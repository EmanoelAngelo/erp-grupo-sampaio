/**
 * ============================================================================
 * REPROJETAR — o fato já chegou, mas nunca virou linha de negócio
 * ============================================================================
 *
 * Comando administrativo. Não é rota, não é tela, não roda sozinho: nenhum
 * trabalhador de fundo o chama.
 *
 * ## O caso que o originou
 *
 * Em 29/08/2026 os 118 eventos desta instalação foram entregues às 20:53, entre
 * a migration 001 (20:50) e a 002 (20:56). A aterrissagem já existia; as tabelas
 * de negócio, não. Os fatos estão salvos com `projected_at` nulo, e a projeção
 * normal — que só acontece dentro de `syncOnce`, sobre o lote que acabou de
 * sair — nunca mais os alcança.
 *
 * ## Como se usa
 *
 * Da RAIZ do repositório:
 *
 *     # ENSAIO — é o PADRÃO. Só lê, e diz o que faria.
 *     node server\dist\scripts\reprojetar-central.js
 *
 *     # DE VERDADE
 *     node server\dist\scripts\reprojetar-central.js --confirmar
 *
 *     # opcionais
 *     --lote=50               eventos por chamada à central (padrão 50)
 *     --maximo=200            teto de eventos nesta execução
 *     --seguir-desconhecidos  projeta o que dá e deixa o resto; leia abaixo
 *
 * ## Credencial
 *
 * Usa a chave de serviço que já está no ambiente — a mesma do backup e da
 * sincronia. NÃO precisa do token pessoal da conta Supabase: aquele serve para
 * DDL, e aqui não se cria nem se altera estrutura nenhuma.
 *
 * ## O que ele nunca faz
 *
 * Não reenvia evento. Não insere em `erp_sync_events` — a única escrita lá é o
 * carimbo `projected_at`, e só depois da confirmação. Não toca na fila local,
 * nem para ler. Não liga worker, não sobe servidor, não apaga nada, não mexe em
 * `node_seq`.
 *
 * ## Por que ele PARA num tipo desconhecido
 *
 * Dentro de `syncOnce`, pular um tipo que a central não entende é o certo: ela
 * pode ser mais antiga que o nó, e derrubar a fila por um tipo novo seria pior.
 *
 * Aqui não. Isto é uma operação administrativa sobre fatos reais, rodada uma
 * vez, e quem a roda precisa saber ANTES de qualquer escrita que existe fato
 * que ninguém sabe traduzir. `--seguir-desconhecidos` existe, e é uma decisão
 * que se toma, não um padrão que se herda.
 */
import {
  registrarErroDeProjecao,
  registrarProjecaoAceita,
  supabaseConfig,
  syncStatus,
} from '../services/sync/SyncService.js';
import { supabaseProjectionTransport } from '../services/sync/CentralProjection.js';
import {
  planejarProjecao,
  reprojetarPendentes,
  supabaseLandingReader,
  type EventoNaLanding,
} from '../services/sync/Reprojection.js';

/** As 18 tabelas de negócio, para o retrato antes e depois. */
const TABELAS_DE_NEGOCIO = [
  'erp_companies', 'erp_operational_units', 'erp_products', 'erp_product_variants',
  'erp_customers', 'erp_inventory_ledger', 'erp_inventory_reservations',
  'erp_inventory_snapshots', 'erp_sales', 'erp_sale_items', 'erp_payments',
  'erp_finance_entries', 'erp_orders', 'erp_order_status_history',
  'erp_fiscal_documents', 'erp_fiscal_events', 'erp_service_orders', 'erp_equipment',
];

/**
 * Estas duas não carregam empresa, e é de propósito.
 *
 * `erp_companies` É a empresa. `erp_sale_items` pendura na venda pela chave
 * composta. Contá-las por empresa exigiria inventar de onde tirar o valor.
 */
const TABELAS_SEM_EMPRESA = ['erp_companies', 'erp_sale_items'];

interface LinhaDaLanding {
  id: string;
  company_id: string;
  event_type: string;
  node_seq: number | null;
  projected_at: string | null;
}

interface RetratoDaCentral {
  total: number;
  semProjecao: number;
  comProjecao: number;
  idsDistintos: number;
  duplicados: number;
  porEmpresa: Record<string, { eventos: number; seqMin: number; seqMax: number }>;
  porTipo: Record<string, number>;
  migrations: number[];
  tabelas: Record<string, number>;
  /**
   * Linhas por tabela e por EMPRESA, no destino.
   *
   * É a única conferência que enxerga projeção cruzando tenant. As outras
   * olham a origem: contar 90 eventos da Preço Justo na aterrissagem prova
   * que a aterrissagem não mudou, e nada sobre onde as linhas foram parar.
   */
  tabelaEmpresa: Record<string, Record<string, number>>;
}

function argumentoNumerico(nome: string): number | undefined {
  const bruto = process.argv.slice(2).find((a) => a.startsWith(`--${nome}=`));
  if (!bruto) return undefined;
  const n = Number.parseInt(bruto.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * O retrato da central, por LEITURA.
 *
 * Usa a chave de serviço pelo PostgREST: nenhum verbo destrutivo, nenhum DDL.
 * As agregações são feitas aqui, em memória, porque o PostgREST não faz
 * `group by` — e para a ordem de grandeza desta aterrissagem isso é uma
 * requisição, não um problema.
 */
async function retratar(
  url: string,
  chave: string,
): Promise<RetratoDaCentral | null> {
  const base = url.replace(/\/+$/, '');
  const h = { apikey: chave, Authorization: `Bearer ${chave}` };

  const eventos: LinhaDaLanding[] = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(
      `${base}/rest/v1/erp_sync_events`
        + `?select=id,company_id,event_type,node_seq,projected_at&limit=1000&offset=${off}`,
      { headers: h },
    );
    if (!r.ok) {
      console.error('  a central recusou a leitura da aterrissagem (HTTP ' + r.status + ').');
      return null;
    }
    const lote = (await r.json()) as LinhaDaLanding[];
    eventos.push(...lote);
    if (lote.length < 1000) break;
  }

  const retrato: RetratoDaCentral = {
    total: eventos.length,
    semProjecao: eventos.filter((e) => e.projected_at === null).length,
    comProjecao: eventos.filter((e) => e.projected_at !== null).length,
    idsDistintos: new Set(eventos.map((e) => e.id)).size,
    duplicados: 0,
    porEmpresa: {},
    porTipo: {},
    migrations: [],
    tabelas: {},
    tabelaEmpresa: {},
  };
  retrato.duplicados = retrato.total - retrato.idsDistintos;

  for (const e of eventos) {
    const seq = Number(e.node_seq ?? 0);
    const atual = retrato.porEmpresa[e.company_id]
      ?? { eventos: 0, seqMin: seq, seqMax: seq };
    atual.eventos += 1;
    atual.seqMin = Math.min(atual.seqMin, seq);
    atual.seqMax = Math.max(atual.seqMax, seq);
    retrato.porEmpresa[e.company_id] = atual;
    retrato.porTipo[e.event_type] = (retrato.porTipo[e.event_type] ?? 0) + 1;
  }

  const mig = await fetch(
    `${base}/rest/v1/erp_central_migrations?select=version&order=version`,
    { headers: h },
  );
  if (mig.ok) {
    retrato.migrations = ((await mig.json()) as Array<{ version: number }>).map((m) => m.version);
  }

  for (const t of TABELAS_DE_NEGOCIO) {
    const r = await fetch(`${base}/rest/v1/${t}?select=*`, {
      headers: { ...h, Prefer: 'count=exact', Range: '0-0' },
    });
    const faixa = r.headers.get('content-range') ?? '';
    const n = Number(String(faixa).split('/')[1]);
    retrato.tabelas[t] = r.ok && Number.isFinite(n) ? n : -1;

    /*
      E de QUEM é cada linha. Só as tabelas que têm a coluna: `erp_companies`
      É a empresa, e `erp_sale_items` pendura na venda. Pedir `company_id`
      delas devolveria erro, e um erro esperado não deve virar ruído.
    */
    if (retrato.tabelas[t] <= 0 || TABELAS_SEM_EMPRESA.includes(t)) continue;
    const donos: Record<string, number> = {};
    for (let off = 0; ; off += 1000) {
      const rr = await fetch(
        `${base}/rest/v1/${t}?select=company_id&limit=1000&offset=${off}`,
        { headers: h },
      );
      if (!rr.ok) break;
      const lote = (await rr.json()) as Array<{ company_id?: string }>;
      for (const linha of lote) {
        const e = String(linha.company_id ?? '');
        if (e) donos[e] = (donos[e] ?? 0) + 1;
      }
      if (lote.length < 1000) break;
    }
    retrato.tabelaEmpresa[t] = donos;
  }

  return retrato;
}

function imprimirRetrato(rotulo: string, r: RetratoDaCentral, nomes: Map<string, string>): void {
  console.log('  [' + rotulo + ']');
  console.log('    landing total        : ' + r.total);
  console.log('    projected_at NULL    : ' + r.semProjecao);
  console.log('    projected_at NOT NULL: ' + r.comProjecao);
  console.log('    event_id distintos   : ' + r.idsDistintos);
  console.log('    duplicados           : ' + r.duplicados);
  console.log('    migrations           : ' + r.migrations.map((v) => 'v' + v).join(' '));
  console.log('    por empresa:');
  for (const [id, e] of Object.entries(r.porEmpresa).sort((a, b) => b[1].eventos - a[1].eventos)) {
    console.log('      ' + String(nomes.get(id) ?? id).slice(0, 16).padEnd(18)
      + String(e.eventos).padStart(4) + '   node_seq ' + e.seqMin + '..' + e.seqMax);
  }
  const comLinhas = Object.entries(r.tabelas).filter(([, n]) => n > 0);
  console.log('    tabelas com linha    : '
    + (comLinhas.length ? comLinhas.map(([t, n]) => t + '=' + n).join(', ') : 'nenhuma'));
  const ausentes = Object.entries(r.tabelas).filter(([, n]) => n < 0).map(([t]) => t);
  console.log('    tabelas ausentes     : ' + (ausentes.length ? ausentes.join(', ') : 'nenhuma'));
}

/**
 * As chaves que EXISTEM numa tabela da central, serializadas do mesmo jeito
 * que o plano serializa: colunas em ordem alfabética, `c=v` unidas por `|`.
 *
 * Devolve chave → empresa (null quando a tabela não carrega empresa). É o
 * insumo da verificação por PRESENÇA: o UPSERT encolhe somas legitimamente,
 * então somar não prova nada — perguntar chave a chave prova.
 */
async function chavesReais(
  url: string,
  chave: string,
  tabela: string,
  colunas: string[],
  temEmpresa: boolean,
): Promise<Map<string, string | null>> {
  const base = url.replace(/\/+$/, '');
  const h = { apikey: chave, Authorization: `Bearer ${chave}` };
  const selecionar = [...colunas];
  if (temEmpresa && !selecionar.includes('company_id')) selecionar.push('company_id');

  const achadas = new Map<string, string | null>();
  for (let off = 0; ; off += 1000) {
    const r = await fetch(
      `${base}/rest/v1/${tabela}?select=${selecionar.join(',')}&limit=1000&offset=${off}`,
      { headers: h },
    );
    if (!r.ok) break;
    const lote = (await r.json()) as Array<Record<string, unknown>>;
    for (const linha of lote) {
      const serializada = [...colunas].sort()
        .map((c) => c + '=' + String(linha[c]))
        .join('|');
      achadas.set(
        serializada,
        temEmpresa && typeof linha.company_id === 'string' ? linha.company_id : null,
      );
    }
    if (lote.length < 1000) break;
  }
  return achadas;
}

function conferir(rotulo: string, ok: boolean, detalhe: string): boolean {
  console.log('  ' + (ok ? 'OK   ' : 'FALHA') + '  ' + rotulo.padEnd(44) + detalhe);
  return ok;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const confirmar = args.includes('--confirmar');
  const ensaio = !confirmar;
  const seguirComDesconhecidos = args.includes('--seguir-desconhecidos');

  const config = supabaseConfig();
  if (!config) {
    console.error('Sem credencial da central. Faltam, no ambiente:');
    for (const f of syncStatus().missing) console.error('  - ' + f);
    return 1;
  }
  const limpar = (t: string): string => t.split(config.serviceRoleKey).join('<oculto>');

  /*
    Os nomes das empresas saem do banco LOCAL, e só para o relatório ficar
    legível. Nenhuma decisão depende disto.
  */
  const nomes = new Map<string, string>();
  try {
    const { getConnection } = await import('../db/sqlite.js');
    const { ensureCoreSchema } = await import('../db/schema.js');
    ensureCoreSchema();
    for (const c of getConnection()
      .prepare('SELECT id, COALESCE(trade_name, legal_name) nome FROM core_companies')
      .all() as unknown as Array<{ id: string; nome: string }>) {
      nomes.set(c.id, c.nome);
    }
  } catch {
    // Sem nomes, o relatório mostra os ids. Não é motivo para não rodar.
  }

  console.log(ensaio ? '=== ENSAIO — nada será projetado ===' : '=== REPROJEÇÃO ===');
  console.log('  central : ' + new URL(config.url).host);
  console.log('  lote    : ' + (argumentoNumerico('lote') ?? 50));
  if (argumentoNumerico('maximo')) console.log('  máximo  : ' + argumentoNumerico('maximo'));
  console.log('  tipo desconhecido : ' + (seguirComDesconhecidos ? 'SEGUE (pedido)' : 'PARA'));
  console.log('  usa token pessoal : NÃO — chave de serviço, e nenhum DDL');

  // ------------------------------------------------------ o retrato de ANTES
  console.log('');
  console.log('=== RETRATO ANTES ===');
  const antes = await retratar(config.url, config.serviceRoleKey);
  if (!antes) return 1;
  imprimirRetrato('antes', antes, nomes);

  // ------------------------------------------------------------- o plano
  const leitor = supabaseLandingReader({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
  });
  const transporte = supabaseProjectionTransport({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
  });

  let pendentes: EventoNaLanding[];
  try {
    pendentes = await leitor.lerNaoProjetados(argumentoNumerico('maximo') ?? 100000);
  } catch (err) {
    console.error('');
    console.error('  não consegui ler os pendentes: '
      + limpar(err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const plano = planejarProjecao(pendentes);
  const tamanhoDoLote = argumentoNumerico('lote') ?? 50;

  console.log('');
  console.log('=== O QUE SERIA PROJETADO ===');
  console.log('  eventos a projetar   : ' + plano.eventos);
  console.log('  linhas previstas     : ' + plano.linhasPrevistas);
  console.log('  lotes estimados      : ' + Math.ceil(plano.eventos / tamanhoDoLote));
  console.log('');
  console.log('  por tabela — operações × linhas finais distintas:');
  for (const [tabela, d] of Object.entries(plano.porTabelaDetalhe).sort()) {
    console.log('    ' + tabela.padEnd(30)
      + String(d.operacoes).padStart(4) + ' op → ' + String(d.chavesDistintas).padStart(4)
      + ' chave(s)  ' + d.estrategia
      + '  [' + d.chaveColunas.join('+') + ']');
  }
  console.log('');
  console.log('  tipo de evento → tabela de destino:');
  for (const [tipo, d] of Object.entries(plano.porTipo).sort((a, b) => b[1].eventos - a[1].eventos)) {
    console.log('    ' + tipo.padEnd(30) + String(d.eventos).padStart(4) + '  → ' + d.tabelas.join(', '));
  }

  console.log('');
  console.log('  destino por empresa — quantas linhas cada uma receberia:');
  for (const [tabela, porEmpresa] of Object.entries(plano.porTabelaEmpresa).sort()) {
    const partes = Object.entries(porEmpresa)
      .sort((a, b) => b[1] - a[1])
      .map(([e, q]) => String(nomes.get(e) ?? e).slice(0, 14) + '=' + q);
    console.log('    ' + tabela.padEnd(30) + partes.join('  '));
  }
  if (plano.tabelasSemEmpresa.length > 0) {
    /*
      Dizer que não dá para contar é diferente de omitir. Quem lê precisa
      saber que estas tabelas ficaram fora da conferência de tenant, e por quê.
    */
    console.log('    (sem coluna de empresa, fora da conferência de tenant: '
      + plano.tabelasSemEmpresa.join(', ') + ')');
  }

  if (plano.desconhecidos.length > 0) {
    console.log('');
    console.log('  SEM PROJETOR — nenhum tradutor conhece estes tipos:');
    for (const d of plano.desconhecidos.slice(0, 20)) {
      console.log('    ' + d.id.slice(0, 10) + '  ' + d.eventType.padEnd(30)
        + String(nomes.get(d.companyId) ?? d.companyId).slice(0, 16));
    }
    if (plano.desconhecidos.length > 20) {
      console.log('    ... e mais ' + (plano.desconhecidos.length - 20));
    }
  }

  if (ensaio) {
    console.log('');
    console.log('Nada foi projetado e nada foi carimbado.');
    console.log('Para valer:  node ' + process.argv[1].split(/[\\/]/).slice(-4).join('/')
      + ' --confirmar');
    return 0;
  }

  // ------------------------------------------------------------ a execução
  console.log('');
  console.log('=== PROJETANDO ===');
  const r = await reprojetarPendentes({
    leitor,
    transporte,
    tamanhoDoLote,
    maximo: argumentoNumerico('maximo'),
    seguirComDesconhecidos,
  });

  if (r.abortado) {
    console.error('  ABORTADO — há fato que nenhum projetor traduz, e nada foi escrito.');
    console.error('  Os ids estão listados acima.');
    console.error('  Para projetar o resto e deixá-los esperando: --seguir-desconhecidos');
    return 1;
  }

  /*
    O DIAGNÓSTICO DA LOJA ACOMPANHA A REPROJEÇÃO (GAP-PRD-048).

    Este é o outro caminho que projeta, e não limpava o erro antigo nem
    registrava o novo: depois de 199 eventos reprojetados e carimbados, a
    loja seguia guardando o PGRST202 de 30/08. Agora a tela de sincronização
    e o `conferir-central` leem o mesmo que o envio normal escreve.
  */
  if (r.eventosProjetados > 0) registrarProjecaoAceita();
  if (r.falhas.length > 0) {
    registrarErroDeProjecao(
      `Reprojeção: ${r.falhas.length} evento(s) recusado(s) pela central. Primeiro: `
        + limpar(r.falhas[0]?.motivo ?? '').slice(0, 300),
    );
  }

  console.log('  eventos projetados   : ' + r.eventosProjetados);
  console.log('  linhas gravadas      : ' + r.linhasGravadas);
  console.log('  puladas pela ordem   : ' + r.puladasPorOrdem);
  console.log('  falhas               : ' + r.falhas.length);
  console.log('');
  console.log('  linhas por tabela:');
  for (const [t, n] of Object.entries(r.porTabela).sort((a, b) => b[1] - a[1])) {
    console.log('    ' + t.padEnd(30) + n);
  }

  if (r.falhas.length > 0) {
    console.log('');
    console.log('=== FALHAS (o fato continua na aterrissagem, sem carimbo) ===');
    for (const f of r.falhas.slice(0, 20)) {
      console.log('    ' + f.id.slice(0, 10) + '  ' + f.eventType.padEnd(28)
        + limpar(f.motivo).slice(0, 80));
    }
  }

  // ----------------------------------------------------- o retrato de DEPOIS
  console.log('');
  console.log('=== RETRATO DEPOIS ===');
  const depois = await retratar(config.url, config.serviceRoleKey);
  if (!depois) return 1;
  imprimirRetrato('depois', depois, nomes);

  // ------------------------------------------------------- as conferências
  console.log('');
  console.log('=== CONFERÊNCIA ===');
  let tudoBem = true;
  const marca = (ok: boolean): void => { if (!ok) tudoBem = false; };

  marca(conferir('landing não mudou de tamanho', depois.total === antes.total,
    antes.total + ' → ' + depois.total));
  marca(conferir('event_id distintos iguais', depois.idsDistintos === antes.idsDistintos,
    antes.idsDistintos + ' → ' + depois.idsDistintos));
  marca(conferir('duplicados continuam zero', depois.duplicados === 0,
    String(depois.duplicados)));
  marca(conferir('migrations intactas',
    JSON.stringify(depois.migrations) === JSON.stringify(antes.migrations),
    depois.migrations.map((v) => 'v' + v).join(' ')));
  marca(conferir('as 18 tabelas continuam existindo',
    Object.values(depois.tabelas).every((n) => n >= 0),
    Object.values(depois.tabelas).filter((n) => n >= 0).length + '/18'));

  /*
    node_seq NÃO PODE MUDAR. É o número que dá a ordem dos fatos, e o que a
    guarda de ordem compara. Alterá-lo faria evento antigo passar por novo.
  */
  for (const [id, e] of Object.entries(antes.porEmpresa)) {
    const d = depois.porEmpresa[id];
    marca(conferir('node_seq de ' + String(nomes.get(id) ?? id).slice(0, 14),
      Boolean(d) && d.seqMin === e.seqMin && d.seqMax === e.seqMax,
      e.seqMin + '..' + e.seqMax + ' → ' + (d ? d.seqMin + '..' + d.seqMax : 'sumiu')));
    marca(conferir('  eventos de ' + String(nomes.get(id) ?? id).slice(0, 14),
      Boolean(d) && d.eventos === e.eventos,
      e.eventos + ' → ' + (d?.eventos ?? 0)));
  }

  marca(conferir('projeção pendente zerou', depois.semProjecao === 0,
    antes.semProjecao + ' → ' + depois.semProjecao));
  marca(conferir('projetados = total', depois.comProjecao === depois.total,
    depois.comProjecao + '/' + depois.total));

  /*
    O CARIMBO NÃO É PROVA.

    `projected_at` ter mudado diz que o carimbo foi gravado, não que a linha
    existe. Esta é a conferência que separa uma coisa da outra: cada tabela que
    o plano previu tem de ter recebido linha de verdade.
  */
  /*
    NENHUMA EMPRESA RECEBEU LINHA DE OUTRA.

    O plano disse, por tabela e por empresa, quantas linhas sairiam. Aqui se
    compara com o CRESCIMENTO real de cada par. Um defeito que trocasse a
    empresa passaria por todas as outras portas: o total bate, os ids são os
    mesmos, o carimbo virou não-nulo — e o gestor da Gringa veria a venda do
    Preço Justo.
  */
  /*
    PRESENÇA DE CHAVE, NÃO ARITMÉTICA.

    A primeira execução reportou 175 operações e as tabelas terminaram com
    menos linhas — e estava CERTO: o UPSERT converge chaves iguais (47
    movimentos → 15 saldos; 37 operações de produto → 16 produtos). Um gate
    que compara somas reprova resultado correto. Este pergunta, chave a
    chave: a linha existe? pertence à empresa prevista?
  */
  console.log('');
  console.log('  chaves previstas → presentes na central (com a empresa certa):');
  const empresasDaOrigem = new Set(Object.keys(antes.porEmpresa));
  for (const [tabela, detalhe] of Object.entries(plano.porTabelaDetalhe).sort()) {
    const temEmpresa = !TABELAS_SEM_EMPRESA.includes(tabela);
    const reais = await chavesReais(
      config.url, config.serviceRoleKey, tabela, detalhe.chaveColunas, temEmpresa,
    );
    let presentes = 0;
    let empresaErrada = 0;
    const faltando: string[] = [];
    for (const prevista of detalhe.chaves) {
      if (!reais.has(prevista.chave)) {
        faltando.push(prevista.chave);
        continue;
      }
      presentes += 1;
      const dona = reais.get(prevista.chave);
      if (prevista.empresa && dona && dona !== prevista.empresa) empresaErrada += 1;
    }
    marca(conferir(
      '    ' + tabela,
      presentes === detalhe.chaves.length && empresaErrada === 0,
      presentes + '/' + detalhe.chaves.length + ' presentes'
        + (empresaErrada ? ', ' + empresaErrada + ' com EMPRESA ERRADA' : '')
        + '  (' + detalhe.operacoes + ' op, ' + detalhe.estrategia + ')',
    ));
    for (const f of faltando.slice(0, 5)) console.log('           faltou: ' + f.slice(0, 70));
  }

  // E nenhuma empresa estranha apareceu em tabela nenhuma.
  const intrusas: string[] = [];
  for (const [tabela, donos] of Object.entries(depois.tabelaEmpresa)) {
    for (const empresa of Object.keys(donos)) {
      if (!empresasDaOrigem.has(empresa)) intrusas.push(tabela + '/' + empresa);
    }
  }
  marca(conferir('nenhuma empresa estranha no destino', intrusas.length === 0,
    intrusas.length ? intrusas.slice(0, 5).join(', ') : 'nenhuma'));

  /*
    O bloco de crescimento por tabela que morava aqui foi substituído pela
    verificação de presença de chave, acima. Crescimento bruto reprovaria o
    UPSERT convergente — que é comportamento correto, não perda.
  */

  // A fila local não pode ter sido tocada — o módulo nem a lê, e aqui se prova.
  try {
    const { getConnection } = await import('../db/sqlite.js');
    const pend = getConnection()
      .prepare("SELECT COUNT(*) n FROM core_outbox WHERE status = 'pending'")
      .get() as { n: number };
    marca(conferir('outbox local continua sem pendente', pend.n === 0, String(pend.n)));
  } catch {
    console.log('  ??     não consegui ler a fila local (não é impedimento)');
  }

  console.log('');
  console.log('=== VEREDITO ===');
  if (tudoBem && r.falhas.length === 0) {
    console.log('  REPROJETADO E CONFERIDO.');
    return 0;
  }
  console.log('  CONFERÊNCIA REPROVADA. Me mostre esta saída inteira.');
  return 1;
}

process.exitCode = await main();
