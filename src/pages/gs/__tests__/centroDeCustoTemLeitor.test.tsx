/**
 * ============================================================================
 * O CENTRO DE CUSTO GANHA LEITOR NA TELA (GAP-V25)
 * ============================================================================
 *
 * ## O defeito
 *
 * O cadastro de centros de custo era completo, `createEntry` gravava a coluna
 * e a rota a repassava — e nenhuma tela lia nem escrevia. O formulário de
 * Contas nem oferecia o campo (o dado só entrava por API), nenhum relatório
 * agrupava por centro, e a própria tela de cadastros avisava, com todas as
 * letras, que a aba não servia para nada.
 *
 * ## O que estes casos cobram, e por que na TELA
 *
 * O servidor já é cobrado em `centro-de-custo-tem-leitor.test.ts`. Aqui a
 * pergunta é outra e é a que o gap descreve: existe SUPERFÍCIE? Um filtro que
 * ninguém pode acionar e um relatório que nenhuma página renderiza são
 * exatamente o estado anterior — código pronto sem chamador.
 *
 * Por isso os casos olham o CORPO e a URL das requisições, e não a mensagem de
 * sucesso: um seletor que muda de valor e não viaja é o defeito que a rodada
 * da categoria já consertou uma vez.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ContasPage from '../ContasPage';
import DrePage from '../DrePage';

const CENTROS = [
  { id: 'cc-loja', code: 'LOJA', name: 'Loja centro', active: 1 },
  { id: 'cc-ofi', code: 'OFI', name: 'Oficina', active: 1 },
];

const LANCAMENTO = {
  id: 'e-1',
  direction: 'out',
  description: 'Aluguel da loja',
  amountCents: 250_000,
  settledCents: 0,
  balanceCents: 250_000,
  status: 'open',
  dueDate: '2026-08-05',
  settledAt: null,
  overdue: false,
  counterpartyName: null,
  originType: 'manual',
  originId: 'e-1',
  originLabel: null,
  installmentNumber: 1,
  installmentTotal: 1,
  categoryId: null,
  categoryName: null,
  costCenterId: 'cc-loja',
  costCenterName: 'Loja centro',
  cancelledAt: null,
  createdAt: '2026-08-05T10:00:00.000Z',
};

const RELATORIO_DE_CENTROS = {
  from: '2026-08-01',
  to: '2026-08-31',
  lines: [
    {
      costCenterId: 'cc-loja',
      costCenterCode: 'LOJA',
      costCenterName: 'Loja centro',
      revenueCents: 400_000,
      expenseCents: 250_000,
      resultCents: 150_000,
      entryCount: 2,
    },
    {
      costCenterId: null,
      costCenterCode: null,
      costCenterName: 'Sem centro de custo',
      revenueCents: 0,
      expenseCents: 90_000,
      resultCents: -90_000,
      entryCount: 1,
    },
  ],
  revenueTotalCents: 400_000,
  expenseTotalCents: 340_000,
  resultCents: 60_000,
  entryCount: 3,
  unassigned: { entryCount: 1, revenueCents: 0, expenseCents: 90_000 },
};

const DRE_VAZIO = {
  companyId: 'c1',
  from: '2026-08-01',
  to: '2026-08-31',
  revenue: { lines: [], totalCents: 400_000, entryCount: 2 },
  expense: { lines: [], totalCents: 340_000, entryCount: 1 },
  resultCents: 60_000,
  uncategorized: { entryCount: 0, revenueCents: 0, expenseCents: 0 },
  // O CMV é de outra rodada e não é o assunto daqui; ele entra no corpo
  // porque a tela o renderiza — um dublê que omite campo obrigatório derruba
  // a tela inteira e faz este arquivo falhar por um motivo que não é o dele.
  cogs: {
    costCents: 0,
    revenueCents: 0,
    marginCents: 0,
    marginPercent: null,
    itemsWithCost: 0,
    itemsWithoutCost: 0,
    itemsBeforeSnapshot: 0,
  },
  reconciliation: {
    panelRevenueCents: 400_000,
    statementRevenueCents: 400_000,
    differenceCents: 0,
    lines: [],
  },
  caveats: ['É regime de COMPETÊNCIA.'],
};

let urls: string[] = [];
let corpos: { url: string; body: unknown }[] = [];

function servidor() {
  urls = [];
  corpos = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      urls.push(alvo);
      if (init?.body) corpos.push({ url: alvo, body: JSON.parse(String(init.body)) });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/finance/cost-centers/report')) return json(RELATORIO_DE_CENTROS);
      if (alvo.includes('/core/finance/cost-centers') && init?.method === 'POST') {
        return json({ costCenter: CENTROS[0] }, 201);
      }
      if (alvo.includes('/core/finance/cost-centers')) return json({ items: CENTROS });
      if (alvo.includes('/core/finance/income-statement')) return json(DRE_VAZIO);
      if (alvo.includes('/core/finance/categories')) return json({ items: [] });
      if (alvo.includes('/core/finance/setup')) return json({ accounts: [], costCenters: CENTROS });
      if (alvo.includes('/core/finance/entries') && init?.method === 'POST') {
        return json({ ...LANCAMENTO, installmentTotal: 1 }, 201);
      }
      if (alvo.includes('/core/finance/entries')) {
        return json({
          items: [LANCAMENTO],
          summary: { openCents: 250_000, overdueCents: 0, settledCents: 0, count: 1 },
          aging: null,
        });
      }
      return json({ items: [] });
    }),
  );
}

beforeEach(() => {
  servidor();
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do centro de custo na tela',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A tela decide o lado pela URL — `pagar` é `direction: 'out'`. */
function contas() {
  render(
    <MemoryRouter initialEntries={['/sistema/financeiro/contas-a-pagar']}>
      <ContasPage />
    </MemoryRouter>,
  );
}

describe('o filtro em Contas', () => {
  it('o seletor de centro de custo existe, com o avesso em primeiro lugar', async () => {
    contas();
    const filtro = (await screen.findByLabelText(
      'Filtrar por centro de custo',
    )) as HTMLSelectElement;
    const opcoes = [...filtro.options].map((o) => o.value);
    // O avesso vem antes da lista: no primeiro mês, "sem centro" é o período
    // inteiro, e é ele que alguém veio buscar.
    expect(opcoes[0]).toBe('');
    expect(opcoes[1]).toBe('sem-centro-de-custo');
    expect(opcoes).toContain('cc-loja');
  });

  it('escolher um centro VIAJA na consulta', async () => {
    contas();
    const filtro = await screen.findByLabelText('Filtrar por centro de custo');
    fireEvent.change(filtro, { target: { value: 'cc-ofi' } });

    await waitFor(() =>
      expect(urls.some((u) => u.includes('costCenterId=cc-ofi'))).toBe(true),
    );
  });

  it('o avesso também viaja', async () => {
    contas();
    const filtro = await screen.findByLabelText('Filtrar por centro de custo');
    fireEvent.change(filtro, { target: { value: 'sem-centro-de-custo' } });

    await waitFor(() =>
      expect(urls.some((u) => u.includes('costCenterId=sem-centro-de-custo'))).toBe(true),
    );
  });

  it('a linha MOSTRA o centro — filtro que não se confere não serve', async () => {
    contas();
    await waitFor(() => expect(screen.getByText('Loja centro')).toBeTruthy());
  });
});

describe('o campo no lançamento avulso', () => {
  it('o formulário oferece o centro, e ele CHEGA no corpo', async () => {
    /*
      Antes, o campo não existia na tela: o dado só entrava por API. Um
      formulário que oferece a classificação e não a envia é o mesmo defeito de
      antes com mais um clique — por isso o teste olha o CORPO.
    */
    contas();
    fireEvent.click(await screen.findByRole('button', { name: 'Lançar conta' }));

    const seletor = await screen.findByLabelText(/Centro de custo/);
    fireEvent.change(seletor, { target: { value: 'cc-ofi' } });
    // `Descrição` casa em mais de um elemento da tela; o do FORMULÁRIO é o
    // primeiro, porque o card de lançamento é montado acima da lista.
    const descricoes = screen.getAllByLabelText(/Descrição/);
    fireEvent.change(descricoes[0], { target: { value: 'Ferramenta da bancada' } });
    fireEvent.change(screen.getByLabelText(/^Valor/), { target: { value: '300,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lançar' }));

    await waitFor(() => {
      const envio = corpos.find((c) => c.url.includes('/core/finance/entries'));
      expect((envio?.body as { costCenterId: string })?.costCenterId).toBe('cc-ofi');
    });
  });
});

describe('o recorte no DRE', () => {
  it('a tela pede o relatório do MESMO período do DRE', async () => {
    render(
      <MemoryRouter>
        <DrePage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(urls.some((u) => u.includes('/core/finance/cost-centers/report'))).toBe(true),
    );
    const doDre = urls.find((u) => u.includes('/core/finance/income-statement'))!;
    const doCentro = urls.find((u) => u.includes('/core/finance/cost-centers/report'))!;
    // Períodos diferentes fariam as duas tabelas da mesma tela se contradizerem
    // sem que nenhuma estivesse obviamente errada.
    expect(doCentro.split('?')[1]).toBe(doDre.split('?')[1]);
  });

  it('renderiza a linha por centro com os números do servidor', async () => {
    render(
      <MemoryRouter>
        <DrePage />
      </MemoryRouter>,
    );

    await screen.findByText('Por centro de custo');
    expect(screen.getByText(/LOJA · Loja centro/)).toBeTruthy();
    // R$ 2.500,00 de despesa e R$ 4.000,00 de receita, como o servidor mandou.
    expect(screen.getAllByText('R$ 2.500,00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('R$ 4.000,00').length).toBeGreaterThan(0);
  });

  it('"Sem centro de custo" é marcado e ganha o atalho para atribuir', async () => {
    render(
      <MemoryRouter>
        <DrePage />
      </MemoryRouter>,
    );

    await screen.findByText('Por centro de custo');
    expect(screen.getByText('SEM CENTRO DE CUSTO')).toBeTruthy();
    // A linha que mede o rateio que falta precisa levar para onde se rateia.
    expect(screen.getByRole('link', { name: 'Atribuir o centro' })).toBeTruthy();
  });
});
