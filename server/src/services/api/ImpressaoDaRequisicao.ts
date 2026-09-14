/**
 * ============================================================================
 * A IMPRESSÃO DIGITAL DE UM PEDIDO COM CHAVE DE IDEMPOTÊNCIA (RES-IDEM-VIZ)
 * ============================================================================
 *
 * ## O defeito, em todos os vizinhos da venda
 *
 * A trava de idempotência buscava só por (empresa, chave) e devolvia o que a
 * chave tinha feito antes. Quando a chave voltava com OUTRO corpo — outra
 * quantidade na consignação, outro valor na maquininha, outro carrinho na loja
 * online —, a resposta era o resultado ANTIGO, com 200, calada: quem pediu
 * achava que o pedido novo tinha acontecido, e ele não existia.
 *
 * O rascunho IETF "The Idempotency-Key HTTP Header Field" manda recusar a
 * reutilização da chave com carga diferente (422). É o que a venda passou a
 * fazer no item IDEM (`ImpressaoDigitalDaVenda.ts`), e o que este módulo dá a
 * todo o resto: cada consumidor grava, na criação, a impressão do que foi
 * pedido, e o reenvio é comparado com ela ANTES de qualquer escrita.
 *
 * ## O que cada consumidor põe na impressão
 *
 * Quem sabe o que é "o mesmo pedido" é o consumidor, não este módulo: cada um
 * monta o objeto com o que o pedido FAZ (mercadoria, valor, forma, destino) e
 * deixa de fora o que é circunstância do reenvio (gaveta, observação, a hora).
 * Este módulo só garante que o mesmo objeto dá a mesma impressão, sempre.
 *
 * ## JSON canônico
 *
 * Chaves de objeto ordenadas por código de caractere (estável entre versões do
 * Node — a impressão fica gravada no banco), `undefined` fora. Listas mantêm a
 * ordem: quem precisa de "sem ordem" ordena antes, porque só ele sabe se a
 * ordem de uma lista é informação.
 *
 * ## A versão na frente, e o legado
 *
 * O valor gravado é `v1:<hex>`. Linha anterior à coluna (nula) ou de outra
 * versão da receita não tem com o que comparar: o reenvio segue a regra de
 * antes (devolve o resultado) em vez de recusar um reenvio legítimo por uma
 * diferença que é da receita.
 *
 * ## A impressão selada
 *
 * O `withIdempotency` genérico guarda a impressão do CORPO INTEIRO da
 * requisição, e alguns desses corpos carregam segredo (o token do CSC, a senha
 * da transportadora). Um SHA-256 puro de uma senha fraca se reverte por força
 * bruta; por isso ali a impressão é um HMAC com chave derivada do segredo do
 * servidor (`impressaoSeladaDe`). Trocar `DEVORA_JWT_SECRET` torna as
 * impressões seladas antigas incomparáveis — o reenvio de um pedido feito
 * ANTES da troca passa a ser recusado, e pede chave nova. É o preço aceito:
 * a troca derruba todas as sessões, e ninguém reenvia pedido de antes dela.
 */
import { createHash, createHmac } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';

/** A receita desta impressão. Mudou o que entra, muda a versão. */
export const VERSAO_DA_IMPRESSAO = 'v1';

/** Ordem por código de caractere — estável entre versões do Node. */
export function porCodigo(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonizar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map((v) => (v === undefined ? null : canonizar(v)));
  if (valor && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const chave of Object.keys(valor as Record<string, unknown>).sort(porCodigo)) {
      const v = (valor as Record<string, unknown>)[chave];
      if (v === undefined) continue;
      saida[chave] = canonizar(v);
    }
    return saida;
  }
  if (typeof valor === 'number' && !Number.isFinite(valor)) return String(valor);
  return valor;
}

/** JSON canônico: chaves ordenadas, `undefined` fora. */
export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(canonizar(valor) ?? null);
}

/** `v1:<sha-256>` do JSON canônico — para pedido que não carrega segredo. */
export function impressaoDe(valor: unknown): string {
  return `${VERSAO_DA_IMPRESSAO}:${createHash('sha256').update(jsonCanonico(valor)).digest('hex')}`;
}

function chaveDoSelo(): Buffer {
  return createHmac('sha256', loadEnv().DEVORA_JWT_SECRET).update('devora:impressao-da-requisicao:v1').digest();
}

/** `v1:<hmac-sha-256>` do JSON canônico — para corpo que pode carregar segredo. */
export function impressaoSeladaDe(valor: unknown): string {
  return `${VERSAO_DA_IMPRESSAO}:${createHmac('sha256', chaveDoSelo()).update(jsonCanonico(valor)).digest('hex')}`;
}

/**
 * A chave foi reusada com OUTRO pedido?
 *
 * Só responde sim quando dá para comparar: a impressão gravada existe e é da
 * mesma receita. Nula (linha anterior à coluna) ou de outra versão responde
 * não — o reenvio segue a regra de sempre.
 */
export function outraImpressao(gravada: unknown, agora: string): boolean {
  if (typeof gravada !== 'string' || !gravada) return false;
  if (!gravada.startsWith(`${VERSAO_DA_IMPRESSAO}:`)) return false;
  return gravada !== agora;
}

/** Inteiro de centavos/quantidade como o serviço normaliza: vazio é zero. */
export function inteiro(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** "2" e 2 são a mesma quantidade; o que não é número fica como texto. */
export function numero(v: unknown): number | string {
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/** Texto aparado; ausente é vazio — `null`, `undefined` e `''` são o mesmo. */
export function texto(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * A recusa, igual em todo consumidor: 422 CORE_IDEMPOTENCY_KEY_REUSED.
 *
 * `oQue` diz o que a chave já registrou, com o número que a pessoa reconhece
 * ("a venda #12", "a remessa da consignação #3"). `details` só leva
 * identificador da PRÓPRIA empresa — a chave é por empresa, e o registro
 * achado é dela.
 */
export function chaveReusada(oQue: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(
    'CORE_IDEMPOTENCY_KEY_REUSED',
    `Esta chave de idempotência já registrou ${oQue}, com outro conteúdo — nada foi registrado agora. `
      + 'Um pedido novo precisa de chave nova.',
    422,
    details,
  );
}
