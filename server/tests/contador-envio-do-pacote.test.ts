/**
 * ============================================================================
 * O PACOTE VAI ATÉ O CONTADOR — POR E-MAIL (GAP-V30) E POR AGENDA (GAP-V31)
 * ============================================================================
 *
 * Até esta rodada o mês só saía da empresa se alguém baixasse o zip e mandasse
 * por fora, ou se o contador entrasse e buscasse. Este arquivo cobra o caminho
 * que faltava, com as regras da casa:
 *
 *   - NUNCA envia direto: o envio ENFILEIRA no outbox de e-mail que já existe.
 *     Sem SMTP a fila acumula em `pending` — estado honesto, não entrega
 *     fingida. O carteiro é o MESMO dos outros e-mails; aqui só nasce o tipo
 *     novo (anexo) e o template.
 *   - O anexo é o MESMO zip do botão "Baixar": montado por `montarPacote` no
 *     instante do envio e guardado pronto na fila — o mesmo princípio do
 *     "montada no instante do fato" que o EmailService declara.
 *   - HISTÓRICO por empresa/competência, com o estado por envio derivado da
 *     fila (pendente/enviado/falhou) — nunca uma segunda máquina de estados.
 *   - AUDITORIA de quem mandou o mês para fora, como no download.
 *   - AGENDA por empresa (dia 1..28) com um tick idempotente por
 *     (empresa, competência): o mês não sai duas vezes nem quando o servidor
 *     passa o dia desligado e o tick roda atrasado.
 *
 * COMO CADA GUARDA FALHA (quebrando de propósito):
 *   - trocando o INSERT da fila por envio direto, o caso "sem SMTP acumula"
 *     fica vermelho — não há transporte nos testes;
 *   - tirando o `ON CONFLICT DO NOTHING` da fila, o tick rodado duas vezes
 *     duplica o e-mail e o caso da idempotência fica vermelho;
 *   - tirando o anexo do flush, o carteiro dublê recebe mensagem sem zip e o
 *     caso do anexo fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import {
  agendaDoContador,
  criarDestinatario,
  enviarPacotePorEmail,
  gravarAgendaDoContador,
  listarEnvios,
  runContadorScheduler,
  RESUMO_DO_MES,
} from '../src/services/core/ContadorEnvioService.js';
import { montarPacote, previaDoFechamento } from '../src/services/core/FiscalClosingService.js';
import {
  flushEmailQueue,
  queuePacoteContadorEmail,
  type CarteiroSmtp,
  type MensagemSmtp,
} from '../src/services/notifications/EmailService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { resetEnvCacheForTests } from '../src/config/env.js';

const app = createApp();
const PERIODO = '2026-07';

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-envio',
    companyId: 'preco-justo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Abre o zip pelo diretório central — o mesmo leitor de fechamento-contador. */
function abrirZip(zip: Buffer): Map<string, string> {
  const fim = zip.length - 22;
  expect(zip.readUInt32LE(fim)).toBe(0x06054b50);
  const entradas = zip.readUInt16LE(fim + 10);
  let cursor = zip.readUInt32LE(fim + 16);

  const saida = new Map<string, string>();
  for (let i = 0; i < entradas; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const tamanhoNome = zip.readUInt16LE(cursor + 28);
    const tamanhoExtra = zip.readUInt16LE(cursor + 30);
    const tamanhoComentario = zip.readUInt16LE(cursor + 32);
    const offsetLocal = zip.readUInt32LE(cursor + 42);
    const nome = zip.subarray(cursor + 46, cursor + 46 + tamanhoNome).toString('utf8');

    expect(zip.readUInt32LE(offsetLocal)).toBe(0x04034b50);
    const comprimido = zip.readUInt32LE(offsetLocal + 18);
    const nomeLocal = zip.readUInt16LE(offsetLocal + 26);
    const extraLocal = zip.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;

    saida.set(
      nome,
      inflateRawSync(zip.subarray(inicio, inicio + comprimido)).toString('utf8'),
    );
    cursor += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return saida;
}

function filaDeEmail() {
  return getConnection()
    .prepare(
      // O ANEXO DA MENSAGEM É O DO COFRE — o mesmo caminho que o carteiro
      // percorre. Os bytes deixaram de morar na linha da fila (uma cópia por
      // destinatário, até 15 MB cada); o que fica aqui é o nome e o ponteiro.
      // `anexo_blob` continua no COALESCE pela mensagem enfileirada ANTES do
      // cofre existir, que precisa sair inteira do mesmo jeito.
      `SELECT q.id, q.template, q.to_address, q.subject, q.body_text, q.status, q.dedupe_key,
              q.anexo_nome, COALESCE(a.conteudo, q.anexo_blob) AS anexo_conteudo
         FROM core_email_queue q
         LEFT JOIN core_email_attachments a ON a.id = q.anexo_id
        WHERE q.company_id = ? ORDER BY q.created_at, q.rowid`,
    )
    .all(companyId) as unknown as {
    id: string;
    template: string;
    to_address: string;
    subject: string;
    body_text: string;
    status: string;
    dedupe_key: string;
    anexo_nome: string | null;
    anexo_conteudo: Uint8Array | null;
  }[];
}

// ---------------------------------------------------------------------------
// Destinatários
// ---------------------------------------------------------------------------

describe('o cadastro de destinatários', () => {
  it('cria, lista e desativa pelo caminho da tela — com auditoria', async () => {
    const criado = await request(app)
      .post('/api/v1/core/fiscal/contador/destinatarios')
      .set(auth)
      .send({ name: 'Escritório Fagundes', email: 'fiscal@fagundes.cnt.br' });
    expect(criado.status).toBe(201);
    expect(criado.body.destinatario.email).toBe('fiscal@fagundes.cnt.br');

    const lista = await request(app)
      .get('/api/v1/core/fiscal/contador/destinatarios')
      .set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].active).toBe(true);

    const desativado = await request(app)
      .patch(`/api/v1/core/fiscal/contador/destinatarios/${criado.body.destinatario.id}`)
      .set(auth)
      .send({ active: false });
    expect(desativado.status).toBe(200);
    expect(desativado.body.destinatario.active).toBe(false);

    const trilha = getConnection()
      .prepare(
        `SELECT action FROM core_audit_log WHERE company_id = ? AND action LIKE 'contador.%'`,
      )
      .all(companyId) as { action: string }[];
    expect(trilha.map((t) => t.action)).toEqual(
      expect.arrayContaining(['contador.destinatario_created', 'contador.destinatario_updated']),
    );
  });

  it('endereço que não é endereço é recusado com erro legível', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/contador/destinatarios')
      .set(auth)
      .send({ name: 'Sem arroba', email: 'nao-e-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_CONTADOR_EMAIL_INVALIDO');
  });

  it('o contador não mexe no cadastro de quem recebe o mês — 403', async () => {
    const contador = await loginForTest(app, {
      userId: 'contador-1',
      companyId,
      profileCodes: ['contador'],
    });
    const res = await request(app)
      .get('/api/v1/core/fiscal/contador/destinatarios')
      .set({ Authorization: `Bearer ${contador.body.accessToken}` });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// O envio manual
// ---------------------------------------------------------------------------

describe('enviar o pacote por e-mail', () => {
  it('ENFILEIRA — nunca envia direto — com template pt-BR e o zip anexado', async () => {
    await request(app)
      .post('/api/v1/core/fiscal/contador/destinatarios')
      .set(auth)
      .send({ name: 'Contador', email: 'contador@escritorio.com.br' });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/closings/${PERIODO}/enviar`)
      .set(auth)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    expect(res.body.enfileirados).toBe(1);

    const fila = filaDeEmail();
    expect(fila).toHaveLength(1);
    // Sem SMTP configurado o estado honesto é PENDENTE — a fila acumula.
    expect(fila[0].status).toBe('pending');
    expect(fila[0].template).toBe('pacote_contador');
    expect(fila[0].to_address).toBe('contador@escritorio.com.br');
    // O template fala português de contador: competência e empresa no assunto.
    expect(fila[0].subject).toContain('julho de 2026');
    expect(fila[0].body_text).toContain('julho de 2026');
    expect(fila[0].body_text).toContain('LEIA-ME');
    // O anexo é o MESMO zip do botão de baixar, com o mesmo nome.
    expect(fila[0].anexo_nome).toBe('pacote-preco-justo-2026-07.zip');
    const dentro = abrirZip(Buffer.from(fila[0].anexo_conteudo!));
    expect(dentro.has('LEIA-ME.txt')).toBe(true);
    expect(dentro.has('resultado/dre.csv')).toBe(true);

    // A auditoria diz QUEM mandou o mês para fora — como no download.
    const trilha = getConnection()
      .prepare(
        `SELECT user_id, entity_id, detail FROM core_audit_log
          WHERE company_id = ? AND action = 'contador.pacote_email'`,
      )
      .all(companyId) as { user_id: string | null; entity_id: string; detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].entity_id).toBe(PERIODO);
    expect(trilha[0].user_id).toBeTruthy();
    expect(JSON.parse(trilha[0].detail).destinatarios).toBe(1);
  });

  /*
    O RESUMO DO E-MAIL CONTAVA SEIS DAS OITO COISAS QUE O MÊS TEM.

    A prévia partiu "compra recebida sem arquivo" em TRÊS fatos com nomes
    próprios — XML perdido, compra sem NF-e (entrada manual) e entrada
    estornada. O zip aprendeu os três, o LEIA-ME aprendeu os três, a tela
    aprendeu os três. O corpo do e-mail ficou com a lista de seis linhas
    escrita à mão de antes: o contador que só lê a mensagem via o mês de uma
    loja de feira como um mês SEM COMPRA NENHUMA, e as duas contagens novas
    não apareciam em lugar nenhum da caixa de entrada dele.

    É a armadilha da LISTA ESCRITA À MÃO, a mesma que já mordeu esta casa: um
    fato novo nasce no domínio e a lista velha continua respondendo, calada,
    pelo mundo que ela conhecia. O caso estrutural abaixo é o que fecha a
    porta — ele não confere DUAS linhas, confere que TODA contagem da prévia
    tem linha. Uma nona contagem, no dia em que existir, cai aqui.
  */
  it('o resumo do e-mail nomeia TODAS as contagens do mês — nenhuma fica de fora', async () => {
    await request(app)
      .post('/api/v1/core/fiscal/contador/destinatarios')
      .set(auth)
      .send({ name: 'Contador', email: 'contador@escritorio.com.br' });

    enviarPacotePorEmail({
      companyId,
      period: PERIODO,
      origem: 'manual',
      idempotencyKey: randomUUID(),
      userId: 'gerente-envio',
    });

    const corpo = filaDeEmail()[0].body_text;
    const previa = previaDoFechamento(companyId, PERIODO);

    // A CHAVE É A LISTA: toda contagem que a prévia carrega precisa de rótulo
    // no resumo, e o rótulo tem de estar no corpo. Se alguém acrescentar uma
    // contagem sem rótulo, o Record não compila; se acrescentar o rótulo e
    // esquecer a linha, este caso fica vermelho.
    for (const chave of Object.keys(previa.contagens)) {
      const rotulo = RESUMO_DO_MES[chave as keyof typeof RESUMO_DO_MES];
      expect(rotulo, `contagem sem rótulo no resumo do e-mail: ${chave}`).toBeTruthy();
      expect(corpo, `rótulo fora do corpo do e-mail: ${chave}`).toContain(rotulo);
    }

    // E as duas que estavam faltando, pelo nome que o contador vai ler.
    expect(corpo).toContain('Compras sem NF-e');
    expect(corpo).toContain('Entradas estornadas');
  });

  it('vai para TODOS os destinatários ativos — e só para os ativos', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    criarDestinatario({ companyId, name: 'B', email: 'b@x.com.br' });
    const c = criarDestinatario({ companyId, name: 'C', email: 'c@x.com.br' });
    await request(app)
      .patch(`/api/v1/core/fiscal/contador/destinatarios/${c.id}`)
      .set(auth)
      .send({ active: false });

    const r = enviarPacotePorEmail({
      companyId,
      period: PERIODO,
      origem: 'manual',
      idempotencyKey: 'k-1',
      userId: 'gerente',
    });
    expect(r.enfileirados).toBe(2);
    expect(filaDeEmail().map((f) => f.to_address).sort()).toEqual(['a@x.com.br', 'b@x.com.br']);
  });

  it('a MESMA chave de idempotência não duplica; uma chave nova reenvia de propósito', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });

    const primeira = enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'clique-1', userId: 'g',
    });
    const repetida = enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'clique-1', userId: 'g',
    });
    expect(primeira.enfileirados).toBe(1);
    // O clique repetido (retry de rede, clique duplo) não gera segundo e-mail.
    expect(repetida.enfileirados).toBe(0);
    expect(filaDeEmail()).toHaveLength(1);

    // Reenviar DE PROPÓSITO é legítimo — pacote é derivado e re-gerável.
    const reenvio = enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'clique-2', userId: 'g',
    });
    expect(reenvio.enfileirados).toBe(1);
    expect(filaDeEmail()).toHaveLength(2);
  });

  it('sem destinatário ativo o envio é recusado dizendo o que falta', async () => {
    const res = await request(app)
      .post(`/api/v1/core/fiscal/closings/${PERIODO}/enviar`)
      .set(auth)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_CONTADOR_SEM_DESTINATARIO');
  });

  it('o histórico por competência mostra cada envio com o estado da fila', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/envios`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      period: PERIODO,
      email: 'a@x.com.br',
      origem: 'manual',
      status: 'pendente',
    });
    // E diz, honesto, que o carteiro ainda não tem credencial.
    expect(res.body.carteiro.readiness).toBe('READY_FOR_CREDENTIAL');

    // Outro mês não vê este envio — o recorte é por competência.
    const outro = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-06/envios')
      .set(auth);
    expect(outro.body.items).toHaveLength(0);
  });

  it('quando o carteiro sai, o anexo viaja e o histórico vira "enviado"', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    // Credencial de mentira só para o flush andar; o transporte é o dublê.
    // `loadEnv` cacheia — o reset é o que faz o processo enxergar a mudança.
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
      expect(entregues[0].anexos).toHaveLength(1);
      expect(entregues[0].anexos![0].nome).toBe('pacote-preco-justo-2026-07.zip');
      expect(abrirZip(entregues[0].anexos![0].conteudo).has('LEIA-ME.txt')).toBe(true);

      const envios = listarEnvios(companyId, PERIODO);
      expect(envios.items[0].status).toBe('enviado');
    } finally {
      delete process.env.EMAIL_ENABLED;
      delete process.env.EMAIL_FROM;
      delete process.env.EMAIL_SMTP_HOST;
      delete process.env.EMAIL_SMTP_USER;
      delete process.env.EMAIL_SMTP_PASSWORD;
      // O próximo arquivo da suíte precisa ver o ambiente de sempre.
      resetEnvCacheForTests();
    }
  });

  it('período que não é AAAA-MM é recusado antes de montar qualquer coisa', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    const res = await request(app)
      .post('/api/v1/core/fiscal/closings/2026-13/enviar')
      .set(auth)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_PERIODO_INVALIDO');
  });

  it('o caixa não manda a contabilidade do mês para fora — 403', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-envio',
      companyId,
      profileCodes: ['operador_caixa_loja'],
    });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/closings/${PERIODO}/enviar`)
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` })
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// O TAMANHO DA FILA DENTRO DO BANCO OPERACIONAL
// ---------------------------------------------------------------------------

/*
  O DEFEITO, EM MEGABYTES.

  O zip do contador chega a 15 MB (ANEXO_TETO_BYTES) e era gravado DENTRO do
  SQLite operacional — que tem 6,2 MB inteiro. Duas metades somavam:

    1. UMA CÓPIA POR DESTINATÁRIO. O laço do envio chamava a fila com o MESMO
       `pacote.bytes` para cada destinatário ativo: três contadores = três
       cópias do mesmo blob na mesma competência.

    2. SEM RETENÇÃO NENHUMA. Não existia um só `DELETE FROM core_email_queue`
       no servidor; o flush só fazia UPDATE de status, e o anexo continuava lá
       DEPOIS de 'sent'. A agenda repete o gesto todo mês, para cada uma das
       seis empresas.

  As duas medidas abaixo são em BYTES, e não em número de linhas: linha é
  barata, blob não.
*/
function bytesDeAnexoNoBanco(): number {
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
  // O cofre de anexos nasce com o conserto; antes dele, esta metade é zero.
  const temCofre = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('core_email_attachments');
  const noCofre = temCofre
    ? Number(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(LENGTH(conteudo)), 0) AS b
                 FROM core_email_attachments WHERE company_id = ?`,
            )
            .get(companyId) as { b: number }
        ).b,
      )
    : 0;
  return naFila + noCofre;
}

function comCredencialDeMentira<T>(fn: () => Promise<T>): Promise<T> {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'loja@grupo.com.br';
  process.env.EMAIL_SMTP_HOST = 'smtp.local';
  process.env.EMAIL_SMTP_USER = 'loja';
  process.env.EMAIL_SMTP_PASSWORD = 'segredo';
  resetEnvCacheForTests();
  return fn().finally(() => {
    delete process.env.EMAIL_ENABLED;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_SMTP_HOST;
    delete process.env.EMAIL_SMTP_USER;
    delete process.env.EMAIL_SMTP_PASSWORD;
    resetEnvCacheForTests();
  });
}

describe('a fila não engorda o banco operacional', () => {
  it('três destinatários, UM zip guardado — e não três cópias do mesmo arquivo', () => {
    for (const nome of ['A', 'B', 'C']) {
      criarDestinatario({ companyId, name: nome, email: `${nome.toLowerCase()}@x.com.br` });
    }

    const r = enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });
    expect(r.enfileirados).toBe(3);

    const tamanhoDoPacote = montarPacote(companyId, PERIODO).bytes.length;
    expect(tamanhoDoPacote).toBeGreaterThan(0);
    // UMA cópia, não três. O e-mail de cada um continua carregando o mesmo
    // arquivo — o que deixou de existir é a triplicata no disco.
    expect(bytesDeAnexoNoBanco()).toBe(tamanhoDoPacote);
  });

  it('os três continuam recebendo o zip inteiro quando o carteiro sai', async () => {
    for (const nome of ['A', 'B', 'C']) {
      criarDestinatario({ companyId, name: nome, email: `${nome.toLowerCase()}@x.com.br` });
    }
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    await comCredencialDeMentira(async () => {
      const entregues: MensagemSmtp[] = [];
      const carteiro: CarteiroSmtp = {
        async enviar(msg) {
          entregues.push(msg);
        },
      };
      const resultado = await flushEmailQueue({ carteiro });
      expect(resultado.sent).toBe(3);
      expect(entregues).toHaveLength(3);
      for (const msg of entregues) {
        expect(msg.anexos).toHaveLength(1);
        expect(msg.anexos![0].nome).toBe('pacote-preco-justo-2026-07.zip');
        expect(abrirZip(msg.anexos![0].conteudo).has('LEIA-ME.txt')).toBe(true);
      }
    });
  });

  it('entregue o mês, os bytes saem do banco — e o histórico continua dizendo "enviado"', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });
    expect(bytesDeAnexoNoBanco()).toBeGreaterThan(0);

    await comCredencialDeMentira(async () => {
      const carteiro: CarteiroSmtp = { async enviar() {} };
      expect((await flushEmailQueue({ carteiro })).sent).toBe(1);
    });

    // A FAIXA DE RETENÇÃO: o anexo vive enquanto houver mensagem que ainda
    // possa sair. Entregue, os megabytes não têm mais função nenhuma.
    expect(bytesDeAnexoNoBanco()).toBe(0);

    // E nada do que a tela mostra se perdeu: estado, nome do arquivo, autor.
    const envios = listarEnvios(companyId, PERIODO);
    expect(envios.items).toHaveLength(1);
    expect(envios.items[0].status).toBe('enviado');
    expect(filaDeEmail()[0].anexo_nome).toBe('pacote-preco-justo-2026-07.zip');
  });

  it('o que ainda NÃO saiu guarda o anexo — pendente não se poda', () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k1', userId: 'g',
    });
    const guardado = bytesDeAnexoNoBanco();
    expect(guardado).toBeGreaterThan(0);

    // Um segundo envio da MESMA competência dispara a faxina — e ela não pode
    // levar o anexo do primeiro, que continua pendente. Sem credencial a fila
    // acumula: é o estado honesto da casa, e apagar o anexo de um pendente
    // entregaria um e-mail dizendo "segue anexo" sem anexo nenhum.
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k2', userId: 'g',
    });
    const fila = filaDeEmail();
    expect(fila).toHaveLength(2);
    // Duas mensagens pendentes do MESMO mês continuam custando UM zip.
    expect(bytesDeAnexoNoBanco()).toBe(guardado);
    // E as DUAS continuam com o arquivo em mãos. Esta é a asserção que pega a
    // faxina gulosa: apagar o anexo de um pendente não muda o total de bytes
    // (o envio seguinte regrava o mesmo conteúdo, no mesmo sha), mas deixa a
    // primeira mensagem prometendo um anexo que ela não tem mais.
    for (const mensagem of fila) {
      expect(mensagem.status).toBe('pending');
      expect(mensagem.anexo_nome).toBe('pacote-preco-justo-2026-07.zip');
      expect(mensagem.anexo_conteudo, 'pendente ficou sem o anexo').not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// O cofre é DA EMPRESA — e não nasce órfão
// ---------------------------------------------------------------------------

describe('a faxina do cofre respeita a fronteira da empresa', () => {
  /** Um anexo órfão plantado no cofre de OUTRA empresa. */
  function plantarOrfao(deQuem: string, bytes: Buffer): string {
    const id = `orfao-${deQuem}-${bytes.length}`;
    getConnection()
      .prepare(
        `INSERT INTO core_email_attachments (id, company_id, nome, size_bytes, conteudo, created_at)
         VALUES (?, ?, 'pacote-alheio.zip', ?, ?, ?)`,
      )
      .run(id, deQuem, bytes.length, bytes, new Date().toISOString());
    return id;
  }

  function existeNoCofre(id: string): boolean {
    return (
      getConnection()
        .prepare('SELECT 1 AS x FROM core_email_attachments WHERE id = ?')
        .get(id) !== undefined
    );
  }

  it('o gesto de UMA empresa não apaga o cofre da outra', () => {
    /*
      O DEFEITO: `liberarAnexosSemDono` varria o cofre INTEIRO, sem filtro de
      empresa, disparada por uma operação com escopo de empresa (o envio do
      pacote começa por ela). Não vaza dado — só apaga órfão —, mas é escrita
      cross-tenant num sistema cuja regra é `companyId` SEMPRE do token: a
      Gringa manda o mês dela e o cofre da Preço Justo encolhe junto.

      E "só órfão" não é conforto: órfão é o que ESTA consulta considera órfão,
      e ela roda com o conhecimento de uma empresa sobre o banco de seis.
    */
    const outra = upsertCompany({
      slug: 'gringa-cofre',
      legalName: 'Gringa Modas Ltda',
      tradeName: 'Gringa',
    });
    const alheio = plantarOrfao(outra, Buffer.from('zip da outra empresa'));
    expect(existeNoCofre(alheio)).toBe(true);

    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    expect(
      existeNoCofre(alheio),
      'o envio de uma empresa apagou anexo do cofre de outra — escrita cross-tenant',
    ).toBe(true);
  });

  it('e continua fazendo a faxina DENTRO da própria empresa', () => {
    // O conserto não pode virar "nunca mais limpa nada": o órfão da própria
    // empresa é exatamente o que esta faxina existe para levar.
    const meuOrfao = plantarOrfao(companyId, Buffer.from('zip velho meu'));
    expect(existeNoCofre(meuOrfao)).toBe(true);

    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    enviarPacotePorEmail({
      companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k', userId: 'g',
    });

    expect(existeNoCofre(meuOrfao), 'a faxina parou de limpar a própria casa').toBe(false);
  });

  it('mensagem DESCARTADA pelo dedupe não deixa anexo órfão para trás', () => {
    /*
      O DEFEITO (a borda que ninguém tinha medido): em
      `queuePacoteContadorEmail` os bytes iam para o cofre ANTES do INSERT, que
      é `ON CONFLICT (dedupe_key) DO NOTHING`. Se dois envios da mesma
      competência produzissem bytes DIFERENTES — um carimbo de tempo dentro do
      zip basta —, o segundo gravava um anexo com sha novo cujo INSERT de
      mensagem era descartado. Nascia um órfão na hora, coletado só na PRÓXIMA
      passagem da faxina; e como a faxina agora é por empresa, "próxima
      passagem" pode ser no mês seguinte.

      O conserto é a ordem: guardar DEPOIS de saber que a mensagem entrou.
    */
    const primeiro = queuePacoteContadorEmail({
      companyId,
      toAddress: 'a@x.com.br',
      subject: 'Pacote 2026-07',
      bodyText: 'segue o mês',
      anexoNome: 'pacote.zip',
      anexoBytes: Buffer.from('zip da primeira montagem'),
      payload: { tipo: 'pacote_contador' },
      dedupeKey: 'contador-pacote:manual:x:2026-07:d1',
    });
    expect(primeiro).not.toBeNull();
    const depoisDoPrimeiro = bytesDeAnexoNoBanco();
    expect(depoisDoPrimeiro).toBeGreaterThan(0);

    // MESMA chave, bytes diferentes: a mensagem é descartada pelo dedupe.
    const segundo = queuePacoteContadorEmail({
      companyId,
      toAddress: 'a@x.com.br',
      subject: 'Pacote 2026-07',
      bodyText: 'segue o mês',
      anexoNome: 'pacote.zip',
      anexoBytes: Buffer.from('zip da segunda montagem, com outro carimbo'),
      payload: { tipo: 'pacote_contador' },
      dedupeKey: 'contador-pacote:manual:x:2026-07:d1',
    });

    expect(segundo, 'a chave repetida enfileirou de novo').toBeNull();
    expect(
      bytesDeAnexoNoBanco(),
      'o anexo da mensagem descartada ficou no cofre sem dono nenhum',
    ).toBe(depoisDoPrimeiro);
    expect(
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_email_attachments WHERE company_id = ?')
        .get(companyId),
    ).toEqual({ n: 1 });

    // E a mensagem que VENCEU continua com o arquivo dela em mãos.
    const fila = filaDeEmail();
    expect(fila).toHaveLength(1);
    expect(fila[0].anexo_conteudo, 'a mensagem que entrou ficou sem anexo').not.toBeNull();
    expect(Buffer.from(fila[0].anexo_conteudo!).toString('utf8')).toBe(
      'zip da primeira montagem',
    );
  });
});

// ---------------------------------------------------------------------------
// A agenda (GAP-V31)
// ---------------------------------------------------------------------------

describe('o agendamento recorrente', () => {
  it('a agenda aceita dia 1..28 e recusa o resto — 29 não existe em fevereiro', async () => {
    const ok = await request(app)
      .put('/api/v1/core/fiscal/contador/agenda')
      .set(auth)
      .send({ dayOfMonth: 5, active: true });
    expect(ok.status).toBe(200);
    expect(ok.body.agenda).toMatchObject({ dayOfMonth: 5, active: true });

    const lida = await request(app).get('/api/v1/core/fiscal/contador/agenda').set(auth);
    expect(lida.body.agenda.dayOfMonth).toBe(5);

    for (const ruim of [0, 29, 31, 1.5]) {
      const res = await request(app)
        .put('/api/v1/core/fiscal/contador/agenda')
        .set(auth)
        .send({ dayOfMonth: ruim, active: true });
      expect(res.status, `dia ${ruim}`).toBe(400);
      expect(res.body.error.code).toBe('CORE_CONTADOR_AGENDA_DIA_INVALIDO');
    }
  });

  it('no dia (ou depois dele), o tick envia a competência ANTERIOR aos ativos', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    gravarAgendaDoContador({ companyId, dayOfMonth: 5, active: true });

    // Dia 10 de agosto na loja: o fechamento que sai é o de JULHO — o mês
    // corrente ainda está acontecendo e não tem como estar completo.
    const r = await runContadorScheduler(new Date('2026-08-10T15:00:00.000Z'));
    expect(r.enviados).toBe(1);

    const fila = filaDeEmail();
    expect(fila).toHaveLength(1);
    expect(fila[0].subject).toContain('julho de 2026');
    expect(fila[0].status).toBe('pending');

    const envios = listarEnvios(companyId, '2026-07');
    expect(envios.items).toHaveLength(1);
    expect(envios.items[0].origem).toBe('agenda');
  });

  it('o tick é idempotente por (empresa, competência): rodar de novo não duplica', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    gravarAgendaDoContador({ companyId, dayOfMonth: 5, active: true });

    await runContadorScheduler(new Date('2026-08-10T15:00:00.000Z'));
    // O servidor reiniciou no mesmo dia; o tick roda de novo.
    await runContadorScheduler(new Date('2026-08-10T18:00:00.000Z'));
    // E de novo, dias depois, dentro do mesmo mês.
    await runContadorScheduler(new Date('2026-08-20T15:00:00.000Z'));

    expect(filaDeEmail()).toHaveLength(1);
    expect(listarEnvios(companyId, '2026-07').items).toHaveLength(1);
  });

  it('antes do dia configurado, nada sai; no mês seguinte, sai a competência nova', async () => {
    criarDestinatario({ companyId, name: 'A', email: 'a@x.com.br' });
    gravarAgendaDoContador({ companyId, dayOfMonth: 5, active: true });

    const cedo = await runContadorScheduler(new Date('2026-08-03T15:00:00.000Z'));
    expect(cedo.enviados).toBe(0);
    expect(filaDeEmail()).toHaveLength(0);

    await runContadorScheduler(new Date('2026-08-10T15:00:00.000Z'));
    // Setembro, dia 3: antes do dia 5 — a competência de agosto ainda espera.
    const setembroCedo = await runContadorScheduler(new Date('2026-09-03T15:00:00.000Z'));
    expect(setembroCedo.enviados).toBe(0);
    // Setembro, dia 5: sai agosto.
    const setembro = await runContadorScheduler(new Date('2026-09-05T15:00:00.000Z'));
    expect(setembro.enviados).toBe(1);

    const assuntos = filaDeEmail().map((f) => f.subject);
    expect(assuntos.some((s) => s.includes('julho de 2026'))).toBe(true);
    expect(assuntos.some((s) => s.includes('agosto de 2026'))).toBe(true);
    expect(filaDeEmail()).toHaveLength(2);
  });

  it('agenda desligada (ou sem destinatário) não dispara — e o erro fica anotado na agenda', async () => {
    gravarAgendaDoContador({ companyId, dayOfMonth: 5, active: false });
    const nada = await runContadorScheduler(new Date('2026-08-10T15:00:00.000Z'));
    expect(nada.enviados).toBe(0);

    // Ligada mas sem ninguém para receber: o tick não fabrica envio; anota.
    gravarAgendaDoContador({ companyId, dayOfMonth: 5, active: true });
    const semDestinatario = await runContadorScheduler(new Date('2026-08-10T15:00:00.000Z'));
    expect(semDestinatario.enviados).toBe(0);
    expect(semDestinatario.falhas).toBe(1);
    expect(filaDeEmail()).toHaveLength(0);

    const agenda = agendaDoContador(companyId);
    expect(agenda?.lastError).toMatch(/destinatário/i);
    // A competência NÃO foi marcada como enviada: quando o cadastro existir,
    // o próximo tick entrega o mês que ficou devendo.
    expect(agenda?.lastSentPeriod).toBeNull();
  });
});
