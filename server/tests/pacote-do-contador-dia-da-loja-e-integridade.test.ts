/**
 * ============================================================================
 * O PACOTE DO CONTADOR: A DATA É A DA LOJA, E O ZIP PROVA QUE É ELE
 * (GAP-PRD-051, GAP-PRD-176)
 * ============================================================================
 *
 * GAP-PRD-051 — O RECORTE ERA O DA LOJA, A DATA IMPRESSA NÃO.
 *
 * `periodBounds`/`diaDaLojaSql` já recortavam o mês pelo calendário de
 * Pelotas: a nota autorizada às 21h30 de 31/07 entra no pacote de julho. Mas o
 * manifesto e o CSV de inutilizações escreviam `String(instante).slice(0,10)`
 * — o dia de GREENWICH. A mesma nota aparecia datada 2026-08-01 dentro do
 * pacote de julho: a linha contradizia o próprio pacote, e o `dhEmi` do XML
 * (com -03:00) contradizia a linha.
 *
 * GAP-PRD-176 — O PACOTE NÃO TINHA COMO PROVAR QUE ERA ELE.
 *
 * Numa disputa ("o arquivo que o contador recebeu é o que o sistema gerou?")
 * a resposta era uma descrição textual. Agora:
 *
 *   - o MANIFESTO traz o SHA-256 de cada arquivo;
 *   - o LEIA-ME traz o SHA-256 do MANIFESTO (um arquivo não pode conter o
 *     próprio hash — o MANIFESTO amarra todos os outros, e o LEIA-ME o amarra);
 *   - o SHA-256 do ZIP sai no cabeçalho do download, na trilha de auditoria e
 *     no corpo do e-mail;
 *   - e a gestão ou o contador conferem um hash contra o que o sistema
 *     registrou ter entregue.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { montarPacote } from '../src/services/core/FiscalClosingService.js';
import { criarDestinatario, enviarPacotePorEmail } from '../src/services/core/ContadorEnvioService.js';
import { sanitizeResponse } from '../src/services/core/SefazAdapter.js';
import { NOTA_RECEBIDA } from '../src/services/core/InboundNoteStatus.js';

const app = createApp();
const PERIODO = '2026-07';
/** 31/07 às 21h30 em Pelotas — 01/08 às 00h30 em Greenwich. */
const NOITE_DE_31 = '2026-08-01T00:30:00.000Z';

let auth: { Authorization: string };
let companyId: string;
let sequencia = 0;

beforeEach(async () => {
  resetDbForTests();
  sequencia = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-integridade',
    companyId: 'preco-justo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

// ---------------------------------------------------------------------------
// Cenário — os mesmos valores que o pipeline grava (ver fechamento-contador)
// ---------------------------------------------------------------------------

function chave(n: number): string {
  return `3526071420016600018755001${String(n).padStart(19, '0')}`;
}

function xmlAssinado(k: string): string {
  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${k}">`
    + '<ide><nNF>1</nNF></ide></infNFe>'
    + '<Signature><SignatureValue>YXNzaW5hdHVyYQ==</SignatureValue></Signature></NFe>';
}

function documento(emissao: string, over: { xmlSigned?: string | null } = {}): string {
  sequencia += 1;
  const id = randomUUID();
  const k = chave(sequencia);
  const protocolo = `1352600001${sequencia}`;
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, model, serie, number, access_key, environment, status,
          xml_signed, xml_authorized, protocol, issued_at, authorized_at,
          created_at, updated_at)
       VALUES (?, ?, '55', 1, ?, ?, 'production', 'AUTHORIZED', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      sequencia,
      k,
      over.xmlSigned === undefined ? xmlAssinado(k) : over.xmlSigned,
      sanitizeResponse(
        `<retEnviNFe><protNFe><infProt><chNFe>${k}</chNFe><nProt>${protocolo}</nProt>`
          + `<cStat>100</cStat></infProt></protNFe>${xmlAssinado(k)}</retEnviNFe>`,
      ),
      protocolo,
      emissao,
      emissao,
      emissao,
      emissao,
    );
  return k;
}

function evento(input: {
  documentId?: string | null;
  tipo: string;
  quando: string;
  model?: string;
  serie?: number;
  de?: number;
  ate?: number;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_events
         (id, company_id, document_id, event_type, sequence, protocol, xml, xml_proc,
          model, serie, number_from, number_to, created_at)
       VALUES (?, ?, ?, ?, 1, '135260009999', ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      companyId,
      input.documentId ?? null,
      input.tipo,
      '<retEvento><infEvento><cStat>135</cStat></infEvento></retEvento>',
      input.model ?? null,
      input.serie ?? null,
      input.de ?? null,
      input.ate ?? null,
      input.quando,
    );
}

function documentoId(k: string): string {
  return (
    getConnection().prepare('SELECT id FROM core_fiscal_documents WHERE access_key = ?').get(k) as {
      id: string;
    }
  ).id;
}

function notaRecebida(entrada: string): string {
  sequencia += 1;
  const k = chave(9000 + sequencia);
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, series, total_cents, status,
          received_at, issued_at, xml_original, doc_type, created_at)
       VALUES (?, ?, ?, ?, '1', 15000, ?, ?, ?, '<nfeProc><NFe>compra</NFe></nfeProc>', 'nfe', ?)`,
    )
    .run(randomUUID(), companyId, k, String(2000 + sequencia), NOTA_RECEBIDA, entrada, entrada, entrada);
  return k;
}

/** Abre o zip pelo diretório central e devolve os BYTES de cada arquivo. */
function abrirZip(zip: Buffer): Map<string, Buffer> {
  const fim = zip.length - 22;
  expect(zip.readUInt32LE(fim)).toBe(0x06054b50);
  const entradas = zip.readUInt16LE(fim + 10);
  let cursor = zip.readUInt32LE(fim + 16);
  const saida = new Map<string, Buffer>();
  for (let i = 0; i < entradas; i += 1) {
    const tamanhoNome = zip.readUInt16LE(cursor + 28);
    const tamanhoExtra = zip.readUInt16LE(cursor + 30);
    const tamanhoComentario = zip.readUInt16LE(cursor + 32);
    const offsetLocal = zip.readUInt32LE(cursor + 42);
    const nome = zip.subarray(cursor + 46, cursor + 46 + tamanhoNome).toString('utf8');
    const comprimido = zip.readUInt32LE(offsetLocal + 18);
    const nomeLocal = zip.readUInt16LE(offsetLocal + 26);
    const extraLocal = zip.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;
    saida.set(nome, inflateRawSync(zip.subarray(inicio, inicio + comprimido)));
    cursor += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return saida;
}

const sha256 = (dado: Buffer | Uint8Array | string): string =>
  createHash('sha256').update(dado).digest('hex');

function linhasDoManifesto(dentro: Map<string, Buffer>): string[] {
  return dentro.get('MANIFESTO.csv')!.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n');
}

// ---------------------------------------------------------------------------
// GAP-PRD-051 — toda data do pacote é o dia da loja
// ---------------------------------------------------------------------------

describe('a noite de 31 continua sendo 31 (GAP-PRD-051)', () => {
  it('a nota emitida às 21h30 de 31/07 entra em julho E aparece datada 2026-07-31', () => {
    const k = documento(NOITE_DE_31);
    const dentro = abrirZip(montarPacote(companyId, PERIODO).bytes);

    const linha = linhasDoManifesto(dentro).find((l) => l.includes(k) && l.includes('emitidas/'));
    expect(linha, 'a nota tem que estar no pacote de julho').toBeDefined();
    expect(linha).toContain('2026-07-31');
    expect(linha).not.toContain('2026-08-01');
  });

  it('a nota sem procNFe — a linha "(não gerado)" — também sai com o dia da loja', () => {
    const k = documento(NOITE_DE_31, { xmlSigned: null });
    const linha = linhasDoManifesto(abrirZip(montarPacote(companyId, PERIODO).bytes)).find(
      (l) => l.includes(k),
    );
    expect(linha).toContain('(não gerado)');
    expect(linha).toContain('2026-07-31');
    expect(linha).not.toContain('2026-08-01');
  });

  it('o cancelamento feito às 21h30 de 31/07 sai datado 2026-07-31', () => {
    const k = documento('2026-07-10T13:00:00.000Z');
    evento({ documentId: documentoId(k), tipo: 'cancelled', quando: NOITE_DE_31 });

    const linha = linhasDoManifesto(abrirZip(montarPacote(companyId, PERIODO).bytes)).find(
      (l) => l.includes(k) && l.includes('eventos/'),
    );
    expect(linha).toBeDefined();
    expect(linha).toContain('2026-07-31');
    expect(linha).not.toContain('2026-08-01');
  });

  it('a mercadoria que ENTROU às 21h30 de 31/07 sai datada 2026-07-31', () => {
    const k = notaRecebida(NOITE_DE_31);
    const linha = linhasDoManifesto(abrirZip(montarPacote(companyId, PERIODO).bytes)).find(
      (l) => l.includes(k) && l.includes('recebidas/'),
    );
    expect(linha).toBeDefined();
    expect(linha).toContain('2026-07-31');
    expect(linha).not.toContain('2026-08-01');
  });

  it('a faixa inutilizada às 21h30 de 31/07 sai datada 2026-07-31 no manifesto E no CSV', () => {
    evento({ tipo: 'void_authorized', quando: NOITE_DE_31, model: '65', serie: 1, de: 5, ate: 7 });
    const dentro = abrirZip(montarPacote(companyId, PERIODO).bytes);

    const noManifesto = linhasDoManifesto(dentro).find((l) => l.includes('numeracao/inut-'));
    expect(noManifesto).toBeDefined();
    expect(noManifesto).toContain('2026-07-31');
    expect(noManifesto).not.toContain('2026-08-01');

    const csv = dentro.get('numeracao/inutilizadas.csv')!.toString('utf8');
    expect(csv).toContain('2026-07-31');
    expect(csv).not.toContain('2026-08-01');
  });

  it('o "Gerado em" do LEIA-ME é a hora da loja, com o fuso dito', () => {
    const leiaMe = abrirZip(montarPacote(companyId, PERIODO).bytes).get('LEIA-ME.txt')!.toString('utf8');
    expect(leiaMe).toMatch(/Gerado em: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(horário da loja, America\/Sao_Paulo\)/);
    expect(leiaMe).not.toContain('(UTC)');
  });
});

// ---------------------------------------------------------------------------
// GAP-PRD-176 — o pacote prova que é ele
// ---------------------------------------------------------------------------

describe('o SHA-256 dentro do pacote (GAP-PRD-176)', () => {
  it('o MANIFESTO traz o SHA-256 de cada arquivo, e ele bate com os bytes do zip', () => {
    const k = documento('2026-07-10T13:00:00.000Z');
    notaRecebida('2026-07-11T13:00:00.000Z');
    const dentro = abrirZip(montarPacote(companyId, PERIODO).bytes);
    const [cabecalho, ...linhas] = linhasDoManifesto(dentro);

    expect(cabecalho).toContain('sha256');

    const comArquivo = [...dentro.keys()].filter((n) => n !== 'MANIFESTO.csv' && n !== 'LEIA-ME.txt');
    expect(comArquivo.length).toBeGreaterThanOrEqual(3); // emitida, recebida e o DRE
    for (const nome of comArquivo) {
      const linha = linhas.find((l) => l.startsWith(nome) || l.startsWith(`"${nome}"`));
      expect(linha, `linha do manifesto para ${nome}`).toBeDefined();
      expect(linha).toContain(sha256(dentro.get(nome)!));
    }
    expect(linhas.some((l) => l.includes(k))).toBe(true);
  });

  it('linha sem arquivo não inventa hash', () => {
    const k = documento('2026-07-10T13:00:00.000Z', { xmlSigned: null });
    const linha = linhasDoManifesto(abrirZip(montarPacote(companyId, PERIODO).bytes)).find(
      (l) => l.includes(k),
    )!;
    expect(linha).not.toMatch(/[0-9a-f]{64}/);
  });

  it('o LEIA-ME traz o SHA-256 do MANIFESTO e ensina a conferir', () => {
    documento('2026-07-10T13:00:00.000Z');
    const pacote = montarPacote(companyId, PERIODO);
    const dentro = abrirZip(pacote.bytes);
    const leiaMe = dentro.get('LEIA-ME.txt')!.toString('utf8');
    const doManifesto = sha256(dentro.get('MANIFESTO.csv')!);

    expect(leiaMe).toContain(doManifesto);
    expect(pacote.manifestoSha256).toBe(doManifesto);
    expect(leiaMe).toContain('certutil -hashfile');
    expect(leiaMe).toContain('sha256sum');
  });

  it('montarPacote devolve o SHA-256 do zip que montou', () => {
    const pacote = montarPacote(companyId, PERIODO);
    expect(pacote.sha256).toBe(sha256(pacote.bytes));
  });

  it('o MANIFESTO é determinístico: o mesmo mês dá o mesmo hash em dois downloads', () => {
    documento('2026-07-10T13:00:00.000Z');
    expect(montarPacote(companyId, PERIODO).manifestoSha256).toBe(
      montarPacote(companyId, PERIODO).manifestoSha256,
    );
  });
});

describe('o SHA-256 do zip fora do zip (GAP-PRD-176)', () => {
  it('o download diz o hash no cabeçalho, e a trilha o registra', async () => {
    documento('2026-07-10T13:00:00.000Z');
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(auth)
      .buffer(true)
      .parse((r, callback) => {
        const partes: Buffer[] = [];
        r.on('data', (c: Buffer) => partes.push(c));
        r.on('end', () => callback(null, Buffer.concat(partes)));
      });

    expect(res.status).toBe(200);
    const corpo = res.body as Buffer;
    expect(res.headers['x-pacote-sha256']).toBe(sha256(corpo));

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'fiscal.closing.package' AND company_id = ?")
      .all(companyId) as { detail: string }[];
    expect(trilha).toHaveLength(1);
    const detalhe = JSON.parse(trilha[0].detail) as Record<string, unknown>;
    expect(detalhe.sha256).toBe(sha256(corpo));
    expect(detalhe.manifestoSha256).toBe(sha256(abrirZip(corpo).get('MANIFESTO.csv')!));
  });

  it('o e-mail diz o hash do anexo e o do MANIFESTO, e a trilha o registra', () => {
    documento('2026-07-10T13:00:00.000Z');
    criarDestinatario({ companyId, userId: null, name: 'Escritório', email: 'contador@example.com' });
    const r = enviarPacotePorEmail({ companyId, period: PERIODO, origem: 'manual', idempotencyKey: 'k-hash' });
    expect(r.enfileirados).toBe(1);

    const fila = getConnection()
      .prepare(
        `SELECT q.body_text, COALESCE(a.conteudo, q.anexo_blob) AS anexo
           FROM core_email_queue q LEFT JOIN core_email_attachments a ON a.id = q.anexo_id
          WHERE q.company_id = ?`,
      )
      .get(companyId) as { body_text: string; anexo: Uint8Array };
    const anexo = Buffer.from(fila.anexo);
    expect(fila.body_text).toContain(sha256(anexo));
    expect(fila.body_text).toContain(sha256(abrirZip(anexo).get('MANIFESTO.csv')!));

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'contador.pacote_email' AND company_id = ?")
      .get(companyId) as { detail: string };
    expect(JSON.parse(trilha.detail).sha256).toBe(sha256(anexo));
  });
});

describe('conferir um pacote recebido (GAP-PRD-176)', () => {
  async function baixar(cabecalho: { Authorization: string }): Promise<Buffer> {
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(cabecalho)
      .buffer(true)
      .parse((r, callback) => {
        const partes: Buffer[] = [];
        r.on('data', (c: Buffer) => partes.push(c));
        r.on('end', () => callback(null, Buffer.concat(partes)));
      });
    expect(res.status).toBe(200);
    return res.body as Buffer;
  }

  it('o hash de um zip que o sistema entregou é reconhecido, com quem, quando e qual mês', async () => {
    documento('2026-07-10T13:00:00.000Z');
    const zip = await baixar(auth);

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${sha256(zip)}`)
      .set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.encontrado).toBe(true);
    expect(res.body.ocorrencias).toHaveLength(1);
    expect(res.body.ocorrencias[0]).toMatchObject({
      period: PERIODO,
      arquivo: 'zip',
      meio: 'download',
    });
    expect(res.body.ocorrencias[0].quando).toBeTruthy();
  });

  it('o hash do MANIFESTO também é reconhecido — o contador pode conferir só ele', async () => {
    documento('2026-07-10T13:00:00.000Z');
    const zip = await baixar(auth);
    const doManifesto = sha256(abrirZip(zip).get('MANIFESTO.csv')!);

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${doManifesto.toUpperCase()}`)
      .set(auth);
    expect(res.body.encontrado).toBe(true);
    expect(res.body.ocorrencias[0].arquivo).toBe('manifesto');
  });

  it('um zip alterado depois do download não é reconhecido', async () => {
    const zip = await baixar(auth);
    const adulterado = Buffer.concat([zip, Buffer.from(' ')]);
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${sha256(adulterado)}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.encontrado).toBe(false);
    expect(res.body.ocorrencias).toEqual([]);
  });

  it('o contador confere; a outra empresa não enxerga o pacote desta', async () => {
    const zip = await baixar(auth);
    const hash = sha256(zip);

    const contador = await loginForTest(app, {
      userId: 'contador-integridade',
      companyId: 'preco-justo',
      profileCodes: ['contador'],
    });
    const peloContador = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${hash}`)
      .set({ Authorization: `Bearer ${contador.body.accessToken}` });
    expect(peloContador.status).toBe(200);
    expect(peloContador.body.encontrado).toBe(true);

    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'gringa-integridade',
      profileCodes: ['gerente_loja'],
    });
    const pelaVizinha = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${hash}`)
      .set({ Authorization: `Bearer ${vizinha.body.accessToken}` });
    expect(pelaVizinha.status).toBe(200);
    expect(pelaVizinha.body.encontrado).toBe(false);
  });

  it('o que não é SHA-256 é recusado com código próprio', async () => {
    const res = await request(app)
      .get('/api/v1/core/fiscal/closings/conferir?sha256=abc%27%20OR%201%3D1')
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_SHA256_INVALIDO');
  });

  it('o caixa não confere pacote — é da gestão e do contador', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-integridade',
      companyId: 'preco-justo',
      profileCodes: ['operador_caixa'],
    });
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/conferir?sha256=${'a'.repeat(64)}`)
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` });
    expect(res.status).toBe(403);
  });
});
