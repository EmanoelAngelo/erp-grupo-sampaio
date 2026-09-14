/**
 * ============================================================================
 * ACESSO DOS USUÁRIOS — o que a tela de Usuários precisa para montar, por
 * pessoa, as EMPRESAS, os PDVs (caixas) e as PÁGINAS/MÓDULOS permitidos
 * ============================================================================
 *
 * Escopo reduzido da entrega: reaproveita o que o RBAC granular (F1) já tem —
 * modelos de sistema (Capabilities.ts), personalização do vínculo, escopo de
 * caixas e a trilha de auditoria com antes/depois (AcessoService) — e não cria
 * um segundo sistema. A autorização de cada rota continua no servidor: a ponte
 * (PonteDaRota.ts) faz as guardas de hoje aceitarem a capability da rota.
 *
 * Quem mexe no acesso de quem:
 *   - precisa de `users.manage` EM CADA empresa em que mexe;
 *   - só entrega capability que ele mesmo tem naquela empresa;
 *   - modelo de dono do grupo (Administrador/Gestor do grupo) só quem tem
 *     `group.admin` entrega;
 *   - ninguém edita o próprio acesso (é a porta para se trancar para fora — ou
 *     se promover).
 */
import { Router } from 'express';
import { authMiddleware, type AuthedRequest } from '../../middleware/auth.js';
import { withTransaction } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import {
  CATALOGO,
  MODELOS_DE_SISTEMA,
  ehCapability,
  modeloDeSistema,
  type Capability,
} from '../../services/auth/Capabilities.js';
import { acessoDoVinculo, type AcessoEfetivo } from '../../services/auth/AcessoEfetivo.js';
import {
  aplicarModeloNoVinculo,
  definirTerminaisDoVinculo,
  personalizarVinculo,
} from '../../services/auth/AcessoService.js';
import { can, requireAnyCapability, requireCapability } from '../../services/auth/Autorizacao.js';
import { findUserById, linkUserToCompany, listCompanies } from '../../services/auth/IdentityService.js';
import { listTerminals } from '../../services/core/TerminalService.js';
import { removerDaOperacao } from '../../services/core/TeamService.js';

export const acessoRouter = Router();
acessoRouter.use(authMiddleware);

/** As capabilities de um modelo de sistema (o catálogo inteiro para os de dono). */
function capabilitiesDoModelo(codigo: string): ReadonlySet<Capability> {
  const modelo = modeloDeSistema(codigo);
  if (!modelo) throw new ApiError('CORE_TEMPLATE_NOT_FOUND', `O modelo "${codigo}" não existe.`, 400);
  return new Set(modelo.fullCatalog ? CATALOGO.map((c) => c.code) : modelo.capabilities);
}

function acessoDoAtor(req: AuthedRequest, companyId: string): AcessoEfetivo | null {
  return companyId === req.auth!.companyId && req.auth!.acesso ? req.auth!.acesso : acessoDoVinculo(req.auth!.sub, companyId);
}

function podeGerirUsuariosEm(req: AuthedRequest, companyId: string): boolean {
  return can(acessoDoAtor(req, companyId), 'users.manage');
}

/** O retrato do acesso de uma pessoa em todas as empresas ativas, como a tela usa. */
function retratoDoUsuario(req: AuthedRequest, userId: string) {
  const usuario = findUserById(userId);
  if (!usuario) throw new ApiError('CORE_USER_NOT_FOUND', 'Usuário não encontrado.', 404);
  const empresas = listCompanies().map((c) => {
    const acesso = acessoDoVinculo(userId, c.id);
    return {
      companyId: c.id,
      slug: c.slug,
      tradeName: c.trade_name,
      vinculado: Boolean(acesso),
      modelo: acesso ? { code: acesso.modelo.code, name: acesso.modelo.name, personalizado: acesso.modelo.personalizado } : null,
      capabilities: acesso ? [...acesso.capabilities].sort() : [],
      terminais: acesso ? acesso.terminais : 'todos',
      caixas: listTerminals(c.id, { somenteAtivos: true }).map((t) => ({ id: t.id, nome: t.name, codigo: t.code })),
      podeEditar: podeGerirUsuariosEm(req, c.id),
    };
  });
  // Privacidade: quem não administra o grupo só enxerga quem está numa empresa que ele gere.
  const administraOGrupo = can(req.auth!.acesso, 'group.admin');
  if (!administraOGrupo && !empresas.some((e) => e.vinculado && e.podeEditar)) {
    throw new ApiError('CORE_USER_NOT_FOUND', 'Usuário não encontrado.', 404);
  }
  return {
    usuario: {
      id: usuario.id,
      login: usuario.login,
      displayName: usuario.display_name,
      active: usuario.active === 1,
    },
    empresas,
  };
}

/**
 * O catálogo em forma de tela: as páginas/módulos agrupados por área e os
 * modelos prontos (atalhos de cenário e perfis de hoje), para o editor aplicar.
 */
acessoRouter.get('/catalogo', (req: AuthedRequest, res, next) => {
  try {
    requireAnyCapability(req, 'users.manage', 'users.view');
    const areas = new Map<string, { code: string; rotulo: string; pagina: string; escopo: string }[]>();
    for (const item of CATALOGO) {
      if (!areas.has(item.area)) areas.set(item.area, []);
      areas.get(item.area)!.push({ code: item.code, rotulo: item.rotulo, pagina: item.pagina, escopo: item.escopo });
    }
    const modelos = Object.values(MODELOS_DE_SISTEMA)
      .filter((m) => !m.hidden)
      .map((m) => ({
        code: m.code,
        nome: m.nome,
        descricao: m.descricao,
        doGrupo: m.assignableBy === 'grupo',
        atalho: m.atalho,
        capabilities: [...capabilitiesDoModelo(m.code)].sort(),
      }));
    res.json({ areas: [...areas].map(([area, capabilities]) => ({ area, capabilities })), modelos });
  } catch (err) {
    next(err);
  }
});

acessoRouter.get('/usuarios/:userId', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'users.manage');
    res.json(retratoDoUsuario(req, String(req.params.userId)));
  } catch (err) {
    next(err);
  }
});

type EntradaDaEmpresa = {
  companyId?: unknown;
  vinculado?: unknown;
  modelo?: unknown;
  capabilities?: unknown;
  terminais?: unknown;
};

acessoRouter.put('/usuarios/:userId', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'users.manage');
    const userId = String(req.params.userId);
    const atorId = req.auth!.sub;
    if (userId === atorId) {
      throw new ApiError(
        'CORE_CANNOT_EDIT_OWN_ACCESS',
        'Você não pode mudar o seu próprio acesso. Peça a outra pessoa que administra os usuários.',
        400,
      );
    }
    if (!findUserById(userId)) throw new ApiError('CORE_USER_NOT_FOUND', 'Usuário não encontrado.', 404);
    const entradas = Array.isArray(req.body?.empresas) ? (req.body.empresas as EntradaDaEmpresa[]) : null;
    if (!entradas || entradas.length === 0) {
      throw new ApiError('CORE_ACCESS_INVALID', 'Informe as empresas e o acesso em cada uma.', 400);
    }
    const empresasAtivas = new Set(listCompanies().map((c) => c.id));

    withTransaction(() => {
      for (const e of entradas) {
        const companyId = String(e.companyId ?? '');
        if (!empresasAtivas.has(companyId)) {
          throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404, { companyId });
        }
        const doAtor = acessoDoAtor(req, companyId);
        if (!can(doAtor, 'users.manage')) {
          throw new ApiError(
            'API_PERMISSION_DENIED',
            'Você não administra os usuários desta empresa.',
            403,
            { companyId, capabilities: ['users.manage'] },
          );
        }
        const vinculoDeAgora = acessoDoVinculo(userId, companyId);

        if (e.vinculado !== true) {
          if (vinculoDeAgora) {
            removerDaOperacao({ companyId, userId, actorId: atorId, perfisDeQuemAge: [doAtor!.modelo.code] });
          }
          continue;
        }

        const modelo = String(e.modelo ?? '');
        const doModelo = capabilitiesDoModelo(modelo);
        const definicao = MODELOS_DE_SISTEMA[modelo]!;
        if (definicao.hidden) {
          throw new ApiError('CORE_TEMPLATE_NOT_FOUND', `O modelo "${modelo}" não se oferece a vínculo novo.`, 400);
        }
        if (definicao.assignableBy === 'grupo' && !can(doAtor, 'group.admin')) {
          throw new ApiError(
            'API_PERMISSION_DENIED',
            'Só quem administra o grupo entrega o modelo de dono do grupo.',
            403,
            { companyId, capabilities: ['group.admin'] },
          );
        }

        // As páginas escolhidas; sem lista, fica o modelo puro.
        let finais: Set<Capability> = new Set(doModelo);
        if (e.capabilities !== undefined) {
          if (!Array.isArray(e.capabilities) || !e.capabilities.every((c) => typeof c === 'string')) {
            throw new ApiError('CORE_ACCESS_INVALID', 'As páginas vêm como uma lista de capabilities.', 400);
          }
          const desconhecidas = (e.capabilities as string[]).filter((c) => !ehCapability(c));
          if (desconhecidas.length) {
            throw new ApiError('CORE_CAPABILITY_UNKNOWN', `Capability desconhecida: ${desconhecidas.join(', ')}.`, 400);
          }
          finais = new Set(e.capabilities as Capability[]);
        }
        const grants = [...finais].filter((c) => !doModelo.has(c));
        const revokes = [...doModelo].filter((c) => !finais.has(c));
        // Só se entrega o que se tem, na empresa onde se tem (o dono do grupo tem
        // tudo). O modelo "da gestão da empresa" é entregue por quem gere os
        // usuários dela (como hoje); o que vai ALÉM do modelo, e o modelo
        // "subconjunto" inteiro, só quem tem. Retirar é sempre permitido.
        const entregues = definicao.assignableBy === 'subconjunto' ? [...finais] : grants;
        const alheias = entregues.filter((c) => !doAtor!.capabilities.has(c));
        if (alheias.length && !doAtor!.modelo.fullCatalog) {
          throw new ApiError(
            'CORE_CAPABILITY_NOT_YOURS',
            'Você só pode liberar o que você mesmo tem nesta empresa.',
            403,
            { companyId, capabilities: alheias },
          );
        }

        if (!vinculoDeAgora) linkUserToCompany(userId, companyId, modelo);
        aplicarModeloNoVinculo({ atorId, userId, companyId, modelo, origem: 'tela' });
        personalizarVinculo({ atorId, userId, companyId, grants, revokes, origem: 'tela' });

        if (e.terminais !== undefined) {
          const terminais = e.terminais === 'todos'
            ? 'todos'
            : Array.isArray(e.terminais) && e.terminais.every((t) => typeof t === 'string')
              ? (e.terminais as string[])
              : null;
          if (terminais === null) {
            throw new ApiError('CORE_ACCESS_INVALID', 'Os caixas vêm como "todos" ou uma lista.', 400);
          }
          definirTerminaisDoVinculo({ atorId, userId, companyId, terminais, origem: 'tela' });
        }
      }
    });

    res.json(retratoDoUsuario(req, userId));
  } catch (err) {
    next(err);
  }
});
