/**
 * DANFE — representação impressa da NF-e (modelo 55).
 *
 * A FONTE É O XML DO DOCUMENTO, não a venda e nem o cadastro atual.
 *
 * Isso é deliberado e importa: o DANFE representa o que foi EFETIVAMENTE
 * enviado à SEFAZ. Se o endereço do emitente mudar amanhã, a segunda via de
 * uma nota de hoje precisa continuar mostrando o endereço de hoje — reler o
 * cadastro produziria um papel que não corresponde ao documento autorizado.
 *
 * Vale a mesma regra do DANFCE: só documento AUTORIZADO gera DANFE. Qualquer
 * outro estado sai como pré-visualização com tarja, porque um papel que parece
 * nota válida sem haver nota é o pior resultado possível.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getDocument } from './FiscalDocumentService.js';
import { isTestProtocol } from './SefazTestAdapter.js';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Valor do XML já vem como "1234.56"; a tela mostra no formato brasileiro. */
function brl(valor: string | null): string {
  const n = Number(valor ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00';
}

function formatKey(key: string | null): string {
  return key ? key.replace(/(\d{4})(?=\d)/g, '$1 ') : '—';
}

function formatDoc(doc: string): string {
  const d = doc.replace(/\D/g, '');
  if (d.length === 14) {
    return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  }
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return doc;
}

/** Extrai o conteúdo de uma tag, opcionalmente dentro de um bloco. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

/** O texto do XML volta a ser texto antes de ir para o HTML (senão `&amp;` dobra). */
function desescaparXml(valor: string): string {
  return valor
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function block(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : '';
}

interface ParsedParty {
  name: string;
  tradeName: string | null;
  document: string;
  ie: string | null;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  uf: string;
  zip: string | null;
}

function parseParty(xml: string, wrapper: 'emit' | 'dest'): ParsedParty {
  const b = block(xml, wrapper);
  const ender = block(b, wrapper === 'emit' ? 'enderEmit' : 'enderDest');
  return {
    name: tag(b, 'xNome') ?? '—',
    tradeName: tag(b, 'xFant'),
    document: tag(b, 'CNPJ') ?? tag(b, 'CPF') ?? '—',
    ie: tag(b, 'IE'),
    street: tag(ender, 'xLgr') ?? '',
    number: tag(ender, 'nro') ?? '',
    complement: tag(ender, 'xCpl'),
    district: tag(ender, 'xBairro') ?? '',
    city: tag(ender, 'xMun') ?? '',
    uf: tag(ender, 'UF') ?? '',
    zip: tag(ender, 'CEP'),
  };
}

interface ParsedItem {
  code: string;
  description: string;
  /** `infAdProd` do item — o chassi, o motor, o IMEI (GAP-PRD-026). */
  additionalInfo: string | null;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  total: string;
}

function parseItems(xml: string): ParsedItem[] {
  const itens: ParsedItem[] = [];
  const re = /<det nItem="\d+">([\s\S]*?)<\/det>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const prod = block(m[1], 'prod');
    itens.push({
      code: tag(prod, 'cProd') ?? '',
      description: tag(prod, 'xProd') ?? '',
      // Fora do `<prod>`: no leiaute o `infAdProd` é filho do `<det>`.
      additionalInfo: tag(m[1], 'infAdProd'),
      ncm: tag(prod, 'NCM') ?? '',
      cfop: tag(prod, 'CFOP') ?? '',
      unit: tag(prod, 'uCom') ?? '',
      quantity: tag(prod, 'qCom') ?? '0',
      unitPrice: tag(prod, 'vUnCom') ?? '0',
      total: tag(prod, 'vProd') ?? '0',
    });
  }
  return itens;
}

export interface DanfeOptions {
  allowUnauthorized?: boolean;
}

export function renderDanfe(
  companyId: string,
  documentId: string,
  options: DanfeOptions = {},
): string {
  ensureCoreSchema();

  const doc = getDocument(companyId, documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }
  if (doc.model !== '55') {
    throw new ApiError(
      'CORE_FISCAL_WRONG_MODEL',
      `DANFE é do modelo 55. Este documento é modelo ${doc.model}.`,
      409,
    );
  }

  const autorizado = doc.status === 'AUTHORIZED' && Boolean(doc.protocol);
  const cancelado = doc.status === 'CANCELLED';

  if (!autorizado && !cancelado && !options.allowUnauthorized) {
    throw new ApiError(
      'CORE_FISCAL_NOT_AUTHORIZED',
      `DANFE só existe para documento autorizado. Este está como ${doc.status}.`,
      409,
      { status: doc.status, cStat: doc.cStat, xMotivo: doc.xMotivo },
    );
  }

  const row = getConnection()
    .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
    .get(documentId) as { xml_original: string | null };
  const xml = row.xml_original ?? '';

  const emit = parseParty(xml, 'emit');
  const dest = parseParty(xml, 'dest');
  const itens = parseItems(xml);
  const total = block(xml, 'ICMSTot');
  const ide = block(xml, 'ide');
  const transp = block(xml, 'transp');
  const infAdic = tag(block(xml, 'infAdic'), 'infCpl');

  const deTeste = isTestProtocol(doc.protocol);
  const homologacao = doc.environment !== 'production';

  const tarjas: string[] = [];
  if (cancelado) tarjas.push('NF-e CANCELADA');
  if (!autorizado && !cancelado) {
    tarjas.push(
      `DOCUMENTO NÃO AUTORIZADO — situação: ${doc.status}`
      + (doc.xMotivo ? `<br>${esc(doc.xMotivo)}` : ''),
    );
  }
  if (deTeste) tarjas.push('AMBIENTE DE TESTE — NÃO É DOCUMENTO FISCAL HOMOLOGADO');
  else if (homologacao) tarjas.push('EMITIDA EM HOMOLOGAÇÃO — SEM VALOR FISCAL');

  const linhasItens = itens
    .map(
      (i, n) => `<tr>
      <td>${String(n + 1).padStart(3, '0')}</td>
      <td>${esc(i.code)}</td>
      <td class="desc">${esc(i.description)}${
        i.additionalInfo ? `<br><small>${esc(desescaparXml(i.additionalInfo))}</small>` : ''
      }</td>
      <td>${esc(i.ncm)}</td>
      <td>${esc(i.cfop)}</td>
      <td>${esc(i.unit)}</td>
      <td class="r">${Number(i.quantity).toLocaleString('pt-BR')}</td>
      <td class="r">${brl(i.unitPrice)}</td>
      <td class="r">${brl(i.total)}</td>
    </tr>`,
    )
    .join('\n');

  const carrier = block(transp, 'transporta');
  const carrierName = tag(carrier, 'xNome');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>DANFE ${doc.number}</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #000; margin: 0; }
  .tarja { border: 3px solid #000; padding: 4mm; margin-bottom: 3mm; text-align: center;
           font-weight: bold; font-size: 13px; text-transform: uppercase; }
  .caixa { border: 1px solid #000; padding: 2mm; margin-bottom: 2mm; }
  .titulo { font-size: 8px; text-transform: uppercase; color: #333; display: block; }
  .cabecalho { display: flex; gap: 3mm; align-items: stretch; }
  .cabecalho .emit { flex: 2; }
  .cabecalho .doc { flex: 1; text-align: center; }
  .doc .danfe { font-size: 16px; font-weight: bold; letter-spacing: 1px; }
  .chave { font-family: "Courier New", monospace; font-size: 11px; letter-spacing: .5px;
           text-align: center; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 1mm 1.5mm; font-size: 8px; }
  th { background: #eee; text-transform: uppercase; font-size: 7px; }
  .r { text-align: right; }
  .desc { text-align: left; }
  .totais td { font-size: 9px; }
  .totais .grande { font-size: 12px; font-weight: bold; }
  h2 { font-size: 9px; text-transform: uppercase; margin: 3mm 0 1mm; border-bottom: 1px solid #000; }
  @media screen { body { max-width: 210mm; margin: 12px auto; padding: 10mm; background: #fff;
    box-shadow: 0 0 0 1px #ccc; } }
</style></head><body>

${tarjas.map((t) => `<div class="tarja">${t}</div>`).join('\n')}

<div class="cabecalho">
  <div class="caixa emit">
    <span class="titulo">Emitente</span>
    <strong>${esc(emit.name)}</strong>${emit.tradeName ? ` (${esc(emit.tradeName)})` : ''}<br>
    ${esc(emit.street)}, ${esc(emit.number)}${emit.complement ? ` — ${esc(emit.complement)}` : ''}<br>
    ${esc(emit.district)} — ${esc(emit.city)}/${esc(emit.uf)}${emit.zip ? ` — CEP ${esc(emit.zip)}` : ''}<br>
    CNPJ ${esc(formatDoc(emit.document))} — IE ${esc(emit.ie ?? '—')}
  </div>
  <div class="caixa doc">
    <span class="danfe">DANFE</span><br>
    <span class="titulo">Documento Auxiliar da Nota Fiscal Eletrônica</span>
    <strong>ENTRADA / SAÍDA: 1 — SAÍDA</strong><br>
    Nº <strong>${doc.number}</strong><br>
    Série <strong>${doc.serie}</strong><br>
    Modelo <strong>${esc(doc.model)}</strong>
  </div>
</div>

<div class="caixa">
  <span class="titulo">Chave de acesso</span>
  <div class="chave">${formatKey(doc.accessKey)}</div>
</div>

<div class="caixa">
  <span class="titulo">Natureza da operação</span>
  ${esc(tag(ide, 'natOp') ?? '—')}
  &nbsp;|&nbsp; <span class="titulo" style="display:inline">Emissão</span>
  ${esc((tag(ide, 'dhEmi') ?? '').slice(0, 10).split('-').reverse().join('/'))}
  &nbsp;|&nbsp; <span class="titulo" style="display:inline">Ambiente</span>
  <strong>${homologacao ? 'HOMOLOGAÇÃO' : 'PRODUÇÃO'}</strong>
  ${
    doc.protocol
      ? `&nbsp;|&nbsp; <span class="titulo" style="display:inline">Protocolo</span> <strong>${esc(doc.protocol)}</strong>`
      : '&nbsp;|&nbsp; <strong>SEM PROTOCOLO DE AUTORIZAÇÃO</strong>'
  }
</div>

<div class="caixa">
  <span class="titulo">Destinatário</span>
  <strong>${esc(dest.name)}</strong> — ${esc(formatDoc(dest.document))}
  ${dest.ie ? ` — IE ${esc(dest.ie)}` : ''}<br>
  ${esc(dest.street)}, ${esc(dest.number)}${dest.complement ? ` — ${esc(dest.complement)}` : ''}<br>
  ${esc(dest.district)} — ${esc(dest.city)}/${esc(dest.uf)}${dest.zip ? ` — CEP ${esc(dest.zip)}` : ''}
</div>

<h2>Produtos e serviços</h2>
<table>
  <thead>
    <tr>
      <th>#</th><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th>
      <th>Un.</th><th>Qtd.</th><th>V. unit.</th><th>V. total</th>
    </tr>
  </thead>
  <tbody>
    ${linhasItens || '<tr><td colspan="9">Sem itens no documento.</td></tr>'}
  </tbody>
</table>

<h2>Cálculo do total</h2>
<table class="totais">
  <tr>
    <td><span class="titulo">Valor dos produtos</span>${brl(tag(total, 'vProd'))}</td>
    <td><span class="titulo">Desconto</span>${brl(tag(total, 'vDesc'))}</td>
    <td><span class="titulo">Frete</span>${brl(tag(total, 'vFrete'))}</td>
    <td class="grande"><span class="titulo">Total da NF-e</span>R$ ${brl(tag(total, 'vNF'))}</td>
  </tr>
</table>

<h2>Transporte</h2>
<div class="caixa">
  <span class="titulo">Modalidade do frete</span>
  ${esc(tag(transp, 'modFrete') ?? '9')}
  ${carrierName ? `&nbsp;|&nbsp; <strong>${esc(carrierName)}</strong>` : ' — sem transportadora'}
</div>

${
  infAdic
    ? `<h2>Informações complementares</h2>
<div class="caixa">${esc(infAdic)}</div>`
    : ''
}

<div class="caixa" style="text-align:center; font-size:8px;">
  GRUPO SAMPAIO · Gestão Empresarial
  ${deTeste ? ' — DOCUMENTO GERADO POR PROVIDER DE TESTE' : ''}
</div>
</body></html>`;
}
