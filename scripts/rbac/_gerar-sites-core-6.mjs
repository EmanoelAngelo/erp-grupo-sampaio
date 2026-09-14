// Gera sites-core-6.json (fatia core.ts 11001-13200) e confere a equivalência
// de cada expressão contra catalogo.json. Só lê o catálogo; não toca no repo.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const catalogo = JSON.parse(readFileSync(join(aqui, 'catalogo.json'), 'utf8'));
const porCode = new Map(catalogo.map((c) => [c.code, c]));

const L = {
  C: 'operador_caixa', CL: 'operador_caixa_loja', CO: 'operador_caixa_oficina',
  E: 'estoquista', L: 'gerente_loja', M: 'mecanico', O: 'gerente_oficina',
  T: 'atendente', K: 'contador',
};
const ORDEM = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente',
  'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina', 'mecanico', 'contador'];
const expandir = (letras) => {
  const s = new Set(['admin_geral', 'gestor', ...letras.split(',').map((x) => L[x.trim()])]);
  return ORDEM.filter((p) => s.has(p));
};
const alcance = (expr) => {
  const m = /^qualquer\((.*)\)$/.exec(expr);
  const codes = m ? m[1].split(',').map((x) => x.trim()) : [expr];
  const s = new Set();
  for (const c of codes) {
    const cap = porCode.get(c);
    if (!cap) throw new Error(`capability fora do catálogo: ${c}`);
    for (const p of cap.perfis_de_hoje) s.add(p);
  }
  return ORDEM.filter((p) => s.has(p));
};

const RP_LO = "requireProfile(req, 'gerente_loja', 'gerente_oficina')";
const RP_LOE = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')";
const RP_DOCA = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')";
const DOCA = 'qualquer(purchases.receive, pdv.backoffice)';
const NOTA_DOCA = 'A tela que consome é Entrada de notas (/sistema/compras/entrada-notas, ROTA_GESTAO, src/router/gsRoutes.tsx:455), à qual o caixa não chega (comentário em src/components/gs/navItems.ts:223-229); os dois caixas por operação alcançam a rota pela API, e é isso que pdv.backoffice ("entrada de NF-e/CT-e pelo balcão") preserva. O legado operador_caixa fica de fora hoje e continua fora (pdv.backoffice não o tem).';
const NOTA_CUSTO_NOTA = ' ESQUISITO: os itens da nota levam unitCostCents (server/src/services/core/NfeImportService.ts:90, 1205), isto é, o CUSTO de compra, e chegam aos caixas e ao estoquista sem passar por inventory.cost.view nem pela política veCustoDoEstoque (server/src/services/core/PoliticaDeGestaoService.ts:159-171). Hoje é assim; a tradução não muda, mas o dono deve saber que pdv.backoffice/purchases.receive entregam custo.';

// [linhaRota, linhaGuarda, metodo, caminho, guarda, letras, capability, escopo, nota]
const R = [
  // ---------------------------------------------------------------- operadoras
  [11002, 11004, 'GET', '/acquirers', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Taxas e prazos das operadoras, mais as formas de pagamento. Único consumidor: tela Operadoras de cartão (src/lib/api/core.ts:5104; /sistema/financeiro/operadoras com QUEM_GERENCIA_A_OPERACAO, src/router/gsRoutes.tsx:408-413). Mesmo conjunto de hoje.'],
  [11016, 11018, 'POST', '/acquirers', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Cadastra operadora; audita acquirer.create (core.ts:11024-11031).'],
  [11038, 11040, 'PATCH', '/acquirers/:id', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Edita/desativa operadora; audita acquirer.update.'],
  [11065, 11067, 'PUT', '/acquirers/:id/rates', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Grava taxa e prazo. Liga o comportamento de recebível do cartão (comentário core.ts:11061-11064): é escrita com efeito financeiro, mas a capability da página basta porque o conjunto é o mesmo de hoje.'],
  [11096, 11098, 'DELETE', '/acquirers/rates/:id', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Remove taxa; audita acquirer.rate.remove.'],
  [11115, 11117, 'GET', '/acquirers/preview', RP_LO, 'L,O', 'finance.acquirers.manage', 'empresa',
    'Simula o calendário de recebimento. Nenhum consumidor em src/ (a busca por "/acquirers" em src só acha src/lib/api/core.ts:5104-5136, sem preview): rota só de API. Mantida no mesmo conjunto.'],
  // ----------------------------------------------------------------- comissões
  [11143, 11145, 'GET', '/commissions/setup', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Grupos, faixas e membros de comissão (folha de pagamento, comentário core.ts:11134-11142). Consumidor: tela Comissões (src/lib/api/core.ts:5144; gsRoutes.tsx:402-407 com QUEM_GERENCIA_A_OPERACAO).'],
  [11157, 11159, 'POST', '/commissions/groups', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Cria grupo de comissão; audita commission.group.create.'],
  [11176, 11178, 'PATCH', '/commissions/groups/:id', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Edita grupo; audita commission.group.update.'],
  [11198, 11200, 'PUT', '/commissions/groups/:id/tiers', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Grava faixa; audita commission.tier.set.'],
  [11222, 11224, 'DELETE', '/commissions/tiers/:id', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Remove faixa; audita commission.tier.remove.'],
  [11240, 11242, 'PUT', '/commissions/members/:userId', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Põe um vendedor num grupo de comissão. ESQUISITO: setMemberGroup (server/src/services/core/CommissionService.ts:203-223) confere que o GRUPO é da empresa, mas não confere que o :userId tem vínculo nesta empresa (core_user_companies): aceita id de conta de outra empresa ou inexistente e grava a linha em core_commission_members. Não vaza dado, mas é escrita sobre alvo fora do escopo de empresa; quando a F4 criar a régua de "alvo no meu escopo", esta rota deveria usá-la.'],
  [11259, 11261, 'GET', '/commissions/summary', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Quanto cada vendedor ganhou no período (src/lib/api/core.ts:5177). Poderia ser lida por reports.*, mas hoje só a tela Comissões a consome; mantida em finance.commissions.manage para não alargar.'],
  [11280, 11282, 'POST', '/commissions/close', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Fecha período: o único ponto em que comissão vira dinheiro (gera título a pagar, core.ts:11276-11279). Audita commission.close com quem mandou pagar.'],
  [11311, 11313, 'GET', '/commissions/closings', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Histórico de fechamentos, "mesmo alcance de quem fecha" (core.ts:11307-11310).'],
  [11325, 11327, 'GET', '/commissions/closings/:id', RP_LO, 'L,O', 'finance.commissions.manage', 'empresa',
    'Detalhe do fechamento; mesmo alcance da lista.'],
  // --------------------------------------------------------- formas de pagamento
  [11341, 11347, 'GET', '/payment-methods', "abertaAo(req, 'balcao', 'bancada', 'escritorio')", 'C,CL,CO,E,L,M,O,T',
    'qualquer(pdv.sell, sales.view, workshop.kanban.view)', 'empresa',
    'Cardápio de formas de pagamento, "aberta aos três" (core.ts:11343-11346); rotas-dado-sensivel cobra 200 para o mecânico. A expressão composta é só para reproduzir os três ambientes: pdv.sell cobre os caixas, gerentes e atendente, sales.view o estoquista, workshop.kanban.view o mecânico. Contador fica fora hoje (não pertence a nenhum dos três ambientes) e continua fora; por isso NÃO é SO_AUTENTICADO. Escopo empresa, e não pdv: é leitura sem gaveta, e requireTerminalNoEscopo não se aplica (desenho §6.3 lista só as operações de caixa/venda).'],
  // --------------------------------------------------------------- financeiro
  [11364, 11366, 'GET', '/finance/setup', RP_LO, 'L,O', 'finance.advanced.view', 'empresa',
    'Devolve categorias, centros de custo e o SALDO de todas as contas bancárias (core.ts:11356-11363, 11370-11376); por isso finance.advanced.view ("saldos"), não finance.view. PORTA QUE BATE NA CARA HOJE: a página /sistema/financeiro/cadastros (FinanceiroCadastrosPage) chama esta rota ao montar (src/pages/gs/FinanceiroCadastrosPage.tsx:83), e a rota da tela (src/router/gsRoutes.tsx:401, ROTA_GESTAO sem lista) e o item de menu "Cadastros" (src/components/gs/navItems.ts:520-524, sem profiles) deixam o estoquista e o atendente entrarem e tomarem 403. O desenho §11.2 põe "cadastros" em finance.view, o que MANTÉM essa porta (finance.view inclui estoquista e atendente). A página de Cadastros deve ter pode = finance.advanced.view (ou todas(finance.advanced.view, finance.manage), já que ela também escreve), e é uma mudança D6 de tela a listar.'],
  [11383, 11385, 'POST', '/finance/categories', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Cria categoria do plano de contas; audita finance.category.create. A leitura das categorias por outras telas usa rota própria (/finance/categories GET, fora desta fatia; src/pages/gs/ContasPage.tsx:368).'],
  [11406, 11408, 'PATCH', '/finance/categories/:id', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Edita/desativa categoria; audita finance.category.update.'],
  [11428, 11430, 'POST', '/finance/cost-centers', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Cria centro de custo; audita finance.cost_center.create.'],
  [11450, 11452, 'PATCH', '/finance/cost-centers/:id', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Edita centro de custo; audita finance.cost_center.update.'],
  [11472, 11474, 'POST', '/finance/accounts', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Cria conta bancária/caixa com saldo de abertura; audita finance.account.create (sem dados bancários no detail, só nome e tipo).'],
  [11501, 11503, 'PATCH', '/finance/accounts/:id', RP_LO, 'L,O', 'finance.manage', 'empresa',
    'Edita conta, inclusive saldo de abertura e conta padrão; audita finance.account.update (o detail não guarda o saldo de abertura antes/depois).'],
  // ----------------------------------------------------- unidades serializadas
  [11542, 11544, 'GET', '/units/equipment-candidates', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Plaquinhas que a loja pode adotar. DADO DE OUTRA EMPRESA POR DESENHO (core.ts:11537-11540): plaquinhasVinculaveis (server/src/services/core/EquipmentStockLink.ts:343-366) lista equipamentos que vivem na Oficina, com marca, modelo, chassi, motor, série, nome da bancada e da empresa. Quem tem inventory.units.manage na PJ Motors lê esse dado da Oficina sem ter capability nenhuma lá. É o comportamento de hoje (filtros origin=INTERNAL_PJ_MOTORS, NOT_SOLD e empresaUsaPlaquinha limitam), e o modelo por empresa não o enxerga: registrar como travessia deliberada, como AlcanceCruzado.'],
  [11599, 11605, 'GET', '/units/summary', "abertaAo(req, 'escritorio')", 'E,L,O,T', 'inventory.units.view', 'empresa',
    'Contagens de unidades da própria empresa (fila de vínculo); tela Unidades de estoque, ROTA_GESTAO (comentário core.ts:11601-11604; src/router/gsRoutes.tsx:616). Caixas ficam fora hoje, embora as duas leituras vizinhas os aceitem; mantido.'],
  [11646, 11652, 'GET', '/units/:productId', "abertaAo(req, 'balcao', 'escritorio')", 'C,CL,CO,E,L,O,T',
    'qualquer(inventory.units.view, pdv.sell)', 'empresa',
    'Lista unidades de um produto: o PDV escolhe o número de série que sai (core.ts:11648-11651) e a tela de Unidades a usa. pdv.sell cobre o balcão (inclusive o legado operador_caixa), inventory.units.view o escritório. Escopo empresa: leitura, sem gaveta.'],
  [11689, 11691, 'POST', '/units/:id/equipment', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Adota a plaquinha da Oficina para a unidade. ESCRITA QUE ATRAVESSA EMPRESA: vincularUnidade (EquipmentStockLink.ts:568-629) mexe no equipamento que pertence à Oficina (origin_company_id e, no vínculo tardio, o dono e a venda), com a sessão da loja. Travas do serviço repetem as da lista (EquipmentStockLink.ts:623-629). Hoje igual.'],
  [11734, 11736, 'POST', '/units/:id/equipment/sheet', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Reimprime a plaquinha adotada (GAP-PRD-190). A autorização é a unidade da empresa da sessão; a folha usa o layout da empresa DONA da plaquinha (a Oficina) e grava evento no histórico do equipamento da Oficina (server/src/services/core/UnitTagReprint.ts:12-24, 94-110). Travessia deliberada, como a rota acima. Não é labels.equipment.print porque a regra de hoje é a da unidade (E,L,O), não a da folha de equipamento (que inclui mecânico e atendente).'],
  [11770, 11772, 'DELETE', '/units/:id/equipment', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Desfaz o vínculo unidade × plaquinha (desvincularUnidade, EquipmentStockLink.ts:933); também escreve no equipamento que vive na Oficina. Audita o antes (core.ts:11782-11784).'],
  [11793, 11796, 'GET', '/units', "abertaAo(req, 'balcao', 'escritorio')", 'C,CL,CO,E,L,O,T',
    'qualquer(inventory.units.view, pdv.sell)', 'empresa',
    'Busca por IMEI/chassi "com a etiqueta na mão" no balcão (core.ts:11792-11796). Mesma expressão de /units/:productId.'],
  [11804, 11806, 'PATCH', '/units/:id', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Corrige a identidade da unidade; a correção pode atravessar para a plaquinha da Oficina (comentário core.ts:11816-11818). Audita unit.identify.'],
  [11840, 11842, 'POST', '/units/:id/write-off', RP_LOE, 'E,L,O', 'inventory.units.manage', 'empresa',
    'Baixa de unidade (perda, quebra, devolução) com movimento de estoque negativo (core.ts:11853-11864). Poderia pedir inventory.manage também, mas hoje o conjunto é o de unidades (E,L,O) e inventory.units.manage o reproduz; o cenário E (Estoque) tem as duas.'],
  // -------------------------------------------------------------------- balança
  [11881, 11888, 'GET', '/scales/formats', "abertaAo(req, 'balcao', 'bancada', 'escritorio')", 'C,CL,CO,E,L,M,O,T',
    'qualquer(pdv.sell, sales.view, workshop.kanban.view)', 'empresa',
    'Layouts de arquivo de balança: tabela do produto, "aberta aos três", rotas-dado-sensivel cobra 200 para o mecânico (core.ts:11883-11887). A única tela que a usa é Balança (ROTA_GESTAO, src/router/gsRoutes.tsx:621; src/lib/api/core.ts:5082), mas trocar para products.view estreitaria os caixas e o mecânico; a expressão composta (a mesma de /payment-methods) é só para equivalência. Contador fora hoje e depois. Candidata à R1 (fechar depois do dia 1).'],
  [11895, 11901, 'GET', '/scales/products', "abertaAo(req, 'escritorio')", 'E,L,O,T', 'products.view', 'empresa',
    'Pesáveis com preço da empresa; tela Balança, ROTA_GESTAO (core.ts:11897-11900).'],
  [11914, 11916, 'POST', '/scales/export', RP_LOE, 'E,L,O', 'products.manage', 'empresa',
    'Gera o arquivo da balança; o catálogo já descreve "arquivo da balança" em products.manage. Audita scale.export.'],
  // ------------------------------------------------------- etiqueta de equipamento
  [11942, 11944, 'POST', '/labels/equipment', "requireProfile(req, 'gerente_oficina', 'mecanico', 'operador_caixa_oficina')", 'CO,M,O',
    'workshop.equipment.label', 'bancada',
    'Dados da plaquinha de equipamentos a partir da OS. ESCOPO DE BANCADA NÃO EXISTE HOJE AQUI: getEquipment filtra só por empresa (server/src/services/core/EquipmentService.ts:618-624), então o mecânico imprime a etiqueta de equipamento de QUALQUER bancada da empresa, não só das suas. A capability é de escopo bancada no catálogo; para o dia 1 ficar igual, a F2(d) NÃO pode acrescentar filtro por bancadasDoVinculo nesta rota, ou tem de listá-lo como mudança deliberada (estreitaria o mecânico). capabilitiesFor(oficina.kind).equipmentTags (core.ts:11991) é regra de negócio, não de acesso. ATENÇÃO CENÁRIO G: o modelo novo tecnico_oficina (desenho §3.1) não traz workshop.equipment.label, que o mecânico tem hoje.'],
  [12027, 12029, 'POST', '/labels/equipment/sheet', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente')", 'E,L,M,O,T',
    'labels.equipment.print', 'empresa',
    'Folha de plaquinhas em milímetro (telas Etiquetas e ficha do equipamento: src/pages/gs/EtiquetasPage.tsx:312; src/lib/api/plaquinhaDaMaquina.ts:32). ESQUISITO: o operador_caixa_oficina imprime a etiqueta avulsa (/labels/equipment) mas não a folha; e getEquipment também não filtra bancada (EquipmentService.ts:618-624). Mantido igual.'],
  [12113, 12115, 'GET', '/labels/equipment/formats', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente')", 'E,L,M,O,T',
    'labels.equipment.print', 'empresa',
    'Formatos da folha de plaquinha; carregada por Etiquetas (EtiquetasPage.tsx:177) e por Plaquinhas (src/pages/gs/PlaquinhasPage.tsx:191, com catch que engole o 403: o caixa da oficina, que vê Plaquinhas, cai no formato padrão sem aviso).'],
  // ----------------------------------------------------------- pool de plaquinhas
  [12139, 12141, 'POST', '/equipment-tags/batches', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista')", 'E,L,M,O',
    'workshop.tags.print', 'empresa',
    'Gera lote de plaquinhas. O comentário do bloco (core.ts:12134-12137) diz que os perfis são os da BANCADA "mais o gerente de loja" e cita atendente e caixa da oficina, mas esta rota não os tem: o comentário descreve a leitura, não a escrita. A regra de ouro empresaUsaPlaquinha é de negócio, não de acesso.'],
  [12162, 12164, 'GET', '/equipment-tags', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente', 'operador_caixa_oficina')", 'CO,E,L,M,O,T',
    'workshop.tags.view', 'empresa',
    'Pool de plaquinhas. Consumidores: Plaquinhas (PlaquinhasPage.tsx:187), Equipamentos (src/pages/gs/EquipamentosPage.tsx:481) e troca de plaquinha (plaquinhaDaMaquina.ts:39). O public_token é podado na fronteira (semCredencial, core.ts:12175-12195). Lista multilinha (core.ts:12164-12172).'],
  [12208, 12217, 'GET', '/equipment-tags/batches', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente', 'operador_caixa_oficina')", 'CO,E,L,M,O,T',
    'workshop.tags.view', 'empresa',
    'Lotes: "os MESMOS perfis que leem o pool" (core.ts:12210-12216), para não repetir a porta que batia na cara do atendente. Guarda multilinha (core.ts:12217-12225).'],
  [12243, 12245, 'POST', '/equipment-tags/sheet', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista')", 'E,L,M,O',
    'workshop.tags.print', 'empresa',
    'Folha do lote; é a única rota que grava printed_at (escrita, core.ts:12235-12238, 12330). preview:true é livre dentro do mesmo guarda.'],
  [12344, 12346, 'POST', '/equipment-tags/release', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'estoquista')", 'E,L,O',
    'workshop.tags.release', 'empresa',
    'Libera plaquinhas impressas para uso; mecânico fora hoje e depois.'],
  [12368, 12370, 'POST', '/equipment-tags/:id/damage', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista')", 'E,L,M,O',
    'workshop.tags.print', 'empresa',
    'Marca plaquinha avulsa como danificada (marcarDanificada, EquipmentTagPoolService.ts:501-538, só por empresa). O catálogo inclui "avaria" em workshop.tags.print; conjunto idêntico.'],
  [12398, 12400, 'POST', '/equipment-tags/:id/replace', "requireProfile(req, 'gerente_oficina', 'mecanico')", 'M,O',
    'workshop.equipment.manage', 'bancada',
    'Troca o adesivo de uma máquina. ESCOPO DE BANCADA NÃO EXISTE HOJE AQUI: substituirPlaquinha busca o equipamento só por empresa (server/src/services/core/EquipmentTagPoolService.ts:668-672), então o mecânico troca a plaquinha de máquina de qualquer bancada. Mesma ressalva de /labels/equipment: acrescentar bancadasDoVinculo na F2(d) estreita o mecânico e tem de ser listado. ATENÇÃO CENÁRIO G: tecnico_oficina não traz workshop.equipment.manage.'],
  [12423, 12425, 'GET', '/equipment-tags/layout', "requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista')", 'E,L,M,O',
    'workshop.tags.print', 'empresa',
    'Layout da plaquinha. ESQUISITO: Plaquinhas carrega esta rota ao montar (PlaquinhasPage.tsx:190) com catch que engole o 403, e o atendente e o caixa da oficina, que leem o pool (workshop.tags.view), levam 403 aqui em silêncio. Não é porta que bate na cara (a tela segue), mas a T-UI-1 vai apontar: a página tem pode = workshop.tags.view e uma rota de montagem mais estreita.'],
  [12433, 12435, 'PUT', '/equipment-tags/layout', "requireProfile(req, 'gerente_oficina', 'gerente_loja')", 'L,O',
    'workshop.tags.layout', 'empresa',
    'Salva o layout da plaquinha (PlaquinhasPage.tsx:465); audita equipment.tags.layout.'],
  // ----------------------------------------------------- entrada de notas (NF-e)
  [12458, 12460, 'GET', '/purchases/notes', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa', NOTA_DOCA],
  [12482, 12484, 'POST', '/purchases/nfe/preview', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa',
    'Lê o XML sem gravar. ' + NOTA_DOCA],
  [12498, 12500, 'POST', '/purchases/nfe/import', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa',
    'Importa o XML para conferência, sem mexer no estoque; audita purchase.nfe.import. ' + NOTA_DOCA],
  [12523, 12525, 'GET', '/purchases/cte', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')", 'CL,CO,E,L,O', DOCA, 'empresa',
    'CT-e: "mesmo alcance da entrada de notas" (core.ts:12517-12522). Guarda multilinha (core.ts:12525-12532). Consumidor: EntradaNotasPage.tsx:878.'],
  [12540, 12542, 'POST', '/purchases/cte/import', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')", 'CL,CO,E,L,O', DOCA, 'empresa',
    'Importa CT-e; audita purchase.cte.import. Guarda multilinha (core.ts:12542-12549).'],
  [12572, 12574, 'GET', '/purchases/dfe', RP_LOE, 'E,L,O', 'purchases.view', 'empresa',
    'Lista DF-e da SEFAZ com o plano do ato fiscal (core.ts:12576-12601). Caixas fora (a doca da DF-e é gerência + estoquista, core.ts:12568-12570). Consumidor: EntradaNotasPage.tsx:854.'],
  [12607, 12609, 'POST', '/purchases/dfe/consultar', RP_LOE, 'E,L,O', 'purchases.receive', 'empresa',
    'Consulta a distribuição na SEFAZ usando o A1 selado da empresa (fiscalAdapter, core.ts:8133-8142; certificatePassword pode vir no corpo). O estoquista dispara uso do certificado hoje, e continua. Handler async: o guarda está dentro do IIFE (core.ts:12608-12612), primeira instrução; o critério posicional do lint aceita hoje e tem de continuar aceitando com requireCapability.'],
  [12615, 12617, 'POST', '/purchases/dfe/:chave/manifestar', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Manifestação do destinatário: "ato fiscal com efeito jurídico, só gerência" (core.ts:12568-12570). purchases.manage (o catálogo cita "manifestação") e fiscal.manage têm o mesmo conjunto {L,O}; fica purchases.manage porque a tela que consome é Entrada de notas (EntradaNotasPage.tsx:949). Auditoria no serviço (dfe.manifest). Handler async, guarda dentro do IIFE.'],
  [12634, 12636, 'POST', '/purchases/dfe/:chave/importar', RP_LOE, 'E,L,O', 'purchases.receive', 'empresa',
    'Importa a nota vinda da DF-e para conferência; audita purchase.dfe.import. Mais estreita que /purchases/nfe/import (sem os caixas), como as demais rotas da DF-e.'],
  [12692, 12694, 'GET', '/purchases/notes/:id/xml', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina', 'contador')", 'CL,CO,E,K,L,O',
    'qualquer(purchases.receive, pdv.backoffice, accounting.closing.view)', 'empresa',
    'XML da compra. Mais o contador, que não chega à tela de Entrada de notas: ele baixa o XML avulso a partir da prévia do fechamento (core.ts:12659-12675). accounting.closing.view traz o contador (e os gerentes, que já passam). Distingue nota manual sem XML (404 CORE_INBOUND_NOTE_MANUAL_SEM_XML) de XML não guardado.'],
  [12734, 12736, 'GET', '/purchases/notes/:id/items', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa',
    'Itens da nota em conferência.' + NOTA_CUSTO_NOTA],
  [12744, 12746, 'POST', '/purchases/notes/:id/link', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa',
    'Vincula/desvincula item ao produto; audita com o antes (core.ts:12771-12787). Resposta traz os itens com custo.' + NOTA_CUSTO_NOTA],
  [12799, 12801, 'POST', '/purchases/notes/:id/conferir', "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')", 'CL,CO,E,L,O', DOCA, 'empresa',
    'Registra a contagem da doca, "os mesmos perfis que vinculam item" (core.ts:12797); guarda multilinha (core.ts:12801-12808); audita purchase.note.conferida.'],
  [12851, 12853, 'POST', '/purchases/notes/:id/confirm', RP_DOCA, 'CL,CO,E,L,O', DOCA, 'empresa',
    'Confirma a entrada: aplica estoque e pode criar produto (createMissing). ESQUISITO: o caixa (via pdv.backoffice) confirma uma nota que gera dívida e mexe no estoque, enquanto a entrada manual (que também gera dívida) é negada a ele de propósito (core.ts:12883-12887). Hoje é assim; mantido igual. Candidata a revisão do dono.'],
  [12889, 12891, 'POST', '/purchases/manual', RP_LOE, 'E,L,O', 'purchases.receive', 'empresa',
    'Entrada manual sem nota: alcance MAIS ESTREITO que a importação de XML, por decisão (core.ts:12883-12887); por isso só purchases.receive, sem pdv.backoffice.'],
  [12931, 12933, 'POST', '/purchases/notes/:id/estornar', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Estorno da entrada confirmada: reescreve estoque e financeiro, "mesma alçada do estorno de baixa e do cancelamento fiscal" (core.ts:12926-12929). purchases.manage cita estorno no catálogo; conjunto {L,O}.'],
  // --------------------------------------------------- devolução ao fornecedor
  [12968, 12970, 'GET', '/purchases/notes/:id/devolviveis', RP_LOE, 'E,L,O', 'purchases.view', 'empresa',
    'Leitura da devolução: "alcance de quem recebe mercadoria" (core.ts:12960-12965). Espelhada na tela por QUEM_DEVOLVE_AO_FORNECEDOR (src/components/gs/navItems.ts:237-250).'],
  [12978, 12980, 'GET', '/purchases/supplier-returns', RP_LOE, 'E,L,O', 'purchases.view', 'empresa',
    'Lista de devoluções ao fornecedor; mesmo alcance.'],
  [12993, 12995, 'GET', '/purchases/supplier-returns/:id', RP_LOE, 'E,L,O', 'purchases.view', 'empresa',
    'Detalhe da devolução; mesmo alcance.'],
  [13003, 13005, 'POST', '/purchases/supplier-returns', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Registra devolução: mexe em estoque e dívida (abatimento/crédito), "só gerência, como o estorno" (core.ts:12963-12965); audita purchase.supplier_return.created.'],
  // ------------------------------------------------ nota recebida sem conta a pagar
  [13049, 13051, 'GET', '/purchases/notas-sem-conta', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Notas confirmadas sem título; "decisão sobre dinheiro" (core.ts:13042-13047). Consumida só pelo cartão NotasSemContaAPagar dentro de Entrada de notas (src/pages/gs/EntradaNotasPage.tsx:59, 2180), por isso purchases.manage pela regra "a tela que consome" (desenho §1.3). qualquer(purchases.manage, finance.manage) teria o mesmo conjunto {L,O} e deixaria o cenário F decidir, mas nenhuma tela financeira a chama hoje.'],
  [13059, 13061, 'POST', '/purchases/notes/:id/conta-a-pagar', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Lança, dá como paga ou dispensa a dívida da nota (src/lib/api/notasSemConta.ts:33); audita purchase.note.finance_decision. Mesma nota da lista acima.'],
  [13093, 13095, 'POST', '/purchases/supplier-returns/:id/fiscal', RP_LO, 'L,O', 'purchases.manage', 'empresa',
    'Situação fiscal da devolução (chave da NF-e de devolução, nota do fornecedor ou dispensa); audita purchase.supplier_return.fiscal. fiscal.manage teria o mesmo conjunto; fica em Compras porque a tela é a de devoluções.'],
  // ------------------------------------------------------------ pedidos online
  [13122, 13129, 'GET', '/orders', "abertaAo(req, 'escritorio')", 'E,L,O,T', 'ecommerce.orders.view', 'empresa',
    'Pedidos da loja online com endereço e valor do comprador; tela Pedidos, ROTA_GESTAO (core.ts:13124-13128; src/router/gsRoutes.tsx:622).'],
  [13163, 13177, 'GET', '/orders/:id', "abertaAo(req, 'escritorio')", 'E,L,O,T', 'ecommerce.orders.view', 'empresa',
    'Pedido aberto com os títulos financeiros que ele gerou (V04-FIN-016). O recorte por empresa está no serviço (getStoreOrderDetail recebe o companyId do token; core.ts:13168-13176): pedido de outra empresa volta 404. ESQUISITO: o bloco financeiro do pedido chega ao estoquista e ao atendente, que não têm finance.advanced.view; é leitura do título do próprio pedido, e finance.view (que os dois têm) cobre a leitura de títulos. Mantido.'],
];

const saida = [];
const problemas = [];
for (const [linha, linhaGuarda, metodo, caminho, guarda, letras, cap, escopo, nota] of R) {
  const perfis = expandir(letras);
  const novo = alcance(cap);
  const igual = perfis.length === novo.length && perfis.every((p, i) => p === novo[i]);
  if (!igual) problemas.push({ linha, caminho, hoje: perfis, novo });
  saida.push({
    arquivo: 'server/src/routes/v1/core.ts',
    linha,
    tipo: 'rota',
    metodo,
    caminho: `/core${caminho}`,
    guarda_hoje: guarda,
    perfis_hoje: perfis,
    capability: cap,
    escopo,
    nota: `Guarda em core.ts:${linhaGuarda}. ${igual ? 'Equivalência dia 1: igual (conferida contra perfis_de_hoje do catálogo).' : 'DESVIO DE EQUIVALÊNCIA.'} ${nota}`,
  });
}
writeFileSync(join(aqui, 'sites-core-6.json'), JSON.stringify(saida, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ sites: saida.length, problemas }, null, 2));
