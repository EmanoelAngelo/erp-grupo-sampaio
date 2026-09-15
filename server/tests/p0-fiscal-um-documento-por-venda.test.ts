/**
 * P0 FISCAL — UMA VENDA, UM DOCUMENTO QUE VALE (homologação SIMULADA).
 *
 *  - clique duplo (e cem cliques) não cria segundo documento nem queima número;
 *  - a mesma venda não fica com NFC-e E NF-e valendo ao mesmo tempo: a troca de
 *    documento passa pelo cancelamento do outro;
 *  - documento rejeitado ou cancelado não documenta nada e não bloqueia.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
} from '../src/services/core/FiscalDocumentService.js';
import { emitNfceForSale, emissionReadinessForSale } from '../src/services/core/FiscalPipelineService.js';
import { listQueue } from '../src/services/core/FiscalQueueService.js';
import { requestCancel } from '../src/services/core/FiscalEventsService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

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

describe('idempotência — clique duplo', () => {
  it('dois cliques simultâneos em "Emitir NFC-e": um documento, um número, um item na fila', async () => {
    const saleId = venda();
    const [a, b] = await Promise.all([
      emitNfceForSale({ companyId: empresa, saleId, developmentMode: true }),
      emitNfceForSale({ companyId: empresa, saleId, developmentMode: true }),
    ]);
    expect(b.document.id).toBe(a.document.id);
    expect(proximoNumero('65')).toBe(2);
    expect(listQueue(empresa)).toHaveLength(1);
    const docs = getConnection()
      .prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents WHERE company_id = ? AND sale_id = ?')
      .get(empresa, saleId) as { c: number };
    expect(Number(docs.c)).toBe(1);
  });

  it('emitir de novo depois de autorizada devolve a MESMA nota — não há segunda transmissão', async () => {
    const saleId = venda();
    const primeira = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true });
    expect(primeira.document.status).toBe('AUTHORIZED');
    const segunda = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true });
    expect(segunda.document.id).toBe(primeira.document.id);
    expect(segunda.document.protocol).toBe(primeira.document.protocol);
    expect(proximoNumero('65')).toBe(2);
  });
});

describe('a mesma venda não fica documentada duas vezes', () => {
  it('NFC-e em andamento bloqueia a NF-e da mesma venda — e nenhum número 55 é reservado', () => {
    const saleId = venda();
    createNfceForSale({ companyId: empresa, saleId });
    expect(() => createNfeForSale({ companyId: empresa, saleId, recipient: CONTRIBUINTE_RS })).toThrow(
      /já tem NFC-e/,
    );
    expect(proximoNumero('55')).toBe(1);
  });

  it('NF-e da venda bloqueia a NFC-e — e o painel do PDV diz por quê antes do clique', () => {
    const saleId = venda();
    createNfeForSale({ companyId: empresa, saleId, recipient: CONTRIBUINTE_RS });
    const prontidao = emissionReadinessForSale(empresa, saleId);
    expect(prontidao.canEmit).toBe(false);
    expect(prontidao.reasons.join(' ')).toMatch(/já tem NF-e/);
    expect(() => createNfceForSale({ companyId: empresa, saleId })).toThrow(/já tem NF-e/);
    expect(proximoNumero('65')).toBe(1);
  });

  it('cupom CANCELADO libera a NF-e (a troca de documento legítima)', async () => {
    const saleId = venda();
    const cupom = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true });
    const cancelado = await requestCancel({
      companyId: empresa,
      documentId: cupom.document.id,
      justification: 'Cliente pediu NF-e com CNPJ no lugar do cupom',
      adapter: new SefazTestAdapter(),
    });
    expect(cancelado.accepted).toBe(true);
    const { document, created } = createNfeForSale({ companyId: empresa, saleId, recipient: CONTRIBUINTE_RS });
    expect(created).toBe(true);
    expect(document.model).toBe('55');
  });

  it('cupom REJEITADO não documenta nada e não bloqueia', async () => {
    const saleId = venda();
    const cupom = await emitNfceForSale({
      companyId: empresa,
      saleId,
      developmentMode: true,
      testScenario: 'REJECTED',
    });
    expect(getDocument(empresa, cupom.document.id)!.status).toBe('REJECTED');
    expect(() => createNfeForSale({ companyId: empresa, saleId, recipient: CONTRIBUINTE_RS })).not.toThrow();
  });
});
