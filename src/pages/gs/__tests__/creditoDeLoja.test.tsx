/**
 * CRÉDITO DE LOJA NA TELA — o vale que o balcão concede e gasta (GAP-V10/V47).
 *
 * O servidor passou a ter razão de crédito, extrato e consumo na venda. Sem
 * tela, isso seria mais um mecanismo que só existe para quem lê o código: a
 * devolução em crédito continuaria virando anotação de papel, porque ninguém
 * no balcão teria como saber que o cliente tem saldo.
 *
 * ## O que cada caso protege (verificado apagando o guarda)
 *
 *   - tire o bloco "Crédito do cliente" do PagamentoDialog e o operador cobra o
 *     valor inteiro de quem tem vale — o passivo continua invisível no balcão;
 *   - deixe o bloco aparecer SEM cliente (ou com saldo zero) e a tela promete o
 *     que a API recusa, que é o jeito mais rápido de ensinar alguém a ignorar
 *     um botão;
 *   - pare de mandar `customerCreditCents` no corpo da venda e o vale some no
 *     caminho: a venda fecha pelo total cheio e o saldo do cliente fica intacto
 *     — ninguém percebe até o cliente reclamar;
 *   - deixe o troco ser medido contra o TOTAL e a venda paga pelo vale devolve
 *     dinheiro de gaveta: crédito virando espécie;
 *   - tire o extrato da ficha do cliente e a pergunta "de onde veio esse
 *     crédito?" volta a não ter resposta em tela nenhuma.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';
import { ClientesPage } from '../OperacaoPages';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const BOLSA = {
  id: 'p-bolsa',
  internal_code: 'BL-0001',
  sku: null,
  barcode: '7890000002222',
  name: 'Bolsa de couro',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 10000,
  price_cents: 20000,
  effective_price_cents: 20000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 9,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Quem devolveu uma peça e ficou com vale. */
const MARTA = {
  id: 'c-marta',
  code: null,
  name: 'Marta Compradora',
  document: '39053344705',
  email: null,
  phone: null,
  address: null,
  notes: null,
  active: 1,
  price_table_id: null,
};

/** Quem nunca devolveu nada: saldo zero, e o bloco não aparece. */
const JOAO = {
  id: 'c-joao',
  code: null,
  name: 'João Sem Vale',
  document: '11144477735',
  email: null,
  phone: null,
  address: null,
  notes: null,
  active: 1,
  price_table_id: null,
};

/** A razão de crédito do dublê, por cliente — como o servidor a devolveria. */
const EXTRATOS: Record<string, { balance: number; entries: Record<string, unknown>[] }> = {
  [MARTA.id]: {
    balance: 25_000,
    entries: [
      {
        id: 'cc-1',
        kind: 'grant',
        amount_cents: 25_000,
        origin_type: 'sale_return',
        origin_id: 'dev-1',
        description: 'Devolução #7 da venda #12',
        return_number: 7,
        sale_number: null,
        created_at: '2026-08-20T14:00:00.000Z',
      },
    ],
  },
  [JOAO.id]: { balance: 0, entries: [] },
};

/** Os corpos que a tela mandou para POST /core/sales. */
let vendas: Record<string, unknown>[] = [];
/** As URLs de extrato que a tela pediu — é o fio entre a tela e a razão. */
let extratosPedidos: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    const credito = alvo.match(/\/core\/customers\/([^/?]+)\/credits/);
    if (credito) {
      extratosPedidos.push(alvo);
      return json(EXTRATOS[credito[1]] ?? { balance: 0, entries: [] });
    }

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      vendas.push(corpo);
      return json({ id: 'v-1', number: 99, total_cents: 20_000, change_cents: 0 }, 201);
    }

    const ficha = alvo.match(/\/core\/customers\/([^/?]+)$/);
    if (ficha && metodo === 'GET') {
      const encontrado = [MARTA, JOAO].find((c) => c.id === ficha[1]);
      return encontrado
        ? json(encontrado)
        : json({ error: { code: 'CORE_CUSTOMER_NOT_FOUND', message: 'não encontrado' } }, 404);
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/customers')) {
      const termo = new URLSearchParams(alvo.split('?')[1] ?? '').get('search') ?? '';
      corpo = {
        items: [MARTA, JOAO].filter(
          (c) => !termo || c.name.toLowerCase().includes(termo.toLowerCase()),
        ),
      };
    } else if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: [BOLSA].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/payments/methods') || alvo.includes('/core/payment-methods')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/catalog/price-tables')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return json(corpo);
  });
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
    'teste do crédito de loja',
  );
}

beforeEach(() => {
  vendas = [];
  extratosPedidos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// --------------------------------------------------------------------- PDV

function montarPdv() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function bipar(codigo: string) {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

async function escolherCliente(nome: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Cliente (F2)' }));
  const busca = await screen.findByLabelText('Buscar cliente');
  fireEvent.change(busca, { target: { value: nome } });
  fireEvent.click(await screen.findByRole('button', { name: nome }));
  await waitFor(() => expect(screen.queryByLabelText('Buscar cliente')).toBeNull());
}

async function abrirPagamento() {
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar (F10)' }));
  await screen.findByRole('dialog', { name: 'Pagamento' });
}

describe('o balcão vê e gasta o vale', () => {
  it('com cliente e saldo, o diálogo mostra o crédito e o valor disponível', async () => {
    montarPdv();
    await bipar('7890000002222');
    await escolherCliente('Marta Compradora');
    await abrirPagamento();

    // O SALDO VAI ESCRITO. "Usar crédito" sem número obriga o operador a
    // adivinhar quanto o cliente tem — e é o número que o cliente pergunta em
    // voz alta no balcão.
    const bloco = await screen.findByTestId('pdv-credito-de-loja');
    expect(bloco.textContent).toContain(formatCents(25_000));
    expect(bloco.textContent).toContain('Marta Compradora');
    expect(extratosPedidos.some((u) => u.includes(MARTA.id))).toBe(true);
  });

  it('sem cliente na venda, o bloco do vale nem aparece', async () => {
    montarPdv();
    await bipar('7890000002222');
    await abrirPagamento();

    // Prometer o que a API recusa é o jeito mais rápido de ensinar alguém a
    // ignorar um botão.
    expect(screen.queryByTestId('pdv-credito-de-loja')).toBeNull();
    expect(extratosPedidos).toEqual([]);
  });

  it('cliente sem saldo também não vê o bloco', async () => {
    montarPdv();
    await bipar('7890000002222');
    await escolherCliente('João Sem Vale');
    await abrirPagamento();

    await waitFor(() => expect(extratosPedidos.some((u) => u.includes(JOAO.id))).toBe(true));
    expect(screen.queryByTestId('pdv-credito-de-loja')).toBeNull();
  });

  it('usar o crédito zera o que falta receber e a venda fecha sem pagamento', async () => {
    montarPdv();
    await bipar('7890000002222');
    await escolherCliente('Marta Compradora');
    await abrirPagamento();

    // A bolsa custa R$ 200,00 e o saldo é R$ 250,00: o vale cobre até o total,
    // nunca mais — crédito não vira troco, e o servidor recusaria.
    const usar = await screen.findByRole('button', { name: /Usar crédito/ });
    expect(usar.textContent).toContain(formatCents(20_000));
    fireEvent.click(usar);

    await waitFor(() => {
      const falta = screen.getByText('Falta receber').parentElement!;
      expect(falta.textContent).toContain(formatCents(0));
    });
    // E o troco NÃO nasce dos R$ 200,00 abatidos: crédito não sai da gaveta.
    expect(screen.getByText('Troco').parentElement!.textContent).toContain(formatCents(0));

    // O Finalizar DO DIÁLOGO — o rodapé do PDV tem outro com o mesmo nome, e é
    // o de dentro que fecha a venda com o vale já aplicado.
    const dialogo = screen.getByRole('dialog', { name: 'Pagamento' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Finalizar (F10)' }));

    await waitFor(() => expect(vendas).toHaveLength(1));
    expect(vendas[0].customerCreditCents).toBe(20_000);
    expect(vendas[0].customerId).toBe(MARTA.id);
    // O vale fica FORA de `payments`: ali mora o que o cliente PAGOU, e aqui
    // ele cobrou uma dívida que a loja já tinha com ele.
    expect(vendas[0].payments).toEqual([]);
  });

  it('desistir do crédito devolve o valor a receber, sem fechar o diálogo', async () => {
    montarPdv();
    await bipar('7890000002222');
    await escolherCliente('Marta Compradora');
    await abrirPagamento();

    fireEvent.click(await screen.findByRole('button', { name: /Usar crédito/ }));
    await waitFor(() =>
      expect(screen.getByText('Falta receber').parentElement!.textContent).toContain(
        formatCents(0),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Não usar o crédito do cliente' }));
    await waitFor(() =>
      expect(screen.getByText('Falta receber').parentElement!.textContent).toContain(
        formatCents(20_000),
      ),
    );
  });
});

// ------------------------------------------------------- ficha do cliente

describe('a ficha do cliente mostra o extrato', () => {
  function montarClientes() {
    render(
      <MemoryRouter>
        <ClientesPage />
      </MemoryRouter>,
    );
  }

  it('abre a ficha e lista o crédito com saldo e origem navegável', async () => {
    montarClientes();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Editar cadastro de Marta Compradora' }),
    );

    // O saldo, e a origem que responde "de onde veio esse crédito?".
    const saldo = await screen.findByTestId('credito-saldo');
    expect(saldo.textContent).toContain(formatCents(25_000));

    const linha = (await screen.findByText('Devolução #7')).closest('tr')!;
    expect(linha.textContent).toContain('Concedido');
    expect(linha.textContent).toContain(formatCents(25_000));
  });

  it('cliente sem movimento não ganha bloco nenhum', async () => {
    montarClientes();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Editar cadastro de João Sem Vale' }),
    );

    // Um bloco "Crédito de loja: R$ 0,00" em toda ficha seria ruído — e
    // ensinaria a pessoa a não olhar o lugar em que o número importa.
    await waitFor(() => expect(extratosPedidos.some((u) => u.includes(JOAO.id))).toBe(true));
    expect(screen.queryByTestId('credito-saldo')).toBeNull();
  });
});
