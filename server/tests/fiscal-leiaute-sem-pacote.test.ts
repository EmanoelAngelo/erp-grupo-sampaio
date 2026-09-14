/**
 * SEM O PACOTE DE ESQUEMAS, NINGUÉM FINGE QUE VALIDOU — GAP-PRD-097.
 *
 * Os XSDs moram no repositório, com manifesto de SHA-256. Se a instalação
 * perder um arquivo (ou alguém editar um XSD "para passar"), o validador não
 * pode dizer "XSD VALID" — nem cair em silêncio para "só boa formação" e
 * deixar a nota seguir. Aqui o `node:fs` é dublado para simular as duas
 * situações, e a resposta tem de ser a mesma: `validated: false`, o motivo
 * por extenso, e a emissão recusada ANTES do número.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const controle = vi.hoisted(() => ({ modo: 'sem-manifesto' as 'sem-manifesto' | 'adulterado' }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    existsSync: (caminho: Parameters<typeof real.existsSync>[0]) =>
      controle.modo === 'sem-manifesto' && String(caminho).endsWith('MANIFESTO.json')
        ? false
        : real.existsSync(caminho),
    readFileSync: ((caminho: Parameters<typeof real.readFileSync>[0], ...resto: unknown[]) => {
      const lido = (real.readFileSync as (...a: unknown[]) => unknown)(caminho, ...resto);
      if (controle.modo === 'adulterado' && String(caminho).endsWith('leiauteNFe_v4.00.xsd')) {
        // Um "ajuste" no XSD para uma nota passar — o manifesto tem de pegar.
        return Buffer.concat([Buffer.from(lido as Buffer), Buffer.from('<!-- afrouxado -->')]);
      }
      return lido;
    }) as typeof real.readFileSync,
  };
});

const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { getSeries, setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
const { createNfceForSale, getDocument, validateDocument } = await import(
  '../src/services/core/FiscalDocumentService.js'
);
const { situacaoDosEsquemas, validarLeiauteNfe } = await import('../src/services/core/FiscalXsdValidator.js');
const { grupoTributarioPadrao } = await import('./helpers/grupoTributario.js');

let companyId: string;

function criarVenda(id: string): string {
  ensureCoreSchema();
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, 'GS-1', 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key,
                             change_cents, created_at)
     VALUES (?, ?, 1, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960012345',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
});

const NFE_MINIMA =
  '<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">'
  + '<infNFe versao="4.00" Id="NFe43260911222333000181650010000000011000000019"><ide><cUF>43</cUF></ide></infNFe></NFe>';

describe('pacote de esquemas ausente', () => {
  it('a situação diz indisponível, com o motivo', () => {
    expect(situacaoDosEsquemas()).toMatchObject({ disponivel: false });
    expect(situacaoDosEsquemas().motivo).toMatch(/não está na instalação/);
  });

  it('validar não reporta validado: diz que só a boa formação foi vista', () => {
    const r = validarLeiauteNfe(NFE_MINIMA);
    expect(r).toMatchObject({ validated: false, wellFormed: true, problems: [], schemaPackage: null });
    expect(r.note).toMatch(/NÃO equivale a conformidade com o leiaute/);
  });

  it('a emissão é recusada ANTES do número (503), e a série não anda', () => {
    const saleId = criarVenda('s1');
    const antes = getSeries(companyId, '65')[0].nextNumber;
    expect(() => createNfceForSale({ companyId, saleId })).toThrow(
      expect.objectContaining({ code: 'CORE_FISCAL_XSD_UNAVAILABLE', status: 503 }),
    );
    expect(getSeries(companyId, '65')[0].nextNumber).toBe(antes);
  });

  it('documento que chega ao DRAFT→VALIDATED sem o pacote vai para ERROR, e não para a assinatura', () => {
    const saleId = criarVenda('s2');
    const id = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, sale_id, model, serie, number, access_key, environment, status,
            xml_original, issued_at, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, '65', 1, 1, '43260911222333000181650010000000011000000019',
                 'homologation', 'DRAFT', ?, ?, ?, ?, ?)`,
      )
      .run(id, companyId, saleId, NFE_MINIMA, agora, `sale:${saleId}:model:65`, agora, agora);

    const r = validateDocument({ companyId, documentId: id });
    expect(r.status).toBe('ERROR');
    expect(getDocument(companyId, id)!.xMotivo).toMatch(/Leiaute não conferido/);
  });
});

describe('pacote de esquemas adulterado', () => {
  it('um XSD que não confere com o manifesto derruba o pacote inteiro', async () => {
    controle.modo = 'adulterado';
    vi.resetModules();
    const validador = await import('../src/services/core/FiscalXsdValidator.js');
    const situacao = validador.situacaoDosEsquemas();
    expect(situacao.disponivel).toBe(false);
    expect(situacao.motivo).toMatch(/leiauteNFe_v4\.00\.xsd.*não confere com o manifesto/);
    expect(validador.validarLeiauteNfe(NFE_MINIMA).validated).toBe(false);
    expect(() => validador.conferirLeiauteAntesDeNumerar(() => NFE_MINIMA)).toThrow(/conferência do leiaute/);
  });
});
