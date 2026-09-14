// Gera sites-core-3.json (fatia core.ts 4401-6600). Só lê catalogo.json; não toca no repositório.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
const DIR = PASTA_RBAC + '/';
const cat = JSON.parse(fs.readFileSync(DIR + 'catalogo.json', 'utf8'));
const CAT = new Map(cat.map((c) => [c.code, c]));
const F = 'server/src/routes/v1/core.ts';

const DONOS = ['admin_geral', 'gestor'];
const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'];
const LO = [...DONOS, 'gerente_loja', 'gerente_oficina'];
const L = [...DONOS, 'gerente_loja'];
const BG = [...DONOS, ...CAIXAS, 'gerente_loja', 'gerente_oficina'];
const BGT = [...BG, 'atendente'];
const ESC = [...DONOS, 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'];
const BE = [...DONOS, ...CAIXAS, 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'];
const SETTLE = [...LO, ...CAIXAS];

const G_BE = "abertaAo(req, 'balcao', 'escritorio')";
const G_ESC = "abertaAo(req, 'escritorio')";
const G_LO = "requireProfile(req, 'gerente_loja', 'gerente_oficina')";
const G_BG = 'requireProfile(req, ...BALCAO_E_GERENCIA)';
const G_BGT = "requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente')";
const G_DONOS = 'requireProfile(req)';

const rows = [];
function rota(linha, linha_rota, metodo, caminho, guarda_hoje, perfis_hoje, capability, escopo, nota) {
  rows.push({ arquivo: F, linha, linha_rota, tipo: 'rota', metodo, caminho: '/core' + caminho, guarda_hoje, perfis_hoje, capability, escopo, nota });
}
function servico(linha, tipo, rotaRef, guarda_hoje, perfis_hoje, capability, escopo, decisao_em, nota, extra = {}) {
  rows.push({ arquivo: F, linha, tipo, metodo: rotaRef?.[0], caminho: rotaRef ? '/core' + rotaRef[1] : undefined, guarda_hoje, perfis_hoje, capability, escopo, decisao_em, nota, ...extra });
}

// ------------------------------------------------------------------ fiscal / certificado / CSC
rota(4457, 4455, 'GET', '/fiscal/certificates/group', G_DONOS, DONOS, 'group.dashboard.view', 'grupo',
  'Painel dos certificados A1 do grupo, consumido pela página do certificado (src/lib/api/core.ts:5492; testes certificadoSeApresenta/certificadoSemSenhaSelada). O catálogo põe a rota em group.dashboard.view (a descrição da capability cita GET /core/fiscal/certificates/group). Dia 1 igual: DONOS. ESQUISITO: a página /sistema/fiscal/certificado tem pode = fiscal.certificate.manage. Um modelo do dono com fiscal.certificate.manage e sem group.dashboard.view abre a página e toma 403 no bloco "do grupo", então a tela precisa esconder o bloco com useCan(\'group.dashboard.view\'). O recorte de QUAIS empresas aparecem é outra decisão, na linha 4461.');
servico(4461, 'atalho-admin', ['GET', '/fiscal/certificates/group'], 'operacoesOndeOPerfilAbre(userId, []) — filtro das empresas do vínculo', DONOS, 'fiscal.certificate.manage', 'empresa',
  'server/src/services/auth/AlcanceCruzado.ts:27,38-56',
  'Travessia de empresa. Com lista vazia, operacoesOndeOPerfilAbre devolve as empresas ativas onde o vínculo DE LÁ é admin_geral/gestor (PERFIS_QUE_PASSAM_EM_TUDO, AlcanceCruzado.ts:27, 43), ou seja, é o atalho de admin fora do guarda. Substituto (desenho §8 item 6): operacoesOndeACapabilityAbre(userId, \'fiscal.certificate.manage\'), para que o A1 de uma empresa só apareça a quem pode gerir o A1 LÁ. É avaliado empresa a empresa, com o acesso da pessoa em cada uma. Dia 1 igual: fiscal.certificate.manage = {admin_geral, gestor}. Sem este filtro, um vínculo de mecânico noutra loja mostraria o A1 dela (GAP-PRD-084, comentário core.ts:4459-4460). Não usar group.dashboard.view aqui: essa capability é da empresa ATIVA (guarda da rota) e não diz nada sobre a empresa de destino.');
rota(4471, 4469, 'POST', '/fiscal/certificate/revoke', G_DONOS, DONOS, 'fiscal.certificate.manage', 'empresa',
  'Revoga o A1 da empresa do token, com auditoria (4479-4486). Mesma capability de GET/POST /fiscal/certificate (core.ts:4371/4382, fora desta fatia). Dia 1 igual.');
rota(4515, 4513, 'GET', '/fiscal/nfce/csc', "requireProfile(req, 'gerente_loja')", L, 'fiscal.csc.manage', 'empresa',
  'CSC da NFC-e: gerente_loja além dos donos, herdado do "escrever" do módulo fiscal legado (comentário 4505-4507). O gerente_oficina fica de fora, então, se a oficina emitir NFC-e, o gerente dela não configura o próprio CSC; é a decisão de hoje, preservada. A resposta sai sanitizada e o token nunca volta.');
rota(4525, 4523, 'POST', '/fiscal/nfce/csc', "requireProfile(req, 'gerente_loja')", L, 'fiscal.csc.manage', 'empresa',
  'Grava o CSC com Idempotency-Key obrigatória; a auditoria registra ambiente, cscId e unidade, nunca o token (4540-4551). Mesmo conjunto do GET.');

// ------------------------------------------------------------------ PIX do balcão (Asaas)
rota(4573, 4567, 'GET', '/pdv/pix-asaas/status', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Estado do PIX Asaas, lido pelo diálogo de pagamento do PDV e de Orçamentos (comentário 4569-4572). qualquer(pdv.sell, sales.view) reproduz balcão+escritório: pdv.sell cobre caixas, gerentes e atendente, e sales.view cobre o estoquista. O estoquista lê o estado mas não gera QR, o que é inofensivo.');
rota(4585, 4581, 'POST', '/pdv/pix-asaas', G_BGT, BGT, 'pdv.sell', 'pdv',
  'Gera o QR PIX com o mesmo alcance de POST /sales (comentário 4584). O escopo é pdv pela capability, mas o pedido não traz caixa: criarPixDoBalcao (4587-4595) não recebe terminalId. Não há o que requireTerminalNoEscopo conferir e vale só a capability, mesmo com vínculo restrito a uma lista de caixas. NÃO chamar requireTerminalNoEscopo aqui: a regra "lista + login por senha sem caixa → 409" do desenho §6.2 quebraria o QR.');
rota(4615, 4611, 'GET', '/pdv/pix-asaas/:id', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Consulta um PIX pelo id (?consultar=1 pergunta ao provedor). Não há recorte por caixa nem por autor.');
rota(4633, 4630, 'POST', '/pdv/pix-asaas/:id/cancel', G_BGT, BGT, 'pdv.sell', 'pdv',
  'Cancela o QR PIX. ESQUISITO: a rota não passa userId nem perfis ao serviço (cancelarPixDoBalcao({ companyId, intentId }), 4635), então qualquer vendedor da empresa cancela o PIX gerado por outro. É diferente de /pdv/terminal/:id/desistir, que confere o dono da cobrança (CobrancasSemVenda.ts:169-177). O pedido não traz caixa.');
rota(4657, 4655, 'GET', '/pdv/pix-pendentes', G_LO, LO, 'pdv.supervise', 'empresa',
  'Fila de PIX pendentes do balcão, lida pela tela Contas a receber (src/lib/api/pixBalcao.ts:66). A cobrança do que não caiu é da gerência (comentário 4651-4654). Dia 1 igual.');
rota(4670, 4665, 'POST', '/sales/:id/payments/:paymentId/confirmar', G_LO, LO, 'sales.supervise', 'empresa',
  'Afirmar que o dinheiro do PIX pendente entrou é da gerência (4668-4669); a descrição de sales.supervise cita esta rota. ESQUISITO: a fila vizinha (4655) é pdv.supervise e o botão que confirma é sales.supervise. No dia 1 os conjuntos são iguais, mas um modelo do dono com só uma das duas vê a fila e toma 403 ao confirmar, ou o contrário. A tela precisa guardar o botão com useCan(\'sales.supervise\').');

// ------------------------------------------------------------------ maquininha no PDV
rota(4702, 4696, 'GET', '/pdv/terminal/status', G_BE, BE, 'qualquer(pdv.payment.charge, sales.view)', 'pdv',
  'Estado da maquininha DO CAIXA (4704-4708), lido pelo diálogo de pagamento do PDV e de Orçamentos. qualquer(pdv.payment.charge, sales.view) reproduz balcão+escritório: o atendente entra por sales.view, porque não tem pdv.payment.charge. O caixa efetivo é decidido na linha 4706.');
servico(4706, 'servico', ['GET', '/pdv/terminal/status'], 'terminalDoPedido({ informado: req.query.terminalId, doDispositivo: req.auth?.storeId }) + assertTerminalDaEmpresa(companyId, caixa)', BE, 'qualquer(pdv.payment.charge, sales.view)', 'pdv',
  'server/src/services/core/TerminalRegistry.ts:41-111',
  'Escolhe o caixa: o do token vence o da query e a divergência dá 409. Hoje só confere que o caixa é da empresa e está ativo, não que ele pertence ao usuário (nenhum vínculo usuário↔caixa). É ponto de requireTerminalNoEscopo (desenho §6.3, core.ts:4696). ESQUISITO: o desenho §6.2 amarra o escopo de caixa às 3 capabilities pdv, mas aqui quem entra só por sales.view (estoquista, atendente) também informa caixa. É preciso decidir se ler o estado da maquininha de um caixa fora da lista é livre (é só leitura) ou se também respeita a lista.');
rota(4717, 4714, 'POST', '/pdv/terminal/charge', G_BG, BG, 'pdv.payment.charge', 'pdv',
  'Cobra no terminal de cartão com Idempotency-Key obrigatória (4719-4727). Dia 1 igual. O escopo de caixa é decidido na linha 4728.');
servico(4728, 'servico', ['POST', '/pdv/terminal/charge'], 'terminalDoPedido({ informado: req.body?.terminalId, doDispositivo: req.auth?.storeId }) + assertTerminalDaEmpresa(companyId, caixa)', BG, 'pdv.payment.charge', 'pdv',
  'server/src/services/core/TerminalRegistry.ts:41-111',
  'O caixa efetivo vira o pdvTerminalId da cobrança (4740). É ponto OBRIGATÓRIO de requireTerminalNoEscopo: um operador com lista de caixas não pode cobrar na maquininha de outro caixa. Hoje não há conferência usuário↔caixa, só empresa/ativo.');
rota(4751, 4749, 'GET', '/pdv/terminal/uncertain', G_LO, LO, 'pdv.supervise', 'empresa',
  'Cobranças sem resposta de todos os caixas. É mais estreita que /pdv/terminal/:id de propósito (comentário 4928-4930). Dia 1 igual.');
rota(4770, 4768, 'GET', '/pdv/terminal/pendencias', G_LO, LO, 'pdv.supervise', 'empresa',
  'Dinheiro da maquininha sem dono e estornos a fazer (GAP-PRD-078/080), consumido por src/lib/api/maquininhas.ts:62. Dia 1 igual.');
rota(4793, 4790, 'POST', '/pdv/terminal/:id/desistir', G_BG, BG, 'pdv.payment.charge', 'pdv',
  'Desistir da cobrança. A rota abre para quem cobra; a regra "só a sua cobrança, a do colega é do gestor" mora no serviço (linha 4794). O caixa da cobrança não é conferido contra o escopo do vínculo: com lista de caixas, é preciso conferir o pdv_terminal_id da transação.');
servico(4794, 'servico', ['POST', '/pdv/terminal/:id/desistir'], "desistirDaCobranca({ profiles: scope(req).profiles }) → GESTORES = {gerente_loja, gerente_oficina, admin_geral, gestor}", LO, 'pdv.supervise', 'empresa',
  'server/src/services/core/CobrancasSemVenda.ts:53,169-177',
  'Decisão por código de perfil dentro do serviço. Quem está em GESTORES desiste da cobrança de qualquer operador; os demais só da própria (tx.createdBy === userId), senão 403 CORE_TERMINAL_DESISTIR_NOT_OWNER. A lista traz admin_geral/gestor escritos à mão, o que é um atalho de admin embutido (desenho §8 item 22). Vira can(\'pdv.supervise\'), com o mesmo conjunto no dia 1. O campo byManager da auditoria (CobrancasSemVenda.ts:192) passa a sair da mesma capability.');
rota(4812, 4810, 'POST', '/pdv/terminal/:id/tratativa', G_LO, LO, 'pdv.supervise', 'empresa',
  'Registrar o que foi feito com uma cobrança sem venda é decisão sobre o dinheiro da operadora, da gerência. Dia 1 igual.');
rota(4829, 4827, 'POST', '/pdv/terminal/:id/vincular-venda', G_LO, LO, 'pdv.supervise', 'empresa',
  'Ligar a cobrança órfã a uma venda, da gerência. Dia 1 igual.');
rota(4852, 4850, 'POST', '/pdv/terminal/:id/estorno-manual', G_LO, LO, 'pdv.supervise', 'empresa',
  'O gestor afirma que o estorno da venda desfeita foi feito no aparelho (GAP-PRD-080). Dia 1 igual.');
rota(4881, 4879, 'GET', '/pdv/terminal/configurations', G_LO, LO, 'pdv.terminal.activation', 'empresa',
  'Maquininhas da operação para ligar/desligar (GAP-PRD-001). Desligar tira a exigência de cobrança aprovada, e o caixa não pode tirar do caminho a regra que confere o próprio trabalho (comentário 4872-4874). Dia 1 igual.');
rota(4891, 4889, 'POST', '/pdv/terminal/configurations/:id/deactivate', G_LO, LO, 'pdv.terminal.activation', 'empresa',
  'Desliga a maquininha, com motivo. Dia 1 igual.');
rota(4909, 4907, 'POST', '/pdv/terminal/configurations/:id/activate', G_LO, LO, 'pdv.terminal.activation', 'empresa',
  'Liga a maquininha, com motivo. Dia 1 igual.');
rota(4932, 4925, 'GET', '/pdv/terminal/:id', G_BE, BE, 'qualquer(pdv.payment.charge, sales.view)', 'empresa',
  'Uma cobrança da maquininha pelo id, de qualquer caixa da empresa, sem recorte por caixa nem por autor (getTerminalPayment(companyId, id), 4934). O estoquista e o atendente leem por sales.view.');
rota(4952, 4950, 'POST', '/pdv/terminal/:id/confirmar-teste', G_BG, BG, 'pdv.payment.charge', 'pdv',
  'Confirma um PIX no provedor de TESTE; o serviço recusa fora do mock (comentário 4941-4945). Não confere caixa nem autor: o transactionId de outro caixa também é confirmado. Só vale em homologação.');
rota(4965, 4962, 'POST', '/pdv/terminal/:id/reconcile', G_LO, LO, 'pdv.supervise', 'empresa',
  'Afirmar o que a operadora fez é decisão de gestor, não do balcão (4964). Dia 1 igual.');

// ------------------------------------------------------------------ orçamento e pré-venda
rota(4990, 4983, 'GET', '/quotes', G_BE, BE, 'qualquer(sales.quotes.manage, sales.view)', 'empresa',
  'Orçamentos e pré-vendas nascem no balcão e são revistos na gestão (comentário 4986-4988). qualquer(sales.quotes.manage, sales.view) = caixas + gerentes + atendente ∪ estoquista, que é exatamente balcão+escritório.');
rota(5011, 5008, 'GET', '/quotes/:id', G_BE, BE, 'qualquer(sales.quotes.manage, sales.view)', 'empresa',
  'Documento aberto, para converter; mesmo alcance da lista (5010).');
rota(5023, 5021, 'POST', '/quotes', G_BGT, BGT, 'sales.quotes.manage', 'empresa',
  'Escrever o orçamento. A alçada de desconto é decidida dentro do serviço (linha 5050). Tela coerente: OrcamentosPage.tsx:420 podeEscrever = BALCAO_E_GERENCIA + atendente.');
servico(5050, 'servico', ['POST', '/quotes'], "createQuote({ alcada: { profileCodes: scope(req).profiles } }) → discountNeedsAuthorization → temAlcadaParaLiberar → AUTHORIZERS", LO, 'approval.discount', 'empresa',
  'server/src/services/core/QuoteService.ts:411-419; server/src/services/core/AuthorizationService.ts:21,130-132,775-789',
  'Alçada de desconto por código de perfil. Quem está em AUTHORIZERS = {admin_geral, gestor, gerente_loja, gerente_oficina} concede desconto acima do limite da política SEM bilhete; os demais precisam de authorizationId de outro gestor. A lista nomeia admin_geral/gestor à mão (desenho §8 item 13). Vira can(\'approval.discount\'), que no dia 1 é o mesmo conjunto. O serviço precisa receber o acesso (capabilities), não a lista de perfis.');
rota(5073, 5071, 'POST', '/quotes/:id/convert', G_BG, BG, 'todas(sales.quotes.manage, pdv.cash.operate)', 'pdv',
  'Converter em VENDA: BALCAO_E_GERENCIA sem o atendente, e é pdv.cash.operate que exclui o atendente (a venda entra na gaveta). O escopo é pdv, mas o pedido traz cashSessionId (5086) e nenhum terminalId: convertQuote chama createSale só com a sessão (QuoteService.ts:1445-1461). requireTerminalNoEscopo precisa ler o terminal_id da SESSÃO de caixa. Não há alçada aqui (a conversão não mede de novo, comentário 5087-5099; QuoteService.ts:1438). Tela coerente: OrcamentosPage.tsx:421 podeFechar = BALCAO_E_GERENCIA.');
rota(5149, 5147, 'PUT', '/quotes/:id/unidades', G_BGT, BGT, 'sales.quotes.manage', 'empresa',
  'Segura o chassi da pré-venda (GAP-PRD-111), com os mesmos perfis que escrevem o documento (5142-5146).');
rota(5187, 5185, 'POST', '/quotes/:id/promote', G_BGT, BGT, 'sales.quotes.manage', 'empresa',
  'Aprovar orçamento vira pré-venda, com vencimento pela política. A alçada vale só para documento nunca conferido (linha 5227).');
servico(5227, 'servico', ['POST', '/quotes/:id/promote'], "promoteToPreSale({ alcada: { profileCodes: scope(req).profiles } }) → createQuote → temAlcadaParaLiberar", LO, 'approval.discount', 'empresa',
  'server/src/services/core/QuoteService.ts:1752-1765,414; server/src/services/core/AuthorizationService.ts:130-132',
  'A alçada só desce quando o documento nunca foi conferido (nuncaConferido), e falha fechada com profileCodes vazio (QuoteService.ts:1758-1765). É a mesma régua AUTHORIZERS de 5050 e vira can(\'approval.discount\').');
rota(5247, 5245, 'POST', '/quotes/:id/cancel', G_BG, BG, 'todas(sales.quotes.manage, pdv.cash.operate)', 'empresa',
  'Cancelar orçamento: BALCAO_E_GERENCIA sem o atendente, que cria, edita e renova mas não cancela, como hoje. ESQUISITO: pdv.cash.operate entra só para excluir o atendente (coincidência de conjunto); cancelQuote (5249-5253) não toca gaveta nem caixa. Com o escopo de pdv do desenho (§6.2, "lista + login por senha sem caixa → 409 CORE_TERMINAL_REQUIRED"), um vínculo com lista de caixas levaria 409 ao cancelar um orçamento no escritório. Então: pdv.cash.operate aqui SEM requireTerminalNoEscopo. A alternativa limpa seria uma capability própria (FALTA:sales.quotes.close), mas a expressão do mapa já é equivalente no dia 1. Tela coerente: OrcamentosPage.tsx:421.');
rota(5269, 5267, 'POST', '/quotes/expire-overdue', G_LO, LO, 'sales.supervise', 'empresa',
  'Expirar pré-vendas vencidas (solta reserva de estoque), da gerência. Tela: OrcamentosPage.tsx:422 podeLiberarVencidos = gerentes. Dia 1 igual.');
rota(5291, 5289, 'PATCH', '/quotes/:id', G_BGT, BGT, 'sales.quotes.manage', 'empresa',
  'Editar o documento aberto (GAP-V66), com os mesmos perfis da criação (5280-5287). A alçada é decidida na linha 5313.');
servico(5313, 'servico', ['PATCH', '/quotes/:id'], "updateQuote({ alcada: { profileCodes: scope(req).profiles } }) → temAlcadaParaLiberar", LO, 'approval.discount', 'empresa',
  'server/src/services/core/QuoteService.ts:414; server/src/services/core/AuthorizationService.ts:130-132',
  'A edição reescreve preço e desconto, então a alçada desce igual à criação (5286-5287). É a mesma régua AUTHORIZERS e vira can(\'approval.discount\').');
rota(5339, 5337, 'POST', '/quotes/:id/renew', G_BGT, BGT, 'sales.quotes.manage', 'empresa',
  'Renovar a validade (GAP-V66). Não mexe em preço, item nem reserva, então não há alçada (5333-5335).');

// ------------------------------------------------------------------ consignação
rota(5378, 5376, 'GET', '/consignments', G_BE, BE, 'qualquer(sales.consignment.manage, sales.view)', 'empresa',
  'Leitura de consignações com o mesmo alcance de GET /quotes (comentário 5363-5365). Fechada ao contador (5373-5374).');
rota(5394, 5392, 'GET', '/consignments/:id', G_BE, BE, 'qualquer(sales.consignment.manage, sales.view)', 'empresa',
  'Uma consignação; mesmo alcance da lista.');
rota(5408, 5406, 'POST', '/consignments', G_BGT, BGT, 'sales.consignment.manage', 'empresa',
  'Remessa: tira mercadoria do saldo sem venda, com Idempotency-Key obrigatória (5421-5425). É o mesmo balcão que escreve orçamento (5366-5367).');
rota(5450, 5448, 'POST', '/consignments/:id/retorno', G_BGT, BGT, 'sales.consignment.manage', 'empresa',
  'Retorno da mercadoria, com Idempotency-Key obrigatória. Mesmo conjunto da remessa.');
rota(5482, 5480, 'POST', '/consignments/:id/faturar', G_BG, BG, 'todas(sales.consignment.manage, pdv.cash.operate)', 'pdv',
  'Faturar cria VENDA: BALCAO_E_GERENCIA sem o atendente, como a conversão de orçamento (5368-5369), e é pdv.cash.operate que exclui o atendente. faturarConsignacao chama createSale com cashSessionId (5496; ConsignmentService.ts:844-869), sem terminalId e sem alcada (preço congelado na remessa). O escopo de caixa precisa sair do terminal_id da sessão.');
rota(5507, 5505, 'POST', '/consignments/:id/fechar', G_BG, BG, 'todas(sales.consignment.manage, pdv.cash.operate)', 'empresa',
  'Fechar é dar por encerrada a custódia (5370-5371). ESQUISITO: pdv.cash.operate só exclui o atendente; fecharConsignacao (5509) não toca gaveta nem caixa, então vale a mesma armadilha do 409 de 5245: não chamar requireTerminalNoEscopo. ERRO NO DESENHO: o §6.3 lista "core.ts:5505 (fechar consignação)" como chamador de terminalDoPedido, e não é. O _inventario.mjs atribuiu a esta rota o terminalDoPedido do helper vendaDoCorpo (core.ts:5536), que fica entre 5505 e 5568. A rota fechar não lê caixa; os chamadores reais são POST /sales, /offline-sales/:id/relaunch e /offline-sales/:id/relaunch-as-new.');

// ------------------------------------------------------------------ vendas
servico(5536, 'servico', ['POST', '/sales'], 'vendaDoCorpo: terminalDoPedido({ informado: corpo?.terminalId, doDispositivo: req.auth?.storeId }) → createSale.terminalId', BGT, 'pdv.sell', 'pdv',
  'server/src/services/core/TerminalRegistry.ts:92-111; server/src/services/core/GavetaDoDinheiro.ts',
  'Helper único do corpo da venda (5526-5566). Serve POST /sales (5606), POST /offline-sales/:id/relaunch (5719, terminalId do corpo em 5716) e POST /offline-sales/:id/relaunch-as-new (5787, terminalId em 5784). É ponto OBRIGATÓRIO de requireTerminalNoEscopo com pdv.sell, junto com a régua da gaveta. Hoje só confere empresa/ativo, sem vínculo usuário↔caixa.');
servico(5562, 'servico', ['POST', '/sales'], "vendaDoCorpo: createSale({ alcada: { profileCodes: scope(req).profiles } }) → discountNeedsAuthorization → AUTHORIZERS", LO, 'approval.discount', 'empresa',
  'server/src/services/core/SalesService.ts:1231-1236; server/src/services/core/AuthorizationService.ts:21,130-132,775-789',
  'Alçada de desconto na venda, medida contra o preço vigente do servidor (comentário 5583-5605). Quem está em AUTHORIZERS vende acima do limite sem bilhete; os demais consomem a liberação na transação da venda. Serve as três rotas de venda (5568, 5704, 5766). Vira can(\'approval.discount\').');
rota(5570, 5568, 'POST', '/sales', G_BGT, BGT, 'pdv.sell', 'pdv',
  'Vender, com Idempotency-Key obrigatória e chave do servidor recusada (5574-5581). O escopo de caixa é decidido na linha 5536 e a alçada na 5562. PORTA QUE BATE NA CARA (mudança D4 do desenho): o estoquista abre o PDV na tela (environments.ts:169, navItems.ts:472, segundo o desenho) e toma 403 aqui no Finalizar; a D4 fecha na tela. O atendente vende sem pdv.cash.operate, isto é, vende na gaveta aberta por outro.');
rota(5667, 5663, 'GET', '/offline-sales', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Vendas offline recusadas: qualquer caixa vê a venda presa de outro caixa e o gestor vê todas (5665-5666). Sem recorte por caixa, nem com escopo de caixa.');
rota(5686, 5683, 'POST', '/offline-sales', G_BGT, BGT, 'pdv.sell', 'pdv',
  'O PDV entrega ao servidor a venda que ele recusou, com o mesmo alcance de POST /sales (5685). Não lê caixa: registrar a pendência não precisa de escopo de caixa (quem precisa é o relançamento). Não chamar requireTerminalNoEscopo aqui.');
rota(5708, 5704, 'POST', '/offline-sales/:id/relaunch', G_BGT, BGT, 'pdv.sell', 'pdv',
  'Relançar é VENDER, com a mesma régua de POST /sales (5706-5707): o terminalId do corpo (5716) desce a vendaDoCorpo (5536), e ali o escopo de caixa e a alçada são decididos.');
rota(5768, 5766, 'POST', '/offline-sales/:id/relaunch-as-new', G_BGT, BGT, 'pdv.sell', 'pdv',
  'Relançar como venda nova (RES-IDEM-TELA), com o mesmo alcance do relançamento. Exige gaveta aberta (5777-5783), e o terminalId do corpo (5784) desce a vendaDoCorpo.');
rota(5831, 5827, 'POST', '/offline-sales/:id/discard', G_LO, LO, 'sales.supervise', 'empresa',
  'Descartar é dizer que a venda com dinheiro recebido não existe: decisão da gerência, com motivo e trilha (5829-5830). Dia 1 igual.');

// ------------------------------------------------------------------ alçada pontual
rota(5871, 5869, 'GET', '/authorizations/quem-libera', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Quem libera aqui (GAP-PRD-054), aberta a quem PEDE liberação (balcão) e a quem monta a equipe (escritório), comentário 5866-5867. Devolve só nomes e perfis, nunca o login. Quem aparece na lista é decidido na linha 5873.');
servico(5873, 'servico', ['GET', '/authorizations/quem-libera'], "quemLiberaNaOperacao(companyId): profile_code IN AUTHORIZERS; 'da operação' = AUTORIZADORES_DA_OPERACAO {gerente_loja, gerente_oficina}; 'do grupo' = o resto (admin_geral, gestor)", LO, 'qualquer(approval.discount, approval.cash_withdrawal, approval.cash_reopen, approval.sale_cancel, approval.sale_return)', 'empresa',
  'server/src/services/core/AuthorizationService.ts:21,135,155-176',
  'Não é guarda de quem pede, mas é decisão por código de perfil: define quem aparece como liberador. Vira "contas ativas com qualquer approval.* nesta empresa"; "do grupo" = quem tem group.admin, e "da operação" = os demais (desenho §10). O cartão da tela passa a mostrar o nome do modelo, não o código. Dia 1 igual.');
rota(5899, 5885, 'POST', '/authorizations', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Pedir liberação. O guarda existe para a rota não virar oráculo de senha de gestor para quem está fora do balcão/escritório, como o mecânico ou um perfil desconhecido (comentário 5888-5898). A alçada do LIBERADOR é conferida dentro (linha 5916). O caixa registrado vem do token (5945), nunca do corpo, e o escopo de caixa não se aplica ao liberador (desenho §10).');
const ACOES = [
  ['desconto_acima_limite', 'approval.discount'],
  ['sangria_especial', 'approval.cash_withdrawal'],
  ['reabrir_caixa', 'approval.cash_reopen'],
  ['cancelar_venda', 'approval.sale_cancel'],
  ['devolver_venda', 'approval.sale_return'],
];
for (const [acao, cap] of ACOES) {
  servico(5916, 'servico', ['POST', '/authorizations'], `authorizeAction({ action: '${acao}' }): assertMembership(liberador, companyId) && AUTHORIZERS.has(membership.profile_code)`, LO, cap, 'empresa',
    'server/src/services/core/AuthorizationService.ts:21,71-77,297-314',
    `Alçada do LIBERADOR na ação '${acao}'. O liberador (login + senha Argon2id) precisa de vínculo NESTA empresa com profile_code em AUTHORIZERS (AuthorizationService.ts:297-305); a auto-liberação é recusada (307-314). Hoje a lista não depende da ação: qualquer autorizador libera qualquer uma das 5 ações de RESTRICTED_ACTIONS. O desenho §10 separa uma capability por ação; esta linha é a da ação '${acao}' → ${cap}. É o mesmo ponto de código das outras 4 linhas 5916. Na resolução, a capability é a do acesso do liberador na empresa da venda (capabilitiesDe(userId, companyId)), não a de quem pede. Dia 1 igual (as 5 approval.* = {admin_geral, gestor, gerente_loja, gerente_oficina}).`,
    { acao });
}
rota(5992, 5990, 'GET', '/authorizations', G_DONOS, DONOS, 'audit.view', 'empresa',
  'Diário das liberações de gestor. Foi estreitado aos donos de propósito, porque o vigiado não lê a própria vigilância (comentário 5979-5988), o mesmo recorte de GET /audit. A descrição de audit.view cita GET /core/authorizations; a tela é a seção "Liberações de gestor" de AuditoriaPage (AuditoriaPage.tsx:313). Dia 1 igual.');
rota(6021, 6013, 'GET', '/sales/discount-policy', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Limite de desconto do operador, para o PDV saber quando pedir liberação (6005-6011). O campo canAuthorizeSelf é decidido na linha 6025.');
servico(6025, 'servico', ['GET', '/sales/discount-policy'], 'canAuthorizeSelf: temAlcadaParaLiberar(scope(req).profiles) → AUTHORIZERS', LO, 'approval.discount', 'empresa',
  'server/src/services/core/AuthorizationService.ts:21,130-132',
  'Diz à tela que quem já tem alçada não pede liberação para si. A lista AUTHORIZERS nomeia admin_geral/gestor à mão. Vira can(\'approval.discount\') (desenho §10, "canAuthorizeSelf de GET /sales/discount-policy (core.ts:6025)"). Dia 1 igual.');

// ------------------------------------------------------------------ política comercial do balcão
rota(6049, 6047, 'GET', '/sale-policies', G_LO, LO, 'settings.sale_policy.manage', 'empresa',
  'Política do balcão, de quem responde pela margem (6041-6045). ESQUISITO, de hoje e mantido: a casca da tela abre ao escritório inteiro (comentário 6034-6040; desenho §11.2 pode = qualquer(settings.sale_policy.manage, sales.view)) e este GET dá 403 ao estoquista e ao atendente, então a tela explica em vez de mostrar. O PDV lê o limite por /sales/discount-policy (6013), não por aqui.');
rota(6058, 6056, 'PUT', '/sale-policies', G_LO, LO, 'settings.sale_policy.manage', 'empresa',
  'Salvar a política. O operador de caixa não entra: quem edita o próprio limite não tem limite (6043-6045). A auditoria grava o estado final (6076-6093). Dia 1 igual.');

// ------------------------------------------------------------------ vendas (leitura) e cancelamento
rota(6111, 6101, 'GET', '/sales', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'Lista de vendas: PDV (últimas vendas do turno) + Vendas/Devoluções (6104-6110). ESQUISITO (ressalva do cenário A): o caixa lê TODAS as vendas da empresa, de todos os caixas e datas, sem recorte por turno ou caixa. O escopo de caixa do desenho não filtra esta leitura (§6.3 filtra só gavetas, sessões e terminais). Se o dono quiser o caixa vendo só as suas, falta regra. A bancada (mecânico) fica de fora.');
rota(6152, 6145, 'GET', '/sales/:id', G_BE, BE, 'qualquer(pdv.sell, sales.view)', 'empresa',
  'A venda item a item, com o mesmo alcance da lista (6147-6151).');
servico(6215, 'atalho-admin', ['POST', '/sales/:id/cancel'], "comLiberacaoPontual: direto = profiles.includes('admin_geral') || profiles.includes('gestor') || opcoes.perfisQuePodemDireto.some(...)", L, 'sales.cancel.direct', 'empresa',
  'server/src/routes/v1/core.ts:6200-6257',
  'ATALHO DE ADMIN explícito fora do guarda (desenho §8 item 14). O helper é genérico: o parâmetro perfisQuePodemDireto vira capabilityDireta por rota, e o atalho admin_geral||gestor sai sem perda, porque as três capabilities diretas já estão no modelo de catálogo inteiro. Nesta fatia o único chamador é 6287 → sales.cancel.direct, que é a capability registrada aqui. Fora da fatia: core.ts:15178 (POST /sale-returns) → approval.sale_return e core.ts:10286 (POST /workshop/orders/:id/estorno) → workshop.checkout.refund. O desenho §8 diz que o helper pertence à fatia (f) da F2 e entra primeiro.');
servico(6242, 'servico', ['POST', '/sales/:id/cancel'], "comLiberacaoPontual, segunda porta: sem direto → exige req.body.authorizationId; consumirLiberacaoDeAcao({ action: 'cancelar_venda', refType: 'sale', refId, requestedBy })", ['gerente_oficina', 'estoquista', 'atendente'], 'approval.sale_cancel', 'empresa',
  'server/src/routes/v1/core.ts:6223-6256; server/src/services/core/AuthorizationService.ts:514 (consumirLiberacaoDeAcao)',
  'Quem alcança a rota mas não faz direto (hoje gerente_oficina, estoquista e atendente) só passa com um bilhete de cancelar_venda emitido por OUTRO usuário com alçada na mesma empresa. O bilhete fica preso a ESTA venda, é gasto na transação e volta intacto se a ação falhar. Sem bilhete: 403 CORE_CANCEL_NEEDS_AUTHORIZATION, com action e referenceId (6226-6238). A capability que conta é approval.sale_cancel do LIBERADOR, conferida na emissão (linha 5916), e não de quem pede. perfis_hoje aqui são os que usam a porta, por isso a equivalência não se aplica.');
rota(6276, 6259, 'POST', '/sales/:id/cancel', G_ESC, ESC, 'sales.returns.operate', 'empresa',
  'Pedir cancelamento, com o alcance da DevolucoesPage (escritório), comentário 6262-6275. Os caixas não alcançam, nem com bilhete. Quem faz direto é decidido nas linhas 6215/6287; o bilhete, na 6242; o caixa, na 6279. ESQUISITO, de hoje e preservado pelo desenho §10: gerente_oficina tem alçada para liberar o cancelamento de OUTROS (approval.sale_cancel), mas não cancela direto (só gerente_loja, 6287). Para cancelar a própria venda ele precisa de outro gestor.');
servico(6279, 'servico', ['POST', '/sales/:id/cancel'], 'terminalDoPedido({ informado: req.body?.terminalId, doDispositivo: req.auth?.storeId }) → cancelSale.terminalId', ESC, 'sales.returns.operate', 'pdv',
  'server/src/services/core/TerminalRegistry.ts:92-111',
  'Escolhe de qual gaveta sai o dinheiro de turno já fechado (GAP-PRD-161, 6301-6303). O desenho §6.3 põe este ponto em requireTerminalNoEscopo, mas o §6.2 amarra o escopo de caixa só às 3 capabilities pdv, e a capability desta rota é de empresa (sales.returns.operate). É preciso definir que, com caixa informado e vínculo com lista, o caixa tem de estar no escopo; sem caixa, vale a regra da gaveta. Estoquista e atendente entram por login de senha, sem storeId, e o caixa vem do corpo.');
servico(6287, 'servico', ['POST', '/sales/:id/cancel'], "comLiberacaoPontual({ perfisQuePodemDireto: ['gerente_loja'], action: 'cancelar_venda' })", L, 'sales.cancel.direct', 'empresa',
  'server/src/routes/v1/core.ts:6284-6305',
  'Quem cancela sem pedir senha: gerente_loja, mais admin_geral/gestor pelo atalho da linha 6215. É exatamente sales.cancel.direct = {admin_geral, gestor, gerente_loja}, então o parâmetro vira capabilityDireta: \'sales.cancel.direct\'. Dia 1 igual.');

// ------------------------------------------------------------------ financeiro
rota(6353, 6346, 'GET', '/finance/entries', G_ESC, ESC, 'finance.view', 'empresa',
  'Contas a pagar/receber, lidas pelas telas Contas e Financeiro (6348-6352). O estoquista e o atendente leem o financeiro inteiro da empresa (finance.view); é o de hoje. Balcão e bancada ficam de fora.');
rota(6421, 6419, 'POST', '/finance/entries', G_LO, LO, 'finance.manage', 'empresa',
  'Lançar conta, inclusive carnê parcelado. Auditado com o total combinado (6440-6457). Dia 1 igual.');
rota(6470, 6464, 'GET', '/finance/entries/:id/settlements', G_ESC, ESC, 'finance.view', 'empresa',
  'Baixas de um lançamento, com o mesmo alcance da lista (6467-6468).');
rota(6480, 6478, 'POST', '/finance/entries/:id/settle', "requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS)", SETTLE, 'qualquer(finance.manage, pdv.cash.operate)', 'empresa',
  'Baixar lançamento: gerência + os três caixas (carnê recebido no balcão; comentário da constante CAIXAS em core.ts:914-921). pdv.cash.operate entra como sinônimo de "caixa". settleEntry (6488-6496) não recebe caixa nem sessão, então o dinheiro recebido no balcão não passa pela gaveta. Vale a mesma armadilha do 409: não chamar requireTerminalNoEscopo aqui. O estoquista e o atendente veem Contas (finance.view) e o servidor lhes nega a baixa (conferir o botão na tela, fora da fatia).');
rota(6518, 6515, 'POST', '/finance/settlements/:id/reverse', G_LO, LO, 'finance.manage', 'empresa',
  'O estorno de baixa desfaz dinheiro já registrado como recebido: é decisão de gestão (6517). Os caixas, que baixam, não estornam. Dia 1 igual.');
rota(6547, 6545, 'GET', '/finance/cash-flow', G_LO, LO, 'finance.advanced.view', 'empresa',
  'Fluxo de caixa projetado (GAP-PRD-094), da gerência. O estoquista e o atendente (finance.view) ficam de fora. Dia 1 igual.');
rota(6574, 6572, 'GET', '/finance/legacy-settlements', G_LO, LO, 'finance.advanced.view', 'empresa',
  'Quitações antigas sem baixa (GAP-PRD-171), leitura da gerência (tela via src/lib/api/baixasLegadas.ts:36). O mapa usa finance.advanced.view na leitura e finance.manage no espelho. Dia 1 igual.');
rota(6584, 6582, 'POST', '/finance/legacy-settlements/mirror', G_LO, LO, 'finance.manage', 'empresa',
  'Cria baixas-espelho das quitações legadas: exige confirm:true e grava a trilha (6591-6599). Dia 1 igual.');

// ------------------------------------------------------------------ equivalência dia 1 pelo catálogo
function alcance(expr) {
  const m = expr.match(/^(qualquer|todas)\((.*)\)$/);
  const codes = m ? m[2].split(',').map((s) => s.trim()) : [expr];
  const sets = codes.map((c) => {
    const e = CAT.get(c);
    if (!e) throw new Error('capability fora do catálogo: ' + c);
    return new Set(e.perfis_de_hoje);
  });
  if (!m || m[1] === 'qualquer') return [...new Set(sets.flatMap((s) => [...s]))].sort();
  return [...sets[0]].filter((p) => sets.every((s) => s.has(p))).sort();
}
for (const r of rows) {
  r.perfis_hoje = [...new Set(r.perfis_hoje)].sort();
  if (r.linha === 6242) { r.equivalencia_dia1 = 'n/a (porta do bilhete: perfis_hoje são quem pede, a capability é do liberador)'; continue; }
  const a = alcance(r.capability);
  r.equivalencia_dia1 = JSON.stringify(a) === JSON.stringify(r.perfis_hoje) ? 'igual' : 'DIFERENTE: novo=' + a.join(',');
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
}
fs.writeFileSync(DIR + 'sites-core-3.json', JSON.stringify(rows, null, 2) + '\n', 'utf8');
console.log('linhas', rows.length);
