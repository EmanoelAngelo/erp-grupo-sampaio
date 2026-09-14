/**
 * ============================================================================
 * A NOTA RECEBIDA SEM CONTA A PAGAR — GAP-PRD-088
 * ============================================================================
 *
 * O banco da Preço Justo tem a NF 9991 (R$ 1.485,60) recebida em 12/08 sem
 * título a pagar: foi confirmada antes de o financeiro nascer junto, e o código
 * decidiu não fabricar dívida retroativa. A decisão é do dono — e faltava o
 * MECANISMO: não havia lista, e o único caminho era um lançamento avulso sem
 * ligação com a nota.
 *
 * Nasceu VERMELHO contra o HEAD anterior (as rotas respondiam 404). O cenário
 * é o da NF 9991, gravado como ela está: recebida, total > 0, sem título.
 * Nada aqui toca o banco real — é o caminho que o dono vai percorrer.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(userId: string, perfil: string, empresa = 'preco-justo-9991'): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, companyId: res.body.company.id };
}

let gerente: Sessao;
let fornecedor: string;

/** A nota como a NF 9991 está: recebida, sem título, anterior ao conserto. */
function notaLegada(opcoes: { number?: string; total?: number; status?: string } = {}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, supplier_id, total_cents, status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-12T20:27:11.000Z', '2026-08-12T20:00:00.000Z')`,
    )
    .run(
      id,
      gerente.companyId,
      `3526081420016600018755001${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}1234567890`.slice(0, 44),
      opcoes.number ?? '9991',
      fornecedor,
      opcoes.total ?? 148560,
      opcoes.status ?? 'recebida',
    );
  return id;
}

function titulos(noteId: string) {
  return getConnection()
    .prepare(
      `SELECT id, amount_cents, settled_cents, status, due_date, competence_date, origin_type,
              supplier_id, category_id, note
         FROM core_finance_entries WHERE origin_id = ? AND direction = 'out'`,
    )
    .all(noteId) as unknown as Record<string, unknown>[];
}

async function lista(s: Sessao = gerente) {
  const res = await request(app).get('/api/v1/core/purchases/notas-sem-conta').set(s.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Record<string, unknown>[];
}

function decidir(noteId: string, body: Record<string, unknown>, s: Sessao = gerente) {
  return request(app).post(`/api/v1/core/purchases/notes/${noteId}/conta-a-pagar`).set(s.auth).send(body);
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-9991', 'gerente_loja');
  const f = await request(app)
    .post('/api/v1/core/suppliers')
    .set(gerente.auth)
    .send({ name: 'Distribuidora da NF 9991', paymentTermDays: 30 });
  fornecedor = f.body.id;
});

describe('GAP-PRD-088 — a lista não deixa a nota sumir por silêncio', () => {
  it('a nota recebida sem título aparece, com o vencimento que o prazo do fornecedor daria', async () => {
    const nota = notaLegada();
    // Total zero (bonificação) e nota em conferência NÃO são pendência.
    notaLegada({ number: 'BONIF', total: 0 });
    notaLegada({ number: 'EMCONF', status: 'conferencia' });

    const itens = await lista();
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({
      id: nota,
      number: '9991',
      totalCents: 148560,
      supplierName: 'Distribuidora da NF 9991',
      // Recebida em 12/08 (dia da loja) + 30 dias de prazo.
      vencimentoSugerido: '2026-09-11',
    });
  });

  it('só a gerência vê e decide', async () => {
    const nota = notaLegada();
    for (const perfil of ['estoquista', 'atendente']) {
      const s = await entrar(`${perfil}-9991`, perfil);
      expect((await request(app).get('/api/v1/core/purchases/notas-sem-conta').set(s.auth)).status).toBe(403);
      expect((await decidir(nota, { acao: 'lancar' }, s)).status).toBe(403);
    }
    expect(titulos(nota)).toEqual([]);
  });

  it('a nota da outra empresa não aparece nem se decide', async () => {
    const nota = notaLegada();
    const outra = await entrar('ger-outra-9991', 'gerente_loja', 'outra-9991');
    expect(await lista(outra)).toEqual([]);
    expect((await decidir(nota, { acao: 'lancar' }, outra)).status).toBe(404);
  });
});

describe('GAP-PRD-088 — os três gestos, cada um com prova', () => {
  it('LANÇAR: nasce o título da nota, com a origem que a confirmação daria, e a nota sai da lista', async () => {
    const nota = notaLegada();
    const res = await decidir(nota, { acao: 'lancar' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ noteId: nota, acao: 'lancar' });

    const [titulo] = titulos(nota);
    expect(titulo).toMatchObject({
      amount_cents: 148560,
      settled_cents: 0,
      status: 'open',
      due_date: '2026-09-11',
      // Competência no mês em que a mercadoria entrou.
      competence_date: '2026-08-12',
      origin_type: 'nfe_entrada',
      supplier_id: fornecedor,
    });
    expect(titulo.category_id).toBeTruthy();
    expect(String(titulo.note)).toContain('Lançada depois do recebimento');

    // A ficha da nota acha o título de volta, pela origem.
    const volta = await request(app)
      .get(`/api/v1/core/finance/entries?originType=nfe_entrada&originId=${nota}`)
      .set(gerente.auth);
    expect(volta.body.items).toHaveLength(1);
    expect(volta.body.items[0].originLabel).toContain('Nota 9991');

    expect(await lista()).toEqual([]);
    // Decidir de novo é recusa — a UNIQUE nunca chega a ser testada.
    const deNovo = await decidir(nota, { acao: 'lancar' });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error.code).toBe('CORE_NOTE_FINANCE_ALREADY_DECIDED');
    expect(titulos(nota)).toHaveLength(1);

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'purchase.note.finance_decision'")
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({ acao: 'lancar' });
  });

  it('JÁ PAGA: o título nasce e a baixa inteira fica registrada, com a forma e a data na observação', async () => {
    const nota = notaLegada();
    const semData = await decidir(nota, { acao: 'ja_paga' });
    expect(semData.status).toBe(400);
    expect(titulos(nota)).toEqual([]);

    const res = await decidir(nota, { acao: 'ja_paga', paidOn: '2026-08-20', method: 'pix' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [titulo] = titulos(nota);
    expect(titulo).toMatchObject({ amount_cents: 148560, settled_cents: 148560, status: 'settled' });
    expect(String(titulo.note)).toContain('Paga fora do sistema em 2026-08-20 (pix)');
    const baixa = getConnection()
      .prepare('SELECT amount_cents, method FROM core_finance_settlements WHERE entry_id = ?')
      .get(titulo.id as string) as { amount_cents: number; method: string };
    expect(baixa).toEqual({ amount_cents: 148560, method: 'pix' });
    expect(await lista()).toEqual([]);
  });

  it('SEM DÍVIDA: exige justificativa, grava na nota com autor e data, e não cria título', async () => {
    const nota = notaLegada();
    const semMotivo = await decidir(nota, { acao: 'sem_divida' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_NOTE_FINANCE_WAIVER_REASON');

    const res = await decidir(nota, { acao: 'sem_divida', reason: 'Mercadoria em consignação — acerto no fim do mês' });
    expect(res.status).toBe(200);
    expect(res.body.entryId).toBeNull();
    const n = getConnection()
      .prepare('SELECT finance_waiver_reason, finance_waiver_by, finance_waiver_at FROM core_inbound_notes WHERE id = ?')
      .get(nota) as Record<string, unknown>;
    expect(n.finance_waiver_reason).toBe('Mercadoria em consignação — acerto no fim do mês');
    expect(n.finance_waiver_by).toBeTruthy();
    expect(n.finance_waiver_at).toBeTruthy();
    expect(titulos(nota)).toEqual([]);
    expect(await lista()).toEqual([]);
  });

  it('ação desconhecida é recusa', async () => {
    const nota = notaLegada();
    expect((await decidir(nota, { acao: 'apagar' })).status).toBe(400);
  });
});
