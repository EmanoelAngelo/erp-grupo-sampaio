/**
 * A ETIQUETA DO CADASTRO SEGUE A SAÍDA DO MODELO (P00 das etiquetas).
 *
 * O DEFEITO: a aba Etiqueta do cadastro chamava `POST /labels/sheet` SEM
 * `perfil` e escrevia o HTML numa janela do navegador — sempre. A tela de
 * Etiquetas, com o MESMO modelo, respeita a saída padrão dele (ZPL, EPL, TSPL,
 * PDF, driver). A loja que configurou a térmica ZPL do balcão imprimia daqui
 * uma folha HTML pelo diálogo do Windows: outro papel, outra escala, e sem a
 * calibração e os ajustes que só vão dentro do arquivo de comandos.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido):
 *
 *   - tire o `perfil` do corpo e o caso do modelo de ZPL fica vermelho (volta a
 *     sair pelo navegador);
 *   - abra a janela mesmo fora do navegador e o caso "nenhuma janela abre" fica
 *     vermelho: o SVG da prévia iria para o diálogo do sistema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EtiquetaDoProduto } from '../EtiquetaDoProduto';

const MODELO_NAVEGADOR = {
  id: 'm-nav', name: 'Rolo 50 × 30', midia: 'rolo', paperWidthMm: 50, paperHeightMm: null,
  widthMm: 50, heightMm: 30, columns: 1, rows: null, fields: ['nome', 'preco', 'barras'],
  isDefault: true, outputProfile: null, printerName: null,
};
const MODELO_ZPL = { ...MODELO_NAVEGADOR, id: 'm-zpl', name: 'Rolo ZPL', isDefault: false, outputProfile: 'zpl' };

let corpos: Record<string, unknown>[];
let modelos: unknown[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function respostaDaFolha(comArquivo: boolean) {
  return {
    html: '<html>desenho</html>',
    etiquetas: 1,
    folhas: 1,
    perfil: comArquivo ? 'zpl' : 'navegador',
    arquivo: comArquivo ? { nome: 'etiquetas-modelo-zpl.zpl', mime: 'text/plain', base64: 'WlBM' } : null,
    comandos: comArquivo ? '^XA^XZ' : null,
    avisos: [],
    semPreco: [],
    promocoes: [],
    codigosGerados: [],
  };
}

let janela: { document: { open: () => void; write: (h: string) => void; close: () => void }; focus: () => void; print: () => void };

beforeEach(() => {
  corpos = [];
  modelos = [MODELO_NAVEGADOR, MODELO_ZPL];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      if (alvo.includes('/core/labels/templates/preview')) return json({ html: '<html>prévia</html>', etiquetas: 1, folhas: 1 });
      if (alvo.includes('/core/labels/templates')) return json({ items: modelos, campos: [] });
      if (alvo.includes('/core/labels/sheet')) {
        const corpo = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        corpos.push(corpo);
        return json(respostaDaFolha(corpo.perfil === 'zpl'));
      }
      return json({});
    }),
  );
  janela = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function montar() {
  render(<EtiquetaDoProduto productId="p1" />);
  return screen.findByLabelText('Modelo de etiqueta');
}

describe('a saída da etiqueta do cadastro é a do modelo', () => {
  it('modelo sem saída padrão: vai pelo navegador, e o corpo não manda perfil', async () => {
    await montar();
    expect((await screen.findByTestId('saida-do-modelo')).textContent).toMatch(/navegador/);
    fireEvent.click(screen.getByRole('button', { name: /Imprimir 1 etiqueta/ }));
    await waitFor(() => expect(corpos).toHaveLength(1));
    expect(corpos[0].perfil).toBeUndefined();
    expect(janela.print).toHaveBeenCalled();
  });

  it('modelo de ZPL: o corpo manda perfil, nenhuma janela abre e o arquivo aparece na tela', async () => {
    const seletor = await montar();
    fireEvent.change(seletor, { target: { value: 'm-zpl' } });
    await waitFor(() => expect(screen.getByTestId('saida-do-modelo').textContent).toMatch(/ZPL/));

    fireEvent.click(screen.getByRole('button', { name: /Imprimir 1 etiqueta/ }));
    await waitFor(() => expect(corpos).toHaveLength(1));
    expect(corpos[0].perfil).toBe('zpl');
    // Escrever o SVG da prévia no diálogo do sistema imprimiria o papel errado.
    expect(janela.print).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /Baixar etiquetas-modelo-zpl\.zpl/ })).toBeTruthy();
    expect((await screen.findByRole('status')).textContent).toMatch(/etiquetas-modelo-zpl\.zpl/);
  });
});
