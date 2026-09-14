/**
 * O SELO DO PRODUTO SEM CÓDIGO, na lista de Etiquetas (C-etiquetas-R01).
 *
 * O selo "gera código ao imprimir" olhava só se o produto tinha código. Depois
 * que o servidor passou a gerar código SÓ quando o formato imprime código
 * (barras ou número) E quem pede tem products.manage, o selo mentia em dois
 * casos: no cartaz de gôndola (nada é gerado) e para quem só imprime (a folha
 * sai sem barras). Agora o selo segue a regra do servidor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EtiquetasPage from '../EtiquetasPage';
import { setSession } from '@/lib/api/client';

let rotas: Record<string, (url: string) => Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const COM_BARRAS = {
  id: 'rolo_50x30', label: 'Rolo 50 × 30 mm', hint: 'Dica do rolo com barras.', midia: 'rolo',
  widthMm: 50, heightMm: 30, columns: 1, rows: null, campos: ['nome', 'preco', 'barras'],
};
const SO_NUMERO = { ...COM_BARRAS, id: 'rolo_numero', hint: 'Dica do rolo só com o número.', campos: ['nome', 'ean'] };
const CARTAZ = {
  ...COM_BARRAS, id: 'a4_gondola_2x5', label: 'Cartaz de gôndola', hint: 'Dica do cartaz de gôndola.', midia: 'folha',
  campos: ['nome', 'atributos', 'preco', 'codigo', 'empresa'],
};

function catalogo(formato: typeof COM_BARRAS) {
  return {
    sources: [{ id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false }],
    formats: [formato],
    campos: [],
    defaultFormat: formato.id,
    quantityModes: [{ id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' }],
  };
}

function candidato(id: string, name: string, barcode: string | null) {
  return {
    productId: id, name, internalCode: `GS-${id}`, barcode, priceCents: 990, listPriceCents: 990,
    onSale: false, stockQuantity: 3, documentQuantity: null, avisoDoCodigo: null,
  };
}

function entrar(capabilities: string[]) {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste do selo do código na lista de etiquetas',
  );
}

function comFormato(formato: typeof COM_BARRAS) {
  rotas = {
    'GET /core/labels/catalog': () => json(catalogo(formato)),
    'GET /core/labels/templates': () => json({ items: [], campos: [] }),
    'GET /core/labels/candidates': () =>
      json({
        source: 'catalogo',
        candidates: [candidato('p1', 'Vassoura', null), candidato('p2', 'Rodo', '7891234567895')],
        problemas: [],
        truncado: false,
      }),
  };
}

beforeEach(() => {
  comFormato(COM_BARRAS);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const caminho = new URL(String(url), 'http://x').pathname.replace(/^\/api\/v1/, '');
      const rota = rotas[`${(init?.method ?? 'GET').toUpperCase()} ${caminho}`];
      return rota ? rota(String(url)) : json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste do selo do código');
});

/** Abre a tela, espera o formato do catálogo valer (a dica dele aparece) e busca. Devolve as duas linhas. */
async function listar(formato: typeof COM_BARRAS) {
  render(
    <MemoryRouter initialEntries={['/sistema/etiquetas']}>
      <EtiquetasPage />
    </MemoryRouter>,
  );
  await screen.findByText(formato.hint);
  fireEvent.change(screen.getByPlaceholderText('Nome, código interno ou código de barras'), { target: { value: 'limp' } });
  const vassoura = (await screen.findByLabelText('Selecionar Vassoura')).closest('tr')!;
  const rodo = screen.getByLabelText('Selecionar Rodo').closest('tr')!;
  return { vassoura: within(vassoura), rodo: within(rodo) };
}

describe('o selo do produto sem código segue a regra do servidor', () => {
  it('quem grava código (products.manage) e o formato imprime barras: "gera código ao imprimir" só no produto sem código', async () => {
    entrar(['labels.products.print', 'products.manage']);
    const { vassoura, rodo } = await listar(COM_BARRAS);
    expect(vassoura.getByText('gera código ao imprimir')).toBeTruthy();
    expect(rodo.queryByText('gera código ao imprimir')).toBeNull();
    expect(vassoura.queryByText(/sai sem barras/)).toBeNull();
  });

  it('o formato imprime só o NÚMERO do código: o servidor também gera, e o selo aparece', async () => {
    comFormato(SO_NUMERO);
    entrar(['labels.products.print', 'products.manage']);
    const { vassoura } = await listar(SO_NUMERO);
    expect(vassoura.getByText('gera código ao imprimir')).toBeTruthy();
  });

  it('cartaz de gôndola (sem barras nem número): nenhum selo — nenhum código nasce', async () => {
    comFormato(CARTAZ);
    entrar(['labels.products.print', 'products.manage']);
    const { vassoura } = await listar(CARTAZ);
    expect(vassoura.queryByText('gera código ao imprimir')).toBeNull();
    expect(vassoura.queryByText(/sai sem barras/)).toBeNull();
  });

  it('quem só imprime (sem products.manage): o selo diz que sai sem barras, e não promete gerar', async () => {
    entrar(['labels.products.print']);
    const { vassoura, rodo } = await listar(COM_BARRAS);
    expect(vassoura.getByText('sem código — sai sem barras')).toBeTruthy();
    expect(vassoura.queryByText('gera código ao imprimir')).toBeNull();
    expect(rodo.queryByText(/sai sem barras/)).toBeNull();
  });

  it('quem só imprime, no cartaz de gôndola: nenhum selo (o formato não leva código)', async () => {
    comFormato(CARTAZ);
    entrar(['labels.products.print']);
    const { vassoura } = await listar(CARTAZ);
    expect(vassoura.queryByText(/sai sem barras/)).toBeNull();
    expect(vassoura.queryByText('gera código ao imprimir')).toBeNull();
  });
});
