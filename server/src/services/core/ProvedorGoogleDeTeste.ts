/**
 * O PROVEDOR DE TESTE — um "Google" que mora dentro da API (GAP-PRD-027).
 *
 * Para quê. O login Google só se prova ponta a ponta com um provedor que
 * emita `code`, troque por id_token assinado e publique a chave. Sem ele, a
 * auditoria registrou "UNABLE_TO_PROVE: não há adapter para falsear". Este
 * arquivo é esse adapter: faz o papel do Google — tela de consentimento,
 * endpoint de token com PKCE, JWKS com chave RSA própria — sem sair da
 * máquina. É com ele que os testes provam o fluxo e que a stack descartável
 * mostra o botão funcionando antes de o dono ter o cliente OAuth.
 *
 * O QUE ELE NUNCA PODE SER: a porta de entrada de uma loja de verdade. Quem
 * controla o provedor de teste escolhe o e-mail "verificado" que quiser — em
 * produção, isso seria entrar na conta de qualquer cliente. Por isso a guarda
 * é do SERVIDOR e é dupla:
 *
 *   - `DEVORA_API_ENV` = production ou staging  → recusa;
 *   - `NODE_ENV` = production (mesmo com DEVORA_API_ENV esquecido) → recusa.
 *
 * E ela é chamada nas TRÊS portas: gravar a configuração com o modo teste,
 * executar o fluxo com ele (banco copiado de outro ambiente), e as rotas da
 * tela de consentimento de teste (que respondem 404 em produção).
 *
 * A identidade que ele emite tem EMISSOR próprio (um domínio `.invalid`, que
 * por norma nunca resolve). A tabela de identidades usa (emissor, sub) como
 * chave: uma identidade de teste nunca se confunde com uma do Google.
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { desafioDoPkce, type TransporteOidc } from './OidcClient.js';

const EMISSOR = 'https://provedor-de-teste.devora.invalid';

export const ENDPOINTS_DO_PROVEDOR_DE_TESTE = {
  emissor: EMISSOR,
  token: `${EMISSOR}/token`,
  jwks: `${EMISSOR}/jwks`,
} as const;

/** O provedor de teste pode operar NESTE processo? */
export function provedorDeTestePermitido(): boolean {
  const apiEnv = loadEnv().DEVORA_API_ENV;
  if (apiEnv === 'production' || apiEnv === 'staging') return false;
  if (process.env.NODE_ENV === 'production') return false;
  return true;
}

export function exigirProvedorDeTestePermitido(): void {
  if (provedorDeTestePermitido()) return;
  throw new ApiError(
    'PORTAL_GOOGLE_TESTE_PROIBIDO',
    'O provedor de teste do Google não opera em produção nem em homologação: ele deixa escolher '
      + 'qualquer e-mail como verificado. Configure o cliente OAuth do Google de verdade.',
    403,
  );
}

// ------------------------------------------------------------- a chave

interface ParDeChaves {
  privada: KeyObject;
  publica: JsonWebKey;
  kid: string;
}

let par: ParDeChaves | null = null;

/** Gerado na primeira vez, e só em memória — reiniciar o processo troca a chave. */
function chaves(): ParDeChaves {
  exigirProvedorDeTestePermitido();
  if (par) return par;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `teste-${randomBytes(6).toString('hex')}`;
  par = {
    privada: privateKey,
    publica: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
    kid,
  };
  return par;
}

export function jwksDoProvedorDeTeste(): { keys: JsonWebKey[] } {
  return { keys: [chaves().publica] };
}

/**
 * Assina um JWT com a chave do provedor de teste. Exportado para os testes
 * montarem tokens adulterados (vencido, audiência errada, nonce errado).
 */
export function assinarNoProvedorDeTeste(
  claims: Record<string, unknown>,
  cabecalho: Record<string, unknown> = {},
): string {
  const { privada, kid } = chaves();
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...cabecalho })).toString('base64url');
  const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${c}`), privada).toString('base64url');
  return `${h}.${c}.${s}`;
}

// ------------------------------------------------------ o consentimento

/** A pessoa que o ensaio diz ser. */
export interface PessoaDeTeste {
  email: string;
  name?: string;
  emailVerified: boolean;
  /** Sem `sub`, deriva do e-mail — a mesma pessoa volta com o mesmo `sub`. */
  sub?: string;
}

export interface ClienteRegistrado {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface CodigoEmitido {
  clientId: string;
  redirectUri: string;
  desafio: string;
  nonce: string;
  pessoa: PessoaDeTeste;
  expiraEm: number;
}

const codigos = new Map<string, CodigoEmitido>();

export function subDeTeste(email: string): string {
  return `teste-${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
}

/**
 * O pedido de autorização como o Google o confere: cliente e endereço de
 * retorno IGUAIS aos cadastrados, e PKCE S256. Qualquer desvio é recusa —
 * como a tela "redirect_uri_mismatch" do Google.
 */
export function conferirPedidoDeAutorizacao(
  q: Record<string, unknown>,
  cliente: ClienteRegistrado | null,
): { clientId: string; redirectUri: string; state: string; nonce: string; desafio: string } {
  exigirProvedorDeTestePermitido();
  const texto = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
  if (!cliente) {
    throw new ApiError('PROVEDOR_TESTE_SEM_CLIENTE', 'Nenhum cliente de teste está configurado.', 400);
  }
  if (texto('client_id') !== cliente.clientId) {
    throw new ApiError('PROVEDOR_TESTE_CLIENTE_DESCONHECIDO', 'client_id desconhecido (invalid_client).', 400);
  }
  if (texto('redirect_uri') !== cliente.redirectUri) {
    throw new ApiError(
      'PROVEDOR_TESTE_REDIRECT_DIFERENTE',
      'redirect_uri diferente do cadastrado (redirect_uri_mismatch).',
      400,
    );
  }
  if (texto('response_type') !== 'code') {
    throw new ApiError('PROVEDOR_TESTE_PEDIDO_INVALIDO', 'response_type precisa ser "code".', 400);
  }
  if (texto('code_challenge_method') !== 'S256' || !texto('code_challenge')) {
    throw new ApiError('PROVEDOR_TESTE_PEDIDO_INVALIDO', 'PKCE S256 obrigatório.', 400);
  }
  if (!texto('state') || !texto('nonce')) {
    throw new ApiError('PROVEDOR_TESTE_PEDIDO_INVALIDO', 'state e nonce obrigatórios.', 400);
  }
  return {
    clientId: cliente.clientId,
    redirectUri: cliente.redirectUri,
    state: texto('state'),
    nonce: texto('nonce'),
    desafio: texto('code_challenge'),
  };
}

/** A pessoa autorizou: emite o `code` e devolve o endereço de retorno. */
export function autorizarNoProvedorDeTeste(
  pedido: ReturnType<typeof conferirPedidoDeAutorizacao>,
  pessoa: PessoaDeTeste,
): string {
  exigirProvedorDeTestePermitido();
  const email = String(pessoa.email ?? '').trim();
  if (!email.includes('@')) {
    throw new ApiError('PROVEDOR_TESTE_EMAIL_INVALIDO', 'Informe um e-mail para o ensaio.', 400);
  }
  const code = randomBytes(24).toString('base64url');
  codigos.set(code, {
    clientId: pedido.clientId,
    redirectUri: pedido.redirectUri,
    desafio: pedido.desafio,
    nonce: pedido.nonce,
    pessoa: { ...pessoa, email },
    // Dez minutos, como o Google.
    expiraEm: Date.now() + 10 * 60 * 1000,
  });
  const volta = new URL(pedido.redirectUri);
  volta.searchParams.set('code', code);
  volta.searchParams.set('state', pedido.state);
  return volta.toString();
}

/** A pessoa recusou: volta com `error=access_denied`, como o Google. */
export function recusarNoProvedorDeTeste(pedido: ReturnType<typeof conferirPedidoDeAutorizacao>): string {
  const volta = new URL(pedido.redirectUri);
  volta.searchParams.set('error', 'access_denied');
  volta.searchParams.set('state', pedido.state);
  return volta.toString();
}

// ------------------------------------------------------------ o token

function erroOAuth(status: number, error: string): { status: number; corpo: unknown } {
  return { status, corpo: { error } };
}

/** O endpoint de token: confere cliente, segredo, retorno, PKCE e uso único. */
export function trocarNoProvedorDeTeste(
  campos: Record<string, string>,
  cliente: ClienteRegistrado | null,
): { status: number; corpo: unknown } {
  exigirProvedorDeTestePermitido();
  if (!cliente || campos.client_id !== cliente.clientId || campos.client_secret !== cliente.clientSecret) {
    return erroOAuth(401, 'invalid_client');
  }
  if (campos.grant_type !== 'authorization_code') return erroOAuth(400, 'unsupported_grant_type');

  const emitido = codigos.get(campos.code ?? '');
  // USO ÚNICO: o código sai do mapa antes de qualquer outra conferência.
  codigos.delete(campos.code ?? '');
  if (!emitido || emitido.expiraEm < Date.now()) return erroOAuth(400, 'invalid_grant');
  if (emitido.clientId !== campos.client_id || emitido.redirectUri !== campos.redirect_uri) {
    return erroOAuth(400, 'invalid_grant');
  }
  if (!campos.code_verifier || desafioDoPkce(campos.code_verifier) !== emitido.desafio) {
    return erroOAuth(400, 'invalid_grant');
  }

  const agora = Math.floor(Date.now() / 1000);
  const idToken = assinarNoProvedorDeTeste({
    iss: EMISSOR,
    aud: emitido.clientId,
    azp: emitido.clientId,
    sub: emitido.pessoa.sub ?? subDeTeste(emitido.pessoa.email),
    email: emitido.pessoa.email,
    email_verified: emitido.pessoa.emailVerified,
    name: emitido.pessoa.name ?? undefined,
    nonce: emitido.nonce,
    iat: agora,
    exp: agora + 3600,
  });
  return {
    status: 200,
    corpo: {
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: idToken,
    },
  };
}

/**
 * O transporte que fala com o provedor de teste EM PROCESSO — nada de rede.
 * Qualquer endereço fora dos dois do provedor é recusado.
 */
export function transporteDoProvedorDeTeste(cliente: ClienteRegistrado | null): TransporteOidc {
  return {
    async postarFormulario(url, campos) {
      exigirProvedorDeTestePermitido();
      if (url !== ENDPOINTS_DO_PROVEDOR_DE_TESTE.token) throw new Error(`endereço fora do provedor de teste: ${url}`);
      return trocarNoProvedorDeTeste(campos, cliente);
    },
    async lerJson(url) {
      exigirProvedorDeTestePermitido();
      if (url !== ENDPOINTS_DO_PROVEDOR_DE_TESTE.jwks) throw new Error(`endereço fora do provedor de teste: ${url}`);
      return { status: 200, corpo: jwksDoProvedorDeTeste(), maxAgeSeg: 300 };
    },
  };
}

/** Para os testes: esquece chave e códigos (cada arquivo começa limpo). */
export function reiniciarProvedorDeTesteParaTestes(): void {
  par = null;
  codigos.clear();
}

// ------------------------------------------------ a tela de consentimento

function esc(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A página que faz o papel da tela "Escolha uma conta" do Google. HTML puro,
 * sem script nem estilo embutido (a política de conteúdo não precisa abrir
 * nada para ela). O formulário volta por GET à rota de confirmação, que
 * responde com o redirecionamento — como o Google.
 */
export function paginaDeConsentimento(acaoDoFormulario: string, q: Record<string, unknown>): string {
  const ocultos = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(typeof q[k] === 'string' ? (q[k] as string) : '')}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Provedor de teste — Entrar com Google</title></head>
<body>
  <h1>Provedor de teste do Google</h1>
  <p><strong>Isto NÃO é o Google.</strong> É o ensaio da entrada pelo Google, que só existe fora de produção.
  Escolha a pessoa que o "Google" vai dizer que entrou.</p>
  <form method="get" action="${esc(acaoDoFormulario)}">
      ${ocultos}
      <p><label>E-mail <input type="email" name="email" required></label></p>
      <p><label>Nome <input type="text" name="name"></label></p>
      <p><label><input type="checkbox" name="email_verified" value="true" checked> O e-mail está verificado no Google</label></p>
      <p>
        <button type="submit" name="decisao" value="autorizar">Autorizar</button>
        <button type="submit" name="decisao" value="recusar" formnovalidate>Recusar</button>
      </p>
  </form>
</body>
</html>`;
}
