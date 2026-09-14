/**
 * ============================================================================
 * AGING — O VENCIDO POR IDADE (V24)
 * ============================================================================
 *
 * O DEFEITO: o gestor via QUANTO estava vencido (`overdueCents`), mas não HÁ
 * QUANTO TEMPO. Priorizar cobrança — ligar primeiro para quem deve há 90 dias,
 * não há 3 — exigia filtrar datas na mão. Nenhuma superfície respondia por
 * faixa de atraso.
 *
 * O que este arquivo cobra:
 *   - a rota de contas devolve `aging` com as cinco faixas da casa:
 *     a vencer, 1-30, 31-60, 61-90 e mais de 90 dias;
 *   - o corte é o DIA DA LOJA (`hojeNaLoja`), o mesmo régua de `overdue` —
 *     duas réguas divergiriam perto da meia-noite;
 *   - as FRONTEIRAS caem do lado certo (30 dias ainda é 1-30; 31 já é 31-60);
 *   - quem conta é o SALDO, não o valor original — baixa parcial diminui a
 *     faixa;
 *   - quitada e cancelada não envelhecem, e um lado não vaza no outro.
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
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';

const app = createApp();
const SENHA = 'Aging@PorFaixas2026';

let empresa: string;
let gestor: { Authorization: string };

interface AgingDto {
  notDueCents: number;
  days1to30Cents: number;
  days31to60Cents: number;
  days61to90Cents: number;
  over90Cents: number;
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

async function conta(
  amountCents: number,
  dueDate: string | null,
  direction: 'in' | 'out' = 'in',
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/finance/entries')
    .set(gestor)
    .send({ direction, description: `Conta ${dueDate ?? 'sem data'}`, amountCents, dueDate });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function agingDe(direction: 'in' | 'out'): Promise<{
  aging: AgingDto;
  summary: { openCents: number; overdueCents: number };
}> {
  const res = await request(app)
    .get(`/api/v1/core/finance/entries?direction=${direction}`)
    .set(gestor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.aging, 'a rota precisa devolver o aging').toBeTruthy();
  return { aging: res.body.aging as AgingDto, summary: res.body.summary };
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'aging-loja',
    legalName: 'Aging da Loja Ltda',
    tradeName: 'Aging',
  });
  gestor = await ator('GESTOR.AGING', 'gerente_loja');
});

describe('as cinco faixas', () => {
  it('cada conta cai na faixa da sua idade — fronteiras incluídas, pelo dia da loja', async () => {
    const hoje = hojeNaLoja();

    await conta(1_000, somarDias(hoje, 5)); //     a vencer (futuro)
    await conta(2_000, hoje); //                   a vencer (vence HOJE não é vencida)
    await conta(400, null); //                     a vencer (sem vencimento não envelhece)
    await conta(3_000, somarDias(hoje, -1)); //    1-30 (fronteira de baixo)
    await conta(4_000, somarDias(hoje, -30)); //   1-30 (fronteira de cima)
    await conta(5_000, somarDias(hoje, -31)); //   31-60
    await conta(6_000, somarDias(hoje, -60)); //   31-60
    await conta(7_000, somarDias(hoje, -61)); //   61-90
    await conta(8_000, somarDias(hoje, -90)); //   61-90
    await conta(9_000, somarDias(hoje, -91)); //   >90
    await conta(10_000, somarDias(hoje, -400)); // >90

    const { aging, summary } = await agingDe('in');
    expect(aging).toEqual({
      notDueCents: 1_000 + 2_000 + 400,
      days1to30Cents: 3_000 + 4_000,
      days31to60Cents: 5_000 + 6_000,
      days61to90Cents: 7_000 + 8_000,
      over90Cents: 9_000 + 10_000,
    });

    // A identidade que amarra o aging ao resto da tela: as faixas somam o
    // MESMO aberto do resumo, e as quatro vencidas somam o MESMO vencido.
    const somaFaixas =
      aging.notDueCents +
      aging.days1to30Cents +
      aging.days31to60Cents +
      aging.days61to90Cents +
      aging.over90Cents;
    expect(somaFaixas).toBe(summary.openCents);
    expect(somaFaixas - aging.notDueCents).toBe(summary.overdueCents);
  });

  it('quem conta é o SALDO: baixa parcial encolhe a faixa', async () => {
    const hoje = hojeNaLoja();
    const id = await conta(10_000, somarDias(hoje, -40)); // 31-60

    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(gestor)
      .send({ amountCents: 4_000, method: 'pix' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);

    const { aging } = await agingDe('in');
    expect(aging.days31to60Cents).toBe(6_000);
  });

  it('quitada não envelhece, cancelada não existe, e um lado não vaza no outro', async () => {
    const hoje = hojeNaLoja();
    const quitada = await conta(5_000, somarDias(hoje, -50));
    await request(app)
      .post(`/api/v1/core/finance/entries/${quitada}/settle`)
      .set(gestor)
      .send({ amountCents: 5_000 });

    const cancelada = await conta(7_000, somarDias(hoje, -50));
    getConnection()
      .prepare('UPDATE core_finance_entries SET cancelled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), cancelada);

    // A dívida vencida é do lado de PAGAR — não pode sujar o aging de receber.
    await conta(9_000, somarDias(hoje, -70), 'out');

    const receber = await agingDe('in');
    expect(receber.aging).toEqual({
      notDueCents: 0,
      days1to30Cents: 0,
      days31to60Cents: 0,
      days61to90Cents: 0,
      over90Cents: 0,
    });

    const pagar = await agingDe('out');
    expect(pagar.aging.days61to90Cents).toBe(9_000);
  });
});
