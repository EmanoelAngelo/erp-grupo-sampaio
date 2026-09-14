/**
 * A VALIDADE DA PRÉ-VENDA VEM DA POLÍTICA, e não de um `7` cravado na tela.
 *
 * ## O defeito
 *
 * `useState(inDays(7))`. Sete dias era a validade da reserva de todas as lojas
 * do grupo, escrita num formulário do frontend. Mudar esse prazo para uma
 * operação exigia editar código — e o SERVIDOR, que é quem expira o documento e
 * devolve o estoque reservado, nunca soube que aquele número existia.
 *
 * Pior: como data explícita VENCE o padrão do servidor, o `7` do frontend
 * atropelava silenciosamente qualquer política que a operação viesse a ter. A
 * tela decidia, e a configuração ficava decorativa.
 *
 * ## O que se cobra
 *
 *   - o campo nasce com a data da POLÍTICA, e a tela diz de onde ela veio;
 *   - a sugestão INTOCADA viaja como nula: quem calcula o instante de
 *     vencimento é o servidor, que é também quem expira o documento depois.
 *     Duas contas para o mesmo prazo divergem — e a divergência aqui solta
 *     reserva antes da hora;
 *   - a data ESCOLHIDA pelo operador vale até o FIM do dia escolhido, o mesmo
 *     instante que o servidor usaria;
 *   - quem não pode ler a política (a rota é ROTA_GESTAO, o servidor exige
 *     gerente) fica com o campo em BRANCO, e o documento vai com `validUntil:
 *     null` — que faz o servidor aplicar a validade dele. Um palpite do
 *     frontend seria pior que o vazio, porque venceria o padrão do servidor.
 *
 * Volte o `inDays(7)` e o primeiro teste cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/*
  QUEM USA A TELA (GAP-PRD-149): desde que Orçamentos esconde o botão que o
  servidor recusa, a tela precisa saber o perfil. Este arquivo exercita o
  fluxo de quem cria, edita, renova e fatura — o gerente da loja.
*/
vi.mock('@/hooks/useSession', async (original) => ({
  ...(await original<typeof import('@/hooks/useSession')>()),
  useProfile: () => 'gerente_loja',
  useHasProfile: (...allowed: string[]) => allowed.includes('gerente_loja'),
}));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrcamentosPage from '../OrcamentosPage';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'LJ-0001',
  sku: null,
  barcode: '789',
  name: 'Pastilha de freio',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 2000,
  price_cents: 5000,
  effective_price_cents: 5000,
  min_stock: 0,
  active: 1,
};

/** Dias de validade que a política responde; null = a rota recusa com 403. */
let validadeDias: number | null = 3;
let criados: unknown[] = [];

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();

      if (alvo.includes('/core/sale-policies')) {
        if (validadeDias === null) {
          return new Response(
            JSON.stringify({
              error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            discountLimitPercent: 10,
            creditSaleDueDays: 0,
            reservationValidDays: validadeDias,
            definidos: {
              discountLimitPercent: false,
              creditSaleDueDays: false,
              reservationValidDays: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (alvo.includes('/core/quotes') && metodo === 'POST') {
        criados.push(init?.body ? JSON.parse(init.body) : null);
        return new Response(
          JSON.stringify({ id: 'q-1', number: 1, kind: 'pre_venda', status: 'aberto' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      let corpo: unknown = {};
      if (alvo.includes('/core/quotes')) corpo = { items: [] };
      else if (alvo.includes('/core/customers')) corpo = { items: [] };
      else if (alvo.includes('/core/products/search')) corpo = { items: [PRODUTO] };

      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  validadeDias = 3;
  criados = [];
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Abre o diálogo de novo documento, que é onde a validade é escolhida. */
async function abrirNovo() {
  render(
    <MemoryRouter>
      <OrcamentosPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Novo / }));
  return (await screen.findByLabelText('Válido até')) as HTMLInputElement;
}

/**
 * A data de hoje + N dias no calendário LOCAL, como o `<input type="date">` a
 * escreve.
 *
 * Não é `toISOString().slice(0, 10)`: isso lê o dia em UTC, e à noite no Brasil
 * (UTC−3) o dia UTC já é o seguinte. Um teste escrito assim ficaria verde de
 * manhã e vermelho depois das 21h — e, pior, aprovaria justamente o defeito de
 * fuso que `inDays` acabou de corrigir.
 */
function emDias(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Põe um produto no documento e salva — o resto do formulário não é o assunto. */
async function adicionarProdutoESalvar() {
  fireEvent.change(screen.getByLabelText(/Pesquise o produto/), {
    target: { value: 'Pastilha' },
  });
  fireEvent.keyDown(screen.getByLabelText(/Pesquise o produto/), { key: 'Enter' });
  fireEvent.click(await screen.findByText('Pastilha de freio'));
  fireEvent.click(screen.getByRole('button', { name: /^Salvar / }));
}

/** O dia LOCAL de um instante ISO — é assim que a data volta do servidor. */
function diaLocalDe(iso: string): string {
  const d = new Date(iso);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

describe('a data sugerida vem da política da operação', () => {
  it('três dias na política, três dias no campo — não sete', async () => {
    const campo = await abrirNovo();

    await waitFor(() => expect(campo.value).toBe(emDias(3)));
    // E a tela diz de ONDE veio: sem isso o operador não distingue sugestão de
    // digitação, e a validade da pré-venda é o que segura estoque.
    expect(screen.getByText(/Sugerido pela política do balcão: 3 dia\(s\)/)).toBeTruthy();
  });

  it('sugestão INTOCADA viaja como nula — quem data o documento é o servidor', async () => {
    const campo = await abrirNovo();
    await waitFor(() => expect(campo.value).toBe(emDias(3)));

    await adicionarProdutoESalvar();

    await waitFor(() => expect(criados).toHaveLength(1));
    /*
      DUAS CONTAS PARA O MESMO PRAZO ERAM UMA A MAIS.

      O servidor encerra a validade no FIM do dia (`validadeDaReserva`,
      23:59:59.999 no relógio da loja) e é ele quem depois EXPIRA o documento e
      devolve o estoque. A tela reconstruía esse instante do `<input
      type="date">` — e data explícita vence o padrão do servidor, então era a
      conta da tela que valia sempre, inclusive quando ninguém tinha escolhido
      data nenhuma (a sugestão preenchia o campo sozinha). Qualquer diferença
      entre as duas contas — meia-noite em vez do fim do dia, o dia lido em UTC
      — é reserva solta antes da hora, com a peça voltando ao disponível e
      sendo vendida para outro cliente enquanto o primeiro ainda tem prazo.

      Mande a data reconstruída aqui e este teste cai.
    */
    expect((criados[0] as { validUntil: unknown }).validUntil).toBeNull();
  });

  it('data ESCOLHIDA viaja como DATA — quem a fecha no fim do dia é o servidor', async () => {
    const campo = await abrirNovo();
    await waitFor(() => expect(campo.value).toBe(emDias(3)));

    /*
      A TELA DEIXOU DE REFAZER A CONTA DO SERVIDOR.

      A versão anterior deste teste exigia que a tela mandasse o INSTANTE — fim
      do dia, 23:59:59.999 — e o comentário dela mesma explicava por quê: duas
      contas para o mesmo prazo são uma a mais, e qualquer diferença entre elas
      é reserva solta antes da hora.

      O jeito de ter uma conta só não é sincronizar as duas: é apagar uma. A
      tela manda o que o operador digitou, que é uma DATA, e o servidor a fecha
      no último instante daquele dia no relógio da LOJA
      (`comoInstanteFinal`, em `CalendarioOperacional`).

      A conta que a tela fazia usava o fuso do NAVEGADOR. Num computador de
      balcão configurado errado — ou no notebook do dono em viagem — o prazo
      combinado com o cliente saía diferente do prazo que o servidor cobra.
    */
    fireEvent.change(campo, { target: { value: emDias(10) } });
    await adicionarProdutoESalvar();

    await waitFor(() => expect(criados).toHaveLength(1));
    expect((criados[0] as { validUntil: unknown }).validUntil).toBe(emDias(10));
  });
});

describe('sem permissão para ler a política', () => {
  it('o campo fica em BRANCO e a tela diz que o servidor decide', async () => {
    validadeDias = null;
    const campo = await abrirNovo();

    // Vazio, e não um palpite: data explícita vence o padrão do servidor, então
    // um chute aqui atropelaria a política que a operação configurou.
    await waitFor(() =>
      expect(screen.getByText(/vale a validade padrão desta operação/)).toBeTruthy(),
    );
    expect(campo.value).toBe('');
  });

  it('o documento vai com validUntil nulo, para o servidor aplicar a política', async () => {
    validadeDias = null;
    await abrirNovo();
    await waitFor(() =>
      expect(screen.getByText(/vale a validade padrão desta operação/)).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText(/Pesquise o produto/), {
      target: { value: 'Pastilha' },
    });
    fireEvent.keyDown(screen.getByLabelText(/Pesquise o produto/), { key: 'Enter' });
    fireEvent.click(await screen.findByText('Pastilha de freio'));
    fireEvent.click(screen.getByRole('button', { name: /^Salvar / }));

    await waitFor(() => expect(criados).toHaveLength(1));
    expect((criados[0] as { validUntil: unknown }).validUntil).toBeNull();
  });
});
