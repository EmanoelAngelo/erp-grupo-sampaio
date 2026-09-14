/**
 * O CUPOM QUE O AGENTE NÃO PEGOU A TEMPO NÃO SAI DEPOIS — F-cupom-fiscal-09.
 *
 * Vencido o prazo da tela com o job ainda `ready`, `printDocument` só dizia "não
 * confirmou" e o job ficava na fila. O caixa pedia Imprimir de novo, nascia um
 * segundo job, e o agente, ao voltar, imprimia OS DOIS — no meio do atendimento
 * de outro cliente.
 *
 * O COMPORTAMENTO MUDOU NESTA RODADA, e é por isso que o servidor deste teste
 * mudou junto: a desistência era "reler o job; se ainda `ready`, mandar
 * `cancelled` por `/status`". Entre as duas idas o agente podia pegar o cupom, e
 * o servidor aceita `printing → cancelled`: a tela dizia "cancelado" e o papel
 * saía. Agora a tela chama `POST /print/jobs/:id/desistir`, que cancela SÓ se o
 * job ainda está `ready`, na mesma instrução — 200 é cancelado de verdade; 409
 * `CORE_PRINT_JOB_TAKEN` é "o agente já pegou", e o estado de agora diz o resto.
 *
 * Como fica vermelho: volte `desistirDoJobDoAgente` à releitura + `/status` e o
 * primeiro caso vê um `cancelled` por `/status` (a janela da corrida); tire o
 * ramo de `printing` e o segundo recebe a frase de "reimprima".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setSession } from '@/lib/api/client';
import { printDocument } from '@/lib/print';

const RAPIDO = { intervaloMs: 5, prazoMs: 40 };

let chamadas: { url: string; metodo: string; corpo: Record<string, unknown> | null }[];
/** O estado que o agente "tem" do job enquanto a tela acompanha. */
let estadoNoAgente: 'ready' | 'printing';
/** Como o servidor responde à desistência. */
let desistencia: 'aceita' | 'ja-pegou' | 'rede';
/** O que a releitura mostra DEPOIS de a desistência não valer. */
let estadoDepois: 'printed' | 'ready' | 'failed' | 'printing';
let desistiu: boolean;

function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: u, metodo, corpo });
      if (u.endsWith('/core/print/jobs') && metodo === 'POST') {
        return responder({ id: 'job-9', status: 'ready', transport: 'agent', fallback_reason: null }, 201);
      }
      if (u.includes('/core/print/jobs/job-9/desistir') && metodo === 'POST') {
        desistiu = true;
        if (desistencia === 'rede') throw new TypeError('Failed to fetch');
        if (desistencia === 'ja-pegou') {
          return responder(
            { error: { code: 'CORE_PRINT_JOB_TAKEN', message: 'O agente do caixa já pegou este cupom.' } },
            409,
          );
        }
        return responder({ id: 'job-9', status: 'cancelled', transport: 'agent', error: corpo?.motivo ?? null });
      }
      if (u.includes('/core/print/jobs/job-9/status') && metodo === 'POST') {
        return responder({ id: 'job-9', status: corpo?.status, transport: 'agent', error: corpo?.error ?? null });
      }
      if (u.includes('/core/print/jobs/job-9')) {
        const status = desistiu ? estadoDepois : estadoNoAgente;
        return responder({
          id: 'job-9',
          status,
          transport: 'agent',
          error: status === 'failed' ? 'Impressora sem papel' : null,
        });
      }
      return responder({});
    }),
  );
}

beforeEach(() => {
  chamadas = [];
  estadoNoAgente = 'ready';
  desistencia = 'aceita';
  estadoDepois = 'printed';
  desistiu = false;
  setSession(
    {
      accessToken: 'token-do-caixa',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do agente que não pegou o cupom',
  );
  servidor();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste do agente');
});

describe('o prazo venceu com o job na fila do agente', () => {
  it('a tela DESISTE pela rota atômica, e só então diz que ele não sai mais', async () => {
    await expect(
      printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO }),
    ).rejects.toThrow(/cancelado para não sair depois/);
    expect(chamadas.some((c) => c.url.includes('/core/print/jobs/job-9/desistir') && c.metodo === 'POST')).toBe(true);
    // O caminho da corrida saiu: nenhum `cancelled` por `/status`.
    expect(chamadas.some((c) => c.corpo?.status === 'cancelled')).toBe(false);
  });

  it('o agente já está imprimindo: NÃO desiste, e manda aguardar o papel em vez de reimprimir', async () => {
    estadoNoAgente = 'printing';
    await expect(
      printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO }),
    ).rejects.toThrow(/aguarde o papel/);
    expect(desistiu).toBe(false);
  });

  it('o agente pegou antes da desistência (409): a tela relê, e o impresso é sucesso', async () => {
    desistencia = 'ja-pegou';
    estadoDepois = 'printed';
    const feita = await printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO });
    expect(feita.status).toBe('printed');
    expect(feita.via).toBe('agente');
  });

  it('o agente pegou e está imprimindo (409): "aguarde o papel", e nunca "cancelado"', async () => {
    desistencia = 'ja-pegou';
    estadoDepois = 'printing';
    const erro = await printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO }).catch(
      (e: unknown) => e as Error,
    );
    expect((erro as Error).message).toMatch(/aguarde o papel/);
    expect((erro as Error).message).not.toMatch(/cancelado/);
  });
});

/*
  "CANCELADO" SÓ QUANDO FOI. A desistência que não chegou ao servidor (a rede)
  e deixou o job AINDA na fila não é anunciada como feita: o caixa, confiante,
  pediria Imprimir de novo, e o agente imprimiria os dois.
*/
describe('a desistência que não valeu não é anunciada como feita', () => {
  it('a rede caiu na desistência com o job AINDA na fila: a tela avisa que o cupom pode sair', async () => {
    desistencia = 'rede';
    estadoDepois = 'ready';
    const erro = await printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO }).catch(
      (e: unknown) => e as Error,
    );
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toMatch(/ainda pode sair quando o agente voltar/);
    expect((erro as Error).message).not.toMatch(/cancelado para não sair depois/);
  });

  it('o agente FALHOU antes da desistência (409): a tela mostra o motivo dele', async () => {
    desistencia = 'ja-pegou';
    estadoDepois = 'failed';
    await expect(
      printDocument('SALE_RECEIPT', 'venda-1', { acompanhamento: RAPIDO }),
    ).rejects.toThrow(/Impressora sem papel/);
  });
});
