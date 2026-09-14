/**
 * A REPRECIFICAÇÃO POR CLASSE — a regra, sem a tela.
 *
 * Aqui se prova o que a decisão faz com cada linha. O que se prova na TELA
 * (`pdvTabelaDePreco.test.tsx`) é que ela é de fato disparada pelos quatro
 * caminhos por onde item e cliente entram fora de ordem. Os dois são
 * necessários: esta metade continuaria verde com o `PdvPage` nunca chamando
 * nada, que é a forma exata do defeito que esta base já cometeu — o dado
 * existe, é calculado, e ninguém lê.
 *
 * ## Cada caso falha quando o guarda sai
 *
 *   - troque `!==` por "tem cliente" em `linhasParaReprecificar` e tirar o
 *     revendedor do carrinho deixa de devolver os preços ao normal;
 *   - ignore `fonte: 'aberto'` e a linha de mão de obra vai a zero no instante
 *     em que o cliente é escolhido;
 *   - ignore `precoDigitado` e o valor combinado no balcão (ou aprovado numa
 *     pré-venda) é apagado pela troca de cliente;
 *   - deixe de reescrever `effective_price_cents` e o painel de concessão
 *     acusa os 15% do revendedor como desconto do operador;
 *   - marque a linha que NÃO foi perguntada e o item bipado durante a ida ao
 *     servidor congela no preço da busca, para sempre.
 */
import { describe, expect, it } from 'vitest';
import type { CarrinhoPrecificado, Product } from '@/lib/api/core';
import { concessaoPrevista, precoVigenteCents } from '../pdvConcessao';
import type { CartLine } from '../pdvTypes';
import {
  aplicarPrecificacao,
  condicaoEmPalavras,
  linhasParaReprecificar,
} from '../pdvReprecificacao';

const MOTO: Product = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Moto Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 900000,
  price_cents: 1200000,
  effective_price_cents: 1200000,
  on_sale: false,
  min_stock: 0,
  active: 1,
  open_price: 0,
};

/** Mão de obra: o cadastro é sugestão, e a sugestão é zero. */
const MAO_DE_OBRA: Product = {
  ...MOTO,
  id: 'p-servico',
  internal_code: 'SV-0001',
  name: 'Mão de obra revisão',
  price_cents: 0,
  effective_price_cents: 0,
  open_price: 1,
};

function linha(product: Product, extra: Partial<CartLine> = {}): CartLine {
  return {
    product,
    quantity: 1,
    unitPriceCents: product.effective_price_cents ?? product.price_cents,
    precificadaPara: null,
    ...extra,
  };
}

/** O que o servidor responde para o revendedor de 15%. */
const ATACADO: CarrinhoPrecificado = {
  items: [
    { productId: 'p-moto', priceCents: 1020000, listPriceCents: 1200000, onSale: true, fonte: 'tabela' },
  ],
  priceTable: { id: 't-atacado', name: 'Atacado', percentOff: 15 },
};

describe('quais linhas precisam de preço novo', () => {
  it('a linha precificada para outro cliente entra', () => {
    const carrinho = [linha(MOTO, { precificadaPara: null })];
    expect(linhasParaReprecificar(carrinho, 'c-revenda')).toHaveLength(1);
  });

  it('a linha já precificada para ESTE cliente fica de fora — senão o balcão pergunta em laço', () => {
    const carrinho = [linha(MOTO, { precificadaPara: 'c-revenda' })];
    expect(linhasParaReprecificar(carrinho, 'c-revenda')).toHaveLength(0);
  });

  it('sem cliente, a linha da busca não é perguntada de novo', () => {
    // O preço da busca JÁ é o preço de quem não tem tabela: base e promoção.
    // Perguntar outra vez seria uma ida ao servidor por item bipado no caso
    // mais comum da loja.
    const carrinho = [linha(MOTO, { precificadaPara: null })];
    expect(linhasParaReprecificar(carrinho, null)).toHaveLength(0);
    expect(linhasParaReprecificar(carrinho, undefined)).toHaveLength(0);
  });

  it('TIRAR o cliente do carrinho também reprecifica — o desconto tem de ir embora com ele', () => {
    const carrinho = [linha(MOTO, { precificadaPara: 'c-revenda' })];
    expect(linhasParaReprecificar(carrinho, null)).toHaveLength(1);
  });

  it('a linha vinda de documento nunca foi precificada para ninguém, nem para "sem cliente"', () => {
    const carrinho = [linha(MOTO, { precificadaPara: undefined })];
    expect(linhasParaReprecificar(carrinho, null)).toHaveLength(1);
  });
});

describe('o preço da tabela vira o preço da linha', () => {
  it('o vigente da linha passa a ser o do revendedor', () => {
    const [nova] = aplicarPrecificacao([linha(MOTO)], ATACADO, 'c-revenda', ['p-moto']);
    expect(nova.unitPriceCents).toBe(1020000);
    expect(nova.precificadaPara).toBe('c-revenda');
  });

  it('o VIGENTE é reescrito junto — e é isso que zera a concessão', () => {
    /*
      O caso que decide a rodada, do lado da tela.

      `pdvConcessao` mede contra `effective_price_cents`, o mesmo denominador do
      `SalesService`. Se a reprecificação escrevesse só `unitPriceCents`, o
      painel do balcão acusaria os R$ 1.800,00 de tabela como concessão do
      operador e diria "acima do limite" numa venda que o servidor fecha sem
      pedir gestor.
    */
    const [nova] = aplicarPrecificacao([linha(MOTO)], ATACADO, 'c-revenda', ['p-moto']);
    expect(precoVigenteCents(nova)).toBe(1020000);
    expect(concessaoPrevista([nova], 0).concedidoCents).toBe(0);
    expect(concessaoPrevista([nova], 0).percentual).toBe(0);
    // O preço de CADASTRO fica: é ele que aparece riscado no "de/por", e sem
    // ele o operador não vê que o desconto está valendo.
    expect(nova.product.price_cents).toBe(1200000);
    expect(nova.product.on_sale).toBe(true);
  });

  it('5% ALÉM da tabela medem 5% de concessão, e não 19,25%', () => {
    /*
      O teste que mais importa. O operador combina R$ 9.690,00 (5% sobre o preço
      de revenda) com o revendedor de 15%.

      Com a tabela no denominador: 51000 / 1020000 = 5,00% — cabe no limite de
      10% da operação e a venda fecha sem gestor.
      Sem ela: 231000 / 1200000 = 19,25% — e o balcão trava em toda venda de
      atacado, que é o estado de onde esta rodada partiu.
    */
    const combinada = linha(MOTO, { unitPriceCents: 969000, precoDigitado: true });
    const [nova] = aplicarPrecificacao([combinada], ATACADO, 'c-revenda', ['p-moto']);

    expect(nova.unitPriceCents).toBe(969000);
    const previa = concessaoPrevista([nova], 0);
    expect(previa.brutoCents).toBe(1020000);
    expect(previa.concedidoCents).toBe(51000);
    expect(previa.percentual).toBe(5);
  });

  it('promoção e tabela não empilham: quem responde é o servidor, e a tela só copia', () => {
    // 20% de promoção com 10% de tabela dá 20%, nunca 28%. A tela não tem como
    // errar isso porque não faz a conta — ela escreve o número que veio.
    const resposta: CarrinhoPrecificado = {
      items: [
        { productId: 'p-moto', priceCents: 960000, listPriceCents: 1200000, onSale: true, fonte: 'promocao' },
      ],
      priceTable: { id: 't-atacado', name: 'Atacado', percentOff: 10 },
    };
    const [nova] = aplicarPrecificacao([linha(MOTO)], resposta, 'c-revenda', ['p-moto']);
    expect(nova.unitPriceCents).toBe(960000);
  });
});

describe('preço aberto fica de fora — a mesma decisão do servidor', () => {
  it('a linha de mão de obra NÃO é zerada quando o cliente é escolhido', () => {
    /*
      O desfecho concreto que esta exclusão evita: mão de obra tem `price_cents`
      zero no cadastro, e sem a saída antecipada a linha combinada em R$ 250,00
      viraria R$ 0,00 no instante em que o atendente escolhesse o cliente — sem
      erro nenhum na tela.
    */
    const combinada = linha(MAO_DE_OBRA, { unitPriceCents: 25000, precoDigitado: true });
    const resposta: CarrinhoPrecificado = {
      items: [
        { productId: 'p-servico', priceCents: 0, listPriceCents: 0, onSale: false, fonte: 'aberto' },
      ],
      priceTable: { id: 't-atacado', name: 'Atacado', percentOff: 15 },
    };

    const [nova] = aplicarPrecificacao([combinada], resposta, 'c-revenda', ['p-servico']);
    expect(nova.unitPriceCents).toBe(25000);
    // Nem o vigente é tocado: escrever a sugestão zero faria o painel de
    // concessão ler a linha como "acima do vigente".
    expect(nova.product.effective_price_cents).toBe(0);
    // Mas ela FOI conferida: sem a marca, a tela perguntaria de novo a cada
    // render.
    expect(nova.precificadaPara).toBe('c-revenda');
  });
});

describe('preço digitado não é sobrescrito — é limitado', () => {
  it('o valor aprovado numa pré-venda sobrevive à troca de cliente', () => {
    // A moto aprovada por R$ 10.000,00 semanas atrás. O vigente do revendedor é
    // R$ 10.200,00: o cliente continua pagando o que aprovou.
    const doDocumento = linha(MOTO, {
      unitPriceCents: 1000000,
      precoNegociadoCents: 1000000,
      precoDigitado: true,
      precificadaPara: undefined,
    });
    const [nova] = aplicarPrecificacao([doDocumento], ATACADO, 'c-revenda', ['p-moto']);
    expect(nova.unitPriceCents).toBe(1000000);
    expect(precoVigenteCents(nova)).toBe(1020000);
  });

  it('se o vigente cair abaixo do combinado, o cliente leva o menor', () => {
    const combinada = linha(MOTO, { unitPriceCents: 1100000, precoDigitado: true });
    const [nova] = aplicarPrecificacao([combinada], ATACADO, 'c-revenda', ['p-moto']);
    // R$ 11.000,00 combinados contra R$ 10.200,00 de tabela: cobrar o combinado
    // seria a tela prometendo um total que o servidor não cobra — ele aplica
    // teto no vigente.
    expect(nova.unitPriceCents).toBe(1020000);
  });
});

describe('o que a resposta não traz', () => {
  it('produto omitido fica exatamente como estava, e não zera', () => {
    // Inativado no cadastro entre o bipe e a troca de cliente. Quem recusa a
    // venda é a venda, nomeando o produto; derrubar a linha aqui deixaria o
    // operador sem preço nenhum nas outras.
    const carrinho = [linha(MOTO)];
    const vazia: CarrinhoPrecificado = { items: [], priceTable: null };
    const [nova] = aplicarPrecificacao(carrinho, vazia, 'c-revenda', ['p-moto']);
    expect(nova.unitPriceCents).toBe(1200000);
    // Marcada assim mesmo: pendente para sempre seria um pedido ao servidor a
    // cada render.
    expect(nova.precificadaPara).toBe('c-revenda');
  });

  it('a linha bipada DURANTE a ida ao servidor continua pendente', () => {
    /*
      O balcão não espera a resposta. Se a linha que entrou no meio do caminho
      fosse marcada, ela congelaria no preço da busca — sem a tabela do cliente
      e sem nunca mais ser perguntada. É o defeito desta rodada reintroduzido
      pela porta dos fundos.
    */
    const carrinho = [linha(MOTO), linha(MAO_DE_OBRA, { unitPriceCents: 25000 })];
    const nova = aplicarPrecificacao(carrinho, ATACADO, 'c-revenda', ['p-moto']);
    expect(nova[0].precificadaPara).toBe('c-revenda');
    expect(nova[1].precificadaPara).toBe(null);
    expect(linhasParaReprecificar(nova, 'c-revenda')).toHaveLength(1);
  });
});

describe('a condição em palavras', () => {
  it('diz o nome e o percentual', () => {
    expect(condicaoEmPalavras({ id: 't', name: 'Atacado', percentOff: 15 })).toBe('Atacado · -15%');
  });

  it('a fração aparece com vírgula, como o balcão lê', () => {
    expect(condicaoEmPalavras({ id: 't', name: 'Revenda', percentOff: 7.5 })).toBe(
      'Revenda · -7,5%',
    );
  });

  it('tabela de 0% mostra só o nome — "-0%" pareceria defeito', () => {
    // Existe: é a tabela que só tem preços fixados por item, sem desconto geral.
    expect(condicaoEmPalavras({ id: 't', name: 'Especial', percentOff: 0 })).toBe('Especial');
  });

  it('sem tabela, nada na tela', () => {
    expect(condicaoEmPalavras(null)).toBeNull();
  });
});

/*
  ================================================================
  A CATRACA: o desconto entrava e não saía mais
  ================================================================

  O teto do preço combinado era medido com `Math.min(unitPriceCents, novo)` — e
  `unitPriceCents` é o campo que a própria reprecificação reescreve. O efeito é
  uma catraca que só desce:

    operador combina R$ 11.000        -> unitPriceCents = 11.000
    escolhe revendedor de 15%         -> min(11.000, 10.200) = 10.200
    TIRA o cliente (volta ao normal)  -> min(10.200, 12.000) = 10.200  <- errado
    escolhe outro cliente, de 5%      -> min(10.200, 11.400) = 10.200

  Os R$ 11.000 combinados somem na primeira troca, e o desconto do revendedor
  gruda numa venda que não é mais dele. Nada na tela denuncia: o número é
  plausível em todos os passos. Quem percebe é o cliente, na hora de pagar.

  O combinado passa a morar em `precoNegociadoCents`, escrito uma vez, e o teto
  é sempre medido contra ELE.
*/
describe('o preço combinado não é corroído pela troca de cliente', () => {
  /** O que o servidor responde para quem NÃO tem tabela: o preço cheio. */
  const SEM_TABELA: CarrinhoPrecificado = {
    items: [
      { productId: 'p-moto', priceCents: 1200000, listPriceCents: 1200000, onSale: false, fonte: 'cadastro' },
    ],
    priceTable: null,
  };

  /** Outro cliente, com 5%. */
  const ESPECIAL: CarrinhoPrecificado = {
    items: [
      { productId: 'p-moto', priceCents: 1140000, listPriceCents: 1200000, onSale: true, fonte: 'tabela' },
    ],
    priceTable: { id: 't-especial', name: 'Especial', percentOff: 5 },
  };

  /** A moto combinada por R$ 11.000, abaixo dos R$ 12.000 de cadastro. */
  function combinada(): CartLine {
    return linha(MOTO, {
      unitPriceCents: 1100000,
      precoDigitado: true,
      precoNegociadoCents: 1100000,
    });
  }

  it('com revendedor de 15%, leva o menor entre o combinado e o de revenda', () => {
    const [nova] = aplicarPrecificacao([combinada()], ATACADO, 'c-revenda', ['p-moto']);
    // 8.500 do revendedor é menor que os 10.000 combinados.
    // 10.200 do revendedor e menor que os 11.000 combinados: vale o do revendedor.
    expect(nova.unitPriceCents).toBe(1020000);
  });

  it('TIRAR o cliente devolve o combinado — e não deixa o desconto grudado', () => {
    const comRevendedor = aplicarPrecificacao([combinada()], ATACADO, 'c-revenda', ['p-moto']);
    const semCliente = aplicarPrecificacao(comRevendedor, SEM_TABELA, null, ['p-moto']);

    // O combinado volta inteiro. Antes ficava no preço do revendedor.
    expect(semCliente[0].unitPriceCents).toBe(1100000);
    expect(semCliente[0].precoNegociadoCents).toBe(1100000);
  });

  it('e trocar de revendedor para cliente de 5% mede contra o combinado, não contra o anterior', () => {
    const comRevendedor = aplicarPrecificacao([combinada()], ATACADO, 'c-revenda', ['p-moto']);
    const comEspecial = aplicarPrecificacao(comRevendedor, ESPECIAL, 'c-especial', ['p-moto']);

    // 11.400 do especial é MAIOR que os 10.000 combinados: vale o combinado.
    expect(comEspecial[0].unitPriceCents).toBe(1100000);
  });

  it('o combinado sobrevive a três trocas seguidas', () => {
    let atual = [combinada()];
    for (const [resp, quem] of [
      [ATACADO, 'c-revenda'],
      [SEM_TABELA, null],
      [ESPECIAL, 'c-especial'],
      [SEM_TABELA, null],
    ] as [CarrinhoPrecificado, string | null][]) {
      atual = aplicarPrecificacao(atual, resp, quem, ['p-moto']);
    }
    // Depois de tudo, sem cliente, o preço é o que foi combinado no balcão.
    expect(atual[0].unitPriceCents).toBe(1100000);
  });
});
