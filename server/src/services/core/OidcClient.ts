/**
 * O cliente OpenID Connect, sem biblioteca — e por que dá para ser assim.
 *
 * O "Entrar com Google" (GAP-PRD-027) precisa de quatro coisas, e as quatro
 * são primitivas que o `node:crypto` já tem:
 *
 *   1. PKCE (RFC 7636): um verificador aleatório que só o servidor conhece e
 *      o SHA-256 dele na URL. Quem interceptar o `code` na volta não troca
 *      por token nenhum sem o verificador.
 *   2. A troca do código por tokens no endpoint do provedor, com o segredo
 *      do cliente — do servidor para o provedor, nunca pelo navegador.
 *   3. A verificação do id_token: assinatura RS256 contra a chave publicada
 *      pelo provedor (JWKS), emissor, audiência, validade e o NONCE que o
 *      servidor gravou ao começar. Um id_token de outro site, vencido, sem
 *      assinatura (`alg: none`) ou assinado com segredo simétrico (`HS256`,
 *      o golpe clássico de trocar o algoritmo) é recusado.
 *   4. O cache das chaves, com releitura quando aparece um `kid` novo — o
 *      Google gira as chaves de tempos em tempos.
 *
 * Uma biblioteca OIDC inteira traria descoberta dinâmica, sessões, cookies
 * e dezenas de opções que este fluxo não usa, e cada opção é um lugar onde a
 * conferência pode ser desligada sem ninguém ver. Aqui cada conferência está
 * escrita e tem teste.
 *
 * O TRANSPORTE É INJETÁVEL. O servidor fala com o Google por `fetch`; os
 * testes e o provedor de teste falam com funções em processo. Nenhum teste
 * sai para a rede.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verificarAssinatura,
  type JsonWebKey,
} from 'node:crypto';
import { ApiError } from '../../utils/errors.js';

/** Quem leva as duas chamadas do servidor ao provedor. */
export interface TransporteOidc {
  /** POST `application/x-www-form-urlencoded`. */
  postarFormulario(
    url: string,
    campos: Record<string, string>,
  ): Promise<{ status: number; corpo: unknown }>;
  /** GET de JSON, com o `max-age` do Cache-Control (segundos) quando houver. */
  lerJson(url: string): Promise<{ status: number; corpo: unknown; maxAgeSeg: number | null }>;
}

/** Dez segundos: o cliente está parado olhando a tela de "entrando...". */
const PRAZO_DA_REDE_MS = 10_000;

function maxAgeDe(cabecalho: string | null): number | null {
  const achado = /max-age=(\d+)/i.exec(cabecalho ?? '');
  return achado ? Number(achado[1]) : null;
}

/** O corpo em JSON, ou nulo quando o provedor devolveu outra coisa. */
async function jsonOuNulo(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

/** O transporte de verdade: `fetch` com prazo. */
export const transporteHttp: TransporteOidc = {
  async postarFormulario(url, campos) {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(campos).toString(),
      signal: AbortSignal.timeout(PRAZO_DA_REDE_MS),
    });
    return { status: resposta.status, corpo: await jsonOuNulo(resposta) };
  },
  async lerJson(url) {
    const resposta = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PRAZO_DA_REDE_MS),
    });
    return {
      status: resposta.status,
      corpo: await jsonOuNulo(resposta),
      maxAgeSeg: maxAgeDe(resposta.headers.get('cache-control')),
    };
  },
};

// ------------------------------------------------------------- aleatórios

/** Texto aleatório em base64url — `state`, `nonce`, chave do navegador. */
export function aleatorio(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Impressão digital: guarda-se ISTO, nunca o valor que abre alguma porta. */
export function impressao(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/** Compara duas impressões em tempo constante. */
export function mesmaImpressao(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * O par do PKCE (RFC 7636, método S256).
 *
 * 48 bytes viram 64 caracteres base64url — dentro dos 43..128 da norma.
 */
export function gerarPkce(): { verificador: string; desafio: string } {
  const verificador = randomBytes(48).toString('base64url');
  return { verificador, desafio: desafioDoPkce(verificador) };
}

export function desafioDoPkce(verificador: string): string {
  return createHash('sha256').update(verificador).digest('base64url');
}

// ---------------------------------------------------------- autorização

export function montarUrlDeAutorizacao(p: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  desafioPkce: string;
}): string {
  const url = new URL(p.endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  // `openid` é o que torna isto OIDC (vem o id_token); `email` traz o e-mail
  // e se ele foi verificado; `profile` traz o nome. Nada além disso é pedido:
  // o sistema não lê agenda, contatos nem Drive de ninguém.
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', p.desafioPkce);
  url.searchParams.set('code_challenge_method', 'S256');
  // Quem tem duas contas Google escolhe qual — entrar com a conta errada em
  // silêncio criaria uma segunda conta na loja sem a pessoa perceber.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

// ------------------------------------------------------------ troca

export async function trocarCodigoPorIdToken(p: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  verificadorPkce: string;
  redirectUri: string;
  transporte: TransporteOidc;
}): Promise<string> {
  let resposta: { status: number; corpo: unknown };
  try {
    resposta = await p.transporte.postarFormulario(p.endpoint, {
      grant_type: 'authorization_code',
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.verificadorPkce,
    });
  } catch {
    throw new ApiError(
      'PORTAL_GOOGLE_INDISPONIVEL',
      'Não foi possível falar com o Google agora. Tente entrar de novo em instantes.',
      502,
    );
  }

  const corpo = (resposta.corpo ?? {}) as Record<string, unknown>;
  if (resposta.status >= 400) {
    // `invalid_grant` = código vencido, já usado ou de outro verificador.
    // O texto do provedor NÃO vai para a tela: pode carregar detalhe da
    // configuração do cliente OAuth, que não é assunto do comprador.
    const erro = typeof corpo.error === 'string' ? corpo.error : 'erro';
    if (erro === 'invalid_client' || erro === 'unauthorized_client') {
      throw new ApiError(
        'PORTAL_GOOGLE_CLIENTE_RECUSADO',
        'O Google recusou a configuração desta loja. Avise a loja — a entrada pelo Google precisa ser revista.',
        502,
        { erroDoProvedor: erro },
      );
    }
    throw new ApiError(
      'PORTAL_GOOGLE_CODIGO_RECUSADO',
      'O Google não aceitou esta volta (ela vence em poucos minutos e vale uma vez só). Tente entrar de novo.',
      400,
      { erroDoProvedor: erro },
    );
  }

  const idToken = corpo.id_token;
  if (typeof idToken !== 'string' || !idToken) {
    throw new ApiError(
      'PORTAL_GOOGLE_INDISPONIVEL',
      'O Google respondeu sem a identificação. Tente entrar de novo.',
      502,
    );
  }
  // O access_token que veio junto é DESCARTADO aqui: o sistema não chama
  // nenhuma API do Google em nome de ninguém, então não há o que guardar.
  return idToken;
}

// ----------------------------------------------------- id_token

export interface ClaimsDoIdToken {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

/** Recusa uniforme: o motivo fica em `details`, para log e teste. */
function tokenInvalido(motivo: string): ApiError {
  return new ApiError(
    'PORTAL_GOOGLE_TOKEN_INVALIDO',
    'A identificação que voltou do Google não passou na conferência. Tente entrar de novo.',
    401,
    { motivo },
  );
}

/** A chave do `kid` não está no conjunto — o chamador relê as chaves. */
export class ChaveDesconhecida extends Error {}

function decodificarParte<T>(parte: string, motivo: string): T {
  try {
    return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')) as T;
  } catch {
    throw tokenInvalido(motivo);
  }
}

/** RS256 contra a chave publicada. Chave malformada é assinatura que não confere. */
function assinaturaConfere(conteudo: string, assinatura: string, jwk: JsonWebKey): boolean {
  try {
    return verificarAssinatura(
      'RSA-SHA256',
      Buffer.from(conteudo),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(assinatura, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** Tolerância de relógio: dois minutos, para servidor e provedor fora de sincronia. */
const TOLERANCIA_SEG = 120;

export function verificarIdToken(p: {
  idToken: string;
  chaves: JsonWebKey[];
  emissores: string[];
  clientId: string;
  nonce: string;
  agoraSeg?: number;
}): ClaimsDoIdToken {
  const partes = p.idToken.split('.');
  if (partes.length !== 3 || partes.some((x) => !x)) throw tokenInvalido('formato');
  const [h, c, s] = partes as [string, string, string];

  const cabecalho = decodificarParte<{ alg?: string; kid?: string; typ?: string }>(h, 'cabecalho');
  // SÓ RS256. `none` é token sem assinatura; `HS256` com a chave pública
  // como segredo é o golpe de confusão de algoritmo. O Google assina RS256.
  if (cabecalho.alg !== 'RS256') throw tokenInvalido('algoritmo');
  if (typeof cabecalho.kid !== 'string' || !cabecalho.kid) throw tokenInvalido('kid');

  const jwk = p.chaves.find((k) => (k as { kid?: string }).kid === cabecalho.kid);
  if (!jwk) throw new ChaveDesconhecida(cabecalho.kid);
  if (jwk.kty !== 'RSA') throw tokenInvalido('chave');

  if (!assinaturaConfere(`${h}.${c}`, s, jwk)) throw tokenInvalido('assinatura');

  const claims = decodificarParte<ClaimsDoIdToken>(c, 'conteudo');
  const agora = p.agoraSeg ?? Math.floor(Date.now() / 1000);

  if (!p.emissores.includes(String(claims.iss))) throw tokenInvalido('emissor');

  const audiencias = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiencias.includes(p.clientId)) throw tokenInvalido('audiencia');
  // Mais de uma audiência exige `azp` = este cliente (OIDC Core 3.1.3.7).
  if (audiencias.length > 1 && claims.azp !== p.clientId) throw tokenInvalido('azp');
  if (claims.azp !== undefined && claims.azp !== p.clientId) throw tokenInvalido('azp');

  if (typeof claims.exp !== 'number' || claims.exp + TOLERANCIA_SEG < agora) {
    throw tokenInvalido('expirado');
  }
  if (typeof claims.iat !== 'number' || claims.iat - TOLERANCIA_SEG > agora) {
    throw tokenInvalido('emitido_no_futuro');
  }

  // O NONCE amarra o token a ESTE pedido de entrada: um id_token capturado de
  // outra entrada (ou de outro site com o mesmo cliente) não serve aqui.
  if (typeof claims.nonce !== 'string' || !mesmaImpressao(impressao(claims.nonce), impressao(p.nonce))) {
    throw tokenInvalido('nonce');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw tokenInvalido('sub');

  return claims;
}

// -------------------------------------------------- cache das chaves

/**
 * Um minuto entre releituras FORÇADAS: um `kid` inventado a cada tentativa
 * não vira uma chamada ao provedor por tentativa. A leitura normal (cache
 * vencido) não conta — a chave girada logo depois dela ainda é achada.
 */
const INTERVALO_MINIMO_DE_RELEITURA_MS = 60_000;
/** Sem Cache-Control, uma hora. */
const VALIDADE_PADRAO_SEG = 3600;

export class CacheDeChaves {
  private chaves: JsonWebKey[] = [];
  private validoAte = 0;
  private ultimaForcada = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly url: string,
    private readonly transporte: TransporteOidc,
    private readonly relogio: () => number = () => Date.now(),
  ) {}

  async obter(forcar = false): Promise<JsonWebKey[]> {
    const agora = this.relogio();
    if (!forcar && this.chaves.length > 0 && agora < this.validoAte) return this.chaves;
    if (forcar && this.chaves.length > 0 && agora - this.ultimaForcada < INTERVALO_MINIMO_DE_RELEITURA_MS) {
      return this.chaves;
    }
    if (forcar) this.ultimaForcada = agora;

    let resposta: { status: number; corpo: unknown; maxAgeSeg: number | null };
    try {
      resposta = await this.transporte.lerJson(this.url);
    } catch {
      if (this.chaves.length > 0) return this.chaves;
      throw new ApiError(
        'PORTAL_GOOGLE_INDISPONIVEL',
        'Não foi possível conferir a identificação com o Google agora. Tente de novo em instantes.',
        502,
      );
    }
    const keys = (resposta.corpo as { keys?: unknown } | null)?.keys;
    if (resposta.status >= 400 || !Array.isArray(keys)) {
      if (this.chaves.length > 0) return this.chaves;
      throw new ApiError(
        'PORTAL_GOOGLE_INDISPONIVEL',
        'O Google não entregou as chaves de conferência. Tente de novo em instantes.',
        502,
      );
    }
    this.chaves = keys as JsonWebKey[];
    this.validoAte = agora + (resposta.maxAgeSeg ?? VALIDADE_PADRAO_SEG) * 1000;
    return this.chaves;
  }
}

/**
 * Verifica com o cache: se o `kid` for novo, relê as chaves UMA vez.
 */
export async function verificarIdTokenComCache(
  cache: CacheDeChaves,
  p: Omit<Parameters<typeof verificarIdToken>[0], 'chaves'>,
): Promise<ClaimsDoIdToken> {
  try {
    return verificarIdToken({ ...p, chaves: await cache.obter() });
  } catch (err) {
    if (!(err instanceof ChaveDesconhecida)) throw err;
  }
  try {
    return verificarIdToken({ ...p, chaves: await cache.obter(true) });
  } catch (err) {
    if (err instanceof ChaveDesconhecida) throw tokenInvalido('kid_desconhecido');
    throw err;
  }
}
