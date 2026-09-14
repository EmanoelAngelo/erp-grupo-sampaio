// Escreve, a partir das saídas da consolidação, os arquivos que o CÓDIGO e os
// TESTES usam — uma fonte só, e nenhum deles editado à mão:
//
//   server/src/services/auth/Capabilities.ts        ← catalogo-final.json + modelos.json
//   server/src/services/auth/TraducaoDePermissoes.ts ← mapa-final.json (as rotas de requirePermission)
//   server/tests/rbac/linha-de-base.json             ← mapa-final.json (rota → perfis de hoje)
//   server/tests/rbac/catalogo-v<N>.json             ← só quando ainda não existe: congela os nomes da versão N
//
//   node scripts/rbac/gerar-artefatos.mjs
//
// O teste `server/tests/rbac/catalogo.test.ts` confere que o arquivo gerado bate
// com o JSON; mexer à mão em Capabilities.ts derruba a suíte.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AQUI, REPO } from './_caminhos.mjs';

const ler = (f) => JSON.parse(readFileSync(join(AQUI, f), 'utf8'));
const catalogoFinal = ler('catalogo-final.json');
const modelos = ler('modelos.json');
const mapa = ler('mapa-final.json');

const CATALOG_VERSION = catalogoFinal.catalog_version;
const s = (x) => JSON.stringify(x);

// ------------------------------------------------------------------ os modelos
const ORDEM_DOS_PERFIS = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];

/**
 * Nome na tela e descrição. O nome vem de modelos.json, menos o do `gestor`, que
 * o dono decidiu chamar "Gestor do grupo": é o par do administrador (catálogo
 * inteiro), e não o gerente de uma loja.
 */
const NOMES = { gestor: 'Gestor do grupo' };
const DESCRICOES = {
  admin_geral: 'Responde pelo grupo inteiro: tem sempre o catálogo completo, em toda empresa em que está. Só quem administra o grupo o entrega.',
  gestor: 'Par do administrador: tem sempre o catálogo completo nas empresas em que está. Não é o gerente de uma loja; para isso use Gerente de Loja ou Gerente da loja (operação).',
  gerente_loja: 'Gerência da loja: venda, caixa, estoque, compras, financeiro, fiscal, e-commerce e a equipe da operação.',
  gerente_oficina: 'Gerência da oficina: ordens de serviço de todas as bancadas, peças, caixa, financeiro, fiscal e a equipe da operação.',
  estoquista: 'Estoque, produtos, compras e a expedição dos pedidos online.',
  atendente: 'Atendimento: clientes, orçamentos, venda no balcão, CRM e abertura de OS.',
  operador_caixa: 'Código antigo de caixa, mantido para quem já o tem. Não é oferecido para vínculos novos.',
  operador_caixa_loja: 'Caixa da loja: vender, abrir e fechar a gaveta, cobrar na maquininha e emitir a nota da venda.',
  operador_caixa_oficina: 'Caixa da oficina: o caixa da loja mais a entrega e o recebimento da OS.',
  mecanico: 'Técnico da bancada: assume, move e conclui as OS das bancadas em que é membro.',
  contador: 'Contador de fora da empresa: só o fechamento fiscal do mês.',
  somente_pdv: 'Só o PDV: vender, operar a gaveta, cobrar e emitir a nota da venda.',
  pdv_painel: 'O PDV e o painel do dia.',
  estoque: 'Só o estoque: consultar, movimentar, aprovar ajuste e cuidar das unidades serializadas.',
  financeiro_relatorios: 'O financeiro completo e os relatórios (central e BI).',
  tecnico_oficina: 'O trabalho da bancada: abrir, assumir, planejar, lançar peças e mão de obra e concluir a OS.',
  oficina_consulta: 'Só olhar o quadro da oficina e as fichas dos equipamentos.',
  gerente_operacao_loja: 'Gestão da operação da loja: PDV, vendas, estoque, financeiro e as liberações de alçada, sem usuários, sem o BI do grupo e sem a configuração fiscal.',
};

const listaDeModelos = [
  ...Object.values(modelos.modelos_de_sistema).map((m) => ({ ...m, atalho: false })),
  ...Object.values(modelos.modelos_de_atalho).map((m) => ({ ...m, atalho: true })),
];
for (const m of listaDeModelos) {
  if (!DESCRICOES[m.code]) throw new Error(`modelo ${m.code} sem descrição`);
}

// ------------------------------------------------------------------ expressões do mapa
function expressao(texto) {
  const t = String(texto).trim();
  const m = t.match(/^(qualquer|todas)\((.*)\)$/s);
  if (m) return { [m[1]]: m[2].split(',').map((x) => x.trim()) };
  if (/^[a-z_]+(\.[a-z_]+)+$/.test(t)) return { uma: t };
  return null;
}

// ------------------------------------------------------------------ Capabilities.ts
const caps = catalogoFinal.capabilities;
const linhasDoCatalogo = caps.map((c) => [
  '  {',
  `    code: ${s(c.code)},`,
  `    area: ${s(c.area)},`,
  `    pagina: ${s(c.pagina)},`,
  `    rotulo: ${s(c.label)},`,
  `    descricao: ${s(c.descricao)},`,
  `    escopo: ${s(c.escopo)},`,
  `    tipo: ${s(c.leitura_ou_escrita)},`,
  `    desde: ${c.desde},`,
  `    modelosPadrao: [${c.modelos_padrao.map(s).join(', ')}],`,
  '  },',
].join('\n'));

const linhasDosModelos = listaDeModelos.map((m) => {
  const titular = m.capabilities.includes('pdv.device_login') && m.assignable_by !== 'grupo';
  return [
    `  ${m.code}: {`,
    `    code: ${s(m.code)},`,
    `    nome: ${s(NOMES[m.code] ?? m.nome)},`,
    `    descricao: ${s(DESCRICOES[m.code])},`,
    `    fullCatalog: ${m.full_catalog === 1},`,
    `    assignableBy: ${s(m.assignable_by)},`,
    `    defaultWorkshops: ${s(m.default_workshops)},`,
    `    hidden: ${m.hidden === 1},`,
    `    atalho: ${m.atalho},`,
    `    titularDeToken: ${titular},`,
    `    capabilities: [${[...m.capabilities].sort().map(s).join(', ')}],`,
    '  },',
  ].join('\n');
});

const CASAS = [
  ['dashboard.view', '/sistema/painel'],
  ['pdv.sell', '/pdv'],
  ['workshop.kanban.view', '/sistema/oficina'],
  ['accounting.closing.view', '/sistema/fiscal/fechamento'],
  ['inventory.view', '/sistema/estoque'],
  ['finance.view', '/sistema/financeiro'],
  ['sales.view', '/sistema/vendas'],
  ['products.view', '/sistema/produtos'],
  ['reports.bi.view', '/sistema/relatorios/bi'],
  ['users.view', '/sistema/usuarios'],
  ['group.companies.manage', '/sistema/empresas'],
];

const capabilitiesTs = `/**
 * ============================================================================
 * O CATÁLOGO DE CAPABILITIES — quem pode o quê, por ação e por tela
 * ============================================================================
 *
 * ARQUIVO GERADO por \`scripts/rbac/gerar-artefatos.mjs\` a partir de
 * \`scripts/rbac/catalogo-final.json\` e \`scripts/rbac/modelos.json\`. Não edite à
 * mão: \`tests/rbac/catalogo.test.ts\` compara este arquivo com os dois JSON.
 *
 * O catálogo mora no CÓDIGO, e não em tabela, de propósito: capability sem
 * guarda no código não existe. Ela nasce e morre com a build. O banco guarda só
 * o que o dono muda — os modelos (\`core_permission_templates\`) e a
 * personalização de cada vínculo (\`core_user_company_capabilities\`). Uma
 * capability gravada no banco que saiu daqui é IGNORADA na resolução (falha
 * fechada) e apagada pela subida, com auditoria.
 *
 * Os modelos de sistema são os perfis de hoje, com o MESMO código
 * (\`core_user_companies.profile_code\` passa a ser "o modelo aplicado"), mais
 * os sete atalhos dos cenários, que nascem sem ninguém vinculado. O conteúdo
 * de cada um foi derivado rota a rota do acesso de hoje (\`modelos.json\`):
 * com eles, nenhuma rota muda de quem passa no dia 1, salvo a D1 declarada.
 *
 * Sem a linha do modelo no banco (banco recém-truncado pelos testes, ou que
 * nunca passou por \`prepararBanco\`), é \`MODELOS_DE_SISTEMA\` que responde.
 */

/** Sobe quando entra ou sai capability. É parte da chave do cache da sessão. */
export const CATALOG_VERSION = ${CATALOG_VERSION} as const;

/** Onde a capability vale: no grupo, na empresa, no caixa (PDV) ou na bancada. */
export type EscopoDaCapability = 'grupo' | 'empresa' | 'pdv' | 'bancada';

/** O que a capability faz: só olha, opera o dia a dia ou administra. */
export type TipoDaCapability = 'ler' | 'operar' | 'gerir';

export interface ItemDoCatalogo {
  readonly code: string;
  readonly area: string;
  readonly pagina: string;
  /** O nome curto, em português, que a tela mostra. */
  readonly rotulo: string;
  readonly descricao: string;
  readonly escopo: EscopoDaCapability;
  readonly tipo: TipoDaCapability;
  /** A versão do catálogo em que a capability entrou (as "novidades" de um modelo editado). */
  readonly desde: number;
  /** Os modelos de sistema em que ela nasce. Capability sem padrão nasceria 403 para todo mundo. */
  readonly modelosPadrao: readonly string[];
}

export const CATALOGO = [
${linhasDoCatalogo.join('\n')}
] as const satisfies readonly ItemDoCatalogo[];

/** Uma capability do catálogo. Erro de digitação num guarda não compila. */
export type Capability = (typeof CATALOGO)[number]['code'];

/** Os códigos, na ordem do catálogo. */
export const CAPABILITIES: readonly Capability[] = CATALOGO.map((c) => c.code);

const POR_CODIGO: ReadonlyMap<string, ItemDoCatalogo> = new Map(CATALOGO.map((c) => [c.code, c]));

/** A string é uma capability do catálogo desta build? */
export function ehCapability(codigo: string): codigo is Capability {
  return POR_CODIGO.has(codigo);
}

/** A linha do catálogo, ou \`undefined\` para código que não existe (mais). */
export function itemDoCatalogo(codigo: string): ItemDoCatalogo | undefined {
  return POR_CODIGO.get(codigo);
}

/** O rótulo em português; o próprio código quando não está no catálogo. */
export function rotuloDe(codigo: string): string {
  return POR_CODIGO.get(codigo)?.rotulo ?? codigo;
}

// ---------------------------------------------------------------- expressões

/**
 * A expressão que uma rota exige: uma capability, qualquer de várias ou todas
 * de várias. É a regra do desenho: a rota abre para quem tem QUALQUER tela que
 * a consome.
 */
export type ExpressaoDeCapability =
  | { readonly uma: Capability }
  | { readonly qualquer: readonly Capability[] }
  | { readonly todas: readonly Capability[] };

/** As capabilities citadas por uma expressão. */
export function capabilitiesDaExpressao(expr: ExpressaoDeCapability): readonly Capability[] {
  if ('uma' in expr) return [expr.uma];
  if ('qualquer' in expr) return expr.qualquer;
  return expr.todas;
}

/** O conjunto passa na expressão? Conjunto vazio nunca passa. */
export function passaNaExpressao(caps: ReadonlySet<string>, expr: ExpressaoDeCapability): boolean {
  if ('uma' in expr) return caps.has(expr.uma);
  if ('qualquer' in expr) return expr.qualquer.some((c) => caps.has(c));
  return expr.todas.length > 0 && expr.todas.every((c) => caps.has(c));
}

/**
 * Lê o texto do mapa (\`products.view\`, \`qualquer(a, b)\`, \`todas(a, b)\`).
 * Devolve \`null\` para texto que não é expressão ou que cita código fora do catálogo.
 */
export function expressaoDoTexto(texto: string): ExpressaoDeCapability | null {
  const t = texto.trim();
  const composta = /^(qualquer|todas)\\((.*)\\)$/s.exec(t);
  if (composta) {
    const partes = composta[2]!.split(',').map((x) => x.trim());
    if (partes.length === 0 || !partes.every(ehCapability)) return null;
    return composta[1] === 'qualquer' ? { qualquer: partes } : { todas: partes };
  }
  return ehCapability(t) ? { uma: t } : null;
}

// ---------------------------------------------------------------- modelos de sistema

/** Quem pode aplicar o modelo inteiro num vínculo (desenho §9.1). */
export type AtribuivelPor = 'gestao_da_empresa' | 'grupo' | 'subconjunto';

export interface ModeloDeSistema {
  readonly code: string;
  readonly nome: string;
  readonly descricao: string;
  /** Sempre o catálogo inteiro (Administrador e Gestor do grupo). Não se edita. */
  readonly fullCatalog: boolean;
  readonly assignableBy: AtribuivelPor;
  /** Bancadas quando o vínculo não escolheu: todas as ativas, ou só as de que é membro. */
  readonly defaultWorkshops: 'todas' | 'membro';
  /** Vale para quem já tem; não se oferece a vínculo novo (o caixa legado). */
  readonly hidden: boolean;
  /** Atalho de cenário: nasce sem ninguém vinculado. */
  readonly atalho: boolean;
  /**
   * Pode ser titular de token de computador do caixa (decisão do dono): só os
   * modelos de caixa e os atalhos de PDV. Conta de dono (\`assignableBy = grupo\`)
   * nunca, mesmo tendo o catálogo inteiro.
   */
  readonly titularDeToken: boolean;
  readonly capabilities: readonly Capability[];
}

export const MODELOS_DE_SISTEMA: Readonly<Record<string, ModeloDeSistema>> = {
${linhasDosModelos.join('\n')}
};

/** O modelo de sistema com este código, ou \`undefined\`. */
export function modeloDeSistema(codigo: string | null | undefined): ModeloDeSistema | undefined {
  if (!codigo) return undefined;
  return Object.prototype.hasOwnProperty.call(MODELOS_DE_SISTEMA, codigo) ? MODELOS_DE_SISTEMA[codigo] : undefined;
}

// ---------------------------------------------------------------- casa

/**
 * A primeira página, numa lista ordenada, cuja capability a pessoa tem (desenho
 * §11.3). Com os modelos do dia 1 é a mesma casa de hoje: gerentes, atendente e
 * estoquista no painel; os caixas no PDV; o mecânico na oficina; o contador no
 * fechamento.
 */
export const CASAS: readonly { readonly capability: Capability; readonly casa: string }[] = [
${CASAS.map(([c, casa]) => `  { capability: ${s(c)}, casa: ${s(casa)} },`).join('\n')}
];

/** A casa de quem não tem nenhuma das capabilities acima. */
export const CASA_SEM_ACESSO = '/sem-acesso';

export function casaDe(caps: ReadonlySet<string>): string {
  return CASAS.find((c) => caps.has(c.capability))?.casa ?? CASA_SEM_ACESSO;
}
`;

// ------------------------------------------------------------------ TraducaoDePermissoes.ts
const rotasDoMapa = mapa.pontos.filter((p) => (p.tipo === 'rota' || p.tipo === 'publica') && p.metodo && p.caminho);
const traducoes = [];
for (const p of rotasDoMapa) {
  const m = /requirePermission\('([^']+)'\)/.exec(p.guarda_hoje ?? '');
  if (!m) continue;
  const e = expressao(p.capability_final);
  if (!e) throw new Error(`rota ${p.metodo} ${p.caminho}: capability_final ilegível: ${p.capability_final}`);
  traducoes.push({ chave: `${p.metodo} ${p.caminho}`, permissao: m[1], e, perfis: p.perfis_hoje });
}
traducoes.sort((a, b) => a.chave.localeCompare(b.chave));
const exprTs = (e) => ('uma' in e ? `{ uma: ${s(e.uma)} }` : 'qualquer' in e ? `{ qualquer: [${e.qualquer.map(s).join(', ')}] }` : `{ todas: [${e.todas.map(s).join(', ')}] }`);

const traducaoTs = `/**
 * ============================================================================
 * requirePermission → capability, ROTA A ROTA (C8)
 * ============================================================================
 *
 * ARQUIVO GERADO por \`scripts/rbac/gerar-artefatos.mjs\` a partir de
 * \`scripts/rbac/mapa-final.json\`. Não edite à mão.
 *
 * \`requirePermission('modulo.recurso.acao')\` perguntava à matriz de
 * \`Permissions.ts\` se os PERFIS do token davam conta da string. Desde a F1 do
 * RBAC granular ele pergunta às CAPABILITIES do vínculo de agora — e a
 * tradução é por ROTA (método + caminho), não por string: a mesma string
 * \`payment-terminal.settings.manage\` guarda uma leitura (\`GET
 * /payment-terminals/local-agent/status\`, \`integrations.card_terminal.operate\`)
 * e um pareamento (\`POST /payment-terminals/local-agent/pairing\`,
 * \`integrations.card_terminal.manage\`). Uma tabela por string alargaria uma e
 * estreitaria a outra.
 *
 * Cada linha foi derivada do acesso de hoje (matriz de módulos + a interseção
 * com \`GERENCIA_DA_MAQUININHA\` dentro do handler): com os modelos de sistema,
 * quem passa é exatamente quem passava. \`tests/rbac/equivalencia.test.ts\`
 * cobra isso rota a rota, e cobra que toda chamada de \`requirePermission\` do
 * código tenha a sua linha aqui. Rota sem linha NEGA (falha fechada).
 *
 * A tabela morre na fatia (e) da F2, quando as chamadas viram \`comCapability\`.
 */
import type { ExpressaoDeCapability } from './Capabilities.js';

export interface TraducaoDaPermissao {
  /** A string que a rota pede hoje — conferida, para a tradução não servir a outra chamada. */
  readonly permissao: string;
  readonly expressao: ExpressaoDeCapability;
}

/** Chave: \`MÉTODO /caminho\` como montado em \`/api/v1\` (sem o prefixo). */
export const PERMISSAO_PARA_CAPABILITY: Readonly<Record<string, TraducaoDaPermissao>> = {
${traducoes.map((t) => `  ${s(t.chave)}: { permissao: ${s(t.permissao)}, expressao: ${exprTs(t.e)} },`).join('\n')}
};
`;

// ------------------------------------------------------------------ linha-de-base.json
const ordemDePerfil = new Map(ORDEM_DOS_PERFIS.map((p, i) => [p, i]));
const rotas = {};
for (const p of rotasDoMapa) {
  const chave = `${p.metodo} ${p.caminho}`;
  if (rotas[chave]) continue; // o mapa repete POST /core/fiscal/series (duas linhas da mesma rota)
  const publica = p.tipo === 'publica';
  rotas[chave] = {
    arquivo: p.arquivo.split('/').pop(),
    linha: p.linha_rota ?? p.linha,
    guarda_hoje: p.guarda_hoje,
    perfis: publica ? 'PUBLICA' : [...p.perfis_hoje].sort((a, b) => (ordemDePerfil.get(a) ?? 99) - (ordemDePerfil.get(b) ?? 99)),
    capability: p.capability_final,
    mudanca: p.mudanca ?? null,
  };
}
const linhaDeBase = {
  o_que_e: 'O acesso de HOJE, congelado antes do RBAC granular (T0): rota (método + caminho em /api/v1) → os perfis que passam no guarda de hoje. '
    + '"capability" é a expressão que a F2 escreve no lugar do guarda (T1). "mudanca" marca as únicas diferenças permitidas.',
  gerado_por: 'scripts/rbac/gerar-artefatos.mjs, a partir de scripts/rbac/mapa-final.json (coluna perfis_hoje)',
  base: mapa.base,
  mudancas_permitidas: {
    D1: 'O legado operador_caixa (0 vínculos) passa a poder POST /core/print/jobs e POST /core/print/jobs/:id/reprint (conflitos.md, C1).',
  },
  total: Object.keys(rotas).length,
  rotas: Object.fromEntries(Object.entries(rotas).sort(([a], [b]) => a.localeCompare(b))),
};

// ------------------------------------------------------------------ escrita
const escrever = (rel, conteudo) => {
  writeFileSync(join(REPO, rel), conteudo, 'utf8');
  console.log('escrito', rel);
};
escrever('server/src/services/auth/Capabilities.ts', capabilitiesTs);
escrever('server/src/services/auth/TraducaoDePermissoes.ts', traducaoTs);
escrever('server/tests/rbac/linha-de-base.json', JSON.stringify(linhaDeBase, null, 1) + '\n');

const congelado = `server/tests/rbac/catalogo-v${CATALOG_VERSION}.json`;
if (!existsSync(join(REPO, congelado))) {
  escrever(congelado, JSON.stringify({
    o_que_e: `Os códigos da versão ${CATALOG_VERSION} do catálogo, congelados. Capability renomeada some dos modelos e dos vínculos na subida — `
      + 'por isso nome publicado não muda: capability nova sobe CATALOG_VERSION e ganha um arquivo novo.',
    catalog_version: CATALOG_VERSION,
    codigos: caps.map((c) => c.code).sort(),
  }, null, 1) + '\n');
} else {
  console.log('mantido', congelado, '(congelado: não se regenera)');
}
console.log(`catálogo ${caps.length}, modelos ${listaDeModelos.length}, traduções ${traducoes.length}, rotas na linha de base ${linhaDeBase.total}`);
