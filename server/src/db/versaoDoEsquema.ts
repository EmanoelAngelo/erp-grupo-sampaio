/**
 * ============================================================================
 * A VERSÃO DO BANCO — um número só, o do núcleo (GAP-PRD-057)
 * ============================================================================
 *
 * Este banco tem DOIS relógios, e só um deles importa:
 *
 *   - `core_meta.core_schema_version` — o NÚCLEO relacional (vendas, caixa,
 *     estoque, fiscal, oficina…). É o que as migrações de `core-migrations.ts`
 *     levam até `CORE_TARGET_VERSION`, e é o que muda quando o código muda.
 *   - `db_meta.version` — a camada de DOCUMENTOS herdada do projeto anterior.
 *     Parou em 19 e não anda mais (o degrau 19 existe só para não renumerar).
 *
 * `npm run db:status` e `GET /system/readiness` mediam o segundo: diziam 19
 * num banco que estava em 84, e o READY vinha de `version >= 15` — uma sonda
 * que ficava verde para sempre depois do primeiro boot. O checklist, por sua
 * vez, falava em "v73". Três números para a mesma pergunta.
 *
 * Aqui mora a resposta única: a versão do núcleo contra o alvo desta build,
 * mais os passos cuja marca falta (o número já mentiu neste projeto — ver
 * `stepApplied` em `core-migrations.ts` —, então "em dia" exige o número E as
 * marcas). A camada de documentos aparece ao lado, rotulada, para quem
 * precisar dela.
 *
 * NUNCA escreve. As duas leituras abrem o que já existe: `versoesDoArquivo`
 * abre o arquivo com `readOnly`, e `versoesDoBancoEmUso` só consulta a conexão
 * da API. Um comando de STATUS que cria tabela — o `loadDb()` antigo criava as
 * 134 da camada de documentos num banco novo — não é status.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CORE_TARGET_VERSION } from './core-migrations.js';
import { ALVO_DA_CAMADA_DE_DOCUMENTOS } from './migrate.js';
import { getConnection, resolveDatabasePath } from './sqlite.js';

export type SituacaoDoEsquema =
  /** Núcleo na versão desta build, com todas as marcas de passo. */
  | 'EM_DIA'
  /** Núcleo abaixo do alvo, ou com passo sem marca: a API migra ao subir. */
  | 'ATRASADO'
  /** Núcleo ACIMA do alvo: o banco é de uma build mais nova que este código. */
  | 'ADIANTADO'
  /** O arquivo existe, mas o núcleo nunca foi migrado (sem `core_meta`). */
  | 'NUNCA_MIGRADO'
  /** Não há arquivo de banco no caminho configurado. */
  | 'SEM_BANCO';

export interface VersoesDoEsquema {
  situacao: SituacaoDoEsquema;
  nucleo: {
    /** `core_meta.core_schema_version`; nulo quando nunca foi gravada. */
    versao: number | null;
    /** `CORE_TARGET_VERSION` desta build. */
    alvo: number;
    /** Passos de 2 até o alvo cuja marca `core_migration_step_N` falta. */
    passosPendentes: number[];
  };
  documentos: {
    /** `db_meta.version`; nulo quando a tabela não existe. */
    versao: number | null;
    alvo: number;
  };
}

function tabelaExiste(db: DatabaseSync, nome: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(nome) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function numero(valor: unknown): number | null {
  const n = Number(valor);
  return valor != null && Number.isFinite(n) ? n : null;
}

/** A régua, isolada para o teste poder cobrar cada caso sem montar banco. */
export function situacaoDoEsquema(
  nucleo: number | null,
  passosPendentes: number[],
  alvo = CORE_TARGET_VERSION,
): Exclude<SituacaoDoEsquema, 'SEM_BANCO'> {
  if (nucleo == null) return 'NUNCA_MIGRADO';
  if (nucleo > alvo) return 'ADIANTADO';
  if (nucleo < alvo || passosPendentes.length > 0) return 'ATRASADO';
  return 'EM_DIA';
}

/** Lê as duas versões de uma conexão aberta. Só SELECT. */
export function lerVersoes(db: DatabaseSync): VersoesDoEsquema {
  let nucleo: number | null = null;
  const aplicados = new Set<number>();
  if (tabelaExiste(db, 'core_meta')) {
    const linhas = db
      .prepare("SELECT key, value FROM core_meta WHERE key = 'core_schema_version' OR key LIKE 'core_migration_step_%'")
      .all() as Array<{ key: string; value: string }>;
    for (const { key, value } of linhas) {
      if (key === 'core_schema_version') nucleo = numero(value);
      else if (value === 'applied') {
        const passo = Number(key.slice('core_migration_step_'.length));
        if (Number.isInteger(passo)) aplicados.add(passo);
      }
    }
  }
  const passosPendentes: number[] = [];
  if (nucleo != null) {
    for (let passo = 2; passo <= CORE_TARGET_VERSION; passo += 1) {
      if (!aplicados.has(passo)) passosPendentes.push(passo);
    }
  }

  let documentos: number | null = null;
  if (tabelaExiste(db, 'db_meta')) {
    const row = db.prepare("SELECT value FROM db_meta WHERE key = 'version'").get() as
      | { value?: string }
      | undefined;
    documentos = numero(row?.value);
  }

  return {
    situacao: situacaoDoEsquema(nucleo, passosPendentes),
    nucleo: { versao: nucleo, alvo: CORE_TARGET_VERSION, passosPendentes },
    documentos: { versao: documentos, alvo: ALVO_DA_CAMADA_DE_DOCUMENTOS },
  };
}

/** As versões do banco que a API está usando agora. */
export function versoesDoBancoEmUso(): VersoesDoEsquema {
  return lerVersoes(getConnection());
}

/**
 * As versões de um ARQUIVO, sem abrir para escrita e sem criá-lo.
 *
 * É o que o `db:status` usa: ele roda com a API desligada (antes de um
 * upgrade) ou ligada (para conferir), e nos dois casos não pode mexer no
 * banco. Arquivo inexistente vira `SEM_BANCO` — e não um banco novo vazio,
 * que é o que `getConnection()` faria.
 */
export function versoesDoArquivo(
  caminho: string = resolveDatabasePath(),
): VersoesDoEsquema & { caminho: string; existe: boolean } {
  if (caminho === ':memory:' || !existsSync(caminho)) {
    return {
      caminho,
      existe: false,
      situacao: 'SEM_BANCO',
      nucleo: { versao: null, alvo: CORE_TARGET_VERSION, passosPendentes: [] },
      documentos: { versao: null, alvo: ALVO_DA_CAMADA_DE_DOCUMENTOS },
    };
  }
  const db = new DatabaseSync(caminho, { readOnly: true });
  try {
    return { caminho, existe: true, ...lerVersoes(db) };
  } finally {
    db.close();
  }
}

/** A frase de uma situação, para o comando e para a tela dizerem o mesmo. */
export function fraseDaSituacao(v: VersoesDoEsquema): string {
  const { versao, alvo, passosPendentes } = v.nucleo;
  switch (v.situacao) {
    case 'EM_DIA':
      return `Núcleo na versão ${alvo}, a desta build.`;
    case 'ATRASADO':
      return versao != null && versao < alvo
        ? `Núcleo na versão ${versao}; esta build pede ${alvo}. A API migra ao subir, ou rode o db:migrate.`
        : `Núcleo marcado como ${versao ?? '—'}, mas ${passosPendentes.length} passo(s) sem marca `
          + `(${passosPendentes.slice(0, 5).join(', ')}${passosPendentes.length > 5 ? '…' : ''}). A API os aplica ao subir, ou rode o db:migrate.`;
    case 'ADIANTADO':
      return `Núcleo na versão ${versao}, acima do alvo ${alvo} desta build: o banco é de uma versão mais nova do sistema. `
        + 'Migração é só para frente — volte a build que migrou este banco em vez de subir esta.';
    case 'NUNCA_MIGRADO':
      return 'O arquivo existe, mas o núcleo nunca foi migrado. A API migra ao subir, ou rode o db:migrate.';
    case 'SEM_BANCO':
      return 'Não há banco no caminho configurado. A primeira subida da API (ou o db:migrate) cria.';
  }
}
