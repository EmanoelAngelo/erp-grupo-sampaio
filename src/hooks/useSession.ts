/**
 * Sessão autenticada, reativa. Fonte única para o frontend saber quem está
 * logado e em qual operação — sempre espelhando o que o servidor emitiu.
 */
import { useSyncExternalStore } from 'react';
import { getSession, subscribeSession, type StoredSession } from '@/lib/api/client';
import { DONOS_DO_GRUPO } from '@/router/environments';

export function useSession(): StoredSession | null {
  return useSyncExternalStore(
    (listener) => subscribeSession(listener),
    () => getSession(),
    () => null,
  );
}

/** Perfil ativo do usuário na operação corrente. */
export function useProfile(): string | null {
  return useSession()?.user.profileCode ?? null;
}

/**
 * O mesmo atalho do `requireProfile` do servidor, do lado de cá.
 *
 * Os dois códigos do atalho estavam escritos à mão aqui. Agora vêm de
 * `DONOS_DO_GRUPO`, que é a MESMA lista que o roteador e o menu leem — a regra
 * de quem responde pelo grupo passa a ter um lugar só no frontend. Sem
 * argumento nenhum, `useHasProfile()` responde exatamente o que
 * `requireProfile(req)` sem perfil extra responde: só o dono do grupo.
 */
export function useHasProfile(...allowed: string[]): boolean {
  const profile = useProfile();
  if (!profile) return false;
  if (DONOS_DO_GRUPO.includes(profile)) return true;
  return allowed.includes(profile);
}
