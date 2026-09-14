/**
 * A pergunta da tela pelo mecanismo NOVO (RBAC granular): o vínculo ativo tem
 * esta capability? Lê o `access` que o servidor devolveu (login, sessão, troca de
 * empresa) e que ele atualiza quando o acesso muda (`X-Acesso-Em-Vigor`).
 *
 * Esconder botão não é segurança — o servidor recusa com 403 de qualquer jeito.
 * Isto é para a tela não oferecer o que o servidor vai negar. Sessão sem `access`
 * (guardada antes do acesso granular) responde `false` até o próximo login.
 */
import { useSession } from '@/hooks/useSession';
import { passaNoTexto } from '@/lib/acesso/acesso';

export function useCan(capability: string): boolean {
  const capabilities = useSession()?.access?.capabilities;
  return Boolean(capabilities && capabilities.includes(capability));
}

/** Qualquer das capabilities (ou uma expressão `qualquer(a, b)` / `todas(a, b)`). */
export function useCanAny(...capabilities: string[]): boolean {
  const caps = useSession()?.access?.capabilities;
  if (!caps) return false;
  return capabilities.some((c) => (c.includes('(') ? passaNoTexto(caps, c) : caps.includes(c)));
}
