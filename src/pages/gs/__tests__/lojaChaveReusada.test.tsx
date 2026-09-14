/**
 * ============================================================================
 * O CHECKOUT CUJA TENTATIVA JÁ REGISTROU OUTRO PEDIDO (R2-IDEM, item 7 — tela)
 * ============================================================================
 *
 * O servidor passou a recusar a MESMA Idempotency-Key com outro carrinho
 * inteiro (422 CORE_IDEMPOTENCY_KEY_REUSED, com os pedidos da primeira vez no
 * detalhe). No navegador isso acontece assim: o "Finalizar pedido" sai, o
 * servidor grava, a resposta se perde; o comprador tira uma loja do carrinho
 * (ou muda o endereço) e finaliza de novo. A chave da tela só trocava no
 * sucesso — a faixa repetia o texto do servidor, que fala em "chave de
 * idempotência", e todo novo clique levava a mesma chave e a mesma recusa.
 *
 * O que estes casos cobram:
 *   - a recusa é lida pelo código e dita na língua de quem compra, com os
 *     números dos pedidos que a tentativa já registrou;
 *   - sem a escolha, nada é reenviado;
 *   - "Registrar como pedido novo" reenvia o carrinho ATUAL com chave NOVA;
 *   - "Voltar ao carrinho" não reenvia, e o próximo finalizar leva a MESMA
 *     chave (quem decide registrar em dobro é o comprador, não a tela).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LojaPage from '../LojaPage';

const LOJAS = {
  stores: [
    { id: 'c-gr', slug: 'gringa', tradeName: 'Gringa', kind: 'retail', productCount: 1 },
    { id: 'c-mm', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail', productCount: 1 },
  ],
  services: [],
};

function produto(id: string, nome: string, preco: number, slug: string, loja: string) {
  return {
    id,
    name: nome,
    description: null,
    category: null,
    brand: null,
    imageUrl: null,
    basePriceCents: preco,
    priceCents: preco,
    onSale: false,
    available: 5,
    storeSlug: slug,
    storeName: loja,
  };
}

const PRODUTOS = {
  total: 2,
  items: [
    produto('p-gringa', 'Jaqueta Corta-Vento', 24_675, 'gringa', 'Gringa'),
    produto('p-mimei', 'Kit Skincare Facial', 12_900, 'me-mimei', 'Me Mimei'),
  ],
};

const RETIRADA = { method: 'retirada', label: 'Retirar na loja', priceCents: 0, estimatedDays: null, source: 'retirada' };

const FRETE = {
  lojas: [
    { companyId: 'c-gr', storeName: 'Gringa', itemsCents: 24_675, options: [RETIRADA], deliveryUnavailable: null },
    { companyId: 'c-mm', storeName: 'Me Mimei', itemsCents: 12_900, options: [RETIRADA], deliveryUnavailable: null },
  ],
  deliveryUnavailable: null,
  itens: [],
};

const PEDIDO_OK = {
  orders: [{ id: 'o-9', number: 9, total_cents: 37_575 }],
  payments: [
    {
      orderId: 'o-9',
      method: 'pix',
      status: 'pending',
      environment: 'sandbox',
      pixPayload: '00020126TESTE-COPIA-E-COLA',
      pixImageBase64: null,
      dueDate: '2026-12-31 23:59:59',
    },
  ],
};

const TEXTO_DO_SERVIDOR =
  'Esta chave de idempotência já registrou os pedidos #7, #8, com outro conteúdo — nada foi registrado agora. '
  + 'Um pedido novo precisa de chave nova.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** As chaves de cada POST /loja/checkout, na ordem. */
let chaves: string[];
/** Quantos checkouts o servidor recusa por chave reusada antes de aceitar. */
let recusas: number;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/loja/checkout/frete')) return json(FRETE);
    if (u.endsWith('/loja/checkout') && metodo === 'POST') {
      chaves.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      if (recusas > 0) {
        recusas -= 1;
        return json(
          {
            error: {
              code: 'CORE_IDEMPOTENCY_KEY_REUSED',
              message: TEXTO_DO_SERVIDOR,
              details: { orderIds: ['o-7', 'o-8'], orderNumbers: [7, 8] },
            },
          },
          422,
        );
      }
      return json(PEDIDO_OK, 201);
    }
    if (u.includes('/loja/stores')) return json(LOJAS);
    if (u.includes('/loja/products')) return json(PRODUTOS);
    return json({ items: [] });
  });
}

beforeEach(() => {
  localStorage.clear();
  chaves = [];
  recusas = 1;
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function finalizarERecusar() {
  render(
    <MemoryRouter>
      <LojaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Jaqueta Corta-Vento');
  for (const nome of ['Jaqueta Corta-Vento', 'Kit Skincare Facial']) {
    fireEvent.click(screen.getByText(nome).closest('li')!.querySelector('button')!);
  }
  fireEvent.click(screen.getByRole('button', { name: /Carrinho/ }));
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Cliente Teste' } });
  fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '52998224725' } });
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'cliente@exemplo.com' } });
  fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
  return screen.findByRole('dialog', { name: /já registrou um pedido/i });
}

describe('a mesma tentativa com outro carrinho, na língua de quem compra', () => {
  it('diz quais pedidos a tentativa já registrou, sem o jargão — e nada é reenviado sem a escolha', async () => {
    const dialogo = await finalizarERecusar();
    expect(dialogo.textContent).toMatch(/#7/);
    expect(dialogo.textContent).toMatch(/#8/);
    expect(dialogo.textContent).toMatch(/nada foi registrado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(chaves).toHaveLength(1);
    // O carrinho continua: nada se perdeu.
    expect(screen.getByRole('heading', { name: 'Gringa' })).toBeTruthy();
  });

  it('"Registrar como pedido novo" reenvia o carrinho atual com OUTRA chave', async () => {
    const dialogo = await finalizarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar como pedido novo/i }));

    expect(await screen.findByText(/Pedido #9 registrado/)).toBeTruthy();
    expect(chaves).toHaveLength(2);
    expect(chaves[1]).not.toBe('');
    expect(chaves[1]).not.toBe(chaves[0]);
    expect(screen.queryByRole('dialog', { name: /já registrou um pedido/i })).toBeNull();
  });

  it('"Voltar ao carrinho" não reenvia, e o próximo finalizar leva a MESMA chave', async () => {
    const dialogo = await finalizarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao carrinho/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou um pedido/i })).toBeNull());
    expect(chaves).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /Finalizar pedido/ }));
    await waitFor(() => expect(chaves).toHaveLength(2));
    expect(chaves[1]).toBe(chaves[0]);
  });
});
