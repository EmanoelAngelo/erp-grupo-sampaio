/**
 * ============================================================================
 * AUDITORIA FASE 5 — COMPRAS PONTA A PONTA
 * ============================================================================
 *
 * A regra da casa, escrita em PurchaseOrderService: o pedido é COMPROMISSO e a
 * nota é FATO. O pedido não movimenta estoque; quem dá entrada é o caminho
 * IMPORTAR → CONFERIR → CONFIRMAR da NF-e, e a conciliação pedido×nota é feita
 * por `POST /purchase-orders/:id/notes/:noteId` (linkNoteToOrder), que
 * recalcula o recebido a partir das notas CONFIRMADAS.
 *
 * Este arquivo atravessa o fluxo INTEIRO por HTTP, com asserções matemáticas:
 * fornecedor → pedido com 2 itens e custos exatos → envio → NF-e parcial
 * (metade de um item) → estoque só com o recebido → segunda nota → estoque
 * completo → contas a pagar no valor exato de CADA NOTA (a regra da casa: a
 * dívida nasce da nota, não do pedido — provada e afirmada aqui) → histórico
 * do fornecedor fechando com o total do pedido.
 *
 * O QUE A AUDITORIA ENCONTROU — e esta rodada CONSERTOU. Cada caso abaixo
 * cobra o comportamento CERTO e volta a ficar vermelho se ele regredir:
 *
 *  1. A ordem natural quebrava o pedido para sempre. A rota de amarrar aceita
 *     "uma nota já importada" (é o comentário dela), ou seja, em conferência.
 *     Quem amarrava na chegada e confirmava depois ficava com estoque e
 *     financeiro andando e o pedido parado em "enviado" com received_quantity
 *     0 — `confirmNfe` não reprojetava pedido nenhum. Agora reprojeta: o caso
 *     "amarrar na chegada..." cobra o pedido andando junto da confirmação.
 *
 *  2. O retrato do recebimento no pedido usava a quantidade FATURADA da nota
 *     (`core_inbound_note_items.quantity`), não a CONFERIDA
 *     (`received_quantity`). A doca contava 8 de 10, o estoque entrava com 8 —
 *     e o pedido afirmava "recebido 10 de 10". `recalcReceived` agora soma o
 *     CONFERIDO (COALESCE: nota sem conferência vale o faturado, a mesma
 *     régua de `confirmNfe`), e a divergência aparece no pedido.
 *
 *  3. Re-amarrar a nota a OUTRO pedido roubava a nota sem reprojetar o pedido
 *     que a perdeu: o antigo ficava com received_quantity e status velhos e a
 *     lista de notas vazia. `linkNoteToOrder` agora recalcula ORIGEM e
 *     destino.
 *
 *  4. Pedido CANCELADO aceitava nota amarrada, e o recalc gravava
 *     received_quantity no item de um pedido morto. A amarração agora recusa
 *     com 409 e CORE_PURCHASE_ORDER_CANCELLED.
 *
 *  5. Da auditoria anterior (P3, linkNoteToPurchaseOrder sem chamador): a
 *     rota sempre EXISTIU no servidor e a função no cliente — mas nenhuma
 *     tela a chamava, e a conciliação inteira era inalcançável pela
 *     interface; na prática, pedido real nunca saía de "enviado". FECHADO na
 *     rodada P1.2: a tela é src/pages/gs/ConciliacaoRecebimentoPage.tsx
 *     (menu Compras › Conciliação de recebimento), provada por
 *     ConciliacaoRecebimentoPage.test.tsx e conciliacaoPorta.test.tsx no
 *     navegador. Os casos de servidor que ELA lê e que ainda não tinham dono
 *     estão no fim deste arquivo — ver o bloco "o que a tela de conciliação
 *     lê".
 *
 * O que NÃO está aqui por já ter dono (sem duplicar):
 *  - pedido não movimenta estoque .............. tests/compras.test.ts
 *  - fornecedor inativo não recebe pedido ...... tests/compras.test.ts
 *  - confirmar 2x não dobra estoque (rota) ..... tests/nfe-import.test.ts
 *  - reimportar o mesmo XML não duplica ........ tests/nfe-import.test.ts
 *  - confirmar 2x não cria 2 dívidas ........... tests/nfe-conferencia-financeiro.test.ts
 *  - dívida = valor da NOTA mesmo chegando menos tests/nfe-conferencia-financeiro.test.ts
 *    (aqui ela é reafirmada DENTRO do fluxo com pedido, que nenhum teste fazia)
 *
 * Etapa de APROVAÇÃO: não existe na casa. O que existe é enviar (rascunho →
 * enviado), e depois de enviado o combinado é o combinado. Registrado como
 * não aplicável.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

/** CNPJ do <emit> das notas — o MESMO documento do fornecedor cadastrado, para
 *  a importação reaproveitar o cadastro em vez de criar um segundo. */
const CNPJ_FORNECEDOR = '14200166000187';

let auth: { Authorization: string };
let companyId: string;
/** O id REAL do usuário (o login de teste gera UUID) — é ele que a trilha grava. */
let auditorId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'auditor-compras',
    companyId: 'auditoria-compras',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  auditorId = res.body.user.id;
});

// ---------------------------------------------------------------- helpers

async function fornecedor(over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    .send({
      name: 'Distribuidora Auditada Ltda',
      document: CNPJ_FORNECEDOR,
      paymentTermDays: 0,
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function produto(nome: string, preco: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: preco });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Saldo direto da tabela: zero é "linha ausente" e a lista da API omite. */
function saldo(productId: string): number {
  const row = getConnection()
    .prepare(
      'SELECT COALESCE(quantity, 0) AS q FROM core_stock WHERE company_id = ? AND product_id = ?',
    )
    .get(companyId, productId) as { q: number } | undefined;
  return row?.q ?? 0;
}

async function contasAPagar(): Promise<Record<string, unknown>[]> {
  const res = await request(app)
    .get('/api/v1/core/finance/entries?direction=out')
    .set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Record<string, unknown>[];
}

/**
 * A amarração dívida→nota (origin_id) NÃO sai pela API — `toEntry` não expõe
 * o campo. A conferência da origem exata vai direto ao banco, como
 * tests/nfe-conferencia-financeiro.test.ts também faz.
 */
function dividasNoBanco(): { amount_cents: number; origin_type: string; origin_id: string }[] {
  return getConnection()
    .prepare(
      `SELECT amount_cents, origin_type, origin_id
         FROM core_finance_entries WHERE company_id = ? AND direction = 'out'`,
    )
    .all(companyId) as unknown as { amount_cents: number; origin_type: string; origin_id: string }[];
}

/**
 * NF-e mínima e válida para o parser da casa, itens casando com o catálogo
 * por NOME (cEAN "SEM GTIN" pula o código de barras de propósito).
 * A chave varia só no fim: 44 dígitos sempre.
 */
function xmlNota(input: {
  sufixoChave: string; // 4 dígitos
  numero: string;
  itens: { nome: string; qtd: number; vUnit: string; vTotal: string }[];
  vNF: string;
}): string {
  const chave = `3526081420016600018755001000001024100001${input.sufixoChave}`;
  const dets = input.itens
    .map(
      (i, idx) => `      <det nItem="${idx + 1}">
        <prod>
          <cProd>AUD-${idx + 1}</cProd><cEAN>SEM GTIN</cEAN>
          <xProd>${i.nome}</xProd><NCM>87141000</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>${i.qtd}</qCom><vUnCom>${i.vUnit}</vUnCom><vProd>${i.vTotal}</vProd>
          <uTrib>UN</uTrib><qTrib>${i.qtd}</qTrib>
        </prod>
      </det>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide><nNF>${input.numero}</nNF><serie>1</serie><dhEmi>2026-08-20T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>${CNPJ_FORNECEDOR}</CNPJ><xNome>Distribuidora Auditada Ltda</xNome></emit>
${dets}
      <total><ICMSTot><vNF>${input.vNF}</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function importar(xml: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({ xml });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.noteId as string;
}

async function conferir(noteId: string, itemIndex: number, receivedQuantity: number, nota?: string) {
  const res = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
    .set(auth)
    .send({ itemIndex, receivedQuantity, divergenceNote: nota });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function confirmar(noteId: string) {
  const res = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function amarrar(orderId: string, noteId: string) {
  const res = await request(app)
    .post(`/api/v1/core/purchase-orders/${orderId}/notes/${noteId}`)
    .set(auth)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function verPedido(orderId: string) {
  const res = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

interface Cenario {
  supplierId: string;
  pastilha: string;
  cabo: string;
  orderId: string;
}

/** Pedido enviado: Pastilha 10 × R$25,00 + Cabo 6 × R$10,00 = R$310,00. */
async function pedidoEnviado(): Promise<Cenario> {
  const f = await fornecedor();
  const pastilha = await produto('Pastilha Auditada', 9900);
  const cabo = await produto('Cabo Auditado', 4900);

  const criado = await request(app)
    .post('/api/v1/core/purchase-orders')
    .set(auth)
    .send({
      supplierId: f.id,
      items: [
        { productId: pastilha, quantity: 10, unitCostCents: 2500 },
        { productId: cabo, quantity: 6, unitCostCents: 1000 },
      ],
    });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  // O compromisso é exato: 10×2500 + 6×1000.
  expect(criado.body.total_cents).toBe(31_000);

  const enviado = await request(app)
    .post(`/api/v1/core/purchase-orders/${criado.body.id}/send`)
    .set(auth)
    .send({});
  expect(enviado.status).toBe(200);
  expect(enviado.body.status).toBe('enviado');

  return { supplierId: f.id, pastilha, cabo, orderId: criado.body.id as string };
}

// ================================================================== FLUXO

describe('o fluxo inteiro: pedido, duas notas, estoque, financeiro e o histórico', () => {
  it('metade da pastilha chega primeiro; o estoque só sobe o recebido; a dívida é a de cada NOTA; o resto completa o pedido', async () => {
    const { supplierId, pastilha, cabo, orderId } = await pedidoEnviado();

    // Nada aconteceu ainda: pedido é compromisso, não entrada.
    expect(saldo(pastilha)).toBe(0);
    expect(saldo(cabo)).toBe(0);
    expect(await contasAPagar()).toHaveLength(0);

    // ---- NOTA 1: o fornecedor manda METADE da pastilha (5 de 10) e nada do cabo.
    const nota1 = await importar(
      xmlNota({
        sufixoChave: '1001',
        numero: '1001',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    const r1 = await confirmar(nota1);
    expect(r1.movedItems).toBe(1);
    expect(r1.createdProducts).toBe(0); // casou com o catálogo, não duplicou produto

    // O estoque reflete SÓ o que veio: 5 pastilhas, cabo intacto.
    expect(saldo(pastilha)).toBe(5);
    expect(saldo(cabo)).toBe(0);

    // A REGRA DA CASA, afirmada: a dívida nasce POR NOTA e no valor DA NOTA
    // (não do pedido, não do que ainda vai chegar): 5 × R$25,00 = R$125,00.
    const contas1 = await contasAPagar();
    expect(contas1).toHaveLength(1);
    expect(contas1[0].amountCents).toBe(12_500);
    expect(contas1[0].status).toBe('open');
    expect(contas1[0].originType).toBe('nfe_entrada');
    // A amarração exata dívida→nota, no banco (a API não expõe origin_id).
    const noBanco1 = dividasNoBanco();
    expect(noBanco1).toHaveLength(1);
    expect(noBanco1[0].origin_id).toBe(nota1);

    // Amarrada ao pedido, a nota confirmada vira recebimento PARCIAL.
    const depois1 = await amarrar(orderId, nota1);
    expect(depois1.status).toBe('recebido_parcial');
    const detalhe1 = await verPedido(orderId);
    const itemPastilha1 = detalhe1.items.find((i: { product_id: string }) => i.product_id === pastilha);
    const itemCabo1 = detalhe1.items.find((i: { product_id: string }) => i.product_id === cabo);
    expect(itemPastilha1.received_quantity).toBe(5);
    expect(itemCabo1.received_quantity).toBe(0);

    // ---- NOTA 2: o restante — 5 pastilhas + 6 cabos = R$185,00.
    const nota2 = await importar(
      xmlNota({
        sufixoChave: '1002',
        numero: '1002',
        itens: [
          { nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' },
          { nome: 'Cabo Auditado', qtd: 6, vUnit: '10.00', vTotal: '60.00' },
        ],
        vNF: '185.00',
      }),
    );
    await confirmar(nota2);

    // Estoque completo, na conta exata do pedido.
    expect(saldo(pastilha)).toBe(10);
    expect(saldo(cabo)).toBe(6);

    // Segunda dívida, no valor da segunda nota. E a soma das notas fecha com o
    // total do pedido — porque tudo chegou como faturado.
    const contas2 = await contasAPagar();
    expect(contas2).toHaveLength(2);
    const soma = contas2.reduce((acc, c) => acc + Number(c.amountCents), 0);
    expect(soma).toBe(31_000);
    const daNota2 = dividasNoBanco().find((c) => c.origin_id === nota2);
    expect(daNota2?.amount_cents).toBe(18_500);

    // Pedido fecha: recebido, item a item.
    const depois2 = await amarrar(orderId, nota2);
    expect(depois2.status).toBe('recebido');
    const detalhe2 = await verPedido(orderId);
    const itemPastilha2 = detalhe2.items.find((i: { product_id: string }) => i.product_id === pastilha);
    const itemCabo2 = detalhe2.items.find((i: { product_id: string }) => i.product_id === cabo);
    expect(itemPastilha2.received_quantity).toBe(10);
    expect(itemCabo2.received_quantity).toBe(6);
    expect(detalhe2.inboundNotes).toHaveLength(2);

    // Consulta posterior: a lista filtrada enxerga o pedido no estado final.
    const lista = await request(app)
      .get('/api/v1/core/purchase-orders?status=recebido')
      .set(auth);
    expect(lista.body.items.map((o: { id: string }) => o.id)).toContain(orderId);

    // Relatório relacionado: o histórico do fornecedor soma as DUAS notas
    // recebidas — e fecha com o mesmo total do pedido.
    const detFornecedor = await request(app)
      .get(`/api/v1/core/suppliers/${supplierId}`)
      .set(auth);
    expect(detFornecedor.status).toBe(200);
    expect(detFornecedor.body.history.noteCount).toBe(2);
    expect(detFornecedor.body.history.totalCents).toBe(31_000);
  });
});

// ============================================================= DIVERGÊNCIA

describe('unidade da nota ≠ unidade do cadastro: o fator de conversão vale no pedido', () => {
  /*
    Fornecedor que fatura em CAIXA num pedido feito em UNIDADE: confirmNfe já
    multiplicava o fator para o ESTOQUE, mas recalcReceived comparava a
    quantidade da nota crua com a do pedido — 2 caixas contra 24 unidades, e o
    pedido afirmaria "faltam 22" com a prateleira cheia. A soma do recebido
    passou a multiplicar COALESCE(conversion_factor, 1).

    O fator aqui é plantado por SQL: na interface ele nasce no casamento
    item-da-nota × produto (EntradaNotasPage), etapa que este caso não precisa
    reencenar para provar a conta.
  */
  it('nota de 2 CX (fator 12) satisfaz o pedido de 24 UN — recebido 24, status recebido', async () => {
    const f = await fornecedor();
    const parafuso = await produto('Parafuso Auditado', 500);

    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: parafuso, quantity: 24, unitCostCents: 100 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const orderId = criado.body.id as string;
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/send`).set(auth).send({});

    const nota = await importar(xmlNota({
      sufixoChave: '7712',
      numero: '7712',
      itens: [{ nome: 'Parafuso Auditado', qtd: 2, vUnit: '12.00', vTotal: '24.00' }],
      vNF: '24.00',
    }));
    getConnection()
      .prepare('UPDATE core_inbound_note_items SET conversion_factor = 12 WHERE note_id = ?')
      .run(nota);

    await confirmar(nota);
    await amarrar(orderId, nota);

    const pedido = await verPedido(orderId);
    expect(pedido.status).toBe('recebido');
    expect((pedido.items as { received_quantity: number }[])[0].received_quantity).toBe(24);
    // E a prateleira conta a MESMA história que o pedido:
    expect(saldo(parafuso)).toBe(24);
  });
});

describe('divergência: a doca conta menos do que a nota fatura', () => {
  it('estoque entra com 8, a dívida é a da nota (10) — e o PEDIDO afirma os 8 da doca: a divergência aparece no retrato do pedido', async () => {
    // Pedido de UM item só, para isolar o que este caso mede: é o CONFERIDO
    // que dita o recebido e o status do pedido — num pedido de dois itens, o
    // cabo ausente também seguraria o status em parcial e não daria para
    // saber QUAL das duas faltas o segurou.
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Auditada', 9900);
    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const orderId = criado.body.id as string;
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/send`).set(auth).send({});

    // A nota fatura as 10 pastilhas; a doca conta 8.
    const nota = await importar(
      xmlNota({
        sufixoChave: '1003',
        numero: '1003',
        itens: [{ nome: 'Pastilha Auditada', qtd: 10, vUnit: '25.00', vTotal: '250.00' }],
        vNF: '250.00',
      }),
    );
    await conferir(nota, 0, 8, 'Duas caixas não desceram do caminhão');
    const r = await confirmar(nota);
    expect(r.divergentItems).toBe(1);

    // A prateleira: 8. A dívida: a da NOTA, 10 × 25,00 — negociar abatimento é
    // conversa de gente. As duas pontas já têm dono em
    // tests/nfe-conferencia-financeiro.test.ts; aqui elas ancoram o que vem.
    expect(saldo(pastilha)).toBe(8);
    const contas = await contasAPagar();
    expect(contas).toHaveLength(1);
    expect(contas[0].amountCents).toBe(25_000);

    // O CONSERTO desta auditoria: `recalcReceived` soma `received_quantity`
    // (o CONFERIDO), não mais `quantity` (o FATURADO). O pedido diz "8 de
    // 10, recebido em parte" — o comprador vê a falta olhando para o pedido,
    // que é exatamente para isso que a comparação pedido×nota existe.
    const depois = await amarrar(orderId, nota);
    expect(depois.status).toBe('recebido_parcial');
    const detalhe = await verPedido(orderId);
    const item = detalhe.items.find((i: { product_id: string }) => i.product_id === pastilha);
    expect(item.received_quantity).toBe(8); // os 8 da doca — NÃO o faturado
    // O pedido e a prateleira contam a MESMA história…
    expect(item.received_quantity - saldo(pastilha)).toBe(0);
    // …e a divergência contra o combinado fica visível: faltam 2 de 10.
    expect(item.quantity - item.received_quantity).toBe(2);
  });
});

// ========================================================= A ORDEM NATURAL

describe('a ordem natural da doca: amarrar na chegada, conferir, confirmar', () => {
  /*
    Este caso ficou VERMELHO até esta rodada — era defeito real de produção.

    A rota de amarrar se descreve como "amarra uma nota já importada ao pedido
    que ela atende" — nota em CONFERÊNCIA, portanto. É a ordem natural: o
    caminhão chega, a nota entra, alguém a amarra ao pedido que ela atende, a
    doca confere, o gerente confirma.

    Só que `confirmNfe` não reprojetava pedido nenhum, e nada mais reprojetava.
    Resultado: estoque subia, contas a pagar nascia, e o pedido ficava
    "enviado" com received_quantity 0 PARA SEMPRE — o comprador achava que
    nada veio e pedia de novo.

    Agora `confirmNfe` chama o recálculo do pedido amarrado, e a asserção
    cobra o desfecho inteiro: nota que atende o pedido todo, confirmada,
    fecha o pedido em 'recebido'.
  */
  it('confirmada a nota JÁ amarrada, o pedido tem de refletir o recebimento', async () => {
    const { pastilha, cabo, orderId } = await pedidoEnviado();

    // A nota atende o pedido INTEIRO: 10 pastilhas + 6 cabos = R$310,00.
    const nota = await importar(
      xmlNota({
        sufixoChave: '1004',
        numero: '1004',
        itens: [
          { nome: 'Pastilha Auditada', qtd: 10, vUnit: '25.00', vTotal: '250.00' },
          { nome: 'Cabo Auditado', qtd: 6, vUnit: '10.00', vTotal: '60.00' },
        ],
        vNF: '310.00',
      }),
    );

    // Amarra NA CHEGADA — a rota aceita (nota em conferência), e é para aceitar.
    const aoAmarrar = await amarrar(orderId, nota);
    // Nota ainda não confirmada não conta — até aqui, tudo coerente.
    expect(aoAmarrar.status).toBe('enviado');

    // A doca confere tudo, o gerente confirma: estoque e financeiro andam.
    await conferir(nota, 0, 10);
    await conferir(nota, 1, 6);
    await confirmar(nota);
    expect(saldo(pastilha)).toBe(10);
    expect(saldo(cabo)).toBe(6);
    expect(await contasAPagar()).toHaveLength(1);

    // E o pedido anda JUNTO: a nota amarrada a ele acabou de ser confirmada.
    const detalhe = await verPedido(orderId);
    const itemPastilha = detalhe.items.find((i: { product_id: string }) => i.product_id === pastilha);
    const itemCabo = detalhe.items.find((i: { product_id: string }) => i.product_id === cabo);
    expect(
      detalhe.status,
      'estoque e financeiro andaram — o pedido tem de andar junto: confirmNfe reprojeta a nota amarrada',
    ).toBe('recebido');
    expect(itemPastilha.received_quantity).toBe(10);
    expect(itemCabo.received_quantity).toBe(6);
  });
});

// ============================================================ CANCELAMENTO

describe('cancelamento de pedido não recebido', () => {
  it('cancela com motivo — e estoque e financeiro ficam matematicamente intactos', async () => {
    const { pastilha, cabo, orderId } = await pedidoEnviado();

    const res = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/cancel`)
      .set(auth)
      .send({ reason: 'Fornecedor perdeu o prazo' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');

    // Nada nasceu de um compromisso desfeito: prateleira zerada, dívida nenhuma.
    expect(saldo(pastilha)).toBe(0);
    expect(saldo(cabo)).toBe(0);
    expect(await contasAPagar()).toHaveLength(0);

    const lista = await request(app)
      .get('/api/v1/core/purchase-orders?status=cancelado')
      .set(auth);
    expect(lista.body.items.map((o: { id: string }) => o.id)).toContain(orderId);
  });

  it('pedido cancelado NÃO aceita nota amarrada: 409, e nada é gravado nos itens dele', async () => {
    /*
      A guarda que faltava em `linkNoteToOrder` (achado da auditoria): a
      mercadoria que chegou para um pedido já cancelado era amarrada sem
      aviso, o recalc gravava received_quantity no item do pedido cancelado, e
      só o status não andava (o recalc pula 'cancelado'). Um pedido morto com
      "recebido 5" dentro é um retrato que ninguém decidiu. Agora a amarração
      recusa com erro nomeado — e a entrada da mercadoria, que é FATO, segue
      valendo pela nota, sem pedido.
    */
    const { pastilha, orderId } = await pedidoEnviado();
    await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/cancel`)
      .set(auth)
      .send({ reason: 'Cancelado antes da entrega' });

    const nota = await importar(
      xmlNota({
        sufixoChave: '1006',
        numero: '1006',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    await confirmar(nota);

    const recusa = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`)
      .set(auth)
      .send({});
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(409);
    expect(recusa.body.error?.code).toBe('CORE_PURCHASE_ORDER_CANCELLED');

    // O estoque da nota confirmada NÃO é desfeito pela recusa — a entrada é
    // fato; o que não existe é amarração com compromisso desfeito.
    expect(saldo(pastilha)).toBe(5);
    const detalhe = await verPedido(orderId);
    expect(detalhe.status).toBe('cancelado');
    expect(detalhe.inboundNotes).toHaveLength(0);
    const item = detalhe.items.find((i: { product_id: string }) => i.product_id === pastilha);
    expect(item.received_quantity).toBe(0);
  });
});

// =========================================================== FALSIFICAÇÕES

describe('falsificações: o que não pode entrar, não entra', () => {
  it('custo negativo é recusado com 400 — e nenhum pedido fica no banco', async () => {
    const f = await fornecedor();
    const p = await produto('Pastilha Auditada', 9900);

    const res = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 10, unitCostCents: -100 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error?.code).toBe('CORE_PURCHASE_ORDER_INVALID');

    // A criação é transacional: o cabeçalho não pode sobreviver ao item podre.
    const lista = await request(app).get('/api/v1/core/purchase-orders').set(auth);
    expect(lista.body.items).toHaveLength(0);
  });

  it('quantidade zero e quantidade negativa também são recusadas', async () => {
    const f = await fornecedor();
    const p = await produto('Pastilha Auditada', 9900);
    for (const quantity of [0, -5]) {
      const res = await request(app)
        .post('/api/v1/core/purchase-orders')
        .set(auth)
        .send({ supplierId: f.id, items: [{ productId: p, quantity, unitCostCents: 1000 }] });
      expect(res.status, `quantity=${quantity}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it('amarrar a MESMA nota duas vezes não dobra o recebido', async () => {
    const { pastilha, orderId } = await pedidoEnviado();
    const nota = await importar(
      xmlNota({
        sufixoChave: '1005',
        numero: '1005',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    await confirmar(nota);

    await amarrar(orderId, nota);
    const denovo = await amarrar(orderId, nota);

    // O recalc recomputa do zero em vez de somar — 5, e não 10.
    expect(denovo.status).toBe('recebido_parcial');
    const detalhe = await verPedido(orderId);
    const item = detalhe.items.find((i: { product_id: string }) => i.product_id === pastilha);
    expect(item.received_quantity).toBe(5);
    expect(detalhe.inboundNotes).toHaveLength(1);
  });

  it('amarrar a nota em OUTRO pedido reprojeta também o pedido que a perdeu', async () => {
    /*
      `linkNoteToOrder` sobrescrevia `purchase_order_id` e reprojetava SÓ o
      pedido que ganhou a nota. O que a perdeu ficava como estava: status
      'recebido_parcial' e received_quantity 5, com a lista de notas VAZIA —
      um recebimento afirmado sem nenhuma nota que o sustente. Consertado:
      o serviço recalcula ORIGEM e destino, e as asserções abaixo cobram o
      pedido órfão voltando ao retrato real.
    */
    const cenario = await pedidoEnviado();

    // Segundo pedido do MESMO fornecedor e produto.
    const segundo = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({
        supplierId: cenario.supplierId,
        items: [{ productId: cenario.pastilha, quantity: 10, unitCostCents: 2500 }],
      });
    expect(segundo.status).toBe(201);
    await request(app)
      .post(`/api/v1/core/purchase-orders/${segundo.body.id}/send`)
      .set(auth)
      .send({});

    const nota = await importar(
      xmlNota({
        sufixoChave: '1007',
        numero: '1007',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    await confirmar(nota);

    const doPrimeiro = await amarrar(cenario.orderId, nota);
    expect(doPrimeiro.status).toBe('recebido_parcial');

    // A nota muda de dono…
    const doSegundo = await amarrar(segundo.body.id, nota);
    expect(doSegundo.status).toBe('recebido_parcial');
    const detalheSegundo = await verPedido(segundo.body.id);
    expect(detalheSegundo.inboundNotes).toHaveLength(1);

    // …e o primeiro volta ao retrato REAL: sem nota, sem recebido, de volta
    // a 'enviado' — nada de recebimento afirmado sem nota que o sustente.
    const detalhePrimeiro = await verPedido(cenario.orderId);
    expect(detalhePrimeiro.inboundNotes).toHaveLength(0);
    expect(detalhePrimeiro.status).toBe('enviado');
    const item = detalhePrimeiro.items.find(
      (i: { product_id: string }) => i.product_id === cenario.pastilha,
    );
    expect(item.received_quantity).toBe(0);
  });
});

// ============================================ O QUE A TELA DE CONCILIAÇÃO LÊ
//
// Rodada P1.2: a tela de conciliação (ConciliacaoRecebimentoPage) nasceu, e o
// mapa abaixo diz de onde vem cada garantia que ela projeta — para não
// duplicar dono:
//
//  - 10 pedidos / 10 faturados / 10 conferidos → 'recebido' ... "a ordem
//    natural da doca" (este arquivo);
//  - entrega parcial (5 de 10) → 'recebido_parcial' ........... "o fluxo
//    inteiro" (este arquivo) e compras.test.ts ("nota parcial deixa o pedido
//    em recebido_parcial");
//  - doca conta 8 do faturado 10 → a divergência no pedido .... "divergência:
//    a doca conta menos" (este arquivo);
//  - fator de conversão (2 CX × 12 = 24 UN) ................... "unidade da
//    nota ≠ unidade do cadastro" (este arquivo);
//  - re-amarrar reprojeta os DOIS pedidos ..................... "amarrar a
//    nota em OUTRO pedido" (este arquivo);
//  - pedido cancelado recusa nota com 409 ..................... "pedido
//    cancelado NÃO aceita nota amarrada" (este arquivo);
//  - recebimento → estoque → financeiro → pedido SEM dupla entrada
//    ........................................................... "o fluxo
//    inteiro" (este arquivo: estoque sobe uma vez, uma dívida por nota, e a
//    soma fecha com o pedido);
//  - fornecedor de outra operação invisível ................... compras.test.ts.
//
// O que NÃO tinha dono nenhum — e ganha aqui: SOBRE-ENTREGA (nota fatura mais
// que o pedido), ITEM EXTRA na nota (produto que ninguém pediu), e o PEDIDO DA
// VIZINHA (audit-tenant.test.ts varre produto, cliente, gaveta, financeiro,
// fiscal e OS — pedido de compra não está lá).

describe('sobre-entrega: a nota fatura 12 num pedido de 10', () => {
  it('o backend AFIRMA a sobra: recebido 12 de 10, status "recebido" — e a divergência fica nos dados', async () => {
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Auditada', 9900);
    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const orderId = criado.body.id as string;
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/send`).set(auth).send({});

    // O fornecedor manda 12 onde se pediu 10 — e a doca confirma os 12.
    const nota = await importar(
      xmlNota({
        sufixoChave: '2001',
        numero: '2001',
        itens: [{ nome: 'Pastilha Auditada', qtd: 12, vUnit: '25.00', vTotal: '300.00' }],
        vNF: '300.00',
      }),
    );
    await confirmar(nota);
    const depois = await amarrar(orderId, nota);

    /*
      O COMPORTAMENTO REAL, provado por sonda antes de ser afirmado (a versão
      com 'recebido_parcial'/10 ficou vermelha nesta máquina): o backend NÃO
      capa a sobra no teto do pedido. `recalcReceived` soma o que a nota
      confirmada traz — 12 —, e 12 ≥ 10 fecha o pedido como 'recebido'. É a
      escolha coerente com "a nota é FATO": a prateleira tem 12, e um pedido
      que dissesse "10 de 10" esconderia os 2 que ninguém pediu.

      A divergência NÃO vira status próprio: ela fica nos DADOS —
      received_quantity (12) MAIOR que quantity (10) — e é exatamente essa a
      régua da tela de conciliação para carimbar a linha como sobra.
    */
    expect(depois.status).toBe('recebido');
    const detalhe = await verPedido(orderId);
    const item = detalhe.items.find((i: { product_id: string }) => i.product_id === pastilha);
    expect(item.received_quantity).toBe(12); // os 12 do caminhão, não os 10 do papel
    expect(item.received_quantity).toBeGreaterThan(item.quantity); // a sobra, visível

    // As outras pontas contam a mesma história: prateleira com 12, e a dívida
    // é a da NOTA (12 × R$25,00) — pagar só o pedido é conversa com o
    // fornecedor, não aritmética do sistema.
    expect(saldo(pastilha)).toBe(12);
    const contas = await contasAPagar();
    expect(contas).toHaveLength(1);
    expect(contas[0].amountCents).toBe(30_000);
  });
});

describe('item extra na nota: produto que ninguém pediu', () => {
  it('o extra entra pelo estoque e aparece nos ITENS DA NOTA — o pedido não ganha linha fabricada', async () => {
    /*
      Pedido só de pastilha; a nota chega com a pastilha E seis cabos que
      ninguém pediu. O desenho da casa: a nota é FATO, então o cabo ENTRA
      (estoque e dívida) — mas o pedido é COMPROMISSO, e compromisso não
      ganha linha retroativa para caber no que o fornecedor mandou.

      Quem sinaliza o extra é a TELA, comparando os itens da nota
      (GET /purchases/notes/:id/items) com os itens do pedido — este caso
      prova que as duas listas dizem coisas diferentes de propósito.
    */
    const f = await fornecedor();
    const pastilha = await produto('Pastilha Auditada', 9900);
    const cabo = await produto('Cabo Auditado', 4900); // no catálogo, fora do pedido

    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: pastilha, quantity: 10, unitCostCents: 2500 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const orderId = criado.body.id as string;
    await request(app).post(`/api/v1/core/purchase-orders/${orderId}/send`).set(auth).send({});

    const nota = await importar(
      xmlNota({
        sufixoChave: '2002',
        numero: '2002',
        itens: [
          { nome: 'Pastilha Auditada', qtd: 10, vUnit: '25.00', vTotal: '250.00' },
          { nome: 'Cabo Auditado', qtd: 6, vUnit: '10.00', vTotal: '60.00' },
        ],
        vNF: '310.00',
      }),
    );
    await confirmar(nota);
    await amarrar(orderId, nota);

    // O pedido fecha pelo que FOI pedido — e continua com UMA linha.
    const detalhe = await verPedido(orderId);
    expect(detalhe.status).toBe('recebido');
    expect(detalhe.items).toHaveLength(1);
    expect(detalhe.items[0].product_id).toBe(pastilha);
    expect(detalhe.items[0].received_quantity).toBe(10);

    // O extra é fato: estoque com 6 cabos que pedido nenhum explica…
    expect(saldo(cabo)).toBe(6);

    // …e os itens da NOTA o entregam à tela, casado com o produto do
    // catálogo: é o item cujo product_id está fora dos itens do pedido.
    const itens = await request(app)
      .get(`/api/v1/core/purchases/notes/${nota}/items`)
      .set(auth);
    expect(itens.status, JSON.stringify(itens.body)).toBe(200);
    const doCabo = (itens.body.items as { productId: string | null; quantity: number }[]).find(
      (i) => i.productId === cabo,
    );
    expect(doCabo, 'o item extra sumiu da lista da nota — a tela ficaria cega').toBeTruthy();
    expect(doCabo!.quantity).toBe(6);
  });
});

describe('o pedido da vizinha não se concilia daqui', () => {
  /*
    audit-tenant.test.ts varre produto, cliente, gaveta, financeiro, fiscal e
    OS — pedido de compra não está lá, e compras.test.ts só fecha o
    FORNECEDOR de outra operação. Este caso fecha o pedido: ler e amarrar com
    token de outra empresa é 404 nomeado, e o anti-vácuo é o dono continuando
    a fazer as duas coisas com o MESMO id — sem isso, um 404 de URL errada
    deixaria tudo verde sem provar nada.
  */
  it('ler e amarrar com token de outra operação: 404, nada gravado — e o dono segue operando', async () => {
    const { pastilha, orderId } = await pedidoEnviado();
    const nota = await importar(
      xmlNota({
        sufixoChave: '2003',
        numero: '2003',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    await confirmar(nota);

    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'loja-vizinha-compras',
      profileCodes: ['gerente_loja'],
    });
    expect(outra.status, JSON.stringify(outra.body)).toBe(200);
    const tokenB = { Authorization: `Bearer ${outra.body.accessToken}` };

    // Ler: o pedido da A não existe para a B — nem como "sem permissão", que
    // já contaria que ele existe.
    const leitura = await request(app).get(`/api/v1/core/purchase-orders/${orderId}`).set(tokenB);
    expect(leitura.status, JSON.stringify(leitura.body)).toBe(404);
    expect(leitura.body.error?.code).toBe('CORE_PURCHASE_ORDER_NOT_FOUND');

    // Amarrar: recusado ANTES de tocar a nota — o vínculo não nasce.
    const amarra = await request(app)
      .post(`/api/v1/core/purchase-orders/${orderId}/notes/${nota}`)
      .set(tokenB)
      .send({});
    expect(amarra.status, JSON.stringify(amarra.body)).toBe(404);

    // Os itens da nota da A tampouco vazam: lista vazia, como se não houvesse.
    const itensB = await request(app)
      .get(`/api/v1/core/purchases/notes/${nota}/items`)
      .set(tokenB);
    expect(itensB.status).toBe(200);
    expect(itensB.body.items).toHaveLength(0);

    // A tentativa não deixou rastro no pedido do dono…
    const antes = await verPedido(orderId);
    expect(antes.inboundNotes).toHaveLength(0);
    expect(
      antes.items.find((i: { product_id: string }) => i.product_id === pastilha).received_quantity,
    ).toBe(0);

    // …e o DONO continua lendo e amarrando o MESMO id — o 404 acima é guarda
    // de empresa, não URL quebrada.
    const doDono = await amarrar(orderId, nota);
    expect(doDono.status).toBe('recebido_parcial');
  });
});

// ================================================= A TRILHA QUE FALTAVA (V19)
//
// purchase.nfe.import/confirm e purchase_orders.created/sent/cancelled sempre
// gravaram recordAudit — mas AMARRAR nota a pedido, CONFERIR item, VINCULAR
// produto e EDITAR itens do rascunho não deixavam rastro nenhum. Re-amarrar
// muda o retrato de DOIS pedidos sem registro de quem o fez; a contagem da
// doca ficava sem autor na trilha central (a nota só guarda received_by na
// confirmação). Estes casos cobram cada gesto na trilha, com quem/o quê.

describe('amarrar, conferir, vincular e editar itens deixam trilha de auditoria', () => {
  function trilha(action: string): Record<string, unknown>[] {
    return getConnection()
      .prepare(
        `SELECT action, entity_type, entity_id, user_id, detail
           FROM core_audit_log WHERE company_id = ? AND action = ?`,
      )
      .all(companyId, action) as unknown as Record<string, unknown>[];
  }

  it('amarrar nota↔pedido grava quem amarrou o quê', async () => {
    const { orderId } = await pedidoEnviado();
    const nota = await importar(
      xmlNota({
        sufixoChave: '3001',
        numero: '3001',
        itens: [{ nome: 'Pastilha Auditada', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    await confirmar(nota);
    await amarrar(orderId, nota);

    const linhas = trilha('purchase_orders.note_linked');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].entity_type).toBe('purchase_order');
    expect(linhas[0].entity_id).toBe(orderId);
    expect(linhas[0].user_id).toBe(auditorId);
    expect(String(linhas[0].detail)).toContain(nota);
  });

  it('conferir item grava a contagem da doca — índice, quantidade e motivo', async () => {
    await pedidoEnviado();
    const nota = await importar(
      xmlNota({
        sufixoChave: '3002',
        numero: '3002',
        itens: [{ nome: 'Pastilha Auditada', qtd: 10, vUnit: '25.00', vTotal: '250.00' }],
        vNF: '250.00',
      }),
    );
    await conferir(nota, 0, 8, 'Duas caixas não desceram');

    const linhas = trilha('purchase.note.conferida');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].entity_type).toBe('inbound_note');
    expect(linhas[0].entity_id).toBe(nota);
    const detail = JSON.parse(String(linhas[0].detail));
    expect(detail.itemIndex).toBe(0);
    expect(detail.receivedQuantity).toBe(8);
    expect(String(detail.divergenceNote)).toContain('não desceram');
  });

  it('vincular produto a item da nota grava a decisão humana', async () => {
    const { pastilha } = await pedidoEnviado();
    // A nota traz um nome que NÃO casa com o catálogo — o vínculo é manual.
    const nota = await importar(
      xmlNota({
        sufixoChave: '3003',
        numero: '3003',
        itens: [{ nome: 'PSTLH AUD REF 9', qtd: 5, vUnit: '25.00', vTotal: '125.00' }],
        vNF: '125.00',
      }),
    );
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${nota}/link`)
      .set(auth)
      .send({ itemIndex: 0, productId: pastilha });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const linhas = trilha('purchase.note.item_vinculado');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].entity_id).toBe(nota);
    const detail = JSON.parse(String(linhas[0].detail));
    expect(detail.itemIndex).toBe(0);
    expect(detail.productId).toBe(pastilha);
  });

  it('editar os itens do rascunho grava a reescrita do compromisso', async () => {
    const f = await fornecedor();
    const p = await produto('Pastilha Auditada', 9900);
    const criado = await request(app)
      .post('/api/v1/core/purchase-orders')
      .set(auth)
      .send({ supplierId: f.id, items: [{ productId: p, quantity: 10, unitCostCents: 2500 }] });
    expect(criado.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/core/purchase-orders/${criado.body.id}/items`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 4, unitCostCents: 2600 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const linhas = trilha('purchase_orders.items_updated');
    expect(linhas).toHaveLength(1);
    expect(linhas[0].entity_id).toBe(criado.body.id);
    expect(linhas[0].user_id).toBe(auditorId);
  });
});
