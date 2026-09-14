/**
 * ============================================================================
 * "ESQUECI MINHA SENHA" PARA A EQUIPE — decisão do dono, com padrão seguro
 * (GAP-PRD-160)
 * ============================================================================
 *
 * ## O que faltava
 *
 * O ERP não tinha recuperação de senha para funcionário: só a gestão redefine
 * (senha provisória, `POST /core/team/:id/password`). Segunda-feira 8h com o
 * gestor ausente e o caixa sem senha é caixa fechado até alguém atender o
 * telefone. O portal do CLIENTE já tinha recuperação por e-mail; a equipe não.
 *
 * ## A decisão continua do dono — o software oferece o mecanismo
 *
 * Gestão como único canal cabe em loja pequena; recuperação pela própria
 * pessoa cabe onde o gestor não está sempre por perto. As duas coisas existem
 * agora, e quem escolhe é o dono, POR OPERAÇÃO (Usuários e equipe). O padrão é
 * DESLIGADO: nada muda para quem não escolher.
 *
 * ## As travas, todas fechando para o lado seguro
 *
 *   - A conta só recupera por e-mail se a recuperação estiver ligada em TODAS
 *     as operações em que ela entra. A senha é uma só; se a loja B não aceita
 *     recuperação por e-mail, o gerente da loja A não decide isso por ela.
 *   - Contas de DONO (admin_geral, gestor, contador — e perfil desconhecido)
 *     nunca recuperam por e-mail: são as que alcançam o grupo inteiro, e os
 *     pares se redefinem entre si (GAP-PRD-010). Caixa de e-mail invadida não
 *     vira o grupo invadido.
 *   - Código de 8 dígitos, uso único, 15 minutos, 5 tentativas. Guarda-se o
 *     HMAC do código (chave derivada de DEVORA_JWT_SECRET), nunca o código.
 *   - A resposta do pedido é SEMPRE a mesma, exista a conta ou não — dizer
 *     "não achei" é entregar a lista de logins. Três pedidos por hora por conta
 *     e dez por endereço de origem; o que passa disso é ignorado em silêncio.
 *   - Trocar a senha pelo código derruba as sessões abertas (session_version),
 *     limpa o bloqueio de login e avisa o dono do e-mail.
 *
 * ## O e-mail
 *
 * O código vai pela fila de e-mail (`core_email_queue`), a mesma do portal. Sem
 * SMTP configurado, a mensagem espera na fila — e a tela de login não oferece o
 * caminho (`recuperacaoDisponivel`), porque oferecer o que não chega seria a
 * porta desenhada que não abre.
 */
import { contaPeloLogin } from './ChaveDoLogin.js';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { hashPassword } from './PasswordService.js';
import { clearLoginAttempts } from './IdentityService.js';
import { eDeDono } from '../core/HierarquiaDePerfis.js';
import { assertPassword, registrarTrocaDaPropriaSenha } from '../core/TeamService.js';
import {
  carteiroConfigurado,
  isDeliverableAddress,
  queueCodigoDaEquipeEmail,
  queueSenhaAlteradaEmail,
} from '../notifications/EmailService.js';

/** Quanto o código vale depois de pedido. */
export const CODIGO_VALE_MS = 15 * 60 * 1000;
/** Tentativas erradas que queimam o código. */
export const MAX_TENTATIVAS_POR_CODIGO = 5;
/** Pedidos por conta, por hora. */
export const MAX_PEDIDOS_POR_HORA = 3;
/** Pedidos por endereço de origem, em 15 minutos. */
export const MAX_PEDIDOS_POR_ORIGEM = 10;

/** O modelo na fila — o código vai SELADO no cofre da fila (GAP-PRD-007); o corpo leva só o marcador. */
export const TEMPLATE_DO_CODIGO = 'recuperacao_senha_equipe';

export const MENSAGEM_DO_PEDIDO =
  'Se a conta tiver e-mail cadastrado e a recuperação estiver ligada nas operações dela, o código '
  + 'chega em alguns minutos. Não chegou? Peça ao gerente para redefinir a sua senha.';

// ---------------------------------------------------------------- configuração

export interface ConfiguracaoDaRecuperacao {
  emailLigado: boolean;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

export function configuracaoDaRecuperacao(companyId: string): ConfiguracaoDaRecuperacao {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT c.email_enabled, c.updated_at, u.display_name AS quem
         FROM core_team_password_recovery_configs c
         LEFT JOIN core_users u ON u.id = c.updated_by
        WHERE c.company_id = ?`,
    )
    .get(companyId) as { email_enabled: number; updated_at: string; quem: string | null } | undefined;
  return {
    emailLigado: row?.email_enabled === 1,
    atualizadoEm: row?.updated_at ?? null,
    atualizadoPor: row?.quem ?? null,
  };
}

export function definirRecuperacaoPorEmail(input: {
  companyId: string;
  ligado: boolean;
  userId: string;
}): ConfiguracaoDaRecuperacao {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `INSERT INTO core_team_password_recovery_configs (company_id, email_enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE
         SET email_enabled = excluded.email_enabled,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
    )
    .run(input.companyId, input.ligado ? 1 : 0, input.userId, new Date().toISOString());
  return configuracaoDaRecuperacao(input.companyId);
}

/**
 * A tela de login deve oferecer "Esqueci minha senha"?
 *
 * Só se ALGUMA operação ativa ligou a recuperação e há SMTP para entregar o
 * código. Não diz nada sobre conta nenhuma.
 */
export function recuperacaoDisponivel(carteiroPronto: boolean = carteiroConfigurado()): boolean {
  if (!carteiroPronto) return false;
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT 1 AS ok
         FROM core_team_password_recovery_configs c
         JOIN core_companies co ON co.id = c.company_id AND co.active = 1
        WHERE c.email_enabled = 1
        LIMIT 1`,
    )
    .get() as { ok?: number } | undefined;
  return row?.ok === 1;
}

// ------------------------------------------------------------------ a conta

interface ContaDaEquipe {
  id: string;
  login: string;
  display_name: string;
  email: string | null;
  active: number;
  customer_id: string | null;
}

/** Login OU e-mail, sem caixa. E-mail que aponta para mais de uma conta não serve. */
function acharConta(identificador: string): ContaDaEquipe | null {
  const termo = identificador.trim();
  if (!termo) return null;
  const db = getConnection();
  // O login pela mesma chave da entrada (acento conta, maiúscula não).
  const porLogin = contaPeloLogin<ContaDaEquipe>(termo);
  if (porLogin) return porLogin;
  const porEmail = db
    .prepare(
      `SELECT id, login, display_name, email, active, customer_id
         FROM core_users WHERE email = ? COLLATE NOCASE`,
    )
    .all(termo) as unknown as ContaDaEquipe[];
  return porEmail.length === 1 ? porEmail[0] : null;
}

interface Vinculo {
  company_id: string;
  profile_code: string;
  is_default: number;
  ligado: number | null;
}

function vinculosAtivos(userId: string): Vinculo[] {
  return getConnection()
    .prepare(
      `SELECT uc.company_id, uc.profile_code, uc.is_default, cfg.email_enabled AS ligado
         FROM core_user_companies uc
         JOIN core_companies co ON co.id = uc.company_id AND co.active = 1
         LEFT JOIN core_team_password_recovery_configs cfg ON cfg.company_id = uc.company_id
        WHERE uc.user_id = ?
        ORDER BY uc.is_default DESC, uc.created_at`,
    )
    .all(userId) as unknown as Vinculo[];
}

/**
 * A conta pode recuperar por e-mail? Devolve a operação onde o e-mail entra na
 * fila (a padrão da pessoa), ou nulo. Toda regra falha fechada.
 */
function elegivel(conta: ContaDaEquipe): { companyId: string } | null {
  if (conta.active !== 1 || conta.customer_id) return null;
  if (!isDeliverableAddress(conta.email)) return null;
  const vinculos = vinculosAtivos(conta.id);
  if (vinculos.length === 0) return null;
  if (vinculos.some((v) => eDeDono(v.profile_code))) return null;
  if (vinculos.some((v) => v.ligado !== 1)) return null;
  return { companyId: vinculos[0].company_id };
}

// ------------------------------------------------------------------ o código

function chave(): Buffer {
  return createHmac('sha256', loadEnv().DEVORA_JWT_SECRET)
    .update('devora:recuperacao-da-equipe:v1')
    .digest();
}

function hashDoCodigo(resetId: string, codigo: string): string {
  return createHmac('sha256', chave()).update(`${resetId}:${codigo}`).digest('hex');
}

function contar(sql: string, ...args: (string | number | null)[]): number {
  return Number((getConnection().prepare(sql).get(...args) as { n: number }).n);
}

/**
 * Pede o código. NUNCA diz se a conta existe: quem chama responde sempre a
 * mesma coisa (`MENSAGEM_DO_PEDIDO`).
 */
export function pedirCodigoDeRecuperacao(input: { identificador: string; ip: string | null }): void {
  ensureCoreSchema();
  const conta = acharConta(input.identificador);
  if (!conta) return;
  const destino = elegivel(conta);
  if (!destino) return;

  const agora = Date.now();
  const umaHoraAtras = new Date(agora - 60 * 60 * 1000).toISOString();
  if (
    contar(
      'SELECT COUNT(*) AS n FROM core_user_password_resets WHERE user_id = ? AND created_at > ?',
      conta.id,
      umaHoraAtras,
    ) >= MAX_PEDIDOS_POR_HORA
  ) {
    return;
  }
  if (
    input.ip
    && contar(
      'SELECT COUNT(*) AS n FROM core_user_password_resets WHERE requested_ip = ? AND created_at > ?',
      input.ip,
      new Date(agora - 15 * 60 * 1000).toISOString(),
    ) >= MAX_PEDIDOS_POR_ORIGEM
  ) {
    return;
  }

  const id = randomUUID();
  const codigo = String(randomInt(0, 100_000_000)).padStart(8, '0');
  const criadoEm = new Date(agora).toISOString();

  withTransaction(() => {
    const db = getConnection();
    // Pedido novo aposenta o anterior: só o último código vale.
    db.prepare(
      `UPDATE core_user_password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
    ).run(criadoEm, conta.id);
    db.prepare(
      `INSERT INTO core_user_password_resets
         (id, user_id, code_hash, attempts, expires_at, used_at, requested_ip, created_at)
       VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`,
    ).run(
      id,
      conta.id,
      hashDoCodigo(id, codigo),
      new Date(agora + CODIGO_VALE_MS).toISOString(),
      input.ip,
      criadoEm,
    );
  });

  // Depois da transação: o selo do cofre custa dezenas de milissegundos e não
  // segura o banco da loja; e a notificação nunca derruba o pedido (GAP-PRD-201).
  // Se não entrar, a resposta é a mesma e a pessoa pode pedir outro código.
  queueCodigoDaEquipeEmail({
    companyId: destino.companyId,
    toAddress: String(conta.email).trim(),
    nome: String(conta.display_name),
    login: String(conta.login),
    codigo,
    dedupeKey: `recuperacao-equipe:${id}`,
    expiraEm: new Date(agora + CODIGO_VALE_MS).toISOString(),
  });

  recordAudit({
    companyId: destino.companyId,
    userId: conta.id,
    action: 'auth.password_recovery.requested',
    entityType: 'user',
    entityId: conta.id,
    detail: { ip: input.ip },
  });
}

const INVALIDO = () =>
  new ApiError('API_RECOVERY_INVALID', 'Código inválido ou vencido. Peça um código novo.', 400);

/**
 * Troca a senha com o código. Toda recusa diz a mesma coisa: "inválido ou
 * vencido" — distinguir "conta não existe" de "código errado" seria outra
 * enumeração.
 */
export async function recuperarSenhaComCodigo(input: {
  identificador: string;
  codigo: string;
  novaSenha: string;
  ip: string | null;
}): Promise<void> {
  ensureCoreSchema();
  assertPassword(String(input.novaSenha ?? ''));
  const conta = acharConta(input.identificador);
  const codigo = String(input.codigo ?? '').trim();
  if (!conta || !/^\d{8}$/.test(codigo)) throw INVALIDO();

  const db = getConnection();
  const pedido = db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at
         FROM core_user_password_resets
        WHERE user_id = ? AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(conta.id) as { id: string; code_hash: string; attempts: number; expires_at: string } | undefined;
  if (!pedido) throw INVALIDO();

  const agora = new Date().toISOString();
  if (pedido.expires_at <= agora || pedido.attempts >= MAX_TENTATIVAS_POR_CODIGO) {
    db.prepare('UPDATE core_user_password_resets SET used_at = ? WHERE id = ?').run(agora, pedido.id);
    throw INVALIDO();
  }

  const esperado = Buffer.from(pedido.code_hash, 'hex');
  const recebido = Buffer.from(hashDoCodigo(pedido.id, codigo), 'hex');
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) {
    db.prepare('UPDATE core_user_password_resets SET attempts = attempts + 1 WHERE id = ?').run(
      pedido.id,
    );
    throw INVALIDO();
  }

  // A regra de hoje, não a do pedido: se o dono desligou a recuperação ou a
  // pessoa virou gestor nesse meio-tempo, o código deixa de valer.
  const destino = elegivel(conta);
  if (!destino) {
    db.prepare('UPDATE core_user_password_resets SET used_at = ? WHERE id = ?').run(agora, pedido.id);
    throw INVALIDO();
  }

  const hash = await hashPassword(input.novaSenha);
  registrarTrocaDaPropriaSenha(conta.id, hash);
  db.prepare('UPDATE core_user_password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(
    agora,
    conta.id,
  );
  clearLoginAttempts(conta.login);
  queueSenhaAlteradaEmail({
    companyId: destino.companyId,
    toAddress: conta.email,
    dedupeKey: `senha-equipe:${pedido.id}`,
  });
  recordAudit({
    companyId: destino.companyId,
    userId: conta.id,
    action: 'auth.password_recovered',
    entityType: 'user',
    entityId: conta.id,
    detail: { ip: input.ip },
  });
}
