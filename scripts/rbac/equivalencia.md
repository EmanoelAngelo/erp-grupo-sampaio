# Equivalência dia 1: modelo × rota

Base: C:/Users/User/Desktop/devora-ent-rbac (branch ent/rbac, HEAD fb4c1118). Calculado por `_consolidar.mjs` sobre as 11 fatias (`sites-*.json`), o catálogo final (141 capabilities) e os modelos derivados (`modelos.json`). Nada foi executado no repositório; o veredito é estático (expressão × modelo), o mesmo cálculo que o T1 do desenho vai congelar.

Legenda das colunas de perfil: A admin_geral, G gestor, L gerente_loja, O gerente_oficina, E estoquista, T atendente, C operador_caixa (legado), CL operador_caixa_loja, CO operador_caixa_oficina, M mecanico, K contador.

Legenda das células: `x` passa hoje e passa no dia 1; `.` não passa nos dois; `+` passa a passar; `-` deixa de passar.

## 1. Resumo por modelo

Rotas guardadas únicas: **606** (4 só autenticadas, 602 com capability). Rotas públicas: 86. Total de rotas únicas: 692.

| modelo | capabilities | rotas hoje | rotas dia 1 | iguais | ganha | perde | pontos de serviço que mudam (como ator) | regras sobre o ALVO que mudam (D11) | pontos de tela que aparecem | pontos de tela que somem |
|---|---|---|---|---|---|---|---|---|---|---|
| `admin_geral` | 141 | 606 | 606 | 606 | 0 | 0 | 1 | 0 | 0 | 0 |
| `gestor` | 141 | 606 | 606 | 606 | 0 | 0 | 1 | 0 | 0 | 0 |
| `gerente_loja` | 107 | 544 | 544 | 606 | 0 | 0 | 1 | 0 | 0 | 0 |
| `gerente_oficina` | 104 | 478 | 478 | 606 | 0 | 0 | 1 | 6 | 1 | 2 |
| `estoquista` | 31 | 233 | 233 | 606 | 0 | 0 | 1 | 0 | 0 | 9 |
| `atendente` | 35 | 175 | 175 | 606 | 0 | 0 | 1 | 0 | 0 | 25 |
| `operador_caixa` | 14 | 115 | 117 | 604 | 2 | 0 | 0 | 0 | 13 | 0 |
| `operador_caixa_loja` | 22 | 147 | 147 | 606 | 0 | 0 | 0 | 0 | 21 | 0 |
| `operador_caixa_oficina` | 21 | 146 | 146 | 606 | 0 | 0 | 0 | 6 | 15 | 0 |
| `mecanico` | 18 | 59 | 59 | 606 | 0 | 0 | 1 | 0 | 0 | 0 |
| `contador` | 1 | 8 | 8 | 606 | 0 | 0 | 1 | 0 | 0 | 0 |

"Pontos de serviço que mudam (como ator)" é só a D10 (login por token de dispositivo) para quem não é caixa. "Regras sobre o ALVO" é a D11: o modelo deixa de ser OBRIGADO a ter bancada específica ao ser cadastrado; o acesso de quem opera não muda.

Onde há `ganha`/`perde` nas rotas:

- `operador_caixa`: ganha POST /core/print/jobs, POST /core/print/jobs/:id/reprint; perde —.

Veredito de todos os 1255 pontos (rotas, serviços e tela): igual 1182 · muda 58 · n/a 10 · igual pelo passo 86 1 · igual (regra) 4. Mudanças não listadas: **0**.

## 2. Tabela modelo × rota (servidor)

Uma linha por rota guardada única (método + caminho). A coluna "D" traz a mudança deliberada quando há.

<details><summary>Abrir a tabela completa (606 rotas)</summary>

| # | rota | guarda nova | A | G | L | O | E | T | C | CL | CO | M | K | veredito |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `GET /core/products` (core.ts:1084) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 2 | `POST /core/products/fotos-em-lote/resolver` (core.ts:1121) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 3 | `GET /core/products/prontidao-online` (core.ts:1132) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 4 | `POST /core/products/publicar-prontos` (core.ts:1143) | `ecommerce.publish` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 5 | `GET /core/products/search` (core.ts:1175) | `qualquer(products.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 6 | `GET /core/products/:id` (core.ts:1208) | `qualquer(products.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 7 | `POST /core/pricing/cart` (core.ts:1268) | `qualquer(pdv.sell, sales.view, workshop.parts.use)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 8 | `GET /core/mail/inbox` (core.ts:1296) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 9 | `POST /core/mail/inbox` (core.ts:1306) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 10 | `POST /core/mail/inbox/test` (core.ts:1339) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 11 | `DELETE /core/mail/inbox` (core.ts:1359) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 12 | `GET /core/mail/schedule` (core.ts:1378) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 13 | `POST /core/mail/schedule` (core.ts:1387) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 14 | `GET /core/mail/messages` (core.ts:1406) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 15 | `POST /core/mail/check` (core.ts:1422) | `purchases.receive` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 16 | `GET /core/print/readiness` (core.ts:1452) | `settings.printers.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 17 | `GET /core/print/printers` (core.ts:1465) | `settings.printers.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 18 | `POST /core/print/printers` (core.ts:1474) | `settings.printers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 19 | `GET /core/print/jobs` (core.ts:1505) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 20 | `POST /core/print/jobs` (core.ts:1525) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | + | x | x | . | . | muda (D1) |
| 21 | `GET /core/print/jobs/:id` (core.ts:1583) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 22 | `POST /core/print/jobs/:id/reprint` (core.ts:1596) | `pdv.sell` | x | x | x | x | . | x | + | x | x | . | . | muda (D1) |
| 23 | `POST /core/print/jobs/:id/status` (core.ts:1627) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 24 | `GET /core/print/drawer` (core.ts:1655) | `qualquer(pdv.cash.operate, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 25 | `POST /core/print/drawer/open` (core.ts:1677) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 26 | `POST /core/print/printers/:id/test` (core.ts:1726) | `settings.printers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 27 | `GET /core/print/jobs/:id/escpos` (core.ts:1776) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 28 | `GET /core/print/jobs/:id/document` (core.ts:1807) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 29 | `GET /core/taxonomy` (core.ts:1825) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 30 | `POST /core/taxonomy/categories` (core.ts:1840) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 31 | `POST /core/taxonomy/categories/merge` (core.ts:1860) | `products.catalog.admin` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 32 | `DELETE /core/taxonomy/categories/:id` (core.ts:1883) | `products.catalog.admin` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 33 | `POST /core/taxonomy/brands` (core.ts:1901) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 34 | `POST /core/taxonomy/brands/merge` (core.ts:1920) | `products.catalog.admin` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 35 | `DELETE /core/taxonomy/brands/:id` (core.ts:1943) | `products.catalog.admin` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 36 | `GET /core/catalog/aux` (core.ts:1971) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 37 | `POST /core/catalog/units` (core.ts:1988) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 38 | `DELETE /core/catalog/units/:id` (core.ts:2007) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 39 | `GET /core/catalog/tax-groups` (core.ts:2040) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 40 | `POST /core/catalog/tax-groups` (core.ts:2050) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 41 | `DELETE /core/catalog/tax-groups/:id` (core.ts:2076) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 42 | `POST /core/catalog/tax-rates` (core.ts:2094) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 43 | `DELETE /core/catalog/tax-rates/:id` (core.ts:2104) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 44 | `GET /core/catalog/custom-fields` (core.ts:2123) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 45 | `POST /core/catalog/custom-fields` (core.ts:2133) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 46 | `DELETE /core/catalog/custom-fields/:id` (core.ts:2152) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 47 | `POST /core/catalog/price-tables` (core.ts:2170) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 48 | `DELETE /core/catalog/price-tables/:id` (core.ts:2180) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 49 | `GET /core/catalog/price-tables/:id/items` (core.ts:2199) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 50 | `PUT /core/catalog/price-tables/:id/items/:productId` (core.ts:2207) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 51 | `DELETE /core/catalog/price-tables/:id/items/:productId` (core.ts:2226) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 52 | `POST /core/products/:id/clone` (core.ts:2245) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 53 | `POST /core/products/:id/tipo` (core.ts:2289) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 54 | `GET /core/products/:id/barcodes` (core.ts:2337) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 55 | `POST /core/products/:id/barcodes` (core.ts:2351) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 56 | `DELETE /core/products/:id/barcodes/:barcode` (core.ts:2363) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 57 | `GET /core/products/:id/kit` (core.ts:2379) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 58 | `PUT /core/products/:id/kit` (core.ts:2397) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 59 | `GET /core/products/:id/price-tiers` (core.ts:2431) | `qualquer(products.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 60 | `PUT /core/products/:id/price-tiers` (core.ts:2446) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 61 | `DELETE /core/products/:id/price-tiers/:minQuantity` (core.ts:2474) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 62 | `GET /core/products/:id/custom-fields` (core.ts:2497) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 63 | `PUT /core/products/:id/custom-fields` (core.ts:2507) | `qualquer(products.manage, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 64 | `GET /core/products/:id/history` (core.ts:2553) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 65 | `POST /core/catalog/pricing/preview` (core.ts:2570) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 66 | `GET /core/products/:id/images` (core.ts:2621) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 67 | `POST /core/products/:id/images` (core.ts:2635) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 68 | `POST /core/products/:id/images/:imageId/primary` (core.ts:2660) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 69 | `DELETE /core/products/:id/images/:imageId` (core.ts:2671) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 70 | `POST /core/products/:id/images/reorder` (core.ts:2690) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 71 | `GET /core/products/:id/variants` (core.ts:2708) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 72 | `POST /core/products/:id/variants` (core.ts:2719) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 73 | `POST /core/products` (core.ts:2743) | `qualquer(products.manage, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 74 | `PUT /core/products/:id` (core.ts:2788) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 75 | `GET /core/stock` (core.ts:2831) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 76 | `GET /core/stock/valuation` (core.ts:2873) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 77 | `GET /core/stock/reconciliation` (core.ts:2912) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 78 | `GET /core/management-policy` (core.ts:2932) | `qualquer(dashboard.view, settings.management_policy.manage)` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 79 | `PUT /core/management-policy` (core.ts:2942) | `settings.management_policy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 80 | `POST /core/stock/reservations/:productId/liberar-sem-origem` (core.ts:2990) | `inventory.adjust.approve` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 81 | `GET /core/stock/movements` (core.ts:3024) | `qualquer(inventory.view, workshop.parts.view)` | x | x | x | x | x | x | . | . | . | x | . | igual |
| 82 | `GET /core/stock/movement-kinds` (core.ts:3076) | `qualquer(inventory.view, workshop.parts.view)` | x | x | x | x | x | x | . | . | . | x | . | igual |
| 83 | `POST /core/stock/movements` (core.ts:3101) | `qualquer(inventory.manage, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 84 | `GET /core/stock/locations` (core.ts:3288) | `qualquer(inventory.view, pdv.sell, workshop.kanban.view)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 85 | `POST /core/stock/locations` (core.ts:3306) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 86 | `PATCH /core/stock/locations/:id` (core.ts:3329) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 87 | `GET /core/stock/locations/balance/:productId` (core.ts:3353) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 88 | `POST /core/stock/transfers` (core.ts:3367) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 89 | `GET /core/stock/batches` (core.ts:3414) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 90 | `GET /core/stock/batches/alertas` (core.ts:3442) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 91 | `GET /core/stock/batches/saldos/:productId` (core.ts:3459) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 92 | `GET /core/stock/batches/:id` (core.ts:3469) | `inventory.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 93 | `POST /core/stock/batches` (core.ts:3484) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 94 | `PATCH /core/stock/batches/:id` (core.ts:3512) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 95 | `POST /core/stock/batches/:id/conferir` (core.ts:3551) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 96 | `POST /core/stock/batches/:id/alocar` (core.ts:3584) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 97 | `PATCH /core/stock/batch-control/:productId` (core.ts:3619) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 98 | `GET /core/customers` (core.ts:3646) | `qualquer(customers.view, pdv.sell, workshop.orders.open)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 99 | `POST /core/customers` (core.ts:3738) | `customers.manage` | x | x | x | x | . | x | . | x | x | . | . | igual |
| 100 | `GET /core/customers/:id` (core.ts:3756) | `qualquer(customers.view, pdv.sell, workshop.orders.open)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 101 | `PUT /core/customers/:id` (core.ts:3788) | `customers.manage` | x | x | x | x | . | x | . | x | x | . | . | igual |
| 102 | `PUT /core/customers/:id/price-table` (core.ts:3822) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 103 | `GET /core/customers/:id/credits` (core.ts:3867) | `qualquer(customers.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 104 | `GET /core/customers/:id/dados-do-titular` (core.ts:3891) | `customers.privacy.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 105 | `POST /core/customers/:id/anonimizar` (core.ts:3911) | `customers.privacy.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 106 | `GET /core/lgpd/retencao` (core.ts:3936) | `customers.privacy.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 107 | `GET /core/customer-credits/liability` (core.ts:3954) | `finance.advanced.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 108 | `GET /core/cash/open` (core.ts:3966) | `qualquer(pdv.cash.operate, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 109 | `GET /core/cash/drawers` (core.ts:4038) | `qualquer(pdv.cash.operate, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 110 | `GET /core/terminals` (core.ts:4055) | `qualquer(pdv.sell, sales.view, settings.terminals.manage)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 111 | `POST /core/terminals` (core.ts:4065) | `settings.terminals.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 112 | `PATCH /core/terminals/:id` (core.ts:4085) | `settings.terminals.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 113 | `POST /core/terminals/:id/deactivate` (core.ts:4109) | `settings.terminals.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 114 | `POST /core/terminals/:id/activate` (core.ts:4137) | `settings.terminals.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 115 | `GET /core/cash/sessions` (core.ts:4161) | `qualquer(pdv.cash.operate, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 116 | `POST /core/cash/open` (core.ts:4183) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 117 | `POST /core/cash/:sessionId/movements` (core.ts:4212) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 118 | `GET /core/cash/:sessionId/summary` (core.ts:4245) | `qualquer(pdv.cash.operate, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 119 | `POST /core/cash/:sessionId/close` (core.ts:4283) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 120 | `POST /core/cash/:sessionId/reopen` (core.ts:4322) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 121 | `GET /core/fiscal/certificate` (core.ts:4371) | `fiscal.certificate.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 122 | `POST /core/fiscal/certificate` (core.ts:4382) | `fiscal.certificate.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 123 | `GET /core/fiscal/certificates/group` (core.ts:4457) | `group.dashboard.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 124 | `POST /core/fiscal/certificate/revoke` (core.ts:4471) | `fiscal.certificate.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 125 | `GET /core/fiscal/nfce/csc` (core.ts:4515) | `fiscal.csc.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 126 | `POST /core/fiscal/nfce/csc` (core.ts:4525) | `fiscal.csc.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 127 | `GET /core/pdv/pix-asaas/status` (core.ts:4573) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 128 | `POST /core/pdv/pix-asaas` (core.ts:4585) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 129 | `GET /core/pdv/pix-asaas/:id` (core.ts:4615) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 130 | `POST /core/pdv/pix-asaas/:id/cancel` (core.ts:4633) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 131 | `GET /core/pdv/pix-pendentes` (core.ts:4657) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 132 | `POST /core/sales/:id/payments/:paymentId/confirmar` (core.ts:4670) | `sales.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 133 | `GET /core/pdv/terminal/status` (core.ts:4702) | `qualquer(pdv.payment.charge, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 134 | `POST /core/pdv/terminal/charge` (core.ts:4717) | `pdv.payment.charge` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 135 | `GET /core/pdv/terminal/uncertain` (core.ts:4751) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 136 | `GET /core/pdv/terminal/pendencias` (core.ts:4770) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 137 | `POST /core/pdv/terminal/:id/desistir` (core.ts:4793) | `pdv.payment.charge` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 138 | `POST /core/pdv/terminal/:id/tratativa` (core.ts:4812) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 139 | `POST /core/pdv/terminal/:id/vincular-venda` (core.ts:4829) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 140 | `POST /core/pdv/terminal/:id/estorno-manual` (core.ts:4852) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 141 | `GET /core/pdv/terminal/configurations` (core.ts:4881) | `pdv.terminal.activation` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 142 | `POST /core/pdv/terminal/configurations/:id/deactivate` (core.ts:4891) | `pdv.terminal.activation` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 143 | `POST /core/pdv/terminal/configurations/:id/activate` (core.ts:4909) | `pdv.terminal.activation` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 144 | `GET /core/pdv/terminal/:id` (core.ts:4932) | `qualquer(pdv.payment.charge, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 145 | `POST /core/pdv/terminal/:id/confirmar-teste` (core.ts:4952) | `pdv.payment.charge` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 146 | `POST /core/pdv/terminal/:id/reconcile` (core.ts:4965) | `pdv.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 147 | `GET /core/quotes` (core.ts:4990) | `qualquer(sales.quotes.manage, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 148 | `GET /core/quotes/:id` (core.ts:5011) | `qualquer(sales.quotes.manage, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 149 | `POST /core/quotes` (core.ts:5023) | `sales.quotes.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 150 | `POST /core/quotes/:id/convert` (core.ts:5073) | `todas(sales.quotes.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 151 | `PUT /core/quotes/:id/unidades` (core.ts:5149) | `sales.quotes.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 152 | `POST /core/quotes/:id/promote` (core.ts:5187) | `sales.quotes.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 153 | `POST /core/quotes/:id/cancel` (core.ts:5247) | `sales.quotes.cancel` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 154 | `POST /core/quotes/expire-overdue` (core.ts:5269) | `sales.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 155 | `PATCH /core/quotes/:id` (core.ts:5291) | `sales.quotes.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 156 | `POST /core/quotes/:id/renew` (core.ts:5339) | `sales.quotes.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 157 | `GET /core/consignments` (core.ts:5378) | `qualquer(sales.consignment.manage, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 158 | `GET /core/consignments/:id` (core.ts:5394) | `qualquer(sales.consignment.manage, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 159 | `POST /core/consignments` (core.ts:5408) | `sales.consignment.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 160 | `POST /core/consignments/:id/retorno` (core.ts:5450) | `sales.consignment.manage` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 161 | `POST /core/consignments/:id/faturar` (core.ts:5482) | `todas(sales.consignment.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 162 | `POST /core/consignments/:id/fechar` (core.ts:5507) | `sales.consignment.close` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 163 | `POST /core/sales` (core.ts:5570) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 164 | `GET /core/offline-sales` (core.ts:5667) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 165 | `POST /core/offline-sales` (core.ts:5686) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 166 | `POST /core/offline-sales/:id/relaunch` (core.ts:5708) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 167 | `POST /core/offline-sales/:id/relaunch-as-new` (core.ts:5768) | `pdv.sell` | x | x | x | x | . | x | x | x | x | . | . | igual |
| 168 | `POST /core/offline-sales/:id/discard` (core.ts:5831) | `sales.supervise` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 169 | `GET /core/authorizations/quem-libera` (core.ts:5871) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 170 | `POST /core/authorizations` (core.ts:5899) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 171 | `GET /core/authorizations` (core.ts:5992) | `audit.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 172 | `GET /core/sales/discount-policy` (core.ts:6021) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 173 | `GET /core/sale-policies` (core.ts:6049) | `settings.sale_policy.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 174 | `PUT /core/sale-policies` (core.ts:6058) | `settings.sale_policy.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 175 | `GET /core/sales` (core.ts:6111) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 176 | `GET /core/sales/:id` (core.ts:6152) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 177 | `POST /core/sales/:id/cancel` (core.ts:6276) | `sales.returns.operate` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 178 | `GET /core/finance/entries` (core.ts:6353) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 179 | `POST /core/finance/entries` (core.ts:6421) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 180 | `GET /core/finance/entries/:id/settlements` (core.ts:6470) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 181 | `POST /core/finance/entries/:id/settle` (core.ts:6480) | `qualquer(finance.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 182 | `POST /core/finance/settlements/:id/reverse` (core.ts:6518) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 183 | `GET /core/finance/cash-flow` (core.ts:6547) | `finance.advanced.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 184 | `GET /core/finance/legacy-settlements` (core.ts:6574) | `finance.advanced.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 185 | `POST /core/finance/legacy-settlements/mirror` (core.ts:6584) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 186 | `POST /core/finance/entries/:id/charge` (core.ts:6627) | `qualquer(finance.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 187 | `POST /core/finance/entries/:id/charges/cancel` (core.ts:6681) | `qualquer(finance.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 188 | `POST /core/finance/entries/:id/charges/refund` (core.ts:6717) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 189 | `GET /core/finance/entries/:id/charges` (core.ts:6759) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 190 | `GET /core/payment-intents` (core.ts:6785) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 191 | `POST /core/payment-intents/:id/retry` (core.ts:6809) | `qualquer(finance.manage, pdv.cash.operate)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 192 | `GET /core/finance/categories` (core.ts:6845) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 193 | `GET /core/finance/cost-centers` (core.ts:6870) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 194 | `GET /core/finance/income-statement` (core.ts:6899) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 195 | `GET /core/finance/cost-centers/report` (core.ts:6929) | `finance.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 196 | `GET /core/dashboard` (core.ts:6965) | `dashboard.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 197 | `GET /core/workshops` (core.ts:7433) | `workshop.benches.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 198 | `GET /core/workshops/brands` (core.ts:7460) | `workshop.benches.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 199 | `PUT /core/workshops/:id/brand` (core.ts:7472) | `workshop.benches.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 200 | `GET /core/fiscal/config` (core.ts:7495) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 201 | `POST /core/fiscal/sefaz/status` (core.ts:7536) | `fiscal.config.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 202 | `PATCH /core/fiscal/config` (core.ts:7734) | `fiscal.config.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 203 | `GET /core/system/secrets-readiness` (core.ts:7767) | `system.secrets.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 204 | `GET /core/fiscal/readiness` (core.ts:7776) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 205 | `GET /core/fiscal/classification` (core.ts:7826) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 206 | `POST /core/fiscal/classification/reler-notas` (core.ts:7878) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 207 | `POST /core/fiscal/classification/confirm` (core.ts:7888) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 208 | `POST /core/fiscal/production-unlock` (core.ts:7939) | `fiscal.policy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 209 | `POST /core/fiscal/sales/:saleId/emit` (core.ts:7975) | `fiscal.sale.emit` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 210 | `GET /core/fiscal/sales/:saleId/emission-readiness` (core.ts:8005) | `fiscal.sale.emit` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 211 | `GET /core/fiscal/sales/:saleId/status` (core.ts:8019) | `qualquer(fiscal.sale.emit, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 212 | `GET /core/fiscal/documents` (core.ts:8029) | `qualquer(fiscal.sale.emit, fiscal.view)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 213 | `GET /core/fiscal/documents/:id` (core.ts:8039) | `qualquer(fiscal.sale.emit, fiscal.view)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 214 | `GET /core/fiscal/documents/:id/danfce` (core.ts:8059) | `qualquer(fiscal.sale.emit, fiscal.view)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 215 | `GET /core/fiscal/pdv-summary` (core.ts:8080) | `qualquer(fiscal.sale.emit, fiscal.view)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 216 | `GET /core/fiscal/acts/plan` (core.ts:8165) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 217 | `GET /core/fiscal/emission-policy` (core.ts:8190) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 218 | `PUT /core/fiscal/emission-policy` (core.ts:8200) | `fiscal.policy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 219 | `PUT /core/fiscal/acts/policy` (core.ts:8210) | `fiscal.policy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 220 | `POST /core/fiscal/documents/:id/reenfileirar` (core.ts:8233) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 221 | `GET /core/fiscal/queue` (core.ts:8254) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 222 | `POST /core/fiscal/queue/drain` (core.ts:8265) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 223 | `POST /core/fiscal/documents/:id/transmitir` (core.ts:8278) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 224 | `GET /core/fiscal/contingency` (core.ts:8295) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 225 | `PUT /core/fiscal/contingency/policy` (core.ts:8305) | `fiscal.policy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 226 | `POST /core/fiscal/contingency/enter` (core.ts:8322) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 227 | `POST /core/fiscal/contingency/exit` (core.ts:8339) | `fiscal.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 228 | `POST /core/fiscal/documents/:id/cancel` (core.ts:8352) | `fiscal.documents.cancel` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 229 | `POST /core/fiscal/documents/:id/correction-letter` (core.ts:8371) | `fiscal.documents.cancel` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 230 | `GET /core/fiscal/correction-letter/notice` (core.ts:8390) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 231 | `GET /core/fiscal/void-ranges` (core.ts:8399) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 232 | `POST /core/fiscal/void-ranges` (core.ts:8411) | `fiscal.documents.cancel` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 233 | `GET /core/fiscal/documents/:id/xml` (core.ts:8451) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 234 | `GET /core/fiscal/documents/:id/danfe` (core.ts:8474) | `qualquer(fiscal.sale.emit, fiscal.view)` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 235 | `GET /core/fiscal/reconciliation` (core.ts:8488) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 236 | `GET /core/fiscal/closings/:period/previa` (core.ts:8521) | `accounting.closing.view` | x | x | x | x | . | . | . | . | . | . | x | igual |
| 237 | `GET /core/fiscal/closings/:period/pacote` (core.ts:8558) | `accounting.closing.view` | x | x | x | x | . | . | . | . | . | . | x | igual |
| 238 | `GET /core/fiscal/closings/conferir` (core.ts:8602) | `accounting.closing.view` | x | x | x | x | . | . | . | . | . | . | x | igual |
| 239 | `GET /core/fiscal/contador/destinatarios` (core.ts:8624) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 240 | `POST /core/fiscal/contador/destinatarios` (core.ts:8634) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 241 | `PATCH /core/fiscal/contador/destinatarios/:id` (core.ts:8650) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 242 | `GET /core/fiscal/contador/agenda` (core.ts:8668) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 243 | `PUT /core/fiscal/contador/agenda` (core.ts:8680) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 244 | `POST /core/fiscal/closings/:period/enviar` (core.ts:8704) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 245 | `GET /core/fiscal/closings/:period/envios` (core.ts:8724) | `accounting.closing.send` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 246 | `GET /core/fiscal/product-pendencies` (core.ts:8734) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 247 | `PATCH /core/fiscal/product-pendencies/:id` (core.ts:8744) | `fiscal.products.classify` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 248 | `GET /core/fiscal/series` (core.ts:8787) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 249 | `POST /core/fiscal/series` (core.ts:8802) | `fiscal.config.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 250 | `GET /core/companies` (core.ts:8900) | `group.companies.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 251 | `PATCH /core/companies/:id/equipment-tags` (core.ts:8932) | `group.companies.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 252 | `POST /core/companies` (core.ts:8976) | `group.companies.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 253 | `GET /core/sellers` (core.ts:9164) | `pdv.cash.operate` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 254 | `GET /core/team` (core.ts:9180) | `users.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 255 | `POST /core/team` (core.ts:9206) | `users.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 256 | `PATCH /core/team/:id` (core.ts:9237) | `users.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 257 | `POST /core/team/:id/active` (core.ts:9266) | `users.deactivate` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 258 | `POST /core/team/:id/password` (core.ts:9293) | `users.reset_password` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 259 | `POST /core/team/:id/remove-from-company` (core.ts:9326) | `users.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 260 | `POST /core/team/link` (core.ts:9350) | `users.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 261 | `GET /core/team/recuperacao-de-senha` (core.ts:9392) | `users.password_recovery.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 262 | `PUT /core/team/recuperacao-de-senha` (core.ts:9401) | `users.password_recovery.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 263 | `GET /core/team/profiles` (core.ts:9423) | `users.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 264 | `GET /core/workshop/orders` (core.ts:9462) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 265 | `GET /core/workshop/orders/:id/impressao` (core.ts:9518) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 266 | `GET /core/workshop/orders/:id` (core.ts:9542) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 267 | `GET /core/workshop/orders/:id/avisos` (core.ts:9559) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 268 | `GET /core/workshop/entrada` (core.ts:9578) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 269 | `POST /core/workshop/orders` (core.ts:9588) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 270 | `POST /core/workshop/orders/:id/assume` (core.ts:9627) | `workshop.orders.assume` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 271 | `POST /core/workshop/orders/:id/move` (core.ts:9656) | `workshop.orders.move` | x | x | . | x | . | . | . | . | x | x | . | igual |
| 272 | `POST /core/workshop/orders/:id/release` (core.ts:9694) | `workshop.orders.assume` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 273 | `POST /core/workshop/orders/:id/regularizar` (core.ts:9736) | `workshop.admin` | x | x | . | x | . | . | . | . | . | . | . | igual |
| 274 | `PATCH /core/workshop/orders/:id/plan` (core.ts:9777) | `workshop.orders.plan` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 275 | `GET /core/workshop/orders/:id/photos` (core.ts:9812) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 276 | `POST /core/workshop/orders/:id/photos` (core.ts:9831) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 277 | `DELETE /core/workshop/orders/:id/photos/:photoId` (core.ts:9860) | `workshop.orders.plan` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 278 | `GET /core/workshop/orders/:id/checklist` (core.ts:9884) | `workshop.kanban.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 279 | `PATCH /core/workshop/orders/:id/checklist/:itemId` (core.ts:9900) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 280 | `GET /core/workshop/sla` (core.ts:9926) | `workshop.admin` | x | x | . | x | . | . | . | . | . | . | . | igual |
| 281 | `PUT /core/workshop/sla` (core.ts:9936) | `workshop.admin` | x | x | . | x | . | . | . | . | . | . | . | igual |
| 282 | `POST /core/workshop/orders/:id/comments` (core.ts:9958) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 283 | `POST /core/workshop/orders/:id/parts` (core.ts:9988) | `workshop.parts.use` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 284 | `POST /core/workshop/orders/:id/labor` (core.ts:10019) | `workshop.labor.manage` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 285 | `POST /core/workshop/orders/:id/pedir-aprovacao` (core.ts:10046) | `workshop.quote.request` | x | x | . | x | . | x | . | . | . | x | . | igual |
| 286 | `POST /core/workshop/orders/:id/decidir-orcamento` (core.ts:10083) | `workshop.quote.request` | x | x | . | x | . | x | . | . | . | x | . | igual |
| 287 | `POST /core/workshop/orders/:id/complete` (core.ts:10130) | `workshop.orders.complete` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 288 | `GET /core/workshop/pending-payment` (core.ts:10176) | `workshop.checkout` | x | x | . | x | . | . | . | . | x | . | . | igual |
| 289 | `POST /core/workshop/orders/:id/checkout` (core.ts:10199) | `workshop.checkout` | x | x | . | x | . | . | . | . | x | . | . | igual |
| 290 | `POST /core/workshop/orders/:id/estorno` (core.ts:10269) | `workshop.checkout` | x | x | . | x | . | . | . | . | x | . | . | igual |
| 291 | `GET /core/equipment` (core.ts:10330) | `workshop.equipment.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 292 | `POST /core/equipment` (core.ts:10394) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 293 | `GET /core/equipment/:id` (core.ts:10469) | `workshop.equipment.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 294 | `PATCH /core/equipment/:id` (core.ts:10521) | `workshop.equipment.manage` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 295 | `PATCH /core/equipment/:id/identidade` (core.ts:10571) | `workshop.equipment.manage` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 296 | `GET /core/equipment/:id/photos` (core.ts:10614) | `workshop.equipment.view` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 297 | `POST /core/equipment/:id/photos` (core.ts:10630) | `workshop.orders.open` | x | x | . | x | . | x | . | . | x | x | . | igual |
| 298 | `DELETE /core/equipment/:id/photos/:photoId` (core.ts:10658) | `workshop.equipment.manage` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 299 | `POST /core/equipment/:id/owner` (core.ts:10681) | `workshop.equipment.owner` | x | x | x | x | . | . | . | x | . | . | . | igual |
| 300 | `POST /core/equipment/:id/owner/desfazer` (core.ts:10725) | `workshop.admin` | x | x | . | x | . | . | . | . | . | . | . | igual |
| 301 | `POST /core/products/:id/barcode` (core.ts:10781) | `labels.products.print` | x | x | x | x | x | . | . | x | . | . | . | igual |
| 302 | `POST /core/labels/products` (core.ts:10803) | `labels.products.print` | x | x | x | x | x | . | . | x | . | . | . | igual |
| 303 | `GET /core/labels/catalog` (core.ts:10825) | `qualquer(pdv.sell, products.view, workshop.kanban.view)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 304 | `GET /core/labels/candidates` (core.ts:10848) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 305 | `POST /core/labels/candidates/codes` (core.ts:10879) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 306 | `POST /core/labels/sheet` (core.ts:10902) | `labels.products.print` | x | x | x | x | x | . | . | x | . | . | . | igual |
| 307 | `GET /core/purchases/notes/:id/repricing` (core.ts:10958) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 308 | `POST /core/purchases/repricing/apply` (core.ts:10969) | `products.price.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 309 | `GET /core/acquirers` (core.ts:11002) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 310 | `POST /core/acquirers` (core.ts:11016) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 311 | `PATCH /core/acquirers/:id` (core.ts:11038) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 312 | `PUT /core/acquirers/:id/rates` (core.ts:11065) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 313 | `DELETE /core/acquirers/rates/:id` (core.ts:11096) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 314 | `GET /core/acquirers/preview` (core.ts:11115) | `finance.acquirers.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 315 | `GET /core/commissions/setup` (core.ts:11143) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 316 | `POST /core/commissions/groups` (core.ts:11157) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 317 | `PATCH /core/commissions/groups/:id` (core.ts:11176) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 318 | `PUT /core/commissions/groups/:id/tiers` (core.ts:11198) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 319 | `DELETE /core/commissions/tiers/:id` (core.ts:11222) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 320 | `PUT /core/commissions/members/:userId` (core.ts:11240) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 321 | `GET /core/commissions/summary` (core.ts:11259) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 322 | `POST /core/commissions/close` (core.ts:11280) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 323 | `GET /core/commissions/closings` (core.ts:11311) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 324 | `GET /core/commissions/closings/:id` (core.ts:11325) | `finance.commissions.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 325 | `GET /core/payment-methods` (core.ts:11341) | `qualquer(pdv.sell, sales.view, workshop.kanban.view)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 326 | `GET /core/finance/setup` (core.ts:11364) | `finance.advanced.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 327 | `POST /core/finance/categories` (core.ts:11383) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 328 | `PATCH /core/finance/categories/:id` (core.ts:11406) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 329 | `POST /core/finance/cost-centers` (core.ts:11428) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 330 | `PATCH /core/finance/cost-centers/:id` (core.ts:11450) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 331 | `POST /core/finance/accounts` (core.ts:11472) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 332 | `PATCH /core/finance/accounts/:id` (core.ts:11501) | `finance.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 333 | `GET /core/units/equipment-candidates` (core.ts:11542) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 334 | `GET /core/units/summary` (core.ts:11599) | `inventory.units.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 335 | `GET /core/units/:productId` (core.ts:11646) | `qualquer(inventory.units.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 336 | `POST /core/units/:id/equipment` (core.ts:11689) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 337 | `POST /core/units/:id/equipment/sheet` (core.ts:11734) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 338 | `DELETE /core/units/:id/equipment` (core.ts:11770) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 339 | `GET /core/units` (core.ts:11793) | `qualquer(inventory.units.view, pdv.sell)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 340 | `PATCH /core/units/:id` (core.ts:11804) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 341 | `POST /core/units/:id/write-off` (core.ts:11840) | `inventory.units.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 342 | `GET /core/scales/formats` (core.ts:11881) | `qualquer(pdv.sell, sales.view, workshop.kanban.view)` | x | x | x | x | x | x | x | x | x | x | . | igual |
| 343 | `GET /core/scales/products` (core.ts:11895) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 344 | `POST /core/scales/export` (core.ts:11914) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 345 | `POST /core/labels/equipment` (core.ts:11942) | `workshop.equipment.label` | x | x | . | x | . | . | . | . | x | x | . | igual |
| 346 | `POST /core/labels/equipment/sheet` (core.ts:12027) | `labels.equipment.print` | x | x | x | x | x | x | . | . | . | x | . | igual |
| 347 | `GET /core/labels/equipment/formats` (core.ts:12113) | `labels.equipment.print` | x | x | x | x | x | x | . | . | . | x | . | igual |
| 348 | `POST /core/equipment-tags/batches` (core.ts:12139) | `workshop.tags.print` | x | x | x | x | x | . | . | . | . | x | . | igual |
| 349 | `GET /core/equipment-tags` (core.ts:12162) | `workshop.tags.view` | x | x | x | x | x | x | . | . | x | x | . | igual |
| 350 | `GET /core/equipment-tags/batches` (core.ts:12208) | `workshop.tags.view` | x | x | x | x | x | x | . | . | x | x | . | igual |
| 351 | `POST /core/equipment-tags/sheet` (core.ts:12243) | `workshop.tags.print` | x | x | x | x | x | . | . | . | . | x | . | igual |
| 352 | `POST /core/equipment-tags/release` (core.ts:12344) | `workshop.tags.release` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 353 | `POST /core/equipment-tags/:id/damage` (core.ts:12368) | `workshop.tags.print` | x | x | x | x | x | . | . | . | . | x | . | igual |
| 354 | `POST /core/equipment-tags/:id/replace` (core.ts:12398) | `workshop.equipment.manage` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 355 | `GET /core/equipment-tags/layout` (core.ts:12423) | `workshop.tags.print` | x | x | x | x | x | . | . | . | . | x | . | igual |
| 356 | `PUT /core/equipment-tags/layout` (core.ts:12433) | `workshop.tags.layout` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 357 | `GET /core/purchases/notes` (core.ts:12458) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 358 | `POST /core/purchases/nfe/preview` (core.ts:12482) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 359 | `POST /core/purchases/nfe/import` (core.ts:12498) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 360 | `GET /core/purchases/cte` (core.ts:12523) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 361 | `POST /core/purchases/cte/import` (core.ts:12540) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 362 | `GET /core/purchases/dfe` (core.ts:12572) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 363 | `POST /core/purchases/dfe/consultar` (core.ts:12607) | `purchases.receive` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 364 | `POST /core/purchases/dfe/:chave/manifestar` (core.ts:12615) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 365 | `POST /core/purchases/dfe/:chave/importar` (core.ts:12634) | `purchases.receive` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 366 | `GET /core/purchases/notes/:id/xml` (core.ts:12692) | `qualquer(purchases.receive, pdv.backoffice, accounting.closing.view)` | x | x | x | x | x | . | . | x | x | . | x | igual |
| 367 | `GET /core/purchases/notes/:id/items` (core.ts:12734) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 368 | `POST /core/purchases/notes/:id/link` (core.ts:12744) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 369 | `POST /core/purchases/notes/:id/conferir` (core.ts:12799) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 370 | `POST /core/purchases/notes/:id/confirm` (core.ts:12851) | `qualquer(purchases.receive, pdv.backoffice)` | x | x | x | x | x | . | . | x | x | . | . | igual |
| 371 | `POST /core/purchases/manual` (core.ts:12889) | `purchases.receive` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 372 | `POST /core/purchases/notes/:id/estornar` (core.ts:12931) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 373 | `GET /core/purchases/notes/:id/devolviveis` (core.ts:12968) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 374 | `GET /core/purchases/supplier-returns` (core.ts:12978) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 375 | `GET /core/purchases/supplier-returns/:id` (core.ts:12993) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 376 | `POST /core/purchases/supplier-returns` (core.ts:13003) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 377 | `GET /core/purchases/notas-sem-conta` (core.ts:13049) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 378 | `POST /core/purchases/notes/:id/conta-a-pagar` (core.ts:13059) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 379 | `POST /core/purchases/supplier-returns/:id/fiscal` (core.ts:13093) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 380 | `GET /core/orders` (core.ts:13122) | `ecommerce.orders.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 381 | `GET /core/orders/:id` (core.ts:13163) | `ecommerce.orders.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 382 | `GET /core/orders/:id/nfe/readiness` (core.ts:13207) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 383 | `POST /core/orders/:id/nfe` (core.ts:13224) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 384 | `POST /core/orders/:id/nfe/municipio` (core.ts:13261) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 385 | `POST /core/orders/:id/pay` (core.ts:13293) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 386 | `POST /core/orders/:id/cancel` (core.ts:13330) | `ecommerce.orders.service` | x | x | x | . | . | x | . | . | . | . | . | igual |
| 387 | `POST /core/orders/:id/devolver` (core.ts:13377) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 388 | `POST /core/orders/:id/devolucao/receber` (core.ts:13416) | `ecommerce.orders.receive_return` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 389 | `POST /core/orders/:id/devolucao/solicitacoes/:requestId/decidir` (core.ts:13452) | `ecommerce.orders.service` | x | x | x | . | . | x | . | . | . | . | . | igual |
| 390 | `POST /core/orders/:id/fulfillment` (core.ts:13482) | `ecommerce.orders.fulfill` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 391 | `POST /core/orders/:id/fulfillment/voltar` (core.ts:13514) | `ecommerce.orders.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 392 | `GET /core/promotions` (core.ts:13540) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 393 | `POST /core/promotions` (core.ts:13559) | `ecommerce.promotions.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 394 | `PATCH /core/promotions/:id` (core.ts:13598) | `ecommerce.promotions.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 395 | `DELETE /core/promotions/:id` (core.ts:13625) | `ecommerce.promotions.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 396 | `GET /core/coupons` (core.ts:13647) | `products.view` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 397 | `POST /core/coupons` (core.ts:13657) | `ecommerce.promotions.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 398 | `DELETE /core/coupons/:id` (core.ts:13684) | `ecommerce.promotions.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 399 | `GET /core/sync/status` (core.ts:13751) | `integrations.sync.operate` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 400 | `POST /core/sync/run` (core.ts:13778) | `integrations.sync.operate` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 401 | `POST /core/sync/probe` (core.ts:13788) | `integrations.sync.admin` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 402 | `POST /core/sync/bootstrap` (core.ts:13808) | `integrations.sync.admin` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 403 | `POST /core/sync/revive` (core.ts:13841) | `integrations.sync.admin` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 404 | `GET /core/integrations/status` (core.ts:13861) | `integrations.status.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 405 | `GET /core/integrations/asaas` (core.ts:13931) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 406 | `GET /core/integrations/asaas/grupo` (core.ts:13956) | `group.dashboard.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 407 | `PUT /core/integrations/asaas/credentials` (core.ts:13978) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 408 | `POST /core/integrations/asaas/homologar` (core.ts:14033) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 409 | `POST /core/integrations/asaas/homologar/conferir-aviso` (core.ts:14082) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 410 | `PUT /core/integrations/asaas/webhook-token` (core.ts:14096) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 411 | `DELETE /core/integrations/asaas/credentials/:environment` (core.ts:14120) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 412 | `PATCH /core/integrations/asaas` (core.ts:14151) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 413 | `POST /core/integrations/asaas/test` (core.ts:14187) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 414 | `GET /core/audit` (core.ts:14263) | `audit.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 415 | `GET /core/shipping-settings` (core.ts:14292) | `ecommerce.shipping.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 416 | `PUT /core/shipping-settings` (core.ts:14309) | `ecommerce.shipping.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 417 | `GET /core/emails` (core.ts:14355) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 418 | `POST /core/emails/:id/reenviar` (core.ts:14385) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 419 | `POST /core/emails/enviar` (core.ts:14405) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 420 | `GET /core/emails/identidade` (core.ts:14424) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 421 | `PUT /core/emails/identidade` (core.ts:14438) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 422 | `GET /core/comunicacoes/prontidao` (core.ts:14465) | `ecommerce.emails.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 423 | `GET /core/asaas/conciliacao` (core.ts:14479) | `integrations.asaas.reconcile` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 424 | `POST /core/asaas/conciliacao/sincronizar` (core.ts:14513) | `integrations.asaas.reconcile` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 425 | `GET /core/asaas/conciliacao/sincronizacao` (core.ts:14541) | `integrations.asaas.reconcile` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 426 | `POST /core/customers/:id/convite-portal` (core.ts:14564) | `customers.portal.invite` | x | x | x | x | . | x | . | . | . | x | . | igual |
| 427 | `GET /core/workshop/chamados` (core.ts:14585) | `workshop.tickets.manage` | x | x | x | x | . | x | . | . | . | x | . | igual |
| 428 | `POST /core/workshop/chamados/:id/converter` (core.ts:14602) | `workshop.tickets.manage` | x | x | x | x | . | x | . | . | . | x | . | igual |
| 429 | `POST /core/workshop/chamados/:id/encerrar` (core.ts:14637) | `workshop.tickets.manage` | x | x | x | x | . | x | . | . | . | x | . | igual |
| 430 | `GET /core/carriers` (core.ts:14669) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 431 | `GET /core/carriers/:id` (core.ts:14684) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 432 | `POST /core/carriers` (core.ts:14695) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 433 | `PATCH /core/carriers/:id` (core.ts:14714) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 434 | `POST /core/carriers/:id/active` (core.ts:14732) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 435 | `GET /core/inbound/config` (core.ts:14757) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 436 | `PUT /core/inbound/config` (core.ts:14767) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 437 | `GET /core/suppliers` (core.ts:14793) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 438 | `GET /core/suppliers/:id` (core.ts:14808) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 439 | `POST /core/suppliers` (core.ts:14822) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 440 | `PATCH /core/suppliers/:id` (core.ts:14840) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 441 | `POST /core/suppliers/:id/active` (core.ts:14859) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 442 | `GET /core/purchase-orders` (core.ts:14884) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 443 | `GET /core/purchase-orders/:id` (core.ts:14904) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 444 | `POST /core/purchase-orders` (core.ts:14914) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 445 | `PUT /core/purchase-orders/:id/items` (core.ts:14939) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 446 | `POST /core/purchase-orders/:id/send` (core.ts:14962) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 447 | `GET /core/purchase-orders/:id/impressao` (core.ts:14986) | `purchases.view` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 448 | `POST /core/purchase-orders/:id/email` (core.ts:15003) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 449 | `POST /core/purchase-orders/:id/cancel` (core.ts:15030) | `purchases.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 450 | `POST /core/purchase-orders/:id/notes/:noteId` (core.ts:15053) | `purchases.receive` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 451 | `GET /core/sales/:id/returnable` (core.ts:15119) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 452 | `GET /core/sale-returns` (core.ts:15129) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 453 | `GET /core/sale-returns/:id` (core.ts:15144) | `qualquer(pdv.sell, sales.view)` | x | x | x | x | x | x | x | x | x | . | . | igual |
| 454 | `POST /core/sale-returns` (core.ts:15164) | `sales.returns.operate` | x | x | x | x | x | x | . | . | . | . | . | igual |
| 455 | `GET /core/inventory-counts` (core.ts:15236) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 456 | `GET /core/inventory-counts/:id` (core.ts:15250) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 457 | `POST /core/inventory-counts` (core.ts:15260) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 458 | `POST /core/inventory-counts/:id/items` (core.ts:15292) | `inventory.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 459 | `POST /core/inventory-counts/:id/apply` (core.ts:15311) | `inventory.adjust.approve` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 460 | `POST /core/inventory-counts/:id/cancel` (core.ts:15334) | `inventory.adjust.approve` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 461 | `GET /core/leads` (core.ts:15362) | `crm.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 462 | `POST /core/leads` (core.ts:15377) | `crm.leads.manage` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 463 | `PATCH /core/leads/:id/status` (core.ts:15398) | `crm.leads.manage` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 464 | `POST /core/leads/:id/convert` (core.ts:15416) | `crm.opportunities.close` | x | x | x | x | . | x | . | . | . | . | . | igual |
| 465 | `GET /core/opportunities` (core.ts:15434) | `crm.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 466 | `POST /core/opportunities` (core.ts:15448) | `crm.leads.manage` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 467 | `POST /core/opportunities/:id/close` (core.ts:15467) | `crm.opportunities.close` | x | x | x | x | . | x | . | . | . | . | . | igual |
| 468 | `GET /core/crm/summary` (core.ts:15485) | `crm.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 469 | `GET /core/loyalty/program` (core.ts:15501) | `crm.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 470 | `PUT /core/loyalty/program` (core.ts:15511) | `crm.loyalty.config` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 471 | `GET /core/loyalty/customers/:id` (core.ts:15534) | `crm.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 472 | `POST /core/loyalty/redeem` (core.ts:15545) | `crm.loyalty.redeem` | x | x | x | x | . | . | . | x | . | . | . | igual |
| 473 | `GET /core/rentals` (core.ts:15568) | `rentals.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 474 | `GET /core/rentals/:id` (core.ts:15582) | `rentals.view` | x | x | x | x | . | x | . | x | . | . | . | igual |
| 475 | `POST /core/rentals` (core.ts:15592) | `rentals.manage` | x | x | x | x | . | x | . | . | . | . | . | igual |
| 476 | `POST /core/rentals/:id/return` (core.ts:15619) | `rentals.manage` | x | x | x | x | . | x | . | . | . | . | . | igual |
| 477 | `POST /core/rentals/:id/cancel` (core.ts:15636) | `rentals.cancel` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 478 | `GET /core/workshop/parts` (core.ts:15659) | `workshop.parts.view` | x | x | x | x | x | x | . | . | . | x | . | igual |
| 479 | `GET /core/workshop/parts/scan` (core.ts:15688) | `qualquer(workshop.parts.use, workshop.parts.manage)` | x | x | x | x | x | . | . | . | . | x | . | igual |
| 480 | `POST /core/workshop/parts` (core.ts:15723) | `workshop.parts.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 481 | `POST /core/workshop/parts/:id/reposicao` (core.ts:15785) | `workshop.parts.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 482 | `PATCH /core/workshop/parts/:id` (core.ts:15828) | `workshop.parts.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 483 | `POST /core/workshop/orders/:orderId/parts/:partId/return` (core.ts:15856) | `workshop.parts.use` | x | x | . | x | . | . | . | . | . | x | . | igual |
| 484 | `GET /core/bank/statements` (core.ts:15899) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 485 | `GET /core/bank/lines` (core.ts:15916) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 486 | `POST /core/bank/statements` (core.ts:15934) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 487 | `GET /core/bank/lines/:id/suggestions` (core.ts:15958) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 488 | `POST /core/bank/lines/:id/match` (core.ts:15969) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 489 | `DELETE /core/bank/lines/:id/match` (core.ts:16009) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 490 | `GET /core/bank/conciliacao` (core.ts:16034) | `finance.bank_reconciliation.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 491 | `GET /core/storefront/settings` (core.ts:16056) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 492 | `POST /core/storefront/imagem` (core.ts:16081) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 493 | `DELETE /core/storefront/imagem/:tipo` (core.ts:16105) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 494 | `PUT /core/storefront/settings` (core.ts:16124) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 495 | `GET /core/storefront/checkout-policy` (core.ts:16158) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 496 | `PUT /core/storefront/checkout-policy` (core.ts:16168) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 497 | `GET /core/portal/login-google` (core.ts:16195) | `integrations.google_login.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 498 | `PUT /core/portal/login-google` (core.ts:16204) | `integrations.google_login.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 499 | `POST /core/storefront/featured/:productId` (core.ts:16237) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 500 | `GET /core/workshops/:id/members` (core.ts:16262) | `workshop.benches.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 501 | `POST /core/workshops/:id/members` (core.ts:16273) | `workshop.benches.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 502 | `DELETE /core/workshops/:id/members/:userId` (core.ts:16296) | `workshop.benches.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 503 | `GET /core/reports` (core.ts:16333) | `reports.central.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 504 | `GET /core/reports/:id` (core.ts:16357) | `reports.central.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 505 | `GET /core/insights/operations` (core.ts:16429) | `reports.bi.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 506 | `GET /core/insights/products` (core.ts:16445) | `reports.bi.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 507 | `GET /core/insights/brands` (core.ts:16468) | `reports.bi.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 508 | `GET /core/insights/margin` (core.ts:16486) | `reports.bi.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 509 | `GET /core/logistics/readiness` (core.ts:16517) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 510 | `GET /core/logistics/carriers` (core.ts:16532) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 511 | `POST /core/logistics/quote` (core.ts:16552) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 512 | `GET /core/loja/prontidao-do-dia-1` (core.ts:16591) | `ecommerce.store.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 513 | `POST /core/import/produtos` (core.ts:16618) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 514 | `GET /core/import/produtos` (core.ts:16647) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 515 | `GET /core/import/produtos/:id/itens` (core.ts:16657) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 516 | `PUT /core/import/produtos/:id/leitura` (core.ts:16678) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 517 | `POST /core/import/produtos/:id/confirmar` (core.ts:16702) | `products.catalog.admin` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 518 | `DELETE /core/import/produtos/:id` (core.ts:16722) | `products.manage` | x | x | x | x | x | . | . | . | . | . | . | igual |
| 519 | `POST /auth/password` (auth.ts:296) | `SO_AUTENTICADO` | x | x | x | x | x | x | x | x | x | x | x | igual |
| 520 | `POST /auth/device/enroll` (auth.ts:457) | `devices.manage` | x | x | . | . | . | . | . | . | . | . | . | igual · D9 |
| 521 | `GET /auth/devices` (auth.ts:526) | `devices.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 522 | `POST /auth/device/:id/revoke` (auth.ts:595) | `devices.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 523 | `POST /auth/logout` (auth.ts:855) | `SO_AUTENTICADO` | x | x | x | x | x | x | x | x | x | x | x | igual |
| 524 | `GET /auth/session` (auth.ts:869) | `SO_AUTENTICADO` | x | x | x | x | x | x | x | x | x | x | x | igual |
| 525 | `POST /auth/switch-company` (auth.ts:895) | `SO_AUTENTICADO` | x | x | x | x | x | x | x | x | x | x | x | igual |
| 526 | `GET /asaas/status` (index.ts:237) | `integrations.asaas.view` | x | x | x | . | . | x | . | . | . | . | . | igual |
| 527 | `POST /asaas/test-connection` (index.ts:256) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 528 | `POST /asaas/customers/sync` (index.ts:275) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 529 | `POST /asaas/charges` (index.ts:286) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 530 | `GET /asaas/charges/:chargeLinkId` (index.ts:297) | `integrations.asaas.view` | x | x | x | . | . | x | . | . | . | . | . | igual |
| 531 | `POST /asaas/charges/:chargeLinkId/cancel` (index.ts:308) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 532 | `GET /asaas/queue` (index.ts:317) | `integrations.asaas.view` | x | x | x | . | . | x | . | . | . | . | . | igual |
| 533 | `POST /asaas/queue/:attemptId/retry` (index.ts:331) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 534 | `POST /asaas/homologation/start` (index.ts:407) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 535 | `POST /asaas/production/activate` (index.ts:418) | `integrations.asaas.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 536 | `GET /logistics/readiness` (logistics.ts:56) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 537 | `GET /logistics/providers-status` (logistics.ts:60) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 538 | `GET /logistics/shipments` (logistics.ts:69) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 539 | `GET /logistics/orders/:orderId/shipments` (logistics.ts:86) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 540 | `POST /logistics/orders/:orderId/services` (logistics.ts:100) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 541 | `POST /logistics/orders/:orderId/label` (logistics.ts:112) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 542 | `POST /logistics/shipments` (logistics.ts:135) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 543 | `POST /logistics/shipments/:id/continue` (logistics.ts:161) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 544 | `GET /logistics/shipments/:id/label` (logistics.ts:170) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 545 | `POST /logistics/shipments/:id/sync` (logistics.ts:179) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 546 | `POST /logistics/shipments/:id/cancel` (logistics.ts:187) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 547 | `GET /logistics/settings/shipping` (logistics.ts:206) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 548 | `PUT /logistics/settings/shipping` (logistics.ts:214) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 549 | `POST /logistics/quotes` (logistics.ts:222) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 550 | `GET /logistics/quotes/:quoteId` (logistics.ts:259) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 551 | `GET /logistics/carriers` (logistics.ts:270) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 552 | `POST /logistics/carriers/credentials` (logistics.ts:287) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 553 | `DELETE /logistics/carriers/:carrier/credentials` (logistics.ts:332) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 554 | `POST /logistics/carriers/:carrier/test-connection` (logistics.ts:356) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 555 | `POST /logistics/carriers/:carrier/test-quote` (logistics.ts:369) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 556 | `POST /logistics/carriers/:carrier/test-tracking` (logistics.ts:377) | `logistics.view` | x | x | x | . | x | x | . | . | . | . | . | igual |
| 557 | `GET /logistics/homologation` (logistics.ts:387) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 558 | `POST /logistics/homologation/run` (logistics.ts:391) | `logistics.manage` | x | x | x | . | x | . | . | . | . | . | . | igual |
| 559 | `GET /core/fiscal/nfse/config` (nfse.ts:45) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 560 | `PATCH /core/fiscal/nfse/config` (nfse.ts:54) | `fiscal.config.manage` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 561 | `GET /core/fiscal/nfse/readiness` (nfse.ts:64) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 562 | `GET /core/fiscal/nfse/documents` (nfse.ts:73) | `fiscal.view` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 563 | `GET /core/fiscal/sales/:saleId/nfse` (nfse.ts:82) | `fiscal.sale.emit` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 564 | `POST /core/fiscal/sales/:saleId/nfse` (nfse.ts:91) | `fiscal.sale.emit` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 565 | `POST /core/fiscal/sales/:saleId/nfse/manual` (nfse.ts:112) | `fiscal.sale.emit` | x | x | x | x | . | . | x | x | x | . | . | igual |
| 566 | `POST /core/fiscal/nfse/:id/cancel-record` (nfse.ts:132) | `fiscal.documents.cancel` | x | x | x | x | . | . | . | . | . | . | . | igual |
| 567 | `GET /payment-terminals/readiness` (payment-terminals.ts:215) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 568 | `GET /payment-terminals/providers-status` (payment-terminals.ts:219) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 569 | `GET /payment-terminals/local-agent/status` (payment-terminals.ts:223) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 570 | `POST /payment-terminals/local-agent/pairing` (payment-terminals.ts:227) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 571 | `POST /payment-terminals/local-agent/pair` (payment-terminals.ts:244) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 572 | `POST /payment-terminals/local-agent/heartbeat` (payment-terminals.ts:258) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 573 | `POST /payment-terminals/local-agents/:id/revoke` (payment-terminals.ts:271) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 574 | `GET /payment-terminals/agent-commands` (payment-terminals.ts:285) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 575 | `GET /payment-terminals/providers` (payment-terminals.ts:300) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 576 | `GET /payment-terminals/providers/:provider/capabilities` (payment-terminals.ts:304) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 577 | `GET /payment-terminals/configurations` (payment-terminals.ts:308) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 578 | `POST /payment-terminals/configurations` (payment-terminals.ts:312) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 579 | `PATCH /payment-terminals/configurations/:id` (payment-terminals.ts:342) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 580 | `POST /payment-terminals/credentials` (payment-terminals.ts:360) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 581 | `GET /payment-terminals/terminals` (payment-terminals.ts:395) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 582 | `POST /payment-terminals/providers/:provider/test-connection` (payment-terminals.ts:399) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 583 | `POST /payment-terminals/providers/:provider/test-transaction` (payment-terminals.ts:403) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 584 | `GET /payment-terminals/transactions` (payment-terminals.ts:428) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 585 | `POST /payment-terminals/transactions` (payment-terminals.ts:437) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 586 | `GET /payment-terminals/transactions/:id` (payment-terminals.ts:462) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 587 | `POST /payment-terminals/transactions/:id/cancel` (payment-terminals.ts:480) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 588 | `POST /payment-terminals/transactions/:id/refund` (payment-terminals.ts:494) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 589 | `POST /payment-terminals/transactions/:id/query` (payment-terminals.ts:515) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 590 | `GET /payment-terminals/transactions/:id/receipt` (payment-terminals.ts:537) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 591 | `POST /payment-terminals/transactions/:id/reprint` (payment-terminals.ts:549) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 592 | `GET /payment-terminals/homologation` (payment-terminals.ts:562) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 593 | `POST /payment-terminals/homologation/run` (payment-terminals.ts:566) | `integrations.card_terminal.manage` | x | x | x | . | . | . | . | . | . | . | . | igual |
| 594 | `GET /payment-terminals/local-agents` (payment-terminals.ts:598) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 595 | `GET /payment-terminals/dashboard` (payment-terminals.ts:602) | `integrations.card_terminal.view` | x | x | x | . | . | x | x | x | x | . | . | igual |
| 596 | `GET /payment-terminals/recovery` (payment-terminals.ts:606) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 597 | `GET /payment-terminals/dead-letter` (payment-terminals.ts:618) | `integrations.card_terminal.operate` | x | x | x | . | . | . | x | x | x | . | . | igual |
| 598 | `GET /system/readiness` (system-admin.ts:30) | `system.status.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 599 | `GET /system/implantacao` (system-admin.ts:50) | `system.deploy.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 600 | `GET /system/implantacao/empresas` (system-admin.ts:79) | `system.deploy.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 601 | `GET /system/implantacao/empresas/:companyId` (system-admin.ts:90) | `system.deploy.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 602 | `PUT /system/implantacao/empresas/:companyId/itens/:item/marca` (system-admin.ts:98) | `system.deploy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 603 | `DELETE /system/implantacao/empresas/:companyId/itens/:item/marca` (system-admin.ts:125) | `system.deploy.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 604 | `GET /system/release` (system-admin.ts:182) | `system.status.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 605 | `GET /system/backup/status` (system-admin.ts:206) | `system.backup.view` | x | x | . | . | . | . | . | . | . | . | . | igual |
| 606 | `POST /system/backup/conferir-bucket` (system-admin.ts:215) | `system.backup.manage` | x | x | . | . | . | . | . | . | . | . | . | igual |

</details>

## 3. Pontos de serviço (fora do guarda da rota)

São 254 pontos. Veredito: igual 236 · n/a 7 · igual pelo passo 86 1 · muda 6 · igual (regra) 4. A tabela abaixo mostra só os que precisaram de regra própria (categoria diferente de "servico-ator" comum) ou mudam; os demais são "igual" com a capability pura.

**§3.1 `bancadasDoVinculo`** (desenho §7.2, corrigido): `all_workshops = 1`, ou NULL com `default_workshops = todas` no modelo → todas as bancadas ATIVAS da empresa; senão as de `core_workshop_members` em bancadas ATIVAS; vazio = nenhuma. O passo 86 grava `all_workshops = 1` para quem tem `workshop.admin` (hoje: admin_geral, gestor, gerente_oficina) e para os não-membros de bancada ativa que não são mecânico (o fallback de core.ts:7383-7384). Nos pontos marcados "todas = workshop.admin", o conjunto de hoje (quem vê todas por código de perfil) é exatamente o de `workshop.admin`; a capability da rota não muda.

| ponto | categoria | regra no dia 1 | hoje | dia 1 | veredito |
|---|---|---|---|---|---|
| core.ts:1547 `POST /core/print/jobs` | escopo-caixa | requireTerminalNoEscopo só quando existe caixa efetivo e a pessoa entrou por pdv.sell; quem entra só por sales.view não leva 409. | A,G,CL,CO,L,O,T,E | A,G,L,O,E,T,CL,CO | igual |
| core.ts:6242 `POST /core/sales/:id/cancel` | liberador | `approval.sale_cancel` | T,E,O | — | n/a (porta do bilhete: a capability é do LIBERADOR, conferida na emissão, core.ts:5916; perfis_hoje são quem pede) |
| core.ts:7359 | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:7375 | escopo-bancada | bancadasDoVinculo: all_workshops=1 ou NULL com default "todas" → todas as ativas; senão as de core_workshop_members ATIVAS; vazio = nenhuma. Passo 86 conta só bancadas ATIVAS. | L,E,T,C,CL,CO,M | — | igual pelo passo 86 (all_workshops=1 para não-membros de bancada ATIVA que não são mecânico), salvo D3b |
| core.ts:7397 | escopo-bancada/entrada | Abre OS em TODAS as bancadas ativas: workshop.admin ou (workshop.orders.open e não workshop.orders.assume). Os demais: bancadasDoVinculo. | A,G,O,T,CO | A,G,O,T,CO | igual |
| core.ts:7408 | voz | vozNaOs: workshop.admin → gestor; workshop.orders.assume → técnico; senão balcão. perfis_hoje = quem NÃO fala como balcão. | A,G,O,M | A,G,O,M | igual |
| core.ts:7417 | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9184 `GET /core/team` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual · D3 |
| core.ts:9464 `GET /core/workshop/orders` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9465 `GET /core/workshop/orders` | voz | onlyMine = assume e não admin | M | M | igual |
| core.ts:9529 `GET /core/workshop/orders/:id/impressao` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9544 `GET /core/workshop/orders/:id` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9563 `GET /core/workshop/orders/:id/avisos` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9580 `GET /core/workshop/entrada` | escopo-bancada/entrada | idem core.ts:7397 | A,G,O,T,CO | A,G,O,T,CO | igual |
| core.ts:9592 `POST /core/workshop/orders` | escopo-bancada/entrada | idem core.ts:7397 | A,G,O,T,CO | A,G,O,T,CO | igual |
| core.ts:9632 `POST /core/workshop/orders/:id/assume` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9661 `POST /core/workshop/orders/:id/move` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9667 `POST /core/workshop/orders/:id/move` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9707 `POST /core/workshop/orders/:id/release` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9712 `POST /core/workshop/orders/:id/release` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9740 `POST /core/workshop/orders/:id/regularizar` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9782 `PATCH /core/workshop/orders/:id/plan` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9788 `PATCH /core/workshop/orders/:id/plan` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9815 `GET /core/workshop/orders/:id/photos` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9833 `POST /core/workshop/orders/:id/photos` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9862 `DELETE /core/workshop/orders/:id/photos/:photoId` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9886 `GET /core/workshop/orders/:id/checklist` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9902 `PATCH /core/workshop/orders/:id/checklist/:itemId` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9972 `POST /core/workshop/orders/:id/comments` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9993 `POST /core/workshop/orders/:id/parts` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:9999 `POST /core/workshop/orders/:id/parts` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10025 `POST /core/workshop/orders/:id/labor` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10031 `POST /core/workshop/orders/:id/labor` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10051 `POST /core/workshop/orders/:id/pedir-aprovacao` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10055 `POST /core/workshop/orders/:id/pedir-aprovacao` | voz | isManager = não assume, ou admin | A,G,O,T | A,G,O,T | igual |
| core.ts:10097 `POST /core/workshop/orders/:id/decidir-orcamento` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10105 `POST /core/workshop/orders/:id/decidir-orcamento` | voz | isManager = não assume, ou admin | A,G,O,T | A,G,O,T | igual |
| core.ts:10135 `POST /core/workshop/orders/:id/complete` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10178 `GET /core/workshop/pending-payment` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:10212 `POST /core/workshop/orders/:id/checkout` | escopo-caixa | O caixa do recebimento passa a vir de terminalDoPedido (token vence o corpo; divergência 409) e entra requireTerminalNoEscopo. | A,G,CO,O | A,G,O,CO | igual · D12 |
| core.ts:10332 `GET /core/equipment` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual · D3 |
| core.ts:10398 `POST /core/equipment` | escopo-bancada/entrada | idem core.ts:7397 | A,G,O,T,CO | A,G,O,T,CO | igual |
| core.ts:14589 `GET /core/workshop/chamados` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:15668 `GET /core/workshop/parts` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:15692 `GET /core/workshop/parts/scan` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:15867 `POST /core/workshop/orders/:orderId/parts/:partId/return` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| core.ts:15873 `POST /core/workshop/orders/:orderId/parts/:partId/return` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| auth.ts:156 | definicao | `qualquer(integrations.card_terminal.view, integrations.card_terminal.operate, integrations.card_terminal.manage, logistics.view, logistics.manage, integrations.asaas.view, integrations.asaas.manage, system.status.view, system.deploy.view, system.deploy.manage, system.backup.view, system.backup.manage, devices.view, devices.manage)` | A,G | — | n/a (definição de requirePermission: vira tradutor por ROTA na F1 e morre na F5) |
| auth.ts:192 | servico-ator | `PUBLICA` | — | anonimo | igual (pública) |
| auth.ts:401 `POST /auth/device/login` | escopo-caixa | Login do dispositivo: o titular do token tem pdv.device_login na empresa do token, não é conta de dono, e o caixa do token está no escopo do vínculo (requireTerminalNoEscopo). | A,G,L,O,E,T,C,CL,CO,M,K | C,CL,CO | muda (D10) |
| nfse.ts:38 | definicao | `qualquer(fiscal.view, fiscal.config.manage, fiscal.sale.emit, fiscal.documents.cancel)` | A,G | — | n/a (cópia local de requireProfile: apagada na fatia c) |
| payment-terminals.ts:74 | definicao | `integrations.card_terminal.manage` | A,G | — | n/a (cópia local de requireProfile: os 11 chamadores viram integrations.card_terminal.manage na fatia e) |
| payment-terminals.ts:82 | servico-ator | `PUBLICA` | — | agente_local | igual (pública) |
| storefront.ts:914 | servico-ator | `PUBLICA` | — | cliente_do_portal | igual (pública) |
| Permissions.ts:70 | modulo-morto | `fiscal.view` | A,G,E,T,O,L | — | n/a (módulo morto fiscal: nenhuma rota chama requirePermission(fiscal.*); não semear) |
| Permissions.ts:79 | modulo-morto | `crm.view` | A,G,E,L,T | — | n/a (módulo morto crm: nenhuma rota chama requirePermission(crm.*); não semear) |
| Permissions.ts:82 | modulo-morto | `reports.bi.view` | A,G,L,O | — | n/a (módulo morto corporate-bi: nenhuma rota chama requirePermission(corporate-bi.*); não semear) |
| IdentityService.ts:509 | fusao | `group.admin` | A | — | igual por construção: vira listGroupAdmins() = group.admin em todas as ativas (A ∪ G); cada conta entra na empresa nova com o MESMO modelo que tem nas outras (desenho §8 #9/#10) |
| IdentityService.ts:521 | fusao | `group.admin` | G | — | igual por construção (ver IdentityService.ts:509) |
| IdentityService.ts:677 | fusao | `group.admin` | A | — | igual por construção: ADMIN entra como admin_geral, como hoje |
| IdentityService.ts:686 | fusao | `group.admin` | G | — | igual por construção: CARLOSGERENTE entra como gestor, como hoje |
| IdentityService.ts:724 | alvo | Aplicar o modelo do primeiro gerente: users.manage + assignable_by do modelo (§9.1); só quem tem group.companies.manage chega aqui | A,G | A,G | igual |
| RecuperacaoDeSenhaDaEquipe.ts:204 | alvo | Conta de dono = algum vínculo com modelo assignable_by=grupo (ou modelo inexistente). Essa conta não recupera por e-mail. | L,O,M,T,E,C,CL,CO | L,O,E,T,C,CL,CO,M | igual |
| TeamService.ts:85 | alvo-formulario | Bancada obrigatória = o modelo tem capability de escopo bancada e default_workshops=membro, ou o vínculo escolheu all_workshops=0 (400 CORE_WORKSHOP_SCOPE_REQUIRED). | A,G,M,O,CO | M | muda (D11) |
| TeamService.ts:161 | alvo | Equipe da oficina = workshop.orders.move e modelo não assignable_by=grupo | M,O,CO | O,CO,M | igual |
| TeamService.ts:406 | alvo-formulario | idem TeamService.ts:85 (criação) | A,G,L,O | M | muda (D11) |
| TeamService.ts:560 | alvo-formulario | idem (troca de modelo) | A,G,L,O | M | muda (D11) |
| TeamService.ts:576 | alvo-formulario | idem (troca de bancadas) | A,G,L,O | M | muda (D11) |
| TeamService.ts:842 | alvo-formulario | idem (vínculo de conta existente) | A,G,L,O | M | muda (D11) |
| AuthorizationService.ts:135 | alvo | "Quem libera aqui": do grupo = group.admin; da operação = algum approval.* e não group.admin | L,O | L,O | igual |
| WorkshopPartsService.ts:162 `POST /core/workshop/orders/:orderId/parts/:partId/return` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| WorkshopIntakeService.ts:42 | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| WorkshopIntakeService.ts:44 | escopo-bancada/entrada | BALCAO_DA_OFICINA = open e não assume e não admin | T,CO | T,CO | igual |
| WorkshopIntakeService.ts:65 | escopo-bancada/entrada | idem core.ts:7397 (GESTAO_DA_OFICINA ∪ BALCAO_DA_OFICINA viram capability) | A,G,O,T,CO | A,G,O,T,CO | igual |
| WorkshopIntakeService.ts:73 | escopo-bancada/entrada | Técnico (assume e não admin) abre só nas bancadas do vínculo | M | M | igual |
| EquipmentService.ts:171 | alvo | Montador = o vínculo do ALVO nesta empresa tem workshop.orders.assume e o modelo dele não é assignable_by=grupo | M,O | O,M | igual |
| ProntidaoDasComunicacoes.ts:208 | alvo | Item "acesso do contador": vê o fechamento e não opera a empresa (accounting.closing.view e não dashboard.view) | K | K | igual |
| implantacaoPorEmpresa.ts:297 | alvo | Item "gerente": users.manage e modelo não assignable_by=grupo | L,O | L,O | igual |
| implantacaoPorEmpresa.ts:321 | alvo | Item "caixa": pdv.device_login e modelo não assignable_by=grupo | C,CL,CO | C,CL,CO | igual |
| WorkshopCoreService.ts:596 `POST /core/workshop/orders/:id/comments` | voz | Só a voz de técnico toma a trava da OS alheia | A,G,O,T,CO | A,G,O,T,CO | igual |
| WorkshopCoreService.ts:678 | trava-sem-bypass | Sem exceção de gestor. NÃO traduzir para workshop.admin. | — | — | igual |
| WorkshopCoreService.ts:792 `POST /core/workshop/orders/:id/move` | escopo-bancada | bancadasDoVinculo (§3.1); todas = workshop.admin | A,G,O | A,G,O | igual |
| WorkshopCoreService.ts:1086 `POST /core/workshop/orders/:id/parts` | trava-sem-bypass | Sem exceção de gestor (o isManager só escolhe o rótulo). NÃO traduzir para workshop.admin. | — | — | igual |
| WorkshopCoreService.ts:1582 `POST /core/workshop/orders/:id/labor` | trava-sem-bypass | idem addPart | — | — | igual |
| WorkshopCoreService.ts:1644 | trava-sem-bypass | Só o técnico responsável conclui | — | — | igual |

## 4. Tela (menu, rotas do navegador e botões)

São 308 pontos de tela. Veredito: igual 239 · muda (D4) 2 · muda (D6) 47 · igual (pública) 16 · n/a 3 · muda (D11) 1. O servidor é a fonte da verdade: toda diferença da tela abaixo é a tela passando a dizer o que o servidor já responde (D6), ou a porta que batia na cara fechando (D4/D6). O detalhe por página está em `conflitos.md` §3.

| modelo | páginas/itens que aparecem | páginas/itens que somem |
|---|---|---|
| `admin_geral` | — | — |
| `gestor` | — | — |
| `gerente_loja` | — | — |
| `gerente_oficina` | /sistema/produtos (ProdutosPage) | /sistema/integracoes/asaas |
| `estoquista` | — | /pdv, /sistema/financeiro/cadastros, /sistema/integracoes, /sistema/integracoes/asaas, (grupo/pendente) Fiscal (grupo) |
| `atendente` | — | /sistema/produtos/prontidao-online, /sistema/produtos/novo, /sistema/financeiro/cadastros, /sistema/compras/entrada-notas, /sistema/compras/nfe-email, /sistema/compras/fornecedores, /sistema/compras/transportadoras, /sistema/compras/configuracao, /sistema/compras/pedidos, /sistema/integracoes, /sistema/integracoes/asaas, (grupo/pendente) Compras (grupo), (grupo/pendente) Fiscal (grupo) |
| `operador_caixa` | /sistema/fiscal/documentos, /sistema/oficina, /sistema/oficina/os/:id, /sistema/equipamentos, /sistema/equipamentos/:id, (grupo/pendente) Vendas (grupo), /sistema/caixa, /pdv, (grupo/pendente) Oficina (grupo), (grupo/pendente) Fiscal (grupo) | — |
| `operador_caixa_loja` | /sistema/fiscal/documentos, /sistema/oficina, /sistema/oficina/os/:id, /sistema/equipamentos, /sistema/equipamentos/:id, /sistema/crm/leads, /sistema/crm/fidelidade, /sistema/locacao/contratos, (grupo/pendente) Vendas (grupo), /sistema/caixa, /pdv, (grupo/pendente) Oficina (grupo), (grupo/pendente) Fiscal (grupo), (grupo/pendente) CRM (grupo), (grupo/pendente) Locação (grupo) | — |
| `operador_caixa_oficina` | /sistema/fiscal/documentos, /sistema/oficina, /sistema/oficina/os/:id, /sistema/equipamentos, /sistema/equipamentos/plaquinhas, /sistema/equipamentos/:id, (grupo/pendente) Vendas (grupo), /sistema/caixa, /pdv, (grupo/pendente) Oficina (grupo), (grupo/pendente) Fiscal (grupo) | — |
| `mecanico` | — | — |
| `contador` | — | — |

## 5. Cenários A–J (fixtures de teste)

Cada cenário é um conjunto de vínculos `{empresa, modelo, grants, revokes, terminais, bancadas}`. As empresas são as seis do seed (`server/src/db/seed.ts:53-58`). "terminais: todos" = `all_terminals=1` (na empresa com 0 caixas é o "PDV único"); para a variante com caixas, a fixture troca por `[<caixa-1>]` e acrescenta o caso 403 do caixa fora do escopo (T6). `<bancada-1>` é criada pela própria fixture. O JSON completo, com a lista de capabilities por empresa, está em `modelos.json` → `cenarios`.

| cenário | vínculos | capabilities por vínculo | casa | rotas que passam | sondas 2xx | sondas 403 (API direta) |
|---|---|---|---|---|---|---|
| **A** Só o PDV da Preço Justo | preco-justo: `somente_pdv` | 8 | /pdv | 93 | 8 | 17 |
| **B** PDV Preço Justo + PDV Gringa, sem gestor | preco-justo: `somente_pdv`<br>gringa: `somente_pdv` | 8 | /pdv | 93 | 8 | 17 |
| **C** Todos os PDVs, sem administração | preco-justo: `somente_pdv`<br>gringa: `somente_pdv`<br>me-mimei: `somente_pdv`<br>conceito: `somente_pdv`<br>pj-motors: `somente_pdv`<br>oficina: `somente_pdv` +1 grant(s) · bancadas todas | 8 / 9 | /pdv | 93 / 96 | 8 | 17 |
| **D** Todos os PDVs + página principal do gestor, sem Fiscal/Usuários/Configuração | preco-justo: `pdv_painel`<br>gringa: `pdv_painel`<br>me-mimei: `pdv_painel`<br>conceito: `pdv_painel`<br>pj-motors: `pdv_painel`<br>oficina: `pdv_painel` +1 grant(s) · bancadas todas | 9 / 10 | /sistema/painel | 95 / 98 | 9 | 16 |
| **E** Só Gestor → Estoque | preco-justo: `estoque` | 5 | /sistema/estoque | 40 | 2 | 23 |
| **F** Gestor → Financeiro + Relatórios | preco-justo: `financeiro_relatorios` | 8 | /sistema/financeiro | 59 | 4 | 21 |
| **G** Só Oficina → Kanban/OS (técnico) | oficina: `tecnico_oficina` · bancadas <bancada-1> | 10 | /sistema/oficina | 39 | 3 | 22 |
| **H** Oficina Kanban + PDV Oficina | oficina: `operador_caixa_oficina` +5 grant(s) · bancadas <bancada-1> | 26 | /pdv | 155 | 14 | 11 |
| **I** Gerente da Preço Justo (PDV, estoque, vendas, financeiro), sem as outras empresas | preco-justo: `gerente_operacao_loja` | 29 | /sistema/painel | 184 | 14 | 11 |
| **J** Administrador do grupo (todas as empresas, todos os módulos) | preco-justo: `admin_geral`<br>gringa: `admin_geral`<br>me-mimei: `admin_geral`<br>conceito: `admin_geral`<br>pj-motors: `admin_geral`<br>oficina: `admin_geral` | 141 | /sistema/painel | 606 | 25 | 0 |

Sondas (as mesmas 25 rotas para todo cenário; a fixture cobra 2xx/403 exatamente como abaixo, no primeiro vínculo do cenário):

- **A** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `GET /core/fiscal/documents`. 403 → `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): gringa, me-mimei, conceito, pj-motors, oficina.
- **B** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `GET /core/fiscal/documents`. 403 → `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): me-mimei, conceito, pj-motors, oficina.
- **C** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `GET /core/fiscal/documents`. 403 → `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): nenhuma.
- **D** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `GET /core/dashboard`, `GET /core/fiscal/documents`. 403 → `POST /core/quotes/:id/cancel`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): nenhuma.
- **E** (preco-justo): 2xx → `GET /core/stock`, `POST /core/stock/movements`. 403 → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/fiscal/documents`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): gringa, me-mimei, conceito, pj-motors, oficina.
- **F** (preco-justo): 2xx → `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`. 403 → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `PATCH /core/fiscal/config`, `GET /core/fiscal/documents`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): gringa, me-mimei, conceito, pj-motors, oficina.
- **G** (oficina): 2xx → `GET /core/customers`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`. 403 → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/fiscal/documents`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): preco-justo, gringa, me-mimei, conceito, pj-motors.
- **H** (oficina): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `POST /core/stock/movements`, `GET /core/fiscal/documents`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`. 403 → `GET /core/dashboard`, `GET /core/stock`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): preco-justo, gringa, me-mimei, conceito, pj-motors.
- **I** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/fiscal/documents`. 403 → `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): gringa, me-mimei, conceito, pj-motors, oficina.
- **J** (preco-justo): 2xx → `POST /core/sales`, `POST /core/cash/open`, `POST /core/pdv/terminal/charge`, `POST /core/fiscal/sales/:saleId/emit`, `GET /core/products/search`, `GET /core/customers`, `GET /core/sales`, `POST /core/quotes/:id/cancel`, `GET /core/dashboard`, `GET /core/stock`, `POST /core/stock/movements`, `GET /core/finance/entries`, `GET /core/finance/cash-flow`, `GET /core/reports`, `GET /core/insights/operations`, `PATCH /core/fiscal/config`, `GET /core/fiscal/documents`, `GET /core/team`, `GET /core/audit`, `GET /core/workshop/orders`, `POST /core/workshop/orders/:id/assume`, `GET /core/workshop/pending-payment`, `POST /core/workshop/orders/:id/checkout`, `POST /core/companies`, `POST /auth/device/enroll`. 403 → —. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): nenhuma.

Capabilities de cada cenário (primeiro vínculo; os demais vínculos do mesmo cenário usam o mesmo modelo, e a Oficina de C/D acrescenta `workshop.checkout`):

- **A**: `customers.contact.view`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `pdv.cash.operate`, `pdv.device_login`, `pdv.payment.charge`, `pdv.sell` · terminais: todos.
- **B**: `customers.contact.view`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `pdv.cash.operate`, `pdv.device_login`, `pdv.payment.charge`, `pdv.sell` · terminais: todos.
- **C**: `customers.contact.view`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `pdv.cash.operate`, `pdv.device_login`, `pdv.payment.charge`, `pdv.sell` · terminais: todos.
- **D**: `customers.contact.view`, `dashboard.view`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `pdv.cash.operate`, `pdv.device_login`, `pdv.payment.charge`, `pdv.sell` · terminais: todos.
- **E**: `inventory.adjust.approve`, `inventory.manage`, `inventory.units.manage`, `inventory.units.view`, `inventory.view` · terminais: todos.
- **F**: `finance.acquirers.manage`, `finance.advanced.view`, `finance.bank_reconciliation.manage`, `finance.commissions.manage`, `finance.manage`, `finance.view`, `reports.bi.view`, `reports.central.view` · terminais: todos.
- **G**: `workshop.equipment.view`, `workshop.kanban.view`, `workshop.labor.manage`, `workshop.orders.assume`, `workshop.orders.complete`, `workshop.orders.move`, `workshop.orders.open`, `workshop.orders.plan`, `workshop.parts.use`, `workshop.quote.request` · bancadas: <bancada-1> · terminais: todos.
- **H**: `customers.contact.view`, `customers.manage`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `pdv.backoffice`, `pdv.cash.operate`, `pdv.device_login`, `pdv.payment.charge`, `pdv.sell`, `sales.consignment.close`, `sales.consignment.manage`, `sales.quotes.cancel`, `sales.quotes.manage`, `workshop.checkout`, `workshop.equipment.label`, `workshop.equipment.view`, `workshop.kanban.view`, `workshop.labor.manage`, `workshop.orders.assume`, `workshop.orders.complete`, `workshop.orders.move`, `workshop.orders.open`, `workshop.orders.plan`, `workshop.parts.use`, `workshop.tags.view` · bancadas: <bancada-1> · terminais: todos.
- **I**: `approval.cash_reopen`, `approval.cash_withdrawal`, `approval.discount`, `approval.sale_cancel`, `approval.sale_return`, `customers.contact.view`, `dashboard.money.view`, `dashboard.view`, `finance.advanced.view`, `finance.manage`, `finance.view`, `fiscal.sale.emit`, `integrations.card_terminal.operate`, `integrations.card_terminal.view`, `inventory.adjust.approve`, `inventory.cost.view`, `inventory.manage`, `inventory.view`, `pdv.cash.operate`, `pdv.payment.charge`, `pdv.sell`, `pdv.supervise`, `products.view`, `sales.cancel.direct`, `sales.quotes.cancel`, `sales.quotes.manage`, `sales.returns.operate`, `sales.supervise`, `sales.view` · terminais: todos.
- **J**: catálogo inteiro (full_catalog) · bancadas: todas · terminais: todos.

Observações que as fixtures têm de cobrir:

- **A/B/C** usam o mesmo modelo "Somente PDV"; B e C diferem só no número de vínculos. A troca de empresa (`POST /auth/switch-company`) só aceita as empresas do vínculo (`auth.ts:895-932`), e a sessão fica numa empresa por vez.
- **D** é "Somente PDV" + `dashboard.view`. O painel sai sem dinheiro (`dashboard.money.view` fora), salvo a política de gestão da empresa ligar (`PoliticaDeGestaoService.ts:159-171`). `fiscal.sale.emit` é a nota DA VENDA, parte do PDV, não o Fiscal do escritório; a página `/sistema/fiscal/documentos` abre para quem tem `fiscal.sale.emit` (D6) — se o dono quiser D sem essa página, a fixture revoga `fiscal.sale.emit` e o PDV deixa de emitir (ver dúvida no relatório).
- **G** exige a lista de bancadas (`default_workshops = membro`); sem bancada, 400 `CORE_WORKSHOP_SCOPE_REQUIRED`. **H** também, porque os 5 grants são de escopo bancada.
- **E** carrega GET /core/stock (`inventory.view`, core.ts:2831) e as subpáginas de movimentações, locais, validade, inventário e unidades (tela-rotas-menu, gsRoutes.tsx:239, 525, 601, 602, 615, 616), todas dentro do modelo "Estoque". O modelo não tem `products.view`: se o formulário de movimentar buscar produto fora de GET /core/stock, a T4 acusa e o modelo ganha `products.view` (dúvida ao dono). A importação por planilha (`products.manage`) fica fora de E de propósito.
- **I** usa `gerente_operacao_loja`, nunca `gestor` (o código `gestor` é o par do administrador, desenho §3.1).
- **J** tem `group.admin` em todas as ativas: é o que define "administrador do grupo" (`listGroupAdmins`), e o invariante `CORE_LAST_GROUP_ADMIN` (desenho §9.4) tem de valer.
