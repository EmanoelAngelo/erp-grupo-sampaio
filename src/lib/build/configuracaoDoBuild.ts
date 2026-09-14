/**
 * ============================================================================
 * O QUE O BUILD DO FRONTEND PUBLICA (GAP-PRD-210)
 * ============================================================================
 *
 * Duas decisões do `vite build` que moram aqui, e não soltas no
 * `vite.config.ts`, para terem teste:
 *
 * ## 1. Mapa de fonte: fora do artefato, por padrão
 *
 * `sourcemap: true` publicava, ao lado de cada pacote, o `.map` com o código-
 * fonte INTEIRO do frontend (6,4 MB medidos) e um comentário
 * `//# sourceMappingURL=` no fim do `.js` apontando para ele. Quem abrisse o
 * DevTools na loja lia o sistema como está no repositório.
 *
 * Agora o padrão é `false`: nenhum `.map` sai. `DEVORA_BUILD_SOURCEMAP=hidden`
 * gera os mapas SEM o comentário — é o modo de quem precisa decifrar um erro
 * de produção (subir os mapas para a ferramenta de erros e apagá-los da pasta
 * publicada). Mesmo nesse modo, a API recusa entregar `*.map`
 * (`frontendEstatico.ts`).
 *
 * Qualquer outro valor RECUSA o build em vez de cair num padrão: quem escreveu
 * `DEVORA_BUILD_SOURCEMAP=true` esperava mapas públicos, e ganhar silêncio no
 * lugar esconderia que o pedido foi recusado.
 *
 * A chave não está nos `.env` de exemplo de propósito: ela é lida pelo BUILD
 * (na máquina de quem builda, antes de existir instalação), não pela API nem
 * pela tela — o contrato de `o-contrato-de-variaveis.test.ts` cobre o que a
 * instalação lê. Está documentada em `docs/DEPLOY.md`.
 *
 * ## 2. A lista do que o service worker guarda
 *
 * Com a divisão por tela (`src/router/telas.tsx`), cada tela virou um pedaço
 * que só é baixado quando alguém a abre. O service worker guardava o que
 * passava por ele — então uma tela nunca aberta com rede não abriria sem ela.
 * O build agora escreve `sw-precache.json` com TODOS os pedaços, e o service
 * worker (`public/sw.js`) baixa a lista inteira: na instalação e a cada
 * abertura com rede, o que também cobre o deploy (o `sw.js` não muda de um
 * build para outro, mas a lista muda).
 */

/** O valor que o `build.sourcemap` do Vite recebe. */
export type MapaDeFonteDoBuild = false | 'hidden';

/** Nome do arquivo que o build escreve e o service worker lê. */
export const LISTA_DO_SERVICE_WORKER = 'sw-precache.json';

/**
 * `DEVORA_BUILD_SOURCEMAP` → `build.sourcemap`.
 *
 * Vazio, ausente ou `false` → nenhum mapa. `hidden` → mapas sem o comentário
 * que os anuncia. Qualquer outra coisa → erro, dizendo o que é aceito.
 */
export function mapaDeFonteDoBuild(valor: string | undefined): MapaDeFonteDoBuild {
  const limpo = (valor ?? '').trim().toLowerCase();
  if (limpo === '' || limpo === 'false') return false;
  if (limpo === 'hidden') return 'hidden';
  throw new Error(
    `DEVORA_BUILD_SOURCEMAP="${valor}" não é aceito. Use "hidden" (mapas gerados sem o `
      + 'comentário que os anuncia, para a ferramenta de erros — não publique os .map) ou deixe '
      + 'vazio (nenhum mapa). Mapa público entrega o código-fonte do sistema a quem abrir o DevTools.',
  );
}

/** O mínimo do `OutputBundle` do Rollup/Rolldown que a lista precisa ler. */
export type ArquivosDoBundle = Record<string, { fileName: string; type: 'chunk' | 'asset' }>;

export interface ListaDoServiceWorker {
  /** Muda sempre que muda um arquivo — os nomes têm hash do conteúdo. */
  versao: string;
  /** Endereços, já com o `base` do build, na ordem alfabética. */
  arquivos: string[];
}

/** FNV-1a de 32 bits: estável, sem depender de `node:crypto` neste módulo. */
function resumo(texto: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * O que o service worker deve guardar: todo pedaço e todo arquivo que o build
 * gerou — menos o `index.html` (a casca, que ele já guarda pelo nome), os
 * `.map` (nunca vão para o navegador) e a própria lista.
 */
export function listaDoServiceWorker(bundle: ArquivosDoBundle, base = '/'): ListaDoServiceWorker {
  const prefixo = base.endsWith('/') ? base : `${base}/`;
  const arquivos = Object.values(bundle)
    .map((item) => item.fileName)
    .filter(
      (nome) => !nome.endsWith('.map') && nome !== 'index.html' && nome !== LISTA_DO_SERVICE_WORKER,
    )
    .map((nome) => `${prefixo}${nome.replace(/^\/+/, '')}`)
    .sort();
  return { versao: resumo(arquivos.join('\n')), arquivos };
}

/*
  O ENDEREÇO DA API DO BUILD NÃO PODE SER UM CAMINHO DO DISCO.

  O roteiro de publicação manda buildar com `VITE_API_BASE_URL=/` (a API serve
  as telas, mesma origem). No Git Bash do Windows, o shell REESCREVE esse "/"
  para a pasta dele — `C:/Program Files/Git/` — antes de o Vite ver. O build
  terminava verde, e a loja publicada pedia os dados a
  `file:///C:/Program%20Files/Git/api/v1/...`: a política de conteúdo recusa, a
  vitrine abre vazia e o PDV não conecta. Foi assim na verificação da
  remediação. Recusar aqui transforma a tela em branco em erro de build, com
  o conserto escrito.
*/
/** O `VITE_API_BASE_URL` conferido: vazio, relativo ("/") ou http(s). */
export function baseDaApiDoBuild(valor: string | undefined): string | undefined {
  const limpo = valor?.trim();
  if (!limpo) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(limpo) || limpo.includes('\\')) {
    throw new Error(
      `VITE_API_BASE_URL="${limpo}" é um caminho do disco, não um endereço. `
        + 'No Git Bash, o "/" vira a pasta do Git: rode `MSYS_NO_PATHCONV=1 VITE_API_BASE_URL=/ npm run build`, '
        + 'ou faça o build no PowerShell (`$env:VITE_API_BASE_URL="/"; npm run build`).',
    );
  }
  if (!limpo.startsWith('/') && !/^https?:\/\//i.test(limpo)) {
    throw new Error(
      `VITE_API_BASE_URL="${limpo}" não é "/" nem um endereço http(s). `
        + 'Use "/" quando a API serve as telas, ou a origem da API (ex.: https://api.exemplo.com.br).',
    );
  }
  return limpo;
}
