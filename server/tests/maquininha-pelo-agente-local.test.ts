/**
 * ============================================================================
 * A MAQUININHA DE VERDADE PASSA PELO AGENTE LOCAL (GAP-PRD-014)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 * - Cadastrar a credencial da Stone deixava o balcão SEM cartão: o status do
 *   PDV passava a dizer `configured: true`, toda cobrança morria `erro`
 *   (adaptador "estrutural") e a venda em cartão exigia uma transação
 *   aprovada que nenhum código sabia produzir — 409 em todo cartão.
 * - O agente local pareava e... só. `GET /local-agent/commands` e
 *   `POST /local-agent/result` respondiam 404: não havia fila de onde ele
 *   tirasse a cobrança nem para onde devolvesse o resultado.
 * - A prontidão dizia `ready_for_homologation` ao gravar a credencial.
 *
 * ## O que estes casos cobram
 *
 * 1. Credencial/configuração num caminho que não existe (nuvem) é RECUSADA;
 *    a maquininha real nasce desligada e só liga com o agente do caixa
 *    pareado. Nada disso tira o cartão manual do balcão.
 * 2. O canal inteiro: tenant → caixa → maquininha → agente → PinPad. A
 *    cobrança do PDV vira comando na fila do agente DAQUELE caixa; o agente a
 *    retira, informa as etapas e devolve o resultado assinado; o PDV vê
 *    "aprovado", a venda fecha com a cobrança, o comprovante fica guardado.
 * 3. A assinatura: segredo errado, corpo adulterado, nonce repetido, carimbo
 *    velho, agente revogado e agente de outra operação são recusados.
 * 4. Os prazos: comando não retirado não cobrou nada; retirado e sem resposta
 *    vira NÃO CONFIRMADA; resposta tardia só vale se ninguém decidiu antes.
 * 5. Cancelar/estornar/consultar pelo agente; homologação por evidência.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { findOneRow, findRows, insertRow, resetDbForTests, updateRows } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { assinar, fraseDaAssinatura } from '../src/services/payment-terminal/agentSignature.js';
import { expirarComandosVencidos } from '../src/services/payment-terminal/PaymentTerminalAgentChannel.js';
import { listUncertainPayments } from '../src/services/core/PdvTerminalService.js';

// Chaves próprias: o caso de produção abre o cofre, e produção recusa as
// chaves padrão de desenvolvimento (o `loadEnv` estoura — e o segredo do
// agente não abriria).
process.env.DEVORA_JWT_SECRET = 'agente-local-teste-jwt-secret-bem-comprido-e-variado';
process.env.DEVORA_ENCRYPTION_KEY = 'agente-local-teste-chave-de-cifra-bem-comprida-e-variada';

// Um app por caso: o limitador de 300 pedidos/minuto por IP é do app, e este
// arquivo passa disso somando os casos — o que ele mede é a maquininha.
let app = createApp();
const SENHA = 'AgenteLocal@Balcao2026';
const BASE = '/api/v1';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

interface Agente {
  id: string;
  segredo: string;
}

let loja: string;
let vizinha: string;
let gerente: Ator;
let caixa: Ator;
let gerenteVizinha: Ator;

async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app).post(`${BASE}/auth/login`).send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

function emAmbiente(apiEnv: 'test' | 'production') {
  process.env.DEVORA_API_ENV = apiEnv;
  resetEnvCacheForTests();
}

/** Pedido assinado do agente, exatamente como o programa do agente monta. */
function assinado(
  metodo: 'GET' | 'POST',
  caminho: string,
  agente: Agente,
  corpo?: unknown,
  opcoes: { carimbo?: string; nonce?: string; segredo?: string; corpoEnviado?: string } = {},
) {
  const carimbo = opcoes.carimbo ?? String(Date.now());
  const nonce = opcoes.nonce ?? randomUUID();
  const texto = corpo === undefined ? '' : JSON.stringify(corpo);
  const frase = fraseDaAssinatura({ metodo, caminho, carimbo, nonce, corpo: texto });
  const cabecalhos = {
    'x-devora-agent': agente.id,
    'x-devora-timestamp': carimbo,
    'x-devora-nonce': nonce,
    'x-devora-signature': assinar(opcoes.segredo ?? agente.segredo, frase),
  };
  if (metodo === 'GET') return request(app).get(caminho).set(cabecalhos);
  return request(app)
    .post(caminho)
    .set(cabecalhos)
    .set('Content-Type', 'application/json')
    .send(opcoes.corpoEnviado ?? texto);
}

async function criarCaixa(nome: string, quem = gerente): Promise<string> {
  const res = await request(app).post(`${BASE}/core/terminals`).set(quem.auth).send({ name: nome });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function cadastrarMaquininha(corpo: Record<string, unknown>, quem = gerente) {
  return request(app)
    .post(`${BASE}/payment-terminals/configurations`)
    .set(quem.auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

async function parearAgente(pdvTerminalId: string | null, quem = gerente): Promise<Agente> {
  const codigo = await request(app)
    .post(`${BASE}/payment-terminals/local-agent/pairing`)
    .set(quem.auth)
    .send({ pdvTerminalId });
  expect(codigo.status, JSON.stringify(codigo.body)).toBe(201);
  expect(String(codigo.body.pairingCode)).toMatch(/^[0-9A-F]{8}$/);
  // O agente não tem sessão: a rota é pública e o código é a prova.
  const par = await request(app)
    .post(`${BASE}/payment-terminals/agent/pair`)
    .send({ pairingCode: codigo.body.pairingCode, version: '1.0.0-teste', hostname: 'CAIXA-PC' });
  expect(par.status, JSON.stringify(par.body)).toBe(201);
  expect(par.body.agentSecret).toBeTruthy();
  return { id: par.body.agentId as string, segredo: par.body.agentSecret as string };
}

async function sinalDeVida(agente: Agente, tefClient = 'ok') {
  const res = await assinado('POST', `${BASE}/payment-terminals/agent/heartbeat`, agente, {
    version: '1.0.0-teste',
    health: { tefClient, pinpad: 'connected', bridge: 'tef_dial', message: tefClient === 'ok' ? null : 'GP inativo' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function ligar(configurationId: string) {
  return request(app)
    .post(`${BASE}/core/pdv/terminal/configurations/${configurationId}/activate`)
    .set(gerente.auth)
    .send({ reason: 'PinPad instalado e pareado' });
}

async function retirar(agente: Agente) {
  const res = await assinado('GET', `${BASE}/payment-terminals/agent/commands?waitMs=0`, agente);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Array<Record<string, unknown> & { payload: Record<string, unknown> }>;
}

async function responder(agente: Agente, commandId: string, corpo: Record<string, unknown>) {
  return assinado('POST', `${BASE}/payment-terminals/agent/commands/${commandId}/result`, agente, corpo);
}

async function cobrar(valor: number, terminalId: string | null, metodo = 'credito', quem = caixa) {
  return request(app)
    .post(`${BASE}/core/pdv/terminal/charge`)
    .set(quem.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ method: metodo, amountInCents: valor, terminalId });
}

async function produtoComEstoque(preco: number): Promise<string> {
  const criado = await request(app)
    .post(`${BASE}/core/products`)
    // A mercadoria é cadastrada e estocada pela gerência (PJ-CAIXA: o caixa da loja não administra produto).
    .set(gerente.auth)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: preco });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  const productId = criado.body.id as string;
  const carga = await request(app)
    .post(`${BASE}/core/stock/movements`)
    .set(gerente.auth)
    .send({ productId, movementType: 'in', quantity: 20, referenceType: 'entrada', referenceId: `carga-${productId}` });
  expect(carga.status, JSON.stringify(carga.body)).toBe(201);
  return productId;
}

function venderNoCartao(productId: string, preco: number, terminalId: string | null, pagamento: Record<string, unknown> = {}) {
  return request(app)
    .post(`${BASE}/core/sales`)
    .set(caixa.auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      terminalId,
      items: [{ productId, quantity: 1, unitPriceCents: preco }],
      payments: [{ method: 'credito', amountCents: preco, status: 'settled', ...pagamento }],
    });
}

function tx(id: string) {
  return findOneRow<Record<string, unknown>>('payment_terminal_transactions', (r) => r.id === id);
}

/** Maquininha Stone pelo agente no caixa, agente pareado e online, ligada. */
async function balcaoIntegrado(): Promise<{ caixaId: string; configId: string; agente: Agente }> {
  const caixaId = await criarCaixa('Caixa 1');
  const cfg = await cadastrarMaquininha({ provider: 'stone', displayName: 'PinPad do Caixa 1', pdvTerminalId: caixaId });
  expect(cfg.status, JSON.stringify(cfg.body)).toBe(201);
  const agente = await parearAgente(caixaId);
  await sinalDeVida(agente);
  const ligou = await ligar(cfg.body.id as string);
  expect(ligou.status, JSON.stringify(ligou.body)).toBe(200);
  return { caixaId, configId: cfg.body.id as string, agente };
}

beforeEach(async () => {
  emAmbiente('test');
  app = createApp();
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preco Justo Ltda', tradeName: 'Preço Justo' });
  vizinha = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  gerente = await ator('GERENTE.PJ', loja, 'gerente_loja');
  caixa = await ator('CAIXA.PJ', loja, 'operador_caixa_loja');
  gerenteVizinha = await ator('GERENTE.GRINGA', vizinha, 'gerente_loja');
});

afterEach(() => emAmbiente('test'));

// ============================================================================
describe('GAP-PRD-014 — cadastrar maquininha real não para o cartão do balcão', () => {
  it('credencial da Stone "pela nuvem" é recusada: esse caminho não existe', async () => {
    const res = await request(app)
      .post(`${BASE}/payment-terminals/credentials`)
      .set(gerente.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ provider: 'stone', connectionMode: 'cloud', accessToken: 'tok-stone-teste' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_CHANNEL_NOT_IMPLEMENTED');
    expect(res.body.error.message).toMatch(/agente local/i);
    expect(findRows('payment_terminal_configurations', (r) => r.companyId === loja)).toHaveLength(0);
  });

  it('credencial gravada sem modo nasce no agente local, DESLIGADA — e o cartão manual continua', async () => {
    const res = await request(app)
      .post(`${BASE}/payment-terminals/credentials`)
      .set(gerente.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ provider: 'stone', accessToken: 'tok-stone-teste' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ provider: 'stone', channel: 'local_agent', active: false });
    expect(JSON.stringify(res.body)).not.toContain('tok-stone-teste');

    const status = await request(app).get(`${BASE}/core/pdv/terminal/status`).set(caixa.auth);
    expect(status.body.configured).toBe(false);

    const produto = await produtoComEstoque(5000);
    const venda = await venderNoCartao(produto, 5000, null);
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  });

  it('a linha LEGADA da Stone "na nuvem", ligada, não tira o cartão do balcão', async () => {
    // Como a auditoria cadastrou no harness B1: credencial Stone, ativa, nuvem.
    insertRow('payment_terminal_configurations', {
      id: 'ptcred-legado-stone',
      companyId: loja,
      provider: 'stone',
      connectionMode: 'cloud',
      active: true,
      encryptedPayload: 'x',
      displayName: 'Terminal stone',
    });
    const status = await request(app).get(`${BASE}/core/pdv/terminal/status`).set(caixa.auth);
    expect(status.body.configured).toBe(false);
    expect(status.body.message).toMatch(/caminho que este sistema não opera/i);

    const produto = await produtoComEstoque(5000);
    const venda = await venderNoCartao(produto, 5000, null);
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const cobranca = await cobrar(5000, null);
    expect(cobranca.status).toBe(409);
    expect(cobranca.body.error.code).toBe('CORE_TERMINAL_NOT_CONFIGURED');
  });

  it('ligar a maquininha sem agente pareado é recusado, com o que fazer', async () => {
    const caixaId = await criarCaixa('Caixa 1');
    const cfg = await cadastrarMaquininha({ provider: 'cielo', pdvTerminalId: caixaId });
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(201);
    expect(cfg.body.active).toBe(false);
    const res = await ligar(cfg.body.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_AGENT_NOT_PAIRED');
    expect(res.body.error.message).toMatch(/código de pareamento/i);
  });

  it('a prontidão não diz "pronta para homologar" só porque há credencial', async () => {
    await request(app)
      .post(`${BASE}/payment-terminals/credentials`)
      .set(gerente.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ provider: 'stone', accessToken: 'tok-stone-teste' });
    const r = await request(app).get(`${BASE}/payment-terminals/readiness`).set(gerente.auth);
    expect(r.status).toBe(200);
    expect(r.body.overallStatus).toBe('awaiting_agent');
    expect(r.body.readyForHomologation).toBe(false);
    expect(r.body.configurations[0]).toMatchObject({ provider: 'stone', status: 'awaiting_agent' });
  });

  it('o caixa não cadastra maquininha, credencial nem pareamento: é decisão da gerência', async () => {
    const cfg = await cadastrarMaquininha({ provider: 'stone' }, caixa);
    expect(cfg.status).toBe(403);
    const cred = await request(app)
      .post(`${BASE}/payment-terminals/credentials`)
      .set(caixa.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ provider: 'stone', accessToken: 'x' });
    expect(cred.status).toBe(403);
    const par = await request(app).post(`${BASE}/payment-terminals/local-agent/pairing`).set(caixa.auth).send({});
    expect(par.status).toBe(403);
  });
});

// ============================================================================
describe('GAP-PRD-014 — o canal PDV → agente → PinPad, de ponta a ponta', () => {
  it('a cobrança do PDV vai para a fila do agente do caixa e volta aprovada com NSU e comprovante', async () => {
    const { caixaId, configId, agente } = await balcaoIntegrado();

    const status = await request(app).get(`${BASE}/core/pdv/terminal/status?terminalId=${caixaId}`).set(caixa.auth);
    expect(status.body).toMatchObject({ configured: true, channel: 'local_agent', channelReady: true, configurationId: configId });

    const cobranca = await cobrar(8900, caixaId);
    expect(cobranca.status, JSON.stringify(cobranca.body)).toBe(200);
    expect(cobranca.body).toMatchObject({ state: 'aguardando_terminal', settled: false, pending: true });
    const txId = cobranca.body.transactionId as string;

    const comandos = await retirar(agente);
    expect(comandos).toHaveLength(1);
    expect(comandos[0]).toMatchObject({ command: 'startPayment', transactionId: txId, redelivery: false });
    expect(comandos[0].payload).toMatchObject({ amountInCents: 8900, paymentMethod: 'credit', provider: 'stone' });

    const retirada = await request(app).get(`${BASE}/core/pdv/terminal/${txId}`).set(caixa.auth);
    expect(retirada.body.state).toBe('processando');

    const etapa = await responder(agente, String(comandos[0].id), {
      status: 'in_progress',
      stage: 'awaiting_customer',
      message: 'INSIRA OU PASSE O CARTAO',
    });
    expect(etapa.status, JSON.stringify(etapa.body)).toBe(200);
    const noAparelho = await request(app).get(`${BASE}/core/pdv/terminal/${txId}`).set(caixa.auth);
    expect(noAparelho.body.state).toBe('aguardando_cliente');
    expect(noAparelho.body.message).toContain('INSIRA OU PASSE O CARTAO');

    const fim = await responder(agente, String(comandos[0].id), {
      status: 'approved',
      nsu: '123456',
      authorizationCode: 'A1B2C3',
      maskedCard: '4111111111111111',
      cardBrand: 'VISA',
      acquirer: 'STONE',
      merchantReceipt: 'VIA ESTABELECIMENTO\nSTONE\nR$ 89,00',
      customerReceipt: 'VIA CLIENTE\nSTONE\nR$ 89,00',
    });
    expect(fim.status, JSON.stringify(fim.body)).toBe(200);
    expect(fim.body).toMatchObject({ outcome: 'applied', transactionStatus: 'authorized', confirmOnTef: true });

    const aprovada = await request(app).get(`${BASE}/core/pdv/terminal/${txId}`).set(caixa.auth);
    expect(aprovada.body).toMatchObject({ state: 'aprovado', settled: true, simulated: false });
    // O cartão só é guardado mascarado, ainda que o agente mande o número inteiro.
    expect(tx(txId)).toMatchObject({ maskedCard: '****1111', providerNsu: '123456', real: true, configurationId: configId });

    const recibo = await request(app).get(`${BASE}/payment-terminals/transactions/${txId}/receipt?via=customer`).set(gerente.auth);
    expect(recibo.status).toBe(200);
    expect(recibo.body.receiptText).toContain('VIA CLIENTE');

    // A venda fecha com a cobrança, e a cobrança fica amarrada à venda.
    const produto = await produtoComEstoque(8900);
    const semCobranca = await venderNoCartao(produto, 8900, caixaId);
    expect(semCobranca.status).toBe(400);
    expect(semCobranca.body.error.code).toBe('CORE_SALE_TERMINAL_REF_REQUIRED');
    const venda = await venderNoCartao(produto, 8900, caixaId, { providerRef: txId });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    expect(tx(txId)?.saleId).toBe(venda.body.id);
  });

  it('o mesmo resultado mandado duas vezes não vira dois comprovantes', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(1000, caixaId);
    const [cmd] = await retirar(agente);
    const corpo = { status: 'approved', nsu: '1', authorizationCode: 'X', merchantReceipt: 'VIA LOJA' };
    const primeiro = await responder(agente, String(cmd.id), corpo);
    const segundo = await responder(agente, String(cmd.id), corpo);
    expect(primeiro.body.duplicate).toBe(false);
    expect(segundo.status).toBe(200);
    expect(segundo.body).toMatchObject({ duplicate: true, transactionStatus: 'authorized', confirmOnTef: true });
    expect(findRows('payment_terminal_receipts', (r) => r.transactionId === cobranca.body.transactionId)).toHaveLength(1);
  });

  it('recusa no aparelho não libera a venda e diz o que o PinPad disse', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(2500, caixaId, 'debito');
    const [cmd] = await retirar(agente);
    expect(cmd.payload.paymentMethod).toBe('debit');
    await responder(agente, String(cmd.id), { status: 'declined', message: 'SALDO INSUFICIENTE' });
    const r = await request(app).get(`${BASE}/core/pdv/terminal/${cobranca.body.transactionId}`).set(caixa.auth);
    expect(r.body).toMatchObject({ state: 'recusado', settled: false });
    expect(r.body.message).toContain('SALDO INSUFICIENTE');
  });

  it('o caixa ao lado não usa o PinPad do Caixa 1: lá o cartão é lançado à mão', async () => {
    const { agente } = await balcaoIntegrado();
    const caixa2 = await criarCaixa('Caixa 2');
    const status = await request(app).get(`${BASE}/core/pdv/terminal/status?terminalId=${caixa2}`).set(caixa.auth);
    expect(status.body.configured).toBe(false);
    const produto = await produtoComEstoque(3000);
    const venda = await venderNoCartao(produto, 3000, caixa2);
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    expect(await retirar(agente)).toHaveLength(0);
  });

  it('sem caixa no pedido, a exigência do cartão continua — omitir o caixa não afrouxa nada', async () => {
    await balcaoIntegrado();
    const status = await request(app).get(`${BASE}/core/pdv/terminal/status`).set(caixa.auth);
    expect(status.body).toMatchObject({ configured: true, requiresTerminal: true });
    const produto = await produtoComEstoque(3000);
    const venda = await venderNoCartao(produto, 3000, null);
    expect(venda.status).toBe(400);
    expect(venda.body.error.code).toBe('CORE_SALE_TERMINAL_REF_REQUIRED');
    const cobranca = await cobrar(3000, null);
    expect(cobranca.status).toBe(409);
    expect(cobranca.body.error.code).toBe('CORE_TERMINAL_CAIXA_REQUIRED');
  });

  it('agente fora do ar: a cobrança é recusada ANTES de nascer, nada fica pendurado', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    updateRows('payment_terminal_local_agents', (r) => r.id === agente.id, (r) => ({
      ...r,
      lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }));
    const status = await request(app).get(`${BASE}/core/pdv/terminal/status?terminalId=${caixaId}`).set(caixa.auth);
    expect(status.body).toMatchObject({ configured: true, channelReady: false });
    expect(status.body.message).toMatch(/fora do ar/i);
    const antes = findRows('payment_terminal_transactions', (r) => r.companyId === loja).length;
    const cobranca = await cobrar(1000, caixaId);
    expect(cobranca.status).toBe(409);
    expect(cobranca.body.error.code).toBe('PAYMENT_TERMINAL_AGENT_OFFLINE');
    expect(cobranca.body.error.message).toMatch(/NADA foi cobrado/);
    expect(findRows('payment_terminal_transactions', (r) => r.companyId === loja)).toHaveLength(antes);
  });

  it('a mesma chave reenviada devolve a mesma cobrança e não põe outro comando na fila', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const chave = randomUUID();
    const pedir = () =>
      request(app)
        .post(`${BASE}/core/pdv/terminal/charge`)
        .set(caixa.auth)
        .set('Idempotency-Key', chave)
        .send({ method: 'credito', amountInCents: 4000, terminalId: caixaId });
    const a = await pedir();
    const b = await pedir();
    expect(b.body.transactionId).toBe(a.body.transactionId);
    expect(await retirar(agente)).toHaveLength(1);
  });
});

// ============================================================================
describe('GAP-PRD-014 — a assinatura do agente', () => {
  it('segredo errado, corpo adulterado, nonce repetido e carimbo velho: 401', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    await cobrar(1000, caixaId);
    const [cmd] = await retirar(agente);
    const caminho = `${BASE}/payment-terminals/agent/commands/${cmd.id}/result`;

    const errado = await assinado('POST', caminho, agente, { status: 'approved' }, { segredo: 'nao-e-o-segredo' });
    expect(errado.status).toBe(401);
    expect(errado.body.error.code).toBe('PAYMENT_TERMINAL_AGENT_UNAUTHORIZED');

    // Assinado "declined", enviado "approved": o SHA-256 do corpo não bate.
    const adulterado = await assinado('POST', caminho, agente, { status: 'declined' }, {
      corpoEnviado: JSON.stringify({ status: 'approved' }),
    });
    expect(adulterado.status).toBe(401);

    const velho = await assinado('GET', `${BASE}/payment-terminals/agent/commands?waitMs=0`, agente, undefined, {
      carimbo: String(Date.now() - 10 * 60_000),
    });
    expect(velho.status).toBe(401);

    const nonce = randomUUID();
    const primeiro = await assinado('POST', `${BASE}/payment-terminals/agent/heartbeat`, agente, { version: '1' }, { nonce });
    expect(primeiro.status).toBe(200);
    const repetido = await assinado('POST', `${BASE}/payment-terminals/agent/heartbeat`, agente, { version: '1' }, { nonce });
    expect(repetido.status).toBe(401);

    const semCabecalho = await request(app).get(`${BASE}/payment-terminals/agent/commands`);
    expect(semCabecalho.status).toBe(401);
    expect(tx(String(cmd.transactionId))?.status).toBe('in_progress');
  });

  it('agente revogado não retira nem responde; o segredo some da linha', async () => {
    const { agente } = await balcaoIntegrado();
    const lista = await request(app).get(`${BASE}/payment-terminals/local-agents`).set(gerente.auth);
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain(agente.segredo);
    expect(JSON.stringify(lista.body)).not.toMatch(/encryptedSecret/);

    const sem = await request(app).post(`${BASE}/payment-terminals/local-agents/${agente.id}/revoke`).set(gerente.auth).send({});
    expect(sem.status).toBe(400);
    const rev = await request(app)
      .post(`${BASE}/payment-terminals/local-agents/${agente.id}/revoke`)
      .set(gerente.auth)
      .send({ reason: 'computador do caixa trocado' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.status).toBe('revoked');
    expect(findOneRow('payment_terminal_local_agents', (r) => r.id === agente.id)?.encryptedSecret).toBeNull();
    const depois = await assinado('GET', `${BASE}/payment-terminals/agent/commands?waitMs=0`, agente);
    expect(depois.status).toBe(401);
  });

  it('o agente de uma operação não responde pelo comando da outra, e o gerente vizinho não revoga', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    await cobrar(1000, caixaId);
    const [cmd] = await retirar(agente);

    const par = await request(app).post(`${BASE}/payment-terminals/local-agent/pairing`).set(gerenteVizinha.auth).send({});
    const outro = await request(app).post(`${BASE}/payment-terminals/agent/pair`).send({ pairingCode: par.body.pairingCode });
    const agenteVizinho: Agente = { id: outro.body.agentId, segredo: outro.body.agentSecret };
    const res = await responder(agenteVizinho, String(cmd.id), { status: 'approved' });
    expect(res.status).toBe(404);
    expect(tx(String(cmd.transactionId))?.status).toBe('in_progress');

    const revogar = await request(app)
      .post(`${BASE}/payment-terminals/local-agents/${agente.id}/revoke`)
      .set(gerenteVizinha.auth)
      .send({ reason: 'tentativa' });
    expect(revogar.status).toBe(404);
  });

  it('código de pareamento é de uso único', async () => {
    const codigo = await request(app).post(`${BASE}/payment-terminals/local-agent/pairing`).set(gerente.auth).send({});
    const um = await request(app).post(`${BASE}/payment-terminals/agent/pair`).send({ pairingCode: codigo.body.pairingCode });
    expect(um.status).toBe(201);
    const dois = await request(app).post(`${BASE}/payment-terminals/agent/pair`).send({ pairingCode: codigo.body.pairingCode });
    expect(dois.status).toBe(400);
    expect(dois.body.error.code).toBe('PAYMENT_TERMINAL_PAIRING_INVALID');
  });

  it('pareamento para caixa de outra operação é recusado', async () => {
    const caixaVizinho = await criarCaixa('Caixa da Gringa', gerenteVizinha);
    const res = await request(app)
      .post(`${BASE}/payment-terminals/local-agent/pairing`)
      .set(gerente.auth)
      .send({ pdvTerminalId: caixaVizinho });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TERMINAL_NOT_REGISTERED');
  });
});

// ============================================================================
describe('GAP-PRD-014 — prazos: o que não se sabe não vira aprovado nem recusado', () => {
  it('comando que o agente não retirou a tempo: NADA foi cobrado, e o operador pode tentar de novo', async () => {
    const { caixaId } = await balcaoIntegrado();
    const cobranca = await cobrar(1500, caixaId);
    const txId = cobranca.body.transactionId as string;
    expirarComandosVencidos(loja, new Date(Date.now() + 31_000));
    const r = await request(app).get(`${BASE}/core/pdv/terminal/${txId}`).set(caixa.auth);
    expect(r.body).toMatchObject({ state: 'erro', settled: false, needsReconciliation: false });
    expect(r.body.message).toMatch(/NADA foi cobrado/);
    expect(findRows('payment_terminal_dead_letter', (d) => d.transactionId === txId)[0]).toMatchObject({ reason: 'not_delivered' });
    const deNovo = await cobrar(1500, caixaId);
    expect(deNovo.status).toBe(200);
  });

  it('retirado e sem resposta: NÃO CONFIRMADA na conferência; a resposta tardia vale se ninguém decidiu', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(2000, caixaId);
    const txId = cobranca.body.transactionId as string;
    const [cmd] = await retirar(agente);
    expirarComandosVencidos(loja, new Date(Date.now() + 181_000));
    expect(listUncertainPayments(loja).map((p) => p.transactionId)).toContain(txId);
    const r = await request(app).get(`${BASE}/core/pdv/terminal/${txId}`).set(caixa.auth);
    expect(r.body).toMatchObject({ state: 'timeout_nao_confirmado', needsReconciliation: true });

    const tardia = await responder(agente, String(cmd.id), { status: 'approved', nsu: '999', authorizationCode: 'LATE' });
    expect(tardia.status, JSON.stringify(tardia.body)).toBe(200);
    expect(tardia.body.outcome).toBe('late_applied');
    expect(tx(txId)?.status).toBe('authorized');
    expect(findRows('payment_terminal_history', (h) => h.transactionId === txId && h.action === 'late_agent_answer_applied')).toHaveLength(1);
  });

  it('resposta tardia depois da conferência do gestor NÃO passa por cima dele', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(2000, caixaId);
    const txId = cobranca.body.transactionId as string;
    const [cmd] = await retirar(agente);
    expirarComandosVencidos(loja, new Date(Date.now() + 181_000));
    const conferida = await request(app)
      .post(`${BASE}/core/pdv/terminal/${txId}/reconcile`)
      .set(gerente.auth)
      .send({ outcome: 'recusado', reason: 'extrato da Stone sem a transação' });
    expect(conferida.status, JSON.stringify(conferida.body)).toBe(200);
    const tardia = await responder(agente, String(cmd.id), { status: 'approved' });
    expect(tardia.body).toMatchObject({ outcome: 'late_ignored' });
    expect(tx(txId)?.status).toBe('declined');
    expect(findRows('payment_terminal_history', (h) => h.transactionId === txId && h.action === 'late_agent_answer')).toHaveLength(1);
  });

  it('"consultar no aparelho" resolve a não confirmada pela palavra do cliente TEF', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(2000, caixaId);
    const txId = cobranca.body.transactionId as string;
    await retirar(agente);
    expirarComandosVencidos(loja, new Date(Date.now() + 181_000));
    const pedido = await request(app).post(`${BASE}/payment-terminals/transactions/${txId}/query`).set(gerente.auth);
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
    const naoCaixa = await request(app).post(`${BASE}/payment-terminals/transactions/${txId}/query`).set(caixa.auth);
    expect(naoCaixa.status).toBe(403);
    const comandos = await retirar(agente);
    const consulta = comandos.find((c) => c.command === 'queryStatus')!;
    expect(consulta).toBeTruthy();
    const res = await responder(agente, String(consulta.id), { status: 'approved', nsu: '777', authorizationCode: 'Q1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx(txId)?.status).toBe('authorized');
    expect(findRows('payment_terminal_history', (h) => h.transactionId === txId && h.action === 'status_confirmed_by_agent')).toHaveLength(1);
  });
});

// ============================================================================
describe('GAP-PRD-014 — cancelar e estornar pelo agente', () => {
  async function aprovada(agente: Agente, caixaId: string, valor = 5000) {
    const cobranca = await cobrar(valor, caixaId);
    const comandos = await retirar(agente);
    const cmd = comandos.find((c) => c.transactionId === cobranca.body.transactionId)!;
    await responder(agente, String(cmd.id), { status: 'approved', nsu: '4242', authorizationCode: 'AUT1', acquirer: 'STONE' });
    return cobranca.body.transactionId as string;
  }

  it('cancelar vai para a fila (202), a cobrança só muda com a confirmação do aparelho', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const txId = await aprovada(agente, caixaId);
    const pedido = await request(app)
      .post(`${BASE}/payment-terminals/transactions/${txId}/cancel`)
      .set(gerente.auth)
      .send({ reason: 'cliente desistiu antes de levar' });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
    expect(pedido.body).toMatchObject({ queuedToAgent: true, operation: 'cancel' });
    expect(tx(txId)?.status).toBe('authorized');

    const repetido = await request(app)
      .post(`${BASE}/payment-terminals/transactions/${txId}/cancel`)
      .set(gerente.auth)
      .send({ reason: 'de novo' });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('PAYMENT_TERMINAL_OPERATION_IN_PROGRESS');

    const [cmd] = await retirar(agente);
    expect(cmd).toMatchObject({ command: 'cancel', transactionId: txId });
    expect(cmd.payload).toMatchObject({ nsu: '4242', authorizationCode: 'AUT1', amountInCents: 5000 });
    const ok = await responder(agente, String(cmd.id), { status: 'approved', message: 'CANCELAMENTO OK' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(tx(txId)).toMatchObject({ status: 'cancelled', cancellationVia: 'agent' });
    const tentativas = findRows('payment_terminal_cancellations', (r) => r.transactionId === txId).map((r) => r.outcome);
    expect(tentativas).toEqual(['queued_to_agent', 'confirmed']);
  });

  it('estorno recusado pelo aparelho fica registrado e a cobrança continua paga', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const txId = await aprovada(agente, caixaId);
    const pedido = await request(app)
      .post(`${BASE}/payment-terminals/transactions/${txId}/refund`)
      .set(gerente.auth)
      .send({ reason: 'devolução parcial', amountInCents: 2000 });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
    const [cmd] = await retirar(agente);
    expect(cmd.payload.amountInCents).toBe(2000);
    await responder(agente, String(cmd.id), { status: 'declined', message: 'ESTORNO PARCIAL NAO SUPORTADO' });
    expect(tx(txId)?.status).toBe('authorized');
    expect(findRows('payment_terminal_refunds', (r) => r.transactionId === txId).map((r) => r.outcome)).toEqual([
      'queued_to_agent',
      'declined',
    ]);
  });
});

// ============================================================================
describe('GAP-PRD-014 — homologação só com evidência, e treinamento não vale em produção', () => {
  it('a maquininha fica homologada quando as operações reais obrigatórias aconteceram', async () => {
    const { caixaId, configId, agente } = await balcaoIntegrado();
    const leitura = async () =>
      (await request(app).get(`${BASE}/payment-terminals/readiness`).set(gerente.auth)).body.configurations.find(
        (c: { configurationId: string }) => c.configurationId === configId,
      );
    expect((await leitura()).status).toBe('ready_for_homologation');

    const fazer = async (metodo: string, valor: number, resultado: Record<string, unknown>) => {
      const c = await cobrar(valor, caixaId, metodo);
      const cmd = (await retirar(agente)).find((x) => x.transactionId === c.body.transactionId)!;
      await responder(agente, String(cmd.id), resultado);
      return c.body.transactionId as string;
    };
    const credito = await fazer('credito', 1000, { status: 'approved', nsu: '1', merchantReceipt: 'VIA LOJA' });
    await fazer('debito', 1000, { status: 'approved', nsu: '2' });
    await fazer('credito', 1000, { status: 'declined' });
    const cancelar = await fazer('credito', 700, { status: 'approved', nsu: '3' });
    await request(app).post(`${BASE}/payment-terminals/transactions/${cancelar}/cancel`).set(gerente.auth).send({ reason: 'homologação' });
    const cc = (await retirar(agente)).find((x) => x.command === 'cancel')!;
    await responder(agente, String(cc.id), { status: 'approved' });
    expect((await leitura()).homologation.missing).toEqual(['Venda do PDV paga com a cobrança']);

    const produto = await produtoComEstoque(1000);
    const venda = await venderNoCartao(produto, 1000, caixaId, { providerRef: credito });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const final = await leitura();
    expect(final.status).toBe('homologated');
    expect(final.homologation.homologated).toBe(true);
  });

  it('em produção, resposta do cliente TEF em modo de treinamento vira falha — nada é dinheiro', async () => {
    const { caixaId, agente } = await balcaoIntegrado();
    const cobranca = await cobrar(1000, caixaId);
    const [cmd] = await retirar(agente);
    emAmbiente('production');
    const res = await responder(agente, String(cmd.id), { status: 'approved', simulated: true, nsu: 'TREINO' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.confirmOnTef).toBe(false);
    expect(tx(cobranca.body.transactionId)).toMatchObject({ status: 'failed' });
    expect(String(tx(cobranca.body.transactionId)?.providerMessage)).toMatch(/TREINAMENTO/);
  });
});

// A tabela relacional dos comandos é cercada por empresa também na leitura do gestor.
describe('GAP-PRD-014 — a fila vista pelo gestor', () => {
  it('lista os comandos da operação, e só dela', async () => {
    const { caixaId } = await balcaoIntegrado();
    await cobrar(1000, caixaId);
    const minha = await request(app).get(`${BASE}/payment-terminals/agent-commands`).set(gerente.auth);
    expect(minha.status).toBe(200);
    expect(minha.body.items).toHaveLength(1);
    const alheia = await request(app).get(`${BASE}/payment-terminals/agent-commands`).set(gerenteVizinha.auth);
    expect(alheia.body.items).toHaveLength(0);
    const total = getConnection().prepare('SELECT COUNT(*) AS n FROM core_payment_terminal_agent_commands').get() as { n: number };
    expect(total.n).toBe(1);
  });
});
