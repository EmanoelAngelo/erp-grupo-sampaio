/**
 * A SUBIDA NÃO MATERIALIZA A CAMADA DE DOCUMENTOS (GAP-PRD-148).
 *
 * `runMigrations` começava com `loadDb()`: lia TODAS as coleções — cada linha
 * passando por `JSON.parse` — a cada boot, para então descobrir que o banco já
 * estava na versão 19 e não fazer nada. E cada degrau pendente chamava
 * `persistDb`, que APAGA e REINSERE todas as coleções numa transação só, para
 * gravar exatamente o mesmo conteúdo. Com `api_request_logs` (30 dias) e
 * `api_sessions` crescendo, a subida ficava mais lenta a cada semana, e um
 * degrau novo reescreveria o banco de documentos inteiro.
 *
 * Os degraus 2..19 só garantiam que a coleção existisse como lista vazia — o
 * que a tabela, criada por `ensureSchema`, já garante. Então a versão passa a
 * ser lida de `db_meta` e o que falta é só carimbá-la.
 *
 * COMO SE PROVA SEM ESPIAR A FUNÇÃO: uma linha de coleção que o `JSON.parse`
 * recusa. Qualquer caminho que materialize a camada estoura nela; o boot que
 * só lê a versão nem a vê. E o `seq` da linha boa não muda: o `persistDb`
 * antigo reinseria tudo e renumerava.
 *
 * A linha é JSON com uma vírgula sobrando, e não lixo: desde o GAP-PRD-147 a
 * coleção tem `company_id` gerada por `json_extract`, e o SQLite recusa lixo
 * já na escrita. A vírgula sobrando o SQLite aceita (JSON5), e o `JSON.parse`
 * não — exatamente a distância entre "o banco guarda" e "a varredura em
 * JavaScript consegue ler".
 */
const QUEBRADA = '{"id":"quebrada","x":1,}';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/sqlite.js';
import { ensureSchema, getSchemaVersion, resetDbForTests, setSchemaVersion } from '../src/db/database.js';
import { ALVO_DA_CAMADA_DE_DOCUMENTOS, runMigrations } from '../src/db/migrate.js';
import { prepararBanco } from '../src/db/migracaoCompleta.js';
import { evaluateCoreProductionReadiness } from '../src/services/system-admin/CoreProductionReadinessService.js';

const COLECAO = 'api_request_logs';

function inserirCru(id: string, data: string): number {
  const r = getConnection().prepare(`INSERT INTO "${COLECAO}" (id, data) VALUES (?, ?)`).run(id, data);
  return Number(r.lastInsertRowid);
}

function seqDe(id: string): number | undefined {
  const row = getConnection().prepare(`SELECT seq FROM "${COLECAO}" WHERE id = ?`).get(id) as { seq?: number } | undefined;
  return row?.seq;
}

beforeEach(() => {
  resetDbForTests();
  ensureSchema();
});

describe('o boot lê a versão, não o conteúdo', () => {
  it('banco na versão 19: runMigrations não abre linha nenhuma', () => {
    setSchemaVersion(ALVO_DA_CAMADA_DE_DOCUMENTOS);
    inserirCru('quebrada', QUEBRADA);
    expect(() => runMigrations()).not.toThrow();
    expect(getSchemaVersion()).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
  });

  it('banco parado num degrau antigo sobe para 19 sem reescrever as coleções', () => {
    setSchemaVersion(5);
    const seqBoa = inserirCru('boa', JSON.stringify({ id: 'boa', companyId: 'c-1' }));
    inserirCru('quebrada', QUEBRADA);

    expect(() => runMigrations()).not.toThrow();
    expect(getSchemaVersion()).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
    // O persistDb antigo apagava e reinseria: a linha voltava com outro seq.
    expect(seqDe('boa')).toBe(seqBoa);
    expect(seqDe('quebrada')).toBeDefined();
  });

  it('banco novo (sem versão) é carimbado com o alvo', () => {
    getConnection().exec("DELETE FROM db_meta WHERE key = 'version'");
    runMigrations();
    expect(getSchemaVersion()).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
  });

  it('o boot inteiro (documentos + núcleo) e a prontidão também não materializam', () => {
    setSchemaVersion(ALVO_DA_CAMADA_DE_DOCUMENTOS);
    inserirCru('quebrada', QUEBRADA);
    expect(() => prepararBanco()).not.toThrow();
    const prontidao = evaluateCoreProductionReadiness();
    expect(prontidao.schema.documentos.versao).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
  });
});
