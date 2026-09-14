/**
 * ============================================================================
 * OS CABEÇALHOS DE SEGURANÇA DA API (GAP-PRD-156)
 * ============================================================================
 *
 * Esta origem serve JSON, arquivos enviados (`/uploads`) e, atrás de sessão,
 * alguns documentos HTML que a tela busca com `fetch` e imprime. Nenhuma
 * resposta dela precisa carregar script, estilo, imagem ou moldura de lugar
 * nenhum quando aberta direto no navegador — então a política é a mais
 * fechada que existe:
 *
 *     default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
 *
 * Um SVG com `<script>` ou um HTML que um dia saia daqui aberto numa aba não
 * executa nada; nenhuma página de fora emoldura a API. O que a tela faz com as
 * respostas não muda: `fetch` e `<img>` de outra origem não herdam a CSP da
 * resposta. A CSP da TELA é outra, e mora no `index.html` do build
 * (`src/lib/seguranca/politicaDeConteudo.ts`).
 *
 * ## HSTS, só quando é verdade
 *
 * `Strict-Transport-Security` só vai quando a requisição chegou por HTTPS:
 * `req.secure`, que o Express calcula pelo socket TLS ou — com
 * `DEVORA_TRUST_PROXY` declarado — pelo `X-Forwarded-Proto` do proxy que
 * terminou o TLS. Sem proxy declarado, esse cabeçalho escrito pelo cliente não
 * vale. HSTS por HTTP puro é ignorado pelo navegador de qualquer jeito, e o
 * balcão na LAN (`http://192.168...`) segue funcionando.
 *
 * 180 dias e sem `includeSubDomains`: o domínio pode ter outros serviços que
 * não são deste sistema, e a promessa que se faz ao navegador por HSTS não se
 * desfaz rápido. Quem quiser mais, sobe no proxy.
 *
 * ## Por que é o PRIMEIRO middleware
 *
 * Antes estes cabeçalhos eram montados depois dos estáticos de `/uploads`, do
 * limite de taxa e do parser do corpo: o arquivo servido, o 429 e a recusa do
 * corpo quebrado saíam sem nenhum. Na frente de tudo, valem para toda resposta.
 */
import type { NextFunction, Request, Response } from 'express';

export const POLITICA_DE_CONTEUDO_DA_API =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const HSTS = 'max-age=15552000';

export function cabecalhosDeSeguranca(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', POLITICA_DE_CONTEUDO_DA_API);
  if (req.secure) res.setHeader('Strict-Transport-Security', HSTS);
  next();
}
