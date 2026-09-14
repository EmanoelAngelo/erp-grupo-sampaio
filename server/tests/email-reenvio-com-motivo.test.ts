/**
 * ============================================================================
 * FALHA ESPAÇA, NÃO MATA — e o que desistiu volta pela tela (GAP-PRD-038)
 * ============================================================================
 *
 * O QUE ERA: cinco tentativas, uma por batida de 60 s. Cinco minutos de SMTP
 * fora (senha de app trocada, DNS, provedor instável) viravam `failed` em
 * TODOS os pendentes — inclusive recuperação de senha e código de
 * verificação. `failed` era terminal: nenhum UPDATE fora do flush, nenhuma
 * rota de reenvio (`POST /core/emails/:id/reenviar` respondia 404), e a tela
 * tinha `lastError` na interface sem renderizá-lo. Reenviar era "chamar o
 * desenvolvedor" para um UPDATE no banco.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - cada falha empurra a próxima tentativa (1, 5, 30, 120, 720 min); só a
 *     sexta desiste — uma queda de minutos não mata mais nada;
 *   - a rota da fila entrega motivo, tentativas e próxima hora, e filtra por
 *     situação;
 *   - o gestor da EMPRESA DONA devolve à fila o que desistiu, auditado;
 *     outra empresa recebe 404, o que ainda está na fila ou já saiu recebe
 *     409, o caixa recebe 403;
 *   - o que não tem mais conteúdo para mandar (segredo vencido, anexo
 *     liberado) é recusado dizendo o que fazer no lugar;
 *   - o zip do contador que falhou fica guardado um mês, para o reenvio
 *     levar o anexo.
 *
 * O relógio do flush é injetado (`agora`): é o único jeito honesto de provar
 * esperas de minutos a horas sem esperar minutos a horas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  ESPERA_ENTRE_TENTATIVAS_MIN,
  flushEmailQueue,
  liberarAnexosSemDono,
  queueEmail,
  queuePacoteContadorEmail,
  queuePasswordResetEmail,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'gringa';
const OUTRA = 'conceito';
const SENHA_DO_APP = 'senha-de-app-que-nao-pode-vazar';
const EMAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;
const originais = new Map<string, string | undefined>();
for (const v of EMAIL_VARS) originais.set(v, process.env[v]);

function comCredencial(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
  process.env.EMAIL_SMTP_PORT = '465';
  process.env.EMAIL_SMTP_USER = 'grupo@sampaio.com.br';
  process.env.EMAIL_SMTP_PASSWORD = SENHA_DO_APP;
}

function carteiro(falha?: () => Error): CarteiroSmtp & { enviados: MensagemSmtp[] } {
  const enviados: MensagemSmtp[] = [];
  return {
    enviados,
    enviar(msg: MensagemSmtp): Promise<void> {
      if (falha) return Promise.reject(falha());
      enviados.push(msg);
      return Promise.resolve();
    },
  };
}

const erro535 = () => new Error(`535-5.7.8 Username and Password not accepted (${SENHA_DO_APP})`);

function enfileirar(companyId = EMPRESA, dedupe = `fato-${Math.random()}`): string {
  const id = queueEmail({
    companyId,
    template: 'pagamento_confirmado',
    toAddress: 'ana@exemplo.com',
    dedupeKey: dedupe,
    context: { storeName: 'Gringa', customerName: 'Ana', orderNumber: 7, totalCents: 12345 },
  });
  expect(id).toBeTruthy();
  return id!;
}

interface Linha {
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
}

function linha(id: string): Linha {
  return getConnection()
    .prepare('SELECT status, attempts, last_error, next_attempt_at FROM core_email_queue WHERE id = ?')
    .get(id) as unknown as Linha;
}

const MIN = 60_000;

/** Faz a mensagem desistir: seis falhas, cada uma depois da espera anterior. */
async function levarAteDesistir(): Promise<number> {
  const quebrado = carteiro(erro535);
  let agora = Date.now();
  for (let i = 0; i < 6; i += 1) {
    await flushEmailQueue({ carteiro: quebrado, agora: new Date(agora) });
    agora += 13 * 60 * MIN;
  }
  return agora;
}

async function tokenDe(profile: string, companyId = EMPRESA): Promise<string> {
  const r = await loginForTest(app, { userId: `u-${profile}`, companyId, profileCodes: [profile] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  comCredencial();
  upsertCompany({ id: EMPRESA, slug: EMPRESA, legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  upsertCompany({ id: OUTRA, slug: OUTRA, legalName: 'Conceito Ltda', tradeName: 'Conceito' });
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const original = originais.get(v);
    if (original === undefined) delete process.env[v];
    else process.env[v] = original;
  }
});

describe('a falha espaça as tentativas', () => {
  it('a primeira falha marca a próxima para 1 minuto depois — e antes disso ninguém insiste', async () => {
    const id = enfileirar();
    const t0 = Date.now();
    await flushEmailQueue({ carteiro: carteiro(erro535), agora: new Date(t0) });

    const depois = linha(id);
    expect(depois.status).toBe('pending');
    expect(depois.attempts).toBe(1);
    expect(new Date(depois.next_attempt_at!).getTime()).toBe(t0 + 1 * MIN);
    // O motivo fica, sem a senha.
    expect(depois.last_error).toMatch(/535/);
    expect(depois.last_error).not.toContain(SENHA_DO_APP);

    // 30 s depois: a mensagem ainda não tem hora — o carteiro nem a vê.
    const bom = carteiro();
    await flushEmailQueue({ carteiro: bom, agora: new Date(t0 + 30_000) });
    expect(bom.enviados).toHaveLength(0);

    // Passado o minuto, sai.
    await flushEmailQueue({ carteiro: bom, agora: new Date(t0 + 61_000) });
    expect(bom.enviados).toHaveLength(1);
    expect(linha(id).status).toBe('sent');
    expect(linha(id).next_attempt_at).toBeNull();
  });

  it('a escada é 1, 5, 30, 120, 720 minutos — e só a sexta falha desiste', async () => {
    expect([...ESPERA_ENTRE_TENTATIVAS_MIN]).toEqual([1, 5, 30, 120, 720]);
    const id = enfileirar();
    const quebrado = carteiro(erro535);
    let agora = Date.now();
    for (const [i, espera] of ESPERA_ENTRE_TENTATIVAS_MIN.entries()) {
      await flushEmailQueue({ carteiro: quebrado, agora: new Date(agora) });
      const l = linha(id);
      expect(l.status).toBe('pending');
      expect(l.attempts).toBe(i + 1);
      expect(new Date(l.next_attempt_at!).getTime()).toBe(agora + espera * MIN);
      agora += espera * MIN;
    }
    await flushEmailQueue({ carteiro: quebrado, agora: new Date(agora) });
    const fim = linha(id);
    expect(fim.status).toBe('failed');
    expect(fim.attempts).toBe(6);
    expect(fim.next_attempt_at).toBeNull();
    expect(fim.last_error).toMatch(/535/);
  });

  it('cinco minutos de SMTP fora — cinco batidas seguidas — não matam a fila', async () => {
    const id = enfileirar();
    const quebrado = carteiro(erro535);
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await flushEmailQueue({ carteiro: quebrado, agora: new Date(t0 + i * MIN) });
    }
    const l = linha(id);
    expect(l.status).toBe('pending');
    expect(l.attempts).toBeLessThan(6);

    // O SMTP volta; a próxima hora chega; a mensagem sai.
    const bom = carteiro();
    await flushEmailQueue({ carteiro: bom, agora: new Date(t0 + 40 * MIN) });
    expect(bom.enviados).toHaveLength(1);
    expect(linha(id).status).toBe('sent');
  });
});

describe('a tela recebe o motivo e filtra por situação', () => {
  it('GET /core/emails entrega motivo, tentativas e a próxima hora; ?status=failed filtra', async () => {
    const token = await tokenDe('gerente_loja');
    const falhou = enfileirar();
    await levarAteDesistir();
    const pendente = enfileirar();
    await flushEmailQueue({ carteiro: carteiro(erro535) });

    const todos = await request(app).get('/api/v1/core/emails').set('Authorization', `Bearer ${token}`);
    expect(todos.status).toBe(200);
    const itens = todos.body.items as Array<Record<string, unknown>>;
    const f = itens.find((i) => i.id === falhou)!;
    expect(f.status).toBe('failed');
    expect(f.attempts).toBe(6);
    expect(String(f.lastError)).toMatch(/535/);
    expect(String(f.lastError)).not.toContain(SENHA_DO_APP);
    expect(f.podeReenviar).toBe(true);
    const p = itens.find((i) => i.id === pendente)!;
    expect(p.status).toBe('pending');
    expect(p.nextAttemptAt).toBeTruthy();
    expect(p.podeReenviar).toBe(false);

    const soFalhas = await request(app)
      .get('/api/v1/core/emails?status=failed')
      .set('Authorization', `Bearer ${token}`);
    expect(soFalhas.status).toBe(200);
    expect((soFalhas.body.items as { id: string }[]).map((i) => i.id)).toEqual([falhou]);

    const torto = await request(app)
      .get('/api/v1/core/emails?status=qualquer')
      .set('Authorization', `Bearer ${token}`);
    expect(torto.status).toBe(400);
  });
});

describe('reenviar pela tela', () => {
  it('devolve à fila, zera as tentativas, audita — e o carteiro seguinte entrega', async () => {
    const token = await tokenDe('gerente_loja');
    const id = enfileirar();
    const depois = await levarAteDesistir();
    expect(linha(id).status).toBe('failed');

    const r = await request(app)
      .post(`/api/v1/core/emails/${id}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.item.status).toBe('pending');
    expect(r.body.item.attempts).toBe(0);
    expect(r.body.status.pending).toBeGreaterThanOrEqual(1);

    const l = linha(id);
    expect([l.status, l.attempts, l.next_attempt_at, l.last_error]).toEqual(['pending', 0, null, null]);

    const trilha = getConnection()
      .prepare(
        `SELECT company_id, user_id, entity_id, detail FROM core_audit_log
          WHERE action = 'email.requeue'`,
      )
      .all() as { company_id: string; user_id: string; entity_id: string; detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].company_id).toBe(EMPRESA);
    expect(trilha[0].entity_id).toBe(id);
    expect(trilha[0].user_id).toBeTruthy();
    const detalhe = JSON.parse(trilha[0].detail) as { tentativasAnteriores: number; ultimoErro: string };
    expect(detalhe.tentativasAnteriores).toBe(6);
    expect(detalhe.ultimoErro).toMatch(/535/);
    expect(detalhe.ultimoErro).not.toContain(SENHA_DO_APP);

    const bom = carteiro();
    await flushEmailQueue({ carteiro: bom, agora: new Date(depois) });
    expect(bom.enviados).toHaveLength(1);
    expect(linha(id).status).toBe('sent');
  });

  it('mensagem de OUTRA empresa responde 404 — e continua como estava', async () => {
    const token = await tokenDe('gerente_loja');
    const daOutra = enfileirar(OUTRA);
    await levarAteDesistir();
    const r = await request(app)
      .post(`/api/v1/core/emails/${daOutra}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
    expect(linha(daOutra).status).toBe('failed');
  });

  it('ainda na fila ou já entregue: 409, dizendo por quê', async () => {
    const token = await tokenDe('gerente_loja');
    const naFila = enfileirar();
    const r1 = await request(app)
      .post(`/api/v1/core/emails/${naFila}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r1.status).toBe(409);
    expect(JSON.stringify(r1.body)).toMatch(/já está na fila/);

    await flushEmailQueue({ carteiro: carteiro() });
    const r2 = await request(app)
      .post(`/api/v1/core/emails/${naFila}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(409);
    expect(JSON.stringify(r2.body)).toMatch(/duplicaria/);
  });

  it('o caixa não mexe na fila de e-mail — 403', async () => {
    const id = enfileirar();
    await levarAteDesistir();
    const token = await tokenDe('operador_caixa_loja');
    const r = await request(app)
      .post(`/api/v1/core/emails/${id}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(linha(id).status).toBe('failed');
  });

  it('link de recuperação que desistiu não volta: o segredo foi apagado — o cliente pede outro', async () => {
    const token = await tokenDe('gerente_loja');
    const id = queuePasswordResetEmail({
      companyId: EMPRESA,
      toAddress: 'ana@exemplo.com',
      resetLink: 'https://loja.exemplo/redefinir-senha?token=abc',
      dedupeKey: 'reset-que-desiste',
    })!;
    // O link vence antes de sair.
    await flushEmailQueue({ carteiro: carteiro(erro535), agora: new Date(Date.now() + 2 * 60 * MIN) });
    expect(linha(id).status).toBe('failed');

    const lista = await request(app).get('/api/v1/core/emails').set('Authorization', `Bearer ${token}`);
    const item = (lista.body.items as Array<Record<string, unknown>>).find((i) => i.id === id)!;
    expect(item.podeReenviar).toBe(false);
    expect(String(item.motivoSemReenvio)).toMatch(/Esqueci minha senha/);

    const r = await request(app)
      .post(`/api/v1/core/emails/${id}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(r.body.error?.code ?? r.body.code).toBe('EMAIL_SEM_REENVIO');
  });
});

describe('o pacote do contador que falhou guarda o zip para o reenvio', () => {
  function pacote(): string {
    const id = queuePacoteContadorEmail({
      companyId: EMPRESA,
      toAddress: 'contador@exemplo.com',
      subject: 'Fechamento de julho',
      bodyText: 'Segue o pacote do mês.',
      anexoNome: 'julho.zip',
      anexoBytes: Buffer.from('conteudo-do-zip-de-julho'),
      payload: {},
      dedupeKey: 'pacote-julho',
    });
    expect(id).toBeTruthy();
    return id!;
  }

  function anexos(): number {
    return Number(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_email_attachments').get() as { n: number }).n,
    );
  }

  it('desistiu: o zip fica; reenviado, o zip viaja inteiro', async () => {
    const token = await tokenDe('gerente_loja');
    const id = pacote();
    const depois = await levarAteDesistir();
    expect(linha(id).status).toBe('failed');
    // A faxina rodou (o flush que desistiu a dispara) e NÃO levou o zip.
    expect(anexos()).toBe(1);

    const r = await request(app)
      .post(`/api/v1/core/emails/${id}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const bom = carteiro();
    await flushEmailQueue({ carteiro: bom, agora: new Date(depois) });
    expect(bom.enviados[0]?.anexos?.[0]?.nome).toBe('julho.zip');
    expect(bom.enviados[0]?.anexos?.[0]?.conteudo.toString()).toBe('conteudo-do-zip-de-julho');
    // Entregue: agora sim a faxina leva os bytes.
    expect(anexos()).toBe(0);
  });

  it('passado um mês, a faxina leva o zip — e o reenvio diz que precisa gerar de novo', async () => {
    const token = await tokenDe('gerente_loja');
    const id = pacote();
    await levarAteDesistir();
    getConnection()
      .prepare('UPDATE core_email_queue SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 24 * 60 * MIN).toISOString(), id);
    liberarAnexosSemDono('todas_as_empresas');
    expect(anexos()).toBe(0);

    const r = await request(app)
      .post(`/api/v1/core/emails/${id}/reenviar`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/tela do contador/);
  });
});
