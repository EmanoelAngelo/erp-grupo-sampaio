/**
 * ============================================================================
 * AS TELAS SERVIDAS PELA PRÓPRIA API — com fallback de SPA (GAP-PRD-013)
 * ============================================================================
 *
 * O repositório não servia o frontend. `app.ts` montava só `/api/v1` e
 * `/uploads/*`, a publicação ficava inteira por conta de quem instala, e a
 * instalação da loja rodava o Vite de DESENVOLVIMENTO na porta 3000.
 *
 * Com `DEVORA_SERVIR_FRONTEND=true` a API entrega o `out/` do `vite build`.
 * Um processo, uma porta: o proxy HTTPS da frente (deploy/caddy) encaminha
 * tudo para ela, e o bundle é buildado com `VITE_API_BASE_URL=/` (mesma
 * origem).
 *
 * ## O fallback, e o que ele não pode engolir
 *
 * O frontend usa `BrowserRouter`: `/sistema/pdv` não é arquivo, é rota da
 * tela. Abrir esse endereço direto (favorito, F5, link no WhatsApp) precisa
 * receber o `index.html`. Mas não TUDO:
 *
 *   - `/api` e `/uploads` nunca: rota que não existe é o 404 JSON da API, e
 *     foto que sumiu é 404 — não uma página;
 *   - caminho com extensão que não existe (`/assets/index-velho.js` pedido
 *     por uma aba aberta antes do deploy) é 404. Entregar HTML no lugar de JS
 *     vira "Unexpected token '<'" no console, e a causa some;
 *   - só GET e HEAD.
 *
 * ## Cache
 *
 * `/assets/*` tem hash no nome — cache de um ano, imutável. Todo o resto
 * (`index.html`, `sw.js`) é `no-cache`: é o index que aponta para o bundle
 * novo, e um service worker em cache prende o navegador na versão velha.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppEnv } from '../../config/env.js';
import { repoRoot } from '../../db/sqlite.js';

/** Onde está o build do frontend que a API serviria. */
export function pastaDoFrontend(env: Pick<AppEnv, 'DEVORA_FRONTEND_DIR'>): string {
  const configurada = env.DEVORA_FRONTEND_DIR?.trim();
  if (!configurada) return resolve(repoRoot(), 'out');
  return isAbsolute(configurada) ? configurada : resolve(repoRoot(), configurada);
}

/** Caminhos que pertencem à API — nunca viram tela. */
const DA_API = /^\/(api|uploads)(\/|$)/;

/**
 * O caminho pede um mapa de fonte (`.map`)? Em qualquer pasta e em qualquer
 * caixa — e lido como o DISCO o leria, não como a URL chegou:
 *
 *   - `%2emap` vira `.map` quando o `express.static` decodifica o caminho;
 *   - o Windows (a loja) ignora ponto e espaço no fim do nome e abre o fluxo
 *     `::$DATA` do arquivo: `x.js.map.`, `x.js.map%20` e `x.js.map::$DATA`
 *     abririam o mesmo `x.js.map`;
 *   - o nome do mapa nem precisa ser o último pedaço da URL: `x.js.map/`,
 *     `x.js.map%5C`, `x.js.map/.` e `x.js.map%5C.` chegam ao disco como o
 *     próprio `x.js.map` (a barra do fim e o `.` somem na normalização do
 *     caminho). Por isso vale QUALQUER pedaço — nenhuma pasta publicada
 *     termina em `.map`, e nenhuma rota de tela também.
 */
function ehMapaDeFonte(caminho: string): boolean {
  let decodificado: string;
  try {
    decodificado = decodeURIComponent(caminho);
  } catch {
    // Caminho malformado: o `express.static` o recusa sozinho (400).
    return false;
  }
  return decodificado
    .split(/[\\/]/)
    .map((pedaco) => pedaco.replace(/:.*$/, '').replace(/[. ]+$/, ''))
    .some((comoODiscoLe) => /\.map$/i.test(comoODiscoLe));
}

/** O último pedaço do caminho tem extensão? Então é arquivo, não rota. */
function pareceArquivo(caminho: string): boolean {
  const ultimo = caminho.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]+$/.test(ultimo);
}

/*
  A CSP DAS TELAS NÃO É A DA API (GAP-PRD-156 × GAP-PRD-061).

  O middleware global põe em TODA resposta a política da API (`default-src
  'none'`), que é a certa para JSON. Nas telas ela desliga o sistema: o
  navegador aplica AS DUAS políticas — a do cabeçalho e a `<meta>` que o build
  põe no index.html (`src/lib/seguranca/politicaDeConteudo.ts`) — e, com
  `default-src 'none'`, nenhum script, estilo ou imagem do próprio pacote
  carrega: a tela abre em branco. No service worker o estrago é calado: a
  política do cabeçalho do `sw.js` é a do worker, e com ela o precache não
  busca nada — o PDV não abre sem rede.

  Aqui a política de CONTEÚDO é a da `<meta>` do build, que conhece a origem da
  API. O cabeçalho só acrescenta o que uma `<meta>` não consegue —
  `frame-ancestors`, a tela não se deixa emoldurar — e repete `object-src` e
  `base-uri`. `/api` e `/uploads` não passam por aqui e seguem com as suas.
*/
export const POLITICA_DAS_TELAS_NO_CABECALHO = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/*
  Só o que SAI COMO TELA troca a política: o arquivo do build que o
  `express.static` entrega (inclusive o 304 da revalidação — o `setHeaders` roda
  antes de o `send` decidir pelo 304, e o navegador copia os cabeçalhos do 304
  para o que guardou) e o index.html do fallback. O que só passa por aqui e não
  é tela — o mapa de fonte recusado, o arquivo do build que não existe, o POST
  num caminho de tela — segue com a política da API, `default-src 'none'`: não
  há por que afrouxar a resposta que não carrega tela nenhuma.
*/
function cabecalhosDaTela(res: { setHeader(nome: string, valor: string): unknown }): void {
  // Os mesmos da API (app.ts). As telas saem ANTES do limite de taxa e do
  // middleware de cabeçalhos — quem as serve é quem os põe.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // Substitui a da API, que o middleware global já pôs (ver o comentário acima).
  res.setHeader('Content-Security-Policy', POLITICA_DAS_TELAS_NO_CABECALHO);
}

/**
 * Monta o frontend na app, se estiver ligado. Vem ANTES do limite de taxa:
 * uma carga de tela são dezenas de arquivos, e contá-los no mesmo balde das
 * chamadas da API faria o PDV tomar 429 ao abrir.
 */
export function montarFrontendEstatico(app: Express, env: AppEnv): void {
  if (env.DEVORA_SERVIR_FRONTEND !== 'true') return;

  const pasta = pastaDoFrontend(env);
  const indice = join(pasta, 'index.html');
  if (!existsSync(indice)) {
    throw new Error(
      `DEVORA_SERVIR_FRONTEND=true, mas não existe ${indice}. `
        + 'Rode `npm run build:frontend` (com VITE_API_BASE_URL=/) antes de subir, '
        + 'ou aponte DEVORA_FRONTEND_DIR para a pasta do build.',
    );
  }

  /*
    MAPA DE FONTE NÃO SAI (GAP-PRD-210). O build padrão não gera `.map`, mas o
    modo `DEVORA_BUILD_SOURCEMAP=hidden` gera — para a ferramenta de erros — e
    quem publica a pasta como veio entregaria o código-fonte inteiro do
    frontend a quem pedisse `/assets/index-*.js.map`. Recusado aqui, antes de
    olhar o disco: a resposta é a mesma exista o arquivo ou não.
  */
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (DA_API.test(req.path) || !ehMapaDeFonte(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).type('text/plain').send('Não encontrado.');
  });

  const arquivos = express.static(pasta, {
    index: false,
    dotfiles: 'deny',
    fallthrough: true,
    setHeaders: (res, caminho) => {
      cabecalhosDaTela(res);
      const normalizado = caminho.split('\\').join('/');
      res.setHeader(
        'Cache-Control',
        normalizado.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (DA_API.test(req.path)) return next();
    arquivos(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (DA_API.test(req.path) || pareceArquivo(req.path)) return next();
    cabecalhosDaTela(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indice, (erro) => {
      if (erro) next(erro);
    });
  });
}
