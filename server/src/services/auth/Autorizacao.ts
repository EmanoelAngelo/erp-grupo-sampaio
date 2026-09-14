/**
 * ============================================================================
 * AS GUARDAS POR CAPABILITY — o servidor decide, pela capability do vínculo
 * ============================================================================
 *
 * RBAC granular, F1 (desenho §4.1). Toda rota guardada passa a chamar uma
 * destas funções na posição incondicional que a regra `rota-declara-alcance`
 * já cobra — a F2 traduz as ~540 guardas por perfil, fatia por fatia, e esta é
 * a API que elas passam a usar:
 *
 *   requireCapability(req, 'finance.manage')
 *   requireAnyCapability(req, 'customers.view', 'pdv.sell', 'workshop.orders.open')
 *   requireAllCapabilities(req, 'sales.quotes.manage', 'pdv.cash.operate')
 *   comCapability('logistics.manage')            // middleware, roteadores que guardam por argumento
 *   comQualquerCapability('integrations.asaas.view', …)
 *   can(acesso, 'inventory.cost.view')           // para serviço: custo, contato do cliente, alçada
 *   requireTerminalNoEscopo(req, terminalId)     // o caixa efetivo no escopo do vínculo (§6)
 *   bancadasDoVinculo(req)                       // 'todas' | as bancadas do vínculo (§7)
 *
 * Nenhuma consulta o banco para a capability: todas leem `req.auth.acesso`,
 * que `authMiddleware` preenche com o acesso efetivo do vínculo DE AGORA
 * (`ContaDaSessao.ts`). Nenhuma pergunta pelo código do perfil: o
 * administrador passa porque o modelo dele é o catálogo inteiro, e não por um
 * "se admin, libera".
 *
 * A recusa usa o código de hoje (`API_PERMISSION_DENIED`, o que a tela e os
 * testes já tratam) com a mensagem que nomeia o que falta, e o detalhe com as
 * capabilities e a empresa — compatível com `requireProfile`.
 */
import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../middleware/auth.js';
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import {
  capabilitiesDaExpressao,
  passaNaExpressao,
  rotuloDe,
  type Capability,
  type ExpressaoDeCapability,
} from './Capabilities.js';
import type { AcessoEfetivo } from './AcessoEfetivo.js';

/** O acesso da sessão desta requisição. Sem sessão é 401; sessão sem acesso é 403. */
export function acessoDaRequisicao(req: AuthedRequest): AcessoEfetivo {
  if (!req.auth) throw new ApiError('API_AUTHENTICATION_REQUIRED', 'Autenticação obrigatória.', 401);
  const acesso = req.auth.acesso;
  if (!acesso) {
    throw new ApiError('API_PERMISSION_DENIED', 'Esta sessão não tem acesso nesta empresa.', 403, {
      capabilities: [],
      companyId: req.auth.companyId,
    });
  }
  return acesso;
}

/** O acesso tem a capability? Para serviços; acesso ausente é "não". */
export function can(acesso: AcessoEfetivo | null | undefined, capability: Capability): boolean {
  return Boolean(acesso?.capabilities.has(capability));
}

/** O acesso passa na expressão? Acesso ausente é "não". */
export function passa(acesso: AcessoEfetivo | null | undefined, expressao: ExpressaoDeCapability): boolean {
  return acesso ? passaNaExpressao(acesso.capabilities, expressao) : false;
}

/**
 * A recusa, dizendo o que falta pelo nome que a tela mostra.
 *
 * Em "todas", só as que faltam; em "qualquer", todas as que abririam a porta —
 * é o que a pessoa leva a quem administra os usuários.
 */
export function recusaPorCapability(acesso: AcessoEfetivo, expressao: ExpressaoDeCapability): ApiError {
  const citadas = capabilitiesDaExpressao(expressao);
  const faltam = 'todas' in expressao ? citadas.filter((c) => !acesso.capabilities.has(c)) : [...citadas];
  const juncao = 'qualquer' in expressao ? ' ou ' : ' e ';
  return new ApiError(
    'API_PERMISSION_DENIED',
    `Seu acesso nesta empresa não inclui: ${faltam.map(rotuloDe).join(juncao)}.`,
    403,
    {
      capabilities: faltam,
      exigencia: 'uma' in expressao ? 'uma' : 'qualquer' in expressao ? 'qualquer' : 'todas',
      companyId: acesso.companyId,
    },
  );
}

/** A expressão, contra o acesso da requisição. Lança a recusa. */
export function requireExpressao(req: AuthedRequest, expressao: ExpressaoDeCapability): void {
  const acesso = acessoDaRequisicao(req);
  if (!passaNaExpressao(acesso.capabilities, expressao)) throw recusaPorCapability(acesso, expressao);
}

export function requireCapability(req: AuthedRequest, capability: Capability): void {
  requireExpressao(req, { uma: capability });
}

export function requireAnyCapability(req: AuthedRequest, ...capabilities: [Capability, ...Capability[]]): void {
  requireExpressao(req, { qualquer: capabilities });
}

export function requireAllCapabilities(req: AuthedRequest, ...capabilities: [Capability, ...Capability[]]): void {
  requireExpressao(req, { todas: capabilities });
}

function comoMiddleware(expressao: ExpressaoDeCapability) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    try {
      requireExpressao(req, expressao);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** A guarda como argumento da rota, antes do handler — o idioma dos roteadores fora de core.ts. */
export function comCapability(capability: Capability) {
  return comoMiddleware({ uma: capability });
}

export function comQualquerCapability(...capabilities: [Capability, ...Capability[]]) {
  return comoMiddleware({ qualquer: capabilities });
}

/**
 * O caixa efetivo está no escopo do vínculo? (desenho §6.2)
 *
 * As capabilities de escopo `pdv` exigem, ALÉM da capability, o caixa no
 * escopo. O caixa efetivo continua sendo o de `terminalDoPedido` (o token
 * vence o corpo). A F2(a) chama isto em cada ponto que opera caixa.
 *
 *   - vínculo com "todos os caixas" → passa (é como todos nascem no passo 86);
 *   - empresa sem caixa ativo → "PDV único da empresa": vale só a capability;
 *   - lista vazia → 403, sem caixa nenhum no acesso;
 *   - sem caixa informado → 409, escolha o caixa;
 *   - caixa fora da lista → 403, com o nome do caixa.
 */
export function requireTerminalNoEscopo(req: AuthedRequest, terminalId: string | null | undefined): void {
  const acesso = acessoDaRequisicao(req);
  if (acesso.terminais === 'todos') return;
  const db = getConnection();
  const ativos = (db
    .prepare('SELECT COUNT(*) AS n FROM core_terminals WHERE company_id = ? AND active = 1')
    .get(acesso.companyId) as { n: number }).n;
  if (ativos === 0) return;
  if (acesso.terminais.length === 0) {
    throw new ApiError(
      'CORE_TERMINAL_OUT_OF_SCOPE',
      'Seu acesso nesta empresa não inclui nenhum caixa. Peça a quem administra os usuários.',
      403,
      { companyId: acesso.companyId, terminalId: terminalId ?? null },
    );
  }
  if (!terminalId) {
    throw new ApiError(
      'CORE_TERMINAL_REQUIRED',
      'Escolha o caixa: seu acesso nesta empresa vale só em alguns caixas.',
      409,
      { companyId: acesso.companyId, terminais: acesso.terminais },
    );
  }
  if (!acesso.terminais.includes(terminalId)) {
    const nome = (db
      .prepare('SELECT name FROM core_terminals WHERE id = ? AND company_id = ?')
      .get(terminalId, acesso.companyId) as { name?: string } | undefined)?.name ?? terminalId;
    throw new ApiError(
      'CORE_TERMINAL_OUT_OF_SCOPE',
      `O caixa "${nome}" não está no seu acesso nesta empresa.`,
      403,
      { companyId: acesso.companyId, terminalId },
    );
  }
}

/** As bancadas do vínculo: `todas` as ativas, ou a lista (vazia = nenhuma — falha fechada). */
export function bancadasDoVinculo(req: AuthedRequest): 'todas' | readonly string[] {
  return acessoDaRequisicao(req).bancadas;
}

/**
 * Pode ser titular de token de computador do caixa (decisão do dono): tem
 * `pdv.device_login` e o modelo NÃO é de dono (`assignable_by = grupo`) —
 * conta de administrador nunca vira sessão sem senha, mesmo tendo o catálogo
 * inteiro. A F2(e) cobra isto no cadastro e no login do dispositivo (D9, D10).
 */
export function podeSerTitularDeToken(acesso: AcessoEfetivo | null | undefined): boolean {
  return can(acesso, 'pdv.device_login') && acesso!.modelo.assignableBy !== 'grupo';
}
