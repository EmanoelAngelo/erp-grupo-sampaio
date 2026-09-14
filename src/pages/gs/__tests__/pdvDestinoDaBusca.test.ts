/**
 * O CÓDIGO ADICIONAL E O SKU TAMBÉM SÃO BIPAGEM — D-pdv-teclado-03.
 *
 * O servidor casa exato por código de barras, código interno, SKU e os códigos
 * adicionais do cadastro (`core_product_barcodes`). A tela decidia só pelos dois
 * primeiros: bipar o código do fardo trazia UM produto, a tela desenhava uma
 * lista de um item, o Enter do leitor já tinha sido gasto e o item não entrava.
 *
 * Como fica vermelho: volte `destinoDaBusca` para
 * `barcode === termo || internal_code === termo` e os casos do código adicional,
 * do SKU, da marca do servidor e do exato acompanhado de texto falham.
 */
import { describe, expect, it } from 'vitest';
import { achadoExato, destinoDaBusca, type AchadoDaBusca } from '../pdvTypes';

function achado(over: Partial<AchadoDaBusca> = {}): AchadoDaBusca {
  return {
    id: 'p-1',
    internal_code: 'GS-000001',
    sku: null,
    barcode: '7898215151784',
    name: 'ARROZ X 5kg',
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 0,
    price_cents: 2190,
    min_stock: 0,
    active: 1,
    kind: 'retail',
    ...over,
  };
}

describe('o que o servidor casou por código entra no carrinho', () => {
  it('código ADICIONAL bipado (nem o nome nem o código interno o contêm): carrinho', () => {
    // A busca só devolve por texto quando nome ou código interno CONTÊM o termo.
    expect(destinoDaBusca([achado()], '1234567')).toBe('carrinho');
  });

  it('SKU bipado: carrinho', () => {
    expect(destinoDaBusca([achado({ sku: 'SKU-ARZ-5' })], 'SKU-ARZ-5')).toBe('carrinho');
  });

  it('peça de bancada achada pelo código adicional continua perguntando', () => {
    expect(destinoDaBusca([achado({ kind: 'part' })], '1234567')).toBe('perguntar');
  });

  it('com a marca `exato` do servidor, a palavra é dele', () => {
    expect(destinoDaBusca([achado({ exato: 1, barcode: 'X' })], 'Y')).toBe('carrinho');
    expect(destinoDaBusca([achado({ exato: 0, name: 'Z' })], '1234567')).toBe('lista');
  });

  it('um exato acompanhado de achados por TEXTO decide pelo exato — e é ele que entra', () => {
    const exato = achado({ id: 'a', barcode: '789000', name: 'CABO HDMI' });
    const porTexto = achado({ id: 'b', barcode: '111', name: 'SUPORTE 789000' });
    expect(destinoDaBusca([porTexto, exato], '789000')).toBe('carrinho');
    expect(achadoExato([porTexto, exato], '789000')?.id).toBe('a');
  });
});

/*
  A MARCA QUE O SERVIDOR JÁ MANDA (revisão). A busca do balcão desta árvore
  devolve `matched_exact` (A-produto-M01), e a tela só lia `exato`. Como fica
  vermelho: tire a leitura de `matched_exact` de `casouExato` e o código
  interno em outra caixa, o adicional de nome parecido e a marca em zero caem
  do lado errado.
*/
describe('a marca `matched_exact` da busca do balcão', () => {
  it('código interno digitado em outra caixa (o servidor casa por upper()): carrinho', () => {
    expect(destinoDaBusca([achado({ matched_exact: 1 })], 'gs-000001')).toBe('carrinho');
  });

  it('código adicional de um produto cujo PRÓPRIO nome contém o número: entra o marcado', () => {
    const doFardo = achado({ id: 'a', name: 'CAIXA 1234567', matched_exact: 1 });
    const porNome = achado({ id: 'b', barcode: '222', name: 'KIT 1234567', matched_exact: 0 });
    expect(destinoDaBusca([doFardo, porNome], '1234567')).toBe('carrinho');
    expect(achadoExato([doFardo, porNome], '1234567')?.id).toBe('a');
  });

  it('marca em zero e nada igual ao termo: lista, sem inferência', () => {
    expect(destinoDaBusca([achado({ name: 'OUTRO', matched_exact: 0 })], '1234567')).toBe('lista');
  });

  it('a marca não conhece o SKU: SKU igual ao termo continua exato com a marca em zero', () => {
    expect(destinoDaBusca([achado({ sku: 'SKU-9', matched_exact: 0 })], 'SKU-9')).toBe('carrinho');
  });
});

describe('o que casou por texto continua sendo lista', () => {
  it('nome contém o termo', () => {
    expect(destinoDaBusca([achado()], 'arroz')).toBe('lista');
  });

  it('código interno contém o termo (LIKE)', () => {
    expect(destinoDaBusca([achado()], 'GS-0000')).toBe('lista');
  });

  it('curinga do LIKE no termo não vira casamento por inferência', () => {
    expect(destinoDaBusca([achado({ name: 'A1B' })], 'A_B')).toBe('lista');
  });

  it('dois exatos (o mesmo código em dois cadastros) é lista: a pessoa escolhe', () => {
    expect(
      destinoDaBusca([achado({ id: 'a', sku: 'X9' }), achado({ id: 'b', sku: 'X9' })], 'X9'),
    ).toBe('lista');
  });
});
