// Gera sites-core-5.json (fatia core.ts 8801-11000). Só lê a árvore; escreve só nesta pasta.
const fs = require('fs');
const path = require('path');
const AB = { L:'gerente_loja', O:'gerente_oficina', E:'estoquista', T:'atendente', C:'operador_caixa', CL:'operador_caixa_loja', CO:'operador_caixa_oficina', M:'mecanico', K:'contador' };
const D = ['admin_geral','gestor'];
const P = (s) => [...D, ...(s ? s.split(',').map(x => AB[x.trim()]) : [])];
const TRES = 'C,CL,CO,M,L,O,E,T';
const F = 'server/src/routes/v1/core.ts';
const out = [];
function r(linha, tipo, metodo, caminho, guarda, perfis, cap, escopo, nota) {
  out.push({ arquivo: F, linha, tipo, metodo, caminho, guarda_hoje: guarda, perfis_hoje: perfis, capability: cap, escopo, nota });
}
const SCOPE_G = ['admin_geral','gestor','gerente_oficina'];
const scopeNota = (extra) => `Recorte de bancada: resolveWorkshopScope (core.ts:7354-7386) — admin_geral/gestor/gerente_oficina veem todas (atalho em core.ts:7359-7362), membro vê as suas, e quem não é gerente nem membro vê a EMPRESA INTEIRA (fallback core.ts:7383-7384). perfis_hoje = quem vê todas por código de perfil (mais o fallback). Vira bancadasDoVinculo(req) (desenho §7.2); o passo 86 grava all_workshops=1 para gerentes e não-membros e preserva o dia 1; a mudança D3 fecha o fallback para vínculos novos. ${extra}`.trim();
const isMgrNota = (extra) => `isManagerProfile (core.ts:7417-7424): admin_geral/gestor/gerente_oficina por código (atalho #16 do desenho §8). ${extra} Tradução exata (§7.3): can('workshop.admin') = {gerente_oficina} + donos.`;
const notMecNota = `isManager = !profiles.includes('mecanico'): o atalho é por negação — atendente, gerente_oficina, admin_geral, gestor e QUALQUER código desconhecido falam como gestão (falha aberta na voz). Só o mecânico fala como técnico. Tradução exata (§7.3): !can('workshop.orders.assume') || can('workshop.admin') — atendente → verdadeiro, gerente_oficina → verdadeiro, mecânico → falso.`;

// ---------------- fiscal (fronteira)
r(8802,'rota','POST','/core/fiscal/series',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'fiscal.config.manage','empresa',
 'Rota declarada em core.ts:8800, uma linha antes do início da fatia (o guarda cai dentro dela) — pode aparecer também na fatia core-4: deduplicar por método+caminho. Grava série e próximo número da NF-e/NFC-e: é configuração fiscal da empresa, não operação de documento. mapa-rota-capability.tsv: fiscal.config.manage = {L,O}+donos, igual. A leitura irmã GET /fiscal/series (core.ts:8785-8787) fica com fiscal.view.');

// ---------------- empresas do grupo
r(8900,'rota','GET','/core/companies','requireProfile(req)',P(''),'group.companies.manage','grupo',
 'requireProfile(req) sem lista = só o atalho de core.ts:941 (admin_geral/gestor). A rota lê ATRAVÉS de empresas: listCompaniesForUser (IdentityService.ts:352-363: empresas ATIVAS com vínculo) ∩ operacoesOndeOPerfilAbre (ver linha 8903). O escopo é grupo, mas o recorte continua por vínculo: um "gestor" de uma loja só lista só a dele.');
r(8903,'atalho-admin','GET','/core/companies','operacoesOndeOPerfilAbre(scope(req).userId, [])',P(''),'group.companies.manage','grupo',
 'Com lista vazia, operacoesOndeOPerfilAbre (AlcanceCruzado.ts:38-56) devolve só as empresas ATIVAS em que o vínculo LÁ é admin_geral/gestor (PERFIS_QUE_PASSAM_EM_TUDO, AlcanceCruzado.ts:27 e 43). É o atalho #6 do desenho §8. Substituto: operacoesOndeACapabilityAbre(userId, "group.companies.manage"), que devolve as empresas ativas em que o acesso da pessoa LÁ tem a capability. Dia 1 igual: só os modelos admin_geral e gestor têm group.companies.manage.');
r(8932,'rota','PATCH','/core/companies/:id/equipment-tags','requireProfile(req)',P(''),'group.companies.manage','grupo',
 'requireProfile(req) = só donos (core.ts:941). Mesma capability da criação e da listagem (o catálogo cita as três rotas). Tem mais dois portões: responder pelo grupo (linha 8934) e a empresa-alvo estar entre os vínculos (linha 8942). Audita company.equipment_tags.update com antes/depois nas duas empresas (core.ts:8946-8957).');
r(8934,'atalho-admin','PATCH','/core/companies/:id/equipment-tags','respondePeloGrupo(userId) → 403 CORE_GROUP_SCOPE_REQUIRED',P(''),'group.admin','grupo',
 "respondePeloGrupo (IdentityService.ts:390-403) exige profile_code IN ('admin_geral','gestor') em TODAS as empresas ativas. É o atalho #8 do desenho §8, que vira \"tem group.admin em todas as ativas\". Hoje recusa o admin/gestor de uma loja só, mesmo que ele passe no requireProfile. Dia 1 igual: group.admin só existe nos modelos admin_geral/gestor.");
r(8942,'servico','PATCH','/core/companies/:id/equipment-tags','listCompaniesForUser(userId).some(c => c.id === alvo) → 404 CORE_COMPANY_NOT_FOUND',P(''),'group.companies.manage','grupo',
 'A empresa-alvo (req.params.id) tem de estar entre as empresas ATIVAS com vínculo (IdentityService.ts:352-363). É escopo de empresa por vínculo, não capability, e continua igual. Detalhe: como a lista filtra c.active = 1, a plaquinha de uma empresa desativada não se liga nem desliga (404). E, com respondePeloGrupo verdadeiro, esse teste é redundante para as empresas ativas.');
r(8976,'rota','POST','/core/companies','requireProfile(req)',P(''),'group.companies.manage','grupo',
 'requireProfile(req) = só donos. Cria a empresa e o primeiro gerente numa transação (IdentityService.ts:618-735). O corpo não escolhe tenant nem pessoa (core.ts:8877-8883, 9062-9065). Audita company.created nas duas empresas (core.ts:9105-9120).');
r(8983,'atalho-admin','POST','/core/companies','respondePeloGrupo(userId) → 403 CORE_GROUP_SCOPE_REQUIRED',P(''),'group.admin','grupo',
 "O mesmo teste da linha 8934 (IdentityService.ts:390-403): admin_geral/gestor em TODAS as ativas. É o atalho #8 do desenho §8 → group.admin em todas as ativas. Recusa o adm de uma loja só, que tem \"o perfil certo e o alcance errado\" (core.ts:8979-8982).");
r(9053,'atalho-admin','POST','/core/companies','createCompanyWithFounders → listGroupAdminIds()/listGroupManagerIds() + vínculo admin_geral/gestor na empresa nova',P(''),'group.admin','grupo',
 "Na mesma transação, o serviço vincula à empresa nova o criador (como 'gestor' se for gestor do grupo, senão 'admin_geral'), os administradores do grupo como 'admin_geral' e os gestores como 'gestor' (IdentityService.ts:634-688). São os atalhos #9 e #10 do desenho §8: \"cada conta com group.admin em todas as ativas entra com o MESMO modelo que tem nas outras\". Sem isso, o administrador do grupo perderia group.admin na empresa nova e deixaria de responder pelo grupo, porque respondePeloGrupo exige todas.");
r(9065,'atalho-admin','POST','/core/companies',"perfisDoCriador: scope(req).profiles → inserirMembroDaEquipe(profileCode do corpo) → assertProfile + assertPodeAtribuir",P(''),'users.manage','empresa',
 "O profileCode do primeiro gerente vem do CORPO (core.ts:9035-9037); o padrão é gerente_loja ou gerente_oficina, pelo tipo da empresa. Passa por inserirMembroDaEquipe com perfisDeQuemCria = perfis do token (IdentityService.ts:718-727), depois por ASSIGNABLE_PROFILES (TeamService.ts:70-80, 239-243) e por assertPodeAtribuir (HierarquiaDePerfis.ts:140-148; capacidadeDe com o atalho RESPONDEM_PELO_GRUPO em :71 e :116). ESQUISITO: como o criador é dono, o corpo pode pedir 'gestor' ou 'contador' como \"primeiro gerente\", e nasce um par do administrador vinculado só à empresa nova. Com capabilities, aplicar o modelo exige users.manage mais o assignable_by dele (§9.1); os modelos 'grupo' exigem group.admin, que o criador tem. Sugestão (mudança deliberada, a listar): limitar o primeiro gerente aos modelos assignable_by='gestao_da_empresa'.");

// ---------------- equipe
r(9164,'rota','GET','/core/sellers',"requireProfile(req, 'gerente_loja', 'gerente_oficina', ...BALCAO)",P('L,O,C,CL,CO'),'pdv.cash.operate','pdv',
 'BALCAO = CAIXAS (core.ts:1011, 923). Devolve só id, nome e ativo para o seletor "Vendedor" do PDV (core.ts:9150-9161). mapa: pdv.cash.operate = {C,CL,CO,L,O}+donos, igual. ESQUISITO: o atendente vende (POST /core/sales também o aceita, core.ts:5568-5570), mas não recebe /sellers. No PDV dele o seletor some em silêncio (o catch silencioso de core.ts:9153-9155) e toda venda sai em nome de quem está logado. qualquer(pdv.sell, pdv.cash.operate) resolveria, mas alarga o atendente: é um desvio a listar. O escopo pdv aqui é só nominal: a rota não tem caixa, então requireTerminalNoEscopo não se aplica.');
r(9180,'rota','GET','/core/team',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.view','empresa',
 'Lista a equipe da empresa ATIVA, com login, e-mail, último acesso e vínculos de bancada. users.view = {L,O}+donos, igual. A grade pessoa × empresas é trabalho novo (§11.4).');
r(9184,'atalho-admin','GET','/core/team','resolveWorkshop(req) — só com ?workshopId=',SCOPE_G,'users.view','bancada',
 'resolveWorkshop (core.ts:7284-7328): admin_geral/gestor/gerente_oficina alcançam todas as bancadas (atalho em core.ts:7290-7293); os demais, só as de que são membros, SEM fallback. Por isso o gerente_loja passa no guarda, mas toma 403 CORE_WORKSHOP_FORBIDDEN ao filtrar por oficina se não for membro. Vira bancadasDoVinculo (§7.2). É um dos 5 pontos da mudança D3: a bancada pedida passa a ser aceita para quem ganhou all_workshops=1.');
r(9195,'atalho-admin','GET','/core/team','acoesSobre({ companyId, alvoId, actorId, perfisDeQuemAge: profiles })',P('L,O'),'users.manage','empresa',
 "acoesSobre (HierarquiaDePerfis.ts:249-284) calcula, para cada membro, gerirNaOperacao, gerirConta e removerDaOperacao. Usa capacidadeDe, com o atalho RESPONDEM_PELO_GRUPO (:71, :115-119), e o teste perfilAqui !== 'admin_geral' (:280, atalho #12). Hoje os donos (capacidade 2) alcançam todos; L e O (capacidade 1) alcançam só os perfis da operação. Vira a régua do §9.3 (assignable_by do modelo atual do alvo + grants ⊆ capabilities de quem age) mais o invariante CORE_LAST_GROUP_ADMIN (§9.4). Os botões seguem sendo calculados pelas MESMAS funções que recusam.");
r(9206,'rota','POST','/core/team',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.manage','empresa',
 'Cria a pessoa com senha provisória. A auditoria team.create grava login e perfil, sem a senha (core.ts:9219-9227). users.manage = {L,O}+donos, igual.');
r(9215,'atalho-admin','POST','/core/team','createTeamMember({ perfisDeQuemCria: scope(req).profiles }) → assertProfile → ASSIGNABLE_PROFILES + assertPodeAtribuir',P('L,O'),'users.manage','empresa',
 "O código tem de estar em ASSIGNABLE_PROFILES (TeamService.ts:70-80, 239-243, com 'gestor' e sem admin_geral), e assertPodeAtribuir (HierarquiaDePerfis.ts:140-148) exige capacidade ≥ exigência. A capacidade é 2 para os donos (atalho RESPONDEM_PELO_GRUPO, :71) e 1 para L/O; a exigência é 1 para os perfis da operação e 2 para gestor, contador ou código desconhecido. Perfis de oficina exigem bancada (TeamService.ts:85, 406-412). Vira o §9.1: users.manage mais o assignable_by do modelo ('grupo' exige group.admin). Os perfis vêm do token (core.ts:9214-9215).");
r(9237,'rota','PATCH','/core/team/:id',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.manage','empresa',
 'Edita nome, e-mail, perfil e bancadas. ESQUISITO: a auditoria team.update grava só o estado novo, sem o antes (core.ts:9250-9257). É a mudança D7 do desenho.');
r(9247,'atalho-admin','PATCH','/core/team/:id','updateTeamMember({ perfisDeQuemCria: scope(req).profiles }) → assertPodeMexerNaOperacao / assertPodeMexerNaConta / assertProfile',P('L,O'),'users.manage','empresa',
 'Perfil e bancadas desta empresa: assertPodeMexerNaOperacao(perfil atual do alvo) (TeamService.ts:515; HierarquiaDePerfis.ts:189-195). Nome e e-mail: assertPodeMexerNaConta, em TODAS as empresas do alvo (TeamService.ts:530-534; HierarquiaDePerfis.ts:208-229). Perfil novo: assertProfile (TeamService.ts:557). Todos usam capacidadeDe, que tem o atalho. Vira o §9.3.');
r(9266,'rota','POST','/core/team/:id/active',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.deactivate','empresa',
 'Liga ou desliga a conta em TODAS as empresas da pessoa e sobe session_version (TeamService.ts:644-648). Audita team.activated/deactivated (core.ts:9277-9283).');
r(9275,'atalho-admin','POST','/core/team/:id/active','setTeamMemberActive({ perfisDeQuemAge: scope(req).profiles }) → assertPodeMexerNaConta',P('L,O'),'users.deactivate','empresa',
 'assertPodeMexerNaConta (TeamService.ts:628-632; HierarquiaDePerfis.ts:208-229) exige vencer a exigência do alvo em CADA empresa dele; senão, 403 CORE_TARGET_BEYOND_YOUR_REACH. Vira users.deactivate em cada empresa do alvo, mais o assignable_by do modelo dele (§9.3).');
r(9293,'rota','POST','/core/team/:id/password',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.reset_password','empresa',
 'Senha provisória. Sobe session_version (TeamService.ts:697-702). Audita team.password_reset SEM a senha (core.ts:9302-9308).');
r(9300,'atalho-admin','POST','/core/team/:id/password','resetTeamMemberPassword({ perfisDeQuemAge: scope(req).profiles }) → assertPodeMexerNaConta',P('L,O'),'users.reset_password','empresa',
 'assertPodeMexerNaConta (TeamService.ts:684-688; HierarquiaDePerfis.ts:208-229), com capacidadeDe e o atalho. Vira users.reset_password em cada empresa do alvo (§9.3).');
r(9326,'rota','POST','/core/team/:id/remove-from-company',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.manage','empresa',
 'Tira a pessoa SÓ desta empresa (core.ts:9316-9323). Audita team.removed_from_company (core.ts:9334-9341).');
r(9332,'atalho-admin','POST','/core/team/:id/remove-from-company',"removerDaOperacao → assertPodeMexerNaOperacao + recusa fixa de perfilAqui === 'admin_geral'",P('L,O'),'users.manage','empresa',
 "assertPodeMexerNaOperacao (TeamService.ts:757). Além disso, há uma recusa FIXA a remover um vínculo 'admin_geral' (TeamService.ts:759-767, 403 CORE_INSTALL_ONLY_PROFILE), para qualquer um, inclusive outro admin. ESQUISITO: o par 'gestor', idêntico nos guardas (HierarquiaDePerfis.ts:27-28), pode ser removido por outro dono, porque a proteção é pelo código e não pelo papel. Vira o invariante \"sempre há ≥1 conta ativa com group.admin em todas as ativas\" (§9.4, 409 CORE_LAST_GROUP_ADMIN; atalho #24). Remover a si mesmo continua recusado (TeamService.ts:748-754).");
r(9350,'rota','POST','/core/team/link',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.manage','empresa',
 'Vincula uma conta existente a esta empresa. Audita team.linked (core.ts:9359-9366).');
r(9356,'atalho-admin','POST','/core/team/link','vincularContaExistente({ perfisDeQuemCria: profiles }) → assertProfile → assertPodeAtribuir',P('L,O'),'users.manage','empresa',
 'assertProfile (TeamService.ts:839) passa por ASSIGNABLE_PROFILES e por assertPodeAtribuir (HierarquiaDePerfis.ts:140-148, capacidadeDe com atalho). Vira o §9.1: users.manage mais o assignable_by do modelo aplicado.');
r(9392,'rota','GET','/core/team/recuperacao-de-senha','requireProfile(req)',P(''),'users.password_recovery.manage','empresa',
 'Só donos (core.ts:941). "Esqueci minha senha" por e-mail é política da casa, e o gerente não decide por ela (core.ts:9373-9381). users.password_recovery.manage = donos, igual.');
r(9401,'rota','PUT','/core/team/recuperacao-de-senha','requireProfile(req)',P(''),'users.password_recovery.manage','empresa',
 'Só donos. Audita team.password_recovery.config (core.ts:9407-9414).');
r(9423,'rota','GET','/core/team/profiles',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'users.view','empresa',
 'Lista os perfis que quem pergunta pode entregar; o filtro está na linha 9433. users.view = {L,O}+donos, igual.');
r(9433,'atalho-admin','GET','/core/team/profiles','capacidadeDe(req.auth?.profileCodes) >= exigenciaDe(p) sobre ASSIGNABLE_PROFILES',P('L,O'),'users.manage','empresa',
 'Lê req.auth.profileCodes direto, sem passar por scope(). capacidadeDe, com o atalho RESPONDEM_PELO_GRUPO (HierarquiaDePerfis.ts:71, 115-119), é comparada com exigenciaDe (:125-127): L e O recebem os 7 perfis da operação; os donos recebem os 9 de ASSIGNABLE_PROFILES, incluindo gestor e contador. Vira "os modelos que quem age pode aplicar" (§9.1, assignable_by). Esse filtro depende de users.manage, e não de users.view: um vínculo com users.view sem users.manage deveria receber a lista vazia.');

// ---------------- ordens de serviço
r(9462,'rota','GET','/core/workshop/orders',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada',
 'Kanban e busca. Balcão + bancada + escritório = todos menos contador (PERFIS_DO_AMBIENTE, core.ts:1057-1062). O recorte de bancada fica na linha 9464. ESQUISITO: a resposta traz workshops: listWorkshopsOf(companyId) (core.ts:9489), que são TODAS as bancadas da empresa e não as do alcance, embora o comentário (core.ts:9487-9488) diga "lista de oficinas do alcance". O mecânico de uma bancada vê o nome das outras no seletor; são só nomes, porque as OS saem filtradas. Com bancadasDoVinculo, a resposta deve trazer a lista do vínculo.');
r(9464,'atalho-admin','GET','/core/workshop/orders','resolveWorkshopScope(req) → searchOrders({ workshopIds })',SCOPE_G,'workshop.kanban.view','bancada',
 scopeNota('Hoje o fallback cobre estoquista, atendente, gerente_loja e os três caixas, que não são membros.'));
r(9465,'servico','GET','/core/workshop/orders',"onlyMine = req.query.mine === 'true' && profiles.includes('mecanico')",['mecanico'],'workshop.orders.assume','bancada',
 "?mine=true só filtra por técnico quem tem o código 'mecanico'. Tradução exata (§7.3): can('workshop.orders.assume') && !can('workshop.admin'). Hoje admin_geral/gestor/gerente_oficina com mine=true veem tudo, e com a tradução também.");
r(9518,'rota','GET','/core/workshop/orders/:id/impressao',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada',
 'A OS em papel (A4). Mesmo alcance da leitura da OS (core.ts:9513-9514).');
r(9529,'atalho-admin','GET','/core/workshop/orders/:id/impressao','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.kanban.view','bancada',
 scopeNota('A OS fora do alcance dá 404 (requireScopedOrder, WorkshopCoreService.ts:2045-2051) antes de virar papel (core.ts:9520-9528).'));
r(9542,'rota','GET','/core/workshop/orders/:id',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada',
 "ESQUISITO (contato do cliente): getOrderDetail devolve customer_phone (WorkshopCoreService.ts:2059-2060) a todos que passam no guarda, inclusive mecanico e estoquista, que NÃO têm customers.contact.view no catálogo. A checagem de serviço do contato (TitularService, desenho §8 #23) não é aplicada aqui. Deixando assim, o dia 1 fica igual; aplicar can('customers.contact.view') estreitaria M e E, e isso é decisão do dono.");
r(9544,'atalho-admin','GET','/core/workshop/orders/:id','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.kanban.view','bancada',
 scopeNota('Fora do alcance: 404.'));
r(9559,'rota','GET','/core/workshop/orders/:id/avisos',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada',
 'Mensagens ao cliente e o e-mail do cadastro (core.ts:9551-9555). É o mesmo ponto de contato do cliente da linha 9542: M e E recebem o e-mail sem ter customers.contact.view.');
r(9563,'atalho-admin','GET','/core/workshop/orders/:id/avisos','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, orderId)',SCOPE_G,'workshop.kanban.view','bancada',
 scopeNota('Fora do alcance: 404 (core.ts:9562).'));
r(9578,'rota','GET','/core/workshop/entrada',"requireProfile(req, 'gerente_oficina', 'operador_caixa_oficina', 'atendente', 'mecanico')",P('O,CO,T,M'),'workshop.orders.open','bancada',
 'As bancadas onde quem pergunta pode abrir OS; a régua está na linha 9580. workshop.orders.open = {O,CO,T,M}+donos, igual.');
r(9580,'atalho-admin','GET','/core/workshop/entrada','bancadasDeEntrada({ companyId, userId, profiles })',['admin_geral','gestor','gerente_oficina','atendente','operador_caixa_oficina'],'workshop.orders.open','bancada',
 "WorkshopIntakeService.ts:42-74: GESTAO_DA_OFICINA ['admin_geral','gestor','gerente_oficina'] (atalho #19) e BALCAO_DA_OFICINA ['atendente','operador_caixa_oficina'] veem todas as bancadas ativas; o mecanico só vê as de que é membro. Vira bancadasDoVinculo (§7.2): o passo 86 grava all_workshops=1 para gerentes e para não-membros que não são mecânicos, o que reproduz a régua de empresa do balcão.");
r(9588,'rota','POST','/core/workshop/orders',"requireProfile(req, 'gerente_oficina', 'operador_caixa_oficina', 'atendente', 'mecanico')",P('O,CO,T,M'),'workshop.orders.open','bancada',
 'Abre a OS. Audita workshop.order.create (core.ts:9610-9617).');
r(9592,'atalho-admin','POST','/core/workshop/orders','resolveBancadaDeEntrada(req) → bancadaDeEntrada',['admin_geral','gestor','gerente_oficina','atendente','operador_caixa_oficina'],'workshop.orders.open','bancada',
 'bancadaDeEntrada (WorkshopIntakeService.ts:82-119; core.ts:7393-7398). Bancada pedida fora da lista: 403. Mecânico sem bancada: 403; empresa sem bancada: 404. Mais de uma sem escolha: 400. Tem a mesma régua (com o atalho) da linha 9580 e vira bancadasDoVinculo.');
r(9627,'rota','POST','/core/workshop/orders/:id/assume',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.orders.assume','bancada',
 'Assumir é o único caminho para sair de EM ABERTO (core.ts:9624). workshop.orders.assume = {M,O}+donos, igual.');
r(9632,'atalho-admin','POST','/core/workshop/orders/:id/assume','resolveWorkshopScope(req) → assumeOrder({ workshopId })',SCOPE_G,'workshop.orders.assume','bancada',
 scopeNota('A escrita usa a mesma lista da leitura.'));
r(9656,'rota','POST','/core/workshop/orders/:id/move',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina')",P('M,O,CO'),'workshop.orders.move','bancada',
 'O caixa da oficina move, por exemplo para devolver a OS da fila à bancada. workshop.orders.move = {M,O,CO}+donos, igual.');
r(9661,'atalho-admin','POST','/core/workshop/orders/:id/move','resolveWorkshopScope(req) → moveOrder({ workshopId })',SCOPE_G,'workshop.orders.move','bancada', scopeNota(''));
r(9667,'atalho-admin','POST','/core/workshop/orders/:id/move','isManagerProfile(req) → moveOrder({ isManager })',SCOPE_G,'workshop.admin','bancada',
 isMgrNota('Libera a trava de responsável no moveOrder: quem não é o técnico responsável não move a OS assumida.'));
r(9694,'rota','POST','/core/workshop/orders/:id/release',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.orders.assume','bancada',
 'Largar a OS. O caixa fica de fora de propósito (core.ts:9689-9690).');
r(9707,'atalho-admin','POST','/core/workshop/orders/:id/release','resolveWorkshopScope(req) → releaseOrder({ workshopId })',SCOPE_G,'workshop.orders.assume','bancada',
 scopeNota('O comentário core.ts:9696-9704 registra o antigo furo do resolveWorkshop(req,false) → null.'));
r(9712,'atalho-admin','POST','/core/workshop/orders/:id/release','isManagerProfile(req) → releaseOrder({ isManager })',SCOPE_G,'workshop.admin','bancada',
 isMgrNota('O gerente larga a OS de outro técnico (remanejamento).'));
r(9736,'rota','POST','/core/workshop/orders/:id/regularizar',"requireProfile(req, 'gerente_oficina')",P('O'),'workshop.admin','bancada',
 'Só a gestão da oficina (core.ts:9728-9733); o gerente_loja fica fora. Pode trocar a OS de bancada (workshopId no corpo, core.ts:9746) dentro do alcance (linha 9740). Audita antes/depois (core.ts:9748-9763).');
r(9740,'atalho-admin','POST','/core/workshop/orders/:id/regularizar','resolveWorkshopScope(req) → regularizarOs({ alcance })',SCOPE_G,'workshop.admin','bancada', scopeNota('Quem chega aqui já é gerente/dono, logo vê todas.'));
r(9777,'rota','PATCH','/core/workshop/orders/:id/plan',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.orders.plan','bancada',
 'Prioridade e prazo. O responsável replaneja o seu serviço, o gerente replaneja qualquer um (core.ts:9770-9774).');
r(9782,'atalho-admin','PATCH','/core/workshop/orders/:id/plan','resolveWorkshopScope(req) → setOrderPlan({ workshopId })',SCOPE_G,'workshop.orders.plan','bancada', scopeNota(''));
r(9788,'atalho-admin','PATCH','/core/workshop/orders/:id/plan','isManagerProfile(req) → setOrderPlan({ isManager })',SCOPE_G,'workshop.admin','bancada',
 isMgrNota('O gerente replaneja a OS de qualquer técnico.'));
r(9812,'rota','GET','/core/workshop/orders/:id/photos',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada',
 'Fotos da OS, com link assinado que vale 1 h (core.ts:9816-9822).');
r(9815,'atalho-admin','GET','/core/workshop/orders/:id/photos','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.kanban.view','bancada', scopeNota('Fora do alcance: 404.'));
r(9831,'rota','POST','/core/workshop/orders/:id/photos',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')",P('M,O,CO,T'),'workshop.orders.open','bancada',
 'Subir a foto é de quem recebe o aparelho: bancada e balcão da oficina.');
r(9833,'atalho-admin','POST','/core/workshop/orders/:id/photos','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.orders.open','bancada', scopeNota(''));
r(9860,'rota','DELETE','/core/workshop/orders/:id/photos/:photoId',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.orders.plan','bancada',
 'O catálogo agrupa "remoção de foto" em workshop.orders.plan porque os perfis coincidem ({M,O}+donos), não pela semântica. Um técnico que planeja e não pode apagar prova exigiria uma capability à parte, que não é necessária no dia 1.');
r(9862,'atalho-admin','DELETE','/core/workshop/orders/:id/photos/:photoId','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.orders.plan','bancada', scopeNota(''));
r(9884,'rota','GET','/core/workshop/orders/:id/checklist',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.kanban.view','bancada','Conferência de entrada da OS (leitura).');
r(9886,'atalho-admin','GET','/core/workshop/orders/:id/checklist','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.kanban.view','bancada', scopeNota(''));
r(9900,'rota','PATCH','/core/workshop/orders/:id/checklist/:itemId',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')",P('M,O,CO,T'),'workshop.orders.open','bancada',
 'Quem confere é quem recebe o aparelho (core.ts:9899).');
r(9902,'atalho-admin','PATCH','/core/workshop/orders/:id/checklist/:itemId','resolveWorkshopScope(req) → getOrderDetail(companyId, alcance, id)',SCOPE_G,'workshop.orders.open','bancada', scopeNota(''));
r(9926,'rota','GET','/core/workshop/sla',"requireProfile(req, 'gerente_oficina')",P('O'),'workshop.admin','bancada',
 'A leitura da régua é só da gerência da oficina, mas o quadro recebe a mesma matriz em GET /workshop/orders (core.ts:9494), então não é segredo. ESQUISITO de escopo: no catálogo, workshop.admin tem escopo "bancada", mas o SLA vale para a EMPRESA inteira (getSlaConfig(companyId), core.ts:9928). Um gerente de oficina restrito a uma bancada leria e editaria a régua de todas.');
r(9936,'rota','PUT','/core/workshop/sla',"requireProfile(req, 'gerente_oficina')",P('O'),'workshop.admin','bancada',
 'Mesma observação de escopo da linha 9926: a régua é da empresa (saveSlaConfig/resetSlaConfig(companyId), core.ts:9939-9941), e a capability é de bancada. Audita workshop.sla.update (core.ts:9942-9949).');
r(9958,'rota','POST','/core/workshop/orders/:id/comments',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')",P('M,O,CO,T'),'workshop.orders.open','bancada',
 'Comentário na OS, com o alcance do quadro (core.ts:9960-9969). A voz de quem fala é decidida na linha 9976.');
r(9972,'atalho-admin','POST','/core/workshop/orders/:id/comments','resolveWorkshopScope(req) → addComment({ workshopId })',SCOPE_G,'workshop.orders.open','bancada', scopeNota(''));
r(9976,'atalho-admin','POST','/core/workshop/orders/:id/comments','vozNaOs(req) → addComment({ authorKind })',SCOPE_G,'workshop.admin','bancada',
 "vozNaOs (core.ts:7407-7410) dá três vozes: 'gestor' para isManagerProfile (admin_geral/gestor/gerente_oficina, atalho); 'tecnico' para o código 'mecanico'; 'balcao' para o resto (operador_caixa_oficina, atendente). A voz decide a autoria e a trava de responsável. Tradução exata (§7.3): workshop.admin → gestor; senão workshop.orders.assume → técnico; senão balcão.");
r(9988,'rota','POST','/core/workshop/orders/:id/parts',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.parts.use','bancada',
 'Lança peça na OS. Audita workshop.order.part (core.ts:10003-10010).');
r(9993,'atalho-admin','POST','/core/workshop/orders/:id/parts','resolveWorkshopScope(req) → addPart({ workshopId })',SCOPE_G,'workshop.parts.use','bancada', scopeNota(''));
r(9999,'atalho-admin','POST','/core/workshop/orders/:id/parts','isManagerProfile(req) → addPart({ isManager })',SCOPE_G,'workshop.admin','bancada',
 isMgrNota('Assina como gestão a queda da aprovação quando a peça muda um total já aceito (core.ts:9996-9999).'));
r(10019,'rota','POST','/core/workshop/orders/:id/labor',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.labor.manage','bancada','Mão de obra da OS.');
r(10025,'atalho-admin','POST','/core/workshop/orders/:id/labor','resolveWorkshopScope(req) → setLabor({ workshopId })',SCOPE_G,'workshop.labor.manage','bancada', scopeNota(''));
r(10031,'atalho-admin','POST','/core/workshop/orders/:id/labor','isManagerProfile(req) → setLabor({ isManager })',SCOPE_G,'workshop.admin','bancada',
 isMgrNota('Faz o mesmo papel que no lançamento de peça (core.ts:10028-10031).'));
r(10046,'rota','POST','/core/workshop/orders/:id/pedir-aprovacao',"requireProfile(req, 'mecanico', 'gerente_oficina', 'atendente')",P('M,O,T'),'workshop.quote.request','bancada',
 'O atendente entra porque é ele quem fala com o cliente (core.ts:10040-10043).');
r(10051,'atalho-admin','POST','/core/workshop/orders/:id/pedir-aprovacao','resolveWorkshopScope(req) → pedirAprovacaoOrcamento({ workshopId })',SCOPE_G,'workshop.quote.request','bancada', scopeNota(''));
r(10055,'servico','POST','/core/workshop/orders/:id/pedir-aprovacao',"isManager: !profiles.includes('mecanico')",['admin_geral','gestor','gerente_oficina','atendente'],'workshop.orders.assume','bancada', notMecNota);
r(10083,'rota','POST','/core/workshop/orders/:id/decidir-orcamento',"requireProfile(req, 'mecanico', 'gerente_oficina', 'atendente')",P('M,O,T'),'workshop.quote.request','bancada',
 'O "sim" por telefone registrado no balcão, com auditoria workshop.order.budget_decision (core.ts:10108-10120). Espelha os perfis do pedir-aprovação.');
r(10097,'atalho-admin','POST','/core/workshop/orders/:id/decidir-orcamento','resolveWorkshopScope(req) → decidirOrcamentoNoBalcao({ workshopId })',SCOPE_G,'workshop.quote.request','bancada', scopeNota(''));
r(10105,'servico','POST','/core/workshop/orders/:id/decidir-orcamento',"isManager: !profiles.includes('mecanico')",['admin_geral','gestor','gerente_oficina','atendente'],'workshop.orders.assume','bancada', notMecNota);
r(10130,'rota','POST','/core/workshop/orders/:id/complete',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.orders.complete','bancada',
 'Conclusão técnica: se tiver custo, a OS vai para AGUARDANDO PAGAMENTO. Aceita forcarChecklist (core.ts:10142-10144).');
r(10135,'atalho-admin','POST','/core/workshop/orders/:id/complete','resolveWorkshopScope(req) → completeTechnical({ workshopId })',SCOPE_G,'workshop.orders.complete','bancada', scopeNota(''));
r(10176,'rota','GET','/core/workshop/pending-payment',"requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina')",P('CO,O'),'workshop.checkout','bancada',
 'Fila de dinheiro do caixa da oficina, pelo botão "OS a receber" do PDV (core.ts:10160-10173).');
r(10178,'atalho-admin','GET','/core/workshop/pending-payment','resolveWorkshopScope(req) → filaDeRecebimento(companyId, alcance)',SCOPE_G,'workshop.checkout','bancada',
 scopeNota('O caixa da oficina não é membro de bancada e vê a empresa inteira pelo fallback (core.ts:10170-10172). O passo 86 preserva isso com all_workshops=1.'));
r(10199,'rota','POST','/core/workshop/orders/:id/checkout',"requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina')",P('CO,O'),'workshop.checkout','bancada',
 'ESQUISITO: o checkout NÃO aplica o recorte de bancada. receberOs recebe só companyId e orderId (core.ts:10204-10218), ao contrário das rotas vizinhas, que passam resolveWorkshopScope. Hoje não vaza, porque CO não é membro (fallback = empresa) e O vê todas. Mas se workshop.checkout, que tem escopo "bancada", for dado a alguém restrito a uma bancada, essa pessoa cobraria OS de outra. Falta passar bancadasDoVinculo ao serviço (fatia d). O caixa e a alçada estão nas linhas 10212 e 10217.');
r(10212,'servico','POST','/core/workshop/orders/:id/checkout','terminalId: req.body?.terminalId ?? req.auth?.storeId ?? null → createSale → assertTerminalDaEmpresa',P('CO,O'),'pdv.cash.operate','pdv',
 'FALLBACK PERIGOSO: o caixa do recebimento é req.body.terminalId ?? req.auth.storeId (core.ts:10212), ou seja, o CORPO vence o TOKEN. É o contrário de terminalDoPedido (TerminalRegistry.ts:92-111), em que o token vence e a divergência dá 409. createSale só confere a empresa (assertTerminalDaEmpresa, SalesService.ts:708). Assim, uma máquina com token do Caixa 1 registra o recebimento no Caixa 2. O desenho §6.3 NÃO lista esta rota entre os pontos de requireTerminalNoEscopo, e ela tem de entrar: é venda com gaveta. Capability de referência: pdv.cash.operate (CO e O a têm no dia 1, então nada estreita). O resto da rota segue com workshop.checkout.');
r(10217,'atalho-admin','POST','/core/workshop/orders/:id/checkout','alcada: { profileCodes: profiles } → createSale → discountNeedsAuthorization → temAlcadaParaLiberar',['admin_geral','gestor','gerente_oficina'],'approval.discount','empresa',
 'createSale → discountNeedsAuthorization → temAlcadaParaLiberar (SalesService.ts:1230-1238; AuthorizationService.ts:21, 130-132, 775-789). Os AUTHORIZERS (admin_geral, gestor, gerente_loja, gerente_oficina) concedem desconto acima do limite sem bilhete. É o atalho #13, que vira can("approval.discount") (§10). Como nesta rota só passam CO, O e donos, gerente_oficina e donos fazem direto, e o CO precisa do bilhete de um gestor, consumido na transação da venda.');
r(10269,'rota','POST','/core/workshop/orders/:id/estorno',"requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina')",P('CO,O'),'workshop.checkout','bancada',
 'Estorna o recebimento de OS paga. Quem faz direto é decidido na linha 10283. ESQUISITO: como no checkout, não há recorte de bancada (vendaAEstornar(companyId, orderId), core.ts:10281). A rota também não passa por terminalDoPedido (core.ts:10267-10318). O desenho §6.3 lista o cancelamento de venda (core.ts:6259), mas não este estorno, que também desfaz título e gaveta: é preciso conferir se estornarRecebimentoDaOs precisa do escopo de caixa. Audita workshop.order.reversal com o IP (core.ts:10297-10312).');
r(10283,'atalho-admin','POST','/core/workshop/orders/:id/estorno',"comLiberacaoPontual(req, { perfisQuePodemDireto: ['gerente_oficina'], action: 'cancelar_venda', refId: saleId })",['admin_geral','gestor','gerente_oficina'],'workshop.checkout.refund','bancada',
 "comLiberacaoPontual (core.ts:6200-6240) deixa fazer direto quem é admin_geral/gestor (atalho em core.ts:6213-6217, #14) ou está em perfisQuePodemDireto=['gerente_oficina'] (core.ts:10286). O caixa da oficina precisa de um bilhete cancelar_venda preso à venda; sem ele, 403 CORE_CANCEL_NEEDS_AUTHORIZATION. Vira capabilityDireta = workshop.checkout.refund (§10), e quem libera precisa de approval.sale_cancel no vínculo da empresa (AuthorizationService.ts:284-314). ESQUISITO: o gerente_loja pode LIBERAR este estorno para o caixa, porque está em AUTHORIZERS (AuthorizationService.ts:21), mas não o faz direto e nem passa no guarda da rota.");

// ---------------- equipamentos
r(10330,'rota','GET','/core/equipment',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.equipment.view','bancada',
 'Lista de equipamentos. O public_token da plaquinha é tirado de cada item (core.ts:10383). O recorte de bancada fica na linha 10332.');
r(10332,'atalho-admin','GET','/core/equipment','resolveWorkshop(req, false) → recorte.workshopId',SCOPE_G,'workshop.equipment.view','bancada',
 'resolveWorkshop (core.ts:7284-7328; atalho em 7290-7293) não tem fallback: o não-membro que pede ?workshopId= toma 403. Sem workshopId, com mais de uma bancada no alcance (ou nenhuma), a função devolve null e a lista sai SEM filtro de bancada (core.ts:10351-10354). ESQUISITO: o mecânico de 2 bancadas, numa empresa com 3, vê o equipamento das 3. É o "funciona por acidente" que o comentário de resolveWorkshopScope descreve (core.ts:7335-7340). Vira bancadasDoVinculo, que é lista e não "uma ou nenhuma". É um dos 5 pontos da mudança D3 (§7.2).');
r(10394,'rota','POST','/core/equipment',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')",P('M,O,CO,T'),'workshop.orders.open','bancada',
 'Cadastro da máquina, com a mesma régua de quem abre OS. O token do QR não sai na resposta (core.ts:10438-10449).');
r(10398,'atalho-admin','POST','/core/equipment','resolveBancadaDeEntrada(req) → bancadaDeEntrada',['admin_geral','gestor','gerente_oficina','atendente','operador_caixa_oficina'],'workshop.orders.open','bancada',
 'É a régua da linha 9592 (WorkshopIntakeService.ts:42-119, com o atalho GESTAO_DA_OFICINA). Vira bancadasDoVinculo.');
r(10469,'rota','GET','/core/equipment/:id',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.equipment.view','bancada',
 'ESQUISITO: a ficha NÃO tem recorte de bancada. fichaDoEquipamento filtra só por empresa (EquipmentService.ts:676-681), então o mecânico de uma bancada lê, pelo id, a máquina de outra, que a lista (linha 10332) e o quadro lhe escondem. A ficha também devolve ownerPhone (core.ts:10485-10496) a M e E, que não têm customers.contact.view: é o mesmo ponto de contato de GET /workshop/orders/:id. Como workshop.equipment.view tem escopo bancada, falta aplicar bancadasDoVinculo aqui (fatia d).');
r(10521,'rota','PATCH','/core/equipment/:id',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.equipment.manage','bancada',
 'Garantia e montagem. Tem a mesma lacuna da ficha: sem recorte de bancada, só por empresa. Audita equipment.update.');
r(10571,'rota','PATCH','/core/equipment/:id/identidade',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.equipment.manage','bancada',
 'Corrige chassi, motor, série e o resto, com motivo e antes/depois no histórico (core.ts:10581-10594). Sem recorte de bancada.');
r(10614,'rota','GET','/core/equipment/:id/photos',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'workshop.equipment.view','bancada',
 'Sem recorte de bancada: listEquipmentPhotos filtra por empresa (EquipmentPhotoService.ts:70). Link assinado de 1 h.');
r(10630,'rota','POST','/core/equipment/:id/photos',"requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente')",P('M,O,CO,T'),'workshop.orders.open','bancada',
 'Sem recorte de bancada, diferente de POST /workshop/orders/:id/photos (core.ts:9833), que confere a OS pelo alcance. Tem a mesma régua de quem recebe a máquina (core.ts:10607-10611).');
r(10658,'rota','DELETE','/core/equipment/:id/photos/:photoId',"requireProfile(req, 'mecanico', 'gerente_oficina')",P('M,O'),'workshop.equipment.manage','bancada',
 'Apagar é da bancada (core.ts:10607-10611). Sem recorte de bancada.');
r(10681,'rota','POST','/core/equipment/:id/owner',"requireProfile(req, 'gerente_oficina', 'operador_caixa_loja', 'gerente_loja')",P('O,CL,L'),'workshop.equipment.owner','empresa',
 'Registra o comprador como dono: o caixa da LOJA vende a moto. operador_caixa_oficina e operador_caixa (legado) ficam FORA. O escopo empresa do catálogo é coerente, porque a rota não recorta bancada. Audita equipment.sold.');
r(10725,'rota','POST','/core/equipment/:id/owner/desfazer',"requireProfile(req, 'gerente_oficina')",P('O'),'workshop.admin','bancada',
 'Desfaz a "venda à mão" da plaquinha (core.ts:10714-10722). Só a gerência da oficina: o gerente_loja registra o dono (linha 10681), mas não desfaz. workshop.admin tem escopo bancada, e a rota não confere a bancada do equipamento: é o mesmo descompasso do SLA.');

// ---------------- etiquetas e reprecificação
r(10781,'rota','POST','/core/products/:id/barcode',"requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja')",P('L,O,E,CL'),'labels.products.print','empresa',
 'Grava EAN-13 no cadastro (auditoria product.barcode.generate). Inclui operador_caixa_loja; exclui atendente, operador_caixa_oficina e operador_caixa.');
r(10803,'rota','POST','/core/labels/products',"requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja')",P('L,O,E,CL'),'labels.products.print','empresa',
 'Dados das etiquetas comerciais (leitura, mas com o guarda da impressão). labels.products.print = {L,O,E,CL}+donos, igual.');
r(10825,'rota','GET','/core/labels/catalog',"abertaAo(req, 'balcao', 'bancada', 'escritorio')",P(TRES),'qualquer(pdv.sell, products.view, workshop.kanban.view)','empresa',
 'Tabela fixa (origens, formatos, modos), sem nenhum dado da empresa (core.ts:10820-10823). A expressão composta do mapa existe só para manter o contador de fora, como o abertaAo faz hoje: SO_AUTENTICADO alargaria ao contador (desvio). A união das três capabilities = todos menos contador, igual.');
r(10848,'rota','GET','/core/labels/candidates',"abertaAo(req, 'escritorio')",P('L,O,E,T'),'products.view','empresa',
 'PORTA QUE BATE NA CARA: a rota abre ao atendente (escritório inteiro), mas a folha (POST /labels/sheet, linha 10902) não o aceita. O próprio comentário diz que "a folha esqueceu o atendente" (core.ts:10843-10846): ele abre Etiquetas, escolhe e toma 403 no Imprimir. Do outro lado, o operador_caixa_loja imprime a folha, mas não lista candidatos. Dia 1 igual com products.view; se o atendente deve imprimir, a decisão é dar labels.products.print ao modelo dele.');
r(10879,'rota','POST','/core/labels/candidates/codes',"abertaAo(req, 'escritorio')",P('L,O,E,T'),'products.view','empresa',
 'É POST, mas só LÊ (core.ts:10873-10878). Tem o mesmo alcance e a mesma porta que bate na cara de /labels/candidates.');
r(10902,'rota','POST','/core/labels/sheet',"requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja')",P('L,O,E,CL'),'labels.products.print','empresa',
 'Grava EAN-13 em lote, até 1000 (core.ts:10892-10917). O atendente fica fora, e isso é a porta que bate na cara vista em /labels/candidates (linha 10848). Audita label.sheet.');
r(10958,'rota','GET','/core/purchases/notes/:id/repricing',"requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')",P('L,O,E'),'purchases.view','empresa',
 'Sugestão de preço depois da entrada da nota. purchases.view = {L,O,E}+donos, igual.');
r(10969,'rota','POST','/core/purchases/repricing/apply',"requireProfile(req, 'gerente_loja', 'gerente_oficina')",P('L,O'),'products.price.manage','empresa',
 'Aplica o preço. Só L e O; o estoquista vê a sugestão (linha 10958), mas não aplica, o que é coerente. Audita purchase.repricing.apply.');

// ---------------- conferências
const cat = require(path.join(__dirname, 'catalogo.json'));
const codes = new Set(cat.map(c => c.code));
const probs = [];
for (const s of out) {
  const cs = s.capability.startsWith('qualquer(') ? s.capability.slice(9, -1).split(',').map(x => x.trim()) : [s.capability];
  for (const c of cs) if (!codes.has(c)) probs.push('cap desconhecida ' + c + ' @' + s.linha);
}
const mapa = fs.readFileSync(path.join(__dirname, 'mapa-rota-capability.tsv'), 'utf8').split('\n').slice(1)
  .map(l => l.split('\t')).filter(x => x[0] === 'core.ts' && ((+x[1] >= 8801 && +x[1] <= 11000) || +x[1] === 8800));
const rotas = out.filter(s => s.tipo === 'rota');
for (const m of mapa) {
  const s = rotas.find(x => x.metodo === m[2] && x.caminho === '/core' + m[3]);
  if (!s) { probs.push('rota do mapa ausente ' + m[1] + ' ' + m[2] + ' ' + m[3]); continue; }
  const exp = m[5] === 'DONOS' ? [...D] : [...D, ...m[5].split(',').map(x => AB[x])];
  const a = [...s.perfis_hoje].sort().join(','), b = exp.sort().join(',');
  if (a !== b) probs.push('perfis divergem ' + s.linha + ' ' + a + ' != ' + b);
  if (s.capability !== m[6]) probs.push('cap diverge do mapa ' + s.linha + ' ' + s.capability + ' != ' + m[6]);
}
for (const s of rotas) if (!mapa.find(m => m[2] === s.metodo && '/core' + m[3] === s.caminho)) probs.push('rota fora do mapa ' + s.linha);
console.log('rotas no mapa (fatia+8800):', mapa.length, '| rotas no arquivo:', rotas.length, '| total sites:', out.length);
console.log('tipos:', JSON.stringify(out.reduce((a, s) => (a[s.tipo] = (a[s.tipo] || 0) + 1, a), {})));
console.log('problemas:', probs.length ? probs : 'nenhum');
fs.writeFileSync(path.join(__dirname, 'sites-core-5.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
