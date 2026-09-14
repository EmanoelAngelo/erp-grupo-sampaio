/**
 * ONDE O CLIENTE É LIGADO À TABELA — a tela que faltava.
 *
 * O cadastro de tabela de preço existia inteiro e não era lido por ninguém,
 * porque não havia elo entre cliente e tabela em lugar nenhum. O servidor
 * passou a ter a coluna, a validação e a rota; sem este seletor, nada disso
 * seria alcançável por gente, e a rodada terminaria com a mesma tela bonita
 * que não muda preço nenhum.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire o seletor e não há como conceder atacado a ninguém;
 *   - mande o id vazio como string e o servidor grava "" no lugar de nulo:
 *     desfazer o vínculo deixa de funcionar;
 *   - ofereça tabela desativada e o gerente descobre a regra pelo 404;
 *   - mostre o seletor a quem não é gerência e a tela oferece o que o servidor
 *     recusa com 403;
 *   - engula o erro da troca e o gerente sai achando que concedeu o desconto.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { ClientesPage } from '../OperacaoPages';

const REVENDEDOR = {
  id: 'c-revenda',
  name: 'PJ Motos Revenda',
  document: '11222333000181',
  email: null,
  phone: null,
  price_table_id: null as string | null,
};

const CONSUMIDOR = {
  id: 'c-final',
  name: 'Maria da Silva',
  document: null,
  email: null,
  phone: null,
  price_table_id: null as string | null,
};

const TABELAS = [
  { id: 't-atacado', name: 'Atacado', percent_off: 15, active: 1, items: 0, customers: 0 },
  // Desativada: existe no cadastro e NÃO pode ser oferecida — o servidor recusa
  // vincular cliente a ela, porque o vínculo não teria efeito nenhum no preço.
  { id: 't-antiga', name: 'Promoção 2024', percent_off: 30, active: 0, items: 0, customers: 0 },
];

/** Os corpos que a tela mandou para `PUT /core/customers/:id/price-table`. */
let vinculos: { url: string; body: unknown }[] = [];
let respostaDoVinculo: { status: number; body: unknown } = { status: 200, body: REVENDEDOR };
let auxFalha = false;

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/price-table') && metodo === 'PUT') {
      vinculos.push({ url: alvo, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(respostaDoVinculo.body), {
        status: respostaDoVinculo.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (alvo.includes('/core/catalog/aux')) {
      if (auxFalha) {
        return new Response(
          JSON.stringify({ error: { code: 'CORE_FORBIDDEN', message: 'Sem permissão.' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ units: [], taxGroups: [], taxRates: [], priceTables: TABELAS }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (alvo.includes('/core/customers')) {
      return new Response(JSON.stringify({ items: [REVENDEDOR, CONSUMIDOR] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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
    'teste do seletor de tabela de preço',
  );
}

beforeEach(() => {
  vinculos = [];
  auxFalha = false;
  respostaDoVinculo = { status: 200, body: REVENDEDOR };
  REVENDEDOR.price_table_id = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <ClientesPage />
    </MemoryRouter>,
  );
}

describe('o gerente liga o cliente à tabela', () => {
  it('o seletor existe por cliente, e nomeia de quem é', async () => {
    entrarComo('gerente_loja');
    montar();
    // `aria-label` com o nome: numa lista de trinta clientes há trinta
    // seletores iguais, e "Tabela de preço" sozinho não diria de qual deles o
    // leitor de tela está falando.
    await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');
    await screen.findByLabelText('Tabela de preço de Maria da Silva');
  });

  it('escolher a tabela manda o id para a rota do cliente certo', async () => {
    entrarComo('gerente_loja');
    montar();
    const seletor = await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');

    fireEvent.change(seletor, { target: { value: 't-atacado' } });

    await waitFor(() => expect(vinculos).toHaveLength(1));
    expect(vinculos[0].url).toContain('/core/customers/c-revenda/price-table');
    expect(vinculos[0].body).toEqual({ priceTableId: 't-atacado' });
  });

  it('diz o que passa a valer, e a partir de quando', async () => {
    entrarComo('gerente_loja');
    montar();
    const seletor = await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');

    fireEvent.change(seletor, { target: { value: 't-atacado' } });

    // "Salvo" não responde a pergunta que se faz aqui. O gerente precisa saber
    // que a venda em andamento no balcão NÃO muda, e a próxima sim.
    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toContain('PJ Motos Revenda');
    expect(aviso.textContent).toContain('Atacado');
    expect(aviso.textContent).toContain('15.00%');
    expect(aviso.textContent).toContain('próxima venda');
  });

  it('desfazer o vínculo manda NULO, e não string vazia', async () => {
    /*
      O servidor grava o que chegar. `""` no lugar de `null` deixaria o cliente
      apontando para uma tabela inexistente: `priceTableForCustomer` não acharia
      nada e o preço voltaria ao normal por acidente — até alguém criar uma
      tabela e o `JOIN` casar de novo. Desfazer precisa ser uma decisão gravada,
      não um efeito colateral.
    */
    REVENDEDOR.price_table_id = 't-atacado';
    entrarComo('gerente_loja');
    montar();
    const seletor = await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');
    expect((seletor as HTMLSelectElement).value).toBe('t-atacado');

    fireEvent.change(seletor, { target: { value: '' } });

    await waitFor(() => expect(vinculos).toHaveLength(1));
    expect(vinculos[0].body).toEqual({ priceTableId: null });
    expect((await screen.findByRole('status')).textContent).toContain('preço normal');
  });

  it('tabela DESATIVADA não é oferecida', async () => {
    entrarComo('gerente_loja');
    montar();
    const seletor = await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');

    const opcoes = Array.from((seletor as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opcoes).toContain('Atacado (-15.00%)');
    // O servidor recusa com 404 dizendo "não encontrada ou desativada". Deixar
    // a opção na lista faria o gerente descobrir a regra pelo erro.
    expect(opcoes.some((t) => t?.includes('Promoção 2024'))).toBe(false);
  });

  it('a recusa do servidor aparece — senão o gerente sai achando que concedeu', async () => {
    respostaDoVinculo = {
      status: 404,
      body: {
        error: {
          code: 'CORE_PRICE_TABLE_NOT_FOUND',
          message: 'Tabela de preço não encontrada ou desativada.',
        },
      },
    };
    entrarComo('gerente_loja');
    montar();
    const seletor = await screen.findByLabelText('Tabela de preço de PJ Motos Revenda');

    fireEvent.change(seletor, { target: { value: 't-atacado' } });

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('não encontrada ou desativada');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('quem não é gerência', () => {
  it('vê a tabela do cliente, mas não a troca', async () => {
    REVENDEDOR.price_table_id = 't-atacado';
    entrarComo('atendente');
    montar();

    await screen.findByText('PJ Motos Revenda');
    // Sem seletor: a rota é de gerência, e tela que oferece o que o servidor
    // recusa com 403 ensina o operador a desconfiar da tela.
    expect(screen.queryByLabelText('Tabela de preço de PJ Motos Revenda')).toBeNull();
    // Mas a informação continua: quem atende precisa saber que aquele cliente
    // tem condição especial antes de prometer outro desconto.
    expect(screen.getByText('Tabela vinculada')).toBeTruthy();
  });

  it('o atendente não pede a lista de tabelas ao servidor', async () => {
    entrarComo('atendente');
    montar();
    await screen.findByText('PJ Motos Revenda');

    const chamadas = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(chamadas.some((c) => String(c[0]).includes('/core/catalog/aux'))).toBe(false);
  });
});

describe('sem a lista de tabelas', () => {
  it('mostra que há vínculo em vez de um seletor vazio', async () => {
    /*
      Um seletor com só "Preço normal" pareceria dizer "este cliente não tem
      tabela nenhuma disponível", e o gerente concluiria que alguém apagou o
      cadastro. Ficar sem editar é aceitável; mentir sobre o estado, não.
    */
    auxFalha = true;
    REVENDEDOR.price_table_id = 't-atacado';
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('PJ Motos Revenda');
    await waitFor(() => expect(screen.getByText('Tabela vinculada')).toBeTruthy());
    expect(screen.queryByLabelText('Tabela de preço de PJ Motos Revenda')).toBeNull();
  });
});
