export function getOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'DEVORA Public API',
      version: '1.0.0',
      description: 'API pública enterprise DEVORA ERP — Checkpoint 67',
    },
    servers: [{ url: '/api/v1' }],
    paths: {
      '/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/readiness': { get: { summary: 'Readiness', responses: { '200': { description: 'Ready' } } } },
      '/version': { get: { summary: 'Version', responses: { '200': { description: 'Version info' } } } },
      '/auth/login': {
        post: {
          summary: 'Login / session bridge',
          description:
            'Issues access+refresh tokens. Rate-limited (30/min per IP or userId). ' +
            // O texto anterior descrevia um "session bridge" sem senha e uma
            // verificação "partial/stub". Nada disso existe: a rota exige senha
            // sempre, verifica com Argon2id, bloqueia por tentativa e confere o
            // vínculo com a empresa. Documentação que promete porta lateral é
            // convite para alguém procurá-la.
            'Password is always required and verified with Argon2id (legacy hashes are rehashed on success). ' +
            'Lockout after repeated failures; timing equalised for unknown logins. ' +
            'Rejects companyId grupo-sampaio|grupo. Access token TTL 3600s; refresh rotates and expires in 7d.',
          responses: {
            '200': { description: 'Tokens { accessToken, refreshToken, expiresIn }' },
            '400': { description: 'Invalid payload / blocked companyId' },
            '401': { description: 'API_AUTH_BRIDGE_REQUIRED' },
            '429': { description: 'API_LOGIN_RATE_LIMIT' },
          },
        },
      },
      // As quatro rotas `/oms` saíram na rodada 36 junto com o roteador. Este
      // arquivo é CONTRATO PÚBLICO: anunciar caminho que responde 404 é pior
      // que não anunciar nada, porque a integração de terceiro escreve o
      // cliente contra o que está aqui.
      '/logistics/shipments': {
        get: { summary: 'List logistics shipments', security: [{ bearerAuth: [] }] },
        post: {
          summary: 'Create logistics shipment',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        },
      },
      '/logistics/quotes': {
        post: {
          summary: 'Request logistics quote',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        },
      },
      '/logistics/quotes/{quoteId}': { get: { summary: 'Get logistics quote', security: [{ bearerAuth: [] }] } },
      '/logistics/carriers': { get: { summary: 'List carrier configs (no secrets)', security: [{ bearerAuth: [] }] } },
      '/logistics/carriers/credentials': {
        post: {
          summary: 'Upsert carrier credentials (backend only)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        },
      },
      // As rotas `/fiscal`, `/fiscal/nfe` e quase todas de `/fiscal/nfce` saíram
      // (GAP-PRD-096): camada JSON legada, sem tela, que atravessava empresa
      // pelo id e respondia valores cravados. O fiscal real é `/core/fiscal/*`,
      // e o CSC, a última porta que sobrava fora do núcleo, foi para lá na
      // junção do GAP-PRD-075: nenhum caminho `/fiscal` fica no contrato.
      '/core/fiscal/nfce/csc': {
        get: { summary: 'CSC da NFC-e por ambiente (sem o token)', security: [{ bearerAuth: [] }] },
        post: {
          summary: 'Grava o CSC de um ambiente (o token nunca volta)',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        },
      },
      // As dez rotas `/workshop` e as onze `/rentals` saíram na rodada 36, pela
      // mesma razão das `/oms` acima. Cuidado ao ler: a oficina e a locação que
      // a empresa opera continuam de pé em `/core/workshop*` e `/core/rentals*`
      // — o que morreu foi o par de fora do núcleo, sobre tabelas vazias.
      /*
        AS DEZESSETE ROTAS `/crm/*` SAÍRAM DAQUI (GAP-PRD-075), com o roteador:
        eram um segundo CRM sobre `crm_*`, paralelo a `core_leads` — lead e
        oportunidade criados por elas nunca apareciam na tela. O CRM que existe
        é `/core/leads` e `/core/opportunities`.

        E AS DEZOITO `/bi/*` TAMBÉM — as dezessete de GAP-V36/V45 e, agora, a
        sonda que sobrava, de um módulo sem número nenhum. Um contrato publicado
        que anuncia rota morta é a mesma mentira num arquivo que o integrador lê
        ANTES de bater na API. O processo vivo responde em `/health`; o que
        aquelas rotas prometiam existe de verdade em `/core/insights/*`,
        `/core/dashboard` e na Central de Relatórios (`/core/reports`),
        documentados abaixo.
      */
      '/core/reports': {
        get: { summary: 'Catálogo de relatórios da Central', security: [{ bearerAuth: [] }] },
      },
      '/core/reports/{id}': {
        get: {
          summary: 'Um relatório — dados, ou CSV com formato=csv',
          security: [{ bearerAuth: [] }],
        },
      },
      '/core/insights/brands': {
        get: { summary: 'Vendas por marca nas operações do vínculo', security: [{ bearerAuth: [] }] },
      },
      // As quinze rotas `/automations/*` saíram com o roteador (GAP-PRD-075):
      // o menu diz "em breve" para Automações, e agora o servidor concorda.
      '/payment-terminals/health': { get: { summary: 'Payment terminal health', responses: { '200': { description: 'OK' } } } },
      '/payment-terminals/readiness': { get: { summary: 'Payment terminal readiness', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/providers': { get: { summary: 'List payment providers', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/providers/{provider}/capabilities': { get: { summary: 'Provider capabilities', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/configurations': {
        get: { summary: 'List terminal configurations', security: [{ bearerAuth: [] }] },
        post: { summary: 'Create terminal configuration', security: [{ bearerAuth: [] }] },
      },
      '/payment-terminals/terminals': { get: { summary: 'List terminals', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/terminals/{id}/status': { get: { summary: 'Terminal status', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/terminals/{id}/test': { post: { summary: 'Test terminal', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/transactions': {
        get: { summary: 'List terminal transactions', security: [{ bearerAuth: [] }] },
        post: { summary: 'Create terminal transaction', security: [{ bearerAuth: [] }] },
      },
      '/payment-terminals/transactions/{id}': { get: { summary: 'Get transaction', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/transactions/{id}/status': { get: { summary: 'Query transaction status', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/transactions/{id}/cancel': { post: { summary: 'Cancel transaction', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/transactions/{id}/refund': { post: { summary: 'Refund transaction', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/homologation': { get: { summary: 'Homologation status', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/local-agents': { get: { summary: 'Local agents', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/dashboard': { get: { summary: 'Payment terminal dashboard', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/recovery': { get: { summary: 'Recovery queue', security: [{ bearerAuth: [] }] } },
      '/payment-terminals/dead-letter': { get: { summary: 'Dead letter', security: [{ bearerAuth: [] }] } },
      '/system/health': { get: { summary: 'System admin health', responses: { '200': { description: 'OK' } } } },
      '/system/readiness': { get: { summary: 'Production readiness', security: [{ bearerAuth: [] }] } },
      '/system/release': { get: { summary: 'Release metadata', security: [{ bearerAuth: [] }] } },
      '/system/implantacao': { get: { summary: 'Conferência da implantação da instalação', security: [{ bearerAuth: [] }] } },
      '/system/implantacao/empresas': { get: { summary: 'Situação da implantação de cada empresa com vínculo de gestão', security: [{ bearerAuth: [] }] } },
      '/system/implantacao/empresas/{companyId}': { get: { summary: 'Checklist de implantação de uma empresa', security: [{ bearerAuth: [] }] } },
      '/system/implantacao/empresas/{companyId}/itens/{item}/marca': {
        put: { summary: 'Confirmar item ou marcá-lo como não se aplica (com motivo)', security: [{ bearerAuth: [] }] },
        delete: { summary: 'Tirar a marca do item', security: [{ bearerAuth: [] }] },
      },
      // `/system/audit` saiu (verificação do GAP-PRD-075): a trilha é `/core/audit`.
      /*
        AS ROTAS LEGADAS DO ASAAS (GAP-PRD-093). `/asaas/charges` era anunciada
        aqui e criava cobrança numa fila paralela que nunca virava título nem
        baixa; saiu (410), e o contrato passa a anunciar a cobrança do núcleo.
      */
      '/asaas/status': {
        get: {
          summary: 'Asaas credential status of the CALLER company (read from the vault)',
          security: [{ bearerAuth: [] }],
        },
      },
      '/asaas/test-connection': { post: { summary: 'Test Asaas connection', security: [{ bearerAuth: [] }] } },
      '/core/finance/entries/{id}/charge': {
        post: {
          summary: 'Charge ONE receivable (PIX, boleto or card link) through Asaas',
          description:
            'Cria a cobrança do título no Asaas da operação (cliente vinculado, referência externa = id do título). '
            + 'Idempotente por título e meio; o webhook do Asaas baixa o título quando o dinheiro entra.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '201': { description: 'Charge created (or recovered): intent, status, PIX/boleto data' } },
        },
      },
      '/core/payment-intents': {
        get: {
          summary: 'Charges of the caller company (status, provider reference, last error)',
          security: [{ bearerAuth: [] }],
        },
      },
      /*
        O webhook do Asaas (GAP-PRD-002). Este documento anunciava só
        `/webhooks/asaas`, e aquela rota gravava o evento sem baixar nada. A URL
        a cadastrar é a POR OPERAÇÃO; a antiga passou a ter o mesmo
        processamento, com a operação reconhecida pelo token.
      */
      '/loja/webhooks/payments/{provider}/{companyId}': {
        post: {
          summary: 'Payment provider webhook for ONE company (URL to register in the Asaas panel)',
          description:
            'Autenticado pelo cabeçalho asaas-access-token, conferido contra o token DESTA operação no cofre. '
            + 'Baixa o título do contas a receber ou marca o pedido online como pago; idempotente por id do evento; '
            + 'evento fora de ordem não desfaz estado. A URL exata de cada operação aparece em Integrações › Asaas.',
          parameters: [
            { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['asaas'] } },
            { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'asaas-access-token', in: 'header', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{ accepted, duplicated, detail }' },
            '401': { description: 'Token não confere' },
            '403': { description: 'Cobrança de outra operação' },
            '503': { description: 'Operação sem token de webhook configurado' },
          },
        },
      },
      '/webhooks/asaas': {
        post: {
          summary: 'Asaas webhook receiver (legacy URL, same processing)',
          description:
            'Endereço antigo, mantido para quem já o cadastrou no painel do Asaas: passa pelo mesmo processamento '
            + 'da rota por operação, com a operação identificada pelo token. Resposta: { ok, accepted, duplicated, duplicate, detail }.',
          parameters: [{ name: 'asaas-access-token', in: 'header', required: true, schema: { type: 'string' } }],
        },
      },
      /*
        As dez rotas `/promotions/*` e a vitrine `/storefronts/public/{slug}`
        saíram daqui na rodada 36, junto com os roteadores. Anunciar num
        contrato público uma rota que responde 404 é pior que não anunciar:
        quem integra escreve o cliente contra o papel, não contra o servidor.
        Quem promove preço é `/core/promotions`; a loja é `/loja`.
      */
      /*
        As nove rotas `/organizations/*` saíram daqui junto com o roteador.
        Elas anunciavam ao mundo — este documento é o contrato público da API —
        um "Create company" que gravava num `Map` em memória e sumia no
        reinício. Spec que descreve rota inexistente é a mesma promessa vazia
        um nível acima: quem integra escreve o cliente contra ela.

        A criação de empresa que EXISTE vive em `/core/companies`.
      */
      '/core/companies': {
        get: { summary: 'List the companies of the CALLER MEMBERSHIPS (management profiles only; scoped per user since round 48)', security: [{ bearerAuth: [] }] },
        post: {
          summary: 'Create company with its first manager (requires management membership in ALL active companies)',
          security: [{ bearerAuth: [] }],
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  };
}
