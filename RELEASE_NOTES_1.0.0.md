# Grupo Sampaio ERP — Release Notes 1.0.0

**Release Final** — Core Production Ready  
**Data:** 2026-08-09

## Resumo

Primeira release estável do **Grupo Sampaio ERP** (Gestão Empresarial) após o roadmap Prompts 01–30 / CP01–CP73 e homologação operacional end-to-end.

Entrada controlada em produção com **CORE operacional** e integrações externas **protegidas** (não homologadas falsamente).

## Escopo Core

- Organização multiempresa (Preço Justo, Gringa, Me Mimei, Conceito, Oficina + empresas dinâmicas)
- Usuários / RBAC / sessões / segurança
- PDV e Caixa (abertura, venda, split tender, cancelamento, fechamento)
- Produto Mestre, promoções, estoque enterprise
- Vendas, compras / supply chain, financeiro AR/AP
- Customer 360, CRM Enterprise, fidelidade
- Oficina Enterprise, Locação Enterprise
- E-commerce admin + OMS (core interno)
- BI corporativo, automações, auditoria/compliance
- Experience Layer (shell, breadcrumbs, design system ERP)

## Arquitetura

- **Frontend:** React 19 + Vite + IndexedDB offline-first (`APP_IDB_VERSION = 67`)
- **Backend:** Node.js + Express (`/api/v1/*`), migrations até schema **v19**
- **Sync:** Outbox/inbox, idempotência, recovery/reconciliação
- **Multi-tenant:** Escopo empresa / unidade / PDV / oficina

## Go-Live 1.0.0

- Canal `stable`
- Core: `READY` → overall `ready_for_core_production`
- Externos: `PENDING` (não `ready_for_full_production`)
- Páginas: Status, Prontidão, Go-Live, Homologações
- Ativação Core protegida por confirmação textual

## Segurança

- Mocks bloqueados em build production
- Flags `*_PRODUCTION_ENABLED=false` por padrão
- Defaults JWT/encryption rejeitados em `DEVORA_API_ENV=production`
- Senhas iniciais provisórias, com troca obrigatória no primeiro acesso (as de desenvolvimento são recusadas em produção)
- Secret scan, rate limit, CORS, headers de segurança

## Integrações externas (pendentes — não são bugs de Core)

| Integração | Implementado | Homologado | Produção |
|------------|--------------|------------|----------|
| Asaas | Sim | Não | Não |
| NF-e | Sim | Não | Não |
| NFC-e | Sim | Não | Não |
| Correios / Jadlog / Melhor Envio | Sim (adapters) | Não | Não |
| Payment Terminals / TEF | Sim (adapters) | Não | Não |
| E-commerce domínio/DNS/HTTPS | Core sim | Produção pública não | Não |
| MFA provider real | Ready | Provider pendente | — |

## Known limitations

Ver `docs/KNOWN_LIMITATIONS.md`.

## Histórico RC

Notas do candidato: `RELEASE_NOTES_1.0.0-rc.1.md` (histórico preservado).
