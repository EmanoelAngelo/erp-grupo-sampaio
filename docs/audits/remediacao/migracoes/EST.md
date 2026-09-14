# Frente EST — o que o banco precisa na consolidação

## Lote T1 (GAP-PRD-015, 085, 204)

**Nenhum passo de consolidação é necessário.**

- `core_supplier_item_codes` (o de-para "código do fornecedor → produto", GAP-PRD-015) é tabela NOVA, declarada na DDL canônica de `server/src/db/schema.ts` com `CREATE TABLE IF NOT EXISTS`. O boot a cria em banco existente. O índice `ix_supplier_item_codes_product` é de tabela nova e mora na mesma DDL (REGRAS §5).
- A tabela entrou em `CORE_TABLES_IN_DELETE_ORDER` antes de `core_products` e de `core_suppliers`, para que o reset dos testes não estoure chave estrangeira.
- Nenhuma coluna nova em tabela existente, nenhum índice sobre coluna nova de tabela existente, nenhuma reconstrução, nenhuma correção de dado.
- O de-para começa vazio: nada é inferido do histórico. Ele aprende na primeira conferência de cada fornecedor (vínculo manual) e com os produtos que a confirmação cadastrar dali em diante.

### Dado já existente no banco real (não aplicado — só o caminho)

Produtos duplicados que notas anteriores cadastraram com preço zero (o sintoma do GAP-PRD-015) **não** são mesclados automaticamente. O caminho de correção pela tela já existe: ajuste de estoque (movimentação manual) para levar o saldo ao cadastro verdadeiro e inativação do duplicado; a partir deste lote, a próxima nota do mesmo fornecedor pode ser vinculada ao produto verdadeiro e o vínculo é lembrado.

## Lote T2 (GAP-PRD-070, 164)

**Nenhum passo de consolidação é necessário.** A paginação das listas não mexeu em `server/src/db/schema.ts`: nenhuma tabela, coluna ou índice novo. As contagens (`total`) e as páginas (`LIMIT/OFFSET`) rodam sobre os índices que já existem por `company_id`; nenhum dado é reescrito.

## Lote T3 (GAP-PRD-087, 088, 089, 090, 165, 166, 167, 168)

**Nenhum passo de consolidação é necessário.** Tudo o que o lote pôs no banco é tabela nova ou coluna nova anulável, pelos dois caminhos que o boot já aplica sozinho (REGRAS §5).

### Tabelas novas (DDL canônica, `CREATE TABLE IF NOT EXISTS`)

- `core_management_policies` (GAP-PRD-165/166, a política de gestão: quem vê dinheiro e a régua do valor do estoque). Uma linha por empresa, chave `company_id`; sem linha = os padrões seguros (só a gerência vê dinheiro; régua `ultimo_custo`, a de sempre). Entrou em `CORE_TABLES_IN_DELETE_ORDER` junto de `core_sale_policies` (só aponta para `core_companies`). **Nenhuma linha é criada por migração**: a política só existe quando o dono a salva em Configurações › Política de gestão.
- `core_supplier_returns` e `core_supplier_return_items` (GAP-PRD-089, devolução ao fornecedor). Os índices `ix_supplier_returns_note` e `ix_supplier_return_items_return` são de tabela nova e moram na mesma DDL. As duas entraram em `CORE_TABLES_IN_DELETE_ORDER` ANTES de `core_finance_entries` (o documento aponta o título que abateu ou o crédito que criou), de `core_inbound_notes`, `core_products` e `core_suppliers`.

### Colunas novas em tabela existente

- `core_inventory_counts.location_id TEXT` (GAP-PRD-167, a contagem por local), **anulável**, declarada na DDL canônica com `REFERENCES core_stock_locations(id)`. Em banco existente o `reconcileCoreSchema` a acrescenta como `location_id TEXT` (sem a FK, que SQLite não acrescenta por ALTER — o serviço valida o local contra `core_stock_locations` da empresa antes de gravar). Nulo = a empresa inteira, que é como toda contagem anterior é lida. **Sem índice**: a coluna só é lida junto da contagem (por id) e da lista (por empresa, já indexada por `UNIQUE (company_id, number)`); se um dia houver filtro por local, o índice `CREATE INDEX IF NOT EXISTS ix_inventory_counts_location ON core_inventory_counts (company_id, location_id);` entra no passo de consolidação do integrador, não no boot.

- `core_inbound_notes.finance_waiver_reason TEXT`, `finance_waiver_by TEXT`, `finance_waiver_at TEXT` (GAP-PRD-088), **anuláveis**, na DDL canônica. O `reconcileCoreSchema` as acrescenta em banco existente. Nulas = ninguém decidiu; só o gesto "esta nota não gera conta" as preenche (os outros dois deixam o título como prova). **Sem índice**: a lista das pendências filtra por `company_id` + `status` e pela ausência de título, e roda sobre dezenas de notas.

### Dados que o código NÃO reescreve

- **GAP-PRD-088 — a NF 9991 da Preço Justo** (`core_inbound_notes 0d642d4a-…`, R$ 1.485,60, recebida em 12/08 sem título): **nenhum** título é criado por migração. O caminho é a tela: Compras › Entrada de notas › "Notas recebidas sem conta a pagar" › Decidir (gerência): lançar a conta (vencimento sugerido = recebimento + prazo do fornecedor), lançar já paga (com a data e a forma) ou declarar que não gera conta (com justificativa). Até alguém decidir, ela continua na lista.

- **GAP-PRD-087 — a reserva órfã da Conceito** (1 unidade do produto `243070f1-…`, reservada por `ecommerce_order 57bee3bf-…`, pedido inexistente): **não** é solta por migração. O caminho é a tela: Estoque › Posição de estoque › "Reservas que precisam de conferência" › "Liberar reserva sem origem" (gerência, com motivo). O gesto grava `ORPHAN_RESERVATION_RELEASE` no razão e `stock.reservation.orphan_released` na trilha. Nenhum movimento antigo é alterado.
- A origem financeira nova `devolucao_fornecedor` só aparece em títulos criados daqui em diante; nada antigo muda de origem.
