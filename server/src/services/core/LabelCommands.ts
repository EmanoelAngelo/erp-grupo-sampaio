/**
 * ============================================================================
 * AS SAÍDAS DA ETIQUETA — ZPL, EPL, TSPL, PDF e SVG a partir das MESMAS caixas
 * ============================================================================
 *
 * Cada função aqui só TRADUZ o que `LabelLayout.ts` decidiu: a posição, o
 * tamanho e o módulo das barras de cada elemento, em pontos da impressora.
 * Nenhuma delas decide geometria — é isso que faz a prévia (SVG) mostrar a
 * mesma coisa que a térmica imprime, ponto por ponto.
 *
 * ## O que NÃO se promete aqui
 *
 * Os comandos seguem os manuais das linguagens (ZPL II, EPL2, TSPL/TSPL2).
 * Firmware, fonte residente, sensor e cortador variam por modelo: o que cada
 * saída precisa conferir numa impressora de verdade está em
 * `HOMOLOGACAO_FISICA` (LabelProfiles.ts), e a tela mostra essa lista. Nada
 * aqui foi homologado em papel.
 *
 * Módulo puro: nada de banco, nada de HTTP.
 */
import { paginaMm, type LabelFormat } from './LabelFormats.js';
import {
  caixaNaEtiqueta,
  caixasDasLinhas,
  larguraEmEm,
  metricaResidente,
  xDaLinha,
  type BarrasNoLayout,
  type CelulaDaPagina,
  type ElementoDoLayout,
  type EtiquetaNoLayout,
  type MetricaDaFonte,
  type PaginaDaImpressao,
  type TextoNoLayout,
  type TracoNoLayout,
} from './LabelLayout.js';

export interface TrabalhoDeImpressao {
  formato: LabelFormat;
  /** As etiquetas DISTINTAS (uma por item); as células das páginas apontam para elas. */
  etiquetas: EtiquetaNoLayout[];
  paginas: PaginaDaImpressao[];
}

export interface SaidaDeComandos {
  comandos: string;
  avisos: string[];
}

interface Caixa {
  x: number;
  y: number;
  largura: number;
  altura: number;
}

// ------------------------------------------------------------------ comuns

/**
 * Páginas IGUAIS em sequência viram UM formato com quantidade: 30 etiquetas
 * do mesmo produto num rolo de uma coluna são um formato impresso 30 vezes,
 * e não 30 formatos iguais atravessando o cabo.
 */
export function corridasDePaginas(paginas: readonly PaginaDaImpressao[]): { pagina: PaginaDaImpressao; quantidade: number }[] {
  const out: { pagina: PaginaDaImpressao; quantidade: number }[] = [];
  let anterior = '';
  for (const p of paginas) {
    const assinatura = JSON.stringify(p.celulas);
    if (out.length > 0 && assinatura === anterior) out[out.length - 1].quantidade += 1;
    else {
      out.push({ pagina: p, quantidade: 1 });
      anterior = assinatura;
    }
  }
  return out;
}

/** Corte só no fim do lote: a última página sai sozinha, e só ela recebe o corte. */
function comUltimaSeparada(cs: { pagina: PaginaDaImpressao; quantidade: number }[]) {
  const out = cs.map((c) => ({ ...c }));
  const ultima = out[out.length - 1];
  if (ultima && ultima.quantidade > 1) {
    ultima.quantidade -= 1;
    out.push({ pagina: ultima.pagina, quantidade: 1 });
  }
  return out;
}

/** A caixa de conteúdo `c` de uma etiqueta, na PÁGINA (pontos), depois do giro. */
function naPagina(etq: EtiquetaNoLayout, celula: CelulaDaPagina, c: Caixa): Caixa {
  const b = caixaNaEtiqueta(etq, c);
  return { x: Math.round(celula.x + b.x), y: Math.round(celula.y + b.y), largura: Math.round(b.largura), altura: Math.round(b.altura) };
}

/** Só as barras (sem as zonas de silêncio), no espaço do conteúdo. */
function caixaDasBarras(b: BarrasNoLayout): Caixa {
  return { x: b.x + b.silencioEsquerda * b.modulo, y: b.y, largura: b.bits.length * b.modulo, altura: b.altura };
}

/** Os dados que a impressora recebe: EAN/UPC SEM o verificador (ela o calcula e confere). */
function dadosSemVerificador(b: BarrasNoLayout): string {
  if (b.simbologia === 'EAN-13') return b.dados.slice(0, 12);
  if (b.simbologia === 'EAN-8') return b.dados.slice(0, 7);
  if (b.simbologia === 'UPC-A') return b.dados.slice(0, 11);
  return b.dados;
}

const limitar = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)));
const mmTexto = (n: number) => String(Math.round(n * 100) / 100);

function vaoDoRolo(f: LabelFormat, linguagem: string, avisos: string[]): number {
  if ((f.sensor ?? 'vao') === 'continua') return 0;
  if (f.vaoDoRoloMm === null || f.vaoDoRoloMm === undefined) {
    avisos.push(
      `${linguagem}: o vão entre as etiquetas do rolo não foi informado no modelo — saiu 2 mm, o mais comum. `
        + 'Meça o rolo e informe no modelo, ou a impressora pode pular ou cortar etiqueta.',
    );
    return 2;
  }
  return f.vaoDoRoloMm;
}

// --------------------------------------------------------------------- ZPL

/** `^ ~ _` são comando e escape no ZPL: dentro do campo viram hexadecimal (com `^FH`). */
export function escaparZpl(t: string): string {
  return t.replace(/[_^~]/g, (c) => `_${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Code 128 no ZPL com o SUBCONJUNTO dito, e não "automático": o desenho da
 * prévia usa o subconjunto C para dígitos (e B para o último, quando ímpar) ou
 * B para texto — a impressora tem de fazer o mesmo, senão a largura do código
 * no papel não é a da prévia. `>;` inicia C, `>:` inicia B, `>6` troca para B,
 * e o `>` do texto vira `><`.
 */
export function code128Zpl(texto: string): string {
  const esc = (s: string) => s.replace(/>/g, '><');
  if (/^\d{2,}$/.test(texto)) {
    const par = texto.length % 2 === 0 ? texto : texto.slice(0, -1);
    return par.length === texto.length ? `>;${par}` : `>;${par}>6${esc(texto.slice(-1))}`;
  }
  return `>:${esc(texto)}`;
}

function barrasZpl(b: BarrasNoLayout, orientacao: 'N' | 'R', h: number): string {
  if (b.simbologia === 'EAN-13') return `^BE${orientacao},${h},N,N^FD${dadosSemVerificador(b)}^FS`;
  if (b.simbologia === 'EAN-8') return `^B8${orientacao},${h},N,N^FD${dadosSemVerificador(b)}^FS`;
  if (b.simbologia === 'UPC-A') return `^BU${orientacao},${h},N,N,N^FD${dadosSemVerificador(b)}^FS`;
  return `^BC${orientacao},${h},N,N,N,N^FH^FD${escaparZpl(code128Zpl(b.dados))}^FS`;
}

/**
 * ZPL II (Zebra e compatíveis). Uma página (a linha do rolo) é um formato
 * `^XA…^XZ`; páginas iguais em sequência saem com `^PQ`.
 *
 *   - `^CI28`: texto em UTF-8 (acentos do português);
 *   - `^PW`/`^LL`: largura e comprimento da página em pontos;
 *   - `^MN`: sensor — Y (vão), M (marca preta), N (contínuo);
 *   - `^MM`: T (destacar) ou C (cortador);
 *   - `~SD`: escurecimento 0–30; `^PR`: velocidade;
 *   - texto em `^A0` (fonte escalável residente) com `^FB` de uma linha, que
 *     alinha à direita/centro NA impressora, com a letra dela;
 *   - barras com `^BY` (módulo em pontos) e sem linha de interpretação (o
 *     número é um texto nosso, onde o layout mandou).
 */
export function gerarZpl(t: TrabalhoDeImpressao): SaidaDeComandos {
  const f = t.formato;
  const avisos: string[] = [];
  const corte = f.corte ?? 'nenhum';
  const sensor = f.sensor ?? 'vao';
  let cs = corridasDePaginas(t.paginas);
  if (corte === 'fim_do_lote') cs = comUltimaSeparada(cs);
  const linhas: string[] = [];
  if (f.densidade !== null && f.densidade !== undefined) linhas.push(`~SD${String(limitar(f.densidade, 0, 30)).padStart(2, '0')}`);
  cs.forEach((c, i) => {
    const ultima = i === cs.length - 1;
    linhas.push(
      '^XA',
      '^CI28',
      `^PW${c.pagina.largura}`,
      `^LL${c.pagina.altura}`,
      '^LH0,0',
      `^MN${sensor === 'marca' ? 'M' : sensor === 'continua' ? 'N' : 'Y'}`,
      `^MM${corte === 'cada_etiqueta' || (corte === 'fim_do_lote' && ultima) ? 'C' : 'T'}`,
    );
    if (f.velocidade) linhas.push(`^PR${limitar(f.velocidade, 1, 14)}`);
    for (const celula of c.pagina.celulas) {
      if (celula.etiqueta === null) continue;
      const etq = t.etiquetas[celula.etiqueta];
      const o = etq.rotacao === 90 ? 'R' : 'N';
      for (const el of etq.elementos) {
        if (el.tipo === 'texto') {
          const j = el.alinhamento === 'direita' ? 'R' : el.alinhamento === 'centro' ? 'C' : 'L';
          caixasDasLinhas(el).forEach((linha, k) => {
            const b = naPagina(etq, celula, linha);
            linhas.push(`^FO${b.x},${b.y}^A0${o},${el.corpo},${el.corpo}^FB${Math.round(el.largura)},1,0,${j}^FH^FD${escaparZpl(el.linhas[k])}^FS`);
          });
        } else if (el.tipo === 'barras') {
          const b = naPagina(etq, celula, caixaDasBarras(el));
          linhas.push(`^FO${b.x},${b.y}^BY${el.modulo},2,${el.altura}${barrasZpl(el, o, el.altura)}`);
        } else {
          const b = naPagina(etq, celula, el);
          const esp = el.campo === 'risco' ? Math.min(b.largura, b.altura) : el.espessura;
          linhas.push(`^FO${b.x},${b.y}^GB${b.largura},${b.altura},${esp},B,0^FS`);
        }
      }
    }
    linhas.push(`^PQ${c.quantidade},0,1,Y`, '^XZ');
  });
  if ((f.avancoFinalMm ?? 0) > 0) {
    avisos.push('ZPL: o avanço de papel ao fim do lote não tem comando equivalente e foi ignorado — ajuste a posição de destaque na impressora.');
  }
  return { comandos: `${linhas.join('\n')}\n`, avisos };
}

// -------------------------------------------------------------------- TSPL

/** A fonte "0" do TSPL recebe o corpo em PONTOS TIPOGRÁFICOS inteiros: o layout mede no corpo que ela vai usar. */
export function metricaTspl(dpi: number): MetricaDaFonte {
  const base = metricaResidente(1.1);
  return {
    nome: 'tspl-0',
    corpo: (pedido) => Math.max(1, Math.floor((Math.max(1, Math.floor((pedido * 72) / dpi)) * dpi) / 72)),
    largura: base.largura,
  };
}

/** Aspas dentro do texto TSPL: `\["]`. */
export function escaparTspl(t: string): string {
  return t.replace(/"/g, '\\["]');
}

/** Code 128 manual (`128M`) com o subconjunto dito — a mesma escolha da prévia. */
function code128Tspl(texto: string): string | null {
  if (/^\d{2,}$/.test(texto)) {
    const par = texto.length % 2 === 0 ? texto : texto.slice(0, -1);
    return par.length === texto.length ? `!105${par}` : `!105${par}!100${texto.slice(-1)}`;
  }
  // "!" é o prefixo de controle do 128M: com ele no texto, o modo automático.
  if (texto.includes('!')) return null;
  return `!104${texto}`;
}

/**
 * Onde a TSPL e a EPL giram: em torno do PONTO de referência (o canto de cima
 * à esquerda do campo SEM giro). A 90° no sentido horário, o campo desce a
 * partir dele e ocupa a faixa à ESQUERDA do ponto — então o ponto é a borda
 * direita da caixa.
 */
function pontoDeReferencia(b: Caixa, rotacao: 0 | 90): { x: number; y: number } {
  return rotacao === 90 ? { x: b.x + b.largura, y: b.y } : { x: b.x, y: b.y };
}

/**
 * TSPL/TSPL2 (TSC e compatíveis). `SIZE` é a página (a linha do rolo), `GAP`
 * ou `BLINE` diz o sensor, `DENSITY` 0–15, `SPEED` em pol/s, `SET CUTTER`
 * OFF / 1 (cada etiqueta) / BATCH (fim do lote). Texto na fonte escalável "0"
 * com o corpo em pontos tipográficos; barras com o módulo em pontos.
 * Linhas terminam em CRLF, como o manual pede.
 */
export function gerarTspl(t: TrabalhoDeImpressao): SaidaDeComandos {
  const f = t.formato;
  const avisos: string[] = [];
  const sensor = f.sensor ?? 'vao';
  const corte = f.corte ?? 'nenhum';
  const primeira = t.paginas[0];
  const dpi = t.etiquetas[0]?.dpi ?? f.dpi ?? 203;
  const linhas: string[] = [];
  if (primeira) {
    // O papel em milímetro exato (50 × 30), e não o dos pontos arredondados (50,04 × 30,03).
    const papel = paginaMm(f);
    linhas.push(`SIZE ${mmTexto(papel.largura)} mm,${mmTexto(papel.altura)} mm`);
  }
  const vao = vaoDoRolo(f, 'TSPL', avisos);
  linhas.push(sensor === 'marca' ? `BLINE ${mmTexto(vao)} mm,0 mm` : `GAP ${mmTexto(vao)} mm,0 mm`);
  linhas.push('DIRECTION 0,0', 'REFERENCE 0,0', 'OFFSET 0 mm');
  linhas.push(corte === 'nenhum' ? 'SET TEAR ON' : 'SET TEAR OFF');
  linhas.push(`SET CUTTER ${corte === 'cada_etiqueta' ? '1' : corte === 'fim_do_lote' ? 'BATCH' : 'OFF'}`);
  if (f.densidade !== null && f.densidade !== undefined) linhas.push(`DENSITY ${limitar(f.densidade / 2, 0, 15)}`);
  if (f.velocidade) linhas.push(`SPEED ${limitar(f.velocidade, 1, 14)}`);
  linhas.push('CODEPAGE UTF-8');
  let automatico = false;
  for (const c of corridasDePaginas(t.paginas)) {
    linhas.push('CLS');
    for (const celula of c.pagina.celulas) {
      if (celula.etiqueta === null) continue;
      const etq = t.etiquetas[celula.etiqueta];
      for (const el of etq.elementos) {
        if (el.tipo === 'texto') {
          const pt = Math.max(1, Math.round((el.corpo * 72) / etq.dpi));
          caixasDasLinhas(el).forEach((linha, k) => {
            const b = naPagina(etq, celula, { ...linha, x: Math.round(xDaLinha(el, k)), largura: Math.ceil(el.larguras[k] ?? 0) });
            const p = pontoDeReferencia(b, etq.rotacao);
            linhas.push(`TEXT ${p.x},${p.y},"0",${etq.rotacao},${pt},${pt},"${escaparTspl(el.linhas[k])}"`);
          });
        } else if (el.tipo === 'barras') {
          const b = naPagina(etq, celula, caixaDasBarras(el));
          const p = pontoDeReferencia(b, etq.rotacao);
          let tipo = el.simbologia === 'EAN-13' ? 'EAN13' : el.simbologia === 'EAN-8' ? 'EAN8' : el.simbologia === 'UPC-A' ? 'UPCA' : '128M';
          let dados = dadosSemVerificador(el);
          if (tipo === '128M') {
            const manual = code128Tspl(el.dados);
            if (manual === null) {
              tipo = '128';
              automatico = true;
            } else dados = manual;
          }
          linhas.push(`BARCODE ${p.x},${p.y},"${tipo}",${el.altura},0,${etq.rotacao},${el.modulo},${el.modulo},"${escaparTspl(dados)}"`);
        } else {
          const b = naPagina(etq, celula, el);
          if (el.campo === 'risco') linhas.push(`BAR ${b.x},${b.y},${b.largura},${b.altura}`);
          else linhas.push(`BOX ${b.x},${b.y},${b.x + b.largura},${b.y + b.altura},${el.espessura}`);
        }
      }
    }
    linhas.push(`PRINT 1,${c.quantidade}`);
  }
  if ((f.avancoFinalMm ?? 0) > 0) linhas.push(`FEED ${Math.round(((f.avancoFinalMm ?? 0) * dpi) / 25.4)}`);
  if (automatico) {
    avisos.push('TSPL: um código com "!" saiu no Code 128 automático — a largura no papel pode diferir da prévia.');
  }
  return { comandos: `${linhas.join('\r\n')}\r\n`, avisos };
}

// --------------------------------------------------------------------- EPL

/**
 * As fontes de mapa de bits da EPL2 (tamanho fixo, passo fixo). A 203 dpi,
 * pelo manual: 1 = 8×12, 2 = 10×16, 3 = 12×20, 4 = 14×24 pontos, com o passo
 * (caractere + espaço) de 10, 12, 14 e 16. A 300 dpi a tabela é outra e é
 * item de homologação.
 */
const FONTES_EPL: Record<number, { id: string; altura: number; passo: number }[]> = {
  203: [
    { id: '1', altura: 12, passo: 10 },
    { id: '2', altura: 16, passo: 12 },
    { id: '3', altura: 20, passo: 14 },
    { id: '4', altura: 24, passo: 16 },
  ],
  300: [
    { id: '1', altura: 20, passo: 14 },
    { id: '2', altura: 28, passo: 18 },
    { id: '3', altura: 36, passo: 22 },
    { id: '4', altura: 44, passo: 26 },
  ],
};

interface FonteEpl {
  id: string;
  mult: number;
  altura: number;
  passo: number;
}

/** A combinação fonte × multiplicador (1–6, igual na horizontal e na vertical) mais alta que cabe no corpo. */
function fonteEpl(corpo: number, dpi: number): FonteEpl {
  const tabela = FONTES_EPL[dpi >= 300 ? 300 : 203];
  let melhor: FonteEpl = { ...tabela[0], mult: 1 };
  for (const fonte of tabela) {
    for (let m = 1; m <= 6; m += 1) {
      const h = fonte.altura * m;
      if (h <= corpo && h > melhor.altura * melhor.mult) melhor = { ...fonte, mult: m };
    }
  }
  return melhor;
}

/** A medida da EPL: passo fixo, exata. O corpo possível é o de uma das combinações. */
export function metricaEpl(dpi: number): MetricaDaFonte {
  return {
    nome: `epl-${dpi >= 300 ? 300 : 203}`,
    corpo: (pedido) => {
      const f = fonteEpl(pedido, dpi);
      return f.altura * f.mult;
    },
    largura: (texto, corpo) => {
      const f = fonteEpl(corpo, dpi);
      return [...texto].length * f.passo * f.mult;
    },
  };
}

/** Aspas e barra invertida dentro do texto EPL. */
export function escaparEpl(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Velocidade em pol/s → o código da EPL (tabela da LP 2844: 1 = 1,5; 2 = 2; 3 = 2,5; 4 = 3,5). */
function velocidadeEpl(ips: number): number {
  if (ips <= 1.5) return 1;
  if (ips <= 2) return 2;
  if (ips <= 2.5) return 3;
  return 4;
}

/**
 * EPL2 (Zebra/Eltron antigas: LP 2844, TLP 2844). `q` largura, `Q`
 * comprimento e vão (ou `B` para marca preta), `S` velocidade, `D`
 * densidade 0–15, `I8,A` página de código Windows-1252 (o arquivo sai em
 * 1252). Cada página: `N` (limpa), os campos, `P` com a quantidade.
 */
export function gerarEpl(t: TrabalhoDeImpressao): SaidaDeComandos {
  const f = t.formato;
  const avisos: string[] = [];
  const primeira = t.paginas[0];
  const dpi = t.etiquetas[0]?.dpi ?? f.dpi ?? 203;
  if (dpi !== 203) {
    avisos.push(`EPL a ${dpi} dpi: a tabela das fontes da impressora precisa ser conferida em papel (a EPL2 é quase sempre de 203 dpi).`);
  }
  const sensor = f.sensor ?? 'vao';
  const vao = Math.round((vaoDoRolo(f, 'EPL', avisos) * dpi) / 25.4);
  const linhas: string[] = ['', 'N'];
  if (primeira) {
    linhas.push(`q${primeira.largura}`);
    linhas.push(sensor === 'continua' ? `Q${primeira.altura},0` : sensor === 'marca' ? `Q${primeira.altura},B${vao}` : `Q${primeira.altura},${vao}`);
  }
  if (f.velocidade) linhas.push(`S${velocidadeEpl(f.velocidade)}`);
  if (f.densidade !== null && f.densidade !== undefined) linhas.push(`D${limitar(f.densidade / 2, 0, 15)}`);
  linhas.push('ZT', 'I8,A,001');
  const corte = f.corte ?? 'nenhum';
  if (corte === 'cada_etiqueta') linhas.push('OC');
  if (corte === 'fim_do_lote') {
    avisos.push('EPL: o corte só no fim do lote não é suportado por esta saída — as etiquetas saem sem corte. Use TSPL ou ZPL, ou corte a cada etiqueta.');
  }
  let temCode128 = false;
  for (const c of corridasDePaginas(t.paginas)) {
    linhas.push('N');
    for (const celula of c.pagina.celulas) {
      if (celula.etiqueta === null) continue;
      const etq = t.etiquetas[celula.etiqueta];
      const rot = etq.rotacao === 90 ? 1 : 0;
      for (const el of etq.elementos) {
        if (el.tipo === 'texto') {
          const fonte = fonteEpl(el.corpo, etq.dpi);
          caixasDasLinhas(el).forEach((linha, k) => {
            const b = naPagina(etq, celula, { ...linha, x: Math.round(xDaLinha(el, k)), largura: Math.ceil(el.larguras[k] ?? 0) });
            const p = pontoDeReferencia(b, etq.rotacao);
            linhas.push(`A${p.x},${p.y},${rot},${fonte.id},${fonte.mult},${fonte.mult},N,"${escaparEpl(el.linhas[k])}"`);
          });
        } else if (el.tipo === 'barras') {
          const b = naPagina(etq, celula, caixaDasBarras(el));
          const p = pontoDeReferencia(b, etq.rotacao);
          const tipo = el.simbologia === 'EAN-13' ? 'E30' : el.simbologia === 'EAN-8' ? 'E80' : el.simbologia === 'UPC-A' ? 'UA0' : '1';
          if (tipo === '1') temCode128 = true;
          // O quinto e o sexto parâmetros são a barra estreita e a larga; EAN/UPC e Code 128 são por módulo, então os dois são o módulo.
          linhas.push(`B${p.x},${p.y},${rot},${tipo},${el.modulo},${el.modulo},${el.altura},N,"${escaparEpl(dadosSemVerificador(el))}"`);
        } else {
          const b = naPagina(etq, celula, el);
          if (el.campo === 'risco') linhas.push(`LO${b.x},${b.y},${b.largura},${b.altura}`);
          else linhas.push(`X${b.x},${b.y},${el.espessura},${b.x + b.largura},${b.y + b.altura}`);
        }
      }
    }
    linhas.push(`P${c.quantidade}`);
  }
  if (temCode128) {
    avisos.push('EPL: o Code 128 da EPL escolhe o subconjunto sozinho — a largura do código no papel pode diferir da prévia.');
  }
  if ((f.avancoFinalMm ?? 0) > 0) avisos.push('EPL: o avanço de papel ao fim do lote não tem comando equivalente e foi ignorado.');
  return { comandos: `${linhas.join('\r\n')}\r\n`, avisos };
}

/** O texto EPL em bytes Windows-1252 (o `I8,A` do cabeçalho): fora do Latin-1, "?". */
export function bytesWindows1252(texto: string): Buffer {
  const bytes: number[] = [];
  for (const c of texto) {
    const cp = c.codePointAt(0) ?? 63;
    bytes.push(cp <= 0xff ? cp : (WIN1252_EXTRAS[cp] ?? 63));
  }
  return Buffer.from(bytes);
}
const WIN1252_EXTRAS: Record<number, number> = {
  0x20ac: 0x80, 0x2026: 0x85, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
};

// --------------------------------------------------------------- SVG / HTML

function escXml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Barras contíguas viram UM retângulo (sem fresta), em pontos, no espaço do conteúdo. */
function retangulosDasBarras(b: BarrasNoLayout): Caixa[] {
  const out: Caixa[] = [];
  const x0 = b.x + b.silencioEsquerda * b.modulo;
  let inicio = -1;
  for (let i = 0; i <= b.bits.length; i += 1) {
    const barra = i < b.bits.length && b.bits[i] === '1';
    if (barra && inicio < 0) inicio = i;
    if (!barra && inicio >= 0) {
      out.push({ x: x0 + inicio * b.modulo, y: b.y, largura: (i - inicio) * b.modulo, altura: b.altura });
      inicio = -1;
    }
  }
  return out;
}

function elementoSvg(el: ElementoDoLayout): string {
  if (el.tipo === 'texto') return textoSvg(el);
  if (el.tipo === 'barras') {
    return `<g fill="#000" data-campo="barras" data-modulo="${el.modulo}" data-simbologia="${el.simbologia}">`
      + retangulosDasBarras(el).map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.largura}" height="${r.altura}"/>`).join('')
      + '</g>';
  }
  return tracoSvg(el);
}

function textoSvg(t: TextoNoLayout): string {
  const ancora = t.alinhamento === 'direita' ? 'end' : t.alinhamento === 'centro' ? 'middle' : 'start';
  const x = t.alinhamento === 'direita' ? t.x + t.largura : t.alinhamento === 'centro' ? t.x + t.largura / 2 : t.x;
  return caixasDasLinhas(t)
    .map((linha, i) => `<text data-campo="${t.campo}" x="${round2(x)}" y="${round2(linha.y + t.corpo * 0.8)}" font-size="${t.corpo}" `
      + `font-family="Arial, Helvetica, sans-serif"${t.negrito ? ' font-weight="bold"' : ''} text-anchor="${ancora}">${escXml(t.linhas[i])}</text>`)
    .join('');
}

function tracoSvg(c: TracoNoLayout): string {
  if (c.campo === 'risco') return `<rect data-campo="risco" x="${c.x}" y="${c.y}" width="${c.largura}" height="${c.altura}" fill="#000"/>`;
  const e = c.espessura;
  return `<rect data-campo="moldura" x="${c.x + e / 2}" y="${c.y + e / 2}" width="${c.largura - e}" height="${c.altura - e}" fill="none" stroke="#000" stroke-width="${e}"/>`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Uma página em SVG, em pontos (`viewBox`) e em milímetro (`width`/`height`):
 * impressa a 100 %, cada ponto do SVG é um ponto da impressora do modelo. As
 * posições puladas e o contorno do adesivo aparecem só na tela.
 */
export function paginaEmSvg(t: TrabalhoDeImpressao, pagina: PaginaDaImpressao, numero: number): string {
  const dpi = t.etiquetas[0]?.dpi ?? t.formato.dpi ?? 203;
  const papel = paginaMm(t.formato);
  const partes: string[] = [];
  for (const celula of pagina.celulas) {
    if (celula.etiqueta === null) {
      const Wl = Math.round((t.formato.widthMm * dpi) / 25.4);
      const Hl = Math.round((t.formato.heightMm * dpi) / 25.4);
      partes.push(`<rect class="pulada" x="${celula.x}" y="${celula.y}" width="${Wl}" height="${Hl}"/>`);
      continue;
    }
    const etq = t.etiquetas[celula.etiqueta];
    const giro = etq.rotacao === 90 ? ` transform="translate(${etq.larguraPontos} 0) rotate(90)"` : '';
    partes.push(
      `<g transform="translate(${celula.x} ${celula.y})" data-etiqueta="${celula.etiqueta}">`
        + `<rect class="contorno" x="0" y="0" width="${etq.larguraPontos}" height="${etq.alturaPontos}"/>`
        + `<g${giro}>${etq.elementos.map(elementoSvg).join('')}</g></g>`,
    );
  }
  // O papel em milímetro EXATO (50 × 30), e não o dos pontos arredondados
  // (400 pontos = 50,04 mm): é o tamanho que o diálogo e o driver conferem.
  return `<svg class="pagina" xmlns="http://www.w3.org/2000/svg" data-pagina="${numero}" `
    + `width="${mmTexto(papel.largura)}mm" height="${mmTexto(papel.altura)}mm" `
    + `viewBox="0 0 ${pagina.largura} ${pagina.altura}" preserveAspectRatio="none" shape-rendering="crispEdges">`
    + `<rect x="0" y="0" width="${pagina.largura}" height="${pagina.altura}" fill="#fff"/>${partes.join('')}</svg>`;
}

/**
 * O documento com todas as páginas em SVG — a PRÉVIA de toda saída que não é
 * a folha do navegador, e o próprio arquivo do perfil "driver" (HTML exato):
 * `@page` no tamanho da página, sem margem, uma página por SVG.
 */
export function documentoSvg(t: TrabalhoDeImpressao, titulo: string): string {
  // O papel em milímetro exato — o mesmo das páginas SVG, e não o dos pontos arredondados.
  const papel = paginaMm(t.formato);
  const tamanho = t.paginas.length > 0 ? `${mmTexto(papel.largura)}mm ${mmTexto(papel.altura)}mm` : 'auto';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escXml(titulo)}</title>
<style>
  @page { size: ${tamanho}; margin: 0; }
  body { margin: 0; }
  .pagina { display: block; page-break-after: always; break-after: page; }
  .pagina:last-child { page-break-after: auto; break-after: auto; }
  .contorno { fill: none; stroke: #bbb; stroke-dasharray: 4 4; stroke-width: 1; }
  .pulada { fill: none; stroke: #ccc; stroke-dasharray: 2 6; stroke-width: 1; }
  @media screen {
    body { background: #f4f4f5; padding: 16px; }
    .pagina { margin: 0 auto 16px; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  }
  @media print { .contorno, .pulada { display: none; } }
</style></head><body>
${t.paginas.map((pg, i) => paginaEmSvg(t, pg, i + 1)).join('\n')}
</body></html>`;
}

// --------------------------------------------------------------------- PDF

/** Bytes da WinAnsiEncoding (a das fontes padrão do PDF) para um caractere. */
function byteWinAnsi(c: string): number {
  const cp = c.codePointAt(0) ?? 63;
  if (cp >= 32 && cp <= 126) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return WIN1252_EXTRAS[cp] ?? 63;
}

/** Texto para string literal do PDF, só com ASCII (o resto em octal). */
function literalPdf(texto: string): string {
  let out = '';
  for (const c of texto) {
    const b = byteWinAnsi(c);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * O PDF da etiqueta — vetorial, sem biblioteca: Helvetica e Helvetica-Bold
 * (as fontes padrão de todo leitor de PDF, na mesma métrica que o layout
 * usou), as barras como retângulos cheios. Cada etiqueta distinta é UM
 * XObject de formulário, e as páginas só o posicionam: 3 000 etiquetas de dez
 * produtos são dez desenhos, não 3 000.
 *
 * Impresso a 100 % ("tamanho real"), cada milímetro do PDF é um milímetro do
 * papel. É para folha A4/Carta e para quem quer guardar o arquivo; a térmica
 * imprime melhor pela linguagem dela.
 */
export function gerarPdf(t: TrabalhoDeImpressao): Buffer {
  const dpi = t.etiquetas[0]?.dpi ?? t.formato.dpi ?? 203;
  const pt = (pontos: number) => (pontos * 72) / dpi;
  const objetos: string[] = [];
  const reservar = () => {
    objetos.push('');
    return objetos.length;
  };
  const definir = (n: number, corpo: string) => {
    objetos[n - 1] = corpo;
  };
  const stream = (dict: string, conteudo: string) => `<< ${dict} /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`;

  const catalogo = reservar();
  const raizDasPaginas = reservar();
  const f1 = reservar();
  const f2 = reservar();
  definir(f1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  definir(f2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  // Uma forma por etiqueta distinta, desenhada no espaço do CONTEÚDO com y para cima.
  const formas = t.etiquetas.map((etq) => {
    const H = etq.alturaDoConteudo;
    const y = (topo: number, altura: number) => pt(H - topo - altura);
    const ops: string[] = [];
    for (const el of etq.elementos) {
      if (el.tipo === 'texto') {
        caixasDasLinhas(el).forEach((linha, i) => {
          const x = xDaLinha(el, i);
          const base = pt(H - (linha.y + el.corpo * 0.8));
          ops.push(`BT /${el.negrito ? 'F2' : 'F1'} ${n3(pt(el.corpo))} Tf ${n3(pt(x))} ${n3(base)} Td ${literalPdf(el.linhas[i])} Tj ET`);
        });
      } else if (el.tipo === 'barras') {
        for (const r of retangulosDasBarras(el)) ops.push(`${n3(pt(r.x))} ${n3(y(r.y, r.altura))} ${n3(pt(r.largura))} ${n3(pt(r.altura))} re`);
        ops.push('f');
      } else if (el.campo === 'risco') {
        ops.push(`${n3(pt(el.x))} ${n3(y(el.y, el.altura))} ${n3(pt(el.largura))} ${n3(pt(el.altura))} re f`);
      } else {
        const e = el.espessura;
        ops.push(`${n3(pt(e))} w ${n3(pt(el.x + e / 2))} ${n3(y(el.y + e / 2, el.altura - e))} ${n3(pt(el.largura - e))} ${n3(pt(el.altura - e))} re S`);
      }
    }
    const n = reservar();
    definir(
      n,
      stream(
        `/Type /XObject /Subtype /Form /BBox [0 0 ${n3(pt(etq.larguraDoConteudo))} ${n3(pt(H))}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >>`,
        `0 g\n${ops.join('\n')}`,
      ),
    );
    return n;
  });

  const paginas: number[] = [];
  // A página do PDF é o papel em milímetro exato (50 × 30 mm = 141,732 × 85,039 pt),
  // e não o dos pontos arredondados; as posições dentro dela seguem em pontos.
  const papel = paginaMm(t.formato);
  const Wp = (papel.largura * 72) / 25.4;
  for (const pagina of t.paginas) {
    const Hp = (papel.altura * 72) / 25.4;
    const ops: string[] = [];
    const usadas = new Set<number>();
    for (const celula of pagina.celulas) {
      if (celula.etiqueta === null) continue;
      const etq = t.etiquetas[celula.etiqueta];
      usadas.add(celula.etiqueta);
      // Retrato: só desloca. Paisagem: o conteúdo gira 90° horário (x da página = y do conteúdo).
      const matriz = etq.rotacao === 90
        ? `0 -1 1 0 ${n3(pt(celula.x))} ${n3(Hp - pt(celula.y))}`
        : `1 0 0 1 ${n3(pt(celula.x))} ${n3(Hp - pt(celula.y) - pt(etq.alturaPontos))}`;
      ops.push(`q ${matriz} cm /E${celula.etiqueta} Do Q`);
    }
    const conteudo = reservar();
    definir(conteudo, stream('', ops.join('\n')));
    const n = reservar();
    const recursos = [...usadas].map((i) => `/E${i} ${formas[i]} 0 R`).join(' ');
    definir(
      n,
      `<< /Type /Page /Parent ${raizDasPaginas} 0 R /MediaBox [0 0 ${n3(Wp)} ${n3(Hp)}] `
        + `/Resources << /XObject << ${recursos} >> >> /Contents ${conteudo} 0 R >>`,
    );
    paginas.push(n);
  }
  definir(raizDasPaginas, `<< /Type /Pages /Kids [${paginas.map((p) => `${p} 0 R`).join(' ')}] /Count ${paginas.length} >>`);
  definir(catalogo, `<< /Type /Catalog /Pages ${raizDasPaginas} 0 R >>`);

  let corpo = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const deslocamentos: number[] = [];
  objetos.forEach((o, i) => {
    deslocamentos.push(Buffer.byteLength(corpo, 'latin1'));
    corpo += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(corpo, 'latin1');
  corpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const d of deslocamentos) corpo += `${String(d).padStart(10, '0')} 00000 n \n`;
  corpo += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(corpo, 'latin1');
}

/** Largura (em em) — reexportada para os testes conferirem a métrica do PDF. */
export const larguraHelveticaEmEm = larguraEmEm;
