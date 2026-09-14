/**
 * ============================================================================
 * O QUADRO COM VERSÃO, A COLUNA QUE PAGINA E A OS FORA DAS REGRAS
 * (GAP-PRD-183, GAP-PRD-187, GAP-PRD-188)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-183: gerente e mecânico com o quadro aberto movem a mesma OS; os
 *     dois recebem 200 e a coluna final é a de quem clicou por último.
 *   - GAP-PRD-187: a coluna pede 60 cards e o servidor ordena por número DESC —
 *     acima de 60, as MAIS ANTIGAS (as de SLA estourado) somem do quadro.
 *   - GAP-PRD-188: a OS #1 do banco da loja está sem bancada, em andamento e
 *     sem responsável, com um evento finalizada → em andamento. A porta que
 *     deixou isso nascer é o assumir sem conferir a situação; o dado precisa
 *     de um caminho de conserto pela tela.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

const OFICINA = 'oficina-qv';
const OUTRA = 'outra-qv';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

let gerente: Ator;
let mec1: Ator;
let mec2: Ator;
let gerenteOutra: Ator;
const BANCADA = 'wk-qv-a';

async function entrar(userId: string, empresa: string, perfil: string): Promise<Ator> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

function bancada(id: string, empresa: string, nome: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, ?, 'mobility', 1, ?)`,
    )
    .run(id, empresa, `slug-${id}`, nome, new Date().toISOString());
}

function vincular(workshopId: string, userId: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), workshopId, userId, new Date().toISOString());
}

function linha(osId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(osId) as Record<string, unknown>;
}

function eventos(osId: string): { from_status: string | null; to_status: string; note: string | null }[] {
  return getConnection()
    .prepare(
      'SELECT from_status, to_status, note FROM core_service_order_events WHERE order_id = ? ORDER BY created_at, rowid',
    )
    .all(osId) as unknown as { from_status: string | null; to_status: string; note: string | null }[];
}

async function abrir(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente.auth)
    .send({ customerName: 'Cliente', complaint: 'Não liga', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

async function assumir(ator: Ator, osId: string): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/assume`)
    .set(ator.auth)
    .send({ status: 'em_andamento', comment: 'assumindo' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Record<string, unknown>;
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('ger-qv', OFICINA, 'gerente_oficina');
  mec1 = await entrar('mec1-qv', OFICINA, 'mecanico');
  mec2 = await entrar('mec2-qv', OFICINA, 'mecanico');
  gerenteOutra = await entrar('ger-outra-qv', OUTRA, 'gerente_oficina');
  bancada(BANCADA, OFICINA, 'Bancada A');
  bancada('wk-qv-outra', OUTRA, 'Bancada da outra');
  vincular(BANCADA, mec1.userId);
  vincular(BANCADA, mec2.userId);
});

// ---------------------------------------------------------------- GAP-PRD-183

describe('GAP-PRD-183 — dois operadores na mesma OS: quem move sobre o retrato velho é avisado', () => {
  it('o gerente move primeiro; o mecânico com o quadro antigo leva 409 e a OS fica onde o gerente pôs', async () => {
    const os = await abrir();
    const assumida = await assumir(mec1, os);
    // Os dois abriram o quadro com a OS em andamento, no mesmo instante.
    const retrato = {
      expectedStatus: assumida.status,
      expectedStatusChangedAt: assumida.status_changed_at,
    };
    const eventosAntes = eventos(os).length;

    const doGerente = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(gerente.auth)
      .send({ status: 'aguardando_peca', comment: 'Peça pedida ao fornecedor', ...retrato });
    expect(doGerente.status, JSON.stringify(doGerente.body)).toBe(200);

    const doMecanico = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({ status: 'manutencao_externa', comment: 'Mandei para a retífica', ...retrato });
    expect(doMecanico.status).toBe(409);
    expect(doMecanico.body.error.code).toBe('CORE_ORDER_STALE');
    expect(doMecanico.body.error.message).toContain('Aguardando peça');
    expect(doMecanico.body.error.message).toContain('ger-qv');
    expect(doMecanico.body.error.details).toMatchObject({ statusAtual: 'aguardando_peca' });

    // A coluna é a do primeiro, e o segundo movimento não deixou rastro nenhum.
    expect(linha(os).status).toBe('aguardando_peca');
    expect(eventos(os)).toHaveLength(eventosAntes + 1);
    const comentarios = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_service_order_comments WHERE order_id = ? AND body LIKE '%retífica%'")
      .get(os) as { n: number };
    expect(comentarios.n).toBe(0);
  });

  it('a volta completa (A → B → A) também é mudança: a coluna é a mesma, o instante não', async () => {
    const os = await abrir();
    const assumida = await assumir(mec1, os);
    const retrato = {
      expectedStatus: assumida.status,
      expectedStatusChangedAt: assumida.status_changed_at,
    };
    await new Promise((r) => setTimeout(r, 5));
    for (const status of ['aguardando_peca', 'em_andamento']) {
      const res = await request(app)
        .post(`/api/v1/core/workshop/orders/${os}/move`)
        .set(gerente.auth)
        .send({ status, comment: `ida e volta: ${status}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    const velho = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({ status: 'parada_setor', comment: 'parou', ...retrato });
    expect(velho.status).toBe(409);
    expect(velho.body.error.code).toBe('CORE_ORDER_STALE');
  });

  it('com o retrato em dia, o movimento passa; sem retrato, o contrato antigo continua valendo', async () => {
    const os = await abrir();
    const assumida = await assumir(mec1, os);
    const emDia = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({
        status: 'parada_setor',
        comment: 'aguardando o setor de pintura',
        expectedStatus: assumida.status,
        expectedStatusChangedAt: assumida.status_changed_at,
      });
    expect(emDia.status, JSON.stringify(emDia.body)).toBe(200);

    const semRetrato = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({ status: 'em_andamento', comment: 'voltou do setor' });
    expect(semRetrato.status, JSON.stringify(semRetrato.body)).toBe(200);
  });

  it('dois técnicos assumindo a mesma OS em aberto: o segundo lê que ela mudou, não "já assumida" sem contexto', async () => {
    const os = await abrir();
    const aberta = linha(os);
    const retrato = {
      expectedStatus: 'em_aberto',
      expectedStatusChangedAt: aberta.status_changed_at,
    };
    const primeiro = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/assume`)
      .set(mec1.auth)
      .send({ status: 'em_andamento', comment: 'eu pego', ...retrato });
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);

    const segundo = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/assume`)
      .set(mec2.auth)
      .send({ status: 'em_andamento', comment: 'eu também', ...retrato });
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CORE_ORDER_STALE');
    expect(linha(os).mechanic_id).toBe(mec1.userId);
  });

  it('largar sobre retrato velho também é recusado', async () => {
    const os = await abrir();
    const assumida = await assumir(mec1, os);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({ status: 'aguardando_peca', comment: 'faltou peça' })
      .expect(200);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/release`)
      .set(gerente.auth)
      .send({
        reason: 'remanejando',
        expectedStatus: assumida.status,
        expectedStatusChangedAt: assumida.status_changed_at,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_STALE');
    expect(linha(os).mechanic_id).toBe(mec1.userId);
  });

  it('pré-condição malformada é 400: trava que aceita qualquer coisa não trava', async () => {
    const os = await abrir();
    await assumir(mec1, os);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/move`)
      .set(mec1.auth)
      .send({ status: 'aguardando_peca', comment: 'x', expectedStatus: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_ORDER_VERSION_INVALID');
  });
});

// ---------------------------------------------------------------- GAP-PRD-187

describe('GAP-PRD-187 — a coluna cheia pagina a partir das mais antigas', () => {
  /** N OS paradas em "aguardando peça", do mec1, com a prioridade dada. */
  async function empilhar(n: number, prioridade = 'media'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await abrir({ priority: prioridade }));
    const agora = new Date().toISOString();
    const mover = getConnection().prepare(
      `UPDATE core_service_orders
          SET status = 'aguardando_peca', mechanic_id = ?, status_changed_at = ?
        WHERE id = ?`,
    );
    for (const id of ids) mover.run(mec1.userId, agora, id);
    return ids;
  }

  it('com 70 na coluna, a primeira página traz as 60 MAIS ANTIGAS e a segunda as 10 restantes, sem repetir', async () => {
    const ids = await empilhar(70);
    const numeros = ids.map((id) => Number(linha(id).number));

    const p1 = await request(app)
      .get('/api/v1/core/workshop/orders?status=aguardando_peca&limit=60&ordem=quadro')
      .set(gerente.auth);
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect(p1.body.total).toBe(70);
    const n1 = (p1.body.items as { number: number }[]).map((o) => o.number);
    // A mais antiga está no quadro — era exatamente ela que sumia.
    expect(n1[0]).toBe(Math.min(...numeros));
    expect(n1).toEqual([...n1].sort((a, b) => a - b));

    const p2 = await request(app)
      .get('/api/v1/core/workshop/orders?status=aguardando_peca&limit=60&offset=60&ordem=quadro')
      .set(gerente.auth);
    const n2 = (p2.body.items as { number: number }[]).map((o) => o.number);
    expect(n2).toHaveLength(10);
    expect(new Set([...n1, ...n2]).size).toBe(70);
    expect(Math.max(...n1)).toBeLessThan(Math.min(...n2));
  });

  it('a urgente mais nova vem antes da média mais velha, como no card', async () => {
    await empilhar(3, 'media');
    const [urgente] = await empilhar(1, 'urgente');
    const res = await request(app)
      .get('/api/v1/core/workshop/orders?status=aguardando_peca&limit=2&ordem=quadro')
      .set(gerente.auth);
    expect(res.body.items[0].id).toBe(urgente);
  });

  it('sem `ordem=quadro`, a lista continua pelas mais recentes (a lista de OS e a coluna de finalizadas)', async () => {
    const ids = await empilhar(3);
    const res = await request(app)
      .get('/api/v1/core/workshop/orders?status=aguardando_peca')
      .set(gerente.auth);
    const numeros = (res.body.items as { number: number }[]).map((o) => o.number);
    expect(numeros[0]).toBe(Math.max(...ids.map((id) => Number(linha(id).number))));
  });
});

// ---------------------------------------------------------------- GAP-PRD-188

describe('GAP-PRD-188 — assumir não tira OS da fila do caixa nem reabre OS finalizada', () => {
  it('o técnico responsável não "reassume" a própria OS finalizada (era assim que nascia finalizada → em andamento)', async () => {
    const os = await abrir();
    await assumir(mec1, os);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/complete`)
      .set(mec1.auth)
      .send({ diagnosis: 'Garantia do conector', hasCost: false, noCostReason: 'garantia', forcarChecklist: true })
      .expect(200);
    expect(linha(os).status).toBe('finalizada');

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/assume`)
      .set(mec1.auth)
      .send({ status: 'em_andamento', comment: 'reabrindo' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_PAST_BOARD');
    expect(linha(os).status).toBe('finalizada');
    expect(eventos(os).some((e) => e.from_status === 'finalizada')).toBe(false);
  });

  it('nem a OS da fila do caixa — tirar de lá é do gerente', async () => {
    const os = await abrir();
    await assumir(mec1, os);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/labor`)
      .set(mec1.auth)
      .send({ laborCents: 5000 })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/complete`)
      .set(mec1.auth)
      .send({ diagnosis: 'Troca do cabo', hasCost: true, forcarChecklist: true })
      .expect(200);
    expect(linha(os).status).toBe('aguardando_pagamento');

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/assume`)
      .set(mec1.auth)
      .send({ status: 'em_andamento', comment: 'volta' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_PAST_BOARD');
    expect(linha(os).status).toBe('aguardando_pagamento');
  });

  it('assumir de novo a OS que já é sua não grava evento de uma coluna para ela mesma', async () => {
    const os = await abrir();
    await assumir(mec1, os);
    const antes = eventos(os).length;
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/assume`)
      .set(mec1.auth)
      .send({ status: 'em_andamento', comment: 'de novo' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_ALREADY_YOURS');
    expect(eventos(os)).toHaveLength(antes);
  });
});

describe('GAP-PRD-188 — a OS legada tem caminho de conserto pela tela', () => {
  /** A OS #1 do banco da loja: sem bancada, em andamento, sem responsável. */
  async function osLegada(): Promise<string> {
    const os = await abrir();
    getConnection()
      .prepare(
        `UPDATE core_service_orders
            SET workshop_id = NULL, mechanic_id = NULL, status = 'em_andamento'
          WHERE id = ?`,
      )
      .run(os);
    return os;
  }

  it('o quadro e a ficha dizem o que está fora das regras', async () => {
    const os = await osLegada();
    const quadro = await request(app)
      .get('/api/v1/core/workshop/orders?status=em_andamento')
      .set(gerente.auth);
    const card = (quadro.body.items as { id: string; irregularidades: string[] }[]).find((o) => o.id === os);
    expect(card?.irregularidades).toEqual(['sem_bancada', 'sem_responsavel']);

    const ficha = await request(app).get(`/api/v1/core/workshop/orders/${os}`).set(gerente.auth);
    expect(ficha.body.irregularidades).toEqual(['sem_bancada', 'sem_responsavel']);

    const emDia = await abrir();
    const fichaEmDia = await request(app).get(`/api/v1/core/workshop/orders/${emDia}`).set(gerente.auth);
    expect(fichaEmDia.body.irregularidades).toEqual([]);
  });

  it('regularizar para o quadro: ganha a bancada, volta para "em aberto" com motivo, e o próximo técnico assume', async () => {
    const os = await osLegada();
    // Antes: nem largar (já "sem responsável") nem concluir (não assumida).
    const largar = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/release`)
      .set(gerente.auth)
      .send({ reason: 'tentar' });
    expect(largar.status).toBe(409);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: 'OS de antes da bancada existir' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'em_aberto', workshop_id: BANCADA, mechanic_id: null });

    const ultimo = eventos(os).at(-1)!;
    expect(ultimo).toMatchObject({ from_status: 'em_andamento', to_status: 'em_aberto' });
    expect(ultimo.note).toContain('OS de antes da bancada existir');
    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'workshop.order.regularize' AND entity_id = ?")
      .get(os) as { detail: string } | undefined;
    expect(auditoria).toBeTruthy();
    expect(JSON.parse(auditoria!.detail)).toMatchObject({
      destino: 'quadro',
      irregularidadesAntes: ['sem_bancada', 'sem_responsavel'],
      statusAntes: 'em_andamento',
      statusDepois: 'em_aberto',
      workshopIdAntes: null,
      workshopIdDepois: BANCADA,
    });

    await assumir(mec2, os);
    expect(linha(os).mechanic_id).toBe(mec2.userId);
  });

  it('encerrar como lançamento indevido: finalizada, sem custo, sem venda — e só quando não há dinheiro', async () => {
    const os = await osLegada();
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'encerrar', motivo: 'OS de teste da implantação' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = linha(os);
    expect(depois).toMatchObject({
      status: 'finalizada',
      has_cost: 0,
      no_cost_reason: 'lancamento_indevido',
      sale_id: null,
      workshop_id: BANCADA,
    });
    expect(depois.closed_at).toBeTruthy();
    expect(eventos(os).at(-1)).toMatchObject({ from_status: 'em_andamento', to_status: 'finalizada' });

    // OS com mão de obra lançada não é lançamento indevido.
    const comDinheiro = await abrir();
    await assumir(mec1, comDinheiro);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${comDinheiro}/labor`)
      .set(mec1.auth)
      .send({ laborCents: 3000 })
      .expect(200);
    const recusa = await request(app)
      .post(`/api/v1/core/workshop/orders/${comDinheiro}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'encerrar', motivo: 'engano' });
    expect(recusa.status).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_ORDER_HAS_MONEY');
    expect(linha(comDinheiro).status).toBe('em_andamento');
  });

  it('as recusas: mecânico 403, sem motivo 400, OS em dia 409, várias bancadas pedem a escolha, outra empresa 404', async () => {
    const os = await osLegada();
    const doMecanico = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(mec1.auth)
      .send({ destino: 'quadro', motivo: 'x' });
    expect(doMecanico.status).toBe(403);

    const semMotivo = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: '  ' });
    expect(semMotivo.status).toBe(400);

    const destinoRuim = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'apagar', motivo: 'x' });
    expect(destinoRuim.status).toBe(400);

    const emDia = await abrir();
    const nada = await request(app)
      .post(`/api/v1/core/workshop/orders/${emDia}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: 'x' });
    expect(nada.status).toBe(409);
    expect(nada.body.error.code).toBe('CORE_ORDER_NOTHING_TO_FIX');

    bancada('wk-qv-b', OFICINA, 'Bancada B');
    const escolha = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: 'x' });
    expect(escolha.status).toBe(400);
    expect(escolha.body.error.code).toBe('CORE_WORKSHOP_REQUIRED');
    const alheia = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: 'x', workshopId: 'wk-qv-outra' });
    expect(alheia.status).toBe(403);
    const naB = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerente.auth)
      .send({ destino: 'quadro', motivo: 'x', workshopId: 'wk-qv-b' });
    expect(naB.status, JSON.stringify(naB.body)).toBe(200);
    expect(naB.body.workshop_id).toBe('wk-qv-b');

    const deFora = await request(app)
      .post(`/api/v1/core/workshop/orders/${os}/regularizar`)
      .set(gerenteOutra.auth)
      .send({ destino: 'encerrar', motivo: 'x' });
    expect(deFora.status).toBe(404);
  });

  it('a OS de coluna de trabalho sem responsável ainda pode ser assumida — e a linha do tempo diz que era isso', async () => {
    const os = await osLegada();
    getConnection().prepare('UPDATE core_service_orders SET workshop_id = ? WHERE id = ?').run(BANCADA, os);
    await assumir(mec1, os);
    expect(eventos(os).at(-1)).toMatchObject({
      from_status: 'em_andamento',
      to_status: 'em_andamento',
      note: 'OS assumida (estava sem responsável)',
    });
  });
});
