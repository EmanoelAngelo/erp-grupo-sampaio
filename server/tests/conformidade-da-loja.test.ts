/**
 * CONFORMIDADE DA LOJA — rodada 45.
 *
 * Vender online no Brasil tem dois deveres que o sistema não cumpria:
 *
 *   - IDENTIFICAÇÃO (Decreto 7.962/2013): razão social, CNPJ e endereço do
 *     fornecedor visíveis na loja. Não havia endpoint público com esses
 *     dados — e os dados fiscais NÃO podem vazar além do que a lei manda
 *     expor (IE, IM, CRT e ambiente ficam de fora).
 *
 *   - CONSENTIMENTO REGISTRADO (LGPD): o cadastro do portal aceitava conta
 *     sem aceite de termos, e não havia onde registrar QUANDO alguém
 *     aceitou. Consentimento sem registro não é consentimento — a coluna
 *     `accepted_terms_at` (migração 64) grava o momento; conta antiga fica
 *     NULL, porque aceite não se inventa retroativamente.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - devolva o objeto fiscal inteiro na identificação e o caso do vazamento
 *     fica vermelho (ele procura ie/environment no JSON);
 *   - aceite cadastro sem termsAccepted e o caso do 400 fica vermelho;
 *   - esqueça de gravar accepted_terms_at e o caso do registro fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
let gringa: string;

beforeEach(async () => {
  resetDbForTests();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Moda Ltda' });
  await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Comércio Ltda' });
  await upsertCompany({ slug: 'oficina', tradeName: 'Oficina', legalName: 'Oficina Ltda', kind: 'workshop' });
  updateFiscalConfig({
    companyId: gringa,
    patch: {
      legalName: 'Gringa Moda Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '1234567890',
      crt: '1',
      street: 'Rua das Andradas',
      number: '1000',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
      zip: '96010-000',
      phone: '(53) 99999-0000',
    },
  });
  grupoTributarioPadrao(gringa);
});

describe('a identificação pública da loja (Decreto 7.962)', () => {
  it('devolve razão social, CNPJ e endereço — o que a lei manda mostrar', async () => {
    const res = await request(app).get('/api/v1/loja/identificacao');
    expect(res.status).toBe(200);
    const daGringa = res.body.stores.find((s: { slug: string }) => s.slug === 'gringa');
    expect(daGringa).toBeTruthy();
    expect(daGringa.legalName).toBe('Gringa Moda Ltda');
    expect(daGringa.cnpj).toBe('11.222.333/0001-81');
    expect(daGringa.address).toMatch(/Rua das Andradas/);
    expect(daGringa.address).toMatch(/Pelotas/);
    expect(daGringa.phone).toBe('(53) 99999-0000');
  });

  it('loja sem cadastro fiscal aparece com campos nulos — ausência não é omissão do endpoint', async () => {
    const res = await request(app).get('/api/v1/loja/identificacao');
    const semFiscal = res.body.stores.find((s: { slug: string }) => s.slug === 'preco-justo');
    expect(semFiscal).toBeTruthy();
    // legal_name de core_companies segura a identificação mínima.
    expect(semFiscal.legalName).toBe('Preço Justo Comércio Ltda');
    expect(semFiscal.cnpj).toBeNull();
  });

  it('NUNCA vaza o que a lei não manda: IE, IM, CRT, ambiente fiscal ficam de fora', async () => {
    const res = await request(app).get('/api/v1/loja/identificacao');
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toMatch(/"ie"/);
    expect(corpo).not.toMatch(/"im"/);
    expect(corpo).not.toMatch(/"crt"/);
    expect(corpo).not.toMatch(/environment/);
    expect(corpo).not.toMatch(/1234567890/);
  });

  it('a Oficina NÃO aparece — não é loja, é sistema', async () => {
    const res = await request(app).get('/api/v1/loja/identificacao');
    expect(JSON.stringify(res.body)).not.toMatch(/oficina/i);
  });
});

describe('o consentimento registrado (LGPD)', () => {
  function conta(email: string) {
    return getConnection()
      .prepare('SELECT accepted_terms_at FROM core_customer_accounts WHERE email = ?')
      .get(email) as { accepted_terms_at: string | null } | undefined;
  }

  it('cadastro SEM aceite é recusado com o motivo', async () => {
    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ email: 'ana@exemplo.com', password: 'Portal@2026' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_TERMS_REQUIRED');
    expect(conta('ana@exemplo.com')).toBeUndefined();
  });

  it('aceite "true" de mentira (string, 1, objeto) não passa — só o booleano', async () => {
    for (const falso of ['true', 1, {}, 'sim']) {
      const res = await request(app)
        .post('/api/v1/loja/portal/registrar')
        .send({ email: 'bia@exemplo.com', password: 'Portal@2026', termsAccepted: falso });
      expect(res.status).toBe(400);
    }
  });

  it('com aceite, a conta nasce com o MOMENTO gravado — é a prova que a LGPD pede', async () => {
    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ email: 'ana@exemplo.com', password: 'Portal@2026', termsAccepted: true });
    expect(res.status).toBe(201);
    const linha = conta('ana@exemplo.com');
    expect(linha?.accepted_terms_at).toBeTruthy();
    expect(new Date(String(linha!.accepted_terms_at)).getTime()).not.toBeNaN();
  });

  it('o caminho do CONVITE exige o mesmo aceite', async () => {
    // O convite troca a co-prova, não o consentimento: sem aceite, nada.
    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ email: 'joana@exemplo.com', password: 'Portal@2026', code: 'ABCD234567' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_TERMS_REQUIRED');
  });
});

describe('migração 64', () => {
  it('cria accepted_terms_at em banco que não a tem — e conta antiga fica NULL', () => {
    const db = getConnection();
    db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_64'").run();
    migrateCoreSchema();
    const coluna = db
      .prepare("SELECT name FROM pragma_table_info('core_customer_accounts') WHERE name = 'accepted_terms_at'")
      .get() as { name: string } | undefined;
    expect(coluna?.name).toBe('accepted_terms_at');
  });
});
