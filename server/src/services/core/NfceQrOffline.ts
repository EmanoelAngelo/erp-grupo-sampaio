/**
 * O QR CODE DA NFC-e EMITIDA EM CONTINGÊNCIA OFF-LINE — GAP-PRD-098.
 *
 * A versão 2 do QR tem dois formatos, e o XSD oficial (PL_010b, `qrCode`)
 * aceita cada um só com o `tpEmis` dele:
 *
 *   ONLINE : chNFe|2|tpAmb|cIdToken|cHashQRCode
 *   OFFLINE: chNFe|2|tpAmb|diaEmi|vNF|digVal|cIdToken|cHashQRCode
 *
 * No off-line o consumidor sai com o cupom ANTES de a SEFAZ conhecer a nota,
 * e o QR carrega o que permite conferir depois: o dia da emissão (dois
 * dígitos do `dhEmi`), o valor total e o `DigestValue` da assinatura em
 * hexadecimal (os 28 caracteres base64, byte a byte: 56 dígitos hex). O hash é
 * o SHA-1 das sete partes concatenadas com o CSC — como no online, o portal
 * refaz a conta com o CSC que tem.
 *
 * O `digVal` só existe DEPOIS de assinar. Por isso a montagem sai com um QR
 * provisório (digVal zerado — só para o XML passar pelo XSD antes de numerar)
 * e a assinatura o substitui pelo verdadeiro (`aplicarQrOffline`). O
 * `infNFeSupl` fica FORA do `infNFe` assinado: trocar o QR não invalida a
 * assinatura.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../utils/errors.js';
import { acharCscDaOperacao, buildNfceQRCodeUrl, rotuloDoAmbiente } from '../nfce/NfceCscService.js';

/** O `digVal` provisório da montagem: 28 caracteres base64 "A" → 56 hex válidos no XSD. */
export const DIGEST_PROVISORIO = 'A'.repeat(28);

export interface QrOffline {
  url: string;
  urlChave: string;
}

export function qrCodeOffline(input: {
  accessKey: string;
  environment: 'homologation' | 'production';
  /** O `dhEmi` do XML — o dia sai dele, no fuso do emitente. */
  dhEmi: string;
  /** O `vNF` exatamente como está no XML (ex.: "100.00"). */
  vNF: string;
  /** O `DigestValue` (base64) da assinatura do `infNFe`. */
  digestValue: string;
  cscId: string;
  cscToken: string;
  uf: string;
}): QrOffline {
  // A URL de consulta vem do mesmo lugar do QR online — UF sem portal recusa.
  const { urlChave } = buildNfceQRCodeUrl(
    input.accessKey,
    input.environment,
    input.cscId,
    input.cscToken,
    input.uf,
  );
  const tpAmb = input.environment === 'homologation' ? '2' : '1';
  const dia = /^\d{4}-\d{2}-(\d{2})T/.exec(input.dhEmi)?.[1];
  if (!dia) {
    throw new ApiError('CORE_FISCAL_QR_OFFLINE_INVALID', 'dhEmi fora do formato para o QR off-line.', 500);
  }
  const digVal = Buffer.from(input.digestValue, 'utf8').toString('hex');
  // Mesmo tratamento do cIdToken do QR online (GAP-PRD-097): sem zeros à esquerda.
  const idToken = String(input.cscId ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  const prefixo = `${input.accessKey}|2|${tpAmb}|${dia}|${input.vNF}|${digVal}|${idToken}`;
  const hash = createHash('sha1').update(`${prefixo}${input.cscToken}`).digest('hex').toUpperCase();
  return { url: `${urlChave}?p=${prefixo}|${hash}`, urlChave };
}

function campo(xml: string, tag: string): string | null {
  return new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`).exec(xml)?.[1] ?? null;
}

/**
 * Troca o QR provisório do XML ASSINADO pelo definitivo, com o `DigestValue`
 * da assinatura. Sem `DigestValue` (a assinatura de fixture do modo de
 * desenvolvimento não tem), usa o SHA-1 do `infNFe` — só serve ao ensaio, que
 * já sai marcado.
 */
export function aplicarQrOffline(xmlAssinado: string, input: {
  companyId: string;
  environment: 'homologation' | 'production';
  uf: string;
}): string {
  const accessKey = /<infNFe\b[^>]*\bId="NFe(\d{44})"/.exec(xmlAssinado)?.[1];
  const dhEmi = campo(xmlAssinado, 'dhEmi');
  const vNF = campo(xmlAssinado, 'vNF');
  if (!accessKey || !dhEmi || !vNF) {
    throw new ApiError('CORE_FISCAL_QR_OFFLINE_INVALID', 'XML sem chave, dhEmi ou vNF para o QR off-line.', 500);
  }
  let digest = campo(xmlAssinado, 'DigestValue');
  if (!digest) {
    const infNFe = /<infNFe\b[\s\S]*?<\/infNFe>/.exec(xmlAssinado)?.[0] ?? xmlAssinado;
    digest = createHash('sha1').update(infNFe, 'utf8').digest('base64');
  }
  // O CSC do ambiente da NOTA (GAP-PRD-022) — o de teste não assina o QR que vale.
  const csc = acharCscDaOperacao(input.companyId, 'unit-default', input.environment);
  if (!csc) {
    throw new ApiError(
      'NFCE_CSC_REQUIRED',
      `Esta operação não tem CSC de ${rotuloDoAmbiente(input.environment)} cadastrado, e o QR Code `
        + 'da NFC-e off-line é montado com ele.',
      400,
    );
  }
  const qr = qrCodeOffline({
    accessKey,
    environment: input.environment,
    dhEmi,
    vNF,
    digestValue: digest.trim(),
    cscId: csc.cscId,
    cscToken: csc.cscToken,
    uf: input.uf,
  });
  const novo = xmlAssinado.replace(
    /<qrCode>[\s\S]*?<\/qrCode>/,
    () => `<qrCode><![CDATA[${qr.url}]]></qrCode>`,
  );
  if (novo === xmlAssinado && !xmlAssinado.includes(qr.url)) {
    throw new ApiError('CORE_FISCAL_QR_OFFLINE_INVALID', 'XML sem infNFeSupl/qrCode para receber o QR off-line.', 500);
  }
  return novo;
}

/** O conteúdo do QR gravado no XML (CDATA ou texto), para o DANFCE desenhar. */
export function qrCodeDoXml(xml: string | null | undefined): string | null {
  const bruto = /<qrCode>([\s\S]*?)<\/qrCode>/.exec(String(xml ?? ''))?.[1];
  if (!bruto) return null;
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(bruto.trim());
  const texto = (cdata ? cdata[1] : bruto).trim().replace(/&amp;/g, '&');
  return texto || null;
}
