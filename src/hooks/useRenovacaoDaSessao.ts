/**
 * A SESSÃO DO PORTAL ACOMPANHA QUEM ESTÁ USANDO (GAP-PRD-193).
 *
 * O servidor desliza o vencimento a cada chamada do portal (uma hora sem uso
 * derruba; teto de 24 h desde o login). Só que a vitrine navega SEM chamar o
 * portal, e a sessão guardada no navegador tem o vencimento de quando foi
 * guardada: depois de uma hora a tela se achava deslogada — a conta "caía no
 * meio da navegação" com o carrinho montado.
 *
 * Este gancho, montado na casca da loja, renova enquanto há USO: ao abrir, ao
 * voltar para a aba, ao clicar ou digitar — no máximo uma vez a cada 5
 * minutos. A aba parada não renova nada, e a sessão cai sozinha, como deve.
 * O 401 (sessão revogada em outro aparelho, teto atingido) limpa a sessão.
 */
import { useEffect, useRef } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { carrinhoApi } from '@/lib/api/carrinho';
import {
  guardarSessaoPortal,
  lerSessaoPortal,
  limparSessaoPortal,
  type SessaoPortal,
} from '@/lib/portalSession';

export const RENOVAR_NO_MAXIMO_A_CADA_MS = 5 * 60 * 1000;

export function useRenovacaoDaSessao(sessao: SessaoPortal | null): void {
  const ultima = useRef(0);
  const token = sessao?.token ?? null;

  useEffect(() => {
    if (!token) return;
    ultima.current = 0;
    const renovar = () => {
      if (Date.now() - ultima.current < RENOVAR_NO_MAXIMO_A_CADA_MS) return;
      ultima.current = Date.now();
      carrinhoApi
        .renovarSessao(token)
        .then((r) => {
          const atual = lerSessaoPortal();
          if (atual?.token === token && r?.expiresAt && r.expiresAt !== atual.expiresAt) {
            guardarSessaoPortal({ ...atual, expiresAt: r.expiresAt });
          }
        })
        .catch((err) => {
          if (err instanceof ApiRequestError && err.status === 401) limparSessaoPortal();
        });
    };
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') renovar();
    };
    renovar();
    window.addEventListener('pointerdown', renovar);
    window.addEventListener('keydown', renovar);
    window.addEventListener('focus', renovar);
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      window.removeEventListener('pointerdown', renovar);
      window.removeEventListener('keydown', renovar);
      window.removeEventListener('focus', renovar);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [token]);
}
