/**
 * Entrada de estoque por XML de NF-e.
 *
 * Usa uma NF-e real em estrutura (nfeProc + infNFe + det/prod + ICMSTot),
 * não um JSON inventado — o parser precisa aguentar o formato que chega.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { parseNfeXml } from '../src/services/core/NfeImportService.js';

const app = createApp();

const ACCESS_KEY = '35240114200166000187550010000000015123456789';

function nfeXml(options: { key?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${options.key ?? ACCESS_KEY}" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <nNF>1024</nNF>
        <serie>1</serie>
        <dhEmi>2026-08-01T10:15:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>14200166000187</CNPJ>
        <xNome>Distribuidora de Pecas Ltda</xNome>
      </emit>
      <dest>
        <CNPJ>99999999000191</CNPJ>
        <xNome>Grupo Sampaio</xNome>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>FORN-001</cProd>
          <cEAN>7891234567895</cEAN>
          <xProd>Pastilha de Freio Dianteira</xProd>
          <NCM>87141000</NCM>
          <CFOP>5102</CFOP>
          <uCom>UN</uCom>
          <qCom>10.0000</qCom>
          <vUnCom>45.5000</vUnCom>
          <vProd>455.00</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>FORN-002</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>Cabo de Acelerador</xProd>
          <NCM>87149990</NCM>
          <CFOP>5102</CFOP>
          <uCom>PC</uCom>
          <qCom>4.0000</qCom>
          <vUnCom>22.2500</vUnCom>
          <vProd>89.00</vProd>
        </prod>
      </det>
      <total>
        <ICMSTot>
          <vNF>544.00</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
  <protNFe><infProt><nProt>135240000000001</nProt></infProt></protNFe>
</nfeProc>`;
}

let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: 'loja-nfe',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('leitura do XML', () => {
  it('extrai chave, fornecedor, itens e totais', () => {
    const parsed = parseNfeXml(nfeXml());
    expect(parsed.accessKey).toBe(ACCESS_KEY);
    expect(parsed.number).toBe('1024');
    expect(parsed.series).toBe('1');
    expect(parsed.supplierName).toBe('Distribuidora de Pecas Ltda');
    expect(parsed.supplierDocument).toBe('14200166000187');
    expect(parsed.totalCents).toBe(54400);
    expect(parsed.items).toHaveLength(2);

    const [first, second] = parsed.items;
    expect(first.description).toBe('Pastilha de Freio Dianteira');
    expect(first.barcode).toBe('7891234567895');
    expect(first.ncm).toBe('87141000');
    expect(first.cfop).toBe('5102');
    expect(first.quantity).toBe(10);
    expect(first.unitCostCents).toBe(4550);

    // "SEM GTIN" não é código de barras — não pode virar EAN falso.
    expect(second.barcode).toBeNull();
    expect(second.unit).toBe('PC');
  });

  it('recusa arquivo que não é NF-e', () => {
    expect(() => parseNfeXml('<html><body>oi</body></html>')).toThrow(/não parece ser uma NF-e/);
  });

  it('recusa XML sem chave de acesso válida', () => {
    expect(() => parseNfeXml(nfeXml({ key: '123' }))).toThrow(/Chave de acesso/);
  });

  it('recusa arquivo vazio', () => {
    expect(() => parseNfeXml('')).toThrow(/vazio/);
  });
});

describe('importação', () => {
  it('preview não altera estoque', async () => {
    const res = await request(app)
      .post('/api/v1/core/purchases/nfe/preview')
      .set(auth)
      .send({ xml: nfeXml() });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].productId).toBeNull();

    const notes = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(notes.body.items).toHaveLength(0);
  });

  it('casa item existente pelo código de barras', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Pastilha (cadastro antigo)', barcode: '7891234567895', priceCents: 9900 });

    const res = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });

    expect(res.status).toBe(201);
    expect(res.body.items[0].productId).toBe(product.body.id);
    expect(res.body.items[0].matchedBy).toBe('barcode');
    expect(res.body.items[1].productId).toBeNull();
  });

  it('importar guarda a nota em conferência sem mexer no estoque', async () => {
    const res = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });
    expect(res.body.status).toBe('conferencia');

    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    expect(stock.body.items).toHaveLength(0);
  });

  it('reimportar a MESMA nota não duplica', async () => {
    const first = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });
    const second = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicated).toBe(true);
    expect(second.body.noteId).toBe(first.body.noteId);

    const notes = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(notes.body.items).toHaveLength(1);
  });
});

describe('conferência e recebimento', () => {
  it('não confirma com item sem produto vinculado', async () => {
    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });

    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`)
      .set(auth)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_UNMATCHED_ITEMS');
  });

  it('cria os produtos que faltam e dá entrada no estoque', async () => {
    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });

    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`)
      .set(auth)
      .send({ createMissing: true });

    expect(res.status).toBe(200);
    expect(res.body.createdProducts).toBe(2);
    expect(res.body.movedItems).toBe(2);

    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    const pastilha = stock.body.items.find(
      (i: { name: string }) => i.name === 'Pastilha de Freio Dianteira',
    );
    const cabo = stock.body.items.find((i: { name: string }) => i.name === 'Cabo de Acelerador');
    expect(pastilha.quantity).toBe(10);
    expect(cabo.quantity).toBe(4);
    // O custo vem da nota.
    expect(pastilha.cost_cents).toBe(4550);
  });

  it('confirmar duas vezes não dobra o estoque', async () => {
    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });
    const url = `/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`;

    await request(app).post(url).set(auth).send({ createMissing: true });
    const second = await request(app).post(url).set(auth).send({ createMissing: true });

    expect(second.body.alreadyReceived).toBe(true);
    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    const pastilha = stock.body.items.find(
      (i: { name: string }) => i.name === 'Pastilha de Freio Dianteira',
    );
    expect(pastilha.quantity).toBe(10);
  });

  it('vincula item manualmente e recebe sem criar produto novo', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Cabo acelerador (catálogo)', priceCents: 5000 });
    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });

    // Item 1 (índice 1) é o "Cabo de Acelerador", que não casou sozinho.
    await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/link`)
      .set(auth)
      .send({ itemIndex: 1, productId: product.body.id });

    /*
      A NOTA ESTÁ EM PC E O CADASTRO EM UN — e só uma pessoa pode dizer que,
      para este item, é a mesma coisa.

      O vínculo manual liga a linha ao produto; ele não afirma nada sobre
      unidade. A nota fatura 4 PC, o cabo do catálogo é vendido em UN, e o
      sistema não tem como saber se PC é sinônimo de UN ou uma embalagem com
      dez dentro. Antes desta rodada ele assumia 1:1 em silêncio — é o mesmo
      pressuposto que fazia dez caixas de doze virarem dez parafusos.

      Quem confere resolve com um número: 1 PC = 1 UN.
    */
    await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 1, receivedQuantity: 4, conversionFactor: 1 });

    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`)
      .set(auth)
      .send({ createMissing: true });

    // Só a pastilha foi criada; o cabo usou o produto vinculado.
    expect(res.body.createdProducts).toBe(1);

    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    const cabo = stock.body.items.find(
      (i: { name: string }) => i.name === 'Cabo acelerador (catálogo)',
    );
    expect(cabo.quantity).toBe(4);
  });

  it('a nota de uma empresa não aparece em outra', async () => {
    await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml: nfeXml() });

    const other = await loginForTest(app, {
      userId: 'gerente-b',
      companyId: 'loja-outra',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/purchases/notes')
      .set({ Authorization: `Bearer ${other.body.accessToken}` });
    expect(res.body.items).toHaveLength(0);
  });

  it('registra a entrada no ledger com a nota como referência', async () => {
    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml() });
    await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`)
      .set(auth)
      .send({ createMissing: true });

    const movements = getConnection()
      .prepare("SELECT reference_type, reference_id FROM core_stock_movements WHERE reference_type = 'nfe_entrada'")
      .all() as unknown as { reference_id: string }[];
    expect(movements).toHaveLength(2);
    expect(movements[0].reference_id).toBe(imported.body.noteId);
  });

  /*
    A REGRA MUDOU (PJ-CAIXA, 2026-09-14). Era "o balcão dá entrada por XML sem o
    gerente". O caixa da LOJA não recebe mercadoria: o login do PDV da Preço
    Justo não administra estoque nem cria produto (a confirmação com
    createMissing cria). O caixa da OFICINA segue importando e confirmando.
  */
  it('caixa da loja não importa a nota (403); o caixa da oficina importa e confirma', async () => {
    const caixaDaLoja = await loginForTest(app, {
      userId: 'caixa',
      companyId: 'loja-nfe',
      profileCodes: ['operador_caixa_loja'],
    });
    const recusada = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set({ Authorization: `Bearer ${caixaDaLoja.body.accessToken}` })
      .send({ xml: nfeXml() });
    expect(recusada.status).toBe(403);

    const operator = await loginForTest(app, {
      userId: 'caixa-oficina',
      companyId: 'loja-nfe',
      profileCodes: ['operador_caixa_oficina'],
    });
    const operatorAuth = { Authorization: `Bearer ${operator.body.accessToken}` };

    const imported = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(operatorAuth)
      .send({ xml: nfeXml() });
    expect(imported.status).toBe(201);

    const confirmed = await request(app)
      .post(`/api/v1/core/purchases/notes/${imported.body.noteId}/confirm`)
      .set(operatorAuth)
      .send({ createMissing: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.movedItems).toBe(2);
  });
});
