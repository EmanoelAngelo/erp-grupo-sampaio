/**
 * ============================================================================
 * COLAR A CREDENCIAL NO `.env` VALE SEM REINICIAR A API (GAP-PRD-065)
 * ============================================================================
 *
 * O QUE ERA: `loadEnv()` memoriza na primeira leitura, e o carregador do
 * `.env` só escreve chave AUSENTE. Os arquivos de exemplo trazem
 * `EMAIL_SMTP_PASSWORD=` e `DEVORA_SUPABASE_URL=` vazias — a chave nasce
 * presente e vazia, e preenchê-la depois não mudava nada até o próximo boot.
 * O dono colava a senha de aplicativo, a tela de E-mails continuava dizendo
 * "Falta configurar: EMAIL_SMTP_PASSWORD", e a de Sincronização o mesmo — sem
 * uma palavra sobre reiniciar. Enquanto isso, o código de verificação e a
 * recuperação de senha do cliente esperavam na fila.
 *
 * O QUE ESTE ARQUIVO PROVA, com um `.env` DE VERDADE numa pasta temporária
 * (a suíte roda com `DEVORA_IGNORE_DOTENV=true`; aqui ele é desligado de
 * propósito, e o processo passa a morar na pasta do arquivo):
 *
 *   - preencher o arquivo com o servidor no ar muda o status e a fila sai;
 *   - trocar a senha no arquivo troca a senha que o transporte usa — e a que
 *     o motivo da falha esconde;
 *   - apagar a linha desliga de novo;
 *   - variável do AMBIENTE DO SISTEMA continua mandando (a precedência do boot);
 *   - a leitura ao vivo não reescreve `process.env` (o caminho do banco, lido
 *     a cada `getConnection`, não pode mudar no meio do dia);
 *   - a credencial da central (tela de Sincronização) segue a mesma regra.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv, lerVariaveisAoVivo, resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  emailStatus,
  flushEmailQueue,
  queueEmail,
  type CarteiroSmtp,
} from '../src/services/notifications/EmailService.js';
import { supabaseConfig, syncStatus } from '../src/services/sync/SyncService.js';

const { criarTransporte, sendMail } = vi.hoisted(() => ({
  criarTransporte: vi.fn(),
  sendMail: vi.fn(),
}));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (config: unknown) => {
      criarTransporte(config);
      return { sendMail };
    },
  },
}));

const CHAVES = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
  'DEVORA_SUPABASE_URL',
  'DEVORA_SUPABASE_SERVICE_KEY',
] as const;
const originais = new Map<string, string | undefined>();
for (const c of CHAVES) originais.set(c, process.env[c]);

const EMPRESA = 'gringa';
let cwdOriginal: string;
let pasta: string;
let arquivo: string;

/** O `.env` da instalação, do jeito que o dono o edita. */
function escreverEnv(linhas: string[]): void {
  writeFileSync(arquivo, `${linhas.join('\n')}\n`, 'utf8');
}

const COMO_O_EXEMPLO = [
  '# copiado do .env.production.example',
  'EMAIL_ENABLED=false',
  'EMAIL_FROM=',
  'EMAIL_SMTP_HOST=',
  'EMAIL_SMTP_PORT=465',
  'EMAIL_SMTP_USER=',
  'EMAIL_SMTP_PASSWORD=',
  'DEVORA_SUPABASE_URL=',
  'DEVORA_SUPABASE_SERVICE_KEY=',
];

function preenchido(senha: string): string[] {
  return [
    'EMAIL_ENABLED=true',
    'EMAIL_FROM=loja@grupo-sampaio.test',
    'EMAIL_SMTP_HOST=smtp.provedor.test',
    'EMAIL_SMTP_PORT=465',
    'EMAIL_SMTP_USER=loja@grupo-sampaio.test',
    `EMAIL_SMTP_PASSWORD="${senha}"`,
  ];
}

function enfileirar(): string {
  const id = queueEmail({
    companyId: EMPRESA,
    template: 'pagamento_confirmado',
    toAddress: 'ana@exemplo.com',
    dedupeKey: `fato-${Math.random()}`,
    context: { storeName: 'Gringa', customerName: 'Ana', orderNumber: 7, totalCents: 100 },
  });
  expect(id).toBeTruthy();
  return id!;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  upsertCompany({ id: EMPRESA, slug: EMPRESA, legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  criarTransporte.mockClear();
  sendMail.mockReset();
  sendMail.mockResolvedValue({});

  for (const c of CHAVES) delete process.env[c];
  cwdOriginal = process.cwd();
  pasta = mkdtempSync(join(tmpdir(), 'smtp-ao-vivo-'));
  // `api/` dentro da pasta: o carregador também olha `../.env`, e o pai aqui
  // é a pasta temporária desta execução — que não tem arquivo nenhum.
  const api = join(pasta, 'api');
  mkdirSync(api);
  arquivo = join(api, '.env');
  process.chdir(api);
  process.env.DEVORA_IGNORE_DOTENV = 'false';
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env.DEVORA_IGNORE_DOTENV = 'true';
  process.chdir(cwdOriginal);
  for (const c of CHAVES) {
    const original = originais.get(c);
    if (original === undefined) delete process.env[c];
    else process.env[c] = original;
  }
  resetEnvCacheForTests();
  rmSync(pasta, { recursive: true, force: true });
});

describe('o e-mail', () => {
  it('a senha colada no .env com o servidor no ar vale na pergunta seguinte — e a fila sai', async () => {
    escreverEnv(COMO_O_EXEMPLO);
    // O "boot": o processo lê o ambiente e memoriza. Era isto que congelava.
    loadEnv();
    const antes = emailStatus(EMPRESA);
    expect(antes.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(antes.missing).toContain('EMAIL_SMTP_PASSWORD');

    const id = enfileirar();
    escreverEnv(preenchido('senha-de-app-nova'));

    const depois = emailStatus(EMPRESA);
    expect(depois.readiness).toBe('READY');
    expect(depois.missing).toEqual([]);

    const r = await flushEmailQueue();
    expect(r.sent).toBe(1);
    expect(criarTransporte).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.provedor.test',
        port: 465,
        auth: { user: 'loja@grupo-sampaio.test', pass: 'senha-de-app-nova' },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'loja@grupo-sampaio.test', to: 'ana@exemplo.com' }),
    );
    const linha = getConnection().prepare('SELECT status FROM core_email_queue WHERE id = ?').get(id) as {
      status: string;
    };
    expect(linha.status).toBe('sent');
  });

  it('trocar a senha no arquivo troca a senha do transporte — e a que o motivo esconde', async () => {
    escreverEnv(preenchido('senha-antiga-do-app'));
    enfileirar();
    await flushEmailQueue();
    expect(criarTransporte).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ pass: 'senha-antiga-do-app' }) }),
    );

    escreverEnv(preenchido('senha-trocada-do-app'));
    const id = enfileirar();
    // O provedor recusa ecoando a credencial — o motivo vai para a tela.
    const ecoa: CarteiroSmtp = {
      enviar: () => Promise.reject(new Error('535 auth failed: senha-trocada-do-app')),
    };
    await flushEmailQueue({ carteiro: ecoa });
    const linha = getConnection()
      .prepare('SELECT last_error FROM core_email_queue WHERE id = ?')
      .get(id) as { last_error: string };
    expect(linha.last_error).toMatch(/535/);
    expect(linha.last_error).not.toContain('senha-trocada-do-app');

    await flushEmailQueue({ agora: new Date(Date.now() + 2 * 60_000) });
    expect(criarTransporte).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ pass: 'senha-trocada-do-app' }) }),
    );
  });

  it('apagar a linha do arquivo desliga de novo', () => {
    escreverEnv(preenchido('qualquer-senha'));
    expect(emailStatus(EMPRESA).readiness).toBe('READY');
    escreverEnv(preenchido('qualquer-senha').filter((l) => !l.startsWith('EMAIL_SMTP_PASSWORD')));
    const s = emailStatus(EMPRESA);
    expect(s.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(s.missing).toEqual(['EMAIL_SMTP_PASSWORD']);
  });

  it('porta que não é número aparece no que falta, em vez de quebrar o transporte', () => {
    escreverEnv([...preenchido('x').filter((l) => !l.startsWith('EMAIL_SMTP_PORT')), 'EMAIL_SMTP_PORT=quatrocentos']);
    expect(emailStatus(EMPRESA).missing).toEqual([
      'EMAIL_SMTP_PORT (número da porta, ex.: 465 ou 587)',
    ]);
  });
});

describe('a precedência do boot continua valendo', () => {
  it('variável do AMBIENTE DO SISTEMA manda — o arquivo não passa por cima', () => {
    process.env.EMAIL_SMTP_HOST = 'smtp.do-sistema.test';
    escreverEnv(preenchido('x').map((l) => (l.startsWith('EMAIL_SMTP_HOST') ? 'EMAIL_SMTP_HOST=smtp.do-arquivo.test' : l)));
    expect(lerVariaveisAoVivo(['EMAIL_SMTP_HOST'] as const).EMAIL_SMTP_HOST).toBe('smtp.do-sistema.test');
  });

  it('a leitura ao vivo não reescreve process.env — só responde quem pergunta', () => {
    escreverEnv(preenchido('primeira'));
    // O carregador de sempre (o do caminho do banco) injeta o que falta.
    getConnection();
    expect(process.env.EMAIL_SMTP_PASSWORD).toBe('primeira');

    escreverEnv(preenchido('segunda'));
    getConnection();
    expect(lerVariaveisAoVivo(['EMAIL_SMTP_PASSWORD'] as const).EMAIL_SMTP_PASSWORD).toBe('segunda');
    // O processo continua vendo o que o boot leu — nada foi trocado por baixo.
    expect(process.env.EMAIL_SMTP_PASSWORD).toBe('primeira');
  });
});

describe('a central (tela de Sincronização)', () => {
  it('preencher DEVORA_SUPABASE_* no arquivo sai de READY_FOR_CREDENTIAL sem reinício', () => {
    escreverEnv(COMO_O_EXEMPLO);
    getConnection();
    expect(supabaseConfig()).toBeNull();
    const antes = syncStatus();
    expect(antes.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(antes.missing).toEqual(['DEVORA_SUPABASE_URL', 'DEVORA_SUPABASE_SERVICE_KEY']);

    escreverEnv([
      ...COMO_O_EXEMPLO.filter((l) => !l.startsWith('DEVORA_SUPABASE')),
      'DEVORA_SUPABASE_URL=https://central.supabase.test',
      'DEVORA_SUPABASE_SERVICE_KEY=chave-de-servico-de-teste',
    ]);
    expect(supabaseConfig()).toEqual({
      url: 'https://central.supabase.test',
      serviceRoleKey: 'chave-de-servico-de-teste',
    });
    const depois = syncStatus();
    expect(depois.readiness).not.toBe('READY_FOR_CREDENTIAL');
    expect(depois.missing).toEqual([]);
  });
});
