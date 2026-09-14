/**
 * Eventos fiscais: cancelamento, carta de correção e inutilização.
 *
 * Três invariantes atravessam este arquivo:
 *
 *  - nada muda sem evidência: resposta rejeitada deixa o documento como estava;
 *  - evento não apaga nada: o XML autorizado continua intocado;
 *  - cancelar a NOTA não cancela a VENDA — o cliente pagou e levou.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { reserveNextNumber, setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  createNfeForSale,
  getDocument,
  listDocumentEvents,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { parseSefazResponse, type SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import {
  CCE_LIMITATION_NOTICE,
  checkCorrectionText,
  listVoidRanges,
  requestCancel,
  requestCorrectionLetter,
  requestVoidRange,
} from '../src/services/core/FiscalEventsService.js';
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

const JUST = 'Erro de digitacao no pedido do cliente';

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
     VALUES (?, ?, ?, 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `PJ-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 200000, 0, 0, 200000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Patinete', 2, 100000, 0, 200000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'pix', 200000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  db.prepare(
    `INSERT INTO core_stock_movements (id, company_id, product_id, movement_type, kind, quantity,
                                       quantity_before, balance_after, reference_type, reference_id, created_at)
     VALUES (?, ?, ?, 'out', 'SALE', 2, 10, 8, 'sale', ?, ?)`,
  ).run(`m-${id}`, companyId, `p-${id}`, id, now);
  db.prepare(
    `INSERT INTO core_finance_entries (id, company_id, direction, amount_cents, status,
                                       settled_cents, description, origin_type, origin_id, created_at)
     VALUES (?, ?, 'in', 200000, 'settled', 200000, 'Venda', 'sale', ?, ?)`,
  ).run(`f-${id}`, companyId, id, now);
  return id;
}

async function nfeAutorizada(saleId: string, adapter = new SefazTestAdapter()) {
  const { document } = createNfeForSale({ companyId, saleId, recipient: DEST });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  await processNext({ companyId, adapter });
  return getDocument(companyId, document.id)!;
}

function contagens() {
  const db = getConnection();
  const c = (t: string) => Number((db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c);
  return {
    vendas: c('core_sales'),
    estoque: c('core_stock_movements'),
    financeiro: c('core_finance_entries'),
    docs: c('core_fiscal_documents'),
  };
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
  companyId = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'PJ Motors Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. das Motos',
      number: '1000',
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
});

describe('cancelamento', () => {
  it('nota autorizada é cancelada com protocolo do evento', async () => {
    const doc = await nfeAutorizada(criarVenda('c1'));
    const adapter = new SefazTestAdapter();

    const r = await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter,
    });

    expect(r.accepted).toBe(true);
    expect(r.protocol).toMatch(/^TEST-/);
    expect(r.document.status).toBe('CANCELLED');
    expect(r.document.cancelledAt).toBeTruthy();
  });

  /** Sem protocolo não houve cancelamento — a nota continua valendo. */
  it('cancelamento REJEITADO deixa a nota autorizada', async () => {
    const doc = await nfeAutorizada(criarVenda('c2'));
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');

    const r = await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter,
    });

    expect(r.accepted).toBe(false);
    expect(r.protocol).toBeNull();
    expect(r.cStat).toBe('573');
    expect(getDocument(companyId, doc.id)!.status).toBe('AUTHORIZED');
  });

  it('o XML autorizado continua intocado depois do cancelamento', async () => {
    const doc = await nfeAutorizada(criarVenda('c3'));
    const antes = getConnection()
      .prepare('SELECT xml_original, protocol FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as { xml_original: string; protocol: string };

    await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new SefazTestAdapter(),
    });

    const depois = getConnection()
      .prepare('SELECT xml_original, protocol FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as { xml_original: string; protocol: string };

    expect(depois.xml_original).toBe(antes.xml_original);
    // O protocolo de AUTORIZAÇÃO permanece: ele prova que a nota existiu.
    expect(depois.protocol).toBe(antes.protocol);
  });

  /** A regra que evita estoque fantasma e caixa furado. */
  it('cancelar a NOTA não cancela a VENDA, nem estoque, nem financeiro', async () => {
    const saleId = criarVenda('c4');
    const doc = await nfeAutorizada(saleId);
    const antes = contagens();

    await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new SefazTestAdapter(),
    });

    const depois = contagens();
    expect(depois).toEqual(antes);

    const venda = getConnection()
      .prepare('SELECT status FROM core_sales WHERE id = ?')
      .get(saleId) as { status: string };
    expect(venda.status).toBe('completed');
  });

  it('cancelar duas vezes não cria segundo evento', async () => {
    const doc = await nfeAutorizada(criarVenda('c5'));
    const adapter = new SefazTestAdapter();

    const a = await requestCancel({ companyId, documentId: doc.id, justification: JUST, adapter });
    const b = await requestCancel({ companyId, documentId: doc.id, justification: JUST, adapter });

    expect(b.accepted).toBe(true);
    expect(b.eventId).toBe(a.eventId);

    const cancelamentos = listDocumentEvents(companyId, doc.id).filter(
      (e) => e.eventType === 'cancelled',
    );
    expect(cancelamentos).toHaveLength(1);
  });

  it('nota não autorizada não é cancelada', () => {
    const { document } = createNfeForSale({
      companyId,
      saleId: criarVenda('c6'),
      recipient: DEST,
    });
    return expect(
      requestCancel({
        companyId,
        documentId: document.id,
        justification: JUST,
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/Só nota autorizada/i);
  });

  it('justificativa curta é recusada antes de falar com a SEFAZ', async () => {
    const doc = await nfeAutorizada(criarVenda('c7'));
    await expect(
      requestCancel({
        companyId,
        documentId: doc.id,
        justification: 'errei',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/ao menos 15/);
  });

  it('a linha do tempo guarda pedido e desfecho', async () => {
    const doc = await nfeAutorizada(criarVenda('c8'));
    await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new SefazTestAdapter(),
    });

    const tipos = listDocumentEvents(companyId, doc.id).map((e) => e.eventType);
    expect(tipos).toContain('cancel_requested');
    expect(tipos).toContain('cancelled');
    expect(tipos).toContain('status:AUTHORIZED->CANCELLED');
  });
});

/*
  ============================================================================
  GAP-V32: O EVENTO ACEITO GUARDA O procEventoNFe ÍNTEGRO — daqui em diante
  ============================================================================

  `core_fiscal_events.xml` sempre guardou o retorno passado por
  `sanitizeResponse` — assinatura e certificado viram "[removido]". Certo para
  LOG e tela; fatal para ARQUIVAMENTO: o contador não valida o cancelamento
  pelo arquivo entregue e vai parar no portal. A assinatura do evento é prova
  PÚBLICA, não segredo.

  O conserto NÃO mexe na sanitização (o log continua igual): o adapter passa a
  entregar as duas metades — o evento ASSINADO que transmitiu e o retorno
  íntegro — e o evento aceito grava o procEventoNFe pronto em `xml_proc`.
*/
describe('o arquivamento do evento (procEventoNFe)', () => {
  const ASSINATURA_DO_EVENTO = 'QXNzaW5hdHVyYVJlYWxEb0V2ZW50bw==';

  /**
   * O adapter como o REAL se comporta desde esta rodada: `enviarEvento`
   * devolve o retorno da SEFAZ E o envEvento assinado que transmitiu. O corpo
   * do retorno inclui uma assinatura embutida de propósito — é ela que prova
   * que o LOG continua sanitizado enquanto o ARQUIVO fica íntegro.
   */
  class AdapterComEventoAssinado extends SefazTestAdapter {
    async cancel(input: {
      accessKey: string;
      protocol: string;
      justification: string;
    }): Promise<SefazResponse> {
      const retorno =
        '<retEvento versao="1.00"><infEvento><cStat>135</cStat>'
        + `<chNFe>${input.accessKey}</chNFe><nProt>135260000000101</nProt>`
        + `<Signature><SignatureValue>${ASSINATURA_DO_EVENTO}</SignatureValue></Signature>`
        + '</infEvento></retEvento>';
      const assinado =
        '<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote>'
        + `<evento versao="1.00"><infEvento Id="ID110111${input.accessKey}01">`
        + '<tpEvento>110111</tpEvento></infEvento>'
        + `<Signature><SignatureValue>${ASSINATURA_DO_EVENTO}</SignatureValue></Signature>`
        + '</evento></envEvento>';
      return {
        ...parseSefazResponse({ body: retorno, correlationId: input.accessKey }),
        xmlEventoAssinado: assinado,
      };
    }
  }

  function linhaDoEvento(eventId: string): { xml: string; xml_proc: string | null } {
    return getConnection()
      .prepare('SELECT xml, xml_proc FROM core_fiscal_events WHERE id = ?')
      .get(eventId) as { xml: string; xml_proc: string | null };
  }

  it('o cancelamento aceito grava o procEventoNFe com a assinatura preservada', async () => {
    const doc = await nfeAutorizada(criarVenda('p1'));
    const r = await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new AdapterComEventoAssinado(),
    });
    expect(r.accepted).toBe(true);

    const linha = linhaDoEvento(r.eventId);
    // O LOG continua sanitizado — o que muda é o ARMAZENAMENTO do documento.
    expect(linha.xml).toContain('[removido]');
    expect(linha.xml).not.toContain(ASSINATURA_DO_EVENTO);
    // O documento de arquivamento tem as duas metades e a assinatura viva.
    expect(linha.xml_proc).toContain('<procEventoNFe');
    expect(linha.xml_proc).toContain('<evento');
    expect(linha.xml_proc).toContain('<retEvento');
    expect(linha.xml_proc).toContain(ASSINATURA_DO_EVENTO);
    expect(linha.xml_proc).not.toContain('[removido]');
  });

  it('a carta de correção aceita ganha o mesmo arquivamento', async () => {
    /*
      O caminho da CC-e chama `correctionLetter`, não `cancel` — herdar só o
      cancel deixaria este caso medindo o adapter errado. O molde do retorno é
      o mesmo.
    */
    class AdapterDeCarta extends AdapterComEventoAssinado {
      async correctionLetter(input: {
        accessKey: string;
        sequence: number;
        text: string;
      }): Promise<SefazResponse> {
        return this.cancel({ accessKey: input.accessKey, protocol: 'p', justification: input.text });
      }
    }
    const doc = await nfeAutorizada(criarVenda('p2'));
    const r = await requestCorrectionLetter({
      companyId,
      documentId: doc.id,
      text: 'Corrigir o nome do bairro do destinatario',
      adapter: new AdapterDeCarta(),
    });
    expect(r.accepted).toBe(true);
    expect(linhaDoEvento(r.eventId).xml_proc).toContain('<procEventoNFe');
  });

  it('o provider de TESTE não fabrica prova: xml_proc fica nulo', async () => {
    /*
      O adapter de teste não tem evento assinado para entregar — e um
      procEventoNFe sem assinatura seria o arquivo que abre e não prova nada.
      Ensaio não vira arquivo probatório; o pacote já o exclui pelo protocolo
      TEST-, e esta é a segunda tranca.
    */
    const doc = await nfeAutorizada(criarVenda('p3'));
    const r = await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new SefazTestAdapter(),
    });
    expect(r.accepted).toBe(true);
    expect(linhaDoEvento(r.eventId).xml_proc).toBeNull();
  });

  it('cancelamento REJEITADO não ganha arquivamento — recusa não é prova', async () => {
    /*
      A recusa vem de um retorno SEM protocolo — o mesmo critério de
      `eventoAceito`. O evento assinado até existe; não importa: sem aceite
      não há o que arquivar.
    */
    class AdapterQueRecusa extends AdapterComEventoAssinado {
      async cancel(input: {
        accessKey: string;
        protocol: string;
        justification: string;
      }): Promise<SefazResponse> {
        return {
          ...parseSefazResponse({
            body:
              '<retEvento versao="1.00"><infEvento><cStat>573</cStat>'
              + `<chNFe>${input.accessKey}</chNFe></infEvento></retEvento>`,
            correlationId: input.accessKey,
          }),
          xmlEventoAssinado: '<evento><Signature>x</Signature></evento>',
        };
      }
    }
    const doc = await nfeAutorizada(criarVenda('p4'));
    const r = await requestCancel({
      companyId,
      documentId: doc.id,
      justification: JUST,
      adapter: new AdapterQueRecusa(),
    });
    expect(r.accepted).toBe(false);
    expect(linhaDoEvento(r.eventId).xml_proc).toBeNull();
  });
});

describe('carta de correção', () => {
  it('primeira carta recebe sequência 1; a segunda, 2', async () => {
    const doc = await nfeAutorizada(criarVenda('e1'));
    const adapter = new SefazTestAdapter();

    const a = await requestCorrectionLetter({
      companyId,
      documentId: doc.id,
      text: 'Corrigir o nome do bairro do destinatario',
      adapter,
    });
    const b = await requestCorrectionLetter({
      companyId,
      documentId: doc.id,
      text: 'Complementar dados de transporte da entrega',
      adapter,
    });

    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(a.accepted).toBe(true);
    expect(a.protocol).toMatch(/^TEST-/);
  });

  it('cartas concorrentes não repetem sequência', async () => {
    const doc = await nfeAutorizada(criarVenda('e2'));
    const adapter = new SefazTestAdapter();

    const r = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        requestCorrectionLetter({
          companyId,
          documentId: doc.id,
          text: `Observacao complementar numero ${i} para a entrega`,
          adapter,
        }),
      ),
    );

    const sequencias = r.map((x) => x.sequence).sort((a, b) => a - b);
    expect(new Set(sequencias).size).toBe(5);
    expect(sequencias).toEqual([1, 2, 3, 4, 5]);
  });

  it('carta rejeitada fica registrada e não vira autorizada', async () => {
    const doc = await nfeAutorizada(criarVenda('e3'));
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');

    const r = await requestCorrectionLetter({
      companyId,
      documentId: doc.id,
      text: 'Corrigir a referencia do pedido do cliente',
      adapter,
    });

    expect(r.accepted).toBe(false);
    expect(r.protocol).toBeNull();
    const tipos = listDocumentEvents(companyId, doc.id).map((e) => e.eventType);
    expect(tipos).toContain('cce_rejected');
    expect(tipos).not.toContain('cce_authorized');
  });

  /** Política conservadora: recusa o que carta reconhecidamente não corrige. */
  it('recusa correção de valor, quantidade, tributação e identidade', () => {
    expect(checkCorrectionText('Corrigir o valor do item 1')).toMatch(/valor/i);
    expect(checkCorrectionText('Alterar a quantidade vendida')).toMatch(/quantidade/i);
    expect(checkCorrectionText('Ajustar aliquota de ICMS')).toBeTruthy();
    expect(checkCorrectionText('Trocar o CNPJ do destinatario')).toMatch(/identidade/i);
    expect(checkCorrectionText('Corrigir o nome do bairro')).toBeNull();
  });

  it('a recusa explica e aponta o caminho certo', async () => {
    const doc = await nfeAutorizada(criarVenda('e4'));
    await expect(
      requestCorrectionLetter({
        companyId,
        documentId: doc.id,
        text: 'Corrigir o valor total da nota fiscal',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/cancelar a nota e emitir outra/i);
  });

  it('a limitação está declarada para a interface mostrar', () => {
    expect(CCE_LIMITATION_NOTICE).toMatch(/não altera a NF-e/i);
    expect(CCE_LIMITATION_NOTICE).toMatch(/política conservadora/i);
  });

  it('NFC-e não recebe carta de correção', async () => {
    const { document } = createNfceForSale({ companyId, saleId: criarVenda('e5') });
    await expect(
      requestCorrectionLetter({
        companyId,
        documentId: document.id,
        text: 'Corrigir o endereco de entrega informado',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/modelo 55/i);
  });

  it('a NF-e original não é alterada pela carta', async () => {
    const doc = await nfeAutorizada(criarVenda('e6'));
    const antes = getConnection()
      .prepare('SELECT xml_original, access_key, number FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id);

    await requestCorrectionLetter({
      companyId,
      documentId: doc.id,
      text: 'Corrigir o ponto de referencia do endereco',
      adapter: new SefazTestAdapter(),
    });

    const depois = getConnection()
      .prepare('SELECT xml_original, access_key, number FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id);
    expect(depois).toEqual(antes);
  });
});

describe('inutilização', () => {
  it('inutiliza faixa livre e registra protocolo', async () => {
    const r = await requestVoidRange({
      companyId,
      model: '55',
      serie: 1,
      year: 2026,
      from: 10,
      to: 15,
      justification: 'Falha no sistema durante a emissao',
      adapter: new SefazTestAdapter(),
    });

    expect(r.accepted).toBe(true);
    expect(r.protocol).toMatch(/^TEST-/);
    expect(r.cStat).toBe('102');

    const lista = listVoidRanges(companyId);
    expect(lista[0].status).toBe('AUTHORIZED');
    expect(lista[0].from).toBe(10);
    expect(lista[0].to).toBe(15);
  });

  /** A regra crítica: número inutilizado nunca mais sai. */
  it('a sequência pula a faixa inutilizada', async () => {
    setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 10 });

    await requestVoidRange({
      companyId,
      model: '55',
      serie: 1,
      year: 2026,
      from: 10,
      to: 15,
      justification: 'Falha no sistema durante a emissao',
      adapter: new SefazTestAdapter(),
    });

    // A próxima emissão pula para 16 — não usa 10..15.
    const proximo = reserveNextNumber({ companyId, model: '55', serie: 1 });
    expect(proximo).toBe(16);
  });

  it('faixa invertida e faixa com número já emitido são recusadas', async () => {
    await expect(
      requestVoidRange({
        companyId,
        model: '55',
        serie: 1,
        year: 2026,
        from: 20,
        to: 10,
        justification: 'Falha no sistema durante a emissao',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/menor que o inicial/i);

    // Emite a nota 1 e tenta inutilizar uma faixa que a contém.
    await nfeAutorizada(criarVenda('v1'));
    await expect(
      requestVoidRange({
        companyId,
        model: '55',
        serie: 1,
        year: 2026,
        from: 1,
        to: 5,
        justification: 'Falha no sistema durante a emissao',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/já emitido/i);
  });

  it('faixas sobrepostas são recusadas', async () => {
    const adapter = new SefazTestAdapter();
    await requestVoidRange({
      companyId,
      model: '55',
      serie: 1,
      year: 2026,
      from: 30,
      to: 40,
      justification: 'Falha no sistema durante a emissao',
      adapter,
    });

    await expect(
      requestVoidRange({
        companyId,
        model: '55',
        serie: 1,
        year: 2026,
        from: 35,
        to: 45,
        justification: 'Outra falha no sistema de emissao',
        adapter,
      }),
    ).rejects.toThrow(/sobrepõe/i);
  });

  it('duas inutilizações concorrentes da mesma faixa: uma vence', async () => {
    const adapter = new SefazTestAdapter();
    const r = await Promise.allSettled([
      requestVoidRange({
        companyId, model: '55', serie: 1, year: 2026, from: 50, to: 55,
        justification: 'Falha no sistema durante a emissao', adapter,
      }),
      requestVoidRange({
        companyId, model: '55', serie: 1, year: 2026, from: 50, to: 55,
        justification: 'Falha no sistema durante a emissao', adapter,
      }),
    ]);

    const ok = r.filter((x) => x.status === 'fulfilled');
    // Pelo menos uma passa; nenhuma pode produzir faixa duplicada autorizada.
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const autorizadas = listVoidRanges(companyId).filter(
      (v) => v.status === 'AUTHORIZED' && v.from === 50,
    );
    expect(autorizadas.length).toBeLessThanOrEqual(1);
  });

  it('inutilização rejeitada fica registrada como rejeitada', async () => {
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');

    const r = await requestVoidRange({
      companyId,
      model: '55',
      serie: 1,
      year: 2026,
      from: 60,
      to: 65,
      justification: 'Falha no sistema durante a emissao',
      adapter,
    });

    expect(r.accepted).toBe(false);
    expect(r.protocol).toBeNull();
    expect(listVoidRanges(companyId)[0].status).toBe('REJECTED');
  });

  it('justificativa curta é recusada', async () => {
    await expect(
      requestVoidRange({
        companyId, model: '55', serie: 1, year: 2026, from: 70, to: 75,
        justification: 'erro', adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/ao menos 15/);
  });
});

describe('isolamento entre operações', () => {
  it('outra operação não cancela a nota, nem vê a inutilização', async () => {
    const doc = await nfeAutorizada(criarVenda('t1'));
    await requestVoidRange({
      companyId, model: '55', serie: 1, year: 2026, from: 90, to: 95,
      justification: 'Falha no sistema durante a emissao', adapter: new SefazTestAdapter(),
    });

    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });

    await expect(
      requestCancel({
        companyId: outra,
        documentId: doc.id,
        justification: JUST,
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toThrow(/não encontrado/i);

    expect(listVoidRanges(outra)).toHaveLength(0);
  });
});
