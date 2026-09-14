/**
 * A CONTA DA CONCESSÃO — a prévia que o balcão vê antes de fechar a venda.
 *
 * ## O que se está protegendo
 *
 * A alçada de desconto tinha três buracos, e os três foram fechados no
 * servidor. A tela ganhou a prévia para que o operador não descubra a recusa
 * com o cliente na frente. Só que uma prévia que DIVERGE do servidor é pior
 * que prévia nenhuma: mostra 8%, o servidor recusa por 12%, e a pessoa deixa
 * de confiar nos dois números.
 *
 * Por isso cada caso aqui é escrito contra a regra do servidor
 * (`SalesService.createSale`), e não contra o que a tela faz hoje.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - troque `unitarioCobradoCents` por `line.unitPriceCents` e o teto some: o
 *     preço rebaixado deixa de contar como concessão, que é exatamente o
 *     terceiro buraco (a moto de R$ 12.000 saindo por R$ 1,00);
 *   - ignore `open_price` e toda mão de obra passa a acusar concessão gigante,
 *     porque a sugestão cadastrada desses itens costuma ser ZERO;
 *   - some o digitado em vez do cobrado e o bruto infla quando alguém digita
 *     acima do vigente — o denominador voltaria a vir da tela, que é o primeiro
 *     buraco.
 */
import { describe, expect, it } from 'vitest';
import type { Product } from '@/lib/api/core';
import type { CartLine } from '../pdvTypes';
import { concessaoPrevista, unitarioCobradoCents } from '../pdvConcessao';

/** Produto de preço FECHADO: o cadastro é teto. */
function produto(over: Partial<Product> = {}): Product {
  return {
    id: 'p-1',
    internal_code: 'LJ-0001',
    sku: null,
    barcode: null,
    name: 'Moto Honda CG 160',
    category: null,
    brand: null,
    unit: 'UN',
    cost_cents: 900000,
    price_cents: 1200000,
    effective_price_cents: 1200000,
    min_stock: 0,
    active: 1,
    ...over,
  };
}

function linha(over: Partial<CartLine> & { product?: Product } = {}): CartLine {
  return {
    product: over.product ?? produto(),
    quantity: over.quantity ?? 1,
    unitPriceCents: over.unitPriceCents ?? 1200000,
  };
}

describe('preço unitário rebaixado é concessão — o buraco que não passava por nada', () => {
  it('a moto de R$ 12.000 vendida por R$ 1,00 acusa 99,99% de concessão', () => {
    // Este era o caso real: havia teto e não havia PISO. A venda fechava, o
    // estoque baixava e a comissão saía sobre R$ 1,00, sem ninguém ser chamado.
    const c = concessaoPrevista([linha({ unitPriceCents: 100 })], 0);

    expect(c.brutoCents).toBe(1200000);
    expect(c.concedidoCents).toBe(1199900);
    expect(c.origens.precoRebaixado).toBe(1199900);
    expect(c.percentual).toBe(99.99);
  });

  it('a quantidade multiplica a concessão, e não só o preço', () => {
    const c = concessaoPrevista([linha({ unitPriceCents: 1000000, quantity: 3 })], 0);

    expect(c.brutoCents).toBe(3600000);
    expect(c.origens.precoRebaixado).toBe(600000);
  });

  it('o PREÇO VIGENTE é o denominador, e não o de tabela', () => {
    // Item em promoção: quem confere a concessão contra o preço de tabela
    // encontraria uma concessão que ninguém deu — a promoção não é concessão
    // do operador, é preço da loja.
    const emPromocao = produto({ price_cents: 32900, effective_price_cents: 24675 });
    const c = concessaoPrevista([linha({ product: emPromocao, unitPriceCents: 24675 })], 0);

    expect(c.brutoCents).toBe(24675);
    expect(c.concedidoCents).toBe(0);
    expect(c.percentual).toBe(0);
  });
});

describe('preço ABERTO não tem teto nem concessão na diferença', () => {
  const maoDeObra = produto({
    id: 'p-mo',
    name: 'Mão de obra',
    // O caso que quebra a conta ingênua: sugestão ZERO no cadastro.
    price_cents: 0,
    effective_price_cents: 0,
    open_price: 1,
  });

  it('o valor combinado no balcão vale, e não é jogado fora pelo teto', () => {
    expect(unitarioCobradoCents(linha({ product: maoDeObra, unitPriceCents: 25000 }))).toBe(25000);
  });

  it('o bruto é o COMBINADO — senão toda OS pediria gestor', () => {
    const c = concessaoPrevista([linha({ product: maoDeObra, unitPriceCents: 25000 })], 0);

    // Com a conta ingênua (vigente 0 como teto), o bruto seria 0 e o valor
    // cobrado viraria ruído — ou concessão de 100% em toda ordem de serviço.
    expect(c.brutoCents).toBe(25000);
    expect(c.concedidoCents).toBe(0);
    expect(c.origens.precoRebaixado).toBe(0);
    expect(c.percentual).toBe(0);
  });

  it('preço aberto SEM valor digitado é recusa, e a tela avisa antes', () => {
    const c = concessaoPrevista([linha({ product: maoDeObra, unitPriceCents: 0 })], 0);

    expect(c.semPreco).toHaveLength(1);
    expect(c.semPreco[0]).toMatchObject({ nome: 'Mão de obra', aberto: true });
  });
});

describe('produto sem preço cadastrado', () => {
  it('é apontado pelo nome, e NÃO como preço aberto', () => {
    // Uma nota de entrada cria dezenas de produtos assim. A recusa é certa; o
    // que muda é a tela dizer qual item é, em vez de o operador procurar.
    const semPreco = produto({ id: 'p-0', name: 'Filtro de óleo', price_cents: 0, effective_price_cents: 0 });
    const c = concessaoPrevista([linha({ product: semPreco, unitPriceCents: 0 })], 0);

    expect(c.semPreco).toEqual([{ productId: 'p-0', nome: 'Filtro de óleo', aberto: false }]);
  });
});

describe('digitar ACIMA do vigente não infla o bruto', () => {
  it('o denominador continua sendo o preço da loja', () => {
    // O primeiro buraco era o denominador vindo do cliente: um total inflado
    // passava QUALQUER desconto sem gestor. Aqui a tela não repete o truque.
    const c = concessaoPrevista([linha({ unitPriceCents: 5000000 })], 600000);

    expect(c.brutoCents).toBe(1200000);
    // Fosse o digitado, 600.000 sobre 5.000.000 daria 12% e passaria num
    // limite de 15%. Sobre o preço de verdade são 50%.
    expect(c.percentual).toBe(50);
    expect(c.acimaDoVigente).toHaveLength(1);
    expect(c.acimaDoVigente[0].vigenteCents).toBe(1200000);
  });
});

describe('o desconto do rodapé', () => {
  it('soma com o preço rebaixado — as parcelas não se escondem uma na outra', () => {
    // Era possível escapar da alçada trocando de campo: o que a rota media era
    // só o rodapé. Aqui as duas origens aparecem separadas E somadas.
    const c = concessaoPrevista([linha({ unitPriceCents: 1100000 })], 100000);

    expect(c.origens).toEqual({ cabecalho: 100000, itens: 0, precoRebaixado: 100000 });
    expect(c.concedidoCents).toBe(200000);
    expect(c.percentual).toBe(16.67);
  });

  it('carrinho vazio com desconto é 100% — deu-se tudo o que havia', () => {
    expect(concessaoPrevista([], 5000).percentual).toBe(100);
  });

  it('sem nada concedido o percentual é zero, e não NaN', () => {
    // `0 / 0` é NaN, e NaN > limite é FALSE: a trava passaria a liberar tudo.
    const c = concessaoPrevista([], 0);
    expect(c.percentual).toBe(0);
    expect(Number.isNaN(c.percentual)).toBe(false);
  });
});
