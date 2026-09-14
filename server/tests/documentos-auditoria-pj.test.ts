/**
 * DOCUMENTOS IMPRESSOS PELA FILA (auditoria PJ, trilha "documentos").
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * C-etiquetas-17  A etiqueta avulsa da fila (PRODUCT_LABEL) tinha desenho
 *                 próprio e imprimia o preço de TABELA: com promoção valendo,
 *                 a prateleira dizia R$ 49,90 e o caixa cobrava R$ 39,90. A
 *                 segunda via copiava o papel congelado, e depois de a
 *                 promoção acabar repetia os R$ 39,90 — o papel cobrando
 *                 menos que o caixa.
 *
 * H-caixa-seguranca-11  O papel do fechamento imprimia os códigos do banco
 *                 ("dinheiro", "opening", "withdrawal"), sem caixa, sem quem
 *                 abriu e quem fechou, com as sangrias somadas numa linha sem
 *                 motivo, e calava a pendência declarada. Num turno ABERTO
 *                 saía "CONFERIDO R$ 0,00", pronto para ser assinado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { addMovement, closeSession, openSession } from '../src/services/core/CashService.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import { createPrintJob, getPrintJob, reprintJob } from '../src/services/core/PrintEngine.js';
import { EAN_DE_AMOSTRA } from '../src/services/core/BarcodeService.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';

const app = createApp();
const SENHA = 'Documentos@Pj2026';

let empresa: string;
let caixa: string;
let gerente: string;
let auth: { Authorization: string };

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** O preço GRANDE da etiqueta — o que o cliente lê de longe. */
function precoDaEtiqueta(html: string | null): string | undefined {
  return html?.match(/class="preco"[^>]*>([^<]+)</)?.[1];
}

function promocao(productId: string, precoCents: number) {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active, starts_at, created_at)
       VALUES (?, ?, ?, ?, 1, '2020-01-01T00:00:00.000Z', ?)`,
    )
    .run(`promo-${productId}`, empresa, productId, precoCents, new Date().toISOString());
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  caixa = await upsertUser({ login: 'CAIXA.DOC', displayName: 'Maria do Caixa', password: SENHA });
  linkUserToCompany(caixa, empresa, 'operador_caixa_loja', true);
  gerente = await upsertUser({ login: 'GERENTE.DOC', displayName: 'Joana Gerente', password: SENHA });
  linkUserToCompany(gerente, empresa, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'CAIXA.DOC', password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

// ============================================================================

describe('C-etiquetas-17 — a etiqueta da fila diz o preço que o caixa cobra', () => {
  it('com a promoção valendo, a etiqueta sai com o preço promocional (e o "de" riscado)', () => {
    const blusa = String(createProduct(empresa, { name: 'Blusa', priceCents: 4990, barcode: '7891234567895' }).id);
    promocao(blusa, 3990);
    // A mesma régua do PDV.
    expect(effectivePriceCents(empresa, blusa, 4990, null).priceCents).toBe(3990);

    const html = renderDocument(empresa, 'PRODUCT_LABEL', blusa);

    // Antes: `<div class="preco">R$ 49,90</div>` — o preço de tabela.
    expect(precoDaEtiqueta(html)).toBe(brl(3990));
    expect(html).toMatch(/class="de"[^>]*>R\$\s49,90/);
    // Continua sendo o rolo de 50 × 30 mm, com as barras da peça.
    expect(html).toContain('50mm 30mm');
    expect(html).toContain('7891234567895');
  });

  it('a segunda via sai com o preço de HOJE, e não com o da promoção que acabou', () => {
    const blusa = String(createProduct(empresa, { name: 'Blusa', priceCents: 4990, barcode: '7891234567895' }).id);
    promocao(blusa, 3990);
    const primeira = createPrintJob({
      companyId: empresa,
      userId: caixa,
      documentType: 'PRODUCT_LABEL',
      documentId: blusa,
      payload: renderDocument(empresa, 'PRODUCT_LABEL', blusa),
    });
    expect(precoDaEtiqueta(primeira.payload)).toBe(brl(3990));

    // A promoção acaba.
    getConnection().prepare('UPDATE core_promotions SET active = 0 WHERE product_id = ?').run(blusa);

    const via = reprintJob({ companyId: empresa, userId: caixa, jobId: primeira.id });
    // Antes: a via copiava o payload e colava R$ 39,90 com o caixa cobrando R$ 49,90.
    expect(precoDaEtiqueta(via.payload)).toBe(brl(4990));
    expect(via.payload).not.toContain('class="de"');
    expect(via.reprint_of).toBe(primeira.id);
    // O papel da primeira via, que já saiu, não é reescrito.
    expect(precoDaEtiqueta(getPrintJob(empresa, primeira.id).payload)).toBe(brl(3990));
  });

  it('a segunda via do cupom de venda continua sendo o papel de antes', () => {
    const blusa = String(createProduct(empresa, { name: 'Blusa', priceCents: 4990 }).id);
    applyMovement({ companyId: empresa, productId: blusa, movementType: 'in', quantity: 5, referenceType: 'entrada', referenceId: 'c1' });
    const venda = createSale({
      companyId: empresa,
      userId: caixa,
      idempotencyKey: randomUUID(),
      items: [{ productId: blusa, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 4990 }],
    });
    const cupom = createPrintJob({
      companyId: empresa,
      userId: caixa,
      documentType: 'SALE_RECEIPT',
      documentId: venda.sale.id,
      payload: '<p>papel congelado</p>',
    });
    // Só a etiqueta segue o cadastro: o cupom registra um fato que já aconteceu.
    expect(reprintJob({ companyId: empresa, userId: caixa, jobId: cupom.id }).payload).toBe('<p>papel congelado</p>');
  });

  it('produto sem código: nem EAN de amostra, nem código gravado no cadastro pela impressão', () => {
    const semEan = String(createProduct(empresa, { name: 'Sem código', priceCents: 1000, barcode: null }).id);

    const html = renderDocument(empresa, 'PRODUCT_LABEL', semEan);

    expect(html).not.toContain(EAN_DE_AMOSTRA);
    expect(html).not.toContain('GERADO AO IMPRIMIR');
    expect(html).toContain('SEM CÓDIGO DE BARRAS');
    const gravado = getConnection().prepare('SELECT barcode FROM core_products WHERE id = ?').get(semEan) as {
      barcode: string | null;
    };
    expect(gravado.barcode).toBeNull();
  });

  it('pela rota, o caixa enfileira a etiqueta com o preço promocional', async () => {
    const blusa = String(createProduct(empresa, { name: 'Blusa', priceCents: 4990, barcode: '7891234567895' }).id);
    promocao(blusa, 3990);
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'PRODUCT_LABEL', documentId: blusa });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const doc = await request(app).get(`/api/v1/core/print/jobs/${job.body.id}/document`).set(auth);
    expect(precoDaEtiqueta(doc.text)).toBe(brl(3990));
  });
});

// ============================================================================

describe('H-caixa-seguranca-11 — o papel do fechamento de caixa', () => {
  function produtoComEstoque(): string {
    const p = String(createProduct(empresa, { name: 'Camiseta', priceCents: 5000 }).id);
    applyMovement({ companyId: empresa, productId: p, movementType: 'in', quantity: 10, referenceType: 'entrada', referenceId: 'c1' });
    return p;
  }

  /** Turno do "Caixa 1 — Balcão": abre com R$ 100, vende, sangra, supre e fecha faltando R$ 5. */
  function turnoFechado(): string {
    getConnection()
      .prepare(`INSERT INTO core_terminals (id, company_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('t-doc', empresa, 'CX-DOC-1', 'Caixa 1 — Balcão', new Date().toISOString());
    const produto = produtoComEstoque();
    const sessao = openSession({ companyId: empresa, userId: caixa, terminalId: 't-doc', openingCents: 10_000 });
    // R$ 100 entregues numa venda de R$ 50: R$ 50 de troco, R$ 50 ficam na gaveta.
    createSale({
      companyId: empresa,
      userId: caixa,
      cashSessionId: sessao.id,
      terminalId: 't-doc',
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      idempotencyKey: randomUUID(),
    } as Parameters<typeof createSale>[0]);
    createSale({
      companyId: empresa,
      userId: caixa,
      cashSessionId: sessao.id,
      terminalId: 't-doc',
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5_000, status: 'settled' }],
      idempotencyKey: randomUUID(),
    } as Parameters<typeof createSale>[0]);
    addMovement({
      companyId: empresa,
      sessionId: sessao.id,
      userId: gerente,
      movementType: 'withdrawal',
      amountCents: 3_000,
      note: 'Depósito no banco',
      alcada: { profileCodes: ['gerente_loja'] },
    });
    addMovement({
      companyId: empresa,
      sessionId: sessao.id,
      userId: gerente,
      movementType: 'supply',
      amountCents: 2_000,
      note: 'Troco do cofre',
    });
    // Esperado: 100 + 50 − 30 + 20 = 140. Contado 135: falta R$ 5.
    closeSession({ companyId: empresa, sessionId: sessao.id, userId: gerente, countedCents: 13_500 });
    return sessao.id;
  }

  it('sai com rótulos que o balcão lê, o caixa, quem abriu, quem fechou e cada sangria com o motivo', () => {
    const papel = renderDocument(empresa, 'CASH_CLOSING', turnoFechado());

    expect(papel).toContain('Caixa 1 — Balcão');
    expect(papel).toContain('Maria do Caixa'); // abriu
    expect(papel).toContain('Joana Gerente'); // fechou e lançou a sangria
    // Revisão: o nome solto não prova a linha certa — Joana também lançou a
    // sangria. Quem abriu e quem fechou, cada um na sua linha.
    expect(papel).toMatch(/Aberto por<\/td><td class="r">Maria do Caixa</);
    expect(papel).toMatch(/Fechado por<\/td><td class="r">Joana Gerente</);
    expect(papel).toMatch(/<td>Dinheiro<\/td>/);
    expect(papel).toMatch(/<td>PIX<\/td>/);
    expect(papel).toContain('Abertura (fundo de troco)');
    expect(papel).toContain('Vendas em dinheiro');
    expect(papel).toMatch(/<td>Sangria<\/td><td class="r">- R\$\s30,00/);
    expect(papel).toContain('Depósito no banco');
    expect(papel).toContain('Suprimento');
    expect(papel).toContain('Troco do cofre');
    expect(papel).toMatch(/Troco devolvido[^<]*<\/td><td class="r">- R\$\s50,00/);
    expect(papel).toMatch(/Esperado<\/td><td class="r b">R\$\s140,00/);
    expect(papel).toContain('FALTA');

    // Os códigos do banco não vão para o papel.
    for (const cru of ['withdrawal', 'opening', 'supply', '<td>dinheiro</td>', '<td>pix</td>', '<td>sale</td>']) {
      expect(papel, cru).not.toContain(cru);
    }
  });

  it('turno ABERTO não tem papel de fechamento: 409, e não um "CONFERIDO R$ 0,00"', () => {
    const sessao = openSession({ companyId: empresa, userId: caixa, openingCents: 10_000 });
    expect(() => renderDocument(empresa, 'CASH_CLOSING', sessao.id)).toThrowError(
      expect.objectContaining({ code: 'CORE_CASH_CLOSING_NOT_CLOSED', status: 409 }),
    );
  });

  it('pela rota: turno aberto é recusado sem criar job; fechado, o caixa imprime o fechamento', async () => {
    const sessao = openSession({ companyId: empresa, userId: caixa, openingCents: 10_000 });

    const aberto = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'CASH_CLOSING', documentId: sessao.id });
    expect(aberto.status, JSON.stringify(aberto.body)).toBe(409);
    expect(aberto.body?.error?.code).toBe('CORE_CASH_CLOSING_NOT_CLOSED');
    expect(aberto.body?.error?.message).toMatch(/ainda está aberto/);
    const jobs = getConnection().prepare('SELECT COUNT(*) AS n FROM core_print_jobs').get() as { n: number };
    expect(jobs.n).toBe(0);

    closeSession({ companyId: empresa, sessionId: sessao.id, userId: caixa, countedCents: 10_000 });
    const fechado = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'CASH_CLOSING', documentId: sessao.id });
    expect(fechado.status, JSON.stringify(fechado.body)).toBe(201);
    const doc = await request(app).get(`/api/v1/core/print/jobs/${fechado.body.id}/document`).set(auth);
    expect(doc.text).toContain('FECHAMENTO DE CAIXA');
    expect(doc.text).toContain('CONFERIDO');
    expect(doc.text).toContain('Fechado por');
    expect(doc.text).toContain('Maria do Caixa');
  });

  it('o turno fechado com pendência eletrônica diz isso no papel, com o motivo e quem declarou', () => {
    const produto = produtoComEstoque();
    const sessao = openSession({ companyId: empresa, userId: caixa, openingCents: 0 });
    const venda = createSale({
      companyId: empresa,
      userId: caixa,
      cashSessionId: sessao.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [
        { method: 'dinheiro', amountCents: 2_000 },
        { method: 'pix', amountCents: 3_000, status: 'pending' },
      ],
      idempotencyKey: randomUUID(),
    } as Parameters<typeof createSale>[0]);
    closeSession({
      companyId: empresa,
      sessionId: sessao.id,
      userId: caixa,
      countedCents: 2_000,
      pendenciasCiente: true,
      pendenciasMotivo: 'gerente confere o extrato amanhã',
    });

    const papel = renderDocument(empresa, 'CASH_CLOSING', sessao.id);
    const [recebido, pendencia] = papel.split('FECHADO COM PENDÊNCIA ELETRÔNICA');

    expect(pendencia).toBeDefined();
    expect(pendencia).toContain(`PIX pendente, venda #${venda.sale.number}`);
    expect(pendencia).toMatch(/30,00/);
    expect(pendencia).toContain('gerente confere o extrato amanhã');
    expect(pendencia).toContain('Declarado por Maria do Caixa');
    // O PIX que não caiu não entra como recebido.
    expect(recebido).not.toMatch(/<td>PIX<\/td>/);
  });

  it('turno reaberto e fechado de novo avisa que este é o fechamento que vale', async () => {
    const { reopenSession } = await import('../src/services/core/CashService.js');
    const sessao = openSession({ companyId: empresa, userId: caixa, openingCents: 10_000 });
    closeSession({ companyId: empresa, sessionId: sessao.id, userId: caixa, countedCents: 10_000 });
    reopenSession({
      companyId: empresa,
      sessionId: sessao.id,
      userId: gerente,
      reason: 'contagem refeita com o gerente',
      alcada: { profileCodes: ['gerente_loja'] },
    });
    // Reaberto, ele volta a ser turno aberto: sem papel de fechamento.
    expect(() => renderDocument(empresa, 'CASH_CLOSING', sessao.id)).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
    closeSession({ companyId: empresa, sessionId: sessao.id, userId: gerente, countedCents: 10_000 });

    expect(renderDocument(empresa, 'CASH_CLOSING', sessao.id)).toContain('Turno reaberto 1 vez(es)');
  });

  /*
    REVISÃO: a recusa do turno aberto valia só para o papel NOVO. A segunda via
    copia o papel congelado sem olhar o turno — então, depois de o gerente
    reabrir, a via do job antigo ainda entregava "CONFERIDO" para um turno
    aberto, e depois de fechado de novo entregava a contagem desfeita.
    Sem `exigirFechamentoQueVale` (PrintEngine), os dois `toThrowError` abaixo
    falham: a via sai.
  */
  it('a segunda via de um fechamento desfeito pela reabertura não sai', async () => {
    const { reopenSession } = await import('../src/services/core/CashService.js');
    const db = getConnection();
    const sessao = openSession({ companyId: empresa, userId: caixa, openingCents: 10_000 });
    closeSession({ companyId: empresa, sessionId: sessao.id, userId: caixa, countedCents: 10_000 });
    const papel = createPrintJob({
      companyId: empresa,
      userId: caixa,
      documentType: 'CASH_CLOSING',
      documentId: sessao.id,
      payload: renderDocument(empresa, 'CASH_CLOSING', sessao.id),
    });
    // Enquanto é o fechamento que vale, a via sai — e é o mesmo papel.
    const via = reprintJob({ companyId: empresa, userId: caixa, jobId: papel.id });
    expect(via.payload).toBe(papel.payload);

    // O papel saiu às 10h; o gerente reabre às 11h (horas fixas: sem depender do milissegundo).
    db.prepare(`UPDATE core_print_jobs SET created_at = '2020-01-01T10:00:00.000Z' WHERE id IN (?, ?)`).run(
      papel.id,
      via.id,
    );
    reopenSession({
      companyId: empresa,
      sessionId: sessao.id,
      userId: gerente,
      reason: 'contagem refeita com o gerente',
      alcada: { profileCodes: ['gerente_loja'] },
    });
    db.prepare(`UPDATE core_cash_sessions SET reopened_at = '2020-01-01T11:00:00.000Z' WHERE id = ?`).run(sessao.id);

    // Turno aberto: nem a via do papel antigo.
    expect(() => reprintJob({ companyId: empresa, userId: caixa, jobId: papel.id })).toThrowError(
      expect.objectContaining({ code: 'CORE_CASH_CLOSING_NOT_CLOSED', status: 409 }),
    );

    // Fechado de novo, com outra contagem: o papel das 10h é de um fechamento desfeito.
    closeSession({ companyId: empresa, sessionId: sessao.id, userId: gerente, countedCents: 9_000 });
    for (const jobId of [papel.id, via.id]) {
      expect(() => reprintJob({ companyId: empresa, userId: caixa, jobId }), jobId).toThrowError(
        expect.objectContaining({ code: 'CORE_CASH_CLOSING_SUPERSEDED', status: 409 }),
      );
    }

    // O fechamento que vale imprime, e tem segunda via.
    const atual = createPrintJob({
      companyId: empresa,
      userId: caixa,
      documentType: 'CASH_CLOSING',
      documentId: sessao.id,
      payload: renderDocument(empresa, 'CASH_CLOSING', sessao.id),
    });
    const viaAtual = reprintJob({ companyId: empresa, userId: caixa, jobId: atual.id });
    expect(viaAtual.payload).toContain('Turno reaberto 1 vez(es)');
    expect(viaAtual.payload).toContain('FALTA');
  });
});
