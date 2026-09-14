/**
 * ============================================================================
 * DE ONDE VEIO A REQUISIÇÃO — o endereço que decide o bloqueio por par
 * (GAP-PRD-074)
 * ============================================================================
 *
 * O controle de força bruta conta falhas por PAR (login + origem), e a origem
 * vinha SEMPRE do socket, com um motivo certo escrito ao lado: `req.ip`
 * obedece a `trust proxy` e ao `X-Forwarded-For`, e um cabeçalho é a coisa
 * mais barata de forjar — quem mandasse um endereço diferente a cada tentativa
 * "trocaria de aparelho" de graça.
 *
 * O motivo vale para o servidor servido DIRETO. Atrás de um proxy reverso —
 * que é como este ERP é publicado — o socket é o proxy, o mesmo para todo
 * mundo: o par vira (gerente, IP-do-proxy), e cinco senhas erradas de qualquer
 * celular trancam o gerente em todos os caixas. Exatamente a arma que o
 * bloqueio por par existe para desarmar, de volta. O limite de taxa já contava
 * por `req.ip` e honrava `DEVORA_TRUST_PROXY`; o par do bloqueio não.
 *
 * ## A regra
 *
 *   - `DEVORA_TRUST_PROXY = 0` (o padrão, servido direto): o SOCKET. Nada do
 *     que o cliente escreve em cabeçalho entra na conta.
 *   - `DEVORA_TRUST_PROXY = N > 0`: `req.ip`, que o Express calcula
 *     descartando os N saltos confiáveis da direita do `X-Forwarded-For` — o
 *     endereço que o proxy de verdade ACRESCENTOU. O que o cliente escreveu à
 *     esquerda é ignorado, então forjar o cabeçalho continua não trocando de
 *     aparelho.
 *
 * O número de saltos é do dono (a topologia da publicação) e o mesmo valor
 * decide o limite de taxa (`app.ts`): as duas contas enxergam a mesma origem.
 */
import { loadEnv } from '../config/env.js';

type RequisicaoComOrigem = {
  ip?: string;
  socket?: { remoteAddress?: string };
};

export function ipDeOrigem(req: RequisicaoComOrigem): string | null {
  const doSocket = req.socket?.remoteAddress ?? null;
  if (loadEnv().DEVORA_TRUST_PROXY > 0) return req.ip || doSocket;
  return doSocket;
}
