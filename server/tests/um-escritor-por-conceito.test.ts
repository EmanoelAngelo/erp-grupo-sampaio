/**
 * ============================================================================
 * UM ESCRITOR POR CONCEITO (GAP-PRD-075) — o inventário, cobrado
 * ============================================================================
 *
 * A ficha: roteadores legados paralelos ao núcleo sobre a camada de documentos,
 * e coleções com dado que eram uma segunda verdade (lead, documento fiscal,
 * envio, maquininha, cobrança Asaas, integração, certificado, sessão/log da
 * API). Depois da junção, cada coleção que continua viva é a ÚNICA verdade do
 * seu conceito, e este arquivo diz — e cobra — quem a escreve, quem a lê, por
 * qual porta a tela a alcança, e por que ela fica.
 *
 * Como cada caso cai:
 *   - coleção nova em `TABLE_NAMES` sem linha aqui: o primeiro caso cai (toda
 *     coleção precisa de uma decisão escrita);
 *   - um SEGUNDO escritor para uma coleção (outro serviço passa a gravar nela):
 *     o caso dos escritores cai — o conjunto é exato;
 *   - o leitor some (a rota que lia sai, e a coleção vira escrita sem leitor):
 *     o caso dos leitores cai;
 *   - a tela deixa de chamar a porta: o caso da porta cai;
 *   - uma coleção de segredo sem a guarda da empresa: o caso do tenant cai;
 *   - a tela volta a chamar um prefixo legado, ou o OpenAPI volta a anunciá-lo:
 *     os dois últimos blocos caem.
 *
 * A varredura lê o código SEM os comentários. A trava anterior casava o nome
 * da coleção em qualquer lugar do fonte — e `logistics_shipments` passou anos
 * "em uso" só porque dois comentários a citavam.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { COLECOES_POR_EMPRESA, TABLE_NAMES, ensureSchema, insertRow, resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { TABELAS_APOSENTADAS } from '../src/db/tabelasAposentadas.js';
import { getOpenApiSpec } from '../src/openapi/spec.js';
import { registrarTentativa } from '../src/services/payment-terminal/PaymentTerminalTransactionEffects.js';
import { loginForTest } from './helpers/auth.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '../src');
const TELA = resolve(AQUI, '../../src');

// ---------------------------------------------------------------------------
// O inventário: coleção viva → conceito, escritores, leitores, porta da tela
// ---------------------------------------------------------------------------

interface Linha {
  conceito: string;
  /** Arquivos de `server/src` (fora de `db/`) que gravam nela — o conjunto EXATO. */
  escritores: string[];
  /** Arquivos que a leem — os que têm de existir (a varredura pode achar mais). */
  leitores: string[];
  /** O caminho que a tela chama e que chega nela; `null` quando a porta não é de tela. */
  porta: string | null;
  /** Guarda credencial ou segredo: escrita sob a guarda da empresa. */
  segredo?: boolean;
  /** Por que é a única verdade do conceito, e não uma segunda. */
  porQueFica: string;
}

const INVENTARIO: Record<string, Linha> = {
  api_sessions: {
    conceito: 'sessão da equipe (refresh token)',
    escritores: ['services/api/ApiAuthService.ts', 'services/api/SessoesDeApi.ts'],
    leitores: ['services/api/SessoesDeApi.ts'],
    porta: '/auth/refresh',
    porQueFica: 'Sessão da EQUIPE; a do cliente da loja é outro conceito (core_customer_sessions). Um módulo só grava e revoga.',
  },
  api_idempotency_keys: {
    conceito: 'chave de idempotência das rotas de escrita',
    escritores: ['services/api/ApiIdempotencyService.ts'],
    leitores: ['services/api/ApiIdempotencyService.ts'],
    porta: null,
    porQueFica: 'Lida pela própria rota a cada reenvio (CSC, credencial de transportadora e de maquininha); não há gêmeo no núcleo.',
  },
  api_request_logs: {
    conceito: 'rastro técnico das recusas da API (ApiError)',
    escritores: ['services/api/ApiIdempotencyService.ts'],
    leitores: [],
    porta: null,
    porQueFica:
      'Registro técnico, não verdade de negócio: método, caminho, status e requestId de cada recusa, podado em 30 dias '
      + '(PoliticaDeRetencao o declara na tela de LGPD). Não tem leitor de tela por desenho — é o rastro que o suporte '
      + 'consulta na cópia do banco; o 500 vai para o log do processo. Não há outro lugar que guarde o mesmo fato.',
  },
  asaas_operational_attempts: {
    conceito: 'fila da homologação sandbox do Asaas',
    escritores: ['services/asaas/AsaasOperationalService.ts'],
    leitores: ['services/asaas/AsaasOperationalService.ts'],
    porta: null,
    porQueFica:
      'Só o passo de idempotência da homologação a enfileira e só GET /asaas/queue a lista (FIN, GAP-PRD-093/155). '
      + 'Cobrança de verdade é core_payment_intents; os vínculos que o processador gravava ao lado agora ficam na tentativa.',
  },
  logistics_carrier_credentials: {
    conceito: 'credencial da transportadora',
    escritores: ['services/logistics/LogisticsCredentialService.ts'],
    leitores: ['services/logistics/LogisticsCredentialService.ts'],
    porta: '/logistics/carriers/credentials',
    segredo: true,
    porQueFica: 'Cofre da transportadora, por empresa; a tela Loja › Logística grava por aqui (LOG, GAP-PRD-117).',
  },
  logistics_quotes: {
    conceito: 'cotação de frete avulsa pela API',
    escritores: ['services/logistics/LogisticsService.ts'],
    leitores: ['services/logistics/LogisticsService.ts'],
    porta: null,
    porQueFica: 'POST /logistics/quotes grava e GET /logistics/quotes/:id relê, cercada pela empresa; o envio do pedido é core_shipments.',
  },
  logistics_homologation_executions: {
    conceito: 'execução da homologação da transportadora',
    escritores: ['services/logistics/LogisticsService.ts'],
    leitores: ['services/logistics/LogisticsService.ts'],
    porta: null,
    porQueFica: 'Uma corrida por pedido de /logistics/homologation/run, relida por GET /logistics/homologation.',
  },
  fiscal_certificate_references: {
    conceito: 'certificado A1',
    escritores: ['services/core/CertificateStatusService.ts', 'services/fiscal/FiscalCertificateService.ts'],
    leitores: ['services/fiscal/FiscalCertificateService.ts'],
    porta: '/core/fiscal/certificate',
    segredo: true,
    porQueFica:
      'O A1 que a emissão do núcleo abre (getCertificateA1); gravado pelo upload e pela revogação do núcleo. '
      + 'A segunda porta (/integrations/nfe/secrets) e o leitor paralelo (FiscalService) saíram.',
  },
  nfce_settings: {
    conceito: 'CSC da NFC-e por ambiente',
    escritores: ['services/nfce/NfceCscService.ts'],
    leitores: ['services/nfce/NfceCscService.ts'],
    porta: '/core/fiscal/nfce/csc',
    segredo: true,
    porQueFica: 'O CSC que a NFC-e do núcleo lê (acharCscDaOperacao); a porta agora é do núcleo e a antiga respondeu 404.',
  },
  payment_terminal_configurations: {
    conceito: 'maquininha cadastrada',
    escritores: [
      'services/payment-terminal/PaymentTerminalCredentialService.ts',
      'services/payment-terminal/PaymentTerminalService.ts',
    ],
    leitores: ['services/payment-terminal/PaymentTerminalService.ts'],
    porta: '/payment-terminals/configurations',
    segredo: true,
    porQueFica: 'Cadastro e credencial da maquininha (PAG, GAP-PRD-076); não há outro cadastro de maquininha.',
  },
  payment_terminal_transactions: {
    conceito: 'cobrança na maquininha',
    escritores: [
      'services/payment-terminal/PaymentTerminalService.ts',
      'services/payment-terminal/PaymentTerminalTransactionEffects.ts',
    ],
    leitores: ['services/core/CobrancasSemVenda.ts', 'services/core/PendenciasDoTurno.ts'],
    porta: '/payment-terminals/transactions',
    porQueFica:
      'A cobrança é gravada por um módulo só (o caminho síncrono e o do agente chamam os mesmos efeitos); o núcleo a lê '
      + 'na conferência do turno e das cobranças sem venda. core_payment_terminal_charge_keys é a trava da chave, não uma cópia.',
  },
  payment_terminal_homologations: {
    conceito: 'homologação da maquininha',
    escritores: ['services/payment-terminal/PaymentTerminalService.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalService.ts'],
    porta: null,
    porQueFica: 'Gravada e relida pelo mesmo serviço (/payment-terminals/homologation).',
  },
  payment_terminal_local_agents: {
    conceito: 'agente local pareado ao caixa',
    escritores: ['services/payment-terminal/PaymentTerminalLocalAgentService.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalLocalAgentService.ts'],
    porta: '/payment-terminals/local-agents',
    segredo: true,
    porQueFica: 'Pareamento, sinal e revogação do agente (PAG, GAP-PRD-014).',
  },
  payment_terminal_history: {
    conceito: 'trilha de eventos da maquininha',
    escritores: [
      'services/core/CobrancasSemVenda.ts',
      'services/core/EstornoNaMaquininha.ts',
      'services/payment-terminal/PaymentTerminalAgentChannel.ts',
      'services/payment-terminal/PaymentTerminalLocalAgentService.ts',
      'services/payment-terminal/PaymentTerminalService.ts',
      'services/payment-terminal/PaymentTerminalTransactionEffects.ts',
    ],
    leitores: ['services/payment-terminal/PaymentTerminalService.ts'],
    porta: null,
    porQueFica:
      'Trilha só de acréscimo: cada fluxo grava o SEU evento, e nenhum reescreve o de outro. A fila de recuperação '
      + '(/payment-terminals/recovery) a lê. O conjunto de escritores é fechado aqui: um sétimo precisa de decisão.',
  },
  payment_terminal_dead_letter: {
    conceito: 'comando do agente que não teve desfecho',
    escritores: ['services/payment-terminal/PaymentTerminalAgentChannel.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalService.ts'],
    porta: null,
    porQueFica: 'Gravada pelo canal do agente, lida por /payment-terminals/dead-letter.',
  },
  payment_terminal_receipts: {
    conceito: 'comprovante da cobrança',
    escritores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    porta: '/receipt',
    porQueFica: 'Um comprovante por cobrança, gravado pelos efeitos e lido pela segunda via da tela (GAP-PRD-162).',
  },
  payment_terminal_cancellations: {
    conceito: 'pedido de cancelamento à operadora',
    escritores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    porta: '/payment-terminals/transactions',
    porQueFica:
      'Cada pedido — inclusive o que a operadora não confirmou — e nada mais guarda esse fato. Era escrita sem leitor; '
      + 'agora a lista de cobranças da tela mostra o último pedido de cada uma (ultimoPedido).',
  },
  payment_terminal_refunds: {
    conceito: 'pedido de estorno à operadora',
    escritores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    leitores: ['services/payment-terminal/PaymentTerminalTransactionEffects.ts'],
    porta: '/payment-terminals/transactions',
    porQueFica: 'Idem cancelamento: o leitor é o mesmo, e a tela mostra o último pedido.',
  },
  integration_secrets: {
    conceito: 'cofre de chaves de integração (Asaas)',
    escritores: ['services/integrations/IntegrationSecretVaultService.ts'],
    leitores: ['services/integrations/AsaasCredentialService.ts'],
    porta: '/core/integrations/asaas/credentials',
    segredo: true,
    porQueFica: 'A chave do Asaas por operação, que o cliente HTTP do núcleo abre. A segunda porta (/integrations) saiu.',
  },
  integration_configurations: {
    conceito: 'estado da integração Asaas por operação',
    escritores: ['services/integrations/AsaasIntegrationStateService.ts'],
    leitores: ['services/integrations/AsaasIntegrationStateService.ts'],
    porta: '/core/integrations/asaas',
    segredo: true,
    porQueFica:
      'Conexão testada, homologação e ambiente pedido, lidos pela tela do Asaas. Os estados de NF-e, NFC-e, logística, '
      + 'maquininha e e-commerce que só a Central de Integrações gravava saíram com ela.',
  },
};

/**
 * Os conceitos cuja verdade é RELACIONAL: nenhuma coleção viva pode ter o nome
 * do gêmeo que eles tiveram. Se uma volta, o conceito volta a ter dois escritores.
 */
const VERDADE_RELACIONAL: Array<{ conceito: string; tabela: string; gemeosMortos: RegExp }> = [
  { conceito: 'lead', tabela: 'core_leads', gemeosMortos: /^crm_/ },
  {
    conceito: 'documento fiscal',
    tabela: 'core_fiscal_documents',
    gemeosMortos: /^(nfe_|fiscal_(documents|issuer|product)|nfce_(documents|queue|reconciliation|homologation))/,
  },
  { conceito: 'envio', tabela: 'core_shipments', gemeosMortos: /^logistics_(shipments|labels|tracking)/ },
  { conceito: 'cobrança Asaas', tabela: 'core_payment_intents', gemeosMortos: /^asaas_(charge|customer)_links$/ },
  { conceito: 'aviso do Asaas', tabela: 'core_payment_webhooks', gemeosMortos: /^asaas_webhook_events$/ },
  { conceito: 'trilha de auditoria', tabela: 'core_audit_log', gemeosMortos: /^(integration_audit_entries|asaas_sandbox_homologations)$/ },
];

// ---------------------------------------------------------------------------
// A leitura do código, sem comentários
// ---------------------------------------------------------------------------

function arquivos(dir: string, filtro: (p: string) => boolean, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome !== '__tests__' && nome !== 'node_modules') arquivos(p, filtro, saida);
    } else if (filtro(p)) saida.push(p);
  }
  return saida;
}

function semComentario(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const FONTES: Array<[string, string]> = arquivos(SRC, (p) => p.endsWith('.ts'))
  .map((p) => relative(SRC, p).split('\\').join('/'))
  .filter((r) => !r.startsWith('db/'))
  .map((r) => [r, semComentario(readFileSync(resolve(SRC, r), 'utf8'))]);

const q = '[\'"`]';
function quemEscreve(nome: string): string[] {
  const re = new RegExp(
    `(insertRow|updateRows|deleteRows)\\s*(<[^>]*>)?\\(\\s*[^;{]*?${q}${nome}${q}|(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+"?${nome}\\b`,
    'i',
  );
  return FONTES.filter(([, t]) => re.test(t)).map(([f]) => f).sort();
}
function quemLe(nome: string): string[] {
  const re = new RegExp(
    `(findRows|findOneRow|findRowsDaEmpresa|findOneRowDaEmpresa)\\s*(<[^>]*>)?\\(\\s*[^;{]*?${q}${nome}${q}|FROM\\s+"?${nome}\\b`,
    'i',
  );
  return FONTES.filter(([, t]) => re.test(t)).map(([f]) => f).sort();
}

// ---------------------------------------------------------------------------

describe('o inventário cobre o banco e bate com o código', () => {
  it('toda coleção viva tem uma linha aqui, e nenhuma linha fala de coleção morta', () => {
    expect(Object.keys(INVENTARIO).sort()).toEqual([...TABLE_NAMES].sort());
    expect(Object.keys(INVENTARIO).filter((n) => TABELAS_APOSENTADAS.includes(n))).toEqual([]);
  });

  for (const [nome, linha] of Object.entries(INVENTARIO)) {
    it(`${nome} (${linha.conceito}): um conjunto fechado de escritores, e um leitor`, () => {
      expect(quemEscreve(nome), `quem escreve ${nome}`).toEqual([...linha.escritores].sort());
      const leitores = quemLe(nome);
      for (const esperado of linha.leitores) expect(leitores, `quem lê ${nome}`).toContain(esperado);
      if (linha.leitores.length === 0) {
        // Só o rastro técnico fica sem leitor, e com o porquê escrito.
        expect(nome).toBe('api_request_logs');
        expect(linha.porQueFica).toMatch(/sem leitor de tela por desenho|Não tem leitor de tela/i);
      }
    });
  }
});

describe('a tela alcança cada verdade pela porta dela', () => {
  const CLIENTE = arquivos(resolve(TELA, 'lib/api'), (p) => /\.ts$/.test(p) && !/\.test\./.test(p))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');

  for (const [nome, linha] of Object.entries(INVENTARIO)) {
    if (!linha.porta) continue;
    it(`${nome}: a tela chama ${linha.porta}`, () => {
      expect(CLIENTE.includes(linha.porta!), `src/lib/api não chama ${linha.porta}`).toBe(true);
    });
  }
});

describe('cada verdade é da empresa dela', () => {
  beforeEach(() => {
    resetDbForTests();
    ensureSchema();
  });

  it('toda coleção viva tem a coluna da empresa', () => {
    const semColuna = Object.keys(INVENTARIO).filter((nome) => {
      const colunas = getConnection().prepare(`PRAGMA table_xinfo("${nome}")`).all() as { name: string }[];
      return !colunas.some((c) => c.name === 'company_id');
    });
    expect(semColuna).toEqual([]);
  });

  it('as de segredo são exatamente as guardadas, e recusam linha sem empresa', () => {
    const deSegredo = Object.entries(INVENTARIO).filter(([, l]) => l.segredo).map(([n]) => n).sort();
    expect([...COLECOES_POR_EMPRESA].sort()).toEqual(deSegredo);
    for (const nome of deSegredo) {
      expect(() => insertRow(nome as never, { id: `sem-empresa-${nome}` }), nome).toThrow(/empresa/);
    }
  });
});

describe('os conceitos de verdade relacional não têm gêmeo vivo', () => {
  for (const c of VERDADE_RELACIONAL) {
    it(`${c.conceito}: ${c.tabela}, e nenhuma coleção viva no lugar do gêmeo`, () => {
      expect(TABLE_NAMES.filter((n) => c.gemeosMortos.test(n)), c.conceito).toEqual([]);
      ensureSchema();
      const existe = getConnection().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(c.tabela);
      expect(existe, c.tabela).toBeTruthy();
    });
  }
});

describe('a maquininha: o pedido de estorno tem leitor, e é da empresa dele', () => {
  const app = createApp();
  const A = 'empresa-a-pedido';
  const B = 'empresa-b-pedido';

  beforeEach(() => {
    resetDbForTests();
  });

  async function portador(companyId: string, userId: string): Promise<{ Authorization: string }> {
    const res = await loginForTest(app, { userId, companyId, profileCodes: ['admin_geral'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  it('a lista de cobranças traz o último pedido, e a da vizinha não vê o de A', async () => {
    for (const companyId of [A, B]) {
      insertRow('payment_terminal_transactions', {
        id: 'pttx-mesmo-id',
        companyId,
        provider: 'stone',
        status: 'authorized',
        amountInCents: 5_000,
        channel: 'local_agent',
        startedAt: '2026-09-11T10:00:00.000Z',
      });
    }
    const pedido = { companyId: A, transactionId: 'pttx-mesmo-id', provider: 'stone', reason: 'cliente desistiu', requestedBy: 'gerente-a', amountInCents: 5_000 };
    registrarTentativa('refund', { ...pedido, outcome: 'queued_to_agent', commandId: 'ptcmd-1' });
    registrarTentativa('refund', {
      ...pedido,
      outcome: 'no_answer',
      providerMessage: 'O agente não respondeu: confira no extrato da operadora se o pedido foi feito.',
      commandId: 'ptcmd-1',
    });

    const deA = await request(app).get('/api/v1/payment-terminals/transactions').set(await portador(A, 'admin-a'));
    expect(deA.status, JSON.stringify(deA.body)).toBe(200);
    expect(deA.body.items).toHaveLength(1);
    expect(deA.body.items[0].ultimoPedido).toMatchObject({
      operacao: 'refund',
      outcome: 'no_answer',
      reason: 'cliente desistiu',
      amountInCents: 5_000,
    });

    const deB = await request(app).get('/api/v1/payment-terminals/transactions').set(await portador(B, 'admin-b'));
    expect(deB.status).toBe(200);
    expect(deB.body.items).toHaveLength(1);
    expect(deB.body.items[0].ultimoPedido).toBeNull();
  });

  it('a "conciliação" que respondia lista vazia saiu do ar e do contrato', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/reconciliation').set(await portador(A, 'admin-a2'));
    expect(res.status).toBe(404);
    const caminhos = Object.keys((getOpenApiSpec() as { paths: Record<string, unknown> }).paths);
    expect(caminhos).not.toContain('/payment-terminals/reconciliation');
  });
});

// ---------------------------------------------------------------------------
// A tela e o contrato descrevem um sistema só
// ---------------------------------------------------------------------------

const PREFIXOS_LEGADOS = [
  '/fiscal', '/integrations', '/crm', '/automations', '/bi', '/sync', '/asaas',
  '/oms', '/workshop', '/rentals', '/storefronts', '/promotions', '/organizations',
];

describe('nenhuma tela chama rota legada', () => {
  it('toda chamada de src/lib/api e das páginas começa num prefixo vivo', () => {
    const PERMITIDOS = ['/acesso', '/auth', '/core', '/logistics', '/loja', '/payment-terminals', '/system'];
    const chamadas: string[] = [];
    for (const p of arquivos(TELA, (f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))) {
      const t = readFileSync(p, 'utf8');
      for (const m of t.matchAll(/apiRequest\s*(?:<[\s\S]*?>)?\s*\(\s*(['"`])(\/[^'"`?$]*)/g)) chamadas.push(m[2]);
    }
    // A varredura enxergou o mundo: sem isto, um regex quebrado passaria em branco.
    expect(chamadas.length).toBeGreaterThan(300);
    const fora = chamadas.filter((c) => !PERMITIDOS.some((p) => c === p || c.startsWith(`${p}/`)));
    expect(fora).toEqual([]);
    const legadas = chamadas.filter((c) => PREFIXOS_LEGADOS.some((p) => c === p || c.startsWith(`${p}/`)));
    expect(legadas).toEqual([]);
  });
});

describe('o OpenAPI público descreve um sistema só', () => {
  it('nenhum caminho legado, e cada porta de verdade aparece uma vez', () => {
    const caminhos = Object.keys((getOpenApiSpec() as { paths: Record<string, unknown> }).paths);
    /*
      `/asaas/status` e `/asaas/test-connection` ficam no contrato por decisão da
      frente FIN (GAP-PRD-093): leem o MESMO cofre da operação que a tela do Asaas
      lê, não escrevem nada. As que fingiam respondem 410 e saíram do contrato.
    */
    const LEGADOS_NO_CONTRATO = PREFIXOS_LEGADOS.filter((p) => p !== '/asaas');
    expect(caminhos.filter((c) => LEGADOS_NO_CONTRATO.some((p) => c === p || c.startsWith(`${p}/`)))).toEqual([]);
    expect(caminhos.filter((c) => c.startsWith('/asaas/')).sort()).toEqual(['/asaas/status', '/asaas/test-connection']);
    expect(caminhos.filter((c) => c.includes('nfce/csc'))).toEqual(['/core/fiscal/nfce/csc']);
    expect(caminhos.filter((c) => c.includes('reconciliation'))).toEqual([]);
  });
});
