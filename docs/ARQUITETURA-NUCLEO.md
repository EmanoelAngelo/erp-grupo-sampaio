# Arquitetura do núcleo — Grupo Sampaio ERP

## O problema que esta arquitetura resolve

O sistema anterior tinha duas falhas estruturais que impediam uso real:

1. **Não havia banco central.** O que se chamava de "banco" no backend era um
   arquivo JSON carregado inteiro em memória e reescrito por completo a cada
   gravação. Sem transação, sem constraint e sujeito a *lost update*: dois
   processos gravando ao mesmo tempo sobrescreviam o trabalho um do outro. Os
   domínios core (estoque, vendas, caixa, clientes) sequer existiam no
   servidor — viviam no IndexedDB de cada navegador, o que torna impossível
   dois PDVs compartilharem estoque.

2. **A autenticação não autenticava.** `POST /auth/login` emitia uma sessão
   válida a partir de `userId` e `companyId` enviados no corpo da requisição,
   sem verificar senha alguma. Qualquer pessoa podia se autenticar como
   qualquer usuário de qualquer empresa.

## Forma atual

```
Cliente React  (casca em cache pelo service worker; fila offline SÓ da venda do PDV — ver OPERATIONS.md)
      │  HTTPS + Bearer JWT
      ▼
API Express  /api/v1
      │
      ▼
Services  ── transações ──►  SQLite central (WAL)
      │
      └────────────────────►  core_audit_log
```

### Banco central

`node:sqlite` (nativo no Node 22+), sem módulo nativo para compilar.

- `journal_mode = WAL` — leitores concorrentes com um escritor, necessário
  para vários PDVs.
- `synchronous = FULL` — venda e caixa sobrevivem a queda de energia.
- `BEGIN IMMEDIATE` — o lock de escrita é adquirido na abertura da transação,
  para que duas vendas do mesmo item não leiam o mesmo saldo e só colidam no
  commit.
- `withTransaction` é reentrante via `SAVEPOINT`, então um serviço pode
  compor operações sem quebrar a atomicidade de quem o chamou.

Há duas camadas sobre a mesma conexão:

| Camada                | Uso                                                        |
| --------------------- | ---------------------------------------------------------- |
| `db/database.ts`      | Coleções de documentos JSON — preserva a API antiga, mantendo os 37 serviços existentes funcionando |
| `db/schema.ts`        | Tabelas relacionais tipadas do núcleo, onde ficam os invariantes |

### Invariantes impostos pelo banco

Não dependem de disciplina do código de aplicação. Duas requisições
concorrentes que violem qualquer um deles falham no commit.

| Invariante                        | Mecanismo                                                     |
| --------------------------------- | ------------------------------------------------------------- |
| Estoque nunca negativo            | `CHECK (quantity >= 0)` em `core_stock`                        |
| Venda baixa estoque uma vez       | `UNIQUE (company, reference_type, reference_id, product, type)` |
| Uma venda, um fato econômico      | `UNIQUE (origin_type, origin_id, direction)`                   |
| Reenvio de venda não duplica      | `UNIQUE (company_id, idempotency_key)`                         |
| Mesma NF-e não entra duas vezes   | `UNIQUE (company_id, access_key)`                              |
| Um caixa aberto por terminal      | índice parcial `WHERE status = 'open'`                         |
| Isolamento entre operações        | `company_id` + FK em toda tabela                               |

> **Detalhe de implementação que custou um bug:** o SQLite avalia o `CHECK` da
> coluna sobre a linha candidata **antes** de resolver `ON CONFLICT`. Um
> upsert que soma um delta negativo viola `quantity >= 0` mesmo quando o saldo
> final seria positivo. Por isso `applyMovement` garante a linha com saldo
> zero e só então aplica o delta num `UPDATE` — aí o `CHECK` incide sobre o
> resultado, que é o que se quer proteger.

### Escopo multiempresa

O `companyId` **nunca** vem do cliente. Ele é derivado de
`core_user_companies` no servidor, a partir do usuário do token. Um operador
do Preço Justo não alcança o estoque da Gringa trocando um campo no corpo da
requisição — a consulta simplesmente não enxerga a outra empresa.

"Visão Grupo Sampaio" é consolidação de leitura e não aceita login direto:
venda, caixa e estoque pertencem sempre a uma das seis operações reais.

### Autenticação

- **Argon2id** (19 MiB, 2 iterações), parâmetros OWASP 2024.
- Hashes SHA-256 legados são aceitos **uma única vez** e reescritos em
  Argon2id no mesmo login — a base migra sozinha conforme as pessoas entram.
- Login inexistente consome o mesmo tempo de um login válido, para não vazar
  por timing quais usuários existem.
- Bloqueio após 5 falhas em 15 minutos, apurado no servidor.
- Access token curto + refresh token com rotação (o refresh usado é revogado).

### Entrar exige senha

Todo login pede usuário e senha — gestão, balcão e bancada. Existiu um "acesso
rápido" por card, que emitia sessão só com o login e era desligado em produção
por padrão; foi **removido**, porque padrão não é garantia: bastava definir
`GRUPO_SAMPAIO_QUICK_LOGIN` para o balcão inteiro entrar sem credencial.

A bancada tem porta própria em `/oficina/login`, separada da tela do
escritório. É navegação, não autorização: quem autoriza continua sendo o
servidor, em cada requisição.

### Token de terminal confiável

O único caminho que dispensa digitar senha, e não é acesso anônimo. Um
administrador registra o terminal (`POST /auth/device/enroll`), que devolve um
token opaco **uma única vez**; o banco guarda apenas o hash SHA-256. O terminal
troca esse token por uma sessão real (`POST /auth/device/login`). O token é
revogável e preso a uma empresa.

## O que os testes provam

`server/tests/core-invariants.test.ts` e `core-api.test.ts` executam as
operações de verdade contra o banco e conferem o estado resultante — não
verificam existência de código por regex.

- dois PDVs vendendo o último item: apenas um conclui, o outro recebe
  `CORE_INSUFFICIENT_STOCK` e o saldo termina em zero (nunca negativo);
- reenviar a mesma venda devolve a original, sem segunda baixa;
- cancelamento repõe o estoque exatamente uma vez, mesmo cancelando duas vezes;
- pagamento que não fecha com o total reverte a transação inteira;
- produto de outra empresa não pode ser vendido;
- o preço vem do cadastro, não do corpo da requisição;
- operador de caixa não cadastra produto nem cancela venda (403).

## Limites conhecidos

- O SQLite atende bem a operação por loja e vários PDVs simultâneos. Para
  concorrência de escrita muito alta entre várias unidades no mesmo banco, o
  passo natural é PostgreSQL — a camada de serviços já está isolada atrás de
  `db/sqlite.ts`, então a troca não alcança as regras de negócio.
- Os predicados da camada de documentos são funções JavaScript, então a
  filtragem acontece em memória. Isso é adequado às tabelas auxiliares
  (configuração, filas, logs), mas os domínios de alto volume devem usar as
  tabelas relacionais do núcleo.
