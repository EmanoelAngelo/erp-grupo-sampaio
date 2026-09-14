/**
 * Markup, margem e os mínimos.
 *
 * O caso que dá nome a este arquivo: custo 100, preço 150 é markup de 50% e
 * margem de 33,33%. Quem troca um pelo outro precifica achando que ganha 50%
 * quando ganha 33% — e o erro só aparece no fechamento do mês.
 */
import { describe, expect, it } from 'vitest';
import {
  avaliarPreco,
  custoDoKit,
  margemDe,
  markupDe,
  precoPorMargem,
  precoPorMarkup,
  quantidadeValida,
} from '../src/services/core/Pricing.js';

describe('markup e margem', () => {
  it('custo 100 e preço 150: markup 50%, margem 33,33%', () => {
    expect(markupDe(10000, 15000)).toBeCloseTo(50, 6);
    expect(margemDe(10000, 15000)).toBeCloseTo(33.3333, 3);
  });

  it('preço igual ao custo zera os dois', () => {
    expect(markupDe(10000, 10000)).toBe(0);
    expect(margemDe(10000, 10000)).toBe(0);
  });

  it('preço abaixo do custo dá markup negativo', () => {
    // O vídeo da referência mostra exatamente isto: custo 300, venda 200,
    // markup negativo até corrigirem o preço.
    expect(markupDe(30000, 20000)).toBeCloseTo(-33.3333, 3);
  });

  /**
   * Sem custo lançado não há markup — e mostrar "0,00%" seria mentir: zero por
   * cento afirma que se vende pelo custo, sobre um custo que não existe.
   */
  it('custo zero não vira markup zero: vira indefinido', () => {
    expect(markupDe(0, 15000)).toBeNull();
  });

  it('preço zero não tem margem', () => {
    expect(margemDe(10000, 0)).toBeNull();
  });
});

describe('o caminho de volta', () => {
  it('markup pedido devolve o preço que o produz', () => {
    const preco = precoPorMarkup(10000, 50);
    expect(preco).toBe(15000);
    expect(markupDe(10000, preco)).toBeCloseTo(50, 6);
  });

  it('margem pedida devolve o preço que a produz', () => {
    const preco = precoPorMargem(10000, 33.3333);
    expect(preco).not.toBeNull();
    expect(margemDe(10000, preco!)).toBeCloseTo(33.3333, 2);
  });

  it('margem de 100% ou mais é recusada, não arredondada', () => {
    expect(precoPorMargem(10000, 100)).toBeNull();
    expect(precoPorMargem(10000, 150)).toBeNull();
  });

  it('ida e volta pelo markup não acumula erro', () => {
    for (const markup of [10, 33.33, 75, 120]) {
      const preco = precoPorMarkup(4990, markup);
      expect(markupDe(4990, preco)).toBeCloseTo(markup, 1);
    }
  });
});

describe('mínimos do produto', () => {
  it('sem mínimo declarado, nada é violado', () => {
    const r = avaliarPreco(10000, 12000);
    expect(r.abaixoDoMinimo).toBe(false);
    expect(r.motivos).toEqual([]);
  });

  it('preço abaixo do mínimo é apontado com o valor', () => {
    const r = avaliarPreco(10000, 11000, { minPriceCents: 12000 });
    expect(r.abaixoDoMinimo).toBe(true);
    expect(r.motivos[0]).toContain('120.00');
  });

  it('markup abaixo do mínimo é apontado', () => {
    const r = avaliarPreco(10000, 10500, { minMarkupPercent: 20 });
    expect(r.abaixoDoMinimo).toBe(true);
    expect(r.motivos.join(' ')).toContain('markup');
  });

  it('margem abaixo do mínimo é apontada', () => {
    const r = avaliarPreco(10000, 11000, { minMarginPercent: 25 });
    expect(r.abaixoDoMinimo).toBe(true);
    expect(r.motivos.join(' ')).toContain('margem');
  });

  /** Três mínimos violados devem render três motivos, não um genérico. */
  it('acumula os motivos em vez de resumir', () => {
    const r = avaliarPreco(10000, 10100, {
      minPriceCents: 15000,
      minMarkupPercent: 30,
      minMarginPercent: 30,
    });
    expect(r.motivos).toHaveLength(3);
  });

  it('vender abaixo do custo é sinalizado à parte do mínimo', () => {
    const r = avaliarPreco(10000, 9000);
    expect(r.abaixoDoCusto).toBe(true);
    // Sem mínimo declarado, prejuízo não conta como violação de política.
    expect(r.abaixoDoMinimo).toBe(false);
  });
});

describe('casas decimais da unidade', () => {
  it('caixa (0 casas) não aceita meia caixa', () => {
    expect(quantidadeValida(2, 0)).toBe(true);
    expect(quantidadeValida(2.5, 0)).toBe(false);
  });

  it('arroba (3 casas) aceita fração fina', () => {
    expect(quantidadeValida(1.125, 3)).toBe(true);
    expect(quantidadeValida(1.1255, 3)).toBe(false);
  });

  it('quantidade zero ou negativa nunca vale', () => {
    expect(quantidadeValida(0, 3)).toBe(false);
    expect(quantidadeValida(-1, 0)).toBe(false);
  });
});

describe('custo do kit', () => {
  it('soma o custo das peças pela quantidade', () => {
    expect(
      custoDoKit([
        { quantity: 2, costCents: 1500 },
        { quantity: 1, costCents: 2000 },
      ]),
    ).toBe(5000);
  });

  it('kit sem peças custa zero', () => {
    expect(custoDoKit([])).toBe(0);
  });

  it('quantidade fracionária entra na conta', () => {
    expect(custoDoKit([{ quantity: 1.5, costCents: 1000 }])).toBe(1500);
  });
});
