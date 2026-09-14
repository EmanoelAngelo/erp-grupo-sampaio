/**
 * Autenticação real do Grupo Sampaio ERP.
 *
 * Substitui o endpoint anterior, que emitia uma sessão válida a partir de um
 * `userId`/`companyId` enviados pelo próprio cliente, sem verificar senha —
 * ou seja, qualquer pessoa podia se autenticar como qualquer usuário de
 * qualquer empresa.
 *
 * Aqui: senha verificada com Argon2id, escopo de empresa derivado do vínculo
 * no banco, lockout e rate limit no servidor.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import {
  authMiddleware,
  autenticacaoDaEtapaDeTroca,
  autenticacaoDaSaida,
  requirePermission,
  rotaPublica,
  type AuthedRequest,
} from '../../middleware/auth.js';
import {
  conferirProvaDaSessao,
  encerrarSessao,
  encerrarSessaoPeloRefresh,
  issueSession,
  refreshSession,
  trocarOperacaoDaSessao,
} from '../../services/api/ApiAuthService.js';
import {
  assertMembership,
  clearLoginAttempts,
  findUserById,
  findUserByLogin,
  isLockedOut,
  listMemberships,
  recordLoginAttempt,
  updatePasswordHash,
} from '../../services/auth/IdentityService.js';
import {
  assertPassword,
  recordLastLogin,
  registrarTrocaDaPropriaSenha,
  senhaEProvisoria,
} from '../../services/core/TeamService.js';
import { assertTerminalDaEmpresa } from '../../services/core/TerminalRegistry.js';
import {
  hashPassword,
  verifyPassword,
  wasteVerificationTime,
} from '../../services/auth/PasswordService.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit/AuditService.js';
import { acessoDoVinculo, acessoParaResposta, modeloDoCodigo } from '../../services/auth/AcessoEfetivo.js';
import { ipDeOrigem } from '../../middleware/ipDeOrigem.js';
import {
  MENSAGEM_DO_PEDIDO,
  pedirCodigoDeRecuperacao,
  recuperacaoDisponivel,
  recuperarSenhaComCodigo,
} from '../../services/auth/RecuperacaoDeSenhaDaEquipe.js';

export const authRouter = Router();

/**
 * "Visão Grupo Sampaio" é uma consolidação de leitura, não uma empresa
 * operante: ninguém abre sessão nela. Vendas, caixa e estoque sempre
 * pertencem a uma das seis operações reais.
 */
const CONSOLIDATION_TENANTS = new Set(['grupo-sampaio', 'grupo']);

const loginSchema = z.object({
  login: z.string().min(1).max(120),
  password: z.string().min(1).max(200),
  companyId: z.string().optional(),
});

/*
  O endereço de origem — o que alimenta o bloqueio por par (login + origem) da
  rodada 34 e a trilha de auditoria.

  Era SEMPRE o socket, para que um X-Forwarded-For forjado não fizesse o
  atacante "trocar de aparelho". Certo para o servidor servido direto; errado
  atrás de um proxy reverso, onde o socket é o proxy para todo mundo e o par
  voltava a trancar o gerente em todos os caixas (GAP-PRD-074). A regra agora
  mora em `middleware/ipDeOrigem.ts`: socket sem proxy declarado; com
  DEVORA_TRUST_PROXY > 0, o endereço que o salto confiável acrescentou — o
  que o cliente escreve no cabeçalho continua sem valer.
*/
function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  return ipDeOrigem(req);
}

/** Resposta única para credencial inválida — não revela se o login existe. */
function invalidCredentials(): ApiError {
  return new ApiError('API_INVALID_CREDENTIALS', 'Usuário ou senha inválidos.', 401);
}

authRouter.post('/login', rotaPublica('login: quando esta rota roda ainda não existe sessão — a credencial é a senha'), async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError('API_INVALID_PAYLOAD', 'Login e senha são obrigatórios.', 400);
    }
    const { login, password, companyId } = parsed.data;
    const ip = clientIp(req);

    if (companyId && CONSOLIDATION_TENANTS.has(companyId)) {
      throw new ApiError(
        'API_INVALID_PAYLOAD',
        'A visão consolidada do grupo não aceita login direto. Escolha uma operação.',
        400,
      );
    }

    if (isLockedOut(login, ip)) {
      throw new ApiError(
        'API_LOGIN_LOCKED',
        'Conta temporariamente bloqueada por excesso de tentativas. Aguarde 15 minutos.',
        429,
      );
    }

    const user = findUserByLogin(login);
    if (!user || !user.active) {
      // Consome tempo equivalente ao de um login válido para não vazar
      // por timing quais logins existem.
      await wasteVerificationTime();
      recordLoginAttempt(login, ip, false);
      throw invalidCredentials();
    }

    const verification = await verifyPassword(password, user.password_hash);
    if (!verification.valid) {
      recordLoginAttempt(login, ip, false);
      throw invalidCredentials();
    }

    // Migração gradual: hash legado válido é reescrito em Argon2id agora.
    if (verification.needsRehash) {
      updatePasswordHash(user.id, await hashPassword(password));
    }

    const memberships = listMemberships(user.id);
    if (memberships.length === 0) {
      recordLoginAttempt(login, ip, false);
      throw new ApiError(
        'API_NO_MEMBERSHIP',
        'Usuário sem empresa vinculada. Contate o administrador.',
        403,
      );
    }

    // O tenant vem do vínculo no banco. Se o cliente pedir uma empresa,
    // ela precisa estar entre as dele — senão é rejeitada.
    const selected = companyId
      ? memberships.find((m) => m.company_id === companyId)
      : memberships[0];
    if (!selected) {
      throw new ApiError('API_TENANT_MISMATCH', 'Empresa não autorizada para este usuário.', 403);
    }

    recordLoginAttempt(login, ip, true);
    clearLoginAttempts(login);
    // Guardado no usuário porque core_login_attempts é expurgável: é controle
    // de força bruta, e o gestor precisa deste dado para saber que a conta
    // parou de ser usada.
    recordLastLogin(user.id);

    /*
      A senha que acabou de conferir é a PROVISÓRIA da gestão? Então a sessão
      nasce marcada, e a API só responde à etapa de troca (GAP-PRD-202 — ver
      `autenticacaoDaEtapaDeTroca`). A mesma leitura vai no corpo, para a tela
      abrir a etapa: token e corpo não podem discordar.
    */
    const senhaProvisoria = senhaEProvisoria(user.id);

    const tokens = issueSession({
      userId: user.id,
      companyId: selected.company_id,
      profileCodes: [selected.profile_code],
      sessionVersion: user.session_version,
      senhaProvisoria,
    });

    recordAudit({
      companyId: selected.company_id,
      userId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip,
    });

    // O acesso efetivo do vínculo escolhido (RBAC granular): a tela monta menu,
    // rotas e casa por ele. As capabilities vão no CORPO, nunca no token.
    const acesso = acessoDoVinculo(user.id, selected.company_id);

    res.json({
      ...tokens,
      access: acesso ? acessoParaResposta(acesso) : null,
      user: {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        profileCode: selected.profile_code,
        /*
          A bandeira da senha provisória ATRAVESSA o login. Era gravada na
          criação e no reset da gestão e nenhum passo do login a devolvia — a
          tela não tinha COMO pedir a troca, porque o único lugar que a
          expunha era /core/team, que o próprio novato não alcança. Quem
          troca de fato é `POST /auth/password`, logo abaixo.
        */
        mustChangePassword: senhaProvisoria,
      },
      company: {
        id: selected.company_id,
        slug: selected.slug,
        tradeName: selected.trade_name,
        kind: selected.kind,
      },
      companies: memberships.map((m) => ({
        id: m.company_id,
        slug: m.slug,
        tradeName: m.trade_name,
        kind: m.kind,
        profileCode: m.profile_code,
        // O nome do modelo aplicado em cada empresa (o seletor mostra); o
        // `profileCode` fica ao lado até a tela nova (F3) terminar.
        modelo: modeloDoCodigo(m.profile_code),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- troca da própria senha

const trocaDeSenhaSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/**
 * O dono da conta troca a PRÓPRIA senha — a saída do beco da provisória.
 *
 * Antes desta rota, a única troca de senha era `POST /core/team/:id/password`,
 * de gestão: o novato que recebia a provisória levava 403 até mirando a si
 * mesmo, e a senha que a gestora conhecia só deixava de ser conhecida por ela
 * se ELA trocasse de novo — regravando `must_change_password = 1`. Beco.
 *
 * Duas credenciais, e nenhuma vem de fora: a sessão do token (só a própria —
 * não existe `:id` aqui de propósito) e a SENHA ATUAL, conferida com Argon2id
 * antes de qualquer escrita. Senha atual errada é 401, não 403: quem chegou
 * até aqui está autenticado; o que falhou foi a credencial extra.
 *
 * A régua da nova é a MESMA da provisória da gestão (`assertPassword`, >= 8):
 * duas réguas divergiriam pelo caminho mais fraco.
 *
 * DEPOIS DA TROCA, TODAS AS SESSÕES CAEM — `session_version` sobe igual ao
 * reset da gestão, e o refresh da própria sessão que pediu a troca morre
 * junto. É decisão, não descuido: se a troca foi porque a senha vazou, a
 * sessão do ladrão não pode sobreviver ao gesto — e não há como derrubar "as
 * outras" sem derrubar todas, porque refresh não sabe de que aparelho veio.
 * O ACCESS de todas elas cai na requisição seguinte (GAP-PRD-053 —
 * `authMiddleware` confere a `session_version`), e o chamador entra de novo,
 * com a senha que agora só ele sabe (a tela já faz isso sozinha).
 *
 * `autenticacaoDaEtapaDeTroca`, e não `authMiddleware`: esta é a rota que o
 * token da senha provisória EXISTE para alcançar (GAP-PRD-202). Todas as
 * outras o recusam com 403 `API_PASSWORD_CHANGE_REQUIRED`.
 */
authRouter.post('/password', autenticacaoDaEtapaDeTroca, rotaPublica('sem permissão de propósito: troca a senha da PRÓPRIA sessão do token — qualquer perfil autenticado, e a credencial extra é a senha atual, conferida no handler'), (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      const parsed = trocaDeSenhaSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ApiError('API_INVALID_PAYLOAD', 'Senha atual e senha nova são obrigatórias.', 400);
      }
      const { currentPassword, newPassword } = parsed.data;
      assertPassword(newPassword);

      const user = findUserById(req.auth!.sub);
      if (!user || !user.active) {
        throw new ApiError('API_INVALID_TOKEN', 'Sessão encerrada. Entre novamente.', 401);
      }

      const verification = await verifyPassword(currentPassword, user.password_hash);
      if (!verification.valid) {
        throw new ApiError('API_INVALID_CREDENTIALS', 'Senha atual incorreta.', 401);
      }

      // O hash é derivado FORA da transação, como nos outros dois caminhos de
      // senha — Argon2id leva centenas de milissegundos.
      registrarTrocaDaPropriaSenha(user.id, await hashPassword(newPassword));

      recordAudit({
        companyId: req.auth!.companyId,
        userId: user.id,
        action: 'auth.password_change',
        entityType: 'user',
        entityId: user.id,
        ip: clientIp(req),
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  })();
});

// ------------------------------------------------- token de terminal do PDV

/**
 * Troca um token de terminal confiável por uma sessão real.
 *
 * ESTE É O ÚNICO CAMINHO SEM DIGITAR SENHA, e ele não é acesso anônimo: o
 * terminal é registrado UMA VEZ por um administrador, guarda apenas um token
 * opaco e o token é revogável a qualquer momento — a alavanca é
 * `POST /device/:id/revoke`, logo abaixo, e `GET /devices` lista o que existe
 * para revogar. Quem autoriza é o cadastro do dispositivo, não a ausência de
 * checagem.
 *
 * Existia antes um acesso por card, que emitia sessão com o login e nenhuma
 * senha. Foi removido: bastava alguém ligar uma variável de ambiente para o
 * balcão inteiro entrar sem credencial. Padrão seguro não é garantia —
 * garantia é o caminho não existir.
 */
authRouter.post('/device/login', rotaPublica('login de terminal: a credencial é o token de dispositivo registrado por um administrador, conferido no handler'), (req, res, next) => {
  try {
    ensureCoreSchema();
    const token = String(req.body?.deviceToken ?? '');
    if (!token) throw new ApiError('API_INVALID_PAYLOAD', 'deviceToken obrigatório.', 400);

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = getConnection()
      .prepare(
        `SELECT d.*, c.slug, c.trade_name, c.kind, t.active AS terminal_active, t.name AS terminal_name
           FROM core_device_tokens d
           JOIN core_companies c ON c.id = d.company_id
           LEFT JOIN core_terminals t ON t.id = d.terminal_id
          WHERE d.token_hash = ? AND d.revoked = 0`,
      )
      .get(tokenHash) as
      | {
          id: string;
          company_id: string;
          terminal_id: string | null;
          user_id: string;
          expires_at: string | null;
          slug: string;
          trade_name: string;
          kind: string;
          terminal_active: number | null;
          terminal_name: string | null;
        }
      | undefined;

    if (!row) throw new ApiError('API_INVALID_TOKEN', 'Token de terminal inválido.', 401);
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ApiError('API_INVALID_TOKEN', 'Token de terminal expirado.', 401);
    }
    // O caixa desligado pelo gerente corta a máquina dele (GAP-PRD-150): o
    // token fica, e volta a entrar se o caixa for religado.
    if (row.terminal_id && row.terminal_active !== 1) {
      throw new ApiError(
        'API_INVALID_TOKEN',
        `O caixa "${row.terminal_name ?? row.terminal_id}" deste computador foi desativado pela gerência.`,
        401,
      );
    }

    const user = findUserById(row.user_id);
    if (!user || !user.active) {
      throw new ApiError('API_INVALID_TOKEN', 'Usuário do terminal inativo.', 401);
    }
    const membership = assertMembership(user.id, row.company_id);
    if (!membership) {
      throw new ApiError('API_TENANT_MISMATCH', 'Terminal não autorizado nesta empresa.', 403);
    }

    getConnection()
      .prepare('UPDATE core_device_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.id);

    const tokens = issueSession({
      userId: user.id,
      companyId: row.company_id,
      storeId: row.terminal_id ?? undefined,
      profileCodes: [membership.profile_code],
      sessionVersion: user.session_version,
    });

    recordAudit({
      companyId: row.company_id,
      userId: user.id,
      action: 'auth.device_login',
      entityType: 'device_token',
      entityId: row.id,
      ip: clientIp(req),
    });

    const acesso = acessoDoVinculo(user.id, row.company_id);

    res.json({
      ...tokens,
      access: acesso ? acessoParaResposta(acesso) : null,
      user: {
        id: user.id,
        login: user.login,
        displayName: user.display_name,
        profileCode: membership.profile_code,
      },
      company: {
        id: row.company_id,
        slug: row.slug,
        tradeName: row.trade_name,
        kind: row.kind,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Registra um terminal confiável. Exige sessão de administrador.
 *
 * A guarda era um `if` de perfis DENTRO do handler — `admin_geral` ou
 * `gestor`, escrito à mão. A rodada 31 trocou pelo `requirePermission` na
 * posição de middleware, que a regra de lint sabe ler. O alcance é o MESMO:
 * o módulo `api` em `Permissions.ts` é `{ler: [], escrever: []}`, e lista
 * vazia significa "só quem responde por tudo" — exatamente `admin_geral` e
 * `gestor`. Uma fonte de verdade em vez de duas.
 */
authRouter.post('/device/enroll', authMiddleware, requirePermission('api.device.enroll'), (req: AuthedRequest, res, next) => {
  try {
    ensureCoreSchema();
    const targetUserId = String(req.body?.userId ?? '');
    const label = String(req.body?.label ?? '').trim().slice(0, 80) || 'Terminal';
    const companyId = req.auth!.companyId;
    if (!targetUserId) throw new ApiError('API_INVALID_PAYLOAD', 'userId obrigatório.', 400);
    if (!assertMembership(targetUserId, companyId)) {
      throw new ApiError('API_TENANT_MISMATCH', 'Usuário não pertence a esta empresa.', 403);
    }

    // O caixa do token (GAP-PRD-150): desta operação e LIGADO. O computador
    // registrado com ele passa a operar só a gaveta daquele caixa
    // (`storeId` no token → `terminalDoPedido` nas rotas de caixa e venda).
    const terminal = assertTerminalDaEmpresa(companyId, req.body?.terminalId, { exigirAtivo: true });

    // O token só existe em claro nesta resposta; o banco guarda apenas o hash.
    const raw = randomBytes(32).toString('base64url');
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_device_tokens
           (id, token_hash, company_id, terminal_id, user_id, label, revoked, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        createHash('sha256').update(raw).digest('hex'),
        companyId,
        terminal?.id ?? null,
        targetUserId,
        label,
        req.auth!.sub,
        new Date().toISOString(),
      );

    // A trilha do registro — quem criou o caminho sem senha, para quem e em
    // qual caixa. O token NUNCA entra aqui.
    recordAudit({
      companyId,
      userId: req.auth!.sub,
      action: 'auth.device_enroll',
      entityType: 'device_token',
      entityId: id,
      detail: { label, targetUserId, terminalId: terminal?.id ?? null },
      ip: clientIp(req),
    });

    res.status(201).json({ id, deviceToken: raw, label, terminalId: terminal?.id ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * Os terminais desta empresa — o que existe para auditar e revogar.
 *
 * O cabeçalho de `device/login` promete "revogável a qualquer momento", e
 * promessa sem alavanca só se cumpria com SQL na mão. A alavanca é a rota de
 * revogação abaixo; esta lista é o que a mão da gestão precisa para puxá-la:
 * qual terminal é qual (`label`), se ainda entra (`revoked`, `expiresAt`) e
 * QUANDO entrou pela última vez (`lastUsedAt`) — um terminal que "ninguém usa"
 * usado ontem à noite é exatamente o que se quer descobrir aqui.
 *
 * O que NUNCA sai: o token (só existiu em claro na resposta do enroll) e o
 * hash dele. A lista é para auditar, não para copiar credencial. O alcance é
 * o MESMO do enroll: módulo `api` em Permissions.ts é `{ler: [], escrever: []}`,
 * e lista vazia significa "só quem responde por tudo".
 */
authRouter.get('/devices', authMiddleware, requirePermission('api.device.list'), (req: AuthedRequest, res, next) => {
  try {
    ensureCoreSchema();
    const linhas = getConnection()
      .prepare(
        `SELECT d.id, d.label, d.user_id, d.terminal_id, d.revoked,
                d.created_at, d.last_used_at, d.expires_at,
                u.login AS user_login, u.display_name AS user_display_name,
                t.name AS terminal_name, t.active AS terminal_active
           FROM core_device_tokens d
           JOIN core_users u ON u.id = d.user_id
           LEFT JOIN core_terminals t ON t.id = d.terminal_id
          WHERE d.company_id = ?
          ORDER BY d.created_at DESC`,
      )
      .all(req.auth!.companyId) as unknown as {
      id: string;
      label: string | null;
      user_id: string;
      terminal_id: string | null;
      revoked: number;
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
      user_login: string;
      user_display_name: string;
      terminal_name: string | null;
      terminal_active: number | null;
    }[];
    res.json({
      items: linhas.map((d) => ({
        id: d.id,
        label: d.label,
        userId: d.user_id,
        userLogin: d.user_login,
        userDisplayName: d.user_display_name,
        terminalId: d.terminal_id,
        // O NOME do caixa (GAP-PRD-150): "qual máquina é esta?" se responde
        // com "Caixa 2", não com um uuid.
        terminalName: d.terminal_name,
        terminalActive: d.terminal_id ? d.terminal_active === 1 : null,
        revoked: d.revoked === 1,
        createdAt: d.created_at,
        lastUsedAt: d.last_used_at,
        expiresAt: d.expires_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Revoga um terminal — a promessa do cabeçalho de `device/login`, cumprida.
 *
 * Seta `revoked = 1`, que o guarda do login de terminal já honrava quando a
 * coluna era marcada por SQL — a coluna sempre teve leitor; o que faltava era
 * o escritor alcançável. Revogação não apaga a linha: o registro de que o
 * terminal existiu, quem o criou e quando entrou pela última vez é histórico
 * de auditoria, e `device/login` só aceita `revoked = 0`.
 *
 * O `:id` é o id da LINHA (o que `GET /devices` lista), nunca o token — e a
 * busca é presa à empresa da sessão: gestão de uma operação não revoga (nem
 * descobre que existe) terminal de outra. Id que não é desta empresa e id
 * inventado respondem o MESMO 404.
 *
 * Mesmo alcance do enroll, pelo mesmo módulo `api` de lista vazia: quem
 * registra terminal é quem o corta.
 */
authRouter.post('/device/:id/revoke', authMiddleware, requirePermission('api.device.revoke'), (req: AuthedRequest, res, next) => {
  try {
    ensureCoreSchema();
    const row = getConnection()
      .prepare('SELECT id FROM core_device_tokens WHERE id = ? AND company_id = ?')
      .get(String(req.params.id), req.auth!.companyId) as { id?: string } | undefined;
    if (!row?.id) {
      throw new ApiError('API_DEVICE_NOT_FOUND', 'Terminal não encontrado nesta empresa.', 404);
    }

    getConnection()
      .prepare('UPDATE core_device_tokens SET revoked = 1 WHERE id = ?')
      .run(row.id);

    recordAudit({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      action: 'auth.device_revoke',
      entityType: 'device_token',
      entityId: row.id,
      // O motivo é opcional (a máquina sumiu é motivo bastante), mas quando a
      // tela o manda ele fica na trilha — é a pergunta de quem lê depois.
      detail: {
        reason: typeof req.body?.reason === 'string' && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 200)
          : null,
      },
      ip: clientIp(req),
    });

    res.json({ id: row.id, revoked: true });
  } catch (err) {
    next(err);
  }
});

/*
  NÃO HÁ ENTRADA SEM SENHA.

  Aqui ficava o atalho de desenvolvimento: uma rota que listava os usuários
  ativos de todas as empresas e outra que emitia sessão só com o id, pulando a
  troca obrigatória de senha. As travas dele valiam só com o ambiente
  declarado, e o padrão é `development` — a loja estava nesse buraco. Saiu por
  inteiro: quem pede aqueles endereços recebe o 404 genérico da API, como
  qualquer endereço que nunca existiu. A variável que o ligava ficou
  aposentada (`config/acessoSemSenhaAposentado.ts`), e as linhas antigas da
  auditoria continuam no banco como histórico.
*/

// ------------------------------------------------------------------ sessão

// ------------------------------------------------ esqueci minha senha (GAP-PRD-160)
//
// Decisão do dono, por operação, desligada por padrão — ver
// services/auth/RecuperacaoDeSenhaDaEquipe.ts. As três rotas são públicas
// porque quem as usa ainda não tem sessão; nenhuma diz se uma conta existe.

authRouter.get('/senha/recuperacao', rotaPublica('a tela de login pergunta se oferece "Esqueci minha senha": responde só se alguma operação ligou a recuperação e há SMTP, nada sobre conta nenhuma'), (_req, res, next) => {
  try {
    res.json({ disponivel: recuperacaoDisponivel() });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/senha/esqueci', rotaPublica('recuperação de senha: quem pede ainda não tem sessão; a resposta é sempre a mesma, exista a conta ou não'), (req, res, next) => {
  try {
    const identificador = String(req.body?.identificador ?? '').trim();
    if (!identificador) {
      throw new ApiError('API_INVALID_PAYLOAD', 'Informe o login ou o e-mail.', 400);
    }
    pedirCodigoDeRecuperacao({ identificador: identificador.slice(0, 200), ip: clientIp(req) });
    res.status(202).json({ ok: true, mensagem: MENSAGEM_DO_PEDIDO });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/senha/recuperar', rotaPublica('recuperação de senha: a credencial é o código de uso único enviado ao e-mail da conta, conferido no serviço'), async (req, res, next) => {
  try {
    await recuperarSenhaComCodigo({
      identificador: String(req.body?.identificador ?? '').slice(0, 200),
      codigo: String(req.body?.codigo ?? ''),
      novaSenha: String(req.body?.novaSenha ?? ''),
      ip: clientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', rotaPublica('renovação de sessão: a credencial é o próprio refresh token do corpo — a sessão de acesso já venceu quando ela roda'), (req, res, next) => {
  try {
    res.json(refreshSession(String(req.body?.refreshToken ?? '')));
  } catch (err) {
    next(err);
  }
});

/*
  As três rotas de sessão abaixo têm `authMiddleware` e NENHUMA permissão — e
  é decisão, não esquecimento. Elas operam somente sobre a PRÓPRIA sessão do
  token: encerrar (`logout`), consultar (`session`) e trocar de empresa
  DENTRO dos vínculos que o usuário já tem (`switch-company`, que confere o
  vínculo no handler). Não existe permissão de módulo que caiba aqui: o
  contador, o mecânico e o caixa precisam todos encerrar e consultar a
  própria sessão. O `rotaPublica` declara exatamente isso — "sem guarda de
  ALCANCE de propósito" — e o motivo diz por quê; a autenticação continua
  obrigatória pelo `authMiddleware` ao lado.

  `logout` e `session` usam `autenticacaoDaEtapaDeTroca` (GAP-PRD-202) — o
  `logout` pela `autenticacaoDaSaida`, que é ela mais o caminho do refresh
  (R2-SESSAO): a sessão aberta com a senha provisória precisa conseguir SAIR
  ("Entrar com outra conta") e ser CONSULTADA enquanto a etapa de troca está
  na tela.
  `switch-company` fica com `authMiddleware`: trocar de operação é navegar,
  e senha provisória não navega.
*/
/*
  O logout encerra a SESSÃO INTEIRA no servidor, qualquer que seja o corpo
  (item SESSAO e RES-SESSAO, ASVS 3.3.1): o ACCESS token que chamou (pelo
  `jti`), todos os refresh vivos da FAMÍLIA do token e o access emitido com
  cada um — e ainda o refresh do corpo, para o token de antes do conserto, que
  não tem família. Antes, o cliente que renovava no meio do logout mandava o
  refresh velho no corpo, e o novo vivia sete dias. Vale também na etapa da
  senha provisória, que chega aqui pela mesma `autenticacaoDaEtapaDeTroca`.
  Token sem `jti` nem `sid` (emitido antes dos dois consertos) só tem o
  refresh do corpo revogado e cai no próprio `exp`.

  SEM access válido (R2-SESSAO): o access venceu e a renovação não pôde ser
  atendida (429, 5xx) — antes o logout parava no 401, e a família vivia até
  sete dias. `autenticacaoDaSaida` deixa passar sem `req.auth` quando o corpo
  traz um refresh, e a rota encerra pela família dele. Esse caminho só REVOGA,
  responde sempre o mesmo 204 (exista o refresh ou não: nada vaza) e tem teto
  de taxa próprio, abaixo do teto geral do app. Sem access e sem refresh, o 401
  de sempre.
*/
const limiteDaSaidaPeloRefresh = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Só o caminho sem access conta: a saída autenticada é a de sempre.
  skip: (req) => Boolean((req as AuthedRequest).auth),
  handler: (_req, _res, next) => {
    next(
      new ApiError(
        'API_RATE_LIMITED',
        'Pedidos de saída demais deste endereço. Aguarde um minuto e tente de novo.',
        429,
      ),
    );
  },
});

authRouter.post('/logout', autenticacaoDaSaida, limiteDaSaidaPeloRefresh, rotaPublica('sem permissão de propósito: encerra a PRÓPRIA sessão — a do token, ou, sem access válido, a do refresh do corpo'), (req: AuthedRequest, res, next) => {
  try {
    const refreshDoCorpo = req.body?.refreshToken ? String(req.body.refreshToken) : undefined;
    if (req.auth) {
      encerrarSessao(req.auth, refreshDoCorpo);
    } else {
      encerrarSessaoPeloRefresh(refreshDoCorpo ?? '');
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/session', autenticacaoDaEtapaDeTroca, rotaPublica('sem permissão de propósito: devolve a PRÓPRIA sessão do token — qualquer perfil autenticado'), (req: AuthedRequest, res) => {
  const memberships = listMemberships(req.auth!.sub);
  // O acesso do vínculo ATIVO, lido nesta requisição pela conferência da
  // sessão. É aqui que a tela vem buscar o acesso novo quando recebe
  // `X-Acesso-Em-Vigor`. O eco do token (`session`) segue sem capabilities.
  const acesso = req.auth!.acesso;
  res.json({
    session: req.auth,
    access: acesso ? acessoParaResposta(acesso) : null,
    companies: memberships.map((m) => ({
      id: m.company_id,
      slug: m.slug,
      tradeName: m.trade_name,
      kind: m.kind,
      profileCode: m.profile_code,
      modelo: modeloDoCodigo(m.profile_code),
    })),
  });
});

/**
 * Troca a empresa ativa — apenas entre as que o usuário realmente possui, e só
 * com a PROVA da sessão (R2-SESSAO).
 *
 * A troca emite um refresh novo (sete dias). Pedindo só o access (uma hora),
 * ela transformava um access furtado em refresh — até para a PRÓPRIA operação
 * atual, porque o `assertMembership` só confere o vínculo — e ainda encerrava
 * a família da vítima. Agora o corpo leva o refresh atual, da mesma pessoa e
 * da mesma família do access (`conferirProvaDaSessao`); sem ele, 401. Trocar
 * para a operação em que já se está é recusado (409). As duas recusas vêm
 * antes de qualquer revogação: nada emitido, nada revogado.
 */
authRouter.post('/switch-company', authMiddleware, rotaPublica('sem permissão de propósito: troca apenas entre as empresas do PRÓPRIO vínculo, conferido pelo assertMembership no handler, com a prova da sessão (o refresh atual) conferida antes'), (req: AuthedRequest, res, next) => {
  try {
    const companyId = String(req.body?.companyId ?? '');
    const refreshDaProva = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    conferirProvaDaSessao(req.auth!, refreshDaProva);
    if (companyId === req.auth!.companyId) {
      throw new ApiError(
        'API_SWITCH_SAME_COMPANY',
        'Esta já é a operação ativa desta sessão: nada foi trocado, e a sessão segue como estava.',
        409,
      );
    }
    const membership = assertMembership(req.auth!.sub, companyId);
    if (!membership) {
      throw new ApiError('API_TENANT_MISMATCH', 'Empresa não autorizada.', 403);
    }
    const user = findUserById(req.auth!.sub);
    /*
      A troca é a MESMA sessão em outra operação (RES-SESSAO): mantém a
      família e encerra, antes de emitir, as credenciais de antes — o token
      que chamou e o refresh vivo da família, com o access emitido junto.
      Antes, a sessão nova nascia e a de antes ficava: o token respondia 200
      até o `exp`, e o refresh (que o cliente descarta) renovava por sete dias.
    */
    const tokens = trocarOperacaoDaSessao(req.auth!, refreshDaProva, {
      companyId,
      profileCodes: [membership.profile_code],
      sessionVersion: user?.session_version ?? 1,
      // Inalcançável hoje (`authMiddleware` recusa a sessão provisória antes),
      // e mesmo assim carregada: trocar de operação não lava a marca.
      senhaProvisoria: req.auth!.senhaProvisoria === true,
    });
    // O acesso da empresa de DESTINO (RBAC granular): a tela recalcula menu e casa.
    const acesso = acessoDoVinculo(req.auth!.sub, companyId);
    res.json({ ...tokens, access: acesso ? acessoParaResposta(acesso) : null });
  } catch (err) {
    next(err);
  }
});

/*
  Aqui morava GET /lockout/:login, pública, "diagnóstico para a tela de login".
  Apagada na rodada 34: nenhuma tela a chamava, e o único uso real que tinha
  era confirmar a quem trancou o login de um funcionário que deu certo — e
  dizer quantas tentativas faltavam. A tela de login recebe o 429 da própria
  tentativa; não precisa perguntar antes.
*/

