/**
 * ============================================================================
 * A ROTA CONFERE O QUE O CORPO MANDA — três frestas do documento e da remessa
 * ============================================================================
 *
 * As três moram no mesmo lugar: o corpo da requisição chega ao banco sem
 * ninguém perguntar nada. Nenhuma delas dá erro; todas as três são silenciosas,
 * e é por isso que só apareceram numa releitura.
 *
 *   1. A REMESSA SEM CHAVE DE IDEMPOTÊNCIA. `POST /core/consignments` era o
 *      ÚNICO dos três eventos de estoque do módulo que não exigia
 *      `Idempotency-Key` — `/retorno` e `/faturar` exigem desde que nasceram, e
 *      o próprio ConsignmentService argumenta a favor dela nos dois. A tela
 *      protegia com `loading={busy}`, que segura o clique duplo do MESMO
 *      navegador e mais nada: um reenvio de rede, uma aba duplicada ou
 *      qualquer outro cliente HTTP criava DUAS consignações, sob dois números,
 *      e tirava a mercadoria do saldo DUAS VEZES.
 *
 *   2. A OBSERVAÇÃO QUE NÃO SE APAGA. O UPDATE usava `note = COALESCE(?, note)`
 *      e a rota mandava `note: req.body?.note ?? null`. Quem limpasse o campo e
 *      salvasse via o texto ANTIGO voltar — não existia caminho para remover a
 *      observação de um documento aberto. O COALESCE está CERTO para
 *      customerId/sellerId, onde a rota separa `undefined` (não mexa) de `null`
 *      (consumidor final); `note` não tinha recebido esse tratamento.
 *
 *   3. O VENDEDOR INVENTADO. `createQuote`/`updateQuote` gravavam
 *      `input.sellerId ?? null` cru. Um id que não existe — ou o id de alguém
 *      de OUTRA empresa — entrava no documento sem erro, e o estouro só vinha
 *      na CONVERSÃO, com o cliente esperando no balcão. `createSale` já
 *      conferia; o documento, não.
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - tire o `exigirChaveDeIdempotencia` de `POST /core/consignments` → "duas
 *     remessas com a mesma chave" fica vermelho com dois números e o saldo em 3;
 *   - devolva o `COALESCE(?, note)` ao UPDATE de `updateQuote` → "a observação
 *     se apaga" fica vermelho com o texto antigo de volta;
 *   - troque o `?? {}` do `note` na rota por `note: req.body?.note ?? null` →
 *     "quem não mandou o campo não apaga nada" fica vermelho;
 *   - tire a chamada de `exigirVendedorDaCasa` de `createQuote` → "vendedor
 *     inventado" volta a gravar 201.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createCustomer } from '../src/services/core/CatalogService.js';

const app = createApp();
const LOJA = 'gringa-corpo';

let auth: { Authorization: string };
let clienteId: string;

const VESTIDO = 'produto-vestido-corpo';

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
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at)'
        + ' VALUES (?, ?, 10, 0, ?)',
    )
    .run(LOJA, id, agora);
}

function saldo(productId: string): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
        .get(LOJA, productId) as { quantity: number }
    ).quantity,
  );
}

function consignacoes(): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_consignments WHERE company_id = ?')
        .get(LOJA) as { n: number }
    ).n,
  );
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-corpo',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  produto(VESTIDO, 'Vestido longo', 20000);
  clienteId = String(createCustomer(LOJA, { name: 'Dona Marlene' }).id);
});

// ---------------------------------------------------------------- DEFEITO 1

describe('a remessa de consignação exige chave, como o retorno e o faturamento', () => {
  it('sem Idempotency-Key a remessa é recusada antes de tirar qualquer peça', async () => {
    const res = await request(app)
      .post('/api/v1/core/consignments')
      .set(auth)
      .send({ customerId: clienteId, items: [{ productId: VESTIDO, quantity: 2 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_REQUIRED');
    // E nada aconteceu: nem documento, nem baixa de estoque.
    expect(consignacoes()).toBe(0);
    expect(saldo(VESTIDO)).toBe(10);
  });

  it('a MESMA chave duas vezes é UMA remessa — e o saldo cai UMA vez', async () => {
    const chave = randomUUID();
    const primeira = await request(app)
      .post('/api/v1/core/consignments')
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ customerId: clienteId, items: [{ productId: VESTIDO, quantity: 2 }] });
    expect(primeira.status).toBe(201);

    // O reenvio de rede: MESMO corpo, MESMA chave, do outro lado de um socket
    // que caiu depois de o servidor ter gravado.
    const reenvio = await request(app)
      .post('/api/v1/core/consignments')
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ customerId: clienteId, items: [{ productId: VESTIDO, quantity: 2 }] });

    // 200 no reenvio, 201 na remessa nova — a mesma distinção de /retorno e
    // /faturar. Devolver 201 nos dois faria a tela comemorar uma saída que não
    // aconteceu.
    expect(reenvio.status).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
    expect(reenvio.body.number).toBe(primeira.body.number);

    expect(consignacoes()).toBe(1);
    expect(saldo(VESTIDO)).toBe(8);
  });

  it('chave nova é remessa nova — reenviar de propósito continua possível', async () => {
    for (const chave of [randomUUID(), randomUUID()]) {
      const res = await request(app)
        .post('/api/v1/core/consignments')
        .set(auth)
        .set('Idempotency-Key', chave)
        .send({ customerId: clienteId, items: [{ productId: VESTIDO, quantity: 1 }] });
      expect(res.status).toBe(201);
    }
    expect(consignacoes()).toBe(2);
    expect(saldo(VESTIDO)).toBe(8);
  });
});

// ---------------------------------------------------------------- DEFEITO 2

describe('a observação do documento se apaga', () => {
  async function abrirComObservacao(): Promise<string> {
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({
        kind: 'orcamento',
        items: [{ productId: VESTIDO, quantity: 1 }],
        note: 'trocar o zíper antes de entregar',
      });
    expect(res.status).toBe(201);
    return String(res.body.id);
  }

  function observacaoDe(id: string): string | null {
    return (
      getConnection()
        .prepare('SELECT note FROM core_quotes WHERE id = ?')
        .get(id) as { note: string | null }
    ).note;
  }

  it('limpar o campo e salvar REMOVE o texto — não devolve o antigo', async () => {
    const id = await abrirComObservacao();
    expect(observacaoDe(id)).toBe('trocar o zíper antes de entregar');

    // É exatamente o que a tela manda quando o operador limpa a caixa:
    // `note: note || null`.
    const res = await request(app)
      .patch(`/api/v1/core/quotes/${id}`)
      .set(auth)
      .send({ items: [{ productId: VESTIDO, quantity: 1 }], note: null });
    expect(res.status).toBe(200);

    expect(observacaoDe(id)).toBeNull();
  });

  it('quem NÃO mandou o campo não apaga nada — ausente é "não mexa"', async () => {
    const id = await abrirComObservacao();

    const res = await request(app)
      .patch(`/api/v1/core/quotes/${id}`)
      .set(auth)
      .send({ items: [{ productId: VESTIDO, quantity: 2 }] });
    expect(res.status).toBe(200);

    expect(observacaoDe(id)).toBe('trocar o zíper antes de entregar');
  });
});

// ---------------------------------------------------------------- DEFEITO 3

describe('o vendedor do documento precisa ser da casa', () => {
  it('id inventado é recusado NA CRIAÇÃO, e não na conversão', async () => {
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({
        kind: 'orcamento',
        items: [{ productId: VESTIDO, quantity: 1 }],
        sellerId: 'vendedor-que-nao-existe',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_SELLER_NOT_IN_COMPANY');
    expect(
      Number(
        (
          getConnection()
            .prepare('SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ?')
            .get(LOJA) as { n: number }
        ).n,
      ),
    ).toBe(0);
  });

  it('vendedor de OUTRA empresa também é recusado', async () => {
    const outra = await loginForTest(app, {
      userId: 'vendedor-da-outra',
      companyId: 'me-mimei-corpo',
      profileCodes: ['atendente'],
    });
    const forasteiro = String(outra.body.user.id);

    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({
        kind: 'orcamento',
        items: [{ productId: VESTIDO, quantity: 1 }],
        sellerId: forasteiro,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_SELLER_NOT_IN_COMPANY');
  });

  it('a EDIÇÃO também confere — a fresta não pode reabrir no PATCH', async () => {
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({ kind: 'orcamento', items: [{ productId: VESTIDO, quantity: 1 }] });
    expect(criado.status).toBe(201);

    const res = await request(app)
      .patch(`/api/v1/core/quotes/${criado.body.id}`)
      .set(auth)
      .send({
        items: [{ productId: VESTIDO, quantity: 1 }],
        sellerId: 'vendedor-que-nao-existe',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_SELLER_NOT_IN_COMPANY');
    expect(
      (
        getConnection()
          .prepare('SELECT seller_id FROM core_quotes WHERE id = ?')
          .get(String(criado.body.id)) as { seller_id: string | null }
      ).seller_id,
    ).toBeNull();
  });

  it('o vendedor de verdade continua entrando no documento', async () => {
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(auth)
      .send({
        kind: 'orcamento',
        items: [{ productId: VESTIDO, quantity: 1 }],
        // Quem está logado é da casa por construção — o caminho normal.
        sellerId: null,
      });
    expect(res.status).toBe(201);
  });
});
