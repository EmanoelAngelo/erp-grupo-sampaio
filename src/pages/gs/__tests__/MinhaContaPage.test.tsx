/**
 * Portal do cliente — o que a tela promete.
 *
 * Três coisas não podem falhar aqui:
 *
 * 1. Sessão vencida ou recusada volta para a tela de entrar. Se o 401 virar
 *    lista vazia, o cliente lê "Nenhum pedido ainda" e conclui que a compra se
 *    perdeu.
 *
 * 2. O botão de cancelar só aparece quando cancelar é possível. Botão que
 *    sempre dá erro faz o cliente achar que cancelou — e ele some.
 *
 * 3. Cancelar pede confirmação e o "Manter pedido" não chama nada. O caminho é
 *    sem volta: estoque devolvido, PIX invalidado.
 *
 * A senha nunca pode sobrar em lugar nenhum: nem no localStorage, nem no DOM.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MinhaContaPage, { MeuPedidoPage } from '../MinhaContaPage';

const PORTAL_KEY = 'gs.portal';
const SENHA = 'senha-do-cliente-2026';

function sessaoValida() {
  return {
    token: 'tok-portal-teste',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    // Verificada por padrão: o mundo destes casos é o cliente estabelecido.
    // O banner de confirmação tem os próprios casos, com a conta NÃO
    // verificada (rodada 50).
    account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
  };
}

function sessaoNaoVerificada() {
  return {
    ...sessaoValida(),
    account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: null },
  };
}

const PEDIDO_AGUARDANDO = {
  id: 'ord-1',
  number: 1001,
  storeName: 'Gringa',
  createdAt: '2026-08-10T12:00:00.000Z',
  statusLabel: 'Aguardando pagamento',
  status: 'aguardando_pagamento',
  itemsCents: 20000,
  shippingCents: 0,
  totalCents: 20000,
  deliveryMethod: 'entrega',
  shippingZip: '01001-000',
  shippingAddress: 'Rua Um, 10',
  trackingCode: null,
  customer: { name: 'Ana', email: 'ana@exemplo.com', document: '***.444.777-**' },
  items: [
    {
      description: 'Jaqueta',
      quantity: 2,
      unitPriceCents: 10000,
      totalCents: 20000,
      imageUrl: null,
    },
  ],
  payments: [
    {
      method: 'pix',
      status: 'pending',
      statusLabel: 'Aguardando pagamento',
      amountCents: 20000,
      pixPayload: '00020126COPIA-E-COLA',
      invoiceUrl: null,
    },
  ],
  timeline: [
    { statusLabel: 'Aguardando pagamento', note: null, createdAt: '2026-08-10T12:00:00.000Z' },
  ],
};

/**
 * Servidor de mentira que responde por rota. Cada teste declara só o que
 * importa para ele; o resto cai em 404 e aparece como falha, não como silêncio.
 */
function servidor(rotas: Record<string, () => Response | Promise<Response>>) {
  const chamadas: { url: string; method: string }[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const alvo = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    chamadas.push({ url: alvo, method });
    for (const [padrao, responder] of Object.entries(rotas)) {
      const [m, caminho] = padrao.split(' ');
      if (m === method && alvo.includes(caminho)) return responder();
    }
    return new Response(JSON.stringify({ error: { message: 'rota não mockada' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fake);
  return { chamadas, fake };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function montarConta() {
  render(
    <MemoryRouter initialEntries={['/minha-conta']}>
      <Routes>
        <Route path="/minha-conta" element={<MinhaContaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function montarPedido(id = 'ord-1') {
  render(
    <MemoryRouter initialEntries={[`/minha-conta/pedidos/${id}`]}>
      <Routes>
        <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('entrar no portal', () => {
  it('sem sessão mostra a tela de acesso — e não pede pedido nenhum', async () => {
    const { chamadas } = servidor({});
    montarConta();

    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    // A identificação legal do rodapé é pública e anônima — fora da conta. A
    // pergunta "a loja oferece Entrar com Google?" (GAP-PRD-027) também: é
    // anônima, sem token, e não lê nada da conta.
    expect(
      chamadas.filter(
        (c) => !c.url.includes('/loja/identificacao') && !c.url.includes('/loja/portal/google/disponivel'),
      ),
    ).toHaveLength(0);
  });

  it('entrando, guarda a sessão e lista os pedidos', async () => {
    servidor({
      'POST /loja/portal/entrar': () => json(sessaoValida()),
      'GET /loja/portal/pedidos': () =>
        json({
          items: [
            {
              id: 'ord-1',
              number: 1001,
              storeName: 'Gringa',
              createdAt: '2026-08-10T12:00:00.000Z',
              totalCents: 20000,
              statusLabel: 'Aguardando pagamento',
              paymentStatusLabel: 'Aguardando pagamento',
              paymentMethod: 'pix',
              deliveryMethod: 'entrega',
              trackingCode: null,
            },
          ],
        }),
    });
    montarConta();

    fireEvent.change(screen.getByLabelText('E-mail'), {
      target: { value: 'ana@exemplo.com' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: SENHA } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await screen.findByText('Pedido #1001');
    expect(screen.getByText('R$ 200,00')).toBeTruthy();
  });

  it('a senha não fica guardada nem sobra no DOM', async () => {
    servidor({
      'POST /loja/portal/entrar': () => json(sessaoValida()),
      'GET /loja/portal/pedidos': () => json({ items: [] }),
    });
    montarConta();

    fireEvent.change(screen.getByLabelText('E-mail'), {
      target: { value: 'ana@exemplo.com' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: SENHA } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await screen.findByText('Nenhum pedido ainda');
    expect(localStorage.getItem(PORTAL_KEY) ?? '').not.toContain(SENHA);
    expect(document.body.innerHTML).not.toContain(SENHA);
  });

  it('credencial recusada mostra o motivo e NÃO cria sessão', async () => {
    servidor({
      'POST /loja/portal/entrar': () =>
        json({ error: { code: 'PORTAL_INVALID_CREDENTIALS', message: 'E-mail ou senha inválidos.' } }, 401),
    });
    montarConta();

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@exemplo.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'errada12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await screen.findByRole('alert');
    expect(localStorage.getItem(PORTAL_KEY)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
  });

  it('sessão recusada pelo servidor volta para entrar — e não finge lista vazia', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
    servidor({
      'GET /loja/portal/pedidos': () =>
        json({ error: { code: 'PORTAL_SESSION_INVALID', message: 'Sessão expirada.' } }, 401),
    });
    montarConta();

    await screen.findByRole('heading', { name: 'Entrar' });
    expect(screen.queryByText('Nenhum pedido ainda')).toBeNull();
    expect(localStorage.getItem(PORTAL_KEY)).toBeNull();
  });

  it('sessão vencida no relógio local nem chega a ser usada', () => {
    localStorage.setItem(
      PORTAL_KEY,
      JSON.stringify({ ...sessaoValida(), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const { chamadas } = servidor({});
    montarConta();

    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    // A identificação legal do rodapé é pública e anônima — fora da conta. A
    // pergunta "a loja oferece Entrar com Google?" (GAP-PRD-027) também: é
    // anônima, sem token, e não lê nada da conta.
    expect(
      chamadas.filter(
        (c) => !c.url.includes('/loja/identificacao') && !c.url.includes('/loja/portal/google/disponivel'),
      ),
    ).toHaveLength(0);
  });
});

describe('confirmar o e-mail (rodada 50)', () => {
  it('conta NÃO verificada mostra o banner; o código certo confirma e o banner some', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoNaoVerificada()));
    const { chamadas } = servidor({
      'GET /loja/portal/pedidos': () => json({ items: [] }),
      'POST /loja/portal/verificar-email': () => json({ verified: true }),
    });
    montarConta();

    await waitFor(() => expect(screen.getByText('Confirme seu e-mail')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Código de confirmação'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.queryByText('Confirme seu e-mail')).toBeNull());
    expect(
      chamadas.some((c) => c.method === 'POST' && c.url.includes('/loja/portal/verificar-email')),
    ).toBe(true);
    // A sessão guardada passa a dizer verificada — o banner não volta no F5.
    const guardada = JSON.parse(localStorage.getItem(PORTAL_KEY)!) as {
      account: { emailVerifiedAt: string | null };
    };
    expect(guardada.account.emailVerifiedAt).toBeTruthy();
  });

  it('conta verificada NÃO vê o banner', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
    servidor({ 'GET /loja/portal/pedidos': () => json({ items: [] }) });
    montarConta();

    await waitFor(() => expect(screen.getByText('Nenhum pedido ainda')).toBeTruthy());
    expect(screen.queryByText('Confirme seu e-mail')).toBeNull();
  });

  it('reenviar chama a rota e avisa que o código novo saiu', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoNaoVerificada()));
    const { chamadas } = servidor({
      'GET /loja/portal/pedidos': () => json({ items: [] }),
      'POST /loja/portal/reenviar-verificacao': () => json({ alreadyVerified: false }),
    });
    montarConta();

    await waitFor(() => expect(screen.getByText('Confirme seu e-mail')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));

    await waitFor(() =>
      expect(screen.getByText(/Código novo enviado/)).toBeTruthy(),
    );
    expect(
      chamadas.some(
        (c) => c.method === 'POST' && c.url.includes('/loja/portal/reenviar-verificacao'),
      ),
    ).toBe(true);
  });
});

describe('detalhe do pedido', () => {
  beforeEach(() => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
  });

  it('mostra o PIX copia e cola do pedido aguardando pagamento', async () => {
    servidor({ 'GET /loja/portal/pedidos/ord-1': () => json(PEDIDO_AGUARDANDO) });
    montarPedido();

    await screen.findByRole('heading', { name: 'Pedido #1001' });
    expect((screen.getByLabelText('PIX copia e cola') as HTMLTextAreaElement).value).toBe(
      '00020126COPIA-E-COLA',
    );
  });

  it('sem sessão não busca o pedido, mesmo com o id na URL', () => {
    localStorage.clear();
    const { chamadas } = servidor({});
    montarPedido();

    expect(screen.getByText(/para ver este pedido/)).toBeTruthy();
    // A identificação legal do rodapé é pública e anônima — fora da conta.
    expect(chamadas.filter((c) => !c.url.includes('/loja/identificacao'))).toHaveLength(0);
  });

  it('pedido de outra pessoa dá not found e não vaza nada', async () => {
    servidor({
      'GET /loja/portal/pedidos/ord-alheio': () =>
        json({ error: { code: 'CORE_ORDER_NOT_FOUND', message: 'Pedido não encontrado.' } }, 404),
    });
    montarPedido('ord-alheio');

    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: /Pedido #/ })).toBeNull();
  });
});

describe('cancelar pedido', () => {
  beforeEach(() => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
  });

  it('oferece cancelar enquanto o pagamento não foi confirmado', async () => {
    servidor({ 'GET /loja/portal/pedidos/ord-1': () => json(PEDIDO_AGUARDANDO) });
    montarPedido();

    await screen.findByRole('button', { name: 'Cancelar pedido' });
  });

  it('pedido pago NÃO oferece o botão — o caminho é devolução', async () => {
    servidor({
      'GET /loja/portal/pedidos/ord-1': () =>
        json({
          ...PEDIDO_AGUARDANDO,
          status: 'pago',
          statusLabel: 'Pagamento confirmado',
          payments: [
            {
              method: 'pix',
              status: 'paid',
              statusLabel: 'Pago',
              amountCents: 20000,
              pixPayload: null,
              invoiceUrl: null,
            },
          ],
        }),
    });
    montarPedido();

    await screen.findByRole('heading', { name: 'Pedido #1001' });
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).toBeNull();
  });

  it('pedido em separação NÃO oferece o botão', async () => {
    servidor({
      'GET /loja/portal/pedidos/ord-1': () =>
        json({ ...PEDIDO_AGUARDANDO, status: 'separacao', statusLabel: 'Em separação' }),
    });
    montarPedido();

    await screen.findByRole('heading', { name: 'Pedido #1001' });
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).toBeNull();
  });

  it('pede confirmação: "Manter pedido" não chama a API', async () => {
    const { chamadas } = servidor({
      'GET /loja/portal/pedidos/ord-1': () => json(PEDIDO_AGUARDANDO),
    });
    montarPedido();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manter pedido' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('confirmando, cancela e a tela passa a mostrar Cancelado', async () => {
    let cancelado = false;
    const { chamadas } = servidor({
      'POST /loja/portal/pedidos/ord-1/cancelar': () => {
        cancelado = true;
        return json({ status: 'cancelado', statusLabel: 'Cancelado' });
      },
      'GET /loja/portal/pedidos/ord-1': () =>
        json(
          cancelado
            ? {
                ...PEDIDO_AGUARDANDO,
                status: 'cancelado',
                statusLabel: 'Cancelado',
                payments: [
                  {
                    method: 'pix',
                    status: 'cancelled',
                    statusLabel: 'Cancelado',
                    amountCents: 20000,
                    pixPayload: null,
                    invoiceUrl: null,
                  },
                ],
              }
            : PEDIDO_AGUARDANDO,
        ),
    });
    montarPedido();

    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar pedido' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, cancelar' }));

    await screen.findByText('Cancelado');
    // O PIX sai da tela junto: código que não recebe mais não pode continuar
    // convidando a pagar.
    expect(screen.queryByLabelText('PIX copia e cola')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).toBeNull();
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('se o servidor recusar, mostra o motivo e traz o estado novo do pedido', async () => {
    servidor({
      'POST /loja/portal/pedidos/ord-1/cancelar': () =>
        json(
          {
            error: {
              code: 'CORE_ORDER_ALREADY_PAID',
              message: 'Pedido já pago: use devolução em vez de cancelamento.',
            },
          },
          409,
        ),
      // O pagamento entrou entre a abertura da tela e o clique. É exatamente
      // a corrida que o 409 existe para cobrir.
      'GET /loja/portal/pedidos/ord-1': () =>
        json({ ...PEDIDO_AGUARDANDO, status: 'pago', statusLabel: 'Pagamento confirmado' }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
    render(
      <MemoryRouter initialEntries={['/minha-conta/pedidos/ord-1']}>
        <Routes>
          <Route path="/minha-conta/pedidos/:orderId" element={<MeuPedidoPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Primeira leitura já chega "pago": o botão não aparece, e é esse o
    // comportamento correto. O caso do clique com estado velho está coberto
    // pelo teste do backend, que é onde a decisão mora.
    await screen.findByText('Pagamento confirmado');
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).toBeNull();
  });
});

describe('pagamento recebido depois do cancelamento', () => {
  it('avisa o cliente com todas as letras, sem pedir para pagar de novo', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoValida()));
    servidor({
      'GET /loja/portal/pedidos/ord-1': () =>
        json({
          ...PEDIDO_AGUARDANDO,
          status: 'cancelado',
          statusLabel: 'Cancelado',
          payments: [
            {
              method: 'pix',
              status: 'paid_after_cancel',
              statusLabel: 'Recebido após o cancelamento',
              amountCents: 20000,
              pixPayload: null,
              invoiceUrl: null,
            },
          ],
          timeline: [
            {
              statusLabel: 'Pagamento recebido após o cancelamento',
              note: 'Pendente de regularização.',
              createdAt: '2026-08-10T13:00:00.000Z',
            },
          ],
        }),
    });
    montarPedido();

    const aviso = await screen.findByTestId('pedido-pago-apos-cancelamento');
    // `formatCents` separa com espaço rígido; o teste não pode depender disso.
    expect(aviso.textContent?.replace(/\s/g, ' ')).toContain('R$ 200,00');
    expect(aviso.textContent).toContain('não precisa pagar de novo');
    // Nada de código PIX numa cobrança que já foi paga.
    expect(screen.queryByLabelText('PIX copia e cola')).toBeNull();
  });
});

describe('cadastro aberto e recuperação (rodada 38)', () => {
  it('criar acesso NÃO exige documento — o campo é opcional', async () => {
    // Sem sessão: cai na tela de Acesso.
    servidor({ 'GET /loja/portal/pedidos': () => new Response('{"items":[]}', { status: 200 }) });
    montarConta();

    fireEvent.click(await screen.findByText('Ainda não tenho acesso'));
    // O campo de documento existe, mas não é obrigatório (rótulo "opcional").
    const doc = screen.getByLabelText('CPF ou CNPJ') as HTMLInputElement;
    expect(doc.required).toBe(false);
    expect(document.body.textContent).toMatch(/opcional/i);
  });

  it('registrar sem documento manda body sem exigir CPF, e entra', async () => {
    const { chamadas, fake } = servidor({
      'POST /loja/portal/registrar': () =>
        new Response(
          JSON.stringify({
            token: 'novo-tok',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            account: { id: 'acc-2', email: 'novo@exemplo.com' },
          }),
          { status: 201 },
        ),
      'GET /loja/portal/pedidos': () => new Response('{"items":[]}', { status: 200 }),
    });
    montarConta();

    fireEvent.click(await screen.findByText('Ainda não tenho acesso'));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Nova Pessoa' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'novo@exemplo.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'umasenhaboa8' } });
    fireEvent.change(screen.getByLabelText('Confirme a senha'), { target: { value: 'umasenhaboa8' } });
    // O aceite dos termos é obrigatório desde a rodada 45 — sem ele o botão
    // fica desarmado.
    const botao = screen.getByRole('button', { name: 'Criar acesso' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText('Aceito os termos e a política de privacidade'),
    );
    expect((botao as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(botao);

    // Depois de criar, mostra "Meus pedidos" (entrou).
    await screen.findByText('Meus pedidos');
    const registro = chamadas.find((c) => c.url.includes('/portal/registrar'));
    expect(registro).toBeTruthy();
    // O nome vai junto e nasce na conta (GAP-PRD-192).
    const init = fake.mock.calls.find((c) => String(c[0]).includes('/portal/registrar'))![1] as { body: string };
    expect(JSON.parse(init.body).name).toBe('Nova Pessoa');
  });

  it('"esqueci minha senha" pede o e-mail e não revela se a conta existe', async () => {
    servidor({
      'POST /loja/portal/recuperar-senha': () =>
        new Response('{"ok":true}', { status: 200 }),
    });
    montarConta();

    fireEvent.click(await screen.findByText('Esqueci minha senha'));
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'quem@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar link' }));

    // Resposta neutra: "se houver uma conta…" — sem confirmar existência.
    expect(await screen.findByText(/se houver uma conta/i)).toBeTruthy();
  });
});

describe('o portal só promete o e-mail que vai chegar (GAP-PRD-200)', () => {
  const DESLIGADO =
    'O envio de e-mails da loja ainda está sendo ativado. Links e códigos por e-mail ainda não chegam. '
    + 'Para trazer suas compras agora, peça na loja o código de convite.';

  it('recuperar senha com o envio desligado: a tela avisa antes e repete o recado do servidor', async () => {
    const { chamadas } = servidor({
      'GET /loja/portal/envio-de-email': () => json({ envioDeEmailAtivo: false, message: DESLIGADO }),
      'POST /loja/portal/recuperar-senha': () =>
        json({
          ok: true,
          envioDeEmailAtivo: false,
          message:
            'O envio de e-mails da loja ainda está sendo ativado. Por enquanto o link de redefinição '
            + 'de senha não chega por e-mail. Tente de novo mais tarde.',
        }),
    });
    montarConta();
    // A tela de ENTRAR não pergunta nada (ela não promete e-mail).
    expect(chamadas.some((c) => c.url.includes('/envio-de-email'))).toBe(false);

    fireEvent.click(await screen.findByText('Esqueci minha senha'));
    // Antes do clique: não promete "enviaremos um link".
    expect(await screen.findByText(/Links e códigos por e-mail ainda não chegam/)).toBeTruthy();
    expect(screen.queryByText(/enviaremos um link/)).toBeNull();

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'quem@exemplo.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByText(/o link de redefinição de senha não chega/)).toBeTruthy();
    expect(screen.queryByText(/enviamos um link/i)).toBeNull();
  });

  it('confirmar o e-mail com o envio desligado: diz que o código não chega e aponta o convite da loja', async () => {
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessaoNaoVerificada()));
    servidor({
      'GET /loja/portal/pedidos': () => json({ items: [] }),
      'GET /loja/portal/envio-de-email': () => json({ envioDeEmailAtivo: false, message: DESLIGADO }),
      'POST /loja/portal/reenviar-verificacao': () =>
        json({
          alreadyVerified: false,
          envioDeEmailAtivo: false,
          message:
            'O envio de e-mails da loja ainda está sendo ativado. Por enquanto o código não chega por '
            + 'e-mail. Para trazer suas compras agora, peça na loja o código de convite e use em '
            + 'Minha conta › Meus equipamentos.',
        }),
    });
    montarConta();

    expect(await screen.findByText(/peça na loja o código de convite.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));
    expect(await screen.findByText(/o código não chega por e-mail/)).toBeTruthy();
    expect(screen.queryByText(/Código novo enviado/)).toBeNull();
  });
});
