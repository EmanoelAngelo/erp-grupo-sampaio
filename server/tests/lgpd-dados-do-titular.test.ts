/**
 * ============================================================================
 * LGPD — O CLIENTE VISTO PELO PERFIL, E OS DIREITOS DO TITULAR (GAP-PRD-073)
 * ============================================================================
 *
 * A auditoria logou como mecânico e como estoquista e recebeu de
 * `GET /core/customers` o `SELECT *` inteiro: CPF, e-mail, telefone, endereço,
 * observações e ainda o `portal_invite_hash` — a credencial do convite do
 * portal. E não havia caminho nenhum para atender um pedido de titular
 * (exportar, anonimizar) sem SQL do desenvolvedor.
 *
 * Este arquivo cobra as três metades da correção:
 *
 *   1. PROJEÇÃO POR PERFIL. A rota continua aberta aos três ambientes (o PDV
 *      vincula cliente à venda e a bancada acha o dono do aparelho — ver
 *      `rotas-abertura-declarada.test.ts`), mas quem não atende o cadastro vê
 *      o nome e só os últimos dígitos do telefone e do documento. O hash do
 *      convite não sai para ninguém, nem para a gerência.
 *   2. EXPORTAÇÃO do titular (art. 18, II e V): tudo o que a operação guarda
 *      da pessoa, num documento só, com trilha.
 *   3. ANONIMIZAÇÃO (art. 18, IV e VI) mantendo o histórico fiscal: a linha
 *      fica — a venda antiga continua apontando para ela —, os dados de
 *      contato somem, inclusive das cópias que a sincronização guardou. Com
 *      pendência (vale, título em aberto, OS na bancada) ela é recusada com a
 *      lista do que falta resolver.
 *
 * E a retenção declarada: o que o sistema guarda, por quanto tempo, e a trilha
 * de auditoria podada no prazo que a declaração diz.
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
import { podarTrilhaDeAuditoria } from '../src/services/audit/RetencaoDaAuditoria.js';

const app = createApp();
const LOJA = 'gringa';
const VIZINHA = 'preco-justo';

type Cabecalho = { Authorization: string };

async function entrar(perfil: string, empresa = LOJA): Promise<Cabecalho> {
  const res = await loginForTest(app, {
    userId: `u-${perfil}-${empresa}`,
    companyId: empresa,
    profileCodes: [perfil],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

const CPF = '39053344705';
const HASH_DO_CONVITE = 'f'.repeat(64);
const SENHA_DO_PORTAL = 'argon2id$hash-da-senha-do-portal';

/** O que não pode aparecer para quem não atende o cadastro. */
const DADOS_DE_CONTATO = [CPF, '99999-1234', 'maria@exemplo.com', 'Laranjeiras', 'látex'];

let gerente: Cabecalho;
let maria: string;

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente_loja');
  const res = await request(app).post('/api/v1/core/customers').set(gerente).send({
    name: 'Maria Aparecida',
    document: '390.533.447-05',
    phone: '(96) 99999-1234',
    email: 'maria@exemplo.com',
    address: 'Rua das Laranjeiras, 10',
    notes: 'Alérgica a látex',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  maria = String(res.body.id);
  // O convite do portal do jeito que `emitirConvitePortal` o deixa gravado:
  // só o hash, com prazo.
  getConnection()
    .prepare('UPDATE core_customers SET portal_invite_hash = ?, portal_invite_expires_at = ? WHERE id = ?')
    .run(HASH_DO_CONVITE, new Date(Date.now() + 86_400_000).toISOString(), maria);
});

function semSegredoDoConvite(corpo: unknown): void {
  const texto = JSON.stringify(corpo);
  expect(texto).not.toContain('portal_invite');
  expect(texto).not.toContain(HASH_DO_CONVITE);
}

const agora = () => new Date().toISOString();

function contatoComercial(companyId: string, customerId: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_leads (id, company_id, name, phone, email, document, notes, customer_id, status, created_at, updated_at)
       VALUES (?, ?, 'Maria A.', '96999991234', 'maria@exemplo.com', ?, 'veio pelo Instagram', ?, 'convertido', ?, ?)`,
    )
    .run(id, companyId, CPF, customerId, agora(), agora());
  return id;
}

function ordemDeServico(companyId: string, customerId: string, status: string): string {
  const id = randomUUID();
  const numero = Math.floor(Math.random() * 1_000_000);
  getConnection()
    .prepare(
      `INSERT INTO core_service_orders (id, company_id, number, customer_id, customer_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Maria Aparecida', ?, ?, ?)`,
    )
    .run(id, companyId, numero, customerId, status, agora(), agora());
  return id;
}

function titulo(companyId: string, customerId: string, status: 'open' | 'settled'): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents, customer_id, description, origin_type, origin_id, created_at)
       VALUES (?, ?, 'in', 10000, ?, ?, ?, 'Venda a prazo', 'sale', ?, ?)`,
    )
    .run(id, companyId, status, status === 'settled' ? 10000 : 0, customerId, randomUUID(), agora());
  return id;
}

function valeDeLoja(companyId: string, customerId: string, centavos: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_customer_credits (id, company_id, customer_id, kind, amount_cents, origin_type, origin_id, description, created_at)
       VALUES (?, ?, ?, 'concessao', ?, 'return', ?, 'Devolução em crédito', ?)`,
    )
    .run(randomUUID(), companyId, customerId, centavos, randomUUID(), agora());
}

function contaDoPortal(companyId: string, customerId: string): string {
  const conta = randomUUID();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_customer_accounts (id, email, password_hash, accepted_terms_at, created_at, updated_at)
     VALUES (?, 'maria@portal.com', ?, ?, ?, ?)`,
  ).run(conta, SENHA_DO_PORTAL, agora(), agora(), agora());
  db.prepare(
    `INSERT INTO core_customer_account_links (id, account_id, customer_id, company_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), conta, customerId, companyId, agora());
  return conta;
}

// ============================================================ projeção por perfil

describe('o que cada perfil lê de /core/customers', () => {
  it('o mecânico vê o nome e o final do telefone — sem CPF, e-mail, endereço nem observações', async () => {
    const mecanico = await entrar('mecanico');
    const res = await request(app).get('/api/v1/core/customers').set(mecanico);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const linha = (res.body.items as Record<string, unknown>[]).find((c) => c.id === maria)!;
    expect(linha.name).toBe('Maria Aparecida');
    expect(linha.phone).toBe('••• 1234');
    expect(linha.document).toBe('••• 4705');
    expect(linha.email).toBeNull();
    expect(linha.address).toBeNull();
    expect(linha.notes).toBeNull();
    expect(linha.dados_mascarados).toBe(true);
    for (const dado of DADOS_DE_CONTATO) expect(JSON.stringify(res.body)).not.toContain(dado);
    semSegredoDoConvite(res.body);
  });

  it('o estoquista também — na lista e na ficha', async () => {
    const estoquista = await entrar('estoquista');
    const lista = await request(app).get('/api/v1/core/customers').set(estoquista);
    const ficha = await request(app).get(`/api/v1/core/customers/${maria}`).set(estoquista);
    expect(lista.status).toBe(200);
    expect(ficha.status).toBe(200);
    expect(ficha.body.name).toBe('Maria Aparecida');
    expect(ficha.body.dados_mascarados).toBe(true);
    for (const corpo of [lista.body, ficha.body]) {
      for (const dado of DADOS_DE_CONTATO) expect(JSON.stringify(corpo)).not.toContain(dado);
      semSegredoDoConvite(corpo);
    }
  });

  it('a busca da bancada ainda acha pelo telefone inteiro — e devolve mascarado', async () => {
    const mecanico = await entrar('mecanico');
    const res = await request(app)
      .get(`/api/v1/core/customers?search=${encodeURIComponent('96999991234')}`)
      .set(mecanico);
    expect(res.status).toBe(200);
    const achados = res.body.items as Record<string, unknown>[];
    expect(achados.map((c) => c.id)).toContain(maria);
    expect(achados[0].phone).toBe('••• 1234');
    for (const dado of DADOS_DE_CONTATO) expect(JSON.stringify(res.body)).not.toContain(dado);
  });

  it('o caixa vê o contato inteiro — é ele quem cadastra, corrige e põe o CPF na nota', async () => {
    const caixa = await entrar('operador_caixa_loja');
    const res = await request(app).get('/api/v1/core/customers').set(caixa);
    expect(res.status).toBe(200);
    const linha = (res.body.items as Record<string, unknown>[]).find((c) => c.id === maria)!;
    expect(linha.document).toBe(CPF);
    expect(linha.phone).toBe('(96) 99999-1234');
    expect(linha.email).toBe('maria@exemplo.com');
    expect(linha.dados_mascarados).toBeUndefined();
    semSegredoDoConvite(res.body);
  });

  it('o atendente abre a ficha inteira, porque é quem a edita', async () => {
    const atendente = await entrar('atendente');
    const res = await request(app).get(`/api/v1/core/customers/${maria}`).set(atendente);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('Rua das Laranjeiras, 10');
    expect(res.body.notes).toBe('Alérgica a látex');
    semSegredoDoConvite(res.body);
  });

  it('o hash do convite do portal não sai para ninguém — nem para a gerência, nem na resposta da edição', async () => {
    const lista = await request(app).get('/api/v1/core/customers').set(gerente);
    const ficha = await request(app).get(`/api/v1/core/customers/${maria}`).set(gerente);
    const edicao = await request(app)
      .put(`/api/v1/core/customers/${maria}`)
      .set(gerente)
      .send({ phone: '(96) 98888-0000' });
    const tabela = await request(app)
      .put(`/api/v1/core/customers/${maria}/price-table`)
      .set(gerente)
      .send({ priceTableId: null });
    for (const res of [lista, ficha, edicao, tabela]) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      semSegredoDoConvite(res.body);
    }
    // O convite continua valendo: some da resposta, não do banco.
    const gravado = getConnection()
      .prepare('SELECT portal_invite_hash FROM core_customers WHERE id = ?')
      .get(maria) as { portal_invite_hash: string };
    expect(gravado.portal_invite_hash).toBe(HASH_DO_CONVITE);
  });
});

// ============================================================ exportação do titular

describe('exportar os dados do titular (art. 18, II e V)', () => {
  it('a gerência recebe tudo o que a operação guarda da pessoa, num documento, e fica na trilha', async () => {
    contatoComercial(LOJA, maria);
    valeDeLoja(LOJA, maria, 2500);
    contaDoPortal(LOJA, maria);

    const res = await request(app).get(`/api/v1/core/customers/${maria}/dados-do-titular`).set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.formato).toBe('devora.titular.v1');
    expect(res.body.titular.document).toBe(CPF);
    expect(res.body.titular.email).toBe('maria@exemplo.com');
    expect(res.body.titular.address).toBe('Rua das Laranjeiras, 10');

    const secoes = res.body.secoes as { chave: string; linhas: Record<string, unknown>[] }[];
    expect(secoes.map((s) => s.chave)).toEqual(
      expect.arrayContaining([
        'vendas',
        'ordens_de_servico',
        'credito_de_loja',
        'contatos_comerciais',
        'contas_do_portal',
        'trilha',
      ]),
    );
    expect(secoes.find((s) => s.chave === 'contatos_comerciais')!.linhas).toHaveLength(1);
    expect(secoes.find((s) => s.chave === 'credito_de_loja')!.linhas).toHaveLength(1);
    const portal = secoes.find((s) => s.chave === 'contas_do_portal')!;
    expect(portal.linhas[0].email).toBe('maria@portal.com');
    // A trilha diz o que foi feito com o cadastro — a criação, pelo menos.
    expect(secoes.find((s) => s.chave === 'trilha')!.linhas.map((l) => l.action)).toContain('customer.create');

    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain('password_hash');
    expect(texto).not.toContain(SENHA_DO_PORTAL);
    semSegredoDoConvite(res.body);
    expect((res.body.retencao as unknown[]).length).toBeGreaterThan(0);

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'customer.lgpd_export' AND entity_id = ?")
      .all(maria) as { detail: string | null }[];
    expect(trilha).toHaveLength(1);
    expect(String(trilha[0].detail)).not.toContain(CPF);
  });

  it('só a gerência exporta — atendente, caixa, mecânico e estoquista recebem 403', async () => {
    for (const perfil of ['atendente', 'operador_caixa_loja', 'mecanico', 'estoquista']) {
      const quem = await entrar(perfil);
      const res = await request(app).get(`/api/v1/core/customers/${maria}/dados-do-titular`).set(quem);
      expect(res.status, perfil).toBe(403);
    }
  });

  it('o titular da vizinha não existe para esta operação', async () => {
    const outra = await entrar('gerente_loja', VIZINHA);
    const res = await request(app).get(`/api/v1/core/customers/${maria}/dados-do-titular`).set(outra);
    expect(res.status).toBe(404);
  });
});

// ============================================================ anonimização

describe('anonimizar o titular (art. 18, IV e VI) mantendo o histórico', () => {
  const anonimizar = (quem: Cabecalho, corpo: Record<string, unknown>, id = maria) =>
    request(app).post(`/api/v1/core/customers/${id}/anonimizar`).set(quem).send(corpo);

  const MOTIVO = 'Pedido da titular por e-mail em 11/09/2026';

  it('sem motivo não anonimiza', async () => {
    const res = await anonimizar(gerente, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_TITULAR_MOTIVO_OBRIGATORIO');
    const linha = getConnection().prepare('SELECT document FROM core_customers WHERE id = ?').get(maria) as {
      document: string;
    };
    expect(linha.document).toBe(CPF);
  });

  it('com vale de loja, título em aberto ou OS na bancada, recusa e diz o que falta resolver', async () => {
    valeDeLoja(LOJA, maria, 5000);
    titulo(LOJA, maria, 'open');
    ordemDeServico(LOJA, maria, 'em_aberto');

    const res = await anonimizar(gerente, { motivo: MOTIVO });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_TITULAR_COM_PENDENCIA');
    const chaves = (res.body.error.details.pendencias as { chave: string }[]).map((p) => p.chave);
    expect(chaves).toEqual(expect.arrayContaining(['credito_de_loja', 'contas_a_receber', 'ordens_de_servico']));
    const linha = getConnection().prepare('SELECT document, active FROM core_customers WHERE id = ?').get(maria) as {
      document: string;
      active: number;
    };
    expect(linha.document).toBe(CPF);
    expect(linha.active).toBe(1);
  });

  it('anonimiza o cadastro e as cópias, e deixa o histórico apontando para a mesma linha', async () => {
    const lead = contatoComercial(LOJA, maria);
    const os = ordemDeServico(LOJA, maria, 'finalizada');
    const pago = titulo(LOJA, maria, 'settled');
    const conta = contaDoPortal(LOJA, maria);
    const db = getConnection();

    // A criação do cadastro subiu para a fila da central com o CPF dentro.
    const antes = db
      .prepare("SELECT payload FROM core_outbox WHERE aggregate_type = 'customer' AND aggregate_id = ?")
      .all(maria) as { payload: string }[];
    expect(antes.some((l) => l.payload.includes(CPF))).toBe(true);

    const res = await anonimizar(gerente, { motivo: MOTIVO });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.anonimizadoEm).toBeTruthy();
    semSegredoDoConvite(res.body);

    const cliente = db.prepare('SELECT * FROM core_customers WHERE id = ?').get(maria) as Record<string, unknown>;
    expect(String(cliente.name)).toMatch(/^Titular anonimizado/);
    for (const campo of ['document', 'email', 'phone', 'address', 'notes', 'portal_invite_hash', 'portal_invite_expires_at']) {
      expect(cliente[campo], campo).toBeNull();
    }
    expect(cliente.active).toBe(0);
    expect(cliente.anonymized_at).toBeTruthy();

    const contato = db.prepare('SELECT * FROM core_leads WHERE id = ?').get(lead) as Record<string, unknown>;
    expect(String(contato.name)).toMatch(/^Titular anonimizado/);
    for (const campo of ['phone', 'email', 'document', 'notes']) expect(contato[campo], campo).toBeNull();

    const ordem = db.prepare('SELECT customer_id, customer_name FROM core_service_orders WHERE id = ?').get(os) as {
      customer_id: string;
      customer_name: string;
    };
    expect(ordem.customer_id).toBe(maria);
    expect(ordem.customer_name).toMatch(/^Titular anonimizado/);

    // O histórico financeiro fica, apontando para a mesma linha.
    const lancamento = db.prepare('SELECT customer_id FROM core_finance_entries WHERE id = ?').get(pago) as {
      customer_id: string;
    };
    expect(lancamento.customer_id).toBe(maria);

    // O vínculo com a conta do portal desta operação sai; a conta (que é da
    // pessoa, e vale para as seis operações) não é apagada por uma delas.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM core_customer_account_links WHERE customer_id = ?').get(maria) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM core_customer_accounts WHERE id = ?').get(conta) as { n: number }).n,
    ).toBe(1);

    // As cópias que a fila da central guardava também perdem o contato.
    const depois = db
      .prepare("SELECT payload FROM core_outbox WHERE aggregate_type = 'customer' AND aggregate_id = ?")
      .all(maria) as { payload: string }[];
    expect(depois.length).toBeGreaterThan(antes.length);
    for (const l of depois) {
      expect(l.payload).not.toContain(CPF);
      expect(l.payload).not.toContain('maria@exemplo.com');
    }

    const trilha = db
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'customer.lgpd_anonymize' AND entity_id = ?")
      .all(maria) as { detail: string | null }[];
    expect(trilha).toHaveLength(1);
    expect(String(trilha[0].detail)).toContain(MOTIVO);
    expect(String(trilha[0].detail)).not.toContain(CPF);
  });

  it('depois de anonimizado, o balcão não acha pelo CPF antigo — e a pessoa pode voltar a ser cadastrada', async () => {
    expect((await anonimizar(gerente, { motivo: MOTIVO })).status).toBe(200);
    const caixa = await entrar('operador_caixa_loja');
    const busca = await request(app).get(`/api/v1/core/customers?search=${CPF}`).set(caixa);
    expect(busca.status).toBe(200);
    expect((busca.body.items as { id: string }[]).map((c) => c.id)).not.toContain(maria);

    const denovo = await request(app)
      .post('/api/v1/core/customers')
      .set(caixa)
      .send({ name: 'Maria Aparecida', document: CPF });
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(201);
  });

  it('anonimizar duas vezes é recusado', async () => {
    expect((await anonimizar(gerente, { motivo: MOTIVO })).status).toBe(200);
    const res = await anonimizar(gerente, { motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_TITULAR_JA_ANONIMIZADO');
  });

  it('só a gerência anonimiza, e só o titular da própria operação', async () => {
    for (const perfil of ['atendente', 'operador_caixa_loja', 'mecanico', 'estoquista']) {
      const quem = await entrar(perfil);
      expect((await anonimizar(quem, { motivo: MOTIVO })).status, perfil).toBe(403);
    }
    const outra = await entrar('gerente_loja', VIZINHA);
    expect((await anonimizar(outra, { motivo: MOTIVO })).status).toBe(404);
    const linha = getConnection().prepare('SELECT document FROM core_customers WHERE id = ?').get(maria) as {
      document: string;
    };
    expect(linha.document).toBe(CPF);
  });
});

// ============================================================ retenção declarada

describe('a retenção é declarada — e a trilha é podada no prazo que a declaração diz', () => {
  it('a gerência lê o que o sistema guarda e por quanto tempo', async () => {
    const res = await request(app).get('/api/v1/core/lgpd/retencao').set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const porChave = new Map(
      (res.body.items as { chave: string; prazo: string }[]).map((r) => [r.chave, r.prazo]),
    );
    expect(porChave.get('core_login_attempts')).toBe('24 horas');
    expect(porChave.get('api_request_logs')).toBe('30 dias');
    expect(porChave.get('core_audit_log')).toBe('5 anos');
    expect(porChave.has('documentos_fiscais')).toBe(true);

    const mecanico = await entrar('mecanico');
    expect((await request(app).get('/api/v1/core/lgpd/retencao').set(mecanico)).status).toBe(403);
  });

  it('a trilha de auditoria mais velha que cinco anos sai; a de dentro do prazo fica', () => {
    const db = getConnection();
    const inserir = (id: string, anosAtras: number) => {
      const quando = new Date();
      quando.setUTCFullYear(quando.getUTCFullYear() - anosAtras);
      db.prepare(
        `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
         VALUES (?, ?, NULL, 'teste.retencao', 'teste', NULL, NULL, NULL, ?)`,
      ).run(id, LOJA, quando.toISOString());
    };
    inserir('velha', 6);
    inserir('recente', 4);

    expect(podarTrilhaDeAuditoria()).toBeGreaterThanOrEqual(1);
    const ids = (db.prepare("SELECT id FROM core_audit_log WHERE action = 'teste.retencao'").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['recente']);
  });
});
