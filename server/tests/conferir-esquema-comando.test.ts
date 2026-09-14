/**
 * O COMANDO `npm run db:conferir-esquema` (GAP-PRD-140).
 *
 * Cada caso cai quando o guarda correspondente sai de `conferirEsquema.ts`:
 *   - o ensaio que abrisse o banco para escrita (ou migrasse) repararia o
 *     índice sem ninguém pedir — o primeiro caso confere que ele continua
 *     faltando depois do ensaio;
 *   - o `--reparar` sem a trava repararia com a API no ar;
 *   - sem a cópia, a pasta de backup não teria o banco de ANTES do reparo;
 *   - caminho sem banco não pode virar banco novo vazio.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { criarColecoesDeDocumentos } = await import('../src/db/database.js');
const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
const { conferirEsquemaPelaLinhaDeComando } = await import('../src/db/conferirEsquema.js');

function saida() {
  const linhas: string[] = [];
  return { escrever: (l: string) => void linhas.push(l), texto: () => linhas.join('\n') };
}

/** Um banco migrado pelo caminho do boot, fechado — como o da loja com a API parada. */
function bancoMigrado(): { dir: string; caminho: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-conferir-'));
  const caminho = join(dir, 'loja.db');
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = caminho;
  resetCoreSchemaCache();
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  migrateCoreSchema();
  closeConnection();
  resetCoreSchemaCache();
  return { dir, caminho };
}

function temIndice(caminho: string, nome: string): boolean {
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(nome));
  } finally {
    db.close();
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

describe('npm run db:conferir-esquema', () => {
  it('o ensaio só lê; o --reparar recusa com a API no ar e, com ela parada, copia, repara e confere', () => {
    const { dir, caminho } = bancoMigrado();
    try {
      const w = new DatabaseSync(caminho);
      w.exec('DROP INDEX ix_fiscal_docs_order');
      w.close();

      const ensaio = saida();
      expect(conferirEsquemaPelaLinhaDeComando([], ensaio.escrever, ensaio.escrever)).toBe(1);
      expect(ensaio.texto()).toMatch(/Ensaio: o banco foi aberto só para leitura/);
      expect(ensaio.texto()).toMatch(/Índice ix_fiscal_docs_order \(core_fiscal_documents\) falta neste banco/);
      expect(ensaio.texto()).toMatch(/--reparar/);
      // O ensaio não consertou nada.
      expect(temIndice(caminho, 'ix_fiscal_docs_order')).toBe(false);

      // A API no ar: o banco tem dono, noutra máquina, batendo agora.
      const agora = new Date().toISOString();
      const w2 = new DatabaseSync(caminho);
      w2.prepare(
        `INSERT INTO core_instancia (papel, token, tipo, pid, host, iniciado_em, batida_em)
         VALUES ('dono', 'token-da-api', 'api', 4242, 'OUTRA-MAQUINA', ?, ?)`,
      ).run(agora, agora);
      w2.close();
      const ocupado = saida();
      expect(conferirEsquemaPelaLinhaDeComando(['--reparar'], ocupado.escrever, ocupado.escrever)).toBe(1);
      expect(ocupado.texto()).toMatch(/Outra instância já usa este banco/);
      expect(ocupado.texto()).toMatch(/Nada foi reparado/);
      expect(temIndice(caminho, 'ix_fiscal_docs_order')).toBe(false);

      // A API parada.
      const w3 = new DatabaseSync(caminho);
      w3.exec('DELETE FROM core_instancia');
      w3.close();
      const reparo = saida();
      expect(conferirEsquemaPelaLinhaDeComando(['--reparar'], reparo.escrever, reparo.escrever)).toBe(0);
      const copia = /Cópia do banco antes do reparo: (.+)$/m.exec(reparo.texto())?.[1]?.trim();
      expect(copia, reparo.texto()).toBeTruthy();
      expect(existsSync(copia!)).toBe(true);
      // A cópia é o banco de ANTES do reparo.
      expect(temIndice(copia!, 'ix_fiscal_docs_order')).toBe(false);
      expect(reparo.texto()).toMatch(/IDÊNTICO/);
      expect(temIndice(caminho, 'ix_fiscal_docs_order')).toBe(true);

      const depois = saida();
      expect(conferirEsquemaPelaLinhaDeComando([], depois.escrever, depois.escrever)).toBe(0);
      expect(depois.texto()).toMatch(/IDÊNTICO/);
    } finally {
      limpar(dir);
    }
  });

  it('caminho sem banco: nem o ensaio nem o reparo criam o arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-conferir-vazio-'));
    const caminho = join(dir, 'nao-existe.db');
    try {
      closeConnection();
      process.env.DEVORA_DATABASE_PATH = caminho;
      const s = saida();
      expect(conferirEsquemaPelaLinhaDeComando([], s.escrever, s.escrever)).toBe(1);
      expect(conferirEsquemaPelaLinhaDeComando(['--reparar'], s.escrever, s.escrever)).toBe(1);
      expect(s.texto()).toMatch(/Não há banco neste caminho/);
      expect(existsSync(caminho)).toBe(false);
    } finally {
      limpar(dir);
    }
  });
});
