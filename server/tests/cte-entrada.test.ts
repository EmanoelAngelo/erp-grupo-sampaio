/**
 * ENTRADA DE CT-e — o documento do TRANSPORTE, que não existia (rodada 44).
 *
 * A transportadora emite o conhecimento (modelo 57) contra quem paga o frete,
 * e até esta rodada o sistema não tinha onde recebê-lo: o parser da entrada
 * recusava qualquer XML sem `infNFe` como "não parece ser uma NF-e", e o
 * frete ficava sem registro próprio — órfão do lado de quem paga.
 *
 * O desenho: parser próprio (infCte), tabela própria com UNIQUE por chave
 * (idempotência igual à da nota), e o vínculo com as NF-e transportadas é
 * DERIVADO — o CT-e guarda as chaves referenciadas e o join com
 * core_inbound_notes resolve na leitura. O e-mail vira canal também: anexo
 * XML que não é NF-e tenta CT-e antes de ser declarado inválido.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - aceite XML sem infCte e o caso "NF-e não é CT-e" fica vermelho;
 *   - troque o INSERT das referências para gravar só a primeira chave e o
 *     caso do vínculo fica vermelho;
 *   - remova o try de CT-e do e-mail e o caso do canal fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { parseCteXml } from '../src/services/core/CteImportService.js';
import { processIncomingMail, upsertInbox } from '../src/services/core/MailInboxService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

const CHAVE_CTE = '43260899999999000191570010000001231000001235';
const CHAVE_NFE_1 = '43260814200166000187550010000009015000000010';
const CHAVE_NFE_2 = '43260814200166000187550010000009025000000020';

function cteXml(accessKey = CHAVE_CTE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cteProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/cte">
  <CTe>
    <infCte Id="CTe${accessKey}" versao="4.00">
      <ide>
        <CFOP>5353</CFOP><natOp>Transporte rodoviario</natOp><mod>57</mod>
        <serie>1</serie><nCT>123</nCT><dhEmi>2026-08-21T08:00:00-03:00</dhEmi>
      </ide>
      <emit><CNPJ>99999999000191</CNPJ><xNome>Transportadora Pampa</xNome></emit>
      <vPrest><vTPrest>350.00</vTPrest><vRec>350.00</vRec></vPrest>
      <infCTeNorm>
        <infDoc>
          <infNFe><chave>${CHAVE_NFE_1}</chave></infNFe>
          <infNFe><chave>${CHAVE_NFE_2}</chave></infNFe>
        </infDoc>
      </infCTeNorm>
    </infCte>
  </CTe>
</cteProc>`;
}

function nfeXml(accessKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${accessKey}" versao="4.00">
      <ide><nNF>901</nNF><serie>1</serie><dhEmi>2026-08-20T09:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Alfa</xNome></emit>
      <det nItem="1"><prod>
        <cProd>A-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Mercadoria</xProd>
        <NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>
        <qCom>2</qCom><vUnCom>10.00</vUnCom><vProd>20.00</vProd>
      </prod></det>
      <total><ICMSTot><vNF>20.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

async function importarCte(xml = cteXml()) {
  return request(app).post('/api/v1/core/purchases/cte/import').set(auth).send({ xml });
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-cte',
    companyId: 'loja-cte',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

describe('o parser do conhecimento', () => {
  it('lê chave, transportadora, valor do frete e as chaves das NF-e transportadas', () => {
    const parsed = parseCteXml(cteXml());
    expect(parsed.accessKey).toBe(CHAVE_CTE);
    expect(parsed.carrierCnpj).toBe('99999999000191');
    expect(parsed.carrierName).toBe('Transportadora Pampa');
    expect(parsed.freightCents).toBe(35000);
    expect(parsed.number).toBe('123');
    expect(parsed.nfeKeys).toEqual([CHAVE_NFE_1, CHAVE_NFE_2]);
  });

  it('NF-e não é CT-e: a recusa diz o que faltou', () => {
    expect(() => parseCteXml(nfeXml(CHAVE_NFE_1))).toThrowError(/infCte/);
  });
});

describe('a importação', () => {
  it('grava o CT-e com TODAS as chaves referenciadas, e reimportar não duplica', async () => {
    const primeira = await importarCte();
    expect(primeira.status).toBe(201);
    expect(primeira.body.duplicated).toBe(false);

    const refs = getConnection()
      .prepare(
        'SELECT nfe_access_key FROM core_cte_referenced_notes WHERE company_id = ? ORDER BY nfe_access_key',
      )
      .all(companyId) as { nfe_access_key: string }[];
    expect(refs.map((r) => r.nfe_access_key)).toEqual([CHAVE_NFE_1, CHAVE_NFE_2].sort());

    const segunda = await importarCte();
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicated).toBe(true);
    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_cte_documents WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(total.n).toBe(1);
  });

  it('a lista mostra o vínculo DERIVADO: quantas NF-e do frete já estão no funil', async () => {
    await importarCte();
    // Uma das duas notas transportadas entra pelo canal normal.
    const nota = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: nfeXml(CHAVE_NFE_1) });
    expect(nota.status).toBe(201);

    const lista = await request(app).get('/api/v1/core/purchases/cte').set(auth);
    expect(lista.status).toBe(200);
    const cte = lista.body.items[0];
    expect(cte.accessKey).toBe(CHAVE_CTE);
    expect(cte.freightCents).toBe(35000);
    expect(cte.notas).toHaveLength(2);
    const daNota = cte.notas.find((x: { accessKey: string }) => x.accessKey === CHAVE_NFE_1);
    const semNota = cte.notas.find((x: { accessKey: string }) => x.accessKey === CHAVE_NFE_2);
    expect(daNota.noteId).toBeTruthy();
    expect(semNota.noteId).toBeNull();
  });

  it('XML de NF-e na rota de CT-e é recusado com 400', async () => {
    const res = await importarCte(nfeXml(CHAVE_NFE_1));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_XML_NOT_CTE');
  });
});

describe('o canal do e-mail', () => {
  function caixa(): string {
    const status = upsertInbox({
      companyId,
      address: 'compras@grupo.com',
      host: 'imap.exemplo.com',
      password: 'segredo',
    });
    return status.inbox!.id;
  }

  function email(inboxId: string, uid: string, conteudo: string | Buffer, nome = 'doc.xml') {
    return processIncomingMail({
      companyId,
      userId: 'u-mail',
      inboxId,
      mail: {
        uid,
        subject: 'Documentos',
        from: 'transportadora@pampa.com',
        date: new Date().toISOString(),
        attachments: [{ filename: nome, contentType: 'text/xml', content: conteudo }],
      },
    } as Parameters<typeof processIncomingMail>[0]);
  }

  it('e-mail SÓ de CT-e novo vira situação própria — frete não é nota em conferência', async () => {
    // A revisão adversarial mordeu: 'importado' fazia a tela anunciar uma
    // nota em conferência que não existe — CT-e não tem itens nem funil.
    const inboxId = caixa();
    const r = email(inboxId, 'uid-frete-1', cteXml());
    expect(String(r.outcome)).toBe('frete');
    expect(String(r.detail ?? '')).toMatch(/frete/i);
  });

  it('o MESMO CT-e reenviado (uid novo) é DUPLICADO — não novidade', async () => {
    // A revisão adversarial mordeu: fretes += 1 incondicional fazia o
    // reenvio virar "importado" — a NF-e reenviada, corretamente, não.
    const inboxId = caixa();
    email(inboxId, 'uid-frete-1', cteXml());
    const reenvio = email(inboxId, 'uid-frete-2', cteXml());
    expect(String(reenvio.outcome)).toBe('duplicado');
    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_cte_documents WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(total.n).toBe(1);
  });

  it('anexo GIGANTE é recusado antes de qualquer parse — 2 MB é o teto por arquivo', async () => {
    const inboxId = caixa();
    const gigante = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const r = email(inboxId, 'uid-gigante', gigante, 'bomba.xml');
    expect(String(r.outcome)).toBe('invalido');
    expect(String(r.detail ?? '')).toMatch(/grande demais/);
  });

  it('anexo que não é NF-e tenta CT-e — a transportadora manda o conhecimento por e-mail', async () => {
    const status = upsertInbox({
      companyId,
      address: 'compras@grupo.com',
      host: 'imap.exemplo.com',
      password: 'segredo',
    });
    const resultado = processIncomingMail({
      companyId,
      userId: 'u-mail',
      inboxId: status.inbox!.id,
      mail: {
        uid: 'msg-cte-1',
        subject: 'Conhecimento de transporte',
        from: 'transportadora@pampa.com',
        date: new Date().toISOString(),
        attachments: [
          { filename: 'cte-123.xml', contentType: 'text/xml', content: cteXml() },
        ],
      },
    } as Parameters<typeof processIncomingMail>[0]);
    // Com a revisão, e-mail só de CT-e tem situação própria: 'frete'.
    expect(String(resultado.outcome)).toBe('frete');
    expect(String(resultado.detail ?? '')).toMatch(/frete|CT-e/i);

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_cte_documents WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(total.n).toBe(1);
  });
});
