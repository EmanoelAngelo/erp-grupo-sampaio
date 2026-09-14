/**
 * Máquina de estados e idempotência do documento fiscal.
 *
 * O teste que mais importa aqui é o da concorrência: cem tentativas de emitir
 * a MESMA venda têm que produzir UM documento, UM número e UMA chave.
 * Documento duplicado significa dois números fiscais queimados para a mesma
 * venda — e número queimado só se resolve por inutilização.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  createNfceForSale,
  getDocument,
  listDocumentEvents,
  transition,
  validateDocument,
  type FiscalStatus,
} from '../src/services/core/FiscalDocumentService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let companyId: string;

/** Cria uma venda concluída, com item fiscalmente completo. */
let proximoNumeroVenda = 0;

function criarVenda(id: string, totalCents = 10_000): string {
  ensureCoreSchema();
  proximoNumeroVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(`prod-${id}`, companyId, `GS-${proximoNumeroVenda}`, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key,
                             change_cents, created_at)
     VALUES (?, ?, ?, 'completed', ?, 0, 0, ?, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, proximoNumeroVenda, totalCents, totalCents, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, ?, 0, ?)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`, totalCents / 2, totalCents);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', ?, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, totalCents, now);

  return id;
}

beforeEach(() => {
  resetDbForTests();
  proximoNumeroVenda = 0;
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

describe('transições', () => {
  it('AUTHORIZED nunca volta para DRAFT', () => {
    expect(canTransition('AUTHORIZED', 'DRAFT')).toBe(false);
    expect(canTransition('AUTHORIZED', 'VALIDATED')).toBe(false);
    expect(canTransition('AUTHORIZED', 'SIGNED')).toBe(false);
    // O único destino de uma nota autorizada é o cancelamento.
    expect(ALLOWED_TRANSITIONS.AUTHORIZED).toEqual(['CANCELLED']);
  });

  it('CANCELLED é terminal', () => {
    expect(ALLOWED_TRANSITIONS.CANCELLED).toEqual([]);
    expect(canTransition('CANCELLED', 'AUTHORIZED')).toBe(false);
  });

  it('REJECTED não vira autorizada; volta ao rascunho para correção', () => {
    expect(canTransition('REJECTED', 'AUTHORIZED')).toBe(false);
    expect(canTransition('REJECTED', 'DRAFT')).toBe(true);
  });

  it('o caminho feliz é o declarado', () => {
    expect(canTransition('DRAFT', 'VALIDATED')).toBe(true);
    expect(canTransition('VALIDATED', 'SIGNED')).toBe(true);
    expect(canTransition('SIGNED', 'QUEUED')).toBe(true);
    expect(canTransition('QUEUED', 'SENDING')).toBe(true);
    expect(canTransition('SENDING', 'AUTHORIZED')).toBe(true);
    expect(canTransition('SENDING', 'REJECTED')).toBe(true);
  });

  it('pular etapa é recusado', () => {
    expect(canTransition('DRAFT', 'AUTHORIZED')).toBe(false);
    expect(canTransition('DRAFT', 'SIGNED')).toBe(false);
    expect(canTransition('VALIDATED', 'AUTHORIZED')).toBe(false);
  });

  it('a recusa acontece de verdade, não só na tabela', () => {
    const saleId = criarVenda('s1');
    const { document } = createNfceForSale({ companyId, saleId });

    expect(() =>
      transition({ companyId, documentId: document.id, to: 'AUTHORIZED' }),
    ).toThrow(/não pode ir para AUTHORIZED/);

    expect(getDocument(companyId, document.id)!.status).toBe('DRAFT');
  });

  it('cada transição fica registrada, append-only', () => {
    const saleId = criarVenda('s2');
    const { document } = createNfceForSale({ companyId, saleId });
    validateDocument({ companyId, documentId: document.id });
    transition({ companyId, documentId: document.id, to: 'SIGNED' });

    const eventos = listDocumentEvents(companyId, document.id);
    const tipos = eventos.map((e) => e.eventType);
    expect(tipos).toContain('status:DRAFT->VALIDATED');
    expect(tipos).toContain('status:VALIDATED->SIGNED');
    expect(eventos.length).toBeGreaterThanOrEqual(3);
  });
});

describe('criação e idempotência', () => {
  it('cria o documento em DRAFT, com chave e número', () => {
    const saleId = criarVenda('s3');
    const { document, created } = createNfceForSale({ companyId, saleId });

    expect(created).toBe(true);
    expect(document.status).toBe('DRAFT');
    expect(document.model).toBe('65');
    expect(document.number).toBe(1);
    expect(document.accessKey).toMatch(/^\d{44}$/);
    expect(document.saleId).toBe(saleId);
    // Emitir em homologação por padrão.
    expect(document.environment).toBe('homologation');
  });

  it('a segunda chamada devolve o MESMO documento, sem novo número', () => {
    const saleId = criarVenda('s4');
    const primeira = createNfceForSale({ companyId, saleId });
    const segunda = createNfceForSale({ companyId, saleId });

    expect(segunda.created).toBe(false);
    expect(segunda.document.id).toBe(primeira.document.id);
    expect(segunda.document.number).toBe(primeira.document.number);
    expect(segunda.document.accessKey).toBe(primeira.document.accessKey);
  });

  /**
   * O clique duplo — e o caixa impaciente que clica dez vezes.
   */
  it('cem tentativas na mesma venda produzem UM documento, UM número, UMA chave', () => {
    const saleId = criarVenda('s5');

    const resultados = Array.from({ length: 100 }, () =>
      createNfceForSale({ companyId, saleId }),
    );

    const ids = new Set(resultados.map((r) => r.document.id));
    const numeros = new Set(resultados.map((r) => r.document.number));
    const chaves = new Set(resultados.map((r) => r.document.accessKey));

    expect(ids.size).toBe(1);
    expect(numeros.size).toBe(1);
    expect(chaves.size).toBe(1);
    expect(resultados.filter((r) => r.created).length).toBe(1);

    const linhas = getConnection()
      .prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents WHERE sale_id = ?')
      .get(saleId) as { c: number };
    expect(Number(linhas.c)).toBe(1);
  });

  it('emitir não cria venda, não move estoque e não gera receita', () => {
    const saleId = criarVenda('s6');
    const db = getConnection();
    const antes = {
      vendas: (db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c,
      movimentos: (
        db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number }
      ).c,
      financeiro: (
        db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }
      ).c,
    };

    createNfceForSale({ companyId, saleId });

    expect((db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c).toBe(
      antes.vendas,
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number }).c,
    ).toBe(antes.movimentos);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }).c,
    ).toBe(antes.financeiro);
  });

  it('vendas diferentes recebem números diferentes', () => {
    const a = createNfceForSale({ companyId, saleId: criarVenda('s7') });
    const b = createNfceForSale({ companyId, saleId: criarVenda('s8') });
    expect(a.document.number).not.toBe(b.document.number);
    expect(a.document.accessKey).not.toBe(b.document.accessKey);
  });

  it('produto sem NCM bloqueia ANTES de queimar número', () => {
    const saleId = criarVenda('s9');
    getConnection()
      .prepare('UPDATE core_products SET ncm = NULL WHERE id = ?')
      .run(`prod-${saleId}`);

    const antes = getConnection()
      .prepare("SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = '65'")
      .get(companyId) as { next_number: number };

    expect(() => createNfceForSale({ companyId, saleId })).toThrow();

    const depois = getConnection()
      .prepare("SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = '65'")
      .get(companyId) as { next_number: number };

    // O número NÃO foi consumido: o portão barrou antes.
    expect(depois.next_number).toBe(antes.next_number);
  });
});

describe('validação do documento', () => {
  it('DRAFT vira VALIDATED e registra QUAL pacote de XSD aprovou (GAP-PRD-097)', () => {
    const saleId = criarVenda('s10');
    const { document } = createNfceForSale({ companyId, saleId });
    const validado = validateDocument({ companyId, documentId: document.id });

    expect(validado.status).toBe('VALIDATED');

    const evento = listDocumentEvents(companyId, document.id).find(
      (e) => e.eventType === 'status:DRAFT->VALIDATED',
    )!;
    // O histórico diz que o leiaute foi conferido, e contra o quê.
    expect(evento.detail).toMatch(/"schemaValidated":true/);
    expect(evento.detail).toMatch(/PL_010b_V1\.30/);
  });
});

describe('isolamento entre operações', () => {
  it('documento de uma operação não é visível na outra', () => {
    const saleId = criarVenda('s11');
    const { document } = createNfceForSale({ companyId, saleId });

    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(getDocument(outra, document.id)).toBeNull();
  });

  it('a numeração de cada operação é independente', () => {
    const a = createNfceForSale({ companyId, saleId: criarVenda('s12') });
    expect(a.document.number).toBe(1);

    // Outra empresa, configurada do zero, começa do 1 também — sem herdar.
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const series = getConnection()
      .prepare('SELECT COUNT(*) AS c FROM core_fiscal_series WHERE company_id = ?')
      .get(outra) as { c: number };
    expect(Number(series.c)).toBe(0);
  });
});

describe('todos os estados têm regra declarada', () => {
  it('nenhum estado fica sem transições definidas', () => {
    const estados: FiscalStatus[] = [
      'DRAFT', 'VALIDATED', 'SIGNED', 'QUEUED', 'SENDING',
      'AUTHORIZED', 'REJECTED', 'CONTINGENCY', 'CANCELLED', 'ERROR',
    ];
    for (const e of estados) {
      expect(ALLOWED_TRANSITIONS[e]).toBeDefined();
    }
  });
});
