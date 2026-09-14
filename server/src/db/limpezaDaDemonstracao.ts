/**
 * ============================================================================
 * A LIMPEZA DA DEMONSTRAÇÃO — o plano exato e a transação que o cumpre
 * ============================================================================
 *
 * O banco da loja nasceu como bancada de demonstração: produtos de exemplo, as
 * treze contas do seed, vendas, caixas abertos, OS, pedido online, nota de
 * entrada de teste, artefatos `ZZ-TESTE`/`ZZ-VERIF` e a maquininha `mock`. Na
 * entrega, isso sai — e a configuração que o dono já fez (fiscal, certificado,
 * séries, grupo tributário, credenciais, caixa de e-mail, empresas, bancadas,
 * categorias de sistema) fica EXATAMENTE como está.
 *
 * Este módulo é a parte que fala SQL. Quem assume o banco, copia antes, move as
 * fotos e escreve o relatório é `services/implantacao/LimpezaDaDemonstracao.ts`.
 *
 * ## O plano é calculado, não suposto
 *
 * Os passos (a ordem que funciona com `foreign_keys = ON`, provada sobre uma
 * réplica do banco real) dizem só as linhas DIRETAS: "todas as vendas", "as
 * categorias ZZ-TESTE", "as treze contas". O resto é o que o SQLite faria — e o
 * plano o calcula lendo, sem apagar nada: para cada instrução, o CASCADE é
 * seguido chave a chave, e toda filha NO ACTION/RESTRICT que ficaria apontando
 * para linha que saiu, ou toda SET NULL que reescreveria linha que fica, vira
 * BLOQUEIO (a aplicação recusa antes de começar, em vez de parar no meio).
 *
 * A saída é o conjunto exato de linhas (rowid) de cada tabela. A IMPRESSÃO
 * DIGITAL é o sha256 das chaves primárias dessas linhas, tabela a tabela, mais
 * as contagens das tabelas de guarda e de dúvida: o dono confere a simulação e
 * aplica COM a impressão — se qualquer linha a sair mudou desde então (uma
 * sessão nova, um movimento no caixa aberto, um produto cadastrado), a
 * impressão muda e a aplicação recusa.
 *
 * ## A transação confere o que fez
 *
 * Dentro de `BEGIN IMMEDIATE`, com `foreign_keys = ON`: o plano é refeito (a
 * impressão tem de bater de novo), cada tabela é fotografada (a contagem e o
 * sha256 de TODA linha que deve ficar), as instruções rodam na ordem do plano,
 * e a foto é tirada de novo. Cada tabela tem de ter perdido exatamente as
 * linhas do plano, e cada linha que ficou tem de estar byte a byte igual. Uma
 * divergência qualquer — um gatilho, uma chave que o plano não previu — é
 * ROLLBACK: nada muda.
 *
 * ## O que NUNCA sai
 *
 * O cofre de chaves (`integration_secrets`), o estado das integrações, o rastro
 * da homologação do Asaas, o certificado, a configuração fiscal, as séries, o
 * grupo tributário, a caixa IMAP, as empresas, as bancadas, `core_meta` e a
 * auditoria. Se um passo ou um CASCADE alcançasse qualquer uma delas, o plano
 * bloqueia. Nenhuma flag muda isso.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const ACAO_DA_LIMPEZA = 'implantacao.limpeza_demonstracao';

/** As treze contas que o seed de demonstração cria (logins exatos). */
export const LOGINS_DA_DEMONSTRACAO: readonly string[] = [
  'ADMIN',
  'CARLOSGERENTE',
  'preco-justo.pdv',
  'gringa.pdv',
  'me-mimei.pdv',
  'conceito.pdv',
  'pj-motors.pdv',
  'oficina.pdv',
  'ROBERTOMECANICO',
  'MARCOSMECANICO',
  'PAULOMECANICO',
  'LUCASMECANICO',
  'JOAOCELULAR',
];

/** A numeração das entidades que somem inteiras: recomeça do 1. */
export const SEQUENCIAS_DAS_ENTIDADES: readonly string[] = [
  'sale',
  'product_code',
  'ecommerce_order',
  'quote_orcamento',
  'quote_pre_venda',
  'service_order',
  'inventory_count',
];

/**
 * Código de barras e plaquinha: só com a flag. Etiqueta impressa com esses
 * números pode estar colada em mercadoria ou máquina.
 */
export const SEQUENCIAS_DE_ETIQUETA: readonly string[] = ['barcode', 'equipment_public_id'];

/** Tabelas que a limpeza nunca tira linha — nem por passo, nem por CASCADE, nem por flag. */
export const NUNCA_SAEM: readonly string[] = [
  'integration_secrets',
  'integration_configurations',
  'integration_audit_entries',
  'asaas_charge_links',
  'asaas_customer_links',
  'asaas_operational_attempts',
  'asaas_sandbox_homologations',
  'asaas_webhook_events',
  'core_payment_webhooks',
  'fiscal_certificate_references',
  'nfce_settings',
  'core_fiscal_configs',
  'core_fiscal_series',
  'core_tax_groups',
  'core_mail_inboxes',
  'core_companies',
  'core_workshops',
  'core_meta',
  'db_meta',
  'core_outbox',
  'core_audit_log',
];

/** A configuração cujo conteúdo o relatório confere, uma a uma, antes e depois. */
export const CONFIGURACAO_CONFERIDA: readonly string[] = [
  'core_companies',
  'core_fiscal_configs',
  'fiscal_certificate_references',
  'core_fiscal_series',
  'core_tax_groups',
  'nfce_settings',
  'integration_configurations',
  'integration_secrets',
  'core_mail_inboxes',
  'core_workshops',
];

/** A trava de instância (GAP-PRD-137) é escrita por quem limpa: fica fora da foto. */
const FORA_DA_FOTO = new Set(['core_instancia']);

export interface OpcoesDaLimpeza {
  incluirClientes?: boolean;
  incluirFornecedor?: boolean;
  reiniciarSequenciasDeEtiqueta?: boolean;
}

type Selecao = { onde: string } | { citadosPeloQueSai: true };

interface DefinicaoDoPasso {
  ordem: number;
  tabela: string;
  motivo: string;
  /** As instruções do passo, na ordem. */
  selecoes: (o: OpcoesDaLimpeza) => Selecao[];
  /** Critério que deixa linhas na tabela: um CASCADE dentro dela não pode levar linha fora do critério. */
  filtrado?: boolean;
  /** Passo de dúvida: só roda com a flag. */
  duvida?: keyof OpcoesDaLimpeza;
}

const aspas = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const lista = (xs: readonly string[]): string => xs.map(aspas).join(', ');
const q = (ident: string): string => (ident === 'rowid' ? 'rowid' : `"${ident.replace(/"/g, '""')}"`);
const TODAS = (): Selecao[] => [{ onde: '1 = 1' }];

export const PASSOS: readonly DefinicaoDoPasso[] = [
  { ordem: 1, tabela: 'core_email_queue', selecoes: TODAS, motivo: 'fila de e-mail da demonstração (sai antes de qualquer transporte)' },
  {
    ordem: 2,
    tabela: 'core_print_jobs',
    selecoes: () => [{ onde: 'reprint_of IS NOT NULL' }, { onde: '1 = 1' }],
    motivo: 'cupons da demonstração na fila de impressão (a reimpressão sai antes do original)',
  },
  { ordem: 3, tabela: 'core_payment_intents', selecoes: TODAS, motivo: 'cobranças PIX de teste dos pedidos de demonstração' },
  { ordem: 4, tabela: 'core_commission_closings', selecoes: TODAS, motivo: 'fechamento de comissão da demonstração' },
  { ordem: 5, tabela: 'core_commission_groups', filtrado: true, selecoes: () => [{ onde: "name LIKE 'ZZ-TESTE%'" }], motivo: 'grupo de comissão de teste (ZZ-TESTE)' },
  { ordem: 6, tabela: 'core_finance_entries', selecoes: TODAS, motivo: 'lançamentos das vendas, do pedido e da comissão de demonstração' },
  { ordem: 7, tabela: 'core_acquirers', filtrado: true, selecoes: () => [{ onde: "name LIKE 'ZZ-TESTE%'" }], motivo: 'adquirente de teste (ZZ-TESTE)' },
  { ordem: 8, tabela: 'core_finance_accounts', filtrado: true, selecoes: () => [{ onde: "name LIKE 'ZZ-TESTE%'" }], motivo: 'conta de teste (ZZ-TESTE)' },
  {
    ordem: 9,
    tabela: 'core_finance_categories',
    filtrado: true,
    selecoes: () => [{ onde: "name LIKE 'ZZ-TESTE%'" }],
    motivo: 'categorias de teste (ZZ-TESTE); as de sistema ficam',
  },
  { ordem: 10, tabela: 'core_orders', selecoes: TODAS, motivo: 'pedidos online de demonstração' },
  { ordem: 11, tabela: 'core_quotes', selecoes: TODAS, motivo: 'orçamentos e pré-vendas de demonstração' },
  { ordem: 12, tabela: 'core_service_orders', selecoes: TODAS, motivo: 'ordens de serviço de demonstração' },
  { ordem: 13, tabela: 'core_equipment_tags', selecoes: TODAS, motivo: 'plaquinha do equipamento de demonstração' },
  { ordem: 14, tabela: 'core_equipment', selecoes: TODAS, motivo: 'equipamento de demonstração' },
  { ordem: 15, tabela: 'core_inventory_counts', selecoes: TODAS, motivo: 'inventário de demonstração' },
  { ordem: 16, tabela: 'core_inbound_notes', selecoes: TODAS, motivo: 'nota de entrada de teste' },
  { ordem: 17, tabela: 'core_sales', selecoes: TODAS, motivo: 'vendas de demonstração' },
  { ordem: 18, tabela: 'core_cash_sessions', selecoes: TODAS, motivo: 'caixas da demonstração, inclusive os abertos' },
  { ordem: 19, tabela: 'core_products', selecoes: TODAS, motivo: 'produtos de demonstração, com variantes, saldo, razão, promoções e fotos (num comando só)' },
  {
    ordem: 20,
    tabela: 'core_stock_locations',
    filtrado: true,
    selecoes: () => [{ onde: "code = 'ZZ-VERIF'" }],
    motivo: 'local de estoque de teste (ZZ-VERIF); os locais gerais ficam',
  },
  {
    ordem: 21,
    tabela: 'core_users',
    filtrado: true,
    // BINARY: o `admin` que o bootstrap cria depois NÃO é o `ADMIN` do seed.
    selecoes: () => [{ onde: `login COLLATE BINARY IN (${lista(LOGINS_DA_DEMONSTRACAO)})` }],
    motivo: 'as treze contas da demonstração (seed), com vínculos e bancadas',
  },
  { ordem: 22, tabela: 'api_sessions', selecoes: TODAS, motivo: 'todas as sessões: ninguém continua logado' },
  { ordem: 23, tabela: 'core_login_attempts', selecoes: TODAS, motivo: 'tentativas de login da demonstração' },
  {
    ordem: 24,
    tabela: 'payment_terminal_transactions',
    filtrado: true,
    selecoes: () => [
      {
        onde:
          "json_extract(data, '$.provider') = 'mock' AND json_extract(data, '$.simulated') = 1 "
          + "AND json_extract(data, '$.real') = 0",
      },
    ],
    motivo: 'cobranças simuladas da maquininha de teste',
  },
  {
    ordem: 25,
    tabela: 'payment_terminal_configurations',
    filtrado: true,
    selecoes: () => [{ onde: "json_extract(data, '$.provider') = 'mock'" }],
    motivo: 'a maquininha de teste (mock)',
  },
  {
    ordem: 26,
    tabela: 'core_sequences',
    filtrado: true,
    selecoes: (o) => [
      {
        onde: `name IN (${lista([
          ...SEQUENCIAS_DAS_ENTIDADES,
          ...(o.reiniciarSequenciasDeEtiqueta ? SEQUENCIAS_DE_ETIQUETA : []),
        ])})`,
      },
    ],
    motivo: 'numeração das entidades que sumiram inteiras: recomeça do 1',
  },
  {
    ordem: 28,
    tabela: 'core_customers',
    duvida: 'incluirClientes',
    selecoes: () => [{ citadosPeloQueSai: true }],
    motivo: 'clientes citados pelos documentos de demonstração que saem',
  },
  {
    ordem: 29,
    tabela: 'core_suppliers',
    duvida: 'incluirFornecedor',
    selecoes: () => [{ citadosPeloQueSai: true }],
    motivo: 'fornecedor citado só pela nota de teste e seus lançamentos',
  },
];

/** Onde moram os arquivos que as linhas citam — e que o CASCADE não apaga do disco. */
const ARQUIVOS: ReadonlyArray<{ tabela: string; coluna: string; pasta: PastaDeArquivo }> = [
  { tabela: 'core_product_images', coluna: 'url', pasta: 'produtos' },
  { tabela: 'core_products', coluna: 'image_url', pasta: 'produtos' },
  { tabela: 'core_service_order_photos', coluna: 'url', pasta: 'os' },
  { tabela: 'core_equipment_photos', coluna: 'url', pasta: 'equipamentos' },
];

export type PastaDeArquivo = 'produtos' | 'os' | 'equipamentos';

// ---------------------------------------------------------------------------
// O plano
// ---------------------------------------------------------------------------

export interface Instrucao {
  ordem: number;
  tabela: string;
  rowids: number[];
}

export interface PassoDoPlano {
  ordem: number;
  tabela: string;
  motivo: string;
  situacao: 'aplica' | 'ausente' | 'duvida_fica';
  /** Linhas escolhidas pelo critério do passo. */
  diretas: number;
  /** O que o passo tira de cada tabela, contando o CASCADE. */
  efeitos: Record<string, number>;
}

export interface LinhaDaTabela {
  tabela: string;
  antes: number;
  saem: number;
  diretas: number;
  emCascata: number;
  /** De quais tabelas veio o CASCADE. */
  cascataDe: string[];
}

export interface Plano {
  versaoDoNucleo: string | null;
  jaAplicadaEm: string | null;
  opcoes: Required<OpcoesDaLimpeza>;
  passos: PassoDoPlano[];
  execucao: Instrucao[];
  /** O conjunto exato de linhas (rowid) que sai de cada tabela. */
  saem: Map<string, Set<number>>;
  porTabela: LinhaDaTabela[];
  totalQueSai: number;
  produtos: Array<{ nome: string; codigo: string | null }>;
  usuarios: Array<{ login: string; nome: string }>;
  duvidas: {
    clientes: { citados: number; incluidos: boolean; porEmpresa: Array<{ empresa: string; criadoEm: string }> };
    fornecedores: { citados: number; incluidos: boolean; porEmpresa: Array<{ empresa: string; criadoEm: string }> };
    sequenciasDeEtiqueta: { linhas: Array<{ nome: string; empresa: string; atual: number }>; reiniciadas: boolean };
  };
  preservadas: Array<{ tabela: string; linhas: number }>;
  arquivos: Array<{ pasta: PastaDeArquivo; nome: string }>;
  documentosFiscaisDeProducao: number;
  bloqueios: string[];
  impressao: string;
}

interface ChaveEstrangeira {
  filho: string;
  pai: string;
  de: string[];
  para: string[];
  aoApagar: string;
}

function tabelasDoBanco(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function colunas(db: DatabaseSync, tabela: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA table_info(${q(tabela)})`).all() as Array<{ name: string; pk: number }>;
}

function colunasDaChave(db: DatabaseSync, tabela: string): string[] {
  return colunas(db, tabela)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

function chavesPorPai(db: DatabaseSync, tabelas: Set<string>): Map<string, ChaveEstrangeira[]> {
  const porPai = new Map<string, ChaveEstrangeira[]>();
  for (const filho of tabelas) {
    const linhas = db.prepare(`PRAGMA foreign_key_list(${q(filho)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>;
    const porId = new Map<number, typeof linhas>();
    for (const l of linhas) porId.set(l.id, [...(porId.get(l.id) ?? []), l]);
    for (const grupo of porId.values()) {
      grupo.sort((a, b) => a.seq - b.seq);
      const pai = grupo[0].table;
      if (!tabelas.has(pai)) continue; // chave para tabela que não existe neste banco: nada a seguir
      let para = grupo.map((l) => l.to);
      if (para.some((p) => !p)) {
        const pk = colunasDaChave(db, pai);
        para = pk.length === grupo.length ? pk : grupo.map(() => 'rowid');
      }
      const fk: ChaveEstrangeira = {
        filho,
        pai,
        de: grupo.map((l) => l.from),
        para: para as string[],
        aoApagar: (grupo[0].on_delete || 'NO ACTION').toUpperCase(),
      };
      porPai.set(pai, [...(porPai.get(pai) ?? []), fk]);
    }
  }
  return porPai;
}

const json = (ids: Iterable<number>): string => JSON.stringify([...ids]);

/** Linhas do filho que apontam, por esta chave, para as linhas `idsDoPai`. */
function filhosQueApontam(db: DatabaseSync, fk: ChaveEstrangeira, idsDoPai: number[]): number[] {
  if (idsDoPai.length === 0) return [];
  const cond = fk.de.map((c, i) => `f.${q(c)} = p.${q(fk.para[i])}`).join(' AND ');
  return (
    db
      .prepare(
        `SELECT DISTINCT f.rowid AS r FROM ${q(fk.filho)} f JOIN ${q(fk.pai)} p ON ${cond}
          WHERE p.rowid IN (SELECT value FROM json_each(?)) ORDER BY f.rowid`,
      )
      .all(json(idsDoPai)) as { r: number }[]
  ).map((l) => Number(l.r));
}

/** Linhas do pai citadas, por esta chave, pelas linhas `idsDoFilho`. */
function paisCitados(db: DatabaseSync, fk: ChaveEstrangeira, idsDoFilho: number[]): number[] {
  if (idsDoFilho.length === 0) return [];
  const cond = fk.de.map((c, i) => `f.${q(c)} = p.${q(fk.para[i])}`).join(' AND ');
  return (
    db
      .prepare(
        `SELECT DISTINCT p.rowid AS r FROM ${q(fk.pai)} p JOIN ${q(fk.filho)} f ON ${cond}
          WHERE f.rowid IN (SELECT value FROM json_each(?)) ORDER BY p.rowid`,
      )
      .all(json(idsDoFilho)) as { r: number }[]
  ).map((l) => Number(l.r));
}

function contar(db: DatabaseSync, tabela: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${q(tabela)}`).get() as { n: number }).n);
}

function umValor<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T | null {
  try {
    const l = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return l ? (Object.values(l)[0] as T) : null;
  } catch {
    return null;
  }
}

interface Contexto {
  db: DatabaseSync;
  tabelas: Set<string>;
  filhos: Map<string, ChaveEstrangeira[]>;
  saem: Map<string, Set<number>>;
  origem: Map<string, { diretas: number; emCascata: number; de: Set<string> }>;
  bloqueios: string[];
}

function anotar(ctx: Contexto, tabela: string, n: number, direta: boolean, de?: string): void {
  const o = ctx.origem.get(tabela) ?? { diretas: 0, emCascata: 0, de: new Set<string>() };
  if (direta) o.diretas += n;
  else {
    o.emCascata += n;
    if (de) o.de.add(de);
  }
  ctx.origem.set(tabela, o);
}

/** Marca as linhas diretas e segue o CASCADE. Devolve tudo o que esta instrução tira. */
function propagar(ctx: Contexto, tabela: string, diretas: number[]): Map<string, number[]> {
  const novas = new Map<string, number[]>();
  const fila: Array<[string, number[]]> = [];
  const marcar = (t: string, rs: number[], de?: string): void => {
    const s = ctx.saem.get(t) ?? new Set<number>();
    const n = rs.filter((r) => !s.has(r));
    if (n.length === 0) return;
    for (const r of n) s.add(r);
    ctx.saem.set(t, s);
    novas.set(t, [...(novas.get(t) ?? []), ...n]);
    anotar(ctx, t, n.length, de === undefined, de);
    fila.push([t, n]);
  };
  marcar(tabela, diretas);
  while (fila.length > 0) {
    const [t, rs] = fila.shift()!;
    for (const fk of ctx.filhos.get(t) ?? []) {
      if (fk.aoApagar !== 'CASCADE') continue;
      marcar(fk.filho, filhosQueApontam(ctx.db, fk, rs), t);
    }
  }
  return novas;
}

/**
 * O que o SQLite recusaria (ou reescreveria) ao fim desta instrução: filha
 * NO ACTION que continua apontando para linha que saiu, RESTRICT alcançada, e
 * SET NULL/SET DEFAULT sobre linha que fica.
 */
function conferirVizinhas(ctx: Contexto, ordem: number, tabelaDoPasso: string, novas: Map<string, number[]>): void {
  for (const [t, rs] of novas) {
    for (const fk of ctx.filhos.get(t) ?? []) {
      if (fk.aoApagar === 'CASCADE') continue;
      const refs = filhosQueApontam(ctx.db, fk, rs);
      const saemDoFilho = ctx.saem.get(fk.filho) ?? new Set<number>();
      const nestaInstrucao = new Set(novas.get(fk.filho) ?? []);
      const sobram = fk.aoApagar === 'RESTRICT'
        ? refs.filter((r) => !saemDoFilho.has(r) || nestaInstrucao.has(r))
        : refs.filter((r) => !saemDoFilho.has(r));
      if (sobram.length === 0) continue;
      const efeito = fk.aoApagar === 'SET NULL' || fk.aoApagar === 'SET DEFAULT'
        ? 'reescreveria linha que fica'
        : 'o banco recusaria (FOREIGN KEY)';
      ctx.bloqueios.push(
        `passo ${ordem} (${tabelaDoPasso}): ${sobram.length} linha(s) de ${fk.filho} apontam `
          + `(${fk.de.join(', ')}, ON DELETE ${fk.aoApagar}) para ${t}, que sai — ${efeito}.`,
      );
    }
  }
}

function citadosPeloQueSai(ctx: Contexto, tabela: string): number[] {
  const achados = new Set<number>();
  for (const fk of ctx.filhos.get(tabela) ?? []) {
    const doFilho = ctx.saem.get(fk.filho);
    if (!doFilho || doFilho.size === 0) continue;
    for (const r of paisCitados(ctx.db, fk, [...doFilho])) achados.add(r);
  }
  const ja = ctx.saem.get(tabela) ?? new Set<number>();
  return [...achados].filter((r) => !ja.has(r)).sort((a, b) => a - b);
}

function identidades(db: DatabaseSync, tabela: string, rowids: Set<number>): string[] {
  const pk = colunasDaChave(db, tabela);
  const sel = pk.length > 0 ? pk.map(q).join(', ') : 'rowid';
  return (
    db.prepare(`SELECT ${sel} FROM ${q(tabela)} WHERE rowid IN (SELECT value FROM json_each(?))`).all(json(rowids)) as Array<
      Record<string, unknown>
    >
  )
    .map((l) => JSON.stringify(Object.values(l)))
    .sort();
}

function empresaDe(db: DatabaseSync, companyId: unknown): string {
  if (typeof companyId !== 'string') return '—';
  return umValor<string>(db, 'SELECT slug FROM core_companies WHERE id = ?', companyId) ?? '—';
}

function nomeDoArquivo(valor: unknown): string | null {
  if (typeof valor !== 'string' || !valor.trim() || /^[a-z]+:\/\//i.test(valor)) return null;
  const nome = valor.split(/[\\/]/).pop() ?? '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nome) ? nome : null;
}

function arquivosQueSaem(ctx: Contexto): Array<{ pasta: PastaDeArquivo; nome: string }> {
  const saem = new Map<string, { pasta: PastaDeArquivo; nome: string }>();
  const ficam = new Set<string>();
  for (const a of ARQUIVOS) {
    if (!ctx.tabelas.has(a.tabela) || !colunas(ctx.db, a.tabela).some((c) => c.name === a.coluna)) continue;
    const sai = ctx.saem.get(a.tabela) ?? new Set<number>();
    for (const l of ctx.db.prepare(`SELECT rowid AS r, ${q(a.coluna)} AS v FROM ${q(a.tabela)}`).all() as Array<{
      r: number;
      v: unknown;
    }>) {
      const nome = nomeDoArquivo(l.v);
      if (!nome) continue;
      const chave = `${a.pasta}/${nome}`;
      if (sai.has(Number(l.r))) saem.set(chave, { pasta: a.pasta, nome });
      else ficam.add(chave);
    }
  }
  // Arquivo que uma linha que FICA ainda cita não vai para a quarentena.
  return [...saem.entries()]
    .filter(([chave]) => !ficam.has(chave))
    .map(([, v]) => v)
    .sort((a, b) => `${a.pasta}/${a.nome}`.localeCompare(`${b.pasta}/${b.nome}`));
}

/** Documento fiscal de PRODUÇÃO em qualquer estado: nota de verdade, que a limpeza não toca. */
function documentosFiscaisDeProducao(db: DatabaseSync, tabelas: Set<string>): number {
  let n = 0;
  if (tabelas.has('core_fiscal_documents')) {
    n += umValor<number>(db, "SELECT COUNT(*) FROM core_fiscal_documents WHERE lower(environment) IN ('production', 'producao', 'produção', '1')") ?? 0;
  }
  // As coleções do fiscal antigo (aposentadas; existem em banco de versão anterior).
  for (const t of ['fiscal_documents', 'nfe_documents', 'nfce_documents']) {
    if (!tabelas.has(t)) continue;
    n += umValor<number>(
      db,
      `SELECT COUNT(*) FROM ${q(t)}
        WHERE lower(COALESCE(json_extract(data, '$.environment'), json_extract(data, '$.ambiente'), ''))
              IN ('production', 'producao', 'produção')
           OR json_extract(data, '$.tpAmb') IN (1, '1')`,
    ) ?? 0;
  }
  return n;
}

function normalizarOpcoes(o: OpcoesDaLimpeza): Required<OpcoesDaLimpeza> {
  return {
    incluirClientes: Boolean(o.incluirClientes),
    incluirFornecedor: Boolean(o.incluirFornecedor),
    reiniciarSequenciasDeEtiqueta: Boolean(o.reiniciarSequenciasDeEtiqueta),
  };
}

/**
 * O plano exato, só lendo. Serve à simulação (conexão só-leitura) e à
 * aplicação (dentro da transação, antes de apagar).
 */
export function planejarLimpeza(db: DatabaseSync, entrada: OpcoesDaLimpeza = {}): Plano {
  const opcoes = normalizarOpcoes(entrada);
  const tabelas = new Set(tabelasDoBanco(db));
  const ctx: Contexto = {
    db,
    tabelas,
    filhos: chavesPorPai(db, tabelas),
    saem: new Map(),
    origem: new Map(),
    bloqueios: [],
  };

  const jaAplicadaEm = tabelas.has('core_audit_log')
    ? umValor<string>(db, 'SELECT created_at FROM core_audit_log WHERE action = ? ORDER BY created_at DESC LIMIT 1', ACAO_DA_LIMPEZA)
    : null;
  const versaoDoNucleo = tabelas.has('core_meta')
    ? umValor<string>(db, "SELECT value FROM core_meta WHERE key = 'core_schema_version'")
    : null;

  const antes = new Map<string, number>();
  for (const t of tabelas) antes.set(t, contar(db, t));

  const passos: PassoDoPlano[] = [];
  const execucao: Instrucao[] = [];
  for (const def of PASSOS) {
    const passo: PassoDoPlano = { ordem: def.ordem, tabela: def.tabela, motivo: def.motivo, situacao: 'aplica', diretas: 0, efeitos: {} };
    passos.push(passo);
    if (def.duvida && !opcoes[def.duvida]) {
      passo.situacao = 'duvida_fica';
      continue;
    }
    if (!tabelas.has(def.tabela)) {
      passo.situacao = 'ausente';
      continue;
    }
    for (const sel of def.selecoes(opcoes)) {
      let diretas: number[];
      try {
        if ('onde' in sel) {
          const ja = ctx.saem.get(def.tabela) ?? new Set<number>();
          diretas = (
            db.prepare(`SELECT rowid AS r FROM ${q(def.tabela)} WHERE ${sel.onde} ORDER BY rowid`).all() as { r: number }[]
          )
            .map((l) => Number(l.r))
            .filter((r) => !ja.has(r));
        } else {
          diretas = citadosPeloQueSai(ctx, def.tabela);
        }
      } catch (err) {
        ctx.bloqueios.push(`passo ${def.ordem} (${def.tabela}): o critério não roda neste banco — ${(err as Error).message}`);
        continue;
      }
      if (diretas.length === 0) continue;
      const novas = propagar(ctx, def.tabela, diretas);
      passo.diretas += diretas.length;
      for (const [t, rs] of novas) passo.efeitos[t] = (passo.efeitos[t] ?? 0) + rs.length;
      conferirVizinhas(ctx, def.ordem, def.tabela, novas);
      if (def.filtrado && 'onde' in sel) {
        const extras = (novas.get(def.tabela) ?? []).filter((r) => !diretas.includes(r));
        if (extras.length > 0) {
          const fora = umValor<number>(
            db,
            `SELECT COUNT(*) FROM ${q(def.tabela)} WHERE rowid IN (SELECT value FROM json_each(?)) AND NOT (${sel.onde})`,
            json(extras),
          ) ?? 0;
          if (fora > 0) {
            ctx.bloqueios.push(
              `passo ${def.ordem} (${def.tabela}): o CASCADE levaria ${fora} linha(s) fora do critério `
                + `(${sel.onde}) — uma linha real pendurada numa de teste.`,
            );
          }
        }
      }
      execucao.push({ ordem: def.ordem, tabela: def.tabela, rowids: diretas });
    }
  }

  for (const t of NUNCA_SAEM) {
    const n = ctx.saem.get(t)?.size ?? 0;
    if (n > 0) ctx.bloqueios.push(`${t} perderia ${n} linha(s): esta tabela nunca sai.`);
  }

  const fiscaisDeProducao = documentosFiscaisDeProducao(db, tabelas);
  if (fiscaisDeProducao > 0) {
    ctx.bloqueios.push(
      `${fiscaisDeProducao} documento(s) fiscal(is) de PRODUÇÃO: este banco já emitiu nota de verdade, `
        + 'e a limpeza da demonstração não roda sobre ele.',
    );
  }

  const porTabela: LinhaDaTabela[] = [];
  const primeiraOrdem = new Map<string, number>();
  for (const p of passos) for (const t of Object.keys(p.efeitos)) if (!primeiraOrdem.has(t)) primeiraOrdem.set(t, p.ordem);
  for (const [t, s] of ctx.saem) {
    if (s.size === 0) continue;
    const o = ctx.origem.get(t)!;
    porTabela.push({ tabela: t, antes: antes.get(t) ?? 0, saem: s.size, diretas: o.diretas, emCascata: o.emCascata, cascataDe: [...o.de].sort() });
  }
  porTabela.sort((a, b) => (primeiraOrdem.get(a.tabela) ?? 99) - (primeiraOrdem.get(b.tabela) ?? 99) || a.tabela.localeCompare(b.tabela));
  const totalQueSai = porTabela.reduce((s, l) => s + l.saem, 0);

  const produtos = (() => {
    const s = ctx.saem.get('core_products');
    if (!s?.size) return [];
    const temCodigo = colunas(db, 'core_products').some((c) => c.name === 'internal_code');
    return (
      db
        .prepare(`SELECT name, ${temCodigo ? 'internal_code' : 'NULL'} AS codigo FROM core_products WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY name, rowid`)
        .all(json(s)) as Array<{ name: string; codigo: string | null }>
    ).map((l) => ({ nome: String(l.name), codigo: l.codigo === null ? null : String(l.codigo) }));
  })();
  const usuarios = (() => {
    const s = ctx.saem.get('core_users');
    if (!s?.size) return [];
    return (
      db.prepare('SELECT login, display_name FROM core_users WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY login').all(json(s)) as Array<{
        login: string;
        display_name: string;
      }>
    ).map((l) => ({ login: String(l.login), nome: String(l.display_name) }));
  })();

  const candidatos = (tabela: string, incluidos: boolean) => {
    if (!tabelas.has(tabela)) return { citados: 0, incluidos, porEmpresa: [] };
    const ids = incluidos ? [...(ctx.saem.get(tabela) ?? [])] : citadosPeloQueSai(ctx, tabela);
    const linhas = ids.length
      ? (db.prepare(`SELECT company_id, created_at FROM ${q(tabela)} WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY created_at`).all(json(ids)) as Array<{
          company_id: unknown;
          created_at: unknown;
        }>)
      : [];
    return {
      citados: ids.length,
      incluidos,
      porEmpresa: linhas.map((l) => ({ empresa: empresaDe(db, l.company_id), criadoEm: String(l.created_at ?? '') })),
    };
  };

  const sequenciasDeEtiqueta = tabelas.has('core_sequences')
    ? (db
        .prepare(`SELECT company_id, name, current FROM core_sequences WHERE name IN (${lista(SEQUENCIAS_DE_ETIQUETA)}) ORDER BY name, company_id`)
        .all() as Array<{ company_id: string; name: string; current: number }>).map((l) => ({
        nome: l.name,
        empresa: empresaDe(db, l.company_id),
        atual: Number(l.current),
      }))
    : [];

  const preservadas: Array<{ tabela: string; linhas: number }> = [];
  for (const t of [...tabelas].sort()) {
    if (FORA_DA_FOTO.has(t)) continue;
    const ficam = (antes.get(t) ?? 0) - (ctx.saem.get(t)?.size ?? 0);
    if (ficam > 0) preservadas.push({ tabela: t, linhas: ficam });
  }

  // A impressão: as chaves exatas que saem, tabela a tabela, e as contagens de guarda e de dúvida.
  const h = createHash('sha256');
  h.update('devora/limpeza-da-demonstracao/1\n');
  h.update(`opcoes ${JSON.stringify(opcoes)}\n`);
  const comSaida = [...ctx.saem.entries()].filter(([, s]) => s.size > 0).map(([t]) => t).sort();
  for (const t of comSaida) {
    h.update(`tabela ${t}\n`);
    for (const id of identidades(db, t, ctx.saem.get(t)!)) h.update(`${id}\n`);
  }
  const guardas = new Set([...comSaida, 'core_customers', 'core_suppliers'].filter((t) => tabelas.has(t)));
  for (const t of [...guardas].sort()) h.update(`contagem ${t}=${antes.get(t) ?? 0}\n`);

  return {
    versaoDoNucleo,
    jaAplicadaEm,
    opcoes,
    passos,
    execucao,
    saem: ctx.saem,
    porTabela,
    totalQueSai,
    produtos,
    usuarios,
    duvidas: {
      clientes: candidatos('core_customers', opcoes.incluirClientes),
      fornecedores: candidatos('core_suppliers', opcoes.incluirFornecedor),
      sequenciasDeEtiqueta: { linhas: sequenciasDeEtiqueta, reiniciadas: opcoes.reiniciarSequenciasDeEtiqueta },
    },
    preservadas,
    arquivos: arquivosQueSaem(ctx),
    documentosFiscaisDeProducao: fiscaisDeProducao,
    bloqueios: ctx.bloqueios,
    impressao: h.digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// A foto de cada tabela: contagem e o sha256 das linhas que ficam
// ---------------------------------------------------------------------------

export type Fotografia = Map<string, { linhas: number; digest: string }>;

function serializar(v: unknown): string {
  if (v === null || v === undefined) return 'n';
  if (v instanceof Uint8Array) return `b${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'bigint') return `i${v.toString()}`;
  if (typeof v === 'number') return `d${String(v)}`;
  return `s${JSON.stringify(v)}`;
}

/**
 * Para cada tabela: quantas linhas tem, e o sha256 das linhas que NÃO estão em
 * `excluir` (com o rowid junto: a mesma linha no mesmo lugar).
 */
export function fotografar(db: DatabaseSync, excluir: Map<string, Set<number>> = new Map()): Fotografia {
  const foto: Fotografia = new Map();
  for (const t of tabelasDoBanco(db)) {
    if (FORA_DA_FOTO.has(t)) continue;
    const fora = excluir.get(t);
    const h = createHash('sha256');
    let linhas = 0;
    for (const l of db.prepare(`SELECT rowid AS "__rowid__", * FROM ${q(t)} ORDER BY rowid`).all() as Array<Record<string, unknown>>) {
      linhas += 1;
      if (fora?.has(Number(l.__rowid__))) continue;
      h.update(`${JSON.stringify(Object.values(l).map(serializar))}\n`);
    }
    foto.set(t, { linhas, digest: h.digest('hex') });
  }
  return foto;
}

/** O que diverge entre a foto de antes e a de depois, dado o que devia sair. */
export function divergencias(
  antes: Fotografia,
  depois: Fotografia,
  saem: Map<string, Set<number>>,
  acrescimos: Record<string, number> = {},
): string[] {
  const achadas: string[] = [];
  for (const [t, a] of antes) {
    const d = depois.get(t);
    if (!d) {
      achadas.push(`${t}: a tabela sumiu.`);
      continue;
    }
    const esperado = a.linhas - (saem.get(t)?.size ?? 0) + (acrescimos[t] ?? 0);
    if (d.linhas !== esperado) achadas.push(`${t}: esperava ${esperado} linha(s) depois, ficaram ${d.linhas}.`);
    else if (d.digest !== a.digest) achadas.push(`${t}: uma linha que devia ficar não está igual.`);
  }
  for (const t of depois.keys()) if (!antes.has(t)) achadas.push(`${t}: tabela nova durante a limpeza.`);
  return achadas;
}

// ---------------------------------------------------------------------------
// A transação
// ---------------------------------------------------------------------------

export class ImpressaoDivergente extends Error {
  constructor(readonly esperada: string, readonly atual: string) {
    super(
      'A impressão digital não bate com o banco de agora: o dado mudou desde a simulação '
        + '(ou as flags não são as mesmas). Nada foi apagado. Rode a simulação de novo, confira, e aplique com a impressão nova.',
    );
    this.name = 'ImpressaoDivergente';
  }
}

export class LimpezaBloqueada extends Error {
  constructor(readonly bloqueios: string[]) {
    super(`A limpeza não pode rodar sobre este banco: ${bloqueios.join(' ')}`);
    this.name = 'LimpezaBloqueada';
  }
}

export class DivergenciaNaLimpeza extends Error {
  constructor(readonly achadas: string[]) {
    super(`O que saiu não é o que o plano disse — ROLLBACK, nada mudou: ${achadas.join(' ')}`);
    this.name = 'DivergenciaNaLimpeza';
  }
}

export interface ResultadoDaTransacao {
  plano: Plano;
  antes: Fotografia;
  idDaAuditoria: string;
  rowidDaAuditoria: number;
}

/**
 * Roda a limpeza numa transação sobre `db`, que o chamador já assumiu (trava
 * de instância) e já copiou. Lança — com ROLLBACK — se a impressão divergir,
 * se houver bloqueio, se o SQLite recusar, ou se o que saiu não for o plano.
 */
export function executarLimpeza(
  db: DatabaseSync,
  entrada: OpcoesDaLimpeza,
  impressao: string,
  extrasDaAuditoria: Record<string, unknown> = {},
): ResultadoDaTransacao {
  db.exec('PRAGMA foreign_keys = ON;');
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (Number(fk.foreign_keys) !== 1) throw new Error('foreign_keys não ligou nesta conexão: a limpeza não roda sem ele.');

  db.exec('BEGIN IMMEDIATE;');
  try {
    const plano = planejarLimpeza(db, entrada);
    if (plano.impressao !== impressao) throw new ImpressaoDivergente(impressao, plano.impressao);
    if (plano.bloqueios.length > 0) throw new LimpezaBloqueada(plano.bloqueios);

    const antes = fotografar(db, plano.saem);
    for (const i of plano.execucao) {
      db.prepare(`DELETE FROM ${q(i.tabela)} WHERE rowid IN (SELECT value FROM json_each(?))`).run(json(i.rowids));
    }

    const idDaAuditoria = randomUUID();
    const porTabela: Record<string, number> = {};
    for (const l of plano.porTabela) porTabela[l.tabela] = l.saem;
    // Só contagens, a impressão e as flags: nenhum login, nome, documento ou contato.
    db.prepare(
      `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
       VALUES (?, NULL, NULL, ?, 'banco', NULL, ?, NULL, ?)`,
    ).run(
      idDaAuditoria,
      ACAO_DA_LIMPEZA,
      JSON.stringify({
        impressao: plano.impressao,
        opcoes: plano.opcoes,
        versaoDoNucleo: plano.versaoDoNucleo,
        linhasQueSairam: plano.totalQueSai,
        porTabela,
        ...extrasDaAuditoria,
      }),
      new Date().toISOString(),
    );
    const rowidDaAuditoria = Number(
      (db.prepare('SELECT rowid AS r FROM core_audit_log WHERE id = ?').get(idDaAuditoria) as { r: number }).r,
    );

    const depois = fotografar(db, new Map([['core_audit_log', new Set([rowidDaAuditoria])]]));
    const achadas = divergencias(antes, depois, plano.saem, { core_audit_log: 1 });
    const quebradas = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    if (quebradas > 0) achadas.push(`foreign_key_check: ${quebradas} referência(s) quebrada(s).`);
    if (achadas.length > 0) throw new DivergenciaNaLimpeza(achadas);

    db.exec('COMMIT;');
    return { plano, antes, idDaAuditoria, rowidDaAuditoria };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // o SQLite pode já ter desfeito sozinho
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// As provas, depois do COMMIT
// ---------------------------------------------------------------------------

export interface Provas {
  integridade: string;
  chavesQuebradas: number;
  produtos: number;
  saldo: { linhas: number; quantidade: number; reservado: number };
  movimentos: number;
  usuariosDaDemonstracao: number;
  usuarios: number;
  sessoes: number;
  empresas: { antes: number; depois: number };
  configuracao: Array<{ tabela: string; igual: boolean }>;
  divergencias: string[];
  auditoria: { antes: number; depois: number; novaLinha: boolean };
  sequenciasQueFicam: string[];
}

export function provasDaLimpeza(db: DatabaseSync, r: ResultadoDaTransacao): Provas {
  const tabelas = new Set(tabelasDoBanco(db));
  const n = (t: string): number => (tabelas.has(t) ? contar(db, t) : 0);
  const depois = fotografar(db, new Map([['core_audit_log', new Set([r.rowidDaAuditoria])]]));
  const saldo = tabelas.has('core_stock')
    ? (db.prepare('SELECT COUNT(*) AS linhas, COALESCE(SUM(quantity), 0) AS q, COALESCE(SUM(reserved), 0) AS r FROM core_stock').get() as {
        linhas: number;
        q: number;
        r: number;
      })
    : { linhas: 0, q: 0, r: 0 };
  return {
    integridade: String(
      (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
    ),
    chavesQuebradas: (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
    produtos: n('core_products'),
    saldo: { linhas: Number(saldo.linhas), quantidade: Number(saldo.q), reservado: Number(saldo.r) },
    movimentos: n('core_stock_movements'),
    usuariosDaDemonstracao: tabelas.has('core_users')
      ? umValor<number>(db, `SELECT COUNT(*) FROM core_users WHERE login COLLATE NOCASE IN (${lista(LOGINS_DA_DEMONSTRACAO)})`) ?? 0
      : 0,
    usuarios: n('core_users'),
    sessoes: n('api_sessions'),
    empresas: { antes: r.antes.get('core_companies')?.linhas ?? 0, depois: n('core_companies') },
    configuracao: CONFIGURACAO_CONFERIDA.filter((t) => r.antes.has(t)).map((t) => ({
      tabela: t,
      igual: r.antes.get(t)?.digest === depois.get(t)?.digest && r.antes.get(t)?.linhas === depois.get(t)?.linhas,
    })),
    divergencias: divergencias(r.antes, depois, r.plano.saem, { core_audit_log: 1 }),
    auditoria: {
      antes: r.antes.get('core_audit_log')?.linhas ?? 0,
      depois: n('core_audit_log'),
      novaLinha: Boolean(umValor<string>(db, 'SELECT id FROM core_audit_log WHERE id = ? AND action = ?', r.idDaAuditoria, ACAO_DA_LIMPEZA)),
    },
    sequenciasQueFicam: tabelas.has('core_sequences')
      ? (db.prepare('SELECT name, COUNT(*) AS n FROM core_sequences GROUP BY name ORDER BY name').all() as Array<{ name: string; n: number }>).map(
          (l) => `${l.name}=${l.n}`,
        )
      : [],
  };
}
