/**
 * ============================================================================
 * PERFIS DE IMPRESSÃO DA ETIQUETA — por onde a etiqueta sai
 * ============================================================================
 *
 * DEFEITO QUE ISTO CORRIGE: a etiqueta tinha UMA saída — HTML pelo diálogo do
 * navegador. A térmica da loja, que fala ZPL, EPL ou TSPL, só imprimia pelo
 * driver do Windows, com a escala e a margem que o driver quisesse; não havia
 * PDF para a folha A4 nem arquivo de comandos para mandar direto à impressora.
 *
 * O perfil diz a SAÍDA e a medida da letra que o layout deve usar. O desenho é
 * um só (`LabelLayout.ts`); o perfil só escolhe o tradutor (`LabelCommands.ts`).
 *
 * ## O que não se promete
 *
 * Nenhuma saída foi homologada em papel. `HOMOLOGACAO_FISICA` é a lista do que
 * precisa ser conferido numa impressora de verdade antes de a loja confiar no
 * perfil — e a tela mostra essa lista junto do seletor.
 *
 * Módulo puro: nada de banco, nada de HTTP.
 */
import { metricaEpl, metricaTspl } from './LabelCommands.js';
import { METRICA_HELVETICA, metricaResidente, type MetricaDaFonte } from './LabelLayout.js';

export type IdDoPerfil = 'navegador' | 'driver_windows' | 'termica_generica' | 'pdf' | 'zpl' | 'epl' | 'tspl';
export type SaidaDoPerfil = 'html' | 'html_exato' | 'pdf' | 'zpl' | 'epl' | 'tspl';

export interface PerfilDeImpressao {
  id: IdDoPerfil;
  rotulo: string;
  /** Como usar, em uma frase — vai para a tela. */
  dica: string;
  saida: SaidaDoPerfil;
  mime: string;
  extensao: string;
  /** Folha A4/Carta: só as saídas que passam por driver ou PDF. A térmica é de rolo. */
  aceitaFolha: boolean;
  /** Densidade, velocidade, corte, sensor e vão vão DENTRO do arquivo (nas outras, ficam no driver). */
  levaAjustesDaTermica: boolean;
}

export const PERFIS_DE_IMPRESSAO: readonly PerfilDeImpressao[] = [
  {
    id: 'navegador',
    rotulo: 'Navegador (diálogo de impressão)',
    dica: 'A folha abre em janela própria e sai pelo diálogo do sistema, em qualquer impressora instalada. Escala 100 %, sem "ajustar à página".',
    saida: 'html',
    mime: 'text/html; charset=utf-8',
    extensao: 'html',
    aceitaFolha: true,
    levaAjustesDaTermica: false,
  },
  {
    id: 'driver_windows',
    rotulo: 'Driver da impressora (Windows)',
    dica: 'Página no tamanho exato da etiqueta, desenhada nos pontos da impressora do modelo. No diálogo, escolha o driver da impressora e o papel do tamanho da etiqueta; densidade e velocidade ficam no driver.',
    saida: 'html_exato',
    mime: 'text/html; charset=utf-8',
    extensao: 'html',
    aceitaFolha: true,
    levaAjustesDaTermica: false,
  },
  {
    id: 'termica_generica',
    rotulo: 'Térmica genérica (pelo driver)',
    dica: 'Para a térmica cuja linguagem não está aqui (PPLA/PPLB da Argox, por exemplo): a mesma página em pontos, só em preto, para o driver dela imprimir. Só rolo.',
    saida: 'html_exato',
    mime: 'text/html; charset=utf-8',
    extensao: 'html',
    aceitaFolha: false,
    levaAjustesDaTermica: false,
  },
  {
    id: 'pdf',
    rotulo: 'PDF (arquivo)',
    dica: 'Arquivo vetorial no tamanho real. Imprima em "tamanho real" (100 %). Bom para folha A4/Carta e para guardar.',
    saida: 'pdf',
    mime: 'application/pdf',
    extensao: 'pdf',
    aceitaFolha: true,
    levaAjustesDaTermica: false,
  },
  {
    id: 'zpl',
    rotulo: 'ZPL (Zebra e compatíveis)',
    dica: 'Arquivo de comandos ZPL II para mandar direto à impressora (porta 9100 da rede, compartilhamento do Windows ou o utilitário do fabricante). Só rolo.',
    saida: 'zpl',
    mime: 'text/plain; charset=utf-8',
    extensao: 'zpl',
    aceitaFolha: false,
    levaAjustesDaTermica: true,
  },
  {
    id: 'epl',
    rotulo: 'EPL2 (Zebra/Eltron antigas)',
    dica: 'Arquivo de comandos EPL2 (LP/TLP 2844 e compatíveis), em Windows-1252. Só rolo.',
    saida: 'epl',
    mime: 'text/plain; charset=windows-1252',
    extensao: 'epl',
    aceitaFolha: false,
    levaAjustesDaTermica: true,
  },
  {
    id: 'tspl',
    rotulo: 'TSPL (TSC e compatíveis)',
    dica: 'Arquivo de comandos TSPL/TSPL2 para mandar direto à impressora. Só rolo.',
    saida: 'tspl',
    mime: 'text/plain; charset=utf-8',
    extensao: 'prn',
    aceitaFolha: false,
    levaAjustesDaTermica: true,
  },
];

export const PERFIL_PADRAO: IdDoPerfil = 'navegador';

export function acharPerfil(id: unknown): PerfilDeImpressao | undefined {
  return PERFIS_DE_IMPRESSAO.find((p) => p.id === id);
}

/** A medida da letra que o layout usa para esta saída (a letra que ela vai imprimir). */
export function metricaDoPerfil(p: PerfilDeImpressao, dpi: number): MetricaDaFonte {
  if (p.saida === 'epl') return metricaEpl(dpi);
  if (p.saida === 'tspl') return metricaTspl(dpi);
  if (p.saida === 'zpl') return metricaResidente(1.1);
  return METRICA_HELVETICA;
}

/** A térmica pode não ter o caractere "…" na tabela dela: lá, três pontos. */
export function reticenciasDoPerfil(p: PerfilDeImpressao): string {
  return p.saida === 'zpl' || p.saida === 'epl' || p.saida === 'tspl' ? '...' : '…';
}

export interface ItemDeHomologacao {
  /** A saída a que o item se refere, ou "todas". */
  saida: SaidaDoPerfil | 'todas';
  item: string;
  /** Como conferir, em papel. */
  como: string;
}

/**
 * O QUE PRECISA DE HOMOLOGAÇÃO FÍSICA antes de a loja confiar em cada saída.
 *
 * Os comandos seguem os manuais; o papel é que diz se o firmware, a fonte
 * residente, o sensor e o cortador daquele modelo fazem o que o manual diz.
 * Nenhum modelo de impressora é declarado compatível aqui.
 */
export const HOMOLOGACAO_FISICA: readonly ItemDeHomologacao[] = [
  {
    saida: 'todas',
    item: 'Cada modelo de impressora em uso na loja, com o firmware dela',
    como: 'Imprimir a etiqueta de teste em cada modelo (as famílias a conferir incluem Zebra ZPL e EPL, TSC, Elgin e Argox — a Argox fala PPLA/PPLB, que não é gerada aqui, e sai pelo perfil de térmica genérica).',
  },
  {
    saida: 'todas',
    item: 'Leitura do código de barras pelo leitor do caixa',
    como: 'Bipar 20 vezes cada simbologia usada (EAN-13, EAN-8, UPC-A, Code 128) em cada combinação rolo × dpi — principalmente os rolos estreitos, onde o módulo fica abaixo do nominal GS1.',
  },
  {
    saida: 'todas',
    item: 'Calibração X/Y de cada impressora',
    como: 'Imprimir a etiqueta de teste (moldura a 0,5 mm da borda) e ajustar o deslocamento do modelo até a moldura ficar centrada no adesivo.',
  },
  {
    saida: 'todas',
    item: 'Mídia comprada: vão, marca preta ou contínua, e a medida do vão',
    como: 'Medir o vão do rolo com paquímetro, informar no modelo e imprimir 30 etiquetas seguidas: nenhuma pode sair pulada nem cortada ao meio.',
  },
  {
    saida: 'todas',
    item: 'Largura da cabeça de impressão frente ao rolo de várias colunas',
    como: 'Conferir que a largura da página (rolo de 2 ou 3 colunas) cabe na cabeça da impressora (2, 3 ou 4 polegadas) com a coluna da direita inteira.',
  },
  {
    saida: 'todas',
    item: 'Densidade e velocidade para o papel (térmico direto ou com ribbon)',
    como: 'Variar a densidade até as barras saírem pretas sem borrar; a barra borrada engorda e o leitor erra.',
  },
  {
    saida: 'zpl',
    item: 'Largura da fonte residente ^A0 frente à medida do layout (fator de segurança 1,1)',
    como: 'Imprimir o preço mais longo (R$ 9.999,99) e um nome de 60 letras no menor rolo: nada pode passar da borda.',
  },
  {
    saida: 'zpl',
    item: 'Acentos com ^CI28 (UTF-8)',
    como: 'Imprimir "ação, pão, café, Ç"; firmware antigo pode exigir outra página de código.',
  },
  {
    saida: 'zpl',
    item: 'Paisagem (^A0R, ^BER), cortador (^MMC), marca preta (^MNM), ~SD e ^PR',
    como: 'Conferir a posição dos campos girados, o corte a cada etiqueta e no fim do lote, e a faixa de velocidade aceita pelo modelo.',
  },
  {
    saida: 'tspl',
    item: 'CODEPAGE UTF-8, fonte "0" com corpo em pontos, SET CUTTER BATCH e a rotação de 90°',
    como: 'Imprimir texto acentuado em retrato e em paisagem, e um lote com corte só no fim.',
  },
  {
    saida: 'tspl',
    item: 'Code 128 manual (128M) e EAN-13 com 12 dígitos',
    como: 'Bipar os dois tipos e conferir que a largura do código no papel bate com a prévia.',
  },
  {
    saida: 'epl',
    item: 'Página de código I8,A (Windows-1252), fontes 1–4 a 203 dpi, rotação, OC (cortador), velocidade S1–S4',
    como: 'Imprimir texto acentuado e conferir as larguras; em EPL o Code 128 escolhe o subconjunto sozinho e a largura pode diferir da prévia.',
  },
  {
    saida: 'html_exato',
    item: 'Driver do Windows com o papel do tamanho da etiqueta',
    como: 'Cadastrar no driver o papel exato do rolo e imprimir em "tamanho real": alguns drivers impõem margem mínima e encolhem a página.',
  },
  {
    saida: 'pdf',
    item: 'Leitor de PDF em "tamanho real"',
    como: 'Imprimir pelo leitor com "tamanho real" (sem "ajustar") e medir a etiqueta com régua.',
  },
];
