/**
 * ============================================================================
 * APLICAR UM ARQUIVO SQL NA CENTRAL — sem copiar, sem colar, sem navegador
 * ============================================================================
 *
 * Duas tentativas de rodar `02-central-schema.sql` pelo SQL Editor terminaram
 * com o marcador de versão gravado e NENHUMA das 18 tabelas criada. O arquivo
 * estava correto — validado contra a gramática do PostgreSQL. O que falhou foi
 * o caminho: 382 linhas atravessando uma caixa de texto de navegador.
 *
 * Este comando tira o navegador do caminho. Lê o arquivo do disco, manda o
 * conteúdo EXATO, e imprime o sha256 do que mandou — para que "o arquivo
 * inteiro saiu daqui" deixe de ser suposição.
 *
 * ## Como se usa
 *
 * Da RAIZ do repositório, em PowerShell:
 *
 *     # 1. ENSAIO — não envia, e nem pede token
 *     node server\dist\scripts\aplicar-sql-central.js docs/supabase/03-projecao.sql --ensaio
 *
 *     # 2. DE VERDADE — o token entra por prompt, sem eco e sem histórico
 *     $s = Read-Host -AsSecureString
 *     $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
 *     $env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
 *     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
 *     node server\dist\scripts\aplicar-sql-central.js docs/supabase/03-projecao.sql --confirmar
 *     Remove-Item Env:SUPABASE_ACCESS_TOKEN
 *
 * O token é PESSOAL, da sua conta Supabase, criado em
 * https://supabase.com/dashboard/account/tokens — e NÃO é a chave de serviço do
 * projeto. Vem por variável de ambiente: em argumento de linha de comando
 * ficaria no histórico do shell e na lista de processos.
 *
 * ## O que ele NÃO faz
 *
 * Não altera o arquivo. Não cria migration. Não escolhe o projeto: o destino
 * vem de `DEVORA_SUPABASE_URL`, o mesmo que o resto do sistema usa, para que
 * não seja possível aplicar no projeto errado por engano.
 *
 * ============================================================================
 * A CONFERÊNCIA — o marcador de versão não serve de prova
 * ============================================================================
 *
 * O marcador é um `INSERT` cru que não verifica nada. Ele já mentiu duas vezes:
 * dizia "versão 2 aplicada" com zero tabelas criadas.
 *
 * Então a conferência pergunta ao CATÁLOGO do PostgreSQL — `to_regclass` e
 * `pg_proc` —, que não passa pelo cache do PostgREST e não depende de marcador
 * nenhum.
 *
 * E ela tira um retrato ANTES e outro DEPOIS. O que a migration deve mudar
 * (tabelas, funções, marcador) é comparado com o esperado; o que ela NÃO pode
 * tocar — a contagem de eventos e quantos ainda não foram projetados — é
 * comparado consigo mesmo. Cravar "118" no código faria a conferência mentir
 * no dia em que houvesse 119.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../config/env.js';

const ENDPOINT_BASE = 'https://api.supabase.com/v1/projects';

/** As 18 tabelas de negócio que a migration 002 promete. */
const TABELAS_DE_NEGOCIO = [
  'erp_companies', 'erp_operational_units', 'erp_products', 'erp_product_variants',
  'erp_customers', 'erp_inventory_ledger', 'erp_inventory_reservations',
  'erp_inventory_snapshots', 'erp_sales', 'erp_sale_items', 'erp_payments',
  'erp_finance_entries', 'erp_orders', 'erp_order_status_history',
  'erp_fiscal_documents', 'erp_fiscal_events', 'erp_service_orders', 'erp_equipment',
];

/** As funções que a migration 003 promete, com a assinatura exata. */
const FUNCOES_ESPERADAS = [
  {
    nome: 'erp_projecao_tabelas_permitidas',
    args: '',
    retorno: 'text[]',
    securityDefiner: false,
  },
  {
    nome: 'erp_apply_projections',
    args: 'payload jsonb',
    retorno: 'jsonb',
    /*
      `security definer` é o que permite à função escrever nas tabelas com RLS
      ligada. É justamente por isso que `anon` e `authenticated` NÃO podem
      executá-la: seria escrita na central para quem tem a chave publicável do
      site, que vai no bundle JavaScript.
    */
    securityDefiner: true,
  },
];

interface FuncaoNaCentral {
  nome: string;
  args: string;
  retorno: string;
  security_definer: boolean;
  service_role: boolean;
  anon: boolean;
  authenticated: boolean;
}

interface EstadoDaCentral {
  tabelasDeNegocio: number;
  funcoes: FuncaoNaCentral[];
  migrations: number[];
  eventos: number;
  naoProjetados: number;
  /** `false` quando a aterrissagem ainda não existe (projeto virgem). */
  aterrissagemExiste: boolean;
}

interface RespostaDaApi {
  ok: boolean;
  status: number;
  corpo: string;
}

async function consultar(ref: string, token: string, sql: string): Promise<RespostaDaApi> {
  const r = await fetch(`${ENDPOINT_BASE}/${ref}/database/query`, {
    method: 'POST',
    headers: {
      // O token só existe AQUI, no cabeçalho. Nenhum log o carrega.
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  return { ok: r.ok, status: r.status, corpo: await r.text().catch(() => '') };
}

/**
 * Retrato do que existe na central AGORA.
 *
 * São duas consultas, e a segunda só roda se a aterrissagem existir: em
 * PostgreSQL uma referência a tabela inexistente derruba a instrução inteira na
 * análise, antes de qualquer `case` — não dá para proteger por dentro.
 */
async function retratar(ref: string, token: string): Promise<EstadoDaCentral | null> {
  const lista = TABELAS_DE_NEGOCIO.map((t) => `'public.${t}'`).join(',');
  const nomes = FUNCOES_ESPERADAS.map((f) => `'${f.nome}'`).join(',');

  // Esta primeira não depende de tabela nenhuma existir.
  const catalogo = await consultar(
    ref,
    token,
    `select
       (select count(*)::int from unnest(array[${lista}]) as t(n)
         where to_regclass(t.n) is not null) as tabelas,
       (to_regclass('public.erp_sync_events') is not null) as aterrissagem,
       coalesce((select json_agg(json_build_object(
            'nome', p.proname,
            'args', pg_get_function_identity_arguments(p.oid),
            'retorno', pg_get_function_result(p.oid),
            'security_definer', p.prosecdef,
            'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
            'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
            'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          order by p.proname)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (${nomes})), '[]'::json) as funcoes;`,
  );
  if (!catalogo.ok) {
    console.error('  não consegui ler o catálogo (HTTP ' + catalogo.status + ').');
    return null;
  }

  type LinhaDoCatalogo = { tabelas?: number; aterrissagem?: boolean; funcoes?: FuncaoNaCentral[] };
  let linha: LinhaDoCatalogo;
  try {
    linha = (JSON.parse(catalogo.corpo) as LinhaDoCatalogo[])[0] ?? {};
  } catch {
    console.error('  resposta inesperada do catálogo: ' + catalogo.corpo.slice(0, 160));
    return null;
  }

  const estado: EstadoDaCentral = {
    tabelasDeNegocio: Number(linha.tabelas ?? 0),
    funcoes: linha.funcoes ?? [],
    migrations: [],
    eventos: -1,
    naoProjetados: -1,
    aterrissagemExiste: linha.aterrissagem === true,
  };

  if (!estado.aterrissagemExiste) return estado;

  const fila = await consultar(
    ref,
    token,
    `select
       coalesce((select json_agg(version order by version)
                   from public.erp_central_migrations), '[]'::json) as migrations,
       (select count(*)::int from public.erp_sync_events) as eventos,
       (select count(*)::int from public.erp_sync_events
         where projected_at is null) as nao_projetados;`,
  );
  if (fila.ok) {
    type LinhaDaFila = { migrations?: number[]; eventos?: number; nao_projetados?: number };
    try {
      const l = (JSON.parse(fila.corpo) as LinhaDaFila[])[0] ?? {};
      estado.migrations = l.migrations ?? [];
      estado.eventos = Number(l.eventos ?? -1);
      estado.naoProjetados = Number(l.nao_projetados ?? -1);
    } catch {
      // Fica com os valores neutros; a conferência dirá que não pôde comparar.
    }
  }
  return estado;
}

function imprimirEstado(rotulo: string, e: EstadoDaCentral): void {
  console.log('  [' + rotulo + ']');
  console.log('    tabelas de negócio     : ' + e.tabelasDeNegocio + '/' + TABELAS_DE_NEGOCIO.length);
  console.log('    migrations             : '
    + (e.migrations.length ? e.migrations.map((v) => 'v' + v).join(' ') : '(nenhuma)'));
  console.log('    eventos na aterrissagem: ' + (e.eventos < 0 ? '(sem aterrissagem)' : e.eventos));
  console.log('    sem projeção           : ' + (e.naoProjetados < 0 ? '—' : e.naoProjetados));
  if (e.funcoes.length === 0) {
    console.log('    funções                : nenhuma');
    return;
  }
  for (const f of e.funcoes) {
    console.log('    função ' + f.nome + '(' + f.args + ') → ' + f.retorno);
    console.log('      security definer     : ' + (f.security_definer ? 'sim' : 'não'));
    console.log('      pode executar        : service_role=' + f.service_role
      + '  anon=' + f.anon + '  authenticated=' + f.authenticated);
  }
}

/** Uma linha do veredito. */
function conferir(rotulo: string, ok: boolean, detalhe: string): boolean {
  console.log('  ' + (ok ? 'OK   ' : 'FALHA') + '  ' + rotulo.padEnd(44) + detalhe);
  return ok;
}

/**
 * O que ESTE arquivo deve ter mudado, e o que não pode ter tocado.
 *
 * Declarado por nome de arquivo porque cada migration promete uma coisa
 * diferente — e porque um arquivo desconhecido não deve passar por uma
 * conferência inventada.
 */
function conferirExpectativas(
  arquivo: string,
  antes: EstadoDaCentral,
  depois: EstadoDaCentral,
): boolean {
  let tudoBem = true;
  const marca = (ok: boolean): void => { if (!ok) tudoBem = false; };

  /*
    INVARIANTES — valem para QUALQUER migration.

    Nenhuma delas pode mexer nos fatos já entregues. A comparação é com o
    retrato de antes, não com um número cravado: "118" viraria mentira no dia
    em que houvesse 119.
  */
  if (antes.aterrissagemExiste && antes.eventos >= 0) {
    marca(conferir('eventos não mudaram', depois.eventos === antes.eventos,
      antes.eventos + ' → ' + depois.eventos));
    marca(conferir('nenhum foi projetado por engano',
      depois.naoProjetados === antes.naoProjetados,
      antes.naoProjetados + ' → ' + depois.naoProjetados));
  }

  const nome = basename(arquivo);

  if (nome === '01-landing.sql') {
    marca(conferir('aterrissagem existe', depois.aterrissagemExiste,
      String(depois.aterrissagemExiste)));
    marca(conferir('marcador v1 gravado', depois.migrations.includes(1),
      depois.migrations.map((v) => 'v' + v).join(' ')));
    return tudoBem;
  }

  if (nome === '02-central-schema.sql') {
    marca(conferir('as 18 tabelas existem', depois.tabelasDeNegocio === 18,
      depois.tabelasDeNegocio + '/18'));
    marca(conferir('marcador v2 gravado', depois.migrations.includes(2),
      depois.migrations.map((v) => 'v' + v).join(' ')));
    return tudoBem;
  }

  if (nome === '03-projecao.sql') {
    // A 003 não pode ter derrubado o que a 002 criou.
    marca(conferir('as 18 tabelas da 002 continuam', depois.tabelasDeNegocio === 18,
      depois.tabelasDeNegocio + '/18'));

    for (const esperada of FUNCOES_ESPERADAS) {
      const achada = depois.funcoes.find((f) => f.nome === esperada.nome);
      marca(conferir('função ' + esperada.nome, Boolean(achada),
        achada ? 'existe' : 'AUSENTE'));
      if (!achada) continue;

      marca(conferir('  assinatura de ' + esperada.nome,
        achada.args === esperada.args && achada.retorno === esperada.retorno,
        achada.nome + '(' + achada.args + ') → ' + achada.retorno));
      marca(conferir('  security definer de ' + esperada.nome,
        achada.security_definer === esperada.securityDefiner,
        String(achada.security_definer)));
    }

    /*
      A PERMISSÃO É PARTE DA MIGRATION, não detalhe de arrumação.

      `security definer` faz a função escrever ignorando RLS. Se `anon` pudesse
      executá-la, qualquer um com a chave publicável do site escreveria na
      central das seis empresas.
    */
    const rpc = depois.funcoes.find((f) => f.nome === 'erp_apply_projections');
    if (rpc) {
      marca(conferir('service_role pode executar a RPC', rpc.service_role === true,
        String(rpc.service_role)));
      marca(conferir('anon NÃO pode', rpc.anon === false, String(rpc.anon)));
      marca(conferir('authenticated NÃO pode', rpc.authenticated === false,
        String(rpc.authenticated)));
    }

    marca(conferir('marcador v3 gravado', depois.migrations.includes(3),
      depois.migrations.map((v) => 'v' + v).join(' ')));
    return tudoBem;
  }

  console.log('  ??     arquivo sem conferência declarada: ' + nome);
  console.log('         o retrato acima é tudo o que dá para afirmar.');
  return tudoBem;
}

/**
 * O caminho DESTE script, relativo ao diretório de onde foi chamado.
 *
 * Imprimir um caminho fixo daria certo de um lugar só. Quem lê a mensagem de
 * ajuda está, por definição, no lugar onde acabou de rodar o ensaio.
 */
function processoRelativo(): string {
  const eu = fileURLToPath(import.meta.url);
  return relative(process.cwd(), eu).split(sep).join(sep) || eu;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const confirmar = args.includes('--confirmar');
  const ensaio = !confirmar;
  const caminhoRelativo = args.find((a) => !a.startsWith('--'));

  if (!caminhoRelativo) {
    console.error('Falta o caminho do arquivo SQL.');
    console.error('  node ' + processoRelativo() + ' docs/supabase/03-projecao.sql --ensaio');
    return 1;
  }
  if (!confirmar && !args.includes('--ensaio')) {
    console.error('Escolha --ensaio (não envia) ou --confirmar (envia).');
    return 1;
  }

  const caminho = resolve(process.cwd(), caminhoRelativo);
  if (!existsSync(caminho)) {
    console.error('Arquivo não encontrado: ' + caminho);
    return 1;
  }

  const bytes = readFileSync(caminho);
  const sql = bytes.toString('utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const linhas = sql.split('\n');

  /*
    O destino vem da configuração do sistema, não de argumento. Digitar o
    project ref à mão é o tipo de coisa que se erra uma vez e se descobre tarde.
  */
  const env = loadEnv();
  const url = String(env.DEVORA_SUPABASE_URL ?? '').trim();
  if (!url) {
    console.error('DEVORA_SUPABASE_URL não está no ambiente: não sei para qual projeto enviar.');
    return 1;
  }
  const ref = new URL(url).host.split('.')[0];

  console.log(ensaio ? '=== ENSAIO — nada será enviado ===' : '=== APLICANDO NA CENTRAL ===');
  console.log('  arquivo   : ' + caminhoRelativo);
  console.log('  bytes     : ' + bytes.length);
  console.log('  linhas    : ' + linhas.length);
  console.log('  sha256    : ' + sha);
  console.log('  projeto   : ' + ref);
  console.log('');
  console.log('  primeira linha : ' + (linhas[0] ?? '').slice(0, 70));
  const ultima = [...linhas].reverse().find((l) => l.trim()) ?? '';
  console.log('  última linha   : ' + ultima.slice(0, 70));

  if (ensaio) {
    console.log('');
    console.log('Nada foi enviado. Para valer:');
    console.log('  $env:SUPABASE_ACCESS_TOKEN=... ; node ' + processoRelativo()
      + ' ' + caminhoRelativo + ' --confirmar');
    return 0;
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (!token) {
    console.error('');
    console.error('Falta SUPABASE_ACCESS_TOKEN no ambiente.');
    console.error('Crie em https://supabase.com/dashboard/account/tokens');
    console.error('Não passe o token como argumento: ele ficaria no histórico do shell.');
    return 1;
  }
  const limpar = (t: string): string => t.split(token).join('<oculto>');

  // ------------------------------------------------------ o retrato de ANTES
  console.log('');
  console.log('=== COMO A CENTRAL ESTÁ, ANTES ===');
  const antes = await retratar(ref, token);
  if (!antes) return 1;
  imprimirEstado('antes', antes);

  // ------------------------------------------------------------- o envio
  console.log('');
  console.log('=== ENVIANDO ===');
  const r = await consultar(ref, token, sql);
  if (!r.ok) {
    console.error('  A central RECUSOU (HTTP ' + r.status + ').');
    console.error('  ' + limpar(r.corpo).slice(0, 500));
    console.error('');
    console.error('  Nada foi aplicado pela metade: o Postgres executa um texto');
    console.error('  com várias instruções numa transação só — ou tudo, ou nada.');
    return 1;
  }
  console.log('  HTTP ' + r.status + ' — aceito.');

  // ----------------------------------------------------- o retrato de DEPOIS
  console.log('');
  console.log('=== COMO A CENTRAL FICOU ===');
  const depois = await retratar(ref, token);
  if (!depois) return 1;
  imprimirEstado('depois', depois);

  console.log('');
  console.log('=== CONFERÊNCIA ===');
  const passou = conferirExpectativas(caminhoRelativo, antes, depois);

  console.log('');
  console.log('=== VEREDITO ===');
  if (passou) {
    console.log('  APLICADO E CONFERIDO.');
    console.log('  Lembre do cache do PostgREST: Settings › General › Restart project.');
    return 0;
  }
  console.log('  CONFERÊNCIA REPROVADA. NÃO confie no marcador de versão.');
  console.log('  Me mostre esta saída inteira.');
  return 1;
}

process.exitCode = await main();
