/**
 * MOVIMENTAÇÃO MANUAL NA LOJA — a tela que a promessa do cadastro apontava.
 *
 * ============================================================================
 * O DEFEITO (GAP-V09)
 * ============================================================================
 *
 * `POST /core/stock/movements` estava pronta, testada e auditada — motivo
 * obrigatório na saída, rótulo fechado, idempotência — e NENHUMA tela da loja
 * a chamava: `coreApi.addStockMovement` não tinha um único chamador. Pior: o
 * formulário de produto mandava o usuário "lançar um movimento em Estoque ›
 * Movimentações", e a tela de Movimentações era só leitura. Perda, uso interno
 * e carga avulsa eram impossíveis pela UI da loja.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - tire o formulário e a promessa do cadastro volta a apontar para o nada;
 *   - deixe o atendente ver o formulário e a tela oferece uma porta que o
 *     servidor bate na cara (o guarda nomeia gerentes, estoquista e caixas);
 *   - deixe a saída passar sem motivo e o cliente descobre a recusa do
 *     servidor DEPOIS de preencher tudo — a regra é espelhada na tela;
 *   - troque o referenceId a cada clique e a retentativa após falha de rede
 *     vira movimento DUPLICADO: a referência estável é a idempotência.
 *
 * ============================================================================
 * E O CUSTO NO HISTÓRICO (GAP-V14)
 * ============================================================================
 *
 * O custo unitário das entradas aparecia num parágrafo de rodapé com as TRÊS
 * primeiras linhas que tinham custo — quem investigava uma entrada específica
 * no meio do histórico não achava o número na linha dela. Vira coluna; o
 * travessão continua para o que o servidor podou (mecânico não vê custo).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import MovimentacoesEstoquePage from '../MovimentacoesEstoquePage';

const MOVIMENTOS = [
  {
    id: 'm-1',
    product_id: 'p-1',
    product_name: 'Parafuso M6',
    internal_code: 'PAR-01',
    movement_type: 'in',
    kind: 'XML_RECEIPT',
    kind_label: 'Entrada por XML',
    quantity: 10,
    quantity_before: 0,
    reserved_delta: 0,
    reserved_after: 0,
    reference_type: 'nfe_entrada',
    reference_id: 'n1',
    document_number: 'NF 123',
    balance_after: 10,
    unit_cost_cents: 123456,
    user_name: 'João',
    reason: null,
    note: null,
    created_at: '2026-08-20T12:00:00.000Z',
  },
  {
    id: 'm-2',
    product_id: 'p-1',
    product_name: 'Parafuso M6',
    internal_code: 'PAR-01',
    movement_type: 'out',
    kind: 'SALE',
    kind_label: 'Venda',
    quantity: -2,
    quantity_before: 10,
    reserved_delta: 0,
    reserved_after: 0,
    reference_type: 'sale',
    reference_id: 'v1',
    document_number: 'Venda #7',
    balance_after: 8,
    // O servidor PODOU o custo (ou o movimento não tem): a linha mostra
    // travessão, nunca zero.
    unit_cost_cents: null,
    user_name: 'Maria',
    reason: null,
    note: null,
    created_at: '2026-08-21T09:00:00.000Z',
  },
];

const LOCAIS = [
  {
    id: 'loc-geral',
    company_id: 'loja',
    code: 'GERAL',
    name: 'Estoque geral',
    note: null,
    is_default: 1,
    active: 1,
  },
  {
    id: 'loc-vit',
    company_id: 'loja',
    code: 'VIT',
    name: 'Vitrine',
    note: null,
    is_default: 0,
    active: 1,
  },
];

const PRODUTOS = [
  { id: 'p-1', name: 'Parafuso M6', internal_code: 'PAR-01', barcode: null, price_cents: 100 },
];

/** Corpos enviados ao POST /core/stock/movements, na ordem. */
let postsDeMovimento: Record<string, unknown>[] = [];
/** Quantos POSTs devem FALHAR antes de o servidor voltar a responder. */
let falhasAntesDoSucesso = 0;
/** Quantos POSTs o servidor recusa por chave reusada (422) antes de aceitar. */
let recusasDeChave = 0;

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/stock/movement-kinds')) return json({ items: [] });
    if (alvo.includes('/core/stock/locations')) return json({ locations: LOCAIS });
    if (alvo.includes('/core/products/search')) return json({ items: PRODUTOS });
    if (alvo.includes('/core/stock/movements') && init?.method === 'POST') {
      postsDeMovimento.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (recusasDeChave > 0) {
        recusasDeChave -= 1;
        const referencia = String(postsDeMovimento[postsDeMovimento.length - 1].referenceId);
        return json(
          {
            error: {
              code: 'CORE_IDEMPOTENCY_KEY_REUSED',
              message:
                `Esta chave de idempotência já registrou o movimento de estoque "${referencia}", com outro conteúdo — `
                + 'nada foi registrado agora. Um pedido novo precisa de chave nova.',
              details: { referenceId: referencia },
            },
          },
          422,
        );
      }
      if (falhasAntesDoSucesso > 0) {
        falhasAntesDoSucesso -= 1;
        return json({ error: { code: 'API_ERROR', message: 'Servidor indisponível.' } }, 500);
      }
      return json({ balance: 42, duplicated: false }, 201);
    }
    if (alvo.includes('/core/stock/movements')) return json({ items: MOVIMENTOS });
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
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da movimentação manual',
  );
}

beforeEach(() => {
  localStorage.clear();
  postsDeMovimento = [];
  falhasAntesDoSucesso = 0;
  recusasDeChave = 0;
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar() {
  render(
    <MemoryRouter>
      <MovimentacoesEstoquePage />
    </MemoryRouter>,
  );
}

/** Preenche o formulário até dar para lançar: produto escolhido + quantidade. */
async function preencherLancamento(opcoes: { tipo: string; quantidade: string; motivo?: string }) {
  fireEvent.click(screen.getByRole('button', { name: 'Lançar movimento' }));

  const busca = await screen.findByPlaceholderText('Nome, código ou barras');
  fireEvent.change(busca, { target: { value: 'Parafuso' } });
  fireEvent.click(await screen.findByRole('button', { name: /Parafuso M6/ }));

  fireEvent.change(screen.getByLabelText(/Tipo do lançamento/), {
    target: { value: opcoes.tipo },
  });
  fireEvent.change(screen.getByLabelText(/Quantidade/), {
    target: { value: opcoes.quantidade },
  });
  if (opcoes.motivo !== undefined) {
    fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: opcoes.motivo } });
  }
}

describe('quem pode lançar vê o formulário; quem não pode, não', () => {
  it('o gerente vê o botão de lançar movimento', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');
    expect(screen.getByRole('button', { name: 'Lançar movimento' })).toBeTruthy();
  });

  it('o atendente vê o histórico, mas NÃO a porta que o servidor negaria', async () => {
    entrar('atendente');
    renderizar();
    await screen.findByText('NF 123');
    expect(screen.queryByRole('button', { name: 'Lançar movimento' })).toBeNull();
  });
});

describe('a regra do servidor mora também na tela', () => {
  it('saída sem motivo é barrada ANTES de qualquer requisição', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    await preencherLancamento({ tipo: 'perda', quantidade: '3' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    expect(await screen.findByText(/motivo da saída/i)).toBeTruthy();
    expect(postsDeMovimento).toHaveLength(0);
  });

  it('a saída com motivo viaja com rótulo fechado, motivo e referência', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    await preencherLancamento({
      tipo: 'perda',
      quantidade: '3',
      motivo: 'Caixa molhada no depósito',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(postsDeMovimento).toHaveLength(1));
    const corpo = postsDeMovimento[0];
    expect(corpo.productId).toBe('p-1');
    expect(corpo.movementType).toBe('out');
    expect(corpo.referenceType).toBe('perda');
    expect(corpo.quantity).toBe(3);
    expect(corpo.reason).toBe('Caixa molhada no depósito');
    expect(typeof corpo.referenceId).toBe('string');
    expect(String(corpo.referenceId).length).toBeGreaterThan(10);

    // O desfecho aparece em palavras, com o saldo que o servidor respondeu.
    expect(await screen.findByText(/saldo atual/i)).toBeTruthy();
  });

  /*
    B-estoque-entrada-13#reauditoria: o "Ajuste de saldo (±)" POSITIVO passava
    sem motivo (a tela só exigia no que sai), e o +20 virava sobra muda no
    histórico. Sem o conserto, o POST sai sem reason.
  */
  it('ajuste POSITIVO sem motivo é barrado ANTES de qualquer requisição, apontando a Entrada avulsa', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    await preencherLancamento({ tipo: 'ajuste', quantidade: '20' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    expect(await screen.findByText(/motivo do ajuste.*Entrada avulsa/i)).toBeTruthy();
    expect(postsDeMovimento).toHaveLength(0);
  });

  it('ajuste POSITIVO com motivo viaja como adjust, com o motivo', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    await preencherLancamento({ tipo: 'ajuste', quantidade: '20', motivo: 'Achei 20 no depósito' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(postsDeMovimento).toHaveLength(1));
    expect(postsDeMovimento[0].movementType).toBe('adjust');
    expect(postsDeMovimento[0].quantity).toBe(20);
    expect(postsDeMovimento[0].reason).toBe('Achei 20 no depósito');
  });

  it('entrada não exige motivo — mercadoria que chega não some de lugar nenhum', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    await preencherLancamento({ tipo: 'entrada', quantidade: '5' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => expect(postsDeMovimento).toHaveLength(1));
    expect(postsDeMovimento[0].movementType).toBe('in');
    expect(postsDeMovimento[0].referenceType).toBe('entrada');
  });
});

describe('a referência é estável: retentativa não duplica movimento', () => {
  it('depois de uma falha, o novo envio leva o MESMO referenceId; depois do sucesso, um novo', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');
    falhasAntesDoSucesso = 1;

    await preencherLancamento({ tipo: 'perda', quantidade: '1', motivo: 'Sumiu da vitrine' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    await waitFor(() => expect(postsDeMovimento).toHaveLength(1));

    // A falha apareceu; a pessoa clica de novo. É a MESMA intenção — o
    // servidor precisa receber a MESMA identidade para não duplicar.
    await screen.findByText(/indisponível/i);
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    await waitFor(() => expect(postsDeMovimento).toHaveLength(2));
    expect(postsDeMovimento[1].referenceId).toBe(postsDeMovimento[0].referenceId);

    // Sucesso: o PRÓXIMO lançamento é outra intenção, com outra identidade.
    await screen.findByText(/saldo atual/i);
    await preencherLancamento({ tipo: 'perda', quantidade: '1', motivo: 'Outra perda' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    await waitFor(() => expect(postsDeMovimento).toHaveLength(3));
    expect(postsDeMovimento[2].referenceId).not.toBe(postsDeMovimento[0].referenceId);
  });
});

/**
 * A TENTATIVA QUE JÁ LANÇOU OUTRO MOVIMENTO (R2-IDEM, item 6).
 *
 * A referência só troca no sucesso. Se a resposta do primeiro envio se perdeu
 * (o servidor gravou) e a pessoa corrigiu a quantidade antes de clicar de novo,
 * o servidor recusa a MESMA referência com outra carga (422
 * CORE_IDEMPOTENCY_KEY_REUSED) — e a tela ficava presa: a faixa repetia o texto
 * do servidor (que fala em chave de idempotência) e todo novo clique levava a
 * mesma referência e a mesma recusa. Agora a tela diz o que houve e oferece,
 * por escolha, lançar como movimento novo; sem a escolha, nada sai.
 */
describe('a tentativa que já lançou outro movimento (422)', () => {
  async function lancarERecusar() {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');
    recusasDeChave = 1;
    await preencherLancamento({ tipo: 'perda', quantidade: '2', motivo: 'Sumiu da vitrine' });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));
    return screen.findByRole('dialog', { name: /já lançou um movimento/i });
  }

  it('diz o que houve na língua de quem lança — e nada é reenviado sem a escolha', async () => {
    const dialogo = await lancarERecusar();
    expect(dialogo.textContent).toMatch(/nada foi lançado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(postsDeMovimento).toHaveLength(1);
  });

  it('"Lançar como movimento novo" reenvia o formulário com OUTRA referência', async () => {
    const dialogo = await lancarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Lançar como movimento novo/i }));

    await waitFor(() => expect(postsDeMovimento).toHaveLength(2));
    expect(postsDeMovimento[1].referenceId).not.toBe(postsDeMovimento[0].referenceId);
    expect(postsDeMovimento[1].quantity).toBe(2);
    expect(postsDeMovimento[1].reason).toBe('Sumiu da vitrine');
    expect(await screen.findByText(/saldo atual/i)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /já lançou um movimento/i })).toBeNull();
  });

  it('"Voltar ao formulário" não reenvia, e o formulário fica como estava', async () => {
    const dialogo = await lancarERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao formulário/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já lançou um movimento/i })).toBeNull());
    expect(postsDeMovimento).toHaveLength(1);
    expect((screen.getByLabelText(/Quantidade/) as HTMLInputElement).value).toBe('2');
  });
});

/**
 * A célula de uma coluna pela POSIÇÃO do cabeçalho, não pelo texto da linha:
 * um travessão apareceria também em outras colunas, e um teste que aceita
 * qualquer travessão ficaria verde com a coluna ausente.
 */
function celula(linhaTexto: string, coluna: string): string {
  const linha = screen.getAllByText(linhaTexto)[0].closest('tr')!;
  const cabecalhos = Array.from(linha.closest('table')!.querySelectorAll('thead th')).map(
    (th) => th.textContent,
  );
  const indice = cabecalhos.indexOf(coluna);
  expect(indice).toBeGreaterThan(-1);
  return linha.querySelectorAll('td')[indice].textContent ?? '';
}

describe('o custo unitário mora na LINHA do histórico (GAP-V14)', () => {
  it('entrada com custo mostra o valor na coluna; movimento sem custo mostra travessão', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');

    expect(celula('NF 123', 'Custo unit.')).toMatch(/1\.234,56/);
    expect(celula('Venda #7', 'Custo unit.')).toBe('—');
  });

  it('o rodapé truncado das "3 primeiras linhas com custo" morreu', async () => {
    entrar('gerente_loja');
    renderizar();
    await screen.findByText('NF 123');
    expect(screen.queryByText(/Custo unitário das entradas/)).toBeNull();
  });
});
