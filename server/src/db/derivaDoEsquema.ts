/**
 * ============================================================================
 * A DERIVA DO ESQUEMA — o banco migrado contra um banco NOVO (GAP-PRD-140)
 * ============================================================================
 *
 * "Passo marcado = passo feito" é a promessa das migrações, e o banco da loja
 * a desmentia em cinco pontos que ninguém via: os passos 9 e 39 marcados sem
 * os índices que eles criam (`ix_stock_movements_kind`, `ix_fiscal_docs_order`),
 * `ix_service_orders_status` com a definição antiga (sem `workshop_id` — o
 * `CREATE INDEX IF NOT EXISTS` de mesmo nome não substitui), o DEFAULT
 * 'recebido' em `core_service_orders.status` e a UNIQUE antiga, inline, de
 * `core_finance_categories`. O `reconcileCoreSchema` só acrescenta COLUNA, e
 * o teste de deriva não comparava DEFAULT nem índice.
 *
 * Este módulo responde três perguntas, sempre pelo mesmo gabarito:
 *
 *   1. COMO É UM BANCO NOVO DESTA BUILD? `referenciaDoEsquema` monta um em
 *      memória pelo MESMO caminho do boot — a DDL da camada de documentos, a
 *      DDL canônica do núcleo e os passos de migração (que criam índices que
 *      a DDL canônica não pode ter) — e o descreve. Nada é copiado à mão: a
 *      referência é o que o boot faz.
 *   2. ESTE BANCO É IGUAL? `conferirEsquema` compara colunas (nome, tipo,
 *      NOT NULL, DEFAULT, chave primária, coluna gerada), UNIQUE e CHECK
 *      declarados na tabela, e índices (nome, tabela, colunas, expressão,
 *      único, parcial). O que só existe no banco é listado à parte e não é
 *      divergência — coluna e tabela a mais podem ser de uma build mais nova
 *      ou aposentadas, e apagar em silêncio destruiria dado —, com uma
 *      exceção: índice ÚNICO a mais é regra que recusa gravação, e diverge.
 *   3. DÁ PARA CONSERTAR? `repararEsquema`, fora de transação: acrescenta o
 *      que falta, reconstrói pela DDL canônica a tabela com DEFAULT ou regra
 *      diferente (chaves estrangeiras desligadas, `foreign_key_check` antes e
 *      depois, `integrity_check`, contagem de linhas — e desfaz tudo se
 *      qualquer uma acusar), e cria ou recria os índices. Roda a cada subida,
 *      depois da transação dos passos (passo 85), e pelo comando
 *      `db:conferir-esquema --reparar`. Banco de build MAIS NOVA não é tocado.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { snapshotDatabase } from './backup.js';
import { comoResolverOIndiceUnico } from './consolidacaoDaRemediacao.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from './core-migrations.js';
import { criarColecoesDeDocumentos } from './database.js';
import { STATEMENTS, coreSchemaEmCache, resetCoreSchemaCache } from './schema.js';
import { comConexaoEmprestada, getConnection, inTransaction, resolveDatabasePath } from './sqlite.js';

// ---------------------------------------------------------------- descrição

export interface ColunaDoEsquema {
  nome: string;
  tipo: string;
  notnull: number;
  /** O DEFAULT como o SQLite o guarda (`'em_aberto'`, `0`), ou nulo. */
  padrao: string | null;
  pk: number;
  /** 0 = comum; 2/3 = gerada (VIRTUAL/STORED) — só `table_xinfo` as mostra. */
  oculta: number;
}

export interface TabelaDoEsquema {
  nome: string;
  sql: string;
  colunas: ColunaDoEsquema[];
  /** UNIQUE declarada na própria tabela, pelas colunas: `(a, b)`. */
  unicos: string[];
  /** CHECK declarados na tabela, normalizados. */
  checks: string[];
}

export interface IndiceDoEsquema {
  nome: string;
  tabela: string;
  sql: string;
  unico: boolean;
  parcial: boolean;
  colunas: string[];
  /** Tabela, colunas/expressões e WHERE, sem o nome e sem espaço: o que decide. */
  assinatura: string;
}

export interface DescricaoDoEsquema {
  tabelas: Record<string, TabelaDoEsquema>;
  indices: Record<string, IndiceDoEsquema>;
}

/** Aspas de identificador para PRAGMA e DDL montada aqui. */
function q(nome: string): string {
  return `"${nome.replace(/"/g, '""')}"`;
}

/**
 * Tira comentário, espaço e aspas de identificador, e baixa a caixa — FORA dos
 * literais de texto. `(company_id,status)` e `(company_id, status)` são o
 * mesmo índice; `'Open'` e `'open'` não são a mesma regra.
 */
export function normalizarSql(sql: string): string {
  const texto = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  // O `split` com grupo alterna: índice par = fora de literal, ímpar = o literal
  // '...' inteiro (com '' escapado), que passa intocado.
  return texto
    .split(/('(?:[^']|'')*')/)
    .map((pedaco, i) => (i % 2 === 1 ? pedaco : pedaco.replace(/[\s"`[\]]+/g, '').toLowerCase()))
    .join('');
}

/**
 * Os CHECK declarados numa DDL de tabela. Parêntese aninhado
 * (`CHECK (status IN ('a','b'))`) é lido até o que fecha o de abertura.
 */
export function checksDe(sqlDaTabela: string): string[] {
  const texto = sqlDaTabela.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const achados: string[] = [];
  for (const m of texto.matchAll(/\bCHECK\s*\(/gi)) {
    let profundidade = 1;
    let i = m.index! + m[0].length;
    const inicio = i;
    while (i < texto.length && profundidade > 0) {
      if (texto[i] === '(') profundidade += 1;
      else if (texto[i] === ')') profundidade -= 1;
      i += 1;
    }
    achados.push(texto.slice(inicio, i - 1).trim());
  }
  return achados.sort();
}

interface LinhaDeColuna {
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface LinhaDeIndice {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

function paraColuna(c: LinhaDeColuna): ColunaDoEsquema {
  return {
    nome: c.name,
    tipo: String(c.type ?? '').trim().toUpperCase(),
    notnull: Number(c.notnull),
    padrao: c.dflt_value == null ? null : String(c.dflt_value),
    pk: Number(c.pk),
    oculta: Number(c.hidden ?? 0),
  };
}

function descreverTabela(db: DatabaseSync, nome: string, sql: string): TabelaDoEsquema {
  const colunas = (db.prepare(`PRAGMA table_xinfo(${q(nome)})`).all() as unknown as LinhaDeColuna[])
    .map(paraColuna)
    .sort((a, b) => a.nome.localeCompare(b.nome));

  const unicos: string[] = [];
  for (const ix of db.prepare(`PRAGMA index_list(${q(nome)})`).all() as unknown as LinhaDeIndice[]) {
    if (ix.origin !== 'u') continue;
    const cols = db.prepare(`PRAGMA index_info(${q(ix.name)})`).all() as unknown as { name: string | null }[];
    unicos.push(`(${cols.map((c) => c.name ?? '?').join(', ')})`);
  }

  return { nome, sql, colunas, unicos: unicos.sort(), checks: checksDe(sql).map(normalizarSql).sort() };
}

const PREFIXO_DO_INDICE =
  /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\[[^\]]+\]|`[^`]+`|[A-Za-z0-9_]+)\s+ON\s+/i;

function assinaturaDoIndice(sql: string): string {
  const m = PREFIXO_DO_INDICE.exec(sql);
  const resto = m ? sql.slice(m[0].length) : sql;
  return `${m?.[1] ? 'unique' : 'index'}:${normalizarSql(resto)}`;
}

const TABELAS_DO_CATALOGO = "FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'";

/**
 * A forma inteira de um banco aberto: tabelas e índices explícitos. Só lê.
 *
 * Quatro consultas, e não quatro POR TABELA: as funções de PRAGMA em tabela
 * (`pragma_table_xinfo(m.name)`) varrem o catálogo inteiro de uma vez. Com as
 * ~200 tabelas do banco, um `prepare` por tabela custava ~250 ms — e esta
 * descrição roda a cada subida da API.
 */
export function descreverEsquema(db: DatabaseSync): DescricaoDoEsquema {
  const tabelas: Record<string, TabelaDoEsquema> = {};
  const linhas = db.prepare(`SELECT m.name AS name, m.sql AS sql ${TABELAS_DO_CATALOGO} ORDER BY m.name`).all() as unknown as {
    name: string;
    sql: string | null;
  }[];
  for (const { name, sql } of linhas) {
    tabelas[name] = { nome: name, sql: sql ?? '', colunas: [], unicos: [], checks: checksDe(sql ?? '').map(normalizarSql).sort() };
  }

  const colunas = db
    .prepare(
      `SELECT m.name AS tabela, p.name AS name, p.type AS type, p."notnull" AS "notnull", p.dflt_value AS dflt_value,
              p.pk AS pk, p.hidden AS hidden
         FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    )
    .all() as unknown as (LinhaDeColuna & { tabela: string })[];
  for (const c of colunas) tabelas[c.tabela]?.colunas.push(paraColuna(c));
  for (const t of Object.values(tabelas)) t.colunas.sort((a, b) => a.nome.localeCompare(b.nome));

  const listas = db
    .prepare(
      `SELECT m.name AS tabela, il.name AS name, il."unique" AS "unique", il.origin AS origin, il.partial AS partial
         FROM sqlite_master m JOIN pragma_index_list(m.name) il
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
    )
    .all() as unknown as (LinhaDeIndice & { tabela: string })[];
  const chaves = db
    .prepare(
      `SELECT il.name AS indice, ii.name AS name, ii."key" AS "key"
         FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_xinfo(il.name) ii
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        ORDER BY il.name, ii.seqno`,
    )
    .all() as unknown as { indice: string; name: string | null; key: number }[];
  const colunasDoIndice = new Map<string, string[]>();
  for (const c of chaves) {
    if (Number(c.key) !== 1) continue;
    const lista = colunasDoIndice.get(c.indice) ?? [];
    lista.push(c.name ?? '<expressão>');
    colunasDoIndice.set(c.indice, lista);
  }
  const metaDoIndice = new Map(listas.map((l) => [l.name, l]));
  for (const l of listas) {
    if (l.origin === 'u') tabelas[l.tabela]?.unicos.push(`(${(colunasDoIndice.get(l.name) ?? []).join(', ')})`);
  }
  for (const t of Object.values(tabelas)) t.unicos.sort();

  const indices: Record<string, IndiceDoEsquema> = {};
  const explicitos = db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .all() as unknown as { name: string; tbl_name: string; sql: string }[];
  for (const ix of explicitos) {
    const meta = metaDoIndice.get(ix.name);
    indices[ix.name] = {
      nome: ix.name,
      tabela: ix.tbl_name,
      sql: ix.sql,
      unico: Boolean(meta?.unique),
      parcial: Boolean(meta?.partial),
      colunas: colunasDoIndice.get(ix.name) ?? [],
      assinatura: assinaturaDoIndice(ix.sql),
    };
  }
  return { tabelas, indices };
}

// ---------------------------------------------------------------- a referência

let referenciaEmCache: DescricaoDoEsquema | null = null;

/**
 * O banco NOVO desta build, descrito. Montado uma vez por processo — a DDL não
 * muda com o processo no ar.
 *
 * O caminho é o do boot (`prepararBanco`): coleções de documentos, DDL
 * canônica do núcleo e `migrateCoreSchema` — que num banco vazio roda todos os
 * passos e cria os índices que só existem neles. A conexão da API é trocada
 * pela de memória só durante a montagem (`comConexaoEmprestada`), e a marca de
 * "esquema garantido" do processo volta a ser o que era.
 */
export function referenciaDoEsquema(): DescricaoDoEsquema {
  if (referenciaEmCache) return referenciaEmCache;
  const ref = new DatabaseSync(':memory:');
  ref.exec('PRAGMA foreign_keys = ON;');
  const esquemaJaGarantido = coreSchemaEmCache();
  try {
    comConexaoEmprestada(ref, () => {
      criarColecoesDeDocumentos(ref);
      ref.exec('BEGIN;');
      for (const statement of STATEMENTS) ref.exec(statement);
      ref.exec('COMMIT;');
      migrateCoreSchema({ referencia: true });
    });
    referenciaEmCache = descreverEsquema(ref);
  } finally {
    if (!esquemaJaGarantido) resetCoreSchemaCache();
    ref.close();
  }
  return referenciaEmCache;
}

/** Só para teste: força montar a referência de novo. */
export function esquecerReferenciaDoEsquema(): void {
  referenciaEmCache = null;
}

// ---------------------------------------------------------------- a comparação

export type TipoDeDivergencia =
  | 'tabela_faltando'
  | 'coluna_faltando'
  | 'coluna_diferente'
  | 'unico_diferente'
  | 'check_diferente'
  | 'indice_faltando'
  | 'indice_diferente'
  | 'unico_a_mais';

export type ReparoDaDivergencia =
  | 'criar_tabela'
  | 'acrescentar_coluna'
  | 'reconstruir_tabela'
  | 'criar_indice'
  | 'recriar_indice'
  | 'derrubar_indice'
  | 'manual';

export interface Divergencia {
  tipo: TipoDeDivergencia;
  tabela: string;
  /** A coluna ou o índice; o nome da tabela quando a divergência é dela. */
  objeto: string;
  banco: string | null;
  referencia: string | null;
  reparo: ReparoDaDivergencia;
  descricao: string;
}

export interface ObjetoAMais {
  tipo: 'tabela_a_mais' | 'coluna_a_mais' | 'indice_a_mais';
  tabela: string;
  objeto: string;
}

export interface ConferenciaDoEsquema {
  identico: boolean;
  divergencias: Divergencia[];
  /** Só existe neste banco; não é divergência e nunca é apagado aqui. */
  aMais: ObjetoAMais[];
  tabelasConferidas: number;
  indicesConferidos: number;
  conferidoEm: string;
}

function formaDaColuna(c: ColunaDoEsquema): string {
  return (
    `${c.tipo || '(sem tipo)'}${c.notnull ? ' NOT NULL' : ''}`
    + `${c.padrao != null ? ` DEFAULT ${c.padrao}` : ''}${c.pk ? ' PRIMARY KEY' : ''}${c.oculta ? ' GERADA' : ''}`
  );
}

function diferencasDaColuna(b: ColunaDoEsquema, r: ColunaDoEsquema): string[] {
  const d: string[] = [];
  if (b.tipo !== r.tipo) d.push(`tipo ${b.tipo || '(sem tipo)'} aqui, ${r.tipo || '(sem tipo)'} no banco novo`);
  if (b.notnull !== r.notnull) {
    d.push(b.notnull ? 'NOT NULL aqui e não no banco novo' : 'aceita nulo aqui e é NOT NULL no banco novo');
  }
  const pb = b.padrao == null ? null : normalizarSql(b.padrao);
  const pr = r.padrao == null ? null : normalizarSql(r.padrao);
  if (pb !== pr) d.push(`DEFAULT ${b.padrao ?? '(nenhum)'} aqui, ${r.padrao ?? '(nenhum)'} no banco novo`);
  if (b.pk !== r.pk) d.push('chave primária diferente');
  if (b.oculta !== r.oculta) d.push('coluna gerada num banco e comum no outro');
  return d;
}

/** A tabela do banco contra a da referência: colunas, UNIQUE e CHECK. */
function compararTabela(
  b: TabelaDoEsquema,
  r: TabelaDoEsquema,
): { divergencias: Divergencia[]; aMais: ObjetoAMais[] } {
  const divergencias: Divergencia[] = [];
  const aMais: ObjetoAMais[] = [];
  const doBanco = new Map(b.colunas.map((c) => [c.nome, c]));
  const daRef = new Map(r.colunas.map((c) => [c.nome, c]));

  for (const c of r.colunas) {
    const cb = doBanco.get(c.nome);
    if (!cb) {
      const acrescentavel = c.oculta === 0 && c.pk === 0 && (c.notnull === 0 || c.padrao != null);
      divergencias.push({
        tipo: 'coluna_faltando',
        tabela: r.nome,
        objeto: c.nome,
        banco: null,
        referencia: formaDaColuna(c),
        reparo: acrescentavel ? 'acrescentar_coluna' : 'manual',
        descricao: `${r.nome}.${c.nome}: a coluna falta neste banco (no banco novo: ${formaDaColuna(c)}).`,
      });
      continue;
    }
    const diffs = diferencasDaColuna(cb, c);
    if (diffs.length > 0) {
      divergencias.push({
        tipo: 'coluna_diferente',
        tabela: r.nome,
        objeto: c.nome,
        banco: formaDaColuna(cb),
        referencia: formaDaColuna(c),
        reparo: 'reconstruir_tabela',
        descricao: `${r.nome}.${c.nome}: ${diffs.join('; ')}.`,
      });
    }
  }
  for (const c of b.colunas) {
    if (!daRef.has(c.nome)) aMais.push({ tipo: 'coluna_a_mais', tabela: r.nome, objeto: c.nome });
  }

  if (b.unicos.join('|') !== r.unicos.join('|')) {
    divergencias.push({
      tipo: 'unico_diferente',
      tabela: r.nome,
      objeto: r.nome,
      banco: b.unicos.join('; ') || null,
      referencia: r.unicos.join('; ') || null,
      reparo: 'reconstruir_tabela',
      descricao:
        `${r.nome}: a chave única declarada na tabela difere — aqui ${b.unicos.join('; ') || 'nenhuma'}, `
        + `no banco novo ${r.unicos.join('; ') || 'nenhuma'}.`,
    });
  }
  if (b.checks.join('|') !== r.checks.join('|')) {
    divergencias.push({
      tipo: 'check_diferente',
      tabela: r.nome,
      objeto: r.nome,
      banco: b.checks.join(' ; ') || null,
      referencia: r.checks.join(' ; ') || null,
      reparo: 'reconstruir_tabela',
      descricao: `${r.nome}: as regras CHECK diferem (${b.checks.length} aqui, ${r.checks.length} no banco novo).`,
    });
  }
  return { divergencias, aMais };
}

/** Compara um banco descrito com a referência. Puro: não abre nem grava nada. */
export function compararEsquemas(banco: DescricaoDoEsquema, ref: DescricaoDoEsquema): ConferenciaDoEsquema {
  const divergencias: Divergencia[] = [];
  const aMais: ObjetoAMais[] = [];

  for (const r of Object.values(ref.tabelas)) {
    const b = banco.tabelas[r.nome];
    if (!b) {
      divergencias.push({
        tipo: 'tabela_faltando',
        tabela: r.nome,
        objeto: r.nome,
        banco: null,
        referencia: r.sql,
        reparo: 'criar_tabela',
        descricao: `A tabela ${r.nome} existe no banco novo e falta neste.`,
      });
      continue;
    }
    const t = compararTabela(b, r);
    divergencias.push(...t.divergencias);
    aMais.push(...t.aMais);
  }
  for (const b of Object.values(banco.tabelas)) {
    if (!ref.tabelas[b.nome]) aMais.push({ tipo: 'tabela_a_mais', tabela: b.nome, objeto: b.nome });
  }

  for (const r of Object.values(ref.indices)) {
    const b = banco.indices[r.nome];
    if (!b) {
      if (!banco.tabelas[r.tabela]) continue; // a tabela inteira falta: já está dito
      divergencias.push({
        tipo: 'indice_faltando',
        tabela: r.tabela,
        objeto: r.nome,
        banco: null,
        referencia: r.sql,
        reparo: 'criar_indice',
        descricao: `Índice ${r.nome} (${r.tabela}) falta neste banco.`,
      });
    } else if (b.tabela !== r.tabela || b.assinatura !== r.assinatura) {
      divergencias.push({
        tipo: 'indice_diferente',
        tabela: r.tabela,
        objeto: r.nome,
        banco: b.sql,
        referencia: r.sql,
        reparo: 'recriar_indice',
        descricao:
          `Índice ${r.nome} tem outra definição — aqui ${b.tabela} (${b.colunas.join(', ')}), `
          + `no banco novo ${r.tabela} (${r.colunas.join(', ')}).`,
      });
    }
  }
  for (const b of Object.values(banco.indices)) {
    if (ref.indices[b.nome] || !ref.tabelas[b.tabela]) continue;
    if (b.unico) {
      divergencias.push({
        tipo: 'unico_a_mais',
        tabela: b.tabela,
        objeto: b.nome,
        banco: b.sql,
        referencia: null,
        reparo: 'derrubar_indice',
        descricao: `Índice único ${b.nome} (${b.tabela}) só existe neste banco: recusa gravação que o banco novo aceita.`,
      });
    } else {
      aMais.push({ tipo: 'indice_a_mais', tabela: b.tabela, objeto: b.nome });
    }
  }

  return {
    identico: divergencias.length === 0,
    divergencias,
    aMais,
    tabelasConferidas: Object.keys(ref.tabelas).length,
    indicesConferidos: Object.keys(ref.indices).length,
    conferidoEm: new Date().toISOString(),
  };
}

/** Este banco contra um banco novo desta build. Só lê este banco. */
export function conferirEsquema(db: DatabaseSync): ConferenciaDoEsquema {
  return compararEsquemas(descreverEsquema(db), referenciaDoEsquema());
}

function versaoDoNucleo(db: DatabaseSync): number | null {
  const temMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_meta'").get();
  if (!temMeta) return null;
  const row = db.prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'").get() as
    | { value?: string }
    | undefined;
  const n = Number(row?.value);
  return row?.value != null && Number.isFinite(n) ? n : null;
}

/**
 * Um ARQUIVO de banco contra a referência, aberto só para leitura — o ensaio
 * do comando. Arquivo que não existe não é criado.
 */
export function conferirEsquemaDoArquivo(caminho: string = resolveDatabasePath()): {
  caminho: string;
  existe: boolean;
  versaoDoNucleo: number | null;
  conferencia: ConferenciaDoEsquema | null;
} {
  if (caminho === ':memory:' || !existsSync(caminho)) {
    return { caminho, existe: false, versaoDoNucleo: null, conferencia: null };
  }
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    const descricao = descreverEsquema(db);
    const versao = versaoDoNucleo(db);
    return {
      caminho,
      existe: true,
      versaoDoNucleo: versao,
      conferencia: compararEsquemas(descricao, referenciaDoEsquema()),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- o reparo

const CHAVE_DO_ULTIMO_REPARO = 'esquema:ultimo_reparo';
const PREFIXO_DA_RECUSA = 'esquema:reconstrucao_desfeita:';

/**
 * As divergências numa linha só, para o aviso da subida. Cada descrição termina
 * com ponto, e o aviso põe o dele depois da lista: sem tirar o de cada uma, a
 * frase saía com ponto dobrado ("falta neste banco.. Ver").
 */
export function resumoDasDivergencias(divergencias: { descricao: string }[], maximo = 5): string {
  return divergencias.slice(0, maximo).map((d) => d.descricao.replace(/[.\s]+$/, '')).join(' | ');
}

export interface PendenciaDoReparo {
  objeto: string;
  motivo: string;
}

export interface ResultadoDoReparo {
  /** Falso quando o banco é de uma build mais nova: nada foi conferido nem tocado. */
  aplicavel: boolean;
  motivo: string | null;
  antes: ConferenciaDoEsquema | null;
  depois: ConferenciaDoEsquema | null;
  reparados: string[];
  pendentes: PendenciaDoReparo[];
  /** A cópia do banco tirada antes de reconstruir tabela (nula: nenhuma reconstrução, ou banco descartável). */
  copia: string | null;
}

export interface OpcoesDoReparo {
  /**
   * 'boot': a subida da API. Uma reconstrução que já foi tentada e desfeita,
   * com a mesma divergência, não é tentada de novo a cada subida (nem copia o
   * banco de novo): fica pendente até o comando.
   * 'comando': `db:conferir-esquema --reparar`, com a API parada — tenta tudo.
   */
  modo: 'boot' | 'comando';
  /** A cópia que quem chamou já tirou (o comando): o reparo não tira outra. */
  copiaJaFeita?: { caminho: string | null };
  /** Só para teste: roda depois de copiar as linhas para a tabela nova, antes das conferências. */
  aoCopiarLinhas?: (db: DatabaseSync, tabelaNova: string) => void;
}

function gravarMeta(db: DatabaseSync, chave: string, valor: string): void {
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(chave, valor);
}

function lerMeta(db: DatabaseSync, chave: string): string | null {
  const temMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_meta'").get();
  if (!temMeta) return null;
  const row = db.prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as { value?: string } | undefined;
  return row?.value ?? null;
}

let contadorDeSavepoint = 0;

function emSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  contadorDeSavepoint += 1;
  const sp = `reparo_esquema_${contadorDeSavepoint}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${sp}`);
    return r;
  } catch (err) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw err;
  }
}

function emTransacao(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE;');
  try {
    fn();
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Já desfeita.
    }
    throw err;
  }
}

/** Referências órfãs por (filha → mãe). Compara contagens, e não linhas: o rowid muda na reconstrução. */
function violacoesDeChave(db: DatabaseSync): Map<string, number> {
  const linhas = db.prepare('PRAGMA foreign_key_check').all() as unknown as { table: string; parent: string }[];
  const m = new Map<string, number>();
  for (const l of linhas) {
    const k = `${l.table} → ${l.parent}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** A DDL canônica com outro nome de tabela (a cópia nasce ao lado e troca de nome depois). */
function ddlComOutroNome(sql: string, de: string, para: string): string {
  const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z0-9_]+))/i.exec(
    sql,
  );
  const nome = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
  if (!m || nome !== de) throw new Error(`A DDL canônica de ${de} não começa pelo nome da tabela.`);
  return `CREATE TABLE ${q(para)}${sql.slice(m[0].length)}`;
}

/**
 * Reconstrói UMA tabela pela DDL canônica da referência, preservando as linhas.
 *
 * É o procedimento documentado do SQLite (e o dos passos 8 e 44): chaves
 * estrangeiras desligadas — fora de transação, porque dentro o PRAGMA é
 * ignorado —, tabela nova ao lado, cópia das colunas em comum, troca de nome,
 * índices canônicos da tabela. Antes de confirmar, quatro conferências, e
 * qualquer uma que acuse desfaz TUDO:
 *
 *   - a contagem de linhas é a mesma;
 *   - `foreign_key_check` não acusa referência órfã que não existia antes
 *     (a que já existia não é culpa da reconstrução, e não a impede);
 *   - `integrity_check` responde ok;
 *   - a tabela ficou igual à do banco novo.
 *
 * Lança quando desfaz; quem chama transforma em pendência.
 */
export function reconstruirTabelaPelaReferencia(
  db: DatabaseSync,
  tabela: string,
  ref: DescricaoDoEsquema,
  aoCopiarLinhas?: (db: DatabaseSync, tabelaNova: string) => void,
): { indicesRecusados: string[] } {
  const canonica = ref.tabelas[tabela];
  if (!canonica?.sql) throw new Error(`A tabela ${tabela} não existe no banco novo.`);
  if (inTransaction()) throw new Error('A reconstrução de tabela não roda dentro de transação.');

  const nova = `${tabela}__canonica`;
  const doBanco = new Set(
    (db.prepare(`PRAGMA table_xinfo(${q(tabela)})`).all() as unknown as LinhaDeColuna[])
      .filter((c) => Number(c.hidden ?? 0) === 0)
      .map((c) => c.name),
  );
  const comuns = canonica.colunas.filter((c) => c.oculta === 0 && doBanco.has(c.nome)).map((c) => q(c.nome));
  const contar = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q(tabela)}`).get() as { n: number }).n);
  const antes = contar();
  const orfasAntes = violacoesDeChave(db);
  const temSequencia = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get(),
  );
  const sequenciaAntes = temSequencia
    ? ((db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(tabela) as { seq?: number } | undefined)?.seq
      ?? null)
    : null;
  const indicesRecusados: string[] = [];

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    emTransacao(db, () => {
      db.exec(`DROP TABLE IF EXISTS ${q(nova)}`);
      db.exec(ddlComOutroNome(canonica.sql, tabela, nova));
      db.exec(`INSERT INTO ${q(nova)} (${comuns.join(', ')}) SELECT ${comuns.join(', ')} FROM ${q(tabela)}`);
      aoCopiarLinhas?.(db, nova);
      db.exec(`DROP TABLE ${q(tabela)}`);
      db.exec(`ALTER TABLE ${q(nova)} RENAME TO ${q(tabela)}`);

      for (const ix of Object.values(ref.indices).filter((i) => i.tabela === tabela)) {
        try {
          emSavepoint(db, () => db.exec(ix.sql));
        } catch {
          // Índice único com pré-condição (placa repetida…): a fase dos índices o diz.
          indicesRecusados.push(ix.nome);
        }
      }
      if (sequenciaAntes != null) {
        const r = db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(sequenciaAntes, tabela);
        if (Number(r.changes) === 0) {
          db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(tabela, sequenciaAntes);
        }
      }

      const depois = contar();
      if (depois !== antes) {
        throw new Error(`a reconstrução de ${tabela} perderia linhas: ${antes} antes, ${depois} depois`);
      }
      const orfasDepois = violacoesDeChave(db);
      const novas = [...orfasDepois].filter(([k, n]) => n > (orfasAntes.get(k) ?? 0)).map(([k, n]) => `${k}: ${n}`);
      if (novas.length > 0) {
        throw new Error(`a reconstrução de ${tabela} deixaria referência órfã (${novas.join('; ')})`);
      }
      const integridade = db.prepare('PRAGMA integrity_check').all() as unknown as { integrity_check: string }[];
      if (!(integridade.length === 1 && integridade[0]!.integrity_check === 'ok')) {
        throw new Error(
          `integrity_check acusou depois da reconstrução de ${tabela}: `
            + integridade.slice(0, 3).map((l) => l.integrity_check).join('; '),
        );
      }
      const sqlNovo = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela) as {
        sql: string;
      }).sql;
      const resto = compararTabela(descreverTabela(db, tabela, sqlNovo), canonica).divergencias;
      if (resto.length > 0) {
        throw new Error(`${tabela} continuaria diferente do banco novo: ${resto.map((d) => d.descricao).join(' | ')}`);
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  return { indicesRecusados };
}

function assinaturaDaTabela(tabela: string, c: ConferenciaDoEsquema): string {
  return c.divergencias
    .filter((d) => d.tabela === tabela && d.reparo === 'reconstruir_tabela')
    .map((d) => `${d.tipo}:${d.objeto}:${d.banco ?? ''}`)
    .sort()
    .join('|');
}

/** Por que uma tabela divergente NÃO pode ser reconstruída agora — ou nulo, se pode. */
function recusaDaReconstrucao(
  db: DatabaseSync,
  tabela: string,
  conferencia: ConferenciaDoEsquema,
  ref: DescricaoDoEsquema,
  modo: OpcoesDoReparo['modo'],
): string | null {
  const aMais = conferencia.aMais
    .filter((o) => o.tipo === 'coluna_a_mais' && o.tabela === tabela)
    .map((o) => o.objeto);
  if (aMais.length > 0) {
    return (
      `a tabela tem coluna(s) que o banco novo não tem (${aMais.join(', ')}): reconstruí-la pela DDL canônica `
      + 'apagaria esse dado. Decida o destino da coluna (é de uma build mais nova?) antes de reparar.'
    );
  }
  const obrigatorias = conferencia.divergencias
    .filter((d) => d.tipo === 'coluna_faltando' && d.tabela === tabela && d.reparo === 'manual')
    .map((d) => d.objeto);
  if (obrigatorias.length > 0) {
    return `falta(m) coluna(s) obrigatória(s) sem DEFAULT (${obrigatorias.join(', ')}): não há valor para as linhas que já existem.`;
  }
  if (!ref.tabelas[tabela]?.sql) return 'a tabela não existe no banco novo.';
  if (modo === 'boot') {
    const anterior = lerMeta(db, PREFIXO_DA_RECUSA + tabela);
    if (anterior) {
      try {
        const r = JSON.parse(anterior) as { assinatura?: string; motivo?: string; em?: string };
        if (r.assinatura === assinaturaDaTabela(tabela, conferencia)) {
          return (
            `a reconstrução já foi tentada e desfeita em ${r.em ?? '?'} (${r.motivo ?? 'sem motivo'}). `
            + 'Não é repetida a cada subida: com a API parada, rode npm run db:conferir-esquema -- --reparar.'
          );
        }
      } catch {
        // Registro ilegível: tenta de novo.
      }
    }
  }
  return null;
}

/**
 * Leva o banco à forma do banco novo, no que é seguro fazer sem decisão de
 * ninguém. Fora de transação (a reconstrução desliga as chaves estrangeiras).
 *
 * Ordem: (A) acrescenta tabela e coluna que faltam; (B) reconstrói a tabela
 * com DEFAULT, NOT NULL, UNIQUE ou CHECK diferente — com cópia do banco antes;
 * (C) cria o índice que falta, recria o de mesmo nome com outra definição e
 * derruba o índice único que o banco novo não tem. Cada item isolado: o que
 * falha vira pendência e o resto segue. Nunca apaga coluna, tabela, nem linha.
 */
export function repararEsquema(db: DatabaseSync, opcoes: OpcoesDoReparo): ResultadoDoReparo {
  if (inTransaction()) {
    throw new Error(
      'O reparo do esquema roda fora de transação: a reconstrução desliga as chaves estrangeiras, e o SQLite ignora isso dentro de uma.',
    );
  }
  const versao = versaoDoNucleo(db);
  if (versao != null && versao > CORE_TARGET_VERSION) {
    return {
      aplicavel: false,
      motivo:
        `Núcleo na versão ${versao}, acima do alvo ${CORE_TARGET_VERSION} desta build: o banco é de uma build mais nova, `
        + 'e esta não o conserta para trás.',
      antes: null,
      depois: null,
      reparados: [],
      pendentes: [],
      copia: null,
    };
  }

  const ref = referenciaDoEsquema();
  const antes = compararEsquemas(descreverEsquema(db), ref);
  const r: ResultadoDoReparo = {
    aplicavel: true,
    motivo: null,
    antes,
    depois: antes,
    reparados: [],
    pendentes: [],
    copia: null,
  };
  if (antes.identico) return r;

  // (A) o que só acrescenta
  const leves = antes.divergencias.filter((d) => d.reparo === 'criar_tabela' || d.reparo === 'acrescentar_coluna');
  if (leves.length > 0) {
    emTransacao(db, () => {
      for (const d of leves) {
        try {
          emSavepoint(db, () => {
            if (d.reparo === 'criar_tabela') {
              db.exec(ref.tabelas[d.tabela]!.sql);
            } else {
              const c = ref.tabelas[d.tabela]!.colunas.find((x) => x.nome === d.objeto)!;
              db.exec(
                `ALTER TABLE ${q(d.tabela)} ADD COLUMN ${q(c.nome)} ${c.tipo}`
                  + `${c.notnull ? ' NOT NULL' : ''}${c.padrao != null ? ` DEFAULT ${c.padrao}` : ''}`,
              );
            }
          });
          r.reparados.push(d.descricao);
        } catch (err) {
          r.pendentes.push({ objeto: `${d.tabela}.${d.objeto}`, motivo: (err as Error).message });
        }
      }
    });
  }

  // (B) a tabela que só a DDL canônica conserta
  const intermediaria = leves.length > 0 ? compararEsquemas(descreverEsquema(db), ref) : antes;
  const aReconstruir = [
    ...new Set(intermediaria.divergencias.filter((d) => d.reparo === 'reconstruir_tabela').map((d) => d.tabela)),
  ];
  const prontas: string[] = [];
  for (const t of aReconstruir) {
    const recusa = recusaDaReconstrucao(db, t, intermediaria, ref, opcoes.modo);
    if (recusa) r.pendentes.push({ objeto: t, motivo: `Reconstrução não feita: ${recusa}` });
    else prontas.push(t);
  }
  if (prontas.length > 0) {
    let copiou = true;
    if (opcoes.copiaJaFeita) {
      r.copia = opcoes.copiaJaFeita.caminho;
    } else {
      try {
        const s = snapshotDatabase('pre-reparo-esquema');
        r.copia = s.path || null;
      } catch (err) {
        copiou = false;
        for (const t of prontas) {
          r.pendentes.push({
            objeto: t,
            motivo: `Reconstrução adiada: a cópia do banco falhou (${(err as Error).message}), e sem cópia a tabela não é reconstruída.`,
          });
        }
      }
    }
    if (copiou) {
      for (const t of prontas) {
        const assinatura = assinaturaDaTabela(t, intermediaria);
        try {
          reconstruirTabelaPelaReferencia(db, t, ref, opcoes.aoCopiarLinhas);
          r.reparados.push(`${t}: reconstruída pela DDL canônica, com as linhas preservadas`);
          db.prepare('DELETE FROM core_meta WHERE key = ?').run(PREFIXO_DA_RECUSA + t);
        } catch (err) {
          const motivo = (err as Error).message;
          r.pendentes.push({ objeto: t, motivo: `Reconstrução desfeita: ${motivo}` });
          gravarMeta(db, PREFIXO_DA_RECUSA + t, JSON.stringify({ assinatura, motivo, em: new Date().toISOString() }));
        }
      }
    }
  }

  // (C) índices — a cada subida
  const atual = compararEsquemas(descreverEsquema(db), ref);
  const deIndice = atual.divergencias.filter(
    (d) => d.reparo === 'criar_indice' || d.reparo === 'recriar_indice' || d.reparo === 'derrubar_indice',
  );
  if (deIndice.length > 0) {
    emTransacao(db, () => {
      for (const d of deIndice) {
        try {
          emSavepoint(db, () => {
            if (d.reparo !== 'criar_indice') db.exec(`DROP INDEX IF EXISTS ${q(d.objeto)}`);
            if (d.reparo !== 'derrubar_indice') db.exec(ref.indices[d.objeto]!.sql);
          });
          r.reparados.push(d.descricao);
        } catch (err) {
          const bruto = (err as Error).message;
          // Índice único recusado por linhas repetidas: diz ONDE corrigir, e não o texto
          // cru do SQLite ("UNIQUE constraint failed: ..."), que não diz nada a quem opera.
          const ondeCorrigir = (comoResolverOIndiceUnico(d.objeto) ?? 'Corrija os valores repetidos').replace(/[.\s]+$/, '');
          r.pendentes.push({
            objeto: d.objeto,
            motivo: /UNIQUE constraint failed/i.test(bruto)
              ? `${d.descricao} Não reparado: há linhas repetidas que o índice único recusa. ${ondeCorrigir}. A próxima subida cria o índice.`
              : `${d.descricao} Não reparado: ${bruto}`,
          });
        }
      }
    });
  }

  r.depois = compararEsquemas(descreverEsquema(db), ref);
  registrarReparo(db, r, opcoes.modo);
  return r;
}

function registrarReparo(db: DatabaseSync, r: ResultadoDoReparo, modo: OpcoesDoReparo['modo']): void {
  const em = new Date().toISOString();
  const resumo = {
    em,
    modo,
    divergenciasAntes: r.antes?.divergencias.length ?? 0,
    divergenciasDepois: r.depois?.divergencias.length ?? 0,
    reparados: r.reparados,
    pendentes: r.pendentes,
    copia: r.copia,
  };
  gravarMeta(db, CHAVE_DO_ULTIMO_REPARO, JSON.stringify(resumo));
  if (r.reparados.length > 0) {
    // A trilha diz que o esquema mudou sem ninguém ter pedido na tela.
    db.prepare(
      `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
       VALUES (?, NULL, NULL, 'system.schema.repaired', 'database_schema', NULL, ?, NULL, ?)`,
    ).run(
      `audit-esquema-${randomUUID()}`,
      JSON.stringify({ ...resumo, by: modo === 'boot' ? 'subida-da-api' : 'db:conferir-esquema' }),
      em,
    );
  }
}

// ---------------------------------------------------------------- a situação, para a prontidão e a tela

export type SituacaoDaDeriva = 'IDENTICO' | 'DIVERGE' | 'NAO_SE_APLICA' | 'NAO_CONFERIDO';

export interface UltimoReparoDoEsquema {
  em: string;
  modo: string;
  divergenciasAntes: number;
  divergenciasDepois: number;
  reparados: string[];
  pendentes: PendenciaDoReparo[];
  copia: string | null;
}

export interface DerivaDoEsquema {
  situacao: SituacaoDaDeriva;
  motivo: string | null;
  totalDeDivergencias: number;
  /** As primeiras 30, com o que cada uma é e como se repara. */
  divergencias: Pick<Divergencia, 'tipo' | 'tabela' | 'objeto' | 'descricao' | 'reparo'>[];
  /** Tabela, coluna ou índice comum que só existe neste banco: mantidos. */
  objetosAMais: number;
  tabelasConferidas: number;
  indicesConferidos: number;
  conferidoEm: string;
  ultimoReparo: UltimoReparoDoEsquema | null;
  comoResolver: string | null;
}

export const COMO_REPARAR_O_ESQUEMA =
  'A API repara sozinha, a cada subida, o índice que falta ou mudou e a tabela com DEFAULT ou regra antiga '
  + '(com cópia do banco antes). O que continua aqui precisou de decisão — veja o motivo de cada item. Para '
  + 'conferir: npm run db:conferir-esquema (só lê). Para reparar, com a API parada: '
  + 'npm run db:conferir-esquema -- --reparar (em produção: node server/dist/db/conferirEsquema.js --reparar).';

function lerUltimoReparo(db: DatabaseSync): UltimoReparoDoEsquema | null {
  const v = lerMeta(db, CHAVE_DO_ULTIMO_REPARO);
  if (!v) return null;
  try {
    return JSON.parse(v) as UltimoReparoDoEsquema;
  } catch {
    return null;
  }
}

/** A situação do esquema do banco da API — a prontidão e a tela Sistema leem daqui. */
export function derivaDoBancoEmUso(db: DatabaseSync = getConnection()): DerivaDoEsquema {
  const agora = new Date().toISOString();
  const vazio = {
    totalDeDivergencias: 0,
    divergencias: [],
    objetosAMais: 0,
    tabelasConferidas: 0,
    indicesConferidos: 0,
  };
  try {
    const versao = versaoDoNucleo(db);
    if (versao == null) {
      return {
        situacao: 'NAO_SE_APLICA',
        motivo: 'O núcleo deste banco nunca foi migrado: a conferência contra o banco novo vale depois da migração.',
        ...vazio,
        conferidoEm: agora,
        ultimoReparo: null,
        comoResolver: null,
      };
    }
    if (versao > CORE_TARGET_VERSION) {
      return {
        situacao: 'NAO_SE_APLICA',
        motivo: `O banco é de uma build mais nova (núcleo ${versao}, alvo ${CORE_TARGET_VERSION}): esta build não o confere.`,
        ...vazio,
        conferidoEm: agora,
        ultimoReparo: lerUltimoReparo(db),
        comoResolver: null,
      };
    }
    const c = conferirEsquema(db);
    return {
      situacao: c.identico ? 'IDENTICO' : 'DIVERGE',
      motivo: null,
      totalDeDivergencias: c.divergencias.length,
      divergencias: c.divergencias.slice(0, 30).map(({ tipo, tabela, objeto, descricao, reparo }) => ({
        tipo,
        tabela,
        objeto,
        descricao,
        reparo,
      })),
      objetosAMais: c.aMais.length,
      tabelasConferidas: c.tabelasConferidas,
      indicesConferidos: c.indicesConferidos,
      conferidoEm: c.conferidoEm,
      ultimoReparo: lerUltimoReparo(db),
      comoResolver: c.identico ? null : COMO_REPARAR_O_ESQUEMA,
    };
  } catch (err) {
    return {
      situacao: 'NAO_CONFERIDO',
      motivo: `A conferência do esquema falhou: ${(err as Error).message}`,
      ...vazio,
      conferidoEm: agora,
      ultimoReparo: null,
      comoResolver: null,
    };
  }
}
