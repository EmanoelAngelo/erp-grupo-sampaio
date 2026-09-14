/**
 * A PEÇA ENTRANDO NA GAVETA — rodada 55.
 *
 * ============================================================================
 * O QUE A BANCADA NÃO CONSEGUIA FAZER
 * ============================================================================
 *
 * A tela de peças tinha 193 linhas e nenhum POST: listava e procurava, e era
 * só. Não cadastrava, não repunha, não editava mínimo, não dizia onde a peça
 * mora. Tudo isso morava no cadastro de PRODUTO — que é tela de gestão e fica
 * fechada para o mecânico, a pessoa que está com a peça na mão.
 *
 * Consequência medida: peça criada pela entrada de nota nasce com mínimo ZERO
 * (a importação não passa `minStock`), e `below_minimum` exige mínimo maior
 * que zero — então o aviso de "está acabando" NUNCA disparava para a peça que
 * entrou pelo caminho principal. O alerta existia e não alcançava ninguém.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 *  - bipar resolve: existe -> repõe; não existe -> cadastra
 *  - documento de origem OBRIGATÓRIO nas duas portas, e ele vai para o razão
 *  - preço DERIVADO de custo + percentual, com a conta da casa
 *  - o mesmo código não vira dois cadastros (o saldo rachado é o pior defeito
 *    possível num estoque)
 *  - mínimo e endereço editáveis de onde se olha a gaveta
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
let mecanicoId: string;

const NF = { numero: 'NF 12345', fornecedor: 'Voltz Distribuidora', valorTotalCents: 96000 };

/**
 * A chave de UM gesto de entrada.
 *
 * O servidor exige `Idempotency-Key` nas duas portas de entrada de peça:
 * sem ela, um clique repetido somaria a carga duas vezes na gaveta. Cada
 * chamada deste teste é um gesto diferente e ganha uma chave diferente — é
 * o que faz as duas viagens do fornecedor continuarem somando.
 */
let gesto = 0;
function chave(): string {
  gesto += 1;
  return `gesto-${gesto}`;
}

beforeEach(async () => {
  resetDbForTests();
  gesto = 0;

  const g = await loginForTest(app, {
    userId: 'ger-gaveta',
    companyId: 'oficina-gaveta',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;

  const m = await loginForTest(app, {
    userId: 'mec-gaveta',
    companyId: 'oficina-gaveta',
    profileCodes: ['mecanico'],
  });
  mecanico = { Authorization: `Bearer ${m.body.accessToken}` };
  mecanicoId = m.body.user.id;

  workshopId = 'wk-gaveta';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-gaveta', 'Bancada', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());
});

function cadastrar(corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/workshop/parts')
    .set(gerente)
    .set('Idempotency-Key', chave())
    .send({
      workshopId,
      name: 'Controlador 48V 1000W',
      barcode: '7891234567895',
      costCents: 32000,
      markupPercent: 40,
      quantity: 3,
      minStock: 2,
      storageLocation: 'Prateleira A3 - Caixa 2',
      documento: NF,
      ...corpo,
    });
}

function saldo(productId: string): { quantity: number; reserved: number } {
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number } | undefined;
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 };
}

// ============================================================================

describe('bipar resolve: existe repõe, não existe cadastra', () => {
  it('código que não existe volta vazio, com o código para o cadastro', async () => {
    const res = await request(app)
      .get('/api/v1/core/workshop/parts/scan')
      .set(gerente)
      .query({ codigo: '7899999999999' });

    expect(res.status).toBe(200);
    expect(res.body.encontrada).toBeNull();
    expect(res.body.codigo).toBe('7899999999999');
  });

  it('código que existe volta com o que a bancada precisa saber', async () => {
    const nova = await cadastrar({});
    expect(nova.status).toBe(201);

    const res = await request(app)
      .get('/api/v1/core/workshop/parts/scan')
      .set(gerente)
      .query({ codigo: '7891234567895' });

    expect(res.status).toBe(200);
    expect(res.body.encontrada.id).toBe(nova.body.productId);
    expect(res.body.encontrada.stock_quantity).toBe(3);
    expect(res.body.encontrada.available).toBe(3);
    expect(res.body.encontrada.min_stock).toBe(2);
    expect(res.body.encontrada.storage_location).toBe('Prateleira A3 - Caixa 2');
  });

  it('o mecânico bipa para consultar — e não vê custo', async () => {
    await cadastrar({});
    const res = await request(app)
      .get('/api/v1/core/workshop/parts/scan')
      .set(mecanico)
      .query({ codigo: '7891234567895' });

    expect(res.status).toBe(200);
    expect(res.body.encontrada.name).toBe('Controlador 48V 1000W');
    // O campo é REMOVIDO no servidor, não escondido na tela.
    expect(res.body.encontrada).not.toHaveProperty('cost_cents');
  });

  it('o código EXATO acha — nunca "parecido"', async () => {
    await cadastrar({});
    const res = await request(app)
      .get('/api/v1/core/workshop/parts/scan')
      .set(gerente)
      .query({ codigo: '789123456789' });
    // Um dígito a menos é outro produto. "Quase igual" devolveria a peça
    // errada para dentro de uma gaveta.
    expect(res.body.encontrada).toBeNull();
  });
});

describe('o preço deriva do custo — a conta é a da casa', () => {
  it('custo 320,00 com 40% vira preço 448,00', async () => {
    const res = await cadastrar({});
    expect(res.status).toBe(201);
    // A MESMA conta do sistema anterior: 32000 x 1,40. Lá era chamada de
    // "margem" e é markup — o nome errado é como se perde dinheiro achando
    // que se está ganhando.
    expect(res.body.priceCents).toBe(44800);
  });

  it('sem percentual e sem preço, a peça é recusada no cadastro', async () => {
    const res = await cadastrar({ markupPercent: null, priceCents: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PART_WITHOUT_PRICE');
    // A recusa é AQUI e não no lançamento da OS: é neste clique que a pessoa
    // ainda pode resolver, com a peça na mão.
    const existe = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND kind = 'part'")
      .get(companyId) as { n: number };
    expect(existe.n).toBe(0);
  });

  it('o preço digitado vale quando ninguém informa percentual', async () => {
    const res = await cadastrar({ markupPercent: null, priceCents: 50000 });
    expect(res.status).toBe(201);
    expect(res.body.priceCents).toBe(50000);
  });
});

describe('o documento de origem é obrigatório, e vai para o razão', () => {
  it('cadastro sem documento é recusado', async () => {
    const res = await cadastrar({ documento: { numero: '  ' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_ENTRY_DOCUMENT_REQUIRED');
  });

  it('reposição sem documento é recusada, e a gaveta não muda', async () => {
    const nova = await cadastrar({});
    const res = await request(app)
      .post(`/api/v1/core/workshop/parts/${nova.body.productId}/reposicao`)
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({ quantity: 5 });

    expect(res.status).toBe(400);
    expect(saldo(nova.body.productId).quantity).toBe(3);
  });

  it('o movimento carrega o número do documento e o custo', async () => {
    const nova = await cadastrar({});
    const mov = getConnection()
      .prepare(
        `SELECT kind, movement_type, document_number, unit_cost_cents, note, workshop_id
           FROM core_stock_movements WHERE product_id = ?`,
      )
      .get(nova.body.productId) as {
      kind: string;
      movement_type: string;
      document_number: string;
      unit_cost_cents: number;
      note: string;
      workshop_id: string;
    };

    expect(mov.movement_type).toBe('in');
    // MANUAL_ENTRY é o rótulo honesto: alguém DECLAROU que a mercadoria
    // chegou. Dizer XML_RECEIPT afirmaria uma nota que não foi lida.
    expect(mov.kind).toBe('MANUAL_ENTRY');
    expect(mov.document_number).toBe('NF 12345');
    expect(mov.unit_cost_cents).toBe(32000);
    expect(mov.note).toContain('Voltz Distribuidora');
    expect(mov.workshop_id).toBe(workshopId);
  });

  it('duas cargas da MESMA nota somam — o fornecedor entrega em duas viagens', async () => {
    const nova = await cadastrar({});
    for (const _ of [1, 2]) {
      const r = await request(app)
        .post(`/api/v1/core/workshop/parts/${nova.body.productId}/reposicao`)
        .set(gerente)
        .set('Idempotency-Key', chave())
        .send({ quantity: 2, documento: NF });
      expect(r.status).toBe(200);
    }
    // Amarrar a chave de idempotência só ao número da nota faria a segunda
    // viagem ser engolida em silêncio: a peça chegava e o saldo não subia.
    // São dois GESTOS, e cada gesto traz a sua chave — por isso somam.
    expect(saldo(nova.body.productId).quantity).toBe(7);
  });
});

describe('o mesmo código não vira dois cadastros', () => {
  it('cadastrar de novo o código que já existe é recusado, apontando a peça', async () => {
    const primeira = await cadastrar({});
    const segunda = await cadastrar({ name: 'Controlador (outro nome)' });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_PART_CODE_TAKEN');
    // A mensagem tem de dizer QUAL peça e o que fazer: sem isso a pessoa
    // muda o código e cadastra assim mesmo, que é o defeito que a recusa
    // existe para impedir.
    expect(segunda.body.error.message).toContain('Controlador 48V 1000W');
    expect(segunda.body.error.message).toContain('reposição');
    expect(segunda.body.error.details?.productId).toBe(primeira.body.productId);
  });
});

describe('a reposição', () => {
  it('soma na gaveta e mantém o preço quando ninguém pede repreço', async () => {
    const nova = await cadastrar({});
    const res = await request(app)
      .post(`/api/v1/core/workshop/parts/${nova.body.productId}/reposicao`)
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({ quantity: 4, costCents: 35000, documento: NF });

    expect(res.status).toBe(200);
    expect(saldo(nova.body.productId).quantity).toBe(7);
    expect(res.body.costCents).toBe(35000);
    // O CUSTO SUBIU E O PREÇO NÃO MUDOU SOZINHO. Preço que muda sozinho é
    // preço que ninguém decidiu, e o número aparece na conta do cliente sem
    // que a loja saiba que aumentou.
    expect(res.body.priceCents).toBe(44800);
    expect(res.body.reprecificada).toBe(false);
  });

  it('com percentual, o preço acompanha o custo novo — e diz que mudou', async () => {
    const nova = await cadastrar({});
    const res = await request(app)
      .post(`/api/v1/core/workshop/parts/${nova.body.productId}/reposicao`)
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({ quantity: 1, costCents: 35000, markupPercent: 40, documento: NF });

    expect(res.status).toBe(200);
    expect(res.body.priceCents).toBe(49000);
    expect(res.body.reprecificada).toBe(true);
  });

  it('mercadoria de revenda não entra por esta porta', async () => {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Camiseta', priceCents: 5000 });

    const res = await request(app)
      .post(`/api/v1/core/workshop/parts/${p.body.id}/reposicao`)
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({ quantity: 2, documento: NF });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_NOT_A_PART');
  });
});

describe('o mínimo e o endereço, editáveis de onde se olha a gaveta', () => {
  it('o mínimo passa a valer, e o aviso dispara', async () => {
    const nova = await cadastrar({ quantity: 3, minStock: 0 });
    const antes = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    // Mínimo zero é "ninguém declarou mínimo": o aviso não dispara, e é assim
    // que nasce toda peça criada pela entrada de nota.
    expect(antes.body.items[0].below_minimum).toBe(false);

    const patch = await request(app)
      .patch(`/api/v1/core/workshop/parts/${nova.body.productId}`)
      .set(gerente)
      .send({ minStock: 5 });
    expect(patch.status).toBe(200);

    const depois = await request(app).get('/api/v1/core/workshop/parts').set(gerente);
    expect(depois.body.items[0].min_stock).toBe(5);
    expect(depois.body.items[0].below_minimum).toBe(true);
  });

  it('o endereço da gaveta é procurável — "o que tem na F1?"', async () => {
    await cadastrar({ storageLocation: 'Prateleira F1 - Caixa 3' });
    const res = await request(app)
      .get('/api/v1/core/workshop/parts')
      .set(gerente)
      .query({ search: 'F1' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].storage_location).toBe('Prateleira F1 - Caixa 3');
  });

  it('o saldo NÃO se ajusta por aqui', async () => {
    const nova = await cadastrar({});
    await request(app)
      .patch(`/api/v1/core/workshop/parts/${nova.body.productId}`)
      .set(gerente)
      .send({ minStock: 1, quantity: 999, stockQuantity: 999 });

    // Uma porta de "corrigir a quantidade" seria o acerto de inventário sem o
    // rastro que o acerto de inventário tem.
    expect(saldo(nova.body.productId).quantity).toBe(3);
  });

  /**
   * ROTA QUE CONVIDA E DEPOIS BARRA é pior que rota fechada.
   *
   * As três rotas de entrada nomeiam `estoquista` — e a resolução da bancada
   * era por FILIAÇÃO a `core_workshop_members`, onde só os mecânicos têm
   * linha. Resultado: quem cuida do estoque lia o próprio perfil na lista de
   * quem pode, clicava, e levava 403 com uma frase sobre autorização de
   * oficina. A conclusão certa de quem vive isso é "o sistema está quebrado".
   */
  it('o estoquista, que a rota nomeia, cadastra de verdade', async () => {
    const est = await loginForTest(app, {
      userId: 'est-gaveta',
      companyId: 'oficina-gaveta',
      profileCodes: ['estoquista'],
    });
    const res = await request(app)
      .post('/api/v1/core/workshop/parts')
      .set({ Authorization: `Bearer ${est.body.accessToken}` })
      .set('Idempotency-Key', chave())
      .send({
        workshopId,
        name: 'Rolamento do estoquista',
        costCents: 10000,
        markupPercent: 40,
        quantity: 2,
        documento: NF,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.priceCents).toBe(14000);
  });

  it('sem bancada informada, a única da empresa é assumida', async () => {
    const res = await request(app)
      .post('/api/v1/core/workshop/parts')
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({
        name: 'Peça sem bancada dita',
        costCents: 5000,
        markupPercent: 40,
        quantity: 1,
        documento: NF,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // Com DUAS bancadas com peça, escolher a primeira em silêncio poria a peça
    // na gaveta errada — e o erro só apareceria com o mecânico da outra
    // procurando o que nunca esteve lá.
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('wk-gaveta-3', ?, 'mob-3', 'Bancada 3', 'mobility', 1, ?)`,
      )
      .run(companyId, new Date().toISOString());

    const ambigua = await request(app)
      .post('/api/v1/core/workshop/parts')
      .set(gerente)
      .set('Idempotency-Key', chave())
      .send({
        name: 'Outra',
        costCents: 5000,
        markupPercent: 40,
        quantity: 1,
        documento: NF,
      });
    expect(ambigua.status).toBe(400);
    expect(ambigua.body.error.code).toBe('CORE_WORKSHOP_REQUIRED');
  });

  it('o mecânico não cadastra nem repõe', async () => {
    const nova = await cadastrar({});
    const criar = await request(app)
      .post('/api/v1/core/workshop/parts')
      .set(mecanico)
      .send({ workshopId, name: 'X', costCents: 100, priceCents: 200, quantity: 1, documento: NF });
    expect(criar.status).toBe(403);

    const repor = await request(app)
      .post(`/api/v1/core/workshop/parts/${nova.body.productId}/reposicao`)
      .set(mecanico)
      .send({ quantity: 1, documento: NF });
    expect(repor.status).toBe(403);
  });
});

describe('a gaveta de cada bancada', () => {
  it('a lista respeita o alcance de quem olha', async () => {
    await cadastrar({});

    // Segunda bancada, com o mecânico vinculado só a ela.
    const outra = 'wk-gaveta-2';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'mob-gaveta-2', 'Bancada 2', 'mobility', 1, ?)`,
      )
      .run(outra, companyId, new Date().toISOString());
    getConnection()
      .prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'mecanico', ?)`,
      )
      .run('wm-gaveta-1', outra, mecanicoId, new Date().toISOString());

    const lista = await request(app).get('/api/v1/core/workshop/parts').set(mecanico);
    expect(lista.status).toBe(200);
    // A peça é da bancada 1 e o mecânico é da 2: a separação que o subtítulo
    // da tela sempre prometeu passa a valer também na LISTA, e não só no
    // lançamento — antes ele via a peça, escolhia, e levava 403.
    expect(lista.body.items).toHaveLength(0);
  });
});
