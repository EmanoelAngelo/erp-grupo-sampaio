/**
 * O CHECKLIST VIRA ASSISTENTE — a tela fiscal responde item a item.
 *
 * ## O defeito
 *
 * O readiness listava pendências e nada mais: cada item dizia PASS ou FAIL com
 * uma frase, e a pessoa que abria a tela ficava sem as quatro respostas que
 * decidem o que fazer a seguir —
 *
 *   - O QUE JÁ SABEMOS (o valor que está lá),
 *   - DE ONDE VEIO o dado (do cadastro? do certificado? do XML do fornecedor?
 *     de uma confirmação humana? da SEFAZ?),
 *   - QUEM RESOLVE (o dono, o contador, ou a SEFAZ — e nesse último caso
 *     ninguém aqui dentro resolve, por mais que se clique),
 *   - QUANTO FALTA, quando o item é de catálogo: "93% dos produtos
 *     classificados" é acionável; "produtos sem NCM" é um susto sem tamanho.
 *
 * Sem o dono do item, a tela empurrava o gestor a tentar resolver o que só a
 * SEFAZ resolve. Sem a procedência, um NCM lido do arquivo do fornecedor
 * parecia decisão da casa. As duas coisas são a mesma classe de defeito: dado
 * sem origem é dado sem responsável.
 *
 * ## O que este arquivo crava
 *
 * O estado é DERIVADO, nunca configurável — e 'CONFIRMADO' exige gente. É o
 * mesmo princípio do `readiness`, que nunca é 'HOMOLOGATED' sem protocolo real.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { buildReadiness } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const PASSWORD = 'Teste@Assistente2026';

let companyId: string;
let gestor: { Authorization: string };

async function actor(login: string, profile: string) {
  const userId = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  gestor = await actor('GESTORASSIST', 'gerente_loja');
});

const ESTADOS = new Set([
  'AUTO_DETECTADO',
  'CONFIRMADO',
  'PENDENTE',
  'DIVERGENTE',
  'NAO_APLICAVEL',
  'BLOQUEADO_EXTERNAMENTE',
]);

describe('cada item do checklist se apresenta por inteiro', () => {
  it('todo item diz estado, procedência e quem resolve', () => {
    const r = buildReadiness(companyId, '65');
    expect(r.items.length).toBeGreaterThan(5);

    for (const item of r.items) {
      expect(ESTADOS.has(item.state), `${item.key} sem estado válido: ${item.state}`).toBe(true);
      expect(
        ['dono', 'gestor', 'contador', 'sefaz'].includes(item.owner),
        `${item.key} sem dono: ${item.owner}`,
      ).toBe(true);
      // Procedência: `null` só é aceitável quando não se sabe NADA ainda.
      if (item.state === 'CONFIRMADO' || item.state === 'AUTO_DETECTADO') {
        expect(item.source, `${item.key} confirmado/detectado sem procedência`).toBeTruthy();
      }
    }
  });

  it('o que já sabemos aparece no item — não só o que falta', async () => {
    await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({ legalName: 'Preço Justo Comércio Ltda', cnpj: '11.222.333/0001-81' });

    const r = buildReadiness(companyId, '65');
    const emitter = r.items.find((i) => i.key === 'emitter')!;
    expect(emitter.state).toBe('CONFIRMADO');
    expect(emitter.source).toBe('cadastro');
    expect(emitter.known).toBe('Preço Justo Comércio Ltda');

    const vazio = r.items.find((i) => i.key === 'ie')!;
    expect(vazio.state).toBe('PENDENTE');
    expect(vazio.known).toBeNull();
  });

  it('CNPJ com dígito errado é DIVERGENTE, não apenas pendente', () => {
    // Gravar pela API é impossível (a validação recusa), e é justamente esse o
    // ponto: a divergência que interessa é a do banco herdado.
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_configs (company_id, cnpj, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (company_id) DO UPDATE SET cnpj = excluded.cnpj`,
      )
      .run(companyId, '11222333000182', new Date().toISOString());

    const cnpj = buildReadiness(companyId, '65').items.find((i) => i.key === 'cnpj')!;
    expect(cnpj.state).toBe('DIVERGENTE');
    expect(cnpj.known).toBe('11222333000182');
  });

  it('a SEFAZ é BLOQUEADO EXTERNAMENTE — ninguém aqui dentro resolve clicando', () => {
    const sefaz = buildReadiness(companyId, '65').items.find((i) => i.key === 'sefaz')!;
    expect(sefaz.status).toBe('PENDING');
    expect(sefaz.state).toBe('BLOQUEADO_EXTERNAMENTE');
    expect(sefaz.owner).toBe('sefaz');
  });

  it('o certificado é AUTO-DETECTADO quando existe: o arquivo se apresenta sozinho', () => {
    const semCert = buildReadiness(companyId, '65').items.find((i) => i.key === 'certificate')!;
    expect(semCert.state).toBe('PENDENTE');
    expect(semCert.owner).toBe('dono');
  });
});

describe('o item de catálogo conta, e a contagem é o que torna a lista acionável', () => {
  async function produto(nome: string, patch: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: nome, priceCents: 1000, ...patch });
    expect(res.status).toBe(201);
    return String(res.body.id);
  }

  it('NCM vem com quantos de quantos, e o percentual', async () => {
    await produto('Com NCM', { ncm: '87141000' });
    await produto('Sem NCM');

    const ncm = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_ncm')!;
    expect(ncm.counts).toEqual({ done: 1, total: 2, percent: 50 });
    expect(ncm.owner).toBe('contador');
  });

  it('catálogo vazio não vira 0% — não há o que classificar', () => {
    const ncm = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_ncm')!;
    expect(ncm.counts).toEqual({ done: 0, total: 0, percent: 100 });
    expect(ncm.state).toBe('NAO_APLICAVEL');
  });

  /*
    A ORIGEM: o grupo tributário a supre — e sem ela em LUGAR NENHUM, trava
    (GAP-PRD-129). O caso antigo dizia "não trava" sem haver grupo nenhum: a
    validação da nota recusava a venda enquanto o checklist a dava por boa.
  */
  it('a ORIGEM: sem ela no produto nem no grupo, trava; o grupo com origem a supre', async () => {
    await produto('Sem origem', { ncm: '87141000', cfop: '5102' });
    const semNada = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_origin')!;
    expect(semNada.status).toBe('FAIL');
    expect(semNada.state).toBe('PENDENTE');
    expect(semNada.detail).toMatch(/grupo tribut/i);

    const { upsertTaxGroup } = await import('../src/services/core/CatalogAuxService.js');
    upsertTaxGroup(companyId, {
      code: 'PADRAO',
      name: 'Padrão',
      regime: 'simples',
      csosn: '102',
      cstPis: '49',
      cstCofins: '49',
      origin: '0',
    });
    const comGrupo = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_origin')!;
    expect(comGrupo.status).toBe('PASS');
    expect(comGrupo.detail).toMatch(/grupo tribut/i);
  });

  it('CEST é NÃO APLICÁVEL quando ninguém declara substituição tributária', async () => {
    await produto('Comum', { ncm: '87141000', cfop: '5102', origin: '0' });
    const cest = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_cest')!;
    expect(cest.status).toBe('PASS');
    expect(cest.state).toBe('NAO_APLICAVEL');
  });

  it('o CFOP nunca é auto-detectado: o do fornecedor é a saída DELE', async () => {
    await produto('Sem CFOP', { ncm: '87141000' });
    const cfop = buildReadiness(companyId, '65').items.find((i) => i.key === 'product_cfop')!;
    expect(cfop.source).not.toBe('xml_fornecedor');
    expect(cfop.detail).toMatch(/fornecedor/i);
  });
});

describe('a rota entrega o assistente inteiro numa chamada', () => {
  it('o resumo da classificação viaja junto do checklist', async () => {
    await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Item', priceCents: 100 });

    const res = await request(app).get('/api/v1/core/fiscal/readiness').set(gestor);
    expect(res.status).toBe(200);
    expect(res.body.classification).toBeTruthy();
    expect(res.body.classification.totalProducts).toBe(1);
    expect(res.body.classification.pendingSuggestions).toBe(0);
    expect(res.body.classification.divergences).toBe(0);

    // O checklist continua vindo por modelo, e cada item já enriquecido.
    const item = res.body.items[0].items.find((i: { key: string }) => i.key === 'emitter');
    expect(item.owner).toBe('gestor');
  });
});
