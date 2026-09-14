/**
 * AS TABELAS MORTAS SAEM (GAP-PRD-141).
 *
 * Duas sobras, medidas pela auditoria:
 *
 *   1. COLEÇÕES SEM LEITOR NEM ESCRITOR criadas em toda instalação: das 132 de
 *      `TABLE_NAMES`, 72 não tinham uma única referência em `server/src` fora
 *      de `db/` — e, com /crm, /automations e /bi desmontados (GAP-PRD-075),
 *      passaram a ser 90. Cada boot as criava, cada reset de teste as
 *      esvaziava, e cada backup as carregava.
 *   2. 81 TABELAS LEGADAS no banco real (oms_*, workshop_*, rental_*,
 *      promotion*, ecommerce_*) que a rodada 36 tirou de `TABLE_NAMES` sem
 *      nunca apagar do arquivo.
 *
 * A primeira se resolve no código: `TABLE_NAMES` só tem coleção que alguém lê
 * ou escreve, e a trava abaixo impede que volte a ter. A segunda é DADO no
 * banco do dono, e o código oferece o caminho — sem aplicar nada no banco
 * real agora: `podarTabelasAposentadas` apaga só o que está na lista das
 * aposentadas E está vazio; tabela aposentada com linha fica, e é dita.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { TABLE_NAMES, ensureSchema } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  TABELAS_APOSENTADAS,
  podarTabelasAposentadas,
} from '../src/db/tabelasAposentadas.js';
import { podarPelaLinhaDeComando } from '../src/scripts/podar-tabelas-aposentadas.js';
import { liberarInstancia, tentarAssumir } from '../src/services/implantacao/instanciaUnica.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '../src');

const raiz = process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir();
const pasta = mkdtempSync(join(raiz, 'gs poda '));
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

function arquivosTs(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) arquivosTs(p, saida);
    else if (p.endsWith('.ts')) saida.push(p);
  }
  return saida;
}

function colecao(db: DatabaseSync, nome: string, linhas = 0): void {
  db.exec(`CREATE TABLE "${nome}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL);`);
  db.exec(`CREATE INDEX "ix_${nome}_id" ON "${nome}" (id);`);
  for (let i = 0; i < linhas; i += 1) {
    db.prepare(`INSERT INTO "${nome}" (id, data) VALUES (?, ?)`).run(`r${i}`, '{}');
  }
}

function existe(db: DatabaseSync, nome: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nome));
}

/*
  O código SEM os comentários (GAP-PRD-075). A trava casava o nome da coleção
  em qualquer lugar do fonte, e `logistics_shipments` ficou "em uso" depois de
  perder o último leitor e o último escritor só porque dois comentários a
  citavam entre crases. Comentário que explica por que algo saiu não é uso.
*/
function semComentario(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('TABLE_NAMES só tem coleção que alguém usa', () => {
  it('toda coleção declarada é lida ou escrita fora de db/', () => {
    const fontes = arquivosTs(SRC)
      .filter((f) => !relative(SRC, f).split(/[\\/]/).includes('db'))
      .map((f) => semComentario(readFileSync(f, 'utf8')));
    const semUso = TABLE_NAMES.filter((nome) => {
      const citada = new RegExp(`['"\`]${nome}['"\`]`);
      return !fontes.some((t) => citada.test(t));
    });
    expect(semUso, 'coleção em TABLE_NAMES sem leitor nem escritor: tire-a da lista e ponha em TABELAS_APOSENTADAS').toEqual([]);
  });

  it('a instalação nova cria só elas', () => {
    ensureSchema();
    const doBanco = (getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'core_%' AND name NOT LIKE 'sqlite_%' AND name <> 'db_meta'")
      .all() as { name: string }[]).map((r) => r.name);
    const aposentadasCriadas = doBanco.filter((n) => TABELAS_APOSENTADAS.includes(n));
    expect(aposentadasCriadas).toEqual([]);
  });

  it('nenhuma coleção viva está na lista das aposentadas', () => {
    const vivas = new Set<string>(TABLE_NAMES);
    expect(TABELAS_APOSENTADAS.filter((n) => vivas.has(n))).toEqual([]);
  });

  it('a lista das aposentadas cobre as 81 que a rodada 36 deixou no banco', () => {
    const conta = (prefixo: string) => TABELAS_APOSENTADAS.filter((n) => n.startsWith(prefixo)).length;
    expect(conta('oms_')).toBe(14);
    expect(conta('workshop_')).toBe(21);
    expect(conta('rental_')).toBe(22);
    expect(conta('promotion')).toBe(9);
    // As quinze ecommerce_* da rodada 36, mais as duas desta poda (carts,
    // orders), mais as seis que saíram com `services/ecommerce/` na junção do
    // GAP-PRD-075 (storefronts, product_publications, operational_attempts,
    // themes, content_pages, domain_bindings).
    expect(conta('ecommerce_')).toBe(23);
  });
});

describe('o caminho para o banco que já existe', () => {
  function bancoDeLoja(): DatabaseSync {
    const db = new DatabaseSync(join(pasta, `loja-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
    colecao(db, 'oms_orders');                 // aposentada, vazia
    colecao(db, 'workshop_orders', 1);         // aposentada, COM dado
    colecao(db, 'crm_leads');                  // aposentada nesta poda, vazia
    colecao(db, 'api_sessions', 3);            // viva
    colecao(db, 'colecao_de_versao_nova');     // formato de coleção, fora de qualquer lista
    db.exec('CREATE TABLE core_vendas_de_mentira (id TEXT PRIMARY KEY);');
    return db;
  }

  it('o ensaio só conta: diz o que sairia, o que fica por ter dado, e o que não conhece', () => {
    const db = bancoDeLoja();
    const r = podarTabelasAposentadas(db, { aplicar: false });
    expect(r.ensaio).toBe(true);
    expect(r.removidas).toEqual([]);
    expect(r.aRemover.sort()).toEqual(['crm_leads', 'oms_orders']);
    expect(r.mantidasComDado).toEqual([{ nome: 'workshop_orders', linhas: 1 }]);
    expect(r.desconhecidas).toEqual(['colecao_de_versao_nova']);
    for (const t of ['oms_orders', 'crm_leads', 'workshop_orders']) expect(existe(db, t)).toBe(true);
    db.close();
  });

  it('aplicar apaga só a aposentada VAZIA — e é idempotente', () => {
    const db = bancoDeLoja();
    const r = podarTabelasAposentadas(db, { aplicar: true });
    expect(r.ensaio).toBe(false);
    expect(r.removidas.sort()).toEqual(['crm_leads', 'oms_orders']);
    expect(existe(db, 'oms_orders')).toBe(false);
    expect(existe(db, 'crm_leads')).toBe(false);
    // Com dado, desconhecida, viva e relacional: ficam.
    expect(existe(db, 'workshop_orders')).toBe(true);
    expect(existe(db, 'colecao_de_versao_nova')).toBe(true);
    expect(existe(db, 'api_sessions')).toBe(true);
    expect(existe(db, 'core_vendas_de_mentira')).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM api_sessions').get() as { n: number }).n).toBe(3);

    const deNovo = podarTabelasAposentadas(db, { aplicar: true });
    expect(deNovo.removidas).toEqual([]);
    expect(deNovo.mantidasComDado).toEqual([{ nome: 'workshop_orders', linhas: 1 }]);
    db.close();
  });
});

describe('o comando db:podar-legado', () => {
  function aposentadaNoBancoDoTeste(): void {
    getConnection().exec(
      'CREATE TABLE IF NOT EXISTS "oms_orders" (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL);',
    );
  }

  it('o padrão é o ensaio: sai com 0 e não apaga nada', () => {
    aposentadaNoBancoDoTeste();
    expect(podarPelaLinhaDeComando([])).toBe(0);
    expect(existe(getConnection(), 'oms_orders')).toBe(true);
  });

  it('--aplicar com outro processo dono do banco (a API no ar) recusa e não apaga', () => {
    aposentadaNoBancoDoTeste();
    // Um processo vivo de verdade, na mesma máquina, dono do banco.
    const outro = tentarAssumir('api', { pid: process.ppid, host: hostname(), pidVivo: () => true });
    expect(outro.assumiu).toBe(true);
    try {
      expect(podarPelaLinhaDeComando(['--aplicar'])).toBe(1);
      expect(existe(getConnection(), 'oms_orders')).toBe(true);
    } finally {
      if (outro.assumiu) liberarInstancia(outro.token);
    }
  });

  it('--aplicar com o banco livre apaga a aposentada vazia e solta o banco', () => {
    aposentadaNoBancoDoTeste();
    expect(podarPelaLinhaDeComando(['--aplicar'])).toBe(0);
    expect(existe(getConnection(), 'oms_orders')).toBe(false);
    expect(getConnection().prepare("SELECT 1 FROM core_instancia WHERE papel = 'dono'").get()).toBeUndefined();
  });
});
