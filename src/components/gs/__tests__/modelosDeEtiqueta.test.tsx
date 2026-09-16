/**
 * O EDITOR DE MODELOS DE ETIQUETA confere a conta do papel antes de salvar.
 *
 * Duas colunas de 30 mm com 2 mm entre elas e 1 mm de margem ocupam 63 mm: num
 * rolo de 60 mm a segunda coluna sairia cortada — a tela diz isso e não deixa
 * salvar. Num rolo de 64 mm, cabe, e o modelo vai para o servidor com a medida
 * real e a impressora escolhida.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { ModelosDeEtiqueta } from '../ModelosDeEtiqueta';

let criado: Record<string, unknown> | null = null;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    let corpo: unknown = {};
    let status = 200;
    if (alvo.includes('/core/labels/templates/preview')) {
      corpo = { html: '<html><body>prévia</body></html>', etiquetas: 4, folhas: 2 };
    } else if (alvo.includes('/core/labels/templates') && metodo === 'POST') {
      criado = JSON.parse(init?.body ?? '{}');
      corpo = { id: 'm1', ...criado, printerName: 'Argox OS-214' };
      status = 201;
    } else if (alvo.includes('/core/labels/templates')) {
      corpo = {
        items: criado ? [{ id: 'm1', ...criado, printerName: 'Argox OS-214' }] : [],
        campos: [
          { id: 'nome', rotulo: 'Nome do produto' },
          { id: 'preco', rotulo: 'Preço' },
          { id: 'barras', rotulo: 'Código de barras (desenho)' },
        ],
      };
    } else if (alvo.includes('/core/print/printers')) {
      corpo = { items: [{ id: 'imp-1', name: 'Argox OS-214', kind: 'etiqueta', transport: 'browser', paper_width_mm: 64, is_default: 1, active: 1 }] };
    }
    return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
  });
}

beforeEach(() => {
  criado = null;
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-g', login: 'ADMIN-PREÇO JUSTO', displayName: 'ADMIN-PREÇO JUSTO', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste do editor de etiquetas',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste do editor de etiquetas');
  vi.unstubAllGlobals();
});

const campo = (rotulo: string) => screen.getByLabelText(rotulo) as HTMLInputElement;
const mudar = (rotulo: string, valor: string) => fireEvent.change(campo(rotulo), { target: { value: valor } });

describe('modelo de 2 colunas', () => {
  it('papel estreito: avisa que a última coluna sairia cortada e não deixa salvar; papel certo: salva com a medida real', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));

    mudar('Nome do modelo', 'Rolo 30 × 20 — 2 colunas');
    mudar('Colunas', '2');
    mudar('Largura da etiqueta', '30');
    mudar('Altura da etiqueta', '20');
    mudar('Espaço entre colunas', '2');
    mudar('Margem esquerda', '1');
    mudar('Largura do papel', '60');

    expect(screen.getByTestId('conta-do-papel').textContent).toMatch(/63 mm e o papel tem 60 mm: a última coluna sairia cortada/);
    const salvar = screen.getByRole('button', { name: 'Salvar modelo' }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);

    mudar('Largura do papel', '64');
    expect(screen.getByTestId('conta-do-papel').textContent).toMatch(/ocupam 63 mm de 64 mm/);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Argox OS-214' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Impressora preferida'), { target: { value: 'imp-1' } });
    expect(salvar.disabled).toBe(false);

    fireEvent.click(salvar);
    await waitFor(() => expect(criado).not.toBeNull());
    expect(criado).toMatchObject({ columns: 2, widthMm: 30, heightMm: 20, gapXmm: 2, marginLeftMm: 1, paperWidthMm: 64, printerId: 'imp-1', midia: 'rolo' });
    expect(await screen.findByText(/Modelo "Rolo 30 × 20 — 2 colunas" salvo/)).toBeTruthy();
  });

  it('a prévia do rascunho é pedida ao servidor e mostrada antes de salvar', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    await waitFor(() => expect(screen.getByText(/4 etiqueta\(s\) de exemplo em 2 página\(s\)/)).toBeTruthy());
    expect((screen.getByTitle('Prévia da etiqueta') as HTMLIFrameElement).getAttribute('srcdoc')).toContain('prévia');
  });
});
