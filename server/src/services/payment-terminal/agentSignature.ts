/**
 * A ASSINATURA DO AGENTE LOCAL — o mesmo código dos dois lados (GAP-PRD-014).
 *
 * O agente local roda no computador do caixa e fala com o PinPad pelo cliente
 * TEF da adquirente. Ele não tem sessão de usuário: quem o identifica é o
 * segredo que recebeu UMA vez, no pareamento. Cada pedido dele ao servidor vai
 * assinado com HMAC-SHA256 sobre:
 *
 *     v1 \n MÉTODO \n CAMINHO-COM-CONSULTA \n CARIMBO-MS \n NONCE \n SHA256(CORPO)
 *
 * - o CARIMBO limita a vida de um pedido capturado a cinco minutos;
 * - o NONCE (guardado pelo servidor) impede reenviar o mesmo pedido dentro
 *   desses cinco minutos — um "aprovado" repetido não vira dois;
 * - o SHA-256 do corpo CRU amarra o conteúdo: trocar "declined" por
 *   "approved" no caminho invalida a assinatura.
 *
 * Este arquivo não lê banco nem ambiente: é aritmética pura, importada pelo
 * servidor (que confere) e pelo programa do agente (que assina). Se os dois
 * lados montassem a frase cada um do seu jeito, a primeira diferença de
 * espaço derrubaria toda cobrança.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Quanto tempo um pedido assinado vale, para cada lado do relógio. */
export const JANELA_DA_ASSINATURA_MS = 5 * 60 * 1000;

/** Os cabeçalhos, com o nome exato que os dois lados usam. */
export const CABECALHOS_DO_AGENTE = {
  agente: 'x-devora-agent',
  carimbo: 'x-devora-timestamp',
  nonce: 'x-devora-nonce',
  assinatura: 'x-devora-signature',
} as const;

export function sha256Hex(corpo: string | Buffer | Uint8Array | null | undefined): string {
  return createHash('sha256').update(corpo ?? '').digest('hex');
}

/** A frase que se assina. Método em maiúsculas; caminho como foi pedido. */
export function fraseDaAssinatura(input: {
  metodo: string;
  caminho: string;
  carimbo: string;
  nonce: string;
  corpo: string | Buffer | Uint8Array | null | undefined;
}): string {
  return [
    'v1',
    input.metodo.toUpperCase(),
    input.caminho,
    input.carimbo,
    input.nonce,
    sha256Hex(input.corpo),
  ].join('\n');
}

export function assinar(segredo: string, frase: string): string {
  return `v1=${createHmac('sha256', segredo).update(frase).digest('hex')}`;
}

/** Comparação em tempo constante — a assinatura não vaza por cronômetro. */
export function assinaturaConfere(segredo: string, frase: string, recebida: string): boolean {
  const esperada = Buffer.from(assinar(segredo, frase));
  const veio = Buffer.from(String(recebida ?? ''));
  if (esperada.length !== veio.length) return false;
  return timingSafeEqual(esperada, veio);
}

/** O carimbo está dentro da janela? (Relógio do computador do caixa atrasado é o caso comum.) */
export function carimboDentroDaJanela(carimbo: string, agoraMs = Date.now()): boolean {
  const n = Number(carimbo);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Math.abs(agoraMs - n) <= JANELA_DA_ASSINATURA_MS;
}
