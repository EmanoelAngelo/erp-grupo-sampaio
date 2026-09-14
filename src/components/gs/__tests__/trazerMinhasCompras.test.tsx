/**
 * "Trazer minhas compras pelo CPF" e a volta ao carrinho — GAP-PRD-028/043.
 *
 * A conta prometia "vincular suas compras pelo CPF" e não tinha campo: a rota
 * existia sem chamador. O que se cobra:
 *
 *   - o controle chama `/loja/portal/vincular` com o token do portal e o
 *     documento, diz o que o servidor respondeu e recarrega os pedidos quando
 *     algo novo foi ligado;
 *   - sem e-mail confirmado, o controle fica travado e diz por quê;
 *   - quem veio do carrinho de uma loja que exige conta tem o caminho de volta
 *     — e só para dentro do site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MinhaContaPage from '@/pages/gs/MinhaContaPage';
import { TrazerMinhasCompras } from '../TrazerMinhasCompras';

const PORTAL_KEY = 'gs.portal';

type Chamada = { url: string; method: string; headers: Record<string, string>; body: unknown };

function servidor(rotas: Record<string, () => Response>) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const alvo = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      chamadas.push({ url: alvo, method, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
      for (const [padrao, responder] of Object.entries(rotas)) {
        const [m, caminho] = padrao.split(' ');
        if (m === method && alvo.includes(caminho)) return responder();
      }
      return json({ items: [] });
    }),
  );
  return chamadas;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('o controle de trazer as compras', () => {
  it('manda o documento com o token do portal, diz a resposta e avisa quem recarrega', async () => {
    const chamadas = servidor({
      'POST /loja/portal/vincular': () =>
        json({ linked: 2, novos: 1, message: 'Encontramos 1 cadastro seu com esse documento e o seu e-mail — ele foi ligado à sua conta.' }),
    });
    const onTrouxe = vi.fn();
    render(<TrazerMinhasCompras token="tok" email="ana@exemplo.com" verificado onTrouxe={onTrouxe} />);

    fireEvent.change(screen.getByLabelText('CPF ou CNPJ das compras'), { target: { value: '111.444.777-35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trazer minhas compras' }));

    await screen.findByText(/ele foi ligado à sua conta/);
    const chamada = chamadas.find((c) => c.url.includes('/loja/portal/vincular'))!;
    expect(chamada.headers['x-portal-token']).toBe('tok');
    expect(chamada.body).toEqual({ document: '111.444.777-35' });
    expect(onTrouxe).toHaveBeenCalledTimes(1);
  });

  it('nada novo: diz o que fazer, e não recarrega à toa', async () => {
    servidor({
      'POST /loja/portal/vincular': () =>
        json({ linked: 1, novos: 0, message: 'Nada novo com esse documento e o seu e-mail. Comprou no balcão sem e-mail? Peça o código de acesso na loja.' }),
    });
    const onTrouxe = vi.fn();
    render(<TrazerMinhasCompras token="tok" email="ana@exemplo.com" verificado onTrouxe={onTrouxe} />);

    fireEvent.change(screen.getByLabelText('CPF ou CNPJ das compras'), { target: { value: '52998224725' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trazer minhas compras' }));

    await screen.findByText(/Peça o código de acesso na loja/);
    expect(onTrouxe).not.toHaveBeenCalled();
  });

  it('sem e-mail confirmado: travado, e a tela diz por quê', () => {
    servidor({});
    render(<TrazerMinhasCompras token="tok" email="ana@exemplo.com" verificado={false} onTrouxe={() => {}} />);

    expect(screen.getByText(/Confirme seu e-mail primeiro/)).toBeTruthy();
    expect((screen.getByLabelText('CPF ou CNPJ das compras') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Trazer minhas compras' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('na página da conta', () => {
  function sessao() {
    return {
      token: 'tok-portal',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      account: { id: 'acc-1', email: 'ana@exemplo.com', emailVerifiedAt: '2026-08-01T00:00:00Z' },
    };
  }

  function montar(entrada: string) {
    render(
      <MemoryRouter initialEntries={[entrada]}>
        <Routes>
          <Route path="/minha-conta" element={<MinhaContaPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('o controle está lá, e trazer algo recarrega os pedidos', async () => {
    let lidas = 0;
    servidor({
      'GET /loja/portal/pedidos': () => {
        lidas += 1;
        return json({ items: [] });
      },
      'POST /loja/portal/vincular': () => json({ linked: 1, novos: 1, message: 'Encontramos 1 cadastro seu.' }),
    });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montar('/minha-conta');

    await screen.findByText('Nenhum pedido ainda');
    const antes = lidas;
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ das compras'), { target: { value: '11144477735' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trazer minhas compras' }));
    await screen.findByText('Encontramos 1 cadastro seu.');
    await waitFor(() => expect(lidas).toBeGreaterThan(antes));
  });

  it('quem veio do carrinho tem o caminho de volta, com o carrinho aberto', async () => {
    servidor({ 'GET /loja/portal/pedidos': () => json({ items: [] }) });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montar('/minha-conta?voltar=%2Fgringa');

    const volta = await screen.findByRole('link', { name: /Voltar ao carrinho e finalizar/ });
    expect(volta.getAttribute('href')).toBe('/gringa?carrinho=1');
  });

  it('o caminho de volta nunca leva para fora do site', async () => {
    servidor({ 'GET /loja/portal/pedidos': () => json({ items: [] }) });
    localStorage.setItem(PORTAL_KEY, JSON.stringify(sessao()));
    montar(`/minha-conta?voltar=${encodeURIComponent('//golpe.example.com')}`);

    await screen.findByText('Nenhum pedido ainda');
    expect(screen.queryByRole('link', { name: /Voltar ao carrinho/ })).toBeNull();
  });
});
