/**
 * ============================================================================
 * O PACOTE QUE NÃO CABE NO E-MAIL — o ramo que decidia sozinho, sem teste
 * ============================================================================
 *
 * `comAnexo = false` é o ramo que decide se o contador RECEBE ou NÃO recebe o
 * arquivo do mês. Ele existia desde o GAP-V30 e nenhum dos dezessete casos de
 * `contador-envio-do-pacote` passava por ele: o pacote de um banco de teste tem
 * dois kilobytes, e o teto são quinze megabytes.
 *
 * Um ramo sem teste é um ramo que ninguém verificou, e este decide o desfecho
 * mais visível do módulo. Se ele quebrasse — anexando mesmo assim — o envio
 * viraria falha certa no provedor do contador, com cara de e-mail enviado. Se
 * quebrasse para o outro lado, todo mês sairia sem anexo e o corpo diria a
 * verdade errada.
 *
 * ## COMO O RAMO É ATRAVESSADO AQUI
 *
 * Gerar 15 MB de XML fiscal levaria minutos e não provaria nada além do que
 * este dublê prova: quem decide é o TAMANHO do pacote. `montarPacote` é
 * substituído por um que devolve um buffer acima do teto — o resto do caminho
 * (prévia, corpo, fila, carteiro, histórico) é o de verdade.
 *
 * ## COMO ESTE GUARDA FALHA (quebrando de propósito)
 *
 *   - troque `pacote.bytes.length <= ANEXO_TETO_BYTES` por `true` → os três
 *     casos ficam vermelhos: o corpo passa a prometer anexo, a fila guarda 16
 *     MB e o carteiro recebe o zip que o provedor recusaria;
 *   - troque por `false` → o caso do pacote pequeno (em
 *     `contador-envio-do-pacote`) fica vermelho, com o mês saindo sem arquivo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * O PACOTE GRANDE, montado uma vez só.
 *
 * Acima de `ANEXO_TETO_BYTES` (15 MB) por um byte: é o limite que interessa,
 * e não um número redondo qualquer. O conteúdo é zero — nada aqui lê o zip;
 * quem decide é o comprimento.
 */
const TETO = 15 * 1024 * 1024;
const PACOTE_GRANDE = Buffer.alloc(TETO + 1);

vi.mock('../src/services/core/FiscalClosingService.js', async (original) => {
  const real =
    await original<typeof import('../src/services/core/FiscalClosingService.js')>();
  return {
    ...real,
    montarPacote: (companyId: string, period: string) => ({
      nomeArquivo: real.montarPacote(companyId, period).nomeArquivo,
      bytes: PACOTE_GRANDE,
    }),
  };
});

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { loginForTest } = await import('./helpers/auth.js');
const { ANEXO_TETO_BYTES, criarDestinatario, enviarPacotePorEmail, listarEnvios } = await import(
  '../src/services/core/ContadorEnvioService.js'
);
const { flushEmailQueue } = await import('../src/services/notifications/EmailService.js');
type MensagemSmtp = import('../src/services/notifications/EmailService.js').MensagemSmtp;
type CarteiroSmtp = import('../src/services/notifications/EmailService.js').CarteiroSmtp;
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const app = createApp();
const PERIODO = '2026-07';

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-pacotao',
    companyId: 'preco-justo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

function fila() {
  return getConnection()
    .prepare(
      `SELECT id, subject, body_text, status, anexo_nome, anexo_blob
         FROM core_email_queue WHERE company_id = ? ORDER BY created_at, rowid`,
    )
    .all(companyId) as unknown as {
    id: string;
    subject: string;
    body_text: string;
    status: string;
    anexo_nome: string | null;
    anexo_blob: Uint8Array | null;
  }[];
}

/** Todo byte de anexo guardado nesta empresa — na fila e no cofre. */
function bytesGuardados(): number {
  const db = getConnection();
  const naFila = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(anexo_blob)), 0) AS b
             FROM core_email_queue WHERE company_id = ?`,
        )
        .get(companyId) as { b: number }
    ).b,
  );
  const noCofre = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(conteudo)), 0) AS b
             FROM core_email_attachments WHERE company_id = ?`,
        )
        .get(companyId) as { b: number }
    ).b,
  );
  return naFila + noCofre;
}

describe('o mês que não cabe no e-mail sai sem anexo, dizendo isso', () => {
  it('o teto é o do PROVEDOR, e o pacote deste caso passa dele', () => {
    // O número não é decorativo: 15 MB de zip viram ~20 MB de mensagem em
    // base64, e o Gmail corta em 25 MB. Acima disso, anexar é enfileirar uma
    // falha certa com cara de envio.
    expect(ANEXO_TETO_BYTES).toBe(TETO);
    expect(PACOTE_GRANDE.length).toBeGreaterThan(ANEXO_TETO_BYTES);
  });

  it('o envio acontece, com comAnexo = false — o mês não fica preso', () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });

    const r = enviarPacotePorEmail({
      companyId,
      period: PERIODO,
      origem: 'manual',
      idempotencyKey: 'clique-do-pacotao',
      userId: 'gerente-pacotao',
    });

    // Recusar o envio seria pior: o contador não receberia nem o AVISO de que
    // o mês está pronto, e o gesto que existe (baixar o zip) ninguém saberia
    // que precisa ser feito.
    expect(r.enfileirados).toBe(1);
    expect(r.comAnexo).toBe(false);
    expect(r.nomeArquivo).toBe('pacote-preco-justo-2026-07.zip');
  });

  it('o corpo NÃO promete anexo: diz que passou do tamanho e aponta os dois caminhos', () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    const [mensagem] = fila();
    expect(mensagem.body_text).toContain('passou do tamanho');
    expect(mensagem.body_text).toContain('NÃO vai anexado');
    // Os dois caminhos que existem de verdade: o botão da tela e o login do
    // contador. Mandar o contador "pedir por WhatsApp" seria inventar processo.
    expect(mensagem.body_text).toContain('Fechamento do contador');
    expect(mensagem.body_text).toContain('Baixar o pacote');
    // E continua sendo o e-mail do mês: assunto e resumo intactos.
    expect(mensagem.subject).toContain('julho de 2026');
    expect(mensagem.body_text).toContain('Notas emitidas autorizadas');
  });

  it('nenhum byte do pacote entra no banco — nem na fila, nem no cofre', () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    const [mensagem] = fila();
    expect(mensagem.anexo_nome).toBeNull();
    expect(mensagem.anexo_blob).toBeNull();
    expect(bytesGuardados()).toBe(0);
  });

  it('o carteiro leva a mensagem SEM anexo — e o histórico vira "enviado"', async () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_FROM = 'loja@grupo.com.br';
    process.env.EMAIL_SMTP_HOST = 'smtp.local';
    process.env.EMAIL_SMTP_USER = 'loja';
    process.env.EMAIL_SMTP_PASSWORD = 'segredo';
    resetEnvCacheForTests();
    try {
      const entregues: MensagemSmtp[] = [];
      const carteiro: CarteiroSmtp = {
        async enviar(msg) {
          entregues.push(msg);
        },
      };
      const resultado = await flushEmailQueue({ carteiro });
      expect(resultado.sent).toBe(1);
      expect(entregues).toHaveLength(1);
      // Sem anexo nenhum: o provedor recusaria 20 MB, e o e-mail que "falha
      // com cara de enviado" é o desfecho que este ramo existe para evitar.
      expect(entregues[0].anexos ?? []).toHaveLength(0);

      expect(listarEnvios(companyId, PERIODO).items[0].status).toBe('enviado');
    } finally {
      delete process.env.EMAIL_ENABLED;
      delete process.env.EMAIL_FROM;
      delete process.env.EMAIL_SMTP_HOST;
      delete process.env.EMAIL_SMTP_USER;
      delete process.env.EMAIL_SMTP_PASSWORD;
      resetEnvCacheForTests();
    }
  });

  it('a auditoria registra o tamanho e o SEM anexo — quem confere depois precisa saber', () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    const trilha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'contador.pacote_email'`,
      )
      .all(companyId) as { detail: string }[];
    expect(trilha).toHaveLength(1);
    const detalhe = JSON.parse(trilha[0].detail) as Record<string, unknown>;
    expect(detalhe.comAnexo).toBe(false);
    expect(detalhe.bytes).toBe(PACOTE_GRANDE.length);
  });

  it('a rota HTTP devolve comAnexo: false — é isso que a tela mostra ao gerente', async () => {
    criarDestinatario({ companyId, name: 'Contador', email: 'contador@escritorio.com.br' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/closings/${PERIODO}/enviar`)
      .set(auth)
      .send({ idempotencyKey: 'clique-http' });

    expect(res.status).toBe(200);
    expect(res.body.comAnexo).toBe(false);
    expect(res.body.enfileirados).toBe(1);
  });
});
