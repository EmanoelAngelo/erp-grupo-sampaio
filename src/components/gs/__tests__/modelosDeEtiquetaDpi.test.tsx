/**
 * O EDITOR DE MODELOS escolhe a RESOLUÇÃO DA IMPRESSORA (C-etiquetas-05).
 *
 * O servidor arredonda cada barra do código para os pontos da impressora do
 * modelo. Sem o seletor, todo rolo era tratado como 203 dpi: numa térmica de
 * 300 dpi as barras saíam desiguais e o leitor falhava.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { ModelosDeEtiqueta } from '../ModelosDeEtiqueta';

let enviado: Record<string, unknown> | null;
let existentes: Record<string, unknown>[];

const MODELO_600 = {
  id: 'm6', name: 'Laser 600', midia: 'rolo', paperWidthMm: 40, paperHeightMm: null, widthMm: 40, heightMm: 30,
  columns: 1, rows: null, gapXmm: 0, gapYmm: 0, marginTopMm: 1, marginLeftMm: 0, orientation: 'retrato',
  scalePercent: 100, dpi: 600, fields: ['nome'], priceHighlight: true, complementText: null, printerId: null,
  printerName: null, isDefault: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  enviado = null;
  existentes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (alvo.includes('/core/labels/templates/preview')) return json({ html: '<html></html>', etiquetas: 1, folhas: 1 });
      if (alvo.includes('/core/labels/templates') && (metodo === 'POST' || metodo === 'PATCH')) {
        enviado = JSON.parse(init?.body ?? '{}');
        return json({ id: 'novo', ...enviado, printerName: null, avisos: [] }, metodo === 'POST' ? 201 : 200);
      }
      if (alvo.includes('/core/labels/templates')) {
        return json({ items: existentes, campos: [{ id: 'nome', rotulo: 'Nome do produto' }] });
      }
      return json({ items: [] });
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
    'teste do dpi do modelo',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste do dpi do modelo');
});

const seletorDeDpi = () => screen.getByLabelText('Resolução da impressora (dpi)') as HTMLSelectElement;

describe('a resolução da impressora no editor', () => {
  it('o modelo novo nasce com 203 dpi, e escolher 300 vai para o servidor', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    expect(seletorDeDpi().value).toBe('203');
    fireEvent.change(screen.getByLabelText('Nome do modelo'), { target: { value: 'Térmica 300' } });
    fireEvent.change(seletorDeDpi(), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar modelo' }));
    await waitFor(() => expect(enviado?.dpi).toBe(300));
  });

  it('a partir de uma folha pronta, nasce com 300 dpi (jato de tinta ou laser)', async () => {
    const folhaPronta = {
      id: 'a4_x', label: 'Folha A4 — 33 por folha', hint: '', midia: 'folha', widthMm: 63.5, heightMm: 25.4,
      columns: 3, rows: 11, campos: ['nome'],
    };
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[folhaPronta as never]} />);
    fireEvent.change(await screen.findByLabelText('Criar a partir de um formato pronto'), { target: { value: 'a4_x' } });
    expect(seletorDeDpi().value).toBe('300');
  });

  it('"Novo modelo" trocado para folha passa a 300 dpi (o padrão da folha), e volta a 203 no rolo (revisão)', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    expect(seletorDeDpi().value).toBe('203');
    fireEvent.click(screen.getByLabelText('Folha (A4 adesiva ou outra)'));
    expect(seletorDeDpi().value).toBe('300');
    fireEvent.change(screen.getByLabelText('Nome do modelo'), { target: { value: 'Gôndola A4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar modelo' }));
    await waitFor(() => expect(enviado?.dpi).toBe(300));
  });

  it('o dpi escolhido à mão não muda quando a mídia muda (revisão)', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    fireEvent.change(seletorDeDpi(), { target: { value: '600' } });
    fireEvent.click(screen.getByLabelText('Folha (A4 adesiva ou outra)'));
    expect(seletorDeDpi().value).toBe('600');
    fireEvent.click(screen.getByLabelText('Rolo (térmica de etiqueta)'));
    expect(seletorDeDpi().value).toBe('600');
  });

  it('editar um modelo de 600 dpi: o seletor mostra 600 e o salvar o mantém', async () => {
    existentes = [MODELO_600];
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    expect(seletorDeDpi().value).toBe('600');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar modelo' }));
    await waitFor(() => expect(enviado?.dpi).toBe(600));
  });
});
