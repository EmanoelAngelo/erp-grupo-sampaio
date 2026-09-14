/**
 * ============================================================================
 * T13 — O CATÁLOGO, OS MODELOS E A LINHA DE BASE CONTAM A MESMA COISA
 * ============================================================================
 *
 * O catálogo de capabilities (`services/auth/Capabilities.ts`) é GERADO de
 * `scripts/rbac/catalogo-final.json` e `scripts/rbac/modelos.json`. Este arquivo
 * cobra as regras que o desenho do RBAC granular (§3.3) põe sobre ele:
 *
 *   - toda capability declara os modelos de sistema em que nasce — sem padrão,
 *     ela nasceria 403 para o gerente em produção (o "235 rotas que só
 *     respondiam ao admin" de `Permissions.ts`, do outro lado);
 *   - nomes únicos e ESTÁVEIS: capability renomeada some dos modelos e dos
 *     vínculos na subida, e quem a tinha perde o acesso;
 *   - toda capability usada (na linha de base, na tradução de
 *     `requirePermission`, nas casas e nas guardas novas do código) existe;
 *   - os modelos de sistema são os perfis de hoje, e os tamanhos são os que o
 *     solver derivou rota a rota.
 *
 * Como cada caso cai: editar `Capabilities.ts` à mão (sem regenerar) derruba o
 * caso do arquivo gerado; renomear um código derruba o congelado; tirar o
 * padrão de uma capability derruba o de nascimento; escrever
 * `requireCapability(req, 'produtos.ver')` numa rota derruba o das guardas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  CAPABILITIES,
  CASAS,
  CASA_SEM_ACESSO,
  CATALOGO,
  CATALOG_VERSION,
  MODELOS_DE_SISTEMA,
  capabilitiesDaExpressao,
  casaDe,
  ehCapability,
  expressaoDoTexto,
  passaNaExpressao,
} from '../../src/services/auth/Capabilities.js';
import { PERMISSAO_PARA_CAPABILITY } from '../../src/services/auth/TraducaoDePermissoes.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '../../..');
const lerJson = <T>(rel: string): T => JSON.parse(readFileSync(join(RAIZ, rel), 'utf8')) as T;

interface CapabilityDoJson {
  code: string;
  area: string;
  pagina: string;
  label: string;
  descricao: string;
  escopo: string;
  leitura_ou_escrita: string;
  desde: number;
  modelos_padrao: string[];
}
interface ModeloDoJson {
  code: string;
  nome: string;
  full_catalog: number;
  assignable_by: string;
  default_workshops: string;
  hidden: number;
  capabilities: string[];
}

const catalogoJson = lerJson<{ catalog_version: number; capabilities: CapabilityDoJson[] }>('scripts/rbac/catalogo-final.json');
const modelosJson = lerJson<{
  modelos_de_sistema: Record<string, ModeloDoJson>;
  modelos_de_atalho: Record<string, ModeloDoJson>;
}>('scripts/rbac/modelos.json');
const linhaDeBase = lerJson<{ rotas: Record<string, { perfis: string[] | 'PUBLICA'; capability: string }> }>(
  'server/tests/rbac/linha-de-base.json',
);

/** Os onze perfis de hoje: os modelos de sistema com o MESMO código. */
const PERFIS_DE_HOJE = [
  'admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador',
];
const ATALHOS = [
  'somente_pdv', 'pdv_painel', 'estoque', 'financeiro_relatorios', 'tecnico_oficina', 'oficina_consulta', 'gerente_operacao_loja',
];

const capsDe = (modelo: string) => new Set<string>(MODELOS_DE_SISTEMA[modelo]!.capabilities);

describe('o catálogo', () => {
  it('141 capabilities na versão 1, com nomes únicos e no formato area.recurso.acao', () => {
    expect(CATALOG_VERSION).toBe(1);
    expect(CATALOGO).toHaveLength(141);
    expect(new Set(CAPABILITIES).size).toBe(CATALOGO.length);
    const malFormados = CAPABILITIES.filter((c) => !/^[a-z_]+(\.[a-z_]+)+$/.test(c));
    expect(malFormados).toEqual([]);
  });

  it('os nomes da versão publicada são os congelados — nome publicado não muda', () => {
    const congelado = lerJson<{ catalog_version: number; codigos: string[] }>(
      `server/tests/rbac/catalogo-v${CATALOG_VERSION}.json`,
    );
    expect(congelado.catalog_version).toBe(CATALOG_VERSION);
    // Capability nova sobe CATALOG_VERSION e ganha um arquivo novo; renomear
    // ou tirar uma sem subir a versão é o que este caso recusa.
    expect([...CAPABILITIES].sort()).toEqual(congelado.codigos);
  });

  it('toda capability declara os modelos em que nasce — sem padrão ela nasceria 403 para todo mundo', () => {
    const semPadrao = CATALOGO.filter((c) => c.modelosPadrao.length === 0).map((c) => c.code);
    expect(semPadrao).toEqual([]);
    const padraoInexistente = CATALOGO.flatMap((c) =>
      c.modelosPadrao.filter((m) => !(m in MODELOS_DE_SISTEMA)).map((m) => `${c.code} → ${m}`));
    expect(padraoInexistente).toEqual([]);
    // E os donos nascem com tudo: capability nova que esquecesse o administrador
    // tiraria dele o que o full_catalog promete.
    const semDono = CATALOGO.filter((c) => !c.modelosPadrao.includes('admin_geral') || !c.modelosPadrao.includes('gestor'));
    expect(semDono.map((c) => c.code)).toEqual([]);
  });

  it('rótulo e descrição para a tela, escopo e tipo válidos, e nenhuma capability de uma versão futura', () => {
    for (const c of CATALOGO) {
      // "BI" é rótulo legítimo: o que se cobra é não ser vazio nem ser o código cru.
      expect(c.rotulo.trim().length, c.code).toBeGreaterThan(1);
      expect(c.rotulo, c.code).not.toBe(c.code);
      expect(c.descricao.trim().length, c.code).toBeGreaterThan(10);
      expect(c.area.trim().length, c.code).toBeGreaterThan(1);
      expect(['grupo', 'empresa', 'pdv', 'bancada'], c.code).toContain(c.escopo);
      expect(['ler', 'operar', 'gerir'], c.code).toContain(c.tipo);
      expect(c.desde, c.code).toBeGreaterThanOrEqual(1);
      expect(c.desde, c.code).toBeLessThanOrEqual(CATALOG_VERSION);
    }
  });

  it('Capabilities.ts é o catalogo-final.json — arquivo gerado, não editado à mão', () => {
    expect(catalogoJson.catalog_version).toBe(CATALOG_VERSION);
    const doJson = catalogoJson.capabilities.map((c) => ({
      code: c.code, area: c.area, pagina: c.pagina, rotulo: c.label, descricao: c.descricao,
      escopo: c.escopo, tipo: c.leitura_ou_escrita, desde: c.desde, modelosPadrao: c.modelos_padrao,
    }));
    expect(CATALOGO.map((c) => ({ ...c, modelosPadrao: [...c.modelosPadrao] }))).toEqual(doJson);
  });

  it('as capabilities de escopo pdv são as três do caixa e a do token do computador', () => {
    expect(CATALOGO.filter((c) => c.escopo === 'pdv').map((c) => c.code).sort()).toEqual(
      ['pdv.cash.operate', 'pdv.device_login', 'pdv.payment.charge', 'pdv.sell'],
    );
  });
});

describe('os modelos de sistema', () => {
  it('são os onze perfis de hoje, com o mesmo código, e os sete atalhos dos cenários', () => {
    expect(Object.keys(MODELOS_DE_SISTEMA).sort()).toEqual([...PERFIS_DE_HOJE, ...ATALHOS].sort());
    for (const p of PERFIS_DE_HOJE) expect(MODELOS_DE_SISTEMA[p]!.atalho, p).toBe(false);
    for (const a of ATALHOS) expect(MODELOS_DE_SISTEMA[a]!.atalho, a).toBe(true);
  });

  it('batem com modelos.json, atributo por atributo e capability por capability', () => {
    const doJson = { ...modelosJson.modelos_de_sistema, ...modelosJson.modelos_de_atalho };
    for (const [code, m] of Object.entries(MODELOS_DE_SISTEMA)) {
      const j = doJson[code]!;
      expect(j, code).toBeDefined();
      expect([...m.capabilities].sort(), code).toEqual([...j.capabilities].sort());
      expect(m.fullCatalog, code).toBe(j.full_catalog === 1);
      expect(m.assignableBy, code).toBe(j.assignable_by);
      expect(m.defaultWorkshops, code).toBe(j.default_workshops);
      expect(m.hidden, code).toBe(j.hidden === 1);
    }
  });

  it('o padrão declarado no catálogo e o conteúdo dos modelos contam a mesma coisa', () => {
    const divergencias: string[] = [];
    for (const [code, m] of Object.entries(MODELOS_DE_SISTEMA)) {
      const caps = new Set<string>(m.capabilities);
      for (const c of CATALOGO) {
        const declarado = c.modelosPadrao.includes(code);
        if (declarado !== caps.has(c.code)) divergencias.push(`${code} × ${c.code}: padrão ${declarado}, modelo ${caps.has(c.code)}`);
      }
    }
    expect(divergencias).toEqual([]);
  });

  it('tamanhos derivados rota a rota (plano, §0)', () => {
    const tamanhos = Object.fromEntries(PERFIS_DE_HOJE.map((p) => [p, MODELOS_DE_SISTEMA[p]!.capabilities.length]));
    // operador_caixa_loja 22 → 21: perdeu pdv.backoffice (PJ-CAIXA — o login do PDV da loja
    // opera o caixa e não administra produto, estoque nem entrada de mercadoria).
    expect(tamanhos).toEqual({
      admin_geral: 141, gestor: 141, gerente_loja: 107, gerente_oficina: 104, estoquista: 31, atendente: 35,
      operador_caixa: 14, operador_caixa_loja: 21, operador_caixa_oficina: 21, mecanico: 18, contador: 1,
    });
  });

  it('Administrador e Gestor do grupo: catálogo inteiro, entregues só pelo grupo; o gestor chama-se "Gestor do grupo"', () => {
    for (const dono of ['admin_geral', 'gestor']) {
      const m = MODELOS_DE_SISTEMA[dono]!;
      expect(m.fullCatalog).toBe(true);
      expect(m.assignableBy).toBe('grupo');
      expect([...m.capabilities].sort()).toEqual([...CAPABILITIES].sort());
    }
    expect(MODELOS_DE_SISTEMA.admin_geral!.nome).toBe('Administrador do grupo');
    expect(MODELOS_DE_SISTEMA.gestor!.nome).toBe('Gestor do grupo');
    // Ninguém mais é full_catalog: "if admin allowEverything" não existe.
    expect(Object.values(MODELOS_DE_SISTEMA).filter((m) => m.fullCatalog).map((m) => m.code).sort()).toEqual(['admin_geral', 'gestor']);
    // O contador também é entregue só pelo grupo (HierarquiaDePerfis.ts:109-111).
    expect(MODELOS_DE_SISTEMA.contador!.assignableBy).toBe('grupo');
  });

  it('só os modelos de caixa e os atalhos de PDV são titulares de token de computador — conta de dono nunca', () => {
    const titulares = Object.values(MODELOS_DE_SISTEMA).filter((m) => m.titularDeToken).map((m) => m.code).sort();
    expect(titulares).toEqual(['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'pdv_painel', 'somente_pdv']);
    // O administrador TEM pdv.device_login (catálogo inteiro) e mesmo assim não é titular.
    expect(capsDe('admin_geral').has('pdv.device_login')).toBe(true);
    expect(MODELOS_DE_SISTEMA.admin_geral!.titularDeToken).toBe(false);
  });

  it('cenário I: o gerente da loja (operação) fica na operação — sem usuários, sem BI do grupo, sem configuração fiscal', () => {
    const caps = capsDe('gerente_operacao_loja');
    for (const fora of ['users.manage', 'users.view', 'reports.bi.view', 'fiscal.config.manage', 'group.admin']) {
      expect(caps.has(fora), fora).toBe(false);
    }
    for (const dentro of ['pdv.sell', 'sales.view', 'inventory.view', 'finance.view', 'approval.discount']) {
      expect(caps.has(dentro), dentro).toBe(true);
    }
  });

  it('cenário D: "PDV + Painel" é o PDV (com a nota da venda) e o painel', () => {
    const pdv = capsDe('somente_pdv');
    const painel = capsDe('pdv_painel');
    expect(pdv.has('fiscal.sale.emit')).toBe(true);
    expect([...painel].sort()).toEqual([...pdv, 'dashboard.view'].sort());
  });

  it('bancada: o mecânico e os atalhos da oficina seguem as bancadas de que são membros; os demais, todas', () => {
    const membro = Object.values(MODELOS_DE_SISTEMA).filter((m) => m.defaultWorkshops === 'membro').map((m) => m.code).sort();
    expect(membro).toEqual(['mecanico', 'oficina_consulta', 'tecnico_oficina']);
  });

  it('só o caixa legado fica escondido de vínculo novo', () => {
    expect(Object.values(MODELOS_DE_SISTEMA).filter((m) => m.hidden).map((m) => m.code)).toEqual(['operador_caixa']);
  });
});

describe('a casa', () => {
  it('é a mesma de hoje para cada perfil (environments.ts: gestão no painel, caixas no PDV, mecânico na oficina, contador no fechamento)', () => {
    const casas = Object.fromEntries(PERFIS_DE_HOJE.map((p) => [p, casaDe(capsDe(p))]));
    expect(casas).toEqual({
      admin_geral: '/sistema/painel', gestor: '/sistema/painel', gerente_loja: '/sistema/painel',
      gerente_oficina: '/sistema/painel', estoquista: '/sistema/painel', atendente: '/sistema/painel',
      operador_caixa: '/pdv', operador_caixa_loja: '/pdv', operador_caixa_oficina: '/pdv',
      mecanico: '/sistema/oficina', contador: '/sistema/fiscal/fechamento',
    });
  });

  it('nos atalhos: estoque no estoque, financeiro no financeiro, técnico na oficina; sem nada, /sem-acesso', () => {
    expect(casaDe(capsDe('estoque'))).toBe('/sistema/estoque');
    expect(casaDe(capsDe('financeiro_relatorios'))).toBe('/sistema/financeiro');
    expect(casaDe(capsDe('tecnico_oficina'))).toBe('/sistema/oficina');
    expect(casaDe(capsDe('somente_pdv'))).toBe('/pdv');
    expect(casaDe(new Set())).toBe(CASA_SEM_ACESSO);
  });

  it('toda casa é de uma capability do catálogo', () => {
    expect(CASAS.filter((c) => !ehCapability(c.capability))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Toda capability USADA existe
// ---------------------------------------------------------------------------

/** As guardas novas e onde começa a lista de capabilities em cada uma. */
const GUARDAS_NOVAS: Record<string, number> = {
  requireCapability: 1,
  requireAnyCapability: 1,
  requireAllCapabilities: 1,
  comCapability: 0,
  comQualquerCapability: 0,
  can: 1,
};

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosTs(caminho));
    else if (nome.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

/** Os argumentos de capability das guardas novas: literal → o código; qualquer outra coisa → marcado. */
function capabilitiesNasGuardas(texto: string, nomeDoArquivo: string): string[] {
  const arquivo = ts.createSourceFile(nomeDoArquivo, texto, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const achadas: string[] = [];
  const visitar = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in GUARDAS_NOVAS) {
      const desde = GUARDAS_NOVAS[node.expression.text]!;
      for (const arg of node.arguments.slice(desde)) {
        if (ts.isStringLiteralLike(arg)) achadas.push(arg.text);
        else if (node.expression.text !== 'can') achadas.push(`(não literal em ${nomeDoArquivo}: ${arg.getText(arquivo)})`);
      }
    }
    ts.forEachChild(node, visitar);
  };
  visitar(arquivo);
  return achadas;
}

describe('toda capability usada existe no catálogo', () => {
  it('as expressões da linha de base (a coluna que a F2 escreve no lugar do guarda)', () => {
    const ruins: string[] = [];
    for (const [rota, r] of Object.entries(linhaDeBase.rotas)) {
      if (r.perfis === 'PUBLICA' || r.capability === 'SO_AUTENTICADO') continue;
      if (!expressaoDoTexto(r.capability)) ruins.push(`${rota}: ${r.capability}`);
    }
    expect(ruins).toEqual([]);
  });

  it('a tradução de requirePermission', () => {
    const ruins = Object.entries(PERMISSAO_PARA_CAPABILITY).flatMap(([rota, t]) =>
      capabilitiesDaExpressao(t.expressao).filter((c) => !ehCapability(c)).map((c) => `${rota}: ${c}`));
    expect(ruins).toEqual([]);
    expect(Object.keys(PERMISSAO_PARA_CAPABILITY).length).toBeGreaterThan(70);
  });

  it('as guardas novas no código do servidor citam só capabilities do catálogo, em literal', () => {
    const src = resolve(AQUI, '../../src');
    const ruins: string[] = [];
    for (const arquivo of arquivosTs(src)) {
      for (const c of capabilitiesNasGuardas(readFileSync(arquivo, 'utf8'), arquivo)) {
        if (!ehCapability(c)) ruins.push(c);
      }
    }
    expect(ruins).toEqual([]);
  });

  it('a varredura das guardas enxerga o que diz enxergar (falsificação)', () => {
    const exemplo = [
      "requireCapability(req, 'products.view');",
      "requireAnyCapability(req, 'customers.view', 'produtos.ver');",
      "comCapability('logistics.manage');",
      'requireCapability(req, CAP_EM_VARIAVEL);',
    ].join('\n');
    const achadas = capabilitiesNasGuardas(exemplo, 'exemplo.ts');
    expect(achadas.slice(0, 4)).toEqual(['products.view', 'customers.view', 'produtos.ver', 'logistics.manage']);
    expect(achadas[4]).toMatch(/não literal/);
    expect(achadas.filter((c) => !ehCapability(c))).toHaveLength(2);
  });

  it('a expressão lida do texto passa para quem deve', () => {
    const e = expressaoDoTexto('qualquer(customers.view, pdv.sell, workshop.orders.open)')!;
    expect(passaNaExpressao(capsDe('mecanico'), e)).toBe(true);
    expect(passaNaExpressao(capsDe('contador'), e)).toBe(false);
    expect(expressaoDoTexto('qualquer(customers.view, inventado.coisa)')).toBeNull();
    expect(passaNaExpressao(new Set(), { todas: [] })).toBe(false);
  });
});
