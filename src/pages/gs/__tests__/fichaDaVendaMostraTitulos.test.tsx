/**
 * ============================================================================
 * A FICHA DA VENDA MOSTRA OS TÍTULOS QUE A VENDA GEROU — a VOLTA, em Vendas
 * ============================================================================
 *
 * ## O DEFEITO: rota sem tela
 *
 * `SalesService` acrescenta `financeEntries` à resposta de `GET /core/sales/:id`
 * — os títulos daquela venda, pela mesma consulta que a tela de Contas usa para
 * a IDA (originType + originId). Há teste de servidor cobrando isso, verde.
 *
 * No frontend, ninguém lia. O tipo `SaleDetail` sequer declarava o campo, o
 * modal da ficha mostrava itens, crédito de loja e cancelados — e nada de
 * dinheiro. A única ocorrência de `financeEntries` em `src/` inteiro estava em
 * MOCKS de teste: o servidor mandava, o navegador recebia, e o dado morria no
 * meio do caminho.
 *
 * O efeito na loja: quem abre a venda #7 para responder "essa venda já foi
 * paga?" sai da ficha, vai ao contas a receber e procura pelo texto — que é
 * exatamente o gesto que a rastreabilidade existe para apagar. Pior em venda a
 * prazo, onde a resposta são TRÊS parcelas com vencimentos diferentes.
 *
 * ## POR QUE `TitulosDoDocumento`, E NÃO UM BLOCO NOVO
 *
 * O componente já existe e já é usado nas fichas de nota de entrada e de pedido
 * de compra. E ele NÃO CONSULTA NADA: recebe `titulos` e `erro` por
 * propriedade, quem busca é a tela. Então reusá-lo aqui não custa a segunda
 * requisição que se temia — a venda já traz os títulos na própria resposta, e o
 * bloco só os desenha. Perguntar de novo em `GET /finance/entries` seria uma
 * segunda pergunta para uma resposta que já está na mão, com um estado de
 * carregamento a mais e um 403 a mais (a rota de Contas não alcança todo perfil
 * que chega a Vendas — é o mesmo erro que já obrigou a tirar `GET /core/sellers`
 * do caminho desta ficha).
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *   - tire o bloco e a venda volta a não dizer o que cobrou de quem;
 *   - leia os títulos da linha da LISTA e eles nascem vazios: a lista nunca
 *     trouxe `financeEntries`;
 *   - troque o array ausente por `[]` e "o servidor não mandou" passa a se ler
 *     como "esta venda não gerou título" — que é a mentira mais cara possível
 *     numa tela de cobrança.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import { VendasPage } from '../OperacaoPages';

const VENDA_A_PRAZO = {
  id: 'v-201',
  number: 201,
  total_cents: 300_000,
  change_cents: 0,
  status: 'completed',
  created_at: '2026-08-28T17:40:00.000Z',
  customer_id: 'c-1',
};

const VENDA_A_VISTA = { ...VENDA_A_PRAZO, id: 'v-202', number: 202, total_cents: 5_000 };
const VENDA_DE_SERVIDOR_VELHO = { ...VENDA_A_PRAZO, id: 'v-203', number: 203 };

/** Uma parcela como `FinanceService.toEntry` a serializa — camelCase. */
function parcela(n: number, valor: number, vencimento: string, pago: number) {
  return {
    id: `fe-${n}`,
    direction: 'in',
    description: `Venda #201 — parcela ${n}/3`,
    amountCents: valor,
    settledCents: pago,
    balanceCents: valor - pago,
    status: pago >= valor ? 'settled' : 'open',
    dueDate: vencimento,
    settledAt: null,
    overdue: false,
    counterpartyName: 'Maria da Silva',
    originType: 'sale',
    originId: 'v-201',
    originLabel: 'Venda #201',
    installmentNumber: n,
    installmentTotal: 3,
    categoryId: null,
    categoryName: null,
    costCenterId: null,
    costCenterName: null,
    cancelledAt: null,
    createdAt: '2026-08-28T17:40:00.000Z',
  };
}

const CORPO_DA_FICHA = {
  items: [
    {
      id: 'si-1',
      product_id: 'p-moto',
      description: 'Moto Honda CG 160',
      quantity: 1,
      unit_price_cents: 300_000,
      total_cents: 300_000,
    },
  ],
  payments: [],
  customerCreditCents: 0,
  removedItems: [],
};

const DETALHES: Record<string, Record<string, unknown>> = {
  'v-201': {
    ...VENDA_A_PRAZO,
    ...CORPO_DA_FICHA,
    financeEntries: [
      parcela(1, 100_000, '2026-09-28', 100_000),
      parcela(2, 100_000, '2026-10-28', 0),
      parcela(3, 100_000, '2026-11-28', 0),
    ],
  },
  'v-202': {
    ...VENDA_A_VISTA,
    ...CORPO_DA_FICHA,
    // Venda à vista em dinheiro não deixa título a cobrar. Vazio é RESPOSTA.
    financeEntries: [],
  },
  // O servidor velho no dia do deploy: o pacote da tela é novo, a API ainda
  // não manda o bloco. Não é "esta venda não gerou título".
  'v-203': { ...VENDA_DE_SERVIDOR_VELHO, ...CORPO_DA_FICHA },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Toda URL pedida — é como se prova que não houve segunda consulta. */
let pedidos: string[] = [];

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
    if (alvo.includes('/core/finance/entries')) {
      // Se a ficha voltar a PERGUNTAR os títulos em vez de ler os que já
      // vieram, este 403 derruba o bloco — e o teste vê.
      return json({ error: { code: 'API_PERMISSION_DENIED', message: 'Sem permissão.' } }, 403);
    }
    if (alvo.includes('/core/sales')) {
      return json({
        items: [VENDA_A_PRAZO, VENDA_A_VISTA, VENDA_DE_SERVIDOR_VELHO],
        total: 3,
      });
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
    'teste do bloco financeiro da ficha da venda',
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
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirFicha(numero: number) {
  render(
    <MemoryRouter>
      <VendasPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: `Abrir a venda #${numero}` }));
  return screen.findByRole('dialog', { name: `Venda #${numero}` });
}

/** O bloco financeiro dentro da ficha aberta. */
function blocoFinanceiro(ficha: HTMLElement): HTMLElement {
  return within(ficha).getByTestId('venda-titulos-do-financeiro');
}

describe('a ficha da venda mostra o que a venda gerou no financeiro', () => {
  it('as três parcelas, com vencimento, valor e o que falta', async () => {
    const ficha = await abrirFicha(201);
    const bloco = blocoFinanceiro(ficha);

    // As três parcelas, numeradas: "1/3" responde à pergunta que a ficha
    // sozinha não respondia — a venda foi parcelada em quantas?
    expect(bloco.textContent).toContain('1/3');
    expect(bloco.textContent).toContain('3/3');
    // Vencimento em pt-BR e SEM recuar um dia: é data de calendário.
    expect(bloco.textContent).toContain('28/10/2026');
    // O dinheiro: o total dos títulos e o que ainda cobra alguém.
    expect(bloco.textContent).toContain(formatCents(300_000));
    expect(bloco.textContent).toContain(formatCents(200_000));
    // A parcela quitada não pode aparecer com a mesma cara da que vence.
    expect(bloco.textContent).toContain('Pago');
  });

  it('os títulos vêm da PRÓPRIA ficha — nenhuma segunda consulta ao financeiro', async () => {
    const ficha = await abrirFicha(201);
    expect(blocoFinanceiro(ficha).textContent).toContain('1/3');

    // A venda já traz os títulos. Perguntar de novo seria uma segunda pergunta
    // para uma resposta que já está na mão — e a rota de Contas responde 403
    // para metade dos perfis que chegam a Vendas.
    expect(pedidos.some((u) => u.includes('/core/finance/entries'))).toBe(false);
  });

  it('venda sem título diz que não gerou — e o bloco não some da tela', async () => {
    const ficha = await abrirFicha(202);
    const bloco = blocoFinanceiro(ficha);

    // Esconder o bloco faria "nenhum" ficar indistinguível de "a tela não
    // sabe", que é o mesmo pecado do rodapé com o zero literal.
    expect(bloco.textContent).toMatch(/nenhum título/i);
  });

  it('bloco ausente na resposta é FALHA declarada, não "não gerou título"', async () => {
    const ficha = await abrirFicha(203);
    const bloco = blocoFinanceiro(ficha);

    const aviso = within(bloco).getByRole('alert');
    expect(aviso.textContent).toMatch(/financeEntries|não veio|não foi possível/i);
    // E JAMAIS a frase de lista vazia: ela leria como venda sem cobrança.
    expect(bloco.textContent).not.toMatch(/nenhum título/i);
  });
});
