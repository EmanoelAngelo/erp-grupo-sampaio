/**
 * A SANGRIA COM TETO, no modal do caixa (F3 do PDV).
 *
 * ## O que a tela tem de resolver, e por que cada parte importa
 *
 * A retirada da gaveta é a única operação deste modal com trava de alçada, e
 * uma trava só serve se for VISÍVEL ANTES. Descobrir o teto pela recusa — com o
 * valor já digitado e a mão no dinheiro — é a mesma experiência de descobrir o
 * limite de desconto no Finalizar, com o cliente na frente: o sistema sabia o
 * número o tempo todo e deixou a pessoa errar primeiro.
 *
 * Três coisas, e as três são cobradas aqui:
 *
 *   1. O TETO APARECE ANTES de o operador digitar. Ele vem junto da sessão em
 *      `GET /core/cash/open`, e não de `/core/sale-policies` — aquela exige
 *      gerente, e quem sangra é o caixa.
 *   2. ACIMA DO TETO, a liberação é pedida NO MESMO MODAL, e a sangria é
 *      reenviada com o `authorizationId`. Sem o reenvio o diálogo seria teatro.
 *   3. QUEM JÁ TEM ALÇADA NÃO VÊ PEDIDO NENHUM. O servidor deixa esses perfis
 *      passarem (`CashService.addMovement` só cobra de quem não tem alçada), e
 *      um pedido que nunca tem desfecho é ruído. Em loja pequena o gerente é
 *      quem fica no caixa, e a sangria existe para PROTEGER o dinheiro —
 *      travá-la para ele deixaria a gaveta cheia justamente quando alguém
 *      decidiu esvaziá-la por segurança.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - não passe `tetoSangriaCents` para o modal e o primeiro bloco cai;
 *   - mande a sangria direto sem pedir a senha e o segundo cai;
 *   - reenvie sem o `authorizationId` e ele cai igual;
 *   - tire o `useHasProfile` e o bloco do gerente cai — ele passa a ver um
 *     pedido de liberação que o servidor nunca vai exigir dele;
 *   - trate o 403 da sangria como erro genérico e o último cai: o operador
 *     volta a ler "não foi possível concluir" numa retirada que só precisava de
 *     uma assinatura.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { formatCents } from '../format';

const SESSAO = {
  id: 'cash-1',
  company_id: 'loja',
  terminal_id: null,
  opened_by: 'u-caixa',
  opening_cents: 20000,
  status: 'open',
  opened_at: '2026-08-18T08:00:00.000Z',
  closed_at: null,
  expected_cents: null,
  counted_cents: null,
  difference_cents: null,
};

/** Movimentos e autorizações que saíram no fio. */
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

function movimentos() {
  return enviados.filter((e) => e.url.includes('/movements') && e.metodo === 'POST');
}

function autorizacoes() {
  return enviados.filter((e) => e.url.includes('/core/authorizations') && e.metodo === 'POST');
}

/**
 * O servidor dublado.
 *
 * `recusarSemLiberacao` reproduz `CashService.addMovement`: a sangria acima do
 * teto só passa com `authorizationId`. Um dublê que aceitasse qualquer coisa
 * deixaria o teste verde com a tela reenviando vazio.
 */
function servidor(opcoes: { recusarSemLiberacao?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (metodo !== 'GET') enviados.push({ url: alvo, metodo, corpo });

      if (alvo.includes('/movements') && metodo === 'POST') {
        if (opcoes.recusarSemLiberacao && !corpo?.authorizationId) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'CORE_WITHDRAWAL_NEEDS_AUTHORIZATION',
                message:
                  'Sangria de R$ 800,00 passa do teto de R$ 500,00 desta operação. '
                  + 'Peça a liberação de um gestor ou retire um valor menor.',
                details: { tetoCents: 50000, pedidoCents: 80000 },
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ balance: 12000 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'auth-sangria-1',
            action: 'sangria_especial',
            authorizedBy: 'u-gerente',
            authorizedByName: 'Gerente',
            createdAt: '2026-08-18T12:00:00.000Z',
            grantedConcessionCents: 80000,
            grantedGrossCents: null,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (alvo.includes('/summary')) {
        return new Response(
          JSON.stringify({ session: SESSAO, expectedCents: 100000, byMethod: [], movements: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/**
 * Quem está no caixa.
 *
 * Passa pelo `setSession` DE VERDADE, e não por um `localStorage.setItem`
 * direto nem por um dublê de `useHasProfile`. Três razões, e a terceira é a que
 * fez o teste falhar antes:
 *
 *   - dublar o hook provaria que o componente chama uma função, e não que o
 *     perfil ativo chega até ele — que é justamente a ligação em teste;
 *   - `setSession` é o caminho que o app usa, com o guarda de escopo junto:
 *     uma sessão que ele recusasse é uma sessão que nunca existiria em
 *     produção;
 *   - escrever no `localStorage` sozinho não funciona depois do primeiro
 *     teste. `getSession` hidrata UMA vez por vida do módulo e guarda o
 *     resultado; com o módulo já hidratado (por este arquivo ou por outro), o
 *     que se escreve no armazenamento não é relido, e todo perfil chegaria
 *     como nulo.
 *
 * `LOGIN` é o motivo porque é literalmente isso: alguém entrou no caixa. É um
 * dos motivos que podem trocar de operação, então o guarda deixa passar.
 */
function entrarComo(profileCode: string) {
  setSession(
    {
      // Token sem escopo de empresa: o guarda só recusa quando o `companyId`
      // do token DIVERGE do exibido, e aqui não há um para divergir.
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da sangria',
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Pelo mesmo caminho da entrada: limpar só o `localStorage` deixaria a
  // sessão viva em memória, e o perfil de um teste vazaria para o seguinte —
  // o gerente do bloco de cima faria o operador do bloco de baixo passar sem
  // liberação, e o teste ficaria verde pelo motivo errado.
  setSession(null, 'LOGOUT', 'teste da sangria');
  localStorage.clear();
});

function montar(tetoSangriaCents: number | null) {
  render(
    <CaixaPdvDialog
      cash={SESSAO as never}
      tetoSangriaCents={tetoSangriaCents}
      vendasEmEspera={0}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
}

const campoValor = () => screen.getByLabelText('Valor') as HTMLInputElement;

/*
  A SANGRIA PASSOU A EXIGIR MOTIVO (H-caixa-seguranca-08): sem ele o botão fica
  desabilitado e o servidor recusa com CORE_CASH_REASON_REQUIRED. Estes testes
  são sobre o TETO, então o motivo é preenchido junto do valor — o caso sem
  motivo tem teste próprio em `caixaSeguranca.test.tsx`.
*/
function digitar(valorEmReais: string) {
  fireEvent.change(campoValor(), { target: { value: valorEmReais } });
  const motivo = screen.getByLabelText('Motivo (obrigatório na sangria)') as HTMLInputElement;
  if (motivo.value === '') fireEvent.change(motivo, { target: { value: 'depósito no banco' } });
}

/** O gestor digita a credencial no diálogo aberto por cima do modal. */
function gestorAssina() {
  fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'gerente' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));
}

describe('o teto aparece ANTES de o operador digitar', () => {
  it('o número está na tela assim que o caixa abre — não é preciso errar para saber', async () => {
    entrarComo('operador_caixa_loja');
    servidor();
    montar(50000);

    // `formatCents` e não a string literal: o pt-BR usa espaço NÃO separável
    // depois do "R$", e um teste escrito com espaço comum reprovaria a moeda
    // certa. O que se cobra é o que o balcão lê.
    const teto = await screen.findByTestId('caixa-teto-sangria');
    expect(teto.textContent).toContain(formatCents(50000));
    // E ele está na lista dos números da gaveta, do lado do esperado: aqui o
    // teto é FATO da operação, e não um alerta de que algo deu errado.
    expect(screen.getByText('Sangria sem chamar gestor')).toBeTruthy();
  });

  it('operação SEM teto não ganha linha nenhuma — informar a ausência de trava seria ruído', async () => {
    entrarComo('operador_caixa_loja');
    servidor();
    montar(null);

    await screen.findByTestId('caixa-esperado');
    expect(screen.queryByTestId('caixa-teto-sangria')).toBeNull();
    expect(screen.queryByText('Sangria sem chamar gestor')).toBeNull();
  });

  it('o aviso aparece com o valor digitado, enquanto ainda dá para mudá-lo', async () => {
    entrarComo('operador_caixa_loja');
    servidor();
    montar(50000);
    await screen.findByTestId('caixa-esperado');

    // Abaixo do teto: nada muda, e o botão continua sendo só "Sangria".
    digitar('300,00');
    expect(screen.queryByTestId('caixa-sangria-acima-do-teto')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sangria' })).toBeTruthy();

    digitar('800,00');
    const aviso = await screen.findByTestId('caixa-sangria-acima-do-teto');
    expect(aviso.textContent).toContain(formatCents(80000));
    expect(aviso.textContent).toContain(formatCents(50000));
    // O próprio botão passa a dizer o que vai acontecer: o operador decide
    // chamar o gerente ANTES de clicar, e não depois de uma recusa.
    expect(screen.getByRole('button', { name: 'Sangria (pede gestor)' })).toBeTruthy();
  });

  it('sangrar EXATAMENTE o teto não pede gestor — é o valor que o dono liberou', async () => {
    entrarComo('operador_caixa_loja');
    servidor();
    montar(50000);
    await screen.findByTestId('caixa-esperado');

    digitar('500,00');
    // Estritamente maior, como no servidor. Um `>=` aqui pediria liberação
    // para o número que está escrito na política.
    expect(screen.queryByTestId('caixa-sangria-acima-do-teto')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await waitFor(() => expect(movimentos().length).toBe(1));
    expect(movimentos()[0].corpo?.amountCents).toBe(50000);
    expect(movimentos()[0].corpo?.authorizationId).toBeUndefined();
  });
});

describe('acima do teto, a liberação é pedida NO MESMO modal', () => {
  beforeEach(async () => {
    entrarComo('operador_caixa_loja');
    servidor({ recusarSemLiberacao: true });
    montar(50000);
    await screen.findByTestId('caixa-esperado');
  });

  it('o clique abre o diálogo do gestor, e a sangria NÃO sai antes da senha', async () => {
    digitar('800,00');
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));

    const dialogo = await screen.findByLabelText('Autorização do gestor');
    // Nenhum movimento saiu ainda: a tela já sabia que seria recusado, e
    // gastar a viagem só para ouvir "não" deixaria o operador esperando à toa.
    expect(movimentos().length).toBe(0);
    /*
      E o gestor lê o que está assinando ANTES de digitar — dentro do diálogo,
      e não numa faixa atrás dele. A busca é escopada ao diálogo de propósito:
      o aviso do modal também diz "Sangria de", e uma busca global passaria
      verde só porque o texto existe em algum lugar da tela. O que importa é
      que ele esteja onde o gestor está olhando.
    */
    expect(dialogo.textContent).toContain('Sangria de');
    expect(dialogo.textContent).toContain(formatCents(80000));
    expect(dialogo.textContent).toContain('ninguém autoriza a própria retirada');
  });

  it('depois da senha, a sangria é reenviada COM o authorizationId', async () => {
    digitar('800,00');
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));
    await screen.findByLabelText('Autorização do gestor');
    gestorAssina();

    await waitFor(() => expect(movimentos().length).toBe(1));
    expect(movimentos()[0].corpo?.movementType).toBe('withdrawal');
    expect(movimentos()[0].corpo?.amountCents).toBe(80000);
    // Sem esta linha o diálogo seria teatro: pediria a senha e mandaria a
    // mesma requisição que já tinha sido recusada.
    expect(movimentos()[0].corpo?.authorizationId).toBe('auth-sangria-1');
  });

  it('a liberação vai com o VALOR, e sem bruto — o teto da gaveta é absoluto', async () => {
    digitar('800,00');
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));
    await screen.findByLabelText('Autorização do gestor');
    gestorAssina();

    await waitFor(() => expect(autorizacoes().length).toBe(1));
    const corpo = autorizacoes()[0].corpo!;
    expect(corpo.action).toBe('sangria_especial');
    // Vale ATÉ este valor: autorizar R$ 800 e reenviar R$ 3.000 é recusado.
    expect(corpo.concedidoCents).toBe(80000);
    /*
      `brutoCents` FICA DE FORA de propósito.

      R$ 800 de sangria são R$ 800 — não é uma fatia de coisa nenhuma.
      Declarar um bruto aqui inventaria um denominador, e o servidor passaria a
      comparar um percentual que ninguém decidiu. É a mesma escolha que
      `CashService` faz do outro lado.
    */
    expect(corpo.brutoCents).toBeUndefined();
    // O motivo diz o teto que foi passado: é o que fica na tela de
    // autorizações para quem for ler depois.
    expect(String(corpo.reason)).toContain('acima do teto');
  });

  it('o valor é congelado no clique — o teclado do operador não muda o que foi assinado', async () => {
    digitar('800,00');
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));
    await screen.findByLabelText('Autorização do gestor');

    /*
      Entre pedir a senha e reenviar, o operador ainda tem o teclado na mão.
      Sem o congelamento, o gestor autorizaria R$ 800 e o movimento sairia com
      o que estivesse no campo na hora do reenvio — o mesmo contorno que a
      liberação sem teto abria no PDV, só que num modal só.
    */
    digitar('3.000,00');
    gestorAssina();

    await waitFor(() => expect(movimentos().length).toBe(1));
    expect(movimentos()[0].corpo?.amountCents).toBe(80000);
    expect(autorizacoes()[0].corpo?.concedidoCents).toBe(80000);
  });

  it('cancelar o diálogo não sangra nada', async () => {
    digitar('800,00');
    fireEvent.click(screen.getByRole('button', { name: 'Sangria (pede gestor)' }));
    await screen.findByLabelText('Autorização do gestor');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByLabelText('Autorização do gestor')).toBeNull());
    expect(movimentos().length).toBe(0);
    expect(autorizacoes().length).toBe(0);
  });
});

describe('quem já tem alçada não vê pedido de liberação nenhum', () => {
  for (const perfil of ['gerente_loja', 'gerente_oficina', 'gestor', 'admin_geral']) {
    it(`${perfil} sangra acima do teto sem que a tela peça senha a ninguém`, async () => {
      entrarComo(perfil);
      servidor();
      montar(50000);
      await screen.findByTestId('caixa-esperado');

      digitar('800,00');
      // Nem o aviso de "vai pedir gestor", nem o rótulo mudado no botão.
      expect(screen.queryByTestId('caixa-sangria-acima-do-teto')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Sangria (pede gestor)' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));

      await waitFor(() => expect(movimentos().length).toBe(1));
      // Vai direto, sem liberação: o servidor deixa esses perfis passarem, e
      // pedir a senha de um SEGUNDO gestor seria um pedido sem desfecho.
      expect(screen.queryByLabelText('Autorização do gestor')).toBeNull();
      expect(autorizacoes().length).toBe(0);
      expect(movimentos()[0].corpo?.amountCents).toBe(80000);
    });
  }

  it('mas a tela diz que ele passou por cima do teto — a trava não sumiu, é que não é sobre ele', async () => {
    entrarComo('gerente_loja');
    servidor();
    montar(50000);
    await screen.findByTestId('caixa-esperado');

    digitar('800,00');
    const nota = await screen.findByTestId('caixa-sangria-alcada-propria');
    expect(nota.textContent).toContain(formatCents(50000));
    // O movimento fica gravado no nome dele, e a conferência do fechamento
    // compara esperado e contado do mesmo jeito.
    expect(nota.textContent).toContain('gravada no seu nome');
  });
});

describe('a recusa do servidor também abre o pedido', () => {
  it('403 de sangria vira pedido de senha, e não "não foi possível concluir"', async () => {
    entrarComo('operador_caixa_loja');
    servidor({ recusarSemLiberacao: true });
    /*
      O TETO DA TELA ESTÁ DESATUALIZADO de propósito: o modal recebeu `null`
      (a operação não tinha trava quando o PDV abriu), e o dono apertou a
      política no meio do turno. Um turno de balcão dura o dia inteiro.

      Quem sabe o número certo nessa hora é o servidor, e ele manda os dois
      valores em `details`. Sem este caminho o operador leria um erro genérico
      numa retirada que só precisava de uma assinatura.
    */
    montar(null);
    await screen.findByTestId('caixa-esperado');

    digitar('800,00');
    // A tela não sabia do teto, então mandou direto.
    fireEvent.click(screen.getByRole('button', { name: 'Sangria' }));
    await waitFor(() => expect(movimentos().length).toBe(1));

    // E a recusa abre o diálogo, com a mensagem e os números DELE.
    await screen.findByLabelText('Autorização do gestor');
    expect(screen.getByText(/passa do teto/)).toBeTruthy();

    gestorAssina();
    await waitFor(() => expect(movimentos().length).toBe(2));
    expect(movimentos()[1].corpo?.authorizationId).toBe('auth-sangria-1');
  });
});
