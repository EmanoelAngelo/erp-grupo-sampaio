/**
 * A projeção do lado de lá: das linhas projetadas para as tabelas da central.
 *
 * O QUE FALTAVA. A fila subia o fato bruto para `erp_sync_events` e parava ali.
 * As tabelas de negócio de `02-central-schema.sql` — vendas, produtos, notas —
 * ficavam vazias para sempre, e `projected_at` nunca era preenchido: existe
 * até um índice para "ainda não projetado" que nenhuma linha de código usava.
 * O `Projector` só era exercitado por teste, contra a central em memória.
 *
 * Uma central que recebe eventos e não os projeta não é uma central: é um log.
 * O gestor abriria o consolidado do grupo e veria zero.
 *
 * POR QUE UMA RPC, E NÃO UPSERT DIRETO
 *
 * A guarda de ordem é a razão. `Prefer: resolution=merge-duplicates` sobrescreve
 * a linha sem olhar nada — e um evento antigo chegando atrasado apagaria estado
 * novo, fazendo um pedido entregue voltar a "criado" na frente do cliente.
 * A guarda precisa de `ON CONFLICT ... WHERE excluded.node_seq >= atual`, que
 * PostgREST não expressa. Então a decisão fica no Postgres, numa função, e o
 * mapeamento continua um só, aqui em TypeScript.
 *
 * O QUE ESTE MÓDULO NÃO PODE AFIRMAR
 *
 * A função SQL correspondente vive em `docs/supabase/03-projecao.sql` e só roda
 * num Postgres de verdade. Sem a credencial da central ela NÃO foi executada
 * uma vez sequer — o que está testado aqui é o lado do nó: quais linhas são
 * montadas, com que chave, em que ordem e o que acontece quando a central
 * recusa. O estado honesto disso é `READY_FOR_CREDENTIAL`, e a tela diz isso.
 */
import type { Projection } from './Projector.js';
import type { OutboxRow } from './OutboxService.js';
import { projectBatch, type CentralWriter } from './Projector.js';

/** Nome da função no Postgres. Precisa bater com `docs/supabase/03-projecao.sql`. */
export const RPC_PROJECAO = 'erp_apply_projections';

/**
 * Como o nó fala com a central para projetar.
 *
 * Separado do transporte de eventos de propósito: entregar o fato e projetá-lo
 * são falhas distintas. Se a projeção quebrar, o fato já está salvo na
 * aterrissagem; fosse a mesma operação, um erro de projeção significaria fato
 * perdido.
 *
 * E refazer a projeção depois é o trabalho de `Reprojection.ts`, com comando
 * próprio (`reprojetar-central.js`). Esta frase já esteve aqui como promessa
 * solta: dizia que a projeção "pode ser refeita" quando nada a refazia —
 * `projetarLote` tinha um único chamador, dentro do envio, e ele só enxerga o
 * lote que está saindo agora. Evento já `synced` na fila local nunca mais era
 * alcançado.
 */
export interface ProjectionTransport {
  name: string;
  isTest?: boolean;
  /** Envia as linhas e devolve quantas a central gravou e quantas recusou por ordem. */
  apply(
    projections: Projection[],
  ): Promise<{ written: number; skippedByOrder: number }>;
  /**
   * Carimba `projected_at` na aterrissagem — DEPOIS da confirmação, e só nos
   * ids que a central aceitou.
   *
   * Opcional porque os dublês de teste não precisam saber de carimbo. Mas o
   * transporte REAL precisa: até 30/08/2026 o único escritor de
   * `projected_at` era a reprojeção administrativa, e o fluxo normal deixava
   * todo evento novo como "não projetado" para sempre — a linha de negócio
   * existia e a aterrissagem mentia.
   */
  marcarProjetados?(ids: string[]): Promise<number>;
}

/** Colunas de um `Projection`, na forma que a função SQL espera. */
function paraSql(p: Projection) {
  return {
    table_name: p.table,
    key_columns: p.key,
    row_data: p.row,
    guard_by_order: p.guardByOrder,
  };
}

/**
 * Transporte real, via PostgREST.
 *
 * O lote inteiro vai numa chamada só: projetar linha a linha faria uma venda de
 * dez itens custar onze viagens de rede, e a central remota é a parte cara.
 */
/**
 * O carimbo em si, exportado porque DUAS portas o usam: o fluxo normal (via
 * transporte) e a reprojeção (via leitor da aterrissagem). Uma implementação
 * só — duas divergiriam no primeiro detalhe.
 *
 * O filtro `projected_at=is.null` preserva o carimbo de quem chegou antes: ele
 * é o instante em que a projeção foi CONFIRMADA, e reescrevê-lo apagaria essa
 * informação.
 */
export async function carimbarProjetadosNaLanding(
  config: { url: string; serviceRoleKey: string; fetchImpl?: typeof fetch },
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const http = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, '');
  const lista = ids.map((i) => `"${i}"`).join(',');
  const r = await http(
    `${base}/rest/v1/erp_sync_events?id=in.(${lista})&projected_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ projected_at: new Date().toISOString() }),
    },
  );
  if (!r.ok) {
    throw new Error(`A central recusou o carimbo de projeção (HTTP ${r.status}).`);
  }
  const linhas = (await r.json().catch(() => [])) as unknown[];
  return Array.isArray(linhas) ? linhas.length : 0;
}

export function supabaseProjectionTransport(config: {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): ProjectionTransport {
  const http = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, '');

  return {
    name: 'supabase',
    async marcarProjetados(ids) {
      return carimbarProjetadosNaLanding(
        { url: config.url, serviceRoleKey: config.serviceRoleKey, fetchImpl: config.fetchImpl },
        ids,
      );
    },
    async apply(projections) {
      if (projections.length === 0) return { written: 0, skippedByOrder: 0 };

      const resposta = await http(`${base}/rest/v1/rpc/${RPC_PROJECAO}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
        },
        body: JSON.stringify({ payload: projections.map(paraSql) }),
      });

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        throw new Error(
          `A central recusou a projeção (HTTP ${resposta.status}). ${corpo.slice(0, 200)}`,
        );
      }

      const dados = (await resposta.json().catch(() => null)) as
        | { written?: number; skipped_by_order?: number }
        | null;

      // Sem resposta legível não se INVENTA sucesso: dizer que gravou o que
      // não se sabe ter gravado é a forma de o consolidado ficar errado em
      // silêncio.
      if (!dados || typeof dados.written !== 'number') {
        throw new Error('A central não informou quantas linhas gravou.');
      }
      return { written: dados.written, skippedByOrder: dados.skipped_by_order ?? 0 };
    },
  };
}

export interface ProjectionResult {
  written: number;
  skippedByOrder: number;
  unknownEvents: number;
  /** Ids dos eventos cuja projeção a central aceitou. */
  projectedIds: string[];
}

/**
 * Projeta um lote de eventos já entregues.
 *
 * Roda DEPOIS da entrega e nunca antes: projetar um fato que a central não
 * recebeu criaria linha de negócio sem o fato que a originou, e a reconciliação
 * apontaria uma diferença que ninguém saberia explicar.
 *
 * Evento de tipo desconhecido não derruba o lote — a central pode ser mais
 * antiga que o nó. O fato fica na aterrissagem, esperando a central subir de
 * versão, e é por isso que ele NÃO entra em `projectedIds`.
 */
export async function projetarLote(
  eventos: OutboxRow[],
  transporte: ProjectionTransport,
): Promise<ProjectionResult> {
  const linhas: Projection[] = [];
  const projetados: string[] = [];

  // Acumulador com a interface do escritor: reaproveita `projectBatch` — o
  // mesmo código que os testes exercitam — só que juntando as linhas em vez de
  // gravar.
  const acumulador: CentralWriter = {
    apply(projections) {
      linhas.push(...projections);
      return { written: projections.length, skippedByOrder: 0 };
    },
  };

  const ordenados = [...eventos].sort((a, b) => a.seq - b.seq);
  let desconhecidos = 0;
  for (const evento of ordenados) {
    const antes = linhas.length;
    const r = projectBatch([evento], acumulador);
    desconhecidos += r.unknownEvents;
    if (linhas.length > antes) projetados.push(evento.id);
  }

  if (linhas.length === 0) {
    return { written: 0, skippedByOrder: 0, unknownEvents: desconhecidos, projectedIds: [] };
  }

  const resultado = await transporte.apply(linhas);
  return {
    written: resultado.written,
    skippedByOrder: resultado.skippedByOrder,
    unknownEvents: desconhecidos,
    projectedIds: projetados,
  };
}
