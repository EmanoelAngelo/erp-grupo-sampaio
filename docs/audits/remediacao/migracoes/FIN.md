# Migrações pendentes da frente FIN (Asaas, financeiro, conciliação, fluxo de caixa)

Regra da remediação (REGRAS.md §5): nada de passo numerado nem de mudança em
`CORE_TARGET_VERSION` nesta frente. Coluna nova entra na DDL canônica
(anulável) e o `reconcileCoreSchema` a acrescenta em banco existente; índice
sobre coluna nova de tabela existente, reconstrução e correção de dado ficam
descritos aqui para o integrador consolidar num passo único.

## Lote N1

### 1. `core_payment_webhooks.company_id` — coluna (já na DDL canônica)

- **Onde:** `server/src/db/schema.ts`, `CREATE TABLE IF NOT EXISTS core_payment_webhooks`.
- **O quê:** `company_id TEXT` (anulável, sem DEFAULT).
- **Por quê (GAP-PRD-002):** o evento passa a guardar a operação que o token
  (ou a URL) provou. É o que deixa o card "Webhook" da tela de Integrações
  dizer "o último aviso chegou em…" por operação.
- **Em banco existente:** `reconcileCoreSchema` executa sozinho
  `ALTER TABLE core_payment_webhooks ADD COLUMN company_id TEXT;`.
  Linhas antigas ficam com `company_id` NULL — correto: o dono delas não foi
  registrado na época.

### 2. Índice para o painel do webhook — PARA O PASSO DE CONSOLIDAÇÃO

```sql
CREATE INDEX IF NOT EXISTS ix_payment_webhooks_company_received
  ON core_payment_webhooks (company_id, received_at);
```

- **Por quê:** `describeAsaasWebhook` (`server/src/services/core/AsaasWebhookInfo.ts`)
  lê o último aviso e a contagem de 30 dias por operação a cada abertura da
  tela de Integrações. Sem o índice é varredura da tabela; o volume é pequeno
  (um aviso por evento de cobrança), então a ausência do índice não quebra
  nada — só não escala.
- **Por que não está no boot:** índice sobre coluna NOVA de tabela existente.
  Em banco antigo o `CREATE INDEX` da DDL canônica rodaria antes do
  `reconcileCoreSchema` acrescentar a coluna e falharia.
- **Pré-requisito:** a coluna do item 1 (o passo deve rodar depois do
  `reconcileCoreSchema`, ou incluir o `ALTER TABLE` condicional).

### 3. Correção de dado — nenhuma necessária

- **O que a auditoria mediu no banco da loja:** `asaas_webhook_events` (a
  coleção da rota antiga) com 2 eventos reais, ambos `PAYMENT_OVERDUE` de
  26/08, e `core_payment_webhooks` com 0 linhas.
- **Por que não há o que reprocessar:** `PAYMENT_OVERDUE` não move dinheiro nem
  baixa título; o efeito dele no núcleo seria só marcar a intenção como
  vencida. Nenhum evento de recebimento (`PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED`)
  ficou preso na coleção legada.
- **Daqui em diante:** a rota antiga entra no processamento do núcleo, e o que
  chegar por ela vai para `core_payment_webhooks` com a operação.
- Esta frente **não abriu** o banco operacional (a conferência acima é a da
  auditoria, `docs/audits/DEVORA-PRODUCTION-READINESS-AUDIT.md`, ficha
  GAP-PRD-002). Se o integrador quiser confirmar antes de consolidar, a leitura
  é somente-leitura:

  ```sql
  SELECT json_extract(data, '$.eventType') AS tipo, COUNT(*)
    FROM asaas_webhook_events GROUP BY tipo;
  ```

  Qualquer `PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED` que aparecer ali é dinheiro
  que entrou sem baixa: a conciliação Asaas o mostra como "cobrado e não
  lançado", e a baixa se faz pela tela do título.

## Lote N2

### 4. `core_payment_intents.provider_checked_at` — coluna (já na DDL canônica)

- **Onde:** `server/src/db/schema.ts`, `CREATE TABLE IF NOT EXISTS core_payment_intents`.
- **O quê:** `provider_checked_at TEXT` (anulável, sem DEFAULT).
- **Por quê (GAP-PRD-016):** a passada de sincronização com o Asaas
  (`server/src/services/core/AsaasSincronizacao.ts`) pergunta primeiro pelas
  cobranças que estão há mais tempo sem consulta. Linhas antigas ficam NULL —
  correto: nunca foram consultadas, e por isso vão primeiro.
- **Em banco existente:** `reconcileCoreSchema` executa
  `ALTER TABLE core_payment_intents ADD COLUMN provider_checked_at TEXT;`.

### 5. `core_asaas_sync_runs` — tabela nova (já na DDL canônica)

- Criada pelo `ensureCoreSchema` no boot (`CREATE TABLE IF NOT EXISTS`), com o
  índice `ix_asaas_sync_runs_company (company_id, started_at)` na mesma DDL
  (índice de tabela NOVA é permitido ali). Nada a consolidar.

### 6. Índice para a passada de sincronização — PARA O PASSO DE CONSOLIDAÇÃO

```sql
CREATE INDEX IF NOT EXISTS ix_payment_intents_company_status_checked
  ON core_payment_intents (company_id, status, provider_checked_at);
```

- **Por quê:** a passada filtra por empresa + status (`pending`/`overdue`/
  `cancelled` recente) e ordena por `provider_checked_at`. Sem o índice é
  varredura da tabela a cada 30 minutos por operação; o volume é o de
  cobranças (baixo), então a ausência não quebra nada — só não escala.
- **Por que não está no boot:** índice sobre coluna NOVA de tabela existente.
- **Pré-requisito:** a coluna do item 4.

### 7. Correção de dado — nenhuma automática

- Cobranças antigas `pending`/`overdue` com `provider_ref` passam a ser
  consultadas no provedor pela própria passada (no boot + 1 min e a cada
  `ASAAS_SYNC_INTERVAL_MINUTES`), que aplica o status real pelo mesmo caminho
  do webhook. Não há SQL de correção a rodar: o caminho de correção é o
  software (botão "Consultar o provedor agora" na conciliação).

### 8. `core_payment_intents.installment_count` e `provider_installment_ref` — colunas (já na DDL canônica)

- **O quê:** `installment_count INTEGER` e `provider_installment_ref TEXT`, as duas
  anuláveis e sem DEFAULT.
- **Por quê (GAP-PRD-114):** a cobrança de cartão da loja online passa a ir
  parcelada ao provedor. O provedor cria uma cobrança por parcela, todas com o
  mesmo `installment`; a intenção guarda o id da primeira (`provider_ref`, como
  antes) e o do plano. O webhook das parcelas 2..N encontra a intenção por
  `provider_installment_ref`; estorno e cancelamento vão ao plano.
- **Em banco existente:** `reconcileCoreSchema` acrescenta as duas. Linhas
  antigas ficam NULL = à vista, que é o que todas foram (o parcelamento não
  existia).

### 9. Índice para o webhook das parcelas — PARA O PASSO DE CONSOLIDAÇÃO

```sql
CREATE INDEX IF NOT EXISTS ix_payment_intents_installment_ref
  ON core_payment_intents (provider_installment_ref)
  WHERE provider_installment_ref IS NOT NULL;
```

- **Por quê:** `handlePaymentWebhook` procura por `provider_installment_ref`
  quando o `provider_ref` do evento não é conhecido (parcelas 2..N). Sem o
  índice, varredura da tabela por evento de parcela — funciona, não escala.
- **Por que não está no boot:** índice sobre coluna NOVA de tabela existente.

### 10. `core_sale_payments.payment_intent_id` e `settled_at` — colunas (já na DDL canônica)

- **O quê:** `payment_intent_id TEXT` e `settled_at TEXT`, anuláveis, sem DEFAULT.
- **Por quê (GAP-PRD-077):** o PIX do balcão pelo Asaas. A linha de pagamento
  guarda a cobrança que a liquida (é por ela que o webhook acha a linha
  pendente) e QUANDO foi liquidada (a conciliação conta a linha no dia em que o
  dinheiro entrou, não no dia da venda).
- **Em banco existente:** `reconcileCoreSchema` acrescenta as duas. Linhas
  antigas ficam NULL: nenhuma passou pelo provedor (a auditoria mediu 0
  intenções com origem `sale` no banco da loja), e para elas a conciliação usa
  `created_at` (`COALESCE(settled_at, created_at)`).

### 11. Índice para o vínculo cobrança ↔ linha — PARA O PASSO DE CONSOLIDAÇÃO

```sql
CREATE INDEX IF NOT EXISTS ix_sale_payments_intent
  ON core_sale_payments (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sale_payments_company_status
  ON core_sale_payments (company_id, status);
```

- **Por quê:** o primeiro serve à conciliação e ao vínculo da venda; o segundo
  à fila de PIX pendentes (`GET /core/pdv/pix-pendentes`). Sem eles, varredura
  — funciona, não escala.
- **Por que não está no boot:** o primeiro é sobre coluna NOVA de tabela
  existente; o segundo, por coerência, vai no mesmo passo.

### 12. Correção de dado — nenhuma automática

- Linhas `core_sale_payments.status = 'pending'` que já existirem no banco (PIX
  declarado pendente por integração, sem provedor) passam a aparecer na fila de
  Contas a receber ("PIX do balcão aguardando confirmação") e se resolvem pela
  confirmação com nota (`POST /core/sales/:id/payments/:paymentId/confirmar`).
  Não há SQL de correção: o caminho é o software.

## Lote N3

### 13. `core_finance_settle_requests` — tabela nova (já na DDL canônica)

- Criada pelo `ensureCoreSchema` no boot (`CREATE TABLE IF NOT EXISTS`), com
  `PRIMARY KEY (company_id, idempotency_key)`. Guarda o pedido de baixa já
  atendido (GAP-PRD-173): o reenvio da mesma baixa com o mesmo
  `Idempotency-Key` devolve a baixa já feita. Nada a consolidar.

### 14. Correção de dado — o título dos fechamentos de comissão antigos (GAP-PRD-174)

- **O que muda no código:** `CommissionService.fecharPeriodo` passa a criar a
  conta a pagar com `origin_type = 'commission_closing'` e `origin_id` = id do
  fechamento. Antes ela nascia `origin_type = 'manual'` com `origin_id` = o
  próprio título, e o vínculo morava só em
  `core_commission_closings.finance_entry_id`.
- **Os títulos antigos** continuam `manual` até o passo de consolidação. Eles
  seguem corretos em valor, baixa, DRE e conciliação; só não viram link para o
  fechamento no contas a pagar (do fechamento se chega a eles pela aba
  Comissões › Fechamentos, que lê `finance_entry_id`).
- **SQL para o passo de consolidação** (idempotente: só toca título `manual`
  que um fechamento aponta como seu, da mesma empresa):

  ```sql
  UPDATE core_finance_entries
     SET origin_type = 'commission_closing',
         origin_id = (SELECT c.id FROM core_commission_closings c
                       WHERE c.finance_entry_id = core_finance_entries.id
                         AND c.company_id = core_finance_entries.company_id)
   WHERE origin_type = 'manual'
     AND installment_total = 1
     AND EXISTS (SELECT 1 FROM core_commission_closings c
                  WHERE c.finance_entry_id = core_finance_entries.id
                    AND c.company_id = core_finance_entries.company_id);
  ```

- **Por que é seguro:** a UNIQUE `(origin_type, origin_id, direction,
  installment_number)` não colide — cada fechamento tem um título só, e o id do
  fechamento é UUID. Nenhum valor muda; nenhuma baixa muda. O `origin_type` não
  tem CHECK.
- **Por que não está no boot:** correção de dado (REGRAS.md §5).

### 15. Correção de dado — as quitações antigas sem baixa: NENHUMA automática (GAP-PRD-171)

- **O que a auditoria mediu no banco da loja:** `core_finance_settlements` com 0
  linhas e 7 lançamentos com `settled_cents > 0` sem baixa (R$ 6.223,45), todos
  anteriores ao V29 (a fatia à vista nascia quitada sem baixa-espelho).
- **Por que não há passo de consolidação:** criar a baixa-espelho desses
  lançamentos muda o que a conciliação bancária de agosto mostra. É decisão do
  dono, e o software a oferece pronta, sem rodar sozinha:
  - Financeiro › Conciliação bancária → cartão "Quitações antigas sem baixa"
    (só aparece quando há o que decidir): lista, total e desde quando;
  - "Criar as baixas-espelho" → confirmação → `POST
    /api/v1/core/finance/legacy-settlements/mirror` com `{ "confirm": true }`
    (gerência; auditoria `finance.legacy_settlements_mirrored`).
  - A baixa nasce com `settled_at` = a quitação original
    (`COALESCE(settled_at, created_at)` do lançamento), `method` = a forma do
    lançamento, `user_id` = quem decidiu e a nota "Baixa-espelho de migração".
    `settled_cents` não muda; saldo, resumo, DRE e fluxo de caixa não mudam.
    Idempotente: o que falta é recalculado a cada chamada.
- **Leitura somente-leitura para conferir antes de decidir** (não altera nada):

  ```sql
  SELECT e.company_id, COUNT(*) AS lancamentos,
         SUM(e.settled_cents - COALESCE(b.explicado, 0)) AS falta_cents
    FROM core_finance_entries e
    LEFT JOIN (SELECT entry_id, SUM(amount_cents) AS explicado
                 FROM core_finance_settlements GROUP BY entry_id) b
           ON b.entry_id = e.id
   WHERE e.cancelled_at IS NULL AND e.settled_cents > COALESCE(b.explicado, 0)
   GROUP BY e.company_id;
  ```

### 16. `integration_configurations` (coleção de documentos) — campos novos, nada a migrar (GAP-PRD-170, GAP-PRD-169)

- **Campos novos no documento do Asaas de cada operação:**
  `productionConnectionVerified`, `productionConnectionTestedAt`,
  `productionConnectionError` (o selo da chave de PRODUÇÃO, testada em
  `api.asaas.com`) e `homologationProbe` (`startedAt` + ids das cobranças de
  teste da última homologação, para conferir o aviso externo).
- **Leitura do formato antigo:** documento sem os campos lê
  `productionConnectionVerified !== true` → "chave de produção não testada".
  É o comportamento certo: o selo antigo (`connectionVerified`) era carimbado
  pelo teste do ambiente efetivo, que era o SANDBOX enquanto a produção
  estava trancada.
- **Efeito esperado no banco da loja:** operação que hoje estivesse em
  produção pelo selo antigo volta ao ambiente efetivo `sandbox`, com a trava
  `CREDENCIAL_DE_PRODUCAO_NAO_TESTADA`, até alguém clicar "Testar conexão" em
  Integrações › Asaas (a chave de produção é testada e o selo novo é
  carimbado). A auditoria mediu o Preço Justo "sandbox homologada" e nenhuma
  operação em produção; ESTADO-ATUAL já pede a reemissão das chaves do Preço
  Justo. Nenhum SQL, nenhuma correção de dado: o caminho é a tela.
- **`homologationSteps` antigos** com as frases "CP59"/"CP61" continuam no
  documento até a próxima homologação, que parte de passos novos.
