/**
 * ============================================================================
 * O PROGRAMA DO AGENTE LOCAL IMPRIMINDO NA TÉRMICA (GAP-PRD-082)
 * ============================================================================
 *
 * O lado do computador do caixa: o endereço conferido antes de escrever, os
 * bytes chegando inteiros numa "impressora de rede" de mentira (um socket na
 * porta 19305, a faixa desta frente), e o impressor de ponta a ponta contra o
 * app em memória — imprime uma vez, conta a falha com o motivo, e não imprime
 * de novo quando só a volta do resultado falhou.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { lerDestinoDaImpressora, type DestinoDaImpressora } from '../src/services/core/destinoDaImpressora.js';
import { ClienteDoServidor, parearComOServidor, type Buscador } from '../src/local-agent/ClienteDoServidor.js';
import { ImpressorDoAgente } from '../src/local-agent/ImpressorDoAgente.js';
import { escreverPorTcp, imprimirNoDestino, type EscritorDeImpressora } from '../src/local-agent/PonteImpressora.js';
import { PonteSemTef } from '../src/local-agent/PonteSemTef.js';
import type { PonteTef } from '../src/local-agent/PonteTef.js';
import { configuracaoDoPareamento, lerArgumentos } from '../src/local-agent/main.js';

process.env.DEVORA_JWT_SECRET = 'agente-impressora-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'agente-impressora-teste-chave-de-cifra-bem-comprida';

const app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'AgenteImpressora@2026';
/** A faixa da frente PAG (19300–19310): a "impressora de rede" do teste. */
const PORTA_DA_IMPRESSORA = 19305;

let falharResultado = 0;
const buscar: Buscador = async (url, init) => {
  const u = new URL(url);
  const caminho = `${u.pathname}${u.search}`;
  if (falharResultado > 0 && caminho.includes('/print-jobs/') && caminho.endsWith('/result')) {
    falharResultado -= 1;
    throw new TypeError('rede caiu na volta do resultado');
  }
  const base = init.method === 'GET' ? request(app).get(caminho) : request(app).post(caminho);
  const pedido = base.set(init.headers);
  const res = init.body === undefined ? await pedido : await pedido.send(init.body);
  return { status: res.status, json: async () => res.body as unknown };
};

describe('o endereço da impressora', () => {
  it('aceita os quatro formatos das térmicas', () => {
    expect(lerDestinoDaImpressora('tcp:192.168.0.50:9100')).toMatchObject({ ok: true, destino: { tipo: 'tcp', porta: 9100 } });
    expect(lerDestinoDaImpressora('com3')).toMatchObject({ ok: true, destino: { tipo: 'serial', endereco: 'COM3', caminho: '\\\\.\\COM3' } });
    expect(lerDestinoDaImpressora('LPT1')).toMatchObject({ ok: true, destino: { tipo: 'paralela' } });
    expect(lerDestinoDaImpressora('\\\\CAIXA1\\CUPOM')).toMatchObject({ ok: true, destino: { tipo: 'compartilhamento' } });
  });

  it('recusa tudo que não é impressora — arquivo do sistema, subpasta, disco cru, porta impossível', () => {
    for (const ruim of [
      'C:\\Windows\\system32\\drivers\\etc\\hosts',
      '\\\\CAIXA1\\CUPOM\\..\\..\\Windows',
      '\\\\.\\PhysicalDrive0',
      'tcp:192.168.0.50:70000',
      'arquivo.txt',
      '',
    ]) {
      expect(lerDestinoDaImpressora(ruim).ok, ruim).toBe(false);
    }
  });

  it('o agente confere de novo antes de escrever: endereço ruim não escreve nada', async () => {
    const escritos: string[] = [];
    const escritor: EscritorDeImpressora = { escrever: async (d) => void escritos.push(d.endereco) };
    await expect(imprimirNoDestino('C:\\Windows\\win.ini', Uint8Array.from([1]), escritor)).rejects.toThrow(/não reconhecido/);
    expect(escritos).toHaveLength(0);
  });
});

describe('a impressora de rede (socket cru)', () => {
  let impressora: Server;
  let recebido: Buffer;

  beforeEach(async () => {
    recebido = Buffer.alloc(0);
    impressora = createServer((s) => {
      s.on('data', (b: Buffer) => {
        recebido = Buffer.concat([recebido, b]);
      });
    });
    await new Promise<void>((r) => impressora.listen(PORTA_DA_IMPRESSORA, '127.0.0.1', () => r()));
  });

  afterEach(async () => {
    await new Promise<void>((r) => impressora.close(() => r()));
  });

  it('os bytes chegam inteiros, na ordem', async () => {
    const bytes = Uint8Array.from([0x1b, 0x40, 0x41, 0x42, 0x1b, 0x70, 0, 25, 250, 0x1d, 0x56, 0x42, 0]);
    await escreverPorTcp('127.0.0.1', PORTA_DA_IMPRESSORA, bytes);
    await new Promise((r) => setTimeout(r, 50));
    expect([...recebido]).toEqual([...bytes]);
  });

  it('impressora desligada vira erro com o endereço, e não um "impresso"', async () => {
    await expect(escreverPorTcp('127.0.0.1', PORTA_DA_IMPRESSORA + 1, Uint8Array.from([1]), 2000)).rejects.toThrow(
      /Não foi possível falar com a impressora em 127\.0\.0\.1:19306/,
    );
  });
});

describe('o impressor do agente, de ponta a ponta com o servidor', () => {
  let loja: string;
  let gerente: { Authorization: string };
  let caixaAuth: { Authorization: string };
  let caixaId: string;
  let escritos: { destino: DestinoDaImpressora; bytes: Buffer }[];
  let falhaDaImpressora: string | null;
  const escritor: EscritorDeImpressora = {
    escrever: async (destino, bytes) => {
      if (falhaDaImpressora) throw new Error(falhaDaImpressora);
      escritos.push({ destino, bytes: Buffer.from(bytes) });
    },
  };

  async function login(l: string, perfil: string) {
    const userId = await upsertUser({ login: l, displayName: l, password: SENHA });
    linkUserToCompany(userId, loja, perfil, true);
    const r = await request(app).post('/api/v1/auth/login').send({ login: l, password: SENHA, companyId: loja });
    expect(r.status).toBe(200);
    return { Authorization: `Bearer ${r.body.accessToken as string}` };
  }

  async function instalar(): Promise<ImpressorDoAgente> {
    const c = await request(app).post('/api/v1/core/terminals').set(gerente).send({ name: 'Caixa 1' });
    caixaId = c.body.id;
    const codigo = await request(app)
      .post('/api/v1/payment-terminals/local-agent/pairing')
      .set(gerente)
      .send({ pdvTerminalId: caixaId });
    const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.1.0', hostname: 'CAIXA1' }, buscar);
    const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
    await cliente.sinal({ version: '1.1.0', hostname: 'CAIXA1', health: {} });
    const impressora = await request(app).post('/api/v1/core/print/printers').set(gerente).send({
      name: 'Térmica 58',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 58,
      isDefault: true,
      pdvTerminalId: caixaId,
      agentDevice: 'COM3',
    });
    expect(impressora.status, JSON.stringify(impressora.body)).toBe(201);
    return new ImpressorDoAgente(cliente, { escritor });
  }

  async function cupomDeVenda(): Promise<string> {
    const p = await request(app).post('/api/v1/core/products').set(gerente).send({ name: 'Boné', priceCents: 3500 });
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: 3,
      referenceType: 'entrada',
      referenceId: `carga-${randomUUID()}`,
    });
    const g = await request(app).post('/api/v1/core/cash/open').set(caixaAuth).send({ openingCents: 0, terminalId: caixaId });
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(caixaAuth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId: p.body.id, quantity: 1, unitPriceCents: 3500 }],
        payments: [{ method: 'dinheiro', amountCents: 3500 }],
        cashSessionId: g.body.id,
        terminalId: caixaId,
      });
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixaAuth)
      .send({ documentType: 'SALE_RECEIPT', documentId: v.body.id, terminalId: caixaId, openDrawer: true });
    expect(job.body.transport).toBe('agent');
    return job.body.id as string;
  }

  const statusDo = (id: string) =>
    (getConnection().prepare('SELECT status, error FROM core_print_jobs WHERE id = ?').get(id) as { status: string; error: string | null });

  beforeEach(async () => {
    process.env.DEVORA_API_ENV = 'test';
    resetEnvCacheForTests();
    resetDbForTests();
    escritos = [];
    falhaDaImpressora = null;
    falharResultado = 0;
    loja = upsertCompany({ slug: 'gringa-imp', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    gerente = await login('GERENTE.AGIMP', 'gerente_loja');
    caixaAuth = await login('CAIXA.AGIMP', 'operador_caixa_loja');
  });

  it('retira, escreve na porta do cupom em 32 colunas com o pulso, e o servidor marca impresso', async () => {
    const impressor = await instalar();
    const jobId = await cupomDeVenda();
    expect(await impressor.passo(0)).toBe(1);
    expect(escritos).toHaveLength(1);
    expect(escritos[0].destino).toMatchObject({ tipo: 'serial', caminho: '\\\\.\\COM3' });
    const texto = escritos[0].bytes.toString('latin1');
    expect(texto).toContain('Bone');
    expect(texto).toContain(`${'-'.repeat(32)}\n`);
    expect(texto).not.toContain('-'.repeat(33));
    expect(texto).toContain('\x1b\x70\x00');
    expect(statusDo(jobId).status).toBe('printed');
  });

  it('impressora sem papel: o job vai a falha com o motivo, e a trilha registra', async () => {
    const impressor = await instalar();
    const jobId = await cupomDeVenda();
    falhaDaImpressora = 'sem papel';
    await impressor.passo(0);
    expect(statusDo(jobId)).toMatchObject({ status: 'failed' });
    expect(statusDo(jobId).error).toMatch(/Falha ao imprimir em "Térmica 58" \(COM3\): sem papel/);
    const trilha = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'print.job.agent_failed' AND entity_id = ?`)
      .get(jobId) as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('a volta do resultado falhou: o cupom NÃO sai de novo, e o resultado chega no passo seguinte', async () => {
    const impressor = await instalar();
    const jobId = await cupomDeVenda();
    falharResultado = 1;
    await impressor.passo(0);
    expect(escritos).toHaveLength(1);
    expect(impressor.resultadosPendentes).toBe(1);
    expect(statusDo(jobId).status).toBe('printing');

    await impressor.passo(0);
    expect(escritos).toHaveLength(1);
    expect(impressor.resultadosPendentes).toBe(0);
    expect(statusDo(jobId).status).toBe('printed');
  });
});

describe('o agente que só imprime', () => {
  it('--sem-tef grava a configuração sem gerenciador, e a ponte recusa cobrar', async () => {
    const { opcoes } = lerArgumentos(['parear', '--servidor', 'https://erp/api/v1', '--codigo', 'AB12CD34', '--sem-tef']);
    const config = configuracaoDoPareamento(opcoes, { agentId: 'a1', segredo: 's', pdvTerminalId: 'cx1' }, 'C:\\agente\\devora-agente.json');
    expect(config.ponte).toEqual({ tipo: 'nenhuma' });
    expect(config.arquivoDeEstado).toBe('C:\\agente\\devora-agente.json.estado');

    const ponte: PonteTef = new PonteSemTef();
    expect(await ponte.saude()).toMatchObject({ tefClient: 'unavailable', bridge: 'nenhuma' });
    expect(await ponte.cobrar({ referencia: '1', documento: '1', valorEmCentavos: 100, metodo: 'credit', parcelas: 1 })).toMatchObject({
      status: 'failed',
    });

    const comTef = configuracaoDoPareamento(
      lerArgumentos(['parear', '--servidor', 'x', '--codigo', 'y']).opcoes,
      { agentId: 'a1', segredo: 's', pdvTerminalId: null },
      'c.json',
    );
    expect(comTef.ponte).toMatchObject({ tipo: 'tef_dial', dirReq: 'C:\\TEF_DIAL\\REQ' });
  });
});
