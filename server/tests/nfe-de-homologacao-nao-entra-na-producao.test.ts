/**
 * ============================================================================
 * NF-e DE HOMOLOGAÇÃO NÃO ENTRA NA PRODUÇÃO (R3-DFE, GAP-PRD-168)
 * ============================================================================
 *
 * A Distribuição DF-e já recusava documento de outro ambiente (409
 * CORE_DFE_OUTRO_AMBIENTE). O upload do XML e o anexo do e-mail não olhavam o
 * `tpAmb` do arquivo: a nota de TESTE do fornecedor (tpAmb=2, sem validade
 * fiscal) entrava no funil de conferência de uma empresa em produção — e a
 * confirmação dava entrada de estoque e gerava conta a pagar de uma compra que
 * não existe perante o fisco.
 *
 * ## A regra (e por que ela não é simétrica)
 *
 *  - empresa em PRODUÇÃO: só entra nota de produção (tpAmb=1). A de
 *    homologação é recusada antes de gravar qualquer coisa; o XML sem tpAmb
 *    legível também (o leiaute exige o campo e a assinatura o cobre — sem ele
 *    não há como afirmar validade fiscal);
 *  - empresa em HOMOLOGAÇÃO: entra a de produção (é compra real: o fisco a
 *    reconhece, e a produção só é liberada depois da homologação real — antes
 *    dela a loja já recebe mercadoria de verdade) e a de homologação (é o
 *    ensaio que o ambiente declara).
 *
 * ## Como fica vermelho
 *
 *  - tire a recusa do `importNfe` e o upload, o e-mail e a nota completa da
 *    DF-e entram no funil;
 *  - tire a recusa da confirmação e a nota de homologação que entrou antes da
 *    trava move estoque e gera conta a pagar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

vi.mock('imapflow', async () => (await import('./helpers/imapFalso.js')).moduloImapFalso);

const request = (await import('supertest')).default;
const imap = await import('./helpers/imapFalso.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { checkInbox, processIncomingMail, upsertInbox } = await import(
  '../src/services/core/MailInboxService.js'
);
const { loginForTest } = await import('./helpers/auth.js');

const app = createApp();

const FORNECEDOR = '14200166000187';

let auth: { Authorization: string };
let empresa: string;
let usuario: string;

type TpAmb = '1' | '2' | null;

/** Chave de 44 dígitos distinta por número. */
function chave(n: number): string {
  return `432609${FORNECEDOR}55001${String(300 + n).padStart(9, '0')}1${String(n).padStart(8, '0')}5`;
}

/** NF-e parseável; `tpAmb` null = o arquivo não traz o campo. */
function nfeXml(n: number, tpAmb: TpAmb): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    '<NFe>',
    `<infNFe Id="NFe${chave(n)}" versao="4.00">`,
    `<ide><nNF>${n}</nNF><serie>1</serie><dhEmi>2026-09-01T09:00:00-03:00</dhEmi>`
      + (tpAmb ? `<tpAmb>${tpAmb}</tpAmb>` : '')
      + '</ide>',
    `<emit><CNPJ>${FORNECEDOR}</CNPJ><xNome>Distribuidora do Ensaio Ltda</xNome></emit>`,
    '<det nItem="1"><prod>',
    `<cProd>HOM-${n}</cProd><cEAN>SEM GTIN</cEAN><xProd>Bateria de teste ${n}</xProd>`,
    '<NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>',
    '<qCom>4</qCom><vUnCom>25.00</vUnCom><vProd>100.00</vProd>',
    '</prod></det>',
    '<total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>',
    '</infNFe>',
    '</NFe>',
    /*
      A NOTA DE PRODUÇÃO VEM COM O PROTOCOLO (B-estoque-entrada-M02).

      Este arquivo nasceu sem `protNFe`, e a empresa em produção importava
      assim mesmo. O comportamento MUDOU de propósito: com a empresa em
      produção, a importação passou a exigir o protocolo de autorização da
      SEFAZ (cStat 100 e a chave do protocolo igual à da nota) — o XML sem ele é
      o arquivo gerado antes da autorização, que pode nunca ter existido perante
      o fisco. A nota de produção deste teste é a AUTORIZADA; a de homologação e
      a sem tpAmb continuam sem protocolo, e são recusadas antes pela trava do
      ambiente, que é o que este arquivo cobra.
    */
    tpAmb === '1'
      ? `<protNFe><infProt><tpAmb>1</tpAmb><chNFe>${chave(n)}</chNFe><cStat>100</cStat>`
        + '<xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>143260000000001</nProt></infProt></protNFe>'
      : '',
    '</nfeProc>',
  ].join('');
}

function ambienteDaEmpresa(ambiente: 'homologation' | 'production'): void {
  getConnection()
    .prepare('UPDATE core_fiscal_configs SET environment = ? WHERE company_id = ?')
    .run(ambiente, empresa);
}

function contar(tabela: string): number {
  return (
    getConnection().prepare(`SELECT COUNT(*) AS n FROM ${tabela} WHERE company_id = ?`).get(empresa) as {
      n: number;
    }
  ).n;
}

function importar(xml: string) {
  return request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
}

function previa(xml: string) {
  return request(app).post('/api/v1/core/purchases/nfe/preview').set(auth).send({ xml });
}

function mensagens(): { outcome: string; detail: string; note_id: string | null; provider_uid: string }[] {
  return getConnection()
    .prepare('SELECT outcome, detail, note_id, provider_uid FROM core_mail_messages WHERE company_id = ? ORDER BY created_at')
    .all(empresa) as never[];
}

beforeEach(async () => {
  resetDbForTests();
  imap.reiniciarImap();
  const res = await loginForTest(app, { userId: 'gerente-tpamb', companyId: 'loja-tpamb', profileCodes: ['gerente_loja'] });
  expect(res.status).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  empresa = res.body.company.id;
  usuario = res.body.user.id;
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Loja do Ambiente Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upload do XML numa empresa em PRODUÇÃO', () => {
  it('nota de homologação (tpAmb=2): 409 dizendo o que é e o que pedir, e nada gravado — nem nota, nem fornecedor', async () => {
    ambienteDaEmpresa('production');

    const res = await importar(nfeXml(1, '2'));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NFE_DE_HOMOLOGACAO');
    expect(res.body.error.message).toMatch(/homologação/);
    expect(res.body.error.message).toMatch(/não tem validade fiscal/);
    expect(res.body.error.message).toMatch(/peça ao fornecedor a nota de produção/i);
    expect(contar('core_inbound_notes')).toBe(0);
    expect(contar('core_inbound_note_items')).toBe(0);
    expect(contar('core_suppliers')).toBe(0);
  });

  it('a prévia já recusa — a tela não oferece conferir o que não pode entrar', async () => {
    ambienteDaEmpresa('production');

    const res = await previa(nfeXml(1, '2'));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_NFE_DE_HOMOLOGACAO');
    expect(contar('core_suppliers')).toBe(0);
  });

  it('XML sem tpAmb legível: recusado com o próprio código — não dá para afirmar validade fiscal', async () => {
    ambienteDaEmpresa('production');

    const res = await importar(nfeXml(2, null));

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_NFE_AMBIENTE_ILEGIVEL');
    expect(res.body.error.message).toMatch(/tpAmb/);
    expect(contar('core_inbound_notes')).toBe(0);
  });

  it('nota de produção (tpAmb=1): importa como sempre', async () => {
    ambienteDaEmpresa('production');

    const res = await importar(nfeXml(3, '1'));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicated).toBe(false);
    expect(contar('core_inbound_notes')).toBe(1);
  });
});

describe('empresa em HOMOLOGAÇÃO (o ensaio, antes da virada)', () => {
  it('a nota de homologação entra — é o ensaio que o ambiente declara', async () => {
    const res = await importar(nfeXml(4, '2'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('a nota de produção também entra — é compra real, e a loja recebe mercadoria antes da virada', async () => {
    const res = await importar(nfeXml(5, '1'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('a nota de homologação que entrou ANTES da trava não se confirma em produção', () => {
  it('confirmar: 409, sem movimento de estoque nem conta a pagar', async () => {
    // Entrou com a empresa em homologação; depois a empresa virou.
    const imp = await importar(nfeXml(6, '2'));
    expect(imp.status).toBe(201);
    ambienteDaEmpresa('production');

    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${imp.body.noteId}/confirm`)
      .set(auth)
      .send({ createMissing: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NFE_DE_HOMOLOGACAO');
    expect(contar('core_stock_movements')).toBe(0);
    expect(contar('core_finance_entries')).toBe(0);
    const nota = getConnection().prepare('SELECT status FROM core_inbound_notes WHERE id = ?').get(imp.body.noteId) as {
      status: string;
    };
    expect(nota.status).not.toBe('recebida');
  });
});

describe('a releitura do XML guardado não usa a nota de homologação numa empresa em produção', () => {
  it('fica de fora, contada à parte — nem completa cadastro nem gera sugestão', async () => {
    const imp = await importar(nfeXml(13, '2'));
    expect(imp.status).toBe(201);
    ambienteDaEmpresa('production');
    const sugestoesAntes = contar('core_product_fiscal_suggestions');

    const res = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ notasLidas: 0, notasSemValidadeFiscal: 1 });
    expect(contar('core_product_fiscal_suggestions')).toBe(sugestoesAntes);
  });
});

describe('pelo e-mail: recusada, registrada com o motivo, e a caixa não trava', () => {
  function inbox(): string {
    return upsertInbox({ companyId: empresa, address: 'notas@loja.com.br', host: 'imap.exemplo.test', password: 'senha-de-app-falsa' })
      .inbox!.id;
  }

  it('a mensagem fica registrada como recusada com o porquê; relida, não é reprocessada', () => {
    ambienteDaEmpresa('production');
    const inboxId = inbox();
    const mail = {
      uid: 'v1:7@INBOX',
      subject: 'NF-e de teste',
      from: 'fornecedor@exemplo.com.br',
      date: new Date().toISOString(),
      attachments: [{ filename: 'nfe-hom.xml', content: nfeXml(7, '2'), contentType: 'text/xml' }],
    };

    const primeira = processIncomingMail({ companyId: empresa, userId: usuario, inboxId, mail });

    expect(primeira.outcome).toBe('recusado');
    expect(primeira.detail).toMatch(/nfe-hom\.xml/);
    expect(primeira.detail).toMatch(/homologação/);
    expect(primeira.detail).toMatch(/não tem validade fiscal/);
    expect(primeira.note_id).toBeNull();
    expect(contar('core_inbound_notes')).toBe(0);

    const segunda = processIncomingMail({ companyId: empresa, userId: usuario, inboxId, mail });
    expect(segunda.id).toBe(primeira.id);
    expect(mensagens()).toHaveLength(1);
    expect(contar('core_inbound_notes')).toBe(0);
  });

  it('pela leitura da caixa: a recusada é marcada como lida e a leitura seguinte não a pega de novo', async () => {
    ambienteDaEmpresa('production');
    inbox();
    imap.entregar(imap.emailCru({ assunto: 'NF-e de teste', anexo: { nome: 'nfe-hom.xml', conteudo: nfeXml(8, '2') } }));
    imap.entregar(imap.emailCru({ assunto: 'NF-e de verdade', anexo: { nome: 'nfe-prod.xml', conteudo: nfeXml(9, '1') } }));

    const primeira = await checkInbox({ companyId: empresa, userId: usuario });
    const segunda = await checkInbox({ companyId: empresa, userId: usuario });

    expect(primeira.checked).toBe(2);
    expect(segunda.checked).toBe(0);
    expect(imap.lida(1)).toBe(true);
    expect(imap.lida(2)).toBe(true);
    expect(mensagens().map((m) => m.outcome).sort()).toEqual(['importado', 'recusado']);
    expect(contar('core_inbound_notes')).toBe(1);
  });

  it('na mesma mensagem, a de produção entra e a de homologação é recusada — o pior caso dá o rótulo', () => {
    ambienteDaEmpresa('production');
    const inboxId = inbox();

    const r = processIncomingMail({
      companyId: empresa,
      userId: usuario,
      inboxId,
      mail: {
        uid: 'v1:10@INBOX',
        attachments: [
          { filename: 'prod.xml', content: nfeXml(10, '1'), contentType: 'text/xml' },
          { filename: 'hom.xml', content: nfeXml(11, '2'), contentType: 'text/xml' },
        ],
      },
    });

    expect(r.outcome).toBe('recusado');
    expect(r.detail).toMatch(/1 importada/);
    expect(r.detail).toMatch(/1 recusada/);
    expect(r.note_id).not.toBeNull();
    expect(contar('core_inbound_notes')).toBe(1);
  });
});

describe('pela Distribuição DF-e: a nota completa passa pelo mesmo funil', () => {
  it('documento do ambiente de produção cujo XML diz tpAmb=2: recusado no importNfe, nada no funil', async () => {
    ambienteDaEmpresa('production');
    getConnection()
      .prepare(
        `INSERT INTO core_dfe_documents (id, company_id, environment, nsu, schema_type, access_key, xml, received_at)
         VALUES ('dfe-hom', ?, 'production', '1', 'procNFe', ?, ?, ?)`,
      )
      .run(empresa, chave(12), nfeXml(12, '2'), new Date().toISOString());

    const res = await request(app).post(`/api/v1/core/purchases/dfe/${chave(12)}/importar`).set(auth).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NFE_DE_HOMOLOGACAO');
    expect(contar('core_inbound_notes')).toBe(0);
  });
});
