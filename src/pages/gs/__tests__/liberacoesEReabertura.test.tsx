/**
 * ============================================================================
 * AS DUAS TELAS QUE FALTAVAM — liberações de gestor e reabertura de turno
 * ============================================================================
 *
 * ## O que cada bloco fecha
 *
 * 1. `GET /core/authorizations` ERA ÓRFÃ (GAP-V62). Existia desde a primeira
 *    rodada da alçada e nenhuma tela a chamava: cada senha de gerente digitada
 *    no balcão virava linha no banco e o dono só a alcançava abrindo o SQLite.
 *    A seção "Liberações de gestor" da Auditoria é o leitor.
 *
 * 2. REABRIR O TURNO NÃO TINHA BOTÃO (GAP-V64). A rota nasceu nesta rodada, e
 *    rota sem tela é exatamente a dívida do item 1 recomeçando.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire a seção da Auditoria e o bloco 1 inteiro fica vermelho: a rota volta
 *     a ser uma consulta que ninguém faz;
 *   - mostre só `authorized_by_name` e o caso dos DOIS nomes cai — é ele que
 *     garante que a lista responde "quem PEDIU", que é o padrão que ela existe
 *     para revelar;
 *   - ofereça "Reabrir turno" em toda linha fechada e o caso do turno antigo
 *     fica vermelho; o servidor recusaria com 409, mas o operador teria clicado;
 *   - ignore o dia da loja na condição do botão e o turno de ontem volta a
 *     oferecer reabertura.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import AuditoriaPage from '../AuditoriaPage';
import { CaixaPage } from '../OperacaoPages';

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'dono', displayName: 'Dona do Grupo', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste de liberações e reabertura',
  );
}

let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[] = [];

beforeEach(() => {
  enviados = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de liberações e reabertura');
  localStorage.clear();
});

/* ========================================================================== */
/* BLOCO 1 — LIBERAÇÕES DE GESTOR NA AUDITORIA (GAP-V62)                      */
/* ========================================================================== */

/** Uma liberação como a rota a devolve: a linha crua, com os DOIS nomes. */
const LIBERACAO = {
  id: 'lib-1',
  action: 'cancelar_venda',
  requested_by: 'u-estoque',
  requested_by_name: 'Estela Estoque',
  authorized_by: 'u-gerente',
  authorized_by_name: 'Gerente Gilda',
  reason: 'erro de digitação na venda #42',
  reference_id: 'venda-42',
  granted_concession_cents: null,
  consumed_ref_type: 'sale',
  consumed_ref_id: 'venda-42',
  consumed_at: '2026-08-28T14:05:00.000Z',
  terminal_id: 'term-1',
  ip: '192.168.0.31',
  created_at: '2026-08-28T14:00:00.000Z',
};

const NAO_USADA = {
  ...LIBERACAO,
  id: 'lib-2',
  action: 'desconto_acima_limite',
  reference_id: null,
  consumed_ref_type: null,
  consumed_ref_id: null,
  consumed_at: null,
  terminal_id: null,
  ip: '10.0.0.9',
  reason: 'concessão de R$ 340,00 sobre R$ 1.200,00',
};

function servidorDaAuditoria(opcoes: { liberacoes?: unknown[]; erroNasLiberacoes?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);
      const json = (dado: unknown, status = 200) =>
        new Response(JSON.stringify(dado), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/authorizations')) {
        if (opcoes.erroNasLiberacoes) {
          return json({ error: { code: 'API_UNAVAILABLE', message: 'Serviço indisponível.' } }, 500);
        }
        return json({ items: opcoes.liberacoes ?? [LIBERACAO, NAO_USADA] });
      }

      if (alvo.includes('/core/audit')) {
        return json({
          items: [
            {
              id: 'a-1',
              company_id: 'loja',
              user_id: 'u-1',
              user_name: 'Dona do Grupo',
              action: 'sale.cancel',
              entity_type: 'sale',
              entity_id: 'venda-42',
              detail: '{"requestingUserId":"u-estoque","authorizingUserId":"u-gerente"}',
              created_at: '2026-08-28T14:05:00.000Z',
            },
          ],
          total: 1,
          actions: ['sale.cancel'],
        });
      }

      return json({ items: [] });
    }),
  );
}

function montarAuditoria() {
  render(
    <MemoryRouter>
      <AuditoriaPage />
    </MemoryRouter>,
  );
}

describe('a rota órfã das liberações ganhou leitor', () => {
  it('a tela PEDE a rota — antes desta rodada nenhuma tela pedia', async () => {
    entrarComo('admin_geral');
    servidorDaAuditoria();
    montarAuditoria();

    await screen.findByText('Liberações de gestor');
    const chamada = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/core/authorizations'));
    expect(chamada, 'a seção não chamou GET /core/authorizations').toBeTruthy();
  });

  it('mostra os DOIS nomes: quem pediu e quem assinou', async () => {
    entrarComo('admin_geral');
    servidorDaAuditoria();
    montarAuditoria();

    /*
      `authorized_by_name` sozinho conta metade. A pergunta que esta lista
      responde melhor é "quem PEDIU" — "o caixa novo pediu seis liberações esta
      semana" é um padrão que não se lê num uuid.
    */
    await screen.findAllByText('Estela Estoque');
    expect(screen.getAllByText(/liberado por Gerente Gilda/).length).toBeGreaterThan(0);
  });

  it('mostra a ação, o recurso e ONDE a senha foi digitada', async () => {
    entrarComo('admin_geral');
    servidorDaAuditoria();
    montarAuditoria();

    await screen.findByText('cancelar_venda');
    // `venda-42` aparece também na trilha de auditoria ao lado — o que se mede
    // aqui é que a seção das liberações o mostra, não que ele seja único na tela.
    expect(screen.getAllByText('venda-42').length).toBeGreaterThan(0);
    // As duas colunas que só existem porque o IP deixou de ser descartado.
    expect(screen.getByText('term-1')).toBeTruthy();
    expect(screen.getByText('192.168.0.31')).toBeTruthy();
    // A liberação sem terminal diz isso com todas as letras, em vez de vazio.
    expect(screen.getByText('sem terminal')).toBeTruthy();
  });

  it('separa a liberação USADA da que ficou por usar', async () => {
    /*
      A liberação é um bilhete de uma viagem só, e a que nunca foi gasta é uma
      senha de gerente que foi digitada e não virou nada. Várias seguidas são um
      padrão que alguém precisa olhar — e sem esta coluna elas se parecem.
    */
    entrarComo('admin_geral');
    servidorDaAuditoria();
    montarAuditoria();

    await screen.findByText('usada');
    expect(screen.getByText('não usada')).toBeTruthy();
  });

  it('a liberação de DINHEIRO não finge ter recurso', async () => {
    entrarComo('admin_geral');
    servidorDaAuditoria({ liberacoes: [NAO_USADA] });
    montarAuditoria();

    await screen.findByText('desconto_acima_limite');
    // O que prende a liberação de desconto é o VALOR, não um alvo: inventar um
    // id aqui faria parecer que faltou preencher a coluna.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('erro nas liberações NÃO derruba a trilha de auditoria', async () => {
    /*
      Duas consultas independentes de propósito. Se a lista de liberações
      falhasse junto com a trilha, um erro na seção nova apagaria a tela que já
      funcionava — e quem investiga perderia as duas respostas de uma vez.
    */
    entrarComo('admin_geral');
    servidorDaAuditoria({ erroNasLiberacoes: true });
    montarAuditoria();

    await screen.findByText('Serviço indisponível.');
    // A trilha continua na tela: `sale.cancel` aparece no seletor de ações e na
    // linha, e as duas presenças provam o mesmo — a página não caiu junto.
    expect(screen.getAllByText('sale.cancel').length).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* BLOCO 2 — O BOTÃO DE REABRIR O TURNO (GAP-V64)                             */
/* ========================================================================== */

/**
 * O relógio da tela é fixado, e o dos turnos é montado a partir dele.
 *
 * "Hoje" é o dia DA LOJA, e a condição do botão o compara com o fechamento.
 * Sem fixar o relógio, o teste passaria de dia às 21h — que é exatamente o
 * defeito de fuso que a condição existe para não cometer.
 */
const AGORA = new Date('2026-08-28T18:00:00.000Z');

function turnoFechado(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: 's-hoje',
    opening_cents: 10_000,
    expected_cents: 52_000,
    counted_cents: 48_000,
    difference_cents: -4_000,
    status: 'closed',
    opened_at: '2026-08-28T11:00:00.000Z',
    closed_at: '2026-08-28T17:30:00.000Z',
    opened_by_name: 'Carlos Caixa',
    closed_by_name: 'Gerente Gilda',
    reopen_count: 0,
    ...sobrescreve,
  };
}

const DE_ONTEM = turnoFechado({
  id: 's-ontem',
  opened_at: '2026-08-27T11:00:00.000Z',
  closed_at: '2026-08-27T21:30:00.000Z',
});

function servidorDoCaixa(opcoes: {
  turnos: Record<string, unknown>[];
  caixaAberto?: boolean;
  erroAoReabrir?: { code: string; message: string };
  /*
    O SERVIDOR QUE PEDE GESTOR — o ramo que a tela do Caixa não sabia atender.

    `CashService.reopenSession` reabre direto para quem tem alçada e, para quem
    não tem, exige o bilhete: sem `authorizationId` ele responde 403
    `CORE_REOPEN_NEEDS_AUTHORIZATION`; com o bilhete, reabre. Este mock repete
    exatamente esse par, porque é dele que a metade de tela depende.
  */
  exigeLiberacao?: boolean;
}) {
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
      const json = (dado: unknown, status = 200) =>
        new Response(JSON.stringify(dado), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/authorizations') && metodo === 'POST') {
        return json({
          id: 'lib-reabertura',
          action: 'reabrir_caixa',
          authorizedBy: 'u-gerente',
          authorizedByName: 'Gerente Gilda',
          createdAt: '2026-08-28T17:59:00.000Z',
          grantedConcessionCents: null,
          grantedGrossCents: null,
          referenceId: 's-hoje',
          terminalId: null,
          ip: null,
          expiresAt: '2026-08-28T18:14:00.000Z',
        });
      }

      if (alvo.includes('/reopen')) {
        if (opcoes.erroAoReabrir) return json({ error: opcoes.erroAoReabrir }, 409);
        const corpo = init?.body
          ? (JSON.parse(init.body) as { authorizationId?: string })
          : {};
        if (opcoes.exigeLiberacao && !corpo.authorizationId) {
          return json(
            {
              error: {
                code: 'CORE_REOPEN_NEEDS_AUTHORIZATION',
                message:
                  'Reabrir um turno de caixa é decisão de quem responde pela operação. '
                  + 'Peça a liberação de um gestor para este turno.',
                details: { sessionId: 's-hoje', action: 'reabrir_caixa' },
              },
            },
            403,
          );
        }
        return json({ ...opcoes.turnos[0], status: 'open', reopen_count: 1 });
      }
      if (alvo.includes('/core/cash/sessions')) return json({ items: opcoes.turnos });
      if (alvo.includes('/core/cash/open')) {
        return json({
          session: opcoes.caixaAberto ? { id: 's-nova', opening_cents: 0 } : null,
          cashWithdrawalLimitCents: null,
        });
      }
      if (alvo.includes('/summary')) return json({ expectedCents: 0 });
      return json({ items: [] });
    }),
  );
}

function montarCaixa() {
  render(
    <MemoryRouter>
      <CaixaPage />
    </MemoryRouter>,
  );
}

const botaoReabrir = () => screen.queryByRole('button', { name: 'Reabrir turno' });

describe('o turno reabre pela tela — e só onde o servidor deixaria', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(AGORA);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('o ÚLTIMO turno fechado HOJE oferece a reabertura', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [turnoFechado()] });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    expect(botaoReabrir()).toBeTruthy();
    // E o motivo é pedido ANTES: "por que este turno foi reaberto?" é a
    // pergunta que alguém faz um mês depois.
    expect(screen.getByLabelText('Motivo da reabertura')).toBeTruthy();
  });

  it('o turno de ONTEM não oferece — a reabertura vale só no dia da loja', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [DE_ONTEM] });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    /*
      O servidor recusaria com `CORE_CASH_REOPEN_TOO_LATE`, e o botão existiria
      só para tomar 409. Não é validação duplicada: é não convidar ao clique.
    */
    expect(botaoReabrir()).toBeNull();
    expect(screen.queryByLabelText('Motivo da reabertura')).toBeNull();
  });

  it('o turno ANTERIOR ao último não oferece, mesmo fechado hoje', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({
      turnos: [turnoFechado(), turnoFechado({ id: 's-antigo', closed_at: '2026-08-28T12:00:00.000Z' })],
    });
    montarCaixa();

    await waitFor(() => expect(screen.getAllByText('Carlos Caixa').length).toBe(2));
    // Um botão só, na primeira linha: reabrir um turno do meio do histórico é
    // reescrever o passado com o presente.
    expect(screen.getAllByRole('button', { name: 'Reabrir turno' }).length).toBe(1);
  });

  it('com caixa ABERTO não há o que reabrir', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [turnoFechado()], caixaAberto: true });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    expect(botaoReabrir()).toBeNull();
  });

  it('reabrir manda o MOTIVO e conta o que aconteceu com a conferência', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [turnoFechado()] });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    fireEvent.change(screen.getByLabelText('Motivo da reabertura'), {
      target: { value: 'faltou lançar a sangria' },
    });
    fireEvent.click(botaoReabrir()!);

    await waitFor(() => {
      const pedido = enviados.find((e) => e.url.includes('/reopen'));
      expect(pedido?.corpo?.reason).toBe('faltou lançar a sangria');
    });
    // A mensagem diz o que NÃO aconteceu: a conferência não foi apagada.
    await screen.findByText(/conferência anterior ficou guardada na trilha/);
  });

  it('o turno já reaberto se declara na lista', async () => {
    /*
      Sem esta marca, uma gaveta fechada, reaberta e fechada de novo teria a
      mesma cara de uma que fechou uma vez só — e a conferência arquivada na
      trilha ficaria invisível para quem confere.
    */
    entrarComo('gerente_loja');
    servidorDoCaixa({
      turnos: [turnoFechado({ reopen_count: 2, reopen_reason: 'contagem errada' })],
    });
    montarCaixa();

    await screen.findByText(/reaberto 2 vezes — contagem errada/);
  });

  it('a recusa do servidor aparece com todas as letras', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({
      turnos: [turnoFechado()],
      erroAoReabrir: {
        code: 'CORE_CASH_NOT_LAST_SESSION',
        message: 'Só o último turno fechado desta operação pode ser reaberto.',
      },
    });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    fireEvent.click(botaoReabrir()!);
    // A decisão é do servidor, e a tela não a traduz nem a esconde.
    await screen.findByText('Só o último turno fechado desta operação pode ser reaberto.');
  });
});

/* ========================================================================== */
/* BLOCO 3 — O CAIXA PEDE O GESTOR NA PRÓPRIA TELA (V11-AUT-015)              */
/* ========================================================================== */

/**
 * ============================================================================
 * O DEFEITO: o botão existe, o 403 tem nome, e a tela não sabe o que fazer
 * ============================================================================
 *
 * A metade do servidor está inteira há uma rodada: quem tem alçada reabre
 * direto; quem não tem recebe 403 `CORE_REOPEN_NEEDS_AUTHORIZATION` e reabre
 * com o bilhete do gestor (`CashService.reopenSession`, e 27 casos verdes em
 * `liberacao-pontual`).
 *
 * A metade da tela não existia. `CaixaPage` renderizava "Reabrir turno" sem
 * nenhum recorte de perfil, `/sistema/caixa` é `ROTA_CAIXA` (o operador de
 * caixa CHEGA), e o handler chamava `coreApi.reopenCash(sessionId, motivo)` com
 * DOIS argumentos — enquanto a assinatura do cliente tem TRÊS, e o terceiro é
 * justamente o `authorizationId`. O operador clicava, tomava o 403, lia a
 * frase "peça a liberação de um gestor" numa faixa azul e não tinha onde o
 * gestor digitar. O caminho da liberação existia inteiro e morria na última
 * linha.
 *
 * E nenhum dos sete casos acima percebia, porque TODOS entram com
 * `gerente_loja` — perfil que reabre direto e nunca vê o 403. Na operação real
 * é o contrário: os únicos perfis de balcão que existem no banco entregue são
 * `operador_caixa_loja` e `operador_caixa_oficina`, isto é, quem abre a gaveta
 * cai sempre no ramo que a tela não sabia atender.
 *
 * ## Como cada caso aqui falha quando o guarda sai
 *
 *   - volte `reopenCash` a dois argumentos e o caso do bilhete cai: a segunda
 *     chamada sai sem `authorizationId` e o servidor recusa de novo;
 *   - trate o 403 nomeado no `catch` genérico e o diálogo não abre;
 *   - tire o aviso de perfil e o caixa volta a se comprometer com um clique
 *     antes de saber que alguém vai ter de assinar.
 */
describe('o operador SEM alçada pede o gestor na própria tela do caixa', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(AGORA);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('o caixa vê o botão E é avisado, ANTES do clique, de que um gestor assina', async () => {
    entrarComo('operador_caixa_loja');
    servidorDoCaixa({ turnos: [turnoFechado()], exigeLiberacao: true });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    // O botão continua existindo: esconder seria negar uma saída que o
    // servidor oferece — o mesmo defeito simétrico da tela de devoluções.
    expect(botaoReabrir()).toBeTruthy();
    // E a condição se explica ANTES, em vez de virar 403 depois.
    expect(screen.getByText(/liberação de um gestor/i)).toBeTruthy();
  });

  it('quem TEM alçada não lê o aviso — ele não descreve o caminho dele', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [turnoFechado()] });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    expect(screen.queryByText(/liberação de um gestor/i)).toBeNull();
  });

  it('o 403 nomeado vira o diálogo do gestor, e a reabertura SEGUE com o bilhete', async () => {
    entrarComo('operador_caixa_loja');
    servidorDoCaixa({ turnos: [turnoFechado()], exigeLiberacao: true });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    fireEvent.change(screen.getByLabelText('Motivo da reabertura'), {
      target: { value: 'faltou lançar a sangria' },
    });
    fireEvent.click(botaoReabrir()!);

    // O 403 NÃO é faixa vermelha: é o próximo passo, e ele abre aqui mesmo.
    await screen.findByRole('dialog', { name: 'Autorização do gestor' });
    fireEvent.change(screen.getByLabelText('Usuário do gestor'), {
      target: { value: 'gilda' },
    });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    // O bilhete é PEDIDO para a ação certa e preso ao turno certo — bilhete
    // solto é o que o servidor recusa em `ACOES_PRESAS_AO_RECURSO`.
    await waitFor(() => {
      const pedido = enviados.find((e) => e.url.includes('/core/authorizations'));
      expect(pedido?.corpo?.action).toBe('reabrir_caixa');
      expect(pedido?.corpo?.referenceId).toBe('s-hoje');
    });

    // E a MESMA ação sai de novo, agora com o bilhete — não uma segunda ação.
    await waitFor(() => {
      const reaberturas = enviados.filter((e) => e.url.includes('/reopen'));
      expect(reaberturas).toHaveLength(2);
      expect(reaberturas[1].corpo?.authorizationId).toBe('lib-reabertura');
      // O motivo digitado sobrevive à liberação: redigitar seria o operador
      // pagar pela permissão que ele não tem.
      expect(reaberturas[1].corpo?.reason).toBe('faltou lançar a sangria');
    });

    await screen.findByText(/conferência anterior ficou guardada na trilha/);
  });

  it('quem TEM alçada reabre direto — e não manda bilhete nenhum', async () => {
    entrarComo('gerente_loja');
    servidorDoCaixa({ turnos: [turnoFechado()] });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    fireEvent.click(botaoReabrir()!);

    await waitFor(() => {
      const pedido = enviados.find((e) => e.url.includes('/reopen'));
      expect(pedido).toBeTruthy();
      // Mandar bilhete tendo alçada seria pedir liberação para si mesmo, que é
      // exatamente o que o mecanismo recusa.
      expect(pedido?.corpo?.authorizationId ?? null).toBeNull();
    });
    expect(screen.queryByRole('dialog', { name: 'Autorização do gestor' })).toBeNull();
  });

  it('credencial recusada NÃO fecha o diálogo — o gestor erra e redigita', async () => {
    entrarComo('operador_caixa_loja');
    servidorDoCaixa({ turnos: [turnoFechado()], exigeLiberacao: true });
    montarCaixa();

    await screen.findByText('Carlos Caixa');
    fireEvent.click(botaoReabrir()!);
    await screen.findByRole('dialog', { name: 'Autorização do gestor' });

    // A partir daqui o servidor recusa a credencial.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/core/authorizations')
          ? new Response(
            JSON.stringify({
              error: { code: 'CORE_AUTHORIZATION_DENIED', message: 'Credencial não autorizada.' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          )
          : new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    fireEvent.change(screen.getByLabelText('Usuário do gestor'), { target: { value: 'gilda' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'errada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));

    await screen.findByText('Credencial não autorizada.');
    expect(screen.queryByRole('dialog', { name: 'Autorização do gestor' })).toBeTruthy();
  });
});
