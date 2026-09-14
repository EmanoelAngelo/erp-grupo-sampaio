/**
 * A ordem de serviço deixa de ser um bilhete de texto livre.
 *
 * ## O que estava errado
 *
 * A loja tem cadastro de cliente e cadastro de equipamento. A OS guardava o
 * nome do cliente COMO DIGITADO — e o mesmo cliente escrito de três jeitos
 * eram três pessoas para a oficina. A rota até aceitava `customerId` e
 * `equipmentId`, e as colunas existiam no banco; era o formulário que nunca os
 * enviava.
 *
 * E a PLACA era digitada e jogada fora: `createOrder` não tinha o parâmetro, o
 * INSERT não listava a coluna, e a listagem exibia `order.plate` — uma coluna
 * que nunca era preenchida. O mecânico digitava a placa da moto e ela sumia.
 *
 * ## O que NÃO mudou, de propósito
 *
 * O vínculo continua OPCIONAL. A oficina atende quem chega, e exigir cadastro
 * para abrir OS travaria o balcão com a pessoa na frente e o aparelho na mão.
 * O texto livre é o que sobra quando não há cadastro — não uma etapa que se
 * pula.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let companyId: string;
let mobilidade: string;
let celulares: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'ger-os',
    companyId: 'empresa-os',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const db = getConnection();
  const agora = new Date().toISOString();
  mobilidade = 'wk-mob-os';
  celulares = 'wk-cel-os';
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'mob', 'Oficina de Mobilidade', 'mobility', 1, ?)`,
  ).run(mobilidade, companyId, agora);
  db.prepare(
    `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
     VALUES (?, ?, 'cel', 'Oficina de Celulares', 'phones', 1, ?)`,
  ).run(celulares, companyId, agora);
});

async function criarCliente(nome: string): Promise<string> {
  const r = await request(app).post('/api/v1/core/customers').set(gerente).send({ name: nome });
  expect(r.status).toBeLessThan(300);
  return r.body.id as string;
}

async function criarEquipamento(workshopId: string, modelo: string, donoId?: string) {
  const dono = donoId ?? (await criarCliente(`Dono de ${modelo}`));
  const r = await request(app).post('/api/v1/core/equipment').set(gerente).send({
    workshopId,
    brand: 'Honda',
    model: modelo,
    origin: 'EXTERNAL_CUSTOMER',
    ownerCustomerId: dono,
  });
  expect(r.status).toBeLessThan(300);
  return { id: r.body.id as string, donoId: dono };
}

function abrirOS(corpo: Record<string, unknown>, workshopId = mobilidade) {
  return request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({ workshopId, ...corpo });
}

function lerOS(id: string) {
  return getConnection()
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(id) as Record<string, unknown>;
}

describe('a placa para de ser jogada fora', () => {
  it('a placa digitada chega ao banco', async () => {
    const r = await abrirOS({ customerName: 'Maria', equipment: 'CG 160', plate: 'ABC1D23' });
    expect(r.status).toBe(201);
    expect(lerOS(r.body.id).plate).toBe('ABC1D23');
  });

  /**
   * Vazio e ausência são coisas diferentes. Com string vazia gravada, um filtro
   * "tem placa" mente — e havia OS no banco da loja exatamente assim.
   */
  it('placa em branco vira ausência, não string vazia', async () => {
    const r = await abrirOS({ customerName: 'Maria', plate: '   ' });
    expect(lerOS(r.body.id).plate).toBeNull();
  });

  it('a placa volta no detalhe da OS', async () => {
    const r = await abrirOS({ customerName: 'Maria', plate: 'XYZ9K88' });
    const d = await request(app)
      .get(`/api/v1/core/workshop/orders/${r.body.id}`)
      .set(gerente);
    expect(d.status).toBe(200);
    expect(d.body.plate).toBe('XYZ9K88');
  });
});

describe('o vínculo é conferido, e manda sobre o texto', () => {
  it('cliente vinculado dá o nome à OS, mesmo com texto divergente', async () => {
    const cliente = await criarCliente('Ana Maria de Souza');
    const r = await abrirOS({ customerId: cliente, customerName: 'aninha' });

    const os = lerOS(r.body.id);
    expect(os.customer_id).toBe(cliente);
    // Guardar os dois criaria duas verdades sobre a mesma pessoa.
    expect(os.customer_name).toBe('Ana Maria de Souza');
  });

  /**
   * Antes isso ia direto para o INSERT e a chave estrangeira estourava como
   * 500 "Erro interno" — quem estava no balcão via o sistema quebrar sem saber
   * o que fazer.
   */
  it('cliente de outra empresa dá 404, e não 500', async () => {
    const outra = await loginForTest(app, {
      userId: 'ger-outra',
      companyId: 'empresa-alheia',
      profileCodes: ['gerente_oficina'],
    });
    const alheio = await request(app)
      .post('/api/v1/core/customers')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ name: 'Cliente da outra' });

    const r = await abrirOS({ customerId: alheio.body.id, customerName: 'x' });
    expect(r.status).toBe(404);
    expect(String(r.body.error?.message ?? r.body.message)).toMatch(/cliente/i);
  });

  it('equipamento vinculado apaga o texto livre — quem nomeia é o cadastro', async () => {
    const eq = await criarEquipamento(mobilidade, 'CG 160 Titan');
    const r = await abrirOS({ customerName: 'Maria', equipmentId: eq.id, equipment: 'motinha' });

    const os = lerOS(r.body.id);
    expect(os.equipment_id).toBe(eq.id);
    expect(os.equipment).toBeNull();

    // E o detalhe devolve o nome do cadastro, para o cartão não ficar em branco.
    const d = await request(app).get(`/api/v1/core/workshop/orders/${r.body.id}`).set(gerente);
    expect(d.body.equipment_display).toBe('Honda CG 160 Titan');
  });

  /** Celular não abre OS na bancada de moto. */
  it('equipamento de outra oficina é recusado', async () => {
    const eq = await criarEquipamento(celulares, 'Galaxy A54');
    const r = await abrirOS({ customerName: 'Maria', equipmentId: eq.id }, mobilidade);
    expect(r.status).toBe(400);
    expect(String(r.body.error?.message ?? r.body.message)).toMatch(/outra oficina/i);
  });

  /**
   * O CASO QUE NÃO PODE QUEBRAR: a oficina atende quem chega. Exigir cadastro
   * para abrir OS travaria o balcão.
   */
  it('sem vínculo nenhum, a OS abre com texto livre', async () => {
    const r = await abrirOS({ customerName: 'Senhor de boné', equipment: 'Bike sem marca' });
    expect(r.status).toBe(201);

    const os = lerOS(r.body.id);
    expect(os.customer_id).toBeNull();
    expect(os.customer_name).toBe('Senhor de boné');
    expect(os.equipment).toBe('Bike sem marca');
  });
});

describe('o detalhe da OS, que existia sem consumidor', () => {
  it('devolve a ordem com peças, comentários e linha do tempo', async () => {
    const r = await abrirOS({ customerName: 'Maria', plate: 'ABC1D23' });
    const d = await request(app).get(`/api/v1/core/workshop/orders/${r.body.id}`).set(gerente);

    expect(d.status).toBe(200);
    expect(Array.isArray(d.body.parts)).toBe(true);
    expect(Array.isArray(d.body.comments)).toBe(true);
    // O evento de abertura já nasce na linha do tempo.
    expect(d.body.events.length).toBeGreaterThan(0);
    expect(d.body.customer_display).toBe('Maria');
  });

  it('OS de outra empresa não é encontrada', async () => {
    const outra = await loginForTest(app, {
      userId: 'ger-outra2',
      companyId: 'empresa-alheia2',
      profileCodes: ['gerente_oficina'],
    });
    const r = await abrirOS({ customerName: 'Maria' });

    const d = await request(app)
      .get(`/api/v1/core/workshop/orders/${r.body.id}`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(d.status).toBe(404);
  });
});

describe('a busca', () => {
  async function tresOS() {
    await abrirOS({ customerName: 'Ana Paula', plate: 'ABC1D23', complaint: 'não liga' });
    await abrirOS({ customerName: 'Bruno Lima', plate: 'XYZ9K88', complaint: 'freio solto' });
    await abrirOS({ customerName: 'Carla Dias', complaint: 'revisão' }, celulares);
  }

  function buscar(qs: string) {
    return request(app).get(`/api/v1/core/workshop/orders?${qs}`).set(gerente);
  }

  it('acha pelo nome do cliente', async () => {
    await tresOS();
    const r = await buscar('q=bruno');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].customer_display).toBe('Bruno Lima');
  });

  it('acha pela placa', async () => {
    await tresOS();
    const r = await buscar('q=XYZ9');
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].plate).toBe('XYZ9K88');
  });

  /** É como o balcão chama a OS: "a 2 ficou pronta?". */
  it('acha pelo número da OS', async () => {
    await tresOS();
    const r = await buscar('q=2');
    expect(r.body.items.some((o: { number: number }) => o.number === 2)).toBe(true);
  });

  it('filtra por oficina', async () => {
    await tresOS();
    const r = await buscar(`workshopId=${celulares}`);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].customer_display).toBe('Carla Dias');
  });

  it('filtra por situação', async () => {
    await tresOS();
    const r = await buscar('status=em_aberto');
    expect(r.body.items.length).toBe(3);
    expect(r.body.total).toBe(3);
  });

  it('devolve o total separado da página', async () => {
    await tresOS();
    const r = await buscar('limit=2');
    expect(r.body.items).toHaveLength(2);
    expect(r.body.total).toBe(3);
  });
});

/**
 * O ALCANCE, que é onde a rodada quase quebrou o balcão.
 *
 * A tentação era traduzir "não é membro de oficina nenhuma" para lista vazia —
 * escopo explícito, filtro honesto. No banco da loja isso fecharia o caixa: o
 * operador de caixa da oficina NÃO tem vínculo em `core_workshop_members` (só
 * os mecânicos têm), e é ele quem cobra a OS pronta.
 */
describe('quem enxerga qual oficina', () => {
  async function sessao(userId: string, perfil: string) {
    const r = await loginForTest(app, { userId, companyId: 'empresa-os', profileCodes: [perfil] });
    return { Authorization: `Bearer ${r.body.accessToken}` };
  }

  it('o caixa da oficina, sem vínculo nenhum, continua vendo as OS', async () => {
    await abrirOS({ customerName: 'Ana' });
    await abrirOS({ customerName: 'Bruno' }, celulares);

    const caixa = await sessao('caixa-oficina', 'operador_caixa_oficina');
    const r = await request(app).get('/api/v1/core/workshop/orders').set(caixa);

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
  });

  it('o mecânico vinculado a uma oficina não vê a OS da outra', async () => {
    await abrirOS({ customerName: 'Ana' });
    await abrirOS({ customerName: 'Bruno' }, celulares);

    const mec = await sessao('mec-mob', 'mecanico');
    const eu = getConnection()
      .prepare('SELECT id FROM core_users WHERE login LIKE ?')
      .get('mec-mob@%') as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('m-1', mobilidade, eu.id, new Date().toISOString());

    const r = await request(app).get('/api/v1/core/workshop/orders').set(mec);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].customer_display).toBe('Ana');
  });

  /**
   * Existe OS gravada antes de `workshop_id` existir. Ela não pertence a
   * oficina nenhuma, e um IN (...) puro a excluiria para sempre — inclusive
   * para o gestor, que é justamente quem precisaria consertá-la.
   */
  it('OS sem oficina não some do alcance de ninguém', async () => {
    const r = await abrirOS({ customerName: 'Legada' });
    getConnection()
      .prepare('UPDATE core_service_orders SET workshop_id = NULL WHERE id = ?')
      .run(r.body.id);

    const mec = await sessao('mec-mob2', 'mecanico');
    const eu = getConnection()
      .prepare('SELECT id FROM core_users WHERE login LIKE ?')
      .get('mec-mob2@%') as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('m-2', mobilidade, eu.id, new Date().toISOString());

    const lista = await request(app).get('/api/v1/core/workshop/orders').set(mec);
    expect(lista.body.items.some((o: { id: string }) => o.id === r.body.id)).toBe(true);

    // E o detalhe dela também responde.
    const d = await request(app).get(`/api/v1/core/workshop/orders/${r.body.id}`).set(mec);
    expect(d.status).toBe(200);
  });
});
