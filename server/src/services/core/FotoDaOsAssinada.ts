/**
 * ============================================================================
 * A FOTO DA OS ABRE POR LINK ASSINADO E CURTO — GAP-PRD-184
 * ============================================================================
 *
 * ## O que estava errado
 *
 * `/uploads/os/<uuid>.<ext>` era servido pelo `express.static` sem sessão
 * nenhuma, como a foto de produto e o logo da loja. Mas a foto da OS não é
 * vitrine: é o aparelho do CLIENTE — a tela trincada, o documento esquecido
 * na capinha, a placa da moto. A lista exigia sessão e alcance de bancada; o
 * endereço, uma vez conhecido (histórico do navegador, print de tela,
 * mensagem encaminhada), valia para qualquer um e para sempre. A entropia do
 * UUID era a única proteção.
 *
 * ## O desenho
 *
 * O banco continua guardando o CAMINHO (`/uploads/os/<uuid>.<ext>`) — nada
 * muda no dado. Quem entrega o link é a listagem, que já exige sessão e
 * alcance: ela devolve o caminho com `?e=<expira>&s=<assinatura>`. A
 * assinatura é um HMAC-SHA256 do nome do arquivo e do instante de expiração,
 * com uma chave DERIVADA de `DEVORA_JWT_SECRET` (rótulo próprio, para que a
 * assinatura da foto nunca sirva como outra coisa). O guarda na frente do
 * `express.static` recusa com 403 o que chega sem assinatura, com assinatura
 * de outro arquivo, adulterada ou vencida.
 *
 * `<img src>` não manda `Authorization`, por isso a sessão não pode ir no
 * cabeçalho; e ir no link (o token de acesso na URL) espalharia a credencial
 * inteira por log de proxy e histórico. O link assinado entrega só aquela
 * foto, e só por uma hora.
 *
 * ## A foto da MÁQUINA segue a mesma régua (junção das frentes)
 *
 * As fotos do equipamento (GAP-PRD-106, `/uploads/equipamentos`) nasceram
 * depois deste guarda e saíam pelo `express.static` público, com cache de sete
 * dias — o chassi, a placa e o estado da moto do cliente abertos a quem tivesse
 * o endereço. Elas passam pelo mesmo guarda, com a mesma validade. A
 * assinatura de cada pasta tem DOMÍNIO próprio: o link de uma foto da OS não
 * abre um arquivo de mesmo nome na pasta das máquinas, e vice-versa. A da OS
 * continua exatamente como era (links já emitidos e os testes do GAP-PRD-184
 * não mudam).
 *
 * ## Validade e cache
 *
 * Uma hora: cobre a bancada que deixa a OS aberta enquanto trabalha, e toda
 * recarga da OS assina de novo. O cache vira `private` com o que resta da
 * validade — o `public, max-age=7d` de antes deixaria a foto guardada em proxy
 * compartilhado.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { loadEnv } from '../../config/env.js';

/** As pastas servidas por link assinado, cada uma com o domínio da assinatura. */
const PASTAS = {
  os: { prefixo: '/uploads/os/', dominio: '' },
  equipamentos: { prefixo: '/uploads/equipamentos/', dominio: 'equipamentos:' },
} as const;

export type PastaAssinada = keyof typeof PASTAS;

/** Quanto o link vale a partir da listagem. */
export const VALIDADE_DO_LINK_MS = 60 * 60 * 1000;

/** O nome que `addOrderPhoto` grava: UUID + extensão. Nada com barra ou ponto-ponto. */
const NOME_DE_FOTO = /^[A-Za-z0-9-]{1,64}\.(jpg|jpeg|png|webp)$/i;

type CodigoDaRecusa = 'CORE_PHOTO_LINK_INVALID' | 'CORE_PHOTO_LINK_EXPIRED';

export type ConferenciaDoLink =
  | { ok: true; restanteSegundos: number }
  | { ok: false; code: CodigoDaRecusa };

function chave(): Buffer {
  return createHmac('sha256', loadEnv().DEVORA_JWT_SECRET).update('devora:foto-da-os:v1').digest();
}

function assinatura(pasta: PastaAssinada, nome: string, expiraEm: number): string {
  return createHmac('sha256', chave())
    .update(`${PASTAS[pasta].dominio}${nome}\n${expiraEm}`)
    .digest('base64url');
}

/**
 * O caminho gravado vira o link que abre, por `VALIDADE_DO_LINK_MS`.
 *
 * Caminho que não é de uma pasta assinada (endereço absoluto, outra pasta)
 * volta como veio: não é este guarda que o serve.
 */
export function assinarCaminhoDaFoto(caminho: string, agora: Date = new Date()): string {
  const pasta = (Object.keys(PASTAS) as PastaAssinada[]).find((p) => caminho.startsWith(PASTAS[p].prefixo));
  if (!pasta) return caminho;
  const nome = caminho.slice(PASTAS[pasta].prefixo.length);
  if (!NOME_DE_FOTO.test(nome)) return caminho;
  const expiraEm = Math.floor((agora.getTime() + VALIDADE_DO_LINK_MS) / 1000);
  return `${caminho}?e=${expiraEm}&s=${assinatura(pasta, nome, expiraEm)}`;
}

/**
 * Confere o link. A assinatura vem ANTES da validade: link adulterado é
 * inválido, e só o link legítimo que passou da hora ouve "venceu".
 */
export function conferirLinkDaFoto(
  nome: string,
  e: unknown,
  s: unknown,
  agoraMs: number = Date.now(),
  pasta: PastaAssinada = 'os',
): ConferenciaDoLink {
  if (!NOME_DE_FOTO.test(nome) || typeof e !== 'string' || typeof s !== 'string') {
    return { ok: false, code: 'CORE_PHOTO_LINK_INVALID' };
  }
  if (!/^\d{1,12}$/.test(e)) return { ok: false, code: 'CORE_PHOTO_LINK_INVALID' };
  const expiraEm = Number(e);
  const esperado = Buffer.from(assinatura(pasta, nome, expiraEm));
  const recebido = Buffer.from(s);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) {
    return { ok: false, code: 'CORE_PHOTO_LINK_INVALID' };
  }
  const restanteMs = expiraEm * 1000 - agoraMs;
  if (restanteMs <= 0) return { ok: false, code: 'CORE_PHOTO_LINK_EXPIRED' };
  return { ok: true, restanteSegundos: Math.ceil(restanteMs / 1000) };
}

const MENSAGEM: Record<PastaAssinada, Record<CodigoDaRecusa, string>> = {
  os: {
    CORE_PHOTO_LINK_INVALID: 'Link de foto inválido. Abra a foto pela ordem de serviço.',
    CORE_PHOTO_LINK_EXPIRED: 'Este link de foto venceu. Abra a ordem de serviço de novo.',
  },
  equipamentos: {
    CORE_PHOTO_LINK_INVALID: 'Link de foto inválido. Abra a foto pela ficha do equipamento.',
    CORE_PHOTO_LINK_EXPIRED: 'Este link de foto venceu. Abra a ficha do equipamento de novo.',
  },
};

/** O guarda que fica na frente do `express.static` de uma pasta assinada. */
export function guardaDaFotoAssinada(pasta: PastaAssinada = 'os'): RequestHandler {
  return (req, res, next) => {
    let nome: string;
    try {
      nome = decodeURIComponent(req.path.replace(/^\//, ''));
    } catch {
      nome = '';
    }
    const r = conferirLinkDaFoto(nome, req.query.e, req.query.s, Date.now(), pasta);
    if (!r.ok) {
      res.status(403).json({ error: { code: r.code, message: MENSAGEM[pasta][r.code] } });
      return;
    }
    res.setHeader('Cache-Control', `private, max-age=${Math.min(r.restanteSegundos, 3600)}`);
    next();
  };
}
