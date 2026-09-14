# Migrações da frente LOG (Logística)

Nenhum passo numerado foi criado e `CORE_TARGET_VERSION` não mudou (REGRAS §5).
Este arquivo registra, para o integrador, o que o boot já resolve sozinho e o
que ficou de fora de propósito.

## Para o passo de consolidação: nada

Conferido pelo verificador da frente contra `8caa1f3`: o diff não tem nenhuma
linha com `core_migration_step` nem com `CORE_TARGET_VERSION` (continua 84), e
tudo o que a frente acrescentou ao banco é tabela nova com `CREATE TABLE IF NOT
EXISTS` (índices na mesma DDL) ou coluna anulável em tabela existente, que o
boot resolve sozinho. Não há índice sobre coluna nova de tabela existente,
reconstrução de tabela, troca de constraint nem correção de dado a fazer.

## Lote L1 — GAP-PRD-030, GAP-PRD-126, GAP-PRD-127, GAP-PRD-117

Nenhuma DDL. A credencial da transportadora continua na coleção de documentos
`logistics_carrier_credentials` (`db/database.ts`, sem esquema). O formato
ganhou `environment` (`homologation` / `production`), `contactEmail` e os campos
do último teste; linha antiga sem `environment` é lida como `homologation`
(sandbox), e a gravação apaga a cópia redundante `apiKeyEncrypted` e as
duplicatas do mesmo escopo. No banco da loja a coleção tem 0 linhas (leitura
somente leitura do lote L2), então não há dado a converter.

## Lote L2 — GAP-PRD-119, GAP-PRD-120, GAP-PRD-118, GAP-PRD-034

### Tabelas novas (DDL canônica em `server/src/db/schema.ts`)

O `ensureCoreSchema` cria em banco existente; os índices são de tabela nova e
moram na mesma DDL.

| Tabela | Para quê |
| --- | --- |
| `core_shipments` | O envio de UM pedido: canal (`melhor_envio` / `manual`), transportadora, referência no provedor, serviço, ambiente, estado, código de rastreio, preço, NF-e ou declaração, última falha de compra, última consulta de rastreio (quando, se deu certo, a frase), despacho (data e operador), entrega (data e origem), cancelamento, chave de idempotência. Índices `ix_shipments_order`, `ix_shipments_sync` e o parcial `ux_shipments_order_alive` (um envio vivo por pedido; cancelado sai da conta). |
| `core_shipment_events` | Os marcos do envio com a ORIGEM (`provedor` / `operador` / `sistema`) e `dedupe_key` única por envio — a mesma postagem lida em duas consultas é uma linha só. Índice `ix_shipment_events_order`. |
| `core_logistics_settings` | Por empresa: `allow_content_declaration` (padrão 0 — sem NF-e, sem etiqueta; decisão do contador) e `jadlog_agency_id`. |

As três entraram em `CORE_TABLES_IN_DELETE_ORDER` (filhos antes de
`core_orders`).

### Colunas novas em tabelas existentes (anuláveis — `reconcileCoreSchema` acrescenta)

| Coluna | Por quê |
| --- | --- |
| `core_orders.shipping_carrier TEXT` | Quem leva a encomenda (correios, jadlog, melhor_envio, generic, propria). Sem ela o código de rastreio é texto solto e o portal não tem para onde linkar. |
| `core_order_events.origin TEXT` | De onde veio a mudança (`operador`, `provedor`, `cliente`, `sistema`). "Entregue" pela transportadora e "entregue" clicado na loja não valem o mesmo. |

**Nenhum índice** sobre essas colunas (não há consulta por elas), então nada a
acrescentar no passo de consolidação.

### Dado existente — nada a corrigir

Leitura SOMENTE LEITURA do banco da loja em 11/09/2026 (`new DatabaseSync(...,
{ readOnly: true })`, só contagens):

- coleção `logistics_shipments` (a que o `POST /logistics/shipments` cru
  gravava): **0 linhas**. A coleção ficou sem escritor e sem leitor; não há o
  que migrar para `core_shipments`;
- `logistics_carrier_credentials`: 0 linhas;
- pedidos antigos com `tracking_code` e sem `shipping_carrier`: continuam
  lidos — o portal mostra o código sem link, porque não se inventa a
  transportadora de um despacho que não a registrou. `core_order_events`
  antigos ficam com `origin` nulo ("origem não registrada"), pelo mesmo motivo.

Nenhum `UPDATE` de dado é proposto.
