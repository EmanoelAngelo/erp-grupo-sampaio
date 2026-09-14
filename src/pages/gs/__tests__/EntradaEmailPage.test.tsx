/**
 * NF-e por e-mail, na tela do gestor (GAP-PRD-035, GAP-PRD-128).
 *
 * O que ela não pode errar:
 *
 * 1. Dizer "Configurada" com a senha recusada pelo provedor. Era a tela da
 *    Preço Justo desde 13/08: selo verde e o erro em letra miúda. A situação
 *    vem em português, com o passo a passo da senha de aplicativo, e "Testar
 *    conexão" confere a senha nova sem ler nota nenhuma.
 *
 * 2. Esconder que ainda há mensagem na caixa. "25 mensagem(ns), 0 nota(s)"
 *    para sempre era o sintoma do canal entupido: a leitura agora diz quantas
 *    RESTAM, e a caixa mostra quantas aguardam.
 *
 * 3. Não deixar escolher o que acontece com a mensagem lida — marcar como
 *    lida (padrão), mover para uma pasta ou não mexer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EntradaEmailPage from '../EntradaEmailPage';

const CAIXA = {
  id: 'cx-1',
  address: 'precojusto@gmail.com',
  host: 'imap.gmail.com',
  port: 993,
  secure: 1,
  username: 'precojusto@gmail.com',
  folder: 'INBOX',
  active: 1,
  last_check_at: '2026-08-13T13:00:00.000Z',
  last_error:
    'Command failed ([AUTHENTICATIONFAILED] Invalid credentials (Failure)). O provedor recusou o usuário ou a senha.',
  after_read: 'lida',
  processed_folder: null,
  imap_pending: 0,
  last_error_kind: 'credencial',
  last_ok_at: null,
};

const RECUSADA = {
  configured: true,
  readiness: 'CREDENTIAL_REJECTED',
  message:
    'O provedor recusou a senha de precojusto@gmail.com na última tentativa — nenhuma nota entra por e-mail até a senha ser trocada. No Gmail: ... Conta Google › Segurança › Senhas de app ...',
  inbox: CAIXA,
};

const ACEITA = {
  configured: true,
  readiness: 'CONFIGURED',
  message: 'Lendo precojusto@gmail.com. Notas recebidas entram em conferência.',
  inbox: { ...CAIXA, last_error: null, last_error_kind: null, last_ok_at: '2026-09-11T15:00:00.000Z' },
};

const AGENDA = {
  autoEnabled: false,
  intervalMinutes: 5,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastResult: null,
  nextRunAt: null,
  lockedUntil: null,
};

interface Pedido {
  metodo: string;
  alvo: string;
  corpo: unknown;
}

function servidor(opcoes: {
  status?: unknown;
  depoisDoTeste?: unknown;
  leitura?: unknown;
  mensagens?: unknown[];
} = {}) {
  const pedidos: Pedido[] = [];
  let status = opcoes.status ?? RECUSADA;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      pedidos.push({ metodo, alvo, corpo: init?.body ? JSON.parse(init.body) : null });
      let corpo: unknown;
      if (alvo.includes('/core/mail/inbox/test')) {
        status = opcoes.depoisDoTeste ?? ACEITA;
        corpo = {
          ok: true,
          mensagens: 40,
          naoLidas: 30,
          tipo: null,
          message:
            'Conexão aceita. A pasta "INBOX" tem 40 mensagem(ns), 30 não lida(s). Nenhuma foi lida agora.',
          status,
        };
      } else if (alvo.includes('/core/mail/inbox')) {
        corpo = status;
      } else if (alvo.includes('/core/mail/messages')) {
        corpo = { items: opcoes.mensagens ?? [] };
      } else if (alvo.includes('/core/mail/schedule')) {
        corpo = AGENDA;
      } else if (alvo.includes('/core/mail/check')) {
        corpo = opcoes.leitura ?? { checked: 0, results: [], restantes: 0, avisos: [] };
      } else {
        corpo = {};
      }
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return pedidos;
}

function montar() {
  render(
    <MemoryRouter>
      <EntradaEmailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a senha recusada tem nome (GAP-PRD-128)', () => {
  it('mostra "senha recusada", o passo a passo, e não "configurada"', async () => {
    servidor();
    montar();
    expect(await screen.findByText('SENHA RECUSADA PELO PROVEDOR')).toBeTruthy();
    expect(screen.queryByText('CONFIGURADA')).toBeNull();
    expect(screen.getByText(/Senhas de app/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/Invalid credentials/)).toBeTruthy();
    // Com a senha recusada, a leitura automática avisa antes de ligar.
    expect(screen.getByText(/cada leitura automática falha/)).toBeTruthy();
  });

  it('"Testar conexão" confere a senha sem ler nota, e a situação volta a Configurada', async () => {
    const pedidos = servidor();
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));

    const resultado = await screen.findByText(/Conexão aceita\. A pasta "INBOX" tem 40 mensagem/);
    expect(resultado.textContent).toMatch(/Nenhuma foi lida agora/);
    expect(await screen.findByText('CONFIGURADA')).toBeTruthy();
    expect(pedidos.some((p) => p.metodo === 'POST' && p.alvo.includes('/core/mail/inbox/test'))).toBe(true);
    // Testar não lê a caixa.
    expect(pedidos.some((p) => p.alvo.includes('/core/mail/check'))).toBe(false);
  });
});

describe('a caixa não entope, e a tela diz quantas faltam (GAP-PRD-035)', () => {
  it('"Ler agora" diz quantas leu e quantas ainda restam na caixa', async () => {
    servidor({
      status: { ...ACEITA, inbox: { ...ACEITA.inbox, imap_pending: 5 } },
      leitura: {
        checked: 25,
        results: [],
        restantes: 5,
        depoisDeLer: 'lida',
        avisos: [],
      },
    });
    montar();
    expect(await screen.findByText('5 mensagem(ns)')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Ler agora' }));

    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toMatch(/25 mensagem\(ns\) lida\(s\) · 0 nota\(s\) em conferência/);
    expect(aviso.textContent).toMatch(/Ainda há 5 mensagem\(ns\) na caixa/);
  });

  it('o aviso do provedor (não deixou marcar como lida) aparece junto', async () => {
    servidor({
      status: ACEITA,
      leitura: {
        checked: 1,
        results: [],
        restantes: 0,
        avisos: ['O provedor não deixou marcar a mensagem como lida (read-only). Nada será lido de novo.'],
      },
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ler agora' }));
    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toMatch(/não deixou marcar a mensagem como lida/);
  });

  it('a mensagem grande demais aparece como "Não lida", com o motivo', async () => {
    servidor({
      status: ACEITA,
      mensagens: [
        {
          id: 'm-1',
          subject: null,
          sender: null,
          received_at: null,
          outcome: 'ilegivel',
          detail: 'Mensagem de 80 MB, acima do limite de 25 MB — não foi baixada.',
          note_id: null,
          access_key: null,
          created_at: '2026-09-11T15:00:00.000Z',
        },
      ],
    });
    montar();
    expect(await screen.findByText('Não lida')).toBeTruthy();
    expect(screen.getByText(/80 MB, acima do limite/)).toBeTruthy();
  });

  it('escolher "mover para uma pasta" pede a pasta e grava a escolha, sem mandar senha em branco', async () => {
    const pedidos = servidor({ status: ACEITA });
    montar();
    // Espera a caixa chegar do servidor: o formulário se preenche com ela.
    await screen.findByText('CONFIGURADA');
    const escolha = screen.getByLabelText('Depois de ler cada mensagem') as HTMLSelectElement;
    expect(escolha.value).toBe('lida');

    fireEvent.change(escolha, { target: { value: 'mover' } });
    fireEvent.change(screen.getByPlaceholderText('Notas processadas'), {
      target: { value: 'Notas processadas' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await vi.waitFor(() =>
      expect(pedidos.some((p) => p.metodo === 'POST' && p.alvo.endsWith('/core/mail/inbox'))).toBe(true),
    );
    const salvar = pedidos.find((p) => p.metodo === 'POST' && p.alvo.endsWith('/core/mail/inbox'));
    expect(salvar?.corpo).toMatchObject({ afterRead: 'mover', processedFolder: 'Notas processadas' });
    expect((salvar?.corpo as { password?: string }).password).toBeUndefined();
    expect(salvar?.corpo).not.toHaveProperty('companyId');
  });
});
