/**
 * A CAIXA NÃO É UMA UNIDADE.
 *
 * ============================================================================
 * DEZ CAIXAS DE DOZE VIRAVAM DEZ PARAFUSOS
 * ============================================================================
 *
 * A entrada de nota lia `qCom` e somava esse número no saldo do produto, sem
 * olhar UMA VEZ para a unidade. O fornecedor fatura em CX porque é assim que
 * ele vende; a loja vende em UN porque é assim que o cliente compra. Ninguém
 * está errado — e o sistema tratava os dois números como se fossem a mesma
 * coisa.
 *
 * O estrago é do tipo que não aparece:
 *
 *   - o saldo entra 12 vezes menor, então o PDV recusa venda de mercadoria que
 *     está na prateleira, e a vitrine esconde produto que existe;
 *   - o CUSTO UNITÁRIO entra 12 vezes maior (o `vUnCom` é o preço da CAIXA),
 *     então markup, margem e o relatório de lucro passam a mentir;
 *   - e a diferença só aparece na contagem de inventário, semanas depois, como
 *     "sobra inexplicada" — que é exatamente o tipo de número que faz a
 *     operação parar de confiar no sistema.
 *
 * ============================================================================
 * A NOTA JÁ TRAZ A CONVERSÃO — ERA SÓ NÃO JOGAR FORA
 * ============================================================================
 *
 * O layout da NF-e tem DOIS pares de unidade e quantidade em cada item:
 *
 *   uCom  / qCom  / vUnCom  — a unidade COMERCIAL: como o fornecedor vende
 *   uTrib / qTrib / vUnTrib — a unidade TRIBUTÁVEL: a menor unidade do item
 *
 * O emitente é obrigado a preencher os dois. Numa nota de 10 caixas de 12, ele
 * escreve `qCom = 10, uCom = CX` e `qTrib = 120, uTrib = UN`. A conversão
 * estava dentro do arquivo o tempo todo; o parser descartava o segundo par.
 *
 * Quando nem assim dá para saber — o fornecedor tributa em CX também, ou usa
 * uma sigla que o cadastro não conhece —, a entrada é RECUSADA e o conferente
 * informa quantas unidades vêm na caixa. Recusar é a única saída honesta:
 * assumir 1:1 é o defeito, e adivinhar seria o defeito com mais passos.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 *  - 10 CX de 12 entram como 120, e o custo unitário é o da UNIDADE
 *  - unidade igual à do cadastro continua entrando 1:1, sem cerimônia
 *  - unidade diferente e sem conversão possível RECUSA a nota, dizendo a linha
 *  - o conferente informa o fator e a nota entra
 *  - produto novo, criado pela própria nota, nasce na unidade da nota — e
 *    entra 1:1, porque aí não há duas unidades, há uma
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let n = 0;

function chave(): string {
  n += 1;
  return `352401142001660001875500100000000151234${String(n).padStart(5, '0')}`.slice(-44);
}

interface ItemDaNota {
  cProd: string;
  cEAN?: string;
  xProd: string;
  uCom: string;
  qCom: number;
  vUnCom: number;
  uTrib?: string;
  qTrib?: number;
}

function nfeXml(accessKey: string, itens: ItemDaNota[]): string {
  const dets = itens
    .map((it, i) => {
      const trib =
        it.uTrib != null
          ? `<uTrib>${it.uTrib}</uTrib><qTrib>${it.qTrib}</qTrib>`
          + `<vUnTrib>${((it.vUnCom * it.qCom) / (it.qTrib as number)).toFixed(4)}</vUnTrib>`
          : '';
      return `      <det nItem="${i + 1}">
        <prod>
          <cProd>${it.cProd}</cProd><cEAN>${it.cEAN ?? 'SEM GTIN'}</cEAN>
          <xProd>${it.xProd}</xProd>
          <NCM>73181500</NCM><CFOP>5102</CFOP>
          <uCom>${it.uCom}</uCom><qCom>${it.qCom}</qCom>
          <vUnCom>${it.vUnCom.toFixed(2)}</vUnCom>
          <vProd>${(it.vUnCom * it.qCom).toFixed(2)}</vProd>
          ${trib}
        </prod>
      </det>`;
    })
    .join('\n');

  const totalNota = itens.reduce((s, it) => s + it.vUnCom * it.qCom, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>77</nNF><serie>1</serie><dhEmi>2026-08-20T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora da Caixa</xNome></emit>
${dets}
      <total><ICMSTot><vNF>${totalNota.toFixed(2)}</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

/** O parafuso que a loja vende AVULSO. */
function parafusoEmUnidade(): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, barcode, name, unit, cost_cents,
                                  price_cents, active, created_at, updated_at)
       VALUES ('p-parafuso', ?, 'PAR-1', '7890000000024', 'Parafuso M8', 'UN', 100, 250, 1, ?, ?)`,
    )
    .run(companyId, agora, agora);
  return 'p-parafuso';
}

async function importar(itens: ItemDaNota[]): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({ xml: nfeXml(chave(), itens) });
  expect(res.status).toBe(201);
  return res.body.noteId as string;
}

function confirmar(noteId: string, createMissing = false) {
  return request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({ createMissing });
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function custo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT cost_cents FROM core_products WHERE id = ?')
    .get(productId) as { cost_cents: number } | undefined;
  return Number(row?.cost_cents ?? 0);
}

const CAIXA_DE_DOZE: ItemDaNota = {
  cProd: 'F-PAR',
  cEAN: '7890000000024',
  xProd: 'Parafuso M8 caixa com 12',
  uCom: 'CX',
  qCom: 10,
  vUnCom: 12.0, // R$ 12,00 a CAIXA — R$ 1,00 a unidade
  uTrib: 'UN',
  qTrib: 120,
};

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-caixa',
    companyId: 'loja-caixa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

// ============================================================================

describe('a nota que já traz a conversão', () => {
  it('10 caixas de 12 entram como 120 unidades', async () => {
    const parafuso = parafusoEmUnidade();
    const noteId = await importar([CAIXA_DE_DOZE]);

    const res = await confirmar(noteId);
    expect(res.status).toBe(200);

    // 10 × 12. Antes desta rodada o saldo subia 10 — e o PDV recusava venda de
    // parafuso que estava na caixa aberta, em cima do balcão.
    expect(saldo(parafuso)).toBe(120);
  });

  it('e o custo passa a ser o da UNIDADE, não o da caixa', async () => {
    const parafuso = parafusoEmUnidade();
    const noteId = await importar([CAIXA_DE_DOZE]);
    await confirmar(noteId);

    // R$ 12,00 a caixa de 12 = R$ 1,00 o parafuso. Guardar 1200 aqui faria
    // markup, margem e o relatório de lucro mentirem por doze.
    expect(custo(parafuso)).toBe(100);
  });

  it('unidade igual à do cadastro continua entrando 1:1', async () => {
    const parafuso = parafusoEmUnidade();
    const noteId = await importar([
      { ...CAIXA_DE_DOZE, uCom: 'UN', qCom: 30, vUnCom: 1.0, uTrib: 'UN', qTrib: 30 },
    ]);

    expect((await confirmar(noteId)).status).toBe(200);
    expect(saldo(parafuso)).toBe(30);
    expect(custo(parafuso)).toBe(100);
  });
});

// ============================================================================

describe('a nota que NÃO traz a conversão', () => {
  it('unidade diferente e sem uTrib útil RECUSA a nota, dizendo a linha', async () => {
    const parafuso = parafusoEmUnidade();
    // O fornecedor tributa em CX também: a nota não sabe quantos vêm dentro.
    const noteId = await importar([{ ...CAIXA_DE_DOZE, uTrib: 'CX', qTrib: 10 }]);

    const res = await confirmar(noteId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_UNIT_MISMATCH');
    // A mensagem tem de nomear a linha e as duas unidades — senão quem lê não
    // sabe qual item resolver nem o que informar.
    expect(res.body.error.message).toMatch(/Parafuso M8 caixa com 12/);
    expect(res.body.error.message).toMatch(/CX/);
    expect(res.body.error.message).toMatch(/UN/);
    // E NADA entrou: recusar pela metade seria pior que não recusar.
    expect(saldo(parafuso)).toBe(0);
  });

  /*
    A EMBALAGEM DO CADASTRO responde antes de a recusa precisar existir.

    O cadastro do produto passou a declarar a embalagem (GAP-V06: "minha caixa
    é CX e vem com 12"). Quando a nota chega EXATAMENTE nessa embalagem e não
    traz a conversão, perguntar de novo ao conferente seria pedir duas vezes o
    que o sistema já sabe — e a régua da casa é que o sistema não pergunta o
    que pode descobrir com segurança.

    O que NÃO muda: a linha da nota continua mandando (fator informado ganha
    sempre), e o qTrib/qCom do emitente continua vindo antes — o fornecedor
    pode mudar a caixa sem avisar, e quem descreve o que chegou é a NOTA.
  */
  it('a embalagem declarada no cadastro converte a caixa sem perguntar', async () => {
    const parafuso = parafusoEmUnidade();
    getConnection()
      .prepare("UPDATE core_products SET pack_factor = 12, pack_unit = 'CX' WHERE id = ?")
      .run(parafuso);

    // A mesma nota do caso anterior — a que era RECUSADA por não trazer conversão.
    const noteId = await importar([{ ...CAIXA_DE_DOZE, uTrib: 'CX', qTrib: 10 }]);

    expect((await confirmar(noteId)).status).toBe(200);
    expect(saldo(parafuso)).toBe(120); // 10 caixas × 12
    expect(custo(parafuso)).toBe(100); // R$ 12,00 a caixa ÷ 12 = R$ 1,00
  });

  it('embalagem de OUTRA unidade não serve, e a recusa continua', async () => {
    const parafuso = parafusoEmUnidade();
    // O cadastro fala de FARDO; a nota veio em CAIXA. Uma coisa não responde
    // pela outra, e adivinhar aqui entraria mercadoria pela conta errada.
    getConnection()
      .prepare("UPDATE core_products SET pack_factor = 20, pack_unit = 'FD' WHERE id = ?")
      .run(parafuso);

    const noteId = await importar([{ ...CAIXA_DE_DOZE, uTrib: 'CX', qTrib: 10 }]);
    const res = await confirmar(noteId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_UNIT_MISMATCH');
    expect(saldo(parafuso)).toBe(0);
  });

  it('o conferente informa quantas vêm na caixa, e a nota entra', async () => {
    const parafuso = parafusoEmUnidade();
    const noteId = await importar([{ ...CAIXA_DE_DOZE, uTrib: 'CX', qTrib: 10 }]);

    const conf = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, receivedQuantity: 10, conversionFactor: 12 });
    expect(conf.status).toBe(200);

    expect((await confirmar(noteId)).status).toBe(200);
    expect(saldo(parafuso)).toBe(120);
    expect(custo(parafuso)).toBe(100);
  });

  it('a conferência devolve o fator informado — a tela não pode esquecê-lo', async () => {
    const noteId = await importar([{ ...CAIXA_DE_DOZE, uTrib: 'CX', qTrib: 10 }]);
    parafusoEmUnidade();

    await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, receivedQuantity: 10, conversionFactor: 12 });

    const lista = await request(app)
      .get(`/api/v1/core/purchases/notes/${noteId}/items`)
      .set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items[0].conversionFactor).toBe(12);
    // E a unidade da nota volta junto: é o que a tela precisa para escrever
    // "10 CX → 120 UN" em vez de um número solto.
    expect(lista.body.items[0].unit).toBe('CX');
  });
});

// ============================================================================

describe('o produto que a própria nota cadastra', () => {
  it('nasce na unidade da nota e entra 1:1 — não há duas unidades', async () => {
    /*
      Sem cadastro anterior não existe conflito: a unidade do produto É a da
      nota. Recusar aqui seria travar a entrada por um problema que não existe.
    */
    const noteId = await importar([
      { cProd: 'NOVO-1', xProd: 'Arruela nova', uCom: 'CX', qCom: 4, vUnCom: 20.0 },
    ]);

    expect((await confirmar(noteId, true)).status).toBe(200);

    const criado = getConnection()
      .prepare("SELECT id, unit FROM core_products WHERE company_id = ? AND name = 'Arruela nova'")
      .get(companyId) as { id: string; unit: string };
    expect(criado.unit).toBe('CX');
    expect(saldo(criado.id)).toBe(4);
  });
});
