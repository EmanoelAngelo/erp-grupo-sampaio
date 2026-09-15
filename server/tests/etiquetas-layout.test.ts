/**
 * ============================================================================
 * O LAYOUT EXPLÍCITO DA ETIQUETA — as regras que só apareceriam no papel
 * ============================================================================
 *
 * `LabelLayout.ts` é puro: estes casos não sobem banco nem servidor. Cada um
 * é uma regra que, quebrada, só se descobre depois de gasto o rolo:
 *
 *   - nenhuma caixa sobre a outra (texto sobre barra = código ilegível);
 *   - o módulo das barras em pontos INTEIROS da impressora, com as zonas de
 *     silêncio livres dentro da área útil;
 *   - nenhuma linha de texto passa da caixa (reticências, não letra cortada);
 *   - o preço é o maior texto quando há destaque;
 *   - as margens e o respiro do modelo são respeitados;
 *   - a paginação: quantidades, 1/2/3 colunas, posição inicial e calibração.
 */
import { describe, expect, it } from 'vitest';
import type { LabelItem } from '../src/services/core/BarcodeService.js';
import { LABEL_FORMATS, findLabelFormat, type LabelFormat } from '../src/services/core/LabelFormats.js';
import {
  caixaNaEtiqueta,
  caixasDasLinhas,
  escalaTipografica,
  layoutDaEtiqueta,
  metricaResidente,
  paginarEtiquetas,
  pontosInteiros,
  quebrarEmLinhas,
  xDaLinha,
  type EtiquetaNoLayout,
  type TextoNoLayout,
} from '../src/services/core/LabelLayout.js';
import { metricaEpl, metricaTspl } from '../src/services/core/LabelCommands.js';

const ITEM: LabelItem = {
  productId: 'p1',
  name: 'Arroz agulhinha tipo 1 pacote 5 kg',
  internalCode: 'GS-000123',
  barcode: '7891234567895',
  priceCents: 2799,
  listPriceCents: 2799,
  onSale: false,
  quantity: 1,
  attributes: 'Tamanho M · Cor Azul',
  brand: 'Marca',
  unit: 'UN',
  sku: 'SKU-1',
  shortDescription: 'Arroz agulhinha, grão longo',
  validade: '2026-12-31',
  lote: 'L2409',
};

/** O pior caso: nome longo, preço de quatro dígitos em promoção. */
const PIOR: LabelItem = {
  ...ITEM,
  name: 'Kit hidratante corporal de amêndoas com óleo de argan 500 ml edição especial de colecionador',
  priceCents: 999_999,
  listPriceCents: 1_299_999,
  onSale: true,
};

const TODOS_OS_CAMPOS = ['nome', 'descricao', 'marca', 'unidade', 'sku', 'atributos', 'preco', 'complemento', 'validade', 'lote', 'barras', 'ean', 'codigo', 'empresa'] as const;

function formato(base: string, extra: Partial<LabelFormat> = {}): LabelFormat {
  return { ...findLabelFormat(base)!, ...extra };
}

interface Tinta {
  campo: string;
  x: number;
  y: number;
  largura: number;
  altura: number;
}

/**
 * Onde há TINTA, no espaço do conteúdo: cada linha de texto na largura medida
 * (e não a caixa inteira, que num preço alinhado à direita ocupa a largura
 * toda), e o código de barras COM as zonas de silêncio — elas têm de estar
 * livres de qualquer outra coisa.
 */
function tintas(etq: EtiquetaNoLayout): Tinta[] {
  const out: Tinta[] = [];
  for (const el of etq.elementos) {
    if (el.tipo === 'texto') {
      caixasDasLinhas(el).forEach((l, i) => out.push({ campo: el.campo, x: xDaLinha(el, i), y: l.y, largura: el.larguras[i], altura: el.corpo }));
    } else if (el.tipo === 'barras') {
      out.push({ campo: 'barras', x: el.x, y: el.y, largura: el.largura, altura: el.altura });
    }
  }
  return out;
}

const sobrepoe = (a: Tinta, b: Tinta) =>
  a.x < b.x + b.largura - 1e-6 && b.x < a.x + a.largura - 1e-6 && a.y < b.y + b.altura - 1e-6 && b.y < a.y + a.altura - 1e-6;

function conferirSemSobreposicao(etq: EtiquetaNoLayout, contexto: string) {
  const ts = tintas(etq);
  const colisoes: string[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    for (let j = i + 1; j < ts.length; j += 1) {
      if (sobrepoe(ts[i], ts[j])) colisoes.push(`${ts[i].campo} × ${ts[j].campo}`);
    }
  }
  expect(colisoes, contexto).toEqual([]);
}

function conferirDentroDaArea(etq: EtiquetaNoLayout, contexto: string) {
  const a = etq.areaUtil;
  for (const t of tintas(etq)) {
    expect(t.x, `${contexto} ${t.campo} (esquerda)`).toBeGreaterThanOrEqual(a.x - 1e-6);
    expect(t.y, `${contexto} ${t.campo} (topo)`).toBeGreaterThanOrEqual(a.y - 1e-6);
    expect(t.x + t.largura, `${contexto} ${t.campo} (direita)`).toBeLessThanOrEqual(a.x + a.largura + 1e-6);
    expect(t.y + t.altura, `${contexto} ${t.campo} (base)`).toBeLessThanOrEqual(a.y + a.altura + 1e-6);
  }
  // Depois do giro, tudo continua dentro do ADESIVO.
  for (const el of etq.elementos) {
    const b = caixaNaEtiqueta(etq, el);
    expect(b.x, `${contexto} ${el.campo}`).toBeGreaterThanOrEqual(0);
    expect(b.y, `${contexto} ${el.campo}`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.largura, `${contexto} ${el.campo}`).toBeLessThanOrEqual(etq.larguraPontos + 1e-6);
    expect(b.y + b.altura, `${contexto} ${el.campo}`).toBeLessThanOrEqual(etq.alturaPontos + 1e-6);
  }
}

/** Todos os formatos prontos × dpi × orientação × os dois itens: a matriz que o papel cobraria. */
function matriz(fn: (etq: EtiquetaNoLayout, contexto: string, f: LabelFormat) => void) {
  let desenhadas = 0;
  for (const base of LABEL_FORMATS) {
    for (const dpi of [203, 300, 600]) {
      for (const orientation of ['retrato', 'paisagem'] as const) {
        for (const item of [ITEM, PIOR]) {
          const f = { ...base, dpi, orientation, campos: [...TODOS_OS_CAMPOS] } as LabelFormat;
          const contexto = `${base.id} ${dpi}dpi ${orientation} ${item === PIOR ? 'pior caso' : 'comum'}`;
          let etq: EtiquetaNoLayout;
          try {
            etq = layoutDaEtiqueta({ ...f, complementText: 'Troca em até 30 dias' }, item, { empresa: 'Preço Justo' });
          } catch (err) {
            // RECUSAR é permitido (etiqueta estreita demais em paisagem); sobrepor, não.
            expect((err as { code?: string }).code, contexto).toMatch(/^CORE_LABEL_(PRICE_DOES_NOT_FIT|LAYOUT_DOES_NOT_FIT)$/);
            continue;
          }
          desenhadas += 1;
          fn(etq, contexto, f);
        }
      }
    }
  }
  // A matriz tem 8 × 3 × 2 × 2 = 96 combinações; a maioria tem de desenhar.
  expect(desenhadas).toBeGreaterThan(70);
}

describe('nenhuma caixa sobre a outra, nada fora da área útil', () => {
  it('em todos os formatos prontos, a 203/300/600 dpi, retrato e paisagem, com todos os campos marcados', () => {
    matriz((etq, contexto) => {
      conferirSemSobreposicao(etq, contexto);
      conferirDentroDaArea(etq, contexto);
    });
  });

  it('o que não cabe SAI da etiqueta e vira aviso com o nome do campo — e nunca sobrepõe', () => {
    const f: LabelFormat = { ...formato('rolo_33x22'), campos: [...TODOS_OS_CAMPOS], complementText: 'Troca em 30 dias' };
    const etq = layoutDaEtiqueta(f, PIOR, { empresa: 'Preço Justo' });
    expect(etq.omitidos.length).toBeGreaterThan(0);
    expect(etq.avisos.join(' ')).toMatch(/ficaram de fora/);
    // Preço e barras ficam sempre.
    expect(etq.elementos.some((e) => e.campo === 'preco')).toBe(true);
    expect(etq.elementos.some((e) => e.campo === 'barras')).toBe(true);
    conferirSemSobreposicao(etq, 'rolo 33 × 22 lotado');
  });

  it('nem preço e barras cabem juntos: a etiqueta é RECUSADA dizendo o que fazer, e não sobreposta', () => {
    const f: LabelFormat = { ...formato('rolo_50x30'), heightMm: 6, campos: ['preco', 'barras'] };
    expect(() => layoutDaEtiqueta(f, ITEM, { empresa: '' })).toThrow(/nem o preço e o código de barras cabem juntos/);
  });
});

describe('o código de barras: módulo em pontos inteiros e zonas de silêncio', () => {
  it('o módulo é um número inteiro de pontos da impressora do formato, a caixa inclui as zonas de silêncio e cabe na área útil', () => {
    matriz((etq, contexto) => {
      const b = etq.elementos.find((e) => e.tipo === 'barras');
      if (!b || b.tipo !== 'barras') return;
      expect(Number.isInteger(b.modulo), contexto).toBe(true);
      expect(b.modulo, contexto).toBeGreaterThanOrEqual(1);
      expect(b.modulo, contexto).toBeLessThanOrEqual(10);
      // A caixa = silêncio + barras + silêncio, módulo a módulo.
      expect(b.largura, contexto).toBe((b.silencioEsquerda + b.bits.length + b.silencioDireita) * b.modulo);
      expect(b.silencioEsquerda, contexto).toBeGreaterThanOrEqual(7);
      expect(b.silencioDireita, contexto).toBeGreaterThanOrEqual(7);
      // O módulo físico nunca fica abaixo do que a impressora marca com confiança.
      expect((b.modulo * 25.4) / etq.dpi, contexto).toBeGreaterThanOrEqual(0.19 - 1e-9);
    });
  });

  it('a mesma etiqueta a 203, 300 e 600 dpi: o módulo é o MAIOR inteiro de pontos em que o código inteiro cabe', () => {
    for (const dpi of [203, 300, 600]) {
      const etq = layoutDaEtiqueta(formato('rolo_50x30', { dpi }), ITEM, { empresa: '' });
      const b = etq.elementos.find((e) => e.tipo === 'barras')!;
      if (b.tipo !== 'barras') throw new Error('sem barras');
      const modulos = b.silencioEsquerda + b.bits.length + b.silencioDireita;
      expect(b.modulo).toBe(Math.min(10, Math.floor(etq.areaUtil.largura / modulos)));
      expect((b.modulo + 1) * modulos > etq.areaUtil.largura || b.modulo === 10).toBe(true);
    }
  });

  it('o rolo de 33 mm a 203 dpi fica com 2 pontos (0,25 mm) e AVISA que está abaixo do nominal GS1', () => {
    const etq = layoutDaEtiqueta(formato('rolo_33x22'), ITEM, { empresa: '' });
    const b = etq.elementos.find((e) => e.tipo === 'barras')!;
    expect(b.tipo === 'barras' && b.modulo).toBe(2);
    expect(etq.avisos.join(' ')).toMatch(/abaixo do mínimo GS1/);
  });

  it('código inválido não vira barra: sai o aviso no lugar e a etiqueta avisa o motivo', () => {
    const etq = layoutDaEtiqueta(formato('rolo_50x30'), { ...ITEM, barcode: '7891234567890' }, { empresa: '' });
    expect(etq.elementos.some((e) => e.tipo === 'barras')).toBe(false);
    const aviso = etq.elementos.find((e) => e.campo === 'avisoDasBarras') as TextoNoLayout;
    expect(aviso.linhas.join(' ')).toMatch(/CÓDIGO INVÁLIDO/);
    expect(etq.avisos.join(' ')).toMatch(/verificador/);
  });
});

describe('o texto nunca é cortado ao meio', () => {
  it('toda linha medida cabe na largura da caixa, em todas as combinações', () => {
    matriz((etq, contexto) => {
      for (const el of etq.elementos) {
        if (el.tipo !== 'texto') continue;
        el.larguras.forEach((w) => expect(w, `${contexto} ${el.campo}`).toBeLessThanOrEqual(el.largura + 1e-6));
        expect(el.linhas.length * el.entrelinha, contexto).toBeLessThanOrEqual(el.altura + 1e-6);
      }
    });
  });

  it('o nome que não cabe termina em reticências (… no HTML/PDF, ... na térmica)', () => {
    const f = formato('rolo_33x22');
    // Três linhas de 33 mm comportam uns 90 caracteres: o dobro do pior caso não cabe.
    const longo = { ...PIOR, name: `${PIOR.name} ${PIOR.name}` };
    const html = layoutDaEtiqueta(f, longo, { empresa: '' });
    const nome = html.elementos.find((e) => e.campo === 'nome') as TextoNoLayout;
    expect(nome.cortado).toBe(true);
    expect(nome.linhas[nome.linhas.length - 1].endsWith('…')).toBe(true);

    const termica = layoutDaEtiqueta(f, longo, { empresa: '', metrica: metricaResidente(1.1), reticencias: '...' });
    const nomeT = termica.elementos.find((e) => e.campo === 'nome') as TextoNoLayout;
    expect(nomeT.linhas[nomeT.linhas.length - 1].endsWith('...')).toBe(true);
  });

  it('palavra maior que a linha quebra por caractere, e as reticências entram na última linha permitida', () => {
    const medir = (t: string) => t.length * 10;
    const r = quebrarEmLinhas('AAAAAAAAAAAAAAAAAAAA BB', 100, 2, medir, '…');
    expect(r.linhas).toHaveLength(2);
    r.linhas.forEach((l) => expect(medir(l)).toBeLessThanOrEqual(100));
    expect(r.cortado).toBe(true);
    expect(r.linhas[1].endsWith('…')).toBe(true);
  });

  it('com a fonte de passo fixo da EPL, a medida é exata: linhas cabem com a largura REAL da impressora', () => {
    const m = metricaEpl(203);
    const etq = layoutDaEtiqueta(formato('rolo_50x30'), PIOR, { empresa: 'Preço Justo', metrica: m, reticencias: '...' });
    for (const el of etq.elementos) {
      if (el.tipo !== 'texto') continue;
      el.linhas.forEach((l, i) => {
        expect(el.larguras[i]).toBe(m.largura(l, el.corpo, el.negrito));
        expect(el.larguras[i]).toBeLessThanOrEqual(el.largura);
      });
    }
    // O corpo da EPL é sempre o de uma fonte × multiplicador que existe.
    const alturas = new Set([12, 16, 20, 24].flatMap((h) => [1, 2, 3, 4, 5, 6].map((k) => h * k)));
    for (const el of etq.elementos) if (el.tipo === 'texto') expect(alturas.has(el.corpo)).toBe(true);
  });

  it('na TSPL o corpo vem de pontos tipográficos inteiros: o que a impressora faz nunca passa um ponto do planejado', () => {
    // A fonte "0" recebe o corpo em pontos tipográficos (1/72"); o layout mede
    // em pontos da impressora, inteiros. O gerador arredonda de volta para
    // pontos tipográficos: a letra impressa fica entre o corpo e o corpo + 1.
    const m = metricaTspl(203);
    for (let pedido = 10; pedido < 80; pedido += 7) {
      const c = m.corpo(pedido);
      expect(c).toBeLessThanOrEqual(pedido);
      const impresso = (Math.round((c * 72) / 203) * 203) / 72;
      expect(impresso).toBeGreaterThanOrEqual(c);
      expect(impresso - c).toBeLessThan(1);
    }
  });
});

describe('o preço em destaque', () => {
  it('com destaque, o preço é o MAIOR texto da etiqueta e sai em negrito', () => {
    matriz((etq, contexto, f) => {
      if (f.priceHighlight === false) return;
      const textos = etq.elementos.filter((e): e is TextoNoLayout => e.tipo === 'texto');
      const preco = textos.find((t) => t.campo === 'preco');
      if (!preco) return;
      expect(preco.negrito, contexto).toBe(true);
      for (const t of textos) if (t !== preco) expect(t.corpo, `${contexto} ${t.campo}`).toBeLessThan(preco.corpo);
    });
  });

  it('sem destaque, o preço sai discreto: menor que com destaque no mesmo formato', () => {
    const com = layoutDaEtiqueta(formato('rolo_60x40'), ITEM, { empresa: '' });
    const sem = layoutDaEtiqueta(formato('rolo_60x40', { priceHighlight: false }), ITEM, { empresa: '' });
    const corpo = (e: EtiquetaNoLayout) => (e.elementos.find((x) => x.campo === 'preco') as TextoNoLayout).corpo;
    expect(corpo(sem)).toBeLessThan(corpo(com));
  });

  it('promoção: o "de" sai riscado, sem encostar no preço; sem promoção não há "de"', () => {
    const etq = layoutDaEtiqueta(formato('rolo_60x40'), PIOR, { empresa: '' });
    const de = etq.elementos.find((e) => e.campo === 'precoDe') as TextoNoLayout;
    expect(de.linhas[0]).toMatch(/12\.999,99/);
    const risco = etq.elementos.find((e) => e.campo === 'risco')!;
    expect(risco.y).toBeGreaterThan(de.y);
    expect(risco.y + risco.altura).toBeLessThanOrEqual(de.y + de.altura);
    conferirSemSobreposicao(etq, 'promoção');
    const comum = layoutDaEtiqueta(formato('rolo_60x40'), ITEM, { empresa: '' });
    expect(comum.elementos.some((e) => e.campo === 'precoDe' || e.campo === 'risco')).toBe(false);
  });

  it('o preço sai com espaço comum: o espaço rígido do "R$ 27,99" não chega à térmica (que o imprimiria como outro caractere)', () => {
    for (const item of [ITEM, PIOR]) {
      const etq = layoutDaEtiqueta(formato('rolo_60x40'), item, { empresa: `Preço${String.fromCharCode(0xa0)}Justo` });
      for (const el of etq.elementos) {
        if (el.tipo !== 'texto') continue;
        for (const l of el.linhas) expect(l.includes(String.fromCharCode(0xa0)), `${el.campo}: ${l}`).toBe(false);
      }
      const preco = etq.elementos.find((e) => e.campo === 'preco') as TextoNoLayout;
      expect(preco.linhas[0]).toMatch(/^R\$ \d/);
    }
  });

  it('a escala tipográfica é a mesma régua da folha HTML (60 × 40: preço de 18,4 px)', () => {
    const s = escalaTipografica(formato('rolo_60x40'));
    expect(s.preco).toBeCloseTo(18.4, 5);
    expect(s.barrasMm).toBeCloseTo(10.4, 5);
  });
});

describe('margens, respiro e o que o modelo pede', () => {
  it('o respiro de cima do MODELO de rolo empurra o conteúdo (margem superior de 4 mm)', () => {
    const f: LabelFormat = { ...formato('rolo_60x40'), paperWidthMm: 60, marginTopMm: 4 };
    const etq = layoutDaEtiqueta(f, ITEM, { empresa: '' });
    const topo = Math.min(...tintas(etq).map((t) => t.y));
    expect(topo).toBeGreaterThanOrEqual(pontosInteiros(4, 203));
  });

  it('validade e lote saem numa linha só, na data do calendário brasileiro', () => {
    const f: LabelFormat = { ...formato('rolo_60x40'), campos: ['nome', 'preco', 'validade', 'lote', 'barras'] };
    const etq = layoutDaEtiqueta(f, ITEM, { empresa: '' });
    const linha = etq.elementos.find((e) => e.campo === 'validadeLote') as TextoNoLayout;
    expect(linha.linhas[0]).toBe('Val. 31/12/2026 · Lote L2409');
  });

  it('a etiqueta de teste ganha moldura DENTRO do adesivo, e o conteúdo começa depois dela', () => {
    const etq = layoutDaEtiqueta(formato('rolo_50x30'), ITEM, { empresa: '', moldura: true });
    const moldura = etq.elementos.find((e) => e.campo === 'moldura')!;
    expect(moldura.x).toBe(pontosInteiros(0.5, 203));
    expect(moldura.x + moldura.largura).toBe(etq.larguraDoConteudo - pontosInteiros(0.5, 203));
    for (const t of tintas(etq)) expect(t.x).toBeGreaterThan(moldura.x + (moldura.tipo === 'caixa' ? moldura.espessura : 0));
  });
});

describe('a paginação do lote', () => {
  it('quantidades (2, 1, 3) viram 6 etiquetas — no rolo de 1 coluna, no de 2 e na folha de 33', () => {
    const soma = (f: LabelFormat) => paginarEtiquetas(f, [2, 1, 3]).paginas.flatMap((p) => p.celulas).filter((c) => c.etiqueta !== null);
    for (const id of ['rolo_50x30', 'rolo_100x30_2', 'a4_63x25_3x11']) {
      const cels = soma(formato(id));
      expect(cels, id).toHaveLength(6);
      expect(cels.map((c) => c.etiqueta), id).toEqual([0, 0, 1, 2, 2, 2]);
    }
    expect(paginarEtiquetas(formato('rolo_50x30'), [2, 1, 3]).paginas).toHaveLength(6);
    expect(paginarEtiquetas(formato('rolo_100x30_2'), [2, 1, 3]).paginas).toHaveLength(3);
    expect(paginarEtiquetas(formato('a4_63x25_3x11'), [2, 1, 3]).paginas).toHaveLength(1);
  });

  it('1, 2 e 3 colunas: cada coluna cai em margem + c × (largura + vão), arredondada do MILÍMETRO', () => {
    for (const [id, colunas] of [['rolo_50x30', 1], ['rolo_100x30_2', 2], ['a4_63x25_3x11', 3]] as const) {
      const f = formato(id);
      const dpi = f.dpi ?? (f.midia === 'rolo' ? 203 : 300);
      const [pagina] = paginarEtiquetas(f, [colunas]).paginas;
      expect(pagina.celulas).toHaveLength(colunas);
      const recuo = f.midia === 'folha' ? f.marginLeftMm : 0;
      pagina.celulas.forEach((c, i) => {
        expect(c.x, `${id} coluna ${i + 1}`).toBe(Math.round(((recuo + i * (f.widthMm + f.gapXmm)) * dpi) / 25.4));
      });
    }
  });

  it('a décima primeira linha da folha A4 cai no ponto certo — sem erro acumulado de arredondamento', () => {
    const f = formato('a4_63x25_3x11');
    const [pagina] = paginarEtiquetas(f, [33]).paginas;
    const ultima = pagina.celulas[32];
    expect(ultima.y).toBe(Math.round(((f.marginTopMm + 10 * f.heightMm) * 300) / 25.4));
  });

  it('posição inicial: pula as N primeiras células da PRIMEIRA página, e só dela', () => {
    const f = formato('a4_63x25_3x11');
    const { paginas } = paginarEtiquetas(f, [30], 5);
    expect(paginas).toHaveLength(2);
    expect(paginas[0].celulas.slice(0, 4).every((c) => c.etiqueta === null)).toBe(true);
    expect(paginas[0].celulas.slice(4).every((c) => c.etiqueta === 0)).toBe(true);
    expect(paginas[0].celulas).toHaveLength(33);
    expect(paginas[1].celulas.map((c) => c.etiqueta)).toEqual([0]);
    // No rolo de 2 colunas, começar na 2 aproveita a linha com a da esquerda já arrancada.
    const rolo = paginarEtiquetas(formato('rolo_100x30_2'), [3], 2).paginas;
    expect(rolo[0].celulas.map((c) => c.etiqueta)).toEqual([null, 0]);
    expect(rolo.flatMap((p) => p.celulas).filter((c) => c.etiqueta !== null)).toHaveLength(3);
  });

  it('calibração: o deslocamento X/Y empurra todas as células; o que sairia do papel encosta e avisa', () => {
    const f = formato('a4_63x25_3x11', { offsetXmm: 1.5, offsetYmm: -0.5 });
    const semOffset = paginarEtiquetas(formato('a4_63x25_3x11'), [3]).paginas[0];
    const comOffset = paginarEtiquetas(f, [3]);
    comOffset.paginas[0].celulas.forEach((c, i) => {
      expect(Math.abs(c.x - semOffset.celulas[i].x - pontosInteiros(1.5, 300))).toBeLessThanOrEqual(1);
      expect(Math.abs(c.y - semOffset.celulas[i].y + pontosInteiros(0.5, 300))).toBeLessThanOrEqual(1);
    });
    expect(comOffset.avisos).toEqual([]);
    const fora = paginarEtiquetas(formato('rolo_50x30', { offsetXmm: 3 }), [1]);
    expect(fora.paginas[0].celulas[0].x).toBe(0);
    expect(fora.avisos.join(' ')).toMatch(/fora do papel/);
  });
});
