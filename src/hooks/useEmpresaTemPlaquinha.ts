/**
 * A empresa da sessão tem plaquinha? Só a PJ Motors (P0 das plaquinhas).
 *
 * Toda tela que mostra plaquinha pergunta aqui ANTES de chamar a API: fora da
 * PJ o servidor recusa com 403, e a tela nem monta o que levaria a recusa.
 *
 * Mora num módulo próprio, e não em `useSession.ts`, de propósito: vários
 * testes dublam `@/hooks/useSession` inteiro (só `useSession`, `useProfile` e
 * `useHasProfile`), e um gancho novo pendurado lá viraria `undefined` dentro
 * deles — a tela quebraria no teste de outra coisa. Daqui ele chama o
 * `useSession` que existir, dublado ou não.
 */
import { useSession } from '@/hooks/useSession';
import { empresaTemPlaquinha } from '@/lib/acesso/plaquinhaDaEmpresa';

export function useEmpresaTemPlaquinha(): boolean {
  return empresaTemPlaquinha(useSession()?.company?.slug);
}
