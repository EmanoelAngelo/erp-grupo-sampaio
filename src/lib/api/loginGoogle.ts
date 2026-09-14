/**
 * "Entrar com Google" — o lado do navegador (GAP-PRD-027).
 *
 * Módulo próprio, fora de `core.ts`: é um assunto só e cabe aqui.
 *
 * O navegador NUNCA vê o segredo do cliente OAuth nem troca código por token:
 * isso é do servidor. O que fica aqui é o que só o navegador pode guardar — a
 * CHAVE DO NAVEGADOR que começou a entrada (no `sessionStorage`, desta aba)
 * e para onde voltar depois. É ela que impede um link de volta aberto em
 * outro navegador de concluir a entrada de outra pessoa.
 */
import { apiRequest } from './client';
import type { SessaoPortal } from '../portalSession';

// ------------------------------------------------------------ o cliente

export type ModoDoGoogle = 'google' | 'teste';

export interface InicioDoGoogle {
  authorizationUrl: string;
  browserKey: string;
  expiresAt: string;
  modo: ModoDoGoogle;
}

export type ResultadoDoGoogle =
  | { status: 'sessao'; session: SessaoPortal; returnTo: string | null; contaNova: boolean }
  | { status: 'termos_pendentes'; ticket: string; email: string; name: string | null; returnTo: string | null }
  | { status: 'vinculado'; googleEmail: string; returnTo: string | null };

export interface GoogleNaConta {
  disponivel: boolean;
  modo: ModoDoGoogle | null;
  ligado: { email: string | null; desde: string; ultimaEntrada: string | null } | null;
  temSenha: boolean;
}

function portal(token: string | null | undefined): Record<string, string> {
  return token ? { 'x-portal-token': token } : {};
}

export const googlePortalApi = {
  disponivel: () =>
    apiRequest<{ disponivel: boolean; modo: ModoDoGoogle | null }>('/loja/portal/google/disponivel', {
      anonymous: true,
    }),
  iniciar: (body: { intent?: 'entrar' | 'vincular'; termsAccepted?: boolean; returnTo?: string | null }, token?: string | null) =>
    apiRequest<InicioDoGoogle>('/loja/portal/google/iniciar', {
      method: 'POST',
      anonymous: true,
      headers: portal(token),
      body,
    }),
  concluir: (body: { code: string; state: string; browserKey: string }, token?: string | null) =>
    apiRequest<ResultadoDoGoogle>('/loja/portal/google/concluir', {
      method: 'POST',
      anonymous: true,
      headers: portal(token),
      body,
    }),
  aceitarTermos: (body: { ticket: string; browserKey: string; termsAccepted: boolean }) =>
    apiRequest<{ status: 'sessao'; session: SessaoPortal; returnTo: string | null; contaNova: boolean }>(
      '/loja/portal/google/aceitar-termos',
      { method: 'POST', anonymous: true, body },
    ),
  naConta: (token: string) =>
    apiRequest<GoogleNaConta>('/loja/portal/google/conta', { anonymous: true, headers: portal(token) }),
  desligar: (token: string) =>
    apiRequest<GoogleNaConta>('/loja/portal/google/conta', {
      method: 'DELETE',
      anonymous: true,
      headers: portal(token),
    }),
};

// ------------------------------------------- o que a aba guarda na ida

/** Chave do `sessionStorage`: da aba, some quando a aba fecha. */
const CHAVE_DA_IDA = 'gs.portal.google';

export interface IdaAoGoogle {
  browserKey: string;
  intent: 'entrar' | 'vincular';
  returnTo: string | null;
  /** Quando começou — a volta depois de 15 minutos é descartada. */
  em: number;
}

export function guardarIda(ida: IdaAoGoogle): void {
  try {
    sessionStorage.setItem(CHAVE_DA_IDA, JSON.stringify(ida));
  } catch {
    // Sem storage não há como provar que é o mesmo navegador; o servidor
    // recusa a volta e a pessoa entra com e-mail e senha.
  }
}

export function lerIda(): IdaAoGoogle | null {
  try {
    const bruto = sessionStorage.getItem(CHAVE_DA_IDA);
    if (!bruto) return null;
    const ida = JSON.parse(bruto) as IdaAoGoogle;
    if (!ida.browserKey || Date.now() - Number(ida.em) > 15 * 60 * 1000) return null;
    return ida;
  } catch {
    return null;
  }
}

export function esquecerIda(): void {
  try {
    sessionStorage.removeItem(CHAVE_DA_IDA);
  } catch {
    // nada a esquecer
  }
}

/** Só caminho interno: `/algo`, nunca `//outro-site` nem endereço completo. */
export function voltaInterna(valor: string | null | undefined): string | null {
  if (!valor || !/^\/(?!\/)[\w\-/]*(\?[\w=&\-%.]*)?$/.test(valor)) return null;
  return valor;
}

// ------------------------------------------------ a configuração (ERP)

export type EstadoDaProntidao = 'desligado' | 'pronto' | 'pronto_teste' | 'bloqueado';

export interface ConfiguracaoDoGoogle {
  enabled: boolean;
  providerMode: ModoDoGoogle;
  clientId: string | null;
  secretConfigured: boolean;
  secretHint: string | null;
  redirectUri: string | null;
  redirectUriSugerido: string;
  enderecoPublicoConfigurado: boolean;
  provedorDeTestePermitido: boolean;
  prontidao: { estado: EstadoDaProntidao; falta: string[]; mensagem: string };
  updatedAt: string | null;
  updatedBy: string | null;
}

export const googleConfigApi = {
  obter: () => apiRequest<ConfiguracaoDoGoogle>('/core/portal/login-google'),
  salvar: (body: {
    enabled: boolean;
    providerMode: ModoDoGoogle;
    clientId: string;
    /** Em branco mantém o segredo guardado. */
    clientSecret: string;
    redirectUri: string;
  }) => apiRequest<ConfiguracaoDoGoogle>('/core/portal/login-google', { method: 'PUT', body }),
};
