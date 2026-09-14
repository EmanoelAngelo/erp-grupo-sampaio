// SEFAZ NFC-e Authorization Transmitter
// Recebe XML não assinado, assina com certificado digital A1 (node-forge),
// monta envelope SOAP 1.2 e transmite para webservice SEFAZ do estado.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as forge from "npm:node-forge@1.3.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── WebServices SEFAZ por estado ───────────────────────────────────────
interface SefazEndpoint {
  nfceHomologacao: string;
  nfceProducao: string;
}

const SEFAZ: Record<string, SefazEndpoint> = {
  RS: {
    nfceHomologacao: "https://nfce-homologacao.sefaz.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    nfceProducao: "https://nfce.sefaz.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  },
  SP: {
    nfceHomologacao: "https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx",
    nfceProducao: "https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx",
  },
  NACIONAL: {
    nfceHomologacao: "https://homologacao.nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
    nfceProducao: "https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
  },
};

function getSefazUrl(uf: string, ambiente: string): string {
  const sefaz = SEFAZ[uf] || SEFAZ["RS"];
  return ambiente === "producao" ? sefaz.nfceProducao : sefaz.nfceHomologacao;
}

// ─── Parse certificado .pfx (PKCS#12) ────────────────────────────────────

interface CertParsed {
  certPem: string;
  keyPem: string;
  certX509B64: string;
  notBefore: Date;
  notAfter: Date;
}

function parsePfx(pfxBase64: string, senha: string): CertParsed {
  const pfxDer = forge.util.decode64(pfxBase64);
  const asn1 = forge.asn1.fromDer(pfxDer);

  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, senha);

  // Extrai certificado e chave privada
  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })?.[forge.pki.oids.pkcs8ShroudedKeyBag];
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })?.[forge.pki.oids.certBag];

  if (!keyBag || !keyBag[0]?.key) {
    throw new Error("Nao foi possivel extrair a chave privada. Verifique a senha do certificado.");
  }
  if (!certBag || !certBag[0]?.cert) {
    throw new Error("Nao foi possivel extrair o certificado X.509 do arquivo .pfx.");
  }

  const keyPem = forge.pki.privateKeyToPem(keyBag[0].key);
  const cert = certBag[0].cert;
  const certPem = forge.pki.certificateToPem(cert);

  // Extrai bytes DER do certificado para Base64 (X509Certificate)
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  const certX509B64 = forge.util.encode64(certDer.data);

  return {
    certPem,
    keyPem,
    certX509B64,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
  };
}

// ─── Canonicalização C14N ────────────────────────────────────────────────

function canonicalizeXml(xml: string): string {
  // Implementação básica de C14N 1.0 (sem namespaces explícitos)
  // Para NFC-e, a SEFAZ espera o infNFe canonicalizado
  let canon = xml
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Normaliza whitespace entre tags
  canon = canon.replace(/>\s+</g, "><");

  // Converte para UTF-8 encoding (já é)
  return canon;
}

// ─── Extrai infNFe do XML ────────────────────────────────────────────────

function extractInfNFe(xml: string): string {
  const match = xml.match(/<infNFe[^>]*>[\s\S]*?<\/infNFe>/);
  if (!match) {
    throw new Error("Tag infNFe nao encontrada no XML.");
  }
  return match[0];
}

// ─── Assinar XML com RSA-SHA256 ──────────────────────────────────────────

function assinarXml(xml: string, cert: CertParsed): string {
  // 1. Extrai o infNFe
  const infNFe = extractInfNFe(xml);

  // 2. Canonicaliza o infNFe
  const canonInfNFe = canonicalizeXml(infNFe);

  // 3. Calcula SHA-256 do infNFe canonicalizado
  const md = forge.md.sha256.create();
  md.update(canonInfNFe, "utf8");
  const digestValue = forge.util.encode64(md.digest().data);

  // 4. Monta SignedInfo (sem assinatura ainda, pra canonicalizar)
  const signedInfoTemplate = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
  <CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
  <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
  <Reference URI="#NFe${extractChaveAcesso(xml)}">
    <Transforms>
      <Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
      <Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
    </Transforms>
    <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <DigestValue>${digestValue}</DigestValue>
  </Reference>
</SignedInfo>`;

  // 5. Canonicaliza o SignedInfo
  const canonSignedInfo = canonicalizeXml(signedInfoTemplate);

  // 6. Assina o SignedInfo canonicalizado com RSA-SHA256
  const privateKey = forge.pki.privateKeyFromPem(cert.keyPem);
  const signMd = forge.md.sha256.create();
  signMd.update(canonSignedInfo, "utf8");
  const signatureValue = forge.util.encode64(privateKey.sign(signMd));

  // 7. Monta elemento <Signature> completo
  const signature = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
  <SignedInfo>
    <CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
    <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
    <Reference URI="#NFe${extractChaveAcesso(xml)}">
      <Transforms>
        <Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
        <Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
      </Transforms>
      <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
      <DigestValue>${digestValue}</DigestValue>
    </Reference>
  </SignedInfo>
  <SignatureValue>${signatureValue}</SignatureValue>
  <KeyInfo>
    <X509Data>
      <X509Certificate>${cert.certX509B64}</X509Certificate>
    </X509Data>
  </KeyInfo>
</Signature>`;

  // 8. Insere a assinatura no XML, dentro da tag <NFe> após </infNFe>
  const signedXml = xml.replace("</infNFe>", `</infNFe>\n${signature}`);

  return signedXml;
}

function extractChaveAcesso(xml: string): string {
  const match = xml.match(/Id="NFe(\d{44})"/);
  return match ? match[1] : "";
}

// ─── Montar envelope SOAP 1.2 ────────────────────────────────────────────

function buildSoapEnvelope(xmlSigned: string, uf: string): string {
  const xmlClean = xmlSigned.replace(/<\?xml[^?]*\?>/g, "").trim();
  const nfeDadosMsg = xmlClean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                 xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                 xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <cUF>${ufToCode(uf)}</cUF>
      <versaoDados>4.00</versaoDados>
    </nfeCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      ${nfeDadosMsg}
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function ufToCode(uf: string): string {
  const map: Record<string, string> = {
    RS: "43", SP: "35", RJ: "33", MG: "31", PR: "41",
    SC: "42", BA: "29", NACIONAL: "43",
  };
  return map[uf] || "43";
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const {
      xml,
      uf,
      ambiente,
      certificadoBase64,
      certificadoSenha,
      csc,
      cscId,
    } = body;

    // ─── VALIDAÇÕES ──────────────────────────────────────────────────
    if (!xml) {
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: "XML nao fornecido",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!certificadoBase64) {
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: "Certificado digital A1 nao configurado. Acesse Configuracoes > Nota Fiscal.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!csc || !cscId) {
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: "CSC e ID CSC nao configurados. Acesse Configuracoes > Nota Fiscal.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── PARSE DO CERTIFICADO ────────────────────────────────────────
    let cert: CertParsed;
    try {
      cert = parsePfx(certificadoBase64, certificadoSenha || "");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: `Falha ao processar certificado digital: ${msg}`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── VALIDAR DATAS DO CERTIFICADO ────────────────────────────────
    const now = new Date();
    if (now < cert.notBefore) {
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: `Certificado ainda nao e valido. Validade inicia em ${cert.notBefore.toISOString().slice(0, 10)}.`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (now > cert.notAfter) {
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: `Certificado vencido em ${cert.notAfter.toISOString().slice(0, 10)}. Renove o certificado A1.`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── ASSINAR XML ─────────────────────────────────────────────────
    let xmlAssinado: string;
    try {
      xmlAssinado = assinarXml(xml, cert);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: `Falha ao assinar XML: ${msg}`,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── MONTAR SOAP E TRANSMITIR ────────────────────────────────────
    const sefazUrl = getSefazUrl(uf || "RS", ambiente || "homologacao");
    const soapEnvelope = buildSoapEnvelope(xmlAssinado, uf || "RS");

    let sefazResponse: Response;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 30000);
      sefazResponse = await fetch(sefazUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/soap+xml; charset=utf-8",
        },
        body: soapEnvelope,
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      return new Response(JSON.stringify({
        cStat: "999",
        xMotivo: `Falha ao comunicar com SEFAZ: ${msg}. Tente novamente.`,
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── PARSE DA RESPOSTA ───────────────────────────────────────────
    const responseText = await sefazResponse.text();

    // Extrai cStat e xMotivo da resposta SOAP
    const cStatMatch = responseText.match(/<cStat>(\d+)<\/cStat>/);
    const xMotivoMatch = responseText.match(/<xMotivo>([^<]+)<\/xMotivo>/);
    const nProtMatch = responseText.match(/<nProt>(\d+)<\/nProt>/);
    const protocoloMatch = responseText.match(/<protNFe[^>]*>[\s\S]*?<nProt>(\d+)<\/nProt>/);

    const cStat = cStatMatch ? cStatMatch[1] : "999";
    const xMotivo = xMotivoMatch ? xMotivoMatch[1] : "Falha ao interpretar resposta SEFAZ";
    const protocolo = nProtMatch ? nProtMatch[1] : (protocoloMatch ? protocoloMatch[1] : "");

    return new Response(JSON.stringify({
      cStat,
      xMotivo,
      protocolo,
      nProt: protocolo,
      ambiente,
      uf,
      sefazUrl,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      cStat: "999",
      xMotivo: `Erro interno: ${String(err)}`,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
