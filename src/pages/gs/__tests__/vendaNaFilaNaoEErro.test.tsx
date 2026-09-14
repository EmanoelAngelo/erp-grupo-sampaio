/**
 * A VENDA QUE ENTROU NA FILA NÃO É UMA VENDA QUE FALHOU.
 *
 * ============================================================================
 * O QUE ACONTECIA NO BALCÃO
 * ============================================================================
 *
 * Quando o servidor não responde, `apiRequest` GUARDA o POST da venda na fila e
 * lança `API_QUEUED_OFFLINE` — um erro que quer dizer "deu certo, só ainda não
 * subiu". O PDV tratava dois códigos com carinho (alçada e produto sem preço) e
 * jogava todo o resto no ramo genérico: faixa VERMELHA de erro, diálogo de
 * pagamento aberto, carrinho intacto.
 *
 * O operador lê "Sem conexão com o servidor" em vermelho, com o carrinho ainda
 * na tela e o cliente esperando. O que ele faz é o óbvio: cancela e refaz. E aí
 * o carrinho novo ganha chave de idempotência NOVA — a antiga morre com o
 * cancelamento —, então quando a conexão volta a fila sobe DUAS vendas do mesmo
 * cliente, com duas baixas de estoque e dois lançamentos de dinheiro.
 *
 * ============================================================================
 * O QUE MUDA
 * ============================================================================
 *
 * A venda enfileirada fecha o pagamento, limpa o carrinho e avisa em tom de
 * confirmação, com a frase que evita o estrago: **não refaça**. É a mesma coisa
 * que acontece numa venda comum — porque, do ponto de vista do balcão, é a
 * mesma coisa: acabou, pode chamar o próximo.
 *
 * ============================================================================
 * CADA TESTE FICA VERMELHO QUANDO O GUARDA SAI
 * ============================================================================
 *
 *   - devolva `API_QUEUED_OFFLINE` ao ramo genérico e o carrinho fica cheio
 *     com faixa vermelha — o estado que produz a venda duplicada;
 *   - tire a frase e o operador continua sem saber se pode chamar o próximo.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Quantas vezes o POST da venda saiu — e com quais chaves. */
let chavesEnviadas: string[];
/** `true` derruba a rede só no POST da venda: é o caso que enfileira. */
let redeCaidaNaVenda: boolean;

function servidor() {
  return vi.fn(
    async (url: string | URL | Request, init?: { method?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();

      if (u.includes('/core/sales') && metodo === 'POST') {
        const headers = new Headers(init?.headers);
        chavesEnviadas.push(headers.get('Idempotency-Key') ?? '');
        if (redeCaidaNaVenda) {
          // O que o navegador faz quando o servidor não responde.
          throw new TypeError('Failed to fetch');
        }
        return json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 0 }, 201);
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

beforeEach(() => {
  chavesEnviadas = [];
  redeCaidaNaVenda = true;
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

describe('a venda guardada na fila termina o atendimento', () => {
  it('o carrinho esvazia e a tela avisa para NÃO refazer', async () => {
    montar();
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    /*
      O carrinho vazio é a metade que importa: enquanto ele fica na tela com
      faixa vermelha, o gesto natural do balcão é cancelar e refazer — e o
      refazer nasce com chave de idempotência nova, que é o que produz a venda
      duplicada quando a fila sobe.
    */
    expect(await screen.findByText(/não refa/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Fone de ouvido')).toBeNull());
  });

  it('a mensagem não é de erro — ela diz que a venda está guardada', async () => {
    montar();
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    // A faixa do PDV e a tela de venda concluída dizem as duas que ela está guardada.
    const avisos = await screen.findAllByText(/fila|guardada/i);
    expect(avisos.length).toBeGreaterThan(0);
    for (const aviso of avisos) {
      expect(aviso.textContent).toMatch(/fila|guardada/i);
      // "Falha ao finalizar a venda" era o texto do ramo genérico.
      expect(aviso.textContent).not.toMatch(/falha/i);
    }
  });

  it('só UMA venda foi para a fila — a chave é a mesma do carrinho', async () => {
    montar();
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    await screen.findByText(/não refa/i);

    expect(chavesEnviadas).toHaveLength(1);
    expect(chavesEnviadas[0]).not.toBe('');
  });
});

// ============================================================================

describe('venda comum continua sendo venda comum', () => {
  it('com o servidor no ar, a mensagem é a de sempre', async () => {
    redeCaidaNaVenda = false;
    montar();
    await porNoCarrinho();
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));

    expect(await screen.findByText(/Venda #1 finalizada/)).toBeTruthy();
  });
});
