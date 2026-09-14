/**
 * Adapter, fila, retry e recovery.
 *
 * O teste mais importante deste arquivo é o do TIMEOUT INCERTO: o ERP envia, a
 * SEFAZ recebe e autoriza, e a conexão cai antes da resposta. Reenviar
 * produziria DUAS notas para a mesma venda. O worker tem que consultar antes.
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
import {
  MAX_ATTEMPTS,
  claimNext,
  consultAndReconcile,
  enqueue,
  listQueue,
  processNext,
  recoverStaleItems,
} from '../src/services/core/FiscalQueueService.js';
import {
  classifyCStat,
  isRetryable,
  parseSefazResponse,
  requiresConsultBeforeRetry,
  resolveEndpoint,
  sanitizeResponse,
  selectAdapter,
} from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter, isTestProtocol } from '../src/services/core/SefazTestAdapter.js';
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
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `GS-${numeroVenda}`, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, numeroVenda, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);

  return id;
}

/** Leva o documento até SIGNED — a assinatura em si tem testes próprios. */
function documentoAssinado(saleId: string) {
  const { document } = createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  return transition({ companyId, documentId: document.id, to: 'SIGNED' });
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

describe('classificação de cStat', () => {
  it('100 é autorizado; qualquer desconhecido NÃO é', () => {
    expect(classifyCStat('100')).toBe('AUTHORIZED');
    expect(classifyCStat('999888')).toBe('REJECTED');
    expect(classifyCStat('')).toBe('REJECTED');
    expect(classifyCStat(null)).toBe('REJECTED');
  });

  it('separa denegado, duplicidade, não encontrado e serviço fora', () => {
    expect(classifyCStat('110')).toBe('DENIED');
    expect(classifyCStat('204')).toBe('DUPLICATE');
    expect(classifyCStat('217')).toBe('NOT_FOUND');
    expect(classifyCStat('108')).toBe('SERVICE_DOWN');
    expect(classifyCStat('105')).toBe('PROCESSING');
  });

  it('rejeição fiscal não é retentável; falha de serviço é', () => {
    expect(isRetryable('REJECTED')).toBe(false);
    expect(isRetryable('DENIED')).toBe(false);
    expect(isRetryable('SERVICE_DOWN')).toBe(true);
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('TRANSPORT_ERROR')).toBe(true);
  });

  it('timeout, duplicidade e processamento exigem consulta antes de reenviar', () => {
    expect(requiresConsultBeforeRetry('TIMEOUT')).toBe(true);
    expect(requiresConsultBeforeRetry('DUPLICATE')).toBe(true);
    expect(requiresConsultBeforeRetry('PROCESSING')).toBe(true);
    expect(requiresConsultBeforeRetry('REJECTED')).toBe(false);
  });
});

describe('parser de resposta', () => {
  /** A regra central: HTTP não decide nada. */
  it('HTTP 200 com cStat de rejeição resulta em REJECTED, nunca AUTHORIZED', () => {
    const body = `<retEnviNFe><protNFe><infProt>
      <chNFe>12345678901234567890123456789012345678901234</chNFe>
      <cStat>225</cStat><xMotivo>Rejeicao: Falha no Schema XML da NFe</xMotivo>
    </infProt></protNFe></retEnviNFe>`;

    const r = parseSefazResponse({ body, correlationId: 'c1' });
    expect(r.outcome).toBe('REJECTED');
    expect(r.cStat).toBe('225');
    expect(r.protocol).toBeNull();
  });

  it('nenhum código de rejeição vira AUTHORIZED, seja qual for', () => {
    for (const codigo of ['204', '225', '539', '110', '217', '108', '999888', '']) {
      expect(parseSefazResponse({
        body: `<protNFe><infProt><cStat>${codigo}</cStat></infProt></protNFe>`,
        correlationId: 'x',
      }).outcome).not.toBe('AUTHORIZED');
    }
  });

  it('extrai protocolo e chave quando autorizado', () => {
    const body = `<retEnviNFe><protNFe><infProt>
      <chNFe>12345678901234567890123456789012345678901234</chNFe>
      <cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>
      <nProt>135260000012345</nProt>
    </infProt></protNFe></retEnviNFe>`;

    const r = parseSefazResponse({ body, correlationId: 'c2' });
    expect(r.outcome).toBe('AUTHORIZED');
    expect(r.protocol).toBe('135260000012345');
    expect(r.accessKey).toBe('12345678901234567890123456789012345678901234');
  });

  it('o cStat do PROTOCOLO vence o do lote', () => {
    // O lote pode ter sido recebido (103) e a nota, rejeitada.
    const body = `<retEnviNFe><cStat>103</cStat><xMotivo>Lote recebido</xMotivo>
      <protNFe><infProt><cStat>539</cStat><xMotivo>Rejeicao</xMotivo></infProt></protNFe>
    </retEnviNFe>`;
    expect(parseSefazResponse({ body, correlationId: 'c3' }).cStat).toBe('539');
  });

  it('remove certificado, assinatura e hash do QR antes de guardar', () => {
    const sujo =
      '<X509Certificate>MIIabc123</X509Certificate>'
      + '<SignatureValue>ZZZZ</SignatureValue>'
      + '<urlChave>https://x?cHashQRCode=deadbeef&cIdToken=000001</urlChave>';
    const limpo = sanitizeResponse(sujo);
    expect(limpo).not.toContain('MIIabc123');
    expect(limpo).not.toContain('ZZZZ');
    expect(limpo).not.toContain('deadbeef');
    expect(limpo).not.toContain('000001');
  });
});

describe('endpoints e seleção de adapter', () => {
  it('recusa transmitir sem endereço configurado, dizendo o que falta', () => {
    expect(() =>
      resolveEndpoint({ uf: 'RS', environment: 'homologation', service: 'authorize' }),
    ).toThrow(/não configurado para RS/i);
  });

  /** A trava que impede nota de mentira em produção. */
  it('o provider de teste é IMPOSSÍVEL em produção', () => {
    const real = new SefazTestAdapter();
    const teste = new SefazTestAdapter();
    expect(() =>
      selectAdapter({ environment: 'production', useTestProvider: true, real, test: teste }),
    ).toThrow(/não pode ser usado em produção/i);
  });

  it('em homologação o provider de teste é permitido e se identifica', async () => {
    const teste = new SefazTestAdapter();
    const escolhido = selectAdapter({
      environment: 'homologation',
      useTestProvider: true,
      real: new SefazTestAdapter(),
      test: teste,
    });
    expect(escolhido.isReal).toBe(false);

    const status = await escolhido.statusServico({ uf: 'RS', environment: 'homologation' });
    // Nunca "SEFAZ ONLINE".
    expect(status.source).toBe('test');
  });
});

describe('fila', () => {
  it('SIGNED entra na fila e o documento vai para QUEUED', () => {
    const doc = documentoAssinado(criarVenda('s1'));
    const item = enqueue({ companyId, documentId: doc.id });

    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(0);
    expect(getDocument(companyId, doc.id)!.status).toBe('QUEUED');
  });

  it('enfileirar duas vezes não cria dois itens', () => {
    const doc = documentoAssinado(criarVenda('s2'));
    const a = enqueue({ companyId, documentId: doc.id });
    const b = enqueue({ companyId, documentId: doc.id });
    expect(b.id).toBe(a.id);
    expect(listQueue(companyId)).toHaveLength(1);
  });

  /** Duas instâncias, um item: só uma transmite. */
  it('single-flight — a segunda reivindicação não pega o mesmo item', () => {
    const doc = documentoAssinado(criarVenda('s3'));
    enqueue({ companyId, documentId: doc.id });

    const primeiro = claimNext(companyId);
    const segundo = claimNext(companyId);

    expect(primeiro).not.toBeNull();
    expect(segundo).toBeNull();
  });
});

describe('transmissão', () => {
  it('autorizada: persiste protocolo, cStat e data', async () => {
    const doc = documentoAssinado(criarVenda('s4'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('AUTHORIZED');
    const r = await processNext({ companyId, adapter });

    expect(r.outcome).toBe('AUTHORIZED');
    const atual = getDocument(companyId, doc.id)!;
    expect(atual.status).toBe('AUTHORIZED');
    expect(atual.protocol).toBeTruthy();
    expect(atual.cStat).toBe('100');
    expect(atual.authorizedAt).toBeTruthy();
    // O protocolo denuncia a origem: veio do provider de teste.
    expect(isTestProtocol(atual.protocol)).toBe(true);
  });

  it('rejeitada: NÃO vira autorizada e guarda o motivo', async () => {
    const doc = documentoAssinado(criarVenda('s5'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await processNext({ companyId, adapter });

    const atual = getDocument(companyId, doc.id)!;
    expect(atual.status).toBe('REJECTED');
    expect(atual.protocol).toBeNull();
    expect(atual.cStat).toBe('539');
    expect(atual.xMotivo).toMatch(/Duplicidade/);
  });

  it('rejeição fiscal não agenda nova tentativa', async () => {
    const doc = documentoAssinado(criarVenda('s6'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    await processNext({ companyId, adapter });

    expect(listQueue(companyId)[0].status).toBe('done');
  });

  it('serviço fora do ar agenda retry e mantém o documento na fila', async () => {
    const doc = documentoAssinado(criarVenda('s7'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('SERVICE_UNAVAILABLE');
    const r = await processNext({ companyId, adapter });

    expect(r.outcome).toBe('SERVICE_DOWN');
    const item = listQueue(companyId)[0];
    expect(item.status).toBe('retry');
    expect(item.attempts).toBe(1);
    expect(item.nextAttemptAt).toBeTruthy();
    expect(getDocument(companyId, doc.id)!.status).toBe('QUEUED');
  });

  it('documento sem assinatura não é transmitido', async () => {
    const { document } = createNfceForSale({ companyId, saleId: criarVenda('s8') });
    validateDocument({ companyId, documentId: document.id });
    transition({ companyId, documentId: document.id, to: 'SIGNED' });
    enqueue({ companyId, documentId: document.id });

    const r = await processNext({ companyId, adapter: new SefazTestAdapter() });
    expect(r.outcome).toBe('NOT_SIGNED');
    expect(getDocument(companyId, document.id)!.status).not.toBe('AUTHORIZED');
  });
});

describe('TIMEOUT INCERTO — o caso que evita nota duplicada', () => {
  /**
   * A SEFAZ recebeu e autorizou; a resposta não voltou. Reenviar produziria
   * duas notas. O worker consulta e descobre que já está autorizada.
   */
  it('timeout leva a CONSULTA, e a autorização é reconciliada', async () => {
    const doc = documentoAssinado(criarVenda('s9'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('TIMEOUT'); // marca a chave como processada no fisco
    const r = await processNext({ companyId, adapter });

    expect(r.outcome).toBe('RESOLVED_BY_CONSULT');
    const atual = getDocument(companyId, doc.id)!;
    expect(atual.status).toBe('AUTHORIZED');
    expect(atual.protocol).toBeTruthy();

    // E a fila foi encerrada — sem reenvio.
    expect(listQueue(companyId)[0].status).toBe('done');
  });

  it('timeout com chave desconhecida no fisco: aí sim agenda nova tentativa', async () => {
    const doc = documentoAssinado(criarVenda('s10'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('NETWORK_ERROR'); // não marca como processada
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    const r = await processNext({ companyId, adapter });

    expect(r.outcome).toBe('NETWORK_ERROR');
    expect(listQueue(companyId)[0].status).toBe('retry');
    expect(getDocument(companyId, doc.id)!.status).toBe('QUEUED');
  });

  it('duplicidade também consulta antes de concluir', async () => {
    const doc = documentoAssinado(criarVenda('s11'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('ALREADY_PROCESSED');
    const r = await processNext({ companyId, adapter });

    // A consulta revelou que estava autorizada.
    expect(r.outcome).toBe('RESOLVED_BY_CONSULT');
    expect(getDocument(companyId, doc.id)!.status).toBe('AUTHORIZED');
  });

  it('consulta direta reconcilia documento autorizado externamente', async () => {
    const doc = documentoAssinado(criarVenda('s12'));
    enqueue({ companyId, documentId: doc.id });
    transition({ companyId, documentId: doc.id, to: 'SENDING' });

    const adapter = new SefazTestAdapter();
    adapter.markProcessed(doc.accessKey!);

    const reconciliado = await consultAndReconcile({
      adapter,
      companyId,
      documentId: doc.id,
    });

    expect(reconciliado?.status).toBe('AUTHORIZED');
    expect(reconciliado?.protocol).toBeTruthy();
  });
});

describe('recovery', () => {
  it('item preso em envio volta para a fila quando a trava vence', async () => {
    const doc = documentoAssinado(criarVenda('s13'));
    enqueue({ companyId, documentId: doc.id });
    claimNext(companyId); // trava o item

    // O processo morreu aqui. Onze minutos depois:
    const depois = new Date(Date.now() + 11 * 60_000);
    const recuperados = recoverStaleItems(companyId, depois);

    expect(recuperados).toHaveLength(1);
    const item = listQueue(companyId)[0];
    expect(item.status).toBe('retry');
    expect(item.errorCode).toBe('RECOVERED');
  });

  it('a trava ainda válida NÃO é recuperada — o outro processo pode estar vivo', () => {
    const doc = documentoAssinado(criarVenda('s14'));
    enqueue({ companyId, documentId: doc.id });
    claimNext(companyId);

    expect(recoverStaleItems(companyId, new Date())).toHaveLength(0);
  });

  it('depois do recovery, a retomada consulta em vez de reenviar', async () => {
    const doc = documentoAssinado(criarVenda('s15'));
    enqueue({ companyId, documentId: doc.id });
    claimNext(companyId);

    // Simula: a SEFAZ tinha recebido e autorizado antes do crash.
    const adapter = new SefazTestAdapter();
    adapter.markProcessed(doc.accessKey!);

    recoverStaleItems(companyId, new Date(Date.now() + 11 * 60_000));

    const reconciliado = await consultAndReconcile({ adapter, companyId, documentId: doc.id });
    expect(reconciliado?.status).toBe('AUTHORIZED');
  });
});

describe('limites', () => {
  it('a fila não tenta para sempre', async () => {
    const doc = documentoAssinado(criarVenda('s16'));
    enqueue({ companyId, documentId: doc.id });

    const adapter = new SefazTestAdapter();
    adapter.setScenario('SERVICE_UNAVAILABLE');

    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      // Avança o relógio para vencer o backoff a cada volta.
      await processNext({ companyId, adapter, now: new Date(Date.now() + i * 6 * 3600_000) });
    }

    const item = listQueue(companyId)[0];
    expect(item.status).toBe('dead');
    expect(item.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(item.nextAttemptAt).toBeNull();
  });
});

describe('invariantes preservadas', () => {
  it('nenhum documento fica AUTHORIZED sem protocolo', async () => {
    const doc = documentoAssinado(criarVenda('s17'));
    enqueue({ companyId, documentId: doc.id });
    await processNext({ companyId, adapter: new SefazTestAdapter() });

    const orfas = getConnection()
      .prepare(
        `SELECT COUNT(*) AS c FROM core_fiscal_documents
          WHERE status = 'AUTHORIZED' AND (protocol IS NULL OR TRIM(protocol) = '')`,
      )
      .get() as { c: number };
    expect(Number(orfas.c)).toBe(0);
    void doc;
  });

  it('transmitir não cria venda, não move estoque e não gera receita', async () => {
    const doc = documentoAssinado(criarVenda('s18'));
    const db = getConnection();
    const antes = {
      vendas: (db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c,
      estoque: (db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number })
        .c,
      financeiro: (
        db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }
      ).c,
    };

    enqueue({ companyId, documentId: doc.id });
    await processNext({ companyId, adapter: new SefazTestAdapter() });

    expect((db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number }).c).toBe(
      antes.vendas,
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_stock_movements').get() as { c: number }).c,
    ).toBe(antes.estoque);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM core_finance_entries').get() as { c: number }).c,
    ).toBe(antes.financeiro);
  });
});
