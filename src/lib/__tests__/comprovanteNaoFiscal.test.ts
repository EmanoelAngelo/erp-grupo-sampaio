/**
 * O COMPROVANTE OFFLINE DIZ A LOJA, E A JANELA FECHA DEPOIS DO PAPEL
 * (auditoria PJ, F-cupom-fiscal-20#reauditoria).
 *
 * O comprovante que o PDV monta sozinho na venda offline saía só com o nome
 * fantasia — sem CNPJ, sem endereço, sem telefone —, e a janela de impressão
 * ficava aberta atrás do PDV depois de cada venda.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlDoComprovanteNaoFiscal, imprimirComprovanteNaoFiscal, type DadosDoComprovante } from '../comprovanteNaoFiscal';

const base: DadosDoComprovante = {
  loja: 'Preço Justo',
  quando: new Date('2026-09-14T10:00:00-03:00'),
  identificacao: 'Venda offline · código A1B2',
  itens: [{ descricao: 'Arroz 5 kg', quantidade: 0.5, unitarioCents: 2990, totalCents: 1495 }],
  subtotalCents: 1495,
  descontoCents: 0,
  acrescimoCents: 0,
  totalCents: 1495,
  pagamentos: [{ rotulo: 'Dinheiro', valorCents: 2000 }],
  trocoCents: 505,
  offline: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('F-cupom-fiscal-20 — o comprovante offline diz de qual loja o cliente comprou', () => {
  it('leva CNPJ, endereço e telefone guardados da resposta da gaveta', () => {
    const html = htmlDoComprovanteNaoFiscal({
      ...base,
      cnpj: '12.345.678/0001-90',
      endereco: 'Rua das Palmeiras, 128 — Centro · Macapá · AP',
      telefone: '(96) 99999-1234',
    });
    // Antes: nenhuma das três linhas existia no papel offline.
    expect(html).toContain('CNPJ 12.345.678/0001-90');
    expect(html).toContain('Rua das Palmeiras, 128 — Centro · Macapá · AP');
    expect(html).toContain('Fone (96) 99999-1234');
    // E continua dizendo o que é.
    expect(html).toContain('COMPROVANTE NÃO FISCAL');
    expect(html).toContain('0,5 x');
  });

  it('sem nada guardado (caixa que nunca falou com o servidor), o papel sai sem as linhas — e não com "CNPJ null"', () => {
    const html = htmlDoComprovanteNaoFiscal({ ...base, cnpj: null, endereco: null, telefone: null });
    expect(html).not.toContain('CNPJ');
    expect(html).not.toContain('null');
    expect(html).not.toContain('class="sub"');
  });

  it('o endereço é texto, e não HTML', () => {
    const html = htmlDoComprovanteNaoFiscal({ ...base, endereco: 'Rua <b>A</b> & Cia' });
    expect(html).toContain('Rua &lt;b&gt;A&lt;/b&gt; &amp; Cia');
  });
});

describe('F-cupom-fiscal-20 — a janela de impressão fecha depois do papel', () => {
  function janelaFalsa() {
    const ouvintes: Record<string, (() => void)[]> = {};
    const ordem: string[] = [];
    const janela = {
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(() => ordem.push('print')),
      close: vi.fn(),
      addEventListener: vi.fn((tipo: string, fn: () => void) => {
        ordem.push(`ouvir:${tipo}`);
        (ouvintes[tipo] ??= []).push(fn);
      }),
    };
    return { janela, ouvintes, ordem };
  }

  it('registra o afterprint ANTES do print, e o afterprint fecha a janela', () => {
    const { janela, ouvintes, ordem } = janelaFalsa();
    vi.spyOn(window, 'open').mockReturnValue(janela as unknown as Window);

    expect(imprimirComprovanteNaoFiscal('<p>papel</p>')).toBe(true);
    // Antes: ninguém ouvia o afterprint, e a janela ficava aberta atrás do PDV.
    expect(ordem.indexOf('ouvir:afterprint')).toBeGreaterThan(-1);
    expect(ordem.indexOf('ouvir:afterprint')).toBeLessThan(ordem.indexOf('print'));
    expect(janela.close).not.toHaveBeenCalled();

    for (const fn of ouvintes.afterprint ?? []) fn();
    expect(janela.close).toHaveBeenCalledTimes(1);
  });

  it('pop-up bloqueado continua respondendo false, sem erro', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(imprimirComprovanteNaoFiscal('<p>papel</p>')).toBe(false);
  });
});
