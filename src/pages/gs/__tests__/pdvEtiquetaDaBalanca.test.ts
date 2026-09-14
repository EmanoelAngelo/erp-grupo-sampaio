/**
 * A ETIQUETA DA BALANÇA NO PDV — a regra, fora da tela (D-pdv-teclado-16).
 *
 * O servidor lê a etiqueta (prefixo, PLU e peso ou preço embutidos) e devolve
 * `balanca` na linha do produto, com `matched_exact` em zero. A tela não lia o
 * campo: a etiqueta caía na lista e, escolhida, entrava com "1 kg".
 *
 * Como fica vermelho: faça `etiquetaDaBalancaUnica` devolver sempre nulo e a
 * etiqueta volta à lista; troque a tolerância por zero centavo e a etiqueta de
 * preço de um produto de R$ 199,90/kg é recusada pelo arredondamento do grama.
 */
import { describe, expect, it } from 'vitest';
import {
  etiquetaDaBalancaUnica,
  recusaDaEtiquetaDaBalanca,
  temEtiquetaDaBalanca,
  toleranciaDaEtiquetaDePrecoCents,
  type AchadoDaBalanca,
  type AchadoDaBusca,
  type LeituraDaBalanca,
} from '../pdvTypes';

function achado(over: Partial<AchadoDaBusca> = {}): AchadoDaBusca {
  return {
    id: 'q-1',
    internal_code: 'GS-Q1',
    sku: null,
    barcode: '7890000000901',
    name: 'QUEIJO MUÇARELA KG',
    category: null,
    brand: null,
    unit: 'KG',
    cost_cents: 0,
    price_cents: 4990,
    min_stock: 0,
    active: 1,
    kind: 'retail',
    ...over,
  };
}

const peso = (kg: number | null): LeituraDaBalanca => ({
  codigo: '2100123003520',
  plu: '00123',
  tipo: 'peso',
  quantidade: kg,
  precoTotalCents: null,
});

const preco = (kg: number | null, totalCents: number): LeituraDaBalanca => ({
  codigo: '2200123017560',
  plu: '00123',
  tipo: 'preco',
  quantidade: kg,
  precoTotalCents: totalCents,
});

const daBalanca = (leitura: LeituraDaBalanca, over: Partial<AchadoDaBusca> = {}) =>
  achado({ ...over, matched_exact: 0, balanca: leitura }) as AchadoDaBalanca;

describe('quando a etiqueta entra direto', () => {
  it('UMA linha com a etiqueta: é ela que entra, mesmo acompanhada de achados por texto', () => {
    const etiqueta = daBalanca(peso(0.352));
    const porTexto = achado({ id: 'q-2', name: 'QUEIJO 2100123003520' });
    expect(etiquetaDaBalancaUnica([porTexto, etiqueta])?.id).toBe('q-1');
  });

  it('duas linhas com etiqueta (o mesmo PLU em dois cadastros): nenhuma entra sozinha — lista', () => {
    expect(
      etiquetaDaBalancaUnica([daBalanca(peso(0.352)), daBalanca(peso(0.352), { id: 'q-2' })]),
    ).toBeNull();
  });

  it('sem etiqueta (ou com `balanca` nulo): a busca de sempre', () => {
    expect(etiquetaDaBalancaUnica([achado(), achado({ id: 'q-2', balanca: null })])).toBeNull();
    expect(temEtiquetaDaBalanca(achado())).toBe(false);
  });
});

describe('a conferência da etiqueta', () => {
  it('etiqueta de PESO com peso: entra', () => {
    expect(recusaDaEtiquetaDaBalanca(daBalanca(peso(0.352)), 4990)).toBeNull();
  });

  it('etiqueta de PESO com peso zero: recusa, e diz para pesar de novo', () => {
    expect(recusaDaEtiquetaDaBalanca(daBalanca(peso(0)), 4990)).toMatch(/peso zero.*pese de novo/);
  });

  it('etiqueta de PREÇO de produto sem preço (quantidade nula): recusa, e diz o que cadastrar', () => {
    expect(recusaDaEtiquetaDaBalanca(daBalanca(preco(null, 1756)), 0)).toMatch(/sem preço no cadastro/);
  });

  it('etiqueta de PREÇO que bate com quantidade × preço: entra (0,352 × R$ 49,90 = R$ 17,56)', () => {
    expect(recusaDaEtiquetaDaBalanca(daBalanca(preco(0.352, 1756)), 4990)).toBeNull();
  });

  it('a diferença do arredondamento ao GRAMA é aceita, mesmo passando de um centavo', () => {
    // R$ 70,45 ÷ R$ 199,90 = 0,352426 kg → 0,352 kg → R$ 70,36: 9 centavos de
    // meio grama de um produto caro, e não erro.
    expect(recusaDaEtiquetaDaBalanca(daBalanca(preco(0.352, 7045)), 19990)).toBeNull();
  });

  it('preço da linha diferente do da etiqueta (o "Preço Unitário" digitado): recusa, com as duas contas', () => {
    const recusa = recusaDaEtiquetaDaBalanca(daBalanca(preco(0.352, 1756)), 3000);
    expect(recusa).toMatch(/17,56/);
    expect(recusa).toMatch(/10,56/);
    expect(recusa).toMatch(/O item não entrou/);
  });

  it('a tolerância é meio grama do preço do quilo, nunca menos de um centavo', () => {
    expect(toleranciaDaEtiquetaDePrecoCents(0)).toBe(1);
    expect(toleranciaDaEtiquetaDePrecoCents(2000)).toBe(1);
    expect(toleranciaDaEtiquetaDePrecoCents(4990)).toBe(3);
    expect(toleranciaDaEtiquetaDePrecoCents(19990)).toBe(10);
  });
});
