/**
 * ============================================================================
 * A TELA QUE ABRE E TOMA 403 EM TODA CHAMADA
 * ============================================================================
 *
 * Cinco telas de e-commerce declaram só `ROTA_GESTAO`, que é o ESCRITÓRIO
 * inteiro: `admin_geral`, `gestor`, `gerente_loja`, `gerente_oficina`,
 * `estoquista` e `atendente`. E o servidor delas é mais estreito que isso.
 *
 *   Administração da loja   GET/PUT /core/storefront/settings
 *   Entrega                 GET/PUT /core/shipping-settings
 *   E-mails                 GET /core/emails, POST /core/emails/enviar,
 *                           POST /core/emails/:id/reenviar
 *   Conciliação Asaas       GET /core/asaas/conciliacao
 *       → os quatro: `requireProfile(req, 'gerente_loja', 'gerente_oficina')`
 *         — o estoquista e o atendente entram e recebem 403 em tudo.
 *
 *   Logística               GET /core/logistics/readiness, /carriers, POST /quote
 *       → `requireProfile(req, 'gerente_loja', 'estoquista')` — aqui quem fica
 *         de fora é o GERENTE DA OFICINA, o contrário dos outros quatro.
 *
 * O sintoma é o que a rodada 23 nomeou "guarda mais estreito que a tela": o
 * menu oferece a porta, a pessoa clica, a tela monta INTEIRA e vazia, e cada
 * chamada volta 403. Chega ao dono como "o sistema está com defeito", e não
 * como "você não tem permissão" — porque ninguém disse isso em lugar nenhum.
 *
 * ## Por que este teste mora no servidor, e por AST
 *
 * Pela mesma razão de `ambientes-dos-dois-lados`: quem decide é
 * `requireProfile`, e a suíte que precisa ficar vermelha é a do lado que
 * manda. E por AST porque os dois arquivos são de projetos diferentes, com
 * `tsconfig` diferentes, e nenhum importa o outro — o `tsc` não conhece
 * relação nenhuma entre eles e os dois compilam felizes dizendo coisas
 * contrárias.
 *
 * ## Como este guarda falha (quebrando de propósito)
 *
 *   - tire `QUEM_RESPONDE_PELA_LOJA` da rota de `/sistema/loja/emails` em
 *     `gsRoutes.tsx` e o caso daquela tela fica vermelho;
 *   - acrescente `'estoquista'` a `QUEM_RESPONDE_PELA_LOJA` e os quatro casos
 *     ficam vermelhos, dizendo qual perfil o navegador oferece e o servidor
 *     recusa.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '../src/routes/v1/core.ts');
const AMBIENTES = resolve(AQUI, '../../src/router/environments.ts');
const ROTAS = resolve(AQUI, '../../src/router/gsRoutes.tsx');

function arvore(caminho: string, tsx = false): ts.SourceFile {
  expect(existsSync(caminho), `arquivo não encontrado: ${caminho}`).toBe(true);
  return ts.createSourceFile(
    caminho,
    readFileSync(caminho, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

// ---------------------------------------------------------------------------

/** Todo `const NOME = [...]` de primeiro nível, resolvido para lista de texto. */
function listasDeclaradas(sf: ts.SourceFile): Map<string, string[]> {
  const achadas = new Map<string, string[]>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      let expr: ts.Expression = decl.initializer;
      while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
      }
      if (!ts.isArrayLiteralExpression(expr)) continue;
      const textos = expr.elements.filter(ts.isStringLiteralLike).map((el) => el.text);
      if (textos.length === expr.elements.length) achadas.set(decl.name.text, textos);
    }
  }
  return achadas;
}

/**
 * Os perfis que o servidor exige numa rota, pelo método e caminho.
 *
 * Lê a chamada `coreRouter.<metodo>('<caminho>', handler)` e procura, dentro
 * do corpo dela, a primeira chamada a `requireProfile`. Devolve os textos que
 * ela nomeia — sem `admin_geral`/`gestor`, que `requireProfile` libera antes
 * de olhar a lista.
 */
function perfisDaRota(sf: ts.SourceFile, metodo: string, caminho: string): string[] {
  let achado: string[] | null = null;

  const visitar = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'coreRouter'
      && node.expression.name.text === metodo
      && node.arguments.length >= 2
      && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text === caminho
    ) {
      const perfis: string[] = [];
      const dentro = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n)
          && ts.isIdentifier(n.expression)
          && n.expression.text === 'requireProfile'
        ) {
          for (const arg of n.arguments.slice(1)) {
            if (ts.isStringLiteralLike(arg)) perfis.push(arg.text);
          }
          return;
        }
        ts.forEachChild(n, dentro);
      };
      ts.forEachChild(node.arguments[node.arguments.length - 1], dentro);
      achado = perfis;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);

  if (achado === null) throw new Error(`rota não encontrada: ${metodo} ${caminho}`);
  return achado;
}

/**
 * A constante de perfil que o roteador do navegador declara para um caminho.
 *
 * `protectedRoute(path, elemento, ambiente, PERFIS)` — o quarto argumento é
 * opcional, e é justamente a ausência dele que este arquivo persegue.
 */
function constanteDaTela(sf: ts.SourceFile, caminho: string): string | null {
  let achado: string | null | undefined;

  const visitar = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'protectedRoute'
      && node.arguments.length >= 3
      && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text === caminho
    ) {
      const quarto = node.arguments[3];
      achado = quarto && ts.isIdentifier(quarto) ? quarto.text : null;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);

  if (achado === undefined) throw new Error(`tela não encontrada no roteador: ${caminho}`);
  return achado;
}

// ---------------------------------------------------------------------------

/** O escritório inteiro — o que `ROTA_GESTAO` sozinha deixa entrar. */
const ESCRITORIO = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
  'atendente',
];

interface TelaComGuarda {
  nome: string;
  caminho: string;
  constante: string;
  /** As rotas que a tela chama, e sem as quais ela é uma casca vazia. */
  rotas: { metodo: string; caminho: string }[];
}

const TELAS: TelaComGuarda[] = [
  {
    nome: 'Administração da loja',
    caminho: '/sistema/loja/administracao',
    constante: 'QUEM_RESPONDE_PELA_LOJA',
    rotas: [
      { metodo: 'get', caminho: '/storefront/settings' },
      { metodo: 'put', caminho: '/storefront/settings' },
    ],
  },
  {
    nome: 'Entrega',
    caminho: '/sistema/loja/entrega',
    constante: 'QUEM_RESPONDE_PELA_LOJA',
    rotas: [
      { metodo: 'get', caminho: '/shipping-settings' },
      { metodo: 'put', caminho: '/shipping-settings' },
    ],
  },
  {
    nome: 'E-mails',
    caminho: '/sistema/loja/emails',
    constante: 'QUEM_RESPONDE_PELA_LOJA',
    rotas: [
      { metodo: 'get', caminho: '/emails' },
      { metodo: 'post', caminho: '/emails/enviar' },
      // O botão "Reenviar" da mensagem que desistiu (GAP-PRD-038).
      { metodo: 'post', caminho: '/emails/:id/reenviar' },
      // O cartão 'O que falta para os e-mails desta empresa saírem' (GAP-PRD-130).
      { metodo: 'get', caminho: '/comunicacoes/prontidao' },
    ],
  },
  {
    nome: 'Conciliação Asaas',
    caminho: '/sistema/integracoes/asaas/conciliacao',
    constante: 'QUEM_RESPONDE_PELA_LOJA',
    rotas: [{ metodo: 'get', caminho: '/asaas/conciliacao' }],
  },
  {
    nome: 'Logística',
    caminho: '/sistema/loja/logistica',
    constante: 'QUEM_COTA_FRETE',
    rotas: [
      { metodo: 'get', caminho: '/logistics/readiness' },
      { metodo: 'get', caminho: '/logistics/carriers' },
      { metodo: 'post', caminho: '/logistics/quote' },
    ],
  },
];

// ============================================================================

describe('a tela declara o mesmo alcance que o servidor exige', () => {
  const servidor = arvore(SERVIDOR);
  const ambientes = arvore(AMBIENTES);
  const roteador = arvore(ROTAS, true);
  const listas = listasDeclaradas(ambientes);

  for (const tela of TELAS) {
    describe(tela.nome, () => {
      it('o roteador declara a constante de perfil, e não só o ambiente', () => {
        expect(
          constanteDaTela(roteador, tela.caminho),
          `${tela.nome} (${tela.caminho}) abre para o escritório inteiro; o servidor não.`,
        ).toBe(tela.constante);
      });

      it('a constante existe e é uma lista de perfis', () => {
        expect(listas.has(tela.constante), `falta \`${tela.constante}\` em environments.ts`)
          .toBe(true);
        expect(listas.get(tela.constante)!.length).toBeGreaterThan(0);
      });

      it('a constante é EXATAMENTE o que o servidor aceita', () => {
        const declarada = [...(listas.get(tela.constante) ?? [])].sort();
        for (const rota of tela.rotas) {
          /*
            `requireProfile` libera `admin_geral` e `gestor` ANTES de olhar a
            lista, então eles fazem parte do alcance real da rota mesmo sem
            estarem escritos nela.
          */
          const doServidor = [
            ...new Set(['admin_geral', 'gestor', ...perfisDaRota(servidor, rota.metodo, rota.caminho)]),
          ].sort();
          expect(
            declarada,
            `${tela.nome}: ${rota.metodo.toUpperCase()} ${rota.caminho} aceita `
              + `[${doServidor.join(', ')}] e a tela oferece [${declarada.join(', ')}]`,
          ).toEqual(doServidor);
        }
      });

      it('e é mais estreita que o escritório — senão a declaração não serviria para nada', () => {
        const declarada = listas.get(tela.constante) ?? [];
        const sobrando = ESCRITORIO.filter((p) => !declarada.includes(p));
        expect(
          sobrando.length,
          `${tela.nome}: nenhum perfil do escritório fica de fora — a constante é decorativa`,
        ).toBeGreaterThan(0);
      });
    });
  }
});

// ============================================================================

describe('quem fica de fora, e por quê', () => {
  const ambientes = arvore(AMBIENTES);
  const listas = listasDeclaradas(ambientes);

  it('estoquista e atendente não respondem pela loja', () => {
    const lista = listas.get('QUEM_RESPONDE_PELA_LOJA') ?? [];
    expect(lista).not.toContain('estoquista');
    expect(lista).not.toContain('atendente');
  });

  it('o gerente da OFICINA não cota frete — e é ele o de fora, aqui', () => {
    /*
      A logística é o contrário das outras quatro: o servidor nomeia
      `gerente_loja` e `estoquista`. Quem despacha encomenda é quem embala, e
      a bancada não embala.
    */
    const lista = listas.get('QUEM_COTA_FRETE') ?? [];
    expect(lista).toContain('estoquista');
    expect(lista).not.toContain('gerente_oficina');
  });
});
