# Migrações da frente PAG — para o passo único de consolidação

Regra da remediação (REGRAS.md, seção 5): nenhuma frente cria `core_migration_step_N` nem mexe em `CORE_TARGET_VERSION`. O que é DDL de tabela nova já está na DDL canônica (`server/src/db/schema.ts`) e o boot cria em banco existente. O que é índice sobre tabela existente, reconstrução ou **correção de dado** fica descrito aqui, com o SQL exato, para o integrador montar o passo de consolidação.

---

## P1 — GAP-PRD-008: reserva da chave de idempotência da maquininha

**Nada a migrar.** A tabela nova `core_payment_terminal_charge_keys` (PRIMARY KEY `(company_id, idempotency_key)`) está na DDL canônica com `CREATE TABLE IF NOT EXISTS`; o `ensureCoreSchema()` a cria em banco existente na primeira subida. Ela entra também em `CORE_TABLES_IN_DELETE_ORDER` (sem FK, sem dependentes).

Não há backfill: as transações de terminal gravadas antes desta tabela continuam respondendo pela chave, porque `reservarCobranca` (em `PaymentTerminalService.ts`) procura primeiro a linha na coleção `payment_terminal_transactions` e só depois a reserva. Não foi criado índice sobre a coleção de documentos.

---

## P1 — GAP-PRD-001: desligar a configuração de maquininha de TESTE (`provider: mock`) gravada

### Por que é correção de dado

O banco real da Preço Justo tem, na coleção `payment_terminal_configurations`, o documento `ptcfg-1786588515956` com `provider: "mock"`, `active: true`, `environment: "sandbox"` e sem credencial (lido em modo somente leitura pela auditoria). Fora de produção ele aprova cartão sem dinheiro trocar de mãos; em produção o código desta frente já o **ignora** na leitura (`getTerminalStatus`), e o balcão volta ao cartão lançado à mão, mas o documento continua gravado.

O software já oferece o caminho sem SQL: **Vendas › Conferência de maquininha › Maquininhas integradas nesta operação › Desligar** (rota `POST /api/v1/core/pdv/terminal/configurations/:id/deactivate`, gerente da operação, motivo obrigatório, com auditoria). A prontidão de go-live (`evaluateCoreProductionReadiness`) aponta a configuração como bloqueio crítico enquanto ela estiver ligada.

Se o integrador preferir que o passo de consolidação desligue a configuração sozinho, este é o SQL. Ele é idempotente: roda de novo sem efeito, porque só pega documentos `mock` ainda ligados.

### SQL (dentro da transação do passo)

```sql
-- 1) Rastro ANTES de mudar: uma linha de histórico por configuração desligada.
INSERT INTO payment_terminal_history (id, data)
SELECT 'pthist-mig-' || id,
       json_object(
         'id',              'pthist-mig-' || id,
         'companyId',       json_extract(data, '$.companyId'),
         'configurationId', id,
         'provider',        'mock',
         'action',          'configuration_deactivated',
         'reason',          'GAP-PRD-001: provider de teste (mock) desligado na consolidação — aprova cartão sem dinheiro.',
         'userId',          'migracao-consolidacao',
         'createdAt',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )
  FROM payment_terminal_configurations
 WHERE json_extract(data, '$.provider') = 'mock'
   AND COALESCE(json_extract(data, '$.active'), 1) <> 0;

-- 2) Auditoria, no mesmo formato que a rota grava.
INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
SELECT 'audit-mig-' || id,
       json_extract(data, '$.companyId'),
       NULL,
       'payment_terminal.configuration.deactivated',
       'payment_terminal_configuration',
       id,
       json_object('provider', 'mock',
                   'reason', 'GAP-PRD-001: provider de teste (mock) desligado na consolidação.',
                   'simulated', json('true'),
                   'by', 'migracao-consolidacao'),
       NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM payment_terminal_configurations
 WHERE json_extract(data, '$.provider') = 'mock'
   AND COALESCE(json_extract(data, '$.active'), 1) <> 0;

-- 3) Desliga. Mesmos campos que `setPaymentTerminalConfigurationActiveBackend` grava.
UPDATE payment_terminal_configurations
   SET data = json_set(
         data,
         '$.active',             json('false'),
         '$.deactivatedAt',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         '$.deactivatedBy',      'migracao-consolidacao',
         '$.deactivationReason', 'GAP-PRD-001: provider de teste (mock) desligado na consolidação — aprova cartão sem dinheiro.',
         '$.updatedAt',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )
 WHERE json_extract(data, '$.provider') = 'mock'
   AND COALESCE(json_extract(data, '$.active'), 1) <> 0;
```

Observações para o integrador:

- As coleções de documentos têm o formato `(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT)` (ver `db/database.ts`); o `INSERT` do passo 1 deixa `seq` para o autoincremento.
- Booleano no JSON: o código grava `true`/`false` com `JSON.stringify`; `json_extract` devolve `1`/`0`. Por isso a condição é `<> 0` e o valor novo é `json('false')`, não o inteiro `0`.
- Em banco de desenvolvimento o passo também desliga a maquininha de teste. Quem precisar dela religa pela mesma tela (a rota de religar recusa o mock em produção/homologação, então isso só funciona em dev/teste).
- As duas transações simuladas antigas da Preço Justo (`payment_terminal_transactions`, sem venda) não precisam de correção: nenhuma está amarrada a venda, e a conferência já as trata pelo estado que têm.
- Nada disto roda no boot. É só para o passo de consolidação, se o integrador decidir incluí-lo; caso contrário, o gestor desliga pela tela.

---

## P2 — GAP-PRD-039 / GAP-PRD-146: cadastro de caixas (terminais) e uma gaveta por caixa

### O que NÃO precisa de passo

- **Colunas novas em `core_terminals`** (`created_by`, `updated_at`, `deactivated_at`, `deactivated_by`, `deactivation_reason`): todas anuláveis, no fim da DDL canônica. O `reconcileCoreSchema` as acrescenta por `ALTER TABLE … ADD COLUMN` em banco existente. Não há backfill: a tabela tem 0 linhas no banco operacional (medido pela auditoria).
- **`code TEXT NOT NULL UNIQUE` (único no banco inteiro)**: não foi reconstruída para `UNIQUE (company_id, code)`. O `TerminalService` gera o código com o slug da empresa na frente (`gringa-cx1`, `preco-justo-cx2`), único por construção. Trocar a constraint seria reconstrução de tabela sem ganho.
- **As duas gavetas abertas desde agosto no banco operacional** (Gringa `acf461e5…` desde 12/08, Preço Justo `63b74a8e…` desde 26/08 — GAP-PRD-131): **sem SQL, de propósito**. Fechar gaveta é contar dinheiro; um `UPDATE status='closed'` gravaria um fechamento sem contagem (o defeito que a régua de `closeSession` existe para impedir). O caminho é a tela: o Painel e o PDV apontam a gaveta de outro dia com a data, e **Vendas › Caixa › Gavetas abertas nesta operação › Fechar esta gaveta** fecha qualquer uma com o valor contado (rota `POST /api/v1/core/cash/:id/close`, com auditoria).

### Índice opcional para o passo de consolidação (GAP-PRD-146)

`ux_cash_open_per_terminal` é `UNIQUE (company_id, terminal_id) WHERE status='open'` e **não vincula a gaveta sem caixa**: no SQLite `NULL` não colide com `NULL`. Hoje a unicidade de "uma gaveta sem caixa aberta por empresa" é garantida em código (`openSession` e `reopenSession` conferem `terminal_id IS ?` dentro da transação). Se o integrador quiser a mesma garantia no banco, este é o índice. Ele não foi posto na DDL canônica porque um banco com duas gavetas sem caixa abertas na mesma empresa faria o boot falhar ao criá-lo.

```sql
-- 1) PRÉ-CONDIÇÃO — tem de voltar VAZIO. Se voltar alguma empresa, NÃO crie o
--    índice: feche as gavetas excedentes pela tela (contando o dinheiro) e rode de novo.
SELECT company_id, COUNT(*) AS abertas
  FROM core_cash_sessions
 WHERE status = 'open' AND terminal_id IS NULL
 GROUP BY company_id
HAVING COUNT(*) > 1;

-- 2) O índice. Idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_open_sem_terminal
  ON core_cash_sessions (company_id)
 WHERE status = 'open' AND terminal_id IS NULL;
```

Validado em SQLite de rascunho em memória (nenhum banco real tocado): com duas gavetas sem caixa abertas na mesma empresa a pré-condição devolve a empresa e o `CREATE` é recusado com `UNIQUE constraint failed`; com a pré-condição vazia o índice nasce, rodar de novo não faz nada, a segunda gaveta sem caixa aberta é recusada, e gaveta COM caixa ao lado da sem caixa, ou gaveta fechada sem caixa, continuam aceitas. No banco operacional a auditoria mediu uma gaveta sem caixa aberta por empresa (a pré-condição passaria), mas as duas são as de agosto — o certo é fechá-las pela tela antes do go-live de qualquer jeito.

## P3 — GAP-PRD-009 / 050 / 161 / 134: devolução pelo líquido e dinheiro sempre com gaveta

### O que NÃO precisa de passo

Nenhuma tabela, coluna ou índice novo. O valor da devolução passou a sair do líquido da linha (desconto do rodapé rateado) e do acumulado já devolvido — conta feita na hora, a partir de `core_sales.discount_cents`, `core_sale_items.total_cents` e `core_sale_return_items`, que já existem. A gaveta do dinheiro é resolvida por `GavetaDoDinheiro` a partir de `core_cash_sessions` e `core_terminals`, também existentes.

### Dado antigo

Devolução gravada pela conta antiga (bruta do desconto do rodapé) continua como está — é documento emitido e dinheiro que já saiu. O código não a reescreve; a próxima devolução da mesma venda desconta dela (acumulado por linha) e a trava `CORE_RETURN_EXCEEDS_PAID` impede que a soma passe do total da venda. Conferido no banco operacional em modo somente leitura em 11/09/2026: `core_sale_returns` tem 0 linhas e nenhuma venda tem `discount_cents > 0`, então não há devolução a mais para corrigir. Não há SQL para este lote.

## P4 — GAP-PRD-014 / 076: fila de comandos do agente local e maquininha por caixa

### O que NÃO precisa de passo

- Duas tabelas NOVAS pela DDL canônica (`server/src/db/schema.ts`), com os índices na mesma DDL e na ordem de exclusão de testes: `core_payment_terminal_agent_commands` (a fila PDV → agente, com os prazos de retirada e de resposta) e `core_payment_terminal_agent_nonces` (os nonces já usados pela assinatura HMAC de cada agente). O boot as cria em banco existente; nenhuma coluna nova em tabela existente, nenhum índice sobre coluna existente, nenhuma reconstrução.
- Campos novos só em coleções de documentos, lidos com padrão para o formato antigo: `payment_terminal_configurations.pdvTerminalId` (ausente = maquininha da operação inteira), `connectionMode` (ausente numa linha antiga de provedor real = `cloud`, que o balcão IGNORA — o cartão volta a ser lançado à mão em vez de parar; o mock continua com o canal `mock`); `payment_terminal_local_agents.encryptedSecret`/`pdvTerminalId`/`health`/`revoked*` (agente antigo sem segredo não autentica e aparece para ser pareado de novo); `payment_terminal_transactions.channel`/`agentId`/`configurationId`/`agentStage` (ausentes nas cobranças antigas, que seguem pelo caminho síncrono de sempre).
- O segredo do agente é selado pelo cofre (`FiscalSecretVault`) e está registrado em `server/src/db/secretsInventory.ts` (`payment_terminal_agent_secret`), então a rotação da chave o alcança.

### Dado antigo

Conferido no banco operacional em modo somente leitura em 11/09/2026: `payment_terminal_configurations` tem 1 linha (a `mock` da Preço Justo, tratada no P1), `payment_terminal_local_agents` tem 0 linhas e `core_terminals` tem 0 linhas. Nenhuma configuração de provedor real e nenhum agente pareado a converter. Não há SQL para este lote.

## P5 — GAP-PRD-078 / 080 / 081: cobranças sem venda, estorno da venda desfeita e fechamento com pendência eletrônica

### O que NÃO precisa de passo

- **Coluna nova `core_cash_sessions.closed_with_pending TEXT`**, anulável, no fim da DDL canônica. O `reconcileCoreSchema` a acrescenta por `ALTER TABLE … ADD COLUMN` em banco existente. Sem backfill: turno já fechado fica `NULL`, que quer dizer "fechou sem pendência declarada" — e é verdade, porque antes ninguém perguntava. A reabertura arquiva o valor em `closing_trail` e volta a coluna a `NULL`.
- **Campos novos só em documentos de `payment_terminal_transactions`**, lidos com padrão para o formato antigo:
  - `cashSessionId` e `pdvTerminalId` — o turno e o caixa de onde o PDV cobrou. Cobrança antiga não tem: o fechamento a encontra pela janela do turno (começou depois da abertura, mesmo caixa; sem caixa com sem caixa).
  - `aEstornarCents` e `estornosPedidos` — o que o cancelamento/devolução da venda mandou estornar (ausente = 0).
  - `semVendaTratadaAt/Por/Motivo`, `vinculadaPor/Em/vinculoMotivo`, `refundVia: 'manual'` — as saídas da fila do gestor.
- Nenhum índice novo, nenhuma reconstrução, nenhuma tabela nova.

### Dado antigo

Este lote não abriu o banco operacional (a leitura em modo somente leitura foi recusada pelo ambiente e não foi contornada). O que se sabe vem dos lotes anteriores: P1 registrou duas cobranças simuladas antigas da Preço Justo sem venda (uma `authorized`, uma `declined`); P4, nenhum agente e nenhum caixa.

- A `authorized` sem venda passa a aparecer em **Vendas › Conferência de maquininha › Cobranças sem venda** — é exatamente o dinheiro órfão que a ficha descreve, aqui simulado. O gestor a trata pela tela (Registrar tratativa, ou Cancelar na operadora); sem SQL, porque tratar exige motivo e auditoria. A `declined` não é pendência.
- **PIX pago na maquininha antes desta versão e usado numa venda não tem `saleId`**: o carimbo só existia para cartão. Ele aparece na fila como "sem venda". O caminho é a tela (Amarrar à venda, pelo número). Se o integrador preferir carimbar no passo de consolidação, o SQL abaixo liga cada cobrança PIX à venda CONCLUÍDA cuja linha de pagamento a aponta (`provider_ref`), na mesma empresa. Venda cancelada fica de fora de propósito: aquele PIX é estorno a fazer, e continua na fila para o gestor.

```sql
UPDATE payment_terminal_transactions
   SET data = json_set(
         data,
         '$.saleId',     (SELECT p.sale_id FROM core_sale_payments p JOIN core_sales s ON s.id = p.sale_id
                           WHERE p.provider_ref = payment_terminal_transactions.id
                             AND p.company_id = json_extract(payment_terminal_transactions.data, '$.companyId')
                             AND s.status = 'completed' LIMIT 1),
         '$.saleNumber', (SELECT s.number FROM core_sale_payments p JOIN core_sales s ON s.id = p.sale_id
                           WHERE p.provider_ref = payment_terminal_transactions.id
                             AND p.company_id = json_extract(payment_terminal_transactions.data, '$.companyId')
                             AND s.status = 'completed' LIMIT 1),
         '$.boundAt',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         '$.boundBy',    'migracao-consolidacao'
       )
 WHERE json_extract(data, '$.paymentMethod') = 'pix'
   AND json_extract(data, '$.saleId') IS NULL
   AND EXISTS (SELECT 1 FROM core_sale_payments p JOIN core_sales s ON s.id = p.sale_id
                WHERE p.provider_ref = payment_terminal_transactions.id
                  AND p.company_id = json_extract(payment_terminal_transactions.data, '$.companyId')
                  AND s.status = 'completed');
```

Validado em SQLite de rascunho em memória (nenhum banco real tocado), com cinco cobranças: a PIX que pagou venda concluída foi carimbada com id e número; a PIX de venda cancelada, a PIX sem linha nenhuma, a PIX apontada por linha de OUTRA empresa e o cartão já carimbado ficaram intocados; rodar de novo alterou 0 linhas.

---

## P6 — GAP-PRD-044 / 045 / 046 / 082 / 083 / 203: fila offline, agente de impressão e prontidão das operações

### O que NÃO precisa de passo

- **Tabela nova `core_offline_sale_pendings`** (GAP-PRD-045/046), com o índice `ix_offline_sale_pendings_status (company_id, status, cash_session_id)` na mesma DDL canônica (`server/src/db/schema.ts`) e na ordem de exclusão de testes. Só aponta para `core_companies`. O boot a cria em banco existente. Guarda a venda feita com o servidor fora que o servidor recusou ao voltar — com o corpo original e a MESMA chave de idempotência (`UNIQUE (company_id, idempotency_key)`).
- **Colunas novas em `core_printers`** (GAP-PRD-082): `pdv_terminal_id TEXT` e `agent_device TEXT`, anuláveis, no fim da DDL canônica. O `reconcileCoreSchema` as acrescenta. Sem backfill: impressora antiga fica "da operação" (sem caixa) e sem endereço — a de navegador não precisa de nenhum dos dois; a de agente antiga aparece na tela com "não tem o endereço no computador do caixa" e o cupom continua saindo pelo navegador até alguém preencher.
- **Colunas novas em `core_print_jobs`**: `transport TEXT`, `open_drawer INTEGER NOT NULL DEFAULT 0`, `pdv_terminal_id TEXT`, `agent_id TEXT`, `claimed_at TEXT`, `fallback_reason TEXT`, `reason TEXT`. Todas anuláveis ou com DEFAULT; o `reconcileCoreSchema` as acrescenta (`ADD COLUMN ... NOT NULL DEFAULT 0` é aceito pelo SQLite). Job antigo fica com `transport` nulo, lido como navegador — é o que ele foi.
- **Nenhum índice novo sobre coluna nova de tabela existente.** A fila do agente consulta `core_print_jobs` por `company_id, status` (índice `ix_print_jobs_company` já existe) e filtra `transport`/`pdv_terminal_id` nas poucas linhas prontas de uma operação.

### Índice opcional para o passo de consolidação

Se o volume de `core_print_jobs` crescer a ponto de a retirada do agente (a cada long-poll de 25 s por caixa) pesar, este índice parcial atende exatamente a consulta de `PrintAgentQueue.retirarImpressoes`. Não foi posto no boot porque é índice sobre coluna nova de tabela existente (REGRAS, seção 5). É idempotente e não tem pré-condição:

```sql
CREATE INDEX IF NOT EXISTS ix_print_jobs_agent_ready
  ON core_print_jobs (company_id, pdv_terminal_id, created_at)
 WHERE transport = 'agent' AND status IN ('ready', 'printing');
```

### Dado antigo

Conferido no banco operacional em modo somente leitura em 11/09/2026: `core_acquirer_rates` 0 linhas nas seis operações (a Preço Justo tem 1 operadora, a `ZZ-TESTE` inativa); `core_printers` 1 linha (Preço Justo, cupom, navegador, 80 mm); `payment_terminal_local_agents` 0; `core_terminals` 0; a configuração `mock` da Preço Justo continua ligada (o caminho de desligar é o do P1). A tabela `core_offline_sale_pendings` ainda não existe lá — nasce na primeira subida desta versão. **Não há SQL de correção de dado para este lote**: taxa de operadora e impressora são cadastro do dono pelas telas (Financeiro › Operadoras de cartão; Configurações › Impressoras), e a prontidão de go-live (`configurationPending`) lista o que falta por operação.
