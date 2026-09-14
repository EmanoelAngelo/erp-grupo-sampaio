/**
 * O ARQUIVO QUE O CONTADOR ARQUIVA: `nfeProc`.
 *
 * ## Que arquivo é esse, e por que não serve entregar o XML da nota
 *
 * Uma NF-e vira dois papéis. O primeiro é a nota assinada — o que a empresa
 * mandou. O segundo é o protocolo — o que a SEFAZ respondeu, com o número de
 * autorização, a data e o motivo. Sozinha, a nota assinada NÃO prova nada: ela
 * é só um documento que alguém escreveu e assinou. Quem guarda documento
 * fiscal precisa provar que ele foi AUTORIZADO, e é o `nfeProc` — nota +
 * protocolo, num arquivo só — que faz essa prova. É o formato que o software
 * do contador espera importar e o que a fiscalização pede.
 *
 * Até esta rodada o sistema tinha as duas metades e nenhuma costura: o XML
 * assinado numa coluna, o protocolo em outra. Quem baixasse "o XML da nota"
 * levava metade do documento.
 *
 * ## DE ONDE VEM CADA METADE — e a armadilha que este arquivo existe para
 * ## desarmar
 *
 * A `<NFe>` sai de `xml_signed`. NUNCA de `xml_authorized`, e isto não é
 * preferência de estilo:
 *
 *   `SefazAdapter.sanitizeResponse` troca o conteúdo de `<SignatureValue>` por
 *   "[removido]" antes de o retorno da SEFAZ ser guardado — de propósito, para
 *   que certificado e segredo do QR não parem no banco nem nos logs. E é
 *   `xml_authorized` que recebe essa resposta já higienizada
 *   (`FiscalQueueService`, na transição para AUTHORIZED).
 *
 *   Algumas respostas trazem a nota inteira embutida. Compor o `nfeProc` a
 *   partir dali produziria um arquivo com cara de perfeito — abre no leitor,
 *   tem os dois elementos, tem o protocolo — e com a assinatura MUTILADA.
 *   Nenhum validador aceitaria, e a descoberta viria meses depois, na
 *   fiscalização, sobre um arquivo que ninguém mais tem como refazer.
 *
 * O `<protNFe>` sai do retorno da SEFAZ, que é o único lugar onde ele pode
 * sair: o protocolo é o que o FISCO disse, e não algo que este sistema saiba
 * escrever. `sanitizeResponse` não toca em `<infProt>` — nada ali é segredo.
 *
 * ## POR QUE ELE DEVOLVE `null` EM VEZ DE COMPLETAR O QUE FALTA
 *
 * A tentação óbvia seria montar o `<protNFe>` com as colunas soltas que o
 * documento já tem (`protocol`, `c_stat`, `x_motivo`, `authorized_at`). Seria
 * FABRICAR PROVA: faltaria o `digVal`, que é o resumo criptográfico com que a
 * SEFAZ atesta o que autorizou, e o resto sairia da nossa palavra em vez da
 * dela. Um protocolo escrito por quem emitiu a nota não é protocolo.
 *
 * Então: metade faltando, resposta `null`. Quem chama decide o que fazer com o
 * buraco — o pacote do contador o registra no manifesto em vez de escondê-lo.
 *
 * ## Regex, e não parser
 *
 * O trabalho aqui é recortar dois elementos e concatenar. Um parser
 * reserializaria, e reserializar é exatamente o que quebra a assinatura (a
 * mesma razão pela qual o XML da nota de entrada é gravado verbatim). O que se
 * corta são bytes, e eles chegam do outro lado idênticos.
 *
 * As expressões toleram PREFIXO DE NAMESPACE (`<ns2:protNFe>`) porque o
 * retorno vem de fora: cada autorizador serializa o envelope do seu jeito, e
 * um recorte que só conhece `<protNFe>` devolveria `null` para uma resposta
 * perfeitamente válida — o pior tipo de falha, porque parece ausência de dado.
 */

/** O namespace da NF-e. Um só, e é o que o `nfeProc` declara. */
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

/** A versão do layout. `4.00` é a vigente, e é a que este projeto gera. */
const VERSAO_LAYOUT = '4.00';

/**
 * Recorta um elemento pelo nome, com ou sem prefixo de namespace.
 *
 * `<(?:\w+:)?NOME\b` é o que impede `NFe` de casar dentro de `infNFe`: a
 * âncora exige que o nome comece logo depois do `<` ou do prefixo.
 */
function recortarElemento(xml: string, nome: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${nome}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${nome}>`);
  const achado = re.exec(xml);
  return achado ? achado[0] : null;
}

/** O conteúdo de uma tag simples, para conferir que o protocolo tem número. */
function conteudoDaTag(xml: string, nome: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${nome}\\b[^>]*>([^<]*)</(?:\\w+:)?${nome}>`);
  const achado = re.exec(xml);
  const valor = achado?.[1]?.trim();
  return valor ? valor : null;
}

export interface EntradaProcNfe {
  /**
   * O XML assinado da nota — a coluna `xml_signed`. É daqui que sai a `<NFe>`,
   * com a assinatura intacta.
   */
  xmlAssinado: string | null | undefined;
  /**
   * A resposta da SEFAZ que contém o `<protNFe>` — a coluna `xml_authorized`.
   * Pode ser o envelope inteiro ou só o elemento; os dois recortam igual.
   */
  protocolo: string | null | undefined;
}

/**
 * Costura a nota assinada com o protocolo de autorização.
 *
 * Devolve `null` — e não um arquivo parcial — quando falta a nota, falta o
 * protocolo, ou o protocolo veio sem `nProt`. O último caso é o mais
 * traiçoeiro: uma REJEIÇÃO também chega dentro de um `<protNFe>`, com `cStat`
 * de recusa e sem número nenhum. Aceitá-la produziria um "documento
 * autorizado" para uma nota que a SEFAZ não autorizou.
 */
export function montarProcNfe(input: EntradaProcNfe): string | null {
  const assinado = input.xmlAssinado ?? '';
  const resposta = input.protocolo ?? '';
  if (!assinado.trim() || !resposta.trim()) return null;

  const nfe = recortarElemento(assinado, 'NFe');
  if (!nfe) return null;

  const prot = recortarElemento(resposta, 'protNFe');
  if (!prot) return null;

  // Sem número de protocolo não há autorização — ver o cabeçalho.
  if (!conteudoDaTag(prot, 'nProt')) return null;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<nfeProc xmlns="${NS_NFE}" versao="${VERSAO_LAYOUT}">\n`
    + `${nfe}\n`
    + `${prot}\n`
    + '</nfeProc>'
  );
}

// ---------------------------------------------------------------------------
// procEventoNFe — o mesmo raciocínio, para o EVENTO (GAP-V32)
// ---------------------------------------------------------------------------

/** A versão do leiaute de evento. `1.00` é a vigente para cancelamento e CC-e. */
const VERSAO_EVENTO = '1.00';

export interface EntradaProcEvento {
  /**
   * O evento ASSINADO que foi transmitido — o `envEvento` (ou o `<evento>`
   * solto) que o adapter real montou e assinou. É daqui que sai o `<evento>`,
   * com a assinatura intacta.
   */
  eventoAssinado: string | null | undefined;
  /**
   * O retorno ÍNTEGRO da SEFAZ, de onde sai o `<retEvento>`. Íntegro mesmo:
   * o retorno que passou por `sanitizeResponse` tem a assinatura mutilada, e
   * é exatamente esse arquivo-que-parece-certo que esta função existe para
   * não produzir.
   */
  retorno: string | null | undefined;
}

/**
 * Costura o evento assinado com a resposta da SEFAZ — o procEventoNFe.
 *
 * As recusas espelham `montarProcNfe`, e cada uma evita fabricar prova:
 *
 *   - sem `<evento>` ou sem `<retEvento>`, `null`: metade de documento com
 *     nome de documento inteiro é o defeito que o LEIA-ME do pacote passou
 *     rodadas explicando;
 *   - `<retEvento>` sem `nProt`, `null`: rejeição também chega num retEvento,
 *     com cStat de recusa e sem protocolo — aceitá-la produziria um "evento
 *     homologado" para um evento que a SEFAZ recusou;
 *   - `<evento>` sem `<Signature`, `null`: um evento sem assinatura não prova
 *     autoria, e o único motivo de esta função existir é a prova. O provider
 *     de teste cai aqui — de propósito: ensaio não vira arquivo probatório.
 */
export function montarProcEventoNfe(input: EntradaProcEvento): string | null {
  const assinado = input.eventoAssinado ?? '';
  const resposta = input.retorno ?? '';
  if (!assinado.trim() || !resposta.trim()) return null;

  const evento = recortarElemento(assinado, 'evento');
  if (!evento || !/<(?:\w+:)?Signature\b/.test(evento)) return null;

  const retEvento = recortarElemento(resposta, 'retEvento');
  if (!retEvento) return null;
  if (!conteudoDaTag(retEvento, 'nProt')) return null;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<procEventoNFe xmlns="${NS_NFE}" versao="${VERSAO_EVENTO}">\n`
    + `${evento}\n`
    + `${retEvento}\n`
    + '</procEventoNFe>'
  );
}

// ---------------------------------------------------------------------------
// procInutNFe — o mesmo raciocínio, para a INUTILIZAÇÃO (resíduo do GAP-V32)
// ---------------------------------------------------------------------------

export interface EntradaProcInut {
  /**
   * O `inutNFe` ASSINADO que foi transmitido. É daqui que sai o elemento com a
   * assinatura intacta — o adapter real é o único lugar que o segura, e ele o
   * jogava fora na linha seguinte ao envio.
   */
  inutAssinado: string | null | undefined;
  /**
   * O retorno ÍNTEGRO da SEFAZ, de onde sai o `retInutNFe`. Íntegro mesmo: o
   * retorno que passou por `sanitizeResponse` tem a assinatura mutilada, e é
   * exatamente esse arquivo-que-parece-certo que esta função existe para não
   * produzir.
   */
  retorno: string | null | undefined;
}

/**
 * Costura o pedido de inutilização assinado com a resposta — o procInutNFe.
 *
 * A INUTILIZAÇÃO FICOU DE FORA DA RODADA DO GAP-V32, e o buraco é do mesmo
 * tamanho do que ela consertou: cancelamento e carta de correção passaram a
 * guardar o procEventoNFe íntegro, enquanto a inutilização continuou entregando
 * ao contador um retorno com a assinatura trocada por "[removido]".
 *
 * Ela é, aliás, o documento em que a prova mais importa: existe PARA justificar
 * números que nunca viraram nota. Sem o arquivo íntegro, a justificativa do
 * buraco na numeração depende de o fisco consultar o próprio sistema.
 *
 * As recusas espelham `montarProcEventoNfe`, e cada uma evita fabricar prova:
 *
 *   - sem `<inutNFe>` ou sem `<retInutNFe>`, `null`: metade de documento com
 *     nome de documento inteiro é o defeito que o LEIA-ME do pacote passou
 *     rodadas explicando;
 *   - `<retInutNFe>` sem `nProt`, `null`: a recusa também chega num retInutNFe,
 *     com cStat de rejeição e sem protocolo — aceitá-la produziria um
 *     "arquivamento" de um ato que a SEFAZ negou, que é pior que não ter
 *     arquivo nenhum;
 *   - `<inutNFe>` sem `<Signature`, `null`: sem assinatura não há autoria, e o
 *     único motivo de esta função existir é a prova. O provider de teste cai
 *     aqui, de propósito.
 */
export function montarProcInutNfe(input: EntradaProcInut): string | null {
  const assinado = input.inutAssinado ?? '';
  const resposta = input.retorno ?? '';
  if (!assinado.trim() || !resposta.trim()) return null;

  const inut = recortarElemento(assinado, 'inutNFe');
  if (!inut || !/<(?:\w+:)?Signature\b/.test(inut)) return null;

  const retInut = recortarElemento(resposta, 'retInutNFe');
  if (!retInut) return null;
  if (!conteudoDaTag(retInut, 'nProt')) return null;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<procInutNFe xmlns="${NS_NFE}" versao="${VERSAO_LAYOUT}">\n`
    + `${inut}\n`
    + `${retInut}\n`
    + '</procInutNFe>'
  );
}
