/**
 * O BALCÃO ENTRE UM CLIENTE E OUTRO — auditoria de entrega.
 *
 * ============================================================================
 * QUATRO COISAS QUE SÓ APARECEM COM O BALCÃO EM MOVIMENTO
 * ============================================================================
 *
 * Nenhuma delas quebra a venda isolada. Todas atrapalham o segundo cliente da
 * fila, que é o estado normal de uma loja aberta.
 *
 * 1. **A prateleira vazia só aparecia no Finalizar.** `addProduct` punha
 *    qualquer produto no carrinho em qualquer quantidade sem olhar saldo. O
 *    servidor recusa — `CHECK (quantity >= 0)` vira `CORE_INSUFFICIENT_STOCK` —
 *    e a recusa chegava DEPOIS de o cartão já ter passado na maquininha avulsa.
 *    O saldo vem na mesma resposta da busca e ninguém olhava.
 *
 * 2. **O foco não voltava para a busca depois da venda.** `clearSale` roda ao
 *    fim de toda venda e mexia em doze estados sem devolver o foco a lugar
 *    nenhum. O leitor de código de barras bipa no vazio, e quem está no caixa
 *    precisa largar a pistola e clicar no campo — a cada cliente.
 *
 * 3. **O TROCO do cliente anterior ficava no maior texto da tela.** A faixa
 *    central mostra `message` enquanto ele existir, e `message` só era zerado
 *    no começo de `finalize`. O item do próximo cliente entrava no carrinho com
 *    "TROCO R$ 47,25" ainda escrito em 26px acima dele.
 *
 * 4. **Esc não fechava o modal de pré-vendas.** O painel de ajuda promete
 *    "Esc — fecha o pagamento e volta ao mesmo carrinho", o operador aprende
 *    que Esc fecha modal, e o de pré-vendas — que diz "Fechar (Esc)" no próprio
 *    botão — não ouvia tecla nenhuma.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';

const SESSAO_KEY = 'gs.session';

const BASE = {
  internal_code: 'PJ-0001',
  sku: null,
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1000,
  price_cents: 2500,
  effective_price_cents: 2500,
  on_sale: false,
  min_stock: 0,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Tem saldo de sobra. */
const COM_SALDO = { ...BASE, id: 'p-1', barcode: '7890000001111', name: 'Fone de ouvido', stock_quantity: 10 };
/** A prateleira está vazia — o servidor vai recusar. */
const SEM_SALDO = { ...BASE, id: 'p-2', barcode: '7890000002222', name: 'Carregador turbo', stock_quantity: 0 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let quotes: unknown[];

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

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
    if (u.includes('/core/products/search')) {
      const alvo = u.includes('2222') ? SEM_SALDO : COM_SALDO;
      return json({ items: [alvo] });
    }
    if (u.includes('/core/quotes')) return json({ items: quotes });
    if (u.includes('/core/sales') && metodo === 'POST') {
      return json({ id: 's-1', number: 1, total_cents: 2500, change_cents: 4725 }, 201);
    }
    return json({ items: [] });
  });
}

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

const busca = () => screen.getByPlaceholderText(/c.digo|barras|produto/i) as HTMLInputElement;

async function bipar(codigo: string, nome: string) {
  const campo = await screen.findByPlaceholderText(/c.digo|barras|produto/i);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await screen.findByText(nome);
}

beforeEach(() => {
  quotes = [];
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

describe('a prateleira vazia aparece no bipe, e não no Finalizar', () => {
  it('produto sem saldo entra avisado — o servidor vai recusar esta venda', async () => {
    montar();
    await bipar('7890000002222', 'Carregador turbo');

    /*
      O saldo vem na MESMA resposta da busca. Deixar a descoberta para o
      Finalizar é deixá-la para depois de o cartão já ter passado na maquininha
      avulsa — e aí o conserto envolve estorno, não um "espera um segundo".
    */
    expect(await screen.findByTestId('pdv-sem-saldo')).toBeTruthy();
    expect(screen.getByTestId('pdv-sem-saldo').textContent).toMatch(/Carregador turbo/);
  });

  it('produto com saldo não acende aviso nenhum', async () => {
    montar();
    await bipar('7890000001111', 'Fone de ouvido');

    // Aviso que aparece sempre deixa de ser lido.
    expect(screen.queryByTestId('pdv-sem-saldo')).toBeNull();
  });

  it('o aviso some quando o carrinho é limpo', async () => {
    montar();
    await bipar('7890000002222', 'Carregador turbo');
    await screen.findByTestId('pdv-sem-saldo');

    fireEvent.click(screen.getByRole('button', { name: /Cancelar \(F6\)/i }));
    /*
      Com carrinho montado, "Cancelar (F6)" PERGUNTA antes de apagar
      (D-pdv-teclado-12): trinta itens sumiam por uma tecla errada, sem desfazer.
      O aviso some quando a venda é de fato cancelada, na confirmação.
    */
    const pergunta = await screen.findByTestId('pdv-confirmar-cancelamento');
    expect(screen.getByTestId('pdv-sem-saldo')).toBeTruthy();
    fireEvent.click(within(pergunta).getByRole('button', { name: /Cancelar a venda/i }));
    await waitFor(() => expect(screen.queryByTestId('pdv-sem-saldo')).toBeNull());
  });
});

// ============================================================================

describe('o próximo cliente encontra a tela limpa', () => {
  it('depois da venda, o foco volta para a busca — o leitor não bipa no vazio', async () => {
    montar();
    await bipar('7890000001111', 'Fone de ouvido');

    /*
      A venda fecha PELO PAGAMENTO de propósito. No Finalizar Rápido o foco
      nunca sai do campo de busca, e o teste passaria com o guarda fora — pelo
      motivo errado. É no F10 que o foco está dentro do diálogo, que desmonta
      logo em seguida e deixa o leitor de código de barras digitando no nada.
    */
    fireEvent.keyDown(window, { key: 'F10' });
    const pagamento = await screen.findByRole('dialog', { name: 'Pagamento' });
    // Campo vazio significa "o que falta" — o gesto mais comum do balcão.
    fireEvent.click(within(pagamento).getByRole('button', { name: /^Lançar$/i }));
    await waitFor(() => {
      const finalizar = within(pagamento).getByRole('button', { name: /Finalizar/i });
      expect((finalizar as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(within(pagamento).getByRole('button', { name: /Finalizar/i }));
    await screen.findByText(/Venda #1 finalizada/);

    /*
      Agora a venda termina na tela de VENDA CONCLUÍDA (Enter imprime, Esc
      segue). O leitor continua sem bipar no vazio: o primeiro caractere do
      próximo código fecha essa tela — sem imprimir — e cai no campo de busca,
      que fica com o foco para o resto do código.
    */
    const concluida = await screen.findByRole('dialog', { name: 'Venda concluída' });
    fireEvent.keyDown(document.activeElement ?? concluida, { key: '7' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Venda concluída' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(busca()));
    expect((busca() as HTMLInputElement).value).toBe('7');
  });

  it('o troco do cliente anterior sai da tela quando o próximo item entra', async () => {
    montar();
    await bipar('7890000001111', 'Fone de ouvido');
    fireEvent.click(screen.getByRole('button', { name: /Finalizar Rápido/i }));
    const troco = await screen.findByText(/TROCO/);
    expect(troco).toBeTruthy();

    // Próximo cliente, primeiro item.
    await bipar('7890000001111', 'Fone de ouvido');

    /*
      A faixa central é o maior texto da tela, em 26px. Manter "TROCO R$ 47,25"
      ali enquanto o próximo cliente é atendido é convidar o operador a
      devolver troco duas vezes.
    */
    await waitFor(() => expect(screen.queryByText(/TROCO/)).toBeNull());
  });
});

// ============================================================================

describe('Esc fecha o que a tela diz que Esc fecha', () => {
  it('o modal de pré-vendas obedece à tecla que ele próprio anuncia', async () => {
    montar();
    fireEvent.keyDown(window, { key: 'F9' });
    await screen.findByText(/Fechar \(Esc\)/i);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/Fechar \(Esc\)/i)).toBeNull());
  });
});
