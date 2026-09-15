import { uploadsDir } from './services/core/ProductImageService.js';
import { storeUploadsDir } from './services/core/StorefrontSettingsService.js';
import { photosDir } from './services/core/WorkshopPhotoService.js';
import { equipmentPhotosDir } from './services/core/EquipmentPhotoService.js';
import { guardaDaFotoAssinada } from './services/core/FotoDaOsAssinada.js';
import express, { type Express } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { loadEnv, type AppEnv } from './config/env.js';
import { ApiError, logError } from './utils/errors.js';
import { createRequestLog } from './services/api/ApiIdempotencyService.js';
import { v1Router } from './routes/v1/index.js';
import { erroDoCorpoDaRequisicao } from './middleware/erroDoCorpo.js';
import { observarProxy } from './middleware/observarProxy.js';
import { cabecalhosDeSeguranca } from './middleware/cabecalhosDeSeguranca.js';
import { montarFrontendEstatico } from './services/implantacao/frontendEstatico.js';

/** Endereços de rede local — o ERP roda em balcão, não só em localhost. */
const PRIVATE_LAN_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[\w-]+\.local)$/i;

/**
 * Política de CORS.
 *
 * Em produção vale exclusivamente o allowlist configurado. Fora dela, também
 * são aceitas origens de localhost e de rede privada, porque o PDV é acessado
 * de outras máquinas do balcão pelo IP da LAN — e porque amarrar o
 * desenvolvimento a uma porta fixa (3000) enquanto o Vite serve em outra
 * (5173) fazia toda requisição falhar no preflight, aparecendo na tela como
 * "não foi possível conectar ao servidor".
 */
export function buildCorsOriginCheck(env: AppEnv) {
  const allowlist = new Set(
    [
      ...env.DEVORA_FRONTEND_ORIGIN.split(','),
      ...(env.ecommerceStorefrontOrigins ? env.ecommerceStorefrontOrigins.split(',') : []),
    ]
      .map((o) => o.trim())
      .filter(Boolean),
  );
  const isProduction = env.DEVORA_API_ENV === 'production';

  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Sem Origin: curl, health check, app nativo. Não é requisição de browser.
    if (!origin) return callback(null, true);
    if (allowlist.has(origin)) return callback(null, true);

    if (!isProduction) {
      try {
        const { hostname } = new URL(origin);
        if (PRIVATE_LAN_HOST.test(hostname)) return callback(null, true);
      } catch {
        // origem malformada cai na negativa abaixo
      }
    }
    return callback(null, false);
  };
}

export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  /*
    QUEM O LIMITE DE TAXA ESTÁ CONTANDO.

    O limite de 300/min e o controle de força bruta do login contam por
    `req.ip`. Servido direto, `req.ip` é o cliente e está certo. Atrás de um
    proxy reverso — que é como este ERP vai ser publicado — `req.ip` é o IP DO
    PROXY: as seis operações, todos os caixas e todo visitante da vitrine
    dividem o MESMO balde, e um robô na vitrine derruba a venda do balcão com
    429.

    `trust proxy` conserta isso e abre outro buraco, e é por isso que o valor é
    DO DONO e não um padrão nosso: com ele ligado, o Express passa a acreditar
    no `X-Forwarded-For`, que é a coisa mais barata de forjar — quem mandar um
    IP diferente a cada tentativa some do controle de força bruta. Só quem sabe
    a topologia da publicação pode decidir, e o número é a quantidade de saltos
    confiáveis.

    Zero (o padrão) mantém o comportamento de hoje: nada é confiado.
  */
  if (env.DEVORA_TRUST_PROXY > 0) app.set('trust proxy', env.DEVORA_TRUST_PROXY);

  // CSP de API, HSTS por HTTPS, nosniff e X-Frame-Options — na frente de
  // TUDO, para valer também em /uploads, preflight, 429 e erro do parser
  // (GAP-PRD-156; ver `middleware/cabecalhosDeSeguranca.ts`).
  app.use(cabecalhosDeSeguranca);

  /*
    `exposedHeaders` existe por causa do DOWNLOAD, e a falta dele produzia um
    defeito que ninguém atribuiria ao CORS.

    O navegador entrega ao JavaScript apenas SEIS cabeçalhos de resposta por
    padrão (Cache-Control, Content-Language, Content-Length, Content-Type,
    Expires, Last-Modified). Todo o resto é filtrado — não some da rede, some
    do alcance do código. `Content-Disposition` não está na lista.

    Isso importa porque baixar arquivo aqui NÃO pode ser feito com
    `window.open` nem com `<a href>`: `authMiddleware` lê o token só do
    cabeçalho `Authorization`, e janela aberta assim não manda header nenhum —
    recebe 401. O caminho é buscar com `fetch`, transformar em Blob e salvar. E
    aí quem nomeia o arquivo é o JavaScript, lendo o `Content-Disposition`.

    Sem esta linha, o servidor manda o nome, o navegador o descarta em
    silêncio, e o contador recebe "download" ou um GUID em vez de
    "pacote-preco-justo-2026-07.zip". Nenhum erro aparece em lugar nenhum.
  */
  app.use(
    cors({
      origin: buildCorsOriginCheck(env),
      credentials: true,
      // `X-Perfil-Em-Vigor`: o perfil mudou desde o token e a tela precisa
      // saber para redesenhar o menu (GAP-PRD-053, `middleware/auth.ts`).
      // `X-Pacote-Sha256`: o hash do pacote do contador, que a tela mostra a
      // quem baixou (GAP-PRD-176) — o navegador o filtraria sem esta lista.
      // `X-Acesso-Em-Vigor`: o ACESSO (capabilities, caixas, bancadas) mudou
      // desde o token — a tela relê /auth/session e redesenha (RBAC granular).
      exposedHeaders: ['Content-Disposition', 'X-Perfil-Em-Vigor', 'X-Acesso-Em-Vigor', 'X-Pacote-Sha256'],
    }),
  );

  /*
    O ID DA REQUISIÇÃO NASCE ANTES DO PARSER DO CORPO (GAP-PRD-157).

    Ficava depois dos `express.json` abaixo: um corpo quebrado estourava no
    parser, o erro pulava este middleware, e a resposta saía com um id
    inventado no tratador — sem `X-Request-Id` no cabeçalho e sem o id que o
    cliente mandou. Justamente a recusa que mais precisa ser rastreada (o
    pacote antigo mandando corpo que a versão nova não lê) era a única sem
    rastro.
  */
  app.use((req, res, next) => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const correlationId = (req.headers['x-correlation-id'] as string) || requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Correlation-Id', correlationId);
    (req as express.Request & { requestId: string; correlationId: string }).requestId = requestId;
    (req as express.Request & { correlationId: string }).correlationId = correlationId;
    next();
  });

  // Percebe o proxy que ninguém declarou em DEVORA_TRUST_PROXY (e o caminho
  // que contorna o proxy declarado) e avisa uma vez — GAP-PRD-055.
  app.use(observarProxy);

  /*
    Foto de produto, certificado A1 e planilha de importação viajam em base64
    no corpo. O limite geral de 1 MB continua valendo para todo o resto — só
    estas rotas precisam de folga, e é melhor abri-la aqui do que afrouxar a
    API inteira.

    A PLANILHA PRECISA ESTAR NESTA LISTA, e não é detalhe de tamanho.

    Base64 cresce 33%, então o teto de 1 MB do corpo corta um arquivo de ~768
    KB. A rota de importação tem teto PRÓPRIO, com código de erro e texto que
    dizem o que fazer — mas o body-parser roda ANTES da rota existir. Sem esta
    linha, quem sobe uma planilha grande nunca chega à mensagem boa: recebe o
    estouro do parser, que na tela vira "falha ao enviar" e não diz nada.

    A folga aqui é maior que o teto de lá de propósito: quem manda quem recusa
    é a rota, que sabe explicar.
  */
  app.use(
    [
      '/api/v1/core/products/:id/images',
      '/api/v1/core/fiscal/certificate',
      '/api/v1/core/import/produtos',
      // Logo/capa da loja (rodada 40): imagem em base64, mesmo motivo das fotos.
      '/api/v1/core/storefront/imagem',
      // Foto da OS (rodada 52): a prova do que chegou e do que foi feito.
      // Sem esta linha, a foto de 2 MB morre no parser de 1 MB e o mecânico
      // vê "falha ao enviar" em vez da mensagem que a rota sabe dar.
      '/api/v1/core/workshop/orders/:id/photos',
      // Foto da máquina (GAP-PRD-106): o mesmo tamanho da foto da OS.
      '/api/v1/core/equipment/:id/photos',
      // Layout da plaquinha (rodada 53): a logo da empresa viaja em base64, e
      // o teto que vale é o da rota (512 KB de imagem). Sem esta linha a logo
      // morre no parser de 1 MB e a resposta vira "Erro interno" — a recusa
      // que explica o tamanho nunca chega a quem está subindo a marca.
      '/api/v1/core/equipment-tags/layout',
      // A folha desenhada com a logo embutida volta grande; e a prévia manda o
      // layout inteiro no corpo.
      '/api/v1/core/equipment-tags/sheet',
    ],
    express.json({ limit: '8mb' }),
  );
  /*
    O agente local da maquininha assina o corpo CRU de cada pedido (GAP-PRD-014,
    `agentSignature.ts`). Depois do parser, os bytes originais não existem mais
    — e reserializar o JSON não devolve os mesmos bytes. Então, só nestas
    rotas, o parser guarda o corpo como chegou em `req.rawBody`.
  */
  app.use(
    '/api/v1/payment-terminals/agent',
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  /*
    O QUE SAI DE /uploads NUNCA RODA NADA (GAP-PRD-066).

    As três pastas são públicas e o nome é o que protege. Até aqui elas saíam
    ANTES do middleware de cabeçalhos de segurança, sem política nenhuma: um
    SVG com `<script>` gravado como logo abria pela URL direta e executava na
    origem do ERP. `sandbox` põe o documento numa origem opaca, sem script e
    sem formulário; `default-src 'none'` corta qualquer busca que ele tentasse.
    Imagem dentro de `<img>` não é afetada — a política vale para quem abre o
    arquivo como documento. `nosniff` impede o navegador de "adivinhar" HTML
    num arquivo com outro tipo.
  */
  const semConteudoAtivo = (res: express.Response) => {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };

  // Arquivos enviados (fotos de produto). Servidos como estáticos, com cache,
  // em vez de trafegar base64 a cada listagem.
  app.use(
    '/uploads/produtos',
    express.static(uploadsDir(), {
      maxAge: '7d',
      /*
        IMUTÁVEL (P0 da Preço Justo): todo arquivo desta pasta nasce com nome
        gerado e nunca é reescrito — foto nova, miniatura nova e clone são
        sempre um NOME novo. `immutable` tira a revalidação a cada recarga: a
        miniatura do balcão sai do cache do navegador sem ir à rede, que é o
        que a deixa aparecer com a rede fraca ou caída.
      */
      immutable: true,
      // Nada de listar diretório nem servir arquivo desconhecido como HTML.
      index: false,
      dotfiles: 'deny',
      setHeaders: semConteudoAtivo,
    }),
  );
  // Logo e capa das lojas (rodada 40) — mesmas regras das fotos de produto.
  app.use(
    '/uploads/lojas',
    express.static(storeUploadsDir(), {
      maxAge: '7d',
      index: false,
      dotfiles: 'deny',
      setHeaders: semConteudoAtivo,
    }),
  );
  /*
    Fotos da OS (rodada 52) — POR LINK ASSINADO (GAP-PRD-184).

    O endereço era público, como o das outras duas pastas, e o que protegia a
    foto era só o NOME. Mas é o aparelho do cliente: o link encaminhado valia
    para qualquer um e para sempre. Agora o guarda confere a assinatura de uma
    hora que só a listagem da OS (com sessão e alcance) entrega, e o cache é
    privado — quem põe o `Cache-Control` é o guarda, com o que resta da
    validade. Ver `services/core/FotoDaOsAssinada.ts`.
  */
  app.use(
    '/uploads/os',
    guardaDaFotoAssinada(),
    express.static(photosDir(), {
      cacheControl: false,
      index: false,
      dotfiles: 'deny',
    }),
  );
  // Fotos da máquina (GAP-PRD-106) — mesmas regras das fotos da OS: link
  // assinado e curto, cache privado (GAP-PRD-184, na junção das frentes).
  app.use(
    '/uploads/equipamentos',
    guardaDaFotoAssinada('equipamentos'),
    express.static(equipmentPhotosDir(), {
      cacheControl: false,
      index: false,
      dotfiles: 'deny',
      setHeaders: semConteudoAtivo,
    }),
  );
  // As telas (out/ do vite build), quando DEVORA_SERVIR_FRONTEND=true — antes
  // do limite de taxa, como os uploads (GAP-PRD-013).
  montarFrontendEstatico(app, env);
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.use('/api/v1', v1Router);

  /*
    O CAMINHO QUE NÃO CHEGA A ROTA NENHUMA.

    Sem este tratador, o Express responde a página padrão dele — 200 bytes
    de `<!DOCTYPE html>` dizendo "Cannot GET /api/v1/o-que-o-cliente-digitou".
    Numa API isso é errado por três motivos, e o terceiro só nasceu agora:

      - o erro deste servidor TEM envelope, e toda tela sabe lê-lo. O 404 do
        framework não tem — nem código, nem requestId, nem correlationId;
      - a página ECOA o caminho pedido de volta, dentro de HTML. Não é
        segredo, mas um respondedor de API não tem por que ter superfície
        nenhuma;
      - e o cliente passou a transformar corpo-não-JSON em
        `API_INVALID_RESPONSE`, cuja frase manda procurar proxy no caminho.
        Diante deste 404 a frase é FALSA: não há proxy — a rota é que não
        existe.

    O gatilho realista é o deploy: o pacote antigo no cache do navegador
    chama uma rota que saiu. O que ele tem de receber é "não encontrado".

    Vem DEPOIS do roteador e ANTES do tratador de erro, que é a única
    posição em que ele vê o que ninguém atendeu sem atrapalhar quem atendeu.
  */
  app.use((_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next(new ApiError('API_NOT_FOUND', 'Rota não encontrada.', 404));
  });

  app.use((erroRecebido: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    const requestId = (req as express.Request & { requestId?: string }).requestId ?? randomUUID();
    // Corpo quebrado, acima do teto ou em charset ilegível é erro de QUEM
    // MANDOU: vira ApiError e segue o caminho de toda recusa (GAP-PRD-157).
    const err = erroDoCorpoDaRequisicao(erroRecebido) ?? erroRecebido;
    if (err instanceof ApiError) {
      createRequestLog({
        method: req.method,
        path: req.path,
        status: err.status,
        requestId,
      });
      const correlationId = (req as express.Request & { correlationId?: string }).correlationId ?? requestId;
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
        requestId,
        correlationId,
      });
      return;
    }
    /*
      O ERRO PRECISA APARECER NO LOG.

      Antes registrava-se só o caminho e o id da requisição. Um 500 sem a causa
      é indistinguível de outro 500, e diagnosticar em produção virava
      adivinhação — foi exatamente o que aconteceu ao investigar uma falha de
      venda: o log dizia que falhou e não dizia o quê.

      A mensagem NÃO vai para o cliente: a resposta continua sendo "Erro
      interno", sem vazar detalhe de banco para quem chamou.
    */
    logError('unhandled_error', {
      path: req.path,
      requestId,
      erro: err instanceof Error ? err.message : String(err),
      pilha: err instanceof Error ? err.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
    });
    const correlationId = (req as express.Request & { correlationId?: string }).correlationId ?? requestId;
    res.status(500).json({
      error: { code: 'API_UNAVAILABLE', message: 'Erro interno.' },
      requestId,
      correlationId,
    });
  });

  return app;
}
