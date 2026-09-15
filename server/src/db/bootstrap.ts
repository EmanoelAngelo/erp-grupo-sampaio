/**
 * ============================================================================
 * O BOOTSTRAP DE PRODUÇÃO — o estrutural do grupo, o administrador inicial e
 * os logins padrão
 * ============================================================================
 *
 * Roda na subida (`index.ts`, logo depois de preparar o banco) e no comando
 * `npm run db:bootstrap --prefix server` — que é também o `db:seed`: roteiros e
 * documentos citam esse nome, e ele não cria mais conta de demonstração
 * nenhuma. As doze contas de demonstração moram no seed de DESENVOLVIMENTO
 * (`npm run db:seed:dev --prefix server`), que recusa produção e homologação.
 *
 * ## O que ele garante
 *
 *   - as seis empresas do grupo, com os slugs de sempre. A que falta nasce — com
 *     os administradores e os gestores do grupo dentro, senão eles perderiam o
 *     título no instante em que ela existisse (ver `listGroupAdminIds`); a que
 *     existe NÃO é tocada: nome, CNPJ, regime e tipo de loja são do dono;
 *   - o que a subida já garantia: as duas bancadas oficiais e quem usa
 *     plaquinha. O tipo de loja só é carimbado na empresa que nasceu AGORA — é
 *     escolha do dono, e reimpô-lo a cada subida a desfaria;
 *   - o ADMINISTRADOR INICIAL: login `admin`, nome "Administrador", senha de
 *     `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`, Argon2id pelo mesmo caminho das outras
 *     contas, troca obrigatória no primeiro acesso, `admin_geral` em todas as
 *     empresas ativas (padrão na Preço Justo). Grava a auditoria
 *     `bootstrap.admin_created` (quem: o sistema) e a marca
 *     `bootstrap_admin_created_at` em `core_meta`;
 *   - os LOGINS PADRÃO (`loginsPadrao.ts`): o PDV e o painel do gestor de cada
 *     operação e as duas bancadas da Oficina, com a senha PROVISÓRIA de
 *     `DEVORA_BOOTSTRAP_LOGINS_PASSWORD`. Só os que faltam, um a um; cada um
 *     grava `bootstrap.login_padrao_criado`. Sem a variável, nenhum nasce.
 *
 * ## Quando o administrador NÃO nasce
 *
 *   - já existe administrador do grupo;
 *   - já existe conta com o login `admin`, sem distinguir maiúsculas — o login
 *     compara com `COLLATE NOCASE`, e um 'admin' ao lado de um 'ADMIN' seriam
 *     duas contas que a tela de entrada não distingue;
 *   - a variável não está definida: nada é criado, o log avisa (sem segredo) e
 *     a conferência da implantação BLOQUEIA dizendo o que fazer.
 *
 * Ele NUNCA altera conta existente: rodar de novo, com a variável que for, não
 * duplica, não reseta, não mexe na senha que o dono trocou nem no acesso que ele
 * personalizou. A senha nunca vai para log, auditoria, marca, relatório nem
 * resposta de API — e senha fraca, ou a de desenvolvimento em produção, é
 * recusada ANTES de criar qualquer coisa.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { ensureCoreSchema } from './schema.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from './core-migrations.js';
import { getConnection, withTransaction } from './sqlite.js';
import {
  findUserByLogin,
  linkUserToWorkshop,
  listGroupAdminIds,
  listGroupManagerIds,
  upsertCompany,
} from '../services/auth/IdentityService.js';
import { hashPassword } from '../services/auth/PasswordService.js';
import { recordAudit } from '../services/audit/AuditService.js';
import { PRESET_OFICIAL } from '../services/core/StorefrontPresets.js';
import {
  ativarDevolucaoEmDuasEtapasNaPrecoJusto,
  exigirMotivoDaLiberacaoNaPrecoJusto,
} from '../services/core/SalePolicyService.js';
import { logInfo, logWarn } from '../utils/errors.js';
import {
  LOGIN_DO_ADMINISTRADOR_INICIAL,
  MARCA_DO_ADMINISTRADOR_CRIADO,
  NOME_DO_ADMINISTRADOR_INICIAL,
  VARIAVEL_DA_SENHA_INICIAL,
  ambienteDeProducao,
  recusaDaSenhaInicial,
} from './administradorInicial.js';
import { LOGINS_PADRAO, VARIAVEL_DA_SENHA_DOS_LOGINS, type LoginPadrao } from './loginsPadrao.js';

/**
 * As seis operações do Grupo Sampaio — e só elas: nenhuma filial fictícia.
 * Empresa nova passa a existir quando o administrador a cria pela tela.
 */
export const EMPRESAS_DO_GRUPO = [
  { slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Comércio Ltda', kind: 'retail' },
  { slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Comércio Ltda', kind: 'retail' },
  { slug: 'me-mimei', tradeName: 'Me Mimei', legalName: 'Me Mimei Comércio Ltda', kind: 'retail' },
  { slug: 'conceito', tradeName: 'Conceito', legalName: 'Conceito Comércio Ltda', kind: 'retail' },
  { slug: 'pj-motors', tradeName: 'PJ Motors', legalName: 'PJ Motors Comércio Ltda', kind: 'retail' },
  { slug: 'oficina', tradeName: 'Oficina', legalName: 'Oficina Serviços Ltda', kind: 'workshop' },
] as const;

const EMPRESA_PADRAO = 'preco-justo';

export type OrigemDoBootstrap = 'subida' | 'comando';

export type AdministradorNoBootstrap =
  | { situacao: 'criado'; id: string; login: string; empresas: number }
  | {
      situacao: 'ja_existe';
      motivo: 'administrador_do_grupo' | 'login_ocupado';
      /** A conta que ocupa o login `admin`, quando há uma. */
      login: string | null;
      /** A variável continua definida — sem efeito nenhum, e deve ser apagada. */
      variavelSobrando: boolean;
    }
  | { situacao: 'sem_senha' };

export interface ResultadoDosLoginsPadrao {
  /** Os que nasceram nesta execução. */
  criados: string[];
  /** Os que já existiam — e não foram tocados. */
  existentes: string[];
  /** Os que não puderam nascer (empresa ou bancada ausente), com o motivo. */
  pulados: { login: string; motivo: string }[];
  /** Faltava conta e a variável não estava definida: nenhuma foi criada. */
  semSenha: boolean;
  /** Todas já existem e a variável continua definida — sem efeito, e deve ser apagada. */
  variavelSobrando: boolean;
}

export interface ResultadoDoBootstrap {
  /** Slugs das empresas que nasceram nesta execução. */
  empresasCriadas: string[];
  administrador: AdministradorNoBootstrap;
  loginsPadrao?: ResultadoDosLoginsPadrao;
}

/** Senha inicial recusada: a mensagem diz o motivo, nunca o valor. */
export class BootstrapRecusado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'BootstrapRecusado';
  }
}

/** Conta nova com senha PROVISÓRIA (`must_change_password = 1`), a partir do hash. */
export function inserirContaProvisoria(login: string, displayName: string, hash: string): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_users
         (id, login, display_name, email, password_hash, hash_algorithm, must_rehash,
          must_change_password, active, session_version, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'argon2id', 0, 1, 1, 1, ?, ?)`,
    )
    .run(id, login, displayName, hash, agora, agora);
  return id;
}

/** O vínculo, se ainda não existe. Existindo, o perfil que o dono deu fica. */
export function vincularSeAusente(userId: string, companyId: string, profileCode: string, isDefault: boolean): void {
  getConnection()
    .prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, company_id) DO NOTHING`,
    )
    .run(randomUUID(), userId, companyId, profileCode, isDefault ? 1 : 0, new Date().toISOString());
}

/**
 * As seis empresas, as duas bancadas e a regra da plaquinha. Devolve os slugs
 * das empresas criadas agora. Empresa que existe não é tocada.
 */
export function garantirEstruturaDoGrupo(): string[] {
  ensureCoreSchema();
  const criadas = withTransaction(() => {
    const db = getConnection();
    // ANTES de criar: derivadas depois, o denominador já contaria a empresa
    // nova, onde ninguém está — e a lista voltaria vazia (IdentityService).
    const adminsDoGrupo = listGroupAdminIds();
    const gestoresDoGrupo = listGroupManagerIds();
    const agora = new Date().toISOString();
    const vinculo = db.prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (user_id, company_id) DO NOTHING`,
    );
    const carimbo = db.prepare(
      'UPDATE core_companies SET storefront_preset = ? WHERE id = ? AND storefront_preset IS NULL',
    );
    const existe = db.prepare('SELECT id FROM core_companies WHERE slug = ?');
    const novas: string[] = [];
    for (const empresa of EMPRESAS_DO_GRUPO) {
      if (existe.get(empresa.slug)) continue;
      const id = upsertCompany({
        slug: empresa.slug,
        legalName: empresa.legalName,
        tradeName: empresa.tradeName,
        kind: empresa.kind,
      });
      for (const adminId of adminsDoGrupo) vinculo.run(randomUUID(), adminId, id, 'admin_geral', agora);
      for (const gestorId of gestoresDoGrupo) vinculo.run(randomUUID(), gestorId, id, 'gestor', agora);
      const preset = PRESET_OFICIAL[empresa.slug];
      if (preset) carimbo.run(preset, id);
      novas.push(empresa.slug);
    }
    return novas;
  });
  // As mesmas duas que a subida já roda: num banco novo elas rodaram antes
  // das empresas existirem, e a bancada de empresa ausente é pulada.
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  // E pelo mesmo motivo: num banco novo a Preço Justo nasce aqui, depois da
  // subida — a devolução em duas etapas é ligada nela agora.
  ativarDevolucaoEmDuasEtapasNaPrecoJusto();
  // E o motivo obrigatório da liberação de desconto, pelo mesmo motivo (P0).
  exigirMotivoDaLiberacaoNaPrecoJusto();
  return criadas;
}

type Decisao =
  | { tipo: 'criar' }
  | { tipo: 'administrador_do_grupo' | 'login_ocupado'; login: string | null };

function decidir(): Decisao {
  const ocupante = findUserByLogin(LOGIN_DO_ADMINISTRADOR_INICIAL);
  if (listGroupAdminIds().length > 0) return { tipo: 'administrador_do_grupo', login: ocupante?.login ?? null };
  if (ocupante) return { tipo: 'login_ocupado', login: ocupante.login };
  return { tipo: 'criar' };
}

function criarAdministrador(hash: string, origem: OrigemDoBootstrap): { id: string; empresas: number } {
  const db = getConnection();
  const ativas = db
    .prepare('SELECT id, slug FROM core_companies WHERE active = 1 ORDER BY trade_name')
    .all() as { id: string; slug: string }[];
  const padrao = ativas.find((e) => e.slug === EMPRESA_PADRAO) ?? ativas[0];
  const id = inserirContaProvisoria(LOGIN_DO_ADMINISTRADOR_INICIAL, NOME_DO_ADMINISTRADOR_INICIAL, hash);
  for (const empresa of ativas) vincularSeAusente(id, empresa.id, 'admin_geral', empresa.id === padrao?.id);
  recordAudit({
    companyId: padrao?.id ?? null,
    // Quem fez foi o sistema: não há conta por trás, e o registro diz isso.
    userId: null,
    action: 'bootstrap.admin_created',
    entityType: 'user',
    entityId: id,
    // A senha NUNCA entra na auditoria.
    detail: {
      login: LOGIN_DO_ADMINISTRADOR_INICIAL,
      displayName: NOME_DO_ADMINISTRADOR_INICIAL,
      ator: 'sistema',
      origem,
      empresas: ativas.map((e) => e.slug),
      trocaObrigatoria: true,
    },
  });
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(MARCA_DO_ADMINISTRADOR_CRIADO, new Date().toISOString());
  return { id, empresas: ativas.length };
}

function preservado(
  decisao: Exclude<Decisao, { tipo: 'criar' }>,
  variavelSobrando: boolean,
  empresasCriadas: string[],
  origem: OrigemDoBootstrap,
): ResultadoDoBootstrap {
  if (decisao.tipo === 'login_ocupado') {
    logWarn('BOOTSTRAP_LOGIN_OCUPADO', {
      origem,
      login: decisao.login,
      detalhe:
        `Ninguém administra o grupo, e o login '${decisao.login}' já existe: o bootstrap não cria `
        + `'${LOGIN_DO_ADMINISTRADOR_INICIAL}' ao lado dele nem altera conta existente.`,
      comoResolver: 'Ver o item "Administrador inicial" em Configurações › Implantação ou no comando conferir-implantacao.',
    });
  } else if (variavelSobrando) {
    logWarn('BOOTSTRAP_VARIAVEL_SEM_EFEITO', {
      origem,
      variavel: VARIAVEL_DA_SENHA_INICIAL,
      detalhe: 'Já existe administrador do grupo: a variável não cria nem altera conta nenhuma.',
      comoResolver: `Apague ${VARIAVEL_DA_SENHA_INICIAL} do .env (e do ambiente do serviço).`,
    });
  }
  return {
    empresasCriadas,
    administrador: { situacao: 'ja_existe', motivo: decisao.tipo, login: decisao.login, variavelSobrando },
  };
}

/** Os logins padrão que ainda não têm conta (pela chave do login: maiúscula não conta, acento conta). */
function loginsPadraoFaltando(): LoginPadrao[] {
  return LOGINS_PADRAO.filter((l) => !findUserByLogin(l.login));
}

export async function executarBootstrap(
  opcoes: { origem?: OrigemDoBootstrap } = {},
): Promise<ResultadoDoBootstrap> {
  const origem = opcoes.origem ?? 'comando';
  const env = loadEnv();
  const senhaDosLogins = env.DEVORA_BOOTSTRAP_LOGINS_PASSWORD.trim() ? env.DEVORA_BOOTSTRAP_LOGINS_PASSWORD : '';
  ensureCoreSchema();

  // A senha dos logins padrão é conferida ANTES de escrever qualquer coisa —
  // como a do admin —, e só quando vai ser usada.
  if (senhaDosLogins && loginsPadraoFaltando().length > 0) {
    const producao = ambienteDeProducao({ DEVORA_API_ENV: env.DEVORA_API_ENV, NODE_ENV: process.env.NODE_ENV });
    const recusa = recusaDaSenhaInicial(senhaDosLogins, producao, VARIAVEL_DA_SENHA_DOS_LOGINS);
    if (recusa) throw new BootstrapRecusado(`${recusa} Nada foi criado.`);
  }

  const resultado = await garantirAdministrador(origem, env);
  const loginsPadrao = await garantirLoginsPadrao(senhaDosLogins, origem);
  return { ...resultado, loginsPadrao };
}

async function garantirAdministrador(
  origem: OrigemDoBootstrap,
  env: ReturnType<typeof loadEnv>,
): Promise<ResultadoDoBootstrap> {
  const senha = env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD.trim() ? env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD : '';

  // A senha é conferida ANTES de escrever qualquer coisa — e só quando vai
  // ser usada: com administrador de pé, a variável não é nem lida a fundo.
  const decisao = decidir();
  if (decisao.tipo === 'criar' && senha) {
    const producao = ambienteDeProducao({ DEVORA_API_ENV: env.DEVORA_API_ENV, NODE_ENV: process.env.NODE_ENV });
    const recusa = recusaDaSenhaInicial(senha, producao);
    if (recusa) throw new BootstrapRecusado(`${recusa} Nada foi criado.`);
  }

  const empresasCriadas = garantirEstruturaDoGrupo();
  if (empresasCriadas.length > 0) logInfo('BOOTSTRAP_EMPRESAS_CRIADAS', { origem, empresas: empresasCriadas });

  if (decisao.tipo !== 'criar') return preservado(decisao, Boolean(senha), empresasCriadas, origem);

  if (!senha) {
    logWarn('BOOTSTRAP_SEM_ADMINISTRADOR', {
      origem,
      variavel: VARIAVEL_DA_SENHA_INICIAL,
      detalhe:
        'Nenhuma conta administra o grupo e a senha do administrador inicial não foi definida: '
        + 'nenhuma conta foi criada, e ninguém entra ainda.',
      comoResolver:
        `Defina ${VARIAVEL_DA_SENHA_INICIAL} no .env do servidor e suba de novo (ou rode `
        + `npm run db:bootstrap --prefix server com a API parada). Entre como '${LOGIN_DO_ADMINISTRADOR_INICIAL}', `
        + 'troque a senha no primeiro acesso e apague a variável.',
    });
    return { empresasCriadas, administrador: { situacao: 'sem_senha' } };
  }

  // Argon2id é caro e assíncrono: sai antes da transação.
  const hash = await hashPassword(senha);
  type Desfecho =
    | { criado: { id: string; empresas: number } }
    | { preservado: Exclude<Decisao, { tipo: 'criar' }> };
  const desfecho = withTransaction((): Desfecho => {
    // Conferido de novo dentro da transação: a trava de instância já impede
    // dois bootstraps juntos, e isto garante que a regra vale no instante da
    // escrita, não no da leitura.
    const deNovo = decidir();
    return deNovo.tipo === 'criar'
      ? { criado: criarAdministrador(hash, origem) }
      : { preservado: deNovo };
  });
  if ('preservado' in desfecho) return preservado(desfecho.preservado, true, empresasCriadas, origem);

  logInfo('BOOTSTRAP_ADMIN_CRIADO', {
    origem,
    login: LOGIN_DO_ADMINISTRADOR_INICIAL,
    empresas: desfecho.criado.empresas,
    proximoPasso:
      `Entre como '${LOGIN_DO_ADMINISTRADOR_INICIAL}', troque a senha no primeiro acesso e apague `
      + `${VARIAVEL_DA_SENHA_INICIAL} do .env.`,
  });
  return {
    empresasCriadas,
    administrador: {
      situacao: 'criado',
      id: desfecho.criado.id,
      login: LOGIN_DO_ADMINISTRADOR_INICIAL,
      empresas: desfecho.criado.empresas,
    },
  };
}

/**
 * Os logins padrão que faltam, um a um. Cada um: conta PROVISÓRIA (Argon2id,
 * sal próprio), o vínculo com o modelo de sistema na empresa dele (e só nela),
 * a bancada para o técnico, e a auditoria. O que já existe não é tocado.
 */
async function garantirLoginsPadrao(senha: string, origem: OrigemDoBootstrap): Promise<ResultadoDosLoginsPadrao> {
  const r: ResultadoDosLoginsPadrao = { criados: [], existentes: [], pulados: [], semSenha: false, variavelSobrando: false };
  const faltando = loginsPadraoFaltando();
  r.existentes = LOGINS_PADRAO.filter((l) => !faltando.includes(l)).map((l) => l.login);
  if (faltando.length === 0) {
    if (senha) {
      r.variavelSobrando = true;
      logWarn('BOOTSTRAP_VARIAVEL_SEM_EFEITO', {
        origem,
        variavel: VARIAVEL_DA_SENHA_DOS_LOGINS,
        detalhe: 'Os logins padrão já existem: a variável não cria nem altera conta nenhuma.',
        comoResolver: `Apague ${VARIAVEL_DA_SENHA_DOS_LOGINS} do .env (e do ambiente do serviço).`,
      });
    }
    return r;
  }
  if (!senha) {
    r.semSenha = true;
    return r;
  }

  const db = getConnection();
  const empresaPeloSlug = db.prepare('SELECT id FROM core_companies WHERE slug = ? AND active = 1');
  const bancadaPeloSlug = db.prepare('SELECT id FROM core_workshops WHERE slug = ? AND company_id = ? AND active = 1');
  for (const l of faltando) {
    const empresa = empresaPeloSlug.get(l.empresa) as { id?: string } | undefined;
    if (!empresa?.id) {
      r.pulados.push({ login: l.login, motivo: `a empresa ${l.empresa} não existe ou está inativa` });
      continue;
    }
    const empresaId = empresa.id;
    let bancadaId: string | null = null;
    if (l.bancada) {
      const bancada = bancadaPeloSlug.get(l.bancada, empresaId) as { id?: string } | undefined;
      if (!bancada?.id) {
        r.pulados.push({ login: l.login, motivo: `a bancada ${l.bancada} não existe ou está inativa em ${l.empresa}` });
        continue;
      }
      bancadaId = bancada.id;
    }
    // Argon2id fora da transação, e um sal por conta (a mesma senha não dá o mesmo hash).
    const hash = await hashPassword(senha);
    const criado = withTransaction(() => {
      // Conferido de novo no instante da escrita.
      if (findUserByLogin(l.login)) return false;
      const id = inserirContaProvisoria(l.login, l.login, hash);
      vincularSeAusente(id, empresaId, l.modelo, true);
      if (bancadaId) linkUserToWorkshop(id, bancadaId, 'mecanico');
      recordAudit({
        companyId: empresaId,
        userId: null,
        action: 'bootstrap.login_padrao_criado',
        entityType: 'user',
        entityId: id,
        // A senha NUNCA entra na auditoria.
        detail: {
          login: l.login,
          empresa: l.empresa,
          modelo: l.modelo,
          bancada: l.bancada ?? null,
          papel: l.papel,
          ator: 'sistema',
          origem,
          trocaObrigatoria: true,
        },
      });
      return true;
    });
    (criado ? r.criados : r.existentes).push(l.login);
  }
  if (r.criados.length > 0) {
    logInfo('BOOTSTRAP_LOGINS_PADRAO_CRIADOS', {
      origem,
      logins: r.criados,
      proximoPasso:
        `Cada login entra com a senha de ${VARIAVEL_DA_SENHA_DOS_LOGINS}, provisória (troca obrigatória no `
        + 'primeiro acesso). Depois das trocas, apague a variável do .env.',
    });
  }
  if (r.pulados.length > 0) logWarn('BOOTSTRAP_LOGINS_PADRAO_PULADOS', { origem, pulados: r.pulados });
  return r;
}

/** O que o comando imprime. Nunca a senha — só o que aconteceu e o próximo passo. */
export function relatorioDoBootstrap(r: ResultadoDoBootstrap): string[] {
  const linhas = [`Empresas do grupo: ${EMPRESAS_DO_GRUPO.map((e) => e.tradeName).join(', ')}.`];
  linhas.push(
    r.empresasCriadas.length > 0
      ? `Criadas agora: ${r.empresasCriadas.join(', ')}. As que já existiam não foram alteradas.`
      : 'Todas já existiam e não foram alteradas.',
  );
  const a = r.administrador;
  if (a.situacao === 'criado') {
    linhas.push(`Administrador inicial criado: login '${a.login}', administrador do grupo em ${a.empresas} empresa(s).`);
    linhas.push(
      `A senha é a de ${VARIAVEL_DA_SENHA_INICIAL}, PROVISÓRIA: o primeiro login abre a troca obrigatória `
        + 'e a API recusa o resto até lá.',
    );
    linhas.push(`Depois da troca, apague ${VARIAVEL_DA_SENHA_INICIAL} do .env: ela não cria nem altera mais nada.`);
  } else if (a.situacao === 'ja_existe') {
    linhas.push(
      a.motivo === 'administrador_do_grupo'
        ? 'Já existe administrador do grupo: nenhuma conta foi criada nem alterada.'
        : `Ninguém administra o grupo, e o login '${a.login}' já existe: o bootstrap não cria `
          + `'${LOGIN_DO_ADMINISTRADOR_INICIAL}' ao lado dele nem altera conta existente. `
          + 'Ver "Administrador inicial" na conferência da implantação.',
    );
    if (a.variavelSobrando) linhas.push(`${VARIAVEL_DA_SENHA_INICIAL} continua definida e não tem efeito: apague-a do .env.`);
  } else {
    linhas.push(
      `Nenhuma conta administra o grupo e ${VARIAVEL_DA_SENHA_INICIAL} não está definida: nenhuma conta foi `
        + 'criada, e ninguém entra ainda.',
    );
    linhas.push(
      `Defina ${VARIAVEL_DA_SENHA_INICIAL} (ao menos 8 caracteres) e rode de novo. Entre como `
        + `'${LOGIN_DO_ADMINISTRADOR_INICIAL}', troque a senha no primeiro acesso e apague a variável.`,
    );
  }
  const lp = r.loginsPadrao;
  if (lp) {
    if (lp.criados.length > 0) {
      linhas.push(`Logins padrão criados (${lp.criados.length}): ${lp.criados.join(', ')}.`);
      linhas.push(
        `A senha de cada um é a de ${VARIAVEL_DA_SENHA_DOS_LOGINS}, PROVISÓRIA: o primeiro login abre a troca `
          + `obrigatória. Depois das trocas, apague ${VARIAVEL_DA_SENHA_DOS_LOGINS} do .env.`,
      );
    }
    if (lp.existentes.length > 0) {
      linhas.push(`Logins padrão que já existiam e não foram alterados: ${lp.existentes.length} de ${LOGINS_PADRAO.length}.`);
    }
    for (const p of lp.pulados) linhas.push(`Login padrão '${p.login}' não foi criado: ${p.motivo}.`);
    if (lp.semSenha) {
      linhas.push(
        `Faltam logins padrão e ${VARIAVEL_DA_SENHA_DOS_LOGINS} não está definida: nenhum foi criado. `
          + 'Defina-a (ao menos 8 caracteres) e rode de novo.',
      );
    }
    if (lp.variavelSobrando) linhas.push(`${VARIAVEL_DA_SENHA_DOS_LOGINS} continua definida e não tem efeito: apague-a do .env.`);
  }
  return linhas;
}
