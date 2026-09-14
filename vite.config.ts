import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import AutoImport from "unplugin-auto-import/vite";
import { injetarPoliticaNoHtml, politicaDeConteudoDaTela } from "./src/lib/seguranca/politicaDeConteudo";
import {
  LISTA_DO_SERVICE_WORKER,
  listaDoServiceWorker,
  mapaDeFonteDoBuild,
  baseDaApiDoBuild,
} from "./src/lib/build/configuracaoDoBuild";

/*
  A CSP DA TELA vai no index.html do BUILD (GAP-PRD-156) — ver
  src/lib/seguranca/politicaDeConteudo.ts. Só no build: o servidor de
  desenvolvimento injeta script inline (o preâmbulo do React Refresh), que a
  política recusaria. A origem da API vem do VITE_API_BASE_URL do build.
*/
function politicaDeConteudo(): Plugin {
  let apiBaseUrl: string | undefined;
  return {
    name: "devora-politica-de-conteudo",
    apply: "build",
    configResolved(config) {
      // Endereço com cara de caminho do disco para o build aqui (ver baseDaApiDoBuild).
      apiBaseUrl = baseDaApiDoBuild(config.env.VITE_API_BASE_URL as string | undefined);
    },
    transformIndexHtml(html) {
      return injetarPoliticaNoHtml(html, politicaDeConteudoDaTela(apiBaseUrl));
    },
  };
}

/*
  A LISTA DO SERVICE WORKER (GAP-PRD-210) — ver src/lib/build/configuracaoDoBuild.ts.
  Cada tela virou um pedaço baixado sob demanda (src/router/telas.tsx); o
  service worker guarda TODOS eles a partir desta lista, para que uma tela
  nunca aberta com rede abra sem ela.
*/
function listaParaOServiceWorker(): Plugin {
  let base = "/";
  return {
    name: "devora-lista-do-service-worker",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_opcoes, bundle) {
      this.emitFile({
        type: "asset",
        fileName: LISTA_DO_SERVICE_WORKER,
        source: JSON.stringify(listaDoServiceWorker(bundle, base), null, 2),
      });
    },
  };
}
// import { readdyJsxRuntimeProxyPlugin } from "./vite.jsx-runtime-proxy";

const base = process.env.BASE_PATH || "/";
const isPreview = process.env.IS_PREVIEW ? true : false;
//const proxyPlugins = isPreview ? [readdyJsxRuntimeProxyPlugin()] : [];
// https://vite.dev/config/
export default defineConfig({
  define: {
    __BASE_PATH__: JSON.stringify(base),
    __IS_PREVIEW__: JSON.stringify(isPreview),
    __READDY_PROJECT_ID__: JSON.stringify(process.env.PROJECT_ID || ""),
    __READDY_VERSION_ID__: JSON.stringify(process.env.VERSION_ID || ""),
    __READDY_AI_DOMAIN__: JSON.stringify(process.env.READDY_AI_DOMAIN || ""),
  },
  plugins: [
    // ...proxyPlugins,
    react(),
    politicaDeConteudo(),
    listaParaOServiceWorker(),
    AutoImport({
      imports: [
        {
          react: [
            ["default", "React"],
            "useState",
            "useEffect",
            "useContext",
            "useReducer",
            "useCallback",
            "useMemo",
            "useRef",
            "useImperativeHandle",
            "useLayoutEffect",
            "useDebugValue",
            "useDeferredValue",
            "useId",
            "useInsertionEffect",
            "useSyncExternalStore",
            "useTransition",
            "startTransition",
            "lazy",
            "memo",
            "forwardRef",
            "createContext",
            "createElement",
            "cloneElement",
            "isValidElement",
          ],
        },
        {
          "react-router-dom": [
            "useNavigate",
            "useLocation",
            "useParams",
            "useSearchParams",
            "Link",
            "NavLink",
            "Navigate",
            "Outlet",
          ],
        },
        // React i18n
        {
          "react-i18next": ["useTranslation", "Trans"],
        },
      ],
      dts: true,
    }),
  ],
  base,
  build: {
    /*
      Mapa de fonte FORA do artefato (GAP-PRD-210): `true` publicava o código-
      fonte inteiro do frontend ao lado do pacote. Padrão: nenhum mapa;
      DEVORA_BUILD_SOURCEMAP=hidden gera os mapas sem o comentário que os
      anuncia (para a ferramenta de erros — não publique os .map; a API recusa
      servi-los). Qualquer outro valor recusa o build.
    */
    sourcemap: mapaDeFonteDoBuild(process.env.DEVORA_BUILD_SOURCEMAP),
    outDir: 'out',
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
  },
});
