/**
 * ============================================================================
 * RESSELAR NÃO É TROCAR
 * ============================================================================
 *
 * A rotação da chave do cofre resolveu metade do problema: o `.pfx`, as chaves
 * do Asaas, o token do webhook e a senha do e-mail deixaram de estar selados
 * com uma chave publicada no repositório.
 *
 * A outra metade não tem conserto do lado de cá. Enquanto aquela chave valia,
 * cópias inteiras deste banco saíram da máquina — 527 objetos no bucket remoto
 * e 717 no disco local, cada um com os cinco segredos abríveis por qualquer um
 * que tenha o repositório. Resselar troca a fechadura de uma porta cuja cópia
 * da chave antiga já está na rua.
 *
 * Para o `.pfx` isso é aceitável: ele é inútil sem a senha, que nunca esteve no
 * banco. Para uma chave de API do Asaas não é — ela É a credencial.
 *
 * ## O que este arquivo trava
 *
 * Que o diagnóstico do dono saiba dizer, por credencial, se ela ainda precisa
 * ser trocada NO PROVEDOR — e que essa marca se apague sozinha quando ele
 * colar a credencial nova, sem ninguém mexer em código.
 *
 * O critério é o carimbo: credencial cujo último toque humano é ANTERIOR à
 * rotação viveu selada pela chave publicada. A que for colada depois, não.
 *
 * Nenhum segredo real aparece aqui.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';

const { resetDbForTests, insertRow, updateRows } = await import('../src/db/database.js');
const { resetCoreSchemaCache } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { encryptFiscalSecret } = await import('../src/services/fiscal/FiscalSecretVault.js');
const { prontidaoDosSegredos, marcarCofreRotacionado } = await import(
  '../src/db/secretsReadiness.js'
);
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const EMPRESA = 'empresa-da-prontidao';
const ANTES = '2026-08-24T17:14:19.487Z';
const ROTACAO = '2026-08-27T13:42:13.194Z';
const DEPOIS = '2026-08-28T09:00:00.000Z';

function semearCredencial(tipo: string, quando: string): void {
  insertRow('integration_secrets', {
    id: `sec-${tipo}`,
    companyId: EMPRESA,
    secretType: tipo,
    encryptedValue: encryptFiscalSecret('valor-inventado-' + tipo),
    createdAt: quando,
    updatedAt: quando,
    rotatedAt: null,
  } as never);
}

beforeEach(() => {
  resetCoreSchemaCache();
  resetDbForTests();
  resetEnvCacheForTests();
});

// ============================================================================

describe('a marca da rotação', () => {
  it('sem marca nenhuma, nada é cobrado — não se acusa o que não se sabe', () => {
    semearCredencial('asaas_production_api_key', ANTES);
    const p = prontidaoDosSegredos();
    expect(p.asaasProduction.selo).toBe('SEALED_CURRENT_KEY');
    expect(p.asaasProduction.trocaNoProvedor).toBe('NOT_REQUIRED');
  });

  it('com a marca, credencial ANTERIOR à rotação pede troca no provedor', () => {
    semearCredencial('asaas_production_api_key', ANTES);
    marcarCofreRotacionado(ROTACAO);

    const p = prontidaoDosSegredos();
    expect(p.asaasProduction.selo).toBe('SEALED_CURRENT_KEY');
    expect(
      p.asaasProduction.trocaNoProvedor,
      'viveu selada pela chave publicada: resselar não desfaz isso',
    ).toBe('REQUIRED');
  });

  it('e credencial colada DEPOIS da rotação não pede nada', () => {
    /*
      É o caso que faz a marca se apagar sozinha. Quando o dono colar a chave
      nova do portal do Asaas, o `updatedAt` passa da rotação e o diagnóstico
      para de cobrar — sem ninguém tocar em código, que é exatamente o que foi
      pedido.
    */
    semearCredencial('asaas_production_api_key', ANTES);
    marcarCofreRotacionado(ROTACAO);
    updateRows(
      'integration_secrets' as never,
      (r) => String((r as Record<string, unknown>).secretType) === 'asaas_production_api_key',
      (r) => ({ ...(r as Record<string, unknown>), updatedAt: DEPOIS }) as never,
    );

    expect(prontidaoDosSegredos().asaasProduction.trocaNoProvedor).toBe('NOT_REQUIRED');
  });

  it('credencial ausente não pede troca — não há o que trocar', () => {
    marcarCofreRotacionado(ROTACAO);
    const p = prontidaoDosSegredos();
    expect(p.asaasProduction.selo).toBe('ABSENT');
    expect(p.asaasProduction.trocaNoProvedor).toBe('NOT_REQUIRED');
  });

  it('as quatro credenciais de provedor são cobradas juntas', () => {
    for (const tipo of ['asaas_sandbox_api_key', 'asaas_production_api_key', 'webhook_token']) {
      semearCredencial(tipo, ANTES);
    }
    marcarCofreRotacionado(ROTACAO);

    const p = prontidaoDosSegredos();
    expect(p.asaasSandbox.trocaNoProvedor).toBe('REQUIRED');
    expect(p.asaasProduction.trocaNoProvedor).toBe('REQUIRED');
    expect(p.asaasWebhook.trocaNoProvedor).toBe('REQUIRED');
  });
});

// ============================================================================

describe('o JWT também tem estado', () => {
  it('o diagnóstico diz se o segredo de sessão é próprio', () => {
    /*
      Ele não estava no diagnóstico, e é a chave com que qualquer um assinaria
      o próprio token de administrador. Produção recusa subir sem ele — mas
      "recusa subir" é uma resposta que só chega no dia do deploy.
    */
    const p = prontidaoDosSegredos();
    expect(['PRODUCTION_SAFE', 'DEVELOPMENT_DEFAULT', 'MISSING']).toContain(p.jwtSecret);
  });

  it('com um JWT próprio e longo, é PRODUCTION_SAFE', () => {
    process.env.DEVORA_JWT_SECRET = 'um-jwt-proprio-longo-o-bastante-para-passar';
    resetEnvCacheForTests();
    expect(prontidaoDosSegredos().jwtSecret).toBe('PRODUCTION_SAFE');
  });
});

// ============================================================================

describe('a fila para a central aparece no diagnóstico', () => {
  it('diz quantos eventos estão parados e desde quando', () => {
    /*
      118 eventos ficaram doze dias na fila sem ninguém perceber, porque o
      único lugar que contava a história era o log do boot. Aqui a contagem
      fica onde o dono olha antes de publicar.
    */
    const p = prontidaoDosSegredos();
    expect(p.outbox).toBeDefined();
    expect(typeof p.outbox.pending).toBe('number');
  });

  it('e diz o estado da credencial da central, sem o valor dela', () => {
    const p = prontidaoDosSegredos();
    expect(p.centralSync.readiness).toBeTruthy();
    expect(Array.isArray(p.centralSync.missing)).toBe(true);
  });

  it('a fila conta o que existe', () => {
    getConnection().exec(
      "INSERT INTO core_outbox (id, node_id, event_type, aggregate_type, aggregate_id, company_id, "
        + "operation, schema_version, payload, occurred_at, status, attempts, created_at) VALUES "
        + "('ev-1','no-1','sale.created','sale','s-1','" + EMPRESA + "','insert',1,'{}',"
        + "'2026-08-15T12:00:00.000Z','pending',0,'2026-08-15T12:00:00.000Z')",
    );
    const p = prontidaoDosSegredos();
    expect(p.outbox.pending).toBe(1);
    expect(p.outbox.oldestPendingAt).toBe('2026-08-15T12:00:00.000Z');
  });
});

// ============================================================================

describe('e nada disso carrega valor de segredo', () => {
  it('o corpo inteiro não tem base64 comprido nem chave do ambiente', () => {
    semearCredencial('asaas_production_api_key', ANTES);
    marcarCofreRotacionado(ROTACAO);

    const texto = JSON.stringify(prontidaoDosSegredos());
    expect(texto).not.toContain(process.env.DEVORA_ENCRYPTION_KEY);
    expect(texto).not.toContain(process.env.DEVORA_JWT_SECRET);
    expect(texto).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
  });
});
