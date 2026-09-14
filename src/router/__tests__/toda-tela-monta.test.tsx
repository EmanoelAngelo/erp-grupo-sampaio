/**
 * ============================================================================
 * TODA TELA MONTA COM A API FORA DO AR — a rede que faltava
 * ============================================================================
 *
 * ## O buraco medido
 *
 * O projeto tem 70 telas e 55 arquivos de teste de tela — e a auditoria mediu
 * que **37 delas nunca são montadas por nenhum teste**. Não é falta de zelo:
 * cada rodada testou o que mexeu, e o que ninguém mexeu ficou sem uma linha.
 *
 * O defeito que isso deixa passar é o mais barato de cometer e o mais caro de
 * descobrir: a tela que ESTOURA AO ABRIR. Um `.map` num estado inicial nulo,
 * uma ordem de hook trocada, um import que virou `undefined` depois de um
 * rename. O `tsc` não pega (o tipo diz que existe), o lint não pega, a suíte
 * do servidor não pega — e a pessoa descobre clicando no menu, com o cliente
 * na frente, numa tela em branco.
 *
 * ## A pergunta que esta rede faz, e por que é ESTA
 *
 * **Toda tela do roteador sobrevive à API fora do ar?**
 *
 * É a pergunta que vale para as 86 rotas com a mesma régua, sem que o dublê
 * precise conhecer o formato de resposta de cada uma. E é um estado REAL: o
 * servidor reiniciando, a rede caindo no meio do expediente, o túnel fechando.
 * A tela tem de dizer "não foi possível carregar" — nunca sumir.
 *
 * ## O que ficou de fora, e por quê (medido, não suposto)
 *
 * A primeira tentativa foi um dublê que respondia 200 com listas vazias. Ela
 * acusou 19 telas — e as 19 eram culpa do dublê, não delas: `coreApi`
 * desembrulha o envelope com `.then((r) => r.formats)`, e um corpo sem aquela
 * chave entrega `undefined` à tela. Cobrir isso de verdade exigiria o formato
 * exato de cada um dos ~70 endpoints, que é o trabalho dos 55 arquivos por
 * tela — não de uma varredura.
 *
 * Fica o achado que a tentativa produziu, e ele é real: **os desembrulhos de
 * `coreApi` não têm fallback**. Num corpo inesperado — versão diferente, proxy
 * que engoliu a resposta, 200 com página de erro — a tela recebe `undefined` e
 * estoura em vez de mostrar o aviso. É rodada própria, e está anotado.
 *
 * ## Por que a lista vem do ROTEADOR, e não de uma lista escrita à mão
 *
 * Uma lista escrita à mão fica para trás na primeira tela nova, em silêncio, e
 * o buraco recomeça. Lendo `gsRoutes`, a tela nasce coberta no mesmo commit em
 * que nasce — e uma rota nova sem tela quebra aqui antes de quebrar no menu.
 *
 * ## Como se mede que a tela estourou
 *
 * Por FRONTEIRA DE ERRO, e não escutando `console.error`. A primeira versão
 * escutava o console e ficou VERDE para telas que estouravam de verdade: o
 * React já tem a referência dele quando o teste troca a função, e parte dos
 * relatos sai no desmonte, fora da janela do caso. Um teste que nomeia 86
 * telas e deixa passar as quebradas é pior que nenhum — ele afirma uma
 * cobertura que não existe.
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, type RouteObject } from 'react-router-dom';
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { gsRoutes } from '../gsRoutes';
import { carregarTodasAsTelas } from '../telaSobDemanda';
import { setSession } from '@/lib/api/client';

/**
 * A API fora do ar — 500 em tudo, GET e POST.
 *
 * `apiRequest` transforma isso em `ApiRequestError`, que é o que a tela vê num
 * servidor reiniciando ou numa rede caída. Nenhum envelope é desembrulhado, e
 * por isso o dublê não precisa conhecer o formato de resposta de ninguém.
 */
function apiForaDoAr() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'Servidor indisponível.' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
  );
}

/**
 * O CONTRATO QUEBRADO — 200 com um corpo que não é o combinado.
 *
 * Não é a API fora do ar: o servidor respondeu, com sucesso, e mandou um
 * objeto sem as chaves que a tela pediu. É o que o DEPLOY cria — o navegador
 * guarda o pacote antigo em cache e a API sobe nova, com uma rota que deixou
 * de mandar `items` ou passou a responder 204.
 *
 * A diferença entre os dois dublês é o que esta rodada consertou: no caminho
 * de ERRO nada nunca esteve quebrado; no caminho do CONTRATO, o `undefined`
 * atravessava até o componente e apagava a tela. Agora ele vira
 * `ApiRequestError`, que é o que toda tela já sabe mostrar.
 */
function contratoQuebrado() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

/** A sessão mais poderosa que existe: nenhuma tela é escondida dela. */
function entrarComoDono() {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'dono', displayName: 'Dono', profileCode: 'admin_geral' },
      company: { id: 'gringa', slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
      companies: [
        {
          id: 'gringa',
          slug: 'gringa',
          tradeName: 'Gringa',
          kind: 'retail',
          profileCode: 'admin_geral',
        },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

/**
 * A fronteira que colhe o estouro.
 *
 * `componentDidCatch` alcança render e efeito, montagem e atualização — é o
 * mesmo mecanismo que uma tela de erro de produção usaria, e por isso mede o
 * que a pessoa sentiria.
 */
class Fronteira extends Component<
  { children: ReactNode; aoPegar: (erro: Error, info: ErrorInfo) => void },
  { caiu: boolean }
> {
  state = { caiu: false };

  static getDerivedStateFromError(): { caiu: boolean } {
    return { caiu: true };
  }

  componentDidCatch(erro: Error, info: ErrorInfo): void {
    this.props.aoPegar(erro, info);
  }

  render(): ReactNode {
    return this.state.caiu ? null : this.props.children;
  }
}

/**
 * Um caminho concreto para cada rota do roteador.
 *
 * Rota com parâmetro (`/loja/:slug/produto/:id`) não monta com o padrão
 * literal: o `useParams` devolveria `':slug'` e a tela pediria um produto
 * chamado ":id". Trocar por um valor plausível é o que faz o caso medir a
 * tela, e não o roteador.
 */
function caminhoConcreto(path: string): string {
  return path
    .split('/')
    .map((parte) => {
      if (!parte.startsWith(':')) return parte;
      if (parte.includes('slug')) return 'gringa';
      if (parte.includes('id') || parte.includes('Id')) return 'x-1';
      return 'x';
    })
    .join('/');
}

interface TelaDoRoteador {
  path: string;
  element: ReactElement;
}

/** Toda rota do roteador que tem elemento — inclusive as públicas. */
function telas(): TelaDoRoteador[] {
  const achadas: TelaDoRoteador[] = [];
  for (const rota of gsRoutes as RouteObject[]) {
    if (!rota.path || !rota.element) continue;
    achadas.push({ path: rota.path, element: rota.element as ReactElement });
  }
  return achadas;
}

const TELAS = telas();

/*
  As telas vêm sob demanda (GAP-PRD-210): cada uma é um pedaço que chega por
  `import()`. Baixá-los todos ANTES de montar faz esta varredura medir a TELA —
  com um pedaço ainda a caminho, o caso veria só "Carregando a tela…" e
  passaria sem a tela ter montado. Um módulo de tela que não importa derruba
  este gancho, e a suíte com ele.
*/
beforeAll(() => carregarTodasAsTelas(), 120_000);

function prepararAmbiente(dubleFetch: () => unknown): void {
  entrarComoDono();
  vi.stubGlobal('fetch', dubleFetch);
  // Uma tela que chame `matchMedia` num ambiente sem ele estouraria aqui por
  // culpa do ambiente, e não dela. Preferimos medir a tela.
  if (!window.matchMedia) {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
  }
}

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ============================================================================

describe('o roteador tem rotas para varrer', () => {
  it('a lista vem do roteador e não está vazia', () => {
    /*
      Guarda contra o pior desfecho possível deste arquivo: `telas()` voltar
      vazio depois de um rename e a suíte inteira ficar verde varrendo nada.
    */
    expect(TELAS.length).toBeGreaterThan(50);
  });
});

async function montarESobreviver(tela: TelaDoRoteador): Promise<void> {
  const pegos: string[] = [];
  render(
    <MemoryRouter initialEntries={[caminhoConcreto(tela.path)]}>
      <Fronteira aoPegar={(erro) => pegos.push(erro.message)}>{tela.element}</Fronteira>
    </MemoryRouter>,
  );

  // As telas carregam por EFEITO: montar e sair na mesma linha não alcançaria
  // o `catch` que roda depois da resposta chegar.
  await waitFor(() => expect(document.body.textContent).not.toBeNull());
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));

  expect(pegos.join(' | '), `${tela.path} estourou`).toBe('');
  // E não ficou no carregando da tela sob demanda: o que se mede é a tela.
  expect(document.querySelector('[data-carregando-tela]'), `${tela.path} ficou carregando`).toBeNull();
  // E montou de verdade: uma tela que devolvesse `null` passaria no caso
  // acima sem provar nada.
  expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
}

describe('toda tela do roteador sobrevive à API fora do ar', () => {
  beforeEach(() => prepararAmbiente(apiForaDoAr()));
  for (const tela of TELAS) {
    it(`${tela.path}`, () => montarESobreviver(tela));
  }
});

/**
 * A SEGUNDA DIMENSÃO — e a que esta rodada abriu.
 *
 * Enquanto o desembrulho era feito em 58 lugares, cada um com o seu
 * `.then((r) => r.items)`, este bloco era impossível: 19 telas apagavam, e o
 * `undefined` vinha do cliente, não delas. Com o desembrulho num ponto só,
 * contrato quebrado virou erro — e erro toda tela já sabe mostrar.
 */
describe('toda tela do roteador sobrevive a um CONTRATO quebrado', () => {
  beforeEach(() => prepararAmbiente(contratoQuebrado()));
  for (const tela of TELAS) {
    it(`${tela.path}`, () => montarESobreviver(tela));
  }
});
