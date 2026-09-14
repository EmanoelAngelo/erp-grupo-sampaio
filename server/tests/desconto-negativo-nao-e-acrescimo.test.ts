/**
 * DESCONTO NEGATIVO É ACRÉSCIMO COM OUTRO NOME — o espelho do buraco que a
 * rodada anterior fechou no campo irmão.
 *
 * ## O que foi medido, contra banco de teste
 *
 * Venda da moto de R$ 12.000,00 com `discountCents: -100000`. PASSOU. Ficou
 * gravado:
 *
 *     discount_cents  = -100000        (um desconto negativo, na venda)
 *     total_cents     =  1300000       (MAIS que o bruto de R$ 12.000,00)
 *     concessão       = -8,33%         (um percentual negativo)
 *
 * ## Por que não é o mesmo defeito do acréscimo negativo
 *
 * O acréscimo negativo era evasão de alçada: ele derrubava o total ficando
 * fora da concessão, e a trava não via. Este não evade nada — a identidade
 * `total = bruto - concedido + acréscimo` continua fechando, e percentual
 * negativo nunca ultrapassa limite nenhum.
 *
 * O estrago é de DADO, que é pior de achar justamente por não disparar nada:
 * cupom e nota saem com "desconto: -R$ 1.000,00", frase que não significa nada
 * para quem lê; o cliente paga mais que o bruto sem nenhuma linha que explique
 * a diferença (o acréscimo, que é o campo feito para ela, fica zerado); e o
 * percentual negativo viaja para a auditoria da venda e para a faixa de
 * concessão do PDV.
 *
 * ## O que cada caso aqui prova, e como ele falha sem o guarda
 *
 * Tire o `if (saleDiscount < 0)` de `SalesService.createSale` e os casos de
 * rodapé param de receber erro: a venda fecha, e as asserções que conferem o
 * banco vazio caem junto. Tire o `if (discount < 0)` da linha e os casos de
 * item fazem o mesmo.
 *
 * Nenhum caso lê texto de código: todos executam venda de verdade e conferem o
 * que ficou (ou não ficou) no banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';

const MOTO = 1_200_000;
const OLEO = 5_000;
const LOJA = 'loja-sinal';

const app = createApp();

/** Quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };

function produto(id: string, nome: string, precoCents: number): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, LOJA, id, nome, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(LOJA, id, agora);
}

function venda(extra: Record<string, unknown>) {
  return createSale({
    companyId: LOJA,
    userId: 'u-caixa',
    idempotencyKey: randomUUID(),
    items: [],
    payments: [],
    ...extra,
  } as Parameters<typeof createSale>[0]);
}

function erroDe(fn: () => unknown): {
  code: string;
  message: string;
  details: { discountCents?: number; productId?: string };
} {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string; details?: unknown };
    return { code: e.code, message: e.message, details: (e.details ?? {}) as never };
  }
  throw new Error('esperava um erro, e a venda passou');
}

/** O que sobrou no banco. Zero é a única resposta aceitável numa recusa. */
function vendasGravadas(): { n: number } {
  return getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
    .get(LOJA) as { n: number };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await loginForTest(app, {
    userId: 'caixa',
    companyId: LOJA,
    profileCodes: ['operador_caixa_loja'],
  });
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-oleo', 'Óleo 1L', OLEO);
});

describe('desconto de rodapé não pode ser negativo', () => {
  it('O CASO MEDIDO: a moto de R$ 12.000 com desconto de -R$ 1.000 é RECUSADA', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1 }],
        discountCents: -100_000,
        payments: [{ method: 'dinheiro', amountCents: 1_300_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(erro.message).toMatch(/não pode ser negativo/i);
    // A mensagem manda usar o campo certo. É a mesma escolha do acréscimo
    // negativo, e pelo mesmo motivo: existe campo com esse significado, e ele
    // aparece separado no cupom e na nota.
    expect(erro.message).toContain('ACRÉSCIMO');
    expect(erro.details.discountCents).toBe(-100_000);

    // E o que a medição encontrou gravado — venda com total maior que o bruto
    // e desconto negativo na linha — não existe mais.
    expect(vendasGravadas().n).toBe(0);
  });

  it('a recusa NÃO depende de alçada: é o dado que está errado, não a permissão', () => {
    /*
      Importa separar as duas coisas. A alçada não teria como pegar este caso —
      concessão negativa não ultrapassa limite nenhum —, e uma venda sem
      `alcada` (a conversão de documento, por exemplo) passaria por qualquer
      trava que morasse lá. O guarda é do CAMPO, e roda sempre.
    */
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 1 }],
        discountCents: -1,
        payments: [{ method: 'dinheiro', amountCents: OLEO + 1 }],
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(vendasGravadas().n).toBe(0);
  });

  it('o mesmo valor lançado como ACRÉSCIMO passa, e aparece onde deve', () => {
    /*
      A outra metade da decisão: recusar só é honesto se o caminho legítimo
      estiver aberto. Quem quis cobrar a mais tem onde lançar, e ali o valor
      fica em campo próprio — visível no cupom, na nota e no relatório — em vez
      de escondido dentro de um desconto de sinal trocado.
    */
    const { sale } = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      surchargeCents: 1_000,
      payments: [{ method: 'dinheiro', amountCents: OLEO + 1_000 }],
      alcada: CAIXA,
    });

    expect(sale.total_cents).toBe(OLEO + 1_000);
    const linha = getConnection()
      .prepare('SELECT discount_cents, surcharge_cents FROM core_sales WHERE id = ?')
      .get(sale.id) as { discount_cents: number; surcharge_cents: number };
    expect(linha).toEqual({ discount_cents: 0, surcharge_cents: 1_000 });
  });

  it('desconto ZERO e desconto POSITIVO continuam passando — o guarda é só do sinal', () => {
    const semDesconto = venda({
      items: [{ productId: 'p-oleo', quantity: 1 }],
      discountCents: 0,
      payments: [{ method: 'dinheiro', amountCents: OLEO }],
      alcada: CAIXA,
    });
    expect(semDesconto.sale.total_cents).toBe(OLEO);

    // 4% sobre R$ 500,00: abaixo do limite do balcão, fecha sem gestor.
    const comDesconto = venda({
      items: [{ productId: 'p-oleo', quantity: 10 }],
      discountCents: 2_000,
      payments: [{ method: 'dinheiro', amountCents: 48_000 }],
      alcada: CAIXA,
    });
    expect(comDesconto.sale.total_cents).toBe(48_000);
    expect(comDesconto.concessao?.percentual).toBe(4);
  });
});

describe('desconto de LINHA não pode ser negativo', () => {
  it('a linha com desconto de -R$ 500 é recusada, e a venda não é gravada', () => {
    /*
      O mesmo campo, um nível mais fundo, e mais silencioso ainda: o cupom
      mostraria um item cujo total é MAIOR que preço × quantidade, sem nada que
      explicasse a diferença.
    */
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-moto', quantity: 1, discountCents: -50_000 }],
        payments: [{ method: 'dinheiro', amountCents: MOTO + 50_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(erro.message).toMatch(/não pode ser negativo/i);
    // A mensagem diz QUAL produto: quem está no balcão tem um carrinho, não
    // uma linha.
    expect(erro.message).toContain('Moto Elétrica');
    expect(erro.details.productId).toBe('p-moto');
    expect(vendasGravadas().n).toBe(0);
  });

  it('E O ESTRAGO QUE ELE FAZIA NA ALÇADA: a linha negativa compensava o desconto real', () => {
    /*
      Este é o caso que mostra por que o guarda da linha não é enfeite do
      guarda do rodapé.

      `concedidoItens` é a soma dos descontos de linha, e ela entra na
      concessão da venda. Uma linha com desconto NEGATIVO entra como parcela
      negativa: os R$ 100,00 de desconto de verdade dados no óleo somavam com
      -R$ 100,00 da moto e davam ZERO de concessão de itens. A venda passava sem
      gestor, com desconto de verdade dado, porque a soma tinha sido zerada por
      um número que não existe no mundo.

      Com o guarda, a venda inteira é recusada antes de qualquer conta de
      alçada — e é por isso que a asserção é sobre o código do erro, e não
      sobre o percentual.
    */
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-oleo', quantity: 10, discountCents: 10_000 },
          { productId: 'p-moto', quantity: 1, discountCents: -10_000 },
        ],
        payments: [{ method: 'dinheiro', amountCents: MOTO + 50_000 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(erro.details.productId).toBe('p-moto');
    expect(vendasGravadas().n).toBe(0);
  });
});

/**
 * ============================================================================
 * A RECUSA VIZINHA JÁ NOMEAVA A LINHA; ESTA, NÃO
 * ============================================================================
 *
 * `CORE_INVALID_DISCOUNT` sai de dois lugares em `SalesService.createSale`, e
 * até aqui os dois eram desiguais: o desconto NEGATIVO leva `productId` no
 * `detail` (é o que os dois casos acima cobram), e o desconto MAIOR QUE O ITEM
 * — "Desconto maior que o valor do item." — saía sem `detail` nenhum.
 *
 * O estrago é no balcão. A tela do PDV re-deriva a linha ofensora com a MESMA
 * aritmética do servidor e só a marca quando acha EXATAMENTE uma fora do teto;
 * com DUAS linhas estouradas ao mesmo tempo ela desiste de marcar — marcar uma
 * por chute mandaria consertar o que não está quebrado — e o operador volta a
 * receber uma frase e uma lista de doze linhas para conferir, com o cliente na
 * frente.
 *
 * Quem sabe qual linha é o servidor: ele descobre a linha ofensora item a item,
 * dentro do laço, com o produto na mão. Dizer é uma linha de código.
 *
 * QUEBRANDO DE PROPÓSITO: tire o `detail` do `throw` e os dois casos abaixo
 * ficam vermelhos, e a tela volta a adivinhar.
 */
describe('desconto MAIOR que o item também nomeia a linha', () => {
  it('a recusa traz o productId — e não só a frase', () => {
    const erro = erroDe(() =>
      venda({
        items: [{ productId: 'p-oleo', quantity: 1, discountCents: OLEO + 1 }],
        payments: [{ method: 'dinheiro', amountCents: 0 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(erro.message).toBe('Desconto maior que o valor do item.');
    expect(erro.details.productId).toBe('p-oleo');
    expect(vendasGravadas().n).toBe(0);
  });

  it('DUAS linhas estouradas: a recusa nomeia AS DUAS, de uma vez', () => {
    /*
      NOMEAR A PRIMEIRA DEVOLVIA UM NOME POR TENTATIVA.

      O laço recusava na primeira linha estourada. Com duas, o operador zerava
      o desconto da que foi nomeada, clicava em Finalizar de novo, tomava a
      MESMA frase pela outra e recomeçava — uma viagem ao servidor por linha
      quebrada, com o cliente na frente.

      Agora o laço ANOTA e segue, e a recusa sai uma vez com a lista inteira.
      Nada é escrito: a conferência acontece antes do primeiro INSERT, e o
      último `expect` é o que garante que adiar a recusa não adiou efeito.
    */
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-oleo', quantity: 1, discountCents: OLEO + 100 },
          { productId: 'p-moto', quantity: 1, discountCents: MOTO + 100 },
        ],
        payments: [{ method: 'dinheiro', amountCents: 0 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.code).toBe('CORE_INVALID_DISCOUNT');
    expect(erro.details.productIds).toEqual(['p-oleo', 'p-moto']);
    // `productId` continua sendo a PRIMEIRA: quem só sabia ler o campo antigo
    // não pode quebrar por causa do campo novo.
    expect(erro.details.productId).toBe('p-oleo');
    expect(vendasGravadas().n).toBe(0);
  });

  it('UMA linha estourada: a lista tem um nome só, e o campo antigo bate com ela', () => {
    const erro = erroDe(() =>
      venda({
        items: [
          { productId: 'p-oleo', quantity: 1, discountCents: OLEO + 100 },
          { productId: 'p-moto', quantity: 1 },
        ],
        payments: [{ method: 'dinheiro', amountCents: 0 }],
        alcada: CAIXA,
      }),
    );

    expect(erro.details.productIds).toEqual(['p-oleo']);
    expect(erro.details.productId).toBe('p-oleo');
    expect(vendasGravadas().n).toBe(0);
  });
});
