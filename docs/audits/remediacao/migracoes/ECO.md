# Migrações da frente ECO (e-commerce, conta do cliente, checkout)

Regra da remediação (REGRAS.md, seção 5): nenhum passo numerado, nenhuma
mudança em `CORE_TARGET_VERSION`. Colunas novas entram anuláveis na DDL
canônica de `server/src/db/schema.ts` e o `reconcileCoreSchema` as acrescenta
em banco existente. Índice sobre coluna nova de tabela existente e correção de
dado ficam descritos aqui, para o integrador montar o passo de consolidação.

---

## Lote E1 — GAP-PRD-006, 043, 028, 133, 205

### Colunas novas (já na DDL canônica; o boot acrescenta sozinho)

| Tabela | Coluna | Tipo | Nulo significa | Quem usa |
| --- | --- | --- | --- | --- |
| `core_customers` | `origin` | TEXT | anterior à regra / caminho automático — **não** é prova de documento | `CatalogService.createCustomer` grava `'balcao'`; o checkout grava `'loja_online'`; `CustomerPortalService.syncLinks` só propaga documento de cadastro `'balcao'` ou de vínculo de convite (GAP-PRD-006) |
| `core_orders` | `customer_account_id` | TEXT (sem REFERENCES, de propósito: coluna acrescentada por ALTER não ganha FK, e a DDL fica igual nos dois caminhos) | pedido de visitante ou anterior à regra | `StorefrontService.checkout` (com conta); `CustomerPortalService.filtroDoDono` (lista, detalhe e cancelamento pelo portal) |
| `core_customer_accounts` | `name`, `phone`, `document` | TEXT | conta anterior à regra | perfil do portal (GAP-PRD-133/205) e regra de cadastro completo do checkout (GAP-PRD-028) |
| `core_customer_account_links` | `proof` | TEXT (`convite`, `coprova`, `email`, `checkout`, `documento`) | vínculo anterior à regra — tratado como NÃO confiável para propagar documento (nunca é desfeito) | `syncLinks`, `registerWithInvite`, `resgatarConvite`, `cadastroDaConta` |
| `core_storefront_settings` | `checkout_mode` | TEXT (`conta`, `visitante`) | `conta` — o padrão seguro: comprar exige conta | `CheckoutIdentityService.politicaDoCheckout`; tela "Quem pode comprar" |

### Índices para o passo de consolidação (NÃO criar no boot)

Todos sobre coluna nova ou expressão de tabela existente. Sem eles o sistema
funciona (as tabelas são pequenas hoje); com eles, "Meus pedidos" e o login do
portal não varrem a tabela inteira quando o volume crescer.

```sql
-- "Meus pedidos" lê por conta em toda abertura (filtroDoDono).
CREATE INDEX IF NOT EXISTS ix_orders_account
  ON core_orders (customer_account_id, created_at);

-- O pedido de visitante é da conta que PROVOU o e-mail digitado nele
-- (filtroDoDono compara LOWER(TRIM(customer_email))). Índice de expressão:
-- o SQLite só o usa se a expressão da consulta for idêntica a esta.
CREATE INDEX IF NOT EXISTS ix_orders_customer_email_norm
  ON core_orders (LOWER(TRIM(customer_email)));

-- Co-prova e ramo do e-mail do syncLinks, e o passo 3 do cadastroDaConta.
CREATE INDEX IF NOT EXISTS ix_customers_email_norm
  ON core_customers (LOWER(TRIM(email)));
```

### Correção de dado — marcar a origem dos cadastros legados (opcional, decidir na consolidação)

Cadastros criados antes da coluna ficam com `origin` nulo, e nulo é tratado
como **não confiável** para propagar documento entre operações. O efeito
conservador: o dono de um cadastro de balcão ANTIGO, sem e-mail, só é
alcançado pela conta via convite do balcão (o caminho que já existe), e não
mais pela co-prova de um cadastro legado. Para devolver a propagação aos
cadastros legados que nasceram no balcão, sem devolvê-la aos que o checkout
público criou:

```sql
-- 1. Nasceu no balcão: tem venda de balcão, orçamento, OS, consignação ou
--    locação — e NUNCA teve pedido da loja online. (Dono de equipamento NÃO
--    entra: o espelho do equipamento vendido online cria cadastro sozinho.)
UPDATE core_customers SET origin = 'balcao'
 WHERE origin IS NULL
   AND id NOT IN (SELECT customer_id FROM core_orders WHERE customer_id IS NOT NULL)
   AND (   id IN (SELECT customer_id FROM core_sales WHERE customer_id IS NOT NULL)
        OR id IN (SELECT customer_id FROM core_quotes WHERE customer_id IS NOT NULL)
        OR id IN (SELECT customer_id FROM core_service_orders WHERE customer_id IS NOT NULL)
        OR id IN (SELECT customer_id FROM core_consignments WHERE customer_id IS NOT NULL)
        OR id IN (SELECT customer_id FROM core_rental_contracts WHERE customer_id IS NOT NULL));

-- 2. Nasceu no checkout público: tem pedido da loja e nenhuma movimentação
--    de balcão. Marcar deixa explícito o que o nulo já trata como não prova.
UPDATE core_customers SET origin = 'loja_online'
 WHERE origin IS NULL
   AND id IN (SELECT customer_id FROM core_orders WHERE customer_id IS NOT NULL)
   AND id NOT IN (SELECT customer_id FROM core_sales WHERE customer_id IS NOT NULL);
```

O restante (cadastro sem movimento nenhum, ou com os dois tipos) fica nulo —
não há como afirmar quem escreveu o documento, e nulo é o lado seguro.

### O que NÃO precisa de migração

- **Vínculos e contas legados**: a auditoria mediu o banco operacional com
  0 contas, 0 vínculos e 0 sessões do portal (seção Y). Não há vínculo
  fabricado a desfazer.
- **Pedidos legados sem `customer_account_id`**: aparecem na conta que provar
  o e-mail digitado neles (`filtroDoDono`); pedido legado sem e-mail não
  aparece em conta nenhuma — não há prova de quem o fez. (O banco operacional
  tem 3 pedidos, 2 deles sem cliente, e 0 contas.)
- **Cadastro cujo e-mail foi reescrito por um checkout alheio antes desta
  correção**: o `UPDATE` antigo não deixava rastro, então o dado não distingue
  e-mail legítimo de e-mail trocado. O caminho de correção já existe: o balcão
  edita o cadastro (`PUT /core/customers/:id`, que registra `customer.update`
  na trilha), e a partir de agora nenhum caminho público reescreve o contato
  de um cadastro.

---

## Lote E2 — GAP-PRD-027 (Entrar com Google)

### Tabelas novas (já na DDL canônica; o `ensureCoreSchema` cria em banco existente)

| Tabela | O que guarda | Observação |
| --- | --- | --- |
| `core_portal_google_login` | A configuração da INSTALAÇÃO (linha única `id = 'google'`): ligado, modo (`google`/`teste`), Client ID, segredo do cliente OAuth **selado** (`secret_cipher`, AES-256-GCM do cofre) e dica, redirect URI, quem alterou | `company_id` fica sempre nulo — existe para o inventário do cofre (`secretsInventory.LUGARES`, tipo `google_oauth_client_secret`), que a rotação de chave reescreve junto com os outros |
| `core_portal_google_states` | O pedido de autorização em voo: impressão (SHA-256) do `state` e da chave do navegador, nonce, verificador PKCE (apagado no uso), intenção, prazo, uso único; e a identidade já verificada esperando o aceite dos termos (ticket) | Descartável: cada início apaga as linhas com mais de 24 h. Índices `ix_portal_google_states_ticket` e `ix_portal_google_states_created` na própria DDL (tabela nova) |
| `core_customer_identities` | A identidade Google ligada à conta: `(issuer, subject)` único, uma por conta (`UNIQUE (account_id, provider)`), e-mail provado no último login | Nenhum token do Google (acesso/atualização/id_token) é guardado |

### Coluna nova em tabela existente (o `reconcileCoreSchema` acrescenta)

| Tabela | Coluna | Tipo | Valor nas linhas existentes | Quem usa |
| --- | --- | --- | --- | --- |
| `core_customer_accounts` | `has_password` | `INTEGER NOT NULL DEFAULT 1` | 1 — toda conta anterior nasceu com senha | `loginCustomer` (conta sem senha recebe a mesma resposta de credencial inválida), `changePassword` (409 `PORTAL_CONTA_SEM_SENHA`), `redefinirSenhaComToken` (dá a primeira senha: volta a 1), `getProfile.hasPassword`, `GoogleLoginService` |

### `password_hash` continua NOT NULL — de propósito

A ficha sugeria "password_hash nulo + provider". Trocar a constraint exige
reconstruir `core_customer_accounts` (tabela apontada por oito filhas, quase todas com
`ON DELETE CASCADE`), e isso não pode ir no boot. A conta criada pelo Google
grava em `password_hash` o marcador `!sem-senha:entra-pelo-google`
(`GoogleLoginService.SEM_SENHA`), que não é Argon2 (`$argon2…`) nem SHA-256
hexadecimal — `verifyPassword` nunca o aceita — e `has_password = 0` diz a
mesma coisa em coluna própria. O comportamento é idêntico ao do nulo, sem
reconstrução. **Nenhum passo de consolidação é necessário.** Se o integrador
quiser mesmo o nulo semântico, o SQL seria:

```sql
-- OPCIONAL, não recomendado agora: reconstrução com FKs desligadas.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE core_customer_accounts_nova (... mesma DDL, com password_hash TEXT ...);
INSERT INTO core_customer_accounts_nova SELECT * FROM core_customer_accounts;
UPDATE core_customer_accounts_nova SET password_hash = NULL WHERE has_password = 0;
DROP TABLE core_customer_accounts;
ALTER TABLE core_customer_accounts_nova RENAME TO core_customer_accounts;
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys = ON;
```

(e trocar as leituras de `password_hash` para tratar nulo — hoje nenhuma
precisa, porque o marcador nunca confere).

### Índices para o passo de consolidação

Nenhum. `has_password` não é filtro de consulta (é lido junto da linha já
achada pelo e-mail/id), e as tabelas novas trazem os seus índices na DDL.

### Correção de dado

Nenhuma. O banco operacional tem 0 contas do portal (auditoria, seção Y):
não há conta a marcar como "sem senha" nem identidade a importar.

---

## Lote E3 — GAP-PRD-115, 191, 192, 116, 193

### Tabelas novas (já na DDL canônica; o `ensureCoreSchema` cria em banco existente)

| Tabela | O que guarda | Observação |
| --- | --- | --- |
| `core_portal_limites` | Uma linha por passagem pelas portas públicas do portal que têm teto: `acao` (`cadastro`, `recuperacao`), `chave` = SHA-256 de (ação + origem), `created_at` | GAP-PRD-192/116. O IP cru NÃO é guardado. Cada uso apaga as linhas com mais de 24 h. Índices `ix_portal_limites_chave (acao, chave, created_at)` e `ix_portal_limites_created (created_at)` na própria DDL (tabela nova) |
| `core_customer_cart_items` | O carrinho da conta: `(account_id, product_id)` chave primária, `quantity`, `added_at`, `updated_at` | GAP-PRD-193. Só produto e quantidade — nunca preço (lido da vitrine a cada leitura). FKs para a conta e o produto com `ON DELETE CASCADE` |

### Colunas novas em tabela existente (o `reconcileCoreSchema` acrescenta; todas anuláveis)

| Tabela | Coluna(s) | Nulo significa | Quem usa |
| --- | --- | --- | --- |
| `core_customer_addresses` | `kind` (`entrega`, `faturamento`, `ambos` — sem CHECK de propósito: o ALTER não levaria a constraint; o serviço valida) | endereço anterior à regra: vale `ambos` se tem IBGE, senão `entrega` (`CustomerAccountService.tipoDoEndereco`) | GAP-PRD-115: faturar exige IBGE; o checkout confere o tipo de cada uso |
| `core_customer_addresses` | `recipient_name` | quem recebe é o nome da conta | GAP-PRD-115 |
| `core_orders` | `shipping_address_id`, `shipping_recipient_name`, `shipping_street`, `shipping_number`, `shipping_complement`, `shipping_district`, `shipping_city`, `shipping_state`, `shipping_city_ibge` | pedido de visitante (endereço em texto), retirada, ou anterior à regra | GAP-PRD-115: o RETRATO da entrega no momento da compra; detalhe do pedido no portal |
| `core_orders` | `billing_address_id`, `billing_name`, `billing_zip`, `billing_street`, `billing_number`, `billing_complement`, `billing_district`, `billing_city`, `billing_state`, `billing_city_ibge` | sem endereço de faturamento na compra, ou anterior à regra | GAP-PRD-115: `OrderInvoiceService.recipientForOrder` lê este retrato antes do caminho antigo (endereço vivo da conta pelo CEP) |

`*_address_id` não tem REFERENCES de propósito: o endereço pode ser apagado e
o retrato fica (é para isso que ele existe).

### Índices para o passo de consolidação

Nenhum necessário. As colunas novas de `core_orders` são lidas junto da
linha do pedido já achada pelo id; `core_customer_addresses.kind` é filtrado
em memória sobre os poucos endereços de UMA conta (já indexados por
`account_id`). A contagem de links de recuperação por conta usa o índice que
já existe (`ix_customer_pw_resets_account`).

### Correção de dado (opcional — o código já trata o nulo)

```sql
-- Declarar o tipo dos endereços anteriores ao GAP-PRD-115, pelo mesmo
-- critério que o código aplica ao nulo. Sem efeito de comportamento; só
-- deixa a coluna explícita para relatório.
UPDATE core_customer_addresses
   SET kind = CASE WHEN city_ibge IS NOT NULL AND TRIM(city_ibge) <> '' THEN 'ambos' ELSE 'entrega' END
 WHERE kind IS NULL;
```

Endereço legado com IBGE de outra UF (a validação nova recusaria) não é
corrigido por SQL — não há como saber qual dos dois campos está certo; a
pessoa corrige pelo "Editar" da conta (o PUT novo), e a nota dos pedidos
novos já lê o retrato.

### O que NÃO precisa de migração

- **Pedidos antigos sem retrato**: `recipientForOrder` cai no caminho
  anterior (endereço da conta pelo CEP do pedido). Retroencher o retrato a
  partir do endereço VIVO repetiria o defeito que o retrato existe para
  evitar; o banco operacional tem 3 pedidos e 0 contas (auditoria, seção Y).
- **Sessões abertas**: continuam com o `expires_at` que têm; o deslize vale a
  partir do próximo uso, e o teto de 24 h usa o `created_at` que já existe.
- **Carrinhos**: não há carrinho a importar — o de cada navegador se funde na
  conta no próximo login (`POST /loja/portal/carrinho/mesclar`).

---

## Lote E4 — GAP-PRD-121, 122, 031, 124, 125, 132

### Colunas novas em tabela existente (o `reconcileCoreSchema` acrescenta; anuláveis)

| Tabela | Coluna | Nulo significa | Quem usa |
| --- | --- | --- | --- |
| `core_orders` | `return_goods_status` (`aguardando`, `recebida`; sem CHECK de propósito — o ALTER não levaria a constraint, o serviço valida) | nada a conferir: pedido não reembolsado, ou reembolsado antes da regra | GAP-PRD-122: `markOrderRefunded` deixa `aguardando` quando o pedido chegou a baixar estoque; `OrderReturnService.receberMercadoriaDevolvida` (POST `/core/orders/:id/devolucao/receber`) passa a `recebida` e devolve ao estoque só o que foi conferido |
| `core_orders` | `return_goods_at` | a mercadoria ainda não foi conferida (ou não há o que conferir) | GAP-PRD-122: a hora do recebimento conferido |

### Tabela nova (já na DDL canônica; o `ensureCoreSchema` cria em banco existente)

| Tabela | O que guarda | Observação |
| --- | --- | --- |
| `core_order_return_requests` | O pedido de devolução que a cliente abre no portal (GAP-PRD-125): tipo (`arrependimento`, `defeito`), relato, situação (`aberta`, `aprovada`, `recusada`, `concluida`), a decisão da loja (nota, quem, quando) | `account_id` sem REFERENCES de propósito (a conta pode ser apagada pela LGPD e a solicitação continua fato do pedido). Índices `ix_order_return_requests_order (order_id, created_at)` e `ix_order_return_requests_company (company_id, status, created_at)` na própria DDL (tabela nova) |

### Origem nova em `core_finance_entries` (sem mudança de esquema)

`origin_type = 'ecommerce_order_refund'` (GAP-PRD-031), escrita por
`OrderRefundLedger`: a saída do dinheiro que volta ao cliente do pedido online,
categoria de sistema `devolucao`, `origin_id` = o pedido. Uma por pedido pela
UNIQUE que já existe (`origin_type, origin_id, direction, installment_number`).
Rótulo "Reembolso do pedido online #N" em `FinanceService.ORIGEM_LEGIVEL_SQL`
e link para a ficha do pedido em `src/lib/rotasDeOrigem.ts`.

### Índice para o passo de consolidação (OPCIONAL)

Os relatórios de venda, o BI e o painel passaram a ler os pedidos pagos no
período (GAP-PRD-132) por `company_id` e pelo dia de `paid_at`. `paid_at` NÃO
é coluna nova, mas o índice é deixado ao integrador pela mesma cautela: sem
ele tudo funciona (a tabela é pequena — o banco operacional tem 3 pedidos);
com ele, o relatório do mês não varre a tabela inteira quando o volume crescer.

```sql
CREATE INDEX IF NOT EXISTS ix_orders_company_paid ON core_orders (company_id, paid_at);
```

### Correção de dado (opcional — o código já trata o nulo)

Pedido reembolsado ANTES desta regra: o `refundOrder` antigo devolvia o
estoque de todo pedido e não lançava contrapartida. O nulo em
`return_goods_status` já é tratado como "nada a conferir" (não aparece o
recebimento). Para deixar explícito o que o estoque antigo já fez:

```sql
-- O estoque do reembolso antigo JÁ voltou (movimento SALE_RETURN do pedido):
-- marcar como recebida, com a hora do movimento.
UPDATE core_orders
   SET return_goods_status = 'recebida',
       return_goods_at = (SELECT MIN(m.created_at) FROM core_stock_movements m
                           WHERE m.reference_type = 'ecommerce_order_refund'
                             AND m.reference_id = core_orders.id)
 WHERE status = 'reembolsado' AND return_goods_status IS NULL
   AND EXISTS (SELECT 1 FROM core_stock_movements m
                WHERE m.reference_type = 'ecommerce_order_refund'
                  AND m.reference_id = core_orders.id);
```

A CONTRAPARTIDA FINANCEIRA de reembolso antigo NÃO é retroencheida por SQL:
lançar agora uma saída com competência de hoje (ou de meses fechados) é
decisão de quem fecha o mês. O caminho existe: lançamento manual de saída em
Contas, ou o aviso de estorno do provedor, que para pedido já reembolsado
lança a saída quitada (`markOrderRefunded` com `devolvido_pelo_provedor`).
Para o contador revisar o que ficou sem espelho:

```sql
SELECT o.company_id, o.number, o.total_cents, o.updated_at
  FROM core_orders o
 WHERE o.status = 'reembolsado'
   AND EXISTS (SELECT 1 FROM core_finance_entries e
                WHERE e.origin_type = 'ecommerce_order' AND e.origin_id = o.id
                  AND e.direction = 'in' AND e.cancelled_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM core_finance_entries e
                    WHERE e.origin_type = 'ecommerce_order_refund' AND e.origin_id = o.id);
```

### O que NÃO precisa de migração

- **Pedidos fora de ordem na máquina de estados (GAP-PRD-121)**: a regra vale
  para a PRÓXIMA transição; pedido que já está numa etapa (mesmo alcançada por
  salto antigo) segue dali. Não há estado a corrigir.
- **`core_orders.sale_id` (GAP-PRD-132)**: continua nulo de propósito — o
  pedido não vira `core_sales` (lançaria a receita duas vezes). Os números de
  venda juntam as duas fontes pela régua do DRE.
- **Solicitações de devolução**: não existiam antes; nada a importar.

---

## Lote E5 — GAP-PRD-032, 033, 197, 194, 123 (promoções validadas e cupons)

### Tabelas novas (já na DDL canônica; o `ensureCoreSchema` cria em banco existente)

| Tabela | O que guarda | Observação |
| --- | --- | --- |
| `core_coupons` | O cupom da loja online, de UMA empresa: código (maiúsculas, `UNIQUE (company_id, code)`), percentual OU valor fixo, pedido mínimo, vigência, teto de usos no total e por cliente, se acumula com promoção, encerramento (quem/quando) | GAP-PRD-123. As CHECKs (`percent_off` entre 0 e 100 exclusivos, `amount_cents > 0`, um dos dois e só um) valem nos dois caminhos porque a tabela é nova |
| `core_coupon_redemptions` | Um uso por pedido (`UNIQUE (order_id)`): cupom, conta, e-mail normalizado, desconto, `status` (`ativo` conta no teto; `liberado` = pedido cancelado) | `account_id` sem REFERENCES de propósito (a conta pode ser apagada pela LGPD e o uso continua fato do pedido). Índice `ix_coupon_redemptions_coupon (coupon_id, status)` na própria DDL |

### Colunas novas em tabela existente (o `reconcileCoreSchema` acrescenta)

| Tabela | Coluna | Tipo | Valor nas linhas existentes | Quem usa |
| --- | --- | --- | --- | --- |
| `core_promotions` | `starts_time`, `ends_time` | TEXT | nulo = o dia inteiro (o que toda promoção anterior significa) | GAP-PRD-194: `PricingService.valeNesteHorario`, relógio da loja |
| `core_promotions` | `max_units` | REAL | nulo = sem teto | GAP-PRD-194: estoque promocional, contado por `unidadesUsadasSql` |
| `core_promotions` | `free_confirmed` | `INTEGER NOT NULL DEFAULT 0` | 0 — nenhuma promoção antiga tem o grátis confirmado | GAP-PRD-032: candidato de preço zero só entra na disputa com 1. **Efeito deliberado**: promoção antiga de 100 % (ou preço zero) deixa de dar o produto de graça até alguém recriá-la confirmando |
| `core_promotions` | `updated_at`, `updated_by` | TEXT | nulo = nunca editada | GAP-PRD-194: `PATCH /core/promotions/:id` |
| `core_orders` | `coupon_id`, `coupon_code` | TEXT | nulo = pedido sem cupom | GAP-PRD-123: o retrato do código usado |
| `core_orders` | `discount_cents` | `INTEGER NOT NULL DEFAULT 0` | 0 | GAP-PRD-123: `items_cents` continua = soma de `core_order_items.total_cents` (líquida); bruto = `items_cents + discount_cents` |
| `core_order_items` | `discount_cents` | `INTEGER NOT NULL DEFAULT 0` | 0 | GAP-PRD-123: a parte do cupom da linha; `total_cents` é líquido. `OrderInvoiceService` declara vProd/vDesc por item |
| `core_order_items` | `promotion_id` | TEXT | nulo | GAP-PRD-194: a promoção que deu o preço da linha |
| `core_sale_items` | `promotion_id` | TEXT | nulo | GAP-PRD-194: idem, no balcão (`SalesService` grava). **Toque mínimo no domínio do PDV** |

### Índices para o passo de consolidação (NÃO criar no boot)

Sobre coluna nova de tabela existente. Sem eles tudo funciona: a subconsulta
do consumo só roda para promoção COM teto (`CASE WHEN max_units IS NULL THEN 0`),
e hoje nenhuma tem. Com eles, a vitrine não varre as linhas de venda a cada
preço quando o dono começar a usar o teto.

```sql
-- Consumo do estoque promocional (PricingService.unidadesUsadasSql).
CREATE INDEX IF NOT EXISTS ix_sale_items_promotion  ON core_sale_items  (promotion_id);
CREATE INDEX IF NOT EXISTS ix_order_items_promotion ON core_order_items (promotion_id);
```

### CHECK em `core_promotions` (a ficha do GAP-PRD-032 pede) — reconstrução, só na consolidação

A validação vive no único escritor (`PromotionService`) e o cálculo do preço
ignora o que ela recusaria (negativo, acima de 100 %, grátis não confirmado).
A CHECK é a segunda trava. Trocar constraint no SQLite exige reconstruir a
tabela, e isso não vai no boot. Antes da reconstrução, as linhas que a CHECK
recusaria precisam ser ENCERRADAS (não apagadas: explicam vendas antigas) e
neutralizadas:

```sql
-- 1. Conferir o que existe (o banco operacional não foi medido nesta frente:
--    a leitura foi recusada pela sandbox; é a primeira coisa a rodar).
SELECT id, company_id, product_id, category, price_cents, percent_off, starts_at, ends_at, active
  FROM core_promotions
 WHERE (price_cents IS NOT NULL AND price_cents < 0)
    OR (percent_off IS NOT NULL AND (percent_off <= 0 OR percent_off > 100))
    OR (price_cents IS NOT NULL AND percent_off IS NOT NULL)
    OR (price_cents IS NULL AND percent_off IS NULL)
    OR (ends_at IS NOT NULL AND ends_at < starts_at)
    OR (product_id IS NULL AND category IS NULL);

-- 2. Promoção com produto de OUTRA empresa (GAP-PRD-197) — linha morta.
SELECT pr.id, pr.company_id, pr.product_id
  FROM core_promotions pr
 WHERE pr.product_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM core_products p
                    WHERE p.id = pr.product_id AND p.company_id = pr.company_id);

-- 3. Encerrar as duas famílias acima (a lista da tela já as mostra como
--    "Inválida", com o motivo, e o gerente pode encerrar por lá).
UPDATE core_promotions SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_by = 'consolidacao-eco-e5'
 WHERE active = 1 AND (
       (price_cents IS NOT NULL AND price_cents < 0)
    OR (percent_off IS NOT NULL AND (percent_off <= 0 OR percent_off > 100))
    OR (price_cents IS NOT NULL AND percent_off IS NOT NULL)
    OR (price_cents IS NULL AND percent_off IS NULL)
    OR (ends_at IS NOT NULL AND ends_at < starts_at)
    OR (product_id IS NULL AND category IS NULL)
    OR (product_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM core_products p
           WHERE p.id = core_promotions.product_id AND p.company_id = core_promotions.company_id)));
```

A reconstrução propriamente dita, se o integrador quiser a CHECK (as linhas
encerradas continuam, então a CHECK é sobre os VALORES, não sobre `active`;
linhas legadas com valor fora da regra precisam ter o valor anulado antes —
`price_cents`/`percent_off` inválidos viram o que eram guardados em uma nota,
decisão de quem consolida; a alternativa conservadora é não reconstruir):

```sql
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE core_promotions_nova (
  -- mesma DDL canônica de schema.ts, acrescida de:
  CHECK (price_cents IS NULL OR price_cents >= 0),
  CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
INSERT INTO core_promotions_nova SELECT * FROM core_promotions;
DROP TABLE core_promotions;
ALTER TABLE core_promotions_nova RENAME TO core_promotions;
CREATE INDEX IF NOT EXISTS ix_promotions_lookup ON core_promotions (company_id, product_id, active);
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys = ON;
```

**Recomendação**: não reconstruir agora. O único escritor confere, o preço
ignora o inválido, e a lista mostra o legado com o motivo. A CHECK acrescenta
pouco e a reconstrução é a operação mais arriscada deste documento.

### Correção de dado

- **Promoção de 100 % / preço zero antiga**: `free_confirmed` nasce 0, e o
  preço deixa de ser zero no próximo cálculo. Se o dono REALMENTE dava algum
  produto de graça, recria a promoção confirmando o grátis (a tela pergunta).
  Nenhum SQL de "confirmar em lote" é oferecido: confirmar grátis é decisão
  explícita, não migração.
- **Linhas de venda/pedido antigas** ficam com `promotion_id` nulo: não contam
  no estoque promocional (que não existia). Nada a retroencher.

### O que NÃO precisa de migração

- **Pedidos antigos**: `discount_cents = 0` e `coupon_code` nulo significam
  "sem cupom", que é a verdade de todos eles. `items_cents` já era a soma dos
  itens, e continua.
- **Cupons**: não existiam; nada a importar.

---

## Lote E6 — GAP-PRD-029, 071, 207, 195, 196

### Coluna nova (já na DDL canônica; o boot acrescenta sozinho)

| Tabela | Coluna | Tipo | Nulo significa | Quem usa |
| --- | --- | --- | --- | --- |
| `core_payment_intents` | `due_date` | TEXT (AAAA-MM-DD) | cobrança anterior à regra — vale o D+1 do dia da loja da criação, que é exatamente o que `createOrderCharge` sempre mandou ao provedor | `OrderChargeService.createOrderCharge` grava o vencimento enviado; `PrazoDaReserva` estende a reserva do pedido com boleto vivo até o fim do 2º dia útil depois do último dia de pagamento; a rotina `expirarPedidosNaoPagos` e a tela da loja (`reservedUntil`) leem a mesma conta (GAP-PRD-029) |

### Índice — nenhum

`PrazoDaReserva.cobrancasVivasDoPedido` lê por `(origin_type, origin_id)`, que
já tem `ix_payment_intents_origin`. A rotina de expiração continua filtrando
`core_orders` por `status` e `created_at` como antes.

### Correção de dado — não é necessária (opcional, só para leitura humana)

O nulo já é tratado pela regra (D+1 da criação), então nenhum pedido antigo
fica sem prazo. Se a consolidação quiser a coluna preenchida para consulta
manual, o valor equivalente ao que foi enviado ao provedor é:

```sql
-- Só cobranças de pedido online, só onde falta. O deslocamento de -3 horas é o
-- mesmo de CalendarioOperacional.diaDaLojaSql (Brasil sem horário de verão).
UPDATE core_payment_intents
   SET due_date = date(datetime(created_at, '-3 hours'), '+1 day')
 WHERE origin_type = 'ecommerce_order' AND due_date IS NULL;
```

### O que NÃO precisa de migração

- GAP-PRD-071: o catálogo decorado da vitrine fica em memória (`VitrineCache`,
  por conexão), sem tabela. O teto de 60 itens por página é regra de código.
- GAP-PRD-207: `warnings` da prontidão é calculado na leitura; nenhuma coluna.
- GAP-PRD-195: a validação do prazo vale para a próxima gravação. Loja que já
  tenha `core_shipping_settings.estimated_days` negativo continua sendo lida
  como "sem prazo" (vitrine e portal tratam `<= 0` assim); corrigir é abrir
  "Entrega pelo site" e salvar um prazo válido ou em branco. Para achar essas
  lojas: `SELECT company_id, estimated_days FROM core_shipping_settings WHERE estimated_days < 0;`
- GAP-PRD-196: `deliveryEstimate` é calculado na leitura; a data prometida
  passou a sair como dia de calendário (AAAA-MM-DD) sem nada gravado.
