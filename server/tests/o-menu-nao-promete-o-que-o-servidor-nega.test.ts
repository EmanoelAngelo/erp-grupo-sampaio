/**
 * ============================================================================
 * O MENU NÃO PROMETE O QUE O SERVIDOR NEGA
 * ============================================================================
 *
 * ## As quatro camadas que já existem — e o elo que nenhuma delas fecha
 *
 * A defesa por perfil, para os dez perfis que existem (admin_geral, gestor,
 * gerente_loja, gerente_oficina, estoquista, atendente, operador_caixa_loja,
 * operador_caixa_oficina, mecanico e contador), tem quatro camadas testadas,
 * cada uma contra um jeito de burlar:
 *
 *   - `src/pages/gs/__tests__/audit-portas.test.tsx` (120 casos): o MENU só
 *     mostra o permitido e a URL DIRETA não burla — nas quinze telas da
 *     auditoria, o perfil excluído não vê o item nem alcança a rota (o guarda
 *     o devolve para casa), e o permitido continua vendo as duas coisas;
 *   - `src/router/__tests__/environments.test.tsx`: cada perfil entra no seu
 *     AMBIENTE e é devolvido à própria casa ao errar a porta — nunca ao
 *     login, que pareceria sessão expirada;
 *   - `server/tests/contador-varredura-das-rotas.test.ts`: a API não burla —
 *     o perfil de fora bate AUTENTICADO nas 312 rotas do núcleo, método
 *     certo, e cada resposta é conferida, com a lista saindo do AST;
 *   - `server/tests/sessao-do-desligado.test.ts`: o RELOAD não burla — o
 *     refresh pergunta à pessoa de hoje (`core_users`, `session_version`),
 *     não à sessão de ontem.
 *
 * O que as quatro provam é que o navegador e a API OBEDECEM às listas de
 * hoje. O que nenhuma prova é que as listas dizem a verdade sobre o servidor:
 * as de `navItems.ts` foram conferidas contra o `requireProfile` real À MÃO
 * ("rota a rota — nenhuma foi suposta"), e mão não roda no CI. Se amanhã
 * alguém plantar um perfil numa lista, ou o guarda de uma rota estreitar, os
 * quatro arquivos acima continuam verdes — e a porta volta a bater na cara,
 * que é o defeito da rodada 23 pela enésima vez.
 *
 * `cinco-telas-que-batem-na-cara.test.ts` fechou esse elo para as cinco telas
 * de e-commerce. Este arquivo fecha o resto: as QUINZE telas da auditoria
 * integral (fiscal ×4, BI, comissões, usuários, mecânicos, operadoras,
 * conciliação bancária, conferência de maquininha, devoluções, CRM/leads,
 * fidelidade e locação), mais a conciliação de recebimento — a tela nova de
 * compras —, mais auditoria e empresas do grupo, que usam o mesmo mecanismo.
 *
 * ## Como, sem duplicar quinze listas à mão
 *
 * Nada aqui repete perfil de tela nenhuma. O que o arquivo declara é só o
 * MAPA tela → rotas-chave: a listagem que a tela carrega no mount e sem a
 * qual ela é uma casca vazia (ex.: `/sistema/financeiro/comissoes` vive de
 * `GET /commissions/setup` e `GET /commissions/summary`). O resto é derivado:
 *
 *   - do AST de `core.ts` sai o `requireProfile` de cada rota-chave, com
 *     `...CAIXAS` resolvido pela constante do próprio arquivo;
 *   - do AST de `navItems.ts` sai a lista que o ITEM DE MENU declara (com a
 *     herança do grupo, quando o item não declara);
 *   - do AST de `gsRoutes.tsx` sai a lista do quarto argumento de
 *     `protectedRoute`;
 *   - e quem não declara nada oferece o ESCRITÓRIO inteiro — derivado de
 *     `AMBIENTE_POR_PERFIL`, não escrito aqui, para que o sétimo morador da
 *     gestão nasça dentro da régua.
 *
 * A afirmação central: o que o menu e o roteador oferecem ⊆ o que o servidor
 * aceita — lembrando que `requireProfile` libera `admin_geral` e `gestor`
 * ANTES de olhar a lista (e `useHasProfile` repete o atalho do lado de cá),
 * então os dois donos fazem parte do alcance real de toda rota. E, no molde
 * das listas da auditoria ("a lista repete o servidor por inteiro, senão vira
 * uma segunda verdade que envelhece sozinha"), o espelho também cobra a
 * igualdade: oferta mais estreita que o servidor transforma tela em segredo
 * alcançável só por URL, o defeito simétrico.
 *
 * ## Por que mora no servidor, e por AST
 *
 * Pela mesma razão de `cinco-telas-que-batem-na-cara`: quem decide é
 * `requireProfile`, e os arquivos são de projetos com `tsconfig` diferentes
 * que não se importam — o `tsc` deixa os dois compilarem felizes dizendo
 * coisas contrárias. Só um teste que lê os dois lados fica vermelho junto.
 *
 * ## Como este guarda falha (quebrando de propósito — conferido)
 *
 *   - troque a lista do item "BI" em `navItems.ts` por `QUEM_EMITE_NOTA` e
 *     dois casos ficam vermelhos, nomeando os três caixas que
 *     `GET /insights/operations` recusa;
 *   - tire o quarto argumento de `protectedRoute('/sistema/relatorios/bi')`
 *     em `gsRoutes.tsx` e a rota passa a oferecer o escritório: o vermelho
 *     nomeia o estoquista e o atendente na sobra;
 *   - tire `'atendente'` de `GET /leads` no servidor e o espelho fica
 *     vermelho dizendo que o menu ainda o oferece.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '../src/routes/v1/core.ts');
const AMBIENTES = resolve(AQUI, '../../src/router/environments.ts');
const MENU = resolve(AQUI, '../../src/components/gs/navItems.ts');
const ROTAS = resolve(AQUI, '../../src/router/gsRoutes.tsx');

/**
 * Os dois que `requireProfile` libera antes de olhar qualquer lista — e que
 * `useHasProfile` libera do lado de cá. Escritos aqui, e não lidos de
 * `DONOS_DO_GRUPO`, de propósito: se alguém alargar a constante do frontend,
 * este arquivo tem de continuar medindo contra o atalho REAL do servidor —
 * e há um caso lá embaixo cobrando que os dois digam o mesmo.
 */
const DONOS = ['admin_geral', 'gestor'];

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

function semRepeticao(perfis: string[]): string[] {
  return [...new Set(perfis)].sort();
}

// ---------------------------------------------------------------------------
// Leitura das constantes — o mesmo desenho de `cinco-telas-que-batem-na-cara`
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
      /*
        APELIDO DE LISTA conta como lista — `const BALCAO = CAIXAS;`.

        Sem isto, `BALCAO` some do mapa e a leitura de `abertaAo(req,
        'balcao', ...)` teria de chutar quem é o balcão. A ordem de declaração
        resolve: `CAIXAS` nasce antes, e este laço lê o arquivo de cima para
        baixo. Apelido de coisa ainda não lida simplesmente não entra — e aí a
        recusa em voz alta lá embaixo acontece, que é o desfecho certo.
      */
      if (ts.isIdentifier(expr)) {
        const apontada = achadas.get(expr.text);
        if (apontada) achadas.set(decl.name.text, [...apontada]);
        continue;
      }
      if (!ts.isArrayLiteralExpression(expr)) continue;
      const textos = expr.elements.filter(ts.isStringLiteralLike).map((el) => el.text);
      if (textos.length === expr.elements.length) achadas.set(decl.name.text, textos);
    }
  }
  return achadas;
}

/**
 * OS AMBIENTES DO SERVIDOR, lidos de `PERFIS_DO_AMBIENTE` em `core.ts`.
 *
 * Existe porque a tela de consignação (GAP-V65) trouxe a primeira rota-chave
 * guardada por `abertaAo` em vez de `requireProfile` — e o comentário da recusa
 * lá embaixo previa exatamente isto: "se um dia mudar, o certo é um humano
 * reolhar o mapa, não o teste fingir que leu". Reolhado: `abertaAo` não é um
 * guarda mais fraco, é o MESMO `requireProfile` com a lista vindo do ambiente,
 * e ignorá-lo deixaria a tela nova fora da vigilância — que é como as quinze
 * portas da auditoria nasceram.
 *
 * A leitura é do objeto REAL, e não de uma cópia escrita aqui: o dia em que
 * alguém puser um perfil novo no escritório do servidor, este teste enxerga.
 */
function ambientesDoServidor(
  sf: ts.SourceFile,
  listas: Map<string, string[]>,
): Map<string, string[]> {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'PERFIS_DO_AMBIENTE') continue;
      let expr: ts.Expression | undefined = decl.initializer;
      while (expr && (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr))) {
        expr = expr.expression;
      }
      if (!expr || !ts.isObjectLiteralExpression(expr)) continue;
      const mapa = new Map<string, string[]>();
      for (const prop of expr.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) continue;
        mapa.set(prop.name.text, resolverLista(prop.initializer, listas, 'PERFIS_DO_AMBIENTE'));
      }
      return mapa;
    }
  }
  throw new Error('PERFIS_DO_AMBIENTE não encontrado em core.ts');
}

/**
 * Os moradores de um ambiente, lidos de `AMBIENTE_POR_PERFIL`.
 *
 * É a régua do FALLBACK: item ou rota sem lista declarada oferece o ambiente
 * inteiro, e escrever os seis do escritório à mão aqui seria criar a lista
 * que envelhece calada no dia em que nascer o sétimo.
 */
function moradoresDoAmbiente(sf: ts.SourceFile, ambiente: string): string[] {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'AMBIENTE_POR_PERFIL') continue;
      if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      const perfis: string[] = [];
      for (const prop of decl.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (!ts.isIdentifier(prop.name) && !ts.isStringLiteralLike(prop.name)) continue;
        if (ts.isStringLiteralLike(prop.initializer) && prop.initializer.text === ambiente) {
          perfis.push(prop.name.text);
        }
      }
      return perfis;
    }
  }
  throw new Error('AMBIENTE_POR_PERFIL não encontrado em environments.ts');
}

/**
 * Resolve a expressão de uma lista de perfis: um identificador que aponta
 * para uma constante declarada, ou um array de literais escrito ali mesmo.
 * Qualquer outra forma é recusada em voz alta — subcontar perfis deixaria o
 * guarda verde e cego, que é pior que vermelho.
 */
function resolverLista(
  expr: ts.Expression,
  listas: Map<string, string[]>,
  onde: string,
): string[] {
  let alvo: ts.Expression = expr;
  while (ts.isAsExpression(alvo) || ts.isParenthesizedExpression(alvo)) {
    alvo = alvo.expression;
  }
  if (ts.isIdentifier(alvo)) {
    const lista = listas.get(alvo.text);
    if (!lista) throw new Error(`${onde}: a constante \`${alvo.text}\` não é uma lista legível`);
    return [...lista];
  }
  if (ts.isArrayLiteralExpression(alvo) && alvo.elements.every(ts.isStringLiteralLike)) {
    return alvo.elements.map((el) => (el as ts.StringLiteralLike).text);
  }
  throw new Error(`${onde}: não sei ler esta declaração de perfis — o guarda não pode chutar`);
}

// ---------------------------------------------------------------------------
// O lado do servidor
// ---------------------------------------------------------------------------

/**
 * Os perfis que o servidor exige numa rota, pelo método e caminho — como em
 * `cinco-telas`, e com uma leitura a mais: `...CAIXAS` (e qualquer spread de
 * constante do próprio `core.ts`) é resolvido para os nomes, porque é assim
 * que o guarda de `/fiscal/documents` está escrito. Argumento que não dá para
 * resolver derruba o teste, em vez de sumir da conta.
 */
function perfisDaRota(
  sf: ts.SourceFile,
  listasDoServidor: Map<string, string[]>,
  ambientesDoNucleo: Map<string, string[]>,
  metodo: string,
  caminho: string,
): string[] {
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
      let guardaVisto = false;
      const dentro = (n: ts.Node): void => {
        /*
          `abertaAo(req, 'balcao', 'escritorio')` é o MESMO guarda com a lista
          vindo do ambiente — a própria função chama `requireProfile` com os
          perfis dos ambientes citados. Lê-lo aqui é o que põe a tela de
          consignação (GAP-V65) sob esta vigilância; ignorá-lo deixaria a porta
          nova sem vigia, que é como as quinze da auditoria nasceram.
        */
        if (
          !guardaVisto
          && ts.isCallExpression(n)
          && ts.isIdentifier(n.expression)
          && n.expression.text === 'abertaAo'
        ) {
          guardaVisto = true;
          for (const arg of n.arguments.slice(1)) {
            if (!ts.isStringLiteralLike(arg)) {
              throw new Error(
                `${metodo.toUpperCase()} ${caminho}: argumento de abertaAo que não sei ler`,
              );
            }
            const moradores = ambientesDoNucleo.get(arg.text);
            if (!moradores) {
              throw new Error(
                `${metodo.toUpperCase()} ${caminho}: ambiente \`${arg.text}\` não está em PERFIS_DO_AMBIENTE`,
              );
            }
            perfis.push(...moradores);
          }
          return;
        }
        if (
          !guardaVisto
          && ts.isCallExpression(n)
          && ts.isIdentifier(n.expression)
          && n.expression.text === 'requireProfile'
        ) {
          guardaVisto = true;
          // O primeiro argumento é `req`; os perfis vêm depois.
          for (const arg of n.arguments.slice(1)) {
            if (ts.isStringLiteralLike(arg)) {
              perfis.push(arg.text);
            } else if (ts.isSpreadElement(arg) && ts.isIdentifier(arg.expression)) {
              const lista = listasDoServidor.get(arg.expression.text);
              if (!lista) {
                throw new Error(
                  `${metodo.toUpperCase()} ${caminho}: não sei resolver \`...${arg.expression.text}\` no requireProfile`,
                );
              }
              perfis.push(...lista);
            } else {
              throw new Error(
                `${metodo.toUpperCase()} ${caminho}: argumento de requireProfile que não sei ler`,
              );
            }
          }
          return;
        }
        ts.forEachChild(n, dentro);
      };
      ts.forEachChild(node.arguments[node.arguments.length - 1], dentro);
      if (!guardaVisto) {
        /*
          Rota-chave sem guarda nenhum no corpo — nem `requireProfile`, nem
          `abertaAo` — não é um caso que este mapa conheça. Rota de tela que
          não nomeia ninguém é rota aberta, e o certo é um humano reolhar o
          mapa, não o teste fingir que leu.

          (`abertaAo` ENTROU nesta leitura com a tela de consignação, GAP-V65,
          que trouxe a primeira rota-chave guardada por ambiente. Este bloco
          continua de pé para o terceiro caso, que ainda não existe.)
        */
        throw new Error(
          `${metodo.toUpperCase()} ${caminho}: nenhum requireProfile nem abertaAo no corpo — o mapa deste teste precisa ser reolhado`,
        );
      }
      achado = perfis;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);

  if (achado === null) throw new Error(`rota não encontrada: ${metodo} ${caminho}`);
  return achado;
}

// ---------------------------------------------------------------------------
// O lado do navegador — o item de menu e a rota do roteador
// ---------------------------------------------------------------------------

function propriedade(
  objeto: ts.ObjectLiteralExpression,
  nome: string,
): ts.PropertyAssignment | null {
  for (const prop of objeto.properties) {
    if (
      ts.isPropertyAssignment(prop)
      && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
      && prop.name.text === nome
    ) {
      return prop;
    }
  }
  return null;
}

/**
 * A lista de perfis que o ITEM DE MENU de um caminho oferece — a do próprio
 * item ou, na falta dela, a herdada do grupo (é a semântica de `perfilAtende`
 * mais a do `AppShell`: filho sem `profiles` mostra para todos que o grupo
 * mostra). `null` = ninguém declarou nada, e a oferta é o ambiente inteiro.
 */
function perfisDoItemDeMenu(
  sf: ts.SourceFile,
  listas: Map<string, string[]>,
  caminho: string,
): string[] | null {
  const achados: (string[] | null)[] = [];

  const visitar = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const to = propriedade(node, 'to');
      if (to && ts.isStringLiteralLike(to.initializer) && to.initializer.text === caminho) {
        let declarada: string[] | null = null;
        // Sobe do item para o grupo: a primeira declaração encontrada manda.
        for (let atual: ts.Node | undefined = node; atual; atual = atual.parent) {
          if (!ts.isObjectLiteralExpression(atual)) continue;
          const profiles = propriedade(atual, 'profiles');
          if (profiles) {
            declarada = resolverLista(profiles.initializer, listas, `item de menu ${caminho}`);
            break;
          }
        }
        achados.push(declarada);
      }
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);

  if (achados.length === 0) throw new Error(`item de menu não encontrado: ${caminho}`);
  if (achados.length > 1) {
    // "Entrada de notas" mora em dois grupos de propósito; nenhuma tela DESTE
    // mapa pode morar em dois sem que um humano diga qual lista vale.
    throw new Error(`mais de um item de menu aponta para ${caminho} — o mapa precisa ser reolhado`);
  }
  return achados[0];
}

/**
 * A lista do quarto argumento de `protectedRoute(path, el, ambiente, PERFIS)`.
 * `null` = ausente, que é justamente a oferta do ambiente inteiro.
 */
function perfisDaTelaNoRoteador(
  sf: ts.SourceFile,
  listas: Map<string, string[]>,
  caminho: string,
): string[] | null {
  let achado: string[] | null | undefined;

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
      achado = quarto ? resolverLista(quarto, listas, `rota ${caminho}`) : null;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);

  if (achado === undefined) throw new Error(`tela não encontrada no roteador: ${caminho}`);
  return achado;
}

// ---------------------------------------------------------------------------
// O MAPA — a única coisa declarada à mão, e é só tela → rotas-chave
// ---------------------------------------------------------------------------

interface TelaNoMapa {
  nome: string;
  /** O caminho no navegador — o mesmo no menu e no roteador. */
  caminho: string;
  /** As chamadas que a tela faz ao montar, e sem as quais é casca vazia. */
  rotas: { metodo: string; caminho: string }[];
}

const TELAS: TelaNoMapa[] = [
  // ---- A prontidão do dia 1 (GAP-PRD-034) --------------------------------
  {
    nome: 'Prontidão do dia 1',
    caminho: '/sistema/loja/prontidao',
    rotas: [{ metodo: 'get', caminho: '/loja/prontidao-do-dia-1' }],
  },
  // ---- Fiscal, as quatro da gestão -------------------------------------
  {
    nome: 'Documentos fiscais',
    caminho: '/sistema/fiscal/documentos',
    rotas: [{ metodo: 'get', caminho: '/fiscal/documents' }],
  },
  {
    nome: 'Inutilização de numeração',
    caminho: '/sistema/fiscal/inutilizacoes',
    rotas: [
      { metodo: 'get', caminho: '/fiscal/void-ranges' },
      { metodo: 'post', caminho: '/fiscal/void-ranges' },
    ],
  },
  {
    nome: 'Configuração fiscal',
    caminho: '/sistema/fiscal/configuracao',
    rotas: [
      { metodo: 'get', caminho: '/fiscal/config' },
      { metodo: 'get', caminho: '/fiscal/readiness' },
      { metodo: 'get', caminho: '/fiscal/series' },
    ],
  },
  {
    nome: 'Certificado A1',
    caminho: '/sistema/fiscal/certificado',
    rotas: [
      { metodo: 'get', caminho: '/fiscal/certificate' },
      // A visão consolidada do grupo (GAP-V41) monta junto com a tela: se ela
      // negar, o cartão "Certificados das suas operações" nasce vazio.
      { metodo: 'get', caminho: '/fiscal/certificates/group' },
    ],
  },
  // ---- Relatórios ------------------------------------------------------
  {
    nome: 'BI',
    caminho: '/sistema/relatorios/bi',
    rotas: [
      { metodo: 'get', caminho: '/insights/operations' },
      { metodo: 'get', caminho: '/insights/products' },
      { metodo: 'get', caminho: '/insights/margin' },
      // O recorte por marca (GAP-V44) monta junto com a tela: se ele negar, o
      // cartão "Por marca" nasce vazio.
      { metodo: 'get', caminho: '/insights/brands' },
    ],
  },
  {
    /*
      A CENTRAL DE RELATÓRIOS (GAP-V37).

      As DUAS rotas entram no mapa porque a tela morre sem qualquer uma: sem o
      catálogo ela não sabe o que oferecer, e sem o relatório a tabela é uma
      casca. As duas nomeiam os mesmos dois gerentes.
    */
    nome: 'Central de relatórios',
    caminho: '/sistema/relatorios/central',
    rotas: [
      { metodo: 'get', caminho: '/reports' },
      { metodo: 'get', caminho: '/reports/:id' },
    ],
  },
  // ---- Financeiro ------------------------------------------------------
  {
    nome: 'Comissões',
    caminho: '/sistema/financeiro/comissoes',
    rotas: [
      { metodo: 'get', caminho: '/commissions/setup' },
      { metodo: 'get', caminho: '/commissions/summary' },
      // A aba Fechamentos (GAP-PRD-174): é para ela que o título da comissão
      // no contas a pagar leva.
      { metodo: 'get', caminho: '/commissions/closings' },
    ],
  },
  {
    // GAP-PRD-094: a tela vive da projeção (e usa /finance/setup só para o
    // seletor de contas, que ela tolera faltar).
    nome: 'Fluxo de caixa',
    caminho: '/sistema/financeiro/fluxo-de-caixa',
    rotas: [{ metodo: 'get', caminho: '/finance/cash-flow' }],
  },
  {
    nome: 'Operadoras de cartão',
    caminho: '/sistema/financeiro/operadoras',
    rotas: [{ metodo: 'get', caminho: '/acquirers' }],
  },
  {
    nome: 'Conciliação bancária',
    caminho: '/sistema/financeiro/conciliacao',
    rotas: [
      { metodo: 'get', caminho: '/bank/statements' },
      { metodo: 'get', caminho: '/bank/lines' },
      { metodo: 'get', caminho: '/bank/conciliacao' },
    ],
  },
  // ---- Vendas ----------------------------------------------------------
  {
    nome: 'Conferência de maquininha',
    caminho: '/sistema/conferencia-maquininha',
    rotas: [{ metodo: 'get', caminho: '/pdv/terminal/uncertain' }],
  },
  {
    /*
      AS DUAS rotas do mount entram, e a segunda é a que faltava.

      A tela carrega `GET /sale-returns` E `GET /sales` no mesmo `carregar()`.
      Só a primeira estava aqui, e por isso o espelho não enxergou o
      desalinhamento que a liberação pontual criou: as ESCRITAS da tela
      (`POST /sales/:id/cancel` e `POST /sale-returns`) passaram a ser
      `abertaAo(req, 'escritorio')` + `comLiberacaoPontual` — feitas para o
      estoquista e o atendente chamarem um gestor —, enquanto a leitura que a
      tela faz ao montar continuava nomeando quatro perfis à mão, sem os dois.
      O ramo `CORE_RETURN_NEEDS_AUTHORIZATION` ficou sem NENHUM usuário
      alcançável: os quatro que abriam a tela devolvem direto.
    */
    nome: 'Cancelamentos e devoluções',
    caminho: '/sistema/vendas/devolucoes',
    rotas: [
      { metodo: 'get', caminho: '/sale-returns' },
      { metodo: 'get', caminho: '/sales' },
    ],
  },
  // ---- Integrações -----------------------------------------------------
  {
    // A fila de sincronização com a central (GAP-PRD-136): a tela vive de
    // `GET /sync/status`, que é dos dois gerentes. O estoquista e o atendente
    // viam o item e tomavam 403 em toda chamada.
    nome: 'Banco central (Supabase)',
    caminho: '/sistema/integracoes/central',
    rotas: [{ metodo: 'get', caminho: '/sync/status' }],
  },
  // ---- Estoque ---------------------------------------------------------
  {
    /*
      AJUSTES E INVENTÁRIO — a porta que a auditoria integral não varreu.

      A tela morre sem `GET /inventory-counts`: é a lista de contagens, e sem
      ela não há o que abrir, contar nem aplicar. As quatro rotas de contagem
      nomeiam `gerente_loja`, `gerente_oficina` e `estoquista`; o `apply` e o
      `cancel` nomeiam só os dois gerentes. O ATENDENTE não está em nenhuma —
      e morava em `gestao`, então via o item e entrava numa tela em que toda
      chamada volta 403.
    */
    nome: 'Ajustes e inventário',
    caminho: '/sistema/estoque/inventario',
    rotas: [{ metodo: 'get', caminho: '/inventory-counts' }],
  },
  // ---- Pessoas e oficina: a MESMA tela em duas portas ------------------
  {
    nome: 'Usuários e equipe',
    caminho: '/sistema/usuarios',
    rotas: [
      { metodo: 'get', caminho: '/team' },
      { metodo: 'get', caminho: '/team/profiles' },
    ],
  },
  {
    nome: 'Mecânicos e técnicos',
    caminho: '/sistema/oficina/mecanicos',
    rotas: [
      { metodo: 'get', caminho: '/team' },
      { metodo: 'get', caminho: '/team/profiles' },
    ],
  },
  // ---- CRM, fidelidade e locação ---------------------------------------
  {
    nome: 'Leads e oportunidades',
    caminho: '/sistema/crm/leads',
    rotas: [
      { metodo: 'get', caminho: '/leads' },
      { metodo: 'get', caminho: '/opportunities' },
      { metodo: 'get', caminho: '/crm/summary' },
    ],
  },
  {
    nome: 'Fidelidade',
    caminho: '/sistema/crm/fidelidade',
    rotas: [{ metodo: 'get', caminho: '/loyalty/program' }],
  },
  {
    nome: 'Locação',
    caminho: '/sistema/locacao/contratos',
    rotas: [{ metodo: 'get', caminho: '/rentals' }],
  },
  /*
    ---- A tela nova de Compras ------------------------------------------
    A conciliação pedido × NF-e nasceu na rodada desta cadeia de consertos e
    entra no espelho no MESMO commit — é o primeiro guarda automático que ela
    tem. O recorte vem das rotas de PEDIDO, que são as mais estreitas que a
    tela usa (as de conferir/confirmar a nota aceitam também os caixas, mas
    sem ler o pedido a conciliação não existe).
  */
  {
    nome: 'Conciliação de recebimento',
    caminho: '/sistema/compras/conciliacao',
    rotas: [
      { metodo: 'get', caminho: '/purchase-orders' },
      { metodo: 'post', caminho: '/purchase-orders/:id/notes/:noteId' },
    ],
  },
  /*
    ---- As duas irmãs de rodadas anteriores, cobertas de graça ----------
    Auditoria e Empresas fecharam antes da auditoria integral, com o mesmo
    mecanismo (`DONOS_DO_GRUPO` nos três lugares). Derivar não custa lista
    nenhuma, e deixá-las fora seria escolher não vigiar duas portas do
    mesmo corredor.
  */
  {
    nome: 'Auditoria',
    caminho: '/sistema/relatorios/auditoria',
    /*
      A tela passou a consumir DUAS rotas. A seção "Liberações de gestor"
      (GAP-V62) deu leitor a `GET /core/authorizations`, que era órfã desde a
      primeira rodada da alçada — e o guarda dela estreitou no mesmo commit,
      de `gerente_loja, gerente_oficina` para `requireProfile(req)`, justamente
      para casar com esta tela: a lista nomeia o gerente que ASSINOU, e o mesmo
      argumento que fecha a trilha a ele vale aqui inteiro.
    */
    rotas: [
      { metodo: 'get', caminho: '/audit' },
      { metodo: 'get', caminho: '/authorizations' },
    ],
  },
  {
    nome: 'Empresas do grupo',
    caminho: '/sistema/empresas',
    rotas: [{ metodo: 'get', caminho: '/companies' }],
  },
  // A tela Sistema (GAP-PRD-064) nasce vigiada: o cofre é a rota do núcleo
  // que ela lê (`requireProfile(req)`, os donos do grupo); as outras duas são
  // do roteador `/system`, com a mesma lista pela matriz de permissões.
  {
    nome: 'Sistema',
    caminho: '/sistema/configuracoes/sistema',
    rotas: [{ metodo: 'get', caminho: '/system/secrets-readiness' }],
  },
  /*
    ---- A tela nova da consignação (GAP-V65) ----------------------------

    Entra no mapa no MESMO gesto em que nasce, e não numa auditoria daqui a
    seis meses: a lição destas quinze telas é que porta nova sem vigia é porta
    que bate na cara na primeira vez que o guarda do servidor estreitar.

    As DUAS rotas de leitura entram porque a tela morre sem qualquer uma: sem
    a lista ela não tem o que mostrar, e sem o detalhe não há retorno nem
    faturamento. As duas são `abertaAo('balcao', 'escritorio')` — o mesmo
    alcance de `GET /quotes` —, e é por isso que nem o item de menu nem a rota
    declaram lista de perfis: declarar seria oferecer MENOS que o servidor
    aceita, e a igualdade é o que este arquivo cobra dos dois lados.
  */
  {
    nome: 'Consignação (condicional)',
    caminho: '/sistema/consignacoes',
    rotas: [
      { metodo: 'get', caminho: '/consignments' },
      { metodo: 'get', caminho: '/consignments/:id' },
    ],
  },
];

// ============================================================================

describe('o menu não promete o que o servidor nega', () => {
  const servidor = arvore(SERVIDOR);
  const ambientes = arvore(AMBIENTES);
  const menu = arvore(MENU);
  const roteador = arvore(ROTAS, true);

  /*
    As listas que o menu e o roteador podem citar moram em DOIS arquivos —
    as da auditoria em `navItems.ts`, as irmãs mais velhas em
    `environments.ts` — e os nomes não colidem. As do servidor (`CAIXAS`)
    ficam separadas: constante do frontend não resolve spread de rota.
  */
  const listas = new Map([...listasDeclaradas(ambientes), ...listasDeclaradas(menu)]);
  const listasDoServidor = listasDeclaradas(servidor);
  // Os ambientes do SERVIDOR, para ler as rotas guardadas por `abertaAo`.
  const ambientesDoNucleo = ambientesDoServidor(servidor, listasDoServidor);
  const escritorio = moradoresDoAmbiente(ambientes, 'gestao');

  /** Sem declaração, a oferta é o ambiente inteiro — é isso que morde. */
  const ofertaDoMenu = (caminho: string): string[] =>
    perfisDoItemDeMenu(menu, listas, caminho) ?? escritorio;
  const ofertaDoRoteador = (caminho: string): string[] =>
    perfisDaTelaNoRoteador(roteador, listas, caminho) ?? escritorio;
  const aceitosNaRota = (metodo: string, caminho: string): string[] =>
    semRepeticao([
      ...DONOS,
      ...perfisDaRota(servidor, listasDoServidor, ambientesDoNucleo, metodo, caminho),
    ]);

  for (const tela of TELAS) {
    describe(tela.nome, () => {
      it('o menu e o roteador oferecem a mesma lista de perfis', () => {
        expect(
          semRepeticao(ofertaDoMenu(tela.caminho)),
          `${tela.nome} (${tela.caminho}): o item de menu e a rota divergiram — `
            + 'uma das duas declarações mudou sozinha',
        ).toEqual(semRepeticao(ofertaDoRoteador(tela.caminho)));
      });

      it('nenhum perfil oferecido é um que o servidor recusa (oferta ⊆ servidor)', () => {
        const lados = [
          ['menu', semRepeticao(ofertaDoMenu(tela.caminho))],
          ['roteador', semRepeticao(ofertaDoRoteador(tela.caminho))],
        ] as const;
        for (const rota of tela.rotas) {
          const aceitos = aceitosNaRota(rota.metodo, rota.caminho);
          for (const [lado, oferecidos] of lados) {
            const sobra = oferecidos.filter((p) => !aceitos.includes(p));
            expect(
              sobra,
              `${tela.nome}: o ${lado} oferece [${sobra.join(', ')}] e `
                + `${rota.metodo.toUpperCase()} ${rota.caminho} recusa com 403 — `
                + 'a porta que bate na cara, proibida desde a rodada 23',
            ).toEqual([]);
          }
        }
      });

      it('e a oferta espelha o servidor por inteiro — nem mais estreita', () => {
        /*
          A direção simétrica: perfil que o servidor aceita e a lista
          esconde transforma a tela em segredo alcançável só por URL. As
          listas da auditoria repetem o servidor por inteiro de propósito
          (quem não é do ambiente, como os caixas em `QUEM_EMITE_NOTA`, o
          ambiente já barra) — este caso é o que impede a cópia de
          envelhecer.
        */
        const declarada = semRepeticao(ofertaDoMenu(tela.caminho));
        for (const rota of tela.rotas) {
          const aceitos = aceitosNaRota(rota.metodo, rota.caminho);
          expect(
            declarada,
            `${tela.nome}: ${rota.metodo.toUpperCase()} ${rota.caminho} aceita `
              + `[${aceitos.join(', ')}] e a tela oferece [${declarada.join(', ')}]`,
          ).toEqual(aceitos);
        }
      });
    });
  }

  // --------------------------------------------------------------------------

  describe('as âncoras que o espelho assume', () => {
    it('DONOS_DO_GRUPO do navegador é exatamente o atalho do servidor', () => {
      /*
        `useHasProfile` deixa passar quem está em `DONOS_DO_GRUPO` sem olhar
        lista nenhuma — o espelho de `requireProfile(req)`. Se a constante
        alargar, o navegador passa a mostrar tudo a um perfil que o servidor
        recusa, e nenhuma comparação de lista acima enxergaria: a promessa
        estaria no atalho, não na lista.
      */
      expect(semRepeticao([...(listas.get('DONOS_DO_GRUPO') ?? [])])).toEqual(
        semRepeticao(DONOS),
      );
    });

    it('o escritório derivado contém quem a auditoria expulsou', () => {
      /*
        A régua do fallback não pode encolher calada: se a leitura de
        `AMBIENTE_POR_PERFIL` quebrar e devolver menos gente, "sem declaração
        = escritório inteiro" deixaria de morder — vazio ⊆ qualquer coisa.
        O estoquista e o atendente são exatamente os dois que colecionavam
        403, então são eles que o fallback tem de continuar carregando.
      */
      expect(escritorio).toContain('estoquista');
      expect(escritorio).toContain('atendente');
      expect(escritorio.length).toBeGreaterThanOrEqual(6);
    });
  });
});
