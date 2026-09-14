# Known Limitations — Grupo Sampaio ERP

> **Este documento não é mais a autoridade.** Quem responde pelo estado do
> sistema é [`docs/ESTADO-ATUAL.md`](./ESTADO-ATUAL.md). Onde os dois
> divergirem, vale aquele.
>
> O motivo é concreto: este arquivo declarava CRM, oficina, locação e BI
> "prontos para produção" enquanto o `ESTADO-ATUAL` os listava como legado.
> Quem lesse este aqui tomaria decisão errada. O que sobra abaixo é o
> histórico da versão 1.0.0 e as travas de produção, que continuam valendo.

## Correções desta data

- **Schema do banco:** este documento já disse v39, v19 e v73 — número de
  esquema envelhece, e nenhum documento o sustenta. A fonte é o código
  (`CORE_TARGET_VERSION`) e a conferência é `npm run db:status`, que mede o
  NÚCLEO (`core_schema_version`) contra esse alvo e diz `EM_DIA` ou não
  (GAP-PRD-057). O 19 que o comando imprimia antes era a camada de documentos
  herdada.
- **IndexedDB:** `APP_IDB_VERSION = 67` era do sistema antigo, removido na
  rodada 19. O aplicativo atual não guarda dado de negócio no navegador — só a
  casca em cache e a fila de escrita offline.
- **Payment Terminals / MFA / e-commerce público:** os estados continuam
  válidos; a lista completa e conferida está no `ESTADO-ATUAL`.

## Status Go-Live

- **coreStatus:** READY — Core ERP operacional para produção controlada
- **externalIntegrationsStatus:** PENDING — integrações externas aguardam homologação real
- **overallStatus:** `ready_for_core_production`

Separação obrigatória:

| Camada | Status | Significado |
|--------|--------|-------------|
| **CORE** | Produção ready | Login, PDV, estoque, vendas, financeiro, CRM, oficina, locação, BI, auditoria |
| **INTEGRAÇÕES EXTERNAS** | Pendente | Asaas, SEFAZ, carriers, TEF, DNS/HTTPS público |

Pendências externas **não** são bugs de Core.

## Integrações externas (EXTERNAL INTEGRATION PENDING)

| Integração | Código | Homologação real |
|------------|--------|------------------|
| Asaas | Implementado + UI | Pendente chave sandbox/produção |
| NF-e | Implementado + UI | Pendente certificado A1/A3 + SEFAZ |
| NFC-e | Implementado + UI | Pendente CSC + certificado |
| Correios | Sem integração direta — PAC e SEDEX saem pelo Melhor Envio | Não se aplica: contrato direto exigiria programação (GAP-PRD-118) |
| Jadlog | Sem integração direta — serviços saem pelo Melhor Envio | Não se aplica: contrato direto exigiria programação (GAP-PRD-118) |
| Melhor Envio | Cotação sandbox + produção + tela de credencial; etiqueta (compra, geração, impressão, cancelamento), despacho com transportadora, rastreio por envio com agenda e link no portal | Pendente token de produção, saldo na carteira e `LOGISTICS_PRODUCTION_ENABLED=true`; nenhuma chamada real medida |
| Payment Terminals (Stone, Cielo, Rede, Getnet, PagBank, Mercado Pago, Generic TEF) | Adapters | Pendente hardware/SDK/homologação |
| E-commerce produção pública | Admin/core OK | Pendente DNS/HTTPS/domínio/deploy |
| MFA provider | Ready | Provider real pendente |

Ativação **individual** via Administração → Integrações (credencial → testar → homologar → produção).

## Produção — defaults seguros

- `DEVORA_API_ENV=production`
- Providers mock bloqueados (`MOCK_PROVIDERS_ALLOWED=false` no build production)
- `*_PRODUCTION_ENABLED=false` na entrada inicial
- JWT/encryption defaults locais **bloqueados** em production
- O bootstrap de produção (a subida, e `db:bootstrap`, o mesmo `db:seed`) cria as seis operações e só a conta `admin`, com a senha de `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`, provisória (`must_change_password = 1`): o login abre a etapa de troca e a API responde só a ela (403 `API_PASSWORD_CHANGE_REQUIRED`) até a troca. Senha curta, e em produção e homologação as senhas de desenvolvimento publicadas, são recusadas antes de criar qualquer coisa
- O bootstrap nunca altera conta existente: rodar de novo não reescreve senha, nome, perfil nem cadastro de empresa. Contas de demonstração só pelo seed de desenvolvimento (`db:seed:dev`), que recusa produção, homologação e o banco operacional

## Fora de escopo / não implementado

- NFS-e municipal como pronta
- Notificações push/SMS sem provider
- TED/DOC bancário automático
- Downgrade destrutivo de migrations

## IndexedDB

- `APP_IDB_VERSION = 67` — versão final do Core 1.0.0

## Backend DB

- Schema migrations até **v19**

## P2/P3 conhecidos (não bloqueiam 1.0)

- Seeds inativos legados (Caixa1/2) bloqueados no login oficial
- Documentação técnica legada pode citar nomes históricos fora do chrome operacional
- Image Docker cobre API; frontend servido à parte

## Sequência pós Go-Live Core

1. Asaas Sandbox → Produção  
2. NF-e Homologação → Produção  
3. NFC-e Homologação → Produção  
4. Logística por provider  
5. Payment Terminal por provider  
6. E-commerce domínio/deploy  
7. MFA provider real  
