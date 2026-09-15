/**
 * CONFIGURAÇÕES › MAQUININHAS (GAP-PRD-076, sobre o GAP-PRD-014).
 *
 * O módulo de maquininha só existia por `curl`. Os casos olham o FIO — o que
 * sai para o servidor — e o que o gerente lê:
 *
 *  - a prontidão diz o que falta pelo nome;
 *  - cadastrar manda provedor, canal do agente local, nome e caixa; o caminho
 *    "pela nuvem" aparece desabilitado com o motivo (a tela não oferece o que
 *    o servidor recusa);
 *  - a credencial vai para o cofre e o campo é de senha;
 *  - "testar conexão" mostra a resposta do servidor;
 *  - ligar leva o motivo, e a recusa do servidor (sem agente pareado) aparece
 *    como veio;
 *  - o código de pareamento sai para o caixa escolhido, com o comando do agente;
 *  - revogar agente leva o motivo;
 *  - a homologação mostra os itens pela evidência;
 *  - a cobrança não confirmada feita pelo agente oferece "consultar no aparelho".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MaquininhasPage from '../MaquininhasPage';
import { setSession } from '@/lib/api/client';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessao(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'quem', displayName: 'Quem', profileCode },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste de maquininhas',
  );
}

const CAIXAS = [
  { id: 'cx1', code: 'pj-cx1', name: 'Caixa 1', active: true, createdAt: '2026-09-01T12:00:00.000Z', caixaAberto: null, tokensAtivos: 0 },
];

const HOMOLOGACAO = {
  configurationId: 'cfg-1',
  homologated: false,
  missing: ['Débito aprovado no aparelho'],
  items: [
    { key: 'credit', label: 'Crédito aprovado no aparelho', required: true, status: 'ok', evidence: 'pttx-1', at: '2026-09-10T15:00:00.000Z' },
    { key: 'debit', label: 'Débito aprovado no aparelho', required: true, status: 'pending', evidence: null, at: null },
  ],
};

const CFG = {
  id: 'cfg-1',
  provider: 'stone',
  displayName: 'PinPad do Caixa 1',
  terminalIdentifier: 'PP-001',
  active: false,
  simulated: false,
  blockedInThisEnvironment: false,
  hasCredentials: false,
  pdvTerminalId: 'cx1',
  channel: 'local_agent',
  implemented: true,
  channelLabel: 'Stone pelo agente local (PinPad + cliente TEF)',
  channelReason: null,
  readinessStatus: 'awaiting_agent',
  agent: null,
  homologation: HOMOLOGACAO,
  blockingReasons: ['Gere o código de pareamento.'],
};

const AGENTE = {
  agentId: 'ptagent-1',
  pdvTerminalId: 'cx1',
  status: 'paired',
  paired: true,
  online: true,
  version: '1.0.0',
  hostname: 'CAIXA1-PC',
  lastSeenAt: '2026-09-11T12:00:00.000Z',
  pairedAt: '2026-09-11T11:00:00.000Z',
  health: { tefClient: 'ok', pinpad: 'connected', message: null },
  revokedAt: null,
  revocationReason: null,
  pairingExpiresAt: null,
};

const INCERTA = {
  id: 'pttx-9',
  provider: 'stone',
  paymentMethod: 'credit',
  amountInCents: 12_345,
  status: 'timeout_uncertain',
  channel: 'local_agent',
  startedAt: '2026-09-11T11:30:00.000Z',
};

let chamadas: { metodo: string; url: string; corpo: unknown; chave: string | null }[];
let recusaLigar: boolean;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? JSON.parse(init.body) : null;
    chamadas.push({ metodo, url: u, corpo, chave: init?.headers?.['Idempotency-Key'] ?? null });

    if (u.endsWith('/core/pdv/terminal/configurations')) return json({ environmentBlocksTestProvider: null, items: [CFG] });
    if (u.endsWith('/payment-terminals/readiness')) {
      return json({
        overallStatus: 'awaiting_agent',
        readyForHomologation: false,
        productionBlocked: true,
        blockingReasons: ['PinPad do Caixa 1: Gere o código de pareamento e informe-o no agente local do computador do caixa.'],
        providers: [],
      });
    }
    if (u.endsWith('/payment-terminals/local-agents') && metodo === 'GET') return json({ items: [AGENTE] });
    if (u.includes('/core/terminals')) return json({ items: CAIXAS });
    if (u.endsWith('/payment-terminals/transactions') && metodo === 'GET') return json({ items: [INCERTA] });
    if (u.includes('/payment-terminals/agent-commands')) return json({ items: [] });
    if (u.endsWith('/payment-terminals/configurations') && metodo === 'POST') {
      return json({ ...CFG, id: 'cfg-2', displayName: corpo.displayName }, 201);
    }
    if (u.endsWith('/payment-terminals/credentials')) return json({ ...CFG, hasCredentials: true }, 201);
    if (u.includes('/test-connection')) {
      return json({ ok: false, real: false, simulated: false, pending: true, message: 'Agente local não pareado para o caixa desta maquininha — PENDENTE.' });
    }
    if (u.includes('/activate')) {
      if (recusaLigar) {
        return json(
          {
            error: {
              code: 'PAYMENT_TERMINAL_AGENT_NOT_PAIRED',
              message: 'Nenhum agente local pareado para o caixa desta maquininha. Gere o código de pareamento.',
            },
          },
          409,
        );
      }
      return json({ ...CFG, active: true });
    }
    if (u.endsWith('/payment-terminals/local-agent/pairing')) {
      return json({ agentId: 'ptagent-2', pairingCode: 'A1B2C3D4', expiresAt: '2026-09-11T12:10:00.000Z', pdvTerminalId: corpo.pdvTerminalId, pdvTerminalName: 'Caixa 1', ttlSeconds: 600 }, 201);
    }
    if (u.includes('/revoke')) return json({ ...AGENTE, status: 'revoked' });
    if (u.includes('/query')) return json({ id: 'pttx-9', status: 'timeout_uncertain', queuedToAgent: true, commandId: 'ptcmd-1' }, 202);
    return json({ items: [] });
  });
}

function montar() {
  render(
    <MemoryRouter>
      <MaquininhasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chamadas = [];
  recusaLigar = false;
  sessao('gerente_loja');
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GAP-PRD-076 — a maquininha pela tela', () => {
  it('a prontidão diz o que falta pelo nome, e a maquininha aparece com caixa e caminho', async () => {
    montar();
    const faltas = await screen.findByRole('list', { name: 'O que falta' });
    expect(faltas.textContent).toMatch(/código de pareamento/);
    // Aparece na tabela e no bloco de homologação.
    expect((await screen.findAllByText('PinPad do Caixa 1')).length).toBeGreaterThan(0);
    expect(screen.getByText('Stone pelo agente local (PinPad + cliente TEF)')).toBeTruthy();
    expect(screen.getAllByText('Caixa 1').length).toBeGreaterThan(0);
    expect(screen.getByText('sem agente pareado')).toBeTruthy();
  });

  it('cadastrar manda o canal do agente local e o caixa; a nuvem aparece desabilitada com o motivo', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Nova maquininha' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Nova maquininha' });
    const radios = within(dialogo).getAllByRole('radio') as HTMLInputElement[];
    expect(radios[1].disabled).toBe(true);
    expect(dialogo.textContent).toMatch(/não está\s+implementada neste sistema/);
    fireEvent.change(within(dialogo).getByRole('combobox', { name: 'Adquirente' }), { target: { value: 'cielo' } });
    fireEvent.change(within(dialogo).getByRole('textbox', { name: 'Nome da maquininha' }), {
      target: { value: 'PinPad Cielo' },
    });
    // A mesma espera do pareamento: a opção do caixa vem de `/core/terminals`,
    // que o botão "Nova maquininha" não espera.
    const caixaDaMaquininha = within(dialogo).getByRole('combobox', { name: 'Caixa da maquininha' });
    await within(caixaDaMaquininha).findByRole('option', { name: 'Caixa 1' });
    fireEvent.change(caixaDaMaquininha, { target: { value: 'cx1' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/payment-terminals/configurations'))).toBeTruthy(),
    );
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/payment-terminals/configurations'))!;
    expect(post.corpo).toMatchObject({
      provider: 'cielo',
      connectionMode: 'local_agent',
      displayName: 'PinPad Cielo',
      pdvTerminalId: 'cx1',
    });
    expect(post.chave).toBeTruthy();
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('a credencial vai para o cofre, num campo de senha', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Credencial' }));
    const dialogo = await screen.findByRole('dialog', { name: /Credencial/ });
    const campo = within(dialogo).getByLabelText('Chave da adquirente') as HTMLInputElement;
    expect(campo.type).toBe('password');
    fireEvent.change(campo, { target: { value: 'tok-segredo' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Guardar no cofre' }));
    await waitFor(() => expect(chamadas.find((c) => c.url.endsWith('/payment-terminals/credentials'))).toBeTruthy());
    const post = chamadas.find((c) => c.url.endsWith('/payment-terminals/credentials'))!;
    expect(post.corpo).toMatchObject({ configurationId: 'cfg-1', provider: 'stone', accessToken: 'tok-segredo' });
  });

  it('testar conexão mostra a resposta do servidor', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));
    const resposta = await screen.findByRole('status', { name: /Conexão de PinPad do Caixa 1/ });
    expect(resposta.textContent).toMatch(/não pareado/);
  });

  it('ligar leva o motivo, e a recusa do servidor aparece como veio', async () => {
    recusaLigar = true;
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ligar' }));
    const dialogo = await screen.findByRole('dialog', { name: /Ligar/ });
    fireEvent.change(within(dialogo).getByRole('textbox', { name: 'Motivo' }), { target: { value: 'PinPad instalado' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Ligar' }));
    expect(await within(dialogo).findByRole('alert')).toBeTruthy();
    expect(within(dialogo).getByRole('alert').textContent).toMatch(/Nenhum agente local pareado/);
    const pedido = chamadas.find((c) => c.url.includes('/activate'))!;
    expect(pedido.corpo).toEqual({ reason: 'PinPad instalado' });
  });

  it('o código de pareamento sai para o caixa escolhido, com o comando do agente', async () => {
    montar();
    const card = (await screen.findByText('Agente local')).closest('section')!;
    const seletor = within(card).getByRole('combobox', { name: 'Caixa da maquininha' });
    // O cartão "Agente local" sai antes de `/core/terminals` responder, com o
    // seletor sem os caixas: trocar o valor antes de a opção existir deixava o
    // select em "" e o código saía para a operação inteira. A opção do caixa é
    // a resposta — espera por ela.
    await within(seletor).findByRole('option', { name: 'Caixa 1' });
    fireEvent.change(seletor, { target: { value: 'cx1' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Gerar código de pareamento' }));
    const codigo = await screen.findByRole('status', { name: 'Código de pareamento' });
    expect(codigo.textContent).toContain('A1B2C3D4');
    expect(codigo.textContent).toMatch(/parear --servidor .* --codigo A1B2C3D4/);
    const pedido = chamadas.find((c) => c.url.endsWith('/local-agent/pairing'))!;
    expect(pedido.corpo).toEqual({ pdvTerminalId: 'cx1' });
  });

  it('revogar o agente leva o motivo', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar' }));
    const dialogo = await screen.findByRole('dialog', { name: /Revogar agente/ });
    fireEvent.change(within(dialogo).getByRole('textbox', { name: 'Motivo' }), { target: { value: 'computador trocado' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(chamadas.find((c) => c.url.includes('/local-agents/ptagent-1/revoke'))).toBeTruthy());
    expect(chamadas.find((c) => c.url.includes('/revoke'))!.corpo).toEqual({ reason: 'computador trocado' });
  });

  it('a homologação mostra os itens pela evidência', async () => {
    montar();
    const bloco = await screen.findByRole('region', { name: /Homologação de PinPad do Caixa 1/ });
    expect(bloco.textContent).toMatch(/1 de 2/);
    expect(bloco.textContent).toMatch(/Crédito aprovado no aparelho/);
    expect(bloco.textContent).toMatch(/Débito aprovado no aparelho/);
  });

  it('a cobrança não confirmada feita pelo agente oferece "consultar no aparelho"', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Consultar no aparelho' }));
    await waitFor(() => expect(chamadas.find((c) => c.url.includes('/transactions/pttx-9/query'))).toBeTruthy());
    expect(await screen.findByText(/Consulta enviada ao agente do caixa/)).toBeTruthy();
  });

  /*
    GAP-PRD-075: o pedido de estorno era gravado — inclusive o que o agente não
    respondeu — e ninguém o lia; a lista mostrava a cobrança como se nada
    tivesse sido pedido. Agora a linha diz o último pedido, com o motivo e a
    frase do servidor.
  */
  it('a cobrança mostra o último pedido de estorno — inclusive o que o aparelho não respondeu', async () => {
    const base = servidor();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        if (String(url).endsWith('/payment-terminals/transactions') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
          return json({
            items: [
              {
                ...INCERTA,
                id: 'pttx-10',
                status: 'authorized',
                ultimoPedido: {
                  operacao: 'refund',
                  outcome: 'no_answer',
                  reason: 'cliente desistiu da compra',
                  requestedAt: '2026-09-11T12:05:00.000Z',
                  providerMessage: 'O agente não respondeu: confira no extrato da operadora se o pedido foi feito.',
                  amountInCents: 12_345,
                },
              },
            ],
          });
        }
        return base(url, init);
      }),
    );
    montar();
    expect(await screen.findByText(/Estorno pedido em .* sem resposta do aparelho\. Motivo: cliente desistiu da compra/)).toBeTruthy();
    expect(screen.getByText(/confira no extrato da operadora/)).toBeTruthy();
  });
});
