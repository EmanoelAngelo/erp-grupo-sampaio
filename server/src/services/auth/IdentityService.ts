/**
 * Identidade: usuários, empresas e o vínculo entre eles.
 *
 * O escopo de tenant (`companyId`) NUNCA vem do cliente. Ele é sempre
 * derivado de `core_user_companies` no servidor — é isso que impede um
 * operador do Preço Justo de ler o estoque da Gringa trocando um campo no
 * corpo da requisição.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword, verifyPassword } from './PasswordService.js';
import { inserirMembroDaEquipe, type TeamMember } from '../core/TeamService.js';
import { chaveDoLogin, contaPeloLogin } from './ChaveDoLogin.js';

export interface CompanyRow {
  id: string;
  slug: string;
  legal_name: string;
  trade_name: string;
  cnpj: string | null;
  tax_regime: string;
  kind: string;
  active: number;
}

export interface UserRow {
  id: string;
  login: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  hash_algorithm: string;
  active: number;
  session_version: number;
}

export interface MembershipRow {
  company_id: string;
  profile_code: string;
  is_default: number;
  slug: string;
  trade_name: string;
  kind: string;
}

/**
 * A conta do login, sem distinguir maiúsculas nem espaços por fora — com o
 * acento contando (ver `ChaveDoLogin.ts`: 'preço justo' acha 'PREÇO JUSTO').
 */
export function findUserByLogin(login: string): UserRow | null {
  return contaPeloLogin<UserRow>(login);
}

export function findUserById(id: string): UserRow | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_users WHERE id = ?')
    .get(id) as UserRow | undefined;
  return row ?? null;
}

export function listMemberships(userId: string): MembershipRow[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT uc.company_id, uc.profile_code, uc.is_default,
              c.slug, c.trade_name, c.kind
         FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id
        WHERE uc.user_id = ? AND c.active = 1
        ORDER BY uc.is_default DESC, c.trade_name`,
    )
    .all(userId) as unknown as MembershipRow[];
}

/** Verifica no servidor se o usuário realmente pertence à empresa pedida. */
export function assertMembership(userId: string, companyId: string): MembershipRow | null {
  return listMemberships(userId).find((m) => m.company_id === companyId) ?? null;
}

export function updatePasswordHash(userId: string, hash: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `UPDATE core_users
          SET password_hash = ?, hash_algorithm = 'argon2id',
              must_rehash = 0, updated_at = ?
        WHERE id = ?`,
    )
    .run(hash, new Date().toISOString(), userId);
}

// ------------------------------------------------------------ lockout server-side

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/*
  DOIS TETOS, porque um só era arma.

  Até a rodada 34 o bloqueio contava falhas POR LOGIN, de qualquer origem:
  quem soubesse o login do gerente (está no cupom, no crachá, no e-mail)
  errava cinco vezes de um celular e o gerente ficava 15 minutos fora do
  próprio caixa — no sábado, na hora do movimento.

  - MAX_FAILED_ATTEMPTS conta POR PAR (login + origem). Tranca o aparelho que
    errou, para aquele login. O gerente, do caixa dele, continua entrando.
  - MAX_FAILED_PER_LOGIN conta por login, de qualquer origem, e é bem mais
    alto: existe para que trocar de endereço a cada quatro erros não vire
    caminho livre. Ninguém tenta 50 senhas em 15 minutos de boa-fé.

  Sem origem conhecida (ip nulo), vale só o teto por login — nunca o par, que
  seria "null" para todo mundo e voltaria a ser a arma.
*/
const MAX_FAILED_ATTEMPTS = 5;
const MAX_FAILED_PER_LOGIN = 50;

export function recordLoginAttempt(login: string, ip: string | null, succeeded: boolean): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      'INSERT INTO core_login_attempts (login, ip, succeeded, attempted_at) VALUES (?, ?, ?, ?)',
    )
    .run(chaveDoLogin(login), ip, succeeded ? 1 : 0, new Date().toISOString());
}

/**
 * Falhas consecutivas na janela recente — base do bloqueio temporário.
 *
 * Com `ip`, conta só as tentativas DAQUELA origem para o login; sem `ip`,
 * conta o login inteiro. A contagem para no primeiro acerto, porque um
 * acerto prova que quem está tentando sabe a senha.
 */
export function countRecentFailures(login: string, ip?: string | null): number {
  ensureCoreSchema();
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();
  const porOrigem = typeof ip === 'string' && ip.length > 0;
  const rows = getConnection()
    .prepare(
      `SELECT succeeded FROM core_login_attempts
        WHERE login = ? AND attempted_at >= ?${porOrigem ? ' AND ip = ?' : ''}
        ORDER BY attempted_at DESC`,
    )
    .all(...(porOrigem ? [chaveDoLogin(login), since, ip] : [chaveDoLogin(login), since])) as unknown as {
    succeeded: number;
  }[];
  let failures = 0;
  for (const row of rows) {
    if (row.succeeded) break;
    failures += 1;
  }
  return failures;
}

export function isLockedOut(login: string, ip?: string | null): boolean {
  if (countRecentFailures(login) >= MAX_FAILED_PER_LOGIN) return true;
  if (typeof ip === 'string' && ip.length > 0) {
    return countRecentFailures(login, ip) >= MAX_FAILED_ATTEMPTS;
  }
  return false;
}

export function clearLoginAttempts(login: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare('DELETE FROM core_login_attempts WHERE login = ?')
    .run(chaveDoLogin(login));
}

// ------------------------------------------------------------------ provisioning

export function upsertCompany(input: {
  slug: string;
  legalName: string;
  tradeName: string;
  cnpj?: string;
  kind?: string;
  taxRegime?: string;
  /** Id explícito — usado por provisionamento e testes; senão, gerado. */
  id?: string;
}): string {
  ensureCoreSchema();
  const db = getConnection();
  const existing = db
    .prepare('SELECT id FROM core_companies WHERE slug = ?')
    .get(input.slug) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE core_companies
          SET legal_name = ?, trade_name = ?, cnpj = ?, kind = ?, tax_regime = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.legalName,
      input.tradeName,
      input.cnpj ?? null,
      input.kind ?? 'retail',
      input.taxRegime ?? 'simples',
      now,
      existing.id,
    );
    return existing.id;
  }
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO core_companies
       (id, slug, legal_name, trade_name, cnpj, ie, tax_regime, kind, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.slug,
    input.legalName,
    input.tradeName,
    input.cnpj ?? null,
    input.taxRegime ?? 'simples',
    input.kind ?? 'retail',
    now,
    now,
  );
  return id;
}

/**
 * Provisionamento DIRETO de uma conta — ferramenta de teste e de instalação.
 *
 * Nenhuma tela e nenhum fluxo de produção a chamam: a gestão cadastra por
 * `TeamService` (login repetido é 409), e o bootstrap e o seed de
 * desenvolvimento só CRIAM contas que faltam (`db/bootstrap.ts`,
 * `db/seedDeDesenvolvimento.ts`). Esta função continua sobrescrevendo quem
 * já existe, porque é para isso que ela serve.
 *
 * Mas trocar a senha de uma conta sem derrubar as sessões dela anulava o
 * gesto — foi o que o `db:seed` fazia com a senha que o dono já tinha trocado.
 * Agora, quando a senha informada é DIFERENTE da que está gravada,
 * `session_version` sobe junto, igual ao reset da gestão e à troca pelo dono.
 * Com a mesma senha, o hash fica como está e nenhuma sessão cai.
 */
export async function upsertUser(input: {
  login: string;
  displayName: string;
  password: string;
  email?: string;
}): Promise<string> {
  ensureCoreSchema();
  const db = getConnection();
  const now = new Date().toISOString();
  const existing = findUserByLogin(input.login);
  if (existing) {
    const conferida = await verifyPassword(input.password, existing.password_hash);
    if (conferida.valid && !conferida.needsRehash) {
      db.prepare('UPDATE core_users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?').run(
        input.displayName,
        input.email ?? null,
        now,
        existing.id,
      );
      return existing.id;
    }
    db.prepare(
      `UPDATE core_users
          SET display_name = ?, email = ?, password_hash = ?,
              hash_algorithm = 'argon2id', must_rehash = 0,
              session_version = session_version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(input.displayName, input.email ?? null, await hashPassword(input.password), now, existing.id);
    return existing.id;
  }
  const hash = await hashPassword(input.password);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_users
       (id, login, display_name, email, password_hash, hash_algorithm,
        must_rehash, active, session_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'argon2id', 0, 1, 1, ?, ?)
     ON CONFLICT (login) DO UPDATE SET
       display_name = excluded.display_name,
       email = excluded.email,
       password_hash = excluded.password_hash,
       updated_at = excluded.updated_at`,
  ).run(id, input.login.trim(), input.displayName, input.email ?? null, hash, now, now);
  // O ON CONFLICT pode ter atualizado uma linha preexistente; devolve o id real.
  return findUserByLogin(input.login)?.id ?? id;
}

export function linkUserToCompany(
  userId: string,
  companyId: string,
  profileCode: string,
  isDefault = false,
): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, company_id)
       DO UPDATE SET profile_code = excluded.profile_code, is_default = excluded.is_default`,
    ).run(
      randomUUID(),
      userId,
      companyId,
      profileCode,
      isDefault ? 1 : 0,
      new Date().toISOString(),
    );
  });
}

/**
 * Vincula um técnico a uma oficina.
 *
 * Pertencer à empresa não basta: um técnico de celulares e um de mobilidade
 * podem estar na mesma empresa e ainda assim não devem se enxergar.
 */
export function linkUserToWorkshop(
  userId: string,
  workshopId: string,
  role = 'mecanico',
): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workshop_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .run(randomUUID(), workshopId, userId, role, new Date().toISOString());
}

/**
 * As empresas ativas do grupo.
 *
 * Ficou sem NENHUM leitor por várias rodadas — a rota que deveria consumi-la
 * (`GET /organizations/companies`) lia um `Map` em memória. Hoje o leitor
 * existe e é `GET /core/companies`.
 */
export function listCompanies(): CompanyRow[] {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT * FROM core_companies WHERE active = 1 ORDER BY trade_name')
    .all() as unknown as CompanyRow[];
}

/**
 * As empresas ativas EM QUE ESTE USUÁRIO TEM VÍNCULO — rodada 48.
 *
 * `listCompanies()` devolve o grupo inteiro, e era o que `GET /core/companies`
 * entregava a qualquer `admin_geral`/`gestor` — inclusive o de uma loja só,
 * que via as operações e os CNPJs das outras cinco. A listagem que a tela
 * consome passa a ser esta: o recorte é o vínculo, não o perfil.
 */
export function listCompaniesForUser(userId: string): CompanyRow[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT c.*
         FROM core_companies c
         JOIN core_user_companies uc ON uc.company_id = c.id AND uc.user_id = ?
        WHERE c.active = 1
        ORDER BY c.trade_name`,
    )
    .all(userId) as unknown as CompanyRow[];
}

/** Os perfis cujo vínculo é de GESTÃO — a mesma dupla de `RESPONDEM_POR_TUDO`. */
const PERFIS_DE_GESTAO = new Set(['admin_geral', 'gestor']);

/**
 * Este usuário tem vínculo de GESTÃO na empresa pedida?
 *
 * É a pergunta que decide travessia de empresa — auditoria de sistema e
 * integrações. Perfil sozinho não atravessa: `admin_geral` da Conceito é
 * administrador DA CONCEITO, e a Gringa só aparece para ele se houver uma
 * linha em `core_user_companies` dizendo isso.
 */
export function temVinculoDeGestao(userId: string, companyId: string): boolean {
  const membership = assertMembership(userId, companyId);
  return membership != null && PERFIS_DE_GESTAO.has(membership.profile_code);
}

/**
 * Este usuário responde pelo GRUPO — vínculo de gestão em TODAS as ativas?
 *
 * É a definição operacional que `listGroupAdminIds` já usava para os
 * administradores, agora como pergunta sobre uma pessoa: quem abre operação
 * nova no grupo é quem responde por todas as que existem. O ADMIN
 * (`admin_geral` nas 6) e o CARLOSGERENTE (`gestor` nas 6) respondem; o adm
 * de uma loja só, não — mesmo com o perfil idêntico.
 */
export function respondePeloGrupo(userId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COUNT(DISTINCT uc.company_id) AS gerencia,
              (SELECT COUNT(*) FROM core_companies WHERE active = 1) AS ativas
         FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id AND c.active = 1
        WHERE uc.user_id = ?
          AND uc.profile_code IN ('admin_geral', 'gestor')`,
    )
    .get(userId) as { gerencia: number; ativas: number } | undefined;
  return Boolean(row && row.ativas > 0 && row.gerencia === row.ativas);
}

// ==========================================================================
// A SÉTIMA OPERAÇÃO — criar empresa de verdade
// ==========================================================================

/**
 * Slugs que uma empresa nova NÃO pode ocupar.
 *
 * `grupo` e `grupo-sampaio` são a visão consolidada de leitura, e `auth.ts`
 * recusa login direto neles. Uma empresa criada com esse slug nasceria com
 * gerente, vínculos e nenhuma porta: ninguém jamais abriria sessão nela.
 */
/*
  E OS ENDEREÇOS DO PRÓPRIO SISTEMA. O slug da empresa é o endereço da loja
  dela (`/:storeSlug`), e o roteador das telas ranqueia caminho fixo acima do
  dinâmico: uma empresa chamada "PDV" ou "Loja" nasceria com /pdv ou /loja, e
  a página dela nunca abriria — quem digitasse o endereço cairia no PDV ou na
  vitrine do grupo. `api`, `uploads` e `assets` são da API e do pacote quando a
  API serve as telas (mesma origem). A lista é conferida contra o roteador em
  `tests/endereco-da-loja-nao-e-rota-do-sistema.test.ts`: rota nova de um
  segmento que não entrar aqui deixa o teste vermelho.
*/
export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set([
  'grupo',
  'grupo-sampaio',
  'sistema',
  'pdv',
  'login',
  'loja',
  'minha-conta',
  'redefinir-senha',
  'politica-de-privacidade',
  'termos-de-uso',
  'trocas-e-devolucoes',
  'equipamento',
  // A casa de quem ainda não tem página liberada (acesso granular da entrega).
  'sem-acesso',
  'api',
  'uploads',
  'assets',
]);

/** Nome comercial para slug: sem acento, sem maiúscula, sem espaço. */
function aoSlug(nome: string): string {
  return (
    nome
      .normalize('NFD')
      // Os diacríticos que o NFD separou. Escrito em escape de propósito: em
      // literal, é um caractere invisível que nenhum revisor consegue conferir.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'empresa'
  );
}

/**
 * Um slug livre na tabela pedida, derivado do nome.
 *
 * `core_companies.slug` e `core_workshops.slug` são UNIQUE — e o da oficina é
 * UNIQUE GLOBAL, não por empresa. Duas empresas chamadas "Oficina do Zé"
 * gerariam a mesma oficina-slug e a segunda estouraria a constraint no meio da
 * transação: a criação inteira reverteria e a pessoa veria um erro de banco
 * cru sobre uma colisão que o servidor podia resolver sozinho.
 *
 * O sufixo é numérico e começa em 2 porque é assim que se lê: "oficina-do-ze"
 * e "oficina-do-ze-2" são a primeira e a segunda.
 *
 * Chamada DENTRO da transação de propósito. `BEGIN IMMEDIATE` já segurou o
 * write lock, então entre o "está livre?" e o `INSERT` não cabe outro escritor.
 */
function slugLivre(tabela: 'core_companies' | 'core_workshops', base: string): string {
  const db = getConnection();
  const inicial = aoSlug(base);
  for (let tentativa = 1; tentativa < 100; tentativa += 1) {
    const candidato = tentativa === 1 ? inicial : `${inicial.slice(0, 44)}-${tentativa}`;
    if (tabela === 'core_companies' && SLUGS_RESERVADOS.has(candidato)) continue;
    const existe = db
      .prepare(`SELECT 1 AS ok FROM ${tabela} WHERE slug = ?`)
      .get(candidato) as { ok?: number } | undefined;
    if (!existe?.ok) return candidato;
  }
  throw new ApiError(
    'CORE_COMPANY_SLUG_EXHAUSTED',
    'Não foi possível derivar um endereço único a partir deste nome. Escolha outro nome fantasia.',
    409,
  );
}

/**
 * Quem é "administrador do grupo" — e por que a ORDEM desta consulta importa.
 *
 * A definição operacional é: `admin_geral` em TODAS as empresas ativas. É o
 * que dá sentido ao nome — quem administra o grupo, e não uma operação.
 *
 * E é justamente por ser "todas" que esta lista TEM de ser derivada ANTES de a
 * empresa nova existir. Derivada depois, o `COUNT` do denominador já inclui a
 * empresa recém-criada, na qual ninguém está vinculado ainda — e o `HAVING`
 * não bate para NINGUÉM. A lista voltaria vazia, todo administrador do grupo
 * perderia o título no instante em que a sétima operação nascesse, e a empresa
 * nova ficaria acessível só para o gerente dela.
 *
 * O defeito não daria erro nenhum: ele apareceria como uma lista vazia, que é
 * exatamente o que um grupo sem administradores também parece.
 */
export function listGroupAdminIds(): string[] {
  return idsComPerfilEmTodasAtivas('admin_geral');
}

/**
 * Quem é "gestor do grupo": `gestor` em TODAS as empresas ativas.
 *
 * Mesma definição, mesmo motivo de ordem. Sem esta lista, a empresa nova
 * nascia só com os administradores dentro — e o CARLOSGERENTE perdia o título
 * de gestor do grupo no instante em que a sétima operação existisse, sem erro
 * nenhum: só uma loja que ele não alcança.
 */
export function listGroupManagerIds(): string[] {
  return idsComPerfilEmTodasAtivas('gestor');
}

function idsComPerfilEmTodasAtivas(profile: 'admin_geral' | 'gestor'): string[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT uc.user_id AS id
         FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id AND c.active = 1
         JOIN core_users u ON u.id = uc.user_id AND u.active = 1
        WHERE uc.profile_code = ?
        GROUP BY uc.user_id
       HAVING COUNT(DISTINCT uc.company_id) =
              (SELECT COUNT(*) FROM core_companies WHERE active = 1)`,
    )
    .all(profile) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export interface NovaEmpresaInput {
  /** Razão social — o nome do contrato social. */
  legalName: string;
  /** Nome fantasia. Ausente, repete a razão social. */
  tradeName?: string;
  cnpj?: string | null;
  /** `workshop` faz nascer a primeira bancada junto. */
  kind: 'retail' | 'workshop';
  /**
   * Só vale quando `kind` é `workshop`. Ausente = mobilidade.
   *
   * Ver o comentário na criação da bancada: o tipo decide se o equipamento
   * ganha plaquinha com QR, e nenhuma rota corrige isso depois.
   */
  workshopKind?: 'mobility' | 'phones';
  taxRegime?: string;
  /** Quem apertou o botão. Vem de `req.auth.sub`, NUNCA do corpo. */
  criadorUserId: string;
  /**
   * Os perfis de quem apertou o botão, do TOKEN. O primeiro gerente passa pela
   * mesma régua de `HierarquiaDePerfis` que o cadastro da tela — e caminho que
   * não informa quem cria não entrega perfil nenhum (falha fechada).
   */
  perfisDoCriador: readonly string[];
  primeiroGerente: {
    login: string;
    displayName: string;
    email?: string | null;
    /** Já derivado FORA da transação — ver `inserirMembroDaEquipe`. */
    passwordHash: string;
    profileCode: string;
  };
}

export interface EmpresaCriada {
  company: CompanyRow;
  /** A primeira bancada, quando a operação é oficina. */
  workshop: { id: string; slug: string; name: string } | null;
  gerente: TeamMember;
  /** Ids dos administradores do grupo que ganharam vínculo na empresa nova. */
  adminsVinculados: string[];
  /** Ids dos gestores do grupo que ganharam vínculo `gestor` na empresa nova. */
  gestoresVinculados: string[];
}

/**
 * ==========================================================================
 * A EMPRESA NASCE INTEIRA OU NÃO NASCE
 * ==========================================================================
 *
 * Uma empresa sem gerente é uma porta trancada com a chave dentro: ela aparece
 * na lista, ninguém consegue entrar, e desfazer pede acesso ao banco. Por isso
 * tudo aqui está numa transação só — a empresa, o vínculo de quem criou, os
 * vínculos dos demais administradores do grupo, a primeira bancada e o
 * primeiro gerente.
 *
 * ## A ORDEM NÃO É ARBITRÁRIA. Cada passo depende do anterior:
 *
 *  1. DERIVAR os administradores do grupo. Antes do `INSERT` da empresa, pelo
 *     motivo explicado em `listGroupAdminIds`.
 *  2. Reservar o slug da empresa (e o da oficina, quando houver).
 *  3. INSERT da empresa.
 *  4. Vincular quem criou, e depois os demais administradores.
 *  5. A BANCADA, quando `kind === 'workshop'` — e ela vem ANTES do gerente,
 *     porque `inserirMembroDaEquipe` recusa `gerente_oficina` (e `mecanico`, e
 *     `operador_caixa_oficina`) sem ao menos uma oficina vinculada. Criar o
 *     gerente primeiro estouraria `CORE_WORKSHOP_LINK_REQUIRED` numa operação
 *     que o usuário pediu corretamente.
 *  6. O PRIMEIRO GERENTE, com a bancada já em mãos.
 *
 * ## O HASH JÁ VEM PRONTO
 *
 * `withTransaction` é síncrona. Derivar Argon2id é assíncrono e caro. Quem
 * chama esta função deriva o hash antes e passa o resultado — é o mesmo
 * arranjo de `createTeamMember`, e é o que permite ao gerente nascer DENTRO da
 * transação em vez de depois dela.
 */
export function createCompanyWithFounders(input: NovaEmpresaInput): EmpresaCriada {
  ensureCoreSchema();

  const legalName = input.legalName.trim();
  const tradeName = (input.tradeName ?? '').trim() || legalName;
  if (!legalName) {
    throw new ApiError('CORE_COMPANY_INCOMPLETE', 'Informe a razão social.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    const agora = new Date().toISOString();

    // (1) ANTES do INSERT. Ver `listGroupAdminIds` — e vale igual para os
    // gestores: derivado depois, o HAVING não bate para ninguém e o grupo
    // inteiro perde o título em silêncio.
    const adminsDoGrupo = listGroupAdminIds();
    const gestoresDoGrupo = listGroupManagerIds();

    // (2)
    const slug = slugLivre('core_companies', tradeName);
    const companyId = randomUUID();

    // (3)
    db.prepare(
      `INSERT INTO core_companies
         (id, slug, legal_name, trade_name, cnpj, ie, tax_regime, kind, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
    ).run(
      companyId,
      slug,
      legalName,
      tradeName,
      input.cnpj?.replace(/\D/g, '') || null,
      input.taxRegime ?? 'simples',
      input.kind,
      agora,
      agora,
    );

    // (4) Quem criou entra primeiro — com o perfil que o fez responder pelo
    // grupo, e não `admin_geral` fixo. O gestor do grupo gravado como
    // `admin_geral` virava perfil MISTO e caía das DUAS listas de derivação:
    // a criação seguinte, feita por outra pessoa, não o arrastava, e ele
    // perdia o grupo em silêncio — o mesmo defeito silencioso que o cabeçalho
    // de `listGroupAdminIds` descreve, só que plantado pela própria criação.
    const vinculo = db.prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (user_id, company_id) DO NOTHING`,
    );
    const perfilDoCriador = gestoresDoGrupo.includes(input.criadorUserId)
      ? 'gestor'
      : 'admin_geral';
    vinculo.run(randomUUID(), input.criadorUserId, companyId, perfilDoCriador, agora);

    const adminsVinculados: string[] = [];
    for (const adminId of adminsDoGrupo) {
      if (adminId === input.criadorUserId) continue;
      vinculo.run(randomUUID(), adminId, companyId, 'admin_geral', agora);
      adminsVinculados.push(adminId);
    }

    // Os gestores do grupo entram como `gestor` — o perfil que eles têm em
    // todas as outras. O criador já entrou acima, com o perfil certo.
    const gestoresVinculados: string[] = [];
    for (const gestorId of gestoresDoGrupo) {
      if (gestorId === input.criadorUserId) continue;
      vinculo.run(randomUUID(), gestorId, companyId, 'gestor', agora);
      gestoresVinculados.push(gestorId);
    }

    // (5) A bancada antes do gerente — ver o cabeçalho.
    let workshop: { id: string; slug: string; name: string } | null = null;
    if (input.kind === 'workshop') {
      const workshopSlug = slugLivre('core_workshops', `oficina ${tradeName}`);
      const workshopId = randomUUID();
      const workshopName = `Oficina ${tradeName}`;
      /*
        O TIPO DA BANCADA NÃO É RÓTULO, e por isso ele é escolhido e não fixo.

        `capabilitiesFor` dá `equipmentTags: true` para mobilidade e `false`
        para celulares — a decisão das rodadas 18 e 20: plaquinha com QR só
        onde o aparelho FICA, porque moto passa dias no pátio e celular entra e
        sai no mesmo dia. Nascer sempre `mobility` daria à sétima operação a
        capacidade errada, e nenhuma rota corrige bancada depois.

        Tipo desconhecido cai em `mobility` porque é o conjunto mais largo, e
        `capabilitiesFor` já trata o desconhecido do lado dele fechando tudo —
        um valor inventado aqui viraria bancada sem peça nem plaquinha.
      */
      const workshopKind = input.workshopKind === 'phones' ? 'phones' : 'mobility';
      db.prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).run(workshopId, companyId, workshopSlug, workshopName, workshopKind, agora);
      workshop = { id: workshopId, slug: workshopSlug, name: workshopName };
    }

    // (6)
    const gerente = inserirMembroDaEquipe({
      companyId,
      login: input.primeiroGerente.login,
      displayName: input.primeiroGerente.displayName,
      email: input.primeiroGerente.email ?? null,
      profileCode: input.primeiroGerente.profileCode,
      perfisDeQuemCria: [...input.perfisDoCriador],
      passwordHash: input.primeiroGerente.passwordHash,
      workshopIds: workshop ? [workshop.id] : [],
    });

    const company = db
      .prepare('SELECT * FROM core_companies WHERE id = ?')
      .get(companyId) as unknown as CompanyRow;

    return { company, workshop, gerente, adminsVinculados, gestoresVinculados };
  });
}
