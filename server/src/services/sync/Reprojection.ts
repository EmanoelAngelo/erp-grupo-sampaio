/**
 * ============================================================================
 * REPROJEÇÃO — do fato que já chegou para a linha de negócio que faltou
 * ============================================================================
 *
 * A projeção normal acontece dentro de `syncOnce`, sobre o lote que ACABOU de
 * ser entregue. É o caminho certo no dia a dia: projetar antes de entregar
 * criaria linha de negócio sem o fato que a originou.
 *
 * Só que ele tem um ponto cego. Depois que o evento sai da fila local como
 * `synced`, nada mais o alcança — `projetarLote` só enxerga o que está saindo
 * agora. Um fato entregue cuja projeção falhou fica na aterrissagem com
 * `projected_at` nulo, e ninguém volta para buscá-lo.
 *
 * Isso deixou de ser hipótese em 29/08/2026. Os 118 eventos desta instalação
 * foram entregues às 20:53, entre a migration 001 (20:50) e a 002 (20:56): a
 * tabela de aterrissagem já existia e as tabelas de negócio ainda não. Os fatos
 * estão salvos, íntegros, e a projeção nunca rodou.
 *
 * ============================================================================
 * A INVERSÃO QUE FAZ ISTO FUNCIONAR
 * ============================================================================
 *
 * A reprojeção parte da ATERRISSAGEM, não da fila local. É a única fonte que
 * continua verdadeira depois de o evento ter sido entregue — e é por isso que
 * este módulo não importa nada de `OutboxService` além do TIPO da linha.
 *
 * Ele também não escreve em `erp_sync_events`. Reprojetar não é reenviar: um
 * fato entregue uma vez não pode virar dois. O que ele faz na aterrissagem é
 * LER e, no fim, CARIMBAR `projected_at`.
 *
 * ============================================================================
 * UM MAPEAMENTO SÓ
 * ============================================================================
 *
 * A tradução evento → linha continua sendo `project()`, em `Projector.ts`.
 * Escrever uma segunda aqui pareceria mais simples e divergiria da primeira no
 * dia em que um campo novo aparecesse — e a divergência apareceria como
 * diferença de relatório, meses depois, sem ninguém saber de onde veio.
 *
 * ============================================================================
 * A ORDEM DAS OPERAÇÕES
 * ============================================================================
 *
 *   1. ler da aterrissagem o que tem `projected_at` nulo, em lotes;
 *   2. projetar o lote pela via oficial;
 *   3. só ENTÃO carimbar `projected_at` — e apenas nos eventos que a central
 *      confirmou.
 *
 * Carimbar antes e falhar deixaria o fato marcado como projetado sem nunca ter
 * virado linha: invisível para sempre, porque a varredura seguinte não o veria.
 */
import type { OutboxRow } from './OutboxService.js';
import {
  carimbarProjetadosNaLanding,
  projetarLote,
  type ProjectionTransport,
} from './CentralProjection.js';
import { project } from './Projector.js';

/** Um evento como a aterrissagem o guarda. */
export interface EventoNaLanding {
  id: string;
  node_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  company_id: string;
  operational_unit_id: string | null;
  operation: string;
  schema_version: number;
  /** `jsonb` na central; objeto aqui. */
  payload: unknown;
  occurred_at: string;
  node_seq: number | null;
}

/**
 * O que a reprojeção precisa saber fazer com a aterrissagem.
 *
 * Três verbos, e nenhum deles insere. A ausência de um `inserir` na interface
 * é deliberada: é o que impede este mecanismo de virar, por descuido, um
 * reenvio.
 */
export interface LandingReader {
  name: string;
  /** Os mais antigos primeiro, no máximo `limite`. */
  lerNaoProjetados(limite: number): Promise<EventoNaLanding[]>;
  contarNaoProjetados(): Promise<number>;
  /** Carimba `projected_at`. Chamado SÓ depois da confirmação da central. */
  marcarProjetados(ids: string[]): Promise<number>;
}

/** Um evento que nenhum projetor sabe traduzir. */
export interface EventoDesconhecido {
  id: string;
  eventType: string;
  companyId: string;
}

/** Uma chave de destino, com a empresa dona quando a linha a carrega. */
export interface ChavePrevista {
  /** As colunas-chave serializadas em ordem fixa: é a identidade da linha. */
  chave: string;
  empresa: string | null;
}

export interface DetalheDaTabela {
  /** Quantas operações de UPSERT sairiam. É o que o RPC conta como written. */
  operacoes: number;
  /** Sobre quantas linhas FINAIS distintas. UPSERT converge chaves iguais. */
  chavesDistintas: number;
  chaveColunas: string[];
  /**
   * APPEND quando cada operação tem chave própria (razão, histórico);
   * CONVERGE quando operações repetem chave (saldo, estado de cadastro).
   * A diferença é o que separa "175 gravadas" de "menos linhas no fim" sem
   * que nada tenha se perdido.
   */
  estrategia: 'APPEND' | 'CONVERGE';
  chaves: ChavePrevista[];
}

export interface PlanoDeProjecao {
  eventos: number;
  /** Quantas LINHAS sairiam. Uma venda vira cabeçalho e itens. */
  linhasPrevistas: number;
  porTipo: Record<string, { eventos: number; tabelas: string[] }>;
  porEmpresa: Record<string, number>;
  /**
   * Quantas linhas por TABELA e por EMPRESA.
   *
   * Conferir que a aterrissagem continua com 90 eventos da Preço Justo prova
   * que a aterrissagem não mudou — e nada sobre onde as LINHAS foram parar.
   * Um defeito que trocasse a empresa passaria por todas as outras
   * conferências: o total bate, os ids são os mesmos, o carimbo virou
   * não-nulo. E o gestor da Gringa veria a venda do Preço Justo.
   */
  porTabelaEmpresa: Record<string, Record<string, number>>;
  /**
   * Por tabela: operações × chaves distintas × as próprias chaves.
   *
   * É o que troca aritmética por verificação: o gate pergunta à central
   * "esta chave existe, e pertence a esta empresa?" em vez de comparar somas
   * que o UPSERT legitimamente encolhe.
   */
  porTabelaDetalhe: Record<string, DetalheDaTabela>;
  /**
   * Tabelas cuja linha não carrega empresa.
   *
   * `erp_companies` É a empresa; `erp_sale_items` pendura na venda. Contá-las
   * por empresa exigiria inventar de onde tirar o valor, e uma conferência
   * que inventa é pior que uma que se declara incapaz.
   */
  tabelasSemEmpresa: string[];
  desconhecidos: EventoDesconhecido[];
}

/**
 * O que cada evento VIRARIA, sem virar.
 *
 * Não estima e não adivinha: roda `project()` — a mesma e única tradução — sobre
 * os eventos de verdade, em memória, e conta o que sairia. Perguntar "quantos
 * eventos passariam" responde pouco antes de mexer em fatos reais; o que se
 * precisa saber é QUE tipo vira QUE tabela, e quantos de cada.
 *
 * Nada aqui toca a central nem o disco.
 */
export function planejarProjecao(eventos: EventoNaLanding[]): PlanoDeProjecao {
  const plano: PlanoDeProjecao = {
    eventos: eventos.length,
    linhasPrevistas: 0,
    porTipo: {},
    porEmpresa: {},
    porTabelaEmpresa: {},
    porTabelaDetalhe: {},
    tabelasSemEmpresa: [],
    desconhecidos: [],
  };

  for (const e of eventos) {
    plano.porEmpresa[e.company_id] = (plano.porEmpresa[e.company_id] ?? 0) + 1;

    const linhas = project(paraOutboxRow(e));
    if (linhas.length === 0) {
      /*
        Lista vazia é como `project()` diz "não conheço este tipo". Guardar o
        ID, e não só a contagem, é o que permite agir: "3 desconhecidos" não
        diz em qual fato olhar.
      */
      plano.desconhecidos.push({
        id: e.id,
        eventType: e.event_type,
        companyId: e.company_id,
      });
      continue;
    }

    plano.linhasPrevistas += linhas.length;
    const atual = plano.porTipo[e.event_type] ?? { eventos: 0, tabelas: [] };
    atual.eventos += 1;
    for (const l of linhas) {
      if (!atual.tabelas.includes(l.table)) atual.tabelas.push(l.table);

      /*
        A identidade da linha no destino é a CHAVE do upsert, serializada em
        ordem fixa de colunas — a mesma que o RPC usa no ON CONFLICT.
      */
      const colunas = Object.keys(l.key).sort();
      const serializada = colunas.map((c) => c + '=' + String(l.key[c])).join('|');
      const detalhe = plano.porTabelaDetalhe[l.table] ?? {
        operacoes: 0,
        chavesDistintas: 0,
        chaveColunas: colunas,
        estrategia: 'APPEND' as const,
        chaves: [] as ChavePrevista[],
      };
      detalhe.operacoes += 1;
      if (!detalhe.chaves.some((c) => c.chave === serializada)) {
        detalhe.chaves.push({
          chave: serializada,
          empresa: typeof l.row.company_id === 'string' && l.row.company_id
            ? l.row.company_id
            : null,
        });
      }
      detalhe.chavesDistintas = detalhe.chaves.length;
      detalhe.estrategia =
        detalhe.chavesDistintas === detalhe.operacoes ? 'APPEND' : 'CONVERGE';
      plano.porTabelaDetalhe[l.table] = detalhe;

      /*
        A empresa sai da LINHA, não do evento. São iguais quando o projetor
        está certo — e é exatamente isso que a conferência precisa medir, em
        vez de assumir.
      */
      const empresa = l.row.company_id;
      if (typeof empresa !== 'string' || !empresa) {
        if (!plano.tabelasSemEmpresa.includes(l.table)) plano.tabelasSemEmpresa.push(l.table);
        continue;
      }
      const porTabela = plano.porTabelaEmpresa[l.table] ?? {};
      porTabela[empresa] = (porTabela[empresa] ?? 0) + 1;
      plano.porTabelaEmpresa[l.table] = porTabela;
    }
    atual.tabelas.sort();
    plano.porTipo[e.event_type] = atual;
  }

  plano.tabelasSemEmpresa.sort();
  return plano;
}

export interface FalhaDeReprojecao {
  id: string;
  companyId: string;
  eventType: string;
  motivo: string;
}

export interface ResultadoDaReprojecao {
  ensaio: boolean;
  pendentesEncontrados: number;
  eventosProjetados: number;
  linhasGravadas: number;
  puladasPorOrdem: number;
  /** Tipos que esta central ainda não entende. Continuam esperando. */
  desconhecidos: number;
  /** Os mesmos, com id e tipo: "3 desconhecidos" não diz onde olhar. */
  desconhecidosDetalhados: EventoDesconhecido[];
  /**
   * Parou sem projetar nada, por haver fato que ninguém sabe traduzir.
   *
   * Não é falha: é a recusa a decidir sozinho sobre dado real.
   */
  abortado: boolean;
  falhas: FalhaDeReprojecao[];
  porEmpresa: Record<string, number>;
  /**
   * Quantas linhas foram para cada tabela.
   *
   * `projected_at` ter mudado não prova que a linha existe. Sem esta conta,
   * "sucesso" quer dizer apenas "o carimbo foi gravado".
   */
  porTabela: Record<string, number>;
}

/**
 * Converte o evento da aterrissagem para a forma que `project()` espera.
 *
 * As duas diferenças são de armazenamento, não de conteúdo: a central chama de
 * `node_seq` o que a fila local chama de `seq`, e guarda o payload como `jsonb`
 * enquanto o `OutboxRow` o carrega como texto. Os campos de controle da fila
 * (`status`, `attempts`, `sent_at`) não existem lá e não são usados pela
 * projeção — vão preenchidos com valor neutro para o tipo fechar.
 */
export function paraOutboxRow(e: EventoNaLanding): OutboxRow {
  return {
    seq: e.node_seq ?? 0,
    id: e.id,
    node_id: e.node_id,
    event_type: e.event_type,
    aggregate_type: e.aggregate_type,
    aggregate_id: e.aggregate_id,
    company_id: e.company_id,
    operational_unit_id: e.operational_unit_id,
    operation: e.operation,
    schema_version: e.schema_version,
    payload: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {}),
    occurred_at: e.occurred_at,
    status: 'synced',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    sent_at: null,
    created_at: e.occurred_at,
  };
}

/** Teto de voltas. Guarda contra laço, não regra de negócio. */
const MAXIMO_DE_VOLTAS = 1000;

export async function reprojetarPendentes(input: {
  leitor: LandingReader;
  transporte: ProjectionTransport;
  /** Quantos eventos por chamada à central. */
  tamanhoDoLote?: number;
  /** Só conta o que faria; não projeta e não carimba. */
  ensaio?: boolean;
  /** Teto de eventos por execução. Sem isto, uma varredura inteira. */
  maximo?: number;
  /**
   * Seguir mesmo havendo evento que nenhum projetor traduz.
   *
   * O padrão é PARAR. No dia a dia, dentro de `syncOnce`, pular o
   * desconhecido é o certo — a central pode ser mais antiga que o nó, e
   * derrubar a fila por um tipo novo seria pior. Numa reprojeção
   * administrativa de fatos reais, não: quem roda precisa saber, ANTES de
   * qualquer escrita, que existe fato que ninguém sabe traduzir.
   */
  seguirComDesconhecidos?: boolean;
}): Promise<ResultadoDaReprojecao> {
  const tamanho = Math.max(1, input.tamanhoDoLote ?? 50);
  const ensaio = input.ensaio === true;

  const resultado: ResultadoDaReprojecao = {
    ensaio,
    pendentesEncontrados: await input.leitor.contarNaoProjetados(),
    eventosProjetados: 0,
    linhasGravadas: 0,
    puladasPorOrdem: 0,
    desconhecidos: 0,
    desconhecidosDetalhados: [],
    abortado: false,
    falhas: [],
    porEmpresa: {},
    porTabela: {},
  };

  /*
    A VARREDURA DE RECONHECIMENTO, antes de escrever qualquer coisa.

    Ela lê tudo o que está pendente e passa pelo projetor em memória. É o
    que permite recusar a execução inteira quando aparece um fato que
    ninguém sabe traduzir — em vez de escrever metade e descobrir depois.
  */
  const paraReconhecer = await input.leitor.lerNaoProjetados(
    input.maximo ?? Number.MAX_SAFE_INTEGER,
  );
  const plano = planejarProjecao(paraReconhecer);
  resultado.desconhecidos = plano.desconhecidos.length;
  resultado.desconhecidosDetalhados = plano.desconhecidos;

  if (ensaio) return resultado;

  if (plano.desconhecidos.length > 0 && input.seguirComDesconhecidos !== true) {
    resultado.abortado = true;
    return resultado;
  }

  /*
    Os que falharam continuam com `projected_at` nulo — e por isso voltariam na
    leitura seguinte, para sempre. Este conjunto os tira do caminho DESTA
    execução, sem mentir sobre o estado deles na central.
  */
  const jaTentados = new Set<string>();
  let processados = 0;

  for (let volta = 0; volta < MAXIMO_DE_VOLTAS; volta += 1) {
    if (input.maximo !== undefined && processados >= input.maximo) break;

    // Pede mais do que o lote para compensar os já tentados que ainda voltam.
    const lidos = await input.leitor.lerNaoProjetados(tamanho + jaTentados.size);
    const lote = lidos.filter((e) => !jaTentados.has(e.id)).slice(0, tamanho);
    if (lote.length === 0) break;

    for (const e of lote) jaTentados.add(e.id);
    processados += lote.length;

    await projetarUmLote(lote, input, resultado);
  }

  return resultado;
}

/**
 * Projeta um lote e carimba o que foi confirmado.
 *
 * O lote inteiro vai numa chamada só — projetar evento a evento faria 118
 * fatos custarem 118 viagens de rede, e a central remota é a parte cara.
 *
 * Quando a chamada FALHA, a estratégia muda: reduz para um evento por vez e
 * isola o culpado. Sem isso, um único evento problemático deixaria os outros
 * 117 parados, e o relatório diria apenas "o lote falhou".
 */
async function projetarUmLote(
  lote: EventoNaLanding[],
  input: { leitor: LandingReader; transporte: ProjectionTransport },
  resultado: ResultadoDaReprojecao,
): Promise<void> {
  try {
    await aplicar(lote, input, resultado);
    return;
  } catch {
    // Cai para o modo isolado. O erro de cada um é registrado lá dentro.
  }

  if (lote.length === 1) {
    // Já estava isolado: o erro é deste evento mesmo.
    await aplicarIsolado(lote[0], input, resultado);
    return;
  }

  for (const e of lote) {
    await aplicarIsolado(e, input, resultado);
  }
}

async function aplicar(
  lote: EventoNaLanding[],
  input: { leitor: LandingReader; transporte: ProjectionTransport },
  resultado: ResultadoDaReprojecao,
): Promise<void> {
  const linhas = lote.map(paraOutboxRow);
  const r = await projetarLote(linhas, input.transporte);

  /*
    De que tabela é cada linha que acabou de entrar. Calculado pelo MESMO
    `project()` que produziu as linhas — não por um segundo mapa.
  */
  for (const l of linhas) {
    if (!r.projectedIds.includes(l.id)) continue;
    for (const proj of project(l)) {
      resultado.porTabela[proj.table] = (resultado.porTabela[proj.table] ?? 0) + 1;
    }
  }

  resultado.linhasGravadas += r.written;
  resultado.puladasPorOrdem += r.skippedByOrder;
  /*
    `desconhecidos` já veio da varredura de reconhecimento, sobre o conjunto
    inteiro. Somar de novo aqui contaria o mesmo evento duas vezes.
  */

  /*
    SÓ AGORA o carimbo, e só nos ids que a central confirmou.

    `projectedIds` traz os eventos que produziram linha. Tipo desconhecido não
    entra: a central pode ser mais antiga que o nó, e carimbar o que não virou
    linha apagaria o fato do radar.
  */
  if (r.projectedIds.length > 0) {
    await input.leitor.marcarProjetados(r.projectedIds);
    resultado.eventosProjetados += r.projectedIds.length;
    for (const e of lote) {
      if (!r.projectedIds.includes(e.id)) continue;
      resultado.porEmpresa[e.company_id] = (resultado.porEmpresa[e.company_id] ?? 0) + 1;
    }
  }
}

async function aplicarIsolado(
  e: EventoNaLanding,
  input: { leitor: LandingReader; transporte: ProjectionTransport },
  resultado: ResultadoDaReprojecao,
): Promise<void> {
  try {
    await aplicar([e], input, resultado);
  } catch (err) {
    resultado.falhas.push({
      id: e.id,
      companyId: e.company_id,
      eventType: e.event_type,
      motivo: err instanceof Error ? err.message : 'Falha ao projetar.',
    });
  }
}

/**
 * O leitor real, via PostgREST.
 *
 * `GET` para ler e `PATCH` para carimbar. Não há verbo de inserção aqui, e a
 * ausência é o ponto: este módulo nunca devolve evento para a aterrissagem.
 */
export function supabaseLandingReader(config: {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): LandingReader {
  const http = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, '');
  const cabecalhos = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
  };
  const COLUNAS =
    'id,node_id,event_type,aggregate_type,aggregate_id,company_id,'
    + 'operational_unit_id,operation,schema_version,payload,occurred_at,node_seq';

  return {
    name: 'supabase',

    async lerNaoProjetados(limite) {
      // `node_seq` crescente: a ordem em que os fatos aconteceram no nó.
      const url =
        `${base}/rest/v1/erp_sync_events?select=${COLUNAS}`
        + `&projected_at=is.null&order=node_seq.asc&limit=${limite}`;
      const r = await http(url, { headers: cabecalhos });
      if (!r.ok) {
        const corpo = await r.text().catch(() => '');
        throw new Error(
          `A central recusou a leitura da aterrissagem (HTTP ${r.status}). ${corpo.slice(0, 200)}`,
        );
      }
      return (await r.json()) as EventoNaLanding[];
    },

    async contarNaoProjetados() {
      const r = await http(
        `${base}/rest/v1/erp_sync_events?select=id&projected_at=is.null`,
        { headers: { ...cabecalhos, Prefer: 'count=exact', Range: '0-0' } },
      );
      if (!r.ok) {
        throw new Error(`A central recusou a contagem (HTTP ${r.status}).`);
      }
      const faixa = r.headers.get('content-range') ?? '';
      const n = Number(String(faixa).split('/')[1]);
      return Number.isFinite(n) ? n : 0;
    },

    async marcarProjetados(ids) {
      /*
        A MESMA implementação que o fluxo normal usa — uma só, exportada por
        CentralProjection. Duas cópias do mesmo PATCH divergiriam no primeiro
        detalhe (o filtro is.null, o Prefer, o formato do erro).
      */
      return carimbarProjetadosNaLanding(
        { url: config.url, serviceRoleKey: config.serviceRoleKey, fetchImpl: config.fetchImpl },
        ids,
      );
    },
  };
}
