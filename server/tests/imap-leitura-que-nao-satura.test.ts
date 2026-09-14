/**
 * ============================================================================
 * A CAIXA DE NF-e POR E-MAIL NÃO ENTOPE (GAP-PRD-035)
 * ============================================================================
 *
 * O QUE ERA:
 *   `checkInbox` pedia `fetch({ seen: false })` e parava na 25ª. O imapflow lê
 *   com BODY.PEEK — baixar não marca como lida — e nada chamava `\Seen`. Com
 *   30 não lidas na caixa (boleto, propaganda, nota), toda leitura via as
 *   MESMAS 25 mais antigas; a 26ª nunca entrava, e a tela dizia "Nenhuma
 *   mensagem nova" / "25 mensagem(ns), 0 nota(s)". O canal parava em silêncio.
 *
 * O QUE ESTE ARQUIVO TRAVA:
 *   - o sistema lembra ONDE PAROU (último UID por UIDVALIDITY): cada mensagem é
 *     lida uma vez, e a leitura seguinte começa depois dela;
 *   - depois de processada, a mensagem é marcada como lida (padrão), movida
 *     para uma pasta, ou deixada como está — escolha da empresa, com tela;
 *   - a leitura diz quantas ainda restam, e o agendador volta em 1 minuto
 *     enquanto houver fila na caixa;
 *   - uma mensagem problemática (grande demais, apagada no meio) não trava o
 *     canal; marcar como lida que falha não reprocessa nada;
 *   - nenhum comando IMAP roda dentro do laço do `fetch` (trava o imapflow).
 *
 * O IMAP é o dublê de `tests/helpers/imapFalso.ts` — com BODY.PEEK, a regra
 * do `N:*` e a trava do laço reproduzidas — e o `mailparser` é o real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

vi.mock('imapflow', async () => (await import('./helpers/imapFalso.js')).moduloImapFalso);

const imap = await import('./helpers/imapFalso.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { listNotes } = await import('../src/services/core/NfeImportService.js');
const { checkInbox, getInboxStatus, processIncomingMail, upsertInbox } = await import(
  '../src/services/core/MailInboxService.js'
);
const { runScheduledSync, setSchedule } = await import('../src/services/core/MailInboxScheduler.js');

const SENHA = 'senha-de-aplicativo-imap-falsa';
let companyId: string;
let userId: string;

/** Chave de 44 dígitos distinta por número. */
function chave(n: number): string {
  return String(n).padStart(2, '0').repeat(22);
}

function nfeXml(n: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe${chave(n)}" versao="4.00">
    <ide><nNF>${n}</nNF><dhEmi>2026-09-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>FORNECEDOR IMAP</xNome></emit>
    <det nItem="1"><prod>
      <cProd>F-${n}</cProd><cEAN>7891234567895</cEAN><xProd>ITEM ${n}</xProd>
      <uCom>UN</uCom><qCom>1</qCom><vUnCom>10.00</vUnCom><vProd>10.00</vProd>
    </prod></det>
  </infNFe></NFe>
</nfeProc>`;
}

function propaganda(n: number): Buffer {
  return imap.emailCru({ assunto: `Oferta ${n}`, de: 'promo@loja-qualquer.com' });
}

function nota(n: number): Buffer {
  return imap.emailCru({
    assunto: `NF-e ${n}`,
    anexo: { nome: `nfe-${n}.xml`, conteudo: nfeXml(n) },
  });
}

function mensagensGravadas(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) n FROM core_mail_messages').get() as { n: number }
  ).n;
}

function notas(): string[] {
  return listNotes(companyId).map((n) => n.access_key as string);
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  imap.reiniciarImap();
  companyId = upsertCompany({ slug: 'preco-justo-imap', legalName: 'Preço Justo', tradeName: 'Preço Justo' });
  userId = await upsertUser({ login: 'GERENTE-IMAP', displayName: 'Gerente', password: 'senha-teste-123' });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  upsertInbox({ companyId, address: 'notas@loja.com.br', host: 'imap.exemplo.test', password: SENHA });
});

describe('30 não lidas na caixa (o cenário da auditoria)', () => {
  it('duas leituras seguidas processam as 30 — e a 26ª NF-e entra', async () => {
    for (let i = 1; i <= 25; i += 1) imap.entregar(propaganda(i));
    for (let i = 26; i <= 30; i += 1) imap.entregar(nota(i));

    const primeira = await checkInbox({ companyId, userId });
    const segunda = await checkInbox({ companyId, userId });

    expect(primeira.checked).toBe(25);
    expect(segunda.checked).toBe(5);
    expect(mensagensGravadas()).toBe(30);
    expect(notas()).toContain(chave(26));
    expect(notas()).toHaveLength(5);
  });
});

describe('cada mensagem é lida uma vez, e o que se faz com ela é escolha da empresa', () => {
  it('padrão: depois de processada, a mensagem fica marcada como lida — só as processadas', async () => {
    for (let i = 1; i <= 27; i += 1) imap.entregar(i === 27 ? nota(27) : propaganda(i));

    const r = await checkInbox({ companyId, userId });

    expect(r.depoisDeLer).toBe('lida');
    expect(r.checked).toBe(25);
    expect(r.restantes).toBe(2);
    for (let uid = 1; uid <= 25; uid += 1) expect(imap.lida(uid)).toBe(true);
    // As que ficaram para a próxima leitura continuam como estavam.
    expect(imap.lida(26)).toBe(false);
    expect(imap.lida(27)).toBe(false);
  });

  it('o sistema lembra onde parou: a nota que alguém já abriu no Gmail entra do mesmo jeito', async () => {
    imap.entregar(propaganda(1));
    await checkInbox({ companyId, userId });

    // Chega a nota e alguém a abre no celular antes de o sistema passar.
    imap.entregar(nota(2), { lida: true });
    const r = await checkInbox({ companyId, userId });

    expect(r.checked).toBe(1);
    expect(notas()).toEqual([chave(2)]);
  });

  it('"não mexer na caixa": nenhuma marca muda, e a leitura seguinte não repete nada', async () => {
    upsertInbox({
      companyId,
      address: 'notas@loja.com.br',
      host: 'imap.exemplo.test',
      afterRead: 'manter',
    });
    imap.entregar(propaganda(1));
    imap.entregar(nota(2));

    const primeira = await checkInbox({ companyId, userId });
    expect(primeira.depoisDeLer).toBe('manter');
    expect(primeira.checked).toBe(2);
    expect(imap.lida(1)).toBe(false);
    expect(imap.lida(2)).toBe(false);
    expect(imap.estadoImap.comandos.some((c) => c.startsWith('STORE'))).toBe(false);

    const segunda = await checkInbox({ companyId, userId });
    expect(segunda.checked).toBe(0);
    expect(mensagensGravadas()).toBe(2);

    imap.entregar(nota(3));
    const terceira = await checkInbox({ companyId, userId });
    expect(terceira.checked).toBe(1);
    expect(notas().sort()).toEqual([chave(2), chave(3)].sort());
  });

  it('"mover para a pasta": a processada sai da caixa de entrada — e a pasta é criada se não existe', async () => {
    upsertInbox({
      companyId,
      address: 'notas@loja.com.br',
      host: 'imap.exemplo.test',
      afterRead: 'mover',
      processedFolder: 'Notas processadas',
    });
    imap.entregar(nota(1));
    imap.entregar(propaganda(2));

    const r = await checkInbox({ companyId, userId });

    expect(r.depoisDeLer).toBe('mover');
    expect(r.checked).toBe(2);
    expect(imap.mensagensDa('INBOX')).toHaveLength(0);
    expect(imap.mensagensDa('Notas processadas')).toHaveLength(2);
    expect(notas()).toEqual([chave(1)]);
  });

  it('mover sem pasta, ou para a própria pasta lida, é recusado na configuração', () => {
    expect(() =>
      upsertInbox({ companyId, address: 'notas@loja.com.br', host: 'imap.exemplo.test', afterRead: 'mover' }),
    ).toThrow(/pasta/i);
    expect(() =>
      upsertInbox({
        companyId,
        address: 'notas@loja.com.br',
        host: 'imap.exemplo.test',
        afterRead: 'mover',
        processedFolder: 'inbox',
      }),
    ).toThrow(/diferente/i);
    expect(() =>
      upsertInbox({ companyId, address: 'notas@loja.com.br', host: 'imap.exemplo.test', afterRead: 'apagar' }),
    ).toThrow(/marcar como lida/i);
  });
});

describe('o protocolo não engana o cursor', () => {
  it('UID N:* além do último não relê a última mensagem para sempre', async () => {
    imap.entregar(nota(1));
    await checkInbox({ companyId, userId });
    imap.estadoImap.downloads = [];

    const r = await checkInbox({ companyId, userId });
    const r2 = await checkInbox({ companyId, userId });

    // O servidor devolveu o UID 1 para `2:*` — e ele foi descartado.
    expect(imap.estadoImap.comandos).toContain('SEARCH {"uid":"2:*"}');
    expect(r.checked + r2.checked).toBe(0);
    expect(imap.estadoImap.downloads).toEqual([]);
    expect(mensagensGravadas()).toBe(1);
  });

  it('nenhum comando roda dentro do laço de um fetch (no imapflow isso trava a conexão)', async () => {
    for (let i = 1; i <= 3; i += 1) imap.entregar(nota(i));
    // O dublê LANÇA se um comando rodar com um fetch em curso: chegar ao fim
    // com as três notas é a prova.
    const r = await checkInbox({ companyId, userId });
    expect(r.checked).toBe(3);
    expect(notas()).toHaveLength(3);
    expect(imap.estadoImap.comandos.filter((c) => c.startsWith('STORE'))).toHaveLength(3);
  });

  it('UIDVALIDITY mudou (pasta recriada): o UID repetido é outra mensagem, e ela entra', async () => {
    imap.entregar(nota(1));
    await checkInbox({ companyId, userId });

    // O provedor recriou a pasta: UIDs recomeçam, validade nova.
    imap.estadoImap.uidValidity = 9002n;
    imap.estadoImap.pastas.set('INBOX', { uidNext: 1, msgs: [] });
    imap.entregar(nota(2)); // UID 1 de novo — mas é outra mensagem

    const r = await checkInbox({ companyId, userId });
    expect(r.checked).toBe(1);
    expect(notas().sort()).toEqual([chave(1), chave(2)].sort());
  });

  it('caixa sem nada não lido na primeira leitura: o cursor começa no fim, e o que chega depois entra', async () => {
    imap.entregar(propaganda(1), { lida: true });
    imap.entregar(propaganda(2), { lida: true });

    const primeira = await checkInbox({ companyId, userId });
    expect(primeira.checked).toBe(0);

    imap.entregar(nota(3), { lida: true });
    const segunda = await checkInbox({ companyId, userId });
    expect(segunda.checked).toBe(1);
    expect(notas()).toEqual([chave(3)]);
  });

  it('a caixa antiga (UID sem validade) não reprocessa o que já tinha visto', async () => {
    // Formato de antes: provider_uid = só o UID.
    const inboxId = String(
      (
        getConnection().prepare('SELECT id FROM core_mail_inboxes WHERE company_id = ?').get(companyId) as {
          id: string;
        }
      ).id,
    );
    imap.entregar(nota(1));
    imap.entregar(nota(2));
    processIncomingMail({
      companyId,
      userId,
      inboxId,
      mail: { uid: '1', attachments: [{ filename: 'nfe-1.xml', content: nfeXml(1) }] },
    });

    const r = await checkInbox({ companyId, userId });

    expect(r.checked).toBe(2);
    expect(mensagensGravadas()).toBe(2); // a do UID 1 não foi gravada de novo
    expect(imap.estadoImap.downloads).toEqual([2]); // e nem baixada
    const chaves = (
      getConnection().prepare('SELECT provider_uid FROM core_mail_messages ORDER BY provider_uid').all() as {
        provider_uid: string;
      }[]
    ).map((m) => m.provider_uid);
    expect(chaves).toEqual(['7001:1@INBOX', '7001:2@INBOX']);
  });
});

describe('uma mensagem problemática não entope o canal de novo', () => {
  it('mensagem grande demais: registrada com o motivo, não baixada, e a nota seguinte entra', async () => {
    const grande = imap.entregar(propaganda(1));
    imap.mensagensDa()[0].tamanho = 80 * 1024 * 1024;
    imap.entregar(nota(2));

    const r = await checkInbox({ companyId, userId });

    expect(r.checked).toBe(2);
    expect(imap.estadoImap.downloads).not.toContain(grande);
    expect(r.results[0].outcome).toBe('ilegivel');
    expect(r.results[0].detail).toMatch(/80 MB.*upload manual/);
    expect(notas()).toEqual([chave(2)]);
  });

  it('mensagem apagada entre a busca e o download: pulada, sem travar', async () => {
    imap.entregar(nota(1));
    imap.entregar(nota(2));
    imap.mensagensDa()[0].sumiu = true;

    const r = await checkInbox({ companyId, userId });
    expect(r.checked).toBe(1);
    expect(notas()).toEqual([chave(2)]);

    const depois = await checkInbox({ companyId, userId });
    expect(depois.checked).toBe(0);
  });

  it('o provedor não deixa marcar como lida: a nota entra, vira aviso, e nada é lido de novo', async () => {
    imap.estadoImap.somenteLeitura = true;
    imap.entregar(nota(1));

    const r = await checkInbox({ companyId, userId });
    expect(notas()).toEqual([chave(1)]);
    expect(r.avisos.join(' ')).toMatch(/não deixou marcar a mensagem como lida.*lembra onde parou/);

    const depois = await checkInbox({ companyId, userId });
    expect(depois.checked).toBe(0);
    expect(mensagensGravadas()).toBe(1);
  });
});

describe('a situação da caixa diz quantas faltam', () => {
  it('depois de uma leitura com sobra, a caixa diz quantas ficaram', async () => {
    for (let i = 1; i <= 28; i += 1) imap.entregar(propaganda(i));
    await checkInbox({ companyId, userId });

    const s = getInboxStatus(companyId);
    expect(s.inbox?.imap_pending).toBe(3);
    expect(s.message).toMatch(/Ainda há 3 mensagem\(ns\)/);
    expect(s.inbox?.after_read).toBe('lida');
    // O "onde parou" é interno: a validade não sai pela API, nem o segredo.
    expect(s.inbox).not.toHaveProperty('imap_uid_validity');
    expect(s.inbox).not.toHaveProperty('secret_cipher');
  });

  it('trocar a pasta lida zera o "onde parou" (o UID de uma pasta não vale em outra)', async () => {
    imap.estadoImap.pastas.set('Fornecedores', { uidNext: 1, msgs: [] });
    imap.entregar(nota(1));
    await checkInbox({ companyId, userId });

    upsertInbox({ companyId, address: 'notas@loja.com.br', host: 'imap.exemplo.test', folder: 'Fornecedores' });
    imap.entregar(nota(2), { pasta: 'Fornecedores' });

    const r = await checkInbox({ companyId, userId });
    expect(r.checked).toBe(1);
    expect(notas().sort()).toEqual([chave(1), chave(2)].sort());
  });
});

describe('o agendador acompanha a fila da caixa', () => {
  it('sobrou mensagem: volta em 1 minuto e diz quantas; zerou: volta no intervalo', async () => {
    for (let i = 1; i <= 25; i += 1) imap.entregar(propaganda(i));
    for (let i = 26; i <= 30; i += 1) imap.entregar(nota(i));
    setSchedule({ companyId, userId, enabled: true, intervalMinutes: 15 });

    // setSchedule agenda a primeira leitura para o relógio de verdade.
    const t0 = new Date(Date.now() + 1_000);
    const mais = (base: Date, min: number) => new Date(base.getTime() + min * 60_000).toISOString();
    await runScheduledSync(t0);
    let linha = getConnection()
      .prepare('SELECT next_run_at, last_result FROM core_mail_inboxes WHERE company_id = ?')
      .get(companyId) as { next_run_at: string; last_result: string };
    expect(linha.next_run_at).toBe(mais(t0, 1));
    expect(linha.last_result).toMatch(/25 mensagem\(ns\), 0 nota\(s\).*Ainda há 5 na caixa/);

    const t1 = new Date(t0.getTime() + 60_000);
    const r = await runScheduledSync(t1);
    expect(r.imported).toBe(5);
    linha = getConnection()
      .prepare('SELECT next_run_at, last_result FROM core_mail_inboxes WHERE company_id = ?')
      .get(companyId) as { next_run_at: string; last_result: string };
    expect(linha.next_run_at).toBe(mais(t1, 15));
    expect(linha.last_result).toBe('5 mensagem(ns), 5 nota(s) em conferência.');
    expect(notas()).toHaveLength(5);
  });
});

describe('a rota', () => {
  it('POST /core/mail/check devolve quantas restam; o corpo não troca a empresa da caixa', async () => {
    const { createApp } = await import('../src/app.js');
    const { loginForTest } = await import('./helpers/auth.js');
    const request = (await import('supertest')).default;
    const app = createApp();

    const login = await loginForTest(app, {
      userId: 'ger-rota-imap',
      companyId: 'empresa-rota-imap',
      profileCodes: ['gerente_loja'],
    });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

    // Tenta gravar a caixa na empresa do beforeEach pelo corpo: não pode.
    const salvo = await request(app)
      .post('/api/v1/core/mail/inbox')
      .set(auth)
      .send({ companyId, address: 'outra@loja.com.br', host: 'imap.exemplo.test', password: SENHA });
    expect(salvo.status).toBe(201);
    const daEmpresaDoBeforeEach = getInboxStatus(companyId);
    expect(daEmpresaDoBeforeEach.inbox?.address).toBe('notas@loja.com.br');
    expect(getInboxStatus('empresa-rota-imap').inbox?.address).toBe('outra@loja.com.br');

    for (let i = 1; i <= 26; i += 1) imap.entregar(propaganda(i));
    const r = await request(app).post('/api/v1/core/mail/check').set(auth);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checked).toBe(25);
    expect(r.body.restantes).toBe(1);
    expect(r.body.depoisDeLer).toBe('lida');

    const invalido = await request(app)
      .post('/api/v1/core/mail/inbox')
      .set(auth)
      .send({ address: 'outra@loja.com.br', host: 'imap.exemplo.test', afterRead: 'apagar' });
    expect(invalido.status).toBe(400);
    expect(invalido.body.error?.code ?? invalido.body.code).toBe('CORE_MAIL_AFTER_READ_INVALID');
  });
});
