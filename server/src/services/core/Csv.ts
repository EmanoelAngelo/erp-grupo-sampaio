/**
 * ============================================================================
 * CSV DA CASA — um gerador só, para o zip do contador e para a Central
 * ============================================================================
 *
 * ## O DEFEITO que este arquivo existe para não repetir
 *
 * Até a rodada dos relatórios havia UM gerador de CSV no repositório inteiro,
 * e ele era privado: `campoCsv`/`linhaCsv`/`montarCsv` moravam dentro de
 * `FiscalClosingService.ts`, servindo só aos três arquivos do zip mensal
 * (`dre.csv`, `inutilizadas.csv`, `MANIFESTO.csv`). Nenhuma tela exportava
 * nada, e a Central de Relatórios (GAP-V37) precisa exportar catorze.
 *
 * O caminho fácil seria copiar as três funções para o serviço novo. Seria o
 * segundo formato de CSV do sistema no dia em que alguém consertasse um
 * escape num lado só — e a forma de descobrir é o contador abrindo dois
 * arquivos do MESMO sistema, um com acento e outro com "InutilizaÃ§Ã£o".
 *
 * Então elas saíram de lá e vieram para cá inteiras, sem mudar um byte do
 * resultado. `FiscalClosingService` importa daqui; `ReportsService` também.
 * O zip do mês continua saindo byte a byte igual — é o que
 * `fechamento-contador.test.ts` já cobra, comparando conteúdo contra o banco.
 *
 * ## AS TRÊS DECISÕES DE FORMATO, e por que cada uma
 *
 * Elas não são gosto: são o que faz o arquivo abrir certo no Excel em
 * português, que é onde o contador e o gestor abrem estes arquivos — não num
 * editor de texto.
 */

/**
 * O BOM de UTF-8 na frente do CSV.
 *
 * Sem ele o Excel em português abre o arquivo em ANSI e "Inutilização" vira
 * "InutilizaÃ§Ã£o". O contador abre estes arquivos no Excel — não num editor
 * de texto —, e um relatório com acento quebrado é lido como sistema
 * malfeito, com razão.
 */
export const BOM = '\uFEFF';

/** Ponto-e-vírgula: é o separador que o Excel em português espera. */
export const SEP = ';';

export function campoCsv(valor: string | number | null | undefined): string {
  const texto = valor === null || valor === undefined ? '' : String(valor);
  // Aspas, separador e quebra de linha precisam de aspas em volta, com as
  // aspas internas dobradas. Sem isto uma justificativa com ponto-e-vírgula
  // desloca todas as colunas à direita dela.
  if (/["\r\n;]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

export function linhaCsv(campos: (string | number | null | undefined)[]): string {
  return campos.map(campoCsv).join(SEP);
}

/** CRLF, porque o destino é Excel no Windows. */
export function montarCsv(linhas: string[]): string {
  return BOM + linhas.join('\r\n') + '\r\n';
}

/**
 * Centavo inteiro virando texto de planilha — vírgula decimal, sem separador
 * de milhar.
 *
 * O separador de milhar fica de FORA de propósito: "1.485,60" com ponto entra
 * no Excel como texto em algumas configurações regionais, e uma coluna de
 * dinheiro que não soma é pior que uma coluna feia. Quem formata bonito é a
 * TELA; o CSV existe para ser somado.
 */
export function reaisCsv(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * O nome do arquivo, seguro para o `Content-Disposition`.
 *
 * O cabeçalho é lido por navegador, e um nome com aspas ou quebra de linha
 * fecha a string do cabeçalho — o mesmo tipo de escape do `campoCsv`, num
 * outro protocolo. Nome vazio devolve um padrão em vez de um cabeçalho
 * quebrado.
 */
export function nomeDeArquivoSeguro(nome: string, padrao = 'relatorio.csv'): string {
  const limpo = nome
    .replace(/[\\/]+/g, '-')
    .replace(/["\r\n;]/g, '')
    .replace(/\.{2,}/g, '.')
    .trim();
  return limpo || padrao;
}
