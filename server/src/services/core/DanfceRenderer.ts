/**
 * DANFCE — a representação impressa da NFC-e.
 *
 * A FONTE É O DOCUMENTO FISCAL, nunca a venda. Desenhar o cupom a partir da
 * `core_sales` produziria um papel que PARECE nota fiscal sem haver nota: os
 * valores bateriam, a chave não existiria, e o cliente sairia da loja
 * convencido de que levou documento.
 *
 * DUAS REGRAS DE HONESTIDADE VISUAL
 *
 * 1. Só documento AUTORIZADO gera DANFCE. Qualquer outro estado produz um
 *    PRÉ-VISUALIZAÇÃO com tarja: quem olha de longe precisa distinguir.
 * 2. Homologação e provider de teste são declarados na tarja. Cupom de
 *    homologação não tem valor fiscal, e quem imprime precisa saber disso
 *    antes de entregar ao cliente.
 */
import { qrSvg as desenharSvgDoQr } from './Qr.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { getDocument, type FiscalDocument } from './FiscalDocumentService.js';
import { loadSaleForNfce, type NfceSale } from './FiscalXmlNfce.js';
import { infAdProdDasUnidades } from './IdentidadeDaUnidadeFiscal.js';
import { isTestProtocol } from './SefazTestAdapter.js';
import { getConnection } from '../../db/sqlite.js';
import { emitidaOffline } from './FiscalContingenciaOffline.js';
import { qrCodeDoXml } from './NfceQrOffline.js';
import { dataHoraDaLoja, larguraDaBobina } from './PapelDaLoja.js';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

/** Chave em blocos de 4, como no cupom — é assim que alguém consegue digitar. */
function formatKey(key: string): string {
  return key.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/*
  O QR do cupom sai do gerador único (`Qr.ts`).

  Este arquivo tinha a TERCEIRA cópia do mesmo desenho — as outras estavam em
  `PrintRenderer` e no navegador. Todas com a mesma zona de silêncio e o mesmo
  nível de correção, escritas três vezes: bastava uma delas mudar para o cupom
  fiscal e a plaquinha discordarem sobre como se desenha um QR.

  O `px: 140` preserva o tamanho que o cupom já imprimia.
*/
function qrSvg(conteudo: string): string {
  return desenharSvgDoQr(conteudo, { px: 140 });
}

const PAGAMENTO_ROTULO: Record<string, string> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  debito: 'Cartão de débito',
  credito: 'Cartão de crédito',
  cartao_debito: 'Cartão de débito',
  cartao_credito: 'Cartão de crédito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  // O vale do cliente entra no `pag` da nota como tPag 05 (F-04), e o papel
  // diz o que ele é — "credito_loja" cru não diz nada ao consumidor.
  credito_loja: 'Crédito de loja (vale)',
  crediario: 'Crediário',
};

/** O texto de um campo do XML volta a ser texto: `&amp;` no XML é `&` no papel. */
function desescaparXml(valor: string): string {
  return valor
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** O primeiro `<tag>valor</tag>` do trecho, já como texto. */
function campoDoXml(xml: string | null, tag: string): string | null {
  if (!xml) return null;
  const achado = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return achado ? desescaparXml(achado[1]) : null;
}

function cpfLegivel(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/**
 * Conteúdo do QR.
 *
 * O QR fiscal real é assinado com o CSC, que não está configurado. Gerar um
 * QR "parecido" seria pior que não gerar: ele levaria o consumidor a uma
 * consulta que falha, e ainda daria aparência de documento válido.
 *
 * Sem CSC, o QR carrega apenas a CHAVE — suficiente para conferência interna e
 * inequivocamente identificado como não fiscal na tarja.
 */
function qrContent(doc: FiscalDocument, temCsc: boolean): { conteudo: string; fiscal: boolean } {
  if (!temCsc) {
    return { conteudo: `CHAVE:${doc.accessKey}`, fiscal: false };
  }
  // Caminho reservado para quando o CSC existir: a URL de consulta da UF com
  // os parâmetros e o hash. Não é montado aqui porque depende do CSC real e
  // da URL da UF, que também não está configurada.
  return { conteudo: `CHAVE:${doc.accessKey}`, fiscal: false };
}

export interface DanfceOptions {
  /** Permite o preview técnico de documento ainda não autorizado. */
  allowUnauthorized?: boolean;
  /** Largura da bobina da impressora que recebe o papel (58 ou 80 mm) — F-07. */
  larguraMm?: number | null;
}

/**
 * Monta o DANFCE (ou a pré-visualização, quando não autorizado).
 *
 * Documento não autorizado NÃO é recusado em silêncio: quem está diagnosticando
 * uma rejeição precisa ver o papel. Mas ele sai marcado, e a marcação é a
 * primeira coisa da página.
 */
export function renderDanfce(
  companyId: string,
  documentId: string,
  options: DanfceOptions = {},
): string {
  ensureCoreSchema();

  const doc = getDocument(companyId, documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }

  const autorizado = doc.status === 'AUTHORIZED' && Boolean(doc.protocol);
  /*
    A NFC-e EMITIDA EM CONTINGÊNCIA OFF-LINE (GAP-PRD-098) é entregue ao
    cliente ANTES da autorização — é para isso que a modalidade existe. O
    DANFCE dela sai sem pedir prévia, com os dizeres do Manual do DANFE NFC-e:
    "EMITIDA EM CONTINGÊNCIA" e, enquanto a SEFAZ não autorizar, "Pendente de
    autorização".
  */
  const offline = emitidaOffline(doc.accessKey);
  const offlinePendente = offline && ['CONTINGENCY', 'QUEUED', 'SENDING'].includes(doc.status);
  // Cupom de nota cancelada continua existindo, e sai com a tarja — igual ao
  // DANFE. Recusar aqui obrigaria a pedir "prévia técnica" de um documento que
  // foi real, e a prévia diz "não autorizado", que é outra coisa.
  const cancelado = doc.status === 'CANCELLED';
  if (!autorizado && !cancelado && !offlinePendente && !options.allowUnauthorized) {
    throw new ApiError(
      'CORE_FISCAL_NOT_AUTHORIZED',
      `DANFCE só existe para documento autorizado. Este está como ${doc.status}.`,
      409,
      { status: doc.status, cStat: doc.cStat, xMotivo: doc.xMotivo },
    );
  }

  const config = getFiscalConfig(companyId);
  let sale: NfceSale | null;
  try {
    /*
      A NOTA CANCELADA REIMPRIME COM OS ITENS E O TOTAL DELA (F-15).

      `loadSaleForNfce` recusa venda que não esteja concluída — certo para
      EMITIR, errado para REPRESENTAR. A venda cancelada depois da emissão caía
      no catch, e o DANFCE saía "NFC-e CANCELADA... Itens indisponíveis / TOTAL
      0,00": um papel que não representava a nota que existiu.
    */
    sale = doc.saleId ? loadSaleForNfce(companyId, doc.saleId, { aceitarCancelada: true }) : null;
  } catch {
    // Venda que não existe mais: o cupom ainda precisa sair, com o que o
    // documento fiscal guarda (o total sai do vNF do XML, mais abaixo).
    sale = null;
  }

  const deTeste = isTestProtocol(doc.protocol);
  const homologacao = doc.environment !== 'production';

  // A tarja vem ANTES de tudo. Quem entrega o papel ao cliente precisa ver a
  // ressalva sem procurar.
  const tarjas: string[] = [];
  if (cancelado) tarjas.push('NFC-e CANCELADA');
  if (offline) {
    tarjas.push(
      offlinePendente ? 'EMITIDA EM CONTINGÊNCIA<br>Pendente de autorização' : 'EMITIDA EM CONTINGÊNCIA',
    );
  }
  if (!autorizado && !cancelado && !offlinePendente) {
    tarjas.push(
      `DOCUMENTO NÃO AUTORIZADO — situação: ${doc.status}`
      + (doc.xMotivo ? `<br>${esc(doc.xMotivo)}` : ''),
    );
  }
  if (deTeste) {
    tarjas.push('AMBIENTE DE TESTE — NÃO É DOCUMENTO FISCAL HOMOLOGADO');
  } else if (homologacao) {
    tarjas.push('EMITIDA EM HOMOLOGAÇÃO — SEM VALOR FISCAL');
  }

  const tarjaHtml = tarjas
    .map(
      (t) =>
        `<div class="tarja">${t}</div>`,
    )
    .join('');

  /*
    A ARITMÉTICA IMPRESSA FECHA CONSIGO MESMA (auditoria, fase 7).

    O corpo imprimia cada item pelo totalCents — que já é LÍQUIDO do desconto
    de linha — e a linha "Descontos" logo abaixo somava só os descontos de
    item. Quem conferia lia 90,00 − 10,00 = 80,00 num cupom cujo TOTAL era
    85,00: o desconto de item saía subtraído DUAS vezes aos olhos do cliente,
    e o desconto de rodapé sumia.

    O XML da mesma nota sempre fez a conta certa: vProd bruto, vDesc inteiro
    (linhas + rodapé), vOutro o acréscimo, e vProd − vDesc + vOutro = vNF é a
    igualdade que a SEFAZ confere. O papel representa esse documento, então
    imprime as MESMAS parcelas: item bruto no corpo (totalCents +
    discountCents, os centavos que o XML chama de vProd), o desconto inteiro
    numa linha só, e o acréscimo quando houver.
  */
  const itens = (sale?.items ?? [])
    .map(
      (i, n) => `<tr>
        <td>${String(n + 1).padStart(3, '0')}</td>
        <td>${esc(i.description)}${
          // O mesmo texto do `infAdProd` do XML (GAP-PRD-026): o cliente leva
          // no papel qual moto, qual celular.
          infAdProdDasUnidades(i.unidades) ? `<br><small>${esc(infAdProdDasUnidades(i.unidades)!)}</small>` : ''
        }</td>
        <td class="r">${i.quantity.toLocaleString('pt-BR')} ${esc(i.unit ?? 'UN')}</td>
        <td class="r">${money(i.unitPriceCents)}</td>
        <td class="r">${money(i.totalCents + i.discountCents)}</td>
      </tr>`,
    )
    .join('');

  const pagamentos = (sale?.payments ?? [])
    .map(
      (p) => `<tr><td colspan="4">${esc(PAGAMENTO_ROTULO[p.method] ?? p.method)}</td>
        <td class="r">${money(p.amountCents)}</td></tr>`,
    )
    .join('');

  // O desconto INTEIRO da venda, como o vDesc do XML: linhas + rodapé.
  const desconto =
    (sale?.items ?? []).reduce((s, i) => s + i.discountCents, 0) + (sale?.discountCents ?? 0);
  // E o acréscimo, como o vOutro — sem ele, venda com juros não fecharia.
  const acrescimo = sale?.surchargeCents ?? 0;
  /*
    O QR É O DO XML ASSINADO — a mesma URL que a SEFAZ recebe no
    `infNFeSupl` (online, ou a versão off-line com o digVal). Sem XML assinado
    com QR, sobra a conferência interna pela chave, dita como tal.
  */
  const xmls = getConnection()
    .prepare(
      'SELECT xml_signed, xml_original, xml_authorized FROM core_fiscal_documents WHERE id = ? AND company_id = ?',
    )
    .get(doc.id, companyId) as
    | { xml_signed: string | null; xml_original: string | null; xml_authorized: string | null }
    | undefined;
  const doXml = qrCodeDoXml(xmls?.xml_signed);
  const { conteudo: qrTexto, fiscal: qrFiscal } = doXml
    ? { conteudo: doXml, fiscal: true }
    : qrContent(doc, false);

  /*
    O QUE O DANFCE LÊ DA PRÓPRIA NOTA (auditoria do cupom, F-15).

    O papel imprimia modelo, série e número, e a data do PROTOCOLO — nada da
    EMISSÃO. Em contingência off-line, que é quando o papel sai antes da
    autorização, nenhuma data saía. Não havia a linha do consumidor (o CPF, ou
    "CONSUMIDOR NÃO IDENTIFICADO") nem o endereço de consulta da UF. As três
    coisas estão no XML da nota — `dhEmi`, `dest`, `urlChave` —, que é a fonte
    deste papel. Sem XML legível, a emissão cai para `issued_at` e o
    consumidor para o cadastro da venda.
  */
  const xmlDaNota =
    [xmls?.xml_authorized, xmls?.xml_signed, xmls?.xml_original].find(
      (x): x is string => Boolean(x && x.includes('<infNFe')),
    ) ?? null;
  const uf = config.uf ?? null;
  const emitidaEm = dataHoraDaLoja(campoDoXml(xmlDaNota, 'dhEmi') ?? doc.issuedAt, uf);
  const trechoDoDestinatario = xmlDaNota ? (/<dest>([\s\S]*?)<\/dest>/.exec(xmlDaNota)?.[1] ?? null) : null;
  const documentoDoConsumidor = xmlDaNota
    ? campoDoXml(trechoDoDestinatario, 'CPF')
    : (() => {
        const d = String(sale?.customerDocument ?? '').replace(/\D/g, '');
        return d.length === 11 ? d : null;
      })();
  const nomeDoConsumidor = xmlDaNota
    ? campoDoXml(trechoDoDestinatario, 'xNome')
    : documentoDoConsumidor
      ? (sale?.customerName ?? null)
      : null;
  const consumidor = documentoDoConsumidor
    ? `CONSUMIDOR — CPF ${cpfLegivel(documentoDoConsumidor)}${nomeDoConsumidor ? ` — ${esc(nomeDoConsumidor)}` : ''}`
    : 'CONSUMIDOR NÃO IDENTIFICADO';
  const urlDeConsulta = campoDoXml(xmlDaNota, 'urlChave');
  // Venda que não pôde ser lida: o TOTAL é o da nota, e não zero.
  const vNfDoXml = Number(campoDoXml(xmlDaNota, 'vNF'));
  const totalCents = sale?.totalCents ?? (Number.isFinite(vNfDoXml) ? Math.round(vNfDoXml * 100) : 0);

  const largura = larguraDaBobina(options.larguraMm);
  const estreita = largura === 58;
  // 58 mm imprime ~48 mm centrados (384 pontos): margem de 5 mm, corpo de 48 mm
  // — com 2 mm o corpo passava da cabeça térmica e a coluna dos valores cortava.
  const margem = estreita ? 5 : 3;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>DANFCE ${doc.number}</title>
<style>
  @page { size: ${largura}mm auto; margin: ${margem}mm; }
  * { box-sizing: border-box; }
  body { width: ${largura - 2 * margem}mm; margin: 0; font-family: "Courier New", monospace;
         font-size: ${estreita ? '9px' : '11px'}; line-height: 1.4; color: #000; }
  h1 { font-size: 12px; margin: 0 0 1mm; text-align: center; }
  .sub { text-align: center; font-size: 10px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: .5mm 0; vertical-align: top; }
  .r { text-align: right; }
  .b { font-weight: bold; }
  .total { font-size: 13px; font-weight: bold; }
  .chave { word-break: break-all; text-align: center; font-size: 10px; }
  .qr { text-align: center; margin: 2mm 0; }
  .tarja { border: 2px solid #000; padding: 2mm; margin-bottom: 2mm; text-align: center;
           font-weight: bold; font-size: 11px; text-transform: uppercase; }
  .rodape { text-align: center; font-size: 9px; margin-top: 2mm; }
  @media screen { body { margin: 12px auto; padding: 8px; box-shadow: 0 0 0 1px #ccc; background: #fff; } }
</style></head><body>
${tarjaHtml}
<h1>${esc(config.legalName ?? 'EMITENTE NÃO CONFIGURADO')}</h1>
<div class="sub">
  CNPJ ${esc(config.cnpj ?? '—')}<br>
  ${esc([config.street, config.number, config.district].filter(Boolean).join(', '))}<br>
  ${esc([config.cityName, config.uf].filter(Boolean).join(' / '))}
</div>
<hr>
<div class="sub b">DOCUMENTO AUXILIAR DA NOTA FISCAL DE CONSUMIDOR ELETRÔNICA</div>
<hr>
<table>
  <tr class="b"><td>#</td><td>DESCRIÇÃO</td><td class="r">QTD</td><td class="r">UNIT</td><td class="r">TOTAL</td></tr>
  ${itens || '<tr><td colspan="5">Itens indisponíveis para este documento.</td></tr>'}
</table>
<hr>
<table>
  ${desconto > 0 ? `<tr><td colspan="4">Descontos</td><td class="r">-${money(desconto)}</td></tr>` : ''}
  ${acrescimo > 0 ? `<tr><td colspan="4">Acréscimo</td><td class="r">+${money(acrescimo)}</td></tr>` : ''}
  <tr class="total"><td colspan="4">TOTAL</td><td class="r">${money(totalCents)}</td></tr>
</table>
<hr>
<table>
  <tr class="b"><td colspan="5">FORMA DE PAGAMENTO</td></tr>
  ${pagamentos || '<tr><td colspan="5">—</td></tr>'}
  ${sale && sale.changeCents > 0 ? `<tr><td colspan="4">Troco</td><td class="r">${money(sale.changeCents)}</td></tr>` : ''}
</table>
<hr>
<div class="sub b">${consumidor}</div>
<hr>
<div class="sub">
  Modelo ${esc(doc.model)} · Série ${doc.serie} · Número ${doc.number}<br>
  ${emitidaEm ? `Emissão: ${esc(emitidaEm)}<br>` : ''}
  Ambiente: ${homologacao ? 'HOMOLOGAÇÃO' : 'PRODUÇÃO'}
</div>
<div class="chave">
  ${doc.accessKey ? formatKey(doc.accessKey) : 'CHAVE NÃO GERADA'}
</div>
${
  doc.protocol
    ? `<div class="sub">Protocolo de autorização: ${esc(doc.protocol)}<br>
       ${doc.authorizedAt ? esc(dataHoraDaLoja(doc.authorizedAt, uf)) : ''}</div>`
    : '<div class="sub b">SEM PROTOCOLO DE AUTORIZAÇÃO</div>'
}
${doc.accessKey ? `<div class="qr">${qrSvg(qrTexto)}</div>` : ''}
<div class="rodape">
  ${
    qrFiscal
      ? urlDeConsulta
        ? `Consulte pela chave de acesso em<br>${esc(urlDeConsulta)}`
        : 'Consulte pela chave de acesso no site da SEFAZ.'
      : 'QR de conferência interna — o QR fiscal exige CSC configurado.'
  }
  <br>GRUPO SAMPAIO · Gestão Empresarial
</div>
</body></html>`;
}
