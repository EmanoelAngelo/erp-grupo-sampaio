/**
 * ============================================================================
 * O CENTRO DE CUSTO GANHA LEITOR (GAP-V25)
 * ============================================================================
 *
 * ## O defeito
 *
 * `core_cost_centers` tinha cadastro completo — criar, renomear, desativar,
 * com auditoria —, `createEntry` gravava `cost_center_id` em todo lançamento e
 * a rota o repassava. NENHUMA consulta o lia: nenhum relatório agrupava,
 * nenhuma lista mostrava, nenhum filtro aceitava.
 *
 * Isso é pior do que faltar o cadastro. Um campo de classificação que não
 * responde nada acaba preenchido de qualquer jeito — e no dia em que alguém
 * finalmente o consultar, a resposta será um relatório de dados inventados
 * pela pressa de fechar o formulário.
 *
 * ## O que este arquivo cobra
 *
 * Os dois leitores, pela ROTA (cobrar o serviço direto passaria com a rota
 * engolindo o parâmetro — que é exatamente o defeito que a rodada da categoria
 * já consertou uma vez):
 *
 *   1. o FILTRO em `/finance/entries`, inclusive o avesso (`sem-centro-de-custo`);
 *   2. o RECORTE em `/finance/cost-centers/report`, que soma o MESMO período do
 *      DRE — se os dois discordarem, uma das telas está mentindo e não dá para
 *      saber qual.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

/** Os dois centros da operação, criados pela rota que já existia. */
let loja: string;
let oficina: string;

async function criarCentro(code: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/finance/cost-centers')
    .set(auth)
    .send({ code, name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.costCenter.id as string;
}

async function lancar(input: {
  direction: 'in' | 'out';
  description: string;
  amountCents: number;
  costCenterId?: string | null;
  competenceDate: string;
}) {
  const res = await request(app)
    .post('/api/v1/core/finance/entries')
    .set(auth)
    .send({ ...input, dueDate: input.competenceDate });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function listar(query: string) {
  return request(app).get(`/api/v1/core/finance/entries?${query}`).set(auth);
}

function relatorio(from = '2026-08-01', to = '2026-08-31') {
  return request(app)
    .get(`/api/v1/core/finance/cost-centers/report?from=${from}&to=${to}`)
    .set(auth);
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-centro',
    companyId: 'loja-centro',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  loja = await criarCentro('LOJA', 'Loja centro');
  oficina = await criarCentro('OFI', 'Oficina');
});

describe('o filtro na lista de contas', () => {
  beforeEach(async () => {
    await lancar({
      direction: 'out',
      description: 'Aluguel da loja',
      amountCents: 250_000,
      costCenterId: loja,
      competenceDate: '2026-08-05',
    });
    await lancar({
      direction: 'out',
      description: 'Ferramenta da bancada',
      amountCents: 30_000,
      costCenterId: oficina,
      competenceDate: '2026-08-06',
    });
    await lancar({
      direction: 'out',
      description: 'Energia (sem rateio)',
      amountCents: 90_000,
      costCenterId: null,
      competenceDate: '2026-08-07',
    });
  });

  it('recorta pelo centro pedido', async () => {
    const res = await listar(`direction=out&costCenterId=${loja}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].description).toBe('Aluguel da loja');
  });

  it('a linha CARREGA o centro — filtro que não se confere não serve', async () => {
    const res = await listar(`direction=out&costCenterId=${oficina}`);
    expect(res.body.items[0].costCenterId).toBe(oficina);
    expect(res.body.items[0].costCenterName).toBe('Oficina');
  });

  it('o avesso traz o que ninguém atribuiu', async () => {
    // É o recorte mais provável no primeiro mês: o banco real tem zero
    // lançamentos com centro. Sem esta opção, saber que existem não ajuda
    // ninguém a classificá-los.
    const res = await listar('direction=out&costCenterId=sem-centro-de-custo');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].description).toBe('Energia (sem rateio)');
    expect(res.body.items[0].costCenterId).toBeNull();
  });

  it('sem filtro, a lista continua inteira', async () => {
    const res = await listar('direction=out');
    expect(res.body.items).toHaveLength(3);
  });

  it('o parâmetro CHEGA ao serviço — a rota não o engole', async () => {
    /*
      Este é o caso que dá sentido ao arquivo. Um filtro escrito na tela e não
      repassado pela rota devolve a lista INTEIRA, e quem filtrou acredita que
      aquilo é o recorte que pediu. Foi assim que `categoryId`, `costCenterId`,
      `accountId` e `competenceDate` viajaram meses sem chegar.
    */
    const semFiltro = await listar('direction=out');
    const comFiltro = await listar(`direction=out&costCenterId=${loja}`);
    expect(comFiltro.body.items.length).toBeLessThan(semFiltro.body.items.length);
  });
});

describe('o recorte do período por centro', () => {
  beforeEach(async () => {
    await lancar({
      direction: 'out',
      description: 'Aluguel da loja',
      amountCents: 250_000,
      costCenterId: loja,
      competenceDate: '2026-08-05',
    });
    await lancar({
      direction: 'in',
      description: 'Venda de balcão',
      amountCents: 400_000,
      costCenterId: loja,
      competenceDate: '2026-08-10',
    });
    await lancar({
      direction: 'out',
      description: 'Ferramenta da bancada',
      amountCents: 30_000,
      costCenterId: oficina,
      competenceDate: '2026-08-06',
    });
    await lancar({
      direction: 'out',
      description: 'Energia (sem rateio)',
      amountCents: 90_000,
      costCenterId: null,
      competenceDate: '2026-08-07',
    });
  });

  it('agrupa em centavos exatos, com receita, despesa e resultado', async () => {
    const res = await relatorio();
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const daLoja = res.body.lines.find(
      (l: { costCenterId: string | null }) => l.costCenterId === loja,
    );
    expect(daLoja.revenueCents).toBe(400_000);
    expect(daLoja.expenseCents).toBe(250_000);
    expect(daLoja.resultCents).toBe(150_000);
    expect(daLoja.entryCount).toBe(2);
    expect(daLoja.costCenterCode).toBe('LOJA');
  });

  it('o que ninguém atribuiu tem casa própria, e ela é NOMEADA', async () => {
    const res = await relatorio();
    const semCentro = res.body.lines.find(
      (l: { costCenterId: string | null }) => l.costCenterId === null,
    );
    expect(semCentro.expenseCents).toBe(90_000);
    expect(res.body.unassigned.entryCount).toBe(1);
    expect(res.body.unassigned.expenseCents).toBe(90_000);
  });

  it('"sem centro" vai por ÚLTIMO — é ação, não destaque no meio', async () => {
    const res = await relatorio();
    const ultima = res.body.lines[res.body.lines.length - 1];
    expect(ultima.costCenterId).toBeNull();
  });

  it('os totais BATEM com o DRE do mesmo período', async () => {
    /*
      A propriedade que sustenta as duas tabelas na mesma tela. Se o recorte
      por centro somasse um conjunto diferente do DRE, alguém leria os dois e
      não saberia em qual acreditar — e as duas estariam plausíveis.
    */
    const centros = await relatorio();
    const dre = await request(app)
      .get('/api/v1/core/finance/income-statement?from=2026-08-01&to=2026-08-31')
      .set(auth);

    expect(centros.body.revenueTotalCents).toBe(dre.body.revenue.totalCents);
    expect(centros.body.expenseTotalCents).toBe(dre.body.expense.totalCents);
    expect(centros.body.resultCents).toBe(dre.body.resultCents);
    expect(centros.body.entryCount).toBe(
      dre.body.revenue.entryCount + dre.body.expense.entryCount,
    );
  });

  it('as linhas somam os totais — a prova de cobertura', async () => {
    const res = await relatorio();
    const somaReceita = res.body.lines.reduce(
      (acc: number, l: { revenueCents: number }) => acc + l.revenueCents,
      0,
    );
    const somaDespesa = res.body.lines.reduce(
      (acc: number, l: { expenseCents: number }) => acc + l.expenseCents,
      0,
    );
    expect(somaReceita).toBe(res.body.revenueTotalCents);
    expect(somaDespesa).toBe(res.body.expenseTotalCents);
  });

  it('período de outro mês não traz nada deste', async () => {
    const res = await relatorio('2026-09-01', '2026-09-30');
    expect(res.body.lines).toHaveLength(0);
    expect(res.body.expenseTotalCents).toBe(0);
  });

  it('centro DESATIVADO continua nomeado no passado', async () => {
    /*
      Esconder o nome do centro encerrado transformaria despesa de um centro
      real em "Sem centro de custo", e o mês FECHADO mudaria de cara no dia em
      que alguém desativasse o centro. O formulário esconde o inativo; o
      relatório do passado, não.
    */
    const desativou = await request(app)
      .patch(`/api/v1/core/finance/cost-centers/${oficina}`)
      .set(auth)
      .send({ active: false });
    expect(desativou.status, JSON.stringify(desativou.body)).toBe(200);

    const res = await relatorio();
    const daOficina = res.body.lines.find(
      (l: { costCenterId: string | null }) => l.costCenterId === oficina,
    );
    expect(daOficina.costCenterName).toBe('Oficina');
  });
});

describe('a lista de centros para seletor e filtro', () => {
  it('responde a quem alcança a tela de Contas, não só ao gerente', async () => {
    /*
      A tela de Contas é ROTA_GESTAO: estoquista e atendente chegam nela. Um
      seletor que responde 403 para quem a tela deixou entrar é tela quebrada
      em produção — o desencontro que a rodada 23 fechou.
    */
    const estoquista = await loginForTest(app, {
      userId: 'estoquista-centro',
      companyId: 'loja-centro',
      profileCodes: ['estoquista'],
    });
    const res = await request(app)
      .get('/api/v1/core/finance/cost-centers')
      .set({ Authorization: `Bearer ${estoquista.body.accessToken}` });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((c: { code: string }) => c.code).sort()).toEqual(['LOJA', 'OFI']);
  });

  it('não vaza valor nenhum: só código e nome', async () => {
    const res = await request(app).get('/api/v1/core/finance/cost-centers').set(auth);
    const primeiro = res.body.items[0] as Record<string, unknown>;
    expect(Object.keys(primeiro)).not.toContain('balance_cents');
    expect(primeiro.code).toBeTruthy();
    expect(primeiro.name).toBeTruthy();
  });

  it('centro de OUTRA empresa não aparece', async () => {
    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinho-centro',
      companyId: 'loja-vizinha-centro',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/finance/cost-centers')
      .set({ Authorization: `Bearer ${vizinha.body.accessToken}` });
    expect(res.body.items).toHaveLength(0);
  });
});
