/**
 * O DANFCE DIZ QUANDO FOI EMITIDO, PARA QUEM, ONDE CONSULTAR — E A NOTA
 * CANCELADA CONTINUA SENDO A NOTA QUE FOI (auditoria do cupom, F-15).
 *
 * ============================================================================
 * O QUE ESTAVA IMPRESSO
 * ============================================================================
 *
 *   - só "Modelo · Série · Número" e a data do PROTOCOLO: nenhuma data de
 *     EMISSÃO. Na contingência off-line (o papel sai antes da autorização),
 *     nenhuma data;
 *   - nenhuma linha de consumidor (o CPF, ou "CONSUMIDOR NÃO IDENTIFICADO");
 *   - "Consulte ... no site da SEFAZ", sem o endereço de consulta da UF;
 *   - a nota cancelada de venda cancelada saía "Itens indisponíveis / TOTAL
 *     0,00" (a leitura da venda recusava venda que não estivesse concluída);
 *   - a hora da autorização no fuso da máquina do servidor.
 *
 * E a largura: o DANFCE também era fixo em 80 mm (F-07).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function criarVenda(id: string, cliente?: { nome: string; cpf: string }): string {
  ensureCoreSchema();
  numeroVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();

  let customerId: string | null = null;
  if (cliente) {
    customerId = `cli-${id}`;
    db.prepare(
      `INSERT INTO core_customers (id, company_id, name, document, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(customerId, companyId, cliente.nome, cliente.cpf, now, now);
  }

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Social', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `GS-${numeroVenda}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at, customer_id)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?, ?)`,
  ).run(id, companyId, numeroVenda, `k-${id}`, now, customerId);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Social', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

function ateAssinado(saleId: string) {
  const { document } = createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection().prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?").run(document.id);
  return transition({ companyId, documentId: document.id, to: 'SIGNED' });
}

async function ateAutorizado(saleId: string) {
  const doc = ateAssinado(saleId);
  enqueue({ companyId, documentId: doc.id });
  await processNext({ companyId, adapter: new SefazTestAdapter() });
  return getDocument(companyId, doc.id)!;
}

let tzAntes: string | undefined;

beforeEach(() => {
  tzAntes = process.env.TZ;
  resetDbForTests();
  numeroVenda = 0;
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
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

afterEach(() => {
  if (tzAntes === undefined) delete process.env.TZ;
  else process.env.TZ = tzAntes;
});

describe('a data de emissão', () => {
  it('o DANFCE autorizado diz quando a nota foi emitida', async () => {
    const doc = await ateAutorizado(criarVenda('e1'));
    expect(renderDanfce(companyId, doc.id)).toMatch(/Emissão: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
  });

  it('sem protocolo (a contingência, a prévia) a emissão continua no papel', () => {
    const doc = ateAssinado(criarVenda('e2'));
    const html = renderDanfce(companyId, doc.id, { allowUnauthorized: true });
    expect(html).toContain('SEM PROTOCOLO DE AUTORIZAÇÃO');
    expect(html).toMatch(/Emissão: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
  });

  it('emissão e autorização no relógio da loja, mesmo com o servidor em UTC', async () => {
    const doc = await ateAutorizado(criarVenda('e3'));
    const db = getConnection();
    // O instante da nota, fixado: 21:30 de 14/09 em Pelotas (00:30 UTC do dia 15).
    const original = (db.prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(doc.id) as {
      xml_original: string;
    }).xml_original;
    expect(original).toContain('<dhEmi>');
    db.prepare('UPDATE core_fiscal_documents SET xml_original = ?, authorized_at = ? WHERE id = ?').run(
      original.replace(/<dhEmi>[^<]*<\/dhEmi>/, '<dhEmi>2026-09-14T21:30:00-03:00</dhEmi>'),
      '2026-09-15T00:31:00.000Z',
      doc.id,
    );

    process.env.TZ = 'UTC';
    const html = renderDanfce(companyId, doc.id);
    expect(html).toContain('Emissão: 14/09/2026, 21:30:00');
    expect(html).toContain('14/09/2026, 21:31:00');
    expect(html).not.toContain('15/09/2026');
  });
});

describe('o consumidor', () => {
  it('sem CPF: CONSUMIDOR NÃO IDENTIFICADO', async () => {
    const doc = await ateAutorizado(criarVenda('c1'));
    expect(renderDanfce(companyId, doc.id)).toContain('CONSUMIDOR NÃO IDENTIFICADO');
  });

  it('com CPF: o CPF e o nome que a nota leva no <dest>', async () => {
    const doc = await ateAutorizado(criarVenda('c2', { nome: 'Maria Consumidora', cpf: '52998224725' }));
    const html = renderDanfce(companyId, doc.id);
    expect(html).toContain('CPF 529.982.247-25');
    expect(html).toContain('Maria Consumidora');
    expect(html).not.toContain('CONSUMIDOR NÃO IDENTIFICADO');
  });
});

describe('onde consultar', () => {
  it('com o QR da nota, o rodapé traz o endereço de consulta da UF (urlChave)', async () => {
    const doc = await ateAutorizado(criarVenda('u1'));
    const db = getConnection();
    // O XML assinado de verdade carrega o infNFeSupl; o helper o troca por um marcador.
    const original = (db.prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(doc.id) as {
      xml_original: string;
    }).xml_original;
    db.prepare('UPDATE core_fiscal_documents SET xml_signed = ? WHERE id = ?').run(original, doc.id);

    const html = renderDanfce(companyId, doc.id);
    expect(html).toContain('Consulte pela chave de acesso em');
    expect(html).toContain('https://dfe-portal.svrs.rs.gov.br/nfce/consulta');
  });
});

describe('a nota cancelada', () => {
  it('de venda cancelada reimprime com os itens e o TOTAL da nota — não "TOTAL 0,00"', async () => {
    const saleId = criarVenda('x1');
    const doc = await ateAutorizado(saleId);
    const db = getConnection();
    db.prepare("UPDATE core_sales SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(new Date().toISOString(), saleId);
    db.prepare("UPDATE core_fiscal_documents SET status = 'CANCELLED' WHERE id = ?").run(doc.id);

    const html = renderDanfce(companyId, doc.id);
    expect(html).toContain('NFC-e CANCELADA');
    expect(html).toContain('Camisa Social');
    expect(html).not.toContain('Itens indisponíveis');
    expect(html).toMatch(/TOTAL<\/td><td class="r">100,00/);
  });
});

describe('a bobina', () => {
  it('DANFCE na impressora de 58 mm sai em 58 mm; sem largura, 80 mm', async () => {
    const doc = await ateAutorizado(criarVenda('b1'));
    const estreito = renderDanfce(companyId, doc.id, { larguraMm: 58 });
    expect(estreito).toContain('size: 58mm auto');
    // Corpo dentro dos ~48 mm que a cabeça térmica de 58 imprime.
    expect(estreito).toContain('width: 48mm');
    expect(renderDanfce(companyId, doc.id)).toContain('size: 80mm auto');
  });
});
