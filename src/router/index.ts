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
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { useRoutes } from 'react-router-dom';
import { useEffect } from 'react';
import { gsRoutes } from './gsRoutes';

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
  useEffect(() => {
    window.REACT_APP_NAVIGATE = navigate;
    navigateResolver(window.REACT_APP_NAVIGATE);
  });
  return element;
}
