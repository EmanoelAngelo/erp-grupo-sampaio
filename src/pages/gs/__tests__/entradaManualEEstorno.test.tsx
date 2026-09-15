/**
 * ============================================================================
 * ENTRADA MANUAL E ESTORNO NA TELA — as duas portas novas do GAP-V17/V20
 * ============================================================================
 *
 * A tela de Entrada de notas ganhou dois gestos, e cada um tem uma promessa
 * de honestidade que estes casos cobram:
 *
 *  1. ENTRADA MANUAL (sem nota fiscal): o formulário diz com todas as letras
 *     que não há NF-e envolvida, os itens vêm da busca no catálogo, e o POST
 *     bate em /core/purchases/manual com productId, quantidade e custo em
 *     CENTAVOS INTEIROS. A linha criada aparece na lista como "Entrada
 *     manual" — nunca com cara de chave de acesso que não existe.
 *
 *  2. ESTORNO da entrada confirmada: o botão só existe para nota 'recebida'
 *     e para GERÊNCIA (o servidor recusa estoquista — a tela não promete o
 *     que o servidor nega), exige motivo, e bate em
 *     /core/purchases/notes/:id/estornar. A nota estornada aparece com o selo
 *     próprio — não como "Recebida" nem como "Conferência", que seriam duas
 *     mentiras diferentes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

const FORNECEDOR = {
  id: 'f-ze',
  name: 'Seu Zé das Embalagens',
  trade_name: null,
  document: null,
  delivery_days: 0,
  payment_term_days: 0,
  active: 1,
};

const SACOLA = {
  id: 'p-sacola',
  internal_code: 'SAC-01',
  sku: null,
  barcode: null,
  name: 'Sacola kraft 30x40',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 45,
  price_cents: 90,
  min_stock: 0,
  active: 1,
};

function nota(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    access_key: '35240114200166000187550010000000011000000017',
    number: '11',
    series: '1',
    supplier_name: 'Distribuidora Alfa',
    total_cents: 125000,
    status: 'recebida',
    created_at: '2026-04-12T10:00:00.000Z',
    issued_at: '2026-04-10T09:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 1,
    doc_type: 'nfe',
    ...sobrescreve,
  };
}

interface Chamada {
  method?: string;
  body?: string;
}

let fetchMock: ReturnType<typeof vi.fn>;
let notas: ReturnType<typeof nota>[];
/** Quantos POSTs da entrada manual o servidor recusa por chave reusada (422). */
let recusasDaEntradaManual = 0;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: Chamada) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (init?.method === 'POST') {
      if (alvo.includes('/core/purchases/manual')) {
        if (recusasDaEntradaManual > 0) {
          recusasDaEntradaManual -= 1;
          return json(
            {
              error: {
                code: 'CORE_IDEMPOTENCY_KEY_REUSED',
                message:
                  'Esta chave de idempotência já registrou outra entrada manual, com outro conteúdo — nada foi '
                  + 'registrado agora. Um pedido novo precisa de chave nova.',
                details: { noteId: 'n-velha' },
              },
            },
            422,
          );
        }
        return json(
          { noteId: 'n-manual', duplicated: false, status: 'conferencia', totalCents: 9000, items: [] },
          201,
        );
      }
      if (alvo.includes('/estornar')) {
        return json({
          noteId: 'n-1',
          status: 'estornada',
          reversedMovements: 1,
          financeCancelled: true,
          alreadyReversed: false,
        });
      }
      return json({});
    }
    if (alvo.includes('/core/products/search')) return json({ items: [SACOLA] });
    if (alvo.includes('/core/purchases/notes/n-manual/items')) return json({ items: [] });
    if (alvo.includes('/core/purchases/notes')) return json({ items: notas });
    if (alvo.includes('/core/suppliers')) return json({ items: [FORNECEDOR] });
    return json({ items: [] });
  });
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-do-estoque',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da entrada manual e do estorno',
  );
}

async function montar(profileCode = 'gerente_loja') {
  entrar(profileCode);
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  /*
    "Notas importadas" é o título do cartão, desenhado antes de a lista chegar
    — e o botão Estornar, os selos e a linha da entrada manual só existem com
    ela. Os casos liam tudo isso logo depois, síncronos: o positivo falhava
    com a lista atrasada, e as negativas ("estoquista não vê o botão", "nota
    em conferência sem botão") ficavam verdes com a lista ainda VAZIA. A
    célula "número/série" da primeira nota prova que `/core/purchases/notes`
    respondeu; a lista entra num `setNotes` só.
  */
  await screen.findByText(/Notas importadas/);
  const primeira = notas[0];
  await screen.findByText(`${primeira.number}/${primeira.series ?? '—'}`);
}

function escritas(): [string, Record<string, unknown>][] {
  return (fetchMock.mock.calls as [unknown, Chamada?][])
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [
      String(url),
      JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    ]);
}

beforeEach(() => {
  localStorage.clear();
  notas = [nota()];
  recusasDaEntradaManual = 0;
  fetchMock = servidor();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ============================================================ ENTRADA MANUAL

describe('entrada manual — a compra sem nota fiscal', () => {
  it('o formulário declara "sem nota fiscal", busca o produto no catálogo e POSTa centavos inteiros', async () => {
    await montar();

    fireEvent.click(screen.getByRole('button', { name: /Entrada manual/ }));
    // A honestidade na cara: quem digita sabe que não está importando NF-e.
    expect(screen.getAllByText(/sem nota fiscal/i).length).toBeGreaterThan(0);

    // A lista de fornecedores chega por rede: escolher antes de a opção
    // existir deixaria o select vazio em silêncio.
    await screen.findByText(/Seu Zé das Embalagens/);
    const fornecedor = screen.getByLabelText(/Fornecedor da entrada manual/) as HTMLSelectElement;
    fireEvent.change(fornecedor, { target: { value: 'f-ze' } });

    const busca = screen.getByLabelText(/Produto do catálogo do item 1 da entrada manual/);
    fireEvent.change(busca, { target: { value: 'sacola' } });
    fireEvent.click(await screen.findByRole('button', { name: /Sacola kraft 30x40 · SAC-01/ }));

    const qtd = screen.getByLabelText(/Quantidade do item 1 da entrada manual/);
    fireEvent.change(qtd, { target: { value: '200' } });
    // O custo veio do cadastro (R$ 0,45) e pode ser sobrescrito.
    const custo = screen.getByLabelText(/Custo unitário do item 1 da entrada manual/) as HTMLInputElement;
    expect(custo.value).toBe('0,45');

    fireEvent.click(screen.getByRole('button', { name: /Lançar entrada manual/ }));

    await waitFor(() => {
      const chamada = escritas().find(([url]) => url.includes('/core/purchases/manual'));
      expect(chamada, 'nenhum POST em /core/purchases/manual').toBeTruthy();
      const corpo = chamada![1];
      expect(corpo.supplierId).toBe('f-ze');
      // A idempotência nasce no formulário: reenviar é a MESMA intenção.
      expect(String(corpo.idempotencyKey ?? '')).not.toBe('');
      const items = corpo.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].productId).toBe('p-sacola');
      expect(items[0].quantity).toBe(200);
      expect(items[0].unitCostCents).toBe(45); // centavos INTEIROS, nunca 0.45
    });
  });

  it('a linha manual da lista se apresenta como entrada manual — sem fingir chave de NF-e', async () => {
    notas = [
      nota({
        id: 'n-m',
        access_key: 'manual:abc',
        number: 'EM-3',
        series: null,
        supplier_name: 'Seu Zé das Embalagens',
        status: 'conferencia',
        tem_xml: 0,
        doc_type: 'manual',
        total_cents: 9000,
      }),
    ];
    await montar();

    expect(screen.getAllByText(/Entrada manual/).length).toBeGreaterThan(0);
    // O rabo da chave sintética ("manual:abc") nunca aparece como chave.
    expect(screen.queryByText(/…manual:abc/)).toBeNull();
  });
});

/**
 * A TENTATIVA QUE JÁ REGISTROU OUTRA ENTRADA (R2-IDEM, item 6).
 *
 * A chave da entrada manual só troca no sucesso. Resposta perdida (o servidor
 * gravou) e a pessoa mudou um item antes de clicar de novo: o servidor recusa a
 * MESMA chave com outra compra (422 CORE_IDEMPOTENCY_KEY_REUSED), e a tela
 * ficava presa na mesma chave e na mesma recusa, com o texto do servidor.
 */
describe('entrada manual — a tentativa que já registrou outra entrada (422)', () => {
  async function lancarERecusar() {
    await montar();
    recusasDaEntradaManual = 1;
    fireEvent.click(screen.getByRole('button', { name: /Entrada manual/ }));
    await screen.findByText(/Seu Zé das Embalagens/);
    fireEvent.change(screen.getByLabelText(/Fornecedor da entrada manual/), { target: { value: 'f-ze' } });
    fireEvent.change(screen.getByLabelText(/Produto do catálogo do item 1 da entrada manual/), {
      target: { value: 'sacola' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Sacola kraft 30x40 · SAC-01/ }));
    fireEvent.change(screen.getByLabelText(/Quantidade do item 1 da entrada manual/), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /Lançar entrada manual/ }));
    return screen.findByRole('dialog', { name: /já registrou uma entrada/i });
  }

  function chavesDaEntradaManual(): string[] {
    return escritas()
      .filter(([url]) => url.includes('/core/purchases/manual'))
      .map(([, corpo]) => String(corpo.idempotencyKey ?? ''));
  }

  it('diz o que houve sem falar em chave de idempotência — e nada é reenviado sem a escolha', async () => {
    const dialogo = await lancarERecusar();
    expect(dialogo.textContent).toMatch(/nada foi lançado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(chavesDaEntradaManual()).toHaveLength(1);
  });

  it('"Registrar como entrada nova" reenvia os mesmos itens com OUTRA chave', async () => {
    const dialogo = await lancarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar como entrada nova/i }));

    await waitFor(() => expect(chavesDaEntradaManual()).toHaveLength(2));
    const [primeira, segunda] = chavesDaEntradaManual();
    expect(segunda).not.toBe('');
    expect(segunda).not.toBe(primeira);
    const ultimo = escritas().filter(([url]) => url.includes('/core/purchases/manual')).at(-1)![1];
    expect((ultimo.items as Record<string, unknown>[])[0]).toMatchObject({ productId: 'p-sacola', quantity: 200 });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou uma entrada/i })).toBeNull());
  });

  it('"Voltar ao formulário" não reenvia nada', async () => {
    const dialogo = await lancarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao formulário/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou uma entrada/i })).toBeNull());
    expect(chavesDaEntradaManual()).toHaveLength(1);
  });
});

// ================================================================== ESTORNO

describe('estorno da entrada confirmada', () => {
  it('nota recebida ganha o botão para a gerência; o clique pede motivo e bate na rota do estorno', async () => {
    await montar('gerente_loja');

    fireEvent.click(screen.getByRole('button', { name: /Estornar/ }));
    // O motivo é pedido NA TELA (GAP-PRD-158), não pelo window.prompt.
    const dialogo = await screen.findByRole('dialog', { name: 'Estornar esta entrada confirmada?' });
    fireEvent.change(within(dialogo).getByRole('textbox', { name: /Motivo do estorno/ }), {
      target: { value: 'Nota da outra empresa do grupo' },
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Estornar a entrada' }));

    await waitFor(() => {
      const chamada = escritas().find(([url]) => url.includes('/core/purchases/notes/n-1/estornar'));
      expect(chamada, 'nenhum POST em /purchases/notes/n-1/estornar').toBeTruthy();
      expect(chamada![1].reason).toBe('Nota da outra empresa do grupo');
    });
  });

  it('sem motivo no prompt, NADA viaja — o servidor exigiria e a tela não manda lixo', async () => {
    await montar('gerente_loja');

    fireEvent.click(screen.getByRole('button', { name: /Estornar/ }));
    const dialogo = await screen.findByRole('dialog', { name: 'Estornar esta entrada confirmada?' });
    // Motivo curto demais: a tela recusa ali mesmo, e nada viaja.
    fireEvent.change(within(dialogo).getByRole('textbox', { name: /Motivo do estorno/ }), { target: { value: 'ab' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Estornar a entrada' }));
    expect(within(dialogo).getByRole('alert').textContent).toContain('pelo menos 3');
    // E desistir fecha a pergunta sem mandar nada.
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(escritas().some(([url]) => url.includes('/estornar'))).toBe(false);
  });

  it('estoquista NÃO vê o botão — a tela não promete o que o servidor nega', async () => {
    await montar('estoquista');
    expect(screen.queryByRole('button', { name: /Estornar/ })).toBeNull();
  });

  it('nota em conferência não tem o que estornar: sem botão', async () => {
    notas = [nota({ status: 'conferencia' })];
    await montar('gerente_loja');
    expect(screen.queryByRole('button', { name: /Estornar/ })).toBeNull();
  });

  it('a nota estornada carrega o selo próprio — nem "Recebida", nem "Conferência" — e diz quem e por quê', async () => {
    notas = [
      nota({
        status: 'estornada',
        reversed_at: '2026-08-25T10:00:00.000Z',
        reversed_by_name: 'Gerente Sampaio',
        reversal_reason: 'Nota da outra empresa do grupo',
      }),
    ];
    await montar('gerente_loja');

    expect(screen.getByText('Estornada')).toBeTruthy();
    expect(screen.queryByText('Recebida')).toBeNull();
    expect(screen.queryByText('Conferência')).toBeNull();
    // O motivo e o autor gravados no estorno têm LEITOR — a regra da casa:
    // coluna sem leitor é ficção com custo de manutenção.
    expect(screen.getByText(/por Gerente Sampaio/)).toBeTruthy();
    expect(screen.getByText('Nota da outra empresa do grupo')).toBeTruthy();
    // Documento morto não ganha botão de estornar de novo.
    expect(screen.queryByRole('button', { name: /Estornar/ })).toBeNull();
  });
});
