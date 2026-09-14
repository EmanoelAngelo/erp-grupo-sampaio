/**
 * O PIPELINE GRAVA O QUE VIAJA, E CONFERE ANTES DE ENFILEIRAR — GAP-PRD-003.
 *
 * `core_fiscal_documents.xml_signed` guardava o XML indentado com um digest
 * que não era o dele. Aqui o caminho é o de verdade: A1 selado no cofre,
 * `emitNfceForSale` sem senha e sem modo de desenvolvimento (a chamada do
 * PDV), e um adapter espião no lugar da rede. Prova-se que:
 *
 *  - o que ficou em `xml_signed` é, byte a byte, o que o adapter recebeu;
 *  - é compacto e o digest confere pela libxml2 (outro canonicalizador);
 *  - o histórico do SIGNED diz como foi assinado;
 *  - se a autoconferência falhar (dublada aqui), o documento vai para ERROR
 *    com o motivo, NADA é gravado como assinado e NADA é transmitido.
 */
import { createHash } from 'node:crypto';
import { XmlC14NMode, XmlDocument } from 'libxml2-wasm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controle = vi.hoisted(() => ({ quebrarAutoconferencia: false }));

vi.mock('../src/services/core/FiscalSigner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/core/FiscalSigner.js')>();
  return {
    ...real,
    verifyNfceSignature: (xml: string) =>
      controle.quebrarAutoconferencia
        ? { valid: false, reason: 'digest dublado para falhar', digestMatches: false, signatureMatches: true }
        : real.verifyNfceSignature(xml),
  };
});

const { getConnection } = await import('../src/db/sqlite.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
const { emitNfceForSale } = await import('../src/services/core/FiscalPipelineService.js');
const { getDocument, listDocumentEvents } = await import('../src/services/core/FiscalDocumentService.js');
const { SefazTestAdapter } = await import('../src/services/core/SefazTestAdapter.js');
const { upsertCertificateA1 } = await import('../src/services/fiscal/FiscalCertificateService.js');
const { temEspacoEntreTags } = await import('../src/services/core/FiscalXmlForma.js');
const { grupoTributarioPadrao } = await import('./helpers/grupoTributario.js');
const { gerarCertificado } = await import('./helpers/certificado.js');
type AuthorizeRequest = import('../src/services/core/SefazAdapter.js').AuthorizeRequest;
type SefazResponse = import('../src/services/core/SefazAdapter.js').SefazResponse;

const SENHA = 'Xyz@Cofre123';
let pfx: string;
let companyId: string;

class Espiao extends SefazTestAdapter {
  readonly recebidos: AuthorizeRequest[] = [];
  override async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    this.recebidos.push(input);
    return super.authorize(input);
  }
}

function criarVenda(id: string): string {
  ensureCoreSchema();
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Social', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `GS-${id}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, 1, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Social', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

beforeAll(() => {
  pfx = gerarCertificado('PRECO JUSTO:11222333000181', SENHA);
}, 60_000);

beforeEach(() => {
  resetDbForTests();
  controle.quebrarAutoconferencia = false;
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
  upsertCertificateA1({ companyId, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA });
});

function xmlAssinadoNoBanco(documentId: string): string | null {
  return (
    getConnection()
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(documentId) as { xml_signed: string | null }
  ).xml_signed;
}

describe('o A1 do cofre assina, e o que fica gravado é o que viaja', () => {
  it('xml_signed == o que o adapter recebeu; compacto; digest confere pela libxml2; histórico diz o perfil', async () => {
    const espiao = new Espiao();
    const r = await emitNfceForSale({ companyId, saleId: criarVenda('v1'), adapter: espiao });
    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.isTest).toBe(false);

    const gravado = xmlAssinadoNoBanco(r.document.id)!;
    expect(espiao.recebidos).toHaveLength(1);
    expect(espiao.recebidos[0].signedXml).toBe(gravado);
    expect(temEspacoEntreTags(gravado)).toBe(false);

    const doc = XmlDocument.fromString(gravado);
    const c14n = doc.get("//*[local-name()='infNFe']")!.canonicalizeToString({ mode: XmlC14NMode.XML_C14N_1_0 });
    doc.dispose();
    const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(gravado)![1];
    expect(createHash('sha1').update(c14n, 'utf8').digest('base64')).toBe(digest);

    const assinou = listDocumentEvents(companyId, r.document.id).find(
      (e) => e.eventType === 'status:VALIDATED->SIGNED',
    )!;
    expect(JSON.parse(assinou.detail!)).toMatchObject({
      signer: 'xml-crypto 6.1.2',
      c14n: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      signatureValid: true,
      schemaValidated: true,
    });
  });
});

describe('a autoconferência antes da fila', () => {
  it('assinatura que não confere: ERROR com o motivo, nada gravado como assinado, nada transmitido', async () => {
    controle.quebrarAutoconferencia = true;
    const espiao = new Espiao();
    const r = await emitNfceForSale({ companyId, saleId: criarVenda('v2'), adapter: espiao });

    expect(r.document.status).toBe('ERROR');
    expect(getDocument(companyId, r.document.id)!.xMotivo).toMatch(
      /O XML assinado não passou na autoconferência: assinatura: digest dublado para falhar/,
    );
    expect(xmlAssinadoNoBanco(r.document.id)).toBeNull();
    expect(espiao.recebidos).toHaveLength(0);
  });
});
