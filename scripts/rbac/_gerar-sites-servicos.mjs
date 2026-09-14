// Gera sites-servicos.json: decisões de autorização FORA dos roteadores (server/src/services).
// Só lê a árvore devora-int-b. Cada linha traz `confere` (trecho que TEM de estar na linha citada);
// o script recusa gerar se algum não bater, e tira o campo da saída.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = REPO_DA_ARVORE;
const SAIDA = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'sites-servicos.json');

const AB = {
  D: ['admin_geral', 'gestor'],
  L: ['gerente_loja'], O: ['gerente_oficina'], E: ['estoquista'], T: ['atendente'],
  C: ['operador_caixa'], CL: ['operador_caixa_loja'], CO: ['operador_caixa_oficina'],
  M: ['mecanico'], K: ['contador'],
  AG: ['admin_geral'], GE: ['gestor'],
};
const P = (...s) => [...new Set(s.flatMap((x) => AB[x]))];
const TODOS = P('D', 'L', 'O', 'E', 'T', 'C', 'CL', 'CO', 'M', 'K');
const APROVACAO = 'qualquer(approval.discount, approval.cash_withdrawal, approval.cash_reopen, approval.sale_cancel, approval.sale_return)';

const S = 'server/src/services/';
const f = {
  perm: S + 'auth/Permissions.ts',
  alc: S + 'auth/AlcanceCruzado.ts',
  ident: S + 'auth/IdentityService.ts',
  conta: S + 'auth/ContaDaSessao.ts',
  recup: S + 'auth/RecuperacaoDeSenhaDaEquipe.ts',
  apiauth: S + 'api/ApiAuthService.ts',
  bi: S + 'core/GroupInsights.ts',
  hier: S + 'core/HierarquiaDePerfis.ts',
  team: S + 'core/TeamService.ts',
  authz: S + 'core/AuthorizationService.ts',
  cash: S + 'core/CashService.ts',
  sales: S + 'core/SalesService.ts',
  quote: S + 'core/QuoteService.ts',
  cobr: S + 'core/CobrancasSemVenda.ts',
  parts: S + 'core/WorkshopPartsService.ts',
  intake: S + 'core/WorkshopIntakeService.ts',
  pol: S + 'core/PoliticaDeGestaoService.ts',
  tit: S + 'lgpd/TitularService.ts',
  equip: S + 'core/EquipmentService.ts',
  pront: S + 'notifications/ProntidaoDasComunicacoes.ts',
  impl: S + 'implantacao/implantacaoPorEmpresa.ts',
  term: S + 'core/TerminalRegistry.ts',
  gav: S + 'core/GavetaDoDinheiro.ts',
  wcore: S + 'core/WorkshopCoreService.ts',
  wreg: S + 'core/WorkshopOrderRegularization.ts',
  inv: S + 'core/InventoryService.ts',
};

const L = [];
const add = (arquivo, linha, tipo, guarda_hoje, perfis_hoje, capability, escopo, nota, confere, extra = {}) =>
  L.push({ arquivo, linha, tipo, metodo: extra.metodo ?? null, caminho: extra.caminho ?? null, tela: null,
    guarda_hoje, perfis_hoje, capability, escopo, nota, confere });

// ============================================================ Permissions.ts
add(f.perm, 51, 'atalho-admin', "const RESPONDEM_POR_TUDO = ['admin_geral', 'gestor']", P('D'), 'group.admin', 'grupo',
  'Atalho #5 do desenho §8 (definição). NÃO vira guarda: admin_geral/gestor passam por serem o modelo full_catalog=1, não por group.admin. O comentário da linha 50 diz "É a MESMA regra do requireProfile" — é a 4ª cópia da lista (core.ts:941, nfse.ts:40, payment-terminals.ts:76). Sai quando temPermissao morre (F5); até lá requirePermission vira o tradutor estático PERMISSAO_PARA_CAPABILITY (desenho §4.2).',
  "RESPONDEM_POR_TUDO = ['admin_geral', 'gestor']");
add(f.perm, 154, 'atalho-admin', 'if (perfis.some((p) => RESPONDEM_POR_TUDO.includes(p))) return true;', P('D'), 'group.admin', 'grupo',
  'Uso do atalho em temPermissao, chamado por requirePermission (middleware/auth.ts:158). Roda ANTES do "módulo não declarado nega" (linha 158): é por isso que api e system-* com listas vazias abrem só aos donos. No catálogo esses módulos viram devices.view/manage e system.* — capabilities que no dia 1 só os modelos admin_geral/gestor têm (mapa: system-admin.ts:30..215 e auth.ts:457/526/595 = DONOS, "igual"). Nenhum substituto em execução: o atalho só sai.',
  'RESPONDEM_POR_TUDO.includes(p)');
add(f.perm, 158, 'servico', 'if (!regra) return false; // módulo não declarado nega (depois do atalho da 154)', P('D'), 'group.admin', 'grupo',
  'Falha fechada por módulo não declarado; na prática "só donos", porque o atalho da 154 roda antes. No catálogo não existe "módulo não declarado": requireCapability só aceita literal presente em catalogo.json (regra capabilityDesconhecida do lint, desenho §4.3), e o tipo Capability não compila. Não precisa de substituto em execução. A capability aqui só registra o alcance de hoje (só donos).',
  'if (!regra) return false;');
add(f.perm, 70, 'servico', "fiscal: { ler: ['estoquista', 'atendente', 'gerente_oficina'], escrever: ['gerente_loja'] }", P('D', 'E', 'T', 'O', 'L'), 'fiscal.view', 'empresa',
  'MÓDULO MORTO: nenhuma rota chama requirePermission(\'fiscal.*\') (RBAC-SERVIDOR.md, busca sem resultado). O fiscal de verdade é guardado por requireProfile em core.ts e nfse.ts. NÃO semear nada a partir desta linha: os perfis dela (leitura para estoquista/atendente, escrita só para gerente_loja) contradizem o fiscal real e perfis_de_hoje de fiscal.view (D, gerente_loja, gerente_oficina). Apagar junto com a matriz na F1/F5.',
  "fiscal: { ler:");
add(f.perm, 75, 'servico', "'payment-terminal': { ler: ['atendente'], ... } (leitura = ler ∪ escrever)", P('D', 'T', 'L', 'C', 'CL', 'CO'), 'integrations.card_terminal.view', 'empresa',
  'Módulo vivo: payment-terminals.ts, 31 rotas requirePermission(\'payment-terminal.*\'). Ações de leitura (view/list/status/…, linhas 40-48) valem para ler ∪ escrever = D, atendente, gerente_loja e os 3 caixas; gerente_oficina fica de fora, como em perfis_de_hoje de integrations.card_terminal.view. Mapa: todas as rotas de leitura, "igual".',
  "ler: ['atendente'],");
add(f.perm, 76, 'servico', "'payment-terminal': { escrever: ['gerente_loja', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'] }", P('D', 'L', 'C', 'CL', 'CO'), 'integrations.card_terminal.operate', 'empresa',
  'Escrita do módulo = integrations.card_terminal.operate (D, gerente_loja, 3 caixas). Nas 11 rotas em que o handler confere de novo GERENCIA_DA_MAQUININHA (payment-terminals.ts:229,246,260,273,287,314,344,362,408,517,569), a interseção dá só D+gerente_loja = integrations.card_terminal.manage. Essa interseção tem de estar embutida em PERMISSAO_PARA_CAPABILITY (desenho §4.2); traduzir só pela matriz alargaria essas 11 rotas aos caixas.',
  "escrever: ['gerente_loja', 'operador_caixa'");
add(f.perm, 79, 'servico', "crm: { ler: ['estoquista'], escrever: ['gerente_loja', 'atendente'] }", P('D', 'E', 'L', 'T'), 'crm.view', 'empresa',
  'MÓDULO MORTO: nenhuma rota chama requirePermission(\'crm.*\'). O CRM real mora em core.ts:15362-15545 com requireProfile. Os perfis desta linha (estoquista lê; gerente_oficina e caixa_loja ausentes) NÃO batem com perfis_de_hoje de crm.view (D, CL, L, O, T). Não usar como fonte da semeadura.',
  'crm: { ler:');
add(f.perm, 82, 'servico', "'corporate-bi': { ler: ['gerente_loja', 'gerente_oficina'], escrever: [] }", P('D', 'L', 'O'), 'reports.bi.view', 'empresa',
  'MÓDULO MORTO (sem chamador vivo). O BI real são as rotas /core/insights/* com PERFIS_QUE_LEEM_O_BI (GroupInsights.ts:39), mesmo conjunto (D, L, O) = reports.bi.view. Apagar com a matriz.',
  "'corporate-bi':");
add(f.perm, 99, 'servico', "logistics: { ler: ['atendente'], escrever: ['gerente_loja', 'estoquista'] }", P('D', 'T', 'L', 'E'), 'logistics.view', 'empresa',
  'Módulo vivo: logistics.ts, 23 rotas. Leitura = logistics.view (D, E, L, T); escrita = logistics.manage (D, E, L). Mapa: todas "igual". gerente_oficina fica de fora, como hoje.',
  'logistics: { ler:');
add(f.perm, 111, 'servico', "asaas: { ler: ['atendente'], escrever: ['gerente_loja'] }", P('D', 'T', 'L'), 'integrations.asaas.view', 'empresa',
  'Módulo vivo: index.ts, 10 rotas /asaas/*. Leitura = integrations.asaas.view (D, L, T); escrita = integrations.asaas.manage (D, L). Mapa: "igual".',
  'asaas: { ler:');
add(f.perm, 117, 'servico', "api: { ler: [], escrever: [] }", P('D'), 'devices.manage', 'empresa',
  'Lista vazia = só donos, pelo atalho da 154. Chamadores vivos em auth.ts: api.device.enroll (457), api.device.list (526), api.device.revoke (595) → devices.manage / devices.view / devices.manage. O escopo do enroll ganha a regra do desenho §6.2: o terminal tem de estar no escopo do usuário dono do token.',
  'api: { ler: [], escrever: [] }');
add(f.perm, 118, 'servico', "'system-release': { ler: [], escrever: [] }", P('D'), 'system.status.view', 'grupo',
  'Só donos. Dois chamadores em system-admin.ts (system-release.view e system-release.manage). GET /release (182) → system.status.view (mapa). Conferir no mapa qual capability recebe o chamador .manage.',
  "'system-release'");
add(f.perm, 119, 'servico', "'system-recovery': { ler: [], escrever: [] }", P('D'), 'system.status.view', 'grupo',
  'MÓDULO SEM CHAMADOR: grep de requirePermission(\'system-recovery.*\') em routes/ = 0. Declarado sem porta; apagar com a matriz. A capability só registra o alcance que teria.',
  "'system-recovery'");
add(f.perm, 120, 'servico', "'system-reconciliation': { ler: [], escrever: [] }", P('D'), 'system.status.view', 'grupo',
  'MÓDULO SEM CHAMADOR (grep em routes/ = 0). Apagar com a matriz.',
  "'system-reconciliation'");
add(f.perm, 121, 'servico', "'system-readiness': { ler: [], escrever: [] }", P('D'), 'system.deploy.view', 'grupo',
  'Só donos. 4 chamadores .view e 2 .manage em system-admin.ts: GET /readiness (30) → system.status.view; /implantacao* (50, 79, 90) → system.deploy.view; PUT/DELETE marca (98, 125) → system.deploy.manage. As rotas /implantacao/empresas* também cobram vínculo de gestão na empresa pedida (temVinculoDeGestao, IdentityService.ts:376).',
  "'system-readiness'");
add(f.perm, 122, 'servico', "'system-homologation': { ler: [], escrever: [] }", P('D'), 'system.status.view', 'grupo',
  'MÓDULO SEM CHAMADOR (grep em routes/ = 0). Apagar com a matriz.',
  "'system-homologation'");
add(f.perm, 123, 'servico', "'system-health': { ler: [], escrever: [] }", P('D'), 'system.status.view', 'grupo',
  'MÓDULO SEM CHAMADOR (grep em routes/ = 0). Apagar com a matriz.',
  "'system-health'");
add(f.perm, 124, 'servico', "'system-backup': { ler: [], escrever: [] }", P('D'), 'system.backup.view', 'grupo',
  'Só donos. GET /backup/status (system-admin.ts:206) → system.backup.view; POST /backup/conferir-bucket (215) → system.backup.manage.',
  "'system-backup'");

// ============================================================ AlcanceCruzado.ts
add(f.alc, 27, 'atalho-admin', "export const PERFIS_QUE_PASSAM_EM_TUDO = ['admin_geral', 'gestor']", P('D'), 'group.admin', 'grupo',
  'Atalho #6 do desenho §8 (definição). Os chamadores recebem o atalho de graça: travessia do painel (core.ts:6997), do BI (GroupInsights.ts:192), de /companies (core.ts:8903) e dos certificados do grupo (core.ts:4461). Sai com operacoesOndeACapabilityAbre(userId, expr): a expressão passa pelo acesso da pessoa NA empresa de lá, e o modelo full_catalog responde por si.',
  "PERFIS_QUE_PASSAM_EM_TUDO = ['admin_geral', 'gestor']");
add(f.alc, 38, 'servico', 'operacoesOndeOPerfilAbre(userId, perfisDaRota): empresas ATIVAS com vínculo cujo profile_code ∈ perfisDaRota ∪ donos', TODOS, 'SO_AUTENTICADO', 'empresa',
  'PARAMÉTRICO. A capability é a do chamador; a função, sozinha, só recorta EMPRESAS (vínculo + c.active=1 + perfil lá). Chamadores: core.ts:4461 (lista vazia = só donos → fiscal.certificate.manage), core.ts:6997 (PERFIS_DO_AMBIENTE.escritorio → dashboard.view), core.ts:8903 (lista vazia → group.companies.manage), GroupInsights.ts:192 (→ reports.bi.view). Vira operacoesOndeACapabilityAbre(userId, expr), que precisa resolver o acesso da pessoa em OUTRA empresa (a AcessoEfetivo do desenho §5 tem de aceitar (userId, companyId), não só req). perfis_hoje = qualquer perfil, porque o recorte depende da lista passada.',
  'export function operacoesOndeOPerfilAbre(');
add(f.alc, 43, 'atalho-admin', 'const perfis = [...new Set([...PERFIS_QUE_PASSAM_EM_TUDO, ...perfisDaRota])];', P('D'), 'group.admin', 'grupo',
  'Uso do atalho: toda travessia aceita admin_geral/gestor LÁ, qualquer que seja a lista da rota. Com lista vazia, "só donos". Sai sem substituto: o modelo full_catalog satisfaz qualquer expressão.',
  '[...PERFIS_QUE_PASSAM_EM_TUDO, ...perfisDaRota]');

// ============================================================ GroupInsights.ts
add(f.bi, 39, 'servico', "export const PERFIS_QUE_LEEM_O_BI = ['gerente_loja', 'gerente_oficina'] as const", P('D', 'L', 'O'), 'reports.bi.view', 'empresa',
  'É a ÚNICA lista de guarda de rota que mora num serviço: as 4 rotas /core/insights/* a passam ao requireProfile (core.ts:16425-16489) e companiesOf (192) a usa para a travessia. Tradução: requireCapability(req, \'reports.bi.view\') nas rotas e operacoesOndeACapabilityAbre(userId, \'reports.bi.view\') aqui, a mesma capability nos dois lados, como hoje é a mesma lista. Dia 1: igual (D, L, O).',
  "PERFIS_QUE_LEEM_O_BI = ['gerente_loja', 'gerente_oficina']");
add(f.bi, 192, 'servico', 'return operacoesOndeOPerfilAbre(userId, PERFIS_QUE_LEEM_O_BI);', P('D', 'L', 'O'), 'reports.bi.view', 'empresa',
  'Travessia do BI (GAP-PRD-084): a empresa B entra na comparação só se o vínculo da pessoa EM B abre o BI. Vira "empresas ativas onde o acesso da pessoa lá tem reports.bi.view". Quem é gerente em A e mecânico em B continua vendo só A.',
  'operacoesOndeOPerfilAbre(userId, PERFIS_QUE_LEEM_O_BI)');

// ============================================================ IdentityService.ts
add(f.ident, 78, 'servico', 'assertMembership(userId, companyId) = listMemberships(userId).find(...) — só empresas ativas (linha 71)', TODOS, 'SO_AUTENTICADO', 'empresa',
  'ESCOPO DE EMPRESA (vínculo em empresa ativa), não capability. Chamadores: auth.ts:401 (login de dispositivo), auth.ts:464 (enroll), auth.ts:907 (switch-company), AuthorizationService.ts:298 (vínculo do liberador). Fica igual (desenho §5.4). Contraste: listMemberships filtra c.active=1, mas ContaDaSessao.ts:69-73 e o refresh (ApiAuthService.ts:226-230) não. É a mudança D2.',
  'export function assertMembership(');
add(f.ident, 352, 'servico', 'listCompaniesForUser(userId): empresas ativas com vínculo, qualquer perfil', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Recorte de empresa por VÍNCULO, sem perfil. Chamadores com capability própria: core.ts:4462 (certificados), 7000 (painel ?companyId=), 8904 (/companies), 8942 (equipment-tags), 16596 (prontidão do dia 1), system-admin.ts:81 (implantação). Fica como está: o escopo continua sendo o vínculo, e a capability é conferida por quem chama.',
  'export function listCompaniesForUser(');
add(f.ident, 366, 'atalho-admin', "const PERFIS_DE_GESTAO = new Set(['admin_geral', 'gestor'])", P('D'), 'system.deploy.view', 'grupo',
  'Atalho #7 do desenho §8. O comentário diz "a mesma dupla de RESPONDEM_POR_TUDO": é outra cópia da lista. O único consumidor é temVinculoDeGestao (376), usado só em system-admin.ts:73 e :83 (implantação por empresa). Substituto: "tem system.deploy.view NAQUELA empresa".',
  "PERFIS_DE_GESTAO = new Set(['admin_geral', 'gestor'])");
add(f.ident, 378, 'servico', 'return membership != null && PERFIS_DE_GESTAO.has(membership.profile_code);', P('D'), 'system.deploy.view', 'grupo',
  'temVinculoDeGestao: vínculo de dono NA empresa pedida. Chamado em system-admin.ts:73 (empresaDeGestao → GET/PUT/DELETE /system/implantacao/empresas/:companyId*, 403 API_TENANT_MISMATCH) e em :83 (filtra a lista de GET /implantacao/empresas). ESQUISITO: system.deploy.view tem escopo "grupo" no catálogo, mas aqui a pergunta é por empresa (o adm de uma loja lê só a sua). A capability tem de ser avaliada no vínculo de CADA empresa, não uma vez por grupo; senão alarga.',
  'PERFIS_DE_GESTAO.has(membership.profile_code)');
add(f.ident, 399, 'atalho-admin', "respondePeloGrupo: COUNT(DISTINCT empresa) com uc.profile_code IN ('admin_geral','gestor') = nº de empresas ativas", P('D'), 'group.admin', 'grupo',
  'Atalho #8 do desenho §8 → "tem group.admin em TODAS as empresas ativas". Chamadores: core.ts:8934 (PATCH /companies/:id/equipment-tags), 8983 (POST /companies), 13734 (escopoDoSync: o nó inteiro ou só a empresa), 16595 (GET /loja/prontidao-do-dia-1: todas ou só a sua). ESQUISITO: aceita MISTURA (admin_geral em 3 empresas e gestor nas outras 3 responde pelo grupo), enquanto listGroupAdminIds/ManagerIds (508/520) exigem o MESMO código em todas. Com group.admin a mistura deixa de importar, que é o certo.',
  "uc.profile_code IN ('admin_geral', 'gestor')");
add(f.ident, 509, 'servico', "listGroupAdminIds() = idsComPerfilEmTodasAtivas('admin_geral') — conta ativa com admin_geral em TODAS as ativas (SQL 524-535)", P('AG'), 'group.admin', 'grupo',
  'Define "administrador do grupo" pelo código do perfil (desenho #9). Consumidor: createCompanyWithFounders (634), que vincula esses ids à empresa nova. Vira listGroupAdmins(): contas ativas com group.admin em todas as ativas, cada uma com o modelo que usa. A ordem "derivar ANTES do INSERT" (498-506) continua obrigatória.',
  "return idsComPerfilEmTodasAtivas('admin_geral')");
add(f.ident, 521, 'servico', "listGroupManagerIds() = idsComPerfilEmTodasAtivas('gestor')", P('GE'), 'group.admin', 'grupo',
  'Mesma régua para "gestor do grupo" (CARLOSGERENTE). Com capability, admin e gestor do grupo viram UMA lista (group.admin em todas), e cada um é vinculado com o modelo que já tem nas outras (desenho #10).',
  "return idsComPerfilEmTodasAtivas('gestor')");
add(f.ident, 669, 'servico', "const perfilDoCriador = gestoresDoGrupo.includes(input.criadorUserId) ? 'gestor' : 'admin_geral';", P('D'), 'group.admin', 'grupo',
  'Escolhe o MODELO do vínculo de quem cria a empresa. ESQUISITO (PLAUSIBLE, lido e não executado): POST /companies deixa passar o criador por respondePeloGrupo (core.ts:8983), que aceita mistura admin_geral/gestor; esse criador misto não está em listGroupManagerIds e cai no ramo admin_geral. Nasce então com um terceiro padrão de vínculos, e na próxima criação não entra em nenhuma das duas listas — o defeito que o comentário 658-663 diz ter fechado continua possível por essa porta. Com capability: "o mesmo modelo que o criador tem nas outras", e mistura só se o dono quiser.',
  'const perfilDoCriador = gestoresDoGrupo.includes(input.criadorUserId)');
add(f.ident, 677, 'servico', "vinculo.run(randomUUID(), adminId, companyId, 'admin_geral', agora) — cada admin do grupo entra na empresa nova", P('AG'), 'group.admin', 'grupo',
  'Entrada automática do administrador do grupo na empresa nova. Desenho #10: quem tem group.admin em todas entra com o modelo que usa nas outras. Dia 1: ADMIN → admin_geral, igual.',
  "vinculo.run(randomUUID(), adminId, companyId, 'admin_geral', agora)");
add(f.ident, 686, 'servico', "vinculo.run(randomUUID(), gestorId, companyId, 'gestor', agora) — cada gestor do grupo entra na empresa nova", P('GE'), 'group.admin', 'grupo',
  'Mesmo mecanismo para os gestores do grupo. Dia 1: CARLOSGERENTE → gestor, igual.',
  "vinculo.run(randomUUID(), gestorId, companyId, 'gestor', agora)");
add(f.ident, 724, 'servico', 'inserirMembroDaEquipe({ ..., perfisDeQuemCria: [...input.perfisDoCriador] }) — o primeiro gerente passa pela régua da hierarquia', P('D'), 'users.manage', 'empresa',
  'O primeiro gerente da empresa nova é validado por assertProfile/assertPodeAtribuir com os perfis do TOKEN do criador (560-564). Com capability: aplicar o modelo pedido exige users.manage + o assignable_by do modelo (desenho §9.1). Como só quem tem group.admin chega aqui, qualquer modelo não full_catalog passa, igual a hoje. Detalhe: a sessão do criador é de OUTRA empresa, e a régua mede o acesso dele lá.',
  'perfisDeQuemCria: [...input.perfisDoCriador]');

// ============================================================ ContaDaSessao.ts / ApiAuthService.ts
add(f.conta, 113, 'servico', 'conferirContaDaSessao: conta ativa (107), session_version (110) e vínculo com profile_code na empresa do token (113) → 401 API_SESSION_ENDED', TODOS, 'SO_AUTENTICADO', 'empresa',
  'A conferência por requisição. É onde o desenho §5.1 passa a carregar as capabilities do vínculo (modelo, deltas, caixas, bancadas), na mesma consulta por chave. Hoje: não olha core_companies.active (consulta 69-73), e a sessão aberta numa empresa desativada segue valendo (mudança D2). As capabilities NÃO podem ir no JWT: esta releitura por requisição é o que dá a revogação imediata.',
  'if (!conta.profile_code) {');
add(f.apiauth, 231, 'servico', 'refresh: relê profile_code do vínculo; sem vínculo → recusa', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Refresh confere conta ativa, session_version e vínculo, e reemite com o perfil de agora (253). Também não olha core_companies.active (D2). Com modelos, o profileCodes do token segue só por compatibilidade; o claim acessoCarimbo (desenho §5.3) nasce aqui.',
  'if (!vinculo?.profile_code) {');
add(f.apiauth, 419, 'servico', 'trocarOperacaoDaSessao(auth, refreshDaProva, destino): encerra a família e emite na empresa de destino com destino.profileCodes, sem storeId', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Troca de empresa. O escopo é conferido antes, em auth.ts:907 (assertMembership). Não leva storeId (428-435), o que o desenho §5.4 mantém de propósito: o escopo de caixa é do vínculo. A troca não é auditada hoje; o desenho acrescenta auth.switch_company (D7).',
  'export function trocarOperacaoDaSessao(');

// ============================================================ RecuperacaoDeSenhaDaEquipe.ts
add(f.recup, 204, 'servico', 'if (vinculos.some((v) => eDeDono(v.profile_code))) return null; — conta de dono não recupera senha por e-mail', P('L', 'O', 'M', 'T', 'E', 'C', 'CL', 'CO'), 'group.admin', 'grupo',
  'perfis_hoje = os que PODEM recuperar por e-mail: os 8 perfis da operação. admin_geral, gestor, contador e perfil desconhecido nunca recuperam (26-29). A capability NÃO é algo que o alvo precisa ter. É o nível exigido para administrar o alvo: a conta é "de dono" quando algum vínculo dela tem modelo assignable_by=\'grupo\' ou modelo inexistente, ou seja, só quem tem group.admin mexe nela (desenho §9.1). Perguntar só "o alvo tem group.admin" deixaria o contador recuperar por e-mail, porque o modelo contador só tem accounting.closing.view: seria mudança não listada.',
  'vinculos.some((v) => eDeDono(v.profile_code))');

// ============================================================ HierarquiaDePerfis.ts
add(f.hier, 71, 'atalho-admin', "const RESPONDEM_PELO_GRUPO = new Set(['admin_geral', 'gestor'])", P('D'), 'group.admin', 'grupo',
  'Atalho #11 do desenho §8: nível RESPONDE_PELO_GRUPO. Aqui o atalho vira capability de verdade: entregar modelo assignable_by=\'grupo\' ou capability de escopo grupo exige group.admin EM X (desenho §9.1-9.2).',
  "RESPONDEM_PELO_GRUPO = new Set(['admin_geral', 'gestor'])");
add(f.hier, 74, 'servico', "const MONTAM_O_TIME = new Set(['gerente_loja', 'gerente_oficina'])", P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Nível MONTA_O_TIME = users.manage (perfis_de_hoje D, L, O). Dia 1: igual.',
  "MONTAM_O_TIME = new Set(['gerente_loja', 'gerente_oficina'])");
add(f.hier, 83, 'servico', 'PERFIS_DA_OPERACAO = {gerente_loja, gerente_oficina, mecanico, atendente, estoquista, operador_caixa, operador_caixa_loja, operador_caixa_oficina} — exigência 1', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Os perfis que quem monta o time administra viram modelos assignable_by=\'gestao_da_empresa\' (desenho §3.1). Fora da lista (admin_geral, gestor, contador, desconhecido) = \'grupo\'. perfis_hoje = quem administra esses alvos (D, L, O). Gerente mexe em outro gerente, como hoje ("é par, não escalada", 29-31).',
  'const PERFIS_DA_OPERACAO = new Set([');
add(f.hier, 115, 'servico', 'capacidadeDe(perfis): 2 se admin_geral/gestor; 1 se gerente_loja/gerente_oficina; 0 resto', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Nível 1 = users.manage; nível 2 = group.admin. Chamadores: assertPodeAtribuir, assertPodeMexerNaOperacao, assertPodeMexerNaConta e GET /team/profiles (core.ts:9433-9434, filtra ASSIGNABLE_PROFILES por capacidade ≥ exigência). Com modelos, /team/profiles devolve os modelos que quem pergunta pode aplicar (§9.1).',
  'export function capacidadeDe(');
add(f.hier, 125, 'servico', 'exigenciaDe(perfil): 1 se PERFIS_DA_OPERACAO, senão 2 (dono ou desconhecido = falha fechada)', P('D'), 'group.admin', 'grupo',
  'A exigência que o ALVO impõe. Para alvo com modelo assignable_by=\'grupo\' ou desconhecido, exige group.admin (perfis_hoje = D). Para alvo da operação, exige users.manage (D, L, O). Vira a leitura de core_permission_templates.assignable_by do modelo atual do alvo. O modelo inexistente continua exigindo o topo.',
  'export function exigenciaDe(');
add(f.hier, 130, 'servico', 'eDeDono(perfil) = exigenciaDe(perfil) === RESPONDE_PELO_GRUPO', P('D'), 'group.admin', 'grupo',
  'Único consumidor: RecuperacaoDeSenhaDaEquipe.ts:204. Mesma tradução de exigenciaDe: "o vínculo exige group.admin para ser administrado" (modelo assignable_by=\'grupo\' ou inexistente).',
  'export function eDeDono(');
add(f.hier, 140, 'servico', 'assertPodeAtribuir(perfil, perfisDeQuemAge): capacidade ≥ exigência, senão 403 CORE_PROFILE_ABOVE_YOURS', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Régua de entregar perfil (criar, promover, vincular). Tradução do desenho §9.1: gestao_da_empresa → users.manage; grupo → group.admin; subconjunto → capabilities(modelo) ⊆ capabilities(quem age, X). MEDIDO pelo arquiteto: a régua pura "só entrega o que tem" quebraria 11 atribuições de hoje. Por isso as duas camadas. Gerente → contador continua recusado porque contador é assignable_by=\'grupo\'. Chamador: TeamService.ts:243.',
  'export function assertPodeAtribuir(');
add(f.hier, 189, 'servico', 'assertPodeMexerNaOperacao(perfilDoAlvoAqui, perfisDeQuemAge): capacidade ≥ exigência do perfil do alvo AQUI, senão 403 CORE_TARGET_ABOVE_YOURS', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Mexer no vínculo desta empresa (modelo, bancadas, remover daqui). Desenho §9.3: quem age satisfaz o assignable_by do modelo ATUAL do alvo em X, e os grants do alvo em X ⊆ capabilities de quem age em X. Chamadores: TeamService.ts:515 (PATCH), 757 (remover da operação); acoesSobre (270).',
  'export function assertPodeMexerNaOperacao(');
add(f.hier, 208, 'servico', 'assertPodeMexerNaConta: exigência aqui + (se não é a própria pessoa) alcance em CADA outra operação do alvo, pelo vínculo do ator lá', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Senha, ativo, nome e e-mail valem para TODAS as empresas do alvo. Por operação: senha → users.reset_password, ativo → users.deactivate, nome/e-mail → users.manage (hoje os três com D, L, O). As outras operações vêm do banco (223-227), e ali capacidadeDe([perfilDoAtorLa]) também aplica o atalho de dono. Com capability, a pergunta "em cada empresa do alvo" precisa das capabilities do ator em OUTRA empresa (resolução por userId+companyId, como na alçada). Recusa: CORE_TARGET_BEYOND_YOUR_REACH.',
  'export function assertPodeMexerNaConta(');
add(f.hier, 224, 'servico', 'const alcancaTodas = outras.every((v) => capacidadeDe([perfilDoAtorLa]) >= exigenciaDe(v.profile_code))', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'O recorte por empresa da régua da conta: sem vínculo do ator na outra empresa → recusa. Não pode ser reduzido a "tem users.manage na empresa ativa". Guardar para a F4 (desenho §9.3, "a mesma pergunta em cada empresa do alvo").',
  'const alcancaTodas = outras.every');
add(f.hier, 249, 'servico', 'acoesSobre(...): gerirNaOperacao, gerirConta, removerDaOperacao, calculados pelas MESMAS funções que recusam', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Espelho para a tela (GET /team, core.ts:9195). Continua "pelas mesmas funções que recusam" (desenho §9.3). Na tela nova ganha a granularidade por capability: users.reset_password e users.deactivate separados de users.manage.',
  'export function acoesSobre(');
add(f.hier, 280, 'atalho-admin', "removerDaOperacao: ... && perfilAqui !== 'admin_geral'", P('L', 'O', 'D'), 'users.manage', 'empresa',
  'Atalho #12 do desenho §8 (proteção que NOMEIA admin_geral): a tela não oferece remover o vínculo admin_geral. Espelha TeamService.ts:759. Vira o invariante CORE_LAST_GROUP_ADMIN (§9.4): recusa só quando a remoção deixaria o grupo sem ninguém com group.admin em todas as ativas. ESQUISITO: gestor, o "par idêntico", é removível; admin_geral não.',
  "&& perfilAqui !== 'admin_geral'");

// ============================================================ TeamService.ts
add(f.team, 70, 'servico', "ASSIGNABLE_PROFILES = ['gestor','gerente_loja','gerente_oficina','mecanico','atendente','estoquista','operador_caixa_loja','operador_caixa_oficina','contador']", P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Lista fixa de perfis atribuíveis. admin_geral e operador_caixa (legado) ficam fora. Vira "modelos não arquivados, hidden=0, cujo assignable_by quem age satisfaz" (desenho §3.1/§9.1). ATENÇÃO: gestor É atribuível (por quem tem group.admin) e dá TUDO na empresa, que é a mudança D8 de rótulo. Consumida também por GET /team/profiles (core.ts:9434). admin_geral continua só por bootstrap: modelo full_catalog, assignable_by=\'grupo\'.',
  'export const ASSIGNABLE_PROFILES = [');
add(f.team, 85, 'servico', "WORKSHOP_PROFILES = {mecanico, gerente_oficina, operador_caixa_oficina}: perfil de oficina exige bancada vinculada", P('D', 'M', 'O', 'CO'), 'workshop.orders.move', 'bancada',
  'Único código do catálogo cujo conjunto é exatamente {M, O, CO} + donos: workshop.orders.move. Consumidores: 161 (filtro da lista), 406/560/576/842 (exigência). Desenho §7.2: vira "capability de escopo bancada + all_workshops=0 (ou default_workshops=\'membro\') exige lista" (400 CORE_WORKSHOP_SCOPE_REQUIRED). ESQUISITO: gerente_oficina é obrigado a ter bancada, mas resolveWorkshop dá a ele TODAS de qualquer jeito (core.ts:7290-7293); o vínculo é exigido e ignorado. operador_caixa_oficina também é obrigado, mas o oficina.pdv do banco da loja não tem linha em core_workshop_members (core.ts:7343-7347). Mudança não listada no §14: com default_workshops=\'todas\' para O e CO, a tela deixa de EXIGIR bancada para eles.',
  "const WORKSHOP_PROFILES = new Set(['mecanico', 'gerente_oficina', 'operador_caixa_oficina'])");
add(f.team, 161, 'servico', 'listTeam({onlyWorkshopStaff}): uc.profile_code IN WORKSHOP_PROFILES', P('M', 'O', 'CO'), 'workshop.orders.move', 'bancada',
  'Não é autorização: é o filtro da lista "equipe da oficina" (GET /team?workshopStaff=1, core.ts:9189; tela /sistema/oficina/mecanicos). perfis_hoje sem donos, porque o filtro é por código e admin_geral/gestor NÃO aparecem. Com capability pura, os modelos full_catalog passam a aparecer na lista (mudança cosmética não listada). Para manter o dia 1: filtrar por "modelo com workshop.orders.move e não full_catalog", ou por vínculo com escopo de bancada por membro.',
  'uc.profile_code IN (${[...WORKSHOP_PROFILES]');
add(f.team, 205, 'servico', 'assertSameCompany(companyId, userId): o ALVO tem vínculo nesta empresa, senão 404 CORE_USER_NOT_IN_COMPANY', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Recorte de tenant do ALVO, não do ator. Chamadores: 502 (PATCH), 616 (ativar/desativar), 671 (reset), 746 (remover). Fica igual. As rotas novas /core/access/users/:id/companies/:companyId (desenho §11.4) precisam da mesma conferência por empresa do path, e cuidado: ali a empresa vem do PATH, e não mais do token.',
  'function assertSameCompany(');
add(f.team, 239, 'servico', 'assertProfile(profileCode, perfisDeQuemCria): ∈ ASSIGNABLE_PROFILES (senão 400) e assertPodeAtribuir', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Porta única de "entregar perfil": criação (399), promoção (557) e vínculo de conta existente (839). Vira "aplicar modelo" (§9.1). Sem perfisDeQuemCria entrega nada (falha fechada), e isso tem de continuar.',
  'function assertProfile(');
add(f.team, 302, 'servico', 'assertWorkshopsOfCompany(companyId, workshopIds): toda bancada pedida é desta empresa, senão 403', P('D', 'L', 'O'), 'users.manage', 'bancada',
  'Hoje confere só a EMPRESA da bancada: qualquer gerente (inclusive gerente_loja) entrega qualquer bancada da empresa. O desenho §9.2 acrescenta "só dentro do escopo de quem age". No dia 1 dá igual, porque gerentes e donos têm "todas"; o gerente de um modelo do dono com escopo por membro passaria a ser recusado.',
  'function assertWorkshopsOfCompany(');
add(f.team, 399, 'servico', 'inserirMembroDaEquipe: assertProfile(input.profileCode, input.perfisDeQuemCria ?? [])', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Criar pessoa: POST /core/team (createTeamMember, 480) e o primeiro gerente da empresa nova (IdentityService.ts:718-727). Auditoria team.create em core.ts:9219-9227 grava o perfil novo. O desenho §12 troca por user.created + access.template_applied.',
  'const profile = assertProfile(input.profileCode, input.perfisDeQuemCria ?? [])');
add(f.team, 406, 'servico', 'WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0 → 400 CORE_WORKSHOP_LINK_REQUIRED (criação)', P('D', 'L', 'O'), 'workshop.orders.move', 'bancada',
  'Exigência de bancada na criação, pelo código do perfil. Tradução: modelo com capability de escopo bancada e escopo "por membro" exige lista (desenho §7.2). Ver a nota de 85 sobre O e CO.',
  'if (WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0) {');
add(f.team, 515, 'servico', 'updateTeamMember: assertPodeMexerNaOperacao(atual.profileCode, perfisDeQuemAge)', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'O alvo é conferido antes de qualquer campo (GAP-PRD-010). Desenho §9.3: a régua passa a olhar o modelo atual do alvo + os grants dele.',
  'assertPodeMexerNaOperacao(atual.profileCode, perfisDeQuemAge)');
add(f.team, 530, 'servico', 'updateTeamMember: nome/e-mail mudaram → assertPodeMexerNaConta', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Nome e e-mail são da CONTA (todas as empresas). Só confere quando mudam (521-528). Evento novo user.profile_updated com antes/depois (§12).',
  'assertPodeMexerNaConta({');
add(f.team, 557, 'servico', 'updateTeamMember: assertProfile(input.profileCode, perfisDeQuemAge) — promoção/rebaixamento', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Trocar o perfil = aplicar outro modelo. O UPDATE de 567-569 não sobe session_version, e não precisa: ContaDaSessao relê por requisição. Auditoria team.update (core.ts:9250-9257) grava só o NOVO; o desenho §12/D7 acrescenta o antes.',
  'const profile = assertProfile(input.profileCode, perfisDeQuemAge)');
add(f.team, 560, 'servico', 'WORKSHOP_PROFILES.has(profile) && destino.length === 0 → 400 (troca de perfil)', P('D', 'L', 'O'), 'workshop.orders.move', 'bancada',
  'Mesma exigência de bancada, agora na promoção. Ver 85/406.',
  'if (WORKSHOP_PROFILES.has(profile) && destino.length === 0) {');
add(f.team, 576, 'servico', 'WORKSHOP_PROFILES.has(perfil) && input.workshopIds.length === 0 → 400 (troca de bancadas)', P('D', 'L', 'O'), 'workshop.orders.move', 'bancada',
  'Mesma exigência ao esvaziar as bancadas. Evento novo access.workshops_changed (§12).',
  'if (WORKSHOP_PROFILES.has(perfil) && input.workshopIds.length === 0) {');
add(f.team, 628, 'servico', 'setTeamMemberActive: assertPodeMexerNaConta', P('D', 'L', 'O'), 'users.deactivate', 'empresa',
  'Desativar/reativar a CONTA (todas as empresas). Sobe session_version (644-648). A régua é de conta: exige alcance em cada empresa do alvo. Auditoria team.activated/deactivated (core.ts:9277-9283).',
  'assertPodeMexerNaConta({');
add(f.team, 637, 'servico', 'if (!input.active && input.userId === input.actorId) → 400 CORE_CANNOT_DEACTIVATE_SELF', P('D', 'L', 'O'), 'users.deactivate', 'empresa',
  'Invariante que continua (desenho §9.4: ninguém desativa a si mesmo). Não depende de perfil.',
  'if (!input.active && input.userId === input.actorId) {');
add(f.team, 684, 'servico', 'resetTeamMemberPassword: assertPodeMexerNaConta', P('D', 'L', 'O'), 'users.reset_password', 'empresa',
  'Redefinir senha é tomar a conta. A régua é de conta (todas as empresas do alvo). Sobe session_version e must_change_password=1 (697-702). Auditoria team.password_reset (core.ts:9302-9308) sem a senha. O §12 mantém "quem, alvo, sem senha".',
  'assertPodeMexerNaConta({');
add(f.team, 748, 'servico', 'removerDaOperacao: userId === actorId → 400 CORE_CANNOT_REMOVE_SELF', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Invariante "ninguém altera o próprio acesso" (§9.4).',
  'if (input.userId === input.actorId) {');
add(f.team, 757, 'servico', 'removerDaOperacao: assertPodeMexerNaOperacao(perfilAqui, input.perfisDeQuemAge ?? [])', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Tirar a pessoa só desta empresa. Não sobe session_version: a sessão desta empresa cai na requisição seguinte pelo vínculo. Evento user.company_unlinked (§12).',
  'assertPodeMexerNaOperacao(perfilAqui, input.perfisDeQuemAge ?? [])');
add(f.team, 759, 'atalho-admin', "if (perfilAqui === 'admin_geral') → 403 CORE_INSTALL_ONLY_PROFILE", P('L', 'O', 'D'), 'users.manage', 'empresa',
  'Atalho #24 do desenho §8 (proteção pelo código admin_geral). Vira o invariante CORE_LAST_GROUP_ADMIN (409): recusa só se sumir o último com group.admin em todas as ativas. ESQUISITO: gestor (par idêntico, acesso igual) é removível pela tela; admin_geral não. Com o invariante, os dois passam a ter a mesma regra. É mudança deliberada, e deve entrar na lista do §14.',
  "if (perfilAqui === 'admin_geral') {");
add(f.team, 839, 'servico', 'vincularContaExistente: assertProfile(input.profileCode, input.perfisDeQuemCria ?? [])', P('D', 'L', 'O'), 'users.manage', 'empresa',
  'Dar acesso a esta empresa a uma conta que já existe (achada pelo login). Não toca senha/nome/e-mail. Evento user.company_linked + access.template_applied (§12). Auditoria de hoje: team.linked (core.ts:9359-9366).',
  'const profile = assertProfile(input.profileCode, input.perfisDeQuemCria ?? [])');
add(f.team, 842, 'servico', 'WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0 → 400 (vínculo de conta existente)', P('D', 'L', 'O'), 'workshop.orders.move', 'bancada',
  'Mesma exigência de bancada no vínculo. Ver 85.',
  'if (WORKSHOP_PROFILES.has(profile) && workshopIds.length === 0) {');

// ============================================================ AuthorizationService.ts (alçada)
add(f.authz, 21, 'atalho-admin', "const AUTHORIZERS = new Set(['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'])", P('D', 'L', 'O'), APROVACAO, 'empresa',
  'Atalho #13 do desenho §8. Um conjunto só para as 5 ações de RESTRICTED_ACTIONS (71-77). Vira uma capability por ação (desenho §10): desconto_acima_limite→approval.discount, sangria_especial→approval.cash_withdrawal, reabrir_caixa→approval.cash_reopen, cancelar_venda→approval.sale_cancel, devolver_venda→approval.sale_return. As 5 nascem com os mesmos perfis_de_hoje (D, L, O), então dia 1 é igual.',
  "const AUTHORIZERS = new Set(['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'])");
add(f.authz, 130, 'servico', 'temAlcadaParaLiberar(profileCodes) = profileCodes.some(p ∈ AUTHORIZERS) — "faz direto, sem pedir"', P('D', 'L', 'O'), APROVACAO, 'empresa',
  'Vira temAlcada(acesso, ação) = can(approval.<ação>), POR AÇÃO. Chamadores: discountNeedsAuthorization (783 → approval.discount), CashService.ts:357 (→ approval.cash_withdrawal), CashService.ts:667 (→ approval.cash_reopen), core.ts:6025 canAuthorizeSelf de GET /sales/discount-policy (→ approval.discount). Hoje a mesma função responde às três perguntas. Ao separar, cada chamador tem de passar a SUA ação.',
  'export function temAlcadaParaLiberar(');
add(f.authz, 135, 'servico', "const AUTORIZADORES_DA_OPERACAO = new Set(['gerente_loja', 'gerente_oficina'])", P('L', 'O'), 'group.admin', 'empresa',
  'Não autoriza: separa, no cartão "Quem libera aqui", os liberadores DA operação dos DO GRUPO. Desenho §10: "do grupo" = quem tem group.admin; "da operação" = os demais com approval.*. A capability registrada é a que decide o lado.',
  "const AUTORIZADORES_DA_OPERACAO = new Set(['gerente_loja', 'gerente_oficina'])");
add(f.authz, 155, 'servico', 'quemLiberaNaOperacao(companyId): contas ativas com uc.profile_code IN AUTHORIZERS nesta empresa, com o CÓDIGO do perfil', P('D', 'L', 'O'), APROVACAO, 'empresa',
  'Leitura (core.ts:5873) para o cartão da EquipePage. Vira "contas ativas cujo acesso NESTA empresa tem qualquer approval.*" (resolução de capabilities de terceiros, por userId+companyId) e devolve o NOME do modelo, não o código. Mantém a regra de não devolver o login (152-153).',
  'export function quemLiberaNaOperacao(');
add(f.authz, 299, 'servico', "authorizeAction: assertMembership(manager.id, companyId) && AUTHORIZERS.has(membership.profile_code), senão 403 CORE_AUTHORIZATION_DENIED", P('D', 'L', 'O'), APROVACAO, 'empresa',
  'O LIBERADOR (outra pessoa, por login+senha Argon2id) precisa de approval.<input.action> no acesso efetivo do vínculo DELE na empresa da venda (desenho §10). A capability exata depende da ação: "qualquer(approval.*)" aqui só descreve o dia 1, em que as 5 têm o mesmo conjunto. Implementar como can(capabilitiesDe(manager.id, companyId), approval.<ação>), nunca "qualquer". assertMembership já recorta empresa ativa. O escopo de caixa NÃO se aplica ao liberador.',
  'if (!membership || !AUTHORIZERS.has(membership.profile_code)) {');
add(f.authz, 308, 'servico', 'if (manager.id === input.requestedBy) → 403 CORE_SELF_AUTHORIZATION', P('D', 'L', 'O'), APROVACAO, 'empresa',
  'Invariante que continua: ninguém libera a própria ação restrita (desenho §10). Quem tem approval.* não precisa pedir: faz direto pelo temAlcada.',
  'if (manager.id === input.requestedBy) {');
add(f.authz, 388, 'servico', 'liberacaoValida: bilhete desta empresa e ação (401-403), não usado (408), requested_by === quem consome (420), dentro de 15 min (433)', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Não decide por perfil: o bilhete é a prova da alçada de OUTRA pessoa. Quem consome só precisa ser quem pediu, na mesma empresa e dentro de VALIDADE_DA_LIBERACAO_MS. Fica igual. A capability de quem consome é a da rota que o chama (pdv.cash.operate, pdv.sell etc.), não uma approval.*.',
  'function liberacaoValida(');
add(f.authz, 514, 'servico', 'consumirLiberacaoDeAcao: além de liberacaoValida, reference_id === recurso (540, CORE_AUTHORIZATION_OTHER_RESOURCE)', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Prende o "sim" ao recurso nas 3 ações de alvo (cancelar_venda, devolver_venda, reabrir_caixa). Sem perfil; fica igual.',
  'export function consumirLiberacaoDeAcao(');
add(f.authz, 605, 'servico', 'consumirLiberacaoDeConcessao: além de liberacaoValida, teto de concessão/percentual (660, 713)', TODOS, 'SO_AUTENTICADO', 'empresa',
  'Prende o "sim" do desconto/sangria ao VALOR. Sem perfil; fica igual.',
  'export function consumirLiberacaoDeConcessao(');
add(f.authz, 783, 'servico', 'discountNeedsAuthorization: if (temAlcadaParaLiberar(profileCodes)) return false;', P('D', 'L', 'O'), 'approval.discount', 'empresa',
  'Quem tem alçada concede acima do limite sem pedir. Chamadores: SalesService.ts:1232 (venda), QuoteService.ts:414 (orçamento/pré-venda). O profileCodes vem do req da rota. Na capability, o parâmetro vira o acesso (can(acesso, \'approval.discount\')).',
  'if (temAlcadaParaLiberar(profileCodes)) return false;');

// ============================================================ CashService / SalesService / QuoteService
add(f.cash, 357, 'servico', 'addMovement withdrawal: teto && |valor| > teto && !temAlcadaParaLiberar(alcada.profileCodes) → exige liberação', P('D', 'L', 'O'), 'approval.cash_withdrawal', 'empresa',
  'Sangria acima do teto da política: quem tem alçada faz direto, os demais gastam o bilhete (consumirLiberacaoDeConcessao). alcada.profileCodes vem da rota (core.ts:4226). O movimento em si é guardado por pdv.cash.operate + escopo do caixa (§6). A alçada é de empresa.',
  '!temAlcadaParaLiberar(perfis)');
add(f.cash, 667, 'servico', 'reopenSession: if (!temAlcadaParaLiberar(perfis)) → exige bilhete reabrir_caixa preso ao turno', P('D', 'L', 'O'), 'approval.cash_reopen', 'empresa',
  'Reabrir turno: quem tem alçada reabre direto, os demais gastam o bilhete preso ao sessionId (consumirLiberacaoDeAcao). alcada.profileCodes vem de core.ts:4331-4332.',
  'if (!temAlcadaParaLiberar(perfis)) {');
add(f.sales, 1232, 'servico', 'createSale: input.alcada && discountNeedsAuthorization(bruto, concedido, input.alcada.profileCodes, limite) → consome bilhete', P('D', 'L', 'O'), 'approval.discount', 'empresa',
  'Desconto acima do limite na venda. Quem monta alcada.profileCodes: core.ts:5049, 5226, 5312, 5561 e WorkshopCashierService.ts:372 (checkout da OS, core.ts:10217). Sem input.alcada a trava não roda (1230-1231): todo chamador de rota tem de continuar passando o acesso, agora como capabilities.',
  '&& discountNeedsAuthorization(');
add(f.quote, 414, 'servico', 'cobrarAlcadaDoDocumento: !discountNeedsAuthorization(bruto, concedido, input.alcada.profileCodes, limite)', P('D', 'L', 'O'), 'approval.discount', 'empresa',
  'Mesma trava no orçamento/pré-venda. Sem input.alcada devolve null (411): a trava só existe se o chamador passar o acesso.',
  '!discountNeedsAuthorization(');
add(f.quote, 1765, 'servico', "promover orçamento nunca conferido: alcadaDaAprovacao = input.alcada ?? { profileCodes: [] } (falha fechada)", P('D', 'L', 'O'), 'approval.discount', 'empresa',
  'Falha fechada: chamador sem acesso ganha alçada nenhuma. Na tradução, o "vazio" tem de ser o conjunto vazio de capabilities, nunca "sem filtro". A auditoria de 1830-1843 grava "perfis" de quem carimbou. Com modelos deve gravar o modelo e se tinha approval.discount (§12).',
  '? (input.alcada ?? { profileCodes: [] })');

// ============================================================ CobrancasSemVenda.ts
add(f.cobr, 53, 'atalho-admin', "const GESTORES = new Set(['gerente_loja', 'gerente_oficina', 'admin_geral', 'gestor'])", P('D', 'L', 'O'), 'pdv.supervise', 'empresa',
  'Atalho #22 do desenho §8. O comentário diz "os mesmos da conferência": conjunto idêntico a perfis_de_hoje de pdv.supervise (D, L, O).',
  "const GESTORES = new Set(['gerente_loja', 'gerente_oficina', 'admin_geral', 'gestor'])");
add(f.cobr, 169, 'servico', 'desistirDaCobranca: gestor = profiles ∈ GESTORES; !gestor && tx.createdBy !== userId → 403 CORE_TERMINAL_DESISTIR_NOT_OWNER', P('D', 'L', 'O'), 'pdv.supervise', 'empresa',
  'Desistir da cobrança de OUTRO operador é da supervisão; o operador desiste só da própria. Chamador: core.ts:4796 (sites-core-3 registra 4794 com pdv.supervise). Tradução: can(\'pdv.supervise\') || tx.createdBy === userId. Dia 1 igual.',
  'const gestor = input.profiles.some((p) => GESTORES.has(p))');

// ============================================================ WorkshopPartsService.ts
add(f.parts, 32, 'atalho-admin', "const VEEM_CUSTO = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista']", P('D', 'L', 'O', 'E'), 'workshop.parts.cost.view', 'bancada',
  'Atalho #21 do desenho §8. Conjunto idêntico a perfis_de_hoje de workshop.parts.cost.view.',
  "const VEEM_CUSTO = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista']");
add(f.parts, 34, 'servico', 'podeVerCusto(profiles) = profiles.some(p ∈ VEEM_CUSTO)', P('D', 'L', 'O', 'E'), 'workshop.parts.cost.view', 'bancada',
  'Chamadores: core.ts:15670 (hideCost da lista de peças) e 15715 (delete item.cost_cents). O custo sai do servidor, não é escondido na tela. ESQUISITO: diferente de PoliticaDeGestaoService.veCustoDoEstoque, aqui o estoquista vê custo SEMPRE e a política de gestão não se aplica. É coerente com o comentário da política ("custo como ferramenta de trabalho"), mas são duas réguas de custo; o catálogo já as separa (workshop.parts.cost.view × inventory.cost.view).',
  'export function podeVerCusto(');
add(f.parts, 105, 'servico', 'listParts: if (!options.hideCost) return base; senão remove cost_cents', P('D', 'L', 'O', 'E'), 'workshop.parts.cost.view', 'bancada',
  'Ponto de APLICAÇÃO. A decisão vem do chamador (core.ts:15670: hideCost = !podeVerCusto(profiles)). Remove o campo, não o zera (107).',
  'if (!options.hideCost) return base;');
add(f.parts, 161, 'servico', 'returnPartToStock: exigirOsNoAlcance(companyId, workshopId, orderId) — 404 fora do alcance de bancada', P('D', 'O', 'M'), 'workshop.parts.use', 'bancada',
  'Escopo de bancada (GAP-PRD-103). Rota POST /workshop/orders/:orderId/parts/:partId/return, requireProfile(\'gerente_oficina\',\'mecanico\') (core.ts:15858). O alcance vem de resolveWorkshop/resolveWorkshopScope (core.ts:7284-7386) e vira bancadasDoVinculo (§7).',
  'exigirOsNoAlcance(input.companyId, input.workshopId ?? null, input.orderId)',
  { metodo: 'POST', caminho: '/core/workshop/orders/:orderId/parts/:partId/return' });
add(f.parts, 162, 'servico', 'returnPartToStock: OS de outro técnico && !isManager → 403 CORE_ORDER_NOT_ASSIGNED_TO_YOU (isManager = isManagerProfile, core.ts:15873)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Trava de responsável COM bypass de gestor: isManagerProfile = admin_geral/gestor/gerente_oficina (core.ts:7417-7424) → can(\'workshop.admin\') (desenho §7.3). O mecânico devolve só peça da OS dele.',
  'antes.mechanic_id !== input.userId && !input.isManager',
  { metodo: 'POST', caminho: '/core/workshop/orders/:orderId/parts/:partId/return' });

// ============================================================ WorkshopIntakeService.ts
add(f.intake, 42, 'atalho-admin', "const GESTAO_DA_OFICINA = ['admin_geral', 'gestor', 'gerente_oficina']", P('D', 'O'), 'workshop.admin', 'bancada',
  'Atalho #19 do desenho §8. Régua de empresa: gestão da oficina abre OS em qualquer bancada. Some com bancadasDoVinculo (all_workshops=1 gravado no passo 86 para D e O).',
  "const GESTAO_DA_OFICINA = ['admin_geral', 'gestor', 'gerente_oficina']");
add(f.intake, 44, 'servico', "const BALCAO_DA_OFICINA = ['atendente', 'operador_caixa_oficina']", P('T', 'CO'), 'workshop.orders.open', 'bancada',
  'Balcão da oficina: abre OS e cadastra equipamento em QUALQUER bancada da empresa, mesmo sendo membro de alguma (GAP-PRD-099). Some com bancadasDoVinculo. Ver a nota de 65 sobre o desvio do passo 86.',
  "const BALCAO_DA_OFICINA = ['atendente', 'operador_caixa_oficina']");
add(f.intake, 65, 'servico', 'bancadasDeEntrada: reguaDeEmpresa = profiles ∈ GESTAO_DA_OFICINA ∪ BALCAO_DA_OFICINA → todas as bancadas ativas; senão só as de core_workshop_members', P('D', 'O', 'T', 'CO'), 'workshop.orders.open', 'bancada',
  'perfis_hoje = os que abrem OS em TODAS as bancadas. Chamadores: core.ts:7397 (resolveBancadaDeEntrada → POST /workshop/orders e POST /equipment) e core.ts:9580 (GET /workshop/entrada). DESVIO NÃO LISTADO no desenho §7.2: o passo 86 grava all_workshops=0 para "membro não gerente", e atendente/operador_caixa_oficina com linha em core_workshop_members (obrigatória para CO criado pela tela, TeamService.ts:85/406) hoje abrem OS em TODAS as bancadas aqui, mas o kanban (resolveWorkshopScope, core.ts:7364-7385) só lhes mostra as suas. Uma função única, bancadasDoVinculo, não reproduz as duas réguas: ou a entrada encolhe, ou o kanban alarga. O §7.2 afirma "idênticas no dia 1", o que só vale para quem não é membro. Decidir antes da F2(d) e listar como D-n.',
  'const reguaDeEmpresa = quem.profiles.some(');
add(f.intake, 73, 'servico', 'bancadasDeEntrada (mecânico e demais): todas.filter(w => membro de w)', P('M'), 'workshop.orders.open', 'bancada',
  'Régua por filiação: o mecânico abre OS só nas suas bancadas. Lista vazia → 403 CORE_WORKSHOP_FORBIDDEN (104-110). É o "vazio = nenhuma" de bancadasDoVinculo (falha fechada). gerente_loja e estoquista caem aqui também, mas a rota não os admite (workshop.orders.open não os tem).',
  'return todas.filter((w) =>');
add(f.intake, 89, 'servico', 'bancadaDeEntrada: bancada pedida (id/slug) fora de permitidas → 403 CORE_WORKSHOP_FORBIDDEN', P('D', 'O', 'T', 'CO', 'M'), 'workshop.orders.open', 'bancada',
  'Escolha explícita de bancada: só entre as do alcance. Fica igual, sobre bancadasDoVinculo.',
  "throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Oficina não autorizada para este usuário.', 403);");

// ============================================================ PoliticaDeGestaoService.ts
add(f.pol, 159, 'atalho-admin', "const QUEM_SEMPRE_VE = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina']", P('D', 'L', 'O'), 'dashboard.money.view', 'empresa',
  'Atalho #20 do desenho §8. A mesma lista serve a DUAS decisões: dinheiro no painel (165 → dashboard.money.view) e custo do estoque (169 → inventory.cost.view). As duas capabilities nascem com D, L, O.',
  "const QUEM_SEMPRE_VE = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina']");
add(f.pol, 165, 'servico', 'veDinheiroDoPainel(companyId, perfis) = ehGerencia(perfis) || politica.painelFinanceiroEquipe', P('D', 'L', 'O'), 'dashboard.money.view', 'empresa',
  'perfis_hoje = quem SEMPRE vê. Estoquista e atendente veem só com a política ligada pelo dono. Tradução: can(\'dashboard.money.view\') || política. Chamador: core.ts:7187 (GET /core/dashboard). ESQUISITO: a política diz "atendente e estoquista" (45), mas não recorta perfil: ligada, vale para QUALQUER vínculo que abra o painel (hoje só D, L, O, E, T). Com modelos do dono (cenário D, "PDV + Painel"), ligar a política passa a dar dinheiro também a quem tem só dashboard.view. Decidir se a política vira "dar dashboard.money.view a quem tem dashboard.view" ou continua flag.',
  'export function veDinheiroDoPainel(');
add(f.pol, 169, 'servico', 'veCustoDoEstoque(companyId, perfis) = ehGerencia(perfis) || politica.custoDoEstoqueEquipe', P('D', 'L', 'O'), 'inventory.cost.view', 'empresa',
  'perfis_hoje = quem sempre vê. Com a política: + estoquista/atendente (qualquer vínculo que chegue às rotas). Chamadores: core.ts:2851, 2894 (posição de estoque), 7225 (lowStock do painel). Tradução: can(\'inventory.cost.view\') || política. Mesma ressalva de 165 para modelos do dono (cenário E, Estoque).',
  'export function veCustoDoEstoque(');

// ============================================================ TitularService.ts
add(f.tit, 66, 'atalho-admin', "QUEM_ATENDE_O_CADASTRO = {admin_geral, gestor, gerente_loja, gerente_oficina, atendente, operador_caixa, operador_caixa_loja, operador_caixa_oficina}", P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'customers.contact.view', 'empresa',
  'Atalho #23 do desenho §8 (a lista nomeia os donos). Conjunto idêntico a perfis_de_hoje de customers.contact.view. ESQUISITO: o comentário (63-64) diz "os perfis de POST/PUT /core/customers", mas a lista inclui operador_caixa legado, que customers.manage NÃO tem (D, CL, CO, L, O, T). O catálogo acertou ao criar customers.contact.view separada; não fundir com customers.manage.',
  'const QUEM_ATENDE_O_CADASTRO');
add(f.tit, 79, 'servico', "alcanceDoCliente(perfis) = perfis ∈ QUEM_ATENDE_O_CADASTRO ? 'contato' : 'minimo'", P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'customers.contact.view', 'empresa',
  'Projeção LGPD por linha: estoquista, mecânico e contador recebem nome + últimos dígitos. Chamadores: core.ts:3669 (lista) e 3767 (ficha); sites-core-2 registra 3669. Tradução: can(acesso, \'customers.contact.view\') ? \'contato\' : \'minimo\'.',
  'export function alcanceDoCliente(');

// ============================================================ EquipmentService.ts
add(f.equip, 171, 'servico', "exigirMontador: vínculo do ALVO nesta empresa && PERFIS_QUE_MONTAM.has(profile_code) (149: {mecanico, gerente_oficina}) → senão 400 CORE_NOT_A_MECHANIC", P('M', 'O'), 'workshop.orders.assume', 'empresa',
  'Decide sobre o ALVO (quem pode constar como montador da máquina), não sobre quem age. perfis_hoje sem donos: um admin_geral/gestor como montador é recusado hoje. Capability mais próxima: workshop.orders.assume (o "técnico": D, M, O). Com capability pura os modelos full_catalog passam a ser aceitos como montador. É mudança cosmética não listada; para manter o dia 1, "tem workshop.orders.assume e o modelo não é full_catalog". Não confere bancada: um mecânico de outra bancada da empresa é aceito, como hoje.',
  'if (!PERFIS_QUE_MONTAM.has(String(membro.profile_code))) {');

// ============================================================ Prontidões (informativas, por código de perfil)
add(f.pront, 208, 'servico', "item contador_usuario: contas ativas com uc.profile_code = 'contador' nesta empresa", P('K'), 'accounting.closing.view', 'empresa',
  'Não é autorização: é o item de prontidão "Acesso do contador ao sistema". Perguntar por capability pura (accounting.closing.view) contaria gerentes e donos e daria "ok" sempre. Continuar perguntando pelo MODELO \'contador\' (o código segue valendo como modelo aplicado) ou por "tem accounting.closing.view e não tem users.view". Modelos do dono para contador (cópias) sumiriam do item.',
  "uc.profile_code = 'contador'");
add(f.impl, 297, 'servico', "item pessoas.gerente: contas ativas com uc.profile_code IN GERENTES (186: gerente_loja, gerente_oficina)", P('L', 'O'), 'users.manage', 'empresa',
  'Não é autorização: checklist de implantação (GET /system/implantacao/empresas/:companyId). Exclui os donos de propósito ("só o grupo entra nela para configurar"). Com capability pura (users.manage inclui D), o item daria PRONTO com só o admin vinculado. Filtrar por "users.manage e não group.admin" ou pelo modelo.',
  'uc.profile_code IN (${GERENTES');
add(f.impl, 321, 'servico', "item pessoas.caixa: contas ativas com uc.profile_code IN CAIXAS (187: operador_caixa, operador_caixa_loja, operador_caixa_oficina)", P('C', 'CL', 'CO'), 'pdv.cash.operate', 'empresa',
  'Não é autorização: checklist ("Ninguém com perfil de caixa: o balcão só abre com o gerente"). pdv.cash.operate também inclui gerentes e donos, e o item viraria PRONTO sem nenhum caixa. Filtrar por "pdv.cash.operate e não pdv.supervise" (é o que separa caixa de gerente no catálogo) ou pelo modelo.',
  'uc.profile_code IN (${CAIXAS');

// ============================================================ PDV: TerminalRegistry / GavetaDoDinheiro (escopo de caixa)
add(f.term, 41, 'servico', 'assertTerminalDaEmpresa(companyId, terminalId, {exigirAtivo}): caixa desta empresa (400) e ligado (409); nulo passa (gaveta única)', P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'qualquer(pdv.sell, pdv.cash.operate, pdv.payment.charge)', 'pdv',
  'Não olha perfil nem usuário: hoje o escopo de PDV é só a EMPRESA (qualquer caixa ou gerente abre qualquer caixa dela). perfis_hoje = os que as rotas de PDV admitem. Desenho §6.2: requireTerminalNoEscopo(req, terminalId) entra ao lado, conferindo core_user_companies.all_terminals / core_user_company_terminals; caixa desativado continua na lista e é recusado aqui (§6.2).',
  'export function assertTerminalDaEmpresa(');
add(f.term, 92, 'servico', 'terminalDoPedido({informado, doDispositivo}): o terminal do token vence o do corpo; divergência → 409 CORE_TERMINAL_MISMATCH', P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'qualquer(pdv.sell, pdv.cash.operate, pdv.payment.charge)', 'pdv',
  'É o caixa EFETIVO sobre o qual o escopo de PDV tem de ser cobrado. TODO chamador precisa de requireTerminalNoEscopo logo depois (desenho §6.3): core.ts:1523, 1653, 1675, 4183, 4696, 4714, 5505, 6259, 15164 e auth.ts:457. Um só esquecido deixa o operador de lista operar outro caixa. Hoje não há vínculo usuário↔caixa fora do token de dispositivo.',
  'export function terminalDoPedido(');
add(f.gav, 121, 'servico', 'gavetaDoDinheiro: gaveta informada aberta de OUTRO terminal → 409 CORE_CASH_SESSION_OTHER_TERMINAL', P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'qualquer(pdv.sell, pdv.cash.operate)', 'pdv',
  'Régua 1 da gaveta: só confere quando o pedido traz terminal. Sem terminal (login por senha), a gaveta informada de QUALQUER caixa da empresa é aceita (111-130): hoje o escopo é a empresa. Com escopo de caixa, a gaveta informada tem de ser de caixa no escopo do vínculo, mesmo sem terminalId.',
  'if (terminalId && sessao.terminal_id !== terminalId) {');
add(f.gav, 183, 'servico', 'gavetaDoDinheiro régua 3: sem caixa no pedido, a ÚNICA gaveta aberta da empresa é usada', P('D', 'L', 'O', 'T', 'C', 'CL', 'CO'), 'qualquer(pdv.sell, pdv.cash.operate)', 'pdv',
  'Desenho §6.2: com escopo em lista, a régua 3 só vale se essa gaveta é de caixa NO ESCOPO; se não, 409 CORE_TERMINAL_REQUIRED, e a tela oferece só os caixas do escopo. Hoje entrega a gaveta de qualquer caixa (inclusive a do colega) ao login por senha. A gaveta sem caixa (terminal_id nulo) = "PDV único".',
  'if (abertas.length === 1) {');

// ============================================================ WorkshopCoreService.ts (escopo de bancada e trava de responsável)
add(f.wcore, 251, 'servico', 'requireScopedOrder: OS com workshop_id fora do alcance → 404 (alcance null = todas da empresa)', P('D', 'L', 'O', 'E', 'T', 'C', 'CL', 'CO', 'M'), 'workshop.kanban.view', 'bancada',
  'O escopo de bancada de TODA ação sobre OS (e de exigirOsNoAlcance, 263, usado em WorkshopPartsService.ts:161 e WorkshopOrderRegularization.ts:136). O alcance vem de resolveWorkshop/resolveWorkshopScope (core.ts:7284-7386) e vira bancadasDoVinculo. perfis_hoje = quem as rotas de OS admitem (GET /workshop/orders: balcão+bancada+escritório, core.ts:9462). ESQUISITO: OS com workshop_id NULO passa em qualquer escopo (237-239); o mecânico de uma bancada vê e mexe na OS legada sem bancada. Continua assim com bancadasDoVinculo, a menos que se decida.',
  'if (workshopIds && order.workshop_id && !workshopIds.includes(order.workshop_id)) {');
add(f.wcore, 596, 'servico', "addComment: authorKind === 'tecnico' && OS de outro técnico → 403 (authorKind = vozNaOs(req), core.ts:9976)", P('D', 'O', 'T', 'CO'), 'workshop.admin', 'bancada',
  'Rota POST /workshop/orders/:id/comments: mecanico, gerente_oficina, operador_caixa_oficina, atendente (core.ts:9958). A voz é "gestor" para D/O (isManagerProfile), "tecnico" para o mecânico e "balcao" para os demais. Só o técnico toma a trava. perfis_hoje = os que comentam em OS alheia. Tradução (desenho §7.3): workshop.admin → gestor; workshop.orders.assume → técnico; senão balcão. A capability registrada é o bypass de gestor.',
  "if (kind === 'tecnico' && order.mechanic_id && order.mechanic_id !== input.userId) {",
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/comments' });
add(f.wcore, 678, 'servico', 'assumeOrder: OS já atribuída a outro técnico → 403 (SEM bypass de gestor)', [], 'workshop.orders.assume', 'bancada',
  'Trava de responsável sem exceção: ninguém, nem gerente, assume a OS de outro técnico (precisa largar antes, releaseOrder). perfis_hoje vazio = ninguém passa com OS alheia. NÃO traduzir para workshop.admin.',
  'if (order.mechanic_id && order.mechanic_id !== input.userId) {');
add(f.wcore, 792, 'servico', 'moveOrder: OS de outro técnico && !isManager → 403 (isManager = isManagerProfile, core.ts:9667)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Rota POST /workshop/orders/:id/move: mecanico, gerente_oficina, operador_caixa_oficina (core.ts:9656). isManagerProfile = admin_geral/gestor/gerente_oficina (core.ts:7417-7424) → can(\'workshop.admin\'). ESQUISITO: o operador_caixa_oficina, que a rota admite, é tratado como técnico aqui e toma 403 ao mover OS assumida por outro. Em addComment ele fala como balcão (7401-7405); aqui não há "voz de balcão".',
  'order.mechanic_id !== input.userId && !input.isManager',
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/move' });
add(f.wcore, 801, 'servico', "moveOrder: sair de 'aguardando_pagamento' && !isManager → 403 CORE_LEAVE_PAYMENT_MANAGER_ONLY", P('D', 'O'), 'workshop.admin', 'bancada',
  'Tirar a OS da fila do caixa desfaz a conclusão técnica: decisão de gestão. O operador_caixa_oficina, que cobra, não pode. Tradução: can(\'workshop.admin\').',
  "if (order.status === 'aguardando_pagamento' && !input.isManager) {",
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/move' });
add(f.wcore, 888, 'servico', 'releaseOrder: OS de outro técnico && !isManager → 403 (core.ts:9712)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Rota POST /workshop/orders/:id/release: mecanico, gerente_oficina (core.ts:9694). Bypass de gestor = workshop.admin. É um dos 5 pontos de resolveWorkshop do desenho §7.2.',
  'if (order.mechanic_id !== input.userId && !input.isManager) {',
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/release' });
add(f.wcore, 966, 'servico', 'setOrderPlan: OS de outro técnico && !isManager → 403 (core.ts:9788)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Rota PATCH /workshop/orders/:id/plan: mecanico, gerente_oficina (core.ts:9777). OS sem dono qualquer técnico planeja (961-962). Bypass = workshop.admin.',
  '!input.isManager',
  { metodo: 'PATCH', caminho: '/core/workshop/orders/:id/plan' });
add(f.wcore, 1086, 'servico', 'addPart: OS de outro técnico → 403 CORE_ORDER_NOT_ASSIGNED_TO_YOU (isManager NÃO é consultado aqui)', [], 'workshop.parts.use', 'bancada',
  'Rota POST /workshop/orders/:id/parts: mecanico, gerente_oficina (core.ts:9988). O isManager que a rota passa (core.ts:9999) só escolhe o rótulo de quem derrubou a aprovação (1253 → 1563); a trava NÃO tem bypass. O DESENHO §7.3 ERRA ao dizer que isManagerProfile "libera a trava de responsável em move, plan, parts, labor e release": em parts e labor não libera. Traduzir para workshop.admin ALARGARIA (o gerente_oficina passaria a lançar peça em OS alheia, que hoje é 403). perfis_hoje vazio = ninguém passa com OS alheia.',
  'if (order.mechanic_id && order.mechanic_id !== input.userId) {',
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/parts' });
add(f.wcore, 1582, 'servico', 'setLabor: OS de outro técnico → 403 (isManager NÃO é consultado aqui)', [], 'workshop.labor.manage', 'bancada',
  'Rota POST /workshop/orders/:id/labor: mecanico, gerente_oficina (core.ts:10019). Mesma observação de addPart: isManager (core.ts:10031) só vale para o rótulo (1609 → 1563). Não traduzir para workshop.admin.',
  'if (order.mechanic_id && order.mechanic_id !== input.userId) {',
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/labor' });
add(f.wcore, 1644, 'servico', 'completeTechnical: OS de outro técnico → 403 (sem parâmetro isManager)', [], 'workshop.orders.complete', 'bancada',
  'Só o técnico responsável conclui. Sem bypass de gestor. Não traduzir para workshop.admin.',
  'if (order.mechanic_id !== input.userId) {');

// ============================================================ WorkshopOrderRegularization.ts
add(f.wreg, 93, 'servico', 'bancadaDestino: bancada pedida tem de ser ATIVA DESTA EMPRESA → senão 403 (não confere o escopo de quem pede)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Rota POST /workshop/orders/:id/regularizar, requireProfile(\'gerente_oficina\') (core.ts:9736). O destino pode ser QUALQUER bancada da empresa; só a OS de origem passa pelo alcance (136). No dia 1 dá igual (D e O veem todas). Um modelo do dono com workshop.admin e escopo por membro poderia jogar a OS em bancada fora do escopo dele. Conferir o destino contra bancadasDoVinculo.',
  "throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Bancada não encontrada nesta empresa.', 403);",
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/regularizar' });
add(f.wreg, 136, 'servico', 'regularizarOs: exigirOsNoAlcance(companyId, input.alcance, orderId)', P('D', 'O'), 'workshop.admin', 'bancada',
  'Escopo de bancada da OS de origem. Sobre bancadasDoVinculo.',
  'exigirOsNoAlcance(input.companyId, input.alcance, input.orderId)',
  { metodo: 'POST', caminho: '/core/workshop/orders/:id/regularizar' });

// ============================================================ InventoryService.ts
add(f.inv, 1594, 'servico', 'listMovements: unit_cost_cents = options.hideCost ? null : ...', P('D', 'L', 'O', 'E', 'T', 'C', 'CL', 'CO', 'K'), 'inventory.view', 'empresa',
  'Ponto de APLICAÇÃO. A decisão está em core.ts:3042-3045: hideCost = nenhum de {admin_geral, gestor, gerente_loja, gerente_oficina, estoquista} E tem mecanico. Com 1 perfil por vínculo, só o mecânico perde o custo (sites-core-2 registra 3042 como atalho-admin → inventory.view, desenho #17). perfis_hoje = os que RECEBEM o custo entre os que chegam à rota. ESQUISITO: esta régua (o custo do razão aparece para atendente e caixas) diverge de veCustoDoEstoque (posição de estoque, só gerência ou política) e de podeVerCusto (peças, com estoquista). São três réguas de custo.',
  'unit_cost_cents: options.hideCost ? null : row.unit_cost_cents');

// ============================================================ conferência e gravação
const erros = [];
const cache = new Map();
const linhaDe = (arq, n) => {
  if (!cache.has(arq)) cache.set(arq, fs.readFileSync(path.join(RAIZ, arq), 'utf8').split(/\r?\n/));
  return cache.get(arq)[n - 1] ?? '';
};
for (const s of L) {
  const txt = linhaDe(s.arquivo, s.linha);
  if (!txt.includes(s.confere)) erros.push(`${s.arquivo}:${s.linha} não contém «${s.confere}» — linha real: «${txt.trim()}»`);
}
// capabilities citadas existem no catálogo
const cat = JSON.parse(fs.readFileSync(path.join(path.dirname(SAIDA), 'catalogo.json'), 'utf8'));
const codes = new Set(cat.map((c) => c.code));
for (const s of L) {
  const cs = s.capability.replace(/^(qualquer|todas)\(|\)$/g, '').split(',').map((x) => x.trim());
  for (const c of cs) {
    if (['SO_AUTENTICADO', 'PUBLICA'].includes(c) || c.startsWith('FALTA:')) continue;
    if (!codes.has(c)) erros.push(`${s.arquivo}:${s.linha} capability desconhecida: ${c}`);
  }
}
if (erros.length) { console.error(erros.join('\n')); process.exit(1); }
const saida = L.map(({ confere, ...resto }) => resto);
fs.writeFileSync(SAIDA, JSON.stringify(saida, null, 2) + '\n', 'utf8');
console.log('ok', saida.length, 'sites →', SAIDA);
