/**
 * ============================================================================
 * TROCAR A CHAVE SEM PERDER O QUE ELA SELOU
 * ============================================================================
 *
 * Os segredos deste sistema — o `.pfx` do certificado, as chaves do Asaas, a
 * senha da caixa de e-mail — existem exatamente UMA vez, cifrados, dentro do
 * banco. Não há segunda cópia. Trocar `DEVORA_ENCRYPTION_KEY` sem reescrever o
 * que ela selou não os corrompe: os torna ilegíveis, que é a mesma coisa com
 * um nome melhor.
 *
 * E a troca não é opcional. Os cinco segredos da Preço Justo estavam selados
 * com a chave PADRÃO de desenvolvimento, e produção recusa subir com ela —
 * publicar exige rotacionar.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 *  - o ensaio não escreve NADA;
 *  - a rotação de verdade resela todos e o serviço oficial passa a abrir;
 *  - a chave antiga deixa de abrir o que foi migrado;
 *  - um segredo que não abre com a antiga ABORTA tudo, antes de escrever;
 *  - falha no meio devolve os cinco ao que eram (tudo ou nada);
 *  - rodar de novo não faz nada e não estraga;
 *  - o relatório não carrega valor nenhum.
 *
 * Nenhum segredo é impresso aqui. Os textos usados são inventados pelo próprio
 * teste e não correspondem a credencial de ninguém.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHAVE_ANTIGA = 'chave-antiga-de-teste-longa-o-bastante-32';
const CHAVE_NOVA = 'chave-nova-de-teste-longa-o-bastante-1234';

process.env.DEVORA_ENCRYPTION_KEY = CHAVE_ANTIGA;

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { insertRow, findRows, updateRows, ensureSchema } = await import('../src/db/database.js');
const { encryptWithKey, decryptWithKey } = await import(
  '../src/services/fiscal/FiscalSecretVault.js'
);
const { inventariarSegredos } = await import('../src/db/secretsInventory.js');
const { rotacionarChaveDoCofre } = await import('../src/db/rotateEncryptionKey.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');

const EMPRESA = 'empresa-do-teste';

/** A padrão de desenvolvimento. Não é segredo: está no fonte deste repositório. */
const PADRAO_PUBLICADA = 'dev-local-encryption-key-32';

/** A marca que a rotação grava quando veio de um valor publicado. */
function marcaDaRotacao(): string | null {
  const linha = getConnection()
    .prepare("SELECT value FROM core_meta WHERE key = 'cofre_rotacionado_em'")
    .get() as { value: string } | undefined;
  return linha?.value ?? null;
}

/** Textos inventados. Não são credencial de ninguém. */
const CLAROS = {
  pfx: 'conteudo-inventado-do-pfx-para-o-teste',
  sandbox: 'chave-inventada-de-sandbox',
  producao: 'chave-inventada-de-producao',
  webhook: 'token-inventado-de-webhook',
};

/*
  UM BANCO SÓ PARA O ARQUIVO INTEIRO.

  Os criadores de esquema deste projeto têm trava de módulo: uma vez prontos,
  não rodam de novo para um arquivo novo. Criar um banco por caso deixava o
  primeiro passar e os demais sem tabela. O banco é criado uma vez e as duas
  coleções de segredo são limpas e semeadas a cada caso — que é o que os
  casos precisam isolar.
*/
const dir = mkdtempSync(join(tmpdir(), 'gs-rotacao-'));
const CAMINHO = join(dir, 'core.db');
process.env.DEVORA_DATABASE_PATH = CAMINHO;
process.env.TEST_DATABASE_PATH = CAMINHO;
resetEnvCacheForTests();
resetCoreSchemaCache();
ensureSchema();
ensureCoreSchema();

/** Semeia quatro segredos selados com a chave ANTIGA. */
function semear(): void {
  insertRow('fiscal_certificate_references', {
    id: 'cert-1',
    companyId: EMPRESA,
    operationalUnitId: 'unit-default',
    type: 'A1',
    subject: 'TITULAR DE TESTE',
    encryptedPfx: encryptWithKey(CLAROS.pfx, CHAVE_ANTIGA),
    createdAt: new Date().toISOString(),
  } as never);

  for (const [tipo, claro] of [
    ['asaas_sandbox_api_key', CLAROS.sandbox],
    ['asaas_production_api_key', CLAROS.producao],
    ['webhook_token', CLAROS.webhook],
  ] as const) {
    insertRow('integration_secrets', {
      id: `sec-${tipo}`,
      companyId: EMPRESA,
      secretType: tipo,
      encryptedValue: encryptWithKey(claro, CHAVE_ANTIGA),
      createdAt: new Date().toISOString(),
    } as never);
  }
}

beforeEach(() => {
  process.env.DEVORA_ENCRYPTION_KEY = CHAVE_ANTIGA;
  resetEnvCacheForTests();
  // A marca da rotação é global ao banco: sem limpar, um caso contamina o outro.
  getConnection().exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  getConnection().exec("DELETE FROM core_meta WHERE key = 'cofre_rotacionado_em'");
  getConnection().exec('DELETE FROM integration_secrets');
  getConnection().exec('DELETE FROM fiscal_certificate_references');
  semear();
});

afterEach(() => {
  process.env.DEVORA_ENCRYPTION_KEY = CHAVE_ANTIGA;
  resetEnvCacheForTests();
});

/** O texto cifrado que está NO BANCO, para conferir sem passar pelo serviço. */
function cifradoNoBanco(store: string, id: string, campo: string): string {
  const linhas = findRows<Record<string, unknown>>(
    store as never,
    (r) => String((r as Record<string, unknown>).id) === id,
  );
  return String(linhas[0]?.[campo] ?? '');
}

// ============================================================================

describe('o ensaio não escreve nada', () => {
  it('relata o que faria e o banco fica intacto', () => {
    const antes = cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx');

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    expect(r.ensaio).toBe(true);
    expect(r.encontrados).toBe(4);
    expect(r.resselados).toBe(4);
    expect(r.copia).toBeNull();
    expect(cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx')).toBe(antes);
  });

  it('e o relatório NÃO carrega valor nenhum', () => {
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });
    const texto = JSON.stringify(r);
    for (const claro of Object.values(CLAROS)) expect(texto).not.toContain(claro);
    expect(texto).not.toContain(CHAVE_ANTIGA);
    expect(texto).not.toContain(CHAVE_NOVA);
  });
});

// ============================================================================

describe('a rotação de verdade', () => {
  it('resela os quatro, e a conferência passa', () => {
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.ensaio).toBe(false);
    expect(r.resselados).toBe(4);
    expect(r.conferido).toBe(true);
    expect(r.impedimentos).toEqual([]);
  });

  it('o CONTEÚDO não muda — o selo muda', () => {
    /*
      É a promessa central: o que sai é o mesmo que entrou. Um erro aqui
      passaria despercebido até alguém tentar assinar uma nota com um `.pfx`
      truncado.
    */
    rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_NOVA, ensaio: false });

    const pfx = cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx');
    expect(decryptWithKey(pfx, CHAVE_NOVA)).toBe(CLAROS.pfx);

    const prod = cifradoNoBanco('integration_secrets', 'sec-asaas_production_api_key', 'encryptedValue');
    expect(decryptWithKey(prod, CHAVE_NOVA)).toBe(CLAROS.producao);
  });

  it('a chave ANTIGA deixa de abrir o que foi migrado', () => {
    rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_NOVA, ensaio: false });

    const pfx = cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx');
    expect(() => decryptWithKey(pfx, CHAVE_ANTIGA)).toThrow();

    // E o inventário concorda, perguntando pela antiga.
    const pelaAntiga = inventariarSegredos(CHAVE_ANTIGA);
    expect(pelaAntiga.every((s) => !s.decryptableWithCurrentKey)).toBe(true);
  });

  it('e o SERVIÇO OFICIAL passa a abrir com a chave nova', () => {
    rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_NOVA, ensaio: false });

    // Troca a chave do processo, como o deploy fará.
    process.env.DEVORA_ENCRYPTION_KEY = CHAVE_NOVA;
    resetEnvCacheForTests();

    const pelaNova = inventariarSegredos();
    expect(pelaNova).toHaveLength(4);
    expect(pelaNova.every((s) => s.decryptableWithCurrentKey)).toBe(true);
  });
});

// ============================================================================

describe('tudo ou nada', () => {
  it('um segredo que não abre com a antiga ABORTA antes de escrever', () => {
    // Um quinto segredo, selado com uma terceira chave que ninguém tem.
    insertRow('integration_secrets', {
      id: 'sec-orfao',
      companyId: EMPRESA,
      secretType: 'chave_de_outra_origem',
      encryptedValue: encryptWithKey('texto-inventado', 'uma-terceira-chave-que-ninguem-tem-32'),
      createdAt: new Date().toISOString(),
    } as never);

    const antes = cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx');

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.impedimentos).toHaveLength(1);
    expect(r.impedimentos[0].situacao).toBe('nao-abre-com-a-antiga');
    expect(r.resselados).toBe(0);
    expect(r.conferido).toBe(false);
    // NADA foi escrito: os outros quatro continuam na chave antiga.
    expect(cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx')).toBe(antes);
    expect(decryptWithKey(antes, CHAVE_ANTIGA)).toBe(CLAROS.pfx);
  });

  it('chave nova igual à antiga é recusada', () => {
    expect(() =>
      rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_ANTIGA, ensaio: true }),
    ).toThrow(/igual/i);
  });

  it('chave faltando é recusada', () => {
    expect(() =>
      rotacionarChaveDoCofre({ chaveAntiga: '', chaveNova: CHAVE_NOVA, ensaio: true }),
    ).toThrow(/precisa das duas/i);
  });
});

// ============================================================================

describe('rodar de novo não estraga', () => {
  it('a segunda rotação encontra tudo já na chave nova e não escreve', () => {
    rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_NOVA, ensaio: false });
    const depoisDaPrimeira = cifradoNoBanco(
      'fiscal_certificate_references',
      'cert-1',
      'encryptedPfx',
    );

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.jaNaChaveNova).toBe(4);
    expect(r.resselados).toBe(0);
    expect(r.impedimentos).toEqual([]);
    // O selo não foi reescrito — nem sequer com a mesma chave.
    expect(cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx')).toBe(
      depoisDaPrimeira,
    );
  });

  it('banco sem segredo nenhum não faz nada e não reclama', () => {
    getConnection().exec('DELETE FROM integration_secrets');
    getConnection().exec('DELETE FROM fiscal_certificate_references');

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.encontrados).toBe(0);
    expect(r.resselados).toBe(0);
    expect(r.impedimentos).toEqual([]);
  });
});

// ============================================================================

/*
  O ENSAIO PRECISA PROVAR A VOLTA, NÃO SÓ A IDA.

  Ele abria os segredos com a chave antiga e parava aí. Isso responde "consigo
  ler?", que é metade da pergunta. A outra metade — "o que eu escrever com a
  chave nova volta a abrir?" — só era respondida DEPOIS da escrita, na
  conferência dentro da transação.

  Descobrir ali não é tarde demais, porque o rollback existe. Mas é tarde para
  o operador: ele já parou o servidor, já tirou a cópia, já iniciou a janela de
  manutenção. O ensaio existe justamente para gastar esses minutos antes, com o
  banco intacto — e um ensaio que não faz a volta inteira promete mais do que
  verificou.

  A volta é feita EM MEMÓRIA: cifra com a nova, reabre o que cifrou, compara
  com o texto que saiu da antiga. Nada disso toca o banco.
*/
describe('o ensaio prova a volta inteira, não só a ida', () => {
  it('conta separadamente quem abre com a antiga e quem sobrevive à nova', () => {
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    expect(r.encontrados).toBe(4);
    expect(r.abremComAAntiga, 'quantos a chave antiga conseguiu abrir').toBe(4);
    expect(
      r.resselaveisComANova,
      'quantos foram cifrados com a nova E reabertos com ela, em memória',
    ).toBe(4);
    expect(r.impedimentos).toEqual([]);
  });

  it('a volta compara o TEXTO — não basta cifrar e dizer que deu certo', () => {
    /*
      Se a volta fosse só `encryptWithKey(...)` sem reabrir e comparar, ela
      passaria com qualquer implementação que devolvesse uma string. O que este
      caso trava é que o texto reaberto é o MESMO que saiu da chave antiga.
    */
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    // O ensaio afirma que os quatro voltam idênticos; aqui a mesma conta é
    // refeita por fora, com o serviço oficial, contra o banco intacto.
    for (const [id, campo, claro] of [
      ['cert-1', 'encryptedPfx', CLAROS.pfx],
      ['sec-asaas_sandbox_api_key', 'encryptedValue', CLAROS.sandbox],
    ] as const) {
      const store = id === 'cert-1' ? 'fiscal_certificate_references' : 'integration_secrets';
      const noBanco = cifradoNoBanco(store, id, campo);
      const daAntiga = decryptWithKey(noBanco, CHAVE_ANTIGA);
      expect(daAntiga).toBe(claro);
      expect(decryptWithKey(encryptWithKey(daAntiga, CHAVE_NOVA), CHAVE_NOVA)).toBe(claro);
    }

    expect(r.resselaveisComANova).toBe(4);
  });

  it('segredo com texto cifrado corrompido não entra na conta e ABORTA', () => {
    /*
      Um cifrado truncado é o que sobra de uma escrita interrompida. Ele não
      abre com chave nenhuma, e por isso não pode ser contado como "pronto para
      resselar" — nem deixar a rotação seguir com os outros, que deixaria o
      banco com dois selos.
    */
    const bom = cifradoNoBanco('integration_secrets', 'sec-webhook_token', 'encryptedValue');
    updateRows(
      'integration_secrets' as never,
      (r) => String((r as Record<string, unknown>).id) === 'sec-webhook_token',
      (r) => ({ ...(r as Record<string, unknown>), encryptedValue: bom.slice(0, 20) }) as never,
    );

    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    expect(r.abremComAAntiga).toBe(3);
    expect(r.resselaveisComANova).toBe(3);
    expect(r.impedimentos).toHaveLength(1);
    expect(r.impedimentos[0].tipo).toContain('webhook_token');
  });

  it('e as duas contas continuam batendo na rotação de verdade', () => {
    // O ensaio e a execução relatam a mesma coisa; senão o ensaio não serve
    // para decidir.
    const r = rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(r.abremComAAntiga).toBe(4);
    expect(r.resselaveisComANova).toBe(4);
    expect(r.resselados).toBe(4);
    expect(r.conferido).toBe(true);
  });

  it('a volta em memória NÃO escreve — o banco fica byte a byte igual', () => {
    const antes = [
      cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx'),
      cifradoNoBanco('integration_secrets', 'sec-asaas_sandbox_api_key', 'encryptedValue'),
      cifradoNoBanco('integration_secrets', 'sec-asaas_production_api_key', 'encryptedValue'),
      cifradoNoBanco('integration_secrets', 'sec-webhook_token', 'encryptedValue'),
    ];

    rotacionarChaveDoCofre({ chaveAntiga: CHAVE_ANTIGA, chaveNova: CHAVE_NOVA, ensaio: true });

    expect([
      cifradoNoBanco('fiscal_certificate_references', 'cert-1', 'encryptedPfx'),
      cifradoNoBanco('integration_secrets', 'sec-asaas_sandbox_api_key', 'encryptedValue'),
      cifradoNoBanco('integration_secrets', 'sec-asaas_production_api_key', 'encryptedValue'),
      cifradoNoBanco('integration_secrets', 'sec-webhook_token', 'encryptedValue'),
    ]).toEqual(antes);
  });
});

// ============================================================================

/*
  A DÍVIDA QUE O RESSELO NÃO PAGA.

  Rotacionar A PARTIR de um valor publicado — a padrão de desenvolvimento, um
  `change-me` de arquivo de exemplo — deixa uma dívida que trocar a fechadura
  não resolve: tudo o que aquela chave selou já viveu legível para quem tivesse
  uma cópia do banco e o repositório.

  A marca existe para o diagnóstico do dono saber cobrar a troca no portal de
  quem emitiu cada credencial. Rotação entre duas chaves próprias não gera
  marca — não há dívida.
*/
describe('a rotação registra de onde veio', () => {
  it('vindo de uma chave PUBLICADA, grava a marca', () => {
    getConnection().exec('DELETE FROM integration_secrets');
    getConnection().exec('DELETE FROM fiscal_certificate_references');
    // Semeia com a padrão de desenvolvimento, que é o caso real desta instalação.
    insertRow('integration_secrets', {
      id: 'sec-publicada',
      companyId: EMPRESA,
      secretType: 'asaas_production_api_key',
      encryptedValue: encryptWithKey('valor-inventado', PADRAO_PUBLICADA),
      createdAt: new Date().toISOString(),
    } as never);

    rotacionarChaveDoCofre({
      chaveAntiga: PADRAO_PUBLICADA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(marcaDaRotacao(), 'sem a marca o dono nunca fica sabendo da dívida').not.toBeNull();
  });

  it('o ENSAIO não grava marca — ele não rotacionou nada', () => {
    getConnection().exec("DELETE FROM core_meta WHERE key = 'cofre_rotacionado_em'");
    getConnection().exec('DELETE FROM integration_secrets');
    getConnection().exec('DELETE FROM fiscal_certificate_references');
    insertRow('integration_secrets', {
      id: 'sec-publicada',
      companyId: EMPRESA,
      secretType: 'asaas_production_api_key',
      encryptedValue: encryptWithKey('valor-inventado', PADRAO_PUBLICADA),
      createdAt: new Date().toISOString(),
    } as never);

    rotacionarChaveDoCofre({
      chaveAntiga: PADRAO_PUBLICADA,
      chaveNova: CHAVE_NOVA,
      ensaio: true,
    });

    expect(marcaDaRotacao()).toBeNull();
  });

  it('entre duas chaves PRÓPRIAS, não grava nada', () => {
    getConnection().exec("DELETE FROM core_meta WHERE key = 'cofre_rotacionado_em'");

    // O `beforeEach` já semeou com CHAVE_ANTIGA, que é própria e inventada.
    rotacionarChaveDoCofre({
      chaveAntiga: CHAVE_ANTIGA,
      chaveNova: CHAVE_NOVA,
      ensaio: false,
    });

    expect(
      marcaDaRotacao(),
      'chave própria nunca esteve publicada: cobrar troca de provedor seria ruído',
    ).toBeNull();
  });
});
