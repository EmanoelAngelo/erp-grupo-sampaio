/**
 * O ADAPTER SEFAZ REAL — rodada 46.
 *
 * ## O que a auditoria mediu, e o que isto conserta
 *
 * O "adapter real" ligado em `fiscalAdapter()` era o SIMULADOR nos dois
 * slots: preencher a tabela de endereços não transmitia nada (rodada 36).
 * Este módulo é o cliente SOAP de verdade — os cinco serviços da interface
 * (status, autorização, consulta, cancelamento, inutilização), a carta de
 * correção, e os dois serviços do Ambiente Nacional que a rodada 44 deixou
 * respondendo 501: Distribuição DF-e e manifestação do destinatário.
 *
 * ## As regras que não se negociam
 *
 * - **A decisão é SEMPRE pelo cStat**, nunca pelo status HTTP
 *   (`parseSefazResponse` — a regra da casa desde o desenho do adapter).
 * - **Falha de transporte LANÇA `TransportFailure`** — a MESMA classe que o
 *   worker da fila reconhece por `instanceof` para consultar a chave antes
 *   de reenviar. Timeout de autorização nunca vira resposta.
 * - **Resposta de EVENTO é lida do bloco `infEvento`**: o retorno traz o
 *   cStat do LOTE (128, "processado") antes do desfecho do evento (135) —
 *   ler o primeiro marcaria rejeição onde houve aceite.
 * - **Eventos e inutilização vão ASSINADOS** (`signXmlElement`, o mesmo
 *   XMLDSig da nota, com as SIGNER_LIMITATIONS declaradas lá).
 * - **O certificado chega ABERTO**: o adapter é construído por requisição e
 *   nunca vê senha — quem o constrói abre o A1 antes: com a selada no cofre
 *   (a emissão, e os atos administrativos pela política padrão do dono —
 *   `FiscalAtosAdministrativos`) ou com a senha digitada, quando ela vem.
 *
 * ## Os endereços
 *
 * RS usa a Sefaz Virtual RS (sefazrs.rs.gov.br) para NF-e (55) e hosts
 * próprios para NFC-e (65); DF-e e eventos do destinatário são serviços do
 * AMBIENTE NACIONAL (nfe.fazenda.gov.br), iguais para todo o país. As URLs
 * seguem o padrão publicado da SVRS — a homologação REAL, com o certificado
 * A1 do grupo, é o juiz final e é a parte do dono.
 */
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { ApiError } from '../../utils/errors.js';
import { environmentCode, type FiscalEnvironment } from './FiscalKeyService.js';
import {
  CSTAT,
  parseSefazResponse,
  type AuthorizeRequest,
  type ConsultRequest,
  type SefazAdapter,
  type SefazResponse,
  type ServiceStatus,
} from './SefazAdapter.js';
import { TransportFailure } from './SefazTestAdapter.js';
import { autoridadesConfiaveis } from './IcpBrasilTrust.js';
import { formatarCnpj } from '../fiscal/FiscalCertificateService.js';
import { signXmlElement } from './FiscalSigner.js';
import { momentoFiscal } from './MomentoFiscal.js';
import { PACOTE_DE_ESQUEMAS, validarXmlContraXsd } from './FiscalXsdValidator.js';
import type { ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';

// ---------------------------------------------------------------- endereços

type ServicoUf = 'status' | 'authorize' | 'consult' | 'event' | 'void';

const CUF: Record<string, string> = { RS: '43' };

/**
 * Os hosts por UF e modelo. Só o RS — a operação inteira é de Pelotas/RS, e
 * endereço fiscal não se chuta: UF fora da tabela responde 501 explicado.
 */
const HOSTS: Record<string, Record<string, Record<FiscalEnvironment, string>>> = {
  RS: {
    '55': {
      homologation: 'https://nfe-homologacao.sefazrs.rs.gov.br',
      production: 'https://nfe.sefazrs.rs.gov.br',
    },
    '65': {
      homologation: 'https://nfce-homologacao.sefazrs.rs.gov.br',
      production: 'https://nfce.sefazrs.rs.gov.br',
    },
  },
};

const CAMINHOS: Record<ServicoUf, string> = {
  status: '/ws/NfeStatusServico/NfeStatusServico4.asmx',
  authorize: '/ws/NfeAutorizacao/NfeAutorizacao4.asmx',
  consult: '/ws/NfeConsulta/NfeConsulta4.asmx',
  event: '/ws/RecepcaoEvento/RecepcaoEvento4.asmx',
  void: '/ws/NfeInutilizacao/NfeInutilizacao4.asmx',
};

/** O namespace WSDL de cada serviço — vai no cabeçalho e no nfeDadosMsg. */
const WSDL: Record<ServicoUf | 'dist' | 'evento', string> = {
  status: 'NFeStatusServico4',
  authorize: 'NFeAutorizacao4',
  consult: 'NFeConsultaProtocolo4',
  event: 'NFeRecepcaoEvento4',
  void: 'NFeInutilizacao4',
  dist: 'NFeDistribuicaoDFe',
  evento: 'NFeRecepcaoEvento4',
};

export function resolverEndpointReal(input: {
  uf: string;
  model: string;
  environment: FiscalEnvironment;
  service: ServicoUf;
}): string {
  const uf = input.uf.toUpperCase();
  const host = HOSTS[uf]?.[input.model]?.[input.environment];
  if (!host) {
    throw new ApiError(
      'CORE_SEFAZ_ENDPOINT_NOT_CONFIGURED',
      `Sem endpoint SEFAZ para UF ${uf} (modelo ${input.model}, ${input.environment}) — endereço fiscal não se chuta.`,
      501,
      { uf, model: input.model, environment: input.environment, service: input.service },
    );
  }
  return `${host}${CAMINHOS[input.service]}`;
}

/** DF-e e eventos do destinatário moram no Ambiente Nacional. */
export function endpointAmbienteNacional(
  environment: FiscalEnvironment,
  service: 'dist' | 'evento',
): string {
  const host =
    environment === 'production'
      ? 'https://www1.nfe.fazenda.gov.br'
      : 'https://hom1.nfe.fazenda.gov.br';
  return service === 'dist'
    ? `${host}/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx`
    : `${host}/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx`;
}

// ---------------------------------------------------------------- transporte

export type PostSoap = (input: {
  url: string;
  body: string;
  cert: ParsedCertificateA1;
  timeoutMs: number;
  /**
   * As autoridades que este servidor reconhece ao validar o certificado DA
   * SEFAZ. Sem as raízes do ICP-Brasil, o Node valida só contra a lista da
   * Mozilla e recusa a conexão com "unable to get local issuer certificate"
   * — ver IcpBrasilTrust (rodada 60).
   */
  ca: string[];
}) => Promise<{ status: number; body: string }>;

/**
 * O POST SOAP 1.2 com TLS mútuo — o molde veio do embrião de homologação
 * (`NfeSefazHomologationClient`, que saiu com o legado no GAP-PRD-075), com os
 * erros convertidos para `TransportFailure`, que é o que a fila entende.
 */
const postSoapReal: PostSoap = (input) =>
  new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        /*
          A CADEIA, e não a folha sozinha (rodada 59). O TLS mútuo espera que
          quem se apresenta mande também as autoridades que o emitiram —
          senão o outro lado tem uma identidade que não consegue verificar. A
          folha sozinha fazia a SEFAZ recusar a conexão, e o dono lia que "a
          comunicação não foi permitida".
        */
        cert: input.cert.chainPem,
        key: input.cert.keyPem,
        /*
          As raízes do ICP-Brasil, que o Node não traz. A validação continua
          LIGADA (`rejectUnauthorized: true` logo abaixo) — o que muda é que
          este servidor passa a conhecer a autoridade que assina os
          webservices do fisco. Sem isto, a conexão morria com "unable to get
          local issuer certificate" e o dono lia isso na tela.
        */
        ca: input.ca,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(input.body),
        },
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          // Resposta fiscal cabe folgada em 10 MB; acima disso não é a
          // SEFAZ falando, é problema — e memória não é infinita.
          if (bytes > 10 * 1024 * 1024) {
            req.destroy();
            reject(new TransportFailure('NETWORK_ERROR', 'Resposta da SEFAZ grande demais.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', (err) => reject(new TransportFailure('NETWORK_ERROR', err.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new TransportFailure('TIMEOUT', 'A SEFAZ não respondeu no tempo limite.'));
    });
    req.write(input.body);
    req.end();
  });

// ------------------------------------------------------------------ helpers

function escapeXml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Envelope SOAP 1.2 no formato do embrião de homologação (Header + Body). */
function envelope(servico: keyof typeof WSDL, dados: string): string {
  const ns = `http://www.portalfiscal.inf.br/nfe/wsdl/${WSDL[servico]}`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + '<soap12:Body>'
    + `<nfeDadosMsg xmlns="${ns}">${dados}</nfeDadosMsg>`
    + '</soap12:Body>'
    + '</soap12:Envelope>'
  );
}

/** A declaração `<?xml?>` do documento assinado NÃO pode viajar dentro do envelope. */
function semDeclaracao(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}

/**
 * Isola o desfecho do EVENTO na resposta.
 *
 * O retorno de evento traz DOIS cStat: o do lote (128, "processado") e o do
 * evento em si (135/573/...). `parseSefazResponse` pega o primeiro que achar
 * — então o bloco `retEvento` é recortado antes do parse. Sem recorte, todo
 * evento aceito leria 128 e viraria rejeição.
 */
function desfechoDoEvento(body: string): string {
  const inicio = body.indexOf('<retEvento');
  if (inicio < 0) return body;
  const fim = body.indexOf('</retEvento>');
  return fim < 0 ? body.slice(inicio) : body.slice(inicio, fim + '</retEvento>'.length);
}

function campo(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)</(?:\\w+:)?${tag}>`));
  return m ? m[1].trim() : null;
}

const TIMEOUT_MS = 30_000;

// ------------------------------------------------- o que a CHAVE já diz

/*
  A CHAVE DE ACESSO É A CERTIDÃO DA NOTA — GAP-PRD-019.

  cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) cDV(1). O
  evento sobre uma nota não precisa que ninguém lhe diga o modelo nem quem a
  emitiu: está escrito ali, e foi escrito no instante da emissão. Perguntar a
  qualquer outra fonte (o modelo '55' cravado, o CNPJ do certificado) é abrir
  espaço para a outra fonte discordar da nota.
*/
function exigirChave(chave: string): string {
  const limpa = String(chave ?? '').trim();
  if (!/^\d{44}$/.test(limpa)) {
    throw new ApiError(
      'CORE_SEFAZ_ACCESS_KEY_INVALID',
      'A chave de acesso da nota precisa ter 44 dígitos para que o evento seja montado.',
      400,
    );
  }
  return limpa;
}

function modeloDaChave(chave: string): string {
  return chave.slice(20, 22);
}

function cnpjDaChave(chave: string): string {
  return chave.slice(6, 20);
}

function soDigitos(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * O instante do evento no formato do leiaute (TDateTimeUTC): segundos, sem
 * milissegundos, com o deslocamento do EMITENTE — o mesmo relógio do `dhEmi`.
 * `toISOString()` sai com `.mmmZ` e a SEFAZ recusa por schema (225).
 */
function dhEvento(uf: string | null | undefined): string {
  return momentoFiscal(new Date(), String(uf ?? '')).dhEmi;
}

// ------------------------------------------------------------------ adapter

export class SefazRealAdapter implements SefazAdapter {
  readonly name = 'sefaz-rs-real';
  readonly isReal = true;

  private readonly cert: ParsedCertificateA1;
  private readonly postSoap: PostSoap;

  constructor(input: { cert: ParsedCertificateA1; postSoap?: PostSoap }) {
    this.cert = input.cert;
    this.postSoap = input.postSoap ?? postSoapReal;
  }

  private async enviar(url: string, servico: keyof typeof WSDL, dados: string): Promise<string> {
    const resposta = await this.postSoap({
      url,
      body: envelope(servico, dados),
      cert: this.cert,
      timeoutMs: TIMEOUT_MS,
      // O Node não conhece a Raiz Brasileira; ela vem do repositório.
      ca: autoridadesConfiaveis(),
    });
    // 5xx é o serviço caído — retryable, e a fila consulta antes de reenviar.
    // A DECISÃO fiscal continua sendo pelo cStat, nunca pelo HTTP.
    if (resposta.status >= 500) {
      throw new TransportFailure('NETWORK_ERROR', `SEFAZ respondeu HTTP ${resposta.status}.`);
    }
    return resposta.body;
  }

  /**
   * O A1 pode assinar pelo autor? A régua é a do fisco: a RAIZ do CNPJ (oito
   * dígitos) — o A1 da matriz assina pela filial. Raiz diferente a SEFAZ
   * recusa (213); recusar aqui poupa a viagem e diz os dois números.
   * Certificado sem CNPJ reconhecível (e-CPF) não é conferido: a conferência
   * dele é feita na carga, com o aviso ao dono.
   */
  private conferirRaizDoAutor(cnpjAutor: string): void {
    const doCertificado = soDigitos(this.cert.cnpj);
    if (doCertificado.length !== 14 || cnpjAutor.length !== 14) return;
    if (doCertificado.slice(0, 8) === cnpjAutor.slice(0, 8)) return;
    throw new ApiError(
      'CORE_SEFAZ_CERTIFICATE_CNPJ_ROOT_MISMATCH',
      `O certificado é de ${formatarCnpj(doCertificado)} e o autor deste ato é `
        + `${formatarCnpj(cnpjAutor)}: raízes de CNPJ diferentes. A SEFAZ recusaria a assinatura `
        + '(cStat 213) — nada foi transmitido.',
      409,
    );
  }

  async statusServico(input: {
    uf: string;
    environment: FiscalEnvironment;
    /** 65 pergunta ao host da NFC-e (GAP-PRD-020); ausente, o da NF-e. */
    model?: string;
  }): Promise<ServiceStatus> {
    // UF desconhecida NAO vira RS em silencio: o resolverEndpointReal logo
    // abaixo levanta 501 para ela — o ?? aqui só mascararia a mesma falta.
    const cUF = CUF[input.uf.toUpperCase()] ?? '00';
    const url = resolverEndpointReal({
      uf: input.uf,
      model: input.model === '65' ? '65' : '55',
      environment: input.environment,
      service: 'status',
    });
    const dados =
      `<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
      + `<tpAmb>${environmentCode(input.environment)}</tpAmb>`
      + `<cUF>${cUF}</cUF>`
      + '<xServ>STATUS</xServ>'
      + '</consStatServ>';
    const body = await this.enviar(url, 'status', dados);
    const cStat = campo(body, 'cStat');
    return {
      /*
        A TABELA CANÔNICA MANDA — e ela diz `SERVICE_UP: ['107']`.

        Aqui estava `cStat === '107' || cStat === '108'`, e 108 é "Serviço
        Paralisado MOMENTANEAMENTE", que a mesma tabela lista em
        `SERVICE_DOWN`. Eram três respostas para uma pergunta só: a tabela
        dizia parado, o adapter de teste dizia parado, e só este — o que fala
        com o fisco de verdade — dizia no ar. A tela pintava verde "serviço em
        operação" enquanto a SEFAZ dizia o contrário.

        A distinção entre 108 (momentâneo) e 109 (sem previsão) não se perde:
        ela chega em `xMotivo`, com as palavras do fisco, que é onde quem
        decide se espera vai olhar.
      */
      online: (CSTAT.SERVICE_UP as readonly string[]).includes(cStat ?? ''),
      cStat,
      xMotivo: campo(body, 'xMotivo'),
      source: 'sefaz',
      checkedAt: new Date().toISOString(),
    };
  }

  async authorize(input: AuthorizeRequest & { model?: string }): Promise<SefazResponse> {
    const url = resolverEndpointReal({
      uf: input.uf,
      model: input.model ?? '55',
      environment: input.environment,
      service: 'authorize',
    });
    /*
      Lote SÍNCRONO de um documento (indSinc=1): a resposta já traz o
      protocolo — sem a dança de recibo do modo assíncrono. O idLote sai da
      própria chave: determinístico, e reenvio do mesmo documento manda o
      mesmo lote.
    */
    const idLote = input.accessKey.slice(-15).replace(/^0+/, '') || '1';
    const dados =
      `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
      + `<idLote>${idLote}</idLote>`
      + '<indSinc>1</indSinc>'
      + semDeclaracao(input.signedXml)
      + '</enviNFe>';
    const body = await this.enviar(url, 'authorize', dados);
    return parseSefazResponse({ body, correlationId: input.accessKey });
  }

  async consult(input: ConsultRequest & { model?: string }): Promise<SefazResponse> {
    const url = resolverEndpointReal({
      uf: input.uf,
      model: input.model ?? '55',
      environment: input.environment,
      service: 'consult',
    });
    const dados =
      `<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
      + `<tpAmb>${environmentCode(input.environment)}</tpAmb>`
      + '<xServ>CONSULTAR</xServ>'
      + `<chNFe>${input.accessKey}</chNFe>`
      + '</consSitNFe>';
    const body = await this.enviar(url, 'consult', dados);
    return parseSefazResponse({ body, correlationId: input.accessKey });
  }

  // ------------------------------------------------------------------ eventos

  /**
   * Monta o envEvento de UM evento, assinado sobre o infEvento.
   *
   * `cOrgao` 91 é o Ambiente Nacional (manifestação do destinatário); os
   * eventos do emitente (cancelamento, CC-e) levam o cUF da UF.
   */
  private montarEvento(input: {
    cOrgao: string;
    accessKey: string;
    /**
     * O AUTOR do evento. Nos eventos do emitente (cancelamento, CC-e) é o
     * CNPJ que está NA CHAVE — o de quem emitiu a nota —, e não o do
     * certificado: o A1 da matriz assina pela filial, mas quem cancela a nota
     * da filial é a filial (a SEFAZ recusa "autor diverge do emissor").
     */
    cnpjAutor: string;
    /** UF do autor — o relógio do `dhEvento`. */
    uf: string;
    tpEvento: string;
    nSeqEvento: number;
    environment: FiscalEnvironment;
    detEvento: string;
  }): string {
    this.conferirRaizDoAutor(input.cnpjAutor);
    const seq = String(input.nSeqEvento).padStart(2, '0');
    const id = `ID${input.tpEvento}${input.accessKey}${seq}`;
    const xml =
      `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">`
      + '<idLote>1</idLote>'
      + '<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">'
      + `<infEvento Id="${id}">`
      + `<cOrgao>${input.cOrgao}</cOrgao>`
      + `<tpAmb>${environmentCode(input.environment)}</tpAmb>`
      + `<CNPJ>${input.cnpjAutor}</CNPJ>`
      + `<chNFe>${input.accessKey}</chNFe>`
      + `<dhEvento>${dhEvento(input.uf)}</dhEvento>`
      + `<tpEvento>${input.tpEvento}</tpEvento>`
      + `<nSeqEvento>${input.nSeqEvento}</nSeqEvento>`
      + '<verEvento>1.00</verEvento>'
      + `<detEvento versao="1.00">${input.detEvento}</detEvento>`
      + '</infEvento>'
      + '</evento>'
      + '</envEvento>';
    // A assinatura entra dentro de <evento>, irmã do infEvento — enveloped.
    return signXmlElement(xml, { tagName: 'infEvento', closeParentTag: '</evento>' }, this.cert)
      .xml;
  }

  private async enviarEvento(url: string, assinado: string, accessKey: string): Promise<SefazResponse> {
    const body = await this.enviar(url, 'event', assinado);
    return {
      ...parseSefazResponse({ body: desfechoDoEvento(body), correlationId: accessKey }),
      /*
        O EVENTO ASSINADO VIAJA JUNTO com a resposta (GAP-V32): o retorno da
        SEFAZ traz só o `retEvento`, e o procEventoNFe de arquivamento precisa
        das duas metades — o evento COM a assinatura e o desfecho. Este é o
        único lugar que segura o XML que acabou de assinar; jogá-lo fora aqui
        era o que condenava o pacote do contador ao "[removido]".
      */
      xmlEventoAssinado: assinado,
    };
  }

  /**
   * O que todo evento do EMITENTE sobre uma nota precisa, tirado da chave:
   * o modelo (que escolhe o host — NFC-e e NF-e moram em hosts diferentes no
   * RS) e o CNPJ do autor. Modelo informado que desmente a chave é recusado
   * antes de montar qualquer coisa.
   */
  private eventoDoEmitente(input: {
    accessKey: string;
    model?: string;
    uf: string;
    environment: FiscalEnvironment;
  }): { chave: string; modelo: string; url: string; cnpjAutor: string } {
    const chave = exigirChave(input.accessKey);
    const modelo = modeloDaChave(chave);
    if (input.model && String(input.model) !== modelo) {
      throw new ApiError(
        'CORE_SEFAZ_MODEL_MISMATCH',
        `A chave é de um documento modelo ${modelo}, e o pedido diz modelo ${input.model}. `
          + 'O evento não foi montado.',
        409,
      );
    }
    const url = resolverEndpointReal({
      uf: input.uf,
      model: modelo,
      environment: input.environment,
      service: 'event',
    });
    return { chave, modelo, url, cnpjAutor: cnpjDaChave(chave) };
  }

  async cancel(input: {
    companyId: string;
    accessKey: string;
    model?: string;
    protocol: string;
    justification: string;
    uf: string;
    environment: FiscalEnvironment;
  }): Promise<SefazResponse> {
    /*
      O HOST VEM DO MODELO DA NOTA (GAP-PRD-019). Aqui estava `model: '55'`
      cravado: o cancelamento de toda NFC-e ia ao host da NF-e, enquanto a
      autorização e a inutilização da mesma NFC-e já iam ao host dela.
    */
    const { chave, url, cnpjAutor } = this.eventoDoEmitente(input);
    const assinado = this.montarEvento({
      cOrgao: CUF[input.uf.toUpperCase()] ?? CUF.RS,
      accessKey: chave,
      cnpjAutor,
      uf: input.uf,
      tpEvento: '110111',
      nSeqEvento: 1,
      environment: input.environment,
      detEvento:
        '<descEvento>Cancelamento</descEvento>'
        + `<nProt>${input.protocol}</nProt>`
        + `<xJust>${escapeXml(input.justification)}</xJust>`,
    });
    return this.enviarEvento(url, assinado, chave);
  }

  /** Carta de correção — evento 110110, com o texto de uso obrigatório do layout. */
  async correctionLetter(input: {
    companyId: string;
    accessKey: string;
    model?: string;
    sequence: number;
    text: string;
    uf: string;
    environment: FiscalEnvironment;
  }): Promise<SefazResponse> {
    const { chave, modelo, url, cnpjAutor } = this.eventoDoEmitente(input);
    // A NFC-e não tem carta de correção: o evento 110110 é da NF-e. Mandar
    // assim mesmo seria gastar a viagem para colher a recusa.
    if (modelo !== '55') {
      throw new ApiError(
        'CORE_FISCAL_CCE_WRONG_MODEL',
        'Carta de correção é da NF-e modelo 55 — a NFC-e não tem CC-e. Nada foi transmitido.',
        409,
      );
    }
    const condUso =
      'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 '
      + 'e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja '
      + 'relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca '
      + 'de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca '
      + 'do remetente ou do destinatario; III - a data de emissao ou de saida.';
    const assinado = this.montarEvento({
      cOrgao: CUF[input.uf.toUpperCase()] ?? CUF.RS,
      accessKey: chave,
      cnpjAutor,
      uf: input.uf,
      tpEvento: '110110',
      nSeqEvento: input.sequence,
      environment: input.environment,
      detEvento:
        '<descEvento>Carta de Correcao</descEvento>'
        + `<xCorrecao>${escapeXml(input.text)}</xCorrecao>`
        + `<xCondUso>${condUso}</xCondUso>`,
    });
    return this.enviarEvento(url, assinado, chave);
  }

  /** Manifestação do destinatário — eventos 210xxx, no Ambiente Nacional (órgão 91). */
  async manifest(input: {
    accessKey: string;
    eventType: string;
    justification?: string;
    environment?: FiscalEnvironment;
    /** UF do destinatário, para o relógio do `dhEvento`. Ausente: Brasília. */
    uf?: string;
  }): Promise<SefazResponse> {
    const environment = input.environment ?? 'homologation';
    const DESCRICOES: Record<string, string> = {
      '210200': 'Confirmacao da Operacao',
      '210210': 'Ciencia da Operacao',
      '210220': 'Desconhecimento da Operacao',
      '210240': 'Operacao nao Realizada',
    };
    const detalhe =
      `<descEvento>${DESCRICOES[input.eventType] ?? 'Manifestacao'}</descEvento>`
      + (input.justification ? `<xJust>${escapeXml(input.justification)}</xJust>` : '');
    const assinado = this.montarEvento({
      cOrgao: '91',
      accessKey: input.accessKey,
      // Na manifestação o autor é o DESTINATÁRIO — esta operação, a dona do
      // certificado. É o único evento em que o CNPJ do A1 é o do autor.
      cnpjAutor: soDigitos(this.cert.cnpj),
      uf: input.uf ?? '',
      tpEvento: input.eventType,
      nSeqEvento: 1,
      environment,
      detEvento: detalhe,
    });
    const url = endpointAmbienteNacional(environment, 'evento');
    const body = await this.enviar(url, 'evento', assinado);
    return parseSefazResponse({ body: desfechoDoEvento(body), correlationId: input.accessKey });
  }

  // ------------------------------------------------------------- inutilização

  async voidNumberRange(input: {
    companyId: string;
    model: string;
    serie: number;
    from: number;
    to: number;
    year?: number;
    cnpj?: string;
    justification: string;
    uf: string;
    environment: FiscalEnvironment;
  }): Promise<SefazResponse> {
    const cUF = CUF[input.uf.toUpperCase()] ?? CUF.RS;
    const url = resolverEndpointReal({
      uf: input.uf,
      model: input.model,
      environment: input.environment,
      service: 'void',
    });
    /*
      O AUTOR É O EMITENTE, NÃO O CERTIFICADO (GAP-PRD-019).

      `this.cert.cnpj` ia no Id e no <CNPJ>: com o A1 da matriz, a filial
      inutilizava numeração DA MATRIZ. A inutilização não tem chave de onde
      tirar o emitente — ele chega do cadastro fiscal da operação, e sem ele
      nada é montado (cair no do certificado seria voltar ao defeito).
    */
    const cnpjAutor = soDigitos(input.cnpj);
    if (cnpjAutor.length !== 14) {
      throw new ApiError(
        'CORE_SEFAZ_EMITTER_CNPJ_REQUIRED',
        'A inutilização precisa do CNPJ do emitente (Fiscal › Configuração). Nada foi transmitido.',
        409,
      );
    }
    this.conferirRaizDoAutor(cnpjAutor);
    /*
      O ANO VEM DO PEDIDO (GAP-PRD-019). Era `new Date().getFullYear()` — o
      relógio da máquina — e o `year` da rota era descartado: em janeiro, a
      faixa do ano anterior saía com o ano novo. Sem ano no pedido, vale o
      corrente no fuso do EMITENTE (o mesmo relógio da chave de acesso).
    */
    const ano =
      input.year !== undefined
        ? String(input.year).slice(-2)
        : momentoFiscal(new Date(), input.uf).aamm.slice(0, 2);
    const serie3 = String(input.serie).padStart(3, '0');
    const ini9 = String(input.from).padStart(9, '0');
    const fim9 = String(input.to).padStart(9, '0');
    const id = `ID${cUF}${ano}${cnpjAutor}${input.model}${serie3}${ini9}${fim9}`;
    const xml =
      `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">`
      + `<infInut Id="${id}">`
      + `<tpAmb>${environmentCode(input.environment)}</tpAmb>`
      + '<xServ>INUTILIZAR</xServ>'
      + `<cUF>${cUF}</cUF>`
      + `<ano>${ano}</ano>`
      + `<CNPJ>${cnpjAutor}</CNPJ>`
      + `<mod>${input.model}</mod>`
      + `<serie>${input.serie}</serie>`
      + `<nNFIni>${input.from}</nNFIni>`
      + `<nNFFin>${input.to}</nNFFin>`
      + `<xJust>${escapeXml(input.justification)}</xJust>`
      + '</infInut>'
      + '</inutNFe>';
    const assinado = signXmlElement(
      xml,
      { tagName: 'infInut', closeParentTag: '</inutNFe>' },
      this.cert,
    ).xml;
    /*
      O inutNFe PASSA PELO XSD OFICIAL ANTES DE VIAJAR — o mesmo portão que a
      nota tem (GAP-PRD-097), agora que a inutilização carrega ano e CNPJ
      vindos de fora. Recusa aqui não gasta a viagem nem deixa a faixa
      reservada à espera de uma resposta que seria 225.
    */
    const leiaute = validarXmlContraXsd(assinado, 'inutNFe');
    if (!leiaute.validated) {
      throw new ApiError(
        'CORE_FISCAL_XSD_UNAVAILABLE',
        `A inutilização não é transmitida sem a conferência do leiaute. ${leiaute.note ?? ''}`.trim(),
        503,
      );
    }
    if (leiaute.problems.length > 0) {
      throw new ApiError(
        'CORE_FISCAL_LAYOUT_INVALID',
        `A inutilização montada não cumpre o leiaute oficial (${PACOTE_DE_ESQUEMAS}) e não foi `
          + `transmitida: ${leiaute.problems.join(' | ')}`,
        409,
        { problems: leiaute.problems, schemaPackage: PACOTE_DE_ESQUEMAS },
      );
    }
    const body = await this.enviar(url, 'void', assinado);
    return {
      ...parseSefazResponse({ body, correlationId: id }),
      /*
        O inutNFe ASSINADO VIAJA JUNTO com a resposta — o resíduo do GAP-V32.

        Esta função montava, assinava e DESCARTAVA o XML na linha seguinte ao
        envio: sobrava só o retorno, que passa por `sanitizeResponse` antes de
        ser gravado, com a assinatura trocada por "[removido]". O contador
        ficava sem como provar, fora do portal da SEFAZ, que aquele buraco na
        numeração foi inutilizado — e a inutilização existe exatamente PARA
        justificar números que nunca viraram nota.

        Este é o único lugar que segura o XML que acabou de assinar, do mesmo
        jeito que `enviarEvento` é para o cancelamento e a carta de correção.
      */
      xmlInutAssinado: assinado,
    };
  }

  // ------------------------------------------------------------------- DF-e

  /**
   * Distribuição DF-e — o que foi emitido contra o CNPJ, por NSU; com
   * `accessKey`, o download da nota específica (o que a ciência libera).
   * O documento vem em `docZip`: gzip+base64, descomprimido AQUI — quem
   * consome recebe XML, não pacote.
   */
  async distributionDFe(input: {
    cnpj: string;
    lastNsu: number;
    accessKey?: string;
    environment?: FiscalEnvironment;
    /** UF do AUTOR da consulta — a da empresa, nunca chutada (auditoria). */
    uf?: string;
  }): Promise<{
    cStat: string;
    xMotivo: string;
    ultNsu: number;
    /** O maior NSU que a SEFAZ tem para o CNPJ — com ultNSU < maxNSU, há mais a pedir (R3-DFE). */
    maxNsu?: number;
    docs: { nsu: string; schema: string; xml: string }[];
  }> {
    const environment = input.environment ?? 'homologation';
    /*
      O cUFAutor era '43' CRAVADO: este serviço fala com o Ambiente Nacional
      — não passa pelo portão de 501 do resolverEndpointReal —, então uma
      empresa de outra UF consultava DF-e declarando autoria do RS em
      silêncio. A UF vem da config da empresa; desconhecida, recusa.
    */
    const ufAutor = String(input.uf ?? 'RS').trim().toUpperCase();
    const cUFAutor = CUF[ufAutor];
    if (!cUFAutor) {
      throw new ApiError(
        'CORE_SEFAZ_UF_NOT_MAPPED',
        `Sem código cUF mapeado para a UF ${ufAutor} — endereço fiscal não se chuta.`,
        501,
      );
    }
    const consulta = input.accessKey
      ? `<consChNFe><chNFe>${input.accessKey}</chNFe></consChNFe>`
      : `<distNSU><ultNSU>${String(input.lastNsu).padStart(15, '0')}</ultNSU></distNSU>`;
    const dados =
      `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">`
      + `<tpAmb>${environmentCode(environment)}</tpAmb>`
      + `<cUFAutor>${cUFAutor}</cUFAutor>`
      + `<CNPJ>${input.cnpj}</CNPJ>`
      + consulta
      + '</distDFeInt>';
    const url = endpointAmbienteNacional(environment, 'dist');
    const body = await this.enviar(url, 'dist', dados);

    const docs: { nsu: string; schema: string; xml: string }[] = [];
    const re = /<docZip[^>]*NSU="0*(\d+)"[^>]*schema="([^"_]+)[^"]*"[^>]*>([^<]+)<\/docZip>/g;
    for (const m of body.matchAll(re)) {
      try {
        docs.push({
          nsu: m[1],
          schema: m[2],
          // maxOutputLength barra gzip bomb: nota gigante não existe —
          // procNFe real cabe folgado em 5 MB descomprimido.
          xml: gunzipSync(Buffer.from(m[3].trim(), 'base64'), {
            maxOutputLength: 5 * 1024 * 1024,
          }).toString('utf8'),
        });
      } catch {
        // Pacote corrompido não derruba o lote: os demais documentos entram.
        // O NSU ausente NÃO volta na próxima distNSU — desde o R3-DFE o cursor
        // é o ultNSU que a SEFAZ devolve —; a nota chega pelo e-mail/upload, ou
        // pela consulta da chave depois da ciência. Base64 de gzip corrompido
        // vindo da própria SEFAZ não é cenário real, e o teto de 5 MB passa
        // folgado da maior NF-e possível (990 itens).
      }
    }
    // O maxNSU manda continuar (ultNSU < maxNSU) ou esperar (iguais) — R3-DFE.
    const maxNsu = campo(body, 'maxNSU');
    return {
      cStat: campo(body, 'cStat') ?? '',
      xMotivo: campo(body, 'xMotivo') ?? '',
      ultNsu: Number(campo(body, 'ultNSU') ?? input.lastNsu),
      ...(maxNsu !== null && /^\d+$/.test(maxNsu) ? { maxNsu: Number(maxNsu) } : {}),
      docs,
    };
  }
}

/*
  O SLOT À PARTE DA DISTRIBUIÇÃO DF-e SAIU DAQUI (GAP-PRD-168).

  `adapterRealOuSimulador` abria o A1 só com a senha digitada no corpo e,
  sem ela, devolvia o simulador fora de produção: com o certificado no cofre,
  a consulta e a manifestação pela tela tomavam 400 em produção e falavam com
  o simulador em homologação. Os atos com a SEFAZ sem nota nossa — inutilização,
  consulta e manifestação — decidem agora em `adapterDoAtoFiscal`
  (`FiscalAtosAdministrativos`): uma política só, a do dono.
*/
