/**
 * O PROTOCOLO COM `Id` — GAP-PRD-004.
 *
 * O leiaute 4.00 declara o atributo `Id` de `infProt` (opcional), e a SVRS o
 * preenche: `<infProt Id="ID143260000000001">`. O parser só reconhecia a tag
 * NUA (`<infProt>`), então, numa autorização real, ele não achava o bloco do
 * protocolo e caía no cStat do LOTE (104, "Lote processado") — uma nota que o
 * fisco AUTORIZOU virava REJECTED, sem protocolo, e a reemissão queimava um
 * número novo para colher duplicidade (539).
 *
 * As respostas abaixo seguem o leiaute do retorno síncrono (retEnviNFe dentro
 * do nfeResultMsg do SOAP 1.2), com os atributos que a SVRS devolve — não são
 * cópia de nenhuma nota real.
 *
 * ## Como fica vermelho
 *
 *  - volte a regex de `parseSefazResponse` para `<(?:\w+:)?infProt>` e os
 *    casos com `Id` leem 104/"Lote processado": REJECTED, protocolo nulo;
 *  - o caso da fila deixa o documento em REJECTED com c_stat 104.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfeForSale,
  getDocument,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { parseSefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import type { ParsedCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const CHAVE = '43260911222333000181550010000000011000000014';

/** O retorno síncrono no formato da SVRS: lote 104 por fora, documento dentro de infProt Id=. */
function retornoSvrs(input: {
  chave: string;
  cStat: string;
  xMotivo: string;
  nProt?: string;
  prefixo?: string;
}): string {
  const p = input.prefixo ? `${input.prefixo}:` : '';
  const ns = input.prefixo ? ` xmlns:${input.prefixo}="http://www.portalfiscal.inf.br/nfe"` : ' xmlns="http://www.portalfiscal.inf.br/nfe"';
  return (
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
    + '<soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
    + `<${p}retEnviNFe versao="4.00"${ns}>`
    + `<${p}tpAmb>2</${p}tpAmb><${p}verAplic>RS20260901120000</${p}verAplic>`
    + `<${p}cStat>104</${p}cStat><${p}xMotivo>Lote processado</${p}xMotivo>`
    + `<${p}cUF>43</${p}cUF><${p}dhRecbto>2026-09-11T10:15:32-03:00</${p}dhRecbto>`
    + `<${p}protNFe versao="4.00">`
    + `<${p}infProt Id="ID${input.nProt ?? '143260000000999'}">`
    + `<${p}tpAmb>2</${p}tpAmb><${p}verAplic>RS20260901120000</${p}verAplic>`
    + `<${p}chNFe>${input.chave}</${p}chNFe>`
    + `<${p}dhRecbto>2026-09-11T10:15:32-03:00</${p}dhRecbto>`
    + (input.nProt ? `<${p}nProt>${input.nProt}</${p}nProt>` : '')
    + `<${p}digVal>Q2hhdmVEZVRlc3RlRG9EaWdlc3Q=</${p}digVal>`
    + `<${p}cStat>${input.cStat}</${p}cStat><${p}xMotivo>${input.xMotivo}</${p}xMotivo>`
    + `</${p}infProt></${p}protNFe></${p}retEnviNFe>`
    + '</nfeResultMsg></soap:Body></soap:Envelope>'
  );
}

describe('parseSefazResponse lê o protocolo mesmo com o atributo Id', () => {
  it('autorização da SVRS (<infProt Id=...>) é AUTHORIZED com o cStat e o protocolo DO DOCUMENTO', () => {
    const r = parseSefazResponse({
      body: retornoSvrs({ chave: CHAVE, cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '143260000000001' }),
      correlationId: CHAVE,
    });
    expect(r.outcome).toBe('AUTHORIZED');
    expect(r.cStat).toBe('100');
    expect(r.xMotivo).toBe('Autorizado o uso da NF-e');
    expect(r.protocol).toBe('143260000000001');
    expect(r.accessKey).toBe(CHAVE);
  });

  it('rejeição do documento com Id sai com o cStat da nota, não com o 104 do lote', () => {
    const r = parseSefazResponse({
      body: retornoSvrs({ chave: CHAVE, cStat: '225', xMotivo: 'Rejeicao: Falha no Schema XML da NFe' }),
      correlationId: CHAVE,
    });
    expect(r.outcome).toBe('REJECTED');
    expect(r.cStat).toBe('225');
    expect(r.xMotivo).toBe('Rejeicao: Falha no Schema XML da NFe');
    expect(r.protocol).toBeNull();
  });

  it('duplicidade (539) dentro de infProt Id= é DUPLICATE — a fila consulta em vez de reemitir', () => {
    const r = parseSefazResponse({
      body: retornoSvrs({ chave: CHAVE, cStat: '539', xMotivo: 'Rejeicao: Duplicidade de NF-e' }),
      correlationId: CHAVE,
    });
    expect(r.outcome).toBe('DUPLICATE');
    expect(r.cStat).toBe('539');
  });

  it('com prefixo de namespace (<nfe:infProt Id=...>) a leitura é a mesma', () => {
    const r = parseSefazResponse({
      body: retornoSvrs({
        chave: CHAVE,
        cStat: '100',
        xMotivo: 'Autorizado o uso da NF-e',
        nProt: '143260000000002',
        prefixo: 'nfe',
      }),
      correlationId: CHAVE,
    });
    expect(r.outcome).toBe('AUTHORIZED');
    expect(r.protocol).toBe('143260000000002');
  });

  it('a forma sem atributo continua valendo (o provider de teste e respostas antigas)', () => {
    const r = parseSefazResponse({
      body:
        '<retEnviNFe><cStat>104</cStat><protNFe><infProt>'
        + `<chNFe>${CHAVE}</chNFe><cStat>100</cStat><xMotivo>ok</xMotivo><nProt>143260000000003</nProt>`
        + '</infProt></protNFe></retEnviNFe>',
      correlationId: CHAVE,
    });
    expect(r.outcome).toBe('AUTHORIZED');
    expect(r.protocol).toBe('143260000000003');
  });

  it('tag vizinha de nome parecido (<infProtX>) não é tomada pelo protocolo', () => {
    const r = parseSefazResponse({
      body:
        '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
        + '<infProtX><cStat>100</cStat></infProtX></retEnviNFe>',
      correlationId: CHAVE,
    });
    // Sem infProt de verdade, vale o primeiro cStat — o do lote —, que NÃO autoriza.
    expect(r.cStat).toBe('104');
    expect(r.outcome).toBe('REJECTED');
  });
});

// ---------------------------------------------------------------------------
// De ponta a ponta na fila: o adapter REAL recebe o retorno da SVRS pelo
// transporte dublado, e o documento tem de terminar AUTORIZADO.
// ---------------------------------------------------------------------------

const DEST: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Comprador Atacado Ltda',
  ieIndicator: '1',
  ie: '987654321',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Industrial',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  zip: '96010000',
  uf: 'RS',
};

/** O A1 não é aberto aqui: o transporte é dublado e o XML "assinado" é um marcador. */
const CERT_FALSO = { cnpj: '11222333000181' } as unknown as ParsedCertificateA1;

let companyId: string;

function criarVenda(id: string): string {
  ensureCoreSchema();
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `C-${id}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, 1, 'completed', 100000, 0, 0, 100000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Patinete', 1, 100000, 0, 100000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'pix', 100000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'PJ Motors Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
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
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
});

describe('a fila aplica a autorização da SVRS', () => {
  it('retorno com <infProt Id=...> deixa o documento AUTHORIZED, com protocolo e cStat 100', async () => {
    const { document } = createNfeForSale({ companyId, saleId: criarVenda('v1'), recipient: DEST });
    validateDocument({ companyId, documentId: document.id });
    getConnection()
      .prepare("UPDATE core_fiscal_documents SET xml_signed = '<NFe><assinado/></NFe>' WHERE id = ?")
      .run(document.id);
    transition({ companyId, documentId: document.id, to: 'SIGNED' });
    enqueue({ companyId, documentId: document.id });

    const chave = getDocument(companyId, document.id)!.accessKey!;
    const enviados: string[] = [];
    const adapter = new SefazRealAdapter({
      cert: CERT_FALSO,
      postSoap: async ({ url, body }) => {
        enviados.push(url);
        void body;
        return {
          status: 200,
          body: retornoSvrs({ chave, cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '143260000004242' }),
        };
      },
    });

    await processNext({ companyId, adapter });

    const doc = getDocument(companyId, document.id)!;
    expect(enviados).toHaveLength(1);
    expect(doc.status).toBe('AUTHORIZED');
    expect(doc.protocol).toBe('143260000004242');
    expect(doc.cStat).toBe('100');
    expect(doc.xMotivo).toBe('Autorizado o uso da NF-e');
  });
});
