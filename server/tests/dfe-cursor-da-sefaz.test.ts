/**
 * ============================================================================
 * O CURSOR DA DISTRIBUIÇÃO DF-e É O QUE A SEFAZ DEVOLVE (R3-DFE, GAP-PRD-168)
 * ============================================================================
 *
 * O cursor era o MAX(nsu) GRAVADO. Depois de um cStat 137 ("nenhum documento
 * localizado") ou de um lote só com o que não gravamos, ele não andava: a
 * próxima consulta repetia o mesmo ultNSU, e a regra do Ambiente Nacional
 * (NT 2014.002) trata consulta repetida sem documento novo como consumo
 * indevido — cStat 656 bloqueia o CNPJ por uma hora. E quando o lote volta com
 * ultNSU < maxNSU, a SEFAZ manda continuar consultando até alcançar o maxNSU;
 * o clique parava no primeiro lote.
 *
 * Agora, por (empresa, ambiente), ficam o ultNSU e o maxNSU devolvidos e o
 * instante da resposta. A consulta parte do ultNSU guardado (nunca de menos
 * que o MAX(nsu) gravado), continua em laço enquanto ultNSU < maxNSU (com teto
 * por clique) e, com 137 ou ultNSU = maxNSU, não sai de novo antes de uma hora
 * — o clique é recusado dizendo a hora. 656 fica gravado e é respeitado.
 *
 * O transporte do adapter real é trocado por um espião (`enviar`) que faz o
 * papel das DUAS SEFAZ. Nada sai.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import { LOTES_POR_CONSULTA } from '../src/services/core/DfeDistribuicaoService.js';
import { horaDaLoja } from '../src/services/core/CalendarioOperacional.js';
import { loginForTest } from './helpers/auth.js';
import { gerarCertificado } from './helpers/certificado.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();

const CNPJ = '11222333000181';
const SENHA = 'Senha@DoCofreCursor';
const FORNECEDOR = '14200166000187';
const UMA_HORA = 60 * 60 * 1000;

type Ambiente = 'homologation' | 'production';

let pfx: string;
let empresa: string;
let auth: { Authorization: string };
let transmitidos: { servico: string; dados: string }[];

/**
 * O que cada SEFAZ tem: `max` documentos (NSU 1..max) e lotes de `lote`. Uma
 * resposta pode ser trocada inteira por teste (`responder`).
 */
let sefaz: Record<Ambiente, { max: number; lote: number }>;
let responder: ((ambiente: Ambiente, ultPedido: number) => string | null) | null;

function chave(ambiente: Ambiente, n: number): string {
  const numero = String((ambiente === 'homologation' ? 100000 : 200000) + n).padStart(9, '0');
  return `432609${FORNECEDOR}55001${numero}1${String(n).padStart(8, '0')}5`;
}

function resumo(ambiente: Ambiente, n: number): string {
  return (
    '<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">'
    + `<chNFe>${chave(ambiente, n)}</chNFe><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor ${n}</xNome>`
    + '<IE>123456789</IE><dhEmi>2026-09-01T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>10.00</vNF>'
    + '<digVal>abc=</digVal><dhRecbto>2026-09-01T10:00:05-03:00</dhRecbto>'
    + '<nProt>143260000009999</nProt><cSitNFe>1</cSitNFe></resNFe>'
  );
}

function nsu15(n: number): string {
  return String(n).padStart(15, '0');
}

function retorno(input: {
  ambiente: Ambiente;
  cStat: string;
  xMotivo: string;
  ult: number;
  max: number;
  docs?: number[];
}): string {
  const tpAmb = input.ambiente === 'production' ? '1' : '2';
  const docs = (input.docs ?? [])
    .map((n) => {
      const zip = gzipSync(Buffer.from(resumo(input.ambiente, n), 'utf8')).toString('base64');
      return `<docZip NSU="${nsu15(n)}" schema="resNFe_v1.01.xsd">${zip}</docZip>`;
    })
    .join('');
  return (
    `<retDistDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>${tpAmb}</tpAmb>`
    + `<cStat>${input.cStat}</cStat><xMotivo>${input.xMotivo}</xMotivo>`
    + `<dhResp>2026-09-13T10:00:00-03:00</dhResp><ultNSU>${nsu15(input.ult)}</ultNSU><maxNSU>${nsu15(input.max)}</maxNSU>`
    + (docs ? `<loteDistDFeInt>${docs}</loteDistDFeInt>` : '')
    + '</retDistDFeInt>'
  );
}

function sefazDoAmbienteNacional(dados: string): string {
  const ambiente: Ambiente = /<tpAmb>1<\/tpAmb>/.test(dados) ? 'production' : 'homologation';
  const ult = Number(/<ultNSU>(\d+)<\/ultNSU>/.exec(dados)?.[1] ?? '0');
  const trocada = responder?.(ambiente, ult);
  if (trocada) return trocada;
  const { max, lote } = sefaz[ambiente];
  if (ult >= max) {
    return retorno({ ambiente, cStat: '137', xMotivo: 'Nenhum documento localizado', ult: max, max });
  }
  const ate = Math.min(ult + lote, max);
  const docs = Array.from({ length: ate - ult }, (_, i) => ult + 1 + i);
  return retorno({ ambiente, cStat: '138', xMotivo: 'Documento localizado', ult: ate, max, docs });
}

function virar(ambiente: Ambiente): void {
  getConnection().prepare('UPDATE core_fiscal_configs SET environment = ? WHERE company_id = ?').run(ambiente, empresa);
}

function consultar() {
  return request(app).post('/api/v1/core/purchases/dfe/consultar').set(auth).send({});
}

function pedidos(): number[] {
  return transmitidos
    .filter((t) => t.servico === 'dist')
    .map((t) => Number(/<ultNSU>(\d+)<\/ultNSU>/.exec(t.dados)?.[1] ?? 'NaN'));
}

function documentos(ambiente: Ambiente): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_dfe_documents WHERE company_id = ? AND environment = ?')
      .get(empresa, ambiente) as { n: number }
  ).n;
}

function cursor(ambiente: Ambiente): Record<string, unknown> | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_dfe_cursors WHERE company_id = ? AND environment = ?')
    .get(empresa, ambiente) as Record<string, unknown> | undefined;
}

/** A hora passou: a espera guardada vence (o relógio do teste não anda). */
function passarUmaHora(): void {
  getConnection()
    .prepare('UPDATE core_dfe_cursors SET next_query_at = ? WHERE company_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), empresa);
}

beforeAll(() => {
  pfx = gerarCertificado(`LOJA CURSOR LTDA:${CNPJ}`, SENHA);
});

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, { userId: 'gerente-cursor', companyId: 'loja-cursor', profileCodes: ['gerente_loja'] });
  expect(res.status).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  empresa = res.body.company.id;
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Loja Cursor Ltda',
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
  grupoTributarioPadrao(empresa);
  upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA });

  sefaz = { homologation: { max: 25, lote: 10 }, production: { max: 4, lote: 10 } };
  responder = null;
  transmitidos = [];
  vi.spyOn(
    SefazRealAdapter.prototype as unknown as {
      enviar: (url: string, servico: string, dados: string) => Promise<string>;
    },
    'enviar',
  ).mockImplementation(async (_url: string, servico: string, dados: string) => {
    transmitidos.push({ servico, dados });
    if (servico !== 'dist') throw new Error(`serviço inesperado: ${servico}`);
    return sefazDoAmbienteNacional(dados);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ultNSU < maxNSU: o mesmo clique continua até alcançar', () => {
  it('lote com ultNSU=10 e maxNSU=25: três consultas no mesmo clique (0, 10, 20) e as 25 notas gravadas', async () => {
    const res = await consultar();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(pedidos()).toEqual([0, 10, 20]);
    expect(res.body.novos).toBe(25);
    expect(res.body.ultimoNsu).toBe(25);
    expect(res.body.maxNsu).toBe(25);
    expect(documentos('homologation')).toBe(25);
    const c = cursor('homologation')!;
    expect(Number(c.ult_nsu)).toBe(25);
    expect(Number(c.max_nsu)).toBe(25);
    expect(c.last_c_stat).toBe('138');
    expect(c.last_response_at).toBeTruthy();
  });

  it('o teto por clique: com muito a baixar, para no teto, diz que resta e o próximo clique continua de onde parou', async () => {
    sefaz.homologation = { max: 10 * (LOTES_POR_CONSULTA + 3), lote: 10 };

    const primeiro = await consultar();

    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(200);
    expect(pedidos()).toHaveLength(LOTES_POR_CONSULTA);
    expect(primeiro.body.restamDocumentos).toBe(true);
    expect(primeiro.body.proximaConsultaEm).toBeNull();

    transmitidos = [];
    const segundo = await consultar();
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(200);
    expect(pedidos()[0]).toBe(10 * LOTES_POR_CONSULTA);
    expect(pedidos()).toHaveLength(3);
    expect(segundo.body.restamDocumentos).toBe(false);
    expect(documentos('homologation')).toBe(10 * (LOTES_POR_CONSULTA + 3));
  });
});

describe('em dia (137, ou ultNSU = maxNSU): a próxima consulta só depois de uma hora', () => {
  it('137: o clique seguinte, antes de 1 h, é recusado com a hora — e nada vai à SEFAZ', async () => {
    sefaz.homologation = { max: 0, lote: 10 };
    const antes = Date.now();

    const primeira = await consultar();
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(200);
    expect(primeira.body.novos).toBe(0);
    const proxima = Date.parse(primeira.body.proximaConsultaEm);
    expect(proxima).toBeGreaterThanOrEqual(antes + UMA_HORA);
    expect(proxima).toBeLessThanOrEqual(Date.now() + UMA_HORA);

    transmitidos = [];
    const segunda = await consultar();

    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_DFE_AGUARDE_A_SEFAZ');
    expect(segunda.body.error.message).toContain(horaDaLoja(new Date(proxima)));
    expect(segunda.body.error.message).toMatch(/656/);
    expect(segunda.body.error.details.proximaConsultaEm).toBe(primeira.body.proximaConsultaEm);
    expect(transmitidos).toEqual([]);

    // A Entrada de Notas recebe a espera junto com a lista (o botão a mostra).
    const lista = await request(app).get('/api/v1/core/purchases/dfe').set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.distribuicao.proximaConsultaEm).toBe(primeira.body.proximaConsultaEm);
    expect(lista.body.distribuicao.motivoDaEspera).toBe('em_dia');

    passarUmaHora();
    const depois = await consultar();
    expect(depois.status, JSON.stringify(depois.body)).toBe(200);
    expect(pedidos()).toEqual([0]);
  });

  it('ultNSU = maxNSU com documentos: também espera — alcançar o maxNSU é estar em dia', async () => {
    expect((await consultar()).status).toBe(200);
    transmitidos = [];

    const denovo = await consultar();

    expect(denovo.status).toBe(409);
    expect(denovo.body.error.code).toBe('CORE_DFE_AGUARDE_A_SEFAZ');
    expect(transmitidos).toEqual([]);
  });
});

describe('656 (consumo indevido): o bloqueio fica gravado e é respeitado', () => {
  it('a SEFAZ bloqueia: o clique diz até quando, e o seguinte nem sai', async () => {
    responder = (ambiente) =>
      retorno({
        ambiente,
        cStat: '656',
        xMotivo: 'Rejeicao: Consumo Indevido (Deve ser utilizado o ultNSU nas solicitacoes subsequentes. Tente apos 1 hora)',
        ult: 0,
        max: 0,
      });
    const antes = Date.now();

    const res = await consultar();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_CONSUMO_INDEVIDO');
    const ate = Date.parse(res.body.error.details.proximaConsultaEm);
    expect(ate).toBeGreaterThanOrEqual(antes + UMA_HORA);
    expect(res.body.error.message).toContain(horaDaLoja(new Date(ate)));
    const c = cursor('homologation')!;
    expect(c.last_c_stat).toBe('656');
    expect(c.wait_reason).toBe('consumo_indevido');
    expect(Date.parse(String(c.next_query_at))).toBe(ate);

    responder = null;
    transmitidos = [];
    const seguinte = await consultar();
    expect(seguinte.status).toBe(409);
    expect(seguinte.body.error.code).toBe('CORE_DFE_AGUARDE_A_SEFAZ');
    expect(seguinte.body.error.message).toMatch(/consumo indevido/i);
    expect(transmitidos).toEqual([]);
  });
});

describe('o cursor guardado nunca recua', () => {
  it('a SEFAZ devolve um ultNSU menor que o guardado: o guardado fica, e a próxima consulta parte dele', async () => {
    expect((await consultar()).status).toBe(200);
    expect(Number(cursor('homologation')!.ult_nsu)).toBe(25);
    passarUmaHora();
    responder = (ambiente) => retorno({ ambiente, cStat: '137', xMotivo: 'Nenhum documento localizado', ult: 5, max: 5 });
    transmitidos = [];

    expect((await consultar()).status).toBe(200);
    expect(pedidos()).toEqual([25]);
    expect(Number(cursor('homologation')!.ult_nsu)).toBe(25);

    passarUmaHora();
    responder = null;
    transmitidos = [];
    expect((await consultar()).status).toBe(200);
    expect(pedidos()).toEqual([25]);
  });

  it('sem cursor guardado (banco que já tinha notas), a consulta parte do MAX(nsu) gravado — nunca de menos', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_dfe_documents (id, company_id, environment, nsu, schema_type, access_key, received_at)
         VALUES ('antigo-7', ?, 'homologation', '7', 'resNFe', ?, ?)`,
      )
      .run(empresa, chave('homologation', 7), new Date().toISOString());

    expect((await consultar()).status).toBe(200);
    expect(pedidos()[0]).toBe(7);
  });

  it('cursor guardado ATRÁS do que está gravado (a gravação andou por fora): parte do maior dos dois', async () => {
    expect((await consultar()).status).toBe(200);
    getConnection()
      .prepare('UPDATE core_dfe_cursors SET ult_nsu = 3 WHERE company_id = ? AND environment = ?')
      .run(empresa, 'homologation');
    passarUmaHora();
    transmitidos = [];

    expect((await consultar()).status).toBe(200);
    expect(pedidos()[0]).toBe(25);
  });
});

describe('por ambiente: homologação e produção têm cursor e espera independentes', () => {
  it('a homologação em espera não segura a produção; e a volta encontra a espera dela', async () => {
    expect((await consultar()).status).toBe(200);
    expect(cursor('homologation')!.next_query_at).toBeTruthy();

    virar('production');
    transmitidos = [];
    const producao = await consultar();
    expect(producao.status, JSON.stringify(producao.body)).toBe(200);
    expect(transmitidos[0].dados).toContain('<tpAmb>1</tpAmb>');
    expect(pedidos()).toEqual([0]);
    expect(producao.body.novos).toBe(4);
    expect(Number(cursor('production')!.ult_nsu)).toBe(4);
    expect(Number(cursor('homologation')!.ult_nsu)).toBe(25);

    virar('homologation');
    transmitidos = [];
    const volta = await consultar();
    expect(volta.status).toBe(409);
    expect(volta.body.error.code).toBe('CORE_DFE_AGUARDE_A_SEFAZ');
    expect(transmitidos).toEqual([]);
  });
});

describe('dois cliques ao mesmo tempo não repetem o ultNSU (verificação do R3-DFE)', () => {
  /*
    Dois gerentes (ou duas abas) clicam "Buscar agora" juntos. Os dois liam o
    mesmo cursor, e os dois mandavam à SEFAZ o MESMO ultNSU — exatamente a
    consulta repetida que o Ambiente Nacional chama de consumo indevido. A
    segunda consulta, com a primeira ainda em andamento, é recusada sem sair.
  */
  it('a segunda consulta, com a primeira em andamento, é recusada sem transmitir — e a primeira termina inteira', async () => {
    const prototipo = SefazRealAdapter.prototype as unknown as {
      enviar: (url: string, servico: string, dados: string) => Promise<string>;
    };
    vi.spyOn(prototipo, 'enviar').mockImplementation(async (_url: string, servico: string, dados: string) => {
      transmitidos.push({ servico, dados });
      await new Promise((r) => setTimeout(r, 40));
      return sefazDoAmbienteNacional(dados);
    });

    const [a, b] = await Promise.all([consultar(), consultar()]);

    const respostas = [a, b];
    const ok = respostas.filter((r) => r.status === 200);
    const recusadas = respostas.filter((r) => r.status === 409);
    expect(ok, JSON.stringify(respostas.map((r) => r.body))).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0].body.error.code).toBe('CORE_DFE_CONSULTA_EM_ANDAMENTO');
    // Nenhum ultNSU foi pedido duas vezes.
    expect(pedidos()).toEqual([0, 10, 20]);
    expect(documentos('homologation')).toBe(25);
  });

  it('terminada a primeira (mesmo com erro), a trava se solta', async () => {
    responder = (ambiente) =>
      retorno({ ambiente, cStat: '593', xMotivo: 'Rejeicao: CNPJ-Base difere', ult: 0, max: 0 });
    expect((await consultar()).status).toBe(409);

    responder = null;
    transmitidos = [];
    const depois = await consultar();
    expect(depois.status, JSON.stringify(depois.body)).toBe(200);
    expect(pedidos()[0]).toBe(0);
  });
});

describe('outra recusa da SEFAZ não anda o cursor', () => {
  it('cStat 593 (CNPJ do certificado diverge): 409 com o cStat, nada gravado, o cursor fica e não há espera', async () => {
    responder = (ambiente) =>
      retorno({ ambiente, cStat: '593', xMotivo: 'Rejeicao: CNPJ-Base consultado difere do CNPJ-Base do Certificado Digital', ult: 0, max: 0 });

    const res = await consultar();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_SEFAZ_RECUSOU');
    expect(res.body.error.message).toMatch(/593/);
    expect(documentos('homologation')).toBe(0);
    const c = cursor('homologation');
    expect(c?.next_query_at ?? null).toBeNull();
    expect(Number(c?.ult_nsu ?? 0)).toBe(0);

    responder = null;
    transmitidos = [];
    expect((await consultar()).status).toBe(200);
    expect(pedidos()[0]).toBe(0);
  });
});
