/**
 * ============================================================================
 * AUDITORIA — FASE 3: OS CADASTROS DO GESTOR (rodada de auditoria externa)
 * ============================================================================
 *
 * A pergunta desta fase não é "a rota existe?" — é "o ciclo inteiro fecha?":
 * CRIAR → REABRIR (o GET devolve o que foi salvo, campo a campo) → EDITAR →
 * REABRIR de novo → INATIVAR conforme a regra da casa → e o REFLEXO no módulo
 * vizinho (PDV, pedido de compra). Mais as falsificações: CPF inválido,
 * documento duplicado, preço negativo, código de barras repetido, e-mail
 * repetido na equipe.
 *
 * O QUE A VARREDURA DAS ROTAS REVELOU ANTES DE QUALQUER TESTE RODAR
 * (grep em server/src/routes/v1/core.ts):
 *
 *   CLIENTE     na varredura original: GET /customers, POST /customers,
 *               PUT /customers/:id/price-table e POST /customers/:id/convite-
 *               portal — e mais nada. O cadastro era write-once: telefone
 *               digitado errado era eterno, e a coluna `active` tinha leitor
 *               (listCustomers filtra active = 1) sem nenhum escritor.
 *               CONSERTADO na rodada de consertos: existem GET /customers/:id
 *               (a ficha) e PUT /customers/:id (edição, com inativação pelo
 *               campo `active`, como no produto) — os testes abaixo exercitam
 *               as rotas novas.
 *
 *   FORNECEDOR  CRUD completo (GET lista, GET :id, POST, PATCH, POST :id/active).
 *
 *   PRODUTO     CRUD completo (POST, GET :id, PUT, e `active` viaja no PUT).
 *
 *   CATEGORIA   POST /taxonomy/categories (upsert: sem id cria, com id renomeia),
 *               DELETE /taxonomy/categories/:id, merge.
 *
 *   FORMA DE PAGAMENTO  só GET /payment-methods — e isso é DECISÃO DOCUMENTADA
 *               (PaymentMethods.ts: catálogo em código, porque cada método tem
 *               comportamento amarrado; tabela deixaria cadastrar "Cheque" que
 *               nenhuma linha de código sabe processar). CRUD aqui é
 *               não-aplicável, não é achado.
 *
 *   EQUIPE      CRUD completo (GET, POST, PATCH, POST :id/active, :id/password).
 *
 * COBERTURA JÁ EXISTENTE QUE ESTE ARQUIVO NÃO DUPLICA:
 *   - fornecedor: CNPJ duplicado, com/sem máscara, prazo negativo, desativado
 *     não recebe pedido de compra novo, desativar preserva histórico —
 *     tests/compras.test.ts (67–135, 204);
 *   - código de barras duplicado NA EDIÇÃO (principal e adicional) —
 *     tests/ajuste-manual-tem-motivo.test.ts (199–260); aqui cobrimos a CRIAÇÃO;
 *   - equipe: login duplicado, senha curta, desativar derruba sessão e barra
 *     login, reset de senha — tests/team.test.ts;
 *   - catálogo de formas de recebimento (quatro ativos, crediário desligado,
 *     método inválido recusado na venda) — tests/formas-de-recebimento.test.ts;
 *   - regras finas de categoria/marca em nível de serviço (nome repetido,
 *     profundidade, fusão) — tests/categorias-marcas.test.ts. Aqui o fluxo é
 *     pela ROTA, com o reflexo no produto.
 *
 * OS VERMELHOS DESTE ARQUIVO ERAM ACHADOS, NÃO ERROS DE TESTE. O estado após a
 * rodada de consertos:
 *   1. CONSERTADO — cliente ganhou edição (PUT /customers/:id) e ficha
 *      (GET /customers/:id); a asserção continua a mesma, a rota agora existe;
 *   2. CONSERTADO — inativação viaja no campo `active` do MESMO PUT, como no
 *      produto; cadastro não se apaga, sai de circulação;
 *   3. CONSERTADO — CPF (11 dígitos) e CNPJ (14) passam pelo módulo 11 na
 *      criação e na edição; era por essa porta que FiscalXmlNfce (linha 450)
 *      levava o documento errado ao XML da NFC-e e a rejeição estourava na
 *      SEFAZ, na hora da venda, longe da causa;
 *   4. CONSERTADO — criarCliente grava só dígitos e o dedupe compara
 *      normalizado contra normalizado (dos dois lados, por causa do cadastro
 *      antigo mascarado), como o SupplierService e o checkout já faziam;
 *   5. CONSERTADO — preço, custo e piso negativos são recusados no POST e no
 *      PUT com o mesmo código da reprecificação em massa (CORE_PRICE_INVALID);
 *   6. CONSERTADO (conserto vizinho, em TeamService) — dois membros com o
 *      MESMO e-mail agora são 409; antes só o login era conferido
 *      (CORE_LOGIN_TAKEN).
 * As beiradas dos consertos 1–5 (PUT negativo, banco só com dígitos, legado
 * mascarado, edição validando documento) vivem em
 * tests/cadastro-fecha-o-ciclo.test.ts.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

/** O gestor — passa por qualquer requireProfile, como manda o RBAC da casa. */
let gestor: { Authorization: string };
/** O caixa do balcão — é por OLHOS DELE que o reflexo no PDV é medido. */
let caixa: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, {
    userId: 'gestor-auditoria',
    companyId: 'loja-auditoria',
    profileCodes: ['gestor'],
  });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  gestor = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;

  const c = await loginForTest(app, {
    userId: 'caixa-auditoria',
    companyId: 'loja-auditoria',
    profileCodes: ['operador_caixa_loja'],
  });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  caixa = { Authorization: `Bearer ${c.body.accessToken}` };
});

// ============================================================================
// CLIENTE
// ============================================================================

describe('cliente — criar e reabrir', () => {
  it('o que foi salvo volta campo a campo na lista', async () => {
    const corpo = {
      name: 'Maria das Bicicletas',
      document: '11144477735', // CPF válido, sem máscara
      email: 'maria@exemplo.com.br',
      phone: '96 99999-1234',
      address: 'Av. FAB, 1200 — Macapá/AP',
      notes: 'Prefere retirar na loja',
      code: 'CLI-0001',
    };
    const criado = await request(app).post('/api/v1/core/customers').set(gestor).send(corpo);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.id).toBeTruthy();

    // REABRIR pela listagem — a leitura que o balcão usa. A ficha individual
    // (GET /customers/:id) é exercitada no ciclo de edição, logo abaixo.
    const lista = await request(app).get('/api/v1/core/customers').set(gestor);
    expect(lista.status).toBe(200);
    const linha = (lista.body.items as Record<string, unknown>[]).find(
      (c) => c.id === criado.body.id,
    );
    expect(linha, 'cliente recém-criado não voltou na listagem').toBeTruthy();
    expect(linha!.name).toBe(corpo.name);
    expect(linha!.document).toBe(corpo.document);
    expect(linha!.email).toBe(corpo.email);
    expect(linha!.phone).toBe(corpo.phone);
    expect(linha!.address).toBe(corpo.address);
    expect(linha!.notes).toBe(corpo.notes);
    expect(linha!.code).toBe(corpo.code);
    expect(linha!.active).toBe(1);
    expect(linha!.price_table_id).toBeNull();
  });

  it('o MESMO documento, idêntico, é recusado com 409', async () => {
    const um = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria', document: '11144477735' });
    expect(um.status).toBe(201);

    const dois = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria de Novo', document: '11144477735' });
    expect(dois.status, JSON.stringify(dois.body)).toBe(409);
    expect(dois.body.error?.code).toBe('CORE_DUPLICATE_DOCUMENT');
  });
});

describe('cliente — as falsificações que o cadastro recusa', () => {
  it('CPF com dígito verificador errado é recusado na porta', async () => {
    /*
      12345678900 falha na conta do segundo dígito (o válido é 12345678909).
      criarCliente confere o módulo 11 (isValidCpf/isValidCnpj) porque o
      estrago de deixar passar aparecia longe: FiscalXmlNfce lê
      core_customers.document e o escreve em <CPF> do XML da NFC-e — a SEFAZ
      rejeitava NA VENDA, meses depois do erro de digitação, com o cliente no
      balcão. Barrar aqui é o único momento em que o erro custa barato.
    */
    const res = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Cliente Fantasma', document: '12345678900' });
    expect(res.status, `CPF inválido foi aceito: ${JSON.stringify(res.body)}`).toBe(400);
  });

  it('o mesmo CPF com máscara é o MESMO cliente — o segundo cadastro é recusado', async () => {
    /*
      criarCliente grava só os DÍGITOS e o dedupe compara normalizado contra
      normalizado — a regra que o SupplierService sempre teve ("CNPJ com e sem
      máscara têm de ser a MESMA transportadora", diz o CarrierService) e que o
      cadastro de cliente tinha ficado de fora. Sem ela, a mesma pessoa virava
      dois históricos, e nenhum dos dois dizia a verdade.
    */
    const semMascara = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria', document: '11144477735' });
    expect(semMascara.status).toBe(201);

    const comMascara = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria Duplicada', document: '111.444.777-35' });
    expect(
      comMascara.status,
      `mesmo CPF mascarado virou segundo cadastro: ${JSON.stringify(comMascara.body)}`,
    ).toBe(409);
  });
});

describe('cliente — editar e inativar (o ciclo fecha)', () => {
  it('corrigir um telefone digitado errado — o PUT edita e o GET devolve a ficha', async () => {
    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'João da Silva', phone: '96 98888-0000' });
    expect(criado.status).toBe(201);

    // A rota que qualquer tela de cadastro espera: PUT /customers/:id, com os
    // MESMOS perfis do POST — quem cadastra no balcão corrige o próprio erro.
    const edicao = await request(app)
      .put(`/api/v1/core/customers/${criado.body.id}`)
      .set(gestor)
      .send({ phone: '96 97777-1111' });
    expect(edicao.status, JSON.stringify(edicao.body)).toBe(200);
    expect(edicao.body.phone).toBe('96 97777-1111');

    // REABRIR pela ficha (GET /customers/:id): o corrigido veio, e o que não
    // foi tocado permanece.
    const ficha = await request(app)
      .get(`/api/v1/core/customers/${criado.body.id}`)
      .set(gestor);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.phone).toBe('96 97777-1111');
    expect(ficha.body.name).toBe('João da Silva');
  });

  it('inativar cliente — active viaja no PUT, e o balcão para de achar', async () => {
    /*
      listCustomers filtra `active = 1`, então o reflexo (sumir da busca do
      balcão) já estava pronto — faltava o escritor. O escritor é o campo
      `active` do MESMO PUT da edição, como no produto: cadastro nunca se
      apaga, sai de circulação.
    */
    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Cliente Que Mudou de Cidade' });
    expect(criado.status).toBe(201);

    const inativa = await request(app)
      .put(`/api/v1/core/customers/${criado.body.id}`)
      .set(gestor)
      .send({ active: false });
    expect(inativa.status, JSON.stringify(inativa.body)).toBe(200);
    expect(inativa.body.active).toBe(0);

    const lista = await request(app).get('/api/v1/core/customers').set(gestor);
    expect(
      (lista.body.items as { id: string }[]).map((c) => c.id),
    ).not.toContain(criado.body.id);
  });
});

// ============================================================================
// FORNECEDOR
// ============================================================================

describe('fornecedor — o ciclo inteiro pela rota', () => {
  it('criar → reabrir campo a campo → editar → reabrir → inativar → sumir da lista de compra', async () => {
    const corpo = {
      name: 'Distribuidora Amazonas Ltda',
      tradeName: 'DistriAma',
      document: '11.222.333/0001-81', // com máscara — o serviço normaliza
      email: 'vendas@distriama.com.br',
      phone: '92 3222-1000',
      contactName: 'Sr. Raimundo',
      city: 'Manaus',
      state: 'AM',
      paymentTermDays: 28,
      deliveryDays: 12,
      notes: 'Pedido mínimo R$ 500',
    };
    const criado = await request(app).post('/api/v1/core/suppliers').set(gestor).send(corpo);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const id = criado.body.id as string;

    // REABRIR: GET /suppliers/:id devolve a ficha, campo a campo.
    const ficha = await request(app).get(`/api/v1/core/suppliers/${id}`).set(gestor);
    expect(ficha.status).toBe(200);
    expect(ficha.body.name).toBe(corpo.name);
    expect(ficha.body.trade_name).toBe(corpo.tradeName);
    expect(ficha.body.document).toBe('11222333000181'); // só dígitos, como manda a casa
    expect(ficha.body.email).toBe(corpo.email);
    expect(ficha.body.phone).toBe(corpo.phone);
    expect(ficha.body.contact_name).toBe(corpo.contactName);
    expect(ficha.body.city).toBe(corpo.city);
    expect(ficha.body.state).toBe(corpo.state);
    expect(ficha.body.payment_term_days).toBe(28);
    expect(ficha.body.delivery_days).toBe(12);
    expect(ficha.body.notes).toBe(corpo.notes);
    expect(ficha.body.active).toBe(1);
    // Nunca vendeu: o histórico vem ZERADO, não ausente — e zerado de verdade.
    expect(ficha.body.history.noteCount).toBe(0);
    expect(ficha.body.history.totalCents).toBe(0);
    expect(ficha.body.history.notes).toEqual([]);

    // EDITAR: o prazo mudou na renegociação; o resto NÃO pode ser arrastado.
    const edita = await request(app)
      .patch(`/api/v1/core/suppliers/${id}`)
      .set(gestor)
      .send({ paymentTermDays: 35, email: 'comercial@distriama.com.br' });
    expect(edita.status, JSON.stringify(edita.body)).toBe(200);

    // REABRIR de novo: o que mudou, mudou; o que não foi tocado, permanece.
    const ficha2 = await request(app).get(`/api/v1/core/suppliers/${id}`).set(gestor);
    expect(ficha2.body.payment_term_days).toBe(35);
    expect(ficha2.body.email).toBe('comercial@distriama.com.br');
    expect(ficha2.body.name).toBe(corpo.name);
    expect(ficha2.body.document).toBe('11222333000181');
    expect(ficha2.body.delivery_days).toBe(12);

    // INATIVAR: some da lista de quem vai comprar…
    const inativa = await request(app)
      .post(`/api/v1/core/suppliers/${id}/active`)
      .set(gestor)
      .send({ active: false });
    expect(inativa.status).toBe(200);
    expect(inativa.body.active).toBe(0);

    const lista = await request(app).get('/api/v1/core/suppliers').set(gestor);
    expect((lista.body.items as { id: string }[]).map((s) => s.id)).not.toContain(id);

    // …mas continua legível para quem pedir o arquivo morto.
    const completa = await request(app)
      .get('/api/v1/core/suppliers?includeInactive=true')
      .set(gestor);
    expect((completa.body.items as { id: string }[]).map((s) => s.id)).toContain(id);

    // REFLEXO: pedido de compra novo para o inativado é recusado — regra já
    // coberta por tests/compras.test.ts ("fornecedor desativado não recebe
    // pedido"); conferida aqui de passagem porque o fluxo já estava montado.
    const pedido = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(gestor)
      .send({ supplierId: id, items: [{ description: 'Caixa de câmaras', quantity: 10, unitCostCents: 1500 }] });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(400);
    expect(pedido.body.error?.code).toBe('CORE_SUPPLIER_INACTIVE');
  });
});

// ============================================================================
// PRODUTO
// ============================================================================

describe('produto — SKU, código de barras, preços e o reflexo no PDV', () => {
  it('criar → reabrir → editar preço → reabrir → inativar → o balcão para de achar', async () => {
    const corpo = {
      name: 'Bicicleta Aro 29 Trilha',
      internalCode: 'BIKE-000029',
      sku: 'TRK-29-PRETA',
      barcode: '7891234567895',
      priceCents: 129_900,
      costCents: 78_000,
      minStock: 2,
      minPriceCents: 99_900,
      category: 'Bicicletas',
      brand: 'Trilha',
      unit: 'UN',
      description: 'Quadro de alumínio, 21 marchas',
    };
    const criado = await request(app).post('/api/v1/core/products').set(gestor).send(corpo);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const id = criado.body.id as string;

    // REABRIR: a ficha devolve o que foi salvo, campo a campo — e o preço
    // vigente É o preço de tabela, porque não há promoção nenhuma.
    const ficha = await request(app).get(`/api/v1/core/products/${id}`).set(gestor);
    expect(ficha.status).toBe(200);
    expect(ficha.body.name).toBe(corpo.name);
    expect(ficha.body.internal_code).toBe(corpo.internalCode);
    expect(ficha.body.sku).toBe(corpo.sku);
    expect(ficha.body.barcode).toBe(corpo.barcode);
    expect(ficha.body.price_cents).toBe(129_900);
    expect(ficha.body.cost_cents).toBe(78_000);
    expect(ficha.body.min_stock).toBe(2);
    expect(ficha.body.min_price_cents).toBe(99_900);
    expect(ficha.body.category).toBe(corpo.category);
    expect(ficha.body.brand).toBe(corpo.brand);
    expect(ficha.body.active).toBe(1);
    expect(ficha.body.effective_price_cents).toBe(129_900);

    // ANTES de mexer: o caixa bipa o código e o produto responde com o preço.
    const bipe = await request(app)
      .get('/api/v1/core/products/search?q=7891234567895')
      .set(caixa);
    expect(bipe.status).toBe(200);
    expect(bipe.body.items).toHaveLength(1);
    expect(bipe.body.items[0].id).toBe(id);
    expect(bipe.body.items[0].effective_price_cents).toBe(129_900);

    // EDITAR: preço de prateleira caiu na renegociação com o fornecedor.
    const edita = await request(app)
      .put(`/api/v1/core/products/${id}`)
      .set(gestor)
      .send({ priceCents: 119_900, description: 'Quadro de alumínio, 21 marchas Shimano' });
    expect(edita.status, JSON.stringify(edita.body)).toBe(200);

    // REABRIR de novo: preço novo na ficha E no bipe do balcão; SKU intacto.
    const ficha2 = await request(app).get(`/api/v1/core/products/${id}`).set(gestor);
    expect(ficha2.body.price_cents).toBe(119_900);
    expect(ficha2.body.effective_price_cents).toBe(119_900);
    expect(ficha2.body.description).toBe('Quadro de alumínio, 21 marchas Shimano');
    expect(ficha2.body.sku).toBe(corpo.sku);
    expect(ficha2.body.cost_cents).toBe(78_000);

    const bipe2 = await request(app)
      .get('/api/v1/core/products/search?q=7891234567895')
      .set(caixa);
    expect(bipe2.body.items[0].effective_price_cents).toBe(119_900);

    // INATIVAR (a regra da casa: active viaja no PUT; cadastro nunca se apaga).
    const inativa = await request(app)
      .put(`/api/v1/core/products/${id}`)
      .set(gestor)
      .send({ active: false });
    expect(inativa.status).toBe(200);
    expect(inativa.body.active).toBe(0);

    // REFLEXO NO PDV: nem o bipe do código acha mais — searchProducts corta
    // em `p.active = 1` antes de qualquer critério.
    const bipe3 = await request(app)
      .get('/api/v1/core/products/search?q=7891234567895')
      .set(caixa);
    expect(bipe3.status).toBe(200);
    expect(bipe3.body.items).toHaveLength(0);

    // …e a gestão CONTINUA vendo o inativo na listagem — o cadastro não some,
    // sai de circulação.
    const gestao = await request(app)
      .get('/api/v1/core/products?search=BIKE-000029')
      .set(gestor);
    expect((gestao.body.items as { id: string }[]).map((p) => p.id)).toContain(id);
  });

  it('código de barras de outro produto é recusado JÁ NA CRIAÇÃO', async () => {
    // A EDIÇÃO já está coberta por ajuste-manual-tem-motivo.test.ts; aqui é a
    // outra metade — createProduct pergunta nas duas tabelas antes do INSERT.
    const dono = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Câmara 29', priceCents: 3_500, barcode: '7899999999999' });
    expect(dono.status).toBe(201);

    const clone = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Câmara 29 de novo', priceCents: 3_500, barcode: '7899999999999' });
    expect(clone.status, JSON.stringify(clone.body)).toBe(409);
    expect(clone.body.error?.code).toBe('CORE_BARCODE_DUPLICATE');
  });

  it('código interno repetido é recusado', async () => {
    const um = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Capacete M', internalCode: 'CAP-000001', priceCents: 8_900 });
    expect(um.status).toBe(201);

    const dois = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Capacete G', internalCode: 'CAP-000001', priceCents: 9_900 });
    expect(dois.status, JSON.stringify(dois.body)).toBe(409);
    expect(dois.body.error?.code).toBe('CORE_DUPLICATE_CODE');
  });

  it('preço NEGATIVO é recusado no cadastro', async () => {
    /*
      createProduct recusa sinal trocado em preço, custo e piso — com o MESMO
      código da reprecificação em massa (applyPrices, CORE_PRICE_INVALID,
      coberto por reprecificacao.test.ts): um fato, uma recusa. Um -500 gravado
      viraria desconto infinito no carrinho que o PricingService somasse. A
      outra porta (o PUT) é coberta em tests/cadastro-fecha-o-ciclo.test.ts.
    */
    const res = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Produto de Preço Impossível', priceCents: -500 });
    expect(res.status, `preço negativo aceito: ${JSON.stringify(res.body)}`).toBe(400);
  });
});

// ============================================================================
// CATEGORIA
// ============================================================================

describe('categoria — o ciclo pela rota, com o reflexo no produto', () => {
  it('criar → reabrir → renomear (o produto vai junto) → remover respeita o uso', async () => {
    // CRIAR
    const criada = await request(app)
      .post('/api/v1/core/taxonomy/categories')
      .set(gestor)
      .send({ name: 'Bicicletas' });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    const id = criada.body.id as string;

    // REABRIR: a taxonomia lista, com uso zero.
    const tax1 = await request(app).get('/api/v1/core/taxonomy').set(gestor);
    const na1 = (tax1.body.categories as { id: string; name: string; usage: number }[]).find(
      (c) => c.id === id,
    );
    expect(na1?.name).toBe('Bicicletas');
    expect(na1?.usage).toBe(0);

    // Um produto passa a usar a categoria.
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Bicicleta Infantil Aro 16', priceCents: 45_900, category: 'Bicicletas' });
    expect(produto.status).toBe(201);

    // EDITAR (renomear): o mesmo POST, com id — e o produto TEM de ir junto.
    const renomeia = await request(app)
      .post('/api/v1/core/taxonomy/categories')
      .set(gestor)
      .send({ id, name: 'Bikes' });
    expect(renomeia.status, JSON.stringify(renomeia.body)).toBe(201);

    // REABRIR de novo: nome novo na lista, uso contado, e o produto aponta
    // para o nome novo — senão o cadastro apontaria para um nome extinto.
    const tax2 = await request(app).get('/api/v1/core/taxonomy').set(gestor);
    const na2 = (tax2.body.categories as { id: string; name: string; usage: number }[]).find(
      (c) => c.id === id,
    );
    expect(na2?.name).toBe('Bikes');
    expect(na2?.usage).toBe(1);

    const fichaProduto = await request(app)
      .get(`/api/v1/core/products/${produto.body.id}`)
      .set(gestor);
    expect(fichaProduto.body.category).toBe('Bikes');

    // REMOVER em uso: recusado — a regra da casa manda usar a fusão.
    const removeEmUso = await request(app)
      .delete(`/api/v1/core/taxonomy/categories/${id}`)
      .set(gestor);
    expect(removeEmUso.status, JSON.stringify(removeEmUso.body)).toBe(409);
    expect(removeEmUso.body.error?.code).toBe('CORE_CATEGORY_IN_USE');

    // O produto muda de categoria; aí sim a remoção passa e a lista esquece.
    await request(app)
      .put(`/api/v1/core/products/${produto.body.id}`)
      .set(gestor)
      .send({ category: 'Avulsos' })
      .expect(200);
    const remove = await request(app)
      .delete(`/api/v1/core/taxonomy/categories/${id}`)
      .set(gestor);
    expect(remove.status, JSON.stringify(remove.body)).toBe(200);
    expect(
      (remove.body.categories as { id: string }[]).map((c) => c.id),
    ).not.toContain(id);
  });
});

// ============================================================================
// FORMA DE PAGAMENTO
// ============================================================================

describe('forma de recebimento — cardápio, não cadastro', () => {
  it('a rota entrega os quatro ativos ao balcão, e o crediário desligado fica de fora', async () => {
    /*
      CRUD aqui é NÃO-APLICÁVEL por decisão escrita em PaymentMethods.ts:
      método de pagamento é COMPORTAMENTO (dinheiro mexe na gaveta, cartão
      passa na maquininha), não dado — tabela deixaria cadastrar "Cheque" que
      nenhuma linha de código sabe processar. O catálogo em si já é coberto por
      formas-de-recebimento.test.ts em nível de serviço; o que este caso prova
      é o CONTRATO HTTP que o PDV consome.
    */
    const res = await request(app).get('/api/v1/core/payment-methods').set(caixa);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const codes = (res.body.methods as { code: string }[]).map((m) => m.code);
    expect(codes).toEqual(['dinheiro', 'debito', 'credito', 'pix']);
    expect(codes).not.toContain('crediario');
  });
});

// ============================================================================
// USUÁRIO DA EQUIPE
// ============================================================================

describe('usuário da equipe — criar, reabrir, editar', () => {
  const NOVO = {
    login: 'ATENDENTE.NOVA',
    displayName: 'Atendente Nova',
    email: 'atendente@lojaauditoria.com.br',
    profileCode: 'atendente',
    password: 'Provisoria@2026',
  };

  it('criar → aparece na lista → editar nome e e-mail → a releitura devolve o novo', async () => {
    const criado = await request(app).post('/api/v1/core/team').set(gestor).send(NOVO);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.login).toBe(NOVO.login);
    expect(criado.body.email).toBe(NOVO.email);
    expect(criado.body.profileCode).toBe('atendente');
    expect(criado.body.mustChangePassword).toBe(true);
    // Senha e hash nunca voltam — regra já cobrada por team.test.ts, conferida
    // de passagem porque o corpo está na mão.
    expect(JSON.stringify(criado.body)).not.toContain(NOVO.password);
    expect(JSON.stringify(criado.body).toLowerCase()).not.toContain('password_hash');

    // REABRIR: a lista da equipe devolve o membro.
    const lista = await request(app).get('/api/v1/core/team').set(gestor);
    const linha = (lista.body.items as Record<string, unknown>[]).find(
      (m) => m.id === criado.body.id,
    );
    expect(linha?.displayName).toBe(NOVO.displayName);
    expect(linha?.email).toBe(NOVO.email);
    expect(linha?.active).toBe(true);

    // EDITAR: casou, trocou de nome e de e-mail.
    const edita = await request(app)
      .patch(`/api/v1/core/team/${criado.body.id}`)
      .set(gestor)
      .send({ displayName: 'Atendente Nova Souza', email: 'nova.souza@lojaauditoria.com.br' });
    expect(edita.status, JSON.stringify(edita.body)).toBe(200);

    // REABRIR de novo: o novo valor, e só ele.
    const lista2 = await request(app).get('/api/v1/core/team').set(gestor);
    const linha2 = (lista2.body.items as Record<string, unknown>[]).find(
      (m) => m.id === criado.body.id,
    );
    expect(linha2?.displayName).toBe('Atendente Nova Souza');
    expect(linha2?.email).toBe('nova.souza@lojaauditoria.com.br');
    expect(linha2?.login).toBe(NOVO.login); // o login não muda por PATCH
    // Inativação e login duplicado: COBERTOS por team.test.ts (desativar
    // derruba a sessão e barra o login; login repetido é 409).
  });

  it('e-mail já usado por outro membro é recusado', async () => {
    /*
      Antes só o LOGIN era conferido (CORE_LOGIN_TAKEN, case-insensitive) e o
      e-mail entrava sem dedupe nenhum: dois crachás com o mesmo endereço. Hoje
      o campo é só informativo — nada loga por e-mail —, mas é exatamente o
      tipo de duplicata que explodiria no dia em que notificação ou recuperação
      de senha passasse a usá-lo. O conserto vive em TeamService.
    */
    const um = await request(app).post('/api/v1/core/team').set(gestor).send(NOVO);
    expect(um.status).toBe(201);

    const dois = await request(app)
      .post('/api/v1/core/team')
      .set(gestor)
      .send({ ...NOVO, login: 'ATENDENTE.OUTRA', displayName: 'Atendente Outra' });
    expect(dois.status, `e-mail duplicado aceito: ${JSON.stringify(dois.body)}`).toBe(409);
  });
});

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

describe('configuração — salva, relida, e o inválido não derruba o que estava', () => {
  it('o CFOP de venda da entrada: PUT grava, GET devolve, e a série de entrada é recusada', async () => {
    // Antes de qualquer configuração: o padrão honesto é nulo, não erro.
    const antes = await request(app).get('/api/v1/core/inbound/config').set(gestor);
    expect(antes.status).toBe(200);
    expect(antes.body.defaultSaleCfop).toBeNull();

    // SALVAR: 5102 — venda dentro do estado, como a loja vende.
    const salva = await request(app)
      .put('/api/v1/core/inbound/config')
      .set(gestor)
      .send({ defaultSaleCfop: '5102' });
    expect(salva.status, JSON.stringify(salva.body)).toBe(200);
    expect(salva.body.defaultSaleCfop).toBe('5102');

    // RELER: o que foi salvo volta.
    const depois = await request(app).get('/api/v1/core/inbound/config').set(gestor);
    expect(depois.body.defaultSaleCfop).toBe('5102');

    // FALSIFICAÇÃO: 1102 é CFOP de ENTRADA — gravá-lo faria a venda declarar
    // que a loja está comprando. Recusado, e o valor anterior fica de pé.
    const invalida = await request(app)
      .put('/api/v1/core/inbound/config')
      .set(gestor)
      .send({ defaultSaleCfop: '1102' });
    expect(invalida.status, JSON.stringify(invalida.body)).toBe(400);
    expect(invalida.body.error?.code).toBe('CORE_CFOP_INVALID');

    const aindaVale = await request(app).get('/api/v1/core/inbound/config').set(gestor);
    expect(aindaVale.body.defaultSaleCfop).toBe('5102');

    // E a conferência final direto no banco: UMA linha, com o valor certo.
    const linha = getConnection()
      .prepare('SELECT default_sale_cfop AS cfop FROM core_inbound_configs WHERE company_id = ?')
      .get(companyId) as { cfop: string } | undefined;
    expect(linha?.cfop).toBe('5102');
  });
});
