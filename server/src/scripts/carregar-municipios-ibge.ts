/**
 * ============================================================================
 * CARREGAR A TABELA DE MUNICÍPIOS DO IBGE — uma vez, pelo dono (IBGE-MUNICIPIOS)
 * ============================================================================
 *
 *     node server/dist/scripts/carregar-municipios-ibge.js --baixar             (no servidor)
 *     node server/dist/scripts/carregar-municipios-ibge.js --arquivo municipios.json
 *     node server/dist/scripts/carregar-municipios-ibge.js --arquivo municipios.csv
 *     npm run ibge:municipios -- --baixar                                      (na bancada)
 *
 * Com a tabela carregada, o formulário do endereço (Minha conta e o checkout
 * da loja) e o cadastro fiscal do emitente acham a cidade pelo nome e o
 * código IBGE vem junto — o cliente nunca digita o código —, e o servidor
 * confere que o código existe e é da UF do endereço. Sem ela, o código é
 * digitado como sempre foi.
 *
 * DE ONDE VEM A LISTA — sempre a OFICIAL do IBGE:
 *
 *   --baixar          busca https://servicodados.ibge.gov.br/api/v1/localidades/municipios
 *                     (dado público, sem chave). Só quando o DONO roda.
 *   --arquivo <x>     lê o arquivo que o dono baixou dessa mesma URL (servidor
 *                     sem internet: baixe noutra máquina e copie), ou um CSV
 *                     `codigo;nome;uf`.
 *
 * A lista é conferida ANTES de gravar (7 dígitos, os dois primeiros = o
 * código da UF, nome, sem código repetido, e o total da lista inteira —
 * ~5.570). Lista que não passa não grava nada. Gravar é uma transação e é
 * idempotente: rodar de novo com a mesma lista não muda nada, e com a lista
 * nova atualiza o que mudou. Pode rodar com a API no ar.
 */
import { existsSync, readFileSync } from 'node:fs';
import { closeConnection, resolveDatabasePath } from '../db/sqlite.js';
import {
  FAIXA_PLAUSIVEL,
  ListaDeMunicipiosInvalida,
  URL_OFICIAL_DOS_MUNICIPIOS,
  comMilhar,
  gravarMunicipios,
  lerListaDoIbge,
  validarListaDeMunicipios,
} from '../services/core/MunicipiosIbge.js';
import { ehPontoDeEntrada } from '../utils/pontoDeEntrada.js';

/** O que o comando usa do mundo — os testes trocam (fetch de mentira, sem rede). */
export interface DependenciasDaCarga {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  lerArquivo?: (caminho: string) => string;
  /** A faixa do total aceito; o padrão é a da lista inteira (~5.570). */
  faixaPlausivel?: readonly [number, number];
  log?: (linha: string) => void;
  erro?: (linha: string) => void;
}

const COMO_SE_USA = [
  'Uso:',
  '  node server/dist/scripts/carregar-municipios-ibge.js --baixar',
  '      busca a lista oficial em ' + URL_OFICIAL_DOS_MUNICIPIOS,
  '  node server/dist/scripts/carregar-municipios-ibge.js --arquivo <municipios.json | municipios.csv>',
  '      lê a lista baixada dessa URL (JSON do IBGE) ou um CSV codigo;nome;uf',
];

/** `--arquivo x` ou `--arquivo=x`. */
function valorDe(args: string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  if (i >= 0) return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
  const junto = args.find((a) => a.startsWith(`${nome}=`));
  return junto ? junto.slice(nome.length + 1) : undefined;
}

/** Devolve o código de saída: 0 = carregou; 1 = recusou ou falhou (nada gravado). */
export async function carregarMunicipiosPelaLinhaDeComando(
  args: string[],
  deps: DependenciasDaCarga = {},
): Promise<number> {
  const log = deps.log ?? ((linha: string) => console.log(linha));
  const erro = deps.erro ?? ((linha: string) => console.error(linha));
  const baixar = args.includes('--baixar');
  const arquivo = valorDe(args, '--arquivo');

  if (baixar === (arquivo !== undefined) || arquivo === '') {
    erro(baixar && arquivo !== undefined ? 'Use --baixar OU --arquivo, não os dois.' : 'Diga de onde vem a lista.');
    for (const linha of COMO_SE_USA) erro(linha);
    return 1;
  }

  const banco = resolveDatabasePath();
  log(`Banco: ${banco}`);
  if (banco !== ':memory:' && !existsSync(banco)) {
    erro(
      'O arquivo do banco não existe. Suba a API uma vez (ela cria o banco) ou confira DEVORA_DATABASE_PATH. '
        + 'Nada foi gravado.',
    );
    return 1;
  }

  let conteudo: string;
  try {
    if (baixar) {
      const buscar = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
      log(`Baixando a lista oficial: ${URL_OFICIAL_DOS_MUNICIPIOS}`);
      const res = await buscar(URL_OFICIAL_DOS_MUNICIPIOS, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        erro(
          `O IBGE respondeu ${res.status}. Nada foi gravado. Tente de novo mais tarde — ou baixe a lista `
            + 'noutra máquina e rode com --arquivo.',
        );
        return 1;
      }
      conteudo = await res.text();
    } else {
      log(`Arquivo: ${arquivo}`);
      conteudo = (deps.lerArquivo ?? ((c: string) => readFileSync(c, 'utf8')))(arquivo!);
    }
  } catch (err) {
    erro(`Não foi possível ler a lista: ${(err as Error).message}. Nada foi gravado.`);
    return 1;
  }

  try {
    const lista = validarListaDeMunicipios(lerListaDoIbge(conteudo), deps.faixaPlausivel ?? FAIXA_PLAUSIVEL);
    log(`Conferida: ${comMilhar(lista.length)} municípios em ${new Set(lista.map((m) => m.uf)).size} UF(s).`);
    const r = gravarMunicipios(lista);
    log(
      `Gravado: ${r.novos} novos, ${r.alterados} alterado(s), ${r.removidos} removido(s), ${r.iguais} iguais — `
        + `${comMilhar(r.total)} municípios na tabela.`,
    );
    log('O formulário do endereço e o cadastro fiscal passam a escolher a cidade pelo nome.');
    return 0;
  } catch (err) {
    if (err instanceof ListaDeMunicipiosInvalida) {
      erro('A lista foi recusada. Nada foi gravado.');
      for (const p of err.problemas.slice(0, 20)) erro(`  - ${p}`);
      if (err.problemas.length > 20) erro(`  … e mais ${err.problemas.length - 20} problema(s).`);
      return 1;
    }
    erro(`A carga falhou: ${(err as Error).message}. Nada foi gravado (a transação voltou).`);
    return 1;
  }
}

if (ehPontoDeEntrada(import.meta.url)) {
  carregarMunicipiosPelaLinhaDeComando(process.argv.slice(2))
    .then((codigo) => {
      process.exitCode = codigo;
    })
    .finally(() => closeConnection());
}
