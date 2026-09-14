/**
 * ============================================================================
 * O RASTRO DO ITEM CANCELADO GANHA LEITOR HUMANO — GAP-V52/V63
 * ============================================================================
 *
 * `core_sale_removed_items` existe desde a onda 1, `GET /core/sales/:id`
 * devolve o bloco `removedItems` — e NENHUMA tela o exibia. O rastro que existe
 * para prevenção de perda era legível só por quem abrisse o banco: o gestor que
 * desconfia de "fechou por menos do que mostrou" não tinha para onde olhar.
 *
 * Pior: a tela de Vendas não tinha ficha nenhuma. A lista mostrava número,
 * data, situação e total, e a venda não abria. Não havia onde pendurar o bloco.
 *
 * ## O que esta rodada acrescenta, e por que ela mora em VENDAS
 *
 * A venda também "abre" em Devoluções — mas ali a lista ESCONDE a cancelada
 * (`status === 'cancelled'` é filtrado), e é justamente na venda cancelada que
 * a pergunta "o que saiu do carrinho antes de fechar?" mais importa. A ficha
 * fica em Vendas, que mostra todas.
 *
 * Essa decisão foi re-medida depois e PREGADA em
 * `rastroDoCarrinhoTemUmaCasaSo.test.tsx`: lá o caso proíbe uma segunda cópia
 * do bloco em Devoluções e exige, em troca, que a venda cancelada saia daquela
 * tela com uma placa apontando para a ficha daqui — o beco era o defeito, a
 * duplicação seria o conserto errado.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - tire o botão que abre a ficha e o rastro volta a não ter leitor;
 *   - leia `removedItems` da linha da LISTA em vez do GET da ficha e o bloco
 *     nasce vazio: a lista nunca trouxe esse campo;
 *   - troque o "quem tirou" pelo id cru e o gestor lê um UUID onde precisa de
 *     um nome — a pergunta é sobre gente;
 *   - esconda o bloco quando não há remoção e "nenhuma" fica indistinguível de
 *     "a tela não sabe", que é o mesmo erro do rodapé com o zero literal.
 *
 * ## A COSTURA FECHADA DEPOIS (o nome vem do servidor)
 *
 * O nome de quem tirou saía de `GET /core/sellers`, que é rota de BALCÃO e não
 * alcança todo perfil que chega a Vendas: o estoquista tomava 403 e lia UUID.
 * Agora `GET /core/sales/:id` devolve `removed_by_name` junto do rastro, e a
 * chamada extra saiu. O servidor abaixo responde 403 em `/core/sellers` de
 * propósito — se a ficha voltar a depender dela, o nome some da tela.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import { VendasPage } from '../OperacaoPages';

const VENDA_COM_RASTRO = {
  id: 'v-101',
  number: 101,
  total_cents: 5_000,
  change_cents: 0,
  status: 'completed',
  created_at: '2026-08-28T17:40:00.000Z',
  customer_id: null,
};

const VENDA_LIMPA = {
  ...VENDA_COM_RASTRO,
  id: 'v-102',
  number: 102,
  total_cents: 9_900,
};

/** A venda cujo autor da remoção não tem mais conta: nome nulo, id de pé. */
const VENDA_SEM_NOME = {
  ...VENDA_COM_RASTRO,
  id: 'v-103',
  number: 103,
};

const DETALHES: Record<string, Record<string, unknown>> = {
  'v-101': {
    ...VENDA_COM_RASTRO,
    items: [
      {
        id: 'si-1',
        product_id: 'p-camiseta',
        description: 'Camiseta',
        quantity: 1,
        unit_price_cents: 5_000,
        total_cents: 5_000,
      },
    ],
    payments: [{ id: 'sp-1', method: 'dinheiro', amount_cents: 5_000, status: 'settled' }],
    financeEntries: [],
    customerCreditCents: 0,
    removedItems: [
      {
        id: 'rm-1',
        sale_id: 'v-101',
        product_id: 'p-bermuda',
        name: 'Bermuda jeans',
        quantity: 2,
        unit_price_cents: 4_990,
        removed_by: 'u-caixa',
        // O NOME vem na própria ficha, resolvido pelo servidor — é a costura
        // que tirou `GET /core/sellers` do caminho.
        removed_by_name: 'Joana do Caixa',
        removed_at: '2026-08-28T17:38:00.000Z',
        reason: null,
      },
    ],
  },
  'v-102': {
    ...VENDA_LIMPA,
    items: [
      {
        id: 'si-2',
        product_id: 'p-camiseta',
        description: 'Camiseta',
        quantity: 2,
        unit_price_cents: 4_950,
        total_cents: 9_900,
      },
    ],
    payments: [{ id: 'sp-2', method: 'pix', amount_cents: 9_900, status: 'settled' }],
    financeEntries: [],
    customerCreditCents: 0,
    removedItems: [],
  },
  'v-103': {
    ...VENDA_SEM_NOME,
    items: [
      {
        id: 'si-3',
        product_id: 'p-camiseta',
        description: 'Camiseta',
        quantity: 1,
        unit_price_cents: 5_000,
        total_cents: 5_000,
      },
    ],
    payments: [{ id: 'sp-3', method: 'dinheiro', amount_cents: 5_000, status: 'settled' }],
    financeEntries: [],
    customerCreditCents: 0,
    removedItems: [
      {
        id: 'rm-3',
        sale_id: 'v-103',
        product_id: 'p-bermuda',
        name: 'Bermuda jeans',
        quantity: 2,
        unit_price_cents: 4_990,
        removed_by: 'u-demitido',
        // Conta apagada (ou id de fora da operação): o servidor devolve o
        // rastro com o nome NULO em vez de derrubar a linha.
        removed_by_name: null,
        removed_at: '2026-08-28T17:38:00.000Z',
        reason: null,
      },
    ],
  },
};

/** Toda URL pedida — prova que a ficha vem do GET, e não da linha da lista. */
let pedidos: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    pedidos.push(alvo);

    const detalhe = alvo.match(/\/core\/sales\/([^/?]+)$/);
    if (detalhe) {
      const ficha = DETALHES[detalhe[1]];
      return ficha
        ? json(ficha)
        : json({ error: { code: 'CORE_SALE_NOT_FOUND', message: 'Venda não encontrada.' } }, 404);
    }
    if (alvo.includes('/core/sellers')) {
      // A rota de balcão recusa este perfil — como recusa o estoquista na
      // produção. A ficha não pode precisar dela para dizer quem tirou.
      return json({ error: { code: 'API_PERMISSION_DENIED', message: 'Sem permissão.' } }, 403);
    }
    if (alvo.includes('/core/sales')) {
      return json({ items: [VENDA_COM_RASTRO, VENDA_LIMPA, VENDA_SEM_NOME], total: 3 });
    }
    return json({});
  });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da ficha da venda',
  );
}

function montar() {
  render(
    <MemoryRouter>
      <VendasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  pedidos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirFicha(numero: number) {
  fireEvent.click(await screen.findByRole('button', { name: `Abrir a venda #${numero}` }));
  return screen.findByRole('dialog', { name: `Venda #${numero}` });
}

describe('a ficha da venda mostra o que saiu do carrinho', () => {
  it('produto, quantidade, valor, quem tirou e quando', async () => {
    montar();
    const ficha = await abrirFicha(101);

    // O bloco vem do GET da ficha — a lista nunca trouxe `removedItems`.
    expect(pedidos.some((u) => u.endsWith('/core/sales/v-101'))).toBe(true);

    const bloco = within(ficha).getByTestId('venda-itens-cancelados');
    expect(bloco.textContent).toContain('Bermuda jeans');
    // A QUANTIDADE removida, não o número de cliques: duas unidades saíram.
    expect(bloco.textContent).toContain('2');
    // O VALOR do que saiu — é o número que dimensiona a suspeita. Duas peças de
    // R$ 49,90 é o que a venda deixou de cobrar.
    expect(bloco.textContent).toContain(formatCents(4_990));
    expect(bloco.textContent).toContain(formatCents(9_980));
    // QUEM tirou, por nome. Um UUID aqui não responde a pergunta, que é sobre
    // gente.
    expect(bloco.textContent).toContain('Joana do Caixa');
    // E o nome veio da PRÓPRIA ficha: nenhuma segunda consulta à equipe. A
    // rota de balcão recusa metade dos perfis que chegam a esta tela, e
    // depender dela era o que fazia o gestor ler UUID.
    expect(pedidos.some((u) => u.includes('/core/sellers'))).toBe(false);
    // E QUANDO — com hora, porque a distância entre a remoção e o Finalizar é
    // parte do que se lê.
    expect(bloco.textContent).toMatch(/28\/08\/2026/);
    expect(bloco.textContent).toMatch(/14:38|17:38|20:38/);
  });

  it('venda sem remoção diz que não houve — e não some da tela', async () => {
    montar();
    const ficha = await abrirFicha(102);

    // "Nenhuma" precisa ser distinguível de "a tela não sabe": esconder o
    // bloco repetiria o pecado do rodapé com o zero literal.
    const bloco = within(ficha).getByTestId('venda-itens-cancelados');
    expect(bloco.textContent).toMatch(/nenhum item/i);
  });

  it('autor sem nome (conta apagada) não some da tela — o id é o que há', async () => {
    montar();
    const ficha = await abrirFicha(103);

    const bloco = within(ficha).getByTestId('venda-itens-cancelados');
    expect(bloco.textContent).toContain('Bermuda jeans');
    // Sem o nome, o identificador é o que há — e é melhor que uma linha em
    // branco, que faria parecer que ninguém removeu nada. O rastro vale mais
    // que o nome.
    expect(bloco.textContent).toContain('u-demitido');
  });

  it('a ficha fecha e reabre na venda certa', async () => {
    montar();
    await abrirFicha(101);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a ficha da venda' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const outra = await abrirFicha(102);
    expect(within(outra).queryByText('Bermuda jeans')).toBeNull();
  });
});
