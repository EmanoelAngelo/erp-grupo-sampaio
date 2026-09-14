/**
 * SEM FOTO É AVISO, NÃO BLOQUEIO — a tela da prontidão (GAP-PRD-207).
 *
 * O servidor passou a mandar a foto em `warnings`. A tela conta o produto
 * publicado sem foto como VENDENDO (é o que ele está fazendo na vitrine),
 * mostra o aviso ao lado dos impedimentos, e a publicação em massa só leva os
 * sem foto quando o gestor aperta o botão que diz isso — o corpo do POST
 * carrega a escolha.
 *
 * Como fica vermelho: volte a tratar `sem_foto` como impedimento e o caso do
 * "Vendendo" cai; publique os sem foto no botão principal e o caso do corpo
 * do POST cai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ProntidaoOnlinePage from '../ProntidaoOnlinePage';

const LINHAS = [
  {
    id: 'p-vende-sem-foto',
    name: 'Tênis publicado sem foto',
    internalCode: 'TN-1',
    priceCents: 15000,
    publishOnline: true,
    blockers: [],
    warnings: ['sem_foto'],
    ready: true,
    readyToPublish: false,
  },
  {
    id: 'p-completo',
    name: 'Jaqueta completa',
    internalCode: 'JQ-1',
    priceCents: 30000,
    publishOnline: false,
    blockers: ['nao_publicado'],
    warnings: [],
    ready: false,
    readyToPublish: true,
  },
  {
    id: 'p-pronto-sem-foto',
    name: 'Boné pronto sem foto',
    internalCode: 'BN-1',
    priceCents: 5000,
    publishOnline: false,
    blockers: ['nao_publicado'],
    warnings: ['sem_foto'],
    ready: false,
    readyToPublish: true,
  },
];

let posts: Record<string, unknown>[];

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (metodo === 'POST' && alvo.includes('/publicar-prontos')) {
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      posts.push(corpo);
      return json(
        corpo.incluirSemFoto
          ? { published: ['p-completo', 'p-pronto-sem-foto'], skipped: 0, semFoto: 0 }
          : { published: ['p-completo'], skipped: 1, semFoto: 1 },
      );
    }
    if (alvo.includes('/prontidao-online')) return json({ items: LINHAS });
    return json({ items: [] });
  });
}

beforeEach(() => {
  posts = [];
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do GAP-PRD-207',
  );
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function montar() {
  render(
    <MemoryRouter>
      <ProntidaoOnlinePage />
    </MemoryRouter>,
  );
}

describe('a foto é aviso', () => {
  it('produto publicado sem foto conta como VENDENDO, com o aviso ao lado', async () => {
    montar();
    const linha = (await screen.findByText('Tênis publicado sem foto')).closest('tr')!;
    expect(within(linha).getByText('Vendendo')).toBeTruthy();
    expect(within(linha).getByText('Sem foto (aviso)')).toBeTruthy();
    expect(screen.getByTestId('prontidao-na-loja').textContent).toBe('1');
  });

  it('o botão principal publica só os completos; o outro diz que leva os sem foto', async () => {
    montar();
    const principal = await screen.findByRole('button', { name: 'Publicar 1 pronto(s)' });
    expect(screen.getByRole('button', { name: 'Publicar também 1 sem foto' })).toBeTruthy();
    expect(screen.getByText(/só não têm foto/)).toBeTruthy();

    fireEvent.click(principal);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ incluirSemFoto: false });
    await screen.findByText(/1 sem foto esperam a sua decisão/);
  });

  it('o botão dos sem foto manda a escolha explícita ao servidor', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Publicar também 1 sem foto' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ incluirSemFoto: true });
  });
});
