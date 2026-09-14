/**
 * NF-e modelo 55: criação do documento e DANFE.
 *
 * O risco coberto aqui é o mesmo do DANFCE — entregar um papel que parece nota
 * fiscal sem haver nota — mais um que só a NF-e tem: a numeração 55 não pode
 * se misturar com a 65, senão as duas sequências ganham buracos, e buraco em
 * numeração fiscal é pergunta do fisco.
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
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { renderDanfe } from '../src/services/core/DanfeRenderer.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const DEST: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Comprador Atacado Ltda',
  ieIndicator: '1',
  ie: '987654321',
  street: 'Rua do Comércio',
  number: '500',
  complement: 'Sala 2',
  district: 'Industrial',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '68900-100',
};

let companyId: string;
let n = 0;

function criarVenda(id: string): string {
  ensureCoreSchema();
  n += 1;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Patinete Urban 350W', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `PJ-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 200000, 0, 0, 200000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Patinete Urban 350W', 2, 100000, 0, 200000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'pix', 200000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

async function nfeAutorizada(saleId: string) {
  const { document } = createNfeForSale({ companyId, saleId, recipient: DEST });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  await processNext({ companyId, adapter: new SefazTestAdapter() });
  return getDocument(companyId, document.id)!;
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
  companyId = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'PJ Motors Comércio Ltda',
      tradeName: 'PJ Motors',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      zip: '68900-000',
      street: 'Av. das Motos',
      number: '1000',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
});

describe('criação da NF-e 55', () => {
  it('cria em DRAFT, com chave de modelo 55', () => {
    const { document, created } = createNfeForSale({
      companyId,
      saleId: criarVenda('v1'),
      recipient: DEST,
    });

    expect(created).toBe(true);
    expect(document.model).toBe('55');
    expect(document.status).toBe('DRAFT');
    expect(document.accessKey!.slice(20, 22)).toBe('55');
  });

  /** Numeração separada: 55 e 65 não compartilham contador. */
  it('a numeração 55 é independente da 65', () => {
    const nfce = createNfceForSale({ companyId, saleId: criarVenda('v2') });
    const nfe = createNfeForSale({ companyId, saleId: criarVenda('v3'), recipient: DEST });

    expect(nfce.document.number).toBe(1);
    expect(nfe.document.number).toBe(1);
    expect(nfce.document.model).toBe('65');
    expect(nfe.document.model).toBe('55');
  });

  it('a MESMA venda pode ter cupom e nota sem um atropelar o outro', () => {
    const saleId = criarVenda('v4');
    const nfce = createNfceForSale({ companyId, saleId });
    const nfe = createNfeForSale({ companyId, saleId, recipient: DEST });

    expect(nfce.document.id).not.toBe(nfe.document.id);
    expect(nfce.document.model).toBe('65');
    expect(nfe.document.model).toBe('55');
  });

  it('cem tentativas produzem UMA NF-e', () => {
    const saleId = criarVenda('v5');
    const r = Array.from({ length: 100 }, () =>
      createNfeForSale({ companyId, saleId, recipient: DEST }),
    );
    expect(new Set(r.map((x) => x.document.id)).size).toBe(1);
    expect(r.filter((x) => x.created).length).toBe(1);
  });

  it('destinatário inválido bloqueia ANTES de queimar número', () => {
    const saleId = criarVenda('v6');
    const antes = getConnection()
      .prepare("SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = '55'")
      .get(companyId) as { next_number: number };

    expect(() =>
      createNfeForSale({
        companyId,
        saleId,
        recipient: { ...DEST, document: '123' },
      }),
    ).toThrow(/destinatário/i);

    const depois = getConnection()
      .prepare("SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = '55'")
      .get(companyId) as { next_number: number };
    expect(depois.next_number).toBe(antes.next_number);
  });
});

describe('DANFE de documento autorizado', () => {
  it('traz emitente, destinatário, itens e totais lidos do XML', async () => {
    const doc = await nfeAutorizada(criarVenda('v7'));
    const html = renderDanfe(companyId, doc.id);

    expect(html).toContain('PJ Motors Comércio Ltda');
    expect(html).toContain('11.222.333/0001-81');
    expect(html).toContain('Comprador Atacado Ltda');
    expect(html).toContain('11.444.777/0001-61');
    expect(html).toContain('Patinete Urban 350W');
    expect(html).toContain('87116000'); // NCM
    expect(html).toContain('5102'); // CFOP
    expect(html).toContain('2.000,00'); // total
    expect(html).toContain('DANFE');
  });

  it('mostra modelo, série, número, chave e protocolo', async () => {
    const doc = await nfeAutorizada(criarVenda('v8'));
    const html = renderDanfe(companyId, doc.id);

    expect(html).toContain(`Nº <strong>${doc.number}</strong>`);
    expect(html).toContain(doc.protocol!);
    expect(html).toMatch(/\d{4} \d{4} \d{4}/);
  });

  /** Cupom de teste não pode passar por documento real. */
  it('documento do provider de teste sai com tarja, antes de tudo', async () => {
    const doc = await nfeAutorizada(criarVenda('v9'));
    const html = renderDanfe(companyId, doc.id);

    expect(html).toContain('AMBIENTE DE TESTE');
    expect(html).toContain('NÃO É DOCUMENTO FISCAL HOMOLOGADO');
    expect(html.indexOf('AMBIENTE DE TESTE')).toBeLessThan(
      html.indexOf('PJ Motors Comércio Ltda'),
    );
  });

  it('não vaza segredo', async () => {
    const doc = await nfeAutorizada(criarVenda('v10'));
    const html = renderDanfe(companyId, doc.id);
    expect(html).not.toMatch(/cscToken|privateKey|PRIVATE KEY|\.pfx/i);
  });

  /**
   * O DANFE lê o XML, não o cadastro. Se o emitente mudar de endereço, a
   * segunda via de uma nota antiga precisa continuar mostrando o endereço
   * daquela nota.
   */
  it('mudar o cadastro NÃO altera o DANFE de uma nota já emitida', async () => {
    const doc = await nfeAutorizada(criarVenda('v11'));
    const antes = renderDanfe(companyId, doc.id);
    expect(antes).toContain('Av. das Motos');

    updateFiscalConfig({ companyId, patch: { street: 'Rua Nova' } });

    const depois = renderDanfe(companyId, doc.id);
    expect(depois).toContain('Av. das Motos');
    expect(depois).not.toContain('Rua Nova');
  });
});

describe('DANFE de documento NÃO autorizado', () => {
  it('é recusado por padrão, dizendo o estado', () => {
    const { document } = createNfeForSale({
      companyId,
      saleId: criarVenda('v12'),
      recipient: DEST,
    });
    expect(() => renderDanfe(companyId, document.id)).toThrow(/DRAFT/);
  });

  it('preview técnico sai com tarja de NÃO AUTORIZADO', () => {
    const { document } = createNfeForSale({
      companyId,
      saleId: criarVenda('v13'),
      recipient: DEST,
    });
    const html = renderDanfe(companyId, document.id, { allowUnauthorized: true });
    expect(html).toContain('DOCUMENTO NÃO AUTORIZADO');
    expect(html).toContain('SEM PROTOCOLO DE AUTORIZAÇÃO');
  });

  it('NFC-e não gera DANFE — é outro modelo', () => {
    const { document } = createNfceForSale({ companyId, saleId: criarVenda('v14') });
    expect(() => renderDanfe(companyId, document.id)).toThrow(/modelo 55/i);
  });
});

describe('impressão e reimpressão', () => {
  it('o PrintEngine entrega o DANFE do documento', async () => {
    const doc = await nfeAutorizada(criarVenda('v15'));
    const html = renderDocument(companyId, 'DANFE', doc.id);
    expect(html).toContain('DANFE');
    expect(html).toContain('Comprador Atacado Ltda');
  });

  it('reimprimir devolve o MESMO papel e não recria nada', async () => {
    const saleId = criarVenda('v16');
    const doc = await nfeAutorizada(saleId);
    const db = getConnection();
    const conta = (t: string) => Number((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);
    const antes = {
      vendas: conta('core_sales'),
      docs: conta('core_fiscal_documents'),
      estoque: conta('core_stock_movements'),
      financeiro: conta('core_finance_entries'),
    };

    const primeira = renderDanfe(companyId, doc.id);
    const segunda = renderDanfe(companyId, doc.id);
    expect(segunda).toBe(primeira);

    expect(conta('core_sales')).toBe(antes.vendas);
    expect(conta('core_fiscal_documents')).toBe(antes.docs);
    expect(conta('core_stock_movements')).toBe(antes.estoque);
    expect(conta('core_finance_entries')).toBe(antes.financeiro);

    const atual = getDocument(companyId, doc.id)!;
    expect(atual.number).toBe(doc.number);
    expect(atual.accessKey).toBe(doc.accessKey);
  });
});

describe('isolamento', () => {
  it('documento de outra operação não é impresso', async () => {
    const doc = await nfeAutorizada(criarVenda('v17'));
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(() => renderDanfe(outra, doc.id)).toThrow(/não encontrado/i);
  });
});
