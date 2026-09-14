/**
 * Caixas (terminais de PDV), as gavetas abertas e o token de dispositivo
 * (GAP-PRD-039, GAP-PRD-146, GAP-PRD-150, GAP-PRD-131).
 *
 * Nenhuma chamada recebe `companyId`: o escopo vem da sessão no servidor, e o
 * caixa de outra operação responde 404 (ou 400, onde ele é só referência).
 *
 * Também mora aqui o que ESTE COMPUTADOR sabe de si: qual caixa ele é (quando
 * a sessão é de senha) e o token de dispositivo guardado (quando ele foi
 * registrado). As duas coisas vivem no `localStorage` da máquina porque são da
 * máquina, não da pessoa — trocar de operador não troca o caixa.
 */
import { apiRequest, envelope } from './client';

export interface TerminalDeCaixa {
  id: string;
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
  deactivationReason: string | null;
  caixaAberto: {
    sessionId: string;
    openedAt: string;
    openedByName: string | null;
    deOutroDia: GavetaDeOutroDia | null;
  } | null;
  tokensAtivos: number;
}

/** A gaveta foi aberta num dia da loja anterior a hoje. */
export interface GavetaDeOutroDia {
  abertaNoDia: string;
  hoje: string;
  dias: number;
}

/** Uma gaveta aberta da operação, com o caixa e quem abriu pelo nome. */
export interface GavetaAberta {
  sessionId: string;
  terminalId: string | null;
  terminalName: string | null;
  terminalCode: string | null;
  openedAt: string;
  openedBy: string;
  openedByName: string | null;
  openingCents: number;
  expectedCents: number;
  deOutroDia: GavetaDeOutroDia | null;
}

/** Um token de dispositivo como a lista o mostra — NUNCA o token em si. */
export interface TokenDeDispositivo {
  id: string;
  label: string | null;
  userId: string;
  userLogin: string;
  userDisplayName: string;
  terminalId: string | null;
  terminalName: string | null;
  terminalActive: boolean | null;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const terminaisApi = {
  listar: (somenteAtivos = false) =>
    apiRequest<{ items: TerminalDeCaixa[] }>(`/core/terminals${somenteAtivos ? '?ativos=1' : ''}`).then(
      envelope('items'),
    ),

  criar: (name: string) =>
    apiRequest<TerminalDeCaixa>('/core/terminals', { method: 'POST', body: { name } }),

  renomear: (id: string, name: string) =>
    apiRequest<TerminalDeCaixa>(`/core/terminals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { name },
    }),

  /** Motivo obrigatório; o servidor recusa com a gaveta do caixa aberta. */
  desativar: (id: string, reason: string) =>
    apiRequest<TerminalDeCaixa>(`/core/terminals/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
      body: { reason },
    }),

  ativar: (id: string) =>
    apiRequest<TerminalDeCaixa>(`/core/terminals/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: {},
    }),

  gavetasAbertas: () =>
    apiRequest<{ items: GavetaAberta[]; deOutroDia: number }>('/core/cash/drawers'),

  // ------------------------------------------------ token de dispositivo

  dispositivos: () =>
    apiRequest<{ items: TokenDeDispositivo[] }>('/auth/devices').then(envelope('items')),

  /** O token vem em claro SÓ nesta resposta; o servidor guarda o hash. */
  registrarDispositivo: (input: { userId: string; label: string; terminalId: string | null }) =>
    apiRequest<{ id: string; deviceToken: string; label: string; terminalId: string | null }>(
      '/auth/device/enroll',
      { method: 'POST', body: { ...input, terminalId: input.terminalId ?? undefined } },
    ),

  revogarDispositivo: (id: string, reason: string) =>
    apiRequest<{ id: string; revoked: true }>(`/auth/device/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
      body: { reason },
    }),
};

// ------------------------------------------------------ este computador

/**
 * A MESMA chave que a tela de login lê (`LoginPage`, `DEVICE_TOKEN_KEY`): é
 * ela que faz aparecer "Entrar no PDV deste terminal" na aba do PDV.
 */
export const CHAVE_TOKEN_DO_COMPUTADOR = 'gs.deviceToken';

const chaveDoCaixa = (companyId: string) => `gs.pdv.terminal.${companyId}`;

function ler(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    return null;
  }
}

function gravar(chave: string, valor: string | null): void {
  try {
    if (valor) localStorage.setItem(chave, valor);
    else localStorage.removeItem(chave);
  } catch {
    // Navegador sem armazenamento: a escolha vale só nesta tela aberta.
  }
}

/** Qual caixa este computador é, nesta operação (sessão de senha). */
export function caixaDesteComputador(companyId: string | null | undefined): string | null {
  return companyId ? ler(chaveDoCaixa(companyId)) : null;
}

export function guardarCaixaDesteComputador(companyId: string, terminalId: string | null): void {
  gravar(chaveDoCaixa(companyId), terminalId);
}

export function tokenDesteComputador(): string | null {
  return ler(CHAVE_TOKEN_DO_COMPUTADOR);
}

export function guardarTokenNesteComputador(token: string | null): void {
  gravar(CHAVE_TOKEN_DO_COMPUTADOR, token);
}

/** `2026-08-12` → `12/08/2026`. */
export function diaBr(dia: string): string {
  const [ano, mes, d] = dia.split('-');
  return `${d}/${mes}/${ano}`;
}

/** A frase da gaveta esquecida (GAP-PRD-131), a mesma em todo lugar que a mostra. */
export function fraseDaGavetaDeOutroDia(g: GavetaDeOutroDia): string {
  const ha = g.dias === 1 ? 'há 1 dia' : `há ${g.dias} dias`;
  return `Esta gaveta está aberta desde ${diaBr(g.abertaNoDia)} (${ha}). `
    + 'Conte o dinheiro e feche este turno antes de vender hoje — senão as vendas de hoje '
    + 'entram na conferência daquele dia.';
}
