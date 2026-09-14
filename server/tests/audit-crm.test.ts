/**
 * ============================================================================
 * AUDITORIA — FASE 11: CLIENTES, CRM E FIDELIDADE (fluxo completo, em centavos)
 * ============================================================================
 *
 * A pergunta desta fase: o CICLO DO CLIENTE fecha? Do cadastro no balcão à
 * venda vinculada, do lead à oportunidade ganha apontando a venda real, do
 * ponto acumulado ao resgate — com a matemática exata em centavos.
 *
 * O MECANISMO REAL DE VINCULAR VENDA A CLIENTE (conferido no código, não
 * suposto):
 *   - o PDV manda `customerId` no POST /core/sales; createSale confere que o
 *     cliente É desta empresa (CORE_CUSTOMER_INVALID — SalesService.ts:328);
 *   - NÃO existe find-or-create por CPF no PDV: `findOrCreateCustomer` vive no
 *     checkout online (StorefrontService.ts:1194) e no vínculo de equipamento
 *     (EquipmentStockLink.ts:1142), nunca na rota de venda — CPF no corpo da
 *     venda é ignorado, e o primeiro caso abaixo PROVA isso;
 *   - o histórico "de quem é a venda" mora em core_sales.customer_id.
 *
 * COBERTURA JÁ EXISTENTE QUE ESTE ARQUIVO NÃO DUPLICA:
 *   - CPF duplicado não cria segundo cadastro (idêntico e com máscara),
 *     CPF inválido barrado, edição/inativação — tests/audit-manager.test.ts
 *     (153–208) e tests/cadastro-fecha-o-ciclo.test.ts;
 *   - lead não é cliente, conversão reaproveita por documento, oportunidade
 *     precisa de dono, perder exige motivo, resumo do funil, lead alheio 404 —
 *     tests/crm-nucleo.test.ts;
 *   - fidelidade núcleo (acúmulo, teto, resgate, estorno do ACUMULADO em
 *     cancelamento e devolução parcial, passivo) — tests/fidelidade.test.ts;
 *   - isolamento: cada operação lista só os próprios clientes e cliente da
 *     vizinha é recusado na venda — tests/matriz-das-seis-operacoes.test.ts
 *     (175, 281); escritas sobre cliente alheio (tabela de preço, convite de
 *     portal) — tests/audit-tenant.test.ts; PATCH de oportunidade alheia na
 *     porta legada /crm — tests/adm-preso-a-sua-loja.test.ts.
 *
 * NÃO-APLICÁVEL NESTA BASE: crédito de cliente / cashback. Não existe no
 * servidor (grep por cashback|customer_credit|store_credit em server/src: zero
 * ocorrências). O que existe de valor guardado por cliente são os PONTOS de
 * fidelidade (core_loyalty_entries) e o crediário como FORMA DE PAGAMENTO —
 * desligado por decisão documentada (formas-de-recebimento.test.ts).
 *
 * OS ACHADOS DESTE ARQUIVO (nasceram vermelhos; os consertos viraram travas):
 *   1. CANCELAR A VENDA NÃO DEVOLVIA OS PONTOS RESGATADOS NELA (CONSERTADO).
 *      reversePoints estornava só as linhas kind='earn'; a linha kind='redeem'
 *      presa à venda cancelada ficava de pé. O cliente pagava com ponto por
 *      uma compra desfeita: recebia de volta o dinheiro, a mercadoria voltava
 *      à loja — e o ponto sumia. Hoje o estorno anda nos DOIS sentidos: o
 *      earn sai e o resgate volta, na mesma proporção.
 *   2. O HISTÓRICO DE COMPRAS DE UM CLIENTE NÃO EXISTIA COMO CONSULTA
 *      (CONSERTADO). Nenhuma rota respondia "as vendas DESTE cliente":
 *      GET /core/sales só lia from/to e IGNORAVA ?customerId= em silêncio —
 *      quem mandava o filtro recebia as vendas de todo mundo, e o front só
 *      teria as 200 últimas para peneirar no navegador. Hoje `listSales`
 *      filtra por customerId DENTRO da empresa do token e a rota repassa o
 *      parâmetro; o caso ficou verde e vira a trava de regressão.
 *   3. SEGMENTAÇÃO DO CRM ERA HEADLESS, E A PORTA SAIU (GAP-PRD-075):
 *      POST/GET /crm/segments gravavam e listavam e nada mais — os
 *      `filters` nunca eram avaliados. O roteador /crm inteiro saiu (um
 *      segundo CRM sobre `crm_*`, paralelo a `core_leads`); segmentar
 *      clientes continua lacuna de produto, e quando nascer, nasce no núcleo.
 *
 * COMO OS GUARDAS AFIRMADOS AQUI FALHAM (conferido no código):
 *   - tirando o `company_id` do SELECT de convertLead (LeadService.ts:176), a
 *     conversão na loja A liga ao cadastro da B e o caso do documento
 *     espelhado fica vermelho;
 *   - tirando a validação de cliente/venda de createOpportunity e
 *     closeOpportunity (LeadService.ts:286, 341), a oportunidade da A aceita
 *     cliente e venda da B e os dois 404 esperados viram 2xx;
 *   - tirando o par (company_id, customer_id) de pointsBalance
 *     (LoyaltyService.ts:109), o extrato da vizinha deixa de responder zero.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

interface Loja {
  auth: { Authorization: string };
  companyId: string;
}

async function abrirLoja(
  userId: string,
  companyId: string,
  profile = 'gerente_loja',
): Promise<Loja> {
  const res = await loginForTest(app, { userId, companyId, profileCodes: [profile] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    companyId: res.body.company.id,
  };
}

/** Produto com estoque, pronto para vender. */
async function criarProduto(loja: Loja, nome: string, priceCents: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(loja.auth)
    .send({ name: nome, priceCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(loja.auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 100,
    referenceType: 'entrada',
    referenceId: 'carga-audit-crm',
  });
  return p.body.id as string;
}

async function criarCliente(
  loja: Loja,
  corpo: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(app).post('/api/v1/core/customers').set(loja.auth).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function vender(
  loja: Loja,
  corpo: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(loja.auth)
    .send({ idempotencyKey: randomUUID(), ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.sale ?? res.body) as Record<string, unknown>;
}

async function saldoDePontos(loja: Loja, clienteId: string): Promise<number> {
  const res = await request(app)
    .get(`/api/v1/core/loyalty/customers/${clienteId}`)
    .set(loja.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.balance as number;
}

beforeEach(() => {
  resetDbForTests();
});

// ============================================================================
// 1. BALCÃO → VENDA → HISTÓRICO: o vínculo é o customerId, e mais nada
// ============================================================================

describe('cliente do balcão e as compras dele', () => {
  it('a venda vincula pelo customerId — e as vendas do cliente são EXATAMENTE as dele, em centavos', async () => {
    const loja = await abrirLoja('gerente-hist', 'loja-audit-crm');
    const produto = await criarProduto(loja, 'Capacete Trilha', 7_390);

    const maria = await criarCliente(loja, {
      name: 'Maria do Balcão',
      document: '11144477735',
    });
    const joao = await criarCliente(loja, { name: 'João de Outra Ficha' });

    // Duas compras da Maria, uma sem cliente, uma do João — o recorte tem de
    // separar as quatro sem confundir ninguém.
    const v1 = await vender(loja, {
      customerId: maria.id,
      items: [{ productId: produto, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 14_780 }],
    });
    const v2 = await vender(loja, {
      customerId: maria.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 7_390 }],
    });
    const semCliente = await vender(loja, {
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 7_390 }],
    });
    await vender(loja, {
      customerId: joao.id,
      items: [{ productId: produto, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 22_170 }],
    });

    // O vínculo mora NA VENDA: a ficha da venda diz de quem ela é.
    const detalhe = await request(app).get(`/api/v1/core/sales/${v1.id}`).set(loja.auth);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.customer_id).toBe(maria.id);
    expect(detalhe.body.total_cents).toBe(14_780);

    // E a listagem carrega o vínculo linha a linha: recortando por
    // customer_id, as vendas da Maria são as DUAS criadas — nem uma a mais,
    // com os totais exatos.
    const lista = await request(app).get('/api/v1/core/sales').set(loja.auth);
    expect(lista.status).toBe(200);
    const linhas = lista.body.items as { id: string; customer_id: string | null; total_cents: number }[];
    const daMaria = linhas.filter((s) => s.customer_id === maria.id);
    expect(new Set(daMaria.map((s) => s.id))).toEqual(new Set([String(v1.id), String(v2.id)]));
    expect(daMaria.map((s) => s.total_cents).sort((a, b) => a - b)).toEqual([7_390, 14_780]);
    expect(linhas.find((s) => s.id === semCliente.id)?.customer_id).toBeNull();

    // A REGRA REAL: CPF no corpo da venda NÃO vincula. Não há find-or-create
    // por documento no PDV (ele vive no checkout online e na conversão de
    // lead); mandar o CPF da Maria sem customerId cria venda SEM dono.
    const porCpf = await vender(loja, {
      customerDocument: '111.444.777-35',
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 7_390 }],
    });
    const fichaPorCpf = await request(app)
      .get(`/api/v1/core/sales/${porCpf.id}`)
      .set(loja.auth);
    expect(
      fichaPorCpf.body.customer_id,
      'CPF no corpo da venda passou a vincular cliente — o mecanismo mudou e esta fase precisa ser reauditada',
    ).toBeNull();
  });

  it('ACHADO (consertado): ?customerId= devolve SÓ as vendas daquele cliente — o histórico ganhou porta de leitura', async () => {
    /*
      DEFEITO (consertado): listSales só conhecia from/to e a rota GET /sales
      não lia customerId nenhum. Quem pedia o histórico de um cliente recebia
      as vendas DE TODO MUNDO — inclusive as sem cliente e as de outros — e o
      front teria de peneirar as 200 últimas no navegador: a compra antiga do
      cliente simplesmente sumia do histórico. Hoje `recorteDeVendas`
      (SalesService) filtra por customer_id COM o company_id do token na
      frente — pedir por cliente da vizinha recorta um conjunto vazio, não as
      vendas dela — e a rota repassa o parâmetro. As asserções continuam as
      mesmas: elas são o registro executável do achado e a trava contra o
      filtro voltar a ser ignorado em silêncio.
    */
    const loja = await abrirLoja('gerente-hist-2', 'loja-audit-crm');
    const produto = await criarProduto(loja, 'Câmara 29', 3_500);
    const maria = await criarCliente(loja, { name: 'Maria Só Dela' });
    const joao = await criarCliente(loja, { name: 'João Intrometido' });

    const daMaria = await vender(loja, {
      customerId: maria.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 3_500 }],
    });
    await vender(loja, {
      customerId: joao.id,
      items: [{ productId: produto, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 7_000 }],
    });
    await vender(loja, {
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 3_500 }],
    });

    const res = await request(app)
      .get(`/api/v1/core/sales?customerId=${maria.id}`)
      .set(loja.auth);
    expect(res.status).toBe(200);
    const linhas = res.body.items as { id: string; customer_id: string | null }[];

    // A venda da Maria vem…
    expect(linhas.map((s) => s.id)).toContain(String(daMaria.id));

    // …e SÓ ela: pedir por um cliente devolve o que é dele — nem a venda do
    // João, nem a venda sem dono. Era esta linha que ficava vermelha quando
    // o filtro era ignorado.
    const intrusas = linhas.filter((s) => s.customer_id !== maria.id);
    expect(
      intrusas.map((s) => s.id),
      'GET /core/sales?customerId= ignora o filtro e devolve vendas de outros clientes — não existe consulta de histórico por cliente no servidor',
    ).toEqual([]);
  });
});

// ============================================================================
// 2. DUPLICIDADE: documento dedupa (coberto); telefone e e-mail NÃO dedupam
// ============================================================================

describe('duplicidade no cadastro de cliente', () => {
  it('a REGRA REAL: mesmo telefone e mesmo e-mail são permitidos — só o documento dedupa', async () => {
    /*
      criarCliente (CatalogService.ts:1125) confere duplicata SÓ por documento
      normalizado — o 409 de CPF repetido, com e sem máscara, já é coberto por
      audit-manager.test.ts (153–208). Telefone e e-mail compartilhados são
      legítimos de propósito: mãe e filho com o telefone da casa, funcionários
      com o e-mail da empresa. Este caso afirma a regra para ela não virar
      "conserto" acidental numa rodada futura sem decisão do dono.
    */
    const loja = await abrirLoja('gerente-dup', 'loja-audit-crm');
    const mae = await criarCliente(loja, {
      name: 'Dona Raimunda',
      phone: '96 98888-7777',
      email: 'familia@casa.com.br',
    });
    const filho = await criarCliente(loja, {
      name: 'Filho da Dona Raimunda',
      phone: '96 98888-7777',
      email: 'familia@casa.com.br',
    });
    expect(filho.id).not.toBe(mae.id);

    const lista = await request(app).get('/api/v1/core/customers').set(loja.auth);
    const ids = (lista.body.items as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(mae.id);
    expect(ids).toContain(filho.id);
  });
});

// ============================================================================
// 3. LEAD → OPORTUNIDADE → CONVERSÃO → VENDA GANHA (o funil fecha em dinheiro)
// ============================================================================

describe('o funil fecha: lead vira cliente, cliente compra, oportunidade aponta a venda', () => {
  it('fluxo inteiro com os números: estimativa de 2.500,00 — venda real de 1.899,00 — e só a venda no financeiro', async () => {
    const loja = await abrirLoja('gerente-funil', 'loja-audit-crm');
    const produto = await criarProduto(loja, 'Bicicleta Aro 29', 189_900);

    // O lead chega da vitrine, com documento.
    const lead = await request(app).post('/api/v1/core/leads').set(loja.auth).send({
      name: 'Cliente da Vitrine',
      phone: '96 99999-0000',
      document: '529.982.247-25',
      source: 'instagram',
    });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    expect(lead.body.status).toBe('novo');

    // A oportunidade nasce como ESTIMATIVA de R$ 2.500,00.
    const opp = await request(app).post('/api/v1/core/opportunities').set(loja.auth).send({
      leadId: lead.body.id,
      title: 'Bike de trilha completa',
      amountCents: 250_000,
    });
    expect(opp.status, JSON.stringify(opp.body)).toBe(201);
    expect(opp.body.status).toBe('aberta');

    // O lead compra: vira cliente…
    const conv = await request(app)
      .post(`/api/v1/core/leads/${lead.body.id}/convert`)
      .set(loja.auth)
      .send({});
    expect(conv.status, JSON.stringify(conv.body)).toBe(200);
    const clienteId = conv.body.customerId as string;

    // …e a venda REAL sai por R$ 1.899,00, vinculada a ele.
    const venda = await vender(loja, {
      customerId: clienteId,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 189_900 }],
    });

    // Fechar GANHA apontando a venda: o funil termina num fato, não numa frase.
    const ganha = await request(app)
      .post(`/api/v1/core/opportunities/${opp.body.id}/close`)
      .set(loja.auth)
      .send({ status: 'ganha', saleId: venda.id });
    expect(ganha.status, JSON.stringify(ganha.body)).toBe(200);
    expect(ganha.body.status).toBe('ganha');
    expect(ganha.body.won_sale_id).toBe(venda.id);
    // A conversão já tinha passado a oportunidade para o cliente.
    expect(ganha.body.customer_id).toBe(clienteId);

    // O número da venda viaja no join — a tela mostra "#N" sem segunda ida.
    const fichaVenda = await request(app).get(`/api/v1/core/sales/${venda.id}`).set(loja.auth);
    expect(ganha.body.sale_number).toBe(fichaVenda.body.number);

    // O resumo separa o estimado do ganho.
    const resumo = await request(app).get('/api/v1/core/crm/summary').set(loja.auth);
    expect(resumo.body.leads.convertido).toBe(1);
    expect(resumo.body.opportunities.abertas).toBe(0);
    expect(resumo.body.opportunities.abertoEstimadoCents).toBe(0);
    expect(resumo.body.opportunities.ganhas).toBe(1);
    expect(resumo.body.opportunities.ganhoCents).toBe(250_000);

    // E o FINANCEIRO só conhece a venda: a estimativa de 250.000 não virou
    // lançamento; o que entrou foi 189.900, no nome do cliente convertido.
    const db = getConnection();
    const foraDaVenda = db
      .prepare(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE company_id = ? AND origin_type <> 'sale'",
      )
      .get(loja.companyId) as { n: number };
    expect(foraDaVenda.n).toBe(0);
    const entrada = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, MAX(customer_id) AS cliente
           FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale' AND direction = 'in'`,
      )
      .get(loja.companyId) as { total: number; cliente: string | null };
    expect(entrada.total).toBe(189_900);
    expect(entrada.cliente).toBe(clienteId);
  });

  it('a oportunidade não aceita cliente nem venda da vizinha — e continua aberta depois da tentativa', async () => {
    /*
      createOpportunity confere o cliente (LeadService.ts:286) e
      closeOpportunity confere a venda (LeadService.ts:341) contra a empresa
      da SESSÃO. Nenhum dos dois guardas tinha teste: sem eles, a previsão da
      loja A nasceria pendurada num cadastro da B, e o "ganha" apontaria
      faturamento de outra empresa.
    */
    const lojaA = await abrirLoja('gerente-opp-a', 'loja-audit-crm');
    const lojaB = await abrirLoja('gerente-opp-b', 'vizinha-audit-crm');

    const clienteB = await criarCliente(lojaB, { name: 'Cliente da Vizinha' });
    const produtoB = await criarProduto(lojaB, 'Produto da Vizinha', 5_000);
    const vendaB = await vender(lojaB, {
      items: [{ productId: produtoB, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
    });

    // Cliente da B na oportunidade da A: 404, como um id inexistente.
    const comClienteAlheio = await request(app)
      .post('/api/v1/core/opportunities')
      .set(lojaA.auth)
      .send({ customerId: clienteB.id, title: 'Previsão sequestrada', amountCents: 100_000 });
    expect(comClienteAlheio.status, JSON.stringify(comClienteAlheio.body)).toBe(404);
    expect(comClienteAlheio.body.error?.code).toBe('CORE_CUSTOMER_NOT_FOUND');

    // Venda da B fechando oportunidade da A: 404 — e a oportunidade fica DE PÉ.
    const leadA = await request(app)
      .post('/api/v1/core/leads')
      .set(lojaA.auth)
      .send({ name: 'Lead da Casa' });
    const oppA = await request(app)
      .post('/api/v1/core/opportunities')
      .set(lojaA.auth)
      .send({ leadId: leadA.body.id, title: 'Negócio da casa', amountCents: 50_000 });
    expect(oppA.status).toBe(201);

    const fechaComVendaAlheia = await request(app)
      .post(`/api/v1/core/opportunities/${oppA.body.id}/close`)
      .set(lojaA.auth)
      .send({ status: 'ganha', saleId: vendaB.id });
    expect(fechaComVendaAlheia.status, JSON.stringify(fechaComVendaAlheia.body)).toBe(404);
    expect(fechaComVendaAlheia.body.error?.code).toBe('CORE_SALE_NOT_FOUND');

    const depois = await request(app).get('/api/v1/core/opportunities').set(lojaA.auth);
    const linha = (depois.body.items as { id: string; status: string; won_sale_id: string | null }[]).find(
      (o) => o.id === oppA.body.id,
    );
    expect(linha?.status).toBe('aberta');
    expect(linha?.won_sale_id).toBeNull();
  });

  it('converter lead NÃO atravessa empresa: o mesmo documento na vizinha é OUTRA pessoa jurídica de cadastro', async () => {
    /*
      A doutrina de CatalogService ("O cliente é DA OPERAÇÃO. Mesmo CPF na
      Gringa e no Preço Justo são dois cadastros") vale também para a
      conversão: o SELECT de convertLead é recortado por company_id
      (LeadService.ts:176). Sem o recorte, o lead da A se ligaria ao cadastro
      da B — e as compras da A entrariam no histórico de um cliente que a A
      nem enxerga.
    */
    const lojaA = await abrirLoja('gerente-conv-a', 'loja-audit-crm');
    const lojaB = await abrirLoja('gerente-conv-b', 'vizinha-audit-crm');

    const clienteB = await criarCliente(lojaB, {
      name: 'Dono do CPF na Vizinha',
      document: '52998224725',
    });

    const leadA = await request(app).post('/api/v1/core/leads').set(lojaA.auth).send({
      name: 'Mesma Pessoa, Outra Loja',
      document: '529.982.247-25',
    });
    expect(leadA.status).toBe(201);

    const conv = await request(app)
      .post(`/api/v1/core/leads/${leadA.body.id}/convert`)
      .set(lojaA.auth)
      .send({});
    expect(conv.status, JSON.stringify(conv.body)).toBe(200);

    // Não reaproveitou o cadastro DA OUTRA empresa: criou o da própria.
    expect(conv.body.reusedExisting).toBe(false);
    expect(conv.body.customerId).not.toBe(clienteB.id);

    const db = getConnection();
    const naA = db
      .prepare(
        'SELECT COUNT(*) AS n FROM core_customers WHERE company_id = ? AND document = ?',
      )
      .get(lojaA.companyId, '52998224725') as { n: number };
    expect(naA.n).toBe(1);

    const daB = db
      .prepare('SELECT company_id, name FROM core_customers WHERE id = ?')
      .get(String(clienteB.id)) as { company_id: string; name: string };
    expect(daB.company_id).toBe(lojaB.companyId);
    expect(daB.name).toBe('Dono do CPF na Vizinha');
  });
});

// ============================================================================
// 4. FIDELIDADE: o acúmulo é sobre o PAGO; o cancelamento deveria devolver
//    TUDO; e ponto não atravessa empresa
// ============================================================================

describe('fidelidade — os números do acúmulo e as beiradas que faltavam', () => {
  it('o ponto nasce do total PÓS-DESCONTO: 3 × 99,90 com 9,70 de desconto = 290 pontos, não 299', async () => {
    /*
      accrueForSale lê sale.total_cents (LoyaltyService.ts:194), que já saiu
      do caixa com o desconto dentro. Se o acúmulo regredir para o bruto dos
      itens, o cliente ganha ponto sobre dinheiro que não entregou — e este
      caso, que mede 290 exatos, fica vermelho com 299.
    */
    const loja = await abrirLoja('gerente-fid-1', 'loja-audit-crm');
    const produto = await criarProduto(loja, 'Luva de Ciclismo', 9_990);
    const cliente = await criarCliente(loja, { name: 'Cliente Pontual' });

    await request(app)
      .put('/api/v1/core/loyalty/program')
      .set(loja.auth)
      .send({ active: true, centsPerPoint: 100, pointValueCents: 1 })
      .expect(200);

    // 3 × 9.990 = 29.970; desconto de rodapé 970 → total 29.000 pagos.
    const venda = await vender(loja, {
      customerId: cliente.id,
      items: [{ productId: produto, quantity: 3 }],
      discountCents: 970,
      payments: [{ method: 'dinheiro', amountCents: 29_000 }],
    });
    const ficha = await request(app).get(`/api/v1/core/sales/${venda.id}`).set(loja.auth);
    expect(ficha.body.total_cents).toBe(29_000);

    // floor(29.000 / 100) = 290. Nem 299 (bruto), nem fração.
    expect(await saldoDePontos(loja, String(cliente.id))).toBe(290);
  });

  it('ACHADO (consertado): cancelar a venda devolve o ponto ACUMULADO e também o RESGATADO nela', async () => {
    /*
      O fluxo inteiro, em números redondos (100 centavos = 1 ponto; 1 ponto =
      10 centavos de desconto):

        venda A de 200,00  → +200 pontos (saldo 200)
        venda B de 100,00  → +100 pontos (saldo 300)
        resgate de 40 pontos NA venda B → −40 (saldo 260, desconto de 4,00)
        CANCELAMENTO da venda B

      O honesto é voltar a 200 — como se a venda B nunca tivesse existido: o
      earn dela sai E o resgate volta. O DEFEITO (consertado): reversePoints
      estornava só kind='earn'; a linha kind='redeem' presa à venda cancelada
      ficava, e o saldo caía para 160 — o cliente devolvia a mercadoria,
      recebia o dinheiro de volta, e perdia 40 pontos (4,00 em valor) por uma
      compra que não houve. Hoje reversePoints devolve o resgate junto
      (kind='reversal' positivo, com trava de repetição por sinal), e a regra
      de ouro do módulo vale para os dois lados. A asserção é a mesma que
      ficava vermelha: ela é o registro executável do achado e a trava contra
      o confisco voltar.
    */
    const loja = await abrirLoja('gerente-fid-2', 'loja-audit-crm');
    const produto = await criarProduto(loja, 'Produto Fiel', 10_000);
    const cliente = await criarCliente(loja, { name: 'Cliente Confiscado' });

    await request(app)
      .put('/api/v1/core/loyalty/program')
      .set(loja.auth)
      .send({ active: true, centsPerPoint: 100, pointValueCents: 10 })
      .expect(200);

    await vender(loja, {
      customerId: cliente.id,
      items: [{ productId: produto, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
    });
    expect(await saldoDePontos(loja, String(cliente.id))).toBe(200);

    const vendaB = await vender(loja, {
      customerId: cliente.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(await saldoDePontos(loja, String(cliente.id))).toBe(300);

    const resgate = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(loja.auth)
      .send({ customerId: cliente.id, points: 40, saleId: vendaB.id });
    expect(resgate.status, JSON.stringify(resgate.body)).toBe(200);
    expect(resgate.body.discountCents).toBe(400);
    expect(resgate.body.balanceAfter).toBe(260);

    const cancela = await request(app)
      .post(`/api/v1/core/sales/${vendaB.id}/cancel`)
      .set(loja.auth)
      .send({ reason: 'cliente desistiu no balcão' });
    expect(cancela.status, JSON.stringify(cancela.body)).toBe(200);

    expect(
      await saldoDePontos(loja, String(cliente.id)),
      'cancelamento estornou o earn (−100) mas não devolveu o resgate (+40): o cliente perdeu 40 pontos numa venda que não existe mais — saldo devido 200, saldo real 160',
    ).toBe(200);
  });

  it('ponto é da OPERAÇÃO: na vizinha, o mesmo cliente tem saldo zero, extrato vazio e resgate recusado', async () => {
    /*
      O predicado é o par (company_id, customer_id) — pointsBalance,
      customerStatement e loyaltyLiability perguntam sempre com os dois.
      fidelidade.test.ts nunca cruzou empresa; aqui o cruzamento inteiro:
      leitura, resgate e passivo.
    */
    const lojaA = await abrirLoja('gerente-fid-a', 'loja-audit-crm');
    const lojaB = await abrirLoja('gerente-fid-b', 'vizinha-audit-crm');

    const produto = await criarProduto(lojaA, 'Produto da A', 10_000);
    const cliente = await criarCliente(lojaA, { name: 'Cliente Fiel da A' });

    for (const loja of [lojaA, lojaB]) {
      await request(app)
        .put('/api/v1/core/loyalty/program')
        .set(loja.auth)
        .send({ active: true, centsPerPoint: 100, pointValueCents: 1 })
        .expect(200);
    }

    await vender(lojaA, {
      customerId: cliente.id,
      items: [{ productId: produto, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
    });
    expect(await saldoDePontos(lojaA, String(cliente.id))).toBe(200);

    // Na B, o MESMO id de cliente: nada vaza — saldo zero, extrato vazio.
    const extratoNaB = await request(app)
      .get(`/api/v1/core/loyalty/customers/${cliente.id}`)
      .set(lojaB.auth);
    expect(extratoNaB.status).toBe(200);
    expect(extratoNaB.body.balance).toBe(0);
    expect(extratoNaB.body.entries).toEqual([]);

    // Resgatar na B o ponto ganho na A: recusado por saldo — o ponto não
    // existe lá, mesmo com programa ativo dos dois lados.
    const resgateNaB = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(lojaB.auth)
      .send({ customerId: cliente.id, points: 50 });
    expect(resgateNaB.status, JSON.stringify(resgateNaB.body)).toBe(409);
    expect(resgateNaB.body.error?.code).toBe('CORE_LOYALTY_INSUFFICIENT');

    // O passivo da B não conta a dívida da A.
    const programaB = await request(app).get('/api/v1/core/loyalty/program').set(lojaB.auth);
    expect(programaB.body.liability.points).toBe(0);

    // E a A continua devendo exatamente os 200.
    expect(await saldoDePontos(lojaA, String(cliente.id))).toBe(200);
  });
});

// ============================================================================
// 5. SEGMENTAÇÃO: a porta legada /crm saiu (GAP-PRD-075)
// ============================================================================

describe('segmentação do CRM — a porta legada saiu do ar', () => {
  it('POST e GET /crm/segments respondem o 404 da casa — o segmento headless não tem mais onde nascer', async () => {
    /*
      Este bloco documentava a segmentação HEADLESS de `/crm/segments`: o
      segmento gravava e listava, e os `filters` nunca eram avaliados. O
      roteador /crm inteiro saiu (GAP-PRD-075) — era um segundo CRM sobre
      `crm_*`, paralelo a `core_leads`, que nenhuma tela lia. A lacuna de
      produto continua a mesma e continua registrada: segmentar clientes é
      decisão do dono, e quando nascer, nasce no núcleo.
    */
    const casa = await abrirLoja('gestor-seg', 'segmentos-audit-crm', 'admin_geral');
    const criado = await request(app)
      .post('/api/v1/crm/segments')
      .set({ ...casa.auth, 'Idempotency-Key': 'seg-audit-1' })
      .send({ name: 'Clientes VIP', filters: [{ field: 'totalSpentCents', op: '>', value: 100_000 }] });
    expect(criado.status).toBe(404);
    expect(criado.body.error?.code).toBe('API_NOT_FOUND');

    const lista = await request(app).get('/api/v1/crm/segments').set(casa.auth);
    expect(lista.status).toBe(404);
  });
});
