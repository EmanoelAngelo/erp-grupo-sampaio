-- ============================================================================
-- MIGRATION 002 — Schema central do Grupo Sampaio
--
-- Rodar DEPOIS de 01-landing.sql. Versionada: ver `erp_central_migrations` no
-- fim do arquivo. A versão da central é INDEPENDENTE da versão do SQLite
-- local — são dois bancos com ciclos de vida próprios, e amarrá-los faria uma
-- migração local exigir uma migração remota sem necessidade.
--
-- O QUE ESTE SCHEMA É, E O QUE NÃO É
--
-- Não é uma cópia do SQLite. Das tabelas legadas, a maioria pertence a módulos
-- que nunca foram ligados; replicá-las produziria um banco central cheio de
-- tabelas vazias que ninguém sabe interpretar. Aqui entra só arquitetura viva:
-- o que existe, tem dado e é consultado.
--
-- IDENTIDADE
--
-- Os ids vêm do nó e são PRESERVADOS. O mesmo fato tem a mesma identidade nos
-- dois bancos — é isso que torna a reconciliação possível e o reenvio
-- inofensivo. A central NUNCA gera id para fato sincronizado.
--
-- ORDENAÇÃO
--
-- Toda tabela projetada carrega `occurred_at` e `node_seq`. A rede não entrega
-- em ordem, e um evento antigo chegando depois NÃO pode sobrescrever estado
-- novo: os projetores comparam antes de gravar (ver o WHERE dos UPSERTs no
-- projetor do backend).
--
-- HISTÓRICO
--
-- Cadastro não é apagado. Produto que já saiu em venda antiga precisa
-- continuar existindo para a nota e o relatório fazerem sentido — por isso
-- `deactivated_at` em vez de DELETE.
-- ============================================================================

-- --------------------------------------------------------------- controle
create table if not exists public.erp_central_migrations (
  version     integer primary key,
  name        text        not null,
  applied_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- empresas
create table if not exists public.erp_companies (
  id           text primary key,
  slug         text        not null,
  trade_name   text        not null,
  legal_name   text,
  kind         text,
  active       boolean     not null default true,
  node_id      text,
  occurred_at  timestamptz not null,
  node_seq     bigint,
  updated_at   timestamptz not null default now()
);

-- Oficina, loja: a unidade dentro da empresa. Duas oficinas do grupo não são
-- duas empresas, e o consolidado precisa separar as duas.
create table if not exists public.erp_operational_units (
  id           text primary key,
  company_id   text        not null references public.erp_companies(id),
  name         text,
  kind         text,
  occurred_at  timestamptz not null,
  node_seq     bigint,
  updated_at   timestamptz not null default now()
);

-- --------------------------------------------------------------- cadastros
create table if not exists public.erp_products (
  id              text primary key,
  company_id      text        not null,
  internal_code   text,
  name            text        not null,
  unit            text,
  category        text,
  subcategory     text,
  brand           text,
  cost_cents      bigint,
  price_cents     bigint,
  parent_id       text,
  active          boolean     not null default true,
  publish_online  boolean     not null default false,
  weight_grams    integer,
  height_cm       numeric,
  width_cm        numeric,
  length_cm       numeric,
  deactivated_at  timestamptz,
  occurred_at     timestamptz not null,
  node_seq        bigint,
  updated_at      timestamptz not null default now()
);
create index if not exists ix_products_company on public.erp_products (company_id);

create table if not exists public.erp_product_variants (
  id            text primary key,
  company_id    text        not null,
  parent_id     text        not null,
  name          text,
  barcode       text,
  attributes    jsonb,
  price_cents   bigint,
  active        boolean     not null default true,
  occurred_at   timestamptz not null,
  node_seq      bigint,
  updated_at    timestamptz not null default now()
);

create table if not exists public.erp_customers (
  id           text primary key,
  company_id   text        not null,
  name         text        not null,
  document     text,
  email        text,
  phone        text,
  occurred_at  timestamptz not null,
  node_seq     bigint,
  updated_at   timestamptz not null default now()
);
create index if not exists ix_customers_company on public.erp_customers (company_id);

-- --------------------------------------------------------------- estoque
--
-- Razão central: uma linha por movimento, imutável. O saldo é derivado dela,
-- não gravado em paralelo — dois lugares dizendo qual é o saldo divergem, e
-- quando divergem ninguém sabe qual acreditar.
create table if not exists public.erp_inventory_ledger (
  id               text primary key,
  company_id       text        not null,
  product_id       text        not null,
  movement_type    text        not null,
  quantity         numeric     not null,
  quantity_before  numeric,
  balance_after    numeric,
  reference_type   text,
  reference_id     text,
  document_number  text,
  unit_cost_cents  bigint,
  operational_unit_id text,
  occurred_at      timestamptz not null,
  node_seq         bigint,
  received_at      timestamptz not null default now()
);
create index if not exists ix_ledger_product on public.erp_inventory_ledger (company_id, product_id, occurred_at);

create table if not exists public.erp_inventory_reservations (
  id                text primary key,
  company_id        text        not null,
  product_id        text        not null,
  reserved_delta    numeric     not null,
  reserved_before   numeric,
  reserved_after    numeric,
  kind              text,
  reference_type    text,
  reference_id      text,
  occurred_at       timestamptz not null,
  node_seq          bigint,
  received_at       timestamptz not null default now()
);

-- Saldo consolidado, derivado do ledger. Existe para consulta rápida; a
-- verdade continua sendo a razão.
create table if not exists public.erp_inventory_snapshots (
  company_id   text        not null,
  product_id   text        not null,
  quantity     numeric     not null,
  reserved     numeric     not null default 0,
  occurred_at  timestamptz not null,
  node_seq     bigint,
  updated_at   timestamptz not null default now(),
  primary key (company_id, product_id)
);

-- --------------------------------------------------------------- vendas
create table if not exists public.erp_sales (
  id               text primary key,
  company_id       text        not null,
  number           bigint,
  customer_id      text,
  seller_id        text,
  status           text        not null,
  subtotal_cents   bigint,
  discount_cents   bigint,
  surcharge_cents  bigint,
  total_cents      bigint      not null,
  change_cents     bigint,
  origin           text,
  occurred_at      timestamptz not null,
  node_seq         bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists ix_sales_company on public.erp_sales (company_id, occurred_at desc);

create table if not exists public.erp_sale_items (
  sale_id           text        not null references public.erp_sales(id) on delete cascade,
  line_number       integer     not null,
  product_id        text,
  description       text,
  quantity          numeric     not null,
  unit_price_cents  bigint,
  discount_cents    bigint,
  total_cents       bigint,
  primary key (sale_id, line_number)
);

create table if not exists public.erp_payments (
  id             text primary key,
  company_id     text        not null,
  origin_type    text        not null,
  origin_id      text        not null,
  method         text,
  provider       text,
  amount_cents   bigint      not null,
  status         text        not null,
  environment    text,
  occurred_at    timestamptz not null,
  node_seq       bigint,
  updated_at     timestamptz not null default now()
);

-- --------------------------------------------------------------- financeiro
create table if not exists public.erp_finance_entries (
  id             text primary key,
  company_id     text        not null,
  direction      text        not null check (direction in ('in', 'out')),
  amount_cents   bigint      not null,
  settled_cents  bigint      not null default 0,
  status         text        not null,
  due_date       date,
  settled_at     timestamptz,
  customer_id    text,
  supplier_id    text,
  description    text,
  origin_type    text,
  origin_id      text,
  occurred_at    timestamptz not null,
  node_seq       bigint,
  updated_at     timestamptz not null default now()
);
create index if not exists ix_finance_company on public.erp_finance_entries (company_id, direction, status);

-- --------------------------------------------------------------- pedidos
create table if not exists public.erp_orders (
  id                text primary key,
  company_id        text        not null,
  number            bigint,
  customer_id       text,
  customer_name     text,
  status            text        not null,
  items_cents       bigint,
  shipping_cents    bigint,
  total_cents       bigint      not null,
  payment_method    text,
  delivery_method   text,
  tracking_code     text,
  occurred_at       timestamptz not null,
  node_seq          bigint,
  updated_at        timestamptz not null default now()
);
create index if not exists ix_orders_company on public.erp_orders (company_id, occurred_at desc);

create table if not exists public.erp_order_status_history (
  id           text primary key,
  order_id     text        not null,
  company_id   text        not null,
  status       text        not null,
  note         text,
  occurred_at  timestamptz not null,
  node_seq     bigint
);

-- --------------------------------------------------------------- fiscal
--
-- SEM XML, SEM CERTIFICADO, SEM CHAVE PRIVADA. O XML carrega assinatura e não
-- acrescenta nada ao consolidado; o certificado nunca sai do nó. O que a
-- central precisa é do fato: modelo, série, número, chave de acesso e situação.
create table if not exists public.erp_fiscal_documents (
  id            text primary key,
  company_id    text        not null,
  model         text,
  serie         integer,
  number        bigint,
  access_key    text,
  status        text        not null,
  environment   text,
  sale_id       text,
  issued_at     timestamptz,
  occurred_at   timestamptz not null,
  node_seq      bigint,
  updated_at    timestamptz not null default now()
);
create unique index if not exists ux_fiscal_doc_numero
  on public.erp_fiscal_documents (company_id, model, serie, number)
  where number is not null;

create table if not exists public.erp_fiscal_events (
  id                 text primary key,
  company_id         text        not null,
  document_id        text,
  fiscal_event_type  text        not null,
  sequence           integer,
  protocol           text,
  c_stat             text,
  x_motivo           text,
  model              text,
  serie              integer,
  number_from        bigint,
  number_to          bigint,
  occurred_at        timestamptz not null,
  node_seq           bigint
);

-- --------------------------------------------------------------- oficina
create table if not exists public.erp_service_orders (
  id                   text primary key,
  company_id           text        not null,
  operational_unit_id  text,
  number               bigint,
  customer_id          text,
  customer_name        text,
  equipment_id         text,
  status               text        not null,
  labor_cents          bigint,
  parts_cents          bigint,
  total_cents          bigint,
  occurred_at          timestamptz not null,
  node_seq             bigint,
  updated_at           timestamptz not null default now()
);

create table if not exists public.erp_equipment (
  id                   text primary key,
  company_id           text        not null,
  operational_unit_id  text,
  public_id            bigint,
  origin               text,
  category             text,
  brand                text,
  model                text,
  serial_number        text,
  owner_customer_id    text,
  status               text,
  occurred_at          timestamptz not null,
  node_seq             bigint,
  updated_at           timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- RLS: deny-by-default em TODAS as tabelas centrais.
--
-- Nenhuma política é criada. Com RLS ligada e sem política, `anon` e
-- `authenticated` não leem nem escrevem nada; só a `service_role`, que ignora
-- RLS por definição e é a única credencial do servidor, alcança.
--
-- Isso é deliberado: aqui está venda, financeiro e cadastro de cliente das
-- seis operações. A chave publicável vai no bundle do site — uma política de
-- leitura ampla transformaria esse arquivo JavaScript numa porta para o
-- faturamento do grupo inteiro.
--
-- Quando houver leitura pela aplicação (BI, painel consolidado), a política
-- entra restrita por company_id e vinculada ao usuário autenticado. Nunca
-- `using (true)`.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'erp_companies', 'erp_operational_units', 'erp_products', 'erp_product_variants',
    'erp_customers', 'erp_inventory_ledger', 'erp_inventory_reservations',
    'erp_inventory_snapshots', 'erp_sales', 'erp_sale_items', 'erp_payments',
    'erp_finance_entries', 'erp_orders', 'erp_order_status_history',
    'erp_fiscal_documents', 'erp_fiscal_events', 'erp_service_orders', 'erp_equipment',
    'erp_central_migrations'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

insert into public.erp_central_migrations (version, name)
values (2, 'central-schema')
on conflict (version) do nothing;
