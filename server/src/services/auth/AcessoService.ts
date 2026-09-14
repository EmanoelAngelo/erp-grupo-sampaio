/**
 * ============================================================================
 * O ESCRITOR DO ACESSO — modelos, personalização, caixas e bancadas, com trilha
 * ============================================================================
 *
 * RBAC granular, F1 (desenho §3 e §12). Um escritor só para os quatro
 * conceitos novos — os modelos de permissão (`core_permission_templates` e as
 * capabilities de cada um), a personalização do vínculo
 * (`core_user_company_capabilities`), o escopo de caixas
 * (`core_user_company_terminals` / `all_terminals`) e o de bancadas
 * (`all_workshops`) —, e cada escrita:
 *
 *   - roda numa transação, JUNTO com a linha da trilha (`recordAudit`): falhou
 *     no meio, não fica nem a mudança nem o registro;
 *   - sobe `access_version` do vínculo (ou `version` do modelo), que é a chave
 *     do cache da sessão: a mudança vale NA REQUISIÇÃO SEGUINTE, sem novo
 *     login, e a tela recebe `X-Acesso-Em-Vigor`;
 *   - grava na trilha o antes, o depois e o diff das capabilities — nunca
 *     senha, hash, token nem segredo.
 *
 * Quem pode entregar o quê (a régua do §9, com `assignable_by`) é da F4, junto
 * com as rotas de Usuários e Modelos. Aqui mora o mecanismo; a F4 põe a porta.
 *
 * E a SEMEADURA: `ensurePermissionTemplates()` roda em `prepararBanco` a cada
 * subida e mantém os modelos de sistema sem atropelar o que o dono editou.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import {
  CAPABILITIES,
  CATALOGO,
  CATALOG_VERSION,
  MODELOS_DE_SISTEMA,
  ehCapability,
  type Capability,
} from './Capabilities.js';
import { acessoDoVinculo } from './AcessoEfetivo.js';

/** De onde veio a mudança — vai para a trilha. */
export type OrigemDaMudanca = 'tela' | 'api' | 'subida' | 'migracao';

interface LinhaDoVinculo {
  id: string;
  user_id: string;
  company_id: string;
  profile_code: string;
  access_version: number;
  all_terminals: number;
  all_workshops: number | null;
}

interface EstadoDoVinculo {
  modelo: string;
  grants: string[];
  revokes: string[];
  terminais: 'todos' | string[];
  bancadas: 'todas' | 'membro' | 'do-modelo';
}

const agora = () => new Date().toISOString();
const ordenado = (xs: Iterable<string>) => [...xs].sort();

function vinculoDe(userId: string, companyId: string): LinhaDoVinculo {
  const v = getConnection()
    .prepare(
      `SELECT id, user_id, company_id, profile_code, access_version, all_terminals, all_workshops
         FROM core_user_companies WHERE user_id = ? AND company_id = ?`,
    )
    .get(userId, companyId) as LinhaDoVinculo | undefined;
  if (!v) throw new ApiError('CORE_USER_NOT_LINKED', 'Esta pessoa não tem vínculo com esta empresa.', 404);
  return v;
}

function estadoDe(v: LinhaDoVinculo): EstadoDoVinculo {
  const db = getConnection();
  const deltas = db
    .prepare('SELECT capability, effect FROM core_user_company_capabilities WHERE user_company_id = ? ORDER BY capability')
    .all(v.id) as { capability: string; effect: string }[];
  const terminais = v.all_terminals === 0
    ? (db.prepare('SELECT terminal_id FROM core_user_company_terminals WHERE user_company_id = ? ORDER BY terminal_id').all(v.id) as { terminal_id: string }[]).map((r) => r.terminal_id)
    : 'todos' as const;
  return {
    modelo: v.profile_code,
    grants: deltas.filter((d) => d.effect === 'grant').map((d) => d.capability),
    revokes: deltas.filter((d) => d.effect === 'revoke').map((d) => d.capability),
    terminais,
    bancadas: v.all_workshops === 1 ? 'todas' : v.all_workshops === 0 ? 'membro' : 'do-modelo',
  };
}

function diffDe(antes: Iterable<string>, depois: Iterable<string>): { '+': string[]; '-': string[] } {
  const a = new Set(antes);
  const d = new Set(depois);
  return { '+': ordenado([...d].filter((x) => !a.has(x))), '-': ordenado([...a].filter((x) => !d.has(x))) };
}

function quemEOnde(userId: string, companyId: string) {
  const db = getConnection();
  const alvo = db.prepare('SELECT id, login, display_name FROM core_users WHERE id = ?').get(userId) as
    | { id: string; login: string; display_name: string }
    | undefined;
  const empresa = db.prepare('SELECT id, trade_name FROM core_companies WHERE id = ?').get(companyId) as
    | { id: string; trade_name: string }
    | undefined;
  return {
    alvo: { id: userId, login: alvo?.login ?? null, nome: alvo?.display_name ?? null },
    empresa: { id: companyId, nome: empresa?.trade_name ?? null },
  };
}

function exigirCapabilities(lista: readonly string[]): Capability[] {
  const desconhecidas = lista.filter((c) => !ehCapability(c));
  if (desconhecidas.length) {
    throw new ApiError('CORE_CAPABILITY_UNKNOWN', `Capability fora do catálogo: ${desconhecidas.join(', ')}.`, 400, { capabilities: desconhecidas });
  }
  return [...new Set(lista)] as Capability[];
}

/**
 * O esqueleto de toda mudança num vínculo: lê o antes, escreve, sobe a versão,
 * lê o depois e grava a trilha — tudo na mesma transação.
 */
function mudarVinculo(
  entrada: { atorId: string | null; userId: string; companyId: string; acao: string; origem: OrigemDaMudanca },
  escrever: (v: LinhaDoVinculo) => void,
): void {
  ensureCoreSchema();
  withTransaction(() => {
    const db = getConnection();
    const v = vinculoDe(entrada.userId, entrada.companyId);
    const antes = estadoDe(v);
    const capsAntes = acessoDoVinculo(entrada.userId, entrada.companyId)?.capabilities ?? new Set<string>();
    escrever(v);
    db.prepare('UPDATE core_user_companies SET access_version = access_version + 1, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(agora(), entrada.atorId, v.id);
    const depois = estadoDe(vinculoDe(entrada.userId, entrada.companyId));
    const capsDepois = acessoDoVinculo(entrada.userId, entrada.companyId)?.capabilities ?? new Set<string>();
    const terminais = Array.isArray(antes.terminais) && Array.isArray(depois.terminais)
      ? diffDe(antes.terminais, depois.terminais)
      : antes.terminais === depois.terminais ? null : { antes: antes.terminais, depois: depois.terminais };
    recordAudit({
      companyId: entrada.companyId,
      userId: entrada.atorId,
      action: entrada.acao,
      entityType: 'user',
      entityId: entrada.userId,
      detail: {
        ...quemEOnde(entrada.userId, entrada.companyId),
        antes,
        depois,
        diff: {
          capabilities: diffDe(capsAntes, capsDepois),
          terminais,
          bancadas: antes.bancadas === depois.bancadas ? null : { antes: antes.bancadas, depois: depois.bancadas },
        },
        origem: entrada.origem,
      },
    });
  });
}

/**
 * A PERSONALIZAÇÃO do vínculo: o que se acrescenta e o que se tira do modelo
 * aplicado. Substitui a personalização inteira (listas vazias = sem
 * personalização). Delta, e não cópia: quem edita o modelo muda todos os que
 * o usam, e o personalizado conserva só a sua diferença.
 */
export function personalizarVinculo(entrada: {
  atorId: string | null;
  userId: string;
  companyId: string;
  grants?: readonly string[];
  revokes?: readonly string[];
  origem?: OrigemDaMudanca;
}): void {
  const grants = exigirCapabilities(entrada.grants ?? []);
  const revokes = exigirCapabilities(entrada.revokes ?? []);
  const nosDois = grants.filter((g) => revokes.includes(g));
  if (nosDois.length) {
    throw new ApiError('CORE_CAPABILITY_CONFLICT', `A mesma capability não pode ser acrescentada e retirada: ${nosDois.join(', ')}.`, 400);
  }
  mudarVinculo(
    { atorId: entrada.atorId, userId: entrada.userId, companyId: entrada.companyId, acao: 'access.capabilities_customized', origem: entrada.origem ?? 'api' },
    (v) => {
      const db = getConnection();
      db.prepare('DELETE FROM core_user_company_capabilities WHERE user_company_id = ?').run(v.id);
      const inserir = db.prepare(
        `INSERT INTO core_user_company_capabilities (user_company_id, capability, effect, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const g of grants) inserir.run(v.id, g, 'grant', entrada.atorId, agora());
      for (const r of revokes) inserir.run(v.id, r, 'revoke', entrada.atorId, agora());
    },
  );
}

/** Aplica um MODELO inteiro no vínculo (`profile_code` = o código do modelo). */
export function aplicarModeloNoVinculo(entrada: {
  atorId: string | null;
  userId: string;
  companyId: string;
  modelo: string;
  manterPersonalizacao?: boolean;
  origem?: OrigemDaMudanca;
}): void {
  ensureCoreSchema();
  const noBanco = getConnection()
    .prepare('SELECT id FROM core_permission_templates WHERE code = ? AND archived_at IS NULL')
    .get(entrada.modelo);
  if (!noBanco && !(entrada.modelo in MODELOS_DE_SISTEMA)) {
    throw new ApiError('CORE_TEMPLATE_NOT_FOUND', `O modelo "${entrada.modelo}" não existe.`, 400);
  }
  mudarVinculo(
    { atorId: entrada.atorId, userId: entrada.userId, companyId: entrada.companyId, acao: 'access.template_applied', origem: entrada.origem ?? 'api' },
    (v) => {
      const db = getConnection();
      db.prepare('UPDATE core_user_companies SET profile_code = ? WHERE id = ?').run(entrada.modelo, v.id);
      if (!entrada.manterPersonalizacao) db.prepare('DELETE FROM core_user_company_capabilities WHERE user_company_id = ?').run(v.id);
    },
  );
}

/** O escopo de caixas: `todos` (inclusive os que forem criados) ou a lista. */
export function definirTerminaisDoVinculo(entrada: {
  atorId: string | null;
  userId: string;
  companyId: string;
  terminais: 'todos' | readonly string[];
  origem?: OrigemDaMudanca;
}): void {
  ensureCoreSchema();
  if (entrada.terminais !== 'todos') {
    const existe = getConnection().prepare('SELECT id FROM core_terminals WHERE id = ? AND company_id = ?');
    const alheios = entrada.terminais.filter((t) => !existe.get(t, entrada.companyId));
    if (alheios.length) {
      throw new ApiError('CORE_TERMINAL_NOT_REGISTERED', `Caixa que não é desta empresa: ${alheios.join(', ')}.`, 400, { terminais: alheios });
    }
  }
  mudarVinculo(
    { atorId: entrada.atorId, userId: entrada.userId, companyId: entrada.companyId, acao: 'access.terminals_changed', origem: entrada.origem ?? 'api' },
    (v) => {
      const db = getConnection();
      db.prepare('DELETE FROM core_user_company_terminals WHERE user_company_id = ?').run(v.id);
      if (entrada.terminais === 'todos') {
        db.prepare('UPDATE core_user_companies SET all_terminals = 1 WHERE id = ?').run(v.id);
        return;
      }
      db.prepare('UPDATE core_user_companies SET all_terminals = 0 WHERE id = ?').run(v.id);
      const inserir = db.prepare(
        'INSERT INTO core_user_company_terminals (user_company_id, terminal_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      );
      for (const t of new Set(entrada.terminais)) inserir.run(v.id, t, entrada.atorId, agora());
    },
  );
}

/** O escopo de bancadas: todas, só as de que é membro, ou o padrão do modelo. */
export function definirBancadasDoVinculo(entrada: {
  atorId: string | null;
  userId: string;
  companyId: string;
  bancadas: 'todas' | 'membro' | 'do-modelo';
  origem?: OrigemDaMudanca;
}): void {
  const valor = entrada.bancadas === 'todas' ? 1 : entrada.bancadas === 'membro' ? 0 : null;
  mudarVinculo(
    { atorId: entrada.atorId, userId: entrada.userId, companyId: entrada.companyId, acao: 'access.workshops_changed', origem: entrada.origem ?? 'api' },
    (v) => {
      getConnection().prepare('UPDATE core_user_companies SET all_workshops = ? WHERE id = ?').run(valor, v.id);
    },
  );
}

// ---------------------------------------------------------------------------
// Os modelos
// ---------------------------------------------------------------------------

interface LinhaDoModelo {
  id: string;
  code: string;
  name: string;
  description: string | null;
  origin: string;
  full_catalog: number;
  assignable_by: string;
  default_workshops: string;
  hidden: number;
  owner_edited: number;
  seeded_catalog_version: number | null;
  version: number;
}

function modeloDoBanco(codigo: string): LinhaDoModelo | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_permission_templates WHERE code = ? AND archived_at IS NULL')
    .get(codigo) as LinhaDoModelo | undefined;
}

function capsDoModelo(templateId: string): Set<string> {
  return new Set(
    (getConnection()
      .prepare('SELECT capability FROM core_permission_template_capabilities WHERE template_id = ?')
      .all(templateId) as { capability: string }[]).map((r) => r.capability),
  );
}

function gravarCapsDoModelo(templateId: string, capabilities: Iterable<string>): void {
  const db = getConnection();
  db.prepare('DELETE FROM core_permission_template_capabilities WHERE template_id = ?').run(templateId);
  const inserir = db.prepare('INSERT INTO core_permission_template_capabilities (template_id, capability) VALUES (?, ?)');
  for (const c of new Set(capabilities)) inserir.run(templateId, c);
}

/**
 * O dono edita as capabilities de um modelo. Vale para todos os que o usam na
 * requisição seguinte (a versão do modelo é chave do cache). Modelo de
 * sistema editado fica marcado: a subida não o sobrescreve mais.
 */
export function editarModelo(entrada: {
  atorId: string | null;
  codigo: string;
  capabilities: readonly string[];
  origem?: OrigemDaMudanca;
}): void {
  ensureCoreSchema();
  const capabilities = exigirCapabilities(entrada.capabilities);
  withTransaction(() => {
    const m = modeloDoBanco(entrada.codigo);
    if (!m) throw new ApiError('CORE_TEMPLATE_NOT_FOUND', `O modelo "${entrada.codigo}" não existe.`, 404);
    if (m.full_catalog === 1) {
      throw new ApiError(
        'CORE_TEMPLATE_LOCKED',
        `"${m.name}" tem sempre o catálogo inteiro: este modelo não se edita.`,
        409,
      );
    }
    const antes = capsDoModelo(m.id);
    gravarCapsDoModelo(m.id, capabilities);
    getConnection()
      .prepare('UPDATE core_permission_templates SET version = version + 1, owner_edited = 1, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(agora(), entrada.atorId, m.id);
    recordAudit({
      companyId: null,
      userId: entrada.atorId,
      action: 'template.updated',
      entityType: 'permission_template',
      entityId: m.id,
      detail: {
        modelo: m.code,
        antes: { capabilities: ordenado(antes) },
        depois: { capabilities: ordenado(capabilities) },
        diff: { capabilities: diffDe(antes, capabilities) },
        origem: entrada.origem ?? 'api',
      },
    });
  });
}

/**
 * As NOVIDADES do catálogo para um modelo: capabilities que entraram depois da
 * versão em que ele foi semeado, com padrão neste modelo, e que ele não tem.
 * A tela de Modelos mostra "N novidades: [Aplicar] [Ignorar]" (F4).
 */
export function novidadesDoModelo(codigo: string): Capability[] {
  ensureCoreSchema();
  const m = modeloDoBanco(codigo);
  if (!m) return [];
  const tem = capsDoModelo(m.id);
  const semeadoEm = m.seeded_catalog_version ?? 0;
  return CATALOGO.filter((c) => c.desde > semeadoEm && (c.modelosPadrao as readonly string[]).includes(codigo) && !tem.has(c.code)).map((c) => c.code);
}

export interface ResultadoDaSemeadura {
  /** Modelos de sistema que nasceram agora. */
  inseridos: string[];
  /** Modelos de sistema não editados que voltaram a bater com o código (ou o catálogo inteiro). */
  sincronizados: string[];
  /** Modelos de sistema editados pelo dono: não tocados. */
  preservados: string[];
  /** Linhas com capability que saiu do catálogo, apagadas (modelos + vínculos). */
  capabilitiesRemovidas: number;
}

/**
 * A SEMEADURA, a cada subida (`prepararBanco`) — desenho §3.2.
 *
 *   1. capability que saiu do catálogo sai de todo modelo (inclusive do dono) e
 *      de todo vínculo, com trilha;
 *   2. para cada modelo de sistema:
 *      - não existe → nasce com as capabilities do código;
 *      - catálogo inteiro → forçado ao catálogo inteiro, SEMPRE;
 *      - existe e o dono não editou → acompanha o código (capability nova
 *        chega a toda instalação), sobe a versão e registra o que mudou;
 *      - existe e o dono editou → não é tocado (as novidades ficam oferecidas).
 *   Modelo do dono (`origin = 'dono'`) nunca é sincronizado.
 *
 * Idempotente: sem mudança, nenhuma escrita e nenhuma trilha.
 */
export function ensurePermissionTemplates(): ResultadoDaSemeadura {
  ensureCoreSchema();
  const resultado: ResultadoDaSemeadura = { inseridos: [], sincronizados: [], preservados: [], capabilitiesRemovidas: 0 };
  withTransaction(() => {
    const db = getConnection();
    const catalogo = new Set<string>(CAPABILITIES);

    // 1. O que saiu do catálogo.
    const mortasEmModelos = (db
      .prepare(
        `SELECT t.id, t.code, tc.capability FROM core_permission_template_capabilities tc
           JOIN core_permission_templates t ON t.id = tc.template_id
          ORDER BY t.code, tc.capability`,
      )
      .all() as { id: string; code: string; capability: string }[]).filter((r) => !catalogo.has(r.capability));
    const porModelo = new Map<string, { code: string; removidas: string[] }>();
    for (const r of mortasEmModelos) {
      const g = porModelo.get(r.id) ?? { code: r.code, removidas: [] };
      g.removidas.push(r.capability);
      porModelo.set(r.id, g);
    }
    const apagarDoModelo = db.prepare('DELETE FROM core_permission_template_capabilities WHERE template_id = ? AND capability = ?');
    for (const [id, g] of porModelo) {
      for (const c of g.removidas) apagarDoModelo.run(id, c);
      resultado.capabilitiesRemovidas += g.removidas.length;
      recordAudit({
        companyId: null, userId: null, action: 'template.capability_removed', entityType: 'permission_template', entityId: id,
        detail: { modelo: g.code, removidas: g.removidas, origem: 'subida' },
      });
    }
    const mortasEmVinculos = (db
      .prepare(
        `SELECT ucc.user_company_id, ucc.capability, uc.user_id, uc.company_id
           FROM core_user_company_capabilities ucc
           JOIN core_user_companies uc ON uc.id = ucc.user_company_id
          ORDER BY ucc.user_company_id, ucc.capability`,
      )
      .all() as { user_company_id: string; capability: string; user_id: string; company_id: string }[]).filter((r) => !catalogo.has(r.capability));
    const porVinculo = new Map<string, { userId: string; companyId: string; removidas: string[] }>();
    for (const r of mortasEmVinculos) {
      const g = porVinculo.get(r.user_company_id) ?? { userId: r.user_id, companyId: r.company_id, removidas: [] };
      g.removidas.push(r.capability);
      porVinculo.set(r.user_company_id, g);
    }
    const apagarDoVinculo = db.prepare('DELETE FROM core_user_company_capabilities WHERE user_company_id = ? AND capability = ?');
    for (const [id, g] of porVinculo) {
      for (const c of g.removidas) apagarDoVinculo.run(id, c);
      resultado.capabilitiesRemovidas += g.removidas.length;
      recordAudit({
        companyId: g.companyId, userId: null, action: 'access.capability_removed', entityType: 'user', entityId: g.userId,
        detail: { vinculo: id, removidas: g.removidas, origem: 'subida' },
      });
    }

    // 2. Os modelos de sistema.
    for (const m of Object.values(MODELOS_DE_SISTEMA)) {
      const doCodigo = new Set<string>(m.fullCatalog ? CAPABILITIES : m.capabilities);
      const linha = db.prepare('SELECT * FROM core_permission_templates WHERE code = ?').get(m.code) as LinhaDoModelo | undefined;
      if (!linha) {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO core_permission_templates
             (id, code, name, description, origin, full_catalog, assignable_by, default_workshops, hidden,
              owner_edited, seeded_catalog_version, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'sistema', ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
        ).run(id, m.code, m.nome, m.descricao, m.fullCatalog ? 1 : 0, m.assignableBy, m.defaultWorkshops, m.hidden ? 1 : 0,
          CATALOG_VERSION, agora(), agora());
        gravarCapsDoModelo(id, doCodigo);
        recordAudit({
          companyId: null, userId: null, action: 'template.seeded', entityType: 'permission_template', entityId: id,
          detail: { modelo: m.code, capabilities: doCodigo.size, origem: 'sistema' },
        });
        resultado.inseridos.push(m.code);
        continue;
      }
      if (linha.origin !== 'sistema') continue;
      const forcarCatalogo = linha.full_catalog === 1 || m.fullCatalog;
      if (linha.owner_edited === 1 && !forcarCatalogo) {
        resultado.preservados.push(m.code);
        continue;
      }
      const tem = capsDoModelo(linha.id);
      const diff = diffDe(tem, doCodigo);
      const atributos: string[] = [];
      if (linha.name !== m.nome) atributos.push('nome');
      if ((linha.description ?? '') !== m.descricao) atributos.push('descricao');
      if (linha.full_catalog !== (m.fullCatalog ? 1 : 0)) atributos.push('full_catalog');
      if (linha.assignable_by !== m.assignableBy) atributos.push('assignable_by');
      if (linha.default_workshops !== m.defaultWorkshops) atributos.push('default_workshops');
      if (linha.hidden !== (m.hidden ? 1 : 0)) atributos.push('hidden');
      const semeadoAtras = (linha.seeded_catalog_version ?? 0) < CATALOG_VERSION;
      if (diff['+'].length === 0 && diff['-'].length === 0 && atributos.length === 0) {
        if (semeadoAtras) {
          db.prepare('UPDATE core_permission_templates SET seeded_catalog_version = ? WHERE id = ?').run(CATALOG_VERSION, linha.id);
        }
        continue;
      }
      if (diff['+'].length || diff['-'].length) gravarCapsDoModelo(linha.id, doCodigo);
      db.prepare(
        `UPDATE core_permission_templates
            SET name = ?, description = ?, full_catalog = ?, assignable_by = ?, default_workshops = ?, hidden = ?,
                seeded_catalog_version = ?, version = version + 1, updated_at = ?
          WHERE id = ?`,
      ).run(m.nome, m.descricao, m.fullCatalog ? 1 : 0, m.assignableBy, m.defaultWorkshops, m.hidden ? 1 : 0,
        CATALOG_VERSION, agora(), linha.id);
      recordAudit({
        companyId: null, userId: null, action: 'template.system_synced', entityType: 'permission_template', entityId: linha.id,
        detail: { modelo: m.code, adicionadas: diff['+'], removidas: diff['-'], atributos, origem: 'subida' },
      });
      resultado.sincronizados.push(m.code);
    }
  });
  return resultado;
}
