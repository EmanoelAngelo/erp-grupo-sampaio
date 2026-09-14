/**
 * ============================================================================
 * AS PORTAS QUE BATEM NA CARA — a varredura da auditoria, tela a tela
 * ============================================================================
 *
 * ## O defeito, mais uma vez, porque ele voltou maior
 *
 * A rodada 23 nomeou o sintoma ("guarda mais estreito que a tela"), a rodada
 * 95 fechou as cinco telas de e-commerce (`cinco-telas-que-batem-na-cara`,
 * no servidor), e a auditoria integral achou o resto do estoque: QUINZE
 * caminhos do escritório abertos no menu e no roteador para perfis que o
 * servidor recusa com 403 em TODA chamada da tela. O estoquista clicava em
 * "BI", a tela montava inteira e vazia, e cada requisição voltava 403 — chega
 * ao dono como "o sistema está com defeito", nunca como "você não tem
 * permissão", porque ninguém disse isso em lugar nenhum.
 *
 * ## O que este arquivo prova, e o que ele não repete
 *
 * Para cada tela fechada: o perfil EXCLUÍDO não vê o item de menu nem alcança
 * a rota (o guarda o devolve para casa), e o perfil PERMITIDO continua vendo
 * as duas coisas — porque o recorte errado para o outro lado transforma tela
 * em segredo alcançável só por URL, que é o defeito simétrico.
 *
 * As listas de perfil abaixo NÃO foram supostas: cada uma foi conferida
 * contra o `requireProfile` real em `server/src/routes/v1/core.ts`, rota a
 * rota, e o comentário de cada tela diz qual. `admin_geral` e `gestor` entram
 * em todas porque `requireProfile` os libera antes de olhar a lista.
 *
 * ## Como este guarda falha (quebrando de propósito)
 *
 *   - tire o quarto argumento de `protectedRoute('/sistema/relatorios/bi', ...)`
 *     em `gsRoutes.tsx` → "estoquista não alcança a rota" fica vermelho;
 *   - tire `profiles` do item "BI" em `navItems.ts` → "estoquista não vê o
 *     item" fica vermelho;
 *   - acrescente `estoquista` a `QUEM_GERENCIA_A_OPERACAO` → os casos de
 *     exclusão das dez telas de gerência ficam vermelhos de uma vez.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, type RouteObject } from 'react-router-dom';
import { Protected } from '@/router/Protected';
import { gsRoutes } from '@/router/gsRoutes';
import { AppShell } from '@/components/gs/AppShell';
import type { Environment } from '@/router/environments';

/*
  DOIS DUBLÊS DE SESSÃO, como em `contador-no-navegador.test.tsx`, e pela
  mesma razão: `Protected` lê `getSession()` do cliente HTTP e o `AppShell` lê
  o hook `useSession`. Dublar só um deixaria metade dos casos medindo uma
  sessão nula — que recusa tudo e fica verde por engano.
*/
let perfilAtual: { user: { profileCode: string } } | null = null;

vi.mock('@/lib/api/client', () => ({
  getSession: () => perfilAtual,
  // A casca monta o EstadoConexao, que escuta o aviso de servidor sem resposta
  // e confere as vendas guardadas: o módulo falso precisa ter os dois.
  EVENTO_SERVIDOR_SEM_RESPOSTA: 'gs:servidor-caiu',
  apiRequest: async () => ({ items: [] }),
}));

vi.mock('@/hooks/useSession', () => ({
  useSession: () =>
    perfilAtual
      ? {
          user: { id: 'u1', displayName: 'Pessoa da Casa', ...perfilAtual.user },
          company: { id: 'c1', tradeName: 'Me Mimei Modas' },
          companies: [{ id: 'c1', tradeName: 'Me Mimei Modas', ...perfilAtual.user }],
        }
      : null,
  useProfile: () => perfilAtual?.user.profileCode ?? null,
  useHasProfile: () => false,
}));

function entrarComo(profileCode: string): void {
  perfilAtual = { user: { profileCode } };
}

/**
 * O que cada rota do roteador REAL exige. É daqui que os casos tiram o guarda
 * que vão exercitar: um conserto que fechasse só o menu, deixando a rota
 * aberta, fica vermelho porque a exigência lida daqui continua nula.
 */
function exigenciasDasRotas(): Map<
  string,
  { environments: Environment[] | null; profiles: readonly string[] | null }
> {
  const mapa = new Map<
    string,
    { environments: Environment[] | null; profiles: readonly string[] | null }
  >();
  for (const rota of gsRoutes as RouteObject[]) {
    if (!rota.path) continue;
    const props = (rota.element as ReactElement | undefined)?.props as
      | { environments?: Environment[]; profiles?: readonly string[] }
      | undefined;
    mapa.set(rota.path, {
      environments: props?.environments ?? null,
      profiles: props?.profiles ?? null,
    });
  }
  return mapa;
}

/**
 * Renderiza a rota com o guarda QUE O ROTEADOR DECLARA e devolve a tela.
 *
 * As casas de destino estão registradas porque é para elas que `Protected`
 * devolve quem o perfil recusa — e o teste precisa distinguir "entrou" de
 * "foi devolvido para casa" de "caiu no login".
 */
function abrir(caminho: string): void {
  const exigencia = exigenciasDasRotas().get(caminho);
  if (!exigencia) throw new Error(`rota não encontrada no roteador: ${caminho}`);
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route
          path={caminho}
          element={
            <Protected
              environments={exigencia.environments ?? undefined}
              profiles={exigencia.profiles ?? undefined}
            >
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>TELA DE LOGIN</p>} />
        <Route path="/pdv" element={<p>CASA PDV</p>} />
        <Route path="/sistema/oficina" element={<p>CASA OFICINA</p>} />
        <Route path="/sistema/painel" element={<p>CASA GESTAO</p>} />
        <Route path="/sistema/fiscal/fechamento" element={<p>CASA CONTABILIDADE</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Abre a casca com a sessão corrente, expande TODOS os grupos, e devolve os
 * caminhos que o menu de fato ofereceu. Expandir tudo é o ponto: um item
 * dentro de grupo fechado não está no DOM, e o que se mede é o que a pessoa
 * ALCANÇA clicando.
 */
function caminhosOferecidosPeloMenu(): string[] {
  const { container } = render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );

  for (const botao of Array.from(container.querySelectorAll('nav button'))) {
    fireEvent.click(botao);
  }

  return Array.from(container.querySelectorAll('nav a'))
    .map((a) => a.getAttribute('href') ?? '')
    .filter(Boolean);
}

beforeEach(() => {
  perfilAtual = null;
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  /*
   * Todos os casos deste arquivo são síncronos, e somam ~90 s de render sem
   * nenhum `await`. Sem devolver a vez ao laço de eventos, a resposta do
   * processo principal ao `onTaskUpdate` do Vitest fica na fila além da janela
   * de 60 s do RPC do worker, e a rodada termina com "Unhandled Error: Timeout
   * calling onTaskUpdate" (exit 1) com os 141 casos verdes. Uma volta de
   * macrotarefa entre os casos basta para a resposta ser lida.
   */
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

// ---------------------------------------------------------------------------

interface TelaFechada {
  nome: string;
  caminho: string;
  /** Perfis do ESCRITÓRIO que o servidor recusa com 403 em toda chamada. */
  excluidos: string[];
  /** Amostra de quem o servidor atende — o recorte não pode virar tesoura. */
  permitidos: string[];
}

/*
  Cada lista abaixo foi CONFERIDA em `server/src/routes/v1/core.ts`, e o
  comentário nomeia a rota lida. Os caixas (`operador_caixa*`) aparecem em
  alguns guardas do servidor, mas moram no ambiente `pdv`: `ROTA_GESTAO` já
  os barra por ambiente, então quem este arquivo mede é o ESCRITÓRIO.
*/
const TELAS: TelaFechada[] = [
  {
    // GET/POST /core/fiscal/certificate e /revoke: `requireProfile(req)` sem
    // perfil extra — só `admin_geral` e `gestor`. O A1 assina nota em nome da
    // empresa; até os gerentes ficam de fora.
    nome: 'Certificado A1',
    caminho: '/sistema/fiscal/certificado',
    excluidos: ['gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor'],
  },
  {
    // GET/PATCH /core/fiscal/config, /fiscal/readiness e /fiscal/series:
    // `requireProfile(req, 'gerente_loja', 'gerente_oficina')`.
    nome: 'Configuração fiscal',
    caminho: '/sistema/fiscal/configuracao',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // GET/POST /core/fiscal/void-ranges: gerentes.
    nome: 'Inutilização de numeração',
    caminho: '/sistema/fiscal/inutilizacoes',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // GET /core/fiscal/documents (+ danfce/danfe): gerentes e os três
    // caixas. No escritório, sobram os gerentes.
    nome: 'Documentos fiscais',
    caminho: '/sistema/fiscal/documentos',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // GET /core/insights/{operations,products,margin,brands}: gerentes.
    nome: 'BI',
    caminho: '/sistema/relatorios/bi',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    /*
      GET /core/reports e /core/reports/:id: gerentes (GAP-V37).

      A Central é a única tela do sistema que é MAIS ESTREITA que várias das
      telas cujos números ela consolida — a Posição de estoque, por exemplo, é
      `abertaAo('escritorio')`. O recorte é deliberado: ela junta num lugar só
      o custo do estoque, a comissão por vendedor e a margem, e uma tela larga
      daria por acidente o que quatro guardas negam de propósito.
    */
    nome: 'Central de relatórios',
    caminho: '/sistema/relatorios/central',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // Todas as rotas de /core/commissions: gerentes.
    nome: 'Comissões',
    caminho: '/sistema/financeiro/comissoes',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // Todas as rotas de /core/team: gerentes. Gestão de acesso não é
    // trabalho de estoquista nem de atendente.
    nome: 'Usuários e equipe',
    caminho: '/sistema/usuarios',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // A MESMA tela de /core/team, pela porta da Oficina.
    nome: 'Mecânicos e técnicos',
    caminho: '/sistema/oficina/mecanicos',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // Todas as rotas de /core/acquirers: gerentes.
    nome: 'Operadoras de cartão',
    caminho: '/sistema/financeiro/operadoras',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // Todas as rotas de /core/bank: gerentes.
    nome: 'Conciliação bancária',
    caminho: '/sistema/financeiro/conciliacao',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // GET /core/pdv/terminal/uncertain e POST .../reconcile: gerentes.
    nome: 'Conferência de maquininha',
    caminho: '/sistema/conferencia-maquininha',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // GAP-PRD-076: /payment-terminals (cadastro, credencial, pareamento,
    // revogação, consulta) e /pdv/terminal/configurations: gerentes.
    nome: 'Maquininhas',
    caminho: '/sistema/configuracoes/maquininhas',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
  {
    // /core/leads, /opportunities e /crm/summary: gerentes, atendente e
    // operador_caixa_loja. Quem fica de fora do escritório é o ESTOQUISTA —
    // lead é gente, não mercadoria.
    nome: 'Leads e oportunidades',
    caminho: '/sistema/crm/leads',
    excluidos: ['estoquista'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'atendente'],
  },
  {
    // GET /core/loyalty/program e /loyalty/customers/:id: o mesmo conjunto
    // do CRM.
    nome: 'Fidelidade',
    caminho: '/sistema/crm/fidelidade',
    excluidos: ['estoquista'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'atendente'],
  },
  {
    // GET/POST /core/rentals: o mesmo conjunto do CRM.
    nome: 'Contratos de locação',
    caminho: '/sistema/locacao/contratos',
    excluidos: ['estoquista'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'atendente'],
  },
  {
    /*
      A PORTA QUE FOI ABERTA, e não fechada — e por isso `excluidos` está vazio.

      Esta linha dizia `excluidos: ['estoquista', 'atendente']`, e estava certa
      enquanto `POST /sales/:id/cancel` era `requireProfile(req,
      'gerente_loja')`. Deixou de estar no dia em que as duas ESCRITAS da tela
      passaram a ser `abertaAo(req, 'escritorio')` + `comLiberacaoPontual`: o
      recurso existe exatamente para o estoquista e o atendente chamarem um
      gestor ali mesmo, e eles continuavam sendo devolvidos para casa pelo
      `Protected` antes de ver a tela.

      O efeito era um caminho MORTO com cara de vivo: o ramo
      `CORE_RETURN_NEEDS_AUTHORIZATION` da `DevolucoesPage` não tinha nenhum
      usuário alcançável na aplicação entregue — os quatro perfis que abriam a
      tela devolvem DIRETO e nunca veem o ramo, e os dois para quem ele foi
      escrito não chegavam à tela.

      Os testes de tela não pegaram porque montam `<DevolucoesPage/>` direto no
      `MemoryRouter`, SEM passar pelo `Protected`. Este caso passa: `abrir()` lê
      a exigência do roteador REAL e monta o guarda REAL.
    */
    nome: 'Cancelamentos e devoluções',
    caminho: '/sistema/vendas/devolucoes',
    excluidos: [],
    permitidos: [
      'admin_geral',
      'gestor',
      'gerente_loja',
      'gerente_oficina',
      'estoquista',
      'atendente',
    ],
  },
  {
    /*
      AJUSTES E INVENTÁRIO — a porta que a auditoria integral não varreu.

      `GET /core/inventory-counts`, `GET /inventory-counts/:id`,
      `POST /inventory-counts` e `POST /inventory-counts/:id/items` são
      `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')`; o
      `apply` e o `cancel` são só os dois gerentes. O ATENDENTE não aparece em
      nenhuma delas — e mora em `gestao`, então `ROTA_GESTAO` sem lista o
      deixava entrar numa tela que monta inteira e VAZIA, com toda chamada
      voltando 403.

      É o mesmo caso da conciliação de recebimento, que a rodada vizinha fechou
      com `QUEM_CONCILIA_RECEBIMENTO` pelo mesmo motivo. Ver
      `QUEM_CONTA_A_PRATELEIRA`.
    */
    nome: 'Ajustes e inventário',
    caminho: '/sistema/estoque/inventario',
    excluidos: ['atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista'],
  },
  {
    // GET /core/sync/status: `requireProfile(req, 'gerente_loja',
    // 'gerente_oficina')` (GAP-PRD-136). O estoquista e o atendente viam o
    // item "Banco central" e tomavam 403 em toda chamada da tela.
    nome: 'Banco central (Supabase)',
    caminho: '/sistema/integracoes/central',
    excluidos: ['estoquista', 'atendente'],
    permitidos: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'],
  },
];

// ============================================================================

describe('a varredura enxerga o sistema de verdade — senão tudo abaixo é teatro', () => {
  it('o roteador tem as telas todas, e o menu do gestor oferece dezenas de caminhos', () => {
    const rotas = exigenciasDasRotas();
    expect(rotas.size).toBeGreaterThan(40);
    for (const tela of TELAS) {
      expect(rotas.has(tela.caminho), `${tela.nome}: rota sumiu do roteador`).toBe(true);
    }
    entrarComo('gestor');
    expect(caminhosOferecidosPeloMenu().length).toBeGreaterThan(40);
  });
});

for (const tela of TELAS) {
  describe(tela.nome, () => {
    for (const perfil of tela.excluidos) {
      it(`${perfil} não vê o item de menu`, () => {
        entrarComo(perfil);
        expect(
          caminhosOferecidosPeloMenu(),
          `o menu oferece ${tela.caminho} a ${perfil}, e o servidor responde 403 em tudo`,
        ).not.toContain(tela.caminho);
      });

      it(`${perfil} não alcança a rota — o guarda o devolve para casa`, () => {
        entrarComo(perfil);
        abrir(tela.caminho);
        expect(
          screen.queryByText('CONTEUDO'),
          `${perfil} abriu ${tela.caminho}, que só responderia 403 para ele`,
        ).toBeNull();
        // Devolvido para a casa DELE — não para o login, que pareceria
        // sessão expirada numa sessão perfeitamente válida.
        expect(screen.getByText('CASA GESTAO')).toBeTruthy();
        expect(screen.queryByText('TELA DE LOGIN')).toBeNull();
      });
    }

    for (const perfil of tela.permitidos) {
      it(`${perfil} continua vendo o item e abrindo a rota`, () => {
        // O recorte não pode virar tesoura: esconder de quem o servidor
        // atende transforma a tela em segredo alcançável só por URL.
        entrarComo(perfil);
        expect(
          caminhosOferecidosPeloMenu(),
          `${tela.nome} sumiu do menu de ${perfil}`,
        ).toContain(tela.caminho);
        cleanup();
        entrarComo(perfil);
        abrir(tela.caminho);
        expect(screen.getByText('CONTEUDO'), `${perfil} perdeu ${tela.caminho}`).toBeTruthy();
      });
    }
  });
}
