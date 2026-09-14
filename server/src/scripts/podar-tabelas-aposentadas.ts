/**
 * ============================================================================
 * PODA DAS TABELAS APOSENTADAS — `npm run db:podar-legado` (GAP-PRD-141)
 * ============================================================================
 *
 * O banco de uma instalação antiga carrega coleções que nenhuma linha do
 * código lê ou escreve: as 81 que a rodada 36 tirou de `TABLE_NAMES` sem
 * apagar, e as 90 que o GAP-PRD-141 tirou. Instalação nova já não as cria.
 * Este comando é o caminho para tirá-las do banco que já existe — e é
 * opcional: nada no sistema depende de elas saírem.
 *
 * ## Como se usa
 *
 *     # 1. ENSAIO (padrão) — não escreve nada, só diz o que sairia
 *     npm run db:podar-legado
 *
 *     # 2. DE VERDADE — com a API PARADA
 *     npm run db:podar-legado -- --aplicar
 *
 * `--aplicar` assume o banco (recusa com a API no ar — GAP-PRD-137), tira uma
 * cópia do banco ANTES (sem cópia, não apaga nada) e apaga só o que é
 * aposentado E vazio. Aposentada com linha fica, e o relatório diz quantas.
 * Coleção que esta versão não conhece fica, e o relatório diz qual.
 */
import { existsSync } from 'node:fs';
import { snapshotDatabase } from '../db/backup.js';
import { closeConnection, getConnection, resolveDatabasePath } from '../db/sqlite.js';
import { podarTabelasAposentadas, type ResultadoDaPoda } from '../db/tabelasAposentadas.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

function relatar(r: ResultadoDaPoda): void {
  console.log(r.ensaio ? '=== ENSAIO — nada foi escrito ===' : '=== PODA APLICADA ===');
  console.log(`Aposentadas e vazias${r.ensaio ? ' (sairiam)' : ''}: ${r.aRemover.length}`);
  for (const nome of r.aRemover) console.log(`  ${nome}`);
  if (!r.ensaio) console.log(`Removidas: ${r.removidas.length}`);
  if (r.mantidasComDado.length > 0) {
    console.log('Aposentadas COM linhas — ficam; decidir com o backup na mão:');
    for (const t of r.mantidasComDado) console.log(`  ${t.nome}: ${t.linhas} linha(s)`);
  }
  if (r.desconhecidas.length > 0) {
    console.log('Coleções que esta versão não conhece — ficam, nunca se apaga o que não se conhece:');
    for (const nome of r.desconhecidas) console.log(`  ${nome}`);
  }
}

/** Devolve o código de saída (0 = feito ou ensaiado; 1 = recusado ou falhou). */
export function podarPelaLinhaDeComando(args: string[]): number {
  const aplicar = args.includes('--aplicar');
  const caminho = resolveDatabasePath();
  console.log(`Banco: ${caminho}`);
  if (caminho !== ':memory:' && !existsSync(caminho)) {
    console.error('O arquivo do banco não existe. Nada a podar.');
    return 1;
  }

  let trava: Trava | null = null;
  try {
    if (aplicar) {
      try {
        trava = assumirInstanciaAgora('manutencao');
      } catch (err) {
        if (!(err instanceof BancoOcupado)) throw err;
        console.error(err.message);
        console.error('Nada foi apagado: pare a API antes de podar.');
        return 1;
      }
      try {
        const copia = snapshotDatabase('pre-poda-tabelas-aposentadas');
        console.log(copia.skipped ? 'Cópia antes: pulada (banco descartável de teste).' : `Cópia antes: ${copia.path}`);
      } catch (err) {
        console.error(`Não foi possível copiar o banco antes: ${(err as Error).message}`);
        console.error('Nada foi apagado. Sem cópia, a poda não roda.');
        return 1;
      }
    }
    relatar(podarTabelasAposentadas(getConnection(), { aplicar }));
    if (!aplicar) console.log('Para valer, com a API parada: npm run db:podar-legado -- --aplicar');
    return 0;
  } catch (err) {
    console.error(`A poda falhou: ${(err as Error).message}. Nada foi apagado (a transação voltou).`);
    return 1;
  } finally {
    trava?.liberar();
    closeConnection();
  }
}

if (ehPontoDeEntrada(import.meta.url)) {
  process.exitCode = podarPelaLinhaDeComando(process.argv.slice(2));
}
