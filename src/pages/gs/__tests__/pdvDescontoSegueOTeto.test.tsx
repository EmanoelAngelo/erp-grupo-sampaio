/**
 * ============================================================================
 * O DESCONTO DA LINHA TEM DE ACOMPANHAR O TETO DA LINHA
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * `definirDescontoDaLinha` limita o desconto ao total da linha NO MOMENTO em
 * que ele é digitado. Depois disso, quem mexe no teto não mexe no desconto:
 *
 *   - `definirQtdDaLinha` muda a quantidade e não toca em `discountCents`;
 *   - `definirPrecoDaLinha` (preço aberto) rebaixa o valor combinado e também
 *     não toca;
 *   - a reprecificação por cliente troca o preço vigente e idem.
 *
 * A sequência que quebra: linha 3 × R$ 10,00 com R$ 30,00 de desconto (aceito,
 * é exatamente o teto), corrigida para quantidade 1. A tela mostra a linha em
 * R$ 0,00 — o `Math.max(0, …)` do total esconde o negativo — e o POST leva
 * `items[].discountCents = 3000` contra um bruto de 1000. O servidor recusa com
 * `CORE_INVALID_DISCOUNT` ("Desconto maior que o valor do item.").
 *
 * ## O AGRAVANTE, que é metade do conserto
 *
 * Essa recusa caía no ramo GENÉRICO do `finalize`: faixa vermelha com a frase
 * do servidor e NADA marcado no carrinho — ao contrário de
 * `CORE_PRODUCT_WITHOUT_PRICE`, que marca a linha ofensora e oferece a saída.
 * Com o cliente na frente e doze linhas na tela, o operador lê "desconto maior
 * que o valor do item" e vai procurar em qual delas.
 *
 * ## O QUE SE COBRA AQUI
 *
 * Os dois lados. Que o desconto acompanhe o teto nos TRÊS escritores do teto
 * (é defeito de classe, não da quantidade), e que a recusa do servidor aponte
 * a linha — nomeada por ele quando ele a nomeia, achada pela tela quando não.
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *   - tire o re-limite da quantidade e o POST volta a levar 3000 contra 1000;
 *   - re-limite a linha mas não o RASCUNHO do campo e a tela passa a mostrar
 *     "30,00" num desconto que vale R$ 10,00 — mentira nova no lugar da velha;
 *   - devolva a recusa ao ramo genérico e a linha ofensora deixa de ser
 *     marcada.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const CAMISETA = {
  id: 'p-camiseta',
  internal_code: 'CM-1',
  sku: null,
  barcode: '7890000001111',
  name: 'Camiseta',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 400,
  price_cents: 1_000,
  effective_price_cents: 1_000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 50,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Mão de obra: preço ABERTO, digitado na própria linha. */
const SERVICO = {
  ...CAMISETA,
  id: 'p-servico',
  internal_code: 'SV-1',
  barcode: '7890000002222',
  name: 'Mão de obra',
  price_cents: 0,
  effective_price_cents: 0,
  open_price: 1,
};

const CATALOGO = [CAMISETA, SERVICO];

let vendasEnviadas: Record<string, unknown>[] = [];
let respostaDaVenda: { status: number; body: unknown } = {
  status: 201,
  body: {
    id: 's-1',
    number: 1,
    total_cents: 0,
    change_cents: 0,
    status: 'completed',
    created_at: '',
  },
};

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/sales') && metodo === 'POST') {
      vendasEnviadas.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify(respostaDaVenda.body), {
        status: respostaDaVenda.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: CATALOGO.filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 100, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vendasEnviadas = [];
  respostaDaVenda = {
    status: 201,
    body: {
      id: 's-1',
      number: 1,
      total_cents: 0,
      change_cents: 0,
      status: 'completed',
      created_at: '',
    },
  };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function bipar(codigo: string, nome: string) {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await screen.findByRole('button', { name: `Remover ${nome}` });
}

/** A linha do carrinho daquele produto. */
function linhaDe(nome: string): HTMLElement {
  return screen.getByRole('button', { name: `Remover ${nome}` }).closest('li')!;
}

function campoDeDesconto(nome: string): HTMLInputElement {
  return screen.getByLabelText(`Desconto de ${nome}`) as HTMLInputElement;
}

async function finalizar() {
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
  await waitFor(() => expect(vendasEnviadas.length).toBeGreaterThan(0));
  return vendasEnviadas[0].items as { productId: string; discountCents?: number }[];
}

describe('o desconto da linha acompanha o teto da linha', () => {
  it('quantidade que CAI re-limita o desconto — na tela e no que viaja', async () => {
    montar();
    await bipar(CAMISETA.barcode, 'Camiseta');

    // 3 × R$ 10,00 = R$ 30,00 de teto. O desconto de R$ 30,00 é aceito.
    fireEvent.change(screen.getByLabelText('Quantidade de Camiseta'), { target: { value: '3' } });
    fireEvent.change(campoDeDesconto('Camiseta'), { target: { value: '30' } });
    expect(linhaDe('Camiseta').textContent).toContain(formatCents(0));

    // A correção: eram 3, é 1. O teto virou R$ 10,00.
    fireEvent.change(screen.getByLabelText('Quantidade de Camiseta'), { target: { value: '1' } });

    // O CAMPO mostra o desconto que vale agora. Re-limitar a linha e deixar
    // "30,00" escrito trocaria uma mentira por outra.
    await waitFor(() => expect(campoDeDesconto('Camiseta').value).toBe('10,00'));

    const itens = await finalizar();
    expect(itens[0].discountCents).toBe(1_000);
  });

  it('quantidade que SOBE não inventa desconto — só o teto cresce', async () => {
    montar();
    await bipar(CAMISETA.barcode, 'Camiseta');

    fireEvent.change(campoDeDesconto('Camiseta'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Quantidade de Camiseta'), { target: { value: '4' } });

    // R$ 5,00 continuam R$ 5,00: o teto subiu, o combinado não.
    await waitFor(() => expect(campoDeDesconto('Camiseta').value).toBe('5,00'));
    // 4 × R$ 10,00 − R$ 5,00. Conferido ANTES de fechar: o Finalizar limpa o
    // carrinho, e ler a linha depois seria ler uma tela que já não existe.
    expect(linhaDe('Camiseta').textContent).toContain(formatCents(3_500));

    const itens = await finalizar();
    expect(itens[0].discountCents).toBe(500);
  });

  /*
    O CARRINHO GUARDADO PELA VERSÃO ANTIGA VOLTA PELA PORTA DOS FUNDOS.

    `comDescontoDentroDoTeto` guarda os TRÊS escritores que a tela conhece —
    quantidade, valor combinado e reprecificação. A retomada da espera (F7) é
    um QUARTO, e ela não passava por lá: `setLines(venda.lines)` devolvia as
    linhas exatamente como estavam gravadas.

    Isso não é hipótese. A espera mora no `localStorage` e é lida com um `as`
    seco (`JSON.parse(bruto) as VendaEmEspera[]`, pdvEmEspera.ts): o que volta
    é o que estava lá, e o que estava lá pode ter sido escrito pela versão
    ANTERIOR a esta regra — quando 3 × R$ 10,00 com R$ 30,00 de desconto virava
    1 × R$ 10,00 com R$ 30,00 e ninguém re-limitava nada. O operador que deixou
    o carrinho em espera na sexta e o retomou na segunda, depois da atualização,
    retoma o defeito junto.

    O teto não é opinião da tela: é a conta do servidor. Uma linha que volta
    acima dele só tem um desfecho, e é a recusa no Finalizar — com o cliente na
    frente e sem nada na tela explicando de onde veio o número.
  */
  it('a espera guardada pela versão ANTIGA volta re-limitada — o quarto escritor', async () => {
    // O retrato que a versão anterior gravava: quantidade 1, desconto de 3000.
    localStorage.setItem(
      'gs.pdv.emEspera',
      JSON.stringify([
        {
          id: 'espera-velha',
          escopo: CAIXA_ABERTO.id,
          rotulo: 'Carrinho de sexta',
          criadoEm: '2026-08-28T18:00:00.000Z',
          itens: 1,
          totalCents: 1_000,
          customerId: null,
          customerName: null,
          discount: 0,
          note: '',
          lines: [
            {
              product: CAMISETA,
              quantity: 1,
              unitPriceCents: 1_000,
              discountCents: 3_000,
            },
          ],
        },
      ]),
    );

    montar();

    // A faixa das esperas é desenhada direto — não há menu a abrir.
    await screen.findByTestId('pdv-esperas');
    fireEvent.click(screen.getByRole('button', { name: 'Carrinho de sexta' }));
    await screen.findByRole('button', { name: 'Remover Camiseta' });

    // O teto de 1 × R$ 10,00 é R$ 10,00. O campo diz o que vale AGORA.
    await waitFor(() => expect(campoDeDesconto('Camiseta').value).toBe('10,00'));

    // E o que viaja é o re-limitado, não o que estava guardado.
    const itens = await finalizar();
    expect(itens[0].discountCents).toBe(1_000);
  });

  it('valor combinado REBAIXADO re-limita o desconto — o mesmo defeito, outro escritor', async () => {
    montar();
    await bipar(SERVICO.barcode, 'Mão de obra');

    fireEvent.change(screen.getByLabelText('Valor combinado de Mão de obra'), {
      target: { value: '150,00' },
    });
    fireEvent.change(campoDeDesconto('Mão de obra'), { target: { value: '100' } });

    // O cliente pechinchou: o combinado passa a R$ 50,00. O desconto de
    // R$ 100,00 não cabe mais.
    fireEvent.change(screen.getByLabelText('Valor combinado de Mão de obra'), {
      target: { value: '50,00' },
    });

    await waitFor(() => expect(campoDeDesconto('Mão de obra').value).toBe('50,00'));
    const itens = await finalizar();
    expect(itens[0].discountCents).toBe(5_000);
  });
});

describe('a recusa de desconto do servidor APONTA A LINHA', () => {
  it('com a linha nomeada pelo servidor: marca, explica e oferece o conserto', async () => {
    respostaDaVenda = {
      status: 400,
      body: {
        error: {
          code: 'CORE_INVALID_DISCOUNT',
          message: 'Desconto maior que o valor do item.',
          details: { productId: 'p-camiseta', discountCents: 3_000 },
        },
      },
    };
    montar();
    await bipar(CAMISETA.barcode, 'Camiseta');
    await bipar(SERVICO.barcode, 'Mão de obra');
    fireEvent.change(campoDeDesconto('Camiseta'), { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    // O texto do SERVIDOR, não um "falha ao finalizar" genérico.
    const recusa = await screen.findByText('Desconto maior que o valor do item.');
    expect(recusa).toBeTruthy();

    // E a LINHA marcada: é isso que evita o operador procurar entre doze.
    await waitFor(() =>
      expect(linhaDe('Camiseta').getAttribute('data-linha-ofensora')).toBe('sim'),
    );
    expect(linhaDe('Mão de obra').getAttribute('data-linha-ofensora')).toBeNull();

    // A saída, ali mesmo: zerar o desconto da linha ofensora.
    fireEvent.click(screen.getByRole('button', { name: /Zerar o desconto desta linha/ }));
    await waitFor(() => expect(campoDeDesconto('Camiseta').value).toBe(''));
    expect(screen.queryByText('Desconto maior que o valor do item.')).toBeNull();
  });

  it('sem a linha nomeada, a faixa diz QUAIS linhas têm desconto — e não some', async () => {
    respostaDaVenda = {
      status: 400,
      body: {
        error: { code: 'CORE_INVALID_DISCOUNT', message: 'Desconto maior que o valor do item.' },
      },
    };
    montar();
    await bipar(CAMISETA.barcode, 'Camiseta');
    await bipar(SERVICO.barcode, 'Mão de obra');
    fireEvent.change(screen.getByLabelText('Valor combinado de Mão de obra'), {
      target: { value: '80,00' },
    });
    fireEvent.change(campoDeDesconto('Camiseta'), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    const faixa = await screen.findByTestId('recusa-de-desconto');
    expect(faixa.textContent).toContain('Desconto maior que o valor do item.');
    // "Não sei qual linha" é um estado HONESTO — e ainda assim reduz a busca
    // de doze linhas para as que têm desconto.
    expect(faixa.textContent).toContain('Camiseta');
    expect(faixa.textContent).not.toContain('Mão de obra');
    // E nenhuma linha fica marcada por chute: marcar a errada mandaria o
    // operador consertar o que não está quebrado.
    expect(linhaDe('Camiseta').getAttribute('data-linha-ofensora')).toBeNull();
  });
});

/**
 * ============================================================================
 * DUAS LINHAS ESTOURADAS AO MESMO TEMPO — a metade que faltava dos dois lados
 * ============================================================================
 *
 * ## O DEFEITO, nos dois lugares
 *
 * SERVIDOR: `SalesService` lançava `CORE_INVALID_DISCOUNT` ("Desconto maior que
 * o valor do item.") SEM `detail` — enquanto a recusa vizinha, a do desconto
 * negativo, sempre levou `productId`. Duas saídas do mesmo código de erro, uma
 * nomeando a linha e a outra não.
 *
 * TELA: sem o nome vindo do servidor ela re-derivava com a MESMA aritmética e
 * só marcava quando achava EXATAMENTE UMA linha fora do teto (`achadas.length
 * === 1`). Com DUAS estouradas ao mesmo tempo ela desistia de marcar as duas
 * — e o operador voltava a receber uma frase e uma lista de doze linhas para
 * conferir, com o cliente na frente.
 *
 * O `=== 1` não era prudência: achar duas pela mesma conta do servidor não é
 * chute nenhum, é a resposta certa duas vezes. Prudência é o caso ZERO, e esse
 * continua igual — nada marcado, e a faixa dizendo quais linhas têm desconto.
 *
 * ## POR ONDE UM CARRINHO CHEGA ESTOURADO — e por que não chega mais
 *
 * Quando estes casos nasceram, `setLines` tinha um QUARTO caminho que não
 * passava pelo teto: a espera do F7, que devolvia o carrinho como fora
 * guardado. Era por ele que o estado entrava aqui.
 *
 * Esse buraco foi fechado logo depois (`retomarEspera` agora re-limita, e o
 * caso "a espera guardada pela versão ANTIGA volta re-limitada" o crava), e
 * fechá-lo mudou o que estes casos podem afirmar: NENHUM escritor da tela
 * deixa uma linha acima do teto, então a conta própria dela não tem mais o que
 * achar por aqui.
 *
 * O que sobrou é o que importava desde o começo, e é o caminho de verdade: a
 * RECUSA DO SERVIDOR. Ela agora nomeia TODAS as linhas (`productIds`), porque
 * recusar na primeira devolvia um nome por tentativa — o operador consertava
 * uma, clicava em Finalizar e tomava a mesma frase pela outra. O cenário do F7
 * continua montando o carrinho porque é o jeito mais curto de pôr duas linhas
 * com desconto na tela; o desconto delas chega re-limitado, e quem aponta o
 * dedo é a resposta do servidor.
 */
describe('DUAS linhas fora do teto: as DUAS ficam marcadas', () => {
  /**
   * Um carrinho guardado no F7 com dois descontos maiores que as linhas.
   *
   * A retomada os re-limita hoje — o que interessa aqui é o carrinho de duas
   * linhas com desconto, não o valor estourado.
   */
  function esperaEstourada() {
    localStorage.setItem(
      'gs.pdv.emEspera',
      JSON.stringify([
        {
          id: 'espera-1',
          escopo: CAIXA_ABERTO.id,
          rotulo: 'Carrinho parado',
          criadoEm: '2026-08-30T12:00:00.000Z',
          customerId: null,
          customerName: null,
          discount: 0,
          note: '',
          lines: [
            {
              product: CAMISETA,
              quantity: 1,
              unitPriceCents: 1_000,
              discountCents: 3_000,
              precificadaPara: null,
            },
            {
              product: SERVICO,
              quantity: 1,
              unitPriceCents: 5_000,
              discountCents: 9_000,
              precificadaPara: null,
            },
          ],
        },
      ]),
    );
  }

  async function retomarOCarrinho() {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Carrinho parado' }));
    await screen.findByRole('button', { name: 'Remover Camiseta' });
    await screen.findByRole('button', { name: 'Remover Mão de obra' });
  }

  it('o servidor nomeia AS DUAS, e as duas ficam marcadas', async () => {
    respostaDaVenda = {
      status: 400,
      body: {
        error: {
          code: 'CORE_INVALID_DISCOUNT',
          message: 'Desconto maior que o valor do item.',
          // O laço do servidor ANOTA e segue: a recusa sai uma vez, com a
          // lista inteira. Era daqui que vinha um nome por tentativa.
          details: {
            productId: 'p-camiseta',
            discountCents: 3_000,
            productIds: ['p-camiseta', 'p-servico'],
          },
        },
      },
    };
    esperaEstourada();
    await retomarOCarrinho();

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await screen.findByText('Desconto maior que o valor do item.');

    await waitFor(() =>
      expect(linhaDe('Camiseta').getAttribute('data-linha-ofensora')).toBe('sim'),
    );
    // A SEGUNDA — é ela que sumia. Uma frase e doze linhas era o que sobrava.
    expect(linhaDe('Mão de obra').getAttribute('data-linha-ofensora')).toBe('sim');
  });

  /*
    O SERVIDOR ANTIGO NOMEAVA UMA — e a tela não pode piorar por falar com ele.

    `productIds` nasceu nesta rodada. Uma resposta sem ele (servidor anterior,
    ou um cliente que não subiu junto) continua trazendo `productId` sozinho, e
    a tela tem de marcar ao menos essa. É o caminho de compatibilidade, e ele é
    medido — não suposto.
  */
  it('servidor ANTIGO nomeia só UMA: a tela marca a que ele nomeou', async () => {
    respostaDaVenda = {
      status: 400,
      body: {
        error: {
          code: 'CORE_INVALID_DISCOUNT',
          message: 'Desconto maior que o valor do item.',
          // Sem `productIds`: é exatamente o que o servidor de ontem responde.
          details: { productId: 'p-camiseta', discountCents: 3_000 },
        },
      },
    };
    esperaEstourada();
    await retomarOCarrinho();

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
    await screen.findByText('Desconto maior que o valor do item.');

    await waitFor(() =>
      expect(linhaDe('Camiseta').getAttribute('data-linha-ofensora')).toBe('sim'),
    );

    // E o conserto zera a marcada — o botão fala no singular quando é uma.
    fireEvent.click(screen.getByRole('button', { name: /Zerar o desconto/ }));
    await waitFor(() => expect(campoDeDesconto('Camiseta').value).toBe(''));
  });

  it('ZERO achadas continua sendo "não sei qual" — o caso honesto não mudou', async () => {
    respostaDaVenda = {
      status: 400,
      body: {
        error: { code: 'CORE_INVALID_DISCOUNT', message: 'Desconto maior que o valor do item.' },
      },
    };
    montar();
    await bipar(CAMISETA.barcode, 'Camiseta');
    fireEvent.change(campoDeDesconto('Camiseta'), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));

    const faixa = await screen.findByTestId('recusa-de-desconto');
    expect(faixa.textContent).toContain('O servidor não disse qual linha');
    expect(linhaDe('Camiseta').getAttribute('data-linha-ofensora')).toBeNull();
  });
});
