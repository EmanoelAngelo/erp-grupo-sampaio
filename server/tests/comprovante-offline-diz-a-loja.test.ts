/**
 * O COMPROVANTE OFFLINE DIZ A LOJA (auditoria PJ, trilha "documentos",
 * F-cupom-fiscal-20#reauditoria).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * Com o servidor fora do ar, o PDV monta sozinho o comprovante não fiscal da
 * venda guardada. Ele saía só com o nome fantasia — `session.company.tradeName`
 * —, porque a sessão do navegador não conhece CNPJ nem endereço e nenhuma
 * resposta do servidor os entregava. O cliente levava um papel que não dizia
 * de qual CNPJ comprou nem para onde voltar para trocar a peça.
 *
 * Agora GET /core/print/drawer — a pergunta que o PDV já faz e guarda enquanto
 * o servidor responde, por causa da largura da bobina — traz também a `loja`:
 * nome, CNPJ, endereço e telefone, pela MESMA leitura do cabeçalho do cupom
 * (`empresaDoPapel`). Duas leituras fariam os dois papéis discordarem.
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
import { empresaDoPapel } from '../src/services/core/PrintRenderer.js';

process.env.DEVORA_JWT_SECRET = 'comprovante-offline-loja-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'comprovante-offline-loja-teste-chave-de-cifra-comprida';

const app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'ComprovanteLoja@2026';

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

/** Endereço e telefone moram no cadastro fiscal — é de lá que o cupom os lê. */
function comEnderecoFiscal() {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_configs
         (company_id, street, number, district, city_name, uf, phone, updated_at)
       VALUES (?, 'Rua das Palmeiras', '128', 'Centro', 'Macapá', 'AP', '(96) 99999-1234', '2026-08-01T00:00:00.000Z')`,
    )
    .run(empresa);
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
  empresa = upsertCompany({ slug: 'preco-justo-offline', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  // CNPJ gravado em formato MISTO: o papel tem de sair pela régua do cupom.
  getConnection().prepare('UPDATE core_companies SET cnpj = ? WHERE id = ?').run('12.345678/0001-90', empresa);
  gerente = await login('GERENTE.OFFLINE', 'gerente_loja');
  caixa = await login('CAIXA.OFFLINE', 'operador_caixa_loja');
});

describe('F-cupom-fiscal-20 — GET /print/drawer entrega a loja do comprovante offline', () => {
  it('com cadastro fiscal: nome, CNPJ formatado, endereço e telefone — o que o caixa guarda para o papel offline', async () => {
    comEnderecoFiscal();

    const r = await gaveta();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Antes: o campo não existia, e o comprovante offline dizia só "Preço Justo".
    expect(r.body.loja).toEqual({
      nome: 'Preço Justo',
      cnpj: '12.345.678/0001-90',
      endereco: 'Rua das Palmeiras, 128 — Centro · Macapá · AP',
      telefone: '(96) 99999-1234',
    });
    // A gaveta e a largura continuam as mesmas de antes.
    expect(r.body.byCommand).toBe(false);
    expect(r.body.paperWidthMm).toBe(80);
  });

  it('sem cadastro fiscal ainda: nome e CNPJ vão, endereço e telefone vêm nulos — como no cupom', async () => {
    const r = await gaveta();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.loja).toEqual({ nome: 'Preço Justo', cnpj: '12.345.678/0001-90', endereco: null, telefone: null });
  });

  it('é a MESMA leitura do cabeçalho do cupom — os dois papéis dizem a mesma loja', () => {
    comEnderecoFiscal();
    const doCupom = empresaDoPapel(empresa);
    expect(prontidaoDaGaveta(empresa).loja).toEqual({
      nome: doCupom.trade_name,
      cnpj: doCupom.cnpj,
      endereco: doCupom.endereco,
      telefone: doCupom.phone,
    });
  });

  it('pelo AGENTE no ar (a outra resposta da gaveta), a loja vem junto também', async () => {
    comEnderecoFiscal();
    const cx = 'cx-of1';
    getConnection()
      .prepare(`INSERT INTO core_terminals (id, company_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run(cx, empresa, 'CX-OF1', 'Caixa 1', new Date().toISOString());
    const codigo = await request(app)
      .post('/api/v1/payment-terminals/local-agent/pairing')
      .set(gerente)
      .send({ pdvTerminalId: cx });
    expect(codigo.status, JSON.stringify(codigo.body)).toBeLessThan(300);
    const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.1.0', hostname: 'CAIXA' }, buscar);
    const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
    await cliente.sinal({ version: '1.1.0', hostname: 'CAIXA', health: {} });
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
    expect(r.body.loja).toMatchObject({ nome: 'Preço Justo', cnpj: '12.345.678/0001-90' });
  });
});
