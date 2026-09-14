/**
 * O LEGADO NÃO INVENTA ESTADO (GAP-PRD-072).
 *
 * Dez rotas montadas respondiam 200 com um estado que ninguém gravou nem
 * consultou — o harness da auditoria mediu cada uma:
 *
 *   POST /sync/outbox                       {accepted: 2, status: 'queued'} sem gravar nada
 *   GET  /sync/cursor                       {cursor: null} cravado
 *   POST /fiscal/nfce/queues/:id/retry      {status: 'retry_pending'} para id inexistente
 *   POST /fiscal/nfe/queues/:id/retry       idem
 *   POST /fiscal/nfce/offline/sync          {synced: 0, failed: 0} sem olhar fila nenhuma
 *   GET  /fiscal/reconciliation             {items: []} cravado
 *   POST /asaas/homologation/start          202 com id 'hom-<timestamp>' e nenhuma linha
 *   GET  /asaas/charges/:id                 {status: 'queued'} para qualquer id, sem consultar
 *   POST /asaas/production/activate         {status: 'production_ready', activated: false}
 *   GET  /payment-terminals/transactions/:id/receipt   recibo fabricado para qualquer id
 *   POST /payment-terminals/transactions/:id/reprint   {reprinted: true} sem imprimir
 *
 * Nenhuma tela as consome. Um integrador que confiasse no 'queued' ou no
 * 'retry_pending' deixaria de cobrar ou de emitir. O contrato esperado é o
 * da ficha: rota que não faz o que diz responde 404 com o envelope da casa,
 * e o banco não muda.
 *
 * O caso é escrito contra o CONTRATO, não contra a remoção: se a frente
 * dona de uma dessas rotas (fiscal, Asaas, maquininha) a implementar de
 * verdade, o id inexistente continua 404 e o caso continua verde.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: Record<string, string>;

function contar(tabela: string): number {
  const db = getConnection();
  const existe = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', tabela);
  if (!existe) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM "${tabela}"`).get() as { n: number }).n);
}

beforeAll(async () => {
  const login = await loginForTest(app, {
    userId: 'integrador-legado',
    companyId: 'empresa-legado',
    profileCodes: ['admin_geral'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}`, 'Idempotency-Key': 'legado-nao-inventa' };
});

const ROTAS: Array<{ metodo: 'get' | 'post'; caminho: string; corpo?: unknown; mentira: string; status?: 410 }> = [
  { metodo: 'post', caminho: '/sync/outbox', corpo: { items: [{ id: 1 }, { id: 2 }] }, mentira: 'queued' },
  { metodo: 'get', caminho: '/sync/cursor', mentira: 'cursor' },
  { metodo: 'post', caminho: '/fiscal/nfce/queues/nao-existe/retry', mentira: 'retry_pending' },
  { metodo: 'post', caminho: '/fiscal/nfe/queues/nao-existe/retry', mentira: 'retry_pending' },
  { metodo: 'post', caminho: '/fiscal/nfce/offline/sync', mentira: 'synced' },
  { metodo: 'get', caminho: '/fiscal/reconciliation', mentira: 'items' },
  { metodo: 'post', caminho: '/asaas/homologation/start', mentira: 'hom-', status: 410 },
  { metodo: 'get', caminho: '/asaas/charges/qualquer-id', mentira: 'queued', status: 410 },
  { metodo: 'post', caminho: '/asaas/production/activate', mentira: 'production_ready', status: 410 },
  { metodo: 'get', caminho: '/payment-terminals/transactions/nao-existe/receipt', mentira: 'merchant' },
  { metodo: 'post', caminho: '/payment-terminals/transactions/nao-existe/reprint', mentira: 'reprinted' },
];

/*
  As rotas do Asaas que respondiam sucesso sem efeito saíram do contrato com 410 e o
  endereço da substituta (GAP-PRD-155): quem ainda chama fica sabendo para onde ir. As
  demais saíram do ar (404). Nas duas formas, nada finge sucesso e nada é gravado.
*/
describe('rota que não faz o que diz sai do ar (404) ou aponta a substituta (410), com o envelope da casa', () => {
  for (const rota of ROTAS) {
    it(`${rota.metodo.toUpperCase()} ${rota.caminho}`, async () => {
      // `asaas_sandbox_homologations` era contada aqui; foi aposentada na
      // junção do GAP-PRD-075 (a trilha da homologação é `core_audit_log`).
      // A fila da homologação é a coleção viva que uma resposta fingida sujaria.
      const antes = {
        outbox: contar('core_outbox'),
        apiOutbox: contar('api_outbox'),
        filaAsaas: contar('asaas_operational_attempts'),
        trilha: contar('core_audit_log'),
      };
      const chamada = request(app)[rota.metodo](`/api/v1${rota.caminho}`).set(auth);
      const res = rota.corpo === undefined ? await chamada : await chamada.send(rota.corpo as object);

      expect(res.status, JSON.stringify(res.body)).toBe(rota.status ?? 404);
      if (rota.status === 410) expect(res.body.error?.details?.substituta, JSON.stringify(res.body)).toBeTruthy();
      expect(res.body.error?.code, JSON.stringify(res.body)).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toContain(rota.mentira);
      // Nada foi gravado em nome da resposta.
      expect({
        outbox: contar('core_outbox'),
        apiOutbox: contar('api_outbox'),
        filaAsaas: contar('asaas_operational_attempts'),
        trilha: contar('core_audit_log'),
      }).toEqual(antes);
    });
  }
});

describe('o contrato publicado não anuncia o que não existe', () => {
  it('o openapi não descreve nenhuma das rotas que fingiam', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const caminhos = Object.keys(res.body.paths as Record<string, unknown>);
    for (const morta of [
      '/sync/outbox',
      '/sync/cursor',
      '/fiscal/nfce/queues/{attemptId}/retry',
      '/fiscal/nfe/queues/{attemptId}/retry',
      '/fiscal/nfce/offline/sync',
      '/fiscal/reconciliation',
      '/asaas/homologation/start',
      '/asaas/charges/{chargeLinkId}',
      '/asaas/production/activate',
      '/payment-terminals/transactions/{id}/receipt',
      '/payment-terminals/transactions/{id}/reprint',
    ]) {
      expect(caminhos, `${morta} ainda está no openapi`).not.toContain(morta);
    }
  });
});

describe('o que é de verdade, ao lado, continua de pé', () => {
  it('a fila da central e o estado dela respondem pelo núcleo', async () => {
    const res = await request(app).get('/api/v1/core/sync/status').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.outbox).toBeTruthy();
  });

  it('a transação de maquininha inexistente já respondia 404 — e continua', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/transactions/nao-existe').set(auth);
    expect(res.status).toBe(404);
  });
});
