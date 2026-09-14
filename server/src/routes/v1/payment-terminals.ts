import { Router } from 'express';
import { authMiddleware, requirePermission, rotaPublica, type AuthedRequest } from '../../middleware/auth.js';
import {
  conferirRequisicaoRepetida,
  requireIdempotencyKey,
  requisicaoDe,
  withIdempotency,
} from '../../services/api/ApiIdempotencyService.js';
import { ApiError } from '../../utils/errors.js';
import { decidePelaCapability, passaPelaCapabilityDaRota } from '../../services/auth/PonteDaRota.js';
import {
  processPaymentTerminalTransaction,
  testPaymentTerminalConnection,
} from '../../services/payment-terminal/PaymentTerminalProviderAdapter.js';
import type { PaymentTerminalProviderId } from '../../services/payment-terminal/PaymentTerminalCredentialService.js';
import {
  cancelPaymentTerminalTransactionBackend,
  getPaymentTerminalReceiptBackend,
  parseViaDoComprovante,
  refundPaymentTerminalTransactionBackend,
  reprintPaymentTerminalReceiptBackend,
  createAndProcessPaymentTerminalTransactionBackend,
  createPaymentTerminalConfigurationBackend,
  getPaymentTerminalDashboardBackend,
  getPaymentTerminalTransactionBackend,
  getProviderCapabilitiesBackend,
  listPaymentTerminalAgentCommandsBackend,
  listPaymentTerminalConfigurationsBackend,
  listPaymentTerminalDeadLetterBackend,
  listPaymentTerminalHomologationsBackend,
  listPaymentTerminalLocalAgentsBackend,
  listPaymentTerminalProvidersBackend,
  listPaymentTerminalRecoveryBackend,
  listPaymentTerminalTransactionsBackend,
  paymentTerminalHealth,
  paymentTerminalProvidersStatus,
  paymentTerminalReadiness,
  queryPaymentTerminalTransactionOnAgentBackend,
  runPaymentTerminalHomologationBackend,
  sanitizePaymentTerminalCredential,
  updatePaymentTerminalConfigurationBackend,
  upsertPaymentTerminalCredentials,
  upsertPaymentTerminalHomologationBackend,
  createLocalAgentPairingCode,
  confirmLocalAgentPairing,
  heartbeatLocalAgent,
  getLocalAgentStatusDetailed,
} from '../../services/payment-terminal/PaymentTerminalService.js';
import {
  registrarSinalDoAgente,
  revokeLocalAgent,
} from '../../services/payment-terminal/PaymentTerminalLocalAgentService.js';
import { autenticarPedidoDoAgente } from '../../services/payment-terminal/PaymentTerminalAgentAuth.js';
import { aguardarImpressoes, registrarResultadoDaImpressao } from '../../services/core/PrintAgentQueue.js';
import {
  aguardarComandos,
  registrarResultadoDoAgente,
} from '../../services/payment-terminal/PaymentTerminalAgentChannel.js';
import { ultimosPedidosDaEmpresa } from '../../services/payment-terminal/PaymentTerminalTransactionEffects.js';

export const paymentTerminalsRouter = Router();

/*
  QUEM CONFIGURA A MAQUININHA É A GERÊNCIA (GAP-PRD-014/076).

  A matriz de permissões dá escrita em `payment-terminal.*` aos caixas — e
  precisa dar: o caixa COBRA. Mas cadastrar maquininha, gravar credencial,
  parear agente, revogá-lo e homologar mudam o que o balcão exige no cartão;
  com a porta aberta ao caixa, o operador desligaria a regra que confere o
  próprio trabalho. Estas rotas pedem, além da permissão do módulo, um dos
  perfis da gerência — os mesmos do liga/desliga (`/core/pdv/terminal/configurations`).
*/
const GERENCIA_DA_MAQUININHA = ['gerente_loja', 'gerente_oficina'] as const;

function requireProfile(req: AuthedRequest, ...allowed: string[]): void {
  // Vínculo personalizado na tela de Usuários: só a capability da rota decide
  // (PonteDaRota.ts) — que já carrega a interseção com a gerência da maquininha.
  if (decidePelaCapability(req)) {
    if (passaPelaCapabilityDaRota(req)) return;
    throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
  }
  const profiles = req.auth?.profileCodes ?? [];
  if (profiles.includes('admin_geral') || profiles.includes('gestor')) return;
  if (allowed.some((p) => profiles.includes(p))) return;
  throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
}

/** O agente que assinou este pedido — ou 401 (ver `PaymentTerminalAgentAuth`). */
function agenteDoPedido(req: AuthedRequest) {
  return autenticarPedidoDoAgente({
    headers: req.headers,
    metodo: req.method,
    caminho: req.originalUrl,
    corpo: (req as unknown as { rawBody?: Buffer }).rawBody ?? '',
  });
}

paymentTerminalsRouter.get('/health', rotaPublica('sonda de saúde: monitor e deploy batem aqui antes de existir sessão'), (_req, res) => {
  res.json(paymentTerminalHealth());
});

// ================================================================ agente local
/*
  AS PORTAS DO AGENTE LOCAL (GAP-PRD-014).

  O agente é um programa no computador do caixa: não tem sessão de usuário.
  O pareamento usa o código de uso único gerado pelo gestor (10 min); daí em
  diante todo pedido vai assinado com o segredo entregue no pareamento
  (HMAC-SHA256 sobre método, caminho, carimbo, nonce e corpo cru). Sem
  assinatura válida, 401 — a mesma resposta para id inexistente, segredo
  errado e pedido repetido.
*/
paymentTerminalsRouter.post(
  '/agent/pair',
  rotaPublica('o agente local ainda não tem identidade: a prova é o código de pareamento de uso único e dez minutos gerado pelo gestor'),
  (req: AuthedRequest, res, next) => {
    try {
      res.status(201).json(confirmLocalAgentPairing({
        pairingCode: String(req.body?.pairingCode ?? ''),
        version: req.body?.version ? String(req.body.version).slice(0, 40) : undefined,
        hostname: req.body?.hostname ? String(req.body.hostname).slice(0, 120) : undefined,
      }));
    } catch (err) {
      next(err);
    }
  },
);

paymentTerminalsRouter.post(
  '/agent/heartbeat',
  rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário'),
  (req: AuthedRequest, res, next) => {
    try {
      const agente = agenteDoPedido(req);
      const health = req.body?.health && typeof req.body.health === 'object' ? req.body.health : null;
      registrarSinalDoAgente(agente.agentId, {
        version: req.body?.version ? String(req.body.version).slice(0, 40) : undefined,
        hostname: req.body?.hostname ? String(req.body.hostname).slice(0, 120) : undefined,
        health,
      });
      res.json({
        ok: true,
        agentId: agente.agentId,
        pdvTerminalId: agente.pdvTerminalId,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

paymentTerminalsRouter.get(
  '/agent/commands',
  rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário'),
  (req: AuthedRequest, res, next) => {
    (async () => {
      try {
        const agente = agenteDoPedido(req);
        const espera = Number(req.query.waitMs ?? 0);
        const items = await aguardarComandos(agente, espera);
        res.json({ items, serverTime: new Date().toISOString() });
      } catch (err) {
        next(err);
      }
    })();
  },
);

paymentTerminalsRouter.post(
  '/agent/commands/:id/result',
  rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário'),
  (req: AuthedRequest, res, next) => {
    try {
      const agente = agenteDoPedido(req);
      res.json(registrarResultadoDoAgente(agente, String(req.params.id), req.body));
    } catch (err) {
      next(err);
    }
  },
);

/*
  AS IMPRESSÕES DO AGENTE LOCAL (GAP-PRD-082).

  O MESMO programa que fala com o PinPad retira os cupons da impressora de
  agente do caixa dele (ESC/POS, com o pulso da gaveta quando pedido) e conta
  se imprimiu. Mesma identidade (assinatura HMAC do segredo do pareamento),
  mesmo long-poll de 25 s. A fila é `core_print_jobs` (`PrintAgentQueue`).
*/
paymentTerminalsRouter.get(
  '/agent/print-jobs',
  rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário'),
  (req: AuthedRequest, res, next) => {
    (async () => {
      try {
        const agente = agenteDoPedido(req);
        const items = await aguardarImpressoes(agente, Number(req.query.waitMs ?? 0));
        res.json({ items, serverTime: new Date().toISOString() });
      } catch (err) {
        next(err);
      }
    })();
  },
);

paymentTerminalsRouter.post(
  '/agent/print-jobs/:id/result',
  rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário'),
  (req: AuthedRequest, res, next) => {
    try {
      const agente = agenteDoPedido(req);
      res.json(registrarResultadoDaImpressao(agente, String(req.params.id), req.body ?? {}));
    } catch (err) {
      next(err);
    }
  },
);

// ================================================================ módulo

paymentTerminalsRouter.get('/readiness', authMiddleware, requirePermission('payment-terminal.view'), (req: AuthedRequest, res) => {
  res.json(paymentTerminalReadiness(req.auth!.companyId));
});

paymentTerminalsRouter.get('/providers-status', authMiddleware, requirePermission('payment-terminal.view'), async (req: AuthedRequest, res) => {
  res.json(await paymentTerminalProvidersStatus(req.auth!.companyId));
});

paymentTerminalsRouter.get('/local-agent/status', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res) => {
  res.json(getLocalAgentStatusDetailed(req.auth!.companyId, req.query.storeId as string | undefined));
});

paymentTerminalsRouter.post('/local-agent/pairing', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.status(201).json(createLocalAgentPairingCode({
      companyId: req.auth!.companyId,
      storeId: req.body?.storeId ?? req.auth!.storeId,
      operationalUnitId: req.body?.operationalUnitId ?? req.auth!.storeId,
      terminalId: req.body?.terminalId,
      // O caixa (`core_terminals`) cujo computador vai rodar o agente.
      pdvTerminalId: req.body?.pdvTerminalId ?? null,
      createdBy: req.auth!.sub,
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/local-agent/pair', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.json(confirmLocalAgentPairing({
      companyId: req.auth!.companyId,
      pairingCode: String(req.body?.pairingCode ?? ''),
      version: req.body?.version as string | undefined,
      storeId: req.body?.storeId ?? req.auth!.storeId,
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/local-agent/heartbeat', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.json(heartbeatLocalAgent({
      companyId: req.auth!.companyId,
      agentId: String(req.body?.agentId ?? ''),
      version: req.body?.version as string | undefined,
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/local-agents/:id/revoke', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.json(revokeLocalAgent({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      agentId: String(req.params.id),
      reason: String(req.body?.reason ?? ''),
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.get('/agent-commands', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.json({
      items: listPaymentTerminalAgentCommandsBackend(req.auth!.companyId, {
        status: req.query.status ? String(req.query.status) : undefined,
        transactionId: req.query.transactionId ? String(req.query.transactionId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.get('/providers', authMiddleware, requirePermission('payment-terminal.view'), (_req, res) => {
  res.json({ items: listPaymentTerminalProvidersBackend() });
});

paymentTerminalsRouter.get('/providers/:provider/capabilities', authMiddleware, requirePermission('payment-terminal.view'), (req, res) => {
  res.json(getProviderCapabilitiesBackend(String(req.params.provider)));
});

paymentTerminalsRouter.get('/configurations', authMiddleware, requirePermission('payment-terminal.configuration.view'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalConfigurationsBackend(req.auth!.companyId, req.query.storeId as string | undefined) });
});

paymentTerminalsRouter.post('/configurations', authMiddleware, requirePermission('payment-terminal.configuration.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const provider = String(req.body?.provider ?? 'mock');
    const payload = withIdempotency(idempotencyKey, req.auth!.companyId, () =>
      createPaymentTerminalConfigurationBackend({
        companyId: req.auth!.companyId,
        storeId: req.body?.storeId ?? req.auth!.storeId,
        operationalUnitId: req.body?.operationalUnitId ?? req.auth!.storeId,
        provider,
        terminalType: req.body?.terminalType ?? 'tef',
        terminalIdentifier: req.body?.terminalIdentifier ?? (provider === 'mock' ? 'MOCK-001' : null),
        displayName: req.body?.displayName ?? (provider === 'mock' ? 'Terminal Mock' : `Maquininha ${provider}`),
        integrationMode: req.body?.integrationMode ?? 'backend_api',
        // Sem modo informado, o serviço grava o único caminho que existe
        // (agente local) — ver `modoPadrao`.
        connectionMode: req.body?.connectionMode,
        pdvTerminalId: req.body?.pdvTerminalId ?? null,
        createdBy: req.auth!.sub,
        idempotencyKey,
      }) as Record<string, unknown>,
      requisicaoDe(req),
    );
    res.status(201).json(sanitizePaymentTerminalCredential(payload));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.patch('/configurations/:id', authMiddleware, requirePermission('payment-terminal.configuration.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.json(updatePaymentTerminalConfigurationBackend({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      configurationId: String(req.params.id),
      displayName: req.body?.displayName,
      terminalIdentifier: req.body?.terminalIdentifier,
      pdvTerminalId: req.body?.pdvTerminalId,
      connectionMode: req.body?.connectionMode,
      primary: req.body?.primary,
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/credentials', authMiddleware, requirePermission('payment-terminal.configuration.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const token = req.body?.accessToken ?? req.body?.merchantKey ?? req.body?.clientSecret;
    if (!token) {
      res.status(400).json({ error: { code: 'PAYMENT_TERMINAL_CREDENTIALS_REQUIRED', message: 'Credencial obrigatória no backend.' } });
      return;
    }
    const payload = withIdempotency(idempotencyKey, req.auth!.companyId, () =>
      sanitizePaymentTerminalCredential(upsertPaymentTerminalCredentials({
        companyId: req.auth!.companyId,
        storeId: req.body?.storeId,
        provider: String(req.body?.provider ?? 'mock') as PaymentTerminalProviderId,
        environment: req.body?.environment === 'production' ? 'production' : 'sandbox',
        configurationId: req.body?.configurationId ? String(req.body.configurationId) : undefined,
        connectionMode: req.body?.connectionMode ? String(req.body.connectionMode) : undefined,
        credentials: {
          accessToken: String(token),
          merchantKey: req.body?.merchantKey,
          merchantId: req.body?.merchantId,
          clientId: req.body?.clientId,
          clientSecret: req.body?.clientSecret,
          terminalSerial: req.body?.terminalSerial,
          establishmentCode: req.body?.establishmentCode,
        },
      }) as Record<string, unknown>),
      requisicaoDe(req),
    );
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.get('/terminals', authMiddleware, requirePermission('payment-terminal.terminal.view'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalConfigurationsBackend(req.auth!.companyId, req.query.storeId as string | undefined) });
});

paymentTerminalsRouter.post('/providers/:provider/test-connection', authMiddleware, requirePermission('payment-terminal.terminal.test'), async (req: AuthedRequest, res) => {
  res.json(await testPaymentTerminalConnection(req.auth!.companyId, String(req.params.provider) as PaymentTerminalProviderId, req.body?.storeId));
});

paymentTerminalsRouter.post('/providers/:provider/test-transaction', authMiddleware, requirePermission('payment-terminal.transaction.create'), (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      // Roteiro de teste do adaptador: não é cobrança do balcão, e fica com a
      // gerência (a cobrança do caixa é POST /core/pdv/terminal/charge).
      requireProfile(req, ...GERENCIA_DA_MAQUININHA);
      res.json(await processPaymentTerminalTransaction(req.auth!.companyId, String(req.params.provider) as PaymentTerminalProviderId, {
        paymentMethod: String(req.body?.paymentMethod ?? 'credit'),
        amountInCents: Number(req.body?.amountInCents ?? 1000),
        installments: Number(req.body?.installments ?? 1),
        scenario: req.body?.scenario,
        storeId: req.body?.storeId,
      }));
    } catch (err) {
      next(err);
    }
  })();
});

/*
  Cada cobrança sai com o ÚLTIMO pedido de cancelamento/estorno feito para ela
  (GAP-PRD-075). Os pedidos eram gravados — inclusive o que a operadora não
  confirmou — e ninguém os lia: a gerência pedia um estorno, o agente não
  respondia, e a lista mostrava a cobrança como se nada tivesse sido pedido.
*/
paymentTerminalsRouter.get('/transactions', authMiddleware, requirePermission('payment-terminal.transaction.view'), (req: AuthedRequest, res) => {
  const companyId = req.auth!.companyId;
  const pedidos = ultimosPedidosDaEmpresa(companyId);
  res.json({
    items: listPaymentTerminalTransactionsBackend(companyId, req.query.storeId as string | undefined)
      .map((tx) => ({ ...tx, ultimoPedido: pedidos.get(String(tx.id)) ?? null })),
  });
});

paymentTerminalsRouter.post('/transactions', authMiddleware, requirePermission('payment-terminal.transaction.create'), async (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const companyId = req.auth!.companyId;
    const payload = await createAndProcessPaymentTerminalTransactionBackend({
      companyId,
      storeId: req.body?.storeId ?? req.auth!.storeId,
      terminalConfigurationId: req.body?.terminalConfigurationId,
      provider: req.body?.provider ?? 'mock',
      environment: req.body?.environment ?? 'sandbox',
      terminalIdentifier: req.body?.terminalIdentifier ?? 'MOCK-001',
      paymentMethod: req.body?.paymentMethod ?? 'credit',
      amountInCents: req.body?.amountInCents ?? 0,
      installments: req.body?.installments ?? 1,
      scenario: req.body?.scenario,
      idempotencyKey,
      correlationId: idempotencyKey,
      createdBy: req.auth!.sub,
    });
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.get('/transactions/:id', authMiddleware, requirePermission('payment-terminal.transaction.view'), (req: AuthedRequest, res) => {
  const tx = getPaymentTerminalTransactionBackend(req.auth!.companyId, String(req.params.id));
  if (!tx) { res.status(404).json({ error: { code: 'PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND' } }); return; }
  res.json(tx);
});

/*
  CANCELAR E ESTORNAR SÓ COM A CONFIRMAÇÃO DO PROVEDOR (GAP-PRD-079).

  Estas duas rotas gravavam `status: result.status ?? 'cancelled'` — e para
  provedor real o adaptador responde pendente SEM status, então "a operadora
  não fez nada" virava cancelado/estornado. As regras (estado de origem,
  cobrança amarrada a venda, valor do estorno, trava do mock, registro da
  tentativa, auditoria) moram no serviço; aqui só se traduz a requisição.

  Pelo agente local (GAP-PRD-014) o pedido vai para a fila e a resposta é 202:
  a cobrança muda quando o aparelho confirmar.
*/
paymentTerminalsRouter.post('/transactions/:id/cancel', authMiddleware, requirePermission('payment-terminal.transaction.cancel'), async (req: AuthedRequest, res, next) => {
  try {
    const resultado = await cancelPaymentTerminalTransactionBackend({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      transactionId: String(req.params.id),
      reason: req.body?.reason,
    });
    res.status(resultado.queuedToAgent ? 202 : 200).json(resultado);
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/transactions/:id/refund', authMiddleware, requirePermission('payment-terminal.transaction.refund'), async (req: AuthedRequest, res, next) => {
  try {
    const bruto = req.body?.amountInCents;
    const resultado = await refundPaymentTerminalTransactionBackend({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      transactionId: String(req.params.id),
      amountInCents: bruto === undefined || bruto === null || bruto === '' ? null : Number(bruto),
      reason: req.body?.reason,
    });
    res.status(resultado.queuedToAgent ? 202 : 200).json(resultado);
  } catch (err) {
    next(err);
  }
});

/*
  "Consulte no aparelho" (GAP-PRD-014): a cobrança NÃO CONFIRMADA feita pelo
  agente local pode ter o desfecho perguntado ao cliente TEF. Decisão de
  gerência, como a conferência pelo extrato.
*/
paymentTerminalsRouter.post('/transactions/:id/query', authMiddleware, requirePermission('payment-terminal.reconciliation.manage'), (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA_DA_MAQUININHA);
    res.status(202).json(queryPaymentTerminalTransactionOnAgentBackend({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      transactionId: String(req.params.id),
    }));
  } catch (err) {
    next(err);
  }
});

/*
  COMPROVANTE E REIMPRESSÃO REAIS (GAP-PRD-162).

  Respondiam 200 com um objeto fabricado, sem consultar nada e sem conferir
  empresa — até para id que não existe. Agora devolvem o texto que a
  adquirente mandou na cobrança (guardado em `payment_terminal_receipts`), com
  404 para transação de outra operação ou inexistente, e 404 próprio quando a
  cobrança não tem comprovante.
*/
paymentTerminalsRouter.get('/transactions/:id/receipt', authMiddleware, requirePermission('payment-terminal.receipt.view'), (req: AuthedRequest, res, next) => {
  try {
    res.json(getPaymentTerminalReceiptBackend(
      req.auth!.companyId,
      String(req.params.id),
      parseViaDoComprovante(req.query.via),
    ));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.post('/transactions/:id/reprint', authMiddleware, requirePermission('payment-terminal.receipt.reprint'), (req: AuthedRequest, res, next) => {
  try {
    res.json(reprintPaymentTerminalReceiptBackend({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      transactionId: String(req.params.id),
      via: parseViaDoComprovante(req.body?.via ?? req.query.via),
    }));
  } catch (err) {
    next(err);
  }
});

paymentTerminalsRouter.get('/homologation', authMiddleware, requirePermission('payment-terminal.homologation.run'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalHomologationsBackend(req.auth!.companyId) });
});

paymentTerminalsRouter.post('/homologation/run', authMiddleware, requirePermission('payment-terminal.homologation.run'), (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      requireProfile(req, ...GERENCIA_DA_MAQUININHA);
      const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
      const provider = String(req.body?.provider ?? 'mock') as PaymentTerminalProviderId;
      // A mesma chave com outro pedido é recusada ANTES de a rodada rodar.
      conferirRequisicaoRepetida(idempotencyKey, req.auth!.companyId, requisicaoDe(req));
      const runResult = await runPaymentTerminalHomologationBackend(req.auth!.companyId, provider, req.body?.storeId);
      const payload = withIdempotency(idempotencyKey, req.auth!.companyId, () =>
        upsertPaymentTerminalHomologationBackend({
          companyId: req.auth!.companyId,
          provider,
          storeId: req.body?.storeId,
          status: runResult.status,
          stepsCompleted: runResult.stepsCompleted,
          homologated: runResult.homologated,
          message: runResult.message,
          productionEnabled: false,
          startedAt: new Date().toISOString(),
          completedAt: runResult.homologated ? new Date().toISOString() : undefined,
          idempotencyKey,
        }) as Record<string, unknown>,
        requisicaoDe(req),
      );
      res.status(202).json({ ...payload, ...runResult });
    } catch (err) {
      next(err);
    }
  })();
});

paymentTerminalsRouter.get('/local-agents', authMiddleware, requirePermission('payment-terminal.settings.manage'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalLocalAgentsBackend(req.auth!.companyId) });
});

paymentTerminalsRouter.get('/dashboard', authMiddleware, requirePermission('payment-terminal.dashboard.view'), (req: AuthedRequest, res) => {
  res.json(getPaymentTerminalDashboardBackend(req.auth!.companyId));
});

paymentTerminalsRouter.get('/recovery', authMiddleware, requirePermission('payment-terminal.recovery.manage'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalRecoveryBackend(req.auth!.companyId) });
});

/*
  `GET /reconciliation` SAIU (GAP-PRD-075). Lia `payment_terminal_reconciliation`,
  coleção que nenhum código escreve: respondia `{ items: [] }` sempre, e o
  contrato publicado a anunciava. Nenhuma tela a chamava. A conferência da
  maquininha de verdade é a do núcleo — cobranças sem venda e pendências do
  turno (`/core/pdv/terminal/*`), sobre `payment_terminal_transactions`.
*/

paymentTerminalsRouter.get('/dead-letter', authMiddleware, requirePermission('payment-terminal.recovery.manage'), (req: AuthedRequest, res) => {
  res.json({ items: listPaymentTerminalDeadLetterBackend(req.auth!.companyId) });
});
