
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const start = performance.now();

    // Check all tables
    const tables = [
      "usuarios", "equipamentos", "clientes", "produtos", "pecas_oficina",
      "plaquinhas", "ordens_servico", "vendas", "caixas", "itens_venda",
      "movimentacoes_estoque", "config_maquininhas", "fila_impressao",
      "produtividade", "os_pecas"
    ];

    const counts: Record<string, number> = {};
    const errors: string[] = [];

    for (const table of tables) {
      try {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true });
        if (error) errors.push(`${table}: ${error.message}`);
        else counts[table] = count ?? 0;
      } catch (e) {
        errors.push(`${table}: ${(e as Error).message}`);
      }
    }

    const latency = Math.round(performance.now() - start);

    const status = errors.length === 0 ? "healthy" : "degraded";

    return new Response(JSON.stringify({
      status,
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      system: "Grupo Sampaio",
      database: {
        status: errors.length === 0 ? "online" : "partial",
        latency_ms: latency,
        table_count: tables.length,
        tables: counts,
        errors: errors.length > 0 ? errors : undefined,
      },
      uptime: Math.floor(performance.now() / 1000),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: status === "healthy" ? 200 : 503,
    });

  } catch (err) {
    return new Response(JSON.stringify({
      status: "error",
      timestamp: new Date().toISOString(),
      error: (err as Error).message,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
