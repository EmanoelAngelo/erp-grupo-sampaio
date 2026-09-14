/**
 * ============================================================================
 * AUDITORIA — FASE 6: A RECONCILIAÇÃO DA GAVETA
 * ============================================================================
 *
 * O cenário conhecido da auditoria: fundo de R$ 200 → suprimento R$ 50 →
 * venda em dinheiro R$ 120 → venda no cartão R$ 80 → sangria R$ 100 →
 * cancelamento de uma venda em dinheiro de R$ 30. O enunciado esperava
 * R$ 240,00 (200+50+120−100−30).
 *
 * A REGRA REAL DA CASA, descoberta no código e afirmada aqui:
 *
 *  - O esperado da gaveta é a SOMA DOS MOVIMENTOS (`expectedCents`), nunca um
 *    número informado. Cada venda em espécie entra como movimento `sale`; o
 *    cancelamento entra como `sale_cancel` NEGATIVO.
 *  - Logo, uma venda de R$ 30 vendida E cancelada NO MESMO turno soma +30 e
 *    −30: o esperado é R$ 270,00, não R$ 240,00. A aritmética do enunciado
 *    (o −30 sem o +30) só existe quando a venda cancelada veio de um turno
 *    ANTERIOR, já fechado — aí o débito cai na gaveta de HOJE (regra de
 *    `cancelSale`, coberta em cancelamento-gaveta-fechada.test.ts no nível do
 *    serviço; aqui ela atravessa a ROTA). Os dois cenários estão provados.
 *  - CARTÃO NÃO ENTRA NA GAVETA: `PaymentMethods` declara `cash: false` para
 *    debito/credito/pix, e `createSale` só lança movimento de gaveta para
 *    meio com `cash: true` (`isCashMethod`). O cartão aparece na conferência
 *    do turno (`byMethod` do summary) — mas não no esperado físico.
 *
 * O QUE JÁ ESTÁ COBERTO (não duplicado aqui):
 *  - troco na conferência (entregue − troco = gaveta): resumo-do-turno-bate.test.ts;
 *  - cancelamento com gaveta fechada e sem caixa aberto → recusa; débito de
 *    turno fechado vai para a gaveta de hoje (serviço): cancelamento-gaveta-fechada.test.ts;
 *  - venda apontando para caixa FECHADO ou de OUTRA empresa → recusa:
 *    auditoria-p0-isolamento.test.ts;
 *  - movimento/fechamento/summary de sessão de outra empresa: audit-tenant.test.ts;
 *  - teto de sangria e liberação de gestor; saldo insuficiente no nível do
 *    serviço: sangria-com-teto.test.ts;
 *  - GET /core/cash/sessions com nomes e diferença: rodada-32-rotas-religadas.test.ts
 *    (aqui o histórico é conferido de novo, mas como fecho do FLUXO inteiro).
 *
 * ONDE A GAVETA QUEBRAVA (defeitos reais da auditoria, consertados no FUNIL do
 * serviço — `exigirCentavosInteiros` em CashService, por onde todo chamador
 * passa; a rota continua fazendo `Number(body)` cru e pode continuar):
 *  - `closeSession` não validava `countedCents`: NaN entrava em bind como NULL
 *    (node:sqlite) nas colunas NULLABLE `counted_cents`/`difference_cents` —
 *    countedCents "2z5" FECHAVA a gaveta sem conferência nenhuma (counted
 *    NULL, difference NULL), e contagem NEGATIVA era aceita e registrada.
 *    Hoje os dois levam 400 CORE_INVALID_AMOUNT e a gaveta segue aberta.
 *  - `addMovement`/`openSession` com valor não numérico: NaN passava pelos
 *    guardas de sinal (`NaN <= 0` e `NaN < 0` são false) e estourava na coluna
 *    NOT NULL → 500 cru API_UNAVAILABLE. Hoje: 400 nomeado, nada gravado.
 *  - valor FRACIONÁRIO (50,5 centavos) entrava na gaveta: a coluna INTEGER de
 *    afinidade aceita REAL, o esperado virava fracionário e nenhuma contagem
 *    inteira fechava em zero nunca mais. Hoje a régua é `Number.isInteger`:
 *    centavos inteiros ou 400 — a regra da casa, em execução.
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
const SENHA = 'Gaveta@Fase6.2026';

let empresa: string;
let auth: { Authorization: string };

/** Produto com estoque, direto no serviço — o que se audita aqui é o caixa. */
function produto(nome: string, precoCents: number, estoque = 10): string {
  const id = createProduct(empresa, { name: nome, priceCents: precoCents }).id;
  applyMovement({
    companyId: empresa,
    productId: id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'ajuste',
    referenceId: `estoque-${nome}`,
  });
  return id;
}

async function abrirCaixa(openingCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/cash/open')
    .set(auth)
    .send({ openingCents });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function vender(opts: {
  sessionId: string | null;
  productId: string;
  quantity: number;
  method: string;
  amountCents: number;
  chave: string;
}) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', opts.chave)
    .send({
      cashSessionId: opts.sessionId,
      items: [{ productId: opts.productId, quantity: opts.quantity }],
      payments: [{ method: opts.method, amountCents: opts.amountCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; total_cents: number };
}

async function resumo(sessionId: string) {
  const res = await request(app).get(`/api/v1/core/cash/${sessionId}/summary`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    session: { status: string };
    expectedCents: number;
    byMethod: { method: string; total: number }[];
    changeCents: number;
    movements: {
      movement_type: string;
      amount_cents: number;
      reference_id: string | null;
      note: string | null;
    }[];
  };
}

function movimento(sessionId: string, tipo: string, amountCents: number, note?: string) {
  const corpo: Record<string, unknown> = { movementType: tipo, amountCents };
  if (note) corpo.note = note;
  return request(app).post(`/api/v1/core/cash/${sessionId}/movements`).set(auth).send(corpo);
}

/** Soma dos movimentos por tipo — imune a empate de created_at na ordenação. */
function somaPorTipo(movs: { movement_type: string; amount_cents: number }[]) {
  const mapa: Record<string, number> = {};
  for (const m of movs) {
    mapa[m.movement_type] = (mapa[m.movement_type] ?? 0) + m.amount_cents;
  }
  return mapa;
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  const gerente = await upsertUser({
    login: 'GERENTE.GAVETA',
    displayName: 'Gerente da Gaveta',
    password: SENHA,
  });
  linkUserToCompany(gerente, empresa, 'gerente_loja', true);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTE.GAVETA', password: SENHA, companyId: empresa });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

// ============================================================================

describe('o cenário conhecido, do fundo de troco ao relatório do turno', () => {
  it('no MESMO turno a venda cancelada soma e subtrai: esperado R$ 270,00, fechamento em zero, histórico com a diferença', async () => {
    /*
      200 de fundo + 50 de suprimento + 120 em dinheiro + 30 em dinheiro
      (depois cancelada) − 100 de sangria − 30 do estorno = R$ 270,00.
      O enunciado da auditoria dizia 240 — mas 240 esquece que a venda de 30
      ENTROU na mesma gaveta antes de sair. O caso seguinte prova onde o 240
      é verdadeiro: quando a venda veio de turno já fechado.
    */
    const bermuda = produto('Bermuda', 12_000);
    const cinto = produto('Cinto', 8_000);
    const meia = produto('Meia', 3_000);

    const sessao = await abrirCaixa(20_000);

    // O caixa aberto é encontrável pelo PDV, e o fundo já é movimento.
    const aberto = await request(app).get('/api/v1/core/cash/open').set(auth);
    expect(aberto.status).toBe(200);
    expect(aberto.body.session?.id).toBe(sessao);
    expect((await resumo(sessao)).expectedCents).toBe(20_000);

    // Suprimento de R$ 50 — o serviço devolve o saldo novo, exato.
    const suprimento = await movimento(sessao, 'supply', 5_000, 'Troco da tarde');
    expect(suprimento.status, JSON.stringify(suprimento.body)).toBe(201);
    expect(suprimento.body.balance).toBe(25_000);

    // Venda de R$ 120 em dinheiro entra inteira na gaveta.
    await vender({
      sessionId: sessao,
      productId: bermuda,
      quantity: 1,
      method: 'dinheiro',
      amountCents: 12_000,
      chave: 'fase6-venda-dinheiro',
    });
    expect((await resumo(sessao)).expectedCents).toBe(37_000);

    // Venda de R$ 80 no CRÉDITO: aparece na conferência do turno (byMethod),
    // mas NÃO move um centavo da gaveta física — `cash: false` no catálogo.
    const vendaCartao = await vender({
      sessionId: sessao,
      productId: cinto,
      quantity: 1,
      method: 'credito',
      amountCents: 8_000,
      chave: 'fase6-venda-cartao',
    });
    const aposCartao = await resumo(sessao);
    expect(aposCartao.expectedCents).toBe(37_000);
    expect(aposCartao.byMethod.find((m) => m.method === 'credito')?.total).toBe(8_000);
    // E nenhum movimento de gaveta cita a venda do cartão.
    expect(
      aposCartao.movements.filter((m) => m.reference_id === vendaCartao.id),
    ).toHaveLength(0);

    // A venda de R$ 30 em dinheiro que vai ser cancelada — no mesmo caixa.
    const vendaCancelavel = await vender({
      sessionId: sessao,
      productId: meia,
      quantity: 1,
      method: 'dinheiro',
      amountCents: 3_000,
      chave: 'fase6-venda-cancelavel',
    });
    expect((await resumo(sessao)).expectedCents).toBe(40_000);

    // Sangria de R$ 100.
    const sangria = await movimento(sessao, 'withdrawal', 10_000, 'Depósito no cofre');
    expect(sangria.status, JSON.stringify(sangria.body)).toBe(201);
    expect(sangria.body.balance).toBe(30_000);

    // Cancelamento da venda de R$ 30 — o estorno debita a MESMA gaveta.
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${vendaCancelavel.id}/cancel`)
      .set(auth)
      .send({ reason: 'cliente desistiu' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    // O RESUMO: matemática exata, movimento a movimento.
    const final = await resumo(sessao);
    expect(final.expectedCents).toBe(27_000); // 200+50+120+30−100−30 = R$ 270,00
    expect(final.movements).toHaveLength(6);
    expect(somaPorTipo(final.movements)).toEqual({
      opening: 20_000,
      supply: 5_000,
      sale: 15_000, // 120 + 30 — as duas vendas em espécie
      withdrawal: -10_000,
      sale_cancel: -3_000,
    });
    // A conferência por meio EXCLUI a venda cancelada: dinheiro do turno = 120.
    expect(final.byMethod.find((m) => m.method === 'dinheiro')?.total).toBe(12_000);
    expect(final.byMethod.find((m) => m.method === 'credito')?.total).toBe(8_000);
    expect(final.changeCents).toBe(0);

    // FECHAMENTO com o contado IGUAL ao esperado → diferença zero, gravada.
    const fechamento = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: 27_000 });
    expect(fechamento.status, JSON.stringify(fechamento.body)).toBe(200);
    expect(fechamento.body.status).toBe('closed');
    expect(fechamento.body.expected_cents).toBe(27_000);
    expect(fechamento.body.counted_cents).toBe(27_000);
    expect(fechamento.body.difference_cents).toBe(0);

    // O RELATÓRIO do turno sobrevive ao fechamento: summary continua legível…
    const historico = await resumo(sessao);
    expect(historico.session.status).toBe('closed');
    expect(historico.expectedCents).toBe(27_000);

    // …e o histórico de turnos responde com gente pelo nome e diferença exata.
    const turnos = await request(app).get('/api/v1/core/cash/sessions').set(auth);
    expect(turnos.status, JSON.stringify(turnos.body)).toBe(200);
    const doTurno = (turnos.body.items as Record<string, unknown>[]).find(
      (s) => s.id === sessao,
    );
    expect(doTurno).toBeDefined();
    expect(doTurno).toMatchObject({
      opening_cents: 20_000,
      expected_cents: 27_000,
      counted_cents: 27_000,
      difference_cents: 0,
      status: 'closed',
      opened_by_name: 'Gerente da Gaveta',
      closed_by_name: 'Gerente da Gaveta',
    });
  });

  it('a aritmética do enunciado (R$ 240,00) só existe entre turnos: venda de turno FECHADO cancelada hoje debita a gaveta de hoje — e a falta de R$ 40 fica registrada', async () => {
    const bermuda = produto('Bermuda B', 12_000);
    const cinto = produto('Cinto B', 8_000);
    const meia = produto('Meia B', 3_000);

    // TURNO 1: vende R$ 30 em dinheiro e fecha batido.
    const turno1 = await abrirCaixa(0);
    const vendaAntiga = await vender({
      sessionId: turno1,
      productId: meia,
      quantity: 1,
      method: 'dinheiro',
      amountCents: 3_000,
      chave: 'fase6-venda-turno1',
    });
    const fecha1 = await request(app)
      .post(`/api/v1/core/cash/${turno1}/close`)
      .set(auth)
      .send({ countedCents: 3_000 });
    expect(fecha1.status, JSON.stringify(fecha1.body)).toBe(200);
    expect(fecha1.body.difference_cents).toBe(0);

    // TURNO 2: o cenário do enunciado, com o −30 vindo do turno anterior.
    const turno2 = await abrirCaixa(20_000);
    expect((await movimento(turno2, 'supply', 5_000)).body.balance).toBe(25_000);
    await vender({
      sessionId: turno2,
      productId: bermuda,
      quantity: 1,
      method: 'dinheiro',
      amountCents: 12_000,
      chave: 'fase6-venda-turno2',
    });
    await vender({
      sessionId: turno2,
      productId: cinto,
      quantity: 1,
      method: 'credito',
      amountCents: 8_000,
      chave: 'fase6-cartao-turno2',
    });
    // Com motivo: a sangria sem motivo passou a ser recusada (H-caixa-seguranca-08).
    const sangria = await movimento(turno2, 'withdrawal', 10_000, 'Depósito no banco');
    expect(sangria.body.balance).toBe(27_000);

    // O cancelamento da venda de ontem: a nota sai da gaveta de HOJE.
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${vendaAntiga.id}/cancel`)
      .set(auth)
      .send({ reason: 'troca desfeita' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    const conferencia = await resumo(turno2);
    expect(conferencia.expectedCents).toBe(24_000); // 200+50+120−100−30 = R$ 240,00
    const estorno = conferencia.movements.find((m) => m.movement_type === 'sale_cancel');
    expect(estorno?.amount_cents).toBe(-3_000);
    expect(estorno?.note).toMatch(/turno já fechado/);
    // E o turno de ontem ficou INTACTO: fechado com os mesmos números.
    const ontem = getConnection()
      .prepare('SELECT expected_cents, difference_cents FROM core_cash_sessions WHERE id = ?')
      .get(turno1) as { expected_cents: number; difference_cents: number };
    expect(ontem).toEqual({ expected_cents: 3_000, difference_cents: 0 });

    // FECHAMENTO DIVERGENTE: contou R$ 200,00 → falta de R$ 40,00, exata.
    const fecha2 = await request(app)
      .post(`/api/v1/core/cash/${turno2}/close`)
      .set(auth)
      .send({ countedCents: 20_000 });
    expect(fecha2.status, JSON.stringify(fecha2.body)).toBe(200);
    expect(fecha2.body.expected_cents).toBe(24_000);
    expect(fecha2.body.counted_cents).toBe(20_000);
    expect(fecha2.body.difference_cents).toBe(-4_000);

    // "De quem era o caixa que fechou faltando 40?" — o histórico responde.
    const turnos = await request(app).get('/api/v1/core/cash/sessions').set(auth);
    const itens = turnos.body.items as Record<string, unknown>[];
    expect(itens).toHaveLength(2);
    const t2 = itens.find((s) => s.id === turno2);
    expect(t2).toMatchObject({
      difference_cents: -4_000,
      closed_by_name: 'Gerente da Gaveta',
    });
    const t1 = itens.find((s) => s.id === turno1);
    expect(t1).toMatchObject({ difference_cents: 0 });
  });
});

// ============================================================================

describe('caixa fechado é imutável — e a reabertura é uma porta com nome', () => {
  /*
    ESTE CASO MUDOU DE AFIRMAÇÃO, e a mudança é a rodada da reabertura
    (GAP-V64) inteira em um parágrafo.

    Ele dizia "reabertura não é regra da casa: a rota nem existe" e conferia um
    404. Era verdade, e era uma verdade incômoda: `reabrir_caixa` esteve
    declarada em `RESTRICTED_ACTIONS` sem rota, função nem botão — a lista
    prometia uma tranca sobre um recurso inexistente, e o motivo da ausência
    nunca foi permissão, era desenho (o que fazer com a conferência já gravada).

    O que este caso protege continua sendo o mesmo, e é o que importa: FECHADO,
    o turno é imutável. Movimento tardio e segundo fechamento continuam levando
    409 com nome, e nada é regravado. O que deixou de ser verdade é que não
    existisse saída nenhuma — ela existe, tem nome, exige gestor (ou a liberação
    dele), vale só no mesmo dia e ARQUIVA a conferência desfeita em vez de
    apagá-la. As regras dela são medidas em `liberacao-pontual.test.ts`.
  */
  it('movimento e segundo fechamento levam 409 — e desfazer o fechamento tem UMA porta só', async () => {
    const sessao = await abrirCaixa(1_000);
    const fecha = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: 1_000 });
    expect(fecha.status).toBe(200);

    // Movimento em caixa fechado: recusado com nome, nada gravado.
    const tardio = await movimento(sessao, 'supply', 500);
    expect(tardio.status, JSON.stringify(tardio.body)).toBe(409);
    expect(tardio.body.error?.code).toBe('CORE_CASH_CLOSED');
    const movimentos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ? AND movement_type = 'supply'")
      .get(sessao) as { n: number };
    expect(movimentos.n).toBe(0);

    // Fechar de novo (com outro contado!) também não reescreve a conferência.
    const refecha = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: 999_999 });
    expect(refecha.status).toBe(409);
    expect(refecha.body.error?.code).toBe('CORE_CASH_CLOSED');

    /*
      A reabertura EXISTE, e é a única porta. O gerente desta suíte tem alçada,
      então ela abre direto — e o que se confere aqui é que ela não é um atalho
      para reescrever a conferência: o fechamento desfeito fica ARQUIVADO na
      trilha, com o contado e a diferença que valiam.
    */
    const reopen = await request(app)
      .post(`/api/v1/core/cash/${sessao}/reopen`)
      .set(auth)
      .send({ reason: 'faltou lançar um suprimento' });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
    expect(reopen.body.status).toBe('open');
    expect(reopen.body.counted_cents).toBeNull();
    const trilha = JSON.parse(String(reopen.body.closing_trail)) as Record<string, unknown>[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].counted_cents).toBe(1_000);

    // Reaberto, o movimento que antes levava 409 passa a ser aceito — que é o
    // ponto inteiro de reabrir.
    const agora = await movimento(sessao, 'supply', 500);
    expect(agora.status, JSON.stringify(agora.body)).toBe(201);

    // E o turno seguinte continua sendo o caminho normal: fecha este e abre o
    // próximo, sem reabrir nada.
    await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: 1_500 });
    const proximo = await abrirCaixa(1_000);
    expect(proximo).not.toBe(sessao);

    // E summary de sessão que não existe é 404 nomeado, não vazamento.
    const fantasma = await request(app)
      .get('/api/v1/core/cash/nao-existe/summary')
      .set(auth);
    expect(fantasma.status).toBe(404);
    expect(fantasma.body.error?.code).toBe('CORE_CASH_NOT_FOUND');
  });
});

// ============================================================================

describe('uma gaveta aberta por vez na empresa', () => {
  it('a segunda abertura simultânea leva 409 — e terminal que não é desta operação é recusado', async () => {
    await abrirCaixa(5_000);

    // Mesmo "terminal" (nenhum): a segunda gaveta não abre.
    const segunda = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth)
      .send({ openingCents: 1_000 });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body.error?.code).toBe('CORE_CASH_ALREADY_OPEN');

    /*
      Uma sessão POR CAIXA: o cadastro de caixas existe desde a remediação
      PAG/P2 (GAP-PRD-039), e a gaveta por caixa está provada em
      `terminais-e-gaveta-por-caixa.test.ts`. Aqui fica a outra metade: um
      terminalId que esta operação não cadastrou é recusado com nome, antes do
      INSERT — sem gaveta pela metade.
    */
    const comTerminal = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth)
      .send({ openingCents: 1_000, terminalId: 'caixa-2' });
    expect(comTerminal.status, JSON.stringify(comTerminal.body)).toBe(400);
    expect(comTerminal.body.error?.code).toBe('CORE_TERMINAL_NOT_REGISTERED');

    // Só uma sessão aberta sobrou no banco.
    const abertas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_cash_sessions WHERE company_id = ? AND status = 'open'")
      .get(empresa) as { n: number };
    expect(abertas.n).toBe(1);
  });
});

// ============================================================================

describe('sangria maior que o saldo da gaveta', () => {
  // A regra no nível do serviço já está coberta em sangria-com-teto.test.ts
  // ("saldo insuficiente continua sendo a recusa que já existia"). Aqui ela é
  // provada PELA ROTA, com o código nomeado e o saldo intacto depois do não.
  it('pela rota: 409 CORE_CASH_INSUFFICIENT, saldo intacto — e a sangria que ZERA a gaveta passa', async () => {
    const sessao = await abrirCaixa(5_000);

    // Com motivo: sem ele a recusa seria outra (H-caixa-seguranca-08), e o
    // assunto aqui é o saldo.
    const demais = await movimento(sessao, 'withdrawal', 5_001, 'Depósito no banco');
    expect(demais.status, JSON.stringify(demais.body)).toBe(409);
    expect(demais.body.error?.code).toBe('CORE_CASH_INSUFFICIENT');
    expect((await resumo(sessao)).expectedCents).toBe(5_000);

    // O limite é o que se pode: sangrar exatamente o saldo deixa a gaveta em 0.
    const zera = await movimento(sessao, 'withdrawal', 5_000, 'Depósito no banco');
    expect(zera.status, JSON.stringify(zera.body)).toBe(201);
    expect(zera.body.balance).toBe(0);
  });
});

// ============================================================================

describe('a gaveta só aceita número que existe — validação de entrada', () => {
  /*
    ESTES CASOS FORAM ACHADOS VERMELHOS pela auditoria (ver o cabeçalho): as
    rotas fazem `Number(req.body...)` cru e os serviços não conferiam
    `Number.isInteger`. NaN passava pelos guardas de sinal (`NaN <= 0` é false)
    e o desfecho dependia da coluna: NOT NULL estourava em 500 cru; NULLABLE
    (o fechamento) gravava NULL e seguia como se nada fosse. A régua agora mora
    no funil do serviço — `exigirCentavosInteiros`, CashService — e estes
    testes são o que a mantém lá.
  */
  it('fechamento com contagem que não é número NÃO fecha a gaveta às cegas', async () => {
    const sessao = await abrirCaixa(10_000);

    const fecha = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: '2z5' });
    // Uma contagem ilegível tem de ser recusada — nunca virar um turno
    // "conferido" sem contado e sem diferença.
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(400);

    const linha = getConnection()
      .prepare('SELECT status, counted_cents, difference_cents FROM core_cash_sessions WHERE id = ?')
      .get(sessao) as { status: string; counted_cents: number | null; difference_cents: number | null };
    expect(linha.status).toBe('open');
  });

  it('contagem NEGATIVA é recusada — não existe gaveta com −R$ 1,00 dentro', async () => {
    const sessao = await abrirCaixa(10_000);
    const fecha = await request(app)
      .post(`/api/v1/core/cash/${sessao}/close`)
      .set(auth)
      .send({ countedCents: -100 });
    expect(fecha.status, JSON.stringify(fecha.body)).toBe(400);
    const linha = getConnection()
      .prepare('SELECT status FROM core_cash_sessions WHERE id = ?')
      .get(sessao) as { status: string };
    expect(linha.status).toBe('open');
  });

  it('movimento com valor que não é número é recusado com 400 nomeado, não com 500 cru', async () => {
    const sessao = await abrirCaixa(10_000);
    const res = await movimento(sessao, 'supply', 'abc' as unknown as number);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // Aconteça o que acontecer com o status, a gaveta não pode ter mudado.
    expect((await resumo(sessao)).expectedCents).toBe(10_000);
  });

  it('meio centavo não entra na gaveta: movimento fracionário é recusado', async () => {
    const sessao = await abrirCaixa(10_000);
    const res = await movimento(sessao, 'supply', 50.5);
    // 50,5 centavos gravados tornam QUALQUER contagem inteira incapaz de
    // fechar em zero — a matemática da casa é em centavos inteiros.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((await resumo(sessao)).expectedCents).toBe(10_000);
  });

  it('abertura com fundo que não é número é recusada com 400 nomeado, não com 500 cru', async () => {
    const res = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth)
      .send({ openingCents: 'duzentos' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // E nada ficou aberto pela metade.
    const aberto = await request(app).get('/api/v1/core/cash/open').set(auth);
    expect(aberto.body.session).toBeNull();
  });
});
