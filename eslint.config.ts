import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import routeElementPlugin from './eslint-rules/route-element-jsx.js'

const autoImportGlobals = {
  // React
  React: 'readonly',
  useState: 'readonly',
  useEffect: 'readonly',
  useContext: 'readonly',
  useReducer: 'readonly',
  useCallback: 'readonly',
  useMemo: 'readonly',
  useRef: 'readonly',
  useImperativeHandle: 'readonly',
  useLayoutEffect: 'readonly',
  useDebugValue: 'readonly',
  useDeferredValue: 'readonly',
  useId: 'readonly',
  useInsertionEffect: 'readonly',
  useSyncExternalStore: 'readonly',
  useTransition: 'readonly',
  startTransition: 'readonly',
  lazy: 'readonly',
  memo: 'readonly',
  forwardRef: 'readonly',
  createContext: 'readonly',
  createElement: 'readonly',
  cloneElement: 'readonly',
  isValidElement: 'readonly',
  // React Router
  useNavigate: 'readonly',
  useLocation: 'readonly',
  useParams: 'readonly',
  useSearchParams: 'readonly',
  Link: 'readonly',
  NavLink: 'readonly',
  Navigate: 'readonly',
  Outlet: 'readonly',
  // React i18n
  useTranslation: 'readonly',
  Trans: 'readonly',
}

export default [
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...autoImportGlobals,
        NodeJS: 'readonly',
        JSX: 'readonly',
        IdleRequestCallback: 'readonly',
        __BASE_PATH__: 'readonly',
        __IS_PREVIEW__: 'readonly',
        __READDY_PROJECT_ID__: 'readonly',
        __READDY_VERSION_ID__: 'readonly',
        __READDY_AI_DOMAIN__: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
      'prefer-const': 'off',
      'prefer-rest-params': 'off',
      'prefer-spread': 'off',
      'no-unused-expressions': 'off',
      'no-case-declarations': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-useless-catch': 'off',
      'no-irregular-whitespace': 'off',
      /*
        ======================================================================
        `no-undef` NÃO SABE LER TIPO — E POR ISSO DERRUBOU O PORTÃO
        ======================================================================

        O DEFEITO, medido: `npm run lint:frontend` estava VERMELHO na base,
        com um erro só —

            src/pages/gs/__tests__/pdvComplementosDaAuditoria.test.tsx
              798:69  error  'KeyboardEventInit' is not defined  no-undef

        — e `KeyboardEventInit` não é código que roda: é o TIPO do parâmetro
        `extra`, apagado na compilação. O portão de lint, que existe para
        recusar a entrega com defeito, estava recusando a entrega por causa de
        uma anotação correta. Portão que grita sem motivo é portão que a
        próxima pessoa aprende a ignorar — e foi por isso que o erro atravessou
        um commit inteiro sem ninguém ver.

        POR QUE ACONTECE, e por que não é caso isolado: `no-undef` resolve
        nomes pela análise de escopo do eslint, que enxerga só VARIÁVEIS. Os
        nomes de tipo do DOM (`KeyboardEventInit`, `RequestInit`,
        `ScrollBehavior`, `AddEventListenerOptions`…) moram no `lib.dom.d.ts`
        do TypeScript, e o pacote `globals` — de onde sai `globals.browser`
        logo acima — lista globais de EXECUÇÃO, nunca nomes de tipo. Então
        todo nome de tipo do DOM usado numa anotação é, para esta regra, um
        identificador inventado.

        A lista de globais acima já mostra a cicatriz: `NodeJS`, `JSX` e
        `IdleRequestCallback` estão lá um a um, cada um posto no dia em que
        derrubou o lint de alguém. Era a estratégia de tapar buraco: só
        conserta o nome que já doeu, e o próximo nome de tipo derruba o portão
        de novo, na véspera de uma entrega, por nada.

        O QUE SUBSTITUI A REGRA — e é mais forte, não mais fraco: `tsc
        --noEmit`, que `npm run type-check:frontend` roda sobre
        `tsconfig.app.json`, cujo `include` é `src` INTEIRO (testes juntos).
        Nome de verdade indefinido vira `error TS2304: Cannot find name` e
        derruba o portão de tipos. O compilador conhece valor E tipo; a regra
        conhecia só metade, e chamava a outra metade de erro.

        Está provado nos dois sentidos em
        `src/lib/__tests__/o-lint-nao-confunde-tipo-com-nome.test.ts`: a
        anotação de tipo passa aqui e o identificador inventado continua caindo
        no `tsc`.
      */
      'no-undef': 'off',
    },
  },
  /*
    Teste de frontend RODA EM NODE, mesmo montando componente em jsdom.

    O bloco acima declara só os globais do navegador, então `process` — que o
    Vitest sempre fornece — era reportado como indefinido. Um teste que precisa
    fixar `process.env.TZ` para provar que o código não depende do relógio da
    máquina não tem como fazê-lo sem isto.
  */
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Only enforce this rule for the router config file to avoid false positives elsewhere.
  {
    files: ['src/router/config.tsx'],
    plugins: {
      'local-route': routeElementPlugin,
    },
    rules: {
      'local-route/route-element-jsx': 'error',
    },
  },
]

