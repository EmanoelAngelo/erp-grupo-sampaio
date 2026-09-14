/**
 * O TOKEN QUE O GESTOR SALVA É O QUE O WEBHOOK CONFERE — rodada 61.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO CONTRA O ASAAS DE VERDADE
 * ============================================================================
 *
 * O dono cadastrou o webhook no Asaas, colou o token na nossa tela e salvou.
 * O Asaas bateu no endereço e levou **503**: "Webhook sem token configurado:
 * nada a conferir, nada é aceito."
 *
 * O token estava salvo. O servidor é que olhava no lugar errado:
 *
 *   - a TELA grava com `upsertAsaasWebhookToken` → cofre, por empresa;
 *   - o HANDLER lia `secretProvider.getAsaasWebhookToken()` → só o `.env`.
 *
 * Duas fontes para a mesma pergunta, e a cicatriz é conhecida nesta base (as
 * três definições de "abaixo do mínimo" da rodada 55, o cStat 108 da 58). O
 * gestor não tem como descobrir: a tela diz "Configurada", o Asaas diz 503, e
 * as duas afirmações são verdadeiras sobre lugares diferentes.
 *
 * ============================================================================
 * POR QUE O HANDLER NÃO SABIA A EMPRESA
 * ============================================================================
 *
 * O webhook é rota PÚBLICA — quem chama é o provedor, não um usuário logado.
 * Sem token de sessão, não há `companyId`, e foi por isso que o código caiu na
 * leitura global do ambiente.
 *
 * A saída não é adivinhar a empresa: é procurar o token entre os que estão
 * cadastrados. Conhecer o token PROVA de quem é o evento — é exatamente para
 * isso que ele existe —, e o handler passa a saber a empresa que antes lhe
 * faltava.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
// O .env NÃO tem token: é justamente o cenário do dono, que salvou pela tela.
delete process.env.ASAAS_WEBHOOK_AUTH_TOKEN;

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { upsertAsaasWebhookToken } = await import(
  '../src/services/integrations/AsaasCredentialService.js'
);

const app = createApp();
const TOKEN_DA_TELA = 'whsec_x_TokenQueOGestorColou123';

let precoJusto: string;
let gringa: string;
let n = 0;

function bater(token?: string, evento = 'PAYMENT_CONFIRMED') {
  n += 1;
  const req = request(app)
    .post('/api/v1/webhooks/asaas')
    .send({ event: evento, id: `evt-${n}`, payment: { id: `pay-${n}`, value: 10 } });
  return token ? req.set('asaas-access-token', token) : req;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'PRECO JUSTO COMERCIO DE VARIEDADES LTDA',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
});

// ============================================================================

describe('o token salvo na tela vale no webhook', () => {
  it('com o token do cofre, o Asaas é aceito — mesmo sem nada no .env', async () => {
    upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_DA_TELA });

    const res = await bater(TOKEN_DA_TELA);

    /*
      Este é o caso do dono, exatamente: token salvo pela tela, `.env` vazio.
      Antes voltava 503 e o pedido ficava "aguardando pagamento" para sempre,
      com o dinheiro já na conta dele.
    */
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('sem token nenhum cadastrado, continua recusando — nada a conferir', async () => {
    const res = await bater(TOKEN_DA_TELA);

    // Aceitar sem ter o que conferir seria abrir um endereço público que
    // grava evento de pagamento a pedido de qualquer um.
    expect(res.status).toBe(503);
  });

  it('token errado é recusado com 401, não com 503', async () => {
    upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_DA_TELA });

    const res = await bater('whsec_x_NaoEhEsseAqui999');

    /*
      A diferença importa para quem configura: 503 diz "não há token
      cadastrado" e manda salvar; 401 diz "o token não confere" e manda
      comparar com o do Asaas. Trocar um pelo outro faz o gestor salvar de
      novo o mesmo valor errado.
    */
    expect(res.status).toBe(401);
  });

  it('a chamada sem cabeçalho nenhum é recusada', async () => {
    upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_DA_TELA });

    const res = await bater(undefined);

    expect(res.status).toBe(401);
  });
});

// ============================================================================

describe('cada empresa tem o seu token', () => {
  it('o token da Gringa vale, e é o da Gringa que é reconhecido', async () => {
    upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_DA_TELA });
    upsertAsaasWebhookToken({ companyId: gringa, webhookToken: 'whsec_x_TokenDaGringa456' });

    /*
      Seis empresas, seis contas no Asaas, seis webhooks — cada uma com o
      próprio token. O handler precisa aceitar QUALQUER um dos cadastrados, e
      saber de quem é o evento que chegou: é o token que responde isso.
    */
    const daGringa = await bater('whsec_x_TokenDaGringa456');
    expect(daGringa.status).toBe(200);

    const daPrecoJusto = await bater(TOKEN_DA_TELA);
    expect(daPrecoJusto.status).toBe(200);

    const deNinguem = await bater('whsec_x_TokenDeNinguem000');
    expect(deNinguem.status).toBe(401);
  });
});

// ============================================================================

describe('o .env continua valendo para quem já o usava', () => {
  it('token do ambiente é aceito quando não há nada no cofre', async () => {
    /*
      Pelo PROVEDOR, e não mexendo em `process.env`: o `loadEnv()` guarda o
      ambiente em cache na primeira leitura, então trocar a variável depois de
      o módulo carregar não muda nada — o teste ficaria vermelho por um
      motivo que não é o dele.
    */
    const { secretProvider } = await import('../src/secrets/SecretProvider.js');
    const espiao = vi
      .spyOn(secretProvider, 'getAsaasWebhookToken')
      .mockReturnValue('token-do-env-legado');
    try {
      const res = await bater('token-do-env-legado');
      /*
        O caminho antigo não é derrubado: quem configurou por variável de
        ambiente — em servidor, por script — continua funcionando. O cofre
        ACRESCENTA uma fonte; não substitui a que já existia.
      */
      expect(res.status).toBe(200);
    } finally {
      espiao.mockRestore();
    }
  });
});
