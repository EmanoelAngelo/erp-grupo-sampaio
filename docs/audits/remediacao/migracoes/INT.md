# Migrações da integração — grupo ESQ (GAP-PRD-140, GAP-PRD-142)

Nenhum passo numerado novo, e `CORE_TARGET_VERSION` continua **85**. Tudo o
que este grupo faz no banco mora no passo de consolidação:

- a correção de dado entra em `CORRECOES` de
  `server/src/db/consolidacaoDaRemediacao.ts` (passo 85, dentro da transação
  da migração, num `SAVEPOINT` próprio);
- o reparo do esquema é a fase do passo 85 que **não cabe** na transação
  (`PRAGMA foreign_keys` não muda dentro de uma): roda logo depois dela, no fim
  de `migrateCoreSchema` (`server/src/db/core-migrations.ts`), **a cada
  subida**, em `repararEsquema` (`server/src/db/derivaDoEsquema.ts`) — o mesmo
  lugar em que `resolverPendenciasDaConsolidacao` já rodava.

Nada foi aplicado no banco da loja. O banco operacional foi aberto só com
`new DatabaseSync(caminho, { readOnly: true })`, para confirmar os fatos e
para tirar o clone da prova (abaixo).

## GAP-PRD-142 — a competência legada no dia da loja

### Os dois backfills antigos passam a usar o dia da loja

Em `core-migrations.ts` (`diaDaLojaSql('created_at')` =
`substr(datetime(created_at, '-3 hours'), 1, 10)`):

```sql
-- reconstrução de core_finance_entries (rebuildFinanceEntries), quando o banco
-- ainda não tem competence_date:
--   antes:  substr(created_at, 1, 10)
--   agora:  substr(datetime(created_at, '-3 hours'), 1, 10)

-- passo 56:
UPDATE core_finance_entries
   SET competence_date = COALESCE(due_date, substr(datetime(created_at, '-3 hours'), 1, 10))
 WHERE competence_date IS NULL;
```

Passo já aplicado não roda de novo; a troca protege o banco restaurado de uma
cópia anterior ao passo 56, que recriaria o desvio.

### A correção no passo 85 — `fin_competencia_legada_no_dia_da_loja`

Função `corrigirCompetenciaLegada(db, { aplicar })` (exportada; `aplicar: false`
é o ensaio e só lista). Só lançamento AUTOMÁTICO, só quando a competência é o
dia UTC do carimbo e difere do dia da loja, e só linha que ninguém tocou:

```sql
-- As candidatas.
SELECT e.id, e.company_id, e.origin_type, e.competence_date, e.due_date,
       substr(datetime(e.created_at, '-3 hours'), 1, 10) AS dia
  FROM core_finance_entries e
 WHERE e.origin_type IN ('sale', 'ecommerce_order', 'sale_return', 'nfe_entrada')
   AND e.competence_date IS NOT NULL
   AND e.competence_date = substr(e.created_at, 1, 10)
   AND e.competence_date <> substr(datetime(e.created_at, '-3 hours'), 1, 10)
   AND e.cancelled_at IS NULL
   AND (e.settled_at IS NULL OR e.settled_at = e.created_at)   -- quitação automática do balcão, não baixa posterior
   AND NOT EXISTS (SELECT 1 FROM core_finance_settlements s WHERE s.entry_id = e.id)   -- sem baixa de gente
   AND NOT EXISTS (SELECT 1 FROM core_audit_log a
                    WHERE a.entity_type = 'finance_entry' AND a.entity_id = e.id)      -- sem edição/trilha
 ORDER BY e.created_at;

-- Para cada candidata (o vencimento vai junto só quando era igual à competência antiga):
UPDATE core_finance_entries
   SET competence_date = :dia,
       due_date        = :vencimento_novo   -- :dia se due_date = competência antiga; senão o due_date de antes
 WHERE id = :id AND competence_date = :competencia_antiga;

INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
VALUES ('audit-mig-142-' || :id, :company_id, NULL, 'finance.entry_competence_corrected', 'finance_entry', :id,
        :detalhe_json,  -- {"antes":{"competenceDate","dueDate"},"depois":{...},"originType","reason","by":"migracao-consolidacao"}
        NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Quantas linhas mudaram, por empresa, e quais:
INSERT INTO core_meta (key, value) VALUES ('consolidacao85:competencia_legada', :json)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

O total também sai em `consolidacao85:resultado` (`fin_competencia_legada_no_dia_da_loja:<n>`).

No clone do banco da loja: **3 linhas** — `372eca4c` (R$ 50,00) e `01fa3166`
(R$ 269,70), de 13/08 para **12/08**, e `647d022c` (pedido online, R$ 329,00),
de 16/08 para **15/08** —, duas na empresa `9348ff15…` e uma na `cfc491b0…`.

## GAP-PRD-140 — o banco migrado igual ao banco novo

### A referência

`referenciaDoEsquema()` monta um banco NOVO em memória pelo mesmo caminho do
boot — `criarColecoesDeDocumentos` (o corpo de `ensureSchema`), a DDL canônica
(`STATEMENTS`) e `migrateCoreSchema({ referencia: true })`, que num banco vazio
roda todos os passos e cria os índices que só existem neles — e o descreve:
colunas (nome, tipo, NOT NULL, DEFAULT, PK, gerada), UNIQUE e CHECK
declarados na tabela, índices (nome, tabela, colunas/expressão, único,
parcial). Os passos falam com `getConnection()`; durante a montagem a conexão
da API é trocada pela de memória (`comConexaoEmprestada`, em `sqlite.ts`) e
devolvida depois. Montada uma vez por processo.

### O reparo (depois da transação dos passos, a cada subida)

Só em banco que não é de build mais nova (núcleo acima do alvo não é tocado).
Cada item isolado; o que falha vira pendência e a subida continua.

```sql
-- (A) o que só acrescenta
CREATE TABLE <tabela> (<DDL canônica do banco novo>);
ALTER TABLE <tabela> ADD COLUMN <coluna> <tipo> [NOT NULL] [DEFAULT <padrão>];

-- (B) tabela com DEFAULT, NOT NULL, UNIQUE ou CHECK diferente: reconstrução pela DDL canônica.
--     Antes: cópia do banco (o snapshot pré-migração da mesma subida, ou
--     snapshotDatabase('pre-reparo-esquema')); sem cópia, não reconstrói.
--     Recusa (vira pendência, sem tocar): coluna que o banco novo não tem
--     (apagaria dado), coluna obrigatória sem DEFAULT faltando, ou — na subida —
--     a mesma divergência já tentada e desfeita (core_meta
--     'esquema:reconstrucao_desfeita:<tabela>'): só o comando tenta de novo.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE "<tabela>__canonica" (<DDL canônica de <tabela>, do banco novo>);
INSERT INTO "<tabela>__canonica" (<colunas em comum>) SELECT <colunas em comum> FROM "<tabela>";
DROP TABLE "<tabela>";
ALTER TABLE "<tabela>__canonica" RENAME TO "<tabela>";
<os CREATE INDEX canônicos de <tabela>>;
UPDATE sqlite_sequence SET seq = MAX(seq, :seq_antes) WHERE name = '<tabela>';   -- se havia
-- Conferências; qualquer uma que acuse => ROLLBACK de tudo:
--   SELECT COUNT(*) igual ao de antes;
--   PRAGMA foreign_key_check sem referência órfã que não existia antes;
--   PRAGMA integrity_check = 'ok';
--   a tabela igual à do banco novo.
COMMIT;
PRAGMA foreign_keys = ON;

-- (C) índices — a cada subida, não só uma vez
CREATE INDEX <nome> ON ...;                              -- faltando
DROP INDEX IF EXISTS <nome>; CREATE INDEX <nome> ON ...; -- mesmo nome, outra definição
DROP INDEX IF EXISTS <nome>;                             -- ÚNICO que o banco novo não tem

-- Registro:
INSERT INTO core_meta (key, value) VALUES ('esquema:ultimo_reparo', :json) ON CONFLICT(key) DO UPDATE ...;
INSERT INTO core_audit_log (..., action, entity_type, ...) VALUES (..., 'system.schema.repaired', 'database_schema', ...);  -- quando reparou algo
```

Tabela, coluna e índice comum que só existem no banco são listados à parte
("a mais") e **nunca** apagados aqui — podem ser de build mais nova ou
aposentados (as coleções aposentadas têm o `db:podar-legado`).

No banco da loja, o reparo faz exatamente os cinco pontos da ficha:

```sql
-- core_service_orders reconstruída: status TEXT NOT NULL DEFAULT 'em_aberto' (era 'recebido');
--   com ela, o índice canônico volta:
CREATE INDEX ix_service_orders_status ON core_service_orders (company_id, workshop_id, status, updated_at);
-- core_finance_categories reconstruída: sai a UNIQUE (company_id, direction, name, parent_id) inline;
--   a unicidade fica no ux_finance_categories_name (COALESCE(parent_id, '')), que já existia.
CREATE INDEX ix_stock_movements_kind ON core_stock_movements (company_id, kind, created_at);
CREATE INDEX ix_fiscal_docs_order ON core_fiscal_documents (order_id);
```

### Onde se vê

- Log da subida: `[migração] esquema reparado contra o banco novo: …` e, se
  sobrar divergência, `[migração] o esquema continua diferente … em N ponto(s)`.
- `GET /system/readiness` → `schemaDrift` (situação, divergências pelo nome,
  último reparo, pendências, como resolver). Não bloqueia o núcleo (P3).
- Tela Configurações › Sistema › Prontidão do núcleo › "Esquema contra um banco novo".
- Comando `npm run db:conferir-esquema` (ensaio: abre o arquivo só para
  leitura, lista e sai com 1 se divergir) e
  `npm run db:conferir-esquema -- --reparar` (com a API parada: assume a trava
  do banco, tira a cópia, migra e repara, confere de novo). Em produção:
  `node server/dist/db/conferirEsquema.js [--reparar]`.

## Prova em clone do banco real (11/09/2026)

Banco operacional aberto com `readOnly: true`, `VACUUM INTO` para um arquivo
em `%TEMP%\esq-clone-*` (fora de qualquer repositório e fora da instalação da
loja), o clone migrado por `prepararBanco()` (o boot), conferido, e **apagado**
(`clone apagado: true`). Com `TEST_DATABASE_PATH` apontando o clone, nenhuma
cópia foi escrita em pasta de backup do repositório.

| | antes (como a loja está) | depois do boot |
|---|---|---|
| tamanho | 6.246.400 bytes | — |
| núcleo | versão 84 | versão 85 |
| divergências contra o banco novo | 147 (144 "falta" = migração pendente da v85, e as 3 da ficha que não são falta) | **0** |
| objetos só no banco | 169 | 168 tabelas aposentadas (nenhuma coluna, nenhum índice) |
| reparo do esquema | — | 5 divergências → 0; 4 itens (2 reconstruções, 2 índices), 0 pendências |
| consolidação do passo 85 | — | 37 itens aplicados, 0 pendências |
| tabelas / índices conferidos | — | 195 / 189 |
| `integrity_check` | ok | ok |
| `foreign_key_check` | 0 | 0 (chaves estrangeiras ligadas) |
| linhas (core_service_orders, core_finance_categories, core_finance_entries, core_sales, core_stock_movements, core_fiscal_documents, core_customers, core_products) | 2, 47, 9, 7, 32, 0, 2, 19 | idênticas |
| competência 372eca4c / 01fa3166 / 647d022c | 2026-08-13 / 2026-08-13 / 2026-08-16 | **2026-08-12 / 2026-08-12 / 2026-08-15** |
| `core_service_orders.status` DEFAULT | `'recebido'` | `'em_aberto'` |
| `ix_service_orders_status` | (company_id, status, updated_at) | (company_id, workshop_id, status, updated_at) |
| `ix_stock_movements_kind`, `ix_fiscal_docs_order` | ausentes (passos 9 e 39 marcados) | presentes |

Tempo do boot sobre o clone: ~3,3 s (inclui montar a referência em memória).

## DFE-AMBIENTE (GAP-PRD-168) — o NSU da Distribuição DF-e é por ambiente

O Ambiente Nacional numera homologação e produção em sequências separadas.
`core_dfe_documents` tinha `UNIQUE (company_id, nsu)` e o cursor era
`MAX(nsu)` da empresa: depois de homologar com notas reais (NSU 1..N), a
primeira consulta de produção partia de N, e a nota de produção de NSU
repetido era engolida pelo `INSERT OR IGNORE`.

### DDL canônica (`server/src/db/schema.ts`)

```sql
environment TEXT NOT NULL DEFAULT 'homologation'
            CHECK (environment IN ('homologation', 'production')),
...
UNIQUE (company_id, environment, nsu)
```

Nenhum índice novo fora da tabela (a DDL canônica roda antes dos passos; a
UNIQUE já indexa `(company_id, environment, nsu)`).

### Passo 85 — item `dfe_ambiente_por_documento` (`garantirAmbienteDosDocumentosDfe`)

Dentro da transação da migração, num `SAVEPOINT` próprio, idempotente:

```sql
ALTER TABLE core_dfe_documents ADD COLUMN environment TEXT NOT NULL DEFAULT 'homologation';
UPDATE core_dfe_documents SET environment = CASE
  WHEN access_key IN (<as 2 chaves do simulador>)                      THEN 'homologation'
  WHEN xml tem '<tpAmb>1</tpAmb>' e não tem '<tpAmb>2</tpAmb>'          THEN 'production'
  WHEN xml tem '<tpAmb>2</tpAmb>' e não tem '<tpAmb>1</tpAmb>'          THEN 'homologation'
  ELSE COALESCE((SELECT CASE WHEN c.environment = 'production' THEN 'production' ELSE 'homologation' END
                   FROM core_fiscal_configs c WHERE c.company_id = core_dfe_documents.company_id), 'homologation')
END;
-- reconstrução pela DDL canônica, com as chaves estrangeiras LIGADAS:
CREATE TABLE core_dfe_documents__por_ambiente (<DDL canônica>);
INSERT INTO core_dfe_documents__por_ambiente (rowid, <todas as colunas>) SELECT rowid, <todas as colunas> FROM core_dfe_documents;
DROP TABLE core_dfe_documents;
ALTER TABLE core_dfe_documents__por_ambiente RENAME TO core_dfe_documents;
-- os índices que a tabela tinha (pelo SQL guardado) e os canônicos dela
```

- **Por que o ambiente das linhas antigas é esse**: a chave do simulador é
  homologação (o simulador nunca responde por produção; são as marcas de
  7eb354f); a nota completa traz o `tpAmb` que a própria SEFAZ carimbou; o
  resumo (resNFe) não traz ambiente, e a consulta sempre usou o ambiente
  fiscal da empresa — o atual é a melhor prova que sobra (sem configuração:
  homologação, o padrão).
- **Conferências**: contagem de linhas igual antes e depois, `rowid`
  preservado, `foreign_key_check` da tabela vazio; falhou, o `SAVEPOINT`
  desfaz e vira pendência da consolidação.
- **Adiada para o reparo do esquema** (sem derrubar a subida) quando a tabela
  tem referência órfã (copiá-la com as chaves ligadas falharia) ou coluna que
  o banco novo não tem. O ambiente é preenchido do mesmo jeito; o
  `repararEsquema` reconstrói depois da transação, com as chaves desligadas e
  a cópia do banco antes (e recria os índices canônicos da tabela).
- **Banco criado pela DDL canônica anterior** (85 sem a coluna): a mesma função
  roda de novo em `migrateCoreSchema`, antes do `reconcileCoreSchema`, a cada
  subida — com a tabela certa, só lê o catálogo.
- **Se a reconstrução ficar pendente**, a consulta não perde nota calada:
  inserção ignorada sem linha no ambiente desfaz o lote com 409
  `CORE_DFE_ESQUEMA_PENDENTE`, dizendo para rodar
  `npm run db:conferir-esquema -- --reparar`.

O banco da loja não foi aberto nesta frente. Prova:
`server/tests/dfe-ambiente-na-migracao.test.ts` (banco da 84 com linhas de
duas empresas, nota amarrada, marca do simulador e índice a mais; banco 85 sem
a coluna; vínculo órfão; a recusa em voz alta).
