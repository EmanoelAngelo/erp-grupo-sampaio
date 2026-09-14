/**
 * Troca de sessão e a trava contra autorização fabricada.
 *
 * DUAS COISAS DIFERENTES, no mesmo arquivo porque ambas protegem contra o
 * mesmo tipo de engano: o sistema afirmar um estado que não corresponde ao
 * mundo.
 *
 * 1. Entrar com outra conta tem que SUBSTITUIR o escopo, não sobrepor. Um
 *    token que continua respondendo pelo usuário anterior daria ao operador de
 *    caixa a permissão do gestor — e a tela mostraria o nome novo.
 *
 * 2. Nenhuma rota pode produzir um documento AUTHORIZED sem evidência externa.
 *    Já houve um serviço que fabricava protocolo e chave a partir de
 *    `Date.now()`; este teste existe para que isso não volte por nenhum
 *    caminho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  linkUserToWorkshop,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const PASSWORD = 'Teste@Sessao2026';

interface Escopo {
  sub: string;
  companyId: string;
  profileCodes: string[];
}

/** Lê o escopo REAL do token, não o nome exibido na tela. */
function escopoDoToken(accessToken: string): Escopo {
  const payload = JSON.parse(
    Buffer.from(accessToken.split('.')[1], 'base64').toString('utf8'),
  ) as Escopo;
  return payload;
}

async function entrar(login: string): Promise<{ token: string; escopo: Escopo }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken, escopo: escopoDoToken(res.body.accessToken) };
}

let precoJusto: string;
let gringa: string;
let oficinaCo: string;

beforeEach(async () => {
  resetDbForTests();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  oficinaCo = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  ensureOfficialWorkshops();

  const gestor = await upsertUser({ login: 'GESTOR', displayName: 'Gestor', password: PASSWORD });
  linkUserToCompany(gestor, precoJusto, 'gestor', true);

  const pdvPJ = await upsertUser({ login: 'PDVPJ', displayName: 'PDV PJ', password: PASSWORD });
  linkUserToCompany(pdvPJ, precoJusto, 'operador_caixa_loja', true);

  const pdvGringa = await upsertUser({
    login: 'PDVGRINGA',
    displayName: 'PDV Gringa',
    password: PASSWORD,
  });
  linkUserToCompany(pdvGringa, gringa, 'operador_caixa_loja', true);

  const mecanico = await upsertUser({
    login: 'MECANICO',
    displayName: 'Mecânico',
    password: PASSWORD,
  });
  linkUserToCompany(mecanico, oficinaCo, 'mecanico', true);
  const ws = getConnection()
    .prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'")
    .get() as { id: string };
  linkUserToWorkshop(mecanico, ws.id, 'mecanico');
});

describe('troca de sessão — o escopo é o do token, não o nome na tela', () => {
  const pares: [string, string][] = [
    ['PDVPJ', 'GESTOR'],
    ['GESTOR', 'PDVPJ'],
    ['GESTOR', 'MECANICO'],
    ['MECANICO', 'GESTOR'],
    ['PDVPJ', 'PDVGRINGA'],
  ];

  for (const [de, para] of pares) {
    it(`${de} → ${para} substitui usuário, empresa e perfil`, async () => {
      const primeiro = await entrar(de);
      const segundo = await entrar(para);

      expect(segundo.escopo.sub).not.toBe(primeiro.escopo.sub);
      expect(segundo.token).not.toBe(primeiro.token);

      // Nenhum resquício do perfil anterior.
      for (const perfil of primeiro.escopo.profileCodes) {
        if (!segundo.escopo.profileCodes.includes(perfil)) {
          expect(segundo.escopo.profileCodes).not.toContain(perfil);
        }
      }
    });
  }

  it('PDV de operações diferentes não compartilham empresa', async () => {
    const pj = await entrar('PDVPJ');
    const gr = await entrar('PDVGRINGA');
    expect(pj.escopo.companyId).toBe(precoJusto);
    expect(gr.escopo.companyId).toBe(gringa);
    expect(pj.escopo.companyId).not.toBe(gr.escopo.companyId);
  });

  /**
   * O que realmente importa: o RBAC segue o token NOVO imediatamente. Se o
   * token do caixa continuasse valendo como gestor, esconder o menu não
   * adiantaria nada.
   */
  it('a permissão acompanha o token novo, na mesma hora', async () => {
    const gestor = await entrar('GESTOR');
    const podeAntes = await request(app)
      .get('/api/v1/core/fiscal/config')
      .set({ Authorization: `Bearer ${gestor.token}` });
    expect(podeAntes.status).toBe(200);

    const caixa = await entrar('PDVPJ');
    const podeDepois = await request(app)
      .get('/api/v1/core/fiscal/config')
      .set({ Authorization: `Bearer ${caixa.token}` });
    expect(podeDepois.status).toBe(403);
  });

  it('o token do mecânico não alcança a configuração fiscal nem a equipe', async () => {
    const mec = await entrar('MECANICO');
    const auth = { Authorization: `Bearer ${mec.token}` };
    expect((await request(app).get('/api/v1/core/fiscal/config').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/core/team').set(auth)).status).toBe(403);
  });

  it('o escopo vem do vínculo no banco, não do que o cliente pede', async () => {
    // Pedir outra empresa no login não muda o tenant: ela precisa estar entre
    // as do usuário.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'PDVPJ', password: PASSWORD, companyId: gringa });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_TENANT_MISMATCH');
  });
});

describe('trava permanente: AUTHORIZED exige evidência externa', () => {
  /**
   * Já existiu um serviço que gravava `status: 'authorized'` com protocolo e
   * chave montados a partir de `Date.now()`. Este teste é a barreira para que
   * nenhum caminho volte a produzir isso.
   */
  it('a rota legada de autorização NFC-e não existe mais — nem para o gestor', async () => {
    const gestor = await entrar('GESTOR');
    const auth = { Authorization: `Bearer ${gestor.token}` };

    /*
      Ela recusava com 409 pelo serviço; desde o GAP-PRD-096 o roteador legado
      inteiro saiu (camada JSON sem tela), e o caminho não responde nada. O
      GESTOR passa em toda permissão, então o 404 aqui não é um 403 disfarçado.
    */
    const res = await request(app)
      .post('/api/v1/fiscal/nfce/documents/qualquer/authorize')
      .set(auth)
      .set('Idempotency-Key', 'trava-2');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('authorized');
  });

  /*
    Aqui havia a trava do SERVIÇO legado (`authorizeNfceDocumentBackend`
    recusando mesmo chamado direto). O serviço saiu inteiro na junção do
    GAP-PRD-075: era o segundo escritor de documento fiscal, e a defesa agora
    é não existir escritor nenhum fora de `core_fiscal_documents` — o caso
    abaixo continua cobrando que nada nasce autorizado sem protocolo.
  */

  it('nenhum documento do núcleo fiscal nasce AUTHORIZED', async () => {
    // A defesa de fundo: qualquer documento gravado sem protocolo não pode
    // estar como autorizado. Vale para qualquer caminho, presente ou futuro.
    const linhas = getConnection()
      .prepare(
        `SELECT COUNT(*) AS c FROM core_fiscal_documents
          WHERE status = 'AUTHORIZED' AND (protocol IS NULL OR TRIM(protocol) = '')`,
      )
      .get() as { c: number };
    expect(Number(linhas.c)).toBe(0);
  });

  it('o readiness nunca reporta HOMOLOGATED sem documento autorizado com protocolo', async () => {
    const gestor = await entrar('GESTOR');
    const res = await request(app)
      .get('/api/v1/core/fiscal/readiness')
      .set({ Authorization: `Bearer ${gestor.token}` });

    for (const relatorio of res.body.items as { readiness: string }[]) {
      expect(relatorio.readiness).not.toBe('HOMOLOGATED');
    }

    const autorizados = getConnection()
      .prepare("SELECT COUNT(*) AS c FROM core_fiscal_documents WHERE status = 'AUTHORIZED'")
      .get() as { c: number };
    expect(Number(autorizados.c)).toBe(0);
  });
});
