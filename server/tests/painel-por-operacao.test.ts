/**
 * ============================================================================
 * O PAINEL OLHA OUTRA OPERAÇÃO SEM TROCAR DE SESSÃO — GAP-V46
 * ============================================================================
 *
 * ## O defeito
 *
 * Comparar o dia de duas lojas custava uma troca no seletor "Operação ativa" da
 * topbar MAIS um `window.location.reload()` inteiro por empresa
 * (`AppShell.tsx`). A visão lado a lado existe — Relatórios › BI, servida por
 * `/insights/operations` —, mas o recorte DIÁRIO por empresa dentro do próprio
 * painel não existia: o painel lia só a empresa do token.
 *
 * ## A regra de atravessar empresa é o VÍNCULO, e este arquivo é quem a prova
 *
 * `?companyId=` é o parâmetro mais perigoso que uma rota multitenant pode
 * aceitar: ele é literalmente "leia os números daquela outra empresa". O que o
 * torna seguro é a MESMA régua de `GET /companies` e de
 * `/fiscal/certificates/group` — `core_user_companies`, não o perfil. Um
 * `gerente_loja` da Conceito é gerente DA CONCEITO.
 *
 * As três formas de errar, e o que cada uma tem de devolver:
 *
 *   - empresa DO vínculo   → 200 com os números DELA (e não os da sessão);
 *   - empresa FORA do vínculo → 403. Não 200 com os números da sessão (que
 *     ensinaria que o parâmetro é decorativo e deixaria o defeito nascer no
 *     dia em que ele passasse a funcionar), e não 404 (que contaria se a
 *     empresa existe — informação que não é de quem perguntou);
 *   - empresa INEXISTENTE  → 403 também, pela mesma razão: quem não tem
 *     vínculo não descobre a diferença entre "não é sua" e "não existe".
 *
 * ## E a lista do seletor vem no MESMO payload
 *
 * Sem ela a tela precisaria de `GET /companies` para desenhar o seletor — e
 * essa rota é de DONO (`requireProfile(req)` sem perfil extra). O gerente com
 * duas lojas não conseguiria montar o próprio seletor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Painel@DoGrupo2026';
const HOJE = '2026-06-10';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';

let conceito: string;
let gringa: string;
let pjmotors: string;

async function ator(login: string, vinculos: [string, string][]) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const [companyId, perfil] of vinculos) linkUserToCompany(userId, companyId, perfil, false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: vinculos[0][0] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(() => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio de Roupas Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  pjmotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'workshop',
  });
});

async function venderNa(
  quem: { Authorization: string },
  companyId: string,
  precoCents: number,
): Promise<void> {
  const produto = await request(app)
    .post(`/api/v1/core/products?companyId=${companyId}`)
    .set(quem)
    .send({ name: `Item ${precoCents}`, priceCents: precoCents });
  expect(produto.status, JSON.stringify(produto.body)).toBe(201);
  const id = produto.body.id as string;
  const carga = await request(app).post('/api/v1/core/stock/movements').set(quem).send({
    productId: id,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(carga.status, JSON.stringify(carga.body)).toBe(201);
  const venda = await request(app)
    .post('/api/v1/core/sales')
    .set(quem)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId: id, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: precoCents }],
    });
  expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  getConnection()
    .prepare('UPDATE core_sales SET created_at = ? WHERE id = ?')
    .run(MEIO_DIA, (venda.body.sale ?? venda.body).id);
}

function painel(quem: { Authorization: string }, companyId?: string) {
  const empresa = companyId ? `&companyId=${companyId}` : '';
  return request(app).get(`/api/v1/core/dashboard?from=${HOJE}&to=${HOJE}${empresa}`).set(quem);
}

describe('o painel troca de operação pelo vínculo, sem trocar de sessão', () => {
  it('o gerente das DUAS lojas lê os números de cada uma sem novo login', async () => {
    /*
      O caso central. As duas vendas nascem em sessões diferentes (o token é
      por empresa, e a venda tem de ser da empresa certa); o que este caso
      prova é a LEITURA: uma sessão só, dois recortes.
    */
    const naConceito = await ator('GERENTE.DUAS', [[conceito, 'gerente_loja']]);
    const naGringa = await ator('GERENTE.DUAS.G', [[gringa, 'gerente_loja']]);
    await venderNa(naConceito, conceito, 10_000);
    await venderNa(naGringa, gringa, 25_000);

    // A mesma pessoa, agora vinculada às duas, entrando pela Conceito.
    const dasDuas = await ator('GERENTE.DUAS', [
      [conceito, 'gerente_loja'],
      [gringa, 'gerente_loja'],
    ]);

    const daCasa = await painel(dasDuas);
    expect(daCasa.status, JSON.stringify(daCasa.body)).toBe(200);
    expect(daCasa.body.revenueCents).toBe(10_000);
    expect(daCasa.body.companyId).toBe(conceito);

    const daOutra = await painel(dasDuas, gringa);
    expect(daOutra.status, JSON.stringify(daOutra.body)).toBe(200);
    expect(daOutra.body.revenueCents).toBe(25_000);
    expect(daOutra.body.companyId).toBe(gringa);
  });

  it('a lista do seletor vem no MESMO payload, e é a do vínculo', async () => {
    const dasDuas = await ator('GERENTE.DUAS', [
      [conceito, 'gerente_loja'],
      [gringa, 'gerente_loja'],
    ]);
    const res = await painel(dasDuas);
    expect(res.status).toBe(200);
    const nomes = (res.body.companies as { id: string; tradeName: string }[]).map(
      (c) => c.tradeName,
    );
    expect(nomes.sort()).toEqual(['Conceito', 'Gringa']);
    /*
      A PJ Motors existe e NÃO é dele: uma lista "todas as empresas" a traria.
      A conferência é pelo ID, e não pelo nome fantasia — renomear a operação
      não pode fazer este guarda passar a medir outra coisa.
    */
    const ids = (res.body.companies as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(pjmotors);
  });
});

describe('o vínculo é o guarda — não o perfil', () => {
  it('A MORDIDA: gerente de UMA loja pedindo a outra recebe 403, e não os números dela', async () => {
    /*
      Sem a conferência, este mesmo pedido devolveria 200 com o faturamento da
      Gringa para quem só responde pela Conceito — o vazamento de tenant mais
      barato que existe, porque basta digitar um id na URL.
    */
    const soConceito = await ator('GERENTE.SO.CONCEITO', [[conceito, 'gerente_loja']]);
    const naGringa = await ator('GERENTE.GRINGA', [[gringa, 'gerente_loja']]);
    await venderNa(naGringa, gringa, 25_000);

    const res = await painel(soConceito, gringa);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_COMPANY_NOT_IN_MEMBERSHIP');
    expect(JSON.stringify(res.body)).not.toContain('25000');
  });

  it('empresa inexistente também é 403 — quem não tem vínculo não descobre o que existe', async () => {
    const soConceito = await ator('GERENTE.SO.CONCEITO', [[conceito, 'gerente_loja']]);
    const res = await painel(soConceito, 'empresa-que-nao-existe');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_COMPANY_NOT_IN_MEMBERSHIP');
  });

  it('sem o parâmetro, nada muda: o painel continua sendo o da sessão', async () => {
    const soConceito = await ator('GERENTE.SO.CONCEITO', [[conceito, 'gerente_loja']]);
    await venderNa(soConceito, conceito, 7_000);
    const res = await painel(soConceito);
    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBe(7_000);
    expect(res.body.companyId).toBe(conceito);
  });
});
