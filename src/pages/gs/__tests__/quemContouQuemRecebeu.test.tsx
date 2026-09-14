/**
 * QUEM CONTOU, QUEM RECEBEU — as colunas gravadas que nenhuma tela nomeava.
 *
 * `counted_by` (contagem de inventário) e `received_by` (nota de entrada) eram
 * escritas a cada gesto e ilegíveis: a resposta para "quem contou o corredor
 * que fechou faltando 40?" e "quem conferiu a nota que dizia 10 e chegou 4?"
 * existia no banco e não existia para ninguém. O servidor passou a devolver o
 * NOME por JOIN (`counted_by_name`, `received_by_name`) — id não responde a
 * quem investiga — e estes casos provam que as telas o mostram.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - tire a coluna "Contado por" e a primeira pergunta da investigação volta
 *     a exigir abrir o banco na mão;
 *   - mostre zero/vazio onde ninguém contou e a ausência vira acusação: item
 *     pendente não tem contador, e isso é informação;
 *   - tire o "por Fulano" da nota recebida e o selo "Recebida" volta a ser
 *     meia informação;
 *   - invente autor para a nota antiga (confirmada antes de a coluna ser
 *     gravada) e a tela mente sobre quem conferiu.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import InventarioPage from '../InventarioPage';
import EntradaNotasPage from '../EntradaNotasPage';

const CONTAGEM = {
  id: 'c-1',
  number: 7,
  status: 'aberta',
  scope_note: 'Corredor 3',
  opened_at: '2026-08-18T09:00:00.000Z',
  applied_at: null,
  apply_reason: null,
  cancel_reason: null,
};

const DETALHE_DA_CONTAGEM = {
  ...CONTAGEM,
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      name: 'Capacete fechado',
      internal_code: 'CAP-01',
      barcode: null,
      expected_quantity: 10,
      counted_quantity: 8,
      counted_by_name: 'Maria Estoquista',
    },
    {
      id: 'i-2',
      product_id: 'p-2',
      name: 'Óleo 20W50',
      internal_code: 'OLE-02',
      barcode: null,
      expected_quantity: 5,
      // Ninguém contou: sem quantidade e sem contador. Nulo não é zero.
      counted_quantity: null,
      counted_by_name: null,
    },
  ],
  resumo: { total: 2, contados: 1, pendentes: 1, divergentes: 1, sobra: 0, falta: 2 },
};

const NOTAS = [
  {
    id: 'n-recebida',
    access_key: '35260800000000000000550010000000011000000010',
    number: '101',
    series: '1',
    supplier_name: 'Fornecedor Bom',
    total_cents: 150000,
    status: 'recebida',
    created_at: '2026-08-10T08:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 1,
    issued_at: '2026-08-09T00:00:00.000Z',
    received_at: '2026-08-10T11:30:00.000Z',
    received_by_name: 'João da Doca',
  },
  {
    id: 'n-antiga',
    access_key: '35260800000000000000550010000000021000000020',
    number: '102',
    series: '1',
    supplier_name: 'Fornecedor Bom',
    total_cents: 90000,
    status: 'recebida',
    created_at: '2026-03-02T08:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 0,
    issued_at: '2026-03-01T00:00:00.000Z',
    // Confirmada antes de a coluna ser gravada: não há autor a afirmar.
    received_at: null,
    received_by_name: null,
  },
];

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/inventory-counts/c-1')) return json(DETALHE_DA_CONTAGEM);
    if (alvo.includes('/core/inventory-counts')) return json({ items: [CONTAGEM] });
    if (alvo.includes('/core/purchases/notes')) return json({ items: NOTAS });
    return json({ items: [] });
  });
}

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode },
      ],
    } as never,
    'LOGIN',
    'teste de quem contou / quem recebeu',
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/**
 * A célula "Contado por" da linha do produto — pela POSIÇÃO da coluna, não
 * pelo texto da linha inteira: um travessão apareceria também na coluna de
 * diferença, e um teste que aceita isso ficaria verde com a coluna ausente.
 */
function celulaContadoPor(produto: string): string {
  const linha = screen.getByText(produto).closest('tr')!;
  const cabecalhos = Array.from(linha.closest('table')!.querySelectorAll('thead th')).map(
    (th) => th.textContent,
  );
  const indice = cabecalhos.indexOf('Contado por');
  expect(indice).toBeGreaterThan(-1);
  return linha.querySelectorAll('td')[indice].textContent ?? '';
}

describe('a contagem de inventário diz QUEM contou', () => {
  it('item contado mostra o nome; item pendente mostra travessão', async () => {
    entrar('gerente_loja');
    render(
      <MemoryRouter>
        <InventarioPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Abrir' }));
    await screen.findByText('Capacete fechado');

    expect(celulaContadoPor('Capacete fechado')).toBe('Maria Estoquista');
    expect(celulaContadoPor('Óleo 20W50')).toBe('—');
  });
});

describe('a entrada de notas diz QUEM recebeu', () => {
  it('a nota recebida traz o nome e a data; a antiga traz só o selo', async () => {
    // Atendente de propósito: alcança a tela pelo roteador e não marca peça,
    // então a página não dispara as consultas de bancada — o caso mede só a
    // lista de notas.
    entrar('atendente');
    render(
      <MemoryRouter>
        <EntradaNotasPage />
      </MemoryRouter>,
    );

    await screen.findByText('101/1');

    const recebida = screen.getByText('101/1').closest('tr')!;
    expect(recebida.textContent).toContain('Recebida');
    expect(recebida.textContent).toContain('por João da Doca');
    expect(recebida.textContent).toContain('10/08/2026');

    // A nota confirmada antes de a coluna existir não ganha autor inventado.
    const antiga = screen.getByText('102/1').closest('tr')!;
    expect(antiga.textContent).toContain('Recebida');
    expect(antiga.textContent).not.toContain('por ');
  });
});
