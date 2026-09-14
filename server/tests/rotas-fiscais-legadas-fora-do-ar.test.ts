/**
 * ============================================================================
 * AS ROTAS FISCAIS LEGADAS SAÍRAM DO AR (GAP-PRD-096, GAP-PRD-075)
 * ============================================================================
 *
 * `/api/v1/fiscal`, `/api/v1/fiscal/nfe` e `/api/v1/fiscal/nfce` eram a
 * camada de documentos JSON de uma emissão que nunca existiu: nenhuma tela as
 * chamava, a tabela `nfe_documents` não alimenta o pipeline real, e o que elas
 * respondiam era inventado ou atravessava empresa:
 *
 *   - `POST /fiscal/nfe/documents/:id/number|validate|xml|sign` alteravam o
 *     documento pelo ID SOZINHO (`updateNfeDocumentBackend` filtrava só por
 *     id): o admin da Gringa numerava a nota da Preço Justo e recebia de volta
 *     o documento alheio, com uma chave "3526<timestamp>" que não tem 44
 *     dígitos nem existe na SEFAZ;
 *   - `GET /fiscal/health` dizia `transmission:false` cravado, e
 *     `GET /fiscal/reconciliation` respondia sempre lista vazia;
 *   - `GET /fiscal/nfe/documents/:id/xml` devolvia um "hash" `xml-<id>`.
 *
 * O GAP-PRD-096 apagou as rotas e deixou o CSC (`/fiscal/nfce/csc`), que a
 * tela usa. A junção do GAP-PRD-075 levou o CSC para o núcleo
 * (`/core/fiscal/nfce/csc`) e apagou o que ainda sobrava do segundo escritor de
 * documento fiscal: `NfeService`, `NfceService`, `FiscalService` e as doze
 * coleções deles — hoje em `TABELAS_APOSENTADAS`.
 *
 * O admin_geral é o ator de propósito: ele passa em toda permissão, então um
 * 404 para ele é 404 para todo mundo — um 403 disfarçaria a rota viva.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { TABLE_NAMES, findRows, resetDbForTests } from '../src/db/database.js';
import { TABELAS_APOSENTADAS } from '../src/db/tabelasAposentadas.js';
import { getOpenApiSpec } from '../src/openapi/spec.js';
import { acharCscDaOperacao } from '../src/services/nfce/NfceCscService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const PRECO_JUSTO = 'preco-justo-legado';
const GRINGA = 'gringa-legado';

async function admin(companyId: string, userId: string): Promise<{ Authorization: string }> {
  const res = await loginForTest(app, { userId, companyId, profileCodes: ['admin_geral'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(() => {
  resetDbForTests();
});

describe('o segundo escritor de documento fiscal saiu da árvore', () => {
  it('os serviços legados e o roteador do CSC não existem mais', () => {
    for (const arquivo of [
      'routes/v1/nfce.ts',
      'services/nfe',
      'services/nfce/NfceService.ts',
      'services/nfce/NfceReadinessService.ts',
      'services/nfce/NfceSefazHomologationClient.ts',
      'services/fiscal/FiscalService.ts',
    ]) {
      expect(existsSync(resolve(SRC, arquivo)), `${arquivo} ainda existe`).toBe(false);
    }
  });

  it('as coleções do legado estão aposentadas — e as duas que o núcleo lê continuam vivas', () => {
    const vivas = new Set<string>(TABLE_NAMES);
    for (const colecao of ['nfe_documents', 'nfce_documents', 'fiscal_documents', 'fiscal_issuer_profiles', 'nfce_queue']) {
      expect(vivas.has(colecao), `${colecao} ainda em TABLE_NAMES`).toBe(false);
      expect(TABELAS_APOSENTADAS, colecao).toContain(colecao);
    }
    // O A1 e o CSC: única verdade do conceito, lidas pela emissão do núcleo.
    expect(vivas.has('fiscal_certificate_references')).toBe(true);
    expect(vivas.has('nfce_settings')).toBe(true);
  });
});

describe('nenhuma rota legada responde', () => {
  const LEGADAS: [metodo: 'get' | 'post', caminho: string][] = [
    ['get', '/fiscal/readiness'],
    ['get', '/fiscal/issuers'],
    ['post', '/fiscal/issuers'],
    ['get', '/fiscal/documents'],
    ['post', '/fiscal/documents'],
    ['get', '/fiscal/certificates'],
    ['post', '/fiscal/certificates'],
    ['post', '/fiscal/certificates/validate'],
    ['post', '/fiscal/certificates/test-signature'],
    ['get', '/fiscal/reconciliation'],
    ['get', '/fiscal/nfe/readiness'],
    ['get', '/fiscal/nfe/service-status'],
    ['post', '/fiscal/nfe/service-status'],
    ['get', '/fiscal/nfe/documents'],
    ['post', '/fiscal/nfe/documents'],
    ['get', '/fiscal/nfe/documents/qualquer'],
    ['post', '/fiscal/nfe/documents/qualquer/number'],
    ['post', '/fiscal/nfe/documents/qualquer/sign'],
    ['post', '/fiscal/nfe/documents/qualquer/authorize'],
    ['post', '/fiscal/nfe/documents/qualquer/query-receipt'],
    ['post', '/fiscal/nfe/documents/qualquer/query-status'],
    ['post', '/fiscal/nfe/documents/qualquer/cancel'],
    ['post', '/fiscal/nfe/documents/qualquer/correction-letter'],
    ['get', '/fiscal/nfe/documents/qualquer/xml'],
    ['get', '/fiscal/nfe/documents/qualquer/danfe'],
    ['post', '/fiscal/nfe/number-invalidation'],
    ['get', '/fiscal/nfe/queues'],
    ['post', '/fiscal/nfe/queues/qualquer/retry'],
    ['get', '/fiscal/nfe/homologation'],
    ['post', '/fiscal/nfe/homologation/run'],
    ['get', '/fiscal/nfe/reconciliation'],
    ['get', '/fiscal/nfce/readiness'],
    ['get', '/fiscal/nfce/service-status'],
    ['post', '/fiscal/nfce/service-status'],
    ['get', '/fiscal/nfce/documents'],
    ['post', '/fiscal/nfce/documents'],
    ['get', '/fiscal/nfce/documents/qualquer'],
    ['post', '/fiscal/nfce/documents/qualquer/authorize'],
    ['post', '/fiscal/nfce/documents/qualquer/cancel'],
    ['post', '/fiscal/nfce/documents/qualquer/status'],
    ['get', '/fiscal/nfce/documents/qualquer/qrcode'],
    ['post', '/fiscal/nfce/qrcode/build'],
    ['get', '/fiscal/nfce/documents/qualquer/danfce'],
    ['get', '/fiscal/nfce/homologation'],
    ['post', '/fiscal/nfce/homologation/run'],
    ['get', '/fiscal/nfce/queues'],
    ['post', '/fiscal/nfce/queues/qualquer/retry'],
    ['post', '/fiscal/nfce/offline/sync'],
    ['get', '/fiscal/nfce/recovery'],
    ['get', '/fiscal/nfce/reconciliation'],
    ['post', '/fiscal/nfce/number-invalidation'],
    // A última porta: o CSC foi para o núcleo (GAP-PRD-075).
    ['get', '/fiscal/nfce/csc'],
    ['post', '/fiscal/nfce/csc'],
  ];

  for (const [metodo, caminho] of LEGADAS) {
    it(`${metodo.toUpperCase()} ${caminho} responde 404 com o envelope da casa`, async () => {
      const dono = await admin(PRECO_JUSTO, 'admin-pj');
      const res = await request(app)[metodo](`/api/v1${caminho}`)
        .set(dono)
        .set('Idempotency-Key', `legado-${metodo}-${caminho}`)
        .send({ cscId: '000001', cscToken: 'TOKEN-PELA-PORTA-VELHA' });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error?.code).toBe('API_NOT_FOUND');
    });
  }

  it('o POST na porta velha do CSC não grava nada', async () => {
    const dono = await admin(PRECO_JUSTO, 'admin-pj-velha');
    await request(app)
      .post('/api/v1/fiscal/nfce/csc')
      .set(dono)
      .set('Idempotency-Key', 'csc-porta-velha')
      .send({ cscId: '000001', cscToken: 'TOKEN-PELA-PORTA-VELHA' });
    expect(findRows('nfce_settings', () => true)).toEqual([]);
  });

  /*
    As três sondas públicas respondiam valores CRAVADOS sem consultar nada —
    `transmission:false`, `productionEnabled:false`. A sonda de saúde de verdade
    é `/api/v1/health`, e a prontidão fiscal é `/core/fiscal/readiness`.
  */
  for (const sonda of ['/fiscal/health', '/fiscal/nfe/health', '/fiscal/nfce/health']) {
    it(`a sonda pública ${sonda} saiu (404 sem sessão)`, async () => {
      const res = await request(app).get(`/api/v1${sonda}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('transmission');
    });
  }
});

describe('o CSC mora no núcleo: /core/fiscal/nfce/csc', () => {
  it('GET e POST servem a empresa do token, e gravam onde a NFC-e do núcleo lê', async () => {
    const dono = await admin(PRECO_JUSTO, 'admin-pj-csc');

    const gravado = await request(app)
      .post('/api/v1/core/fiscal/nfce/csc')
      .set(dono)
      .set('Idempotency-Key', 'csc-no-nucleo')
      .send({ cscId: '000001', cscToken: 'TOKEN-DE-TESTE-CSC', environment: 'homologation' });
    expect(gravado.status, JSON.stringify(gravado.body)).toBe(201);
    expect(JSON.stringify(gravado.body)).not.toContain('TOKEN-DE-TESTE-CSC');
    // O leitor da emissão enxerga o que a porta gravou — um escritor, um leitor.
    expect(acharCscDaOperacao(PRECO_JUSTO, 'unit-default', 'homologation')).toEqual({
      cscId: '000001',
      cscToken: 'TOKEN-DE-TESTE-CSC',
    });

    const lista = await request(app).get('/api/v1/core/fiscal/nfce/csc').set(dono);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(JSON.stringify(lista.body)).not.toContain('TOKEN-DE-TESTE-CSC');

    // A outra empresa não enxerga o CSC desta.
    const vizinha = await admin(GRINGA, 'admin-gringa-csc');
    const daVizinha = await request(app).get('/api/v1/core/fiscal/nfce/csc').set(vizinha);
    expect(daVizinha.status).toBe(200);
    expect(daVizinha.body.items).toHaveLength(0);
  });

  it('o mesmo clique duas vezes grava uma vez', async () => {
    const dono = await admin(PRECO_JUSTO, 'admin-pj-duplo');
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/api/v1/core/fiscal/nfce/csc')
        .set(dono)
        .set('Idempotency-Key', 'csc-duplo-clique')
        .send({ cscId: '000001', cscToken: 'TOKEN-DUPLO', environment: 'homologation' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect(findRows('nfce_settings', (r) => r.companyId === PRECO_JUSTO)).toHaveLength(1);
  });

  it('sem a chave de idempotência, recusa e não grava', async () => {
    const dono = await admin(PRECO_JUSTO, 'admin-pj-sem-chave');
    const res = await request(app)
      .post('/api/v1/core/fiscal/nfce/csc')
      .set(dono)
      .send({ cscId: '000001', cscToken: 'TOKEN-SEM-CHAVE', environment: 'homologation' });
    expect(res.status).toBe(400);
    expect(findRows('nfce_settings', () => true)).toEqual([]);
  });
});

describe('o contrato público não anuncia o que não existe', () => {
  it('o OpenAPI não lista rota /fiscal nenhuma — o CSC está no núcleo', () => {
    const caminhos = Object.keys((getOpenApiSpec() as { paths: Record<string, unknown> }).paths);
    expect(caminhos.filter((c) => c.startsWith('/fiscal'))).toEqual([]);
    expect(caminhos).toContain('/core/fiscal/nfce/csc');
  });
});
