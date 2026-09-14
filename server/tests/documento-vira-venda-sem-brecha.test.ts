/**
 * OS DOIS BLOQUEIOS DO DOCUMENTO — medidos contra banco de teste, com número.
 *
 * A rodada anterior fechou a alçada: a concessão passou a ser medida ONDE O
 * PREÇO É ESCRITO (criação do orçamento e da pré-venda), e a conversão ficou
 * leve de propósito. A trava ficou certa, e sobraram duas brechas que não
 * davam erro nenhum — as duas silenciosas, as duas com o documento jurando que
 * estava tudo em ordem.
 *
 *   1. CHAVE DE IDEMPOTÊNCIA COLIDINDO ENTRE DOCUMENTOS. Duas pré-vendas da
 *      MESMA moto, convertidas com a MESMA Idempotency-Key, produziam UMA
 *      venda só. As DUAS pré-vendas ficavam status='convertido' apontando para
 *      o MESMO converted_sale_id, e o saldo andava de {quantity:49,reserved:1}
 *      para {quantity:49,reserved:0}: a segunda moto SAIU DA RESERVA, voltou a
 *      contar como DISPONÍVEL, e não gerou venda, nem pagamento, nem
 *      lançamento financeiro — com o documento dizendo "faturada".
 *
 *   2. ORÇAMENTO ANTERIOR À RODADA. Documento gravado como a rodada anterior
 *      gravava (`concession_cents` NULO, moto de R$ 12.000 a unit_price_cents
 *      = 100) atravessava promoteToPreSale + convertQuote inteiro: venda de
 *      R$ 1,00, estoque baixado e `auditoria: []` — vazia. O documento NOVO
 *      apagava o rastro de que o antigo nunca tinha sido conferido.
 *
 * COMO ESTES CASOS FALHAM (verificado quebrando cada guarda de propósito):
 *
 *   - trocando `quote:<id>:<chave>` de volta por `input.idempotencyKey` cru em
 *     convertQuote, a segunda conversão devolve a venda da primeira: os dois
 *     casos de duas pré-vendas falham (uma venda só, saldo 49/0);
 *   - removendo a recusa de `duplicated`, o caso do cinto-e-suspensório passa a
 *     soltar a reserva e devolver a venda alheia;
 *   - tirando o `alcada` condicional de promoteToPreSale, os três casos de
 *     documento anterior à rodada passam a criar a pré-venda e falham aqui;
 *   - trocando `?? { profileCodes: [] }` por `?? undefined`, o caso do chamador
 *     que esquece a alçada falha — a trava volta a falhar ABERTA;
 *   - tirando o `alcada` da rota POST /quotes/:id/promote, o caso HTTP falha.
 *
 * Nenhum caso procura texto de código: todos executam documento e venda de
 * verdade e conferem o que ficou no banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';
import {
  convertQuote,
  createQuote,
  promoteToPreSale,
} from '../src/services/core/QuoteService.js';

const MOTO = 1_200_000;
const OLEO = 5_000;
const LOJA = 'loja-documento';

const app = createApp();

/** Perfil de quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };

function produto(id: string, nome: string, precoCents: number): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, LOJA, id, nome, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(LOJA, id, agora);
}

function saldo(productId: string): { quantity: number; reserved: number } {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(LOJA, productId) as { quantity: number; reserved: number };
}

function contar(sql: string, ...params: unknown[]): number {
  const row = getConnection().prepare(sql).get(...(params as string[])) as { n: number };
  return row.n;
}

function documento(quoteId: string): {
  status: string;
  converted_sale_id: string | null;
  concession_cents: number | null;
  total_cents: number;
} {
  return getConnection()
    .prepare(
      'SELECT status, converted_sale_id, concession_cents, total_cents FROM core_quotes WHERE id = ?',
    )
    .get(quoteId) as never;
}

function auditoria(acao: string): { detail: string }[] {
  return getConnection()
    .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(LOJA, acao) as never;
}

/** Erro capturado com código e detalhe, que é o que o balcão vê. */
function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava um erro, e a operação passou');
}

/**
 * Liberação de gestor já registrada.
 *
 * Gravada direto porque o que está sob teste é o DOCUMENTO consumir a
 * liberação; quem prova que a credencial do gestor é conferida de verdade é o
 * teste de `authorizeAction`, em pdv-finalizacao.
 */
function liberacao(para: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by,
          granted_concession_cents, created_at)
       VALUES (?, ?, 'desconto_acima_limite', ?, 'u-gerente', NULL, ?)`,
    )
    .run(id, LOJA, para, new Date().toISOString());
  return id;
}

/** O operador do balcão, com token real e o id que a liberação vai carregar. */
async function operador(): Promise<{ token: string; userId: string }> {
  const res = await loginForTest(app, {
    userId: 'caixa',
    companyId: LOJA,
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status).toBe(200);
  const linha = getConnection()
    .prepare('SELECT id FROM core_users WHERE login = ?')
    .get(`caixa@${LOJA}`) as { id: string };
  return { token: res.body.accessToken as string, userId: linha.id };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await operador();
  produto('p-moto', 'Moto Elétrica', MOTO);
  produto('p-oleo', 'Óleo 1L', OLEO);
});

/* ========================================================================== */
/* BLOQUEIO 1 — A CHAVE COLIDINDO ENTRE DOIS DOCUMENTOS                       */
/* ========================================================================== */

describe('duas pré-vendas com a mesma chave são duas vendas, não uma', () => {
  /** Pré-venda de UMA moto, ao preço de tabela: nada a conceder, nada a liberar. */
  function preVendaDaMoto() {
    return createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'pre_venda',
      items: [{ productId: 'p-moto', quantity: 1 }],
      alcada: CAIXA,
    });
  }

  function converter(quoteId: string, chave: string) {
    return convertQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      quoteId,
      idempotencyKey: chave,
      payments: [{ method: 'dinheiro', amountCents: MOTO }],
    });
  }

  it('O CENÁRIO MEDIDO: duas motos reservadas, mesma Idempotency-Key, duas vendas', () => {
    /*
      A medição original, número por número. Antes do prefixo:
        - saía UMA venda só;
        - as DUAS pré-vendas ficavam 'convertido' apontando para o MESMO
          converted_sale_id;
        - o saldo ia de {49,1} para {49,0} — a segunda moto voltava ao
          disponível sem venda, sem pagamento e sem financeiro.

      A chave repetida não é hipótese remota: é a aba duplicada, o cliente HTTP
      que reenvia o header, o script que gera a chave uma vez por sessão.
    */
    const primeira = preVendaDaMoto();
    const segunda = preVendaDaMoto();
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 2 });

    const chave = 'MESMA-CHAVE-DAS-DUAS-ABAS';
    const a = converter(primeira.id, chave);
    const b = converter(segunda.id, chave);

    // Duas vendas DIFERENTES. Este é o coração do caso: sem o prefixo,
    // b.saleId era igual a a.saleId.
    expect(b.saleId).not.toBe(a.saleId);
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(2);

    // E cada documento aponta para a SUA venda.
    expect(documento(primeira.id).converted_sale_id).toBe(a.saleId);
    expect(documento(segunda.id).converted_sale_id).toBe(b.saleId);

    // O saldo é a prova física: duas motos saíram da prateleira e nenhuma
    // ficou presa na reserva. Antes: {49,0} — uma moto voltava a "existir".
    expect(saldo('p-moto')).toEqual({ quantity: 48, reserved: 0 });
  });

  it('a segunda venda tem pagamento e lançamento financeiro próprios', () => {
    /*
      O que a colisão apagava não era só a linha da venda: era o dinheiro. A
      segunda moto saía da loja com o documento dizendo "faturada" e sem um
      centavo lançado — e nenhum relatório acusava nada, porque a venda que não
      existiu também não aparece em lugar nenhum.
    */
    const primeira = preVendaDaMoto();
    const segunda = preVendaDaMoto();

    const chave = 'MESMA-CHAVE-DAS-DUAS-ABAS';
    converter(primeira.id, chave);
    converter(segunda.id, chave);

    expect(
      contar(
        `SELECT COUNT(*) AS n FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale'`,
        LOJA,
      ),
    ).toBe(2);
    expect(
      contar(
        `SELECT COALESCE(SUM(settled_cents), 0) AS n FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale'`,
        LOJA,
      ),
    ).toBe(2 * MOTO);
  });

  it('a IDEMPOTÊNCIA LEGÍTIMA continua de pé: mesmo documento + mesma chave = mesma venda', () => {
    /*
      A outra metade, e ela importa tanto quanto a separação: se o conserto
      fosse "gerar uma chave nova a cada conversão", o reenvio depois de uma
      queda de rede passaria a criar uma SEGUNDA venda — trocaríamos uma moto
      perdida por uma venda em dobro.

      O prefixo preserva a idempotência porque é determinístico: o mesmo
      documento com a mesma chave produz a mesma chave final. O que se prova
      aqui é que essa chave final ainda casa — a venda é encontrada, não
      recriada.
    */
    const pv = preVendaDaMoto();
    const chave = 'CHAVE-DO-PDV';
    const primeira = converter(pv.id, chave);

    const gravada = getConnection()
      .prepare('SELECT idempotency_key FROM core_sales WHERE id = ?')
      .get(primeira.saleId) as { idempotency_key: string };
    expect(gravada.idempotency_key).toBe(`quote:${pv.id}:${chave}`);

    // O reenvio, exatamente como o PDV o faria: mesma chave final, mesma venda
    // de volta, e nenhuma segunda venda criada.
    const reenvio = createSale({
      companyId: LOJA,
      userId: 'u-caixa',
      idempotencyKey: `quote:${pv.id}:${chave}`,
      items: [{ productId: 'p-moto', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: MOTO }],
    });
    expect(reenvio.duplicated).toBe(true);
    expect(reenvio.sale.id).toBe(primeira.saleId);
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(1);
    expect(saldo('p-moto')).toEqual({ quantity: 49, reserved: 0 });
  });

  it('o mesmo documento não vira duas vendas nem tentando de novo', () => {
    const pv = preVendaDaMoto();
    const chave = 'CHAVE-DO-PDV';
    const venda = converter(pv.id, chave);

    // A segunda tentativa esbarra no status do documento e diz qual venda já
    // existe — que é a informação que quem está no balcão precisa.
    const erro = erroDe(() => converter(pv.id, chave));
    expect(erro.code).toBe('CORE_QUOTE_ALREADY_CONVERTED');
    expect(erro.message).toContain(String(venda.saleId));
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(1);
  });

  it('CINTO E SUSPENSÓRIO: venda já gravada na chave do documento não solta a reserva', () => {
    /*
      A conferência que existe para o dia em que o prefixo não bastar. Aqui a
      chave final é ocupada à mão ANTES da conversão — é a simulação do estado
      de banco que o código não supõe possível.

      O que NÃO se pode aceitar é o desfecho medido no bloqueio 1: soltar a
      reserva e devolver a venda de outro documento como se fosse desta. A
      recusa derruba a transação inteira, e a reserva solta volta ao lugar.

      A intrusa é uma venda SEM impressão digital da mercadoria (a coluna nula,
      como toda venda anterior a ela — item IDEM). Com impressão e outra
      mercadoria, `createSale` recusaria antes (422, o caso seguinte) e esta
      conferência do documento deixaria de ser exercitada. Nula, `createSale`
      devolve a intrusa como reenvio, e é a recusa do documento que segura.
    */
    const pv = preVendaDaMoto();
    const chave = 'CHAVE-QUE-JA-TEM-DONO';
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });

    // Uma venda QUALQUER ocupando a chave final desta pré-venda.
    const intrusa = createSale({
      companyId: LOJA,
      userId: 'u-caixa',
      idempotencyKey: `quote:${pv.id}:${chave}`,
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: OLEO }],
    });
    getConnection()
      .prepare('UPDATE core_sales SET idempotency_fingerprint = NULL WHERE id = ?')
      .run(intrusa.sale.id);

    const erro = erroDe(() => converter(pv.id, chave));
    expect(erro.code).toBe('CORE_QUOTE_CONVERT_KEY_CONFLICT');

    // A moto continua RESERVADA: a reserva é solta antes da venda, e o
    // rollback tem de devolvê-la. Sem a recusa, o saldo aqui seria {50,0} — a
    // moto de volta ao disponível sem venda nenhuma.
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });
    // E o documento continua aberto, apontando para nada.
    expect(documento(pv.id)).toMatchObject({ status: 'aberto', converted_sale_id: null });
    // Nenhuma venda nova: só a intrusa, que já estava lá.
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(1);
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE id = ?', intrusa.sale.id)).toBe(1);
  });

  it('a intrusa COM impressão digital e outra mercadoria é recusada antes, pela venda — e a reserva fica', () => {
    /*
      O mesmo estado impossível, com a venda de hoje: a intrusa grava a
      impressão digital da mercadoria dela (óleo), e a conversão pede a moto.
      Quem recusa agora é `createSale` (422 CORE_IDEMPOTENCY_KEY_REUSED), dentro
      da transação da conversão — e o desfecho que importa é o mesmo do caso
      acima: a reserva volta, o documento fica aberto, nenhuma venda nova.
    */
    const pv = preVendaDaMoto();
    const chave = 'CHAVE-QUE-JA-TEM-DONO';
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });

    const intrusa = createSale({
      companyId: LOJA,
      userId: 'u-caixa',
      idempotencyKey: `quote:${pv.id}:${chave}`,
      items: [{ productId: 'p-oleo', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: OLEO }],
    });

    const erro = erroDe(() => converter(pv.id, chave));
    expect(erro.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(erro.message).toContain(`#${intrusa.sale.number}`);

    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });
    expect(documento(pv.id)).toMatchObject({ status: 'aberto', converted_sale_id: null });
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(1);
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE id = ?', intrusa.sale.id)).toBe(1);
  });
});

/* ========================================================================== */
/* BLOQUEIO 2 — O ORÇAMENTO ANTERIOR À RODADA                                 */
/* ========================================================================== */

describe('orçamento anterior à trava é conferido na APROVAÇÃO, não apagado', () => {
  /**
   * Um orçamento gravado como a rodada anterior gravava.
   *
   * `concession_cents` NULO porque a coluna não existia, e a moto de
   * R$ 12.000 escrita a R$ 1,00 porque nada conferia o preço. É o documento
   * que estava no banco quando a trava nasceu — e o único jeito honesto de
   * testar a migração é reproduzir a linha, não fingi-la.
   */
  function orcamentoAnteriorARodada(unitCents = 100): string {
    const doc = createQuote({
      companyId: LOJA,
      userId: 'u-caixa',
      kind: 'orcamento',
      items: [{ productId: 'p-moto', quantity: 1 }],
      alcada: CAIXA,
    });
    getConnection()
      .prepare(
        `UPDATE core_quotes
            SET concession_cents = NULL, concession_gross_cents = NULL,
                authorization_id = NULL, total_cents = ?
          WHERE id = ?`,
      )
      .run(unitCents, doc.id);
    getConnection()
      .prepare(
        'UPDATE core_quote_items SET unit_price_cents = ?, total_cents = ? WHERE quote_id = ?',
      )
      .run(unitCents, unitCents, doc.id);
    return doc.id;
  }

  function aprovar(quoteId: string, alcada?: { profileCodes: string[]; authorizationId?: string }) {
    return promoteToPreSale({
      companyId: LOJA,
      userId: 'u-caixa',
      quoteId,
      alcada,
    });
  }

  it('O CENÁRIO MEDIDO: a moto de R$ 1,00 não chega mais a virar pré-venda nem venda', () => {
    /*
      O caminho inteiro que foi medido: promoteToPreSale + convertQuote saíam
      com venda de R$ 1,00, estoque baixado e `auditoria: []`. A mecânica do
      apagamento era sutil — a pré-venda NOVA nascia com concession_cents
      preenchido (createQuote mede mesmo quando não cobra), e com isso
      `autorizada` deixava de ser nula na conversão e a linha de "não
      conferida" nunca era escrita.

      Agora a alçada cobra na aprovação, que é a primeira vez que alguém olha
      para aquele preço.
    */
    const antigo = orcamentoAnteriorARodada();

    const erro = erroDe(() => aprovar(antigo, CAIXA));
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');

    // Nenhuma pré-venda nasceu — só continua existindo o orçamento antigo.
    expect(contar('SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ?', LOJA)).toBe(1);
    expect(documento(antigo).status).toBe('aberto');
    // Nenhuma venda, nenhuma baixa, nenhuma reserva.
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(0);
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 0 });
  });

  it('chamador que NÃO diz quem aprova também é recusado — a trava falha FECHADA', () => {
    /*
      Uma trava que só funciona quando o chamador lembra de preencher um campo
      é a trava que não existe: foi assim que a porta dos fundos nasceu da
      primeira vez, com `createSale` sendo chamado sem alçada. Lista de perfis
      ausente vira lista VAZIA, que não tem alçada para liberar nada.
    */
    const antigo = orcamentoAnteriorARodada();

    const erro = erroDe(() => aprovar(antigo));
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 0 });
  });

  it('COM liberação do gestor a aprovação passa, e deixa o rastro de que a origem não foi conferida', async () => {
    const { userId } = await operador();
    const antigo = orcamentoAnteriorARodada();

    const preVenda = promoteToPreSale({
      companyId: LOJA,
      userId,
      quoteId: antigo,
      alcada: { profileCodes: ['operador_caixa_loja'], authorizationId: liberacao(userId) },
    });

    // A pré-venda nasce conferida — e é isso que apagava o rastro antes.
    expect(documento(preVenda.id).concession_cents).toBe(MOTO - 100);
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });

    /*
      A linha que responde, meses depois, "de onde veio esta venda de R$ 1,00".
      Depois daqui ninguém mais consegue distinguir a pré-venda conferida na
      criação da pré-venda herdada de um documento que ninguém mediu: as duas
      carregam um número. Este é o único lugar em que a diferença existe.
    */
    const rastro = auditoria('quote.promote.origem_nao_conferida');
    expect(rastro).toHaveLength(1);
    const detalhe = JSON.parse(rastro[0].detail) as Record<string, unknown>;
    expect(detalhe.preSaleId).toBe(preVenda.id);
    expect(detalhe.perfis).toEqual(['operador_caixa_loja']);
  });

  it('orçamento antigo SEM concessão continua aprovando liso — a loja não para', () => {
    /*
      A maioria dos documentos anteriores à rodada foi escrita ao preço de
      tabela: eles nunca foram conferidos, e também nunca concederam nada. Se a
      cobrança na aprovação atingisse esses, a trava teria parado o balcão
      inteiro por causa de uma coluna que não existia — e a lição da rodada
      anterior é justamente essa: trava que empurra a operação para fora do
      caminho auditado é pior que não ter trava.
    */
    const antigo = orcamentoAnteriorARodada(MOTO);

    const preVenda = aprovar(antigo, CAIXA);
    expect(preVenda.kind).toBe('pre_venda');
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });
    // O rastro continua sendo escrito: a origem era mesmo não conferida.
    expect(auditoria('quote.promote.origem_nao_conferida')).toHaveLength(1);
  });

  it('documento JÁ conferido não é cobrado de novo, nem com concessão enorme aprovada', async () => {
    /*
      A regra que não podia quebrar. Este orçamento concede 99,99% e passou na
      criação com a liberação de um gestor — `concession_cents` ficou gravado.
      Aprovar é dizer "o cliente fechou", não escrever preço: pedir gestor de
      novo aqui seria cobrar duas vezes pela mesma decisão, e é exatamente o
      comportamento que a rodada anterior comprou com a trava na criação.
    */
    const { userId } = await operador();
    const doc = createQuote({
      companyId: LOJA,
      userId,
      kind: 'orcamento',
      items: [{ productId: 'p-moto', quantity: 1, unitPriceCents: 100 }],
      alcada: { profileCodes: ['operador_caixa_loja'], authorizationId: liberacao(userId) },
    });
    expect(documento(doc.id).concession_cents).toBe(MOTO - 100);

    const preVenda = promoteToPreSale({ companyId: LOJA, userId, quoteId: doc.id, alcada: CAIXA });

    expect(preVenda.total_cents).toBe(100);
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });
    // Nada a registrar: a origem FOI conferida.
    expect(auditoria('quote.promote.origem_nao_conferida')).toHaveLength(0);
  });

  it('PELA ROTA: POST /quotes/:id/promote recusa o documento antigo e aceita com liberação', async () => {
    /*
      O serviço só cobra se alguém lhe disser quem está aprovando, e quem sabe
      isso é a rota — ela já tinha os perfis à mão em `scope(req).profiles`,
      pelo mesmo caminho que POST /core/quotes usa. Este caso é o que impede a
      alçada de ficar pendurada num parâmetro que ninguém preenche.
    */
    const { token, userId } = await operador();
    const antigo = orcamentoAnteriorARodada();

    const recusa = await request(app)
      .post(`/api/v1/core/quotes/${antigo}/promote`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(recusa.status).toBe(403);
    expect(recusa.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 0 });

    const aprovada = await request(app)
      .post(`/api/v1/core/quotes/${antigo}/promote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ authorizationId: liberacao(userId) });

    expect(aprovada.status).toBe(201);
    expect(saldo('p-moto')).toEqual({ quantity: 50, reserved: 1 });
  });
});
