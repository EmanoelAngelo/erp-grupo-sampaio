/**
 * ============================================================================
 * A FUNÇÃO DE PROJEÇÃO EXISTE NA CENTRAL? — perguntado sem gravar nada
 * (GAP-PRD-048)
 * ============================================================================
 *
 * Entregar o fato e projetá-lo são duas chamadas. A primeira grava na
 * aterrissagem (`erp_sync_events`); a segunda chama a função
 * `erp_apply_projections`, criada por `docs/supabase/03-projecao.sql`, que
 * transforma o fato em linha das tabelas do consolidado. Se a função não
 * existe, a entrega segue funcionando e o consolidado fica vazio — e o banco
 * da loja guardou um PGRST202 por dias sem que nada o lesse.
 *
 * A conferência chama a função com um lote VAZIO. A função percorre o array
 * (`jsonb_array_elements`) e devolve `{written: 0, skipped_by_order: 0}`: nada
 * é gravado, e a resposta separa os quatro casos:
 *
 *   PRONTA        — a função existe e aceitou a chamada;
 *   AUSENTE       — PGRST202: a função não existe; diz qual arquivo rodar;
 *   RECUSADA      — outra recusa (chave errada, permissão, erro da central);
 *   SEM_RESPOSTA  — a central não respondeu (rede, DNS, projeto pausado).
 *
 * A chave de serviço nunca aparece no texto devolvido.
 */
import { RPC_PROJECAO } from './CentralProjection.js';

export type EstadoDaRpcDeProjecao = 'PRONTA' | 'AUSENTE' | 'RECUSADA' | 'SEM_RESPOSTA';

export interface ConferenciaDaRpcDeProjecao {
  estado: EstadoDaRpcDeProjecao;
  /** Código HTTP da resposta; nulo quando não houve resposta. */
  http: number | null;
  /** O que aconteceu e o que fazer, em português, sem a chave. */
  detalhe: string;
}

export async function conferirRpcDeProjecao(config: {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ConferenciaDaRpcDeProjecao> {
  const http = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, '');
  const limpar = (texto: string): string =>
    config.serviceRoleKey ? texto.split(config.serviceRoleKey).join('<oculto>') : texto;

  let resposta: Response;
  try {
    resposta = await http(`${base}/rest/v1/rpc/${RPC_PROJECAO}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      // Lote vazio: a função existe e responde, e nenhuma linha é gravada.
      body: JSON.stringify({ payload: [] }),
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    return {
      estado: 'SEM_RESPOSTA',
      http: null,
      detalhe: limpar(`A central não respondeu à chamada da função ${RPC_PROJECAO}: ${motivo}`),
    };
  }

  const corpo = await resposta.text().catch(() => '');
  if (resposta.ok) {
    return {
      estado: 'PRONTA',
      http: resposta.status,
      detalhe: `A função ${RPC_PROJECAO} existe e aceitou um lote vazio — nada foi gravado.`,
    };
  }
  if (corpo.includes('PGRST202')) {
    return {
      estado: 'AUSENTE',
      http: resposta.status,
      detalhe:
        `A central não tem a função ${RPC_PROJECAO} (PGRST202): os fatos chegam à aterrissagem, `
        + 'mas o consolidado do grupo fica vazio. Rode docs/supabase/03-projecao.sql no SQL Editor '
        + 'do projeto, confira de novo e depois rode reprojetar-central para projetar o que ficou.',
    };
  }
  return {
    estado: 'RECUSADA',
    http: resposta.status,
    detalhe: limpar(
      `A central recusou a chamada da função ${RPC_PROJECAO} (HTTP ${resposta.status}). ${corpo.slice(0, 200)}`,
    ).trim(),
  };
}
