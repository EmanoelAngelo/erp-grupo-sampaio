/**
 * GAP-PRD-193 — O CARRINHO MORA NA CONTA, FUNDE NO LOGIN, E A SESSÃO NÃO CAI
 * NO MEIO DA NAVEGAÇÃO.
 *
 * A auditoria achou o carrinho só no `localStorage` (trocar de aparelho
 * perdia tudo, entrar na conta não trazia o que foi montado no outro) e a
 * sessão do portal com 1 hora FIXA, sem renovação. A decisão da ficha — "se
 * a conta obrigatória vier, carrinho no servidor por conta e renovação
 * deslizante" — foi tomada: desde o GAP-PRD-028 a loja exige conta por
 * padrão. Então:
 *
 *   - GET/PUT /loja/portal/carrinho: o carrinho da conta, só produto e
 *     quantidade; preço e disponível lidos da vitrine AGORA;
 *   - POST /loja/portal/carrinho/mesclar: o login funde o carrinho do
 *     aparelho com o da conta (mesmo produto = a MAIOR quantidade);
 *   - POST /loja/portal/carrinho/itens: a página do produto acrescenta;
 *   - o pedido fechado tira da conta o que foi comprado;
 *   - a sessão desliza: cada uso empurra o vencimento (1 h sem uso derruba),
 *     até o teto absoluto de 24 h desde o login.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const BASE = '/api/v1/loja/portal';
const SENHA = 'senha-do-cliente-2026';

let gringa: string;
let n = 0;

function produto(companyId: string, preco = 10000, opcoes: { publicado?: boolean } = {}): string {
  n += 1;
  const id = `prod-carrinho-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, ?, 1, ?, ?, ?)`,
  ).run(id, companyId, `CA-${n}`, `Item ${n}`, preco, opcoes.publicado === false ? 0 : 1, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function contaNova(email = 'ana@exemplo.com'): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post(`${BASE}/registrar`)
    .send({ termsAccepted: true, email, password: SENHA, name: 'Ana' });
  expect(res.status).toBe(201);
  const accountId = res.body.account.id as string;
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string };
  confirmarEmail({ accountId, codigo: textoDeEntrega(linha.id)!.match(/é: (\d{6})/)![1] });
  return { token: res.body.token as string, accountId };
}

async function entrar(email = 'ana@exemplo.com'): Promise<string> {
  const res = await request(app).post(`${BASE}/entrar`).send({ email, password: SENHA });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const carrinho = (token: string) => request(app).get(`${BASE}/carrinho`).set('x-portal-token', token);
const trocar = (token: string, items: unknown) =>
  request(app).put(`${BASE}/carrinho`).set('x-portal-token', token).send({ items });
const mesclar = (token: string, items: unknown) =>
  request(app).post(`${BASE}/carrinho/mesclar`).set('x-portal-token', token).send({ items });

function quantidades(body: { items: { productId: string; quantity: number }[] }) {
  return Object.fromEntries(body.items.map((i) => [i.productId, i.quantity]));
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('GAP-PRD-193 — o carrinho mora na conta', () => {
  it('o que um aparelho guarda, o outro lê (dois logins da mesma conta)', async () => {
    const { token: celular } = await contaNova();
    const a = produto(gringa, 12000);
    const b = produto(gringa, 5000);

    const salvo = await trocar(celular, [
      { productId: a, quantity: 2 },
      { productId: b, quantity: 1 },
    ]);
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);

    const computador = await entrar();
    const lido = await carrinho(computador);
    expect(lido.status).toBe(200);
    expect(quantidades(lido.body)).toEqual({ [a]: 2, [b]: 1 });
    // O produto vem como a vitrine o mostra — com o preço de agora.
    expect(lido.body.items.find((i: { productId: string }) => i.productId === a).product).toMatchObject({
      id: a,
      priceCents: 12000,
      storeSlug: 'gringa',
    });
  });

  it('o carrinho não congela preço: mudou na loja, muda no carrinho', async () => {
    const { token } = await contaNova();
    const a = produto(gringa, 12000);
    await trocar(token, [{ productId: a, quantity: 1 }]);
    getConnection().prepare('UPDATE core_products SET price_cents = 9900 WHERE id = ?').run(a);
    const lido = await carrinho(token);
    expect(lido.body.items[0].product.priceCents).toBe(9900);
  });

  it('o login FUNDE: o do aparelho entra, e o mesmo produto fica com a MAIOR quantidade', async () => {
    const { token } = await contaNova();
    const a = produto(gringa);
    const b = produto(gringa);
    const c = produto(gringa);
    await trocar(token, [
      { productId: a, quantity: 3 },
      { productId: b, quantity: 1 },
    ]);

    const noOutroAparelho = await entrar();
    const fundido = await mesclar(noOutroAparelho, [
      { productId: a, quantity: 1 },
      { productId: b, quantity: 4 },
      { productId: c, quantity: 2 },
    ]);
    expect(fundido.status).toBe(200);
    expect(quantidades(fundido.body)).toEqual({ [a]: 3, [b]: 4, [c]: 2 });

    // Fundir de novo o mesmo carrinho não dobra nada.
    const deNovo = await mesclar(noOutroAparelho, [{ productId: c, quantity: 2 }]);
    expect(quantidades(deNovo.body)).toEqual({ [a]: 3, [b]: 4, [c]: 2 });
  });

  it('o que saiu da vitrine não entra — e volta em "descartados" para a tela dizer', async () => {
    const { token } = await contaNova();
    const ok = produto(gringa);
    const oculto = produto(gringa, 10000, { publicado: false });
    const res = await trocar(token, [
      { productId: ok, quantity: 1 },
      { productId: oculto, quantity: 1 },
      { productId: 'nao-existe', quantity: 1 },
    ]);
    expect(quantidades(res.body)).toEqual({ [ok]: 1 });
    expect(res.body.descartados.map((d: { productId: string }) => d.productId).sort()).toEqual(
      [oculto, 'nao-existe'].sort(),
    );

    // Despublicado DEPOIS de guardado: sai na próxima leitura, com o aviso.
    getConnection().prepare('UPDATE core_products SET publish_online = 0 WHERE id = ?').run(ok);
    const lido = await carrinho(token);
    expect(lido.body.items).toEqual([]);
    expect(lido.body.descartados).toEqual([{ productId: ok, motivo: 'indisponivel' }]);
    expect((await carrinho(token)).body.descartados).toEqual([]);
  });

  it('quantidade é inteira e tem teto; lista torta é 400', async () => {
    const { token } = await contaNova();
    const a = produto(gringa);
    const res = await trocar(token, [{ productId: a, quantity: 1000 }, { productId: a, quantity: 2.7 }]);
    expect(quantidades(res.body)).toEqual({ [a]: 99 });
    expect((await trocar(token, 'isto não é lista')).status).toBe(400);
  });

  it('a página do produto ACRESCENTA (POST /carrinho/itens)', async () => {
    const { token } = await contaNova();
    const a = produto(gringa);
    await trocar(token, [{ productId: a, quantity: 1 }]);
    const res = await request(app)
      .post(`${BASE}/carrinho/itens`)
      .set('x-portal-token', token)
      .send({ productId: a, quantity: 2 });
    expect(res.status).toBe(200);
    expect(quantidades(res.body)).toEqual({ [a]: 3 });
  });

  it('o carrinho é de UMA conta: a outra não lê nem escreve nele', async () => {
    const { token: ana } = await contaNova('ana@exemplo.com');
    const { token: bia } = await contaNova('bia@exemplo.com');
    const a = produto(gringa);
    await trocar(ana, [{ productId: a, quantity: 2 }]);
    expect((await carrinho(bia)).body.items).toEqual([]);
    await trocar(bia, []);
    expect(quantidades((await carrinho(ana)).body)).toEqual({ [a]: 2 });
  });

  it('sem sessão é 401', async () => {
    expect((await request(app).get(`${BASE}/carrinho`)).status).toBe(401);
    expect((await request(app).put(`${BASE}/carrinho`).send({ items: [] })).status).toBe(401);
  });

  it('fechar o pedido tira da conta o que foi comprado (e só isso)', async () => {
    const { token } = await contaNova();
    const comprado = produto(gringa);
    const fica = produto(gringa);
    await trocar(token, [
      { productId: comprado, quantity: 1 },
      { productId: fica, quantity: 2 },
    ]);
    const pedido = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'k-carrinho')
      .set('x-portal-token', token)
      .send({
        paymentMethod: 'pix',
        customerDocument: '111.444.777-35',
        customerPhone: '(53) 99999-0000',
        items: [{ productId: comprado, quantity: 1 }],
      });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(quantidades((await carrinho(token)).body)).toEqual({ [fica]: 2 });
  });
});

describe('GAP-PRD-193 — a sessão desliza', () => {
  function sessao(token: string) {
    return getConnection()
      .prepare('SELECT expires_at, created_at FROM core_customer_sessions WHERE id = ?')
      .get(token) as { expires_at: string; created_at: string };
  }
  function envelhecer(token: string, minutosDesdeOLogin: number, minutosAteVencer: number) {
    const agora = Date.now();
    getConnection()
      .prepare('UPDATE core_customer_sessions SET created_at = ?, expires_at = ? WHERE id = ?')
      .run(
        new Date(agora - minutosDesdeOLogin * 60_000).toISOString(),
        new Date(agora + minutosAteVencer * 60_000).toISOString(),
        token,
      );
  }

  it('usar a conta empurra o vencimento para 1 h a partir de agora', async () => {
    const { token } = await contaNova();
    envelhecer(token, 50, 10); // entrou há 50 min; venceria em 10.
    const res = await request(app).get(`${BASE}/sessao`).set('x-portal-token', token);
    expect(res.status).toBe(200);
    const vence = new Date(res.body.expiresAt).getTime();
    expect(vence).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(new Date(sessao(token).expires_at).getTime()).toBe(vence);
    expect(res.body.absoluteExpiresAt).toBeTruthy();
  });

  it('qualquer chamada do portal também renova (a navegação não derruba a conta)', async () => {
    const { token } = await contaNova();
    envelhecer(token, 50, 10);
    await carrinho(token);
    expect(new Date(sessao(token).expires_at).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
  });

  it('nunca passa de 24 h desde o login', async () => {
    const { token } = await contaNova();
    envelhecer(token, 23 * 60 + 30, 10); // entrou há 23h30; venceria em 10 min.
    const res = await request(app).get(`${BASE}/sessao`).set('x-portal-token', token);
    const teto = new Date(sessao(token).created_at).getTime() + 24 * 60 * 60_000;
    expect(new Date(res.body.expiresAt).getTime()).toBe(teto);
  });

  it('sessão vencida não se renova — 401', async () => {
    const { token } = await contaNova();
    envelhecer(token, 120, -1);
    expect((await request(app).get(`${BASE}/sessao`).set('x-portal-token', token)).status).toBe(401);
  });

  it('sessão revogada (saiu) não se renova', async () => {
    const { token } = await contaNova();
    await request(app).post(`${BASE}/sair`).set('x-portal-token', token);
    expect((await request(app).get(`${BASE}/sessao`).set('x-portal-token', token)).status).toBe(401);
  });
});
