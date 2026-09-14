/**
 * TIRAR MERCADORIA DO SISTEMA À MÃO EXIGE DIZER POR QUÊ.
 *
 * ============================================================================
 * OS DOIS BURACOS DA ROTA MANUAL
 * ============================================================================
 *
 * **1. Ajuste negativo sem motivo.**
 *
 * `POST /core/stock/movements` aceitava tirar quantidade do estoque sem uma
 * palavra de explicação — e nem repassava o `reason` para o serviço, então a
 * coluna nascia nula mesmo quando alguém digitava algo. A contagem de
 * inventário, que faz a MESMA coisa, sempre exigiu motivo.
 *
 * O histórico de estoque é o que se consulta quando a prateleira discorda do
 * sistema. Uma linha "saíram 3" sem motivo não responde nada: não se sabe se
 * foi perda, furto, uso interno ou erro de digitação — e a diferença entre
 * essas quatro é a decisão que o gestor precisa tomar.
 *
 * **2. `referenceType` livre.**
 *
 * O corpo mandava o rótulo que quisesse, e ele ia direto para o histórico: dava
 * para lançar um ajuste manual e chamá-lo de `sale`. Duas consequências, e a
 * segunda é pior que cosmética:
 *
 *   - o histórico passa a mentir sobre o que aconteceu;
 *   - `applyMovement` decide o destino da PLAQUINHA pela referência, e `sale`
 *     está na lista das que DÃO DONO. Um ajuste manual rotulado de venda
 *     carimbaria proprietário numa moto que ninguém comprou.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let produto: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'estoquista-motivo',
    companyId: 'loja-motivo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  produto = createProduct(companyId, { name: 'Camiseta', priceCents: 5_000 }).id;
  applyMovement({
    companyId,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'carga',
  });
});

function mover(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/stock/movements')
    .set(auth)
    .send({ productId: produto, referenceId: randomUUID(), ...body });
}

function ultimoMovimento(): { reason: string | null; reference_type: string } {
  return getConnection()
    .prepare(
      `SELECT reason, reference_type FROM core_stock_movements
        WHERE company_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(companyId) as { reason: string | null; reference_type: string };
}

// ============================================================================

describe('o que sai à mão tem de dizer por quê', () => {
  it('saída sem motivo é recusada, e a recusa explica o que escrever', async () => {
    const res = await mover({ movementType: 'out', quantity: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REASON_REQUIRED');
    expect(String(res.body.error.message)).toMatch(/motivo/i);
  });

  it('ajuste NEGATIVO também', async () => {
    const res = await mover({ movementType: 'adjust', quantity: -3 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REASON_REQUIRED');
  });

  it('motivo em branco não conta como motivo', async () => {
    const res = await mover({ movementType: 'out', quantity: 3, reason: '   ' });
    expect(res.status).toBe(400);
  });

  it('com motivo, a saída acontece — e o motivo FICA no histórico', async () => {
    const res = await mover({
      movementType: 'out',
      quantity: 3,
      reason: 'Peça quebrada na montagem',
    });

    expect(res.status).toBe(201);
    expect(ultimoMovimento().reason).toBe('Peça quebrada na montagem');
  });

  it('ENTRADA não precisa de motivo — mercadoria que chega não some de lugar nenhum', async () => {
    /*
      Exigir motivo na entrada transformaria toda carga de estoque num
      formulário a mais, sem responder pergunta nenhuma: entrada aparece na
      prateleira, e a prateleira confere. O que precisa de explicação é o que
      DESAPARECE.
    */
    const res = await mover({ movementType: 'in', quantity: 5 });
    expect(res.status).toBe(201);
  });

  /*
    MUDOU (B-estoque-entrada-13#reauditoria): este caso dizia "ajuste POSITIVO
    também não" e esperava 201. Era a metade que faltava do achado: o "+20" sem
    uma palavra virava sobra muda no histórico. Ajuste não é entrada — ele diz
    que o sistema estava errado, nos dois sentidos. A ENTRADA avulsa (caso de
    cima) continua sem motivo.
  */
  it('ajuste POSITIVO sem motivo é recusado, e a recusa aponta a Entrada avulsa', async () => {
    const res = await mover({ movementType: 'adjust', quantity: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REASON_REQUIRED');
    expect(String(res.body.error.message)).toMatch(/motivo do ajuste.*Entrada avulsa/);
  });

  it('ajuste POSITIVO com motivo passa, e o motivo fica no histórico', async () => {
    const res = await mover({ movementType: 'adjust', quantity: 5, reason: 'Achei 5 na prateleira de cima' });
    expect(res.status).toBe(201);
    expect(ultimoMovimento().reason).toBe('Achei 5 na prateleira de cima');
  });
});

// ============================================================================

describe('o rótulo do movimento não é digitado pelo chamador', () => {
  it('um ajuste manual não pode se chamar "venda"', async () => {
    /*
      Não é só o histórico mentir. `applyMovement` decide o destino da
      PLAQUINHA pela referência, e `sale` está na lista das que dão dono: um
      ajuste rotulado de venda carimbaria proprietário numa moto que ninguém
      comprou, e a garantia passaria a correr a partir dali.
    */
    const res = await mover({
      movementType: 'out',
      quantity: 1,
      reason: 'Sumiu',
      referenceType: 'sale',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REFERENCE_TYPE_INVALID');
  });

  it('nem "ecommerce_order", que também dá dono', async () => {
    const res = await mover({
      movementType: 'out',
      quantity: 1,
      reason: 'Sumiu',
      referenceType: 'ecommerce_order',
    });
    expect(res.status).toBe(400);
  });

  it('nem um rótulo inventado', async () => {
    const res = await mover({
      movementType: 'out',
      quantity: 1,
      reason: 'Sumiu',
      referenceType: 'coisa_que_nao_existe',
    });
    expect(res.status).toBe(400);
  });

  it('os rótulos manuais valem, e chegam ao histórico', async () => {
    for (const rotulo of ['ajuste', 'perda', 'uso_interno', 'manual']) {
      const res = await mover({
        movementType: 'out',
        quantity: 1,
        reason: 'Motivo qualquer',
        referenceType: rotulo,
      });
      expect([rotulo, res.status]).toEqual([rotulo, 201]);
      expect(ultimoMovimento().reference_type).toBe(rotulo);
    }
  });

  it('sem rótulo, o padrão continua sendo "manual"', async () => {
    await mover({ movementType: 'out', quantity: 1, reason: 'Motivo qualquer' });
    expect(ultimoMovimento().reference_type).toBe('manual');
  });
});

// ============================================================================

describe('o código de barras é conferido também na EDIÇÃO', () => {
  /**
   * `createProduct` pergunta nas duas tabelas antes de gravar. `updateProduct`
   * não perguntava nada, e o desfecho dependia de qual delas o código ocupava:
   *
   *   - em `core_products`, sobrava o índice único e a tela levava um 500 cru;
   *   - em `core_product_barcodes`, nada barrava — e passavam a existir DOIS
   *     produtos respondendo ao mesmo bipe, sem erro e sem aviso. A leitora
   *     acha um dos dois, a venda sai do produto errado, e o saldo do certo
   *     nunca baixa.
   *
   * O segundo é o defeito; o 500 é só o mais barulhento.
   */
  async function produtoCom(nome: string, barcode?: string) {
    const res = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: nome, priceCents: 1_000, barcode });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  it('o código principal de outro produto é recusado — e não vira 500', async () => {
    await produtoCom('Camiseta azul', '7891234567895');
    const outro = await produtoCom('Camiseta verde');

    const res = await request(app)
      .put(`/api/v1/core/products/${outro.id}`)
      .set(auth)
      .send({ barcode: '7891234567895' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_BARCODE_DUPLICATE');
  });

  it('o código ADICIONAL de outro produto também — é o mesmo bipe', async () => {
    const dono = await produtoCom('Camiseta azul');
    await request(app)
      .post(`/api/v1/core/products/${dono.id}/barcodes`)
      .set(auth)
      .send({ barcode: '7899999999999' })
      .expect(201);

    const outro = await produtoCom('Camiseta verde');
    const res = await request(app)
      .put(`/api/v1/core/products/${outro.id}`)
      .set(auth)
      .send({ barcode: '7899999999999' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_BARCODE_DUPLICATE');
  });

  it('gravar o PRÓPRIO código de novo continua valendo', async () => {
    const produtoDele = await produtoCom('Camiseta azul', '7891234567895');

    const res = await request(app)
      .put(`/api/v1/core/products/${produtoDele.id}`)
      .set(auth)
      .send({ barcode: '7891234567895', name: 'Camiseta azul M' });

    expect(res.status).toBe(200);
  });

  it('editar sem mexer no código de barras não é barrado', async () => {
    const produtoDele = await produtoCom('Camiseta azul', '7891234567895');

    const res = await request(app)
      .put(`/api/v1/core/products/${produtoDele.id}`)
      .set(auth)
      .send({ priceCents: 2_000 });

    expect(res.status).toBe(200);
  });
});
