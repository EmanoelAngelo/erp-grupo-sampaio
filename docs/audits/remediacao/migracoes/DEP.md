# Migrações da frente DEP

Nenhum passo numerado foi criado e `CORE_TARGET_VERSION` não mudou. O que a
frente precisou no banco está abaixo, com o que o integrador tem (ou não tem)
de fazer no passo de consolidação.

## Lote D2 — estado do backup, envio incremental das fotos (GAP-PRD-011, GAP-PRD-058)

### Tabelas novas — já na DDL canônica, nada a consolidar

Em `server/src/db/schema.ts` (`STATEMENTS`), com `CREATE TABLE IF NOT EXISTS`
— o boot as cria em banco existente — e na lista `CORE_TABLES_IN_DELETE_ORDER`:

- `core_backup_execucoes` — uma linha por execução do diário (gatilho, início,
  fim, e o resultado da cópia local, do envio do banco ao bucket e do envio
  das fotos, com o motivo da falha). Índice `idx_core_backup_execucoes_inicio`
  na mesma DDL (tabela nova, coluna própria). A própria rotina poda para as
  400 mais novas.
- `core_backup_uploads` — o índice das fotos (caminho, tamanho, data de
  modificação, sha256), para o diário não reler o catálogo inteiro todo dia.
- `core_backup_objetos_remotos` — o que já está no bucket, por
  `(destino, sha256)`; `destino` é a digital de URL + bucket (nunca a chave).

Nenhuma coluna nova em tabela existente, nenhum índice sobre coluna existente,
nenhuma reconstrução.

### Dado antigo — opcional, sem pressa

- `core_meta.uploads_backup_digital` (a digital do último PACOTE de fotos,
  formato versão 1) deixou de ter leitor: o envio incremental guarda o último
  conjunto em `core_meta.uploads_backup_objetos`. A chave antiga é inofensiva
  (não é lida, não é segredo). Se o integrador quiser limpar no passo de
  consolidação:

  ```sql
  DELETE FROM core_meta WHERE key = 'uploads_backup_digital';
  ```

  Motivo: só higiene. Não apagar não muda comportamento nenhum. Na primeira
  execução do diário depois da atualização, as fotos sobem de novo uma vez,
  no formato por objetos (`uploads/objetos/<sha256>` + manifesto versão 2); os
  pacotes antigos continuam no bucket e continuam restauráveis
  (`restaurar-uploads.js`).

## Lote D4 — instância única, coleções aposentadas, empresa em coluna (GAP-PRD-137, GAP-PRD-141, GAP-PRD-147)

Nenhum passo numerado, `CORE_TARGET_VERSION` intacto.

### Tabela nova — já na DDL canônica, nada a consolidar (GAP-PRD-137)

- `core_instancia` — o dono do banco (uma linha, `papel = 'dono'`): tipo
  (`api`, `migracao`, `manutencao`), pid, máquina, início e última batida. Em
  `STATEMENTS` como `DDL_DA_INSTANCIA` (exportada: a trava a cria sozinha
  ANTES das migrações, porque é ela que as protege) e em
  `CORE_TABLES_IN_DELETE_ORDER`. De carona, `core_implantacao_marcas`
  (GAP-PRD-067, lote D3) entrou na ordem de exclusão, onde faltava.

### Coluna nova nas coleções — acrescentada pelo boot, sem reconstrução (GAP-PRD-147)

Toda coleção de `TABLE_NAMES` ganha

```sql
company_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.companyId')) VIRTUAL
```

Na DDL de `ensureSchema` (`db/database.ts`) para tabela nova; em tabela que
já existe, o próprio `ensureSchema` acrescenta com `ALTER TABLE ... ADD
COLUMN` (coluna gerada VIRTUAL: o SQLite não reescreve linha nenhuma; é
anulável; `PRAGMA table_info` nem a lista, só `table_xinfo`). É o molde do
`reconcileCoreSchema` para as coleções.

### Índice sobre a coluna nova — PARA O PASSO DE CONSOLIDAÇÃO (GAP-PRD-147)

Não roda no boot (regra 5). O filtro por empresa já é SQL sem ele; o índice
só tira a varredura. Nas sete coleções que guardam segredo ou credencial
(`COLECOES_POR_EMPRESA`):

```sql
CREATE INDEX IF NOT EXISTS "ix_integration_secrets_company"            ON "integration_secrets" (company_id);
CREATE INDEX IF NOT EXISTS "ix_integration_configurations_company"     ON "integration_configurations" (company_id);
CREATE INDEX IF NOT EXISTS "ix_fiscal_certificate_references_company"  ON "fiscal_certificate_references" (company_id);
CREATE INDEX IF NOT EXISTS "ix_nfce_settings_company"                  ON "nfce_settings" (company_id);
CREATE INDEX IF NOT EXISTS "ix_logistics_carrier_credentials_company"  ON "logistics_carrier_credentials" (company_id);
CREATE INDEX IF NOT EXISTS "ix_payment_terminal_configurations_company" ON "payment_terminal_configurations" (company_id);
CREATE INDEX IF NOT EXISTS "ix_payment_terminal_local_agents_company"  ON "payment_terminal_local_agents" (company_id);
```

Cuidado ao indexar: índice sobre coluna gerada calcula `json_extract` de cada
linha existente. Uma linha com `data` que não é JSON faria o `CREATE INDEX`
falhar — e faria falhar também a leitura por empresa (`findRowsDaEmpresa`,
cujo `WHERE company_id = ?` avalia a coluna em cada linha). Medido no SQLite
3.53 do Node 24: o `ALTER` passa com lixo antigo na tabela, `SELECT seq, data`
(o que boot, backup e `findRows` leem) continua funcionando, e daqui em diante
o banco RECUSA gravar documento que não é JSON. Para achar lixo antigo antes
de indexar: `SELECT seq FROM "<coleção>" WHERE json_valid(data) = 0`. As linhas dessas coleções só nascem por `insertRow`
(`JSON.stringify`), então isso não deve existir — mas o passo deve rodar o
índice numa transação e, se falhar, registrar e seguir sem ele (o filtro
continua correto, só mais lento).

### Correção de dado — as tabelas aposentadas (GAP-PRD-141)

Instalação nova já não cria as 90 coleções tiradas de `TABLE_NAMES` nem as 81
da rodada 36. No banco que já existe elas continuam lá. O passo de
consolidação pode (é opcional — nada depende disso) chamar, DEPOIS do
snapshot que a migração já tira quando há passo pendente:

```ts
import { podarTabelasAposentadas } from './tabelasAposentadas.js';
const r = podarTabelasAposentadas(getConnection(), { aplicar: true });
// r.removidas, r.mantidasComDado, r.desconhecidas — registrar no log
```

O que ela faz, e é o SQL equivalente: para cada nome de
`TABELAS_APOSENTADAS` que exista no banco, com o formato de coleção
(`seq, id, data`) e com `SELECT COUNT(*) = 0`, `DROP TABLE IF EXISTS "<nome>"`
(o índice `ix_<nome>_id` sai junto). Aposentada com linha fica e é relatada;
coleção que a build não conhece fica e é relatada. Usa SAVEPOINT, então roda
dentro ou fora da transação do passo. O mesmo caminho existe para o operador:
`npm run db:podar-legado` (ensaio) e `-- --aplicar` (com a API parada, cópia
antes).

Motivo: peso morto em backup, restauração e na leitura de quem audita o
arquivo; nenhum efeito funcional.

## Lote D5 — fila da central (GAP-PRD-047); o resto do lote ficou aberto

Nenhum passo numerado, `CORE_TARGET_VERSION` intacto.

### Coluna nova — acrescentada pelo boot, nada a consolidar (GAP-PRD-047)

- `core_outbox.last_error_kind TEXT` — a natureza da última falha de envio
  (`'TRANSPORTE'` ou `'RECUSA'`). Na DDL canônica (`schema.ts`), anulável e
  sem DEFAULT: o `reconcileCoreSchema` a acrescenta em banco existente com
  `ALTER TABLE ... ADD COLUMN`. Linha antiga fica com NULL e é lida como "não
  se sabe" — o comportamento de uma linha NULL é o de antes (a próxima falha
  grava a natureza). Nenhum índice.

Nenhum dado antigo precisa de correção: eventos que já estão `dead` por
queda da central continuam `dead` até alguém clicar em "Tentar novamente" (é a
ação que já existia); a partir desta versão, queda da central não leva mais
ninguém para lá.

## Verificação da frente — índice duplicado, projeção e fuso (GAP-PRD-144, GAP-PRD-048, GAP-PRD-145)

Nenhum passo numerado, `CORE_TARGET_VERSION` intacto.

### Índice duplicado — PARA O PASSO DE CONSOLIDAÇÃO (GAP-PRD-144)

`ix_stock_mov_product` saiu da DDL canônica (`schema.ts`): banco novo já não
o cria. No banco existente ele continua lá, idêntico a
`ix_stock_movements_product` — os dois em `core_stock_movements (company_id,
product_id, created_at)`. O boot não derruba índice (regra 5); o passo de
consolidação roda:

```sql
DROP INDEX IF EXISTS ix_stock_mov_product;
```

Motivo: cada movimento de estoque pagava duas escritas de índice, sem ganho
de leitura. Seguro em qualquer ordem: `ix_stock_movements_product` (mesmas
colunas, mesma ordem) continua e é garantido por `CREATE INDEX IF NOT EXISTS`
em todo boot; nenhuma consulta cita o nome do índice. Prova de que o banco
novo nasce sem duplicata: `server/tests/um-indice-por-pergunta.test.ts`.

### Projeção e fuso — nada a consolidar (GAP-PRD-048, GAP-PRD-145)

- O diagnóstico da projeção ganha duas chaves em `core_meta`
  (`central_projection_last_error_at`, `central_projection_last_ok_at`) ao
  lado da antiga `central_projection_last_error`. Sem DDL. O erro antigo sem
  hora (o PGRST202 de 30/08 no banco da loja) é lido como "data
  desconhecida" e sai sozinho na primeira projeção aceita (envio normal ou
  `reprojetar-central --confirmar`). Nenhum dado a corrigir.
- A conferência do fuso só consulta o `Intl` do Node; nada no banco.

### GAP-PRD-140 e GAP-PRD-142 — fechados na integração (grupo ESQ)

A deriva de esquema (os dois índices ausentes, o índice de mesmo nome com
definição diferente, o DEFAULT e a UNIQUE antigos) e a competência legada no
dia UTC foram implementadas e provadas na fase de integração. O SQL, a chamada
no passo 85 e a prova no clone do banco real estão em `migracoes/INT.md`; o
journal, em `journal/INT.jsonl`.
