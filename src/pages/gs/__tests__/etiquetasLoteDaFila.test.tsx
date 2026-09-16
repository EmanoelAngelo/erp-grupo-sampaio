/**
 * A ESCOLHA DE LOTE NA FILA DE ETIQUETAS (P00 das etiquetas).
 *
 * O DEFEITO: a etiqueta com validade saía com o lote que vence primeiro entre
 * os que têm saldo (o FEFO do servidor), e a tela não dizia qual era nem
 * deixava trocar — embora `POST /labels/sheet` sempre tenha aceitado `batchId`
 * por item. Quem etiquetava a caixa recém-chegada colava nela a validade do
 * lote VELHO que ainda estava na prateleira.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido):
 *
 *   - tire o `batchId` do corpo em `gerarFolha` e "o lote escolhido vai no
 *     corpo" fica vermelho;
 *   - troque `formatoImprimeLote` por `true` e o caso do formato sem validade
 *     fica vermelho (o seletor aparece onde não muda o adesivo);
 *   - tire o aviso de `listaSemLote` e o caso do iogurte sem lote fica vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EtiquetasPage from '../EtiquetasPage';
import { setSession } from '@/lib/api/client';

let rotas: Record<string, (url: string, body: unknown) => Response>;
let corpoDaFolha: Record<string, unknown> | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const COM_VALIDADE = {
  id: 'rolo_validade', label: 'Rolo 50 × 40 com validade', hint: 'Rolo com validade e lote.', midia: 'rolo',
  widthMm: 50, heightMm: 40, columns: 1, rows: null,
  campos: ['nome', 'preco', 'validade', 'lote', 'barras'],
};
const SEM_VALIDADE = {
  ...COM_VALIDADE, id: 'rolo_simples', label: 'Rolo 50 × 30', hint: 'Rolo sem validade.',
  campos: ['nome', 'preco', 'barras'],
};

function catalogo() {
  return {
    sources: [{ id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false }],
    formats: [COM_VALIDADE, SEM_VALIDADE],
    campos: [],
    defaultFormat: COM_VALIDADE.id,
    quantityModes: [{ id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' }],
  };
}

const IOGURTE = {
  productId: 'p-iogurte', name: 'Iogurte natural', internalCode: 'GS-1', barcode: '7891234567895',
  priceCents: 350, listPriceCents: 350, onSale: false, stockQuantity: 16, documentQuantity: null,
  avisoDoCodigo: null,
  rastreiaLote: true,
  lotes: [
    { batchId: 'b-out', code: 'L-OUT', expiresOn: '2026-10-05', quantity: 4 },
    { batchId: 'b-dez', code: 'L-DEZ', expiresOn: '2026-12-31', quantity: 12 },
  ],
};
/** Controla lote e não tem nenhum com saldo: a etiqueta sai sem validade. */
const REQUEIJAO = {
  ...IOGURTE, productId: 'p-requeijao', name: 'Requeijão cremoso', internalCode: 'GS-2',
  barcode: '7891234567802', rastreiaLote: true, lotes: [],
};

function entrar() {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: {
        capabilities: ['products.view', 'products.manage', 'labels.products.print', 'settings.printers.manage'],
        modelo: { personalizado: false },
        casa: '/sistema',
      },
    } as never,
    'LOGIN',
    'teste do lote na fila de etiquetas',
  );
}

beforeEach(() => {
  corpoDaFolha = null;
  entrar();
  rotas = {
    'GET /core/labels/catalog': () => json(catalogo()),
    'GET /core/labels/templates': () => json({ items: [], campos: [] }),
    'GET /core/labels/prints': () => json({ items: [] }),
    'GET /core/print/printers': () => json({ items: [] }),
    'GET /core/labels/candidates': () =>
      json({ source: 'catalogo', candidates: [IOGURTE, REQUEIJAO], problemas: [], truncado: false }),
    'POST /core/labels/sheet': (_url, body) => {
      corpoDaFolha = body as Record<string, unknown>;
      return json({ html: '<html></html>', etiquetas: 1, folhas: 1, perfil: 'navegador', arquivo: null, comandos: null, avisos: [], semPreco: [], promocoes: [], impressaoId: 'i1' });
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const caminho = new URL(String(url), 'http://x').pathname.replace(/^\/api\/v1/, '');
      const rota = rotas[`${(init?.method ?? 'GET').toUpperCase()} ${caminho}`];
      const corpo = init?.body ? JSON.parse(init.body) : null;
      return rota ? rota(String(url), corpo) : json({ items: [] });
    }),
  );
  vi.stubGlobal('open', vi.fn(() => null));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste do lote na fila');
});

async function montarComOIogurteNaFila() {
  render(
    <MemoryRouter>
      <EtiquetasPage />
    </MemoryRouter>,
  );
  const busca = await screen.findByPlaceholderText('Nome, código interno ou código de barras');
  fireEvent.change(busca, { target: { value: 'io' } });
  const marcar = await screen.findByLabelText('Selecionar Iogurte natural');
  fireEvent.click(marcar);
  return marcar;
}

describe('a fila diz qual lote vai para o papel, e deixa trocar', () => {
  it('o automático é o que vence primeiro, e o seletor lista os dois com validade e saldo', async () => {
    await montarComOIogurteNaFila();
    const seletor = (await screen.findByLabelText('Lote de Iogurte natural')) as HTMLSelectElement;
    expect(seletor.value).toBe('');
    const opcoes = [...seletor.options].map((o) => o.textContent);
    expect(opcoes[0]).toBe('Lote automático — L-OUT · vence 05/10/2026 · 4');
    expect(opcoes[1]).toBe('L-OUT · vence 05/10/2026 · 4');
    expect(opcoes[2]).toBe('L-DEZ · vence 31/12/2026 · 12');
  });

  it('o lote escolhido vai no corpo da folha; sem escolher, o corpo não manda lote nenhum', async () => {
    await montarComOIogurteNaFila();
    fireEvent.click(screen.getByRole('button', { name: /Gerar folha/ }));
    await waitFor(() => expect(corpoDaFolha).not.toBeNull());
    expect((corpoDaFolha as { items: unknown[] }).items).toEqual([{ productId: 'p-iogurte', quantity: 1 }]);

    corpoDaFolha = null;
    fireEvent.change(await screen.findByLabelText('Lote de Iogurte natural'), { target: { value: 'b-dez' } });
    fireEvent.click(screen.getByRole('button', { name: /Gerar folha/ }));
    await waitFor(() => expect(corpoDaFolha).not.toBeNull());
    expect((corpoDaFolha as { items: unknown[] }).items).toEqual([
      { productId: 'p-iogurte', quantity: 1, batchId: 'b-dez' },
    ]);
  });

  it('no formato que não imprime validade nem lote, o seletor some e o corpo volta sem lote', async () => {
    await montarComOIogurteNaFila();
    fireEvent.change(await screen.findByLabelText('Lote de Iogurte natural'), { target: { value: 'b-dez' } });
    fireEvent.change(screen.getByLabelText('Formato da etiqueta'), { target: { value: SEM_VALIDADE.id } });
    await waitFor(() => expect(screen.queryByLabelText('Lote de Iogurte natural')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Gerar folha/ }));
    await waitFor(() => expect(corpoDaFolha).not.toBeNull());
    expect((corpoDaFolha as { items: unknown[] }).items).toEqual([{ productId: 'p-iogurte', quantity: 1 }]);
  });

  it('quem controla lote e não tem nenhum com saldo é avisado ANTES de gastar o rolo', async () => {
    render(
      <MemoryRouter>
        <EtiquetasPage />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByPlaceholderText('Nome, código interno ou código de barras'), {
      target: { value: 'requeij' },
    });
    fireEvent.click(await screen.findByLabelText('Selecionar Requeijão cremoso'));
    const aviso = await screen.findByTestId('aviso-sem-lote');
    expect(aviso.textContent).toMatch(/Requeijão cremoso/);
    expect(aviso.textContent).toMatch(/SEM validade/);
    // Ele não tem lote com saldo: não há o que escolher.
    expect(screen.queryByLabelText('Lote de Requeijão cremoso')).toBeNull();
  });
});
