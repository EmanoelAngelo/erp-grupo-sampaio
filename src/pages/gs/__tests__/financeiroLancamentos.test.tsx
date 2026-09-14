/**
 * ============================================================================
 * FINANCEIRO › LANÇAMENTOS: A COLUNA "VALOR" MOSTRAVA VALOR QUEBRADO
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * `FinanceiroPage` declarava uma interface LOCAL em snake_case (`amount_cents`,
 * `settled_cents`, `due_date`) e lia esses campos da resposta de
 * `GET /core/finance/entries` — que serializa SÓ camelCase (`FinanceService`
 * monta um objeto novo: `amountCents`, `settledCents`, `dueDate`).
 *
 * O efeito era o pior tipo de defeito de tela: o CONVINCENTE. Descrição, tipo e
 * situação vêm com o mesmo nome nos dois lados e funcionavam; só o dinheiro e o
 * vencimento quebravam. Quem abria via uma tabela inteira montada, com badges
 * certos, e "R$ NaN" na coluna do dinheiro — e "—" em toda linha de
 * vencimento, o que se lê como "nenhum destes títulos vence", não como
 * "a tela não sabe ler a resposta".
 *
 * O compilador não podia ajudar: uma interface escrita à mão dentro da tela não
 * tem como ser confrontada com o que o servidor manda. Por isso o conserto não
 * é renomear três campos — é APAGAR a interface local e usar o tipo
 * `FinanceEntry` já exportado por `src/lib/api/core.ts`, que é o mesmo que o
 * resto do sistema usa (`TitulosDoDocumento`, `ContasPage`). Um terceiro tipo
 * para a mesma resposta é a próxima divergência esperando acontecer.
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *   - volte a ler `amount_cents` e a coluna Valor imprime "R$ NaN" —
 *     `formatCents(undefined)` não estoura, ele MENTE;
 *   - volte a ler `due_date` e toda linha vence em "—";
 *   - troque `dataBR` por `new Date(...).toLocaleDateString` e o vencimento de
 *     calendário recua um dia (o erro que `src/lib/datas.ts` existe para
 *     impedir, e que já mordeu duas vezes neste projeto);
 *   - devolva um corpo sem `items` e a tela precisa cair no ERRO — lista vazia
 *     fabricada leria como "não há títulos" num dia de cobrança.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import { FinanceiroPage } from '../OperacaoPages';

/**
 * As linhas COMO O SERVIDOR AS MANDA — camelCase, tal qual `toEntry` monta em
 * `server/src/services/core/FinanceService.ts`. É este o ponto do teste: se a
 * tela voltar a ler snake_case, nada aqui muda e ela quebra sozinha.
 */
const A_RECEBER = {
  id: 'fe-1',
  direction: 'in',
  description: 'Venda #7',
  amountCents: 125_000,
  settledCents: 0,
  balanceCents: 125_000,
  status: 'open',
  dueDate: '2026-12-31',
  settledAt: null,
  overdue: false,
  counterpartyName: 'Maria da Silva',
  originType: 'sale',
  originId: 'v-7',
  originLabel: 'Venda #7',
  installmentNumber: 1,
  installmentTotal: 1,
  categoryId: null,
  categoryName: null,
  costCenterId: null,
  costCenterName: null,
  cancelledAt: null,
  createdAt: '2026-08-30T12:00:00.000Z',
};

const A_PAGAR_SEM_VENCIMENTO = {
  ...A_RECEBER,
  id: 'fe-2',
  direction: 'out',
  description: 'Energia elétrica',
  amountCents: 48_790,
  settledCents: 48_790,
  balanceCents: 0,
  status: 'settled',
  // Título sem vencimento EXISTE (lançamento à vista já quitado). O traço aqui
  // é resposta legítima — e é por isso que a linha de cima precisa mostrar a
  // data de verdade: senão as duas ficam iguais na tela.
  dueDate: null,
  settledAt: '2026-08-30T12:00:00.000Z',
  originType: 'manual',
  originLabel: null,
};

/** O corpo que o servidor devolve, trocável por caso. */
let corpo: unknown = { items: [A_RECEBER, A_PAGAR_SEM_VENCIMENTO], summary: null, aging: null };

function servidor() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function entrarComoGerente() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste da tela de lançamentos',
  );
}

beforeEach(() => {
  corpo = { items: [A_RECEBER, A_PAGAR_SEM_VENCIMENTO], summary: null, aging: null };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGerente();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <FinanceiroPage />
    </MemoryRouter>,
  );
}

/** A linha da tabela que fala daquele título — pelo texto da descrição. */
async function linhaDe(descricao: string): Promise<HTMLElement> {
  const celula = await screen.findByText(descricao);
  return celula.closest('tr')!;
}

describe('a tela de lançamentos lê o contrato que o servidor manda', () => {
  it('a coluna Valor mostra o dinheiro, e não "NaN"', async () => {
    montar();
    const linha = await linhaDe('Venda #7');

    expect(linha.textContent).toContain(formatCents(125_000));
    // O guarda que segura o defeito de CLASSE: `formatCents(undefined)` não
    // estoura — devolve "R$ NaN" e a tela continua de pé, mentindo.
    expect(linha.textContent).not.toContain('NaN');

    const outra = await linhaDe('Energia elétrica');
    expect(outra.textContent).toContain(formatCents(48_790));
    expect(outra.textContent).not.toContain('NaN');
  });

  it('a coluna Vencimento mostra a data em pt-BR, sem recuar um dia', async () => {
    montar();
    const linha = await linhaDe('Venda #7');

    // 31/12/2026, e não 30/12: vencimento é DATA DE CALENDÁRIO. Lê-lo com
    // `new Date` faria a tela mostrar o dia anterior fora de Greenwich.
    expect(linha.textContent).toContain('31/12/2026');
  });

  it('título sem vencimento diz "—" — e isso é resposta, não ausência de leitor', async () => {
    montar();
    const semData = await linhaDe('Energia elétrica');
    const comData = await linhaDe('Venda #7');

    // As duas linhas precisam DIFERIR na coluna de vencimento. Enquanto a tela
    // lia `due_date`, as duas mostravam "—" e não havia como notar o defeito.
    expect(semData.textContent).toContain('—');
    expect(comData.textContent).not.toContain('31/12/2026 —');
  });

  it('a situação e o tipo continuam de pé — o que já funcionava não regride', async () => {
    montar();
    const receber = await linhaDe('Venda #7');
    expect(within(receber).getByText('A receber')).toBeTruthy();
    expect(within(receber).getByText('Em aberto')).toBeTruthy();

    const pagar = await linhaDe('Energia elétrica');
    expect(within(pagar).getByText('A pagar')).toBeTruthy();
    expect(within(pagar).getByText('Liquidado')).toBeTruthy();
  });

  it('corpo sem "items" cai no erro da tela, e não numa lista vazia inventada', async () => {
    corpo = { summary: null, aging: null };
    montar();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/items/);
    // "Nenhum lançamento" num dia de cobrança é a pior resposta possível.
    await waitFor(() => expect(screen.queryByText('Nenhum lançamento')).toBeNull());
  });
});
