# Conflitos e mudanças deliberadas

Base: C:/Users/User/Desktop/devora-ent-rbac (branch ent/rbac, HEAD fb4c1118). Calculado por `_consolidar.mjs`. Um CONFLITO é um lugar onde "o perfil passava hoje" == "o modelo tem a capability da rota" não pode valer para todas as rotas ao mesmo tempo, ou onde a capability pura mudaria o comportamento de um ponto. Nada aqui foi escondido: o solver acusa todo par (perfil, capability) forçado a verdadeiro por uma restrição e a falso por outra.

## 1. Conflitos que o solver encontrou

Restrições vinculantes: 766 (602 rotas guardadas únicas + 164 pontos de serviço decididos pela capability do ator). Conflitos: **1**. Sem resolução: **0**.

### C1: `operador_caixa` × `pdv.sell`

- Exige TRUE: POST /core/pdv/pix-asaas (server/src/routes/v1/core.ts:4585); POST /core/pdv/pix-asaas/:id/cancel (server/src/routes/v1/core.ts:4633); core.ts:5536 POST /core/sales (server/src/routes/v1/core.ts:5536); POST /core/sales (server/src/routes/v1/core.ts:5570); POST /core/offline-sales (server/src/routes/v1/core.ts:5686); POST /core/offline-sales/:id/relaunch (server/src/routes/v1/core.ts:5708); POST /core/offline-sales/:id/relaunch-as-new (server/src/routes/v1/core.ts:5768).
- Exige FALSE: POST /core/print/jobs (server/src/routes/v1/core.ts:1525); POST /core/print/jobs/:id/reprint (server/src/routes/v1/core.ts:1596).
- Resolução: valor true. pdv.sell guarda POST /core/sales, /cash e o PDV inteiro com o operador_caixa legado dentro, e POST /print/jobs e /print/jobs/:id/reprint com ele fora. Fica TRUE: o legado ganha as duas rotas de impressão (0 vínculos; a guarda de hoje se contradiz, porque ele já lê e atualiza os mesmos jobs por abertaAo(balcao)). Mudança D1.

Capabilities cobradas sozinhas por rotas com listas de perfis diferentes (o mesmo conflito, visto pela capability):

- `pdv.sell`: {A,T,L,O,G,CL,CO} em 1 rota(s) (POST /core/print/jobs/:id/reprint) × {A,T,L,O,G,C,CL,CO} em 6 rota(s).

Consistência do administrador: `admin_geral` passa em toda restrição, portanto full_catalog reproduz o dia 1; `gestor` passa em toda restrição, portanto full_catalog reproduz o dia 1.

Correções que o solver impôs aos `perfis_de_hoje` do catálogo de entrada: nenhuma (o catálogo final grava o conjunto derivado).

## 2. Conflitos de semântica (a capability pura mudaria o ponto) e a resolução

| id | conflito | evidência | resolução |
|---|---|---|---|
| C1 | pdv.sell × operador_caixa legado | core.ts:1523/1525 e 1594/1596 (POST /print/jobs, /reprint) deixam o legado fora; POST /core/sales (core.ts:5568) e o resto do PDV o deixam dentro. | Aceitar a mudança (D1). Uma capability só para excluir um código com 0 vínculos, que a tela já não cria (TeamService.ts:37-47), seria ruído. Quem ganha: `operador_caixa` (legado), 2 rotas de impressão. |
| C2 | Uma função de bancada × duas réguas de hoje | Kanban: resolveWorkshopScope mostra ao membro só as suas bancadas (core.ts:7364-7371), com fallback "empresa inteira" para não-membro (7383-7384). Entrada de OS: atendente e caixa da oficina abrem em QUALQUER bancada mesmo sendo membros (WorkshopIntakeService.ts:65-68). Com bancadasDoVinculo única, ou a entrada estreita, ou o kanban alarga. | Dividir a REGRA, não a capability: `bancadasDoVinculo` vale para ver/operar; a entrada abre em todas as bancadas ativas para `workshop.admin` ou `(workshop.orders.open e não workshop.orders.assume)`; o técnico (assume e não admin) abre só nas suas. Verificado no dia 1 em core.ts:7397, 9580, 9592, 10398 e WorkshopIntakeService.ts:44/65/73: igual para os 11. O passo 86 conta só bancadas ATIVAS (furo 1 da nota de core.ts:7375). |
| C3 | Decisões sobre o ALVO por código de perfil | EquipmentService.ts:171 (montador), TeamService.ts:161 (equipe da oficina), implantacaoPorEmpresa.ts:297/321 (checklist gerente/caixa), ProntidaoDasComunicacoes.ts:208 (contador), RecuperacaoDeSenhaDaEquipe.ts:204 (conta de dono), TerminaisPage.tsx:440 (quem recebe token). Com capability pura, os modelos full_catalog entram em todas as listas e os itens de checklist dariam PRONTO em falso. | Capability + o atributo `assignable_by` do modelo (dado editável, não código): "modelo não é assignable_by=grupo" separa as contas de dono, a mesma régua que o desenho §9.1 já usa para a recuperação de senha. Montador = assume ∧ ¬grupo; equipe da oficina = move ∧ ¬grupo; gerente = users.manage ∧ ¬grupo; caixa = pdv.device_login ∧ ¬grupo; contador = accounting.closing.view ∧ ¬dashboard.view. Todas iguais no dia 1 (tabela §3 de equivalencia.md). |
| C4 | pdv.cash.operate usado só para tirar o atendente | POST /core/quotes/:id/cancel (core.ts:5245-5260) e POST /core/consignments/:id/fechar (core.ts:5507-5515) guardavam todas(sales.*.manage, pdv.cash.operate), e nenhuma toca gaveta. Com lista de caixas no vínculo, a regra de escopo de PDV daria 409 no escritório. | Dividir: `sales.quotes.cancel` e `sales.consignment.close` (novas, escopo empresa), semeadas no conjunto exato de hoje {A,G,L,O,C,CL,CO}. /convert e /faturar continuam todas(..., pdv.cash.operate), porque viram venda com gaveta. O botão Cancelar de OrcamentosPage passa a `sales.quotes.cancel`. |
| C5 | Token de computador do caixa sem capability | TerminaisPage.tsx:440 decide por prefixo de código quem recebe token; o servidor não confere o alvo no enroll (auth.ts:457-500) e aceita login de dispositivo de qualquer perfil (auth.ts:401-404). | Nova `pdv.device_login` (escopo pdv), semeada em C, CL, CO (e em somente_pdv / pdv_painel). Tela: alvo com pdv.device_login ∧ ¬grupo = {C,CL,CO}, igual. Servidor: D9 e D10. |
| C6 | Capability de escopo grupo avaliada por empresa | system-admin.ts:73/83 (empresaDeGestao/temVinculoDeGestao) confere admin_geral/gestor NA empresa da URL; o catálogo dá escopo grupo a system.deploy.*. | Decisão: toda capability mora num vínculo e é avaliada no vínculo da empresa pedida (`capabilitiesDe(userId, companyId)`). "Escopo grupo" só significa "só quem tem group.admin entrega" (§9.2). Igual no dia 1. |
| C7 | O desenho §7.3 alargaria a trava de responsável | isManagerProfile NÃO libera a trava em addPart, setLabor, completeTechnical nem assumeOrder (WorkshopCoreService.ts:678, 1086, 1582, 1644); só em move, plan, release e return (792/801/888/966, WorkshopPartsService.ts:162). | Manter sem bypass nos quatro. Só move/plan/release/return traduzem para `workshop.admin`. Corrige o texto do §7.3. |
| C8 | Tradutor de requirePermission por string não é exato | payment-terminal.settings.manage cobre GET /local-agent/status (operate) e POST /local-agent/pairing (manage); homologation.run e transaction.create idem (nota de middleware/auth.ts:156). | A tabela `PERMISSAO_PARA_CAPABILITY` da F1 é por ROTA (método + caminho), não por string de permissão. A base da catraca é 76 chamadas vivas (medido), não 83. |
| C9 | Três réguas de custo | hideCost do razão (core.ts:3042: só o mecânico perde), veCustoDoEstoque (PoliticaDeGestaoService.ts:169: gerência ou política) e podeVerCusto das peças (WorkshopPartsService.ts:32: com estoquista). O atendente e o estoquista veem o custo unitário no razão mesmo com a política escondendo o custo em GET /stock. | Dia 1 exato com três capabilities: `inventory.view` (razão), `inventory.cost.view` (+política), `workshop.parts.cost.view`. Unificar é decisão do dono (R4). |
| C10 | Mapa do arquiteto × fatias | 11 rotas têm expressão diferente entre `mapa-rota-capability.tsv` e as fatias. | Vale a da fatia (leu o handler). Todas dão o mesmo conjunto no dia 1 (as rotas estão "igual" na equivalência). Lista abaixo. |
| C11 | Erros de texto do desenho | §6.3 lista core.ts:5505 (fechar consignação) como chamador de terminalDoPedido, e não é (core.ts:5507-5515); o §6.3 esquece POST /workshop/orders/:id/checkout (core.ts:10212), onde o corpo vence o token; o §7.2 não diz que o passo 86 conta só bancadas ATIVAS; o §7.2 lista 5 pontos de resolveWorkshop e restam 2 (core.ts:9184, 10332); a tabela §11.2 contradiz a D6 em prontidão online, entrada de notas e cadastros do financeiro. | Corrigido aqui: a lista de pontos de requireTerminalNoEscopo perde 5505 e ganha 10212 (D12); passo 86 com bancadas ativas; as páginas seguem a expressão da rota que montam (prontidão e novo produto = products.manage; entrada de notas = purchases.receive; cadastros do financeiro = finance.advanced.view). |
| C12 | GERENCIA_DA_MAQUININHA com letra morta | payment-terminals.ts:72 lista gerente_oficina, mas o requirePermission que vem antes já o barra (Permissions.ts:74-77). | Os 11 pontos viram `integrations.card_terminal.manage` = {L} + donos, o alcance real de hoje. Se o dono quiser o gerente de oficina lá, é mudança a listar. |

Rotas em que a fatia e o mapa do arquiteto divergem (C10):

- `POST /core/pricing/cart` (server/src/routes/v1/core.ts:1268): tsv `qualquer(pdv.sell, sales.view, workshop.kanban.view)` → final `qualquer(pdv.sell, sales.view, workshop.parts.use)`; veredito igual.
- `POST /core/mail/check` (server/src/routes/v1/core.ts:1422): tsv `purchases.view` → final `purchases.receive`; veredito igual.
- `POST /core/catalog/tax-groups` (server/src/routes/v1/core.ts:2050): tsv `products.manage` → final `fiscal.products.classify`; veredito igual.
- `DELETE /core/catalog/tax-groups/:id` (server/src/routes/v1/core.ts:2076): tsv `products.manage` → final `fiscal.products.classify`; veredito igual.
- `POST /core/catalog/tax-rates` (server/src/routes/v1/core.ts:2094): tsv `products.manage` → final `fiscal.products.classify`; veredito igual.
- `DELETE /core/catalog/tax-rates/:id` (server/src/routes/v1/core.ts:2104): tsv `products.manage` → final `fiscal.products.classify`; veredito igual.
- `POST /core/fiscal/sefaz/status` (server/src/routes/v1/core.ts:7536): tsv `fiscal.view` → final `fiscal.config.manage`; veredito igual.
- `POST /auth/password` (server/src/routes/v1/auth.ts:296): tsv `PUBLICA` → final `SO_AUTENTICADO`; veredito igual.
- `POST /auth/logout` (server/src/routes/v1/auth.ts:855): tsv `PUBLICA` → final `SO_AUTENTICADO`; veredito igual.
- `GET /auth/session` (server/src/routes/v1/auth.ts:869): tsv `PUBLICA` → final `SO_AUTENTICADO`; veredito igual.
- `POST /auth/switch-company` (server/src/routes/v1/auth.ts:895): tsv `PUBLICA` → final `SO_AUTENTICADO`; veredito igual.

## 3. Mudanças deliberadas (a lista inteira; fora delas, o dia 1 é o de hoje)

| id | mudança | evidência | por quê / quem ganha ou perde | pontos no mapa |
|---|---|---|---|---|
| D1 | O legado `operador_caixa` passa a poder POST /print/jobs e POST /print/jobs/:id/reprint. | core.ts:1523-1525, 1594-1596 | C1. Código com 0 vínculos; a guarda de hoje se contradiz. | 2 |
| D2 | Sessão e refresh caem quando a empresa é desativada (401 API_SESSION_ENDED). | ContaDaSessao.ts:69-73; ApiAuthService.ts:226-230 | Hoje a sessão numa empresa desativada segue valendo. | — (regra geral, não é ponto do mapa) |
| D3 | Os 2 pontos que ainda usam resolveWorkshop (GET /core/team?workshopId=, core.ts:9184; GET /core/equipment, core.ts:10332) passam a aceitar a bancada pedida por quem já via todas as bancadas pelo fallback; o fallback fecha para vínculos NOVOS. | core.ts:9184, 10332 (resolveWorkshop, core.ts:7284-7328); fallback 7383-7384. O desenho §7.2 cita 5 pontos, mas release e comments já usam resolveWorkshopScope (core.ts:9707, 9972; comentários 9699, 9964) e o painel (core.ts:6943) não filtra por bancada | Não abre dado novo: resolveWorkshopScope já entregava essas OS. Capability de kanban dada a alguém novo não abre todas as bancadas por omissão. | 2 |
| D3b | O passo 86 conta só bancadas ATIVAS. Quem é membro só de bancada desativada e não é mecânico fica com "todas" (como hoje). O MECÂNICO sem nenhuma bancada ativa, que hoje vê todas pelo fallback, passa a ver NENHUMA. | core.ts:7273 (listWorkshopsOf filtra active=1), 7375, 7383-7384 | O fallback do mecânico é acidente (o mecânico nasce com bancada obrigatória, TeamService.ts:85/406). Alternativa, se o dono preferir: o passo 86 grava all_workshops=1 também para ele. | 1 |
| D4 | O PDV sai do menu e da rota do estoquista. | environments.ts:169; navItems.ts:472; gsRoutes.tsx:228; core.ts:5568-5570 | Porta que bate na cara: ele abre o PDV e toma 403 no Finalizar. | 2 |
| D5 | A URL proibida mostra "Acesso negado" (/sem-acesso) em vez de voltar em silêncio para a casa. | Protected.tsx:90-92, 115-117 | Pedido da missão. | — (regra geral, não é ponto do mapa) |
| D6 | Menu, rotas do navegador e botões calculados por capability: a tela passa a mostrar só o que o servidor aceita. | lista calculada abaixo | Pela primeira vez tela e servidor dizem a mesma coisa. | 47 |
| D7 | A auditoria passa a gravar o "antes", o diff, a troca de empresa e os eventos de modelo. | core.ts:9250-9257; auth.ts:895-932 | Pedido da missão. | — (regra geral, não é ponto do mapa) |
| D8 | O modelo `gestor` passa a se chamar "Gestor do grupo (par do administrador)"; o acesso é o mesmo. | HierarquiaDePerfis.ts:27-28; seed.ts:215-222 | Evita entregar o grupo a um "gestor de loja". | — (regra geral, não é ponto do mapa) |
| D9 | POST /auth/device/enroll passa a exigir que o ALVO tenha `pdv.device_login` no vínculo, não seja conta de dono, tenha o caixa no escopo e seja alcançável por quem registra (§9.3). | auth.ts:457-509 (hoje só exige userId com vínculo, 460-466) | Fecha o caminho sem senha para uma conta de administrador, que hoje só a tela evita. Impacto prático: 0 caixas cadastrados na loja. | 1 |
| D10 | POST /auth/device/login passa a exigir `pdv.device_login` do titular do token (não conta de dono) e o caixa do token no escopo. | auth.ts:389-416 | Hoje qualquer perfil com token vira sessão de terminal (mecânico, contador, admin_geral). Quem perde: E, T, L, O, M, K e os donos, por token de dispositivo (por senha nada muda). Tokens existentes na loja: 0. | 1 |
| D11 | Formulário de pessoa: bancada obrigatória quando o modelo tem capability de escopo bancada e `default_workshops=membro`, ou quando o vínculo escolhe `all_workshops=0`. Gerente de oficina e caixa da oficina deixam de ser OBRIGADOS a escolher bancadas específicas (podem receber "todas"). | TeamService.ts:85, 406, 560, 576, 842; EquipePage (tela-botoes:610) | Hoje o gerente de oficina é obrigado a ter bancada e a ignora (core.ts:7290-7293). Vínculos existentes preservados pelo passo 86; muda só o cadastro novo. | 6 |
| D12 | POST /workshop/orders/:id/checkout: o caixa do recebimento passa a vir de terminalDoPedido (o token vence o corpo; divergência 409) e entra requireTerminalNoEscopo. | core.ts:10212; TerminalRegistry.ts:92-111 | Hoje o corpo vence o token: a máquina do Caixa 1 registra recebimento no Caixa 2. | 1 |

### D6 em detalhe (calculado ponto a ponto)

**Fecham portas que batiam na cara** (27 pontos; o servidor já negava a rota que a página monta):

- /pdv (gsRoutes.tsx:228, tela-rota) — `pdv.sell`: perdem E (D4).
- /sistema/produtos/prontidao-online (gsRoutes.tsx:236, tela-rota) — `products.manage`: perdem T.
- /sistema/produtos/novo (gsRoutes.tsx:237, tela-rota) — `products.manage`: perdem T.
- /sistema/financeiro/cadastros (gsRoutes.tsx:401, tela-rota) — `finance.advanced.view`: perdem E,T.
- /sistema/compras/entrada-notas (gsRoutes.tsx:455, tela-rota) — `purchases.receive`: perdem T.
- /sistema/compras/nfe-email (gsRoutes.tsx:476, tela-rota) — `purchases.view`: perdem T.
- /sistema/compras/fornecedores (gsRoutes.tsx:477, tela-rota) — `purchases.view`: perdem T.
- /sistema/compras/transportadoras (gsRoutes.tsx:478, tela-rota) — `purchases.view`: perdem T.
- /sistema/compras/configuracao (gsRoutes.tsx:479, tela-rota) — `purchases.view`: perdem T.
- /sistema/compras/pedidos (gsRoutes.tsx:480, tela-rota) — `purchases.view`: perdem T.
- /sistema/integracoes (gsRoutes.tsx:643, tela-rota) — `integrations.status.view`: perdem E,T.
- /sistema/integracoes/asaas (gsRoutes.tsx:644, tela-rota) — `integrations.asaas.manage`: perdem O,E,T.
- /sistema/compras/fornecedores (navItems.ts:344, tela-menu) — `purchases.view`: perdem T.
- /sistema/produtos/prontidao-online (navItems.ts:372, tela-menu) — `products.manage`: perdem T.
- /sistema/compras/nfe-email (navItems.ts:392, tela-menu) — `purchases.view`: perdem T.
- /sistema/compras/entrada-notas (navItems.ts:393, tela-menu) — `purchases.receive`: perdem T.
- /pdv (navItems.ts:472, tela-menu) — `pdv.sell`: perdem E (D4).
- /sistema/financeiro/cadastros (navItems.ts:521, tela-menu) — `finance.advanced.view`: perdem E,T.
- (grupo/pendente) Compras (grupo) (navItems.ts:550, tela-menu) — `qualquer(purchases.view, purchases.receive)`: perdem T.
- /sistema/compras/entrada-notas (navItems.ts:553, tela-menu) — `purchases.receive`: perdem T.
- /sistema/compras/pedidos (navItems.ts:554, tela-menu) — `purchases.view`: perdem T.
- /sistema/compras/fornecedores (navItems.ts:579, tela-menu) — `purchases.view`: perdem T.
- /sistema/compras/transportadoras (navItems.ts:581, tela-menu) — `purchases.view`: perdem T.
- /sistema/compras/configuracao (navItems.ts:586, tela-menu) — `purchases.view`: perdem T.
- (grupo/pendente) Fiscal (grupo) (navItems.ts:735, tela-menu) — `qualquer(fiscal.sale.emit, fiscal.view, accounting.closing.view, fiscal.certificate.manage)`: perdem E,T.
- /sistema/integracoes (navItems.ts:942, tela-menu) — `integrations.status.view`: perdem E,T.
- /sistema/integracoes/asaas (navItems.ts:946, tela-menu) — `integrations.asaas.manage`: perdem O,E,T.

**Aparecem telas que o servidor já atendia** (24 pontos):

- /sistema/fiscal/documentos (gsRoutes.tsx:283, tela-rota) — `qualquer(fiscal.sale.emit, fiscal.view)`: ganham C,CL,CO.
- /sistema/oficina (gsRoutes.tsx:423, tela-rota) — `workshop.kanban.view`: ganham C,CL,CO.
- /sistema/oficina/os/:id (gsRoutes.tsx:424, tela-rota) — `workshop.kanban.view`: ganham C,CL,CO.
- /sistema/equipamentos (gsRoutes.tsx:427, tela-rota) — `workshop.equipment.view`: ganham C,CL,CO.
- /sistema/equipamentos/plaquinhas (gsRoutes.tsx:442, tela-rota) — `workshop.tags.view`: ganham CO.
- /sistema/equipamentos/:id (gsRoutes.tsx:443, tela-rota) — `workshop.equipment.view`: ganham C,CL,CO.
- /sistema/crm/leads (gsRoutes.tsx:533, tela-rota) — `crm.view`: ganham CL.
- /sistema/crm/fidelidade (gsRoutes.tsx:534, tela-rota) — `crm.view`: ganham CL.
- /sistema/locacao/contratos (gsRoutes.tsx:535, tela-rota) — `rentals.view`: ganham CL.
- (grupo/pendente) Vendas (grupo) (navItems.ts:458, tela-menu) — `qualquer(sales.view, pdv.sell, pdv.supervise, pdv.cash.operate)`: ganham C,CL,CO.
- /sistema/caixa (navItems.ts:471, tela-menu) — `qualquer(pdv.cash.operate, sales.view)`: ganham C,CL,CO.
- /pdv (navItems.ts:472, tela-menu) — `pdv.sell`: ganham C,CL,CO.
- (grupo/pendente) Oficina (grupo) (navItems.ts:594, tela-menu) — `qualquer(workshop.kanban.view, workshop.equipment.view, workshop.tags.view, users.view, workshop.benches.view, workshop.parts.view)`: ganham C,CL,CO.
- /sistema/oficina (navItems.ts:599, tela-menu) — `workshop.kanban.view`: ganham C,CL,CO.
- /sistema/equipamentos (navItems.ts:600, tela-menu) — `workshop.equipment.view`: ganham C,CL,CO.
- /sistema/equipamentos/plaquinhas (navItems.ts:602, tela-menu) — `workshop.tags.view`: ganham CO.
- (grupo/pendente) Fiscal (grupo) (navItems.ts:735, tela-menu) — `qualquer(fiscal.sale.emit, fiscal.view, accounting.closing.view, fiscal.certificate.manage)`: ganham C,CL,CO.
- /sistema/fiscal/documentos (navItems.ts:746, tela-menu) — `qualquer(fiscal.sale.emit, fiscal.view)`: ganham C,CL,CO.
- (grupo/pendente) CRM (grupo) (navItems.ts:823, tela-menu) — `crm.view`: ganham CL.
- /sistema/crm/leads (navItems.ts:834, tela-menu) — `crm.view`: ganham CL.
- /sistema/crm/fidelidade (navItems.ts:840, tela-menu) — `crm.view`: ganham CL.
- (grupo/pendente) Locação (grupo) (navItems.ts:849, tela-menu) — `rentals.view`: ganham CL.
- /sistema/locacao/contratos (navItems.ts:857, tela-menu) — `rentals.view`: ganham CL.
- /sistema/produtos (ProdutosPage) (OperacaoPages.tsx:126, tela-botao) — `products.manage`: ganham O.

## 4. Recomendações que ficam para o dono (não entram no dia 1)

- **R1**: tirar `crm.*`, `rentals.view`, `workshop.kanban.view` e `workshop.equipment.view` dos modelos de caixa que não os usam (fecha API e menu juntos; é a contrapartida da D6 "aparecem").
- **R2**: recorte por tipo de documento em POST /print/jobs (PrintRenderer.ts:641-678 desenha fechamento de caixa, OS, DANFE, orçamento e etiquetas de QUALQUER id da empresa para quem passa na rota). Estreita o acesso de hoje (o atendente imprime etiqueta, por exemplo); medir antes.
- **R3**: o relatório do razão de estoque (ReportsService.ts:606-612) lista `unit_cost_cents` sem hideCost. No dia 1 só a gerência chega nele (reports.central.view), mas um modelo do dono com `reports.central.view` e sem `inventory.cost.view` veria o custo. A F2(b) deve aplicar `can(inventory.cost.view)` ali.
- **R4**: unificar as três réguas de custo (C9).
- **R5**: se o dono quiser alinhar a segunda via ao POST /print/jobs, `qualquer(pdv.sell, sales.view)` na reprint dá ao estoquista a segunda via que ele já consegue por um job novo (core.ts:1594 × 1523).
