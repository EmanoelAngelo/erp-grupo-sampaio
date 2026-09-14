/**
 * Provider de TESTE. Não é a SEFAZ e nunca poderá ser confundido com ela.
 *
 * Existe para que a fila, o retry, o recovery e a consulta pós-timeout possam
 * ser exercitados sem certificado real — que é o único jeito de saber que
 * funcionam ANTES de ter as credenciais. Um caminho de transmissão testado
 * pela primeira vez em produção é um caminho não testado.
 *
 * TRÊS COISAS TORNAM A CONFUSÃO IMPOSSÍVEL
 *
 * 1. `isReal = false`, e `selectAdapter` recusa este provider em produção.
 * 2. O protocolo devolvido começa com `TEST-`. Um protocolo real é numérico,
 *    então nenhum documento autorizado por aqui passa por autorizado de
 *    verdade em nenhuma tela ou relatório.
 * 3. `source: 'test'` no status do serviço — o readiness mostra
 *    `TEST_PROVIDER`, nunca "SEFAZ ONLINE".
 *
 * O comportamento é DETERMINÍSTICO: o cenário é escolhido por quem chama, não
 * sorteado. Teste que às vezes passa não prova nada.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuthorizeRequest,
  ConsultRequest,
  SefazAdapter,
  SefazResponse,
  ServiceStatus,
} from './SefazAdapter.js';
import { parseSefazResponse } from './SefazAdapter.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';

export type TestScenario =
  | 'AUTHORIZED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'ALREADY_PROCESSED'
  | 'CONSULT_AUTHORIZED'
  | 'CONSULT_NOT_FOUND';

/**
 * Cenários dos EVENTOS fiscais.
 *
 * Separados do cenário de autorização de propósito: o teste precisa poder
 * autorizar a nota e recusar o cancelamento dela — que é justamente o caso em
 * que o sistema não pode marcar o documento como cancelado.
 */
export type TestEventScenario = 'EVENT_AUTHORIZED' | 'EVENT_REJECTED';

/** Marca inconfundível: protocolo real da SEFAZ é numérico. */
export const TEST_PROTOCOL_PREFIX = 'TEST-';

export function isTestProtocol(protocol: string | null | undefined): boolean {
  return Boolean(protocol && protocol.startsWith(TEST_PROTOCOL_PREFIX));
}

/**
 * As chaves que o simulador INVENTA na Distribuição DF-e (NSU 1 e 2).
 *
 * O DV (último dígito) é '7' de propósito e não é o módulo 11 do corpo: nenhuma
 * NF-e real tem uma destas chaves. É por elas que o serviço reconhece, no banco,
 * o ensaio que o simulador deixou — e o tira do caminho da SEFAZ de verdade
 * (GAP-PRD-168).
 */
export function chaveDfeDoSimulador(i: number): string {
  const corpo = `43260814200166000187550010${String(i).padStart(9, '0')}`;
  return corpo.padEnd(44, '7').slice(0, 44);
}

export const CHAVES_DFE_DO_SIMULADOR: readonly string[] = [1, 2].map(chaveDfeDoSimulador);

function envelope(input: {
  cStat: string;
  xMotivo: string;
  accessKey: string;
  protocol?: string | null;
}): string {
  const prot = input.protocol
    ? `<nProt>${input.protocol}</nProt>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <tpAmb>2</tpAmb>
  <protNFe>
    <infProt>
      <chNFe>${input.accessKey}</chNFe>
      <cStat>${input.cStat}</cStat>
      <xMotivo>${input.xMotivo}</xMotivo>
      ${prot}
    </infProt>
  </protNFe>
</retEnviNFe>`;
}

/** Erro de transporte — o que a rede produz, não o que o fisco responde. */
export class TransportFailure extends Error {
  readonly kind: 'TIMEOUT' | 'NETWORK_ERROR';

  constructor(kind: 'TIMEOUT' | 'NETWORK_ERROR', message: string) {
    super(message);
    this.name = 'TransportFailure';
    this.kind = kind;
  }
}

export class SefazTestAdapter implements SefazAdapter {
  readonly name = 'sefaz-test-provider';

  readonly isReal = false;

  /** Cenário aplicado à próxima chamada de `authorize`. */
  private scenario: TestScenario = 'AUTHORIZED';

  /** Cenário aplicado a `consult`, quando difere do de autorização. */
  private consultScenario: TestScenario | null = null;

  /** Cenário dos eventos (cancelamento, CC-e, inutilização). */
  private eventScenario: TestEventScenario = 'EVENT_AUTHORIZED';

  setEventScenario(scenario: TestEventScenario): void {
    this.eventScenario = scenario;
  }

  /**
   * Chaves que o "fisco de mentira" considera já processadas.
   *
   * É o que permite reproduzir o caso mais delicado: a SEFAZ recebeu e
   * autorizou, mas a resposta não chegou. Na consulta seguinte, a chave já
   * está lá.
   */
  private readonly processed = new Map<string, { cStat: string; protocol: string }>();

  setScenario(scenario: TestScenario): void {
    this.scenario = scenario;
  }

  setConsultScenario(scenario: TestScenario | null): void {
    this.consultScenario = scenario;
  }

  /** Marca uma chave como já autorizada do lado do fisco simulado. */
  markProcessed(accessKey: string, cStat = '100'): void {
    this.processed.set(accessKey, {
      cStat,
      protocol: `${TEST_PROTOCOL_PREFIX}${randomUUID().slice(0, 12)}`,
    });
  }

  async statusServico(input: {
    uf: string;
    environment: FiscalEnvironment;
    model?: string;
  }): Promise<ServiceStatus> {
    void input;
    if (this.scenario === 'SERVICE_UNAVAILABLE') {
      return {
        online: false,
        cStat: '108',
        xMotivo: 'Servico Paralisado Momentaneamente (provider de teste)',
        source: 'test',
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      online: true,
      cStat: '107',
      xMotivo: 'Servico em Operacao (provider de teste)',
      // Nunca 'sefaz': o readiness precisa poder dizer TEST_PROVIDER.
      source: 'test',
      checkedAt: new Date().toISOString(),
    };
  }

  async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    const correlationId = randomUUID();

    switch (this.scenario) {
      case 'TIMEOUT':
        // A SEFAZ RECEBEU e processou; a resposta é que não voltou. Por isso a
        // chave fica marcada como processada — é o que a consulta vai achar.
        this.markProcessed(input.accessKey);
        throw new TransportFailure('TIMEOUT', 'Tempo esgotado aguardando a SEFAZ.');

      case 'NETWORK_ERROR':
        throw new TransportFailure('NETWORK_ERROR', 'Falha de rede ao contatar a SEFAZ.');

      case 'SERVICE_UNAVAILABLE':
        return parseSefazResponse({
          body: envelope({
            cStat: '108',
            xMotivo: 'Servico Paralisado Momentaneamente',
            accessKey: input.accessKey,
          }),
          correlationId,
        });

      case 'REJECTED':
        return parseSefazResponse({
          body: envelope({
            cStat: '539',
            xMotivo: 'Rejeicao: Duplicidade de NF-e com diferenca na chave de acesso',
            accessKey: input.accessKey,
          }),
          correlationId,
        });

      case 'ALREADY_PROCESSED':
        this.markProcessed(input.accessKey);
        return parseSefazResponse({
          body: envelope({
            cStat: '204',
            xMotivo: 'Rejeicao: Duplicidade de NF-e',
            accessKey: input.accessKey,
          }),
          correlationId,
        });

      case 'AUTHORIZED':
      default: {
        this.markProcessed(input.accessKey);
        const registro = this.processed.get(input.accessKey)!;
        return parseSefazResponse({
          body: envelope({
            cStat: '100',
            xMotivo: 'Autorizado o uso da NF-e (PROVIDER DE TESTE)',
            accessKey: input.accessKey,
            protocol: registro.protocol,
          }),
          correlationId,
        });
      }
    }
  }

  async consult(input: ConsultRequest): Promise<SefazResponse> {
    const correlationId = randomUUID();
    const cenario = this.consultScenario ?? 'CONSULT_AUTHORIZED';

    // A rede que caiu na autorização também derruba a consulta — é o que
    // CONFIRMA a indisponibilidade (GAP-PRD-098). "Não conheço a chave" é a
    // SEFAZ no ar.
    if (cenario === 'NETWORK_ERROR' || cenario === 'TIMEOUT') {
      throw new TransportFailure(cenario, 'Falha de rede ao consultar a SEFAZ.');
    }

    if (cenario === 'CONSULT_NOT_FOUND' || !this.processed.has(input.accessKey)) {
      return parseSefazResponse({
        body: envelope({
          cStat: '217',
          xMotivo: 'Rejeicao: NF-e nao consta na base de dados da SEFAZ',
          accessKey: input.accessKey,
        }),
        correlationId,
      });
    }

    const registro = this.processed.get(input.accessKey)!;
    return parseSefazResponse({
      body: envelope({
        cStat: registro.cStat,
        xMotivo: 'Autorizado o uso da NF-e (PROVIDER DE TESTE)',
        accessKey: input.accessKey,
        protocol: registro.protocol,
      }),
      correlationId,
    });
  }

  async cancel(input: {
    accessKey: string;
    protocol: string;
    justification: string;
  }): Promise<SefazResponse> {
    void input.justification;
    return this.eventoSimulado(input.accessKey, {
      okStat: '135',
      okMotivo: 'Evento registrado e vinculado a NF-e (PROVIDER DE TESTE)',
      failStat: '573',
      failMotivo: 'Rejeicao: Duplicidade de evento (PROVIDER DE TESTE)',
    });
  }

  /**
   * Resposta de evento, conforme o cenário escolhido.
   *
   * A recusa devolve `cStat` de rejeição e NENHUM protocolo — é exatamente o
   * que impede o chamador de marcar o documento como cancelado: sem protocolo
   * não houve evento aceito.
   */
  private async eventoSimulado(
    accessKey: string,
    codigos: { okStat: string; okMotivo: string; failStat: string; failMotivo: string },
  ): Promise<SefazResponse> {
    const rejeitar = this.eventScenario === 'EVENT_REJECTED';
    return parseSefazResponse({
      body: envelope({
        cStat: rejeitar ? codigos.failStat : codigos.okStat,
        xMotivo: rejeitar ? codigos.failMotivo : codigos.okMotivo,
        accessKey,
        protocol: rejeitar ? null : `${TEST_PROTOCOL_PREFIX}${randomUUID().slice(0, 12)}`,
      }),
      correlationId: randomUUID(),
    });
  }

  async voidNumberRange(input: {
    model: string;
    serie: number;
    from: number;
    to: number;
  }): Promise<SefazResponse> {
    void input;
    return this.eventoSimulado('', {
      okStat: '102',
      okMotivo: 'Inutilizacao de numero homologado (PROVIDER DE TESTE)',
      failStat: '241',
      failMotivo: 'Rejeicao: Um numero da faixa ja foi utilizado (PROVIDER DE TESTE)',
    });
  }

  // -------------------------------------------- Distribuição DF-e (rodada 44)

  /** Chave determinística de teste: 44 dígitos, UF 43 (RS), modelo 55. */
  private chaveDfe(i: number): string {
    return chaveDfeDoSimulador(i);
  }

  private resNFeXml(i: number): string {
    const chave = this.chaveDfe(i);
    return [
      '<resNFe versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">',
      `<chNFe>${chave}</chNFe><CNPJ>14200166000187</CNPJ>`,
      `<xNome>Fornecedor Simulado ${i}</xNome>`,
      `<dhEmi>2026-08-2${i}T09:00:00-03:00</dhEmi><vNF>150.00</vNF><cSitNFe>1</cSitNFe>`,
      '</resNFe>',
    ].join('');
  }

  /** A nota COMPLETA — parseável pelo funil de importação de verdade. */
  private procNFeXml(accessKey: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
      '<NFe>',
      `<infNFe Id="NFe${accessKey}" versao="4.00">`,
      '<ide><nNF>901</nNF><serie>1</serie><dhEmi>2026-08-20T09:00:00-03:00</dhEmi></ide>',
      '<emit><CNPJ>14200166000187</CNPJ><xNome>Fornecedor Simulado</xNome></emit>',
      '<det nItem="1"><prod>',
      '<cProd>DFE-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Mercadoria da distribuicao</xProd>',
      '<NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>',
      '<qCom>3</qCom><vUnCom>50.00</vUnCom><vProd>150.00</vProd>',
      '</prod></det>',
      '<total><ICMSTot><vNF>150.00</vNF></ICMSTot></total>',
      '</infNFe>',
      '</NFe>',
      '</nfeProc>',
    ].join('');
  }

  /**
   * Distribuição DF-e simulada.
   *
   * Sem `accessKey`: o lote por NSU — sempre os MESMOS dois resumos (NSU 1 e
   * 2), filtrados por `lastNsu`, para a reconsulta provar idempotência sem
   * estado entre instâncias.
   *
   * Com `accessKey`: o download da nota completa — é o que a ciência libera
   * na SEFAZ real, e aqui devolve um procNFe que o funil de importação
   * consegue parsear de verdade.
   */
  async distributionDFe(input: {
    cnpj: string;
    lastNsu: number;
    accessKey?: string;
  }): Promise<{ cStat: string; xMotivo: string; ultNsu: number; docs: { nsu: string; schema: string; xml: string }[] }> {
    void input.cnpj;
    if (input.accessKey) {
      return {
        cStat: '138',
        xMotivo: 'Documento localizado (PROVIDER DE TESTE)',
        ultNsu: input.lastNsu,
        docs: [{ nsu: String(input.lastNsu || 1), schema: 'procNFe', xml: this.procNFeXml(input.accessKey) }],
      };
    }
    const todos = [1, 2].map((i) => ({ nsu: String(i), schema: 'resNFe', xml: this.resNFeXml(i) }));
    const docs = todos.filter((d) => Number(d.nsu) > input.lastNsu);
    return {
      cStat: docs.length ? '138' : '137',
      xMotivo: docs.length
        ? 'Documentos localizados (PROVIDER DE TESTE)'
        : 'Nenhum documento localizado (PROVIDER DE TESTE)',
      ultNsu: 2,
      docs,
    };
  }

  /** Manifestação do destinatário. Mesma mecânica de evento do cancelamento. */
  async manifest(input: {
    accessKey: string;
    eventType: string;
    justification?: string;
  }): Promise<SefazResponse> {
    void input.eventType;
    void input.justification;
    return this.eventoSimulado(input.accessKey, {
      okStat: '135',
      okMotivo: 'Evento registrado e vinculado a NF-e (PROVIDER DE TESTE)',
      failStat: '573',
      failMotivo: 'Rejeicao: Duplicidade de evento (PROVIDER DE TESTE)',
    });
  }
  /** Carta de correção. Mesma mecânica de evento do cancelamento. */
  async correctionLetter(input: {
    accessKey: string;
    sequence: number;
    text: string;
  }): Promise<SefazResponse> {
    void input.text;
    void input.sequence;
    return this.eventoSimulado(input.accessKey, {
      okStat: '135',
      okMotivo: 'Evento registrado e vinculado a NF-e (PROVIDER DE TESTE)',
      failStat: '594',
      failMotivo: 'Rejeicao: Sequencia de evento ja utilizada (PROVIDER DE TESTE)',
    });
  }
}
