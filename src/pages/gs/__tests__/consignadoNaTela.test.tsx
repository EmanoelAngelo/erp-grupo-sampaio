/**
 * ============================================================================
 * CONSIGNAÇÃO NA TELA — o ciclo inteiro, e não um status (GAP-V65)
 * ============================================================================
 *
 * Gringa e Me Mimei mandam roupa "no condicional" todo dia. Não havia nada
 * disso no sistema — nem tela, nem rota, nem tabela —, e os dois contornos
 * possíveis mentiam sobre o estoque: a pré-venda diz que a peça continua na
 * arara (ela reserva, não retira) e não aceita retorno parcial; o caderno não
 * diz nada a ninguém.
 *
 * O que esta tela precisa provar, e é o que se cobra aqui:
 *
 *   1. A COLUNA "com o cliente" existe e mostra o número certo. É o motivo da
 *      tela existir: sem ela, a lista é um arquivo morto de papéis.
 *   2. A tela DIZ que a mercadoria sai do estoque — não que fica reservada.
 *      Quem vem da pré-venda espera o contrário, e a diferença é o que faz a
 *      contagem do mês fechar.
 *   3. O CLIENTE É OBRIGATÓRIO, e a recusa acontece antes de sair mercadoria.
 *   4. O RETORNO PARCIAL viaja com chave de idempotência — o clique duplo
 *      devolveria ao saldo peça que continua na casa da cliente.
 *   5. O FATURAMENTO cobra o preço CONGELADO na remessa, não o de hoje.
 *   6. FECHAR só aparece quando não sobrou nada com o cliente.
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - tire a coluna "Com o cliente" da tabela → o caso 1 fica vermelho;
 *   - deixe `salvar` mandar sem `customerId` → o caso 3 fica vermelho;
 *   - troque `uuid()` por uma constante no envio → o caso 4 continua verde,
 *     mas é o servidor quem cobra ali (ver `consignado-ciclo-real`);
 *   - calcule o total pelo preço do produto de hoje em vez de
 *     `unit_price_cents` → o caso 5 fica vermelho.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConsignacoesPage from '../ConsignacoesPage';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'LJ-0001',
  sku: null,
  barcode: '789',
  name: 'Vestido longo',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 8000,
  // O preço de HOJE subiu: a remessa foi congelada em R$ 200.
  price_cents: 26000,
  effective_price_cents: 26000,
  min_stock: 0,
  stock_quantity: 5,
  active: 1,
};

const NA_RUA = {
  id: 'c-1',
  number: 3,
  status: 'aberta',
  customer_id: 'cli-1',
  customer_name: 'Dona Marlene',
  valid_until: null,
  created_at: new Date().toISOString(),
  pending_qty: 4,
  pending_value_cents: 80000,
};

/** O detalhe: 5 saíram, 1 voltou, 4 ainda estão com ela. */
const DETALHE = {
  ...NA_RUA,
  seller_id: null,
  note: null,
  closed_at: null,
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      description: 'Vestido longo',
      delivered_qty: 5,
      returned_qty: 1,
      sold_qty: 0,
      // CONGELADO na remessa: R$ 200, e não os R$ 260 de hoje.
      unit_price_cents: 20000,
      pending_qty: 4,
    },
  ],
  events: [
    {
      id: 'e-1',
      kind: 'remessa',
      sale_id: null,
      sale_number: null,
      user_name: 'Vendedora',
      detail: null,
      created_at: new Date().toISOString(),
    },
  ],
};

let criadas: Record<string, unknown>[] = [];
let retornos: { body: Record<string, unknown>; chave: string | null }[] = [];
let faturamentos: { body: Record<string, unknown>; chave: string | null }[] = [];
/** Nada pendente: é o estado em que "Fechar" pode aparecer. */
let semPendencia = false;

function servidor() {
  criadas = [];
  retornos = [];
  faturamentos = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        const alvo = String(url);
        const metodo = (init?.method ?? 'GET').toUpperCase();
        const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const chave = init?.headers?.['Idempotency-Key'] ?? null;
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });

        if (alvo.includes('/core/customers')) {
          return json({ items: [{ id: 'cli-1', name: 'Dona Marlene' }] });
        }
        if (alvo.includes('/core/sellers')) return json({ items: [] });
        if (alvo.includes('/core/products/search')) return json({ items: [PRODUTO] });

        if (alvo.includes('/retorno') && metodo === 'POST') {
          retornos.push({ body: corpo, chave });
          return json({ eventId: 'e-2', duplicated: false }, 201);
        }
        if (alvo.includes('/faturar') && metodo === 'POST') {
          faturamentos.push({ body: corpo, chave });
          return json({ saleId: 's-1', number: 101, totalCents: 40000, duplicated: false }, 201);
        }
        if (alvo.includes('/fechar') && metodo === 'POST') return json(NA_RUA);

        const detalhe = alvo.match(/\/core\/consignments\/([^/?]+)$/);
        if (detalhe && metodo === 'GET') {
          if (!semPendencia) return json(DETALHE);
          return json({
            ...DETALHE,
            pending_qty: 0,
            items: [{ ...DETALHE.items[0], returned_qty: 5, pending_qty: 0 }],
          });
        }
        if (alvo.includes('/core/consignments') && metodo === 'POST') {
          criadas.push(corpo);
          return json({ id: 'c-nova', number: 4, status: 'aberta' }, 201);
        }
        if (alvo.includes('/core/consignments')) {
          return json({ items: [semPendencia ? { ...NA_RUA, pending_qty: 0 } : NA_RUA] });
        }

        return json({});
      },
    ),
  );
}

beforeEach(() => {
  semPendencia = false;
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function abrir() {
  render(
    <MemoryRouter>
      <ConsignacoesPage />
    </MemoryRouter>,
  );
}

async function abrirDetalhe() {
  abrir();
  fireEvent.click(await screen.findByRole('button', { name: /^Ver$/ }));
  await screen.findByText(/Consignação #3/);
}

describe('a lista mostra o que está com o cliente', () => {
  it('a coluna "com o cliente" traz quantidade e valor', async () => {
    abrir();
    await screen.findByText('#3');
    expect(screen.getByText('Dona Marlene')).toBeTruthy();
    // 4 peças, R$ 800 — o número que a vendedora procura ao telefone.
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/800,00/)).toBeTruthy();
  });

  it('a tela diz que a mercadoria SAI do estoque, e não que fica reservada', async () => {
    abrir();
    await screen.findByText('#3');
    expect(screen.getByText(/SAI do estoque/i)).toBeTruthy();
  });
});

describe('a remessa exige dono conhecido', () => {
  it('sem cliente, a mercadoria não sai — e a tela diz por quê', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: /Nova consignação/ }));
    fireEvent.change(await screen.findByLabelText(/Pesquise o produto/), {
      target: { value: 'Vestido' },
    });
    fireEvent.keyDown(screen.getByLabelText(/Pesquise o produto/), { key: 'Enter' });
    fireEvent.click(await screen.findByText('Vestido longo'));
    fireEvent.click(screen.getByRole('button', { name: /Registrar remessa/ }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/cliente/i);
    expect(criadas).toHaveLength(0);
  });

  it('com cliente e item, a remessa é registrada', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: /Nova consignação/ }));
    await waitFor(() => expect(screen.getByText('Dona Marlene')).toBeTruthy());
    // O cliente se escolhe por BUSCA (GAP-PRD-070): o seletor de 100 nomes
    // deixava de fora quem vinha depois do 100º.
    fireEvent.change(screen.getByLabelText(/^Cliente/), { target: { value: 'Dona' } });
    fireEvent.click(await screen.findByRole('button', { name: /Dona Marlene/ }));
    fireEvent.change(screen.getByLabelText(/Pesquise o produto/), {
      target: { value: 'Vestido' },
    });
    fireEvent.keyDown(screen.getByLabelText(/Pesquise o produto/), { key: 'Enter' });
    fireEvent.click(await screen.findByText('Vestido longo'));
    fireEvent.change(screen.getByLabelText(/Quantidade de Vestido longo/), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Registrar remessa/ }));

    await waitFor(() => expect(criadas).toHaveLength(1));
    expect(criadas[0].customerId).toBe('cli-1');
    expect((criadas[0].items as { quantity: number }[])[0].quantity).toBe(3);
  });
});

describe('o retorno parcial', () => {
  it('devolve só o que a cliente trouxe, com chave de idempotência', async () => {
    await abrirDetalhe();
    fireEvent.click(screen.getByRole('button', { name: /Registrar retorno/ }));

    fireEvent.change(await screen.findByLabelText(/Quantidade de Vestido longo/), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar retorno/ }));

    await waitFor(() => expect(retornos).toHaveLength(1));
    expect((retornos[0].body.items as { quantity: number }[])[0].quantity).toBe(2);
    // Sem a chave, o clique duplo devolveria duas vezes a mesma peça.
    expect(retornos[0].chave).toBeTruthy();
  });

  it('não deixa devolver mais do que está com o cliente', async () => {
    await abrirDetalhe();
    fireEvent.click(screen.getByRole('button', { name: /Registrar retorno/ }));
    fireEvent.change(await screen.findByLabelText(/Quantidade de Vestido longo/), {
      target: { value: '99' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar retorno/ }));

    await waitFor(() => expect(retornos).toHaveLength(1));
    // A tela corta no pendente; o servidor recusaria de todo jeito.
    expect((retornos[0].body.items as { quantity: number }[])[0].quantity).toBe(4);
  });
});

describe('o faturamento cobra o preço CONGELADO na remessa', () => {
  it('2 peças a R$ 200 dão R$ 400 — não R$ 520 da tabela de hoje', async () => {
    await abrirDetalhe();
    fireEvent.click(screen.getByRole('button', { name: /Faturar o que ficou/ }));

    fireEvent.change(await screen.findByLabelText(/Quantidade de Vestido longo/), {
      target: { value: '2' },
    });

    // A cliente levou por R$ 200 e paga R$ 200 — quem explicaria o contrário
    // seria a vendedora, que não teve parte no reajuste.
    await waitFor(() => expect(screen.getByText(/400,00/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Faturar e receber/ }));
    await waitFor(() => expect(faturamentos).toHaveLength(1));
    const pagamentos = faturamentos[0].body.payments as { amountCents: number }[];
    expect(pagamentos[0].amountCents).toBe(40000);
    expect(faturamentos[0].chave).toBeTruthy();
  });
});

describe('fechar só quando não sobrou nada', () => {
  it('com mercadoria na rua, o botão de fechar não aparece', async () => {
    await abrirDetalhe();
    expect(screen.queryByRole('button', { name: /Fechar consignação/ })).toBeNull();
    expect(screen.getByText(/devolva ou fature antes de fechar/i)).toBeTruthy();
  });

  it('sem pendência, o botão aparece', async () => {
    semPendencia = true;
    await abrirDetalhe();
    expect(screen.getByRole('button', { name: /Fechar consignação/ })).toBeTruthy();
  });
});
