// Consolidação do RBAC granular do DEVORA.
// Lê catalogo.json + sites-*.json (as 11 fatias) + mapa-rota-capability.tsv + _modelos-dia1.json,
// resolve os FALTA:, deriva os modelos de sistema a partir do acesso de HOJE (restrição por restrição),
// acusa os conflitos, calcula o veredito de cada ponto e escreve:
//   catalogo-final.json, mapa-final.json, modelos.json, conflitos.md, equivalencia.md, plano-de-implementacao.md
// Só lê arquivos desta pasta. Não toca no repositório. Rodar: node _consolidar.mjs (cwd = esta pasta).
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';

const LER = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const P = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
const AB = { admin_geral: 'A', gestor: 'G', gerente_loja: 'L', gerente_oficina: 'O', estoquista: 'E', atendente: 'T',
  operador_caixa: 'C', operador_caixa_loja: 'CL', operador_caixa_oficina: 'CO', mecanico: 'M', contador: 'K' };
const ab = (xs) => (xs.length ? xs.map((p) => AB[p] ?? p).join(',') : '—');
const FATIAS = ['core-1', 'core-2', 'core-3', 'core-4', 'core-5', 'core-6', 'core-7', 'outros-roteadores', 'servicos', 'tela-rotas-menu', 'tela-botoes'];
const BASE = BASE_DA_ARVORE;

// ------------------------------------------------------------------ atributos dos modelos de sistema (desenho §3.1)
const ATTR = {
  admin_geral: { nome: 'Administrador do grupo', full_catalog: 1, assignable_by: 'grupo', default_workshops: 'todas', hidden: 0 },
  gestor: { nome: 'Gestor do grupo (par do administrador)', full_catalog: 1, assignable_by: 'grupo', default_workshops: 'todas', hidden: 0 },
  gerente_loja: { nome: 'Gerente de Loja', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  gerente_oficina: { nome: 'Gerente de Oficina', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  estoquista: { nome: 'Estoquista', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  atendente: { nome: 'Atendente', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  operador_caixa: { nome: 'Operador de Caixa (legado)', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 1 },
  operador_caixa_loja: { nome: 'Operador de Caixa (loja)', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  operador_caixa_oficina: { nome: 'Operador de Caixa (oficina)', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'todas', hidden: 0 },
  mecanico: { nome: 'Mecânico / Técnico', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: 'membro', hidden: 0 },
  contador: { nome: 'Contador', full_catalog: 0, assignable_by: 'grupo', default_workshops: 'todas', hidden: 0 },
};

// ------------------------------------------------------------------ catálogo: o de entrada + as capabilities que resolvem os FALTA:
const catalogoIn = LER('catalogo.json');
const NOVAS = [
  {
    code: 'pdv.device_login', area: 'PDV', pagina: '/sistema/configuracoes/terminais (quem recebe o token) · POST /auth/device/enroll · POST /auth/device/login',
    label: 'Entrar por token de computador do caixa',
    descricao: 'Pode ser o titular de um token de dispositivo (computador do caixa) e abrir sessão por ele, sem senha, no caixa do token. Conferida no ALVO do cadastro (POST /auth/device/enroll, auth.ts:457) e no login do dispositivo (POST /auth/device/login, auth.ts:401), sempre com o caixa do token no escopo do vínculo (requireTerminalNoEscopo). Conta cujo modelo no vínculo é assignable_by=grupo (conta de dono) nunca recebe token, pela mesma régua que já a impede de recuperar senha por e-mail (RecuperacaoDeSenhaDaEquipe.ts:204). Substitui o filtro por prefixo de código de TerminaisPage.tsx:440.',
    escopo: 'pdv', leitura_ou_escrita: 'operar',
    perfis_de_hoje: ['admin_geral', 'gestor', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
    origem: 'resolve FALTA:pdv.device_login (tela-botoes, src/pages/gs/TerminaisPage.tsx:440) e a nota de auth.ts:401',
  },
  {
    code: 'sales.quotes.cancel', area: 'Vendas', pagina: '/sistema/orcamentos', label: 'Cancelar orçamento',
    descricao: 'POST /core/quotes/:id/cancel (core.ts:5245-5260). Separada de todas(sales.quotes.manage, pdv.cash.operate): cancelar não toca gaveta nem caixa, e a capability de escopo pdv nesta rota levaria 409 CORE_TERMINAL_REQUIRED a quem tem lista de caixas e cancela no escritório.',
    escopo: 'empresa', leitura_ou_escrita: 'operar',
    perfis_de_hoje: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
    origem: 'resolve a sugestão FALTA:sales.quotes.close da fatia core-3',
  },
  {
    code: 'sales.consignment.close', area: 'Vendas', pagina: '/sistema/consignacoes', label: 'Fechar consignação',
    descricao: 'POST /core/consignments/:id/fechar (core.ts:5507-5515): encerra a custódia, sem gaveta. Mesmo motivo de sales.quotes.cancel.',
    escopo: 'empresa', leitura_ou_escrita: 'operar',
    perfis_de_hoje: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'],
    origem: 'resolve a sugestão FALTA:sales.consignment.close da fatia core-3',
  },
];
const catalogo = [...catalogoIn.map((c) => ({ ...c, origem: 'catalogo.json' })), ...NOVAS];
const CODES = new Set(catalogo.map((c) => c.code));
const CAT = Object.fromEntries(catalogo.map((c) => [c.code, c]));

// ------------------------------------------------------------------ expressões
function parse(e) {
  e = String(e).trim();
  const m = e.match(/^(qualquer|todas)\((.*)\)$/s);
  if (m) return { op: m[1], args: m[2].split(',').map((s) => s.trim()) };
  if (/^[a-z_]+(\.[a-z_*]+)+$/.test(e)) return { op: 'cap', args: [e] };
  return { op: 'marcador', raw: e };
}
const has = (m, c) => m.caps.has(c);
const grupo = (m) => m.attrs.assignable_by === 'grupo';
const APPROVALS = ['approval.discount', 'approval.cash_withdrawal', 'approval.cash_reopen', 'approval.sale_cancel', 'approval.sale_return'];
function passa(x, m) {
  if (x.op === 'cap') return has(m, x.args[0]);
  if (x.op === 'qualquer') return x.args.some((a) => has(m, a));
  if (x.op === 'todas') return x.args.every((a) => has(m, a));
  return true;
}

// ------------------------------------------------------------------ pontos
const pontos = [];
for (const f of FATIAS) {
  LER(`sites-${f}.json`).forEach((s, i) => {
    const base = s.arquivo.split('/').pop();
    pontos.push({ ...s, fatia: f, id: `${f}#${i}`, base, ref: `${s.arquivo}:${s.linha}` });
  });
}
const ehRota = (s) => s.tipo === 'rota' || s.tipo === 'publica';
const ehTela = (s) => s.fatia.startsWith('tela-');
const chaveRota = (s) => `${s.metodo} ${s.caminho}`;
const rotaPorChave = new Map();
for (const s of pontos) if (s.tipo === 'rota' && s.metodo && s.caminho && !rotaPorChave.has(chaveRota(s))) rotaPorChave.set(chaveRota(s), s);

// ------------------------------------------------------------------ decisões por ponto (a parte que o arquiteto decide; tudo o mais é calculado)
// chave: "<basename>:<linha>" (ou "<fatia>:<linha>" para a tela); `tipos` limita a que tipos a decisão se aplica.
const intakeTodas = (m) => has(m, 'workshop.admin') || (has(m, 'workshop.orders.open') && !has(m, 'workshop.orders.assume'));
const tecnico = (m) => has(m, 'workshop.orders.assume') && !has(m, 'workshop.admin');
const temCapDeBancada = (m) => [...m.caps].some((c) => CAT[c]?.escopo === 'bancada');
const bancadaObrigatoriaNova = (m) => temCapDeBancada(m) && m.attrs.default_workshops === 'membro';
const EQUIPE_DA_OFICINA_HOJE = ['mecanico', 'gerente_oficina', 'operador_caixa_oficina'];

const OV = {
  // --- D1: o legado operador_caixa (0 vínculos) ---
  'core.ts:1525': { tipos: ['rota'], mudanca: 'D1', conflito: 'C1', categoria: 'guarda' },
  'core.ts:1547': { mudanca: 'D1', conflito: 'C1', categoria: 'escopo-caixa', regra: 'requireTerminalNoEscopo só quando existe caixa efetivo e a pessoa entrou por pdv.sell; quem entra só por sales.view não leva 409.' },
  'core.ts:1596': { tipos: ['rota'], mudanca: 'D1', conflito: 'C1', categoria: 'guarda' },
  // --- capabilities novas que resolvem a sugestão da core-3 (C4) ---
  'core.ts:5247': { tipos: ['rota'], cap: 'sales.quotes.cancel', conflito: 'C4', categoria: 'guarda', regra: 'Sem requireTerminalNoEscopo: a rota não toca gaveta.' },
  'core.ts:5507': { tipos: ['rota'], cap: 'sales.consignment.close', conflito: 'C4', categoria: 'guarda', regra: 'Sem requireTerminalNoEscopo: a rota não toca gaveta.' },
  'tela-botoes:421': { conflito: 'C4', regra: 'Botão Faturar: todas(sales.quotes.manage, pdv.cash.operate) (a rota /convert toca caixa). Botão Cancelar: sales.quotes.cancel. Mesmo conjunto de perfis no dia 1.' },
  // --- liberador da alçada ---
  'core.ts:6242': { fixo: 'n/a (porta do bilhete: a capability é do LIBERADOR, conferida na emissão, core.ts:5916; perfis_hoje são quem pede)', categoria: 'liberador' },
  // --- bancada ---
  'core.ts:7375': { fixo: 'igual pelo passo 86 (all_workshops=1 para não-membros de bancada ATIVA que não são mecânico), salvo D3b', mudanca: 'D3b', conflito: 'C2', categoria: 'escopo-bancada',
    regra: 'bancadasDoVinculo: all_workshops=1 ou NULL com default "todas" → todas as ativas; senão as de core_workshop_members ATIVAS; vazio = nenhuma. Passo 86 conta só bancadas ATIVAS.' },
  'core.ts:7397': { pred: intakeTodas, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'Abre OS em TODAS as bancadas ativas: workshop.admin ou (workshop.orders.open e não workshop.orders.assume). Os demais: bancadasDoVinculo.' },
  'core.ts:9580': { pred: intakeTodas, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'idem core.ts:7397' },
  'core.ts:9592': { pred: intakeTodas, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'idem core.ts:7397' },
  'core.ts:10398': { pred: intakeTodas, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'idem core.ts:7397' },
  'WorkshopIntakeService.ts:65': { pred: intakeTodas, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'idem core.ts:7397 (GESTAO_DA_OFICINA ∪ BALCAO_DA_OFICINA viram capability)' },
  'WorkshopIntakeService.ts:44': { pred: (m) => has(m, 'workshop.orders.open') && !has(m, 'workshop.orders.assume') && !has(m, 'workshop.admin'), conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'BALCAO_DA_OFICINA = open e não assume e não admin' },
  'WorkshopIntakeService.ts:73': { pred: tecnico, conflito: 'C2', categoria: 'escopo-bancada/entrada', regra: 'Técnico (assume e não admin) abre só nas bancadas do vínculo' },
  // --- voz na OS e travas de responsável (§7.3, corrigido) ---
  'core.ts:7408': { pred: (m) => has(m, 'workshop.admin') || has(m, 'workshop.orders.assume'), categoria: 'voz', regra: 'vozNaOs: workshop.admin → gestor; workshop.orders.assume → técnico; senão balcão. perfis_hoje = quem NÃO fala como balcão.' },
  'core.ts:9465': { pred: tecnico, categoria: 'voz', regra: 'onlyMine = assume e não admin' },
  'core.ts:10055': { pred: (m) => !has(m, 'workshop.orders.assume') || has(m, 'workshop.admin'), categoria: 'voz', regra: 'isManager = não assume, ou admin' },
  'core.ts:10105': { pred: (m) => !has(m, 'workshop.orders.assume') || has(m, 'workshop.admin'), categoria: 'voz', regra: 'isManager = não assume, ou admin' },
  'WorkshopCoreService.ts:596': { pred: (m) => !tecnico(m), categoria: 'voz', regra: 'Só a voz de técnico toma a trava da OS alheia' },
  'WorkshopCoreService.ts:678': { pred: () => false, conflito: 'C7', categoria: 'trava-sem-bypass', regra: 'Sem exceção de gestor. NÃO traduzir para workshop.admin.' },
  'WorkshopCoreService.ts:1086': { pred: () => false, conflito: 'C7', categoria: 'trava-sem-bypass', regra: 'Sem exceção de gestor (o isManager só escolhe o rótulo). NÃO traduzir para workshop.admin.' },
  'WorkshopCoreService.ts:1582': { pred: () => false, conflito: 'C7', categoria: 'trava-sem-bypass', regra: 'idem addPart' },
  'WorkshopCoreService.ts:1644': { pred: () => false, conflito: 'C7', categoria: 'trava-sem-bypass', regra: 'Só o técnico responsável conclui' },
  'tela-botoes:313': { pred: tecnico, esperado: ['mecanico'], categoria: 'voz', regra: 'Uso composto falaComoTecnico = ehMecanico && !gerenteDaOficina (linha 314) = assume e não admin. A variável isolada ehMecanico não tem uso próprio.' },
  // --- decisões sobre o ALVO (C3): capability + atributo assignable_by do modelo, nunca código ---
  'EquipmentService.ts:171': { pred: (m) => has(m, 'workshop.orders.assume') && !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Montador = o vínculo do ALVO nesta empresa tem workshop.orders.assume e o modelo dele não é assignable_by=grupo' },
  'tela-botoes:217': { pred: (m) => has(m, 'workshop.orders.assume') && !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Espelho de EquipmentService.ts:171 (a tela recebe a elegibilidade calculada pelo servidor)' },
  'TeamService.ts:161': { pred: (m) => has(m, 'workshop.orders.move') && !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Equipe da oficina = workshop.orders.move e modelo não assignable_by=grupo' },
  'implantacaoPorEmpresa.ts:297': { pred: (m) => has(m, 'users.manage') && !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Item "gerente": users.manage e modelo não assignable_by=grupo' },
  'implantacaoPorEmpresa.ts:321': { pred: (m) => has(m, 'pdv.device_login') && !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Item "caixa": pdv.device_login e modelo não assignable_by=grupo' },
  'ProntidaoDasComunicacoes.ts:208': { pred: (m) => has(m, 'accounting.closing.view') && !has(m, 'dashboard.view'), conflito: 'C3', categoria: 'alvo', regra: 'Item "acesso do contador": vê o fechamento e não opera a empresa (accounting.closing.view e não dashboard.view)' },
  'RecuperacaoDeSenhaDaEquipe.ts:204': { pred: (m) => !grupo(m), conflito: 'C3', categoria: 'alvo', regra: 'Conta de dono = algum vínculo com modelo assignable_by=grupo (ou modelo inexistente). Essa conta não recupera por e-mail.' },
  'AuthorizationService.ts:135': { pred: (m) => APPROVALS.some((a) => has(m, a)) && !has(m, 'group.admin'), categoria: 'alvo', regra: '"Quem libera aqui": do grupo = group.admin; da operação = algum approval.* e não group.admin' },
  'tela-botoes:440': { cap: 'pdv.device_login', pred: (m) => has(m, 'pdv.device_login') && !grupo(m), conflito: 'C5', categoria: 'alvo', regra: 'Quem pode RECEBER token: o vínculo do alvo tem pdv.device_login e o modelo não é assignable_by=grupo. O servidor passa a cobrar a mesma regra (D9).' },
  'TeamService.ts:85': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'Bancada obrigatória = o modelo tem capability de escopo bancada e default_workshops=membro, ou o vínculo escolheu all_workshops=0 (400 CORE_WORKSHOP_SCOPE_REQUIRED).' },
  'TeamService.ts:406': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'idem TeamService.ts:85 (criação)' },
  'TeamService.ts:560': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'idem (troca de modelo)' },
  'TeamService.ts:576': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'idem (troca de bancadas)' },
  'TeamService.ts:842': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'idem (vínculo de conta existente)' },
  'tela-botoes:610': { pred: bancadaObrigatoriaNova, esperado: EQUIPE_DA_OFICINA_HOJE, mudanca: 'D11', categoria: 'alvo-formulario', regra: 'Espelho de TeamService.ts:85: a tela lê a exigência do modelo vinda do servidor' },
  // --- administrador do grupo: listas fundidas ---
  'IdentityService.ts:509': { fixo: 'igual por construção: vira listGroupAdmins() = group.admin em todas as ativas (A ∪ G); cada conta entra na empresa nova com o MESMO modelo que tem nas outras (desenho §8 #9/#10)', categoria: 'fusao' },
  'IdentityService.ts:521': { fixo: 'igual por construção (ver IdentityService.ts:509)', categoria: 'fusao' },
  'IdentityService.ts:677': { fixo: 'igual por construção: ADMIN entra como admin_geral, como hoje', categoria: 'fusao' },
  'IdentityService.ts:686': { fixo: 'igual por construção: CARLOSGERENTE entra como gestor, como hoje', categoria: 'fusao' },
  'IdentityService.ts:724': { alcance: (m) => has(m, 'group.companies.manage'), categoria: 'alvo', regra: 'Aplicar o modelo do primeiro gerente: users.manage + assignable_by do modelo (§9.1); só quem tem group.companies.manage chega aqui' },
  // --- PDV: dispositivo e caixa ---
  'auth.ts:401': { tipos: ['servico'], cap: 'pdv.device_login', pred: (m) => has(m, 'pdv.device_login') && !grupo(m), mudanca: 'D10', conflito: 'C5', categoria: 'escopo-caixa', regra: 'Login do dispositivo: o titular do token tem pdv.device_login na empresa do token, não é conta de dono, e o caixa do token está no escopo do vínculo (requireTerminalNoEscopo).' },
  'auth.ts:457': { tipos: ['rota'], associada: 'D9', categoria: 'guarda', regra: 'Ator: devices.manage (igual). ALVO (novo, D9): pdv.device_login no vínculo, modelo não assignable_by=grupo, caixa no escopo do alvo, e o ator alcança o alvo pela régua do §9.3.' },
  'core.ts:10212': { associada: 'D12', categoria: 'escopo-caixa', regra: 'O caixa do recebimento passa a vir de terminalDoPedido (token vence o corpo; divergência 409) e entra requireTerminalNoEscopo.' },
  // --- custo ---
  'InventoryService.ts:1594': { rota: 'GET /core/stock/movements', categoria: 'servico-ator', regra: 'hideCost = !can(inventory.view) (core.ts:3042). Comparado entre quem alcança GET /core/stock/movements.' },
  // --- definições e módulos mortos ---
  'auth.ts:156': { tipos: ['atalho-admin'], fixo: 'n/a (definição de requirePermission: vira tradutor por ROTA na F1 e morre na F5)', conflito: 'C8', categoria: 'definicao' },
  'nfse.ts:38': { tipos: ['atalho-admin'], fixo: 'n/a (cópia local de requireProfile: apagada na fatia c)', categoria: 'definicao' },
  'payment-terminals.ts:74': { tipos: ['atalho-admin'], fixo: 'n/a (cópia local de requireProfile: os 11 chamadores viram integrations.card_terminal.manage na fatia e)', conflito: 'C12', categoria: 'definicao' },
  'Permissions.ts:70': { fixo: 'n/a (módulo morto fiscal: nenhuma rota chama requirePermission(fiscal.*); não semear)', categoria: 'modulo-morto' },
  'Permissions.ts:79': { fixo: 'n/a (módulo morto crm: nenhuma rota chama requirePermission(crm.*); não semear)', categoria: 'modulo-morto' },
  'Permissions.ts:82': { fixo: 'n/a (módulo morto corporate-bi: nenhuma rota chama requirePermission(corporate-bi.*); não semear)', categoria: 'modulo-morto' },
};
function decisaoDe(s) {
  const k1 = `${s.base}:${s.linha}`;
  const k2 = `${s.fatia}:${s.linha}`;
  const ov = (ehTela(s) ? OV[k2] : undefined) ?? OV[k1];
  if (!ov) return null;
  if (ov.tipos && !ov.tipos.includes(s.tipo)) return null;
  if (!ov.tipos && s.tipo === 'rota' && !ov.cap) return null; // decisões de serviço não pegam a rota da mesma linha
  return ov;
}
const usoDasChaves = {};
for (const s of pontos) { const ov = decisaoDe(s); if (ov) { const k = Object.keys(OV).find((kk) => OV[kk] === ov); (usoDasChaves[k] = usoDasChaves[k] || []).push(s.id); } }
const chavesSemUso = Object.keys(OV).filter((k) => !usoDasChaves[k]);
const chavesAmbiguas = Object.entries(usoDasChaves).filter(([, v]) => v.length > 1);

const RE_BANCADA = /resolveWorkshopScope|resolveWorkshop\(|isManagerProfile|GESTAO_DA_OFICINA/;
const RE_TODAS_A_G_O = (s) => s.perfis_hoje.length === 3 && ['admin_geral', 'gestor', 'gerente_oficina'].every((p) => s.perfis_hoje.includes(p));

// capability final de cada ponto
for (const s of pontos) {
  const ov = decisaoDe(s);
  s.capability_fatia = s.capability;
  let cap = ov?.cap ?? s.capability;
  if (String(cap).startsWith('FALTA:')) cap = cap.slice(6);
  s.capability_final = cap;
  s.x = parse(cap);
  s.ov = ov;
  if (s.x.op !== 'marcador') for (const a of s.x.args) if (!CODES.has(a)) throw new Error(`capability desconhecida ${a} em ${s.ref}`);
}

// ------------------------------------------------------------------ restrições vinculantes para derivar os modelos
// (1) toda rota guardada (única por método+caminho); (2) todo ponto de serviço cuja decisão é a capability do ATOR
//     e que não tem regra própria acima nem é recorte de bancada (comparado entre quem alcança a rota, se houver).
const restricoes = [];
const vistas = new Set();
for (const s of pontos) {
  if (s.x.op === 'marcador' || ehTela(s)) continue;
  if (s.tipo === 'rota') {
    const k = chaveRota(s);
    if (vistas.has(k)) continue;
    vistas.add(k);
    restricoes.push({ id: s.id, ref: s.ref, rotulo: `${s.metodo} ${s.caminho}`, x: s.x, S: s.perfis_hoje, R: null, tipo: 'rota' });
    continue;
  }
  if (s.ov) continue;
  if (RE_BANCADA.test(String(s.guarda_hoje)) && RE_TODAS_A_G_O(s) && !String(s.capability_final).startsWith('workshop.admin')) continue;
  if (!s.perfis_hoje.every((p) => P.includes(p)) || !s.perfis_hoje.length) continue;
  const r = s.metodo && s.caminho ? rotaPorChave.get(chaveRota(s)) : null;
  restricoes.push({ id: s.id, ref: s.ref, rotulo: `${s.base}:${s.linha}${s.caminho ? ' ' + s.metodo + ' ' + s.caminho : ''}`, x: s.x, S: s.perfis_hoje, R: r ? r.perfis_hoje : null, tipo: 'servico' });
}

// resolução dos conflitos de derivação (o que o solver não consegue satisfazer)
const RESOLUCAO = {
  'operador_caixa|pdv.sell': { valor: true, mudanca: 'D1', conflito: 'C1',
    motivo: 'pdv.sell guarda POST /core/sales, /cash e o PDV inteiro com o operador_caixa legado dentro, e POST /print/jobs e /print/jobs/:id/reprint com ele fora. Fica TRUE: o legado ganha as duas rotas de impressão (0 vínculos; a guarda de hoje se contradiz, porque ele já lê e atualiza os mesmos jobs por abertaAo(balcao)).' },
  'operador_caixa|sales.view': { valor: false, conflito: 'C1', motivo: 'Forçada falsa por print/jobs; sem outra restrição que a queira verdadeira.' },
};

function modeloDeCatalogo(p) { return new Set(catalogo.filter((c) => c.perfis_de_hoje.includes(p)).map((c) => c.code)); }

const conflitosSolver = [];
const derivacao = {};
for (const p of P) {
  const forcT = new Map(); const forcF = new Map();
  const add = (mp, c, r) => { if (!mp.has(c)) mp.set(c, []); mp.get(c).push(r); };
  const clausAny = []; const clausNotAll = [];
  for (const r of restricoes) {
    if (r.R && !r.R.includes(p)) continue;
    const inS = r.S.includes(p);
    if (r.x.op === 'cap') add(inS ? forcT : forcF, r.x.args[0], r);
    else if (r.x.op === 'qualquer') { if (!inS) r.x.args.forEach((a) => add(forcF, a, r)); else clausAny.push(r); }
    else if (r.x.op === 'todas') { if (inS) r.x.args.forEach((a) => add(forcT, a, r)); else clausNotAll.push(r); }
  }
  const padrao = modeloDeCatalogo(p);
  const val = new Map(); const origem = new Map();
  for (const c of CODES) {
    const t = forcT.get(c); const f = forcF.get(c);
    if (t && f) {
      const res = RESOLUCAO[`${p}|${c}`];
      conflitosSolver.push({ perfil: p, capability: c, a_favor: t.map((r) => r.rotulo + ' (' + r.ref + ')'), contra: f.map((r) => r.rotulo + ' (' + r.ref + ')'), resolucao: res ?? null });
      val.set(c, res ? res.valor : padrao.has(c)); origem.set(c, res ? 'conflito-resolvido' : 'CONFLITO-SEM-RESOLUCAO');
    } else if (t) { val.set(c, true); origem.set(c, 'forcada'); }
    else if (f) { val.set(c, false); origem.set(c, 'forcada'); }
  }
  const escolhas = [];
  for (const r of clausAny) {
    if (r.x.args.some((a) => val.get(a) === true)) continue;
    const livres = r.x.args.filter((a) => !val.has(a));
    const pref = livres.find((a) => padrao.has(a)) ?? livres[0];
    if (!pref) { conflitosSolver.push({ perfil: p, capability: `qualquer(${r.x.args.join(', ')})`, a_favor: [r.rotulo + ' (' + r.ref + ')'], contra: r.x.args.map((a) => a + ' forçada falsa'), resolucao: RESOLUCAO[`${p}|${r.x.args[0]}`] ?? null }); continue; }
    val.set(pref, true); origem.set(pref, 'clausula'); if (!padrao.has(pref)) escolhas.push(`${pref} por ${r.rotulo}`);
  }
  for (const r of clausNotAll) {
    if (r.x.args.some((a) => val.get(a) === false)) continue;
    const livres = r.x.args.filter((a) => !val.has(a));
    const pref = livres.find((a) => !padrao.has(a)) ?? livres[0];
    if (!pref) { conflitosSolver.push({ perfil: p, capability: `todas(${r.x.args.join(', ')})`, a_favor: r.x.args.map((a) => a + ' forçada verdadeira'), contra: [r.rotulo + ' (' + r.ref + ')'], resolucao: null }); continue; }
    val.set(pref, false); origem.set(pref, 'clausula'); if (padrao.has(pref)) escolhas.push(`sem ${pref} por ${r.rotulo}`);
  }
  for (const c of CODES) if (!val.has(c)) { val.set(c, padrao.has(c)); origem.set(c, 'sem-restricao'); }
  const caps = [...CODES].filter((c) => val.get(c));
  derivacao[p] = { caps, origem, escolhas, padrao };
}

// full_catalog: o conjunto derivado de admin_geral/gestor tem de ser o catálogo inteiro
const fullOk = ['admin_geral', 'gestor'].map((p) => ({ p, faltam: [...CODES].filter((c) => !derivacao[p].caps.includes(c)) }));

// modelos finais: full_catalog = catálogo inteiro; os demais = o derivado
const M = {};
for (const p of P) {
  const caps = ATTR[p].full_catalog ? [...CODES] : derivacao[p].caps;
  M[p] = { code: p, caps: new Set(caps), attrs: ATTR[p] };
}
// perfis_de_hoje finais (a partir dos modelos) e correções do catálogo
const correcoes = [];
for (const c of catalogo) {
  const novo = P.filter((p) => M[p].caps.has(c.code));
  const antes = c.perfis_de_hoje;
  const mais = novo.filter((p) => !antes.includes(p)); const menos = antes.filter((p) => !novo.includes(p));
  if (mais.length || menos.length) correcoes.push({ code: c.code, mais, menos });
  c.perfis_de_hoje_final = novo;
}

// ------------------------------------------------------------------ modelos de atalho (sistema, nascem sem vínculo)
const SOMENTE_PDV = ['pdv.sell', 'pdv.cash.operate', 'pdv.payment.charge', 'pdv.device_login', 'fiscal.sale.emit', 'customers.contact.view', 'integrations.card_terminal.view', 'integrations.card_terminal.operate'];
const ATALHOS = {
  somente_pdv: { nome: 'Somente PDV', default_workshops: 'todas', caps: SOMENTE_PDV },
  pdv_painel: { nome: 'PDV + Painel', default_workshops: 'todas', caps: [...SOMENTE_PDV, 'dashboard.view'] },
  estoque: { nome: 'Estoque', default_workshops: 'todas', caps: ['inventory.view', 'inventory.manage', 'inventory.adjust.approve', 'inventory.units.view', 'inventory.units.manage'] },
  financeiro_relatorios: { nome: 'Financeiro e Relatórios', default_workshops: 'todas', caps: ['finance.view', 'finance.advanced.view', 'finance.manage', 'finance.commissions.manage', 'finance.acquirers.manage', 'finance.bank_reconciliation.manage', 'reports.central.view', 'reports.bi.view'] },
  tecnico_oficina: { nome: 'Técnico da oficina', default_workshops: 'membro', caps: ['workshop.kanban.view', 'workshop.orders.open', 'workshop.orders.move', 'workshop.orders.assume', 'workshop.orders.plan', 'workshop.parts.use', 'workshop.labor.manage', 'workshop.orders.complete', 'workshop.quote.request', 'workshop.equipment.view'] },
  oficina_consulta: { nome: 'Oficina: consulta', default_workshops: 'membro', caps: ['workshop.kanban.view', 'workshop.equipment.view'] },
  gerente_operacao_loja: { nome: 'Gerente da loja (operação)', default_workshops: 'todas', caps: [...SOMENTE_PDV.filter((c) => c !== 'pdv.device_login'), 'pdv.supervise', 'dashboard.view', 'dashboard.money.view', 'sales.view', 'sales.supervise', 'sales.quotes.manage', 'sales.quotes.cancel', 'sales.returns.operate', 'sales.cancel.direct', 'inventory.view', 'inventory.manage', 'inventory.adjust.approve', 'inventory.cost.view', 'products.view', 'finance.view', 'finance.advanced.view', 'finance.manage', ...APPROVALS] },
};
for (const [k, v] of Object.entries(ATALHOS)) for (const c of v.caps) if (!CODES.has(c)) throw new Error(`atalho ${k}: ${c}`);
const modeloObj = (code) => (ATTR[code] ? M[code] : { code, caps: new Set(ATALHOS[code].caps), attrs: { full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: ATALHOS[code].default_workshops } });

// ------------------------------------------------------------------ veredito de cada ponto
function classificarTela(s) {
  if (s.base === 'environments.ts' && s.tipo === 'tela-rota') return 'constante-de-ambiente';
  if (/\(grupo/.test(String(s.tela))) return 'grupo-do-menu';
  if (s.tipo === 'atalho-admin') return 'definicao';
  return s.tipo;
}
const naoListadas = [];
for (const s of pontos) {
  const ov = s.ov;
  s.categoria = ov?.categoria ?? (ehTela(s) ? classificarTela(s) : s.tipo === 'rota' ? 'guarda' : s.tipo === 'publica' ? 'publica' : 'servico-ator');
  if (!ov && !ehTela(s) && RE_BANCADA.test(String(s.guarda_hoje)) && RE_TODAS_A_G_O(s)) {
    s.categoria = 'escopo-bancada';
    s.pred = (m) => has(m, 'workshop.admin');
    s.regra_final = 'bancadasDoVinculo (§3.1); todas = workshop.admin';
    if (/resolveWorkshop\(/.test(String(s.guarda_hoje))) s.mudanca_associada = 'D3';
  }
  if (ov?.regra) s.regra_final = ov.regra;
  if (ov?.associada) s.mudanca_associada = ov.associada;
  s.conflito = ov?.conflito ?? null;
  // marcadores
  if (s.x.op === 'marcador') {
    s.marcador = s.x.raw === 'SO_AUTENTICADO' ? (s.tipo === 'rota' ? "soAutenticado('motivo')" : 'SO_AUTENTICADO') : "rotaPublica('motivo')";
    s.alcance_dia1 = s.x.raw === 'SO_AUTENTICADO' ? P.slice() : s.perfis_hoje;
    s.veredito = s.x.raw === 'SO_AUTENTICADO' ? (s.perfis_hoje.length === 11 ? 'igual' : 'muda') : 'igual (pública)';
    s.ganha = []; s.perde = [];
    continue;
  }
  if (s.tipo === 'rota') s.marcador = s.x.op === 'cap' ? `requireCapability('${s.x.args[0]}')` : s.x.op === 'qualquer' ? `requireAnyCapability(${s.x.args.map((a) => `'${a}'`).join(', ')})` : `requireAllCapabilities(${s.x.args.map((a) => `'${a}'`).join(', ')})`;
  if (ov?.fixo) { s.veredito = ov.fixo; s.ganha = []; s.perde = []; s.alcance_dia1 = null; if (ov.mudanca) s.mudanca = ov.mudanca; continue; }
  const pred = ov?.pred ?? s.pred ?? ((m) => passa(s.x, m));
  let R = null;
  if (!ehTela(s) && s.tipo !== 'rota') {
    const rk = ov?.rota ?? (s.metodo && s.caminho ? chaveRota(s) : null);
    const r = rk ? rotaPorChave.get(rk) : null;
    if (r) R = r.perfis_hoje;
  }
  const universo = P.filter((p) => (!R || R.includes(p)) && (!ov?.alcance || ov.alcance(M[p])));
  const esperado = (ov?.esperado ?? s.perfis_hoje).filter((p) => universo.includes(p));
  const novo = universo.filter((p) => pred(M[p]));
  s.ganha = novo.filter((p) => !esperado.includes(p));
  s.perde = esperado.filter((p) => !novo.includes(p));
  s.alcance_dia1 = novo;
  s.comparado_entre = R ? `quem alcança ${ov?.rota ?? chaveRota(s)}` : ov?.alcance ? 'quem tem group.companies.manage' : 'os 11 modelos';
  if (!s.ganha.length && !s.perde.length) { s.veredito = 'igual'; continue; }
  // mudança: tem de estar listada
  let d = ov?.mudanca ?? null;
  if (!d && ehTela(s)) {
    if (s.categoria === 'constante-de-ambiente') { s.veredito = 'n/a (constante de ambiente: mecanismo; o veredito é o da página)'; continue; }
    if (s.tela && /^\/pdv\b/.test(s.tela) && s.perde.includes('estoquista')) d = 'D4';
    else d = 'D6';
  }
  if (!d) naoListadas.push(s);
  s.mudanca = d;
  s.veredito = `muda${d ? ' (' + d + ')' : ' (NÃO LISTADA)'}`;
}

// divergências fatia × tsv do arquiteto (só rotas)
const tsv = fs.readFileSync('mapa-rota-capability.tsv', 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
const PREFIXO = { 'core.ts': '/core', 'auth.ts': '/auth', 'logistics.ts': '/logistics', 'payment-terminals.ts': '/payment-terminals', 'storefront.ts': '/loja' };
const divergTsv = [];
let casadasTsv = 0;
for (const r of tsv) {
  const cands = pontos.filter((s) => ehRota(s) && s.base === r[0] && s.metodo === r[2] && s.caminho && (s.caminho === (PREFIXO[r[0]] ?? '') + r[3] || (!PREFIXO[r[0]] && s.caminho.endsWith(r[3]) && /^\/[a-z-]+$/.test(s.caminho.slice(0, s.caminho.length - r[3].length)))));
  if (!cands.length) continue;
  casadasTsv++;
  for (const s of cands) {
    s.capability_tsv = r[6];
    const a = String(s.capability_fatia).replace(/\s+/g, ''); const b = r[6].replace(/\s+/g, '');
    const iguais = a === b || (a === 'PUBLICA' && (b === 'PUBLICA' || b.startsWith('rotaPublica')));
    if (!iguais) { s.divergencia_tsv = true; divergTsv.push(s); }
  }
}

// ------------------------------------------------------------------ totais
const rotasUnicas = []; const vistasR = new Set();
for (const s of pontos) if (ehRota(s) && s.metodo && !vistasR.has(chaveRota(s))) { vistasR.add(chaveRota(s)); rotasUnicas.push(s); }
for (const s of pontos) if (ehRota(s) && s.metodo) { const primeira = rotasUnicas.find((r) => chaveRota(r) === chaveRota(s)); if (primeira !== s) s.duplicado_de = primeira.id; }
const guardadas = rotasUnicas.filter((s) => s.x.op !== 'marcador' || s.x.raw === 'SO_AUTENTICADO');
const publicas = rotasUnicas.filter((s) => s.x.op === 'marcador' && s.x.raw === 'PUBLICA');
const conta = (xs, f) => xs.reduce((a, s) => { const k = f(s); a[k] = (a[k] || 0) + 1; return a; }, {});

// ------------------------------------------------------------------ cenários A–J
const EMP = ['preco-justo', 'gringa', 'me-mimei', 'conceito', 'pj-motors', 'oficina'];
const LOJAS = EMP.filter((e) => e !== 'oficina');
const TEC = ['workshop.orders.assume', 'workshop.orders.plan', 'workshop.parts.use', 'workshop.labor.manage', 'workshop.orders.complete'];
const v = (empresa, modelo, extra = {}) => ({ empresa, modelo, grants: [], revokes: [], terminais: 'todos', bancadas: null, ...extra });
const CENARIOS = {
  A: { titulo: 'Só o PDV da Preço Justo', vinculos: [v('preco-justo', 'somente_pdv')] },
  B: { titulo: 'PDV Preço Justo + PDV Gringa, sem gestor', vinculos: [v('preco-justo', 'somente_pdv'), v('gringa', 'somente_pdv')] },
  C: { titulo: 'Todos os PDVs, sem administração', vinculos: [...LOJAS.map((e) => v(e, 'somente_pdv')), v('oficina', 'somente_pdv', { grants: ['workshop.checkout'], bancadas: 'todas' })] },
  D: { titulo: 'Todos os PDVs + página principal do gestor, sem Fiscal/Usuários/Configuração', vinculos: [...LOJAS.map((e) => v(e, 'pdv_painel')), v('oficina', 'pdv_painel', { grants: ['workshop.checkout'], bancadas: 'todas' })] },
  E: { titulo: 'Só Gestor → Estoque', vinculos: [v('preco-justo', 'estoque')] },
  F: { titulo: 'Gestor → Financeiro + Relatórios', vinculos: [v('preco-justo', 'financeiro_relatorios')] },
  G: { titulo: 'Só Oficina → Kanban/OS (técnico)', vinculos: [v('oficina', 'tecnico_oficina', { bancadas: ['<bancada-1>'] })] },
  H: { titulo: 'Oficina Kanban + PDV Oficina', vinculos: [v('oficina', 'operador_caixa_oficina', { grants: TEC, bancadas: ['<bancada-1>'] })] },
  I: { titulo: 'Gerente da Preço Justo (PDV, estoque, vendas, financeiro), sem as outras empresas', vinculos: [v('preco-justo', 'gerente_operacao_loja')] },
  J: { titulo: 'Administrador do grupo (todas as empresas, todos os módulos)', vinculos: EMP.map((e) => v(e, 'admin_geral')) },
};
const CASAS = [['dashboard.view', '/sistema/painel'], ['pdv.sell', '/pdv'], ['workshop.kanban.view', '/sistema/oficina'], ['accounting.closing.view', '/sistema/fiscal/fechamento'], ['inventory.view', '/sistema/estoque'], ['finance.view', '/sistema/financeiro'], ['sales.view', '/sistema/vendas'], ['products.view', '/sistema/produtos'], ['reports.bi.view', '/sistema/relatorios/bi'], ['users.view', '/sistema/usuarios'], ['group.companies.manage', '/sistema/empresas']];
const casaDe = (caps) => (CASAS.find(([c]) => caps.has(c)) ?? [null, '/sem-acesso'])[1];
const SONDAS = ['POST /core/sales', 'POST /core/cash/open', 'POST /core/pdv/terminal/charge', 'POST /core/fiscal/sales/:saleId/emit', 'GET /core/products/search', 'GET /core/customers', 'GET /core/sales', 'POST /core/quotes/:id/cancel',
  'GET /core/dashboard', 'GET /core/stock', 'POST /core/stock/movements', 'GET /core/finance/entries', 'GET /core/finance/cash-flow', 'GET /core/reports', 'GET /core/insights/operations',
  'PATCH /core/fiscal/config', 'GET /core/fiscal/documents', 'GET /core/team', 'GET /core/audit', 'GET /core/workshop/orders', 'POST /core/workshop/orders/:id/assume', 'GET /core/workshop/pending-payment',
  'POST /core/workshop/orders/:id/checkout', 'POST /core/companies', 'POST /auth/device/enroll'];
for (const k of SONDAS) if (!rotaPorChave.has(k)) throw new Error('sonda sem rota: ' + k);
const cenariosOut = {};
for (const [id, c] of Object.entries(CENARIOS)) {
  const porEmpresa = {};
  for (const vin of c.vinculos) {
    const base = modeloObj(vin.modelo);
    const caps = new Set([...base.caps, ...vin.grants].filter((x) => !vin.revokes.includes(x)));
    const m = { code: vin.modelo, caps, attrs: base.attrs };
    const passam = guardadas.filter((r) => r.x.op === 'marcador' || passa(r.x, m));
    const bancadaCaps = [...caps].filter((x) => CAT[x].escopo === 'bancada');
    porEmpresa[vin.empresa] = {
      modelo: vin.modelo, grants: vin.grants, revokes: vin.revokes, terminais: vin.terminais,
      bancadas: bancadaCaps.length ? (vin.bancadas ?? (base.attrs.default_workshops === 'todas' ? 'todas' : 'OBRIGATÓRIO ESCOLHER')) : null,
      capabilities: [...caps].sort(), n_capabilities: caps.size, casa: casaDe(caps), rotas_que_passam: passam.length,
      sondas_2xx: SONDAS.filter((k) => passa(rotaPorChave.get(k).x, m)), sondas_403: SONDAS.filter((k) => !passa(rotaPorChave.get(k).x, m)),
      tem_group_admin: caps.has('group.admin'),
    };
  }
  cenariosOut[id] = { titulo: c.titulo, vinculos: c.vinculos, por_empresa: porEmpresa, empresas_fora_do_escopo: EMP.filter((e) => !porEmpresa[e]) };
}

// ------------------------------------------------------------------ comparação com _modelos-dia1.json
const dia1 = LER('_modelos-dia1.json');
const difDia1 = {};
for (const p of P) { const a = new Set(dia1[p] ?? []); const b = M[p].caps; difDia1[p] = { mais: [...b].filter((c) => !a.has(c)), menos: [...a].filter((c) => !b.has(c)) }; }

// ------------------------------------------------------------------ capabilities usadas sozinhas com listas diferentes (conflito latente)
const listasPorCap = {};
for (const r of restricoes) if (r.x.op === 'cap' && !r.R) { const k = r.x.args[0]; const l = [...r.S].sort().join(','); (listasPorCap[k] = listasPorCap[k] || {}); (listasPorCap[k][l] = listasPorCap[k][l] || []).push(r.rotulo); }
const capsComListasDiferentes = Object.entries(listasPorCap).filter(([, ls]) => Object.keys(ls).length > 1);

// ------------------------------------------------------------------ SAÍDA 1: catalogo-final.json
const usoRota = {}; const usoServ = {}; const usoTela = {};
for (const s of pontos) { if (s.x.op === 'marcador') continue; const alvo = ehTela(s) ? usoTela : s.tipo === 'rota' ? usoRota : usoServ; if (s.tipo === 'rota' && s.duplicado_de) continue; for (const a of new Set(s.x.args)) alvo[a] = (alvo[a] || 0) + 1; }
const catalogoFinal = catalogo.map((c) => ({
  code: c.code, area: c.area, pagina: c.pagina, label: c.label, descricao: c.descricao, escopo: c.escopo, leitura_ou_escrita: c.leitura_ou_escrita,
  perfis_de_hoje: c.perfis_de_hoje_final, desde: 1,
  modelos_padrao: [...P.filter((p) => M[p].caps.has(c.code)), ...Object.keys(ATALHOS).filter((k) => ATALHOS[k].caps.includes(c.code))],
  rotas_que_cobram: usoRota[c.code] ?? 0, pontos_de_servico: usoServ[c.code] ?? 0, pontos_de_tela: usoTela[c.code] ?? 0,
  origem: c.origem,
}));
fs.writeFileSync('catalogo-final.json', JSON.stringify({ base: BASE, catalog_version: 1, total: catalogoFinal.length, novas: NOVAS.map((n) => n.code), capabilities: catalogoFinal }, null, 1));

// ------------------------------------------------------------------ SAÍDA 2: mapa-final.json
const mapaPontos = pontos.map((s) => ({
  id: s.id, fatia: s.fatia, arquivo: s.arquivo, linha: s.linha, linha_rota: s.linha_rota ?? null, tipo: s.tipo, categoria: s.categoria,
  metodo: s.metodo ?? null, caminho: s.caminho ?? null, tela: s.tela ?? null,
  guarda_hoje: s.guarda_hoje, perfis_hoje: s.perfis_hoje,
  capability_fatia: s.capability_fatia, capability_tsv: s.capability_tsv ?? null, capability_final: s.capability_final,
  guarda_nova: s.marcador ?? null, regra_final: s.regra_final ?? null, escopo: s.escopo,
  alcance_dia1: s.alcance_dia1, comparado_entre: s.comparado_entre ?? null, veredito: s.veredito, ganha: s.ganha, perde: s.perde,
  mudanca: s.mudanca ?? null, mudanca_associada: s.mudanca_associada ?? null, conflito: s.conflito, duplicado_de: s.duplicado_de ?? null,
  divergencia_tsv: !!s.divergencia_tsv, rotas_servidor: s.rotas_servidor ?? null, nota: s.nota,
}));
const totais = {
  pontos: pontos.length, por_fatia: conta(pontos, (s) => s.fatia), por_tipo: conta(pontos, (s) => s.tipo), por_categoria: conta(pontos, (s) => s.categoria),
  rotas_unicas: rotasUnicas.length, rotas_guardadas: guardadas.length, rotas_publicas: publicas.length,
  rotas_guardadas_por_guarda: conta(guardadas, (s) => (s.x.op === 'marcador' ? 'soAutenticado' : s.x.op)),
  veredito: conta(pontos, (s) => String(s.veredito).replace(/ \(.*$/, '').replace(/^n\/a.*/, 'n/a').replace(/^igual por.*/, 'igual (regra)')),
  rotas_veredito: conta(rotasUnicas, (s) => String(s.veredito).replace(/ \(.*$/, '')),
  mudancas_nao_listadas: naoListadas.length, tsv_casadas: casadasTsv, tsv_divergentes: divergTsv.length,
};
fs.writeFileSync('mapa-final.json', JSON.stringify({ base: BASE, gerado_por: '_consolidar.mjs', legenda: { A: 'admin_geral', G: 'gestor', L: 'gerente_loja', O: 'gerente_oficina', E: 'estoquista', T: 'atendente', C: 'operador_caixa', CL: 'operador_caixa_loja', CO: 'operador_caixa_oficina', M: 'mecanico', K: 'contador' }, totais, pontos: mapaPontos }, null, 1));

// ------------------------------------------------------------------ SAÍDA 3: modelos.json
const modelosOut = {};
for (const p of P) {
  const d = derivacao[p]; const caps = [...M[p].caps].sort();
  const org = {}; for (const c of caps) { const o = ATTR[p].full_catalog ? 'full_catalog' : d.origem.get(c); (org[o] = org[o] || []).push(c); }
  modelosOut[p] = {
    code: p, ...ATTR[p], origin: 'sistema', n_capabilities: caps.length, capabilities: caps,
    derivacao: Object.fromEntries(Object.entries(org).map(([k, xs]) => [k, xs.length])),
    sem_restricao: ATTR[p].full_catalog ? [] : org['sem-restricao'] ?? [],
    escolhas_de_clausula_fora_do_catalogo: d.escolhas,
    conflitos: conflitosSolver.filter((c) => c.perfil === p).map((c) => c.capability),
    diferenca_vs_modelos_dia1_json: difDia1[p],
  };
}
fs.writeFileSync('modelos.json', JSON.stringify({
  base: BASE, gerado_por: '_consolidar.mjs', catalog_version: 1, n_catalogo: CODES.size,
  regra: 'Para cada restrição vinculante (rota guardada, ou ponto de serviço decidido pela capability do ator, comparado entre quem alcança a rota), "o perfil passava hoje" == "o modelo passa a expressão". Capability sem restrição nenhuma para o perfil herda o padrão do catálogo (sem_restricao).',
  full_catalog_consistente: fullOk, modelos_de_sistema: modelosOut,
  modelos_de_atalho: Object.fromEntries(Object.entries(ATALHOS).map(([k, a]) => [k, { code: k, nome: a.nome, origin: 'sistema', full_catalog: 0, assignable_by: 'gestao_da_empresa', default_workshops: a.default_workshops, hidden: 0, nasce_sem_vinculo: true, n_capabilities: a.caps.length, capabilities: [...a.caps].sort() }])),
  conflitos: conflitosSolver, cenarios: cenariosOut,
}, null, 1));

// ------------------------------------------------------------------ SAÍDA 4: equivalencia.md
const L = [];
const w = (s = '') => L.push(s);
const rotasPorModelo = {};
for (const p of P) {
  let hoje = 0, amanha = 0, iguais = 0, ganha = 0, perde = 0; const listaG = [], listaP = [];
  for (const r of guardadas) {
    const h = r.perfis_hoje.includes(p); const a = r.x.op === 'marcador' ? true : passa(r.x, M[p]);
    hoje += h; amanha += a; if (h === a) iguais++; else if (a) { ganha++; listaG.push(chaveRota(r)); } else { perde++; listaP.push(chaveRota(r)); }
  }
  const serv = pontos.filter((s) => !ehTela(s) && s.tipo !== 'rota' && s.tipo !== 'publica');
  const sm = serv.filter((s) => !s.categoria.startsWith('alvo') && (s.ganha?.includes(p) || s.perde?.includes(p)));
  const sa = pontos.filter((s) => s.categoria.startsWith('alvo') && (s.ganha?.includes(p) || s.perde?.includes(p)));
  const tela = pontos.filter((s) => ehTela(s) && !['constante-de-ambiente', 'alvo', 'alvo-formulario', 'voz', 'definicao'].includes(s.categoria));
  const tg = tela.filter((s) => s.ganha?.includes(p)); const tp = tela.filter((s) => s.perde?.includes(p));
  rotasPorModelo[p] = { hoje, amanha, iguais, ganha, perde, listaG, listaP, serv_muda: sm.length, alvo_muda: sa.length, tela_ganha: tg, tela_perde: tp };
}
w('# Equivalência dia 1: modelo × rota');
w();
w(`Base: ${BASE}. Calculado por \`_consolidar.mjs\` sobre as 11 fatias (\`sites-*.json\`), o catálogo final (${CODES.size} capabilities) e os modelos derivados (\`modelos.json\`). Nada foi executado no repositório; o veredito é estático (expressão × modelo), o mesmo cálculo que o T1 do desenho vai congelar.`);
w();
w('Legenda das colunas de perfil: A admin_geral, G gestor, L gerente_loja, O gerente_oficina, E estoquista, T atendente, C operador_caixa (legado), CL operador_caixa_loja, CO operador_caixa_oficina, M mecanico, K contador.');
w();
w('Legenda das células: `x` passa hoje e passa no dia 1; `.` não passa nos dois; `+` passa a passar; `-` deixa de passar.');
w();
w('## 1. Resumo por modelo');
w();
w(`Rotas guardadas únicas: **${guardadas.length}** (${guardadas.filter((r) => r.x.op === 'marcador').length} só autenticadas, ${guardadas.length - guardadas.filter((r) => r.x.op === 'marcador').length} com capability). Rotas públicas: ${publicas.length}. Total de rotas únicas: ${rotasUnicas.length}.`);
w();
w('| modelo | capabilities | rotas hoje | rotas dia 1 | iguais | ganha | perde | pontos de serviço que mudam (como ator) | regras sobre o ALVO que mudam (D11) | pontos de tela que aparecem | pontos de tela que somem |');
w('|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of P) { const r = rotasPorModelo[p]; w(`| \`${p}\` | ${M[p].caps.size} | ${r.hoje} | ${r.amanha} | ${r.iguais} | ${r.ganha} | ${r.perde} | ${r.serv_muda} | ${r.alvo_muda} | ${r.tela_ganha.length} | ${r.tela_perde.length} |`); }
w();
w('"Pontos de serviço que mudam (como ator)" é só a D10 (login por token de dispositivo) para quem não é caixa. "Regras sobre o ALVO" é a D11: o modelo deixa de ser OBRIGADO a ter bancada específica ao ser cadastrado; o acesso de quem opera não muda.');
w();
w('Onde há `ganha`/`perde` nas rotas:');
w();
for (const p of P) { const r = rotasPorModelo[p]; if (r.ganha || r.perde) w(`- \`${p}\`: ganha ${r.listaG.join(', ') || '—'}; perde ${r.listaP.join(', ') || '—'}.`); }
w();
w(`Veredito de todos os ${pontos.length} pontos (rotas, serviços e tela): ${Object.entries(totais.veredito).map(([k, n]) => `${k} ${n}`).join(' · ')}. Mudanças não listadas: **${naoListadas.length}**.`);
w();
w('## 2. Tabela modelo × rota (servidor)');
w();
w('Uma linha por rota guardada única (método + caminho). A coluna "D" traz a mudança deliberada quando há.');
w();
w('<details><summary>Abrir a tabela completa (' + guardadas.length + ' rotas)</summary>');
w();
w('| # | rota | guarda nova | A | G | L | O | E | T | C | CL | CO | M | K | veredito |');
w('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
guardadas.forEach((r, i) => {
  const cel = P.map((p) => { const h = r.perfis_hoje.includes(p); const a = r.x.op === 'marcador' ? true : passa(r.x, M[p]); return h && a ? 'x' : !h && !a ? '.' : a ? '+' : '-'; });
  w(`| ${i + 1} | \`${r.metodo} ${r.caminho}\` (${r.base}:${r.linha}) | \`${r.capability_final}\` | ${cel.join(' | ')} | ${r.veredito}${r.mudanca_associada ? ' · ' + r.mudanca_associada : ''} |`);
});
w();
w('</details>');
w();
w('## 3. Pontos de serviço (fora do guarda da rota)');
w();
const servPts = pontos.filter((s) => !ehTela(s) && s.tipo !== 'rota' && s.tipo !== 'publica');
w(`São ${servPts.length} pontos. Veredito: ${Object.entries(conta(servPts, (s) => String(s.veredito).replace(/ \(.*$/, '').replace(/^n\/a.*/, 'n/a').replace(/^igual por.*/, 'igual (regra)'))).map(([k, n]) => `${k} ${n}`).join(' · ')}. A tabela abaixo mostra só os que precisaram de regra própria (categoria diferente de "servico-ator" comum) ou mudam; os demais são "igual" com a capability pura.`);
w();
w('**§3.1 `bancadasDoVinculo`** (desenho §7.2, corrigido): `all_workshops = 1`, ou NULL com `default_workshops = todas` no modelo → todas as bancadas ATIVAS da empresa; senão as de `core_workshop_members` em bancadas ATIVAS; vazio = nenhuma. O passo 86 grava `all_workshops = 1` para quem tem `workshop.admin` (hoje: admin_geral, gestor, gerente_oficina) e para os não-membros de bancada ativa que não são mecânico (o fallback de core.ts:7383-7384). Nos pontos marcados "todas = workshop.admin", o conjunto de hoje (quem vê todas por código de perfil) é exatamente o de `workshop.admin`; a capability da rota não muda.');
w();
w('| ponto | categoria | regra no dia 1 | hoje | dia 1 | veredito |');
w('|---|---|---|---|---|---|');
for (const s of servPts) {
  if (s.categoria === 'servico-ator' && s.veredito === 'igual' && !s.mudanca_associada) continue;
  w(`| ${s.base}:${s.linha}${s.caminho ? ' `' + s.metodo + ' ' + s.caminho + '`' : ''} | ${s.categoria} | ${(s.regra_final ?? '`' + s.capability_final + '`').replace(/\|/g, '/')} | ${ab(s.perfis_hoje.filter((p) => P.includes(p)))} | ${s.alcance_dia1 ? ab(s.alcance_dia1) : '—'} | ${s.veredito}${s.mudanca_associada ? ' · ' + s.mudanca_associada : ''} |`);
}
w();
w('## 4. Tela (menu, rotas do navegador e botões)');
w();
const telaPts = pontos.filter((s) => ehTela(s));
w(`São ${telaPts.length} pontos de tela. Veredito: ${Object.entries(conta(telaPts, (s) => String(s.veredito).replace(/^n\/a.*/, 'n/a'))).map(([k, n]) => `${k} ${n}`).join(' · ')}. O servidor é a fonte da verdade: toda diferença da tela abaixo é a tela passando a dizer o que o servidor já responde (D6), ou a porta que batia na cara fechando (D4/D6). O detalhe por página está em \`conflitos.md\` §3.`);
w();
w('| modelo | páginas/itens que aparecem | páginas/itens que somem |');
w('|---|---|---|');
for (const p of P) { const r = rotasPorModelo[p]; const f = (xs) => [...new Set(xs.map((s) => s.tela))].join(', ') || '—'; w(`| \`${p}\` | ${f(r.tela_ganha)} | ${f(r.tela_perde)} |`); }
w();
w('## 5. Cenários A–J (fixtures de teste)');
w();
w('Cada cenário é um conjunto de vínculos `{empresa, modelo, grants, revokes, terminais, bancadas}`. As empresas são as seis do seed (`server/src/db/seed.ts:53-58`). "terminais: todos" = `all_terminals=1` (na empresa com 0 caixas é o "PDV único"); para a variante com caixas, a fixture troca por `[<caixa-1>]` e acrescenta o caso 403 do caixa fora do escopo (T6). `<bancada-1>` é criada pela própria fixture. O JSON completo, com a lista de capabilities por empresa, está em `modelos.json` → `cenarios`.');
w();
w('| cenário | vínculos | capabilities por vínculo | casa | rotas que passam | sondas 2xx | sondas 403 (API direta) |');
w('|---|---|---|---|---|---|---|');
for (const [id, c] of Object.entries(cenariosOut)) {
  const emps = Object.entries(c.por_empresa);
  const um = emps[0][1];
  const desc = c.vinculos.map((x) => `${x.empresa}: \`${x.modelo}\`${x.grants.length ? ' +' + x.grants.length + ' grant(s)' : ''}${x.bancadas ? ' · bancadas ' + (Array.isArray(x.bancadas) ? x.bancadas.join(',') : x.bancadas) : ''}`).join('<br>');
  const ncaps = [...new Set(emps.map(([, e]) => e.n_capabilities))].join(' / ');
  w(`| **${id}** ${c.titulo} | ${desc} | ${ncaps} | ${[...new Set(emps.map(([, e]) => e.casa))].join(' / ')} | ${[...new Set(emps.map(([, e]) => e.rotas_que_passam))].join(' / ')} | ${um.sondas_2xx.length} | ${um.sondas_403.length} |`);
}
w();
w('Sondas (as mesmas 25 rotas para todo cenário; a fixture cobra 2xx/403 exatamente como abaixo, no primeiro vínculo do cenário):');
w();
for (const [id, c] of Object.entries(cenariosOut)) {
  const [emp, e] = Object.entries(c.por_empresa)[0];
  w(`- **${id}** (${emp}): 2xx → ${e.sondas_2xx.map((s) => '`' + s + '`').join(', ') || '—'}. 403 → ${e.sondas_403.map((s) => '`' + s + '`').join(', ') || '—'}. Empresas fora do escopo (troca de empresa recusada, 403 em qualquer rota com companyId delas): ${c.empresas_fora_do_escopo.join(', ') || 'nenhuma'}.`);
}
w();
w('Capabilities de cada cenário (primeiro vínculo; os demais vínculos do mesmo cenário usam o mesmo modelo, e a Oficina de C/D acrescenta `workshop.checkout`):');
w();
for (const [id, c] of Object.entries(cenariosOut)) { const e = Object.values(c.por_empresa)[0]; w(`- **${id}**: ${e.n_capabilities === CODES.size ? 'catálogo inteiro (full_catalog)' : e.capabilities.map((x) => '`' + x + '`').join(', ')}${e.bancadas ? ' · bancadas: ' + (Array.isArray(e.bancadas) ? e.bancadas.join(',') : e.bancadas) : ''} · terminais: ${e.terminais}.`); }
w();
w('Observações que as fixtures têm de cobrir:');
w();
w('- **A/B/C** usam o mesmo modelo "Somente PDV"; B e C diferem só no número de vínculos. A troca de empresa (`POST /auth/switch-company`) só aceita as empresas do vínculo (`auth.ts:895-932`), e a sessão fica numa empresa por vez.');
w('- **D** é "Somente PDV" + `dashboard.view`. O painel sai sem dinheiro (`dashboard.money.view` fora), salvo a política de gestão da empresa ligar (`PoliticaDeGestaoService.ts:159-171`). `fiscal.sale.emit` é a nota DA VENDA, parte do PDV, não o Fiscal do escritório; a página `/sistema/fiscal/documentos` abre para quem tem `fiscal.sale.emit` (D6) — se o dono quiser D sem essa página, a fixture revoga `fiscal.sale.emit` e o PDV deixa de emitir (ver dúvida no relatório).');
w('- **G** exige a lista de bancadas (`default_workshops = membro`); sem bancada, 400 `CORE_WORKSHOP_SCOPE_REQUIRED`. **H** também, porque os 5 grants são de escopo bancada.');
w('- **E** carrega GET /core/stock (`inventory.view`, core.ts:2831) e as subpáginas de movimentações, locais, validade, inventário e unidades (tela-rotas-menu, gsRoutes.tsx:239, 525, 601, 602, 615, 616), todas dentro do modelo "Estoque". O modelo não tem `products.view`: se o formulário de movimentar buscar produto fora de GET /core/stock, a T4 acusa e o modelo ganha `products.view` (dúvida ao dono). A importação por planilha (`products.manage`) fica fora de E de propósito.');
w('- **I** usa `gerente_operacao_loja`, nunca `gestor` (o código `gestor` é o par do administrador, desenho §3.1).');
w('- **J** tem `group.admin` em todas as ativas: é o que define "administrador do grupo" (`listGroupAdmins`), e o invariante `CORE_LAST_GROUP_ADMIN` (desenho §9.4) tem de valer.');
fs.writeFileSync('equivalencia.md', L.join('\n') + '\n');

// ------------------------------------------------------------------ SAÍDA 5: conflitos.md
const C = [];
const c = (s = '') => C.push(s);
const d6 = pontos.filter((s) => ehTela(s) && (s.mudanca === 'D6' || s.mudanca === 'D4'));
c('# Conflitos e mudanças deliberadas');
c();
c(`Base: ${BASE}. Calculado por \`_consolidar.mjs\`. Um CONFLITO é um lugar onde "o perfil passava hoje" == "o modelo tem a capability da rota" não pode valer para todas as rotas ao mesmo tempo, ou onde a capability pura mudaria o comportamento de um ponto. Nada aqui foi escondido: o solver acusa todo par (perfil, capability) forçado a verdadeiro por uma restrição e a falso por outra.`);
c();
c('## 1. Conflitos que o solver encontrou');
c();
c(`Restrições vinculantes: ${restricoes.length} (${restricoes.filter((r) => r.tipo === 'rota').length} rotas guardadas únicas + ${restricoes.filter((r) => r.tipo === 'servico').length} pontos de serviço decididos pela capability do ator). Conflitos: **${conflitosSolver.length}**. Sem resolução: **${conflitosSolver.filter((x) => !x.resolucao).length}**.`);
c();
for (const x of conflitosSolver) {
  c(`### ${x.resolucao?.conflito ?? 'C?'}: \`${x.perfil}\` × \`${x.capability}\``);
  c();
  c(`- Exige TRUE: ${x.a_favor.slice(0, 8).join('; ')}${x.a_favor.length > 8 ? `; e mais ${x.a_favor.length - 8}` : ''}.`);
  c(`- Exige FALSE: ${x.contra.join('; ')}.`);
  c(`- Resolução: ${x.resolucao ? `valor ${x.resolucao.valor}. ${x.resolucao.motivo}${x.resolucao.mudanca ? ' Mudança ' + x.resolucao.mudanca + '.' : ''}` : '**SEM RESOLUÇÃO**'}`);
  c();
}
c('Capabilities cobradas sozinhas por rotas com listas de perfis diferentes (o mesmo conflito, visto pela capability):');
c();
for (const [cap, ls] of capsComListasDiferentes) c(`- \`${cap}\`: ${Object.entries(ls).map(([l, rs]) => `{${ab(l.split(','))}} em ${rs.length} rota(s)${rs.length <= 3 ? ' (' + rs.join(', ') + ')' : ''}`).join(' × ')}.`);
if (!capsComListasDiferentes.length) c('- nenhuma.');
c();
c(`Consistência do administrador: ${fullOk.map((f) => `\`${f.p}\` ${f.faltam.length ? 'faltam ' + f.faltam.join(', ') : 'passa em toda restrição, portanto full_catalog reproduz o dia 1'}`).join('; ')}.`);
c();
c(`Correções que o solver impôs aos \`perfis_de_hoje\` do catálogo de entrada: ${correcoes.length ? correcoes.map((x) => `\`${x.code}\` +${ab(x.mais)} −${ab(x.menos)}`).join('; ') : 'nenhuma'} (o catálogo final grava o conjunto derivado).`);
c();
c('## 2. Conflitos de semântica (a capability pura mudaria o ponto) e a resolução');
c();
const CONF = [
  ['C1', 'pdv.sell × operador_caixa legado', 'core.ts:1523/1525 e 1594/1596 (POST /print/jobs, /reprint) deixam o legado fora; POST /core/sales (core.ts:5568) e o resto do PDV o deixam dentro.', 'Aceitar a mudança (D1). Uma capability só para excluir um código com 0 vínculos, que a tela já não cria (TeamService.ts:37-47), seria ruído. Quem ganha: `operador_caixa` (legado), 2 rotas de impressão.'],
  ['C2', 'Uma função de bancada × duas réguas de hoje', 'Kanban: resolveWorkshopScope mostra ao membro só as suas bancadas (core.ts:7364-7371), com fallback "empresa inteira" para não-membro (7383-7384). Entrada de OS: atendente e caixa da oficina abrem em QUALQUER bancada mesmo sendo membros (WorkshopIntakeService.ts:65-68). Com bancadasDoVinculo única, ou a entrada estreita, ou o kanban alarga.', 'Dividir a REGRA, não a capability: `bancadasDoVinculo` vale para ver/operar; a entrada abre em todas as bancadas ativas para `workshop.admin` ou `(workshop.orders.open e não workshop.orders.assume)`; o técnico (assume e não admin) abre só nas suas. Verificado no dia 1 em core.ts:7397, 9580, 9592, 10398 e WorkshopIntakeService.ts:44/65/73: igual para os 11. O passo 86 conta só bancadas ATIVAS (furo 1 da nota de core.ts:7375).'],
  ['C3', 'Decisões sobre o ALVO por código de perfil', 'EquipmentService.ts:171 (montador), TeamService.ts:161 (equipe da oficina), implantacaoPorEmpresa.ts:297/321 (checklist gerente/caixa), ProntidaoDasComunicacoes.ts:208 (contador), RecuperacaoDeSenhaDaEquipe.ts:204 (conta de dono), TerminaisPage.tsx:440 (quem recebe token). Com capability pura, os modelos full_catalog entram em todas as listas e os itens de checklist dariam PRONTO em falso.', 'Capability + o atributo `assignable_by` do modelo (dado editável, não código): "modelo não é assignable_by=grupo" separa as contas de dono, a mesma régua que o desenho §9.1 já usa para a recuperação de senha. Montador = assume ∧ ¬grupo; equipe da oficina = move ∧ ¬grupo; gerente = users.manage ∧ ¬grupo; caixa = pdv.device_login ∧ ¬grupo; contador = accounting.closing.view ∧ ¬dashboard.view. Todas iguais no dia 1 (tabela §3 de equivalencia.md).'],
  ['C4', 'pdv.cash.operate usado só para tirar o atendente', 'POST /core/quotes/:id/cancel (core.ts:5245-5260) e POST /core/consignments/:id/fechar (core.ts:5507-5515) guardavam todas(sales.*.manage, pdv.cash.operate), e nenhuma toca gaveta. Com lista de caixas no vínculo, a regra de escopo de PDV daria 409 no escritório.', 'Dividir: `sales.quotes.cancel` e `sales.consignment.close` (novas, escopo empresa), semeadas no conjunto exato de hoje {A,G,L,O,C,CL,CO}. /convert e /faturar continuam todas(..., pdv.cash.operate), porque viram venda com gaveta. O botão Cancelar de OrcamentosPage passa a `sales.quotes.cancel`.'],
  ['C5', 'Token de computador do caixa sem capability', 'TerminaisPage.tsx:440 decide por prefixo de código quem recebe token; o servidor não confere o alvo no enroll (auth.ts:457-500) e aceita login de dispositivo de qualquer perfil (auth.ts:401-404).', 'Nova `pdv.device_login` (escopo pdv), semeada em C, CL, CO (e em somente_pdv / pdv_painel). Tela: alvo com pdv.device_login ∧ ¬grupo = {C,CL,CO}, igual. Servidor: D9 e D10.'],
  ['C6', 'Capability de escopo grupo avaliada por empresa', 'system-admin.ts:73/83 (empresaDeGestao/temVinculoDeGestao) confere admin_geral/gestor NA empresa da URL; o catálogo dá escopo grupo a system.deploy.*.', 'Decisão: toda capability mora num vínculo e é avaliada no vínculo da empresa pedida (`capabilitiesDe(userId, companyId)`). "Escopo grupo" só significa "só quem tem group.admin entrega" (§9.2). Igual no dia 1.'],
  ['C7', 'O desenho §7.3 alargaria a trava de responsável', 'isManagerProfile NÃO libera a trava em addPart, setLabor, completeTechnical nem assumeOrder (WorkshopCoreService.ts:678, 1086, 1582, 1644); só em move, plan, release e return (792/801/888/966, WorkshopPartsService.ts:162).', 'Manter sem bypass nos quatro. Só move/plan/release/return traduzem para `workshop.admin`. Corrige o texto do §7.3.'],
  ['C8', 'Tradutor de requirePermission por string não é exato', 'payment-terminal.settings.manage cobre GET /local-agent/status (operate) e POST /local-agent/pairing (manage); homologation.run e transaction.create idem (nota de middleware/auth.ts:156).', 'A tabela `PERMISSAO_PARA_CAPABILITY` da F1 é por ROTA (método + caminho), não por string de permissão. A base da catraca é 76 chamadas vivas (medido), não 83.'],
  ['C9', 'Três réguas de custo', 'hideCost do razão (core.ts:3042: só o mecânico perde), veCustoDoEstoque (PoliticaDeGestaoService.ts:169: gerência ou política) e podeVerCusto das peças (WorkshopPartsService.ts:32: com estoquista). O atendente e o estoquista veem o custo unitário no razão mesmo com a política escondendo o custo em GET /stock.', 'Dia 1 exato com três capabilities: `inventory.view` (razão), `inventory.cost.view` (+política), `workshop.parts.cost.view`. Unificar é decisão do dono (R4).'],
  ['C10', 'Mapa do arquiteto × fatias', `${divergTsv.length} rotas têm expressão diferente entre \`mapa-rota-capability.tsv\` e as fatias.`, 'Vale a da fatia (leu o handler). Todas dão o mesmo conjunto no dia 1 (as rotas estão "igual" na equivalência). Lista abaixo.'],
  ['C11', 'Erros de texto do desenho', '§6.3 lista core.ts:5505 (fechar consignação) como chamador de terminalDoPedido, e não é (core.ts:5507-5515); o §6.3 esquece POST /workshop/orders/:id/checkout (core.ts:10212), onde o corpo vence o token; o §7.2 não diz que o passo 86 conta só bancadas ATIVAS; o §7.2 lista 5 pontos de resolveWorkshop e restam 2 (core.ts:9184, 10332); a tabela §11.2 contradiz a D6 em prontidão online, entrada de notas e cadastros do financeiro.', 'Corrigido aqui: a lista de pontos de requireTerminalNoEscopo perde 5505 e ganha 10212 (D12); passo 86 com bancadas ativas; as páginas seguem a expressão da rota que montam (prontidão e novo produto = products.manage; entrada de notas = purchases.receive; cadastros do financeiro = finance.advanced.view).'],
  ['C12', 'GERENCIA_DA_MAQUININHA com letra morta', 'payment-terminals.ts:72 lista gerente_oficina, mas o requirePermission que vem antes já o barra (Permissions.ts:74-77).', 'Os 11 pontos viram `integrations.card_terminal.manage` = {L} + donos, o alcance real de hoje. Se o dono quiser o gerente de oficina lá, é mudança a listar.'],
];
c('| id | conflito | evidência | resolução |');
c('|---|---|---|---|');
for (const [id, t, e, r] of CONF) c(`| ${id} | ${t} | ${e} | ${r} |`);
c();
c('Rotas em que a fatia e o mapa do arquiteto divergem (C10):');
c();
for (const s of divergTsv) c(`- \`${s.metodo} ${s.caminho}\` (${s.ref}): tsv \`${s.capability_tsv}\` → final \`${s.capability_final}\`; veredito ${s.veredito}.`);
c();
c('## 3. Mudanças deliberadas (a lista inteira; fora delas, o dia 1 é o de hoje)');
c();
const porD = (d) => pontos.filter((s) => s.mudanca === d || s.mudanca_associada === d);
const DS = [
  ['D1', 'O legado `operador_caixa` passa a poder POST /print/jobs e POST /print/jobs/:id/reprint.', 'core.ts:1523-1525, 1594-1596', 'C1. Código com 0 vínculos; a guarda de hoje se contradiz.'],
  ['D2', 'Sessão e refresh caem quando a empresa é desativada (401 API_SESSION_ENDED).', 'ContaDaSessao.ts:69-73; ApiAuthService.ts:226-230', 'Hoje a sessão numa empresa desativada segue valendo.'],
  ['D3', 'Os 2 pontos que ainda usam resolveWorkshop (GET /core/team?workshopId=, core.ts:9184; GET /core/equipment, core.ts:10332) passam a aceitar a bancada pedida por quem já via todas as bancadas pelo fallback; o fallback fecha para vínculos NOVOS.', 'core.ts:9184, 10332 (resolveWorkshop, core.ts:7284-7328); fallback 7383-7384. O desenho §7.2 cita 5 pontos, mas release e comments já usam resolveWorkshopScope (core.ts:9707, 9972; comentários 9699, 9964) e o painel (core.ts:6943) não filtra por bancada', 'Não abre dado novo: resolveWorkshopScope já entregava essas OS. Capability de kanban dada a alguém novo não abre todas as bancadas por omissão.'],
  ['D3b', 'O passo 86 conta só bancadas ATIVAS. Quem é membro só de bancada desativada e não é mecânico fica com "todas" (como hoje). O MECÂNICO sem nenhuma bancada ativa, que hoje vê todas pelo fallback, passa a ver NENHUMA.', 'core.ts:7273 (listWorkshopsOf filtra active=1), 7375, 7383-7384', 'O fallback do mecânico é acidente (o mecânico nasce com bancada obrigatória, TeamService.ts:85/406). Alternativa, se o dono preferir: o passo 86 grava all_workshops=1 também para ele.'],
  ['D4', 'O PDV sai do menu e da rota do estoquista.', 'environments.ts:169; navItems.ts:472; gsRoutes.tsx:228; core.ts:5568-5570', 'Porta que bate na cara: ele abre o PDV e toma 403 no Finalizar.'],
  ['D5', 'A URL proibida mostra "Acesso negado" (/sem-acesso) em vez de voltar em silêncio para a casa.', 'Protected.tsx:90-92, 115-117', 'Pedido da missão.'],
  ['D6', 'Menu, rotas do navegador e botões calculados por capability: a tela passa a mostrar só o que o servidor aceita.', 'lista calculada abaixo', 'Pela primeira vez tela e servidor dizem a mesma coisa.'],
  ['D7', 'A auditoria passa a gravar o "antes", o diff, a troca de empresa e os eventos de modelo.', 'core.ts:9250-9257; auth.ts:895-932', 'Pedido da missão.'],
  ['D8', 'O modelo `gestor` passa a se chamar "Gestor do grupo (par do administrador)"; o acesso é o mesmo.', 'HierarquiaDePerfis.ts:27-28; seed.ts:215-222', 'Evita entregar o grupo a um "gestor de loja".'],
  ['D9', 'POST /auth/device/enroll passa a exigir que o ALVO tenha `pdv.device_login` no vínculo, não seja conta de dono, tenha o caixa no escopo e seja alcançável por quem registra (§9.3).', 'auth.ts:457-509 (hoje só exige userId com vínculo, 460-466)', 'Fecha o caminho sem senha para uma conta de administrador, que hoje só a tela evita. Impacto prático: 0 caixas cadastrados na loja.'],
  ['D10', 'POST /auth/device/login passa a exigir `pdv.device_login` do titular do token (não conta de dono) e o caixa do token no escopo.', 'auth.ts:389-416', 'Hoje qualquer perfil com token vira sessão de terminal (mecânico, contador, admin_geral). Quem perde: E, T, L, O, M, K e os donos, por token de dispositivo (por senha nada muda). Tokens existentes na loja: 0.'],
  ['D11', 'Formulário de pessoa: bancada obrigatória quando o modelo tem capability de escopo bancada e `default_workshops=membro`, ou quando o vínculo escolhe `all_workshops=0`. Gerente de oficina e caixa da oficina deixam de ser OBRIGADOS a escolher bancadas específicas (podem receber "todas").', 'TeamService.ts:85, 406, 560, 576, 842; EquipePage (tela-botoes:610)', 'Hoje o gerente de oficina é obrigado a ter bancada e a ignora (core.ts:7290-7293). Vínculos existentes preservados pelo passo 86; muda só o cadastro novo.'],
  ['D12', 'POST /workshop/orders/:id/checkout: o caixa do recebimento passa a vir de terminalDoPedido (o token vence o corpo; divergência 409) e entra requireTerminalNoEscopo.', 'core.ts:10212; TerminalRegistry.ts:92-111', 'Hoje o corpo vence o token: a máquina do Caixa 1 registra recebimento no Caixa 2.'],
];
c('| id | mudança | evidência | por quê / quem ganha ou perde | pontos no mapa |');
c('|---|---|---|---|---|');
for (const [id, t, e, r] of DS) c(`| ${id} | ${t} | ${e} | ${r} | ${porD(id).length || '— (regra geral, não é ponto do mapa)'} |`);
c();
c('### D6 em detalhe (calculado ponto a ponto)');
c();
const fecha = d6.filter((s) => s.perde.length); const abre = d6.filter((s) => s.ganha.length);
c(`**Fecham portas que batiam na cara** (${fecha.length} pontos; o servidor já negava a rota que a página monta):`);
c();
for (const s of fecha) c(`- ${s.tela} (${s.base}:${s.linha}, ${s.tipo}) — \`${s.capability_final}\`: perdem ${ab(s.perde)}${s.mudanca === 'D4' ? ' (D4)' : ''}.`);
c();
c(`**Aparecem telas que o servidor já atendia** (${abre.length} pontos):`);
c();
for (const s of abre) c(`- ${s.tela} (${s.base}:${s.linha}, ${s.tipo}) — \`${s.capability_final}\`: ganham ${ab(s.ganha)}.`);
c();
c('## 4. Recomendações que ficam para o dono (não entram no dia 1)');
c();
c('- **R1**: tirar `crm.*`, `rentals.view`, `workshop.kanban.view` e `workshop.equipment.view` dos modelos de caixa que não os usam (fecha API e menu juntos; é a contrapartida da D6 "aparecem").');
c('- **R2**: recorte por tipo de documento em POST /print/jobs (PrintRenderer.ts:641-678 desenha fechamento de caixa, OS, DANFE, orçamento e etiquetas de QUALQUER id da empresa para quem passa na rota). Estreita o acesso de hoje (o atendente imprime etiqueta, por exemplo); medir antes.');
c('- **R3**: o relatório do razão de estoque (ReportsService.ts:606-612) lista `unit_cost_cents` sem hideCost. No dia 1 só a gerência chega nele (reports.central.view), mas um modelo do dono com `reports.central.view` e sem `inventory.cost.view` veria o custo. A F2(b) deve aplicar `can(inventory.cost.view)` ali.');
c('- **R4**: unificar as três réguas de custo (C9).');
c('- **R5**: se o dono quiser alinhar a segunda via ao POST /print/jobs, `qualquer(pdv.sell, sales.view)` na reprint dá ao estoquista a segunda via que ele já consegue por um job novo (core.ts:1594 × 1523).');
fs.writeFileSync('conflitos.md', C.join('\n') + '\n');

// ------------------------------------------------------------------ SAÍDA 6: plano-de-implementacao.md
const FATIA_F2 = (code) => {
  const a = CAT[code]?.area ?? '';
  if (/^(pdv|sales|approval)\./.test(code) || code === 'fiscal.sale.emit' || /^customers\./.test(code) || /^settings\.(terminals|printers|sale_policy)/.test(code)) return 'a';
  if (/^(products|inventory|purchases|labels\.products)/.test(code) || code === 'fiscal.products.classify') return 'b';
  if (/^(finance|fiscal|accounting|reports|dashboard)\./.test(code)) return 'c';
  if (/^(workshop|labels\.equipment)/.test(code)) return 'd';
  if (/^(ecommerce|crm|rentals|integrations|logistics|system|devices)\./.test(code)) return 'e';
  if (/^(group|users|audit|permissions|settings\.management_policy)/.test(code)) return 'f';
  return 'f:' + a;
};
const rotasCore = guardadas.filter((r) => r.base === 'core.ts' && r.x.op !== 'marcador');
const porFatiaF2 = conta(rotasCore, (r) => FATIA_F2(r.x.args[0]));
const outrasPorArquivo = conta(guardadas.filter((r) => r.base !== 'core.ts'), (r) => r.base);
const servPorArquivo = conta(servPts.filter((s) => s.x.op !== 'marcador' && (s.categoria !== 'servico-ator' || s.veredito !== 'igual')), (s) => s.base);
const telaPorArquivo = conta(telaPts, (s) => s.base);
const Q = [];
const q = (s = '') => Q.push(s);
q('# Plano de implementação do RBAC granular');
q();
q(`Base: ${BASE}. Números calculados por \`_consolidar.mjs\` sobre \`mapa-final.json\`. Contagens de guardas legadas medidas por grep no HEAD (lidas, não executadas): core.ts tem 435 ocorrências de \`requireProfile(\` (1 definição em core.ts:939, 9 em comentário, 425 chamadas) e 111 de \`abertaAo(\` (definição em core.ts:1070); nfse.ts tem 8 chamadas da cópia (definição em nfse.ts:38); payment-terminals.ts tem 11 (definição em payment-terminals.ts:74); \`requirePermission(\` tem 76 chamadas vivas (auth.ts 3, index.ts 10 + 1 em comentário, logistics.ts 23, payment-terminals.ts 31, system-admin.ts 9). A F0 congela a base exata por AST; o número da catraca parte dela, não dos 83 do desenho.`);
q();
q('## 0. O que muda em relação ao desenho');
q();
q(`- Catálogo final: **${CODES.size}** capabilities (138 + \`pdv.device_login\`, \`sales.quotes.cancel\`, \`sales.consignment.close\`).`);
q(`- Modelos de sistema derivados rota a rota (\`modelos.json\`): ${P.map((p) => `${p} ${M[p].caps.size}`).join(', ')}. Mais 7 modelos de atalho sem vínculo.`);
q(`- Pontos no mapa: ${pontos.length} (${Object.entries(totais.por_tipo).map(([k, n]) => `${k} ${n}`).join(', ')}). Rotas únicas ${rotasUnicas.length}: ${guardadas.length} guardadas (${totais.rotas_guardadas_por_guarda.soAutenticado ?? 0} só autenticadas) e ${publicas.length} públicas.`);
q(`- Equivalência das rotas: ${Object.entries(totais.rotas_veredito).map(([k, n]) => `${k} ${n}`).join(', ')}. Conflitos do solver: ${conflitosSolver.length}, todos resolvidos. Mudanças não listadas: ${naoListadas.length}.`);
q('- Mudanças deliberadas: D1–D8 do desenho, D3b, D9–D12 (conflitos.md §3).');
q('- `soAutenticado(\'motivo\')` entra no lint ao lado de `rotaPublica` para as rotas que exigem token e não pedem capability (auth.ts:296, 855, 869, 895 e `GET /core/permissions/catalog`).');
q();
q('## 1. Ordem');
q();
q('```');
q('F0 (linha de base + catálogo) ─► F1 (servidor-base) ─┬─► F2 (tradução: f primeiro, depois a–e em paralelo) ─┐');
q('                                                     ├─► F3 (tela-base) ─────────────────────────────────────┼─► F5 (remoção final) ─► liga a personalização');
q('                                                     └─► F4 (Usuários e Modelos; depois de F3) ──────────────┘');
q('F6 (testes) acompanha todas; F2(d) só começa depois da decisão D3b.');
q('```');
q();
q('## 2. Frentes');
q();
const FR = [
  ['F0 — linha de base e catálogo', 'serial, pequena', 'Congelar o acesso de hoje e publicar o catálogo final, sem mudar comportamento.',
    ['`server/src/services/auth/Capabilities.ts` (novo; gerado de `catalogo-final.json`: CATALOGO, type Capability, CATALOG_VERSION=1, MODELOS_DE_SISTEMA de `modelos.json`)', '`server/tests/rbac/linha-de-base.json` (rota → perfis de hoje; é a coluna perfis_hoje de `mapa-final.json`)', '`server/tests/rbac/equivalencia.test.ts` (T0/T1)', '`server/tests/rbac/catalogo.test.ts` (T13)', '`scripts/rbac/` (este `_consolidar.mjs` e os geradores das fatias, para rodar sobre o HEAD da hora)'],
    'T0 e T13 verdes; a catraca registra a base medida por AST.'],
  ['F1 — servidor-base', 'depois de F0', 'Tabelas, semeadura, resolução do acesso, sessão, guardas novas, lint. Nenhuma rota muda.',
    ['`server/src/db/schema.ts` (core_permission_templates, core_permission_template_capabilities, core_user_company_capabilities, core_user_company_terminals; colunas novas de core_user_companies; CORE_TABLES_IN_DELETE_ORDER em schema.ts:5437)', '`server/src/db/core-migrations.ts` (passo 86 com bancadas ATIVAS; CORE_TARGET_VERSION 85→86 em core-migrations.ts:86)', '`server/src/db/migracaoCompleta.ts` (ensurePermissionTemplates em prepararBanco, migracaoCompleta.ts:27-33)', '`server/src/services/auth/AcessoEfetivo.ts`, `Autorizacao.ts`, `AcessoService.ts` (novos)', '`server/src/services/auth/ContaDaSessao.ts` (consulta com o modelo; D2)', '`server/src/services/api/ApiAuthService.ts` (refresh confere empresa ativa, D2)', '`server/src/middleware/auth.ts` (req.auth.acesso, X-Acesso-Em-Vigor, `soAutenticado`, requirePermission vira tradutor POR ROTA, C8)', '`server/src/routes/v1/auth.ts` (só o `access` do login, dispositivo, sessão e troca)', '`server/src/services/auth/Permissions.ts` (vira reexport de Capabilities; módulos mortos fiscal/crm/corporate-bi saem)', '`server/eslint-rules/rota-declara-alcance.js` (GUARDAS novas em :110, capabilityDesconhecida, soAutenticado)'],
    'T9, T10, T12 verdes; T2 igual à linha de base.'],
  ['F2 — tradução das guardas', 'depois de F1; (f) entra primeiro', 'Cada rota passa a `requireCapability/requireAnyCapability/requireAllCapabilities` com a expressão `capability_final` de `mapa-final.json`; cada ponto de serviço recebe a `regra_final`. Cada PR baixa a catraca e mantém T1 verde para as suas rotas.',
    [`(f) grupo, usuários, auditoria, alçada: ${porFatiaF2.f ?? 0} rotas de core.ts; \`AuthorizationService.ts\` (approval.<ação> exata no vínculo do liberador), \`IdentityService.ts\` (listGroupAdmins, temVinculoDeGestao → system.deploy.view no vínculo, C6), \`AlcanceCruzado.ts\` (operacoesOndeACapabilityAbre), \`TitularService.ts\`, \`HierarquiaDePerfis.ts\` (só leitura de capability; a régua nova é da F4), \`RecuperacaoDeSenhaDaEquipe.ts\` (conta de dono por assignable_by), helpers \`comLiberacaoPontual\` e \`scope()\` de core.ts`,
      `(a) PDV, caixa, vendas, fiscal da venda, clientes: ${porFatiaF2.a ?? 0} rotas; \`CashService.ts\`, \`SalesService.ts\`, \`QuoteService.ts\`, \`GavetaDoDinheiro.ts\`, \`TerminalRegistry.ts\` (requireTerminalNoEscopo nos chamadores de terminalDoPedido: core.ts:1523/1547, 1653, 1675, 4183/4191, 4696/4706, 4714/4728, 6259/6279, 15164/15170, SEM 5505), \`CobrancasSemVenda.ts\`; capabilities novas sales.quotes.cancel/sales.consignment.close (C4); D1`,
      `(b) produtos, estoque, compras, unidades: ${porFatiaF2.b ?? 0} rotas; \`PoliticaDeGestaoService.ts\` (can(dashboard.money.view)/can(inventory.cost.view) || política), hideCost de core.ts:3042, \`ReportsService.ts\` (R3, se o dono aprovar)`,
      `(c) financeiro, fiscal, contábil, relatórios, painel: ${porFatiaF2.c ?? 0} rotas; \`nfse.ts\` inteiro (8 rotas, apaga a cópia de requireProfile em nfse.ts:38)`,
      `(d) oficina, equipamento, plaquinhas, bancadas: ${porFatiaF2.d ?? 0} rotas; \`bancadasDoVinculo\` (resolveWorkshop/resolveWorkshopScope em core.ts:7284-7386), \`WorkshopIntakeService.ts\` (regra de entrada do C2), \`WorkshopCoreService.ts\` (voz; travas sem bypass, C7), \`WorkshopPartsService.ts\`, \`EquipmentService.ts\` (montador, C3), checkout com terminalDoPedido (D12)`,
      `(e) e-commerce, CRM, locação, integrações, logística, sistema: ${porFatiaF2.e ?? 0} rotas de core.ts + ${Object.entries(outrasPorArquivo).filter(([k]) => k !== 'nfse.ts').map(([k, n]) => `${k} ${n}`).join(', ')} rotas guardadas; \`payment-terminals.ts\` (apaga a cópia em :74, C12), \`system-admin.ts\` (C6), \`auth.ts\` (D9, D10), \`implantacaoPorEmpresa.ts\` e \`ProntidaoDasComunicacoes.ts\` (checklists por capability + assignable_by, C3)`],
    'T1 = igual + D1 para todas as rotas; catraca = 0.'],
  ['F3 — tela-base', 'depois de F1, em paralelo com F2', 'useCan, sessão com `access`, Protected com /sem-acesso, casa calculada, menu e rotas por capability.',
    ['`src/hooks/useCan.ts` (novo); `src/hooks/useSession.ts` (useHasProfile e DONOS_DO_GRUPO saem na F5)', '`src/lib/api/client.ts` (StoredSession.access, X-Acesso-Em-Vigor)', '`src/router/Protected.tsx`, `src/router/gsRoutes.tsx` (pode obrigatório), `src/router/environments.ts` (vira só casas e porta)', '`src/components/gs/navItems.ts`, `src/components/gs/AppShell.tsx` (nome do modelo no topo)', '`src/pages/gs/AcessoNegadoPage.tsx` (novo)', '`src/lib/acesso/catalogo.gen.ts` (gerado de catalogo-final.json)', `as 34 telas com useHasProfile (64 chamadas); pontos de tela no mapa por arquivo: ${Object.entries(telaPorArquivo).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${n}`).join(', ')}…`],
    'T4 e T-UI-1 verdes; D4/D6 congeladas por modelo na PR para o dono revisar.'],
  ['F4 — Usuários e Modelos', 'depois de F1 e F3', 'Rotas e telas de acesso, régua de quem entrega o quê, auditoria antes/depois.',
    ['`server/src/routes/v1/acesso.ts` (novo roteador, montado em index.ts; core.ts não é tocado)', '`server/src/services/core/HierarquiaDePerfis.ts` (régua §9 com assignable_by)', '`server/src/services/core/TeamService.ts` (fachada; D11)', '`src/pages/gs/EquipePage.tsx` → UsuariosPage; `src/pages/gs/ModelosPage.tsx` (nova); `src/lib/api/acesso.ts`; `src/components/gs/QuemLiberaAqui.tsx` (nome do modelo; lado grupo/operação por group.admin)', '`src/pages/gs/TerminaisPage.tsx` (lista de quem recebe token pela elegibilidade do servidor, C5)'],
    'T3, T8, T11 verdes.'],
  ['F5 — remoção final', 'serial, depois de F2, F3 e F4', 'Apagar o modelo antigo e ligar a personalização.',
    ['apagar requireProfile, abertaAo, PERFIS_DO_AMBIENTE, CAIXAS/BALCAO_E_GERENCIA/AUX_EDITORES, AlcanceCruzado.PERFIS_QUE_PASSAM_EM_TUDO, temPermissao/Permissions.ts, QUEM_*, DONOS_DO_GRUPO, useHasProfile, X-Perfil-Em-Vigor, companies[].profileCode, fachadas /core/team*', 'tirar as guardas legadas do lint', 'ligar core_meta.rbac_personalizacao_liberada'],
    'Busca por admin_geral/gestor em server/src e src só acha seed, bootstrap e rótulos de modelo.'],
  ['F6 — testes', 'contínua', 'A matriz T0–T13 do desenho, com as fixtures A–J de equivalencia.md §5.',
    ['`server/tests/rbac/` (T2 por modelo, um arquivo por modelo; T3 com as 25 sondas; T5; T6 com D12 e D10; T7; T8; T9; T10; T11)', '`src/**/__tests__/rbac/` (T4, T-UI-1)', 'reescrever, não desligar: ambientes-dos-dois-lados, cinco-telas-que-batem-na-cara, o-menu-nao-promete-o-que-o-servidor-nega, permissions, rotas-abertura-declarada, regra-rota-declara-alcance, rodada-31-alcance-declarado, hierarquia-da-equipe, liberacao-pontual, alcada-sem-porta-dos-fundos, audit-portas, menu-e-rotas, environments, contador-no-navegador', 'os 526 arquivos que provisionam por profile_code NÃO mudam: o código vira "modelo aplicado", e sem semeadura MODELOS_DE_SISTEMA responde (§3.4)'],
    'A matriz inteira verde.'],
];
for (const [t, quando, o, arqs, pronta] of FR) {
  q(`### ${t} (${quando})`);
  q();
  q(o);
  q();
  for (const a of arqs) q(`- ${a}`);
  q();
  q(`Pronta quando: ${pronta}`);
  q();
}
q('## 3. Pontos de serviço com regra própria, por arquivo (a F2 não pode esquecer nenhum)');
q();
for (const [k, n] of Object.entries(servPorArquivo).sort((a, b) => b[1] - a[1])) q(`- \`${k}\`: ${n}`);
q();
q('## 4. Riscos de execução');
q();
q('- core.ts tem 16 mil linhas: as fatias da F2 dependem de PRs pequenas; a atribuição é por capability (área), não por faixa de linha, porque as linhas andam. O script regenera o mapa sobre o HEAD da hora.');
q('- A personalização e os modelos do dono só ligam com a catraca em 0: antes disso um vínculo com código `dono-…` levaria 403 em toda rota legada e teria o menu vazio (AppShell.tsx:31-39 com environmentOf nulo).');
q('- Os testes que provisionam por profile_code seguem valendo porque o código vira modelo e o banco truncado resolve por MODELOS_DE_SISTEMA; qualquer capability nova precisa declarar os modelos em que nasce (T13), senão nasce 403 para o gerente.');
fs.writeFileSync('plano-de-implementacao.md', Q.join('\n') + '\n');

// ------------------------------------------------------------------ relatório no console
console.log(JSON.stringify({
  pontos: pontos.length, catalogo: CODES.size, restricoes: restricoes.length, conflitos: conflitosSolver.map((x) => `${x.perfil}|${x.capability}|${x.resolucao ? 'ok' : 'SEM'}`),
  capsComListasDiferentes: capsComListasDiferentes.map(([k]) => k), fullOk, correcoes, naoListadas: naoListadas.map((s) => `${s.ref} ${s.tipo} ${s.tela ?? ''} ${s.capability_final} +${ab(s.ganha)} -${ab(s.perde)}`),
  chavesSemUso, chavesAmbiguas, totais: { ...totais, por_fatia: undefined }, modelos: Object.fromEntries(P.map((p) => [p, M[p].caps.size])), difDia1,
  divergTsv: divergTsv.length, casadasTsv, porFatiaF2,
}, null, 1));
