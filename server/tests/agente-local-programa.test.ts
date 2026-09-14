/**
 * ============================================================================
 * O PROGRAMA DO AGENTE LOCAL, CONTRA UM GERENCIADOR TEF DE MENTIRA (GAP-PRD-014)
 * ============================================================================
 *
 * O servidor ganhou a fila e o resultado assinado; faltava o OUTRO lado — o
 * programa que roda no computador do caixa, retira a cobrança, fala com o
 * cliente TEF e devolve o resultado. Sem ele, "instalar o PinPad" ainda
 * exigiria programar.
 *
 * O cliente TEF daqui é um gerenciador FALSO que lê as pastas REQ/RESP de
 * uma pasta temporária do sistema, acusa o pedido (IntPos.Sts) e responde
 * (IntPos.001) — o protocolo de troca de arquivos. Ele só existe no teste.
 * O servidor é o app de verdade, em memória, sem rede: o `buscar` do agente
 * é ligado ao supertest.
 *
 * Os casos cobram:
 *
 * - a ponte: pedido escrito e renomeado, recibo, resposta lida pela
 *   identificação, comprovante e confirmação; gerenciador fechado = nada
 *   cobrado e pedido APAGADO; recibo sem resposta = não confirmada;
 * - o executor de ponta a ponta: parear pelo código, cobrar pelo PDV, o
 *   agente retira, cobra no "PinPad", o servidor registra aprovado com NSU e
 *   comprovante, e só então o agente CONFIRMA (CNF) no gerenciador;
 * - servidor que recusa o resultado → o agente DESFAZ (NCN);
 * - agente que caiu no meio da cobrança não cobra de novo: "não confirmada".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { findOneRow, resetDbForTests } from '../src/db/database.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { ClienteDoServidor, parearComOServidor, type Buscador } from '../src/local-agent/ClienteDoServidor.js';
import { armazemEmMemoria, ExecutorDoAgente } from '../src/local-agent/ExecutorDoAgente.js';
import { lerCampos, PonteTefDial } from '../src/local-agent/PonteTefDial.js';
import { lerArgumentos } from '../src/local-agent/main.js';

process.env.DEVORA_JWT_SECRET = 'agente-programa-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'agente-programa-teste-chave-de-cifra-bem-comprida';

let app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'AgentePrograma@2026';

/** O `fetch` do agente ligado ao app em memória — nenhuma porta aberta. */
const buscar: Buscador = async (url, init) => {
  const u = new URL(url);
  const caminho = `${u.pathname}${u.search}`;
  const base = init.method === 'GET' ? request(app).get(caminho) : request(app).post(caminho);
  const pedido = base.set(init.headers);
  const res = init.body === undefined ? await pedido : await pedido.send(init.body);
  return { status: res.status, json: async () => res.body as unknown };
};

// ---------------------------------------------------------------- o GP falso

interface GerenciadorFalso {
  dirReq: string;
  dirResp: string;
  recebidos: Map<string, string>[];
  parar: () => void;
}

/**
 * Lê REQ/IntPos.001, acusa (Sts) e, para CRT/CNC, responde como mandado.
 * `modo`: 'aprova' | 'recusa' | 'mudo' (acusa e nunca responde) | 'fechado' (nem acusa).
 */
function gerenciadorFalso(pasta: string, modo: 'aprova' | 'recusa' | 'mudo' | 'fechado' = 'aprova'): GerenciadorFalso {
  const dirReq = join(pasta, 'REQ');
  const dirResp = join(pasta, 'RESP');
  // O gerenciador de verdade cria as próprias pastas ao instalar.
  mkdirSync(dirReq, { recursive: true });
  mkdirSync(dirResp, { recursive: true });
  const recebidos: Map<string, string>[] = [];
  let nsu = 100;
  const relogio = setInterval(() => {
    const arquivo = join(dirReq, 'IntPos.001');
    if (modo === 'fechado' || !existsSync(arquivo)) return;
    const campos = lerCampos(readFileSync(arquivo, 'latin1'));
    rmSync(arquivo, { force: true });
    recebidos.push(campos);
    const id = campos.get('001-000') ?? '';
    const op = campos.get('000-000') ?? '';
    const escrever = (nome: string, linhas: string[]) => {
      const tmp = join(dirResp, `${nome}.tmp`);
      writeFileSync(tmp, `${linhas.join('\r\n')}\r\n999-999 = 0\r\n`, 'latin1');
      renameSync(tmp, join(dirResp, nome));
    };
    escrever('IntPos.Sts', [`000-000 = ${op}`, `001-000 = ${id}`]);
    if ((op === 'CRT' || op === 'CNC') && modo !== 'mudo') {
      nsu += 1;
      const aprovada = modo === 'aprova';
      setTimeout(() => {
        escrever('IntPos.001', [
          `000-000 = ${op}`,
          `001-000 = ${id}`,
          `009-000 = ${aprovada ? '0' : '5'}`,
          '010-000 = STONE',
          `012-000 = ${String(nsu).padStart(6, '0')}`,
          '013-000 = AUT777',
          '022-000 = 11092026',
          '023-000 = 101500',
          `027-000 = FIN${nsu}`,
          `030-000 = ${aprovada ? 'TRANSACAO APROVADA' : 'SALDO INSUFICIENTE'}`,
          '040-000 = VISA',
          '712-000 = 2',
          '713-001 = "VIA CLIENTE"',
          '713-002 = "STONE R$ 89,00"',
          '714-000 = 2',
          '715-001 = "VIA ESTABELECIMENTO"',
          '715-002 = "STONE R$ 89,00"',
        ]);
      }, 60);
    }
  }, 20);
  return { dirReq, dirResp, recebidos, parar: () => clearInterval(relogio) };
}

let pasta: string;
let gp: GerenciadorFalso | null;

function ponte(esperaStatusMs = 1500, esperaRespostaMs = 2000) {
  return new PonteTefDial({ dirReq: join(pasta, 'REQ'), dirResp: join(pasta, 'RESP'), esperaStatusMs, esperaRespostaMs, intervaloMs: 20 });
}

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'devora-gp-'));
  gp = null;
});

afterEach(() => {
  gp?.parar();
  rmSync(pasta, { recursive: true, force: true });
});

// ============================================================================
describe('a ponte pela troca de arquivos', () => {
  it('cobra: pedido renomeado, recibo, resposta pela identificação, comprovante e dados de confirmação', async () => {
    gp = gerenciadorFalso(pasta, 'aprova');
    const etapas: string[] = [];
    const r = await ponte().cobrar(
      { referencia: '0000000042', documento: 'ABC12345', valorEmCentavos: 8900, metodo: 'credit', parcelas: 1 },
      (e) => etapas.push(e.stage),
    );
    expect(r).toMatchObject({ status: 'approved', nsu: '000101', authorizationCode: 'AUT777', acquirer: 'STONE', cardBrand: 'VISA' });
    expect(r.customerReceipt).toBe('VIA CLIENTE\nSTONE R$ 89,00');
    expect(r.merchantReceipt).toBe('VIA ESTABELECIMENTO\nSTONE R$ 89,00');
    expect(r.confirmacao).toEqual({ rede: 'STONE', nsu: '000101', finalizacao: 'FIN101', referencia: '0000000042' });
    expect(etapas).toEqual(['awaiting_customer']);
    const pedido = gp.recebidos[0];
    expect(Object.fromEntries(pedido)).toMatchObject({
      '000-000': 'CRT',
      '001-000': '0000000042',
      '002-000': 'ABC12345',
      '003-000': '8900',
      '004-000': '0',
      '999-999': '0',
    });
    // Nada sobra nas pastas: o pedido foi pego e as respostas, lidas e apagadas.
    expect(readdirSync(join(pasta, 'RESP'))).toEqual([]);
  });

  it('gerenciador fechado: NADA cobrado, e o pedido é APAGADO para ninguém pegá-lo depois', async () => {
    gp = gerenciadorFalso(pasta, 'fechado');
    const r = await ponte(300).cobrar({ referencia: '1', documento: 'X', valorEmCentavos: 100, metodo: 'debit', parcelas: 1 });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/NADA foi cobrado/);
    expect(existsSync(join(pasta, 'REQ', 'IntPos.001'))).toBe(false);
  });

  it('recibo sem resposta: NÃO CONFIRMADA, nunca recusada', async () => {
    gp = gerenciadorFalso(pasta, 'mudo');
    const r = await ponte(1000, 300).cobrar({ referencia: '2', documento: 'X', valorEmCentavos: 100, metodo: 'credit', parcelas: 1 });
    expect(r.status).toBe('uncertain');
  });

  it('estorno parcial é recusado pela ponte (CNC desfaz o valor inteiro); PIX só se habilitado', async () => {
    const parcial = await ponte().cancelar({
      referencia: '3', valorEmCentavos: 100, valorOriginalEmCentavos: 500, rede: 'STONE', nsu: '1', data: null, hora: null,
    });
    expect(parcial.status).toBe('declined');
    const pix = await ponte().cobrar({ referencia: '4', documento: 'X', valorEmCentavos: 100, metodo: 'pix', parcelas: 1 });
    expect(pix.status).toBe('failed');
  });

  it('saúde: ATV acusado = cliente TEF ok; sem acusar = indisponível', async () => {
    gp = gerenciadorFalso(pasta, 'aprova');
    expect((await ponte().saude()).tefClient).toBe('ok');
    gp.parar();
    expect((await ponte(200).saude()).tefClient).toBe('unavailable');
  });
});

// ============================================================================
describe('o executor do agente, de ponta a ponta com o servidor', () => {
  let loja: string;
  let gerenteAuth: { Authorization: string };
  let caixaAuth: { Authorization: string };
  let caixaId: string;

  async function login(l: string, companyId: string, perfil: string) {
    const userId = await upsertUser({ login: l, displayName: l, password: SENHA });
    linkUserToCompany(userId, companyId, perfil, true);
    const r = await request(app).post('/api/v1/auth/login').send({ login: l, password: SENHA, companyId });
    expect(r.status).toBe(200);
    return { Authorization: `Bearer ${r.body.accessToken}` };
  }

  /** Gerente cadastra caixa e maquininha, gera o código; o PROGRAMA pareia e liga. */
  async function instalar(modo: 'aprova' | 'recusa' = 'aprova') {
    gp = gerenciadorFalso(pasta, modo);
    const caixa = await request(app).post('/api/v1/core/terminals').set(gerenteAuth).send({ name: 'Caixa 1' });
    caixaId = caixa.body.id;
    const cfg = await request(app)
      .post('/api/v1/payment-terminals/configurations')
      .set(gerenteAuth)
      .set('Idempotency-Key', randomUUID())
      .send({ provider: 'stone', displayName: 'PinPad Caixa 1', pdvTerminalId: caixaId });
    const codigo = await request(app)
      .post('/api/v1/payment-terminals/local-agent/pairing')
      .set(gerenteAuth)
      .send({ pdvTerminalId: caixaId });
    const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.0.0', hostname: 'CAIXA1' }, buscar);
    expect(par.pdvTerminalId).toBe(caixaId);
    const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
    const estado = armazemEmMemoria();
    const executor = new ExecutorDoAgente(cliente, ponte(), {
      estado,
      versao: '1.0.0',
      hostname: 'CAIXA1',
      tentativas: 2,
      esperaEntreTentativasMs: 10,
    });
    await executor.sinal();
    const ligou = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${cfg.body.id}/activate`)
      .set(gerenteAuth)
      .send({ reason: 'PinPad instalado' });
    expect(ligou.status, JSON.stringify(ligou.body)).toBe(200);
    return { executor, estado, cliente, agentId: par.agentId };
  }

  async function cobrarNoPdv(valor = 8900) {
    const r = await request(app)
      .post('/api/v1/core/pdv/terminal/charge')
      .set(caixaAuth)
      .set('Idempotency-Key', randomUUID())
      .send({ method: 'credito', amountInCents: valor, terminalId: caixaId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.transactionId as string;
  }

  const tx = (id: string) => findOneRow<Record<string, unknown>>('payment_terminal_transactions', (r) => r.id === id);

  beforeEach(async () => {
    process.env.DEVORA_API_ENV = 'test';
    resetEnvCacheForTests();
    app = createApp();
    resetDbForTests();
    loja = upsertCompany({ slug: 'preco-justo', legalName: 'PJ Ltda', tradeName: 'PJ' });
    gerenteAuth = await login('GERENTE.AG', loja, 'gerente_loja');
    caixaAuth = await login('CAIXA.AG', loja, 'operador_caixa_loja');
  });

  it('o PDV cobra, o agente passa no PinPad, o servidor registra e só então o agente CONFIRMA', async () => {
    const { executor, estado } = await instalar('aprova');
    const txId = await cobrarNoPdv();
    expect(await executor.passo(0)).toBe(1);

    expect(tx(txId)).toMatchObject({ status: 'authorized', providerNsu: '000101', providerAuthorizationCode: 'AUT777', real: true });
    const pdv = await request(app).get(`/api/v1/core/pdv/terminal/${txId}`).set(caixaAuth);
    expect(pdv.body).toMatchObject({ state: 'aprovado', settled: true });
    const recibo = await request(app).get(`/api/v1/payment-terminals/transactions/${txId}/receipt?via=customer`).set(gerenteAuth);
    expect(recibo.body.receiptText).toContain('VIA CLIENTE');

    // A ordem importa: CRT, depois (e só depois) CNF com a finalização do GP.
    const ops = gp!.recebidos.map((c) => c.get('000-000'));
    expect(ops.filter((o) => o !== 'ATV')).toEqual(['CRT', 'CNF']);
    const cnf = gp!.recebidos.find((c) => c.get('000-000') === 'CNF')!;
    expect(cnf.get('027-000')).toBe('FIN101');
    expect(estado.atual.pendentes).toEqual([]);
  });

  it('recusa no PinPad: nada a confirmar, o PDV vê "recusado"', async () => {
    const { executor } = await instalar('recusa');
    const txId = await cobrarNoPdv();
    await executor.passo(0);
    expect(tx(txId)?.status).toBe('declined');
    expect(gp!.recebidos.map((c) => c.get('000-000')).filter((o) => o !== 'ATV')).toEqual(['CRT']);
  });

  it('o servidor recusa o resultado (a cobrança já tinha desfecho) → o agente DESFAZ no gerenciador', async () => {
    const { executor, estado } = await instalar('aprova');
    const txId = await cobrarNoPdv();
    // O agente devolve o resultado de um comando que o servidor não reconhece
    // (404): o ERP não vai registrar esse dinheiro, então o gerenciador desfaz.
    await executor.executar({
      id: 'ptcmd-que-nao-existe',
      command: 'startPayment',
      transactionId: txId,
      payload: { amountInCents: 8900, paymentMethod: 'credit', reference: 'X' },
      redelivery: false,
    });
    const ops = gp!.recebidos.map((c) => c.get('000-000')).filter((o) => o !== 'ATV');
    expect(ops).toEqual(['CRT', 'NCN']);
    expect(estado.atual.pendentes).toEqual([]);
  });

  it('caiu no meio da cobrança: na reentrega o agente NÃO cobra de novo — responde "não confirmada"', async () => {
    const { executor, estado, cliente } = await instalar('aprova');
    const txId = await cobrarNoPdv();
    const [cmd] = await cliente.comandos(0); // retirou…
    estado.gravar({ emAndamento: cmd.id, pendentes: [], feitos: [] }); // …e caiu no meio do PinPad
    const reentrega = await cliente.comandos(0);
    expect(reentrega[0]).toMatchObject({ id: cmd.id, redelivery: true });
    await executor.executar(reentrega[0]);
    expect(tx(txId)?.status).toBe('timeout_uncertain');
    expect(gp!.recebidos.filter((c) => c.get('000-000') === 'CRT')).toHaveLength(0);
  });

  it('cancelamento pedido na tela passa pelo agente: CNC no gerenciador, CNF, e a cobrança vira cancelada', async () => {
    const { executor } = await instalar('aprova');
    const txId = await cobrarNoPdv(8900);
    await executor.passo(0);
    const pedido = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${txId}/cancel`)
      .set(gerenteAuth)
      .send({ reason: 'cliente desistiu' });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(202);
    await executor.passo(0);
    expect(tx(txId)?.status).toBe('cancelled');
    const cnc = gp!.recebidos.find((c) => c.get('000-000') === 'CNC')!;
    expect(Object.fromEntries(cnc)).toMatchObject({ '003-000': '8900', '010-000': 'STONE', '012-000': '000101' });
    const ops = gp!.recebidos.map((c) => c.get('000-000')).filter((o) => o !== 'ATV');
    expect(ops).toEqual(['CRT', 'CNF', 'CNC', 'CNF']);
  });
});

describe('a linha de comando', () => {
  it('lê os argumentos do pareamento', () => {
    expect(lerArgumentos(['parear', '--servidor', 'https://erp/api/v1', '--codigo', 'A1B2C3D4', '--pix'])).toEqual({
      comando: 'parear',
      opcoes: { servidor: 'https://erp/api/v1', codigo: 'A1B2C3D4', pix: true },
    });
  });
});
