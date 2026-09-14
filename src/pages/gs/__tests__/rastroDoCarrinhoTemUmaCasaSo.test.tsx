/**
 * ============================================================================
 * O RASTRO DO CARRINHO TEM UMA CASA SÓ — e a devolução aponta para ela
 * ============================================================================
 *
 * ## A pergunta que estes casos respondem
 *
 * A onda 6 pendurou `ItensCanceladosDaVenda` na ficha da venda, em `VendasPage`,
 * e deixou anotado que `DevolucoesPage` "também abre a venda" e ficou sem o
 * bloco. A tentação óbvia é copiá-lo para cá. Estes casos são a prova de que
 * NÃO é para copiar, e de qual era o defeito de verdade.
 *
 * ## O que foi MEDIDO no código, e que decide a questão
 *
 *   1. `DevolucoesPage` esconde a venda cancelada (`vendasFiltradas` recusa
 *      `status === 'cancelled'`) — e é na venda cancelada que "o que saiu do
 *      carrinho antes de fechar?" mais importa. Um bloco aqui apareceria
 *      exatamente onde a pergunta pesa MENOS, e sumiria — junto com a venda —
 *      onde ela pesa mais. Quem aprendesse "o rastro se lê em Devoluções"
 *      procuraria a venda cancelada e não acharia NEM o bloco NEM a venda: não
 *      "nenhuma remoção", e sim nada. Uma segunda casa que não responde na hora
 *      que importa é pior que uma casa só.
 *
 *   2. Ninguém fica sem o rastro. `/sistema/vendas/devolucoes` é
 *      `ROTA_GESTAO` + `QUEM_DESFAZ_VENDA`; `AMBIENTE_POR_PERFIL` põe os dois
 *      caixas em `pdv`, então a interseção que de fato entra aqui é
 *      {admin_geral, gestor, gerente_loja, gerente_oficina} — e `/sistema/vendas`
 *      é `ROTA_GESTAO` SEM recorte de perfil, então os quatro alcançam a ficha.
 *      A parte da pendência da onda 6 que dizia "inalcançável" não se sustenta.
 *
 *   3. A ficha custa uma requisição a mais. `abrirVenda` pede
 *      `/core/sales/:id/returnable`, que não traz `removedItems`; o bloco
 *      exigiria `GET /core/sales/:id` e mais `GET /core/sellers` para o mapa de
 *      nomes — duas idas ao servidor no balcão, com o cliente na frente, para
 *      responder uma pergunta de auditoria que se faz depois.
 *
 * ## O DEFEITO QUE SOBROU — e este é real
 *
 * A tela some com a venda cancelada e não diz PARA ONDE ela foi. Quem cancela
 * aqui (é desta tela que se cancela) vê a linha desaparecer com um aviso e fica
 * sem caminho até a ficha — o rastro é alcançável e ninguém sabe por onde. É a
 * mesma regra que esta tela já aplica ao recorte do `?devolucao=` e que
 * `VendasPage` aplica ao `?venda=`: o recorte se declara E tem saída.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - copie `ItensCanceladosDaVenda` para cá e o caso da "casa só" fica
 *     vermelho — a segunda definição é justamente o que ele proíbe;
 *   - tire o link do aviso do cancelamento e a venda volta a sumir sem destino;
 *   - tire o link do vazio da busca e quem procura a venda cancelada pelo
 *     número lê "não encontrada" sem saber que ela existe noutra tela.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA_VIVA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: null,
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 1_200_000,
  discount_cents: 0,
  total_cents: 1_200_000,
  change_cents: 0,
  status: 'closed',
  note: null,
  created_at: '2026-08-18T10:00:00.000Z',
};

/** A venda que a lista ESCONDE — e é nela que a pergunta do rastro pesa mais. */
const VENDA_CANCELADA = {
  ...VENDA_VIVA,
  id: 's-9',
  number: 41,
  status: 'cancelled',
};

/** Toda URL pedida — é o que prova que a ficha NÃO é buscada aqui. */
let pedidos: string[] = [];

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const alvo = String(url);
      pedidos.push(`${(init?.method ?? 'GET').toUpperCase()} ${alvo}`);

      if (alvo.includes('/cancel')) return json({ ...VENDA_VIVA, status: 'cancelled' });
      if (alvo.includes('/returnable')) {
        return json({
          items: [
            {
              sale_item_id: 'si-1',
              product_id: 'p-1',
              description: 'Moto 0km',
              quantity: 1,
              returned_quantity: 0,
              unit_price_cents: 1_200_000,
              total_cents: 1_200_000,
              serialized: 0,
              units: [],
            },
          ],
        });
      }
      // `sale-returns` antes de `sales`: "sale-returns" não contém "sales", e a
      // ordem inversa devolveria vendas para o histórico de devoluções.
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA_VIVA, VENDA_CANCELADA] });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste do rastro do carrinho',
  );
}

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  pedidos = [];
  localStorage.clear();
  servidor();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do rastro do carrinho');
  localStorage.clear();
});

describe('a devolução não vira uma segunda casa do rastro', () => {
  it('abrir a venda para devolver NÃO desenha o bloco dos itens cancelados', async () => {
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getAllByRole('button', { name: 'Devolver desta' })[0]);
    await screen.findByText('Venda #42');

    /*
      A DECISÃO, PREGADA.

      Copiar `ItensCanceladosDaVenda` para cá criaria a segunda definição da
      mesma regra — a que sempre diverge no primeiro conserto feito de um lado
      só — e o faria numa tela que ESCONDE a venda cancelada, ou seja, onde o
      rastro nunca poderá responder o caso que mais importa.
    */
    expect(screen.queryByTestId('venda-itens-cancelados')).toBeNull();
  });

  it('e não paga a requisição da ficha para nada', async () => {
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getAllByRole('button', { name: 'Devolver desta' })[0]);
    await screen.findByText('Venda #42');

    // A tela pede os itens devolvíveis; a ficha (`GET /core/sales/:id`) e o mapa
    // de nomes da equipe são custo do bloco, e o bloco não mora aqui.
    expect(pedidos.some((p) => p.includes('/core/sales/s-1/returnable'))).toBe(true);
    expect(pedidos.some((p) => p === 'GET /core/sales/s-1')).toBe(false);
    expect(pedidos.some((p) => p.includes('/core/sellers'))).toBe(false);
  });
});

describe('o recorte se declara E tem saída — a venda cancelada não é um beco', () => {
  it('procurar a venda cancelada pelo número diz onde ela está', async () => {
    montar();
    await screen.findByText('#42');

    // O número da venda cancelada — o que o cliente traz no cupom.
    fireEvent.change(screen.getByLabelText('Venda'), { target: { value: '41' } });

    await screen.findByText(/Venda cancelada não aparece/);
    const link = screen.getByRole('link', { name: /Ver todas as vendas/ });
    expect(link.getAttribute('href')).toBe('/sistema/vendas');
  });

  it('depois de cancelar, o aviso leva à FICHA da venda que acabou de sumir', async () => {
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancelar venda' })[0]);
    await screen.findByTestId('confirmar-cancelamento');
    // O motivo passou a ser obrigatório (auditoria da Preço Justo, E-venda-servidor-M01):
    // sem ele o botão não confirma. É o que responde "por que esta venda sumiu?".
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'Cliente desistiu da compra' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));

    await screen.findByText(/O estoque voltou, a comissão foi estornada/);

    /*
      É DESTA TELA QUE SE CANCELA, e é aqui que a pessoa fica sem caminho: a
      linha some, o aviso explica o estorno, e o rastro do carrinho — a razão
      pela qual muita venda é cancelada — fica noutra tela que ninguém disse
      qual é. O link fecha o beco sem duplicar o bloco.
    */
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /ficha da venda #42/ });
      expect(link.getAttribute('href')).toBe('/sistema/vendas?venda=s-1');
    });
  });
});
