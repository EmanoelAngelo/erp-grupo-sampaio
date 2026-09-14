/**
 * OS EVENTOS DO ADAPTER REAL — GAP-PRD-019.
 *
 * O adapter real montava cancelamento, carta de correção e inutilização com
 * quatro defeitos que só a SEFAZ acusaria — com o prazo do cancelamento
 * correndo:
 *
 *  1. HOST ERRADO PARA NFC-e. `cancel` e `correctionLetter` resolviam o
 *     endpoint com o modelo '55' cravado: o cancelamento de uma NFC-e (65) ia
 *     para `nfe-homologacao.sefazrs`, e a SVRS atende NFC-e em
 *     `nfce-homologacao.sefazrs` — o mesmo mapa que a autorização e a
 *     inutilização já usavam.
 *  2. `dhEvento` FORA DO LEIAUTE. `new Date().toISOString()` sai com
 *     milissegundos e `Z`; o tipo TDateTimeUTC do leiaute exige
 *     AAAA-MM-DDThh:mm:ss±hh:00 — cStat 225 em todo evento.
 *  3. CNPJ DO CERTIFICADO NO LUGAR DO EMITENTE. O A1 da matriz assina pela
 *     filial (a SEFAZ compara a RAIZ); o autor do evento, porém, é o emitente
 *     da nota — o CNPJ que está na chave. Com o do certificado, a filial
 *     colheria "autor do evento diverge do emissor".
 *  4. O ANO DA INUTILIZAÇÃO VINHA DO RELÓGIO. O `year` da rota era descartado:
 *     inutilizar em janeiro uma faixa do ano anterior saía com o ano errado.
 *
 * O transporte é dublado (nenhum byte sai daqui); a assinatura é a de verdade,
 * com um certificado gerado no teste, e o inutNFe assinado passa pelo XSD
 * oficial embutido (inutNFe_v4.00).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import type { SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { requestCancel, requestVoidRange } from '../src/services/core/FiscalEventsService.js';
import { validarXmlContraXsd } from '../src/services/core/FiscalXsdValidator.js';
import { verifyXmlElementSignature } from '../src/services/core/FiscalSigner.js';
import type { ParsedCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';
/** NFC-e (65) e NF-e (55) da MATRIZ — o modelo mora nas posições 21-22 da chave. */
const CHAVE_NFCE = `432609${CNPJ_MATRIZ}650010000000071000000070`;
const CHAVE_NFE = `432609${CNPJ_MATRIZ}550010000000081000000080`;
/** NF-e da FILIAL, assinada com o A1 da matriz (mesma raiz). */
const CHAVE_NFE_FILIAL = `432609${CNPJ_FILIAL}550010000000091000000090`;
/** NF-e de OUTRA empresa: raiz diferente da do certificado. */
const CHAVE_OUTRA_RAIZ = `43260999888777000166550010000000101000000100`;

/**
 * O TDateTimeUTC do leiaute, lido do XSD oficial embutido — o teste não
 * reescreve o padrão à mão, então não há como os dois divergirem.
 */
const TDATETIMEUTC = (() => {
  const xsd = readFileSync(
    fileURLToPath(new URL('../fiscal-schemas/PL_010b_V1.30/tiposBasico_v4.00.xsd', import.meta.url)),
    'utf8',
  );
  const bloco = xsd.slice(xsd.indexOf('<xs:simpleType name="TDateTimeUTC">'));
  const padrao = /<xs:pattern value="([^"]+)"/.exec(bloco)![1];
  // Padrão de XSD é ancorado por definição.
  return new RegExp(`^(?:${padrao})$`);
})();

function gerarCertificado(cn: string, cnpj: string): ParsedCertificateA1 {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 365);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    subject: cn,
    issuer: cn,
    cnpj,
    serialNumber: '01',
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  } as ParsedCertificateA1;
}

let certMatriz: ParsedCertificateA1;
beforeAll(() => {
  certMatriz = gerarCertificado(`MATRIZ LTDA:${CNPJ_MATRIZ}`, CNPJ_MATRIZ);
});

function retornoEvento(chave: string, tpEvento: string): string {
  return (
    '<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote>'
    + '<tpAmb>2</tpAmb><cOrgao>43</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
    + '<retEvento versao="1.00"><infEvento Id="ID143260000000500">'
    + `<tpAmb>2</tpAmb><cOrgao>43</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>`
    + `<chNFe>${chave}</chNFe><tpEvento>${tpEvento}</tpEvento><nSeqEvento>1</nSeqEvento>`
    + '<dhRegEvento>2026-09-11T10:15:40-03:00</dhRegEvento><nProt>143260000000500</nProt>'
    + '</infEvento></retEvento></retEnvEvento>'
  );
}

/** Transporte dublado: guarda URL e corpo, e devolve o retorno de roteiro. */
function adapterComTransporte(cert: ParsedCertificateA1, corpo: (url: string) => string) {
  const chamadas: { url: string; body: string }[] = [];
  const adapter = new SefazRealAdapter({
    cert,
    postSoap: async ({ url, body }) => {
      chamadas.push({ url, body });
      return { status: 200, body: corpo(url) };
    },
  });
  return { adapter, chamadas };
}

function tag(xml: string, nome: string): string | null {
  return new RegExp(`<${nome}(?:\\s[^>]*)?>([^<]*)</${nome}>`).exec(xml)?.[1] ?? null;
}

/** O envEvento assinado que viajou, sem o envelope SOAP. */
function eventoEnviado(body: string): string {
  return body.slice(body.indexOf('<envEvento'), body.indexOf('</envEvento>') + '</envEvento>'.length);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('o host do evento segue o modelo da nota', () => {
  it('cancelamento de NFC-e (65) vai ao host da NFC-e; de NF-e (55), ao da NF-e', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFCE, '110111'));

    await adapter.cancel({
      companyId: 'c1',
      accessKey: CHAVE_NFCE,
      protocol: '143260000000071',
      justification: 'venda digitada em duplicidade no caixa',
      uf: 'RS',
      environment: 'homologation',
    });
    await adapter.cancel({
      companyId: 'c1',
      accessKey: CHAVE_NFE,
      protocol: '143260000000081',
      justification: 'venda digitada em duplicidade no caixa',
      uf: 'RS',
      environment: 'homologation',
    });

    expect(chamadas[0].url).toContain('https://nfce-homologacao.sefazrs.rs.gov.br/');
    expect(chamadas[0].url).toContain('RecepcaoEvento');
    expect(chamadas[1].url).toContain('https://nfe-homologacao.sefazrs.rs.gov.br/');
  });

  it('em produção, a NFC-e vai ao host de produção da NFC-e', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFCE, '110111'));
    await adapter.cancel({
      companyId: 'c1',
      accessKey: CHAVE_NFCE,
      protocol: '143260000000071',
      justification: 'venda digitada em duplicidade no caixa',
      uf: 'RS',
      environment: 'production',
    });
    expect(chamadas[0].url).toContain('https://nfce.sefazrs.rs.gov.br/');
    expect(tag(chamadas[0].body, 'tpAmb')).toBe('1');
  });

  it('modelo informado que desmente a chave é recusado sem transmitir', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFCE, '110111'));
    await expect(
      adapter.cancel({
        companyId: 'c1',
        accessKey: CHAVE_NFCE,
        model: '55',
        protocol: '143260000000071',
        justification: 'venda digitada em duplicidade no caixa',
        uf: 'RS',
        environment: 'homologation',
      }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_MODEL_MISMATCH' });
    expect(chamadas).toHaveLength(0);
  });

  it('carta de correção de NFC-e é recusada antes da rede — NFC-e não tem CC-e', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFCE, '110110'));
    await expect(
      adapter.correctionLetter({
        companyId: 'c1',
        accessKey: CHAVE_NFCE,
        sequence: 1,
        text: 'Corrigir o complemento do endereco',
        uf: 'RS',
        environment: 'homologation',
      }),
    ).rejects.toMatchObject({ code: 'CORE_FISCAL_CCE_WRONG_MODEL' });
    expect(chamadas).toHaveLength(0);
  });
});

describe('dhEvento no formato do leiaute (TDateTimeUTC), no relógio do emitente', () => {
  it('sem milissegundos, sem Z, com o deslocamento da UF — e cumpre o padrão do XSD', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T13:15:32.123Z'));

    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFE, '110111'));
    await adapter.cancel({
      companyId: 'c1',
      accessKey: CHAVE_NFE,
      protocol: '143260000000081',
      justification: 'venda digitada em duplicidade no caixa',
      uf: 'RS',
      environment: 'homologation',
    });

    const dh = tag(chamadas[0].body, 'dhEvento')!;
    expect(dh).toBe('2026-09-11T10:15:32-03:00');
    expect(dh).toMatch(TDATETIMEUTC);
    // A forma antiga — o que o toISOString() produzia — o padrão recusa.
    expect('2026-09-11T13:15:32.123Z').not.toMatch(TDATETIMEUTC);
  });

  it('a carta de correção também sai no formato do leiaute', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoEvento(CHAVE_NFE, '110110'));
    await adapter.correctionLetter({
      companyId: 'c1',
      accessKey: CHAVE_NFE,
      sequence: 2,
      text: 'Corrigir o complemento do endereco',
      uf: 'RS',
      environment: 'homologation',
    });
    expect(tag(chamadas[0].body, 'dhEvento')).toMatch(TDATETIMEUTC);
    expect(tag(chamadas[0].body, 'nSeqEvento')).toBe('2');
  });
});

describe('o autor do evento é o EMITENTE da nota', () => {
  it('A1 da matriz cancelando nota da filial: <CNPJ> é o da filial (o da chave), e a assinatura confere', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () =>
      retornoEvento(CHAVE_NFE_FILIAL, '110111'),
    );
    const r = await adapter.cancel({
      companyId: 'c1',
      accessKey: CHAVE_NFE_FILIAL,
      protocol: '143260000000091',
      justification: 'venda digitada em duplicidade no caixa',
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.cStat).toBe('135');

    const evento = eventoEnviado(chamadas[0].body);
    expect(tag(evento, 'CNPJ')).toBe(CNPJ_FILIAL);
    expect(evento).not.toContain(`<CNPJ>${CNPJ_MATRIZ}</CNPJ>`);
    expect(verifyXmlElementSignature(evento, 'infEvento').valid).toBe(true);
  });

  it('certificado de outra RAIZ é recusado antes de transmitir (a SEFAZ responderia 213)', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () =>
      retornoEvento(CHAVE_OUTRA_RAIZ, '110111'),
    );
    await expect(
      adapter.cancel({
        companyId: 'c1',
        accessKey: CHAVE_OUTRA_RAIZ,
        protocol: '143260000000101',
        justification: 'venda digitada em duplicidade no caixa',
        uf: 'RS',
        environment: 'homologation',
      }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_CERTIFICATE_CNPJ_ROOT_MISMATCH' });
    expect(chamadas).toHaveLength(0);
  });
});

describe('inutilização: ano do pedido, CNPJ do emitente, host do modelo, XSD oficial', () => {
  function retornoInut(): string {
    return (
      '<retInutNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><infInut Id="ID143260000000777">'
      + '<tpAmb>2</tpAmb><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
      + '<nProt>143260000000777</nProt></infInut></retInutNFe>'
    );
  }

  it('o ano vem do pedido (2025 em janeiro de 2026) e o Id/CNPJ são do emitente, não do certificado', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-05T12:00:00.000Z'));

    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoInut());
    const r = await adapter.voidNumberRange({
      companyId: 'c1',
      model: '65',
      serie: 1,
      from: 120,
      to: 125,
      year: 2025,
      cnpj: CNPJ_FILIAL,
      justification: 'queda de energia no meio da emissao',
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.cStat).toBe('102');

    const corpo = chamadas[0].body;
    expect(chamadas[0].url).toContain('https://nfce-homologacao.sefazrs.rs.gov.br/');
    expect(tag(corpo, 'ano')).toBe('25');
    expect(tag(corpo, 'CNPJ')).toBe(CNPJ_FILIAL);
    expect(corpo).toContain(`Id="ID4325${CNPJ_FILIAL}65001000000120000000125"`);
  });

  it('o inutNFe assinado cumpre o XSD oficial (inutNFe_v4.00) e a assinatura confere', async () => {
    const { adapter } = adapterComTransporte(certMatriz, () => retornoInut());
    const r = await adapter.voidNumberRange({
      companyId: 'c1',
      model: '55',
      serie: 1,
      from: 10,
      to: 12,
      year: 2026,
      cnpj: CNPJ_MATRIZ,
      justification: 'Falha no sistema durante a emissão',
      uf: 'RS',
      environment: 'homologation',
    });
    const inut = r.xmlInutAssinado!;
    const xsd = validarXmlContraXsd(inut, 'inutNFe');
    expect(xsd.validated).toBe(true);
    expect(xsd.problems).toEqual([]);
    expect(verifyXmlElementSignature(inut, 'infInut').valid).toBe(true);
  });

  it('sem o CNPJ do emitente a inutilização não é montada — não cai no do certificado', async () => {
    const { adapter, chamadas } = adapterComTransporte(certMatriz, () => retornoInut());
    await expect(
      adapter.voidNumberRange({
        companyId: 'c1',
        model: '55',
        serie: 1,
        from: 10,
        to: 12,
        year: 2026,
        justification: 'Falha no sistema durante a emissao',
        uf: 'RS',
        environment: 'homologation',
      }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_EMITTER_CNPJ_REQUIRED' });
    expect(chamadas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// O serviço entrega ao adapter o que ele precisa: modelo, ambiente DA NOTA,
// ano do pedido e CNPJ do emitente.
// ---------------------------------------------------------------------------

type Recebido = Record<string, unknown>;

/** Espião que se comporta como o simulador, mas grava o que recebeu. */
class AdapterEspiao extends SefazTestAdapter {
  readonly cancelamentos: Recebido[] = [];
  readonly inutilizacoes: Recebido[] = [];

  override async cancel(input: { accessKey: string; protocol: string; justification: string }): Promise<SefazResponse> {
    this.cancelamentos.push(input as unknown as Recebido);
    return super.cancel(input);
  }

  override async voidNumberRange(input: { model: string; serie: number; from: number; to: number }): Promise<SefazResponse> {
    this.inutilizacoes.push(input as unknown as Recebido);
    return super.voidNumberRange(input);
  }
}

let companyId: string;

function nfceAutorizadaNoBanco(protocolo: string, ambiente: 'homologation' | 'production'): string {
  ensureCoreSchema();
  const id = `doc-${protocolo}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, sale_id, model, serie, number, access_key, environment, status,
          protocol, c_stat, x_motivo, issued_at, authorized_at, created_at, updated_at)
       VALUES (?, ?, NULL, '65', 1, 7, ?, ?, 'AUTHORIZED', ?, '100', 'Autorizado', ?, ?, ?, ?)`,
    )
    .run(id, companyId, CHAVE_NFCE, ambiente, protocolo, agora, agora, agora, agora);
  return id;
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'matriz', legalName: 'Matriz Ltda', tradeName: 'Matriz' });
  updateFiscalConfig({ companyId, patch: { cnpj: '11.222.333/0001-81', uf: 'RS', legalName: 'Matriz Ltda' } });
});

describe('o serviço passa ao adapter o que a nota diz', () => {
  it('cancelamento leva o MODELO da nota e o AMBIENTE em que ela foi autorizada', async () => {
    const id = nfceAutorizadaNoBanco('TEST-abc123', 'homologation');
    const espiao = new AdapterEspiao();
    const r = await requestCancel({
      companyId,
      documentId: id,
      justification: 'venda digitada em duplicidade no caixa',
      adapter: espiao,
    });
    expect(r.accepted).toBe(true);
    expect(espiao.cancelamentos[0]).toMatchObject({ model: '65', environment: 'homologation', uf: 'RS' });
  });

  it('inutilização leva o ANO do pedido e o CNPJ do emitente configurado', async () => {
    const espiao = new AdapterEspiao();
    await requestVoidRange({
      companyId,
      model: '65',
      serie: 1,
      year: 2025,
      from: 40,
      to: 41,
      justification: 'queda de energia no meio da emissao',
      adapter: espiao,
    });
    expect(espiao.inutilizacoes[0]).toMatchObject({ year: 2025, cnpj: CNPJ_MATRIZ, model: '65' });
  });

  it('ano no futuro ou anterior a 2006 é recusado antes de reservar a faixa', async () => {
    const espiao = new AdapterEspiao();
    const proximo = new Date().getUTCFullYear() + 1;
    for (const year of [proximo, 2005, Number.NaN]) {
      await expect(
        requestVoidRange({
          companyId,
          model: '55',
          serie: 1,
          year,
          from: 50,
          to: 51,
          justification: 'queda de energia no meio da emissao',
          adapter: espiao,
        }),
      ).rejects.toMatchObject({ code: 'CORE_FISCAL_VOID_YEAR_INVALID' });
    }
    expect(espiao.inutilizacoes).toHaveLength(0);
  });

  it('modelo fora de 55/65 é recusado antes de reservar a faixa', async () => {
    const espiao = new AdapterEspiao();
    await expect(
      requestVoidRange({
        companyId,
        model: '',
        serie: 1,
        year: 2026,
        from: 60,
        to: 61,
        justification: 'queda de energia no meio da emissao',
        adapter: espiao,
      }),
    ).rejects.toMatchObject({ code: 'CORE_FISCAL_VOID_MODEL_INVALID' });
    expect(espiao.inutilizacoes).toHaveLength(0);
  });
});

