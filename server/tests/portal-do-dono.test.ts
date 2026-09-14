/**
 * O dono, autenticado, vendo o que a plaquinha esconde.
 *
 * ## Duas portas, e a de fora não mudou
 *
 * A plaquinha continua pública e mínima. Esta é a outra porta: a conta do
 * portal — a mesma do e-commerce — passa a mostrar os aparelhos do dono, o
 * histórico completo e quanto custou cada serviço.
 *
 * ## O bloqueio que este arquivo existe para travar
 *
 * O convite NÃO pode passar pelo vínculo automático por e-mail. `syncLinks`
 * liga a conta a todo cadastro do GRUPO cujo e-mail ou documento casem, SEM
 * filtro de empresa — e o e-mail do convite é escolhido por quem resgata, sem
 * ninguém verificar. Pego o papel da Joana, registro com o e-mail da Maria, e
 * recebo os cadastros da Maria em todas as operações.
 *
 * O caso `o convite liga UM cadastro, e só ele` é o que impede isso de voltar.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { hashPassword } from '../src/services/auth/PasswordService.js';
import { confirmarEmail, loginCustomer } from '../src/services/core/CustomerPortalService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let oficina: { Authorization: string };
let companyId: string;
let workshopId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'ger-portal',
    companyId: 'empresa-portal',
    profileCodes: ['gerente_oficina'],
  });
  oficina = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  workshopId = 'wk-portal';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob', 'Oficina de Mobilidade', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());
});

/** Cliente de balcão: nome e telefone, sem e-mail — como a oficina cadastra. */
async function clienteDeBalcao(nome: string): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/customers')
    .set(oficina)
    .send({ name: nome, phone: '96988887777' });
  expect(r.status).toBeLessThan(300);
  return r.body.id as string;
}

async function equipamentoDe(customerId: string, modelo: string): Promise<string> {
  const r = await request(app).post('/api/v1/core/equipment').set(oficina).send({
    workshopId,
    brand: 'Shineray',
    model: modelo,
    origin: 'EXTERNAL_CUSTOMER',
    ownerCustomerId: customerId,
  });
  expect(r.status).toBeLessThan(300);
  return r.body.id as string;
}

function emitirConvite(customerId: string) {
  return request(app).post(`/api/v1/core/customers/${customerId}/convite-portal`).set(oficina);
}

/**
 * Registra pelo caminho ANTIGO: e-mail + documento no mesmo cadastro.
 *
 * Cria o cadastro correspondente antes, porque é essa a prova que o caminho
 * exige — e é justamente a prova que o cliente de balcão não tem.
 */
async function contaCom(
  email: string,
  documento: string,
  senha = 'Portal@2026',
  /*
    QUEM ESCREVEU O DOCUMENTO do cadastro que co-prova (GAP-PRD-006). O padrão
    é o balcão — gente da loja com a pessoa na frente —, que é o único
    documento que o portal propaga para as outras operações. 'loja_online' é
    o CPF digitado num checkout público, que não se propaga.
  */
  origem: 'balcao' | 'loja_online' = 'balcao',
): Promise<string> {
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      `c-${documento}`,
      companyId,
      `Cliente ${documento}`,
      documento,
      email,
      origem,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const r = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: documento, password: senha });
  expect(r.status).toBe(201);
  // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
  // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
  provarCaixa(r.body.account.id as string, email);
  return r.body.token as string;
}

/** Lê o código do e-mail enfileirado e confirma — o gesto do dono da caixa. */
function provarCaixa(accountId: string, email: string): void {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId, codigo });
}

/** Registra pelo CONVITE: é assim que o cliente de balcão entra. */
async function contaPorConvite(email: string, code: string, senha = 'Portal@2026'): Promise<string> {
  const r = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: senha, code });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

const P = (token: string) => ({ 'x-portal-token': token });

describe('o convite existe porque o dono não consegue criar conta sozinho', () => {
  /**
   * A razão de a rodada inteira precisar do convite: criar conta exige e-mail
   * E documento no cadastro, e o cliente de oficina é cadastrado com nome e
   * telefone. Sem o convite, o portal nasce inacessível para quem ele serve.
   */
  it('registrar sozinho NÃO liga a conta ao cadastro de balcão — o convite ainda é necessário', async () => {
    // A rodada 38 abriu o cadastro: a pessoa CRIA a conta com e-mail e senha.
    // Mas o cliente de balcão foi cadastrado com nome e telefone, SEM e-mail —
    // então não há co-prova (e-mail+documento no mesmo cadastro), e a conta
    // aberta não adota o cadastro dele. Os equipamentos continuam invisíveis
    // até o convite ligar o vínculo. É por isso que o convite existe.
    const joana = await clienteDeBalcao('Joana Proprietária');
    await equipamentoDe(joana, 'Attractive');

    const r = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'joana@exemplo.com', document: '55566677788', password: 'Portal@2026' });
    expect(r.status).toBe(201);

    // A conta existe, mas está vazia: o equipamento do balcão não veio junto.
    const equipamentos = await request(app)
      .get('/api/v1/loja/portal/equipamentos')
      .set('x-portal-token', r.body.token);
    expect(equipamentos.status).toBe(200);
    expect(equipamentos.body.items).toEqual([]);
  });

  it('a oficina emite o código, e ele sai uma vez só', async () => {
    const joana = await clienteDeBalcao('Joana Proprietária');
    const r = await emitirConvite(joana);

    expect(r.status).toBe(201);
    expect(String(r.body.code)).toMatch(/^[A-Z2-9]{10}$/);
    expect(r.body.customerName).toBe('Joana Proprietária');

    // No banco fica só o hash: é credencial, e aqui também há CPF guardado.
    const linha = getConnection()
      .prepare('SELECT portal_invite_hash FROM core_customers WHERE id = ?')
      .get(joana) as { portal_invite_hash: string };
    expect(linha.portal_invite_hash).not.toBe(r.body.code);
    expect(linha.portal_invite_hash).toHaveLength(64);
  });

  it('o código não entra na auditoria', async () => {
    const joana = await clienteDeBalcao('Joana');
    const r = await emitirConvite(joana);
    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'customer.portal_invite'")
      .all() as unknown as { detail: string }[];
    expect(JSON.stringify(auditoria)).not.toContain(r.body.code);
  });
});

describe('o convite liga UM cadastro, e só ele', () => {
  /**
   * O BLOQUEIO. Sem esta separação, quem resgata escolhe o e-mail e `syncLinks`
   * o transforma em chave para qualquer cadastro do grupo que use aquele
   * e-mail — inclusive de outra empresa.
   */
  it('resgatar com o e-mail de terceiro NÃO alcança o cadastro dele', async () => {
    // Maria comprou no site: cadastro com e-mail e documento.
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
         VALUES ('c-maria', ?, 'Maria Compradora', '11122233344', 'maria@exemplo.com', 1, ?, ?)`,
      )
      .run(companyId, new Date().toISOString(), new Date().toISOString());

    // Joana levou a moto: cadastro de balcão, e um convite no papel.
    const joana = await clienteDeBalcao('Joana Proprietária');
    const convite = await emitirConvite(joana);

    // Quem está com o papel registra PELO CONVITE, usando o e-mail da MARIA.
    // É o cenário que o desenho original permitia: e-mail escolhido por quem
    // resgata, sem ninguém verificar.
    const token = await contaPorConvite('maria@exemplo.com', convite.body.code);

    // A conta recebeu o cadastro da JOANA — e nenhum outro.
    const vinculos = getConnection()
      .prepare(
        `SELECT customer_id FROM core_customer_account_links
          WHERE account_id = (SELECT account_id FROM core_customer_sessions WHERE id = ?)`,
      )
      .all(token) as unknown as { customer_id: string }[];

    expect(vinculos.map((v) => v.customer_id)).toContain(joana);
    expect(vinculos.map((v) => v.customer_id)).not.toContain('c-maria');
  });

  /** E o cadastro fiscal da Joana não é reescrito com o e-mail de quem resgatou. */
  it('resgatar não escreve e-mail no cadastro do cliente', async () => {
    const joana = await clienteDeBalcao('Joana Proprietária');
    const convite = await emitirConvite(joana);
    const token = await contaCom('quemquerque@exemplo.com', '99988877766');
    await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .set(P(token))
      .send({ code: convite.body.code });

    const linha = getConnection()
      .prepare('SELECT email FROM core_customers WHERE id = ?')
      .get(joana) as { email: string | null };
    expect(linha.email).toBeNull();
  });

  /**
   * O cenário que o desenho original deixava sem saída: o dono já tem conta
   * do e-commerce, e na oficina é outro cadastro. Registrar recusaria com
   * "já existe acesso para este e-mail", e o código viraria papel morto.
   */
  it('quem JÁ tem conta consegue resgatar', async () => {
    const token = await contaCom('ja.tenho@exemplo.com', '12312312312');
    const joana = await clienteDeBalcao('Joana Proprietária');
    const convite = await emitirConvite(joana);

    const r = await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .set(P(token))
      .send({ code: convite.body.code });
    expect(r.status).toBe(200);
    expect(r.body.customerName).toBe('Joana Proprietária');
  });

  it('o mesmo código não vale duas vezes', async () => {
    const joana = await clienteDeBalcao('Joana');
    const convite = await emitirConvite(joana);
    const a = await contaCom('a@exemplo.com', '11111111111');
    const b = await contaCom('b@exemplo.com', '22222222222');

    await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .set(P(a))
      .send({ code: convite.body.code });
    const segunda = await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .set(P(b))
      .send({ code: convite.body.code });

    expect(segunda.status).toBe(400);
  });

  it('código inventado é recusado', async () => {
    const token = await contaCom('c@exemplo.com', '33333333333');
    const r = await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .set(P(token))
      .send({ code: 'ZZZZZZZZZZ' });
    expect(r.status).toBe(400);
  });

  it('sem sessão de portal, não resgata', async () => {
    const joana = await clienteDeBalcao('Joana');
    const convite = await emitirConvite(joana);
    const r = await request(app)
      .post('/api/v1/loja/portal/convite/resgatar')
      .send({ code: convite.body.code });
    expect(r.status).toBe(401);
  });
});

describe('o que o dono passa a ver', () => {
  async function donoComMoto() {
    const joana = await clienteDeBalcao('Joana Proprietária');
    const moto = await equipamentoDe(joana, 'Patinete X');
    const convite = await emitirConvite(joana);
    // O caminho REAL do cliente de oficina: ele não tem e-mail no cadastro.
    const token = await contaPorConvite('joana@exemplo.com', convite.body.code);
    return { joana, moto, token };
  }

  it('lista os aparelhos dele', async () => {
    const { token } = await donoComMoto();
    const r = await request(app).get('/api/v1/loja/portal/equipamentos').set(P(token));

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].model).toBe('Patinete X');
    expect(r.body.items[0].publicIdLabel).toMatch(/^#\d{4}$/);
  });

  /** É o que a plaquinha esconde de propósito, e o que o dono tem direito de ver. */
  it('o histórico traz o valor de cada serviço', async () => {
    const { joana, moto, token } = await donoComMoto();
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficina)
      .send({ workshopId, equipmentId: moto, customerId: joana, complaint: 'Não liga' });
    getConnection()
      .prepare('UPDATE core_service_orders SET labor_cents = 9000, total_cents = 9000 WHERE id = ?')
      .run(os.body.id);

    const r = await request(app).get(`/api/v1/loja/portal/equipamentos/${moto}`).set(P(token));
    expect(r.status).toBe(200);
    expect(r.body.ordens).toHaveLength(1);
    expect(r.body.ordens[0].totalCents).toBe(9000);
    expect(r.body.ordens[0].complaint).toBe('Não liga');
  });

  /**
   * A moto usada trocou de mãos. `assignOwner` sobrescreve o dono sem recriar
   * registro, então as queixas do dono ANTERIOR — que são as palavras dele —
   * continuam presas àquele chassi.
   */
  it('o dono novo NÃO lê a ordem do dono anterior', async () => {
    const antigo = await clienteDeBalcao('Dono Antigo');
    const moto = await equipamentoDe(antigo, 'CG 160');
    await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficina)
      .send({ workshopId, equipmentId: moto, customerId: antigo, complaint: 'segredo do antigo' });

    // Transferência de propriedade.
    const novo = await clienteDeBalcao('Dono Novo');
    getConnection()
      .prepare('UPDATE core_equipment SET owner_customer_id = ? WHERE id = ?')
      .run(novo, moto);

    const convite = await emitirConvite(novo);
    const token = await contaPorConvite('novo@exemplo.com', convite.body.code);

    const r = await request(app).get(`/api/v1/loja/portal/equipamentos/${moto}`).set(P(token));
    expect(r.status).toBe(200);
    expect(r.body.ordens).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain('segredo do antigo');
  });

  it('aparelho de outro dono responde 404, não 403', async () => {
    const alheio = await clienteDeBalcao('Outro Dono');
    const motoAlheia = await equipamentoDe(alheio, 'Bike');
    const { token } = await donoComMoto();

    // 403 confirmaria que o id existe. 404 não conta nada.
    const r = await request(app)
      .get(`/api/v1/loja/portal/equipamentos/${motoAlheia}`)
      .set(P(token));
    expect(r.status).toBe(404);
  });

  it('conta sem vínculo nenhum responde vazio, e não 500', async () => {
    // `IN ()` é erro de sintaxe no SQLite: sem a guarda, isto viraria 500.
    const token = await contaCom('sozinho@exemplo.com', '77788899900');
    const lista = await request(app).get('/api/v1/loja/portal/equipamentos').set(P(token));
    expect(lista.status).toBe(200);
    expect(lista.body.items).toEqual([]);

    const ficha = await request(app)
      .get('/api/v1/loja/portal/equipamentos/qualquer-id')
      .set(P(token));
    expect(ficha.status).toBe(404);
  });

  it('sem sessão, nada responde', async () => {
    const r = await request(app).get('/api/v1/loja/portal/equipamentos');
    expect(r.status).toBe(401);
  });
});

describe('o chamado — que não é uma OS', () => {
  async function donoComMoto() {
    const joana = await clienteDeBalcao('Joana');
    const moto = await equipamentoDe(joana, 'Patinete X');
    const convite = await emitirConvite(joana);
    // O caminho REAL do cliente de oficina: ele não tem e-mail no cadastro.
    const token = await contaPorConvite('joana@exemplo.com', convite.body.code);
    return { joana, moto, token };
  }

  it('o dono abre chamado e ele NÃO vira OS sozinho', async () => {
    const { moto, token } = await donoComMoto();
    const r = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'Freio raspando' });

    expect(r.status).toBe(201);
    // A moto está na garagem: nenhuma OS pode ter nascido.
    const os = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_service_orders')
      .get() as { n: number };
    expect(os.n).toBe(0);
  });

  it('a oficina vê o chamado na fila', async () => {
    const { moto, token } = await donoComMoto();
    await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'Freio raspando' });

    const fila = await request(app).get('/api/v1/core/workshop/chamados').set(oficina);
    expect(fila.status).toBe(200);
    expect(fila.body.items).toHaveLength(1);
    expect(fila.body.items[0].customer_name).toBe('Joana');
  });

  /** A conversão é o que dá ESCRITOR ao `opened_by_customer`. */
  it('converter cria a OS marcada como aberta pelo cliente', async () => {
    const { moto, token } = await donoComMoto();
    const chamado = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'Freio raspando' });

    const r = await request(app)
      .post(`/api/v1/core/workshop/chamados/${chamado.body.id}/converter`)
      .set(oficina);
    expect(r.status).toBe(200);

    const os = getConnection()
      .prepare('SELECT opened_by_customer, complaint, equipment_id FROM core_service_orders WHERE id = ?')
      .get(r.body.orderId) as Record<string, unknown>;
    expect(os.opened_by_customer).toBe(1);
    expect(os.complaint).toBe('Freio raspando');
    expect(os.equipment_id).toBe(moto);
  });

  /** O mecânico converte: na bancada é ele quem recebe a moto. */
  it('o mecânico consegue converter', async () => {
    const { moto, token } = await donoComMoto();
    const chamado = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'Freio raspando' });

    const mec = await loginForTest(app, {
      userId: 'mec-portal',
      companyId: 'empresa-portal',
      profileCodes: ['mecanico'],
    });
    const r = await request(app)
      .post(`/api/v1/core/workshop/chamados/${chamado.body.id}/converter`)
      .set({ Authorization: `Bearer ${mec.body.accessToken}` });
    expect(r.status).toBe(200);
  });

  /**
   * Aparelho já na bancada não precisa de chamado — mas `aguardando_pagamento`
   * NÃO conta como "está aqui": a moto já foi entregue e a OS só sai daquele
   * estado quando alguém dá baixa. Tratá-la como em serviço trancaria o dono
   * para fora por semanas.
   */
  it('aparelho em serviço recusa chamado novo', async () => {
    const { joana, moto, token } = await donoComMoto();
    await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficina)
      .send({ workshopId, equipmentId: moto, customerId: joana, complaint: 'já está aqui' });

    const r = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'outro problema' });
    expect(r.status).toBe(409);
  });

  it('mas OS esperando pagamento NÃO tranca o dono', async () => {
    const { joana, moto, token } = await donoComMoto();
    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficina)
      .send({ workshopId, equipmentId: moto, customerId: joana, complaint: 'serviço antigo' });
    getConnection()
      .prepare("UPDATE core_service_orders SET status = 'aguardando_pagamento' WHERE id = ?")
      .run(os.body.id);

    const r = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'problema novo' });
    expect(r.status).toBe(201);
  });

  /**
   * O freio conta por JANELA, e não por quantos estão abertos: cancelar zeraria
   * um contador por status, e o laço abrir→cancelar→abrir rodaria sem limite.
   */
  it('cancelar e reabrir não escapa do limite diário', async () => {
    const { moto, token } = await donoComMoto();
    for (let i = 0; i < 10; i += 1) {
      const c = await request(app)
        .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
        .set(P(token))
        .send({ description: `pedido ${i}` });
      expect(c.status).toBe(201);
      await request(app)
        .post(`/api/v1/loja/portal/chamados/${c.body.id}/cancelar`)
        .set(P(token));
    }

    const excedente = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'passou do teto' });
    expect(excedente.status).toBe(429);
  });

  it('o dono não abre chamado para aparelho alheio', async () => {
    const alheio = await clienteDeBalcao('Outro');
    const motoAlheia = await equipamentoDe(alheio, 'Bike');
    const { token } = await donoComMoto();

    const r = await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${motoAlheia}/chamados`)
      .set(P(token))
      .send({ description: 'não é minha' });
    expect(r.status).toBe(404);
  });

  it('uma conta não lê o chamado da outra', async () => {
    const { moto, token } = await donoComMoto();
    await request(app)
      .post(`/api/v1/loja/portal/equipamentos/${moto}/chamados`)
      .set(P(token))
      .send({ description: 'meu chamado' });

    const outra = await contaCom('outra@exemplo.com', '88899900011');
    const r = await request(app).get('/api/v1/loja/portal/chamados').set(P(outra));
    expect(r.body.items).toEqual([]);
  });
});

/**
 * O VAZAMENTO QUE JÁ EXISTIA, e que este arquivo encontrou de passagem.
 *
 * `syncLinks` recalcula, a cada login, os cadastros que a conta representa. A
 * regra era `email = ? OR document = ?`, sem filtro de empresa.
 *
 * O registro exige e-mail E documento no MESMO cadastro — parece prova
 * suficiente, e não é: nada impede que esse cadastro seja o MEU com o e-mail de
 * outra pessoa. Basta informá-lo numa compra de balcão. Aí o `OR` casava o
 * cadastro DELA, em qualquer operação do grupo, e eu passava a ler o histórico
 * de compras dela.
 *
 * Quem é a mesma pessoa em duas operações tem o mesmo DOCUMENTO. É ele que
 * identifica; o e-mail só responde quando não há documento para comparar.
 */
describe('o vínculo entre contas segue o documento, não o e-mail', () => {
  it('meu cadastro com o e-mail de outra pessoa NÃO me dá o cadastro dela', async () => {
    const agora = new Date().toISOString();
    // Maria comprou no site da Gringa.
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
         VALUES ('c-maria-2', ?, 'Maria', '11122233344', 'maria@exemplo.com', 1, ?, ?)`,
      )
      .run(companyId, agora, agora);

    // Eu compro no balcão e informo o e-mail DELA com o MEU documento.
    const meuToken = await contaCom('maria@exemplo.com', '99988877766');

    const vinculos = getConnection()
      .prepare(
        `SELECT customer_id FROM core_customer_account_links
          WHERE account_id = (SELECT account_id FROM core_customer_sessions WHERE id = ?)`,
      )
      .all(meuToken) as unknown as { customer_id: string }[];

    expect(vinculos.map((v) => v.customer_id)).not.toContain('c-maria-2');
  });

  /** E o que a regra existe para servir continua servindo. */
  it('o mesmo documento em duas operações continua sendo a mesma pessoa', async () => {
    const agora = new Date().toISOString();
    const outra = getConnection()
      .prepare(
        `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
         VALUES ('emp-2', 'emp-2', 'Outra Ltda', 'Outra', 1, ?, ?)`,
      )
      .run(agora, agora);
    void outra;
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
         VALUES ('c-outra-op', 'emp-2', 'Joao', '12345678909', 'joao@exemplo.com', 1, ?, ?)`,
      )
      .run(agora, agora);

    const token = await contaCom('joao@exemplo.com', '12345678909');
    const vinculos = getConnection()
      .prepare(
        `SELECT customer_id FROM core_customer_account_links
          WHERE account_id = (SELECT account_id FROM core_customer_sessions WHERE id = ?)`,
      )
      .all(token) as unknown as { customer_id: string }[];

    expect(vinculos.map((v) => v.customer_id)).toContain('c-outra-op');
  });
});

/**
 * O LOGIN TAMBÉM SEGUE O DOCUMENTO — e de onde ele vem é o assunto inteiro.
 *
 * `core_customer_accounts` guarda e-mail e senha, e nunca guardou documento.
 * Por isso o login chamava `syncLinks` com documento nulo e caía SEMPRE no ramo
 * do e-mail — o ramo que o comentário de lá chama de último recurso. O efeito
 * era o inverso do que o desenho promete: quem compra no balcão sem e-mail no
 * cadastro nunca era alcançado, e o portal ficava vazio para quem acabou de
 * comprar.
 *
 * Agora o documento é DESCOBERTO: sai dos cadastros JÁ VINCULADOS à conta —
 * documento que o sistema já aceitou como sendo desta pessoa, e não algo que
 * quem entra digita. É essa a diferença para o vazamento acima, e é ela que os
 * dois primeiros casos daqui cobram, um de cada lado.
 */
describe('o login alcança o documento pelos vínculos que a conta já tem', () => {
  /**
   * Uma segunda operação do grupo.
   *
   * O mesmo documento não se repete DENTRO da empresa — a chave única do
   * cadastro impede —, e é o que dá sentido ao vínculo: a pessoa é uma, os
   * cadastros são um por operação.
   */
  function outraOperacao(id: string): string {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, id, `${id} Ltda`, id, agora, agora);
    return id;
  }

  /** Um cadastro qualquer, escrito direto: aqui o assunto é o vínculo, não a rota. */
  function cadastro(
    id: string,
    campos: { document?: string | null; email?: string | null; companyId?: string },
  ): string {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        campos.companyId ?? companyId,
        `Cadastro ${id}`,
        campos.document ?? null,
        campos.email ?? null,
        agora,
        agora,
      );
    return id;
  }

  function vinculosDe(token: string): string[] {
    return (
      getConnection()
        .prepare(
          `SELECT customer_id FROM core_customer_account_links
            WHERE account_id = (SELECT account_id FROM core_customer_sessions WHERE id = ?)`,
        )
        .all(token) as unknown as { customer_id: string }[]
    ).map((v) => v.customer_id);
  }

  /**
   * O CASO QUE ESTAVA QUEBRADO. O cadastro do balcão não tem e-mail — é assim
   * que a oficina cadastra —, e com o ramo do e-mail ele nunca era alcançado.
   */
  it('cadastro sem e-mail e com o MEU documento entra no login seguinte', async () => {
    const token = await contaCom('eu@exemplo.com', '11122233344');
    // A compra de balcão que aconteceu DEPOIS de a conta existir, em OUTRA
    // operação do grupo — que é onde a oficina cadastra o dono da moto.
    const balcao = cadastro('c-balcao', {
      companyId: outraOperacao('emp-balcao'),
      document: '11122233344',
      email: null,
    });
    expect(vinculosDe(token)).not.toContain(balcao);

    const sessao = await loginCustomer({ email: 'eu@exemplo.com', password: 'Portal@2026' });
    expect(sessao.customers.map((c) => c.customerId)).toContain(balcao);
  });

  /**
   * O MESMO CASO, COM O DOCUMENTO DIGITADO NUM CHECKOUT (GAP-PRD-006).
   *
   * Se o cadastro que co-prova foi criado pela loja online, o CPF dele foi
   * digitado por quem comprou — e quem digita o CPF de outra pessoa com o
   * próprio e-mail co-prova esse cadastro de verdade. Propagar esse documento
   * entregava a quem digitou o cadastro de balcão da vítima, em outra
   * operação. O cadastro de balcão sem e-mail fica de fora; quem é o dono
   * dele entra pelo convite.
   */
  it('documento que veio de um checkout público NÃO alcança o cadastro de balcão de outra operação', async () => {
    const token = await contaCom('eu@exemplo.com', '11122233344', 'Portal@2026', 'loja_online');
    const balcao = cadastro('c-balcao', {
      companyId: outraOperacao('emp-balcao'),
      document: '11122233344',
      email: null,
    });

    const sessao = await loginCustomer({ email: 'eu@exemplo.com', password: 'Portal@2026' });

    expect(sessao.customers.map((c) => c.customerId)).not.toContain(balcao);
    expect(vinculosDe(token)).not.toContain(balcao);
    // E o cadastro que ela co-provou continua dela — senão o teste passaria
    // por não ligar nada a ninguém.
    expect(sessao.customers.map((c) => c.customerId)).toContain('c-11122233344');
  });

  /**
   * A PROVA DE QUE O VAZAMENTO DA RODADA 17 NÃO VOLTOU.
   *
   * Alcançar documento não pode transformar o e-mail em chave: o cadastro de
   * OUTRA pessoa que carrega o meu e-mail e não tem documento continua fora.
   */
  it('cadastro de terceiro com o meu e-mail e sem documento fica de fora', async () => {
    const token = await contaCom('eu@exemplo.com', '11122233344');
    const alheio = cadastro('c-alheio', { document: null, email: 'eu@exemplo.com' });

    const sessao = await loginCustomer({ email: 'eu@exemplo.com', password: 'Portal@2026' });

    expect(sessao.customers.map((c) => c.customerId)).not.toContain(alheio);
    expect(vinculosDe(token)).not.toContain(alheio);
    // E o que é meu de verdade continua lá — senão o teste passaria por não
    // ligar nada a ninguém.
    expect(sessao.customers.map((c) => c.customerId)).toContain('c-11122233344');
  });

  /**
   * O ÚLTIMO RECURSO NÃO PODE SUMIR.
   *
   * Conta antiga — criada antes de o registro exigir documento — não alcança
   * documento nenhum. Se o ramo do e-mail desaparecesse, quem já usa o portal
   * perderia o acesso ao próprio histórico no primeiro login depois do deploy.
   */
  it('conta VERIFICADA que só alcança e-mail casa por e-mail — provada a caixa', async () => {
    // Rodada 50: o ramo do e-mail só vale com a caixa provada. A dona
    // legítima (email_verified_at preenchido) segue casando pelo endereço; o
    // caso do e-mail NÃO verificado que NÃO casa mora em cadastro-por-email.
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_customer_accounts (id, email, password_hash, email_verified_at, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(randomUUID(), 'antiga@exemplo.com', await hashPassword('Portal@2026'), agora, agora, agora);
    const meu = cadastro('c-antigo', { document: null, email: 'antiga@exemplo.com' });

    const sessao = await loginCustomer({ email: 'antiga@exemplo.com', password: 'Portal@2026' });
    expect(sessao.customers.map((c) => c.customerId)).toContain(meu);
  });

  /**
   * O FURO QUE SOBROU, E QUE SÓ APARECE NO SEGUNDO LOGIN.
   *
   * A conta do convite nasce ligada a UM cadastro de balcão — nome e telefone,
   * sem CPF, que é como a oficina cadastra. Não alcançando documento nenhum,
   * ela cai no ramo do e-mail em toda entrada; e enquanto esse ramo aceitava
   * qualquer cadastro com aquele endereço, ela adotava o de OUTRA pessoa —
   * justamente o cadastro COM documento, que é o completo, o que tem histórico.
   *
   * `registerWithInvite` não chama `syncLinks` de propósito, então o resgate
   * parecia seguro e o estrago só chegava na entrada seguinte. Por isso o teste
   * loga DUAS vezes: uma asserção no instante do resgate não veria nada.
   */
  it('a conta do convite não adota, no login seguinte, o cadastro alheio que tem documento', async () => {
    const balcao = await clienteDeBalcao('Joana do Balcão');
    const convite = await emitirConvite(balcao);
    expect(convite.status).toBe(201);

    // A outra pessoa: mesmo e-mail informado num balcão qualquer, e um CPF
    // próprio. É ela que o ramo do e-mail alcançava.
    const alheio = cadastro('c-maria', { document: '99988877766', email: 'joana@exemplo.com' });

    const token = await contaPorConvite('joana@exemplo.com', convite.body.code as string);
    expect(vinculosDe(token)).not.toContain(alheio);

    const sessao = await loginCustomer({ email: 'joana@exemplo.com', password: 'Portal@2026' });

    expect(sessao.customers.map((c) => c.customerId)).not.toContain(alheio);
    // E o convite continua entregando o que prometeu — senão o caso passaria
    // por não ligar coisa nenhuma.
    expect(sessao.customers.map((c) => c.customerId)).toContain(balcao);
  });

  /**
   * DOCUMENTO EM BRANCO NÃO É DOCUMENTO.
   *
   * O filtro que descarta `''` na descoberta parece detalhe e decide duas
   * coisas: sem ele a string vazia entraria no conjunto, `docs.length` viraria
   * 1, e a conta perderia o ramo do e-mail em silêncio — além de
   * `document IN ('')` casar todo cadastro de documento vazio do grupo, que
   * são pessoas diferentes.
   */
  it('cadastro vinculado com documento em branco não vira chave nem desliga o e-mail', async () => {
    const agora = new Date().toISOString();
    const contaId = randomUUID();
    // Verificada (rodada 50): o ramo do e-mail só casa com a caixa provada.
    getConnection()
      .prepare(
        `INSERT INTO core_customer_accounts (id, email, password_hash, email_verified_at, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(contaId, 'branco@exemplo.com', await hashPassword('Portal@2026'), agora, agora, agora);

    const vazio = cadastro('c-vazio', { document: '', email: 'branco@exemplo.com' });
    getConnection()
      .prepare(
        `INSERT INTO core_customer_account_links (id, account_id, customer_id, company_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), contaId, vazio, companyId, agora);

    // Outra pessoa, também com documento em branco, em outra operação.
    const outro = cadastro('c-vazio-alheio', {
      companyId: outraOperacao('emp-branco'),
      document: '',
      email: 'terceiro@exemplo.com',
    });
    // E o meu, que só o e-mail alcança.
    const meu = cadastro('c-meu-branco', { document: null, email: 'branco@exemplo.com' });

    const sessao = await loginCustomer({ email: 'branco@exemplo.com', password: 'Portal@2026' });
    const ids = sessao.customers.map((c) => c.customerId);

    expect(ids).toContain(meu);
    expect(ids).not.toContain(outro);
  });
});
