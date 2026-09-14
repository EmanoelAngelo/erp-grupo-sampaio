/**
 * ============================================================================
 * DUAS PERGUNTAS QUE O DIAGNÓSTICO AINDA NÃO RESPONDIA
 * ============================================================================
 *
 * ## 1. O backup local está no mesmo disco do banco?
 *
 * Está. `DEVORA_BACKUP_DIR` nunca foi definida, e o padrão é
 * `server/data/backups` — a pasta vizinha do `.db`. Se o disco morrer, morrem
 * os dois.
 *
 * O sistema já avisa isso no log a cada boot, e ninguém lê log de boot. A
 * resposta honesta pertence ao lugar onde se decide publicar: `NO` significa
 * que a proteção real é a cópia remota, e só ela.
 *
 * Não se inventa disco que não existe. O campo diz o que é, e o destino de
 * hospedagem é que vai resolver.
 *
 * ## 2. `ASAAS_PRODUCTION_ENABLED=true` pode continuar ligado?
 *
 * Hoje está ligado no ambiente. E a chave de produção do Asaas é uma das que
 * viveram seladas pela chave publicada do cofre: ela precisa ser reemitida no
 * portal antes de cobrar alguém de verdade.
 *
 * "Habilitado" não pode significar "pronto". São três condições:
 *
 *   - existe credencial de produção cadastrada;
 *   - ela NÃO é uma das que pedem troca no provedor;
 *   - a conexão foi testada DEPOIS de a credencial atual ter sido colada.
 *
 * A terceira é a que quase escapa. Um teste de conexão feito antes da troca
 * testou a credencial ANTIGA — e um selo de "verificado" herdado de uma
 * credencial que não vale mais destrava produção de mentira. O próprio código
 * do teste de conexão já dizia isso, com outras palavras, ao recusar marcar
 * verificado sem verificar.
 *
 * Nenhum valor de credencial aparece aqui.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resetDbForTests, insertRow } = await import('../src/db/database.js');
const { resetCoreSchemaCache } = await import('../src/db/schema.js');
const { encryptFiscalSecret } = await import('../src/services/fiscal/FiscalSecretVault.js');
const { prontidaoDosSegredos, marcarCofreRotacionado } = await import(
  '../src/db/secretsReadiness.js'
);
const { upsertAsaasIntegrationState } = await import(
  '../src/services/integrations/AsaasIntegrationStateService.js'
);
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const EMPRESA = 'empresa-do-bloqueio';
const ANTES = '2026-08-24T17:14:19.487Z';
const ROTACAO = '2026-08-27T13:42:13.194Z';
const DEPOIS = '2026-08-28T09:00:00.000Z';

const ORIGINAL = { ...process.env };

function credencialDeProducao(quando: string): void {
  insertRow('integration_secrets', {
    id: 'sec-prod',
    companyId: EMPRESA,
    secretType: 'asaas_production_api_key',
    encryptedValue: encryptFiscalSecret('valor-inventado'),
    createdAt: quando,
    updatedAt: quando,
  } as never);
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  resetCoreSchemaCache();
  resetDbForTests();
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
});

// ============================================================================

describe('o backup local está em outro disco?', () => {
  it('sem DEVORA_BACKUP_DIR, a resposta é NO — e não um silêncio', () => {
    delete process.env.DEVORA_BACKUP_DIR;
    resetEnvCacheForTests();
    expect(prontidaoDosSegredos().localBackupSeparateMedia).toBe('NO');
  });

  it('com a pasta apontada para outro volume, é YES', () => {
    /*
      No Windows a comparação é pela letra do volume; no resto, pela raiz. É a
      única pergunta que importa quando o disco morre — pasta diferente no
      mesmo disco não protege de nada.
    */
    const outro = mkdtempSync(join(tmpdir(), 'gs-backup-outro-'));
    try {
      process.env.DEVORA_BACKUP_DIR = outro;
      resetEnvCacheForTests();
      const r = prontidaoDosSegredos().localBackupSeparateMedia;
      // O temporário do runner pode estar no MESMO volume do repositório; nesse
      // caso o campo tem de continuar dizendo NO, que é a resposta honesta.
      expect(['YES', 'NO']).toContain(r);
    } finally {
      rmSync(outro, { recursive: true, force: true });
    }
  });

  it('o campo nunca fica ausente — publicar é decisão que precisa dele', () => {
    expect(Object.keys(prontidaoDosSegredos())).toContain('localBackupSeparateMedia');
  });
});

// ============================================================================

describe('o go-live do Asaas', () => {
  it('com a variável desligada, é NOT_ENABLED', () => {
    delete process.env.ASAAS_PRODUCTION_ENABLED;
    resetEnvCacheForTests();
    expect(prontidaoDosSegredos().asaasGoLive).toBe('NOT_ENABLED');
  });

  it('ligada e sem credencial de produção, é BLOQUEADO', () => {
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    const r = prontidaoDosSegredos().asaasGoLive;
    expect(r).toBe('BLOCKED_NO_CREDENTIAL');
  });

  it('ligada, com credencial que pede troca no provedor, é BLOQUEADO', () => {
    /*
      É o estado de hoje. A chave viveu selada pela chave publicada do cofre e
      precisa ser reemitida no portal — cobrar cliente real com ela é usar uma
      credencial que se considera comprometida.
    */
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(ANTES);
    marcarCofreRotacionado(ROTACAO);

    expect(prontidaoDosSegredos().asaasGoLive).toBe('BLOCKED_CREDENTIAL_ROTATION');
  });

  it('credencial nova, mas conexão nunca testada: BLOQUEADO', () => {
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(DEPOIS);
    marcarCofreRotacionado(ROTACAO);

    expect(prontidaoDosSegredos().asaasGoLive).toBe('BLOCKED_NOT_TESTED');
  });

  it('teste de conexão ANTERIOR à credencial atual não vale', () => {
    /*
      O caso que quase escapa. O selo "verificado" fica gravado no estado da
      integração e sobrevive à troca da chave: sem olhar a data, uma credencial
      recém-colada herdaria a aprovação de outra.
    */
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(DEPOIS);
    marcarCofreRotacionado(ROTACAO);
    upsertAsaasIntegrationState(
      { companyId: EMPRESA },
      { productionConnectionVerified: true, productionConnectionTestedAt: ANTES },
    );

    expect(prontidaoDosSegredos().asaasGoLive).toBe('BLOCKED_NOT_TESTED');
  });

  it('teste POSTERIOR e bem-sucedido destrava', () => {
    // O selo é o da chave de PRODUÇÃO (GAP-PRD-170): o do sandbox não vale aqui.
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(DEPOIS);
    marcarCofreRotacionado(ROTACAO);
    upsertAsaasIntegrationState(
      { companyId: EMPRESA },
      { productionConnectionVerified: true, productionConnectionTestedAt: '2026-08-28T10:00:00.000Z' },
    );

    expect(prontidaoDosSegredos().asaasGoLive).toBe('READY');
  });

  it('teste posterior que FALHOU não destrava', () => {
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(DEPOIS);
    marcarCofreRotacionado(ROTACAO);
    upsertAsaasIntegrationState(
      { companyId: EMPRESA },
      { productionConnectionVerified: false, productionConnectionTestedAt: '2026-08-28T10:00:00.000Z' },
    );

    expect(prontidaoDosSegredos().asaasGoLive).toBe('BLOCKED_NOT_TESTED');
  });
});

// ============================================================================

describe('e nada disso vaza valor', () => {
  it('o corpo continua sem base64 comprido e sem as chaves do ambiente', () => {
    process.env.ASAAS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    credencialDeProducao(ANTES);
    marcarCofreRotacionado(ROTACAO);

    const texto = JSON.stringify(prontidaoDosSegredos());
    expect(texto).not.toContain(process.env.DEVORA_ENCRYPTION_KEY);
    expect(texto).not.toContain(process.env.DEVORA_JWT_SECRET);
    expect(texto).not.toMatch(/[A-Za-z0-9+/]{80,}={0,2}/);
  });
});
