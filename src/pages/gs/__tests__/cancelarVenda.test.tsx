/**
 * O BOTÃO DE CANCELAR VENDA, que o menu prometia há rodadas.
 *
 * ## A dívida que estes testes fecham
 *
 * O item de menu diz "Devolver não altera a venda; cancelar desfaz" e aponta
 * para esta tela. A rota `POST /core/sales/:id/cancel` existia, `cancelSale`
 * estornava estoque, comissão e fidelidade, `coreApi.cancelSale` estava escrito
 * — e NENHUMA tela chamava. Promessa de menu que o sistema não cumpre é pior
 * que ausência: quem lia acreditava que a saída existia, e no balcão acabava
 * devolvendo a venda inteira, que é outro fato e deixa a receita no mês.
 *
 * ## As duas coisas que não podem errar
 *
 * 1. QUEM VÊ O BOTÃO — e a resposta MUDOU na rodada da liberação pontual
 *    (GAP-V60). A rota do roteador é `ROTA_GESTAO`, que abre o escritório
 *    inteiro: admin_geral, gestor, gerente_loja, gerente_oficina, estoquista e
 *    atendente. O servidor deixa `gerente_loja` (com admin_geral e gestor por
 *    cima) cancelar DIRETO.
 *
 *    Antes, os outros três não viam o botão, e a razão era boa: desenhá-lo
 *    faria o estoquista ler a confirmação inteira sobre estorno de estoque e
 *    comissão, confirmar, e só então descobrir que não podia — numa ação
 *    irreversível, na hora exata em que a pessoa se compromete.
 *
 *    Agora ELE PODE, com a credencial de um gestor digitada ali mesmo. Esconder
 *    o botão passou a ser o defeito simétrico: a tela negaria uma saída que o
 *    servidor oferece, e o balcão voltaria a devolver a venda inteira (outro
 *    fato) ou a pedir a senha emprestada (nenhum rastro). O cuidado antigo não
 *    se perdeu — ele virou o aviso DENTRO da confirmação, lido ANTES do clique.
 *
 * 2. O QUE A CONFIRMAÇÃO DIZ. Esta tela JÁ trata devolução, e as duas ações se
 *    parecem nela e são opostas no livro. "Tem certeza?" não distingue as duas.
 *    Os três estornos estão escritos um a um porque cada um surpreende alguém:
 *    o estoque surpreende quem já separou a mercadoria para outro cliente; a
 *    comissão surpreende o vendedor, que vê o mês cair; a fidelidade surpreende
 *    o cliente, que perde pontos que já apareciam para ele.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - mostre o botão para todo mundo e o bloco de perfis cai;
 *   - troque a confirmação por um "tem certeza?" e o bloco do texto cai;
 *   - dispare o cancelamento no clique do botão, sem confirmar, e o teste do
 *     "não cancela antes de confirmar" cai — que é o que separa um botão de uma
 *     armadilha numa ação sem volta.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: null,
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 1200000,
  discount_cents: 0,
  total_cents: 1200000,
  change_cents: 0,
  status: 'closed',
  note: null,
  created_at: '2026-08-18T10:00:00.000Z',
};

let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

function cancelamentos() {
  return enviados.filter((e) => e.url.includes('/cancel') && e.metodo === 'POST');
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') {
        enviados.push({
          url: alvo,
          metodo,
          corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        });
      }

      if (alvo.includes('/cancel') && metodo === 'POST') {
        return new Response(JSON.stringify({ ...VENDA, status: 'cancelled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      /*
        `/core/sale-returns` (histórico) e `/core/sales` (vendas) são rotas
        diferentes e parecidas, e a ordem aqui importa: o histórico é conferido
        PRIMEIRO porque "sale-returns" não contém "sales" — casar na ordem
        inversa devolveria a lista de vendas para o histórico de devoluções.
      */
      let corpo: unknown = { items: [] };
      if (alvo.includes('/core/sale-returns')) {
        corpo = { items: [] };
      } else if (alvo.includes('/core/sales')) {
        corpo = { items: [VENDA] };
      }
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

/** Ver a nota longa em `sangriaComTeto.test.tsx`: a sessão entra pelo app. */
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
    'teste de cancelamento',
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de cancelamento');
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

const botaoCancelar = () => screen.queryByRole('button', { name: 'Cancelar venda' });

describe('quem vê o botão é quem o servidor deixa cancelar', () => {
  for (const perfil of ['gerente_loja', 'gestor', 'admin_geral']) {
    it(`${perfil} vê o botão ao lado do de devolver`, async () => {
      entrarComo(perfil);
      montar();

      await screen.findByText('#42');
      expect(botaoCancelar()).toBeTruthy();
      // Os dois lado a lado, na mesma linha da mesma venda: é aí que a escolha
      // acontece, com o cliente na frente.
      expect(screen.getByRole('button', { name: 'Devolver desta' })).toBeTruthy();
    });
  }

  for (const perfil of ['estoquista', 'atendente', 'gerente_oficina']) {
    it(`${perfil} vê o botão E é avisado de que um gestor vai assinar`, async () => {
      entrarComo(perfil);
      montar();

      await screen.findByText('#42');
      /*
        O BOTÃO APARECE porque o caminho existe. Escondê-lo agora seria a tela
        negando uma saída que o servidor oferece — e quem opera resolveria como
        resolvia antes: devolvendo a venda inteira, que é outro fato, ou
        pedindo a senha do gerente emprestada, que não deixa rastro nenhum.
      */
      expect(botaoCancelar()).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Devolver desta' })).toBeTruthy();
      // E a condição está escrita na tela, antes de qualquer clique.
      expect(screen.getByText(/liberação de um gestor/)).toBeTruthy();

      /*
        O CUIDADO ANTIGO, NO LUGAR NOVO: quem não cancela sozinho lê dentro da
        confirmação que a credencial de um gestor será pedida — antes de se
        comprometer, que era o ponto do desenho anterior.
      */
      fireEvent.click(botaoCancelar()!);
      const dialogo = await screen.findByTestId('confirmar-cancelamento');
      expect(screen.getByTestId('aviso-de-gestor').textContent).toContain('uma vez só');
      expect(dialogo.textContent).toContain('credencial');
    });
  }

  it('o gerente NÃO lê o aviso de gestor — ele não pede liberação a ninguém', async () => {
    /*
      A outra metade, e ela decide se a rodada foi ganho ou armadilha: exigir
      liberação também de quem tem alçada seria o argumento que tirou
      `cancelar_venda` da lista de ações restritas — ninguém autoriza a própria
      ação, e o gerente teria de chamar um segundo gerente para cancelar.
    */
    entrarComo('gerente_loja');
    montar();
    await screen.findByText('#42');
    fireEvent.click(botaoCancelar()!);
    await screen.findByTestId('confirmar-cancelamento');
    expect(screen.queryByTestId('aviso-de-gestor')).toBeNull();
  });
});

describe('a confirmação diz o que o cancelamento DESFAZ', () => {
  beforeEach(async () => {
    entrarComo('gerente_loja');
    montar();
    await screen.findByText('#42');
    fireEvent.click(botaoCancelar()!);
    await screen.findByTestId('confirmar-cancelamento');
  });

  it('nomeia os três estornos, um a um', () => {
    const dialogo = screen.getByTestId('confirmar-cancelamento');
    /*
      O CORAÇÃO DESTE BLOCO.

      Numa tela que já trata devolução, "tem certeza?" não distingue as duas
      ações. Cada um destes três surpreende alguém diferente, e uma confirmação
      genérica transfere as três surpresas para depois do clique.
    */
    expect(dialogo.textContent).toContain('Estoque');
    expect(dialogo.textContent).toContain('Comissão');
    expect(dialogo.textContent).toContain('Fidelidade');
  });

  it('diz que NÃO é devolução, e que não tem volta', () => {
    const dialogo = screen.getByTestId('confirmar-cancelamento');
    // A distinção que a tela inteira existe para manter: devolver reconhece a
    // venda, cancelar a apaga do faturamento.
    expect(dialogo.textContent).toContain('Cancelar não é devolver');
    expect(dialogo.textContent).toContain('Não há como desfazer o cancelamento');
    // E o número da venda está no título e no botão: numa lista de vendas
    // parecidas, confirmar a errada é o erro fácil de cometer.
    expect(dialogo.textContent).toContain('#42');
  });

  it('não cancela nada antes de a pessoa confirmar', () => {
    // Abrir a confirmação não é confirmar. Sem esta separação o botão da lista
    // seria uma armadilha: um clique e a venda some.
    expect(cancelamentos().length).toBe(0);
  });

  it('voltar fecha o diálogo sem cancelar', async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByTestId('confirmar-cancelamento')).toBeNull());
    expect(cancelamentos().length).toBe(0);
  });
});

describe('confirmado, o cancelamento vai — com o motivo junto', () => {
  it('chama a rota da venda certa e conta o que foi desfeito', async () => {
    entrarComo('gerente_loja');
    montar();
    await screen.findByText('#42');
    fireEvent.click(botaoCancelar()!);
    await screen.findByTestId('confirmar-cancelamento');

    fireEvent.change(screen.getByLabelText('Motivo'), {
      target: { value: 'cliente desistiu no balcão' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));

    await waitFor(() => expect(cancelamentos().length).toBe(1));
    expect(cancelamentos()[0].url).toContain('/core/sales/s-1/cancel');
    // O motivo entra na auditoria e no movimento de estoque: é o que responde
    // "por que esta venda sumiu?" meses depois.
    expect(cancelamentos()[0].corpo?.reason).toBe('cliente desistiu no balcão');

    // E o aviso repete os três estornos, para quem não leu a confirmação.
    await screen.findByText(/O estoque voltou, a comissão foi estornada/);
  });

  it('sem motivo o botão não confirma — o servidor passou a exigir o motivo', async () => {
    /*
      O COMPORTAMENTO MUDOU (E-venda-servidor-M01). Este teste provava que o
      motivo em branco ia AUSENTE no fio, porque o servidor o aceitava
      opcional. O cancelamento tira dinheiro da gaveta e desfaz estoque,
      comissão e fidelidade, e a devolução — que mexe em menos coisa — já
      exigia três letras; o servidor agora recusa sem motivo
      (CORE_CANCEL_REASON_REQUIRED), e a tela não deixa confirmar sem ele, em
      vez de mandar um pedido que vai ser recusado.
    */
    entrarComo('gerente_loja');
    montar();
    await screen.findByText('#42');
    fireEvent.click(botaoCancelar()!);
    await screen.findByTestId('confirmar-cancelamento');

    const confirmar = () =>
      screen.getByRole('button', { name: /Cancelar a venda #42/ }) as HTMLButtonElement;
    expect(confirmar().disabled).toBe(true);
    fireEvent.click(confirmar());

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  ab ' } });
    expect(confirmar().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'cliente desistiu' } });
    expect(confirmar().disabled).toBe(false);
    expect(cancelamentos().length).toBe(0);
  });
});

/* ========================================================================== */
/* A LIBERAÇÃO PONTUAL (GAP-V60), pelo caminho que o operador percorre         */
/* ========================================================================== */

/**
 * O servidor que recusa a PRIMEIRA vez e aceita com o bilhete.
 *
 * É a única forma honesta de medir este fluxo: o 403 nomeado não é uma
 * condição que a tela calcula, é uma RESPOSTA. Uma tela que decidisse sozinha
 * "este perfil precisa de gestor" duplicaria a regra do servidor e divergiria
 * dela no dia em que a lista de perfis mudasse — que é o defeito que
 * `o-menu-nao-promete` existe para caçar.
 */
function servidorQuePedeGestor(opcoes: { senhaAceita?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (metodo !== 'GET') enviados.push({ url: alvo, metodo, corpo });

      const json = (dado: unknown, status = 200) =>
        new Response(JSON.stringify(dado), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        if (opcoes.senhaAceita === false) {
          return json(
            { error: { code: 'CORE_AUTHORIZATION_DENIED', message: 'Credencial não autorizada.' } },
            403,
          );
        }
        return json({ id: 'lib-1', action: 'cancelar_venda', authorizedByName: 'Gerente' }, 201);
      }

      if (alvo.includes('/cancel') && metodo === 'POST') {
        if (!corpo?.authorizationId) {
          return json(
            {
              error: {
                code: 'CORE_CANCEL_NEEDS_AUTHORIZATION',
                message: 'Peça a liberação de um gestor para esta venda.',
                details: { action: 'cancelar_venda', referenceId: 's-1' },
              },
            },
            403,
          );
        }
        return json({ ...VENDA, status: 'cancelled' });
      }

      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

describe('o 403 nomeado vira o diálogo do gestor, e a ação SEGUE', () => {
  async function chegarNoDialogoDeGestor() {
    entrarComo('estoquista');
    montar();
    await screen.findByText('#42');
    fireEvent.click(botaoCancelar()!);
    await screen.findByTestId('confirmar-cancelamento');
    fireEvent.change(screen.getByLabelText('Motivo'), {
      target: { value: 'erro de digitação' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));
    return screen.findByRole('dialog', { name: 'Autorização do gestor' });
  }

  it('a primeira recusa abre a caixa da credencial em vez de uma faixa vermelha', async () => {
    servidorQuePedeGestor();
    await chegarNoDialogoDeGestor();

    // O que o gestor lê antes de digitar: QUAL venda e QUANTO.
    expect(screen.getByText(/Cancelamento da venda #42/)).toBeTruthy();
    // E nada foi cancelado ainda — a recusa é o começo do caminho, não o fim.
    expect(cancelamentos().filter((c) => c.corpo?.authorizationId).length).toBe(0);
  });

  it('com a credencial aceita, a MESMA venda é cancelada com o bilhete', async () => {
    servidorQuePedeGestor();
    await chegarNoDialogoDeGestor();

    fireEvent.change(screen.getByLabelText('Usuário do gestor'), {
      target: { value: 'gerente.loja' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-do-gestor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    // O pedido de liberação leva a AÇÃO e o ALVO — sem o alvo, o servidor
    // recusa, e um "sim" sem alvo valeria para qualquer venda.
    await waitFor(() => {
      const pedido = enviados.find((e) => e.url.includes('/core/authorizations'));
      expect(pedido?.corpo?.action).toBe('cancelar_venda');
      expect(pedido?.corpo?.referenceId).toBe('s-1');
    });

    /*
      E A AÇÃO SEGUE SOZINHA. Se a tela só guardasse o id e esperasse um segundo
      clique, o operador teria de repetir tudo com o cliente na frente — e o
      bilhete vence em quinze minutos.
    */
    await waitFor(() => {
      const comBilhete = cancelamentos().filter((c) => c.corpo?.authorizationId === 'lib-1');
      expect(comBilhete.length).toBe(1);
      // O motivo digitado antes da liberação não se perdeu no caminho.
      expect(comBilhete[0].corpo?.reason).toBe('erro de digitação');
    });
    await screen.findByText(/O estoque voltou, a comissão foi estornada/);
  });

  it('senha errada fica NO DIÁLOGO, e a venda não é cancelada', async () => {
    servidorQuePedeGestor({ senhaAceita: false });
    await chegarNoDialogoDeGestor();

    fireEvent.change(screen.getByLabelText('Usuário do gestor'), {
      target: { value: 'gerente.loja' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'chute' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    // O erro aparece onde a pessoa está olhando — e o diálogo continua aberto,
    // porque a correção é digitar de novo, não recomeçar a operação.
    await screen.findByText('Credencial não autorizada.');
    expect(screen.queryByRole('dialog', { name: 'Autorização do gestor' })).toBeTruthy();
    expect(cancelamentos().filter((c) => c.corpo?.authorizationId).length).toBe(0);
  });
});
