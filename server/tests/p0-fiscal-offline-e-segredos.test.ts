/**
 * P0 FISCAL — A VENDA OFF-LINE NÃO É NFC-e AUTORIZADA, E NENHUM SEGREDO VAI PARA O LOG
 * (homologação SIMULADA, com um A1 GERADO no teste — nenhuma credencial real).
 *
 * O fluxo inteiro: venda → montagem → assinatura (A1 de teste) → transmissão
 * (simulador) → protocolo → XML guardado (original, assinado, retorno) →
 * status → DANFCE. E os dois lados da honestidade:
 *
 *  - a NFC-e emitida em contingência off-line (tpEmis 9) é entregue ao cliente
 *    ANTES da autorização: estado CONTINGENCY, rótulo "pendente de
 *    autorização", DANFCE com "EMITIDA EM CONTINGÊNCIA", "Pendente de
 *    autorização", "SEM PROTOCOLO DE AUTORIZAÇÃO" e, em homologação, "SEM VALOR
 *    FISCAL" — nunca AUTHORIZED, nunca "NFC-e autorizada";
 *  - a venda sem NFC-e tem só o comprovante NÃO FISCAL;
 *  - senha do A1, token do CSC, chave privada, SignatureValue e certificado não
 *    aparecem em log, auditoria, eventos fiscais, fila nem na saída para a
 *    central.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { getDocument, getDocumentBySale } from '../src/services/core/FiscalDocumentService.js';
import {
  STATUS_LABEL,
  TERMINAL_STATUSES,
  emitNfceForSale,
  fiscalStatusForSale,
} from '../src/services/core/FiscalPipelineService.js';
import { processNext } from '../src/services/core/FiscalQueueService.js';
import { requestCancel, requestVoidRange } from '../src/services/core/FiscalEventsService.js';
import { gravarPoliticaDeContingencia, periodoAtivo } from '../src/services/core/FiscalContingenciaOffline.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';
import { gerarCertificado } from './helpers/certificado.js';

process.env.DEVORA_API_ENV = 'test';

const SENHA_A1 = 'Senha-Do-A1-De-Teste@2026';
/** O CSC de TESTE do helper — é ele que não pode aparecer em log. */
const CSC_TOKEN = 'CSC-DE-TESTE-NAO-E-O-REAL';

let empresa: string;
let pfx: string;
let n = 0;

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

function colunas(documentId: string) {
  return getConnection()
    .prepare('SELECT xml_original, xml_signed, xml_authorized FROM core_fiscal_documents WHERE id = ?')
    .get(documentId) as { xml_original: string | null; xml_signed: string | null; xml_authorized: string | null };
}

/** A SEFAZ cai: 108 na autorização — com a modalidade off-line, o período abre. */
async function derrubarASefaz(): Promise<void> {
  const fora = new SefazTestAdapter();
  fora.setScenario('SERVICE_UNAVAILABLE');
  fora.setConsultScenario('CONSULT_NOT_FOUND');
  await emitNfceForSale({ companyId: empresa, saleId: venda(), developmentMode: true, adapter: fora });
}

beforeAll(() => {
  pfx = gerarCertificado('PRECO JUSTO LTDA:11222333000181', SENHA_A1);
});

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
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 1 });
  upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a venda OFF-LINE não é NFC-e autorizada', () => {
  it('tpEmis 9: CONTINGENCY, "pendente de autorização", sem protocolo — e o DANFCE diz isso', async () => {
    gravarPoliticaDeContingencia({ companyId: empresa, modo: 'OFFLINE_NFCE', prazoHoras: 24, userId: 'dono' });
    await derrubarASefaz();
    expect(periodoAtivo(empresa)).not.toBeNull();

    const saleId = venda();
    // O fluxo do balcão: A1 do cofre, sem senha digitada, sem modo de desenvolvimento.
    const r = await emitNfceForSale({ companyId: empresa, saleId });

    expect(r.document.accessKey!.charAt(34)).toBe('9');
    expect(r.document.status).toBe('CONTINGENCY');
    expect(r.document.status).not.toBe('AUTHORIZED');
    expect(r.document.protocol).toBeNull();
    expect(r.terminal).toBe(false);
    expect(r.statusLabel).toMatch(/pendente de autorização/);
    expect(r.statusLabel).not.toBe(STATUS_LABEL.AUTHORIZED);
    expect(TERMINAL_STATUSES.has('CONTINGENCY')).toBe(false);

    const noBalcao = fiscalStatusForSale(empresa, saleId)!;
    expect(noBalcao.document.status).toBe('CONTINGENCY');
    expect(noBalcao.contingencia).toMatchObject({ offline: true, pendente: true });

    const danfce = renderDanfce(empresa, r.document.id);
    expect(danfce).toContain('EMITIDA EM CONTINGÊNCIA');
    expect(danfce).toContain('Pendente de autorização');
    expect(danfce).toContain('SEM PROTOCOLO DE AUTORIZAÇÃO');
    expect(danfce).toContain('EMITIDA EM HOMOLOGAÇÃO — SEM VALOR FISCAL');
    expect(danfce).not.toContain('Protocolo de autorização:');

    // A SEFAZ volta e autoriza: aí sim o documento vira AUTHORIZED, com protocolo.
    await processNext({ companyId: empresa, adapter: new SefazTestAdapter(), documentId: r.document.id });
    const depois = getDocument(empresa, r.document.id)!;
    expect(depois.status).toBe('AUTHORIZED');
    expect(depois.protocol).toBeTruthy();
    const danfceAutorizado = renderDanfce(empresa, r.document.id);
    expect(danfceAutorizado).toContain('Protocolo de autorização:');
    expect(danfceAutorizado).not.toContain('Pendente de autorização');
  });

  it('venda sem NFC-e tem só o comprovante NÃO FISCAL — e nenhuma situação fiscal inventada', () => {
    const saleId = venda();
    expect(fiscalStatusForSale(empresa, saleId)).toBeNull();
    expect(getDocumentBySale(empresa, saleId, '65')).toBeNull();
    const cupom = renderDocument(empresa, 'SALE_RECEIPT', saleId);
    expect(cupom).toContain('COMPROVANTE NÃO FISCAL');
    expect(cupom).toContain('Documento sem valor fiscal');
    expect(cupom).not.toContain('DOCUMENTO AUXILIAR DA NOTA FISCAL');
  });

  it('nota só na fila (tpEmis 1, SEFAZ fora, modalidade AGUARDAR) não tem DANFCE e não se diz autorizada', async () => {
    const fora = new SefazTestAdapter();
    fora.setScenario('SERVICE_UNAVAILABLE');
    const saleId = venda();
    const r = await emitNfceForSale({ companyId: empresa, saleId, adapter: fora });
    expect(r.document.status).toBe('QUEUED');
    expect(r.statusLabel).toBe('Aguardando transmissão');
    expect(() => renderDanfce(empresa, r.document.id)).toThrow(/só existe para documento autorizado/);
    const previa = renderDanfce(empresa, r.document.id, { allowUnauthorized: true });
    expect(previa).toContain('DOCUMENTO NÃO AUTORIZADO');
  });
});

describe('o fluxo inteiro com o A1 de teste — e nenhum segredo fora do lugar', () => {
  it('assina, transmite, guarda os três XML, cancela, inutiliza — e log, auditoria, eventos, fila e central saem limpos', async () => {
    const saidas: string[] = [];
    for (const nivel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
        saidas.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }

    // 1. Emissão normal com o A1 do cofre (a senha NÃO é digitada).
    const saleId = venda();
    const r = await emitNfceForSale({ companyId: empresa, saleId, adapter: new SefazTestAdapter() });
    expect(r.document.status).toBe('AUTHORIZED');
    const xml = colunas(r.document.id);
    expect(xml.xml_original).toContain('<infNFe');
    expect(xml.xml_signed).toContain('<SignatureValue>');
    expect(xml.xml_authorized).toContain('<cStat>100</cStat>');

    // 2. Uma queda de rede com a consulta também fora (gera log de erro).
    const semRede = new SefazTestAdapter();
    semRede.setScenario('NETWORK_ERROR');
    semRede.setConsultScenario('NETWORK_ERROR');
    await emitNfceForSale({ companyId: empresa, saleId: venda(), adapter: semRede });

    // 3. Cancelamento e inutilização (a inutilização do número que a nota em fila NÃO usa).
    await requestCancel({
      companyId: empresa,
      documentId: r.document.id,
      justification: 'Cliente desistiu da compra no balcão',
      adapter: new SefazTestAdapter(),
    });
    await requestVoidRange({
      companyId: empresa,
      model: '65',
      serie: 1,
      from: 50,
      to: 51,
      justification: 'Salto de numeração por falha de sistema',
      adapter: new SefazTestAdapter(),
    });

    // O que é segredo: senha, CSC, chave privada, e o miolo da assinatura e do certificado.
    const assinatura = /<SignatureValue>([^<]+)<\/SignatureValue>/.exec(xml.xml_signed!)![1];
    const certificado = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(xml.xml_signed!)![1];
    const segredos = [SENHA_A1, CSC_TOKEN, 'PRIVATE KEY', assinatura.slice(0, 40), certificado.slice(0, 40), pfx.slice(0, 40)];

    const db = getConnection();
    const textos = [
      ...saidas,
      ...(db.prepare('SELECT action, detail FROM core_audit_log').all() as unknown as Record<string, unknown>[]).map((l) => JSON.stringify(l)),
      ...(db.prepare('SELECT event_type, justification, x_motivo, xml FROM core_fiscal_events').all() as unknown as Record<string, unknown>[]).map((l) => JSON.stringify(l)),
      ...(db.prepare('SELECT error_code, error_message FROM core_fiscal_queue').all() as unknown as Record<string, unknown>[]).map((l) => JSON.stringify(l)),
      ...(db.prepare('SELECT event_type, payload FROM core_outbox').all() as unknown as Record<string, unknown>[]).map((l) => JSON.stringify(l)),
      // O retorno da SEFAZ guardado no documento passa pela sanitização.
      String(colunas(r.document.id).xml_authorized ?? ''),
    ];
    expect(textos.length).toBeGreaterThan(5);
    for (const segredo of segredos) {
      const vazou = textos.filter((t) => t.includes(segredo));
      expect(vazou, `segredo "${segredo.slice(0, 12)}…" apareceu em: ${vazou.slice(0, 2).join(' || ')}`).toEqual([]);
    }
    // E a saída para a central não carrega XML nenhum.
    const payloads = (db.prepare('SELECT payload FROM core_outbox').all() as unknown as { payload: string }[]).map((p) => p.payload);
    expect(payloads.some((p) => p.includes('<NFe') || p.includes('<Signature'))).toBe(false);
  });
});
