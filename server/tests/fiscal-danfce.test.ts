/**
 * DANFCE — a representação impressa da NFC-e.
 *
 * O risco que estes testes cobrem não é estético: é entregar ao cliente um
 * papel que PARECE nota fiscal sem haver nota. Documento não autorizado tem
 * que sair marcado, e cupom de teste tem que dizer que é de teste.
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
  getDocument,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let companyId: string;
let numeroVenda = 0;

function criarVenda(id: string): string {
  ensureCoreSchema();
  numeroVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Social', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `GS-${numeroVenda}`, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 500, ?)`,
  ).run(id, companyId, numeroVenda, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Social', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10500, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);

  return id;
}

function ateAssinado(saleId: string) {
  const { document } = createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  return transition({ companyId, documentId: document.id, to: 'SIGNED' });
}

async function ateAutorizado(saleId: string) {
  const doc = ateAssinado(saleId);
  enqueue({ companyId, documentId: doc.id });
  await processNext({ companyId, adapter: new SefazTestAdapter() });
  return getDocument(companyId, doc.id)!;
}

beforeEach(() => {
  resetDbForTests();
  numeroVenda = 0;
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
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
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
});

describe('DANFCE de documento autorizado', () => {
  it('traz emitente, itens, totais, pagamento e troco', async () => {
    const doc = await ateAutorizado(criarVenda('s1'));
    const html = renderDanfce(companyId, doc.id);

    expect(html).toContain('Preço Justo Comércio Ltda');
    expect(html).toContain('11.222.333/0001-81');
    expect(html).toContain('Camisa Social');
    expect(html).toContain('100,00'); // total
    expect(html).toContain('Dinheiro');
    expect(html).toContain('105,00'); // pago
    expect(html).toContain('5,00'); // troco
  });

  it('traz modelo, série, número, chave, protocolo e QR', async () => {
    const doc = await ateAutorizado(criarVenda('s2'));
    const html = renderDanfce(companyId, doc.id);

    expect(html).toContain('Modelo 65');
    expect(html).toContain(`Série ${doc.serie}`);
    expect(html).toContain(`Número ${doc.number}`);
    expect(html).toContain('Protocolo de autorização');
    expect(html).toContain(doc.protocol!);
    // A chave sai em blocos de 4 — é assim que alguém consegue digitar.
    expect(html).toMatch(/\d{4} \d{4} \d{4}/);
    expect(html).toContain('<svg');
  });

  /** Cupom emitido pelo provider de teste não pode passar por documento real. */
  it('cupom do provider de teste sai com tarja inconfundível', async () => {
    const doc = await ateAutorizado(criarVenda('s3'));
    const html = renderDanfce(companyId, doc.id);

    expect(html).toContain('AMBIENTE DE TESTE');
    expect(html).toContain('NÃO É DOCUMENTO FISCAL HOMOLOGADO');
    // A tarja vem antes do nome da empresa: quem entrega o papel vê primeiro.
    expect(html.indexOf('AMBIENTE DE TESTE')).toBeLessThan(
      html.indexOf('Preço Justo Comércio Ltda'),
    );
  });

  it('sem CSC, o QR é declarado como conferência interna', async () => {
    const doc = await ateAutorizado(criarVenda('s4'));
    const html = renderDanfce(companyId, doc.id);
    expect(html).toContain('QR de conferência interna');
    expect(html).toContain('exige CSC configurado');
  });

  it('não vaza CSC nem segredo nenhum', async () => {
    const doc = await ateAutorizado(criarVenda('s5'));
    const html = renderDanfce(companyId, doc.id);
    expect(html).not.toMatch(/cscToken|cIdToken|cHashQRCode|PRIVATE KEY|\.pfx/i);
  });
});

describe('DANFCE de documento NÃO autorizado', () => {
  it('é recusado por padrão', () => {
    const doc = ateAssinado(criarVenda('s6'));
    expect(() => renderDanfce(companyId, doc.id)).toThrow(/só existe para documento autorizado/i);
  });

  it('a recusa diz em que estado o documento está', () => {
    const doc = ateAssinado(criarVenda('s7'));
    expect(() => renderDanfce(companyId, doc.id)).toThrow(/SIGNED/);
  });

  /** Preview técnico existe — para diagnosticar —, mas sai marcado. */
  it('preview técnico sai com tarja de NÃO AUTORIZADO', () => {
    const doc = ateAssinado(criarVenda('s8'));
    const html = renderDanfce(companyId, doc.id, { allowUnauthorized: true });

    expect(html).toContain('DOCUMENTO NÃO AUTORIZADO');
    expect(html).toContain('SIGNED');
    expect(html).toContain('SEM PROTOCOLO DE AUTORIZAÇÃO');
  });

  it('documento rejeitado mostra o motivo na tarja', async () => {
    const doc = ateAssinado(criarVenda('s9'));
    enqueue({ companyId, documentId: doc.id });
    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await processNext({ companyId, adapter });

    const html = renderDanfce(companyId, doc.id, { allowUnauthorized: true });
    expect(html).toContain('DOCUMENTO NÃO AUTORIZADO');
    expect(html).toContain('REJECTED');
    expect(html).toContain('Duplicidade');
    expect(html).not.toContain('Protocolo de autorização');
  });

  it('rascunho também é recusado', () => {
    const { document } = createNfceForSale({ companyId, saleId: criarVenda('s10') });
    expect(() => renderDanfce(companyId, document.id)).toThrow();
  });
});

describe('reimpressão não recria nada', () => {
  it('imprimir duas vezes mantém uma venda, um documento, um número', async () => {
    const saleId = criarVenda('s11');
    const doc = await ateAutorizado(saleId);
    const db = getConnection();

    const antes = {
      vendas: (db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c,
      docs: (db.prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents').get() as { c: number })
        .c,
      estoque: (db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number })
        .c,
      financeiro: (
        db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }
      ).c,
    };

    const primeira = renderDanfce(companyId, doc.id);
    const segunda = renderDanfce(companyId, doc.id);

    // O papel é o mesmo: mesma chave, mesmo protocolo, mesmo número.
    expect(segunda).toBe(primeira);

    expect((db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c).toBe(
      antes.vendas,
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents').get() as { c: number }).c,
    ).toBe(antes.docs);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number }).c,
    ).toBe(antes.estoque);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }).c,
    ).toBe(antes.financeiro);

    const atual = getDocument(companyId, doc.id)!;
    expect(atual.number).toBe(doc.number);
    expect(atual.accessKey).toBe(doc.accessKey);
    expect(atual.status).toBe('AUTHORIZED');
  });
});

describe('isolamento', () => {
  it('documento de outra operação não é impresso', async () => {
    const doc = await ateAutorizado(criarVenda('s12'));
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(() => renderDanfce(outra, doc.id)).toThrow(/não encontrado/i);
  });
});
