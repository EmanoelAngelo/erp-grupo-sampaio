/**
 * Regressões encontradas NA TELA, não na suíte.
 *
 * Cada teste aqui nasceu de um E2E no navegador com a suíte inteira verde. A
 * lista existe para que o próximo refactor não desfaça o que só aparecia
 * abrindo a página:
 *
 * 1. O detalhe do documento devolvia só o documento — a tela mostrava "R$ NaN".
 * 2. O destinatário da NF-e não era gravado; a lista dizia "Consumidor" para
 *    uma nota de atacado com CNPJ.
 * 3. A linha do tempo não trazia cStat/xMotivo — "cancelamento recusado" sem
 *    motivo é um beco sem saída para quem opera.
 * 4. A lista de inutilizações mostrava a MESMA faixa duas vezes, uma delas
 *    "aguardando resposta".
 * 5. O DANFCE recusava documento cancelado, enquanto o DANFE aceitava.
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
  getFiscalDocumentRow,
  listDocumentEvents,
  listFiscalDocuments,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import {
  listVoidRanges,
  requestCancel,
  requestVoidRange,
} from '../src/services/core/FiscalEventsService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { renderDanfe } from '../src/services/core/DanfeRenderer.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

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

let empresa: string;
let n = 0;

function configurar(companyId: string) {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Operação Ltda',
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
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
}

/** Venda de R$ 2.000,00 — o valor importa: é ele que aparecia como NaN. */
function criarVenda(companyId: string, id: string): string {
  ensureCoreSchema();
  n += 1;
  const db = getConnection();
  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `C-${n}`, agora, agora);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 200000, 0, 0, 200000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, agora);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Patinete', 2, 100000, 0, 200000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, ?, 200000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, 'pix', agora);
  return id;
}

async function autorizar(companyId: string, saleId: string, modelo: '55' | '65') {
  const { document } =
    modelo === '55'
      ? createNfeForSale({ companyId, saleId, recipient: DEST })
      : createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  await processNext({ companyId, adapter: new SefazTestAdapter() });
  return document.id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = await upsertCompany({ slug: 'pj', tradeName: 'PJ', legalName: 'PJ Ltda' });
  configurar(empresa);
  n = 0;
});

describe('detalhe do documento', () => {
  it('traz valor, número da venda e destinatário — a tela mostrava R$ NaN', async () => {
    const id = await autorizar(empresa, criarVenda(empresa, 'v1'), '55');

    const linha = getFiscalDocumentRow(empresa, id);

    expect(linha?.totalCents).toBe(200000);
    expect(linha?.saleNumber).toBe(1);
    expect(linha?.customerName).toBe('Comprador Atacado Ltda');
    expect(linha?.recipientDocument).toBe('11.444.777/0001-61');
  });

  it('detalhe e lista concordam campo a campo', async () => {
    const id = await autorizar(empresa, criarVenda(empresa, 'v2'), '55');

    const daLista = listFiscalDocuments(empresa).find((d) => d.id === id);

    expect(getFiscalDocumentRow(empresa, id)).toEqual(daLista);
  });

  it('não inventa destinatário para NFC-e: a venda de balcão não tem', async () => {
    const id = await autorizar(empresa, criarVenda(empresa, 'v3'), '65');

    const linha = getFiscalDocumentRow(empresa, id);

    expect(linha?.customerName).toBeNull();
    expect(linha?.recipientDocument).toBeNull();
  });
});

describe('linha do tempo', () => {
  it('traz o motivo da recusa junto do evento', async () => {
    const id = await autorizar(empresa, criarVenda(empresa, 'v4'), '55');
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');
    await requestCancel({
      companyId: empresa,
      documentId: id,
      justification: 'Cliente desistiu da compra hoje',
      adapter,
    });

    const recusa = listDocumentEvents(empresa, id).find((e) => e.eventType === 'cancel_rejected');

    expect(recusa).toBeDefined();
    expect(recusa?.cStat).toBeTruthy();
    // Sem o motivo, a tela mostra "recusado" e mais nada.
    expect(recusa?.xMotivo).toBeTruthy();
  });

  it('numera as cartas de correção na sequência', async () => {
    const id = await autorizar(empresa, criarVenda(empresa, 'v5'), '55');
    const adapter = new SefazTestAdapter();
    const { requestCorrectionLetter } = await import(
      '../src/services/core/FiscalEventsService.js'
    );
    await requestCorrectionLetter({
      companyId: empresa,
      documentId: id,
      text: 'Esclarecimento sobre o endereco de entrega',
      adapter,
    });
    await requestCorrectionLetter({
      companyId: empresa,
      documentId: id,
      text: 'Complemento do esclarecimento anterior',
      adapter,
    });

    const cartas = listDocumentEvents(empresa, id).filter((e) => e.eventType === 'cce_authorized');

    expect(cartas.map((c) => c.sequence)).toEqual([1, 2]);
  });
});

describe('lista de inutilizações', () => {
  it('mostra UMA linha por faixa, com o desfecho', async () => {
    await requestVoidRange({
      companyId: empresa,
      model: '55',
      serie: 1,
      year: new Date().getFullYear(),
      from: 900,
      to: 905,
      justification: 'Falha de sistema durante a emissao',
      adapter: new SefazTestAdapter(),
    });

    const faixas = listVoidRanges(empresa);

    expect(faixas).toHaveLength(1);
    expect(faixas[0].status).toBe('AUTHORIZED');
    expect(faixas[0].protocol).toBeTruthy();
  });

  it('mantém visível o pedido que ficou sem resposta', () => {
    ensureCoreSchema();
    // Pedido registrado e nenhum desfecho: é exatamente a faixa que alguém
    // precisa ir atrás.
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_events
           (id, company_id, document_id, event_type, sequence, justification, model, serie,
            number_from, number_to, created_at)
         VALUES ('ev-pendente', ?, NULL, 'void_requested', 1, 'Sem resposta ainda', '55', 1,
                 700, 705, ?)`,
      )
      .run(empresa, new Date().toISOString());

    const faixas = listVoidRanges(empresa);

    expect(faixas).toHaveLength(1);
    expect(faixas[0].status).toBe('REQUESTED');
  });

  it('recusa faixa que se sobrepõe a uma já inutilizada', async () => {
    const comum = {
      companyId: empresa,
      model: '55',
      serie: 1,
      year: new Date().getFullYear(),
      justification: 'Falha de sistema durante a emissao',
      adapter: new SefazTestAdapter(),
    };
    await requestVoidRange({ ...comum, from: 900, to: 905 });

    await expect(requestVoidRange({ ...comum, from: 903, to: 904 })).rejects.toMatchObject({
      code: 'CORE_FISCAL_VOID_RANGE_OVERLAP',
    });
  });
});

describe('espelho de documento cancelado', () => {
  it('DANFE e DANFCE saem com a tarja de cancelada, sem exigir preview', async () => {
    const nfe = await autorizar(empresa, criarVenda(empresa, 'v6'), '55');
    const nfce = await autorizar(empresa, criarVenda(empresa, 'v7'), '65');
    for (const id of [nfe, nfce]) {
      await requestCancel({
        companyId: empresa,
        documentId: id,
        justification: 'Cliente desistiu da compra hoje',
        adapter: new SefazTestAdapter(),
      });
    }

    expect(renderDanfe(empresa, nfe)).toContain('NF-e CANCELADA');
    expect(renderDanfce(empresa, nfce)).toContain('NFC-e CANCELADA');
  });
});
