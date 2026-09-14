export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CHAVE_SECRETA = /api[_-]?key|secret|token|password|cvv|card|authorization|access_token|webhook/i;

/*
  UM ERROR NO LOG DIZ QUAL FOI O ERRO (GAP-PRD-059).

  `message` e `stack` de um `Error` não são enumeráveis: percorrer
  `Object.entries` devolvia `{}`, e `logError('backup_diario_falhou', { err })`
  saía sem causa nenhuma — disco cheio e pasta sem permissão viravam a mesma
  linha. Agora o erro vira objeto comum com nome, mensagem, pilha curta (a
  primeira linha e quatro quadros), o `code` do sistema operacional quando
  houver, os campos próprios (o `code` e o `status` de `ApiError`) e a causa
  encadeada. Tudo passa pela mesma máscara de segredo.

  `caminho` guarda só os ANCESTRAIS do valor em curso: um objeto que aponta
  para si mesmo (a causa que é o próprio erro) vira '[circular]' em vez de
  estourar a pilha, e o mesmo objeto citado duas vezes, sem ciclo, sai duas
  vezes.
*/
const QUADROS_DA_PILHA = 4;

function erroParaLog(erro: Error, caminho: Set<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: erro.name,
    message: sanitizeForLog(erro.message, caminho),
  };
  if (erro.stack) {
    out.stack = sanitizeForLog(
      erro.stack
        .split('\n')
        .slice(0, QUADROS_DA_PILHA + 1)
        .map((l) => l.trim())
        .join(' | '),
      caminho,
    );
  }
  for (const [k, v] of Object.entries(erro)) {
    if (k in out) continue;
    out[k] = CHAVE_SECRETA.test(k) ? '[REDACTED]' : sanitizeForLog(v, caminho);
  }
  const causa = (erro as { cause?: unknown }).cause;
  if (causa !== undefined && !('cause' in out)) out.cause = sanitizeForLog(causa, caminho);
  return out;
}

export function sanitizeForLog(value: unknown, caminho: Set<object> = new Set()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/\$aact_[A-Za-z0-9_]+/g, '[REDACTED_ASAAS_KEY]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/access_token["']?\s*[:=]\s*["'][^"']+["']/gi, 'access_token:"[REDACTED]"')
      .replace(/api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/gi, 'apiKey:"[REDACTED]"');
  }
  if (typeof value !== 'object') return value;
  if (caminho.has(value)) return '[circular]';
  caminho.add(value);
  try {
    if (value instanceof Error) return erroParaLog(value, caminho);
    if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, caminho));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = CHAVE_SECRETA.test(k) ? '[REDACTED]' : sanitizeForLog(v, caminho);
    }
    return out;
  } finally {
    caminho.delete(value);
  }
}

/*
  O LOG_LEVEL VALE (GAP-PRD-153).

  A chave estava no schema, validada e documentada nos três exemplos, e este
  logger não a lia: `logInfo` imprimia sempre. A ordem é debug < info < warn <
  error. O nível é lido A CADA CHAMADA — este módulo é importado por tudo,
  antes de o `.env` ser lido, e congelar o nível na importação o travaria no
  padrão. Valor estranho cai em `info` em vez de calar o log: quem recusa valor
  inválido é o boot (`loadEnv`).
*/
const ORDEM_DOS_NIVEIS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type NivelDeLog = keyof typeof ORDEM_DOS_NIVEIS;

function sai(nivel: NivelDeLog): boolean {
  const configurado = (process.env.LOG_LEVEL ?? '').trim().toLowerCase() as NivelDeLog;
  const minimo = ORDEM_DOS_NIVEIS[configurado] ?? ORDEM_DOS_NIVEIS.info;
  return ORDEM_DOS_NIVEIS[nivel] >= minimo;
}

function linha(level: NivelDeLog, message: string, meta?: Record<string, unknown>): string {
  const payload = meta ? sanitizeForLog(meta) : undefined;
  return JSON.stringify({ level, message, ...((payload as object) ?? {}) });
}

export function logDebug(message: string, meta?: Record<string, unknown>): void {
  if (sai('debug')) console.log(linha('debug', message, meta));
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  if (sai('info')) console.log(linha('info', message, meta));
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (sai('warn')) console.warn(linha('warn', message, meta));
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  if (sai('error')) console.error(linha('error', message, meta));
}
