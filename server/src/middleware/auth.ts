import { type Request, type Response, type NextFunction } from 'express';
import { verifyAccessToken, type AuthTokenPayload } from '../services/api/ApiAuthService.js';
import { conferirContaDaSessao } from '../services/auth/ContaDaSessao.js';
import type { AcessoEfetivo } from '../services/auth/AcessoEfetivo.js';
import { capabilitiesDaExpressao, passaNaExpressao } from '../services/auth/Capabilities.js';
import { PERMISSAO_PARA_CAPABILITY } from '../services/auth/TraducaoDePermissoes.js';
import { ApiError } from '../utils/errors.js';

export type AuthedRequest = Request & {
  /**
   * O token, com o perfil (modelo aplicado) de agora — e o ACESSO EFETIVO do
   * vínculo (RBAC granular): capabilities, caixas e bancadas, lidos do banco
   * nesta requisição. `acesso` não é enumerável: o eco da sessão
   * (`GET /auth/session`) e qualquer `JSON.stringify(req.auth)` continuam sem
   * as capabilities, que não moram no token.
   */
  auth?: AuthTokenPayload & { acesso?: AcessoEfetivo };
  requestId?: string;
  correlationId?: string;
};

/**
 * ============================================================================
 * SENHA PROVISÓRIA NÃO NAVEGA A API (GAP-PRD-202)
 * ============================================================================
 *
 * A etapa de troca da senha provisória existia só no navegador (`Protected`
 * mandava a sessão de volta para a porta). A API servia todas as rotas com o
 * token emitido pela senha que a GESTÃO definiu — e portanto conhece: quem a
 * digitou operava por HTTP em nome do novato, sem passar por tela nenhuma.
 *
 * Agora o token dessa sessão vem marcado (`senhaProvisoria`, emitido pelo
 * login) e `authMiddleware` o recusa com 403 em TODA rota. É falha fechada: a
 * rota que alguém criar amanhã com `authMiddleware` já nasce recusando.
 *
 * As exceções são as três rotas da própria etapa — trocar a senha, consultar a
 * sessão, sair — e elas não passam por aqui: usam
 * `autenticacaoDaEtapaDeTroca`, logo abaixo, NOMEADA na linha da rota. Uma
 * lista de caminhos liberados dentro deste middleware seria a mesma lista de
 * exceção que esquece o próximo caso; um middleware com outro nome deixa a
 * exceção escrita onde a próxima pessoa vai ler.
 *
 * 403, e não 401: quem chegou aqui está autenticado — o cliente que renova o
 * token num 401 renovaria de novo, para sempre, e a marca atravessa o refresh.
 */
const SENHA_PROVISORIA_EXIGE_TROCA =
  'Esta sessão entrou com a senha provisória definida pela gestão. '
  + 'Troque a senha para continuar — até lá, só a troca, a sessão e a saída respondem.';

/**
 * O cabeçalho que avisa a tela de que o perfil mudou desde o token.
 *
 * O servidor já usa o perfil de agora; a tela guarda o do login e é com ele
 * que monta o menu. Sem o aviso, o gerente rebaixado veria o menu de gerente
 * (e levaria 403) e o atendente promovido não veria o que passou a alcançar
 * até entrar de novo. Exposto ao JavaScript pelo CORS em `app.ts`.
 */
export const CABECALHO_PERFIL_EM_VIGOR = 'X-Perfil-Em-Vigor';

/**
 * O cabeçalho que avisa a tela de que o ACESSO mudou desde o token (RBAC
 * granular): capability dada ou tirada, modelo editado, escopo de caixa ou de
 * bancada trocado. O valor é o carimbo novo (não secreto); o token carrega o
 * carimbo da emissão (`acessoCarimbo`). A tela relê `GET /auth/session` e
 * redesenha menu e guardas sem novo login. Exposto pelo CORS em `app.ts`.
 */
export const CABECALHO_ACESSO_EM_VIGOR = 'X-Acesso-Em-Vigor';

function autenticar(req: AuthedRequest, res: Response, aceitaSenhaProvisoria: boolean): ApiError | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return new ApiError('API_AUTHENTICATION_REQUIRED', 'Autenticação obrigatória.', 401);
  }
  let senhaProvisoriaNoBanco: boolean;
  try {
    const doToken = verifyAccessToken(header.slice(7));
    /*
      A CONTA DE AGORA, e não só a assinatura (GAP-PRD-053): desativado, com a
      senha trocada, removido desta operação ou com a operação desativada cai
      AQUI, na requisição seguinte ao gesto — e não quando o token vencer. O
      perfil e o acesso que valem são os do vínculo de agora. Vale também para
      as rotas da etapa de troca: conta desligada não troca senha nem consulta
      sessão.
    */
    const emVigor = conferirContaDaSessao(doToken);
    const auth: AuthTokenPayload & { acesso?: AcessoEfetivo } = { ...doToken, profileCodes: emVigor.profileCodes };
    Object.defineProperty(auth, 'acesso', { value: emVigor.acesso, enumerable: false, writable: false, configurable: true });
    req.auth = auth;
    senhaProvisoriaNoBanco = emVigor.senhaProvisoria;
    if (emVigor.profileCodes[0] !== doToken.profileCodes?.[0]) {
      res.setHeader(CABECALHO_PERFIL_EM_VIGOR, emVigor.profileCodes[0]);
    }
    if (emVigor.acesso.carimbo !== doToken.acessoCarimbo) {
      res.setHeader(CABECALHO_ACESSO_EM_VIGOR, emVigor.acesso.carimbo);
    }
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  /*
    A senha provisória vale pela marca do token OU pela conta de agora: um
    token emitido por outro caminho (sem a marca) numa conta que a gestão
    acabou de pôr em senha provisória não opera o sistema.
  */
  if ((req.auth.senhaProvisoria === true || senhaProvisoriaNoBanco) && !aceitaSenhaProvisoria) {
    return new ApiError('API_PASSWORD_CHANGE_REQUIRED', SENHA_PROVISORIA_EXIGE_TROCA, 403);
  }
  return null;
}

export function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    const recusa = autenticar(req, res, false);
    next(recusa ?? undefined);
  } catch (err) {
    next(err);
  }
}

/**
 * A autenticação das TRÊS rotas da etapa de troca — `POST /auth/password`,
 * `GET /auth/session` e `POST /auth/logout`. Aceita o token da senha
 * provisória, porque é com ele que a pessoa troca a senha (ou desiste e sai).
 *
 * Não use em rota que lê ou escreve dado da operação: a razão de existir de
 * `authMiddleware` recusar esse token é justamente que outra pessoa conhece
 * a senha que o emitiu.
 */
export function autenticacaoDaEtapaDeTroca(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    const recusa = autenticar(req, res, true);
    next(recusa ?? undefined);
  } catch (err) {
    next(err);
  }
}

/**
 * A autenticação do LOGOUT (R2-SESSAO): a da etapa de troca — e, quando ela
 * recusa com 401 (access vencido, encerrado, ausente) e o corpo traz um
 * refresh, deixa passar SEM `req.auth`, para a rota encerrar pela família do
 * refresh.
 *
 * Por quê: com o access vencido e a renovação indisponível (429, 5xx), o
 * logout do cliente não chegava ao servidor e a família vivia até sete dias. O
 * refresh do corpo é credencial suficiente para ENCERRAR a sessão dele — não
 * para ler nem escrever nada: a rota só revoga, responde sempre o mesmo 204 e
 * tem teto de taxa próprio. Sem refresh no corpo, o 401 segue como sempre.
 */
export function autenticacaoDaSaida(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    const recusa = autenticar(req, res, true);
    if (!recusa) {
      next();
      return;
    }
    const refresh = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    if (recusa.status === 401 && typeof refresh === 'string' && refresh !== '') {
      req.auth = undefined;
      next();
      return;
    }
    next(recusa);
  } catch (err) {
    next(err);
  }
}

/**
 * Guarda de permissão.
 *
 * O QUE ESTAVA ERRADO: comparava a string da permissão com os CÓDIGOS DE
 * PERFIL do token — `profiles.includes('asaas.charge.create')`. Perfil é
 * `gestor`, `mecanico`, `operador_caixa_loja`; permissão é
 * `asaas.charge.create`. Nunca casava, e o único caminho que passava era o
 * atalho do `admin_geral`.
 *
 * Consequência medida: 235 rotas em 18 roteadores respondiam só ao
 * administrador. Fiscal, CRM, BI, oficina, locação, promoções, logística,
 * terminais e e-commerce estavam escritos e testados, e devolviam 403 para
 * todo mundo. Funcionalidade inalcançável é pior que funcionalidade ausente,
 * porque parece pronta.
 *
 * Depois a pergunta foi para `Permissions.ts`, que sabia a que módulo cada
 * permissão pertence e quem trabalha nele.
 *
 * AGORA ELA VAI À CAPABILITY DO VÍNCULO (RBAC granular, F1), ROTA A ROTA. A
 * tabela `PERMISSAO_PARA_CAPABILITY` traduz cada rota que chama
 * `requirePermission` (método + caminho) para a expressão de capability que
 * reproduz exatamente quem passava pela matriz de módulos — com a interseção
 * da gerência da maquininha já embutida. Por rota, e não por string: a mesma
 * string guarda leitura numa rota e pareamento em outra (C8). Com os modelos
 * de sistema, ninguém ganha nem perde rota (T1 e a varredura T2 cobram); com
 * a personalização, dar ou tirar a capability passa a valer na requisição
 * seguinte. Rota sem linha na tabela NEGA — falha fechada.
 *
 * A mensagem de recusa é a de sempre (`Permissão negada: <string>.`), com as
 * capabilities no detalhe. A tabela e esta função morrem na fatia (e) da F2,
 * quando as chamadas viram `comCapability`.
 */
export function requirePermission(permission: string) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const traducao = PERMISSAO_PARA_CAPABILITY[chaveDaRota(req)];
    const acesso = req.auth?.acesso;
    if (!traducao || traducao.permissao !== permission || !acesso || !passaNaExpressao(acesso.capabilities, traducao.expressao)) {
      next(
        new ApiError(
          'API_PERMISSION_DENIED',
          `Permissão negada: ${permission}.`,
          403,
          traducao
            ? { capabilities: [...capabilitiesDaExpressao(traducao.expressao)], companyId: req.auth?.companyId ?? null }
            : { motivo: 'Esta rota não tem tradução de permissão para capability.' },
        ),
      );
      return;
    }
    next();
  };
}

/**
 * A rota desta requisição como a tabela de tradução a conhece: `MÉTODO
 * /caminho`, com o caminho DECLARADO (`/shipments/:id/label`, não o valor) e
 * sem o prefixo `/api/v1`. Dentro de uma middleware de rota o Express já
 * preencheu `req.route` e `req.baseUrl` (o ponto de montagem do roteador).
 */
export function chaveDaRota(req: Request): string {
  const metodo = req.method === 'HEAD' ? 'GET' : req.method.toUpperCase();
  const base = (req.baseUrl ?? '').replace(/^\/api\/v1(?=\/|$)/, '');
  const rota = (req as Request & { route?: { path?: unknown } }).route;
  const caminho = typeof rota?.path === 'string' ? rota.path : req.path;
  return `${metodo} ${base}${caminho}`;
}

/**
 * A declaração de rota aberta DE PROPÓSITO.
 *
 * Uma rota sem guarda NENHUMA é indistinguível de esquecimento: a rota que
 * alguém decidiu abrir (login, vitrine da loja, webhook, health) e a rota que
 * alguém esqueceu de guardar têm exatamente a mesma cara no código — e foi
 * assim que duas rotas de carrinho/pedido ficaram abertas a qualquer perfil
 * autenticado até a rodada 29. Esta função é o jeito de dizer "aberta de
 * propósito, e eis o porquê", no único lugar onde a próxima pessoa vai ler:
 * a própria linha da rota.
 *
 * Em execução ela é um no-op — não guarda nada, e não deve: quando essas
 * rotas rodam, não existe sessão para interrogar. Quem a torna obrigatória é
 * a regra de lint `rota-declara-alcance`, que recusa rota calada e recusa
 * também `rotaPublica('')`: declaração sem motivo é só um jeito novo de
 * silenciar a regra.
 *
 * O parâmetro existe para forçar o motivo a ser escrito; ele não é usado em
 * execução de propósito — o leitor é o destinatário, não o servidor.
 */
export function rotaPublica(motivo: string) {
  void motivo;
  /*
    Os dois primeiros parâmetros são `unknown` de propósito: este middleware
    não lê nada de req/res, e tipá-los como `Request`/`Response` genéricos
    faria o TypeScript inferir OUTRO tipo de params para a rota inteira —
    `req.params.slug` viraria `string | string[]` nos handlers vizinhos.
    `unknown` aceita qualquer coisa e não participa da inferência.
  */
  return (_req: unknown, _res: unknown, next: NextFunction): void => {
    next();
  };
}

/**
 * A declaração de rota SÓ AUTENTICADA, de propósito (RBAC granular).
 *
 * O irmão de `rotaPublica` para as rotas que exigem sessão e não pedem
 * capability nenhuma, porque operam só sobre a PRÓPRIA sessão: trocar a
 * própria senha, sair, consultar a sessão, trocar de empresa entre os próprios
 * vínculos. Hoje elas declaram `rotaPublica` com um motivo que diz "sem
 * permissão de propósito"; esta é a declaração que diz isso pelo nome.
 *
 * Em execução é um no-op: quem exige a sessão é a autenticação ao lado
 * (`authMiddleware` e irmãs). A regra `rota-declara-alcance` exige o motivo
 * literal e recusa a rota que declare isto E peça capability.
 */
export function soAutenticado(motivo: string) {
  void motivo;
  return (_req: unknown, _res: unknown, next: NextFunction): void => {
    next();
  };
}

export function requireCompanyScope(req: AuthedRequest, res: Response, next: NextFunction): void {
  const companyId = req.params.companyId ?? req.body?.companyId ?? req.query.companyId;
  if (companyId && req.auth?.companyId && companyId !== req.auth.companyId) {
    next(new ApiError('API_TENANT_MISMATCH', 'Empresa não autorizada.', 403));
    return;
  }
  next();
}
