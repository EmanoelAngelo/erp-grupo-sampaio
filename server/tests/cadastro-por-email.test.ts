/**
 * ============================================================================
 * O E-MAIL PROVA DONO — rodada 50
 * ============================================================================
 *
 * O buraco que esta rodada fecha: o registro com CO-PROVA (e-mail + documento
 * no mesmo cadastro) vinculava os pedidos NA HORA. Mas conhecer os dois dados
 * não é ser dono da caixa de entrada — o e-mail é público e o CPF é
 * semi-público. Com os dois de OUTRA pessoa, a conta nascia lendo o histórico
 * de compras dela: pedidos, endereços, equipamentos.
 *
 * Agora o vínculo espera o CÓDIGO: seis dígitos que vão para a caixa daquele
 * e-mail e só voltam pela mão de quem a abre. As regras que este arquivo
 * trava:
 *
 *   - registro com co-prova NÃO vincula na hora — a conta nasce vazia e o
 *     documento espera junto ao código;
 *   - o código certo verifica o e-mail E faz o vínculo nascer;
 *   - código errado conta tentativa (o mesmo lockout do login); vencido não
 *     vale; reenvio tem teto por hora e CARREGA a co-prova pendente;
 *   - `vincularPorDocumento` exige e-mail verificado — a mesma regra, na
 *     outra porta que aceita documento digitado;
 *   - o convite do balcão continua vinculando na hora (o papel é a prova) e
 *     o código sai mesmo assim;
 *   - usar o link de redefinição de senha TAMBÉM verifica (o link foi para a
 *     caixa e voltou) e destrava a co-prova pendente.
 *
 * COMO CADA GUARDA FALHA (conferido quebrando cada um de propósito):
 *  - religando o syncLinks imediato no registro, o caso do ataque falha
 *    (a vítima aparece vinculada sem código nenhum);
 *  - tirando o guarda de `vincularPorDocumento`, o caso do 403 falha;
 *  - tirando o `link_document` do reenvio, o caso do código vencido falha
 *    (o vínculo se perde com o código velho).
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  confirmarEmail,
  pedirVerificacaoEmail,
  redefinirSenhaComToken,
  registerWithInvite,
  vincularPorDocumento,
} from '../src/services/core/CustomerPortalService.js';

const app = createApp();
const SENHA = 'senha-forte-8';
const CPF_DA_VITIMA = '52998224725';

let gringa: string;

/** O cadastro comercial da vítima — e-mail e documento juntos (a co-prova). */
function cadastroDaVitima(email = 'vitima@exemplo.com', documento = CPF_DA_VITIMA): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, email, document, active, created_at, updated_at)
       VALUES (?, ?, 'Vítima da Silva', ?, ?, 1, ?, ?)`,
    )
    .run(id, gringa, email, documento, agora, agora);
  return id;
}

async function registrar(email: string, documento?: string) {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ email, password: SENHA, document: documento, termsAccepted: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    token: string;
    account: { id: string; emailVerifiedAt: string | null };
    customers: { customerId: string }[];
  };
}

/** O código como o CLIENTE o recebe: lido do corpo do e-mail na fila. */
function codigoDaCaixa(): string {
  // Por rowid, não created_at: num teste rápido dois códigos caem no mesmo
  // milissegundo, e o ORDER BY created_at empataria sem ordem definida.
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  const achado = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/);
  expect(achado, 'código de verificação não está no corpo do e-mail').toBeTruthy();
  return achado![1];
}

function vinculosDe(accountId: string): string[] {
  return (
    getConnection()
      .prepare('SELECT customer_id FROM core_customer_account_links WHERE account_id = ?')
      .all(accountId) as unknown as { customer_id: string }[]
  ).map((l) => l.customer_id);
}

function contaVerificada(accountId: string): string | null {
  const linha = getConnection()
    .prepare('SELECT email_verified_at FROM core_customer_accounts WHERE id = ?')
    .get(accountId) as { email_verified_at: string | null } | undefined;
  return linha?.email_verified_at ?? null;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = upsertCompany({
    slug: 'gringa',
    tradeName: 'Gringa',
    legalName: 'Gringa Ltda',
    kind: 'retail',
  });
});

describe('a co-prova espera o código', () => {
  it('registro com e-mail + documento NÃO vincula na hora — o histórico só vem com o código', async () => {
    /*
      O ATAQUE que morre aqui: quem conhece o e-mail e o CPF de outra pessoa
      registra a conta — e antes desta rodada saía com os pedidos dela. O
      código foi para a caixa DA VÍTIMA; sem abri-la, nada chega.
    */
    const clienteId = cadastroDaVitima();
    const sessao = await registrar('vitima@exemplo.com', CPF_DA_VITIMA);

    expect(sessao.customers).toHaveLength(0);
    expect(vinculosDe(sessao.account.id)).toHaveLength(0);
    expect(sessao.account.emailVerifiedAt).toBeNull();

    // O código certo — que só o dono da caixa tem — verifica E vincula.
    const codigo = codigoDaCaixa();
    const confirmou = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .set({ 'x-portal-token': sessao.token })
      .send({ code: codigo });
    expect(confirmou.status, JSON.stringify(confirmou.body)).toBe(200);

    expect(contaVerificada(sessao.account.id)).toBeTruthy();
    expect(vinculosDe(sessao.account.id)).toContain(clienteId);
  });

  it('o payload da fila NÃO carrega o código — a tela do gestor não vira sequestro', async () => {
    await registrar('vitima@exemplo.com');
    const codigo = codigoDaCaixa();
    const payload = getConnection()
      .prepare("SELECT payload FROM core_email_queue WHERE template = 'verificacao_email'")
      .get() as { payload: string };
    expect(payload.payload).not.toContain(codigo);
  });

  it('IP fixo trava rápido — cinco palpites do mesmo aparelho e a rota tranca', async () => {
    // O par (conta + origem) tranca em 5, como no login: o aparelho que
    // insiste para de tentar. É a primeira barreira; a rota usa o IP do
    // socket (127.0.0.1 no teste).
    const sessao = await registrar('ana@exemplo.com');
    const certo = codigoDaCaixa();
    const errado = certo === '000000' ? '000001' : '000000';

    let trancou = false;
    for (let i = 0; i < 6; i += 1) {
      const r = await request(app)
        .post('/api/v1/loja/portal/verificar-email')
        .set({ 'x-portal-token': sessao.token })
        .send({ code: errado });
      if (r.status === 429) { trancou = true; break; }
      expect(r.status).toBe(400);
    }
    expect(trancou).toBe(true);
  });

  it('IP rotativo não escapa: o teto POR CONTA (8) morde mesmo trocando de origem', async () => {
    /*
      O ataque que a revisão apontou: quem adivinha o código É o dono da
      conta e roda de IP, então o teto por par (5/origem) nunca acumula. O
      teto por CONTA é a barreira que segura isso — provado aqui variando o
      ip a cada palpite, o que só dá para fazer no serviço.
    */
    const sessao = await registrar('ana@exemplo.com');
    const certo = codigoDaCaixa();
    const errado = certo === '000000' ? '000001' : '000000';

    for (let i = 0; i < 8; i += 1) {
      expect(() =>
        confirmarEmail({ accountId: sessao.account.id, codigo: errado, ip: `10.0.0.${i}` }),
      ).toThrowError(/inválido|vencido/i);
    }
    // Nem o código CERTO passa — a conta trancou pelo teto por conta.
    expect(() =>
      confirmarEmail({ accountId: sessao.account.id, codigo: certo, ip: '10.0.0.99' }),
    ).toThrowError(/tentativas/i);
  });

  it('só o ÚLTIMO código vale — o reenvio invalida o anterior', async () => {
    const sessao = await registrar('ana@exemplo.com');
    const primeiro = codigoDaCaixa();

    const reenvio = await request(app)
      .post('/api/v1/loja/portal/reenviar-verificacao')
      .set({ 'x-portal-token': sessao.token });
    expect(reenvio.status).toBe(200);
    const segundo = codigoDaCaixa();
    expect(segundo).not.toBe(primeiro);

    // O código velho não vale mais — invalidado pelo reenvio.
    const velho = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .set({ 'x-portal-token': sessao.token })
      .send({ code: primeiro });
    expect(velho.status).toBe(400);

    // O novo, sim.
    const novo = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .set({ 'x-portal-token': sessao.token })
      .send({ code: segundo });
    expect(novo.status).toBe(200);
  });

  it('o código de UMA conta não confirma OUTRA — a consulta é escopada por conta', async () => {
    const a = await registrar('a@exemplo.com');
    const codigoDeA = codigoDaCaixa();
    const b = await registrar('b@exemplo.com');

    // B tenta usar o código que foi para a caixa de A.
    const cruzado = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .set({ 'x-portal-token': b.token })
      .send({ code: codigoDeA });
    expect(cruzado.status).toBe(400);
    expect(contaVerificada(b.account.id)).toBeNull();

    // E o código de A segue valendo para A — B errar não o queimou.
    confirmarEmail({ accountId: a.account.id, codigo: codigoDeA });
    expect(contaVerificada(a.account.id)).toBeTruthy();
  });

  it('código vencido não vale — e o REENVIO carrega a co-prova pendente', async () => {
    const clienteId = cadastroDaVitima('ana@exemplo.com');
    const sessao = await registrar('ana@exemplo.com', CPF_DA_VITIMA);
    const vencido = codigoDaCaixa();

    // O tempo passa: o primeiro código vence.
    getConnection()
      .prepare('UPDATE core_customer_email_verifications SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());

    const recusa = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .set({ 'x-portal-token': sessao.token })
      .send({ code: vencido });
    expect(recusa.status).toBe(400);
    expect(recusa.body.error?.code).toBe('PORTAL_CODIGO_INVALIDO');

    // Reenvia — e o código NOVO ainda sabe da co-prova que esperava.
    const reenvio = await request(app)
      .post('/api/v1/loja/portal/reenviar-verificacao')
      .set({ 'x-portal-token': sessao.token });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);

    confirmarEmail({ accountId: sessao.account.id, codigo: codigoDaCaixa() });
    expect(vinculosDe(sessao.account.id)).toContain(clienteId);
  });

  it('reenviar sem parar tem teto: o quarto código da mesma hora é 429', async () => {
    const sessao = await registrar('ana@exemplo.com');
    // O registro já criou o primeiro; mais dois cabem na mesma hora.
    for (let i = 0; i < 2; i += 1) {
      const ok = await request(app)
        .post('/api/v1/loja/portal/reenviar-verificacao')
        .set({ 'x-portal-token': sessao.token });
      expect(ok.status).toBe(200);
    }
    const demais = await request(app)
      .post('/api/v1/loja/portal/reenviar-verificacao')
      .set({ 'x-portal-token': sessao.token });
    expect(demais.status).toBe(429);
    expect(demais.body.error?.code).toBe('PORTAL_VERIFICACAO_LIMITE');
  });

  it('conta já verificada: reenviar é inofensivo e diz isso', async () => {
    const sessao = await registrar('ana@exemplo.com');
    confirmarEmail({ accountId: sessao.account.id, codigo: codigoDaCaixa() });
    expect(pedirVerificacaoEmail(sessao.account.id)).toEqual({ alreadyVerified: true });
  });
});

describe('as outras portas da mesma regra', () => {
  it('vincularPorDocumento exige e-mail verificado — depois do código, vincula', async () => {
    const clienteId = cadastroDaVitima('ana@exemplo.com');
    const sessao = await registrar('ana@exemplo.com'); // sem documento no registro

    expect(() =>
      vincularPorDocumento({ accountId: sessao.account.id, document: CPF_DA_VITIMA }),
    ).toThrowError(/Confirme seu e-mail/);

    confirmarEmail({ accountId: sessao.account.id, codigo: codigoDaCaixa() });
    const r = vincularPorDocumento({ accountId: sessao.account.id, document: CPF_DA_VITIMA });
    expect(r.linked).toBe(1);
    expect(vinculosDe(sessao.account.id)).toContain(clienteId);
  });

  it('o convite do balcão continua vinculando NA HORA — o papel é a prova', async () => {
    const agora = new Date().toISOString();
    const clienteId = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, active, created_at, updated_at)
         VALUES (?, ?, 'Dona da Moto', 1, ?, ?)`,
      )
      .run(clienteId, gringa, agora, agora);

    const sessao = await registerWithInvite({
      email: 'balcao@exemplo.com',
      password: SENHA,
      customerId: clienteId,
      companyId: gringa,
      termsAccepted: true,
    });
    expect(vinculosDe(sessao.account.id)).toContain(clienteId);
    // E o código saiu mesmo assim: a caixa ainda precisa provar dona.
    expect(codigoDaCaixa()).toMatch(/^\d{6}$/);
    expect(sessao.account.emailVerifiedAt).toBeNull();
  });

  it('usar o link de redefinição TAMBÉM verifica — e destrava a co-prova pendente', async () => {
    const clienteId = cadastroDaVitima('ana@exemplo.com');
    const sessao = await registrar('ana@exemplo.com', CPF_DA_VITIMA);
    expect(vinculosDe(sessao.account.id)).toHaveLength(0);

    // O link de reset foi para a MESMA caixa: usá-lo prova o e-mail tanto
    // quanto o código. Planta-se o reset com hash conhecido, como no teste
    // do carteiro.
    const token = 'token-reset-conhecido';
    getConnection()
      .prepare(
        `INSERT INTO core_customer_password_resets
           (id, account_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        randomUUID(),
        sessao.account.id,
        createHash('sha256').update(token).digest('hex'),
        new Date(Date.now() + 3_600_000).toISOString(),
        new Date().toISOString(),
      );

    await redefinirSenhaComToken({ token, password: 'senha-nova-diferente-8' });

    expect(contaVerificada(sessao.account.id)).toBeTruthy();
    expect(vinculosDe(sessao.account.id)).toContain(clienteId);
  });

  it('o LOGIN não vincula pelo e-mail sem verificação — e passa a vincular depois de provar', async () => {
    /*
      A "outra porta" que a revisão da rodada achou: a co-prova do registro
      foi fechada, mas o login recalculava vínculos pelo ramo do E-MAIL — e o
      checkout de visitante SEM CPF cria cadastros com e-mail e histórico
      real. Quem registrasse com o e-mail de outra pessoa herdava as compras
      dela no primeiro login. Agora o ramo do e-mail exige e-mail provado.

      A dona LEGÍTIMA (que tem a caixa) segue recuperando as compras de
      visitante: verifica e, no login seguinte, o ramo do e-mail volta a
      valer.
    */
    const agora = new Date().toISOString();
    const visitante = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, email, document, active, created_at, updated_at)
         VALUES (?, ?, 'Compra de visitante', ?, NULL, 1, ?, ?)`,
      )
      .run(visitante, gringa, 'dona@exemplo.com', agora, agora);

    const sessao = await registrar('dona@exemplo.com'); // sem CPF
    expect(vinculosDe(sessao.account.id)).toHaveLength(0);

    const entrar = async () =>
      request(app)
        .post('/api/v1/loja/portal/entrar')
        .send({ email: 'dona@exemplo.com', password: SENHA });

    // Login antes de verificar: NADA vincula pelo e-mail.
    expect((await entrar()).status).toBe(200);
    expect(vinculosDe(sessao.account.id)).toHaveLength(0);

    // A dona prova a caixa e loga de novo: agora o cadastro de visitante vem.
    confirmarEmail({ accountId: sessao.account.id, codigo: codigoDaCaixa() });
    expect((await entrar()).status).toBe(200);
    expect(vinculosDe(sessao.account.id)).toContain(visitante);
  });

  it('sem sessão do portal, verificar e reenviar são 401', async () => {
    const semSessao = await request(app)
      .post('/api/v1/loja/portal/verificar-email')
      .send({ code: '123456' });
    expect(semSessao.status).toBe(401);
    const reenvio = await request(app).post('/api/v1/loja/portal/reenviar-verificacao');
    expect(reenvio.status).toBe(401);
  });
});
