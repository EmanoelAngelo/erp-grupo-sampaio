/**
 * ============================================================================
 * O ACESSO EFETIVO DE UM VÍNCULO — capabilities, caixas e bancadas de agora
 * ============================================================================
 *
 * RBAC granular, F1 (desenho §5). Um vínculo pessoa × empresa tem um modelo
 * aplicado (`core_user_companies.profile_code`), e o acesso dele é:
 *
 *   - modelo de catálogo inteiro (`full_catalog = 1`) → o catálogo inteiro;
 *   - senão → (capabilities do modelo ∪ acrescentadas) − retiradas, ∩ catálogo;
 *   - modelo sem linha no banco → `MODELOS_DE_SISTEMA[código]`, ou NADA para
 *     código desconhecido (a mesma falha fechada que `abertaAo` dá hoje ao
 *     perfil que ninguém previu).
 *
 * Capability gravada no banco que saiu do catálogo é ignorada aqui — falha
 * fechada — e a subida a apaga com trilha (`AcessoService.ensurePermissionTemplates`).
 *
 * O CACHE. A conferência roda em TODA requisição autenticada, então o que
 * depende de três consultas pequenas (capabilities do modelo, personalização e
 * caixas do vínculo) fica em memória, por conexão, com a chave
 * `vínculo:access_version:modelo:template:versão do template:versão do
 * catálogo`. Toda mudança de acesso sobe `access_version` (vínculo) ou
 * `version` (modelo) — é o que `AcessoService` faz em cada escrita —, então o
 * cache nunca serve acesso velho. As bancadas de que a pessoa é membro NÃO
 * ficam no cache: a lista de membros muda por outro escritor (a equipe da
 * oficina), e é uma consulta por índice só para quem segue "as suas".
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import {
  CAPABILITIES,
  CATALOG_VERSION,
  casaDe,
  ehCapability,
  modeloDeSistema,
  type AtribuivelPor,
  type Capability,
} from './Capabilities.js';

/** A linha que a conferência da sessão lê (uma consulta por chave primária). */
export interface LinhaDoVinculo {
  vinculo_id: string | null;
  profile_code: string | null;
  access_version: number | null;
  all_terminals: number | null;
  all_workshops: number | null;
  company_active: number | null;
  template_id: string | null;
  template_version: number | null;
  template_name: string | null;
  full_catalog: number | null;
  default_workshops: string | null;
  assignable_by: string | null;
}

/** As colunas e as junções do vínculo — as mesmas na sessão e em `acessoDoVinculo`. */
export const COLUNAS_DO_VINCULO = `uc.id AS vinculo_id, uc.profile_code, uc.access_version, uc.all_terminals, uc.all_workshops,
       c.active AS company_active,
       t.id AS template_id, t.version AS template_version, t.name AS template_name,
       t.full_catalog, t.default_workshops, t.assignable_by`;
export const JUNCOES_DO_VINCULO = `LEFT JOIN core_companies c ON c.id = uc.company_id
       LEFT JOIN core_permission_templates t ON t.code = uc.profile_code AND t.archived_at IS NULL`;

export interface ModeloAplicado {
  code: string;
  name: string;
  /** O vínculo tem acrescentadas ou retiradas sobre o modelo. */
  personalizado: boolean;
  acrescentadas: readonly Capability[];
  retiradas: readonly Capability[];
  assignableBy: AtribuivelPor;
  fullCatalog: boolean;
}

export interface AcessoEfetivo {
  vinculoId: string;
  userId: string;
  companyId: string;
  modelo: ModeloAplicado;
  capabilities: ReadonlySet<Capability>;
  /** `todos` = qualquer caixa da empresa, inclusive os que forem criados. */
  terminais: 'todos' | readonly string[];
  /** `todas` = todas as bancadas ativas; lista = as de que é membro (vazia = nenhuma). */
  bancadas: 'todas' | readonly string[];
  /** Não secreto: muda quando o acesso muda. Vai no token (`acessoCarimbo`) e no cabeçalho X-Acesso-Em-Vigor. */
  carimbo: string;
}

interface Calculado {
  chave: string;
  capabilities: ReadonlySet<Capability>;
  modelo: ModeloAplicado;
  terminais: 'todos' | readonly string[];
  regraDeBancadas: 'todas' | 'membro';
}

const TODAS: ReadonlySet<Capability> = new Set(CAPABILITIES);
const LIMITE_DO_CACHE = 5000;

interface Consultas {
  capsDoModelo: StatementSync;
  personalizacao: StatementSync;
  caixas: StatementSync;
  bancadas: StatementSync;
  vinculo: StatementSync;
  cache: Map<string, Calculado>;
}
const porConexao = new WeakMap<DatabaseSync, Consultas>();

function consultas(): Consultas {
  const db = getConnection();
  let c = porConexao.get(db);
  if (!c) {
    c = {
      capsDoModelo: db.prepare('SELECT capability FROM core_permission_template_capabilities WHERE template_id = ?'),
      personalizacao: db.prepare(
        'SELECT capability, effect FROM core_user_company_capabilities WHERE user_company_id = ? ORDER BY capability',
      ),
      caixas: db.prepare('SELECT terminal_id FROM core_user_company_terminals WHERE user_company_id = ? ORDER BY terminal_id'),
      bancadas: db.prepare(
        `SELECT w.id FROM core_workshop_members m
           JOIN core_workshops w ON w.id = m.workshop_id
          WHERE m.user_id = ? AND w.company_id = ? AND w.active = 1
          ORDER BY w.id`,
      ),
      vinculo: db.prepare(
        `SELECT ${COLUNAS_DO_VINCULO}
           FROM core_user_companies uc
           ${JUNCOES_DO_VINCULO}
          WHERE uc.user_id = ? AND uc.company_id = ?`,
      ),
      cache: new Map(),
    };
    porConexao.set(db, c);
  }
  return c;
}

function calcular(c: Consultas, linha: LinhaDoVinculo, chave: string): Calculado {
  const codigo = linha.profile_code ?? '';
  const sistema = modeloDeSistema(codigo);
  let base: ReadonlySet<Capability>;
  let nome: string;
  let assignableBy: AtribuivelPor;
  let defaultWorkshops: 'todas' | 'membro';
  let fullCatalog: boolean;

  if (linha.template_id) {
    fullCatalog = linha.full_catalog === 1;
    base = fullCatalog
      ? TODAS
      : new Set(
        (c.capsDoModelo.all(linha.template_id) as { capability: string }[])
          .map((r) => r.capability)
          .filter(ehCapability),
      );
    nome = linha.template_name ?? codigo;
    assignableBy = (linha.assignable_by as AtribuivelPor | null) ?? 'subconjunto';
    defaultWorkshops = linha.default_workshops === 'todas' ? 'todas' : 'membro';
  } else if (sistema) {
    fullCatalog = sistema.fullCatalog;
    base = fullCatalog ? TODAS : new Set(sistema.capabilities);
    nome = sistema.nome;
    assignableBy = sistema.assignableBy;
    defaultWorkshops = sistema.defaultWorkshops;
  } else {
    // Código que nenhum modelo conhece: nada. Falha fechada.
    fullCatalog = false;
    base = new Set();
    nome = codigo;
    assignableBy = 'subconjunto';
    defaultWorkshops = 'membro';
  }

  const acrescentadas: Capability[] = [];
  const retiradas: Capability[] = [];
  if (linha.vinculo_id) {
    for (const d of c.personalizacao.all(linha.vinculo_id) as { capability: string; effect: string }[]) {
      if (!ehCapability(d.capability)) continue;
      if (d.effect === 'grant') acrescentadas.push(d.capability);
      else if (d.effect === 'revoke') retiradas.push(d.capability);
    }
  }
  let capabilities: ReadonlySet<Capability>;
  if (fullCatalog) {
    capabilities = TODAS;
  } else {
    const conjunto = new Set<Capability>(base);
    for (const g of acrescentadas) conjunto.add(g);
    for (const r of retiradas) conjunto.delete(r);
    capabilities = conjunto;
  }

  const terminais: 'todos' | readonly string[] =
    linha.all_terminals === 0 && linha.vinculo_id
      ? (c.caixas.all(linha.vinculo_id) as { terminal_id: string }[]).map((r) => r.terminal_id)
      : 'todos';
  const regraDeBancadas: 'todas' | 'membro' =
    linha.all_workshops === 1 ? 'todas' : linha.all_workshops === 0 ? 'membro' : defaultWorkshops;

  return {
    chave,
    capabilities,
    terminais,
    regraDeBancadas,
    modelo: {
      code: codigo,
      name: nome,
      personalizado: acrescentadas.length + retiradas.length > 0,
      acrescentadas,
      retiradas,
      assignableBy,
      fullCatalog,
    },
  };
}

/**
 * O acesso efetivo a partir da linha do vínculo (a da sessão ou a de
 * `acessoDoVinculo`). Devolve `null` quando não há vínculo.
 */
export function resolverAcesso(linha: LinhaDoVinculo, userId: string, companyId: string): AcessoEfetivo | null {
  if (!linha.vinculo_id || !linha.profile_code) return null;
  const c = consultas();
  const chave = [
    linha.vinculo_id,
    linha.access_version ?? 1,
    linha.profile_code,
    linha.template_id ?? '-',
    linha.template_version ?? 0,
    linha.all_terminals ?? 1,
    linha.all_workshops ?? '-',
    CATALOG_VERSION,
  ].join(':');
  let calculado = c.cache.get(chave);
  if (!calculado) {
    calculado = calcular(c, linha, chave);
    if (c.cache.size >= LIMITE_DO_CACHE) c.cache.clear();
    c.cache.set(chave, calculado);
  }
  const bancadas: 'todas' | readonly string[] =
    calculado.regraDeBancadas === 'todas'
      ? 'todas'
      : (c.bancadas.all(userId, companyId) as { id: string }[]).map((r) => r.id);
  const carimbo = createHash('sha256')
    .update(`${calculado.chave}|${bancadas === 'todas' ? '*' : bancadas.join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return {
    vinculoId: linha.vinculo_id,
    userId,
    companyId,
    modelo: calculado.modelo,
    capabilities: calculado.capabilities,
    terminais: calculado.terminais,
    bancadas,
    carimbo,
  };
}

/**
 * O acesso de uma pessoa numa empresa, lido agora — para quem NÃO é a sessão
 * da requisição: o login (que ainda não tem sessão), a emissão do token (o
 * carimbo) e, na F2, o liberador da alçada na empresa da venda.
 */
export function acessoDoVinculo(userId: string, companyId: string): AcessoEfetivo | null {
  ensureCoreSchema();
  const linha = consultas().vinculo.get(userId, companyId) as LinhaDoVinculo | undefined;
  return linha ? resolverAcesso(linha, userId, companyId) : null;
}

/** O carimbo do acesso de agora, para o token nascer com ele. `undefined` sem vínculo. */
export function carimboDoAcesso(userId: string, companyId: string): string | undefined {
  return acessoDoVinculo(userId, companyId)?.carimbo;
}

/** O que a tela recebe em `access` (login, dispositivo, sessão e troca de empresa). */
export interface AcessoParaResposta {
  modelo: { code: string; name: string; personalizado: boolean; acrescentadas: readonly string[]; retiradas: readonly string[] };
  capabilities: string[];
  terminais: 'todos' | readonly string[];
  bancadas: 'todas' | readonly string[];
  casa: string;
  carimbo: string;
}

export function acessoParaResposta(acesso: AcessoEfetivo): AcessoParaResposta {
  return {
    modelo: {
      code: acesso.modelo.code,
      name: acesso.modelo.name,
      personalizado: acesso.modelo.personalizado,
      acrescentadas: [...acesso.modelo.acrescentadas],
      retiradas: [...acesso.modelo.retiradas],
    },
    capabilities: [...acesso.capabilities].sort(),
    terminais: acesso.terminais,
    bancadas: acesso.bancadas,
    casa: casaDe(acesso.capabilities),
    carimbo: acesso.carimbo,
  };
}

/** O nome do modelo aplicado, para `companies[].modelo`: o do banco, o do código, ou o próprio código. */
export function modeloDoCodigo(codigo: string): { code: string; name: string } {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT name FROM core_permission_templates WHERE code = ? AND archived_at IS NULL')
    .get(codigo) as { name?: string } | undefined;
  return { code: codigo, name: linha?.name ?? modeloDeSistema(codigo)?.nome ?? codigo };
}
