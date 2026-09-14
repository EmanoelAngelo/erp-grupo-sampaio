/**
 * A sessão do PORTAL DO CLIENTE, num lugar só.
 *
 * Até a rodada 37, três arquivos (`MinhaContaPage`, `MeusEquipamentosPage`,
 * `AvaliacoesProduto`) declaravam cada um a chave `gs.portal`, a leitura, a
 * conferência de validade e o `comToken`. Três cópias da mesma regra é três
 * lugares para uma divergir: um esquecer de conferir a validade, outro guardar
 * um formato de sessão diferente, e a conta do cliente passa a mentir em uma
 * tela e não na outra.
 *
 * Esta sessão é do PORTAL, e é separada da sessão administrativa do ERP de
 * propósito: quem comprou uma jaqueta não ganha escopo de PDV nem de gerente.
 * Ela vive em `gs.portal`; a do ERP, em outra chave. As duas nunca se
 * encontram — o servidor as valida por mecanismos diferentes
 * (`x-portal-token` aqui, `Authorization: Bearer` lá).
 */
import { apiRequest } from './api/client';

/** A chave no localStorage. Um lugar só a conhece: este. */
const PORTAL_KEY = 'gs.portal';

/**
 * O vínculo do cliente com UMA operação. Uma pessoa pode ter cadastro em mais
 * de uma loja do grupo (mesmo e-mail, documentos por empresa), então é lista.
 */
export interface VinculoCliente {
  customerId: string;
  companyId: string;
  companyName: string;
}

export interface SessaoPortal {
  token: string;
  /** ISO. Sessão vencida não é sessão — ver `lerSessaoPortal`. */
  expiresAt: string;
  account: {
    id: string;
    email: string;
    /** Nulo = a caixa de entrada ainda não provou dona (rodada 50). */
    emailVerifiedAt?: string | null;
  };
  /** Presente onde a tela precisa saber de quais lojas o cliente é. */
  customers?: VinculoCliente[];
}

/**
 * A sessão guardada, SE ainda vale.
 *
 * Vencida devolve `null` — melhor pedir para entrar de novo do que mostrar uma
 * tela vazia que parece "você não tem pedidos". A validade é conferida pelo
 * relógio local; o servidor confere de novo a cada chamada, então um relógio
 * adiantado no máximo antecipa um "entre de novo", nunca abre porta.
 */
export function lerSessaoPortal(): SessaoPortal | null {
  try {
    const bruto = localStorage.getItem(PORTAL_KEY);
    if (!bruto) return null;
    const s = JSON.parse(bruto) as SessaoPortal;
    if (!s.token || !s.expiresAt) return null;
    return new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/** O token válido, ou `null`. Atalho para quem só precisa do token. */
export function tokenDoPortal(): string | null {
  return lerSessaoPortal()?.token ?? null;
}

/**
 * O evento que o cabeçalho ouve para trocar "Entre" por "Olá, fulano" na hora
 * do login, sem recarregar a página. O `storage` do navegador só dispara entre
 * ABAS diferentes; dentro da mesma aba, quem avisa é este evento.
 */
export const PORTAL_EVENT = 'gs:portal-changed';

export function guardarSessaoPortal(s: SessaoPortal | null): void {
  try {
    if (s) localStorage.setItem(PORTAL_KEY, JSON.stringify(s));
    else localStorage.removeItem(PORTAL_KEY);
  } catch {
    // Sem storage a sessão vale só nesta aba. Não é motivo para quebrar a tela.
  }
  try {
    window.dispatchEvent(new Event(PORTAL_EVENT));
  } catch {
    // Fora do navegador (teste de nó), não há window. Sem evento, sem drama.
  }
}

/** Apaga a sessão. Usado quando o servidor responde 401 (token revogado). */
export function limparSessaoPortal(): void {
  guardarSessaoPortal(null);
}

/**
 * Toda chamada do portal leva o token no cabeçalho próprio (`x-portal-token`),
 * nunca no `Authorization` — que é da sessão do ERP. `anonymous: true` impede
 * o cliente da API de anexar o Bearer administrativo por engano.
 */
export function comTokenPortal<T>(
  caminho: string,
  token: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  return apiRequest<T>(caminho, {
    anonymous: true,
    headers: { 'x-portal-token': token },
    ...init,
  });
}
