/**
 * A página que a plaquinha abre.
 *
 * O QR era gerado, impresso e colado — e levava a lugar nenhum: a rota só
 * existia no roteador legado, inalcançável, e não havia endpoint público para
 * resolver o token.
 *
 * A REGRA QUE ESTE ARQUIVO PROTEGE: a plaquinha fica EXPOSTA no equipamento, no
 * pátio, na calçada. Quem passa pode escanear. Já havia teste cobrando que o QR
 * não carregue dado do dono; este cobra o outro lado — não basta o token ser
 * opaco se a página que ele abre despeja tudo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let workshopId: string;
let clienteId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'ger-of-publico',
    companyId: 'oficina-publica',
    profileCodes: ['gerente_oficina'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  workshopId = 'wk-publica';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'publica', 'Oficina de Mobilidade', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());

  const cliente = await request(app)
    .post('/api/v1/core/customers')
    .set(auth)
    .send({ name: 'Joana Proprietária', document: '52998224725', phone: '53988887777' });
  clienteId = cliente.body.id;
});

async function equipamento() {
  const res = await request(app)
    .post('/api/v1/core/equipment')
    .set(auth)
    .send({
      workshopId,
      brand: 'Shineray',
      model: 'Patinete X',
      color: 'Vermelho',
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: clienteId,
    });
  expect(res.status).toBeLessThan(300);
  const token = getConnection()
    .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
    .get(res.body.id) as { public_token: string };
  return { id: res.body.id as string, token: token.public_token };
}

describe('a plaquinha abre alguma coisa', () => {
  it('o token resolve o equipamento, sem login', async () => {
    const eq = await equipamento();
    // Sem cabeçalho de autenticação: é o cliente na calçada.
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);

    expect(res.status).toBe(200);
    expect(res.body.brand).toBe('Shineray');
    expect(res.body.model).toBe('Patinete X');
    expect(res.body.companyName).toBeTruthy();
  });

  it('exigir login mataria a plaquinha', async () => {
    const eq = await equipamento();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    // Ninguém cria conta na calçada para saber se a moto ficou pronta.
    expect(res.status).not.toBe(401);
  });

  it('token desconhecido e token inválido respondem IGUAL', async () => {
    const a = await request(app).get('/api/v1/loja/equipamento/nao-existe');
    const b = await request(app).get('/api/v1/loja/equipamento/xxxxxxxx');
    // Distinguir os dois diria a quem tenta adivinhar que chegou perto.
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body.error.code).toBe(b.body.error.code);
  });
});

describe('o que a página NUNCA mostra', () => {
  it('nada do dono — nem nome, nem telefone, nem documento', async () => {
    const eq = await equipamento();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    const corpo = JSON.stringify(res.body);

    // A plaquinha fica exposta: quem passa na calçada pode escanear.
    expect(corpo).not.toContain('Joana');
    expect(corpo).not.toContain('52998224725');
    expect(corpo).not.toContain('53988887777');
    expect(res.body).not.toHaveProperty('owner');
    expect(res.body).not.toHaveProperty('owner_customer_id');
  });

  it('nenhum valor: custo, peça ou serviço', async () => {
    const eq = await equipamento();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    const corpo = JSON.stringify(res.body);
    for (const proibido of ['cost', 'price', 'cents', 'total', 'valor']) {
      expect(corpo.toLowerCase()).not.toContain(proibido);
    }
  });

  it('não vaza o identificador interno do equipamento', async () => {
    const eq = await equipamento();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    expect(JSON.stringify(res.body)).not.toContain(eq.id);
  });
});

describe('andamento em linguagem de cliente', () => {
  async function comOrdem() {
    const eq = await equipamento();
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(auth)
      .send({
        workshopId,
        equipmentId: eq.id,
        title: 'Revisão',
        description: 'Não liga',
        customerId: clienteId,
      });
    return { eq, orderId: os.body.id as string };
  }

  it('mostra que está em serviço e desde quando', async () => {
    const { eq } = await comOrdem();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);

    expect(res.body.inService).toBe(true);
    expect(res.body.timeline.length).toBeGreaterThan(0);
    expect(res.body.timeline[0].step).toBe('Recebido pela oficina');
  });

  it('traduz o estado interno em etapa que o cliente entende', async () => {
    const { eq } = await comOrdem();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    // "em_aberto" não diz nada para quem está esperando a moto.
    expect(JSON.stringify(res.body)).not.toContain('em_aberto');
    expect(res.body.status).toBeTruthy();
  });

  it('não repete a mesma etapa em seguida', async () => {
    const { eq } = await comOrdem();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);

    // A OS nasce em aberto e o primeiro evento costuma registrar o mesmo
    // estado. Para dentro isso é histórico; para o cliente vira "Recebido pela
    // oficina" duas vezes, e ele fica procurando a diferença entre as duas.
    const passos = res.body.timeline.map((t: { step: string }) => t.step);
    for (let i = 1; i < passos.length; i += 1) {
      expect(passos[i]).not.toBe(passos[i - 1]);
    }
  });

  it('sem ordem de serviço, não inventa andamento', async () => {
    const eq = await equipamento();
    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    // Equipamento cadastrado e nunca atendido: dizer "em serviço" seria mentira.
    expect(res.body.inService).toBe(false);
    expect(res.body.status).toBeNull();
    expect(res.body.timeline).toEqual([]);
  });
});

/**
 * A LINHA DO TEMPO NÃO PODE TER BURACO.
 *
 * Estado sem rótulo público SOME da linha — a regra existe para o nome interno
 * nunca vazar, e está certa. O efeito colateral é que qualquer estado esquecido
 * no mapa vira uma etapa invisível, e ninguém percebe: a resposta continua
 * válida, só que incompleta.
 *
 * Foi o que aconteceu duas vezes.
 */
describe('nenhuma etapa some da plaquinha', () => {
  /** Mesmo cenário do bloco acima: equipamento com uma OS aberta. */
  async function comOrdem() {
    const eq = await equipamento();
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(auth)
      .send({ workshopId, equipmentId: eq.id, customerId: clienteId, complaint: 'Nao liga' });
    return { eq, ordem: os.body.id as string };
  }

  /**
   * O caso que mais importa para o dono: a moto ficou PRONTA.
   *
   * `aguardando_pagamento` não estava no mapa, então o momento em que o
   * aparelho fica pronto era o único invisível — o cliente escaneava o QR e
   * continuava lendo "Em serviço" enquanto a moto esperava por ele no balcão.
   */
  it('pronto para retirada aparece para o cliente', async () => {
    const { eq, ordem } = await comOrdem();
    getConnection()
      .prepare(
        `INSERT INTO core_service_order_events
           (id, order_id, company_id, from_status, to_status, created_at)
         VALUES ('ev-pg', ?, ?, 'em_andamento', 'aguardando_pagamento', ?)`,
      )
      .run(ordem, companyId, new Date().toISOString());

    const res = await request(app).get(`/api/v1/loja/equipamento/${eq.token}`);
    const passos = res.body.timeline.map((t: { step: string }) => t.step);
    expect(passos).toContain('Pronto para retirada');
  });

  /**
   * O guarda estrutural: todo estado que a OS pode assumir tem rótulo.
   *
   * É este caso que teria evitado as duas ausências. Sem ele, acrescentar um
   * estado novo à máquina de estados deixa a plaquinha muda sobre ele, e o
   * defeito só aparece quando um cliente reclama.
   */
  /**
   * O GUARDA ESTRUTURAL, e a razão de ele ser assim.
   *
   * A primeira versão deste caso montava um evento por estado e conferia que
   * a linha do tempo tinha texto. Isso não falha nunca: basta UM passo com
   * texto para o laço inteiro passar, e o estado esquecido continua sumindo em
   * silêncio. Escrevi de novo um teste que não consegue falhar.
   *
   * O que precisa ser cobrado é direto: todo estado que a máquina de estados
   * pode assumir TEM rótulo. Comparar os dois conjuntos é a asserção honesta —
   * e falha no dia em que alguém acrescentar um estado sem lembrar da
   * plaquinha, que é exatamente como as duas ausências entraram.
   */
  it('todo estado da OS tem rótulo público, e nenhum rótulo sobra', async () => {
    const { ORDER_STATUSES } = await import('../src/services/core/WorkshopCoreService.js');
    const { ETAPA_PUBLICA } = await import('../src/services/core/EquipmentPublicView.js');

    const semRotulo = ORDER_STATUSES.filter((e) => !ETAPA_PUBLICA[e]);
    expect(semRotulo.join(', ')).toBe('');

    // E o contrário: rótulo para estado que não existe é resquício de
    // vocabulário antigo — foi assim que "parada_setor" ficou no mapa sem
    // nunca ter existido nem no vocabulário velho nem no novo.
    const sobrando = Object.keys(ETAPA_PUBLICA).filter(
      (k) => !(ORDER_STATUSES as readonly string[]).includes(k),
    );
    expect(sobrando.join(', ')).toBe('');
  });
});
