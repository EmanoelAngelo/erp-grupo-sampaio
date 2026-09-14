/**
 * ============================================================================
 * O ITEM DA NOTA CASA COM O PRODUTO QUE JÁ EXISTE — GAP-PRD-015, 085 e 204
 * ============================================================================
 *
 * ## O defeito (GAP-PRD-015)
 *
 * O item que o casamento automático não reconhecia — fornecedor sem GTIN,
 * `cProd` diferente do código interno, descrição diferente do nome — só tinha
 * um destino: virar um SEGUNDO produto no catálogo, com preço zero, e o saldo
 * subia nele. O produto verdadeiro ficava com saldo velho e o PDV passava a
 * mostrar dois "mesmo produto". A rota de vínculo existia sem nenhum chamador,
 * e mesmo quem a chamasse por API teria de repetir o vínculo em TODA nota do
 * mesmo fornecedor — o sistema não aprendia nada.
 *
 * O conserto no servidor tem três pedaços, e este arquivo cobra os três:
 *
 *   1. o vínculo manual APRENDE: grava o de-para (fornecedor + código do
 *      fornecedor → produto), e a próxima nota do MESMO fornecedor casa sozinha,
 *      com `matchedBy = 'supplier_code'`;
 *   2. o casamento por GTIN enxerga os códigos de barras ADICIONAIS do produto
 *      (o do fabricante, o do fardo) — antes só o principal;
 *   3. o vínculo pode ser DESFEITO enquanto a nota está em conferência
 *      (`productId: null`), e desfazer esquece o de-para errado.
 *
 * ## O vínculo em documento fechado (GAP-PRD-085)
 *
 * `linkNoteItem` não lia o status da nota: numa nota RECEBIDA o item mudava de
 * produto, a nota passava a afirmar uma entrada que o razão nega e a conciliação
 * do pedido somava o produto errado. Agora é 409, como na conferência.
 *
 * ## A nota manual sem XML (GAP-PRD-204)
 *
 * A compra digitada nunca teve arquivo, e o 404 dizia que ela "entrou antes de
 * o sistema passar a guardar o arquivo" — mandando o contador procurar um XML
 * que nunca existiu.
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

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-casamento',
    companyId: 'loja-casamento',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

// ---------------------------------------------------------------- helpers

interface ItemXml {
  cProd: string;
  cEAN?: string;
  xProd: string;
  uCom?: string;
  qCom?: number;
  vUnCom?: number;
}

let sequencia = 0;

/** Uma NF-e em estrutura real; cada chamada ganha chave de acesso nova. */
function nfeXml(opcoes: { cnpj?: string; fornecedor?: string; itens: ItemXml[] }): string {
  sequencia += 1;
  const chave = `3524011420016600018755001${String(sequencia).padStart(9, '0')}1234567890`;
  const det = opcoes.itens
    .map((item, i) => {
      const q = item.qCom ?? 1;
      const v = item.vUnCom ?? 10;
      return `<det nItem="${i + 1}"><prod>
          <cProd>${item.cProd}</cProd>
          <cEAN>${item.cEAN ?? 'SEM GTIN'}</cEAN>
          <xProd>${item.xProd}</xProd>
          <NCM>87141000</NCM>
          <CFOP>5102</CFOP>
          <uCom>${item.uCom ?? 'UN'}</uCom>
          <qCom>${q.toFixed(4)}</qCom>
          <vUnCom>${v.toFixed(4)}</vUnCom>
          <vProd>${(q * v).toFixed(2)}</vProd>
        </prod></det>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe>
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide><cUF>35</cUF><nNF>${sequencia}</nNF><serie>1</serie>
      <dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
    <emit><CNPJ>${opcoes.cnpj ?? '14200166000187'}</CNPJ>
      <xNome>${opcoes.fornecedor ?? 'Distribuidora Alfa'}</xNome></emit>
    <dest><CNPJ>99999999000191</CNPJ><xNome>Loja</xNome></dest>
    ${det}
    <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
  </infNFe></NFe></nfeProc>`;
}

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 1990, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function importar(xml: string) {
  const res = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as {
    noteId: string;
    items: { productId: string | null; matchedBy: string | null }[];
  };
}

function vincular(noteId: string, corpo: Record<string, unknown>) {
  return request(app).post(`/api/v1/core/purchases/notes/${noteId}/link`).set(auth).send(corpo);
}

async function confirmar(noteId: string, createMissing = false) {
  const res = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({ createMissing });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function itemDaNota(noteId: string, indice: number): Record<string, unknown> {
  const linhas = getConnection()
    .prepare('SELECT * FROM core_inbound_note_items WHERE note_id = ? ORDER BY rowid')
    .all(noteId) as unknown as Record<string, unknown>[];
  return linhas[indice];
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function deParas(): Record<string, unknown>[] {
  return getConnection()
    .prepare('SELECT * FROM core_supplier_item_codes WHERE company_id = ? ORDER BY supplier_code')
    .all(companyId) as unknown as Record<string, unknown>[];
}

function trilha(acao: string): Record<string, unknown>[] {
  return getConnection()
    .prepare('SELECT * FROM core_audit_log WHERE company_id = ? AND action = ? ORDER BY rowid')
    .all(companyId, acao) as unknown as Record<string, unknown>[];
}

function produtosComNome(nome: string): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = ?')
    .get(companyId, nome) as { n: number };
  return Number(row.n);
}

// ============================================ GAP-PRD-085: documento fechado

describe('vincular item só enquanto a nota está em conferência (GAP-PRD-085)', () => {
  it('nota RECEBIDA recusa o vínculo com 409 e o item continua no produto que entrou', async () => {
    const pastilha = await produto('Pastilha de Freio', { barcode: '7891234567895' });
    const outro = await produto('Disco de Freio');
    const nota = await importar(
      nfeXml({ itens: [{ cProd: 'F-1', cEAN: '7891234567895', xProd: 'PASTILHA', qCom: 10 }] }),
    );
    expect(nota.items[0].productId).toBe(pastilha);
    await confirmar(nota.noteId);
    expect(saldo(pastilha)).toBe(10);

    const res = await vincular(nota.noteId, { itemIndex: 0, productId: outro });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NOTE_ALREADY_RECEIVED');

    // A nota continua dizendo a verdade do razão.
    expect(itemDaNota(nota.noteId, 0).product_id).toBe(pastilha);
    expect(itemDaNota(nota.noteId, 0).matched_by).toBe('barcode');
    // E a recusa não deixa rastro de vínculo que não aconteceu.
    expect(trilha('purchase.note.item_vinculado')).toHaveLength(0);
  });

  it('nota ESTORNADA recusa o vínculo com 409 CORE_NOTE_REVERSED', async () => {
    const pastilha = await produto('Pastilha de Freio', { barcode: '7891234567895' });
    const outro = await produto('Disco de Freio');
    const nota = await importar(
      nfeXml({ itens: [{ cProd: 'F-1', cEAN: '7891234567895', xProd: 'PASTILHA', qCom: 2 }] }),
    );
    await confirmar(nota.noteId);
    const estorno = await request(app)
      .post(`/api/v1/core/purchases/notes/${nota.noteId}/estornar`)
      .set(auth)
      .send({ reason: 'Confirmada por engano' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(200);

    const res = await vincular(nota.noteId, { itemIndex: 0, productId: outro });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NOTE_REVERSED');
    expect(itemDaNota(nota.noteId, 0).product_id).toBe(pastilha);
  });

  it('desfazer o vínculo também é recusado em nota recebida', async () => {
    const pastilha = await produto('Pastilha de Freio', { barcode: '7891234567895' });
    const nota = await importar(
      nfeXml({ itens: [{ cProd: 'F-1', cEAN: '7891234567895', xProd: 'PASTILHA' }] }),
    );
    await confirmar(nota.noteId);

    const res = await vincular(nota.noteId, { itemIndex: 0, productId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(itemDaNota(nota.noteId, 0).product_id).toBe(pastilha);
  });
});

// ============================================ GAP-PRD-015: casar com o que existe

describe('o vínculo manual casa com o produto que já existe (GAP-PRD-015)', () => {
  it('o item vinculado entra no produto verdadeiro — nenhum cadastro duplicado com preço zero', async () => {
    const verdadeiro = await produto('Cabo de Acelerador CG 160');
    const nota = await importar(
      nfeXml({ itens: [{ cProd: 'ALFA-778', xProd: 'CABO ACEL CG160 REF 778', qCom: 4 }] }),
    );
    expect(nota.items[0].productId).toBeNull();

    const res = await vincular(nota.noteId, { itemIndex: 0, productId: verdadeiro });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0].productId).toBe(verdadeiro);
    expect(res.body.items[0].matchedBy).toBe('manual');
    // A tela precisa dizer COM QUAL produto casou — o id não diz nada a ninguém.
    expect(res.body.items[0].productName).toBe('Cabo de Acelerador CG 160');
    expect(typeof res.body.items[0].productInternalCode).toBe('string');

    const conf = await confirmar(nota.noteId);
    expect(conf.createdProducts).toBe(0);
    expect(saldo(verdadeiro)).toBe(4);
    expect(produtosComNome('CABO ACEL CG160 REF 778')).toBe(0);
  });

  it('o vínculo APRENDE: a próxima nota do mesmo fornecedor casa sozinha pelo código dele', async () => {
    const verdadeiro = await produto('Cabo de Acelerador CG 160');
    const primeira = await importar(
      nfeXml({ itens: [{ cProd: 'ALFA-778', xProd: 'CABO ACEL CG160 REF 778' }] }),
    );
    const res = await vincular(primeira.noteId, { itemIndex: 0, productId: verdadeiro });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const de = deParas();
    expect(de).toHaveLength(1);
    expect(de[0].supplier_code).toBe('ALFA-778');
    expect(de[0].product_id).toBe(verdadeiro);
    expect(de[0].origin).toBe('vinculo_manual');
    expect(de[0].source_note_id).toBe(primeira.noteId);

    // Descrição diferente de novo — o fornecedor muda o texto a cada nota.
    const segunda = await importar(
      nfeXml({ itens: [{ cProd: 'ALFA-778', xProd: 'CABO ACELERADOR 778 (NOVO)' }] }),
    );
    expect(segunda.items[0].productId).toBe(verdadeiro);
    expect(segunda.items[0].matchedBy).toBe('supplier_code');
  });

  it('o de-para é do FORNECEDOR: o mesmo código vindo de outro fornecedor não casa', async () => {
    const verdadeiro = await produto('Cabo de Acelerador CG 160');
    const primeira = await importar(
      nfeXml({ itens: [{ cProd: '778', xProd: 'CABO ACEL CG160' }] }),
    );
    await vincular(primeira.noteId, { itemIndex: 0, productId: verdadeiro });

    const deOutro = await importar(
      nfeXml({
        cnpj: '55666777000188',
        fornecedor: 'Atacado Beta',
        itens: [{ cProd: '778', xProd: 'PARAFUSO M8' }],
      }),
    );
    expect(deOutro.items[0].productId).toBeNull();
  });

  it('`lembrar: false` vincula esta nota sem ensinar nada às próximas', async () => {
    const verdadeiro = await produto('Kit Promocional Verão');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'PROMO-1', xProd: 'BRINDE' }] }));
    const res = await vincular(nota.noteId, { itemIndex: 0, productId: verdadeiro, lembrar: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0].productId).toBe(verdadeiro);
    expect(deParas()).toHaveLength(0);
  });

  it('trocar o vínculo reescreve o de-para — a última decisão humana vence', async () => {
    const errado = await produto('Cabo de Freio');
    const certo = await produto('Cabo de Acelerador');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'ALFA-9', xProd: 'CABO 9' }] }));
    await vincular(nota.noteId, { itemIndex: 0, productId: errado });
    const res = await vincular(nota.noteId, { itemIndex: 0, productId: certo });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const de = deParas();
    expect(de).toHaveLength(1);
    expect(de[0].product_id).toBe(certo);

    // A trilha guarda o antes e o depois.
    const linhas = trilha('purchase.note.item_vinculado');
    expect(linhas).toHaveLength(2);
    const detalhe = JSON.parse(String(linhas[1].detail));
    expect(detalhe.productId).toBe(certo);
    expect(detalhe.anterior).toBe(errado);
    expect(detalhe.lembrado).toBe(true);
  });

  it('o de-para aprendido VENCE o casamento por descrição, que é o mais fraco', async () => {
    const homonimo = await produto('Filtro de Oleo');
    const certo = await produto('Filtro de Óleo Moto Honda');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'FO-1', xProd: 'Filtro de Oleo' }] }));
    // O nome idêntico casou sozinho — com o produto errado.
    expect(nota.items[0].productId).toBe(homonimo);
    expect(nota.items[0].matchedBy).toBe('name');
    await vincular(nota.noteId, { itemIndex: 0, productId: certo });

    const proxima = await importar(nfeXml({ itens: [{ cProd: 'FO-1', xProd: 'Filtro de Oleo' }] }));
    expect(proxima.items[0].productId).toBe(certo);
    expect(proxima.items[0].matchedBy).toBe('supplier_code');
  });

  it('desfazer o vínculo (productId: null) devolve o item para "sem produto" e esquece o de-para', async () => {
    const errado = await produto('Filtro de Oleo');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'FO-1', xProd: 'FILTRO AR' }] }));
    await vincular(nota.noteId, { itemIndex: 0, productId: errado });
    expect(deParas()).toHaveLength(1);

    const res = await vincular(nota.noteId, { itemIndex: 0, productId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0].productId).toBeNull();
    expect(res.body.items[0].matchedBy).toBeNull();
    expect(itemDaNota(nota.noteId, 0).matched).toBe(0);
    expect(deParas()).toHaveLength(0);

    const linhas = trilha('purchase.note.item_desvinculado');
    expect(linhas).toHaveLength(1);
    expect(JSON.parse(String(linhas[0].detail)).anterior).toBe(errado);
  });

  it('modelo de grade e kit que desmembra são recusados NO VÍNCULO, não na confirmação', async () => {
    const modelo = await produto('Camiseta Polo');
    await produto('Camiseta Polo M');
    getConnection()
      .prepare("UPDATE core_products SET parent_id = ? WHERE name = 'Camiseta Polo M'")
      .run(modelo);
    const kit = await produto('Kit Revisão');
    getConnection()
      .prepare('UPDATE core_products SET is_kit = 1, kit_explode_on_sale = 1 WHERE id = ?')
      .run(kit);
    const nota = await importar(nfeXml({ itens: [{ cProd: 'X', xProd: 'POLO' }] }));

    const grade = await vincular(nota.noteId, { itemIndex: 0, productId: modelo });
    expect(grade.status, JSON.stringify(grade.body)).toBe(400);
    expect(grade.body.error.code).toBe('CORE_PRODUCT_IS_GRID_MODEL');

    const doKit = await vincular(nota.noteId, { itemIndex: 0, productId: kit });
    expect(doKit.status, JSON.stringify(doKit.body)).toBe(400);
    expect(doKit.body.error.code).toBe('CORE_PRODUCT_IS_KIT');

    expect(itemDaNota(nota.noteId, 0).product_id).toBeNull();
    expect(deParas()).toHaveLength(0);
  });

  it('o estoquista — quem está na doca — vincula pela mesma rota', async () => {
    const verdadeiro = await produto('Cabo de Acelerador CG 160');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'E-1', xProd: 'CABO' }] }));
    const doca = await loginForTest(app, {
      userId: 'estoquista-casamento',
      companyId,
      profileCodes: ['estoquista'],
    });
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${nota.noteId}/link`)
      .set({ Authorization: `Bearer ${doca.body.accessToken}` })
      .send({ itemIndex: 0, productId: verdadeiro });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(deParas()[0].created_by).toBeTruthy();
  });

  it('produto de OUTRA empresa não é vinculável (404) — o de-para não atravessa empresas', async () => {
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    });
    const authOutra = { Authorization: `Bearer ${outra.body.accessToken}` };
    const alheio = await request(app)
      .post('/api/v1/core/products')
      .set(authOutra)
      .send({ name: 'Produto da vizinha', priceCents: 100 });
    expect(alheio.status).toBe(201);

    const nota = await importar(nfeXml({ itens: [{ cProd: 'V-1', xProd: 'ITEM' }] }));
    const res = await vincular(nota.noteId, { itemIndex: 0, productId: alheio.body.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');

    // E a nota desta empresa não é alcançável pela vizinha.
    const cruzado = await request(app)
      .post(`/api/v1/core/purchases/notes/${nota.noteId}/link`)
      .set(authOutra)
      .send({ itemIndex: 0, productId: alheio.body.id });
    expect(cruzado.status).toBe(404);
  });

  it('o produto que a confirmação CADASTRA também entra no de-para — renomear não duplica na próxima nota', async () => {
    const primeira = await importar(
      nfeXml({ itens: [{ cProd: 'ALFA-55', xProd: 'PSTLH FREIO DIANT', qCom: 3 }] }),
    );
    const conf = await confirmar(primeira.noteId, true);
    expect(conf.createdProducts).toBe(1);
    const criado = String(itemDaNota(primeira.noteId, 0).product_id);
    const de = deParas();
    expect(de).toHaveLength(1);
    expect(de[0].product_id).toBe(criado);
    expect(de[0].origin).toBe('cadastro_pela_nota');

    // A loja arruma o nome do cadastro — o gesto mais comum depois da carga.
    getConnection()
      .prepare("UPDATE core_products SET name = 'Pastilha de freio dianteira' WHERE id = ?")
      .run(criado);

    const segunda = await importar(
      nfeXml({ itens: [{ cProd: 'ALFA-55', xProd: 'PSTLH FREIO DIANT', qCom: 2 }] }),
    );
    expect(segunda.items[0].productId).toBe(criado);
    expect(segunda.items[0].matchedBy).toBe('supplier_code');
    const conf2 = await confirmar(segunda.noteId);
    expect(conf2.createdProducts).toBe(0);
    expect(saldo(criado)).toBe(5);
  });

  it('o de-para que aponta para um produto que virou modelo de grade é ignorado, não obedecido', async () => {
    const vira = await produto('Bota');
    const nota = await importar(nfeXml({ itens: [{ cProd: 'B-1', xProd: 'BOTA COURO' }] }));
    await vincular(nota.noteId, { itemIndex: 0, productId: vira });
    await produto('Bota 40');
    getConnection()
      .prepare("UPDATE core_products SET parent_id = ? WHERE name = 'Bota 40'")
      .run(vira);

    const proxima = await importar(nfeXml({ itens: [{ cProd: 'B-1', xProd: 'BOTA COURO' }] }));
    expect(proxima.items[0].productId).toBeNull();
  });
});

describe('o GTIN do fornecedor enxerga os códigos adicionais do produto (GAP-PRD-015)', () => {
  it('EAN que é código ADICIONAL do cadastro casa por código de barras', async () => {
    const oleo = await produto('Óleo 20W50 1L', { barcode: '7890000000017' });
    const adicional = await request(app)
      .post(`/api/v1/core/products/${oleo}/barcodes`)
      .set(auth)
      .send({ barcode: '7891111111111' });
    expect(adicional.status, JSON.stringify(adicional.body)).toBeLessThan(300);

    const nota = await importar(
      nfeXml({ itens: [{ cProd: 'OL-1', cEAN: '7891111111111', xProd: 'OLEO MOTOR 20W50' }] }),
    );
    expect(nota.items[0].productId).toBe(oleo);
    expect(nota.items[0].matchedBy).toBe('barcode');
  });

  it('a prévia (antes de gravar) já usa o de-para do fornecedor cadastrado', async () => {
    const verdadeiro = await produto('Cabo de Acelerador CG 160');
    const primeira = await importar(nfeXml({ itens: [{ cProd: 'ALFA-778', xProd: 'CABO' }] }));
    await vincular(primeira.noteId, { itemIndex: 0, productId: verdadeiro });

    const previa = await request(app)
      .post('/api/v1/core/purchases/nfe/preview')
      .set(auth)
      .send({ xml: nfeXml({ itens: [{ cProd: 'ALFA-778', xProd: 'CABO' }] }) });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    expect(previa.body.items[0].productId).toBe(verdadeiro);
    expect(previa.body.items[0].matchedBy).toBe('supplier_code');
  });
});

// ============================================ GAP-PRD-204: nota manual sem XML

describe('a nota lançada à mão não finge ter perdido o XML (GAP-PRD-204)', () => {
  it('404 próprio, com a frase de quem nunca teve arquivo', async () => {
    const fornecedor = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Seu Zé das Embalagens', paymentTermDays: 0 });
    expect(fornecedor.status, JSON.stringify(fornecedor.body)).toBe(201);
    const sacola = await produto('Sacola kraft');
    const criada = await request(app)
      .post('/api/v1/core/purchases/manual')
      .set(auth)
      .send({
        supplierId: fornecedor.body.id,
        items: [{ productId: sacola, quantity: 10, unitCostCents: 45 }],
      });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);

    const res = await request(app)
      .get(`/api/v1/core/purchases/notes/${criada.body.noteId}/xml`)
      .set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_INBOUND_NOTE_MANUAL_SEM_XML');
    expect(res.body.error.message).toMatch(/lançada manualmente/);
    expect(res.body.error.message).not.toMatch(/antes de o sistema passar a guardar/);
  });

  it('a nota de XML antiga, sem arquivo, continua com o código e a frase dela', async () => {
    const nota = await importar(nfeXml({ itens: [{ cProd: 'A', xProd: 'ITEM' }] }));
    getConnection()
      .prepare('UPDATE core_inbound_notes SET xml_original = NULL WHERE id = ?')
      .run(nota.noteId);

    const res = await request(app).get(`/api/v1/core/purchases/notes/${nota.noteId}/xml`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_INBOUND_NOTE_XML_AUSENTE');
    expect(res.body.error.message).toMatch(/antes de o sistema passar a guardar/);
  });
});
