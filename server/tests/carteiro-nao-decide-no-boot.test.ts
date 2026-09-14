/**
 * O CARTEIRO NÃO É DECIDIDO NA SUBIDA DO SERVIDOR.
 *
 * ============================================================================
 * O QUE FOI MEDIDO
 * ============================================================================
 *
 * `index.ts` perguntava UMA vez, no boot:
 *
 *     if (carteiroConfigurado()) startEmailFlushWorker();
 *     else logInfo('CARTEIRO_SAIDA_IDLE', ...)
 *
 * O molde veio do trabalhador da central, e lá ele se justifica: sem
 * `SUPABASE_URL` não há para onde enviar, e um timer batendo a cada quinze
 * segundos contra o nada só produziria erro em log.
 *
 * Aqui a situação é outra, e este arquivo é o que a mede: **a batida sem
 * credencial já é inofensiva**. `fazerFlush` devolve `READY_FOR_CREDENTIAL` e
 * volta sem tocar em nada. O `if` do boot não protege de nada — só cria uma
 * dependência de ORDEM: o carteiro passa a existir ou não conforme o estado do
 * ambiente no instante exato em que o processo subiu.
 *
 * E a fila de e-mail não é decorativa: nela ficam o CÓDIGO DE VERIFICAÇÃO da
 * conta do cliente e a RECUPERAÇÃO DE SENHA. O carteiro sai sempre; quem decide
 * se há o que entregar é cada batida.
 *
 * ============================================================================
 * UMA HONESTIDADE SOBRE COMO O SMTP É CONFIGURADO
 * ============================================================================
 *
 * Não há tela de SMTP: as credenciais são `EMAIL_*` no ambiente. Até o
 * GAP-PRD-065 elas vinham de `loadEnv`, que memoriza na primeira leitura — e
 * trocar a credencial exigia reiniciar o processo de qualquer jeito.
 *
 * Desde então o carteiro relê `EMAIL_*` do `.env` a cada batida
 * (`lerVariaveisAoVivo`; a prova de ponta a ponta mora em
 * `smtp-sem-reinicio.test.ts`). O carteiro sempre ligado e a leitura ao vivo
 * são as duas metades: sem qualquer uma delas, colar a senha no `.env` com o
 * servidor no ar continuaria sem efeito.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { carteiroConfigurado, tickDoCarteiro, queueEmail } = await import(
  '../src/services/notifications/EmailService.js'
);
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const CHAVES = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
];
const original: Record<string, string | undefined> = {};

let empresa: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });

  for (const k of CHAVES) {
    original[k] = process.env[k];
    delete process.env[k];
  }
  /*
    `loadEnv` memoriza. Sem limpar o cache, o teste mediria o ambiente da
    PRIMEIRA leitura do processo, e não o que ele acabou de mexer — e passaria
    (ou falharia) pelo motivo errado.
  */
  resetEnvCacheForTests();
});

afterEach(() => {
  for (const k of CHAVES) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetEnvCacheForTests();
});

function configurarSmtp(): void {
  process.env.EMAIL_ENABLED = 'true';
  process.env.EMAIL_FROM = 'loja@teste.local';
  process.env.EMAIL_SMTP_HOST = 'smtp.teste.local';
  process.env.EMAIL_SMTP_USER = 'loja@teste.local';
  process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste';
  resetEnvCacheForTests();
}

/** Uma mensagem na fila — a que mais importa: o código de verificação. */
function enfileirar(chave: string): void {
  queueEmail({
    companyId: empresa,
    template: 'pagamento_confirmado',
    toAddress: 'cliente@teste.local',
    dedupeKey: chave,
    context: { storeName: 'Gringa', customerName: 'Cliente', orderNumber: 1, totalCents: 1000 },
  });
}

function naFila(): number {
  return Number(
    (
      getConnection()
        .prepare("SELECT COUNT(*) AS n FROM core_email_queue WHERE status = 'pending'")
        .get() as { n: number }
    ).n,
  );
}

// ============================================================================

describe('a batida sem credencial é inofensiva', () => {
  /**
   * É esta a premissa que derruba o `if` do boot. Se a batida sem credencial
   * fizesse alguma coisa — errasse, marcasse como falha, enchesse o log —, o
   * `if` estaria certo e o conserto seria outro.
   */
  it('não estoura, e a fila fica intacta', async () => {
    enfileirar('mensagem-1');
    expect(naFila()).toBe(1);

    await tickDoCarteiro();

    // A mensagem CONTINUA pendente: sem credencial ninguém entrega, e marcá-la
    // como enviada seria mentir sobre um e-mail que não saiu.
    expect(naFila()).toBe(1);
  });

  it('e nenhuma tentativa é contada contra a mensagem', async () => {
    /*
      Importa porque a fila desiste depois de N tentativas. Se a batida sem
      credencial contasse, o servidor que subisse antes do `.env` estar pronto
      QUEIMARIA as mensagens da fila enquanto ninguém olhava.
    */
    enfileirar('mensagem-2');
    await tickDoCarteiro();
    await tickDoCarteiro();
    await tickDoCarteiro();

    const linha = getConnection()
      .prepare('SELECT attempts, status FROM core_email_queue LIMIT 1')
      .get() as { attempts: number; status: string };
    expect([linha.attempts, linha.status]).toEqual([0, 'pending']);
  });

  it('o carteiro se declara não configurado — que é o que o boot perguntava', () => {
    expect(carteiroConfigurado()).toBe(false);
  });
});

// ============================================================================

describe('com credencial, a mesma batida entrega', () => {
  it('a fila acumulada sai na primeira batida depois de configurado', async () => {
    enfileirar('mensagem-3');
    expect(carteiroConfigurado()).toBe(false);

    configurarSmtp();
    expect(carteiroConfigurado()).toBe(true);

    // Um carteiro de mentira: entrega tudo e conta o que passou por ele.
    const entregues: string[] = [];
    await tickDoCarteiro({
      enviar: async (m: { to: string }) => {
        entregues.push(m.to);
      },
    } as never);

    expect(entregues).toEqual(['cliente@teste.local']);
    expect(naFila()).toBe(0);
  });
});
