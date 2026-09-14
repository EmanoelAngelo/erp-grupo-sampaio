/**
 * ============================================================================
 * A CONFIGURAÇÃO DO DIA 1, LOJA POR LOJA (GAP-PRD-034)
 * ============================================================================
 *
 * A auditoria leu o banco da loja e achou tudo por configurar — entrega,
 * medidas, CEP de origem, Asaas, SMTP, transportadora —, com uma tela pronta
 * para cada item e nenhum lugar que dissesse, por operação, o que falta. Este
 * arquivo cobra a lista: cada item diz o estado lido do que está GRAVADO, quem
 * resolve (a loja pela tela, ou o servidor pelo `.env`) e onde; e o item vira
 * verde quando o dono configura — sem ninguém do desenvolvimento no meio.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { saveShippingSettings } from '../src/services/core/CheckoutShippingService.js';
import { upsertAsaasApiKey } from '../src/services/integrations/AsaasCredentialService.js';
import { upsertLogisticsCredentials } from '../src/services/logistics/LogisticsCredentialService.js';
import { prontidaoDaOperacao, type ItemDoDiaUm } from '../src/services/logistics/ProntidaoDoDiaUm.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const SENHA = 'Teste@DiaUm2026';
const EMAIL_VARS = ['EMAIL_ENABLED', 'EMAIL_FROM', 'EMAIL_SMTP_HOST', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASSWORD'];

let gringa: string;
let meMimei: string;
let n = 0;

async function sessao(login: string, perfil: string, empresas: string[]) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const e of empresas) linkUserToCompany(userId, e, perfil, e === empresas[0]);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function produto(empresa: string, comMedidas: boolean, nome = `Produto ${n + 1}`) {
  n += 1;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents,
          weight_grams, height_cm, width_cm, length_cm, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 1000, 5000, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      `d1-prod-${n}`,
      empresa,
      `D1-${n}`,
      nome,
      comMedidas ? 500 : null,
      comMedidas ? 10 : null,
      comMedidas ? 20 : null,
      comMedidas ? 30 : null,
      agora,
      agora,
    );
}

function item(itens: ItemDoDiaUm[], chave: string): ItemDoDiaUm {
  const achado = itens.find((i) => i.chave === chave);
  expect(achado, `item ${chave}`).toBeDefined();
  return achado as ItemDoDiaUm;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  for (const v of EMAIL_VARS) delete process.env[v];
  delete process.env.LOGISTICS_PRODUCTION_ENABLED;
  resetEnvCacheForTests();
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  meMimei = upsertCompany({ slug: 'me-mimei', legalName: 'Me Mimei Ltda', tradeName: 'Me Mimei' });
});

afterEach(() => {
  for (const v of EMAIL_VARS) delete process.env[v];
  delete process.env.LOGISTICS_PRODUCTION_ENABLED;
  resetEnvCacheForTests();
});

describe('operação recém-criada: a lista diz tudo o que falta, e quem resolve', () => {
  it('nada configurado — o retrato do banco da loja', () => {
    const p = prontidaoDaOperacao(gringa);
    expect(p.companyName).toBe('Gringa');
    expect(p.pronta).toBe(false);

    // Só retirada é o padrão SEGURO: é escolha, não falta.
    expect(item(p.itens, 'entrega')).toMatchObject({ estado: 'escolha', quem: 'loja', onde: '/sistema/loja/entrega' });
    expect(item(p.itens, 'entrega').detalhe).toMatch(/só RETIRADA/);
    expect(item(p.itens, 'produtos_publicados')).toMatchObject({ estado: 'pendente' });
    expect(item(p.itens, 'cep_origem')).toMatchObject({ estado: 'pendente', onde: '/sistema/fiscal/configuracao' });
    expect(item(p.itens, 'remetente').detalhe).toMatch(/CNPJ/);
    // Sem transportadora a loja ainda entrega pela tabela: escolha.
    expect(item(p.itens, 'transportadora')).toMatchObject({ estado: 'escolha', onde: '/sistema/loja/logistica' });
    expect(item(p.itens, 'asaas')).toMatchObject({ estado: 'pendente', onde: '/sistema/integracoes/asaas' });
    expect(item(p.itens, 'asaas').detalhe).toMatch(/Pagamento online indisponível/);
    // O SMTP é do SERVIDOR, e o item diz quais variáveis faltam.
    expect(item(p.itens, 'email')).toMatchObject({ estado: 'pendente', quem: 'servidor' });
    expect(item(p.itens, 'email').detalhe).toMatch(/EMAIL_SMTP_HOST/);

    expect(p.pendentes).toBe(p.itens.filter((i) => i.estado === 'pendente').length);
  });

  it('produto publicado sem medida aparece pelo NOME', () => {
    produto(gringa, true, 'Jaqueta');
    produto(gringa, false, 'Camiseta sem medida');
    const medidas = item(prontidaoDaOperacao(gringa).itens, 'medidas');
    expect(medidas.estado).toBe('pendente');
    expect(medidas.detalhe).toMatch(/1 de 2/);
    expect(medidas.detalhe).toMatch(/Camiseta sem medida/);
  });

  it('pedido que nasceu sem cobrança online é contado no item do Asaas', () => {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_payment_intents
           (id, company_id, provider, origin_type, origin_id, method, amount_cents, status, idempotency_key, created_at, updated_at)
         VALUES ('pi-1', ?, 'asaas', 'ecommerce_order', 'o-1', 'pix', 1000, 'unconfigured', 'k-1', ?, ?)`,
      )
      .run(gringa, agora, agora);
    expect(item(prontidaoDaOperacao(gringa).itens, 'asaas').detalhe).toMatch(/1 pedido\(s\) já nasceram sem cobrança online/);
  });
});

describe('o dono configura pelas telas, e o item vira verde — sem código', () => {
  it('entrega, produtos, CEP, remetente, e-mail: tudo ok', () => {
    saveShippingSettings({ companyId: gringa, pickupEnabled: true, deliveryEnabled: true, flatRateCents: 2_500, freeAboveCents: 30_000 });
    produto(gringa, true);
    updateFiscalConfig({
      companyId: gringa,
      patch: {
        legalName: 'Gringa Comércio Ltda',
        cnpj: '11.222.333/0001-81',
        zip: '68900-000',
        street: 'Rua Cândido Mendes',
        number: '100',
        district: 'Centro',
        cityName: 'Macapá',
        uf: 'AP',
        phone: '(96) 3222-0000',
      },
    });
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_FROM = 'loja@example.com';
    process.env.EMAIL_SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_SMTP_USER = 'loja@example.com';
    process.env.EMAIL_SMTP_PASSWORD = 'senha-de-teste';
    resetEnvCacheForTests();

    const p = prontidaoDaOperacao(gringa);
    expect(item(p.itens, 'entrega')).toMatchObject({ estado: 'ok' });
    expect(item(p.itens, 'entrega').detalhe).toMatch(/R\$ 25,00.*grátis acima de R\$ 300,00/);
    for (const chave of ['produtos_publicados', 'medidas', 'cep_origem', 'remetente', 'email']) {
      expect(item(p.itens, chave).estado, chave).toBe('ok');
    }
  });

  it('Asaas de sandbox é pendência que diz "sandbox"; transportadora travada no servidor diz quem resolve', () => {
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_sandbox_de_teste_000000000000' });
    upsertLogisticsCredentials({
      companyId: gringa,
      carrier: 'melhor_envio',
      environment: 'production',
      credentials: { token: 'me-prod-token-de-teste-dia1' },
    });
    const p = prontidaoDaOperacao(gringa);
    expect(item(p.itens, 'asaas')).toMatchObject({ estado: 'pendente' });
    expect(item(p.itens, 'asaas').detalhe).toMatch(/SANDBOX/);
    expect(item(p.itens, 'transportadora')).toMatchObject({ estado: 'pendente', quem: 'servidor', onde: null });
    expect(item(p.itens, 'transportadora').detalhe).toMatch(/LOGISTICS_PRODUCTION_ENABLED/);

    process.env.LOGISTICS_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    expect(item(prontidaoDaOperacao(gringa).itens, 'transportadora').estado).toBe('ok');
  });
});

describe('a rota: por operação para o gerente, o grupo inteiro para quem responde por ele', () => {
  it('o gerente vê só a operação dele', async () => {
    const gerente = await sessao('GERENTE_D1', 'gerente_loja', [gringa]);
    const res = await request(app).get('/api/v1/core/loja/prontidao-do-dia-1').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.operacoes.map((o: { companyName: string }) => o.companyName)).toEqual(['Gringa']);
  });

  it('o gestor do grupo vê as operações todas de uma vez', async () => {
    const gestor = await sessao('GESTOR_D1', 'gestor', [gringa, meMimei]);
    const res = await request(app).get('/api/v1/core/loja/prontidao-do-dia-1').set(gestor);
    expect(res.status).toBe(200);
    expect(res.body.operacoes.map((o: { companyName: string }) => o.companyName).sort()).toEqual(['Gringa', 'Me Mimei']);
  });

  it('estoquista e atendente não abrem — o mesmo alcance das telas que resolvem os itens', async () => {
    for (const perfil of ['estoquista', 'atendente']) {
      const quem = await sessao(`D1_${perfil.toUpperCase()}`, perfil, [gringa]);
      expect((await request(app).get('/api/v1/core/loja/prontidao-do-dia-1').set(quem)).status, perfil).toBe(403);
    }
  });
});
