/**
 * P0 FISCAL — REJEIÇÃO NÃO QUEIMA NÚMERO; INUTILIZAÇÃO SÓ DO QUE A SEFAZ NÃO CONSUMIU
 * (homologação SIMULADA).
 *
 * Os defeitos presos aqui:
 *  - `REJECTED → DRAFT` existia na tabela e ninguém a percorria: a venda com
 *    NFC-e rejeitada ficava rejeitada para sempre (a emissão é idempotente por
 *    venda e devolvia o documento rejeitado);
 *  - a inutilização recusava QUALQUER número com documento — inclusive o da
 *    rejeitada, que a SEFAZ não consumiu: o buraco não tinha como ser
 *    justificado;
 *  - `enqueue` não devolvia à fila o documento assinado de novo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  createNfeForSale,
  getDocument,
  listDocumentEvents,
  transition,
} from '../src/services/core/FiscalDocumentService.js';
import { advanceDocument, emitNfceForSale } from '../src/services/core/FiscalPipelineService.js';
import { listQueue } from '../src/services/core/FiscalQueueService.js';
import { requestVoidRange } from '../src/services/core/FiscalEventsService.js';
import { reemitirRejeitada } from '../src/services/core/FiscalReemissao.js';
import { parseSefazResponse, type AuthorizeRequest, type SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

/** O simulador que responde UMA vez com o cStat pedido e depois autoriza. */
class RespondeUmaVez extends SefazTestAdapter {
  private usado = false;

  constructor(
    private readonly cStat: string,
    private readonly xMotivo: string,
    private readonly comProtocolo = false,
  ) {
    super();
  }

  override async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    if (this.usado) return super.authorize(input);
    this.usado = true;
    return parseSefazResponse({
      body:
        `<retEnviNFe><protNFe><infProt><chNFe>${input.accessKey}</chNFe><cStat>${this.cStat}</cStat>`
        + `<xMotivo>${this.xMotivo}</xMotivo>${this.comProtocolo ? '' : ''}</infProt></protNFe></retEnviNFe>`,
      correlationId: randomUUID(),
    });
  }
}

let empresa: string;
let n = 0;

const CONTRIBUINTE_RS: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Oficina Parceira Ltda',
  ieIndicator: '1',
  ie: '0960123456',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Fragata',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96040000',
};

function venda(): string {
  ensureCoreSchema();
  n += 1;
  const id = `venda-${n}`;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `PJ-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);
  return id;
}

function proximoNumero(model: '55' | '65'): number {
  return Number(
    (getConnection()
      .prepare('SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = 1')
      .get(empresa, model) as { next_number: number }).next_number,
  );
}

async function nfceRejeitada(cStat = '778', xMotivo = 'Rejeicao: Informado NCM inexistente') {
  const saleId = venda();
  const r = await emitNfceForSale({
    companyId: empresa,
    saleId,
    developmentMode: true,
    adapter: new RespondeUmaVez(cStat, xMotivo),
  });
  return { saleId, doc: getDocument(empresa, r.document.id)! };
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960123456',
      crt: '1',
      street: 'Rua XV de Novembro',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96015000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(empresa);
  setSeriesNextNumber({ companyId: empresa, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 1 });
});

describe('rejeição não queima número — a nota se corrige e sai com o MESMO número', () => {
  it('NFC-e rejeitada volta a DRAFT com o mesmo número e chave nova, e é autorizada; a sequência não anda', async () => {
    const { doc } = await nfceRejeitada();
    expect(doc.status).toBe('REJECTED');
    expect(doc.cStat).toBe('778');
    expect(proximoNumero('65')).toBe(2);

    const r = reemitirRejeitada({ companyId: empresa, documentId: doc.id });
    expect(r.document.status).toBe('DRAFT');
    expect(r.document.number).toBe(doc.number);
    expect(r.document.serie).toBe(doc.serie);
    expect(r.document.accessKey).not.toBe(doc.accessKey);
    expect(r.document.cStat).toBeNull();
    expect(proximoNumero('65')).toBe(2);

    const fim = await advanceDocument(doc.id, { companyId: empresa, developmentMode: true, adapter: new SefazTestAdapter() }, true);
    expect(fim.document.status).toBe('AUTHORIZED');
    expect(fim.document.number).toBe(1);
    expect(fim.document.protocol).toBeTruthy();
    // Um item de fila só — reaberto, não duplicado.
    expect(listQueue(empresa)).toHaveLength(1);
    expect(listQueue(empresa)[0].status).toBe('done');
    // O histórico guarda a tentativa rejeitada.
    const reabertura = listDocumentEvents(empresa, doc.id).find((e) => e.eventType === 'status:REJECTED->DRAFT');
    expect(reabertura?.detail).toContain(doc.accessKey!);
    expect(reabertura?.detail).toContain('778');
  });

  it('NF-e rejeitada reemite com o destinatário lido da própria nota', async () => {
    const saleId = venda();
    const { document } = createNfeForSale({ companyId: empresa, saleId, recipient: CONTRIBUINTE_RS });
    await advanceDocument(document.id, { companyId: empresa, developmentMode: true, adapter: new RespondeUmaVez('778', 'NCM') }, true);
    expect(getDocument(empresa, document.id)!.status).toBe('REJECTED');

    const r = reemitirRejeitada({ companyId: empresa, documentId: document.id });
    expect(r.numero).toBe(document.number);
    const xml = String(
      (getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(document.id) as {
        xml_original: string;
      }).xml_original,
    );
    expect(xml).toContain('<CNPJ>11444777000161</CNPJ>');
    expect(xml).toContain('<IE>0960123456</IE>');
    expect(proximoNumero('55')).toBe(2);
  });

  it('nota em ERRO que nunca saiu (autoconferência) também se reemite com o mesmo número', () => {
    const { document } = createNfceForSale({ companyId: empresa, saleId: venda() });
    transition({ companyId: empresa, documentId: document.id, to: 'ERROR', patch: { x_motivo: 'leiaute' } });
    const r = reemitirRejeitada({ companyId: empresa, documentId: document.id });
    expect(r.document.status).toBe('DRAFT');
    expect(r.numero).toBe(document.number);
  });

  it('erro de nota que JÁ FOI transmitida exige consulta — não reemite às cegas', async () => {
    const saleId = venda();
    // "Autorizado" sem protocolo: resposta malformada → ERROR depois de SENDING.
    const r = await emitNfceForSale({
      companyId: empresa,
      saleId,
      developmentMode: true,
      adapter: new RespondeUmaVez('100', 'Autorizado sem protocolo'),
    });
    expect(getDocument(empresa, r.document.id)!.status).toBe('ERROR');
    expect(() => reemitirRejeitada({ companyId: empresa, documentId: r.document.id })).toThrow(/Consulte a chave/);
  });

  it('denegada é final; duplicidade (539) exige consulta; autorizada não se reemite', async () => {
    const denegada = await nfceRejeitada('110', 'Uso Denegado');
    expect(() => reemitirRejeitada({ companyId: empresa, documentId: denegada.doc.id })).toThrow(/denegado/i);

    const duplicada = await nfceRejeitada('539', 'Duplicidade de NF-e com diferenca na chave de acesso');
    expect(() => reemitirRejeitada({ companyId: empresa, documentId: duplicada.doc.id })).toThrow(/duplicidade/i);

    const saleId = venda();
    const autorizada = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true });
    expect(() => reemitirRejeitada({ companyId: empresa, documentId: autorizada.document.id })).toThrow(
      /Só nota rejeitada/,
    );
  });
});

describe('inutilização — só número que a SEFAZ não consumiu', () => {
  it('o número da rejeitada abandonada se inutiliza; depois disso ele não volta', async () => {
    const { doc } = await nfceRejeitada();
    const r = await requestVoidRange({
      companyId: empresa,
      model: '65',
      serie: 1,
      from: doc.number,
      to: doc.number,
      justification: 'Venda devolvida antes da correção da nota rejeitada',
      adapter: new SefazTestAdapter(),
    });
    expect(r.accepted).toBe(true);
    expect(() => reemitirRejeitada({ companyId: empresa, documentId: doc.id })).toThrow(/inutilizado/);
    // A sequência não andou para trás nem para frente por causa disso.
    expect(proximoNumero('65')).toBe(2);
  });

  it('o número de nota AUTORIZADA não se inutiliza', async () => {
    const autorizada = await emitNfceForSale({ companyId: empresa, saleId: venda(), developmentMode: true });
    await expect(
      requestVoidRange({
        companyId: empresa,
        model: '65',
        serie: 1,
        from: autorizada.document.number,
        to: autorizada.document.number,
        justification: 'Tentativa indevida de inutilizar nota autorizada',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/já emitido/);
  });

  it('o número de nota denegada ou duplicada (consumido na SEFAZ) também não se inutiliza', async () => {
    const denegada = await nfceRejeitada('110', 'Uso Denegado');
    await expect(
      requestVoidRange({
        companyId: empresa,
        model: '65',
        serie: 1,
        from: denegada.doc.number,
        to: denegada.doc.number,
        justification: 'Tentativa de inutilizar número denegado',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/já emitido/);
  });
});
