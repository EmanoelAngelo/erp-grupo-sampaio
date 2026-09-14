/**
 * ============================================================================
 * O CADASTRO FECHA O CICLO — as beiradas que audit-manager não cobre
 * ============================================================================
 *
 * audit-manager.test.ts documenta os achados da auditoria pela porta
 * principal: CPF inválido no POST, máscara virando duplicata, o PUT de cliente
 * que não existia, o preço negativo na criação. Este arquivo cobre as BEIRADAS
 * do mesmo conserto — cada uma é um jeito de o defeito voltar por outra porta:
 *
 *   - o PUT de produto também recusa dinheiro negativo (preço, custo e piso).
 *     O achado era "no POST e no PUT"; testar só o POST deixaria a edição
 *     aberta para gravar o -500 que a criação passou a recusar;
 *   - o documento entra no banco SÓ DÍGITOS — o INSERT normaliza, não apenas o
 *     dedupe. É a coluna crua que FiscalXmlNfce escreve em <CPF> do XML, então
 *     máscara gravada seria rejeição da SEFAZ mesmo com o dedupe certo;
 *   - cadastro ANTIGO gravado com máscara (de antes desta rodada, quando nada
 *     normalizava) não vira segundo cliente: o dedupe compara normalizado
 *     contra normalizado DOS DOIS LADOS, não só do lado de quem chega;
 *   - a edição passa pela MESMA porta da criação: documento trocado é validado
 *     (módulo 11) e deduplicado — senão o PUT seria o contorno do POST;
 *   - inativar não é apagar: o PUT com `active: true` traz o cliente de volta,
 *     com tudo que ele tinha;
 *   - a ficha de um id inexistente é 404 com código da casa, não um vazamento.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let gestor: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const g = await loginForTest(app, {
    userId: 'gestor-ciclo',
    companyId: 'loja-ciclo',
    profileCodes: ['gestor'],
  });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  gestor = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;
});

// ============================================================================
// PRODUTO — a edição recusa o mesmo dinheiro impossível que a criação
// ============================================================================

describe('produto — dinheiro negativo não entra por NENHUMA das duas portas', () => {
  it('o PUT recusa preço, custo e piso negativos — e o valor gravado fica de pé', async () => {
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(gestor)
      .send({ name: 'Cadeado Reforçado', priceCents: 4_500, costCents: 2_000 });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const id = criado.body.id as string;

    // O mesmo código/mensagem da reprecificação em massa (`applyPrices`):
    // um fato, uma recusa.
    for (const corpo of [
      { priceCents: -1 },
      { costCents: -500 },
      { minPriceCents: -100 },
    ]) {
      const res = await request(app)
        .put(`/api/v1/core/products/${id}`)
        .set(gestor)
        .send(corpo);
      expect(res.status, `negativo aceito no PUT: ${JSON.stringify(corpo)}`).toBe(400);
      expect(res.body.error?.code).toBe('CORE_PRICE_INVALID');
    }

    // A recusa não pode ter arranhado o cadastro: o preço que valia continua.
    const ficha = await request(app).get(`/api/v1/core/products/${id}`).set(gestor);
    expect(ficha.body.price_cents).toBe(4_500);
    expect(ficha.body.cost_cents).toBe(2_000);
  });

  it('o POST também recusa custo e piso negativos — o achado não era só o preço', async () => {
    for (const corpo of [
      { name: 'Custo Impossível', priceCents: 1_000, costCents: -300 },
      { name: 'Piso Impossível', priceCents: 1_000, minPriceCents: -1 },
    ]) {
      const res = await request(app).post('/api/v1/core/products').set(gestor).send(corpo);
      expect(res.status, `negativo aceito no POST: ${JSON.stringify(corpo)}`).toBe(400);
      expect(res.body.error?.code).toBe('CORE_PRICE_INVALID');
    }
  });
});

// ============================================================================
// CLIENTE — o documento no banco é o que o XML vai ler
// ============================================================================

describe('cliente — o documento vive no banco só em dígitos', () => {
  it('cadastrado com máscara, gravado sem: a coluna crua é a que sai no XML', async () => {
    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria Mascarada', document: '111.444.777-35' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.document).toBe('11144477735');

    // E a ficha relida confirma o que está na coluna, não só no eco do POST.
    const ficha = await request(app)
      .get(`/api/v1/core/customers/${criado.body.id}`)
      .set(gestor);
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.document).toBe('11144477735');
  });

  it('cadastro ANTIGO com máscara não vira duplicata: o dedupe normaliza os dois lados', async () => {
    /*
      Linha plantada direto no banco, como o banco real tem: de antes desta
      rodada, quando o INSERT gravava o documento cru. Se o dedupe comparasse
      o documento limpo com a coluna crua, este cadastro seria invisível para
      a checagem — e a mesma pessoa nasceria de novo.
    */
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, document, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(randomUUID(), companyId, 'Maria de Antes', '111.444.777-35', agora, agora);

    const denovo = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria de Agora', document: '11144477735' });
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(409);
    expect(denovo.body.error?.code).toBe('CORE_DUPLICATE_DOCUMENT');
  });
});

describe('cliente — a edição passa pela mesma porta da criação', () => {
  it('trocar o documento valida o verificador e recusa o de outro cliente', async () => {
    const maria = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Maria', document: '11144477735' });
    expect(maria.status).toBe(201);
    const joao = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'João', document: '52998224725' });
    expect(joao.status).toBe(201);

    // O CPF da Maria, mascarado, não vira o do João: 409, mesmo código do POST.
    const roubo = await request(app)
      .put(`/api/v1/core/customers/${joao.body.id}`)
      .set(gestor)
      .send({ document: '111.444.777-35' });
    expect(roubo.status, JSON.stringify(roubo.body)).toBe(409);
    expect(roubo.body.error?.code).toBe('CORE_DUPLICATE_DOCUMENT');

    // Dígito verificador errado também não entra pela edição.
    const errado = await request(app)
      .put(`/api/v1/core/customers/${joao.body.id}`)
      .set(gestor)
      .send({ document: '12345678900' });
    expect(errado.status, JSON.stringify(errado.body)).toBe(400);

    // Documento novo e VÁLIDO entra — e entra só em dígitos.
    const troca = await request(app)
      .put(`/api/v1/core/customers/${joao.body.id}`)
      .set(gestor)
      .send({ document: '390.533.447-05' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body.document).toBe('39053344705');

    // Reenviar o PRÓPRIO documento não é duplicata: o dedupe exclui o dono.
    const mesmo = await request(app)
      .put(`/api/v1/core/customers/${joao.body.id}`)
      .set(gestor)
      .send({ document: '39053344705' });
    expect(mesmo.status, JSON.stringify(mesmo.body)).toBe(200);
  });

  it('inativar não apaga: reativar devolve o cliente inteiro à lista', async () => {
    const criado = await request(app)
      .post('/api/v1/core/customers')
      .set(gestor)
      .send({ name: 'Cliente Que Voltou', phone: '96 91234-5678' });
    expect(criado.status).toBe(201);
    const id = criado.body.id as string;

    const inativa = await request(app)
      .put(`/api/v1/core/customers/${id}`)
      .set(gestor)
      .send({ active: false });
    expect(inativa.status, JSON.stringify(inativa.body)).toBe(200);
    expect(inativa.body.active).toBe(0);

    const semEle = await request(app).get('/api/v1/core/customers').set(gestor);
    expect((semEle.body.items as { id: string }[]).map((c) => c.id)).not.toContain(id);

    // A volta: mudou de cidade e voltou — o cadastro estava esperando.
    const reativa = await request(app)
      .put(`/api/v1/core/customers/${id}`)
      .set(gestor)
      .send({ active: true });
    expect(reativa.status, JSON.stringify(reativa.body)).toBe(200);
    expect(reativa.body.active).toBe(1);
    expect(reativa.body.phone).toBe('96 91234-5678');

    const comEle = await request(app).get('/api/v1/core/customers').set(gestor);
    expect((comEle.body.items as { id: string }[]).map((c) => c.id)).toContain(id);
  });

  it('a ficha de um id inexistente é 404 com o código da casa', async () => {
    const res = await request(app)
      .get(`/api/v1/core/customers/${randomUUID()}`)
      .set(gestor);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_CUSTOMER_NOT_FOUND');
  });
});
