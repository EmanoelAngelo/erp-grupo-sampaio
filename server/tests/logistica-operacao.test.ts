/**
 * Logística: o módulo existia e não era alcançável por ninguém.
 *
 * O roteador `/logistics` guarda toda rota com `requirePermission('logistics.
 * view')` — e `requirePermission` compara essa string com os PERFIS do usuário.
 * Não existe perfil chamado "logistics.view". Só `admin_geral` passava, e não há
 * nenhum admin_geral em uso: cotação, transportadoras, envios e homologação
 * respondiam 403 para todo mundo, gestor incluído. Um módulo inteiro escrito,
 * testado e trancado.
 *
 * Estas rotas em `/core` falam o vocabulário do resto do sistema: perfis
 * nomeados, com o mesmo desvio de gestor e admin.
 *
 * E a regra que este arquivo protege é a mesma do frete no checkout: NADA DE
 * DEFAULT SILENCIOSO. Cotar sem peso ou sem dimensão faria o sistema inventar
 * uma caixa; o transportador cobra pela caixa real, e a diferença aparece
 * depois, com a mercadoria já vendida.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const SENHA = 'Teste@Logistica2026';

let companyId: string;
let gestor: { Authorization: string };
let caixa: { Authorization: string };

async function sessao(login: string, perfil: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio Ltda',
    tradeName: 'Gringa',
  });
  gestor = await sessao('GERENTE1', 'gerente_loja');
  caixa = await sessao('CAIXA1', 'operador_caixa_loja');
});

describe('quem entra', () => {
  it('o gerente da loja vê a prontidão', async () => {
    const res = await request(app).get('/api/v1/core/logistics/readiness').set(gestor);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('providers');
  });

  it('o caixa não — frete não é assunto do balcão', async () => {
    const res = await request(app).get('/api/v1/core/logistics/readiness').set(caixa);
    expect(res.status).toBe(403);
  });

  it('sem sessão, nada', async () => {
    const res = await request(app).get('/api/v1/core/logistics/readiness');
    expect(res.status).toBe(401);
  });

  /**
   * A rota de `/logistics` DESTRANCOU, e isso é o conserto — não uma regressão.
   *
   * Este teste dizia o contrário: cobrava 403 para o gerente, com o comentário
   * "exige um perfil chamado logistics.view, que ninguém tem". Estava certo no
   * diagnóstico e o contorno foi construir `/core/logistics/*` em paralelo,
   * porque alargar acesso em dezesseis roteadores à mão seria o remédio errado.
   *
   * O remédio certo veio depois: `requirePermission` comparava a permissão com
   * os CÓDIGOS DE PERFIL e por isso nunca casava. Com o catálogo de permissões
   * no lugar, `logistics.view` responde a quem trabalha com logística nos DOIS
   * roteadores — e as duas rotas chamam a mesma `logisticsReadiness`, escopada
   * pela empresa do token.
   */
  it('a rota legada responde a quem trabalha com logística', async () => {
    const res = await request(app).get('/api/v1/logistics/readiness').set(gestor);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('providers');
  });

  it('e continua fechada para o caixa, igual à rota nova', async () => {
    const res = await request(app).get('/api/v1/logistics/readiness').set(caixa);
    expect(res.status).toBe(403);
  });
});

describe('o CEP de origem sai da configuração fiscal', () => {
  it('sem CEP declarado, o item ORIGEM fica pendente e diz onde resolver', async () => {
    const res = await request(app).get('/api/v1/core/logistics/readiness').set(gestor);

    expect(res.body.originZip).toBeNull();
    // O item ORIGEM é de quem tem integração: Correios e Jadlog mostram só
    // "SEM INTEGRAÇÃO DIRETA" (GAP-PRD-118), e o primeiro da lista era o Correios.
    const origem = res.body.providers.find((p: { carrier: string }) => p.carrier === 'melhor_envio').items.find(
      (i: { key: string }) => i.key === 'origem',
    );
    expect(origem.status).toBe('pending');
    expect(origem.message).toContain('Fiscal');
  });

  it('com CEP declarado, o item fica verde', async () => {
    // ESTE ITEM NÃO OLHAVA PARA NADA: era 'pending' fixo, mandando configurar
    // o que já estava configurado. Item que nunca fica verde ensina a ignorar
    // o checklist inteiro.
    updateFiscalConfig({ companyId, patch: { zip: '68900-000' } });

    const res = await request(app).get('/api/v1/core/logistics/readiness').set(gestor);

    expect(res.body.originZip).toBe('68900000');
    // O item ORIGEM é de quem tem integração: Correios e Jadlog mostram só
    // "SEM INTEGRAÇÃO DIRETA" (GAP-PRD-118), e o primeiro da lista era o Correios.
    const origem = res.body.providers.find((p: { carrier: string }) => p.carrier === 'melhor_envio').items.find(
      (i: { key: string }) => i.key === 'origem',
    );
    expect(origem.status).toBe('ok');
  });
});

describe('cotação não inventa pacote', () => {
  it('recusa sem peso e sem dimensões, e diz exatamente o que falta', async () => {
    updateFiscalConfig({ companyId, patch: { zip: '68900-000' } });

    const res = await request(app)
      .post('/api/v1/core/logistics/quote')
      .set(gestor)
      .send({ destinationZipCode: '30130000' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('SHIPPING_DATA_REQUIRED');
    expect(res.body.options).toEqual([]);
    // Sem a lista, o gestor fica adivinhando qual campo faltou.
    expect(res.body.missing).toEqual(
      expect.arrayContaining(['peso', 'altura', 'largura', 'comprimento']),
    );
  });

  it('sem CEP de origem em lugar nenhum, também recusa', async () => {
    const res = await request(app)
      .post('/api/v1/core/logistics/quote')
      .set(gestor)
      .send({
        destinationZipCode: '30130000',
        weightGrams: 500,
        heightCm: 10,
        widthCm: 15,
        lengthCm: 20,
      });

    expect(res.body.code).toBe('SHIPPING_DATA_REQUIRED');
    expect(res.body.missing).toContain('CEP de origem');
  });

  it('usa o CEP da operação quando ninguém digita origem', async () => {
    updateFiscalConfig({ companyId, patch: { zip: '68900-000' } });

    const res = await request(app)
      .post('/api/v1/core/logistics/quote')
      .set(gestor)
      .send({
        destinationZipCode: '30130000',
        weightGrams: 500,
        heightCm: 10,
        widthCm: 15,
        lengthCm: 20,
      });

    expect(res.body.code).toBeUndefined();
    expect(Array.isArray(res.body.options)).toBe(true);
  });

  it('cotação sem credencial sai MARCADA como simulada', async () => {
    updateFiscalConfig({ companyId, patch: { zip: '68900-000' } });

    const res = await request(app)
      .post('/api/v1/core/logistics/quote')
      .set(gestor)
      .send({
        destinationZipCode: '30130000',
        weightGrams: 500,
        heightCm: 10,
        widthCm: 15,
        lengthCm: 20,
      });

    // Preço simulado lido como preço de transportadora vira prejuízo por
    // pedido. A marca é o que impede alguém de publicar isso na loja.
    expect(res.body.simulated).toBe(true);
    expect(res.body.real).toBe(false);
  });
});

describe('transportadoras', () => {
  it('lista as três, nenhuma configurada, sem fingir conexão', async () => {
    const res = await request(app).get('/api/v1/core/logistics/carriers').set(gestor);

    expect(res.status).toBe(200);
    const nomes = res.body.items.map((i: { carrier: string }) => i.carrier).sort();
    expect(nomes).toEqual(['correios', 'jadlog', 'melhor_envio']);
    for (const item of res.body.items) {
      expect(item.configured).toBe(false);
      expect(item.connection.ok).toBe(false);
    }
  });

  it('produção continua bloqueada — é o estado honesto sem contrato', async () => {
    const res = await request(app).get('/api/v1/core/logistics/carriers').set(gestor);
    expect(res.body.productionBlocked).toBe(true);
  });
});
