/**
 * DISTRIBUIÇÃO DF-e E MANIFESTAÇÃO DO DESTINATÁRIO — rodada 44.
 *
 * Até aqui a nota do fornecedor só entrava se ALGUÉM a trouxesse: upload ou
 * e-mail. A fonte oficial — as notas emitidas CONTRA o CNPJ do grupo, que a
 * SEFAZ entrega pela Distribuição DF-e — não existia, e manifestação do
 * destinatário (ciência, confirmação, desconhecimento, operação não
 * realizada) não tinha nem tabela.
 *
 * O desenho segue o padrão fiscal da casa:
 *   - o adapter é INJETADO (simulador hoje; o SOAP real é a rodada 46, e o
 *     método ausente responde 501, como a CC-e fazia);
 *   - NSU é o cursor: UNIQUE (company, nsu) torna a reconsulta idempotente e
 *     o próximo lote parte de MAX(nsu);
 *   - manifestação só muda estado com PROTOCOLO aceito, e o pedido e o
 *     desfecho ficam em core_fiscal_events, append-only;
 *   - ciência LIBERA o download: aceita a ciência, o serviço já baixa o
 *     procNFe completo na mesma conversa — e só ele pode ser importado para o
 *     funil de conferência.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - troque o INSERT OR IGNORE por INSERT e a reconsulta explode em vez de
 *     devolver 0 novos;
 *   - deixe a manifestação gravar status sem conferir o protocolo e o caso da
 *     rejeição fica vermelho;
 *   - aceite importar resNFe e o caso do resumo fica vermelho — resumo não
 *     tem item, e nota sem item não se confere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { manifestarDfe } from '../src/services/core/DfeDistribuicaoService.js';
import { loginForTest } from './helpers/auth.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

function configurarFiscal(alvo: string) {
  updateFiscalConfig({
    companyId: alvo,
    patch: {
      legalName: 'Operação Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(alvo);
}

/*
  O SIMULADOR POR PEDIDO EXPLÍCITO (GAP-PRD-168). A consulta e a manifestação
  passaram a decidir pela política dos atos: sem `developmentMode`, vão à
  SEFAZ com o A1 do cofre — e sem A1, 409 dizendo onde enviá-lo. Esta suíte
  mede o domínio sobre o simulador, então PEDE o simulador, como a
  inutilização pede. O caminho real está em `dfe-pela-politica-dos-atos`.
*/
async function consultar() {
  return request(app).post('/api/v1/core/purchases/dfe/consultar').set(auth).send({ developmentMode: true });
}

function documentos(): { nsu: string; schema_type: string; access_key: string | null; manifest_status: string | null; xml: string | null }[] {
  return getConnection()
    .prepare(
      `SELECT nsu, schema_type, access_key, manifest_status, xml
         FROM core_dfe_documents WHERE company_id = ? ORDER BY CAST(nsu AS INTEGER)`,
    )
    .all(companyId) as never[];
}

function eventos(): { event_type: string; protocol: string | null; c_stat: string | null }[] {
  return getConnection()
    .prepare(
      "SELECT event_type, protocol, c_stat FROM core_fiscal_events WHERE company_id = ? AND event_type LIKE 'dfe_%' ORDER BY created_at",
    )
    .all(companyId) as never[];
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-dfe',
    companyId: 'loja-dfe',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  configurarFiscal(companyId);
});

describe('a consulta por NSU', () => {
  it('primeira consulta grava os documentos; reconsultar devolve 0 novos e NÃO duplica', async () => {
    const primeira = await consultar();
    expect(primeira.status).toBe(200);
    expect(primeira.body.novos).toBeGreaterThan(0);

    const antes = documentos();
    expect(antes.length).toBe(primeira.body.novos);
    // Todo resumo tem chave de 44 dígitos e tipo declarado.
    for (const d of antes) {
      expect(d.schema_type).toBe('resNFe');
      expect(d.access_key).toMatch(/^\d{44}$/);
    }

    const segunda = await consultar();
    expect(segunda.status).toBe(200);
    expect(segunda.body.novos).toBe(0);
    expect(documentos().length).toBe(antes.length);
  });

  it('developmentMode com senha ERRADA no corpo não derruba o simulador — o slot real é preguiçoso', async () => {
    // A revisão da rodada 46 mordeu: o slot real era construído SEMPRE, e a
    // senha lixo explodia um fluxo que ia usar o provider de teste.
    const res = await request(app)
      .post('/api/v1/core/purchases/dfe/consultar')
      .set(auth)
      .send({ developmentMode: true, certificatePassword: 'senha-lixo' });
    expect(res.status).toBe(200);
  });

  it('sem CNPJ fiscal configurado a consulta é recusada com o motivo', async () => {
    const semFiscal = await loginForTest(app, {
      userId: 'gerente-sem-cnpj',
      companyId: 'loja-sem-cnpj',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .post('/api/v1/core/purchases/dfe/consultar')
      .set({ Authorization: `Bearer ${semFiscal.body.accessToken}` })
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_CNPJ_REQUIRED');
  });

  it('estoquista consulta e lista — mas NÃO manifesta: manifestação é ato fiscal de gerência', async () => {
    const estoquista = await loginForTest(app, {
      userId: 'estoquista-dfe',
      companyId: 'loja-dfe',
      profileCodes: ['estoquista'],
    });
    const cabecalho = { Authorization: `Bearer ${estoquista.body.accessToken}` };
    expect(
      (await request(app).post('/api/v1/core/purchases/dfe/consultar').set(cabecalho).send({ developmentMode: true }))
        .status,
    ).toBe(200);
    expect((await request(app).get('/api/v1/core/purchases/dfe').set(cabecalho)).status).toBe(200);

    const chave = documentos()[0].access_key!;
    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(cabecalho)
      .send({ developmentMode: true, tipo:'ciencia' });
    expect(res.status).toBe(403);
  });
});

describe('a manifestação', () => {
  async function comDocumentos(): Promise<string> {
    await consultar();
    return documentos()[0].access_key!;
  }

  it('ciência: grava status + protocolo, registra o par de eventos e BAIXA o XML completo', async () => {
    const chave = await comDocumentos();
    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'ciencia' });
    expect(res.status).toBe(200);

    const doc = documentos().find((d) => d.access_key === chave)!;
    expect(doc.manifest_status).toBe('ciencia');
    // Ciência liberou o download: o documento agora É a nota completa.
    expect(doc.schema_type).toBe('procNFe');
    expect(doc.xml).toContain('infNFe');

    const trilha = eventos().map((e) => e.event_type);
    expect(trilha).toContain('dfe_manifest_ciencia_requested');
    expect(trilha).toContain('dfe_manifest_ciencia_authorized');
    const aceite = eventos().find((e) => e.event_type === 'dfe_manifest_ciencia_authorized')!;
    expect(aceite.protocol).toBeTruthy();
  });

  it('confirmação é DEFINITIVA: desconhecer depois é recusado', async () => {
    const chave = await comDocumentos();
    await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'confirmacao' });
    expect(documentos().find((d) => d.access_key === chave)!.manifest_status).toBe('confirmacao');

    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'desconhecimento' });
    expect(res.status).toBe(409);
    expect(documentos().find((d) => d.access_key === chave)!.manifest_status).toBe('confirmacao');
  });

  it('operação não realizada EXIGE justificativa de verdade (15+ caracteres, como a SEFAZ)', async () => {
    const chave = await comDocumentos();
    const sem = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'nao_realizada' });
    expect(sem.status).toBe(400);

    const curta = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'nao_realizada', justification: 'curta' });
    expect(curta.status).toBe(400);
    expect(documentos().find((d) => d.access_key === chave)!.manifest_status).toBeNull();
  });

  it('rejeição da SEFAZ NÃO grava status — sem protocolo não houve manifestação', async () => {
    const chave = await comDocumentos();
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');
    await expect(
      manifestarDfe({ companyId, userId: 'u-1', accessKey: chave, tipo: 'ciencia', adapter }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_MANIFEST_REJECTED' });

    expect(documentos().find((d) => d.access_key === chave)!.manifest_status).toBeNull();
    const trilha = eventos().map((e) => e.event_type);
    expect(trilha).toContain('dfe_manifest_ciencia_requested');
    expect(trilha).toContain('dfe_manifest_ciencia_rejected');
    expect(trilha).not.toContain('dfe_manifest_ciencia_authorized');
  });

  it("tipo herdado do prototype ('toString') é 400 — a revisão adversarial mordeu aqui", async () => {
    // TIPOS_MANIFESTACAO é objeto literal: sem o hasOwnProperty, 'toString'
    // devolvia a função herdada (truthy), passava a guarda e gravava
    // manifest_status='toString' com evento fiscal lixo e protocolo aceito.
    await consultar();
    const chave = documentos()[0].access_key!;
    for (const tipoLixo of ['toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
      const res = await request(app)
        .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
        .set(auth)
        .send({ developmentMode: true, tipo:tipoLixo });
      expect(res.status).toBe(400);
    }
    expect(documentos()[0].manifest_status).toBeNull();
  });

  it('o rastro fiscal carrega a CHAVE — pedido e rejeição não são órfãos', async () => {
    await consultar();
    const chave = documentos()[0].access_key!;
    const adapter = new SefazTestAdapter();
    adapter.setEventScenario('EVENT_REJECTED');
    await expect(
      manifestarDfe({ companyId, userId: 'u-1', accessKey: chave, tipo: 'ciencia', adapter }),
    ).rejects.toMatchObject({ code: 'CORE_DFE_MANIFEST_REJECTED' });

    // Numa disputa ('vocês tentaram manifestar a nota X?'), o rastro responde:
    // cada linha, inclusive a rejeitada, carrega a chNFe no campo do XML.
    const linhas = getConnection()
      .prepare(
        "SELECT event_type, xml FROM core_fiscal_events WHERE company_id = ? AND event_type LIKE 'dfe_%'",
      )
      .all(companyId) as { event_type: string; xml: string | null }[];
    expect(linhas.length).toBeGreaterThan(0);
    for (const linha of linhas) {
      expect(linha.xml).toContain(chave);
    }
  });

  it('chave desconhecida é 404 — não se manifesta o que a SEFAZ não entregou', async () => {
    await comDocumentos();
    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${'9'.repeat(44)}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'ciencia' });
    expect(res.status).toBe(404);
  });
});

describe('do DF-e para o funil de conferência', () => {
  it('RESUMO não se importa: a recusa explica que a ciência libera a nota completa', async () => {
    await consultar();
    const chave = documentos()[0].access_key!;
    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/importar`)
      .set(auth)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_XML_INCOMPLETO');
    expect(String(res.body.error.message)).toMatch(/ci[êe]ncia/i);
  });

  it('depois da ciência, importar cria a nota no funil e amarra o documento a ela', async () => {
    await consultar();
    const chave = documentos()[0].access_key!;
    await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/manifestar`)
      .set(auth)
      .send({ developmentMode: true, tipo:'ciencia' });

    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/importar`)
      .set(auth)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.noteId).toBeTruthy();

    const nota = getConnection()
      .prepare('SELECT id, status, access_key FROM core_inbound_notes WHERE company_id = ? AND access_key = ?')
      .get(companyId, chave) as { id: string; status: string } | undefined;
    expect(nota).toBeTruthy();
    expect(nota!.status).toBe('conferencia');

    const doc = getConnection()
      .prepare('SELECT imported_note_id FROM core_dfe_documents WHERE company_id = ? AND access_key = ?')
      .get(companyId, chave) as { imported_note_id: string | null };
    expect(doc.imported_note_id).toBe(nota!.id);

    // Importar de novo não duplica — o funil já era idempotente por chave.
    const denovo = await request(app)
      .post(`/api/v1/core/purchases/dfe/${chave}/importar`)
      .set(auth)
      .send({});
    expect(denovo.status).toBe(200);
    expect(denovo.body.duplicated).toBe(true);
  });
});
