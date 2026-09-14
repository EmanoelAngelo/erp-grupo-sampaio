// Gera sites-core-2.json — fatia core.ts 2201-4400 (int/b fb4c111). Só lê o que foi lido à mão; não toca no repo.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ARQ = 'server/src/routes/v1/core.ts';
const DONOS = ['admin_geral', 'gestor'];
const GER = [...DONOS, 'gerente_loja', 'gerente_oficina'];
const AUX = [...GER, 'estoquista']; // AUX_EDITORES core.ts:1984
const ESC = [...GER, 'estoquista', 'atendente']; // abertaAo('escritorio') core.ts:1023
const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina']; // core.ts:923
const BAL_ESC = [...ESC, ...CAIXAS];
const BAN_ESC = [...ESC, 'mecanico'];
const BAL_BAN_ESC = [...BAL_ESC, 'mecanico'];
const AUX_CX = [...AUX, 'operador_caixa_loja', 'operador_caixa_oficina'];
const CLI_W = [...GER, 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina'];
const BEG = [...GER, ...CAIXAS]; // BALCAO_E_GERENCIA core.ts:937

const ATALHO = 'admin_geral/gestor passam pelo atalho de requireProfile (core.ts:941).';
const r = (linha, metodo, caminho, guardaLinha, guarda, perfis, capability, escopo, nota) => ({
  arquivo: ARQ, linha, tipo: 'rota', metodo, caminho: '/core' + caminho,
  guarda_hoje: guarda, perfis_hoje: perfis, capability, escopo,
  nota: `guarda em core.ts:${guardaLinha}. ${nota}`.trim(),
});
const s = (linha, tipo, metodo, caminho, guarda, perfis, capability, escopo, nota) => ({
  arquivo: ARQ, linha, tipo, metodo, caminho: '/core' + caminho,
  guarda_hoje: guarda, perfis_hoje: perfis, capability, escopo, nota,
});

const RP_GER = "requireProfile(req, 'gerente_loja', 'gerente_oficina')";
const RP_AUX = 'requireProfile(req, ...AUX_EDITORES)';
const RP_AUX3 = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')";
const RP_AUX_CX = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')";
const RP_CLI = "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina')";
const RP_BEG = 'requireProfile(req, ...BALCAO_E_GERENCIA)';
const AB_ESC = "abertaAo(req, 'escritorio')";
const AB_BAL_ESC = "abertaAo(req, 'balcao', 'escritorio')";
const AB_BAN_ESC = "abertaAo(req, 'bancada', 'escritorio')";
const AB_3 = "abertaAo(req, 'balcao', 'bancada', 'escritorio')";

const CUSTO_VAZA = 'VAZAMENTO DE CUSTO: a política de gestão (GAP-PRD-165, veCustoDoEstoque em PoliticaDeGestaoService.ts:169-171) esconde custo de estoquista/atendente em GET /stock e /stock/valuation, mas esta rota entrega';

const sites = [
  // ---------------------------------------------------------------- preço fixado na tabela
  r(2207, 'PUT', '/catalog/price-tables/:id/items/:productId', 2209, RP_GER, GER, 'products.price.manage', 'empresa',
    `Fixar preço de um produto numa tabela de preço é decisão de preço (mesmo alcance de PUT /products/:id/price-tiers). ${ATALHO} Equivalência dia-1: igual (mapa-rota-capability.tsv).`),
  r(2226, 'DELETE', '/catalog/price-tables/:id/items/:productId', 2228, RP_GER, GER, 'products.price.manage', 'empresa',
    `Metade de desfazer do PUT acima; mesmo alcance. ${ATALHO} Igual no dia 1.`),
  // ---------------------------------------------------------------- produto
  r(2245, 'POST', '/products/:id/clone', 2247, RP_AUX, AUX, 'products.manage', 'empresa',
    `Clonar produto = cadastrar produto; AUX_EDITORES (core.ts:1984) = gerentes + estoquista. ${ATALHO} Igual no dia 1.`),
  r(2289, 'POST', '/products/:id/tipo', 2291, RP_AUX, AUX, 'products.manage', 'empresa',
    `Converter revenda<->peça. O comentário (core.ts:2276-2287) cita o atalho de admin/gestor explicitamente e exclui os caixas de propósito. Efeito colateral forte (tira da vitrine, muda dono do saldo) sem capability própria; products.manage cobre porque hoje o conjunto é o mesmo do cadastro. ${ATALHO} Igual no dia 1.`),
  r(2337, 'GET', '/products/:id/barcodes', 2343, AB_ESC, ESC, 'products.view', 'empresa',
    `Lido só pelo formulário de produto (tela de escritório). ${ATALHO} Igual no dia 1.`),
  r(2351, 'POST', '/products/:id/barcodes', 2353, RP_AUX, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2363, 'DELETE', '/products/:id/barcodes/:barcode', 2365, RP_AUX, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2379, 'GET', '/products/:id/kit', 2385, AB_ESC, ESC, 'products.view', 'empresa',
    `Composição do kit para o formulário. ${CUSTO_VAZA} costCents do kit (core.ts:2390, kitCostCents) a estoquista e atendente sem olhar a política. Dia 1 mantém (igual); fechar exige projetar costCents por can('inventory.cost.view') || política — mudança a listar. ${ATALHO}`),
  r(2397, 'PUT', '/products/:id/kit', 2399, RP_AUX, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2431, 'GET', '/products/:id/price-tiers', 2438, AB_BAL_ESC, BAL_ESC, 'qualquer(products.view, pdv.sell)', 'empresa',
    `O balcão lê a faixa por quantidade para oferecer ao cliente (comentário core.ts:2433-2437); o escritório lê no formulário. Leitura de empresa: o escopo de caixa de pdv.sell não se aplica. Inclui o legado operador_caixa (0 vínculos). ${ATALHO} Igual no dia 1.`),
  r(2446, 'PUT', '/products/:id/price-tiers', 2454, RP_GER, GER, 'products.price.manage', 'empresa',
    `Decisão de preço sem alçada (comentário core.ts:2448-2453). ${ATALHO} Igual no dia 1.`),
  r(2474, 'DELETE', '/products/:id/price-tiers/:minQuantity', 2476, RP_GER, GER, 'products.price.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2497, 'GET', '/products/:id/custom-fields', 2499, AB_ESC, ESC, 'products.view', 'empresa',
    `Leitura só do escritório — mas o PUT ao lado aceita os caixas (ver linha 2507): o caixa ESCREVE o valor e não consegue LER de volta pela mesma família de rotas. ${ATALHO} Igual no dia 1.`),
  r(2507, 'PUT', '/products/:id/custom-fields', 2514, "requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja', 'operador_caixa_oficina')", AUX_CX, 'qualquer(products.manage, pdv.backoffice)', 'empresa',
    `GUARDA QUE SE CONTRADIZ: o comentário (core.ts:2509-2513) diz 'a MESMA largura do PUT do cadastro', mas PUT /products/:id perdeu os caixas no GAP-PRD-052 (core.ts:2775-2786, guarda AUX_EDITORES em :2790). Hoje o caixa escreve campo personalizado de produto EXISTENTE pela API, e não lê (GET :2497 é só escritório). pdv.backoffice preserva o dia 1 (igual); candidato a mudança deliberada: só products.manage (e o PDV grava os campos no POST /products). ${ATALHO}`),
  r(2553, 'GET', '/products/:id/history', 2555, AB_ESC, ESC, 'products.view', 'empresa',
    `Trilha de um produto (V05). ${CUSTO_VAZA} o de/para do Custo (CAMPOS_DA_TRILHA inclui cost_cents, CatalogService.ts:916) a estoquista e atendente. Dia 1 mantém; fechar = podar campos 'dinheiro' de custo sem can('inventory.cost.view') || política. ${ATALHO}`),
  r(2570, 'POST', '/catalog/pricing/preview', 2577, AB_ESC, ESC, 'products.view', 'empresa',
    `POST que não escreve: só calcula markup/margem do que o formulário digita (core.ts:2572-2576). Poderia ser SO_AUTENTICADO sem risco (não lê banco), mas products.view mantém o dia 1 exato e segue a tela que o consome. ${ATALHO}`),
  r(2621, 'GET', '/products/:id/images', 2627, AB_ESC, ESC, 'products.view', 'empresa', `Galeria do formulário; a vitrine pública tem rota própria. ${ATALHO} Igual no dia 1.`),
  r(2635, 'POST', '/products/:id/images', 2637, RP_AUX3, AUX, 'products.manage', 'empresa', `Lista escrita à mão igual a AUX_EDITORES. ${ATALHO} Igual no dia 1.`),
  r(2660, 'POST', '/products/:id/images/:imageId/primary', 2662, RP_AUX3, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2671, 'DELETE', '/products/:id/images/:imageId', 2673, RP_AUX3, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2690, 'POST', '/products/:id/images/reorder', 2692, RP_AUX3, AUX, 'products.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(2708, 'GET', '/products/:id/variants', 2711, AB_ESC, ESC, 'products.view', 'empresa',
    `Grade de variações (variantStock: saldo por variante) dentro do formulário de produto. ${ATALHO} Igual no dia 1.`),
  r(2719, 'POST', '/products/:id/variants', 2721, RP_AUX3, AUX, 'products.manage', 'empresa',
    `Gera variantes com priceByCombo (core.ts:2727): o estoquista fixa PREÇO das variantes novas sem products.price.manage — é o mesmo poder de preço que já tem ao cadastrar produto. ${ATALHO} Igual no dia 1.`),
  r(2743, 'POST', '/products', 2751, RP_AUX_CX, AUX_CX, 'qualquer(products.manage, pdv.backoffice)', 'empresa',
    `Os caixas de loja/oficina cadastram produto NOVO pelo balcão, de propósito (GAP-PRD-052, core.ts:2745-2750); o legado operador_caixa fica fora. O caixa cria com qualquer preço/custo, mas não lista (GET /products é escritório). ${ATALHO} Igual no dia 1.`),
  r(2788, 'PUT', '/products/:id', 2790, RP_AUX, AUX, 'products.manage', 'empresa',
    `Editar cadastro, inclusive price_cents e cost_cents. RECORTE QUE NÃO CASA COM O CATÁLOGO: o estoquista muda o preço de tabela aqui, enquanto tabela de preço/faixa exigem products.price.manage (só gerência). Dia 1 = products.manage (igual); separar o campo preço por can('products.price.manage') seria mudança deliberada. ${ATALHO}`),
  // ---------------------------------------------------------------- estoque
  r(2831, 'GET', '/stock', 2838, AB_ESC, ESC, 'inventory.view', 'empresa',
    `Saldo por produto (Estoque, Locais, Unidades, formulário). Custo por linha decidido dentro do handler (ver servico :2851). ${ATALHO} Igual no dia 1.`),
  r(2873, 'GET', '/stock/valuation', 2881, AB_ESC, ESC, 'inventory.view', 'empresa',
    `Valor total do estoque; total oculto conforme veCustoDoEstoque (servico :2894). ${ATALHO} Igual no dia 1.`),
  r(2912, 'GET', '/stock/reconciliation', 2914, AB_ESC, ESC, 'inventory.view', 'empresa', `Conferência de reservas (GAP-PRD-087). ${ATALHO} Igual no dia 1.`),
  r(2932, 'GET', '/management-policy', 2934, AB_ESC, ESC, 'qualquer(dashboard.view, settings.management_policy.manage)', 'empresa',
    `Ler a política é do escritório inteiro (comentário core.ts:2926-2930); a tela de política aparece para quem vê o painel. dashboard.view = {E,L,O,T}+donos; settings.management_policy.manage = donos. ${ATALHO} Igual no dia 1.`),
  r(2942, 'PUT', '/management-policy', 2944, 'requireProfile(req)', DONOS, 'settings.management_policy.manage', 'empresa',
    `requireProfile SEM LISTA: quem decide é SÓ o atalho admin_geral/gestor (core.ts:941) — nenhum perfil é nomeado. No modelo novo vira capability explícita (só nos modelos full_catalog no dia 1). Auditoria já grava antes/depois (core.ts:2956-2976). Igual no dia 1.`),
  r(2990, 'POST', '/stock/reservations/:productId/liberar-sem-origem', 2992, RP_GER, GER, 'inventory.adjust.approve', 'empresa',
    `Soltar reserva órfã devolve mercadoria à venda por decisão (comentário core.ts:2984-2988); estoquista fica fora. ${ATALHO} Igual no dia 1.`),
  r(3024, 'GET', '/stock/movements', 3033, AB_BAN_ESC, BAN_ESC, 'qualquer(inventory.view, workshop.parts.view)', 'empresa',
    `A bancada entra de propósito, com custo podado (servico :3042). workshop.parts.view tem escopo bancada no catálogo, mas a rota NÃO filtra por bancada: o mecânico lê o razão de estoque da EMPRESA inteira. Escopo da rota = empresa. ${ATALHO} Igual no dia 1.`),
  r(3076, 'GET', '/stock/movement-kinds', 3083, AB_BAN_ESC, BAN_ESC, 'qualquer(inventory.view, workshop.parts.view)', 'empresa',
    `Só rótulos estáticos do filtro (MOVEMENT_KINDS); anda junto com /stock/movements (comentário core.ts:3078-3082). Poderia ser SO_AUTENTICADO sem risco, mas acompanhar a rota irmã mantém o dia 1 exato. ${ATALHO}`),
  r(3101, 'POST', '/stock/movements', 3103, RP_AUX_CX, AUX_CX, 'qualquer(inventory.manage, pdv.backoffice)', 'empresa',
    `Movimento manual (entrada/saída/ajuste/perda/uso_interno). PODER GRANDE NO CAIXA: operador_caixa_loja/oficina lança SAÍDA de estoque (perda, uso interno) só com motivo, sem alçada, e não lê o razão (GET /stock/movements não abre ao balcão). pdv.backoffice preserva o dia 1 (igual). Cenário A (somente_pdv) não recebe pdv.backoffice, então fecha para ele. ${ATALHO}`),
  r(3288, 'GET', '/stock/locations', 3296, AB_3, BAL_BAN_ESC, 'qualquer(inventory.view, pdv.sell, workshop.kanban.view)', 'empresa',
    `Aberta aos três ambientes por decisão registrada (rotas-dado-sensivel cobra 200 ao mecânico, core.ts:3290-3295). Lista de locais da empresa, sem recorte de bancada nem de caixa. ${ATALHO} Igual no dia 1.`),
  r(3306, 'POST', '/stock/locations', 3308, RP_AUX3, AUX, 'inventory.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(3329, 'PATCH', '/stock/locations/:id', 3331, RP_AUX3, AUX, 'inventory.manage', 'empresa', `Inclui desativar o local (active). ${ATALHO} Igual no dia 1.`),
  r(3353, 'GET', '/stock/locations/balance/:productId', 3359, AB_ESC, ESC, 'inventory.view', 'empresa', `Só a tela Locais de estoque consome. ${ATALHO} Igual no dia 1.`),
  r(3367, 'POST', '/stock/transfers', 3369, RP_AUX3, AUX, 'inventory.manage', 'empresa', `Transferência entre locais. ${ATALHO} Igual no dia 1.`),
  r(3414, 'GET', '/stock/batches', 3416, AB_ESC, ESC, 'inventory.view', 'empresa',
    `${CUSTO_VAZA} value_cents = saldo × p.cost_cents por lote (BatchService.ts:503) a estoquista e atendente, sem veCustoDoEstoque — dividir pelo saldo dá o custo unitário. Dia 1 mantém (igual); fechar = mesma projeção de GET /stock. ${ATALHO}`),
  r(3442, 'GET', '/stock/batches/alertas', 3444, AB_ESC, ESC, 'inventory.view', 'empresa',
    `${CUSTO_VAZA} valueCents por faixa de validade (BatchService.ts:1082-1113) sem veCustoDoEstoque. Dia 1 mantém. ${ATALHO}`),
  r(3459, 'GET', '/stock/batches/saldos/:productId', 3461, AB_ESC, ESC, 'inventory.view', 'empresa', `Saldo lote a lote de um produto. ${ATALHO} Igual no dia 1.`),
  r(3469, 'GET', '/stock/batches/:id', 3471, AB_ESC, ESC, 'inventory.view', 'empresa',
    `getBatch usa o mesmo SQL_SELECT_BATCH (BatchService.ts:519-523), com value_cents: mesmo vazamento de custo de /stock/batches. Tenant: lote de outra empresa responde 404 (core.ts:3474-3477). ${ATALHO} Igual no dia 1.`),
  r(3484, 'POST', '/stock/batches', 3486, RP_AUX3, AUX, 'inventory.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(3512, 'PATCH', '/stock/batches/:id', 3514, RP_AUX3, AUX, 'inventory.manage', 'empresa', `Mudar validade decide FEFO; auditoria grava de/para (core.ts:3532-3543). ${ATALHO} Igual no dia 1.`),
  r(3551, 'POST', '/stock/batches/:id/conferir', 3553, RP_AUX3, AUX, 'inventory.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(3584, 'POST', '/stock/batches/:id/alocar', 3586, RP_AUX3, AUX, 'inventory.manage', 'empresa', `Move saldo por par de movimentos. ${ATALHO} Igual no dia 1.`),
  r(3619, 'PATCH', '/stock/batch-control/:productId', 3621, RP_AUX3, AUX, 'inventory.manage', 'empresa',
    `Interruptor de controle de lote do produto; chamado pela tela do produto depois de salvar a ficha (products.manage tem o mesmo conjunto; inventory.manage segue o mapa). ${ATALHO} Igual no dia 1.`),
  // ---------------------------------------------------------------- clientes
  r(3646, 'GET', '/customers', 3659, AB_3, BAL_BAN_ESC, 'qualquer(customers.view, pdv.sell, workshop.orders.open)', 'empresa',
    `Três telas consomem: Clientes (escritório), PDV (vincular à venda), Oficina/Equipamentos (dono do aparelho) — core.ts:3648-3658. workshop.orders.open é de escopo bancada, mas a lista é da empresa inteira (sem recorte por bancada). A projeção por linha é decidida dentro (servico :3669). ${ATALHO} Igual no dia 1.`),
  r(3738, 'POST', '/customers', 3740, RP_CLI, CLI_W, 'customers.manage', 'empresa',
    `Quem cadastra: gerência, atendente e os dois caixas; o legado operador_caixa fica FORA aqui, mas DENTRO de alcanceDoCliente (TitularService.ts:72) — divergência sem efeito (0 vínculos). ${ATALHO} Igual no dia 1.`),
  r(3756, 'GET', '/customers/:id', 3762, AB_3, BAL_BAN_ESC, 'qualquer(customers.view, pdv.sell, workshop.orders.open)', 'empresa',
    `Mesma abertura da lista (core.ts:3758-3761); projeção decidida dentro (servico :3767). ${ATALHO} Igual no dia 1.`),
  r(3788, 'PUT', '/customers/:id', 3790, RP_CLI, CLI_W, 'customers.manage', 'empresa',
    `Espelha o POST. O corpo aceita active: o caixa INATIVA cliente pela API (core.ts:3780-3782) com a mesma capability de corrigir telefone. Candidato a capability separada no futuro; dia 1 igual. ${ATALHO}`),
  r(3822, 'PUT', '/customers/:id/price-table', 3824, RP_GER, GER, 'products.price.manage', 'empresa',
    `Condição comercial muda dinheiro (comentário core.ts:3807-3820): mesmo conjunto de quem cria tabela de preço. ${ATALHO} Igual no dia 1.`),
  r(3867, 'GET', '/customers/:id/credits', 3869, AB_BAL_ESC, BAL_ESC, 'qualquer(customers.view, pdv.sell)', 'empresa',
    `Extrato de crédito de loja: o PDV precisa saber se há saldo para abater; o escritório responde 'de onde veio' (core.ts:3846-3866). Bancada e contador fora. ${ATALHO} Igual no dia 1.`),
  r(3891, 'GET', '/customers/:id/dados-do-titular', 3893, RP_GER, GER, 'customers.privacy.manage', 'empresa',
    `LGPD art. 18: exportar tudo do titular. O comentário (core.ts:3885) conta com o atalho do dono. ${ATALHO} Igual no dia 1.`),
  r(3911, 'POST', '/customers/:id/anonimizar', 3913, RP_GER, GER, 'customers.privacy.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(3936, 'GET', '/lgpd/retencao', 3938, RP_GER, GER, 'customers.privacy.manage', 'empresa',
    `Devolve só a declaração estática POLITICA_DE_RETENCAO (sem dado de empresa). ${ATALHO} Igual no dia 1.`),
  r(3954, 'GET', '/customer-credits/liability', 3956, RP_GER, GER, 'finance.advanced.view', 'empresa',
    `Passivo de vale somado: pergunta de quem responde pelo caixa (core.ts:3945-3953). Fronteira entre fatias (a) e (f) no desenho §15. ${ATALHO} Igual no dia 1.`),
  // ---------------------------------------------------------------- caixa
  r(3966, 'GET', '/cash/open', 3973, AB_BAL_ESC, BAL_ESC, 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
    `Gaveta aberta do caixa + teto de sangria. Estoquista e atendente leem (sales.view) mesmo sem poder abrir caixa. Escolha do caixa decidida dentro (servico :3991): hoje qualquer um da empresa consulta QUALQUER caixa por ?terminalId quando não há token de dispositivo. requireTerminalNoEscopo deve valer para quem entra só por pdv.cash.operate. ${ATALHO} Igual no dia 1.`),
  r(4038, 'GET', '/cash/drawers', 4040, AB_BAL_ESC, BAL_ESC, 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
    `Todas as gavetas abertas da empresa. Desenho §6.3: filtrar para o escopo de caixa quem não tem settings.terminals.manage. ${ATALHO} Igual no dia 1.`),
  r(4055, 'GET', '/terminals', 4057, AB_BAL_ESC, BAL_ESC, 'qualquer(pdv.sell, sales.view, settings.terminals.manage)', 'pdv',
    `O operador escolhe 'qual caixa é este computador' (core.ts:4051-4053). Desenho §6.3: devolver noMeuEscopo e filtrar para quem não tem settings.terminals.manage. ${ATALHO} Igual no dia 1.`),
  r(4065, 'POST', '/terminals', 4067, RP_GER, GER, 'settings.terminals.manage', 'empresa', `Cadastro de caixa; auditado com ip. ${ATALHO} Igual no dia 1.`),
  r(4085, 'PATCH', '/terminals/:id', 4087, RP_GER, GER, 'settings.terminals.manage', 'empresa', `Renomear; auditoria com antes/depois. ${ATALHO} Igual no dia 1.`),
  r(4109, 'POST', '/terminals/:id/deactivate', 4111, RP_GER, GER, 'settings.terminals.manage', 'empresa',
    `Desligar caixa derruba os tokens de dispositivo presos a ele (core.ts:4126-4128). No modelo novo o caixa desligado continua na lista de escopo do vínculo (desenho §6.2). ${ATALHO} Igual no dia 1.`),
  r(4137, 'POST', '/terminals/:id/activate', 4139, RP_GER, GER, 'settings.terminals.manage', 'empresa', `${ATALHO} Igual no dia 1.`),
  r(4161, 'GET', '/cash/sessions', 4170, AB_BAL_ESC, BAL_ESC, 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
    `Histórico de turnos de TODOS os caixas da empresa, com nomes e diferença. Desenho §6.3: filtrar ao escopo quem não tem settings.terminals.manage. ${ATALHO} Igual no dia 1.`),
  r(4183, 'POST', '/cash/open', 4185, RP_BEG, BEG, 'pdv.cash.operate', 'pdv',
    `Abrir gaveta. Atendente fica fora (não está em BALCAO_E_GERENCIA). Escopo de caixa decidido em terminalDoPedido (servico :4191) — ponto obrigatório de requireTerminalNoEscopo. ${ATALHO} Igual no dia 1.`),
  r(4212, 'POST', '/cash/:sessionId/movements', 4214, RP_BEG, BEG, 'pdv.cash.operate', 'pdv',
    `Suprimento/sangria/ajuste por sessionId. FALTA ESCOPO HOJE: nem a rota nem addMovement (CashService.ts:311-317) conferem session.terminal_id contra o storeId do token — um computador registrado como Caixa 1 lança na gaveta do Caixa 2 sabendo o id. requireTerminalNoEscopo(req, session.terminal_id) tem de entrar aqui (desenho §6.3 já prevê). Alçada da sangria decidida dentro (servico :4227). ${ATALHO} Igual no dia 1.`),
  r(4245, 'GET', '/cash/:sessionId/summary', 4252, AB_BAL_ESC, BAL_ESC, 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
    `Resumo do turno por sessionId, de qualquer caixa da empresa. O desenho §6.3 NÃO lista esta leitura entre as que filtram por escopo (lista só /cash/drawers, /cash/sessions, /terminals) — acrescentar, senão o operador restrito ao Caixa 1 lê o dinheiro do Caixa 2. ${ATALHO} Igual no dia 1.`),
  r(4283, 'POST', '/cash/:sessionId/close', 4285, RP_BEG, BEG, 'pdv.cash.operate', 'pdv',
    `Fechar turno por sessionId. FALTA ESCOPO HOJE: closeSession (CashService.ts:429+) não confere terminal nem quem abriu; qualquer caixa/gerente da empresa fecha a gaveta de outro caixa. Ponto de requireTerminalNoEscopo. ${ATALHO} Igual no dia 1.`),
  r(4322, 'POST', '/cash/:sessionId/reopen', 4324, RP_BEG, BEG, 'pdv.cash.operate', 'pdv',
    `Reabrir o último turno do mesmo caixa, no mesmo dia. Mesma falta de escopo de caixa por sessionId. Quem faz direto vs. com bilhete é decidido dentro (servico :4332). ${ATALHO} Igual no dia 1.`),
  // ---------------------------------------------------------------- certificado A1
  r(4371, 'GET', '/fiscal/certificate', 4373, 'requireProfile(req)', DONOS, 'fiscal.certificate.manage', 'empresa',
    `requireProfile SEM LISTA: só o atalho admin_geral/gestor decide (comentário core.ts:4367-4370 diz isso). A tela de certificado é do grupo (travessia por operacoesOndeOPerfilAbre fica em core.ts:4455, fora desta fatia). Igual no dia 1.`),
  r(4382, 'POST', '/fiscal/certificate', 4384, 'requireProfile(req)', DONOS, 'fiscal.certificate.manage', 'empresa',
    `requireProfile SEM LISTA: só o atalho decide. Recebe .pfx + senha do certificado: a auditoria desta rota (e a do futuro AcessoService) não pode gravar certificatePassword. Igual no dia 1.`),

  // ================================================================ pontos DENTRO dos handlers
  s(2851, 'servico', 'GET', '/stock', 'veCustoDoEstoque(companyId, profiles) — PoliticaDeGestaoService.ts:159-171 (QUEM_SEMPRE_VE = admin_geral, gestor, gerente_loja, gerente_oficina) || politica.custoDoEstoqueEquipe',
    GER, 'inventory.cost.view', 'empresa',
    'Decide se cost_cents/value_cents/valuation_cost_cents saem da resposta. Hoje: gerência + donos sempre; estoquista/atendente só se o dono ligar custoDoEstoqueEquipe (perfis_hoje lista o "sempre"). ATALHO ADMIN embutido no serviço (QUEM_SEMPRE_VE, PoliticaDeGestaoService.ts:159). Substituto: can(\'inventory.cost.view\') || política (desenho §8 #20). Igual no dia 1.'),
  s(2894, 'servico', 'GET', '/stock/valuation', 'veCustoDoEstoque(companyId, profiles) — mesmo helper, PoliticaDeGestaoService.ts:169-171',
    GER, 'inventory.cost.view', 'empresa',
    'Esconde o total do estoque (totalCents=null) com a mesma régua de GET /stock. Mesmo atalho QUEM_SEMPRE_VE. Substituto: can(\'inventory.cost.view\') || política. Igual no dia 1.'),
  s(3042, 'atalho-admin', 'GET', '/stock/movements', "hideCost = !profiles.some(p => ['admin_geral','gestor','gerente_loja','gerente_oficina','estoquista'].includes(p)) && profiles.includes('mecanico')",
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'], 'inventory.view', 'empresa',
    'Checagem manual de perfil que NOMEIA admin_geral e gestor (core.ts:3043-3045). Com 1 perfil por vínculo, só o mecânico tem unit_cost_cents podado (InventoryService.ts:1594); perfis_hoje = quem VÊ o custo. Substituto dia-1 exato: hideCost = !can(\'inventory.view\') (desenho §8 #17). CONTRADIÇÃO: o atendente e o estoquista VEEM o custo unitário aqui mesmo com a política de gestão escondendo o custo deles em GET /stock (veCustoDoEstoque, :2851). O certo semanticamente seria can(\'inventory.cost.view\') || política — isso é mudança deliberada a listar (fecha custo para E/T).'),
  s(3669, 'servico', 'GET', '/customers', "alcanceDoCliente(req.auth?.profileCodes) — TitularService.ts:66-81 (QUEM_ATENDE_O_CADASTRO)",
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'], 'customers.contact.view', 'empresa',
    'Projeção LGPD por linha (GAP-PRD-073): quem está no conjunto vê contato inteiro; estoquista e mecânico veem nome + últimos dígitos. ATALHO ADMIN embutido no serviço (admin_geral/gestor listados em TitularService.ts:67-68). Substituto: can(\'customers.contact.view\') (desenho §8 #23). Igual no dia 1.'),
  s(3767, 'servico', 'GET', '/customers/:id', "alcanceDoCliente(req.auth?.profileCodes) — TitularService.ts:66-81",
    ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'], 'customers.contact.view', 'empresa',
    'Mesma projeção da lista na ficha (core.ts:3766). Substituto: can(\'customers.contact.view\'). Igual no dia 1.'),
  s(3991, 'servico', 'GET', '/cash/open', "terminal = req.auth.storeId ?? req.query.terminalId; assertTerminalDaEmpresa(companyId, pedido, { exigirAtivo: true }) — TerminalRegistry.ts:41-71",
    BAL_ESC, 'qualquer(pdv.cash.operate, sales.view)', 'pdv',
    'Decide DE QUAL CAIXA é a gaveta consultada (core.ts:3982-3995). Hoje o único recorte é o token de dispositivo; login por senha consulta qualquer caixa ativo da empresa por ?terminalId. Não há perfil envolvido. No modelo novo: requireTerminalNoEscopo(req, terminal) para quem entra só por pdv.cash.operate (quem tem sales.view lê gavetas como hoje). Com 0 caixas (a loja hoje) nada muda.'),
  s(4191, 'servico', 'POST', '/cash/open', "terminalDoPedido({ informado: req.body.terminalId, doDispositivo: req.auth.storeId }) + openSession → assertTerminalDaEmpresa (TerminalRegistry.ts:92-111; CashService.ts:125-126)",
    BEG, 'pdv.cash.operate', 'pdv',
    'O token vence o corpo; divergência = 409. Não há vínculo usuário↔caixa: qualquer caixa/gerente abre a gaveta de qualquer caixa da empresa (login por senha). Ponto obrigatório de requireTerminalNoEscopo (desenho §6.3, core.ts:4183).'),
  s(4227, 'servico', 'POST', '/cash/:sessionId/movements', "alcada: { profileCodes: scope(req).profiles } → CashService.ts:353-357 temAlcadaParaLiberar(perfis) — AuthorizationService.ts:21 AUTHORIZERS = admin_geral, gestor, gerente_loja, gerente_oficina",
    GER, 'approval.cash_withdrawal', 'empresa',
    'Sangria acima do teto: quem tem alçada faz direto; os demais gastam bilhete sangria_especial (consumirLiberacaoDeConcessao). ATALHO ADMIN embutido em AUTHORIZERS (AuthorizationService.ts:21). Substituto: can(\'approval.cash_withdrawal\') (desenho §10). A alçada pontual continua: o operador não vira gerente, só consome o bilhete. Igual no dia 1.'),
  s(4332, 'servico', 'POST', '/cash/:sessionId/reopen', "alcada: { profileCodes: profiles } → CashService.ts:665-667 temAlcadaParaLiberar(perfis) — AUTHORIZERS (AuthorizationService.ts:21)",
    GER, 'approval.cash_reopen', 'empresa',
    'Reabrir turno: quem tem alçada reabre direto; os demais precisam do bilhete reabrir_caixa preso à sessão (consumirLiberacaoDeAcao, CashService.ts:677-686). ATALHO ADMIN embutido em AUTHORIZERS. Substituto: can(\'approval.cash_reopen\') (desenho §10). Igual no dia 1.'),
];

const aqui = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(aqui, 'sites-core-2.json'), JSON.stringify(sites, null, 2) + '\n', 'utf8');
console.log('sites', sites.length);
