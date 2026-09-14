/**
 * ============================================================================
 * A ROTA 298 NÃO NASCE CALADA
 * ============================================================================
 *
 * ## Por que esta regra existe
 *
 * `src/routes/v1/core.ts` tem 297 rotas. Durante vinte e duas rodadas, 52
 * delas foram nascendo sem dizer nada sobre quem as alcança — não de uma vez,
 * mas UMA DE CADA VEZ. A rodada 23 fechou as 52. Se a história parasse aí, a
 * rodada 24 recomeçaria a contagem do zero, porque a causa não é o estoque de
 * rotas caladas: é que o SILÊNCIO É INDISTINGUÍVEL DE "ABERTA DE PROPÓSITO".
 * Uma rota que ninguém guardou e uma rota que alguém decidiu abrir têm
 * exatamente a mesma cara no código, e ninguém revisa o que não tem cara de
 * nada.
 *
 * Esta regra dá cara ao silêncio. A partir dela, a rota calada não compila o
 * portão de lint — e quem escrever a rota 298 é obrigado a tomar a decisão no
 * momento em que ela é barata, que é enquanto se escreve a rota.
 *
 * ## Por que AST e não regex
 *
 * Este projeto já pagou por essa lição. A primeira varredura de rotas caladas
 * foi feita com regex exigindo `requireProfile(req` na mesma linha, e contou
 * 55 onde havia 52 — porque várias chamadas estão quebradas em duas linhas
 * pelo formatador. Uma varredura seguinte, mais frouxa, contou 63, porque
 * onze rotas põem o corpo dentro de uma IIFE assíncrona e o regex não sabia
 * descer nela. Regex conta texto; a pergunta aqui é sobre ESTRUTURA. A regra
 * lê a árvore que o próprio parser do TypeScript produz — a mesma que o
 * compilador enxerga.
 *
 * ## O CRITÉRIO: onde a declaração vale, e por quê
 *
 * Uma crítica derrubou a primeira especificação, que era "procurar a chamada
 * em qualquer profundidade dentro do handler". Nessa forma, isto passaria:
 *
 *     coreRouter.get('/x', (req, res, next) => {
 *       if (req.query.modoAntigo === '1') requireProfile(req, 'gerente_loja');
 *       res.json(dadosDaEmpresa(req));
 *     });
 *
 * O guarda existe, a regra fica verde, e a rota está aberta para todo mundo
 * que não mandar `modoAntigo=1`. O mesmo vale para a chamada enterrada num
 * callback que só roda depois da resposta.
 *
 * Então o critério é POSICIONAL, e a razão tem uma frase só: só vale a
 * declaração cuja execução é INCONDICIONAL — todo caminho que chega ao
 * handler passa por ela antes de qualquer trabalho. Na prática, a chamada tem
 * de ser um statement de PRIMEIRO NÍVEL de um destes três lugares:
 *
 *   1. o corpo do handler;
 *   2. o bloco do `try` de primeiro nível do handler — que é como as 297
 *      rotas deste arquivo são escritas, porque o `catch (err) { next(err) }`
 *      é o que transforma o 403 lançado pelo guarda em resposta HTTP;
 *   3. o corpo de uma IIFE assíncrona de primeiro nível — `(async () => {
 *      ... })()`, com ou sem `void` na frente, com ou sem `.catch(next)`
 *      pendurado. Onze rotas de `core.ts` são escritas assim, e recusá-las
 *      seria condenar código correto. Ela é incondicional pelo mesmo motivo:
 *      é invocada na hora, não guardada para depois.
 *
 * Estes três lugares se combinam e se aninham (IIFE contendo `try`, que é o
 * caso real das onze). O que NÃO vale, e é recusado de propósito: dentro de
 * `if`, de laço, de `switch`, de `&&`, de ternário, ou dentro de uma função
 * passada como argumento para outra coisa — tudo isso é execução condicional
 * ou adiada, e um guarda que talvez rode não é um guarda.
 *
 * Quando a chamada EXISTE mas está num desses lugares recusados, a regra não
 * diz "não tem guarda" — ela diz onde está e por que não conta. Errar a
 * mensagem aqui seria caro: quem lê "não declara alcance" numa rota que
 * visivelmente chama `requireProfile` conclui que a regra está quebrada, e a
 * próxima coisa que a pessoa faz é desligá-la.
 *
 * ## O handler tem de ser inline
 *
 * Se o handler for uma referência (`coreRouter.get('/x', tratarX)`), a regra
 * não tem como ver o corpo, e uma regra que se cala diante do que não entende
 * vira uma porta. As 297 rotas de hoje são todas inline; a regra exige que
 * continuem, e diz isso na mensagem.
 *
 * ## O que a regra NÃO faz
 *
 * Não julga se o alcance escolhido está CERTO. `abertaAo(req, 'escritorio')`
 * numa rota que o PDV consome passa por aqui e quebra a tela em produção.
 * Isso é trabalho de gente lendo o roteador do navegador, e é por isso que a
 * mensagem manda escrever o motivo em comentário: o comentário é o único
 * lugar onde a próxima pessoa descobre QUAL tela consome a rota sem refazer a
 * investigação inteira.
 */

import { readFileSync } from 'node:fs';

const METODOS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * O que o roteador aceita receber sem ser uma rota.
 *
 * Hoje é um só: `coreRouter.use(authMiddleware)`, que monta a autenticação do
 * roteador inteiro. Qualquer OUTRA coisa chamada no roteador — `.route()`,
 * `.all()`, `.head()` — é reportada como forma não reconhecida, e é de
 * propósito: `.route('/x').get(h)` e `.all('/x', h)` são API de primeira classe
 * do Express e passariam por esta regra sem um arranhão, porque o `callee` não
 * é um dos cinco nomes que ela conhece.
 *
 * Regra que se cala diante do que não entende é uma porta — está escrito no
 * cabeçalho deste arquivo, e esta lista é o que faz a frase valer para ela
 * mesma. Se um dia `.route()` for necessário, o caminho é ensinar a regra a
 * lê-lo, não deixá-la em silêncio.
 */
const NAO_E_ROTA = new Set(['use']);

/**
 * Os jeitos legítimos de declarar alcance neste projeto.
 *
 * As três LEGADAS perguntam pelo PERFIL e morrem por fatias na F2 do RBAC
 * granular — a catraca (`tests/rbac/catraca-das-guardas-legadas.test.ts`) só
 * as deixa diminuir, e a F5 as tira daqui. As cinco NOVAS perguntam pela
 * CAPABILITY do vínculo, e valem nos mesmos lugares incondicionais; a
 * capability tem de ser literal e existir no catálogo (`capabilityDesconhecida`).
 */
const GUARDAS_LEGADAS = ['abertaAo', 'requireProfile', 'requirePermission'];

/** Guarda por capability → a posição do primeiro argumento que é capability. */
const GUARDAS_POR_CAPABILITY = new Map([
  ['requireCapability', 1],
  ['requireAnyCapability', 1],
  ['requireAllCapabilities', 1],
  ['comCapability', 0],
  ['comQualquerCapability', 0],
]);

const GUARDAS = new Set([...GUARDAS_LEGADAS, ...GUARDAS_POR_CAPABILITY.keys()]);

/**
 * Os códigos do catálogo, lidos de `src/services/auth/Capabilities.ts` — uma
 * fonte só. A regra é JavaScript e não importa TypeScript; uma cópia da lista
 * aqui dentro divergiria na primeira capability nova. O arquivo é gerado
 * (`scripts/rbac/gerar-artefatos.mjs`) e a leitura se limita ao bloco
 * `CATALOGO` (os modelos, mais abaixo, também têm `code:`). O teste da regra
 * confere que o que se lê aqui é exatamente `CAPABILITIES`.
 */
let catalogoLido = null;
export function codigosDoCatalogo() {
  if (!catalogoLido) {
    const texto = readFileSync(new URL('../src/services/auth/Capabilities.ts', import.meta.url), 'utf8');
    const inicio = texto.indexOf('export const CATALOGO = [');
    const fim = texto.indexOf('] as const', inicio);
    if (inicio < 0 || fim < 0) {
      throw new Error('rota-declara-alcance: não achei o bloco CATALOGO em src/services/auth/Capabilities.ts');
    }
    catalogoLido = new Set([...texto.slice(inicio, fim).matchAll(/\bcode:\s*["']([a-z0-9_.]+)["']/g)].map((m) => m[1]));
  }
  return catalogoLido;
}

/**
 * A declaração de rota pública DE PROPÓSITO.
 *
 * Rota sem guarda nenhuma é indistinguível de esquecimento — é a frase que
 * abre este arquivo. Mas o sistema TEM rotas sem guarda por desenho: login
 * (quando ela roda, não existe sessão), a vitrine da loja, o webhook do
 * Asaas, os `/health`. Sem um jeito de DECLARAR isso, elas nunca passariam
 * por esta regra — e a alternativa, uma allowlist de caminhos dentro da
 * config, seria mágica invisível: a rota parece calada no arquivo e passa
 * por motivo que só a config conhece.
 *
 * `rotaPublica('motivo')` é a declaração. O MOTIVO é obrigatório e tem de
 * ser um literal de string não vazio: uma declaração sem motivo é só um
 * jeito novo de silenciar a regra, e é recusada com mensagem própria.
 */
const DECLARACAO_PUBLICA = 'rotaPublica';

/**
 * O irmão de `rotaPublica` no RBAC granular: `soAutenticado('motivo')`, a rota
 * que exige SESSÃO e não pede capability nenhuma, porque opera só sobre a
 * própria sessão (trocar a própria senha, sair, consultar, trocar de empresa).
 * Mesmas exigências: motivo literal não vazio, e nunca junto de uma guarda.
 */
const DECLARACAO_AUTENTICADA = 'soAutenticado';

/**
 * O que NÃO conta como declaração, de propósito: `authMiddleware`.
 *
 * Autenticar responde "quem é você"; alcance responde "o que você pode".
 * As duas rotas de carrinho/pedido de `storefronts.ts` que a rodada 29
 * consertou tinham `authMiddleware` e nada mais — qualquer perfil
 * autenticado, inclusive o contador (pessoa de FORA da operação), criava
 * pedido com valor vindo do corpo da requisição. Se `authMiddleware`
 * contasse como declaração, esse buraco seria verde de novo.
 */

/** Profundidade máxima de desembrulho de IIFE/try aninhados. */
const PROFUNDIDADE_MAXIMA = 6;

// ---------------------------------------------------------------------------
// Leitura da árvore
// ---------------------------------------------------------------------------

/** `coreRouter.get(...)` → 'get'. Qualquer outra coisa → null. */
export function metodoDeRota(node, roteadores) {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.object?.type !== 'Identifier') return null;
  if (!roteadores.includes(callee.object.name)) return null;
  if (callee.property?.type !== 'Identifier') return null;
  const nome = callee.property.name;
  if (METODOS.has(nome)) return nome;
  // Forma no roteador que não é rota conhecida nem middleware permitido: quem
  // decide é o chamador, e ele reporta em vez de ignorar.
  return NAO_E_ROTA.has(nome) ? null : { formaDesconhecida: nome };
}

/** O caminho da rota, só para a mensagem de erro ser útil. */
export function caminhoDeRota(node) {
  const primeiro = node.arguments?.[0];
  if (primeiro?.type === 'Literal' && typeof primeiro.value === 'string') return primeiro.value;
  if (primeiro?.type === 'TemplateLiteral' && primeiro.quasis.length === 1) {
    return primeiro.quasis[0].value.cooked;
  }
  return '(caminho não literal)';
}

/**
 * O handler é o ÚLTIMO argumento que é função escrita ali mesmo.
 *
 * Último, e não segundo, porque express aceita middlewares no meio
 * (`router.get(path, limitador, handler)`) e é o final da cadeia que responde.
 */
export function handlerInline(node) {
  const args = node.arguments ?? [];
  for (let i = args.length - 1; i >= 1; i -= 1) {
    const a = args[i];
    if (a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression') return a;
  }
  return null;
}

/**
 * O SEGUNDO idioma de guarda deste servidor: o middleware na lista de
 * argumentos, antes do handler.
 *
 *     logisticsRouter.get('/shipments', authMiddleware,
 *       requirePermission('logistics.shipment.view'), (req, res) => { ... });
 *
 * Por que isso vale tanto quanto a primeira linha do corpo: o Express roda os
 * middlewares NA ORDEM e INCONDICIONALMENTE antes do handler — não existe
 * caminho de execução que chegue ao trabalho sem passar por eles. É o mesmo
 * critério posicional do outro idioma, só que garantido pelo framework em vez
 * de pela posição no bloco.
 *
 * O que conta é a CHAMADA de um nome de GUARDAS (`requirePermission('x')`) ou
 * a declaração pública (`rotaPublica('motivo')`). Um Identifier solto como
 * `authMiddleware` NÃO conta — ver o comentário em DECLARACAO_PUBLICA — e um
 * handler-função também não é argumento de guarda.
 *
 * Devolve:
 *   { situacao: 'declarada', guarda }        — guarda de verdade no argumento
 *   { situacao: 'publica', guarda }          — rotaPublica com motivo não vazio
 *   { situacao: 'publica-sem-motivo', guarda } — rotaPublica silenciada
 *   null                                     — nenhum argumento declara nada
 */
export function guardaNosArgumentos(node) {
  const args = node.arguments ?? [];
  /*
    SÓ CONTA O QUE VEM **ANTES** DO HANDLER — e isto foi um furo medido, não
    zelo.

    O Express executa os argumentos na ordem, e o handler inline é quem
    RESPONDE: um middleware colocado depois dele nunca roda.
    `crmRouter.get('/x', handler, requirePermission('crm.lead.view'))` passava
    nesta função como "declarada", com a guarda pendurada num lugar que a
    execução jamais alcança — rota aberta com o portão verde, que é o defeito
    exato que a regra existe para impedir.

    Por isso a varredura PARA no primeiro argumento que é função inline. Guarda
    depois desse ponto não é guarda; é decoração.

    E as declarações são COLETADAS, não devolvidas na primeira: uma rota com
    `rotaPublica(...)` E `requirePermission(...)` juntos é uma contradição —
    alguém declarou "aberta de propósito" numa rota guardada, e uma das duas
    afirmações é mentira. A regra recusa em vez de escolher por ordem.
  */
  let publica = null;
  let guardada = null;

  for (let i = 1; i < args.length; i += 1) {
    const arg = descascar(args[i]);
    if (arg?.type === 'ArrowFunctionExpression' || arg?.type === 'FunctionExpression') break;
    if (arg?.type !== 'CallExpression' || arg.callee?.type !== 'Identifier') continue;
    const nome = arg.callee.name;
    if (GUARDAS.has(nome)) {
      guardada = { situacao: 'declarada', guarda: nome };
      continue;
    }
    if (nome === DECLARACAO_PUBLICA || nome === DECLARACAO_AUTENTICADA) {
      const motivo = arg.arguments?.[0];
      const texto =
        motivo?.type === 'Literal' && typeof motivo.value === 'string'
          ? motivo.value
          : motivo?.type === 'TemplateLiteral' && motivo.quasis.length === 1
            ? motivo.quasis[0].value.cooked
            : null;
      // Motivo tem de ser literal E não vazio (espaço não é motivo). Uma
      // variável como motivo também é recusada: o leitor da rota precisa ler
      // o porquê ALI, não caçar o valor em outro arquivo.
      const tipo = nome === DECLARACAO_PUBLICA ? 'publica' : 'autenticada';
      publica =
        typeof texto === 'string' && texto.trim().length > 0
          ? { situacao: tipo, guarda: nome }
          : { situacao: `${tipo}-sem-motivo`, guarda: nome };
    }
  }

  if (publica && guardada) {
    return { situacao: 'contraditoria', guarda: guardada.guarda, declaracao: publica.guarda };
  }
  return guardada ?? publica;
}

/**
 * A rota (`<roteador>.<metodo>(...)`) que contém este nó, subindo pelos pais.
 * Serve para a mensagem da capability desconhecida dizer ONDE ela está.
 */
function rotaQueContem(node, roteadores) {
  for (let atual = node.parent; atual; atual = atual.parent) {
    if (atual.type !== 'CallExpression') continue;
    const metodo = metodoDeRota(atual, roteadores);
    if (typeof metodo === 'string') return { metodo, rota: caminhoDeRota(atual) };
  }
  return null;
}

/**
 * Os argumentos de capability de uma guarda nova que NÃO são uma capability do
 * catálogo em literal: código desconhecido, variável, expressão, ou nenhum.
 */
export function capabilitiesRecusadas(node, catalogo = codigosDoCatalogo()) {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return [];
  const desde = GUARDAS_POR_CAPABILITY.get(node.callee.name);
  if (desde === undefined) return [];
  const args = (node.arguments ?? []).slice(desde);
  if (args.length === 0) return ['(nenhuma capability)'];
  const recusadas = [];
  for (const arg of args) {
    const texto =
      arg.type === 'Literal' && typeof arg.value === 'string'
        ? arg.value
        : arg.type === 'TemplateLiteral' && arg.quasis.length === 1
          ? arg.quasis[0].value.cooked
          : null;
    if (texto === null) recusadas.push(`(${arg.type === 'Identifier' ? `variável ${arg.name}` : 'expressão'}, não literal)`);
    else if (!catalogo.has(texto)) recusadas.push(`'${texto}'`);
  }
  return recusadas;
}

/** Tira `void x`, `await x`, `x!` e `(x)` da frente de uma expressão. */
function descascar(expr) {
  let atual = expr;
  for (let i = 0; i < PROFUNDIDADE_MAXIMA && atual; i += 1) {
    if (atual.type === 'UnaryExpression' && atual.operator === 'void') atual = atual.argument;
    else if (atual.type === 'AwaitExpression') atual = atual.argument;
    else if (atual.type === 'TSNonNullExpression') atual = atual.expression;
    else if (atual.type === 'TSAsExpression') atual = atual.expression;
    else return atual;
  }
  return atual;
}

/**
 * Se o statement for uma IIFE — `(async () => {...})()`, `void (...)()`,
 * `(...)().catch(next)` —, devolve o BLOCO dela. Senão, null.
 *
 * O `.catch(next)` / `.then(...)` pendurado no fim é desembrulhado porque é
 * como se encadeia o tratamento de erro da IIFE, e ele não muda o fato de a
 * função ter sido invocada na hora.
 */
export function blocoDeIife(statement) {
  if (statement.type !== 'ExpressionStatement') return null;
  let expr = descascar(statement.expression);

  // Desce por `.catch(next)`, `.then(...)`, `.finally(...)` até achar a
  // chamada que de fato invoca a função.
  for (let i = 0; i < PROFUNDIDADE_MAXIMA; i += 1) {
    if (expr?.type !== 'CallExpression') return null;
    const callee = descascar(expr.callee);
    if (callee?.type === 'ArrowFunctionExpression' || callee?.type === 'FunctionExpression') {
      return callee.body?.type === 'BlockStatement' ? callee.body : null;
    }
    if (callee?.type === 'MemberExpression' && !callee.computed) {
      expr = descascar(callee.object);
      continue;
    }
    return null;
  }
  return null;
}

/** A chamada de guarda deste statement, se ele for exatamente isso. */
function guardaDoStatement(statement) {
  if (statement.type !== 'ExpressionStatement') return null;
  const expr = descascar(statement.expression);
  if (expr?.type !== 'CallExpression') return null;
  const callee = expr.callee;
  if (callee?.type !== 'Identifier') return null;
  return GUARDAS.has(callee.name) ? callee.name : null;
}

/**
 * A busca POSICIONAL: percorre só os lugares cuja execução é incondicional.
 *
 * Repare no que este `for` NÃO tem: nenhum ramo para `IfStatement`, para laço,
 * para `SwitchStatement`. A ausência é o critério. Se um dia alguém
 * acrescentar um ramo desses "para reduzir falso positivo", terá reaberto
 * exatamente o buraco da crítica 7.
 */
export function guardaDeclarada(statements, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAXIMA) return null;
  for (const statement of statements ?? []) {
    const direta = guardaDoStatement(statement);
    if (direta) return direta;

    if (statement.type === 'TryStatement' && statement.block?.type === 'BlockStatement') {
      const dentro = guardaDeclarada(statement.block.body, profundidade + 1);
      if (dentro) return dentro;
      continue;
    }

    const bloco = blocoDeIife(statement);
    if (bloco) {
      const dentro = guardaDeclarada(bloco.body, profundidade + 1);
      if (dentro) return dentro;
    }
  }
  return null;
}

/**
 * Existe chamada de guarda em QUALQUER lugar do handler?
 *
 * Só serve para escolher a mensagem: "não tem guarda" e "tem guarda no lugar
 * errado" são erros diferentes e pedem conselhos diferentes.
 */
export function guardaEmQualquerLugar(node) {
  let achada = null;
  const visitados = new Set();
  const pilha = [node];
  while (pilha.length && !achada) {
    const atual = pilha.pop();
    if (!atual || typeof atual !== 'object' || visitados.has(atual)) continue;
    visitados.add(atual);
    if (Array.isArray(atual)) {
      for (const filho of atual) pilha.push(filho);
      continue;
    }
    if (
      atual.type === 'CallExpression' &&
      atual.callee?.type === 'Identifier' &&
      GUARDAS.has(atual.callee.name)
    ) {
      achada = atual.callee.name;
      break;
    }
    for (const chave of Object.keys(atual)) {
      if (chave === 'parent' || chave === 'loc' || chave === 'range') continue;
      const valor = atual[chave];
      if (valor && typeof valor === 'object') pilha.push(valor);
    }
  }
  return achada;
}

/**
 * O veredito de uma rota, num objeto — usado pela regra e pelo script que
 * conta a matriz para os docs, para que os dois nunca discordem.
 *
 * `situacao`: 'declarada' | 'publica' | 'publica-sem-motivo' | 'escondida'
 *           | 'calada' | 'handler-nao-inline' | 'forma-desconhecida'
 */
export function analisarRota(node, roteadores = ['coreRouter']) {
  const metodo = metodoDeRota(node, roteadores);
  if (!metodo) return null;
  /*
    `coreRouter.route('/x').get(h)` e `coreRouter.all('/x', h)` são API de
    primeira classe do Express, e passariam por esta regra sem um arranhão: o
    `callee` não é um dos cinco nomes que ela conhece, então ela devolvia `null`
    e seguia adiante. A rota nasceria calada com o portão verde.

    Hoje não há nenhuma ocorrência das duas no repositório — e é justamente por
    isso que o buraco é perigoso: ninguém descobriria por acidente.
  */
  if (typeof metodo === 'object') {
    return { metodo: metodo.formaDesconhecida, rota: caminhoDeRota(node), situacao: 'forma-desconhecida', guarda: null };
  }
  const rota = caminhoDeRota(node);

  /*
    O segundo idioma vem PRIMEIRO, e a ordem tem um porquê: quando a guarda é
    middleware, o Express a executa antes do handler seja o handler inline ou
    não — então `router.get('/x', requirePermission('x'), tratarX)` é rota
    declarada mesmo com handler por referência. Exigir inline aqui seria
    reescrever código correto para agradar a ferramenta. A exigência de
    handler inline continua valendo para quem NÃO declara por argumento,
    porque aí a única esperança de achar a declaração é ler o corpo.
  */
  const porArgumento = guardaNosArgumentos(node);
  if (porArgumento) return { metodo, rota, ...porArgumento };

  const handler = handlerInline(node);
  if (!handler) return { metodo, rota, situacao: 'handler-nao-inline', guarda: null };
  if (handler.body?.type !== 'BlockStatement') {
    return { metodo, rota, situacao: 'handler-nao-inline', guarda: null };
  }
  const guarda = guardaDeclarada(handler.body.body);
  if (guarda) return { metodo, rota, situacao: 'declarada', guarda };
  const escondida = guardaEmQualquerLugar(handler);
  if (escondida) return { metodo, rota, situacao: 'escondida', guarda: escondida };
  return { metodo, rota, situacao: 'calada', guarda: null };
}

// ---------------------------------------------------------------------------
// O plugin
// ---------------------------------------------------------------------------

/*
  A mensagem tem de DIZER O QUE FAZER. Uma mensagem que só nomeia o defeito
  ("rota sem guarda") faz a pessoa ir procurar o padrão em outra rota e copiar
  o guarda da vizinha — que é exatamente como nasceu o caso das etiquetas, em
  que o guarda copiado ficou mais estreito que a tela e teria escondido a
  página de `atendente`. Por isso a mensagem traz as duas opções, diz quando
  cada uma se aplica, e manda escrever o motivo: qual tela consome a rota.
*/
const COMO_CONSERTAR =
  'Declare na PRIMEIRA linha útil do handler (dentro do `try`, antes de qualquer trabalho) a CAPABILITY que a rota exige: ' +
  "`requireCapability(req, 'area.recurso.acao')`, ou `requireAnyCapability(req, ...)` quando a rota serve telas diferentes " +
  '(ela abre para quem tem QUALQUER tela que a consome), ou `requireAllCapabilities(req, ...)`. ' +
  "Nos roteadores que guardam por middleware, o equivalente é `comCapability('area.recurso.acao')` como argumento da rota, " +
  'antes do handler. A capability é um literal do catálogo (`src/services/auth/Capabilities.ts`). ' +
  'Enquanto a F2 do RBAC granular não termina, as guardas por perfil ainda valem — ' +
  "`abertaAo(req, 'balcao' | 'bancada' | 'escritorio', ...)`, `requireProfile(req, 'perfil', ...)` e " +
  "`requirePermission('modulo.recurso.acao')` —, mas a catraca não deixa escrever chamada nova delas. " +
  "E se a rota for aberta DE PROPÓSITO — login, vitrine, webhook, health —, declare `rotaPublica('motivo')` " +
  "como argumento; se ela só exige a PRÓPRIA sessão, `soAutenticado('motivo')`: é o que separa decisão de esquecimento. " +
  'E escreva ACIMA da chamada um comentário dizendo POR QUE esse alcance: qual tela consome a rota e ' +
  'quais ambientes o roteador do navegador deixa chegar nela. O guarda nunca pode ser mais estreito que a tela.';

export const regraRotaDeclaraAlcance = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Exige que toda rota do roteador declare a quem está aberta, no primeiro nível do handler.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          roteadores: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      calada:
        'Rota calada: `{{metodo}} {{rota}}` não diz a quem está aberta. ' +
        'Rota sem guarda NÃO é "aberta de propósito" — é indistinguível de esquecimento, e um perfil ' +
        'que ninguém previu entra nela em silêncio (falha ABERTA). ' +
        COMO_CONSERTAR,
      escondida:
        'Guarda que talvez não rode: `{{metodo}} {{rota}}` chama `{{guarda}}`, mas não no primeiro nível ' +
        'do handler — está dentro de um `if`, de um laço ou de uma função adiada, e portanto existe caminho ' +
        'de execução que responde SEM passar por ele. Um guarda condicional não é guarda. ' +
        COMO_CONSERTAR,
      formaDesconhecida:
        'Forma de rota que esta regra nao entende: `<roteador>.{{metodo}}()`. ' +
        'Ela so sabe ler get, post, put, patch e delete — e regra que se cala diante do que nao ' +
        'entende e uma porta: a rota nasceria sem declarar alcance, com o portao verde. ' +
        'Use um dos cinco metodos, ou ensine esta regra a ler a forma nova. ' +
        COMO_CONSERTAR,
      handlerNaoInline:
        'Handler de `{{metodo}} {{rota}}` não é uma função escrita aqui, então não dá para verificar se ' +
        'a rota declara alcance — e regra que se cala diante do que não entende é uma porta. ' +
        'Escreva o handler inline. ' +
        COMO_CONSERTAR,
      publicaSemMotivo:
        '`{{metodo}} {{rota}}` chama `rotaPublica` sem motivo — e a declaração sem motivo é só um jeito ' +
        'novo de silenciar esta regra. O motivo é um literal de string não vazio, escrito ali mesmo, ' +
        "dizendo POR QUE a rota não tem guarda: quem a consome antes de existir sessão. " +
        "Exemplo: `rotaPublica('vitrine da loja: o comprador ainda não tem conta')`.",
      autenticadaSemMotivo:
        '`{{metodo}} {{rota}}` chama `soAutenticado` sem motivo — e a declaração sem motivo é só um jeito ' +
        'novo de silenciar esta regra. O motivo é um literal de string não vazio, escrito ali mesmo, ' +
        'dizendo POR QUE a rota exige sessão e nenhuma capability: ela opera só sobre a PRÓPRIA sessão. ' +
        "Exemplo: `soAutenticado('a própria sessão: qualquer pessoa autenticada consulta a sua')`.",
      contraditoria:
        '`{{metodo}} {{rota}}` declara `{{declaracao}}` E chama `{{guarda}}` ao mesmo tempo. As duas ' +
        'afirmações não podem ser verdade juntas: ou a rota dispensa guarda de alcance de propósito (e a ' +
        'guarda sobra), ou ela é guardada (e a declaração mente para quem lê). Decida uma e apague a outra — ' +
        'uma declaração que contradiz o comportamento é pior que nenhuma, porque quem lê acredita nela.',
      capabilityDesconhecida:
        '`{{metodo}} {{rota}}` pede {{capability}} a `{{guarda}}`, e isso não é uma capability do catálogo ' +
        '(`src/services/auth/Capabilities.ts`). A capability tem de ser um literal de string, escrito ali, ' +
        'com um código que exista no catálogo: um erro de digitação seria uma rota que nega todo mundo em ' +
        'produção, e uma variável obrigaria quem lê a caçar o valor em outro arquivo. Capability nova entra ' +
        'pelo catálogo (`scripts/rbac`), declarando os modelos em que nasce.',
    },
  },
  create(context) {
    const roteadores = context.options?.[0]?.roteadores ?? ['coreRouter'];
    return {
      CallExpression(node) {
        // A capability de toda guarda nova, esteja ela onde estiver no arquivo.
        const recusadas = capabilitiesRecusadas(node);
        if (recusadas.length > 0) {
          const onde = rotaQueContem(node, roteadores);
          for (const capability of recusadas) {
            context.report({
              node,
              messageId: 'capabilityDesconhecida',
              data: {
                metodo: onde ? onde.metodo.toUpperCase() : '(fora',
                rota: onde ? onde.rota : 'de rota)',
                guarda: node.callee.name,
                capability,
              },
            });
          }
        }

        const veredito = analisarRota(node, roteadores);
        if (!veredito || ['declarada', 'publica', 'autenticada'].includes(veredito.situacao)) {
          return;
        }
        const messageId =
          veredito.situacao === 'handler-nao-inline'
            ? 'handlerNaoInline'
            : veredito.situacao === 'forma-desconhecida'
              ? 'formaDesconhecida'
              : veredito.situacao === 'publica-sem-motivo'
                ? 'publicaSemMotivo'
                : veredito.situacao === 'autenticada-sem-motivo'
                  ? 'autenticadaSemMotivo'
                  : veredito.situacao;
        context.report({
          node: node.callee,
          messageId,
          data: {
            metodo: veredito.metodo.toUpperCase(),
            rota: veredito.rota,
            guarda: veredito.guarda,
            declaracao: veredito.declaracao ?? DECLARACAO_PUBLICA,
          },
        });
      },
    };
  },
};

export default {
  rules: {
    'rota-declara-alcance': regraRotaDeclaraAlcance,
  },
};
