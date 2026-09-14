# Frente FIS — mudanças de banco para o passo de consolidação

Nenhum lote da frente FIS cria passo numerado nem mexe em `CORE_TARGET_VERSION`
(REGRAS.md, seção 5). O que precisar de índice em coluna nova, reconstrução de
tabela, troca de constraint ou correção de dado fica descrito aqui, com o SQL
exato, para o integrador.

## Lote F1 — GAP-PRD-003 (assinatura XMLDSig) e GAP-PRD-097 (XSD)

**Esquema: nenhuma mudança.** Nenhuma tabela nova, nenhuma coluna nova, nenhum
índice. A assinatura e a validação de leiaute são código; os XSDs moram em
arquivo (`server/fiscal-schemas/PL_010b_V1.30`, com `MANIFESTO.json`), não no
banco.

**Dados já existentes: nada a corrigir hoje — conferido no banco da loja em
modo somente leitura (`new DatabaseSync(caminho, { readOnly: true })`), em
11/09/2026:**

- `core_fiscal_documents`: 0 linhas; `core_fiscal_queue`: 0 linhas. Não existe
  nenhum XML assinado pelo assinador antigo (indentado, com digest que não é
  C14N) para reassinar.
- `core_fiscal_configs`: 1 configuração (RS, homologação), com CEP preenchido.
  A nova exigência de CEP do emitente (o XSD `TEnderEmi` o torna obrigatório)
  não bloqueia a emissão da loja.

**Se, até o deploy, aparecer documento assinado pela versão antiga** (só é
possível se alguém emitir com A1 real antes de receber este branch), ele é
reconhecível assim — XML assinado de verdade (não fixture) que ainda tem quebra
de linha entre as tags:

```sql
SELECT id, company_id, model, serie, number, status
  FROM core_fiscal_documents
 WHERE COALESCE(xml_signed, '') <> ''
   AND xml_signed NOT LIKE '%GS-FIXTURE-SIGNATURE%'
   AND instr(xml_signed, char(10)) > 0
   AND status IN ('SIGNED', 'QUEUED', 'CONTINGENCY');
```

A correção NÃO é editar o XML (qualquer byte muda o digest): é levar o
documento a `ERROR` e de volta a `DRAFT`, para o pipeline (`advanceDocument`)
reassinar a partir de `xml_original` com o assinador novo. A recuperação de
documentos em ERROR pela tela é do lote F3 (fila autônoma e recuperação).

**Configuração sem CEP do emitente** (para a prontidão explicar antes da
venda; nenhuma escrita):

```sql
SELECT company_id, uf, environment
  FROM core_fiscal_configs
 WHERE length(replace(replace(COALESCE(zip, ''), '-', ''), '.', '')) <> 8;
```

## Lote F2 — GAP-PRD-004, GAP-PRD-005, GAP-PRD-018, GAP-PRD-019

**Esquema: uma tabela NOVA, na DDL canônica — nada para o passo de
consolidação.** `core_fiscal_act_policies` (a decisão do dono: cofre ou senha
digitada nos atos com a SEFAZ) nasce com `CREATE TABLE IF NOT EXISTS` em
`server/src/db/schema.ts`; o boot a cria em banco existente. Chave primária em
`company_id`, sem índice adicional. Sem linha, vale o padrão seguro (cofre).
Entrou em `CORE_TABLES_IN_DELETE_ORDER` antes de `core_fiscal_configs`.

```sql
CREATE TABLE IF NOT EXISTS core_fiscal_act_policies (
  company_id             TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
  require_typed_password INTEGER NOT NULL DEFAULT 0,
  updated_by             TEXT,
  updated_at             TEXT NOT NULL
);
```

**Dados já existentes: nada a corrigir hoje.** A conferência somente leitura do
lote F1 (11/09/2026) encontrou 0 linhas em `core_fiscal_documents` e em
`core_fiscal_queue` no banco da loja — não há documento lido pelo parser antigo
nem evento fabricado pelo simulador. (Neste lote o banco da loja não foi
aberto.) Se, até o deploy, alguém emitir ou cancelar pela versão antiga, os
casos são reconhecíveis assim:

1. **GAP-PRD-004 — autorização lida como rejeição (cStat do lote).** Nota que a
   SEFAZ autorizou e o parser antigo gravou como REJECTED com o 104 do lote:

   ```sql
   SELECT id, company_id, model, serie, number, access_key
     FROM core_fiscal_documents
    WHERE status = 'REJECTED' AND c_stat = '104';
   ```

   Correção: NÃO reemitir (seria duplicidade 539). Consultar a chave
   (`consultAndReconcile` da fila, `FiscalQueueService`), que agora lê o
   `infProt Id=` e leva o documento a AUTHORIZED com o protocolo real. A tela de
   recuperação da fila é do lote F3.

2. **GAP-PRD-005 / GAP-PRD-018 — cancelamento fabricado pelo simulador sobre
   nota real.** Documento com protocolo de autorização real e evento de
   cancelamento aceito com protocolo `TEST-`:

   ```sql
   SELECT d.id, d.company_id, d.model, d.serie, d.number, d.environment,
          d.protocol AS protocolo_da_nota, e.protocol AS protocolo_do_cancelamento
     FROM core_fiscal_documents d
     JOIN core_fiscal_events e ON e.document_id = d.id AND e.event_type = 'cancelled'
    WHERE d.status = 'CANCELLED'
      AND COALESCE(d.protocol, '') NOT LIKE 'TEST-%'
      AND e.protocol LIKE 'TEST-%';
   ```

   Correção, SÓ para as linhas encontradas e depois de conferir no portal da
   SEFAZ que a nota continua autorizada (o evento é append-only e fica como
   rastro; o que volta é o estado do documento):

   ```sql
   UPDATE core_fiscal_documents
      SET status = 'AUTHORIZED', cancelled_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (/* ids da consulta acima */);
   INSERT INTO core_fiscal_events (id, company_id, document_id, event_type, sequence, justification, created_at)
   SELECT lower(hex(randomblob(16))), company_id, id, 'cancel_reverted_test_provider', 1,
          'Cancelamento feito pelo simulador (GAP-PRD-005/018) desfeito: a SEFAZ mantém a nota autorizada.',
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
     FROM core_fiscal_documents WHERE id IN (/* os mesmos ids */);
   ```

   Depois disso o cancelamento de verdade sai pela tela, pelo adapter real.

## Lote F3 — GAP-PRD-020 (fila autônoma) e GAP-PRD-098 (contingência off-line)

**Esquema: duas tabelas NOVAS, só na DDL canônica** (`server/src/db/schema.ts`,
`CREATE TABLE IF NOT EXISTS` — o boot as cria em banco existente; nada a
consolidar):

- `core_fiscal_contingency_policies` (company_id PK, mode DEFAULT
  `'AGUARDAR'`, deadline_hours, note, updated_by, updated_at) — a modalidade
  decidida pelo contador. Sem linha, vale o padrão seguro (AGUARDAR).
- `core_fiscal_contingency_periods` (id, company_id, model, reason,
  justification, started_at/origin/by, trigger_code, ended_at/origin/by,
  last_probe_at/cstat/reason, created_at, updated_at) + o índice único parcial
  `ux_fiscal_contingency_active (company_id) WHERE ended_at IS NULL` (um
  período aberto por empresa). O índice é de TABELA NOVA, por isso fica na
  mesma DDL (REGRAS, seção 5).

As duas entraram em `CORE_TABLES_IN_DELETE_ORDER`, antes de `core_companies`.
Nenhuma coluna nova em tabela existente, nenhum índice sobre coluna existente,
nenhuma reconstrução.

**Dados já existentes: nada a corrigir por SQL.** O banco da loja NÃO foi
aberto neste lote (a leitura somente leitura foi negada pelo classificador de
permissões, como no F2); vale a conferência somente leitura do F1 em
11/09/2026: `core_fiscal_documents` e `core_fiscal_queue` com 0 linhas.

**O que muda no primeiro boot com este branch (para o dono saber):** o
trabalhador da fila (`startFiscalQueueWorker`, no `index.ts`) roda já na
subida e a cada minuto. Se até o deploy existir nota na fila:

- nota assinada de verdade (A1) com item vencido é TRANSMITIDA à SEFAZ pelo
  adapter real, com o A1 do cofre da própria empresa — é o comportamento
  pedido (antes ela esperava a próxima venda da mesma empresa);
- nota de ensaio (assinatura de fixture) com a operação ou o servidor em
  produção é PARADA (`dead`, `CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION`) e vira
  pendência — nunca vai ao simulador em produção;
- nota que tinha desistido por indisponibilidade e entrado em CONTINGENCY
  (regra antiga das cinco tentativas) volta sozinha à fila na primeira
  sondagem com resposta 107 da SEFAZ.

Para ver o que o trabalhador vai encontrar, antes do deploy (somente leitura):

```sql
SELECT q.company_id, d.model, d.status AS documento, q.status AS fila, q.attempts,
       q.next_attempt_at, q.error_code,
       CASE WHEN d.xml_signed LIKE '%GS-FIXTURE-SIGNATURE%' THEN 'ensaio' ELSE 'A1' END AS assinatura
  FROM core_fiscal_queue q
  JOIN core_fiscal_documents d ON d.id = q.document_id
 WHERE q.status IN ('pending', 'retry', 'sending', 'dead')
 ORDER BY q.company_id, q.created_at;
```

## Lote F4 — GAP-PRD-021, GAP-PRD-095, GAP-PRD-129, GAP-PRD-041, GAP-PRD-178

**Esquema: quatro colunas NOVAS em tabela existente, anuláveis, só na DDL
canônica** de `core_tax_groups` (`server/src/db/schema.ts`; o
`reconcileCoreSchema` as acrescenta em banco existente). Nenhum índice, nenhuma
reconstrução, nada para o passo de consolidação:

- `icms_rate_code TEXT` — código da alíquota de ICMS (`core_tax_rates`, kind
  `icms`) lida pelos CST 00, 20 e 90;
- `p_red_bc TEXT` — percentual de redução da base (obrigatório no CST 20,
  opcional no 90);
- `fcp_rate_code TEXT` — código da alíquota de FCP (kind `fcp`);
- `c_benef TEXT` — código de benefício fiscal da UF (sai no `<prod>`).

`core_tax_rates.kind` é texto sem CHECK: voltar a aceitar `icms` e passar a
aceitar `fcp` é regra do serviço, sem mudança no banco.

**Dados já existentes: nada a corrigir por SQL automático.** O que muda no
primeiro boot é só LEITURA: o checklist passa a olhar os grupos tributários, e
a PJ (grupo `SIMPLES-101` sem pCredSN e sem CST de PIS/COFINS, segundo a
auditoria) passa a ver `product_tax_group` FAIL com o contador como dono — é o
comportamento pedido. A correção é o contador informar e a gerência gravar em
Catálogo › Grupos tributários. Consultas somente leitura para conferir antes:

1. Grupos ativos e o que o checklist vai cobrar deles:

   ```sql
   SELECT c.slug, g.code, f.crt, g.csosn, g.p_cred_sn, g.cst_icms, g.icms_rate_code,
          g.cst_pis, g.cst_cofins, g.cfop_internal, g.origin
     FROM core_tax_groups g
     JOIN core_companies c ON c.id = g.company_id
     LEFT JOIN core_fiscal_configs f ON f.company_id = g.company_id
    WHERE g.active = 1
    ORDER BY c.slug, g.code;
   ```

2. CRT gravado fora do leiaute (a gravação agora o recusa; o checklist mostra
   DIVERGENTE e a tela oferece os quatro valores para corrigir):

   ```sql
   SELECT company_id, crt FROM core_fiscal_configs
    WHERE COALESCE(TRIM(crt), '') NOT IN ('', '1', '2', '3', '4');
   ```

3. **Produtos criados pela entrada de nota com o CFOP do FORNECEDOR** (o
   comportamento antigo, sem `default_sale_cfop`; desde este lote o produto
   nasce sem CFOP e o grupo responde por ele). O CFOP próprio do produto VENCE
   o do grupo, então estes continuam saindo com a operação do fornecedor até
   alguém corrigir:

   ```sql
   SELECT p.company_id, p.id, p.name, p.cfop
     FROM core_products p
    WHERE p.active = 1
      AND COALESCE(TRIM(p.cfop), '') <> ''
      AND EXISTS (SELECT 1 FROM core_inbound_note_items i
                   WHERE i.company_id = p.company_id AND i.product_id = p.id
                     AND i.cfop = p.cfop)
      AND NOT EXISTS (SELECT 1 FROM core_inbound_configs k
                       WHERE k.company_id = p.company_id AND k.default_sale_cfop = p.cfop);
   ```

   Correção, SÓ depois de o contador confirmar que o CFOP do grupo vale para
   estes produtos (e de o grupo ter `cfop_internal`), pela alteração rápida da
   tela ou, em lote, com os ids confirmados:

   ```sql
   UPDATE core_products
      SET cfop = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (/* ids confirmados pelo contador */);
   ```

## Lote F5 — GAP-PRD-022, GAP-PRD-023, GAP-PRD-179, GAP-PRD-180

**Esquema: nenhuma mudança.** Nenhuma tabela, coluna ou índice. `nfce_settings`
e `fiscal_certificate_references` são coleções de documentos
(`server/src/db/database.ts`, JSON na coluna `data`), e o formato novo lê o
antigo:

- `nfce_settings` passa a ter um documento por (empresa, unidade, **ambiente**)
  — até dois por operação. Documento sem `environment` é lido como
  `homologation` (o padrão com que foi gravado). Gravar o CSC de produção deixa
  de exigir `NFCE_PRODUCTION_ENABLED` (a variável continua valendo só para o
  módulo legado `NfceService`).
- `fiscal_certificate_references`: revogar remove `encryptedPfx` **e**
  `encryptedPassword`; reenviar remove `revokedAt`/`revokeReason` do topo e
  acrescenta `historico` (lista sem segredo: série, impressão digital,
  validade, status, motivo da revogação, data da troca).
- Unidade: todas as rotas passam a gravar e ler só `unit-default`; outra
  unidade é recusada (400 `CORE_FISCAL_UNIT_NOT_SUPPORTED`).

**Dados já existentes.** Neste lote o banco da loja NÃO foi aberto; os fatos
abaixo são da leitura somente leitura da auditoria (11/09/2026):
`fiscal_certificate_references` com 1 documento (PJ, `unit-default`, `valid`,
`encryptedPfx` presente, **`encryptedPassword` ausente**, sem titular nem
conferência de CNPJ); `nfce_settings` vazia. Consultas somente leitura para
conferir no dia do deploy — só a coluna `data` é usada, então valem qualquer
que seja o resto do esquema da coleção:

1. **Certificado sem senha selada (GAP-PRD-023).** Não se corrige por SQL: a
   senha não está em lugar nenhum do banco. A correção é o DONO reenviar o
   mesmo `.pfx` com a senha em Fiscal › Certificado (o reenvio sela a senha e
   preenche titular e conferência). A prontidão agora mostra o item
   `certificate` FAIL/PENDENTE com essa instrução.

   ```sql
   SELECT json_extract(data, '$.companyId')         AS empresa,
          json_extract(data, '$.operationalUnitId') AS unidade,
          json_extract(data, '$.status')            AS status,
          json_extract(data, '$.validTo')           AS valido_ate,
          json_type(data, '$.encryptedPfx')      IS NOT NULL AS tem_arquivo,
          json_type(data, '$.encryptedPassword') IS NOT NULL AS tem_senha
     FROM fiscal_certificate_references;
   ```

2. **Revogado que ainda guarda a senha (GAP-PRD-179)** — só existe se alguém
   revogou pela versão antiga. Esperado: nenhum (o único documento da loja está
   `valid`). Correção segura e idempotente, para o passo de consolidação:

   ```sql
   SELECT json_extract(data, '$.companyId') AS empresa, json_extract(data, '$.revokedAt') AS revogado_em
     FROM fiscal_certificate_references
    WHERE json_extract(data, '$.status') = 'revoked'
      AND json_type(data, '$.encryptedPassword') IS NOT NULL;

   UPDATE fiscal_certificate_references
      SET data = json_remove(data, '$.encryptedPassword', '$.encryptedPfx')
    WHERE json_extract(data, '$.status') = 'revoked'
      AND (json_type(data, '$.encryptedPassword') IS NOT NULL
           OR json_type(data, '$.encryptedPfx') IS NOT NULL);
   ```

3. **Válido com carimbo de revogação (GAP-PRD-179)** — reenvio feito pela
   versão antiga depois de uma revogação. A revogação continua registrada na
   auditoria (`fiscal.certificate.revoke`); os carimbos no topo só confundem.
   Esperado: nenhum.

   ```sql
   SELECT json_extract(data, '$.companyId') AS empresa,
          json_extract(data, '$.revokedAt') AS revogado_em,
          json_extract(data, '$.revokeReason') AS motivo
     FROM fiscal_certificate_references
    WHERE json_extract(data, '$.status') = 'valid'
      AND json_type(data, '$.revokedAt') IS NOT NULL;

   UPDATE fiscal_certificate_references
      SET data = json_remove(data, '$.revokedAt', '$.revokeReason')
    WHERE json_extract(data, '$.status') = 'valid'
      AND json_type(data, '$.revokedAt') IS NOT NULL;
   ```

4. **Certificado ou CSC sob outra unidade (GAP-PRD-180)** — gravados pelas
   rotas antigas (`operationalUnitId` no corpo, ou `/integrations/*/secrets`,
   que usava o `storeId` do token). Nada que emite os lê, antes ou agora.
   Esperado: nenhum. NÃO mover por SQL: um arquivo sob "loja-2" pode não ser o
   da operação, e trocar o certificado de quem emite sem conferência é o erro
   que a conferência de CNPJ existe para impedir. A correção é reenviar pela
   tela (Fiscal › Certificado; o CSC em Fiscal › Configuração).

   ```sql
   SELECT 'certificado' AS o_que, json_extract(data, '$.companyId') AS empresa,
          json_extract(data, '$.operationalUnitId') AS unidade, json_extract(data, '$.status') AS status
     FROM fiscal_certificate_references
    WHERE COALESCE(json_extract(data, '$.operationalUnitId'), '') <> 'unit-default'
   UNION ALL
   SELECT 'csc', json_extract(data, '$.companyId'), json_extract(data, '$.operationalUnitId'),
          COALESCE(json_extract(data, '$.environment'), 'homologation')
     FROM nfce_settings
    WHERE COALESCE(json_extract(data, '$.operationalUnitId'), '') <> 'unit-default';
   ```

5. **CSC (GAP-PRD-022)** — nada a migrar: `nfce_settings` está vazia na loja, e
   documento antigo sem `environment` é lido como homologação. Um CSC gravado
   como produção pela versão antiga (só com a variável ligada) continua valendo
   como produção.

## Lote F6 — GAP-PRD-026 (identidade da unidade no documento) e GAP-PRD-024 (caminho fiscal da OS)

**Esquema: duas tabelas NOVAS, só na DDL canônica** (`server/src/db/schema.ts`,
`CREATE TABLE IF NOT EXISTS` — o boot as cria em banco existente; nada a
consolidar). Nenhuma coluna nova em tabela existente, nenhum índice sobre
coluna existente, nenhuma reconstrução:

- `core_nfse_configs` (company_id PK; `mode` DEFAULT `'DESLIGADA'` — padrão
  seguro: sem linha ou sem decisão, o sistema não emite NFS-e; `environment`
  DEFAULT `'homologation'`; códigos do contador; série e próximo número da
  DPS; confirmação do município).
- `core_nfse_documents` (uma NFS-e por venda: `UNIQUE (company_id, sale_id)`,
  que é constraint da tabela nova, na mesma DDL).

As duas entraram em `CORE_TABLES_IN_DELETE_ORDER` antes de `core_fiscal_queue`
(o documento aponta para `core_sales`; a configuração só para a empresa).

**`core_product_units.sale_item_id`** já existia e passa a ser GRAVADO pela
venda (GAP-PRD-026). Nenhuma mudança de esquema.

**Dados já existentes: nada a corrigir obrigatoriamente.** O banco da loja NÃO
foi aberto neste lote (a leitura somente leitura foi negada pelo classificador
de permissões nos lotes F2–F5); valem os fatos N2 da auditoria.

1. **Unidade vendida antes do carimbo** (a auditoria registrou 0 unidades
   serializadas no banco real, então o esperado é nenhuma). O leitor
   `unidadesPorLinha` já acha a unidade pela referência de saída quando a
   linha do produto é única — não precisa de correção. Se o integrador quiser
   deixar o carimbo explícito (opcional, idempotente, só onde não há
   ambiguidade):

   ```sql
   -- Conferência:
   SELECT u.id, u.company_id, u.exit_reference_id AS sale_id, u.product_id
     FROM core_product_units u
    WHERE u.status = 'sold' AND u.exit_reference_type = 'sale' AND u.sale_item_id IS NULL;

   -- Carimbo opcional: só quando a venda tem UMA linha daquele produto.
   UPDATE core_product_units
      SET sale_item_id = (
            SELECT i.id FROM core_sale_items i
             WHERE i.sale_id = core_product_units.exit_reference_id
               AND i.product_id = core_product_units.product_id)
    WHERE status = 'sold' AND exit_reference_type = 'sale' AND sale_item_id IS NULL
      AND (SELECT COUNT(*) FROM core_sale_items i
            WHERE i.sale_id = core_product_units.exit_reference_id
              AND i.product_id = core_product_units.product_id) = 1;
   ```

2. **Venda de OS cobrada antes desta correção** (uma linha "Ordem de serviço
   #N", sem produto — a auditoria cita a venda #1 da Oficina, OS #2). NÃO se
   reescreve a venda: a nota de mercadoria a itemiza pela própria OS
   (`FiscalVendaDaOficina`), desde que o valor cobrado seja o total da OS; a
   mão de obra vai para a NFS-e. Conferência somente leitura — as que a
   itemização pela OS não alcança (o total cobrado difere do total da OS) e
   ficam sem nota de peças até alguém conferir:

   ```sql
   SELECT s.company_id, s.id AS sale_id, s.number AS venda, o.number AS os,
          s.total_cents AS cobrado, o.total_cents AS total_da_os,
          o.parts_cents, o.labor_cents
     FROM core_sales s
     JOIN core_service_orders o ON o.sale_id = s.id AND o.company_id = s.company_id
    WHERE NOT EXISTS (SELECT 1 FROM core_sale_items i
                       WHERE i.sale_id = s.id AND i.product_id IS NOT NULL)
    ORDER BY s.company_id, s.number;
   ```

   Linha com `cobrado <> total_da_os` é caso de conferência humana (a OS mudou
   depois de cobrada); o sistema recusa a itemização e diz o motivo.

**O que muda no primeiro boot com este branch:** nada é emitido sozinho. A
NFS-e nasce desligada em todas as empresas; a venda de OS nova sai itemizada
(peça com produto e custo — passa a entrar no CMV/DRE e no relatório de
produtos vendidos, que antes não viam a peça vendida pela oficina).

## Lote F7 — GAP-PRD-051, GAP-PRD-176, GAP-PRD-096, GAP-PRD-181, GAP-PRD-163

O banco da loja NÃO foi aberto neste lote (a leitura somente leitura foi negada
pelo classificador de permissões, como nos lotes F2–F6). Os fatos do banco real
citados abaixo são os da auditoria (fichas GAP-PRD-181 e GAP-PRD-096).

### GAP-PRD-051 e GAP-PRD-176 — pacote do contador

**Esquema: nenhuma mudança.** As datas do MANIFESTO/CSV passam a ser o dia da
loja (código). O SHA-256 do zip e do MANIFESTO vai no `detail` (JSON) das
linhas de `core_audit_log` com `action` `fiscal.closing.package` e
`contador.pacote_email` — coluna que já existe.

**Dados já existentes: nada a corrigir.** Pacotes baixados ou enviados ANTES do
deploy não têm hash na trilha; a conferência (`GET /core/fiscal/closings/
conferir`) responde "não reconhecido" para eles, e isso é a verdade — não há
como provar a posteriori o que saiu sem hash. Basta baixar/enviar de novo.

### GAP-PRD-096 — rotas fiscais legadas

**Esquema: nenhuma mudança.** As rotas `/api/v1/fiscal`, `/api/v1/fiscal/nfe` e
quase todas de `/api/v1/fiscal/nfce` saíram; `/fiscal/nfce/csc` fica. As
coleções JSON legadas (`nfe_documents`, `nfe_operational_attempts`,
`nfe_homologation_executions`, `nfe_reconciliation`, `nfce_documents`,
`nfce_queue`, `nfce_homologation_executions` e as da camada `fiscal_*` do
roteador `/fiscal`) continuam criadas por `db/database.ts` e ninguém mais as
escreve por rota. Não são apagadas neste passo: `NfceService`/`NfeService`
seguem importados pelos testes de homologação e pela prontidão legada.

Conferência somente leitura (a auditoria encontrou a tabela `nfe_documents`
fora do pipeline real; o esperado é ter só lixo de teste ou nada):

```sql
SELECT 'nfe_documents' AS colecao, COUNT(*) AS linhas FROM nfe_documents
UNION ALL SELECT 'nfce_documents', COUNT(*) FROM nfce_documents
UNION ALL SELECT 'nfe_operational_attempts', COUNT(*) FROM nfe_operational_attempts
UNION ALL SELECT 'nfce_queue', COUNT(*) FROM nfce_queue;

-- Documentos legados com chave FABRICADA ("3526<timestamp>", menos de 44
-- dígitos) — gravados pela rota /number que atravessava empresa:
SELECT id, json_extract(data, '$.companyId') AS empresa,
       json_extract(data, '$.accessKey') AS chave, json_extract(data, '$.status') AS status
  FROM nfe_documents
 WHERE length(COALESCE(json_extract(data, '$.accessKey'), '')) BETWEEN 1 AND 43;
```

Limpeza OPCIONAL, para o passo de consolidação, só depois de conferir que as
linhas são de teste (nenhuma nota real nasceu dessas coleções — o pipeline é
`core_fiscal_documents`):

```sql
DELETE FROM nfe_documents
 WHERE length(COALESCE(json_extract(data, '$.accessKey'), '')) BETWEEN 1 AND 43;
```

### GAP-PRD-181 — o XML de entrada completa o cadastro

**Esquema: colunas NOVAS em tabelas existentes, todas anuláveis, só na DDL
canônica** (`server/src/db/schema.ts`; o `reconcileCoreSchema` as acrescenta em
banco existente). Nenhum índice, nenhuma reconstrução, nada para o passo de
consolidação:

- `core_suppliers.city_ibge TEXT` — o `<cMun>` do emitente; mudar a cidade do
  fornecedor o apaga (`SupplierService.updateSupplier`);
- `core_inbound_notes.model TEXT`, `recipient_document TEXT`,
  `recipient_name TEXT` — o modelo e o destinatário da nota;
- `core_inbound_note_items.icms_cst`, `icms_csosn`, `ipi_cst`, `pis_cst`,
  `cofins_cst` (TEXT) e `icms_cents`, `icms_st_cents`, `ipi_cents`,
  `pis_cents`, `cofins_cents` (INTEGER) — a tributação que o fornecedor
  declarou no item (a SAÍDA dele; nunca vira a tributação do produto).

**Dados já existentes: o caminho de correção é a RELEITURA, disparada por
gente — nunca no boot.** `POST /core/fiscal/classification/reler-notas`
(gerência; botão "Reler as notas já recebidas" em Fiscal › Configuração, no
cartão das sugestões do XML) relê o `xml_original` guardado de cada nota da
empresa e completa SÓ o que está nulo: modelo/destinatário da nota, campos em
branco do fornecedor (o digitado nunca é sobrescrito), CEST/origem/tributos do
item, as sugestões de classificação das notas anteriores ao recurso, e a
procedência `xml_fornecedor` do produto que se prova nascido da nota (criado
entre a importação e a confirmação dela, com o nome da linha e o NCM do
arquivo). É idempotente e deixa trilha (`fiscal.inbound_notes_reread`).

O caso do banco real (auditoria): dois produtos da PJ com o NCM do item da nota
recebida em 12/08, `fiscal_classification_source` nulo, e
`core_product_fiscal_suggestions` vazia. Conferência somente leitura antes e
depois de clicar:

```sql
-- Produtos com o NCM igual ao do item da nota que os criou, sem procedência:
SELECT p.company_id, p.id, p.name, p.ncm, p.created_at, n.access_key, n.received_at
  FROM core_products p
  JOIN core_inbound_note_items i ON i.product_id = p.id AND i.company_id = p.company_id
  JOIN core_inbound_notes n ON n.id = i.note_id
 WHERE p.fiscal_classification_source IS NULL
   AND p.fiscal_confirmed_at IS NULL
   AND p.ncm = i.ncm
   AND p.name = i.description;

-- Notas com XML guardado que ainda não geraram sugestão:
SELECT n.company_id, n.id, n.access_key
  FROM core_inbound_notes n
 WHERE COALESCE(n.xml_original, '') <> ''
   AND NOT EXISTS (SELECT 1 FROM core_product_fiscal_suggestions s WHERE s.note_id = n.id);
```

A releitura NÃO é SQL: ela depende do parser (`parseNfeXml`) e das regras de
"só o que está em branco" e "o IBGE só anda com a cidade", que moram no código.

### GAP-PRD-163 — a NFC-e no Finalizar

**Esquema: uma tabela NOVA, só na DDL canônica** (`CREATE TABLE IF NOT EXISTS`;
o boot a cria em banco existente; o CHECK é constraint da tabela nova, na mesma
DDL). Entrou em `CORE_TABLES_IN_DELETE_ORDER` ao lado de
`core_fiscal_act_policies`:

```sql
CREATE TABLE IF NOT EXISTS core_fiscal_emission_policies (
  company_id       TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
  nfce_on_finalize TEXT NOT NULL DEFAULT 'MANUAL'
                   CHECK (nfce_on_finalize IN ('MANUAL', 'AUTOMATICA')),
  updated_by       TEXT,
  updated_at       TEXT NOT NULL
);
```

**Dados já existentes: nada.** Sem linha vale MANUAL — o comportamento de
sempre. No primeiro boot nenhuma NFC-e passa a sair sozinha; só depois de o
dono escolher "Sozinha, no Finalizar" em Fiscal › Configuração.
