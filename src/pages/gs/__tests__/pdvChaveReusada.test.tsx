/**
 * ============================================================================
 * A TENTATIVA QUE JÁ REGISTROU OUTRA VENDA (RES-IDEM-TELA)
 * ============================================================================
 *
 * O servidor passou a recusar a MESMA Idempotency-Key com outra mercadoria
 * (422 CORE_IDEMPOTENCY_KEY_REUSED, d622b6d). No balcão isso acontece assim:
 * a venda foi criada, mas a tela recebeu um erro que não é de rede (um 500
 * depois do commit); o carrinho continua na tela com a MESMA chave, o caixa
 * mexe nele e finaliza de novo.
 *
 * A recusa caía no ramo genérico: a faixa mostrava o texto do servidor — que
 * fala em "chave de idempotência", coisa que o caixa não vê — e a chave FICAVA.
 * O único jeito de ganhar chave nova era cancelar a venda inteira.
 *
 * O que estes casos cobram:
 *
 *   - a recusa é lida pelo CÓDIGO e dita na língua do caixa, com o número da
 *     venda que a tentativa já registrou;
 *   - sem o caixa escolher, nada é reenviado — registrar em dobro é escolha;
 *   - "Registrar como venda nova" reenvia o carrinho ATUAL com chave NOVA;
 *   - "Voltar ao carrinho" não reenvia nada;
 *   - "Ver a venda #N" mostra o que a venda #N registrou (GET /core/sales/:id,
 *     aberta ao balcão), para o caixa comparar com o carrinho.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const SESSAO_KEY = 'gs.session';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'PJ-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Fone de ouvido',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** O texto do servidor: fala de chave de idempotência, que o caixa não vê. */
const TEXTO_DO_SERVIDOR =
  'Esta chave de idempotência já registrou a venda #7, com outra mercadoria — nada foi registrado agora. '
  + 'Uma venda nova precisa de chave nova.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** As chaves de cada POST da venda, na ordem. */
let chavesEnviadas: string[];
/** A chave que o servidor já conhece com outra mercadoria. */
let chaveOcupada: string | null;

function servidor() {
  return vi.fn(
    async (url: string | URL | Request, init?: { method?: string; headers?: Record<string, string> }) => {
      const barra = respostaDaBarraDoShell(url);
      if (barra) return barra;
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();

      if (u.includes('/core/sales') && metodo === 'POST') {
        const chave = new Headers(init?.headers).get('Idempotency-Key') ?? '';
        chavesEnviadas.push(chave);
        // A primeira tentativa desta tela é a que ocupa a chave: o servidor a
        // conhece por uma venda anterior, com outros itens.
        chaveOcupada ??= chave;
        if (chave === chaveOcupada) {
          return json(
            {
              error: {
                code: 'CORE_IDEMPOTENCY_KEY_REUSED',
                message: TEXTO_DO_SERVIDOR,
                details: { saleId: 's-7', saleNumber: 7 },
              },
            },
            422,
          );
        }
        return json({ id: 's-8', number: 8, total_cents: 2500, change_cents: 0 }, 201);
      }
      if (u.includes('/core/sales/s-7') && metodo === 'GET') {
        return json({
          id: 's-7',
          number: 7,
          total_cents: 5000,
          change_cents: 0,
          status: 'completed',
          created_at: '2026-09-13T10:00:00.000Z',
          subtotal_cents: 5000,
          discount_cents: 0,
          surcharge_cents: 0,
          seller_id: null,
          note: null,
          items: [
            {
              id: 'i-1',
              product_id: 'p-1',
              description: 'Fone de ouvido',
              quantity: 2,
              unit_price_cents: 2500,
              total_cents: 5000,
            },
          ],
          payments: [],
          customerCreditCents: 0,
          removedItems: [],
          financeEntries: [],
        });
      }
      if (u.includes('/core/cash/open') && metodo === 'GET') {
        return json({
          session: { id: 'sessao-1', opening_cents: 5000, status: 'aberto' },
          cashWithdrawalLimitCents: null,
        });
      }
      if (u.includes('/summary')) return json({ expectedCents: 5000, byMethod: [], movements: [] });
      if (u.includes('/core/fiscal/pdv-summary')) {
        return json({ situacao: 'READY', pendencyCount: 0, motivos: [] });
      }
      if (u.includes('/core/products/search')) return json({ items: [PRODUTO] });
      return json({ items: [] });
    },
  );
}

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function porNoCarrinho() {
  const busca = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
  fireEvent.change(busca, { target: { value: '7890000001111' } });
  fireEvent.keyDown(busca, { key: 'Enter' });
  await screen.findByText('Fone de ouvido');
}

async function finalizarERecusar() {
  montar();
  await porNoCarrinho();
  fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
  return screen.findByRole('dialog', { name: /já registrou/i });
}

beforeEach(() => {
  chavesEnviadas = [];
  chaveOcupada = null;
  localStorage.setItem(
    SESSAO_KEY,
    JSON.stringify({
      accessToken: 'tok',
      user: { id: 'u1', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    }),
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ============================================================================

describe('a recusa da chave reusada, na língua do caixa', () => {
  it('diz qual venda a tentativa já registrou, sem falar em chave de idempotência', async () => {
    const dialogo = await finalizarERecusar();
    expect(dialogo.textContent).toContain('Esta tentativa já registrou a venda #7, com outros itens.');
    expect(dialogo.textContent).toMatch(/nada foi registrado agora/i);
    // O jargão do servidor não chega ao balcão, nem no diálogo nem na faixa.
    expect(screen.queryByText(/idempot/i)).toBeNull();
    // O carrinho continua na tela: nada se perdeu.
    expect(screen.getAllByText('Fone de ouvido').length).toBeGreaterThan(0);
  });

  it('sem o caixa escolher, nada é reenviado', async () => {
    await finalizarERecusar();
    // Um tempo para qualquer reenvio automático aparecer — e ele não aparece.
    await new Promise((r) => setTimeout(r, 80));
    expect(chavesEnviadas).toHaveLength(1);
  });

  it('os atalhos do balcão (F8, F10) não agem por baixo do diálogo — nada sai sem a escolha', async () => {
    /*
      O caixa acabou de ver a recusa e, por reflexo, aperta F8 (finalizar em
      dinheiro). Com o diálogo fora da lista de modais do handler da página, o
      F8 finalizava POR BAIXO dele: um POST sem escolha nenhuma, e a recusa que
      volta troca o pagamento guardado para o reenvio por "dinheiro, valor
      exato" — o "Registrar como venda nova" seguinte registraria em dinheiro a
      venda que o cliente pagou no cartão.
    */
    const dialogo = await finalizarERecusar();
    const voltar = within(dialogo).getByRole('button', { name: /Voltar ao carrinho/i });
    fireEvent.keyDown(voltar, { key: 'F8' });
    fireEvent.keyDown(voltar, { key: 'F10' });
    await new Promise((r) => setTimeout(r, 80));
    expect(chavesEnviadas).toHaveLength(1);
    // O pagamento não abriu por cima, e o diálogo continua sendo a pergunta.
    expect(screen.getByRole('dialog', { name: /já registrou/i })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /pagamento/i })).toBeNull();
  });

  it('"Registrar como venda nova" reenvia o carrinho atual com OUTRA chave', async () => {
    const dialogo = await finalizarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar como venda nova/i }));

    expect(await screen.findByText(/Venda #8 finalizada/)).toBeTruthy();
    expect(chavesEnviadas).toHaveLength(2);
    expect(chavesEnviadas[1]).not.toBe('');
    expect(chavesEnviadas[1]).not.toBe(chavesEnviadas[0]);
    expect(screen.queryByRole('dialog', { name: /já registrou/i })).toBeNull();
  });

  it('"Voltar ao carrinho" fecha sem reenviar, e o carrinho fica', async () => {
    const dialogo = await finalizarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao carrinho/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou/i })).toBeNull());
    expect(chavesEnviadas).toHaveLength(1);
    expect(screen.getAllByText('Fone de ouvido').length).toBeGreaterThan(0);
  });

  it('"Ver a venda #7" mostra o que ela registrou, para comparar com o carrinho', async () => {
    const dialogo = await finalizarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Ver a venda #7/i }));

    const resumo = await within(dialogo).findByTestId('venda-da-tentativa');
    expect(resumo.textContent).toMatch(/2\s*×\s*Fone de ouvido/);
    expect(resumo.textContent).toMatch(/50,00/);
    // Ver não é registrar: nenhum POST a mais.
    expect(chavesEnviadas).toHaveLength(1);
  });
});
