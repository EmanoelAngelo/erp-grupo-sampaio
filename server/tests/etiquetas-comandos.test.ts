/**
 * ============================================================================
 * AS SAÍDAS DA ETIQUETA — ZPL, EPL, TSPL, PDF e a prévia, do MESMO layout
 * ============================================================================
 *
 * Funções puras (`LabelCommands.ts`): o texto do comando é conferido linha a
 * linha. O que se prova aqui é que cada gerador TRADUZ as caixas do layout —
 * mesma posição, mesmo módulo, mesma quantidade — e escapa o que a linguagem
 * trata como comando. O que só o papel prova está em `HOMOLOGACAO_FISICA`.
 */
import { describe, expect, it } from 'vitest';
import type { LabelItem } from '../src/services/core/BarcodeService.js';
import { findLabelFormat, type LabelFormat } from '../src/services/core/LabelFormats.js';
import {
  layoutDaEtiqueta,
  metricaResidente,
  paginarEtiquetas,
  type BarrasNoLayout,
  type MetricaDaFonte,
} from '../src/services/core/LabelLayout.js';
import {
  bytesWindows1252,
  code128Zpl,
  documentoSvg,
  escaparZpl,
  gerarEpl,
  gerarPdf,
  gerarTspl,
  gerarZpl,
  metricaEpl,
  metricaTspl,
  type TrabalhoDeImpressao,
} from '../src/services/core/LabelCommands.js';
import { HOMOLOGACAO_FISICA, PERFIS_DE_IMPRESSAO } from '../src/services/core/LabelProfiles.js';

function item(nome: string, extra: Partial<LabelItem> = {}): LabelItem {
  return {
    productId: nome, name: nome, internalCode: 'GS-1', barcode: '7891234567895', priceCents: 1990, listPriceCents: 1990,
    onSale: false, quantity: 1, attributes: '', brand: '', unit: '', sku: '', shortDescription: '', ...extra,
  };
}

function formato(id: string, extra: Partial<LabelFormat> = {}): LabelFormat {
  return { ...findLabelFormat(id)!, ...extra };
}

function trabalho(f: LabelFormat, itens: LabelItem[], opcoes: { comecarEm?: number; metrica?: MetricaDaFonte; reticencias?: string } = {}): TrabalhoDeImpressao {
  return {
    formato: f,
    etiquetas: itens.map((i) => layoutDaEtiqueta(f, i, { empresa: 'Preço Justo', metrica: opcoes.metrica, reticencias: opcoes.reticencias })),
    paginas: paginarEtiquetas(f, itens.map((i) => i.quantity), opcoes.comecarEm ?? 1).paginas,
  };
}

const soma = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const numeros = (texto: string, re: RegExp) => [...texto.matchAll(re)].map((m) => Number(m[1]));

const LOTE = [item('Arroz', { quantity: 2 }), item('Feijão', { quantity: 1 }), item('Café', { quantity: 3 })];

// --------------------------------------------------------------------- ZPL

describe('ZPL', () => {
  it('página do rolo 50 × 30 a 203 dpi: ^PW400 ^LL240, UTF-8, sensor de vão, destacar', () => {
    const { comandos } = gerarZpl(trabalho(formato('rolo_50x30'), [item('Arroz')]));
    expect(comandos).toContain('^XA\n^CI28\n^PW400\n^LL240\n^LH0,0\n^MNY\n^MMT\n');
    expect(comandos.trim().endsWith('^XZ')).toBe(true);
  });

  it('EAN-13 sai com os 12 dígitos (a impressora calcula o verificador), sem linha de interpretação, com o módulo do layout', () => {
    const t = trabalho(formato('rolo_50x30'), [item('Arroz')]);
    const b = t.etiquetas[0].elementos.find((e) => e.tipo === 'barras') as BarrasNoLayout;
    const { comandos } = gerarZpl(t);
    expect(comandos).toContain(`^BY${b.modulo},2,${b.altura}^BEN,${b.altura},N,N^FD789123456789^FS`);
  });

  it('o lote (2, 1, 3): páginas iguais em sequência viram UM formato com ^PQ, e a soma é 6', () => {
    const { comandos } = gerarZpl(trabalho(formato('rolo_50x30'), LOTE));
    expect(numeros(comandos, /\^PQ(\d+),/g)).toEqual([2, 1, 3]);
    expect(comandos.match(/\^XA/g)).toHaveLength(3);
  });

  it('rolo de 2 colunas com o lote (2, 1, 3): 3 linhas de papel, cada uma com as etiquetas dela', () => {
    const { comandos } = gerarZpl(trabalho(formato('rolo_100x30_2'), LOTE));
    const formatos = comandos.split('^XZ').filter((s) => s.includes('^XA'));
    expect(formatos).toHaveLength(3);
    expect(soma(numeros(comandos, /\^PQ(\d+),/g))).toBe(3);
    // Duas colunas: o preço (campo de ^FB alinhado à direita) aparece duas vezes por formato.
    for (const fmt of formatos) expect(fmt.match(/\^FB\d+,1,0,R/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('posição inicial 2 no rolo de 2 colunas: a primeira linha só tem campos na coluna da DIREITA', () => {
    const f = formato('rolo_100x30_2');
    const { comandos } = gerarZpl(trabalho(f, [item('Arroz')], { comecarEm: 2 }));
    const xs = numeros(comandos, /\^FO(\d+),/g);
    const inicioDaSegunda = Math.round(((f.widthMm + f.gapXmm) * 203) / 25.4);
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(inicioDaSegunda);
  });

  it('escapa ^, ~ e _ do texto (em hexadecimal, com ^FH) — um nome não vira comando', () => {
    expect(escaparZpl('Sabão ^XZ ~JA a_b')).toBe('Sabão _5EXZ _7EJA a_5Fb');
    const { comandos } = gerarZpl(trabalho(formato('rolo_60x40'), [item('Sabão ^XZ ~JA')]));
    expect(comandos).not.toMatch(/\^FD[^\n]*\^XZ ~JA/);
    expect(comandos).toContain('_5EXZ _7EJA');
  });

  it('Code 128 com o subconjunto dito: C para dígitos, B para o último ímpar, B para texto, e o ">" dobrado', () => {
    expect(code128Zpl('12345678')).toBe('>;12345678');
    expect(code128Zpl('1234567')).toBe('>;123456>67');
    expect(code128Zpl('PJ-ABC>1')).toBe('>:PJ-ABC><1');
    const { comandos } = gerarZpl(trabalho(formato('rolo_60x40'), [item('Peça', { barcode: 'PJ-ABC-001' })]));
    expect(comandos).toContain('^BCN,');
    expect(comandos).toContain('^FH^FD>:PJ-ABC-001^FS');
  });

  it('densidade, velocidade, sensor e corte vêm do modelo', () => {
    const base = { densidade: 15, velocidade: 4 } as Partial<LabelFormat>;
    const cada = gerarZpl(trabalho(formato('rolo_50x30', { ...base, corte: 'cada_etiqueta', sensor: 'marca' }), LOTE)).comandos;
    expect(cada.startsWith('~SD15\n')).toBe(true);
    expect(cada).toContain('^PR4');
    expect(cada).toContain('^MNM');
    expect(cada.match(/\^MMC/g)).toHaveLength(3);
    expect(cada).not.toContain('^MMT');

    // Corte só no fim do lote: a última etiqueta sai sozinha, e só ela com o cortador.
    const fim = gerarZpl(trabalho(formato('rolo_50x30', { corte: 'fim_do_lote', sensor: 'continua' }), LOTE)).comandos;
    expect(fim).toContain('^MNN');
    expect(numeros(fim, /\^PQ(\d+),/g)).toEqual([2, 1, 2, 1]);
    expect(fim.match(/\^MMC/g)).toHaveLength(1);
    const ultimo = fim.split('^XA').pop()!;
    expect(ultimo).toContain('^MMC');
  });

  it('paisagem: texto em ^A0R e barras em ^BER', () => {
    const { comandos } = gerarZpl(trabalho(formato('rolo_60x40', { orientation: 'paisagem' }), [item('Arroz')]));
    expect(comandos).toContain('^A0R,');
    expect(comandos).toContain('^BER,');
    expect(comandos).not.toContain('^A0N,');
  });
});

// ------------------------------------------------------------ fidelidade

describe('a prévia tem a mesma geometria do comando', () => {
  it('a primeira barra na prévia (SVG) e o ^FO do código de barras no ZPL caem no MESMO ponto da página', () => {
    const t = trabalho(formato('rolo_100x30_2'), [item('Arroz', { quantity: 2 })], { metrica: metricaResidente(1.1), reticencias: '...' });
    const { comandos } = gerarZpl(t);
    const svg = documentoSvg(t, 'prévia');
    const celula = t.paginas[0].celulas[1];
    const b = t.etiquetas[0].elementos.find((e) => e.tipo === 'barras') as BarrasNoLayout;
    const xBarras = celula.x + b.x + b.silencioEsquerda * b.modulo;
    expect(comandos).toContain(`^FO${xBarras},${celula.y + b.y}^BY${b.modulo}`);
    // No SVG, a célula é um grupo deslocado; a primeira barra do EAN (guarda) começa em b.x + silêncio.
    expect(svg).toContain(`<g transform="translate(${celula.x} ${celula.y})"`);
    expect(svg).toContain(`<rect x="${b.x + b.silencioEsquerda * b.modulo}" y="${b.y}" width="${b.modulo}" height="${b.altura}"/>`);
  });

  it('a prévia é em milímetro e em pontos: 50 × 30 mm, viewBox 400 × 240 (203 dpi), @page do tamanho do rolo', () => {
    const svg = documentoSvg(trabalho(formato('rolo_50x30'), [item('Arroz')]), 'prévia');
    expect(svg).toContain('@page { size: 50mm 30mm; margin: 0; }');
    expect(svg).toContain('width="50mm" height="30mm" viewBox="0 0 400 240"');
  });

  it('a posição pulada aparece na prévia (só na tela) e não gera campo nenhum no comando', () => {
    const t = trabalho(formato('a4_63x25_3x11'), [item('Arroz')], { comecarEm: 3 });
    const svg = documentoSvg(t, 'prévia');
    expect(svg.match(/class="pulada"/g)).toHaveLength(2);
    expect(svg).toContain('@media print { .contorno, .pulada { display: none; } }');
  });
});

// -------------------------------------------------------------------- TSPL

describe('TSPL', () => {
  it('cabeçalho do rolo: SIZE, GAP (avisando que o vão não foi informado), CODEPAGE UTF-8, e CRLF', () => {
    const { comandos, avisos } = gerarTspl(trabalho(formato('rolo_50x30'), [item('Arroz')], { metrica: metricaTspl(203) }));
    expect(comandos.startsWith('SIZE 50 mm,30 mm\r\nGAP 2 mm,0 mm\r\n')).toBe(true);
    expect(comandos).toContain('CODEPAGE UTF-8\r\n');
    expect(comandos).toContain('SET CUTTER OFF\r\n');
    expect(comandos.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
    expect(avisos.join(' ')).toMatch(/vão entre as etiquetas do rolo não foi informado/);
  });

  it('vão informado, marca preta, densidade (metade da escala 0–30), velocidade, corte no fim do lote e avanço final', () => {
    const f = formato('rolo_50x30', { vaoDoRoloMm: 3, sensor: 'marca', densidade: 21, velocidade: 3, corte: 'fim_do_lote', avancoFinalMm: 10 });
    const { comandos, avisos } = gerarTspl(trabalho(f, LOTE, { metrica: metricaTspl(203) }));
    expect(comandos).toContain('BLINE 3 mm,0 mm\r\n');
    expect(comandos).toContain('DENSITY 11\r\n');
    expect(comandos).toContain('SPEED 3\r\n');
    expect(comandos).toContain('SET CUTTER BATCH\r\n');
    expect(comandos).toContain(`FEED ${Math.round((10 * 203) / 25.4)}\r\n`);
    expect(numeros(comandos, /PRINT 1,(\d+)/g)).toEqual([2, 1, 3]);
    expect(avisos).toEqual([]);
  });

  it('EAN-13 com 12 dígitos e o módulo do layout; aspas escapadas como \\["]', () => {
    const t = trabalho(formato('rolo_60x40'), [item('Pote 5" azul')], { metrica: metricaTspl(203) });
    const b = t.etiquetas[0].elementos.find((e) => e.tipo === 'barras') as BarrasNoLayout;
    const { comandos } = gerarTspl(t);
    expect(comandos).toMatch(new RegExp(`BARCODE \\d+,\\d+,"EAN13",${b.altura},0,0,${b.modulo},${b.modulo},"789123456789"`));
    expect(comandos).toContain('Pote 5\\["] azul');
  });

  it('Code 128 manual com o subconjunto dito (!105 para dígitos, !104 para texto)', () => {
    const { comandos } = gerarTspl(trabalho(formato('rolo_60x40'), [item('A', { barcode: '12345' }), item('B', { barcode: 'PJ-001' })], { metrica: metricaTspl(203) }));
    expect(comandos).toContain('"128M"');
    expect(comandos).toContain('"!1051234!1005"');
    expect(comandos).toContain('"!104PJ-001"');
  });

  it('paisagem: rotação 90 com o ponto de referência na borda DIREITA da caixa do campo', () => {
    const t = trabalho(formato('rolo_60x40', { orientation: 'paisagem' }), [item('Arroz')], { metrica: metricaTspl(203) });
    const { comandos } = gerarTspl(t);
    const etq = t.etiquetas[0];
    const b = etq.elementos.find((e) => e.tipo === 'barras') as BarrasNoLayout;
    // Conteúdo (x, y) → etiqueta (L − y − h, x); o ponto de referência é a borda direita: L − y.
    const xRef = etq.larguraPontos - b.y;
    const yRef = b.x + b.silencioEsquerda * b.modulo;
    expect(comandos).toContain(`BARCODE ${xRef},${yRef},"EAN13",${b.altura},0,90,`);
  });
});

// --------------------------------------------------------------------- EPL

describe('EPL2', () => {
  it('cabeçalho: q/Q em pontos (vão de 2 mm = 16 pontos), Windows-1252, e P com a quantidade', () => {
    const { comandos } = gerarEpl(trabalho(formato('rolo_50x30'), LOTE, { metrica: metricaEpl(203) }));
    expect(comandos).toContain('\r\nN\r\nq400\r\nQ240,16\r\n');
    expect(comandos).toContain('ZT\r\nI8,A,001\r\n');
    expect(numeros(comandos, /\r\nP(\d+)\r\n/g)).toEqual([2, 1, 3]);
    expect(comandos).toMatch(/B\d+,\d+,0,E30,\d+,\d+,\d+,N,"789123456789"/);
  });

  it('o texto usa uma das fontes 1–4 com multiplicador, e a largura do layout é a da impressora', () => {
    const t = trabalho(formato('rolo_50x30'), [item('Arroz')], { metrica: metricaEpl(203) });
    const { comandos } = gerarEpl(t);
    const linhas = comandos.split('\r\n').filter((l) => l.startsWith('A'));
    expect(linhas.length).toBeGreaterThan(0);
    for (const l of linhas) expect(l).toMatch(/^A\d+,\d+,0,[1-4],[1-6],[1-6],N,".*"$/);
  });

  it('corte a cada etiqueta liga o cortador (OC); no fim do lote, avisa que não há', () => {
    expect(gerarEpl(trabalho(formato('rolo_50x30', { corte: 'cada_etiqueta' }), [item('A')], { metrica: metricaEpl(203) })).comandos).toContain('\r\nOC\r\n');
    const fim = gerarEpl(trabalho(formato('rolo_50x30', { corte: 'fim_do_lote', vaoDoRoloMm: 2 }), [item('A')], { metrica: metricaEpl(203) }));
    expect(fim.comandos).not.toContain('\r\nOC\r\n');
    expect(fim.avisos.join(' ')).toMatch(/corte só no fim do lote não é suportado/);
  });

  it('o arquivo sai em Windows-1252: ç e ã em um byte, "…" no 0x85, o que não existe vira "?"', () => {
    expect([...bytesWindows1252('ção…✓')]).toEqual([0xe7, 0xe3, 0x6f, 0x85, 0x3f]);
  });
});

// --------------------------------------------------------------------- PDF

describe('PDF', () => {
  function objetos(pdf: string) {
    return [...pdf.matchAll(/(\d+) 0 obj\n/g)].map((m) => ({ numero: Number(m[1]), posicao: m.index! }));
  }

  it('é um PDF de verdade: cabeçalho, xref com os deslocamentos certos, trailer e %%EOF', () => {
    const pdf = gerarPdf(trabalho(formato('rolo_50x30'), LOTE)).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)\n/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const entradas = pdf.slice(xref).split('\n').slice(3).filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    const objs = objetos(pdf);
    expect(entradas).toHaveLength(objs.length);
    entradas.forEach((d, i) => expect(pdf.slice(d).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it('página no tamanho do rolo (50 × 30 mm = 141,732 × 85,039 pt) e uma página por etiqueta do rolo de 1 coluna', () => {
    const pdf = gerarPdf(trabalho(formato('rolo_50x30'), LOTE)).toString('latin1');
    expect(pdf).toContain('/MediaBox [0 0 141.732 85.039]');
    expect(pdf.match(/\/Type \/Page /g)).toHaveLength(6);
  });

  it('cada etiqueta DISTINTA é um desenho só: 3 000 cópias de um produto são 1 XObject', () => {
    const pdf = gerarPdf(trabalho(formato('a4_63x25_3x11'), [item('Arroz', { quantity: 200 })])).toString('latin1');
    expect(pdf.match(/\/Subtype \/Form/g)).toHaveLength(1);
    expect(pdf.match(/\/Type \/Page /g)).toHaveLength(Math.ceil(200 / 33));
  });

  it('texto em WinAnsi: acento em octal, parênteses escapados — o arquivo é ASCII puro', () => {
    const pdf = gerarPdf(trabalho(formato('rolo_60x40'), [item('Pão (francês)')])).toString('latin1');
    expect(pdf).toContain('(P\\343o \\(franc\\352s\\))');
    const corpo = pdf.slice(pdf.indexOf('\n') + 1 + pdf.slice(pdf.indexOf('\n') + 1).indexOf('\n') + 1);
    // Só ASCII imprimível, mais TAB, LF e CR — conferido pelo código de cada
    // caractere: a regra no-control-regex recusa o intervalo de controle numa
    // expressão regular, e a pergunta é a mesma.
    const foraDoAscii = [...corpo].some((c) => {
      const n = c.charCodeAt(0);
      return !(n === 0x09 || n === 0x0a || n === 0x0d || (n >= 0x20 && n <= 0x7e));
    });
    expect(foraDoAscii).toBe(false);
  });
});

// ------------------------------------------------------------ os perfis

describe('os perfis de impressão e a lista de homologação', () => {
  it('sete perfis, e só os que passam por driver ou PDF aceitam folha A4', () => {
    expect(PERFIS_DE_IMPRESSAO.map((p) => p.id)).toEqual(['navegador', 'driver_windows', 'termica_generica', 'pdf', 'zpl', 'epl', 'tspl']);
    expect(PERFIS_DE_IMPRESSAO.filter((p) => p.aceitaFolha).map((p) => p.id)).toEqual(['navegador', 'driver_windows', 'pdf']);
  });

  it('a lista de homologação física cobre cada linguagem gerada e não declara modelo nenhum compatível', () => {
    const saidas = new Set(HOMOLOGACAO_FISICA.map((h) => h.saida));
    for (const s of ['todas', 'zpl', 'epl', 'tspl', 'pdf', 'html_exato']) expect(saidas.has(s as never), s).toBe(true);
    expect(HOMOLOGACAO_FISICA.map((h) => `${h.item} ${h.como}`).join(' ')).not.toMatch(/\bcompatível\b|\bhomologad[ao]\b/i);
  });
});
