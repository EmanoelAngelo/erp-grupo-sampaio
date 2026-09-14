/**
 * ============================================================================
 * A CENTRAL RECEBEU O QUE A LOJA MANDOU?
 * ============================================================================
 *
 * Roda DEPOIS de os três arquivos de `docs/supabase` terem sido executados no
 * SQL Editor do projeto. Antes disso ele não envia nada — diz o que falta e
 * para.
 *
 * ## Como se usa
 *
 *     # 1. só conferir, sem enviar
 *     node dist/scripts/conferir-central.js
 *
 *     # 2. conferir, enviar a fila e reconciliar
 *     node dist/scripts/conferir-central.js --sincronizar
 *
 * ## O que ele responde
 *
 *     CENTRAL SCHEMA    READY | BLOCKED_EXTERNAL
 *     OUTBOX BEFORE     quantos esperavam
 *     OUTBOX AFTER      quantos ainda esperam
 *     DUPLICATES        fatos que chegaram mais de uma vez
 *     TENANT MISMATCH   fatos gravados na empresa errada
 *
 * ## Por que os dois últimos existem
 *
 * O envio é UPSERT com o `id` do evento como chave primária: reenviar o mesmo
 * fato mil vezes resulta em uma linha. `DUPLICATES` confere isso contra a
 * central de verdade, em vez de confiar na promessa.
 *
 * `TENANT MISMATCH` é a pergunta que seis empresas no mesmo banco obrigam a
 * fazer. Um fato do Preço Justo gravado sob a Gringa não dá erro em lugar
 * nenhum — aparece meses depois, num relatório que não fecha.
 *
 * Nenhum valor de credencial é impresso: o que sai passa por `limpar`.
 */
import {
  diagnosticoDaProjecao,
  probeCentralSchema,
  supabaseConfig,
  syncOnce,
  syncStatus,
  type SupabaseConfig,
} from '../services/sync/SyncService.js';
import { outboxStatus } from '../services/sync/OutboxService.js';
import { conferirRpcDeProjecao } from '../services/sync/conferenciaDaProjecao.js';
import { getConnection } from '../db/sqlite.js';
import { ensureCoreSchema } from '../db/schema.js';

interface LinhaDaCentral {
  id: string;
  company_id: string;
}

/** Traz da central só id e empresa — nunca o payload. */
async function lerCentral(config: SupabaseConfig): Promise<LinhaDaCentral[]> {
  const cabecalhos = {
    Authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
  };
  const achados: LinhaDaCentral[] = [];
  const passo = 1000;
  let inicio = 0;
  for (;;) {
    const resposta = await fetch(
      `${config.url}/rest/v1/erp_sync_events?select=id,company_id&limit=${passo}&offset=${inicio}`,
      { headers: cabecalhos },
    );
    if (!resposta.ok) {
      throw new Error(`A central recusou a leitura (HTTP ${resposta.status}).`);
    }
    const lote = (await resposta.json()) as LinhaDaCentral[];
    achados.push(...lote);
    if (lote.length < passo) break;
    inicio += passo;
  }
  return achados;
}

async function main(): Promise<number> {
  const sincronizar = process.argv.slice(2).includes('--sincronizar');

  const config = supabaseConfig();
  if (!config) {
    console.error('Sem credencial da central. Faltam, no ambiente:');
    for (const f of syncStatus().missing) console.error('  - ' + f);
    return 1;
  }

  const limpar = (texto: string): string =>
    texto.split(config.serviceRoleKey).join('<oculto>');

  // ---------------------------------------------------------- 1. o esquema
  console.log('=== 1. A CENTRAL TEM O ESQUEMA? ===');
  const sonda = await probeCentralSchema();
  if (!sonda.ok) {
    console.log('  CENTRAL SCHEMA : BLOCKED_EXTERNAL');
    console.log('  motivo         : ' + limpar(sonda.detail ?? 'tabelas ausentes'));
    console.log('');
    console.log('  O QUE FAZER, no painel da Supabase:');
    console.log('    1. abra o projeto ' + new URL(config.url).host);
    console.log('    2. menu lateral → SQL Editor → New query');
    console.log('    3. cole e rode, NESTA ORDEM, um arquivo de cada vez:');
    console.log('         docs/supabase/01-landing.sql');
    console.log('         docs/supabase/02-central-schema.sql');
    console.log('         docs/supabase/03-projecao.sql');
    console.log('    4. rode este comando de novo.');
    console.log('');
    console.log('  A fila continua intacta — nada foi enviado, e nenhuma tentativa');
    console.log('  foi gasta: central sem esquema não é central fora do ar.');
    return 1;
  }
  console.log('  CENTRAL SCHEMA : READY');

  // ----------------------------------------- 1b. a função de projeção
  /*
    TER AS TABELAS NÃO PROVA TER A FUNÇÃO (GAP-PRD-048). Sem
    `erp_apply_projections`, os fatos chegam à aterrissagem e o consolidado do
    grupo fica vazio. A pergunta vai com lote VAZIO: nada é gravado. E o que
    esta loja registrou da última projeção aparece junto.
  */
  console.log('');
  console.log('=== 1b. A CENTRAL TEM A FUNÇÃO DE PROJEÇÃO? ===');
  const rpc = await conferirRpcDeProjecao({ url: config.url, serviceRoleKey: config.serviceRoleKey });
  console.log('  PROJECTION RPC : ' + rpc.estado + (rpc.http ? ' (HTTP ' + rpc.http + ')' : ''));
  console.log('  detalhe        : ' + limpar(rpc.detalhe));
  const diagnostico = diagnosticoDaProjecao();
  console.log(
    '  nesta loja     : '
      + (diagnostico.ultimoErro
        ? 'último erro de projeção em ' + (diagnostico.ultimoErroEm ?? 'data desconhecida') + ' — '
          + limpar(diagnostico.ultimoErro).slice(0, 160)
        : 'nenhum erro de projeção registrado'),
  );
  console.log('  última aceita  : ' + (diagnostico.ultimaAceitaEm ?? 'nenhuma registrada'));

  // ----------------------------------------------------------- 2. a fila
  ensureCoreSchema();
  const antes = outboxStatus();
  console.log('');
  console.log('=== 2. A FILA, ANTES ===');
  console.log('  OUTBOX BEFORE : ' + antes.pending);
  console.log('  em retry      : ' + antes.retry);
  console.log('  mortos        : ' + antes.dead);

  if (!sincronizar) {
    console.log('');
    console.log('Nada foi enviado. Para enviar, rode de novo com --sincronizar.');
    return 0;
  }

  // ------------------------------------------------------------ 3. o envio
  console.log('');
  console.log('=== 3. ENVIO ===');
  let passada = 0;
  let enviados = 0;
  while (passada < 200) {
    passada += 1;
    const r = await syncOnce({ batchSize: 50 });
    if (r.attempted === 0) break;
    enviados += r.sent;
    console.log(
      '  passada ' + String(passada).padStart(3)
      + '  tentados ' + String(r.attempted).padStart(4)
      + '  enviados ' + String(r.sent).padStart(4)
      + '  falhos ' + String(r.failed).padStart(3),
    );
    // Passada inteira falhando não melhora na seguinte: para e mostra o motivo.
    if (r.failed > 0 && r.sent === 0) {
      console.log('  parando: ' + limpar(r.error ?? 'a passada inteira falhou'));
      break;
    }
  }

  const depois = outboxStatus();
  console.log('');
  console.log('  OUTBOX AFTER : ' + depois.pending);
  console.log('  em retry     : ' + depois.retry);
  console.log('  mortos       : ' + depois.dead);
  console.log('  enviados     : ' + enviados);

  // -------------------------------------------------- 4. reconciliação
  console.log('');
  console.log('=== 4. RECONCILIAÇÃO local × central ===');

  const locais = getConnection()
    .prepare("SELECT id, company_id FROM core_outbox WHERE status = 'synced'")
    .all() as unknown as LinhaDaCentral[];
  console.log('  marcados como enviados aqui : ' + locais.length);

  let central: LinhaDaCentral[];
  try {
    central = await lerCentral(config);
  } catch (err) {
    console.log(
      '  não consegui ler a central: '
        + limpar(err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }
  console.log('  linhas na central           : ' + central.length);

  const idsCentral = new Set(central.map((c) => c.id));
  const empresaNaCentral = new Map(central.map((c) => [c.id, c.company_id]));

  const faltando = locais.filter((l) => !idsCentral.has(l.id));
  const duplicados = central.length - idsCentral.size;
  const trocados = locais.filter(
    (l) => idsCentral.has(l.id) && empresaNaCentral.get(l.id) !== l.company_id,
  );

  console.log('');
  console.log('  DUPLICATES      : ' + duplicados + '   (o id é chave primária lá: tem de ser 0)');
  console.log('  TENANT MISMATCH : ' + trocados.length + '   (fato gravado na empresa errada)');
  console.log('  NÃO CHEGARAM    : ' + faltando.length);
  for (const f of faltando.slice(0, 10)) console.log('      ' + f.id);

  console.log('');
  console.log('=== VEREDITO ===');
  // Sem a função de projeção o consolidado fica vazio, mesmo com a fila em dia.
  const ok =
    depois.pending === 0 && duplicados === 0 && trocados.length === 0 && faltando.length === 0
    && rpc.estado === 'PRONTA';
  console.log('  CENTRAL SCHEMA  : READY');
  console.log('  PROJECTION RPC  : ' + rpc.estado);
  console.log('  OUTBOX BEFORE   : ' + antes.pending);
  console.log('  OUTBOX AFTER    : ' + depois.pending);
  console.log('  DUPLICATES      : ' + duplicados);
  console.log('  TENANT MISMATCH : ' + trocados.length);
  console.log('  RECONCILIAÇÃO   : ' + (ok ? 'PASS' : 'FAIL'));
  return ok ? 0 : 1;
}

process.exitCode = await main();
