/**
 * Escopo ativo — quem está operando, e em qual operação.
 *
 * Existe porque uma vez, num E2E, a operação ativa saiu de PJ Motors e virou
 * Me Mimei sem ninguém ter escolhido. Não foi possível reproduzir. Um bug de
 * tenant que não se reproduz não é um bug pequeno: é um bug que ninguém vê
 * acontecer, e que na próxima vez despacha estoque, emite nota e lança
 * financeiro na empresa errada.
 *
 * A resposta não foi caçar o caso. Foi tornar a troca silenciosa IMPOSSÍVEL:
 *
 * 1. Toda mudança de sessão declara um MOTIVO. Sem motivo não há troca.
 * 2. Só alguns motivos podem mudar de operação. Renovação de token e
 *    restauração de sessão NÃO podem — se mudarem, é erro, e o erro estoura.
 * 3. A operação exibida tem de ser a mesma do token. Divergir aqui significa
 *    a tela dizendo "PJ Motors" enquanto o servidor grava em Me Mimei.
 * 4. Toda transição fica registrada, com o antes e o depois, para que a
 *    próxima ocorrência tenha rastro em vez de memória.
 *
 * O registro NUNCA guarda token, senha ou credencial — só identificadores de
 * escopo e o motivo.
 */

/** Motivos autorizados. Qualquer outro valor é erro de programação. */
export type ScopeChangeReason =
  | 'LOGIN'
  | 'DEVICE_LOGIN'
  | 'EXPLICIT_OPERATION_CHANGE'
  | 'SESSION_RESTORE_VALIDATED'
  | 'TOKEN_REFRESH'
  | 'LOGOUT';

/**
 * Motivos que PODEM mudar a operação ativa.
 *
 * A lista é curta de propósito. Renovar token e restaurar sessão ficam de
 * fora: os dois acontecem sozinhos, sem ninguém olhando, e é exatamente aí
 * que uma troca silenciosa passaria despercebida.
 */
const PODEM_TROCAR_OPERACAO: ReadonlySet<ScopeChangeReason> = new Set<ScopeChangeReason>([
  'LOGIN',
  'DEVICE_LOGIN',
  'EXPLICIT_OPERATION_CHANGE',
  'LOGOUT',
]);

export interface ActiveScope {
  userId: string | null;
  companyId: string | null;
  /** Unidade operacional do token (`storeId`), quando a sessão é de terminal. */
  unitId: string | null;
  pdvId: string | null;
  workshopId: string | null;
}

export const ESCOPO_VAZIO: ActiveScope = {
  userId: null,
  companyId: null,
  unitId: null,
  pdvId: null,
  workshopId: null,
};

export interface ScopeChangeEntry {
  previousCompanyId: string | null;
  newCompanyId: string | null;
  previousUnitId: string | null;
  newUnitId: string | null;
  previousPdvId: string | null;
  newPdvId: string | null;
  previousWorkshopId: string | null;
  newWorkshopId: string | null;
  reason: ScopeChangeReason;
  /** De onde partiu a chamada — `AppShell.handleSwitch`, `client.refresh`… */
  source: string;
  userId: string | null;
  timestamp: string;
}

export class ScopeViolationError extends Error {
  readonly reason: ScopeChangeReason;

  readonly previousCompanyId: string | null;

  readonly newCompanyId: string | null;

  constructor(input: {
    message: string;
    reason: ScopeChangeReason;
    previousCompanyId: string | null;
    newCompanyId: string | null;
  }) {
    super(input.message);
    this.name = 'ScopeViolationError';
    this.reason = input.reason;
    this.previousCompanyId = input.previousCompanyId;
    this.newCompanyId = input.newCompanyId;
  }
}

// ------------------------------------------------------------------ registro

/**
 * Diário em memória.
 *
 * Fica limitado porque é diagnóstico, não auditoria: a auditoria de verdade é
 * a do servidor, em `core_audit_log`. Aqui o objetivo é responder "o que
 * aconteceu nos últimos minutos desta aba".
 */
const LIMITE = 100;
const diario: ScopeChangeEntry[] = [];
const ouvintes = new Set<(entry: ScopeChangeEntry) => void>();

export function scopeJournal(): readonly ScopeChangeEntry[] {
  return diario;
}

export function clearScopeJournal(): void {
  diario.length = 0;
}

export function onScopeChange(listener: (entry: ScopeChangeEntry) => void): () => void {
  ouvintes.add(listener);
  return () => ouvintes.delete(listener);
}

function registrar(entry: ScopeChangeEntry): void {
  diario.push(entry);
  if (diario.length > LIMITE) diario.shift();
  for (const ouvinte of ouvintes) ouvinte(entry);
}

/** Em desenvolvimento a troca aparece no console; em produção, só no diário. */
function ehDesenvolvimento(): boolean {
  try {
    return import.meta.env?.DEV === true || import.meta.env?.MODE === 'test';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ o token

interface PayloadToken {
  sub?: string;
  companyId?: string;
  storeId?: string;
}

/**
 * Escopo REAL da sessão: o que está dentro do token.
 *
 * A leitura é do payload, sem verificar assinatura — e não precisa verificar:
 * quem valida o token é o servidor, a cada requisição. Aqui o payload serve
 * só para conferir se a tela está mostrando a mesma operação que o servidor
 * vai usar.
 */
export function scopeFromToken(accessToken: string | null | undefined): {
  userId: string | null;
  companyId: string | null;
  unitId: string | null;
} {
  if (!accessToken) return { userId: null, companyId: null, unitId: null };
  const partes = accessToken.split('.');
  if (partes.length !== 3) return { userId: null, companyId: null, unitId: null };
  try {
    const base64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const payload = JSON.parse(json) as PayloadToken;
    return {
      userId: payload.sub ?? null,
      companyId: payload.companyId ?? null,
      unitId: payload.storeId ?? null,
    };
  } catch {
    // Token ilegível não é motivo para derrubar a tela; a requisição seguinte
    // recebe 401 e o fluxo normal de sessão resolve.
    return { userId: null, companyId: null, unitId: null };
  }
}

// ------------------------------------------------------------------ a regra

/**
 * Autoriza (ou recusa) uma transição de escopo, e registra o que aconteceu.
 *
 * Recusa é exceção, não `console.warn`: um caminho que troca de empresa sem
 * poder é um defeito, e defeito silencioso foi justamente o que gerou este
 * arquivo.
 */
export function assertScopeChange(input: {
  previous: ActiveScope;
  next: ActiveScope;
  reason: ScopeChangeReason;
  source: string;
}): ScopeChangeEntry {
  const { previous, next, reason, source } = input;

  const entry: ScopeChangeEntry = {
    previousCompanyId: previous.companyId,
    newCompanyId: next.companyId,
    previousUnitId: previous.unitId,
    newUnitId: next.unitId,
    previousPdvId: previous.pdvId,
    newPdvId: next.pdvId,
    previousWorkshopId: previous.workshopId,
    newWorkshopId: next.workshopId,
    reason,
    source,
    userId: next.userId ?? previous.userId,
    timestamp: new Date().toISOString(),
  };

  const trocou =
    previous.companyId !== null
    && next.companyId !== null
    && previous.companyId !== next.companyId;

  if (trocou && !PODEM_TROCAR_OPERACAO.has(reason)) {
    registrar(entry);
    throw new ScopeViolationError({
      message:
        `A operação ativa mudou de ${previous.companyId} para ${next.companyId} `
        + `por "${reason}" (${source}), que não pode trocar de operação. `
        + 'Troca de operação exige ação explícita de quem opera.',
      reason,
      previousCompanyId: previous.companyId,
      newCompanyId: next.companyId,
    });
  }

  registrar(entry);

  if (ehDesenvolvimento() && (trocou || previous.unitId !== next.unitId)) {
    // Sem token, sem credencial: só o escopo e o porquê.
    console.info(
      '[escopo] %s → %s por %s (%s)',
      previous.companyId ?? '—',
      next.companyId ?? '—',
      reason,
      source,
    );
  }

  return entry;
}

/**
 * A operação exibida é a mesma do token?
 *
 * Quando diverge, a tela mostra uma empresa e o servidor grava em outra. Não
 * existe grau de gravidade aqui: ou são a mesma, ou a sessão está mentindo.
 */
export function assertScopeMatchesToken(input: {
  companyId: string | null;
  accessToken: string | null;
  source: string;
}): void {
  const doToken = scopeFromToken(input.accessToken);
  if (!doToken.companyId || !input.companyId) return;
  if (doToken.companyId === input.companyId) return;

  throw new ScopeViolationError({
    message:
      `A sessão exibe a operação ${input.companyId} mas o token vale para `
      + `${doToken.companyId} (${input.source}). A tela estaria mostrando uma `
      + 'empresa enquanto o servidor grava em outra.',
    reason: 'EXPLICIT_OPERATION_CHANGE',
    previousCompanyId: input.companyId,
    newCompanyId: doToken.companyId,
  });
}
