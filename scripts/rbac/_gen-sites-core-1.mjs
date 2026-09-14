// Gera sites-core-1.json (fatia core.ts 1-2200) e confere a equivalência dia-1
// de cada capability contra perfis_de_hoje do catalogo.json. Só lê o repo.
import fs from 'node:fs';
const DIR = new URL('.', import.meta.url);
const cat = JSON.parse(fs.readFileSync(new URL('catalogo.json', DIR), 'utf8'));
const CAP = Object.fromEntries(cat.map((c) => [c.code, c]));

const DONOS = ['admin_geral', 'gestor'];
const L = 'gerente_loja', O = 'gerente_oficina', E = 'estoquista', T = 'atendente';
const C = 'operador_caixa', CL = 'operador_caixa_loja', CO = 'operador_caixa_oficina', M = 'mecanico', K = 'contador';
const ESC = [L, O, E, T], BAL = [C, CL, CO], BAN = [M];
const TODOS = [...DONOS, L, O, E, T, C, CL, CO, M, K];
const ARQ = 'server/src/routes/v1/core.ts';
const P = (...xs) => [...new Set([...DONOS, ...xs.flat()])];

function alcance(expr) {
  const m = expr.match(/^qualquer\((.*)\)$/);
  const codes = m ? m[1].split(',').map((s) => s.trim()) : [expr];
  const set = new Set();
  for (const c of codes) {
    if (!CAP[c]) throw new Error('capability fora do catálogo: ' + c);
    for (const p of CAP[c].perfis_de_hoje) set.add(p);
  }
  return set;
}
function equiv(perfis, expr) {
  const hoje = new Set(perfis), novo = alcance(expr);
  const ganha = [...novo].filter((p) => !hoje.has(p)).sort();
  const perde = [...hoje].filter((p) => !novo.has(p)).sort();
  return ganha.length || perde.length ? `DESVIO ganha=[${ganha}] perde=[${perde}]` : 'igual';
}

const sites = [];
function add(s) {
  if (s.tipo === 'rota' || s.tipo === 'servico') {
    if (!['SO_AUTENTICADO', 'PUBLICA'].includes(s.capability) && !s.capability.startsWith('FALTA:')) {
      s.equivalencia_dia1 = equiv(s.perfis_hoje, s.capability);
    }
  }
  sites.push({ arquivo: ARQ, ...s });
}
const rota = (linha, linha_rota, metodo, caminho, guarda_hoje, perfis_hoje, capability, escopo, nota) =>
  add({ linha, linha_rota, tipo: 'rota', metodo, caminho: '/core' + caminho, guarda_hoje, perfis_hoje, capability, escopo, nota });

// ------------------------------------------------------------ mecanismo
add({
  linha: 899, tipo: 'servico', guarda_hoje: 'coreRouter.use(authMiddleware)', perfis_hoje: TODOS,
  capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Autenticação de todo o coreRouter (montado em /core, server/src/routes/v1/index.ts:198): toda rota /core/* exige sessão válida — conta ativa, session_version e vínculo na empresa do token, relidos a cada requisição (ContaDaSessao.ts:95-117). Não há rotaPublica na fatia 1-2200. Não decide capability: é aqui (middleware/auth.ts:65-69) que a F1 passa a gravar req.auth.acesso (capabilities, terminais, bancadas), e a D2 (empresa desativada → 401) entra por baixo dele. O helper scope() (902-908) repassa req.auth.profileCodes como `profiles` aos handlers; nesta fatia nenhum handler o lê, mas 20 handlers mais abaixo decidem por ele (ex.: 2839, 3034, 6213, 7285, 9181) — ele some na F5 junto com profileCodes.',
});
add({
  linha: 941, tipo: 'atalho-admin',
  guarda_hoje: "requireProfile (939-944): if (profiles.includes('admin_geral') || profiles.includes('gestor')) return;",
  perfis_hoje: DONOS, capability: 'group.admin', escopo: 'grupo',
  nota: "Atalho #1 do desenho §8 ('if admin allowEverything'). NÃO vira guarda: quem passa aqui (admin_geral, gestor) é exatamente perfis_de_hoje de group.admin, e é por isso que o código aparece aqui, só como rótulo. No modelo novo esses dois têm o catálogo inteiro porque o modelo é full_catalog=1, e nenhum requireCapability pergunta por group.admin no lugar desta linha. Ela é apagada na F5 junto com requireProfile. Na mesma região estão as listas que os guardas desta fatia expandem, e que também somem na F5: CAIXAS (923), BALCAO_E_GERENCIA (937) e AUX_EDITORES (1984). A recusa (943) usa API_PERMISSION_DENIED, o mesmo código que requireCapability vai manter (desenho §4.1).",
});
add({
  linha: 1072, tipo: 'atalho-admin',
  guarda_hoje: 'abertaAo(req, primeiro, ...outros) (1070-1073) → requireProfile(req, ...PERFIS_DO_AMBIENTE[ambientes])',
  perfis_hoje: DONOS, capability: 'group.admin', escopo: 'grupo',
  nota: "Atalho #2 do desenho §8: abertaAo delega a requireProfile e herda o atalho admin_geral/gestor. A matriz ambiente→perfis está em 1057-1062: balcao=BALCAO=CAIXAS (1011, 923), bancada=['mecanico'] (1014), escritorio=[gerente_loja, gerente_oficina, estoquista, atendente] (1023), contabilidade=['contador'] (1053). server/tests/ambientes-dos-dois-lados.test.ts:161-169 lê PERFIS_DO_AMBIENTE por AST para amarrar ao navegador; esse teste tem de ser reescrito, não desligado. Um perfil desconhecido falha fechado (comentário 965-973), e o modelo inexistente do desenho (§3.4) mantém isso. Apagada na F5; as 23 chamadas de abertaAo desta fatia viram as capabilities de cada rota abaixo.",
});

// ------------------------------------------------------------ produtos
rota(1084, 1077, 'GET', '/products', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Lista de Produtos: telas ROTA_GESTAO (Produtos, Etiquetas, Locação, Alteração rápida, formulário; comentário 1080-1082). Mesmo acesso de hoje: {E,L,O,T} + donos. ESQUISITO: listProducts devolve p.* (CatalogService.ts:1299), com cost_cents, ao estoquista e ao atendente sem passar por veCustoDoEstoque, que é a política que esconde o custo do estoquista em core.ts:2851 e 2894. Custo vaza fora da capability: a F2(b) deve apagar cost_cents quando faltar can(inventory.cost.view) e a política não liberar.');
rota(1121, 1119, 'POST', '/products/fotos-em-lote/resolver', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'products.manage', 'empresa',
  'Casa arquivo com produto no envio de fotos em lote (comentário 1114-1118). Só lê, mas é o primeiro passo de editar a foto do cadastro. Mesmo acesso de hoje: {E,L,O}.');
rota(1132, 1130, 'GET', '/products/prontidao-online', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'products.manage', 'empresa',
  "Mostra o que falta a cada produto para vender online. Mesmo acesso de hoje: {E,L,O}. A tela e a rota divergem: o desenho §11.2 põe a página 'prontidão' em ecommerce.store.manage ({L,O}), mais estreita que a rota. O estoquista perderia a página e manteria a API. Não é porta que bate na cara (é o contrário), mas a F3 precisa decidir: ou a página aceita qualquer(ecommerce.store.manage, products.manage), ou fica a assimetria.");
rota(1143, 1141, 'POST', '/products/publicar-prontos', "requireProfile(req, 'gerente_loja')", P(L), 'ecommerce.publish', 'empresa',
  'Publica em lote no e-commerce os produtos prontos (auditoria product.publish_ready, 1149-1161). Hoje só gerente_loja. ecommerce.publish = {gerente_loja} + donos, igual a hoje, e o gerente_oficina continua fora.');
rota(1175, 1168, 'GET', '/products/search', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(products.view, pdv.sell)', 'empresa',
  'Busca do PDV (comentário 1170-1174) e das telas de gestão (montar kit, ?excludeKits). O acesso é o mesmo de hoje: {C,CL,CO,E,L,O,T} + donos. pdv.sell tem escopo pdv, mas aqui é só leitura de catálogo, sem caixa efetivo, então não chama requireTerminalNoEscopo. ESQUISITO: searchProducts devolve p.* com cost_cents (CatalogService.ts:1169) aos três caixas. No cenário A (Somente PDV), o caixa veria o custo. Recortar por inventory.cost.view na F2(b).');
rota(1208, 1202, 'GET', '/products/:id', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(products.view, pdv.sell)', 'empresa',
  'Ficha do produto. O PDV a usa para montar a linha da venda (preço vigente e faixas, 1213-1240), e o formulário e a alteração rápida também. Mesmo acesso de hoje. ESQUISITO: getProduct faz SELECT * (CatalogService.ts:1077), e o stock vem de listStock com p.cost_cents (InventoryService.ts:1478). O custo chega ao balcão sem recorte. Cortar por inventory.cost.view.');
rota(1268, 1266, 'POST', '/pricing/cart', "abertaAo(req, 'balcao', 'bancada', 'escritorio')", P(BAL, BAN, ESC), 'qualquer(pdv.sell, sales.view, workshop.parts.use)', 'empresa',
  "Reprecifica o carrinho para um cliente (PricingService). Na tela, só o PDV chama esta rota: src/pages/gs/PdvPage.tsx:838, src/components/gs/ClientePdvDialog.tsx:28 e src/lib/api/core.ts:3780. O mecânico entra pela bancada porque o comentário 1263-1264 diz 'fecha OS com peça', mas nenhuma tela dele usa a rota hoje. DIVERGE do mapa, que põe workshop.kanban.view no terceiro termo. As duas escolhas dão {C,CL,CO,E,L,M,O,T} + donos no dia 1 (fica de fora só o contador, como hoje). A diferença: workshop.kanban.view abriria o preço por cliente (a tabela comercial do revendedor) a um modelo 'Oficina: consulta', que não precifica nada. workshop.parts.use é o que o comentário descreve. A rota não grava, então não cobra escopo de caixa nem de bancada.");

// ------------------------------------------------------------ e-mail de XML
rota(1296, 1294, 'GET', '/mail/inbox', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'purchases.view', 'empresa',
  'Estado da caixa de e-mail que recebe XML de fornecedor (Compras). Mesmo acesso de hoje: {E,L,O}. sanitize tira secret_cipher (MailInboxService.ts:167-177): a senha não chega ao estoquista.');
rota(1306, 1303, 'POST', '/mail/inbox', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'purchases.manage', 'empresa',
  "Configura a caixa: endereço, servidor e senha de aplicativo. O comentário 1305 diz 'decisão de gestor'. Mesmo acesso de hoje: {L,O}. O companyId do token vem por último no spread (1308-1310), então o corpo não troca de empresa. A auditoria não grava a senha (1311-1324).");
rota(1339, 1336, 'POST', '/mail/inbox/test', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'purchases.manage', 'empresa',
  'Testa a conexão IMAP (GAP-PRD-128). Tem o alcance da configuração: {L,O}, o mesmo de hoje.');
rota(1359, 1357, 'DELETE', '/mail/inbox', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'purchases.manage', 'empresa',
  'Remove a caixa, com auditoria mail.inbox.remove. Mesmo acesso de hoje: {L,O}.');
rota(1378, 1376, 'GET', '/mail/schedule', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'purchases.view', 'empresa',
  'Estado da leitura automática. Mesmo acesso de hoje: {E,L,O}.');
rota(1387, 1385, 'POST', '/mail/schedule', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'purchases.manage', 'empresa',
  'Liga, desliga e muda o intervalo da leitura automática. Mesmo acesso de hoje: {L,O}. A rota não chama recordAudit (1385-1402); setSchedule recebe o userId.');
rota(1406, 1404, 'GET', '/mail/messages', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'purchases.view', 'empresa',
  'Lista as mensagens já lidas da caixa. Mesmo acesso de hoje: {E,L,O}.');
rota(1422, 1419, 'POST', '/mail/check', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'purchases.receive', 'empresa',
  "Lê a caixa na hora e cria notas EM CONFERÊNCIA (1413-1418, auditoria mail.inbox.check). DIVERGE do mapa (purchases.view): a rota escreve, porque cria entrada de nota, e a capability certa é purchases.receive ('Entrada de notas'). As duas têm {E,L,O} + donos, então o dia 1 fica igual. Com purchases.view, um modelo de Compras só de leitura conseguiria criar notas.");

// ------------------------------------------------------------ impressão
rota(1452, 1446, 'GET', '/print/readiness', "abertaAo(req, 'escritorio')", P(ESC), 'settings.printers.view', 'empresa',
  'Diagnóstico de impressora. Só a tela Configurações → Impressoras o consome (1448-1451). Mesmo acesso de hoje: {E,L,O,T}.');
rota(1465, 1459, 'GET', '/print/printers', "abertaAo(req, 'escritorio')", P(ESC), 'settings.printers.view', 'empresa',
  'Lista de impressoras da tela de configuração. O cupom do balcão sai sem passar por esta rota (1461-1463). Mesmo acesso de hoje: {E,L,O,T}.');
rota(1474, 1472, 'POST', '/print/printers', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'settings.printers.manage', 'empresa',
  'Cadastra e edita impressora, inclusive pdv_terminal_id e agent_device. Mesmo acesso de hoje: {L,O}. O companyId da sessão vence o corpo (1476-1478).');
rota(1505, 1498, 'GET', '/print/jobs', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Fila de impressão, lida por lib/print.ts no PDV e em Orçamentos. Mesmo acesso de hoje: {C,CL,CO,E,L,O,T}. ESQUISITO: listPrintJobs faz SELECT * (PrintEngine.ts:462) e devolve o payload, isto é, o HTML renderizado de até 100 documentos da empresa (fechamento de caixa, OS com dados do cliente, DANFE), a qualquer caixa ou pessoa do escritório. A rota vizinha GET /print/jobs/:id tira o payload (1586-1587). A F2(a) deve cortar o payload aqui também.');
rota(1525, 1523, 'POST', '/print/jobs', "requireProfile(req, 'operador_caixa_loja', 'operador_caixa_oficina', 'gerente_loja', 'gerente_oficina', 'atendente', 'estoquista')", P(CL, CO, L, O, T, E), 'qualquer(pdv.sell, sales.view)', 'pdv',
  "Enfileira impressão: o cupom do PDV e os papéis das telas de Vendas e Orçamentos. MUDANÇA D1: o operador_caixa legado (0 vínculos) passa a entrar. Hoje ele é o único caixa fora desta lista, mas entra em GET /print/jobs, GET /print/jobs/:id e POST /print/jobs/:id/status (abertaAo 'balcao'). A guarda de hoje se contradiz, e a D1 a alinha. O escopo de caixa é cobrado em terminalDoPedido, na linha 1547 (ver o ponto próprio). FALTA recorte por tipo de documento: renderDocument (PrintRenderer.ts:641-678) desenha CASH_CLOSING, WORKSHOP_OS, DANFE/DANFCE, QUOTE, PRODUCT_LABEL e EQUIPMENT_QR_TAG de QUALQUER id da empresa para quem passa aqui. Um usuário 'Somente PDV' imprime o fechamento de caixa de outro operador ou a OS de outra bancada. Sugestão para a F2(a), conferir o tipo: CASH_CLOSING → qualquer(pdv.cash.operate, sales.supervise); WORKSHOP_OS → workshop.kanban.view com bancadasDoVinculo; DANFE/DANFCE → qualquer(fiscal.sale.emit, fiscal.view); PRODUCT_LABEL → labels.products.print; EQUIPMENT_QR_TAG → qualquer(workshop.equipment.label, labels.equipment.print). Isso estreita o acesso de hoje (o atendente imprime etiqueta, por exemplo), então medir antes e listar como mudança D.");
rota(1583, 1581, 'GET', '/print/jobs/:id', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.sell, sales.view)', 'empresa',
  'O PDV acompanha o cupom até printed ou failed (GAP-PRD-082). Mesmo acesso de hoje: {C,CL,CO,E,L,O,T}. O payload não vem (1586-1587).');
rota(1596, 1594, 'POST', '/print/jobs/:id/reprint', "requireProfile(req, 'operador_caixa_loja', 'operador_caixa_oficina', 'gerente_loja', 'gerente_oficina', 'atendente')", P(CL, CO, L, O, T), 'pdv.sell', 'pdv',
  'Segunda via. Hoje: {CL,CO,L,O,T} + donos. pdv.sell acrescenta só o operador_caixa legado (D1). CONTRADIÇÃO: o estoquista fica fora da segunda via, mas cria um job novo do MESMO documento por POST /print/jobs (1523-1533), que o aceita. pdv.sell mantém a exclusão de hoje. Se o dono quiser alinhar, qualquer(pdv.sell, sales.view) resolve, e aí vira mudança listada. reprintJob copia o payload e a impressora do job original (PrintEngine.ts:386-414), sem caixa efetivo, então requireTerminalNoEscopo não tem o que conferir aqui.');
rota(1627, 1620, 'POST', '/print/jobs/:id/status', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Avança o estado do papel (printing, printed). Mesmo acesso de hoje. Qualquer pessoa desse alcance avança qualquer job da empresa: advancePrintJob só confere a transição (PrintEngine.ts:417-449) e não olha quem criou o job. Risco baixo, porque é só o estado do papel.');
rota(1655, 1653, 'GET', '/print/drawer', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
  'O PDV pergunta se desenha o botão da gaveta (GAP-V55). Mesmo acesso de hoje: {C,CL,CO,E,L,O,T}. O atendente (tem pdv.sell, não tem caixa) e o estoquista entram por sales.view. O caixa é resolvido por terminalDoPedido na linha 1658 (ver o ponto próprio).');
rota(1677, 1675, 'POST', '/print/drawer/open', 'requireProfile(req, ...BALCAO_E_GERENCIA)', P(BAL, L, O), 'pdv.cash.operate', 'pdv',
  "Abre a gaveta sem venda (troco, sangria), com motivo obrigatório e trilha (cash.drawer.open_requested). Mesmo acesso de hoje: pdv.cash.operate = BALCAO_E_GERENCIA (937) + donos, e o atendente continua fora. requireTerminalNoEscopo é obrigatório aqui: linha 1687 e desenho §6.3.");
rota(1726, 1724, 'POST', '/print/printers/:id/test', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'settings.printers.manage', 'empresa',
  'Página de teste da impressora do agente local. Mesmo acesso de hoje: {L,O}.');
rota(1776, 1774, 'GET', '/print/jobs/:id/escpos', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Bytes ESC/POS do cupom. Mesmo acesso de hoje. ESQUISITO: ?gaveta=1 (1791) põe o PULSO DA GAVETA nos bytes, e basta sales.view para pedir (estoquista, atendente). A rota própria de abrir a gaveta exige pdv.cash.operate, motivo e trilha (1675-1717). Nenhuma tela chama /escpos hoje (nenhuma ocorrência em src/). Sugestão para a F2(a): ?gaveta=1 passa a exigir pdv.cash.operate.');
rota(1807, 1801, 'GET', '/print/jobs/:id/document', "abertaAo(req, 'balcao', 'escritorio')", P(BAL, ESC), 'qualquer(pdv.sell, sales.view)', 'empresa',
  'HTML do job para o navegador imprimir. Mesmo acesso de hoje. Quando o job não tem payload, a rota renderiza de novo (1810), sem recorte por tipo de documento, a mesma falta do POST /print/jobs.');

// ------------------------------------------------------------ categorias e marcas
const BUG_SPREAD = (linha, svc) =>
  `DADO DE OUTRA EMPRESA: o handler monta ${svc}({ companyId, ...(req.body ?? {}) }) na linha ${linha}. O corpo é espalhado DEPOIS da empresa da sessão, então um companyId no corpo vence, e o serviço usa input.companyId no INSERT e no UPDATE de core_products (TaxonomyService.ts:112-181 e 293-340). É o defeito que 1308-1310 e 1476-1478 já consertaram em outras rotas. Quem tem vínculo em duas empresas recebe os dois ids no login (auth.ts:247-253): um estoquista de A escreve em B, onde talvez seja só caixa. Não depende da capability. Conserto: inverter a ordem, espalhando o corpo primeiro e o companyId da sessão por último.`;
rota(1825, 1819, 'GET', '/taxonomy', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Categorias e marcas, para o cadastro de produto e a tela Categorias/Marcas (ROTA_GESTAO). Mesmo acesso de hoje: {E,L,O,T}.');
rota(1840, 1838, 'POST', '/taxonomy/categories', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'products.manage', 'empresa',
  'Cria ou renomeia categoria; renomear leva os produtos junto (TaxonomyService.ts:159-167). Mesmo acesso de hoje: {E,L,O}. ' + BUG_SPREAD(1842, 'upsertCategory'));
rota(1860, 1858, 'POST', '/taxonomy/categories/merge', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.catalog.admin', 'empresa',
  'Une duas categorias e migra os produtos. Mesmo acesso de hoje: {L,O}. O companyId é passado explícito (1862-1866), sem spread.');
rota(1883, 1881, 'DELETE', '/taxonomy/categories/:id', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.catalog.admin', 'empresa',
  'Remove categoria; recusa quando há produto usando (TaxonomyService.ts:260-274). Mesmo acesso de hoje: {L,O}.');
rota(1901, 1899, 'POST', '/taxonomy/brands', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')", P(L, O, E), 'products.manage', 'empresa',
  'Cria ou renomeia marca; renomear leva os produtos. Mesmo acesso de hoje: {E,L,O}. ' + BUG_SPREAD(1903, 'upsertBrand'));
rota(1920, 1918, 'POST', '/taxonomy/brands/merge', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.catalog.admin', 'empresa',
  'Une duas marcas. Mesmo acesso de hoje: {L,O}. O companyId é explícito (1922-1926).');
rota(1943, 1941, 'DELETE', '/taxonomy/brands/:id', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.catalog.admin', 'empresa',
  'Remove marca. Mesmo acesso de hoje: {L,O}.');

// ------------------------------------------------------------ auxiliares do catálogo
rota(1971, 1965, 'GET', '/catalog/aux', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Seletores do cadastro: unidade, grupo tributário, alíquota e tabela de preço. Tela Auxiliares do catálogo (ROTA_GESTAO). Mesmo acesso de hoje: {E,L,O,T}.');
rota(1988, 1986, 'POST', '/catalog/units', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'products.manage', 'empresa',
  'AUX_EDITORES (1984) = gerente_loja, gerente_oficina, estoquista. Mesmo acesso de hoje.');
rota(2007, 2005, 'DELETE', '/catalog/units/:id', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'products.manage', 'empresa',
  'Mesmo acesso de hoje. Uma incoerência de hoje fica preservada: o estoquista APAGA unidade e campo personalizado, mas não apaga categoria nem marca (essas pedem products.catalog.admin).');
rota(2040, 2037, 'GET', '/catalog/tax-groups', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Seletor de grupo tributário no cadastro do produto (GAP-V01). Tem o alcance de /catalog/aux, igual ao de hoje.');
const FISCAL_AUX = "DIVERGE do mapa (products.manage). O grupo tributário leva regime, CST de IPI e alíquota de IPI, e o comentário 2059-2060 diz que ele 'MUDA O XML de todo produto do grupo'. É classificação fiscal, a mesma família de /fiscal/classification e /fiscal/product-pendencies, que o mapa guarda com fiscal.products.classify. As duas capabilities têm {E,L,O} + donos, então o dia 1 fica igual. Com products.manage, um modelo 'Cadastro de produto' sem fiscal mudaria a tributação de uma linha inteira. Na tela, a seção fiscal de Auxiliares deve seguir esta capability, e não a da página.";
rota(2050, 2048, 'POST', '/catalog/tax-groups', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'fiscal.products.classify', 'empresa', FISCAL_AUX);
rota(2076, 2074, 'DELETE', '/catalog/tax-groups/:id', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'fiscal.products.classify', 'empresa', FISCAL_AUX);
rota(2094, 2092, 'POST', '/catalog/tax-rates', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'fiscal.products.classify', 'empresa',
  'Alíquota: mesma razão do grupo tributário. DIVERGE do mapa (products.manage), com equivalência igual ({E,L,O}). ESQUISITO: a rota não chama recordAudit (2092-2100), então mudar uma alíquota não deixa rastro, ao contrário do grupo tributário (2053-2067).');
rota(2104, 2102, 'DELETE', '/catalog/tax-rates/:id', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'fiscal.products.classify', 'empresa',
  'Mesma razão. DIVERGE do mapa (products.manage), com equivalência igual. Sem recordAudit (2102-2111).');
rota(2123, 2120, 'GET', '/catalog/custom-fields', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Definição dos campos personalizados, usada como seletor do cadastro. Mesmo acesso de hoje: {E,L,O,T}.');
rota(2133, 2131, 'POST', '/catalog/custom-fields', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'products.manage', 'empresa',
  "Cria a definição do campo personalizado (V07). O comentário 2113-2118 diz que é 'decisão de quem organiza o catálogo'. Mesmo acesso de hoje: {E,L,O}.");
rota(2152, 2150, 'DELETE', '/catalog/custom-fields/:id', 'requireProfile(req, ...AUX_EDITORES)', P(L, O, E), 'products.manage', 'empresa',
  'Mesmo acesso de hoje: {E,L,O}.');
rota(2170, 2168, 'POST', '/catalog/price-tables', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.price.manage', 'empresa',
  'Cria e altera tabela de preço (percentual). Mesmo acesso de hoje: {L,O}. ESQUISITO: sem recordAudit (2168-2176); mexer no preço de uma tabela inteira não deixa rastro.');
rota(2180, 2178, 'DELETE', '/catalog/price-tables/:id', "requireProfile(req, 'gerente_loja', 'gerente_oficina')", P(L, O), 'products.price.manage', 'empresa',
  'Mesmo acesso de hoje: {L,O}. Sem recordAudit (2178-2187).');
rota(2199, 2197, 'GET', '/catalog/price-tables/:id/items', "abertaAo(req, 'escritorio')", P(ESC), 'products.view', 'empresa',
  'Preços fixados da tabela (comentário 1189-1196). Mesmo acesso de hoje: {E,L,O,T}. O atendente e o estoquista leem o preço combinado, por decisão explícita do comentário.');

// ------------------------------------------------------------ escopo de caixa (terminalDoPedido)
add({
  linha: 1547, tipo: 'servico', metodo: 'POST', caminho: '/core/print/jobs',
  guarda_hoje: 'terminalDoPedido({ informado: req.body?.terminalId, doDispositivo: req.auth?.storeId }) + assertTerminalDaEmpresa(companyId, caixa) (1547-1548)',
  perfis_hoje: P(CL, CO, L, O, T, E), capability: 'qualquer(pdv.sell, sales.view)', escopo: 'pdv',
  nota: 'Mesma expressão da rota, porque este ponto fica dentro dela; o recorte de caixa só vale para quem entrou por pdv.sell. Decide o caixa efetivo: o terminal do token de dispositivo vence o do corpo, e a divergência dá 409 (TerminalRegistry.ts:92-111). assertTerminalDaEmpresa recusa caixa de outra empresa. É aqui que entra requireTerminalNoEscopo (desenho §6.3, que cita core.ts:1523). Cuidado: a rota também serve o escritório (sales.view) sem caixa. A F2(a) só deve cobrar o escopo quando existir caixa efetivo e a pessoa tiver entrado por pdv.sell. Quem entra só por sales.view (o estoquista imprimindo da tela de Vendas) não pode levar 409 CORE_TERMINAL_REQUIRED. Equivalência: o desvio D1 (operador_caixa) vem da rota, não deste ponto.',
});
add({
  linha: 1658, tipo: 'servico', metodo: 'GET', caminho: '/core/print/drawer',
  guarda_hoje: 'terminalDoPedido({ informado: req.query.terminalId, doDispositivo: req.auth?.storeId }) + assertTerminalDaEmpresa(companyId, caixa) (1658-1659)',
  perfis_hoje: P(BAL, ESC), capability: 'qualquer(pdv.cash.operate, sales.view)', escopo: 'pdv',
  nota: 'Caixa efetivo para dizer se a gaveta abre por comando. É leitura. Com escopo em lista, fora do escopo a resposta deve ser byCommand:false (o botão não aparece) ou 403 CORE_TERMINAL_OUT_OF_SCOPE; decidir na F2(a). No dia 1 (all_terminals=1) nada muda. Aqui o terminalId vem da query, e não do corpo.',
});
add({
  linha: 1687, tipo: 'servico', metodo: 'POST', caminho: '/core/print/drawer/open',
  guarda_hoje: 'terminalDoPedido({ informado: req.body?.terminalId, doDispositivo: req.auth?.storeId }) + assertTerminalDaEmpresa(companyId, caixa) (1687-1688)',
  perfis_hoje: P(BAL, L, O), capability: 'pdv.cash.operate', escopo: 'pdv',
  nota: 'Hoje um caixa ou gerente logado por senha abre a gaveta de QUALQUER caixa da empresa, informando terminalId no corpo. Com o escopo, caixa fora da lista dá 403 CORE_TERMINAL_OUT_OF_SCOPE, e login por senha sem caixa, com gavetas em caixas fora do escopo, dá 409 CORE_TERMINAL_REQUIRED (desenho §6.2). Na empresa com 0 caixas (a gaveta única, terminal_id nulo), vale só a capability.',
});

sites.sort((a, b) => a.linha - b.linha);
const out = new URL('sites-core-1.json', DIR);
fs.writeFileSync(out, JSON.stringify(sites, null, 2) + '\n', 'utf8');
const back = JSON.parse(fs.readFileSync(out, 'utf8'));
const cnt = (k) => back.reduce((m, s) => ((m[s[k]] = (m[s[k]] || 0) + 1), m), {});
console.log('sites', back.length, cnt('tipo'));
console.log('equivalencia', cnt('equivalencia_dia1'));
for (const s of back) if (s.equivalencia_dia1 && s.equivalencia_dia1 !== 'igual') console.log(' ', s.linha, s.caminho, s.equivalencia_dia1);
