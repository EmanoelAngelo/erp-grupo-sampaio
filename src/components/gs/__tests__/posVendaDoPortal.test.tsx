/**
 * O pós-venda no portal (GAP-PRD-125): a nota da compra, o pedido de
 * devolução da cliente e a decisão da loja.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NotaDoPedido } from '../NotaDoPedido';
import { DevolucaoDoPedido } from '../DevolucaoDoPedido';
import { SolicitacoesDeDevolucao } from '../SolicitacoesDeDevolucao';
import type { DevolucaoNoPortal, SolicitacaoDeDevolucao } from '@/lib/api/posVenda';

type Chamada = { url: string; method: string; headers: Record<string, string>; body: unknown };

function servidor(responder: (url: string) => Response) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      chamadas.push({
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return responder(String(url));
    }),
  );
  return chamadas;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOTA = {
  numero: 12,
  serie: 1,
  chave: '43260911222333000181550010000000121000000123',
  status: 'AUTHORIZED' as const,
  statusLabel: 'Autorizada',
  autorizadaEm: '2026-09-10T12:00:00.000Z',
  danfe: true,
  xml: true,
};

describe('a nota fiscal no portal', () => {
  it('pedido pago sem nota diz que ela vem; aguardando pagamento não mostra nada', () => {
    const { rerender } = render(<NotaDoPedido orderId="o1" token="t" nota={null} pago />);
    expect(screen.getByText('A nota fiscal aparece aqui assim que a loja emitir.')).toBeTruthy();
    rerender(<NotaDoPedido orderId="o1" token="t" nota={null} pago={false} />);
    expect(screen.queryByTestId('nota-do-pedido')).toBeNull();
  });

  it('mostra número, série, situação e chave', () => {
    render(<NotaDoPedido orderId="o1" token="t" nota={NOTA} pago />);
    expect(screen.getByText(/NF-e nº 12 \(série 1\)/)).toBeTruthy();
    expect(screen.getByText('Autorizada')).toBeTruthy();
    expect(screen.getByText(/Chave de acesso: 4326/)).toBeTruthy();
  });

  it('baixar o XML busca com o token do PORTAL (nunca o do ERP) e salva com o nome do servidor', async () => {
    const chamadas = servidor(
      () =>
        new Response('<nfeProc/>', {
          status: 200,
          headers: {
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="NFe-${NOTA.chave}.xml"`,
          },
        }),
    );
    const criar = vi.fn(() => 'blob:nota');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() }));
    const clicou = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<NotaDoPedido orderId="o1" token="tok-portal" nota={NOTA} pago />);
    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));

    await vi.waitFor(() => expect(clicou).toHaveBeenCalled());
    expect(chamadas[0].url).toContain('/api/v1/loja/portal/pedidos/o1/nfe/xml');
    expect(chamadas[0].headers).toEqual({ 'x-portal-token': 'tok-portal' });
    const ancora = clicou.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(ancora.download).toBe(`NFe-${NOTA.chave}.xml`);
  });

  it('a recusa do servidor aparece com as palavras dele', async () => {
    servidor(() => json({ error: { code: 'PORTAL_NFE_CANCELADA', message: 'A nota fiscal deste pedido foi cancelada.' } }, 409));
    render(<NotaDoPedido orderId="o1" token="t" nota={NOTA} pago />);
    fireEvent.click(screen.getByRole('button', { name: 'Baixar XML' }));
    expect(await screen.findByText('A nota fiscal deste pedido foi cancelada.')).toBeTruthy();
  });

  it('nota cancelada oferece o DANFE (com a tarja) e não o XML', () => {
    render(<NotaDoPedido orderId="o1" token="t" nota={{ ...NOTA, status: 'CANCELLED', statusLabel: 'Cancelada', xml: false }} pago />);
    expect(screen.getByRole('button', { name: 'Ver DANFE' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Baixar XML' })).toBeNull();
  });
});

const DENTRO_DO_PRAZO: DevolucaoNoPortal = {
  podeSolicitar: true,
  motivoIndisponivel: null,
  prazoArrependimentoAte: '2026-09-18',
  arrependimentoNoPrazo: true,
  solicitacoes: [],
};

describe('o pedido de devolução no portal', () => {
  it('diz até quando dá para desistir e envia tipo e motivo com o token do portal', async () => {
    const chamadas = servidor(() => json({ solicitacao: {}, devolucao: DENTRO_DO_PRAZO }, 201));
    const aoMudar = vi.fn();
    render(<DevolucaoDoPedido orderId="o7" token="tok-portal" devolucao={DENTRO_DO_PRAZO} aoMudar={aoMudar} />);

    expect(screen.getByText(/Você pode desistir da compra até 18\/09\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pedir devolução' }));
    fireEvent.change(screen.getByLabelText('O que aconteceu?'), { target: { value: 'Não serviu no meu filho' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido de devolução' }));

    await vi.waitFor(() => expect(aoMudar).toHaveBeenCalled());
    expect(chamadas[0].url).toContain('/loja/portal/pedidos/o7/devolucao');
    expect(chamadas[0].method).toBe('POST');
    expect(chamadas[0].headers['x-portal-token']).toBe('tok-portal');
    expect(chamadas[0].body).toEqual({ tipo: 'arrependimento', motivo: 'Não serviu no meu filho' });
  });

  it('fora do prazo, arrependimento fica indisponível e o defeito é o que sobra', () => {
    render(
      <DevolucaoDoPedido
        orderId="o7"
        token="t"
        devolucao={{ ...DENTRO_DO_PRAZO, arrependimentoNoPrazo: false, prazoArrependimentoAte: '2026-09-01' }}
        aoMudar={vi.fn()}
      />,
    );
    expect(screen.getByText(/O prazo de desistência terminou em 01\/09\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pedir devolução' }));
    const arrependimento = screen.getByRole('radio', { name: /arrependimento/ }) as HTMLInputElement;
    expect(arrependimento.disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /defeito/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('motivo curto não vai ao servidor; recusa do servidor aparece', async () => {
    const chamadas = servidor(() =>
      json({ error: { code: 'PORTAL_DEVOLUCAO_JA_SOLICITADA', message: 'Já existe um pedido de devolução em andamento para esta compra.' } }, 409),
    );
    render(<DevolucaoDoPedido orderId="o7" token="t" devolucao={DENTRO_DO_PRAZO} aoMudar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pedir devolução' }));
    fireEvent.change(screen.getByLabelText('O que aconteceu?'), { target: { value: 'curto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido de devolução' }));
    expect(await screen.findByText(/pelo menos 10 caracteres/)).toBeTruthy();
    expect(chamadas).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('O que aconteceu?'), { target: { value: 'Agora com motivo suficiente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedido de devolução' }));
    expect(await screen.findByText('Já existe um pedido de devolução em andamento para esta compra.')).toBeTruthy();
  });

  it('mostra as solicitações com a resposta da loja, e o motivo de não poder pedir de novo', () => {
    render(
      <DevolucaoDoPedido
        orderId="o7"
        token="t"
        devolucao={{
          ...DENTRO_DO_PRAZO,
          podeSolicitar: false,
          motivoIndisponivel: 'Já existe um pedido de devolução em andamento para esta compra.',
          solicitacoes: [
            {
              id: 'r1',
              orderId: 'o7',
              kind: 'defeito',
              kindLabel: 'Produto com defeito',
              reason: 'Costura aberta',
              status: 'aprovada',
              statusLabel: 'Aprovada — combine com a loja a entrega do produto',
              decisionNote: 'Traga na loja com a etiqueta',
              createdAt: '2026-09-11T10:00:00.000Z',
              decidedAt: '2026-09-11T11:00:00.000Z',
            },
          ],
        }}
        aoMudar={vi.fn()}
      />,
    );
    expect(screen.getByText(/Aprovada — combine com a loja/)).toBeTruthy();
    expect(screen.getByText('Resposta da loja: Traga na loja com a etiqueta')).toBeTruthy();
    expect(screen.getByText('Já existe um pedido de devolução em andamento para esta compra.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pedir devolução' })).toBeNull();
  });
});

const ABERTA: SolicitacaoDeDevolucao = {
  id: 'r9',
  orderId: 'o9',
  kind: 'arrependimento',
  kindLabel: 'Desistência (arrependimento)',
  reason: 'Comprei o tamanho errado',
  status: 'aberta',
  statusLabel: 'Aguardando a loja',
  decisionNote: null,
  createdAt: '2026-09-11T10:00:00.000Z',
  decidedAt: null,
};

describe('a loja decide o pedido de devolução', () => {
  it('aprovar manda a decisão e a instrução opcional', async () => {
    const chamadas = servidor(() => json({ ...ABERTA, status: 'aprovada' }));
    const aoConcluir = vi.fn();
    render(<SolicitacoesDeDevolucao orderId="o9" solicitacoes={[ABERTA]} aoConcluir={aoConcluir} aoFalhar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar devolução' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Aprovar a devolução' });
    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: 'Traga na loja' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aprovar' }));
    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas[0].url).toContain('/core/orders/o9/devolucao/solicitacoes/r9/decidir');
    expect(chamadas[0].body).toEqual({ decisao: 'aprovar', nota: 'Traga na loja' });
  });

  it('aprovar sem instrução também vale — ela é opcional', async () => {
    const chamadas = servidor(() => json({ ...ABERTA, status: 'aprovada' }));
    const aoConcluir = vi.fn();
    render(<SolicitacoesDeDevolucao orderId="o9" solicitacoes={[ABERTA]} aoConcluir={aoConcluir} aoFalhar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar devolução' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Aprovar a devolução' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Aprovar' }));
    await vi.waitFor(() => expect(aoConcluir).toHaveBeenCalled());
    expect(chamadas[0].body).toEqual({ decisao: 'aprovar' });
  });

  it('recusar sem motivo não vai ao servidor — a cliente ficaria sem explicação', async () => {
    const chamadas = servidor(() => json({}));
    render(<SolicitacoesDeDevolucao orderId="o9" solicitacoes={[ABERTA]} aoConcluir={vi.fn()} aoFalhar={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Recusar a devolução' });
    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: ' ' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Recusar a devolução' }));
    expect(within(dialogo).getByRole('alert').textContent).toBe('Escreva o motivo com pelo menos 5 caracteres.');
    expect(chamadas).toHaveLength(0);
  });

  it('decidida não oferece botão', () => {
    render(
      <SolicitacoesDeDevolucao
        orderId="o9"
        solicitacoes={[{ ...ABERTA, status: 'recusada', statusLabel: 'Recusada pela loja', decisionNote: 'Uso' }]}
        aoConcluir={vi.fn()}
        aoFalhar={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Aprovar devolução' })).toBeNull();
    expect(screen.getByText('Resposta: Uso')).toBeTruthy();
  });
});
