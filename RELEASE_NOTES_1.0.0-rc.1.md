# DEVORA ERP — Release Notes 1.0.0-rc.1

**Release Candidate 1** — Checkpoint 73

## Resumo

Primeira release candidate do DEVORA ERP após conclusão do roadmap CP01–CP73.

## Módulos (CP01–CP72)

Supply Chain, Comercial, Financeiro, Asaas, Conciliação, API Pública, E-commerce, OMS, Logística, Fiscal, NF-e, NFC-e, Oficina Enterprise, Locação, CRM Enterprise, BI Corporativo, Automações, Payment Terminals.

## CP73 — Hardening

- Módulo `system-admin` com prontidão, saúde, recovery/reconciliação/auditoria globais
- Central de homologações externas
- GlobalErrorBoundary (sem stack em produção)
- API `/api/v1/version` enriquecida
- API `/api/v1/system/*`
- Feature flags consolidadas
- Scripts backup/restore/secret-scan
- Documentação técnica e operacional
- CI pipeline
- Docker (dev/staging)

## Pendências externas

Homologação real necessária para: Asaas, NF-e, NFC-e, carriers, payment terminals, DNS e-commerce.

## Known limitations

Ver `docs/KNOWN_LIMITATIONS.md`.
