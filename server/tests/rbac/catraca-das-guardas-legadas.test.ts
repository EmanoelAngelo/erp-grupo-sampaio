/**
 * ============================================================================
 * A CATRACA — as guardas por PERFIL só podem diminuir
 * ============================================================================
 *
 * O RBAC granular aposenta três mecanismos que perguntam pelo CÓDIGO DO
 * PERFIL — `requireProfile` (e as cópias locais em `nfse.ts` e
 * `payment-terminals.ts`), `abertaAo` e `requirePermission` no servidor, e
 * `useHasProfile` na tela. Eles morrem por fatias (F2, F3), e a F5 apaga as
 * funções quando a contagem chegar a zero.
 *
 * O risco de uma migração por fatias é a fatia seguinte ESCREVER uma chamada
 * nova do mecanismo velho — por cópia da rota vizinha — enquanto a anterior
 * tirava três. A soma parece andar e o fim nunca chega. Esta catraca mede, por
 * AST (não por texto: comentário que cita `requireProfile(req, ...)` não é
 * chamada), quantas chamadas existem em cada arquivo, e só deixa CAIR.
 *
 * A base foi medida no HEAD da F0 (int/b fb4c111). Arquivo que não está na
 * base tem base zero: uma cópia nova de `requireProfile` num roteador novo cai
 * aqui. Quando uma fatia baixar um número, ela pode (e deve) baixar a base
 * junto — mas nunca subir.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '../../..');

/** Os nomes que perguntam pelo perfil. */
const MECANISMOS = ['requireProfile', 'abertaAo', 'requirePermission', 'useHasProfile'] as const;

/** `arquivo › mecanismo` → chamadas medidas na F0. Fora daqui, a base é zero. */
const BASE_DA_CATRACA: Readonly<Record<string, number>> = {
  'server/src/routes/v1/auth.ts › requirePermission': 3,
  'server/src/routes/v1/core.ts › requireProfile': 421,
  'server/src/routes/v1/core.ts › abertaAo': 98,
  'server/src/routes/v1/index.ts › requirePermission': 10,
  'server/src/routes/v1/logistics.ts › requirePermission': 23,
  'server/src/routes/v1/nfse.ts › requireProfile': 8,
  'server/src/routes/v1/payment-terminals.ts › requirePermission': 31,
  'server/src/routes/v1/payment-terminals.ts › requireProfile': 11,
  'server/src/routes/v1/system-admin.ts › requirePermission': 9,
  'src/components/gs/AsaasDoGrupoCard.tsx › useHasProfile': 1,
  'src/components/gs/CaixaPdvDialog.tsx › useHasProfile': 1,
  'src/components/gs/ConferenciaDeReservas.tsx › useHasProfile': 1,
  'src/components/gs/NotasSemContaAPagar.tsx › useHasProfile': 1,
  'src/components/gs/RecuperacaoDeSenhaDaOperacao.tsx › useHasProfile': 1,
  'src/components/gs/RegularizarVendasOffline.tsx › useHasProfile': 1,
  'src/pages/gs/AlteracaoRapidaPage.tsx › useHasProfile': 1,
  'src/pages/gs/AuxiliaresCatalogoPage.tsx › useHasProfile': 2,
  'src/pages/gs/ContasPage.tsx › useHasProfile': 3,
  'src/pages/gs/DevolucoesFornecedorPage.tsx › useHasProfile': 1,
  'src/pages/gs/DevolucoesPage.tsx › useHasProfile': 2,
  'src/pages/gs/EntradaNotasPage.tsx › useHasProfile': 5,
  'src/pages/gs/EquipamentoFichaPage.tsx › useHasProfile': 6,
  'src/pages/gs/EquipamentosPage.tsx › useHasProfile': 1,
  'src/pages/gs/ImportacaoPlanilhaPage.tsx › useHasProfile': 1,
  'src/pages/gs/ImpressorasPage.tsx › useHasProfile': 1,
  'src/pages/gs/InventarioPage.tsx › useHasProfile': 1,
  'src/pages/gs/LocaisEstoquePage.tsx › useHasProfile': 1,
  'src/pages/gs/MovimentacoesEstoquePage.tsx › useHasProfile': 1,
  'src/pages/gs/OficinaPage.tsx › useHasProfile': 1,
  'src/pages/gs/OperacaoPages.tsx › useHasProfile': 5,
  'src/pages/gs/OrcamentosPage.tsx › useHasProfile': 3,
  'src/pages/gs/OrdemServicoPage.tsx › useHasProfile': 7,
  'src/pages/gs/PainelPage.tsx › useHasProfile': 1,
  'src/pages/gs/PdvPage.tsx › useHasProfile': 1,
  'src/pages/gs/PecasPage.tsx › useHasProfile': 1,
  'src/pages/gs/PedidosCompraPage.tsx › useHasProfile': 1,
  'src/pages/gs/PlaquinhasPage.tsx › useHasProfile': 3,
  'src/pages/gs/PoliticaGestaoPage.tsx › useHasProfile': 1,
  'src/pages/gs/TerminaisPage.tsx › useHasProfile': 1,
  'src/pages/gs/UnidadesEstoquePage.tsx › useHasProfile': 1,
};

/** As chamadas de cada mecanismo num fonte, pela árvore do TypeScript. */
export function chamadasNoFonte(texto: string, nomeDoArquivo: string): Partial<Record<(typeof MECANISMOS)[number], number>> {
  const tipo = nomeDoArquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const fonte = ts.createSourceFile(nomeDoArquivo, texto, ts.ScriptTarget.ES2022, true, tipo);
  const n: Partial<Record<(typeof MECANISMOS)[number], number>> = {};
  const visitar = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const nome = node.expression.text as (typeof MECANISMOS)[number];
      if ((MECANISMOS as readonly string[]).includes(nome)) n[nome] = (n[nome] ?? 0) + 1;
    }
    ts.forEachChild(node, visitar);
  };
  visitar(fonte);
  return n;
}

/** O código de produto: servidor e tela, sem teste, sem declaração de tipo, sem dependência. */
function fontesDoProduto(pasta: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(pasta)) {
    if (nome === 'node_modules' || nome === '__tests__' || nome === 'dist') continue;
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...fontesDoProduto(caminho));
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) && !nome.endsWith('.d.ts')) saida.push(caminho);
  }
  return saida;
}

function medir(): Record<string, number> {
  const medida: Record<string, number> = {};
  for (const arquivo of [...fontesDoProduto(join(RAIZ, 'server/src')), ...fontesDoProduto(join(RAIZ, 'src'))]) {
    const rel = relative(RAIZ, arquivo).split('\\').join('/');
    for (const [mecanismo, n] of Object.entries(chamadasNoFonte(readFileSync(arquivo, 'utf8'), arquivo))) {
      if (n) medida[`${rel} › ${mecanismo}`] = n;
    }
  }
  return medida;
}

describe('a catraca das guardas por perfil', () => {
  const medida = medir();

  it('nenhum arquivo tem MAIS chamadas de guarda por perfil do que a base — nem arquivo novo', () => {
    const subiram = Object.entries(medida)
      .filter(([chave, n]) => n > (BASE_DA_CATRACA[chave] ?? 0))
      .map(([chave, n]) => `${chave}: ${n} (base ${BASE_DA_CATRACA[chave] ?? 0})`);
    // O conserto nunca é subir a base: é escrever a guarda nova
    // (requireCapability/requireAnyCapability/comCapability na rota, useCan na tela).
    expect(subiram.join('\n')).toBe('');
  });

  it('a medida enxerga o que diz enxergar — a varredura não está lendo o vazio', () => {
    const total = Object.values(medida).reduce((a, b) => a + b, 0);
    const base = Object.values(BASE_DA_CATRACA).reduce((a, b) => a + b, 0);
    // Enquanto a F2/F3 não terminam, a medida é positiva e não passa da base.
    expect(total).toBeLessThanOrEqual(base);
    expect(fontesDoProduto(join(RAIZ, 'server/src/routes/v1')).length).toBeGreaterThanOrEqual(8);
  });

  it('conta CHAMADA, não texto: comentário e definição não contam; chamada quebrada em linhas conta', () => {
    const exemplo = [
      "// requireProfile(req, 'gerente_loja') — isto é prosa",
      'function requireProfile(req: unknown, ...p: string[]) { void req; void p; }',
      "requireProfile(req, 'gerente_loja');",
      'abertaAo(',
      '  req,',
      "  'escritorio',",
      ');',
      "router.get('/x', requirePermission('a.b.view'), h);",
      "const pode = useHasProfile('gerente_loja');",
    ].join('\n');
    expect(chamadasNoFonte(exemplo, 'exemplo.tsx')).toEqual({ requireProfile: 1, abertaAo: 1, requirePermission: 1, useHasProfile: 1 });
  });
});
