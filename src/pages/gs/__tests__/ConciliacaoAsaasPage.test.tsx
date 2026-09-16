/**
 * A tela de conciliação.
 *
 * O que ela não pode errar:
 *
 * 1. NÃO oferecer botão de corrigir. Ajustar o lado que parece errado é
 *    acertar a balança empurrando o prato: some com o sintoma, mantém a causa,
 *    e a próxima divergência vem em cima de um número adulterado.
 *
 * 2. Mostrar OS DOIS valores. Só o saldo da diferença não diz qual lado
 *    conferir primeiro.
 *
 * 3. Dizer quantos bateram quando não há divergência. "Tudo certo" sem número
 *    não é conferível — pode ser que nada tenha sido comparado.
 *
 * 4. NÃO IMPRIMIR O NOME INTERNO DA COLUNA. A linha da divergência dizia
 *    `finance_entry · 0d642d4a-…`: vocabulário de banco de dados, para quem
 *    confere dinheiro. É a mesma informação que o contas a receber já mostra
 *    traduzida e clicável (`originLabel` do servidor + `destinoDaOrigem`), e é
 *    a própria divergência que este relatório existe para explicar. Quem lê
 *    precisa saber DE QUE PAPEL se trata e chegar nele.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConciliacaoAsaasPage from '../ConciliacaoAsaasPage';

function servidor(relatorio: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(relatorio), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

/**
 * O servidor que responde uma coisa na primeira conciliação e outra na
 * segunda — é o que acontece quando o gerente confere um período e depois
 * pede outro.
 *
 * A fila conta SÓ as chamadas da conciliação: a casca da tela (AppShell) faz
 * pedidos próprios, e uma fila por ordem de `fetch` entregaria a resposta
 * errada para a tela errada.
 */
function servidorEmSequencia(respostas: { status: number; corpo: unknown }[]) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (entrada: unknown) => {
      const url = String(
        typeof entrada === 'string' ? entrada : (entrada as { url?: string })?.url ?? '',
      );
      if (!url.includes('/asaas/conciliacao')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const r = respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      return new Response(JSON.stringify(r.corpo), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <ConciliacaoAsaasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('quando tudo bate', () => {
  it('diz QUANTOS bateram, não só "tudo certo"', async () => {
    servidor({
      from: '2026-08-01T03:00:00.000Z',
      to: '2026-09-01T02:59:59.999Z',
      providerCents: 15000,
      financeCents: 15000,
      differenceCents: 0,
      matched: 7,
      rows: [],
    });
    montar();

    // Sem o número, "tudo certo" pode significar "nada foi comparado".
    await screen.findByText(/7 recebimento\(s\) batendo nos dois lados/);
  });

  it('período SEM movimento não é "tudo certo"', async () => {
    servidor({
      from: '2026-08-01T03:00:00.000Z',
      to: '2026-09-01T02:59:59.999Z',
      providerCents: 0,
      financeCents: 0,
      differenceCents: 0,
      matched: 0,
      rows: [],
    });
    montar();

    // Afirmar que confere quando não havia o que conferir dá uma garantia que
    // ninguém checou — e o problema pode ser a busca, não o caixa.
    await screen.findByText(/não houve o que conferir/);
    expect(screen.queryByText(/Tudo confere/)).toBeNull();
  });
});

// ============================================================================
// ERRO NOVO NÃO CONVIVE COM NÚMERO VELHO
// ============================================================================

/**
 * O DEFEITO: o `catch` do `carregar()` escrevia `setErro(...)` e não limpava
 * `dados`. O gerente conferia 30 dias, invertia as datas, o servidor recusava
 * o recorte — e a tela mostrava o alerta vermelho COM os cartões e a frase do
 * período anterior intactos logo abaixo. Números reais de um recorte que não é
 * o dos campos, ao lado de um erro: pior que o vazio que existia antes, porque
 * parecem a resposta ao que se acabou de pedir.
 */
describe('quando o servidor recusa o recorte', () => {
  const CONFERIDO = {
    from: '2026-08-01T03:00:00.000Z',
    to: '2026-09-01T02:59:59.999Z',
    providerCents: 15000,
    financeCents: 15000,
    differenceCents: 0,
    matched: 7,
    rows: [],
  };

  const RECUSA = {
    error: {
      code: 'CORE_RECONCILIATION_RANGE_INVALID',
      message: 'O fim do período é anterior ao começo: confira as datas do recorte.',
    },
  };

  it('apaga os números do período anterior em vez de mostrá-los junto do erro', async () => {
    servidorEmSequencia([
      { status: 200, corpo: CONFERIDO },
      { status: 400, corpo: RECUSA },
    ]);
    montar();

    // A primeira conferência pinta os cartões e a frase.
    await screen.findByText(/7 recebimento\(s\) batendo nos dois lados/);
    expect(screen.getByText('No provedor')).toBeTruthy();

    // A segunda é recusada pelo servidor.
    fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/fim do período é anterior ao começo/);

    // E nada do recorte anterior sobrevive à recusa.
    await waitFor(() => {
      expect(screen.queryByText(/recebimento\(s\) batendo nos dois lados/)).toBeNull();
    });
    expect(screen.queryByText('No provedor')).toBeNull();
    expect(screen.queryByText('No financeiro')).toBeNull();
    expect(screen.queryByText('Diferença')).toBeNull();
    expect(screen.queryByText(/Números do período conferido/)).toBeNull();
  });

  it('enquanto há números, a tela diz de que período eles são', async () => {
    servidor(CONFERIDO);
    montar();

    await screen.findByText(/7 recebimento\(s\) batendo nos dois lados/);
    /*
      O período é o que o SERVIDOR usou (`from`/`to` do relatório), lido no
      fuso da loja: `to` é o último milissegundo do dia 31 em Pelotas, que em
      UTC já é 1º de setembro — imprimir o pedaço cru da ISO diria "01/09".
    */
    const periodo = screen.getByText(/Números do período conferido/);
    expect(periodo.textContent).toContain('01/08/2026');
    expect(periodo.textContent).toContain('31/08/2026');
  });
});

describe('quando há divergência', () => {
  const RELATORIO = {
    from: '2026-08-01T03:00:00.000Z',
    to: '2026-09-01T02:59:59.999Z',
    providerCents: 24675,
    financeCents: 0,
    differenceCents: 24675,
    matched: 0,
    rows: [
      {
        kind: 'cobrado_nao_lancado',
        originType: 'ecommerce_order',
        originId: 'ped-1',
        providerCents: 24675,
        financeCents: null,
        differenceCents: 24675,
        providerRef: 'pay_123',
        confirmedAt: new Date().toISOString(),
        description: 'Cobrança confirmada pelo provedor sem lançamento no financeiro.',
      },
    ],
  };

  it('mostra os DOIS lados, não só o saldo', async () => {
    servidor(RELATORIO);
    montar();

    await screen.findByText('Cobrado e não lançado');
    // Quem investiga precisa saber qual lado conferir primeiro.
    expect(screen.getByText(/Provedor:/)).toBeTruthy();
    expect(screen.getByText('sem lançamento')).toBeTruthy();
  });

  it('explica o que a divergência significa em dinheiro', async () => {
    servidor(RELATORIO);
    montar();

    // Um código como "cobrado_nao_lancado" não diz a ninguém o que fazer.
    await screen.findByText(/não existe no financeiro/);
  });

  it('NÃO oferece botão de corrigir', async () => {
    servidor(RELATORIO);
    montar();

    await screen.findByText('Cobrado e não lançado');
    for (const proibido of [/corrigir/i, /ajustar/i, /sincronizar/i, /forçar/i]) {
      expect(screen.queryByRole('button', { name: proibido })).toBeNull();
    }
  });
});

// ============================================================================
// A LINHA DIZ DE QUE PAPEL SE TRATA — e leva até ele
// ============================================================================

/**
 * O DEFEITO: `ConciliacaoAsaasPage.tsx:212` imprimia `l.originType` cru.
 *
 * O gerente que confere dinheiro lia "finance_entry · 0d642d4a-3f…" — o nome
 * da COLUNA do banco e um UUID —, sem rótulo humano e sem porta para o
 * documento, enquanto o contas a receber já traduz os dois na mesma
 * informação. Divergência de dinheiro escrita em vocabulário de banco é a
 * linha que ninguém investiga.
 */
function linhaDaDivergencia(kind = 'Cobrado e não lançado'): HTMLElement {
  return screen.getByText(kind).closest('li') as HTMLElement;
}

function relatorioCom(rows: Record<string, unknown>[]) {
  return {
    from: '2026-08-01T03:00:00.000Z',
    to: '2026-09-01T02:59:59.999Z',
    providerCents: 24675,
    financeCents: 0,
    differenceCents: 24675,
    matched: 0,
    rows,
  };
}

function linha(over: Record<string, unknown> = {}) {
  return {
    kind: 'cobrado_nao_lancado',
    originType: 'ecommerce_order',
    originId: 'ped-1',
    providerCents: 24675,
    financeCents: null,
    differenceCents: 24675,
    providerRef: 'pay_123',
    confirmedAt: '2026-08-20T10:00:00.000Z',
    description: 'Cobrança confirmada pelo provedor sem lançamento no financeiro.',
    ...over,
  };
}

describe('a origem da divergência se lê em português, e abre o documento', () => {
  it('o pedido da loja vira "Pedido da loja online" com link para o pedido', async () => {
    servidor(relatorioCom([linha()]));
    montar();

    await screen.findByText('Cobrado e não lançado');
    const item = within(linhaDaDivergencia());

    // O nome interno da coluna SAI da tela.
    expect(item.queryByText(/ecommerce_order/)).toBeNull();
    expect(item.getByText(/Pedido da loja online/)).toBeTruthy();

    // E a porta é a MESMA de `destinoDaOrigem`, que o contas a receber usa —
    // não um segundo mapa de rotas escrito aqui.
    const link = item.getByRole('link', { name: /Pedido da loja online/ });
    expect(link.getAttribute('href')).toBe('/sistema/pedidos?encomenda=ped-1');
  });

  it('a venda de balcão vira "Venda" com link para a venda', async () => {
    servidor(relatorioCom([linha({ originType: 'sale', originId: 'venda-12' })]));
    montar();

    await screen.findByText('Cobrado e não lançado');
    const item = within(linhaDaDivergencia());
    expect(item.queryByText(/\bsale\b/)).toBeNull();
    expect(item.getByRole('link', { name: /Venda/ }).getAttribute('href')).toBe(
      '/sistema/vendas?venda=venda-12',
    );
  });

  it('a cobrança avulsa de título se nomeia — e NÃO ganha link, porque não há tela', async () => {
    servidor(relatorioCom([linha({ originType: 'finance_entry', originId: 'tit-7' })]));
    montar();

    await screen.findByText('Cobrado e não lançado');
    const item = within(linhaDaDivergencia());

    // O rótulo humano existe...
    expect(item.queryByText(/finance_entry/)).toBeNull();
    expect(item.getByText(/Título do contas a receber/)).toBeTruthy();
    /*
      ...e o link NÃO: o contas a receber não abre por id de lançamento
      (nenhuma tela lê um `?titulo=`), e porta desenhada que não abre é pior
      que porta nenhuma — a regra que `destinoDaOrigem` já aplica ao avulso.
    */
    expect(item.queryByRole('link')).toBeNull();
  });

  it('o id continua na linha — é por ele que o suporte acha a cobrança', async () => {
    servidor(relatorioCom([linha({ originType: 'finance_entry', originId: 'tit-7' })]));
    montar();

    await screen.findByText('Cobrado e não lançado');
    const item = within(linhaDaDivergencia());
    // Traduzir não é esconder: sem o id, ninguém casa a linha com o extrato.
    expect(item.getByText('tit-7')).toBeTruthy();
    expect(item.getByText('pay_123')).toBeTruthy();
  });

  it('origem que a tela não conhece cai no código cru, e não numa palavra errada', async () => {
    servidor(relatorioCom([linha({ originType: 'origem_do_futuro', originId: 'x-1' })]));
    montar();

    await screen.findByText('Cobrado e não lançado');
    const item = within(linhaDaDivergencia());
    /*
      Inventar "Documento" para o que a tela não conhece daria nome de gente a
      uma coisa que ela não sabe o que é. O código cru é feio e é honesto.
    */
    expect(item.getByText(/origem_do_futuro/)).toBeTruthy();
    expect(item.queryByRole('link')).toBeNull();
  });
});

describe('a tradução da origem cobre TODAS as origens de cobrança do servidor', () => {
  it('o Record da tela e o PaymentOriginType do servidor têm os mesmos membros', () => {
    /*
      LISTA POR COMPLEMENTO É BOMBA.

      O `Record<OrigemDaCobranca, …>` da tela quebra a COMPILAÇÃO se faltar um
      rótulo — mas só para os membros que a união da tela declara, e essa união
      é cópia à mão da do servidor (o frontend não importa código de `server/`).
      Uma quinta origem de cobrança nascida no servidor voltaria a imprimir
      nome de coluna na tela, em silêncio. Este caso é a costura entre as duas:
      ele fica vermelho no dia em que as listas divergirem.
    */
    const fonte = readFileSync(
      resolve(__dirname, '../../../../server/src/services/core/PaymentService.ts'),
      'utf8',
    );
    const declaracao = /export type PaymentOriginType\s*=([^;]+);/.exec(fonte);
    expect(declaracao, 'PaymentOriginType não encontrado em PaymentService.ts').toBeTruthy();
    const doServidor = [...declaracao![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    const daTela = readFileSync(resolve(__dirname, '../ConciliacaoAsaasPage.tsx'), 'utf8');
    const uniao = /type OrigemDaCobranca\s*=([^;]+);/.exec(daTela);
    expect(uniao, 'OrigemDaCobranca não encontrado em ConciliacaoAsaasPage.tsx').toBeTruthy();
    const naTela = [...uniao![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    expect(naTela).toEqual(doServidor);
    expect(naTela.length).toBeGreaterThan(0);
  });
});
