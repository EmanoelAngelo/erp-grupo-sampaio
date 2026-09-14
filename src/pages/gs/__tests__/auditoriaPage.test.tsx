/**
 * A TELA DE AUDITORIA — o leitor da trilha que tinha 128 escritores e nenhum.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem a tabela nomear GENTE (`user_name` do JOIN), o dono leria uuid ao
 *     perguntar "quem cancelou essa venda?" — o caso do nome falha;
 *   - se o filtro de ação parar de viajar na CONSULTA e virar filtro de
 *     navegador, o caso do `action=` falha: filtrar a página carregada não é
 *     filtrar o histórico;
 *   - o mesmo para a busca (`q=`) e para a página (`offset=`);
 *   - sem o `total` filtrado do servidor, a numeração "1–50 de 120" falha;
 *   - sem a frase própria para o 403, quem não responde pelo grupo leria um
 *     erro genérico numa tela que abriu — e acharia defeito onde há decisão.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import AuditoriaPage from '../AuditoriaPage';

const REGISTROS = [
  {
    id: 'a-1',
    company_id: 'loja',
    user_id: 'u-maria',
    user_name: 'Maria Sampaio',
    action: 'sale.cancel',
    entity_type: 'sale',
    entity_id: 'venda-123',
    detail: JSON.stringify({ motivo: 'cliente desistiu', totalCents: 12000 }),
    created_at: '2026-08-10T14:30:00.000Z',
  },
  {
    id: 'a-2',
    company_id: 'loja',
    user_id: null,
    // Sem usuário não é lacuna: webhook e job agem sozinhos.
    user_name: null,
    action: 'ecommerce.webhook',
    entity_type: 'order',
    entity_id: 'pedido-9',
    detail: null,
    created_at: '2026-08-10T13:00:00.000Z',
  },
];

const ACOES = ['ecommerce.webhook', 'sale.cancel', 'sale.create'];

/** As URLs que a tela pediu, na ordem — é nelas que os filtros têm de estar. */
let consultas: string[] = [];
let respostaDaTrilha: { status: number; body: unknown };

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    if (alvo.includes('/core/audit')) {
      consultas.push(alvo);
      return new Response(JSON.stringify(respostaDaTrilha.body), {
        status: respostaDaTrilha.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function entrarComoGestor() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste da tela de auditoria',
  );
}

beforeEach(() => {
  consultas = [];
  respostaDaTrilha = {
    status: 200,
    body: { items: REGISTROS, total: 2, actions: ACOES },
  };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGestor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrir() {
  render(
    <MemoryRouter>
      <AuditoriaPage />
    </MemoryRouter>,
  );
  await screen.findByText('Maria Sampaio');
}

/** A query string da última consulta que a tela fez à trilha. */
function ultimaConsulta(): URLSearchParams {
  const alvo = consultas[consultas.length - 1];
  return new URLSearchParams(alvo.split('?')[1] ?? '');
}

describe('a trilha vira gente e frase, não uuid e JSON', () => {
  it('a linha diz quem, o quê e o detalhe legível', async () => {
    await abrir();

    // Quem: o NOME do JOIN, não o id — e o uuid não vaza para a célula.
    expect(screen.getByText('Maria Sampaio')).toBeTruthy();
    expect(screen.queryByText('u-maria')).toBeNull();

    // O detalhe gravado como JSON sai como pares legíveis.
    expect(screen.getByText(/motivo: cliente desistiu/)).toBeTruthy();
    expect(screen.getByText(/totalCents: 12000/)).toBeTruthy();
  });

  it('ação sem usuário aparece como "sistema", não como célula vazia', async () => {
    await abrir();
    expect(screen.getByText('sistema')).toBeTruthy();
  });

  it('o seletor de ações vem do servidor, não de lista fixa', async () => {
    await abrir();
    const seletor = screen.getByLabelText('Filtrar por ação') as HTMLSelectElement;
    const opcoes = Array.from(seletor.options).map((o) => o.value);
    expect(opcoes).toEqual(['', ...ACOES]);
  });
});

describe('filtro, busca e página viajam NA CONSULTA', () => {
  it('escolher uma ação refaz a consulta com action= e volta à primeira página', async () => {
    await abrir();
    fireEvent.change(screen.getByLabelText('Filtrar por ação'), {
      target: { value: 'sale.cancel' },
    });

    await waitFor(() => expect(consultas.length).toBe(2));
    const q = ultimaConsulta();
    expect(q.get('action')).toBe('sale.cancel');
    expect(q.get('offset')).toBe('0');
  });

  it('a busca só sai no envio, e sai como q=', async () => {
    await abrir();
    fireEvent.change(screen.getByPlaceholderText('Ação, entidade, id ou detalhe…'), {
      target: { value: 'venda-123' },
    });
    // Digitar não consulta: uma consulta por tecla martelaria a tabela que
    // mais cresce no banco.
    expect(consultas.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(consultas.length).toBe(2));
    expect(ultimaConsulta().get('q')).toBe('venda-123');
  });

  it('a numeração usa o total FILTRADO do servidor, e "Próxima" pede offset=50', async () => {
    respostaDaTrilha = {
      status: 200,
      body: {
        items: Array.from({ length: 50 }, (_, i) => ({
          ...REGISTROS[0],
          id: `a-${i}`,
          entity_id: `venda-${i}`,
        })),
        total: 120,
        actions: ACOES,
      },
    };
    render(
      <MemoryRouter>
        <AuditoriaPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('1–50 de 120 registros')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => expect(consultas.length).toBe(2));
    expect(ultimaConsulta().get('offset')).toBe('50');
    expect(await screen.findByText('51–100 de 120 registros')).toBeTruthy();
  });
});

describe('quem não responde pelo grupo lê a decisão, não um erro genérico', () => {
  it('o 403 vira a frase do alcance', async () => {
    respostaDaTrilha = {
      status: 403,
      body: { error: { code: 'API_PERMISSION_DENIED', message: 'Sem permissão.' } },
    };
    render(
      <MemoryRouter>
        <AuditoriaPage />
      </MemoryRouter>,
    );

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Só quem responde pelo grupo');
    expect(alerta.textContent).toContain('aparece na trilha');
  });
});
