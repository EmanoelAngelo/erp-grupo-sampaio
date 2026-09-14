/**
 * ============================================================================
 * T0 E T1 — O ACESSO DE HOJE, CONGELADO, E A EXPRESSÃO NOVA QUE O REPRODUZ
 * ============================================================================
 *
 * O RBAC granular troca o guarda de ~600 rotas. A promessa é que, com os
 * modelos de sistema do dia 1, NINGUÉM ganha nem perde rota — salvo a mudança
 * D1, declarada. Promessa sobre 600 rotas não se confere de olho: se confere
 * rota a rota, e é o que este arquivo faz, sem subir servidor.
 *
 * T0 — LINHA DE BASE. `linha-de-base.json` diz, para cada rota (método +
 * caminho em /api/v1), quais perfis passam HOJE. Aqui o código é lido por AST
 * (a mesma leitura posicional da regra `rota-declara-alcance`: só vale guarda
 * incondicional) e cada guarda é resolvido para o conjunto de perfis que ele
 * alcança — `requireProfile` com o atalho dos donos e as listas nomeadas,
 * `abertaAo` pelos ambientes, `requirePermission` pela matriz de
 * `Permissions.ts`, a interseção quando há dois guardas (a gerência da
 * maquininha), e as guardas novas pelos modelos de sistema. O resultado tem de
 * ser a linha de base. Rota nova, rota apagada, guarda que alarga ou estreita:
 * vermelho, com o nome da rota.
 *
 * T1 — EQUIVALÊNCIA ESTÁTICA. Para cada rota guardada, a expressão de
 * capability que a F2 escreve no lugar do guarda (`capability` na linha de
 * base) alcança, com os modelos de sistema, exatamente os perfis de hoje. A
 * única diferença permitida é a D1. E a tradução de `requirePermission`
 * (`TraducaoDePermissoes.ts`) cobre toda chamada do código, com a mesma string
 * e a mesma expressão.
 *
 * O que NÃO se prova aqui: que o servidor em execução faz o que o código diz.
 * Isso é a varredura dinâmica (T2, `varredura/`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { temPermissao } from '../../src/services/auth/Permissions.js';
import {
  MODELOS_DE_SISTEMA,
  expressaoDoTexto,
  passaNaExpressao,
  type ExpressaoDeCapability,
} from '../../src/services/auth/Capabilities.js';
import { PERMISSAO_PARA_CAPABILITY } from '../../src/services/auth/TraducaoDePermissoes.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR_ROTAS = resolve(AQUI, '../../src/routes/v1');

interface RotaDaBase {
  arquivo: string;
  linha: number;
  guarda_hoje: string;
  perfis: string[] | 'PUBLICA';
  capability: string;
  mudanca: string | null;
}
const linhaDeBase = JSON.parse(readFileSync(join(AQUI, 'linha-de-base.json'), 'utf8')) as {
  total: number;
  rotas: Record<string, RotaDaBase>;
};

/** Os onze perfis de hoje, na ordem da legenda. */
const PERFIS = [
  'admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador',
];
const DONOS = ['admin_geral', 'gestor'];
const ordenar = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => PERFIS.indexOf(a) - PERFIS.indexOf(b));

const GUARDAS_LEGADAS = new Set(['requireProfile', 'abertaAo', 'requirePermission']);
const GUARDAS_NOVAS = new Set(['requireCapability', 'requireAnyCapability', 'requireAllCapabilities', 'comCapability', 'comQualquerCapability']);
const DECLARACOES = new Set(['rotaPublica', 'soAutenticado']);
/** O que autentica (quem é você) — nunca conta como alcance sozinho. */
const AUTENTICACOES = new Set(['authMiddleware', 'autenticacaoDaEtapaDeTroca', 'autenticacaoDaSaida']);
const METODOS = new Set(['get', 'post', 'put', 'patch', 'delete']);

// ---------------------------------------------------------------------------
// A leitura do código
// ---------------------------------------------------------------------------

interface Guarda {
  nome: string;
  args: readonly ts.Expression[];
}
interface RotaDoCodigo {
  chave: string;
  arquivo: string;
  linha: number;
  guardas: Guarda[];
  declaracao: 'rotaPublica' | 'soAutenticado' | null;
  autenticada: boolean;
}
interface ArquivoLido {
  nome: string;
  fonte: ts.SourceFile;
  listas: Map<string, string[]>;
  ambientes: Map<string, string[]>;
  atalhoDosDonos: boolean;
}

function tirar(expr: ts.Expression): ts.Expression {
  let atual = expr;
  for (let i = 0; i < 8; i += 1) {
    if (ts.isVoidExpression(atual) || ts.isAwaitExpression(atual)) atual = atual.expression;
    else if (ts.isParenthesizedExpression(atual) || ts.isNonNullExpression(atual) || ts.isAsExpression(atual)) atual = atual.expression;
    else return atual;
  }
  return atual;
}

/** O bloco de uma IIFE de primeiro nível (`(async () => {...})()`, com ou sem `.catch(next)`). */
function blocoDeIife(stmt: ts.Statement): ts.Block | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  let expr = tirar(stmt.expression);
  for (let i = 0; i < 6; i += 1) {
    if (!ts.isCallExpression(expr)) return null;
    const alvo = tirar(expr.expression);
    if (ts.isArrowFunction(alvo) || ts.isFunctionExpression(alvo)) return ts.isBlock(alvo.body) ? alvo.body : null;
    if (ts.isPropertyAccessExpression(alvo)) {
      expr = tirar(alvo.expression);
      continue;
    }
    return null;
  }
  return null;
}

/** As guardas INCONDICIONAIS do corpo: primeiro nível, `try` de primeiro nível, IIFE de primeiro nível. */
function guardasDoCorpo(stmts: readonly ts.Statement[], profundidade = 0): Guarda[] {
  if (profundidade > 6) return [];
  const achadas: Guarda[] = [];
  for (const stmt of stmts) {
    if (ts.isExpressionStatement(stmt)) {
      const expr = tirar(stmt.expression);
      if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
        const nome = expr.expression.text;
        if (GUARDAS_LEGADAS.has(nome) || GUARDAS_NOVAS.has(nome)) {
          achadas.push({ nome, args: expr.arguments });
          continue;
        }
      }
    }
    if (ts.isTryStatement(stmt)) {
      achadas.push(...guardasDoCorpo(stmt.tryBlock.statements, profundidade + 1));
      continue;
    }
    const bloco = blocoDeIife(stmt);
    if (bloco) achadas.push(...guardasDoCorpo(bloco.statements, profundidade + 1));
  }
  return achadas;
}

/** `const X = ['a', ...Y] as const` e `const X = Y`: as listas nomeadas do arquivo. */
function listasDoArquivo(fonte: ts.SourceFile): Map<string, ts.Expression> {
  const cruas = new Map<string, ts.Expression>();
  const visitar = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      cruas.set(node.name.text, tirar(node.initializer));
    }
    ts.forEachChild(node, visitar);
  };
  visitar(fonte);
  return cruas;
}

function resolverLista(nome: string, cruas: Map<string, ts.Expression>, visitados = new Set<string>()): string[] | null {
  if (visitados.has(nome)) return null;
  visitados.add(nome);
  const expr = cruas.get(nome);
  if (!expr) return null;
  if (ts.isIdentifier(expr)) return resolverLista(expr.text, cruas, visitados);
  if (!ts.isArrayLiteralExpression(expr)) return null;
  const saida: string[] = [];
  for (const el of expr.elements) {
    if (ts.isStringLiteralLike(el)) saida.push(el.text);
    else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
      const dentro = resolverLista(el.expression.text, cruas, new Set(visitados));
      if (!dentro) return null;
      saida.push(...dentro);
    } else return null;
  }
  return saida;
}

function lerArquivo(nome: string): ArquivoLido {
  const caminho = join(DIR_ROTAS, nome);
  const fonte = ts.createSourceFile(caminho, readFileSync(caminho, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cruas = listasDoArquivo(fonte);
  const listas = new Map<string, string[]>();
  for (const k of cruas.keys()) {
    const l = resolverLista(k, cruas);
    if (l) listas.set(k, l);
  }
  const ambientes = new Map<string, string[]>();
  const pda = cruas.get('PERFIS_DO_AMBIENTE');
  if (pda && ts.isObjectLiteralExpression(pda)) {
    for (const prop of pda.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const valor = tirar(prop.initializer);
      const lista = ts.isIdentifier(valor) ? listas.get(valor.text) : null;
      if (lista) ambientes.set(prop.name.text, lista);
    }
  }
  // O `requireProfile` LOCAL deste arquivo tem o atalho dos donos? (core, nfse e maquininha têm.)
  let atalhoDosDonos = false;
  const visitar = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'requireProfile' && node.body) {
      const corpo = node.body.getText(fonte);
      atalhoDosDonos = corpo.includes("'admin_geral'") && corpo.includes("'gestor'");
    }
    ts.forEachChild(node, visitar);
  };
  visitar(fonte);
  return { nome, fonte, listas, ambientes, atalhoDosDonos };
}

function lerRoteadores(): RotaDoCodigo[] {
  const arquivos = readdirSync(DIR_ROTAS).filter((f) => f.endsWith('.ts')).map(lerArquivo);

  // Qual arquivo exporta cada roteador, e onde cada um é montado.
  const arquivoDoRoteador = new Map<string, ArquivoLido>();
  const montagens: { pai: string; prefixo: string; filho: string }[] = [];
  for (const a of arquivos) {
    for (const m of a.fonte.getFullText().matchAll(/export const (\w+Router) = Router\(\)/g)) arquivoDoRoteador.set(m[1]!, a);
    const visitar = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.name.text === 'use'
      ) {
        const args = node.arguments;
        const prefixo = args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : '';
        for (const arg of args) {
          if (ts.isIdentifier(arg) && /Router$/.test(arg.text)) {
            montagens.push({ pai: node.expression.expression.text, prefixo, filho: arg.text });
          }
        }
      }
      ts.forEachChild(node, visitar);
    };
    visitar(a.fonte);
  }
  const prefixos = new Map<string, string>([['v1Router', '']]);
  for (let volta = 0; volta < 5; volta += 1) {
    for (const m of montagens) {
      const doPai = prefixos.get(m.pai);
      if (doPai !== undefined && !prefixos.has(m.filho)) prefixos.set(m.filho, doPai + m.prefixo);
    }
  }

  const rotas: RotaDoCodigo[] = [];
  for (const [roteador, a] of arquivoDoRoteador) {
    const prefixo = prefixos.get(roteador);
    if (prefixo === undefined) throw new Error(`${roteador} (${a.nome}) não está montado em lugar nenhum que a leitura conheça`);
    const visitar = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === roteador
        && METODOS.has(node.expression.name.text)
      ) {
        const primeiro = node.arguments[0];
        if (!primeiro || !ts.isStringLiteralLike(primeiro)) throw new Error(`${a.nome}: rota com caminho não literal`);
        const guardas: Guarda[] = [];
        let declaracao: RotaDoCodigo['declaracao'] = null;
        let autenticada = false;
        let handler: ts.ArrowFunction | ts.FunctionExpression | null = null;
        for (const bruto of node.arguments.slice(1)) {
          const arg = tirar(bruto);
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            handler = arg;
            break;
          }
          if (ts.isIdentifier(arg) && AUTENTICACOES.has(arg.text)) autenticada = true;
          if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
            const nome = arg.expression.text;
            if (GUARDAS_LEGADAS.has(nome) || GUARDAS_NOVAS.has(nome)) guardas.push({ nome, args: arg.arguments });
            if (DECLARACOES.has(nome)) declaracao = nome as RotaDoCodigo['declaracao'];
          }
        }
        if (handler && ts.isBlock(handler.body)) guardas.push(...guardasDoCorpo(handler.body.statements));
        const linha = a.fonte.getLineAndCharacterOfPosition(node.getStart(a.fonte)).line + 1;
        rotas.push({
          chave: `${node.expression.name.text.toUpperCase()} ${prefixo}${primeiro.text}`,
          arquivo: a.nome,
          linha,
          guardas,
          declaracao,
          autenticada,
        });
      }
      ts.forEachChild(node, visitar);
    };
    visitar(a.fonte);
  }
  return rotas;
}

// ---------------------------------------------------------------------------
// A resolução: guarda → perfis que passam
// ---------------------------------------------------------------------------

const literais = (args: readonly ts.Expression[]) =>
  args.map((a) => (ts.isStringLiteralLike(a) ? a.text : null));

function expressaoDaGuardaNova(g: Guarda): ExpressaoDeCapability | null {
  const desde = g.nome.startsWith('com') ? 0 : 1;
  const caps = literais(g.args.slice(desde));
  if (caps.some((c) => c === null) || caps.length === 0) return null;
  const texto = g.nome === 'requireCapability' || g.nome === 'comCapability'
    ? caps[0]!
    : `${g.nome === 'requireAllCapabilities' ? 'todas' : 'qualquer'}(${caps.join(', ')})`;
  return expressaoDoTexto(texto);
}

const perfisDaExpressao = (e: ExpressaoDeCapability) =>
  PERFIS.filter((p) => passaNaExpressao(new Set<string>(MODELOS_DE_SISTEMA[p]!.capabilities), e));

function perfisDaGuarda(g: Guarda, a: ArquivoLido): string[] {
  const donos = a.atalhoDosDonos ? DONOS : [];
  if (g.nome === 'requireProfile') {
    const perfis: string[] = [...donos];
    for (const arg of g.args.slice(1)) {
      if (ts.isStringLiteralLike(arg)) perfis.push(arg.text);
      else if (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression)) {
        const lista = a.listas.get(arg.expression.text);
        if (!lista) throw new Error(`${a.nome}: lista ${arg.expression.text} não resolvida`);
        perfis.push(...lista);
      } else throw new Error(`${a.nome}: argumento de requireProfile que a leitura não entende: ${arg.getText(a.fonte)}`);
    }
    return ordenar(perfis.filter((p) => PERFIS.includes(p)));
  }
  if (g.nome === 'abertaAo') {
    const perfis: string[] = [...donos];
    for (const amb of literais(g.args.slice(1))) {
      const lista = amb ? a.ambientes.get(amb) : undefined;
      if (!lista) throw new Error(`${a.nome}: ambiente ${amb} não resolvido`);
      perfis.push(...lista);
    }
    return ordenar(perfis);
  }
  if (g.nome === 'requirePermission') {
    const [p] = literais(g.args);
    if (!p) throw new Error(`${a.nome}: requirePermission sem literal`);
    return PERFIS.filter((perfil) => temPermissao([perfil], p));
  }
  const e = expressaoDaGuardaNova(g);
  if (!e) throw new Error(`${a.nome}: ${g.nome} com capability desconhecida ou fora de literal`);
  return perfisDaExpressao(e);
}

type Alcance = string[] | 'PUBLICA' | 'SEM_GUARDA';

function alcanceDaRota(r: RotaDoCodigo, a: ArquivoLido): Alcance {
  if (r.guardas.length === 0) {
    if (r.declaracao === 'soAutenticado') return [...PERFIS];
    // `rotaPublica` com autenticação ao lado: "sem guarda de ALCANCE de
    // propósito", mas com sessão — qualquer perfil autenticado (as rotas da
    // própria sessão em auth.ts). Sem autenticação, pública de verdade.
    if (r.declaracao === 'rotaPublica') return r.autenticada ? [...PERFIS] : 'PUBLICA';
    return 'SEM_GUARDA';
  }
  let conjunto = new Set(PERFIS);
  for (const g of r.guardas) {
    const passa = new Set(perfisDaGuarda(g, a));
    conjunto = new Set([...conjunto].filter((p) => passa.has(p)));
  }
  return ordenar(conjunto);
}

const arquivos = new Map(readdirSync(DIR_ROTAS).filter((f) => f.endsWith('.ts')).map((f) => [f, lerArquivo(f)]));
const rotasDoCodigo = lerRoteadores();
const alcancePorChave = new Map<string, { alcance: Alcance; rota: RotaDoCodigo }>();
const repetidas: string[] = [];
for (const r of rotasDoCodigo) {
  if (alcancePorChave.has(r.chave)) repetidas.push(`${r.chave} (${r.arquivo}:${r.linha})`);
  else alcancePorChave.set(r.chave, { alcance: alcanceDaRota(r, arquivos.get(r.arquivo)!), rota: r });
}

// ---------------------------------------------------------------------------
// T0
// ---------------------------------------------------------------------------

describe('T0 — o código de hoje é a linha de base', () => {
  it('a leitura enxerga os nove roteadores e todas as rotas (senão ficaria verde lendo nada)', () => {
    // O nono é `acesso.ts` (a tela de Usuários: empresa, PDV e página por pessoa).
    expect(new Set(rotasDoCodigo.map((r) => r.arquivo)).size).toBe(9);
    expect(alcancePorChave.size).toBe(linhaDeBase.total);
    expect(linhaDeBase.total).toBeGreaterThan(680);
    expect(repetidas).toEqual([]);
  });

  it('nenhuma rota do código fica fora da linha de base, e nenhuma da linha de base sumiu', () => {
    const naBase = new Set(Object.keys(linhaDeBase.rotas));
    const novas = [...alcancePorChave.keys()].filter((k) => !naBase.has(k));
    const sumidas = [...naBase].filter((k) => !alcancePorChave.has(k));
    expect({ novas, sumidas }).toEqual({ novas: [], sumidas: [] });
  });

  it('toda rota alcança HOJE exatamente os perfis da linha de base', () => {
    const divergentes: string[] = [];
    for (const [chave, { alcance, rota }] of alcancePorChave) {
      const base = linhaDeBase.rotas[chave];
      if (!base) continue;
      const esperado = base.perfis === 'PUBLICA' ? 'PUBLICA' : ordenar(base.perfis);
      if (JSON.stringify(alcance) !== JSON.stringify(esperado)) {
        divergentes.push(`${chave} (${rota.arquivo}:${rota.linha}): código ${JSON.stringify(alcance)} × base ${JSON.stringify(esperado)}`);
      }
    }
    expect(divergentes.join('\n')).toBe('');
  });

  it('a resolução enxerga o atalho dos donos, as listas nomeadas e a interseção da maquininha', () => {
    // Falsificação de três pedaços da leitura: se um deles quebrar, a
    // comparação acima poderia passar por acaso (dois erros que se anulam).
    expect(alcancePorChave.get('GET /core/products')!.alcance).toEqual(
      ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'],
    );
    expect(alcancePorChave.get('POST /payment-terminals/local-agent/pairing')!.alcance).toEqual(['admin_geral', 'gestor', 'gerente_loja']);
    expect(alcancePorChave.get('GET /payment-terminals/local-agent/status')!.alcance).toEqual(
      ['admin_geral', 'gestor', 'gerente_loja', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
    );
    expect(alcancePorChave.get('POST /auth/login')!.alcance).toBe('PUBLICA');
    expect(alcancePorChave.get('GET /auth/session')!.alcance).toEqual(PERFIS);
  });
});

// ---------------------------------------------------------------------------
// T1
// ---------------------------------------------------------------------------

describe('T1 — a expressão de capability reproduz o acesso de hoje', () => {
  it('toda rota guardada: a expressão, com os modelos de sistema, alcança os perfis de hoje — só a D1 difere', () => {
    const diferencas: string[] = [];
    for (const [chave, base] of Object.entries(linhaDeBase.rotas)) {
      if (base.perfis === 'PUBLICA') continue;
      const hoje = ordenar(base.perfis);
      if (base.capability === 'SO_AUTENTICADO') {
        if (JSON.stringify(hoje) !== JSON.stringify(PERFIS)) diferencas.push(`${chave}: só autenticada, mas a base não tem os onze`);
        continue;
      }
      const e = expressaoDoTexto(base.capability);
      if (!e) {
        diferencas.push(`${chave}: expressão ilegível ${base.capability}`);
        continue;
      }
      const dia1 = perfisDaExpressao(e);
      const ganha = dia1.filter((p) => !hoje.includes(p));
      const perde = hoje.filter((p) => !dia1.includes(p));
      if (ganha.length || perde.length) diferencas.push(`${chave} [${base.mudanca ?? 'sem mudança declarada'}]: ganha ${ganha.join(',') || '—'}; perde ${perde.join(',') || '—'}`);
    }
    expect(diferencas).toEqual([
      'POST /core/print/jobs [D1]: ganha operador_caixa; perde —',
      'POST /core/print/jobs/:id/reprint [D1]: ganha operador_caixa; perde —',
    ]);
  });

  it('a tradução de requirePermission cobre TODA chamada do código, com a mesma string e a expressão do mapa', () => {
    const comPermissao = [...alcancePorChave.values()]
      .map(({ rota }) => ({ rota, g: rota.guardas.find((g) => g.nome === 'requirePermission') }))
      .filter((x) => x.g);
    expect(comPermissao.length).toBe(Object.keys(PERMISSAO_PARA_CAPABILITY).length);
    const problemas: string[] = [];
    for (const { rota, g } of comPermissao) {
      const t = PERMISSAO_PARA_CAPABILITY[rota.chave];
      const [permissao] = literais(g!.args);
      if (!t) {
        problemas.push(`${rota.chave}: sem tradução (a rota negaria todo mundo)`);
        continue;
      }
      if (t.permissao !== permissao) problemas.push(`${rota.chave}: código pede ${permissao}, tradução é de ${t.permissao}`);
      const doMapa = expressaoDoTexto(linhaDeBase.rotas[rota.chave]!.capability);
      if (JSON.stringify(t.expressao) !== JSON.stringify(doMapa)) problemas.push(`${rota.chave}: tradução ${JSON.stringify(t.expressao)} × mapa ${JSON.stringify(doMapa)}`);
    }
    expect(problemas).toEqual([]);
  });

  it('a tradução, com os modelos de sistema, passa exatamente quem a matriz de hoje passava (com a interseção da gerência)', () => {
    const divergentes: string[] = [];
    for (const [chave, t] of Object.entries(PERMISSAO_PARA_CAPABILITY)) {
      const hoje = linhaDeBase.rotas[chave]!.perfis as string[];
      const dia1 = perfisDaExpressao(t.expressao);
      if (JSON.stringify(ordenar(hoje)) !== JSON.stringify(dia1)) divergentes.push(`${chave}: hoje ${hoje} × tradução ${dia1}`);
    }
    expect(divergentes).toEqual([]);
  });
});
