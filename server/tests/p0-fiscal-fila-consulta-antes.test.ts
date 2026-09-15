/**
 * P0 FISCAL — A FILA CONSULTA ANTES DE RETRANSMITIR (homologação SIMULADA).
 *
 * Os defeitos que este arquivo prende:
 *
 *  1. A consulta pós-timeout só acontecia DENTRO da tentativa que sofreu o
 *     timeout. Com a rede caída a consulta também falha, o item ia para
 *     `retry` e a tentativa seguinte chamava `authorize` direto — sem saber se
 *     a SEFAZ já tinha autorizado a primeira. O item RECOVERED (processo morto
 *     no meio do envio) idem.
 *  2. Duplicidade (204) ou lote em processamento (105) sem desfecho na
 *     consulta viravam REJECTED — e a rejeição volta ao rascunho e sai de
 *     novo: a segunda nota da mesma venda.
 *  3. Uma consulta respondida com 108 (serviço paralisado) também virava
 *     REJECTED.
 *
 * Nenhum byte sai daqui: o adapter é um roteiro em memória que conta cada
 * chamada — é a contagem de `authorize` que prova "não retransmitiu".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  claimNext,
  enqueue,
  listQueue,
  processNext,
  recoverStaleItems,
} from '../src/services/core/FiscalQueueService.js';
import { fiscalStatusForSale } from '../src/services/core/FiscalPipelineService.js';
import {
  reiniciarEstadoDoTrabalhadorParaTeste,
  runFiscalQueueTick,
} from '../src/services/core/FiscalQueueWorker.js';
import {
  parseSefazResponse,
  type AuthorizeRequest,
  type ConsultRequest,
  type SefazAdapter,
  type SefazResponse,
  type ServiceStatus,
} from '../src/services/core/SefazAdapter.js';
import { TransportFailure } from '../src/services/core/SefazTestAdapter.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

type Passo = 'TIMEOUT' | 'REDE' | { cStat: string; xMotivo?: string };

/**
 * O "fisco" de ensaio, com roteiro. `conhece` é a base da SEFAZ simulada: a
 * chave que está lá é devolvida pela consulta como autorizada.
 */
class FiscoRoteirizado implements SefazAdapter {
  readonly name = 'fisco-roteirizado';

  readonly isReal = false;

  autorizacoes = 0;

  consultas = 0;

  readonly conhece = new Map<string, string>();

  roteiroDaAutorizacao: Passo[] = [];

  roteiroDaConsulta: Passo[] = [];

  online = true;

  private resposta(chave: string, cStat: string, xMotivo: string, protocolo?: string): SefazResponse {
    return parseSefazResponse({
      body:
        `<retEnviNFe><protNFe><infProt><chNFe>${chave}</chNFe><cStat>${cStat}</cStat>`
        + `<xMotivo>${xMotivo}</xMotivo>${protocolo ? `<nProt>${protocolo}</nProt>` : ''}`
        + '</infProt></protNFe></retEnviNFe>',
      correlationId: randomUUID(),
    });
  }

  async statusServico(): Promise<ServiceStatus> {
    return {
      online: this.online,
      cStat: this.online ? '107' : '108',
      xMotivo: this.online ? 'Servico em Operacao' : 'Paralisado',
      source: 'test',
      checkedAt: new Date().toISOString(),
    };
  }

  async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    this.autorizacoes += 1;
    const passo = this.roteiroDaAutorizacao.shift() ?? { cStat: '100' };
    if (passo === 'TIMEOUT') {
      // A SEFAZ recebeu e autorizou; a resposta é que não voltou.
      this.conhece.set(input.accessKey, `TEST-${randomUUID().slice(0, 10)}`);
      throw new TransportFailure('TIMEOUT', 'Tempo esgotado.');
    }
    if (passo === 'REDE') throw new TransportFailure('NETWORK_ERROR', 'Sem rede.');
    if (passo.cStat === '100') {
      const protocolo = `TEST-${randomUUID().slice(0, 10)}`;
      this.conhece.set(input.accessKey, protocolo);
      return this.resposta(input.accessKey, '100', 'Autorizado o uso da NF-e', protocolo);
    }
    return this.resposta(input.accessKey, passo.cStat, passo.xMotivo ?? `Resposta ${passo.cStat}`);
  }

  async consult(input: ConsultRequest): Promise<SefazResponse> {
    this.consultas += 1;
    const passo = this.roteiroDaConsulta.shift();
    if (passo === 'REDE' || passo === 'TIMEOUT') throw new TransportFailure('NETWORK_ERROR', 'Sem rede.');
    if (passo) return this.resposta(input.accessKey, passo.cStat, passo.xMotivo ?? `Resposta ${passo.cStat}`);
    const protocolo = this.conhece.get(input.accessKey);
    return protocolo
      ? this.resposta(input.accessKey, '100', 'Autorizado o uso da NF-e', protocolo)
      : this.resposta(input.accessKey, '217', 'NF-e nao consta na base de dados da SEFAZ');
  }

  async cancel(): Promise<SefazResponse> {
    throw new Error('não usado');
  }

  async voidNumberRange(): Promise<SefazResponse> {
    throw new Error('não usado');
  }
}

let companyId: string;
let numeroVenda = 0;

function criarVenda(): string {
  ensureCoreSchema();
  numeroVenda += 1;
  const id = `venda-${numeroVenda}`;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `PJ-${numeroVenda}`, now, now);
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

/** Documento na fila, com a assinatura fingida — a assinatura tem testes próprios. */
function notaNaFila(): { saleId: string; documentId: string; accessKey: string } {
  const saleId = criarVenda();
  const { document } = createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  return { saleId, documentId: document.id, accessKey: document.accessKey! };
}

const depois = (minutos: number) => new Date(Date.now() + minutos * 60_000);

beforeEach(() => {
  resetDbForTests();
  reiniciarEstadoDoTrabalhadorParaTeste();
  numeroVenda = 0;
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId,
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
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
});

describe('internet cai e volta — a retomada consulta antes de retransmitir', () => {
  it('timeout com a consulta TAMBÉM fora: a tentativa seguinte consulta, acha autorizada e NÃO retransmite', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = ['TIMEOUT'];
    fisco.roteiroDaConsulta = ['REDE'];

    const primeira = await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    expect(primeira.outcome).toBe('TIMEOUT');
    expect(getDocument(companyId, nota.documentId)!.status).toBe('QUEUED');
    // Enquanto não se sabe, a venda NÃO aparece como autorizada no balcão.
    const noBalcao = fiscalStatusForSale(companyId, nota.saleId)!;
    expect(noBalcao.document.status).not.toBe('AUTHORIZED');
    expect(noBalcao.statusLabel).not.toMatch(/autorizada/i);

    const segunda = await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(10) });
    expect(segunda.outcome).toBe('RESOLVED_BY_CONSULT');
    expect(fisco.autorizacoes).toBe(1);
    const doc = getDocument(companyId, nota.documentId)!;
    expect(doc.status).toBe('AUTHORIZED');
    expect(doc.protocol).toBe(fisco.conhece.get(nota.accessKey));
    expect(listQueue(companyId)[0].status).toBe('done');
  });

  it('a consulta segue sem resposta na retomada: nada é retransmitido e a nota continua fora de AUTHORIZED', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = ['REDE'];
    fisco.roteiroDaConsulta = ['REDE', 'REDE'];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    const r = await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(10) });

    expect(r.outcome).toBe('NETWORK_ERROR');
    expect(fisco.autorizacoes).toBe(1);
    expect(fisco.consultas).toBe(2);
    const item = listQueue(companyId)[0];
    expect(item.status).toBe('retry');
    expect(item.errorCode).toBe('NETWORK_ERROR');
    expect(getDocument(companyId, nota.documentId)!.status).toBe('QUEUED');
  });

  it('a consulta diz "não consta": só então a nota é transmitida de novo', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = ['REDE', { cStat: '100' }];
    fisco.roteiroDaConsulta = ['REDE'];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    const r = await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(10) });

    expect(r.outcome).toBe('AUTHORIZED');
    // Duas consultas (a da primeira tentativa e a da retomada), duas transmissões.
    expect(fisco.consultas).toBe(2);
    expect(fisco.autorizacoes).toBe(2);
    expect(getDocument(companyId, nota.documentId)!.status).toBe('AUTHORIZED');
  });

  it('item RECOVERED (processo morto no meio do envio): a retomada consulta antes — sem reenviar', async () => {
    const nota = notaNaFila();
    claimNext(companyId, new Date(), nota.documentId);
    const fisco = new FiscoRoteirizado();
    // A SEFAZ tinha recebido e autorizado antes do crash.
    fisco.conhece.set(nota.accessKey, 'TEST-antes-do-crash');

    recoverStaleItems(companyId, depois(11));
    const r = await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(11) });

    expect(r.outcome).toBe('RESOLVED_BY_CONSULT');
    expect(fisco.autorizacoes).toBe(0);
    expect(getDocument(companyId, nota.documentId)!.protocol).toBe('TEST-antes-do-crash');
  });

  it('o trabalhador de fundo retoma sozinho quando a SEFAZ volta — e consulta antes de transmitir', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = ['TIMEOUT'];
    fisco.roteiroDaConsulta = ['REDE'];
    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    expect(listQueue(companyId)[0].status).toBe('retry');

    // A rede volta. Nenhum clique: a passada do trabalhador sonda, antecipa e drena.
    const passada = await runFiscalQueueTick({
      now: depois(0.5),
      escolher: () => ({ tipo: 'adapter', adapter: fisco }),
    });

    expect(passada.sondadas).toBe(1);
    expect(fisco.autorizacoes).toBe(1);
    expect(getDocument(companyId, nota.documentId)!.status).toBe('AUTHORIZED');
    expect(listQueue(companyId)[0].status).toBe('done');
  });
});

describe('duplicidade, processamento e consulta sem desfecho NÃO são rejeição', () => {
  it('204 com a consulta dizendo "não consta": a nota espera na fila — não vira REJECTED', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = [{ cStat: '204', xMotivo: 'Rejeicao: Duplicidade de NF-e' }];
    fisco.roteiroDaConsulta = [{ cStat: '217' }];

    const r = await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    expect(r.outcome).toBe('DUPLICATE');
    expect(getDocument(companyId, nota.documentId)!.status).toBe('QUEUED');
    expect(listQueue(companyId)[0]).toMatchObject({ status: 'retry', errorCode: '204' });

    // A réplica da SEFAZ alcançou: a próxima tentativa CONSULTA e acha autorizada.
    fisco.conhece.set(nota.accessKey, 'TEST-primeira-transmissao');
    const r2 = await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(10) });
    expect(r2.outcome).toBe('RESOLVED_BY_CONSULT');
    expect(fisco.autorizacoes).toBe(1);
    expect(getDocument(companyId, nota.documentId)!.status).toBe('AUTHORIZED');
  });

  it('204 com a consulta fora do ar: espera — nunca REJECTED', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = [{ cStat: '204' }];
    fisco.roteiroDaConsulta = ['REDE'];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    expect(getDocument(companyId, nota.documentId)!.status).toBe('QUEUED');
    expect(listQueue(companyId)[0].status).toBe('retry');
  });

  it('105 (lote em processamento): espera e consulta depois, sem REJECTED', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = [{ cStat: '105', xMotivo: 'Lote em processamento' }];
    fisco.roteiroDaConsulta = [{ cStat: '217' }];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    expect(getDocument(companyId, nota.documentId)!.status).toBe('QUEUED');

    fisco.conhece.set(nota.accessKey, 'TEST-processado');
    await processNext({ companyId, adapter: fisco, documentId: nota.documentId, now: depois(10) });
    expect(getDocument(companyId, nota.documentId)!.status).toBe('AUTHORIZED');
    expect(fisco.autorizacoes).toBe(1);
  });

  it('consulta respondida com 108 (serviço paralisado) não decide a nota', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = ['TIMEOUT'];
    fisco.roteiroDaConsulta = [{ cStat: '108', xMotivo: 'Servico Paralisado Momentaneamente' }];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    const doc = getDocument(companyId, nota.documentId)!;
    expect(doc.status).toBe('QUEUED');
    expect(doc.cStat).toBeNull();
  });

  it('539 com a chave desconhecida continua rejeição conclusiva (o número é de outra chave)', async () => {
    const nota = notaNaFila();
    const fisco = new FiscoRoteirizado();
    fisco.roteiroDaAutorizacao = [{ cStat: '539', xMotivo: 'Duplicidade com diferenca na chave' }];

    await processNext({ companyId, adapter: fisco, documentId: nota.documentId });
    const doc = getDocument(companyId, nota.documentId)!;
    expect(doc.status).toBe('REJECTED');
    expect(doc.cStat).toBe('539');
    expect(doc.protocol).toBeNull();
  });
});
