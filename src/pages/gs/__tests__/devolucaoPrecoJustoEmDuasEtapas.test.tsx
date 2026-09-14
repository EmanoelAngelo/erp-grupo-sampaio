/**
 * A DEVOLUÇÃO DA PREÇO JUSTO EM DUAS ETAPAS, NA TELA.
 *
 * A tela só DIZIA "devolva R$ X ao cliente". Agora, quando o servidor responde
 * que a operação devolve em duas etapas (`fluxo: 'duas_etapas'`):
 *
 *   - a venda original aparece inteira antes dos itens (quem operou, fiscal,
 *     formas de pagamento, o pago por unidade);
 *   - cada item diz a CONDIÇÃO e pergunta "Retornar ao estoque disponível?" —
 *     avariado trava o SIM;
 *   - o motivo vem da lista, e "Confirmar mercadoria" não leva dinheiro nem
 *     gaveta;
 *   - REGISTRAR DEVOLUÇÃO AO CLIENTE registra o que de fato aconteceu, com a
 *     mesma chave no clique duplo (um POST só), a gaveta só no dinheiro, a
 *     instrução honesta no PIX e no cartão, e justificativa quando o meio não é
 *     o da venda.
 *
 * Como cada caso fica vermelho: tire da tela o ramo `emEtapas` e a condição, o
 * painel e o corpo novo somem; tire `ocupado` do painel e o clique duplo manda
 * dois POSTs; mande `cashSessionId` no PIX e o terceiro caso o vê.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'preco-justo',
  customer_id: null,
  seller_id: null,
  cash_session_id: 'sessao-7',
  subtotal_cents: 10000,
  discount_cents: 0,
  total_cents: 10000,
  change_cents: 0,
  status: 'closed',
  note: null,
  created_at: '2026-09-14T10:00:00.000Z',
};

const ITEM = {
  sale_item_id: 'si-1',
  product_id: 'p-1',
  description: 'Camiseta',
  quantity: 2,
  unit_price_cents: 5000,
  total_cents: 10000,
  net_total_cents: 10000,
  returned_quantity: 0,
  returned_cents: 0,
  serialized: 0,
  units: [],
};

const FISCAL = {
  estado: 'nao_fiscal',
  rotulo: 'NÃO FISCAL',
  detalhe: 'A venda saiu com comprovante não fiscal: não há documento fiscal a regularizar.',
  documentoStatus: null,
};

let meioDaVenda: 'dinheiro' | 'pix';

function vendaParaDevolucao() {
  return {
    ...VENDA,
    surcharge_cents: 0,
    customer_name: null,
    seller_name: 'Beto',
    operator_name: 'Caixa Ana',
    payments: [{ method: meioDaVenda, amount_cents: 10000, status: 'settled' }],
    customerCreditCents: 0,
    fiscal: FISCAL,
    devolucoes: [],
  };
}

function detalhe(reembolsado: number) {
  const pendente = 10000 - reembolsado;
  return {
    id: 'r-1',
    number: 7,
    sale_id: 's-1',
    sale_number: 42,
    reason: 'Defeito',
    total_cents: 10000,
    refund_method: 'em_etapas',
    refund_flow: 'duas_etapas',
    reason_code: 'defeito',
    created_at: '2026-09-14T11:00:00.000Z',
    items: [
      {
        id: 'ri-1',
        sale_item_id: 'si-1',
        product_id: 'p-1',
        description: 'Camiseta',
        quantity: 2,
        unit_price_cents: 5000,
        total_cents: 10000,
        restock: 0,
        item_condition: 'avariado',
      },
    ],
    created_by_name: 'Fulano',
    approved_by_name: 'Fulano',
    mercadoria: { situacao: 'concluida', estoque: 'nao_retornou' },
    reembolso: {
      fluxo: 'duas_etapas',
      devolvivelCents: 10000,
      reembolsadoCents: reembolsado,
      pendenteCents: pendente,
      situacao: reembolsado === 0 ? 'pendente' : pendente > 0 ? 'parcial' : 'concluido',
      registros:
        reembolsado > 0
          ? [
              {
                id: 'f-1',
                method: meioDaVenda,
                amount_cents: reembolsado,
                original_method: null,
                method_justification: null,
                reference: null,
                note: null,
                cash_session_id: meioDaVenda === 'dinheiro' ? 'sessao-7' : null,
                created_by: 'u-1',
                created_by_name: 'Fulano',
                created_at: '2026-09-14T12:00:00.000Z',
              },
            ]
          : [],
      meiosDaVenda: [{ method: meioDaVenda, recebidoCents: 10000, reembolsadoCents: reembolsado, disponivelCents: pendente }],
      sugestao: pendente > 0 ? [{ method: meioDaVenda, cents: pendente }] : [],
    },
    fiscal: FISCAL,
  };
}

let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null; chave: string | null }[];
let consultasDoCaixa: number;
let historico: Record<string, unknown>[];

const devolucoes = () => enviados.filter((e) => e.metodo === 'POST' && /\/core\/sale-returns$/.test(e.url));
const reembolsos = () => enviados.filter((e) => e.metodo === 'POST' && e.url.includes('/refunds'));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: ConstructorParameters<typeof Headers>[0] }) => {
      const alvo = String(url).split('?')[0];
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') {
        enviados.push({
          url: alvo,
          metodo,
          corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
          chave: new Headers(init?.headers).get('Idempotency-Key'),
        });
      }
      if (alvo.endsWith('/refunds') && metodo === 'POST') return json({ ...detalhe(10000), refundId: 'f-1' }, 201);
      if (alvo.endsWith('/core/sale-returns/r-1')) return json(detalhe(0));
      if (alvo.endsWith('/core/sale-returns') && metodo === 'POST') return json(detalhe(0), 201);
      if (alvo.includes('/core/sale-returns')) return json({ items: historico });
      if (alvo.includes('/core/cash/open')) {
        consultasDoCaixa += 1;
        return json({ session: { id: 'sessao-7', opening_cents: 20000, status: 'open' }, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/returnable')) {
        return json({ items: [ITEM], fluxo: 'duas_etapas', venda: vendaParaDevolucao() });
      }
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  enviados = [];
  consultasDoCaixa = 0;
  meioDaVenda = 'dinheiro';
  historico = [];
  localStorage.clear();
  servidor();
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ADMIN-PREÇO JUSTO', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'gerente_loja' }],
    } as never,
    'LOGIN',
    'teste da devolução em duas etapas',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da devolução em duas etapas');
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

/** Abre o reembolso pela linha do histórico — a devolução de ontem, com o PIX por fazer. */
async function abrirReembolsoPeloHistorico() {
  historico = [
    {
      id: 'r-1',
      number: 7,
      sale_id: 's-1',
      sale_number: 42,
      reason: 'Defeito',
      total_cents: 10000,
      refund_method: 'em_etapas',
      refund_flow: 'duas_etapas',
      created_at: '2026-09-14T11:00:00.000Z',
      reembolso: { fluxo: 'duas_etapas', devolvivelCents: 10000, reembolsadoCents: 0, pendenteCents: 10000, situacao: 'pendente' },
    },
  ];
  montar();
  expect((await screen.findByTestId('reembolso-da-devolucao-7')).textContent).toContain('PENDENTE');
  fireEvent.click(screen.getByRole('button', { name: 'Registrar reembolso' }));
  return screen.findByTestId('painel-do-reembolso');
}

describe('a mercadoria: a venda inteira, a condição e o estoque', () => {
  it('mostra a venda original; avariado trava o SIM; "Confirmar mercadoria" não leva dinheiro nem gaveta', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Devolver desta' }));
    const venda = await screen.findByTestId('venda-da-devolucao');
    expect(venda.textContent).toContain('#42');
    expect(venda.textContent).toContain('Caixa Ana');
    expect(screen.getByTestId('fiscal-da-venda').textContent).toBe('NÃO FISCAL');
    expect(screen.getByTestId('pago-por-unidade-si-1').textContent).toContain('50,00');
    // O meio do dinheiro não é escolhido aqui: é o passo seguinte.
    expect(screen.queryByLabelText(/Como o dinheiro volta/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Devolver quantos de Camiseta/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Condição de Camiseta'), { target: { value: 'avariado' } });
    const sim = screen.getByLabelText('Sim — Camiseta volta ao estoque disponível') as HTMLInputElement;
    const nao = screen.getByLabelText('Não — Camiseta não volta ao estoque disponível') as HTMLInputElement;
    expect(sim.disabled).toBe(true);
    expect(nao.checked).toBe(true);

    const confirmar = screen.getByRole('button', { name: 'Confirmar mercadoria' }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: 'defeito' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar mercadoria' }));

    await waitFor(() => expect(devolucoes()).toHaveLength(1));
    const corpo = devolucoes()[0].corpo!;
    expect(corpo).toMatchObject({ saleId: 's-1', reasonCode: 'defeito', reason: 'Defeito' });
    expect(corpo.items).toEqual([expect.objectContaining({ saleItemId: 'si-1', quantity: 2, restock: false, condition: 'avariado' })]);
    expect(corpo.refundMethod).toBeUndefined();
    expect(corpo.cashSessionId).toBeUndefined();
    expect(devolucoes()[0].chave).toBeTruthy();
    expect(consultasDoCaixa).toBe(0);

    // A segunda etapa abre em seguida, com os três estados separados.
    const painel = await screen.findByTestId('painel-do-reembolso');
    expect(within(painel).getByTestId('estado-mercadoria').textContent).toBe('CONCLUÍDA');
    expect(within(painel).getByTestId('estado-estoque').textContent).toBe('NÃO RETORNOU');
    expect(within(painel).getByTestId('estado-reembolso').textContent).toBe('PENDENTE');
    expect(within(painel).getByTestId('valor-pendente').textContent).toContain('100,00');
    expect(within(painel).getByTestId('estado-fiscal').textContent).toBe('NÃO FISCAL');
  });
});

describe('REGISTRAR DEVOLUÇÃO AO CLIENTE', () => {
  it('dinheiro: o clique duplo manda UM registro, com a gaveta aberta; depois o reembolso aparece concluído', async () => {
    const painel = await abrirReembolsoPeloHistorico();
    expect(within(painel).getByTestId('instrucao-do-meio').textContent).toContain('DEVOLUÇÃO AO CLIENTE');
    const botao = within(painel).getByRole('button', { name: 'Registrar devolução ao cliente' }) as HTMLButtonElement;
    // Os dois cliques no MESMO act: a tela não redesenha entre eles, o botão
    // ainda está habilitado no segundo — é a trava por ref que barra o envio.
    act(() => {
      botao.click();
      botao.click();
    });

    await waitFor(() => expect(reembolsos()).toHaveLength(1));
    expect(reembolsos()[0].corpo).toMatchObject({ method: 'dinheiro', amountCents: 10000, cashSessionId: 'sessao-7' });
    expect(reembolsos()[0].chave).toBeTruthy();
    expect(await screen.findByTestId('reembolso-concluido')).toBeTruthy();
    expect(screen.getByTestId('estado-reembolso').textContent).toBe('CONCLUÍDO');
    expect(reembolsos()).toHaveLength(1);
  });

  it('PIX: a tela não finge que enviou; a referência vai no corpo e a gaveta nem é consultada', async () => {
    meioDaVenda = 'pix';
    const painel = await abrirReembolsoPeloHistorico();
    expect(within(painel).getByTestId('instrucao-do-meio').textContent).toContain('O DEVORA não envia PIX');
    fireEvent.change(within(painel).getByLabelText(/Referência do PIX/), { target: { value: 'E2E-778899' } });
    fireEvent.click(within(painel).getByRole('button', { name: 'Registrar PIX devolvido' }));

    await waitFor(() => expect(reembolsos()).toHaveLength(1));
    expect(reembolsos()[0].corpo).toMatchObject({ method: 'pix', amountCents: 10000, reference: 'E2E-778899', cashSessionId: null });
    expect(consultasDoCaixa).toBe(0);
  });

  it('meio diferente do original pede justificativa; o cartão diz para estornar na maquininha', async () => {
    const painel = await abrirReembolsoPeloHistorico();
    expect(within(painel).queryByLabelText(/Justificativa/)).toBeNull();
    fireEvent.change(within(painel).getByLabelText('Meio da devolução'), { target: { value: 'credito' } });
    expect(within(painel).getByTestId('instrucao-do-meio').textContent).toContain('Realize o estorno/reembolso na maquininha');
    expect(within(painel).getByRole('button', { name: 'Confirmar estorno realizado' })).toBeTruthy();
    expect(within(painel).getByLabelText(/Justificativa/)).toBeTruthy();
  });
});
