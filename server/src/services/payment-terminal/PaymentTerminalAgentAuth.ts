/**
 * QUEM É O AGENTE QUE ESTÁ FALANDO (GAP-PRD-014).
 *
 * O agente local não tem sessão de usuário — ele é um programa num computador
 * de caixa. A prova de identidade é a assinatura HMAC de cada pedido com o
 * segredo entregue no pareamento (`agentSignature.ts`). Aqui se confere, na
 * ordem:
 *
 *   1. os quatro cabeçalhos existem;
 *   2. o carimbo está dentro de cinco minutos do relógio do servidor;
 *   3. o agente existe, está pareado e não foi revogado;
 *   4. a assinatura confere com o segredo dele, sobre o corpo CRU;
 *   5. o nonce nunca foi usado por este agente.
 *
 * Toda falha é o MESMO 401, com a mesma mensagem: "o id não existe", "o
 * segredo está errado" e "o pedido é repetido" são informação útil só para
 * quem está tentando entrar.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  CABECALHOS_DO_AGENTE,
  JANELA_DA_ASSINATURA_MS,
  assinaturaConfere,
  carimboDentroDaJanela,
  fraseDaAssinatura,
} from './agentSignature.js';
import { agenteParaConferir, registrarSinalDoAgente } from './PaymentTerminalLocalAgentService.js';

export interface AgenteAutenticado {
  agentId: string;
  companyId: string;
  pdvTerminalId: string | null;
}

function recusa(): ApiError {
  return new ApiError(
    'PAYMENT_TERMINAL_AGENT_UNAUTHORIZED',
    'Pedido do agente local sem assinatura válida. Refaça o pareamento se o segredo foi perdido.',
    401,
  );
}

export function autenticarPedidoDoAgente(input: {
  headers: Record<string, string | string[] | undefined>;
  metodo: string;
  caminho: string;
  corpo: Buffer | string | null | undefined;
  agoraMs?: number;
}): AgenteAutenticado {
  const ler = (nome: string): string => {
    const v = input.headers[nome];
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  };
  const agentId = ler(CABECALHOS_DO_AGENTE.agente).trim();
  const carimbo = ler(CABECALHOS_DO_AGENTE.carimbo).trim();
  const nonce = ler(CABECALHOS_DO_AGENTE.nonce).trim();
  const assinatura = ler(CABECALHOS_DO_AGENTE.assinatura).trim();
  if (!agentId || !carimbo || !nonce || !assinatura || nonce.length > 128) throw recusa();

  const agoraMs = input.agoraMs ?? Date.now();
  if (!carimboDentroDaJanela(carimbo, agoraMs)) throw recusa();

  const agente = agenteParaConferir(agentId);
  if (!agente) throw recusa();

  const frase = fraseDaAssinatura({
    metodo: input.metodo,
    caminho: input.caminho,
    carimbo,
    nonce,
    corpo: input.corpo,
  });
  if (!assinaturaConfere(agente.segredo, frase, assinatura)) throw recusa();

  // O nonce por último: um pedido com assinatura errada não pode "gastar" o
  // nonce de um pedido legítimo que ainda vai chegar.
  ensureCoreSchema();
  const db = getConnection();
  const limite = new Date(agoraMs - 2 * JANELA_DA_ASSINATURA_MS).toISOString();
  db.prepare('DELETE FROM core_payment_terminal_agent_nonces WHERE seen_at < ?').run(limite);
  const inserido = db
    .prepare(
      `INSERT OR IGNORE INTO core_payment_terminal_agent_nonces (agent_id, nonce, seen_at)
       VALUES (?, ?, ?)`,
    )
    .run(agentId, nonce, new Date(agoraMs).toISOString());
  if (Number(inserido.changes) !== 1) throw recusa();

  registrarSinalDoAgente(agentId);
  return {
    agentId,
    companyId: String(agente.row.companyId),
    pdvTerminalId: (agente.row.pdvTerminalId as string | null | undefined) ?? null,
  };
}
