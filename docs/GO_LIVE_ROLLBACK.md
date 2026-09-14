# Rollback operacional — DEVORA ERP 1.0.0

## Quando usar

Após deploy de produção, se houver regressão crítica no núcleo (5xx, corrupção
de dados, indisponibilidade).

## Procedimento

1. **Parar as escritas**: parar o serviço antes de trocar a build
   (`node server/dist/scripts/parar-api.js` no Windows com supervisor)
2. **Rollback da aplicação** para a versão anterior estável (`out/` + `server/dist`)
3. **Preservar o banco** — não executar downgrade de esquema
4. **Backup/restore** somente com aprovação administrativa explícita
5. **Nunca restaurar automaticamente** sem confirmação e registro

## Ordem recomendada

```
Detectar incidente → Parar escritas → Rollback da app → Conferir health/readiness → Monitorar
```

## Banco de dados

- As migrações são **só para frente**. A build anterior sobe sobre o banco
  preservado; `node server/dist/db/status.js` dirá **ADIANTADO** (o banco é de
  uma build mais nova) — é o esperado num rollback de aplicação, e a migração
  não rebaixa o número.
- Se o esquema for incompatível: restaurar o backup pré-deploy num caminho
  **novo** e conferir antes de usar —
  `node server/dist/scripts/restaurar-backup.js <backup> <destino-novo.db>`
  (`npm run db:restore` na bancada) roda o `integrity_check` e recusa destino
  existente; só então aponte `DEVORA_DATABASE_PATH` para ele. O backup
  pré-migração que o boot tira fica em `DEVORA_BACKUP_DIR` (`pre-migracao-v<N>`);
  `npm run db:backups` lista.
- Registrar: horário, versão da aplicação, versão do núcleo (`db:status`) e o
  arquivo de backup usado.

## Integrações externas

Rollback de aplicação **não** reativa integrações externas. As chaves de
produção permanecem como estão no `.env`.

## Registro

Registre no controle de incidentes (fora do sistema): release revertida,
motivo, operador, horário e o código do erro (`requestId`) que disparou a
decisão. O que o sistema registrou sozinho está em Relatórios › Auditoria.
