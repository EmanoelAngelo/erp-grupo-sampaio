-- ============================================================================
-- MIGRATION 003 — Projeção: do fato bruto para as tabelas de negócio
--
-- Rodar DEPOIS de 01-landing.sql e 02-central-schema.sql.
--
-- O QUE ESTA MIGRATION RESOLVE
--
-- A fila do nó subia o fato para `erp_sync_events` e parava ali. As tabelas de
-- negócio criadas em 002 ficavam vazias para sempre, e `projected_at` nunca era
-- preenchido — existe até um índice para "ainda não projetado" que nada usava.
-- Uma central que recebe eventos e não os projeta não é central: é um log, e o
-- consolidado do grupo mostraria zero.
--
-- POR QUE UMA FUNÇÃO, E NÃO UPSERT DIRETO PELO PostgREST
--
-- A GUARDA DE ORDEM. `Prefer: resolution=merge-duplicates` sobrescreve a linha
-- sem olhar nada. A rede não entrega em ordem: um "pedido criado" atrasado
-- chegando depois do "pedido entregue" apagaria o estado novo, e o cliente
-- veria o pedido voltar no tempo. A decisão precisa de
-- `WHERE excluded.node_seq >= atual.node_seq`, que PostgREST não expressa.
--
-- O mapeamento evento → linha continua UM SÓ, em TypeScript
-- (`server/src/services/sync/Projector.ts`). Reescrevê-lo aqui em SQL criaria
-- duas versões da mesma regra, que divergem no primeiro campo novo.
--
-- SEGURANÇA: A LISTA BRANCA
--
-- A função monta SQL dinâmico a partir de um nome de tabela vindo de fora.
-- Sem lista branca isso é injeção com chave de serviço — quem alcançasse a RPC
-- escreveria em qualquer tabela do projeto, `auth.users` inclusive. Só as
-- tabelas projetadas entram, e nome fora da lista levanta exceção em vez de ser
-- ignorado em silêncio: ignorar faria o nó acreditar que gravou.
-- ============================================================================

create or replace function public.erp_projecao_tabelas_permitidas()
returns text[]
language sql
immutable
as $$
  -- Exatamente as tabelas que `Projector.ts` escreve, nem uma a mais. A lista
  -- tem teste do lado do nó cobrando que as duas não divirjam: tabela nova no
  -- projetor sem entrada aqui viraria exceção só em produção.
  select array[
    'erp_companies',
    'erp_customers',
    'erp_equipment',
    'erp_finance_entries',
    'erp_fiscal_documents',
    'erp_fiscal_events',
    'erp_inventory_ledger',
    'erp_inventory_reservations',
    'erp_inventory_snapshots',
    'erp_order_status_history',
    'erp_orders',
    'erp_payments',
    'erp_product_variants',
    'erp_products',
    'erp_sale_items',
    'erp_sales',
    'erp_service_orders'
  ]::text[];
$$;

-- ----------------------------------------------------------------------------
-- erp_apply_projections(payload jsonb)
--
-- Recebe um lote de linhas já projetadas pelo nó:
--
--   [{ "table_name": "erp_sales",
--      "key_columns": { "id": "..." },
--      "row_data":    { "id": "...", "total_cents": 1000, "node_seq": 42, ... },
--      "guard_by_order": true }, ...]
--
-- Devolve { "written": n, "skipped_by_order": n }.
--
-- IDEMPOTENTE: reprocessar o mesmo lote mil vezes deixa uma linha por chave. É
-- essa propriedade que torna o "replay" da fila uma operação de rotina, e não
-- um risco.
-- ----------------------------------------------------------------------------
create or replace function public.erp_apply_projections(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item            jsonb;
  tabela          text;
  chaves          text[];
  colunas         text[];
  guarda          boolean;
  sql_texto       text;
  gravadas        int := 0;
  puladas_ordem   int := 0;
  afetadas        int;
begin
  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'payload precisa ser um array de projeções';
  end if;

  for item in select * from jsonb_array_elements(payload)
  loop
    tabela := item->>'table_name';
    guarda := coalesce((item->>'guard_by_order')::boolean, false);

    if not (tabela = any (public.erp_projecao_tabelas_permitidas())) then
      -- Recusa alto e claro. Ignorar faria o nó marcar como projetado um fato
      -- que nunca chegou a tabela nenhuma.
      raise exception 'tabela % não está na lista de projeção', tabela;
    end if;

    select array_agg(k order by k) into chaves
      from jsonb_object_keys(item->'key_columns') as k;
    select array_agg(k order by k) into colunas
      from jsonb_object_keys(item->'row_data') as k;

    if chaves is null or array_length(chaves, 1) = 0 then
      raise exception 'projeção sem chave para a tabela %', tabela;
    end if;

    -- `jsonb_populate_record` converte os tipos conforme a própria tabela: sem
    -- ele, todo valor chegaria como texto e a data viraria string.
    sql_texto := format(
      'insert into public.%I (%s)
         select %s from jsonb_populate_record(null::public.%I, $1) as t
       on conflict (%s) do update set %s %s',
      tabela,
      (select string_agg(format('%I', c), ', ') from unnest(colunas) as c),
      (select string_agg(format('t.%I', c), ', ') from unnest(colunas) as c),
      tabela,
      (select string_agg(format('%I', c), ', ') from unnest(chaves) as c),
      (select string_agg(format('%I = excluded.%I', c, c), ', ')
         from unnest(colunas) as c
        where not (c = any (chaves))),
      case
        when guarda then
          format('where public.%I.node_seq is null or excluded.node_seq >= public.%I.node_seq',
                 tabela, tabela)
        else ''
      end
    );

    execute sql_texto using item->'row_data';
    get diagnostics afetadas = row_count;

    if afetadas > 0 then
      gravadas := gravadas + 1;
    else
      -- Zero linha afetada com guarda ligada significa exatamente uma coisa:
      -- o que já estava lá é mais novo. Não é erro; é a guarda funcionando.
      puladas_ordem := puladas_ordem + 1;
    end if;
  end loop;

  return jsonb_build_object('written', gravadas, 'skipped_by_order', puladas_ordem);
end;
$$;

comment on function public.erp_apply_projections(jsonb) is
  'Aplica linhas projetadas pelo nó com upsert idempotente e guarda de ordem por node_seq.';

-- A RPC é chamada com a chave de SERVIÇO, do servidor. Nenhum papel anônimo ou
-- autenticado pode executá-la: com `security definer`, dar EXECUTE ao anon
-- entregaria escrita na central para qualquer um com a chave publicável.
revoke execute on function public.erp_apply_projections(jsonb) from public;
revoke execute on function public.erp_apply_projections(jsonb) from anon;
revoke execute on function public.erp_apply_projections(jsonb) from authenticated;
grant  execute on function public.erp_apply_projections(jsonb) to service_role;

insert into public.erp_central_migrations (version, name)
values (3, 'projecao')
on conflict (version) do nothing;
