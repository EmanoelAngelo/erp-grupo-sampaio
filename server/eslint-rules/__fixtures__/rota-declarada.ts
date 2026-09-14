/*
  ARQUIVO DE EXEMPLO — não é código do produto, não entra no build.

  Este é o lado VERDE da prova: os quatro formatos de rota que existem em
  `core.ts` e que declaram alcance de verdade. A regra tem de ficar CALADA
  aqui. Se ela reclamar de alguma linha deste arquivo, ela está condenando
  código correto — e regra que dá falso positivo é desligada na semana
  seguinte, o que é pior do que não existir.

  `tests/regra-rota-declara-alcance.test.ts` roda o eslint como processo sobre
  este arquivo e exige ZERO erros.
*/

declare const coreRouter: {
  get: (...args: unknown[]) => void;
  post: (...args: unknown[]) => void;
  put: (...args: unknown[]) => void;
  patch: (...args: unknown[]) => void;
  delete: (...args: unknown[]) => void;
};
declare function abertaAo(req: unknown, ...ambientes: string[]): void;
declare function requireProfile(req: unknown, ...perfis: string[]): void;
declare function requirePermission(req: unknown, permissao: string): void;
declare function rotaPublica(motivo: string): unknown;
declare const authMiddleware: unknown;
declare const limitador: unknown;
declare function trabalho(req: unknown): unknown;
declare function trabalhoAsync(req: unknown): Promise<unknown>;
declare const tratarExterno: (req: unknown, res: unknown) => void;

// 1. O formato normal: `try` de primeiro nível, guarda na primeira linha útil.
coreRouter.get('/exemplo/normal', (req, res: any, next: any) => {
  try {
    // A tela de Exemplo é ROTA_GESTAO; o balcão não chega aqui.
    abertaAo(req, 'escritorio');
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// 2. A IIFE assíncrona com `void` na frente — onze rotas de core.ts são assim.
coreRouter.post('/exemplo/iife', (req, res: any, next: any) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja');
      res.json(await trabalhoAsync(req));
    } catch (err) {
      next(err);
    }
  })();
});

// 3. A IIFE sem `void` e com `.catch` pendurado — mesma execução imediata.
coreRouter.put('/exemplo/iife-catch', (req, res: any, next: any) => {
  (async () => {
    try {
      requirePermission(req, 'exemplo.editar');
      res.json(await trabalhoAsync(req));
    } catch (err) {
      next(err);
    }
  })().catch(next);
});

// 4. Com middleware no meio: o handler é o ÚLTIMO argumento-função.
coreRouter.delete('/exemplo/com-middleware', limitador, (req, res: any, next: any) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// 5. Sem `try`: guarda como primeiro statement do corpo do handler.
coreRouter.patch('/exemplo/sem-try', (req, res: any) => {
  abertaAo(req, 'bancada', 'escritorio');
  res.json(trabalho(req));
});

// 6. O SEGUNDO idioma: a guarda como MIDDLEWARE, argumento antes do handler.
// É como os dezoito roteadores fora de core.ts guardam. O Express roda o
// middleware incondicionalmente antes do handler — declaração tão forte
// quanto a primeira linha do corpo.
coreRouter.get('/exemplo/permissao-middleware', authMiddleware, requirePermission('exemplo.item.view'), (req, res: any) => {
  res.json(trabalho(req));
});

// 7. Guarda-middleware com handler POR REFERÊNCIA: vale, porque a guarda não
// mora no corpo — ela roda antes dele, esteja o corpo onde estiver.
coreRouter.post('/exemplo/permissao-referencia', authMiddleware, requirePermission('exemplo.item.create'), tratarExterno);

// 8. A rota aberta DE PROPÓSITO, com o motivo escrito ali: `rotaPublica`.
coreRouter.get('/exemplo/publica', rotaPublica('vitrine: quem chama ainda não tem conta nem sessão'), (req, res: any) => {
  res.json(trabalho(req));
});

/*
  O RBAC GRANULAR (F1): as guardas por CAPABILITY valem nos mesmos lugares
  incondicionais das legadas, com a capability escrita em literal e presente no
  catálogo (`src/services/auth/Capabilities.ts`).
*/
declare function requireCapability(req: unknown, ...caps: string[]): void;
declare function requireAnyCapability(req: unknown, ...caps: string[]): void;
declare function requireAllCapabilities(req: unknown, ...caps: string[]): void;
declare function comCapability(...caps: string[]): unknown;
declare function comQualquerCapability(...caps: string[]): unknown;
declare function soAutenticado(motivo: string): unknown;

// 9. A guarda nova no `try` de primeiro nível.
coreRouter.get('/exemplo/capability', (req, res: any, next: any) => {
  try {
    // A tela de Produtos consome esta rota.
    requireCapability(req, 'products.view');
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// 10. Qualquer de várias — a rota abre para quem tem QUALQUER tela que a consome.
coreRouter.get('/exemplo/qualquer-capability', (req, res: any, next: any) => {
  try {
    requireAnyCapability(req, 'customers.view', 'pdv.sell', 'workshop.orders.open');
    res.json(trabalho(req));
  } catch (err) {
    next(err);
  }
});

// 11. Todas de várias, dentro da IIFE.
coreRouter.post('/exemplo/todas-capabilities', (req, res: any, next: any) => {
  void (async () => {
    try {
      requireAllCapabilities(req, 'sales.quotes.manage', 'pdv.cash.operate');
      res.json(await trabalhoAsync(req));
    } catch (err) {
      next(err);
    }
  })();
});

// 12. Como middleware, nos roteadores que guardam por argumento.
coreRouter.get('/exemplo/capability-middleware', authMiddleware, comCapability('logistics.manage'), (req, res: any) => {
  res.json(trabalho(req));
});
coreRouter.get('/exemplo/qualquer-capability-middleware', authMiddleware, comQualquerCapability('integrations.asaas.view', 'integrations.asaas.manage'), tratarExterno);

// 13. Só autenticada, de propósito e com o motivo: a rota da PRÓPRIA sessão.
coreRouter.get('/exemplo/so-autenticada', authMiddleware, soAutenticado('a própria sessão: qualquer pessoa autenticada consulta a sua'), (req, res: any) => {
  res.json(trabalho(req));
});
