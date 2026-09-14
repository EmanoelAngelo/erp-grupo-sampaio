# Migrações e correções de dado — frente SEG

Nada aqui roda no boot. O integrador decide se e quando consolidar num passo
numerado (REGRAS.md, seção 5). Nenhuma linha foi aplicada no banco operacional.

## Lote S1

### Esquema

Nenhuma mudança de esquema em tabela SQL.

- `api_sessions` (coleção de documentos, `db/database.ts`) ganhou o campo
  `senhaProvisoria: boolean` (GAP-PRD-202). Documento antigo sem o campo é
  lido como `false` (`ApiAuthService.refreshSession`: `session.senhaProvisoria === true`).
  Nenhuma conversão necessária.

### Correção de dado recomendada — contas do seed antigo sem a bandeira de senha provisória (GAP-PRD-040)

**Motivo.** O seed anterior criou as 13 contas com `must_change_password = 0` e
com as senhas compartilhadas de desenvolvimento/família (auditoria: 13 contas
com a bandeira 0; `last_login_at` NULL em cinco PDVs). O código novo só marca
as contas que ele cria daqui para a frente; as 13 que já existem continuam sem
a bandeira até alguém agir.

**Caminho sem SQL (já existe na tela).** Em `/sistema/usuarios`, "Resetar
senha" em cada conta do seed grava uma senha provisória nova e
`must_change_password = 1`, sobe `session_version` e o próximo login só abre a
etapa de troca (a API recusa o resto com `API_PASSWORD_CHANGE_REQUIRED`).

**Caminho por passo de consolidação (se o dono preferir).** Marca como
provisória a senha atual das contas do seed que ainda não foram usadas desde a
criação — quem já entrou e trocou não é incomodado:

```sql
UPDATE core_users
   SET must_change_password = 1,
       session_version      = session_version + 1,
       updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE must_change_password = 0
   AND last_login_at IS NULL
   AND login IN (
     'ADMIN', 'CARLOSGERENTE',
     'preco-justo.pdv', 'gringa.pdv', 'me-mimei.pdv', 'conceito.pdv', 'pj-motors.pdv', 'oficina.pdv',
     'ROBERTOMECANICO', 'MARCOSMECANICO', 'PAULOMECANICO', 'LUCASMECANICO', 'JOAOCELULAR'
   );
```

Variante mais forte (todas as 13, inclusive as já usadas — cada pessoa digita a
senha atual uma vez e escolhe outra): retirar a linha `AND last_login_at IS NULL`.
Efeito colateral das duas: as sessões abertas dessas contas deixam de renovar
(é o que o `session_version + 1` pede), e desde o GAP-PRD-053 (lote S2) o access
token vigente também cai na requisição seguinte.

## Lote S2

### Esquema

Nenhuma mudança de esquema em tabela SQL, nenhum índice novo.

- `api_sessions` (GAP-PRD-069): refresh, rotação e logout passam a ler e
  revogar pela coluna `id`, que já tinha índice (`ix_api_sessions_id`, criado
  por `db/database.ts:ensureSchema`). A revogação é
  `json_set(data, '$.revoked', json('true'))` sobre a própria linha.
- Sessão gravada sem `expiresAt` (formato antigo) vence em `createdAt + 7 dias`;
  sem nenhuma das duas datas, é tratada como vencida.

### Limpeza de dado — automática, não é passo de migração (GAP-PRD-069)

A poda roda no próprio código (`services/api/SessoesDeApi.ts`), na primeira
emissão de sessão de cada processo e depois a cada 50 emissões — o mesmo
desenho da poda de `api_request_logs`. Não precisa de passo de consolidação.

O que ela apaga, para o integrador saber o que esperar no banco operacional
depois do primeiro login com o código novo (a auditoria contou 434 linhas em
`api_sessions`, todas vencidas, e 150 revogadas):

```sql
DELETE FROM api_sessions
 WHERE json_valid(data)
   AND (json_extract(data, '$.revoked') = 1
        OR (json_type(data, '$.expiresAt') = 'text' AND json_extract(data, '$.expiresAt') <= :agora)
        OR (json_type(data, '$.expiresAt') IS NULL
            AND json_type(data, '$.createdAt') = 'text'
            AND json_extract(data, '$.createdAt') <= :agora_menos_7_dias));

DELETE FROM core_login_attempts WHERE attempted_at < :agora_menos_24_horas;
```

Linha de `api_sessions` cujo JSON não abre não é apagada (não há idade que se
leia nela).

## Lote S3

### Esquema

Duas tabelas NOVAS na DDL canônica (`server/src/db/schema.ts`), criadas pelo
boot em banco existente com `CREATE TABLE IF NOT EXISTS` — nenhum passo
numerado, nenhuma coluna nova em tabela existente, nenhum índice sobre tabela
existente (GAP-PRD-160):

- `core_team_password_recovery_configs` — a escolha do dono, por operação, de
  deixar a equipe trocar a própria senha pelo e-mail. Sem linha = desligada
  (padrão seguro).
- `core_user_password_resets` — o código de uso único (guarda-se o HMAC, nunca
  o código), com `ix_user_pw_resets_user (user_id, created_at)`, índice da
  própria tabela nova.

As duas entram na lista de apagar dos testes antes de `core_user_companies` /
`core_users` (apontam para `core_users` e `core_companies`).

### Dado — nada a corrigir

- Fotos da OS (GAP-PRD-184): `core_service_order_photos.url` continua
  guardando o caminho `/uploads/os/<uuid>.<ext>`; o link assinado é montado na
  resposta da listagem. Nenhuma linha muda.
- Fila do sync (GAP-PRD-136), BI/painel (GAP-PRD-084), cadastro de produto
  (GAP-PRD-052), alçada (GAP-PRD-054): só leitura e guarda de rota.

### Para quem integra

- Frontend (GAP-PRD-206): a tela de login só pergunta pelo acesso rápido com
  `VITE_DEV_QUICK_LOGIN=true` no build. A instalação de desenvolvimento que usa
  o acesso rápido (servidor com `DEVORA_DEV_QUICK_LOGIN=true`) precisa ligar as
  duas; em produção as duas ficam `false`.
- A tela da fila de e-mail passa a ocultar o corpo dos modelos
  `recuperacao_senha` e `recuperacao_senha_equipe` (levam código/link de
  acesso) — mudança mínima em `EmailService.listEmailQueue`, domínio da frente
  EML.

## Lote S4

### Esquema

- `core_customers.anonymized_at TEXT` (GAP-PRD-073) — coluna nova, anulável, na
  DDL canônica; o `reconcileCoreSchema` a acrescenta em banco existente. Nulo =
  cadastro vivo. Nenhum índice novo, nenhuma reconstrução, nenhum passo numerado.

### Dado — nada a corrigir no boot

- Nenhum cliente existente é tocado. A anonimização só acontece a pedido, pela
  rota `POST /core/customers/:id/anonimizar` (Cadastros › Clientes › ficha ›
  Direitos do titular), numa transação que também limpa, em `core_outbox`, as
  cópias do payload daquele cliente (a fila nunca é podada e guardava o CPF de
  cada `customer.upserted` já entregue).
- `core_audit_log` passa a ser podada com 5 anos (`RetencaoDaAuditoria`), no
  máximo uma vez por dia de processo, pendurada na poda amortizada das sessões.
  O banco real começou em 2026: nada sai antes de 2031.

### Índice recomendado (opcional, para o passo de consolidação)

A poda da trilha filtra só por data, e o índice que existe é
`ix_audit_company (company_id, created_at)` — então ela varre a tabela, uma vez
por dia. Se a trilha crescer a ponto de essa varredura pesar, o integrador pode
criar (índice sobre coluna de tabela existente não vai no boot — REGRAS.md, §5):

```sql
CREATE INDEX IF NOT EXISTS ix_audit_created ON core_audit_log (created_at);
```

### Para quem integra

- Sincronização (frente SYNC): o `customer.upserted` emitido na anonimização leva
  nome anônimo e contato nulo, e o projetor copia só nome/documento/e-mail/
  telefone para `erp_customers` — a cópia remota do cadastro fica anonimizada
  quando o evento sobe. A cópia remota das OS (`erp_service_orders.customer_name`,
  projetada de `service_order.opened`/`status_changed`) NÃO é reescrita: não
  existe evento de "OS renomeada" no catálogo, e emitir `status_changed` sem
  mudança de status mentiria para a central. Fica para a SYNC decidir o evento
  (ou a rotina na central) que regrave `customer_name` das OS de um cliente
  anonimizado. Localmente o nome da OS já é anonimizado, na tabela e na fila.
- Asaas: o cadastro do cliente no provedor (`core_asaas_customers`) continua lá.
  A anonimização recusa quem tem título em aberto; apagar o cliente no painel do
  Asaas, quando o titular pedir, é do dono.
- Leitura de cliente: `getCustomer`/`listCustomers` deixam de devolver
  `portal_invite_hash`, `portal_invite_expires_at` e `portal_invite_used_at`.
  Quem precisa delas (`EquipmentPortalService`) sempre as leu com consulta
  própria.
