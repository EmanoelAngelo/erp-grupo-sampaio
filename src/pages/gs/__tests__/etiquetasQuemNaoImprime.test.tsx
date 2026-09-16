/**
 * ETIQUETAS — A TELA NÃO OFERECE O QUE O SERVIDOR RECUSA (P00 das etiquetas).
 *
 * O DEFEITO: a tela é ROTA_GESTAO e a lista de candidatos é aberta ao
 * escritório inteiro (`products.view`), mas `POST /labels/sheet` e
 * `GET /labels/templates` cobram `labels.products.print`. O atendente abria a
 * tela, levava na cara uma caixa vermelha de "Falha ao carregar os modelos de
 * etiqueta", montava a fila mesmo assim e, no clique em "Gerar folha", via uma
 * janela em branco abrir e fechar e um 403 no lugar da folha.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido):
 *
 *   - tire o `!podeImprimir` de `motivoParaNaoGerar` e "Gerar folha" volta a
 *     ficar habilitado para quem o servidor recusa;
 *   - tire o `podeImprimir &&` do `<ModelosDeEtiqueta>` e a chamada a
 *     /labels/templates volta a sair (e com ela a caixa vermelha).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EtiquetasPage from '../EtiquetasPage';
import { setSession } from '@/lib/api/client';

let chamadas: string[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const FORMATO = {
  id: 'rolo_50x30', label: 'Rolo 50 × 30 mm', hint: 'Rolo simples.', midia: 'rolo',
  widthMm: 50, heightMm: 30, columns: 1, rows: null, campos: ['nome', 'preco', 'barras'],
};

const CANDIDATO = {
  productId: 'p1', name: 'Vassoura', internalCode: 'GS-1', barcode: '7891234567895',
  priceCents: 1990, listPriceCents: 1990, onSale: false, stockQuantity: 5, documentQuantity: null,
  avisoDoCodigo: null, rastreiaLote: false, lotes: [],
};

function entrar(capabilities: string[]) {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode: 'atendente' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste de quem não imprime etiqueta',
  );
}

beforeEach(() => {
  chamadas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const caminho = new URL(String(url), 'http://x').pathname.replace(/^\/api\/v1/, '');
      chamadas.push(`${(init?.method ?? 'GET').toUpperCase()} ${caminho}`);
      if (caminho === '/core/labels/catalog') {
        return json({
          sources: [{ id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false }],
          formats: [FORMATO],
          campos: [],
          defaultFormat: FORMATO.id,
          quantityModes: [{ id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' }],
        });
      }
      if (caminho === '/core/labels/candidates') {
        return json({ source: 'catalogo', candidates: [CANDIDATO], problemas: [], truncado: false });
      }
      if (caminho === '/core/labels/templates') {
        return json({ error: { code: 'API_FORBIDDEN', message: 'Sem acesso.' } }, 403);
      }
      return json({ items: [] });
    }),
  );
  vi.stubGlobal('open', vi.fn(() => null));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste de quem não imprime etiqueta');
});

function montar() {
  render(
    <MemoryRouter>
      <EtiquetasPage />
    </MemoryRouter>,
  );
}

describe('quem vê etiqueta mas não imprime', () => {
  it('o botão nasce desabilitado com o motivo escrito, e nenhum modelo é pedido ao servidor', async () => {
    entrar(['products.view']);
    montar();
    const botao = (await screen.findByRole('button', { name: /Gerar folha/ })) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    const motivo = await screen.findByTestId('motivo-para-nao-gerar');
    expect(motivo.textContent).toMatch(/não imprime/);
    expect(motivo.textContent).toMatch(/Usuários › Acesso/);
    // A caixa vermelha de "Falha ao carregar os modelos" vinha daqui.
    await waitFor(() => expect(chamadas).toContain('GET /core/labels/catalog'));
    expect(chamadas).not.toContain('GET /core/labels/templates');
    expect(screen.queryByText('Modelos de etiqueta')).toBeNull();
  });

  it('com a fila montada, o botão continua desabilitado — o trabalho não termina em 403', async () => {
    entrar(['products.view']);
    montar();
    fireEvent.change(await screen.findByPlaceholderText('Nome, código interno ou código de barras'), {
      target: { value: 'vass' },
    });
    fireEvent.click(await screen.findByLabelText('Selecionar Vassoura'));
    await screen.findByLabelText('Quantidade de etiquetas de Vassoura');
    expect((screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(chamadas).not.toContain('POST /core/labels/sheet');
  });

  it('quem imprime segue com os modelos e com o botão liberado assim que a fila tem item', async () => {
    entrar(['products.view', 'labels.products.print']);
    montar();
    await screen.findByText('Modelos de etiqueta');
    expect(chamadas).toContain('GET /core/labels/templates');
    expect((screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Nome, código interno ou código de barras'), {
      target: { value: 'vass' },
    });
    fireEvent.click(await screen.findByLabelText('Selecionar Vassoura'));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
