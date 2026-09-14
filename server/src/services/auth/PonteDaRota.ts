/**
 * ============================================================================
 * A PONTE DO ACESSO GRANULAR (escopo reduzido da entrega)
 * ============================================================================
 *
 * As ≈540 guardas por perfil (`requireProfile`/`abertaAo` em core.ts) ficam
 * como estão. Quando o PERFIL do vínculo não está na lista de uma rota, a rota
 * abre também para quem tem, no acesso efetivo do vínculo (lido do banco nesta
 * requisição), a CAPABILITY dela — a expressão calculada rota a rota em
 * `CapabilityDaRota.ts` (gerado de scripts/rbac/mapa-final.json).
 *
 * Por que isto não abre porta para ninguém de hoje: os modelos de sistema
 * foram derivados para dar EXATAMENTE o acesso de hoje (a equivalência modelo ×
 * rota e a varredura por modelo cobram). A ponte só muda o resultado para o
 * vínculo PERSONALIZADO pela tela de Usuários — o dono dá a capability, a rota
 * abre; tira, fecha na requisição seguinte.
 *
 * Rota fora da tabela: só a guarda por perfil (falha fechada).
 */
import type { AuthedRequest } from '../../middleware/auth.js';
import { chaveDaRota } from '../../middleware/auth.js';
import { expressaoDoTexto, passaNaExpressao, type ExpressaoDeCapability } from './Capabilities.js';
import { CAPABILITY_DA_ROTA } from './CapabilityDaRota.js';
import { requireTerminalNoEscopo } from './Autorizacao.js';
import { terminalDoPedido } from '../core/TerminalRegistry.js';

const expressoes = new Map<string, ExpressaoDeCapability | null>();

/** A expressão de capability da rota desta requisição, ou `null` se a rota não está na tabela. */
export function expressaoDaRequisicao(req: AuthedRequest): ExpressaoDeCapability | null {
  const chave = chaveDaRota(req);
  if (!expressoes.has(chave)) {
    const texto = CAPABILITY_DA_ROTA[chave];
    expressoes.set(chave, texto ? expressaoDoTexto(texto) : null);
  }
  return expressoes.get(chave) ?? null;
}

/**
 * O vínculo foi PERSONALIZADO na tela de Usuários (páginas dadas ou tiradas
 * sobre o modelo)? Então quem decide a rota é SÓ a capability: a página
 * retirada tem de fechar mesmo para quem tem um perfil de hoje que a guarda
 * por perfil deixaria passar (o gerente de loja sem Fiscal). Vínculo com o
 * modelo puro segue a guarda por perfil + a ponte — o acesso de hoje.
 */
export function decidePelaCapability(req: AuthedRequest): boolean {
  return req.auth?.acesso?.modelo.personalizado === true;
}

/** O acesso efetivo do vínculo tem a capability desta rota? */
export function passaPelaCapabilityDaRota(req: AuthedRequest): boolean {
  const acesso = req.auth?.acesso;
  if (!acesso) return false;
  const expressao = expressaoDaRequisicao(req);
  return expressao !== null && passaNaExpressao(acesso.capabilities, expressao);
}

/**
 * O caixa efetivo do pedido (o do token de dispositivo vence o do corpo) E no
 * escopo de caixas do vínculo. Vínculo com "todos os caixas" (como todos
 * nascem) e empresa sem caixa cadastrado passam sem mudança: o recorte só vale
 * para quem o dono restringiu a caixas específicos.
 */
export function caixaNoEscopo(
  req: AuthedRequest,
  input: { informado: unknown; doDispositivo: string | null | undefined },
): string | null {
  const caixa = terminalDoPedido(input);
  if (req.auth?.acesso) requireTerminalNoEscopo(req, caixa);
  return caixa;
}
