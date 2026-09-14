/**
 * A VENDA PAGA EM PARTE COM VALE TAMBÉM TEM NFC-e (auditoria do cupom, F-04).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * O crédito de loja (o vale da troca) fica FORA de `core_sale_payments` por
 * projeto: não é instrumento de pagamento, é dívida extinta, e o resgate mora
 * em `core_customer_credits` (kind 'redeem'). `loadSaleForNfce` lia só os
 * meios, e a conferência "pagamentos − troco = total" falhava SEMPRE:
 *
 *     venda R$ 100 = R$ 30 de vale + R$ 70 em dinheiro
 *     "pag — Pagamentos (R$ 70,00) menos troco (R$ 0,00) não fecham com o
 *      total (R$ 100,00)"
 *
 * No modo MANUAL o botão de emitir não aparecia; no AUTOMÁTICA o papel saía
 * como comprovante não fiscal. Essa venda nunca teria nota. A paga inteira com
 * vale falhava também em "sem pagamento".
 *
 * O leiaute tem a forma certa para isso: tPag 05, "Crédito Loja".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany, upsertUser, linkUserToCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, getFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { buildNfceXml, loadSaleForNfce, validateNfce } from '../src/services/core/FiscalXmlNfce.js';
import { createNfceForSale } from '../src/services/core/FiscalDocumentService.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { createCustomer } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { grantCredit } from '../src/services/core/CustomerCreditService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let companyId: string;
let userId: string;
let produto: string;
let cliente: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
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

  userId = await upsertUser({ login: 'CAIXA_VALE', displayName: 'Caixa', password: 'Teste@Vale2026' });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);

  // O produto com a tributação completa: o que se testa aqui é o `pag`.
  produto = 'prod-vale';
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, 'PJ-VALE', 'Camisa Social', 'UN', 4000, 10000, '62052000', '5102', '0', 1, ?, ?)`,
    )
    .run(produto, companyId, agora, agora);
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'carga-vale',
  });

  cliente = String(createCustomer(companyId, { name: 'Marta Compradora' } as never).id);
});

/** O vale da troca: a devolução concede crédito ao cliente. */
function valeDe(valorCents: number): void {
  grantCredit({
    companyId,
    customerId: cliente,
    amountCents: valorCents,
    originType: 'sale_return',
    originId: `devolucao-${randomUUID()}`,
    description: 'Troca de peça',
  });
}

function vendaComVale(valeCents: number, dinheiroCents: number): string {
  return createSale({
    companyId,
    userId,
    customerId: cliente,
    customerCreditCents: valeCents,
    items: [{ productId: produto, quantity: 1 }],
    payments: dinheiroCents > 0 ? [{ method: 'dinheiro', amountCents: dinheiroCents }] : [],
    idempotencyKey: randomUUID(),
  }).sale.id;
}

describe('o vale entra no pagamento da nota', () => {
  it('R$ 30 de vale + R$ 70 em dinheiro: a conferência fecha, e o XML leva tPag 05', () => {
    valeDe(3_000);
    const saleId = vendaComVale(3_000, 7_000);

    const venda = loadSaleForNfce(companyId, saleId);
    expect(venda.payments).toEqual(
      expect.arrayContaining([
        { method: 'dinheiro', amountCents: 7_000 },
        { method: 'credito_loja', amountCents: 3_000 },
      ]),
    );

    // O mesmo `validateNfce` que decide se o botão de emitir aparece.
    const problemas = validateNfce(venda, getFiscalConfig(companyId));
    expect(problemas.filter((p) => p.field === 'pag'), JSON.stringify(problemas)).toEqual([]);

    const { xml } = buildNfceXml({ sale: venda, config: getFiscalConfig(companyId), serie: 1, number: 1 });
    expect(xml).toMatch(/<tPag>05<\/tPag>\s*<vPag>30\.00<\/vPag>/);
    expect(xml).toMatch(/<tPag>01<\/tPag>\s*<vPag>70\.00<\/vPag>/);
    expect(xml).toContain('<vNF>100.00</vNF>');
  });

  it('a venda paga INTEIRA com vale também tem nota — nem "sem pagamento", nem conta que não fecha', () => {
    valeDe(10_000);
    const saleId = vendaComVale(10_000, 0);

    const venda = loadSaleForNfce(companyId, saleId);
    expect(venda.payments).toEqual([{ method: 'credito_loja', amountCents: 10_000 }]);
    const problemas = validateNfce(venda, getFiscalConfig(companyId));
    expect(problemas.filter((p) => p.field === 'pag'), JSON.stringify(problemas)).toEqual([]);
  });

  it('venda sem vale continua como era: só os meios', () => {
    const saleId = createSale({
      companyId,
      userId,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      idempotencyKey: randomUUID(),
    }).sale.id;
    expect(loadSaleForNfce(companyId, saleId).payments).toEqual([{ method: 'dinheiro', amountCents: 10_000 }]);
  });

  it('o DANFCE diz "Crédito de loja (vale)", e não o código cru', () => {
    valeDe(3_000);
    const saleId = vendaComVale(3_000, 7_000);
    const { document } = createNfceForSale({ companyId, saleId });

    const html = renderDanfce(companyId, document.id, { allowUnauthorized: true });
    expect(html).toContain('Crédito de loja (vale)');
    expect(html).not.toContain('credito_loja');
    expect(html).toContain('30,00');
    expect(html).toContain('70,00');
  });
});
