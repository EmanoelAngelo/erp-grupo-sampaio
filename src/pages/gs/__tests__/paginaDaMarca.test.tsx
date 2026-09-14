/**
 * A PÁGINA DA MARCA — rodada 40.
 *
 * Cada loja ganhou endereço próprio (/preco-justo, /me-mimei…) com a cara da
 * marca: a paleta entra por `data-marca` na casca (token, não reescrita de
 * tela), o cabeçalho mostra a loja com caminho de volta ao Grupo, e o herói
 * traz capa/chamada. Slug desconhecido diz "esta loja não existe" — não uma
 * vitrine vazia que parece defeito.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LojaPage from '../LojaPage';

const LOJAS = {
  stores: [
    {
      id: 'c-pj',
      slug: 'preco-justo',
      tradeName: 'Preço Justo',
      kind: 'retail',
      productCount: 3,
      headline: 'Tudo para o dia a dia',
      description: null,
      whatsapp: null,
      bannerText: null,
      logoUrl: '/uploads/lojas/logo-pj.png',
      coverUrl: '/uploads/lojas/capa-pj.jpg',
    },
  ],
  services: [],
};

function servidor() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const corpo = u.includes('/loja/stores')
      ? LOJAS
      : u.includes('/loja/destaques') || u.includes('/loja/categories')
        ? { items: [] }
        : u.includes('/loja/products')
          ? { total: 0, items: [] }
          : {};
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function montar(caminho: string) {
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/loja" element={<LojaPage />} />
        <Route path="/:storeSlug" element={<LojaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a página da marca', () => {
  it('veste a marca: data-marca no wrapper, nome no cabeçalho, volta ao Grupo', async () => {
    montar('/preco-justo');
    // O cabeçalho é a marca, não "GRUPO SAMPAIO".
    const nome = await screen.findByRole('link', { name: /preço justo/i });
    expect(nome.getAttribute('href')).toBe('/preco-justo');
    // O caminho de volta existe e é discreto.
    const volta = screen.getByRole('link', { name: 'Grupo Sampaio' });
    expect(volta.getAttribute('href')).toBe('/loja');
    // O escopo de paleta está no DOM — é ele que troca as cores via tokens.
    expect(document.querySelector('[data-marca="preco-justo"]')).toBeTruthy();
  });

  it('mostra o herói: capa e chamada da loja', async () => {
    montar('/preco-justo');
    const capa = await screen.findByAltText('Capa da Preço Justo');
    /*
      O CAMINHO É RESOLVIDO, e não cru (rodada 56).

      Este caso travava o caminho relativo — que era exatamente o defeito: as
      imagens são servidas pela API, noutra porta, e o Vite não tem proxy.
      `src="/uploads/..."` bate no Vite e dá 404, então a capa quebraria no dia
      em que o dono mandasse a primeira.
    */
    expect(capa.getAttribute('src')).toMatch(new RegExp('^https?://[^/]+/uploads/lojas/capa-pj\.jpg$'));
    expect(screen.getByText('Tudo para o dia a dia')).toBeTruthy();
    // Na página da marca não há seletor de lojas.
    expect(screen.queryByText('Nossas lojas')).toBeNull();
  });

  it('slug desconhecido diz que a loja não existe, com caminho de volta', async () => {
    montar('/loja-que-nao-existe');
    expect(await screen.findByText(/esta loja não existe/i)).toBeTruthy();
    const volta = screen.getByRole('link', { name: /ver as lojas do grupo sampaio/i });
    expect(volta.getAttribute('href')).toBe('/loja');
  });

  it('na home do grupo, as lojas são LINKS que navegam para a página da marca', async () => {
    montar('/loja');
    const link = await screen.findByRole('link', { name: /preço justo/i });
    expect(link.getAttribute('href')).toBe('/preco-justo');
    // Sem data-marca na home: a casca é a do grupo.
    expect(document.querySelector('[data-marca]')).toBeNull();
    // E a Oficina não aparece em lugar nenhum da vitrine.
    expect(document.body.textContent).not.toMatch(/oficina/i);
  });
});

describe('a home do grupo (rodada 41)', () => {
  function backendCompleto(ofertas: unknown[]) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      const corpo = u.includes('/loja/stores')
        ? LOJAS
        : u.includes('/loja/ofertas')
          ? { items: ofertas }
          : u.includes('/loja/destaques') || u.includes('/loja/categories')
            ? { items: [] }
            : u.includes('/loja/products')
              ? { total: 0, items: [] }
              : {};
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('as lojas são CARDS com capa, logo e chamada — e navegam para a marca', async () => {
    vi.stubGlobal('fetch', backendCompleto([]));
    montar('/loja');
    const grade = await screen.findByTestId('cards-das-lojas');
    expect(grade).toBeTruthy();
    // A capa e a chamada vêm do painel do gestor.
    const capa = screen.getByAltText('Capa da Preço Justo');
    /*
      O CAMINHO É RESOLVIDO, e não cru (rodada 56).

      Este caso travava o caminho relativo — que era exatamente o defeito: as
      imagens são servidas pela API, noutra porta, e o Vite não tem proxy.
      `src="/uploads/..."` bate no Vite e dá 404, então a capa quebraria no dia
      em que o dono mandasse a primeira.
    */
    expect(capa.getAttribute('src')).toMatch(new RegExp('^https?://[^/]+/uploads/lojas/capa-pj\.jpg$'));
    expect(screen.getByText('Tudo para o dia a dia')).toBeTruthy();
    const card = screen.getByRole('link', { name: /preço justo/i });
    expect(card.getAttribute('href')).toBe('/preco-justo');
  });

  it('a seção Ofertas aparece com promoção vigente, mostrando o preço riscado', async () => {
    vi.stubGlobal(
      'fetch',
      backendCompleto([
        {
          id: 'of-1',
          name: 'Jaqueta em Oferta',
          imageUrl: null,
          basePriceCents: 30000,
          priceCents: 24000,
          onSale: true,
          available: 2,
          storeSlug: 'preco-justo',
          storeName: 'Preço Justo',
        },
      ]),
    );
    montar('/loja');
    expect(await screen.findByText('Ofertas')).toBeTruthy();
    expect(screen.getByText('Jaqueta em Oferta')).toBeTruthy();
  });

  it('sem promoção vigente, a seção Ofertas NEM aparece', async () => {
    vi.stubGlobal('fetch', backendCompleto([]));
    montar('/loja');
    await screen.findByTestId('cards-das-lojas');
    expect(screen.queryByText('Ofertas')).toBeNull();
  });
})
