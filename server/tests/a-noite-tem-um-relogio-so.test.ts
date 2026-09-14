/**
 * ============================================================================
 * A NOITE TEM UM RELÓGIO SÓ — E ELE É O DA LOJA
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * Três escritores de vencimento mediam o mesmo instante por DOIS relógios ao
 * mesmo tempo: a venda fiada, o repasse da operadora e a compra que chega pela
 * porta dos fundos. Os três estão aqui porque o defeito é UM só — quem
 * consertar um lado sem olhar os outros deixa a metade viva.
 *
 * `SalesService.createSale`:
 *
 *   - a COMPETÊNCIA saía de `diaDaLoja(now)` — o relógio de quem está atrás do
 *     balcão, curado na rodada 82;
 *   - o VENCIMENTO saía de `diaMais(now, dias)`, que é `somarDias`, e
 *     `somarDias` começa por `dia.slice(0, 10)`. Recebendo um INSTANTE ISO em
 *     vez de uma data de calendário, esse recorte devolve o dia de GREENWICH.
 *   - o prazo da OPERADORA saía de `saleDate: now.slice(0, 10)`, o mesmo
 *     recorte, entregue de bandeja ao `planForPayment`.
 *
 * Entre 21h e a meia-noite em Pelotas o relógio de Greenwich já virou o dia.
 * Nessa faixa — a última hora de todo dia de loja que fecha às 22h — o MESMO
 * instante produzia duas datas diferentes:
 *
 *     venda fiada às 22h30 de 31/08, política de 30 dias
 *       competência .... 2026-08-31   (dia da loja, certo)
 *       vencimento ..... 2026-10-01   (31 dias depois da competência)
 *
 * O cliente combinou trinta dias e o sistema anotou trinta e um. Na virada do
 * mês, o título nasce em outubro enquanto a receita compete agosto — e o
 * envelhecimento, o painel de cobrança e a conferência da operadora passam a
 * contar dias a partir de um dia que ninguém viveu.
 *
 * `NfeImportService.confirmNfe` fazia o mesmo com a dívida do FORNECEDOR, e no
 * mesmo INSERT: a competência já saía de `diaDaLoja(now)` e o vencimento saía
 * de `diaMaisNaCompra(now, prazo)`, cujo `iso.slice(0, 10)` é o dia de
 * Greenwich. A carga que chega às 22h com prazo de 30 dias nascia com trinta e
 * um dias de prazo — a loja pagando o fornecedor um dia depois do combinado,
 * por aritmética de calendário, e o cadastro do prazo mentindo na tela.
 *
 * É o MESMO defeito de fuso que a rodada 82 curou nas LEITURAS
 * (`o-dia-do-relatorio-e-o-dia-da-loja`). Ali o escritor da competência ficou
 * para trás; aqui é o escritor do vencimento.
 *
 * ## COMO ESTE ARQUIVO FALHA
 *
 * O relógio é ENCENADO (`vi.useFakeTimers`, o mecanismo de audit-auth e
 * audit-reports) porque o defeito mora no ESCRITOR: carimbar o banco depois,
 * como a maior parte da suíte faz, mascararia exatamente o que se quer medir.
 *
 * Devolvendo `diaMais(now, …)` ou `now.slice(0, 10)` ao lugar de onde saíram,
 * os casos abaixo ficam vermelhos com a data de Greenwich — um dia a mais em
 * cada prazo.
 *
 * O fuso da MÁQUINA não decide nada: forçado para UTC antes de qualquer
 * import, como no arquivo da regra. Esta bancada roda em America/Sao_Paulo, e
 * sem isso o teste acertaria por acidente aqui e falharia no servidor.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { salvarPolitica } from '../src/services/core/SalePolicyService.js';
import { createAcquirer, setRate } from '../src/services/core/AcquirerService.js';
import { createSupplier } from '../src/services/core/SupplierService.js';
import { confirmNfe, createManualInboundNote } from '../src/services/core/NfeImportService.js';
import { diaDaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';

/** 22h30 de 31/08 em Pelotas. Em Greenwich já é 1º de setembro. */
const VENDA_DAS_22H30 = '2026-09-01T01:30:00.000Z';
const DIA_DA_LOJA = '2026-08-31';
const DIA_DE_GREENWICH = '2026-09-01';

const PRECO = 100_000;
const PRODUTO = 'p-bateria';

let empresa: string;

interface Titulo {
  direction: string;
  amount_cents: number;
  due_date: string;
  competence_date: string;
  installment_number: number;
  payment_method: string | null;
}

function titulos(saleId: string, direcao = 'in'): Titulo[] {
  return getConnection()
    .prepare(
      `SELECT direction, amount_cents, due_date, competence_date,
              installment_number, payment_method
         FROM core_finance_entries
        WHERE origin_type = 'sale' AND origin_id = ? AND direction = ?
        ORDER BY installment_number`,
    )
    .all(saleId, direcao) as unknown as Titulo[];
}

function produto(): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Bateria 60Ah', 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(PRODUTO, empresa, PRODUTO, PRECO, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(empresa, PRODUTO, agora);
}

/** A dívida do fiado precisa ter dono — é o que `createSale` já exige. */
function cliente(): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
       VALUES ('c-noturno', ?, 'Seu Antônio', 1, ?, ?)`,
    )
    .run(empresa, agora, agora);
  return 'c-noturno';
}

function vender(extra: Record<string, unknown>) {
  return createSale({
    companyId: empresa,
    userId: 'u-caixa',
    idempotencyKey: randomUUID(),
    items: [{ productId: PRODUTO, quantity: 1 }],
    payments: [],
    ...extra,
  } as Parameters<typeof createSale>[0]);
}

beforeEach(() => {
  /*
    O RELÓGIO É ENCENADO ANTES DE QUALQUER ESCRITA, inclusive a do cenário: o
    que está sob medida é o dia que o serviço DEDUZ de `new Date()`, e um
    cenário montado no relógio real deixaria metade das linhas em outro dia.
  */
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(VENDA_DAS_22H30).getTime() });
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'loja-noturna',
    legalName: 'Loja Noturna Ltda',
    tradeName: 'Loja Noturna',
    kind: 'retail',
  });
  produto();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a competência e o vencimento leem o MESMO relógio', () => {
  it('o instante encenado é mesmo a virada: dia da loja 31/08, dia de Greenwich 01/09', () => {
    // A âncora do arquivo. Se um dia esta linha falhar, nada abaixo significa
    // o que diz significar — e o vermelho aparece aqui, não no meio da conta.
    expect(diaDaLoja(new Date().toISOString())).toBe(DIA_DA_LOJA);
    expect(new Date().toISOString().slice(0, 10)).toBe(DIA_DE_GREENWICH);
  });

  it('venda fiada às 22h30 com prazo de 30 dias: competência 31/08 e vencimento 30/09', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', creditSaleDueDays: 30 });

    const { sale } = vender({ customerId: cliente() });
    const [titulo] = titulos(sale.id);

    expect(titulo.competence_date).toBe(DIA_DA_LOJA);
    /*
      O NÚMERO DA MORDIDA: pelo relógio de Greenwich o vencimento sairia
      2026-10-01 — trinta dias contados de um dia que a loja ainda não viveu.
      Trinta dias a partir do dia da loja são 30/09.
    */
    expect(titulo.due_date).toBe('2026-09-30');
    expect(titulo.due_date).toBe(somarDias(DIA_DA_LOJA, 30));

    // E a prova que amarra os dois relógios num só: o prazo combinado é a
    // distância entre a competência e o vencimento, e não entre dois dias
    // diferentes. É esta igualdade que o defeito quebrava.
    expect(titulo.due_date).toBe(somarDias(titulo.competence_date, 30));
  });

  it('venda fiada sem prazo na política vence no dia da LOJA, não no de Greenwich', () => {
    // Prazo zero é decisão legítima: vence hoje. "Hoje" continua sendo o dia
    // de quem está atrás do balcão.
    salvarPolitica({ companyId: empresa, userId: 'u-dono', creditSaleDueDays: 0 });

    const { sale } = vender({ customerId: cliente() });
    const [titulo] = titulos(sale.id);

    expect(titulo.due_date).toBe(DIA_DA_LOJA);
    expect(titulo.due_date).toBe(titulo.competence_date);
  });

  it('venda à vista às 22h30: vencimento e competência são o mesmo dia da loja', () => {
    const { sale } = vender({
      payments: [{ method: 'dinheiro', amountCents: PRECO }],
    });
    const [titulo] = titulos(sale.id);

    expect(titulo.competence_date).toBe(DIA_DA_LOJA);
    expect(titulo.due_date).toBe(DIA_DA_LOJA);
  });
});

describe('o prazo da OPERADORA conta a partir do dia da loja', () => {
  function regraDeCredito(parcelas: number, dias: number): void {
    const operadora = createAcquirer(empresa, { name: 'Cielo' }).id;
    setRate(empresa, {
      acquirerId: operadora,
      paymentMethod: 'credito',
      installments: parcelas,
      feeBps: 350,
      settlementDays: dias,
    });
  }

  it('crédito 1× com repasse em 30 dias cai em 30/09, e não em 01/10', () => {
    regraDeCredito(1, 30);

    const { sale } = vender({
      payments: [{ method: 'credito', amountCents: PRECO, installments: 1 }],
    });
    const [parcela] = titulos(sale.id);

    /*
      `planForPayment` recebe `saleDate` e soma os dias de repasse em cima
      dele. Entregar `now.slice(0, 10)` fazia a operadora "depositar" um dia
      depois do combinado — e a conferência da maquininha nunca fechava para
      as vendas do fim do expediente.
    */
    expect(parcela.due_date).toBe(somarDias(DIA_DA_LOJA, 30));
    expect(parcela.due_date).toBe('2026-09-30');
    expect(parcela.competence_date).toBe(DIA_DA_LOJA);
  });

  it('crédito 3× encadeia 30/60/90 a partir do dia da loja', () => {
    regraDeCredito(3, 30);

    const { sale } = vender({
      payments: [{ method: 'credito', amountCents: PRECO, installments: 3 }],
    });
    const parcelas = titulos(sale.id);
    expect(parcelas).toHaveLength(3);

    expect(parcelas.map((p) => p.due_date)).toEqual([
      somarDias(DIA_DA_LOJA, 30),
      somarDias(DIA_DA_LOJA, 60),
      somarDias(DIA_DA_LOJA, 90),
    ]);
    // Todas competem a noite em que a venda aconteceu — não a madrugada
    // seguinte em Greenwich.
    expect(parcelas.every((p) => p.competence_date === DIA_DA_LOJA)).toBe(true);
  });

  it('a TAXA da maquininha vence junto com a parcela que a gerou', () => {
    regraDeCredito(1, 30);

    const { sale } = vender({
      payments: [{ method: 'credito', amountCents: PRECO, installments: 1 }],
    });
    const [taxa] = titulos(sale.id, 'out');

    // A despesa segue a parcela: se o vencimento da parcela mudou de relógio,
    // o da taxa mudava junto — e a conferência da maquininha via dois dias.
    expect(taxa.due_date).toBe(somarDias(DIA_DA_LOJA, 30));
    expect(taxa.competence_date).toBe(DIA_DA_LOJA);
  });
});

/**
 * A OUTRA PONTA DO MESMO DEFEITO: a dívida do FORNECEDOR.
 *
 * A entrada de nota grava competência e vencimento na MESMA instrução INSERT —
 * e mesmo ali os dois liam relógios diferentes. A carga que o motorista
 * descarrega às 22h30 (hora em que caminhão de distribuidora chega mesmo)
 * nascia com um dia a mais de prazo, e o cadastro do fornecedor, que diz "30
 * dias" na tela, passava a descrever um acordo que o sistema não cumpria.
 *
 * A entrada MANUAL serve de bancada por ser o caminho mais curto até o mesmo
 * INSERT — não é um segundo escritor: `confirmNfe` é um só para as duas
 * espécies de documento, e é ele quem grava a dívida.
 */
describe('a COMPRA que chega às 22h30 conta o prazo do fornecedor pelo dia da loja', () => {
  function comprarComPrazo(dias: number): Titulo[] {
    const fornecedor = createSupplier(empresa, {
      name: 'Distribuidora Noturna Ltda',
      paymentTermDays: dias,
    }).id as string;

    const { noteId } = createManualInboundNote({
      companyId: empresa,
      userId: 'u-comprador',
      supplierId: fornecedor,
      documentNumber: 'EM-22H30',
      items: [{ productId: PRODUTO, quantity: 3, unitCostCents: 40_000 }],
    });
    confirmNfe({ companyId: empresa, noteId, userId: 'u-comprador' });

    return getConnection()
      .prepare(
        `SELECT direction, amount_cents, due_date, competence_date,
                installment_number, payment_method
           FROM core_finance_entries
          WHERE origin_type = 'entrada_manual' AND origin_id = ?`,
      )
      .all(noteId) as unknown as Titulo[];
  }

  it('prazo de 30 dias: competência 31/08 e vencimento 30/09 — não 01/10', () => {
    const [divida] = comprarComPrazo(30);

    expect(divida.competence_date).toBe(DIA_DA_LOJA);
    /*
      O NÚMERO DA MORDIDA: pelo relógio de Greenwich a dívida venceria
      2026-10-01. O fornecedor combinou trinta dias contados do dia em que
      entregou — e o dia em que ele entregou é 31/08 para todo mundo que
      estava na loja.
    */
    expect(divida.due_date).toBe('2026-09-30');
    expect(divida.due_date).toBe(somarDias(divida.competence_date, 30));
  });

  it('prazo ZERO (à vista) vence no dia da LOJA, junto da competência', () => {
    const [divida] = comprarComPrazo(0);

    expect(divida.due_date).toBe(DIA_DA_LOJA);
    expect(divida.due_date).toBe(divida.competence_date);
  });
});
