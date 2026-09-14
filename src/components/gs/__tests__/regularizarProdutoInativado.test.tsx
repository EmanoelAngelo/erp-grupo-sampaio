/**
 * ============================================================================
 * "REGULARIZAR" DIZ QUAL PRODUTO FOI INATIVADO E O QUE FAZER (G-offline-sync-09)
 * ============================================================================
 *
 * O servidor passou a recusar o produto inativado com o nome e
 * `details: { productId, name, inativo: true }` — mas a frase dele é a do
 * BALCÃO: "Tire a linha do carrinho — ou, se a venda já aconteceu, reative o
 * produto e relance". Em Regularizar a venda já aconteceu e não há carrinho;
 * a tela repetia a frase crua e não dizia que descartar era a outra saída.
 *
 * Aqui: a frase é desta tela (reativar em Produtos e relançar, ou descartar —
 * dito a quem pode e a quem precisa pedir), o nome vem do servidor ou da linha
 * da própria venda, o link para Produtos só aparece na gestão, e a pendência
 * guardada com esse código explica a saída já na lista.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RegularizarVendasOffline } from '../RegularizarVendasOffline';
import { setSession } from '@/lib/api/client';

let recusadas: unknown[];
let respostaDoRelancamento: () => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const FRASE_DO_BALCAO =
  '"Bota Nova" não pode mais ser vendido: ele foi inativado em Produtos. Tire a linha do carrinho — ou, se a venda '
  + 'já aconteceu, reative o produto e relance.';

const BASE = {
  id: 'offsale-1',
  idempotencyKey: 'pdv-0b8f2c1e-4d3a-4f7e-9a61-5c2d7e8f9a10',
  label: 'venda do PDV',
  queuedAt: '2026-09-13T21:40:00.000Z',
  reportedAt: '2026-09-14T08:00:00.000Z',
  lastReportedAt: '2026-09-14T08:00:00.000Z',
  reportedBy: 'u-caixa-1',
  reportedByName: 'Caixa 1',
  terminalId: 't1',
  terminalName: 'Caixa 1',
  cashSessionId: 'sessao-caixa-1',
  receivedCents: 20000,
  itemsCount: 1,
  items: [{ productId: 'p-bota', name: 'Bota', quantity: 1, unitPriceCents: 20000 }],
  payments: [{ method: 'dinheiro', amountCents: 20000 }],
  status: 'pendente',
  errorCode: 'CORE_PRODUCT_NOT_FOUND',
  errorMessage: FRASE_DO_BALCAO,
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  vendaDaChave: null,
  gavetaDeDestino: { cashSessionId: 'sessao-caixa-1', terminalId: 't1', terminalName: 'Caixa 1', motivo: 'a_da_venda' },
};

function recusa(details: unknown) {
  return () => json({ error: { code: 'CORE_PRODUCT_NOT_FOUND', message: FRASE_DO_BALCAO, details } }, 404);
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: `u-${profileCode}`, login: profileCode, displayName: profileCode, profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste de regularizar produto inativado',
  );
}

beforeEach(() => {
  localStorage.clear();
  recusadas = [BASE];
  respostaDoRelancamento = recusa({ productId: 'p-bota', name: 'Bota Nova', inativo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/relaunch')) return respostaDoRelancamento();
      if (u.includes('/core/offline-sales')) return json({ items: recusadas });
      return json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste de regularizar produto inativado');
  localStorage.clear();
});

async function relancarEPegarOErro() {
  render(<RegularizarVendasOffline onClose={() => undefined} />);
  const c = await screen.findByTestId('venda-offline-recusada');
  fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
  const alerta = await within(c).findByRole('alert');
  return { c, alerta };
}

describe('G-offline-sync-09 — a recusa por produto inativado, dita na língua de Regularizar', () => {
  it('o caixa lê o nome, reativar e relançar, e que o descarte é pedido ao gerente — sem "carrinho" e sem link de gestão', async () => {
    entrarComo('operador_caixa_loja');
    const { c, alerta } = await relancarEPegarOErro();
    const texto = alerta.textContent ?? '';
    expect(texto).toMatch(/"Bota Nova" foi inativado em Produtos depois desta venda/);
    expect(texto).toMatch(/reative o produto em Produtos e relance/);
    expect(texto).toMatch(/peça a um gerente para descartá-la/);
    // A instrução do balcão não vale aqui: não há carrinho numa venda que já aconteceu.
    expect(texto).not.toMatch(/carrinho/i);
    // Produtos é tela do escritório: o caixa no PDV não recebe o link.
    expect(within(c).queryByRole('link', { name: /Abrir Produtos/i })).toBeNull();
  });

  it('o gerente lê que pode descartar, e recebe o link para Produtos', async () => {
    entrarComo('gerente_loja');
    const { alerta } = await relancarEPegarOErro();
    expect(alerta.textContent).toMatch(/"Bota Nova" foi inativado/);
    expect(alerta.textContent).toMatch(/descarte-a com o motivo/);
    expect(within(alerta).getByRole('link', { name: /Abrir Produtos/i }).getAttribute('href')).toBe('/sistema/produtos');
  });

  it('sem o nome no detalhe (servidor anterior), o nome vem da linha da própria venda', async () => {
    entrarComo('operador_caixa_loja');
    respostaDoRelancamento = recusa({ productId: 'p-bota', inativo: true });
    const { alerta } = await relancarEPegarOErro();
    expect(alerta.textContent).toMatch(/"Bota" foi inativado em Produtos/);
  });

  it('o produto que saiu do cadastro de vez não manda reativar: diz que não relança e aponta o descarte', async () => {
    entrarComo('gerente_loja');
    respostaDoRelancamento = recusa({ productId: 'p-bota' });
    const { alerta } = await relancarEPegarOErro();
    expect(alerta.textContent).toMatch(/"Bota" não existe mais no cadastro desta operação/);
    expect(alerta.textContent).toMatch(/descarte-a com o motivo/);
    expect(alerta.textContent).not.toMatch(/reative/);
  });

  it('a pendência guardada com a recusa do produto explica a saída já na lista', async () => {
    entrarComo('operador_caixa_loja');
    render(<RegularizarVendasOffline onClose={() => undefined} />);
    const c = await screen.findByTestId('venda-offline-recusada');
    const aviso = within(c).getByTestId('produto-inativo-na-lista').textContent ?? '';
    expect(aviso).toMatch(/Se o produto foi inativado, a saída é reativá-lo em Produtos e relançar/);
    expect(aviso).toMatch(/se a venda não vai existir, ela é descartada \(gerência\)/i);
  });

  // REVISÃO: o mesmo código vem do produto EXCLUÍDO (a exclusão passa quando ele
  // não tem histórico — e a venda guardada nunca chegou ao servidor). O aviso da
  // lista mandava sempre "A saída é reativar", sem o que reativar.
  it('a pendência do produto que saiu do cadastro não ouve só "reativar" na lista', async () => {
    entrarComo('operador_caixa_loja');
    recusadas = [
      {
        ...BASE,
        errorMessage: 'Produto não encontrado nesta operação — tire a linha do carrinho e bipe o produto de novo.',
      },
    ];
    render(<RegularizarVendasOffline onClose={() => undefined} />);
    const c = await screen.findByTestId('venda-offline-recusada');
    const aviso = within(c).getByTestId('produto-inativo-na-lista').textContent ?? '';
    expect(aviso).not.toMatch(/A saída é reativar/);
    expect(aviso).toMatch(/se ele saiu do cadastro, esta venda não relança/);
  });

  // REVISÃO: sem `details` nenhum, a tela afirmava "não tem como ser relançada"
  // — e o produto podia estar só inativado, com o dinheiro já recebido.
  it('a recusa sem detalhe não decide pelo descarte: diz os dois casos e aponta Produtos', async () => {
    entrarComo('gerente_loja');
    respostaDoRelancamento = () =>
      json({ error: { code: 'CORE_PRODUCT_NOT_FOUND', message: 'Produto não encontrado: p-bota' } }, 404);
    const { alerta } = await relancarEPegarOErro();
    const texto = alerta.textContent ?? '';
    expect(texto).toMatch(/Se ele foi inativado, reative o produto em Produtos e relance/);
    expect(texto).toMatch(/se saiu do cadastro, a venda não tem como ser relançada/);
    expect(texto).not.toMatch(/não existe mais no cadastro/);
    expect(within(alerta).getByRole('link', { name: /Abrir Produtos/i })).toBeTruthy();
  });
});
