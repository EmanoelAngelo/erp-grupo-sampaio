import { Router } from 'express';
import { authMiddleware, requirePermission, rotaPublica, type AuthedRequest } from '../../middleware/auth.js';
import {
  conferirRequisicaoRepetida,
  requireIdempotencyKey,
  requisicaoDe,
  withIdempotency,
} from '../../services/api/ApiIdempotencyService.js';
import {
  backendLogisticsQuote,
  createLogisticsQuote,
  getLogisticsHomologationBackend,
  getLogisticsQuoteById,
  listLogisticsCarrierConfigs,
  logisticsHealth,
  logisticsProvidersStatus,
  logisticsReadiness,
  runLogisticsHomologationBackend,
  sanitizeLogisticsCredentialForResponse,
  upsertLogisticsHomologationBackend,
  upsertLogisticsCredentials,
} from '../../services/logistics/LogisticsService.js';
import {
  resolveCarrierAccess,
  testLogisticsCarrierConnection,
  trackLogisticsCarrier,
} from '../../services/logistics/LogisticsCarrierAdapter.js';
import {
  isLogisticsCarrierId,
  lerEntradaDeCredencial,
  removeLogisticsCredentials,
} from '../../services/logistics/LogisticsCredentialService.js';
import {
  cancelarEnvio,
  comprarEtiqueta,
  continuarEtiqueta,
  lerConfiguracaoDeEnvio,
  linkParaImprimir,
  listarEnviosDaEmpresa,
  listarEnviosDoPedido,
  prontidaoDaEtiqueta,
  salvarConfiguracaoDeEnvio,
  servicosParaOPedido,
  sincronizarEnvio,
} from '../../services/logistics/EnvioDoPedidoService.js';
import { recordAudit } from '../../services/audit/AuditService.js';
import { ApiError } from '../../utils/errors.js';

export const logisticsRouter = Router();

logisticsRouter.get('/health', rotaPublica('sonda de saúde: monitor e deploy batem aqui antes de existir sessão'), (_req, res) => {
  res.json(logisticsHealth());
});

logisticsRouter.get('/readiness', authMiddleware, requirePermission('logistics.view'), (req: AuthedRequest, res) => {
  res.json(logisticsReadiness(req.auth!.companyId));
});

/*
  ============================================================================
  HANDLER `async` SEM `next(err)` NÃO RESPONDE NUNCA — nem com erro
  ============================================================================

  Este roteador roda sobre Express 4, que NÃO conhece promessa: o que um
  handler `async` rejeita não chega ao tratador de erros. A requisição fica
  aberta, sem resposta e sem status, até o cliente desistir — e a tela
  Logística fica girando para sempre. Em produção a rejeição só vira uma linha
  de log (`instalarRedeDeSeguranca`); na suíte, derruba o processo do teste.

  Eram três rotas assim aqui. Duas delas (as de teste, logo abaixo) tinham
  também o gatilho: o `:carrier` da URL entrava sem conferência nenhuma, e
  `simulateQuote` indexa uma tabela por transportadora — nome desconhecido é
  `undefined.map(...)`, um TypeError dentro da promessa. As irmãs
  (`test-connection`, `DELETE credentials`) já conferiam o nome; estas duas
  ficaram de fora.

  As três passam a devolver o erro pelo `next` — e as de teste recusam a
  transportadora desconhecida com o mesmo 400 das irmãs, antes de chamar nada.
*/
logisticsRouter.get('/providers-status', authMiddleware, requirePermission('logistics.view'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(await logisticsProvidersStatus(req.auth!.companyId));
  } catch (err) {
    next(err);
  }
});

/**
 * Os envios da operação — os de verdade, de `core_shipments`, cada um de um
 * pedido (GAP-PRD-120). Era a coleção `logistics_shipments`, que só o POST cru
 * abaixo escrevia.
 */
logisticsRouter.get('/shipments', authMiddleware, requirePermission('logistics.shipment.view'), (req: AuthedRequest, res, next) => {
  try {
    res.json({ items: listarEnviosDaEmpresa(req.auth!.companyId) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ envio do pedido
//
// ETIQUETA, RASTREIO E CANCELAMENTO PELO PROVEDOR (GAP-PRD-120, GAP-PRD-119).
// O despacho (quem leva + código) e a entrega pelo operador continuam na rota
// de etapas do pedido, `/core/orders/:id/fulfillment`, que agora passa por
// `avancarEtapaDoPedido`. A empresa vem SEMPRE da sessão: envio ou pedido de
// outra empresa responde o mesmo 404 do inexistente.

/** O que falta para comprar a etiqueta, e os envios que o pedido já tem. */
logisticsRouter.get('/orders/:orderId/shipments', authMiddleware, requirePermission('logistics.shipment.view'), (req: AuthedRequest, res, next) => {
  try {
    const companyId = req.auth!.companyId;
    const orderId = String(req.params.orderId);
    res.json({
      readiness: prontidaoDaEtiqueta(companyId, orderId),
      items: listarEnviosDoPedido(companyId, orderId),
    });
  } catch (err) {
    next(err);
  }
});

/** Os serviços do Melhor Envio para o pacote deste pedido (cotação real). */
logisticsRouter.post('/orders/:orderId/services', authMiddleware, requirePermission('logistics.quote.request'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(await servicosParaOPedido(req.auth!.companyId, String(req.params.orderId)));
  } catch (err) {
    next(err);
  }
});

/**
 * Comprar a etiqueta do pedido: carrinho → pagamento → geração. Gasta saldo
 * da carteira do provedor — por isso a chave de idempotência é obrigatória.
 */
logisticsRouter.post('/orders/:orderId/label', authMiddleware, requirePermission('logistics.label.create'), async (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const resultado = await comprarEtiqueta({
      companyId: req.auth!.companyId,
      orderId: String(req.params.orderId),
      userId: req.auth!.sub,
      idempotencyKey,
      destinatario: req.body?.destinatario,
      servico: req.body?.servico ?? null,
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

/**
 * A ROTA CRUA SAIU (GAP-PRD-120). Gravava qualquer corpo como "quoted" — sem
 * pedido, sem provedor, com `companyId` de corpo por cima e campos inventados
 * junto. Criar envio agora é comprar a etiqueta DE UM PEDIDO: `orderId` é
 * obrigatório, e o resto passa pela mesma validação da rota acima.
 */
logisticsRouter.post('/shipments', authMiddleware, requirePermission('logistics.label.create'), async (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const orderId = String(req.body?.orderId ?? '').trim();
    if (!orderId) {
      throw new ApiError(
        'LOGISTICS_ORDER_REQUIRED',
        'Envio é de um pedido: informe orderId (e o destinatário confirmado). Ver POST /logistics/orders/:orderId/label.',
        400,
      );
    }
    const resultado = await comprarEtiqueta({
      companyId: req.auth!.companyId,
      orderId,
      userId: req.auth!.sub,
      idempotencyKey,
      destinatario: req.body?.destinatario,
      servico: req.body?.servico ?? null,
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

/** Retomar a compra que parou (saldo que faltou, geração que falhou). */
logisticsRouter.post('/shipments/:id/continue', authMiddleware, requirePermission('logistics.label.create'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(await continuarEtiqueta(req.auth!.companyId, String(req.params.id), req.auth!.sub));
  } catch (err) {
    next(err);
  }
});

/** O link de impressão da etiqueta, pedido na hora (o do provedor expira). */
logisticsRouter.get('/shipments/:id/label', authMiddleware, requirePermission('logistics.label.view'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(await linkParaImprimir(req.auth!.companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/** "Atualizar rastreio": consulta o provedor e grava o resultado — inclusive a falha. */
logisticsRouter.post('/shipments/:id/sync', authMiddleware, requirePermission('logistics.tracking.sync'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(await sincronizarEnvio(req.auth!.companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

logisticsRouter.post('/shipments/:id/cancel', authMiddleware, requirePermission('logistics.shipment.cancel'), async (req: AuthedRequest, res, next) => {
  try {
    res.json(
      await cancelarEnvio({
        companyId: req.auth!.companyId,
        shipmentId: String(req.params.id),
        userId: req.auth!.sub,
        motivo: req.body?.motivo,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Como a operação envia: declaração de conteúdo (decisão do contador, padrão
 * desligado) e agência Jadlog.
 */
logisticsRouter.get('/settings/shipping', authMiddleware, requirePermission('logistics.config.view'), (req: AuthedRequest, res, next) => {
  try {
    res.json(lerConfiguracaoDeEnvio(req.auth!.companyId));
  } catch (err) {
    next(err);
  }
});

logisticsRouter.put('/settings/shipping', authMiddleware, requirePermission('logistics.config.manage'), (req: AuthedRequest, res, next) => {
  try {
    res.json(salvarConfiguracaoDeEnvio(req.auth!.companyId, req.body ?? {}, req.auth!.sub));
  } catch (err) {
    next(err);
  }
});

logisticsRouter.post('/quotes', authMiddleware, requirePermission('logistics.quote.request'), async (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const companyId = req.auth!.companyId;
    // A mesma chave com outro pedido é recusada ANTES de cotar.
    conferirRequisicaoRepetida(idempotencyKey, companyId, requisicaoDe(req));
    const quoteResult = await backendLogisticsQuote(companyId, req.body ?? {});

    // Faltando peso ou dimensão, NÃO se grava cotação: uma cotação sem opções
    // guardada no histórico parece uma consulta feita, e não foi.
    if ('code' in quoteResult && quoteResult.code === 'SHIPPING_DATA_REQUIRED') {
      res.status(201).json({
        options: [],
        code: quoteResult.code,
        missing: quoteResult.missing,
        message: quoteResult.message,
      });
      return;
    }

    const payload = withIdempotency(idempotencyKey, companyId, () =>
      createLogisticsQuote({
        ...req.body,
        companyId,
        options: quoteResult.options,
        simulated: quoteResult.simulated,
        real: quoteResult.real,
        idempotencyKey,
      }),
      requisicaoDe(req),
    );
    res.status(201).json({ ...payload, message: quoteResult.message });
  } catch (err) {
    next(err);
  }
});

logisticsRouter.get('/quotes/:quoteId', authMiddleware, requirePermission('logistics.quote.request'), (req: AuthedRequest, res) => {
  // A empresa vem da SESSÃO: cotação alheia responde o mesmo 404 de um id
  // inexistente — sem oráculo de existência entre tenants.
  const quote = getLogisticsQuoteById(req.auth!.companyId, String(req.params.quoteId));
  if (!quote) {
    res.status(404).json({ error: { code: 'LOGISTICS_QUOTE_NOT_FOUND', message: 'Cotação não encontrada.' } });
    return;
  }
  res.json(quote);
});

logisticsRouter.get('/carriers', authMiddleware, requirePermission('logistics.config.view'), (req: AuthedRequest, res) => {
  res.json({ items: listLogisticsCarrierConfigs(req.auth!.companyId) });
});

/**
 * A credencial da transportadora — a porta que a tela Logística usa (GAP-PRD-117).
 *
 * Existia só para quem tivesse curl e um JWT na mão. A tela agora chama esta
 * rota, e ela ganhou o que faltava para ser porta de gente: validação com
 * motivo (transportadora, ambiente, token, e-mail), auditoria do ato — com o
 * ambiente, nunca com o token — e a resposta dizendo, pelos códigos de
 * `access.locks`, o que ainda impede a cotação de valer no checkout.
 *
 * Token de PRODUÇÃO é aceito mesmo com `LOGISTICS_PRODUCTION_ENABLED`
 * desligada: o dono entrega o insumo quando o tem, e a trava aparece na
 * resposta e na prontidão pelo nome.
 */
logisticsRouter.post('/carriers/credentials', authMiddleware, requirePermission('logistics.config.manage'), (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const companyId = req.auth!.companyId;
    const entrada = lerEntradaDeCredencial(req.body);
    const storeId = req.body?.storeId ? String(req.body.storeId) : undefined;
    const payload = withIdempotency(idempotencyKey, companyId, () => {
      const salvo = sanitizeLogisticsCredentialForResponse(upsertLogisticsCredentials({
        companyId,
        storeId,
        carrier: entrada.carrier,
        environment: entrada.environment,
        enabled: req.body?.enabled ?? true,
        simulationMode: req.body?.simulationMode ?? true,
        contactEmail: entrada.contactEmail,
        credentials: {
          token: entrada.token,
          apiKey: entrada.token,
          contract: req.body?.contract,
          postingCard: req.body?.postingCard,
          username: req.body?.username,
          password: req.body?.password,
          cnpj: req.body?.cnpj,
          accountId: req.body?.accountId,
        },
      }) as Record<string, unknown>);
      recordAudit({
        companyId,
        userId: req.auth!.sub,
        action: 'logistics.credential_saved',
        entityType: 'logistics_carrier',
        entityId: entrada.carrier,
        // Só a transportadora e o ambiente. O token não entra em auditoria,
        // nem mascarado.
        detail: { carrier: entrada.carrier, environment: entrada.environment },
      });
      return { ...salvo, access: resolveCarrierAccess(companyId, entrada.carrier, storeId) };
    }, requisicaoDe(req));
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

/** Tirar a credencial: a transportadora sai do checkout na hora (token vazado, contrato encerrado). */
logisticsRouter.delete('/carriers/:carrier/credentials', authMiddleware, requirePermission('logistics.config.manage'), (req: AuthedRequest, res, next) => {
  try {
    const carrier = String(req.params.carrier);
    if (!isLogisticsCarrierId(carrier)) {
      throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
    }
    const companyId = req.auth!.companyId;
    const removed = removeLogisticsCredentials(companyId, carrier);
    if (removed > 0) {
      recordAudit({
        companyId,
        userId: req.auth!.sub,
        action: 'logistics.credential_removed',
        entityType: 'logistics_carrier',
        entityId: carrier,
        detail: { carrier },
      });
    }
    res.json({ removed, access: resolveCarrierAccess(companyId, carrier) });
  } catch (err) {
    next(err);
  }
});

logisticsRouter.post('/carriers/:carrier/test-connection', authMiddleware, requirePermission('logistics.config.manage'), async (req: AuthedRequest, res, next) => {
  try {
    const carrier = String(req.params.carrier);
    if (!isLogisticsCarrierId(carrier)) {
      throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
    }
    const result = await testLogisticsCarrierConnection(req.auth!.companyId, carrier, req.body?.storeId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

logisticsRouter.post('/carriers/:carrier/test-quote', authMiddleware, requirePermission('logistics.quote.request'), async (req: AuthedRequest, res, next) => {
  try {
    const carrier = String(req.params.carrier);
    if (!isLogisticsCarrierId(carrier)) {
      throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
    }
    res.json(await backendLogisticsQuote(req.auth!.companyId, { ...req.body, carrier }));
  } catch (err) {
    next(err);
  }
});

logisticsRouter.post('/carriers/:carrier/test-tracking', authMiddleware, requirePermission('logistics.tracking.view'), async (req: AuthedRequest, res, next) => {
  try {
    const carrier = String(req.params.carrier);
    if (!isLogisticsCarrierId(carrier)) {
      throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
    }
    res.json(
      await trackLogisticsCarrier(
        req.auth!.companyId,
        carrier,
        String(req.body?.trackingCode ?? 'TEST-001'),
        req.body?.storeId,
      ),
    );
  } catch (err) {
    next(err);
  }
});

logisticsRouter.get('/homologation', authMiddleware, requirePermission('logistics.homologation.run'), (req: AuthedRequest, res) => {
  res.json(getLogisticsHomologationBackend(req.auth!.companyId));
});

logisticsRouter.post('/homologation/run', authMiddleware, requirePermission('logistics.homologation.run'), async (req: AuthedRequest, res, next) => {
  try {
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    // Nome desconhecido não vira linha de homologação: gravava `carrier:
    // 'qualquer-coisa'` com "Credenciais ausentes." e sujava a última rodada
    // que a tela mostra.
    const carrier = String(req.body?.carrier ?? 'melhor_envio');
    if (!isLogisticsCarrierId(carrier)) {
      throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
    }
    // A mesma chave com outro pedido é recusada ANTES de a rodada rodar.
    conferirRequisicaoRepetida(idempotencyKey, req.auth!.companyId, requisicaoDe(req));
    const runResult = await runLogisticsHomologationBackend(req.auth!.companyId, carrier, req.body?.storeId);
    const payload = withIdempotency(idempotencyKey, req.auth!.companyId, () =>
      upsertLogisticsHomologationBackend({
        companyId: req.auth!.companyId,
        carrier,
        storeId: req.body?.storeId,
        status: runResult.status,
        stepsCompleted: runResult.stepsCompleted,
        homologated: runResult.homologated,
        message: runResult.message,
        productionEnabled: false,
        startedAt: new Date().toISOString(),
        // Concluída é a execução que HOMOLOGOU — não a que rodou com uma
        // variável de teste ligada.
        completedAt: runResult.homologated ? new Date().toISOString() : undefined,
        idempotencyKey,
      }) as Record<string, unknown>,
      requisicaoDe(req),
    );
    res.status(202).json({ ...payload, ...runResult });
  } catch (err) {
    next(err);
  }
});
