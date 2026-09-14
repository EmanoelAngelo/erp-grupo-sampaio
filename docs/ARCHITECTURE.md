# Arquitetura — Grupo Sampaio ERP

Este arquivo descrevia, até agosto de 2026, um sistema que não existe mais:
"Core local (IndexedDB)", "JSON DB versionado", `src/permissions/`,
`src/lib/appIndexedDB.ts`. Tudo isso foi removido na rodada 19, junto com as
80.800 linhas do frontend antigo. Um documento que descreve arquitetura apagada
é pior do que documento nenhum: manda quem lê procurar arquivo que não existe.

O detalhamento está em [`ARQUITETURA-NUCLEO.md`](./ARQUITETURA-NUCLEO.md), e o
estado por módulo em [`ESTADO-ATUAL.md`](./ESTADO-ATUAL.md). O que segue é o
resumo.

## Forma

```
Navegador (React 19 + Vite)
      │  HTTPS, Bearer JWT no header
      ▼
API Node/Express  ── /api/v1
      │
      ▼
Serviços  ── transações ──►  SQLite central (WAL)
                                  │
                                  ▼
                         fila de saída ──► banco central (Supabase)
```

**Um dado, um dono.** O navegador não guarda dado de negócio: guarda a casca em
cache (para a tela abrir sem servidor) e uma fila de escrita com chave de
idempotência (para a venda não se perder quando o servidor cai). Estoque, venda,
caixa e nota vivem no SQLite do servidor, com transação de verdade.

Foi isso que mudou em relação ao sistema anterior, e é a razão de ele ter sido
substituído: com o dado no IndexedDB de cada navegador, dois PDVs nunca
compartilhariam estoque.

## Camadas

1. **Aplicativo** — `src/` — React 19, telas em `src/pages/gs`, design system em
   `src/components/gs` e `src/design/tokens.css`
2. **API** — `server/src/routes/v1` — Express, rotas sob `/api/v1`
3. **Serviços** — `server/src/services/core` — onde mora a regra, sempre em
   transação
4. **Banco** — `server/src/db` — SQLite WAL, schema em `schema.ts`, migrations
   numeradas e idempotentes em `core-migrations.ts`
5. **Integrações** — providers desacoplados (Asaas, fiscal, logística, TEF,
   impressão), cada um com estado honesto de prontidão
6. **Central** — `server/src/services/sync` — fila de saída, projeção e
   reconciliação para o banco do grupo

## Multiempresa

Seis operações: Preço Justo, Gringa, Me Mimei, Conceito, PJ Motors e Oficina.

O `companyId` **sempre** vem do vínculo do usuário no token, nunca do corpo da
requisição. Isolamento coberto por teste com 403.

## Segurança

- Argon2id nas senhas; JWT com TTL curto e refresh com rotação
- Bloqueio por tentativa, limite de taxa no login
- Segredos só no servidor, cifrados; nunca voltam por API, nem mascarados
- Logs sanitizados dos dois lados
- Providers de teste bloqueados quando `DEVORA_API_ENV=production`

## Offline

- Service worker guarda a casca — a tela abre sem servidor
- Fila de escrita com chave de idempotência: reenvio não duplica venda
- Integração externa nunca finge sucesso; o estado é `pending` até haver resposta

## Deploy

[`DEPLOY.md`](./DEPLOY.md) · [`OPERATIONS.md`](./OPERATIONS.md) ·
[`GO_LIVE_CHECKLIST.md`](./GO_LIVE_CHECKLIST.md)
