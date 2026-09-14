/**
 * Avaliações na página do produto.
 *
 * As duas coisas que a tela não pode errar:
 *
 * 1. Produto sem avaliação NÃO mostra "0 estrelas". Zero é lido como nota
 *    péssima; "ainda não avaliado" é o que de fato acontece — e a diferença
 *    entre as duas coisas é uma venda.
 *
 * 2. Quem não está logado não recebe um formulário que vai recusar. Formulário
 *    que sempre dá erro ensina o cliente a ignorar a seção inteira.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AvaliacoesProduto } from '../AvaliacoesProduto';

const PORTAL_KEY = 'gs.portal';

function logar() {
  localStorage.setItem(
    PORTAL_KEY,
    JSON.stringify({
      token: 'tok-portal',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: { id: 'acc-1', email: 'ana@exemplo.com' },
    }),
  );
}

function avaliacao(over: Record<string, unknown> = {}) {
  return {
    id: 'av-1',
    rating: 5,
    comment: 'Chegou rápido e é bem feito.',
    displayName: 'Ana S.',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function servidor(rotas: Record<string, () => unknown>) {
  const chamadas: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      chamadas.push({
        url: alvo,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body) : null,
      });
      const metodo = (init?.method ?? "GET").toUpperCase();
      for (const [padrao, responder] of Object.entries(rotas)) {
        // O padrao pode fixar o metodo ("POST /avaliacoes"): sem isso o POST
        // casaria na rota de LEITURA e o teste provaria a coisa errada.
        const [m, caminho] = padrao.includes(" ") ? padrao.split(" ") : [metodo, padrao];
        if (m === metodo && alvo.includes(caminho)) {
          const corpo = responder();
          const status = (corpo as { __status?: number })?.__status ?? 200;
          return new Response(JSON.stringify(corpo), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

const SEM_AVALIACAO = { average: null, count: 0, items: [] };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('resumo', () => {
  it('produto sem avaliação NÃO mostra zero estrelas', async () => {
    servidor({ '/avaliacoes': () => SEM_AVALIACAO });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByText('Este produto ainda não foi avaliado.');
    // "0,0" na vitrine seria lido como nota péssima.
    expect(screen.queryByText('0.0')).toBeNull();
  });

  it('com avaliações, mostra média e total', async () => {
    servidor({
      '/avaliacoes': () => ({ average: 4.5, count: 2, items: [avaliacao()] }),
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByText('4.5');
    expect(screen.getByText(/2 avaliações de quem comprou/)).toBeTruthy();
  });

  it('cada avaliação carrega o selo de compra verificada', async () => {
    servidor({ '/avaliacoes': () => ({ average: 5, count: 1, items: [avaliacao()] }) });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByText('compra verificada');
    expect(screen.getByText('Ana S.')).toBeTruthy();
    expect(screen.getByText('Chegou rápido e é bem feito.')).toBeTruthy();
  });
});

describe('quem pode avaliar', () => {
  it('sem sessão, explica a regra e NÃO oferece formulário', async () => {
    servidor({ '/avaliacoes': () => SEM_AVALIACAO });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByText(/Só quem comprou e já recebeu pode avaliar/);
    expect(screen.queryByRole('button', { name: /avaliação/i })).toBeNull();
  });

  it('logado, o formulário aparece', async () => {
    logar();
    servidor({
      '/minha-avaliacao': () => ({ review: null }),
      '/avaliacoes': () => SEM_AVALIACAO,
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByRole('button', { name: 'Enviar avaliação' });
  });

  it('token que o servidor RECUSA cai na mensagem de entrar, não em silêncio', async () => {
    // Achado no navegador: com sessão vencida no localStorage a seção ficava
    // muda — título "Avaliações" e mais nada. Só o servidor sabe se a sessão
    // ainda vale.
    logar();
    servidor({
      '/minha-avaliacao': () => ({ __status: 401, error: { code: 'PORTAL_SESSION_INVALID' } }),
      '/avaliacoes': () => SEM_AVALIACAO,
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    // Desde a rodada 37 "Entre na sua conta" é um LINK, não um beco: a frase
    // que mandava a pessoa para um lugar agora diz onde fica.
    const entrar = await screen.findByRole('link', { name: /entre na sua conta/i });
    expect(entrar.getAttribute('href')).toBe('/minha-conta');
    expect(screen.queryByRole('button', { name: /avaliação/i })).toBeNull();
    // A sessão morta sai do storage: manter lixo faz a próxima tela repetir o erro.
    expect(localStorage.getItem(PORTAL_KEY)).toBeNull();
  });

  it('falha de rede NÃO derruba a sessão guardada', async () => {
    // Deslogar alguém porque a API piscou é pior que o silêncio momentâneo.
    logar();
    servidor({ '/avaliacoes': () => SEM_AVALIACAO });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByText(/Não foi possível carregar o formulário/);
    expect(localStorage.getItem(PORTAL_KEY)).not.toBeNull();
  });

  it('quem já avaliou vê a nota anterior e o botão vira "atualizar"', async () => {
    logar();
    servidor({
      '/minha-avaliacao': () => ({ review: avaliacao({ rating: 3, comment: 'Razoável' }) }),
      '/avaliacoes': () => ({ average: 3, count: 1, items: [avaliacao({ rating: 3 })] }),
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    await screen.findByRole('button', { name: 'Atualizar avaliação' });
    expect((screen.getByLabelText('Sua nota') as HTMLSelectElement).value).toBe('3');
    // Dizer que substitui evita a pessoa achar que vai somar uma segunda nota.
    expect(screen.getByText(/substitui a avaliação anterior/)).toBeTruthy();
  });
});

describe('enviar', () => {
  it('manda nota e comentário, e recarrega o resumo', async () => {
    logar();
    let enviado = false;
    const chamadas = servidor({
      '/minha-avaliacao': () => ({ review: null }),
      '/avaliacoes': () =>
        enviado ? { average: 4, count: 1, items: [avaliacao({ rating: 4 })] } : SEM_AVALIACAO,
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Sua nota'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Comentário'), { target: { value: 'Muito bom' } });
    enviado = true;
    fireEvent.click(screen.getByRole('button', { name: 'Enviar avaliação' }));

    await screen.findByText('Obrigado pela avaliação.');
    const post = chamadas.find((c) => c.method === 'POST');
    expect((post!.body as Record<string, unknown>).rating).toBe(4);
    expect((post!.body as Record<string, unknown>).comment).toBe('Muito bom');
  });

  it('a recusa do servidor aparece com o motivo', async () => {
    logar();
    servidor({
      '/minha-avaliacao': () => ({ review: null }),
      'GET /avaliacoes': () => SEM_AVALIACAO,
      'POST /avaliacoes': () => ({
        __status: 403,
        error: { code: 'PORTAL_REVIEW_NOT_ALLOWED', message: 'Só quem comprou e já recebeu este produto pode avaliá-lo.' },
      }),
    });
    render(<MemoryRouter><AvaliacoesProduto productId="p-1" /></MemoryRouter>);

    const botao = await screen.findByRole('button', { name: 'Enviar avaliação' });
    // A recusa do servidor precisa virar mensagem na tela, não silêncio.
    fireEvent.click(botao);
    await screen.findByRole('alert');
  });
});
