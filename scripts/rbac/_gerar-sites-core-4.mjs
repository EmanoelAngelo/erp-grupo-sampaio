// Gera sites-core-4.json (fatia core.ts 6601-8800). So escreve nesta pasta.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
const DIR = PASTA_RBAC + '/';
const F = 'server/src/routes/v1/core.ts';
const DONOS = ['admin_geral', 'gestor'];
const GER = [...DONOS, 'gerente_loja', 'gerente_oficina'];
const CX = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'];
const GER_CX = [...GER, ...CX];
const ESC = [...GER, 'estoquista', 'atendente'];
const GER_E = [...GER, 'estoquista'];
const GER_K = [...GER, 'contador'];
const BAL_ESC = [...ESC, ...CX];
const G_LO = "requireProfile(req, 'gerente_loja', 'gerente_oficina')";
const G_CX = "requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS)";
const G_E = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')";
const G_K = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'contador')";
const DON = 'requireProfile(req)';
const ESCR = "abertaAo(req, 'escritorio')";

const rows = [];
const r = (linha, linha_rota, metodo, caminho, guarda_hoje, perfis_hoje, capability, escopo, nota) =>
  rows.push({ arquivo: F, linha, linha_rota, tipo: 'rota', metodo, caminho: '/core' + caminho, guarda_hoje, perfis_hoje, capability, escopo, nota });
const s = (linha, tipo, guarda_hoje, perfis_hoje, capability, escopo, nota) =>
  rows.push({ arquivo: F, linha, tipo, guarda_hoje, perfis_hoje, capability, escopo, nota });

// ------------------------------------------------ cobranca online do titulo
const NOTA_COBRAR_SEM_TELA =
  'Unico consumidor na tela e ContasPage (src/lib/api/core.ts:4810-4862; src/pages/gs/ContasPage.tsx:300-306 desenha o botao tambem para os caixas), ' +
  'mas a pagina e ROTA_GESTAO (src/router/gsRoutes.tsx:385-386; src/router/environments.ts:171 = so "gestao") e os caixas sao "pdv" (environments.ts:69-71): ' +
  'para o caixa esta porta so existe por API direta. Com pdv.cash.operate no guarda, os modelos "Somente PDV"/"PDV + Painel" (cenarios A-D) ganham, por API, gerar/cancelar/re-tentar cobranca no provedor sobre QUALQUER titulo da empresa. ' +
  'Recomendo mudanca deliberada (listar em D*): guardar so com finance.manage, fechando uma porta sem tela para os 3 caixas. ' +
  'Nao ha caixa na operacao: requireTerminalNoEscopo nao se aplica, embora pdv.cash.operate seja de escopo pdv.';
r(6627, 6624, 'POST', '/finance/entries/:id/charge', G_CX, GER_CX, 'qualquer(finance.manage, pdv.cash.operate)', 'empresa',
  'Igual ao mapa (dia 1: finance.manage {donos,L,O} U pdv.cash.operate {donos,3 caixas,L,O} = conjunto de hoje). Justificativa do codigo: "mesmo alcance de /finance/entries/:id/settle" (core.ts:6616-6619). ' + NOTA_COBRAR_SEM_TELA +
  ' Alem disso o modal le antes GET /finance/entries/:id/charges (ContasPage.tsx:1451), que e so escritorio (core.ts:6759): mesmo que o caixa chegasse a tela, levaria 403 na leitura.');
r(6681, 6678, 'POST', '/finance/entries/:id/charges/cancel', G_CX, GER_CX, 'qualquer(finance.manage, pdv.cash.operate)', 'empresa',
  'Igual ao mapa. Consumidor: ContasPage.tsx:920 (lista de cobrancas). ' + NOTA_COBRAR_SEM_TELA);
r(6717, 6714, 'POST', '/finance/entries/:id/charges/refund', G_LO, GER, 'finance.manage', 'empresa',
  'Igual ao mapa. Devolve dinheiro ao cliente e desfaz baixa (core.ts:6703-6713); a descricao de finance.manage ja inclui "estornar cobranca". Nao passa por comLiberacaoPontual (sem alcada: quem nao tem, leva 403). Consumidor: src/lib/api/cobrancas.ts:64 (botao so para gerencia, ContasPage.tsx:314).');
r(6759, 6757, 'GET', '/finance/entries/:id/charges', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. Leitura da tela Contas (ContasPage.tsx:1451). Guarda que se contradiz com as irmas: quem CRIA a cobranca (caixas, core.ts:6627) nao LE o status dela; e quem le (estoquista, atendente) nao cria. Irrelevante hoje so porque o caixa nao chega a tela.');
r(6785, 6783, 'GET', '/payment-intents', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. Lista cobrancas de TODAS as origens (originType livre, core.ts:6791: titulo, pedido da loja online...). Consumidor: ContasPage.tsx:873.');
r(6809, 6806, 'POST', '/payment-intents/:id/retry', G_CX, GER_CX, 'qualquer(finance.manage, pdv.cash.operate)', 'empresa',
  'Igual ao mapa. Mais largo que /charge: a intencao pode ser de qualquer origem (a auditoria grava intent.origin_type, core.ts:6821), entao o caixa re-tenta por API a cobranca de um pedido da loja online. Consumidor unico: ContasPage.tsx:890. ' + NOTA_COBRAR_SEM_TELA);

// ------------------------------------------------------ financeiro (leitura)
r(6845, 6843, 'GET', '/finance/categories', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. Seletor da tela Contas (ROTA_GESTAO), sem saldo atras (comentario core.ts:6831-6842).');
r(6870, 6868, 'GET', '/finance/cost-centers', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. Seletor/filtro da tela Contas; so codigo e nome (core.ts:6856-6867).');
const NOTA_DRE =
  ' Esquisito: entrega receita, despesa e resultado ao estoquista e ao atendente (escritorio) SEM passar pela politica de gestao, enquanto o painel esconde deles o faturamento quando a politica esta desligada (veDinheiroDoPainel, core.ts:7187; PoliticaDeGestaoService.ts:158-167). ' +
  'A capability finance.view preserva isso no dia 1; se o dono quer que "dinheiro so para gerencia" valha tambem aqui, e mudanca deliberada (ex.: exigir finance.advanced.view ou dashboard.money.view || politica).';
r(6899, 6897, 'GET', '/finance/income-statement', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. DRE do periodo (core.ts:6884-6896).' + NOTA_DRE);
r(6929, 6927, 'GET', '/finance/cost-centers/report', ESCR, ESC, 'finance.view', 'empresa',
  'Igual ao mapa. Irma do DRE, por centro de custo (core.ts:6911-6926).' + NOTA_DRE);

// ------------------------------------------------------------------- painel
r(6965, 6943, 'GET', '/dashboard', ESCR, ESC, 'dashboard.view', 'empresa',
  'Igual ao mapa. As decisoes internas estao nas linhas 6997 (travessia de empresa), 7187 (dinheiro) e 7225 (custo). A coluna "extras" do inventario (_inventario-rotas.tsv: resolveWorkshopScope, resolveWorkshop, isManagerProfile) e artefato: a regiao da rota vai ate a proxima (7426) e engole as definicoes dos helpers; o handler (6943-7254) nao chama nenhum deles.');
s(6997, 'servico',
  'operacoesOndeOPerfilAbre(userId, PERFIS_DO_AMBIENTE.escritorio) — com atalho admin_geral/gestor em AlcanceCruzado.ts:27,43; recusa 403 CORE_COMPANY_PROFILE_WITHOUT_ACCESS / CORE_COMPANY_NOT_IN_MEMBERSHIP em core.ts:6999-7011',
  ESC, 'dashboard.view', 'empresa',
  'Travessia GET /core/dashboard?companyId=: a empresa pedida entra so se o perfil da pessoa LA abre o painel (perfis_hoje = perfil do vinculo na empresa pedida, ativa, AlcanceCruzado.ts:51). Vira operacoesOndeACapabilityAbre(userId, "dashboard.view") (desenho §8 #6), avaliando o acesso efetivo do vinculo LA. O atalho dos donos sai daqui junto com AlcanceCruzado.PERFIS_QUE_PASSAM_EM_TUDO. A lista "companies" da resposta (core.ts:7235) sai da mesma funcao.');
s(7187, 'servico',
  'veDinheiroDoPainel(companyId, scope(req).profiles) — QUEM_SEMPRE_VE = admin_geral, gestor, gerente_loja, gerente_oficina, senao a politica (PoliticaDeGestaoService.ts:159-167)',
  GER, 'dashboard.money.view', 'empresa',
  'perfis_hoje = os que sempre veem; estoquista e atendente veem so se core_management_policies.painelFinanceiroEquipe da empresa estiver ligado. Traducao: can(acesso, "dashboard.money.view") || politica(companyId) (desenho §8 #20). ' +
  'DEFEITO DE ALCANCE CRUZADO: companyId aqui e a empresa OLHADA (core.ts:7013, vinda de ?companyId=), mas os perfis sao os DA SESSAO (scope(req).profiles, core.ts:902-907). Quem e gerente na empresa da sessao e atendente/estoquista na empresa B atravessa para B e le faturamento, ticket, recebiveis e valores por produto/vendedor/marca de B mesmo com a politica de B desligada (e o inverso esconde o que ele veria em B). ' +
  'Na traducao, usar o acesso efetivo do vinculo NA EMPRESA OLHADA (capabilitiesDe(userId, companyId)), nunca req.auth.acesso da sessao.');
s(7225, 'servico',
  'veCustoDoEstoque(companyId, scope(req).profiles) — mesma regua QUEM_SEMPRE_VE (PoliticaDeGestaoService.ts:159-171)',
  GER, 'inventory.cost.view', 'empresa',
  'Esconde cost_cents/value_cents/valuation_cost_cents do lowStock do painel para quem nao ve custo (core.ts:7223-7227); estoquista e atendente so com custoDoEstoqueEquipe ligado. Traducao: can(acesso, "inventory.cost.view") || politica(companyId) (desenho §8 #20). ' +
  'Mesmo DEFEITO DE ALCANCE CRUZADO da linha 7187: perfis da SESSAO contra a empresa OLHADA; na traducao, acesso do vinculo na empresa olhada.');

// ------------------------------------------------------ oficina (helpers)
s(7290, 'atalho-admin',
  "resolveWorkshop: isManager = profiles.includes('admin_geral') || profiles.includes('gestor') || profiles.includes('gerente_oficina'); demais so as bancadas de core_workshop_members, SEM fallback (core.ts:7295-7310)",
  ['admin_geral', 'gestor', 'gerente_oficina'], 'workshop.admin', 'bancada',
  'Decisao de ESCOPO de bancada (quais bancadas o vinculo alcanca), nao de capability de rota; as capabilities sao as dos chamadores (core.ts:9184 GET /team, 10332 GET /equipment). workshop.admin e citada porque tem exatamente o conjunto de hoje ({admin_geral, gestor, gerente_oficina}). ' +
  'O desenho (§7.2, §8 #15) troca por bancadasDoVinculo(req) = all_workshops / default_workshops, e o passo 86 grava all_workshops=1 para esses tres; atalho admin/gestor sai daqui. ' +
  'Escolha a registrar: com bancadasDoVinculo, quem ganha all_workshops=1 por ser nao-membro (gerente_loja, estoquista, atendente, caixas) passa a pedir ?workshopId= aqui (efeito colateral D3); com can("workshop.admin") a regua de hoje fica identica. Escolher UMA e listar.');
s(7359, 'atalho-admin',
  "resolveWorkshopScope: gerente = profiles.includes('admin_geral') || profiles.includes('gestor') || profiles.includes('gerente_oficina') => todas as bancadas ativas",
  ['admin_geral', 'gestor', 'gerente_oficina'], 'workshop.admin', 'bancada',
  'Escopo de bancada das leituras de OS/kanban (chamadores em core.ts:9464, 9529, 9544, 9563, 9632, 9661, 9707, 9740, 9782, 9815-9902, 9972, 9993, 10025, 10051, 10097, 10135, 10178, 14589, 15668, 15692, 15867). ' +
  'workshop.admin = conjunto exato de hoje; o desenho troca por bancadasDoVinculo (all_workshops=1 gravado pelo passo 86 para esses perfis). O atalho admin/gestor sai daqui (desenho §8 #15).');
s(7375, 'servico',
  'resolveWorkshopScope: fallback — pedida com minhas vazio => permitidas = todas (core.ts:7375); sem pedida e minhas vazio => null = empresa inteira (core.ts:7383-7384)',
  ['gerente_loja', 'estoquista', 'atendente', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico'],
  'workshop.kanban.view', 'bancada',
  'perfis_hoje = todo nao-gerente SEM filiacao a bancada ATIVA (mecanico incluido nesse caso). Capability = a dos chamadores (kanban/OS); a decisao em si e escopo (bancadasDoVinculo, "vazio = nenhuma", desenho §7.2, mudanca D3). ' +
  'Dois furos na preservacao do passo 86 (desenho §7.2): (1) listWorkshopsOf filtra active=1 (core.ts:7273) mas a filiacao nao; quem so e membro de bancada DESATIVADA hoje cai no fallback e ve TODAS. A regra do passo 86 "sem nenhuma linha em core_workshop_members" tem de contar so bancadas ATIVAS, senao essa pessoa (nao-mecanico) vira all_workshops=0 e perde tudo. ' +
  '(2) O mecanico sem bancada ativa hoje ve TODAS pelo fallback; o passo 86 exclui mecanico da preservacao, entao no dia 1 ele passa a ver NENHUMA: fechamento provavelmente desejado, mas nao esta em §14 e precisa entrar na D3.');
s(7397, 'servico',
  'resolveBancadaDeEntrada => bancadaDeEntrada({ companyId, userId, profiles, pedida }) — WorkshopIntakeService.ts:42 GESTAO_DA_OFICINA=[admin_geral,gestor,gerente_oficina], :44 BALCAO_DA_OFICINA=[atendente,operador_caixa_oficina], :65-68 regua de empresa; demais so as bancadas de que sao membros',
  ['admin_geral', 'gestor', 'gerente_oficina', 'atendente', 'operador_caixa_oficina'], 'workshop.orders.open', 'bancada',
  'Onde a OS/equipamento ENTRA (chamadores core.ts:9592 POST /workshop/orders e 10398). perfis_hoje = os que abrem em QUALQUER bancada; o mecanico so nas suas. Carrega o atalho admin/gestor (WorkshopIntakeService.ts:42, desenho §8 #19) e vira bancadasDoVinculo. ' +
  'DIVERGENCIA NAO LISTADA: hoje atendente/operador_caixa_oficina COM linha em core_workshop_members abrem OS em qualquer bancada (regua de empresa ignora a filiacao, WorkshopIntakeService.ts:65-68) mas no kanban veem so as suas (core.ts:7364-7371). Com uma funcao so e o passo 86 gravando all_workshops=0 para "com linha e nao gerente", a entrada de OS dessas pessoas estreita. Preservar (all_workshops=1 para modelos de balcao) ou listar em §14.');
s(7408, 'servico',
  "vozNaOs: isManagerProfile(req) => 'gestor'; (req.auth?.profileCodes ?? []).includes('mecanico') => 'tecnico'; senao 'balcao'",
  ['admin_geral', 'gestor', 'gerente_oficina', 'mecanico'], 'workshop.admin', 'bancada',
  "Checagem manual de profile_code (linha 7409). perfis_hoje = gestor-voz {admin_geral, gestor, gerente_oficina} + tecnico {mecanico}; o resto fala como 'balcao'. Traducao do desenho §7.3: workshop.admin => 'gestor'; workshop.orders.assume => 'tecnico'; senao 'balcao' (equivalente no dia 1: assume = {donos, M, O} e donos/O ja caem no primeiro ramo). Chamador: core.ts:9976 (comentario da OS).");
s(7417, 'atalho-admin',
  "isManagerProfile: profiles.includes('admin_geral') || profiles.includes('gestor') || profiles.includes('gerente_oficina')",
  ['admin_geral', 'gestor', 'gerente_oficina'], 'workshop.admin', 'bancada',
  'Libera a trava de responsavel em move/plan/parts/labor/release/checkout (chamadores core.ts:9667, 9712, 9788, 9999, 10031, 15873). Vira can("workshop.admin") (desenho §8 #16), mesmo conjunto; o atalho admin/gestor sai daqui.');

// ------------------------------------------------------ oficinas (rotas)
r(7433, 7426, 'GET', '/workshops', ESCR, ESC, 'workshop.benches.view', 'empresa',
  'Igual ao mapa. Mecanico e caixas ficam fora de proposito: recebem as bancadas por GET /workshop/orders (comentario core.ts:7428-7432).');
r(7460, 7458, 'GET', '/workshops/brands', ESCR, ESC, 'workshop.benches.view', 'empresa',
  'Igual ao mapa. Em nome de quem cada bancada imprime (core.ts:7450-7457).');
r(7472, 7468, 'PUT', '/workshops/:id/brand', G_LO, GER, 'workshop.benches.manage', 'empresa',
  'Igual ao mapa. Nao passa por resolveWorkshop: o gerente_loja (nao membro) muda a marca de qualquer bancada da empresa, coerente com o escopo empresa da capability.');

// ------------------------------------------------------------------ fiscal
r(7495, 7493, 'GET', '/fiscal/config', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa.');
r(7536, 7533, 'POST', '/fiscal/sefaz/status', G_LO, GER, 'fiscal.config.manage', 'empresa',
  'DIVERGE DO MAPA (la: fiscal.view); mesmo conjunto no dia 1 ({donos, L, O}). A rota recebe a senha do A1 no corpo (core.ts:7547) e responde 400 CORE_SEFAZ_CERTIFICATE_PASSWORD_INVALID quando ela nao abre o arquivo (core.ts:7596-7601), sem limite de tentativas visivel: e um oraculo da senha do certificado. ' +
  'Guardar com a capability de LEITURA entregaria esse oraculo a qualquer modelo do dono com "Fiscal (ver)". Tambem grava auditoria fiscal.sefaz_status_checked (7682-7696). fiscal.config.manage (quem sobe/configura) e o dono natural.');
r(7734, 7732, 'PATCH', '/fiscal/config', G_LO, GER, 'fiscal.config.manage', 'empresa',
  'Igual ao mapa. environment=production continua travado por production_unlocked no servico (a chave e POST /fiscal/production-unlock, donos).');
r(7767, 7765, 'GET', '/system/secrets-readiness', DON, DONOS, 'system.secrets.view', 'grupo',
  'Igual ao mapa. Estado dos segredos da INSTALACAO (prontidaoDosSegredos() sem companyId, core.ts:7768): montada em /core mas nao e dado da empresa, por isso escopo grupo (so group.admin entrega). Comentario core.ts:7753-7764: gerente nao entra de proposito.');
r(7776, 7774, 'GET', '/fiscal/readiness', G_LO, GER, 'fiscal.view', 'empresa',
  'Igual ao mapa. Leva junto o parecer da producao (assessProductionUnlock) e o resumo da classificacao (core.ts:7790-7799).');
r(7826, 7824, 'GET', '/fiscal/classification', G_E, GER_E, 'fiscal.products.classify', 'empresa',
  'Igual ao mapa. Leitura guardada pela capability de operar (nao ha "classificar (ver)"); contador fora de proposito (core.ts:7820-7822).');
r(7878, 7876, 'POST', '/fiscal/classification/reler-notas', G_LO, GER, 'fiscal.manage', 'empresa',
  'Igual ao mapa. Escreve no cadastro de fornecedor e na procedencia do produto e percorre todas as notas da empresa (core.ts:7873-7874); purchases.manage teria o mesmo conjunto, mas a descricao de fiscal.manage ja nomeia "reler notas para classificacao".');
r(7888, 7886, 'POST', '/fiscal/classification/confirm', G_E, GER_E, 'fiscal.products.classify', 'empresa', 'Igual ao mapa.');
r(7939, 7937, 'POST', '/fiscal/production-unlock', DON, DONOS, 'fiscal.policy.manage', 'empresa',
  'Igual ao mapa. Libera emissao com valor juridico (core.ts:7928-7931). Hoje so donos; como fiscal.policy.manage e de escopo empresa, com a personalizacao quem a tem pode entrega-la a um gerente daquela empresa — decidir se ela deveria ser de escopo grupo (so group.admin entrega), como system.*.');
r(7975, 7972, 'POST', '/fiscal/sales/:saleId/emit', G_CX, GER_CX, 'fiscal.sale.emit', 'empresa',
  'Igual ao mapa. Nao confere o caixa da venda contra o escopo de PDV do vinculo: com escopo por caixa (desenho §6), o operador restrito ao Caixa 1 emite a nota de uma venda do Caixa 2 (idempotente, sem segundo numero). Se o escopo de PDV deve valer para o ato fiscal, conferir o terminal da venda com requireTerminalNoEscopo; senao, registrar que fiscal.sale.emit e de empresa de proposito.');
r(8005, 8003, 'GET', '/fiscal/sales/:saleId/emission-readiness', "requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS)", GER_CX, 'fiscal.sale.emit', 'empresa', 'Igual ao mapa. Painel do PDV pergunta antes de mostrar o botao (core.ts:8000-8002).');
r(8019, 8013, 'GET', '/fiscal/sales/:saleId/status', "abertaAo(req, 'balcao', 'escritorio')", BAL_ESC, 'qualquer(fiscal.sale.emit, sales.view)', 'empresa',
  'Igual ao mapa. Mais largo que as irmas (estoquista e atendente entram pelo escritorio, via sales.view), coerente com a tela de vendas.');
const NOTA_DOC_CAIXA =
  ' A lista/documento traz valor, venda e destinatario (core.ts:8041-8042): o caixa le TODAS as notas da empresa, nao so as da sua venda/caixa. Hoje e assim; com D6 a pagina Documentos fiscais passa a aparecer para os caixas. Candidato a R1 (decisao do dono).';
r(8029, 8027, 'GET', '/fiscal/documents', G_CX, GER_CX, 'qualquer(fiscal.sale.emit, fiscal.view)', 'empresa', 'Igual ao mapa.' + NOTA_DOC_CAIXA);
r(8039, 8037, 'GET', '/fiscal/documents/:id', G_CX, GER_CX, 'qualquer(fiscal.sale.emit, fiscal.view)', 'empresa', 'Igual ao mapa.' + NOTA_DOC_CAIXA);
r(8059, 8057, 'GET', '/fiscal/documents/:id/danfce', G_CX, GER_CX, 'qualquer(fiscal.sale.emit, fiscal.view)', 'empresa',
  'Igual ao mapa. ?preview=1 renderiza nota nao autorizada, com tarja (core.ts:8061-8063), tambem para o caixa.');
r(8080, 8077, 'GET', '/fiscal/pdv-summary', G_CX, GER_CX, 'qualquer(fiscal.sale.emit, fiscal.view)', 'empresa',
  'Igual ao mapa. Resumo do balcao (pode emitir, pendencias, contingencia), core.ts:8070-8107.');
r(8165, 8163, 'GET', '/fiscal/acts/plan', G_LO, GER, 'fiscal.view', 'empresa',
  'Igual ao mapa. A tela pergunta antes do botao de cancelar/CC-e/inutilizar (core.ts:8156-8162): um modelo do dono com fiscal.documents.cancel sem fiscal.view nao planeja o ato. Considerar qualquer(fiscal.view, fiscal.documents.cancel) — igual no dia 1.');
r(8190, 8188, 'GET', '/fiscal/emission-policy', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa. Ler: gerencia; gravar: donos (core.ts:8181-8187).');
r(8200, 8198, 'PUT', '/fiscal/emission-policy', DON, DONOS, 'fiscal.policy.manage', 'empresa', 'Igual ao mapa. Ligar NFC-e automatica produz documento sem clique (core.ts:8184-8186).');
r(8210, 8208, 'PUT', '/fiscal/acts/policy', DON, DONOS, 'fiscal.policy.manage', 'empresa', 'Igual ao mapa. Cofre ou senha digitada nos atos com a SEFAZ (core.ts:8174-8180).');
r(8233, 8231, 'POST', '/fiscal/documents/:id/reenfileirar', G_LO, GER, 'fiscal.manage', 'empresa', 'Igual ao mapa. Volta da contingencia (core.ts:8224-8230).');
r(8254, 8252, 'GET', '/fiscal/queue', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa.');
r(8265, 8262, 'POST', '/fiscal/queue/drain', G_LO, GER, 'fiscal.manage', 'empresa', 'Igual ao mapa.');
r(8278, 8275, 'POST', '/fiscal/documents/:id/transmitir', G_LO, GER, 'fiscal.manage', 'empresa', 'Igual ao mapa.');
r(8295, 8293, 'GET', '/fiscal/contingency', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa. O caixa sabe da contingencia por /fiscal/pdv-summary (core.ts:8106), nao por aqui.');
r(8305, 8303, 'PUT', '/fiscal/contingency/policy', DON, DONOS, 'fiscal.policy.manage', 'empresa', 'Igual ao mapa. Modalidade e prazo sao decisao do contador gravada pelos donos (core.ts:8287-8292).');
r(8322, 8320, 'POST', '/fiscal/contingency/enter', G_LO, GER, 'fiscal.manage', 'empresa', 'Igual ao mapa.');
r(8339, 8337, 'POST', '/fiscal/contingency/exit', G_LO, GER, 'fiscal.manage', 'empresa', 'Igual ao mapa.');
r(8352, 8348, 'POST', '/fiscal/documents/:id/cancel', G_LO, GER, 'fiscal.documents.cancel', 'empresa', 'Igual ao mapa. companyId sempre do token (core.ts:8115-8117).');
r(8371, 8368, 'POST', '/fiscal/documents/:id/correction-letter', G_LO, GER, 'fiscal.documents.cancel', 'empresa', 'Igual ao mapa.');
r(8390, 8388, 'GET', '/fiscal/correction-letter/notice', G_LO, GER, 'fiscal.view', 'empresa',
  'Igual ao mapa. Devolve so o texto fixo CCE_LIMITATION_NOTICE (core.ts:8391), sem dado da empresa; poderia ser SO_AUTENTICADO, mas fiscal.view preserva o dia 1 e o lint.');
r(8399, 8397, 'GET', '/fiscal/void-ranges', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa.');
r(8411, 8407, 'POST', '/fiscal/void-ranges', G_LO, GER, 'fiscal.documents.cancel', 'empresa', 'Igual ao mapa. Inutilizar queima numeracao para sempre (core.ts:8410).');
r(8451, 8449, 'GET', '/fiscal/documents/:id/xml', G_LO, GER, 'fiscal.view', 'empresa',
  'Igual ao mapa. A segunda leitura por id sem company_id (core.ts:8457-8458) esta protegida pelo getDocument(companyId, id) anterior (8453). Assimetria de hoje: o XML fica fora do caixa, mas DANFE/DANFCE (8059, 8474) nao.');
r(8474, 8472, 'GET', '/fiscal/documents/:id/danfe', G_CX, GER_CX, 'qualquer(fiscal.sale.emit, fiscal.view)', 'empresa',
  'Igual ao mapa. ?preview=1 renderiza nao autorizada (core.ts:8478).' + NOTA_DOC_CAIXA);
r(8488, 8486, 'GET', '/fiscal/reconciliation', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa.');

// ------------------------------------------------------- fechamento do contador
r(8521, 8519, 'GET', '/fiscal/closings/:period/previa', G_K, GER_K, 'accounting.closing.view', 'empresa',
  'Igual ao mapa. Estoquista e atendente fora de proposito; contador entra pela porta dele (comentario core.ts:8496-8516).');
r(8558, 8556, 'GET', '/fiscal/closings/:period/pacote', G_K, GER_K, 'accounting.closing.view', 'empresa',
  'Igual ao mapa. Leva todos os documentos fiscais do mes, o resultado e os XML de compra para fora da empresa; auditoria fiscal.closing.package com sha256 (core.ts:8563-8578).');
r(8602, 8600, 'GET', '/fiscal/closings/conferir', G_K, GER_K, 'accounting.closing.view', 'empresa', 'Igual ao mapa. So a empresa do token (core.ts:8595-8596).');
const NOTA_ENVIO = ' Sem o contador de proposito (quem RECEBE nao decide para onde a contabilidade vai; a varredura do contador cobra o 403, core.ts:8610-8620).';
r(8624, 8622, 'GET', '/fiscal/contador/destinatarios', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa. Leitura guardada pela capability de gerir da mesma pagina.' + NOTA_ENVIO);
r(8634, 8632, 'POST', '/fiscal/contador/destinatarios', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa.' + NOTA_ENVIO);
r(8650, 8648, 'PATCH', '/fiscal/contador/destinatarios/:id', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa.' + NOTA_ENVIO);
r(8668, 8666, 'GET', '/fiscal/contador/agenda', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa.' + NOTA_ENVIO);
r(8680, 8678, 'PUT', '/fiscal/contador/agenda', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa.' + NOTA_ENVIO);
r(8704, 8702, 'POST', '/fiscal/closings/:period/enviar', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa. Enfileira, nunca envia direto; Idempotency-Key obrigatoria (core.ts:8694-8701).' + NOTA_ENVIO);
r(8724, 8722, 'GET', '/fiscal/closings/:period/envios', G_LO, GER, 'accounting.closing.send', 'empresa', 'Igual ao mapa.' + NOTA_ENVIO);

// ------------------------------------------------ pendencias fiscais e series
r(8734, 8732, 'GET', '/fiscal/product-pendencies', G_E, GER_E, 'fiscal.products.classify', 'empresa', 'Igual ao mapa.');
r(8744, 8742, 'PATCH', '/fiscal/product-pendencies/:id', G_E, GER_E, 'fiscal.products.classify', 'empresa',
  'Igual ao mapa. O estoquista grava NCM, CEST, CFOP, origem e perfil tributario do produto (core.ts:8746-8754), o que muda o imposto das notas seguintes; e o conjunto de hoje.');
r(8787, 8785, 'GET', '/fiscal/series', G_LO, GER, 'fiscal.view', 'empresa', 'Igual ao mapa.');
r(8802, 8800, 'POST', '/fiscal/series', G_LO, GER, 'fiscal.config.manage', 'empresa', 'Igual ao mapa. Proximo numero da serie; numeroOuNaN evita serie 0 silenciosa (core.ts:8769-8783).');

// ------------------------------------------------ conferencia contra o catalogo
const cat = JSON.parse(fs.readFileSync(DIR + 'catalogo.json', 'utf8'));
const byCode = new Map(cat.map((c) => [c.code, c]));
const probs = [];
for (const row of rows) {
  const codes = row.capability.replace(/^qualquer\(|\)$/g, '').split(',').map((x) => x.trim());
  for (const c of codes) if (!byCode.has(c)) probs.push(`${row.linha}: capability fora do catalogo ${c}`);
  if (row.tipo === 'rota') {
    const alc = new Set(codes.flatMap((c) => byCode.get(c)?.perfis_de_hoje ?? []));
    const hoje = new Set(row.perfis_hoje);
    const igual = alc.size === hoje.size && [...hoje].every((p) => alc.has(p));
    row.equivalencia_dia1 = igual ? 'igual' : `DESVIO novo=${[...alc].sort()} hoje=${[...hoje].sort()}`;
    if (!igual) probs.push(`${row.linha} ${row.caminho}: ${row.equivalencia_dia1}`);
  }
}
fs.writeFileSync(DIR + 'sites-core-4.json', JSON.stringify(rows, null, 2) + '\n');
console.log('linhas', rows.length, 'rotas', rows.filter((x) => x.tipo === 'rota').length);
console.log(probs.length ? probs.join('\n') : 'sem problemas');
