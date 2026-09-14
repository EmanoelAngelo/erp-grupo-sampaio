/**
 * Leitura automática da caixa de e-mail.
 *
 * O que estes testes protegem:
 *
 *   EXECUÇÃO ÚNICA  duas instâncias do servidor não leem a mesma caixa ao
 *                   mesmo tempo;
 *   RECUPERAÇÃO     se o processo morre no meio, a trava vence e a próxima
 *                   execução assume — sem intervenção manual;
 *   NADA DUPLICA    retomar não reprocessa; a chave da NF-e continua sendo a
 *                   defesa, venha a nota do agendador, do botão ou do upload.
 *
 * A conexão IMAP é substituída por um duplo: o objetivo aqui é a mecânica do
 * agendador, não o protocolo de e-mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { ApiError } = await import('../src/utils/errors.js');
const { listAudit } = await import('../src/services/audit/AuditService.js');
const { listNotes } = await import('../src/services/core/NfeImportService.js');
const MailInboxService = await import('../src/services/core/MailInboxService.js');
const {
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  getSchedulerSettings,
  runScheduledSync,
  setSchedule,
} = await import('../src/services/core/MailInboxScheduler.js');

let companyId: string;
let userId: string;
let inboxId: string;

const CHAVE = '5'.repeat(44);

function nfeXml(chave: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe${chave}" versao="4.00">
    <ide><nNF>777</nNF><dhEmi>2026-08-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>FORNECEDOR</xNome></emit>
    <det nItem="1"><prod>
      <cProd>F-1</cProd><cEAN>7891234567895</cEAN><xProd>ITEM</xProd>
      <uCom>UN</uCom><qCom>3</qCom><vUnCom>10.00</vUnCom><vProd>30.00</vProd>
    </prod></det>
  </infNFe></NFe>
</nfeProc>`;
}

/** Substitui a conexão IMAP: aqui interessa a mecânica, não o protocolo. */
function fingirLeitura(resultado: 'sucesso' | 'erro' | 'vazio' = 'sucesso') {
  return vi.spyOn(MailInboxService, 'checkInbox').mockImplementation(async (input) => {
    if (resultado === 'erro') {
      throw new ApiError('CORE_MAIL_CONNECTION_FAILED', 'Não foi possível ler a caixa.', 502);
    }
    if (resultado === 'vazio') return { checked: 0, results: [] };

    const registro = MailInboxService.processIncomingMail({
      companyId: input.companyId,
      userId: input.userId,
      inboxId,
      mail: {
        uid: 'uid-agendado',
        subject: 'NF-e 777',
        from: 'fornecedor@exemplo.com',
        attachments: [{ filename: 'nfe.xml', content: nfeXml(CHAVE) }],
      },
    });
    return { checked: 1, results: [registro] };
  });
}

function estadoBruto() {
  return getConnection()
    .prepare('SELECT locked_until, locked_by, next_run_at FROM core_mail_inboxes WHERE id = ?')
    .get(inboxId) as { locked_until: string | null; locked_by: string | null; next_run_at: string | null };
}

function travar(ate: Date, quem = 'outro-processo') {
  getConnection()
    .prepare('UPDATE core_mail_inboxes SET locked_until = ?, locked_by = ? WHERE id = ?')
    .run(ate.toISOString(), quem, inboxId);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  userId = await upsertUser({
    login: 'GERENTE',
    displayName: 'Gerente',
    password: 'senha-teste-123',
  });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);

  const status = MailInboxService.upsertInbox({
    companyId,
    address: 'notas@grupossampaio.com.br',
    host: 'imap.exemplo.com',
    password: 'senha-de-aplicativo',
  });
  inboxId = status.inbox!.id;
});

describe('ligar e desligar', () => {
  it('nasce desligada', () => {
    const s = getSchedulerSettings(companyId)!;
    expect(s.autoEnabled).toBe(false);
    expect(s.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  it('ligar agenda a primeira leitura para agora', () => {
    const s = setSchedule({ companyId, userId, enabled: true });
    expect(s.autoEnabled).toBe(true);
    // Quem acabou de ativar espera ver resultado, não daqui a 5 minutos.
    expect(new Date(s.nextRunAt!).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('desligar limpa o próximo agendamento', () => {
    setSchedule({ companyId, userId, enabled: true });
    const s = setSchedule({ companyId, userId, enabled: false });
    expect(s.autoEnabled).toBe(false);
    expect(s.nextRunAt).toBeNull();
  });

  it('o intervalo é configurável, com piso', () => {
    expect(setSchedule({ companyId, userId, enabled: true, intervalMinutes: 30 }).intervalMinutes).toBe(30);
    // Intervalo zero marteladaria o provedor.
    expect(setSchedule({ companyId, userId, enabled: true, intervalMinutes: 0 }).intervalMinutes).toBe(
      MIN_INTERVAL_MINUTES,
    );
  });

  it('não liga sem senha — agendaria uma falha a cada intervalo', () => {
    getConnection()
      .prepare('UPDATE core_mail_inboxes SET secret_cipher = NULL WHERE id = ?')
      .run(inboxId);
    expect(() => setSchedule({ companyId, userId, enabled: true })).toThrowError(/senha/i);
  });

  it('não liga sem caixa configurada', () => {
    MailInboxService.removeInbox(companyId);
    expect(() => setSchedule({ companyId, userId, enabled: true })).toThrowError(/Configure a caixa/i);
  });

  it('ligar e desligar ficam na auditoria', () => {
    setSchedule({ companyId, userId, enabled: true });
    setSchedule({ companyId, userId, enabled: false });
    const acoes = (listAudit(companyId, { limit: 20 }).items as unknown as { action: string }[]).map((a) => a.action);
    expect(acoes).toContain('mail.scheduler_enabled');
    expect(acoes).toContain('mail.scheduler_disabled');
  });
});

describe('execução', () => {
  it('desligada não roda', async () => {
    const spy = fingirLeitura();
    const r = await runScheduledSync();
    expect(r.claimed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ligada e vencida, roda e importa', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });

    const r = await runScheduledSync();
    expect(r.claimed).toBe(1);
    expect(r.imported).toBe(1);
    expect(listNotes(companyId)).toHaveLength(1);
  });

  it('não roda antes da hora', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true, intervalMinutes: 10 });
    await runScheduledSync();

    // A segunda passada, no mesmo instante, encontra a caixa reagendada.
    const segunda = await runScheduledSync();
    expect(segunda.claimed).toBe(0);
  });

  it('roda de novo depois do intervalo', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true, intervalMinutes: 5 });
    await runScheduledSync();

    const futuro = new Date(Date.now() + 6 * 60_000);
    expect((await runScheduledSync(futuro)).claimed).toBe(1);
  });

  it('sucesso registra o resumo e limpa o erro anterior', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    const s = getSchedulerSettings(companyId)!;
    expect(s.lastSuccessAt).toBeTruthy();
    expect(s.lastResult).toMatch(/nota\(s\) em conferência/);
    expect(s.lastError).toBeNull();
  });

  it('a leitura automática usa o MESMO caminho da manual', async () => {
    const spy = fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();
    // Se um dia alguém duplicar a lógica de leitura, este teste quebra.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('execução única', () => {
  it('caixa travada por outro processo não é reivindicada', async () => {
    const spy = fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    travar(new Date(Date.now() + 5 * 60_000));

    const r = await runScheduledSync();
    expect(r.claimed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('duas passadas simultâneas: só uma executa', async () => {
    const spy = fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });

    const [a, b] = await Promise.all([runScheduledSync(), runScheduledSync()]);

    // A trava é o UPDATE condicional: quem grava primeiro leva.
    expect(a.claimed + b.claimed).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(listNotes(companyId)).toHaveLength(1);
  });

  it('a trava é liberada ao terminar', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    const estado = estadoBruto();
    expect(estado.locked_until).toBeNull();
    expect(estado.locked_by).toBeNull();
  });
});

describe('recuperação', () => {
  it('trava vencida é assumida pela próxima execução', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    // O processo morreu no meio e deixou a trava para trás.
    travar(new Date(Date.now() - 60_000), 'processo-morto');

    const r = await runScheduledSync();
    expect(r.claimed).toBe(1);
    expect(estadoBruto().locked_by).toBeNull();
  });

  it('retomar depois de queda NÃO duplica a nota', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true, intervalMinutes: 1 });
    await runScheduledSync();
    expect(listNotes(companyId)).toHaveLength(1);

    // Simula a queda: trava vencida, e a mesma mensagem volta a ser lida.
    travar(new Date(Date.now() - 60_000), 'processo-morto');
    await runScheduledSync(new Date(Date.now() + 2 * 60_000));

    // O UID já visto e a chave da NF-e seguram a duplicata.
    expect(listNotes(companyId)).toHaveLength(1);
  });
});

describe('erro de leitura', () => {
  it('falha registra o motivo sem desligar o agendamento', async () => {
    fingirLeitura('erro');
    setSchedule({ companyId, userId, enabled: true });

    const r = await runScheduledSync();
    expect(r.failed).toBe(1);

    const s = getSchedulerSettings(companyId)!;
    // Provedor fora do ar é temporário; desligar sozinho faria as notas
    // pararem de entrar sem ninguém perceber.
    expect(s.autoEnabled).toBe(true);
    expect(s.lastError).toMatch(/não foi possível ler/i);
    expect(s.lastErrorAt).toBeTruthy();
  });

  it('falha solta a trava e reagenda', async () => {
    fingirLeitura('erro');
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    const estado = estadoBruto();
    expect(estado.locked_until).toBeNull();
    expect(estado.next_run_at).toBeTruthy();
  });

  it('depois do erro, a leitura seguinte volta ao normal', async () => {
    fingirLeitura('erro');
    setSchedule({ companyId, userId, enabled: true, intervalMinutes: 1 });
    await runScheduledSync();

    vi.restoreAllMocks();
    fingirLeitura('sucesso');
    await runScheduledSync(new Date(Date.now() + 2 * 60_000));

    const s = getSchedulerSettings(companyId)!;
    expect(s.lastSuccessAt).toBeTruthy();
    expect(s.lastError).toBeNull();
  });

  it('o erro fica na auditoria, sem a credencial', async () => {
    fingirLeitura('erro');
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    const trilha = listAudit(companyId, { limit: 20 }).items as unknown as { action: string; detail: string }[];
    const erro = trilha.find((a) => a.action === 'mail.scheduler_error');
    expect(erro).toBeTruthy();
    expect(JSON.stringify(trilha)).not.toContain('senha-de-aplicativo');
  });
});

describe('duplicidade entre origens', () => {
  it('e-mail agendado depois de upload manual não cria segunda nota', async () => {
    const { importNfe } = await import('../src/services/core/NfeImportService.js');
    importNfe({ companyId, userId, xml: nfeXml(CHAVE) });
    expect(listNotes(companyId)).toHaveLength(1);

    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    expect(listNotes(companyId)).toHaveLength(1);
  });

  it('upload manual depois do e-mail agendado também não duplica', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });
    await runScheduledSync();

    const { importNfe } = await import('../src/services/core/NfeImportService.js');
    const r = importNfe({ companyId, userId, xml: nfeXml(CHAVE) });
    expect(r.duplicated).toBe(true);
    expect(listNotes(companyId)).toHaveLength(1);
  });
});

describe('isolamento por operação', () => {
  it('a caixa de uma empresa não é lida no escopo da outra', async () => {
    fingirLeitura();
    setSchedule({ companyId, userId, enabled: true });

    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    await runScheduledSync();

    expect(listNotes(companyId)).toHaveLength(1);
    expect(listNotes(outra)).toHaveLength(0);
    expect(getSchedulerSettings(outra)).toBeNull();
  });
});
