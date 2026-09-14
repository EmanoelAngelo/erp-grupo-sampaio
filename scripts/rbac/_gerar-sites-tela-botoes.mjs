// Gera sites-tela-botoes.json — fatia "tela-botoes": useHasProfile, listas de perfis e
// checagens de perfil em src/ fora de src/router e navItems.ts (devora-int-b, HEAD fb4c111).
// Só lê. A equivalência dia-1 é medida contra perfis_de_hoje de catalogo.json.
import fs from 'node:fs';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const catalogo = JSON.parse(fs.readFileSync(path.join(AQUI, 'catalogo.json'), 'utf8'));
const CAT = new Map(catalogo.map((c) => [c.code, c]));

const D = ['admin_geral', 'gestor'];
const TODOS = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
const ORDEM = new Map(TODOS.map((p, i) => [p, i]));
const ord = (xs) => [...new Set(xs)].sort((a, b) => ORDEM.get(a) - ORDEM.get(b));
const uhp = (...xs) => ord([...D, ...xs]); // o que useHasProfile(...xs) responde hoje

function alcance(expr) {
  const m = /^(qualquer|todas)\((.*)\)$/.exec(expr);
  const codes = m ? m[2].split(',').map((s) => s.trim()) : [expr];
  for (const c of codes) if (!CAT.has(c)) throw new Error(`capability fora do catálogo: ${c}`);
  const sets = codes.map((c) => new Set(CAT.get(c).perfis_de_hoje));
  if (!m || m[1] === 'qualquer') return ord(sets.flatMap((s) => [...s]));
  return ord([...sets[0]].filter((p) => sets.every((s) => s.has(p))));
}
function escopoDe(expr) {
  const m = /^(qualquer|todas)\((.*)\)$/.exec(expr);
  const codes = m ? m[2].split(',').map((s) => s.trim()) : [expr];
  const esc = [...new Set(codes.map((c) => CAT.get(c).escopo))];
  // pdv > bancada > empresa > grupo: o mais específico que a expressão toca
  for (const e of ['pdv', 'bancada', 'empresa', 'grupo']) if (esc.includes(e)) return e;
  return 'empresa';
}

const S = [];
function site(o) {
  const semMedida = /^(SO_AUTENTICADO|PUBLICA|FALTA:)/.test(o.capability) || o.sem_medida;
  if (!semMedida) {
    const novo = alcance(o.capability);
    const hoje = ord(o.perfis_hoje);
    const ganha = novo.filter((p) => !hoje.includes(p));
    const perde = hoje.filter((p) => !novo.includes(p));
    o.equivalencia_dia1 = ganha.length || perde.length
      ? `DIFERE ganha=[${ganha.join(',')}] perde=[${perde.join(',')}]`
      : 'igual';
    if (!o.escopo) o.escopo = escopoDe(o.capability);
  } else {
    o.equivalencia_dia1 = o.equivalencia_dia1 ?? 'n/a';
  }
  o.perfis_hoje = ord(o.perfis_hoje);
  const { sem_medida, ...resto } = o;
  S.push(resto);
}

// ───────────────────────────── o atalho e os mecanismos ─────────────────────────────

site({
  arquivo: 'src/hooks/useSession.ts', linha: 34, tipo: 'atalho-admin', tela: '(todas as telas que chamam useHasProfile)',
  guarda_hoje: "useHasProfile (31-36): if (DONOS_DO_GRUPO.includes(profile)) return true;  // DONOS_DO_GRUPO importado de src/router/environments.ts:257 (useSession.ts:7)",
  perfis_hoje: D, capability: 'group.admin', escopo: 'grupo', sem_medida: true,
  equivalencia_dia1: 'n/a (atalho, não guarda)',
  nota: "Atalho #25 do desenho §8 — o 'if admin allowEverything' do navegador. NÃO vira guarda: quem passa aqui é exatamente perfis_de_hoje de group.admin, e é só por isso que o code aparece. No modelo novo o hook inteiro morre (F5) e cada chamada vira useCan(<capability>) lendo session.access.capabilities; o administrador passa porque o modelo dele é full_catalog=1, não por pergunta de código. Esquisito: useHasProfile() SEM argumento é usado como 'só donos' em 4 telas (AsaasDoGrupoCard:28, RecuperacaoDeSenhaDaOperacao:20, PoliticaGestaoPage:33, TerminaisPage:415) — cada uma responde a uma capability diferente (group.dashboard.view, users.password_recovery.manage, settings.management_policy.manage, devices.manage); traduzir todas para group.admin estreitaria o dono que personalizar essas capabilities. Também: useProfile (18-20) devolve o profileCode cru; hoje não tem outro chamador fora deste arquivo.",
});

site({
  arquivo: 'src/components/gs/AppShell.tsx', linha: 38, tipo: 'tela-menu', tela: '(menu lateral — todas as telas com AppShell)',
  guarda_hoje: "canSee(item, environment, profileCode) (31-39): !environment → false; (item.environments ?? ['gestao']).includes(environment); perfilAtende(profileCode, item.profiles)  — environment = environmentOf(session.user.profileCode) (62)",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: "MECANISMO do filtro de grupo do menu, não um ponto com capability própria: cada item de NAV_ITEMS (navItems.ts, outra fatia) declara environments/profiles, e é aqui que se decide. Na F3 vira useCan(item.pode) e o 'grupo aparece se algum filho aparece' (96) continua. Fallback perigoso: environmentOf devolve null para código fora de AMBIENTE_POR_PERFIL (environments.ts:121-124), e canSee devolve false para TODO item — um vínculo com modelo do dono (código 'dono-…') ficaria com o menu VAZIO. Mais um motivo para a personalização só ligar com a catraca em 0 (desenho §4.2). O padrão ['gestao'] (37) some: ambiente passa a ser só a porta de login.",
});

site({
  arquivo: 'src/components/gs/AppShell.tsx', linha: 57, tipo: 'tela-menu', tela: '(menu lateral — todas as telas com AppShell)',
  guarda_hoje: "canSeeChild(child, parent, environment, profileCode) (47-58): (child.environments ?? parent.environments ?? ['gestao']).includes(environment); perfilAtende(profileCode, child.profiles ?? parent.profiles)",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: "MECANISMO do filtro de subitem (herda do grupo). Mesmo destino de canSee: useCan(child.pode ?? parent.pode). A herança do grupo tem de ficar (um subitem não nasce mais visível que o grupo). Mesma queda para null do perfil desconhecido (linha 53).",
});

// ───────────────────────────── a casa depois do login (homeOf por perfil) ─────────────────────────────

const notaCasa = "Casa decidida pelo PERFIL: homeOf(profileCode) → CASA[AMBIENTE_POR_PERFIL[code] ?? 'gestao'] (environments.ts:67-98, 114-136). Na F3 vira session.access.casa, calculada pelo servidor com a tabela ordenada de §11.3 (dashboard.view → /sistema/painel; pdv.sell → /pdv; workshop.kanban.view → /sistema/oficina; accounting.closing.view → /sistema/fiscal/fechamento; … ; nenhuma → /sem-acesso). Com os modelos dia-1 a casa é a mesma de hoje. Fallback perigoso de hoje: código desconhecido → /sistema/painel, que é ROTA_GESTAO; Protected, com ambiente null, devolve de novo para /sistema/painel — laço (risco PLAUSIBLE do mapa, environments.ts:121-136 + Protected.tsx:90-92). Todo modelo do dono cairia nele.";
site({
  arquivo: 'src/pages/gs/LoginPage.tsx', linha: 138, tipo: 'tela-rota', tela: '/login (aba Gestão/PDV, login com senha)',
  guarda_hoje: 'navigate(destinationFor(session.user.profileCode)) — destinationFor = homeOf (82)',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa', nota: notaCasa,
});
site({
  arquivo: 'src/pages/gs/LoginPage.tsx', linha: 170, tipo: 'tela-rota', tela: '/login (bloco ACESSO RÁPIDO)',
  guarda_hoje: 'entrarRapido → quickLogin(u.id, u.company_id) → navigate(destinationFor(session.user.profileCode))',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: `${notaCasa} Este ponto é do ACESSO RÁPIDO (LoginPage.tsx:154-176; POST /auth/quick-login, auth.ts:688, rotaPublica), que a preparação para entrega manda apagar inteiro — não precisa de tradução, sai junto.`,
});
site({
  arquivo: 'src/pages/gs/LoginPage.tsx', linha: 184, tipo: 'tela-rota', tela: '/login (aba PDV, token de terminal)',
  guarda_hoje: 'submitDevice → loginWithDeviceToken(deviceToken) → navigate(destinationFor(session.user.profileCode))',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'pdv',
  nota: `${notaCasa} Login de dispositivo (POST /auth/device/login, auth.ts:353, rotaPublica): com o escopo de caixa do desenho §6, o caixa do token precisa estar no escopo do dono do token, senão 403 API_TERMINAL_OUT_OF_SCOPE antes de chegar aqui.`,
});
site({
  arquivo: 'src/pages/gs/OficinaLoginPage.tsx', linha: 70, tipo: 'tela-rota', tela: '/oficina/login',
  guarda_hoje: 'navigate(homeOf(session.user.profileCode))',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: `${notaCasa} A porta da bancada leva cada um para a casa DELE (cabeçalho do arquivo, 15): com capability, o técnico da oficina (cenário G) vai a /sistema/oficina porque só tem workshop.*, e não por morar no ambiente 'oficina'.`,
});
site({
  arquivo: 'src/components/gs/TrocaDeSenhaProvisoria.tsx', linha: 98, tipo: 'tela-rota', tela: '(etapa de troca da senha provisória, dentro de /login e /oficina/login)',
  guarda_hoje: 'navigate(homeOf(session.user.profileCode)) depois de relogar com a senha nova',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: `${notaCasa} É o caminho do administrador inicial (senha provisória + troca obrigatória): com o modelo admin_geral full_catalog a casa dele é /sistema/painel pela tabela, como hoje.`,
});

// ───────────────────────────── componentes ─────────────────────────────

site({
  arquivo: 'src/components/gs/AsaasDoGrupoCard.tsx', linha: 28, tipo: 'tela-botao', tela: '/sistema/integracoes/asaas (cartão, IntegracaoAsaasPage.tsx:187)',
  guarda_hoje: 'useHasProfile()  // sem argumento = só donos',
  rotas_servidor: ['GET /core/integrations/asaas/grupo (core.ts:13956, requireProfile() = DONOS)'],
  perfis_hoje: D, capability: 'group.dashboard.view',
  nota: "Cartão da prontidão Asaas das seis empresas; só pede a rota se 'dono'. A rota que ele carrega é group.dashboard.view no mapa (visão consolidada do grupo), não group.admin: usar a mesma capability da rota é o que mantém 'a tela não promete o que o servidor nega'. Esquisito: a travessia de empresas desta rota ainda passa por AlcanceCruzado (atalho #6) — quem tiver group.dashboard.view só numa empresa não deveria ver as outras; isso é da fatia (f).",
});
site({
  arquivo: 'src/components/gs/CaixaPdvDialog.tsx', linha: 173, tipo: 'tela-botao', tela: '/pdv (diálogo do caixa, PdvPage.tsx:3713)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // temAlcada",
  rotas_servidor: ['POST /core/cash/:sessionId/movements (core.ts:4212) — a liberação é cobrada no serviço: CashService.ts:353-357 (sangria acima do teto), AUTHORIZERS em AuthorizationService.ts:21'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'approval.cash_withdrawal',
  nota: "Alçada pontual: quem tem alçada faz a sangria acima do teto direto e NÃO vê o pedido de 'Chamar gestor' (sangriaPedeGestor = passaDoTeto && !temAlcada, 363; aviso 737). Espelho de temAlcadaParaLiberar (AuthorizationService.ts:130-132), que no desenho §10 vira can(approval.cash_withdrawal). O operador continua operador: sem a capability ele pede o bilhete de outro, e o gerente assina com a senha dele (a alçada não promove ninguém). O escopo de caixa não se aplica ao liberador (§10).",
});
site({
  arquivo: 'src/components/gs/ConferenciaDeReservas.tsx', linha: 58, tipo: 'tela-botao', tela: '/sistema/estoque (EstoquePage, OperacaoPages.tsx:448)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // solta",
  rotas_servidor: ['POST /core/stock/reservations/:productId/liberar-sem-origem (core.ts:2990)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'inventory.adjust.approve',
  nota: "Botão 'liberar reserva sem origem' (177). Mesma capability que o mapa dá à rota. A leitura da conferência (GET /core/stock/reconciliation, core.ts:2912) é inventory.view.",
});
site({
  arquivo: 'src/components/gs/NotasSemContaAPagar.tsx', linha: 36, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas (EntradaNotasPage.tsx:2180)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // gerencia",
  rotas_servidor: ['GET /core/purchases/notas-sem-conta (core.ts:13049)', 'POST /core/purchases/notes/:id/conta-a-pagar (core.ts:13059)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'purchases.manage',
  nota: "O cartão inteiro some (87) e nem pede a lista (44) sem gerência. As duas rotas são purchases.manage no mapa. Cenário F (Financeiro + Relatórios) NÃO vê este cartão, embora ele gere conta a pagar: a decisão é de compras. Se o dono quiser o financeiro decidindo, a rota passa a qualquer(purchases.manage, finance.manage) — decisão, não dia 1.",
});
site({
  arquivo: 'src/components/gs/RecuperacaoDeSenhaDaOperacao.tsx', linha: 20, tipo: 'tela-botao', tela: '/sistema/usuarios (EquipePage.tsx:193)',
  guarda_hoje: 'useHasProfile()  // sem argumento = só donos',
  rotas_servidor: ['GET /core/team/recuperacao-de-senha (core.ts:9390)', 'PUT /core/team/recuperacao-de-senha (core.ts:9399)'],
  perfis_hoje: D, capability: 'users.password_recovery.manage',
  nota: "Cartão 'Esqueci minha senha' da equipe. Mesma capability da rota (users.password_recovery.manage, escopo empresa, só donos no dia 1). A troca da escolha deve cair na auditoria de §12 (hoje team.password_recovery.config, core.ts:9407-9414).",
});
site({
  arquivo: 'src/components/gs/RegularizarVendasOffline.tsx', linha: 127, tipo: 'tela-botao', tela: '(diálogo das vendas offline recusadas, aberto pelo EstadoConexao em AppShell.tsx:290 e PdvPage.tsx:2508)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeDescartar",
  rotas_servidor: ['POST /core/offline-sales/:id/discard (core.ts:5827)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'sales.supervise',
  nota: "Botão 'descartar' da venda offline (355). Mesma capability da rota. Relançar (relaunch/relaunch-as-new, core.ts:5704/5766) é pdv.sell e não é gateado aqui — certo, o servidor aceita o balcão.",
});
site({
  arquivo: 'src/components/gs/RegularizarVendasOffline.tsx', linha: 129, tipo: 'tela-botao', tela: '(diálogo das vendas offline recusadas) → link para /sistema/vendas',
  guarda_hoje: "environmentOf(sessao?.user?.profileCode) === 'gestao'  // podeAbrirVendas",
  perfis_hoje: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'], capability: 'sales.view',
  nota: "Checagem manual de perfil por AMBIENTE: o link 'Ver a venda em Vendas' (110-113) só aparece para a gestão, porque Protected devolveria o caixa para casa. Na F3 é a própria `pode` da página /sistema/vendas (sales.view, §11.2). Fallback perigoso: perfil desconhecido → environmentOf null → link some (falha fechada, tolerável).",
});

// ───────────────────────────── páginas: produtos e catálogo ─────────────────────────────

site({
  arquivo: 'src/pages/gs/AlteracaoRapidaPage.tsx', linha: 96, tipo: 'tela-botao', tela: '/sistema/produtos/alteracao-rapida',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // podeEditar",
  rotas_servidor: ['PUT /core/products/:id (core.ts:2788, requireProfile(...AUX_EDITORES)) via coreApi.updateProduct (147)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'products.manage',
  nota: "Campos editáveis de custo e venda e o botão salvar (176, 258, 273). A rota é products.manage. Esquisito (não é dia-1, é desenho do catálogo): o estoquista muda o PREÇO DE VENDA por aqui (PUT /products/:id) mas não pode mexer em faixa de preço nem em tabela de preço (products.price.manage, L,O). Se o dono quiser o preço só com gerência, a F2(b) precisa separar o campo de preço no PUT; hoje as duas coisas moram na mesma rota.",
});
site({
  arquivo: 'src/pages/gs/AuxiliaresCatalogoPage.tsx', linha: 84, tipo: 'tela-botao', tela: '/sistema/produtos/auxiliares',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // podeEditar",
  rotas_servidor: ['POST/DELETE /core/catalog/units (core.ts:1986/2005)', 'POST/DELETE /core/catalog/tax-groups (2048/2074)', 'POST/DELETE /core/catalog/tax-rates (2092/2102)', 'POST/DELETE /core/catalog/custom-fields (2131/2150) — todas requireProfile(...AUX_EDITORES)', 'MAS também: POST /core/catalog/price-tables (2168) e DELETE /core/catalog/price-tables/:id (2178) = gerente_loja/gerente_oficina'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'products.manage',
  nota: "PORTA QUE BATE NA CARA: o mesmo podeEditar é passado ao painel de Tabelas de preço (231) e desenha 'nova tabela' (1411) e excluir (1561) para o ESTOQUISTA, mas POST/DELETE /catalog/price-tables são L,O (products.price.manage no mapa) → 403. Na F3 o painel de tabelas deve usar products.price.manage (podeFixar já é essa capability, linha 93); os outros quatro painéis ficam com products.manage. Isso é fechar porta que bate na cara (tipo D6), não mudança de acesso no servidor.",
});
site({
  arquivo: 'src/pages/gs/AuxiliaresCatalogoPage.tsx', linha: 93, tipo: 'tela-botao', tela: '/sistema/produtos/auxiliares (aba Tabelas de preço)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeFixar",
  rotas_servidor: ['PUT /core/catalog/price-tables/:id/items/:productId (core.ts:2207)', 'DELETE /core/catalog/price-tables/:id/items/:productId (core.ts:2226)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'products.price.manage',
  nota: "Fixar/remover preço de produto na tabela (1720, 1875). Mesma capability da rota.",
});
site({
  arquivo: 'src/pages/gs/OperacaoPages.tsx', linha: 126, tipo: 'tela-botao', tela: '/sistema/produtos (ProdutosPage)',
  guarda_hoje: "useHasProfile('gerente_loja', 'estoquista')  // canEdit",
  rotas_servidor: ["'Novo produto' → /sistema/produtos/novo → POST /core/products (core.ts:2743: L,O,E,CL,CO)", 'Clonar → POST /core/products/:id/clone (core.ts:2245, AUX_EDITORES = L,O,E)'],
  perfis_hoje: uhp('gerente_loja', 'estoquista'), capability: 'products.manage',
  nota: "GUARDA DA TELA MAIS ESTREITA QUE O SERVIDOR: a lista esquece gerente_oficina, que o servidor aceita nas duas rotas (e em PUT /products/:id). Hoje o gerente de oficina não vê 'Novo produto' nem 'Clonar' (179, 311), mas pode chegar a /sistema/produtos/novo pela URL e salvar. Com products.manage ele GANHA os botões — tela passa a mostrar o que o servidor já abria (D6), sem mudar o servidor. Listar como deliberada na PR da F3.",
});
site({
  arquivo: 'src/pages/gs/ImportacaoPlanilhaPage.tsx', linha: 230, tipo: 'tela-botao', tela: '/sistema/estoque/importacao-planilha',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeConfirmar",
  rotas_servidor: ['POST /core/import/produtos/:id/confirmar (core.ts:16702)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'products.catalog.admin',
  nota: "Botão 'Confirmar importação' (738). Mesma capability da rota. O resto da tela (subir, reler, remapear, descartar) é products.manage — é a `pode` da página (§11.2).",
});

// ───────────────────────────── estoque ─────────────────────────────

site({
  arquivo: 'src/pages/gs/InventarioPage.tsx', linha: 97, tipo: 'tela-botao', tela: '/sistema/estoque/inventario',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeFecharAContagem",
  rotas_servidor: ['POST /core/inventory-counts/:id/apply (core.ts:15311)', 'POST /core/inventory-counts/:id/cancel (core.ts:15334)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'inventory.adjust.approve',
  nota: "Aplicar/cancelar a contagem. Mesma capability da rota. Não há alçada pontual para isso (aplicar_inventario não está em RESTRICTED_ACTIONS), então o botão some em vez de pedir gestor — o comentário (71-95) continua valendo.",
});
site({
  arquivo: 'src/pages/gs/LocaisEstoquePage.tsx', linha: 36, tipo: 'tela-botao', tela: '/sistema/estoque/locais',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // podeMexer",
  rotas_servidor: ['POST /core/stock/locations (core.ts:3306)', 'PATCH /core/stock/locations/:id (core.ts:3329)', 'POST /core/stock/transfers (core.ts:3367)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'inventory.manage',
  nota: "Criar, desativar e transferir (179, 238, 332). Mesma capability das três rotas.",
});
site({
  arquivo: 'src/pages/gs/MovimentacoesEstoquePage.tsx', linha: 661, tipo: 'tela-botao', tela: '/sistema/estoque/movimentacoes',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')  // podeLancar",
  rotas_servidor: ['POST /core/stock/movements (core.ts:3101)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina'), capability: 'qualquer(inventory.manage, pdv.backoffice)',
  nota: "Formulário de lançamento manual. A expressão é a mesma da rota. Os dois caixas da lista não chegam a esta tela hoje (ROTA_GESTAO); com a `pode` da página = inventory.view eles continuam fora — pdv.backoffice só serve à retaguarda pelo balcão.",
});
site({
  arquivo: 'src/pages/gs/UnidadesEstoquePage.tsx', linha: 399, tipo: 'tela-botao', tela: '/sistema/estoque/unidades',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // podeReimprimir",
  rotas_servidor: ['POST /core/units/:id/equipment/sheet (core.ts:11734)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'inventory.units.manage',
  nota: "Reimprimir a plaquinha da moto pela unidade (992). Mesma capability da rota.",
});

// ───────────────────────────── compras ─────────────────────────────

site({
  arquivo: 'src/pages/gs/EntradaNotasPage.tsx', linha: 716, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // marcaPeca",
  rotas_servidor: ['POST /core/products/:id/tipo (core.ts:2289, AUX_EDITORES) via coreApi.definirTipoProduto (1044)', 'carrega GET /core/workshops (7426) e GET /core/workshop/parts (15659) só para quem marca (1005-1023)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'products.manage',
  nota: "Coluna 'marcar como peça'. A rota que decide é POST /products/:id/tipo = products.manage (não workshop.parts.manage, que é da tela de Peças). As duas leituras de apoio (workshop.benches.view e workshop.parts.view) alcançam o mesmo conjunto no dia 1.",
});
site({
  arquivo: 'src/pages/gs/EntradaNotasPage.tsx', linha: 724, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // estorna",
  rotas_servidor: ['POST /core/purchases/notes/:id/estornar (core.ts:12931)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'purchases.manage',
  nota: 'Estornar entrada confirmada. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EntradaNotasPage.tsx', linha: 731, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // lancaManual",
  rotas_servidor: ['POST /core/purchases/manual (core.ts:12889)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'purchases.receive',
  nota: 'Entrada manual. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EntradaNotasPage.tsx', linha: 740, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')  // vincula",
  rotas_servidor: ['POST /core/purchases/notes/:id/link (core.ts:12744)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina'), capability: 'qualquer(purchases.receive, pdv.backoffice)',
  nota: "Vincular item da nota a produto (1519). Expressão igual à da rota. Os caixas não chegam à tela hoje (ROTA_GESTAO); a `pode` nova da página é qualquer(purchases.receive, pdv.backoffice) (§11.2), então com capability os caixas da loja e da oficina PASSAM a ver /sistema/compras/entrada-notas — o servidor já os aceita nas rotas de conferência; é D6, a listar.",
});
site({
  arquivo: 'src/pages/gs/EntradaNotasPage.tsx', linha: 778, tipo: 'tela-botao', tela: '/sistema/compras/entrada-notas (notas contra o CNPJ, DF-e)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // manifesta",
  rotas_servidor: ['POST /core/purchases/dfe/:chave/manifestar (core.ts:12615)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'purchases.manage',
  nota: 'Manifestar é ato fiscal (2475). Mesma capability da rota. Consultar e importar DF-e (12607/12634) são purchases.receive e não passam por esta variável.',
});
site({
  arquivo: 'src/pages/gs/DevolucoesFornecedorPage.tsx', linha: 463, tipo: 'tela-botao', tela: '/sistema/compras/devolucoes',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // gerencia",
  rotas_servidor: ['POST /core/purchases/supplier-returns (core.ts:13003)', 'POST /core/purchases/supplier-returns/:id/fiscal (core.ts:13093)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'purchases.manage',
  nota: "Registrar devolução e resolver o fiscal (416, 512, 531). Mesma capability das rotas; o estoquista lê (purchases.view).",
});
site({
  arquivo: 'src/pages/gs/PedidosCompraPage.tsx', linha: 311, tipo: 'tela-botao', tela: '/sistema/compras/pedidos',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // gerencia",
  rotas_servidor: ['POST /core/purchase-orders/:id/email (core.ts:15003)', 'POST /core/purchase-orders/:id/send (core.ts:14962)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'purchases.manage',
  nota: "Enviar por e-mail e marcar como enviado (778, 785). Mesma capability. PORTA QUE BATE NA CARA ao lado: 'Cancelar pedido' (789-790) NÃO usa esta variável e aparece ao ESTOQUISTA, mas POST /core/purchase-orders/:id/cancel (core.ts:15030) é L,O (purchases.manage) → 403. Na F3 o botão de cancelar também deve pedir purchases.manage.",
});

// ───────────────────────────── financeiro ─────────────────────────────

site({
  arquivo: 'src/pages/gs/ContasPage.tsx', linha: 288, tipo: 'tela-botao', tela: '/sistema/financeiro/contas-a-receber e /contas-a-pagar',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeLancar",
  rotas_servidor: ['POST /core/finance/entries (core.ts:6419)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'finance.manage',
  nota: "Botão 'Lançar conta'. Mesma capability da rota. Cenário F (financeiro_relatorios) tem finance.manage e vê o botão.",
});
site({
  arquivo: 'src/pages/gs/ContasPage.tsx', linha: 300, tipo: 'tela-botao', tela: '/sistema/financeiro/contas-a-receber (CobrancasCard e linhas)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina')  // podeCobrar",
  rotas_servidor: ['POST /core/finance/entries/:id/charge (core.ts:6624)', 'POST /core/finance/entries/:id/charges/cancel (6678)', 'POST /core/payment-intents/:id/retry (6806)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'), capability: 'qualquer(finance.manage, pdv.cash.operate)',
  nota: "Gerar, cancelar e retentar cobrança (1083, 1093, 1344). Expressão igual à das três rotas. Os caixas não chegam à tela (ROTA_GESTAO hoje, finance.view na F3), então para eles a lista é letra morta nos dois mundos.",
});
site({
  arquivo: 'src/pages/gs/ContasPage.tsx', linha: 314, tipo: 'tela-botao', tela: '/sistema/financeiro/contas-a-receber (CobrancasCard)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeEstornar",
  rotas_servidor: ['POST /core/finance/entries/:id/charges/refund (core.ts:6714)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'finance.manage',
  nota: 'Estornar cobrança. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/FechamentoContadorPage.tsx', linha: 255, tipo: 'tela-botao', tela: '/sistema/fiscal/fechamento',
  guarda_hoje: "(getSession()?.user.profileCode ?? '') !== 'contador'  // souDaGestao",
  rotas_servidor: ['GET/POST/PATCH /core/fiscal/contador/destinatarios (core.ts:8622/8632/8648)', 'GET/PUT /core/fiscal/contador/agenda (8666/8678)', 'POST /core/fiscal/closings/:period/enviar (8702)', 'GET /core/fiscal/closings/:period/envios (8722)'],
  perfis_hoje: ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], capability: 'accounting.closing.send',
  nota: "Checagem manual de perfil POR NEGAÇÃO, sem useHasProfile: a seção de envio e os efeitos (295, 753) valem para todo mundo que não é 'contador'. Dos que chegam à tela hoje (QUEM_ENTREGA_A_CONTABILIDADE: donos, L, O, contador) isso dá exatamente accounting.closing.send. FALLBACK PERIGOSO: qualquer código que não seja literalmente 'contador' (um modelo do dono 'dono-…', ou um 'contador' personalizado com outro código) é tratado como gestão e dispara as 7 chamadas L,O que voltam 403. Com useCan('accounting.closing.send') a pergunta vira positiva.",
});
site({
  arquivo: 'src/pages/gs/PainelPage.tsx', linha: 63, tipo: 'tela-botao', tela: '/sistema/painel',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // abreACentral",
  rotas_servidor: ['link para /sistema/relatorios/central → GET /core/reports (core.ts:16333)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'reports.central.view',
  nota: "Link 'ver o relatório' do estoque baixo (387). O comentário diz 'o mesmo recorte do menu': na F3 é a `pode` de /sistema/relatorios/central. Cenário D (pdv_painel) tem dashboard.view e não reports.central.view: não vê o link, certo.",
});

// ───────────────────────────── vendas, caixa, PDV ─────────────────────────────

site({
  arquivo: 'src/pages/gs/DevolucoesPage.tsx', linha: 163, tipo: 'tela-botao', tela: '/sistema/vendas/devolucoes',
  guarda_hoje: "useHasProfile('gerente_loja')  // cancelaDireto",
  rotas_servidor: ["POST /core/sales/:id/cancel (core.ts:6259) — comLiberacaoPontual com perfisQuePodemDireto ['gerente_loja'] (core.ts:6287)"],
  perfis_hoje: uhp('gerente_loja'), capability: 'sales.cancel.direct',
  nota: "Decide se a confirmação avisa que um gestor vai assinar. Espelho do 'faz direto' de comLiberacaoPontual (atalho #14: admin/gestor fazem direto em core.ts:6213-6217). Desenho §10: capabilityDireta = sales.cancel.direct, conjunto exato {donos, gerente_loja}. Não é autorização: a rota é sales.returns.operate e recusa sem bilhete com CORE_CANCEL_NEEDS_AUTHORIZATION.",
});
site({
  arquivo: 'src/pages/gs/DevolucoesPage.tsx', linha: 164, tipo: 'tela-botao', tela: '/sistema/vendas/devolucoes',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // devolveDireto",
  rotas_servidor: ["POST /core/sale-returns (core.ts:15164) — comLiberacaoPontual com perfisQuePodemDireto ['gerente_loja','gerente_oficina'] (core.ts:15178)"],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'approval.sale_return',
  nota: "Mesmo idioma do cancelamento. Desenho §10: a capability direta da devolução é approval.sale_return (quem libera faz direto), conjunto exato {donos, L, O}.",
});
site({
  arquivo: 'src/pages/gs/OperacaoPages.tsx', linha: 1460, tipo: 'tela-botao', tela: '/sistema/caixa (CaixaPage)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // reabreDireto",
  rotas_servidor: ['POST /core/cash/:sessionId/reopen (core.ts:4322) — o bilhete é cobrado em CashService.ts:664-676 para quem não tem alçada'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'approval.cash_reopen',
  nota: "Espelho de temAlcadaParaLiberar (AUTHORIZERS). Quem não tem vê o aviso 'com a liberação de um gestor' (1748). A rota em si é pdv.cash.operate; a alçada é can(approval.cash_reopen). A reabertura precisa também de requireTerminalNoEscopo pela session.terminal_id (§6.3).",
});
site({
  arquivo: 'src/pages/gs/OrcamentosPage.tsx', linha: 45, tipo: 'tela-botao', tela: '/sistema/orcamentos',
  guarda_hoje: "const BALCAO_E_GERENCIA = ['operador_caixa','operador_caixa_loja','operador_caixa_oficina','gerente_loja','gerente_oficina']  // lista local",
  perfis_hoje: uhp('operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'gerente_loja', 'gerente_oficina'), capability: 'pdv.cash.operate',
  nota: "LISTA DE PERFIS copiada à mão do servidor (core.ts:937) — terceira cópia de BALCAO_E_GERENCIA (servidor, esta, e o espelho do teste). Alimenta 420 e 421. Somada ao atalho, é exatamente perfis_de_hoje de pdv.cash.operate, e é assim que ela entra nas expressões das duas linhas abaixo. Morre na F3 (useCan).",
});
site({
  arquivo: 'src/pages/gs/OrcamentosPage.tsx', linha: 420, tipo: 'tela-botao', tela: '/sistema/orcamentos',
  guarda_hoje: "useHasProfile(...BALCAO_E_GERENCIA, 'atendente')  // podeEscrever",
  rotas_servidor: ['POST /core/quotes (core.ts:5021)', 'PATCH /core/quotes/:id (5289)', 'POST /core/quotes/:id/renew (5337)', 'POST /core/quotes/:id/promote (5185)', 'PUT /core/quotes/:id/unidades (5147)'],
  perfis_hoje: uhp('operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'gerente_loja', 'gerente_oficina', 'atendente'), capability: 'sales.quotes.manage',
  nota: 'Novo, editar, renovar, aprovar. Mesma capability das rotas.',
});
site({
  arquivo: 'src/pages/gs/OrcamentosPage.tsx', linha: 421, tipo: 'tela-botao', tela: '/sistema/orcamentos',
  guarda_hoje: 'useHasProfile(...BALCAO_E_GERENCIA)  // podeFechar',
  rotas_servidor: ['POST /core/quotes/:id/convert (core.ts:5071)', 'POST /core/quotes/:id/cancel (core.ts:5245)'],
  perfis_hoje: uhp('operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'gerente_loja', 'gerente_oficina'), capability: 'todas(sales.quotes.manage, pdv.cash.operate)',
  nota: "Faturar e cancelar. Expressão igual à das duas rotas (o mapa usa todas(): quem fatura precisa de caixa). O atendente escreve o orçamento mas não fatura — continua assim.",
});
site({
  arquivo: 'src/pages/gs/OrcamentosPage.tsx', linha: 422, tipo: 'tela-botao', tela: '/sistema/orcamentos',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeLiberarVencidos",
  rotas_servidor: ['POST /core/quotes/expire-overdue (core.ts:5267)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'sales.supervise',
  nota: 'Liberar vencidos. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/PdvPage.tsx', linha: 572, tipo: 'tela-botao', tela: '/pdv',
  guarda_hoje: "useHasProfile('operador_caixa_oficina', 'gerente_oficina')  // recebeOs",
  rotas_servidor: ['GET /core/workshop/pending-payment (core.ts:10174)'],
  perfis_hoje: uhp('operador_caixa_oficina', 'gerente_oficina'), capability: 'workshop.checkout',
  nota: "Fila de OS a receber no PDV (578-583). Mesma capability da rota. Escopo bancada: com bancadasDoVinculo (§7) a fila deve vir filtrada pelas bancadas do vínculo; o caixa da oficina tem all_workshops=1 pelo passo 86 (não é membro), então no dia 1 nada muda. Cenário H (Caixa da oficina + técnico) vê a fila.",
});
site({
  arquivo: 'src/pages/gs/OperacaoPages.tsx', linha: 627, tipo: 'tela-botao', tela: '/sistema/clientes (ClientesPage)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeVincular",
  rotas_servidor: ['PUT /core/customers/:id/price-table (core.ts:3822)', 'carrega GET /core/catalog/aux (1965) só para quem vincula (680-685)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'products.price.manage',
  nota: 'Vincular cliente a tabela de preço (1067). Mesma capability da rota (o mapa põe price-table do cliente em products.price.manage).',
});
site({
  arquivo: 'src/pages/gs/OperacaoPages.tsx', linha: 634, tipo: 'tela-botao', tela: '/sistema/clientes (ClientesPage)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeAtenderTitular",
  rotas_servidor: ['GET /core/customers/:id/dados-do-titular (core.ts:3891)', 'POST /core/customers/:id/anonimizar (core.ts:3911)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'customers.privacy.manage',
  nota: 'Atendimento LGPD do titular (973). Mesma capability das rotas.',
});
site({
  arquivo: 'src/pages/gs/OperacaoPages.tsx', linha: 642, tipo: 'tela-botao', tela: '/sistema/clientes (ClientesPage)',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina')  // podeEditar",
  rotas_servidor: ['POST /core/customers (core.ts:3738)', 'PUT /core/customers/:id (core.ts:3788)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina'), capability: 'customers.manage',
  nota: "Cadastrar/editar ficha. Mesma capability das rotas. Os caixas da lista não chegam à tela hoje; com a `pode` da página = customers.view eles continuam fora (customers.view não é dos caixas).",
});

// ───────────────────────────── oficina ─────────────────────────────

site({
  arquivo: 'src/pages/gs/OficinaPage.tsx', linha: 337, tipo: 'tela-botao', tela: '/sistema/oficina',
  guarda_hoje: "useHasProfile('gerente_oficina')  // podeEditarSla",
  rotas_servidor: ['GET /core/workshop/sla (core.ts:9924)', 'PUT /core/workshop/sla (core.ts:9934)'],
  perfis_hoje: uhp('gerente_oficina'), capability: 'workshop.admin',
  nota: "Editor da régua de SLA (676). Mesma capability das rotas. Note que gerente_loja chega ao kanban e NÃO edita SLA — continua assim.",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 279, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina')  // mexeEmPeca",
  rotas_servidor: ['POST /core/workshop/orders/:id/parts (core.ts:9986)', 'POST /core/workshop/orders/:orderId/parts/:partId/return (core.ts:15856)', 'também decide mexeNaConta (868) → POST /core/workshop/orders/:id/labor (10017)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina'), capability: 'workshop.parts.use',
  nota: "Lançar e devolver peça (838, 844, 1292, 1361). Mesma capability das rotas de peça. ESQUISITO: a mesma variável também libera a mão de obra (mexeNaConta, 868), que no catálogo é workshop.labor.manage — mesmo conjunto no dia 1, mas um dono que der só workshop.parts.use (sem labor) veria o botão de mão de obra e tomaria 403. Na F3 separar: mexeNaConta = useCan('workshop.labor.manage'). A trava 'deOutroTecnico' continua (isManagerProfile → can('workshop.admin'), §7.3).",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 290, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')  // podeFotografar",
  rotas_servidor: ['POST /core/workshop/orders/:id/photos (core.ts:9829)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente'), capability: 'workshop.orders.open',
  nota: "Tirar foto na OS (1186). Mesma capability da rota. Apagar foto (DELETE 9858) é workshop.orders.plan no mapa e não passa por aqui.",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 297, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina', 'atendente')  // pedeAprovacao",
  rotas_servidor: ['POST /core/workshop/orders/:id/pedir-aprovacao (core.ts:10044)', 'POST /core/workshop/orders/:id/decidir-orcamento (core.ts:10081)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina', 'atendente'), capability: 'workshop.quote.request',
  nota: "Pedir aprovação do orçamento ao cliente (1573). Mesma capability das rotas. Também entra em temServicoEConta (881) junto com mexeEmPeca e caixaDaOficina — é só visibilidade do cartão.",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 298, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('operador_caixa_oficina', 'gerente_oficina')  // caixaDaOficina",
  rotas_servidor: ['POST /core/workshop/orders/:id/checkout (core.ts:10197)', 'POST /core/workshop/orders/:id/estorno (core.ts:10267)', 'e podeEmitir de DocumentosFiscaisDaOs (1799) → POST /core/fiscal/sales/:saleId/emit (core.ts:7972) e NFS-e da venda (nfse.ts:82/91/112)'],
  perfis_hoje: uhp('operador_caixa_oficina', 'gerente_oficina'), capability: 'workshop.checkout',
  nota: "Cobrar a OS e o estorno (1714, 1742). Mesma capability do checkout. ESQUISITO: a mesma variável decide quem EMITE a nota da OS (DocumentosFiscaisDaOs podeEmitir, 1799), cujas rotas são fiscal.sale.emit = {donos, L, O, C, CL, CO}: hoje a tela esconde a emissão de gerente_loja e dos caixas da loja que o servidor aceitaria. Na F3 separar: podeEmitir = useCan('fiscal.sale.emit') (mudança D6, a listar) ou manter workshop.checkout de propósito ('quem cobrou emite', comentário em DocumentosFiscaisDaOs.tsx:65).",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 299, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')  // podeComentar",
  rotas_servidor: ['POST /core/workshop/orders/:id/comments (core.ts:9956)', 'PATCH /core/workshop/orders/:id/checklist/:itemId (9897) usa o mesmo conjunto'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente'), capability: 'workshop.orders.open',
  nota: "Comentar na linha do tempo (1128, 1145); combinado com falaComoTecnico/deOutroTecnico em podeComentarNestaOs (850). Mesma capability da rota. Efeito do D3 (§7.2): POST comments usa resolveWorkshop, e quem ganhou all_workshops=1 por não ser membro passa a poder pedir bancada específica.",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 307, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('gerente_oficina')  // gerenteDaOficina",
  rotas_servidor: ['POST /core/workshop/orders/:id/regularizar (core.ts:9734)', 'e a trava de responsável no servidor: isManagerProfile (core.ts:7417-7424) em move/plan/parts/labor/release'],
  perfis_hoje: uhp('gerente_oficina'), capability: 'workshop.admin',
  nota: "Replaneja e devolve OS de outro técnico, regulariza (844, 890, 955, 1367, 1430). Tradução exata de §7.3: isManagerProfile → can('workshop.admin').",
});
site({
  arquivo: 'src/pages/gs/OrdemServicoPage.tsx', linha: 313, tipo: 'tela-botao', tela: '/sistema/oficina/os/:id',
  guarda_hoje: "useHasProfile('mecanico')  // ehMecanico; usado só em falaComoTecnico = ehMecanico && !gerenteDaOficina (314)",
  rotas_servidor: ['espelho de vozNaOs (core.ts:7407-7410): técnico fala com a trava de responsável'],
  perfis_hoje: uhp('mecanico'), capability: 'workshop.orders.assume',
  nota: "Voz de técnico na OS. Tradução de §7.3: falaComoTecnico = can('workshop.orders.assume') && !can('workshop.admin'). A variável isolada DIFERE (gerente_oficina ganha workshop.orders.assume), mas o único uso é o composto da linha 314, que dá o MESMO resultado no dia 1: donos e gerente_oficina têm workshop.admin → não falam como técnico; mecânico fala. Esquisito hoje: admin_geral/gestor passam por ehMecanico só pelo atalho e são desligados pelo gerenteDaOficina — o atalho em dose dupla se anula.",
});
site({
  arquivo: 'src/pages/gs/PecasPage.tsx', linha: 143, tipo: 'tela-botao', tela: '/sistema/oficina/pecas',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista')  // daEntrada",
  rotas_servidor: ['POST /core/workshop/parts (core.ts:15723)', 'POST /core/workshop/parts/:id/reposicao (15785)', 'PATCH /core/workshop/parts/:id (15828)', 'carrega GET /core/workshops (7426, escritório) só para quem dá entrada (181-193)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina', 'estoquista'), capability: 'workshop.parts.manage',
  nota: "Cadastrar peça, repor, ajustar mínimo/local (346, 723, 752, 793). Mesma capability das rotas. O gate da carga de /workshops existe porque o mecânico chega a esta tela (ROTA_OFICINA) e /workshops é só escritório (403) — com capability a leitura vira workshop.benches.view e o mecânico continua sem ela.",
});
site({
  arquivo: 'src/pages/gs/PlaquinhasPage.tsx', linha: 161, tipo: 'tela-botao', tela: '/sistema/equipamentos/plaquinhas',
  guarda_hoje: "useHasProfile('gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista')  // podeGerar",
  rotas_servidor: ['POST /core/equipment-tags/batches (core.ts:12139)', 'POST /core/equipment-tags/sheet (12243)', 'POST /core/equipment-tags/:id/damage (12368)'],
  perfis_hoje: uhp('gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista'), capability: 'workshop.tags.print',
  nota: 'Gerar lote, imprimir, marcar danificada (343, 733). Mesma capability das rotas.',
});
site({
  arquivo: 'src/pages/gs/PlaquinhasPage.tsx', linha: 162, tipo: 'tela-botao', tela: '/sistema/equipamentos/plaquinhas',
  guarda_hoje: "useHasProfile('gerente_oficina', 'gerente_loja')  // podeEditarLayout",
  rotas_servidor: ['PUT /core/equipment-tags/layout (core.ts:12433)'],
  perfis_hoje: uhp('gerente_oficina', 'gerente_loja'), capability: 'workshop.tags.layout',
  nota: 'Editar o layout (289). Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/PlaquinhasPage.tsx', linha: 170, tipo: 'tela-botao', tela: '/sistema/equipamentos/plaquinhas',
  guarda_hoje: "useHasProfile('gerente_oficina', 'gerente_loja', 'estoquista')  // podeLiberar",
  rotas_servidor: ['POST /core/equipment-tags/release (core.ts:12344)'],
  perfis_hoje: uhp('gerente_oficina', 'gerente_loja', 'estoquista'), capability: 'workshop.tags.release',
  nota: 'Liberar lote para uso (610). Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EquipamentosPage.tsx', linha: 132, tipo: 'tela-botao', tela: '/sistema/equipamentos',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')  // podeCadastrar",
  rotas_servidor: ['POST /core/equipment (core.ts:10392)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente'), capability: 'workshop.orders.open',
  nota: "Cadastrar equipamento. Mesma capability da rota (o mapa põe POST /equipment em workshop.orders.open: cadastra quem abre OS). O caixa da oficina não chega à tela hoje (ROTA_OFICINA = oficina+gestão); com a `pode` workshop.equipment.view ele passa a ver /sistema/equipamentos (D6 do desenho) e então o botão aparece para ele — o servidor já aceita.",
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 160, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina')  // podeEditar",
  rotas_servidor: ['PATCH /core/equipment/:id (core.ts:10519)', 'PATCH /core/equipment/:id/identidade (10569)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina'), capability: 'workshop.equipment.manage',
  nota: "Editar a ficha (365). Mesma capability das rotas. Ao editar, a tela lê GET /core/team?workshopStaff=1 (212), que é users.view (L,O): o MECÂNICO pode editar mas toma 403 na lista de montadores — a tela trata (equipeIndisponivel, 158-159), então não é porta na cara, é campo desligado.",
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 162, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente')  // podeImprimirPlaquinha",
  rotas_servidor: ['POST /core/labels/equipment/sheet (core.ts:12027)'],
  perfis_hoje: uhp('gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente'), capability: 'labels.equipment.print',
  nota: "Imprimir a plaquinha (386). Mesma capability da rota. O comentário da linha 161 diz que a lista é também a de '.../replace', mas replace (12398) é só M,O e é podeTrocarPlaquinha — comentário desatualizado.",
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 169, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina')  // podeTrocarPlaquinha",
  rotas_servidor: ['POST /core/equipment-tags/:id/replace (core.ts:12398)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina'), capability: 'workshop.equipment.manage',
  nota: 'Trocar a plaquinha do equipamento (387). Mesma capability que o mapa dá à rota.',
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 171, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')  // podeSubirFoto",
  rotas_servidor: ['POST /core/equipment/:id/photos (core.ts:10628)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente'), capability: 'workshop.orders.open',
  nota: 'Subir foto do equipamento. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 172, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('mecanico', 'gerente_oficina')  // podeApagarFoto",
  rotas_servidor: ['DELETE /core/equipment/:id/photos/:photoId (core.ts:10656)'],
  perfis_hoje: uhp('mecanico', 'gerente_oficina'), capability: 'workshop.equipment.manage',
  nota: 'Apagar foto do equipamento. Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 174, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id',
  guarda_hoje: "useHasProfile('gerente_oficina')  // podeDesfazerVenda",
  rotas_servidor: ['POST /core/equipment/:id/owner/desfazer (core.ts:10723)'],
  perfis_hoje: uhp('gerente_oficina'), capability: 'workshop.admin',
  nota: 'Desfazer a venda do equipamento (troca de dono). Mesma capability da rota.',
});
site({
  arquivo: 'src/pages/gs/EquipamentoFichaPage.tsx', linha: 217, tipo: 'tela-botao', tela: '/sistema/equipamentos/:id (seletor "Montada por")',
  guarda_hoje: "equipe.filter(p => p.profileCode === 'mecanico' || p.profileCode === 'gerente_oficina')  // quem é ELEGÍVEL como montador",
  rotas_servidor: ['espelho de EquipmentService.ts:149/171 (PERFIS_QUE_MONTAM, recusa CORE_NOT_A_MECHANIC 400) chamado por PATCH /core/equipment/:id'],
  perfis_hoje: ['mecanico', 'gerente_oficina'], capability: 'workshop.orders.assume',
  nota: "Checagem manual do PERFIL DO ALVO (não de quem opera), e SEM o atalho de dono — no servidor também (EquipmentService.ts:149). Capability sugerida: o alvo tem workshop.orders.assume no vínculo daquela empresa (quem assume OS é técnico). DIFERE no dia 1: admin_geral/gestor, por terem o catálogo inteiro (full_catalog), passam a ser elegíveis como montador. Ou se aceita como mudança deliberada (listar), ou o serviço exige 'workshop.orders.assume e modelo não full_catalog'. A mesma troca tem de acontecer em EquipmentService.ts (fatia d), senão tela e servidor divergem.",
});

// ───────────────────────────── configurações, usuários ─────────────────────────────

site({
  arquivo: 'src/pages/gs/ImpressorasPage.tsx', linha: 92, tipo: 'tela-botao', tela: '/sistema/configuracoes/impressoras',
  guarda_hoje: "useHasProfile('gerente_loja', 'gerente_oficina')  // podeGerir",
  rotas_servidor: ['POST /core/print/printers/:id/test (core.ts:1724)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'settings.printers.manage',
  nota: "Só o 'Imprimir teste' do agente usa a variável (255). PORTA QUE BATE NA CARA ao lado: 'Nova impressora' (182), 'Editar' (274) e 'Tornar padrão' (269) NÃO passam por podeGerir e aparecem ao ESTOQUISTA e ao ATENDENTE (a tela é ROTA_GESTAO), mas salvar é POST /core/print/printers (core.ts:1472) = L,O → 403. Na F3 esses três botões também devem pedir settings.printers.manage.",
});
site({
  arquivo: 'src/pages/gs/PoliticaGestaoPage.tsx', linha: 33, tipo: 'tela-botao', tela: '/sistema/configuracoes/politica-de-gestao',
  guarda_hoje: 'useHasProfile()  // sem argumento = só donos',
  rotas_servidor: ['PUT /core/management-policy (core.ts:2942, requireProfile())'],
  perfis_hoje: D, capability: 'settings.management_policy.manage',
  nota: "Salvar a política (dinheiro no painel, custo do estoque). Mesma capability da rota. A leitura (GET 2932) é qualquer(dashboard.view, settings.management_policy.manage). A política é o 'OU' do can(dashboard.money.view) || política (atalho #20).",
});
site({
  arquivo: 'src/pages/gs/TerminaisPage.tsx', linha: 415, tipo: 'tela-botao', tela: '/sistema/configuracoes/terminais (bloco Acesso sem senha)',
  guarda_hoje: 'useHasProfile()  // sem argumento = só donos',
  rotas_servidor: ['GET /auth/devices (auth.ts:526, requirePermission api.device.list)', 'POST /auth/device/enroll (auth.ts:457)', 'POST /auth/device/:id/revoke (auth.ts:595)'],
  perfis_hoje: D, capability: 'devices.manage',
  nota: "Registrar/revogar computador do caixa (token de dispositivo). As rotas de escrita são devices.manage e a de lista devices.view — mesmos donos no dia 1; na F3 a lista pode ficar com devices.view e os botões com devices.manage. Com o escopo de caixa (§6), o enroll só aceita alvo que tenha o caixa no escopo; a tela deve oferecer só esses.",
});
site({
  arquivo: 'src/pages/gs/TerminaisPage.tsx', linha: 440, tipo: 'tela-botao', tela: '/sistema/configuracoes/terminais (seletor de usuário do token)',
  guarda_hoje: "equipe.filter(u => u.active && u.profileCode.startsWith('operador_caixa'))  // quem pode RECEBER token de dispositivo",
  rotas_servidor: ['POST /auth/device/enroll (auth.ts:457) — no trecho 457-500 o servidor só exige userId (460), não confere o perfil do alvo'],
  perfis_hoje: ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'], capability: 'FALTA:pdv.device_login', escopo: 'pdv',
  nota: "Checagem manual do PERFIL DO ALVO por prefixo de código, e SÓ NA TELA: a regra 'token é do PDV; token para gestão seria sessão de gestão sem senha no balcão' (438-439) não é cobrada pelo servidor (PLAUSIBLE, lido em auth.ts:457-500). Nenhuma capability do catálogo serve: pdv.cash.operate alargaria para os gerentes, que é o que a regra quer evitar, e qualquer capability inclui os donos (full_catalog). Sugestão: FALTA:pdv.device_login ('pode entrar por token de computador'), escopo pdv, semeada só nos três modelos de caixa e em somente_pdv/pdv_painel; o enroll (fatia e) confere a capability do ALVO e o escopo do caixa. Equivalência exata sem capability nova seria 'alvo tem pdv.cash.operate e não tem dashboard.view' = {C, CL, CO} no dia 1, mas é regra de negação e não serve a modelo do dono. Com prefixo de código, qualquer modelo novo de caixa (somente_pdv) fica FORA da lista.",
});
site({
  arquivo: 'src/pages/gs/EquipePage.tsx', linha: 610, tipo: 'tela-botao', tela: '/sistema/usuarios e /sistema/oficina/mecanicos (formulário da pessoa)',
  guarda_hoje: "const PERFIS_DE_OFICINA = new Set(['mecanico','gerente_oficina','operador_caixa_oficina']) (88); exigeOficina = PERFIS_DE_OFICINA.has(profileCode)",
  rotas_servidor: ['espelho de TeamService.ts:85 (WORKSHOP_PROFILES) em POST /core/team (9203), PATCH /core/team/:id (9235), POST /core/team/link (9348)'],
  perfis_hoje: ['mecanico', 'gerente_oficina', 'operador_caixa_oficina'], capability: 'users.manage', escopo: 'bancada', sem_medida: true,
  equivalencia_dia1: 'n/a (regra de formulário sobre o MODELO do alvo, não acesso de quem opera)',
  nota: "LISTA DE PERFIS no formulário: decide se o campo de oficinas é obrigatório para o modelo escolhido. Quem usa o formulário precisa de users.manage (a `pode` do botão). Na F4 a regra vira dado do modelo: bancada obrigatória quando o modelo tem capability de escopo 'bancada' e default_workshops='membro' (ou quando o vínculo escolhe all_workshops=0), recusa 400 CORE_WORKSHOP_SCOPE_REQUIRED (desenho §7.2). Diferença a decidir: hoje gerente_oficina e operador_caixa_oficina são obrigados a ter oficina mesmo vendo todas (gerente pelo isManager; caixa pelo fallback); com default_workshops='todas' deixam de ser. Lista copiada à mão do servidor: tem de morrer junto com WORKSHOP_PROFILES, senão tela e servidor divergem.",
});
site({
  arquivo: 'src/pages/gs/EquipePage.tsx', linha: 618, tipo: 'tela-botao', tela: '/sistema/usuarios (formulário Editar)',
  guarda_hoje: "perfilForaDaLista = Boolean(membro) && !perfis.includes(membro.profileCode)  // perfis = GET /core/team/profiles",
  rotas_servidor: ['GET /core/team/profiles (core.ts:9421, filtrado por assertPodeAtribuir — HierarquiaDePerfis.ts:140-148)', 'PATCH /core/team/:id (9235)'],
  perfis_hoje: uhp('gerente_loja', 'gerente_oficina'), capability: 'users.manage',
  nota: "Checagem de perfil contra a lista que o SERVIDOR devolve (não lista fixa): se o perfil atual do alvo não é atribuível por quem age (ex.: admin_geral), o select vira texto e o perfil não é enviado — impede rebaixar calado. Na F4 a lista vira 'modelos que quem age pode aplicar' (§9.1, assignable_by) e a mesma proteção fica. Os rótulos continuam fixos em PERFIL_ROTULO (57-85) e precisam vir do servidor (nome do modelo).",
});

// ─────────────────────────────────────────────────────────────────────────────

S.sort((a, b) => a.arquivo.localeCompare(b.arquivo) || a.linha - b.linha);
const destino = path.join(AQUI, 'sites-tela-botoes.json');
fs.writeFileSync(destino, JSON.stringify(S, null, 2) + '\n', 'utf8');
const dif = S.filter((s) => s.equivalencia_dia1.startsWith('DIFERE'));
console.log(`escrito ${destino}: ${S.length} pontos; DIFERE=${dif.length}`);
for (const d of dif) console.log(' ', d.arquivo, d.linha, d.capability, d.equivalencia_dia1);
