/**
 * Gestão de equipe: técnicos, mecânicos e demais usuários da operação.
 *
 * NÃO EXISTE "usuário mecânico" separado. O técnico é um `core_users` com um
 * vínculo de empresa (`core_user_companies`, que dá o perfil) e, quando atende
 * oficina, um vínculo de oficina (`core_workshop_members`). Uma segunda tabela
 * de pessoas seria uma segunda verdade sobre quem pode entrar — e as duas
 * divergiriam no primeiro desligamento feito só de um lado.
 *
 * POR QUE NÃO REUSAR `upsertUser`
 *
 * Aquela função é de provisionamento direto (teste e instalação — o seed, desde
 * o GAP-PRD-040, nem ela usa mais): se o login já existe, ela sobrescreve a
 * senha sem perguntar. Como fluxo de gestor isso é uma porta dos fundos — bastaria
 * digitar o login de outra pessoa na tela de cadastro para trocar a senha
 * dela. Aqui, login repetido é erro (409), e trocar senha é uma operação
 * separada e auditada.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword } from '../auth/PasswordService.js';
import { contaPeloLogin } from '../auth/ChaveDoLogin.js';
import {
  assertPodeAtribuir,
  assertPodeMexerNaConta,
  assertPodeMexerNaOperacao,
} from './HierarquiaDePerfis.js';

/**
 * Perfis que a tela de equipe pode atribuir.
 *
 * `admin_geral` NÃO está na lista, e é de propósito: quem administra a equipe
 * não deve poder fabricar um administrador global do sistema pela tela de
 * cadastro de mecânico. Essa promoção continua sendo operação de instalação.
 */
/**
 * O caixa é `_loja` ou `_oficina`, nunca o genérico.
 *
 * A lista oferecia `operador_caixa` — código que o seed não cria e que ninguém
 * tem: zero vínculos no banco. Quem cadastrasse um caixa pela tela nasceria com
 * um perfil diferente do dos cinco caixas que já trabalham, e as guardas de
 * rota tratam os dois de forma diferente em alguns lugares.
 *
 * O genérico continua ACEITO nas guardas (ver `CAIXAS` em `routes/v1/core.ts`),
 * porque instalação antiga pode tê-lo. O que não se faz mais é criar um novo.
 */
/**
 * O CONTADOR é o nono, e o primeiro que não trabalha aqui dentro.
 *
 * Os oito primeiros são cargos da operação: quem abre a loja, quem monta o
 * aparelho, quem confere a mercadoria. O contador é escritório contratado — ele
 * recebe o mês, escritura e vai embora.
 *
 * ## Por que ele é um perfil de `core_users`, e não um portal com token próprio
 *
 * Um portal seria a TERCEIRA verdade sobre quem entra no sistema, depois de
 * `core_users` e `core_customer_accounts` — e o cabeçalho de
 * `CustomerPortalService` já escreveu, com o preço pago, por que as duas
 * primeiras não podem se misturar. Uma terceira significaria repetir Argon2id,
 * refresh com rotação, bloqueio por tentativa, vínculo por empresa e
 * desligamento; e repetir cinco mecanismos de segurança é escolher qual deles
 * vai ficar para trás. Perfil novo herda os cinco no dia em que nasce.
 *
 * O que o mantém estreito não é a tabela: é o guarda. `contador` está no
 * ambiente `contabilidade` e em nenhum outro (`routes/v1/core.ts`), então toda
 * rota que declara alcance por ambiente já o recusa; e das 310 rotas do núcleo
 * ele alcança três, nomeado uma a uma.
 */
export const ASSIGNABLE_PROFILES = [
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'mecanico',
  'atendente',
  'estoquista',
  'operador_caixa_loja',
  'operador_caixa_oficina',
  'contador',
] as const;

export type AssignableProfile = (typeof ASSIGNABLE_PROFILES)[number];

/** Perfis que atendem oficina — para estes o vínculo de oficina é exigido. */
const WORKSHOP_PROFILES = new Set(['mecanico', 'gerente_oficina', 'operador_caixa_oficina']);

/** Tamanho mínimo da senha provisória, alinhado ao resto da autenticação. */
const MIN_PASSWORD = 8;

export interface TeamMember {
  id: string;
  login: string;
  displayName: string;
  email: string | null;
  profileCode: string;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  workshops: { id: string; name: string; slug: string; role: string }[];
}

/**
 * Nunca devolve hash, algoritmo nem versão de sessão.
 *
 * E as oficinas listadas são as DESTA empresa. A consulta pedia todas as
 * bancadas do usuário, sem dizer de qual operação: o gerente da Preço Justo,
 * lendo a própria equipe, via o vínculo do colega com a bancada da Oficina —
 * que é outra empresa do grupo, com outro CNPJ.
 */
function toMember(row: Record<string, unknown>, companyId: string): TeamMember {
  const id = String(row.id);
  const workshops = getConnection()
    .prepare(
      `SELECT w.id, w.name, w.slug, m.role
         FROM core_workshop_members m
         JOIN core_workshops w ON w.id = m.workshop_id AND w.company_id = ?
        WHERE m.user_id = ?
        ORDER BY w.name`,
    )
    .all(companyId, id) as unknown as { id: string; name: string; slug: string; role: string }[];

  return {
    id,
    login: String(row.login),
    displayName: String(row.display_name),
    email: (row.email as string | null) ?? null,
    profileCode: String(row.profile_code),
    active: row.active === 1,
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: (row.last_login_at as string | null) ?? null,
    createdAt: String(row.created_at),
    workshops,
  };
}

/**
 * Equipe de uma operação.
 *
 * `workshopId` restringe aos vinculados àquela oficina — é o que impede a
 * lista de mecânicos da mobilidade de mostrar os técnicos de celulares.
 */
export function listTeam(
  companyId: string,
  options: { workshopId?: string; search?: string; onlyWorkshopStaff?: boolean } = {},
): TeamMember[] {
  ensureCoreSchema();

  const params: unknown[] = [companyId];
  let sql = `SELECT u.*, uc.profile_code
               FROM core_users u
               JOIN core_user_companies uc ON uc.user_id = u.id
              WHERE uc.company_id = ?`;

  if (options.workshopId) {
    sql += ` AND EXISTS (SELECT 1 FROM core_workshop_members m
                          WHERE m.user_id = u.id AND m.workshop_id = ?)`;
    params.push(options.workshopId);
  }
  if (options.onlyWorkshopStaff) {
    sql += ` AND uc.profile_code IN (${[...WORKSHOP_PROFILES].map(() => '?').join(', ')})`;
    params.push(...WORKSHOP_PROFILES);
  }
  if (options.search) {
    sql += ' AND (u.display_name LIKE ? OR u.login LIKE ?)';
    const like = `%${options.search}%`;
    params.push(like, like);
  }

  sql += ' ORDER BY u.active DESC, u.display_name';

  const rows = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map((row) => toMember(row, companyId));
}

export function getTeamMember(companyId: string, userId: string): TeamMember | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT u.*, uc.profile_code
         FROM core_users u
         JOIN core_user_companies uc ON uc.user_id = u.id
        WHERE uc.company_id = ? AND u.id = ?`,
    )
    .get(companyId, userId) as Record<string, unknown> | undefined;
  return row ? toMember(row, companyId) : null;
}

/**
 * Confirma que o usuário pertence à operação de quem está mexendo.
 *
 * Sem isto, saber o id de alguém de outra empresa bastaria para desativá-lo:
 * a rota valida o token, mas o token não diz nada sobre o ALVO da operação.
 */
/** O perfil que o alvo tem NESTA operação. Vazio quando o vínculo sumiu. */
function perfilDoAlvo(companyId: string, userId: string): string {
  const row = getConnection()
    .prepare("SELECT profile_code FROM core_user_companies WHERE company_id = ? AND user_id = ?")
    .get(companyId, userId) as { profile_code?: string } | undefined;
  return String(row?.profile_code ?? "");
}

function assertSameCompany(companyId: string, userId: string): void {
  const link = getConnection()
    .prepare('SELECT 1 AS ok FROM core_user_companies WHERE company_id = ? AND user_id = ?')
    .get(companyId, userId) as { ok?: number } | undefined;
  if (!link?.ok) {
    throw new ApiError('CORE_USER_NOT_IN_COMPANY', 'Usuário não pertence a esta operação.', 404);
  }
}

/**
 * Perfis que só quem responde pelo grupo atribui — e contas em que só ele mexe.
 *
 * A régua MUDOU DE LUGAR com o GAP-PRD-010 e mora em `HierarquiaDePerfis.ts`.
 * Aqui havia duas listas soltas (`PERFIS_DE_DONO` para a atribuição e
 * `assertPodeMexerNoAlvo` para o alvo), e as duas esqueceram `admin_geral`:
 * um gerente de loja trocava a senha do administrador do sistema e entrava
 * como ele. E o PATCH não chamava nenhuma das duas — rebaixava gestor e
 * `admin_geral` com 200.
 *
 * O que continua valendo, com as palavras de antes, porque o motivo não mudou:
 *
 *   - `gestor` alcança TUDO (`requireProfile` o deixa passar em toda rota), e
 *     fundar operação virou escalada com prêmio: o gerente criava um gestor,
 *     entrava com ele e abria empresas no grupo. Ninguém entrega um crachá que
 *     não tem.
 *   - `contador` não escala nada, e mesmo assim é de dono: dar login DE DENTRO
 *     a uma pessoa DE FORA é escolher a quem o grupo entrega a contabilidade —
 *     todas as notas, todos os XML de compra, o resultado do período. É pouco
 *     de valor alto e irreversível: o pacote sai e não volta.
 *   - `admin_geral` não é atribuível pela tela (não está em
 *     `ASSIGNABLE_PROFILES`), e por isso ninguém o tinha posto na lista de
 *     dono. Mas o alvo de um reset de senha não precisa ser atribuído — só
 *     precisa existir.
 */
function assertProfile(profileCode: string, perfisDeQuemCria: string[] = []): AssignableProfile {
  if (!(ASSIGNABLE_PROFILES as readonly string[]).includes(profileCode)) {
    throw new ApiError('CORE_PROFILE_INVALID', 'Perfil inválido para atribuição.', 400);
  }
  assertPodeAtribuir(profileCode, perfisDeQuemCria);
  return profileCode as AssignableProfile;
}

/**
 * A regra da senha provisória, EXPORTADA.
 *
 * Quem já tem só o hash em mãos não consegue mais medir o comprimento — e
 * `inserirMembroDaEquipe` (abaixo) recebe hash, não senha. Se a regra ficasse
 * privada, o criador de empresa aceitaria "123" como senha do primeiro
 * gerente, e a divergência entre os dois caminhos de cadastro só apareceria no
 * dia em que alguém tentasse invadir pelo mais fraco.
 */
export function assertPassword(password: string): void {
  if (password.trim().length < MIN_PASSWORD) {
    throw new ApiError(
      'CORE_PASSWORD_WEAK',
      `A senha provisória precisa ter ao menos ${MIN_PASSWORD} caracteres.`,
      400,
    );
  }
}

/**
 * E-mail livre — a MESMA regra do login, aplicada ao outro identificador.
 *
 * Só o login tinha dedupe (CORE_LOGIN_TAKEN, caso-insensível); o e-mail
 * entrava sem conferência nenhuma, e dois crachás acabavam com o mesmo
 * endereço. Hoje o campo é informativo — nada loga por e-mail —, mas é
 * exatamente a duplicata que explode no dia em que notificação ou recuperação
 * de senha passar a usá-lo: qual das duas contas recebe o link?
 *
 * COLLATE NOCASE porque e-mail é identidade sem caixa, como o login. E o
 * `exceptUserId` existe por causa do PATCH mais comum da tela: mudou o nome, o
 * e-mail veio junto no corpo, intacto — resalvar o próprio endereço não pode
 * ser recusado.
 */
function assertEmailLivre(email: string | null | undefined, exceptUserId?: string): void {
  const limpo = email?.trim();
  if (!limpo) return;
  const row = getConnection()
    .prepare(
      `SELECT id FROM core_users WHERE email = ? COLLATE NOCASE${exceptUserId ? ' AND id <> ?' : ''}`,
    )
    .get(...((exceptUserId ? [limpo, exceptUserId] : [limpo]) as never[])) as
    | { id?: string }
    | undefined;
  if (row?.id) {
    throw new ApiError('CORE_EMAIL_TAKEN', 'Já existe um usuário com este e-mail.', 409);
  }
}

/**
 * Confirma que as oficinas pedidas são desta empresa.
 *
 * Vincular alguém a uma oficina de outro tenant furaria o isolamento na raiz —
 * e a checagem de leitura (`resolveWorkshop`) passaria a deixar entrar, porque
 * para ela o vínculo é a autoridade.
 */
function assertWorkshopsOfCompany(companyId: string, workshopIds: string[]): void {
  for (const id of workshopIds) {
    const row = getConnection()
      .prepare('SELECT 1 AS ok FROM core_workshops WHERE id = ? AND company_id = ?')
      .get(id, companyId) as { ok?: number } | undefined;
    if (!row?.ok) {
      throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Oficina não pertence a esta operação.', 403);
    }
  }
}

/**
 * Troca as bancadas da pessoa NESTA operação — só nesta.
 *
 * O DELETE apagava todas as bancadas do usuário, de qualquer empresa: o
 * gerente do Preço Justo, reeditando o técnico que também atende a Oficina,
 * tirava dele a bancada de lá sem saber que ela existia (GAP-PRD-152 — a conta
 * é uma, as operações são várias). As bancadas das outras operações não são
 * assunto de quem edita esta.
 */
function replaceWorkshopLinks(
  companyId: string,
  userId: string,
  workshopIds: string[],
  role: string,
): void {
  const db = getConnection();
  db.prepare(
    `DELETE FROM core_workshop_members
      WHERE user_id = ?
        AND workshop_id IN (SELECT id FROM core_workshops WHERE company_id = ?)`,
  ).run(userId, companyId);
  for (const workshopId of workshopIds) {
    db.prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), workshopId, userId, role, new Date().toISOString());
  }
}

/**
 * ============================================================================
 * O MEMBRO NASCE EM DUAS PARTES, E A DIVISÃO É O CONSERTO
 * ============================================================================
 *
 * `createTeamMember` é `async` porque `hashPassword` é `async`, e
 * `withTransaction` (db/sqlite.ts) é SÍNCRONA — ela abre `BEGIN IMMEDIATE`,
 * chama `fn()` e faz `COMMIT` na mesma volta do event loop. Uma função `async`
 * passada para ela devolve uma Promise IMEDIATAMENTE, o `COMMIT` acontece
 * antes de qualquer `await` interno terminar, e todo trabalho depois do
 * primeiro `await` fica FORA da transação.
 *
 * Isso não é teoria: a criação de empresa precisa gravar, tudo ou nada, a
 * empresa, os vínculos dos administradores, a primeira oficina e o primeiro
 * gerente. Chamando `createTeamMember` de dentro daquela transação, o gerente
 * cairia fora dela — e uma empresa sem gerente é uma porta trancada com a
 * chave dentro: ninguém consegue entrar para consertar.
 *
 * A divisão desfaz o problema em vez de contorná-lo:
 *
 *   - `inserirMembroDaEquipe` é SÍNCRONA e não abre transação nenhuma. Recebe
 *     o hash JÁ DERIVADO. Pode ser chamada de dentro de qualquer transação em
 *     curso e participa dela — inclusive do rollback.
 *   - `createTeamMember` continua `async` e é o caminho da tela de equipe:
 *     valida a senha em claro, deriva o hash FORA da transação (Argon2id leva
 *     centenas de milissegundos, e segurar o write lock esse tempo todo
 *     travaria o balcão) e chama a síncrona lá dentro.
 *
 * Quem tem o hash não consegue validar o comprimento da senha, então a
 * validação vive em `assertPassword` e é responsabilidade de quem ainda tem o
 * texto. Ambos os chamadores a chamam.
 */
export function inserirMembroDaEquipe(input: {
  companyId: string;
  login: string;
  displayName: string;
  email?: string | null;
  profileCode: string;
  /**
   * Os perfis de QUEM está criando — o crachá não pode ser maior que o dele.
   *
   * Ausente não entrega perfil NENHUM, e é o lado seguro: caminho que não
   * informa quem chama não tem capacidade para medir (`HierarquiaDePerfis`).
   */
  perfisDeQuemCria?: string[];
  /** Já derivado — ver o cabeçalho acima. */
  passwordHash: string;
  workshopIds?: string[];
}): TeamMember {
  ensureCoreSchema();

  const login = input.login.trim();
  const displayName = input.displayName.trim();
  if (!login || !displayName) {
    throw new ApiError('CORE_USER_INCOMPLETE', 'Informe nome e login.', 400);
  }

  const profile = assertProfile(input.profileCode, input.perfisDeQuemCria ?? []);

  const workshopIds = input.workshopIds ?? [];
  assertWorkshopsOfCompany(input.companyId, workshopIds);

  // Quem atende oficina sem vínculo entraria e não veria OS nenhuma — a tela
  // ficaria vazia sem explicar por quê.
  if (WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0) {
    throw new ApiError(
      'CORE_WORKSHOP_LINK_REQUIRED',
      'Perfil de oficina exige ao menos uma oficina vinculada.',
      400,
    );
  }

  const db = getConnection();

  // Login ocupado pela MESMA chave da entrada: 'preço justo' ocupa 'PREÇO JUSTO'.
  const existing = contaPeloLogin<{ id: string; login: string }>(login);
  if (existing?.id) {
    throw new ApiError('CORE_LOGIN_TAKEN', 'Já existe um usuário com este login.', 409);
  }

  // O outro identificador passa pela mesma porta — ver `assertEmailLivre`.
  assertEmailLivre(input.email);

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_users
       (id, login, display_name, email, password_hash, hash_algorithm, must_rehash,
        must_change_password, active, session_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'argon2id', 0, 1, 1, 1, ?, ?)`,
  ).run(id, login, displayName, input.email?.trim() || null, input.passwordHash, now, now);

  db.prepare(
    `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(randomUUID(), id, input.companyId, profile, now);

  replaceWorkshopLinks(input.companyId, id, workshopIds, profile === 'mecanico' ? 'mecanico' : profile);

  return getTeamMember(input.companyId, id)!;
}

export async function createTeamMember(input: {
  companyId: string;
  login: string;
  displayName: string;
  email?: string | null;
  profileCode: string;
  /**
   * Os perfis de QUEM está criando — o crachá não pode ser maior que o dele.
   *
   * Ausente não entrega perfil NENHUM, e é o lado seguro: caminho que não
   * informa quem chama não tem capacidade para medir (`HierarquiaDePerfis`).
   */
  perfisDeQuemCria?: string[];
  password: string;
  workshopIds?: string[];
}): Promise<TeamMember> {
  /*
    As demais validações (login vazio, perfil inválido, oficina de outro
    tenant) mudaram de lugar: agora vivem em `inserirMembroDaEquipe`, e por
    isso rodam DEPOIS do hash em vez de antes. O preço é derivar Argon2id à
    toa numa requisição que ia falhar de qualquer jeito — algumas centenas de
    milissegundos, num caminho que uma pessoa percorre poucas vezes por ano.

    O que se compra com isso é que os DOIS caminhos de cadastro — esta tela e
    a criação de empresa — passam pelas mesmas checagens, na mesma função.
    Deixá-las aqui em cima significaria que o gerente nascido junto com a
    empresa não seria validado por nenhuma delas.
  */
  ensureCoreSchema();
  assertPassword(input.password);

  // O hash fica FORA da transação: derivar Argon2id leva centenas de
  // milissegundos e seguraria o banco travado por todo esse tempo.
  const passwordHash = await hashPassword(input.password);

  return withTransaction(() => inserirMembroDaEquipe({ ...input, passwordHash }));
}

export function updateTeamMember(input: {
  companyId: string;
  userId: string;
  /** Quem edita — o alvo que é a própria pessoa não tem "outras operações" alheias. */
  actorId: string;
  displayName?: string;
  email?: string | null;
  profileCode?: string;
  /**
   * Os perfis de quem está editando — a mesma trava da criação.
   *
   * Promover alguém já cadastrado é o caminho mais curto da escalada, e seria
   * o que sobraria se só a criação fosse fechada: bastava cadastrar um
   * `atendente` e, no clique seguinte, torná-lo `gestor`.
   */
  perfisDeQuemCria?: string[];
  workshopIds?: string[];
}): TeamMember {
  ensureCoreSchema();
  assertSameCompany(input.companyId, input.userId);
  const perfisDeQuemAge = input.perfisDeQuemCria ?? [];

  /*
    O ALVO É CONFERIDO ANTES DE QUALQUER CAMPO (GAP-PRD-010).

    Esta função chamava `assertProfile` só para o perfil NOVO e nunca olhava o
    perfil ATUAL de quem estava sendo editado. Medido: o gerente de loja
    rebaixava o gestor a estoquista e o `admin_geral` a atendente, com 200, e
    trocava nome e e-mail do gestor. Agora quem não alcança o perfil que o alvo
    tem aqui não mexe em nada dele — nem nas bancadas.
  */
  const atual = getTeamMember(input.companyId, input.userId)!;
  assertPodeMexerNaOperacao(atual.profileCode, perfisDeQuemAge);

  /*
    Nome e e-mail são da PESSOA, não do vínculo: valem em todas as operações
    dela. Mexer neles pede alcance sobre todas (ver `assertPodeMexerNaConta`).

    Mas só quando MUDAM. A tela manda nome e e-mail em todo "Salvar", intactos
    — o gerente que ajusta a bancada de um técnico que também atende outra
    operação não pode tomar 403 por um nome que ele não tocou.
  */
  const nomeNovo = input.displayName === undefined ? undefined : input.displayName.trim() || atual.displayName;
  const emailNovo = input.email === undefined ? undefined : input.email?.trim() || null;
  const mudaNome = nomeNovo !== undefined && nomeNovo !== atual.displayName;
  const mudaEmail = emailNovo !== undefined && emailNovo !== atual.email;
  if (mudaNome || mudaEmail) {
    assertPodeMexerNaConta({
      companyId: input.companyId,
      alvoId: input.userId,
      actorId: input.actorId,
      perfisDeQuemAge,
    });
  }

  return withTransaction(() => {
    const db = getConnection();
    const now = new Date().toISOString();

    if (mudaNome || mudaEmail) {
      // O PATCH não pode roubar o e-mail de outro membro — mesma recusa da
      // criação, com a exceção do próprio dono (resalvar o que já é dele).
      if (mudaEmail) {
        assertEmailLivre(emailNovo, input.userId);
      }
      db.prepare('UPDATE core_users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?').run(
        nomeNovo ?? atual.displayName,
        emailNovo === undefined ? atual.email : emailNovo,
        now,
        input.userId,
      );
    }

    if (input.profileCode !== undefined) {
      const profile = assertProfile(input.profileCode, perfisDeQuemAge);
      const destino = input.workshopIds ?? atual.workshops.map((w) => w.id);

      if (WORKSHOP_PROFILES.has(profile) && destino.length === 0) {
        throw new ApiError(
          'CORE_WORKSHOP_LINK_REQUIRED',
          'Perfil de oficina exige ao menos uma oficina vinculada.',
          400,
        );
      }
      db.prepare(
        'UPDATE core_user_companies SET profile_code = ? WHERE user_id = ? AND company_id = ?',
      ).run(profile, input.userId, input.companyId);
    }

    if (input.workshopIds !== undefined) {
      assertWorkshopsOfCompany(input.companyId, input.workshopIds);
      const perfil = input.profileCode ?? atual.profileCode;

      if (WORKSHOP_PROFILES.has(perfil) && input.workshopIds.length === 0) {
        throw new ApiError(
          'CORE_WORKSHOP_LINK_REQUIRED',
          'Perfil de oficina exige ao menos uma oficina vinculada.',
          400,
        );
      }
      replaceWorkshopLinks(
        input.companyId,
        input.userId,
        input.workshopIds,
        perfil === 'mecanico' ? 'mecanico' : perfil,
      );
    }

    return getTeamMember(input.companyId, input.userId)!;
  });
}

/**
 * Ativa ou desativa o acesso.
 *
 * Desativar NÃO apaga a pessoa: a OS que ela assumiu, os comentários e as
 * peças que lançou continuam apontando para ela. Apagar o usuário deixaria
 * esse histórico órfão — e histórico de oficina é o que resolve discussão com
 * cliente meses depois.
 *
 * `session_version` é incrementado junto: quem já está logado cai na
 * requisição seguinte — `authMiddleware` confere a versão a cada requisição
 * (GAP-PRD-053); antes, só quando o token expirasse.
 */
export function setTeamMemberActive(input: {
  companyId: string;
  userId: string;
  active: boolean;
  actorId: string;
  /** Perfis de QUEM AGE. Vem de `scope(req).profiles`, nunca do corpo. */
  perfisDeQuemAge?: string[];
}): TeamMember {
  ensureCoreSchema();
  assertSameCompany(input.companyId, input.userId);

  /*
    O ALVO TAMBEM E GUARDADO, e nao so o perfil pedido: sem isto, quem nao
    pode CRIAR um gestor podia tomar a conta do gestor que ja existe, que da no
    mesmo com uma volta a mais.

    E o guarda e o da CONTA, nao o do vinculo (GAP-PRD-152): `active` mora em
    `core_users` e desliga a pessoa em TODAS as operacoes dela. O gestor de uma
    loja so desativava o administrador do grupo nas seis. Quem nao alcanca
    todas as operacoes do alvo tem, para isto, "Remover desta operacao".
  */
  assertPodeMexerNaConta({
    companyId: input.companyId,
    alvoId: input.userId,
    actorId: input.actorId,
    perfisDeQuemAge: input.perfisDeQuemAge ?? [],
  });

  // Sem isto, um gestor distraído se tranca para fora e ninguém consegue
  // reativá-lo pela tela.
  if (!input.active && input.userId === input.actorId) {
    throw new ApiError('CORE_CANNOT_DEACTIVATE_SELF', 'Você não pode desativar o próprio acesso.', 400);
  }

  return withTransaction(() => {
    getConnection()
      .prepare(
        `UPDATE core_users
            SET active = ?, session_version = session_version + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(input.active ? 1 : 0, new Date().toISOString(), input.userId);
    return getTeamMember(input.companyId, input.userId)!;
  });
}

/**
 * Define uma senha provisória.
 *
 * A senha nova é marcada como "trocar no primeiro acesso": o gestor precisa
 * conhecê-la para entregar, e a partir daí só o dono deve conhecer a que está
 * em uso. A versão de sessão sobe para derrubar sessões antigas — se o reset
 * foi por suspeita de acesso indevido, deixar a sessão de pé anularia o gesto.
 */
export async function resetTeamMemberPassword(input: {
  companyId: string;
  userId: string;
  password: string;
  /** Quem redefine — o próprio alvo não tem "outras operações" alheias. */
  actorId: string;
  /** Perfis de QUEM AGE. Vem de `scope(req).profiles`, nunca do corpo. */
  perfisDeQuemAge?: string[];
}): Promise<TeamMember> {
  ensureCoreSchema();
  assertSameCompany(input.companyId, input.userId);
  /*
    TROCAR A SENHA DE ALGUEM E TOMAR A CONTA DELE.

    Sem esta linha, um gerente de loja que recebia 403 ao tentar CRIAR um
    gestor podia simplesmente trocar a senha do gestor que ja existe e entrar
    como ele. A porta da frente recusava e a de tras nao — e continuou aberta
    para o `admin_geral` ate o GAP-PRD-010.

    A senha e da PESSOA: vale em todas as operacoes dela. Por isso o guarda e
    o da conta — o gerente de A nao toma, pela senha, o tecnico que tambem
    trabalha na B, onde ele nao manda em ninguem.
  */
  assertPodeMexerNaConta({
    companyId: input.companyId,
    alvoId: input.userId,
    actorId: input.actorId,
    perfisDeQuemAge: input.perfisDeQuemAge ?? [],
  });
  assertPassword(input.password);

  const hash = await hashPassword(input.password);

  return withTransaction(() => {
    getConnection()
      .prepare(
        `UPDATE core_users
            SET password_hash = ?, hash_algorithm = 'argon2id', must_rehash = 0,
                must_change_password = 1, session_version = session_version + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(hash, new Date().toISOString(), input.userId);
    return getTeamMember(input.companyId, input.userId)!;
  });
}

/**
 * ============================================================================
 * TIRAR A PESSOA SÓ DESTA OPERAÇÃO — e dar de volta (GAP-PRD-152)
 * ============================================================================
 *
 * "Desativar" desliga a CONTA, e a conta é uma para todas as operações da
 * pessoa. Isso é o certo quando a pessoa sai do grupo; é errado quando ela só
 * deixa de trabalhar AQUI — o técnico que atendia duas bancadas e agora fica
 * numa, o administrador do grupo que não precisa mais entrar numa loja.
 *
 * Por isso o vínculo tem a própria alavanca. Ela apaga a linha desta operação
 * em `core_user_companies` e as bancadas DESTA operação; a conta, a senha e os
 * outros vínculos ficam intactos. O histórico não se perde: vendas, OS e
 * trilha continuam apontando para o id da pessoa, que continua existindo.
 *
 * Três recusas, cada uma com o seu motivo:
 *
 *   - a si mesmo: quem se remove perde a tela de onde desfaria o gesto;
 *   - o ÚLTIMO vínculo: a conta ficaria sem nenhuma operação — nenhuma lista
 *     de equipe a mostraria, e ninguém a reativaria pela tela. Para tirar o
 *     acesso inteiro existe "Desativar", que é reversível;
 *   - vínculo de `admin_geral`: ele não é atribuível pela tela, então a
 *     remoção não teria volta pela tela. A criação dele é de instalação, e a
 *     retirada também.
 *
 * As sessões DESTA operação caem na requisição seguinte (`authMiddleware`
 * confere o vínculo a cada requisição, GAP-PRD-053, e o refresh o relê e
 * recusa quem não o tem mais); as das outras operações seguem —
 * subir `session_version` derrubaria a pessoa do trabalho que ela continua
 * fazendo lá.
 */
export function removerDaOperacao(input: {
  companyId: string;
  userId: string;
  actorId: string;
  /** Perfis de QUEM AGE. Vem de `scope(req).profiles`, nunca do corpo. */
  perfisDeQuemAge?: string[];
}): { id: string; login: string; outrasOperacoes: number } {
  ensureCoreSchema();
  assertSameCompany(input.companyId, input.userId);

  if (input.userId === input.actorId) {
    throw new ApiError(
      'CORE_CANNOT_REMOVE_SELF',
      'Você não pode se remover da operação em que está trabalhando.',
      400,
    );
  }

  const perfilAqui = perfilDoAlvo(input.companyId, input.userId);
  assertPodeMexerNaOperacao(perfilAqui, input.perfisDeQuemAge ?? []);

  if (perfilAqui === 'admin_geral') {
    throw new ApiError(
      'CORE_INSTALL_ONLY_PROFILE',
      'O vínculo de administrador do sistema não se remove pela tela: ele também não se cria '
        + 'por ela, e a remoção não teria volta. É operação de instalação.',
      403,
      { profileCode: perfilAqui },
    );
  }

  const db = getConnection();
  const outras = db
    .prepare('SELECT COUNT(*) AS n FROM core_user_companies WHERE user_id = ? AND company_id <> ?')
    .get(input.userId, input.companyId) as { n: number };
  if (outras.n === 0) {
    throw new ApiError(
      'CORE_LAST_COMPANY_LINK',
      'Esta é a única operação desta pessoa. Remover o último vínculo deixaria a conta sem '
        + 'nenhuma tela onde ser encontrada; para tirar o acesso, use "Desativar", que se desfaz.',
      409,
    );
  }

  const login = (
    db.prepare('SELECT login FROM core_users WHERE id = ?').get(input.userId) as { login: string }
  ).login;

  withTransaction(() => {
    db.prepare(
      `DELETE FROM core_workshop_members
        WHERE user_id = ?
          AND workshop_id IN (SELECT id FROM core_workshops WHERE company_id = ?)`,
    ).run(input.userId, input.companyId);
    /*
      O VÍNCULO DE COMISSÃO SAI JUNTO — senão a readmissão comissiona sozinha.

      Quem era removido da operação deixava para trás a linha de
      `core_commission_members`: a pessoa sumia da tela (ComissõesPage lista a
      EQUIPE), mas a linha continuava no banco, `faixaPara` continuava
      resolvendo a faixa dela, e o dia em que a pessoa fosse revinculada ela
      voltava comissionada no grupo antigo sem ninguém ter decidido isso. O que
      já foi APURADO (`core_commission_entries`) fica: é dinheiro de venda que
      aconteceu, e período fechado não se reescreve por desligamento.
    */
    db.prepare('DELETE FROM core_commission_members WHERE company_id = ? AND user_id = ?').run(
      input.companyId,
      input.userId,
    );
    const removido = db
      .prepare('SELECT is_default FROM core_user_companies WHERE user_id = ? AND company_id = ?')
      .get(input.userId, input.companyId) as { is_default: number };
    db.prepare('DELETE FROM core_user_companies WHERE user_id = ? AND company_id = ?').run(
      input.userId,
      input.companyId,
    );
    // A operação padrão do login saiu: a mais antiga das que sobraram assume,
    // para o login seguinte não escolher por ordem alfabética.
    if (removido.is_default === 1) {
      db.prepare(
        `UPDATE core_user_companies SET is_default = 1
          WHERE id = (SELECT id FROM core_user_companies WHERE user_id = ?
                       ORDER BY created_at, id LIMIT 1)`,
      ).run(input.userId);
    }
  });

  return { id: input.userId, login, outrasOperacoes: outras.n };
}

/**
 * Dá acesso a ESTA operação a uma conta que já existe no grupo.
 *
 * É o desfazer de `removerDaOperacao`, e também o caminho para quem passa a
 * trabalhar aqui além de onde já trabalha. A pessoa é achada pelo LOGIN, que
 * é o que a gestão conhece — o id de outra empresa ninguém daqui tem.
 *
 * NÃO toca na senha, no nome nem no e-mail: tudo isso é da conta, e a conta
 * pode entrar em operações onde quem age não manda. Por isso a senha também
 * não vira provisória — ninguém daqui a conhece. O que se entrega é só o
 * vínculo, e o vínculo passa pela régua de sempre: perfil atribuível, perfil
 * que quem age pode entregar, bancada desta operação, bancada obrigatória para
 * perfil de oficina.
 */
export function vincularContaExistente(input: {
  companyId: string;
  login: string;
  profileCode: string;
  /** Perfis de QUEM AGE. Vem de `scope(req).profiles`, nunca do corpo. */
  perfisDeQuemCria?: string[];
  workshopIds?: string[];
}): TeamMember {
  ensureCoreSchema();
  const login = input.login.trim();
  if (!login) throw new ApiError('CORE_USER_INCOMPLETE', 'Informe o login da conta.', 400);

  const profile = assertProfile(input.profileCode, input.perfisDeQuemCria ?? []);
  const workshopIds = input.workshopIds ?? [];
  assertWorkshopsOfCompany(input.companyId, workshopIds);
  if (WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0) {
    throw new ApiError(
      'CORE_WORKSHOP_LINK_REQUIRED',
      'Perfil de oficina exige ao menos uma oficina vinculada.',
      400,
    );
  }

  const db = getConnection();
  const conta = contaPeloLogin<{ id: string; login: string }>(login);
  if (!conta?.id) {
    throw new ApiError('CORE_USER_NOT_FOUND', 'Nenhuma conta do grupo tem este login.', 404);
  }
  const userId = conta.id;
  const jaAqui = db
    .prepare('SELECT 1 AS ok FROM core_user_companies WHERE user_id = ? AND company_id = ?')
    .get(userId, input.companyId) as { ok?: number } | undefined;
  if (jaAqui?.ok) {
    throw new ApiError(
      'CORE_ALREADY_IN_COMPANY',
      'Esta conta já tem acesso a esta operação — edite o perfil dela na lista.',
      409,
    );
  }

  return withTransaction(() => {
    db.prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(randomUUID(), userId, input.companyId, profile, new Date().toISOString());
    replaceWorkshopLinks(input.companyId, userId, workshopIds, profile === 'mecanico' ? 'mecanico' : profile);
    return getTeamMember(input.companyId, userId)!;
  });
}

/**
 * A troca feita PELO DONO — o primeiro (e único) escritor de
 * `must_change_password = 0`.
 *
 * O espelho de `resetTeamMemberPassword`, com a diferença que dá sentido à
 * bandeira: quando é a GESTÃO que define a senha, duas pessoas a conhecem e a
 * bandeira sobe (troque no primeiro acesso); quando é o PRÓPRIO dono que
 * troca — pela rota `POST /auth/password`, que confere a senha atual antes —,
 * só ele conhece a nova, e a bandeira desce. Sem este escritor, "provisória"
 * era para sempre: nenhum caminho no servidor gravava 0.
 *
 * `session_version` sobe igual ao reset, e pelo mesmo motivo: se a troca foi
 * porque a senha vazou (ou porque a gestora a conhecia), deixar as sessões
 * antigas de pé anularia o gesto. O refresh da própria sessão que pediu a
 * troca morre junto, e o ACCESS dela cai na requisição seguinte (GAP-PRD-053):
 * o chamador entra de novo, com a senha que agora só ele sabe.
 *
 * QUEM VALIDA fica no chamador, como nos outros dois caminhos de senha: esta
 * função recebe o hash já derivado (Argon2id, fora de transação) e quem ainda
 * tem o texto em claro chama `assertPassword` antes.
 */
export function registrarTrocaDaPropriaSenha(userId: string, passwordHash: string): void {
  ensureCoreSchema();
  withTransaction(() => {
    getConnection()
      .prepare(
        `UPDATE core_users
            SET password_hash = ?, hash_algorithm = 'argon2id', must_rehash = 0,
                must_change_password = 0, session_version = session_version + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(passwordHash, new Date().toISOString(), userId);
  });
}

/**
 * A senha deste usuário ainda é a provisória que a gestão entregou?
 *
 * Leitor para o LOGIN (`POST /auth/login` devolve a bandeira no corpo): a
 * tela só tem como pedir a troca se a resposta do login contar que precisa.
 * Vive aqui — e não num cast sobre a linha de `IdentityService` — porque a
 * bandeira é assunto desta gestão de equipe: todos os escritores dela estão
 * neste arquivo.
 */
export function senhaEProvisoria(userId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT must_change_password AS flag FROM core_users WHERE id = ?')
    .get(userId) as { flag?: number } | undefined;
  return row?.flag === 1;
}

/** Marca o acesso. Chamado pelo login bem-sucedido. */
export function recordLastLogin(userId: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare('UPDATE core_users SET last_login_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}
