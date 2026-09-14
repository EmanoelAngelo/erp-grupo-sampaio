/**
 * A configuração do eslint usada SÓ pela prova da regra.
 *
 * Ela existe separada da `server/eslint.config.js` por um motivo prático: a
 * config de produção liga a regra apenas em `src/routes/v1/core.ts`, e os
 * arquivos de exemplo não moram lá — nem podem morar, porque `npm run lint`
 * varre `src` e `npm run type-check` compila `src`, e um exemplo que é
 * PROPOSITALMENTE errado derrubaria os dois portões.
 *
 * O que NÃO está duplicado aqui é o que importa: a regra em si vem do mesmo
 * módulo `./rota-declara-alcance.js` que a config de produção importa. Existe
 * uma implementação só. Esta config só diz "aplique-a aos exemplos".
 */
import tseslint from 'typescript-eslint';
import regrasDeRota from './rota-declara-alcance.js';

export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { 'local-rotas': regrasDeRota },
    rules: {
      'local-rotas/rota-declara-alcance': 'error',
    },
  },
];
