/**
 * ============================================================================
 * A FATIA À VISTA NASCE COM A LINHA DE BAIXA (V29)
 * ============================================================================
 *
 * O DEFEITO: a venda quitada gravava `settled_cents = amount_cents` direto no
 * lançamento, sem linha em `core_finance_settlements`. O saldo fechava — mas o
 * HISTÓRICO não contava a história: a conciliação bancária compara linhas do
 * extrato contra baixas, e para ela essas entradas simplesmente não existiam
 * (o banco real tinha 7 de 9 lançamentos quitados e ZERO baixas). Regime de
 * caixa, idem: sem a data e o meio de cada baixa, não há o que somar.
 *
 * O CONSERTO: a fatia que nasce quitada nasce com a baixa-espelho na MESMA
 * transação — mesmo valor, mesmo meio, mesmo instante. Nenhum saldo muda;
 * o que muda é o extrato do lançamento passar a existir.
 *
 * COMPATIBILIDADE: lançamentos ANTIGOS quitados sem baixa não são reescritos —
 * inventar uma baixa retroativa com data de hoje sujaria a conciliação de um
 * mês já vivido. A regra vale das vendas novas em diante.
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
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';

const app = createApp();
const SENHA = 'Baixa@Espelho2026';

let empresa: string;
let gestor: { Authorization: string };
let produto: string;

async function ator(login: string, profile: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function vender(body: Record<string, unknown>, chave: string) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(gestor)
    .set('Idempotency-Key', chave)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; total_cents: number };
}

interface EntryRow {
  id: string;
  amount_cents: number;
  settled_cents: number;
  status: string;
  payment_method: string | null;
}

interface SettlementRow {
  entry_id: string;
  amount_cents: number;
  method: string | null;
  settled_at: string;
}

function lancamentosDa(saleId: string): EntryRow[] {
  return getConnection()
    .prepare(
      `SELECT id, amount_cents, settled_cents, status, payment_method
         FROM core_finance_entries
        WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ?
          AND direction = 'in' -- a taxa da operadora é 'out' e não é fatia
        ORDER BY installment_number`,
    )
    .all(empresa, saleId) as unknown as EntryRow[];
}

function baixasDe(entryId: string): SettlementRow[] {
  return getConnection()
    .prepare(
      `SELECT entry_id, amount_cents, method, settled_at
         FROM core_finance_settlements WHERE entry_id = ? ORDER BY settled_at`,
    )
    .all(entryId) as unknown as SettlementRow[];
}

/** Operadora de crédito 1x com taxa, para abrir o caminho das fatias. */
async function operadoraCredito1x(): Promise<void> {
  const op = await request(app)
    .post('/api/v1/core/acquirers')
    .set(gestor)
    .send({ name: 'Cielo' });
  expect(op.status, JSON.stringify(op.body)).toBe(201);
  const rate = await request(app)
    .put(`/api/v1/core/acquirers/${op.body.acquirer.id}/rates`)
    .set(gestor)
    .send({ paymentMethod: 'credito', installments: 1, feeBps: 350, settlementDays: 30 });
  expect(rate.status, JSON.stringify(rate.body)).toBe(200);
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'baixa-espelho',
    legalName: 'Baixa Espelho Ltda',
    tradeName: 'Espelho',
    kind: 'retail',
  });
  gestor = await ator('GESTOR.ESPELHO', 'gestor');
  produto = createProduct(empresa, { name: 'Ventilador', priceCents: 10_000 }).id as string;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 20,
    referenceType: 'ajuste',
    referenceId: 'carga-espelho',
  });
});

describe('a baixa-espelho', () => {
  it('venda toda em dinheiro: o lançamento quitado tem UMA baixa do valor cheio', async () => {
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      },
      'espelho-dinheiro',
    );

    const [entrada] = lancamentosDa(venda.id);
    expect(entrada.status).toBe('settled');
    expect(entrada.settled_cents).toBe(10_000);

    const baixas = baixasDe(entrada.id);
    expect(baixas).toHaveLength(1);
    expect(baixas[0].amount_cents).toBe(10_000);
    expect(baixas[0].method).toBe('dinheiro');
    // A invariante que sustenta o extrato: a soma das baixas É o quitado.
    expect(baixas.reduce((acc, b) => acc + b.amount_cents, 0)).toBe(entrada.settled_cents);
  });

  it('o troco não vira baixa: pagou 120 numa venda de 100, a baixa é de 100', async () => {
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 12_000 }],
      },
      'espelho-troco',
    );

    const [entrada] = lancamentosDa(venda.id);
    expect(entrada.settled_cents).toBe(10_000);
    const baixas = baixasDe(entrada.id);
    expect(baixas).toHaveLength(1);
    expect(baixas[0].amount_cents).toBe(10_000);
  });

  it('venda mista com operadora: SÓ a fatia à vista nasce com baixa; a do cartão espera o depósito', async () => {
    await operadoraCredito1x();
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 2 }],
        payments: [
          { method: 'dinheiro', amountCents: 12_000 },
          { method: 'credito', amountCents: 8_000, installments: 1 },
        ],
      },
      'espelho-misto',
    );

    const fatias = lancamentosDa(venda.id);
    expect(fatias).toHaveLength(2);

    const aVista = fatias.find((f) => f.payment_method === 'dinheiro')!;
    const noCartao = fatias.find((f) => f.payment_method === 'credito')!;

    expect(aVista.status).toBe('settled');
    expect(baixasDe(aVista.id)).toHaveLength(1);
    expect(baixasDe(aVista.id)[0].amount_cents).toBe(12_000);
    expect(baixasDe(aVista.id)[0].method).toBe('dinheiro');

    // A fatia da operadora continua em aberto e SEM baixa — o dinheiro dela
    // ainda não caiu; a baixa nasce quando alguém a registrar, como sempre.
    expect(noCartao.status).toBe('open');
    expect(baixasDe(noCartao.id)).toHaveLength(0);
  });

  it('venda a prazo (sem pagamento) continua nascendo limpa: aberta e sem baixa', async () => {
    // Fiado exige saber de quem cobrar — regra da casa, não deste teste.
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Cliente do Fiado' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);

    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 1 }],
        payments: [],
        customerId: cliente.body.id,
      },
      'espelho-fiado',
    );

    const [entrada] = lancamentosDa(venda.id);
    expect(entrada.status).toBe('open');
    expect(entrada.settled_cents).toBe(0);
    expect(baixasDe(entrada.id)).toHaveLength(0);
  });

  it('a baixa-espelho aparece na rota de baixas — a tela conta a história inteira', async () => {
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'pix', amountCents: 10_000 }],
      },
      'espelho-rota',
    );
    const [entrada] = lancamentosDa(venda.id);

    const res = await request(app)
      .get(`/api/v1/core/finance/entries/${entrada.id}/settlements`)
      .set(gestor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].amountCents).toBe(10_000);
    expect(res.body.items[0].method).toBe('pix');
  });
});
