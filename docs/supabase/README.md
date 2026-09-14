# Banco central — Supabase

> ## O QUE FAZER AGORA — 5 minutos
>
> A credencial já está no `.env` e funciona (o bucket de backup responde). O
> que falta são as TABELAS, e criá-las só é possível pelo painel.
>
> **Enquanto isso não for feito, 118 eventos ficam esperando na fila.** Eles
> não se perdem e não gastam tentativa: o envio nem é iniciado enquanto a
> central não tem onde receber.
>
> **1. ONDE CLICAR**
> Entre em <https://supabase.com/dashboard> e faça login.
>
> **2. QUAL PROJETO**
> O do host `jwniisomdfzbrzhcwalp` — é o mesmo que já guarda os backups, e o
> mesmo que está em `DEVORA_SUPABASE_URL`. Se houver mais de um projeto na
> conta, confira por **Project Settings → General → Reference ID**.
>
> **3. QUAL ARQUIVO, EM QUE ORDEM**
> No menu da esquerda: **SQL Editor** → **New query**. Abra cada arquivo
> abaixo neste repositório, copie o conteúdo inteiro, cole no editor e clique
> em **Run** (ou Ctrl+Enter). **Um de cada vez, nesta ordem:**
>
> | Ordem | Arquivo | O que cria |
> | --- | --- | --- |
> | 1º | `docs/supabase/01-landing.sql` | A aterrissagem: `erp_sync_events` e o controle de versão |
> | 2º | `docs/supabase/02-central-schema.sql` | As tabelas do negócio na central |
> | 3º | `docs/supabase/03-projecao.sql` | O que transforma evento em linha de negócio |
>
> A ordem importa: o segundo e o terceiro dependem do que o primeiro cria. Os
> três são idempotentes (`create table if not exists`) — rodar de novo por
> engano não estraga nada.
>
> **4. COMO SABER QUE DEU CERTO**
> Cada execução deve terminar com **Success. No rows returned**. Se aparecer
> erro em vermelho, **pare** e me mande a mensagem: rodar o seguinte por cima
> de um que falhou deixa a central pela metade.
>
> Depois dos três, confirme daqui:
>
> ```bash
> node server/dist/scripts/conferir-central.js
> ```
>
> Ele responde `CENTRAL SCHEMA : READY` e mostra quantos eventos esperam. Para
> enviar a fila e conferir que tudo chegou certo:
>
> ```bash
> node server/dist/scripts/conferir-central.js --sincronizar
> ```
>
> O esperado ao fim: `OUTBOX AFTER 0`, `DUPLICATES 0`, `TENANT MISMATCH 0`.

---

Guia operacional. **Nenhum segredo real entra neste arquivo.**

## A arquitetura, em uma frase

O SQLite de cada loja é o banco **operacional**; a Supabase é o banco
**central**. O PDV vende com a internet caída, e os fatos sobem para a central
quando a conexão volta.

```
PDV / telas → API Express (única autoridade de negócio)
                 ↓ (mesma transação)
          SQLite local + fila de saída
                 ↓ (worker, em segundo plano)
          Supabase: aterrissagem → projeções
```

O frontend **não** fala com a Supabase para estoque, venda, financeiro ou
fiscal. Só o servidor escreve na central, com credencial própria.

---

## 1. Criar o projeto na Supabase

1. Crie um projeto novo (região mais próxima da operação reduz a latência do
   worker, mas não afeta o PDV — ele não espera a central).
2. Em **Project Settings → API**, anote:
   - **Project URL** → vai em `DEVORA_SUPABASE_URL`
   - **service_role key** → vai em `DEVORA_SUPABASE_SERVICE_KEY`

A chave `anon`/publicável **não serve** para o servidor. Ela existe para o
navegador com RLS; gravar a central com ela significaria confiar no navegador.

## 2. Colocar a credencial no servidor

No `.env` da máquina que roda a API — **nunca** no `.env` do frontend, nunca com
prefixo `VITE_`, nunca em commit:

```
DEVORA_SUPABASE_URL=
DEVORA_SUPABASE_SERVICE_KEY=
```

Enquanto elas não existirem, o estado é `READY_FOR_CREDENTIAL`: a fila acumula
e nada é inventado.

> A `service_role` ignora RLS por definição. Ela só pode existir no servidor:
> nunca em localStorage, IndexedDB, resposta HTTP, log ou bundle.

## 3. Rodar as migrations da central

No **SQL Editor** da Supabase, em ordem:

1. `01-landing.sql` — tabela de aterrissagem + controle de versão
2. `02-central-schema.sql` — tabelas de negócio
3. `03-projecao.sql` — a função que transforma fato bruto em linha de negócio

O terceiro arquivo não é opcional. Sem ele os eventos chegam à aterrissagem e
param ali: as tabelas de negócio ficam vazias, `projected_at` nunca é
preenchido, e o consolidado do grupo mostra zero mesmo com a fila subindo
normalmente. Ele também é o único lugar onde a **guarda de ordem** existe — a
rede não entrega em ordem, e sem essa guarda um "pedido criado" atrasado
sobrescreveria um "pedido entregue", fazendo o pedido voltar no tempo na frente
do cliente.

> A função `erp_apply_projections` nunca foi executada contra um Postgres real:
> sem credencial da central não há onde rodá-la. O que está testado é o lado do
> nó — quais linhas são montadas, com que chave, em que ordem, e o que acontece
> quando a central recusa. Ao aplicar a migration, confira o retorno da primeira
> sincronização: ele informa quantas linhas foram projetadas.

As migrations são versionadas em `erp_central_migrations`. A versão da central
é **independente** da versão do SQLite local (`CORE_TARGET_VERSION`): são dois
bancos com ciclos de vida próprios.

Aplicar num banco vazio produz o schema final. Reaplicar é seguro — tudo é
`if not exists` / `on conflict do nothing`.

Depois, na tela `/sistema/integracoes/central`, clique em **Conferir schema**.
O estado sai de `READY_FOR_SCHEMA`.

## 4. Carga inicial

A fila só carrega o que aconteceu **depois** que ela passou a existir. Produtos,
clientes e vendas anteriores precisam da carga inicial.

Na mesma tela: **Carga inicial**. O processo:

- lê o banco local pelas consultas oficiais (nada de SQL improvisado);
- enfileira em lotes, cada um em transação própria (uma transação única
  travaria o PDV enquanto durasse);
- grava checkpoint — se cair no meio, retoma de onde parou;
- usa ids **derivados** do fato (`bootstrap:<agregado>:<id>`), então rodar duas
  vezes não duplica nada.

Depois disso o estado vira `SYNC_READY`.

## 5. Conferir a sincronização

`/sistema/integracoes/central` mostra, por nó:

| O que | Como ler |
| --- | --- |
| Estado | credencial → schema → carga → sincronizando |
| Esperando para subir | fatos ainda não enviados |
| Em nova tentativa | falharam e vão tentar de novo |
| Já na central | confirmados pela central |
| Parados | esgotaram as tentativas; **precisam de você** |
| Atraso | "Central 2 horas atrasada" |
| Última falha | motivo, com a credencial removida |

**"Central em dia" não é o mesmo que "conexão ok".** Ter rede não significa ter
dado consistente — por isso não existe um rótulo "ONLINE" nesta tela.

## 6. Recuperar a fila

**Evento parado (`dead`).** Falhou 12 vezes; insistir não resolve. Descubra a
causa (schema faltando, credencial trocada, rede), corrija, e use **Tentar
novamente** — isso devolve os eventos à fila. Nenhum fato é descartado.

**Fila grande depois de dias offline.** Normal. O worker envia em lotes de 100 a
cada 15 s e a central deduplica por id; não há nada a fazer além de esperar. O
atraso na tela mostra o progresso.

**Reenvio duplicado.** Não existe efeito duplicado: o `id` do evento é chave
primária na central e o envio é UPSERT. Dez entregas do mesmo fato = uma linha.

## 7. Trocar a credencial

1. Gere a nova `service_role` na Supabase.
2. Atualize `DEVORA_SUPABASE_SERVICE_KEY` no `.env` do servidor.
3. Reinicie a API.
4. **Conferir schema** na tela.

A fila não é afetada: eventos pendentes continuam pendentes e sobem com a
credencial nova.

## 8. Restaurar a central

A central é **derivada**. Cada nó continua com o histórico completo no SQLite,
que é a autoridade sobre os próprios fatos.

Para reconstruir do zero:

1. Rode as migrations num projeto novo.
2. Configure a credencial nova.
3. **Carga inicial** em cada nó.

A projeção é idempotente e o replay completo reproduz o mesmo estado — por isso
reconstruir é rotina, não emergência.

> A central **nunca** escreve de volta no nó. Se a central e o nó divergirem,
> o nó está certo. A conferência compara e reporta `MATCH`/`MISMATCH`; ela
> nunca altera o banco operacional para "fazer bater".

---

## Segurança

- **RLS ligada, sem política**, em todas as tabelas centrais. `anon` e
  `authenticated` não leem nem escrevem; só a `service_role`.
- **Segredo não sobe.** Hash de senha, certificado A1, senha do certificado,
  CSC, chave de API, token de webhook, token de sessão, dado de cartão e XML
  fiscal assinado são removidos do payload no nó, em qualquer profundidade.
- **Quando abrir leitura** para BI ou painel consolidado, a política entra
  restrita por `company_id` e vinculada ao usuário autenticado. Nunca
  `using (true)`: a chave publicável vai no bundle do site, e uma leitura ampla
  transformaria esse arquivo numa porta para o faturamento do grupo inteiro.

## Desenvolvimento sem credencial

O projeto é desenvolvível e testável sem nenhuma credencial real: os testes
usam `testCentralTransport()`, uma central em memória com a mesma semântica de
upsert e ordem. Ela se identifica como **TESTE** na tela — um ambiente que
sincroniza para lugar nenhum não pode se apresentar como pronto.
