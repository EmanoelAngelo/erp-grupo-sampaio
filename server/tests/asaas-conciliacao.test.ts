/**
 * Conciliação Asaas × financeiro do núcleo.
 *
 * O QUE ESTE ARQUIVO PROTEGE
 *
 * O provedor confirma, o webhook chega, o núcleo lança. São três passos
 * ligados por rede: basta um falhar para a operação passar a ter uma verdade a
 * menos, sem nenhuma tela avisar. As três formas de isso acontecer:
 *
 *  - COBRADO E NÃO LANÇADO — dinheiro na conta do Asaas que não existe no
 *    financeiro. Some do faturamento e do imposto.
 *  - LANÇADO E NÃO COBRADO — financeiro diz que recebeu e o provedor não tem
 *    a cobrança. Infla o resultado com receita que não existe.
 *  - VALOR DIVERGENTE — os dois existem e não batem.
 *
 * E a regra que este arquivo cobra com mais força: a conciliação NÃO CORRIGE
 * NADA. Ajustar sozinha o lado que "parece errado" é acertar a balança
 * empurrando o prato — some com o sintoma, mantém a causa, e a próxima
 * divergência já vem em cima de um número adulterado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { reconcileAsaas } from '../src/services/core/AsaasReconciliation.js';

let gringa: string;
let n = 0;

const AGORA = new Date().toISOString();

/** Cobrança confirmada no provedor. */
function intent(originId: string, cents: number, status = 'confirmed'): void {
  n += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_payment_intents
         (id, company_id, provider, environment, origin_type, origin_id, method,
          amount_cents, status, provider_ref, idempotency_key, confirmed_at,
          created_at, updated_at)
       VALUES (?, ?, 'asaas', 'sandbox', 'ecommerce_order', ?, 'pix', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      originId,
      cents,
      status,
      `pay_${originId}`,
      `idem-${n}`,
      status === 'confirmed' ? AGORA : null,
      AGORA,
      AGORA,
    );
}

/** Entrada liquidada no financeiro do núcleo. */
function lancamento(originId: string, cents: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, description, origin_type, origin_id, created_at)
       VALUES (?, ?, 'in', ?, 'settled', ?, ?, ?, ?, 'ecommerce_order', ?, ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      cents,
      AGORA.slice(0, 10),
      AGORA,
      cents,
      `Pedido online ${originId}`,
      originId,
      AGORA,
    );
}

function conciliar() {
  return reconcileAsaas({ companyId: gringa });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('quando tudo bate', () => {
  it('não acusa divergência nenhuma', () => {
    intent('ped-1', 24675);
    lancamento('ped-1', 24675);

    const r = conciliar();
    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect(r.differenceCents).toBe(0);
  });

  it('os totais dos dois lados aparecem, mesmo sem divergência', () => {
    intent('ped-1', 10000);
    lancamento('ped-1', 10000);
    intent('ped-2', 5000);
    lancamento('ped-2', 5000);

    const r = conciliar();
    // Sem os totais, "está tudo certo" não é conferível.
    expect(r.providerCents).toBe(15000);
    expect(r.financeCents).toBe(15000);
  });
});

describe('cobrado e não lançado', () => {
  it('acusa o dinheiro que entrou no provedor e sumiu do financeiro', () => {
    intent('ped-1', 24675);
    // O webhook não chegou, ou chegou e falhou no meio.

    const r = conciliar();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
    expect(r.rows[0].providerCents).toBe(24675);
    expect(r.rows[0].financeCents).toBeNull();
    // Receita invisível: some do faturamento, do imposto e do fechamento.
    expect(r.differenceCents).toBe(24675);
  });
});

describe('lançado e não cobrado', () => {
  it('acusa o lançamento sem cobrança confirmada', () => {
    intent('ped-1', 24675, 'pending');
    lancamento('ped-1', 24675);

    const r = conciliar();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('lancado_nao_cobrado');
    expect(r.rows[0].providerCents).toBeNull();
    expect(r.rows[0].financeCents).toBe(24675);
  });

  it('venda que NUNCA passou pelo provedor não é divergência', () => {
    // Dinheiro no balcão e cartão na maquininha física entram no financeiro
    // sem cobrança no Asaas. Tratar isso como erro encheria o relatório de
    // ruído até ninguém mais olhar.
    lancamento('ped-balcao', 9900);

    expect(conciliar().rows).toHaveLength(0);
  });

  it('e também NÃO entra no total — o resumo não pode contradizer o detalhe', () => {
    /**
     * ACHADO NO NAVEGADOR, com dados reais.
     *
     * A tela mostrava "Diferença −R$ 319,70" em vermelho e, logo abaixo,
     * "tudo confere". O total do financeiro somava vendas de balcão que nunca
     * passaram pelo Asaas; a lista de divergências, corretamente, não.
     *
     * Um alerta que contradiz o próprio detalhe é pior que nenhum alerta:
     * ensina a ignorar o vermelho.
     */
    lancamento('ped-balcao', 31970);

    const r = conciliar();
    expect(r.rows).toHaveLength(0);
    expect(r.financeCents).toBe(0);
    expect(r.differenceCents).toBe(0);
  });
});

describe('valor divergente', () => {
  it('acusa a diferença com os dois lados visíveis', () => {
    intent('ped-1', 24675);
    lancamento('ped-1', 24000);

    const r = conciliar();
    expect(r.rows[0].kind).toBe('valor_divergente');
    expect(r.rows[0].providerCents).toBe(24675);
    expect(r.rows[0].financeCents).toBe(24000);
    // Quem investiga precisa ver os dois números, não só o saldo.
    expect(r.rows[0].differenceCents).toBe(675);
  });

  it('a maior divergência vem primeiro', () => {
    intent('ped-pequeno', 10100);
    lancamento('ped-pequeno', 10000);
    intent('ped-grande', 500000);

    const r = conciliar();
    // É por onde alguém começa a investigar.
    expect(r.rows[0].originId).toBe('ped-grande');
  });
});

describe('cobrança em aberto NÃO é divergência', () => {
  it('intenção pendente sem lançamento é ignorada', () => {
    // PIX gerado e ainda não pago é o estado normal de um pedido novo.
    intent('ped-1', 24675, 'pending');

    expect(conciliar().rows).toHaveLength(0);
  });
});

describe('a conciliação NÃO corrige nada', () => {
  it('depois de rodar, os dois lados continuam exatamente como estavam', () => {
    intent('ped-1', 24675);
    lancamento('ped-1', 24000);

    const antes = {
      intents: getConnection().prepare('SELECT * FROM core_payment_intents').all(),
      financeiro: getConnection().prepare('SELECT * FROM core_finance_entries').all(),
    };

    conciliar();
    conciliar();

    // Acertar a balança empurrando o prato some com o sintoma e mantém a
    // causa — e a próxima divergência vem em cima de um número adulterado.
    expect(getConnection().prepare('SELECT * FROM core_payment_intents').all()).toEqual(
      antes.intents,
    );
    expect(getConnection().prepare('SELECT * FROM core_finance_entries').all()).toEqual(
      antes.financeiro,
    );
  });
});

describe('isolamento entre operações', () => {
  it('a cobrança de uma empresa não aparece na conciliação da outra', async () => {
    const preco = await upsertCompany({
      slug: 'preco-justo',
      tradeName: 'Preço Justo',
      legalName: 'Preço Justo Ltda',
    });
    intent('ped-1', 24675);

    // Cada CNPJ concilia o próprio caixa; misturar seria somar faturamento de
    // empresas diferentes.
    expect(reconcileAsaas({ companyId: preco }).rows).toHaveLength(0);
    expect(reconcileAsaas({ companyId: gringa }).rows).toHaveLength(1);
  });
});

// ============================================================================
// O QUE A CONCILIAÇÃO NÃO ENXERGAVA
// ============================================================================

/** Uma parcela do crediário do pedido, com o número dela. */
function parcela(originId: string, cents: number, numero: number, total: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, description, origin_type, origin_id,
          installment_number, installment_total, created_at)
       VALUES (?, ?, 'in', ?, 'settled', ?, ?, ?, ?, 'ecommerce_order', ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      cents,
      AGORA.slice(0, 10),
      AGORA,
      cents,
      `Pedido online ${originId} · ${numero}/${total}`,
      originId,
      numero,
      total,
      AGORA,
    );
}

/** Uma cobrança que o webhook marcou fora do caminho feliz. */
function intentSemConfirmacao(originId: string, cents: number, status: string): void {
  n += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_payment_intents
         (id, company_id, provider, environment, origin_type, origin_id, method,
          amount_cents, status, provider_ref, idempotency_key, confirmed_at,
          created_at, updated_at)
       VALUES (?, ?, 'asaas', 'sandbox', 'ecommerce_order', ?, 'pix', ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), gringa, originId, cents, status, `pay_${originId}`, `idem-${n}`, AGORA, AGORA);
}

describe('o dinheiro que o webhook marcou fora do caminho feliz', () => {
  /**
   * `PaymentService` grava três desfechos de cobrança paga, e a conciliação só
   * lia UM deles:
   *
   *   - `confirmed` — o caminho feliz;
   *   - `paid_after_cancel` — dinheiro real que entrou depois do cancelamento;
   *   - `amount_mismatch` — pagou valor diferente do pedido.
   *
   * Os dois últimos são exatamente o dinheiro que precisa de alguém olhando —
   * e sumiam do único relatório feito para achá-los. Nenhum deles carimba
   * `confirmed_at`, então incluí-los no `status` sem trocar a coluna do
   * recorte não bastaria: continuariam fora da janela.
   */
  it('pagamento recebido APÓS o cancelamento aparece', () => {
    intentSemConfirmacao('ped-cancelado', 24675, 'paid_after_cancel');

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
    expect(r.rows[0].providerCents).toBe(24675);
  });

  it('pagamento com valor divergente aparece', () => {
    intentSemConfirmacao('ped-torto', 10000, 'amount_mismatch');

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect(r.providerCents).toBe(10000);
  });

  it('cobrança ainda pendente NÃO aparece — ela não é dinheiro', () => {
    intentSemConfirmacao('ped-aberto', 10000, 'pending');
    expect(conciliar().rows).toHaveLength(0);
  });

  it('cobrança cancelada no provedor também não aparece', () => {
    intentSemConfirmacao('ped-morto', 10000, 'cancelled');
    expect(conciliar().rows).toHaveLength(0);
  });
});

describe('o pedido parcelado não vira divergência de mentira', () => {
  /**
   * A chave era `(origin_type, origin_id)`, e um `Map` guarda o ÚLTIMO valor
   * de cada chave. Um pedido de R$ 300 em 3× tem três lançamentos com a mesma
   * origem: a comparação via só a última parcela e acusava R$ 200 de
   * divergência que não existe — no relatório que o gerente usa justamente
   * para decidir se falta dinheiro.
   */
  it('três parcelas somam o pedido inteiro', () => {
    intent('ped-3x', 30000);
    parcela('ped-3x', 10000, 1, 3);
    parcela('ped-3x', 10000, 2, 3);
    parcela('ped-3x', 10000, 3, 3);

    const r = conciliar();

    expect(r.rows).toHaveLength(0);
    expect([r.providerCents, r.financeCents, r.differenceCents]).toEqual([30000, 30000, 0]);
    expect(r.matched).toBe(1);
  });

  it('e a divergência de verdade continua aparecendo', () => {
    // Duas das três parcelas lançadas: falta uma de verdade.
    intent('ped-3x', 30000);
    parcela('ped-3x', 10000, 1, 3);
    parcela('ped-3x', 10000, 2, 3);

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect([r.rows[0].kind, r.rows[0].differenceCents]).toEqual(['valor_divergente', 10000]);
  });

  it('duas cobranças confirmadas para o mesmo pedido somam — e acusam a dobra', () => {
    // Pagamento duplicado no provedor: o financeiro tem um lançamento só.
    intent('ped-dobrado', 10000);
    getConnection()
      .prepare(
        `INSERT INTO core_payment_intents
           (id, company_id, provider, environment, origin_type, origin_id, method,
            amount_cents, status, provider_ref, idempotency_key, confirmed_at,
            created_at, updated_at)
         VALUES (?, ?, 'asaas', 'sandbox', 'ecommerce_order', ?, 'pix', ?, 'confirmed', ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), gringa, 'ped-dobrado', 10000, 'pay_2', 'idem-dobra', AGORA, AGORA, AGORA);
    lancamento('ped-dobrado', 10000);

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect([r.rows[0].kind, r.rows[0].providerCents, r.rows[0].financeCents]).toEqual([
      'valor_divergente',
      20000,
      10000,
    ]);
  });
});

// ============================================================================
// A SEGUNDA ORIGEM DE COBRANÇA: O TÍTULO DO CONTAS A RECEBER
// ============================================================================

/**
 * O DEFEITO QUE ESTE BLOCO COBRA (regressão do V13-ASS-016).
 *
 * A cobrança avulsa (GAP-V70) criou uma SEGUNDA origem de cobrança e a
 * conciliação ficou intocada. As duas pontas passaram a falar grafias
 * diferentes do mesmo fato:
 *
 *   - do lado do PROVEDOR, a intenção nasce com `origin_type = 'finance_entry'`
 *     e `origin_id` = o id DO TÍTULO;
 *   - do lado do FINANCEIRO, o título avulso tem `origin_type = 'manual'` e
 *     `origin_id` apontando para ele mesmo — e a consulta nem o trazia, porque
 *     filtrava `origin_type IN ('ecommerce_order','sale')`.
 *
 * A chave da comparação é `origin_type:origin_id`, então 'finance_entry:x'
 * nunca casava com 'manual:x'. Consequência determinística: TODA cobrança de
 * título paga e JÁ BAIXADA pelo webhook caía em `cobrado_nao_lancado`. É o
 * relatório que existe para achar dinheiro faltando dizendo que falta dinheiro
 * que não falta — e um alerta que sempre grita ensina a ignorar alertas.
 */

/** Cobrança de TÍTULO no provedor: a grafia `finance_entry:<id do título>`. */
function cobrancaDoTitulo(entryId: string, cents: number, status = 'confirmed'): void {
  n += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_payment_intents
         (id, company_id, provider, environment, origin_type, origin_id, method,
          amount_cents, status, provider_ref, idempotency_key, confirmed_at,
          created_at, updated_at)
       VALUES (?, ?, 'asaas', 'sandbox', 'finance_entry', ?, 'pix', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      entryId,
      cents,
      status,
      `pay_${entryId}`,
      `finance_entry:${entryId}:pix`,
      status === 'confirmed' ? AGORA : null,
      AGORA,
      AGORA,
    );
}

/** Cobrança da VENDA no provedor: a grafia `sale:<id da venda>`. */
function cobrancaDoVenda(saleId: string, cents: number, status = 'confirmed'): void {
  n += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_payment_intents
         (id, company_id, provider, environment, origin_type, origin_id, method,
          amount_cents, status, provider_ref, idempotency_key, confirmed_at,
          created_at, updated_at)
       VALUES (?, ?, 'asaas', 'sandbox', 'sale', ?, 'pix', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      saleId,
      cents,
      status,
      `pay_venda_${saleId}`,
      `sale:${saleId}:pix`,
      status === 'confirmed' ? AGORA : null,
      AGORA,
      AGORA,
    );
}

/**
 * Título avulso do contas a receber. `origin_type = 'manual'` e `origin_id`
 * apontando para ele mesmo é exatamente o que `FinanceService.createEntry`
 * grava. `baixado: false` deixa o título em aberto.
 */
function tituloAvulso(
  id: string,
  cents: number,
  opcoes: {
    baixado?: boolean;
    originType?: string;
    originId?: string;
    parcela?: number;
    totalDeParcelas?: number;
  } = {},
): string {
  const baixado = opcoes.baixado ?? true;
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, description, origin_type, origin_id,
          installment_number, installment_total, created_at)
       VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      gringa,
      cents,
      baixado ? 'settled' : 'open',
      AGORA.slice(0, 10),
      baixado ? AGORA : null,
      baixado ? cents : 0,
      'Aluguel da sala 2',
      opcoes.originType ?? 'manual',
      opcoes.originId ?? id,
      opcoes.parcela ?? 1,
      opcoes.totalDeParcelas ?? 1,
      AGORA,
    );
  return id;
}

describe('a cobrança do título não vira falso positivo', () => {
  it('título cobrado e JÁ BAIXADO pelo webhook não é divergência', () => {
    const titulo = tituloAvulso('tit-1', 30000);
    cobrancaDoTitulo(titulo, 30000);

    const r = conciliar();

    // Era aqui que o relatório gritava `cobrado_nao_lancado` com o título
    // baixado na mesma tela.
    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect([r.providerCents, r.financeCents, r.differenceCents]).toEqual([30000, 30000, 0]);
  });

  it('e o falso positivo não some sozinho: título cobrado e NÃO baixado continua acusando', () => {
    tituloAvulso('tit-2', 30000, { baixado: false });
    cobrancaDoTitulo('tit-2', 30000);

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
    expect(r.rows[0].originType).toBe('finance_entry');
    expect(r.rows[0].originId).toBe('tit-2');
  });

  it('valor divergente do título aparece com os dois lados', () => {
    tituloAvulso('tit-3', 29000);
    cobrancaDoTitulo('tit-3', 30000);

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect([r.rows[0].kind, r.rows[0].providerCents, r.rows[0].financeCents]).toEqual([
      'valor_divergente',
      30000,
      29000,
    ]);
  });

  it('título baixado no CAIXA, sem cobrança nenhuma, não entra no relatório', () => {
    // Dinheiro no balcão não é divergência — é outro meio de pagamento.
    tituloAvulso('tit-4', 12345);

    const r = conciliar();
    expect(r.rows).toHaveLength(0);
    expect(r.financeCents).toBe(0);
  });

  it('cobrança de título ainda pendente com o título baixado à mão é LANÇADO E NÃO COBRADO', () => {
    // O boleto continua vivo no provedor e alguém já deu baixa no caixa: o
    // cliente ainda pode pagar de novo. É divergência de verdade.
    tituloAvulso('tit-5', 20000);
    cobrancaDoTitulo('tit-5', 20000, 'pending');

    const r = conciliar();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('lancado_nao_cobrado');
    expect(r.rows[0].originId).toBe('tit-5');
  });

  it('o carnê: três parcelas cobradas e baixadas fecham em zero', () => {
    // Cada parcela é um título com a SUA cobrança — é o desenho de
    // `chargeFinanceEntry`. Três fatos, três chaves, nenhum falso positivo.
    for (const numero of [1, 2, 3]) {
      const id = `tit-carne-${numero}`;
      tituloAvulso(id, 10000, {
        originId: 'grupo-carne',
        parcela: numero,
        totalDeParcelas: 3,
      });
      cobrancaDoTitulo(id, 10000);
    }

    const r = conciliar();
    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(3);
    expect(r.differenceCents).toBe(0);
  });

  it('título de VENDA cobrado pelo provedor não é contado duas vezes', () => {
    /*
      A ARMADILHA DA DEDUÇÃO DUPLA — e o cenário que a exercita DE VERDADE.

      O DEFEITO DO TESTE ANTERIOR (medido na reverificação): ele criava o
      lançamento com origem 'sale'/'venda-9' e UMA intenção só,
      `finance_entry:tit-6`. A consulta POR DOCUMENTO exige
      `p.origin_type = f.origin_type AND p.origin_id = f.origin_id`, ou seja,
      exigiria uma intenção `sale:venda-9` que o cenário não criava. A linha
      NUNCA chegava duas vezes, e o caso ficava verde com o `Set` arrancado —
      um teste que passa com o guarda removido não mede o guarda.

      O cenário certo tem os DOIS fatos no provedor: a venda foi cobrada
      online (`sale:venda-9`) e o título que ela gerou foi cobrado de novo
      como título (`finance_entry:tit-6`). Aí a MESMA linha do financeiro é
      trazida pelas duas consultas, e é o dedupe — e só ele — que impede o
      total do financeiro de dobrar.
    */
    tituloAvulso('tit-6', 15000, { originType: 'sale', originId: 'venda-9' });
    cobrancaDoVenda('venda-9', 15000);
    cobrancaDoTitulo('tit-6', 15000);

    const r = conciliar();

    // UM lançamento de R$ 150, contado UMA vez. Sem o dedupe são 30000 aqui.
    expect(r.financeCents, 'a mesma linha do financeiro foi contada duas vezes').toBe(15000);
    // Dois fatos no provedor: o cliente foi cobrado duas vezes pelo mesmo valor.
    expect(r.providerCents).toBe(30000);
    // Um dos dois casa com o lançamento; o outro é dinheiro sem lançamento —
    // e é ele que precisa aparecer. Sem o dedupe os DOIS casariam e o
    // relatório diria "tudo confere" com o cliente cobrado em dobro.
    expect(r.matched).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
  });
});

// ============================================================================
// O FALSO POSITIVO QUE A CORREÇÃO DEIXOU VIVO
// ============================================================================

/**
 * O DEFEITO (a mesma classe que o bloco de cima existe para matar).
 *
 * O `EXISTS` da consulta POR TÍTULO não olhava o `status` da intenção. Então
 * QUALQUER cobrança de título — inclusive uma ainda `pending`, que não é
 * dinheiro — bastava para reescrever a chave do lançamento como
 * `finance_entry:<id>`. E o dedupe, fazendo o seu trabalho, retirava essa
 * mesma linha da consulta POR DOCUMENTO.
 *
 * Consequência determinística num lançamento de PEDIDO ONLINE já liquidado
 * pelo webhook do pedido: a intenção CONFIRMADA do pedido perde o lançamento
 * (`cobrado_nao_lancado`) e o lançamento perde a cobrança
 * (`lancado_nao_cobrado`). Duas divergências de mentira nascidas de um boleto
 * em aberto — no relatório que existe justamente para achar dinheiro faltando.
 *
 * O caminho é alcançável pela tela: `POST /core/finance/entries/:id/charge`
 * não restringe `origin_type`, e o botão "Cobrar via Asaas" do contas a
 * receber é oferecido para qualquer título em aberto com cliente.
 */
describe('a cobrança EM ABERTO do título não rouba o lançamento do documento', () => {
  it('pedido pago e baixado, com boleto de título ainda pendente, NÃO é divergência', () => {
    // O pedido online foi pago e o webhook baixou o lançamento. Depois alguém
    // gerou um boleto avulso em cima do mesmo título — que continua em aberto
    // no provedor, porque ninguém o pagou.
    tituloAvulso('lanc-do-pedido-7', 30000, {
      originType: 'ecommerce_order',
      originId: 'ped-7',
    });
    intent('ped-7', 30000);
    cobrancaDoTitulo('lanc-do-pedido-7', 30000, 'pending');

    const r = conciliar();

    expect(
      r.rows,
      'o boleto em aberto reescreveu a chave e partiu o fato em duas divergências de mentira',
    ).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect([r.providerCents, r.financeCents, r.differenceCents]).toEqual([30000, 30000, 0]);
  });

  it('e o caminho inverso continua valendo: cobrança do TÍTULO paga casa pelo título', () => {
    // O PIX do pedido nunca foi pago; quem pagou foi o boleto do título. A
    // chave certa aqui é a do título, e o relatório fecha em zero.
    tituloAvulso('lanc-do-pedido-8', 30000, {
      originType: 'ecommerce_order',
      originId: 'ped-8',
    });
    intent('ped-8', 30000, 'pending');
    cobrancaDoTitulo('lanc-do-pedido-8', 30000);

    const r = conciliar();

    expect(r.rows).toHaveLength(0);
    expect(r.matched).toBe(1);
    expect([r.providerCents, r.financeCents]).toEqual([30000, 30000]);
  });

  it('o conserto NÃO silencia o alerta legítimo: pedido pago e NÃO lançado continua acusando', () => {
    // Sem o lançamento, o dinheiro do pedido é receita invisível — e o boleto
    // pendente do título não pode servir de desculpa para escondê-lo.
    intent('ped-9', 30000);
    cobrancaDoTitulo('titulo-fantasma-9', 30000, 'pending');

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect([r.rows[0].kind, r.rows[0].originType, r.rows[0].originId]).toEqual([
      'cobrado_nao_lancado',
      'ecommerce_order',
      'ped-9',
    ]);
  });

  it('cobrado nas DUAS pontas e lançado uma vez: o dinheiro a mais aparece', () => {
    // Pagamento em duplicidade de verdade — pedido e título, ambos confirmados,
    // um lançamento só. O relatório tem de mostrar a sobra, não engoli-la.
    tituloAvulso('lanc-do-pedido-10', 30000, {
      originType: 'ecommerce_order',
      originId: 'ped-10',
    });
    intent('ped-10', 30000);
    cobrancaDoTitulo('lanc-do-pedido-10', 30000);

    const r = conciliar();

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('cobrado_nao_lancado');
    expect([r.providerCents, r.financeCents, r.differenceCents]).toEqual([60000, 30000, 30000]);
  });
});
