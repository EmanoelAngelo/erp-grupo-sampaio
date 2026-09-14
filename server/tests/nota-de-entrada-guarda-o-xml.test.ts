/**
 * ============================================================================
 * O BURACO IRREVERSÍVEL: O XML DA NOTA DE ENTRADA
 * ============================================================================
 *
 * De todas as lacunas desta rodada, esta é a única que o tempo torna
 * IMPOSSÍVEL de consertar. Uma tela que falta pode ser escrita amanhã; um
 * relatório errado pode ser recalculado. Um arquivo que foi lido e descartado
 * não volta. No banco real deste ERP existe UMA nota recebida, e o XML dela já
 * se foi — nenhum backfill, nenhuma migração, nenhum pedido ao fornecedor
 * resolve com certeza.
 *
 * Por isso este arquivo cobra o comportamento em três alturas diferentes, e
 * não só no serviço:
 *
 *   1. A COLUNA existe e a migração a leva ao banco que já roda.
 *   2. O ESCRITOR grava VERBATIM — byte por byte, sem passar por parser.
 *   3. A ROTA devolve o arquivo, e a LISTA não o arrasta junto.
 *
 * COMO CADA GUARDA FALHA (medido, quebrando de propósito — a saída real está
 * no relatório da rodada):
 *
 *   - trocando `input.xml` por `JSON.stringify(parsed)` no INSERT de
 *     `importNfe`, o caso "grava o arquivo exatamente como chegou" fica
 *     vermelho;
 *   - voltando `listNotes` para `SELECT n.*`, o caso "a lista NÃO arrasta o
 *     XML" fica vermelho, porque o campo reaparece na resposta;
 *   - apagando o `if (!nota.xmlOriginal)` da rota, a nota antiga passa a
 *     devolver 200 com corpo vazio e o caso da nota sem arquivo fica vermelho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema, resetCoreSchemaCache } from '../src/db/schema.js';
import { loginForTest } from './helpers/auth.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { importNfe } from '../src/services/core/NfeImportService.js';
import { processIncomingMail, upsertInbox } from '../src/services/core/MailInboxService.js';

const app = createApp();

const CHAVE = '35240114200166000187550010000000015123456789';
const CHAVE_EMAIL = '35240114200166000187550010000000029123456789';

/**
 * O XML de propósito FEIO: indentação irregular, atributo em ordem incomum,
 * aspas simples, espaço antes da barra de fechamento e um bloco de assinatura.
 *
 * Um XML bonitinho passaria mesmo que alguém reserializasse a árvore do
 * parser antes de gravar — que é exatamente o defeito que este arquivo
 * existe para impedir. A assinatura do fornecedor cobre ESTES bytes.
 */
function xmlDoFornecedor(chave = CHAVE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao='4.00' xmlns="http://www.portalfiscal.inf.br/nfe"><NFe>
   <infNFe versao="4.00" Id="NFe${chave}">
        <ide><cUF>35</cUF><nNF>2048</nNF><serie>1</serie>
   <dhEmi>2026-07-05T09:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Ação &amp; Peças Ltda</xNome></emit>
      <dest><CNPJ>99999999000191</CNPJ><xNome>Grupo Sampaio</xNome></dest>
      <det nItem="1"><prod><cProd>FORN-9</cProd><cEAN>7891234567895</cEAN>
        <xProd>Pastilha de Freio</xProd><NCM>87141000</NCM><CFOP>5102</CFOP>
        <uCom>UN</uCom><qCom>3.0000</qCom><vUnCom>50.0000</vUnCom><vProd>150.00</vProd>
      </prod></det>
      <total><ICMSTot><vNF>150.00</vNF></ICMSTot></total>
   </infNFe>
   <Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>ABCdef123+/=</SignatureValue></Signature>
 </NFe>
  <protNFe><infProt><nProt>135240000000009</nProt></infProt></protNFe></nfeProc>`;
}

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-entrada',
    companyId: 'loja-entrada',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function importarPelaRota(xml = xmlDoFornecedor()) {
  const res = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({ xml });
  expect(res.status).toBe(201);
  return res.body.noteId as string;
}

describe('a coluna chega ao banco que já existe', () => {
  it('a migração 58 acrescenta xml_original em core_inbound_notes', () => {
    ensureCoreSchema();

    /*
      Simula o banco da loja: a tabela existe SEM a coluna nova. É esse o caso
      que a lista canônica de `schema.ts` não resolve — `CREATE TABLE IF NOT
      EXISTS` não altera tabela que já está lá — e é por isso que o passo de
      migração existe.
    */
    const db = getConnection();
    db.exec('DROP TABLE IF EXISTS core_inbound_note_items');
    db.exec('DROP TABLE IF EXISTS core_inbound_notes');
    db.exec(`CREATE TABLE core_inbound_notes (
       id TEXT PRIMARY KEY, company_id TEXT NOT NULL, access_key TEXT NOT NULL,
       total_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'imported',
       created_at TEXT NOT NULL, UNIQUE (company_id, access_key))`);
    db.prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_58'").run();

    migrateCoreSchema();

    const colunas = db
      .prepare('PRAGMA table_info(core_inbound_notes)')
      .all() as { name: string; notnull: number; dflt_value: unknown }[];
    const xml = colunas.find((c) => c.name === 'xml_original');
    expect(xml).toBeDefined();
    // Nasce NULLABLE: a nota que já existe não tem arquivo, e nulo é a verdade.
    expect(xml?.notnull).toBe(0);
    expect(xml?.dflt_value).toBeNull();

    /*
      As tabelas derrubadas acima precisam voltar ANTES do próximo teste.
      `ensureCoreSchema` guarda um `ready` de processo e vira no-op depois da
      primeira chamada — sem limpar esse cache, o `resetDbForTests` do
      `beforeEach` seguinte estouraria com "no such table", e o vermelho
      apareceria num teste que não tem nada a ver com isto.
    */
    resetCoreSchemaCache();
    ensureCoreSchema();
  });

  it('o passo 58 é ALCANÇÁVEL: o alvo do esquema não ficou para trás dele', () => {
    /*
      ESTE CASO PEDIA `CORE_TARGET_VERSION === 58`, e o número foi tirado na
      rodada 30, que levou o alvo a 59.

      O que ele existe para proteger não é o número 58: é o passo desta rodada
      ser alcançado. `migrateCoreSchema` varre de 2 até o alvo, então um alvo
      MENOR que este passo o deixaria fora da varredura para sempre — a coluna
      `xml_original` nunca chegaria ao banco que já roda na loja, e o caso
      acima passaria mesmo assim, porque ele apaga a marca e chama a migração
      diretamente.

      Fixar o número exigia editar este arquivo a cada rodada seguinte, e um
      teste que só pede manutenção acaba sendo ajustado sem ninguém ler o que
      ele afirmava. A desigualdade diz a mesma coisa e continua verdadeira
      quando o alvo cresce.
    */
    expect(CORE_TARGET_VERSION).toBeGreaterThanOrEqual(58);
    expect(migrateCoreSchema().to).toBe(CORE_TARGET_VERSION);

    const marca = getConnection()
      .prepare('SELECT value FROM core_meta WHERE key = ?')
      .get('core_migration_step_58') as { value?: string } | undefined;
    expect(marca?.value).toBe('applied');
  });
});

describe('o escritor', () => {
  it('grava o arquivo exatamente como chegou, byte por byte', async () => {
    const original = xmlDoFornecedor();
    const noteId = await importarPelaRota(original);

    const row = getConnection()
      .prepare('SELECT xml_original FROM core_inbound_notes WHERE id = ?')
      .get(noteId) as { xml_original: string };

    /*
      IGUALDADE ESTRITA, e não "contém" nem "parece com".

      A assinatura do fornecedor cobre os bytes. Reserializar reordena
      atributo, normaliza aspas e troca espaço em branco — o arquivo continua
      legível e a assinatura para de validar. Só a igualdade exata prova que
      nada tocou no texto.
    */
    expect(row.xml_original).toBe(original);
    // E as marcas mais frágeis, nomeadas: aspas simples no atributo, a
    // entidade `&amp;` sem expandir, e a assinatura inteira.
    expect(row.xml_original).toContain("versao='4.00'");
    expect(row.xml_original).toContain('Ação &amp; Peças');
    expect(row.xml_original).toContain('<SignatureValue>ABCdef123+/=</SignatureValue>');
  });

  it('o caminho do E-MAIL grava igual: o funil é o mesmo', () => {
    /*
      Este caso é o motivo de o escritor estar em `importNfe` e não na rota.
      A nota que chega por e-mail nunca passa por `POST /purchases/nfe/import`
      — o `MailInboxService` chama o serviço direto. Um escritor na rota
      cobriria metade dos caminhos, e a metade descoberta é justamente a
      automática, que ninguém vê acontecer.
    */
    const caixa = upsertInbox({
      companyId,
      address: 'notas@grupo-sampaio.com.br',
      host: 'imap.exemplo.com',
      password: 'senha-de-aplicativo',
    });

    const xml = xmlDoFornecedor(CHAVE_EMAIL);
    const registro = processIncomingMail({
      companyId,
      userId: 'user-1',
      inboxId: caixa.inbox!.id,
      mail: {
        uid: 'uid-1',
        subject: 'NF-e 2048',
        attachments: [{ filename: 'nfe-2048.xml', content: Buffer.from(xml, 'utf8') }],
      },
    });
    expect(registro.outcome).toBe('importado');

    const row = getConnection()
      .prepare('SELECT xml_original FROM core_inbound_notes WHERE company_id = ? AND access_key = ?')
      .get(companyId, CHAVE_EMAIL) as { xml_original: string };
    expect(row.xml_original).toBe(xml);
  });

  it('reimportar o mesmo arquivo não cria segunda nota nem reescreve a primeira', async () => {
    const noteId = await importarPelaRota();

    const segunda = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml: xmlDoFornecedor() });
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicated).toBe(true);
    expect(segunda.body.noteId).toBe(noteId);

    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(quantas.n).toBe(1);
  });
});

describe('a lista da tela', () => {
  it('NÃO arrasta o XML, e diz quais notas têm arquivo', async () => {
    await importarPelaRota();

    const res = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);

    const nota = res.body.items[0] as Record<string, unknown>;

    /*
      O CAMPO NÃO PODE ESTAR NA RESPOSTA. Não basta a tela ignorá-lo: um XML de
      NF-e com trinta itens passa de 100 KB, e a lista traz até 200 notas. Com
      `SELECT n.*` a tela puxaria dezenas de megabytes a cada carregamento
      para exibir sete colunas — e ninguém veria a causa, porque `n.*` não
      menciona o XML em lugar nenhum.
    */
    expect(nota.xml_original).toBeUndefined();
    expect(Object.keys(nota)).not.toContain('xml_original');

    // O booleano que o botão de baixar consome.
    expect(nota.tem_xml).toBe(1);
    // E a data da PRÓPRIA nota, que é como a tela conta a verdade sobre as
    // antigas sem chumbar uma data no código.
    expect(String(nota.issued_at).slice(0, 10)).toBe('2026-07-05');
  });

  it('a nota antiga aparece com tem_xml = 0', async () => {
    const noteId = await importarPelaRota();
    // A nota importada antes da rodada 27, reproduzida: linha completa, coluna
    // nula. É o estado real da única nota do banco da loja.
    getConnection()
      .prepare('UPDATE core_inbound_notes SET xml_original = NULL WHERE id = ?')
      .run(noteId);

    const res = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(res.body.items[0].tem_xml).toBe(0);
  });
});

describe('a rota do arquivo', () => {
  it('devolve o XML com o nome do arquivo no cabeçalho', async () => {
    const noteId = await importarPelaRota();

    const res = await request(app)
      .get(`/api/v1/core/purchases/notes/${noteId}/xml`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${CHAVE}-nfe.xml"`,
    );
    expect(res.text).toBe(xmlDoFornecedor());
  });

  it('nota SEM arquivo tem código próprio — não é "nota não encontrada"', async () => {
    const noteId = await importarPelaRota();
    getConnection()
      .prepare('UPDATE core_inbound_notes SET xml_original = NULL WHERE id = ?')
      .run(noteId);

    const res = await request(app)
      .get(`/api/v1/core/purchases/notes/${noteId}/xml`)
      .set(auth);

    expect(res.status).toBe(404);
    /*
      Dois "não existe" diferentes, com códigos diferentes. Devolver
      "não encontrada" para uma nota que está na lista mandaria alguém caçar um
      defeito que não existe — a nota está lá, o que não existe é o arquivo, e
      isso é história, não erro.
    */
    expect(res.body.error.code).toBe('CORE_INBOUND_NOTE_XML_AUSENTE');
  });

  it('a nota de outra operação não vaza', async () => {
    const noteId = await importarPelaRota();

    const outra = await loginForTest(app, {
      userId: 'gerente-vizinho',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get(`/api/v1/core/purchases/notes/${noteId}/xml`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });

    // Mesma resposta de nota inexistente, de propósito: distinguir os dois
    // casos contaria a quem tem o id que a nota existe em outra operação.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_INBOUND_NOTE_NOT_FOUND');
  });

  it('sem token não passa', async () => {
    const noteId = await importarPelaRota();
    const res = await request(app).get(`/api/v1/core/purchases/notes/${noteId}/xml`);
    expect(res.status).toBe(401);
  });

  it('o mecânico da bancada não alcança o arquivo fiscal da compra', async () => {
    const noteId = await importarPelaRota();
    const mecanico = await loginForTest(app, {
      userId: 'mecanico-1',
      companyId,
      profileCodes: ['mecanico'],
    });
    const res = await request(app)
      .get(`/api/v1/core/purchases/notes/${noteId}/xml`)
      .set({ Authorization: `Bearer ${mecanico.body.accessToken}` });
    expect(res.status).toBe(403);
  });
});
