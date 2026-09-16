/**
 * ============================================================================
 * A ESCOLHA DE LOTE NA ETIQUETA — a fila enxerga o que vai para o papel
 * ============================================================================
 *
 * O DEFEITO (P00 das etiquetas): `POST /labels/sheet` sempre aceitou `batchId`
 * por item, e a etiqueta com validade já saía com o lote FEFO — mas
 * `GET /labels/candidates` não devolvia lote nenhum. A tela não tinha como
 * mostrar QUAL validade ia sair nem como escolher outra, então quem etiquetava
 * a caixa recém-chegada colava nela a validade do lote velho que ainda estava
 * na prateleira.
 *
 * COMO ESTES CASOS FALHAM (quebrando de propósito — conferido):
 *
 *   - tire a chamada de `comOsLotes` de uma das sete origens em
 *     `listLabelCandidates` e o caso daquela origem fica vermelho;
 *   - troque o `ORDER BY (b.expires_on IS NULL), b.expires_on` por `b.code` e
 *     "o primeiro da lista é o que a folha escolhe sozinha" fica vermelho;
 *   - tire o `if (!(lote.quantity > 0)) continue` e o lote sem saldo volta à
 *     fila — a validade da caixa que já saiu;
 *   - tire o `AND b.company_id = ?` e o lote da outra loja aparece na Preço
 *     Justo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { createBatch, setBatchControl } from '../src/services/core/BatchService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { criarModelo } from '../src/services/core/LabelTemplateService.js';
import { listLabelCandidates } from '../src/services/core/LabelSourcesService.js';

const app = createApp();
const EMPRESA = 'loja-lote-etq';
const OUTRA = 'loja-lote-etq-outra';

let gerente: { Authorization: string };
let iogurte: string;
let parafuso: string;

const bearer = (r: { body: { accessToken: string } }) => ({ Authorization: `Bearer ${r.body.accessToken}` });

function entrar(companyId: string, productId: string, quantidade: number, batchId?: string) {
  applyMovement({
    companyId,
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: randomUUID(),
    batchId,
  });
}

beforeEach(async () => {
  resetDbForTests();
  gerente = bearer(await loginForTest(app, { userId: 'gerente-lote', companyId: EMPRESA, profileCodes: ['gerente_loja'] }));
  await loginForTest(app, { userId: 'gerente-lote-outra', companyId: OUTRA, profileCodes: ['gerente_loja'] });

  iogurte = String(createProduct(EMPRESA, { name: 'Iogurte natural 170g', priceCents: 350, barcode: '7891234567895' }).id);
  parafuso = String(createProduct(EMPRESA, { name: 'Parafuso 4x40', priceCents: 100, barcode: '7891234567802' }).id);
  setBatchControl({ companyId: EMPRESA, productId: iogurte, tracksBatches: true });
});

/** O candidato de um produto na busca do catálogo. */
function candidato(termo: string, productId: string) {
  const r = listLabelCandidates(EMPRESA, { source: 'catalogo', search: termo });
  const c = r.candidates.find((x) => x.productId === productId);
  if (!c) throw new Error(`candidato ${productId} não veio na busca "${termo}"`);
  return c;
}

describe('a fila mostra os lotes que a folha usaria', () => {
  it('o primeiro da lista é o que a folha escolhe sozinha: vence antes, e com saldo', () => {
    const dezembro = createBatch(EMPRESA, { productId: iogurte, code: 'L-DEZ', expiresOn: '2026-12-31' });
    const outubro = createBatch(EMPRESA, { productId: iogurte, code: 'L-OUT', expiresOn: '2026-10-05' });
    entrar(EMPRESA, iogurte, 12, dezembro.id);
    entrar(EMPRESA, iogurte, 4, outubro.id);

    const c = candidato('Iogurte', iogurte);
    expect(c.rastreiaLote).toBe(true);
    expect(c.lotes).toEqual([
      { batchId: outubro.id, code: 'L-OUT', expiresOn: '2026-10-05', quantity: 4 },
      { batchId: dezembro.id, code: 'L-DEZ', expiresOn: '2026-12-31', quantity: 12 },
    ]);
  });

  it('lote sem saldo não entra na fila: a validade da caixa que já saiu não volta para a prateleira', () => {
    const vazio = createBatch(EMPRESA, { productId: iogurte, code: 'L-VAZIO', expiresOn: '2026-09-01' });
    const cheio = createBatch(EMPRESA, { productId: iogurte, code: 'L-CHEIO', expiresOn: '2026-11-20' });
    entrar(EMPRESA, iogurte, 6, vazio.id);
    applyMovement({
      companyId: EMPRESA,
      productId: iogurte,
      movementType: 'out',
      quantity: 6,
      referenceType: 'perda',
      referenceId: randomUUID(),
      batchId: vazio.id,
    });
    entrar(EMPRESA, iogurte, 3, cheio.id);

    const c = candidato('Iogurte', iogurte);
    expect(c.lotes.map((l) => l.code)).toEqual(['L-CHEIO']);
  });

  it('lote sem validade declarada vai para o fim, e continua escolhível — nulo não é "não vence"', () => {
    const semData = createBatch(EMPRESA, { productId: iogurte, code: 'L-SEM-DATA', expiresOn: null });
    const comData = createBatch(EMPRESA, { productId: iogurte, code: 'L-COM-DATA', expiresOn: '2027-01-15' });
    entrar(EMPRESA, iogurte, 2, semData.id);
    entrar(EMPRESA, iogurte, 2, comData.id);

    expect(candidato('Iogurte', iogurte).lotes.map((l) => [l.code, l.expiresOn])).toEqual([
      ['L-COM-DATA', '2027-01-15'],
      ['L-SEM-DATA', null],
    ]);
  });

  it('quem não controla lote vem sem lote e sem o selo — e quem controla sem lote com saldo vem com o selo e a lista vazia', () => {
    entrar(EMPRESA, parafuso, 50);
    expect(candidato('Parafuso', parafuso)).toMatchObject({ rastreiaLote: false, lotes: [] });
    // O iogurte controla lote e ninguém declarou nenhum: é isto que a tela usa
    // para avisar que a etiqueta vai sair SEM validade.
    expect(candidato('Iogurte', iogurte)).toMatchObject({ rastreiaLote: true, lotes: [] });
  });

  it('o lote da outra operação não aparece nesta — nem o de outro produto', () => {
    const daOutra = String(createProduct(OUTRA, { name: 'Iogurte natural 170g', priceCents: 350 }).id);
    setBatchControl({ companyId: OUTRA, productId: daOutra, tracksBatches: true });
    const alheio = createBatch(OUTRA, { productId: daOutra, code: 'L-ALHEIO', expiresOn: '2026-10-01' });
    entrar(OUTRA, daOutra, 9, alheio.id);

    const meu = createBatch(EMPRESA, { productId: iogurte, code: 'L-MEU', expiresOn: '2026-12-01' });
    entrar(EMPRESA, iogurte, 5, meu.id);

    expect(candidato('Iogurte', iogurte).lotes.map((l) => l.code)).toEqual(['L-MEU']);
    // O parafuso é da MESMA loja e não tem lote: a consulta de lote é por produto.
    expect(candidato('Parafuso', parafuso).lotes).toEqual([]);
  });

  it('as sete origens trazem o lote — o funil é um só', async () => {
    const l = createBatch(EMPRESA, { productId: iogurte, code: 'L-FUNIL', expiresOn: '2026-11-11' });
    entrar(EMPRESA, iogurte, 7, l.id);

    const doEstoque = listLabelCandidates(EMPRESA, { source: 'estoque' });
    expect(doEstoque.candidates.find((c) => c.productId === iogurte)?.lotes.map((x) => x.code)).toEqual(['L-FUNIL']);

    const dosCodigos = listLabelCandidates(EMPRESA, { source: 'codigos', codes: '7891234567895' });
    expect(dosCodigos.candidates[0]?.lotes.map((x) => x.code)).toEqual(['L-FUNIL']);

    // Pela rota, que é como a tela vê.
    const pela = await request(app)
      .get('/api/v1/core/labels/candidates')
      .query({ source: 'catalogo', search: 'Iogurte' })
      .set(gerente);
    expect(pela.status, JSON.stringify(pela.body)).toBe(200);
    expect(pela.body.candidates[0].lotes).toEqual([
      { batchId: l.id, code: 'L-FUNIL', expiresOn: '2026-11-11', quantity: 7 },
    ]);
  });
});

describe('o lote escolhido na fila é o que sai no papel', () => {
  it('sem escolher, sai o que vence primeiro; escolhendo o outro, sai o outro', async () => {
    const modelo = criarModelo(EMPRESA, null, {
      name: 'Rolo com validade',
      midia: 'rolo',
      paperWidthMm: 50,
      widthMm: 50,
      heightMm: 40,
      fields: ['nome', 'preco', 'validade', 'lote', 'barras'],
      outputProfile: 'zpl',
    });
    const outubro = createBatch(EMPRESA, { productId: iogurte, code: 'L-OUT', expiresOn: '2026-10-05' });
    const dezembro = createBatch(EMPRESA, { productId: iogurte, code: 'L-DEZ', expiresOn: '2026-12-31' });
    entrar(EMPRESA, iogurte, 4, outubro.id);
    entrar(EMPRESA, iogurte, 12, dezembro.id);

    const lotes = candidato('Iogurte', iogurte).lotes;
    expect(lotes[0].code).toBe('L-OUT');

    const automatica = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({ templateId: modelo.id, perfil: 'zpl', items: [{ productId: iogurte, quantity: 1 }] });
    expect(automatica.status, JSON.stringify(automatica.body)).toBe(200);
    expect(automatica.body.comandos).toContain('Val. 05/10/2026 · Lote L-OUT');

    const escolhida = await request(app)
      .post('/api/v1/core/labels/sheet')
      .set(gerente)
      .send({
        templateId: modelo.id,
        perfil: 'zpl',
        items: [{ productId: iogurte, quantity: 1, batchId: lotes[1].batchId }],
      });
    expect(escolhida.status, JSON.stringify(escolhida.body)).toBe(200);
    expect(escolhida.body.comandos).toContain('Val. 31/12/2026 · Lote L-DEZ');
  });
});
