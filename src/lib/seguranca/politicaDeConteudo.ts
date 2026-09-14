/**
 * ============================================================================
 * A POLÍTICA DE CONTEÚDO DA TELA (GAP-PRD-156)
 * ============================================================================
 *
 * A sessão inteira — access e refresh token — mora no `localStorage`
 * (`client.ts`). Qualquer script que rode nesta origem a lê: um único XSS
 * futuro levaria a sessão de todas as operações da pessoa. Não havia CSP
 * nenhuma — nem no `index.html`, nem no servidor que o entrega (o Express não
 * serve o frontend; quem serve é o host estático ou o proxy).
 *
 * Esta política vai como `<meta http-equiv="Content-Security-Policy">` no
 * `index.html` do BUILD (plugin em `vite.config.ts`), para valer seja qual for
 * o host estático. O que ela fecha:
 *
 *   - `script-src 'self'`: só o JavaScript do próprio pacote executa. Nada
 *     inline, nada de `eval`, nada de outro domínio — o caminho clássico de um
 *     XSS até o `localStorage` é exatamente um script injetado;
 *   - `connect-src`: `fetch` só fala com esta origem e com a API. Um script
 *     que escapasse não teria para onde mandar o token;
 *   - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
 *
 * O que ela deixa, e por quê:
 *
 *   - `style-src 'unsafe-inline'`: as janelas de impressão (etiqueta, OS,
 *     DANFE, plaquinha) são HTML gerado pelo servidor e escrito numa janela
 *     nova, que HERDA esta política — e esse HTML é feito de `<style>` e
 *     `style=""`. Estilo inline não executa código;
 *   - `img-src https: data: blob:` e a API: foto de produto e logo vêm de
 *     `/uploads` da API, o QR é gerado em `data:`, a prévia do arquivo é
 *     `blob:`. `https:` fica aberto porque imagem de outra origem não executa
 *     nada e o cadastro aceita endereço absoluto (`coreApi.imageUrl`);
 *   - `frame-src 'self' blob:`: a prévia da plaquinha usa `srcdoc`, que herda
 *     esta política.
 *
 * ## A origem da API
 *
 * Com `VITE_API_BASE_URL` no build (o caso de produção), `connect-src` libera
 * exatamente aquela origem. Sem ela, o cliente deriva a API do host que serviu
 * a página na porta 8787 (`client.ts`, `baseUrl`) — o balcão abre o sistema
 * pelo IP da LAN, que não se conhece no build —, e a política libera a porta
 * 8787 de qualquer host (`http://*:8787`). É mais largo, e é o que o modo LAN
 * exige; em produção a variável de build o estreita.
 *
 * ## O que uma `<meta>` não consegue
 *
 * `frame-ancestors` (não se deixar emoldurar) e HSTS só valem como cabeçalho
 * HTTP — ficam para o host estático/proxy que entrega o `index.html`
 * (`docs/DEPLOY.md`). A API já manda os dela (`server/src/middleware/cabecalhosDeSeguranca.ts`).
 *
 * Quem acrescentar um provedor externo à tela (login do Google, widget de
 * pagamento) acrescenta o domínio dele AQUI, na diretiva certa, e cobra no
 * teste — a política recusa em silêncio para o usuário e em voz alta no
 * console.
 */

/** Porta da API quando `VITE_API_BASE_URL` não existe — a mesma de `client.ts`. */
const PORTA_PADRAO_DA_API = '8787';

/** A origem (esquema + host + porta) de uma URL absoluta, ou `null`. */
function origemDe(url: string | undefined): string | null {
  const limpa = url?.trim();
  if (!limpa) return null;
  try {
    const u = new URL(limpa);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    // Relativa ("/api") ou inválida: a API é a própria origem da página.
    return null;
  }
}

/**
 * As origens da API que a tela alcança. `configurada` é o
 * `VITE_API_BASE_URL` do build; sem ela, a porta padrão de qualquer host.
 */
export function origensDaApi(configurada: string | undefined): string[] {
  const origem = origemDe(configurada);
  if (origem) return [origem];
  if (configurada?.trim()) return []; // relativa: coberta por 'self'
  return [`http://*:${PORTA_PADRAO_DA_API}`, `https://*:${PORTA_PADRAO_DA_API}`];
}

export function politicaDeConteudoDaTela(apiBaseUrl: string | undefined): string {
  const api = origensDaApi(apiBaseUrl);
  const diretivas: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:', ...api]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...api]],
    ['frame-src', ["'self'", 'blob:']],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  return diretivas.map(([nome, fontes]) => `${nome} ${[...new Set(fontes)].join(' ')}`).join('; ');
}

/**
 * Põe a política no `<head>`, logo depois do `<meta charset>` — antes de
 * qualquer `<link>` ou `<script>`, porque a CSP de uma `<meta>` só vale para o
 * que vem depois dela.
 */
export function injetarPoliticaNoHtml(html: string, politica: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${politica.replace(/"/g, '&quot;')}" />`;
  const charset = /<meta\s+charset=[^>]*>/i;
  if (charset.test(html)) return html.replace(charset, (m) => `${m}\n    ${meta}`);
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${meta}`);
}
