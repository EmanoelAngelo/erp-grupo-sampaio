/**
 * ============================================================================
 * O QUADRO GANHA PRIORIDADE, SLA E MEMÓRIA — rodada 51
 * ============================================================================
 *
 * A lógica portada do sistema anterior da oficina (o que o dono aprovou),
 * sobre o NOSSO motor — com dois defeitos do antigo deixados para trás, de
 * propósito:
 *
 *   - lá o relógio do SLA contava do `updatedAt`, que reiniciava a cada
 *     comentário ou foto — o card "esquecia" o atraso toda vez que alguém
 *     tocava na OS. Aqui o relógio é `status_changed_at`: só a MUDANÇA DE
 *     COLUNA o reinicia;
 *   - lá a régua do SLA morava no localStorage de cada navegador — o quadro
 *     discordava de si mesmo entre máquinas. Aqui é POR EMPRESA, no banco.
 *
 * As regras que este arquivo trava:
 *
 *   - OS nasce com prioridade `media`; prioridade decide a ordem da coluna e
 *     a régua; replanejar fica na linha do tempo com autor;
 *   - TODO movimento no quadro exige observação (era boa vontade da tela; é
 *     regra do servidor agora);
 *   - devolver ao quadro é LARGAR: justificativa obrigatória, responsável
 *     limpo, e o próximo técnico assume;
 *   - a fila do caixa não se entra por arrasto (só pela conclusão técnica) e
 *     não se sai dela sem ser gerente;
 *   - `parada_setor` é coluna de verdade, na ordem do quadro antigo;
 *   - a régua tem os DEFAULTS verbatim do antigo, o gestor edita por célula
 *     (1–720h), célula igual ao padrão é apagada, e a personalização é por
 *     empresa.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *  - trocando `status_changed_at` por `updated_at` no comentário, o caso do
 *    relógio fica vermelho (é o defeito do antigo voltando);
 *  - tirando a exigência de observação do move, o caso do 400 falha;
 *  - tirando a limpeza do `mechanic_id` do largar, o caso do "próximo técnico
 *    assume" falha com CORE_ORDER_ALREADY_ASSIGNED;
 *  - apagando o backfill da migração 66, o caso do banco v65 fica com
 *    status_changed_at nulo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let gerente: Record<string, string>;
let mecanicoA: Record<string, string>;
let mecanicoB: Record<string, string>;

async function entrar(userId: string, profileCodes: string[], companyId = 'oficina-co') {
  const res = await loginForTest(app, { userId, companyId, profileCodes });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function criarBancada(companyId = 'oficina-co', id = 'ws-mob'): void {
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, ?, 'Mobilidade', 'mobility', 1, ?)`,
    )
    .run(id, companyId, `slug-${id}`, new Date().toISOString());
}

async function abrirOs(auth: Record<string, string>, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(auth)
    .send({ customerName: 'Maria', complaint: 'Não carrega', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    id: string;
    priority: string;
    due_date: string | null;
    status_changed_at: string | null;
  };
}

async function assumir(auth: Record<string, string>, orderId: string, status = 'em_andamento') {
  const res = await request(app)
    .post(`/api/v1/core/workshop/orders/${orderId}/assume`)
    .set(auth)
    .send({ status, comment: 'Assumindo o serviço' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function osCrua(orderId: string) {
  return getConnection()
    .prepare(
      'SELECT status, mechanic_id, priority, due_date, status_changed_at, updated_at FROM core_service_orders WHERE id = ?',
    )
    .get(orderId) as {
    status: string;
    mechanic_id: string | null;
    priority: string;
    due_date: string | null;
    status_changed_at: string | null;
    updated_at: string;
  };
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-of', ['gerente_oficina']);
  criarBancada();
  mecanicoA = await entrar('mec-a', ['mecanico']);
  mecanicoB = await entrar('mec-b', ['mecanico']);
});

describe('prioridade e prazo', () => {
  it('a OS nasce media, sem prazo, e com o relógio da coluna ligado', async () => {
    const os = await abrirOs(gerente);
    expect(os.priority).toBe('media');
    expect(os.due_date).toBeNull();
    expect(os.status_changed_at).toBeTruthy();
  });

  it('nasce urgente com prazo quando a abertura os informa — e o board os devolve', async () => {
    const os = await abrirOs(gerente, { priority: 'urgente', dueDate: '2026-08-30' });
    expect(os.priority).toBe('urgente');
    expect(os.due_date).toBe('2026-08-30');

    const board = await request(app).get('/api/v1/core/workshop/orders').set(gerente);
    const item = board.body.items.find((o: { id: string }) => o.id === os.id);
    expect(item.priority).toBe('urgente');
    expect(item.due_date).toBe('2026-08-30');
    expect(board.body.priorities).toEqual(['urgente', 'alta', 'media', 'baixa']);
  });

  it('prioridade inventada e prazo ilegível são 400 na porta', async () => {
    const invalida = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Maria', priority: 'gravissima' });
    expect(invalida.status).toBe(400);
    expect(invalida.body.error?.code).toBe('CORE_INVALID_PRIORITY');

    const prazoTorto = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Maria', dueDate: 'depois do carnaval' });
    expect(prazoTorto.status).toBe(400);
    expect(prazoTorto.body.error?.code).toBe('CORE_INVALID_DUE_DATE');
  });

  it('replanejar muda prioridade e prazo — e fica na linha do tempo com autor', async () => {
    const os = await abrirOs(gerente);
    const res = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/plan`)
      .set(gerente)
      .send({ priority: 'urgente', dueDate: '2026-09-01' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.priority).toBe('urgente');
    expect(res.body.due_date).toBe('2026-09-01');

    const detalhe = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.id}`)
      .set(gerente);
    const corpo = JSON.stringify(detalhe.body.comments);
    expect(corpo).toContain('Replanejou a OS');
    expect(corpo).toContain('Média → Urgente');
  });

  it('mecânico não replaneja OS de outro; o gerente sim', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);

    const negado = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/plan`)
      .set(mecanicoB)
      .send({ priority: 'alta' });
    expect(negado.status).toBe(403);

    const doGerente = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/plan`)
      .set(gerente)
      .send({ priority: 'alta' });
    expect(doGerente.status).toBe(200);
  });

  it('OS finalizada não replaneja', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanicoA)
      .send({ diagnosis: 'Garantia do motor', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);

    const res = await request(app)
      .patch(`/api/v1/core/workshop/orders/${os.id}/plan`)
      .set(gerente)
      .send({ priority: 'baixa' });
    expect(res.status).toBe(409);
  });
});

describe('o relógio do SLA é a coluna, não o toque', () => {
  it('comentar NÃO reinicia o relógio; mudar de coluna sim', async () => {
    /*
      O defeito do antigo que ficou lá: o alerta contava do updatedAt, e
      qualquer comentário "curava" o atraso. Aqui o comentário anda o
      updated_at e NÃO o status_changed_at.
    */
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);
    const antes = osCrua(os.id);
    expect(antes.status_changed_at).toBeTruthy();

    await pausa(15);
    const comentado = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/comments`)
      .set(mecanicoA)
      .send({ body: 'Só um registro no meio do serviço' });
    expect(comentado.status, JSON.stringify(comentado.body)).toBe(201);

    const depoisDoComentario = osCrua(os.id);
    expect(depoisDoComentario.status_changed_at).toBe(antes.status_changed_at);
    expect(depoisDoComentario.updated_at >= antes.updated_at).toBe(true);

    await pausa(15);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(mecanicoA)
      .send({ status: 'aguardando_peca', comment: 'Peça encomendada' })
      .expect(200);
    const depoisDoMove = osCrua(os.id);
    expect(depoisDoMove.status_changed_at! > antes.status_changed_at!).toBe(true);
  });
});

describe('a régua do SLA', () => {
  it('os defaults são os do sistema anterior, verbatim', async () => {
    const res = await request(app).get('/api/v1/core/workshop/sla').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.matrix.em_andamento).toEqual({ urgente: 4, alta: 8, media: 16, baixa: 24 });
    expect(res.body.matrix.manutencao_externa).toEqual({ urgente: 24, alta: 48, media: 72, baixa: 96 });
    expect(res.body.matrix.parada_setor).toEqual({ urgente: 8, alta: 16, media: 24, baixa: 48 });
    expect(res.body.matrix.aguardando_peca).toEqual({ urgente: 48, alta: 72, media: 96, baixa: 120 });
    expect(res.body.custom).toEqual([]);
  });

  it('o gestor personaliza uma célula; devolvê-la ao padrão APAGA a personalização', async () => {
    const salvo = await request(app)
      .put('/api/v1/core/workshop/sla')
      .set(gerente)
      .send({ matrix: { em_andamento: { urgente: 2 } } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    expect(salvo.body.matrix.em_andamento.urgente).toBe(2);
    expect(salvo.body.custom).toHaveLength(1);

    const deVolta = await request(app)
      .put('/api/v1/core/workshop/sla')
      .set(gerente)
      .send({ matrix: { em_andamento: { urgente: 4 } } });
    expect(deVolta.body.matrix.em_andamento.urgente).toBe(4);
    expect(deVolta.body.custom).toEqual([]);
  });

  it('fora da grade é 400: hora 0, hora 721, coluna sem SLA', async () => {
    for (const matrix of [
      { em_andamento: { urgente: 0 } },
      { em_andamento: { urgente: 721 } },
      { em_aberto: { urgente: 4 } },
    ]) {
      const res = await request(app).put('/api/v1/core/workshop/sla').set(gerente).send({ matrix });
      expect(res.status, JSON.stringify(matrix)).toBe(400);
    }
  });

  it('restaurar o padrão apaga tudo', async () => {
    await request(app)
      .put('/api/v1/core/workshop/sla')
      .set(gerente)
      .send({ matrix: { parada_setor: { baixa: 100 } } })
      .expect(200);
    const reset = await request(app)
      .put('/api/v1/core/workshop/sla')
      .set(gerente)
      .send({ reset: true });
    expect(reset.body.custom).toEqual([]);
    expect(reset.body.matrix.parada_setor.baixa).toBe(48);
  });

  it('o mecânico não EDITA a régua — mas o quadro a entrega para ele', async () => {
    const editar = await request(app).get('/api/v1/core/workshop/sla').set(mecanicoA);
    expect(editar.status).toBe(403);

    const board = await request(app).get('/api/v1/core/workshop/orders').set(mecanicoA);
    expect(board.status).toBe(200);
    expect(board.body.sla.em_andamento.urgente).toBe(4);
  });

  it('a régua é POR EMPRESA: a personalização de uma não vaza para a outra', async () => {
    await request(app)
      .put('/api/v1/core/workshop/sla')
      .set(gerente)
      .send({ matrix: { em_andamento: { urgente: 1 } } })
      .expect(200);

    const outraEmpresa = await entrar('gerente-2', ['gerente_oficina'], 'outra-oficina-co');
    const res = await request(app).get('/api/v1/core/workshop/sla').set(outraEmpresa);
    expect(res.body.matrix.em_andamento.urgente).toBe(4);
    expect(res.body.custom).toEqual([]);
  });
});

describe('as regras novas do quadro', () => {
  it('mover sem observação é 400 — o quadro não anda calado', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(mecanicoA)
      .send({ status: 'aguardando_peca' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_COMMENT_REQUIRED');
  });

  it('parada_setor é coluna de verdade, na ordem do quadro antigo', async () => {
    const board = await request(app).get('/api/v1/core/workshop/orders').set(gerente);
    expect(board.body.statuses).toEqual([
      'em_aberto',
      'em_andamento',
      'manutencao_externa',
      'parada_setor',
      'aguardando_peca',
      'aguardando_pagamento',
      'finalizada',
    ]);

    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id, 'parada_setor');
    expect(osCrua(os.id).status).toBe('parada_setor');
  });

  it('a fila do caixa não se entra por arrasto, nem se volta ao quadro por arrasto', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);

    const paraFila = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(mecanicoA)
      .send({ status: 'aguardando_pagamento', comment: 'tentando pular a conferência' });
    expect(paraFila.status).toBe(409);
    expect(paraFila.body.error?.code).toBe('CORE_AWAIT_PAYMENT_VIA_COMPLETE');

    const paraAberto = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(mecanicoA)
      .send({ status: 'em_aberto', comment: 'devolvendo pelo caminho errado' });
    expect(paraAberto.status).toBe(409);
    expect(paraAberto.body.error?.code).toBe('CORE_REOPEN_VIA_RELEASE');
  });

  it('tirar a OS da fila do caixa é do gerente — o técnico não desfaz a conclusão', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/labor`)
      .set(mecanicoA)
      .send({ laborCents: 15000 })
      .expect(200);
    const fim = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/complete`)
      .set(mecanicoA)
      .send({ diagnosis: 'Troca do controlador', hasCost: true, forcarChecklist: true });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
    expect(osCrua(os.id).status).toBe('aguardando_pagamento');

    const doTecnico = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(mecanicoA)
      .send({ status: 'em_andamento', comment: 'o orçamento mudou' });
    expect(doTecnico.status).toBe(403);
    expect(doTecnico.body.error?.code).toBe('CORE_LEAVE_PAYMENT_MANAGER_ONLY');

    const doGerente = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/move`)
      .set(gerente)
      .send({ status: 'em_andamento', comment: 'cliente pediu mais um serviço' });
    expect(doGerente.status, JSON.stringify(doGerente.body)).toBe(200);
  });
});

describe('largar a OS', () => {
  it('o responsável larga com justificativa: volta ao quadro, e o PRÓXIMO técnico assume', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);

    const largou = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/release`)
      .set(mecanicoA)
      .send({ reason: 'Não tenho experiência com este controlador' });
    expect(largou.status, JSON.stringify(largou.body)).toBe(200);

    const crua = osCrua(os.id);
    expect(crua.status).toBe('em_aberto');
    expect(crua.mechanic_id).toBeNull();

    // A justificativa fica na linha do tempo — é o que o próximo lê primeiro.
    const detalhe = await request(app).get(`/api/v1/core/workshop/orders/${os.id}`).set(gerente);
    expect(JSON.stringify(detalhe.body.comments)).toContain('Não tenho experiência');
    expect(JSON.stringify(detalhe.body.events)).toContain('OS devolvida ao quadro');

    // E o quadro segue vivo: outro técnico assume sem esbarrar no 409.
    await assumir(mecanicoB, os.id);
    expect(osCrua(os.id).mechanic_id).toBeTruthy();
  });

  it('largar sem justificativa é 400', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/release`)
      .set(mecanicoA)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_REASON_REQUIRED');
  });

  it('só o responsável (ou o gerente) larga', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id);

    const alheio = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/release`)
      .set(mecanicoB)
      .send({ reason: 'não é minha, mas quero largar' });
    expect(alheio.status).toBe(403);

    const doGerente = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/release`)
      .set(gerente)
      .send({ reason: 'Remanejando a equipe da semana' });
    expect(doGerente.status).toBe(200);
    expect(osCrua(os.id).mechanic_id).toBeNull();
  });

  it('OS na fila do caixa ou sem dono não se larga', async () => {
    const semDono = await abrirOs(gerente);
    const resSemDono = await request(app)
      .post(`/api/v1/core/workshop/orders/${semDono.id}/release`)
      .set(gerente)
      .send({ reason: 'tanto faz' });
    expect(resSemDono.status).toBe(409);

    const naFila = await abrirOs(gerente);
    await assumir(mecanicoA, naFila.id);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${naFila.id}/labor`)
      .set(mecanicoA)
      .send({ laborCents: 5000 })
      .expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${naFila.id}/complete`)
      .set(mecanicoA)
      .send({ diagnosis: 'Freio regulado', hasCost: true, forcarChecklist: true })
      .expect(200);
    const resNaFila = await request(app)
      .post(`/api/v1/core/workshop/orders/${naFila.id}/release`)
      .set(mecanicoA)
      .send({ reason: 'desisti' });
    expect(resNaFila.status).toBe(409);
    expect(resNaFila.body.error?.code).toBe('CORE_ORDER_PAST_BOARD');
  });
});

describe('a coluna nova não fura as regras que enumeram status', () => {
  /*
    O DEFEITO DE FAMÍLIA que a revisão desta rodada achou: quatro lugares
    escreviam "a OS está viva na bancada" por COMPLEMENTO — a lista dos
    quatro status que existiam. Nenhum soube de `parada_setor` quando ela
    nasceu. Agora a pergunta tem UMA fonte (`ORDER_STATUSES_ON_BENCH`), e
    estes casos batem em cada leitor dela.
  */
  // O caso da VENDA da moto parada no setor mora em
  // `equipamento-no-estoque.test.ts`, ao lado do irmão "moto desmontada na
  // bancada não sai do estoque" — é lá que o cenário de plaquinha e unidade
  // já está montado.

  it('o orçamento de uma OS parada no setor pode ser enviado ao cliente', async () => {
    const os = await abrirOs(gerente);
    await assumir(mecanicoA, os.id, 'parada_setor');
    await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/labor`)
      .set(mecanicoA)
      .send({ laborCents: 12000 })
      .expect(200);

    const pedido = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.id}/pedir-aprovacao`)
      .set(mecanicoA)
      .send({});
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(200);
  });
});

describe('o prazo é uma data de calendário, não um palpite', () => {
  it('31 de fevereiro e mês 13 são recusados — o rollover do JavaScript não passa', async () => {
    for (const dueDate of ['2026-02-31', '2026-13-01', '30/08/2026', '2026-8-3']) {
      const res = await request(app)
        .post('/api/v1/core/workshop/orders')
        .set(gerente)
        .send({ customerName: 'Maria', dueDate });
      expect(res.status, dueDate).toBe(400);
      expect(res.body.error?.code).toBe('CORE_INVALID_DUE_DATE');
    }
  });

  it('uma data de verdade passa e volta EXATAMENTE como veio', async () => {
    const os = await abrirOs(gerente, { dueDate: '2026-02-28' });
    expect(os.due_date).toBe('2026-02-28');
  });
});

describe('a bancada é fronteira também na ESCRITA', () => {
  it('mecânico de duas bancadas não replaneja nem larga OS de uma terceira', async () => {
    /*
      `resolveWorkshop(req, false)` devolve `null` para quem atende MAIS DE
      UMA bancada — e null, no serviço, é "sem filtro de oficina". O quadro
      já escondia a OS alheia (a leitura usa o escopo em lista); a escrita
      passava. As duas metades agora usam a mesma régua.
    */
    const db = getConnection();
    const agora = new Date().toISOString();
    for (const [id, slug] of [['ws-a', 'a'], ['ws-b', 'b'], ['ws-c', 'c']] as const) {
      db.prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, 'oficina-co', ?, ?, 'mobility', 1, ?)`,
      ).run(id, `bancada-${slug}`, `Bancada ${slug}`, agora);
    }
    // O id REAL do usuário (o helper gera um UUID; 'mec-duas' é só o rótulo).
    const login = await loginForTest(app, {
      userId: 'mec-duas',
      companyId: 'oficina-co',
      profileCodes: ['mecanico'],
    });
    const mec = { Authorization: `Bearer ${login.body.accessToken}` };
    const meuId = (
      getConnection()
        .prepare('SELECT id FROM core_users WHERE login = ?')
        .get('MEC-DUAS@OFICINA-CO') as { id: string } | undefined
    )?.id
      ?? (getConnection()
        .prepare('SELECT id FROM core_users WHERE display_name = ?')
        .get('mec-duas') as { id: string }).id;
    for (const ws of ['ws-a', 'ws-b']) {
      db.prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'mecanico', ?)`,
      ).run(randomUUID(), ws, meuId, agora);
    }

    // A OS mora na TERCEIRA bancada, que ele não atende.
    const alheia = await request(app)
      .post('/api/v1/core/workshop/orders?workshopId=ws-c')
      .set(gerente)
      .send({ customerName: 'De outra bancada' });
    expect(alheia.status, JSON.stringify(alheia.body)).toBe(201);
    const alheiaId = alheia.body.id as string;

    // O quadro dele não mostra a OS...
    const board = await request(app).get('/api/v1/core/workshop/orders').set(mec);
    expect(board.body.items.some((o: { id: string }) => o.id === alheiaId)).toBe(false);

    // ...e a escrita concorda com a leitura.
    const plan = await request(app)
      .patch(`/api/v1/core/workshop/orders/${alheiaId}/plan`)
      .set(mec)
      .send({ priority: 'urgente' });
    expect(plan.status, JSON.stringify(plan.body)).toBe(404);

    const assume = await request(app)
      .post(`/api/v1/core/workshop/orders/${alheiaId}/assume`)
      .set(mec)
      .send({ status: 'em_andamento', comment: 'tentando pegar OS de outra bancada' });
    expect(assume.status).toBe(404);
  });
});

describe('a migração 66 leva o quadro velho junto', () => {
  it('banco v65: as colunas nascem e o relógio herda o updated_at — nunca nulo', () => {
    /*
      OS antiga entrou na coluna atual em algum momento que ninguém gravou; o
      retrato honesto é o updated_at. Sem o backfill, status_changed_at nulo
      significaria "desde sempre" e o quadro acordaria inteiro estourado.
    */
    const db = getConnection();
    for (let passo = 2; passo <= 65; passo += 1) {
      db.prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, 'applied')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`core_migration_step_${passo}`);
    }
    db.prepare('DELETE FROM core_meta WHERE key = ?').run('core_migration_step_66');
    db.exec('ALTER TABLE core_service_orders DROP COLUMN priority;');
    db.exec('ALTER TABLE core_service_orders DROP COLUMN due_date;');
    db.exec('ALTER TABLE core_service_orders DROP COLUMN status_changed_at;');

    // Uma OS do "banco antigo", com updated_at conhecido.
    db.prepare(
      `INSERT INTO core_companies (id, slug, legal_name, trade_name, kind, active, created_at, updated_at)
       VALUES ('emp-66', 'emp-66', 'Empresa 66', 'Empresa 66', 'workshop', 1, '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO core_service_orders
         (id, company_id, number, status, opened_by_customer, labor_cents, parts_cents, total_cents, created_at, updated_at)
       VALUES ('os-antiga', 'emp-66', 1, 'em_andamento', 0, 0, 0, 0, '2026-02-01T10:00:00Z', '2026-02-02T15:30:00Z')`,
    ).run();

    /*
      O número é ARMADILHA de propósito: cada passo novo derruba este teste e
      obriga quem o escreveu a vir aqui conferir que o backfill do quadro
      continua valendo. Rodada 52 (passo 67, garantia e conferência de
      entrada): o passo é idempotente — `addColumn` não repete coluna que já
      existe — e não toca em `core_service_orders`, então a OS antiga continua
      herdando o relógio do `updated_at`. Este banco chega aqui SEM as marcas
      66 e 67, e os dois passos rodam em sequência.
    */
    /*
      Rodada 53 (passo 68, o pool da plaquinha): conferido que o passo novo
      nao toca em `core_service_orders` — ele cria duas tabelas, a coluna da
      regra de ouro e carrega o pool. A OS antiga deste caso continua
      herdando o relogio do `updated_at`.
    */
    /*
      Rodada 54 (passo 69, a marca de quem assina o papel da bancada):
      conferido que o passo so acrescenta `core_workshops.brand_company_id` e
      regrava as duas bancadas oficiais. Nao toca em equipamento, em OS nem
      em tabela de preco — os casos abaixo seguem valendo.
    */
    /*
      Rodada 73 (passo 73, a conversão de unidade na entrada de nota):
      conferido que o passo só acrescenta três colunas NULLABLE a
      `core_inbound_note_items` — unit_trib, quantity_trib e
      conversion_factor. Não reconstrói tabela, não regrava linha, e não
      toca em equipamento, plaquinha, OS, quadro da oficina, marca de
      bancada nem tabela de preço. Os casos abaixo seguem valendo.

      E o passo NASCEU errado, com o alvo ainda em 72: o passo rodava e
      `haPassoPendente` não o via, então a migração entrava sem o snapshot.
      `schema-drift` ganhou o caso que cobra os dois sentidos.
    */
    /*
      Passo 74 (o rastro do item cancelado no carrinho — GAP-V52/V63):
      conferido que o passo só marca a tabela NOVA `core_sale_removed_items`
      (criada pelo IF NOT EXISTS do ensureCoreSchema) e garante o índice por
      venda. Não toca em `core_service_orders` — a OS antiga deste caso
      continua herdando o relógio do `updated_at`.
    */
    /*
      Passos 75-77 (rodada dos vídeos): anexo na fila de e-mail + índices do
      pacote do contador (75), cópia de arquivamento do evento fiscal (76) e
      espécie/estorno da nota de entrada (77). Nenhum toca em
      `core_service_orders` — a OS antiga continua herdando o relógio do
      `updated_at`.
    */
    /*
      Passo 78 (a liberação diz ONDE foi digitada, e o turno reabre —
      GAP-V61/V64): `terminal_id`/`ip` em `core_authorizations` e as cinco da
      trilha de reabertura em `core_cash_sessions`. Nenhum toca em
      `core_service_orders` — a OS antiga continua herdando o relógio do
      `updated_at`.
    */
    /*
      Passo 79 (o crédito de loja ganha razão — GAP-V10/V47): tabela nova
      (`core_customer_credits`) mais o índice dela. Nenhum toca em
      `core_service_orders` — a OS antiga continua herdando o relógio do
      `updated_at`.
    */
    /*
      Passo 80 (o catálogo ganha serviço, faixa, embalagem, campo próprio, dia
      da semana e IPI — GAP-V01/V08): ALTER em `core_products`,
      `core_promotions` e `core_tax_groups`, mais três tabelas novas. Nenhum
      toca em `core_service_orders` — a OS antiga continua herdando o relógio
      do `updated_at`.
    */
    /*
      Passo 84 (o anexo do e-mail sai da fila e vai para o cofre — GAP-V30,
      conserto): UM ALTER, `core_email_queue.anexo_id`, nullable e sem
      backfill, mais a tabela NOVA `core_email_attachments`, que nasce na DDL
      canônica. Não toca em equipamento, plaquinha, OS nem garantia — os casos
      abaixo seguem valendo, como no passo 83 (`core_sale_items.cost_cents`).
    */
    /*
      Passo 86 (RBAC granular): cinco colunas em `core_user_companies` e o
      escopo de bancada de cada vínculo gravado. Não toca em
      `core_service_orders` nem no relógio do SLA.
    */
    expect(CORE_TARGET_VERSION).toBe(86);
    migrateCoreSchema();

    const os = db
      .prepare('SELECT priority, status_changed_at FROM core_service_orders WHERE id = ?')
      .get('os-antiga') as { priority: string; status_changed_at: string };
    expect(os.priority).toBe('media');
    expect(os.status_changed_at).toBe('2026-02-02T15:30:00Z');
  });
});
