/**
 * O CLIENTE NÃO ESCOLHE O PROVIDER DOS ATOS FISCAIS — GAP-PRD-005.
 *
 * `cancelFiscalDocument`, `createCorrectionLetter` e `createVoidRange`
 * mandavam `developmentMode: true` em todo pedido: a tela só alcançava o
 * SIMULADOR. Em homologação a nota real ficava "cancelada" com protocolo de
 * ensaio; em produção o botão morria. Este arquivo cobra o CORPO que sai
 * pela rede — o que a tela manda de verdade.
 *
 * ## Como fica vermelho
 *
 * Volte `developmentMode: true` em qualquer um dos três e o caso dele falha.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreApi } from '../core';

function servidor() {
  const corpos: { url: string; metodo: string; corpo: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      corpos.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ accepted: true, sequence: 1, protocol: '1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return corpos;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('os três atos saem sem developmentMode', () => {
  it('cancelamento: só a justificativa — e a senha quando alguém a digitou', async () => {
    const corpos = servidor();
    await coreApi.cancelFiscalDocument('doc-1', 'Venda digitada em duplicidade');
    await coreApi.cancelFiscalDocument('doc-1', 'Venda digitada em duplicidade', 'senha-do-a1');

    expect(corpos[0].url).toContain('/core/fiscal/documents/doc-1/cancel');
    expect(corpos[0].corpo).toEqual({ justification: 'Venda digitada em duplicidade' });
    expect(corpos[0].corpo).not.toHaveProperty('developmentMode');
    expect(corpos[1].corpo).toEqual({
      justification: 'Venda digitada em duplicidade',
      certificatePassword: 'senha-do-a1',
    });
  });

  it('carta de correção: só o texto', async () => {
    const corpos = servidor();
    await coreApi.createCorrectionLetter('doc-2', 'Corrigir o complemento do endereco');
    expect(corpos[0].corpo).toEqual({ text: 'Corrigir o complemento do endereco' });
    expect(corpos[0].corpo).not.toHaveProperty('developmentMode');
  });

  it('inutilização: o pedido inteiro, com o ano — sem developmentMode e sem senha vazia', async () => {
    const corpos = servidor();
    await coreApi.createVoidRange({
      model: '65',
      serie: 1,
      year: 2025,
      from: 10,
      to: 12,
      justification: 'Queda de energia no meio da emissao',
      certificatePassword: '',
    });
    expect(corpos[0].corpo).toEqual({
      model: '65',
      serie: 1,
      year: 2025,
      from: 10,
      to: 12,
      justification: 'Queda de energia no meio da emissao',
    });
  });
});
