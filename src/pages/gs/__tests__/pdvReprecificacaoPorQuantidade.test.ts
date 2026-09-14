/**
 * A FAIXA DE PREÇO POR QUANTIDADE CHEGA AO PDV — a regra, sem a tela
 * (G-offline-sync-M01).
 *
 * A marca de precificação dizia só PARA QUEM a linha foi precificada. A faixa
 * do Gestor ("a partir de 3: R$ 3,33") depende da QUANTIDADE, e bipar o mesmo
 * item três vezes não reprecificava: a tela cobrava 3 × R$ 4,00 e o servidor
 * fechava por 3 × R$ 3,33 — recusando o cartão ("troco só sobre dinheiro") e,
 * no dinheiro, lançando um troco que ninguém devolveu.
 *
 * Como fica vermelho: tire a comparação de quantidade de
 * `linhasParaReprecificar` e o primeiro caso não vê a linha pendente; ignore
 * `quantidades` em `aplicarPrecificacao` e a resposta da quantidade velha marca
 * a linha nova como precificada.
 */
import { describe, expect, it } from 'vitest';
import type { CarrinhoPrecificado, Product } from '@/lib/api/core';
import type { CartLine } from '../pdvTypes';
import { aplicarPrecificacao, linhasParaReprecificar } from '../pdvReprecificacao';

const SABONETE: Product = {
  id: 'p-sabonete',
  internal_code: 'PJ-0010',
  sku: null,
  barcode: '7890000000101',
  name: 'Sabonete',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 150,
  price_cents: 400,
  effective_price_cents: 400,
  on_sale: false,
  min_stock: 0,
  active: 1,
  open_price: 0,
};

function linha(extra: Partial<CartLine> = {}): CartLine {
  return { product: SABONETE, quantity: 1, unitPriceCents: 400, precificadaPara: null, ...extra };
}

const FAIXA_DE_3: CarrinhoPrecificado = {
  items: [{ productId: 'p-sabonete', priceCents: 333, listPriceCents: 400, onSale: true, fonte: 'faixa' }],
  priceTable: null,
};

describe('a quantidade faz parte da marca', () => {
  it('a linha nascida da busca (uma unidade) NÃO pede preço — o caso mais comum não vai ao servidor', () => {
    expect(linhasParaReprecificar([linha()], null)).toHaveLength(0);
  });

  it('a mesma linha com 3 unidades (três bipes) fica PENDENTE, mesmo sem cliente', () => {
    expect(linhasParaReprecificar([linha({ quantity: 3 })], null)).toHaveLength(1);
  });

  it('a resposta do servidor para 3 unidades põe o preço da faixa e marca a quantidade', () => {
    const [depois] = aplicarPrecificacao([linha({ quantity: 3 })], FAIXA_DE_3, null, ['p-sabonete'], {
      'p-sabonete': 3,
    });
    expect(depois.unitPriceCents).toBe(333);
    expect(depois.precificadaQtd).toBe(3);
    expect(linhasParaReprecificar([depois], null)).toHaveLength(0);
  });

  it('a linha que mudou de quantidade durante a ida ao servidor continua pendente', () => {
    // Perguntou-se por 3; enquanto isso, o quarto bipe chegou.
    const [depois] = aplicarPrecificacao([linha({ quantity: 4 })], FAIXA_DE_3, null, ['p-sabonete'], {
      'p-sabonete': 3,
    });
    expect(depois.unitPriceCents).toBe(400);
    expect(linhasParaReprecificar([depois], null)).toHaveLength(1);
  });

  it('voltar a quantidade para 1 também reprecifica — a faixa deixa de valer', () => {
    const naFaixa = linha({ quantity: 1, unitPriceCents: 333, precificadaQtd: 3 });
    expect(linhasParaReprecificar([naFaixa], null)).toHaveLength(1);
  });
});
