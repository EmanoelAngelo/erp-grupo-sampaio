/**
 * A CONFERÊNCIA VOLTA PARA A TELA — rodada 44.
 *
 * A auditoria mediu três mentiras na entrada de notas:
 *
 *   - `received_quantity` era GRAVADO e nunca devolvido: a coluna "Diferença"
 *     da tela mostrava "—" para sempre, e reabrir a nota apagava (visualmente)
 *     a contagem que o conferente acabou de fazer;
 *   - `divergence_note` era coluna morta dos DOIS lados — a rota aceitava, o
 *     front nunca enviava, o SELECT nunca devolvia;
 *   - `matchedBy` MENTIA: a leitura fabricava 'barcode' para todo item
 *     vinculado, mesmo quando o casamento foi por código interno, descrição ou
 *     vínculo manual.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - tire receivedQuantity/divergenceNote do map de `listNoteItems` e os
 *     casos "a conferência volta" ficam vermelhos;
 *   - volte o map para `matchedBy: r.product_id ? 'barcode' : null` e o caso
 *     do código interno fica vermelho;
 *   - tire o `matched_by = 'manual'` do `linkNoteItem` e o caso do vínculo
 *     manual fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let n = 0;

const CHAVE_BASE = '3524011420016600018755001000000001512345678';

function chave(): string {
  n += 1;
  return `${CHAVE_BASE}${n}`.slice(-44).padStart(44, '0');
}

/**
 * Nota com TRÊS itens desenhados para caminhos de casamento distintos:
 *   1. cEAN 789...31 — casa por código de barras;
 *   2. cProd COD-INTERNO-2, sem EAN — casa por código interno;
 *   3. sem EAN e cProd desconhecido — não casa (vira vínculo manual).
 */
function nfeXml(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>44</nNF><serie>1</serie><dhEmi>2026-08-20T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Rodada 44</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>F-001</cProd><cEAN>7890000000031</cEAN><xProd>Item por barras</xProd>
          <NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>
          <qCom>10</qCom><vUnCom>10.00</vUnCom><vProd>100.00</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>COD-INTERNO-2</cProd><cEAN>SEM GTIN</cEAN><xProd>Item por codigo interno</xProd>
          <NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>
          <qCom>5</qCom><vUnCom>20.00</vUnCom><vProd>100.00</vProd>
        </prod>
      </det>
      <det nItem="3">
        <prod>
          <cProd>DESCONHECIDO-3</cProd><cEAN>SEM GTIN</cEAN><xProd>Item sem cadastro</xProd>
          <NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>
          <qCom>2</qCom><vUnCom>50.00</vUnCom><vProd>100.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>300.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

function criarProduto(id: string, extras: { barcode?: string; internalCode: string; name: string }) {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, barcode, name, unit, cost_cents,
                                  price_cents, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UN', 500, 1000, 1, ?, ?)`,
    )
    .run(id, companyId, extras.internalCode, extras.barcode ?? null, extras.name, agora, agora);
}

async function importar(): Promise<{ noteId: string; items: Record<string, unknown>[] }> {
  const res = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({ xml: nfeXml(chave()) });
  expect(res.status).toBe(201);
  return { noteId: res.body.noteId as string, items: res.body.items };
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-44',
    companyId: 'loja-44',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  criarProduto('p-barras', {
    barcode: '7890000000031',
    internalCode: 'PB-1',
    name: 'Produto do barras',
  });
  criarProduto('p-interno', { internalCode: 'COD-INTERNO-2', name: 'Produto do codigo' });
  criarProduto('p-manual', { internalCode: 'PM-3', name: 'Produto do vinculo manual' });
});

describe('a conferência volta para quem conferiu', () => {
  it('conferir devolve receivedQuantity e divergenceNote NA RESPOSTA — a coluna Diferença ganha o número', async () => {
    const { noteId } = await importar();
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, receivedQuantity: 8, divergenceNote: 'duas caixas com avaria' });
    expect(res.status).toBe(200);

    const item = res.body.items[0];
    expect(item.receivedQuantity).toBe(8);
    expect(item.divergenceNote).toBe('duas caixas com avaria');
    // Os não conferidos continuam nulos — NULL é "ninguém contou ainda".
    expect(res.body.items[1].receivedQuantity).toBeNull();
  });

  it('reabrir a nota NÃO apaga a contagem: o GET devolve o que foi conferido', async () => {
    const { noteId } = await importar();
    await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 1, receivedQuantity: 0, divergenceNote: 'falta total' });

    const res = await request(app).get(`/api/v1/core/purchases/notes/${noteId}/items`).set(auth);
    expect(res.status).toBe(200);
    // Zero é "conferi e não veio" — diferente de NULL, e precisa VOLTAR como 0.
    expect(res.body.items[1].receivedQuantity).toBe(0);
    expect(res.body.items[1].divergenceNote).toBe('falta total');
  });
});

describe('matchedBy diz a verdade', () => {
  it('cada caminho de casamento volta com o SEU método — não "barcode" para todos', async () => {
    const { noteId } = await importar();
    const res = await request(app).get(`/api/v1/core/purchases/notes/${noteId}/items`).set(auth);
    expect(res.status).toBe(200);
    const [porBarras, porCodigo, semCasar] = res.body.items;
    expect(porBarras.matchedBy).toBe('barcode');
    expect(porCodigo.matchedBy).toBe('internal_code');
    expect(semCasar.matchedBy).toBeNull();
    expect(semCasar.productId).toBeNull();
  });

  it('vínculo manual fica registrado como MANUAL — quem auditar sabe que foi gente, não máquina', async () => {
    const { noteId } = await importar();
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/link`)
      .set(auth)
      .send({ itemIndex: 2, productId: 'p-manual' });
    expect(res.status).toBe(200);
    expect(res.body.items[2].matchedBy).toBe('manual');
    expect(res.body.items[2].productId).toBe('p-manual');
  });

  it('item ANTIGO (gravado antes da coluna) volta NULL — não se inventa história retroativa', async () => {
    const { noteId } = await importar();
    // Simula o dado velho: vinculado, sem método gravado.
    getConnection()
      .prepare(
        `UPDATE core_inbound_note_items SET matched_by = NULL
          WHERE note_id = ? AND product_id IS NOT NULL`,
      )
      .run(noteId);
    const res = await request(app).get(`/api/v1/core/purchases/notes/${noteId}/items`).set(auth);
    expect(res.body.items[0].matchedBy).toBeNull();
    expect(res.body.items[0].productId).toBe('p-barras');
  });
});

describe('migração 63', () => {
  it('cria matched_by em banco que não a tem — e reaplicar não explode', () => {
    const db = getConnection();
    db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_63'").run();
    migrateCoreSchema();
    const coluna = db
      .prepare("SELECT name FROM pragma_table_info('core_inbound_note_items') WHERE name = 'matched_by'")
      .get() as { name: string } | undefined;
    expect(coluna?.name).toBe('matched_by');
  });
});
