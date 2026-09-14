/**
 * A ETIQUETA NO CADASTRO DO PRODUTO.
 *
 *   - a quantidade deixa apagar: limpar o "1" e digitar 5 dá 5, e não 15
 *     (A-produto-22 / C-etiquetas-M01);
 *   - com o pop-up bloqueado a tela NÃO diz "enviada(s) para impressão"
 *     (C-etiquetas-16);
 *   - o código de barras que o produto ganhou ao imprimir é dito, e o
 *     formulário é avisado para recarregar (C-etiquetas-16).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { EtiquetaDoProduto } from '../EtiquetaDoProduto';

const MODELO = {
  id: 'm1', name: 'Rolo 40 × 30', midia: 'rolo', paperWidthMm: 40, paperHeightMm: null, widthMm: 40, heightMm: 30,
  columns: 1, rows: null, gapXmm: 0, gapYmm: 0, marginTopMm: 1, marginLeftMm: 0, orientation: 'retrato',
  scalePercent: 100, fields: ['nome'], priceHighlight: true, complementText: null, printerId: null, printerName: null, isDefault: true,
};

let folha: Record<string, unknown>;
let pedidosDaFolha: Record<string, unknown>[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  pedidosDaFolha = [];
  folha = { html: '<html>folha</html>', etiquetas: 5, folhas: 5, promocoes: [], semPreco: [], codigosGerados: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      if (alvo.includes('/core/labels/templates/preview')) return json({ html: '<html>prévia</html>', etiquetas: 1, folhas: 1 });
      if (alvo.includes('/core/labels/templates')) return json({ items: [MODELO], campos: [] });
      if (alvo.includes('/core/labels/sheet')) {
        pedidosDaFolha.push(JSON.parse(String(init?.body ?? '{}')));
        return json(folha);
      }
      return json({});
    }),
  );
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da etiqueta do produto',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste da etiqueta do produto');
});

async function montar(onImpresso?: (r: { codigoGerado: string | null }) => void) {
  render(<EtiquetaDoProduto productId="p1" onImpresso={onImpresso} />);
  await waitFor(() => expect((screen.getByLabelText('Modelo de etiqueta') as HTMLSelectElement).value).toBe('m1'));
  return screen.getByLabelText('Quantidade de etiquetas') as HTMLInputElement;
}

describe('a quantidade de etiquetas', () => {
  it('apagar o 1 e digitar 5 dá 5 etiquetas, não 15', async () => {
    const qtd = await montar();
    expect(qtd.value).toBe('1');
    fireEvent.change(qtd, { target: { value: '' } });
    expect(qtd.value).toBe('');
    const botao = screen.getByRole('button', { name: /Imprimir/ }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    // A tecla seguinte entra no fim do que estiver no campo.
    fireEvent.change(qtd, { target: { value: `${qtd.value}5` } });
    expect(qtd.value).toBe('5');
    expect(screen.getByRole('button', { name: 'Imprimir 5 etiqueta(s)' })).toBeTruthy();
  });

  it('acima de 200 vira 200 ao sair do campo', async () => {
    const qtd = await montar();
    fireEvent.change(qtd, { target: { value: '350' } });
    expect((screen.getByRole('button', { name: /Imprimir/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.blur(qtd);
    expect(qtd.value).toBe('200');
  });
});

describe('imprimir', () => {
  it('pop-up bloqueado: o erro aparece e o "enviada(s) para impressão" NÃO', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir 1 etiqueta(s)' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/bloqueou a janela/);
    expect(screen.queryByText(/enviada\(s\) para impressão/)).toBeNull();
  });

  it('com a janela: imprime, diz o código que o produto ganhou e avisa o formulário', async () => {
    const janela = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    vi.spyOn(window, 'open').mockImplementation(() => janela as never);
    folha = { ...folha, etiquetas: 1, codigosGerados: [{ productId: 'p1', name: 'Sabão', barcode: '2000000000015' }] };
    const onImpresso = vi.fn();
    await montar(onImpresso);
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir 1 etiqueta(s)' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/1 etiqueta\(s\) enviada\(s\) para impressão/);
    expect(status.textContent).toMatch(/ganhou o código de barras 2000000000015/);
    expect(janela.print).toHaveBeenCalled();
    expect(onImpresso).toHaveBeenCalledWith({ codigoGerado: '2000000000015' });
    expect(pedidosDaFolha[0]).toMatchObject({ templateId: 'm1', items: [{ productId: 'p1', quantity: 1 }] });
  });
});
