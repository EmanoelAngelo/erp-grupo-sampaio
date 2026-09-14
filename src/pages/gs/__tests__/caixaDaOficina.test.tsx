/**
 * O CAIXA DA OFICINA PELA TELA — GAP-PRD-042, 104, 209 e 105.
 *
 * ## O que cada bloco derruba
 *
 *   - tire o botão "OS a receber" do PDV e o caixa da oficina (que mora no
 *     ambiente `pdv`) volta a não ter onde receber a OS;
 *   - troque o `PagamentoDialog` por um meio só e o split/troco some do corpo;
 *   - tire o desconto do corpo e o total recebido não bate com a OS;
 *   - gere uma chave nova a cada tentativa e o reenvio depois de queda de
 *     rede cobra duas vezes;
 *   - ignore `CORE_DISCOUNT_NEEDS_AUTHORIZATION` / `CORE_CANCEL_NEEDS_AUTHORIZATION`
 *     e o caixa fica parado diante de uma faixa vermelha sem saída;
 *   - ofereça "Faturar" sem a política ligada ou sem cliente e o servidor
 *     recusaria com o cliente na frente.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PdvPage from '../PdvPage';
import OrdemServicoPage from '../OrdemServicoPage';
import { RecebimentoOsDialog } from '@/components/gs/RecebimentoOsDialog';

const CAIXA_ABERTO = { id: 'gaveta-oficina', opening_cents: 10000, status: 'open' };

const OS_NA_FILA = {
  id: 'os-43',
  number: 43,
  status: 'aguardando_pagamento',
  customer_id: 'cli-1',
  customer_display: 'Dona Marta',
  equipment_display: 'Shineray PT2',
  plate: null,
  workshop_name: 'Bancada de mobilidade',
  mechanic_name: 'Zé Mecânico',
  labor_cents: 15000,
  parts_cents: 5000,
  total_cents: 20000,
};

interface Pedido {
  alvo: string;
  metodo: string;
  corpo: Record<string, unknown>;
  chave: string | null;
}

let pedidos: Pedido[];
let fila: {
  items: (typeof OS_NA_FILA)[];
  total: number;
  temOficina: boolean;
  faturamentoAPrazo: { habilitado: boolean; prazoDias: number };
};
/** Respostas do checkout, em ordem — cada chamada consome a primeira. */
let respostasDoCheckout: (() => Response | Promise<Response>)[];
let respostasDoEstorno: (() => Response)[];
let osDaFicha: Record<string, unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recusa(code: string, message: string, status: number, details?: unknown) {
  return json({ error: { code, message, details } }, status);
}

const RECEBIDA = () =>
  json(
    {
      order: { ...OS_NA_FILA, status: 'finalizada', sale_id: 'venda-9', paid_at: '2026-09-11T12:00:00Z' },
      sale: { id: 'venda-9', number: 9, total_cents: 18000, change_cents: 0, status: 'completed' },
      replay: false,
    },
    201,
  );

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (
      url: string | URL | Request,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const cabecalhos = init?.headers ?? {};
      if (metodo !== 'GET') {
        pedidos.push({ alvo, metodo, corpo, chave: cabecalhos['Idempotency-Key'] ?? null });
      }

      if (alvo.includes('/core/workshop/pending-payment')) return json(fila);
      if (alvo.endsWith('/checkout') && metodo === 'POST') {
        const proxima = respostasDoCheckout.shift();
        return proxima ? proxima() : RECEBIDA();
      }
      if (alvo.endsWith('/estorno') && metodo === 'POST') {
        const proxima = respostasDoEstorno.shift();
        if (proxima) return proxima();
        osDaFicha = { ...osDaFicha, status: 'aguardando_pagamento', sale_id: null, paid_at: null };
        return json({ order: osDaFicha, sale: { id: 'venda-9', status: 'cancelled' } });
      }
      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        return json({ id: 'liberacao-1', action: String(corpo.action) }, 201);
      }
      if (alvo.includes('/core/cash/open')) {
        return json({ session: CAIXA_ABERTO, cashWithdrawalLimitCents: null });
      }
      if (alvo.includes('/core/print/jobs') && metodo === 'POST') {
        return json({ id: 'job-1', status: 'ready', payload: '<p>cupom</p>' }, 201);
      }
      if (/\/core\/workshop\/orders\/[^/]+$/.test(alvo)) return json(osDaFicha);
      if (alvo.includes('/payment-methods')) {
        return json({
          methods: [
            { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
            { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
            { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
            { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
          ],
        });
      }
      if (alvo.includes('/terminal/status')) {
        return json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      if (alvo.includes('/core/sellers')) return json({ items: [] });
      if (alvo.includes('/core/workshop/parts')) return json({ items: [] });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string, userId = 'user-caixa') {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: userId, login: userId, displayName: 'Caixa da Oficina', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  respostasDoCheckout = [];
  respostasDoEstorno = [];
  fila = {
    items: [OS_NA_FILA],
    total: 1,
    temOficina: true,
    faturamentoAPrazo: { habilitado: false, prazoDias: 0 },
  };
  osDaFicha = {
    ...OS_NA_FILA,
    status: 'finalizada',
    sale_id: 'venda-9',
    paid_at: '2026-09-11T12:00:00.000Z',
    workshop_id: 'wk-1',
    mechanic_id: 'user-mec',
    customer_phone: null,
    equipment_public_id: null,
    equipment_serial: null,
    complaint: 'não liga',
    diagnosis: 'controlador',
    opened_by_customer: 0,
    approval_requested_at: null,
    approved_at: null,
    priority: 'media',
    due_date: null,
    created_at: '2026-09-10T12:00:00.000Z',
    parts: [],
    comments: [],
    events: [],
  };
  localStorage.clear();
  servidor();
  entrarComo('operador_caixa_oficina');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montarPdv() {
  render(
    <MemoryRouter initialEntries={['/pdv']}>
      <PdvPage />
    </MemoryRouter>,
  );
}

function checkouts(): Pedido[] {
  return pedidos.filter((p) => p.alvo.endsWith('/checkout'));
}

/** Lança um meio no PagamentoDialog: escolhe, digita (vazio = o que falta) e lança. */
function lancar(meio: RegExp, valor = '') {
  const pagamento = within(screen.getByRole('dialog', { name: 'Pagamento' }));
  fireEvent.click(pagamento.getByRole('button', { name: meio }));
  fireEvent.change(pagamento.getByLabelText(/Valor recebido em/i), { target: { value: valor } });
  fireEvent.click(pagamento.getByRole('button', { name: /^Lançar$/ }));
}

/** O Finalizar DO DIÁLOGO — o PDV tem o dele atrás, e não é ele que se aperta. */
async function finalizar() {
  const pagamento = within(screen.getByRole('dialog', { name: 'Pagamento' }));
  const botao = pagamento.getByRole('button', { name: /^Finalizar/ }) as HTMLButtonElement;
  await waitFor(() => expect(botao.disabled).toBe(false));
  fireEvent.click(botao);
}

// ============================================================================

/**
 * O RECEBIMENTO QUE JÁ TINHA SIDO REGISTRADO COM OUTRO PAGAMENTO (R2-IDEM,
 * item 6).
 *
 * A chave é uma por diálogo. Resposta perdida (o servidor recebeu a OS no PIX)
 * e o caixa trocou para dinheiro antes de tentar de novo: o servidor recusa a
 * mesma chave com outro dinheiro (422 CORE_IDEMPOTENCY_KEY_REUSED, com a venda
 * no detalhe), e a tela repetia o texto do servidor a cada clique.
 *
 * Aqui NÃO há "registrar como novo": o 422 só chega quando a venda da chave é
 * a venda desta OS (WorkshopCashierService, `receberOs`: chave de outro
 * documento é 409 CORE_CHECKOUT_KEY_CONFLICT) — a OS já está recebida, e uma
 * chave nova daria 409 CORE_ORDER_NOT_AWAITING_PAYMENT. Oferecer o botão seria
 * oferecer a porta que nunca abre; o que a tela faz é dizer que a OS está paga,
 * e em qual venda.
 */
describe('R2-IDEM — o recebimento que a tentativa já registrou (422)', () => {
  it('diz que a OS já foi recebida, na venda do servidor, sem cobrar de novo e sem o jargão', async () => {
    respostasDoCheckout = [
      () =>
        recusa(
          'CORE_IDEMPOTENCY_KEY_REUSED',
          'Esta chave de idempotência já registrou a venda #9 desta OS, com outro conteúdo — nada foi registrado '
            + 'agora. Um pedido novo precisa de chave nova.',
          422,
          { saleId: 'venda-9', saleNumber: 9 },
        ),
    ];
    const onCancel = vi.fn();
    render(
      <RecebimentoOsDialog
        os={OS_NA_FILA}
        cashSessionId="gaveta-oficina"
        faturamentoAPrazo={{ habilitado: false, prazoDias: 30 }}
        onRecebido={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Receber R\$\s200,00$/ }));
    await screen.findByRole('button', { name: /^Dinheiro/ });
    lancar(/^Dinheiro/);
    await finalizar();

    const aviso = await screen.findByRole('dialog', { name: /já foi recebida/i });
    expect(aviso.textContent).toContain('venda #9');
    expect(aviso.textContent).toMatch(/nada foi cobrado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    // A porta que nunca abre não é oferecida.
    expect(within(aviso).queryByRole('button', { name: /novo/i })).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(checkouts()).toHaveLength(1);

    fireEvent.click(within(aviso).getByRole('button', { name: /Fechar o recebimento/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(checkouts()).toHaveLength(1);
  });
});

describe('GAP-PRD-042 — a fila da oficina no PDV', () => {
  it('o caixa da oficina vê "OS a receber", abre a fila e recebe a OS com split e desconto', async () => {
    montarPdv();
    fireEvent.click(await screen.findByRole('button', { name: 'OS a receber (1)' }));
    expect(await screen.findByText('Dona Marta · Shineray PT2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Receber OS #43' }));

    // Resumo: R$ 20,00 de desconto sobre R$ 200,00.
    fireEvent.change(await screen.findByLabelText('Desconto da OS'), { target: { value: '20' } });
    expect(screen.getByTestId('os-a-receber-total').textContent).toMatch(/^R\$\s180,00$/);
    fireEvent.click(screen.getByRole('button', { name: /^Receber R\$\s180,00$/ }));

    // O fechamento do PDV: R$ 100,00 em dinheiro e o resto no PIX.
    await screen.findByRole('button', { name: /^PIX/ });
    lancar(/^Dinheiro/, '100,00');
    lancar(/^PIX/);
    await finalizar();

    await waitFor(() => expect(checkouts()).toHaveLength(1));
    const [pedido] = checkouts();
    expect(pedido.alvo).toContain('/core/workshop/orders/os-43/checkout');
    expect(pedido.corpo.payments).toEqual([
      { method: 'dinheiro', amountCents: 10000 },
      { method: 'pix', amountCents: 8000 },
    ]);
    expect(pedido.corpo.discountCents).toBe(2000);
    expect(pedido.corpo.cashSessionId).toBe('gaveta-oficina');
    expect(pedido.chave).toMatch(/^os-recebimento-/);

    // A faixa do PDV diz o que aconteceu, e o painel do comprovante aparece.
    expect(await screen.findByText('OS #43 recebida — venda #9')).toBeTruthy();
  });

  it('o caixa da LOJA não pede a fila nem vê o botão', async () => {
    entrarComo('operador_caixa_loja');
    montarPdv();
    await screen.findByRole('button', { name: /Cliente \(F2\)/ });
    expect(screen.queryByRole('button', { name: /OS a receber/ })).toBeNull();
    const pediuFila = (vi.mocked(fetch).mock.calls as unknown[][]).some((c) =>
      String(c[0]).includes('/pending-payment'),
    );
    expect(pediuFila).toBe(false);
  });

  it('empresa sem bancada não mostra o botão, mesmo para quem receberia', async () => {
    fila = { ...fila, items: [], total: 0, temOficina: false };
    montarPdv();
    await screen.findByRole('button', { name: /Cliente \(F2\)/ });
    // A fila respondeu; o botão só não tem por que existir.
    await waitFor(() =>
      expect(
        (vi.mocked(fetch).mock.calls as unknown[][]).some((c) =>
          String(c[0]).includes('/pending-payment'),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('button', { name: /OS a receber/ })).toBeNull();
  });
});

// ============================================================================

function montarRecebimento(
  extra: Partial<{ habilitado: boolean; semCliente: boolean }> = {},
  onRecebido = vi.fn(),
) {
  render(
    <RecebimentoOsDialog
      os={{ ...OS_NA_FILA, customer_id: extra.semCliente ? null : OS_NA_FILA.customer_id }}
      cashSessionId="gaveta-oficina"
      faturamentoAPrazo={{ habilitado: extra.habilitado ?? false, prazoDias: 30 }}
      onRecebido={onRecebido}
      onCancel={() => undefined}
    />,
  );
  return onRecebido;
}

describe('GAP-PRD-104 — alçada, fiado e a mesma chave', () => {
  it('desconto acima da alçada abre a senha do gestor, e o recebimento sai de novo com a liberação e a MESMA chave', async () => {
    respostasDoCheckout = [
      () =>
        recusa(
          'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
          'Esta venda concede R$ 50,00 sobre R$ 200,00 (25%), acima do limite de 10%.',
          403,
          { concedidoCents: 5000, brutoCents: 20000 },
        ),
    ];
    const onRecebido = montarRecebimento();
    fireEvent.change(screen.getByLabelText('Desconto da OS'), { target: { value: '25%' } });
    fireEvent.click(screen.getByRole('button', { name: /^Receber R\$\s150,00$/ }));
    await screen.findByRole('button', { name: /^PIX/ });
    lancar(/^PIX/);
    await finalizar();

    // A recusa vira o diálogo do gestor — não uma faixa vermelha.
    await screen.findByRole('dialog', { name: 'Autorização do gestor' });
    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'carlos' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    await waitFor(() => expect(onRecebido).toHaveBeenCalledTimes(1));
    const liberacao = pedidos.find((p) => p.alvo.includes('/core/authorizations'));
    expect(liberacao?.corpo).toMatchObject({
      action: 'desconto_acima_limite',
      concedidoCents: 5000,
      brutoCents: 20000,
    });
    const [primeiro, segundo] = checkouts();
    expect(segundo.corpo.authorizationId).toBe('liberacao-1');
    expect(segundo.corpo.discountCents).toBe(5000);
    expect(segundo.corpo.payments).toEqual(primeiro.corpo.payments);
    // A MESMA chave: se o primeiro tivesse gravado, o segundo seria o reenvio.
    expect(segundo.chave).toBe(primeiro.chave);
  });

  it('queda de rede: tentar de novo reusa a chave — o servidor devolve o que já aconteceu', async () => {
    respostasDoCheckout = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () =>
        json(
          {
            order: { ...OS_NA_FILA, status: 'finalizada' },
            sale: { id: 'venda-9', number: 9, total_cents: 20000, change_cents: 0 },
            replay: true,
          },
          200,
        ),
    ];
    const onRecebido = montarRecebimento();
    fireEvent.click(screen.getByRole('button', { name: /^Receber R\$\s200,00$/ }));
    await screen.findByRole('button', { name: /^PIX/ });
    lancar(/^PIX/);
    await finalizar();
    expect(await screen.findByText(/este mesmo recebimento será reconhecido/i)).toBeTruthy();

    await finalizar();
    await waitFor(() => expect(onRecebido).toHaveBeenCalledTimes(1));
    const [a, b] = checkouts();
    expect(b.chave).toBe(a.chave);
    expect(onRecebido.mock.calls[0][0].replay).toBe(true);
  });

  it('faturar a prazo só aparece com a política ligada e cliente do cadastro — e manda a lista vazia', async () => {
    const onRecebido = montarRecebimento({ habilitado: true });
    fireEvent.click(
      screen.getByRole('button', { name: 'Faturar para Dona Marta (vence em 30 dia(s))' }),
    );
    await waitFor(() => expect(onRecebido).toHaveBeenCalledTimes(1));
    expect(checkouts()[0].corpo.payments).toEqual([]);
  });

  it('com a política desligada, ou sem cliente do cadastro, não há botão de faturar', () => {
    montarRecebimento({ habilitado: false });
    expect(screen.queryByRole('button', { name: /^Faturar/ })).toBeNull();
    cleanup();
    montarRecebimento({ habilitado: true, semCliente: true });
    expect(screen.queryByRole('button', { name: /^Faturar/ })).toBeNull();
    expect(screen.getByText(/precisa de cliente do cadastro/)).toBeTruthy();
  });
});

// ============================================================================

function montarFicha() {
  render(
    <MemoryRouter initialEntries={['/sistema/oficina/os/os-43']}>
      <Routes>
        <Route path="/sistema/oficina/os/:id" element={<OrdemServicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GAP-PRD-105 — a OS paga tem comprovante e estorno', () => {
  it('o gerente da oficina estorna com motivo, e a OS volta para a fila do caixa', async () => {
    entrarComo('gerente_oficina', 'user-gerente');
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Estornar recebimento' }));
    const confirmar = screen.getAllByRole('button', { name: 'Estornar recebimento' }).at(-1)!;
    expect((confirmar as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo do estorno'), {
      target: { value: 'Lançado em dinheiro, o cliente pagou no PIX' },
    });
    fireEvent.click(confirmar);

    await waitFor(() => {
      const estorno = pedidos.find((p) => p.alvo.endsWith('/os-43/estorno'));
      expect(estorno?.corpo.reason).toBe('Lançado em dinheiro, o cliente pagou no PIX');
    });
    expect(
      await screen.findByText('Recebimento estornado — a OS voltou para a fila do caixa.'),
    ).toBeTruthy();
    // A ficha releu: a OS está de volta à fila e oferece receber de novo.
    expect(await screen.findByRole('button', { name: 'Registrar recebimento' })).toBeTruthy();
  });

  it('o caixa estorna com a senha do gestor, presa à venda da OS', async () => {
    respostasDoEstorno = [
      () =>
        recusa('CORE_CANCEL_NEEDS_AUTHORIZATION', 'Peça a liberação de um gestor.', 403, {
          action: 'cancelar_venda',
          referenceId: 'venda-9',
        }),
    ];
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Estornar recebimento' }));
    fireEvent.change(screen.getByLabelText('Motivo do estorno'), {
      target: { value: 'cobrado em dobro' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Estornar recebimento' }).at(-1)!);

    await screen.findByRole('dialog', { name: 'Autorização do gestor' });
    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'carlos' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    await waitFor(() => {
      const estornos = pedidos.filter((p) => p.alvo.endsWith('/estorno'));
      expect(estornos).toHaveLength(2);
      expect(estornos[1].corpo.authorizationId).toBe('liberacao-1');
    });
    const liberacao = pedidos.find((p) => p.alvo.includes('/core/authorizations'));
    expect(liberacao?.corpo).toMatchObject({ action: 'cancelar_venda', referenceId: 'venda-9' });
  });

  it('imprimir o comprovante manda a venda da OS para a fila de impressão', async () => {
    const abrir = vi.spyOn(window, 'open').mockReturnValue(null);
    montarFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Imprimir comprovante' }));
    await waitFor(() => {
      const job = pedidos.find((p) => p.alvo.includes('/core/print/jobs'));
      expect(job?.corpo).toMatchObject({ documentType: 'SALE_RECEIPT', documentId: 'venda-9' });
    });
    abrir.mockRestore();
  });

  it('o mecânico não vê comprovante nem estorno — dinheiro é gesto do caixa', async () => {
    entrarComo('mecanico', 'user-mec');
    montarFicha();
    await screen.findByText('Finalizada');
    expect(screen.queryByRole('button', { name: 'Estornar recebimento' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Imprimir comprovante' })).toBeNull();
  });
});
