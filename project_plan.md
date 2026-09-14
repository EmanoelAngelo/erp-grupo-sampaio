# Grupo Sampaio ERP

Sistema de gestão para as seis operações do grupo: **Preço Justo, Gringa, Me
Mimei, Conceito, PJ Motors e Oficina**. Cobre balcão (PDV), estoque, caixa,
vendas, financeiro, clientes, oficina, e-commerce e fiscal, com os dados de
cada operação isolados dos das outras.

## Aviso sobre este documento

Até agosto de 2026 este arquivo descrevia o **MotoElétrica Pro**: uma aplicação
de página única, com dados em `localStorage`/IndexedDB no navegador e Supabase
como backup assíncrono. **Essa arquitetura foi substituída** e o texto antigo
foi removido daqui porque estava sendo lido como se ainda valesse — descrevia
tabelas, rotas e um modelo de dados que não existem mais.

O que sobreviveu como requisito, e não como implementação: rastreabilidade por
QR do equipamento, kanban da oficina, controle de caixa por turno e catálogo
público. O que **não** sobreviveu: o modelo offline-first (ver "Dívida
conhecida").

### Onde está a verdade

Este arquivo é orientação de entrada. O estado real, módulo a módulo, fica em:

| Documento | Para quê |
| --- | --- |
| `docs/CHECKPOINT.md` | Estado detalhado, o que é parcial e o que não começou |
| `docs/ESTADO-ATUAL.md` | Resumo honesto por módulo |
| `docs/ARQUITETURA-NUCLEO.md` | Como o núcleo transacional funciona |
| `docs/KNOWN_LIMITATIONS.md` | Limites assumidos — **anterior ao CHECKPOINT; onde divergirem, vale o CHECKPOINT** |

## Arquitetura vigente

```
Navegador (React + Vite)
      │  HTTP, token no header
      ▼
API Node/Express  ──  /api/v1
      │
      ▼
SQLite central (WAL, transacional, migrations versionadas)
```

- **Servidor local.** SQLite e API rodam na máquina da operação. O sistema não
  depende de internet para funcionar — depende do servidor estar de pé.
- **Dois formatos de tabela no mesmo banco.** Domínios com invariante forte
  (estoque, vendas, caixa, financeiro) têm tabelas relacionais tipadas em
  `server/src/db/schema.ts`. O resto usa coleções de documento em
  `server/src/db/database.ts` — mesma transação, mesmo arquivo.
- **`companyId` nunca vem do corpo da requisição**, sempre do vínculo do
  usuário autenticado. É o que impede uma operação de ler ou escrever na outra.
- **Design system** em `src/design/tokens.css` + `src/components/gs/`.

## Estado resumido

| Camada | Situação |
| --- | --- |
| Núcleo (auth, produtos, estoque, caixa, vendas, financeiro, clientes) | Funcionando |
| PDV, oficina, equipamentos, compras, entrada por XML | Funcionando |
| E-commerce, pedidos, promoções, administração da loja | Funcionando |
| CRM, fidelidade, locação, BI, conciliação bancária, logística | Funcionando |
| Fiscal (NF-e/NFC-e) | Pipeline e telas completos — falta o certificado A1 |
| Asaas | Código completo — falta a chave e a URL pública |
| Banco central (Supabase) | Fila, projeção e SQL prontos — falta a credencial |
| Correios, Melhor Envio, TEF, impressão silenciosa | Aguardam credencial ou hardware |
| Automações | Único item que segue "em breve", de propósito |

O quadro completo e conferido está em [`docs/ESTADO-ATUAL.md`](docs/ESTADO-ATUAL.md),
que é quem responde pelo estado do sistema. Nada é declarado homologado sem
execução contra o ambiente real do provedor:
`GET /api/v1/core/integrations/status` devolve esse estado em tempo de execução.

## Dívida conhecida

As duas dívidas que este documento listava foram pagas:

- **Offline-first** voltou na rodada 13: service worker guardando a casca e
  fila de escrita com chave de idempotência. A venda não se perde quando o
  servidor cai, e o reenvio não duplica.
- **As ~69 mil linhas de frontend legado** foram removidas na rodada 19 — na
  conta final, 1.774 arquivos e 80.800 linhas. Eram inalcançáveis: guardavam a
  sessão no navegador, e o login atual autentica no servidor, então toda rota
  antiga terminava num salto para a tela de senha.

## Como rodar

```bash
npm install && npm run dev
```

Gates obrigatórios antes de qualquer entrega:

```bash
npm run lint && npm run type-check && npm run test && npm run build
```
