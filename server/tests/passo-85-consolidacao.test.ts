/**
 * O PASSO 85 — A CONSOLIDAÇÃO DA REMEDIAÇÃO.
 *
 * Cada caso cai quando o guarda correspondente sai de `consolidacaoDaRemediacao.ts`:
 *   - banco novo: se um índice tiver SQL que não casa com a DDL canônica (coluna
 *     com outro nome, tabela errada), ele vira pendência e o primeiro caso cai —
 *     é a prova de que os índices valem no esquema de verdade;
 *   - banco antigo: sem a correção de cada item, o dado legado continua lá e o
 *     segundo caso cai; e o que tem de ficar intocado (a recuperação pedida agora,
 *     a conta que já entrou) também é conferido;
 *   - índice único com pré-condição: sem a conferência, o CREATE UNIQUE derrubaria
 *     a migração inteira; sem o resolvedor, a pendência nunca sairia — o terceiro
 *     caso cai nos dois;
 *   - o marcador e os corpos: se a fila de e-mail mudar o texto, a máscara do
 *     passo deixaria de casar e o quarto caso cai.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { ensureSchema } = await import('../src/db/database.js');
const { migrateCoreSchema, CORE_TARGET_VERSION } = await import('../src/db/core-migrations.js');
const {
  ITENS_DA_CONSOLIDACAO,
  MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO,
  CORPO_ATUAL_RECUPERACAO,
  CORPO_ATUAL_VERIFICACAO,
  pendenciasDaConsolidacao,
  resolverPendenciasDaConsolidacao,
} = await import('../src/db/consolidacaoDaRemediacao.js');
const { podarTabelasAposentadas } = await import('../src/db/tabelasAposentadas.js');
const { upsertCompany, upsertUser } = await import('../src/services/auth/IdentityService.js');
const {
  MARCA_DO_CONTEUDO_PROTEGIDO,
  queuePasswordResetEmail,
  queueVerificacaoEmail,
} = await import('../src/services/notifications/EmailService.js');

function bancoTemporario(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-passo85-'));
  return { dir, path: join(dir, 'core.db') };
}

/** Aponta a conexão para o banco temporário e o prepara como a subida da API prepara. */
function prepararBanco(path: string): void {
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  process.env.TEST_DATABASE_PATH = path;
  resetCoreSchemaCache();
  // As coleções de documentos (payment_terminal_*, fiscal_certificate_references…)
  // nascem pelo `ensureSchema` da camada de documentos; o núcleo, pelo `ensureCoreSchema`.
  ensureSchema();
  ensureCoreSchema();
  // `ensureSchema` é memorizado por processo: no segundo banco temporário ele não
  // roda de novo. As coleções que o passo 85 toca nascem aqui com a MESMA DDL dele.
  for (const colecao of ['payment_terminal_configurations', 'payment_terminal_history', 'payment_terminal_transactions']) {
    getConnection().exec(
      `CREATE TABLE IF NOT EXISTS "${colecao}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL)`,
    );
  }
}

function limpar(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária; o Windows às vezes segura o handle.
  }
}

function indicesDoBanco(): Set<string> {
  const linhas = getConnection()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as unknown as { name: string }[];
  return new Set(linhas.map((l) => l.name));
}

/** Volta o banco a "antes do passo 85": sem a marca e sem os índices únicos. */
function desfazerPasso85(): void {
  const db = getConnection();
  db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_85'").run();
  db.prepare("UPDATE core_meta SET value = '84' WHERE key = 'core_schema_version'").run();
  for (const nome of ITENS_DA_CONSOLIDACAO.unicos) db.exec(`DROP INDEX IF EXISTS ${nome}`);
}

describe('passo 85 — banco novo', () => {
  it('marca o passo, sobe a versão e cria todos os índices, sem pendência', () => {
    const { dir, path } = bancoTemporario();
    prepararBanco(path);
    migrateCoreSchema();

    const db = getConnection();
    const marca = db.prepare("SELECT value FROM core_meta WHERE key = 'core_migration_step_85'").get() as
      | { value?: string }
      | undefined;
    const versao = db.prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'").get() as
      | { value?: string }
      | undefined;
    // O 85 deixou de ser o último passo com o 86 (RBAC granular): o que se
    // cobra é o 85 marcado e a versão no alvo desta build.
    expect(CORE_TARGET_VERSION).toBeGreaterThanOrEqual(85);
    expect(marca?.value).toBe('applied');
    expect(Number(versao?.value)).toBe(CORE_TARGET_VERSION);

    // Todo índice do passo nasceu — nenhum SQL descasado da DDL canônica.
    const existentes = indicesDoBanco();
    const faltando = [...ITENS_DA_CONSOLIDACAO.indices, ...ITENS_DA_CONSOLIDACAO.unicos].filter(
      (nome) => !existentes.has(nome),
    );
    expect(faltando, 'índices do passo 85 que não nasceram num banco novo').toEqual([]);
    expect(pendenciasDaConsolidacao(db)).toEqual([]);
    limpar(dir);
  });
});

describe('passo 85 — banco que vem de antes', () => {
  it('aplica as correções seguras e deixa intocado o que ainda vale', async () => {
    const { dir, path } = bancoTemporario();
    prepararBanco(path);
    migrateCoreSchema();
    desfazerPasso85();

    const db = getConnection();
    const loja = upsertCompany({ slug: 'loja-85', legalName: 'Loja 85 Ltda', tradeName: 'Loja 85', kind: 'retail' });

    // EML — três recuperações: uma entregue e uma desistida com o segredo em claro;
    // uma pendente de AGORA, que ainda vale e o carteiro entrega.
    const entregue = queuePasswordResetEmail({
      companyId: loja, toAddress: 'a@exemplo.com.br', resetLink: 'https://x/redefinir?token=abc', dedupeKey: `r-${randomUUID()}`,
    })!;
    const desistida = queueVerificacaoEmail({
      companyId: loja, toAddress: 'b@exemplo.com.br', codigo: '123456', dedupeKey: `v-${randomUUID()}`,
    })!;
    const deAgora = queuePasswordResetEmail({
      companyId: loja, toAddress: 'c@exemplo.com.br', resetLink: 'https://x/redefinir?token=def', dedupeKey: `r-${randomUUID()}`,
    })!;
    const antiga = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')";
    db.prepare(`UPDATE core_email_queue SET status = 'sent', created_at = ${antiga}, body_text = ? WHERE id = ?`)
      .run('Abra este link: https://x/redefinir?token=abc', entregue);
    db.prepare(`UPDATE core_email_queue SET status = 'failed', created_at = ${antiga}, body_text = ? WHERE id = ?`)
      .run('Seu código é 123456', desistida);
    db.prepare('UPDATE core_email_queue SET body_text = ? WHERE id = ?')
      .run('Abra este link: https://x/redefinir?token=def', deAgora);

    // SEG — conta do seed que nunca entrou × conta do seed que já entrou.
    const admin = await upsertUser({ login: 'ADMIN', displayName: 'Admin', password: 'Seed@Antigo2026' });
    const gerente = await upsertUser({ login: 'CARLOSGERENTE', displayName: 'Carlos', password: 'Seed@Antigo2026' });
    db.prepare('UPDATE core_users SET must_change_password = 0, last_login_at = NULL WHERE id = ?').run(admin);
    db.prepare("UPDATE core_users SET must_change_password = 0, last_login_at = '2026-08-01T12:00:00.000Z' WHERE id = ?")
      .run(gerente);

    // PAG — a configuração de maquininha de TESTE, ligada.
    db.prepare('INSERT INTO payment_terminal_configurations (id, data) VALUES (?, ?)').run(
      'ptcfg-teste',
      JSON.stringify({ id: 'ptcfg-teste', companyId: loja, provider: 'mock', active: true, environment: 'sandbox' }),
    );

    migrateCoreSchema();

    // EML: as antigas perderam o segredo; a de agora continua como estava.
    const corpo = (id: string) =>
      (db.prepare('SELECT body_text FROM core_email_queue WHERE id = ?').get(id) as { body_text: string }).body_text;
    expect(corpo(entregue)).toBe(CORPO_ATUAL_RECUPERACAO);
    expect(corpo(entregue)).not.toContain('token=');
    expect(corpo(desistida)).toBe(CORPO_ATUAL_VERIFICACAO);
    expect(corpo(desistida)).not.toContain('123456');
    expect(corpo(deAgora)).toContain('token=def');

    // SEG: a que nunca entrou ficou provisória; a que já entrou, não.
    const provisoria = (id: string) =>
      Number((db.prepare('SELECT must_change_password AS m FROM core_users WHERE id = ?').get(id) as { m: number }).m);
    expect(provisoria(admin)).toBe(1);
    expect(provisoria(gerente)).toBe(0);

    // PAG: desligada, com rastro e auditoria.
    const cfg = JSON.parse(
      (db.prepare("SELECT data FROM payment_terminal_configurations WHERE id = 'ptcfg-teste'").get() as { data: string }).data,
    );
    expect(cfg.active).toBe(false);
    expect(cfg.deactivatedBy).toBe('migracao-consolidacao');
    expect(db.prepare("SELECT COUNT(*) AS n FROM payment_terminal_history WHERE id = 'pthist-mig-ptcfg-teste'").get())
      .toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE id = 'audit-mig-ptcfg-teste'").get()).toEqual({ n: 1 });

    // E rodar de novo não duplica nada (idempotente).
    desfazerPasso85();
    migrateCoreSchema();
    expect(db.prepare("SELECT COUNT(*) AS n FROM payment_terminal_history WHERE id LIKE 'pthist-mig-%'").get()).toEqual({ n: 1 });
    expect(corpo(deAgora)).toContain('token=def');
    limpar(dir);
  });
});

describe('passo 85 — índice único com pré-condição', () => {
  it('duas gavetas sem caixa abertas viram pendência, e a pendência sai sozinha depois de fechar uma', async () => {
    const { dir, path } = bancoTemporario();
    prepararBanco(path);
    migrateCoreSchema();
    desfazerPasso85();

    const db = getConnection();
    const loja = upsertCompany({ slug: 'loja-gavetas', legalName: 'Gavetas Ltda', tradeName: 'Gavetas', kind: 'retail' });
    const caixa = await upsertUser({ login: 'caixa.gavetas', displayName: 'Caixa', password: 'Caixa@Gavetas2026' });
    const abrir = (id: string) =>
      db.prepare(
        `INSERT INTO core_cash_sessions (id, company_id, opened_by, opening_cents, status, opened_at)
         VALUES (?, ?, ?, 0, 'open', ?)`,
      ).run(id, loja, caixa, new Date().toISOString());
    abrir('gaveta-1');
    abrir('gaveta-2');

    migrateCoreSchema();

    // A migração subiu inteira; o índice ficou de fora, com a pendência dizendo onde resolver.
    expect(Number((db.prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'").get() as { value: string }).value))
      .toBe(CORE_TARGET_VERSION);
    expect(indicesDoBanco().has('ux_cash_open_sem_terminal')).toBe(false);
    const pendencia = pendenciasDaConsolidacao(db).find((p) => p.chave === 'ux_cash_open_sem_terminal');
    expect(pendencia?.comoResolver).toContain('Fechar esta gaveta');

    // O dono fecha a gaveta excedente pela tela; a próxima subida cria o índice.
    db.prepare("UPDATE core_cash_sessions SET status = 'closed', closed_at = ? WHERE id = 'gaveta-2'")
      .run(new Date().toISOString());
    const r = resolverPendenciasDaConsolidacao(db);
    expect(r.resolvidas).toContain('ux_cash_open_sem_terminal');
    expect(indicesDoBanco().has('ux_cash_open_sem_terminal')).toBe(true);
    expect(pendenciasDaConsolidacao(db).some((p) => p.chave === 'ux_cash_open_sem_terminal')).toBe(false);
    limpar(dir);
  });
});

describe('passo 85 — o marcador e os corpos da fila de e-mail', () => {
  it('são os mesmos que a fila grava hoje (senão a máscara deixaria de casar)', () => {
    const { dir, path } = bancoTemporario();
    prepararBanco(path);
    migrateCoreSchema();
    const loja = upsertCompany({ slug: 'loja-marca', legalName: 'Marca Ltda', tradeName: 'Marca', kind: 'retail' });
    const r = queuePasswordResetEmail({
      companyId: loja, toAddress: 'd@exemplo.com.br', resetLink: 'https://x/redefinir?token=ghi', dedupeKey: `r-${randomUUID()}`,
    })!;
    const v = queueVerificacaoEmail({
      companyId: loja, toAddress: 'e@exemplo.com.br', codigo: '654321', dedupeKey: `v-${randomUUID()}`,
    })!;
    const corpo = (id: string) =>
      (getConnection().prepare('SELECT body_text FROM core_email_queue WHERE id = ?').get(id) as { body_text: string })
        .body_text;
    expect(MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO).toBe(MARCA_DO_CONTEUDO_PROTEGIDO);
    expect(corpo(r)).toBe(CORPO_ATUAL_RECUPERACAO);
    expect(corpo(v)).toBe(CORPO_ATUAL_VERIFICACAO);
    limpar(dir);
  });
});

/*
  LEG GAP-PRD-075 — as coleções aposentadas que TÊM linha vão para a verdade do núcleo.
  Cada item cai se o seu guarda sair: sem a cópia, a linha antiga some sem ter para onde
  ir (o `DELETE` só apaga o que tem cópia) e o caso de "está no núcleo" falha; sem o
  `DELETE`, a coleção continua com linha e a poda não a oferece; sem o "só o que tem
  cópia", o vínculo órfão sumiria.
*/
describe('passo 85 — o legado com linha vai para o núcleo, e só sai o que tem cópia', () => {
  it('avisos, vínculos e trilhas do Asaas: copiados, apagados da coleção antiga, e a poda oferece as vazias', () => {
    const { dir, path } = bancoTemporario();
    prepararBanco(path);
    migrateCoreSchema();
    desfazerPasso85();

    const db = getConnection();
    // As coleções aposentadas não nascem mais pelo `ensureSchema`: o banco "de antes" as tem.
    for (const colecao of [
      'asaas_webhook_events', 'asaas_customer_links', 'asaas_charge_links',
      'asaas_sandbox_homologations', 'integration_audit_entries', 'asaas_operational_attempts',
    ]) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${colecao}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL)`);
    }
    const inserir = (colecao: string, linha: Record<string, unknown>) =>
      db.prepare(`INSERT INTO "${colecao}" (id, data) VALUES (?, ?)`).run(String(linha.id), JSON.stringify(linha));
    const emp = 'empresa-legado-85';

    // O aviso que só a rota antiga guardou, e um que o núcleo já tem.
    inserir('asaas_webhook_events', {
      id: 'awe-1', eventId: 'evt_legado_1', eventType: 'PAYMENT_OVERDUE', status: 'processed',
      payload: { event: 'PAYMENT_OVERDUE', payment: { id: 'pay_legado_1' } }, environment: 'sandbox',
      createdAt: '2026-08-26T07:30:38.405Z', processedAt: '2026-08-26T07:30:39.000Z',
    });
    db.prepare(
      `INSERT INTO core_payment_webhooks (id, provider, event_id, event_type, payload, processed, received_at)
       VALUES ('wh-nucleo', 'asaas', 'evt_ja_no_nucleo', 'PAYMENT_CREATED', '{}', 1, '2026-08-26T03:00:00.000Z')`,
    ).run();
    inserir('asaas_webhook_events', {
      id: 'awe-2', eventId: 'evt_ja_no_nucleo', eventType: 'PAYMENT_CREATED', status: 'received',
      payload: {}, createdAt: '2026-08-26T03:00:01.000Z',
    });

    // As tentativas da fila e os vínculos que o processador gravava ao lado — e um órfão.
    inserir('asaas_operational_attempts', {
      id: 'att-cliente', companyId: emp, operationType: 'asaas_customer_sync', sourceId: 'cust-local-1',
      idempotencyKey: 'k-cliente', status: 'completed',
    });
    inserir('asaas_operational_attempts', {
      id: 'att-cobranca', companyId: emp, operationType: 'asaas_charge_create', sourceId: 'cob-local-1',
      idempotencyKey: 'k-cobranca', status: 'completed',
    });
    inserir('asaas_customer_links', { id: 'lnk-cliente', companyId: emp, customerId: 'cust-local-1', asaasCustomerId: 'cus_1', environment: 'sandbox' });
    inserir('asaas_customer_links', { id: 'lnk-orfao', companyId: emp, customerId: 'sem-tentativa', asaasCustomerId: 'cus_2' });
    inserir('asaas_charge_links', {
      id: 'lnk-cobranca', companyId: emp, localChargeId: 'cob-local-1', asaasPaymentId: 'pay_1',
      idempotencyKey: 'k-cobranca', status: 'PENDING',
    });

    // As duas trilhas da homologação fora do núcleo.
    inserir('integration_audit_entries', {
      id: 'iaudit-hom-1', companyId: emp, provider: 'asaas', action: 'homologation_failed',
      description: 'Homologação Asaas: parcial', occurredAt: '2026-08-26T03:34:58.651Z',
    });
    inserir('asaas_sandbox_homologations', { id: 'hom-1', companyId: emp, status: 'error', steps: [{ key: 'connection', status: 'error' }] });
    inserir('asaas_sandbox_homologations', { id: 'res-1', companyId: emp, resourceType: 'customer', resourceId: 'cus_x' });

    migrateCoreSchema();

    const contar = (sql: string, ...p: string[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);

    // Avisos: o que só a rota antiga tinha está no livro do núcleo, como já tratado.
    const aviso = db.prepare("SELECT processed, error, payload FROM core_payment_webhooks WHERE provider = 'asaas' AND event_id = 'evt_legado_1'")
      .get() as { processed: number; error: string; payload: string };
    expect(aviso.processed).toBe(1);
    expect(aviso.error).toContain('rota antiga');
    expect(JSON.parse(aviso.payload).payment.id).toBe('pay_legado_1');
    // O que o núcleo já tinha não duplicou.
    expect(contar("SELECT COUNT(*) AS n FROM core_payment_webhooks WHERE event_id = 'evt_ja_no_nucleo'")).toBe(1);
    expect(contar('SELECT COUNT(*) AS n FROM asaas_webhook_events')).toBe(0);

    // Vínculos: na tentativa; o órfão fica.
    const link = (id: string) =>
      JSON.parse((db.prepare('SELECT data FROM asaas_operational_attempts WHERE id = ?').get(id) as { data: string }).data).remoteLink;
    expect(link('att-cliente')).toMatchObject({ id: 'lnk-cliente', asaasCustomerId: 'cus_1' });
    expect(link('att-cobranca')).toMatchObject({ id: 'lnk-cobranca', asaasPaymentId: 'pay_1' });
    expect((db.prepare('SELECT id FROM asaas_customer_links').all() as { id: string }[]).map((r) => r.id)).toEqual(['lnk-orfao']);
    expect(contar('SELECT COUNT(*) AS n FROM asaas_charge_links')).toBe(0);

    // Trilhas: em core_audit_log, com o registro inteiro.
    const trilha = db.prepare("SELECT action, detail FROM core_audit_log WHERE id LIKE 'audit-mig-iae-%' OR id LIKE 'audit-mig-ash-%' ORDER BY id")
      .all() as { action: string; detail: string }[];
    expect(trilha.map((t) => t.action).sort()).toEqual([
      'integrations.asaas.homologation_failed',
      'integrations.asaas.homologation_run',
      'integrations.asaas.sandbox_resource',
    ]);
    expect(trilha.every((t) => JSON.parse(t.detail).registro)).toBe(true);
    expect(contar('SELECT COUNT(*) AS n FROM integration_audit_entries')).toBe(0);
    expect(contar('SELECT COUNT(*) AS n FROM asaas_sandbox_homologations')).toBe(0);

    // Rodar de novo não duplica nada.
    desfazerPasso85();
    migrateCoreSchema();
    expect(contar("SELECT COUNT(*) AS n FROM core_payment_webhooks WHERE event_id = 'evt_legado_1'")).toBe(1);
    expect(contar("SELECT COUNT(*) AS n FROM core_audit_log WHERE id LIKE 'audit-mig-%-%' AND (id LIKE 'audit-mig-iae-%' OR id LIKE 'audit-mig-ash-%')")).toBe(3);

    // E a poda oferece exatamente as que ficaram vazias; a do órfão fica, com a linha dita.
    const poda = podarTabelasAposentadas(db, { aplicar: false });
    for (const colecao of ['asaas_webhook_events', 'asaas_charge_links', 'asaas_sandbox_homologations', 'integration_audit_entries']) {
      expect(poda.aRemover, colecao).toContain(colecao);
    }
    expect(poda.mantidasComDado).toContainEqual({ nome: 'asaas_customer_links', linhas: 1 });
    limpar(dir);
  });
});
