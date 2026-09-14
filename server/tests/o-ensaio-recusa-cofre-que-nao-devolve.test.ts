/**
 * ============================================================================
 * O ENSAIO PRECISA CONSEGUIR DIZER NÃO
 * ============================================================================
 *
 * O ensaio da rotação faz o vaivém em memória: cifra com a chave nova, reabre o
 * que cifrou, compara com o texto que saiu da antiga. O arquivo irmão
 * (`a-rotacao-da-chave-e-tudo-ou-nada`) prova que ele CONTA esse vaivém.
 *
 * Só que contar acerto não prova guarda nenhuma. Com o cofre real, nenhuma
 * chave que eu consiga escrever faz o vaivém falhar — AES-GCM devolve o que
 * recebeu, e `scryptSync` aceita qualquer texto como chave. Testei chave de
 * cinco milhões de caracteres, surrogate solto, nulos e emoji: todas voltam
 * idênticas. Um guarda que nunca vê o caso ruim é um guarda que ninguém provou.
 *
 * Então este arquivo TROCA o cofre por um que mente: cifra e devolve outra
 * coisa. É o único jeito de fazer o caso ruim acontecer — e é o que transforma
 * a contagem do ensaio em guarda de verdade.
 *
 * ## Por que isso não é paranoia
 *
 * O vaivém protege contra o cofre parar de ser reversível — troca de algoritmo,
 * troca de derivação, sal alterado, biblioteca atualizada. São mudanças que
 * alguém faz de boa-fé, e cujo estrago aparece meses depois, na primeira
 * rotação, com o `.pfx` da loja dentro.
 *
 * Nenhum segredo real aparece aqui. Os textos são inventados pelo teste.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHAVE_ANTIGA = 'chave-antiga-de-teste-longa-o-bastante-32';
const CHAVE_NOVA = 'chave-nova-de-teste-longa-o-bastante-1234';

process.env.DEVORA_ENCRYPTION_KEY = CHAVE_ANTIGA;

/*
  O COFRE TROCADO.

  `encryptWithKey` continua honesto para a chave ANTIGA — é ele que semeia o
  banco. Para a chave NOVA ele devolve lixo, e é aí que o vaivém do ensaio tem
  de perceber que a volta não veio igual.

  `decryptWithKey` fica intacto: quem mente é só o lado que sela.
*/
vi.mock('../src/services/fiscal/FiscalSecretVault.js', async (original) => {
  const real = await original<typeof import('../src/services/fiscal/FiscalSecretVault.js')>();
  return {
    ...real,
    encryptWithKey: (texto: string, chave: string): string =>
      chave === CHAVE_NOVA
        ? real.encryptWithKey('lixo-que-nao-e-o-texto-original', chave)
        : real.encryptWithKey(texto, chave),
  };
});

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { insertRow, findRows, ensureSchema } = await import('../src/db/database.js');
const { encryptWithKey } = await import('../src/services/fiscal/FiscalSecretVault.js');
const { rotacionarChaveDoCofre } = await import('../src/db/rotateEncryptionKey.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const EMPRESA = 'empresa-do-cofre-mentiroso';
const CLARO_PFX = 'conteudo-inventado-do-pfx';
const CLARO_SEC = 'chave-inventada-de-integracao';

const dir = mkdtempSync(join(tmpdir(), 'gs-cofre-mentiroso-'));
const CAMINHO = join(dir, 'core.db');
process.env.DEVORA_DATABASE_PATH = CAMINHO;
process.env.TEST_DATABASE_PATH = CAMINHO;
resetEnvCacheForTests();
resetCoreSchemaCache();
ensureSchema();
ensureCoreSchema();

beforeEach(() => {
  process.env.DEVORA_ENCRYPTION_KEY = CHAVE_ANTIGA;
  resetEnvCacheForTests();
  getConnection().exec('DELETE FROM integration_secrets');
  getConnection().exec('DELETE FROM fiscal_certificate_references');

  insertRow('fiscal_certificate_references', {
    id: 'cert-1',
    companyId: EMPRESA,
    operationalUnitId: 'unit-default',
    type: 'A1',
    subject: 'TITULAR DE TESTE',
    encryptedPfx: encryptWithKey(CLARO_PFX, CHAVE_ANTIGA),
    createdAt: new Date().toISOString(),
  } as never);

  insertRow('integration_secrets', {
    id: 'sec-1',
    companyId: EMPRESA,
    secretType: 'asaas_production_api_key',
    encryptedValue: encryptWithKey(CLARO_SEC, CHAVE_ANTIGA),
    createdAt: new Date().toISOString(),
  } as never);
});

function cifradoNoBanco(store: string, id: string, campo: string): string {
  const linhas = findRows<Record<string, unknown>>(
    store as never,
    (r) => String((r as Record<string, unknown>).id) === id,
  );
  return String(linhas[0]?.[campo] ?? '');
}

// ============================================================================

describe('cofre que não devolve o que recebeu', () => {
  it('o ensaio conta ZERO resseláveis, mesmo abrindo os dois com a antiga', () => {
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    // A ida funciona: a chave antiga abre os dois.
    expect(r.abremComAAntiga).toBe(2);
    // A volta não: o que a chave nova selou não voltou igual.
    expect(r.resselaveisComANova).toBe(0);
  });

  it('e os dois viram IMPEDIMENTO nomeado, não "não abre com a antiga"', () => {
    /*
      O nome do desfecho é o que diz ao operador onde procurar. "Não abre com a
      antiga" mandaria conferir a chave antiga — que está certa. O problema é o
      outro lado.
    */
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    expect(r.impedimentos).toHaveLength(2);
    for (const i of r.impedimentos) expect(i.situacao).toBe('nao-sobrevive-a-nova');
  });

  it('a rotação de VERDADE recusa escrever — e o banco fica intacto', () => {
    const antes = [
      cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx'),
      cifradoNoBanco('integration_secrets', 'sec-1', 'encryptedValue'),
    ];

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.resselados).toBe(0);
    expect(r.conferido).toBe(false);
    expect(r.copia, 'nem a cópia deve ser tirada: não há o que copiar antes de').toBeNull();
    expect([
      cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx'),
      cifradoNoBanco('integration_secrets', 'sec-1', 'encryptedValue'),
    ]).toEqual(antes);
  });

  it('o relatório do impedimento também não carrega valor nenhum', () => {
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });
    const texto = JSON.stringify(r);
    for (const claro of [CLARO_PFX, CLARO_SEC, CHAVE_ANTIGA, CHAVE_NOVA]) {
      expect(texto).not.toContain(claro);
    }
  });
});
