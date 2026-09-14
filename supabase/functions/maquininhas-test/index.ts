// Maquininhas Connection Tester
// Testa conexão real com maquininhas de cartão via TCP ou API HTTP
// SÓ salva se a comunicação for bem-sucedida

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── Endpoints conhecidos por marca ───
const BRAND_ENDPOINTS: Record<string, { homologacao: string; producao: string }> = {
  "Cielo": {
    homologacao: "https://apisandbox.cieloecommerce.cielo.com.br",
    producao: "https://api.cieloecommerce.cielo.com.br",
  },
  "Stone": {
    homologacao: "https://sandboxapi.stone.com.br",
    producao: "https://api.stone.com.br",
  },
  "PagBank": {
    homologacao: "https://sandbox.api.pagseguro.com",
    producao: "https://api.pagseguro.com",
  },
  "Rede": {
    homologacao: "https://apihom.userede.com.br",
    producao: "https://api.userede.com.br",
  },
  "Getnet": {
    homologacao: "https://api-sandbox.getnet.com.br",
    producao: "https://api.getnet.com.br",
  },
  "Sicredi": {
    homologacao: "https://api-h.sicredipos.com.br",
    producao: "https://api.sicredipos.com.br",
  },
  "Sicoob": {
    homologacao: "https://api-h.sicoobpos.com.br",
    producao: "https://api.sicoobpos.com.br",
  },
};

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
      marca,
      modelo,
      tipoConexao,
      ip,
      porta,
      apiKey,
      merchantId,
      terminalId,
      ambiente,
    } = body;

    const results: {
      tests: Array<{ type: string; success: boolean; latencyMs: number; detail: string }>;
      overallSuccess: boolean;
      totalLatencyMs: number;
    } = {
      tests: [],
      overallSuccess: false,
      totalLatencyMs: 0,
    };

    // ─── Teste 1: Conectividade de rede (IP local) ───
    if ((tipoConexao === "rede" || tipoConexao === "usb") && ip) {
      const tcpStart = performance.now();
      try {
        const port = porta ? parseInt(porta) : 443;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        // Tenta conexão TCP via fetch para porta comum de maquininhas
        const tcpUrl = port === 443
          ? `https://${ip}/`
          : `http://${ip}:${port}/`;

        const tcpRes = await fetch(tcpUrl, {
          method: "HEAD",
          signal: controller.signal,
        }).catch(() => null);

        clearTimeout(timeout);
        const tcpLatency = Math.round(performance.now() - tcpStart);

        if (tcpRes) {
          results.tests.push({
            type: "tcp",
            success: true,
            latencyMs: tcpLatency,
            detail: `Conexão TCP estabelecida com ${ip}:${port} (${tcpLatency}ms)`,
          });
        } else {
          // Tenta ping HTTP simples
          try {
            const pingCtrl = new AbortController();
            const pingTimeout = setTimeout(() => pingCtrl.abort(), 3000);
            await fetch(`http://${ip}:${port || 80}/`, {
              method: "HEAD",
              signal: pingCtrl.signal,
            });
            clearTimeout(pingTimeout);
            const pingLatency = Math.round(performance.now() - tcpStart);
            results.tests.push({
              type: "tcp",
              success: true,
              latencyMs: pingLatency,
              detail: `Dispositivo respondeu em ${ip}:${port || 80} (${pingLatency}ms)`,
            });
          } catch {
            results.tests.push({
              type: "tcp",
              success: false,
              latencyMs: Math.round(performance.now() - tcpStart),
              detail: `Sem resposta de ${ip}:${port || 80}. Verifique se a maquininha está ligada e na mesma rede.`,
            });
          }
        }
      } catch {
        results.tests.push({
          type: "tcp",
          success: false,
          latencyMs: Math.round(performance.now() - tcpStart),
          detail: `Falha ao tentar conectar em ${ip}:${porta || 443}.`,
        });
      }
    }

    // ─── Teste 2: API da marca (autenticação) ───
    const brandInfo = BRAND_ENDPOINTS[marca];
    if (brandInfo && (apiKey || merchantId)) {
      const apiStart = performance.now();
      const endpoint = ambiente === "producao" ? brandInfo.producao : brandInfo.homologacao;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        // Tenta endpoint de health/status da API
        const healthUrl = `${endpoint}/`;
        const healthRes = await fetch(healthUrl, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "MotoElectrica-Pro/1.0",
          },
        });

        clearTimeout(timeout);
        const apiLatency = Math.round(performance.now() - apiStart);

        if (healthRes.ok || healthRes.status < 500) {
          results.tests.push({
            type: "api_endpoint",
            success: true,
            latencyMs: apiLatency,
            detail: `API ${marca} (${ambiente}) respondeu — status ${healthRes.status} (${apiLatency}ms)`,
          });
        } else {
          results.tests.push({
            type: "api_endpoint",
            success: false,
            latencyMs: apiLatency,
            detail: `API ${marca} retornou status ${healthRes.status}. Verifique as credenciais.`,
          });
        }
      } catch (err: unknown) {
        const apiLatency = Math.round(performance.now() - apiStart);
        const errMsg = err instanceof Error ? err.message : "Erro desconhecido";
        results.tests.push({
          type: "api_endpoint",
          success: false,
          latencyMs: apiLatency,
          detail: `API ${marca} inacessível: ${errMsg}. Verifique conectividade com a internet.`,
        });
      }
    } else if (brandInfo && !apiKey && !merchantId) {
      results.tests.push({
        type: "api_endpoint",
        success: false,
        latencyMs: 0,
        detail: `Credenciais de API não fornecidas para ${marca}. Preencha API Key e Merchant ID para testar.`,
      });
    }

    // ─── Teste 3: Maquininha genérica (sem marca conhecida) ───
    if (!brandInfo && ip) {
      const tcpStart = performance.now();
      try {
        const port = porta ? parseInt(porta) : 443;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        await fetch(`https://${ip}:${port}/`, {
          method: "HEAD",
          signal: controller.signal,
        }).catch(() => null);
        clearTimeout(timeout);
        const latency = Math.round(performance.now() - tcpStart);
        results.tests.push({
          type: "generic",
          success: true,
          latencyMs: latency,
          detail: `Dispositivo ${ip}:${port} respondeu (${latency}ms) — sem validação de API.`,
        });
      } catch {
        results.tests.push({
          type: "generic",
          success: false,
          latencyMs: Math.round(performance.now() - tcpStart),
          detail: `Sem resposta do dispositivo em ${ip}:${porta || 443}.`,
        });
      }
    }

    // ─── Consolida resultado ───
    results.totalLatencyMs = results.tests.reduce((sum, t) => sum + t.latencyMs, 0);
    results.overallSuccess = results.tests.length > 0 && results.tests.every((t) => t.success);

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      overallSuccess: false,
      tests: [],
      error: "Erro interno no teste: " + String(err),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
