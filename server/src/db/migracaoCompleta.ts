/**
 * ============================================================================
 * PREPARAR O BANCO — o que o boot faz, e o que o `db:migrate` faz: o mesmo
 * ============================================================================
 *
 * O boot (`index.ts`) leva o banco ao formato desta build antes de abrir a
 * porta: camada de documentos, NÚCLEO (com snapshot quando há passo a rodar) e
 * os fatos estruturais do grupo (as duas bancadas oficiais e quem usa
 * plaquinha). O `npm run db:migrate` só fazia a primeira parte — e, no
 * Windows, nem essa (GAP-PRD-056).
 *
 * As duas portas chamam `prepararBanco`. Assim um upgrade "a frio" — banco
 * migrado ANTES de subir a nova build, com a API desligada — faz exatamente o
 * que a subida faria, e o operador vê o resultado antes de abrir o balcão.
 */
import { runMigrations } from './migrate.js';
import {
  ensureOfficialTagCompanies,
  ensureOfficialWorkshops,
  migrateCoreSchema,
  type OpcoesDaMigracao,
} from './core-migrations.js';
import { closeConnection, resolveDatabasePath } from './sqlite.js';
import { ensurePermissionTemplates } from '../services/auth/AcessoService.js';
import { ativarDevolucaoEmDuasEtapasNaPrecoJusto } from '../services/core/SalePolicyService.js';
import { fraseDaSituacao, versoesDoArquivo, versoesDoBancoEmUso, type VersoesDoEsquema } from './versaoDoEsquema.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';

export function prepararBanco(opcoes: OpcoesDaMigracao = {}): { nucleo: { de: number; para: number } } {
  runMigrations();
  const { from, to } = migrateCoreSchema(opcoes);
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  // A devolução em duas etapas nasce ligada só na Preço Justo, e só onde o
  // dono ainda não escolheu (ver SalePolicyService).
  ativarDevolucaoEmDuasEtapasNaPrecoJusto();
  // Os modelos de permissão de sistema (RBAC granular): semeados a cada
  // subida, sem sobrescrever o que o dono editou — ver `AcessoService.ts`.
  ensurePermissionTemplates();
  return { nucleo: { de: from, para: to } };
}

function linhaDeVersoes(v: VersoesDoEsquema): string {
  return (
    `Núcleo: versão ${v.nucleo.versao ?? '—'} (alvo desta build: ${v.nucleo.alvo}). `
    + `Camada de documentos: ${v.documentos.versao ?? '—'} (alvo ${v.documentos.alvo}).`
  );
}

/**
 * O comando. Devolve o código de saída em vez de chamar `process.exit`: o
 * processo termina sozinho quando o banco fecha, e a saída pendente no stdout
 * não se perde (no Windows, `exit` com escrita pendente já cortou relatório).
 */
export function migrarPelaLinhaDeComando(): number {
  const caminho = resolveDatabasePath();
  let trava: Trava | null = null;
  try {
    const antes = versoesDoArquivo(caminho);
    console.log(`Banco: ${caminho}`);
    console.log(
      antes.existe
        ? `Antes — ${linhaDeVersoes(antes)}`
        : 'Antes — o arquivo não existe: será criado agora.',
    );
    /*
      A MIGRAÇÃO TEM DONO (GAP-PRD-137). Os passos do núcleo conferem e marcam
      sem trava entre processos: migrar a frio com a API no ar é migrar duas
      vezes ao mesmo tempo. Com a API no ar não há o que fazer aqui — ela migra
      sozinha ao subir —, então o comando recusa e diz quem está usando.
    */
    try {
      trava = assumirInstanciaAgora('migracao');
    } catch (err) {
      if (!(err instanceof BancoOcupado)) throw err;
      console.error(err.message);
      console.error('Nada foi migrado. A API no ar migra ao subir; para migrar a frio, pare-a antes.');
      return 1;
    }
    prepararBanco();
    const depois = versoesDoBancoEmUso();
    console.log(`Depois — ${linhaDeVersoes(depois)}`);
    console.log(fraseDaSituacao(depois));
    if (depois.situacao !== 'EM_DIA') {
      console.log('A migração terminou, mas o banco NÃO ficou na versão desta build.');
      return 1;
    }
    console.log('Migrações aplicadas.');
    return 0;
  } catch (err) {
    console.error(`A migração falhou: ${(err as Error).message}`);
    console.error('Nada foi dado como migrado. Se havia passo pendente, o snapshot pré-migração está na pasta de backup.');
    return 1;
  } finally {
    trava?.liberar();
    closeConnection();
  }
}
