/**
 * As rotas da aplicação.
 *
 * Até esta rodada eram duas listas: as telas reconstruídas primeiro e, atrás
 * delas, 350 rotas legadas que respondiam por tudo que ainda não tinha sido
 * migrado. Não sobrou nada para elas responderem — e, pior, elas já não
 * respondiam: dependiam de uma sessão guardada no navegador que o login novo
 * nunca preenche, então cada uma terminava num salto para `/login`. Quem
 * digitasse um endereço antigo era mandado para a tela de senha sem explicação
 * nenhuma, como se tivesse errado a senha.
 *
 * Ficou uma lista só, com um destino para endereço inexistente que diz isso em
 * português.
 */
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { useRoutes } from 'react-router-dom';
import { useCallback, useEffect } from 'react';
import { gsRoutes } from './gsRoutes';
import { comFronteiraDaTela } from './FronteiraDaTela';
import { homeOf } from './environments';
import { getSession } from '@/lib/api/client';

let navigateResolver: (navigate: ReturnType<typeof useNavigate>) => void;

declare global {
  interface Window {
    REACT_APP_NAVIGATE: ReturnType<typeof useNavigate>;
  }
}

export const navigatePromise = new Promise<NavigateFunction>((resolve) => {
  navigateResolver = resolve;
});

export function AppRoutes() {
  const element = useRoutes(gsRoutes);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    window.REACT_APP_NAVIGATE = navigate;
    navigateResolver(window.REACT_APP_NAVIGATE);
  });

  /*
    A CASA DE QUEM ESTÁ DENTRO, e a porta de quem não está.

    A sessão é lida na hora do clique, e não por `useSession`: este componente
    é o pai de todas as telas, e assiná-lo a cada troca de sessão redesenharia
    o roteador inteiro por uma decisão que só importa depois de um estouro.
  */
  const casaDoPerfil = useCallback(() => {
    const sessao = getSession();
    return sessao ? homeOf(sessao.user.profileCode) : '/';
  }, []);
  const aoInicio = useCallback(() => {
    navigate(casaDoPerfil(), { replace: true });
  }, [navigate, casaDoPerfil]);
  const aoVoltar = useCallback(() => navigate(-1), [navigate]);
  const aoRecarregar = useCallback(() => window.location.reload(), []);

  /*
    AS DUAS PORTAS QUE PODEM NÃO ABRIR.

    `homeOf('operador_caixa_loja')` é '/pdv': com o PDV estourando, "Ir para o
    início" redesenha a MESMA tela. E `location.key` é 'default' no endereço em
    que o navegador abriu — o balcão que liga o computador direto no PDV não
    tem página anterior, então `navigate(-1)` não leva a lugar nenhum. O aviso
    só mostra a porta que abre; ver `FronteiraDaTela.tsx`.
  */
  const inicioLevaEmbora = useCallback(
    () => casaDoPerfil() !== location.pathname,
    [casaDoPerfil, location.pathname],
  );
  const podeVoltar = location.key !== 'default';

  /*
    A fronteira fica AQUI, dentro do roteador: a tela que estoura não leva o
    `BrowserRouter` junto, e o aviso tem para onde levar a pessoa. O porquê
    inteiro está em `FronteiraDaTela.tsx`. `location.key` muda a cada
    navegação — é o que faz o erro ser esquecido ao sair da tela quebrada.
  */
  return comFronteiraDaTela({
    chave: location.key,
    aoInicio,
    aoVoltar,
    aoRecarregar,
    podeVoltar,
    inicioLevaEmbora,
    children: element,
  });
}
