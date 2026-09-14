/**
 * Um backup só vale quando alguém já VOLTOU dele.
 *
 * A auditoria da rodada 35 mediu o que existia: snapshot pré-migração e backup
 * manual, os dois corretos (VACUUM INTO, com o WAL) — e TRÊS coisas que
 * anulavam os dois:
 *
 *   1. O backup morava em `server/data/backups`, a mesma pasta do banco, no
 *      mesmo disco. Disco morre, morrem os dois.
 *   2. Não havia backup AUTOMÁTICO. Só rodava quando alguém lembrava, e a
 *      última vez foi 17/08.
 *   3. A limpeza mantinha 10 arquivos e não distinguia snapshot de migração de
 *      backup manual: dez migrações seguidas apagavam todos os backups que o
 *      dono tirou. E `scripts/restore-verify.ts` procurava `devora-backup-*.json`
 *      numa pasta que não existe — era do projeto anterior, nunca rodou aqui.
 *
 * Este arquivo prova a parte que nenhum dos dois provava: que um arquivo
 * gerado por `snapshotDatabase` ABRE, tem as tabelas, tem as linhas, e que a
 * função de restauração devolve um banco idêntico. Tudo em diretório
 * temporário próprio — nunca no banco operacional, nunca no banco da suíte.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copiarBancoParaArquivo,
  listarBackups,
  podarBackups,
  restaurarBackupEm,
  verificarBackup,
} from '../src/db/backup.js';

let pasta: string;

/** Um banco pequeno e reconhecível — não é o da suíte, não é o operacional. */
function bancoDeOrigem(caminho: string): DatabaseSync {
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE vendas (id INTEGER PRIMARY KEY, total_cents INTEGER NOT NULL)');
  db.exec('INSERT INTO vendas (total_cents) VALUES (1000), (2500), (999)');
  return db;
}

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), 'gs-backup-'));
});

afterEach(() => {
  rmSync(pasta, { recursive: true, force: true });
});

describe('o arquivo de backup', () => {
  it('abre, tem as tabelas e tem as linhas — inclusive as que só estavam no WAL', () => {
    const origem = join(pasta, 'origem.db');
    const db = bancoDeOrigem(origem);
    // Com WAL, esta linha mora no -wal até o checkpoint. Copiar só o .db a
    // perderia — é o "pior tipo de backup" que o módulo já avisava.
    db.exec('INSERT INTO vendas (total_cents) VALUES (777)');

    const destino = join(pasta, 'copia.db');
    copiarBancoParaArquivo(db, destino);
    db.close();

    const copia = new DatabaseSync(destino, { readOnly: true });
    const linhas = copia.prepare('SELECT total_cents FROM vendas ORDER BY id').all() as { total_cents: number }[];
    copia.close();
    expect(linhas.map((l) => l.total_cents)).toEqual([1000, 2500, 999, 777]);
  });

  it('a verificação recusa arquivo que não é SQLite íntegro', () => {
    const falso = join(pasta, 'falso.db');
    writeFileSync(falso, 'isto nao e um banco');
    const veredito = verificarBackup(falso);
    expect(veredito.ok).toBe(false);
    expect(veredito.motivo).toBeTruthy();
  });

  it('a verificação recusa um SQLite que ABRE mas está corrompido por dentro', () => {
    /*
      O caso anterior (texto puro) nem chega a abrir e cai no catch — ele não
      exercita o integrity_check. Este foi escrito depois de provar isso:
      com o integrity_check desligado, a suíte continuava verde. Um banco com
      página estragada abre normalmente e é exatamente o que um disco morrendo
      produz.
    */
    const origem = join(pasta, 'origem.db');
    const db = bancoDeOrigem(origem);
    // Volume de dado para ter páginas além do cabeçalho.
    for (let i = 0; i < 300; i += 1) db.exec(`INSERT INTO vendas (total_cents) VALUES (${i})`);
    const destino = join(pasta, 'corrompido.db');
    copiarBancoParaArquivo(db, destino);
    db.close();

    // Estraga bytes no MEIO do arquivo, preservando o cabeçalho de 100 bytes:
    // o SQLite abre, e o integrity_check é quem descobre.
    const { openSync, writeSync, closeSync } = require('node:fs') as typeof import('node:fs');
    const tamanho = statSync(destino).size;
    const fd = openSync(destino, 'r+');
    writeSync(fd, Buffer.alloc(512, 0xff), 0, 512, Math.floor(tamanho / 2));
    closeSync(fd);

    const veredito = verificarBackup(destino);
    expect(veredito.ok).toBe(false);
    expect(veredito.motivo ?? '').not.toBe('');
  });

  it('a verificação aprova um backup de verdade e diz quantas tabelas tem', () => {
    const origem = join(pasta, 'origem.db');
    const db = bancoDeOrigem(origem);
    const destino = join(pasta, 'copia.db');
    copiarBancoParaArquivo(db, destino);
    db.close();

    const veredito = verificarBackup(destino);
    expect(veredito.ok).toBe(true);
    expect(veredito.tabelas).toBeGreaterThanOrEqual(1);
  });
});

describe('restaurar', () => {
  it('devolve um banco idêntico, num caminho novo, sem tocar no original', () => {
    const origem = join(pasta, 'origem.db');
    const db = bancoDeOrigem(origem);
    const backup = join(pasta, 'backup.db');
    copiarBancoParaArquivo(db, backup);
    db.close();

    const restaurado = join(pasta, 'restaurado.db');
    const resultado = restaurarBackupEm(backup, restaurado);
    expect(resultado.ok).toBe(true);
    expect(existsSync(restaurado)).toBe(true);

    const r = new DatabaseSync(restaurado, { readOnly: true });
    const soma = (r.prepare('SELECT SUM(total_cents) AS s FROM vendas').get() as { s: number }).s;
    r.close();
    expect(soma).toBe(1000 + 2500 + 999);

    // O backup continua lá, intacto: restaurar é copiar, não mover.
    expect(existsSync(backup)).toBe(true);
  });

  it('se recusa a restaurar por cima de um arquivo que já existe', () => {
    /*
      Restaurar POR CIMA do banco em uso, com o servidor ligado, corrompe os
      dois. A função não conhece o servidor, então a regra é mais simples e
      mais dura: o destino precisa não existir. Quem quer substituir o banco
      em uso para o servidor, renomeia o atual e restaura no caminho livre.
    */
    const origem = join(pasta, 'origem.db');
    const db = bancoDeOrigem(origem);
    const backup = join(pasta, 'backup.db');
    copiarBancoParaArquivo(db, backup);
    db.close();

    const resultado = restaurarBackupEm(backup, origem);
    expect(resultado.ok).toBe(false);
    expect(resultado.motivo).toMatch(/já existe/i);
  });

  it('recusa restaurar um arquivo que não passa na verificação', () => {
    const falso = join(pasta, 'falso.db');
    writeFileSync(falso, 'lixo');
    const resultado = restaurarBackupEm(falso, join(pasta, 'saida.db'));
    expect(resultado.ok).toBe(false);
    expect(existsSync(join(pasta, 'saida.db'))).toBe(false);
  });
});

describe('retenção', () => {
  function criar(nome: string, idadeDias: number) {
    const caminho = join(pasta, nome);
    writeFileSync(caminho, 'x');
    const quando = Date.now() - idadeDias * 86_400_000;
    // utimes via fs: mtime define a idade que a poda enxerga.
    const { utimesSync } = require('node:fs') as typeof import('node:fs');
    utimesSync(caminho, quando / 1000, quando / 1000);
  }

  it('a poda NUNCA deixa a pasta com menos que o mínimo, por mais velhos que sejam', () => {
    for (let i = 1; i <= 5; i += 1) criar(`grupo-sampaio-2026-01-0${i}-diario.db`, 400 + i);
    podarBackups(pasta, { manterDias: 30, manterMinimo: 3 });
    const sobraram = readdirSync(pasta).filter((f) => f.endsWith('.db'));
    expect(sobraram.length).toBe(3);
  });

  it('a poda apaga só o que passou do prazo E está acima do mínimo', () => {
    criar('grupo-sampaio-velho-1-diario.db', 60);
    criar('grupo-sampaio-velho-2-diario.db', 45);
    criar('grupo-sampaio-novo-1-diario.db', 2);
    criar('grupo-sampaio-novo-2-diario.db', 1);
    podarBackups(pasta, { manterDias: 30, manterMinimo: 2 });
    const sobraram = readdirSync(pasta).filter((f) => f.endsWith('.db')).sort();
    expect(sobraram).toEqual(['grupo-sampaio-novo-1-diario.db', 'grupo-sampaio-novo-2-diario.db']);
  });

  it('snapshot de migração e backup diário são podados em separado', () => {
    /*
      O defeito medido: uma poda só, de 10 arquivos, sem distinguir motivo.
      Dez migrações seguidas apagavam todos os backups manuais do dono.
    */
    for (let i = 1; i <= 12; i += 1) criar(`grupo-sampaio-2026-08-${String(i).padStart(2, '0')}-migration.db`, 1);
    criar('grupo-sampaio-2026-07-01-manual.db', 50);
    criar('grupo-sampaio-2026-07-02-diario.db', 49);
    podarBackups(pasta, { manterDias: 30, manterMinimo: 3, motivo: 'migration', manterMaximo: 5 });
    const migracoes = readdirSync(pasta).filter((f) => f.endsWith('-migration.db'));
    const outros = readdirSync(pasta).filter((f) => !f.endsWith('-migration.db') && f.endsWith('.db'));
    expect(migracoes.length).toBe(5);
    // Os que não são de migração não foram tocados por esta poda.
    expect(outros.length).toBe(2);
  });

  it('listarBackups devolve nome, tamanho, data e motivo, do mais novo ao mais velho', () => {
    criar('grupo-sampaio-a-diario.db', 3);
    criar('grupo-sampaio-b-manual.db', 1);
    const lista = listarBackups(pasta);
    expect(lista.map((b) => b.motivo)).toEqual(['manual', 'diario']);
    expect(lista[0].bytes).toBe(statSync(join(pasta, 'grupo-sampaio-b-manual.db')).size);
    expect(lista[0].createdAt).toBeTruthy();
  });
});
