/**
 * ============================================================================
 * OS DOIS RECORDS DE AMBIENTE, AMARRADOS
 * ============================================================================
 *
 * ## O defeito que não existe até existir
 *
 * "Quem trabalha onde" está escrito DUAS VEZES neste projeto:
 *
 *   - `server/src/routes/v1/core.ts`  → `PERFIS_DO_AMBIENTE`, ambiente → perfis
 *   - `src/router/environments.ts`    → `AMBIENTE_POR_PERFIL`, perfil → ambiente
 *
 * São arquivos de projetos diferentes, com `tsconfig` diferentes, e nenhum
 * importa o outro. O `tsc` não conhece nenhuma relação entre eles: os dois
 * compilam, sozinhos e felizes, dizendo coisas contrárias.
 *
 * E o sintoma da divergência é ruim dos dois lados:
 *
 *   - navegador MAIS LARGO que o servidor: o menu oferece a tela, a pessoa
 *     clica, e todas as chamadas voltam 403. É a tela em branco com cara de
 *     defeito — o erro que a rodada 23 nomeou "guarda mais estreito que a
 *     tela" e que voltou em quatro rodadas seguidas.
 *
 *   - servidor MAIS LARGO que o navegador: a rota entrega dado que tela
 *     nenhuma oferece. Não quebra nada visível, e é pior por isso: um perfil
 *     alcança pela API o que ninguém decidiu dar a ele, e a decisão fica
 *     invisível porque não há tela onde vê-la.
 *
 * A rodada 29 é exatamente o momento em que isto passa de risco a certeza: o
 * quarto ambiente (`contabilidade`) nasce nos dois arquivos, no mesmo dia, por
 * mãos diferentes. Se um dos dois lados esquecer, nada avisa.
 *
 * ## Por que este teste mora no SERVIDOR
 *
 * Porque é o servidor que decide. `canAccess` do navegador é navegação; quem
 * responde 403 é `requireProfile`. A suíte que precisa ficar vermelha é a que
 * guarda o lado que manda.
 *
 * ## Por que AST, e não importar os dois módulos
 *
 * `core.ts` não exporta `PERFIS_DO_AMBIENTE` — e não deve: é detalhe interno
 * do roteador, e exportá-lo só para o teste seria alargar a superfície pública
 * de um arquivo de 8000 linhas por conveniência de suíte. `environments.ts`,
 * do outro lado, é módulo de frontend: importá-lo daqui arrastaria o
 * `tsconfig` do navegador para dentro do servidor.
 *
 * Ler a árvore resolve os dois: é a mesma que o compilador enxerga, e não
 * obriga nenhum dos arquivos a mudar de forma para caber no teste.
 *
 * ## ELE FICA VERMELHO ENQUANTO SÓ UM DOS LADOS TIVER LANDADO
 *
 * E isso é o teste funcionando, não o teste quebrado. A rodada 29 foi
 * construída em duas metades — servidor e navegador — e este arquivo é a
 * costura entre elas. Enquanto `src/router/environments.ts` não tiver
 * `contabilidade` no union `Environment`, `contador: 'contabilidade'` em
 * `AMBIENTE_POR_PERFIL` e uma entrada em `CASA`, os casos abaixo apontam
 * exatamente o que falta, com o perfil e os dois lados da contradição escritos
 * na mensagem.
 *
 * Medido: com as três linhas do navegador no lugar, os 8 casos passam.
 * Trocando `estoquista: 'gestao'` por `'pdv'` no navegador, dois casos ficam
 * vermelhos dizendo "estoquista: servidor diz `escritorio` (= `gestao`),
 * navegador diz `pdv`" — que é o formato de vermelho que esta costura existe
 * para produzir.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '../src/routes/v1/core.ts');
const NAVEGADOR = resolve(AQUI, '../../src/router/environments.ts');

function arvore(caminho: string): ts.SourceFile {
  // Se o arquivo sumir de lugar, o teste FALHA em vez de se pular. Um teste
  // que se pula sozinho quando o alvo muda de caminho é um teste que deixa de
  // existir sem ninguém notar.
  expect(existsSync(caminho), `arquivo não encontrado: ${caminho}`).toBe(true);
  return ts.createSourceFile(
    caminho,
    readFileSync(caminho, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

// ---------------------------------------------------------------------------
// Leitura genérica
// ---------------------------------------------------------------------------

/** Todo `const NOME = ...` de primeiro nível, pelo nome. */
function constantes(sf: ts.SourceFile): Map<string, ts.Expression> {
  const achadas = new Map<string, ts.Expression>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        achadas.set(decl.name.text, decl.initializer);
      }
    }
  }
  return achadas;
}

/** Tira o `as const` / `as Record<...>` da frente de uma expressão. */
function semAsserção(expr: ts.Expression): ts.Expression {
  let atual = expr;
  while (ts.isAsExpression(atual) || ts.isParenthesizedExpression(atual)) {
    atual = atual.expression;
  }
  return atual;
}

/**
 * Uma lista de strings, resolvendo alias (`const BALCAO = CAIXAS;`).
 *
 * Sem resolver o alias, `balcao` sairia vazio e o teste ficaria verde por
 * comparar nada com nada — exatamente a forma de falso verde que este arquivo
 * existe para não ter.
 */
function listaDeTextos(
  expr: ts.Expression,
  todas: Map<string, ts.Expression>,
  profundidade = 0,
): string[] {
  if (profundidade > 5) throw new Error('alias encadeado demais para resolver');
  const alvo = semAsserção(expr);
  if (ts.isIdentifier(alvo)) {
    const apontado = todas.get(alvo.text);
    if (!apontado) throw new Error(`não achei a constante \`${alvo.text}\``);
    return listaDeTextos(apontado, todas, profundidade + 1);
  }
  if (!ts.isArrayLiteralExpression(alvo)) {
    throw new Error('esperava uma lista de textos');
  }
  return alvo.elements.map((el) => {
    if (!ts.isStringLiteralLike(el)) throw new Error('elemento que não é texto literal');
    return el.text;
  });
}

/** As chaves de um objeto literal, na ordem em que estão escritas. */
function chavesDoObjeto(expr: ts.Expression): string[] {
  const alvo = semAsserção(expr);
  if (!ts.isObjectLiteralExpression(alvo)) throw new Error('esperava um objeto literal');
  return alvo.properties.map((p) => {
    const nome = p.name;
    if (!nome) throw new Error('propriedade sem nome');
    if (ts.isIdentifier(nome) || ts.isStringLiteralLike(nome)) return nome.text;
    throw new Error('nome de propriedade que não é identificador nem texto');
  });
}

// ---------------------------------------------------------------------------
// O lado do servidor
// ---------------------------------------------------------------------------

/** `PERFIS_DO_AMBIENTE` de `core.ts`: ambiente → perfis. */
function ambientesDoServidor(): Map<string, string[]> {
  const sf = arvore(SERVIDOR);
  const todas = constantes(sf);
  const record = todas.get('PERFIS_DO_AMBIENTE');
  if (!record) throw new Error('`PERFIS_DO_AMBIENTE` sumiu de core.ts');

  const objeto = semAsserção(record);
  if (!ts.isObjectLiteralExpression(objeto)) throw new Error('`PERFIS_DO_AMBIENTE` não é objeto');

  const saida = new Map<string, string[]>();
  for (const prop of objeto.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error('`PERFIS_DO_AMBIENTE` tem propriedade em forma não reconhecida');
    }
    const nome = prop.name;
    if (!ts.isIdentifier(nome) && !ts.isStringLiteralLike(nome)) {
      throw new Error('ambiente com nome não literal');
    }
    saida.set(nome.text, listaDeTextos(prop.initializer, todas));
  }
  return saida;
}

/** Os membros do union `type Ambiente = ...` de `core.ts`. */
function unionAmbiente(): string[] {
  const sf = arvore(SERVIDOR);
  for (const statement of sf.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Ambiente') {
      const tipo = statement.type;
      if (!ts.isUnionTypeNode(tipo)) throw new Error('`Ambiente` deixou de ser union');
      return tipo.types.map((t) => {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteralLike(t.literal)) return t.literal.text;
        throw new Error('membro de `Ambiente` que não é texto literal');
      });
    }
  }
  throw new Error('`type Ambiente` sumiu de core.ts');
}

// ---------------------------------------------------------------------------
// O lado do navegador
// ---------------------------------------------------------------------------

/** `AMBIENTE_POR_PERFIL` de `environments.ts`: perfil → ambiente. */
function ambientesDoNavegador(): Map<string, string> {
  const sf = arvore(NAVEGADOR);
  const record = constantes(sf).get('AMBIENTE_POR_PERFIL');
  if (!record) throw new Error('`AMBIENTE_POR_PERFIL` sumiu de environments.ts');

  const objeto = semAsserção(record);
  if (!ts.isObjectLiteralExpression(objeto)) {
    throw new Error('`AMBIENTE_POR_PERFIL` não é objeto');
  }

  const saida = new Map<string, string>();
  for (const prop of objeto.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error('`AMBIENTE_POR_PERFIL` tem propriedade em forma não reconhecida');
    }
    const nome = prop.name;
    const valor = prop.initializer;
    if (!ts.isIdentifier(nome) && !ts.isStringLiteralLike(nome)) {
      throw new Error('perfil com nome não literal');
    }
    if (!ts.isStringLiteralLike(valor)) throw new Error('ambiente que não é texto literal');
    saida.set(nome.text, valor.text);
  }
  return saida;
}

/** Os membros do union `type Environment = ...` de `environments.ts`. */
function unionEnvironment(): string[] {
  const sf = arvore(NAVEGADOR);
  for (const statement of sf.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Environment') {
      const tipo = statement.type;
      if (!ts.isUnionTypeNode(tipo)) throw new Error('`Environment` deixou de ser union');
      return tipo.types.map((t) => {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteralLike(t.literal)) return t.literal.text;
        throw new Error('membro de `Environment` que não é texto literal');
      });
    }
  }
  throw new Error('`type Environment` sumiu de environments.ts');
}

/** As chaves de `CASA` — todo ambiente precisa ter para onde levar a pessoa. */
function casasDoNavegador(): string[] {
  const sf = arvore(NAVEGADOR);
  const casa = constantes(sf).get('CASA');
  if (!casa) throw new Error('`CASA` sumiu de environments.ts');
  return chavesDoObjeto(casa);
}

// ---------------------------------------------------------------------------
// A tradução, que é o contrato
// ---------------------------------------------------------------------------

/**
 * Servidor → navegador. Os nomes são diferentes por história, não por decisão.
 *
 * O servidor fala do PRÉDIO (`balcao`, `bancada`, `escritorio`); o navegador
 * fala da TELA (`pdv`, `oficina`, `gestao`). São os mesmos três lugares com
 * dois vocabulários, e o quarto — `contabilidade` — nasceu depois dessa
 * bifurcação e por isso tem o mesmo nome dos dois lados.
 *
 * Esta tabela é o único lugar do projeto onde a correspondência está escrita.
 * Ela mesma é conferida abaixo: se um ambiente nascer de um lado e não estiver
 * aqui, o teste diz isso em vez de ignorá-lo.
 */
const TRADUCAO: Record<string, string> = {
  balcao: 'pdv',
  bancada: 'oficina',
  escritorio: 'gestao',
  contabilidade: 'contabilidade',
};

/**
 * Os dois perfis que estão no navegador de propósito e NÃO no servidor.
 *
 * `requireProfile` devolve cedo para `admin_geral` e `gestor` antes de olhar
 * qualquer lista — e `core.ts` escreve, ao lado de `ESCRITORIO`, que repeti-los
 * na lista criaria uma segunda cópia dessa regra para divergir da primeira. O
 * navegador precisa deles porque `homeOf` tem de saber para onde levar um
 * gestor que acaba de entrar.
 *
 * A exceção está aqui NOMEADA e é COBRADA nos dois sentidos logo abaixo: não é
 * um `filter` que engole o que não bate, é uma afirmação sobre exatamente dois
 * códigos.
 */
const SO_NO_NAVEGADOR = ['admin_geral', 'gestor'];

// ---------------------------------------------------------------------------
// Os casos
// ---------------------------------------------------------------------------

describe('a leitura dos dois arquivos é honesta', () => {
  it('o servidor tem os quatro ambientes, e o union bate com o Record', () => {
    // Se a leitura por AST voltar vazia, tudo o que vem depois compara nada
    // com nada e fica verde. Este caso é o que impede isso.
    const servidor = ambientesDoServidor();
    expect([...servidor.keys()].sort()).toEqual([
      'balcao',
      'bancada',
      'contabilidade',
      'escritorio',
    ]);
    expect(unionAmbiente().sort()).toEqual([...servidor.keys()].sort());
    // E cada lista tem gente: um ambiente vazio negaria todo mundo em silêncio.
    for (const [ambiente, perfis] of servidor) {
      expect(perfis.length, `o ambiente \`${ambiente}\` está vazio`).toBeGreaterThan(0);
    }
  });

  it('o navegador tem os quatro Environment, e CASA leva cada um a algum lugar', () => {
    const environments = unionEnvironment();
    expect(environments.sort()).toEqual(['contabilidade', 'gestao', 'oficina', 'pdv']);
    // `CASA` é `Record<Environment, string>`: o `tsc` do navegador já cobraria
    // a chave faltando. O que ele NÃO cobra é o inverso — uma casa a mais, de
    // um ambiente que deixou de existir — e é isso que esta comparação pega.
    expect(casasDoNavegador().sort()).toEqual(environments.sort());
  });

  it('a tabela de tradução cobre os dois lados, sem sobra nem falta', () => {
    const doServidor = [...ambientesDoServidor().keys()].sort();
    expect(Object.keys(TRADUCAO).sort()).toEqual(doServidor);
    expect(Object.values(TRADUCAO).sort()).toEqual(unionEnvironment().sort());
  });
});

describe('perfil a perfil, os dois lados dizem a mesma coisa', () => {
  it('todo perfil que o servidor põe num ambiente está no MESMO ambiente no navegador', () => {
    const servidor = ambientesDoServidor();
    const navegador = ambientesDoNavegador();

    const divergentes: string[] = [];
    for (const [ambiente, perfis] of servidor) {
      for (const perfil of perfis) {
        const esperado = TRADUCAO[ambiente];
        const noNavegador = navegador.get(perfil);
        if (noNavegador !== esperado) {
          divergentes.push(
            `${perfil}: servidor diz \`${ambiente}\` (= \`${esperado}\`), `
              + `navegador diz \`${noNavegador ?? '(ausente)'}\``,
          );
        }
      }
    }
    // A lista vazia é o verde. O vermelho traz o perfil pelo nome e os dois
    // lados da contradição, que é o que se precisa para consertar sem abrir
    // nenhum dos dois arquivos.
    expect(divergentes).toEqual([]);
  });

  it('e todo perfil do navegador está no mesmo ambiente no servidor', () => {
    /*
      O sentido oposto, e ele não é redundante: um perfil que só existe no
      navegador é uma tela oferecida a quem a rota recusa. Foi assim que o item
      "PDV" ficou anos no menu da gestão sem a rota correspondente aceitar
      `gestao` — está contado em `environments.ts`.
    */
    const servidor = ambientesDoServidor();
    const navegador = ambientesDoNavegador();

    const ondeOServidorPoe = new Map<string, string>();
    for (const [ambiente, perfis] of servidor) {
      for (const perfil of perfis) ondeOServidorPoe.set(perfil, TRADUCAO[ambiente]!);
    }

    const divergentes: string[] = [];
    for (const [perfil, ambiente] of navegador) {
      if (SO_NO_NAVEGADOR.includes(perfil)) continue;
      const noServidor = ondeOServidorPoe.get(perfil);
      if (noServidor !== ambiente) {
        divergentes.push(
          `${perfil}: navegador diz \`${ambiente}\`, `
            + `servidor diz \`${noServidor ?? '(ausente de todos os ambientes)'}\``,
        );
      }
    }
    expect(divergentes).toEqual([]);
  });

  it('a exceção dos dois donos do grupo é exatamente essa — e é cobrada nos dois sentidos', () => {
    const navegador = ambientesDoNavegador();
    const doServidor = new Set([...ambientesDoServidor().values()].flat());

    for (const perfil of SO_NO_NAVEGADOR) {
      // Está no navegador: `homeOf` precisa saber para onde levar o gestor.
      expect(navegador.has(perfil), `${perfil} sumiu de AMBIENTE_POR_PERFIL`).toBe(true);
      // E NÃO está no servidor: a regra de que eles passam por cima de tudo
      // tem uma implementação só, dentro de `requireProfile`.
      expect(doServidor.has(perfil), `${perfil} virou item de lista de ambiente`).toBe(false);
    }

    /*
      E a exceção não cresce sozinha. Se um terceiro perfil aparecer só no
      navegador, o caso acima já o pega — mas só enquanto ninguém o acrescentar
      a `SO_NO_NAVEGADOR` para "consertar o vermelho". Este número é o pedágio:
      mexer nele obriga a escrever por que o terceiro perfil merece a exceção.
    */
    expect(SO_NO_NAVEGADOR).toHaveLength(2);
  });
});

describe('o contador, que é o ambiente novo desta rodada', () => {
  it('mora sozinho na contabilidade, dos dois lados', () => {
    /*
      "Sozinho" é a metade que protege. `contador` não pertencer a nenhum outro
      ambiente é o que faz TODA rota guardada por `abertaAo` recusá-lo sem
      ninguém escrever uma linha sobre ela — e é o que a varredura das 310
      rotas mede na outra ponta.
    */
    const servidor = ambientesDoServidor();
    expect(servidor.get('contabilidade')).toEqual(['contador']);

    const outros = [...servidor]
      .filter(([ambiente]) => ambiente !== 'contabilidade')
      .flatMap(([, perfis]) => perfis);
    expect(outros).not.toContain('contador');

    expect(ambientesDoNavegador().get('contador')).toBe('contabilidade');
  });

  it('e a casa dele não é a casa da gestão', () => {
    // Se `CASA.contabilidade` apontasse para `/sistema/painel`, `homeOf` o
    // levaria para um painel que responde 403 inteiro — a tela em branco com
    // cara de defeito, no primeiro segundo do primeiro acesso dele.
    const sf = arvore(NAVEGADOR);
    const casa = constantes(sf).get('CASA');
    const objeto = semAsserção(casa!);
    if (!ts.isObjectLiteralExpression(objeto)) throw new Error('`CASA` não é objeto');

    const destinos = new Map<string, string>();
    for (const prop of objeto.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const nome = prop.name;
      if ((ts.isIdentifier(nome) || ts.isStringLiteralLike(nome))
        && ts.isStringLiteralLike(prop.initializer)) {
        destinos.set(nome.text, prop.initializer.text);
      }
    }
    const dele = destinos.get('contabilidade');
    expect(dele, '`CASA.contabilidade` não existe').toBeDefined();
    expect(dele).not.toBe(destinos.get('gestao'));
  });
});
