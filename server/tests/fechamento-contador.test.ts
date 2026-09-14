/**
 * ============================================================================
 * O PACOTE DO CONTADOR
 * ============================================================================
 *
 * Todo defeito possível aqui tem a mesma forma: o zip SAI, ABRE, e está
 * incompleto. Ninguém recebe um erro; alguém recebe um mês pela metade e
 * assume que é o mês inteiro. Por isso quase todo caso deste arquivo é sobre
 * ausência — o que NÃO pode faltar, e o que NÃO pode entrar.
 *
 * COMO CADA GUARDA FALHA (medido, quebrando de propósito; a saída real está no
 * relatório da rodada):
 *
 *   - pondo `LIMIT 300` na consulta de emitidas, "traz o mês inteiro" fica
 *     vermelho em 310 documentos;
 *   - pondo `LIMIT 200` na consulta de inutilizações, "todas as faixas" fica
 *     vermelho em 205 faixas;
 *   - tirando `AND d.environment = 'production'` de `SO_PRODUCAO`, o caso da
 *     homologação fica vermelho;
 *   - tirando a marca de fixture, o caso do documento de teste fica vermelho;
 *   - trocando o recorte do evento pela data da NOTA, o cancelamento de mês
 *     anterior some e o caso fica vermelho;
 *   - trocando `event_type = 'void_authorized'` por `IN (...)`, o pedido e a
 *     recusa entram no CSV e o caso fica vermelho;
 *   - tirando o `if` que só acrescenta pasta com conteúdo, `emitidas/` aparece
 *     vazia e o caso da pasta fica vermelho;
 *   - tirando `slugSeguro` de `nomeDoPacote`, o caso do slug hostil fica
 *     vermelho com aspas e quebra de linha dentro do cabeçalho.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { TEST_PASSWORD } from './helpers/auth.js';
/*
  `previaDoFechamento` NÃO é importada de propósito: a prévia é conferida pela
  ROTA, que é por onde a tela a consome. Ela estava na lista de imports sem
  nenhum uso — e um import morto num arquivo de teste é a promessa de cobertura
  que ninguém cumpre.
*/
import {
  montarPacote,
  periodBounds,
  TETO_DE_DOCUMENTOS,
} from '../src/services/core/FiscalClosingService.js';
import { FIXTURE_SIGNATURE_MARK } from '../src/services/core/FiscalPipelineService.js';
import { TEST_PROTOCOL_PREFIX } from '../src/services/core/SefazTestAdapter.js';
import { sanitizeResponse } from '../src/services/core/SefazAdapter.js';
import {
  NOTA_ESTORNADA,
  NOTA_IMPORTADA,
  NOTA_RECEBIDA,
} from '../src/services/core/InboundNoteStatus.js';

const app = createApp();
const PERIODO = '2026-07';

let auth: { Authorization: string };
let companyId: string;
let sequencia = 0;

beforeEach(async () => {
  resetDbForTests();
  sequencia = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-fechamento',
    companyId: 'preco-justo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

// ---------------------------------------------------------------------------
// Fabricação de cenário
// ---------------------------------------------------------------------------

/**
 * A chave de acesso tem 44 dígitos e é única no banco inteiro. Gerá-la por
 * contador é o que permite criar 310 documentos sem colisão.
 */
function chave(n: number): string {
  // Montada como TEXTO. Somar ao número de 44 dígitos não funciona: ele passa
  // de `Number.MAX_SAFE_INTEGER` e todas as chaves saem iguais — o teste
  // quebraria por colisão, não pelo que ele cobra.
  return `3526071420016600018755001${String(n).padStart(19, '0')}`;
}

const ASSINATURA = 'YXNzaW5hdHVyYS1yZWFsLWRvLWNlcnRpZmljYWRv';

function xmlAssinado(k: string): string {
  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${k}">`
    + '<ide><nNF>1</nNF></ide></infNFe>'
    + `<Signature><SignatureValue>${ASSINATURA}</SignatureValue></Signature></NFe>`;
}

/** A resposta como o banco a guarda: passada por `sanitizeResponse` de verdade. */
function xmlAutorizado(k: string, protocolo: string): string {
  return sanitizeResponse(
    `<retEnviNFe><protNFe><infProt><chNFe>${k}</chNFe>`
      + `<nProt>${protocolo}</nProt><cStat>100</cStat></infProt></protNFe>`
      + `${xmlAssinado(k)}</retEnviNFe>`,
  );
}

interface DocumentoDeTeste {
  emissao?: string;
  status?: 'AUTHORIZED' | 'CANCELLED';
  environment?: string;
  protocol?: string | null;
  xmlSigned?: string | null;
  xmlAuthorized?: string | null;
  empresa?: string;
  /** '55' NF-e (padrão) ou '65' NFC-e — o pacote não filtra modelo. */
  model?: string;
}

/*
  A INSERÇÃO É DIRETA, e isso é decisão consciente.

  Levar um documento até AUTHORIZED pelo caminho de produção exige certificado,
  configuração fiscal completa e o provider de teste — que carimba protocolo
  `TEST-`, justamente o que este pacote precisa EXCLUIR. Não há como fabricar,
  pelo caminho real, um documento de produção autorizado neste ambiente.

  O risco de inserir à mão é escrever um valor que a produção nunca grava — foi
  assim que a suíte de compras ficou verde sobre um defeito real. A defesa aqui
  é usar os MESMOS valores que `FiscalDocumentService.transition` escreve
  ('AUTHORIZED', 'CANCELLED', environment 'production') e importar de
  `SefazTestAdapter` e `FiscalPipelineService` as marcas de teste, em vez de
  digitá-las.
*/
function documento(over: DocumentoDeTeste = {}): string {
  sequencia += 1;
  const id = randomUUID();
  const k = chave(sequencia);
  const emissao = over.emissao ?? `${PERIODO}-10T13:00:00.000Z`;
  const protocolo = over.protocol === undefined ? `1352600001${sequencia}` : over.protocol;
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, model, serie, number, access_key, environment, status,
          xml_signed, xml_authorized, protocol, issued_at, authorized_at,
          created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.empresa ?? companyId,
      over.model ?? '55',
      sequencia,
      k,
      over.environment ?? 'production',
      over.status ?? 'AUTHORIZED',
      over.xmlSigned === undefined ? xmlAssinado(k) : over.xmlSigned,
      over.xmlAuthorized === undefined
        ? xmlAutorizado(k, protocolo ?? '1')
        : over.xmlAuthorized,
      protocolo,
      emissao,
      emissao,
      emissao,
      emissao,
    );
  return id;
}

function evento(input: {
  documentId?: string | null;
  tipo: string;
  quando: string;
  xml?: string | null;
  /** O procEventoNFe íntegro (GAP-V32) — eventos novos o têm; legado, não. */
  xmlProc?: string | null;
  protocolo?: string | null;
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
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      companyId,
      input.documentId ?? null,
      input.tipo,
      input.protocolo === undefined ? '135260009999' : input.protocolo,
      input.xml === undefined ? '<retEvento><infEvento><cStat>135</cStat></infEvento></retEvento>' : input.xml,
      input.xmlProc ?? null,
      input.model ?? null,
      input.serie ?? null,
      input.de ?? null,
      input.ate ?? null,
      input.quando,
    );
}

function notaRecebida(input: {
  entrada: string;
  xml?: string | null;
  status?: string;
  usarCreatedAt?: boolean;
  /** 'nfe' (padrão) ou 'manual' — a compra SEM nota fiscal (GAP-V17). */
  docType?: string;
  /** A chave crua, para a entrada manual, que nunca tem 44 dígitos. */
  accessKey?: string;
}): string {
  sequencia += 1;
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, series, total_cents, status,
          received_at, issued_at, xml_original, doc_type, created_at)
       VALUES (?, ?, ?, ?, '1', 15000, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      input.accessKey ?? chave(9000 + sequencia),
      String(2000 + sequencia),
      input.status ?? NOTA_RECEBIDA,
      input.usarCreatedAt ? null : input.entrada,
      input.entrada,
      input.xml === undefined ? '<nfeProc><NFe>compra</NFe></nfeProc>' : input.xml,
      input.docType ?? 'nfe',
      input.entrada,
    );
  return id;
}

/**
 * A compra SEM nota fiscal, como `createManualInboundNote` a grava: espécie
 * 'manual', chave sintética que NUNCA tem 44 dígitos, e `xml_original` nulo
 * porque arquivo nenhum jamais existiu.
 */
function entradaManual(entrada: string, status: string = NOTA_RECEBIDA): string {
  sequencia += 1;
  return notaRecebida({
    entrada,
    status,
    xml: null,
    docType: 'manual',
    accessKey: `manual:${randomUUID()}`,
  });
}

// ---------------------------------------------------------------------------
// Leitura do zip
// ---------------------------------------------------------------------------

/**
 * Abre o zip pelo DIRETÓRIO CENTRAL, que é o que o Explorer do Windows lê.
 *
 * Varrer o arquivo procurando assinaturas — como o 7-Zip faz — esconderia um
 * índice errado. `zip-writer.test.ts` já entrega o arquivo ao descompactador
 * do sistema operacional; aqui o que interessa é o CONTEÚDO, e ler pelo índice
 * mantém a leitura honesta sem pagar o preço de um processo externo por caso.
 */
function abrirZip(zip: Buffer): Map<string, string> {
  const fim = zip.length - 22;
  expect(zip.readUInt32LE(fim)).toBe(0x06054b50);
  const entradas = zip.readUInt16LE(fim + 10);
  let cursor = zip.readUInt32LE(fim + 16);

  const saida = new Map<string, string>();
  for (let i = 0; i < entradas; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const tamanhoNome = zip.readUInt16LE(cursor + 28);
    const tamanhoExtra = zip.readUInt16LE(cursor + 30);
    const tamanhoComentario = zip.readUInt16LE(cursor + 32);
    const offsetLocal = zip.readUInt32LE(cursor + 42);
    const nome = zip.subarray(cursor + 46, cursor + 46 + tamanhoNome).toString('utf8');

    expect(zip.readUInt32LE(offsetLocal)).toBe(0x04034b50);
    const comprimido = zip.readUInt32LE(offsetLocal + 18);
    const nomeLocal = zip.readUInt16LE(offsetLocal + 26);
    const extraLocal = zip.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;

    saida.set(
      nome,
      inflateRawSync(zip.subarray(inicio, inicio + comprimido)).toString('utf8'),
    );
    cursor += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return saida;
}

function pacote(period = PERIODO): Map<string, string> {
  return abrirZip(montarPacote(companyId, period).bytes);
}

// ---------------------------------------------------------------------------
// O período
// ---------------------------------------------------------------------------

describe('periodBounds', () => {
  it('recorta o mês inteiro, com o último dia certo', () => {
    expect(periodBounds('2026-02')).toMatchObject({
      primeiroDia: '2026-02-01',
      ultimoDia: '2026-02-28',
    });
    // Bissexto sem tabela escrita à mão.
    expect(periodBounds('2024-02').ultimoDia).toBe('2024-02-29');
    expect(periodBounds('2026-12').ultimoDia).toBe('2026-12-31');
  });

  it('recusa o que não é AAAA-MM, com código próprio', () => {
    for (const ruim of ['2026', '2026-1', '26-01', '2026/01', 'julho', '']) {
      expect(() => periodBounds(ruim)).toThrowError(/CORE_FISCAL_PERIODO_INVALIDO|inválid|válido/i);
    }
  });

  it('recusa mês fora de 01..12 — o zero é o perigoso', () => {
    /*
      Um regex de "dois dígitos" aceitaria '2026-00', e `new Date(2026, 0, 0)`
      cai em DEZEMBRO DE 2025. O pacote sairia com o mês errado e ninguém
      desconfiaria, porque ele viria cheio.
    */
    expect(() => periodBounds('2026-00')).toThrow();
    expect(() => periodBounds('2026-13')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A prévia
// ---------------------------------------------------------------------------

describe('a prévia', () => {
  it('conta o que existe e não dá veredito bloqueante', async () => {
    documento();
    documento({ status: 'CANCELLED' });
    notaRecebida({ entrada: `${PERIODO}-05T12:00:00.000Z` });
    notaRecebida({ entrada: `${PERIODO}-06T12:00:00.000Z`, xml: null, status: NOTA_IMPORTADA });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.contagens).toMatchObject({
      emitidasAutorizadas: 1,
      emitidasCanceladas: 1,
      recebidasComArquivo: 1,
      recebidasSemArquivo: 1,
    });

    const codigos = res.body.pendencias.map((p: { codigo: string }) => p.codigo);
    expect(codigos).toContain('RECEBIDA_SEM_ARQUIVO');
    expect(codigos).toContain('RECEBIDA_NAO_CONFERIDA');

    /*
      NENHUMA PENDÊNCIA BLOQUEIA. Com zero emissão no banco real, um critério
      do tipo "não fecha sem nota emitida" reprovaria todos os meses, todos os
      meses — e um alerta que sempre acende deixa de ser lido. A prova é que o
      download funciona com as duas pendências acesas.
    */
    const download = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(auth);
    expect(download.status).toBe(200);
  });

  it('mês sem nada devolve zeros e nenhuma pendência', async () => {
    const res = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-03/previa')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.contagens.emitidasAutorizadas).toBe(0);
    expect(res.body.pendencias).toEqual([]);
  });

  it('diz em que meses há matéria-prima, do mais recente para o mais antigo', async () => {
    documento({ emissao: '2026-05-10T12:00:00.000Z' });
    notaRecebida({ entrada: '2026-07-02T12:00:00.000Z' });

    const res = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-01/previa')
      .set(auth);

    /*
      É o que faz o seletor da tela abrir no lugar certo. Sem isto ele abriria
      no mês corrente — que, num sistema cujo movimento é de julho, mostra um
      pacote vazio e faz o operador concluir que a função não funciona.
    */
    expect(res.body.mesesComMateriaPrima).toEqual(['2026-07', '2026-05']);
  });

  it('período inválido na URL vira 400 com código próprio', async () => {
    const res = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-13/previa')
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_PERIODO_INVALIDO');
  });
});

// ---------------------------------------------------------------------------
// O pacote: o que entra
// ---------------------------------------------------------------------------

describe('o pacote', () => {
  it('sempre traz LEIA-ME, MANIFESTO e o DRE', () => {
    const dentro = pacote();
    expect([...dentro.keys()]).toEqual(
      expect.arrayContaining(['LEIA-ME.txt', 'MANIFESTO.csv', 'resultado/dre.csv']),
    );
  });

  it('a nota emitida vira procNFe com a assinatura ORIGINAL', () => {
    documento();
    const dentro = pacote();
    const emitidas = [...dentro.keys()].filter((n) => n.startsWith('emitidas/'));
    expect(emitidas).toHaveLength(1);

    const proc = dentro.get(emitidas[0])!;
    expect(proc).toContain('<nfeProc');
    expect(proc).toContain('<protNFe>');
    /*
      A ARMADILHA CENTRAL DESTA RODADA. `xml_authorized` guarda a resposta já
      passada por `sanitizeResponse`, que troca a assinatura por "[removido]".
      Compor a nota dali entregaria ao contador um arquivo que abre, que tem os
      dois elementos, e que não prova autorização nenhuma.
    */
    expect(proc).toContain(ASSINATURA);
    expect(proc).not.toContain('[removido]');
  });

  it('a nota recebida entra com o XML do fornecedor, sem uma vírgula a mais', () => {
    const original = '<nfeProc versao=\'4.00\'><NFe>  do fornecedor  </NFe></nfeProc>';
    notaRecebida({ entrada: `${PERIODO}-09T12:00:00.000Z`, xml: original });

    const dentro = pacote();
    const recebidas = [...dentro.keys()].filter((n) => n.startsWith('recebidas/'));
    expect(recebidas).toHaveLength(1);
    expect(dentro.get(recebidas[0])).toBe(original);
  });

  it('a nota é recortada pela data de ENTRADA, não pela de emissão', () => {
    /*
      Compra é escriturada quando a mercadoria ENTRA. Uma nota emitida em junho
      que chegou em julho é de julho — recortar pela emissão a jogaria para o
      pacote do mês errado, e ela sumiria dos dois se o pacote de junho já
      tivesse sido entregue.
    */
    getConnection()
      .prepare(
        `INSERT INTO core_inbound_notes
           (id, company_id, access_key, total_cents, status, issued_at, received_at,
            xml_original, created_at)
         VALUES (?, ?, ?, 1000, ?, '2026-06-28T12:00:00.000Z', ?, '<x/>', '2026-06-28T12:00:00.000Z')`,
      )
      .run(randomUUID(), companyId, chave(7777), NOTA_RECEBIDA, `${PERIODO}-02T12:00:00.000Z`);

    expect([...pacote().keys()].filter((n) => n.startsWith('recebidas/'))).toHaveLength(1);
    expect([...pacote('2026-06').keys()].filter((n) => n.startsWith('recebidas/'))).toHaveLength(0);
  });

  it('nota sem received_at cai no created_at, e não some do calendário', () => {
    notaRecebida({
      entrada: `${PERIODO}-11T12:00:00.000Z`,
      status: NOTA_IMPORTADA,
      usarCreatedAt: true,
    });
    expect([...pacote().keys()].filter((n) => n.startsWith('recebidas/'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// O pacote: o que NÃO entra
// ---------------------------------------------------------------------------

describe('o que não pode entrar', () => {
  it('documento de HOMOLOGAÇÃO fica de fora', () => {
    documento({ environment: 'homologation' });
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);
  });

  it('documento com assinatura de FIXTURE fica de fora', () => {
    const k = chave(4242);
    documento({ xmlSigned: `<NFe><Signature>${FIXTURE_SIGNATURE_MARK}</Signature></NFe>` });
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);
    expect(k).toHaveLength(44);
  });

  it('documento com protocolo do provider de TESTE fica de fora', () => {
    documento({ protocol: `${TEST_PROTOCOL_PREFIX}abc123` });
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);
  });

  it('documento de OUTRA empresa fica de fora', () => {
    const vizinha = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    documento({ empresa: vizinha });
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);
  });

  it('pasta sem conteúdo NÃO entra: pasta vazia parece perda de dado', () => {
    const dentro = pacote();
    for (const prefixo of ['emitidas/', 'eventos/', 'recebidas/', 'numeracao/']) {
      expect([...dentro.keys()].filter((n) => n.startsWith(prefixo))).toHaveLength(0);
    }
    // E o LEIA-ME EXPLICA cada ausência, em vez de deixar o silêncio decidir.
    const leiaMe = dentro.get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('emitidas/  — NÃO EXISTE neste pacote');
    expect(leiaMe).toContain('recebidas/  — NÃO EXISTE neste pacote');
  });

  it('nota autorizada sem XML assinado NÃO vira arquivo — vira linha no manifesto', () => {
    documento({ xmlSigned: null });

    const dentro = pacote();
    expect([...dentro.keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);

    /*
      A alternativa seria gravar a metade que existe com nome de procNFe: um
      arquivo que abre, que parece o documento certo, e que não prova
      autorização. A ausência é registrada COM A CHAVE, para poder ser
      investigada.
    */
    expect(dentro.get('MANIFESTO.csv')).toContain('(não gerado)');
  });
});

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

describe('os eventos', () => {
  it('cancelamento de nota do mês ANTERIOR entra pelo mês do EVENTO', () => {
    const antiga = documento({ emissao: '2026-06-15T12:00:00.000Z' });
    evento({ documentId: antiga, tipo: 'cancelled', quando: `${PERIODO}-03T09:00:00.000Z` });

    const dentro = pacote();
    const eventos = [...dentro.keys()].filter((n) => n.startsWith('eventos/'));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toContain('cancelamento');

    // E a nota, essa sim, ficou no pacote de junho — cada coisa no seu mês.
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(0);
    expect([...pacote('2026-06').keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(1);
  });

  it('carta de correção entra; pedido e recusa não', () => {
    const doc = documento();
    evento({ documentId: doc, tipo: 'cce_authorized', quando: `${PERIODO}-12T10:00:00.000Z` });
    evento({ documentId: doc, tipo: 'cce_requested', quando: `${PERIODO}-12T09:00:00.000Z`, xml: null });
    evento({
      documentId: doc,
      tipo: 'cancel_rejected',
      quando: `${PERIODO}-13T10:00:00.000Z`,
      protocolo: null,
    });

    const eventos = [...pacote().keys()].filter((n) => n.startsWith('eventos/'));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toContain('carta-de-correcao');
  });

  it('evento de documento de homologação não entra', () => {
    const doc = documento({ environment: 'homologation' });
    evento({ documentId: doc, tipo: 'cancelled', quando: `${PERIODO}-04T10:00:00.000Z` });
    expect([...pacote().keys()].filter((n) => n.startsWith('eventos/'))).toHaveLength(0);
  });

  /*
    GAP-V32: DAQUI EM DIANTE o evento aceito guarda TAMBÉM o procEventoNFe
    íntegro (`xml_proc`), com a assinatura preservada — assinatura de evento é
    prova pública, não segredo. Quando o íntegro existe, é ELE que entra no
    zip; o legado (só o retorno sanitizado) continua saindo como sempre, com a
    ressalva do LEIA-ME.
  */
  it('evento com o íntegro guardado sai como procEventoNFe, assinatura e tudo', () => {
    const doc = documento();
    const proc =
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">\n'
      + `<evento versao="1.00"><infEvento Id="ID110111x01"><tpEvento>110111</tpEvento></infEvento>`
      + `<Signature><SignatureValue>${ASSINATURA}</SignatureValue></Signature></evento>\n`
      + '<retEvento versao="1.00"><infEvento><cStat>135</cStat>'
      + '<nProt>135260001112223</nProt></infEvento></retEvento>\n'
      + '</procEventoNFe>';
    evento({
      documentId: doc,
      tipo: 'cancelled',
      quando: `${PERIODO}-03T09:00:00.000Z`,
      xmlProc: proc,
    });

    const dentro = pacote();
    const eventos = [...dentro.keys()].filter((n) => n.startsWith('eventos/'));
    expect(eventos).toHaveLength(1);
    // O nome DIZ o formato — o contador arquiva pelo nome.
    expect(eventos[0]).toContain('-procEventoNFe.xml');
    // E o conteúdo é o documento íntegro, byte a byte, com a assinatura viva.
    expect(dentro.get(eventos[0])).toBe(proc);
    expect(dentro.get(eventos[0])).toContain(ASSINATURA);
    expect(dentro.get(eventos[0])).not.toContain('[removido]');

    // Com TODO evento do mês íntegro, o LEIA-ME descreve o formato de
    // arquivamento e NÃO manda o contador ao portal validar o validável.
    const leiaMe = dentro.get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('procEventoNFe');
    expect(leiaMe).not.toContain('"[removido]"');
  });

  it('evento LEGADO (sem o íntegro) continua saindo como retorno, com a ressalva', () => {
    const doc = documento();
    evento({ documentId: doc, tipo: 'cancelled', quando: `${PERIODO}-03T09:00:00.000Z` });

    const dentro = pacote();
    const eventos = [...dentro.keys()].filter((n) => n.startsWith('eventos/'));
    expect(eventos).toHaveLength(1);
    // Sem sufixo de procEventoNFe: o arquivo NÃO finge ser o que não é.
    expect(eventos[0]).not.toContain('procEventoNFe');
    /*
      A ressalva do "[removido]" é IRREVERSÍVEL para o passado — o que não
      foi guardado não existe — e o LEIA-ME continua explicando por que a
      assinatura desses arquivos não confere.
    */
    const leiaMe = dentro.get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('"[removido]"');
    expect(leiaMe).toContain('portal');
  });

  it('íntegro e legado convivem no mesmo mês — e o LEIA-ME conta os dois', () => {
    const doc = documento();
    evento({
      documentId: doc,
      tipo: 'cancelled',
      quando: `${PERIODO}-03T09:00:00.000Z`,
      xmlProc: '<procEventoNFe versao="1.00"><evento/><retEvento/></procEventoNFe>',
    });
    const outro = documento();
    evento({ documentId: outro, tipo: 'cce_authorized', quando: `${PERIODO}-04T09:00:00.000Z` });

    const leiaMe = pacote().get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('procEventoNFe');
    expect(leiaMe).toContain('1 arquivo(s) de evento são apenas o RETORNO');
  });
});

// ---------------------------------------------------------------------------
// NFC-e no pacote (GAP-V33)
// ---------------------------------------------------------------------------

/*
  A consulta de emitidas não filtra modelo — o 65 entra POR CONSTRUÇÃO. Só que
  todo documento fabricado neste arquivo era '55': uma regressão que filtrasse
  modelo (um `AND model = '55'` copiado de outra consulta) passaria verde.
  Este bloco é o que a faria ficar vermelha.
*/
describe('a NFC-e (modelo 65) no pacote', () => {
  it('a NFC-e autorizada entra em emitidas/ e conta na prévia', async () => {
    documento({ model: '65' });

    const dentro = pacote();
    const emitidas = [...dentro.keys()].filter((n) => n.startsWith('emitidas/'));
    expect(emitidas).toHaveLength(1);
    // O manifesto nomeia o modelo — é como o contador separa cupom de nota.
    expect(dentro.get('MANIFESTO.csv')).toContain('Modelo 65');

    const previa = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth);
    expect(previa.status).toBe(200);
    expect(previa.body.contagens.emitidasAutorizadas).toBe(1);
  });

  it('55 e 65 no mesmo mês saem juntos, cada um com seu arquivo', () => {
    documento({ model: '55' });
    documento({ model: '65' });
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Numeração
// ---------------------------------------------------------------------------

describe('a numeração inutilizada', () => {
  it('só a faixa AUTORIZADA entra — pedida e recusada continuam válidas', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-08T10:00:00.000Z`,
      model: '55',
      serie: 1,
      de: 10,
      ate: 12,
    });
    evento({
      tipo: 'void_requested',
      quando: `${PERIODO}-08T09:00:00.000Z`,
      model: '55',
      serie: 1,
      de: 20,
      ate: 22,
    });
    evento({
      tipo: 'void_rejected',
      quando: `${PERIODO}-09T09:00:00.000Z`,
      model: '55',
      serie: 1,
      de: 30,
      ate: 32,
    });

    const csv = pacote().get('numeracao/inutilizadas.csv')!;
    expect(csv).toContain('modelo;serie;numero_inicial;numero_final');
    expect(csv).toContain('55;1;10;12');
    /*
      Faixa PEDIDA e faixa RECUSADA não estão inutilizadas: aqueles números
      continuam válidos e ainda podem virar nota. Declará-las como queimadas
      faria o contador dar por perdida uma numeração viva.
    */
    expect(csv).not.toContain(';20;22');
    expect(csv).not.toContain(';30;32');
  });

  it('faixa de outro mês não entra', () => {
    evento({
      tipo: 'void_authorized',
      quando: '2026-06-30T10:00:00.000Z',
      model: '55',
      serie: 1,
      de: 40,
      ate: 41,
    });
    expect([...pacote().keys()].filter((n) => n.startsWith('numeracao/'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Truncamento silencioso
// ---------------------------------------------------------------------------

describe('nada é truncado em silêncio', () => {
  it('310 notas emitidas saem TODAS — a consulta da tela para em 300', () => {
    /*
      `listFiscalDocuments` termina em LIMIT 300. Reusá-la aqui truncaria um
      mês real sem nenhum sinal: o zip sairia, abriria, e faltariam dez notas.
      Este é o número que prova que a consulta do pacote é outra.
    */
    for (let i = 0; i < 310; i += 1) documento();
    expect([...pacote().keys()].filter((n) => n.startsWith('emitidas/'))).toHaveLength(310);
  });

  it('205 faixas inutilizadas saem TODAS — a consulta da tela para em 200', () => {
    for (let i = 0; i < 205; i += 1) {
      evento({
        tipo: 'void_authorized',
        quando: `${PERIODO}-08T10:00:00.000Z`,
        model: '55',
        serie: 1,
        de: 1000 + i,
        ate: 1000 + i,
      });
    }
    const csv = pacote().get('numeracao/inutilizadas.csv')!;
    // Cabeçalho + 205 faixas + a linha vazia do CRLF final.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(206);
  });
});

// ---------------------------------------------------------------------------
// O teto
// ---------------------------------------------------------------------------

describe('o teto', () => {
  it('acima de 5000 documentos o pacote é recusado, com o número medido', async () => {
    /*
      O zip é montado inteiro em memória, e cada XML é lido para a memória
      antes disso. Sem teto, um mês grande derrubaria o processo do servidor —
      para todo mundo, não só para quem clicou. A recusa com número é a
      diferença entre "caiu" e "peça em duas metades".
    */
    const db = getConnection();
    const stmt = db.prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, model, serie, number, access_key, environment, status,
          xml_signed, xml_authorized, protocol, issued_at, created_at, updated_at)
       VALUES (?, ?, '55', 9, ?, ?, 'production', 'AUTHORIZED', '<NFe/>', '<r/>', ?, ?, ?, ?)`,
    );
    const quando = `${PERIODO}-15T12:00:00.000Z`;
    // `withTransaction` e não BEGIN/COMMIT à mão: um erro no meio do laço
    // deixaria a transação aberta e TODOS os testes seguintes falhariam com
    // "cannot start a transaction within a transaction" — um vermelho em massa
    // sem nexo com a causa.
    withTransaction(() => {
      for (let i = 0; i < TETO_DE_DOCUMENTOS + 1; i += 1) {
        stmt.run(randomUUID(), companyId, i, chave(100000 + i), `p${i}`, quando, quando, quando);
      }
    });

    expect(() => montarPacote(companyId, PERIODO)).toThrowError(/5001/);

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(auth);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('CORE_FISCAL_PACOTE_GRANDE_DEMAIS');
  });
});

// ---------------------------------------------------------------------------
// A rota
// ---------------------------------------------------------------------------

describe('a rota do download', () => {
  it('entrega zip com nome de arquivo e registra quem levou', async () => {
    documento();

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const pedacos: Buffer[] = [];
        r.on('data', (d: Buffer) => pedacos.push(d));
        r.on('end', () => cb(null, Buffer.concat(pedacos)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="pacote-preco-justo-2026-07.zip"',
    );

    // Chegou um zip DE VERDADE, não um JSON de erro com status 200.
    const dentro = abrirZip(res.body as Buffer);
    expect(dentro.has('LEIA-ME.txt')).toBe(true);

    /*
      A AUDITORIA. O que sai daqui é a contabilidade inteira de um mês saindo
      da empresa. Seis meses depois, "quem baixou o pacote de julho?" tem que
      ter resposta.
    */
    const trilha = getConnection()
      .prepare(
        `SELECT user_id, entity_id, detail FROM core_audit_log
          WHERE company_id = ? AND action = 'fiscal.closing.package'`,
      )
      .all(companyId) as { user_id: string; entity_id: string; detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].entity_id).toBe(PERIODO);
    expect(JSON.parse(trilha[0].detail).nomeArquivo).toBe('pacote-preco-justo-2026-07.zip');
  });

  it('o Content-Disposition é exposto ao JavaScript pelo CORS', async () => {
    /*
      Sem `exposedHeaders`, o navegador FILTRA este cabeçalho antes de o código
      vê-lo — ele chega na rede e some do alcance do JavaScript. O download é
      feito por fetch (a janela aberta com window.open não manda o Bearer e
      leva 401), então quem nomeia o arquivo é o código lendo este cabeçalho.
      Sem esta linha o contador recebe um GUID em vez do nome do pacote, e
      nenhum erro aparece em lugar nenhum.
    */
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth)
      .set('Origin', 'http://localhost:5173');

    // A lista pode ter outros cabeçalhos (X-Perfil-Em-Vigor, GAP-PRD-053); o que
    // este caso cobra é que o Content-Disposition esteja nela — e o SHA-256 do
    // pacote (GAP-PRD-176), pelo mesmo motivo: a tela o mostra.
    const expostos = String(res.headers['access-control-expose-headers']).split(',').map((h) => h.trim());
    expect(expostos).toContain('Content-Disposition');
    expect(expostos).toContain('X-Pacote-Sha256');
  });

  it('o slug hostil não entra cru no cabeçalho', async () => {
    /*
      Cabeçalho é texto: aspas e quebra de linha dentro dele mudam o
      significado da resposta inteira — uma quebra permite ANEXAR outro
      cabeçalho. O slug vem de cadastro, ou seja, de gente digitando.
    */
    /*
      A carga é escolhida a dedo: aspas e ponto-e-vírgula, SEM quebra de linha.

      Com quebra de linha o Node recusa o cabeçalho sozinho e a rota devolve
      500 — o teste ficaria vermelho pelo motivo errado, provando que a
      biblioteca se defende e não que este código se defende. Sem quebra de
      linha o cabeçalho é ACEITO e sai
      `filename="pacote-ma"; filename="roubado.zip-...zip"`: o navegador lê o
      segundo `filename` e salva o arquivo com o nome que o cadastro escolheu.
    */
    const hostil = upsertCompany({
      slug: 'ma"; filename="roubado.zip',
      legalName: 'Hostil Ltda',
      tradeName: 'Hostil',
    });
    /*
      O ator é montado à mão porque `loginForTest` CRIA a empresa a partir do
      id que recebe — e aqui a empresa já existe, com um slug que ele não
      escreveria. Reusar o helper esbarraria na chave primária e o vermelho
      falaria de outra coisa.
    */
    const userId = await upsertUser({
      login: 'gerente@hostil',
      displayName: 'Gerente Hostil',
      password: TEST_PASSWORD,
    });
    linkUserToCompany(userId, hostil, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'gerente@hostil', password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set({ Authorization: `Bearer ${login.body.accessToken}` });

    expect(res.status).toBe(200);
    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; filename="pacote-[a-z0-9-]+-2026-07\.zip"$/);
    expect(disposition).not.toContain('roubado.zip');
  });

  it('o caixa não leva a contabilidade do mês para fora', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-1',
      companyId,
      profileCodes: ['operador_caixa_loja'],
    });
    const cabecalho = { Authorization: `Bearer ${caixa.body.accessToken}` };

    const previa = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(cabecalho);
    expect(previa.status).toBe(403);

    const download = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`)
      .set(cabecalho);
    expect(download.status).toBe(403);
  });

  it('sem token não passa', async () => {
    const res = await request(app).get(`/api/v1/core/fiscal/closings/${PERIODO}/pacote`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// O LEIA-ME
// ---------------------------------------------------------------------------

describe('o LEIA-ME conta a verdade inteira', () => {
  it('a emissão parada tem DUAS causas, e as duas estão escritas', () => {
    const leiaMe = pacote().get('LEIA-ME.txt')!;

    /*
      A meia verdade custaria caro aqui. A leitura fácil é "falta o certificado
      A1" — e quem lesse só isso compraria o certificado, instalaria, tentaria
      emitir e receberia um erro que não fala de certificado nenhum:
      `SEFAZ_ENDPOINTS` é um objeto VAZIO, e os endereços de web service de
      cada UF também precisam ser preenchidos.
    */
    expect(leiaMe).toContain('CERTIFICADO DIGITAL A1');
    expect(leiaMe).toContain('ENDEREÇOS DOS WEB SERVICES DA SEFAZ');
    expect(leiaMe).toContain('Resolver só uma não destrava');
  });

  it('a nota de compra sem arquivo é declarada, com o número dela', () => {
    notaRecebida({ entrada: `${PERIODO}-07T12:00:00.000Z`, xml: null });
    const dentro = pacote();

    expect(dentro.get('LEIA-ME.txt')).toContain('1 nota(s) de compra entraram neste período');
    // E aparece no manifesto pela chave, para poder ser investigada uma a uma.
    expect(dentro.get('MANIFESTO.csv')).toContain('(não guardado)');
  });

  it('as ressalvas do DRE viajam junto com o DRE', () => {
    const leiaMe = pacote().get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('O QUE O DRE NÃO INCLUI');
    // A ressalva do CMV é a que mais muda a leitura do resultado.
    expect(leiaMe).toMatch(/CMV|custo/i);
  });

  it('diz que não é SPED nem apuração de imposto', () => {
    expect(pacote().get('LEIA-ME.txt')).toContain('Não é SPED');
  });
});

// ---------------------------------------------------------------------------
// Os CSV
// ---------------------------------------------------------------------------

describe('os arquivos de planilha', () => {
  it('o manifesto tem uma linha por arquivo do pacote', () => {
    documento();
    notaRecebida({ entrada: `${PERIODO}-05T12:00:00.000Z` });

    const dentro = pacote();
    const linhas = dentro
      .get('MANIFESTO.csv')!
      .trimEnd()
      .split('\r\n')
      .slice(1);

    // Cada arquivo do zip, menos os dois que descrevem o pacote.
    const arquivos = [...dentro.keys()].filter(
      (n) => n !== 'LEIA-ME.txt' && n !== 'MANIFESTO.csv',
    );
    for (const nome of arquivos) {
      expect(linhas.some((l) => l.includes(nome))).toBe(true);
    }
  });

  it('abre com BOM, para o Excel em português não quebrar o acento', () => {
    const csv = pacote().get('resultado/dre.csv')!;
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });

  it('ponto-e-vírgula dentro de um campo não desloca as colunas', () => {
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_events
           (id, company_id, event_type, protocol, model, serie, number_from, number_to,
            justification, created_at)
         VALUES (?, ?, 'void_authorized', '135', '55', 1, 50, 50, ?, ?)`,
      )
      .run(
        randomUUID(),
        companyId,
        'Erro de digitacao; numero pulado no talao',
        `${PERIODO}-20T10:00:00.000Z`,
      );

    const csv = pacote().get('numeracao/inutilizadas.csv')!;
    expect(csv).toContain('"Erro de digitacao; numero pulado no talao"');
  });
});

/*
  DADO SIMULADO NÃO PODE ENTRAR NO PACOTE — nem pela porta dos eventos.

  O filtro de produção (`SO_PRODUCAO`) pergunta ao DOCUMENTO: ambiente,
  protocolo e marca de fixture moram em `core_fiscal_documents`. Só que a
  INUTILIZAÇÃO não tem documento — é uma faixa de números queimada, uma linha
  solta em `core_fiscal_events` — e por isso escapava inteira da peneira.

  O que isso valia HOJE: sem certificado e sem endereço de SEFAZ configurado,
  TODA inutilização que o sistema consegue registrar é simulada, com protocolo
  `TEST-`. O pacote sairia com `numeracao/inutilizadas.csv` listando faixas
  fabricadas — e faixa queimada é obrigação acessória, não enfeite. O contador
  leria aquilo como fato.

  Entregar dado de teste dentro de um pacote fiscal é pior do que entregar
  pacote vazio: o vazio se percebe.
*/
describe('o dado simulado fica de fora, inclusive onde não há documento', () => {
  it('faixa inutilizada com protocolo de teste não entra no CSV', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-10T10:00:00.000Z`,
      protocolo: `${TEST_PROTOCOL_PREFIX}999`,
      model: '55',
      serie: 1,
      de: 10,
      ate: 12,
    });

    const arquivos = pacote();
    // A pasta inteira não deve existir: era a única faixa do mês.
    const numeracao = [...arquivos.keys()].filter((n) => n.startsWith('numeracao/'));
    expect(numeracao).toEqual([]);
  });

  it('e a mesma faixa, com protocolo de verdade, entra', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-10T10:00:00.000Z`,
      protocolo: '135260001234567',
      model: '55',
      serie: 1,
      de: 10,
      ate: 12,
    });

    const csv = pacote().get('numeracao/inutilizadas.csv');
    expect(csv).toBeDefined();
    expect(csv).toContain('10');
    expect(csv).toContain('12');
  });

  /*
    A PRÉVIA E O PACOTE PRECISAM CONCORDAR.

    Se só uma das duas consultas filtrasse, a tela contaria uma faixa que o zip
    não traz — e divergência entre o que se promete e o que se entrega é
    exatamente o defeito que este serviço existe para não cometer.
  */
  it('a prévia conta a mesma coisa que o pacote entrega', async () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-10T10:00:00.000Z`,
      protocolo: `${TEST_PROTOCOL_PREFIX}999`,
      model: '55',
      serie: 1,
      de: 10,
      ate: 12,
    });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.contagens.faixasInutilizadas).toBe(0);
  });
});

/*
  O PACOTE NÃO PODE SE CONTRADIZER.

  O bloco "POR QUE NÃO HÁ NOTA EMITIDA" era escrito SEMPRE. Num pacote com
  notas emitidas dentro, o contador leria essa frase logo abaixo da pasta
  cheia — e a primeira reação de quem lê isso é desconfiar do que veio, não do
  texto. Um pacote que se contradiz gasta a confiança que ele existe para
  construir.
*/
describe('a explicação da ausência só sai quando há ausência', () => {
  it('sem nota emitida, o LEIA-ME explica as duas causas', () => {
    const leiaMe = pacote().get('LEIA-ME.txt') ?? '';
    expect(leiaMe).toContain('POR QUE NÃO HÁ NOTA EMITIDA');
    // As duas, e não só o certificado: endereço de SEFAZ vazio trava igual.
    expect(leiaMe).toContain('CERTIFICADO DIGITAL A1');
    expect(leiaMe).toContain('WEB SERVICES DA SEFAZ');
  });

  it('com nota emitida, a seção some', () => {
    documento({});
    const leiaMe = pacote().get('LEIA-ME.txt') ?? '';
    expect(leiaMe).not.toContain('POR QUE NÃO HÁ NOTA EMITIDA');
  });
});

// ---------------------------------------------------------------------------
// A INUTILIZAÇÃO ENTREGA O ARQUIVO, NÃO SÓ A LINHA DA PLANILHA
// ---------------------------------------------------------------------------

/*
  ============================================================================
  O RESÍDUO DA ONDA 5, DO LADO DO PACOTE
  ============================================================================

  A rodada anterior fez a inutilização ACEITA guardar o `procInutNFe` íntegro
  em `core_fiscal_events.xml_proc` — o inutNFe assinado costurado com o
  retInutNFe da SEFAZ, prova validável fora do portal
  (`a-inutilizacao-tambem-deixa-prova.test.ts`).

  E o pacote do contador não o entregava. A consulta de eventos filtra
  `event_type IN ('cancelled', 'cce_authorized')`, e a inutilização não é
  nenhum dos dois: ela saía do zip como UMA LINHA em
  `numeracao/inutilizadas.csv` — modelo, série, faixa, protocolo, data,
  justificativa. Texto que este sistema digitou sobre si mesmo.

  Numa fiscalização sobre o buraco na numeração, o que a empresa tem para
  mostrar é exatamente isso: uma planilha que ela mesma escreveu. O arquivo
  assinado estava no banco, guardado, e não chegava a quem precisa dele.

  COMO ELE FALHA: tirar `void_authorized` da consulta de arquivos da numeração
  deixa os casos abaixo vermelhos de uma vez — o íntegro, o legado e a
  contagem do LEIA-ME.
*/
describe('a inutilização entrega o procInutNFe, não só a linha do CSV', () => {
  const PROC_INUT =
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<procInutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + '<inutNFe><infInut><xJust>Falha na bobina</xJust></infInut>'
    + `<Signature><SignatureValue>${ASSINATURA}</SignatureValue></Signature></inutNFe>`
    + '<retInutNFe><infInut><cStat>102</cStat><nProt>143260000000202</nProt></infInut></retInutNFe>'
    + '</procInutNFe>';

  it('a faixa COM o íntegro sai como arquivo, com a assinatura viva', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-08T10:00:00.000Z`,
      protocolo: '143260000000202',
      xmlProc: PROC_INUT,
      model: '65',
      serie: 1,
      de: 10,
      ate: 12,
    });

    const dentro = pacote();
    const xmls = [...dentro.keys()].filter((n) => n.startsWith('numeracao/') && n.endsWith('.xml'));
    expect(xmls).toHaveLength(1);

    // O nome DIZ o formato — o contador arquiva pelo nome, como no evento.
    expect(xmls[0]).toContain('-procInutNFe.xml');
    // E o conteúdo é o documento íntegro, byte a byte.
    expect(dentro.get(xmls[0])).toBe(PROC_INUT);
    expect(dentro.get(xmls[0])).toContain(ASSINATURA);
    expect(dentro.get(xmls[0])).not.toContain('[removido]');

    // O CSV continua existindo: ele é o índice legível da numeração queimada.
    expect(dentro.get('numeracao/inutilizadas.csv')).toContain('65;1;10;12');

    // E o MANIFESTO aponta o arquivo, com a faixa como referência.
    const manifesto = dentro.get('MANIFESTO.csv')!;
    expect(manifesto).toContain(xmls[0]);
    expect(manifesto).toContain('Inutilização de numeração (procInutNFe)');
  });

  it('a faixa LEGADO sai como o retorno da SEFAZ, sem fingir ser o íntegro', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-08T10:00:00.000Z`,
      protocolo: '143260000000203',
      xml:
        '<retInutNFe><infInut><cStat>102</cStat>'
        + '<Signature><SignatureValue>[removido]</SignatureValue></Signature>'
        + '</infInut></retInutNFe>',
      model: '55',
      serie: 1,
      de: 20,
      ate: 20,
    });

    const dentro = pacote();
    const xmls = [...dentro.keys()].filter((n) => n.startsWith('numeracao/') && n.endsWith('.xml'));
    expect(xmls).toHaveLength(1);
    /*
      Sem o sufixo: o arquivo NÃO finge ser o que não é. É a MESMA distinção
      que os eventos já fazem — "melhorar" o legado montando um procInutNFe
      com a assinatura "[removido]" dentro produziria o arquivo que abre e não
      prova nada.
    */
    expect(xmls[0]).not.toContain('procInutNFe');
    expect(dentro.get(xmls[0])).toContain('[removido]');

    const leiaMe = dentro.get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('1 arquivo(s) de inutilização são apenas o RETORNO');
    expect(leiaMe).toContain('portal');
  });

  it('faixa SEM arquivo nenhum vira linha no manifesto, não silêncio', () => {
    /*
      A faixa registrada antes de a guarda existir e sem nem o retorno salvo. O
      fato existe — o número está queimado — e o pacote diz que o arquivo não
      existe, em vez de deixar a ausência passar por completude.
    */
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-08T10:00:00.000Z`,
      protocolo: '143260000000204',
      xml: null,
      model: '55',
      serie: 1,
      de: 30,
      ate: 31,
    });

    const dentro = pacote();
    expect([...dentro.keys()].filter((n) => n.endsWith('.xml'))).toHaveLength(0);
    expect(dentro.get('numeracao/inutilizadas.csv')).toContain('55;1;30;31');
    expect(dentro.get('MANIFESTO.csv')).toContain('(não guardado)');
  });

  it('íntegro e legado convivem — e o LEIA-ME conta os dois', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-08T10:00:00.000Z`,
      protocolo: '143260000000205',
      xmlProc: PROC_INUT,
      model: '65',
      serie: 1,
      de: 10,
      ate: 12,
    });
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-09T10:00:00.000Z`,
      protocolo: '143260000000206',
      model: '55',
      serie: 1,
      de: 40,
      ate: 40,
    });

    const leiaMe = pacote().get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('procInutNFe');
    expect(leiaMe).toContain('1 arquivo(s) de inutilização são apenas o RETORNO');
  });

  it('a faixa SIMULADA continua fora — nem CSV, nem arquivo', () => {
    evento({
      tipo: 'void_authorized',
      quando: `${PERIODO}-10T10:00:00.000Z`,
      protocolo: `${TEST_PROTOCOL_PREFIX}999`,
      xmlProc: PROC_INUT,
      model: '55',
      serie: 1,
      de: 10,
      ate: 12,
    });
    /*
      A peneira do dado simulado vale para o ARQUIVO também, e não só para a
      planilha. Um procInutNFe fabricado pelo simulador dentro do pacote seria
      pior que a linha de CSV inventada: ele tem cara de documento.
    */
    expect([...pacote().keys()].filter((n) => n.startsWith('numeracao/'))).toEqual([]);
  });

  it('o pedido e a recusa não viram arquivo — número vivo não tem prova de morte', () => {
    evento({
      tipo: 'void_requested',
      quando: `${PERIODO}-08T09:00:00.000Z`,
      xmlProc: PROC_INUT,
      model: '55',
      serie: 1,
      de: 50,
      ate: 52,
    });
    evento({
      tipo: 'void_rejected',
      quando: `${PERIODO}-09T09:00:00.000Z`,
      xmlProc: PROC_INUT,
      model: '55',
      serie: 1,
      de: 60,
      ate: 62,
    });
    expect([...pacote().keys()].filter((n) => n.startsWith('numeracao/'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TRÊS AUSÊNCIAS DIFERENTES, TRÊS EXPLICAÇÕES DIFERENTES
// ---------------------------------------------------------------------------

/*
  ============================================================================
  O BALDE "SEM ARQUIVO" ERA UM BALDE SÓ — E CABIAM TRÊS FATOS NELE
  ============================================================================

  A consulta das notas recebidas perguntava UMA coisa: `xml_original` está
  vazio? Quem respondesse "sim" caía num balde cuja explicação é específica e
  irreversível — "esta nota entrou antes da versão 58, o XML foi lido e
  descartado, não há como recuperá-lo".

  Duas outras coisas caíam ali, e a frase mente sobre as duas:

    - a ENTRADA MANUAL (GAP-V17, `doc_type = 'manual'`): a compra da feira, do
      autônomo, do produtor rural. Ela NUNCA teve XML porque nota fiscal não
      houve. Dizer que o arquivo "não existe mais" manda o contador procurar um
      documento que jamais existiu — e esconde o que ele precisa saber, que é
      uma compra SEM documento fiscal, com tratamento próprio na escrituração.

    - a nota ESTORNADA (GAP-V20): entrada confirmada e depois DESFEITA,
      documento morto. Ela caía em dois lugares errados ao mesmo tempo: na
      pendência "ainda em conferência" da prévia, porque a contagem era por
      COMPLEMENTO (`status <> 'recebida'`) — a mesma armadilha de sempre —, e,
      quando tinha XML, dentro de `recebidas/` como compra viva.

  COMO ELE FALHA:
    - devolver `naoConferidas` ao complemento `status <> 'recebida'` acende
      RECEBIDA_NAO_CONFERIDA sobre a estornada e o primeiro caso fica vermelho;
    - devolver a entrada manual ao balde do XML perdido zera
      `recebidasSemNota` e faz `recebidasSemArquivo` contar 2;
    - tirar o filtro de status da consulta de `recebidas/` põe o XML da nota
      morta de volta na pasta das compras vivas.
*/
describe('as três ausências da nota de entrada não se confundem', () => {
  const DIA = `${PERIODO}-05T12:00:00.000Z`;

  it('a prévia separa compra sem NF-e, entrada estornada e XML perdido', async () => {
    entradaManual(DIA);
    notaRecebida({ entrada: DIA, status: NOTA_ESTORNADA });
    notaRecebida({ entrada: DIA, xml: null });
    notaRecebida({ entrada: DIA });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(res.body.contagens).toMatchObject({
      recebidasComArquivo: 1,
      // Só a nota pré-v58 continua neste balde: é a única de quem a frase
      // "o arquivo não existe mais" é verdade.
      recebidasSemArquivo: 1,
      recebidasSemNota: 1,
      recebidasEstornadas: 1,
    });

    /*
      E a nota MORTA não é uma nota em conferência. A contagem era por
      complemento (`status <> 'recebida'`), então a estornada acendia uma
      pendência mandando conferir mercadoria de uma entrada já desfeita.
    */
    const codigos = res.body.pendencias.map((p: { codigo: string }) => p.codigo);
    expect(codigos).not.toContain('RECEBIDA_NAO_CONFERIDA');
    expect(codigos).toContain('RECEBIDA_SEM_ARQUIVO');

    // A pendência do XML perdido conta UMA, e não três.
    const perdido = res.body.pendencias.find(
      (p: { codigo: string }) => p.codigo === 'RECEBIDA_SEM_ARQUIVO',
    );
    expect(perdido.quantidade).toBe(1);
  });

  it('a nota EM CONFERÊNCIA continua acendendo a pendência dela', async () => {
    notaRecebida({ entrada: DIA, status: NOTA_IMPORTADA });
    const res = await request(app)
      .get(`/api/v1/core/fiscal/closings/${PERIODO}/previa`)
      .set(auth);
    const codigos = res.body.pendencias.map((p: { codigo: string }) => p.codigo);
    expect(codigos).toContain('RECEBIDA_NAO_CONFERIDA');
  });

  it('o manifesto dá a cada ausência a linha e a explicação dela', () => {
    entradaManual(DIA);
    notaRecebida({ entrada: DIA, status: NOTA_ESTORNADA, xml: null });
    notaRecebida({ entrada: DIA, xml: null });

    const manifesto = pacote().get('MANIFESTO.csv')!;
    expect(manifesto).toContain('Compra sem nota fiscal (entrada manual)');
    expect(manifesto).toContain('Entrada estornada (documento morto)');
    expect(manifesto).toContain('(não guardado)');
    // A frase do XML perdido não pode aparecer sobre quem nunca teve XML.
    const linhaManual = manifesto
      .split('\r\n')
      .find((l) => l.includes('Compra sem nota fiscal'))!;
    expect(linhaManual).not.toContain('não existe mais');
    expect(linhaManual).toContain('sem nota fiscal');
  });

  it('o LEIA-ME conta as três com números próprios', () => {
    entradaManual(DIA);
    entradaManual(DIA);
    notaRecebida({ entrada: DIA, status: NOTA_ESTORNADA });
    notaRecebida({ entrada: DIA, xml: null });

    const leiaMe = pacote().get('LEIA-ME.txt')!;
    expect(leiaMe).toContain('2 compra(s) sem nota fiscal');
    expect(leiaMe).toContain('1 entrada(s) do período foram ESTORNADAS');
    expect(leiaMe).toContain('1 nota(s) de compra entraram neste período');
  });

  it('o XML da nota ESTORNADA sai da pasta das compras vivas', () => {
    notaRecebida({ entrada: DIA, status: NOTA_ESTORNADA });
    notaRecebida({ entrada: DIA });

    const dentro = pacote();
    /*
      A PASTA É A INTERFACE: quem recebe o zip arrasta `recebidas/` inteira
      para o importador do escritório, e o manifesto fica para depois. Uma nota
      estornada ali dentro vira compra escriturada — só que o estoque já
      voltou, o contas a pagar já foi cancelado, e o resultado do mês ganharia
      uma despesa que o próprio sistema desfez.
    */
    expect([...dentro.keys()].filter((n) => n.startsWith('recebidas/'))).toHaveLength(1);
    const mortas = [...dentro.keys()].filter((n) => n.startsWith('estornadas/'));
    expect(mortas).toHaveLength(1);
    // O arquivo continua saindo: a NF-e existe na SEFAZ contra este CNPJ, e o
    // contador precisa saber que ela existe E que não foi escriturada.
    expect(dentro.get(mortas[0])).toContain('compra');
    expect(dentro.get('LEIA-ME.txt')).toContain('estornadas/');
  });
});
