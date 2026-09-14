/**
 * ============================================================================
 * ESTORNO DA ENTRADA CONFIRMADA — o espelho do confirmar, numa transação só
 * ============================================================================
 *
 * GAP-V20: o XML confirmado por engano (a nota do irmão da outra empresa, o
 * arquivo duplicado com chave diferente) não tinha volta: o estoque só descia
 * por ajuste manual e a dívida só saía cancelando o lançamento à parte — dois
 * gestos desconectados, sem vínculo entre si nem com a nota, e o histórico do
 * fornecedor continuava contando a compra.
 *
 * O desenho do conserto, `POST /purchases/notes/:id/estornar`:
 *
 *   1. REVERTE os movimentos de estoque com movimento CONTRÁRIO no razão —
 *      nunca apaga: a entrada aconteceu e o estorno também, e o histórico
 *      conta os dois;
 *   2. CANCELA o título se aberto (carimbo `cancelled_at`, como a venda
 *      cancelada); se JÁ BAIXADO, recusa mandando estornar a baixa primeiro —
 *      dinheiro que saiu não some por decreto;
 *   3. DESFAZ o retrato do pedido amarrado (recalcReceived volta a contar só
 *      notas vivas — inclusive rebaixando o pedido 'recebido');
 *   4. carimba a nota como 'estornada' com quem/quando/por quê, e o documento
 *      vira MORTO: não se confere, não se reconfirma, não se amarra;
 *   5. é IDEMPOTENTE (estornar de novo não desce estoque duas vezes) e
 *      AUDITADO.
 *
 * Nota inteira ou nota nenhuma: mercadoria que já saiu do estoque impede o
 * estorno com recusa nomeada — o caminho aí é o ajuste com motivo, que já
 * existe e tem trilha própria.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { applyMovement, listMovements } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

const CNPJ = '14200166000187';

let auth: { Authorization: string };
let companyId: string;
/** O id REAL do usuário (o login de teste gera UUID) — é ele que a trilha grava. */
let gerenteId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-do-estorno',
    companyId: 'loja-do-estorno',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  gerenteId = res.body.user.id;
});

// ---------------------------------------------------------------- helpers

async function fornecedor(): Promise<{ id: string }> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    .send({ name: 'Distribuidora do Estorno Ltda', document: CNPJ, paymentTermDays: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function produto(nome: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 5000 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function nota(noteId: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_inbound_notes WHERE id = ?')
    .get(noteId) as Record<string, unknown>;
}

function divida(noteId: string): Record<string, unknown> | undefined {
  return getConnection()
    .prepare(
      `SELECT id, status, cancelled_at, settled_cents FROM core_finance_entries
        WHERE company_id = ? AND origin_id = ? AND direction = 'out'`,
    )
    .get(companyId, noteId) as Record<string, unknown> | undefined;
}

function movimentos(noteId: string): Record<string, unknown>[] {
  return getConnection()
    .prepare(
      `SELECT movement_type, kind, reference_type, quantity, balance_after
         FROM core_stock_movements
        WHERE company_id = ? AND reference_id = ? ORDER BY created_at`,
    )
    .all(companyId, noteId) as unknown as Record<string, unknown>[];
}

/** Entrada manual confirmada: o caminho mais curto até uma nota 'recebida'. */
async function entradaConfirmada(
  productId: string,
  qtd: number,
  custo: number,
): Promise<string> {
  const f = await fornecedor();
  const criada = await request(app)
    .post('/api/v1/core/purchases/manual')
    .set(auth)
    .send({ supplierId: f.id, items: [{ productId, quantity: qtd, unitCostCents: custo }] });
  expect(criada.status, JSON.stringify(criada.body)).toBe(201);
  const noteId = criada.body.noteId as string;
  const conf = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({});
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  return noteId;
}

async function estornar(noteId: string, reason = 'Confirmada por engano — documento da outra empresa') {
  return request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/estornar`)
    .set(auth)
    .send({ reason });
}

// =============================================================== O ESPELHO

describe('o estorno desfaz as três pontas numa transação só', () => {
  it('estoque desce por movimento CONTRÁRIO, a dívida aberta é cancelada, e a nota vira estornada com autor e motivo', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    expect(saldo(pastilha)).toBe(10);
    expect(divida(noteId)?.status).toBe('open');

    const res = await estornar(noteId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.alreadyReversed).toBe(false);
    expect(res.body.status).toBe('estornada');

    // O estoque volta a zero — e o razão conta a história INTEIRA: a entrada
    // continua lá, e o estorno é uma linha nova de saída. Nada apagado.
    expect(saldo(pastilha)).toBe(0);
    const movs = movimentos(noteId);
    expect(movs).toHaveLength(2);
    expect(movs[0].movement_type).toBe('in');
    expect(movs[1].movement_type).toBe('out');
    expect(movs[1].reference_type).toBe('estorno_entrada');
    expect(movs[1].quantity).toBe(-10);

    // A dívida aberta cai pelo carimbo — o mesmo desenho da venda cancelada.
    const conta = divida(noteId);
    expect(conta?.status).toBe('cancelled');
    expect(conta?.cancelled_at).toBeTruthy();

    // E a nota diz quem, quando e por quê.
    const n = nota(noteId);
    expect(n.status).toBe('estornada');
    expect(n.reversed_by).toBe(gerenteId);
    expect(n.reversed_at).toBeTruthy();
    expect(String(n.reversal_reason)).toContain('engano');

    // A lista da tela conta a história sem SQL: espécie, selo e o motivo com
    // autor — coluna gravada TEM leitor (a regra da casa).
    const lista = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(lista.status).toBe(200);
    const daLista = (lista.body.items as Record<string, unknown>[]).find((i) => i.id === noteId);
    expect(daLista?.status).toBe('estornada');
    expect(daLista?.reversed_at).toBeTruthy();
    expect(String(daLista?.reversal_reason)).toContain('engano');
    expect(daLista?.reversed_by_name).toBe('gerente-do-estorno'); // display_name do login

    // Auditado: o gesto tem trilha central.
    const trilha = getConnection()
      .prepare(
        `SELECT action, entity_id, user_id FROM core_audit_log
          WHERE company_id = ? AND action = 'purchase.note.estorno'`,
      )
      .all(companyId) as unknown as Record<string, unknown>[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].entity_id).toBe(noteId);
    expect(trilha[0].user_id).toBe(gerenteId);
  });

  /*
    ==========================================================================
    O ESTORNO TEM NOME PRÓPRIO NO RAZÃO — e ele se chamava "Saída manual"
    ==========================================================================

    A perna de saída já nascia com referência PRÓPRIA ('estorno_entrada'), que
    é o que deduplica o segundo clique. O `kind`, porém, foi emprestado:
    'MANUAL_EXIT', rotulado "Saída manual" na tela de Movimentações.

    Quem abre o histórico do produto seis meses depois lê "Saída manual -10" e
    entende mercadoria que saiu da prateleira — perda, consumo interno, brinde.
    O que aconteceu foi o contrário: a mercadoria NUNCA entrou, porque a
    entrada que a trouxe foi desfeita. As duas leituras levam a decisões
    opostas na hora de repor. E o filtro por tipo não ajuda: escolher "Saída
    manual" traz os estornos junto com as perdas, e não há como separá-los sem
    abrir o banco.

    COMO ELE FALHA: trocar `kind: 'ENTRY_REVERSAL'` de volta por 'MANUAL_EXIT'
    em `estornarNota` deixa este caso vermelho no kind e no rótulo.
  */
  it('a perna de saída se declara ESTORNO DE ENTRADA, não saída manual', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    await estornar(noteId);

    const movs = movimentos(noteId);
    expect(movs).toHaveLength(2);
    expect(movs[1].kind).toBe('ENTRY_REVERSAL');
    expect(movs[1].kind).not.toBe('MANUAL_EXIT');

    // O rótulo é o que a tela mostra, e ele diz o fato inteiro.
    const daTela = listMovements(companyId, { productId: pastilha });
    expect(daTela[0].kind_label).toBe('Estorno de entrada');

    /*
      E o filtro separa: o estorno tem balde próprio, e o balde de "Saída
      manual" — onde moram perda e consumo interno — não o contém mais.
    */
    expect(listMovements(companyId, { kind: 'ENTRY_REVERSAL' })).toHaveLength(1);
    expect(listMovements(companyId, { kind: 'MANUAL_EXIT' })).toHaveLength(0);
  });

  it('o histórico do fornecedor PARA de contar a compra estornada', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    const fornecedorId = String(nota(noteId).supplier_id);

    await estornar(noteId);

    const ficha = await request(app).get(`/api/v1/core/suppliers/${fornecedorId}`).set(auth);
    expect(ficha.status).toBe(200);
    expect(ficha.body.history.noteCount).toBe(0);
    expect(ficha.body.history.totalCents).toBe(0);
  });

  /*
    ==========================================================================
    A FICHA DO FORNECEDOR COBRAVA DÍVIDA CANCELADA
    ==========================================================================

    O DEFEITO: `supplierPurchaseHistory` somava `openPayableCents` sem
    `cancelled_at IS NULL`, enquanto TODO o resto do financeiro filtra
    cancelado. O estorno carimba `status='cancelled', cancelled_at=?` na dívida
    SEM mexer em `amount_cents` nem em `settled_cents` — de propósito, porque a
    dívida existiu e o histórico conta os dois fatos. Resultado: na MESMA tela
    em que `noteCount` e `totalCents` iam a zero, o cartão "Em aberto"
    continuava exibindo o valor estornado como devido.

    E o número não era só feio: é ele que responde "quanto ainda devo a este
    fornecedor" antes de autorizar a próxima compra.
  */
  it('e PARA de cobrar a dívida cancelada pelo estorno', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    const fornecedorId = String(nota(noteId).supplier_id);

    const antes = await request(app).get(`/api/v1/core/suppliers/${fornecedorId}`).set(auth);
    // A dívida da nota existe e é devida ANTES do estorno — senão o caso
    // ficaria verde por não ter o que somar.
    expect(antes.body.history.openPayableCents).toBe(25000);

    await estornar(noteId);

    const depois = await request(app).get(`/api/v1/core/suppliers/${fornecedorId}`).set(auth);
    expect(depois.body.history.openPayableCents).toBe(0);

    // E a dívida continua LÁ, cancelada: o estorno não apaga o passado.
    const divida = getConnection()
      .prepare(
        `SELECT amount_cents, settled_cents, cancelled_at FROM core_finance_entries
          WHERE origin_id = ? AND direction = 'out'`,
      )
      .get(noteId) as Record<string, unknown>;
    expect(Number(divida.amount_cents)).toBe(25000);
    expect(divida.cancelled_at).toBeTruthy();
  });

  it('estornar DUAS vezes não desce o estoque duas vezes — idempotente', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);

    await estornar(noteId);
    const denovo = await estornar(noteId);
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(200);
    expect(denovo.body.alreadyReversed).toBe(true);

    expect(saldo(pastilha)).toBe(0); // e não -10
    // Um único movimento de estorno no razão.
    const saidas = movimentos(noteId).filter((m) => m.movement_type === 'out');
    expect(saidas).toHaveLength(1);
  });
});

// ============================================================== O PEDIDO

describe('o pedido amarrado volta ao retrato real', () => {
  it("pedido 'recebido' pela nota estornada volta a 'enviado' com received_quantity 0", async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Estornável');

    const pedido = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    const orderId = pedido.body.id as string;
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/send`).set(auth).send({});

    // A entrada manual atende o pedido: mesmo fornecedor, mesmo produto.
    const criada = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    const noteId = criada.body.noteId as string;
    await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${noteId}`)
      .set(auth)
      .send({});
    await request(app).post(`/api/v1/core/purchases/notes/${noteId}/confirm`).set(auth).send({});

    const antes = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(auth);
    expect(antes.body.status).toBe('recebido');

    await estornar(noteId);

    const depois = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(auth);
    expect(depois.body.status).toBe('enviado');
    expect(depois.body.items[0].received_quantity).toBe(0);
  });
});

// ============================================================== AS RECUSAS

describe('o que o estorno recusa — e por quê', () => {
  it('dívida JÁ BAIXADA: 409 mandando estornar a baixa primeiro — e NADA muda', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);

    // O financeiro dá baixa na conta (pagou o fornecedor).
    const contaId = String(divida(noteId)!.id);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${contaId}/settle`)
      .set(auth)
      .send({ amountCents: 25_000 });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);

    const res = await estornar(noteId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_NOTE_ENTRY_SETTLED');

    // Nada mudou: dinheiro pago não some por decreto.
    expect(saldo(pastilha)).toBe(10);
    expect(nota(noteId).status).toBe('recebida');
    expect(divida(noteId)?.cancelled_at).toBeNull();
  });

  it('mercadoria que JÁ SAIU: 409 nomeando o produto — o caminho é o ajuste com motivo', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);

    // 4 unidades saíram (venda, perda — tanto faz: o saldo não cobre mais).
    applyMovement({
      companyId,
      productId: pastilha,
      movementType: 'out',
      quantity: 4,
      referenceType: 'ajuste_teste',
      referenceId: 'saida-antes-do-estorno',
      reason: 'saída entre a entrada e o estorno',
    });

    const res = await estornar(noteId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe('CORE_ESTORNO_INSUFFICIENT_STOCK');
    expect(String(res.body.error?.message)).toContain('Pastilha Estornável');

    // Nota inteira ou nota nenhuma: nada foi revertido pela metade.
    expect(saldo(pastilha)).toBe(6);
    expect(nota(noteId).status).toBe('recebida');
    expect(divida(noteId)?.status).toBe('open');
  });

  it('nota ainda em conferência: 409 — só entrada confirmada tem o que estornar', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Estornável');
    const criada = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    const res = await estornar(criada.body.noteId as string);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it('sem motivo não há estorno: 400', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    const res = await estornar(noteId, '');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(nota(noteId).status).toBe('recebida');
  });

  it('estoquista não estorna: 403 — desfazer entrada confirmada é ato de gerência', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);
    const estoquista = await loginForTest(app, {
      userId: 'estoquista-do-estorno',
      companyId: 'loja-do-estorno',
      profileCodes: ['estoquista'],
    });
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/estornar`)
      .set({ Authorization: `Bearer ${estoquista.body.accessToken}` })
      .send({ reason: 'tentativa sem alçada' });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(nota(noteId).status).toBe('recebida');
  });

  it('a nota da vizinha não se estorna daqui: 404, nada muda', async () => {
    const pastilha = await produto('Pastilha Estornável');
    const noteId = await entradaConfirmada(pastilha, 10, 2500);

    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha-estorno',
      companyId: 'vizinha-do-estorno',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/estornar`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ reason: 'não é minha nota' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(nota(noteId).status).toBe('recebida');
    expect(saldo(pastilha)).toBe(10);
  });
});

// ==================================================== O DOCUMENTO MORTO

describe('nota estornada é documento morto', () => {
  it('não se confere, não se reconfirma, não se amarra a pedido', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Estornável');
    const criada = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    const noteId = criada.body.noteId as string;
    await request(app).post(`/api/v1/core/purchases/notes/${noteId}/confirm`).set(auth).send({});
    await estornar(noteId);

    const conferir = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, receivedQuantity: 5 });
    expect(conferir.status, JSON.stringify(conferir.body)).toBe(409);

    // Reconfirmar uma nota estornada ressuscitaria o documento em silêncio:
    // o movimento seria deduplicado (nada entra), a dívida cancelada ficaria
    // como está, e o status voltaria a 'recebida' — um zumbi. Recusa nomeada.
    const reconfirmar = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
      .set(auth)
      .send({});
    expect(reconfirmar.status, JSON.stringify(reconfirmar.body)).toBe(409);
    expect(nota(noteId).status).toBe('estornada');
    expect(saldo(pastilha)).toBe(0);

    const pedido = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    const amarrar = await request(app)
      .post(`/api/v1/core/purchase-orders/${pedido.body.id}/notes/${noteId}`)
      .set(auth)
      .send({});
    expect(amarrar.status, JSON.stringify(amarrar.body)).toBe(409);
  });
});

// ============================================================ TAMBÉM NA NF-e

describe('o estorno vale para a nota de XML do mesmo jeito', () => {
  it('importa, confirma, estorna: estoque zerado, dívida cancelada, nota estornada', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe35260814200166000187550010000099910001099910" versao="4.00">
      <ide><nNF>9991</nNF><serie>1</serie><dhEmi>2026-08-20T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>${CNPJ}</CNPJ><xNome>Distribuidora do Estorno Ltda</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>EST-1</cProd><cEAN>SEM GTIN</cEAN>
          <xProd>Pastilha Estornável</xProd><NCM>87141000</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>10</qCom><vUnCom>25.00</vUnCom><vProd>250.00</vProd>
          <uTrib>UN</uTrib><qTrib>10</qTrib>
        </prod>
      </det>
      <total><ICMSTot><vNF>250.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
    await fornecedor();
    const pastilha = await produto('Pastilha Estornável');

    const imp = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const noteId = imp.body.noteId as string;
    await request(app).post(`/api/v1/core/purchases/notes/${noteId}/confirm`).set(auth).send({});
    expect(saldo(pastilha)).toBe(10);

    const res = await estornar(noteId, 'Arquivo da outra empresa do grupo');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(saldo(pastilha)).toBe(0);
    expect(nota(noteId).status).toBe('estornada');
    expect(divida(noteId)?.status).toBe('cancelled');
  });
});
