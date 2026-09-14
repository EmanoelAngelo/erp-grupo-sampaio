// Gera sites-outros-roteadores.json — fatia "outros-roteadores".
// Só lê: devora-int-b (int/b, fb4c111) já foi lido à mão; este script só monta o JSON,
// recalcula perfis_hoje pela réplica de Permissions.ts e confere contra catalogo.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const catalogo = JSON.parse(readFileSync(join(AQUI, 'catalogo.json'), 'utf8'));
const CAPS = new Map(catalogo.map((c) => [c.code, c]));

const DONOS = ['admin_geral', 'gestor'];
const TODOS = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
const ORDEM = new Map(TODOS.map((p, i) => [p, i]));
const ord = (l) => [...new Set(l)].sort((a, b) => (ORDEM.get(a) ?? 99) - (ORDEM.get(b) ?? 99));

// ---- réplica exata de server/src/services/auth/Permissions.ts:40-165
const ACOES_DE_LEITURA = new Set(['view', 'list', 'status', 'health', 'readiness', 'preview', 'export']);
const MODULOS = {
  fiscal: { ler: ['estoquista', 'atendente', 'gerente_oficina'], escrever: ['gerente_loja'] },
  'payment-terminal': { ler: ['atendente'], escrever: ['gerente_loja', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'] },
  crm: { ler: ['estoquista'], escrever: ['gerente_loja', 'atendente'] },
  'corporate-bi': { ler: ['gerente_loja', 'gerente_oficina'], escrever: [] },
  logistics: { ler: ['atendente'], escrever: ['gerente_loja', 'estoquista'] },
  asaas: { ler: ['atendente'], escrever: ['gerente_loja'] },
  api: { ler: [], escrever: [] },
  'system-release': { ler: [], escrever: [] },
  'system-recovery': { ler: [], escrever: [] },
  'system-reconciliation': { ler: [], escrever: [] },
  'system-readiness': { ler: [], escrever: [] },
  'system-homologation': { ler: [], escrever: [] },
  'system-health': { ler: [], escrever: [] },
  'system-backup': { ler: [], escrever: [] },
};
function alcancePermissao(perm) {
  const partes = perm.split('.');
  const regra = MODULOS[partes[0]];
  if (!regra) return [...DONOS];
  const leitura = ACOES_DE_LEITURA.has(partes[partes.length - 1]);
  return ord([...DONOS, ...(leitura ? [...regra.ler, ...regra.escrever] : regra.escrever)]);
}
const alcancePerfis = (...lista) => ord([...DONOS, ...lista]);
const inter = (a, b) => ord(a.filter((x) => b.includes(x)));

const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'];
const GERENCIA = ['gerente_loja', 'gerente_oficina'];
const GERENCIA_DA_MAQUININHA = ['gerente_loja', 'gerente_oficina'];

// capabilities referidas por uma expressão (código, qualquer(...), todas(...))
function capsDaExpr(expr) {
  const m = /^(qualquer|todas)\((.*)\)$/.exec(expr);
  return m ? m[2].split(',').map((s) => s.trim()) : [expr];
}
function alcanceDaExpr(expr) {
  const m = /^(qualquer|todas)\((.*)\)$/.exec(expr);
  const conj = capsDaExpr(expr).map((c) => CAPS.get(c)?.perfis_de_hoje ?? []);
  if (!m || m[1] === 'qualquer') return ord(conj.flat());
  return ord(conj.reduce((a, b) => a.filter((x) => b.includes(x))));
}

const sites = [];
const R = 'server/src/routes/v1/';
const MW = 'server/src/middleware/auth.ts';

/**
 * Rota guardada: calcula perfis_hoje, confere a equivalência dia-1 e anexa à nota.
 */
function rota({ arquivo, linha, metodo, caminho, guarda, perfis, capability, escopo = 'empresa', nota }) {
  const novo = alcanceDaExpr(capability);
  const igual = novo.length === perfis.length && novo.every((p, i) => p === perfis[i]);
  const eq = igual
    ? 'Equivalência dia-1: igual (conjunto de perfis de hoje = perfis_de_hoje da capability no catálogo).'
    : `Equivalência dia-1: DESVIO — hoje ${JSON.stringify(perfis)}, com a capability ${JSON.stringify(novo)}.`;
  sites.push({ arquivo, linha, tipo: 'rota', metodo, caminho, guarda_hoje: guarda, perfis_hoje: perfis, capability, escopo, nota: `${nota} ${eq}` });
}
function publica({ arquivo, linha, metodo, caminho, guarda, perfis = ['anonimo'], escopo = 'grupo', nota }) {
  sites.push({ arquivo, linha, tipo: 'publica', metodo, caminho, guarda_hoje: guarda, perfis_hoje: perfis, capability: 'PUBLICA', escopo, nota });
}
function outro(obj) {
  sites.push(obj);
}

// =====================================================================================
// MIDDLEWARE — server/src/middleware/auth.ts
// =====================================================================================
outro({
  arquivo: MW, linha: 65, tipo: 'servico',
  guarda_hoje: "autenticar(): const emVigor = conferirContaDaSessao(doToken); req.auth = { ...doToken, profileCodes: emVigor.profileCodes }; X-Perfil-Em-Vigor se mudou (auth.ts:65-69)",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Ponto ÚNICO onde a sessão vira "o perfil do vínculo de agora" (ContaDaSessao.ts:95-117) em toda rota com authMiddleware, autenticacaoDaEtapaDeTroca ou autenticacaoDaSaida. É aqui que entra req.auth.acesso = {vinculoId, modelo, capabilities, terminais, bancadas, carimbo} (desenho §5.2) e o cabeçalho X-Acesso-Em-Vigor ao lado de X-Perfil-Em-Vigor (linha 49). Não decide capability; decide "conta ativa + session_version + vínculo existe". Não confere core_companies.active (sessão em empresa desativada segue valendo: mudança D2 do desenho entra nesta mesma consulta). Tem de continuar relendo do banco a cada requisição: capability NÃO viaja no JWT (GAP-PRD-053).',
});
outro({
  arquivo: MW, linha: 74, tipo: 'servico',
  guarda_hoje: "if (req.auth.senhaProvisoria === true && !aceitaSenhaProvisoria) → 403 API_PASSWORD_CHANGE_REQUIRED",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Recusa em TODA rota com authMiddleware a sessão emitida com a senha provisória (GAP-PRD-202); só /auth/password, /auth/session e /auth/logout aceitam (autenticacaoDaEtapaDeTroca/autenticacaoDaSaida, linhas 98-136). Independe de perfil e de capability — continua como está e vale também para o admin inicial do bootstrap (desenho §8). FURO relacionado, fora deste middleware: POST /auth/device/login (auth.ts:410-416) e POST /auth/quick-login (auth.ts:706-711) emitem sessão SEM senhaProvisoria, então a marca não os alcança (ver os sites dessas rotas).',
});
outro({
  arquivo: MW, linha: 98, tipo: 'servico',
  guarda_hoje: 'autenticacaoDaEtapaDeTroca = autenticar(req, res, true) — aceita o token da senha provisória',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Autenticação SEM guarda de alcance, nomeada na linha das rotas da etapa de troca (POST /auth/password auth.ts:296, GET /auth/session auth.ts:869). Não recebe capability: qualquer vínculo precisa trocar a própria senha e ler a própria sessão. Na F1, GET /auth/session passa a devolver access (desenho §5.3), sem mudar esta função.',
});
outro({
  arquivo: MW, linha: 119, tipo: 'servico',
  guarda_hoje: 'autenticacaoDaSaida = etapa de troca; se 401 e o corpo traz refreshToken, segue SEM req.auth',
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Só POST /auth/logout (auth.ts:855). O caminho sem access só revoga pela família do refresh e responde 204 fixo, com teto de taxa próprio (auth.ts:837-853). Nada a traduzir para capability.',
});
outro({
  arquivo: MW, linha: 156, tipo: 'atalho-admin',
  guarda_hoje: "requirePermission(permission) → temPermissao(req.auth?.profileCodes, permission) (Permissions.ts:153-165: `if (perfis.some(p => RESPONDEM_POR_TUDO.includes(p))) return true`, RESPONDEM_POR_TUDO = ['admin_geral','gestor'] em Permissions.ts:51)",
  perfis_hoje: DONOS,
  capability: 'qualquer(integrations.card_terminal.view, integrations.card_terminal.operate, integrations.card_terminal.manage, logistics.view, logistics.manage, integrations.asaas.view, integrations.asaas.manage, system.status.view, system.deploy.view, system.deploy.manage, system.backup.view, system.backup.manage, devices.view, devices.manage)',
  escopo: 'empresa',
  nota: 'O MECANISMO, não uma rota: é o guarda por argumento dos roteadores de fora de core.ts. São 76 chamadas vivas, todas nesta fatia (payment-terminals.ts 31, logistics.ts 23, index.ts 10, system-admin.ts 9, auth.ts 3), uma por rota; core.ts não chama (o único requirePermission( lá é comentário, core.ts:16506, e o 11º de index.ts também, index.ts:173). O desenho (§4.2) diz 83 e usa 83 na base da catraca: o número medido é 76, e a catraca tem de partir dele. perfis_hoje aqui = os que passam pelo ATALHO (Permissions.ts:154), que vale para qualquer permissão, inclusive de módulo não declarado. A "capability" listada é a UNIÃO das 14 que os chamadores passam a cobrar — não é expressão para guardar nada. Destino (desenho §4.2): na F1 vira tradutor por tabela estática PERMISSAO_PARA_CAPABILITY (exata, derivada desta fatia) e o atalho sai do tradutor; depois cada chamada vira comCapability(\'<code>\') e a função morre na F5. ATENÇÃO na tabela: a interseção com GERENCIA_DA_MAQUININHA dentro dos handlers de payment-terminals.ts (11 rotas) NÃO pode ser embutida pela permissão sozinha — payment-terminal.settings.manage cobre ao mesmo tempo rotas de caixa (GET /local-agent/status, GET /local-agents → operate) e de gerência (POST /local-agent/pairing → manage); o tradutor tem de ser por ROTA, não por string de permissão. Idem homologation.run (GET → operate, POST → manage) e transaction.create (POST /transactions → operate, POST /providers/:p/test-transaction → manage).',
});
outro({
  arquivo: MW, linha: 192, tipo: 'servico',
  guarda_hoje: "rotaPublica(motivo) — no-op em execução; o lint rota-declara-alcance exige motivo literal",
  perfis_hoje: ['anonimo'], capability: 'PUBLICA', escopo: 'grupo',
  nota: 'Declaração, não guarda: 90 rotas, TODAS nesta fatia (storefront 64, auth 12 — 4 delas autenticadas —, payment-terminals 7, index 5, logistics 1, system-admin 1); core.ts não usa rotaPublica. ESQUISITO a manter em mente: rotaPublica também é usada em rotas AUTENTICADAS para dizer "sem guarda de ALCANCE de propósito" (auth.ts:296, 855, 869, 895) — no desenho novo, essas quatro seriam melhor declaradas por um marcador próprio (ex.: soAutenticado(\'motivo\')), para que "PUBLICA" no inventário signifique sem sessão. Não muda comportamento.',
});
outro({
  arquivo: MW, linha: 206, tipo: 'servico',
  guarda_hoje: "requireCompanyScope: companyId de params/body/query ≠ req.auth.companyId → 403 API_TENANT_MISMATCH",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'SEM CHAMADOR (nenhuma rota da árvore a usa; RBAC-SERVIDOR.md). Proteção que parece existir e não existe: não pode ser citada como escopo de empresa. Destino: apagar na F5, ou reescrever como helper do escopo de empresa do vínculo. Não mapeia capability.',
});

// =====================================================================================
// auth.ts (montado em /auth) — 15 rotas
// =====================================================================================
const A = R + 'auth.ts';
publica({ arquivo: A, linha: 129, metodo: 'POST', caminho: '/auth/login', escopo: 'empresa',
  guarda: "rotaPublica('login: quando esta rota roda ainda não existe sessão — a credencial é a senha')",
  nota: 'Sem sessão: a credencial é a senha (Argon2id, lockout por login+origem). Decisões de ESCOPO dentro do handler: recusa tenant de consolidação (auth.ts:138-144), exige ≥1 vínculo em empresa ativa (174-182; listMemberships filtra c.active=1, IdentityService.ts:71) e a empresa pedida tem de estar entre os vínculos (186-191) — ver o site "servico" da linha 186. Emite profileCodes:[profile_code] (211); no desenho a resposta ganha access e companies[].modelo (§5.3).' });
outro({ arquivo: A, linha: 186, tipo: 'servico', metodo: 'POST', caminho: '/auth/login',
  guarda_hoje: "selected = companyId ? memberships.find(m => m.company_id === companyId) : memberships[0]; sem selected → 403 API_TENANT_MISMATCH",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'ESCOPO DE EMPRESA no login: a sessão só nasce numa empresa em que a pessoa tem vínculo (qualquer modelo). Continua valendo igual no modelo novo — é a camada USUÁRIO → ESCOPO DE EMPRESA. Detalhe a decidir na F1: um vínculo cujo modelo resolve para ZERO capabilities (código sem modelo, §3.4) ainda entra e cai em /sem-acesso; o login não deve recusar por isso (o dono pode estar no meio de montar o acesso).' });
outro({ arquivo: A, linha: 296, tipo: 'rota', metodo: 'POST', caminho: '/auth/password',
  guarda_hoje: "autenticacaoDaEtapaDeTroca + rotaPublica('sem permissão de propósito: troca a senha da PRÓPRIA sessão…')",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Autenticada, sem guarda de alcance: troca a PRÓPRIA senha (sem :id), conferindo a senha atual. Sobe session_version (registrarTrocaDaPropriaSenha) e audita auth.password_change sem a senha (auth.ts:320-327) — já cumpre "sem senha" da auditoria pedida. No inventário do arquiteto aparece como PUBLICA; aqui é SO_AUTENTICADO porque exige token (middleware/auth.ts:98). Equivalência dia-1: igual.' });
publica({ arquivo: A, linha: 353, metodo: 'POST', caminho: '/auth/device/login', escopo: 'pdv',
  guarda: "rotaPublica('login de terminal: a credencial é o token de dispositivo…')",
  nota: 'Sem sessão: a credencial é o token de dispositivo (hash sha256 em core_device_tokens). Decisões dentro: token não revogado nem vencido (366-386), caixa do token ativo (389-395), conta ativa (397-400), vínculo na empresa do token (401-404). Emite storeId = terminal_id (413) com o profile_code do vínculo (414). FUROS a registrar: (1) a sessão NÃO leva senhaProvisoria (410-416) — o dono do token com senha provisória opera pela máquina sem passar pela troca (middleware/auth.ts:74 não o alcança); (2) nada limita o PERFIL do dono do token: um token registrado para um admin_geral dá sessão de administrador SEM SENHA naquela máquina. No desenho (§6.2) este é o ponto onde o caixa do token tem de estar no escopo de PDV do vínculo (403 API_TERMINAL_OUT_OF_SCOPE) — ver o site servico da linha 401.' });
outro({ arquivo: A, linha: 401, tipo: 'servico', metodo: 'POST', caminho: '/auth/device/login',
  guarda_hoje: "const membership = assertMembership(user.id, row.company_id); if (!membership) → 403 API_TENANT_MISMATCH (auth.ts:401-404); caixa ativo em 389-395",
  perfis_hoje: TODOS, capability: 'qualquer(pdv.sell, pdv.cash.operate, pdv.payment.charge)', escopo: 'pdv',
  nota: 'ESCOPO DE PDV da máquina: hoje só confere vínculo na empresa e caixa ativo — QUALQUER perfil (inclusive mecânico, contador e admin_geral) vira sessão de terminal. perfis_hoje = os 11. A expressão sugerida é MUDANÇA DELIBERADA (não é dia-1 igual): exigir que o dono do token tenha alguma capability de PDV E o caixa do token no escopo (requireTerminalNoEscopo, desenho §6.2). Hoje o cadastro (POST /auth/device/enroll) só é feito por admin_geral/gestor e só existe 0 caixa na loja, então o risco prático é baixo; sem a mudança, a regra do escopo de PDV tem um desvio pela máquina. Se o dono preferir manter o dia-1 exato, use SO_AUTENTICADO + requireTerminalNoEscopo (que no dia 1 passa para todos: all_terminals=1).' });
rota({ arquivo: A, linha: 457, metodo: 'POST', caminho: '/auth/device/enroll',
  guarda: "requirePermission('api.device.enroll')", perfis: alcancePermissao('api.device.enroll'),
  capability: 'devices.manage',
  nota: 'Módulo api = {ler:[],escrever:[]} (Permissions.ts:117): só os donos, pelo atalho. Decisões dentro: o usuário-alvo tem vínculo nesta empresa (464-466) e o caixa é desta empresa e ativo (471, assertTerminalDaEmpresa). ESQUISITO: o alvo pode ser QUALQUER perfil, inclusive admin_geral/gestor — cria o caminho sem senha para uma conta de administrador. No desenho (§6.2) o enroll recusa alvo sem o caixa no escopo; sugiro também recusar alvo sem capability de PDV (mesma régua do site auth.ts:401) e aplicar a hierarquia (§9: quem registra só registra para quem ele poderia administrar). Audita auth.device_enroll sem o token (495-503).' });
rota({ arquivo: A, linha: 526, metodo: 'GET', caminho: '/auth/devices',
  guarda: "requirePermission('api.device.list')", perfis: alcancePermissao('api.device.list'),
  capability: 'devices.view',
  nota: "'list' é ação de leitura, mas o módulo api tem ler=[] (Permissions.ts:117): só donos. Lista presa à empresa da sessão (538), sem token nem hash na resposta. A tela TerminaisPage mostra a seção só aos donos (RBAC-TELA-E-USUARIOS.md:77) — coerente." });
rota({ arquivo: A, linha: 595, metodo: 'POST', caminho: '/auth/device/:id/revoke',
  guarda: "requirePermission('api.device.revoke')", perfis: alcancePermissao('api.device.revoke'),
  capability: 'devices.manage',
  nota: 'Busca presa à empresa da sessão (598-603): id de outra empresa responde o mesmo 404. Audita auth.device_revoke com motivo (609-623). Revogar derruba o login da máquina; a sessão já emitida segue até o próximo refresh/expiração — no desenho, mudar o ESCOPO do usuário derruba na requisição seguinte (§5.1), mas revogar o token não derruba a sessão viva (limitação de hoje, não desta tradução).' });
publica({ arquivo: A, linha: 658, metodo: 'GET', caminho: '/auth/quick-login/users', escopo: 'grupo',
  guarda: "rotaPublica('atalho de DEV…') + 404 se DEVORA_DEV_QUICK_LOGIN !== 'true' ou não vem do loopback (auth.ts:660-662)",
  nota: 'Atalho de DESENVOLVIMENTO. Com a variável ligada e pedido do loopback, devolve TODAS as contas ativas das seis empresas com o profile_code de cada vínculo (663-681). Fica fora do RBAC por desenho; o item 1 da preparação para entrega manda REMOVER (rotas, UI, cliente), mantendo a recusa de subida com a variável em true (env.ts:529-540). Não deve ganhar capability — deve sumir.' });
publica({ arquivo: A, linha: 688, metodo: 'POST', caminho: '/auth/quick-login', escopo: 'grupo',
  guarda: "rotaPublica('atalho de DEV…') + 404 se desligado ou fora do loopback (auth.ts:690-692)",
  nota: 'Emite sessão de QUALQUER conta ativa, inclusive admin_geral, sem senha (706-711), e sem a marca senhaProvisoria (contorna GAP-PRD-202). Confere o vínculo (700-704), então pula a senha, não a autorização. REMOVER (item 1). Enquanto existir, é o único caminho que entra como Administrador do grupo sem credencial — nenhuma capability resolve isso.' });
publica({ arquivo: A, linha: 756, metodo: 'GET', caminho: '/auth/senha/recuperacao', escopo: 'grupo',
  guarda: "rotaPublica('a tela de login pergunta se oferece \"Esqueci minha senha\"…')",
  nota: 'Sem sessão; responde só se alguma operação ligou a recuperação e há SMTP. Quem LIGA a recuperação é users.password_recovery.manage (core.ts, fora da fatia).' });
publica({ arquivo: A, linha: 764, metodo: 'POST', caminho: '/auth/senha/esqueci', escopo: 'grupo',
  guarda: "rotaPublica('recuperação de senha: quem pede ainda não tem sessão…')",
  nota: 'Sem sessão; resposta fixa exista a conta ou não. A régua de quem pode recuperar mora em RecuperacaoDeSenhaDaEquipe (fora da fatia). Para a auditoria pedida: o reset por código deve gravar evento user.password_reset com origem "recuperacao", sem a senha (desenho §12).' });
publica({ arquivo: A, linha: 777, metodo: 'POST', caminho: '/auth/senha/recuperar', escopo: 'grupo',
  guarda: "rotaPublica('recuperação de senha: a credencial é o código de uso único…')",
  nota: 'Sem sessão; a credencial é o código de uso único enviado por e-mail, conferido no serviço.' });
publica({ arquivo: A, linha: 791, metodo: 'POST', caminho: '/auth/refresh', escopo: 'empresa',
  guarda: "rotaPublica('renovação de sessão: a credencial é o próprio refresh token do corpo…')",
  nota: 'Sem access: a credencial é o refresh. refreshSession relê conta, session_version e vínculo e o profile_code atual (ApiAuthService.ts:211-254). Não confere core_companies.active (ApiAuthService.ts:226-230) — a mudança D2 do desenho entra lá, não aqui.' });
outro({ arquivo: A, linha: 855, tipo: 'rota', metodo: 'POST', caminho: '/auth/logout',
  guarda_hoje: "autenticacaoDaSaida + limiteDaSaidaPeloRefresh + rotaPublica('sem permissão de propósito: encerra a PRÓPRIA sessão…')",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Encerra a própria sessão (família inteira). Sem access válido, aceita só o refresh do corpo e só revoga. No inventário do arquiteto consta PUBLICA; é SO_AUTENTICADO (ou refresh). Equivalência dia-1: igual.' });
outro({ arquivo: A, linha: 869, tipo: 'rota', metodo: 'GET', caminho: '/auth/session',
  guarda_hoje: "autenticacaoDaEtapaDeTroca + rotaPublica('sem permissão de propósito: devolve a PRÓPRIA sessão do token…')",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'Devolve req.auth e companies[] com profileCode de cada vínculo (870-880). É o ponto onde a TELA passa a receber access {modelo, capabilities, terminais, bancadas, casa, carimbo} (desenho §5.3) e de onde useCan lê; companies[].profileCode fica ao lado até a F3. Hoje devolve `session: req.auth` cru — quando req.auth ganhar `acesso` (Set), serializar explicitamente (Set vira {} no JSON). Equivalência dia-1: igual.' });
outro({ arquivo: A, linha: 895, tipo: 'rota', metodo: 'POST', caminho: '/auth/switch-company',
  guarda_hoje: "authMiddleware + rotaPublica('sem permissão de propósito: troca apenas entre as empresas do PRÓPRIO vínculo…') + conferirProvaDaSessao (899) + assertMembership (907-910)",
  perfis_hoje: TODOS, capability: 'SO_AUTENTICADO', escopo: 'empresa',
  nota: 'TROCA DE EMPRESA SÓ NO ESCOPO: exige o refresh da mesma família (899), recusa a mesma empresa (900-906, 409) e só aceita empresa com vínculo em empresa ativa (907-910). Não pede capability — e não deve: a missão diz "troca de empresa só no escopo". A emissão nova não leva storeId (ApiAuthService.ts:419-436), correto para escopo de PDV por vínculo. FALTA AUDITORIA: a troca não grava evento (mudança D7, auth.switch_company). A resposta passa a trazer o access da empresa de destino (desenho §5.4). Equivalência dia-1: igual.' });

// =====================================================================================
// index.ts (v1Router, raiz de /api/v1) — 15 rotas
// =====================================================================================
const I = R + 'index.ts';
publica({ arquivo: I, linha: 25, metodo: 'GET', caminho: '/health', guarda: "rotaPublica('sonda de saúde…')", nota: 'Sonda de saúde sem sessão; não expõe dado de empresa.' });
publica({ arquivo: I, linha: 55, metodo: 'GET', caminho: '/readiness', guarda: "rotaPublica('sonda de prontidão…')", nota: 'Sonda de prontidão sem sessão; responde só se o banco abre (59), sem estado do cofre (comentário 41-47). O diagnóstico com segredo mora atrás de sessão (system.secrets.view, core.ts).' });
publica({ arquivo: I, linha: 73, metodo: 'GET', caminho: '/version', guarda: "rotaPublica('versão publicada: a tela de login mostra a release antes de autenticar')", nota: 'Versão publicada, sem sessão. O detalhe do processo (Node, instância, fuso) fica em GET /system/release (system.status.view).' });
publica({ arquivo: I, linha: 188, metodo: 'GET', caminho: '/openapi.json', guarda: "rotaPublica('contrato público da API…')", nota: 'Contrato público sem sessão. Quando entrarem as rotas /core/access e /core/permission-templates (desenho §11.4), o contrato publicado as anuncia — sem capability no contrato não há vazamento, mas o catálogo de capabilities NÃO deve ir para cá (GET /core/permissions/catalog é autenticado).' });
const asaas = [
  [237, 'GET', '/asaas/status', 'asaas.connection.view', 'integrations.asaas.view', 'Lê o COFRE da operação (243), com storeId do token. gerente_oficina e estoquista não passam hoje (módulo asaas = {ler:[atendente], escrever:[gerente_loja]}, Permissions.ts:111), embora a página /sistema/integracoes/asaas seja só ROTA_GESTAO (gsRoutes.tsx:644) — a porta que bate na cara dessa página é tratada em D6 do desenho.'],
  [256, 'POST', '/asaas/test-connection', 'asaas.connection.test', 'integrations.asaas.manage', "Chamada real ao provedor com a credencial do cofre; storeId/operationalUnitId do CORPO vencem o token (263-264) — sem efeito de escopo hoje (0 caixas), mas é leitura de credencial por outra unidade escolhida pelo cliente."],
  [275, 'POST', '/asaas/customers/sync', 'asaas.customer.sync', 'integrations.asaas.manage', "Rota MORTA: responde 410 saiuDoContrato sempre (276-281); a guarda ficou só para não abrir o 410 a quem nunca a alcançou. Pode ser apagada na F5 em vez de traduzida."],
  [286, 'POST', '/asaas/charges', 'asaas.charge.create', 'integrations.asaas.manage', 'Rota MORTA (410, 287-292). Mesma observação.'],
  [297, 'GET', '/asaas/charges/:chargeLinkId', 'asaas.charge.view', 'integrations.asaas.view', 'Rota MORTA (410, 298-303). Mesma observação.'],
  [308, 'POST', '/asaas/charges/:chargeLinkId/cancel', 'asaas.charge.cancel', 'integrations.asaas.manage', 'Rota MORTA (410, 309-314). Mesma observação.'],
  [317, 'GET', '/asaas/queue', 'asaas.queue.view', 'integrations.asaas.view', 'Fila de homologação sandbox presa à empresa da sessão (318).'],
  [331, 'POST', '/asaas/queue/:attemptId/retry', 'asaas.queue.retry', 'integrations.asaas.manage', 'Retry preso à empresa do token (GAP-PRD-155, 333-349), com auditoria do retry e da recusa.'],
  [407, 'POST', '/asaas/homologation/start', 'asaas.homologation.run', 'integrations.asaas.manage', 'Rota MORTA (410, 408-413). Mesma observação.'],
  [418, 'POST', '/asaas/production/activate', 'asaas.production.activate', 'integrations.asaas.manage', 'Rota MORTA (410, 419-430). A ativação real é PATCH /core/integrations/asaas (core.ts, fora da fatia).'],
];
for (const [linha, metodo, caminho, perm, cap, nota] of asaas) {
  rota({ arquivo: I, linha, metodo, caminho, guarda: `requirePermission('${perm}')`, perfis: alcancePermissao(perm), capability: cap,
    nota: `${ACOES_DE_LEITURA.has(perm.split('.').pop()) ? 'Ação de leitura' : 'Ação de escrita'} do módulo asaas (Permissions.ts:111). ${nota}` });
}
publica({ arquivo: I, linha: 392, metodo: 'POST', caminho: '/webhooks/asaas', escopo: 'empresa',
  guarda: "rotaPublica('webhook do Asaas: quem chama é o provedor, autenticado pelo asaas-access-token dentro do handler')",
  perfis: ['provedor_asaas'],
  nota: 'Quem chama é o provedor; a empresa sai do TOKEN (handlePaymentWebhook). Fora do RBAC de pessoas.' });

// =====================================================================================
// logistics.ts (montado em /logistics) — 24 rotas
// =====================================================================================
const L = R + 'logistics.ts';
publica({ arquivo: L, linha: 52, metodo: 'GET', caminho: '/logistics/health', guarda: "rotaPublica('sonda de saúde…')", nota: 'Sonda de saúde sem sessão.' });
const LOG_BASE = 'Módulo logistics = {ler:[atendente], escrever:[gerente_loja, estoquista]} (Permissions.ts:99); gerente_oficina fora (coerente com QUEM_COTA_FRETE, environments.ts:367-372).';
const logs = [
  [56, 'GET', '/logistics/readiness', 'logistics.view', 'logistics.view', ''],
  [60, 'GET', '/logistics/providers-status', 'logistics.view', 'logistics.view', ''],
  [69, 'GET', '/logistics/shipments', 'logistics.shipment.view', 'logistics.view', 'Envios da empresa da sessão (71).'],
  [86, 'GET', '/logistics/orders/:orderId/shipments', 'logistics.shipment.view', 'logistics.view', 'Pedido de outra empresa responde 404 (comentário 82-83).'],
  [100, 'POST', '/logistics/orders/:orderId/services', 'logistics.quote.request', 'logistics.manage', "Cotação real no Melhor Envio; ação 'request' conta como escrita."],
  [112, 'POST', '/logistics/orders/:orderId/label', 'logistics.label.create', 'logistics.manage', 'Compra etiqueta e GASTA saldo da carteira do provedor (comentário 108-111) — o estoquista gasta dinheiro da empresa. Fica igual no dia 1; candidato a capability própria (ex.: logistics.label.buy) se o dono quiser separar.'],
  [135, 'POST', '/logistics/shipments', 'logistics.label.create', 'logistics.manage', 'Mesmo que /orders/:orderId/label, com orderId no corpo.'],
  [161, 'POST', '/logistics/shipments/:id/continue', 'logistics.label.create', 'logistics.manage', 'Retoma a compra (gasta saldo).'],
  [170, 'GET', '/logistics/shipments/:id/label', 'logistics.label.view', 'logistics.view', ''],
  [179, 'POST', '/logistics/shipments/:id/sync', 'logistics.tracking.sync', 'logistics.manage', ''],
  [187, 'POST', '/logistics/shipments/:id/cancel', 'logistics.shipment.cancel', 'logistics.manage', ''],
  [206, 'GET', '/logistics/settings/shipping', 'logistics.config.view', 'logistics.view', ''],
  [214, 'PUT', '/logistics/settings/shipping', 'logistics.config.manage', 'logistics.manage', "Grava a declaração de conteúdo, que o próprio comentário chama de 'decisão do contador' (203-204), e a agência Jadlog: o estoquista decide. Fica igual; o dono pode querer isso em fiscal.config.manage ou numa capability própria."],
  [222, 'POST', '/logistics/quotes', 'logistics.quote.request', 'logistics.manage', ''],
  [259, 'GET', '/logistics/quotes/:quoteId', 'logistics.quote.request', 'logistics.manage', "GET guardado por ação de ESCRITA ('request'): o atendente, que lê envios e etiquetas, não lê uma cotação. Tradução exata = logistics.manage; alargar para logistics.view seria mudança a listar."],
  [270, 'GET', '/logistics/carriers', 'logistics.config.view', 'logistics.view', ''],
  [287, 'POST', '/logistics/carriers/credentials', 'logistics.config.manage', 'logistics.manage', 'Grava credencial de transportadora; audita sem o token (313-322). O estoquista grava credencial — igual hoje.'],
  [332, 'DELETE', '/logistics/carriers/:carrier/credentials', 'logistics.config.manage', 'logistics.manage', 'Audita a remoção (341-348).'],
  [356, 'POST', '/logistics/carriers/:carrier/test-connection', 'logistics.config.manage', 'logistics.manage', ''],
  [369, 'POST', '/logistics/carriers/:carrier/test-quote', 'logistics.quote.request', 'logistics.manage', ''],
  [377, 'POST', '/logistics/carriers/:carrier/test-tracking', 'logistics.tracking.view', 'logistics.view', "POST que chama o provedor, classificado como LEITURA pela ação 'view': o atendente dispara consulta externa. Tradução exata = logistics.view."],
  [387, 'GET', '/logistics/homologation', 'logistics.homologation.run', 'logistics.manage', "GET guardado pela ação 'run' (escrita): o atendente não lê o estado da homologação."],
  [391, 'POST', '/logistics/homologation/run', 'logistics.homologation.run', 'logistics.manage', ''],
];
for (const [linha, metodo, caminho, perm, cap, nota] of logs) {
  rota({ arquivo: L, linha, metodo, caminho, guarda: `requirePermission('${perm}')`, perfis: alcancePermissao(perm), capability: cap,
    nota: `${LOG_BASE}${nota ? ' ' + nota : ''}` });
}

// =====================================================================================
// nfse.ts (nfseRouter DENTRO do coreRouter: core.ts:16743, atrás de coreRouter.use(authMiddleware) em core.ts:899) — 8 rotas
// =====================================================================================
const N = R + 'nfse.ts';
outro({ arquivo: N, linha: 38, tipo: 'atalho-admin',
  guarda_hoje: "function requireProfile(req, ...permitidos) { if (perfis.includes('admin_geral') || perfis.includes('gestor')) return; … } (nfse.ts:38-43, atalho na linha 40)",
  perfis_hoje: DONOS,
  capability: 'qualquer(fiscal.view, fiscal.config.manage, fiscal.sale.emit, fiscal.documents.cancel)',
  escopo: 'empresa',
  nota: 'CÓPIA LOCAL do requireProfile de core.ts:939-944, com o mesmo atalho "admin_geral/gestor passam". perfis_hoje = os que passam pelo atalho. A "capability" é a UNIÃO das 4 que os 8 chamadores (47, 56, 66, 75, 84, 94, 114, 134) passam a cobrar — cada rota leva a sua (ver os sites abaixo). Destino: apagar a cópia na fatia (c) da F2 (desenho §8 #3), junto com as listas locais CAIXAS/GERENCIA (nfse.ts:30-31, duplicadas de core.ts:923). O lint enxerga esta cópia só porque casa pelo NOME requireProfile (rota-declara-alcance.js:110): uma cópia renomeada escaparia — a catraca de chamadas legadas (desenho §4.2) precisa contar esta função também.' });
const nfse = [
  [45, 47, 'GET', '/core/fiscal/nfse/config', 'GERENCIA', 'fiscal.view', 'Cadastro fiscal de NFS-e (leitura).'],
  [54, 56, 'PATCH', '/core/fiscal/nfse/config', 'GERENCIA', 'fiscal.config.manage', 'Grava a configuração da NFS-e: mesmo alcance da configuração fiscal do núcleo.'],
  [64, 66, 'GET', '/core/fiscal/nfse/readiness', 'GERENCIA', 'fiscal.view', ''],
  [73, 75, 'GET', '/core/fiscal/nfse/documents', 'GERENCIA', 'fiscal.view', 'Lista as NFS-e da empresa (fiscal.view, não fiscal.sale.emit: o caixa não lista todas).'],
  [82, 84, 'GET', '/core/fiscal/sales/:saleId/nfse', 'GERENCIA+CAIXAS', 'fiscal.sale.emit', 'Prontidão da NFS-e de UMA venda, lida pelo PDV/caixa da oficina. Sem escopo de caixa: qualquer venda da empresa (a venda de outro caixa também) — no dia 1 igual; o escopo de PDV do desenho (§6) não recorta leitura de venda.'],
  [91, 94, 'POST', '/core/fiscal/sales/:saleId/nfse', 'GERENCIA+CAIXAS', 'fiscal.sale.emit', 'Emite a NFS-e da venda. O atendente, que VENDE (POST /core/sales, core.ts:5570), não emite a nota da própria venda aqui — igual hoje (fiscal.sale.emit não o inclui). Simulador só fora de produção (98).'],
  [112, 114, 'POST', '/core/fiscal/sales/:saleId/nfse/manual', 'GERENCIA+CAIXAS', 'fiscal.sale.emit', 'Registra NFS-e emitida no portal da prefeitura.'],
  [132, 134, 'POST', '/core/fiscal/nfse/:id/cancel-record', 'GERENCIA', 'fiscal.documents.cancel', 'Registra o cancelamento feito no portal.'],
];
for (const [linha, lg, metodo, caminho, lista, cap, nota] of nfse) {
  const perfis = lista === 'GERENCIA' ? alcancePerfis(...GERENCIA) : alcancePerfis(...GERENCIA, ...CAIXAS);
  const g = lista === 'GERENCIA' ? 'requireProfile(req, ...GERENCIA)' : 'requireProfile(req, ...GERENCIA, ...CAIXAS)';
  rota({ arquivo: N, linha, metodo, caminho, guarda: `${g} [cópia local, nfse.ts:38]`, perfis, capability: cap,
    nota: `Guarda em nfse.ts:${lg}. GERENCIA=[gerente_loja, gerente_oficina], CAIXAS=[operador_caixa, operador_caixa_loja, operador_caixa_oficina] (nfse.ts:30-31); admin_geral/gestor pelo atalho da cópia (nfse.ts:40). ${nota}`.trim() });
}

// =====================================================================================
// payment-terminals.ts (montado em /payment-terminals) — 38 rotas
// =====================================================================================
const P = R + 'payment-terminals.ts';
outro({ arquivo: P, linha: 74, tipo: 'atalho-admin',
  guarda_hoje: "function requireProfile(req, ...allowed) { if (profiles.includes('admin_geral') || profiles.includes('gestor')) return; … } (payment-terminals.ts:74-79, atalho na linha 76), usada só com GERENCIA_DA_MAQUININHA = ['gerente_loja','gerente_oficina'] (linha 72)",
  perfis_hoje: DONOS, capability: 'integrations.card_terminal.manage', escopo: 'empresa',
  nota: 'CÓPIA LOCAL do requireProfile com o atalho, chamada DENTRO do handler de 11 rotas (229, 246, 260, 273, 287, 314, 344, 362, 408, 517, 569), sempre DEPOIS de um requirePermission. Os 11 chamadores viram requireCapability(\'integrations.card_terminal.manage\') — a checagem dupla vira uma capability só. GUARDA QUE SE CONTRADIZ: GERENCIA_DA_MAQUININHA inclui gerente_oficina, e o comentário (63-71) diz "os mesmos do liga/desliga (/core/pdv/terminal/configurations)", que em core inclui gerente_oficina (pdv.terminal.activation). Mas o requirePermission que vem ANTES já barra gerente_oficina (o módulo payment-terminal não o lista, Permissions.ts:74-77): o nome gerente_oficina na lista é letra morta, e o alcance real é {gerente_loja} + donos. Destino: apagar a cópia na fatia (e) da F2 (desenho §8 #4).' });
outro({ arquivo: P, linha: 82, tipo: 'servico',
  guarda_hoje: 'agenteDoPedido(req) → autenticarPedidoDoAgente({headers, metodo, caminho, corpo cru}) — HMAC-SHA256 do segredo do pareamento; 401 uniforme',
  perfis_hoje: ['agente_local'], capability: 'PUBLICA', escopo: 'pdv',
  nota: 'Identidade de MÁQUINA, não de pessoa: o agente local fica preso à empresa e ao caixa (pdvTerminalId) do código de pareamento que a gerência gerou (POST /local-agent/pairing). Fica FORA das capabilities (não há vínculo usuário×empresa). Relação com o escopo de PDV novo: a fila de comandos/impressões é do caixa do agente; restringir usuário a caixas não mexe aqui. Usada pelas 5 rotas /agent/* (122, 146, 163, 184, 200).' });
publica({ arquivo: P, linha: 91, metodo: 'GET', caminho: '/payment-terminals/health', guarda: "rotaPublica('sonda de saúde…')", nota: 'Sonda de saúde sem sessão.' });
publica({ arquivo: P, linha: 106, metodo: 'POST', caminho: '/payment-terminals/agent/pair', escopo: 'pdv', perfis: ['agente_local'],
  guarda: "rotaPublica('o agente local ainda não tem identidade: a prova é o código de pareamento de uso único e dez minutos gerado pelo gestor')",
  nota: 'A prova é o código de uso único de 10 min gerado por quem tem integrations.card_terminal.manage (POST /payment-terminals/local-agent/pairing). Fora do RBAC de pessoas.' });
for (const [linha, metodo, caminho] of [
  [122, 'POST', '/payment-terminals/agent/heartbeat'],
  [146, 'GET', '/payment-terminals/agent/commands'],
  [163, 'POST', '/payment-terminals/agent/commands/:id/result'],
  [184, 'GET', '/payment-terminals/agent/print-jobs'],
  [200, 'POST', '/payment-terminals/agent/print-jobs/:id/result'],
]) {
  publica({ arquivo: P, linha, metodo, caminho, escopo: 'pdv', perfis: ['agente_local'],
    guarda: "rotaPublica('agente local: identifica-se pela assinatura HMAC do segredo do pareamento, não por sessão de usuário')",
    nota: 'Agente local assinado por HMAC (agenteDoPedido, payment-terminals.ts:82). Sem sessão de usuário; o escopo é o caixa do agente. Continua PUBLICA no inventário (a credencial é a assinatura).' });
}
const PT_BASE = 'Módulo payment-terminal = {ler:[atendente], escrever:[gerente_loja, operador_caixa, operador_caixa_loja, operador_caixa_oficina]} (Permissions.ts:74-77). gerente_oficina NÃO passa em nenhuma rota deste roteador, mas a página /sistema/configuracoes/maquininhas é oferecida a ele (QUEM_GERENCIA_A_OPERACAO, navItems.ts:82-87; gsRoutes.tsx:355-360) e ela carrega GET /payment-terminals/readiness ao montar (src/lib/api/maquininhas.ts:327): PORTA QUE BATE NA CARA para o gerente de oficina — resolvida pela D6 do desenho (a tela passa a pedir integrations.card_terminal.view).';
const pts = [
  // [linha, metodo, caminho, perm, interno(linha|null), cap, nota]
  [215, 'GET', '/readiness', 'payment-terminal.view', null, 'integrations.card_terminal.view', ''],
  [219, 'GET', '/providers-status', 'payment-terminal.view', null, 'integrations.card_terminal.view', ''],
  [223, 'GET', '/local-agent/status', 'payment-terminal.settings.manage', null, 'integrations.card_terminal.operate', "GET guardado por ação de ESCRITA ('manage') e SEM a checagem de gerência que as irmãs de escrita têm: os caixas passam, e é assim que o PDV mostra o estado do agente. storeId vem da query (224) sem conferência de escopo de caixa."],
  [227, 'POST', '/local-agent/pairing', 'payment-terminal.settings.manage', 229, 'integrations.card_terminal.manage', 'Gera o código de pareamento. storeId/operationalUnitId/pdvTerminalId vêm do CORPO e vencem o do token (232-236) — ok para a gerência, que escolhe o caixa.'],
  [244, 'POST', '/local-agent/pair', 'payment-terminal.settings.manage', 246, 'integrations.card_terminal.manage', 'Confirma o pareamento pela sessão da gerência (a versão do agente é /agent/pair, pública). storeId do corpo vence o do token (251).'],
  [258, 'POST', '/local-agent/heartbeat', 'payment-terminal.settings.manage', 260, 'integrations.card_terminal.manage', 'Heartbeat pela sessão da gerência (o agente de verdade usa /agent/heartbeat com HMAC).'],
  [271, 'POST', '/local-agents/:id/revoke', 'payment-terminal.settings.manage', 273, 'integrations.card_terminal.manage', ''],
  [285, 'GET', '/agent-commands', 'payment-terminal.settings.manage', 287, 'integrations.card_terminal.manage', 'Leitura (fila de comandos do agente) guardada como gerência; carregada pela página Maquininhas (src/lib/api/maquininhas.ts:430).'],
  [300, 'GET', '/providers', 'payment-terminal.view', null, 'integrations.card_terminal.view', 'Lista estática de provedores, sem dado de empresa.'],
  [304, 'GET', '/providers/:provider/capabilities', 'payment-terminal.view', null, 'integrations.card_terminal.view', 'Estático, sem dado de empresa. (O nome "capabilities" aqui é do provedor de maquininha, não do RBAC.)'],
  [308, 'GET', '/configurations', 'payment-terminal.configuration.view', null, 'integrations.card_terminal.view', ''],
  [312, 'POST', '/configurations', 'payment-terminal.configuration.manage', 314, 'integrations.card_terminal.manage', 'Cadastra maquininha; storeId do corpo vence o do token (320).'],
  [342, 'PATCH', '/configurations/:id', 'payment-terminal.configuration.manage', 344, 'integrations.card_terminal.manage', ''],
  [360, 'POST', '/credentials', 'payment-terminal.configuration.manage', 362, 'integrations.card_terminal.manage', 'Grava a credencial da adquirente (segredo).'],
  [395, 'GET', '/terminals', 'payment-terminal.terminal.view', null, 'integrations.card_terminal.view', 'Lista as MAQUININHAS (payment_terminal_configurations), não os caixas core_terminals — homônimo de GET /core/terminals; não confundir no escopo de PDV.'],
  [399, 'POST', '/providers/:provider/test-connection', 'payment-terminal.terminal.test', null, 'integrations.card_terminal.operate', "Ação 'test' é escrita: os caixas disparam teste de conexão com o provedor (chamada externa); storeId do corpo."],
  [403, 'POST', '/providers/:provider/test-transaction', 'payment-terminal.transaction.create', 408, 'integrations.card_terminal.manage', 'Roteiro de teste do adaptador, só gerência (comentário 406-407).'],
  [428, 'GET', '/transactions', 'payment-terminal.transaction.view', null, 'integrations.card_terminal.view', 'Todas as cobranças de cartão da empresa, com o último pedido de cancelamento/estorno; o atendente lê. Sem recorte por caixa.'],
  [437, 'POST', '/transactions', 'payment-terminal.transaction.create', null, 'integrations.card_terminal.operate', 'SEGUNDA PORTA DE COBRANÇA, fora do PDV (a do balcão é POST /core/pdv/terminal/charge, core.ts:4696-4714, que passa por terminalDoPedido). Aqui o storeId do CORPO vence o do token (443) — o contrário da régua "o token vence o corpo" (TerminalRegistry.ts:92-111). O escopo de PDV novo (requireTerminalNoEscopo, desenho §6.3) NÃO lista esta rota e tem de listá-la: sem isso, o operador restrito ao Caixa 1 cobra pelo Caixa 2 por aqui. Também: gerente_oficina não passa aqui mas passa em pdv.payment.charge — por isso a tradução exata é integrations.card_terminal.operate e não pdv.payment.charge.'],
  [462, 'GET', '/transactions/:id', 'payment-terminal.transaction.view', null, 'integrations.card_terminal.view', ''],
  [480, 'POST', '/transactions/:id/cancel', 'payment-terminal.transaction.cancel', null, 'integrations.card_terminal.operate', 'O CAIXA CANCELA DIRETO, sem alçada, cobrança avulsa (sem venda) ou de venda já desfeita (exigirSemVenda, PaymentTerminalService.ts:1020-1036), de QUALQUER caixa da empresa. Contraste: cancelar a VENDA exige gerente ou bilhete (approval.sale_cancel, comLiberacaoPontual). Dia 1 igual; candidata a pdv.supervise ou approval.* por decisão do dono (mudança a listar).'],
  [494, 'POST', '/transactions/:id/refund', 'payment-terminal.transaction.refund', null, 'integrations.card_terminal.operate', 'Mesma observação do cancel: o caixa ESTORNA dinheiro de cobrança avulsa sem alçada (teto no serviço, PaymentTerminalService.ts:1219-1236).'],
  [515, 'POST', '/transactions/:id/query', 'payment-terminal.reconciliation.manage', 517, 'integrations.card_terminal.manage', '"Consulte no aparelho": decisão de gerência (comentário 510-514).'],
  [537, 'GET', '/transactions/:id/receipt', 'payment-terminal.receipt.view', null, 'integrations.card_terminal.view', ''],
  [549, 'POST', '/transactions/:id/reprint', 'payment-terminal.receipt.reprint', null, 'integrations.card_terminal.operate', ''],
  [562, 'GET', '/homologation', 'payment-terminal.homologation.run', null, 'integrations.card_terminal.operate', "GET guardado pela ação 'run' (escrita) sem a checagem de gerência do POST irmão (569): os caixas LEEM as homologações, o atendente não. Tradução exata = operate."],
  [566, 'POST', '/homologation/run', 'payment-terminal.homologation.run', 569, 'integrations.card_terminal.manage', ''],
  [598, 'GET', '/local-agents', 'payment-terminal.settings.manage', null, 'integrations.card_terminal.operate', 'Leitura SEM a checagem de gerência: os caixas listam os agentes (hostname, versão) da empresa inteira; carregada pela página Maquininhas (src/lib/api/maquininhas.ts:376).'],
  [602, 'GET', '/dashboard', 'payment-terminal.dashboard.view', null, 'integrations.card_terminal.view', ''],
  [606, 'GET', '/recovery', 'payment-terminal.recovery.manage', null, 'integrations.card_terminal.operate', "GET com ação 'manage': os caixas passam."],
  [618, 'GET', '/dead-letter', 'payment-terminal.recovery.manage', null, 'integrations.card_terminal.operate', "GET com ação 'manage': os caixas passam."],
];
for (const [linha, metodo, sub, perm, interno, cap, nota] of pts) {
  let perfis = alcancePermissao(perm);
  let guarda = `requirePermission('${perm}')`;
  let pre = '';
  if (interno) {
    perfis = inter(perfis, alcancePerfis(...GERENCIA_DA_MAQUININHA));
    guarda += ` + requireProfile(req, ...GERENCIA_DA_MAQUININHA) [cópia local, payment-terminals.ts:${interno}]`;
    pre = `Checagem dupla: ${alcancePermissao(perm).join(', ')} pela permissão ∩ {gerente_loja, gerente_oficina} + donos pela cópia local (linha ${interno}) = só gerente_loja + donos (gerente_oficina já cai na permissão). `;
  }
  rota({ arquivo: P, linha, metodo, caminho: `/payment-terminals${sub}`, guarda, perfis, capability: cap,
    nota: `${pre}${nota ? nota + ' ' : ''}${PT_BASE}` });
}

// =====================================================================================
// storefront.ts (montado em /loja) — 64 rotas, todas rotaPublica
// =====================================================================================
const S = R + 'storefront.ts';
outro({ arquivo: S, linha: 914, tipo: 'servico',
  guarda_hoje: "exigirCliente(req) → resolveCustomerSession(x-portal-token) ou 401 PORTAL_UNAUTHENTICATED",
  perfis_hoje: ['cliente_do_portal'], capability: 'PUBLICA', escopo: 'grupo',
  nota: 'Sessão do CLIENTE da loja (conta do comprador), separada da sessão da equipe (header próprio x-portal-token, storefront.ts:905-912). Não passa por perfil, vínculo nem capability — e não deve: o RBAC novo é da equipe. A conta do cliente atravessa as lojas das seis empresas (o checkout devolve um pedido por empresa). Chamada direta em 33 rotas do portal e, via pedidoDaSessao (1239-1253), em mais 3 (danfe, xml, devolução). A capability PUBLICA aqui significa "fora do RBAC da equipe".' });
const VITRINE = 'Vitrine pública da loja: sem sessão, fora do RBAC da equipe. O dado exposto é o que a própria vitrine publica.';
const PORTAL = 'Portal do cliente: credencial = sessão do comprador (x-portal-token), exigida por exigirCliente (storefront.ts:914)';
const sf = [
  [141, 'GET', '/identificacao', 'Identificação legal do fornecedor (Decreto 7.962).'],
  [148, 'GET', '/stores', VITRINE],
  [156, 'GET', '/products', VITRINE],
  [184, 'GET', '/ofertas', VITRINE],
  [198, 'GET', '/destaques', VITRINE],
  [211, 'GET', '/categories', VITRINE],
  [227, 'GET', '/municipios', 'Busca pública de municípios do IBGE (até 20 por busca).'],
  [242, 'GET', '/stores/:storeSlug/products/:id', VITRINE],
  [270, 'POST', '/stores/:storeSlug/products/:id/shipping-quote', `${VITRINE} Cota frete no provedor com a credencial da empresa (custo de chamada externa, sem gasto de saldo).`],
  [489, 'POST', '/checkout/frete', VITRINE],
  [530, 'POST', '/checkout/cupom', 'Simulação de cupom antes do login; lê a sessão do portal se vier (536-537). Teto de códigos errados por origem.'],
  [645, 'GET', '/products/:id', VITRINE],
  [661, 'POST', '/checkout', 'Checkout: token do portal opcional, mas token enviado e inválido = 401 (685-693); sem sessão, a loja que exige conta recusa. Preço e frete do servidor. Fora do RBAC da equipe.'],
  [922, 'POST', '/portal/registrar', 'Cria/abre a conta do comprador; sem sessão ainda. Consentimento é o primeiro portão (927).'],
  [975, 'POST', '/portal/entrar', 'Login do comprador; sem sessão ainda.'],
  [991, 'POST', '/portal/sair', 'Encerra a sessão do x-portal-token enviado; sem token é inofensiva (993).'],
  [1003, 'POST', '/portal/verificar-email', `${PORTAL} (1005).`],
  [1019, 'POST', '/portal/reenviar-verificacao', `${PORTAL} (1021).`],
  [1046, 'POST', '/portal/convite/resgatar', `${PORTAL} (1048). O convite nasce no balcão pela equipe (customers.portal.invite, core.ts).`],
  [1055, 'GET', '/portal/equipamentos', `${PORTAL} (1057).`],
  [1064, 'GET', '/portal/equipamentos/:id', `${PORTAL} (1066).`],
  [1078, 'GET', '/portal/chamados', `${PORTAL} (1080).`],
  [1087, 'POST', '/portal/equipamentos/:id/chamados', `${PORTAL} (1089). O chamado cai na fila da equipe (workshop.tickets.manage).`],
  [1103, 'POST', '/portal/chamados/:id/cancelar', `${PORTAL} (1105).`],
  [1118, 'POST', '/portal/ordens/:id/aprovar', `${PORTAL} (1120). O CLIENTE decide o orçamento da OS: mexe em dado de bancada sem passar pelo escopo de bancada — correto (é o dono do equipamento), mas é o único escritor de OS fora do RBAC da equipe.`],
  [1127, 'POST', '/portal/ordens/:id/recusar', `${PORTAL} (1129). Mesma observação de /aprovar.`],
  [1135, 'GET', '/portal/pedidos', `${PORTAL} (1137).`],
  [1147, 'GET', '/portal/pedidos/:id', `${PORTAL} (1149).`],
  [1195, 'POST', '/portal/pedidos/:id/cancelar', `${PORTAL} (1197).`],
  [1256, 'GET', '/portal/pedidos/:id/nfe/danfe', `${PORTAL}, via pedidoDaSessao (1245, 1258).`],
  [1269, 'GET', '/portal/pedidos/:id/nfe/xml', `${PORTAL}, via pedidoDaSessao (1245, 1271).`],
  [1284, 'POST', '/portal/pedidos/:id/devolucao', `${PORTAL}, via pedidoDaSessao (1245, 1286). A decisão da devolução é da equipe (ecommerce.orders.service, core.ts).`],
  [1308, 'GET', '/products/:id/avaliacoes', 'Resumo público de avaliações, sem sessão.'],
  [1320, 'POST', '/products/:id/avaliacoes', `${PORTAL} (1322).`],
  [1338, 'GET', '/products/:id/minha-avaliacao', `${PORTAL} (1340).`],
  [1349, 'GET', '/portal/enderecos', `${PORTAL} (1351).`],
  [1358, 'POST', '/portal/enderecos', `${PORTAL} (1360).`],
  [1372, 'PUT', '/portal/enderecos/:id', `${PORTAL} (1374).`],
  [1381, 'POST', '/portal/enderecos/:id/padrao', `${PORTAL} (1383).`],
  [1391, 'DELETE', '/portal/enderecos/:id', `${PORTAL} (1393).`],
  [1407, 'POST', '/portal/senha', `${PORTAL} (1409).`],
  [1425, 'GET', '/portal/perfil', `${PORTAL} (1427). "Perfil" aqui é o cadastro do comprador, não perfil de acesso.`],
  [1439, 'PUT', '/portal/perfil', `${PORTAL} (1441).`],
  [1455, 'POST', '/portal/vincular', `${PORTAL} (1457).`],
  [1478, 'POST', '/portal/sair-outros', `${PORTAL} (1480).`],
  [1495, 'GET', '/portal/sessao', `${PORTAL} (1497).`],
  [1509, 'GET', '/portal/carrinho', `${PORTAL} (1511).`],
  [1518, 'PUT', '/portal/carrinho', `${PORTAL} (1520).`],
  [1527, 'POST', '/portal/carrinho/mesclar', `${PORTAL} (1529).`],
  [1536, 'POST', '/portal/carrinho/itens', `${PORTAL} (1538).`],
  [1553, 'GET', '/portal/envio-de-email', 'Pergunta sem sessão se há envio de e-mail; não revela conta nem configuração.'],
  [1565, 'POST', '/portal/recuperar-senha', 'Recuperação de senha do comprador, sem sessão.'],
  [1578, 'POST', '/portal/redefinir-senha', 'O token do e-mail é a credencial.'],
  [1597, 'GET', '/portal/google/disponivel', 'Responde só se mostra o botão do Google. Quem liga o Google é integrations.google_login.manage (grupo, core.ts).'],
  [1610, 'POST', '/portal/google/iniciar', 'Começa a entrada pelo Google; para ligar a uma conta aberta, o x-portal-token é exigido no serviço (1617).'],
  [1626, 'POST', '/portal/google/concluir', 'Volta do Google: code + state + chave do navegador; id_token conferido pela chave do Google.'],
  [1642, 'POST', '/portal/google/aceitar-termos', 'Ticket de uso único + chave do navegador.'],
  [1659, 'GET', '/portal/google/conta', `${PORTAL} (1661).`],
  [1668, 'DELETE', '/portal/google/conta', `${PORTAL} (1670).`],
  [1682, 'GET', '/portal/google/teste/autorizar', 'Provedor de TESTE do Google, 404 em produção.'],
  [1695, 'GET', '/portal/google/teste/autorizar/confirmar', 'Provedor de TESTE do Google, 404 em produção.'],
  [1740, 'POST', '/webhooks/payments/:provider/:companyId', 'Webhook do provedor; a empresa vem na URL e o token é o do COFRE daquela empresa (comentário 1729-1738) — um token de uma empresa não confirma pedido de outra.'],
  [1755, 'POST', '/webhooks/payments/:provider', 'Webhook legado sem empresa na URL: a empresa sai do TOKEN; o token do ambiente só vale fora de produção (GAP-PRD-113).'],
  [1779, 'GET', '/equipamento/:token', 'Plaquinha: o QR é a credencial (token opaco), resposta mínima sem dono nem valor (comentário 1768-1778).'],
];
const PORTAL_LINHAS = new Set([1003, 1019, 1046, 1055, 1064, 1078, 1087, 1103, 1118, 1127, 1135, 1147, 1195, 1256, 1269, 1284, 1320, 1338, 1349, 1358, 1372, 1381, 1391, 1407, 1425, 1439, 1455, 1478, 1495, 1509, 1518, 1527, 1536, 1659, 1668]);
for (const [linha, metodo, sub, nota] of sf) {
  const perfis = PORTAL_LINHAS.has(linha) ? ['cliente_do_portal']
    : (linha === 1740 || linha === 1755) ? ['provedor_pagamento'] : ['anonimo'];
  publica({ arquivo: S, linha, metodo, caminho: `/loja${sub}`, perfis,
    escopo: (linha === 1740 || linha === 1755) ? 'empresa' : 'grupo',
    guarda: 'rotaPublica(…)', nota });
}

// =====================================================================================
// system-admin.ts (montado em /system) — 10 rotas
// =====================================================================================
const Y = R + 'system-admin.ts';
publica({ arquivo: Y, linha: 26, metodo: 'GET', caminho: '/system/health', guarda: "rotaPublica('sonda de saúde…')", nota: 'Sonda de saúde sem sessão.' });
const SYS_BASE = 'Módulo system-* = {ler:[], escrever:[]} (Permissions.ts:118-124): só os donos, pelo atalho RESPONDEM_POR_TUDO.';
const sys = [
  [30, 'GET', '/system/readiness', 'system-readiness.view', 'system.status.view', 'Prontidão do backend (global).'],
  [50, 'GET', '/system/implantacao', 'system-readiness.view', 'system.deploy.view', 'Conferência da implantação (global; nomes de variável, nunca valores). Mesma permissão de /readiness mas capability diferente (system.deploy.view) — o catálogo separa estado de implantação; no dia 1 os dois conjuntos são {admin_geral, gestor}.'],
  [79, 'GET', '/system/implantacao/empresas', 'system-readiness.view', 'system.deploy.view', 'Além da permissão, FILTRA as empresas por temVinculoDeGestao (linha 83) — ver o site atalho-admin da linha 83.'],
  [90, 'GET', '/system/implantacao/empresas/:companyId', 'system-readiness.view', 'system.deploy.view', 'Além da permissão, exige vínculo de gestão na empresa PEDIDA (empresaDeGestao, linha 92 → 71-77) — ver o site atalho-admin da linha 73.'],
  [98, 'PUT', '/system/implantacao/empresas/:companyId/itens/:item/marca', 'system-readiness.manage', 'system.deploy.manage', 'Além da permissão, empresaDeGestao (100 → 71-77). Audita implantacao.item_marcado na empresa PEDIDA (110-118).'],
  [125, 'DELETE', '/system/implantacao/empresas/:companyId/itens/:item/marca', 'system-readiness.manage', 'system.deploy.manage', 'Além da permissão, empresaDeGestao (127 → 71-77). Audita implantacao.marca_removida (132-140).'],
  [182, 'GET', '/system/release', 'system-release.view', 'system.status.view', 'Versão, Node, instância e fuso (global).'],
  [206, 'GET', '/system/backup/status', 'system-backup.view', 'system.backup.view', 'Global de propósito: o banco é um só para as seis empresas (comentário 198-205). Com a capability de escopo grupo dada em UMA empresa, a pessoa lê o backup do grupo inteiro — por isso system.* só é entregue por quem tem group.admin (desenho §9.2).'],
  [215, 'POST', '/system/backup/conferir-bucket', 'system-backup.manage', 'system.backup.manage', 'Uma chamada ao provedor por clique; audita na empresa DA SESSÃO (219) um fato do grupo.'],
];
for (const [linha, metodo, caminho, perm, cap, nota] of sys) {
  rota({ arquivo: Y, linha, metodo, caminho, guarda: `requirePermission('${perm}')`, perfis: alcancePermissao(perm), capability: cap, escopo: 'grupo',
    nota: `${SYS_BASE} ${nota}` });
}
outro({ arquivo: Y, linha: 73, tipo: 'atalho-admin', metodo: 'GET|PUT|DELETE', caminho: '/system/implantacao/empresas/:companyId[/itens/:item/marca]',
  guarda_hoje: "empresaDeGestao(req): if (!temVinculoDeGestao(req.auth.sub, companyId)) → 403 API_TENANT_MISMATCH; temVinculoDeGestao = vínculo com profile_code ∈ PERFIS_DE_GESTAO = {'admin_geral','gestor'} (IdentityService.ts:366-379)",
  perfis_hoje: DONOS, capability: 'system.deploy.view', escopo: 'empresa',
  nota: 'CHECAGEM MANUAL DE PERFIL por código (admin_geral/gestor) na empresa PEDIDA pela URL — travessia de empresa sem trocar de sessão. Chamada por 3 rotas (92, 100, 127). Substituto (desenho §8 #7): "tem system.deploy.view NO VÍNCULO da empresa pedida" (capabilitiesDe(userId, companyId), não req.auth.acesso da sessão) — e para PUT/DELETE, system.deploy.manage lá. ESQUISITO: o catálogo dá escopo "grupo" a system.deploy.*, mas esta checagem é POR EMPRESA; ou o catálogo aceita capability de grupo avaliada por vínculo (é o que o desenho faz, pois toda capability mora num vínculo), ou esta travessia vira group.admin. Equivalência dia-1: igual (os dois modelos com a capability são exatamente admin_geral e gestor).' });
outro({ arquivo: Y, linha: 83, tipo: 'atalho-admin', metodo: 'GET', caminho: '/system/implantacao/empresas',
  guarda_hoje: "listCompaniesForUser(sub).filter(id => temVinculoDeGestao(sub, id)) — PERFIS_DE_GESTAO = {'admin_geral','gestor'} (IdentityService.ts:366-379)",
  perfis_hoje: DONOS, capability: 'system.deploy.view', escopo: 'empresa',
  nota: 'Mesma checagem por código de perfil, agora como FILTRO da lista: devolve só as empresas em que o vínculo é admin_geral/gestor. Substituto: empresas ativas do usuário onde capabilitiesDe(userId, id) tem system.deploy.view (o mesmo operacoesOndeACapabilityAbre do desenho §8 #6). Equivalência dia-1: igual.' });

// ---------------------------------------------------------------------- saída + conferência
const codigosDesconhecidos = [];
for (const s of sites) {
  const c = s.capability;
  if (c === 'PUBLICA' || c === 'SO_AUTENTICADO' || c.startsWith('FALTA:')) continue;
  for (const k of capsDaExpr(c)) if (!CAPS.has(k)) codigosDesconhecidos.push(`${s.arquivo}:${s.linha} ${k}`);
}
if (codigosDesconhecidos.length) {
  console.error('capability fora do catálogo:', codigosDesconhecidos);
  process.exit(1);
}
const saida = join(AQUI, 'sites-outros-roteadores.json');
writeFileSync(saida, JSON.stringify(sites, null, 2) + '\n', 'utf8');
const porArquivo = {};
const porTipo = {};
for (const s of sites) {
  porArquivo[s.arquivo] = (porArquivo[s.arquivo] ?? 0) + 1;
  porTipo[s.tipo] = (porTipo[s.tipo] ?? 0) + 1;
}
const desvios = sites.filter((s) => s.tipo === 'rota' && /DESVIO/.test(s.nota));
console.log(JSON.stringify({ total: sites.length, porArquivo, porTipo, desvios: desvios.map((d) => `${d.arquivo}:${d.linha}`) }, null, 2));
