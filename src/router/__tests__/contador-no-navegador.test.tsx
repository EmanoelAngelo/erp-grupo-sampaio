/**
 * ============================================================================
 * O CONTADOR, DO LADO DE CÁ — ele entra na porta dele e não vê mais nada
 * ============================================================================
 *
 * ## O que já está provado em outro lugar, e não se repete aqui
 *
 * Que o SERVIDOR o recusa em 307 das 310 rotas de `core.ts` está provado por
 * varredura, com token de verdade, em `server/tests/contador-varredura-das-rotas.test.ts`.
 * Que os dois Records de ambiente — o do servidor e o daqui — dizem a mesma
 * coisa está provado por AST em `server/tests/ambientes-dos-dois-lados.test.ts`.
 *
 * O que NENHUM dos dois alcança é o que este arquivo mede: a CASCA. Um sistema
 * cujo servidor recusa perfeitamente e cujo menu oferece quinze portas produz
 * um contador que clica em quatorze delas, recebe 403 em todas, e conclui que
 * o sistema está quebrado. Ninguém abre chamado dizendo "o menu me ofereceu
 * demais"; abre-se dizendo "não funciona".
 *
 * ## Os quatro casos que este arquivo existe para pegar
 *
 *   1. o menu do contador oferecendo item que responde 403 — cobrado
 *      genericamente, comparando o que a casca RENDERIZA com o que o roteador
 *      DECLARA, sem lista escrita à mão;
 *   2. o laço de redirecionamento: `CASA.contabilidade` é a primeira casa do
 *      sistema que declara `profiles`, e um contador fora dessa lista seria
 *      devolvido em pingue-pongue para a tela que acabou de recusá-lo;
 *   3. a tesoura: o recorte novo levando junto o menu de quem já tinha o item
 *      — a gestão continua vendo o Fiscal inteiro;
 *   4. a casa errada: `homeOf('contador')` apontando para o painel, que
 *      responde 403 inteiro para ele.
 *
 * ## Como cada bloco fica VERMELHO (medido, não prometido)
 *
 *   - tire `contador: 'contabilidade'` de `AMBIENTE_POR_PERFIL` → `environmentOf`
 *     devolve `null`, `canSee` recusa tudo, e o menu dele fica sem item nenhum:
 *     o caso "o item que ele alcança está lá" falha;
 *   - troque `ROTA_CONTABILIDADE` por `ROTA_GESTAO` na rota do fechamento →
 *     o guarda passa a devolvê-lo e o caso "ele abre a única tela dele" falha;
 *   - troque `ROTA_CONTABILIDADE` por `ROTA_GESTAO` só no ITEM do menu → o
 *     item some do menu dele e a tela vira segredo alcançável por URL;
 *   - dê ao grupo Fiscal `environments: ROTA_CONTABILIDADE` sem declarar
 *     `ROTA_GESTAO` nos outros quatro filhos → "Documentos fiscais" aparece
 *     para o contador e o caso do menu genérico o nomeia, com o caminho e o
 *     ambiente que a rota exige;
 *   - tire `contador` de `QUEM_ENTREGA_A_CONTABILIDADE` → o caso do laço
 *     falha dizendo que a casa dele não o aceita.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, type RouteObject } from 'react-router-dom';
import { Protected } from '../Protected';
import { gsRoutes } from '../gsRoutes';
import { AppShell } from '@/components/gs/AppShell';
import { NAV_ITEMS } from '@/components/gs/navItems';
import {
  AMBIENTE_POR_PERFIL,
  CASA,
  DONOS_DO_GRUPO,
  QUEM_ENTREGA_A_CONTABILIDADE,
  QUEM_MONTA_O_CATALOGO,
  ROTA_CONTABILIDADE,
  ROTA_GESTAO,
  ROTA_OFICINA,
  ROTA_PDV,
  environmentOf,
  homeOf,
  perfilAtende,
  type Environment,
} from '../environments';

/** A tela de fechamento, escrita uma vez para os casos poderem compará-la. */
const FECHAMENTO = '/sistema/fiscal/fechamento';

/*
  DOIS DUBLÊS DE SESSÃO, e eles não são o mesmo.

  `Protected` lê `getSession()` do cliente HTTP; o `AppShell` lê o hook
  `useSession`. Dublar só um deixaria metade dos casos medindo uma sessão nula
  — que recusa tudo e fica verde por engano, que é a forma de falso verde mais
  fácil de escrever num arquivo sobre quem NÃO vê o quê.
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
          user: { id: 'u1', displayName: 'Contabilidade Andrade', ...perfilAtual.user },
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

/** Renderiza uma rota protegida isolada e devolve o que ficou na tela. */
function abrir(rota: string, environments: Environment[], profiles?: readonly string[]) {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route
          path={rota}
          element={
            <Protected environments={environments} profiles={profiles}>
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>TELA DE LOGIN</p>} />
        <Route path="/pdv" element={<p>CASA PDV</p>} />
        <Route path="/sistema/oficina" element={<p>CASA OFICINA</p>} />
        <Route path="/sistema/painel" element={<p>CASA GESTAO</p>} />
        <Route path={FECHAMENTO} element={<p>CASA CONTABILIDADE</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** O que cada rota do roteador exige: ambiente e, quando declara, perfil. */
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
 * Abre a casca com a sessão corrente, expande TODOS os grupos, e devolve os
 * caminhos que o menu de fato ofereceu.
 *
 * Expandir tudo é o ponto: um item escondido dentro de um grupo fechado não
 * está no DOM, e um teste que só olhasse a coluna colapsada acharia que o menu
 * do gerente tem quatro links. O que se mede é o que a pessoa ALCANÇA clicando.
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o contador tem prédio, e mora sozinho nele', () => {
  it('o perfil cai no ambiente da contabilidade', () => {
    expect(environmentOf('contador')).toBe('contabilidade');
  });

  it('e ninguém mais mora lá', () => {
    /*
      "Sozinho" é a metade que protege, e ela é do lado de cá também: como todo
      grupo de menu e toda rota sem declaração herdam `['gestao']`, um ambiente
      com um morador só significa que o morador não enxerga nada que não tenha
      sido aberto por escrito. Se um segundo perfil entrar aqui, ele herda a
      tela de fechamento inteira sem ninguém ter decidido isso.
    */
    const moradores = Object.entries(AMBIENTE_POR_PERFIL)
      .filter(([, ambiente]) => ambiente === 'contabilidade')
      .map(([perfil]) => perfil);
    expect(moradores).toEqual(['contador']);
  });

  it('e não entrou de carona em nenhuma das listas de perfil já existentes', () => {
    // As duas listas do escritório restringem para BAIXO. Se `contador`
    // aparecesse numa delas, ele ganharia uma tela que o servidor recusa.
    expect(DONOS_DO_GRUPO).not.toContain('contador');
    expect(QUEM_MONTA_O_CATALOGO).not.toContain('contador');
  });
});

describe('a casa dele é onde ele trabalha', () => {
  it('homeOf leva o contador para a tela de fechamento', () => {
    expect(homeOf('contador')).toBe(FECHAMENTO);
    expect(CASA.contabilidade).toBe(FECHAMENTO);
  });

  it('e NÃO para o painel, que responde 403 inteiro para ele', () => {
    // Este é o vermelho que o teste do servidor também cobra, por AST. Aqui a
    // pergunta é feita à função que o login de fato chama.
    expect(homeOf('contador')).not.toBe(CASA.gestao);
  });

  it('a casa que ele recebe é uma rota que o roteador conhece', () => {
    // Casa apontando para caminho sem rota cairia na tela de "não encontrada",
    // e o primeiro segundo do primeiro acesso dele seria um 404.
    expect(exigenciasDasRotas().has(homeOf('contador'))).toBe(true);
  });
});

/**
 * O LAÇO — o risco que esta rodada criou e que não existia antes.
 *
 * Até aqui nenhum destino de `CASA` declarava `profiles`, então quem o guarda
 * devolvia chegava sempre a um lugar que o aceitava. `CASA.contabilidade` é a
 * tela de fechamento, que declara `QUEM_ENTREGA_A_CONTABILIDADE`: se `contador`
 * sair dessa lista, ele é devolvido para a tela que acabou de recusá-lo, e a
 * primeira tela depois do login vira um pingue-pongue infinito.
 *
 * A varredura é sobre `AMBIENTE_POR_PERFIL` inteiro de propósito: uma lista de
 * perfis escrita à mão aqui deixaria de cobrir o décimo perfil no dia em que
 * ele nascer, que é exatamente o dia em que este caso teria algo a dizer.
 */
describe('a casa de cada ambiente aceita quem mora nele', () => {
  it('nenhum perfil é devolvido para uma casa que o recusa', () => {
    const rotas = exigenciasDasRotas();
    const presos: string[] = [];

    for (const [perfil, ambiente] of Object.entries(AMBIENTE_POR_PERFIL)) {
      const casa = CASA[ambiente];
      const exigencia = rotas.get(casa);
      if (!exigencia) {
        presos.push(`${perfil}: a casa \`${casa}\` não é rota nenhuma`);
        continue;
      }
      if (exigencia.environments && !exigencia.environments.includes(ambiente)) {
        presos.push(
          `${perfil}: mora em \`${ambiente}\`, e a casa dele (${casa}) `
            + `só aceita [${exigencia.environments.join(', ')}]`,
        );
      }
      if (!perfilAtende(perfil, exigencia.profiles ?? undefined)) {
        presos.push(
          `${perfil}: a casa dele (${casa}) exige perfil `
            + `[${(exigencia.profiles ?? []).join(', ')}] — laço de redirecionamento`,
        );
      }
    }

    expect(presos).toEqual([]);
  });

  it('e a varredura enxerga perfis de verdade', () => {
    // Sem isto o caso acima ficaria verde para sempre no dia em que o Record
    // deixasse de ser lido — percorreria zero perfil e não provaria nada.
    expect(Object.keys(AMBIENTE_POR_PERFIL).length).toBeGreaterThan(8);
    expect(AMBIENTE_POR_PERFIL.contador).toBe('contabilidade');
  });
});

describe('o guarda deixa o contador entrar na única tela dele', () => {
  it('ele abre o fechamento', () => {
    entrarComo('contador');
    abrir(FECHAMENTO, ROTA_CONTABILIDADE, QUEM_ENTREGA_A_CONTABILIDADE);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('e a gestão continua abrindo a mesma tela — ela não virou tela de terceiro', () => {
    // O item 2 da rodada diz isso em uma linha: "a gestão continua vendo a
    // tela, que já é assim hoje". Sem este caso, trocar `ROTA_CONTABILIDADE`
    // por `['contabilidade']` passaria despercebido e o gerente perderia o
    // fechamento sem ninguém ter decidido isso.
    for (const perfil of ['gerente_loja', 'gerente_oficina', 'gestor', 'admin_geral']) {
      cleanup();
      entrarComo(perfil);
      abrir(FECHAMENTO, ROTA_CONTABILIDADE, QUEM_ENTREGA_A_CONTABILIDADE);
      expect(screen.getByText('CONTEUDO'), `${perfil} perdeu o fechamento`).toBeTruthy();
    }
  });

  it('o estoquista e o atendente continuam recusados — o ambiente novo não os trouxe junto', () => {
    for (const perfil of ['estoquista', 'atendente']) {
      cleanup();
      entrarComo(perfil);
      abrir(FECHAMENTO, ROTA_CONTABILIDADE, QUEM_ENTREGA_A_CONTABILIDADE);
      expect(screen.queryByText('CONTEUDO'), `${perfil} entrou no fechamento`).toBeNull();
      // Volta para a casa DELE, que é o painel — não para o login.
      expect(screen.getByText('CASA GESTAO')).toBeTruthy();
    }
  });
});

describe('e o devolve de todo o resto', () => {
  it('o painel do escritório o manda de volta para o fechamento', () => {
    entrarComo('contador');
    abrir('/sistema/painel', ROTA_GESTAO);

    expect(screen.getByText('CASA CONTABILIDADE')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
    // E não para o login: a sessão dele está perfeitamente válida.
    expect(screen.queryByText('TELA DE LOGIN')).toBeNull();
  });

  it('o PDV também', () => {
    entrarComo('contador');
    abrir('/pdv', ROTA_PDV);
    expect(screen.getByText('CASA CONTABILIDADE')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('a oficina também', () => {
    entrarComo('contador');
    abrir('/sistema/oficina', ROTA_OFICINA);
    expect(screen.getByText('CASA CONTABILIDADE')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('e toda rota do roteador que não seja o fechamento', () => {
    /*
      A varredura do lado de cá. É a irmã pequena da varredura das 310 rotas do
      servidor, e mede outra coisa: lá o que se prova é que a API recusa; aqui,
      que a CASCA não abre. Uma tela que abre e chega vazia com erro de
      permissão é lida como defeito do sistema, mesmo com o servidor perfeito.

      Sai por AST do roteador, nunca por lista escrita à mão: rota nova aberta
      por engano à contabilidade tem de deixar este caso vermelho.
    */
    const abertas: string[] = [];
    for (const [caminho, exigencia] of exigenciasDasRotas()) {
      if (caminho === FECHAMENTO) continue;
      // Rota sem ambiente é pública (vitrine, login, portal do cliente): ela
      // não pertence a ambiente nenhum e não é o que este caso mede.
      if (!exigencia.environments) continue;
      if (!exigencia.environments.includes('contabilidade')) continue;
      abertas.push(`${caminho} → [${exigencia.environments.join(', ')}]`);
    }

    expect(abertas).toEqual([]);
  });

  it('e a varredura das rotas está enxergando o roteador de verdade', () => {
    const rotas = exigenciasDasRotas();
    expect(rotas.size).toBeGreaterThan(40);
    // A única que ele alcança, e ela declara as DUAS dimensões.
    expect(rotas.get(FECHAMENTO)?.environments).toEqual(ROTA_CONTABILIDADE);
    expect(rotas.get(FECHAMENTO)?.profiles).toContain('contador');
  });
});

describe('o menu dele não oferece porta que bate na cara', () => {
  it('a casca renderiza para o contador exatamente um caminho: o fechamento', () => {
    entrarComo('contador');
    // Contado no DOM, com todos os grupos abertos. Quinze itens e quatorze
    // 403 é a experiência que esta rodada existe para não entregar.
    expect(caminhosOferecidosPeloMenu()).toEqual([FECHAMENTO]);
  });

  it('e é o item certo, com o rótulo que ele procura', () => {
    entrarComo('contador');
    caminhosOferecidosPeloMenu();
    expect(screen.getByText('Fechamento do contador')).toBeTruthy();
  });

  it('os outros quatro itens do Fiscal NÃO aparecem para ele', () => {
    /*
      Os quatro são `abertaAo(req, 'escritorio')` no servidor, e `contador` não
      está no escritório: os quatro respondem 403 para ele. Eles moram no mesmo
      grupo que o item dele, então é precisamente aqui que a herança de ambiente
      poderia vazar — filho sem declaração herda o grupo, e o grupo agora abre
      para a contabilidade.
    */
    entrarComo('contador');
    caminhosOferecidosPeloMenu();

    for (const rotulo of [
      'Documentos fiscais',
      'Inutilização de numeração',
      'Configuração fiscal',
      'Certificado A1',
    ]) {
      expect(screen.queryByText(rotulo), `${rotulo} apareceu para o contador`).toBeNull();
    }
  });

  it('todo caminho que o menu dele oferece é um caminho que o guarda abre', () => {
    /*
      O caso genérico, e o que sobrevive a uma reorganização do menu: em vez de
      conferir rótulos, ele compara o que a CASCA renderizou com o que o
      ROTEADOR declara, item por item. Um item novo oferecido ao contador
      apontando para rota de gestão aparece aqui com o caminho e as duas listas.
    */
    entrarComo('contador');
    const rotas = exigenciasDasRotas();
    const batemNaCara: string[] = [];

    for (const caminho of caminhosOferecidosPeloMenu()) {
      const exigencia = rotas.get(caminho);
      if (!exigencia) {
        batemNaCara.push(`${caminho}: o menu oferece, e o roteador não conhece`);
        continue;
      }
      if (exigencia.environments && !exigencia.environments.includes('contabilidade')) {
        batemNaCara.push(
          `${caminho}: o menu oferece à contabilidade, e a rota só aceita `
            + `[${exigencia.environments.join(', ')}]`,
        );
      }
      if (!perfilAtende('contador', exigencia.profiles ?? undefined)) {
        batemNaCara.push(
          `${caminho}: a rota exige perfil [${(exigencia.profiles ?? []).join(', ')}], `
            + 'e `contador` não está nela',
        );
      }
    }

    expect(batemNaCara).toEqual([]);
  });
});

describe('o recorte novo não virou tesoura no menu de quem já tinha', () => {
  it('o gerente continua vendo o Fiscal dele — os quatro itens que o servidor lhe atende', () => {
    /*
      A metade que quase ninguém escreve, e a que impede o item 4 desta rodada
      de ser um estrago: os quatro `environments: ROTA_GESTAO` que os filhos do
      Fiscal ganharam existem para o contador NÃO os ver — e a maneira mais
      fácil de errar isso é digitar o ambiente trocado num deles e apagá-lo do
      menu do gerente, que é quem os usa todo dia.

      Este caso dizia "os cinco itens" e envelheceu na rodada da auditoria
      integral, de propósito: as três rotas do Certificado A1 são
      `requireProfile(req)` sem perfil extra — só os donos do grupo —, e o
      item passou a declarar `DONOS_DO_GRUPO` como o de "Empresas do grupo".
      O gerente clicava e colecionava 403; agora o menu diz a verdade. O caso
      seguinte cobra que o item não sumiu de quem o servidor ATENDE.
    */
    entrarComo('gerente_loja');
    caminhosOferecidosPeloMenu();

    for (const rotulo of [
      'Documentos fiscais',
      'Inutilização de numeração',
      'Fechamento do contador',
      'Configuração fiscal',
    ]) {
      expect(screen.getByText(rotulo), `a gestão perdeu "${rotulo}"`).toBeTruthy();
    }
    expect(
      screen.queryByText('Certificado A1'),
      'o A1 apareceu para o gerente, e as três rotas dele só atendem os donos',
    ).toBeNull();
  });

  it('e o Certificado A1 continua no menu dos donos — o recorte não o apagou', () => {
    for (const perfil of ['admin_geral', 'gestor']) {
      cleanup();
      entrarComo(perfil);
      caminhosOferecidosPeloMenu();
      expect(screen.getByText('Certificado A1'), `${perfil} perdeu o A1`).toBeTruthy();
    }
  });

  it('e o menu da gestão não encolheu: continua com dezenas de caminhos', () => {
    entrarComo('gestor');
    expect(caminhosOferecidosPeloMenu().length).toBeGreaterThan(40);
  });

  it('o grupo Fiscal declara os dois ambientes, e a lista é exatamente essa', () => {
    // O pedágio: alargar o Fiscal para um terceiro ambiente obriga a escrever
    // por quê, em vez de acontecer numa linha de diff.
    const fiscal = NAV_ITEMS.find((i) => i.label === 'Fiscal')!;
    expect(fiscal.environments).toEqual(['contabilidade', 'gestao']);
  });
});
