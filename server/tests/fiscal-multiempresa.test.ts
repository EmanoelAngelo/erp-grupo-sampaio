/**
 * NENHUM DOCUMENTO FISCAL DE UMA OPERAÇÃO SAI EM NOME DE OUTRA.
 *
 * ============================================================================
 * O FURO QUE ESTAVA ABAIXO DO HTTP
 * ============================================================================
 *
 * O isolamento entre as seis empresas estava correto em toda a camada HTTP: o
 * `companyId` vem do vínculo do token, nunca do corpo. E mesmo assim a fila
 * fiscal atravessava.
 *
 *     SELECT * FROM core_fiscal_queue
 *      WHERE status IN ('pending','retry')
 *      ORDER BY next_attempt_at LIMIT 10
 *
 * Sem `company_id`. E `processNext` roda dentro da requisição de UMA empresa,
 * montando o adapter com o **certificado dela**. Na loja: o gerente da Gringa
 * emite uma NFC-e; o processo pega o item mais antigo da fila, que é do Preço
 * Justo, e o transmite assinado com o certificado da Gringa. A SEFAZ rejeita
 * por CNPJ do certificado diferente do emitente — e a nota da Gringa fica
 * "aguardando transmissão" para sempre.
 *
 * Com seis empresas no mesmo banco, isso acontece no primeiro dia.
 *
 * O teste da fila que existia usava UMA empresa só. É por isso que ele passava.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO GUARDA
 * ============================================================================
 *
 * A regra que não pode ser quebrada por nenhum caminho: certificado, série,
 * numeração, configuração tributária e fila são de quem emite. Cada teste aqui
 * fica vermelho se a costura for desfeita — a "mordida" está documentada em
 * cada um.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
const { upsertTaxGroup } = await import('../src/services/core/CatalogAuxService.js');
const { upsertNfceCsc } = await import('../src/services/nfce/NfceCscService.js');
const { createNfceForSale, getDocument, transition, validateDocument } = await import(
  '../src/services/core/FiscalDocumentService.js'
);
const { claimNext, enqueue, listQueue, processNext } = await import(
  '../src/services/core/FiscalQueueService.js'
);
const { SefazTestAdapter } = await import('../src/services/core/SefazTestAdapter.js');

/** As duas operações do teste — uma no RS, outra no AP, como o grupo real. */
let precoJusto: string;
let gringa: string;
let numeroVenda = 0;

function empresa(slug: string, nome: string, cnpj: string, uf: string, ibge: string): string {
  const id = upsertCompany({ slug, legalName: `${nome} Ltda`, tradeName: nome });
  updateFiscalConfig({
    companyId: id,
    patch: {
      legalName: `${nome} Comércio Ltda`,
      cnpj,
      ie: '123456789',
      crt: '1',
      street: 'Rua Um',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: ibge,
      zip: '96010000',
      uf,
    },
  });
  setSeriesNextNumber({ companyId: id, model: '65', serie: 1, nextNumber: 1 });
  /*
    O grupo tributário é parte da implantação de qualquer operação: sem ele a
    emissão é recusada de propósito, porque a tributação vem da configuração e
    não do código.
  */
  upsertNfceCsc({
    companyId: id,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  upsertTaxGroup(id, {
    code: 'SIMPLES-102',
    name: 'Simples — CSOSN 102',
    regime: 'simples',
    csosn: '102',
    cstPis: '49',
    cstCofins: '49',
    cfopInternal: '5102',
    cfopExternal: '6102',
  });
  return id;
}

/** Uma venda fechada, pronta para virar cupom. */
function criarVenda(companyId: string, id: string): string {
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

/** Desliga uma série para deixar só a que o teste quer exercitar. */
function desativarSerie(companyId: string, model: string, serie: number): void {
  getConnection()
    .prepare('UPDATE core_fiscal_series SET active = 0 WHERE company_id = ? AND model = ? AND serie = ?')
    .run(companyId, model, serie);
}

/** Leva o documento até SIGNED e o põe na fila. */
function naFila(companyId: string, saleId: string) {
  const { document } = createNfceForSale({ companyId, saleId });
  validateDocument({ companyId, documentId: document.id });
  getConnection()
    .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
    .run(document.id);
  transition({ companyId, documentId: document.id, to: 'SIGNED' });
  enqueue({ companyId, documentId: document.id });
  return document.id;
}

beforeEach(() => {
  resetDbForTests();
  numeroVenda = 0;
  precoJusto = empresa('preco-justo', 'Preço Justo', '11.222.333/0001-81', 'RS', '4314407');
  gringa = empresa('gringa', 'Gringa', '99.888.777/0001-00', 'RS', '4314407');
});

// ============================================================================

describe('a fila fiscal é da empresa que emite', () => {
  it('a Gringa não reivindica o documento do Preço Justo — nem o mais antigo', () => {
    /*
      A ORDEM IMPORTA: o do Preço Justo entra PRIMEIRO, então é ele o mais
      antigo e é ele que o `ORDER BY next_attempt_at LIMIT 10` entregava. Sem a
      empresa no filtro, a Gringa pega a nota da vizinha e a transmite com o
      próprio certificado.

      MORDIDA: tire `company_id = ?` do `claimNext` e este teste fica vermelho.
    */
    naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));
    const daGringa = naFila(gringa, criarVenda(gringa, 'venda-gr'));

    const reivindicado = claimNext(gringa);

    expect(reivindicado).toBeTruthy();
    expect(reivindicado!.companyId).toBe(gringa);
    expect(reivindicado!.documentId).toBe(daGringa);
  });

  it('empresa sem nada na fila não recebe o item da vizinha', () => {
    naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));

    // A Gringa não emitiu nada. Não há o que reivindicar.
    expect(claimNext(gringa)).toBeNull();
    // E o item do Preço Justo continua intocado, esperando quem é dele.
    expect(listQueue(precoJusto)).toHaveLength(1);
    expect(listQueue(precoJusto)[0].status).toBe('pending');
  });

  it('o item da vizinha não é sequer travado — ele fica livre para o dono', () => {
    const doPrecoJusto = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));

    claimNext(gringa);

    /*
      Travar o item da outra empresa seria quase tão ruim quanto transmiti-lo:
      a nota do Preço Justo ficaria presa por 10 minutos a cada tentativa da
      vizinha, sem ninguém entender por quê.
    */
    const item = getConnection()
      .prepare('SELECT status, locked_by FROM core_fiscal_queue WHERE document_id = ?')
      .get(doPrecoJusto) as { status: string; locked_by: string | null };
    expect(item.status).toBe('pending');
    expect(item.locked_by).toBeNull();
  });

  it('cada uma transmite a sua, na mesma fila, sem se ver', async () => {
    const doPrecoJusto = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));
    const daGringa = naFila(gringa, criarVenda(gringa, 'venda-gr'));

    /*
      A ORDEM DAS ASSERÇÕES É O TESTE.

      Afirmar só que as duas terminam autorizadas passaria com o defeito
      inteiro no lugar: a Gringa transmitiria a do Preço Justo, o Preço Justo
      transmitiria a da Gringa, e no fim as duas estariam autorizadas — cada
      uma assinada pelo certificado errado. O que prova o isolamento é o
      documento da VIZINHA continuar intocado depois do primeiro passe.
    */
    const r1 = await processNext({ companyId: gringa, adapter: new SefazTestAdapter() });
    expect(r1.processed).toBe(true);
    expect(getDocument(gringa, daGringa)!.status).toBe('AUTHORIZED');
    expect(getDocument(precoJusto, doPrecoJusto)!.status).toBe('QUEUED');

    const r2 = await processNext({ companyId: precoJusto, adapter: new SefazTestAdapter() });
    expect(r2.processed).toBe(true);
    expect(getDocument(precoJusto, doPrecoJusto)!.status).toBe('AUTHORIZED');
  });
});

// ============================================================================

describe('a numeração de uma não consome a da outra', () => {
  it('as duas emitem a nota número 1 — a série é de cada empresa', () => {
    const doPrecoJusto = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));
    const daGringa = naFila(gringa, criarVenda(gringa, 'venda-gr'));

    /*
      Numeração fiscal é por empresa, modelo e série. Se a sequência fosse
      global, a segunda loja começaria no 2 e o contador dela teria um buraco no
      número 1 que ninguém consegue explicar.
    */
    expect(getDocument(precoJusto, doPrecoJusto)!.number).toBe(1);
    expect(getDocument(gringa, daGringa)!.number).toBe(1);
  });

  it('a chave de acesso de cada uma carrega a UF e o CNPJ dela', () => {
    const doPrecoJusto = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));
    const daGringa = naFila(gringa, criarVenda(gringa, 'venda-gr'));

    const chavePj = getDocument(precoJusto, doPrecoJusto)!.accessKey!;
    const chaveGr = getDocument(gringa, daGringa)!.accessKey!;

    // cUF nas duas primeiras posições: as duas são do RS.
    expect(chavePj.slice(0, 2)).toBe('43');
    expect(chaveGr.slice(0, 2)).toBe('43');
    // CNPJ do emitente, posições 6 a 20.
    expect(chavePj.slice(6, 20)).toBe('11222333000181');
    expect(chaveGr.slice(6, 20)).toBe('99888777000100');
  });
});

// ============================================================================

describe('um documento não é lido pela empresa errada', () => {
  it('getDocument com a empresa vizinha não devolve nada', () => {
    const doPrecoJusto = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));

    expect(getDocument(precoJusto, doPrecoJusto)).toBeTruthy();
    expect(getDocument(gringa, doPrecoJusto)).toBeNull();
  });

  it('a listagem da fila mostra só o que é da operação', () => {
    naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));
    naFila(gringa, criarVenda(gringa, 'venda-gr'));

    expect(listQueue(precoJusto)).toHaveLength(1);
    expect(listQueue(gringa)).toHaveLength(1);
    expect(listQueue(precoJusto)[0].companyId).toBe(precoJusto);
    expect(listQueue(gringa)[0].companyId).toBe(gringa);
  });
});

// ============================================================================

describe('a série vem da configuração da empresa', () => {
  it('a operação que cadastrou a série 5 emite na série 5, e não na 1', () => {
    /*
      `const serie = input.serie ?? 1` — e nenhum chamador passava série. A
      operação cadastrava a série 5 na tela `/sistema/fiscal/configuracao`, o
      checklist ficava verde porque EXISTE série, e a nota saía na série 1: uma
      numeração que o contador não conhece e que ninguém declarou.

      MORDIDA: volte o `?? 1` e este teste fica vermelho.
    */
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 5, nextNumber: 1 });
    desativarSerie(precoJusto, '65', 1);

    const doc = getDocument(precoJusto, naFila(precoJusto, criarVenda(precoJusto, 'venda-pj')))!;

    expect(doc.serie).toBe(5);
    // E a chave carrega a mesma série, nas posições 22 a 25.
    expect(doc.accessKey!.slice(22, 25)).toBe('005');
  });

  it('cada operação emite na série dela — a do vizinho não vale', () => {
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 5, nextNumber: 1 });
    desativarSerie(precoJusto, '65', 1);
    setSeriesNextNumber({ companyId: gringa, model: '65', serie: 9, nextNumber: 1 });
    desativarSerie(gringa, '65', 1);

    const pj = getDocument(precoJusto, naFila(precoJusto, criarVenda(precoJusto, 'venda-pj')))!;
    const gr = getDocument(gringa, naFila(gringa, criarVenda(gringa, 'venda-gr')))!;

    expect(pj.serie).toBe(5);
    expect(gr.serie).toBe(9);
  });

  it('operação sem série cadastrada é recusada, e a recusa diz onde resolver', () => {
    /*
      Antes, a ausência de série virava a série 1 em silêncio. A nota saía —
      numa numeração que ninguém declarou, e que o contador vai procurar.
    */
    getConnection()
      .prepare('DELETE FROM core_fiscal_series WHERE company_id = ? AND model = ?')
      .run(precoJusto, '65');

    expect(() => createNfceForSale({ companyId: precoJusto, saleId: criarVenda(precoJusto, 'v-sem-serie') }))
      .toThrow(/série/i);
  });
});

// ============================================================================

describe('a contingência tem caminho de volta', () => {
  it('documento que voltou da contingência é transmitido de novo', async () => {
    const { enterContingency, requeueFromContingency } = await import(
      '../src/services/core/FiscalContingencyService.js'
    );
    const doc = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));

    // A fila esgota as tentativas e o documento entra em contingência: o item
    // vira `dead`, que é o estado de quem não é mais reivindicado.
    getConnection()
      .prepare("UPDATE core_fiscal_queue SET status = 'dead' WHERE document_id = ?")
      .run(doc);
    transition({ companyId: precoJusto, documentId: doc, to: 'SENDING' });
    enterContingency({ companyId: precoJusto, documentId: doc, reason: 'SEFAZ_UNAVAILABLE' });

    requeueFromContingency({ companyId: precoJusto, documentId: doc });

    /*
      O documento voltava para QUEUED e o ITEM DA FILA continuava `dead` —
      e `claimNext` só olha `pending` e `retry`. A nota entrava em contingência
      e não existia caminho de volta: ela ficava esperando um worker que nunca
      ia pegá-la.
    */
    const r = await processNext({ companyId: precoJusto, adapter: new SefazTestAdapter() });
    expect(r.processed).toBe(true);
    expect(getDocument(precoJusto, doc)!.status).toBe('AUTHORIZED');
  });

  it('item travado por processo morto volta sozinho na próxima tentativa', async () => {
    const doc = naFila(precoJusto, criarVenda(precoJusto, 'venda-pj'));

    /*
      `recoverStaleItems` existia e NÃO TINHA CHAMADOR: um item reivindicado por
      um processo que morreu ficava `sending` para sempre, porque `claimNext` só
      busca `pending` e `retry`. A nota da venda nunca era transmitida, e ela
      some também das pendências.
    */
    getConnection()
      .prepare(
        `UPDATE core_fiscal_queue
            SET status = 'sending', locked_until = '2020-01-01T00:00:00.000Z',
                locked_by = 'processo-que-morreu'
          WHERE document_id = ?`,
      )
      .run(doc);

    const r = await processNext({ companyId: precoJusto, adapter: new SefazTestAdapter() });
    expect(r.processed).toBe(true);
    expect(getDocument(precoJusto, doc)!.status).toBe('AUTHORIZED');
  });
});

// ============================================================================

describe('inutilização recusada não queima a numeração', () => {
  it('a faixa volta a ficar livre de verdade — e a sequência não pula', async () => {
    const { requestVoidRange } = await import('../src/services/core/FiscalEventsService.js');
    const { reserveNextNumber, setSeriesNextNumber } = await import(
      '../src/services/core/FiscalKeyService.js'
    );

    setSeriesNextNumber({ companyId: precoJusto, model: '55', serie: 1, nextNumber: 10 });

    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');

    /*
      A faixa avança `next_number` para `to + 1` ANTES de falar com a SEFAZ — o
      que está certo, porque impede uma emissão concorrente de cair dentro do
      intervalo. O que faltava era o desfazer: nada voltava atrás quando a
      resposta era recusa, e `setSeriesNextNumber` recusa retroceder.

      O gerente digita 10-20 por engano, a SEFAZ recusa, e a numeração salta de
      9 para 21 sem nenhuma inutilização autorizada para justificar o buraco no
      pacote do contador.
    */
    const r = await requestVoidRange({
      companyId: precoJusto,
      model: '55',
      serie: 1,
      year: 2026,
      from: 10,
      to: 20,
      justification: 'Faixa digitada por engano no balcao',
      adapter,
    });

    expect(r.accepted).toBe(false);
    expect(reserveNextNumber({ companyId: precoJusto, model: '55', serie: 1 })).toBe(10);
  });

  it('inutilização ACEITA continua queimando a faixa — a trava não afrouxou', async () => {
    const { requestVoidRange } = await import('../src/services/core/FiscalEventsService.js');
    const { reserveNextNumber, setSeriesNextNumber } = await import(
      '../src/services/core/FiscalKeyService.js'
    );

    setSeriesNextNumber({ companyId: precoJusto, model: '55', serie: 1, nextNumber: 10 });

    const r = await requestVoidRange({
      companyId: precoJusto,
      model: '55',
      serie: 1,
      year: 2026,
      from: 10,
      to: 20,
      justification: 'Falha no sistema durante a emissao',
      adapter: new SefazTestAdapter(),
    });

    expect(r.accepted).toBe(true);
    expect(reserveNextNumber({ companyId: precoJusto, model: '55', serie: 1 })).toBe(21);
  });
});
