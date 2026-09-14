/**
 * `npm run db:conferir-esquema` — o banco contra um banco NOVO desta build
 * (GAP-PRD-140).
 *
 * O `db:status` responde "em que passo o banco está". Este comando responde a
 * pergunta que o número não responde: o banco TEM a forma que os passos
 * prometem? Compara colunas (tipo, NOT NULL, DEFAULT), UNIQUE e CHECK
 * declarados na tabela e índices com um banco novo montado em memória pelo
 * mesmo caminho do boot.
 *
 *   npm run db:conferir-esquema                ensaio: abre o arquivo SÓ PARA
 *                                              LEITURA, lista as divergências
 *                                              e não muda nada (sai com 0 se
 *                                              idêntico, 1 se não)
 *   npm run db:conferir-esquema -- --reparar   com a API PARADA: assume a trava
 *                                              do banco, tira uma cópia, migra
 *                                              e repara (o que a subida faria),
 *                                              e confere de novo
 *
 * Em produção, sem o `tsx`: `node server/dist/db/conferirEsquema.js [--reparar]`.
 */
import { existsSync } from 'node:fs';
import { snapshotDatabase } from './backup.js';
import { CORE_TARGET_VERSION } from './core-migrations.js';
import {
  conferirEsquema,
  conferirEsquemaDoArquivo,
  derivaDoBancoEmUso,
  type ConferenciaDoEsquema,
  type ReparoDaDivergencia,
} from './derivaDoEsquema.js';
import { prepararBanco } from './migracaoCompleta.js';
import { closeConnection, getConnection, resolveDatabasePath } from './sqlite.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

type Escrever = (linha: string) => void;

const ROTULO_DO_REPARO: Record<ReparoDaDivergencia, string> = {
  criar_tabela: 'cria a tabela',
  acrescentar_coluna: 'acrescenta a coluna',
  reconstruir_tabela: 'reconstrói a tabela pela DDL canônica, preservando as linhas',
  criar_indice: 'cria o índice',
  recriar_indice: 'recria o índice',
  derrubar_indice: 'derruba o índice',
  manual: 'precisa de decisão',
};

function relatar(c: ConferenciaDoEsquema, escrever: Escrever): void {
  escrever(`Conferido contra um banco novo desta build: ${c.tabelasConferidas} tabelas, ${c.indicesConferidos} índices.`);
  if (c.identico) {
    escrever('IDÊNTICO: nenhuma divergência de coluna, DEFAULT, UNIQUE, CHECK ou índice.');
  } else {
    escrever(`DIVERGE em ${c.divergencias.length} ponto(s):`);
    for (const d of c.divergencias) escrever(`  - ${d.descricao} [reparo: ${ROTULO_DO_REPARO[d.reparo]}]`);
  }
  if (c.aMais.length > 0) {
    const porTipo = new Map<string, number>();
    for (const o of c.aMais) porTipo.set(o.tipo, (porTipo.get(o.tipo) ?? 0) + 1);
    escrever(
      `Só neste banco, mantidos (não são divergência): ${[...porTipo].map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ')}.`,
    );
  }
}

/**
 * O comando. Devolve o código de saída em vez de chamar `process.exit`: a
 * saída pendente no stdout não se perde (ver `migrarPelaLinhaDeComando`).
 */
export function conferirEsquemaPelaLinhaDeComando(
  args: string[] = process.argv.slice(2),
  escrever: Escrever = console.log,
  erro: Escrever = console.error,
): number {
  const reparar = args.includes('--reparar');
  const caminho = resolveDatabasePath();
  escrever(`Banco: ${caminho}`);

  if (!reparar) {
    const r = conferirEsquemaDoArquivo(caminho);
    if (!r.existe || !r.conferencia) {
      erro('Não há banco neste caminho. Nada foi conferido (e nada foi criado).');
      return 1;
    }
    escrever('Ensaio: o banco foi aberto só para leitura; nada foi mudado.');
    if (r.versaoDoNucleo != null && r.versaoDoNucleo > CORE_TARGET_VERSION) {
      escrever(
        `O banco é de uma build mais nova (núcleo ${r.versaoDoNucleo}, alvo ${CORE_TARGET_VERSION}): `
          + 'a conferência desta build não vale para ele.',
      );
      return 1;
    }
    if (r.versaoDoNucleo == null || r.versaoDoNucleo < CORE_TARGET_VERSION) {
      escrever(
        `Atenção: núcleo na versão ${r.versaoDoNucleo ?? '—'}, alvo ${CORE_TARGET_VERSION}. Parte do que segue é `
          + 'migração pendente — a API a aplica ao subir (ou o db:migrate), e repara o esquema logo depois.',
      );
    }
    relatar(r.conferencia, escrever);
    if (!r.conferencia.identico) {
      escrever('Para reparar, com a API parada: npm run db:conferir-esquema -- --reparar (tira uma cópia do banco antes).');
    }
    return r.conferencia.identico ? 0 : 1;
  }

  if (caminho === ':memory:' || !existsSync(caminho)) {
    erro('Não há banco neste caminho: não há o que reparar.');
    return 1;
  }
  let trava: Trava | null = null;
  try {
    // O reparo reconstrói tabela: com a API no ar seriam dois donos no mesmo
    // arquivo (GAP-PRD-137). A trava recusa e diz quem está usando.
    try {
      trava = assumirInstanciaAgora('manutencao');
    } catch (err) {
      if (!(err instanceof BancoOcupado)) throw err;
      erro(err.message);
      erro('Nada foi reparado. Pare a API antes de reparar o esquema.');
      return 1;
    }

    let copia: string | null;
    try {
      const s = snapshotDatabase('pre-reparo-esquema');
      copia = s.path || null;
      escrever(
        copia
          ? `Cópia do banco antes do reparo: ${copia}`
          : 'Banco declarado descartável (TEST_DATABASE_PATH): cópia dispensada.',
      );
    } catch (err) {
      erro(`A cópia do banco falhou: ${(err as Error).message}. Nada foi reparado — sem cópia não se reconstrói tabela.`);
      return 1;
    }

    prepararBanco({ reparoDoEsquema: { modo: 'comando', copiaJaFeita: { caminho: copia } } });
    const deriva = derivaDoBancoEmUso(getConnection());
    const reparo = deriva.ultimoReparo;
    if (reparo && reparo.reparados.length > 0) {
      escrever(`Reparado (${reparo.reparados.length}):`);
      for (const x of reparo.reparados) escrever(`  + ${x}`);
    }
    if (reparo && reparo.pendentes.length > 0) {
      escrever(`Não reparado (${reparo.pendentes.length}):`);
      for (const p of reparo.pendentes) escrever(`  ! ${p.objeto}: ${p.motivo}`);
    }
    const depois = conferirEsquema(getConnection());
    escrever('Depois do reparo:');
    relatar(depois, escrever);
    return depois.identico ? 0 : 1;
  } catch (err) {
    erro(`O reparo falhou: ${(err as Error).message}`);
    return 1;
  } finally {
    trava?.liberar();
    closeConnection();
  }
}

if (ehPontoDeEntrada(import.meta.url)) {
  process.exitCode = conferirEsquemaPelaLinhaDeComando();
}
