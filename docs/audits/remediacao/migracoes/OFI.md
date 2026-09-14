# Migrações da frente OFI (Oficina, equipamentos/QR, Kanban, PJ Motors)

Nenhum passo numerado foi criado e `CORE_TARGET_VERSION` não mudou (REGRAS, seção 5).
Este arquivo lista o que o integrador precisa saber para o passo único de consolidação.

## Lote O1 — caixa da oficina (GAP-PRD-042, 104, 209, 105)

### Coluna nova em tabela existente — nenhum passo necessário

| Tabela | Coluna | Tipo | Padrão | Leitor |
| --- | --- | --- | --- | --- |
| `core_sale_policies` | `workshop_credit_enabled` | `INTEGER` anulável | nulo = desligado | `SalePolicyService.politicaDaEmpresa` → `WorkshopCashierService.receberOs` (recusa o fiado da OS enquanto não for 1) |

A coluna está na DDL canônica (`server/src/db/schema.ts`), é anulável e sem índice:
`reconcileCoreSchema` a acrescenta sozinha em banco existente com
`ALTER TABLE core_sale_policies ADD COLUMN workshop_credit_enabled INTEGER;`.
Nulo preserva o comportamento seguro (a OS só fecha com o total coberto).

### Índices, reconstruções e correção de dado — nenhum

- Nenhum índice novo. A fila do caixa (`filaDeRecebimento`) filtra por
  `company_id` e `status` em `core_service_orders`, que já tem a busca do quadro.
- Nenhuma constraint trocada, nenhuma tabela reconstruída.
- Nenhum dado corrigido no boot.

### Dado legado que o código agora sabe consertar (sem SQL)

Antes desta correção, cancelar a venda de uma OS paga deixava a OS `finalizada`
apontando para a venda cancelada. O código NÃO corrige isso sozinho no boot; o
caminho é a tela: ficha da OS › "Estornar recebimento" (rota
`POST /core/workshop/orders/:id/estorno`), que reconhece a venda já cancelada,
reabre a OS em `aguardando_pagamento` sem tocar na venda e registra evento e
auditoria (`workshop.order.reversal`, `reparo: true`).

Consulta somente-leitura para o integrador conferir se o banco real tem casos
assim antes da virada (não foi executada contra o banco operacional nesta frente):

```sql
SELECT o.company_id, o.number, o.sale_id, s.status AS venda
  FROM core_service_orders o
  JOIN core_sales s ON s.id = o.sale_id
 WHERE o.status = 'finalizada' AND s.status = 'cancelled';
```

### Chave de idempotência do recebimento (formato novo, leitura do antigo)

Vendas de OS gravadas daqui em diante usam `idempotency_key` com o namespace da
OS: `os:<orderId>:<Idempotency-Key>`, ou `os-<orderId>` (e `os-<orderId>:<n>`
depois do n-ésimo estorno) quando o cliente não manda cabeçalho. As vendas
antigas (chave crua ou `os-<orderId>`) continuam reconhecidas no reenvio: o
serviço compara a chave crua com a venda da OS finalizada. Nenhuma migração de
dado é necessária.

## Lote O2 — quem abre e mexe na OS, devolução de peça, portal, eventos de status, custo da peça (GAP-PRD-099, 102, 186, 103, 182, 100, 101)

### Tabelas, colunas e índices — nenhum

Nenhuma tabela nova, nenhuma coluna nova, nenhum índice, nenhuma constraint
trocada. Em particular:

- `core_service_order_comments.author_kind` ganhou o valor `balcao`
  (GAP-PRD-102). A coluna é `TEXT NOT NULL DEFAULT 'tecnico'` **sem CHECK**, então
  o valor novo não exige reconstrução. Leitores: `OrdemServicoPage` (título
  "Anotação do balcão"); os demais leitores tratam qualquer valor diferente de
  `proprietario` como fala da equipe, como antes.
- O custo da peça consumida pela OS (GAP-PRD-101) mora no RAZÃO, e não numa
  coluna nova: `core_stock_movements.unit_cost_cents` (coluna que já existia) passa
  a ser preenchida na saída `WORKSHOP_PART_CONSUMPTION` e na volta
  `WORKSHOP_PART_RETURN`; a venda da OS lê daí (`custoDaPecaConsumida`).
- A venda da OS passa a ser itemizada em `core_sale_items` (peça com
  `cost_cents`, mão de obra com `cost_cents` nulo, todas com `product_id` nulo) —
  colunas existentes.

### Dado legado que o código agora neutraliza (SQL opcional, NÃO aplicado no boot)

1. **Pedido de aprovação pendurado em OS fora da bancada** (GAP-PRD-182). Antes,
   concluir a OS com o pedido pendente deixava `approval_requested_at` preenchido
   numa OS `aguardando_pagamento`/`finalizada`. O código novo já não oferece nem
   aceita decisão nessa OS (portal: `aguardandoDecisao=false` e
   `PORTAL_ORDER_NOT_ON_BENCH` 409; ficha: sem o selo "aguardando o cliente"), então
   a limpeza é cosmética. Se o integrador quiser o dado limpo:

   ```sql
   -- conferir antes (somente leitura):
   SELECT company_id, number, status, approval_requested_at
     FROM core_service_orders
    WHERE approval_requested_at IS NOT NULL AND approved_at IS NULL
      AND status IN ('aguardando_pagamento', 'finalizada');
   -- corrigir (passo de consolidação, não boot):
   UPDATE core_service_orders
      SET approval_requested_at = NULL
    WHERE approval_requested_at IS NOT NULL AND approved_at IS NULL
      AND status IN ('aguardando_pagamento', 'finalizada');
   ```

2. **CMV das vendas de OS antigas** (GAP-PRD-101). Venda de OS anterior a esta
   correção tem UMA linha com `cost_cents` nulo; saída de peça antiga tem
   `unit_cost_cents` nulo. **Não há backfill, de propósito**: reconstruir o custo
   de então com o custo do cadastro de hoje é inventar número (doutrina do
   GAP-V28 em `IncomeStatementService`). O DRE conta essas linhas como "sem
   retrato" e diz isso na ressalva. Nenhum SQL.

3. **Consolidado da central com OS paradas em "em aberto"** (GAP-PRD-100). As OS
   que mudaram de situação antes desta correção só tinham o evento de abertura.
   Daqui para a frente toda mudança emite `service_order.status_changed`. Para
   alinhar o passado, o caminho já existe e não é SQL: a carga inicial da central
   (`BootstrapService`, fonte `core_service_orders`) espelha a situação e os
   totais atuais de cada OS com id derivado (idempotente).

### Comportamento que muda sem migração

- `POST /core/workshop/orders` e `POST /core/equipment` resolvem a bancada pela
  régua de quem ABRE (`WorkshopIntakeService`): caixa e atendente da oficina têm a
  empresa inteira; mecânico continua preso à filiação. Nenhum vínculo precisa ser
  criado para o usuário "PDV Oficina" do banco real — e o contorno de vinculá-lo
  como membro da bancada NÃO deve ser feito (ele passaria a contar como bancada).
- Rota nova, somente leitura: `GET /core/workshop/entrada` (bancadas de entrada).

## Lote O3 — quadro com versão e paginação, OS legada, plaquinha pela tela, identidade da máquina (GAP-PRD-183, 187, 188, 107, 185, 190, 106)

### Tabela nova — nenhum passo necessário

`core_equipment_photos` (GAP-PRD-106) está na DDL canônica (`server/src/db/schema.ts`)
com `CREATE TABLE IF NOT EXISTS` e o índice `ix_equipment_photos (equipment_id, created_at)`
na mesma DDL; o boot a cria em banco existente. Entrou em `CORE_TABLES_IN_DELETE_ORDER`
antes de `core_equipment`. Os arquivos vão para `<DEVORA_UPLOADS_DIR ou server/data/uploads>/equipamentos`,
servidos em `/uploads/equipamentos` (mesmas regras de `/uploads/os`).

### Colunas novas em tabela existente — nenhum passo necessário

| Tabela | Coluna | Tipo | Padrão | Leitor |
| --- | --- | --- | --- | --- |
| `core_equipment` | `plate` | `TEXT` anulável | nulo = não informada | ficha do equipamento; `EquipmentIdentityService` (unicidade por empresa) |
| `core_equipment` | `odometer_km` | `INTEGER` anulável | nulo = não informada | ficha do equipamento |
| `core_equipment` | `odometer_at` | `TEXT` anulável | nulo | ficha do equipamento (data da leitura do km) |

`reconcileCoreSchema` as acrescenta com `ALTER TABLE core_equipment ADD COLUMN ...`.

### Índice sobre coluna nova — para o passo de consolidação (NÃO aplicado no boot)

A placa é única por empresa, e o código já confere isso no cadastro e na correção
(`CORE_EQUIPMENT_DUPLICATE_IDENTITY`, dizendo qual plaquinha já a usa). O índice é a
rede do banco, como `ux_equipment_chassis` é para o chassi:

```sql
-- conferir antes (somente leitura): não pode haver placa repetida na mesma empresa
SELECT company_id, plate, COUNT(*) FROM core_equipment
 WHERE plate IS NOT NULL GROUP BY company_id, plate HAVING COUNT(*) > 1;
-- criar (passo de consolidação):
CREATE UNIQUE INDEX IF NOT EXISTS ux_equipment_plate
  ON core_equipment (company_id, plate) WHERE plate IS NOT NULL;
```

Como a coluna nasce vazia, a conferência volta vazia em todo banco existente.

### Valores novos em colunas TEXT sem CHECK — nenhuma reconstrução

- `core_service_orders.no_cost_reason` ganha `lancamento_indevido`, gravado SÓ pela
  regularização da gestão (GAP-PRD-188); a conclusão técnica continua aceitando só
  garantia/cortesia/retrabalho. O A4 da OS o traduz.
- `core_equipment_events.event_type` ganha `identidade_corrigida`, `km_registrado` e
  `label_printed` (este último já tinha rótulo na ficha e nenhum escritor).
- `core_equipment.category`: o vocabulário novo (`moto`, `scooter`, `bicicleta_eletrica`,
  `patinete`, `celular`, `outro`) vale para o que ENTRA; linhas antigas com texto livre
  continuam legíveis e a correção de identidade as traz ao vocabulário. Sem SQL.

### Dado legado que o código agora sabe consertar (sem SQL, pela tela)

1. **OS fora das regras** (GAP-PRD-188): OS sem bancada ou numa coluna de trabalho sem
   responsável aparece no quadro com "Fora das regras" e na ficha com o cartão
   "Regularizar" (gerente da oficina, `POST /core/workshop/orders/:id/regularizar`):
   devolver ao quadro (ganha a bancada, volta para "em aberto") ou encerrar como
   lançamento indevido (só sem peça, mão de obra ou venda). Motivo, evento,
   comentário e auditoria `workshop.order.regularize`. A porta que criou o evento
   finalizada → em andamento (assumir OS paga/finalizada) foi fechada.

   ```sql
   -- somente leitura, para o integrador conferir antes da virada:
   SELECT number, status, workshop_id, mechanic_id FROM core_service_orders
    WHERE workshop_id IS NULL
       OR (status IN ('em_andamento','manutencao_externa','parada_setor','aguardando_peca')
           AND mechanic_id IS NULL);
   ```

2. **Operação sem a marca de plaquinha** (GAP-PRD-185): Configurações › Empresas do
   grupo › "Plaquinha com QR" › Ligar (`PATCH /core/companies/:id/equipment-tags`).
   O passo de migração que marca `oficina` e `pj-motors` continua como está.

### Comportamento que muda sem migração

- `POST /core/workshop/orders/:id/assume` recusa OS na fila do caixa ou finalizada
  (`CORE_ORDER_PAST_BOARD`) e a OS que já é do técnico (`CORE_ORDER_ALREADY_YOURS`).
- `assume`, `move` e `release` aceitam `expectedStatus`/`expectedStatusChangedAt`
  (opcionais); o quadro e a ficha passam a mandá-los (`CORE_ORDER_STALE` 409).
- `GET /core/workshop/orders?ordem=quadro` ordena por prioridade e a mais antiga primeiro.
- `POST /core/companies`: sem `usesEquipmentTags`, a marca segue a bancada (oficina de
  mobilidade nasce usando plaquinha; celular e loja, não).
- Rotas novas: `POST /workshop/orders/:id/regularizar`, `PATCH /companies/:id/equipment-tags`,
  `POST /units/:id/equipment/sheet`, `PATCH /equipment/:id/identidade`,
  `GET|POST /equipment/:id/photos`, `DELETE /equipment/:id/photos/:photoId`.

## Lote O4 — PJ Motors: pré-venda de moto, vínculo de plaquinha, fronteira com a Oficina, reserva por unidade (GAP-PRD-025, 108, 109, 110, 111, 189, 112)

### Tabela nova — nenhum passo necessário

`core_product_unit_holds` (GAP-PRD-111) está na DDL canônica (`server/src/db/schema.ts`)
com `CREATE TABLE IF NOT EXISTS`, o índice único `ux_product_unit_holds_unit (unit_id)` e
o índice `ix_product_unit_holds_reference (company_id, reference_type, reference_id)` na
mesma DDL; o boot a cria em banco existente. Entrou em `CORE_TABLES_IN_DELETE_ORDER` antes
de `core_product_units`.

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `unit_id` | `TEXT NOT NULL`, FK `core_product_units`, único | a moto segurada — uma moto, um documento |
| `reference_type` / `reference_id` | `TEXT NOT NULL` | `'pre_venda'` + id do documento em `core_quotes` |
| `product_id`, `company_id`, `created_by`, `created_at` | | |

A reserva só vale enquanto o documento está `aberto` e dentro da validade: todo leitor
junta com `core_quotes` (`sqlReservadaPorOutro` em `ProductUnitService.ts`), então pré-venda
vencida ou cancelada solta a moto sem varredura. Converter, cancelar e vencer apagam as
linhas do documento (arrumação); a edição que baixa a quantidade apara o excedente.

### Dado existente — nada a migrar

Banco nenhum tem linhas nesta tabela antes desta versão, e pré-venda antiga continua como
era: reserva por quantidade (`core_stock.reserved`), com a conversão escolhendo a moto por
FIFO à vista entre as livres (GAP-PRD-025).

### Colunas, índices e constraints — nenhum

Nenhuma coluna nova em tabela existente, nenhum índice sobre coluna existente, nenhuma
reconstrução. Valores novos em colunas `TEXT` sem CHECK:

- `core_equipment_events.event_type` ganha uso de `sale_reverted` pela "venda à mão" desfeita
  (GAP-PRD-189) — o valor já existia para a devolução de venda; a ficha o traduz ("Venda
  desfeita").
- `core_service_orders.customer_name` recebe `Montagem interna` quando a OS da moto do estoque
  abre sem nome (GAP-PRD-109).

### Dado legado que o código agora sabe consertar (sem SQL, pela tela)

1. **Plaquinha interna "vendida à mão" sem venda** (GAP-PRD-189, e o equipamento órfão do
   GAP-PRD-112). Ficha do equipamento › cartão "Venda registrada à mão" › Desfazer registro de
   venda (gerente da oficina, `POST /core/equipment/:id/owner/desfazer`, motivo obrigatório):
   volta a `NOT_SOLD`, sem dono, com evento `sale_reverted` (motivo e dono anterior) e auditoria
   `equipment.sale.manual_undo`. Só vale para `INTERNAL_PJ_MOTORS` com `sale_id` nulo e sem
   unidade vinculada. Se a moto de fato saiu antes do sistema, o registro está certo e fica.

   ```sql
   -- somente leitura, para o dono decidir caso a caso antes da virada:
   SELECT e.public_id, e.chassis, e.sold_at, c.name AS dono
     FROM core_equipment e
     LEFT JOIN core_customers c ON c.id = e.owner_customer_id
    WHERE e.origin = 'INTERNAL_PJ_MOTORS' AND e.sale_status = 'SOLD' AND e.sale_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM core_product_units u WHERE u.equipment_id = e.id);
   ```

2. **Moto vendida sem plaquinha** (GAP-PRD-108). Estoque › Unidades › "Vincular plaquinha (já
   vendida)": a plaquinha com o mesmo chassi/motor/série recebe o comprador (espelhado pelo
   CPF), `sold_at` da venda e `sale_id`. Sem SQL.

3. **Plaquinha gerada na PJ Motors antes da regra** (GAP-PRD-110). A PJ não gera, não imprime
   nem libera mais (`CORE_TAGS_NEED_WORKSHOP`); o que já foi gerado se marca como danificada na
   tela de Plaquinhas (a rota de dano continua aberta a ela). Sem SQL.

### Comportamento que muda sem migração

- `POST /core/quotes/:id/convert` aceita `unidades: [{ productId, unitIds }]`; sem elas, a moto
  segurada pelo documento ou a mais antiga livre (antes: 400 `CORE_UNITS_REQUIRED`).
- `pickUnitsFifo` deixa de escolher moto segurada por pré-venda viva de outro documento
  (pedido online, peça de OS); a transferência entre locais a inclui por último.
- A venda de balcão de moto segurada por outra pré-venda é recusada (`CORE_UNIT_HELD`).
- `POST /core/units/:id/equipment` aceita unidade VENDIDA (vínculo tardio) e recusa a plaquinha
  com o número de uma moto vendida sem plaquinha (`CORE_EQUIPMENT_BELONGS_TO_SOLD_UNIT`).
- `POST /core/workshop/orders` recusa cliente do cadastro na moto interna não vendida
  (`CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER`).
- `POST /core/equipment/:id/owner` recusa a moto cujo chassi/motor/série está `in_stock` numa
  loja do grupo (`CORE_EQUIPMENT_SALE_BY_PDV`) e `saleId` que não existe (`CORE_SALE_NOT_FOUND`).
- Gerar lote, imprimir folha e liberar plaquinha exigem bancada ativa na empresa
  (`CORE_TAGS_NEED_WORKSHOP`); `GET /core/equipment-tags` devolve `temBancada`.
- Rotas novas: `PUT /core/quotes/:id/unidades`, `POST /core/equipment/:id/owner/desfazer`.
  `GET /core/units/summary` ganhou `vendidasSemPlaquinha`, `produtosSerializados` e
  `semIdentidade`; `GET /core/units/:productId` ganhou `reserva` por unidade;
  `GET /core/equipment/:id` ganhou `vendaAMao`.
