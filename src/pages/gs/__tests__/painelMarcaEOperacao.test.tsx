/**
 * ============================================================================
 * O PAINEL: MARCA E OPERAÇÃO — GAP-V44 / GAP-V46
 * ============================================================================
 *
 * ## Os dois defeitos que esta tela carregava
 *
 * 1. VENDAS POR MARCA não existiam em superfície nenhuma. O ingrediente estava
 *    em `core_products.brand` desde sempre; os insights agregavam por produto,
 *    por operação e por margem — nunca por marca.
 *
 * 2. O PAINEL ERA MONO-EMPRESA, e a troca custava um `window.location.reload()`
 *    inteiro (`AppShell.tsx`). Comparar o dia de duas lojas era: trocar a
 *    operação ativa na topbar, esperar a página inteira recarregar, olhar,
 *    trocar de volta, esperar de novo.
 *
 * ## Como cada caso fica vermelho
 *
 *   - some com o `byBrand` do payload e o cartão some — o caso da soma cai;
 *   - rateie o desconto de rodapé entre as marcas e o caso da parcela não
 *     alocada cai, com a conta na mão;
 *   - desenhe o seletor de operação para quem tem UMA empresa só e o caso do
 *     seletor cai (um controle com uma opção é ruído);
 *   - troque a chamada por um `reload` e o caso da troca cai: a segunda
 *     requisição nunca acontece, porque a página inteira é jogada fora.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PainelPage from '../PainelPage';

let urls: string[] = [];

const CONCEITO = 'empresa-conceito';
const GRINGA = 'empresa-gringa';

function painel(companyId: string, extras: Record<string, unknown> = {}) {
  return {
    revenueCents: 29_000,
    salesCount: 2,
    averageTicketCents: 14_500,
    openReceivablesCents: 0,
    byDay: [{ day: '2026-06-10', sales_count: 2, revenue_cents: 29_000 }],
    topProducts: [],
    bySeller: [],
    byBrand: [
      { brand: 'Nike', quantity: 2, sales_count: 1, revenue_cents: 20_000 },
      { brand: 'Adidas', quantity: 1, sales_count: 1, revenue_cents: 6_000 },
      { brand: 'Sem marca', quantity: 3, sales_count: 1, revenue_cents: 3_000 },
    ],
    byBrandUnallocatedCents: 0,
    lowStock: [],
    certificateAlert: null,
    companyId,
    companies: [
      { id: CONCEITO, tradeName: 'Conceito' },
      { id: GRINGA, tradeName: 'Gringa' },
    ],
    ...extras,
  };
}

function json(corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Cada empresa devolve o próprio faturamento — é o que a troca tem de mostrar. */
function servidor(companies?: { id: string; tradeName: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endereco = String(url);
      urls.push(endereco);
      const pedida = /companyId=([^&]+)/.exec(endereco)?.[1];
      const alvo = pedida ?? CONCEITO;
      const extras: Record<string, unknown> = {};
      if (companies) extras.companies = companies;
      if (alvo === GRINGA) extras.revenueCents = 88_000;
      return json(painel(alvo, extras));
    }),
  );
}

function entrar() {
  setSession(
    {
      accessToken: 'token-do-gerente',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: CONCEITO, slug: 'conceito', tradeName: 'Conceito', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do painel',
  );
}

async function montar(companies?: { id: string; tradeName: string }[]) {
  entrar();
  servidor(companies);
  render(
    <MemoryRouter>
      <PainelPage />
    </MemoryRouter>,
  );
  await screen.findByText('Vendas por marca');
}

beforeEach(() => {
  urls = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do painel');
  localStorage.clear();
});

describe('vendas por marca aparecem no painel', () => {
  it('cada marca com o dinheiro dela, e "Sem marca" como grupo', async () => {
    await montar();
    const cartao = screen.getByText('Vendas por marca').closest('section')!;
    expect(within(cartao).getByText('Nike')).toBeTruthy();
    expect(within(cartao).getByText('Adidas')).toBeTruthy();
    // "Sem marca" é um GRUPO: filtrá-lo faria o cartão nascer vazio no banco
    // real, onde ZERO de dezenove produtos têm marca preenchida.
    expect(within(cartao).getByText('Sem marca')).toBeTruthy();
    expect(within(cartao).getByText('R$ 200,00')).toBeTruthy();
  });

  it('sem venda no período, o cartão diz isso em vez de sumir', async () => {
    entrar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(painel(CONCEITO, { byBrand: [], revenueCents: 0, salesCount: 0 }))),
    );
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    // Um cartão que desaparece faz quem procurou o recorte achar que ele não
    // existe no sistema.
    await screen.findByText('Vendas por marca');
    await screen.findByText('Nenhuma venda no período');
  });

  it('A PARCELA NÃO RATEADA é declarada quando existe', async () => {
    /*
      O desconto de rodapé não tem dono entre as linhas. Ratear exigiria
      escolher um critério que ninguém decidiu; então ele é NOMEADO, e a soma
      das barras mais essa parcela fecha com o faturamento.
    */
    await montar();
    expect(screen.queryByText(/não pertencem a marca nenhuma/)).toBeNull();

    cleanup();
    entrar();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(painel(CONCEITO, { byBrandUnallocatedCents: -500 }))),
    );
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    await screen.findByText(/não pertencem a marca nenhuma/);
    await screen.findByText(/-R\$\s?5,00|R\$\s?-5,00/);
  });
});

describe('o painel troca de operação sem recarregar a página', () => {
  it('o seletor lista as operações do VÍNCULO, que vêm no mesmo payload', async () => {
    await montar();
    const seletor = screen.getByLabelText('Operação:') as HTMLSelectElement;
    expect([...seletor.options].map((o) => o.textContent)).toEqual(['Conceito', 'Gringa']);
  });

  it('A MORDIDA: escolher a outra operação REFAZ a consulta com o companyId', async () => {
    /*
      Se a troca voltasse a ser `window.location.reload()`, nenhuma segunda
      requisição aconteceria — a página inteira seria jogada fora, e este caso
      ficaria vermelho na contagem de URLs.
    */
    await montar();
    fireEvent.change(screen.getByLabelText('Operação:'), { target: { value: GRINGA } });

    await waitFor(() =>
      expect(urls.some((u) => u.includes(`companyId=${GRINGA}`))).toBe(true),
    );
    // E o número muda com ela: R$ 880,00 é o faturamento da Gringa no dublê.
    await screen.findByText('R$ 880,00');
  });

  it('quem tem UMA operação só não vê seletor nenhum', async () => {
    // Um controle com uma opção é ruído: ocupa espaço no cabeçalho do painel
    // que o gestor abre todo dia e não serve para nada.
    await montar([{ id: CONCEITO, tradeName: 'Conceito' }]);
    expect(screen.queryByLabelText('Operação:')).toBeNull();
  });
});
