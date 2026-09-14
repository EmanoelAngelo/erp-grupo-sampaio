/**
 * A HOMOLOGAÇÃO DO ASAAS GANHA PORTA — rodada 62.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO NA TELA DO DONO
 * ============================================================================
 *
 * A tela de integrações lista as travas que impedem cobrar de verdade, e uma
 * delas é "a homologação em sandbox ainda não foi concluída". O dono abriu
 * essa tela, cumpriu tudo que podia — chave sandbox, chave produção, conexão
 * testada, pedido de produção registrado — e ficou parado nessa trava, sem
 * nenhum botão que a abrisse.
 *
 * O motor existia: `runAsaasSandboxHomologation` roda dezesseis passos contra
 * o sandbox (cliente, PIX, QR, boleto, linha digitável, checkout,
 * idempotência, contas a receber, conciliação, webhook…). O que não existia
 * era o caminho até ele:
 *
 *   - a rota `POST /integrations/:provider/homologate` exige a permissão
 *     `integrations.homologate`, e a matriz declara
 *     `integrations: { ler: [], escrever: [] }` — NENHUM perfil a tem;
 *   - nenhuma tela chamava qualquer uma das duas.
 *
 * Ou seja: código correto, inalcançável por qualquer pessoa. É a mesma
 * família do `statusServico` da rodada 58 — a terceira e a quarta vez que
 * esta base entrega motor sem porta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);

const app = createApp();
const SENHA = 'Teste@Homolog2026';

let precoJusto: string;
let gringa: string;
let gestor: { Authorization: string };
let gestorGringa: { Authorization: string };
let caixa: { Authorization: string };

async function ator(login: string, profile: string, company: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(id, company, profile, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** O resultado que o motor devolve quando tudo passa. */
function resultadoBom() {
  return {
    status: 'passed',
    sandboxHomologated: true,
    steps: [
      { key: 'credential', label: 'Credencial Sandbox', category: 'CONFIGURAÇÃO', status: 'success' },
      { key: 'pix_charge', label: 'Cobrança PIX', category: 'PIX', status: 'success' },
      { key: 'webhook_local', label: 'Webhook local', category: 'WEBHOOK', status: 'success' },
    ],
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'PRECO JUSTO COMERCIO DE VARIEDADES LTDA',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  gestor = await ator('gestor-pj', 'gerente_loja', precoJusto);
  gestorGringa = await ator('gestor-gringa', 'gerente_loja', gringa);
  caixa = await ator('caixa-pj', 'operador_caixa', precoJusto);
});

// ============================================================================

describe('o gestor alcança a homologação', () => {
  it('o gerente da loja dispara e recebe os passos com o resultado de cada um', async () => {
    const mod = await import('../src/services/integrations/AsaasHomologationService.js');
    vi.spyOn(mod, 'runAsaasSandboxHomologation').mockResolvedValue(resultadoBom() as never);

    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/homologar')
      .set(gestor)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('passed');
    /*
      Os PASSOS voltam, e não só um "ok". Dezesseis coisas são exercitadas
      contra o sandbox; quando uma falha, é o passo que diz qual — sem isso a
      tela só saberia dizer "não passou", que não ajuda ninguém a consertar.
    */
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThan(0);
    expect(res.body.steps[0]).toHaveProperty('label');
    expect(res.body.steps[0]).toHaveProperty('status');
    vi.restoreAllMocks();
  });

  it('o caixa não homologa — é configuração, não operação de balcão', async () => {
    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/homologar')
      .set(caixa)
      .send({});

    expect(res.status).toBe(403);
  });

  it('a empresa vem do TOKEN, nunca do corpo', async () => {
    const mod = await import('../src/services/integrations/AsaasHomologationService.js');
    const espiao = vi
      .spyOn(mod, 'runAsaasSandboxHomologation')
      .mockResolvedValue(resultadoBom() as never);

    /*
      Aceitar `companyId` do corpo deixaria o gestor da Gringa homologar a
      Preço Justo sabendo o id — e homologação carimba estado que libera
      cobrança de verdade.
    */
    await request(app)
      .post('/api/v1/core/integrations/asaas/homologar')
      .set(gestorGringa)
      .send({ companyId: precoJusto });

    expect(espiao).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: gringa }),
    );
    vi.restoreAllMocks();
  });

  it('a falha do motor chega à tela com o motivo, não como erro genérico', async () => {
    const mod = await import('../src/services/integrations/AsaasHomologationService.js');
    vi.spyOn(mod, 'runAsaasSandboxHomologation').mockResolvedValue({
      status: 'failed',
      sandboxHomologated: false,
      steps: [
        { key: 'credential', label: 'Credencial Sandbox', category: 'CONFIGURAÇÃO', status: 'success' },
        {
          key: 'pix_charge',
          label: 'Cobrança PIX',
          category: 'PIX',
          status: 'failed',
          detail: 'O Asaas recusou: valor mínimo não atingido.',
        },
      ],
    } as never);

    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/homologar')
      .set(gestor)
      .send({});

    /*
      200 com `status: 'failed'`: a homologação RODOU e o resultado é que ela
      não passou. Devolver erro faria a tela dizer "não foi possível
      homologar", escondendo QUAL passo falhou — que é a única informação que
      permite consertar.
    */
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    const passoRuim = res.body.steps.find((s: { key: string }) => s.key === 'pix_charge');
    expect(passoRuim.status).toBe('failed');
    expect(passoRuim.detail).toContain('valor mínimo');
    vi.restoreAllMocks();
  });

  it('a homologação fica na trilha de auditoria', async () => {
    const mod = await import('../src/services/integrations/AsaasHomologationService.js');
    vi.spyOn(mod, 'runAsaasSandboxHomologation').mockResolvedValue(resultadoBom() as never);

    await request(app)
      .post('/api/v1/core/integrations/asaas/homologar')
      .set(gestor)
      .send({});

    const { getConnection } = await import('../src/db/sqlite.js');
    const trilha = getConnection()
      .prepare(`SELECT * FROM core_audit_log WHERE action LIKE 'integrations.asaas.homolog%'`)
      .all() as Record<string, unknown>[];

    // Homologar carimba o estado que libera cobrar de verdade: quem fez, e
    // quando, é pergunta que o contador pode fazer.
    expect(trilha.length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});
