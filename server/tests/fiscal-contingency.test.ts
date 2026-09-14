/**
 * Contingência NFC-e e pendências fiscais.
 *
 * A regra central destes testes: contingência é resposta a INDISPONIBILIDADE,
 * não a erro de dado. Uma nota rejeitada por CNPJ inválido continuará rejeitada
 * amanhã — colocá-la em contingência faria o prazo correr contra um documento
 * que nunca será aceito, escondendo o erro de cadastro atrás de um estado que
 * parece transitório.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { getDocument, transition } from '../src/services/core/FiscalDocumentService.js';
import { emitNfceForSale } from '../src/services/core/FiscalPipelineService.js';
import { enqueue, processNext, listQueue } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import {
  CONTINGENCY_EXTERNAL_DEPENDENCIES,
  CONTINGENCY_STATUS,
  TP_EMIS_OFFLINE,
  contingencyView,
  enterContingency,
  finishContingency,
  isEligibleForContingency,
  listFiscalPendencies,
  reasonFromOutcome,
  requeueFromContingency,
} from '../src/services/core/FiscalContingencyService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

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
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `C-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

async function documentoAssinado(saleId: string) {
  const adapter = new SefazTestAdapter();
  adapter.setScenario('NETWORK_ERROR');
  adapter.setConsultScenario('CONSULT_NOT_FOUND');
  await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });
  return getDocument(companyId, getConnection()
    .prepare('SELECT id FROM core_fiscal_documents WHERE sale_id = ?')
    .get(saleId) ? (getConnection()
    .prepare('SELECT id FROM core_fiscal_documents WHERE sale_id = ?')
    .get(saleId) as { id: string }).id : '')!;
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
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

describe('elegibilidade — o que É e o que NÃO É contingência', () => {
  it('indisponibilidade do serviço e falha de transporte são elegíveis', () => {
    expect(isEligibleForContingency('SERVICE_DOWN')).toBe(true);
    expect(isEligibleForContingency('TRANSPORT_ERROR')).toBe(true);
  });

  /** A regra que impede esconder erro de cadastro atrás de estado transitório. */
  it('REJEIÇÃO FISCAL nunca é elegível', () => {
    expect(isEligibleForContingency('REJECTED')).toBe(false);
    expect(isEligibleForContingency('DENIED')).toBe(false);
  });

  it('timeout não é elegível direto — exige consulta primeiro', () => {
    expect(isEligibleForContingency('TIMEOUT')).toBe(false);
    expect(isEligibleForContingency('DUPLICATE')).toBe(false);
    expect(isEligibleForContingency('NOT_FOUND')).toBe(false);
  });

  it('cada desfecho elegível tem um motivo legível', () => {
    expect(reasonFromOutcome('SERVICE_DOWN')).toBe('SEFAZ_UNAVAILABLE');
    expect(reasonFromOutcome('TRANSPORT_ERROR')).toBe('NETWORK_UNAVAILABLE');
    expect(reasonFromOutcome('REJECTED')).toBeNull();
  });
});

describe('entrada em contingência', () => {
  it('grava motivo, início e pendência de transmissão', async () => {
    const doc = await documentoAssinado(criarVenda('s1'));
    const c = enterContingency({
      companyId,
      documentId: doc.id,
      reason: 'SEFAZ_UNAVAILABLE',
      triggerCode: '108',
    });

    expect(c.status).toBe('CONTINGENCY');
    const view = contingencyView(companyId, doc.id)!;
    expect(view.active).toBe(true);
    expect(view.reason).toBe('SEFAZ_UNAVAILABLE');
    expect(view.reasonLabel).toBe('SEFAZ indisponível');
    expect(view.startedAt).toBeTruthy();
    expect(view.pendingTransmission).toBe(true);
  });

  it('NÃO gera documento novo, não renumera e não troca a chave', async () => {
    const doc = await documentoAssinado(criarVenda('s2'));
    const antes = { numero: doc.number, chave: doc.accessKey, id: doc.id };

    enterContingency({ companyId, documentId: doc.id, reason: 'NETWORK_UNAVAILABLE' });

    const depois = getDocument(companyId, doc.id)!;
    expect(depois.id).toBe(antes.id);
    expect(depois.number).toBe(antes.numero);
    expect(depois.accessKey).toBe(antes.chave);

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents')
      .get() as { c: number };
    expect(Number(total.c)).toBe(1);
  });

  it('motivo inválido é recusado — erro de dado não é contingência', async () => {
    const doc = await documentoAssinado(criarVenda('s3'));
    expect(() =>
      enterContingency({
        companyId,
        documentId: doc.id,
        reason: 'NCM_INVALIDO' as never,
      }),
    ).toThrow(/não é contingência/i);
  });

  it('registra o evento no histórico append-only', async () => {
    const doc = await documentoAssinado(criarVenda('s4'));
    enterContingency({ companyId, documentId: doc.id, reason: 'SEFAZ_UNAVAILABLE' });

    const eventos = getConnection()
      .prepare('SELECT event_type, justification FROM core_fiscal_events WHERE document_id = ?')
      .all(doc.id) as unknown as { event_type: string; justification: string | null }[];

    const inicio = eventos.find((e) => e.event_type === 'contingency_started')!;
    expect(inicio).toBeTruthy();
    // O histórico declara que a regra legal está pendente.
    expect(inicio.justification).toContain(CONTINGENCY_STATUS);
  });
});

describe('retorno do serviço', () => {
  it('volta à fila mantendo número, chave e id', async () => {
    const doc = await documentoAssinado(criarVenda('s5'));
    enterContingency({ companyId, documentId: doc.id, reason: 'NETWORK_UNAVAILABLE' });

    const voltou = requeueFromContingency({ companyId, documentId: doc.id });

    expect(voltou.status).toBe('QUEUED');
    expect(voltou.number).toBe(doc.number);
    expect(voltou.accessKey).toBe(doc.accessKey);
    expect(voltou.id).toBe(doc.id);

    const tipos = (
      getConnection()
        .prepare('SELECT event_type FROM core_fiscal_events WHERE document_id = ?')
        .all(doc.id) as unknown as { event_type: string }[]
    ).map((e) => e.event_type);
    expect(tipos).toContain('connection_restored');
    expect(tipos).toContain('requeue');
  });

  it('documento que não está em contingência não volta', async () => {
    const doc = await documentoAssinado(criarVenda('s6'));
    expect(() => requeueFromContingency({ companyId, documentId: doc.id })).toThrow(
      /Só documento em contingência/i,
    );
  });

  it('encerrar preserva o registro de que esteve em contingência', async () => {
    const doc = await documentoAssinado(criarVenda('s7'));
    enterContingency({ companyId, documentId: doc.id, reason: 'SEFAZ_UNAVAILABLE' });
    finishContingency({ companyId, documentId: doc.id });

    const view = contingencyView(companyId, doc.id)!;
    expect(view.startedAt).toBeTruthy(); // o histórico continua lá
    expect(view.endedAt).toBeTruthy();
    expect(view.pendingTransmission).toBe(false);
  });
});

describe('estado legal declarado', () => {
  /**
   * O que falta é REGRA EXTERNA, não código — e isso precisa estar dito, não
   * descoberto na homologação.
   */
  it('a implementação se declara pronta à espera da decisão do contador — não homologada', () => {
    // Deixou de ser "fundação" (GAP-PRD-098): a off-line está implementada
    // (fiscal-contingencia-offline.test.ts). O que resta é de fora: a decisão
    // do contador (modalidade e prazo), o CSC e a homologação real.
    expect(CONTINGENCY_STATUS).toBe('OFFLINE_NFCE_IMPLEMENTED_PENDING_ACCOUNTANT_DECISION');
    expect(CONTINGENCY_EXTERNAL_DEPENDENCIES.length).toBeGreaterThan(0);
    expect(CONTINGENCY_EXTERNAL_DEPENDENCIES.join(' ')).toMatch(/prazo/i);
    expect(CONTINGENCY_EXTERNAL_DEPENDENCIES.join(' ')).toMatch(/CSC/);
    expect(CONTINGENCY_EXTERNAL_DEPENDENCIES.join(' ')).toMatch(/homologação/i);
  });

  it('o tpEmis da contingência offline é 9 e entra na chave', () => {
    expect(TP_EMIS_OFFLINE).toBe('9');
  });
});

describe('fila leva a contingência só por indisponibilidade', () => {
  it('esgotadas as tentativas com serviço fora, o documento entra em contingência', async () => {
    const saleId = criarVenda('s8');
    const adapter = new SefazTestAdapter();
    adapter.setScenario('NETWORK_ERROR');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    const docId = (
      getConnection()
        .prepare('SELECT id FROM core_fiscal_documents WHERE sale_id = ?')
        .get(saleId) as { id: string }
    ).id;

    adapter.setScenario('SERVICE_UNAVAILABLE');
    for (let i = 0; i < 6; i += 1) {
      await processNext({ companyId, adapter, now: new Date(Date.now() + i * 6 * 3600_000) });
    }

    expect(getDocument(companyId, docId)!.status).toBe('CONTINGENCY');
    expect(contingencyView(companyId, docId)!.reason).toBe('SEFAZ_UNAVAILABLE');
  });

  it('rejeição fiscal NUNCA leva a contingência, por mais que se insista', async () => {
    const saleId = criarVenda('s9');
    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    const docId = (
      getConnection()
        .prepare('SELECT id FROM core_fiscal_documents WHERE sale_id = ?')
        .get(saleId) as { id: string }
    ).id;

    for (let i = 0; i < 6; i += 1) {
      await processNext({ companyId, adapter, now: new Date(Date.now() + i * 6 * 3600_000) });
    }

    const doc = getDocument(companyId, docId)!;
    expect(doc.status).toBe('REJECTED');
    expect(doc.contingencyMode).toBeNull();
    expect(contingencyView(companyId, docId)).toBeNull();
  });
});

describe('pendências fiscais', () => {
  it('conta rejeitada, contingência e envio parado — não conta autorizada', async () => {
    // Autorizada: NÃO deve contar.
    await emitNfceForSale({ companyId, saleId: criarVenda('ok'), developmentMode: true });
    expect(listFiscalPendencies(companyId)).toHaveLength(0);

    // Rejeitada: conta.
    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await emitNfceForSale({ companyId, saleId: criarVenda('rej'), developmentMode: true, adapter });

    const pend = listFiscalPendencies(companyId);
    expect(pend).toHaveLength(1);
    expect(pend[0].kind).toBe('REJECTED');
    expect(pend[0].label).toBe('NFC-e rejeitada');
  });

  it('contingência pendente entra na contagem', async () => {
    const doc = await documentoAssinado(criarVenda('s10'));
    enterContingency({ companyId, documentId: doc.id, reason: 'SEFAZ_UNAVAILABLE' });

    const pend = listFiscalPendencies(companyId);
    expect(pend.some((p) => p.kind === 'CONTINGENCY_PENDING')).toBe(true);
  });

  it('envio parado há tempo demais entra; envio recente não', async () => {
    const doc = await documentoAssinado(criarVenda('s11'));
    transition({ companyId, documentId: doc.id, to: 'SENDING' });

    // Recente: não conta.
    expect(listFiscalPendencies(companyId).some((p) => p.kind === 'SENDING_TOO_LONG')).toBe(false);

    // Antigo: conta.
    getConnection()
      .prepare('UPDATE core_fiscal_documents SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), doc.id);
    expect(listFiscalPendencies(companyId).some((p) => p.kind === 'SENDING_TOO_LONG')).toBe(true);
  });

  it('pendência de uma operação não aparece na outra', async () => {
    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await emitNfceForSale({ companyId, saleId: criarVenda('s12'), developmentMode: true, adapter });

    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(listFiscalPendencies(companyId).length).toBeGreaterThan(0);
    expect(listFiscalPendencies(outra)).toHaveLength(0);
  });

  it('resolver a pendência a remove da contagem', async () => {
    const doc = await documentoAssinado(criarVenda('s13'));
    enterContingency({ companyId, documentId: doc.id, reason: 'NETWORK_UNAVAILABLE' });
    expect(listFiscalPendencies(companyId)).toHaveLength(1);

    requeueFromContingency({ companyId, documentId: doc.id });
    const adapter = new SefazTestAdapter();
    adapter.setScenario('AUTHORIZED');
    enqueue({ companyId, documentId: doc.id });
    // O item já tinha uma tentativa falha e está no backoff; o worker só o
    // pega quando a espera vence.
    await processNext({ companyId, adapter, now: new Date(Date.now() + 24 * 3600_000) });

    expect(getDocument(companyId, doc.id)!.status).toBe('AUTHORIZED');
    expect(listFiscalPendencies(companyId)).toHaveLength(0);
    void listQueue(companyId);
  });
});
