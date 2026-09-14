/**
 * A LIBERAÇÃO DO GESTOR CARREGA O VALOR — no PDV e na aprovação de orçamento.
 *
 * ## O contorno que estes testes fecham
 *
 * A liberação era um "sim" sem número. O PDV pedia autorização mandando os
 * valores COSTURADOS numa frase — "Concessão de R$ 3.400,00 (28%) sobre
 * R$ 12.000,00 na venda X" — e mais nada. O servidor guardava a frase, e frase
 * não se compara com carrinho: `granted_concession_cents` nascia nulo, e o
 * `consumirLiberacaoDeConcessao` não tinha contra o que conferir.
 *
 * O resultado é executável em três gestos, e nenhum deles deixa rastro que
 * denuncie: o gestor olha a tela, vê 28%, digita a senha e sai de perto; o
 * operador volta ao carrinho, rebaixa mais o preço, e fecha a venda concedendo
 * 60% com o MESMO "sim". A liberação continuava valendo uma vez só — o que ela
 * não fazia era valer para um VALOR.
 *
 * ## Por que os testes olham o CORPO DA REQUISIÇÃO, e não a tela
 *
 * Porque é no fio que este defeito vive e morre. Um teste que dubla a
 * autorização e confere que a venda fechou fica verde com os campos ausentes —
 * o servidor dublado aceita o que se mandou ele aceitar. E o nome do campo é
 * metade do recurso: `POST /core/authorizations` lê `concedidoCents`, e
 * qualquer outro nome (`valorCents`, `amountCents`, `concessaoCents`) atravessa
 * o fio, é ignorado do outro lado, e a liberação volta a nascer sem teto —
 * exatamente o estado de antes, com a aparência de estar consertado.
 *
 * Por isso as asserções abaixo são sobre chaves e valores do JSON enviado.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire `concedidoCents`/`brutoCents` da chamada do PDV e o primeiro bloco
 *     cai;
 *   - renomeie o campo e ele cai igual, que é o ponto;
 *   - mande os números da PRÉVIA em vez dos números da RECUSA e o terceiro cai:
 *     o gestor assinaria um valor diferente do que o servidor vai medir;
 *   - deixe a aprovação de orçamento sem o diálogo, ou reenvie sem o
 *     `authorizationId`, e o bloco do orçamento cai — que é o beco original.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/*
  QUEM USA A TELA (GAP-PRD-149): Orçamentos esconde o botão que o servidor
  recusa, então a tela precisa saber o perfil. A aprovação com liberação é
  fluxo de quem escreve orçamento — aqui, o gerente da loja.
*/
vi.mock('@/hooks/useSession', async (original) => ({
  ...(await original<typeof import('@/hooks/useSession')>()),
  useProfile: () => 'gerente_loja',
  useHasProfile: (...allowed: string[]) => allowed.includes('gerente_loja'),
}));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PdvPage from '../PdvPage';
import OrcamentosPage from '../OrcamentosPage';

/** A gaveta aberta do turno — sem ela o PDV recusa a venda. */
const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

/** A moto de R$ 12.000 — o item do caso real do preço rebaixado. */
const MOTO = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Moto Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 900000,
  price_cents: 1200000,
  effective_price_cents: 1200000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 2,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Tudo o que saiu no fio, para as asserções sobre o corpo. */
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

function registrar(url: string, metodo: string, init?: { body?: string }) {
  enviados.push({
    url,
    metodo,
    corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  });
}

/** O corpo do POST de autorização — o único lugar onde este defeito aparece. */
function corpoDaAutorizacao(): Record<string, unknown> {
  const pedido = enviados.find(
    (e) => e.url.includes('/core/authorizations') && e.metodo === 'POST',
  );
  expect(pedido, 'nenhuma autorização foi pedida').toBeTruthy();
  return pedido!.corpo!;
}

const LIBERACAO = {
  id: 'auth-1',
  action: 'desconto_acima_limite',
  authorizedBy: 'u-gerente',
  authorizedByName: 'Gerente',
  createdAt: '2026-08-18T12:00:00.000Z',
  grantedConcessionCents: 200000,
  grantedGrossCents: 1200000,
};

/*
  A RECUSA DO SERVIDOR, com os números DELE.

  Repare que `concedidoCents` aqui (R$ 2.500) é DIFERENTE do que a prévia da
  tela calcularia para o mesmo carrinho (R$ 2.000). A divergência é de
  propósito: é ela que prova qual das duas fontes a tela usou ao pedir a
  liberação. Num caixa real elas divergem sempre que o preço muda entre a
  montagem do carrinho e o Finalizar — e é o número do servidor que vai medir a
  liberação quando ela for gasta.
*/
const RECUSA_DA_VENDA = {
  status: 403,
  body: {
    error: {
      code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
      message: 'Esta venda concede R$ 2.500,00 sobre R$ 12.000,00 (20.83%).',
      details: {
        percentual: 20.83,
        concedidoCents: 250000,
        brutoCents: 1200000,
        origens: { cabecalho: 50000, itens: 0, precoRebaixado: 200000 },
        limite: 10,
      },
    },
  },
};

function servidorDoPdv() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo !== 'GET') registrar(alvo, metodo, init);

    if (alvo.includes('/core/authorizations') && metodo === 'POST') {
      return new Response(JSON.stringify(LIBERACAO), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // A venda é recusada SEMPRE nestes testes: o que se observa é o pedido de
    // liberação que a recusa provoca, e não o fechamento.
    if (alvo.includes('/core/sales') && metodo === 'POST') {
      return new Response(JSON.stringify(RECUSA_DA_VENDA.body), {
        status: RECUSA_DA_VENDA.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: [MOTO].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      /*
        O BALCÃO VENDE COM A GAVETA ABERTA — e o dublê tem que refletir isso.

        Estes testes dublavam `session: null`, e o PDV faturava assim mesmo:
        o dinheiro entrava sem gaveta e o fechamento do dia não tinha como
        bater. Agora a venda com caixa fechado é recusada no balcão, e um
        dublê sem sessão testaria uma loja que não existe.
      */
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/team') || alvo.includes('/core/units/search')) {
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
  enviados = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Põe a moto no carrinho pelo preço combinado, e tenta fechar a venda. */
async function venderMotoRebaixadaETentarFechar() {
  fireEvent.change(screen.getByLabelText('Preço Unitário'), { target: { value: '10000' } });
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: '7890000001111' } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar Rápido (F8)' }));
  // O diálogo do gestor abre por causa do 403.
  await screen.findByLabelText('Autorização do gestor');
}

/** O gestor digita a credencial no diálogo que estiver aberto. */
function gestorAssina() {
  fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'gerente' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));
}

describe('o PDV manda o valor da liberação como NÚMERO, e não só na frase', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', servidorDoPdv());
    render(
      <MemoryRouter>
        <PdvPage />
      </MemoryRouter>,
    );
  });

  it('os dois campos vão no corpo, com os nomes que o servidor lê', async () => {
    await venderMotoRebaixadaETentarFechar();
    gestorAssina();

    await waitFor(() => expect(corpoDaAutorizacao()).toBeTruthy());
    const corpo = corpoDaAutorizacao();

    /*
      O NOME É METADE DO RECURSO.

      `POST /core/authorizations` lê `req.body?.concedidoCents` e o repassa a
      `AuthorizationService` como `concessao.concedidoCents`. Um campo com
      qualquer outro nome atravessa o fio, é ignorado do outro lado, e a
      liberação nasce sem teto — em silêncio, com a tela parecendo consertada.
    */
    expect(corpo).toHaveProperty('concedidoCents');
    expect(corpo).toHaveProperty('brutoCents');
    expect(typeof corpo.concedidoCents).toBe('number');
    expect(typeof corpo.brutoCents).toBe('number');
  });

  it('os números são os da RECUSA do servidor, e não os da prévia da tela', async () => {
    await venderMotoRebaixadaETentarFechar();
    gestorAssina();

    await waitFor(() => expect(corpoDaAutorizacao()).toBeTruthy());
    const corpo = corpoDaAutorizacao();

    /*
      A prévia desta tela calcularia R$ 2.000 de concessão para este carrinho
      (moto de R$ 12.000 saindo por R$ 10.000). O servidor recusou dizendo
      R$ 2.500 — ele enxerga o desconto de rodapé que a tela não tem como ver.

      Mandar o número da prévia faria o gestor assinar 16,67% enquanto o
      servidor mede 20,83%: a liberação recusaria a PRÓPRIA venda que a
      motivou, e o balcão travaria num laço sem saída.
    */
    expect(corpo.concedidoCents).toBe(250000);
    expect(corpo.brutoCents).toBe(1200000);
    expect(corpo.concedidoCents).not.toBe(200000);
  });

  it('a frase CONTINUA — é o que a pessoa lê na tela de autorizações', async () => {
    await venderMotoRebaixadaETentarFechar();
    gestorAssina();

    await waitFor(() => expect(corpoDaAutorizacao()).toBeTruthy());
    const corpo = corpoDaAutorizacao();

    // Dois inteiros não contam a história: de onde veio a concessão, em que
    // venda, com que percentual. O número é para COMPARAR, o texto é para
    // CONFERIR, e trocar um pelo outro perde metade.
    expect(String(corpo.reason)).toContain('Concessão de');
    expect(String(corpo.reason)).toContain('20.83%');
    expect(String(corpo.reason)).toContain('de preço abaixo do vigente');
    expect(corpo.action).toBe('desconto_acima_limite');
  });
});

// --------------------------------------------------------- orçamento antigo

const ORCAMENTO_ANTIGO = {
  id: 'q-antigo',
  number: 41,
  kind: 'orcamento',
  status: 'aberto',
  customer_id: null,
  customer_name: null,
  total_cents: 1000000,
  discount_cents: 0,
  valid_until: '2026-12-31T23:59:59.000Z',
  converted_sale_id: null,
  created_at: '2025-03-01T12:00:00.000Z',
};

/*
  A recusa da APROVAÇÃO: o orçamento nasceu antes de a coluna
  `concession_cents` existir, então ninguém nunca conferiu aquele preço. É todo
  documento anterior à rodada da trava — a maioria do que está no balcão.
*/
const RECUSA_DA_APROVACAO = {
  status: 403,
  body: {
    error: {
      code: 'CORE_DISCOUNT_NEEDS_AUTHORIZATION',
      message:
        'Este orçamento concede R$ 2.000,00 sobre R$ 12.000,00 (16.67%), acima do limite '
        + 'de 10% desta operação.',
      details: {
        percentual: 16.67,
        concedidoCents: 200000,
        brutoCents: 1200000,
        origens: { cabecalho: 0, precoRebaixado: 200000 },
        limite: 10,
        kind: 'orcamento',
      },
    },
  },
};

/** Quantas vezes a promoção foi tentada, e com que corpo. */
function promocoes() {
  return enviados.filter((e) => e.url.includes('/promote') && e.metodo === 'POST');
}

function servidorDoOrcamento() {
  /** A primeira aprovação é recusada; a segunda (com liberação) passa. */
  let jaRecusou = false;
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo !== 'GET') registrar(alvo, metodo, init);

    if (alvo.includes('/promote') && metodo === 'POST') {
      const corpo = init?.body ? (JSON.parse(init.body) as { authorizationId?: string }) : {};
      /*
        O SERVIDOR SÓ ACEITA COM A LIBERAÇÃO — e este dublê é rigoroso de
        propósito. Aceitar o reenvio sem conferir o `authorizationId` deixaria
        o teste verde com a tela reenviando vazio, que é metade do beco.
      */
      if (!corpo.authorizationId) {
        jaRecusou = true;
        return new Response(JSON.stringify(RECUSA_DA_APROVACAO.body), {
          status: RECUSA_DA_APROVACAO.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect(jaRecusou).toBe(true);
      return new Response(
        JSON.stringify({
          ...ORCAMENTO_ANTIGO,
          id: 'pv-1',
          number: 88,
          kind: 'pre_venda',
          valid_until: '2026-08-25T23:59:59.000Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (alvo.includes('/core/authorizations') && metodo === 'POST') {
      return new Response(JSON.stringify(LIBERACAO), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/quotes')) {
      corpo = { items: [ORCAMENTO_ANTIGO] };
    } else if (alvo.includes('/core/customers')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/sale-policies')) {
      corpo = {
        discountLimitPercent: 10,
        creditSaleDueDays: 0,
        reservationValidDays: 7,
        cashWithdrawalLimitCents: null,
        definidos: {
          discountLimitPercent: false,
          creditSaleDueDays: false,
          reservationValidDays: false,
          cashWithdrawalLimitCents: false,
        },
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('aprovar orçamento antigo pede a liberação ALI, e reenvia com ela', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', servidorDoOrcamento());
    render(
      <MemoryRouter>
        <OrcamentosPage />
      </MemoryRouter>,
    );
  });

  it('a recusa de alçada abre o diálogo do gestor — e não uma faixa vermelha sem saída', async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));

    /*
      O BECO, em uma asserção.

      Antes disto a recusa virava "Falha ao aprovar" numa faixa vermelha, e a
      mensagem do servidor mandava pedir a liberação de um gestor sem que a
      tela tivesse onde digitá-la. O balcão lia "peça a liberação", olhava a
      tela, e não achava nada para clicar — em TODO orçamento anterior à
      rodada da trava, que é a maioria deles.
    */
    await screen.findByLabelText('Autorização do gestor');
    // E os números do 403 ficam à vista: o gestor não assina no escuro.
    expect(screen.getByText(/16\.67%/)).toBeTruthy();
    expect(screen.getByText(/limite 10%/)).toBeTruthy();
  });

  it('depois da senha, a aprovação é REENVIADA com o authorizationId', async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    await screen.findByLabelText('Autorização do gestor');
    gestorAssina();

    await waitFor(() => expect(promocoes().length).toBe(2));
    // A primeira tentativa foi sem liberação (é o que provocou o 403)...
    expect(promocoes()[0].corpo?.authorizationId).toBeUndefined();
    // ...e a segunda carrega a liberação que o gestor acabou de dar. Sem este
    // reenvio o diálogo seria teatro: pediria a senha e não usaria para nada.
    expect(promocoes()[1].corpo?.authorizationId).toBe('auth-1');

    // E o balcão vê a pré-venda criada, com a data até quando o estoque fica
    // reservado — o desfecho que o beco impedia.
    await screen.findByText(/pré-venda #88 criada/);
  });

  it('a liberação da aprovação também vai COM VALOR, pelos números do 403', async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    await screen.findByLabelText('Autorização do gestor');
    gestorAssina();

    await waitFor(() => expect(promocoes().length).toBe(2));
    const corpo = corpoDaAutorizacao();
    // Mesma regra do PDV, e é o mesmo componente pedindo: a liberação vale
    // ATÉ este valor, e não para qualquer um.
    expect(corpo.concedidoCents).toBe(200000);
    expect(corpo.brutoCents).toBe(1200000);
    expect(corpo.action).toBe('desconto_acima_limite');
    expect(String(corpo.reason)).toContain('orçamento #41');
  });
});
