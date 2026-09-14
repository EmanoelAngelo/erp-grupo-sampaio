// SEFAZ Connection Tester v2
// Testa comunicacao real com webservices da SEFAZ
// Valida endpoints, latencia, certificado A1 e SOAP consStatServ

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as forge from "npm:node-forge@1.3.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// --- Endpoints SEFAZ por estado ---
const SEFAZ_ENDPOINTS: Record<string, {
  nome: string;
  nfce: string;
  homologacao: string;
  status: string;
  wsdlProducao: string;
  wsdlHomologacao: string;
}> = {
  "RS": {
    nome: "Rio Grande do Sul",
    nfce: "https://nfce.sefaz.rs.gov.br",
    homologacao: "https://nfce-homologacao.sefaz.rs.gov.br",
    status: "https://www.sefaz.rs.gov.br",
    wsdlProducao: "https://nfce.sefaz.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
    wsdlHomologacao: "https://nfce-homologacao.sefaz.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  },
  "SP": {
    nome: "Sao Paulo",
    nfce: "https://nfce.fazenda.sp.gov.br",
    homologacao: "https://homologacao.nfce.fazenda.sp.gov.br",
    status: "https://www.fazenda.sp.gov.br",
    wsdlProducao: "https://nfce.fazenda.sp.gov.br/ws/NfeStatusServico4.asmx",
    wsdlHomologacao: "https://homologacao.nfe.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx",
  },
  "NACIONAL": {
    nome: "Ambiente Nacional (SVRS)",
    nfce: "https://nfce.svrs.rs.gov.br",
    homologacao: "https://homologacao.nfce.svrs.rs.gov.br",
    status: "https://www.nfe.fazenda.gov.br",
    wsdlProducao: "https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
    wsdlHomologacao: "https://homologacao.nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  },
};

// Fallback para estados sem WSDL especifico
function getSefazInfo(uf: string) {
  return SEFAZ_ENDPOINTS[uf] || SEFAZ_ENDPOINTS["RS"];
}

function ufToCode(uf: string): string {
  const map: Record<string, string> = {
    RS: "43", SP: "35", RJ: "33", MG: "31", PR: "41",
    SC: "42", BA: "29", NACIONAL: "43",
  };
  return map[uf] || "43";
}

// --- Parse certificado .pfx (PKCS#12) ---
interface CertParsed {
  certPem: string;
  keyPem: string;
  certX509B64: string;
  notBefore: string;
  notAfter: string;
  subjectCN: string;
  issuerCN: string;
}

function parsePfx(pfxBase64: string, senha: string): CertParsed {
  if (!pfxBase64) throw new Error("Certificado nao fornecido.");

  let pfxDer: forge.util.ByteStringBuffer;
  try {
    pfxDer = forge.util.decode64(pfxBase64);
  } catch {
    throw new Error("Arquivo .pfx invalido ou corrompido. Nao foi possivel decodificar Base64.");
  }

  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(pfxDer);
  } catch {
    throw new Error("Arquivo .pfx nao e um DER/ASN.1 valido.");
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, senha || "");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Erro";
    if (msg.includes("password") || msg.includes("decrypt") || msg.includes("bag")) {
      throw new Error("Senha do certificado incorreta ou arquivo .pfx corrompido.");
    }
    throw new Error(`Falha ao processar .pfx: ${msg}`);
  }

  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })?.[forge.pki.oids.pkcs8ShroudedKeyBag];
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })?.[forge.pki.oids.certBag];

  if (!keyBag || !keyBag[0]?.key) {
    throw new Error("Nao foi possivel extrair a chave privada. Verifique a senha do certificado.");
  }
  if (!certBag || !certBag[0]?.cert) {
    throw new Error("Nao foi possivel extrair o certificado X.509 do arquivo .pfx.");
  }

  const cert = certBag[0].cert;

  // Extrai bytes DER do certificado para Base64 (X509Certificate)
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  const certX509B64 = forge.util.encode64(certDer.data);

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keyBag[0].key),
    certX509B64,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    subjectCN: cert.subject.getField("CN")?.value || "Desconhecido",
    issuerCN: cert.issuer.getField("CN")?.value || "Desconhecido",
  };
}

// --- SOAP consStatServ (Status do Servico) ---
function buildConsStatServSoap(uf: string, ambiente: string): string {
  const cUF = ufToCode(uf);
  const tpAmb = ambiente === "producao" ? "1" : "2";

  return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                 xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                 xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <cUF>${cUF}</cUF>
      <versaoDados>4.00</versaoDados>
    </nfeCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${tpAmb}</tpAmb>
        <cUF>${cUF}</cUF>
        <xServ>STATUS</xServ>
      </consStatServ>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

interface TestResult {
  type: string;
  endpoint: string;
  success: boolean;
  latencyMs: number;
  httpStatus?: number;
  detail: string;
}

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
      uf,
      ambiente,
      cnpj,
      inscricaoEstadual,
      certificadoBase64,
      certificadoSenha,
    } = body;

    const ufKey = (uf || "RS").toUpperCase();
    const sefazInfo = getSefazInfo(ufKey);
    const isProducao = ambiente === "producao";

    const tests: TestResult[] = [];
    let certParsed: CertParsed | null = null;

    // --- Teste 0: Valida certificado A1 (se fornecido) ---
    if (certificadoBase64) {
      const start0 = performance.now();
      try {
        certParsed = parsePfx(certificadoBase64, certificadoSenha || "");

        const now = new Date();
        const notAfter = new Date(certParsed.notAfter);
        const notBefore = new Date(certParsed.notBefore);
        const lat = Math.round(performance.now() - start0);

        if (now > notAfter) {
          tests.push({
            type: "certificado",
            endpoint: "local",
            success: false,
            latencyMs: lat,
            detail: `Certificado VENCIDO em ${notAfter.toISOString().slice(0, 10)}. Titular: ${certParsed.subjectCN}. Emitido por: ${certParsed.issuerCN}.`,
          });
        } else if (now < notBefore) {
          tests.push({
            type: "certificado",
            endpoint: "local",
            success: false,
            latencyMs: lat,
            detail: `Certificado ainda NAO e valido. Inicia em ${notBefore.toISOString().slice(0, 10)}. Titular: ${certParsed.subjectCN}.`,
          });
        } else {
          const diasRestantes = Math.ceil((notAfter.getTime() - now.getTime()) / 86400000);
          tests.push({
            type: "certificado",
            endpoint: "local",
            success: true,
            latencyMs: lat,
            detail: `Certificado VALIDO ate ${notAfter.toISOString().slice(0, 10)} (${diasRestantes} dias). Titular: ${certParsed.subjectCN}. Emitido por: ${certParsed.issuerCN}.`,
          });
        }
      } catch (err: unknown) {
        const lat = Math.round(performance.now() - start0);
        const msg = err instanceof Error ? err.message : "Erro";
        tests.push({
          type: "certificado",
          endpoint: "local",
          success: false,
          latencyMs: lat,
          detail: `Falha no certificado: ${msg}`,
        });
      }
    }

    // --- Teste 1: Site principal da SEFAZ ---
    const start1 = performance.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(sefazInfo.status, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(timeout);
      const lat = Math.round(performance.now() - start1);
      tests.push({
        type: "portal",
        endpoint: sefazInfo.status,
        success: res.ok,
        latencyMs: lat,
        httpStatus: res.status,
        detail: res.ok
          ? `Portal SEFAZ/${ufKey} acessivel (${lat}ms)`
          : `Portal retornou HTTP ${res.status}`,
      });
    } catch (err: unknown) {
      const lat = Math.round(performance.now() - start1);
      const msg = err instanceof Error ? err.message : "Erro";
      tests.push({
        type: "portal",
        endpoint: sefazInfo.status,
        success: false,
        latencyMs: lat,
        detail: `Portal inacessivel: ${msg}`,
      });
    }

    // --- Teste 2: Endpoint NFC-e ---
    const nfceUrl = isProducao ? sefazInfo.nfce : sefazInfo.homologacao;
    const start2 = performance.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(nfceUrl, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(timeout);
      const lat = Math.round(performance.now() - start2);
      tests.push({
        type: "nfce",
        endpoint: nfceUrl,
        success: res.ok || res.status < 500,
        latencyMs: lat,
        httpStatus: res.status,
        detail: res.ok
          ? `Webservice NFC-e (${isProducao ? "Producao" : "Homologacao"}) respondeu (${lat}ms)`
          : `NFC-e retornou HTTP ${res.status}`,
      });
    } catch (err: unknown) {
      const lat = Math.round(performance.now() - start2);
      const msg = err instanceof Error ? err.message : "Erro";
      tests.push({
        type: "nfce",
        endpoint: nfceUrl,
        success: false,
        latencyMs: lat,
        detail: `NFC-e inacessivel: ${msg}`,
      });
    }

    // --- Teste 3: Portal Nacional ---
    const start3 = performance.now();
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch("https://www.nfe.fazenda.gov.br", { method: "HEAD", signal: ctrl.signal });
      clearTimeout(timeout);
      const lat = Math.round(performance.now() - start3);
      tests.push({
        type: "nacional",
        endpoint: "https://www.nfe.fazenda.gov.br",
        success: res.ok,
        latencyMs: lat,
        httpStatus: res.status,
        detail: res.ok
          ? `Portal NF-e Nacional acessivel (${lat}ms)`
          : `Portal Nacional retornou HTTP ${res.status}`,
      });
    } catch (err: unknown) {
      const lat = Math.round(performance.now() - start3);
      const msg = err instanceof Error ? err.message : "Erro";
      tests.push({
        type: "nacional",
        endpoint: "https://www.nfe.fazenda.gov.br",
        success: false,
        latencyMs: lat,
        detail: `Portal Nacional inacessivel: ${msg}`,
      });
    }

    // --- Teste 4: SOAP consStatServ (Status do Servico SEFAZ) ---
    const wsdlUrl = isProducao ? sefazInfo.wsdlProducao : sefazInfo.wsdlHomologacao;
    const soapBody = buildConsStatServSoap(ufKey, ambiente || "homologacao");
    const start4 = performance.now();

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(wsdlUrl, {
        method: "POST",
        headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
        body: soapBody,
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      const lat = Math.round(performance.now() - start4);
      const respText = await res.text();

      // Extrai cStat e xMotivo da resposta SOAP
      const cStatMatch = respText.match(/<cStat>(\d+)<\/cStat>/);
      const xMotivoMatch = respText.match(/<xMotivo>([^<]+)<\/xMotivo>/);
      const cStat = cStatMatch ? cStatMatch[1] : "?";
      const xMotivo = xMotivoMatch ? xMotivoMatch[1] : "sem resposta XML";

      const soaSuccess = res.ok && cStat === "107"; // 107 = Servico em Operacao

      tests.push({
        type: "soap_status",
        endpoint: wsdlUrl,
        success: soaSuccess,
        latencyMs: lat,
        httpStatus: res.status,
        detail: soaSuccess
          ? `consStatServ OK: ${xMotivo} (cStat=${cStat}, ${lat}ms)`
          : `consStatServ: ${xMotivo} (cStat=${cStat}, HTTP ${res.status})`,
      });

    } catch (err: unknown) {
      const lat = Math.round(performance.now() - start4);
      const msg = err instanceof Error ? err.message : "Erro";
      tests.push({
        type: "soap_status",
        endpoint: wsdlUrl,
        success: false,
        latencyMs: lat,
        detail: `SOAP consStatServ falhou: ${msg}. O webservice pode estar fora do ar ou blocos de firewall podem estar impedindo a conexao.`,
      });
    }

    // --- Consolida ---
    const passedTests = tests.filter((t) => t.success);
    // Requer: portal OK + NFC-e OK + Nacional OK = ao menos 3 passando
    // Se tem certificado, exige tambem que o cert esteja OK
    const requiredPasses = certificadoBase64 ? 4 : 3;
    const overallSuccess = passedTests.length >= requiredPasses;
    const totalLatencyMs = Math.round(
      tests.reduce((sum, t) => sum + t.latencyMs, 0) / (tests.length || 1)
    );

    // --- Recomendacao ---
    let recomendacao = "";
    const certOk = tests.find((t) => t.type === "certificado");
    const soapOk = tests.find((t) => t.type === "soap_status");

    if (overallSuccess && passedTests.length === tests.length) {
      recomendacao = "Comunicacao SEFAZ totalmente operacional. ";
      if (certOk?.success) {
        recomendacao += "Certificado A1 validado com sucesso. Pronto para emissao de NF-e/NFC-e.";
      }
    } else if (overallSuccess) {
      const falhas = tests.filter((t) => !t.success).map((t) => t.type).join(", ");
      recomendacao = `Comunicacao parcial — ${falhas} indisponivel(is). Verifique com o contador se o estado exige endpoints especificos.`;
    } else if (!certOk?.success && certificadoBase64) {
      recomendacao = `Certificado digital invalido: ${certOk?.detail}. Corrija o certificado .pfx antes de emitir notas.`;
    } else if (!soapOk?.success) {
      recomendacao = "Webservice SEFAZ indisponivel no momento (SOAP consStatServ falhou). Tente novamente mais tarde.";
    } else {
      recomendacao = "Falha critica na comunicacao SEFAZ. Verifique conectividade com a internet, firewall e DNS.";
    }

    return new Response(JSON.stringify({
      tests,
      overallSuccess,
      totalLatencyMs,
      uf: ufKey,
      estado: sefazInfo.nome,
      ambiente: isProducao ? "Producao" : "Homologacao",
      recomendacao,
      certificado: certParsed ? {
        titular: certParsed.subjectCN,
        emissor: certParsed.issuerCN,
        validoAte: certParsed.notAfter,
        diasRestantes: Math.ceil((new Date(certParsed.notAfter).getTime() - Date.now()) / 86400000),
      } : null,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      overallSuccess: false,
      tests: [],
      error: "Erro interno: " + String(err),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
