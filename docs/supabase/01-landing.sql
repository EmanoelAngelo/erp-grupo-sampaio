-- ============================================================================
-- Banco central do Grupo Sampaio — tabela de aterrissagem
--
-- Rodar no SQL Editor da Supabase. Este é o PRIMEIRO passo da arquitetura
-- híbrida: cada nó (loja) continua com o SQLite local como banco operacional,
-- e sobe os fatos para cá quando a conexão permite.
--
-- Por que uma tabela de aterrissagem antes das tabelas de negócio:
--
-- Receber o fato bruto e projetar depois separa duas falhas que não podem se
-- misturar. Se o formato de uma entidade mudar, ou se uma projeção tiver erro,
-- o fato JÁ ESTÁ salvo aqui e a projeção pode ser refeita. Fosse direto para a
-- tabela final, um erro de projeção significaria fato perdido — e fato de
-- venda perdido não se recupera.
--
-- `id` é a chave primária e vem do nó. É isso que torna o reenvio inofensivo:
-- o transporte usa UPSERT, então o mesmo evento chegando mil vezes resulta em
-- uma linha, nunca em mil vendas.
-- ============================================================================

-- Controle de versão da central. Independente da versão do SQLite local.
create table if not exists public.erp_central_migrations (
  version     integer primary key,
  name        text        not null,
  applied_at  timestamptz not null default now()
);

create table if not exists public.erp_sync_events (
  id                   uuid        primary key,
  node_id              text        not null,
  event_type           text        not null,
  aggregate_type       text        not null,
  aggregate_id         text        not null,
  company_id           text        not null,
  operational_unit_id  text,
  operation            text        not null check (operation in ('insert', 'update', 'delete')),
  -- Versão do envelope. Sem ela, evoluir o payload depois quebraria a leitura
  -- de todo evento antigo já gravado aqui — e evento de venda não se regenera.
  schema_version       integer     not null default 1,
  payload              jsonb       not null,
  occurred_at          timestamptz not null,
  -- Ordem em que o fato saiu do nó. A rede não entrega em ordem, e é este
  -- número que permite ao projetor recusar evento antigo que chegou depois.
  node_seq             bigint,
  projected_at         timestamptz,
  received_at          timestamptz not null default now()
);

-- Consultas quentes: o que chegou de cada nó, o estado de um agregado, e o
-- que ainda falta projetar.
create index if not exists ix_sync_events_node
  on public.erp_sync_events (node_id, node_seq);

create index if not exists ix_sync_events_aggregate
  on public.erp_sync_events (aggregate_type, aggregate_id, node_seq);

create index if not exists ix_sync_events_company
  on public.erp_sync_events (company_id, occurred_at desc);

create index if not exists ix_sync_events_unprojected
  on public.erp_sync_events (projected_at, node_seq) where projected_at is null;

-- ----------------------------------------------------------------------------
-- RLS LIGADA E SEM POLÍTICA, DE PROPÓSITO.
--
-- Com RLS ligada e nenhuma política criada, ninguém lê nem escreve — exceto a
-- service_role, que ignora RLS por definição e é a única credencial que o
-- servidor usa. O navegador do cliente, que carrega a chave publicável, não
-- alcança esta tabela de forma alguma.
--
-- Isso é deliberado: aqui trafegam venda, financeiro e cadastro de cliente das
-- seis operações. Uma política de leitura ampla transformaria a chave que vai
-- no bundle do site numa porta para o faturamento do grupo inteiro.
--
-- Quando houver leitura pela aplicação (BI, painel consolidado), a política
-- entra restrita por company_id e vinculada ao usuário autenticado — nunca
-- `using (true)`.
-- ----------------------------------------------------------------------------
alter table public.erp_sync_events enable row level security;

comment on table public.erp_sync_events is
  'Fatos brutos vindos dos nós locais (lojas). Fonte para as projeções de negócio. '
  'Escrita apenas por service_role, via API do ERP. Nunca recebe segredo: hash de senha, '
  'certificado, token e chave de API são removidos no nó antes do envio.';

alter table public.erp_central_migrations enable row level security;

insert into public.erp_central_migrations (version, name)
values (1, 'landing')
on conflict (version) do nothing;
