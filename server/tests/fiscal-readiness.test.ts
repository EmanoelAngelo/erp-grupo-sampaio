/**
 * Configuração fiscal e o portão de emissão.
 *
 * O readiness existe para que "posso emitir?" seja respondido com a lista do
 * que falta, e não com uma tentativa que morre na SEFAZ depois da venda feita.
 *
 * O teste mais importante deste arquivo é o último: sem certificado real, o
 * caminho inteiro tem que terminar em READY_FOR_CERTIFICATE — nunca em
 * AUTHORIZED.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { isValidCnpj, buildReadiness } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const PASSWORD = 'Teste@Fiscal2026';

let companyId: string;
let gestor: { Authorization: string };

async function actor(login: string, profile: string, company = companyId) {
  const userId = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(userId, company, profile, true);
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
  gestor = await actor('GESTORFISCAL', 'gerente_loja');
});

describe('CNPJ', () => {
  it('confere os dois dígitos verificadores', () => {
    // Gerado pelo próprio algoritmo da Receita a partir de uma base conhecida.
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);

    // Um dígito trocado invalida.
    expect(isValidCnpj('11222333000182')).toBe(false);
    // Todos iguais passam na conta e não são CNPJ.
    expect(isValidCnpj('11111111111111')).toBe(false);
    expect(isValidCnpj('123')).toBe(false);
    expect(isValidCnpj(null)).toBe(false);
  });

  it('a API recusa gravar CNPJ inválido', async () => {
    const res = await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({ cnpj: '11222333000182' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_CNPJ_INVALID');
  });
});

describe('readiness', () => {
  it('operação recém-criada não pode emitir e diz exatamente o que falta', () => {
    const r = buildReadiness(companyId, '65');

    expect(r.canEmit).toBe(false);
    expect(r.readiness).toBe('READY_FOR_CERTIFICATE');

    const falhas = r.items.filter((i) => i.status === 'FAIL').map((i) => i.key);
    expect(falhas).toContain('emitter');
    expect(falhas).toContain('cnpj');
    expect(falhas).toContain('ie');
    expect(falhas).toContain('crt');
    expect(falhas).toContain('address');
    expect(falhas).toContain('certificate');
    expect(falhas).toContain('csc');

    // Cada pendência explica o campo, não um "erro de configuração" genérico.
    for (const item of r.items.filter((i) => i.status === 'FAIL')) {
      expect(item.detail).toBeTruthy();
      expect(item.detail!.length).toBeGreaterThan(10);
    }
  });

  it('SEFAZ fica PENDING, nunca PASS por otimismo', () => {
    const r = buildReadiness(companyId, '65');
    const sefaz = r.items.find((i) => i.key === 'sefaz')!;
    expect(sefaz.status).toBe('PENDING');
    expect(r.readiness).not.toBe('HOMOLOGATED');
  });

  it('preencher o emitente resolve os itens correspondentes e só eles', async () => {
    await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({
        legalName: 'Preço Justo Comércio Ltda',
        cnpj: '11.222.333/0001-81',
        // IE do RS é o CGC/TE, com dígito conferido (auditoria P0): o fictício
        // '123456789' não fecha a conta e o item ficaria PENDENTE/DIVERGENTE.
        ie: '096/0012346',
        crt: '1',
        street: 'Av. Central',
        number: '100',
        district: 'Centro',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        zip: '96010000',
        uf: 'RS',
      });

    const r = buildReadiness(companyId, '65');
    const porChave = Object.fromEntries(r.items.map((i) => [i.key, i.status]));

    expect(porChave.emitter).toBe('PASS');
    expect(porChave.cnpj).toBe('PASS');
    expect(porChave.ie).toBe('PASS');
    expect(porChave.crt).toBe('PASS');
    expect(porChave.address).toBe('PASS');
    expect(porChave.ibge).toBe('PASS');

    // O certificado NÃO passou a existir por causa do endereço.
    expect(porChave.certificate).toBe('FAIL');
    expect(r.canEmit).toBe(false);
    expect(r.readiness).toBe('READY_FOR_CERTIFICATE');
  });

  it('código IBGE precisa ter 7 dígitos', async () => {
    await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({ cityIbge: '160' });
    const r = buildReadiness(companyId, '65');
    expect(r.items.find((i) => i.key === 'ibge')!.status).toBe('FAIL');
  });

  it('NF-e não exige CSC; NFC-e exige', () => {
    const nfce = buildReadiness(companyId, '65');
    const nfe = buildReadiness(companyId, '55');
    expect(nfce.items.some((i) => i.key === 'csc')).toBe(true);
    expect(nfe.items.some((i) => i.key === 'csc')).toBe(false);
  });
});

describe('produção', () => {
  it('não é ligada pela tela de configuração', async () => {
    const res = await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({ environment: 'production' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_PRODUCTION_LOCKED');

    const cfg = await request(app).get('/api/v1/core/fiscal/config').set(gestor);
    expect(cfg.body.environment).toBe('homologation');
  });

  it('o ambiente padrão é homologação', async () => {
    const res = await request(app).get('/api/v1/core/fiscal/config').set(gestor);
    expect(res.body.environment).toBe('homologation');
    expect(res.body.productionUnlocked).toBe(false);
  });
});

describe('numeração pela API', () => {
  it('recusa retrocesso da série', async () => {
    await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gestor)
      .send({ model: '65', serie: 1, nextNumber: 300 });

    const res = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gestor)
      .send({ model: '65', serie: 1, nextNumber: 20 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_NUMBER_REGRESSION');
  });
});

describe('RBAC fiscal — testado na API, não no menu', () => {
  it('mecânico não lê nem grava configuração fiscal', async () => {
    const mecanico = await actor('MECFISCAL', 'mecanico');

    const leitura = await request(app).get('/api/v1/core/fiscal/config').set(mecanico);
    expect(leitura.status).toBe(403);

    const escrita = await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(mecanico)
      .send({ legalName: 'Hackeada' });
    expect(escrita.status).toBe(403);

    const readiness = await request(app).get('/api/v1/core/fiscal/readiness').set(mecanico);
    expect(readiness.status).toBe(403);
  });

  it('a configuração de uma operação não vaza para outra', async () => {
    await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({ legalName: 'Preço Justo Comércio Ltda', cnpj: '11.222.333/0001-81' });

    const outraCo = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    const daGringa = await actor('GESTORGRINGA', 'gerente_loja', outraCo);

    const res = await request(app).get('/api/v1/core/fiscal/config').set(daGringa);
    expect(res.status).toBe(200);
    // Cada operação emite com o próprio CNPJ. Não existe fallback.
    expect(res.body.legalName).toBeNull();
    expect(res.body.cnpj).toBeNull();
  });
});

describe('E2E sem certificado real', () => {
  /**
   * O teste que resume a rodada: com tudo o que é possível configurar sem o
   * certificado já configurado, o sistema tem que parar honestamente em
   * READY_FOR_CERTIFICATE — e não fabricar uma autorização.
   */
  it('caminho completo termina em READY_FOR_CERTIFICATE, não em AUTHORIZED', async () => {
    await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gestor)
      .send({
        legalName: 'Preço Justo Comércio Ltda',
        tradeName: 'Preço Justo',
        cnpj: '11.222.333/0001-81',
        ie: '123456789',
        crt: '1',
        zip: '68900-000',
        street: 'Av. Central',
        number: '100',
        district: 'Centro',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        uf: 'RS',
      });
    await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gestor)
      .send({ model: '65', serie: 1, nextNumber: 1 });

    const res = await request(app)
      .get('/api/v1/core/fiscal/readiness?model=65')
      .set(gestor);

    const r = res.body.items[0];
    expect(r.readiness).toBe('READY_FOR_CERTIFICATE');
    expect(r.canEmit).toBe(false);
    expect(r.items.find((i: { key: string }) => i.key === 'sefaz').status).toBe('PENDING');

    // O que resta é exatamente o que depende do usuário: certificado e CSC.
    const falhas = r.items
      .filter((i: { status: string }) => i.status === 'FAIL')
      .map((i: { key: string }) => i.key);
    expect(falhas).toEqual(
      expect.arrayContaining(['certificate', 'certificate_validity', 'csc']),
    );
    expect(falhas).not.toContain('cnpj');
    expect(falhas).not.toContain('address');
  });
});
