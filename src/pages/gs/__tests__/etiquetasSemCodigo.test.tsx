/**
 * QUEM SÓ IMPRIME ETIQUETA fica sabendo, ANTES de gerar a folha, que o produto
 * sem código de barras sai sem barras (PED-etq-01).
 *
 * Gravar código no produto é mexer no cadastro (products.manage). Com só
 * "Etiquetas de produto", a folha sai e o item sem código vai sem barras — e a
 * tela só dizia isso depois do papel gasto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EtiquetasPage from '../EtiquetasPage';
import { setSession } from '@/lib/api/client';

let rotas: Record<string, (url: string) => Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CATALOGO = {
  sources: [{ id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false }],
  formats: [
    { id: 'rolo_50x30', label: 'Rolo 50 × 30 mm', hint: 'Térmica.', midia: 'rolo', widthMm: 50, heightMm: 30, columns: 1, rows: null, campos: ['nome', 'barras'] },
  ],
  campos: [],
  defaultFormat: 'rolo_50x30',
  quantityModes: [{ id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' }],
};

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
      user: { id: 'u1', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste do aviso de produto sem código',
  );
}

beforeEach(() => {
  rotas = {
    'GET /core/labels/catalog': () => json(CATALOGO),
    'GET /core/labels/templates': () => json({ items: [], campos: [] }),
    'GET /core/labels/candidates': () =>
      json({
        source: 'catalogo',
        candidates: [candidato('p1', 'Vassoura', null), candidato('p2', 'Rodo', '7891234567895')],
        problemas: [],
        truncado: false,
      }),
  };
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
  setSession(null, 'LOGOUT', 'fim do teste do aviso de produto sem código');
});

async function porNaFila(...nomes: string[]) {
  render(
    <MemoryRouter initialEntries={['/sistema/etiquetas']}>
      <EtiquetasPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText('Nome, código interno ou código de barras'), { target: { value: 'limp' } });
  for (const nome of nomes) fireEvent.click(await screen.findByLabelText(`Selecionar ${nome}`));
}

describe('o produto sem código, para quem só imprime', () => {
  it('só "Etiquetas de produto": a fila diz qual item sai sem barras e onde gerar o código', async () => {
    entrar(['labels.products.print']);
    await porNaFila('Vassoura', 'Rodo');
    const aviso = await screen.findByTestId('aviso-sem-codigo');
    expect(aviso.textContent).toMatch(/Sem código de barras: Vassoura\./);
    expect(aviso.textContent).not.toMatch(/Rodo/);
    expect(aviso.textContent).toMatch(/não grava código no cadastro: estas saem SEM barras/);
    expect(aviso.textContent).toMatch(/Gerar código de barras/);
  });

  it('com products.manage, a folha grava o código: nenhum aviso', async () => {
    entrar(['labels.products.print', 'products.manage']);
    await porNaFila('Vassoura');
    expect(screen.queryByTestId('aviso-sem-codigo')).toBeNull();
  });

  it('só imprime, mas o formato não imprime código (só nome e preço): nenhum aviso falso (revisão)', async () => {
    rotas['GET /core/labels/catalog'] = () =>
      json({
        ...CATALOGO,
        formats: [{ ...CATALOGO.formats[0], id: 'rolo_preco', campos: ['nome', 'preco'] }],
        defaultFormat: 'rolo_preco',
      });
    entrar(['labels.products.print']);
    await porNaFila('Vassoura');
    await screen.findByLabelText('Quantidade de etiquetas de Vassoura');
    expect(screen.queryByTestId('aviso-sem-codigo')).toBeNull();
  });

  it('só imprime, mas todos na fila têm código: nenhum aviso', async () => {
    entrar(['labels.products.print']);
    await porNaFila('Rodo');
    expect(screen.queryByTestId('aviso-sem-codigo')).toBeNull();
  });
});
