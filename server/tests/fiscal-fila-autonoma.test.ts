/**
 * A FILA FISCAL ANDA SOZINHA — GAP-PRD-020.
 *
 * ## O que a auditoria mediu (harness b4-fiscal-e2e-nfce, "FILA SEM WORKER")
 *
 * `processNext` só era chamado dentro da emissão de uma venda. Timeout +
 * consulta 217 deixavam a nota QUEUED com nova tentativa marcada; ninguém a
 * transmitia até alguém da MESMA empresa emitir outra nota — e aí a venda
 * NOVA transmitia a nota VELHA (o item mais antigo) e devolvia a própria como
 * "aguardando transmissão". Nenhum `setInterval` tocava `core_fiscal_queue`, e
 * a rota de reenfileirar a contingência não tinha botão.
 *
 * ## O que este arquivo cobra
 *
 *  - a emissão de uma venda transmite SÓ a nota daquela venda;
 *  - o trabalhador de fundo drena TODOS os itens vencidos de TODAS as
 *    empresas, sem emissão nenhuma, com o adapter da procedência de cada nota
 *    (simulador só para nota de ensaio e nunca em produção; A1 do cofre da
 *    própria empresa para nota assinada de verdade);
 *  - a SEFAZ fora para a empresa na primeira indisponibilidade, sem segurar
 *    as outras; a volta dela (sondagem 107) antecipa as esperas;
 *  - sem A1 no cofre a nota espera sem gastar tentativa, e vira pendência;
 *  - o gestor vê a fila e transmite agora uma nota (inclusive a que entrou em
 *    contingência) — e só a da própria operação;
 *  - o servidor liga o trabalhador.
 *
 * ## Como fica vermelho
 *
 *  - volte `advanceDocument` a chamar `processNext` sem `documentId` e o
 *    primeiro caso transmite a nota velha;
 *  - apague `FiscalQueueWorker` (ou tire o `startFiscalQueueWorker` do
 *    `index.ts`) e os casos do trabalhador não têm quem os rode;
 *  - tire a parada por indisponibilidade e as notas da empresa com a SEFAZ fora
 *    gastam tentativa na mesma passada.
 *
 * Nada aqui fala com a SEFAZ: o simulador, adapters dublês e um espião no
 * transporte do `SefazRealAdapter`.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { getDocument, getDocumentBySale, transition } from '../src/services/core/FiscalDocumentService.js';
import { emitNfceForSale } from '../src/services/core/FiscalPipelineService.js';
import { processNext } from '../src/services/core/FiscalQueueService.js';
import {
  enterContingency,
  listFiscalPendencies,
} from '../src/services/core/FiscalContingencyService.js';
import {
  SONDAGEM_MS,
  adapterDaFila,
  estadoDoTrabalhador,
  reiniciarEstadoDoTrabalhadorParaTeste,
  runFiscalQueueTick,
  startFiscalQueueWorker,
  stopFiscalQueueWorker,
  ultimaSondagem,
  type EscolhaDoAdapter,
} from '../src/services/core/FiscalQueueWorker.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import type {
  AuthorizeRequest,
  SefazAdapter,
  SefazResponse,
  ServiceStatus,
} from '../src/services/core/SefazAdapter.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';
import { gerarCertificado } from './helpers/certificado.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();
const SENHA_LOGIN = 'Teste@Fila2026';
const SENHA_A1 = 'Senha@DaFila1';

let precoJusto: string;
let gringa: string;
let numeroVenda = 0;
let pfx: string;

function implantar(slug: string, cnpj: string): string {
  const companyId = upsertCompany({ slug, legalName: `${slug} Ltda`, tradeName: slug });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: `${slug} Comércio Ltda`,
      cnpj,
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
  return companyId;
}

function criarVenda(companyId: string, id: string): string {
  ensureCoreSchema();
  numeroVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `F-${numeroVenda}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, numeroVenda, `k-${id}`, now);
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

/**
 * A nota que a queda da SEFAZ deixou para trás: emitida em desenvolvimento,
 * rede fora na autorização e a consulta sem achar a chave — QUEUED, item em
 * `retry` com nova tentativa marcada.
 */
async function notaQueFicouNaFila(companyId: string, venda: string): Promise<string> {
  const saleId = criarVenda(companyId, venda);
  const adapter = new SefazTestAdapter();
  adapter.setScenario('NETWORK_ERROR');
  adapter.setConsultScenario('CONSULT_NOT_FOUND');
  await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });
  const doc = getDocumentBySale(companyId, saleId, '65')!;
  expect(doc.status).toBe('QUEUED');
  return doc.id;
}

function item(documentId: string) {
  return getConnection()
    .prepare('SELECT * FROM core_fiscal_queue WHERE document_id = ?')
    .get(documentId) as {
    status: string;
    attempts: number;
    next_attempt_at: string | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
  };
}

/** A espera venceu (o que a auditoria fez com UPDATE no banco). */
function vencer(documentId: string): void {
  getConnection()
    .prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), documentId);
}

/** Um adapter dublê que conta o que recebe — e diz o que o teste mandar. */
class Dubla implements SefazAdapter {
  readonly name = 'dubla';
  readonly autorizacoes: AuthorizeRequest[] = [];
  sondagens = 0;
  constructor(
    readonly isReal: boolean,
    private readonly teste = new SefazTestAdapter(),
    private readonly online = true,
  ) {}
  cenario(c: Parameters<SefazTestAdapter['setScenario']>[0]): this {
    this.teste.setScenario(c);
    this.teste.setConsultScenario('CONSULT_NOT_FOUND');
    return this;
  }
  async statusServico(): Promise<ServiceStatus> {
    this.sondagens += 1;
    return {
      online: this.online,
      cStat: this.online ? '107' : '108',
      xMotivo: this.online ? 'Servico em Operacao' : 'Servico Paralisado Momentaneamente',
      source: 'test',
      checkedAt: new Date().toISOString(),
    };
  }
  async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    this.autorizacoes.push(input);
    return this.teste.authorize(input);
  }
  consult: SefazAdapter['consult'] = (i) => this.teste.consult(i);
  cancel: SefazAdapter['cancel'] = (i) => this.teste.cancel(i);
  voidNumberRange: SefazAdapter['voidNumberRange'] = (i) => this.teste.voidNumberRange(i);
}

async function login(companyId: string, login: string, perfil: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(id, companyId, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA_LOGIN });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeAll(() => {
  pfx = gerarCertificado('PRECO JUSTO LTDA:11222333000181', SENHA_A1);
});

beforeEach(() => {
  resetDbForTests();
  reiniciarEstadoDoTrabalhadorParaTeste();
  numeroVenda = 0;
  precoJusto = implantar('preco-justo', '11.222.333/0001-81');
  gringa = implantar('gringa', '11.444.777/0001-61');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  stopFiscalQueueWorker();
  process.env.DEVORA_API_ENV = 'test';
});

// ============================================================================

describe('a emissão de uma venda transmite SÓ a nota daquela venda', () => {
  it('a venda nova não transmite a nota velha — e não fica para trás', async () => {
    const velha = await notaQueFicouNaFila(precoJusto, 'venda-velha');
    vencer(velha);

    const saleNova = criarVenda(precoJusto, 'venda-nova');
    const r = await emitNfceForSale({
      companyId: precoJusto,
      saleId: saleNova,
      developmentMode: true,
      adapter: new SefazTestAdapter(),
    });

    // A nota da venda nova é a que andou.
    expect(r.document.status).toBe('AUTHORIZED');
    // A velha continua esperando o trabalhador — não foi transmitida por
    // quem não tinha nada com ela.
    expect(getDocument(precoJusto, velha)!.status).toBe('QUEUED');
    expect(item(velha).attempts).toBe(1);
  });
});

describe('o trabalhador drena a fila sem emissão nenhuma', () => {
  it('todas as vencidas, de todas as empresas, numa passada — cada uma com o adapter da procedência', async () => {
    const docs = [
      await notaQueFicouNaFila(precoJusto, 'pj-1'),
      await notaQueFicouNaFila(precoJusto, 'pj-2'),
      await notaQueFicouNaFila(gringa, 'gr-1'),
      await notaQueFicouNaFila(gringa, 'gr-2'),
    ];
    docs.forEach(vencer);

    // Sem `escolher`: o adapter é o de produção deste módulo. Nota de ensaio
    // fora de produção vai pelo simulador (que autoriza).
    const passada = await runFiscalQueueTick();

    for (const [i, id] of docs.entries()) {
      const empresa = i < 2 ? precoJusto : gringa;
      expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
      expect(item(id).status).toBe('done');
    }
    expect(passada.empresas.map((e) => e.transmitidos).sort()).toEqual([2, 2]);
  });

  it('respeita o backoff: com a SEFAZ ainda fora, o item não vencido não é tocado', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-espera');
    const fora = new Dubla(false, new SefazTestAdapter(), false);
    await runFiscalQueueTick({ escolher: () => ({ tipo: 'adapter', adapter: fora }) });
    expect(fora.autorizacoes).toHaveLength(0);
    expect(getDocument(precoJusto, id)!.status).toBe('QUEUED');
    expect(item(id).attempts).toBe(1);
  });

  it('com o relógio adiante, a espera vence e a nota sai', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-relogio');
    await runFiscalQueueTick({ now: new Date(Date.now() + 2 * 60_000) });
    expect(getDocument(precoJusto, id)!.status).toBe('AUTHORIZED');
  });

  it('item travado por processo que morreu é recuperado pela passada', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-travado');
    getConnection()
      .prepare(
        `UPDATE core_fiscal_queue
            SET status = 'sending', locked_until = '2020-01-01T00:00:00.000Z', locked_by = 'morto'
          WHERE document_id = ?`,
      )
      .run(id);
    await runFiscalQueueTick();
    expect(getDocument(precoJusto, id)!.status).toBe('AUTHORIZED');
  });

  it('a empresa com a SEFAZ fora para na primeira indisponibilidade — e não segura a outra', async () => {
    const pj = [
      await notaQueFicouNaFila(precoJusto, 'pj-a'),
      await notaQueFicouNaFila(precoJusto, 'pj-b'),
      await notaQueFicouNaFila(precoJusto, 'pj-c'),
    ];
    const gr = await notaQueFicouNaFila(gringa, 'gr-a');
    [...pj, gr].forEach(vencer);

    const fora = new Dubla(false).cenario('SERVICE_UNAVAILABLE');
    const noAr = new Dubla(false).cenario('AUTHORIZED');
    const escolher = (companyId: string): EscolhaDoAdapter => ({
      tipo: 'adapter',
      adapter: companyId === precoJusto ? fora : noAr,
    });

    const passada = await runFiscalQueueTick({ escolher });

    // Uma tentativa só contra o serviço fora; as outras duas não gastaram nada.
    expect(fora.autorizacoes).toHaveLength(1);
    const tentativas = pj.map((id) => item(id).attempts).sort();
    expect(tentativas).toEqual([1, 1, 2]);
    expect(passada.empresas.find((e) => e.companyId === precoJusto)!.paradaPor).toBe('SERVICE_DOWN');
    // A vizinha seguiu a vida.
    expect(getDocument(gringa, gr)!.status).toBe('AUTHORIZED');
  });

  it('o ambiente da transmissão é o da NOTA, não o da configuração de hoje', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-amb');
    vencer(id);
    // A operação virou produção depois que a nota de homologação entrou na fila.
    getConnection()
      .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
      .run(precoJusto);
    const dubla = new Dubla(true).cenario('AUTHORIZED');
    await runFiscalQueueTick({ escolher: () => ({ tipo: 'adapter', adapter: dubla }) });
    expect(dubla.autorizacoes[0].environment).toBe('homologation');
  });
});

describe('a volta da SEFAZ reprocessa sozinha', () => {
  it('sondagem 107 antecipa a espera por indisponibilidade e a nota sai na mesma passada', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-volta');
    // A espera ainda é longa (a quarta tentativa seria em uma hora).
    getConnection()
      .prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?')
      .run(new Date(Date.now() + 60 * 60_000).toISOString(), id);

    const noAr = new Dubla(false, new SefazTestAdapter(), true).cenario('AUTHORIZED');
    const passada = await runFiscalQueueTick({ escolher: () => ({ tipo: 'adapter', adapter: noAr }) });

    expect(noAr.sondagens).toBe(1);
    expect(passada.antecipadas).toBe(1);
    expect(getDocument(precoJusto, id)!.status).toBe('AUTHORIZED');
    expect(ultimaSondagem(precoJusto)?.online).toBe(true);
  });

  it('SEFAZ ainda fora: nada é antecipado, e a sondagem não se repete antes do intervalo', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-fora');
    getConnection()
      .prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?')
      .run(new Date(Date.now() + 60 * 60_000).toISOString(), id);

    const fora = new Dubla(false, new SefazTestAdapter(), false).cenario('AUTHORIZED');
    const escolher = () => ({ tipo: 'adapter' as const, adapter: fora });
    await runFiscalQueueTick({ escolher });
    await runFiscalQueueTick({ escolher, now: new Date(Date.now() + 30_000) });

    expect(fora.sondagens).toBe(1);
    expect(fora.autorizacoes).toHaveLength(0);
    expect(getDocument(precoJusto, id)!.status).toBe('QUEUED');
    expect(ultimaSondagem(precoJusto)).toMatchObject({ online: false, cStat: '108' });

    // Passado o intervalo, pergunta de novo.
    await runFiscalQueueTick({ escolher, now: new Date(Date.now() + SONDAGEM_MS + 1_000) });
    expect(fora.sondagens).toBe(2);
  });
});

describe('a procedência decide o adapter — e o que não pode sair, não sai', () => {
  it('nota assinada de verdade sem A1 no cofre ESPERA, sem gastar tentativa, e vira pendência', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-sem-a1');
    // Assinada "de verdade" (sem a marca da fixture).
    getConnection()
      .prepare("UPDATE core_fiscal_documents SET xml_signed = '<NFe>assinada</NFe>' WHERE id = ?")
      .run(id);
    vencer(id);

    await runFiscalQueueTick();

    const i = item(id);
    expect(i.attempts).toBe(1);
    expect(i.status).toBe('retry');
    expect(i.error_code).toBe('FISCAL_CERTIFICATE_NOT_FOUND');
    expect(i.error_message).toMatch(/certificado A1 no cofre/);

    // Meia hora depois, o balcão e o gestor sabem — antes do "desistiu".
    getConnection()
      .prepare('UPDATE core_fiscal_queue SET created_at = ? WHERE document_id = ?')
      .run(new Date(Date.now() - 45 * 60_000).toISOString(), id);
    const pend = listFiscalPendencies(precoJusto).find((p) => p.documentId === id)!;
    expect(pend.kind).toBe('TRANSMISSION_DELAYED');
    expect(pend.label).toMatch(/certificado A1 no cofre/);
  });

  it('com o A1 no cofre, sai pelo adapter REAL, no host da NFC-e, com o certificado da própria empresa', async () => {
    upsertCertificateA1({ companyId: precoJusto, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
    const id = await notaQueFicouNaFila(precoJusto, 'pj-com-a1');
    getConnection()
      .prepare("UPDATE core_fiscal_documents SET xml_signed = '<NFe>assinada</NFe>' WHERE id = ?")
      .run(id);
    vencer(id);
    const chave = getDocument(precoJusto, id)!.accessKey!;

    const enviados: { url: string; servico: string }[] = [];
    vi.spyOn(
      SefazRealAdapter.prototype as unknown as {
        enviar: (url: string, servico: string, dados: string) => Promise<string>;
      },
      'enviar',
    ).mockImplementation(async (url: string, servico: string) => {
      enviados.push({ url, servico });
      return (
        '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
        + `<protNFe><infProt Id="ID143260000000999"><chNFe>${chave}</chNFe><cStat>100</cStat>`
        + '<xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>143260000000999</nProt></infProt></protNFe></retEnviNFe>'
      );
    });

    expect(adapterDaFila(precoJusto, getDocument(precoJusto, id)!)).toMatchObject({ tipo: 'adapter' });
    await runFiscalQueueTick();

    expect(enviados).toHaveLength(1);
    expect(enviados[0].url).toContain('https://nfce-homologacao.sefazrs.rs.gov.br/');
    const doc = getDocument(precoJusto, id)!;
    expect(doc.status).toBe('AUTHORIZED');
    expect(doc.protocol).toBe('143260000000999');
    // A Gringa não tem A1: a escolha dela não usa o certificado da vizinha.
    const daGringa = await notaQueFicouNaFila(gringa, 'gr-sem-a1');
    getConnection()
      .prepare("UPDATE core_fiscal_documents SET xml_signed = '<NFe>assinada</NFe>' WHERE id = ?")
      .run(daGringa);
    expect(adapterDaFila(gringa, getDocument(gringa, daGringa)!)).toMatchObject({ tipo: 'espera' });
  });

  it('nota de ensaio com o servidor em produção NÃO sai pelo simulador: o item para, com o motivo', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-ensaio');
    vencer(id);
    vi.stubEnv('NODE_ENV', 'production');

    await runFiscalQueueTick();

    const i = item(id);
    expect(i.status).toBe('dead');
    expect(i.error_code).toBe('CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION');
    expect(getDocument(precoJusto, id)!.status).toBe('QUEUED');
    expect(listFiscalPendencies(precoJusto).find((p) => p.documentId === id)?.kind).toBe('QUEUE_DEAD');
  });

  it('nota de ensaio com a OPERAÇÃO em produção também não', async () => {
    const id = await notaQueFicouNaFila(precoJusto, 'pj-ensaio-op');
    getConnection()
      .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
      .run(precoJusto);
    expect(adapterDaFila(precoJusto, getDocument(precoJusto, id)!)).toMatchObject({
      tipo: 'bloqueio',
      codigo: 'CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION',
    });
  });
});

describe('o gestor vê a fila e transmite agora', () => {
  it('o painel da fila é da operação: contagem, itens e o estado do trabalhador', async () => {
    const gerente = await login(precoJusto, 'GERFILA', 'gerente_loja');
    const id = await notaQueFicouNaFila(precoJusto, 'pj-painel');
    await notaQueFicouNaFila(gringa, 'gr-painel');

    const res = await request(app).get('/api/v1/core/fiscal/queue').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.contagem).toMatchObject({ novaTentativa: 1, desistiu: 0 });
    expect(res.body.itens).toHaveLength(1);
    expect(res.body.itens[0]).toMatchObject({ documentId: id, queueStatus: 'retry', attempts: 1 });
    expect(res.body.trabalhador).toHaveProperty('ligado');
  });

  it('o caixa não mexe na fila', async () => {
    const caixa = await login(precoJusto, 'CXFILA', 'operador_caixa_loja');
    const id = await notaQueFicouNaFila(precoJusto, 'pj-caixa');
    expect((await request(app).get('/api/v1/core/fiscal/queue').set(caixa)).status).toBe(403);
    expect(
      (await request(app).post(`/api/v1/core/fiscal/documents/${id}/transmitir`).set(caixa)).status,
    ).toBe(403);
  });

  it('transmitir agora: a nota em espera sai sem esperar o backoff', async () => {
    const gerente = await login(precoJusto, 'GERAGORA', 'gerente_loja');
    const id = await notaQueFicouNaFila(precoJusto, 'pj-agora');
    // A espera está marcada para daqui a um minuto.
    expect(new Date(item(id).next_attempt_at!).getTime()).toBeGreaterThan(Date.now());

    const res = await request(app).post(`/api/v1/core/fiscal/documents/${id}/transmitir`).set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('AUTHORIZED');
    expect(res.body.statusLabel).toBe('NFC-e autorizada');
  });

  it('a nota que entrou em contingência volta pelo botão — mesmo número, mesma chave', async () => {
    const gerente = await login(precoJusto, 'GERCONT', 'gerente_loja');
    const id = await notaQueFicouNaFila(precoJusto, 'pj-cont');
    const antes = getDocument(precoJusto, id)!;
    getConnection().prepare("UPDATE core_fiscal_queue SET status = 'dead' WHERE document_id = ?").run(id);
    transition({ companyId: precoJusto, documentId: id, to: 'SENDING' });
    enterContingency({ companyId: precoJusto, documentId: id, reason: 'SEFAZ_UNAVAILABLE' });

    const res = await request(app).post(`/api/v1/core/fiscal/documents/${id}/transmitir`).set(gerente);
    expect(res.status).toBe(200);
    const depois = getDocument(precoJusto, id)!;
    expect(depois.status).toBe('AUTHORIZED');
    expect(depois.number).toBe(antes.number);
    expect(depois.accessKey).toBe(antes.accessKey);
  });

  it('nota de outra operação é 404; nota autorizada não é "transmitida de novo"', async () => {
    const gerente = await login(precoJusto, 'GERISOLA', 'gerente_loja');
    const daVizinha = await notaQueFicouNaFila(gringa, 'gr-isola');
    const r1 = await request(app).post(`/api/v1/core/fiscal/documents/${daVizinha}/transmitir`).set(gerente);
    expect(r1.status).toBe(404);
    expect(getDocument(gringa, daVizinha)!.status).toBe('QUEUED');

    const saleId = criarVenda(precoJusto, 'pj-autorizada');
    const { document } = await emitNfceForSale({ companyId: precoJusto, saleId, developmentMode: true });
    const r2 = await request(app).post(`/api/v1/core/fiscal/documents/${document.id}/transmitir`).set(gerente);
    expect(r2.status).toBe(409);
    expect(r2.body.error?.code ?? r2.body.code).toBe('CORE_FISCAL_NOT_IN_QUEUE');
  });

  it('transmitir a fila da operação inteira pela tela', async () => {
    const gerente = await login(precoJusto, 'GERDRENA', 'gerente_loja');
    const a = await notaQueFicouNaFila(precoJusto, 'pj-d1');
    const b = await notaQueFicouNaFila(precoJusto, 'pj-d2');
    [a, b].forEach(vencer);
    const res = await request(app).post('/api/v1/core/fiscal/queue/drain').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.resultado.transmitidos).toBe(2);
    expect(res.body.painel.contagem).toMatchObject({ aguardando: 0, novaTentativa: 0 });
  });
});

describe('o servidor liga o trabalhador', () => {
  it('startFiscalQueueWorker liga (sem segurar o processo) e stop desliga', () => {
    startFiscalQueueWorker(3_600_000);
    expect(estadoDoTrabalhador()).toMatchObject({ ligado: true, tickMs: 3_600_000 });
    stopFiscalQueueWorker();
    expect(estadoDoTrabalhador().ligado).toBe(false);
  });

  it('o index.ts do servidor liga e desliga o trabalhador junto dos outros', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/\n\s*startFiscalQueueWorker\(\);/);
    expect(index).toMatch(/stopFiscalQueueWorker\(\);/);
  });
});

describe('processNext com documento', () => {
  it('reivindica só o item daquele documento', async () => {
    const velha = await notaQueFicouNaFila(precoJusto, 'pj-v');
    const nova = await notaQueFicouNaFila(precoJusto, 'pj-n');
    [velha, nova].forEach(vencer);
    const r = await processNext({ companyId: precoJusto, adapter: new SefazTestAdapter(), documentId: nova });
    expect(r.documentId).toBe(nova);
    expect(getDocument(precoJusto, velha)!.status).toBe('QUEUED');
  });
});
