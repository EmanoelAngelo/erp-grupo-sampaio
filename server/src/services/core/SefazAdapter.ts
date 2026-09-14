/**
 * Interface única de comunicação com a SEFAZ.
 *
 * TODO acesso ao fisco passa por aqui. Espalhar SOAP pelo código produziria
 * versões divergentes do tratamento de resposta, e é exatamente no tratamento
 * de resposta que mora o risco: dar uma nota como autorizada quando não é.
 *
 * A REGRA QUE GOVERNA ESTE MÓDULO
 *
 * O status HTTP não determina autorização. A SEFAZ responde HTTP 200 tanto
 * para "autorizado" quanto para "rejeitado por CNPJ inválido" — o que decide é
 * o `cStat` dentro do envelope. Confundir os dois é o erro que faz um sistema
 * imprimir cupom de nota recusada.
 */
import { ApiError } from '../../utils/errors.js';
import { loadEnv } from '../../config/env.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';

// ------------------------------------------------------------------- cStat

/**
 * Códigos de retorno.
 *
 * A tabela completa vive no Manual de Orientação do Contribuinte e muda entre
 * versões do layout. Aqui ficam só os que MUDAM A DECISÃO, agrupados por
 * efeito — e a classificação de qualquer código desconhecido é "não
 * autorizado", nunca o contrário.
 */
export const CSTAT = {
  /** Autorizado o uso da NF-e. */
  AUTHORIZED: ['100', '150'],
  /** Cancelamento homologado. */
  CANCELLED: ['101', '135', '155'],
  /** Uso denegado — documento existe, mas não pode ser usado. */
  DENIED: ['110', '301', '302', '303'],
  /** Já existe documento com esta chave/numeração. Exige CONSULTA, não reenvio. */
  DUPLICATE: ['204', '539'],
  /** Documento não consta na base do fisco. */
  NOT_FOUND: ['217', '999999'],
  /** Serviço fora do ar — retentável. */
  SERVICE_DOWN: ['108', '109', '999'],
  /** Lote ainda em processamento — exige nova consulta, não reenvio. */
  PROCESSING: ['105', '106'],
  /** Serviço em operação (resposta de statusServico). */
  SERVICE_UP: ['107'],
} as const;

export type SefazOutcome =
  | 'AUTHORIZED'
  | 'REJECTED'
  | 'DENIED'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'PROCESSING'
  | 'SERVICE_DOWN'
  | 'TRANSPORT_ERROR'
  | 'TIMEOUT';

/**
 * Traduz o cStat em decisão.
 *
 * O DEFAULT É REJEITADO. Código novo ou desconhecido nunca vira autorização:
 * o preço de tratar um desconhecido como rejeitado é reprocessar; o preço de
 * tratá-lo como autorizado é entregar cupom sem nota válida.
 */
export function classifyCStat(cStat: string | null | undefined): SefazOutcome {
  const codigo = (cStat ?? '').trim();
  if (!codigo) return 'REJECTED';

  if ((CSTAT.AUTHORIZED as readonly string[]).includes(codigo)) return 'AUTHORIZED';
  if ((CSTAT.DENIED as readonly string[]).includes(codigo)) return 'DENIED';
  if ((CSTAT.DUPLICATE as readonly string[]).includes(codigo)) return 'DUPLICATE';
  if ((CSTAT.NOT_FOUND as readonly string[]).includes(codigo)) return 'NOT_FOUND';
  if ((CSTAT.SERVICE_DOWN as readonly string[]).includes(codigo)) return 'SERVICE_DOWN';
  if ((CSTAT.PROCESSING as readonly string[]).includes(codigo)) return 'PROCESSING';

  return 'REJECTED';
}

/** Falha transitória: vale retentar. Rejeição fiscal NÃO entra aqui. */
export function isRetryable(outcome: SefazOutcome): boolean {
  return outcome === 'SERVICE_DOWN' || outcome === 'TRANSPORT_ERROR' || outcome === 'TIMEOUT';
}

/**
 * Desfecho que exige CONSULTAR antes de qualquer reenvio.
 *
 * Reenviar depois de um timeout é como pedir a mesma pizza porque o entregador
 * demorou: a primeira pode estar a caminho. Na SEFAZ isso significa duas notas
 * para a mesma venda.
 */
export function requiresConsultBeforeRetry(outcome: SefazOutcome): boolean {
  return outcome === 'TIMEOUT' || outcome === 'DUPLICATE' || outcome === 'PROCESSING';
}

// ---------------------------------------------------------------- respostas

export interface SefazResponse {
  outcome: SefazOutcome;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
  accessKey: string | null;
  /** XML de retorno, já sem nada que possa carregar segredo. */
  rawResponse: string | null;
  /**
   * O MESMO retorno, íntegro — sem `sanitizeResponse` (GAP-V32).
   *
   * Existe para o ARQUIVAMENTO do evento fiscal: a assinatura de um
   * cancelamento é prova pública, e apagá-la do documento guardado condena o
   * contador ao portal da SEFAZ. A sanitização continua valendo onde sempre
   * valeu — `rawResponse` é o que vai para log, tela e `xml_authorized`; este
   * campo só é gravado no lugar que existe para guardar documento
   * (`core_fiscal_events.xml_proc`, via `montarProcEventoNfe`).
   */
  rawResponseIntegro: string | null;
  /**
   * O evento ASSINADO que foi enviado (envEvento), quando o adapter o tem.
   *
   * É a metade que o retorno não traz: o procEventoNFe de arquivamento é
   * evento assinado + retEvento, e só o adapter real segura o XML que
   * assinou. Ausente no provider de teste — que, certo, nunca fabrica prova.
   */
  xmlEventoAssinado?: string | null;
  /**
   * O `inutNFe` ASSINADO que foi enviado — o resíduo do GAP-V32.
   *
   * A inutilização ficou de fora da rodada que deu prova ao cancelamento e à
   * carta de correção, e o buraco é do mesmo tamanho: `voidNumberRange` monta e
   * assina o `inutNFe`, envia, e joga o XML assinado fora na linha seguinte.
   * Sobrava só o retorno, que passa por `sanitizeResponse` antes de ser gravado
   * — assinatura e certificado viram "[removido]".
   *
   * Inutilização é justamente o documento em que a prova mais importa: ela
   * existe PARA justificar números que nunca viraram nota. Sem ela, a
   * justificativa do buraco na numeração depende de o fisco consultar o próprio
   * sistema.
   *
   * Ausente no provider de teste, que não assina nada — e é assim que se
   * garante que ensaio não vira arquivo probatório.
   */
  xmlInutAssinado?: string | null;
  receivedAt: string;
  /** Liga a requisição à resposta no log, sem expor conteúdo. */
  correlationId: string;
}

/**
 * Extrai o desfecho fiscal do envelope de resposta.
 *
 * INDEPENDENTE DO HTTP. Recebe o corpo já lido; quem chamou não passa o status
 * porque ele não participa da decisão.
 */
export function parseSefazResponse(input: {
  body: string;
  correlationId: string;
  receivedAt?: string;
}): SefazResponse {
  /*
    A ABERTURA DA TAG ACEITA ATRIBUTOS — GAP-PRD-004.

    O leiaute 4.00 declara `Id` em `infProt` (opcional), e a SVRS o preenche:
    `<infProt Id="ID143...">`. Com a regex exigindo a tag nua, o bloco do
    protocolo não era achado e a leitura caía no cStat do LOTE (104, "Lote
    processado"): nota AUTORIZADA pelo fisco virava REJECTED, sem protocolo, e
    a reemissão queimava número para colher duplicidade. `(?:\s[^>]*)?` aceita
    atributo e só atributo — `<infProtX>` continua não sendo protocolo.
  */
  const abre = (tag: string): string => `<(?:\\w+:)?${tag}(?:\\s[^>]*)?>`;
  const fecha = (tag: string): string => `</(?:\\w+:)?${tag}>`;
  const lerEm = (xml: string, tag: string): string | null => {
    const m = new RegExp(`${abre(tag)}([^<]*)${fecha(tag)}`).exec(xml);
    return m ? m[1].trim() : null;
  };
  const pegar = (tag: string): string | null => lerEm(input.body, tag);

  // O protocolo traz o cStat do DOCUMENTO; fora dele fica o do LOTE. O que
  // decide a sorte da nota é o de dentro do protocolo, quando existe.
  const protocolo = new RegExp(`${abre('infProt')}([\\s\\S]*?)${fecha('infProt')}`).exec(
    input.body,
  )?.[1];
  const pegarNoProtocolo = (tag: string): string | null =>
    protocolo ? lerEm(protocolo, tag) : null;

  const cStat = pegarNoProtocolo('cStat') ?? pegar('cStat');
  const xMotivo = pegarNoProtocolo('xMotivo') ?? pegar('xMotivo');
  const protocol = pegarNoProtocolo('nProt') ?? pegar('nProt');
  const accessKey = pegarNoProtocolo('chNFe') ?? pegar('chNFe');

  return {
    outcome: classifyCStat(cStat),
    cStat,
    xMotivo,
    protocol,
    accessKey,
    rawResponse: sanitizeResponse(input.body),
    // O corpo como chegou. Ninguém o serializa em log — quem loga usa
    // `rawResponse`; quem o consome é o arquivamento do evento (GAP-V32).
    rawResponseIntegro: input.body,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    correlationId: input.correlationId,
  };
}

/**
 * Remove do XML guardado qualquer coisa que possa ser segredo.
 *
 * O retorno da SEFAZ não costuma trazer credencial, mas o XML enviado vai
 * embutido em algumas respostas — e ele carrega o certificado e o QR com CSC
 * hasheado. Guardar o bruto sem filtrar acabaria colocando isso no banco e nos
 * logs.
 */
export function sanitizeResponse(xml: string): string {
  return xml
    .replace(
      /<(?:\w+:)?X509Certificate>[\s\S]*?<\/(?:\w+:)?X509Certificate>/g,
      '<X509Certificate>[removido]</X509Certificate>',
    )
    .replace(
      /<(?:\w+:)?SignatureValue>[\s\S]*?<\/(?:\w+:)?SignatureValue>/g,
      '<SignatureValue>[removido]</SignatureValue>',
    )
    .replace(/([?&]cHashQRCode=)[^&"'<\s]+/gi, '$1[removido]')
    .replace(/([?&]cIdToken=)[^&"'<\s]+/gi, '$1[removido]');
}

// ------------------------------------------------------------------ adapter

export interface AuthorizeRequest {
  companyId: string;
  /** '55' NF-e, '65' NFC-e — no RS os HOSTS diferem (rodada 46). */
  model?: string;
  documentId: string;
  accessKey: string;
  signedXml: string;
  uf: string;
  environment: FiscalEnvironment;
}

export interface ConsultRequest {
  companyId: string;
  model?: string;
  accessKey: string;
  uf: string;
  environment: FiscalEnvironment;
}

export interface ServiceStatus {
  online: boolean;
  cStat: string | null;
  xMotivo: string | null;
  /** Identifica a origem da informação — `test` nunca é SEFAZ. */
  source: 'sefaz' | 'test';
  checkedAt: string;
}

export interface SefazAdapter {
  readonly name: string;
  /** `false` no provider de teste. Usado para bloquear produção. */
  readonly isReal: boolean;
  /**
   * `model` escolhe o HOST no RS — a NFC-e (65) tem serviços próprios, e a
   * sondagem da fila (GAP-PRD-020) pergunta ao host da nota que espera.
   * Ausente: o da NF-e, como sempre foi.
   */
  statusServico(input: {
    uf: string;
    environment: FiscalEnvironment;
    model?: string;
  }): Promise<ServiceStatus>;
  authorize(input: AuthorizeRequest): Promise<SefazResponse>;
  consult(input: ConsultRequest): Promise<SefazResponse>;
  cancel(input: {
    companyId: string;
    accessKey: string;
    /**
     * '55' NF-e, '65' NFC-e — no RS os hosts diferem (GAP-PRD-019). A chave
     * carrega o modelo e é ela quem manda; informado, precisa bater com ela.
     */
    model?: string;
    protocol: string;
    justification: string;
    uf: string;
    /** O ambiente em que a NOTA foi autorizada — é lá que o evento vale. */
    environment: FiscalEnvironment;
  }): Promise<SefazResponse>;
  voidNumberRange(input: {
    companyId: string;
    model: string;
    serie: number;
    from: number;
    to: number;
    /** O ano da faixa (AAAA), como o gestor pediu. Ausente: o corrente, no fuso do emitente. */
    year?: number;
    /** O CNPJ do EMITENTE — autor da inutilização, que nem sempre é o do certificado. */
    cnpj?: string;
    justification: string;
    uf: string;
    environment: FiscalEnvironment;
  }): Promise<SefazResponse>;
}

// ---------------------------------------------------------------- endpoints

export type SefazService = 'status' | 'authorize' | 'consult' | 'event' | 'void';

/**
 * Endereços dos web services.
 *
 * NÃO HÁ URL NACIONAL ÚNICA para NFC-e: cada UF publica os próprios endereços,
 * e alguns estados delegam a autorizadores diferentes. Este mapa começa VAZIO
 * de propósito — inventar uma URL faria a transmissão falhar de um jeito
 * difícil de diagnosticar, ou pior, acertar o ambiente errado.
 *
 * Preencher exige a tabela oficial de web services da SEFAZ para as UFs em que
 * o Grupo opera. Enquanto estiver vazio, `resolveEndpoint` recusa com uma
 * mensagem que diz exatamente o que falta.
 */
export const SEFAZ_ENDPOINTS: Record<
  string,
  Partial<Record<FiscalEnvironment, Partial<Record<SefazService, string>>>>
> = {
  // Exemplo do formato esperado (comentado — não é endereço configurado):
  // AP: {
  //   homologation: { status: 'https://.../NFeStatusServico4', ... },
  //   production:   { status: 'https://.../NFeStatusServico4', ... },
  // },
};

export function resolveEndpoint(input: {
  uf: string;
  environment: FiscalEnvironment;
  service: SefazService;
}): string {
  const uf = input.uf.toUpperCase();
  const url = SEFAZ_ENDPOINTS[uf]?.[input.environment]?.[input.service];
  if (!url) {
    throw new ApiError(
      'CORE_SEFAZ_ENDPOINT_NOT_CONFIGURED',
      `Endereço do serviço "${input.service}" não configurado para ${uf}/${input.environment}. `
        + 'Os endereços dos web services variam por UF e por autorizador; precisam ser '
        + 'preenchidos a partir da tabela oficial da SEFAZ antes da transmissão real.',
      501,
      { uf, environment: input.environment, service: input.service },
    );
  }
  return url;
}

// ------------------------------------------------------- seleção do adapter

/**
 * O PROCESSO roda como produção?
 *
 * Pelos DOIS nomes, como a trava das chaves do cofre em `loadEnv`:
 * `DEVORA_API_ENV=production` é deste projeto e só existe se alguém escrever;
 * `NODE_ENV=production` é o que hospedagem, container e gerenciador de
 * processo definem sozinhos. Olhar só o primeiro deixava o simulador vivo em
 * `NODE_ENV=production node dist/index.js` sem a outra variável.
 *
 * `NODE_ENV` é lido primeiro de propósito: responde sem acordar `loadEnv`.
 */
export function servidorEmProducao(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  return loadEnv().DEVORA_API_ENV === 'production';
}

/** Em produção — da operação, da nota ou do processo — só adapter real transmite. */
export function exigeAdapterReal(environment: FiscalEnvironment | string | null | undefined): boolean {
  return environment === 'production' || servidorEmProducao();
}

/**
 * O PORTÃO DE PRODUÇÃO, na forma que qualquer caminho pode chamar
 * (GAP-PRD-018).
 *
 * `selectAdapter` só barrava `useTestProvider`; o que chegava no slot `real`
 * passava sem pergunta — e o slot `real` recebia o SIMULADOR sempre que o
 * servidor não se declarava produção. Operação em produção + servidor em
 * development cancelava nota de produção com protocolo TEST-. A pergunta
 * certa não é "quem pediu o simulador", é "quem vai transmitir": em
 * produção, adapter que se declara de teste não transmite, venha de onde vier.
 */
export function assertAdapterPodeTransmitir(input: {
  adapter: SefazAdapter;
  environment: FiscalEnvironment | string | null | undefined;
}): void {
  if (input.adapter.isReal) return;
  if (!exigeAdapterReal(input.environment)) return;
  throw new ApiError(
    'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
    'O provider de teste não pode falar com a SEFAZ em produção — nota, cancelamento ou '
      + 'inutilização feitos por ele não existem para o fisco.',
    409,
  );
}

/**
 * Escolhe o adapter.
 *
 * O provider de TESTE nunca é selecionável em produção — e a checagem é aqui,
 * num ponto só, para não depender de disciplina em cada chamada. Um teste
 * cobra que produção jamais receba o adapter de teste.
 *
 * "Produção" é a da operação OU a do processo (GAP-PRD-018), e vale para os
 * dois slots: pedir o simulador é recusado, e o slot `real` que chega
 * ocupado por um adapter de teste também.
 */
export function selectAdapter(input: {
  environment: FiscalEnvironment;
  useTestProvider: boolean;
  real: SefazAdapter;
  test: SefazAdapter;
}): SefazAdapter {
  if (exigeAdapterReal(input.environment)) {
    if (input.useTestProvider) {
      throw new ApiError(
        'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
        'O provider de teste não pode ser usado em produção. Nota emitida por ele não existe '
          + 'para o fisco.',
        409,
      );
    }
    assertAdapterPodeTransmitir({ adapter: input.real, environment: 'production' });
    return input.real;
  }
  return input.useTestProvider ? input.test : input.real;
}
