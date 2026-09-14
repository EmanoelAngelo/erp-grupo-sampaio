/**
 * A configuração do "Entrar com Google" — da INSTALAÇÃO (GAP-PRD-027).
 *
 * O que o dono traz de fora é o cliente OAuth criado no Google Cloud Console:
 * o Client ID, o segredo, e o endereço de retorno que ele cadastrou lá. Com os
 * três gravados aqui pela tela, nenhuma linha de código precisa ser escrita
 * para a loja passar a oferecer o botão.
 *
 * POR QUE É DA INSTALAÇÃO E NÃO DA OPERAÇÃO. A conta do cliente é do grupo:
 * a mesma pessoa compra na Gringa e no Preço Justo com um login só. E o
 * Google só devolve para os endereços cadastrados no cliente OAuth — a loja
 * online tem um endereço público só. Seis configurações por empresa seriam
 * seis lugares para uma divergir sem ninguém ver.
 *
 * O SEGREDO VAI SELADO NO COFRE e não volta para a tela: a tela recebe a dica
 * (••••abcd) e o "configurado". Deixar o campo em branco ao salvar mantém o
 * que está guardado.
 *
 * O PROVEDOR DE TESTE é uma escolha de configuração (`provider_mode`), e o
 * servidor a recusa em produção/homologação — na gravação E na execução: um
 * banco copiado do ambiente de desenvolvimento não liga o provedor de teste
 * numa loja de verdade (ver `ProvedorGoogleDeTeste`).
 */
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { decryptFiscalSecret, encryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { publicBaseUrl, publicBaseUrlConfigurada } from './PublicUrl.js';
import {
  ENDPOINTS_DO_PROVEDOR_DE_TESTE,
  exigirProvedorDeTestePermitido,
  provedorDeTestePermitido,
  type ClienteRegistrado,
} from './ProvedorGoogleDeTeste.js';

export type ModoDoProvedor = 'google' | 'teste';

/** O caminho da tela que recebe a volta do Google (`src/router/gsRoutes.tsx`). */
export const CAMINHO_DO_RETORNO = '/minha-conta/google';

/** Os endpoints do Google — fixos e publicados em accounts.google.com/.well-known. */
export const ENDPOINTS_DO_GOOGLE = {
  autorizacao: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  // O Google assina com os dois nomes do mesmo emissor.
  emissores: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

interface LinhaDaConfig {
  enabled: number;
  provider_mode: ModoDoProvedor;
  client_id: string | null;
  secret_cipher: string | null;
  secret_hint: string | null;
  redirect_uri: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export type EstadoDaProntidao = 'desligado' | 'pronto' | 'pronto_teste' | 'bloqueado';

/** O que a tela do dono mostra. Nunca o segredo. */
export interface ConfiguracaoGoogleNaTela {
  enabled: boolean;
  providerMode: ModoDoProvedor;
  clientId: string | null;
  secretConfigured: boolean;
  secretHint: string | null;
  redirectUri: string | null;
  /** O endereço que a tela sugere cadastrar no Google. */
  redirectUriSugerido: string;
  /** Falso = o endereço público não foi declarado (GRUPO_SAMPAIO_PUBLIC_URL). */
  enderecoPublicoConfigurado: boolean;
  /** O provedor de teste pode ser escolhido NESTE ambiente? */
  provedorDeTestePermitido: boolean;
  prontidao: { estado: EstadoDaProntidao; falta: string[]; mensagem: string };
  updatedAt: string | null;
  updatedBy: string | null;
}

function lerLinha(): LinhaDaConfig | undefined {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT enabled, provider_mode, client_id, secret_cipher, secret_hint, redirect_uri,
              updated_by, updated_at
         FROM core_portal_google_login WHERE id = 'google'`,
    )
    .get() as LinhaDaConfig | undefined;
}

/** O que falta para ligar — a mesma lista para a tela e para a recusa. */
function oQueFalta(l: {
  client_id: string | null;
  secret_cipher: string | null;
  redirect_uri: string | null;
}): string[] {
  const falta: string[] = [];
  if (!l.client_id) falta.push('Client ID do cliente OAuth');
  if (!l.secret_cipher) falta.push('Segredo do cliente OAuth');
  if (!l.redirect_uri) falta.push('Endereço de retorno (redirect URI)');
  return falta;
}

function prontidao(l: LinhaDaConfig | undefined): ConfiguracaoGoogleNaTela['prontidao'] {
  const base = l ?? {
    enabled: 0,
    provider_mode: 'google' as ModoDoProvedor,
    client_id: null,
    secret_cipher: null,
    redirect_uri: null,
  };
  const falta = oQueFalta(base);
  if (!base.enabled) {
    return {
      estado: 'desligado',
      falta,
      mensagem:
        falta.length > 0
          ? 'Desligado. A loja não mostra o botão do Google até a configuração ficar completa e ser ligada.'
          : 'Configurado, mas desligado: a loja não mostra o botão do Google.',
    };
  }
  if (base.provider_mode === 'teste') {
    return provedorDeTestePermitido()
      ? {
          estado: 'pronto_teste',
          falta: [],
          mensagem:
            'Ligado com o PROVEDOR DE TESTE: o botão aparece e simula o Google. Serve para ensaio — em produção o servidor recusa.',
        }
      : {
          estado: 'bloqueado',
          falta: ['Trocar para o Google de verdade'],
          mensagem:
            'Ligado com o provedor de teste, que este ambiente recusa. O botão não aparece até trocar para o Google.',
        };
  }
  return {
    estado: 'pronto',
    falta: [],
    mensagem: 'Ligado. O botão "Entrar com Google" aparece na tela de entrar da loja.',
  };
}

export function redirectUriSugerido(): string {
  return `${publicBaseUrl()}${CAMINHO_DO_RETORNO}`;
}

export function lerConfiguracaoGoogle(): ConfiguracaoGoogleNaTela {
  const l = lerLinha();
  return {
    enabled: Boolean(l?.enabled),
    providerMode: l?.provider_mode ?? 'google',
    clientId: l?.client_id ?? null,
    secretConfigured: Boolean(l?.secret_cipher),
    secretHint: l?.secret_hint ?? null,
    redirectUri: l?.redirect_uri ?? null,
    redirectUriSugerido: redirectUriSugerido(),
    enderecoPublicoConfigurado: publicBaseUrlConfigurada(),
    provedorDeTestePermitido: provedorDeTestePermitido(),
    prontidao: prontidao(l),
    updatedAt: l?.updated_at ?? null,
    updatedBy: l?.updated_by ?? null,
  };
}

/** O que a trilha de auditoria guarda — sem o segredo, só se ele mudou. */
export function retratoParaAuditoria(c: ConfiguracaoGoogleNaTela): Record<string, unknown> {
  return {
    enabled: c.enabled,
    providerMode: c.providerMode,
    clientId: c.clientId,
    redirectUri: c.redirectUri,
    secretHint: c.secretHint,
  };
}

function validarClientId(modo: ModoDoProvedor, valor: string): void {
  // O Client ID do Google termina sempre assim. Aceitar outra coisa era
  // descobrir o erro de digitação só na tela de erro do Google, na frente
  // do cliente.
  const ok =
    modo === 'google'
      ? /^[\w-]+\.apps\.googleusercontent\.com$/.test(valor)
      : /^[\w.-]{8,}$/.test(valor);
  if (!ok) {
    throw new ApiError(
      'PORTAL_GOOGLE_CLIENT_ID_INVALIDO',
      modo === 'google'
        ? 'O Client ID do Google termina em ".apps.googleusercontent.com". Copie-o inteiro do Google Cloud Console.'
        : 'Client ID de teste: pelo menos 8 caracteres, sem espaços.',
      400,
    );
  }
}

function validarRedirectUri(valor: string): string {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ApiError(
      'PORTAL_GOOGLE_REDIRECT_INVALIDO',
      'O endereço de retorno precisa ser completo, começando com https://.',
      400,
    );
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // O Google só aceita http:// para localhost — e é o mesmo critério aqui:
  // devolver o código de entrada por http aberto na internet é entregá-lo a
  // quem estiver no meio do caminho.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ApiError(
      'PORTAL_GOOGLE_REDIRECT_INVALIDO',
      'O endereço de retorno precisa ser https:// (só o localhost do desenvolvimento aceita http://).',
      400,
    );
  }
  if (url.hash || url.search) {
    throw new ApiError(
      'PORTAL_GOOGLE_REDIRECT_INVALIDO',
      'O endereço de retorno não leva "?" nem "#": o Google exige o endereço exato cadastrado.',
      400,
    );
  }
  // A volta tem de cair na tela que conclui a entrada. Outro caminho seria
  // um endereço que o Google aceita e a loja não sabe tratar.
  if (!url.pathname.replace(/\/+$/, '').endsWith(CAMINHO_DO_RETORNO)) {
    throw new ApiError(
      'PORTAL_GOOGLE_REDIRECT_INVALIDO',
      `O endereço de retorno termina em ${CAMINHO_DO_RETORNO} — é a tela da loja que conclui a entrada.`,
      400,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function dica(segredo: string): string {
  return segredo.length >= 4 ? `••••${segredo.slice(-4)}` : '•••• configurado';
}

export function salvarConfiguracaoGoogle(
  input: {
    enabled?: unknown;
    providerMode?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    redirectUri?: unknown;
  },
  userId: string,
): ConfiguracaoGoogleNaTela {
  ensureCoreSchema();
  const atual = lerLinha();

  const modo: ModoDoProvedor =
    input.providerMode === undefined ? (atual?.provider_mode ?? 'google') : (input.providerMode as ModoDoProvedor);
  if (modo !== 'google' && modo !== 'teste') {
    throw new ApiError('PORTAL_GOOGLE_MODO_INVALIDO', 'Escolha "google" ou "teste".', 400);
  }
  // A PRIMEIRA PORTA do provedor de teste: produção não o grava.
  if (modo === 'teste') exigirProvedorDeTestePermitido();

  const clientId =
    input.clientId === undefined ? (atual?.client_id ?? null) : String(input.clientId).trim() || null;
  if (clientId) validarClientId(modo, clientId);

  const redirectBruto =
    input.redirectUri === undefined ? (atual?.redirect_uri ?? null) : String(input.redirectUri).trim() || null;
  const redirectUri = redirectBruto ? validarRedirectUri(redirectBruto) : null;

  // Segredo: em branco (ou ausente) MANTÉM o guardado.
  const segredoNovo = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (segredoNovo && segredoNovo.length < 8) {
    throw new ApiError(
      'PORTAL_GOOGLE_SEGREDO_INVALIDO',
      'O segredo do cliente OAuth tem pelo menos 8 caracteres. Copie-o inteiro do Google Cloud Console.',
      400,
    );
  }
  const cifrado = segredoNovo ? encryptFiscalSecret(segredoNovo) : (atual?.secret_cipher ?? null);
  const dicaDoSegredo = segredoNovo ? dica(segredoNovo) : (atual?.secret_hint ?? null);

  const ligar = input.enabled === undefined ? Boolean(atual?.enabled) : input.enabled === true;
  if (ligar) {
    const falta = oQueFalta({ client_id: clientId, secret_cipher: cifrado, redirect_uri: redirectUri });
    if (falta.length > 0) {
      throw new ApiError(
        'PORTAL_GOOGLE_CONFIGURACAO_INCOMPLETA',
        `Para ligar falta: ${falta.join(', ')}.`,
        422,
        { falta },
      );
    }
  }

  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_portal_google_login
         (id, company_id, enabled, provider_mode, client_id, secret_cipher, secret_hint,
          redirect_uri, updated_by, created_at, updated_at)
       VALUES ('google', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         enabled = excluded.enabled,
         provider_mode = excluded.provider_mode,
         client_id = excluded.client_id,
         secret_cipher = excluded.secret_cipher,
         secret_hint = excluded.secret_hint,
         redirect_uri = excluded.redirect_uri,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(ligar ? 1 : 0, modo, clientId, cifrado, dicaDoSegredo, redirectUri, userId, agora, agora);

  return lerConfiguracaoGoogle();
}

/** O que o fluxo usa. Só existe com tudo preenchido, ligado e permitido. */
export interface ConfiguracaoEmUso {
  modo: ModoDoProvedor;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  endpoints: { token: string; jwks: string; emissores: string[] };
}

/**
 * A configuração que vale AGORA — ou a recusa.
 *
 * A SEGUNDA PORTA do provedor de teste: mesmo gravado (banco trazido de
 * outro ambiente), ele não roda onde o servidor diz produção.
 */
export function configuracaoEmUso(): ConfiguracaoEmUso {
  const l = lerLinha();
  if (!l || !l.enabled || oQueFalta(l).length > 0) {
    throw new ApiError(
      'PORTAL_GOOGLE_DESLIGADO',
      'A entrada pelo Google não está disponível nesta loja. Entre com e-mail e senha.',
      503,
    );
  }
  if (l.provider_mode === 'teste') exigirProvedorDeTestePermitido();

  let clientSecret: string;
  try {
    clientSecret = decryptFiscalSecret(String(l.secret_cipher));
  } catch {
    throw new ApiError(
      'PORTAL_GOOGLE_SEGREDO_ILEGIVEL',
      'A entrada pelo Google está indisponível: o segredo guardado não abre com a chave atual. Avise a loja.',
      503,
    );
  }

  return {
    modo: l.provider_mode,
    clientId: String(l.client_id),
    clientSecret,
    redirectUri: String(l.redirect_uri),
    endpoints:
      l.provider_mode === 'teste'
        ? {
            token: ENDPOINTS_DO_PROVEDOR_DE_TESTE.token,
            jwks: ENDPOINTS_DO_PROVEDOR_DE_TESTE.jwks,
            emissores: [ENDPOINTS_DO_PROVEDOR_DE_TESTE.emissor],
          }
        : {
            token: ENDPOINTS_DO_GOOGLE.token,
            jwks: ENDPOINTS_DO_GOOGLE.jwks,
            emissores: [...ENDPOINTS_DO_GOOGLE.emissores],
          },
  };
}

/** O que a VITRINE pode saber: se o botão aparece. Nada da configuração. */
export function googleDisponivel(): { disponivel: boolean; modo: ModoDoProvedor | null } {
  const l = lerLinha();
  if (!l || !l.enabled || oQueFalta(l).length > 0) return { disponivel: false, modo: null };
  if (l.provider_mode === 'teste' && !provedorDeTestePermitido()) return { disponivel: false, modo: null };
  return { disponivel: true, modo: l.provider_mode };
}


/**
 * O cliente registrado, para o provedor de teste conferir o que chega nele —
 * como o Google confere o que foi cadastrado no Console. Só existe no modo
 * teste; o provedor de teste recusa sozinho fora do ambiente permitido.
 */
export function clienteRegistradoParaTeste(): ClienteRegistrado | null {
  const l = lerLinha();
  if (!l || l.provider_mode !== 'teste' || !l.client_id || !l.secret_cipher || !l.redirect_uri) return null;
  try {
    return {
      clientId: l.client_id,
      clientSecret: decryptFiscalSecret(l.secret_cipher),
      redirectUri: l.redirect_uri,
    };
  } catch {
    return null;
  }
}
