// Gera sites-core-7.json (fatia core.ts 13201-fim) e confere: (1) cada rota da
// fatia no fonte tem entrada, (2) rota/capability batem com mapa-rota-capability.tsv,
// (3) a capability reproduz o conjunto de hoje (perfis_de_hoje do catálogo),
// (4) toda linha citada existe e contém o que se diz. Só lê; não toca no repo.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const FONTE = REPO_DA_ARVORE + '/server/src/routes/v1/core.ts';
const src = readFileSync(FONTE, 'utf8').split('\n');
const catalogo = JSON.parse(readFileSync(join(aqui, 'catalogo.json'), 'utf8'));
const porCode = new Map(catalogo.map((c) => [c.code, c]));
const INICIO = 13201;

const L = {
  C: 'operador_caixa', CL: 'operador_caixa_loja', CO: 'operador_caixa_oficina',
  E: 'estoquista', L: 'gerente_loja', M: 'mecanico', O: 'gerente_oficina',
  T: 'atendente', K: 'contador',
};
const ORDEM = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
const expandir = (letras) => {
  const s = new Set(['admin_geral', 'gestor']);
  if (letras !== 'DONOS') for (const x of letras.split(',')) s.add(L[x.trim()]);
  return ORDEM.filter((p) => s.has(p));
};
const codesDe = (expr) => {
  const m = /^qualquer\((.*)\)$/.exec(expr);
  return m ? m[1].split(',').map((x) => x.trim()) : [expr];
};
const alcance = (expr) => {
  const s = new Set();
  for (const c of codesDe(expr)) {
    const cap = porCode.get(c);
    if (!cap) throw new Error(`capability fora do catálogo: ${c}`);
    for (const p of cap.perfis_de_hoje) s.add(p);
  }
  return ORDEM.filter((p) => s.has(p));
};
const igual = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);

// ------------------------------------------------------------------ TSV (rotas)
const tsv = readFileSync(join(aqui, 'mapa-rota-capability.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t'))
  .filter((c) => c[0] === 'core.ts' && +c[1] >= INICIO);
const porLinha = new Map(tsv.map((c) => [+c[1], c]));

// guarda de hoje, lida do fonte: primeira chamada de guarda depois da linha da rota
function guardaDaRota(linha) {
  for (let i = linha - 1; i < linha + 14; i++) {
    const m = /(requireProfile|abertaAo)\(req[^;]*\)/.exec(src[i]);
    if (m) return { linha: i + 1, texto: m[0] };
  }
  throw new Error(`guarda não achada para a rota da linha ${linha}`);
}

// ------------------------------------------------------------ notas por rota
const NAO_ESC = 'Escopo empresa: a empresa vem do token (scope(req), core.ts:902-907).';
const D6_COMPRAS = 'Tela em ROTA_GESTAO sem lista de perfis (src/router/gsRoutes.tsx:476-480): o atendente abre a página e toma 403 aqui — porta que bate na cara já listada em D6 (desenho §14).';
const ASAAS_PORTA = 'PORTA QUE BATE NA CARA HOJE: /sistema/integracoes/asaas é ROTA_GESTAO sem lista (src/router/gsRoutes.tsx:644), e o gerente_oficina, o estoquista e o atendente abrem a tela e tomam 403 (D6). integrations.asaas.view (A,G,L,T) existe no catálogo mas não serve aqui: alargaria ao atendente.';
const EMAILS = 'Tela /sistema/loja/emails com QUEM_RESPONDE_PELA_LOJA (src/router/gsRoutes.tsx:642; src/router/environments.ts:348-353), a mesma lista — cinco-telas-que-batem-na-cara.test.ts cobra.';
const LOJA = 'Tela da loja com QUEM_RESPONDE_PELA_LOJA (src/router/gsRoutes.tsx:558-561; src/router/environments.ts:348-353), a mesma lista.';
const BANCO = 'Tela /sistema/financeiro/conciliacao com QUEM_GERENCIA_A_OPERACAO (src/router/gsRoutes.tsx:543-547), a mesma lista. Cenário F recebe (finance.bank_reconciliation.manage está no modelo financeiro_relatorios).';
const CRM_TELA = 'Tela com QUEM_ATENDE_O_CLIENTE (src/components/gs/navItems.ts:118-125; src/router/gsRoutes.tsx:532-540), que inclui operador_caixa_loja, mas a rota é ROTA_GESTAO e o caixa mora no ambiente pdv: ele alcança pela API e não pela tela (D6 "aparecem telas"; R1 sugere tirar crm.* do caixa).';
const LOC_TELA = 'Tela /sistema/locacao/contratos com QUEM_ATENDE_O_CLIENTE (src/router/gsRoutes.tsx:535-540); mesma ressalva do caixa da loja (alcança pela API, não pela tela; R1).';
const IMPORT = 'Tela /sistema/estoque/importacao-planilha com QUEM_MONTA_O_CATALOGO (src/router/gsRoutes.tsx:471-474; src/router/environments.ts:279-285), a mesma lista.';
const INV = 'Tela /sistema/estoque/inventario com QUEM_CONTA_A_PRATELEIRA (src/router/gsRoutes.tsx:526-529).';
const RELAT = 'Tela com QUEM_GERENCIA_A_OPERACAO (src/router/gsRoutes.tsx:569, 583-586). A Central junta custo, comissão e margem, por isso é a porta mais estreita (comentário core.ts:16326-16331). A empresa é a do token, sem ?companyId= (core.ts:16369-16372).';
const BI = 'Tela /sistema/relatorios/bi com QUEM_GERENCIA_A_OPERACAO (src/router/gsRoutes.tsx:569). A rota não usa a empresa da sessão: compara as operações do VÍNCULO pelo perfil de cada uma (ver a entrada de serviço desta rota). Guarda da sessão e travessia usam a mesma lista (PERFIS_QUE_LEEM_O_BI, server/src/services/core/GroupInsights.ts:39).';
const LOGI = 'Leitura, mas logistics.view (A,G,E,L,T) alargaria ao atendente; fica na capability de gerir para o conjunto ser o de hoje. Tela /sistema/loja/logistica com QUEM_COTA_FRETE (src/router/gsRoutes.tsx:639; src/router/environments.ts:367-372), a mesma lista: gerente_oficina fora de propósito ("a bancada não embala"). Duas portas para o mesmo módulo: estas rotas de core e o roteador /logistics (requirePermission). O comentário core.ts:16504-16515 diz que aquele só deixava passar admin_geral; o mapa RBAC-SERVIDOR registra logistics já declarado em Permissions.ts — comentário possivelmente desatualizado, conferir na fatia (e).';

const N = {
  13207: 'Prontidão para faturar o pedido online, perguntada antes de mostrar o botão (core.ts:13190-13196). A concessão ao perfil fantasma financeiro saiu (core.ts:13197-13205): só gerente_loja fatura. É leitura, mas serve só ao botão de faturar, por isso fica no conjunto da escrita. Tela /sistema/pedidos é ROTA_GESTAO sem lista (src/router/gsRoutes.tsx:622); a F3 deve esconder o botão por ecommerce.orders.manage.',
  13224: 'Emite a NF-e do pedido com o A1 da empresa (certificatePassword pode vir no corpo). ESQUISITO: ato fiscal guardado pela capability de pedidos (L), não por fiscal.manage (L,O); o gerente_oficina não fatura pedido online, hoje e depois. Handler async, guarda dentro do IIFE (core.ts:13225-13227). Audita order.emit_nfe. developmentMode (core.ts:13229) é ambiente, não acesso.',
  13261: 'Corrige o município do endereço fiscal do pedido; audita order.nfe_municipio_corrigido com de/para (core.ts:13272-13285).',
  13293: 'Baixa manual do pedido (PIX conferido, dinheiro na retirada): efeito financeiro sem finance.manage. Só gerente_loja, e o cenário F (financeiro_relatorios) não alcança — coerente com a tela de Pedidos. Audita order.pay_manual.',
  13330: 'Cancela o pedido e mata a cobrança no provedor ANTES de soltar a reserva (core.ts:13317-13329, 13353). Motivo obrigatório; audita order.cancel com o status anterior. O atendente cancela (atende o cliente), mas não devolve dinheiro (13377). Handler async, guarda dentro do IIFE.',
  13377: 'Reembolso no provedor e estoque de volta: "dinheiro saindo é decisão de gerência — atendente não devolve" (core.ts:13372-13376). Audita order.refund.',
  13416: 'Recebimento item a item da mercadoria devolvida (volta ao estoque). O gerente_oficina fica fora hoje e depois (catálogo: A,G,E,L). Audita order.return_received.',
  13452: 'Decide o pedido de devolução aberto pela cliente no portal; não mexe em dinheiro nem estoque (core.ts:13447-13451). Rota declarada em várias linhas (core.ts:13452-13454), guarda na 13456. Audita order.return_request_decided.',
  13482: 'Avança etapa do OMS (separação, conferência, embalagem, expedição, entrega). O gerente_oficina fica fora hoje e depois. Audita order.fulfillment.',
  13514: 'Desfaz UMA etapa: "decisão de gerência, com motivo" (core.ts:13510-13513). Audita order.fulfillment_regress com de/para.',
  13540: 'A régua das promoções. Tela Promoções, ROTA_GESTAO (src/router/gsRoutes.tsx:617). O balcão não lê a régua, recebe o preço já promovido em /products/:id (core.ts:13542-13546). products.view reproduz o escritório exato {E,L,O,T}; não há capability de leitura de promoções no catálogo.',
  13559: 'Cria promoção. ESQUISITO DE NOME: a capability está na área E-commerce, mas a promoção muda o preço do BALCÃO também (o PDV recebe o preço promovido em /products/:id, core.ts:13544-13545). O dono que der ecommerce.promotions.manage acha que mexe só na loja online; sugerir rótulo "Promoções e cupons (loja e balcão)". Audita promotion.create com a janela de horário. A página abre ao escritório inteiro (ROTA_GESTAO, gsRoutes.tsx:617) e a escrita é só de gerente_loja: a F3 deve esconder o botão por esta capability.',
  13598: 'Edita promoção ativa; audita promotion.update com as mudanças (core.ts:13609-13618).',
  13625: 'Encerra promoção (UPDATE active = 0, core.ts:13630-13632). SEM AUDITORIA: criar e editar gravam trilha (promotion.create/update) e o encerramento do cupom também (coupon.end, core.ts:13689-13698), mas encerrar a promoção, que muda o preço no balcão, não grava nada.',
  13647: 'Cupons da loja online: ler é do escritório (tela Cupons, ROTA_GESTAO, src/router/gsRoutes.tsx:619; comentário core.ts:13641-13646). products.view foi escolhida pela equivalência do conjunto {E,L,O,T}; no sentido, é leitura de promoções e cupons, que o catálogo não tem separada.',
  13657: 'Cria cupom; audita coupon.create com as regras (core.ts:13662-13677).',
  13684: 'Encerra cupom; audita coupon.end quando muda (core.ts:13689-13698).',
  13751: 'Estado da fila de saída deste nó. O recorte da resposta (nó ou operação) e os botões (acoes) são decididos no handler: ver as entradas 13754 e 13756. Tela SincronizacaoPage (/sistema/integracoes/central, QUEM_RESPONDE_PELA_LOJA, src/router/gsRoutes.tsx:657-662; chamada em src/pages/gs/SincronizacaoPage.tsx:142).',
  13778: 'Empurra a fila do NÓ inteiro (syncOnce), sem recorte de empresa, de propósito: só antecipa o ciclo de fundo de 15 segundos (core.ts:13728-13730). O gerente de uma loja dispara o envio dos eventos das seis; não decide nada sobre evento de ninguém. Mantido.',
  13788: 'Confere se a central tem o schema aplicado (toca a rede). É estado do servidor, não dado de empresa. O gerente_oficina fica fora hoje e depois; acoes.conferirSchema espelha (core.ts:13762).',
  13808: 'GUARDA QUE SE CONTRADIZ: a rota aceita gerente_loja, mas o handler recusa com 403 CORE_SYNC_NODE_SCOPE quem não responde pelo grupo (core.ts:13812-13819; ver a entrada 13812). Alcance efetivo hoje: admin_geral/gestor com vínculo em TODAS as empresas ativas. A tradução mecânica (integrations.sync.admin) mantém o dia 1 igual porque a trava do handler continua; mais limpo é requireCapability(group.admin), que só fecha a porta de rota que já batia na cara do gerente — mudança a listar. Audita sync.bootstrap.',
  13841: 'Devolve à fila os eventos mortos, no recorte de quem pede: a operação da sessão, ou o nó para quem responde pelo grupo (ver a entrada 13845). Audita sync.revive com o escopo.',
  13861: 'Estado dos provedores da operação (Asaas, NF-e, NFC-e, Correios, Melhor Envio, TEF, impressão). PORTA QUE BATE NA CARA HOJE: /sistema/integracoes é ROTA_GESTAO sem lista (src/router/gsRoutes.tsx:643) e a tela chama esta rota (src/pages/gs/GestaoPages.tsx:1143); estoquista e atendente entram e tomam 403 (D6).',
  13931: 'Painel do Asaas da operação: estado, credenciais (só dica mascarada), homologação, webhook. ' + ASAAS_PORTA,
  13956: 'Prontidão do Asaas nas operações da pessoa. requireProfile(req) sem lista = admin_geral/gestor NA EMPRESA DA SESSÃO; não exige responder pelo grupo, então o gestor de uma loja só também passa. A lista de empresas lida vem do serviço, sem olhar o perfil lá (ver a entrada 13960). Consumidor: src/lib/api/asaasDoGrupo.ts:36.',
  13978: 'Grava a chave do Asaas no cofre, por ambiente, e derruba os selos só daquele ambiente. Audita integrations.asaas.credential_saved só com o ambiente, sem a chave.',
  14033: 'Roda a homologação de 16 passos contra o sandbox. A empresa vem do token; a rota antiga, com companyId no corpo, continua inalcançável (permissão integrations.homologate sem perfil, core.ts:14019-14031). Handler async, guarda dentro do IIFE. Audita o resultado.',
  14082: 'Confere de novo se o aviso externo do Asaas chegou, sem refazer a homologação.',
  14096: 'Grava o token do webhook desta operação; audita integrations.asaas.webhook_token_saved.',
  14120: 'Remove a chave de um ambiente e derruba os selos dele; audita integrations.asaas.credential_removed.',
  14151: 'Registra o pedido de produção (intenção); as cinco trancas de resolveAsaasEnvironment decidem o ambiente efetivo. Audita integrations.asaas.environment_requested.',
  14187: 'Testa cada chave no próprio ambiente e grava o selo como consequência do teste. Audita integrations.asaas.connection_tested.',
  14263: 'Trilha da empresa ativa, só para os donos (comentário core.ts:14243-14256; o 403 do gerente está provado em server/tests/auditoria-tem-leitor.test.ts). Tela /sistema/relatorios/auditoria com DONOS_DO_GRUPO (src/router/gsRoutes.tsx:600). audit.view tem escopo empresa: o admin_geral de uma loja só lê a trilha dessa loja, como hoje. Até existir GET /core/access/users/:id/history (desenho §11.4), é aqui que se lê a trilha de mudança de acesso.',
  14292: 'Se a loja entrega e por quanto. ' + LOJA.replace('558-561', '625-629'),
  14309: 'Grava entrega/retirada e frete; audita shipping.settings_update (core.ts:14324-14334). Decisão de dinheiro: o padrão é desligado (core.ts:14286-14290).',
  14355: 'Fila de e-mail da empresa, sem o conteúdo protegido. ' + EMAILS,
  14385: 'Devolve à fila uma mensagem que desistiu; só a da empresa do token, com auditoria no serviço (core.ts:14378-14384).',
  14405: 'Tenta entregar a fila DA EMPRESA DO TOKEN (GAP-PRD-198): antes o clique marcava enviada a mensagem de outra empresa (core.ts:14396-14404). Handler async, guarda dentro do IIFE.',
  14424: 'Quem assina o e-mail da empresa e a prévia. Consumidor: src/components/gs/RemetenteDaEmpresa.tsx:62.',
  14438: 'Grava a identidade de remetente da empresa do token; audita email.identidade.update (core.ts:14434-14437).',
  14465: 'O que falta para as comunicações funcionarem (SMTP, fila, remetente, agenda e usuário do contador). Só leitura, mesmo alcance da fila de e-mail (core.ts:14459-14464). Consumidor: src/lib/api/comunicacoes.ts:31.',
  14479: 'Provedor × financeiro: relata, não corrige. Tela ConciliacaoAsaasPage com QUEM_RESPONDE_PELA_LOJA (src/router/gsRoutes.tsx:650-655). ESQUISITO, mantido: o gerente_oficina concilia o Asaas mas não abre o painel do Asaas (integrations.asaas.manage é só gerente_loja).',
  14513: 'Pergunta ao provedor as cobranças em aberto e aplica o status pelo caminho do webhook; mesmo alcance da conciliação (core.ts:14505-14512). Handler async, guarda dentro do IIFE. Audita asaas.sync.',
  14541: 'Última passada e quantas cobranças esperam consulta; leitura da mesma tela.',
  14564: 'Emite o código de convite do portal do cliente. O código é credencial e não entra na auditoria (core.ts:14575-14577). O cliente é conferido na empresa (server/src/services/core/EquipmentPortalService.ts:87-95). Único consumidor: src/pages/gs/OrdemServicoPage.tsx:641. O operador_caixa_oficina fica fora de propósito (core.ts:14551-14562).',
  14585: 'Fila de chamados abertos pelo cliente no portal. O recorte de bancada é aplicado no handler (ver a entrada 14589). Consumidor: src/pages/gs/OficinaPage.tsx:433.',
  14602: 'Converte o chamado em OS. ESCOPO DE BANCADA AUSENTE: converterChamado lê o chamado só por empresa (server/src/services/core/EquipmentPortalService.ts:574-580), e createOrder só confere que a bancada é da empresa (server/src/services/core/WorkshopCoreService.ts:450-455). Resultado: o mecânico converte chamado de QUALQUER bancada e abre OS nela, contornando a régua de entrada (mecânico só nas suas, server/src/services/core/WorkshopIntakeService.ts:42-74) que a abertura normal de OS aplica. A lista (GET) recorta, a escrita não. Para o dia 1 ficar igual, a F2(d) não pode pôr bancadasDoVinculo aqui sem listar a mudança (estreita o mecânico). Recomendo listar e fechar. Audita workshop.request.convert.',
  14637: 'Encerra o chamado sem virar OS. Mesmo furo de bancada da conversão: encerrarChamado filtra só por empresa (server/src/services/core/EquipmentPortalService.ts:607-620). Audita workshop.request.close.',
  14669: 'Transportadoras: a leitura aceita o estoquista, que confere na doca (core.ts:14666-14667). ' + D6_COMPRAS,
  14684: 'Ficha da transportadora com o histórico de notas. ' + D6_COMPRAS,
  14695: 'Cadastra transportadora; audita carrier.create.',
  14714: 'Edita transportadora; audita carrier.update.',
  14732: 'Ativa/desativa transportadora; audita carrier.active.',
  14757: 'CFOP com que a loja vende, gravado no produto que a entrada cria (core.ts:14751-14755). ' + D6_COMPRAS,
  14767: 'Grava o CFOP padrão de venda da entrada: é decisão FISCAL sob purchases.manage (L,O). fiscal.config.manage tem o mesmo conjunto; fica em Compras porque a tela é a de configuração da entrada (src/router/gsRoutes.tsx:479). Audita inbound.config.set.',
  14793: 'Fornecedores. ' + D6_COMPRAS,
  14808: 'Ficha do fornecedor com o histórico de compras (valores). ' + D6_COMPRAS,
  14822: 'Cadastra fornecedor; audita suppliers.created.',
  14840: 'Edita fornecedor; audita suppliers.updated.',
  14859: 'Desativa em vez de apagar; audita suppliers.activated/deactivated.',
  14884: 'Pedidos de compra, paginados. ' + D6_COMPRAS,
  14904: 'Ficha do pedido de compra. ' + D6_COMPRAS,
  14914: 'Cria pedido de compra (compromisso); audita purchase_orders.created.',
  14939: 'Reescreve os itens do rascunho; audita autor e tamanho (core.ts:14945-14955).',
  14962: 'Envia o pedido ao fornecedor (trava os itens); audita purchase_orders.sent.',
  14986: 'O pedido em papel A4: mesmo alcance da ficha, "quem abre o pedido imprime" (core.ts:14980-14985).',
  15003: 'Pedido por e-mail ao fornecedor: mesmo alcance de /send (core.ts:14996-15002). Audita purchase_orders.emailed com o destinatário.',
  15030: 'Cancela pedido de compra; audita purchase_orders.cancelled.',
  15053: 'Amarra nota já importada ao pedido: é gesto da doca, por isso purchases.receive (E,L,O) e não purchases.manage. Audita purchase_orders.note_linked (core.ts:15058-15070).',
  15119: 'O que ainda pode voltar da venda. O guarda foi alargado de propósito ao escritório inteiro para ler o que se pode desfazer (comentário core.ts:15083-15116), e é o mesmo de GET /sales. pdv.sell cobre o balcão (inclusive o legado operador_caixa), os gerentes e o atendente; sales.view cobre o estoquista. Mecânico e contador fora hoje e depois.',
  15129: 'Lista de devoluções; mesma expressão e mesma razão de /sales/:id/returnable. Tela DevolucoesPage com QUEM_DESFAZ_VENDA (src/router/gsRoutes.tsx:516).',
  15144: 'Detalhe da devolução: "mesmo alcance da lista" (core.ts:15146).',
  15164: 'Registra a devolução (estoque e dinheiro). Os caixas leem, mas NÃO registram: o guarda da escrita é só o escritório (core.ts:15166). sales.returns.operate reproduz {E,L,O,T}. Quem faz direto e quem precisa de liberação é decidido no handler (ver a entrada 15178); de qual gaveta sai o dinheiro, também (ver 15170). Audita sale_returns.created com quem pediu e quem assinou, e o IP do socket.',
  15236: 'Contagens de inventário. ' + INV,
  15250: 'Detalhe da contagem. ' + INV,
  15260: 'Abre contagem (recorte por categoria/busca/local, conferido no serviço); audita inventory_counts.opened.',
  15292: 'Registra o contado; ainda não mexe em estoque (core.ts:15291).',
  15311: 'Aplica o acerto: "é aqui que o saldo muda sem documento" (core.ts:15310). Só gerência. Audita inventory_counts.applied.',
  15334: 'Cancela contagem; audita inventory_counts.cancelled.',
  15362: 'Leads da empresa. ' + CRM_TELA,
  15377: 'Registra lead (idempotente pelo header). SEM recordAudit na rota (core.ts:15377-15396). ' + CRM_TELA,
  15398: 'Muda status do lead. Sem recordAudit na rota.',
  15416: 'Converte lead em cliente, reaproveitando o cadastro. O caixa da loja fica fora hoje e depois (crm.opportunities.close = A,G,L,O,T). Audita leads.converted.',
  15434: 'Oportunidades. ' + CRM_TELA,
  15448: 'Abre oportunidade; o caixa da loja entra (crm.leads.manage). Sem recordAudit na rota.',
  15467: 'Fecha oportunidade (ganha/perdida, ligada a venda). Caixa fora. Sem recordAudit na rota.',
  15485: 'Resumo do CRM. ' + CRM_TELA,
  15501: 'Programa de fidelidade. ESQUISITO, mantido: devolve também o passivo de pontos (loyaltyLiability, core.ts:15505), que é dado financeiro, ao caixa da loja e ao atendente, que não têm finance.view (o caixa) ou só o básico. Tela /sistema/crm/fidelidade com QUEM_ATENDE_O_CLIENTE (src/router/gsRoutes.tsx:534).',
  15511: 'Configura o programa de fidelidade (o que vale cada ponto); audita loyalty.program_updated.',
  15534: 'Extrato de pontos do cliente (PDV e tela de fidelidade).',
  15545: 'Resgate: pontos viram desconto para o PDV aplicar. Só o caixa da LOJA entre os caixas; o operador_caixa_oficina e o legado ficam fora hoje e depois. Sem recordAudit na rota (o serviço recebe userId, core.ts:15550-15556).',
  15568: 'Contratos de locação. ' + LOC_TELA,
  15582: 'Detalhe do contrato. ' + LOC_TELA,
  15592: 'Cria contrato (reserva, não baixa); audita rentals.created. O caixa da loja fica fora (rentals.manage = A,G,L,O,T).',
  15619: 'Devolução de itens locados. Sem recordAudit na rota.',
  15636: 'Cancela contrato: só gerência. Sem recordAudit na rota (core.ts:15636-15651).',
  15659: 'Gaveta de peças da bancada. Duas decisões no handler: o recorte de bancada (ver 15668) e o custo (ver 15670). Tela /sistema/oficina/pecas, ROTA_OFICINA (src/router/gsRoutes.tsx:542).',
  15688: 'Bipar e resolver no balcão da oficina. workshop.parts.use cobre o mecânico e o gerente_oficina; workshop.parts.manage cobre o estoquista e o gerente_loja. ESQUISITO, mantido: o atendente lê a gaveta (GET /workshop/parts) mas não bipa. Recorte de bancada (ver 15692) e custo (ver 15715) no handler. Consumidor: src/lib/api/core.ts:6489.',
  15723: 'Cadastra peça e dá entrada, com chave de idempotência obrigatória. A bancada vem do corpo e é validada contra a EMPRESA, não contra a filiação (comentário core.ts:15727-15736): quem cadastra peça alcança todas as bancadas. No dia 1 fica igual, porque os modelos com workshop.parts.manage (E,L,O) nascem com default_workshops = todas. Mas um modelo do dono com workshop.parts.manage e bancadas restritas NÃO seria recortado aqui se a F2(d) não trocar a régua. Audita workshop.part.created.',
  15785: 'Repõe a gaveta com documento; mesma régua de bancada por empresa. Audita workshop.part.restocked.',
  15828: 'Ajusta mínimo, endereço, CUSTO e PREÇO da peça (core.ts:15832-15840). A auditoria workshop.part.updated grava só mínimo e endereço (core.ts:15847): a troca de custo e preço não fica na trilha.',
  15856: 'Devolve ao estoque peça requisitada e não usada. Duas decisões no handler: o alcance de bancada (ver 15867) e a trava de responsável, que o gestor da oficina fura (ver 15873). Audita workshop.part_returned.',
  15899: 'Extratos importados, paginados. ' + BANCO,
  15916: 'Linhas do extrato. ' + BANCO,
  15934: 'Importa extrato; audita bank.statement_imported.',
  15958: 'Sugestões de casamento para a linha.',
  15969: 'Casa linha com baixa: "ato de quem confere". Audita bank.line_matched com o valor.',
  16009: 'Desfaz o casamento; a trilha é obrigatória porque desfazer apaga matched_by/matched_at (core.ts:15996-16008). Audita bank.line_unmatched.',
  16034: 'Venda × financeiro × banco no período. ' + BANCO,
  16056: 'Identidade da vitrine, produtos publicados e o tipo da loja. ' + LOJA,
  16081: 'Logo e capa da página da marca; audita storefront.logo/capa.set.',
  16105: 'Remove logo ou capa; audita.',
  16124: 'Configurações da vitrine (texto, WhatsApp, faixa, parcelas, preset); audita storefront.settings_updated sem o antes.',
  16158: 'Quem pode fechar pedido na loja online desta operação (conta ou visitante).',
  16168: 'Troca o modo do checkout; audita com antes e depois (core.ts:16172-16181).',
  16195: 'Lê a configuração do login Google do portal. É da INSTALAÇÃO, não da empresa (comentário core.ts:16188-16194), mas o guarda é requireProfile(req) = admin_geral/gestor NA EMPRESA DA SESSÃO: o gestor de uma loja só lê e muda a configuração de todas. A capability é de escopo grupo no catálogo. A F1 precisa decidir como capability de escopo grupo é avaliada: no vínculo da sessão, como hoje (dia 1 igual), ou exigindo group.admin em todas as ativas (fecha, mudança a listar). Tela com DONOS_DO_GRUPO (src/router/gsRoutes.tsx:647).',
  16204: 'Grava a configuração do login Google (segredo entra e não sai); audita portal.google_login_updated com antes/depois sem o segredo (core.ts:16219-16230). Mesma ressalva de escopo grupo da leitura.',
  16237: 'Liga/desliga destaque do produto na vitrine. Sem recordAudit na rota (core.ts:16237-16247).',
  16262: 'Lista quem trabalha na bancada, com login e nome; loadWorkshop confere a empresa (server/src/services/core/WorkshopMembersService.ts:17-40). A tela OficinasPage (/sistema/oficina/oficinas) é ROTA_GESTAO sem lista (src/router/gsRoutes.tsx:566): se ela carregar membros para o estoquista ou o atendente, é 403 — conferir na T-UI-1.',
  16273: 'Põe alguém na bancada. É MUDANÇA DE ACESSO, não cadastro: core_workshop_members é a lista que resolveWorkshop, resolveWorkshopScope e WorkshopIntakeService leem. Hoje: (1) não há régua de hierarquia, e o gerente_loja põe qualquer conta da empresa, inclusive gerente_oficina ou gestor, sem assertPodeMexerNaOperacao (server/src/services/core/HierarquiaDePerfis.ts:189-195), inclusive a si mesmo; (2) a auditoria workshop.member_added grava só a bancada como entity_id, sem o ALVO (userId do corpo) e sem o antes (core.ts:16283-16289); (3) o role vem livre do corpo (core.ts:16281). addWorkshopMember confere o vínculo na empresa (WorkshopMembersService.ts:54-69). A missão pede auditoria de troca de escopo com alvo, antes e depois: na F4 esta rota vira fachada de PUT /core/access/users/:id/companies/:companyId {bancadas} (users.manage + desenho §9) e grava access.workshops_changed; ou exige as duas capabilities. workshop.benches.manage fica para o dia 1 ser igual.',
  16296: 'Tira alguém da bancada. Mesmo furo de auditoria: workshop.member_removed sem o alvo (core.ts:16301-16307). E TIRAR ESCOPO PODE ALARGAR ACESSO: sem nenhuma filiação ativa, quem não é gerente cai no fallback de resolveWorkshopScope e passa a ver as OS de TODAS as bancadas da empresa (core.ts:7383-7384), inclusive o mecânico. A D3 do desenho fecha o fallback para vínculos novos; esta rota precisa dela, ou de recusar a remoção da última bancada de quem tem capability de escopo bancada (400 CORE_WORKSHOP_SCOPE_REQUIRED, desenho §7.2).',
  16333: 'Catálogo de relatórios (não lê o banco). ' + RELAT,
  16357: 'Um relatório, com o mesmo conteúdo em CSV. A exportação é auditada (report.export, core.ts:16395-16408). ' + RELAT,
  16429: 'Comparativo por operação. ' + BI,
  16445: 'Produtos mais vendidos nas operações do vínculo. ' + BI,
  16468: 'Vendas por marca nas operações do vínculo (core.ts:16462-16467). ' + BI,
  16486: 'Margem só onde o custo é confiável. ' + BI,
  16517: 'Prontidão da logística e CEP de origem. ' + LOGI,
  16532: 'Estado dos provedores de frete. Handler async, guarda dentro do IIFE. ' + LOGI,
  16552: 'Cotação de conferência; recusa pacote sem peso ou dimensão. Handler async, guarda dentro do IIFE. ' + LOGI,
  16591: 'Configuração do dia 1 loja a loja. Tela /sistema/loja/prontidao com QUEM_RESPONDE_PELA_LOJA (src/router/gsRoutes.tsx:633). Quem responde pelo grupo vê todas as operações de uma vez: decisão no handler (ver a entrada 16595).',
  16618: 'Envia a planilha de produtos (lote para conferência); audita import.produtos.upload. ' + IMPORT,
  16647: 'Lotes de importação. ' + IMPORT,
  16657: 'Itens do lote, paginados, erros primeiro. ' + IMPORT,
  16678: 'Relê o lote com outro separador, encoding ou mapa; quem lê é o servidor. Sem recordAudit na rota.',
  16702: 'Confirmar CRIA produto e mexe em estoque: "fica com a gerência" (core.ts:16704). products.catalog.admin tem exatamente {L,O}. Audita import.produtos.confirmar.',
  16722: 'Descarta o lote; audita import.produtos.descartar.',
};

// ESCOPO por rota: o do catálogo; leitura com expressão composta fica em empresa.
const escopoDe = (expr) => {
  const cs = codesDe(expr);
  if (cs.length > 1) {
    const e = new Set(cs.map((c) => porCode.get(c).escopo));
    return e.size === 1 && e.has('bancada') ? 'bancada' : 'empresa';
  }
  return porCode.get(cs[0]).escopo;
};

const saida = [];
const problemas = [];

for (const t of tsv) {
  const linha = +t[1];
  const g = guardaDaRota(linha);
  const perfis = expandir(t[5]);
  const cap = t[6];
  const novo = alcance(cap);
  const eq = igual(perfis, novo);
  if (!eq) problemas.push({ linha, caminho: t[3], hoje: perfis, novo });
  if (!N[linha]) problemas.push({ linha, falta: 'nota' });
  saida.push({
    arquivo: 'server/src/routes/v1/core.ts',
    linha,
    tipo: 'rota',
    metodo: t[2],
    caminho: `/core${t[3]}`,
    guarda_hoje: g.texto,
    perfis_hoje: perfis,
    capability: cap,
    escopo: escopoDe(cap),
    nota: `Guarda em core.ts:${g.linha}. ${eq ? 'Equivalência dia 1: igual (conferida contra perfis_de_hoje do catálogo).' : 'DESVIO DE EQUIVALÊNCIA.'} ${N[linha] ?? ''} ${NAO_ESC_PARA(cap)}`.trim(),
  });
}
function NAO_ESC_PARA(cap) {
  const e = escopoDe(cap);
  return e === 'empresa' ? NAO_ESC : '';
}

// --------------------------------------------- pontos de decisão dentro do handler
// [linha, ancora (texto que a linha contém), tipo, metodo, caminho, guarda, perfis, capability, escopo, conferirEquivalencia, nota]
const TODAS = ['admin_geral', 'gestor', 'gerente_oficina'];
const RWS = "resolveWorkshopScope(req) — core.ts:7349-7385: admin_geral/gestor/gerente_oficina veem todas as bancadas ativas; membro vê as suas; não-gerente sem filiação ativa cai no fallback 'empresa inteira' (core.ts:7375, 7383-7384)";
const NOTA_RWS = 'perfis_hoje = quem vê TODAS as bancadas sempre (o isManager da definição, core.ts:7359, já registrado na fatia core-4 como atalho-admin). Membro vê só as suas; quem não é gerente e não tem filiação ativa vê a empresa inteira pelo fallback. A decisão é de ESCOPO, não de capability: a capability é a da rota, e a régua vira bancadasDoVinculo(req) (desenho §7.2), com all_workshops gravado pelo passo 86 para preservar o dia 1 (D3).';
const PODE_CUSTO = "!podeVerCusto(profiles) — server/src/services/core/WorkshopPartsService.ts:32-36 (VEEM_CUSTO = ['admin_geral','gestor','gerente_loja','gerente_oficina','estoquista'])";
const BI_TRAV = 'GroupInsights.companiesOf → operacoesOndeOPerfilAbre(userId, PERFIS_QUE_LEEM_O_BI) — server/src/services/core/GroupInsights.ts:191-193; server/src/services/auth/AlcanceCruzado.ts:27, 38-56 (atalho PERFIS_QUE_PASSAM_EM_TUDO)';
const NOTA_BI = 'Travessia de empresa: a comparação junta as empresas ATIVAS em que o perfil da pessoa LÁ abre o BI (gerente_loja, gerente_oficina ou, pelo atalho, admin_geral/gestor). Vira operacoesOndeACapabilityAbre(userId, reports.bi.view), avaliando o acesso efetivo do vínculo em cada empresa (desenho §8 #6); o atalho sai com AlcanceCruzado.PERFIS_QUE_PASSAM_EM_TUDO. O catálogo já descreve isso em reports.bi.view ("compara só empresas em que a pessoa também tem esta capability"). Igual no dia 1.';

const S = [
  [13754, 'escopoDoSync(req)', 'atalho-admin', 'GET', '/sync/status',
    "escopoDoSync(req) → respondePeloGrupo(userId) — core.ts:13732-13736; server/src/services/auth/IdentityService.ts:390-403 (profile_code IN ('admin_geral','gestor') em TODAS as empresas ativas). Decide escopo 'no' × 'operacao' da resposta e acoes.cargaInicial (core.ts:13758-13761)",
    ['admin_geral', 'gestor'], 'group.admin', 'grupo', true,
    'Checagem manual de profile_code que nomeia admin_geral e gestor. perfis_hoje só vale para quem tem um desses em TODAS as ativas (ADMIN e CARLOSGERENTE no seed); o dono de uma loja só cai no recorte da operação. Substituto: "tem group.admin em todas as ativas" (desenho §8 #8). O recorte protege dado de outra empresa: antes de GAP-PRD-136 o gerente da loja A via contagens e o último erro da loja B (core.ts:13713-13731).'],
  [13756, "perfis.includes('admin_geral')", 'atalho-admin', 'GET', '/sync/status',
    "dono = profileCodes.includes('admin_geral') || includes('gestor'); acoes.conferirSchema = acoes.reviver = dono || includes('gerente_loja') (core.ts:13755-13763)",
    ['admin_geral', 'gestor', 'gerente_loja'], 'integrations.sync.admin', 'empresa', true,
    'Atalho admin/gestor escrito à mão para calcular os botões pelas mesmas regras que recusam /sync/probe e /sync/revive (core.ts:13748-13749). Substituto exato: acoes.conferirSchema = acoes.reviver = can(integrations.sync.admin) (desenho §8 #18); cargaInicial segue a entrada 13754. O gerente_oficina vê a tela e não vê esses dois botões, hoje e depois.'],
  [13812, 'escopoDoSync(req).doNo', 'atalho-admin', 'POST', '/sync/bootstrap',
    "if (!escopoDoSync(req).doNo) throw 403 CORE_SYNC_NODE_SCOPE — respondePeloGrupo(userId), IdentityService.ts:390-403 (core.ts:13812-13819)",
    ['admin_geral', 'gestor'], 'group.admin', 'grupo', true,
    'A carga inicial sobe o histórico de TODAS as operações do servidor, então é de quem responde pelo nó (core.ts:13797-13807). É esta checagem, e não o guarda da rota, que dá o alcance real: o gerente_loja passa no guarda e toma 403 aqui (guarda que se contradiz, ver a rota 13808). Substituto: can(group.admin) em todas as ativas (desenho §8 #8).'],
  [13845, 'escopoDoSync(req)', 'atalho-admin', 'POST', '/sync/revive',
    'const { doNo, recorte } = escopoDoSync(req) → reviverMortos(recorte): nó inteiro para quem responde pelo grupo, empresa da sessão para os demais (core.ts:13845-13846)',
    ['admin_geral', 'gestor'], 'group.admin', 'grupo', true,
    'Decide de QUAIS empresas o gerente devolve os mortos à fila (GAP-PRD-136, core.ts:13835-13840). perfis_hoje = quem alcança o nó inteiro. Substituto: group.admin em todas as ativas. A auditoria grava o escopo usado (core.ts:13853).'],
  [13960, 'prontidaoAsaasDoGrupo(userId)', 'servico', 'GET', '/integrations/asaas/grupo',
    'prontidaoAsaasDoGrupo(userId) → operacoesDe(userId): TODAS as empresas ativas em que a pessoa tem QUALQUER vínculo, sem olhar o perfil lá (server/src/services/core/ProntidaoAsaasDoGrupo.ts:69-79, 166-178)',
    ['admin_geral', 'gestor'], 'group.dashboard.view', 'grupo', true,
    'TRAVESSIA DE EMPRESA SEM PERFIL LÁ. O guarda confere admin_geral/gestor só na empresa da SESSÃO; a lista entrega a prontidão do Asaas (chave configurada ou não, origem, webhook, homologação, ambiente pedido) de toda empresa em que a pessoa tenha vínculo, até como mecânico ou caixa. É diferente das outras travessias (painel, BI, /companies), que passam por operacoesOndeOPerfilAbre. Hoje ADMIN e CARLOSGERENTE têm admin_geral/gestor nas 6, então ninguém é afetado; mas uma conta gestor numa loja e caixa em outra lê o Asaas da outra. Recomendo operacoesOndeACapabilityAbre(userId, group.dashboard.view): mudança deliberada a listar (fecha travessia), igual para as contas de hoje.'],
  [14589, 'resolveWorkshopScope(req)', 'servico', 'GET', '/workshop/chamados', RWS,
    TODAS, 'workshop.tickets.manage', 'bancada', false,
    NOTA_RWS + ' Aqui a lista de chamados filtra por essas bancadas (server/src/services/core/EquipmentPortalService.ts:523-535); converter e encerrar não filtram (ver as rotas 14602 e 14637).'],
  [15170, 'terminalDoPedido({', 'servico', 'POST', '/sale-returns',
    'caixaDoPedido = terminalDoPedido({ informado: req.body.terminalId, doDispositivo: req.auth.storeId }) — o terminal do token vence o do corpo (server/src/services/core/TerminalRegistry.ts:92-111); decide de qual gaveta sai a devolução em dinheiro (core.ts:15195-15197)',
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'], 'sales.returns.operate', 'pdv', true,
    'Decisão de CAIXA/LOCAL, não de perfil: hoje o único recorte é o token de dispositivo; login por senha escolhe qualquer caixa ativo da empresa. O desenho §6.3 lista esta linha entre os chamadores de terminalDoPedido que ganham requireTerminalNoEscopo. ESQUISITO: quem registra a devolução é o escritório (estoquista e atendente incluídos, com liberação), e nenhum dos dois tem pdv.cash.operate; a regra de §6.2 fala só das três capabilities de pdv. A F2(a) precisa dizer se o escopo de caixa vale para o dinheiro que SAI da gaveta numa devolução feita por quem não opera caixa. Com 0 caixas (a loja hoje) ou all_terminals = 1 (todos no passo 86), nada muda no dia 1.'],
  [15178, "perfisQuePodemDireto: ['gerente_loja', 'gerente_oficina']", 'atalho-admin', 'POST', '/sale-returns',
    "comLiberacaoPontual(req, { perfisQuePodemDireto: ['gerente_loja','gerente_oficina'], action: 'devolver_venda', refId: saleId }) — direto = admin_geral || gestor || perfisQuePodemDireto (core.ts:6213-6217); os demais precisam do bilhete de liberação preso à venda, senão 403 CORE_RETURN_NEEDS_AUTHORIZATION",
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], 'approval.sale_return', 'empresa', true,
    'Alçada pontual: um gerente libera sem transformar o estoquista/atendente em gerente, e a liberação é gasta uma vez e presa a ESTA venda. O atalho admin/gestor mora em comLiberacaoPontual (core.ts:6214-6216). Substituto: capabilityDireta = approval.sale_return (desenho §10, tabela "faz direto hoje": gerente_loja e gerente_oficina). Quem LIBERA (AUTHORIZERS, server/src/services/core/AuthorizationService.ts:21) é o mesmo conjunto. Igual no dia 1.'],
  [15668, 'workshopIds: resolveWorkshopScope(req)', 'servico', 'GET', '/workshop/parts', RWS,
    TODAS, 'workshop.parts.view', 'bancada', false,
    NOTA_RWS + ' Aqui recorta a gaveta: sem ele o mecânico de celulares via a gaveta de mobilidade (core.ts:15666-15667). O estoquista e o atendente, sem filiação, veem todas pelo fallback.'],
  [15670, 'hideCost: !podeVerCusto(profiles)', 'atalho-admin', 'GET', '/workshop/parts', PODE_CUSTO,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista'], 'workshop.parts.cost.view', 'bancada', true,
    'Checagem manual de perfil que nomeia admin_geral e gestor (VEEM_CUSTO). O custo é removido da resposta, não escondido na tela (core.ts:15653-15657). Entre os que passam na rota, o mecânico e o atendente não veem custo. Substituto exato: hideCost = !can(workshop.parts.cost.view) (desenho §8 #21).'],
  [15692, 'const alcance = resolveWorkshopScope(req)', 'servico', 'GET', '/workshop/parts/scan', RWS,
    TODAS, 'qualquer(workshop.parts.use, workshop.parts.manage)', 'bancada', false,
    NOTA_RWS + ' Peça de bancada fora do alcance volta como foraDoAlcance, não como "cadastre" (core.ts:15699-15704).'],
  [15715, 'if (!podeVerCusto(profiles)) delete item.cost_cents', 'atalho-admin', 'GET', '/workshop/parts/scan', PODE_CUSTO,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista'], 'workshop.parts.cost.view', 'bancada', true,
    'Mesmo VEEM_CUSTO de GET /workshop/parts: o mecânico bipa e não vê custo. Substituto: can(workshop.parts.cost.view). Igual no dia 1.'],
  [15867, 'workshopId: resolveWorkshopScope(req)', 'servico', 'POST', '/workshop/orders/:orderId/parts/:partId/return', RWS,
    TODAS, 'workshop.parts.use', 'bancada', false,
    NOTA_RWS + ' Aqui vira exigirOsNoAlcance: OS fora do alcance não é encontrada (server/src/services/core/WorkshopPartsService.ts:161).'],
  [15873, 'isManager: isManagerProfile(req)', 'atalho-admin', 'POST', '/workshop/orders/:orderId/parts/:partId/return',
    "isManagerProfile(req) — core.ts:7417-7424 (profileCodes inclui admin_geral, gestor ou gerente_oficina); sem ele, OS de outro técnico dá 403 CORE_ORDER_NOT_ASSIGNED_TO_YOU (server/src/services/core/WorkshopPartsService.ts:162-168)",
    ['admin_geral', 'gestor', 'gerente_oficina'], 'workshop.admin', 'bancada', true,
    'Atalho admin/gestor fora do guarda: quem é "gestor da oficina" devolve peça de OS atribuída a outro técnico. Substituto exato: can(workshop.admin) (desenho §7.3, §8 #16).'],
  [16434, 'operationsOverview({', 'servico', 'GET', '/insights/operations', BI_TRAV,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], 'reports.bi.view', 'empresa', true, NOTA_BI],
  [16450, 'topProducts({', 'servico', 'GET', '/insights/products', BI_TRAV,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], 'reports.bi.view', 'empresa', true, NOTA_BI],
  [16473, 'topBrands({', 'servico', 'GET', '/insights/brands', BI_TRAV,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], 'reports.bi.view', 'empresa', true, NOTA_BI],
  [16491, 'marginWhereReliable({', 'servico', 'GET', '/insights/margin', BI_TRAV,
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina'], 'reports.bi.view', 'empresa', true,
    NOTA_BI + ' A margem expõe custo: a pessoa só compara margem de empresa onde é gerente ou dona.'],
  [16595, 'respondePeloGrupo(userId)', 'atalho-admin', 'GET', '/loja/prontidao-do-dia-1',
    "empresas = respondePeloGrupo(userId) ? listCompaniesForUser(userId) : [companyId] — IdentityService.ts:390-403 (admin_geral/gestor em TODAS as ativas) e 352-363 (vínculos ativos)",
    ['admin_geral', 'gestor'], 'group.admin', 'grupo', true,
    'Checagem manual de profile_code (admin_geral, gestor). Quem responde pelo grupo vê a prontidão de todas as operações de uma vez; o gerente, só a da sessão (core.ts:16584-16590). Substituto: group.admin em todas as ativas (desenho §8 #8). listCompaniesForUser recorta por vínculo, e quem responde pelo grupo tem vínculo em todas, então a lista é o grupo. Igual no dia 1.'],
];

for (const [linha, ancora, tipo, metodo, caminho, guarda, perfis, cap, escopo, conferir, nota] of S) {
  if (!src[linha - 1].includes(ancora)) problemas.push({ linha, falta: `âncora "${ancora}" não está na linha` });
  let eq = null;
  if (conferir) {
    eq = igual(ORDEM.filter((p) => perfis.includes(p)), alcance(cap));
    if (!eq) problemas.push({ linha, caminho, hoje: perfis, novo: alcance(cap) });
  } else alcance(cap); // só confere que existe no catálogo
  saida.push({
    arquivo: 'server/src/routes/v1/core.ts',
    linha,
    tipo,
    metodo,
    caminho: `/core${caminho}`,
    guarda_hoje: guarda,
    perfis_hoje: ORDEM.filter((p) => perfis.includes(p)),
    capability: cap,
    escopo,
    nota: `${eq === true ? 'Equivalência dia 1: igual (conjunto de hoje = perfis_de_hoje da capability). ' : eq === null ? 'Decisão de escopo: perfis_hoje não se compara com a capability. ' : 'DESVIO. '}${nota}`,
  });
}

saida.sort((a, b) => a.linha - b.linha || (a.tipo === 'rota' ? -1 : 1));

// ------------------------------------------------------------------ conferências
const rotasFonte = [];
for (let i = INICIO - 1; i < src.length; i++) {
  if (/coreRouter\.(get|post|put|patch|delete)\(/.test(src[i])) rotasFonte.push(i + 1);
}
const linhasRota = new Set(saida.filter((s) => s.tipo === 'rota').map((s) => s.linha));
for (const l of rotasFonte) if (!linhasRota.has(l)) problemas.push({ linha: l, falta: 'rota do fonte sem entrada' });
for (const s of saida.filter((x) => x.tipo === 'rota')) {
  if (!src[s.linha - 1].includes(`coreRouter.${s.metodo.toLowerCase()}(`)) problemas.push({ linha: s.linha, falta: 'linha da rota não bate' });
  const t = porLinha.get(s.linha);
  if (!t || `/core${t[3]}` !== s.caminho || t[6] !== s.capability) problemas.push({ linha: s.linha, falta: 'difere do TSV' });
}
// guardas legadas no fonte da fatia: toda chamada requireProfile/abertaAo/requirePermission fora de comentário tem de estar coberta
const guardasFonte = [];
let emBloco = false;
for (let i = 0; i < src.length; i++) {
  let l = src[i];
  // tira comentário de bloco (pode abrir e fechar na mesma linha) e de linha
  let codigo = '';
  while (l.length) {
    if (emBloco) {
      const f = l.indexOf('*/');
      if (f < 0) { l = ''; break; }
      l = l.slice(f + 2); emBloco = false;
    } else {
      const a = l.indexOf('/*');
      const c = l.indexOf('//');
      if (c >= 0 && (a < 0 || c < a)) { codigo += l.slice(0, c); l = ''; break; }
      if (a < 0) { codigo += l; l = ''; break; }
      codigo += l.slice(0, a); l = l.slice(a + 2); emBloco = true;
    }
  }
  if (i < INICIO - 1) continue;
  if (/\b(requireProfile|abertaAo|requirePermission|rotaPublica)\(req/.test(codigo)) guardasFonte.push(i + 1);
}
const guardasCitadas = new Set(saida.filter((s) => s.tipo === 'rota').map((s) => Number(/core\.ts:(\d+)/.exec(s.nota)[1])));
for (const g of guardasFonte) if (!guardasCitadas.has(g)) problemas.push({ linha: g, falta: 'guarda do fonte não citada' });

writeFileSync(join(aqui, 'sites-core-7.json'), JSON.stringify(saida, null, 2) + '\n', 'utf8');
const porTipo = {};
for (const s of saida) porTipo[s.tipo] = (porTipo[s.tipo] || 0) + 1;
console.log(JSON.stringify({
  sites: saida.length, porTipo, rotasNoFonte: rotasFonte.length, rotasNoTsv: tsv.length,
  guardasNoFonte: guardasFonte.length, problemas,
}, null, 2));
