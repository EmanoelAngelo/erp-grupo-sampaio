/**
 * Peças da oficina.
 *
 * Duas regras, e as duas já existiam no repositório em outro lugar — o que
 * faltava era valerem aqui:
 *
 *   O MECÂNICO NÃO VÊ CUSTO. O que a empresa pagou no fornecedor não é assunto
 *   de quem monta a peça. E o campo é REMOVIDO da resposta, não escondido na
 *   tela: dado que não sai do servidor não vaza por inspeção do navegador.
 *
 *   PEÇA PERTENCE A UMA OFICINA. A bancada de celulares não enxerga o estoque
 *   de mobilidade.
 *
 * E o buraco que esta rodada fecha: peça requisitada e não usada sumia. A baixa
 * acontecia ao lançar na OS, e não havia caminho de volta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let mecanico: { Authorization: string };
let companyId: string;
let workshopId: string;

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, {
    userId: 'ger-oficina',
    companyId: 'oficina-pecas',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;

  const m = await loginForTest(app, {
    userId: 'mec-1',
    companyId: 'oficina-pecas',
    profileCodes: ['mecanico'],
  });
  mecanico = { Authorization: `Bearer ${m.body.accessToken}` };

  const db = getConnection();
  workshopId = 'wk-pecas';
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'bancada', 'Bancada', 'mobility', 1, ?)`,
  ).run(workshopId, companyId, new Date().toISOString());
});

async function peca(nome: string, qtd: number, custo = 3000, oficina: string | null = workshopId) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome, priceCents: 9000, costCents: custo });

  getConnection()
    .prepare("UPDATE core_products SET kind = 'part', workshop_id = ?, min_stock = 2 WHERE id = ?")
    .run(oficina, p.body.id);

  if (qtd > 0) {
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id}`,
    });
  }
  return p.body.id as string;
}

describe('o mecânico não vê custo', () => {
  it('o campo NÃO sai do servidor para o mecânico', async () => {
    await peca('Parafuso', 10);
    const res = await request(app).get('/api/v1/core/workshop/parts').set(mecanico);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    // Removido, não zerado nem escondido: não há o que inspecionar no navegador.
    expect(res.body.items[0]).not.toHaveProperty('cost_cents');
    // O que ele precisa saber continua vindo.
    expect(res.body.items[0].name).toBe('Parafuso');
    expect(res.body.items[0].stock_quantity).toBe(10);
  });

  it('o gerente vê', async () => {
    await peca('Rolamento', 5, 4500);
    const res = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    expect(res.body.items[0].cost_cents).toBe(4500);
  });
});

describe('recorte por oficina', () => {
  it('só lista peça, não produto de revenda', async () => {
    await peca('Peça', 5);
    await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Camiseta de revenda', priceCents: 5000 });

    const res = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Peça');
  });

  it('filtra pela oficina pedida', async () => {
    await peca('Da bancada', 5, 3000, workshopId);
    await peca('De outra', 5, 3000, null);

    const res = await request(app)
      .get(`/api/v1/core/workshop/parts?workshopId=${workshopId}`)
      .set(gerente);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Da bancada');
  });

  it('avisa quando está abaixo do mínimo', async () => {
    await peca('Quase acabando', 1);
    const res = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    // É o que faz alguém repor antes de faltar no meio de um conserto.
    expect(res.body.items[0].below_minimum).toBe(true);
  });
});

/**
 * O MECÂNICO LANÇANDO A PEÇA — a persona que faltava inteira.
 *
 * Os sete lançamentos deste arquivo eram todos do GERENTE, e o gerente passa em
 * lugares onde o mecânico não passa: `resolveWorkshop` o trata como quem
 * alcança qualquer bancada da empresa, e ele nunca esbarra em
 * `CORE_ORDER_NOT_ASSIGNED_TO_YOU` na prática porque costuma ser quem assume.
 *
 * A tela nova é do mecânico — é o perfil que o `useHasProfile` da OS libera, é
 * quem está com o aparelho aberto na bancada, e é dele que falam todos os
 * comentários do serviço ("quem lê isto quase sempre é o mecânico"). Uma suíte
 * que só exercita o gerente prova a regra pela pessoa errada: bastaria a rota
 * passar a exigir um perfil de gestão para o balcão inteiro parar sem nenhum
 * teste ficar vermelho.
 */
describe('o mecânico é quem lança a peça, e é por ele que a corrente é medida', () => {
  async function osDoMecanico(): Promise<string> {
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Cliente', workshopId, complaint: 'não liga' });
    // ASSUMIR é o que amarra a OS ao técnico. Sem isto o lançamento até passa
    // (OS sem responsável aceita qualquer um), e o teste provaria menos.
    const assumida = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/assume`)
      .set(mecanico)
      .send({ status: 'em_andamento', comment: 'assumindo' });
    expect(assumida.status).toBeLessThan(300);
    return os.body.id as string;
  }

  it('lança a peça da própria OS: sai da gaveta e entra na conta', async () => {
    const orderId = await osDoMecanico();
    const produto = await peca('Conector de carga', 6);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 2 });

    expect(res.status).toBe(201);
    // A peça continua na gaveta, agora com dono.
    expect(saldoDe(produto)).toBe(6);
    expect(reservaDe(produto)).toBe(2);
    const os = getConnection()
      .prepare('SELECT parts_cents, total_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number; total_cents: number };
    expect(os.parts_cents).toBe(18000);
    expect(os.total_cents).toBe(18000);
  });

  /**
   * A OS DO COLEGA.
   *
   * É a recusa que a tela da OS espelha: ela deixa de oferecer o botão quando
   * `mechanic_id` é de outro, e a frase que ela escreve ("quem lança e devolve
   * peça é quem assumiu") só faz sentido se o servidor recusar de fato. Sem
   * este teste, a tela poderia estar guardando uma porta que já estava aberta.
   */
  it('a OS assumida por outro técnico recusa a peça — e a gaveta não é tocada', async () => {
    const outro = await loginForTest(app, {
      userId: 'mec-2',
      companyId: 'oficina-pecas',
      profileCodes: ['mecanico'],
    });
    const orderId = await osDoMecanico();
    const produto = await peca('Bateria', 5);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set({ Authorization: `Bearer ${outro.body.accessToken}` })
      .send({ productId: produto, quantity: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_ORDER_NOT_ASSIGNED_TO_YOU');
    expect(saldoDe(produto)).toBe(5);
  });

  /**
   * A RECUSA CHEGA INTEIRA ATÉ ELE.
   *
   * A tela mostra a mensagem do SERVIDOR em vez de escrever uma segunda versão
   * dela, e é isso que faz a recusa ser útil: "peça sem preço" não diz a quem
   * pedir. Se a mensagem fosse encurtada para o mecânico (ou trocada por um
   * código), a tela passaria a exibir um erro que não resolve nada.
   */
  it('a recusa de peça sem preço chega ao mecânico com a frase inteira', async () => {
    const orderId = await osDoMecanico();
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Flex sem preço', priceCents: 0, costCents: 2000 });
    getConnection()
      .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
      .run(workshopId, p.body.id);
    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: 3,
      referenceType: 'entrada',
      referenceId: `nf-${p.body.id}`,
    });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(mecanico)
      .send({ productId: p.body.id, quantity: 1 });

    expect(res.status).toBe(409);
    const mensagem = String(res.body.error?.message ?? '');
    expect(mensagem).toContain('Flex sem preço');
    // Diz QUEM resolve, e não manda o mecânico a uma tela que o roteador fecha
    // para ele.
    expect(mensagem).toContain('cadastro do produto');
    expect(mensagem).not.toContain('/sistema/produtos');
  });

  /**
   * O CUSTO NÃO ATRAVESSA A CORRENTE INTEIRA.
   *
   * `listParts` já era cobrado sozinho lá em cima. O que este teste mede é o
   * caminho que a tela nova percorre de ponta a ponta — buscar na gaveta,
   * lançar, reler a OS —, porque é aí que um campo a mais escapa: a resposta do
   * lançamento e o detalhe da OS são objetos grandes, montados em outro
   * serviço, e nenhum deles passa pelo `hideCost`.
   */
  it('nem a busca, nem o lançamento, nem a OS relida entregam custo ao mecânico', async () => {
    const orderId = await osDoMecanico();
    const produto = await peca('Placa-mãe', 4, 55000);

    const gaveta = await request(app)
      .get(`/api/v1/core/workshop/parts?workshopId=${workshopId}`)
      .set(mecanico);
    expect(gaveta.body.items[0]).not.toHaveProperty('cost_cents');

    const lancamento = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 1 });
    expect(lancamento.status).toBe(201);

    const detalhe = await request(app)
      .get(`/api/v1/core/workshop/orders/${orderId}`)
      .set(mecanico);
    expect(detalhe.status).toBe(200);
    // O PREÇO ele vê: é o que entra na conta do cliente e é o número que diz
    // que o conserto está sendo cobrado.
    expect(detalhe.body.parts[0].unit_price_cents).toBe(9000);
    // O custo, não — em nenhum canto do documento inteiro.
    expect(JSON.stringify(detalhe.body)).not.toContain('55000');
    expect(JSON.stringify(detalhe.body)).not.toContain('cost_cents');
  });

  it('devolver pela linha da tabela é dele também, e a conta cai junto', async () => {
    const orderId = await osDoMecanico();
    const produto = await peca('Parafuso', 10);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(mecanico)
      .send({ productId: produto, quantity: 3 });

    const parte = getConnection()
      .prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?')
      .get(orderId) as { id: string };

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${parte.id}/return`)
      .set(mecanico)
      .send({ quantity: 1, reason: 'Não precisou' });

    expect(res.status).toBe(200);
    // Nunca saiu da prateleira: o que cai é a promessa, não o saldo.
    expect(saldoDe(produto)).toBe(10);
    expect(reservaDe(produto)).toBe(2);
    const os = getConnection()
      .prepare('SELECT parts_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number };
    // Duas ficaram no aparelho; a terceira está de volta e não é cobrada.
    expect(os.parts_cents).toBe(18000);
  });
});

/**
 * O LANÇAMENTO DA PEÇA NA OS — as duas recusas que faltavam.
 *
 * Cada teste aqui é escrito para FALHAR se o guarda sair do código. Tirar a
 * conferência de preço faz o primeiro passar a devolver 201 e a OS fechar sem
 * custo; tirar a de saldo faz a recusa voltar a ser a frase genérica de
 * `applyMovement`, sem nome de peça e sem número.
 */
describe('a peça só entra na OS se puder ser cobrada e existir', () => {
  async function abrirOs(): Promise<string> {
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Cliente', workshopId, complaint: 'não liga' });
    return os.body.id as string;
  }

  async function pecaSemPreco(nome: string, qtd: number): Promise<string> {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      // É EXATAMENTE assim que a importação de XML cria produto: a nota traz o
      // custo e o sistema não inventa margem.
      .send({ name: nome, priceCents: 0, costCents: 2000 });

    getConnection()
      .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
      .run(workshopId, p.body.id);

    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `nf-${p.body.id}`,
    });
    return p.body.id as string;
  }

  it('peça a R$ 0,00 é recusada — senão a loja dá a peça de graça', async () => {
    const orderId = await abrirOs();
    const produto = await pecaSemPreco('Conector de carga', 5);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PART_WITHOUT_PRICE');
    // Nada saiu da gaveta: a recusa vem antes da baixa.
    const row = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(companyId, produto) as { quantity: number };
    expect(row.quantity).toBe(5);
  });

  /*
    A CORRENTE INTEIRA, num teste só.

    Sem o guarda, esta sequência termina com uma OS FINALIZADA de total zero
    contendo uma peça que saiu do estoque — a loja deu a peça e o guarda que
    existe para impedir isso (`CORE_HAS_PARTS_COST`) não dispara, porque ele só
    reage a total maior que zero.
  */
  it('a peça de graça faria a OS fechar "sem custo" com peça dentro', async () => {
    const orderId = await abrirOs();
    const produto = await pecaSemPreco('Bateria genérica', 3);

    const lancamento = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 1 });
    expect(lancamento.status).toBe(409);

    const os = getConnection()
      .prepare('SELECT parts_cents, total_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number; total_cents: number };
    expect(os.parts_cents).toBe(0);
    expect(os.total_cents).toBe(0);
  });

  it('falta de peça diz QUAL peça e QUANTO tem', async () => {
    const orderId = await abrirOs();
    const produto = await peca('Flex de tela', 1);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 3 });

    expect(res.status).toBe(409);
    const mensagem = String(res.body.error?.message ?? res.body.message ?? '');
    // "Estoque insuficiente para concluir a operação" não serve a quem está com
    // o aparelho aberto na bancada: o nome e os números são a mensagem.
    expect(mensagem).toContain('Flex de tela');
    expect(mensagem).toContain('1');
    expect(mensagem).toContain('3');
    expect(saldoDe(produto)).toBe(1);
  });

  it('peça reservada não é surrupiada, e a recusa não culpa um só compromisso', async () => {
    const orderId = await abrirOs();
    const produto = await peca('Tela completa', 5);

    // Reserva tem QUATRO origens desde a rodada 55 — outra OS, pedido da loja
    // online, pré-venda e locação. O teste escreve o número direto porque o que
    // está sob prova é a recusa, não quem reservou.
    getConnection()
      .prepare('UPDATE core_stock SET reserved = 4 WHERE company_id = ? AND product_id = ?')
      .run(companyId, produto);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 3 });

    expect(res.status).toBe(409);
    const mensagem = String(res.body.error?.message ?? res.body.message ?? '');
    expect(mensagem).toContain('prometida');
    /*
      NOMEAR UMA ORIGEM SÓ DESCREVERIA O ESTADO ERRADO na maioria dos casos.

      A frase antiga listava três e uma delas era falsa: ORÇAMENTO não reserva,
      é papel — quem reserva é a pré-venda. E desde a rodada 55 a causa mais
      provável de todas é outra OS. O que este caso trava é que a mensagem
      continue oferecendo MAIS DE UM lugar para procurar.
    */
    expect(mensagem).toContain('outra OS');
    expect(mensagem).toContain('locação');
    expect(mensagem).not.toContain('orçamento');
    expect(saldoDe(produto)).toBe(5);
  });

  it('com preço e com saldo, a peça entra e soma na conta', async () => {
    const orderId = await abrirOs();
    const produto = await peca('Cabo flat', 4);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.parts_cents).toBe(18000);
    expect(saldoDe(produto)).toBe(4);
    expect(reservaDe(produto)).toBe(2);
  });

  /**
   * O ESPELHO DA PEÇA DE GRAÇA — e o guarda que só agora tem como disparar.
   *
   * `CORE_HAS_PARTS_COST` existe desde que a OS existe, e o teste que o cobria
   * lançava a peça direto pelo servidor. Na operação de verdade ele nunca
   * disparava por um motivo mais simples: nenhuma tela lançava peça, então
   * `total_cents` era sempre zero e "encerrar sem custo" sempre passava.
   *
   * Aqui a corrente inteira roda pela porta que a rodada abriu — peça com
   * preço, lançada, conta somada — e é o fim dela que interessa: com peça
   * dentro, encerrar "sem custo" tem de ser RECUSADO. É o contraste exato do
   * teste da peça a R$ 0,00 lá em cima: lá a OS fechava sem custo porque a
   * peça não valia nada; aqui ela não fecha, porque vale.
   */
  it('com a peça lançada, encerrar "sem custo" passa a ser recusado', async () => {
    const orderId = await abrirOs();
    const produto = await peca('Bateria 48V', 4);

    const lancamento = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: produto, quantity: 2 });
    expect(lancamento.status).toBe(201);

    // A conta subiu DE VERDADE — é `total_cents` que o guarda do fechamento
    // lê, e sem esta linha o teste passaria com um lançamento que não somou.
    const os = getConnection()
      .prepare('SELECT parts_cents, total_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number; total_cents: number };
    expect(os.parts_cents).toBe(18000);
    expect(os.total_cents).toBe(18000);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/assume`)
      .set(gerente)
      .send({ status: 'em_andamento', comment: 'assumindo' });

    const semCusto = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente)
      .send({ diagnosis: 'Trocada a bateria', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });

    expect(semCusto.status).toBe(409);
    expect(semCusto.body.error?.code ?? semCusto.body.code).toBe('CORE_HAS_PARTS_COST');

    // E a OS continua aberta: recusa que já tivesse fechado seria pior que
    // nenhuma.
    const depois = getConnection()
      .prepare('SELECT status FROM core_service_orders WHERE id = ?')
      .get(orderId) as { status: string };
    expect(depois.status).toBe('em_andamento');
  });
});

/**
 * A PEÇA DA OUTRA BANCADA — o guarda que existia e não alcançava nada.
 *
 * `CORE_PART_OTHER_WORKSHOP` está em `addPart` desde que a oficina foi escrita,
 * e comparava `product.workshop_id` com o da OS. Só que NADA gravava
 * `workshop_id` em produto: o mapa de campos do `atualizarProduto` não tinha a
 * coluna, e no banco real os dezenove produtos estavam todos sem oficina. O
 * guarda comparava nulo com um id e liberava sempre — vigiava uma porta que
 * ninguém conseguia abrir.
 *
 * Por isso este teste marca a peça pela ROTA DE CONVERSÃO, e não por UPDATE
 * direto: o que ele prova não é a comparação (essa já estava escrita), é que
 * agora existe um caminho de operação que chega até ela. Um teste que gravasse
 * a coluna por SQL cru ficaria verde mesmo com o defeito central de volta.
 */
describe('a peça de uma bancada não entra na OS da outra', () => {
  let segundaBancada: string;

  beforeEach(() => {
    segundaBancada = 'wk-celulares-2';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'celulares-2', 'Bancada de Celulares', 'phones', 1, ?)`,
      )
      .run(segundaBancada, companyId, new Date().toISOString());
  });

  /** Peça marcada pelo caminho de verdade: a rota que a rodada abriu. */
  async function pecaConvertida(nome: string, oficina: string, qtd: number): Promise<string> {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: nome, priceCents: 9000, costCents: 3000 });

    const convertido = await request(app)
      .post(`/api/v1/core/products/${p.body.id}/tipo`)
      .set(gerente)
      .send({ kind: 'part', workshopId: oficina });
    expect(convertido.status).toBe(200);
    expect(convertido.body.workshopId).toBe(oficina);

    await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `nf-${p.body.id}`,
    });
    return p.body.id as string;
  }

  it('a peça da bancada de celulares é recusada na OS da de mobilidade', async () => {
    const daOutra = await pecaConvertida('Tela de iPhone', segundaBancada, 5);

    // A premissa, conferida no banco: a coluna está MESMO preenchida, e com a
    // OUTRA bancada. Sem isto o teste passaria pelo motivo errado no dia em que
    // a conversão voltasse a não gravar nada — a recusa cairia em
    // `CORE_PRODUCT_NOT_FOUND` ou simplesmente sumiria.
    const linha = getConnection()
      .prepare('SELECT workshop_id FROM core_products WHERE id = ?')
      .get(daOutra) as { workshop_id: string | null };
    expect(linha.workshop_id).toBe(segundaBancada);

    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Cliente', workshopId, complaint: 'não liga' });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/parts`)
      .set(gerente)
      .send({ productId: daOutra, quantity: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PART_OTHER_WORKSHOP');
    // A gaveta da outra bancada não foi tocada.
    expect(saldoDe(daOutra)).toBe(5);
  });

  it('a peça da PRÓPRIA bancada entra — a recusa é do escopo, não de toda peça', async () => {
    const daCasa = await pecaConvertida('Bateria 48V', workshopId, 5);

    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ customerName: 'Cliente', workshopId, complaint: 'não liga' });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/parts`)
      .set(gerente)
      .send({ productId: daCasa, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.parts_cents).toBe(18000);
    expect(saldoDe(daCasa)).toBe(5);
    expect(reservaDe(daCasa)).toBe(2);
  });
});

function saldoDe(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

/**
 * O que a bancada PROMETEU (rodada 55).
 *
 * A peça lançada na OS não sai da prateleira: ela fica reservada até o serviço
 * ser autorizado. Então quase todo caso daqui passou a ter DUAS afirmações — o
 * físico que não anda e a promessa que anda. Afirmar só uma deixaria passar
 * exatamente o defeito que a rodada existe para impedir.
 */
function reservaDe(productId: string): number {
  const row = getConnection()
    .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { reserved: number } | undefined;
  return row?.reserved ?? 0;
}

describe('devolução de peça não usada', () => {
  async function osComPeca(quantidade: number) {
    const p = await peca('Cabo', 10);
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente)
      .send({ title: 'Conserto', workshopId, description: 'teste' });
    const orderId = os.body.id;

    const comPeca = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts`)
      .set(gerente)
      .send({ productId: p, quantity: quantidade });
    expect(comPeca.status).toBeLessThan(300);

    const parte = getConnection()
      .prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?')
      .get(orderId) as { id: string };
    return { orderId, partId: parte.id, productId: p };
  }

  function saldo(productId: string): number {
    const row = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(companyId, productId) as { quantity: number } | undefined;
    return row?.quantity ?? 0;
  }

  /** O prometido. Ver a nota em reservaDe, no alto do arquivo. */
  function prometido(productId: string): number {
    const row = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(companyId, productId) as { reserved: number } | undefined;
    return row?.reserved ?? 0;
  }

  it('a peça devolvida volta ao estoque', async () => {
    const { orderId, partId, productId } = await osComPeca(3);
    // Prometida, não baixada: a peça está na prateleira esperando o serviço.
    expect(saldo(productId)).toBe(10);
    expect(prometido(productId)).toBe(3);

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 1, reason: 'Não precisou' });

    expect(res.status).toBe(200);
    // Sem isto o parafuso não usado sumia do sistema para sempre. Agora o que
    // volta é a PROMESSA — dar entrada aqui inventaria mercadoria.
    expect(saldo(productId)).toBe(10);
    expect(prometido(productId)).toBe(2);
  });

  /**
   * O TIPO DIZ O QUE ACONTECEU — e a peça devolvida tem dois "o que aconteceu"
   * possíveis desde a rodada 55.
   *
   * Devolver o que ainda estava PROMETIDO desfaz a promessa: a peça nunca saiu
   * da prateleira. Devolver o que JÁ SAIU é entrada de verdade. Ajuste de
   * inventário esconderia as duas origens — a peça voltou de uma OS, não de
   * uma contagem —, e é isso que este caso continua travando.
   */
  it('o movimento tem tipo próprio, não vira ajuste de inventário', async () => {
    const { orderId, partId } = await osComPeca(2);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 1 });

    const mov = getConnection()
      .prepare("SELECT kind, movement_type FROM core_stock_movements WHERE reference_type = 'workshop_part_return'")
      .get() as { kind: string; movement_type: string };
    expect(mov.kind).toBe('WORKSHOP_PART_RESERVATION_RELEASE');
    expect(mov.movement_type).toBe('release');
    expect(mov.kind).not.toContain('ADJUSTMENT');
  });

  it('não devolve mais do que requisitou', async () => {
    const { orderId, partId } = await osComPeca(2);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 5 });
    expect(res.status).toBe(409);
  });

  it('duas devoluções parciais somam e respeitam o total', async () => {
    const { orderId, partId, productId } = await osComPeca(3);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 2 });
    const segunda = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 2 });

    expect(segunda.status).toBe(409);
    expect(saldo(productId)).toBe(10);
    expect(prometido(productId)).toBe(1);
  });

  /*
    O QUE VOLTOU PARA A GAVETA NÃO É COBRADO.

    Escrito depois de rodar o fluxo no navegador: a peça voltava ao estoque e a
    OS continuava marcando R$ 1.800,00. O defeito estava aqui desde que a
    devolução foi escrita — invisível porque nenhuma tela a chamava.

    Sem o `recalcularTotaisDaOS` na devolução, este teste falha nas duas
    afirmações: o total fica no valor cheio e a OS de garantia não fecha.
  */
  it('a devolução derruba a conta da OS, e não só o saldo', async () => {
    const { orderId, partId } = await osComPeca(3);
    const antes = getConnection()
      .prepare('SELECT parts_cents, total_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number; total_cents: number };
    expect(antes.total_cents).toBe(27000);

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 1 });

    const depois = getConnection()
      .prepare('SELECT parts_cents, total_cents FROM core_service_orders WHERE id = ?')
      .get(orderId) as { parts_cents: number; total_cents: number };
    // Duas peças ficaram na moto; a terceira está de volta na gaveta e o
    // cliente não paga por ela.
    expect(depois.parts_cents).toBe(18000);
    expect(depois.total_cents).toBe(18000);
  });

  it('devolvido tudo, a OS de garantia volta a poder fechar sem custo', async () => {
    const { orderId, partId } = await osComPeca(2);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/parts/${partId}/return`)
      .set(mecanico)
      .send({ quantity: 2 });

    await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/assume`)
      .set(gerente)
      .send({ status: 'em_andamento', comment: 'assumindo' });

    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${orderId}/complete`)
      .set(gerente)
      .send({ diagnosis: 'Não precisou de peça', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });

    // Com a conta velha, isto era CORE_HAS_PARTS_COST: a OS ficava presa,
    // cobrando por peça nenhuma.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('finalizada');
  });

  it('peça de outra OS é recusada', async () => {
    const a = await osComPeca(1);
    const b = await osComPeca(1);
    const res = await request(app)
      .post(`/api/v1/core/workshop/orders/${a.orderId}/parts/${b.partId}/return`)
      .set(mecanico)
      .send({ quantity: 1 });
    expect(res.status).toBe(404);
  });
});
