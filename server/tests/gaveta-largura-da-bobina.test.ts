/**
 * A LARGURA DA BOBINA NA PRONTIDÃO DA GAVETA (auditoria PJ, trilha "documentos",
 * PED-pdv-01#largura).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * O PDV monta sozinho o comprovante da venda offline (servidor fora do ar) e
 * escolhe a largura dele pelo `paperWidthMm` de GET /core/print/drawer — que
 * ele lê e guarda enquanto o servidor responde. Mas `prontidaoDaGaveta` só
 * olhava a impressora de AGENTE e não devolvia largura nenhuma: o caixa com
 * térmica de 58 mm pelo navegador (o caso comum, sem agente) imprimia o
 * comprovante offline em 80 mm, cortado.
 *
 * Agora a resposta traz a bobina do CUPOM deste caixa, em qualquer transporte,
 * pela mesma escolha da fila (a do caixa antes da da operação, a padrão
 * primeiro) e pela mesma régua do papel do servidor (sem medida, 80).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { ClienteDoServidor, parearComOServidor, type Buscador } from '../src/local-agent/ClienteDoServidor.js';
import { prontidaoDaGaveta } from '../src/services/core/EscPos.js';
import { upsertPrinter } from '../src/services/core/PrintEngine.js';

process.env.DEVORA_JWT_SECRET = 'gaveta-largura-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'gaveta-largura-teste-chave-de-cifra-bem-comprida';

const app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'GavetaLargura@2026';

const buscar: Buscador = async (url, init) => {
  const u = new URL(url);
  const caminho = `${u.pathname}${u.search}`;
  const base = init.method === 'GET' ? request(app).get(caminho) : request(app).post(caminho);
  const pedido = base.set(init.headers);
  const res = init.body === undefined ? await pedido : await pedido.send(init.body);
  return { status: res.status, json: async () => res.body as unknown };
};

type Auth = { Authorization: string };
let empresa: string;
let gerente: Auth;
let caixa: Auth;

async function login(l: string, perfil: string): Promise<Auth> {
  const userId = await upsertUser({ login: l, displayName: l, password: SENHA });
  linkUserToCompany(userId, empresa, perfil, true);
  const r = await request(app).post('/api/v1/auth/login').send({ login: l, password: SENHA, companyId: empresa });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

function novoCaixa(id: string, nome: string): string {
  getConnection()
    .prepare(`INSERT INTO core_terminals (id, company_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(id, empresa, `CX-${id}`, nome, new Date().toISOString());
  return id;
}

/** O gerente gera o código para o caixa; o PROGRAMA pareia e manda o primeiro sinal. */
async function instalarAgente(caixaId: string): Promise<void> {
  const codigo = await request(app)
    .post('/api/v1/payment-terminals/local-agent/pairing')
    .set(gerente)
    .send({ pdvTerminalId: caixaId });
  expect(codigo.status, JSON.stringify(codigo.body)).toBeLessThan(300);
  const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.1.0', hostname: 'CAIXA' }, buscar);
  const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
  await cliente.sinal({ version: '1.1.0', hostname: 'CAIXA', health: {} });
}

const gaveta = (terminalId?: string) =>
  request(app)
    .get(terminalId ? `/api/v1/core/print/drawer?terminalId=${terminalId}` : '/api/v1/core/print/drawer')
    .set(caixa);

beforeEach(async () => {
  process.env.DEVORA_API_ENV = 'test';
  resetEnvCacheForTests();
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({ slug: 'preco-justo-largura', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  gerente = await login('GERENTE.LARGURA', 'gerente_loja');
  caixa = await login('CAIXA.LARGURA', 'operador_caixa_loja');
});

describe('PED-pdv-01#largura — GET /print/drawer diz a bobina do cupom deste caixa', () => {
  it('térmica de 58 mm pelo NAVEGADOR, sem agente nenhum: a resposta diz 58', async () => {
    upsertPrinter({ companyId: empresa, name: 'Térmica 58', kind: 'cupom', transport: 'browser', paperWidthMm: 58, isDefault: true });

    const r = await gaveta();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A gaveta continua honesta: sem agente, sem comando.
    expect(r.body.byCommand).toBe(false);
    // Antes: o campo não existia, e o comprovante offline saía em 80 mm, cortado.
    expect(r.body.paperWidthMm).toBe(58);
  });

  it('sem impressora de cupom (só etiqueta), vale 80 — o mesmo padrão do papel do servidor', async () => {
    // A etiqueta de 40 mm não é a bobina do cupom.
    upsertPrinter({ companyId: empresa, name: 'Etiquetas', kind: 'etiqueta', paperWidthMm: 40, isDefault: true });

    const r = await gaveta();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.paperWidthMm).toBe(80);
  });

  it('a do caixa antes da da operação: o Caixa 1 tem 58, o Caixa 2 usa a da loja (80)', async () => {
    const cx1 = novoCaixa('cx-l1', 'Caixa 1');
    const cx2 = novoCaixa('cx-l2', 'Caixa 2');
    upsertPrinter({ companyId: empresa, name: 'Térmica 80 da loja', kind: 'cupom', paperWidthMm: 80, isDefault: true });
    upsertPrinter({ companyId: empresa, name: 'Térmica 58 do Caixa 1', kind: 'cupom', paperWidthMm: 58, pdvTerminalId: cx1 });

    expect((await gaveta(cx1)).body.paperWidthMm).toBe(58);
    expect((await gaveta(cx2)).body.paperWidthMm).toBe(80);
    // Sem caixa informado, só a da operação serve.
    expect((await gaveta()).body.paperWidthMm).toBe(80);
  });

  it('entre as da operação, a padrão vem primeiro; a desativada não conta', async () => {
    upsertPrinter({ companyId: empresa, name: 'Térmica 80 antiga', kind: 'cupom', paperWidthMm: 80 });
    upsertPrinter({ companyId: empresa, name: 'Térmica 58 nova', kind: 'cupom', paperWidthMm: 58, isDefault: true });
    expect(prontidaoDaGaveta(empresa).paperWidthMm).toBe(58);

    getConnection().prepare(`UPDATE core_printers SET active = 0 WHERE company_id = ? AND name = ?`).run(empresa, 'Térmica 58 nova');
    expect(prontidaoDaGaveta(empresa).paperWidthMm).toBe(80);
  });

  it('medida antiga gravada antes da trava do cadastro (57) passa pela mesma régua do papel: 58', () => {
    const p = upsertPrinter({ companyId: empresa, name: 'Térmica antiga', kind: 'cupom', paperWidthMm: 58, isDefault: true });
    getConnection().prepare('UPDATE core_printers SET paper_width_mm = 57 WHERE id = ?').run(p.id);
    expect(prontidaoDaGaveta(empresa).paperWidthMm).toBe(58);
  });

  it('pelo AGENTE no ar, a gaveta abre por comando e a largura vem junto', async () => {
    const cx = novoCaixa('cx-ag', 'Caixa 1');
    await instalarAgente(cx);
    upsertPrinter({
      companyId: empresa,
      name: 'Térmica 58 do balcão',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 58,
      isDefault: true,
      agentDevice: 'tcp:192.168.0.50:9100',
      pdvTerminalId: cx,
    });

    const r = await gaveta(cx);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ byCommand: true, agentOnline: true, paperWidthMm: 58 });
  });

  it('com agente sem impressora de cupom deste caixa, a largura ainda sai da térmica de navegador da loja', async () => {
    const cx1 = novoCaixa('cx-m1', 'Caixa 1');
    const cx2 = novoCaixa('cx-m2', 'Caixa 2');
    await instalarAgente(cx1);
    upsertPrinter({
      companyId: empresa,
      name: 'Térmica do Caixa 1',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 80,
      agentDevice: 'tcp:192.168.0.50:9100',
      pdvTerminalId: cx1,
    });
    upsertPrinter({ companyId: empresa, name: 'Térmica 58 da loja', kind: 'cupom', transport: 'browser', paperWidthMm: 58, isDefault: true });

    // O Caixa 2 não tem agente: a gaveta é pela chave, e o papel é a térmica da loja.
    const r = await gaveta(cx2);
    expect(r.body.byCommand).toBe(false);
    expect(r.body.paperWidthMm).toBe(58);
    // O Caixa 1 imprime na térmica dele, de 80.
    expect((await gaveta(cx1)).body.paperWidthMm).toBe(80);
  });
});
