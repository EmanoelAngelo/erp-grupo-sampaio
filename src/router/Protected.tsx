/**
 * Guarda de rota: exige sessão E ambiente.
 *
 * A checagem aqui é de NAVEGAÇÃO. A autorização real acontece no servidor, que
 * valida o token e o vínculo de empresa em cada requisição — se esta camada
 * falhar, a API ainda recusa. Ver `environments.ts` para o desenho.
 *
 * TRÊS SAÍDAS DIFERENTES, DE PROPÓSITO:
 *
 *  - sem sessão → login. A pessoa precisa entrar.
 *  - com sessão PROVISÓRIA (`mustChangePassword`) → a porta do ambiente dela,
 *    que abre direto na etapa de troca. A senha que a gestão conhece não
 *    navega o sistema — nem por F5, nem por URL digitada, nem pelo voltar.
 *  - com sessão, porta errada → CASA DO PERFIL. Mandar para o login quem já
 *    está autenticado parece sessão expirada, e o caixa digita a senha de novo
 *    achando que caiu. Ele só clicou onde não devia.
 *
 * E O LOGIN NÃO É UM SÓ. A bancada tem porta própria (`/oficina/login`). Sem
 * sessão, quem tentou abrir uma rota de oficina volta para a porta DELE — não
 * para a tela do escritório, que oferece Gestão e PDV a quem não usa nenhum
 * dos dois. Sem isto, toda sessão expirada na oficina despejava o mecânico no
 * lugar errado.
 *
 * ACESSO PERSONALIZADO (RBAC granular, escopo reduzido da entrega). Quem teve o
 * acesso montado na tela de Usuários (modelo que não é perfil de hoje, ou vínculo
 * com capabilities dadas/tiradas) é guardado pelas CAPABILITIES que o servidor
 * devolve em `access`: a tela da tabela (`capabilityDaTela.gen.ts`) abre ou
 * mostra "acesso negado" — nada de redirecionar calado para uma tela errada. Os
 * perfis de hoje seguem pelo ambiente e pela lista de perfis, como sempre.
 */
import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '@/hooks/useSession';
import { acessoPersonalizado, telaAbre, temAlgumaTelaDeGestao } from '@/lib/acesso/acesso';
import AcessoNegadoPage from '@/pages/gs/AcessoNegadoPage';
import { environmentOf, homeOf, perfilAtende, type Environment } from './environments';

/**
 * Para qual porta mandar quem não tem sessão.
 *
 * A decisão vem da ROTA, não do perfil: sem sessão não há perfil para
 * consultar. Se a rota serve a bancada, a porta é a da bancada.
 */
function loginRouteFor(environments?: Environment[]): string {
  return environments?.includes('oficina') ? '/oficina/login' : '/login';
}

export function Protected({
  children,
  environments,
  profiles,
}: {
  children: ReactElement;
  /** Ambientes que podem abrir esta rota. Omitido, basta ter sessão. */
  environments?: Environment[];
  /**
   * Perfis que podem abrir esta rota, DENTRO do ambiente. Omitido, todo perfil
   * do ambiente entra — que é o caso de quase toda tela.
   *
   * Existe porque `ROTA_GESTAO` é o escritório inteiro e algumas rotas do
   * servidor atendem só o dono do grupo. Ver o bloco no fim de
   * `environments.ts` para a razão de ser cargo, e não um quarto prédio.
   */
  profiles?: readonly string[];
}): ReactElement {
  /*
    A sessão é ACOMPANHADA, não lida uma vez: quando o servidor recusa a
    sessão por senha provisória (403 `API_PASSWORD_CHANGE_REQUIRED`, GAP-PRD-202),
    o cliente marca a bandeira e este guarda redesenha — a pessoa vai para a
    etapa de troca na hora, e não só no próximo F5.
  */
  const session = useSession();
  const location = useLocation();
  if (!session) return <Navigate to={loginRouteFor(environments)} replace />;

  /*
    SENHA PROVISÓRIA NÃO NAVEGA.

    A etapa de troca segura a pessoa na tela de login — mas a sessão emitida
    pelo login provisório precisa existir (é ela que autentica o
    `POST /auth/password`), e sessão que existe é sessão que o F5, a URL
    digitada e o botão voltar restauram. Sem esta linha, a etapa era um aviso
    que só aparecia uma vez: qualquer recarga entrava no app com a senha que a
    gestão conhece ainda valendo.

    O destino é a PORTA, não a casa: as duas telas de login abrem direto na
    etapa quando a sessão guardada carrega a bandeira. E a porta é a do
    AMBIENTE DA PESSOA — aqui há sessão, logo há perfil, e o mecânico
    provisório que digitou URL de gestão volta para `/oficina/login`, não para
    a tela que oferece Gestão e PDV. Ausência da bandeira é "não precisa
    trocar": sessões de antes deste contrato seguem navegando.
  */
  if (session.user.mustChangePassword) {
    const ambiente = environmentOf(session.user.profileCode);
    return <Navigate to={loginRouteFor(ambiente ? [ambiente] : environments)} replace />;
  }

  /*
    ACESSO PERSONALIZADO: a tela da tabela abre pela capability, ou diz que não
    abre. Tela fora da tabela (a porta de um prédio sem capability própria)
    abre para quem tem o prédio: o PDV para quem vende, a gestão para quem tem
    alguma tela de gestão.
  */
  if (acessoPersonalizado(session)) {
    const capabilities = session.access!.capabilities;
    const abre = telaAbre(capabilities, location.pathname);
    if (abre === true) return children;
    if (abre === false) return <AcessoNegadoPage />;
    if (!environments) return children;
    const noPdv = environments.includes('pdv') && capabilities.includes('pdv.sell');
    const naGestao = environments.includes('gestao') && temAlgumaTelaDeGestao(capabilities);
    return noPdv || naGestao ? children : <AcessoNegadoPage />;
  }

  if (!environments) return children;

  const atual = environmentOf(session.user.profileCode);
  if (!atual || !environments.includes(atual)) {
    return <Navigate to={homeOf(session.user.profileCode)} replace />;
  }

  /*
    Perfil errado sai pela MESMA porta que ambiente errado: a casa da pessoa.
    Ela está autenticada e no prédio certo — apenas clicou numa sala que não é
    dela. Mandá-la ao login diria "sua sessão caiu", que é falso.

    O LAÇO É O RISCO REAL DESTE BLOCO, e ele mudou de forma na rodada 29.

    Até aqui nenhuma rota-casa (`CASA`) declarava `profiles`, então quem era
    devolvido chegava sempre a um destino que aceita todo perfil do ambiente
    dele — o laço era impossível por construção. Agora `CASA.contabilidade` é a
    tela de fechamento, que declara `QUEM_ENTREGA_A_CONTABILIDADE`: se
    `contador` sair dessa lista, ele é devolvido para a tela que acabou de
    recusá-lo, e o navegador entra em pingue-pongue na primeira tela depois do
    login.

    A garantia deixou de ser estrutural e passou a ser cobrada por teste: o
    caso "a casa de cada ambiente aceita quem mora nele" em
    `contador-no-navegador.test.tsx` percorre `CASA` inteira e confere, para
    cada perfil, que o destino da casa dele o deixa entrar.
  */
  if (!perfilAtende(session.user.profileCode, profiles)) {
    return <Navigate to={homeOf(session.user.profileCode)} replace />;
  }

  return children;
}
