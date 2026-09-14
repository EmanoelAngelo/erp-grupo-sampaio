/*
  ARQUIVO DE EXEMPLO — não é código do produto, não entra no build.

  Este é o lado VERMELHO da prova, e cada rota aqui é um retrato de um defeito
  real que já aconteceu neste repositório:

    - `/exemplo/calada`      : a rota 298 nascendo sem guarda nenhum. É como as
                               52 rotas caladas de core.ts eram.
    - `/exemplo/condicional` : o guarda existe mas está dentro de um `if` — quem
                               não mandar o parâmetro passa direto. É a crítica 7.
    - `/exemplo/adiado`      : o guarda existe mas dentro de um callback que roda
                               depois; a resposta já foi enviada.
    - `/exemplo/referencia`  : o handler não está escrito aqui, então não há como
                               verificar nada.
    - `/exemplo/auth-sem-permissao` : autenticada e NADA mais — o buraco das duas
                               rotas de carrinho/pedido da rodada 29.
    - `/exemplo/publica-sem-motivo` e `/exemplo/publica-motivo-longe` :
                               `rotaPublica` sem motivo legível ali — declaração
                               vazia é só um jeito novo de silenciar a regra.

  `tests/regra-rota-declara-alcance.test.ts` exige que a regra aponte
  EXATAMENTE estas sete, com a mensagem certa para cada tipo. Se a regra for
  afrouxada, o teste fica vermelho — que é o único jeito de saber que ela ainda
  morde.
*/

declare const coreRouter: {
  get: (...args: unknown[]) => void;
  post: (...args: unknown[]) => void;
};
declare function requireProfile(req: unknown, ...perfis: string[]): void;
declare function rotaPublica(motivo?: string): unknown;
declare const authMiddleware: unknown;
declare function trabalho(req: unknown): unknown;
declare function depois(cb: () => void): void;
declare const tratarExterno: (req: unknown, res: unknown) => void;
declare const MOTIVO_EM_VARIAVEL: string;

// CALADA: nenhuma menção a quem alcança.
coreRouter.get('/exemplo/calada', (req, res: any, next: any) => {
  try {
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// ESCONDIDA: o guarda só roda para quem pedir o modo antigo.
coreRouter.get('/exemplo/condicional', (req: any, res: any, next: any) => {
  try {
    if (req.query.modoAntigo === '1') {
      requireProfile(req, 'gerente_loja');
    }
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// ESCONDIDA: o guarda foi adiado para depois da resposta.
coreRouter.post('/exemplo/adiado', (req, res: any, next: any) => {
  try {
    res.json(trabalho(req));
    depois(() => {
      requireProfile(req, 'gerente_loja');
    });
  } catch (err) {
    next(err);
  }
});

// HANDLER NÃO INLINE: não dá para ver o corpo daqui.
coreRouter.get('/exemplo/referencia', tratarExterno);

// CALADA MESMO AUTENTICADA: `authMiddleware` responde "quem é você", não
// "o que você pode". Foi exatamente assim que carrinho e pedido de
// storefronts.ts ficaram abertos a qualquer perfil até a rodada 29.
coreRouter.post('/exemplo/auth-sem-permissao', authMiddleware, (req, res: any, next: any) => {
  try {
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// PÚBLICA SEM MOTIVO: declaração vazia é só um jeito novo de silenciar a regra.
coreRouter.get('/exemplo/publica-sem-motivo', rotaPublica(''), (req, res: any) => {
  res.json(trabalho(req));
});

// PÚBLICA COM MOTIVO EM VARIÁVEL: o leitor da rota tem de ler o porquê ALI,
// não caçar o valor em outro arquivo. Recusada como sem motivo.
coreRouter.get('/exemplo/publica-motivo-longe', rotaPublica(MOTIVO_EM_VARIAVEL), (req, res: any) => {
  res.json(trabalho(req));
});

/*
  GUARDA DEPOIS DO HANDLER: o Express executa os argumentos na ordem, e o
  handler inline é quem responde — o middleware pendurado depois dele NUNCA
  roda. Um atacante da rodada 31 provou que a primeira versão da regra dava
  esta rota por declarada, com a guarda num lugar que a execução não alcança.
*/
coreRouter.get('/exemplo/guarda-depois-do-handler', (req, res: any) => {
  res.json(trabalho(req));
}, requirePermission('crm.lead.view'));

// CONTRADIÇÃO: "aberta de propósito" numa rota guardada. Uma das duas
// afirmações é mentira, e a regra recusa em vez de escolher por ordem.
coreRouter.get('/exemplo/contraditoria', rotaPublica('motivo qualquer'), requirePermission('crm.lead.view'), (req, res: any) => {
  res.json(trabalho(req));
});

/*
  O RBAC GRANULAR (F1). A guarda nova só vale com capability DO CATÁLOGO,
  escrita em literal ali: um erro de digitação ("produtos.ver") seria uma rota
  que nega todo mundo em produção, e uma variável obrigaria quem lê a caçar o
  valor em outro arquivo — o mesmo motivo do `rotaPublica` com motivo em
  variável.
*/
declare function requireCapability(req: unknown, ...caps: string[]): void;
declare function comCapability(...caps: string[]): unknown;
declare function soAutenticado(motivo?: string): unknown;
declare const CAP_EM_VARIAVEL: string;

// CAPABILITY DESCONHECIDA: não existe no catálogo.
coreRouter.get('/exemplo/capability-desconhecida', (req, res: any, next: any) => {
  try {
    requireCapability(req, 'produtos.ver');
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// CAPABILITY EM VARIÁVEL: quem lê a rota não sabe o que ela exige.
coreRouter.get('/exemplo/capability-em-variavel', (req, res: any, next: any) => {
  try {
    requireCapability(req, CAP_EM_VARIAVEL);
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// A MESMA COISA como middleware.
coreRouter.get('/exemplo/middleware-capability-desconhecida', authMiddleware, comCapability('estoque.mexer'), (req, res: any) => {
  res.json(trabalho(req));
});

// A GUARDA NOVA ESCONDIDA num `if`: vale o mesmo critério posicional.
coreRouter.get('/exemplo/capability-condicional', (req: any, res: any, next: any) => {
  try {
    if (req.query.modoAntigo === '1') {
      requireCapability(req, 'products.view');
    }
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// SÓ AUTENTICADA SEM MOTIVO: a mesma recusa do `rotaPublica('')`.
coreRouter.get('/exemplo/autenticada-sem-motivo', authMiddleware, soAutenticado(''), (req, res: any) => {
  res.json(trabalho(req));
});

// "SÓ AUTENTICADA" numa rota que pede capability: uma das duas afirmações mente.
coreRouter.get('/exemplo/autenticada-contraditoria', authMiddleware, soAutenticado('a própria sessão'), comCapability('products.view'), (req, res: any) => {
  res.json(trabalho(req));
});
