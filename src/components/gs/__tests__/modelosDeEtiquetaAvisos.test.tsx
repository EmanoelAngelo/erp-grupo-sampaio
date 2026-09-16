/**
 * O EDITOR DE MODELOS diz o que pode dar errado no papel, e parte das folhas
 * Carta com o papel Carta.
 *
 *   - a prévia devolve os AVISOS do modelo (barra abaixo do mínimo GS1, campos
 *     que não cabem na altura) e o editor os mostra (C-etiquetas-05/12);
 *   - "A partir de um formato pronto" com uma folha Carta (215,9 × 279,4)
 *     levava o papel A4 fixo de 210 × 297 (C-etiquetas-02).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { ModelosDeEtiqueta } from '../ModelosDeEtiqueta';

const AVISO = 'Com 28,8 mm úteis, cada barra do código fica com 0,245 mm — abaixo do mínimo GS1 (0,264 mm).';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      const corpo = alvo.includes('/core/labels/templates/preview')
        ? { html: '<html>prévia</html>', etiquetas: 2, folhas: 2, avisos: [AVISO] }
        : alvo.includes('/core/labels/templates')
          ? { items: [], campos: [{ id: 'nome', rotulo: 'Nome do produto' }] }
          : { items: [] };
      return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    'teste dos avisos do modelo',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste dos avisos do modelo');
});

describe('o editor de modelos', () => {
  it('mostra os avisos que a prévia devolve', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    await waitFor(() => expect(screen.getByTestId('avisos-do-modelo').textContent).toContain('abaixo do mínimo GS1'));
  });

  it('a partir de uma folha Carta, o rascunho nasce com o papel Carta (215,9 × 279,4), não A4', async () => {
    const carta = {
      id: 'a4_67x25_3x10', label: 'Folha Carta — 30 por folha (66,7 × 25,4 mm)', hint: 'Carta.', midia: 'folha' as const,
      widthMm: 66.68, heightMm: 25.4, columns: 3, rows: 10, campos: ['nome'], gapXmm: 3.18, marginTopMm: 12.7,
      marginLeftMm: 4.76, paperWidthMm: 215.9, paperHeightMm: 279.4,
    };
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[carta]} />);
    fireEvent.change(await screen.findByLabelText('Criar a partir de um formato pronto'), { target: { value: 'a4_67x25_3x10' } });
    expect((screen.getByLabelText('Largura do papel') as HTMLInputElement).value).toBe('215.9');
    expect((screen.getByLabelText('Altura do papel') as HTMLInputElement).value).toBe('279.4');
  });
});
