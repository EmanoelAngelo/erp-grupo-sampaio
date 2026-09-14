import { Router } from 'express';
import { ApiError } from '../../utils/errors.js';
import { loadEnv } from '../../config/env.js';
import { authMiddleware, requirePermission, rotaPublica, type AuthedRequest } from '../../middleware/auth.js';
import { authRouter } from './auth.js';
import { coreRouter } from './core.js';
import { storefrontRouter } from './storefront.js';
import { AsaasHttpClient } from '../../services/asaas/AsaasHttpClient.js';
import {
  listOperationalAttempts,
  processOperationalAttempt,
} from '../../services/asaas/AsaasOperationalService.js';
import { getAsaasCredentialStatus } from '../../services/integrations/AsaasCredentialService.js';
import { recordAudit } from '../../services/audit/AuditService.js';
import { handlePaymentWebhook } from '../../services/core/PaymentService.js';
import { getOpenApiSpec } from '../../openapi/spec.js';
import { logisticsRouter } from './logistics.js';
import { paymentTerminalsRouter } from './payment-terminals.js';
import { getReleaseVersionInfo } from '../../services/system-admin/SystemAdminService.js';
import { getConnection } from '../../db/sqlite.js';
import { systemAdminRouter } from './system-admin.js';
import { acessoRouter } from './acesso.js';

export const v1Router = Router();

v1Router.get('/health', rotaPublica('sonda de saúde: monitor e deploy batem aqui antes de existir sessão'), (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/*
  A SONDA DE PRONTIDÃO — e a diferença dela para a de saúde.

    /health     o processo está VIVO: respondeu.
    /readiness  o processo está APTO: o que ele precisa para servir
                responde.

  Ela respondia `ready: true` e `database: true` CRAVADOS, sem consultar
  nada. Uma sonda que sempre diz sim é pior que nenhuma: o orquestrador
  manda a fila da loja inteira para um processo cujo banco não abre, e cada
  requisição responde erro.

  ## O que ela NÃO pode contar

  É rota pública, sem sessão — é assim que o orquestrador a alcança antes
  de existir login. O estado do cofre não entra aqui: "a senha do
  certificado está ausente" e "a chave de cifra é a padrão" são exatamente
  o que alguém de fora gostaria de saber antes de tentar. Esse diagnóstico
  mora atrás de autenticação, em /core/system/secrets-readiness.

  ## Bloqueio parcial não é indisponibilidade

  Faltar CSC bloqueia a NFC-e e não bloqueia o ERP: o balcão vende, a
  oficina abre OS, a loja recebe pedido. Responder "não apto" por causa do
  CSC tiraria tudo do ar por um dado que ainda espera o portal da SEFAZ.
*/
v1Router.get('/readiness', rotaPublica('sonda de prontidão: o deploy pergunta antes de mandar tráfego, sem sessão'), (_req, res) => {
  let database: boolean;
  try {
    // A pergunta mais barata que ainda prova que o banco abre e responde.
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_companies').get();
    database = true;
  } catch {
    database = false;
  }

  const corpo = {
    ready: database,
    database,
    checkedAt: new Date().toISOString(),
  };
  res.status(database ? 200 : 503).json(corpo);
});

v1Router.get('/version', rotaPublica('versão publicada: a tela de login mostra a release antes de autenticar'), (_req, res) => {
  res.json({ ...getReleaseVersionInfo(), api: 'devora-public-v1' });
});

/*
  ========= AQUI MORAVAM /storefronts E /promotions (rodada 36) =========

  `/storefronts` (PLURAL) eram 22 rotas de uma loja fantasma; quem atende de
  verdade é `/loja` (`storefront.ts`, SINGULAR), montada abaixo. `/promotions`
  eram 12 rotas de um segundo motor de promoções que nunca precificou nada —
  quem desconta no PDV e na vitrine é `core_promotions`, via `/core/promotions`.
  Os dois saíram inteiros: zero chamadores no frontend, zero linhas no banco.
  `services/ecommerce/` ficou viva pelo painel de `/integrations` e pela
  prontidão de staging — e saiu com os dois (GAP-PRD-075, abaixo).
*/
v1Router.use('/logistics', logisticsRouter);
/*
  ============ /fiscal E /fiscal/nfe LEGADOS — APAGADOS (GAP-PRD-096) ============

  Eram a camada de documentos JSON de uma emissão que nunca existiu: nenhuma
  tela os chamava e `nfe_documents` não alimenta o pipeline real. E não eram
  inofensivos: `POST /fiscal/nfe/documents/:id/number|validate|xml|sign`
  alteravam o documento pelo ID SOZINHO — o admin de uma empresa numerava a
  nota da vizinha e recebia o documento alheio de volta, com uma chave
  "3526<timestamp>" que nem tem 44 dígitos —, e `/fiscal/health`,
  `/fiscal/reconciliation` e o "hash" do XML respondiam valores cravados.

  O fiscal de verdade mora todo no núcleo (`/core/fiscal/*`). De `/fiscal/nfce`
  ficou por um tempo só o CSC, que a tela de configuração fiscal usa — e na
  junção do GAP-PRD-075 ele foi para o núcleo (`/core/fiscal/nfce/csc`), com
  o mesmo dado e o mesmo alcance. Nenhum prefixo `/fiscal` fica montado.
*/
v1Router.use('/payment-terminals', paymentTerminalsRouter);
v1Router.use('/system', systemAdminRouter);

/*
  ======== /crm, /automations E /bi — DESMONTADOS (GAP-PRD-075) ========

  `/crm` eram 17 rotas sobre `crm_*`, e o próprio arquivo admitia viver "em
  outro espaço de identidade", coexistindo com `core_leads` "por prazo
  determinado". O prazo acabou: eram duas verdades sobre o mesmo lead — o
  gestor criava lead e oportunidade por aqui, e eles nunca apareciam na tela,
  que lê `core_leads` (`/core/leads`, `/core/opportunities`).
  `/automations` eram 15 rotas sobre `automation_*`, com o menu dizendo "em
  breve" e as rotas respondendo. `/bi` só tinha a sonda de um módulo que já
  não tinha número nenhum (os painéis saíram na rodada dos relatórios); o
  processo vivo responde em `/health`, e o BI de verdade é `/core/insights/*`.
  Nenhuma tela chamava os três. Saíram os roteadores, os serviços e as rotas
  do contrato publicado.

  ============ /integrations — DESMONTADO (GAP-PRD-075, junção) ============

  Oito rotas de uma "Central de Integrações" que nenhuma tela chamava
  (varredura de `src/lib/api` e das páginas): a tela Integrações lê
  `/core/integrations/status` e a do Asaas, `/core/integrations/asaas*`. Era
  uma SEGUNDA PORTA para cada credencial — o A1 (`/core/fiscal/certificate`),
  o CSC (`/core/fiscal/nfce/csc`), a chave do Asaas
  (`/core/integrations/asaas/credentials`), o token do Melhor Envio
  (`/logistics/carriers/credentials`) e a credencial da maquininha
  (`/payment-terminals/credentials`) — e o painel dela respondia a prontidão
  da NF-e e da NFC-e lendo `fiscal_issuer_profiles` e
  `fiscal_product_profiles`, que ninguém escreve: "emitente não configurado"
  para a empresa cujo emitente o núcleo tem. Saiu com o serviço, os quatro
  estados por provedor que só ele gravava e o módulo `services/ecommerce/`,
  que só ele e a prontidão de staging liam.

  Os prefixos que ficaram acima TÊM tela em cima: `/payment-terminals`
  (PAG), `/logistics` (LOG) e `/system` (Configurações). A lista fechada do
  que pode estar montado é cobrada em `o-legado-sem-consumidor-sai-do-ar.test.ts`.
*/


/*
  ========= OMS, OFICINA E LOCAÇÃO LEGADOS — APAGADOS NA RODADA 36 ===========

  Montavam-se aqui `/oms`, `/workshop` e `/rentals`: 25 rotas sobre a camada de
  documentos JSON (`findRows`/`insertRow` em `oms_*`, `workshop_*`, `rental_*`).
  As 57 tabelas deles estavam com ZERO linha no banco operacional e nenhuma
  tela do sistema jamais os chamou. O que a empresa usa são os HOMÔNIMOS do
  núcleo, relacionais e com dado dentro: `POST /core/orders/:id/fulfillment`,
  as vinte rotas `/core/workshop*` e as cinco de locação em `core.ts`.
  Dois módulos com o mesmo nome, um deles vazio, é a pior documentação que
  existe — quem procurasse "a oficina" achava primeiro a que não guarda nada.
*/

/*
  ================= O ROTEADOR /organizations FOI APAGADO ====================

  Ele existia com nove rotas — cinco GETs e quatro POSTs — e `POST
  /organizations/companies` respondia 201 com uma empresa que NUNCA TOCAVA
  `core_companies`: o serviço guardava tudo num `Map` em memória do processo.
  Criar empresa por ali devolvia sucesso, sumia no reinício, e nenhum login
  jamais alcançaria o tenant inventado.

  Foi apagado INTEIRO, e não pela metade, por três medições:

   1. NENHUM CONSUMIDOR. Nem tela, nem teste, nem script: os cinco GETs
      importavam do mesmo serviço-fantasma e listariam sempre o `Map` vazio.
      Preservar um GET "porque é leitura" deixaria de pé o serviço todo.

   2. O GUARDA MENTIA. `requirePermission('system-release.manage')` é
      `{ler:[],escrever:[]}` na matriz — quer dizer que `admin_geral` E
      `gestor` chegavam nela. As irmãs liam `body.companyId` e o `assertScope`
      era curto-circuitado por um `isGroupAdmin` que incluía `gestor`: é o
      vazamento de tenant da rodada 14, vivo em outro arquivo.

   3. A REGRA DE LINT NÃO ALCANÇAVA. `rota-declara-alcance` roda só sobre
      `coreRouter`. Foi FORA da cobertura que a rota fantasma nasceu, e é por
      isso que a substituta (`POST /core/companies`) nasceu DENTRO dela.

  Arquivo que responde 201 para dado que não existe é pior que arquivo ausente:
  promessa que o sistema não cumpre custa mais caro que a funcionalidade que
  falta, porque a falta pelo menos se vê.
*/

v1Router.get('/openapi.json', rotaPublica('contrato público da API: ferramenta de integração lê sem sessão'), (_req, res) => {
  res.json(getOpenApiSpec());
});

// Autenticação real (senha Argon2id, escopo derivado do vínculo no banco)
// vive em ./auth.ts. O endpoint anterior aceitava userId/companyId do corpo
// da requisição sem verificar senha e foi removido por ser um bypass total.
v1Router.use('/auth', authRouter);

// Núcleo transacional: produtos, estoque, clientes, caixa, vendas, financeiro.
v1Router.use('/core', coreRouter);

// O acesso dos usuários por empresa, PDV e página (tela de Usuários).
v1Router.use('/acesso', acessoRouter);

// Loja publica do Grupo Sampaio (sem autenticacao).
v1Router.use('/loja', storefrontRouter);

/*
  ================= AS ROTAS LEGADAS /asaas/* (GAP-PRD-093) =================

  Este bloco anunciava no OpenAPI um Asaas paralelo ao do núcleo:

    - `GET /asaas/charges/:id` respondia `{status:'queued'}` para QUALQUER id;
    - `POST /asaas/charges` e `/asaas/customers/sync` enfileiravam numa coleção
      de documentos (`asaas_operational_attempts` → `asaas_charge_links`) que
      nunca vira título, nunca vira baixa e que a conciliação não enxerga;
    - `POST /asaas/charges/:id/cancel` enfileirava um tipo de operação que o
      processador nem conhece — e a tentativa terminava "completed";
    - `POST /asaas/homologation/start` respondia `in_progress, steps: []` sem
      rodar nada, e `/asaas/production/activate` respondia `activated:false`;
    - `GET /asaas/status` lia só o `.env` e dizia "não configurado" com a
      chave da operação no cofre.

  Nenhuma tela as chamava; um integrador que seguisse o contrato criaria
  cobrança numa fila que ninguém lê e consultaria um status inventado.

  O que FINGIA responde 410 e diz qual rota faz o serviço de verdade — 410 e
  não 404 porque quem integrou pelo contrato antigo precisa saber que a rota
  existiu, saiu, e para onde ir. O que é VERDADE ficou: o status (agora do
  cofre), o teste de conexão (o cliente HTTP já lia o cofre) e a fila da
  homologação sandbox, cercada pela empresa (GAP-PRD-155).
*/
function saiuDoContrato(substituta: string, motivo: string): ApiError {
  return new ApiError(
    'API_ROUTE_GONE',
    `Esta rota saiu do contrato: ${motivo} Use ${substituta}.`,
    410,
    { substituta },
  );
}

v1Router.get('/asaas/status', authMiddleware, requirePermission('asaas.connection.view'), (req: AuthedRequest, res) => {
  const env = loadEnv();
  const companyId = req.auth!.companyId;
  // O COFRE DA OPERAÇÃO, e não o .env. É a mesma leitura da tela de
  // Integrações — duas respostas diferentes para a mesma pergunta era o
  // defeito (GAP-PRD-093).
  const status = getAsaasCredentialStatus(companyId, { storeId: req.auth!.storeId });
  res.json({
    companyId,
    enabled: env.asaasEnabled,
    environment: env.ASAAS_ENVIRONMENT,
    productionEnabled: env.asaasProductionEnabled,
    sandbox: status.sandbox,
    production: status.production,
    webhookConfigured: status.webhook.configured,
    webhookPublicUrl: env.ASAAS_WEBHOOK_PUBLIC_URL || null,
  });
});

v1Router.post('/asaas/test-connection', authMiddleware, requirePermission('asaas.connection.test'), async (req: AuthedRequest, res, next) => {
  try {
    const environment = (req.body?.environment ?? 'sandbox') as 'sandbox' | 'production';
    const client = new AsaasHttpClient({
      environment,
      correlationId: req.correlationId,
      companyId: req.auth!.companyId,
      storeId: req.body?.storeId ?? req.auth!.storeId,
      operationalUnitId: req.body?.operationalUnitId,
    });
    const result = await client.testConnection();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.customer.sync`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.post('/asaas/customers/sync', authMiddleware, requirePermission('asaas.customer.sync'), (_req: AuthedRequest, _res, next) => {
  next(
    saiuDoContrato(
      'POST /api/v1/core/finance/entries/:id/charge',
      'o cliente é cadastrado no Asaas junto com a primeira cobrança dele, pelo vínculo do núcleo.',
    ),
  );
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.charge.create`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.post('/asaas/charges', authMiddleware, requirePermission('asaas.charge.create'), (_req: AuthedRequest, _res, next) => {
  next(
    saiuDoContrato(
      'POST /api/v1/core/finance/entries/:id/charge',
      'a cobrança nascia numa fila paralela que nunca virava título nem baixa.',
    ),
  );
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.charge.view`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.get('/asaas/charges/:chargeLinkId', authMiddleware, requirePermission('asaas.charge.view'), (_req: AuthedRequest, _res, next) => {
  next(
    saiuDoContrato(
      'GET /api/v1/core/payment-intents (ou GET /api/v1/core/finance/entries/:id/charges)',
      'ela dizia que toda cobrança estava na fila, para qualquer id, sem consultar nada.',
    ),
  );
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.charge.cancel`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.post('/asaas/charges/:chargeLinkId/cancel', authMiddleware, requirePermission('asaas.charge.cancel'), (_req: AuthedRequest, _res, next) => {
  next(
    saiuDoContrato(
      'POST /api/v1/core/finance/entries/:id/charges/cancel',
      'o cancelamento era enfileirado e nunca chegava ao provedor.',
    ),
  );
});

v1Router.get('/asaas/queue', authMiddleware, requirePermission('asaas.queue.view'), (req: AuthedRequest, res) => {
  const items = listOperationalAttempts(req.auth!.companyId);
  res.json({ items });
});

/*
  O RETRY É DA EMPRESA DO TOKEN (GAP-PRD-155).

  Chamava `processOperationalAttempt(id)` sem empresa: o gestor de B, com o id
  de uma tentativa de A, processava a de A com o cofre de A — e recebia 200
  `{status:'not_found'}`, porque a lista de B não a mostrava. Agora a empresa
  entra no serviço, id alheio é 404 sem nada tocado, e as duas coisas — o
  retry e a recusa — ficam na auditoria com quem pediu.
*/
v1Router.post('/asaas/queue/:attemptId/retry', authMiddleware, requirePermission('asaas.queue.retry'), async (req: AuthedRequest, res, next) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.sub ?? null;
    const attemptId = String(req.params.attemptId);
    const antes = listOperationalAttempts(companyId).find((row) => row.id === attemptId);
    if (!antes) {
      recordAudit({
        companyId,
        userId,
        action: 'asaas.queue.retry_denied',
        entityType: 'asaas_operational_attempt',
        entityId: attemptId,
        detail: { motivo: 'tentativa inexistente nesta empresa' },
        ip: req.ip ?? null,
      });
      throw new ApiError('ASAAS_ATTEMPT_NOT_FOUND', 'Tentativa não encontrada nesta operação.', 404);
    }
    const depois = await processOperationalAttempt(attemptId, companyId);
    recordAudit({
      companyId,
      userId,
      action: 'asaas.queue.retry',
      entityType: 'asaas_operational_attempt',
      entityId: attemptId,
      detail: {
        operacao: antes.operationType,
        antes: antes.status,
        depois: depois?.status ?? null,
        erro: depois?.sanitizedError ?? null,
      },
      ip: req.ip ?? null,
    });
    res.json(depois);
  } catch (err) {
    next(err);
  }
});

/*
  `POST /sync/outbox` e `GET /sync/cursor` SAÍRAM (GAP-PRD-072). O primeiro
  respondia `{ accepted: N, status: 'queued' }` sem gravar uma linha — nem em
  `core_outbox`, nem em lugar nenhum —, e o segundo, `cursor: null` cravado.
  A fila da central de verdade nasce na mesma transação do fato
  (`OutboxService.enqueue`) e se vê e se opera por `/core/sync/*` (tela
  Sincronização).
*/

/*
  A URL QUE O PAINEL DO ASAAS DA LOJA JÁ TEM CADASTRADA (GAP-PRD-002).

  Até aqui esta rota gravava o evento numa coleção legada, respondia 200 e
  parava: o dinheiro entrava, nada era baixado, e o Asaas — tendo recebido
  2xx — não reenviava nunca. No banco da loja, dois PAYMENT_OVERDUE reais
  chegaram por aqui; o livro do núcleo (`core_payment_webhooks`) tinha zero.

  Agora ela entra no MESMO processamento da rota por operação: a empresa sai
  do token, a conferência de tenant é a mesma, a idempotência é a mesma. Quem
  já cadastrou este endereço não precisa trocar nada. `duplicate` e `ok`
  continuam na resposta para quem lia o formato antigo.
*/
v1Router.post('/webhooks/asaas', rotaPublica('webhook do Asaas: quem chama é o provedor, autenticado pelo asaas-access-token dentro do handler'), (req, res, next) => {
  try {
    const result = handlePaymentWebhook({
      provider: 'asaas',
      token: req.headers['asaas-access-token'] as string | undefined,
      payload: req.body ?? {},
    });
    res.status(200).json({ ok: true, ...result, duplicate: result.duplicated });
  } catch (err) {
    next(err);
  }
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.homologation.run`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.post('/asaas/homologation/start', authMiddleware, requirePermission('asaas.homologation.run'), (_req: AuthedRequest, _res, next) => {
  next(
    saiuDoContrato(
      'POST /api/v1/core/integrations/asaas/homologar',
      'ela respondia "in_progress" com zero passos, sem rodar homologação nenhuma.',
    ),
  );
});

// Nenhuma tela chama; a guarda é a mesma de antes (`asaas.production.activate`), para que
// sair do contrato não abra a rota a quem nunca a alcançou.
v1Router.post('/asaas/production/activate', authMiddleware, requirePermission('asaas.production.activate'), (_req: AuthedRequest, _res, next) => {
  next(
    /*
      A substituta apontava `POST /integrations/asaas/activate`, que saiu com o
      roteador `/integrations` (GAP-PRD-075). A tela do Asaas pede produção por
      `PATCH /core/integrations/asaas` (`environment: 'production'`), com a
      tranca de produção e a auditoria do núcleo.
    */
    saiuDoContrato(
      'PATCH /api/v1/core/integrations/asaas (environment: "production")',
      'ela respondia "activated: false" sem ativar nem registrar nada.',
    ),
  );
});
