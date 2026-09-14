/**
 * ============================================================================
 * A INUTILIZAÇÃO TAMBÉM PRECISA DE PROVA — o resíduo do GAP-V32
 * ============================================================================
 *
 * ## O que a rodada do V32 consertou, e o que ela deixou de fora
 *
 * O cancelamento e a carta de correção passaram a guardar o `procEventoNFe`
 * íntegro: o evento ASSINADO costurado com o retorno da SEFAZ, em `xml_proc`.
 * O contador valida o arquivo sem precisar do portal.
 *
 * A INUTILIZAÇÃO ficou de fora, e o buraco é do mesmo tamanho. `voidNumberRange`
 * do adapter real MONTA e ASSINA um `inutNFe` — e joga o XML assinado fora
 * assim que o envia: o retorno é o único que sobra, e ele passa por
 * `sanitizeResponse` antes de ir para o banco (assinatura e certificado viram
 * "[removido]"). Numa fiscalização sobre o buraco na numeração, o que a empresa
 * tem para mostrar é um retorno mutilado.
 *
 * Inutilização é exatamente o documento em que a prova mais importa: ela existe
 * PARA justificar números que nunca viraram nota. Sem o `procInutNFe`, a
 * justificativa depende de o fisco consultar o próprio sistema.
 *
 * ## Por que a assinatura pode ser guardada
 *
 * É a mesma razão do evento: a assinatura de um documento TRANSMITIDO é prova
 * PÚBLICA, não credencial. O que `sanitizeResponse` protege é segredo (chave,
 * certificado), e ela continua intocada — o LOG segue sanitizado. O que muda é
 * o ARQUIVAMENTO, que ganha uma coluna própria, como o evento ganhou.
 *
 * ## COMO ELE FALHA (medido, quebrando de propósito)
 *
 *   - trocando `xmlProc: aceito ? procDaInutilizacao(response) : null` por
 *     `null` em `requestVoidRange`, o caso do arquivamento fica vermelho com
 *     `xml_proc` nulo;
 *   - trocando `aceito ?` por `true`, o caso da RECUSA fica vermelho: a prova
 *     de um ato que a SEFAZ negou passaria a ser arquivada;
 *   - apagando a conferência de `<Signature` em `montarProcInutNfe`, dois casos
 *     ficam vermelhos de uma vez — a costura sem assinatura e o provider de
 *     teste, que passaria a fabricar prova.
 *
 * O que ESTE arquivo não alcança é o `SefazRealAdapter`: ele fala SOAP com o
 * fisco e nenhum teste sem rede o exercita. A metade dele — devolver o
 * `inutNFe` assinado em vez de descartá-lo — é a mesma linha que a rodada do
 * evento já provou funcionar em `enviarEvento`, e a cobrança real é a
 * homologação com o certificado do dono.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { parseSefazResponse, type SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { requestVoidRange } from '../src/services/core/FiscalEventsService.js';
import { montarProcInutNfe } from '../src/services/core/FiscalProcNfe.js';

const ASSINATURA = 'QXNzaW5hdHVyYVJlYWxEYUludXRpbGl6YWNhbw==';
const JUST = 'Falha de impressao na bobina do caixa 2';

let companyId: string;

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  updateFiscalConfig({
    companyId,
    patch: { cnpj: '11.222.333/0001-81', uf: 'RS', legalName: 'Preço Justo Ltda' },
  });
});

/** O retorno da SEFAZ para a inutilização aceita — com assinatura embutida. */
function retornoAceito(): string {
  return (
    '<retInutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + '<infInut Id="ID43260011222333000181650010000000010000000010">'
    + '<tpAmb>2</tpAmb><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
    + '<nProt>143260000000202</nProt>'
    + `<Signature><SignatureValue>${ASSINATURA}</SignatureValue></Signature>`
    + '</infInut></retInutNFe>'
  );
}

/** O inutNFe assinado, como o adapter real o transmite. */
function inutAssinado(): string {
  return (
    '<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + '<infInut Id="ID43260011222333000181650010000000010000000010">'
    + '<tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><mod>65</mod><serie>1</serie>'
    + '<nNFIni>1</nNFIni><nNFFin>1</nNFFin>'
    + `<xJust>${JUST}</xJust></infInut>`
    + `<Signature><SignatureValue>${ASSINATURA}</SignatureValue></Signature>`
    + '</inutNFe>'
  );
}

/**
 * O adapter como o REAL passa a se comportar: devolve o retorno da SEFAZ E o
 * inutNFe assinado que transmitiu. Sem a segunda metade não há arquivamento.
 */
class AdapterComInutAssinado extends SefazTestAdapter {
  async voidNumberRange(): Promise<SefazResponse> {
    return {
      ...parseSefazResponse({ body: retornoAceito(), correlationId: 'inut' }),
      xmlInutAssinado: inutAssinado(),
    };
  }
}

/**
 * O adapter que RECUSA — e o caso escolhido é o que mais dói.
 *
 * A rejeição 563 ("já existe pedido de inutilização com a mesma faixa") vem
 * ECOANDO o protocolo do pedido anterior. Ela tem, portanto, as duas metades
 * que a costura exige: o inutNFe assinado que acabamos de transmitir e um
 * retInutNFe com `nProt`. Só o cStat a separa de uma inutilização homologada.
 *
 * É por isso que este caso está aqui: sem a peneira do `aceito`, o pacote do
 * contador receberia um procInutNFe montado, válido na aparência, arquivando a
 * prova de um ato que a SEFAZ NEGOU.
 */
class AdapterQueRecusa extends SefazTestAdapter {
  async voidNumberRange(): Promise<SefazResponse> {
    const corpo =
      '<retInutNFe versao="4.00"><infInut><cStat>563</cStat>'
      + '<xMotivo>Ja existe pedido de inutilizacao com a mesma faixa</xMotivo>'
      + '<nProt>143260000000111</nProt>'
      + '</infInut></retInutNFe>';
    return {
      ...parseSefazResponse({ body: corpo, correlationId: 'inut' }),
      xmlInutAssinado: inutAssinado(),
    };
  }
}

function linhaDoEvento(eventId: string): { xml: string; xml_proc: string | null } {
  return getConnection()
    .prepare('SELECT xml, xml_proc FROM core_fiscal_events WHERE id = ?')
    .get(eventId) as { xml: string; xml_proc: string | null };
}

describe('a costura do procInutNFe', () => {
  it('junta o inutNFe assinado com o retInutNFe da SEFAZ', () => {
    const proc = montarProcInutNfe({
      inutAssinado: inutAssinado(),
      retorno: retornoAceito(),
    });
    expect(proc).toContain('<procInutNFe');
    expect(proc).toContain('<inutNFe');
    expect(proc).toContain('<retInutNFe');
    expect(proc).toContain(ASSINATURA);
    expect(proc).not.toContain('[removido]');
  });

  it('sem assinatura no inutNFe, NÃO monta — ensaio não vira prova', () => {
    expect(
      montarProcInutNfe({
        inutAssinado: '<inutNFe><infInut></infInut></inutNFe>',
        retorno: retornoAceito(),
      }),
    ).toBeNull();
  });

  it('sem protocolo no retorno, NÃO monta — recusa não é homologação', () => {
    const recusa =
      '<retInutNFe versao="4.00"><infInut><cStat>563</cStat></infInut></retInutNFe>';
    expect(montarProcInutNfe({ inutAssinado: inutAssinado(), retorno: recusa })).toBeNull();
  });

  it('faltando qualquer uma das metades, NÃO monta', () => {
    expect(montarProcInutNfe({ inutAssinado: null, retorno: retornoAceito() })).toBeNull();
    expect(montarProcInutNfe({ inutAssinado: inutAssinado(), retorno: null })).toBeNull();
  });
});

describe('a inutilização aceita guarda o arquivamento', () => {
  it('grava o procInutNFe íntegro, e o LOG continua sanitizado', async () => {
    const r = await requestVoidRange({
      companyId,
      model: '65',
      serie: 1,
      from: 1,
      to: 1,
      justification: JUST,
      adapter: new AdapterComInutAssinado(),
    });
    expect(r.accepted).toBe(true);

    const linha = linhaDoEvento(r.eventId);
    expect(linha.xml_proc).toContain('<procInutNFe');
    expect(linha.xml_proc).toContain('<inutNFe');
    expect(linha.xml_proc).toContain('<retInutNFe');
    expect(linha.xml_proc).toContain(ASSINATURA);

    /*
      A SANITIZAÇÃO NÃO FOI AFROUXADA — é o ponto de todo o desenho. O log
      continua com a assinatura apagada; quem ganhou a versão íntegra foi o
      arquivo de ARQUIVAMENTO, que é outra coluna e outro propósito.
    */
    expect(linha.xml).toContain('[removido]');
    expect(linha.xml).not.toContain(ASSINATURA);
  });

  it('a inutilização RECUSADA não guarda prova nenhuma', async () => {
    const r = await requestVoidRange({
      companyId,
      model: '65',
      serie: 2,
      from: 5,
      to: 6,
      justification: JUST,
      adapter: new AdapterQueRecusa(),
    });
    expect(r.accepted).toBe(false);
    // Recusa com inutNFe assinado em mãos continua sendo recusa: guardar um
    // "procInutNFe" aqui seria arquivar a prova de um ato que não aconteceu.
    expect(linhaDoEvento(r.eventId).xml_proc).toBeNull();
  });

  it('o provider de TESTE não fabrica prova: xml_proc fica nulo', async () => {
    const r = await requestVoidRange({
      companyId,
      model: '65',
      serie: 3,
      from: 9,
      to: 9,
      justification: JUST,
      adapter: new SefazTestAdapter(),
    });
    // O simulador aceita, e é para aceitar — o que ele não faz é assinar. Sem
    // assinatura não há procInutNFe, e o pacote do contador não recebe um
    // arquivo que abre e não prova nada.
    expect(linhaDoEvento(r.eventId).xml_proc).toBeNull();
  });
});
