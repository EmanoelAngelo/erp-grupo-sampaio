/**
 * ============================================================================
 * "REGULARIZAR" TEM SAÍDA PARA A VENDA RECUSADA PELO PREÇO (G-offline-sync-08)
 * ============================================================================
 *
 * A venda feita sem servidor cobrou no cartão o preço que a tela conhecia; o
 * preço baixou antes de ela subir, e o servidor recusou com 409
 * `CORE_SALE_TOTAL_CHANGED` (`details.linhas[].vigenteCents`). Em "Regularizar"
 * o relançamento repetia o mesmo corpo e tomava a mesma recusa, com a frase
 * "atualize o carrinho" — sem carrinho, sem saída.
 *
 * Agora o cartão mostra o preço da venda, o de hoje e a diferença, e oferece:
 * relançar pelo preço de agora (devolvendo a diferença) ou, para a gerência,
 * manter o valor cobrado com a diferença como acréscimo. A escolha vai ao
 * servidor, que faz a conta e registra a decisão.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RegularizarVendasOffline } from '../RegularizarVendasOffline';
import { setSession } from '@/lib/api/client';

interface Pedido {
  url: string;
  method: string;
  body: unknown;
}

let pedidos: Pedido[];
let respostasDoRelancamento: (() => Response)[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RECUSA_DO_PRECO =
  'O preço mudou depois que o item entrou no carrinho — "Jaqueta jeans" entrou em promoção: de R$ 50,00 para R$ 40,00.';

const PENDENCIA = {
  id: 'offsale-preco',
  idempotencyKey: 'pdv-7c1d2e3f-aaaa-bbbb-cccc-0a1b2c3d4e5f',
  label: 'venda do PDV',
  queuedAt: '2026-09-13T21:40:00.000Z',
  reportedAt: '2026-09-14T08:00:00.000Z',
  lastReportedAt: '2026-09-14T08:00:00.000Z',
  reportedBy: 'u-caixa',
  reportedByName: 'Caixa 1',
  terminalId: 't1',
  terminalName: 'Caixa 1',
  cashSessionId: 'sessao-caixa-1',
  receivedCents: 5000,
  itemsCount: 1,
  items: [{ productId: 'p-jaqueta', name: 'Jaqueta jeans', quantity: 1, unitPriceCents: 5000 }],
  payments: [{ method: 'debito', amountCents: 5000 }],
  status: 'pendente',
  errorCode: 'CORE_SALE_TOTAL_CHANGED',
  errorMessage: RECUSA_DO_PRECO,
  attempts: 1,
  saleId: null,
  saleNumber: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  vendaDaChave: null,
  gavetaDeDestino: { cashSessionId: 'sessao-caixa-1', terminalId: 't1', terminalName: 'Caixa 1', motivo: 'a_da_venda' },
};

/** A recusa que o servidor devolve ao relançar o mesmo corpo. */
const RECUSADO_PELO_PRECO = () =>
  json(
    {
      error: {
        code: 'CORE_SALE_TOTAL_CHANGED',
        message: RECUSA_DO_PRECO,
        details: {
          totalCents: 4000,
          aCobrarCents: 4000,
          recebidoCents: 5000,
          diferencaCents: 1000,
          linhas: [
            { productId: 'p-jaqueta', name: 'Jaqueta jeans', informadoCents: 5000, vigenteCents: 4000, fonte: 'promocao' },
          ],
        },
      },
    },
    409,
  );

function relancadaCom(ajuste: Record<string, unknown>, total: number) {
  return () =>
    json(
      {
        sale: { id: 's-91', number: 91, total_cents: total },
        duplicated: false,
        pendencia: { ...PENDENCIA, status: 'regularizada' },
        ajusteDePreco: ajuste,
      },
      201,
    );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste do preço mudado em regularizar',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  respostasDoRelancamento = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      pedidos.push({ url: u, method, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
      if (u.includes('/relaunch')) return (respostasDoRelancamento.shift() ?? RECUSADO_PELO_PRECO)();
      if (u.includes('/core/offline-sales')) return json({ items: [PENDENCIA] });
      return json({ items: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do preço mudado em regularizar');
  localStorage.clear();
});

function relancamentos() {
  return pedidos.filter((p) => p.url.includes('/relaunch'));
}

async function cartao() {
  render(<RegularizarVendasOffline onClose={() => undefined} />);
  return screen.findByTestId('venda-offline-recusada');
}

describe('G-offline-sync-08 — a venda recusada pelo preço tem saída guiada', () => {
  it('o caixa vê o preço da venda, o de hoje e a diferença, e relança pelo preço de agora', async () => {
    entrarComo('operador_caixa_loja');
    respostasDoRelancamento = [
      RECUSADO_PELO_PRECO,
      relancadaCom(
        {
          modo: 'preco_de_agora',
          diferencaCents: 1000,
          linhas: [{ productId: 'p-jaqueta', name: 'Jaqueta jeans', quantity: 1, informadoCents: 5000, vigenteCents: 4000 }],
          estornoCents: 1000,
          devolverEmDinheiroCents: 0,
          acrescimoCents: 0,
          frase: 'Relançada pelo preço de agora. Devolver R$ 10,00 ao cliente: R$ 10,00 de estorno no aparelho do cartão.',
        },
        4000,
      ),
    ];
    const c = await cartao();
    // A lista já diz que a recusa foi pelo preço, e para onde ir.
    expect(within(c).getByTestId('preco-mudou-na-lista').textContent).toMatch(/baixou depois desta venda/);

    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    const quadro = await within(c).findByTestId('preco-mudou');
    expect(quadro.textContent).toMatch(/Jaqueta jeans: vendido a R\$\s50,00, hoje R\$\s40,00/);
    expect(quadro.textContent).toMatch(/10,00 mais barata/);
    // O botão que só repete a recusa sai de cena; ficam as saídas.
    expect(within(c).queryByRole('button', { name: /Relançar na gaveta aberta/i })).toBeNull();
    // Manter o valor cobrado é da gerência: para o caixa, dito, e sem botão.
    expect(within(quadro).queryByRole('button', { name: /Manter o valor cobrado/i })).toBeNull();
    expect(quadro.textContent).toMatch(/decisão da gerência/);

    fireEvent.click(within(quadro).getByRole('button', { name: /Relançar pelo preço de agora/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Devolver R\$ 10,00 ao cliente/);
    expect(relancamentos()[1].body).toEqual({
      cashSessionId: 'sessao-caixa-1',
      terminalId: 't1',
      ajusteDePreco: 'preco_de_agora',
    });
  });

  it('o gerente pode manter o valor cobrado, com a diferença como acréscimo', async () => {
    entrarComo('gerente_loja');
    respostasDoRelancamento = [
      RECUSADO_PELO_PRECO,
      relancadaCom(
        {
          modo: 'manter_o_cobrado',
          diferencaCents: 1000,
          linhas: [],
          estornoCents: 0,
          devolverEmDinheiroCents: 0,
          acrescimoCents: 1000,
          frase: 'A gerência manteve o valor cobrado: acréscimo de R$ 10,00 sobre o preço de agora.',
        },
        5000,
      ),
    ];
    const c = await cartao();
    fireEvent.click(within(c).getByRole('button', { name: /Relançar na gaveta aberta/i }));
    const quadro = await within(c).findByTestId('preco-mudou');
    fireEvent.click(within(quadro).getByRole('button', { name: /Manter o valor cobrado/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/acréscimo de R\$ 10,00/);
    expect(relancamentos()[1].body).toMatchObject({ ajusteDePreco: 'manter_o_cobrado' });
  });
});
