/**
 * ============================================================================
 * PARCELAMENTO MANUAL — O CARNÊ DO BALCÃO (V23)
 * ============================================================================
 *
 * O DEFEITO: venda a prazo negociada no balcão (3x sem cartão) não tinha como
 * virar 3 títulos. Ou virava um título só — e a cobrança do mês errava — ou
 * três lançamentos digitados à mão sem vínculo nenhum entre si. O esquema
 * estava PRONTO desde a rodada que pôs a parcela na chave: o comentário de
 * `core_finance_entries` promete que "no dia em que o crediário entrar, a
 * baixa, o estorno e as conciliações já funcionam sobre parcela sem uma linha
 * de código nova". Faltava o escritor.
 *
 * AS REGRAS DA CASA que este arquivo cobra:
 *   - centavos EXATOS: a soma das parcelas é o total, sem float, e o RESTO da
 *     divisão vai na PRIMEIRA parcela;
 *   - vencimentos mensais a partir do primeiro, com clamp de fim de mês
 *     (31/jan + 1 mês = 28/fev, não 3/mar);
 *   - as parcelas dividem um grupo (origin_id comum) e cada uma é baixável e
 *     estornável sozinha — as irmãs não se mexem;
 *   - as falsificações: parcela 0 é recusada, 1 parcela é o lançamento normal
 *     de sempre, parcelar sem primeiro vencimento é recusado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Carne@EmDia2026';

let empresa: string;
let gestor: { Authorization: string };

interface EntryDto {
  id: string;
  description: string;
  amountCents: number;
  balanceCents: number;
  status: string;
  dueDate: string | null;
  originType: string;
  originId: string;
  installmentNumber: number;
  installmentTotal: number;
}

async function ator(login: string, profile: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function lancar(body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/finance/entries').set(gestor).send(body);
}

async function lista(query: string): Promise<EntryDto[]> {
  const res = await request(app).get(`/api/v1/core/finance/entries?${query}`).set(gestor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as EntryDto[];
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'carne-loja',
    legalName: 'Carnê da Loja Ltda',
    tradeName: 'Carnê',
  });
  gestor = await ator('GESTOR.CARNE', 'gerente_loja');
});

describe('a criação do carnê', () => {
  it('total que não divide exato: o resto vai na PRIMEIRA parcela e a soma fecha no centavo', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Carnê da geladeira',
      amountCents: 10_000, // R$ 100,00 em 3 → 33,34 + 33,33 + 33,33
      dueDate: '2026-09-10',
      installments: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const parcelas = await lista('direction=in');
    expect(parcelas).toHaveLength(3);

    const ordenadas = [...parcelas].sort((a, b) => a.installmentNumber - b.installmentNumber);
    expect(ordenadas.map((p) => p.amountCents)).toEqual([3_334, 3_333, 3_333]);
    expect(ordenadas.reduce((acc, p) => acc + p.amountCents, 0)).toBe(10_000);

    // Todas do mesmo grupo, numeradas, e o título diz qual é qual.
    const grupo = ordenadas[0].originId;
    expect(grupo).toBeTruthy();
    for (const [i, p] of ordenadas.entries()) {
      expect(p.originId).toBe(grupo);
      expect(p.originType).toBe('manual');
      expect(p.installmentNumber).toBe(i + 1);
      expect(p.installmentTotal).toBe(3);
      expect(p.description).toBe(`Carnê da geladeira (${i + 1}/3)`);
      expect(p.status).toBe('open');
    }
  });

  it('vencimentos mensais com clamp de fim de mês: 31/jan → 28/fev → 31/mar', async () => {
    const res = await lancar({
      direction: 'out',
      description: 'Fornecedor parcelado',
      amountCents: 30_000,
      dueDate: '2026-01-31',
      installments: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const parcelas = (await lista('direction=out')).sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );
    expect(parcelas.map((p) => p.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('cada parcela baixa e estorna SOZINHA — as irmãs não se mexem', async () => {
    await lancar({
      direction: 'in',
      description: 'Carnê 2x',
      amountCents: 10_001, // ímpar de propósito: 50,01 + 50,00
      dueDate: '2026-09-10',
      installments: 2,
    });
    const [p1, p2] = (await lista('direction=in')).sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );
    expect(p1.amountCents).toBe(5_001);
    expect(p2.amountCents).toBe(5_000);

    // Baixa da SEGUNDA parcela, inteira.
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${p2.id}/settle`)
      .set(gestor)
      .send({ amountCents: 5_000, method: 'dinheiro' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    expect(baixa.body.entry.status).toBe('settled');

    // A primeira continua em aberto, intocada.
    const depois = (await lista('direction=in')).sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );
    expect(depois[0].status).toBe('open');
    expect(depois[0].balanceCents).toBe(5_001);
    expect(depois[1].status).toBe('settled');

    // Estorno devolve SÓ a parcela estornada ao aberto.
    const settlementId = baixa.body.settlements[0].id as string;
    const estorno = await request(app)
      .post(`/api/v1/core/finance/settlements/${settlementId}/reverse`)
      .set(gestor)
      .send({});
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(200);
    expect(estorno.body.entry.status).toBe('open');
    expect(estorno.body.entry.balanceCents).toBe(5_000);
  });

  it('o grupo inteiro sai pelo filtro de origem — é a consulta da tela', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Carnê 4x',
      amountCents: 40_000,
      dueDate: '2026-09-05',
      installments: 4,
    });
    expect(res.status).toBe(201);
    const grupo = (res.body as EntryDto).originId;

    const doGrupo = await lista(`direction=in&originType=manual&originId=${grupo}`);
    expect(doGrupo).toHaveLength(4);
  });
});

describe('as falsificações', () => {
  it('parcela 0, negativa ou quebrada é recusada', async () => {
    for (const installments of [0, -1, 2.5]) {
      const res = await lancar({
        direction: 'in',
        description: 'Carnê inválido',
        amountCents: 10_000,
        dueDate: '2026-09-10',
        installments,
      });
      expect(res.status, `installments=${installments}`).toBe(400);
    }
  });

  it('parcelar sem o primeiro vencimento é recusado — o carnê precisa de calendário', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Carnê sem data',
      amountCents: 10_000,
      installments: 3,
    });
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/vencimento/i);
  });

  it('1 parcela é o lançamento normal de sempre — sem sufixo, sem grupo', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Conta simples',
      amountCents: 7_500,
      dueDate: '2026-09-10',
      installments: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [unica] = await lista('direction=in');
    expect(unica.description).toBe('Conta simples');
    expect(unica.installmentNumber).toBe(1);
    expect(unica.installmentTotal).toBe(1);
    // Lançamento avulso aponta para si mesmo, como sempre apontou.
    expect(unica.originId).toBe(unica.id);
  });

  it('o número de parcelas que passar do teto é recusado com erro legível', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Carnê infinito',
      amountCents: 10_000,
      dueDate: '2026-09-10',
      installments: 61,
    });
    expect(res.status).toBe(400);
  });

  it('valor menor que o número de parcelas não fabrica parcela de zero centavo', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Migalha',
      amountCents: 2,
      dueDate: '2026-09-10',
      installments: 3,
    });
    expect(res.status).toBe(400);
  });
});

describe('a trilha', () => {
  it('a auditoria registra o carnê com o grupo e o número de parcelas', async () => {
    const res = await lancar({
      direction: 'in',
      description: 'Carnê auditado',
      amountCents: 9_000,
      dueDate: '2026-09-10',
      installments: 3,
    });
    expect(res.status).toBe(201);

    const linha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'finance.entry_created'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(empresa) as { detail: string };
    const detail = JSON.parse(linha.detail) as Record<string, unknown>;
    expect(detail.installments).toBe(3);
    expect(detail.groupId).toBe((res.body as EntryDto).originId);
  });
});
