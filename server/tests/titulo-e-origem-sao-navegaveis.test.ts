/**
 * ============================================================================
 * O TÍTULO NAVEGA ATÉ A ORIGEM — E A ORIGEM ACHA OS SEUS TÍTULOS (V22/V18)
 * ============================================================================
 *
 * O DEFEITO: `origin_type` e `origin_id` sempre foram gravados íntegros em
 * `core_finance_entries`, mas a API só serializava `originType`. Quem abria o
 * contas a pagar e queria a nota que gerou a dívida tinha o texto "NF-e 1234"
 * — sem id, sem link. E a volta era pior: nenhum filtro devolvia "os
 * lançamentos desta venda"; auditar um título estranho exigia SQL na mão.
 * O próprio audit-purchase registrou por escrito: "a amarração dívida→nota
 * (origin_id) NÃO sai pela API" e conferia direto no banco.
 *
 * O que este arquivo cobra, por HTTP e com IDs REAIS (venda criada pela rota,
 * nota com linha de verdade no banco):
 *
 *   IDA   — a lista expõe `originId` e um `originLabel` legível
 *           ('Venda #7', 'Nota 4711 — Fornecedor X'), o suficiente para a
 *           tela montar o link sem adivinhar nada;
 *   VOLTA — `GET /finance/entries?originType=&originId=` devolve exatamente
 *           os lançamentos daquele documento, e de nenhum outro.
 *
 * ============================================================================
 * A ORIGEM QUE FICOU DE FORA: 'entrada_manual'
 * ============================================================================
 *
 * `ORIGEM_LEGIVEL_SQL` nomeava quatro origens — sale, sale_return, nfe_entrada
 * e ecommerce_order — e a compra sem nota fiscal (GAP-V17) grava uma QUINTA,
 * `entrada_manual`, de propósito: é o que impede a compra digitada de se
 * apresentar como NF-e. O CASE caía no `ELSE NULL`, o título voltava com
 * `originLabel` nulo e a tela — que só faz link do que tem rótulo — deixava a
 * dívida da feira sem porta nenhuma. A rastreabilidade existia no banco e
 * morria no serializador, que é exatamente o defeito que este arquivo nasceu
 * para fechar.
 *
 * O último bloco varre TODAS as origens que o sistema escreve em
 * `core_finance_entries` e cobra que cada uma ou tenha rótulo, ou esteja na
 * lista declarada de "não tem superfície". Origem nova sem decisão fica
 * vermelha aqui, e não em silêncio na tela do contas a pagar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';

const app = createApp();
const SENHA = 'Origem@Navegavel2026';

let empresa: string;
let gestor: { Authorization: string };
let produto: string;

async function ator(login: string, profile: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

interface EntryDto {
  id: string;
  description: string;
  originType: string;
  originId: string;
  originLabel: string | null;
  amountCents: number;
}

async function lista(query: string): Promise<EntryDto[]> {
  const res = await request(app).get(`/api/v1/core/finance/entries?${query}`).set(gestor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as EntryDto[];
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'origem-navegavel',
    legalName: 'Origem Navegável Ltda',
    tradeName: 'Origem',
    kind: 'retail',
  });
  gestor = await ator('GESTOR.ORIGEM', 'gestor');
  produto = createProduct(empresa, { name: 'Caixa de Som', priceCents: 15_000 }).id as string;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'carga-origem',
  });
});

describe('IDA: o título carrega a origem inteira', () => {
  it('venda real: originId é o id da venda e o rótulo é "Venda #N"', async () => {
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gestor)
      .set('Idempotency-Key', 'origem-venda-1')
      .send({
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 15_000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const [titulo] = await lista('direction=in');
    expect(titulo.originType).toBe('sale');
    // O id navegável — a metade que faltava da rastreabilidade.
    expect(titulo.originId).toBe(venda.body.id);
    expect(titulo.originLabel).toBe(`Venda #${venda.body.number}`);
  });

  it('nota de entrada real: rótulo "Nota N — Fornecedor" e originId da nota', async () => {
    const db = getConnection();
    const agora = new Date().toISOString();
    const fornecedorId = randomUUID();
    db.prepare(
      `INSERT INTO core_suppliers (id, company_id, name, created_at, updated_at)
       VALUES (?, ?, 'Distribuidora Alfa', ?, ?)`,
    ).run(fornecedorId, empresa, agora, agora);

    const notaId = randomUUID();
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, supplier_id, total_cents, status, created_at)
       VALUES (?, ?, ?, '4711', ?, 98700, 'recebida', ?)`,
    ).run(notaId, empresa, `chave-${notaId}`, fornecedorId, agora);

    // O lançamento como o importador de NF-e o grava: amarrado pela origem.
    db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents,
          supplier_id, description, origin_type, origin_id, created_at)
       VALUES (?, ?, 'out', 98700, 'open', 0, ?, 'NF-e 4711', 'nfe_entrada', ?, ?)`,
    ).run(randomUUID(), empresa, fornecedorId, notaId, agora);

    const [divida] = await lista('direction=out');
    expect(divida.originType).toBe('nfe_entrada');
    expect(divida.originId).toBe(notaId);
    expect(divida.originLabel).toBe('Nota 4711 — Distribuidora Alfa');
  });

  it('entrada manual real: rótulo "Entrada manual EM-N — Fornecedor" e originId da nota', async () => {
    /*
      A COMPRA DA FEIRA, pelo caminho de verdade: cria a entrada manual pela
      rota e confirma. É a confirmação que grava a dívida com
      `origin_type = 'entrada_manual'` — e era ela que voltava sem rótulo.
    */
    const fornecedor = await request(app)
      .post('/api/v1/core/suppliers')
      .set(gestor)
      .send({ name: 'Seu Zé das Embalagens', paymentTermDays: 0 });
    expect(fornecedor.status, JSON.stringify(fornecedor.body)).toBe(201);

    const entrada = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(gestor)
      .send({
        supplierId: fornecedor.body.id,
        items: [{ productId: produto, quantity: 10, unitCostCents: 1_000 }],
      });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);

    const confirmada = await request(app)
      .post(`/api/v1/core/purchases/notes/${entrada.body.noteId}/confirm`)
      .set(gestor)
      .send({});
    expect(confirmada.status, JSON.stringify(confirmada.body)).toBe(200);

    // O número da entrada manual é o da casa: EM-1, EM-2… — é ele que a
    // pessoa lê no contas a pagar e procura no papel do fornecedor.
    const numero = (
      getConnection()
        .prepare('SELECT number FROM core_inbound_notes WHERE id = ?')
        .get(entrada.body.noteId) as { number: string }
    ).number;
    expect(numero).toMatch(/^EM-\d+$/);

    const [divida] = await lista('direction=out');
    expect(divida.originType).toBe('entrada_manual');
    expect(divida.originId).toBe(entrada.body.noteId);
    /*
      O DEFEITO em uma linha: aqui vinha `null`, e sem rótulo a tela não
      monta link. O rótulo diz a ESPÉCIE do papel — "Entrada manual", nunca
      "Nota" —, que é a mesma honestidade que a origem própria defende no
      banco.
    */
    expect(divida.originLabel).toBe(`Entrada manual ${numero} — Seu Zé das Embalagens`);
  });

  it('lançamento manual não inventa origem: originLabel nulo, originId aponta para si', async () => {
    const criada = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(gestor)
      .send({ direction: 'out', description: 'Aluguel', amountCents: 120_000 });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);

    const [avulsa] = await lista('direction=out');
    expect(avulsa.originType).toBe('manual');
    expect(avulsa.originId).toBe(avulsa.id);
    expect(avulsa.originLabel).toBeNull();
  });
});

/*
  ============================================================================
  A VARREDURA: NENHUMA ORIGEM FICA SEM DECISÃO
  ============================================================================

  A lista abaixo é o conjunto FECHADO de `origin_type` que o sistema escreve em
  `core_finance_entries` hoje — levantado por `grep "INSERT INTO
  core_finance_entries" server/src` e lendo cada um dos seis escritores:

    SalesService ......... 'sale'
    SaleReturnService .... 'sale_return'
    NfeImportService ..... 'nfe_entrada' e 'entrada_manual'
    StorefrontService .... 'ecommerce_order'
    CommissionService .... 'commission_closing' (GAP-PRD-174; antes, 'manual')
    FinanceService ....... 'manual' (e a cópia do carnê, que herda o tipo)

  Foi assim que 'entrada_manual' passou despercebida por rodadas: quem
  acrescentou a quinta origem no ESCRITOR não voltou ao LEITOR, e nada ficou
  vermelho. Este caso monta um lançamento de cada espécie, apontando para um
  documento de verdade, e cobra a decisão explícita: ou tem rótulo, ou está
  declarada como origem sem superfície ('manual', o avulso — que aponta para si
  mesmo e não tem para onde navegar).

  Origem nova sem decisão cai aqui, e não em silêncio na tela do contas a pagar.
*/
describe('VARREDURA: toda origem escrita tem rótulo, ou é declaradamente sem superfície', () => {
  /** Um documento de cada espécie, e o lançamento que ele geraria. */
  function montarUmDeCada(): { fornecedor: string; venda: { id: string; number: number } } {
    const db = getConnection();
    const agora = new Date().toISOString();

    const fornecedorId = randomUUID();
    db.prepare(
      `INSERT INTO core_suppliers (id, company_id, name, created_at, updated_at)
       VALUES (?, ?, 'Distribuidora Ômega', ?, ?)`,
    ).run(fornecedorId, empresa, agora, agora);

    const vendaId = randomUUID();
    db.prepare(
      `INSERT INTO core_sales
         (id, company_id, number, subtotal_cents, discount_cents, total_cents,
          change_cents, status, idempotency_key, created_at)
       VALUES (?, ?, 90, 10000, 0, 10000, 0, 'completed', ?, ?)`,
    ).run(vendaId, empresa, randomUUID(), agora);

    return { fornecedor: fornecedorId, venda: { id: vendaId, number: 90 } };
  }

  function lancar(originType: string, originId: string, descricao: string): void {
    getConnection()
      .prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents,
            description, origin_type, origin_id, created_at)
         VALUES (?, ?, 'out', 1000, 'open', 0, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), empresa, descricao, originType, originId, new Date().toISOString());
  }

  it('as cinco origens com documento trazem rótulo; só o avulso volta nulo', async () => {
    const db = getConnection();
    const agora = new Date().toISOString();
    const { fornecedor, venda } = montarUmDeCada();

    // NF-e de entrada.
    const notaFiscal = randomUUID();
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, supplier_id, total_cents, status, doc_type, created_at)
       VALUES (?, ?, ?, '8080', ?, 1000, 'recebida', 'nfe', ?)`,
    ).run(notaFiscal, empresa, `chave-${notaFiscal}`, fornecedor, agora);
    lancar('nfe_entrada', notaFiscal, 'NF-e 8080');

    // Entrada manual — a quinta espécie, a que voltava sem rótulo.
    const entradaManual = randomUUID();
    db.prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, supplier_id, total_cents, status, doc_type, created_at)
       VALUES (?, ?, ?, 'EM-9', ?, 1000, 'recebida', 'manual', ?)`,
    ).run(entradaManual, empresa, `manual:${entradaManual}`, fornecedor, agora);
    lancar('entrada_manual', entradaManual, 'Entrada manual EM-9');

    // Devolução de venda.
    const devolucao = randomUUID();
    db.prepare(
      `INSERT INTO core_sale_returns
         (id, company_id, number, sale_id, reason, total_cents, refund_method, created_at)
       VALUES (?, ?, 5, ?, 'Peça errada', 1000, 'dinheiro', ?)`,
    ).run(devolucao, empresa, venda.id, agora);
    lancar('sale_return', devolucao, 'Devolução #5');

    // Pedido da loja online.
    const pedido = randomUUID();
    db.prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_name, items_cents, total_cents,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 77, 'Cliente da Vitrine', 1000, 1000, 'pago', ?, ?, ?)`,
    ).run(pedido, empresa, randomUUID(), agora, agora);
    lancar('ecommerce_order', pedido, 'Pedido online #77');
    // O reembolso do mesmo pedido (GAP-PRD-031): a sétima origem, escrita por
    // OrderRefundLedger — o dinheiro que volta ao cliente.
    lancar('ecommerce_order_refund', pedido, 'Reembolso do pedido online #77');

    // Devolução ao fornecedor (GAP-PRD-089) — a sétima origem, o crédito a
    // receber de quem vendeu a mercadoria que voltou.
    const devolucaoAoFornecedor = randomUUID();
    db.prepare(
      `INSERT INTO core_supplier_returns
         (id, company_id, number, note_id, supplier_id, reason, goods_cents, credit_cents,
          finance_mode, created_at)
       VALUES (?, ?, 3, ?, ?, 'Defeito', 1000, 1000, 'credito', ?)`,
    ).run(devolucaoAoFornecedor, empresa, notaFiscal, fornecedor, agora);
    lancar('devolucao_fornecedor', devolucaoAoFornecedor, 'Crédito da devolução #3');

    // Venda de balcão.
    lancar('sale', venda.id, `Venda #${venda.number}`);

    // Fechamento de comissão — a sétima espécie (GAP-PRD-174). Nascia 'manual'
    // e o título não sabia de onde veio.
    const vendedor = randomUUID();
    db.prepare(
      `INSERT INTO core_users (id, login, display_name, password_hash, active, created_at, updated_at)
       VALUES (?, ?, 'Joana Vendedora', 'x', 1, ?, ?)`,
    ).run(vendedor, `v-${vendedor}`, agora, agora);
    const fechamento = randomUUID();
    db.prepare(
      `INSERT INTO core_commission_closings
         (id, company_id, seller_id, period_from, period_to, total_cents, created_at)
       VALUES (?, ?, ?, '2026-08-01', '2026-08-31', 1000, ?)`,
    ).run(fechamento, empresa, vendedor, agora);
    lancar('commission_closing', fechamento, 'Comissão Joana');

    // O avulso: origem que aponta para si mesma, sem documento nenhum.
    const avulso = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents,
            description, origin_type, origin_id, created_at)
         VALUES (?, ?, 'out', 1000, 'open', 0, 'Aluguel', 'manual', ?, ?)`,
      )
      .run(avulso, empresa, avulso, agora);

    const porOrigem = new Map(
      (await lista('direction=out')).map((e) => [e.originType, e.originLabel]),
    );

    expect(porOrigem.get('sale')).toBe('Venda #90');
    expect(porOrigem.get('sale_return')).toBe('Devolução #5 da venda #90');
    expect(porOrigem.get('nfe_entrada')).toBe('Nota 8080 — Distribuidora Ômega');
    expect(porOrigem.get('entrada_manual')).toBe('Entrada manual EM-9 — Distribuidora Ômega');
    expect(porOrigem.get('ecommerce_order')).toBe('Pedido online #77');
    expect(porOrigem.get('devolucao_fornecedor')).toBe(
      'Devolução ao fornecedor #3 — Distribuidora Ômega',
    );
    expect(porOrigem.get('commission_closing')).toBe(
      'Fechamento de comissão — Joana Vendedora · 01/08/2026 a 31/08/2026',
    );
    expect(porOrigem.get('ecommerce_order_refund')).toBe('Reembolso do pedido online #77');

    // A ÚNICA sem superfície, e por decisão: não há tela do lançamento avulso
    // para onde navegar. Nulo aqui é a verdade, não uma lacuna.
    expect(porOrigem.get('manual')).toBeNull();

    // E as nove são as nove: nenhuma origem entrou na lista sem passar por
    // uma das asserções acima.
    expect([...porOrigem.keys()].sort()).toEqual([
      'commission_closing',
      'devolucao_fornecedor',
      'ecommerce_order',
      'ecommerce_order_refund',
      'entrada_manual',
      'manual',
      'nfe_entrada',
      'sale',
      'sale_return',
    ]);
  });

  it('documento apagado não vira rótulo mentiroso: entrada manual órfã volta nula', async () => {
    // O `CASE WHEN … IS NULL THEN NULL` do SQL existe para isto: sem ele, a
    // concatenação produziria 'Entrada manual ' pendurado no nada, e a tela
    // ofereceria um link para um documento que não existe mais.
    lancar('entrada_manual', randomUUID(), 'Entrada manual de nota apagada');
    const [orfa] = await lista('direction=out');
    expect(orfa.originType).toBe('entrada_manual');
    expect(orfa.originLabel).toBeNull();
  });
});

describe('VOLTA: a origem acha os seus títulos', () => {
  it('o filtro por originType+originId devolve os lançamentos DAQUELA venda, e só dela', async () => {
    const venderPor = async (chave: string) => {
      const res = await request(app)
        .post('/api/v1/core/sales')
        .set(gestor)
        .set('Idempotency-Key', chave)
        .send({
          items: [{ productId: produto, quantity: 1 }],
          payments: [{ method: 'dinheiro', amountCents: 15_000 }],
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as { id: string; number: number };
    };
    const primeira = await venderPor('origem-volta-1');
    const segunda = await venderPor('origem-volta-2');

    const daPrimeira = await lista(`direction=in&originType=sale&originId=${primeira.id}`);
    expect(daPrimeira).toHaveLength(1);
    expect(daPrimeira[0].originId).toBe(primeira.id);
    expect(daPrimeira[0].originLabel).toBe(`Venda #${primeira.number}`);

    // A conta da OUTRA venda não vaza no recorte.
    expect(daPrimeira.some((e) => e.originId === segunda.id)).toBe(false);

    // Origem inexistente devolve lista vazia, não erro.
    const deNinguem = await lista(`direction=in&originType=sale&originId=${randomUUID()}`);
    expect(deNinguem).toHaveLength(0);
  });

  it('a FICHA da venda traz o bloco financeiro: os títulos que ela gerou', async () => {
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gestor)
      .set('Idempotency-Key', 'origem-ficha-1')
      .send({
        items: [{ productId: produto, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 15_000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    // A ficha era só itens e pagamentos; quem queria saber "essa venda gerou
    // que cobrança?" tinha de sair dela e caçar. O bloco fecha o ciclo.
    const ficha = await request(app).get(`/api/v1/core/sales/${venda.body.id}`).set(gestor);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    const titulos = ficha.body.financeEntries as EntryDto[];
    expect(Array.isArray(titulos)).toBe(true);
    expect(titulos).toHaveLength(1);
    expect(titulos[0].originId).toBe(venda.body.id);
    expect(titulos[0].amountCents).toBe(15_000);
  });
});

/*
  ============================================================================
  A VOLTA NAS DUAS FICHAS QUE FALTAVAM — devolução e pedido da loja
  ============================================================================

  ## O DEFEITO MEDIDO (V04-FIN-016)

  A IDA fecha nas cinco origens com documento; a VOLTA fechava em TRÊS — venda
  (bloco na própria ficha), NF-e e entrada manual (segunda consulta, da mesma
  tela). Faltavam a DEVOLUÇÃO e o PEDIDO DA LOJA, e as duas mexem em dinheiro:
  a devolução gera título de SAÍDA (o estorno) e o pedido, de ENTRADA.

  ## OS DOIS CAMINHOS, E POR QUE CADA UM

  PEDIDO DA LOJA — o bloco vem na PRÓPRIA resposta de `GET /core/orders/:id`,
  como na venda. A ficha faz essa chamada para existir; pendurar os títulos
  nela custa ZERO requisição a mais, e a rota do financeiro não alcança todo
  perfil que abre Pedidos.

  DEVOLUÇÃO — pela consulta genérica `?originType=sale_return&originId=`, como
  na nota de entrada. A tela de devoluções não abre detalhe nenhum (o recorte
  `?devolucao=` é feito sobre o histórico que já chegou); pendurar os títulos
  em `GET /sale-returns/:id` obrigaria a tela a fazer uma chamada que ela não
  faz, e a receber a devolução DUAS vezes só para carregar o bloco de carona.

  Por isso este bloco cobra COISAS DIFERENTES nas duas: no pedido, o campo na
  resposta do detalhe; na devolução, o recorte da consulta.
*/
describe('VOLTA: as duas fichas que faltavam acham os seus títulos', () => {
  /** Um pedido da loja com o recebível que ele gerou. */
  function pedidoComTitulo(numero: number, valorCents: number): string {
    const db = getConnection();
    const agora = new Date().toISOString();
    const pedido = randomUUID();
    db.prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_name, items_cents, total_cents,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'Ana Compradora', ?, ?, 'pago', ?, ?, ?)`,
    ).run(pedido, empresa, numero, valorCents, valorCents, randomUUID(), agora, agora);
    db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents,
          description, origin_type, origin_id, created_at)
       VALUES (?, ?, 'in', ?, 'open', 0, ?, 'ecommerce_order', ?, ?)`,
    ).run(randomUUID(), empresa, valorCents, `Pedido online #${numero}`, pedido, agora);
    return pedido;
  }

  it('a FICHA do pedido da loja traz o bloco financeiro: os títulos que ele gerou', async () => {
    const pedido = pedidoComTitulo(1009, 20_000);
    // Um SEGUNDO pedido, com o seu próprio título: o recorte tem de existir.
    pedidoComTitulo(1010, 33_300);

    const ficha = await request(app).get(`/api/v1/core/orders/${pedido}`).set(gestor);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);

    const titulos = ficha.body.financeEntries as EntryDto[];
    expect(Array.isArray(titulos)).toBe(true);
    expect(titulos).toHaveLength(1);
    expect(titulos[0].originType).toBe('ecommerce_order');
    expect(titulos[0].originId).toBe(pedido);
    // Centavos inteiros: o valor do pedido, sem passar por real nenhum.
    expect(titulos[0].amountCents).toBe(20_000);
    // E o título do OUTRO pedido não vaza para esta ficha.
    expect(titulos.some((t) => t.amountCents === 33_300)).toBe(false);
  });

  it('pedido que ainda não gerou título traz o bloco VAZIO — e não ausente', async () => {
    const db = getConnection();
    const agora = new Date().toISOString();
    const pedido = randomUUID();
    db.prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_name, items_cents, total_cents,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 1011, 'Bruno Comprador', 5000, 5000, 'aguardando_pagamento', ?, ?, ?)`,
    ).run(pedido, empresa, randomUUID(), agora, agora);

    const ficha = await request(app).get(`/api/v1/core/orders/${pedido}`).set(gestor);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    /*
      Lista vazia e campo AUSENTE são fatos diferentes na tela: o vazio diz
      "este pedido ainda não cobra ninguém" e a ausência diz "não sei". O
      servidor sempre manda o campo — mesmo vazio.
    */
    expect(Array.isArray(ficha.body.financeEntries)).toBe(true);
    expect(ficha.body.financeEntries).toHaveLength(0);
  });

  it('a ficha do pedido de OUTRA empresa continua 404 — e não vaza título nenhum', async () => {
    const outra = upsertCompany({
      slug: 'origem-vizinha',
      legalName: 'Vizinha Ltda',
      tradeName: 'Vizinha',
      kind: 'retail',
    });
    const db = getConnection();
    const agora = new Date().toISOString();
    const pedido = randomUUID();
    db.prepare(
      `INSERT INTO core_orders
         (id, company_id, number, customer_name, items_cents, total_cents,
          status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 2001, 'Cliente Vizinho', 9900, 9900, 'pago', ?, ?, ?)`,
    ).run(pedido, outra, randomUUID(), agora, agora);

    const ficha = await request(app).get(`/api/v1/core/orders/${pedido}`).set(gestor);
    // O companyId sai do TOKEN, e a ficha do vizinho não existe para este
    // gestor — nem com o bloco financeiro pendurado nela.
    expect(ficha.status).toBe(404);
    expect(ficha.body.financeEntries).toBeUndefined();
  });

  it('a consulta da DEVOLUÇÃO devolve o estorno dela, e só dele', async () => {
    const db = getConnection();
    const agora = new Date().toISOString();

    const venda = randomUUID();
    db.prepare(
      `INSERT INTO core_sales
         (id, company_id, number, subtotal_cents, discount_cents, total_cents,
          change_cents, status, idempotency_key, created_at)
       VALUES (?, ?, 91, 15000, 0, 15000, 0, 'completed', ?, ?)`,
    ).run(venda, empresa, randomUUID(), agora);

    const devolver = (numero: number, valorCents: number): string => {
      const devolucao = randomUUID();
      db.prepare(
        `INSERT INTO core_sale_returns
           (id, company_id, number, sale_id, reason, total_cents, refund_method, created_at)
         VALUES (?, ?, ?, ?, 'Peça errada', ?, 'dinheiro', ?)`,
      ).run(devolucao, empresa, numero, venda, valorCents, agora);
      db.prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents,
            description, origin_type, origin_id, created_at)
         VALUES (?, ?, 'out', ?, 'open', 0, ?, 'sale_return', ?, ?)`,
      ).run(
        randomUUID(),
        empresa,
        valorCents,
        `Devolução #${numero} da venda #91`,
        devolucao,
        agora,
      );
      return devolucao;
    };

    const quarta = devolver(4, 5_000);
    devolver(5, 3_000);

    // É EXATAMENTE a consulta que a ficha da devolução passou a fazer.
    const daQuarta = await lista(`originType=sale_return&originId=${quarta}`);
    expect(daQuarta).toHaveLength(1);
    expect(daQuarta[0].originId).toBe(quarta);
    expect(daQuarta[0].amountCents).toBe(5_000);
    expect(daQuarta[0].originLabel).toBe('Devolução #4 da venda #91');

    // O estorno da OUTRA devolução da MESMA venda não entra no recorte — é o
    // erro que perguntar só pela venda cometeria.
    expect(daQuarta.some((e) => e.amountCents === 3_000)).toBe(false);
  });
});
