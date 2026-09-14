/**
 * ============================================================================
 * O CUPOM E A GAVETA PELO AGENTE LOCAL (GAP-PRD-082)
 * ============================================================================
 *
 * A auditoria mediu: `/print/jobs/:id/escpos` existia sem nenhum cliente no
 * repositório, `prontidaoDaGaveta.byCommand` virava `true` só por existir uma
 * impressora cadastrada como "agente", e o cupom saía sempre pela caixa de
 * diálogo do navegador. O agente que consumiria o ESC/POS era código a
 * escrever.
 *
 * Aqui o servidor é o app de verdade, em memória; o agente é o programa de
 * verdade (`ClienteDoServidor`, assinatura HMAC), ligado ao app sem rede. Os
 * casos cobram:
 *
 *   - o cupom da venda vai para o agente DO CAIXA, com o pulso da gaveta antes
 *     do corte, e só vira `printed` quando o agente confirma;
 *   - sem endereço, sem agente pareado ou com o agente fora do ar, o cupom sai
 *     pelo navegador e o job diz por quê;
 *   - o agente de um caixa não pega o cupom de outro caixa nem de outra
 *     empresa, e não confirma job alheio;
 *   - a gaveta sem venda: motivo, trilha, só com agente no ar, e o pulso velho
 *     NUNCA abre depois;
 *   - teste e gaveta não nascem por POST /print/jobs nem têm segunda via;
 *   - a página de teste é o que faz a prontidão dizer AGENT_READY;
 *   - o retirado e não confirmado vira falha com a frase da impressora;
 *   - endereço e caixa conferidos no cadastro, e a empresa é a da sessão.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests, updateRows } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { ClienteDoServidor, parearComOServidor, type Buscador } from '../src/local-agent/ClienteDoServidor.js';

process.env.DEVORA_JWT_SECRET = 'impressao-agente-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'impressao-agente-teste-chave-de-cifra-bem-comprida';

const app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'ImpressaoAgente@2026';

const buscar: Buscador = async (url, init) => {
  const u = new URL(url);
  const caminho = `${u.pathname}${u.search}`;
  const base = init.method === 'GET' ? request(app).get(caminho) : request(app).post(caminho);
  const pedido = base.set(init.headers);
  const res = init.body === undefined ? await pedido : await pedido.send(init.body);
  return { status: res.status, json: async () => res.body as unknown };
};

type Auth = { Authorization: string };
let loja: string;
let gerente: Auth;
let caixa: Auth;

async function login(l: string, companyId: string, perfil: string): Promise<Auth> {
  const userId = await upsertUser({ login: l, displayName: l, password: SENHA });
  linkUserToCompany(userId, companyId, perfil, true);
  const r = await request(app).post('/api/v1/auth/login').send({ login: l, password: SENHA, companyId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

async function criarCaixa(auth: Auth, nome: string): Promise<string> {
  const r = await request(app).post('/api/v1/core/terminals').set(auth).send({ name: nome });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** O gerente gera o código para o caixa; o PROGRAMA pareia e manda o primeiro sinal. */
async function instalarAgente(auth: Auth, caixaId: string | null): Promise<{ cliente: ClienteDoServidor; agentId: string }> {
  const codigo = await request(app)
    .post('/api/v1/payment-terminals/local-agent/pairing')
    .set(auth)
    .send(caixaId ? { pdvTerminalId: caixaId } : {});
  expect(codigo.status, JSON.stringify(codigo.body)).toBeLessThan(300);
  const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.1.0', hostname: 'CAIXA' }, buscar);
  const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
  await cliente.sinal({ version: '1.1.0', hostname: 'CAIXA', health: {} });
  return { cliente, agentId: par.agentId };
}

async function impressoraDeAgente(auth: Auth, caixaId: string | null, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/print/printers')
    .set(auth)
    .send({
      name: 'Térmica do balcão',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 80,
      isDefault: true,
      pdvTerminalId: caixaId,
      agentDevice: 'tcp:192.168.0.50:9100',
      ...extra,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function vendaEmDinheiro(auth: Auth, caixaId: string | null): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Camiseta ${randomUUID().slice(0, 4)}`, priceCents: 7000 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  const gaveta = await request(app)
    .post('/api/v1/core/cash/open')
    .set(auth)
    .send({ openingCents: 0, terminalId: caixaId ?? undefined });
  expect(gaveta.status, JSON.stringify(gaveta.body)).toBe(201);
  const v = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId: p.body.id, quantity: 1, unitPriceCents: 7000 }],
      payments: [{ method: 'dinheiro', amountCents: 7000 }],
      cashSessionId: gaveta.body.id,
      terminalId: caixaId ?? undefined,
    });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return v.body.id as string;
}

function imprimir(auth: Auth, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/print/jobs').set(auth).send(corpo);
}

const lerJob = async (id: string) => (await request(app).get(`/api/v1/core/print/jobs/${id}`).set(caixa)).body;

function textoDos(base64: string): string {
  return Buffer.from(base64, 'base64').toString('latin1');
}

function envelhecer(sql: string, ...params: string[]) {
  getConnection().prepare(sql).run(...params);
}

beforeEach(async () => {
  process.env.DEVORA_API_ENV = 'test';
  resetEnvCacheForTests();
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo-imp', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  gerente = await login('GERENTE.IMP', loja, 'gerente_loja');
  caixa = await login('CAIXA.IMP', loja, 'operador_caixa_loja');
});

describe('o cupom da venda pelo agente do caixa', () => {
  it('sai com o pulso da gaveta antes do corte, e só vira impresso quando o agente confirma', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const { cliente } = await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const vendaId = await vendaEmDinheiro(caixa, caixa1);

    const pedido = await imprimir(caixa, {
      documentType: 'SALE_RECEIPT',
      documentId: vendaId,
      terminalId: caixa1,
      openDrawer: true,
    });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body).toMatchObject({ transport: 'agent', status: 'ready', open_drawer: 1, fallback_reason: null });

    const entregues = await cliente.impressoes(0);
    expect(entregues).toHaveLength(1);
    expect(entregues[0]).toMatchObject({
      jobId: pedido.body.id,
      openDrawer: true,
      printer: { device: 'tcp:192.168.0.50:9100', columns: 48 },
    });
    const bytes = textoDos(entregues[0].escposBase64);
    expect(bytes).toContain('Venda #');
    expect(bytes).toContain('70,00');
    const pulso = bytes.indexOf('\x1b\x70\x00');
    const corte = bytes.indexOf('\x1d\x56\x42');
    expect(pulso).toBeGreaterThan(0);
    expect(pulso).toBeLessThan(corte);

    // Retirado não é impresso: a impressora pode estar sem papel.
    expect((await lerJob(pedido.body.id)).status).toBe('printing');
    expect(await cliente.resultadoDaImpressao(pedido.body.id, { status: 'printed' })).toMatchObject({ duplicate: false });
    const impresso = await lerJob(pedido.body.id);
    expect(impresso.status).toBe('printed');
    expect(impresso.printed_at).toBeTruthy();
    expect(impresso.payload).toBeUndefined();

    // A volta repetida (rede) é a mesma resposta; nada é entregue de novo.
    expect(await cliente.resultadoDaImpressao(pedido.body.id, { status: 'printed' })).toMatchObject({ duplicate: true });
    expect(await cliente.impressoes(0)).toHaveLength(0);
  });

  it('a segunda via não abre a gaveta', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const { cliente } = await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const vendaId = await vendaEmDinheiro(caixa, caixa1);
    const primeira = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1, openDrawer: true });
    await cliente.impressoes(0);
    await cliente.resultadoDaImpressao(primeira.body.id, { status: 'printed' });

    const segunda = await request(app).post(`/api/v1/core/print/jobs/${primeira.body.id}/reprint`).set(caixa).send({});
    expect(segunda.status).toBe(201);
    expect(segunda.body.open_drawer).toBe(0);
    const [via] = await cliente.impressoes(0);
    expect(textoDos(via.escposBase64).includes('\x1b\x70')).toBe(false);
  });
});

describe('quando o agente não pode imprimir, o cupom sai pelo navegador e diz por quê', () => {
  it('sem agente pareado, sem endereço, ou com o agente fora do ar', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const impressora = await impressoraDeAgente(gerente, caixa1);
    const vendaId = await vendaEmDinheiro(caixa, caixa1);

    const semAgente = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1, openDrawer: true });
    expect(semAgente.body).toMatchObject({ transport: 'browser', open_drawer: 0 });
    expect(semAgente.body.fallback_reason).toMatch(/Nenhum agente local pareado do caixa "Caixa 1"/);

    const { agentId } = await instalarAgente(gerente, caixa1);
    updateRows('payment_terminal_local_agents', (r) => r.id === agentId, (r) => ({
      ...r,
      lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    const foraDoAr = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1 });
    expect(foraDoAr.body.transport).toBe('browser');
    expect(foraDoAr.body.fallback_reason).toMatch(/está fora do ar/);

    const semEndereco = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ id: impressora, name: 'Térmica do balcão', kind: 'cupom', transport: 'agent', agentDevice: '' });
    expect(semEndereco.status).toBe(201);
    const semOnde = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1 });
    expect(semOnde.body.fallback_reason).toMatch(/não tem o endereço no computador do caixa/);
  });
});

describe('cada agente com o seu caixa, e cada operação com os seus', () => {
  it('o agente do Caixa 2 não pega o cupom do Caixa 1, nem a outra empresa, e ninguém confirma job alheio', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const caixa2 = await criarCaixa(gerente, 'Caixa 2');
    const agente1 = await instalarAgente(gerente, caixa1);
    const agente2 = await instalarAgente(gerente, caixa2);
    await impressoraDeAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa2, { name: 'Térmica do Caixa 2', agentDevice: 'COM3' });

    const vizinha = upsertCompany({ slug: 'me-mimei-imp', legalName: 'Me Mimei Ltda', tradeName: 'Me Mimei' });
    const gerenteVizinha = await login('GERENTE.VIZ', vizinha, 'gerente_loja');
    const agenteVizinho = await instalarAgente(gerenteVizinha, null);

    const vendaId = await vendaEmDinheiro(caixa, caixa1);
    const job = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1 });
    expect(job.body.transport).toBe('agent');

    expect(await agente2.cliente.impressoes(0)).toHaveLength(0);
    expect(await agenteVizinho.cliente.impressoes(0)).toHaveLength(0);
    const [doCaixa1] = await agente1.cliente.impressoes(0);
    expect(doCaixa1.jobId).toBe(job.body.id);

    await expect(agente2.cliente.resultadoDaImpressao(job.body.id, { status: 'printed' })).rejects.toMatchObject({
      status: 404,
    });
    expect((await lerJob(job.body.id)).status).toBe('printing');
  });

  it('pedido sem assinatura não retira cupom', async () => {
    const r = await request(app).get('/api/v1/payment-terminals/agent/print-jobs');
    expect(r.status).toBe(401);
  });
});

describe('a gaveta sem venda', () => {
  it('motivo obrigatório, só com o agente no ar, o pulso exato, e a abertura na trilha', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const caixa2 = await criarCaixa(gerente, 'Caixa 2');
    const { cliente, agentId } = await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);

    const semMotivo = await request(app).post('/api/v1/core/print/drawer/open').set(caixa).send({ terminalId: caixa1 });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_DRAWER_REASON_REQUIRED');

    const outroCaixa = await request(app)
      .post('/api/v1/core/print/drawer/open')
      .set(caixa)
      .send({ terminalId: caixa2, reason: 'troco' });
    expect(outroCaixa.status).toBe(409);
    expect(outroCaixa.body.error.code).toBe('CORE_DRAWER_NOT_BY_COMMAND');

    const pedido = await request(app)
      .post('/api/v1/core/print/drawer/open')
      .set(caixa)
      .send({ terminalId: caixa1, reason: 'troco para o caixa 2' });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body).toMatchObject({ document_type: 'DRAWER_PULSE', transport: 'agent', open_drawer: 1 });

    const [pulso] = await cliente.impressoes(0);
    expect([...Buffer.from(pulso.escposBase64, 'base64')]).toEqual([0x1b, 0x70, 0, 25, 250]);
    await cliente.resultadoDaImpressao(pulso.jobId, { status: 'printed' });

    const trilha = getConnection()
      .prepare(`SELECT action, detail FROM core_audit_log WHERE entity_id = ? ORDER BY created_at`)
      .all(pedido.body.id) as { action: string; detail: string }[];
    expect(trilha.map((t) => t.action)).toEqual(['cash.drawer.open_requested', 'cash.drawer.opened_by_command']);
    expect(JSON.parse(trilha[1].detail)).toMatchObject({ reason: 'troco para o caixa 2', pdvTerminalId: caixa1, agentId });
  });

  it('o pulso que o agente não retirou em 1 minuto NUNCA abre depois', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const { cliente } = await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const pedido = await request(app)
      .post('/api/v1/core/print/drawer/open')
      .set(caixa)
      .send({ terminalId: caixa1, reason: 'conferência do fundo' });
    envelhecer(
      'UPDATE core_print_jobs SET created_at = ? WHERE id = ?',
      new Date(Date.now() - 2 * 60_000).toISOString(),
      pedido.body.id,
    );
    expect(await cliente.impressoes(0)).toHaveLength(0);
    const job = await lerJob(pedido.body.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/gaveta NÃO abre depois/);
  });

  it('GET /print/drawer responde por caixa, com o agente no ar', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const caixa2 = await criarCaixa(gerente, 'Caixa 2');
    await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const doCaixa1 = await request(app).get(`/api/v1/core/print/drawer?terminalId=${caixa1}`).set(caixa);
    expect(doCaixa1.body).toMatchObject({ byCommand: true, agentOnline: true });
    const doCaixa2 = await request(app).get(`/api/v1/core/print/drawer?terminalId=${caixa2}`).set(caixa);
    expect(doCaixa2.body.byCommand).toBe(false);
  });
});

describe('teste e gaveta têm rota própria', () => {
  it('POST /print/jobs recusa os tipos reservados, e o pulso não tem segunda via', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const direto = await imprimir(caixa, { documentType: 'DRAWER_PULSE', documentId: caixa1, terminalId: caixa1 });
    expect(direto.status).toBe(400);
    expect(direto.body.error.code).toBe('CORE_PRINT_TYPE_RESERVED');

    const pulso = await request(app)
      .post('/api/v1/core/print/drawer/open')
      .set(caixa)
      .send({ terminalId: caixa1, reason: 'troco' });
    const segunda = await request(app).post(`/api/v1/core/print/jobs/${pulso.body.id}/reprint`).set(caixa).send({});
    expect(segunda.status).toBe(400);
    expect(segunda.body.error.code).toBe('CORE_PRINT_REPRINT_NOT_ALLOWED');
  });
});

describe('a página de teste é o que faz a prontidão dizer impressão direta', () => {
  it('só a gerência pede, o agente imprime e confirma, e a prontidão vira AGENT_READY', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const { cliente } = await instalarAgente(gerente, caixa1);
    const impressora = await impressoraDeAgente(gerente, caixa1);

    const antes = await request(app).get('/api/v1/core/print/readiness').set(gerente);
    expect(antes.body.readiness).toBe('READY_FOR_HARDWARE');
    expect(antes.body.message).toMatch(/página de teste/);
    expect(antes.body.printers[0]).toMatchObject({ ready: true, problem: null, pdvTerminalName: 'Caixa 1', lastTest: null });

    expect((await request(app).post(`/api/v1/core/print/printers/${impressora}/test`).set(caixa)).status).toBe(403);
    const teste = await request(app).post(`/api/v1/core/print/printers/${impressora}/test`).set(gerente);
    expect(teste.status, JSON.stringify(teste.body)).toBe(201);
    const [pagina] = await cliente.impressoes(0);
    expect(textoDos(pagina.escposBase64)).toContain('PAGINA DE TESTE');
    await cliente.resultadoDaImpressao(pagina.jobId, { status: 'printed' });

    const depois = await request(app).get('/api/v1/core/print/readiness').set(gerente);
    expect(depois.body.readiness).toBe('AGENT_READY');
    expect(depois.body.printers[0].lastTest).toMatchObject({ status: 'printed' });
    expect(depois.body.printers[0].agent).toMatchObject({ online: true });
  });

  it('com o agente fora do ar, o teste é recusado com o que falta', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const impressora = await impressoraDeAgente(gerente, caixa1);
    const teste = await request(app).post(`/api/v1/core/print/printers/${impressora}/test`).set(gerente);
    expect(teste.status).toBe(409);
    expect(teste.body.error.code).toBe('CORE_PRINT_AGENT_UNAVAILABLE');
    expect(teste.body.error.message).toMatch(/Nenhum agente local pareado/);
  });
});

describe('retirado e não confirmado', () => {
  it('vira falha com a frase da impressora; a confirmação atrasada ainda vale', async () => {
    const caixa1 = await criarCaixa(gerente, 'Caixa 1');
    const { cliente } = await instalarAgente(gerente, caixa1);
    await impressoraDeAgente(gerente, caixa1);
    const vendaId = await vendaEmDinheiro(caixa, caixa1);
    const job = await imprimir(caixa, { documentType: 'SALE_RECEIPT', documentId: vendaId, terminalId: caixa1 });
    await cliente.impressoes(0);
    envelhecer(
      'UPDATE core_print_jobs SET claimed_at = ? WHERE id = ?',
      new Date(Date.now() - 3 * 60_000).toISOString(),
      job.body.id,
    );
    await cliente.impressoes(0);
    const vencido = await lerJob(job.body.id);
    expect(vencido.status).toBe('failed');
    expect(vencido.error).toMatch(/não confirmou em 2 minutos/);

    await cliente.resultadoDaImpressao(job.body.id, { status: 'printed' });
    expect((await lerJob(job.body.id)).status).toBe('printed');
  });
});

describe('o cadastro da impressora de agente', () => {
  it('confere o endereço e o caixa, e a empresa é a da sessão', async () => {
    const vizinha = upsertCompany({ slug: 'conceito-imp', legalName: 'Conceito Ltda', tradeName: 'Conceito' });
    const gerenteVizinha = await login('GERENTE.CONC', vizinha, 'gerente_loja');
    const caixaDaVizinha = await criarCaixa(gerenteVizinha, 'Caixa da vizinha');

    const caminhoDoSistema = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ name: 'Térmica', kind: 'cupom', transport: 'agent', agentDevice: 'C:\\Windows\\system32\\drivers\\etc\\hosts' });
    expect(caminhoDoSistema.status).toBe(400);
    expect(caminhoDoSistema.body.error.code).toBe('CORE_PRINTER_DEVICE_INVALID');

    const caixaAlheio = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ name: 'Térmica', kind: 'cupom', transport: 'agent', pdvTerminalId: caixaDaVizinha, agentDevice: 'COM3' });
    expect(caixaAlheio.status).toBe(400);
    expect(caixaAlheio.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');

    const empresaNoCorpo = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ name: 'Térmica', kind: 'cupom', transport: 'browser', companyId: vizinha });
    expect(empresaNoCorpo.status).toBe(201);
    expect(empresaNoCorpo.body.company_id).toBe(loja);

    const compartilhada = await request(app)
      .post('/api/v1/core/print/printers')
      .set(gerente)
      .send({ name: 'USB', kind: 'cupom', transport: 'agent', agentDevice: '\\\\CAIXA1\\CUPOM' });
    expect(compartilhada.status).toBe(201);
    expect(compartilhada.body.agent_device).toBe('\\\\CAIXA1\\CUPOM');
  });
});
