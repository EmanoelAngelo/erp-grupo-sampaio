import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import regrasDeRota from './eslint-rules/rota-declara-alcance.js';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**'],
  },
  /*
    ================== NENHUMA ROTA NASCE CALADA ===========================

    A regra cobre AGORA os dezessete roteadores de `src/routes/v1` — não só o
    `coreRouter`. A história de por que ela começou em um arquivo só está no
    cabeçalho de `eslint-rules/rota-declara-alcance.js`; o resumo é que os
    outros roteadores guardam com OUTRO idioma (o middleware como argumento:
    `requirePermission('x')` antes do handler), e enquanto a regra só sabia
    ler o idioma de `core.ts`, ligá-la aqui condenaria centenas de rotas
    corretas. A rodada 31 ensinou o segundo idioma à regra e criou
    `rotaPublica('motivo')` para as rotas abertas por desenho (login, vitrine,
    webhook, health) — que antes não tinham COMO declarar nada.

    A medição que motivou o alargamento: das 277 rotas fora do alcance da
    regra, DUAS estavam autenticadas sem permissão nenhuma (carrinho e pedido
    em `storefronts.ts`, consertadas na rodada 29). O buraco não era teórico.
    `storefronts.ts` e `promotions.ts` foram apagados inteiros na rodada 36 —
    a lista abaixo encolheu de dezenove para dezessete junto com eles.

    A lista de roteadores é explícita, nome por nome, em vez de um curinga,
    porque a regra casa pelo NOME do identificador: um roteador novo que não
    estiver aqui fica invisível para ela. O teste da regra confere que esta
    lista bate com os `export const *Router` de `src/routes/v1` — roteador
    novo sem entrada aqui derruba a suíte, não passa em silêncio.
  */
  {
    files: ['src/routes/v1/*.ts'],
    plugins: { 'local-rotas': regrasDeRota },
    rules: {
      'local-rotas/rota-declara-alcance': [
        'error',
        {
          roteadores: [
            'acessoRouter',
            'authRouter',
            'coreRouter',
            'logisticsRouter',
            'nfseRouter',
            'paymentTerminalsRouter',
            'storefrontRouter',
            'systemAdminRouter',
            'v1Router',
          ],
        },
      ],
    },
  },
);
