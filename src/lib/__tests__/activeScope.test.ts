/**
 * A operação ativa não muda sozinha.
 *
 * Num E2E, uma vez, PJ Motors virou Me Mimei sem ninguém escolher. Não foi
 * possível reproduzir — e é por isso que estes testes existem: eles não
 * reproduzem o caso, eles fecham os caminhos por onde ele poderia acontecer.
 *
 * O que se cobra aqui é a REGRA, não um sintoma: renovar token, restaurar
 * sessão e navegar não podem trocar de empresa. Só login e escolha explícita
 * podem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScopeViolationError,
  assertScopeChange,
  assertScopeMatchesToken,
  clearScopeJournal,
  scopeFromToken,
  scopeJournal,
  type ActiveScope,
} from '../activeScope';

const PJ_MOTORS = 'd872b5bb-85c5-4bd9-8e10-385f7a740583';
const ME_MIMEI = '399eceb2-362e-4c32-b69d-c7e47a1f8751';
const PRECO_JUSTO = '9348ff15-b188-45f7-a6c1-2a29094375cd';
const USUARIO = '4e7663c8-6b32-4ec2-8de3-f1ce8b2fb0ac';

/** Token de mentira com payload de verdade — é só o payload que se lê aqui. */
function token(companyId: string, storeId?: string): string {
  const payload = { sub: USUARIO, companyId, storeId };
  const base64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_');
  return `cabecalho.${base64}.assinatura`;
}

function escopo(companyId: string | null, unitId: string | null = null): ActiveScope {
  return { userId: USUARIO, companyId, unitId, pdvId: null, workshopId: null };
}

beforeEach(() => {
  clearScopeJournal();
});

describe('leitura do escopo no token', () => {
  it('lê empresa e unidade do payload', () => {
    expect(scopeFromToken(token(PJ_MOTORS, 'terminal-1'))).toEqual({
      userId: USUARIO,
      companyId: PJ_MOTORS,
      unitId: 'terminal-1',
    });
  });

  it('token ilegível não derruba nada — a requisição seguinte recebe 401', () => {
    expect(scopeFromToken('isto-nao-e-um-token')).toEqual({
      userId: null,
      companyId: null,
      unitId: null,
    });
    expect(scopeFromToken(null)).toEqual({ userId: null, companyId: null, unitId: null });
  });
});

describe('quem pode trocar de operação', () => {
  it.each(['LOGIN', 'DEVICE_LOGIN', 'EXPLICIT_OPERATION_CHANGE'] as const)(
    '%s pode',
    (reason) => {
      expect(() =>
        assertScopeChange({
          previous: escopo(PJ_MOTORS),
          next: escopo(ME_MIMEI),
          reason,
          source: 'teste',
        }),
      ).not.toThrow();
    },
  );

  it('renovação de token NÃO pode — é o caminho que roda sozinho', () => {
    expect(() =>
      assertScopeChange({
        previous: escopo(PJ_MOTORS),
        next: escopo(ME_MIMEI),
        reason: 'TOKEN_REFRESH',
        source: 'client.refreshSession',
      }),
    ).toThrow(ScopeViolationError);
  });

  it('restauração de sessão NÃO pode', () => {
    expect(() =>
      assertScopeChange({
        previous: escopo(PRECO_JUSTO),
        next: escopo(ME_MIMEI),
        reason: 'SESSION_RESTORE_VALIDATED',
        source: 'client.restaurarSessao',
      }),
    ).toThrow(ScopeViolationError);
  });

  it('renovar mantendo a mesma operação é o caminho normal', () => {
    expect(() =>
      assertScopeChange({
        previous: escopo(PJ_MOTORS),
        next: escopo(PJ_MOTORS),
        reason: 'TOKEN_REFRESH',
        source: 'client.refreshSession',
      }),
    ).not.toThrow();
  });

  it('a recusa diz de onde veio e para onde ia', () => {
    try {
      assertScopeChange({
        previous: escopo(PJ_MOTORS),
        next: escopo(ME_MIMEI),
        reason: 'TOKEN_REFRESH',
        source: 'client.refreshSession',
      });
      expect.unreachable('deveria ter recusado');
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeViolationError);
      const violacao = err as ScopeViolationError;
      expect(violacao.previousCompanyId).toBe(PJ_MOTORS);
      expect(violacao.newCompanyId).toBe(ME_MIMEI);
      expect(violacao.message).toContain('ação explícita');
    }
  });
});

describe('tela e token dizem a mesma coisa', () => {
  it('operação exibida diferente da do token é recusada', () => {
    // Era exatamente isto que o `target ?? current.company` produzia: token de
    // uma empresa, nome de outra na tela.
    expect(() =>
      assertScopeMatchesToken({
        companyId: PJ_MOTORS,
        accessToken: token(ME_MIMEI),
        source: 'teste',
      }),
    ).toThrow(ScopeViolationError);
  });

  it('iguais passam', () => {
    expect(() =>
      assertScopeMatchesToken({
        companyId: PJ_MOTORS,
        accessToken: token(PJ_MOTORS),
        source: 'teste',
      }),
    ).not.toThrow();
  });
});

describe('diário de transições', () => {
  it('registra o antes, o depois, o motivo e a origem', () => {
    assertScopeChange({
      previous: escopo(PJ_MOTORS, 'terminal-1'),
      next: escopo(ME_MIMEI, 'terminal-2'),
      reason: 'EXPLICIT_OPERATION_CHANGE',
      source: 'AppShell.handleSwitch',
    });

    const [entrada] = scopeJournal();

    expect(entrada).toMatchObject({
      previousCompanyId: PJ_MOTORS,
      newCompanyId: ME_MIMEI,
      previousUnitId: 'terminal-1',
      newUnitId: 'terminal-2',
      reason: 'EXPLICIT_OPERATION_CHANGE',
      source: 'AppShell.handleSwitch',
      userId: USUARIO,
    });
  });

  it('registra também a transição RECUSADA — senão o rastro some junto', () => {
    expect(() =>
      assertScopeChange({
        previous: escopo(PJ_MOTORS),
        next: escopo(ME_MIMEI),
        reason: 'TOKEN_REFRESH',
        source: 'client.refreshSession',
      }),
    ).toThrow();

    expect(scopeJournal()).toHaveLength(1);
    expect(scopeJournal()[0].reason).toBe('TOKEN_REFRESH');
  });

  it('nunca guarda token, senha ou credencial', () => {
    assertScopeChange({
      previous: escopo(PJ_MOTORS),
      next: escopo(PJ_MOTORS),
      reason: 'TOKEN_REFRESH',
      source: 'client.refreshSession',
    });

    const serializado = JSON.stringify(scopeJournal());

    for (const proibido of ['accessToken', 'refreshToken', 'password', 'Authorization']) {
      expect(serializado).not.toContain(proibido);
    }
  });
});

/**
 * Os cenários pedidos, no nível em que eles realmente acontecem: a sessão
 * guardada. Navegar entre rotas não passa por `setSession` — e é isso que
 * estes testes fixam.
 */
describe('a sessão sobrevive à navegação', () => {
  let cliente: typeof import('../api/client');

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    cliente = await import('../api/client');
  });

  afterEach(() => {
    localStorage.clear();
  });

  function guardar(companyId: string, tradeName: string) {
    localStorage.setItem(
      'gs.session',
      JSON.stringify({
        accessToken: token(companyId),
        refreshToken: 'r-1',
        expiresAt: Date.now() + 3_600_000,
        user: { id: USUARIO, login: 'ADMIN', displayName: 'Admin', profileCode: 'admin_geral' },
        company: { id: companyId, slug: tradeName.toLowerCase(), tradeName, kind: 'retail' },
        companies: [
          { id: ME_MIMEI, slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail', profileCode: 'admin_geral' },
          { id: PJ_MOTORS, slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail', profileCode: 'admin_geral' },
          { id: PRECO_JUSTO, slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'admin_geral' },
        ],
      }),
    );
  }

  it('PJ Motors continua PJ Motors depois de recarregar', () => {
    guardar(PJ_MOTORS, 'PJ Motors');

    expect(cliente.getSession()?.company.id).toBe(PJ_MOTORS);
  });

  it('ler a sessão várias vezes — trocar de rota — não muda de operação', () => {
    guardar(PJ_MOTORS, 'PJ Motors');

    // Cada tela chama `getSession` ao montar. Cem telas, mesma operação.
    for (let i = 0; i < 100; i += 1) expect(cliente.getSession()?.company.id).toBe(PJ_MOTORS);
  });

  it('Me Mimei continua Me Mimei', () => {
    guardar(ME_MIMEI, 'Me Mimei');

    expect(cliente.getSession()?.company.id).toBe(ME_MIMEI);
  });

  it('Preço Justo sobrevive ao restore', () => {
    guardar(PRECO_JUSTO, 'Preço Justo');

    expect(cliente.getSession()?.company.slug).toBe('preço justo');
  });

  it('sessão adulterada — empresa exibida ≠ empresa do token — é descartada', () => {
    guardar(PJ_MOTORS, 'PJ Motors');
    const bruta = JSON.parse(localStorage.getItem('gs.session')!) as Record<string, unknown>;
    bruta.company = { id: ME_MIMEI, slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail' };
    localStorage.setItem('gs.session', JSON.stringify(bruta));

    // Nem PJ Motors nem Me Mimei: escolher por conta própria seria adivinhar.
    expect(cliente.getSession()).toBeNull();
    expect(localStorage.getItem('gs.session')).toBeNull();
  });

  it('trocar para a operação em que já se está não emite token novo', async () => {
    guardar(PJ_MOTORS, 'PJ Motors');
    cliente.getSession();
    const chamadas = vi.spyOn(globalThis, 'fetch');

    await cliente.switchCompany(PJ_MOTORS);

    // Nem uma requisição: trocar para onde já se está não é troca.
    expect(chamadas).not.toHaveBeenCalled();
    expect(cliente.getSession()?.company.id).toBe(PJ_MOTORS);
    chamadas.mockRestore();
  });

  it('trocar para operação fora dos vínculos é recusado, e a atual permanece', async () => {
    guardar(PJ_MOTORS, 'PJ Motors');
    cliente.getSession();

    await expect(cliente.switchCompany('empresa-que-nao-e-desta-sessao')).rejects.toMatchObject({
      code: 'API_TENANT_UNKNOWN',
    });
    expect(cliente.getSession()?.company.id).toBe(PJ_MOTORS);
  });

  it('a troca ADOTA o perfil do vínculo de destino — não carrega o antigo', async () => {
    /*
      O defeito da rodada 48: `{...current, company: target}` levava o token
      novo e a empresa nova, mas o `user.profileCode` continuava o da empresa
      ANTERIOR. O servidor já emitia o token certo (perfil do vínculo de
      destino); era só a cópia guardada que mentia — e é ela que o menu e os
      guardas de tela leem (`menuPorPerfil.test.tsx` prova que o menu segue
      `session.user.profileCode`; este caso fecha o elo que faltava).

      Gestor na PJ Motors, mecânico na Me Mimei: depois da troca, a sessão
      tem de dizer mecânico.
    */
    guardar(PJ_MOTORS, 'PJ Motors');
    const bruta = JSON.parse(localStorage.getItem('gs.session')!) as {
      user: { profileCode: string };
      companies: { id: string; profileCode: string }[];
    };
    bruta.user.profileCode = 'gestor';
    for (const c of bruta.companies) {
      c.profileCode = c.id === ME_MIMEI ? 'mecanico' : 'gestor';
    }
    localStorage.setItem('gs.session', JSON.stringify(bruta));
    cliente.getSession();

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: token(ME_MIMEI), refreshToken: 'r-2', expiresIn: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const depois = await cliente.switchCompany(ME_MIMEI);

    expect(depois?.company.id).toBe(ME_MIMEI);
    expect(depois?.user.profileCode).toBe('mecanico');
    expect(cliente.getSession()?.user.profileCode).toBe('mecanico');
    fetchMock.mockRestore();
  });
});
