# AUDITORIA DE PARIDADE — VELO ERP × DEVORA ERP

**Data:** 31/08/2026 · **HEAD auditado:** `bd0702d` · **Branch:** `finalization/grupo-sampaio-enterprise`

## Base epistêmica desta auditoria

A referência "Velo" usada aqui é a **especificação textual extraída de 13 vídeos de utilização real do Velo ERP por um segundo agente** — esta auditoria **não assistiu aos vídeos**; toda menção ao Velo significa "segundo a especificação extraída do vídeo #N". Comparações que exigiriam detalhe ausente da especificação estão marcadas **NÃO DETERMINÁVEL A PARTIR DA REFERÊNCIA VELO FORNECIDA** ou `NAO_COMPARAVEL`. O relatório separa sempre: (a) o que a referência Velo afirma; (b) o que foi **comprovado** no Devora (com nível de evidência); (c) inferência; (d) o que não foi possível comprovar.

**Método:** 13 auditores independentes, um por vídeo, seguindo a cadeia TELA → AÇÃO → API → REGRA → BANCO → EFEITO ENTRE MÓDULOS → PERMISSÃO → AUDITORIA → TENANT → TESTE. Evidência preferencial: execução de testes de fluxo existentes (isolados por construção — banco temporário) e leitura de código; consultas ao banco operacional **somente leitura**. Nenhuma linha de código de produto foi alterada; nenhuma chamada externa foi feita; nenhum segredo foi lido ou impresso.

**Níveis de evidência:** N1 fluxo E2E executado verde · N2 teste automatizado específico · N3 frontend+backend+persistência comprovados por leitura · N4 código encontrado, não executado · N5 só indício. Nada foi declarado plenamente comprovado com N5.

---

## 1. RESUMO EXECUTIVO

**Total de capacidades auditadas: 215** (derivadas atomicamente da especificação dos 13 vídeos).

| Situação | Qtde | % |
| --- | --- | --- |
| A — implementado e comprovado | 129 | 60,0% |
| B — implementado, UX/fluxo diferente | 18 | 8,4% |
| C — parcial | 31 | 14,4% |
| D — backend sem frontend | 4 | 1,9% |
| E — frontend sem backend | 0 | 0% |
| F — não implementado | 26 | 12,1% |
| G — bloqueado por dependência externa | 6 | 2,8% |
| H — não aplicável | 1 | 0,5% |
| I — não comprovável com segurança | 0 | 0% |

**Paridade FUNCIONAL: 79,1%** — fórmula: (A + B + 0,5×(C+D) + 0,25×E) / (215 − G − H − I). 
**Paridade OPERACIONAL/UX: 74,5%** — fórmula: (A + 0,75×B + 0,4×C + 0×D + 0,25×E) / mesmo denominador (D vale zero porque o funcionário não alcança pela tela).

**Leitura honesta dos dois números:** a paridade FUNCIONAL mede se a capacidade existe no produto (código+fluxo); a OPERACIONAL desconta o que o funcionário não alcança pela tela ou alcança por caminho pior. A distância entre as duas (~5 pontos) é quase toda "backend pronto, superfície faltando".

**O retrato em uma frase:** o Devora cobre com solidez — e frequentemente com controles superiores — o núcleo que a referência Velo demonstra (produto, estoque por evento, compras com conciliação, financeiro, contador, certificado, PDV com pagamentos e alçada, pré-venda/orçamento); as ausências reais concentram-se em **validade/lote, consignado, cobrança avulsa Asaas, parcelamento manual, rastro de item cancelado no carrinho e conveniências de balcão** (cliente inline, desconto digitável no PDV).

**Cinco descobertas que merecem destaque:**
1. **Rastreabilidade e integridade são o ponto mais forte do Devora** — razão de estoque imutável provado em 4 superfícies, webhook com conferência de valor, competência no dia da loja, isolamento tenant sem furo em nenhum dos 13 domínios auditados.
2. **A elevação pontual de privilégio EXISTE e é bem-feita para desconto** (operador continua logado; gestor autoriza com senha na mesma tela; auditoria grava os dois; uso único vinculado à venda) — mas **não cobre cancelamento de venda/devolução**, que ainda exigem o gerente na própria sessão (inferior à referência Velo nesses pontos).
3. **O rodapé "Itens cancelados" do PDV é um `0` fixo** — o conceito existe na tela e não existe no código: item removido do carrinho não deixa rastro nenhum (GAP P1 de prevenção de perda).
4. **Validade/lote não existe em camada nenhuma** (nem coluna, nem serviço, nem tela) — num grupo que opera com produtos pesáveis/perecíveis via balança, é o gap funcional mais claro contra a referência Velo.
5. **Consignado não existe de ponta a ponta** (a palavra aparece só em status de equipamento da oficina, que é outro conceito).

## 2. SCORECARD POR VÍDEO

| Vídeo | Checkpoints | A | B | C+D+E | F | G | H+I | Paridade funcional | Paridade operacional |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #01 Produto | 30 | 19 | 3 | 5 | 3 | 0 | 0 | 82% | 77% |
| #02 Estoque | 19 | 15 | 0 | 3 | 1 | 0 | 0 | 87% | 83% |
| #03 Compras | 15 | 11 | 0 | 3 | 1 | 0 | 0 | 83% | 81% |
| #04 Financeiro | 16 | 11 | 1 | 4 | 0 | 0 | 0 | 88% | 83% |
| #05 Contador | 14 | 9 | 1 | 1 | 3 | 0 | 0 | 75% | 73% |
| #06 Validade/Relatórios | 7 | 0 | 0 | 1 | 6 | 0 | 0 | 7% | 6% |
| #07 Certificado A1 | 12 | 8 | 1 | 3 | 0 | 0 | 0 | 88% | 83% |
| #08 Dashboard/Acessos | 14 | 12 | 1 | 0 | 1 | 0 | 0 | 93% | 91% |
| #09 PDV Pagamentos/TEF | 11 | 5 | 1 | 3 | 0 | 1 | 1 | 83% | 73% |
| #10 PDV Avançado | 23 | 9 | 7 | 6 | 1 | 0 | 0 | 83% | 71% |
| #11 Autorização Pontual | 18 | 11 | 1 | 2 | 4 | 0 | 0 | 72% | 70% |
| #12 Pré-venda/Orçamento/Consignado | 16 | 10 | 2 | 1 | 3 | 0 | 0 | 78% | 74% |
| #13 Asaas/Contas a Receber | 20 | 9 | 0 | 3 | 3 | 5 | 0 | 70% | 65% |

## 3. MATRIZ COMPLETA (215 checkpoints)

Colunas: ID · Vídeo · Capacidade (segundo a especificação Velo) · Classificação · Comparação · Nível de evidência · Frontend · Backend · Teste · Tenant.
As colunas Persistência/Observação completas estão no anexo bruto (saída estruturada dos auditores, citada no §15).

| ID | Vídeo | Capacidade | Cls | Comparação | Ev | Frontend | Backend | Teste | Tenant |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V01-PRD-001 | #01 Produto | Código interno do produto | **A** | EQUIVALENTE | N1 | src/pages/gs/ProdutoFormPage.tsx (Campo 'Código interno', hint 'Em bra | POST/PUT /core/products (server/src/routes/v1/core.ts:1945,1979 → Cata | server/tests/audit-manager.test.ts (RODADO VERDE, 16 testes) | UNIQUE por company_id + scope(req) em toda ro |
| V01-PRD-002 | #01 Produto | Nome do produto | **A** | EQUIVALENTE | N1 | src/pages/gs/ProdutoFormPage.tsx (único campo obrigatório; validação c | POST/PUT /core/products | server/tests/audit-manager.test.ts (VERDE) | company_id em core_products |
| V01-PRD-003 | #01 Produto | Grupo/categoria (com subcategoria) | **A** | EQUIVALENTE | N1 | ProdutoFormPage.tsx (selects Categoria/Subcategoria do vocabulário; va | TaxonomyService + rotas de categorias (core.ts) | server/tests/categorias-marcas.test.ts (VERDE, 23) + audit-m | UNIQUE(company_id, parent_id, name) |
| V01-PRD-004 | #01 Produto | Marca | **A** | EQUIVALENTE | N2 | ProdutoFormPage.tsx (select de marcas da taxonomia) + CategoriasMarcas | TaxonomyService | server/tests/categorias-marcas.test.ts (VERDE) | UNIQUE por company_id |
| V01-PRD-005 | #01 Produto | Ativo/inativo | **A** | EQUIVALENTE | N1 | ProdutoFormPage.tsx (checkbox 'Produto ativo') | PUT /core/products/:id (active no payload) | server/tests/audit-manager.test.ts (VERDE): 'inativar → o ba | scope(req) |
| V01-PRD-006 | #01 Produto | Envio para catálogo/loja virtual | **A** | EQUIVALENTE | N2 | ProdutoFormPage.tsx seção E-commerce (publishOnline, descrição da vitr | StorefrontService consome o MESMO core_products (publish_online=1) | server/tests/loja-produto.test.ts (RODADO VERDE, 18) + produ | vitrine por empresa; audit-ecommerce cobriu f |
| V01-PRD-007 | #01 Produto | Preço aberto (digitado na venda) | **A** | EQUIVALENTE | N2 | ProdutoFormPage.tsx (checkbox 'Preço aberto' que desabilita preço/mark | PricingService fonte 'aberto' (não reprecifica a linha); servidor recu | server/tests/catalog-aux.test.ts (VERDE): 'cria com…preço ab | n-conferido além do padrão company_id |
| V01-PRD-008 | #01 Produto | Preço de venda | **A** | EQUIVALENTE | N1 | ProdutoFormPage.tsx seção Preços (parseReaisToCents pt-BR — '1.500,00' | PUT /core/products/:id; preço negativo recusado | server/tests/audit-manager.test.ts (VERDE): 'editar preço →  | scope(req) |
| V01-PRD-009 | #01 Produto | Preço de custo | **A** | EQUIVALENTE | N1 | ProdutoFormPage.tsx (custo alimenta markup/margem em tempo real) | PUT /core/products/:id + RepricingService sugere reprecificação na ent | server/tests/audit-manager.test.ts + server/tests/reprecific | scope(req) |
| V01-PRD-010 | #01 Produto | Margem (e markup) | **A** | SUPERIOR | N2 | ProdutoFormPage.tsx: markup E margem lado a lado, EDITÁVEIS — digitar  | POST /core/catalog/pricing/preview (core.ts:1772) — o número salvo tem | server/tests/pricing.test.ts (RODADO VERDE, 21) | n/a (cálculo) |
| V01-PRD-011 | #01 Produto | Estoque atual visível no cadastro | **A** | EQUIVALENTE | N2 | ProdutoFormPage.tsx seção Estoque: Em estoque / Reservado / Disponível | GET /core/stock (core.ts:1999) | server/tests/estoque-historico.test.ts (RODADO VERDE, 16) | PK(company_id, product_id) |
| V01-PRD-012 | #01 Produto | Estoque mínimo | **A** | EQUIVALENTE | N3 | ProdutoFormPage.tsx (campo Estoque mínimo) + PecasPage lê below_minimu | listStock(lowOnly=true) filtra abaixo do mínimo (core.ts:2007) | cobertura direta do lowOnly n-conferido nesta rodada | scope(req) |
| V01-PRD-013 | #01 Produto | Localização / locais de estoque | **B** | EQUIVALENTE | N2 | LocaisEstoquePage.tsx (cadastro de locais, posição por local somada do | StockLocationService; transferência não altera o total | server/tests/stock-locations.test.ts (RODADO VERDE, 17) + sa | company_id nas duas tabelas |
| V01-PRD-014 | #01 Produto | Controle de estoque liga/desliga (produto sem estoque / serviço) | **C** | INFERIOR | N3 | ausente (nenhum toggle no ProdutoFormPage) | SalesService.baixasDaLinha (l.82-107): TODA linha que não é kit desmem | n/a (capacidade ausente) | n/a |
| V01-PRD-015 | #01 Produto | Promoção com período | **A** | EQUIVALENTE | N2 | GestaoPages.tsx › PromocoesPage (início/fim, encerrar antes do prazo;  | PricingService.promocoesVigentes + effectivePriceCents (starts_at<=now | server/tests/promocao-vigencia.test.ts (RODADO VERDE, 13) +  | ix_promotions_lookup por company_id |
| V01-PRD-016 | #01 Produto | Dias promocionais da semana | **F** | INFERIOR | N3 | ausente | ausente | n/a | n/a |
| V01-PRD-017 | #01 Produto | Preço/percentual promocional | **B** | EQUIVALENTE | N2 | PromocoesPage: preço promocional FIXO ou percentual de desconto; por p | effectivePriceCents escolhe o candidato mais vantajoso; promoção e tab | promocao-vigencia + promocao-pdv-e-loja (VERDES) | company_id |
| V01-PRD-018 | #01 Produto | Campos personalizados | **F** | INFERIOR | N3 | ausente | ausente | n/a | n/a |
| V01-PRD-019 | #01 Produto | NCM | **A** | EQUIVALENTE | N3 | ProdutoFormPage.tsx seção Fiscal + FiscalPage 'Pendências fiscais de p | PATCH /core/fiscal/product-pendencies/:id; NCM faltando BLOQUEIA emiss | pendências e emissão têm suíte própria (audit-fiscal, contex | scope(req) |
| V01-PRD-020 | #01 Produto | CEST | **A** | EQUIVALENTE | N3 | ProdutoFormPage.tsx seção Fiscal + FiscalPage pendências (rascunho inc | mesma cadeia do NCM; grupo tributário também carrega cest default | idem NCM | scope(req) |
| V01-PRD-021 | #01 Produto | Grupo tributário | **C** | INFERIOR | N2 | AuxiliaresCatalogoPage.tsx (CRUD completo do grupo: regime, CST/CSOSN, | PATCH product-pendencies aceita taxProfile (core.ts:4625) — porta exis | server/tests/catalog-aux.test.ts (VERDE): 'guarda o enquadra | busca do grupo SEMPRE com company_id (Tributa |
| V01-PRD-022 | #01 Produto | PIS/COFINS/IPI | **C** | INFERIOR | N2 | AuxiliaresCatalogoPage (CST PIS/COFINS no grupo tributário; alíquotas  | TributacaoDoItem valida CST de PIS E COFINS obrigatórios e monta PISNT | catalog-aux (VERDE) para a gravação; emissão n-rodada aqui | company_id |
| V01-PRD-023 | #01 Produto | Preço por quantidade (escalonado) | **F** | INFERIOR | N3 | ausente | ausente | n/a | n/a |
| V01-PRD-024 | #01 Produto | Imagens do produto | **A** | EQUIVALENTE | N2 | ProdutoFormPage GaleriaCard: múltiplas fotos, principal, reordenar, FI | rotas de imagem (add/remove/reorder/setPrimary); vitrine usa exatament | server/tests/produto-fotos.test.ts (RODADO VERDE, 16) + foto | company_id na tabela |
| V01-PRD-025 | #01 Produto | Dados para balança | **A** | EQUIVALENTE | N2 | ProdutoFormPage: 'Vendido por peso', PLU (TEXT — zero à esquerda conta | ScaleExportService gera o arquivo; pesável≠PLU separados de propósito  | server/tests/balanca-export.test.ts (RODADO VERDE, 22) | por empresa |
| V01-PRD-026 | #01 Produto | Descrição | **A** | EQUIVALENTE | N3 | ProdutoFormPage: 'Descrição interna' (anotação da equipe) + 'Descrição | PUT /core/products (description, onlineDescription) | n-conferido campo a campo | scope(req) |
| V01-PRD-027 | #01 Produto | Embalagens/caixas com fator | **C** | INFERIOR | N2 | kit no ProdutoFormPage (venda: caixa como kit que desmembra); fator de | NfeImportService.fatorDeConversao: compra por caixa vira unidades no e | server/tests/catalog-aux.test.ts kit (VERDE) + venda-kit.tes | company_id |
| V01-PRD-028 | #01 Produto | Múltiplas tabelas de preço | **A** | EQUIVALENTE | N1 | AuxiliaresCatalogoPage (CRUD: percentual geral + preço FIXADO por item | PricingService: preço da tabela entra no preço VIGENTE — concessão med | server/tests/tabela-de-preco-vale-na-venda.test.ts (RODADO V | company_id em todas; teste inclui migração 59 |
| V01-PRD-029 | #01 Produto | Histórico de alterações do produto | **C** | INFERIOR | N3 | AuditoriaPage.tsx (só admin_geral/gestor; busca por texto alcança enti | recordAudit em product.create/update/tipo/imagem/kit/clone (core.ts:19 | auditoria-tem-leitor.test.ts existe; n-rodado aqui | listAudit filtra por company_id (AuditService |
| V01-PRD-030 | #01 Produto | UX de cadastro progressivo (seções vs formulário monolítico) | **B** | EQUIVALENTE | N2 | ProdutoFormPage.tsx (2003 linhas): 8 ABAS (Dados gerais, Fotos, Preços | n/a | src/pages/gs/__tests__/ProdutoFormConversao.test.tsx (RODADO | n/a |
| V02-EST-001 | #02 Estoque | Razão/ledger de estoque imutável | **A** | EQUIVALENTE | N1 | src/pages/gs/MovimentacoesEstoquePage.tsx (colunas Saldo ant./Saldo po | POST/GET /api/v1/core/stock/movements; server/src/services/core/Invent | server/tests/audit-inventory.test.ts (verde) | company_id em toda consulta; audit-tenant.tes |
| V02-EST-002 | #02 Estoque | Entrada manual de estoque | **C** | INFERIOR | N1 | parcial: src/pages/gs/PecasPage.tsx (só oficina) e ImportacaoPlanilhaP | POST /api/v1/core/stock/movements (core.ts:2090, requireProfile + reco | server/tests/audit-inventory.test.ts (verde) | companyId do token; audit-tenant.test.ts prov |
| V02-EST-003 | #02 Estoque | Saída manual de estoque | **D** | INFERIOR | N1 | ausente | POST /api/v1/core/stock/movements (motivo obrigatório p/ out e adjust  | server/tests/ajuste-manual-tem-motivo.test.ts (verde) | companyId do token (scope) |
| V02-EST-004 | #02 Estoque | Ajuste com motivo obrigatório | **A** | EQUIVALENTE | N1 | src/pages/gs/InventarioPage.tsx (Field 'Motivo do acerto' required, li | POST /core/inventory-counts/:id/apply (gerente only) e POST /core/stoc | server/tests/ajuste-manual-tem-motivo.test.ts + tests/invent | inventario.test.ts: contagem de outra operaçã |
| V02-EST-005 | #02 Estoque | Transferência entre locais | **A** | EQUIVALENTE | N2 | src/pages/gs/LocaisEstoquePage.tsx (transferir, linhas 318-363) | POST /api/v1/core/stock/transfers → StockLocationService.transferStock | server/tests/stock-locations.test.ts (verde; nível serviço — | companyId do scope; local buscado por empresa |
| V02-EST-006 | #02 Estoque | Múltiplos locais de estoque | **A** | EQUIVALENTE | N2 | src/pages/gs/LocaisEstoquePage.tsx (cadastro + posição por local) | GET/POST/PATCH /core/stock/locations, GET /core/stock/locations/balanc | server/tests/stock-locations.test.ts (verde) | listLocations/createLocation por companyId |
| V02-EST-007 | #02 Estoque | Recebimento por nota (entrada de NF-e) | **A** | EQUIVALENTE | N1 | src/pages/gs/EntradaNotasPage.tsx + ConciliacaoRecebimentoPage.tsx + E | rotas /core/purchases + /core/import/nfe → NfeImportService/PurchaseOr | server/tests/audit-purchase.test.ts + src/pages/gs/__tests__ | audit-purchase: 'o pedido da vizinha não se c |
| V02-EST-008 | #02 Estoque | Baixa por venda | **A** | EQUIVALENTE | N1 | src/pages/gs/PdvPage.tsx → POST /core/sales | SalesService.createSale → applyMovement (kind SALE) | server/tests/audit-inventory.test.ts (verde) | audit-tenant.test.ts verde: venda nasce na em |
| V02-EST-009 | #02 Estoque | Reposição de estoque por cancelamento | **A** | EQUIVALENTE | N1 | src/pages/gs/DevolucoesPage.tsx (cancelar ao lado de devolver) | POST /core/sales/:id/cancel → cancelSale | server/tests/devolucao.test.ts + tests/estoque-historico.tes | venda de outra operação inacessível (devoluca |
| V02-EST-010 | #02 Estoque | Devolução de venda | **A** | EQUIVALENTE | N1 | src/pages/gs/DevolucoesPage.tsx | POST /core/sale-returns, GET /core/sales/:id/returnable → SaleReturnSe | server/tests/devolucao.test.ts (verde) | returnable de outra operação = 404 (verde) |
| V02-EST-011 | #02 Estoque | Inventário/balanço (contagem com congelamento) | **A** | EQUIVALENTE | N1 | src/pages/gs/InventarioPage.tsx (esperado/contado/diferença, pendente  | 6 rotas /core/inventory-counts (permissão: contar = estoquista+, aplic | server/tests/inventario.test.ts + src/pages/gs/__tests__/que | contagem de outra operação = 404 (verde) |
| V02-EST-012 | #02 Estoque | Etiquetas (código de barras, preço, gôndola) | **A** | EQUIVALENTE | N2 | src/pages/gs/EtiquetasPage.tsx (+ PlaquinhasPage para equipamentos) | /core/labels/* → LabelFormats/LabelSourcesService/BarcodeService | server/tests/etiquetas-formatos.test.ts, etiquetas-origens.t | listLabelCandidates por empresa; nome da empr |
| V02-EST-013 | #02 Estoque | Custo na movimentação | **A** | EQUIVALENTE | N1 | src/pages/gs/MovimentacoesEstoquePage.tsx (rodapé de custo) + PecasPag | applyMovement.unitCostCents; GET /stock/movements com hideCost por per | server/tests/audit-purchase.test.ts (verde); reprecificacao. | idem movimentos |
| V02-EST-014 | #02 Estoque | Valor do estoque (valorização qty × custo) | **F** | INFERIOR | N3 | ausente | ausente (dado bruto disponível em GET /core/stock) | ausente | n-conferido |
| V02-EST-015 | #02 Estoque | Prevenção de duplicidade (idempotência por referência) | **A** | EQUIVALENTE | N1 | referenceId gerado por gesto (randomUUID no client) | InventoryService.applyMovement (pré-cheque + rebaixa 201→200) | server/tests/audit-inventory.test.ts + tests/audit-purchase. | chave inclui company_id |
| V02-EST-016 | #02 Estoque | Histórico de movimentações filtrável | **A** | EQUIVALENTE | N1 | src/pages/gs/MovimentacoesEstoquePage.tsx (filtros + paginação + entra | GET /api/v1/core/stock/movements → listMovements | server/tests/audit-inventory.test.ts + tests/estoque-histori | scope(req).companyId em toda listagem |
| V02-EST-017 | #02 Estoque | Estoque mínimo e alertas | **A** | EQUIVALENTE | N1 | src/pages/gs/OperacaoPages.tsx (EstoquePage: filtro + badge) + PainelP | GET /core/stock?low=true; painel com lowStock (core.ts:3633) | server/tests/audit-dashboard.test.ts (verde) | por companyId |
| V02-EST-018 | #02 Estoque | Isolamento multitenant do estoque | **A** | EQUIVALENTE | N1 | sessão por empresa (AppShell) | scope(req) em todas as rotas de estoque | server/tests/audit-tenant.test.ts (verde) | provado por teste rodado |
| V02-EST-019 | #02 Estoque | Trocas (devolução + novo item num ciclo fechado) | **C** | INFERIOR | N1 | parcial: src/pages/gs/DevolucoesPage.tsx (opção crédito) | SaleReturnService (refund_method='credito' pula o lançamento); consumo | server/tests/devolucao.test.ts (verde, só a metade existente | idem devolução |
| V03-CMP-001 | #03 Compras | Fornecedor CRUD (cadastro, edição, busca, desativação, histórico de compras) | **A** | EQUIVALENTE | N1 | src/pages/gs/FornecedoresPage.tsx (rota /sistema/compras/fornecedores, | POST/PATCH/GET /api/v1/core/suppliers, POST /suppliers/:id/active (cor | server/tests/compras.test.ts — 23 testes RODADOS VERDES (blo | compras.test.ts 'fornecedor de outra operação |
| V03-CMP-002 | #03 Compras | Pedido de compra (criar, enviar, imutável após envio, previsão de entrega, status) | **C** | INFERIOR | N1 | src/pages/gs/PedidosCompraPage.tsx (/sistema/compras/pedidos) | /api/v1/core/purchase-orders (POST, GET, PUT items, POST send/cancel)  | audit-purchase.test.ts 13 verdes + compras.test.ts 23 verdes | audit-purchase.test.ts 'o pedido da vizinha n |
| V03-CMP-003 | #03 Compras | Importação de XML NF-e (upload, preview, casamento com catálogo, idempotência, guarda do a | **A** | EQUIVALENTE | N1 | src/pages/gs/EntradaNotasPage.tsx (/sistema/compras/entrada-notas): bo | POST /purchases/nfe/preview e /nfe/import (core.ts:7659-7687); NfeImpo | nfe-import.test.ts 15 verdes + nota-de-entrada-guarda-o-xml. | nfe-import.test.ts 'a nota de uma empresa não |
| V03-CMP-004 | #03 Compras | Entrada MANUAL de nota sem XML (digitada) | **F** | INFERIOR | N3 | ausente (nenhuma tela cria nota digitada) | ausente — o ÚNICO INSERT em core_inbound_notes do servidor é o de impo | ausente | n-conferido |
| V03-CMP-005 | #03 Compras | Itens com qtd pedida × faturada × conferida lado a lado | **A** | EQUIVALENTE | N1 | ConciliacaoRecebimentoPage.tsx: colunas Pedida/Faturada/Conferida/Preç | GET /purchase-orders/:id (items com quantity e received_quantity) + GE | ConciliacaoRecebimentoPage.test.tsx 7 verdes ('o pedido 41 m | herdada das rotas (audit-purchase verde) |
| V03-CMP-006 | #03 Compras | Recebimento parcial (nota atende parte do pedido; segunda nota completa) | **A** | EQUIVALENTE | N1 | ConciliacaoRecebimentoPage (estado Parcial com 'faltam N') + PedidosCo | recalcReceived + linkNoteToOrder (PurchaseOrderService.ts:254-390); co | audit-purchase.test.ts 'metade da pastilha chega primeiro… o | audit-purchase verde |
| V03-CMP-007 | #03 Compras | Excedente / sobre-entrega (nota fatura mais que o pedido) | **A** | EQUIVALENTE | N1 | ConciliacaoRecebimentoPage: motivo 'sobra contra o pedido' (estado Div | recalcReceived NÃO capa no teto do pedido: recebido 12 de 10, status ' | audit-purchase.test.ts 'sobre-entrega: a nota fatura 12 num  | audit-purchase verde |
| V03-CMP-008 | #03 Compras | Fator de conversão de unidade (nota em CX, cadastro em UN) | **A** | EQUIVALENTE | N1 | EntradaNotasPage: input 'Quantas unidades do cadastro vêm em uma da no | confirmNfe recusa unidade sem conversão (CORE_UNIT_MISMATCH 409 nomean | audit-purchase.test.ts 'nota de 2 CX (fator 12) satisfaz o p | herdada (audit-purchase verde) |
| V03-CMP-009 | #03 Compras | Divergência visível (doca conta diferente do faturado; motivo gravado; estados nomeados) | **A** | EQUIVALENTE | N1 | EntradaNotasPage: coluna Diferença + motivo da divergência por item; C | POST /purchases/notes/:id/conferir (receivedQuantity, divergenceNote,  | nfe-conferencia-financeiro.test.ts 19 verdes + conferencia-v | herdada (verde) |
| V03-CMP-010 | #03 Compras | Custo atualizado no produto pela entrada | **A** | SUPERIOR | N1 | EntradaNotasPage: após confirmar, assistente de reprecificação lista i | UPDATE core_products.cost_cents com o custo da última carga que ENTROU | nfe-import.test.ts (cost_cents=4550 vindo da nota) + nfe-con | UPDATE com company_id no WHERE; suites verdes |
| V03-CMP-011 | #03 Compras | Entrada no estoque (movimentação, idempotência, serializado) | **A** | EQUIVALENTE | N1 | EntradaNotasPage 'Dar entrada no estoque' (1 clique); MovimentacoesEst | applyMovement com referência (empresa, nfe_entrada, noteId, produto) — | nfe-import.test.ts ('confirmar duas vezes não dobra o estoqu | nfe-import verde; movimentos por company_id |
| V03-CMP-012 | #03 Compras | Contas a pagar nasce da nota | **A** | EQUIVALENTE | N1 | ContasPage (financeiro) lista a dívida com descrição 'NF-e {número}',  | confirmNfe INSERT em core_finance_entries direction=out, origin_type=' | nfe-conferencia-financeiro.test.ts 19 verdes (dívida criada, | herdada; entries por company_id (audit-purcha |
| V03-CMP-013 | #03 Compras | Conciliação pedido × nota (tela nova ConciliacaoRecebimentoPage) | **A** | EQUIVALENTE | N1 | src/pages/gs/ConciliacaoRecebimentoPage.tsx (/sistema/compras/concilia | POST /purchase-orders/:id/notes/:noteId (amarrar), /purchases/notes/:i | RODADOS VERDES: ConciliacaoRecebimentoPage.test.tsx 7 + conc | audit-purchase 'o pedido da vizinha': amarrar |
| V03-CMP-014 | #03 Compras | Cancelamento (pedido; e estorno de entrada) | **C** | INFERIOR | N1 | PedidosCompraPage: 'Cancelar pedido' com motivo via window.prompt | POST /purchase-orders/:id/cancel (motivo ≥3 obrigatório; recebido NÃO  | audit-purchase.test.ts 'cancela com motivo — estoque e finan | herdada (verde) |
| V03-CMP-015 | #03 Compras | Rastreabilidade documento→estoque→financeiro (e a volta) | **C** | INFERIOR | N1 | MovimentacoesEstoquePage: coluna e filtro 'Documento' (NF-e, venda ou  | IDA completa: core_stock_movements.reference_type='nfe_entrada'+refere | estoque-historico.test.ts 16 verdes ('cenário do dono: entra | herdada (verdes) |
| V04-FIN-001 | #04 Financeiro | Contas a pagar (lista, filtros, totais, lançamento avulso) | **A** | EQUIVALENTE | N1 | src/pages/gs/ContasPage.tsx em /sistema/financeiro/contas-a-pagar (ROT | GET/POST /api/v1/core/finance/entries (server/src/routes/v1/core.ts:33 | server/tests/audit-finance.test.ts; server/tests/finance.tes | company_id em todo SELECT/UPDATE do FinanceSe |
| V04-FIN-002 | #04 Financeiro | Contas a receber (mesma tela, direção in; recebíveis nascem da venda/e-commerce) | **A** | EQUIVALENTE | N1 | src/pages/gs/ContasPage.tsx em /sistema/financeiro/contas-a-receber (d | GET /api/v1/core/finance/entries?direction=in + summarize (core.ts:334 | server/tests/audit-finance.test.ts (verde); server/tests/pra | company_id em toda consulta; abertaAo('escrit |
| V04-FIN-003 | #04 Financeiro | Título com origem/credor/vencimento/valor/status | **A** | EQUIVALENTE | N1 | ContasPage.tsx colunas 366-461 | FinanceService.toEntry/listEntries (JOIN customers/suppliers/categorie | audit-finance.test.ts + contasCategoria.test.tsx (verdes) | company_id em toda consulta |
| V04-FIN-004 | #04 Financeiro | Parcelas: cartão gera parcelas; título parcelado manual | **C** | INFERIOR | N1 | OperadorasPage (taxas por forma×parcelas); ContasPage sem campo 'parce | AcquirerService.planForPayment + SalesService (insere N linhas 'Venda  | server/tests/prazos-e-taxas.test.ts (verde); server/tests/au | company_id nas taxas da operadora e nos lança |
| V04-FIN-005 | #04 Financeiro | Baixa total | **A** | EQUIVALENTE | N1 | ContasPage.tsx DetalheCard (botão Registrar recebimento/pagamento, for | POST /api/v1/core/finance/entries/:id/settle (core.ts:3445) -> Finance | audit-finance.test.ts e finance.test.ts (verdes) | companyId no UPDATE condicional e no INSERT d |
| V04-FIN-006 | #04 Financeiro | Baixa parcial | **A** | EQUIVALENTE | N1 | ContasPage.tsx (campo de valor editável, hint 'Pode ser parcial', mens | mesma rota settle; múltiplas linhas em core_finance_settlements por tí | audit-finance.test.ts (verde) | idem V04-FIN-005 |
| V04-FIN-007 | #04 Financeiro | Estorno de baixa | **A** | EQUIVALENTE | N1 | ContasPage.tsx DetalheCard (histórico com line-through e '(estorno)') | POST /api/v1/core/finance/settlements/:id/reverse (core.ts:3471, só ge | audit-finance.test.ts e finance.test.ts (verdes); conciliaca | company_id no SELECT e nos UPDATEs |
| V04-FIN-008 | #04 Financeiro | Vencido / aging | **C** | INFERIOR | N1 | ContasPage.tsx (filtro Vencidas, KPI, destaque); PainelPage mostra a r | listEntries situation='overdue' + summarize.overdueCents (FinanceServi | audit-finance.test.ts (verde) | company_id em toda consulta |
| V04-FIN-009 | #04 Financeiro | Competência (dia da loja) | **A** | EQUIVALENTE | N1 | ContasPage campo Competência ('o mês em que o fato conta no resultado' | hojeNaLoja/mesDaLoja/diaDaLojaSql (CalendarioOperacional) usados no DR | server/tests/dre-competencia.test.ts; server/tests/conciliac | n-conferido por empresa no calendário (fuso ú |
| V04-FIN-010 | #04 Financeiro | Categoria (plano de contas) | **A** | EQUIVALENTE | N1 | ContasPage (filtro+coluna+formulário); FinanceiroCadastrosPage aba cat | GET /finance/categories (core.ts:3509); POST/PATCH /finance/categories | contasCategoria.test.tsx; dre-competencia.test.ts; audit-fin | categoria conferida contra company_id E direç |
| V04-FIN-011 | #04 Financeiro | Centro de custo | **C** | INFERIOR | N2 | FinanceiroCadastrosPage.tsx aba 'centros' (cadastro apenas) | POST/PATCH /finance/cost-centers (core.ts:6707/6729); createEntry grav | dre-competencia.test.ts (verde, prova a escrita) | core_cost_centers por empresa (FK company_id, |
| V04-FIN-012 | #04 Financeiro | DRE | **A** | EQUIVALENTE | N1 | src/pages/gs/DrePage.tsx em /sistema/financeiro/dre (nenhuma aritmétic | GET /finance/income-statement (core.ts:3535) -> IncomeStatementService | server/tests/dre-competencia.test.ts; src/pages/gs/__tests__ | company_id na consulta única; alcance abertaA |
| V04-FIN-013 | #04 Financeiro | Comissão (regras, apuração, fechamento) | **A** | EQUIVALENTE | N1 | src/pages/gs/ComissoesPage.tsx (abas Grupos e faixas / Vendedores / Ap | 8 rotas /commissions/* (core.ts:6450-6612) -> CommissionService.fechar | server/tests/comissoes.test.ts; comissao-vira-dinheiro.test. | company_id em tudo; rotas exigem gerentes |
| V04-FIN-014 | #04 Financeiro | Caixa (abertura, suprimento, sangria, fechamento com conferência, turnos) | **A** | EQUIVALENTE | N1 | src/components/gs/CaixaPdvDialog.tsx (PDV) + seção Turnos anteriores;  | 6 rotas /cash/* (core.ts:2431-2560) -> CashService.ts | server/tests/audit-caixa.test.ts; resumo-do-turno-bate.test. | company_id nas sessões; a-caixa-nao-e-uma-uni |
| V04-FIN-015 | #04 Financeiro | Conciliação bancária (import extrato, casamento, estorno) | **B** | EQUIVALENTE | N1 | src/pages/gs/ConciliacaoBancariaPage.tsx em /sistema/financeiro/concil | 7 rotas /bank/* (core.ts:9963-10065) -> BankReconciliation.ts | server/tests/conciliacao-bancaria.test.ts; conciliacao-banca | company_id em linha, baixa e casamento; rotas |
| V04-FIN-016 | #04 Financeiro | Rastreabilidade bidirecional documento<->título | **C** | INFERIOR | N3 | ausente (nenhum link título<->documento em ContasPage/VendasPage/Entra | origin_type/origin_id gravados sempre; não expostos na rota de listage | server/tests/nfe-conferencia-financeiro.test.ts; audit-finan | company_id em tudo |
| V05-CNT-001 | #05 Contador | Pacote fiscal por empresa + competência (AAAA-MM) | **A** | EQUIVALENTE | N1 | src/pages/gs/FechamentoContadorPage.tsx (/sistema/fiscal/fechamento) | GET /api/v1/core/fiscal/closings/:period/previa e /:period/pacote (ser | server/tests/fechamento-contador.test.ts (43 verdes), server | companyId sai de scope(req) do vínculo, nunca |
| V05-CNT-002 | #05 Contador | XMLs de SAÍDA (modelos 55/65) em lote, formato de arquivamento nfeProc | **A** | EQUIVALENTE | N1 | src/pages/gs/FechamentoContadorPage.tsx (KPIs autorizadas/canceladas) | FiscalClosingService.montarPacote + FiscalProcNfe.montarProcNfe | fechamento-contador.test.ts verde; fiscal-proc-nfe.test.ts e | caso 'documento de OUTRA empresa fica de fora |
| V05-CNT-003 | #05 Contador | XMLs de ENTRADA (notas de compra) no pacote | **A** | EQUIVALENTE | N1 | FechamentoContadorPage (KPIs 'Compras com XML'/'sem XML') | montarPacote (recebidas) + GET /core/purchases/notes/:id/xml | fechamento-contador.test.ts e contador-acesso.test.ts verdes | 'a nota de compra da empresa vizinha não exis |
| V05-CNT-004 | #05 Contador | Eventos (cancelamento, carta de correção) no pacote, recortados pela data do EVENTO | **C** | INFERIOR | N1 | FechamentoContadorPage (KPI 'Eventos no mês') | montarPacote (eventos), filtros SO_PRODUCAO + SO_EVENTO_REAL | fechamento-contador.test.ts: 'carta de correção entra; pedid | JOIN com core_fiscal_documents da mesma compa |
| V05-CNT-005 | #05 Contador | Inutilizações de numeração no pacote | **B** | EQUIVALENTE | N1 | FechamentoContadorPage (KPI 'Faixas inutilizadas') | montarPacote (numeração), SO_EVENTO_REAL_SEM_APELIDO | fechamento-contador.test.ts verde (5+ casos de inutilização) | WHERE company_id = ? |
| V05-CNT-006 | #05 Contador | DRE do período dentro do pacote | **A** | EQUIVALENTE | N1 | FechamentoContadorPage; DrePage separada para gestão | incomeStatement(companyId, primeiroDia, ultimoDia) | fechamento-contador.test.ts + audit-reports.test.ts verdes | companyId do vínculo |
| V05-CNT-007 | #05 Contador | Manifesto do pacote (uma linha por arquivo) | **A** | EQUIVALENTE | N1 | descrito na tela ('um MANIFESTO.csv com uma linha por arquivo') | montarPacote (manifesto) | fechamento-contador.test.ts verde | herdado do pacote |
| V05-CNT-008 | #05 Contador | LEIA-ME explicando o conteúdo e as lacunas | **A** | EQUIVALENTE | N1 | a tela avisa para abrir o LEIA-ME antes de enviar | montarLeiaMe (FiscalClosingService.ts:990) | fechamento-contador.test.ts verde | herdado |
| V05-CNT-009 | #05 Contador | Download pela tela (UI do fechamento) | **A** | EQUIVALENTE | N1 | src/pages/gs/FechamentoContadorPage.tsx + src/lib/download.ts | as duas rotas de closings | src/pages/gs/__tests__/FechamentoContadorPage.test.tsx (9 ve | token Bearer; empresa do vínculo |
| V05-CNT-010 | #05 Contador | Perfil contador restrito (acesso só ao que lhe cabe) | **A** | EQUIVALENTE | N1 | Protected + environments.ts (CASA.contabilidade = /sistema/fiscal/fech | requireProfile nomeando 'contador' nas 3 rotas | contador-varredura-das-rotas.test.ts, contador-acesso.test.t | sim — ver V05-CNT-011 |
| V05-CNT-011 | #05 Contador | Isolamento multiempresa do pacote e das rotas do contador | **A** | EQUIVALENTE | N1 | empresa do vínculo exibida no subtítulo do card | scope(req) em ambas as rotas | contador-acesso.test.ts + fechamento-contador.test.ts verdes | comprovado por teste executado |
| V05-CNT-012 | #05 Contador | Automação recorrente de geração/envio do pacote (agendamento) | **F** | INFERIOR | N3 | ausente | ausente | ausente | n-conferido |
| V05-CNT-013 | #05 Contador | Envio do pacote por e-mail | **F** | INFERIOR | N3 | ausente | ausente (fila core_email_queue existe, sem template nem anexo) | ausente | n-conferido |
| V05-CNT-014 | #05 Contador | Cadastro de destinatário do pacote / dia de envio | **F** | INFERIOR | N3 | EquipePage (cadastro do usuário contador) | TeamService (criação restrita a gestor) | contador-acesso.test.ts verde (cadastro do usuário, não do d | vínculo por empresa |
| V06-VAL-001 | #06 Validade/Relatórios | Campo de validade/lote no cadastro de produto ou no estoque | **F** | INFERIOR | N3 | ausente — grep validade/vencimento/expiry/perec em src/pages/gs/Produt | ausente — server/src/db/schema.ts:339-444; server/src/db/core-migratio | ausente | n/a — capacidade ausente |
| V06-VAL-002 | #06 Validade/Relatórios | Registro de data de validade por item/lote na entrada de mercadoria | **F** | INFERIOR | N3 | ausente — ConciliacaoRecebimentoPage.tsx e EntradaNotasPage.tsx sem ca | ausente — NfeImportService.ts sem captura de validade | ausente | n/a — capacidade ausente |
| V06-VAL-003 | #06 Validade/Relatórios | Marcação conferido/não conferido de validade por item | **F** | INFERIOR | N3 | ausente (para validade) | ausente (para validade) | ausente | n/a — capacidade ausente |
| V06-VAL-004 | #06 Validade/Relatórios | Alerta de vencimento de produto | **F** | INFERIOR | N3 | ausente (para validade de produto) | ausente | ausente | n/a — capacidade ausente |
| V06-VAL-005 | #06 Validade/Relatórios | Relatório de validade (posição de vencimentos) | **F** | INFERIOR | N3 | ausente | ausente | ausente | n/a — capacidade ausente |
| V06-VAL-006 | #06 Validade/Relatórios | Central de relatórios parametrizados com filtros genéricos | **F** | INFERIOR | N2 | telas fixas: DrePage.tsx, BiPage.tsx, AuditoriaPage.tsx, PainelPage.ts | /core/insights/* e /core/audit reais; /bi/reports é stub com payload v | server/tests/audit-reports.test.ts — RODADO, 13/13 verde | insights recortados pelo vínculo core_user_co |
| V06-VAL-007 | #06 Validade/Relatórios | Exportação CSV/PDF de relatório avulso | **C** | INFERIOR | N2 | src/pages/gs/FechamentoContadorPage.tsx (único exportador de relatório | rota do pacote mensal em server/src/routes/v1/core.ts:4553-4600; serve | server/tests/audit-reports.test.ts:750-805 — RODADO, verde | pacote e dre.csv por empresa — o teste verde  |
| V07-CRT-001 | #07 Certificado A1 | Upload de certificado A1 (.pfx/.p12) por empresa | **A** | EQUIVALENTE | N1 | src/pages/gs/CertificadoPage.tsx (UploadCard: input file .pfx/.p12 lid | POST /api/v1/core/fiscal/certificate (server/src/routes/v1/core.ts:260 | RODADO VERDE: server/tests/a-emissao-abre-o-cofre.test.ts (v | companyId vem de scope(req) do token, nunca d |
| V07-CRT-002 | #07 Certificado A1 | Substituição/re-selagem do certificado (renovação) | **A** | EQUIVALENTE | N1 | src/pages/gs/CertificadoPage.tsx — o mesmo card vira 'Substituir certi | upsertCertificateA1 faz update na linha existente (mesma id) — nunca c | RODADO VERDE: a-emissao-abre-o-cofre.test.ts seção 5 ('o ree | mesmo scope do upload |
| V07-CRT-003 | #07 Certificado A1 | Senha SELADA no cofre AES-256-GCM e consumida pelo pipeline de emissão | **A** | EQUIVALENTE | N1 | nenhuma tela pede senha na emissão — PainelFiscalPdv/PDV chamam a rota | server/src/services/fiscal/FiscalSecretVault.ts (aes-256-gcm, scrypt d | RODADO VERDE (NÍVEL 1): server/tests/a-emissao-abre-o-cofre. | getCertificateA1(companyId, unit) — cofre por |
| V07-CRT-004 | #07 Certificado A1 | Não exposição do segredo (resposta, log, auditoria, banco) | **A** | NAO_COMPARAVEL | N1 | CertificadoPage descarta a senha do estado após envio/teste (useEffect | sanitizeCertificateForResponse omite encryptedPfx/keyPem/senha e redig | RODADO VERDE: a-emissao-abre-o-cofre.test.ts 'varredura: a s | n-conferido (não se aplica: nada sensível sai |
| V07-CRT-005 | #07 Certificado A1 | Validade/vencimento visível (titular, CNPJ, emissor, série, válido de/até, dias restantes) | **A** | EQUIVALENTE | N2 | CertificadoPage: badge de situação (VÁLIDO/PRÓXIMO DO VENCIMENTO/VENCI | GET /core/fiscal/certificate → getCertificateView (server/src/services | RODADO VERDE: certificado-a1.test.ts — 'certificado com folg | scope(req) na rota GET |
| V07-CRT-006 | #07 Certificado A1 | Alerta proativo de vencimento do certificado | **C** | INFERIOR | N2 | só dentro de CertificadoPage (badge warning + 'Providencie a renovação | EXPIRY_WARNING_DAYS=30 em CertificateStatusService; vencido BLOQUEIA e | RODADO VERDE: certificado-a1.test.ts 'dentro da janela de av | por empresa via view |
| V07-CRT-007 | #07 Certificado A1 | Ambiente homologação/produção por empresa | **C** | INFERIOR | N2 | FiscalPage: badge AMBIENTE (PRODUÇÃO=danger/HOMOLOGAÇÃO=info) + 'Produ | core_fiscal_configs.environment por company_id; PATCH /fiscal/config a | RODADO VERDE: a-emissao-abre-o-cofre.test.ts seção 6 exercit | environment é coluna por company_id — teste v |
| V07-CRT-008 | #07 Certificado A1 | Portões de produção (nada de teste/fixture vale em produção) | **A** | NAO_COMPARAVEL | N1 | FiscalPage avisa 'nota emitida aqui não tem valor fiscal' quando produ | 4 camadas: (1) developmentMode recusado em produção (CORE_SEFAZ_TEST_P | RODADO VERDE: a-emissao-abre-o-cofre.test.ts seção 6 — 'prod | portões avaliados por empresa (config da empr |
| V07-CRT-009 | #07 Certificado A1 | Lista/visão dos certificados (o que a tela mostra) | **B** | INFERIOR | N3 | CertificadoPage mostra UM certificado — o da operação selecionada no t | GET /core/fiscal/certificate devolve a view de UMA empresa (a do token | rota GET varrida verde em a-emissao-abre-o-cofre.test.ts; te | cada empresa vê só o seu |
| V07-CRT-010 | #07 Certificado A1 | CNPJ conferido contra o .pfx | **C** | NAO_COMPARAVEL | N4 | campo 'CNPJ esperado (opcional)' no UploadCard ('Confere se o certific | upsertCertificateA1: se expectedCnpj vier, compara com o CNPJ extraído | ausente — grep em server/tests por CNPJ_MISMATCH/expectedCnp | n-conferido |
| V07-CRT-011 | #07 Certificado A1 | Isolamento tenant — empresa B não usa o A1 da empresa A | **A** | EQUIVALENTE | N1 | troca de operação no topo troca o certificado exibido | todas as consultas filtram companyId (FiscalCertificateService, Certif | RODADO VERDE: a-emissao-abre-o-cofre.test.ts seção 4 ('B sem | é o próprio checkpoint — provado em nível 1 |
| V07-CRT-012 | #07 Certificado A1 | Uso real do certificado pelo adapter SEFAZ (assinatura + TLS mútuo) | **A** | INFERIOR | N1 | TesteDaSefaz na CertificadoPage (POST /core/fiscal/sefaz/status com se | SefazRealAdapter.ts: SOAP 1.2 real com TLS mútuo usando cert: chainPem | RODADO VERDE: a-emissao-abre-o-cofre.test.ts varredura — spy | adapter montado com o certificado da empresa  |
| V08-DSH-001 | #08 Dashboard/Acessos | Dashboard com filtro de período (De/Até) | **A** | EQUIVALENTE | N1 | src/pages/gs/PainelPage.tsx (inputs date De/Até, padrão últimos 30 dia | GET /api/v1/core/dashboard — server/src/routes/v1/core.ts:3551 (aberta | server/tests/audit-dashboard.test.ts — RODADO VERDE 8/8 (rec | scope(req).companyId em toda query; caso 'a v |
| V08-DSH-002 | #08 Dashboard/Acessos | Vendas por dia (gráfico) | **A** | EQUIVALENTE | N1 | src/pages/gs/PainelPage.tsx SalesByDayChart (barras SVG próprias, valo | byDay no GET /core/dashboard (GROUP BY dia da loja, core.ts:3590-3600) | audit-dashboard RODADO VERDE: byDay bate no centavo e a soma | company_id na query; testado verde |
| V08-DSH-003 | #08 Dashboard/Acessos | Vendas por VENDEDOR | **A** | EQUIVALENTE | N1 | src/pages/gs/PainelPage.tsx Card 'Vendas por vendedor' (tabela Vendedo | bySeller no GET /core/dashboard (core.ts:3618-3631; LEFT JOIN core_use | audit-dashboard RODADO VERDE: bySeller é partição exata do t | company_id na query; testado verde |
| V08-DSH-004 | #08 Dashboard/Acessos | Produtos vendidos (top) | **A** | EQUIVALENTE | N1 | src/pages/gs/PainelPage.tsx Card 'Produtos vendidos' (Produto/Qtd/Valo | topProducts no GET /core/dashboard (core.ts:3602-3614, LIMIT 10 por fa | audit-dashboard RODADO VERDE: P1=3 un/37.035, P2=2 un/13.578 | i.company_id na query; testado verde |
| V08-DSH-005 | #08 Dashboard/Acessos | Vendas por MARCA | **F** | INFERIOR | N3 | ausente (PainelPage e BiPage não têm marca; CategoriasMarcasPage é CAD | ausente (nenhuma agregação por marca: grep byBrand/by_brand/por marca  | ausente | n-conferido (capacidade inexistente) |
| V08-DSH-006 | #08 Dashboard/Acessos | Filtro por empresa | **B** | EQUIVALENTE | N1 | src/components/gs/AppShell.tsx Topbar: select 'Operação ativa' (só apa | POST /api/v1/auth/switch-company (auth.ts:709 — assertMembership recus | audit-dashboard RODADO VERDE (isolamento Gringa×Conceito; pa | assertMembership no switch; insights JOIN cor |
| V08-DSH-007 | #08 Dashboard/Acessos | KPIs: faturamento, ticket médio, contas a receber | **A** | EQUIVALENTE | N1 | src/pages/gs/PainelPage.tsx: 4 KPIs (Faturamento, Vendas, Ticket médio | GET /core/dashboard: revenueCents/salesCount/averageTicketCents/openRe | audit-dashboard RODADO VERDE: ticket exato 16.871 (50.613/3) | testado verde |
| V08-DSH-008 | #08 Dashboard/Acessos | RBAC: perfis existentes | **A** | EQUIVALENTE | N2 | src/router/environments.ts AMBIENTE_POR_PERFIL: 4 ambientes (pdv, ofic | server/src/services/auth/Permissions.ts (matriz módulo×ação, falha fec | o-menu-nao-promete (56/56 VERDE) e audit-portas (120/120 VER | perfil é POR EMPRESA (vínculo em core_user_co |
| V08-DSH-009 | #08 Dashboard/Acessos | RBAC: menu por perfil | **A** | EQUIVALENTE | N1 | src/components/gs/navItems.ts (environments+profiles por item/grupo, h | listas espelham requireProfile de core.ts (QUEM_GERENCIA_A_OPERACAO, Q | src/pages/gs/__tests__/audit-portas.test.tsx — RODADO VERDE  | n-conferido (eixo é perfil, não tenant) |
| V08-DSH-010 | #08 Dashboard/Acessos | RBAC: URL direta não burla | **A** | EQUIVALENTE | N1 | src/router/Protected + gsRoutes.tsx protectedRoute(caminho, tela, ambi | defesa em profundidade: mesmo se a casca abrisse, cada rota confere pe | audit-portas RODADO VERDE: perfil excluído que abre a URL é  | n-conferido neste eixo |
| V08-DSH-011 | #08 Dashboard/Acessos | RBAC: API não burla | **A** | EQUIVALENTE | N1 | n/a | requireProfile/abertaAo em cada rota de core.ts (PERFIS_DO_AMBIENTE, c | server/tests/contador-varredura-das-rotas.test.ts — RODADO V | audit-dashboard verde (cross-tenant); 23 fals |
| V08-DSH-012 | #08 Dashboard/Acessos | RBAC: reload/refresh não burla (sessão relê a pessoa de hoje) | **A** | SUPERIOR | N1 | src/lib/api/client.ts: 401 → refresh único em voo → repete; refresh fa | POST /auth/refresh relê core_users (active, session_version) e o víncu | server/tests/sessao-do-desligado.test.ts — RODADO VERDE 6/6 | desvinculado da operação não renova acesso a  |
| V08-DSH-013 | #08 Dashboard/Acessos | Sessão: expiração e logout | **A** | EQUIVALENTE | N1 | AppShell Topbar botão 'Sair' → logout() → /login; renovação automática | POST /auth/logout revoga o refresh (auth.ts:689); ACCESS_TOKEN_TTL_SEC | server/tests/audit-auth.test.ts — RODADO VERDE 9/9 ('logout  | logout/session/switch-company operam só sobre |
| V08-DSH-014 | #08 Dashboard/Acessos | Guarda automática menu×servidor (o menu não promete o que o servidor nega) | **A** | NAO_COMPARAVEL | N1 | navItems.ts + gsRoutes.tsx (lados medidos) | core.ts requireProfile (lado medido) | server/tests/o-menu-nao-promete-o-que-o-servidor-nega.test.t | n/a |
| V09-PAG-001 | #09 PDV Pagamentos/TEF | Dinheiro com troco | **A** | EQUIVALENTE | N1 | src/components/gs/PagamentoDialog.tsx (Totalizador Troco ao vivo; troc | POST /core/sales → server/src/services/core/SalesService.ts:887-950 (t | server/tests/audit-pdv.test.ts (RODADO VERDE, 9 testes — E2E | scope(req) injeta companyId; company_id NOT N |
| V09-PAG-002 | #09 PDV Pagamentos/TEF | Débito e crédito lançados manualmente (maquininha avulsa) | **A** | EQUIVALENTE | N1 | PagamentoDialog.tsx:406-409 (sem terminal configurado, cartão entra à  | SalesService.ts:876-885 (assertPaymentMethod na entrada); PaymentMetho | server/tests/audit-pdv.test.ts (VERDE: 'pagamento eletrônico | idem V09-PAG-001 |
| V09-PAG-003 | #09 PDV Pagamentos/TEF | PIX manual (QR fora do sistema, operador confirma) | **A** | EQUIVALENTE | N1 | PagamentoDialog.tsx (PIX é meio ativo, Alt+4; lançado direto como sett | PaymentMethods.ts:56 (pix ativo); SalesService.ts:113-114 aceita statu | server/tests/audit-pdv.test.ts (VERDE, inclui PIX manual) +  | idem V09-PAG-001 |
| V09-PAG-004 | #09 PDV Pagamentos/TEF | Múltiplas formas na mesma venda (pagamento dividido) | **A** | EQUIVALENTE | N2 | PagamentoDialog.tsx: lista de lançamentos com remover, 'Falta receber' | SalesService.ts:1169-1196 (N linhas em core_sale_payments); soma < tot | src/components/gs/__tests__/pagamentoDividido.test.tsx (RODA | idem V09-PAG-001 |
| V09-PAG-005 | #09 PDV Pagamentos/TEF | Crediário | **H** | NAO_COMPARAVEL | N2 | ausente por decisão (PdvPage.tsx:179 — ajuda deixou de prometer crediá | server/src/services/core/PaymentMethods.ts:57-70 — { code: 'crediario' | server/tests/formas-de-recebimento.test.ts (RODADO VERDE, 17 | n-conferido (método global por instalação) |
| V09-PAG-006 | #09 PDV Pagamentos/TEF | Vale / crédito de cliente (conceder e GASTAR crédito na loja) | **C** | INFERIOR | N2 | src/pages/gs/DevolucoesPage.tsx:280,654 (devolução com refundMethod 'c | SaleReturnService.ts:37,490-492 (RefundMethod 'credito': não sai do ca | server/tests/devolucao.test.ts (RODADO VERDE, 22 — inclui de | company_id em core_sale_returns |
| V09-PAG-007 | #09 PDV Pagamentos/TEF | Débito em conta do cliente (vender na conta / fiado) | **B** | EQUIVALENTE | N2 | PdvPage.tsx: finalizar sem lançar pagamento com cliente identificado ( | SalesService.ts:912-930 (CORE_SALE_WITHOUT_PAYER: venda sem pagamento  | server/tests/formas-de-recebimento.test.ts (RODADO VERDE: 'v | idem V09-PAG-001 |
| V09-PAG-008 | #09 PDV Pagamentos/TEF | TEF/SmartPOS integrado — máquina de estados (pending→aprovado→recusado→timeout→cancelado)  | **G** | INFERIOR | N2 | PagamentoDialog.tsx:85-165 (TerminalProgress com 4 etapas + estados de | PdvTerminalService.ts (8 estados, NOT_SETTLED explícito, STATUS_MAP do | server/tests/pdv-maquininha.test.ts (RODADO VERDE, 20: aprov | list/get filtram companyId (PaymentTerminalSe |
| V09-PAG-009 | #09 PDV Pagamentos/TEF | Venda só finaliza após confirmação da operadora quando a maquininha é integrada | **C** | EQUIVALENTE | N2 | PagamentoDialog.tsx:401-436 (com terminal configurado o clique não val | PdvTerminalService.ts:47-56 (NOT_SETTLED: todos os estados exceto apro | server/tests/pdv-maquininha.test.ts (RODADO VERDE: 'aprovada | idem V09-PAG-008 |
| V09-PAG-010 | #09 PDV Pagamentos/TEF | Conferência de maquininha — fila de cobranças incertas com resolução manual auditada | **A** | EQUIVALENTE | N2 | src/pages/gs/ConferenciaMaquininhaPage.tsx (fila + ReconcileDialog com | GET /core/pdv/terminal/uncertain e POST /:id/reconcile exigem gerente_ | server/tests/pdv-maquininha.test.ts (RODADO VERDE: 'reconcil | fila e reconcile passam por companyId do toke |
| V09-PAG-011 | #09 PDV Pagamentos/TEF | PIX pela maquininha integrada (QR no aparelho, confirmação assíncrona) | **D** | INFERIOR | N2 | ausente: PagamentoDialog.tsx:401-409 só roteia debito/credito pelo ter | completo: methodNeedsTerminal('pix') = true com terminal (PdvTerminalS | server/tests/pdv-pix-maquininha.test.ts (RODADO VERDE, 12: ' | idem V09-PAG-008 |
| V10-PDV-001 | #10 PDV Avançado | Atalhos de teclado do PDV (mapa completo vs lista Velo) | **B** | INFERIOR | N2 | src/pages/gs/PdvPage.tsx + src/components/gs/PagamentoDialog.tsx + src | n/a (atalhos são da tela) | src/pages/gs/__tests__/pdvAtalhos.test.tsx (RODADO, 16 verde | n/a |
| V10-PDV-002 | #10 PDV Avançado | Fluxo 100% teclado possível | **B** | EQUIVALENTE | N2 | src/pages/gs/PdvPage.tsx; src/components/gs/PagamentoDialog.tsx | POST /api/v1/core/sales | pdvAtalhos.test.tsx + pagamentoDividido.test.tsx (RODADOS, v | n-conferido |
| V10-PDV-003 | #10 PDV Avançado | Barcode: bipe entra direto no carrinho | **A** | EQUIVALENTE | N1 | src/pages/gs/PdvPage.tsx (runSearch) + src/pages/gs/pdvTypes.ts | GET /core/products/search (?includeParts=1), GET /core/products/:id/un | server/tests/audit-pdv.test.ts (RODADO, 9 verdes) | audit-pdv rodou o fluxo nas 6 empresas; scope |
| V10-PDV-004 | #10 PDV Avançado | Alterar quantidade do item | **C** | INFERIOR | N3 | src/pages/gs/PdvPage.tsx | POST /core/sales (items[].quantity) | server/tests/audit-pdv.test.ts (RODADO) | n-conferido |
| V10-PDV-005 | #10 PDV Avançado | Cancelar item individual RASTREÁVEL | **C** | INFERIOR | N3 | src/pages/gs/PdvPage.tsx:2226-2246 | ausente (remoção é só estado da tela) | ausente (nenhum teste cobra contagem de itens cancelados) | n/a |
| V10-PDV-006 | #10 PDV Avançado | Cancelar venda com motivo | **B** | EQUIVALENTE | N2 | src/pages/gs/DevolucoesPage.tsx (fora do PDV) | POST /core/sales/:id/cancel | src/pages/gs/__tests__/cancelarVenda.test.tsx (RODADO, 12 ve | scope(req).companyId na rota |
| V10-PDV-007 | #10 PDV Avançado | Desconto por item | **C** | INFERIOR | N2 | src/pages/gs/PdvPage.tsx + pdvConcessao.ts | POST /core/sales (createSale mede as 3 origens: cabeçalho, itens, preç | server/tests/alcada-sem-porta-dos-fundos.test.ts (RODADO, 22 | scope por empresa |
| V10-PDV-008 | #10 PDV Avançado | Desconto total (rodapé) | **D** | INFERIOR | N3 | ausente (nenhum input de desconto no PDV) | POST /core/sales (discountCents) — completo | server/tests/audit-pdv.test.ts (RODADO — desconto via API, n | scope por empresa |
| V10-PDV-009 | #10 PDV Avançado | Alçada: liberação pontual de gestor sem trocar de login | **A** | EQUIVALENTE | N1 | src/components/gs/PagamentoDialog.tsx (AutorizacaoGerenteDialog) + Pdv | POST /core/authorizations; createSale consome (SalesService) | server/tests/alcada-sem-porta-dos-fundos.test.ts + src/pages | companyId no authorizeAction; guarda abertaAo |
| V10-PDV-010 | #10 PDV Avançado | Cliente inline: pesquisar e CADASTRAR sem sair da venda | **C** | INFERIOR | N3 | src/pages/gs/PdvPage.tsx (openCustomers) | GET /core/customers; POST /core/pricing/cart | src/pages/gs/__tests__/pdvTabelaDePreco.test.tsx existe (n-e | scope por empresa |
| V10-PDV-011 | #10 PDV Avançado | Vendedor por venda (comissão certa) | **A** | EQUIVALENTE | N3 | src/pages/gs/PdvPage.tsx:2057-2077 | GET /core/sellers; POST /core/sales (sellerId) | server/tests/comissoes.test.ts (existe, n-executado nesta au | listSellers e venda por companyId |
| V10-PDV-012 | #10 PDV Avançado | Observação da venda | **B** | EQUIVALENTE | N2 | src/pages/gs/PdvPage.tsx (editarObservacao) | POST /core/sales (note) | src/pages/gs/__tests__/pdvAtalhos.test.tsx (RODADO) | n-conferido |
| V10-PDV-013 | #10 PDV Avançado | Sangria e suprimento DO PDV | **A** | EQUIVALENTE | N1 | src/components/gs/CaixaPdvDialog.tsx | POST /core/cash/:sessionId/movements; POST /core/authorizations | server/tests/sangria-com-teto.test.ts (RODADO, 16 verdes) +  | sessão de caixa é uma por empresa; scope nas  |
| V10-PDV-014 | #10 PDV Avançado | Gaveta (comando de abertura da gaveta de dinheiro) | **F** | INFERIOR | N3 | ausente | ausente | ausente | n/a |
| V10-PDV-015 | #10 PDV Avançado | Impressão do comprovante | **B** | INFERIOR | N1 | src/lib/print.ts + src/components/gs/PainelFiscalPdv.tsx | POST /core/print/jobs, GET /core/print/jobs/:id/document, /reprint | server/tests/audit-impressao.test.ts (RODADO, verde) | jobs por empresa (audit-impressao valida iden |
| V10-PDV-016 | #10 PDV Avançado | Suspender (aguardar) venda e retomar | **B** | EQUIVALENTE | N2 | src/pages/gs/PdvPage.tsx + src/pages/gs/pdvEmEspera.ts | ausente (deliberado — localStorage) | src/pages/gs/__tests__/pdvEmEspera.test.ts (RODADO, 15 verde | escopo por empresa comprovado no módulo (esco |
| V10-PDV-017 | #10 PDV Avançado | Pagamento dividido (múltiplos meios) | **A** | EQUIVALENTE | N2 | src/components/gs/PagamentoDialog.tsx | POST /core/sales (payments[]); GET /core/payment-methods | src/components/gs/__tests__/pagamentoDividido.test.tsx + ser | venda por empresa; audit-pdv nas 6 |
| V10-PDV-018 | #10 PDV Avançado | Troco | **A** | EQUIVALENTE | N1 | PagamentoDialog (Totalizador Troco) + PdvPage (mensagem) | POST /core/sales → change_cents | server/tests/audit-pdv.test.ts (RODADO); server/tests/venda- | provado nas 6 empresas |
| V10-PDV-019 | #10 PDV Avançado | Finalizar rápido | **A** | EQUIVALENTE | N2 | src/pages/gs/PdvPage.tsx (finalizeCashExact) | POST /core/sales | pdvAtalhos.test.tsx + audit-pdv.test.ts (RODADOS) | provado nas 6 |
| V10-PDV-020 | #10 PDV Avançado | Tela de recebimento (totais: subtotal/saldo/pagos/recebido) | **B** | EQUIVALENTE | N2 | src/components/gs/PagamentoDialog.tsx:504-599 | validação final no POST /core/sales | pagamentoDividido.test.tsx (RODADO, 14 verdes) | n/a |
| V10-PDV-021 | #10 PDV Avançado | Fechamento de caixa (conferência) | **A** | EQUIVALENTE | N1 | src/components/gs/CaixaPdvDialog.tsx | GET /core/cash/:id/summary; POST /core/cash/:id/close | server/tests/audit-pdv.test.ts + audit-caixa.test.ts + src/c | uma sessão por empresa; provado nas 6 |
| V10-PDV-022 | #10 PDV Avançado | Pesquisa avançada (F4) | **C** | INFERIOR | N3 | src/pages/gs/PdvPage.tsx:1808-1816 | GET /core/products/search | audit-pdv (busca por texto, RODADO); tela de filtros: ausent | scope por empresa |
| V10-PDV-023 | #10 PDV Avançado | Pré-vendas no PDV (F9): carregar e faturar | **A** | EQUIVALENTE | N1 | src/pages/gs/PdvPage.tsx (openQuotes/loadQuote)  | GET /core/quotes, POST /core/quotes/:id/convert | server/tests/alcada-sem-porta-dos-fundos.test.ts (RODADO); o | scope por empresa |
| V11-AUT-001 | #11 Autorização Pontual | Elevação pontual para desconto acima do limite no PDV: operador continua logado, gestor li | **A** | EQUIVALENTE | N1 | src/pages/gs/PdvPage.tsx (confirmAuthorization, linhas 1330-1405) + sr | POST /core/authorizations (server/src/routes/v1/core.ts:3093) + server | server/tests/politica-do-balcao.test.ts VERDE (51); src/page | company_id em toda consulta; assertMembership |
| V11-AUT-002 | #11 Autorização Pontual | Identificação do autorizador: login+senha do gestor no MESMO modal, verificada com Argon2i | **A** | EQUIVALENTE | N2 | src/components/gs/PagamentoDialog.tsx:208-288 | server/src/services/core/AuthorizationService.ts:141-162 | server/tests/pdv-finalizacao.test.ts VERDE (19) | n-conferido neste checkpoint (ver V11-AUT-007 |
| V11-AUT-003 | #11 Autorização Pontual | Liberação de USO ÚNICO, gasta e vinculada ao documento que a consumiu (consumo transaciona | **A** | EQUIVALENTE | N2 | src/pages/gs/PdvPage.tsx:1092 (authorizationId enviado uma vez e zerad | server/src/services/core/AuthorizationService.ts:406-424 | server/tests/alcada-sem-porta-dos-fundos.test.ts VERDE (22) | consulta de consumo filtra company_id (Author |
| V11-AUT-004 | #11 Autorização Pontual | Liberação com teto em VALOR e em PERCENTUAL: carrinho mudado depois do 'sim' do gestor é r | **A** | SUPERIOR | N2 | src/pages/gs/PdvPage.tsx:1380-1390 (concedidoCents/brutoCents no corpo | server/src/services/core/AuthorizationService.ts:173-174, 329-404 | server/tests/alcada-sem-porta-dos-fundos.test.ts VERDE; src/ | mesma consulta tenant-safe do consumo |
| V11-AUT-005 | #11 Autorização Pontual | Liberação presa ao operador que a pediu — não transfere para outro operador | **A** | EQUIVALENTE | N2 | n/a (regra de servidor) | server/src/services/core/AuthorizationService.ts:316-323 | server/tests/alcada-sem-porta-dos-fundos.test.ts VERDE | requested_by vem do token (scope(req).userId) |
| V11-AUT-006 | #11 Autorização Pontual | Auditoria registra OS DOIS: quem pediu (requestingUser) e quem liberou (authorizingUser) | **A** | EQUIVALENTE | N2 | src/pages/gs/AuditoriaPage.tsx + src/pages/gs/OrcamentosPage.tsx:975 | server/src/routes/v1/core.ts:3139-3151 + AuditService.recordAudit | server/tests/pdv-finalizacao.test.ts VERDE; src/pages/gs/__t | audit por company_id; listAuthorizations filt |
| V11-AUT-007 | #11 Autorização Pontual | Alçada é da EMPRESA da venda: gerente de outra empresa do grupo não libera | **A** | EQUIVALENTE | N2 | n/a (regra de servidor) | server/src/services/core/AuthorizationService.ts:154-162 | server/tests/pdv-finalizacao.test.ts VERDE | sim — o núcleo do checkpoint |
| V11-AUT-008 | #11 Autorização Pontual | Senha errada e login inexistente recusados SEM virar oráculo de credenciais | **A** | EQUIVALENTE | N2 | erro exibido no próprio modal (authError) | server/src/services/core/AuthorizationService.ts:141-151 | server/tests/pdv-finalizacao.test.ts VERDE | n/a |
| V11-AUT-009 | #11 Autorização Pontual | Autoautorização proibida; quem já tem alçada não pede liberação para si mesmo | **A** | EQUIVALENTE | N2 | CaixaPdvDialog mostra 'Sangria sem chamar gestor' para quem tem alçada | server/src/services/core/AuthorizationService.ts:70-72, 164-171 | server/tests/pdv-finalizacao.test.ts VERDE; server/tests/pol | perfis saem do token, nunca do corpo (core.ts |
| V11-AUT-010 | #11 Autorização Pontual | Sangria acima do teto da gaveta com liberação pontual (F3 do PDV), mesma mecânica de consu | **A** | EQUIVALENTE | N2 | src/components/gs/CaixaPdvDialog.tsx:355-408, 595-799 | server/src/services/core/CashService.ts:283-317 | src/components/gs/__tests__/sangriaComTeto.test.tsx VERDE (1 | teto lido de politicaDaEmpresa(companyId); co |
| V11-AUT-011 | #11 Autorização Pontual | Orçamento e pré-venda: criação E aprovação acima do limite pedem liberação pontual; a conv | **A** | EQUIVALENTE | N2 | src/pages/gs/OrcamentosPage.tsx:479-498, 975 | server/src/services/core/QuoteService.ts:440-494, 1335 | server/tests/alcada-sem-porta-dos-fundos.test.ts VERDE (22); | mesma consulta tenant-safe do consumo |
| V11-AUT-012 | #11 Autorização Pontual | Alteração de preço abaixo do vigente: coberta pela MESMA trava de concessão (rodapé + desc | **B** | EQUIVALENTE | N2 | src/pages/gs/pdvConcessao.ts (prévia espelhando a conta do servidor) | server/src/services/core/SalesService.ts:704-832 | server/tests/politica-do-balcao.test.ts VERDE; server/tests/ | limite por empresa via politicaDaEmpresa |
| V11-AUT-013 | #11 Autorização Pontual | Cancelamento de VENDA com autorização pontual (operador pede, gestor libera sem trocar de  | **F** | INFERIOR | N2 | src/pages/gs/DevolucoesPage.tsx (botão restrito por perfil) | server/src/routes/v1/core.ts:3321-3343 (requireProfile 'gerente_loja') | src/pages/gs/__tests__/cancelarVenda.test.tsx VERDE (12) | cancelSale filtra company_id |
| V11-AUT-014 | #11 Autorização Pontual | Devolução/estorno de venda com autorização pontual | **F** | INFERIOR | N3 | src/pages/gs/DevolucoesPage.tsx | server/src/routes/v1/core.ts:9289-9313 + SaleReturnService | ausente (para elevação pontual; a devolução em si tem suíte  | createSaleReturn recebe companyId do token |
| V11-AUT-015 | #11 Autorização Pontual | Reabertura de caixa fechado (com ou sem autorização) | **F** | INFERIOR | N3 | ausente | ausente (closeSession é terminal — CashService.ts:340) | ausente | n/a |
| V11-AUT-016 | #11 Autorização Pontual | Cancelamento de ITEM da venda em andamento com autorização/trilha | **F** | INFERIOR | N3 | src/pages/gs/PdvPage.tsx (remoção de linha local) | ausente | ausente | n/a |
| V11-AUT-017 | #11 Autorização Pontual | Consulta/relatório das liberações concedidas (quem pediu, quem liberou, quanto, consumida  | **C** | NAO_COMPARAVEL | N3 | parcial: src/pages/gs/AuditoriaPage.tsx + OrcamentosPage.tsx:975; tela | GET /core/authorizations (core.ts:3158) | src/pages/gs/__tests__/orcamentoLiberadoPor.test.tsx VERDE ( | listAuthorizations filtra company_id |
| V11-AUT-018 | #11 Autorização Pontual | Tenant e terminal/IP registrados na liberação | **C** | INFERIOR | N3 | n/a | server/src/services/core/AuthorizationService.ts:123, 180-197 | ausente | tenant sim; terminal não |
| V12-PRE-001 | #12 Pré-venda/Orçamento/Consignado | PRÉ-VENDA: criar e salvar com número automático, data, cliente, validade, observação e des | **A** | EQUIVALENTE | N1 | src/pages/gs/OrcamentosPage.tsx (NovoDocumentoDialog: busca de produto | POST /core/quotes (server/src/routes/v1/core.ts:2818) → createQuote (s | server/tests/orcamento-prevenda.test.ts; server/tests/gerent | company_id em toda query; teste 'documento de |
| V12-PRE-002 | #12 Pré-venda/Orçamento/Consignado | PRÉ-VENDA: reserva de estoque (o que ela reserva e o que não) | **A** | EQUIVALENTE | N1 | OrcamentosPage.tsx mostra 'estoque reservado até <data>' na criação/ap | QuoteService.createQuote + InventoryService.reserveStock (PRE_SALE_RES | server/tests/orcamento-prevenda.test.ts (blocos 'pré-venda s | idem 001 |
| V12-PRE-003 | #12 Pré-venda/Orçamento/Consignado | PRÉ-VENDA/ORÇAMENTO: listar, sair da tela e recuperar depois | **A** | EQUIVALENTE | N2 | OrcamentosPage.tsx (tabela + DetalheDialog); PDV F9 lista pré-vendas a | GET /core/quotes, GET /core/quotes/:id (abertaAo balcao+escritorio) | server/tests/gerente-oficina-no-balcao.test.ts (VERDE); fron | listQuotes/loadQuote sempre com company_id |
| V12-PRE-004 | #12 Pré-venda/Orçamento/Consignado | EDITAR documento aberto (orçamento ou pré-venda): itens, quantidades, preços | **F** | INFERIOR | N3 | ausente | ausente | ausente | n-conferido |
| V12-PRE-005 | #12 Pré-venda/Orçamento/Consignado | PRÉ-VENDA: converter em venda no PDV (F9) — reserva vira baixa sem dupla contagem | **A** | SUPERIOR | N1 | PdvPage.tsx F9 (openQuotes/loadQuote/finalize) | POST /core/quotes/:id/convert → convertQuote → createSale (mesma trans | server/tests/orcamento-prevenda.test.ts; server/tests/docume | teste de outra empresa VERDE; convertQuote ca |
| V12-PRE-006 | #12 Pré-venda/Orçamento/Consignado | Carrinho em espera no PDV (F7) — segurar e retomar atendimento | **B** | EQUIVALENTE | N1 | src/pages/gs/pdvEmEspera.ts + PdvPage.tsx (F7) | POST /core/pricing/cart (reprecificação na retomada); a espera em si é | src/pages/gs/__tests__/pdvEmEspera.test.ts; server/tests/car | escopo sem-caixa:<companyId> separa as 6 empr |
| V12-PRE-007 | #12 Pré-venda/Orçamento/Consignado | ORÇAMENTO: criar e salvar (cotação sem reserva, permitida acima do saldo, preço de linha n | **A** | EQUIVALENTE | N1 | OrcamentosPage.tsx (aba Orçamento + NovoDocumentoDialog) | POST /core/quotes kind=orcamento | server/tests/orcamento-prevenda.test.ts; server/tests/tabela | idem 001 |
| V12-PRE-008 | #12 Pré-venda/Orçamento/Consignado | ORÇAMENTO/PRÉ-VENDA: imprimir / exportar PDF | **A** | EQUIVALENTE | N2 | OrcamentosPage.tsx DetalheDialog + src/lib/print.ts | PrintEngine ('QUOTE','PRE_SALE'; PRE_SALE em a4) + PrintRenderer.rende | server/tests/impressao.test.ts (VERDE) | renderQuote recebe companyId |
| V12-PRE-009 | #12 Pré-venda/Orçamento/Consignado | ORÇAMENTO/PRÉ-VENDA: validade e expiração automática | **A** | EQUIVALENTE | N1 | OrcamentosPage.tsx (campo 'Válido até' com sugestão da política + botã | validadeDaReserva (SalePolicyService) + expireOverdueQuotes (QuoteServ | server/tests/orcamento-prevenda.test.ts; src/pages/gs/__test | varredura por companyId na abertura do caixa  |
| V12-PRE-010 | #12 Pré-venda/Orçamento/Consignado | Renovar a validade de documento vencido | **F** | INFERIOR | N3 | ausente (a mensagem promete uma ação que não existe) | ausente | ausente | n-conferido |
| V12-PRE-011 | #12 Pré-venda/Orçamento/Consignado | ORÇAMENTO: converter em venda — e A REGRA REAL de preço na conversão | **B** | EQUIVALENTE | N1 | fluxo de tela é em 2 passos: Aprovar→pré-venda→PDV F9; conversão DIRET | POST /core/quotes/:id/convert (aceita os dois kinds) | server/tests/orcamento-prevenda.test.ts; server/tests/docume | idem 005 |
| V12-PRE-012 | #12 Pré-venda/Orçamento/Consignado | ORÇAMENTO: aprovar → pré-venda (promote) com estoque conferido na aprovação | **A** | EQUIVALENTE | N1 | OrcamentosPage.tsx botão 'Aprovar → pré-venda' + diálogo de gestor qua | POST /core/quotes/:id/promote → promoteToPreSale (reusa createQuote; a | server/tests/orcamento-prevenda.test.ts; server/tests/docume | idem 001 |
| V12-PRE-013 | #12 Pré-venda/Orçamento/Consignado | Vendedor no documento e comissão atravessando a conversão | **C** | INFERIOR | N3 | ausente (campo vendedor não existe na tela de orçamento; o PDV tem sel | presente (rota e serviço aceitam e propagam sellerId) | n-conferido (nenhum teste cobre comissão de venda convertida | idem 001 |
| V12-PRE-014 | #12 Pré-venda/Orçamento/Consignado | Alçada de desconto no documento — mecanismo REAL de liberação pontual de gestor | **A** | SUPERIOR | N1 | OrcamentosPage.tsx (aprovacaoPendente + AutorizacaoGerenteDialog de Pa | AuthorizationService (discountNeedsAuthorization, consumirLiberacaoDeC | server/tests/documento-vira-venda-sem-brecha.test.ts (VERDE) | autorizações por company_id |
| V12-PRE-015 | #12 Pré-venda/Orçamento/Consignado | Cancelamento de documento (devolve reserva, idempotente, convertido não cancela) | **A** | EQUIVALENTE | N1 | OrcamentosPage.tsx botões Cancelar (lista e detalhe) | POST /core/quotes/:id/cancel → cancelQuote (QuoteService.ts:1192) | server/tests/orcamento-prevenda.test.ts | idem 001 |
| V12-PRE-016 | #12 Pré-venda/Orçamento/Consignado | CONSIGNADO: ciclo completo (entrega→saída de estoque→retorno parcial→venda parcial→fechame | **F** | INFERIOR | N3 | ausente | ausente | ausente | n-conferido |
| V13-ASS-001 | #13 Asaas/Contas a Receber | Credencial Asaas POR EMPRESA no cofre (tenant-aware, sandbox e produção separados) | **A** | EQUIVALENTE | N1 | src/pages/gs/IntegracaoAsaasPage.tsx | PUT/DELETE /core/integrations/asaas/credentials (core.ts:8430,8544) | server/tests/asaas-e-por-operacao.test.ts (verde) | provado por teste: chave de uma empresa não v |
| V13-ASS-002 | #13 Asaas/Contas a Receber | Tela de integração (IntegracaoAsaasPage): status, credenciais mascaradas, token de webhook | **A** | EQUIVALENTE | N2 | src/pages/gs/IntegracaoAsaasPage.tsx (rota /sistema/integracoes/asaas, | 8 rotas /core/integrations/asaas* (core.ts:8408-8621), requireProfile  | server/tests/asaas-integration.test.ts (verde) | scope(req) do token |
| V13-ASS-003 | #13 Asaas/Contas a Receber | Conta a receber MANUAL com 'gerar cobrança via Asaas' (cobrança avulsa a partir do finance | **F** | INFERIOR | N3 | ausente (ContasPage.tsx sem botão) | ausente (createPaymentIntent sem chamador) | ausente | — |
| V13-ASS-004 | #13 Asaas/Contas a Receber | Parcelamento de cobrança Asaas (installments na cobrança do provedor) | **F** | INFERIOR | N3 | ausente | ausente (AsaasHttpClient.createPayment sem installments) | ausente | — |
| V13-ASS-005 | #13 Asaas/Contas a Receber | Cobrança PIX online (QR + copia-e-cola, guardado para não re-buscar) | **G** | EQUIVALENTE | N1 | checkout da vitrine (payments na resposta do POST /storefront/checkout | POST /storefront/checkout → createOrderCharge | server/tests/ecommerce-jornada.test.ts (verde) | cobrança na conta da operação dona do pedido  |
| V13-ASS-006 | #13 Asaas/Contas a Receber | Cobrança boleto (linha digitável + página da fatura) | **G** | EQUIVALENTE | N1 | — | createOrderCharge method='boleto' | server/tests/ecommerce-jornada.test.ts (verde) | — |
| V13-ASS-007 | #13 Asaas/Contas a Receber | Cartão online (CREDIT_CARD pago na página do provedor — sem escopo PCI) | **G** | EQUIVALENTE | N1 | — | createOrderCharge method='cartao' | server/tests/cartao-e-devolucao.test.ts (verde) | — |
| V13-ASS-008 | #13 Asaas/Contas a Receber | Customer link (vínculo cliente ERP ↔ cliente Asaas, por operação E por ambiente, reaprovei | **G** | EQUIVALENTE | N1 | — | resolveAsaasCustomer (chamado por createOrderCharge) | server/tests/ecommerce-jornada.test.ts (verde) | vínculo por company_id + environment (mesmo C |
| V13-ASS-009 | #13 Asaas/Contas a Receber | External reference (cobrança amarrada ao pedido, cliente remoto amarrado ao cadastro) | **A** | EQUIVALENTE | N1 | — | OrderChargeService + AsaasCustomerLinkService | server/tests/ecommerce-jornada.test.ts (verde) | — |
| V13-ASS-010 | #13 Asaas/Contas a Receber | Webhook por empresa com token (URL própria /webhooks/payments/:provider/:companyId; token  | **A** | EQUIVALENTE | N1 | — | POST /storefront/webhooks/payments/asaas[/:companyId] | server/tests/pagamento-webhook.test.ts + webhook-token-do-co | API_WEBHOOK_TENANT_MISMATCH 403: token válido |
| V13-ASS-011 | #13 Asaas/Contas a Receber | Idempotência (uma cobrança por pedido+método; evento processado uma única vez; retomada do | **A** | EQUIVALENTE | N1 | — | OrderChargeService + handlePaymentWebhook | ecommerce-jornada + pagamento-webhook (verdes) | — |
| V13-ASS-012 | #13 Asaas/Contas a Receber | Ciclo de status da cobrança visível ao operador (pending/overdue/confirmed/refunded/charge | **D** | INFERIOR | N1 | ausente (nenhuma tela de cobranças) | core_payment_intents com 10 estados | server/tests/pagamento-webhook.test.ts (verde, só backend) | — |
| V13-ASS-013 | #13 Asaas/Contas a Receber | Baixa automática no financeiro quando pago (webhook liquida) | **A** | EQUIVALENTE | N1 | — | handlePaymentWebhook → markOrderPaid | server/tests/ecommerce-jornada.test.ts (verde) | company_id da intenção; webhook de outra empr |
| V13-ASS-014 | #13 Asaas/Contas a Receber | Cancelamento cancela a cobrança no provedor (os 3 caminhos) | **C** | INFERIOR | N1 | — | cancelOrderCharges (OrderChargeService.ts:320) — chamado só pelo porta | server/tests/ecommerce-jornada.test.ts (verde, caminho do po | — |
| V13-ASS-015 | #13 Asaas/Contas a Receber | Estorno (devolução aciona refund no provedor; webhook de estorno/chargeback reverte o pedi | **G** | EQUIVALENTE | N1 | — | refundOrder + handlePaymentWebhook(reverses) | cartao-e-devolucao + pagamento-webhook + ecommerce-jornada ( | — |
| V13-ASS-016 | #13 Asaas/Contas a Receber | Conciliação Asaas (3 estados de divergência + parcelas somadas + dinheiro fora do caminho  | **A** | EQUIVALENTE | N1 | src/pages/gs/ConciliacaoAsaasPage.tsx (auto-carrega 30 dias ao abrir) | GET /core/asaas/conciliacao (gerente_loja/gerente_oficina) | server/tests/asaas-conciliacao.test.ts + src/pages/gs/__test | teste verde: 'a cobrança de uma empresa não a |
| V13-ASS-017 | #13 Asaas/Contas a Receber | Retry e tratamento de falhas de cobrança/webhook | **C** | NAO_COMPARAVEL | N1 | — | AsaasHttpClient.request + handlePaymentWebhook | server/tests/pagamento-webhook.test.ts (verde) | — |
| V13-ASS-018 | #13 Asaas/Contas a Receber | Recorrência de cobrança (assinatura) | **F** | INFERIOR | N3 | ausente | ausente (só o método HTTP sem chamador) | ausente | — |
| V13-ASS-019 | #13 Asaas/Contas a Receber | Auditoria das operações Asaas | **A** | EQUIVALENTE | N3 | — | recordAudit + core_order_events + domain events | rotas exercitadas por asaas-integration.test.ts (verde), aud | — |
| V13-ASS-020 | #13 Asaas/Contas a Receber | Segurança do segredo (produção SÓ do cofre; chave nunca volta; comparação em tempo constan | **A** | EQUIVALENTE | N2 | — | AsaasCredentialService + IntegrationSecretVaultService | server/tests/asaas-e-por-operacao.test.ts (verde) | produção exige credencial própria da operação |

## 4. FLUXOS E2E EXECUTADOS NESTA AUDITORIA

Todos em banco temporário (isolamento por construção da suíte — `assertDestructiveAllowed`); nenhum tocou o banco operacional. Cada linha é um arquivo de teste de FLUXO rodado **verde** durante a auditoria pelos auditores, com pré-condições fabricadas no próprio teste e efeitos conferidos em estoque/financeiro/auditoria/tenant:

- **#01 Produto:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#02 Estoque:** Rodado VERDE nesta auditoria: 13 arquivos de teste, 201 testes, 0 falhas — audit-inventory (7), ajuste-manual-tem-motivo (15), inventario (17), stock-locations (17), devolucao (22), estoque-historico (16), audit-purchase (13), audit-tenant (14), audit-dashboard (8), etiquetas-formatos+origens+barcode-labels (70), browser quemContouQuemRecebeu (2).
- **#03 Compras:** RODADO VERDE nesta auditoria: 163 testes em 13 arquivos, 0 falhas — servidor 130 (audit-purchase 13, compras 23, nfe-import 15, nfe-conferencia-financeiro 19, compras-status-nota 12, conferencia-volta-para-a-tela 6, reprecificacao 14, nota-de-entrada-guarda-o-xml 12, estoque-historico 16) e navegador 33 (ConciliacaoRecebimentoPage 7, conciliacaoPorta 7, EntradaNotasXml 7, EntradaNotasFornecedor 10, quemContouQuemRecebeu 2).
- **#04 Financeiro:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#05 Contador:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#06 Validade/Relatórios:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#07 Certificado A1:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#08 Dashboard/Acessos:** Rodado VERDE nesta auditoria: audit-dashboard 8/8, audit-portas (raiz, navegador) 120/120, o-menu-nao-promete-o-que-o-servidor-nega 56/56, sessao-do-desligado 6/6, contador-varredura-das-rotas 10/10, audit-auth 9/9 — 209 testes, 0 falhas.
- **#09 PDV Pagamentos/TEF:** RODADO VERDE nesta auditoria: 9 arquivos, 137 testes — audit-pdv (9, E2E com dinheiro+troco e eletrônicos manuais), formas-de-recebimento (17), pdv-maquininha (20), payment-terminals (10), prazos-e-taxas (23), pdv-pix-maquininha (12), venda-troco-pendente (10), devolucao (22), pagamentoDividido browser (14).
- **#10 PDV Avançado:** RODADO VERDE nesta auditoria: 164 testes em 12 arquivos — server: audit-pdv (9, turno E2E nas 6 empresas), pdv-finalizacao (19), alcada-sem-porta-dos-fundos (22), sangria-com-teto (16), audit-impressao+audit-caixa (21); frontend: pdvAtalhos (16), pagamentoDividido (14), pdvEmEspera (15), fechamentoDoTurno, liberacaoComValor (6), balcaoEntreClientes (65 no lote de 6 arquivos), cancelarVenda (12).
- **#11 Autorização Pontual:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#12 Pré-venda/Orçamento/Consignado:** fluxos comprovados por leitura de cadeia + testes citados na matriz (coluna Teste).
- **#13 Asaas/Contas a Receber:** RODADO VERDE nesta auditoria: 8 arquivos de teste, 87 testes passando, 1 pulado (exige chave real, corretamente): ecommerce-jornada 12, asaas-conciliacao 18, pagamento-webhook 18, asaas-integration 13+1, asaas-e-por-operacao 7, webhook-token-do-cofre 6, cartao-e-devolucao 8, ConciliacaoAsaasPage (navegador) 5.

**Resultado agregado: PASS em todos os fluxos executados.** Nenhum FAIL; onde a execução não era possível com segurança (integração externa), o checkpoint foi classificado G/I — nunca "PASS por inferência".

## 5. UX / PRODUTIVIDADE (por leitura de componente, interações contadas)

**PDV (fluxo principal):** MUITO RÁPIDO. Venda simples = bipe → F8 (finalizar rápido em dinheiro exato) — 2 interações; com pagamento misto: bipe → F10 → Alt+1..4 por forma → Enter. Atalhos reais mapeados no código: F2 clientes, F3 caixa, F4 busca, F6 cancela venda, F7 espera, F8 finaliza rápido, F9 pré-vendas, F10 pagamento, Alt+O observação, Alt+1..4 formas. **Contra a lista da referência Velo faltam:** atalho de sangria/suprimento (existem na tela do caixa, não como atalho), gaveta, impressora dedicada, pesquisa de cliente inline. Fluxo 100% teclado: possível na venda; cliente/caixa abrem diálogos com mouse-first.
**Compras (entrada por XML):** RÁPIDO — importar → conferir → confirmar em uma tela, com a conciliação pedido×nota em tela própria nova.
**Recebimento/Conciliação:** RÁPIDO (estados derivados, ações só as reais).
**Financeiro:** MUITO RÁPIDO na baixa (menu → filtro → baixar na linha); estorno idem.
**Oficina:** fluxo completo em tela única + kanban; ACEITÁVEL a RÁPIDO.
**Produtos:** cadastro progressivo REAL (seções recolhíveis; só nome obrigatório) — paridade com a UX descrita na referência; margem/markup bidirecionais com piso por produto são melhores que o descrito.
**Estoque:** rápido para CONSULTAR; **lento para AGIR** na loja (movimentação manual sem tela fora da oficina — GAP P1).
Pontos operacionais fracos honestos: observação da venda via `window.prompt`; quantidade não editável na linha (remove e re-bipa); painel mono-empresa com reload na troca.

## 6. SEGURANÇA E AUTORIZAÇÃO

- **RBAC:** 10 perfis reais; menu, roteador e servidor espelhados por teste AST automático (`o-menu-nao-promete-o-que-o-servidor-nega`, rodado verde); URL direta/API/reload não burlam (120 casos de navegador + varredura de 312 rotas + sessão do desligado — verdes).
- **Tenant:** nenhum furo achado nos 13 domínios; falsificações históricas (23) re-executadas verdes; certificado/Asaas/QR isolados por empresa com testes.
- **Elevação pontual:** implementada para desconto acima da alçada (requestingUser+authorizingUser+venda+auditoria; senha do gestor na mesma tela; uso único). **Não existe** para cancelamento de venda/devolução/reabertura (exigem sessão de gerente) — diferença real contra a referência Velo. Não há "senha mestra" (bom).
- **Sessão:** JWT 1h + refresh rotativo; troca de senha derruba sessões; senha provisória tranca navegação (guarda de rota).
- **Segredos:** cofre AES-256-GCM; senha do A1 selada e consumida pelo pipeline sem trafegar; Asaas produção só do cofre; varredura provou que a senha não aparece em resposta/log/auditoria/erro.
- **Auditoria:** operações sensíveis auditadas (venda, cancelamento, liberação de desconto com os dois usuários, cobrança, certificado); lacunas pontuais registradas (conciliar/vincular nota sem trilha — P3; IP/terminal não gravados na liberação — P3).

## 7. INTEGRAÇÕES EXTERNAS — PRONTO INTERNAMENTE × PRONTO PARA PRODUÇÃO

| Integração | Pronto internamente | Pronto para produção | O que falta (externo) |
| --- | --- | --- | --- |
| TEF/maquininha | Máquina de estados pending→aprovado/recusado/timeout com idempotência, testada com mock; mock **bloqueado em produção** (provado) | **NÃO** | SDK do provedor + PinPad físico + homologação (G) |
| Asaas | Cobrança PIX/boleto/cartão do pedido online, webhook com conferência de valor, conciliação 3-estados, homologação sandbox pela tela — 87 testes verdes | **NÃO** | Rotação das credenciais no portal (dono); depois: teste + homologação pela tela |
| SMTP/E-mail | Fila + carteiro + templates prontos; sem envio | **NÃO** | Senha de aplicativo + EMAIL_* (dono) |
| Fiscal/SEFAZ | Emissão simulada ponta a ponta; A1 no cofre consumido pelo pipeline; statusServico já provado contra SEFAZ-RS real | **NÃO** para emitir | Senha do A1 (reenviar .pfx), cadastro fiscal, CSC, pCredSN/NCM (contador), 1ª homologação |
| Transportadoras | Melhor Envio com conexão real implementada; Correios/Jadlog adapter-only; checkout nunca cobra frete simulado | **NÃO** | Tokens/contratos (dono) |

## 8. DEVORA SUPERIOR AO VELO (somente comprovado; referência = especificação fornecida)

- V01-PRD-010 Margem/markup: editáveis nos DOIS sentidos com preço recalculado no servidor (uma implementação só) + pisos de preço/markup/margem POR PRODUTO com alerta de violação e motivo na tela — política gravada, conta derivada *(auditor #01 Produto)*
- Fila pré-salvar: fotos e códigos de barras extras escolhidos ANTES de o produto existir sobem juntos no Salvar (ProdutoFormPage) — no fluxo clássico a foto se perdia *(auditor #01 Produto)*
- Card de efeitos da conversão de tipo: trocar mercadoria↔peça relata despublicação da vitrine, saldo que muda de lado, reservas comprometidas e preço zero que bloquearia OS (rota própria POST /products/:id/tipo; ProdutoFormConversao.test.tsx verde) *(auditor #01 Produto)*
- Anti-empilhamento com alçada: preço de tabela entra no preço vigente, então o desconto do revendedor não consome a alçada de concessão do operador (PricingService; tabela-de-preco-vale-na-venda 32 testes verdes) *(auditor #01 Produto)*
- Variantes com EAN e código internos PRÓPRIOS por combinação — o leitor do PDV cai na peça exata (variantes.test.ts 18 verdes) *(auditor #01 Produto)*
- Alteração rápida em massa paginada que só salva o que mudou, com markup/margem por linha e saldo somente-leitura (AlteracaoRapidaPage) *(auditor #01 Produto)*
- Múltiplos códigos de barras por produto com unicidade POR EMPRESA nos dois lugares (principal+adicionais) e busca por qualquer um (catalog-aux verde) *(auditor #01 Produto)*
- Clone de produto preservando preços em tabela (ProductCloneService; 1 uso real na trilha) *(auditor #01 Produto)*
- Kit: vende como um, baixa as peças; custo pode derivar da soma; kit-dentro-de-kit recusado no cadastro (catalog-aux verde) *(auditor #01 Produto)*
- Razão com saldo anterior+posterior fechando linha a linha, cobrado em 4 superfícies independentes e íntegro no banco real (0 linhas fora da conta, 0 divergências razão×cache nas 6 empresas) — audit-inventory.test.ts verde *(auditor #02 Estoque)*
- Cancelar depois de devolver não repõe duas vezes (vender 5, devolver 2, cancelar → voltam exatamente 3) — invariante de cruzamento de fluxos provado verde em devolucao.test.ts *(auditor #02 Estoque)*
- Inventário aplica a DIFERENÇA congelada na abertura: a loja segue vendendo durante a contagem e a venda do intervalo não é desfeita pelo acerto — inventario.test.ts verde *(auditor #02 Estoque)*
- Devolução distingue mercadoria boa de defeituosa (restock por item) e devolve o preço PRATICADO, não o do cadastro de hoje *(auditor #02 Estoque)*
- Rótulo do movimento fechado no servidor: ajuste manual não consegue se chamar 'venda' (evitando dar dono a plaquinha) — CORE_REFERENCE_TYPE_INVALID *(auditor #02 Estoque)*
- Custo removido da RESPOSTA (não só da tela) para o perfil mecânico no histórico de movimentações *(auditor #02 Estoque)*
- Assistente de reprecificação pós-entrada: ao confirmar a nota, a tela lista os produtos que ficaram vendendo abaixo do custo/mínimo com preço sugerido editável e aplicação em lote (GET /purchases/notes/:id/repricing + apply; reprecificacao.test.ts 14 verdes) — o aviso de margem encolhendo na hora, não no fechamento do mês *(auditor #03 Compras)*
- Três canais de chegada do documento além do upload: Distribuição DF-e da SEFAZ com manifestação (ciência/confirmação/desconhecimento/operação não realizada com justificativa mínima), XML por e-mail e CT-e do frete no mesmo funil de conferência — com grupo <transp> lido (volumes, pesos, placa, transportador) para a doca bater com o romaneio *(auditor #03 Compras)*
- XML original guardado byte a byte com download por nota e 404 nomeado para nota sem arquivo (nota-de-entrada-guarda-o-xml 12 verdes) — o papel fiscal não se perde do sistema *(auditor #03 Compras)*
- Vencimento do contas a pagar nasce do prazo cadastrado do fornecedor (30 dias no cadastro = 30 dias no vencimento; zero = à vista) — compra não nasce vencida (nfe-conferencia-financeiro verde) *(auditor #03 Compras)*
- Porta por perfil provada nos DOIS lados: menu e rota da conciliação usam a MESMA lista (QUEM_CONCILIA_RECEBIMENTO), atendente não vê o item (conciliacaoPorta 7 verdes), e o guarda menu×servidor por AST cobre as telas de compras *(auditor #03 Compras)*
- Peça de oficina nasce na entrada da nota: marcar mercadoria como peça da bancada no fim da conferência, com aviso explícito de preço de venda zero — o caminho que evita a peça saindo de graça na OS *(auditor #03 Compras)*
- Conciliação painel×DRE NOMEADA e conferida: differenceCents é provado igual à soma das parcelas nomeadas por origem (pedido online, receita de serviço...) — dre-competencia verde; dois números diferentes nunca ficam mudos *(auditor #04 Financeiro)*
- DRE com 3 invariantes de partição conferidas em runtime (estoura em vez de devolver número plausível errado) e ressalvas geradas no SERVIDOR e renderizadas obrigatoriamente na tela *(auditor #04 Financeiro)*
- Estorno de baixa preserva o extrato: contrapartida negativa + carimbo, e a conciliação bancária detecta baixa estornada JÁ conciliada como divergência (cheque devolvido) — conciliacao-bancaria-fecha verde *(auditor #04 Financeiro)*
- Baixa concorrente segura por UPDATE condicional: dois cliques/dois caixas na mesma conta não pagam acima do devido (garantia no SQL, não em conferência prévia) *(auditor #04 Financeiro)*
- Comissão com snapshot de regra na venda (mudar o percentual não reescreve mês pago), estorno automático negativo em cancelamento/devolução, e fechamento auditado que vira conta a pagar 'Folha' com financeEntryId *(auditor #04 Financeiro)*
- Taxa de cartão como despesa própria com calendário por parcela (30/60/90) e centavo de sobra na 1ª — o custo da maquininha aparece no DRE em vez de sumir dentro da receita líquida (prazos-e-taxas 23 verdes) *(auditor #04 Financeiro)*
- Cancelamento de venda zera os QUATRO lugares que respondem 'quanto' de uma vez (lista, resumo, painel, DRE) por carimbo cancelled_at imune a baixa posterior — e recusa baixa em lançamento cancelado (409) *(auditor #04 Financeiro)*
- Fechamento do contador: o mês inteiro num zip com LEIA-ME de lacunas dentro do pacote (FechamentoContadorPage) — entrega ao contador o que falta junto com o que tem *(auditor #04 Financeiro)*
- Conferência de maquininha: fila de cobranças sem resposta decidida por gestor olhando o extrato da operadora, com registro nominal — o sistema recusa chutar aprovado/recusado *(auditor #04 Financeiro)*
- Alinhamento tela×servidor auditado: o guarda de cada rota financeira bate exatamente com quem o roteador deixa entrar (rodada 23 + teste de menu por AST) — sem tela em branco com 403 *(auditor #04 Financeiro)*
- Prévia com pendências ANTES do download (tela mostra as 6 contagens, lacunas com detalhe e nada bloqueia o botão) — o checklist do vídeo não mostra prévia equivalente *(auditor #05 Contador)*
- LEIA-ME auto-derivado que declara o que NÃO entrou e por quê (inclusive que o certificado instalado é de autoridade de TESTE, com titular/emissor/CNPJ) — pacote que descreve as próprias lacunas *(auditor #05 Contador)*
- MANIFESTO.csv com linhas '(não gerado)'/'(não guardado)' para documentos que existem sem arquivo — a ausência não some em silêncio *(auditor #05 Contador)*
- Peneira de dado simulado em TODAS as consultas (homologação, fixture, protocolo TEST-) com teste provando que prévia e pacote contam a mesma coisa — dado de teste nunca vira escrituração *(auditor #05 Contador)*
- Auditoria nominal do download (fiscal.closing.package com userId): 'quem levou a contabilidade do mês' tem resposta — 2 registros reais no banco *(auditor #05 Contador)*
- Varredura por AST das 358 rotas com login real de contador: 355 respondem 403 do RBAC e as 3 abertas respondem certo — regressão de acesso fica vermelha antes de produção *(auditor #05 Contador)*
- Teto medido antes de carregar (5000 docs/60 MB) com recusa 413 trazendo o número medido — a tela repassa o número em vez de 'falha ao baixar' *(auditor #05 Contador)*
- Consistência aritmética dos relatórios provada por teste rodado nesta auditoria: DRE, painel e lista de vendas dizem o MESMO número no centavo, com bordas do dia da LOJA (23:59:59 pertence ao dia certo) — audit-reports.test.ts 13/13 verde; o vídeo do Velo mostra telas, não garantias assim *(auditor #06 Validade/Relatórios)*
- Trilha de auditoria com filtro de ação e busca aplicados no servidor sobre o histórico INTEIRO (não só a página), restrita aos donos pelo mesmo guarda da rota (AuditoriaPage + GET /core/audit) *(auditor #06 Validade/Relatórios)*
- Pacote mensal do contador em um download: XMLs emitidos e recebidos, eventos, numeração inutilizada, DRE em CSV e MANIFESTO.csv — com teste que confere o conteúdo do CSV contra o banco da empresa certa *(auditor #06 Validade/Relatórios)*
- BI multiempresa recortado pelo VÍNCULO da pessoa (core_user_companies), com margem calculada só onde o custo é confiável e a tela dizendo quantos itens ficaram de fora — honestidade de número que relatório genérico não costuma ter *(auditor #06 Validade/Relatórios)*
- V08-DSH-014 — guarda menu×servidor por AST no CI (56 testes verdes): o menu não consegue prometer o que o servidor nega, por construção — e o teste documenta as quebras propositais que o deixam vermelho *(auditor #08 Dashboard/Acessos)*
- V08-DSH-007 — consistência entre superfícies PROVADA por execução: painel × lista de vendas × BI de operações × tela de Contas devolvem o mesmo número no centavo para o mesmo recorte, e o link para o DRE explica a diferença em vez de esconder *(auditor #08 Dashboard/Acessos)*
- V08-DSH-012 — endurecimento de sessão além do RBAC básico: refresh relê a pessoa de HOJE (desligado cai em ≤1h, rebaixado renova com o perfil atual, recusa revoga, reativação não ressuscita token) *(auditor #08 Dashboard/Acessos)*
- Honestidade dos números: KPI sem dado mostra estado vazio em vez de zero inventado; margem só onde há custo, dizendo quantos itens ficaram de fora; o dashboard executivo decorativo (zeros hardcoded) foi REMOVIDO e o teste prova o 404 *(auditor #08 Dashboard/Acessos)*
- Corte de dia pelo relógio da LOJA (diaDaLojaSql): a venda das 21h30 fica no dia do operador — defeito clássico de fuso já fechado e testado *(auditor #08 Dashboard/Acessos)*
- Timeout incerto vira fila de trabalho travada e auditada: estado timeout_nao_confirmado não avança sozinho (não fecha venda, não recobra, não recusa), exige gestor + motivo + nome na auditoria — pdv-maquininha.test.ts verde prova cada trava (PdvTerminalService.ts:9-24) *(auditor #09 PDV Pagamentos/TEF)*
- Troco só sai do dinheiro LIQUIDADO: PIX pendente não banca troco e não entra no fechamento do caixa (CORE_CHANGE_NOT_CASH; venda-troco-pendente.test.ts verde) — proteção contábil acima do usual em PDV *(auditor #09 PDV Pagamentos/TEF)*
- Idempotency-Key obrigatória na cobrança do terminal (400 sem ela) e reenvio devolve a mesma transação — 'reenvio com a mesma chave não cobra o cliente duas vezes' verde (core.ts:2690-2698) *(auditor #09 PDV Pagamentos/TEF)*
- Mock de TEF fisicamente bloqueado em produção/staging por env assert nas três portas (configurar, credenciar, cobrar) — impossível 'aprovar sem dinheiro trocar de mãos' por engano (PaymentTerminalCredentialService.ts:25-35) *(auditor #09 PDV Pagamentos/TEF)*
- Catálogo de meios no SERVIDOR com comportamento amarrado: método desconhecido recusado na entrada com lista dos aceitos, crediário desligado com mensagem própria — formas-de-recebimento.test.ts verde (17) *(auditor #09 PDV Pagamentos/TEF)*
- Liberação gerencial com TETO NUMÉRICO gravado e consumo único: o 'sim' do gestor vale para aquele valor e uma vez só (granted_concession_cents; autorizar 28% e fechar com 60% é recusado com os dois números) — alcada-sem-porta-dos-fundos.test.ts, 22 verdes *(auditor #10 PDV Avançado)*
- Idempotência por carrinho + fila offline honesta: reenvio por queda de rede não duplica venda, e API_QUEUED_OFFLINE instrui 'NÃO refaça esta venda' em vez de faixa vermelha (PdvPage.finalize) *(auditor #10 PDV Avançado)*
- Reprecificação por cliente DENTRO do PDV pela mesma rota que a venda confere (POST /core/pricing/cart), com marca precificadaPara por linha e preço negociado protegido contra a catraca do Math.min (pdvTypes.ts) *(auditor #10 PDV Avançado)*
- Teto de sangria visível ANTES de digitar, com credencial de gestor no próprio diálogo e valor congelado no momento do pedido (sangria-com-teto.test.ts, 16 verdes) *(auditor #10 PDV Avançado)*
- Ajuda×handler de atalhos amarrados por teste de fonte: atalho prometido é atalho que funciona, e F5/F11/F12 devolvidas ao navegador (pdvAtalhos.test.tsx) *(auditor #10 PDV Avançado)*
- Peça de oficina bipada exige decisão explícita com o nome da bancada — o estoque de conserto da 6ª empresa não esvazia em silêncio pelo balcão das outras 5 *(auditor #10 PDV Avançado)*
- Fechamento com a composição do esperado movimento a movimento e a conta do troco explicada na tela, bloqueado quando o resumo não carrega (fechamentoDoTurno + audit-pdv verdes) *(auditor #10 PDV Avançado)*
- Turno E2E certificado por teste nas SEIS empresas com aritmética em centavos exatos (audit-pdv.test.ts, 9 verdes) *(auditor #10 PDV Avançado)*
- V11-AUT-004 — o 'sim' do gestor é amarrado ao valor E ao percentual que ele viu: liberar R$ 1.800 e vender concedendo R$ 25.000 é recusado (teste VERDE), e o golpe do carrinho mudado (tirar a moto, manter a concessão: 28% virando 68%) é recusado por CORE_AUTHORIZATION_ABOVE_PERCENT com os dois percentuais na mensagem *(auditor #11 Autorização Pontual)*
- Consumo transacional com devolução em rollback: venda que falha DEPOIS do consumo (saldo, caixa fechado) devolve a liberação intacta — o gestor não é chamado de novo por erro técnico (teste VERDE); corrida entre dois documentos decidida por UPDATE condicional, não por SELECT+if *(auditor #11 Autorização Pontual)*
- Anti-oráculo de credenciais: login inexistente e senha errada respondem com a MESMA mensagem e o MESMO custo de tempo (wasteVerificationTime), e a rota é restrita ao balcão+gestão — quem está no caixa não descobre quais logins de gestor existem (testes VERDES) *(auditor #11 Autorização Pontual)*
- Limite de alçada POR EMPRESA configurável pelo dono (PoliticaVendaPage): 5% numa operação e 10% noutra convivem no mesmo grupo (teste 'duas operações, dois limites, ao mesmo tempo' VERDE) — desconto E teto de sangria *(auditor #11 Autorização Pontual)*
- A trava mede a concessão INTEIRA no servidor (rodapé + desconto de linha + preço rebaixado, denominador = preço vigente), fechando os contornos do total inflado pelo cliente, do acréscimo negativo e do orçamento-porta-dos-fundos — todos com teste VERDE de recusa *(auditor #11 Autorização Pontual)*
- V12-PRE-005 Conversão de pré-venda: idempotência por documento (chave quote:<id>:<key>) provada contra o cenário de duas pré-vendas/mesma chave virando uma venda só — e recusa segura ('cinto e suspensório') que não solta reserva; documento-vira-venda-sem-brecha.test.ts 11 VERDES *(auditor #12 Pré-venda/Orçamento/Consignado)*
- V12-PRE-014 Alçada medida ONDE O PREÇO É ESCRITO (criação do documento), herdada na conversão sem cobrar de novo, com liberação pontual de gestor consumível (não é login de gerente), teto em percentual, 'liberado por <nome>' no detalhe e auditoria quote.convert.concessao_aumentou quando a tabela sobe no intervalo *(auditor #12 Pré-venda/Orçamento/Consignado)*
- Credencial por OPERAÇÃO (6 CNPJs) com regra 'produção só do cofre': cobrança nunca cai na conta do CNPJ errado — provado por teste verde (asaas-e-por-operacao), incluindo o caso da empresa dona da chave do .env *(auditor #13 Asaas/Contas a Receber)*
- Conferência de VALOR no webhook: pagamento com valor divergente NÃO marca o pedido pago — vira amount_mismatch pendente de conferência (cartao-e-devolucao verde); um webhook legítimo de R$ 1,00 não libera pedido de R$ 200,00 *(auditor #13 Asaas/Contas a Receber)*
- paid_after_cancel: dinheiro recebido depois do cancelamento não é engolido nem ressuscita o pedido — fica registrado, e a conciliação o mostra (asaas-conciliacao verde) *(auditor #13 Asaas/Contas a Receber)*
- Conciliação inclui o dinheiro FORA do caminho feliz (paid_after_cancel + amount_mismatch) e soma parcelas por fato — sem divergência falsa de 3x e sem esconder cobrança dupla (D5/D6 consertados, 18 testes verdes) *(auditor #13 Asaas/Contas a Receber)*
- Webhook resiliente: evento que falhou no meio (processed=0) é RETOMADO na reentrega do provedor em vez de descartado como duplicata; token comparado em tempo constante; evento fora de ordem não regride estado (rank) *(auditor #13 Asaas/Contas a Receber)*
- Cartão sem escopo PCI: o número do cartão nunca passa pelo ERP — a cobrança nasce CREDIT_CARD e é digitada na página do provedor *(auditor #13 Asaas/Contas a Receber)*
- Homologação sandbox executável pela própria tela, com checklist passo a passo e as 5 travas de produção explicadas em português *(auditor #13 Asaas/Contas a Receber)*

## 9. VELO SUPERIOR AO DEVORA (segundo a especificação fornecida; comprovado do lado Devora)

**Funcionalidade ausente:** validade/lote (ciclo inteiro); consignado; preço por quantidade; campos personalizados; dias da semana em promoção; parcelamento manual de título; cobrança avulsa/recorrência Asaas a partir do financeiro; produto sem controle de estoque (serviço de balcão); envio automático do pacote ao contador por e-mail; vendas por marca no dashboard.
**UX pior:** cliente inline no PDV (pesquisar/cadastrar sem sair da venda); desconto digitável no PDV; quantidade na linha; observação via prompt; central de relatórios parametrizada com exportação (Devora: telas fixas, exportação só no zip fiscal).
**Automação ausente:** agendamento de fechamento/envio contábil; retry autônomo de cobrança falhada.
**Processo incompleto:** rastro de item cancelado no carrinho (rodapé fixo em 0); elevação pontual para cancelamento/estorno; volta título→documento não navegável.
**Integração externa:** TEF integrado em uso (na referência aparece operando; aqui aguarda SDK/hardware) — não é defeito de código.

## 10. GAP REGISTER (76 gaps: 0×P0 · 12×P1 · 24×P2 · 40×P3)

IDs sequenciais por ordem de vídeo. Nenhum gap foi implementado — este registro é o insumo do roadmap (§14).

**GAP-V01 [P2] Grupo tributário sem seletor em NENHUMA tela de produto** *(#01 Produto)*
- Impacto: Empresa que cadastrar um SEGUNDO grupo tributário ativo trava a emissão fiscal de todo produto sem perfil — e a mensagem de erro manda 'escolher o perfil no cadastro do produto', campo que não existe na tela. Hoje só não dói porque o banco real tem 1 grupo.
- Evidência: server/src/services/core/TributacaoDoItem.ts:155-160 (recusa com 2+ grupos); ProdutoFormPage.tsx sem o campo; FiscalPage.tsx:466 rascunho só {ncm,cfop,origin,cest}; PATCH /core/fiscal/product-pendencies/:id JÁ aceita taxProfile (core.ts:4625); core_products.tax_profile: 0 de 19 preenchidos.
- Referência Velo: Grupo tributário é campo do cadastro do produto.
- Devora parcial: CRUD do grupo completo em Auxiliares; consumo na emissão completo; falta só a atribuição pela tela.
- Risco: Baixo — backend e validação prontos.
- Recomendação (NÃO implementada): Acrescentar select de grupo tributário na seção Fiscal do ProdutoFormPage (e/ou no rascunho da pendência fiscal), enviando taxProfile pela rota que já existe.

**GAP-V02 [P2] Não existe produto sem controle de estoque (serviço de balcão)** *(#01 Produto)*
- Impacto: Um serviço de varejo (ajuste de roupa, instalação, película) não pode ser vendido no PDV: toda linha baixa estoque e o CHECK(quantity>=0) recusa sem saldo. O contorno real é lançar saldo fictício — que suja o razão.
- Evidência: SalesService.baixasDaLinha (l.82-107) baixa TODA linha não-kit; core_stock CHECK quantity>=0 (schema.ts:762); nenhuma coluna liga/desliga em core_products; serviço só existe via OS (serviceTotalCents, SalesService.ts:142).
- Referência Velo: Toggle de controle de estoque por produto (produto sem estoque = serviço).
- Devora parcial: Preço aberto cobre o valor combinado; OS cobre mão de obra da oficina; falta o serviço vendável no balcão de varejo.
- Recomendação (NÃO implementada): Flag no cadastro (ex.: kind='service' ou stock_control=0) que pula a baixa na venda — reaproveitando o precedente do kit desmembrado, que já vende sem saldo próprio.

**GAP-V03 [P3] Promoção não tem dias da semana** *(#01 Produto)*
- Impacto: 'Toda quarta a fruta X em oferta' exige recriar a promoção a cada semana; a do Velo agenda uma vez.
- Evidência: core_promotions só tem starts_at/ends_at (schema.ts:2596-2608); PromocoesPage sem UI de dias.
- Referência Velo: Dias promocionais da semana no cadastro da promoção.
- Recomendação (NÃO implementada): Coluna weekdays (bitmask/JSON) em core_promotions + filtro em promocoesVigentes + checkboxes na PromocoesPage.

**GAP-V04 [P3] Preço por quantidade (escalonado) inexistente** *(#01 Produto)*
- Impacto: '3 por R$ 10' ou preço de atacado por volume para cliente avulso não existe — a tabela de preço exige cliente identificado e vinculado.
- Evidência: Nenhuma estrutura de faixa por quantidade (grep em server/src); tabela de preço é por CLIENTE (core_customers.price_table_id).
- Referência Velo: Preço escalonado por quantidade no cadastro do produto.
- Devora parcial: Tabelas de preço cobrem o atacado por cliente (32 testes verdes).
- Recomendação (NÃO implementada): Faixas min_quantity→preço em tabela própria, aplicadas em effectivePriceCents pela quantidade da linha — mantendo a regra anti-empilhamento.

**GAP-V05 [P3] Histórico do produto sem diff de campos** *(#01 Produto)*
- Impacto: A trilha diz que houve product.update (20 no banco real) mas não O QUE mudou — 'quem alterou o preço de 39,90 para 29,90?' não tem resposta; e gerente não lê a Auditoria (só admin/gestor).
- Evidência: PUT /products/:id grava recordAudit sem detail (core.ts:1984-1991); AuditoriaPage restrita a DONOS_DO_GRUPO; sem aba de histórico no formulário.
- Referência Velo: Histórico de alterações campo a campo visível no produto.
- Recomendação (NÃO implementada): Gravar detail com campos alterados (de/para) no product.update — o padrão já existe em fiscal.product_updated (detail.fields) — e expor um 'Histórico' na ficha do produto filtrando por entity_id.

**GAP-V06 [P3] Embalagem/fator não é atributo do cadastro** *(#01 Produto)*
- Impacto: O fator caixa→unidade é redigitado a cada entrada de nota; erro de digitação numa entrada futura multiplica ou divide estoque e custo silenciosamente.
- Evidência: conversion_factor vive em core_inbound_note_items (por linha de nota — NfeImportService.ts:796-825, 1092-1100), não em core_products; kit cobre só o lado da venda.
- Referência Velo: Cadastro de embalagens/caixas com fator no produto.
- Devora parcial: Entrada converte com fator informado; venda de caixa via kit desmembrado (testes verdes).
- Recomendação (NÃO implementada): Guardar o fator aprendido por (produto, fornecedor/EAN da caixa) e pré-preencher na conferência seguinte.

**GAP-V07 [P3] Campos personalizados inexistentes** *(#01 Produto)*
- Impacto: Atributos específicos do negócio (ex.: voltagem, aro, validade) não têm onde morar fora de descrição/variant_attributes.
- Evidência: Zero ocorrências de custom field em src/ e server/src.
- Referência Velo: Campos personalizados por produto.
- Recomendação (NÃO implementada): Só se a operação pedir — variant_attributes JSON já cobre grade; avaliar demanda real antes de criar EAV genérico.

**GAP-V08 [P3] IPI não emitido (vIPI fixo 0.00)** *(#01 Produto)*
- Impacto: Se alguma empresa do grupo vier a precisar destacar IPI (improvável no varejo Simples), o XML sai zerado.
- Evidência: FiscalXmlNfce.ts:604 '<vIPI>0.00</vIPI>' hardcoded; core_tax_rates aceita kind='ipi' sem consumidor na emissão.
- Dependência: Emissão homologada real ainda depende de senha A1/CSC do dono (contexto G).
- Recomendação (NÃO implementada): Documentar como fora de escopo do varejo Simples ou ligar o rate kind='ipi' ao grupo do item.

**GAP-V09 [P1] Movimentação manual de estoque sem tela na loja** *(#02 Estoque)*
- Impacto: Perda, uso interno e carga avulsa de estoque são impossíveis pela UI da loja: a rota POST /core/stock/movements está pronta, testada e auditada (motivo obrigatório, rótulo fechado, idempotência), mas coreApi.addStockMovement (src/lib/api/core.ts:2323) não tem nenhum chamador. Pior: ProdutoFormPage.tsx:1452 manda o usuário 'lançar um movimento em Estoque › Movimentações' — e MovimentacoesEstoquePage é só leitura. Promessa de tela que o sistema não cumpre, o mesmo defeito que o próprio repo documentou no botão de cancelar.
- Evidência: grep movementType/addStockMovement em src/: zero chamadores; ProdutoFormPage.tsx:1452-1455; MovimentacoesEstoquePage.tsx sem formulário
- Referência Velo: Tela de lançamento manual de movimentação com tipo e motivo
- Devora parcial: Oficina tem entrada pela gaveta (PecasPage); loja tem planilha (em massa) e contagem de inventário (por catálogo inteiro)
- Recomendação (NÃO implementada): Adicionar formulário de movimento (entrada/saída/ajuste, com motivo e local) na MovimentacoesEstoquePage — o servidor já valida tudo; é ligar o fio que existe.

**GAP-V10 [P1] Crédito de devolução não vira saldo consumível — ciclo de troca não fecha** *(#02 Estoque)*
- Impacto: A devolução com 'Crédito na loja' registra o método e o DRE ressalva o valor, mas não existe conta de crédito do cliente nem forma de pagamento que o consuma na venda seguinte. O operador dá o crédito pelo sistema e cobra de volta no papel — o dinheiro devido ao cliente vive fora do sistema.
- Evidência: IncomeStatementService.ts:284-288 ('o crédito ainda nem existe como saldo no sistema — a rodada 21 já apontou isso'); PaymentMethods.ts sem método de crédito-da-loja; grep customer_credit/credit_balance: zero tabelas
- Referência Velo: Troca com vale/crédito consumível na venda seguinte
- Devora parcial: refund_method='credito' gravado e medido no DRE como ressalva
- Recomendação (NÃO implementada): Criar o saldo de crédito do cliente (razão próprio, como o estoque) e a forma de pagamento que o consome no PDV, com teto no saldo disponível.

**GAP-V11 [P2] Valor do estoque não existe em nenhuma superfície** *(#02 Estoque)*
- Impacto: Nenhuma tela ou rota responde 'quanto vale meu estoque' (quantidade × custo) — pergunta padrão de fechamento e de seguro. O dado bruto está pronto (GET /core/stock traz cost_cents por item), falta só a agregação; o stub de BI que prometia inventoryValueCents foi removido por estar hardcoded em zero.
- Evidência: CorporateBIService.ts:13-19; grep de valorização em server/src e src/: sem agregação; EstoquePage sem coluna de valor
- Referência Velo: Relatório/indicador de valor do estoque
- Devora parcial: custo e preço por item já saem na rota de posição
- Recomendação (NÃO implementada): Somar qty × custo no listStock (total no rodapé da posição e por local), respeitando hideCost por perfil.

**GAP-V12 [P2] Contagem de inventário pela UI abre sempre o catálogo inteiro** *(#02 Estoque)*
- Impacto: A rota POST /core/inventory-counts aceita productIds (e o teste usa), mas a InventarioPage só envia scopeNote: toda contagem aberta pela tela congela o catálogo ativo INTEIRO, e a tabela de itens não tem busca nem paginação. Ajustar 1 produto exige rolar a lista completa; numa loja com milhares de SKUs a tela fica impraticável e o acerto avulso, lento.
- Evidência: InventarioPage.tsx:90 (openInventoryCount só com scopeNote); tabela sem filtro; inventario.test.ts prova que a rota aceita lista
- Referência Velo: Balanço por seleção/filtro de itens
- Devora parcial: backend pronto; 'produto encontrado fora da lista entra na contagem' já funciona
- Recomendação (NÃO implementada): Expor a seleção de produtos (busca/corredor/categoria) na abertura da contagem e busca na tabela de itens.

**GAP-V13 [P3] Posição de estoque sem campo de busca** *(#02 Estoque)*
- Impacto: EstoquePage lista tudo com um único filtro (abaixo do mínimo); achar um produto é rolar a tabela. O parâmetro search de listStock existe e é usado por outras telas (Locais, Unidades, ProdutoForm) — só a tela principal de posição não o expõe.
- Evidência: OperacaoPages.tsx:305-415 (sem input de busca); core.ts:2011 (search suportado)
- Referência Velo: Busca na consulta de saldo
- Devora parcial: busca existe na rota e em 3 outras telas
- Recomendação (NÃO implementada): Adicionar SearchInput ligado ao listStock({search}) na EstoquePage.

**GAP-V14 [P3] Custo unitário no histórico aparece só como rodapé truncado** *(#02 Estoque)*
- Impacto: MovimentacoesEstoquePage mostra o custo das entradas num parágrafo com as 3 primeiras linhas que têm custo — não como coluna. Quem investiga o custo de uma entrada específica no meio do histórico não o encontra na linha dela.
- Evidência: MovimentacoesEstoquePage.tsx:360-369
- Referência Velo: Custo visível por movimento
- Devora parcial: dado presente na resposta; exibição truncada
- Recomendação (NÃO implementada): Coluna de custo unitário no histórico (já vem podada pelo servidor para o mecânico via hideCost).

**GAP-V15 [P3] Transferência entre locais sem teste HTTP de rota** *(#02 Estoque)*
- Impacto: POST /core/stock/transfers é rota fina sobre transferStock (testado a fundo no nível do serviço), mas nenhum teste atravessa a rota — permissão, parse do corpo e auditoria dela não têm cobrança automática.
- Evidência: grep stock/transfers em server/tests: zero; stock-locations.test.ts importa o serviço direto
- Dependência: nenhuma
- Risco: baixo — a rota só repassa
- Recomendação (NÃO implementada): Um teste supertest cobrindo 201, recusa de perfil e o recordAudit da rota.

**GAP-V16 [P1] Tela de pedidos cria itens sem produto do catálogo — conciliação item a item inalcançável pela interface** *(#03 Compras)*
- Impacto: Pedido criado pela ÚNICA tela de criação (PedidosCompraPage) nasce com product_id NULL em todos os itens; recalcReceived casa por product_id, então o 'Recebido' fica 0 e o pedido preso em 'enviado' para sempre, mesmo com notas amarradas e confirmadas — exatamente o sintoma que a rodada P1.2 fechou para pedidos criados por API. A ConciliacaoRecebimentoPage mostraria tudo como Pendente + itens da nota como extras.
- Evidência: PedidosCompraPage.tsx:99-105 (items: description/quantity/unitCostCents, sem productId; formulário sem busca de produto) vs PurchaseOrderService.ts:267-269 ('if (item.product_id)' — item sem produto soma 0) e ConciliacaoRecebimentoPage.tsx:202 (casa por productId). O backend ACEITA productId (PurchaseOrderItemInput) e todos os testes verdes o usam via API.
- Referência Velo: Pedido de compra com itens do catálogo, permitindo o confronto pedido×nota por item
- Devora parcial: Backend completo e provado; descrição livre funciona para embalagem/café (decisão documentada), mas é o único caminho da tela
- Recomendação (NÃO implementada): Adicionar autocomplete de produto do catálogo nas linhas do formulário de pedido (mantendo a descrição livre como alternativa legítima para não-revenda). Backend não muda.

**GAP-V17 [P2] Entrada de mercadoria sem XML não gera documento nem título a pagar** *(#03 Compras)*
- Impacto: Compra de fornecedor sem NF-e (feira, autônomo — que o cadastro de fornecedor aceita SEM documento de propósito) entra por movimento manual de estoque: sem nota, sem vínculo com fornecedor, sem contas a pagar. A dívida dessa compra não existe no financeiro e o histórico do fornecedor não a vê.
- Evidência: Único INSERT em core_inbound_notes é o de importNfe (NfeImportService.ts:613); POST /stock/movements (core.ts:2090) move estoque com custo mas não cria documento nem lançamento; compras.test.ts prova que 'Seu Zé das Embalagens' é cadastrável — mas nada compra dele com rastro completo.
- Referência Velo: Entrada manual digitada, sem XML
- Devora parcial: Movimento manual de estoque com custo/motivo/auditoria e importação de planilha existem — mas nenhum gera dívida nem documento
- Recomendação (NÃO implementada): Rota de nota manual (cabeçalho fornecedor+número+total, itens digitados) desaguando no MESMO funil conferir→confirmar — reaproveita estoque, financeiro, conciliação e auditoria já provados.

**GAP-V18 [P2] A volta financeiro→documento não é navegável: origin_id não sai pela API** *(#03 Compras)*
- Impacto: Quem abre o contas a pagar e quer a nota que gerou a dívida só tem o texto 'NF-e 1234' — sem link, sem id. Para conferir divergência (dívida 10, prateleira 8) a pessoa navega para outra tela e busca pelo número na mão.
- Evidência: FinanceService.ts:77-103 (toEntry expõe originType mas não origin_id); o próprio audit-purchase.test.ts:143-147 registra: 'A amarração dívida→nota (origin_id) NÃO sai pela API' e verifica direto no banco.
- Referência Velo: Navegação do título para o documento de origem
- Devora parcial: origin_type/origin_id íntegros no banco; descrição carrega o número da nota (teste 'é assim que o financeiro acha o papel')
- Recomendação (NÃO implementada): Expor originId no toEntry e transformar a descrição em link para a nota na ContasPage. O dado já está gravado.

**GAP-V19 [P3] Amarrar nota a pedido, conferir item e vincular produto não deixam trilha de auditoria** *(#03 Compras)*
- Impacto: purchase.nfe.import/confirm, purchase_orders.created/sent/cancelled e suppliers.* gravam recordAudit — mas POST /purchase-orders/:id/notes/:noteId (amarrar/re-amarrar), /purchases/notes/:id/conferir, /notes/:id/link e PUT /purchase-orders/:id/items não. Re-amarrar muda o retrato de DOIS pedidos sem registro de quem o fez; a contagem da doca fica sem autor na trilha central (a nota guarda received_by só na confirmação).
- Evidência: core.ts:9231-9239 (amarrar), 7895-7923 (conferir), 7874-7888 (link), 9179-9188 (PUT items) — nenhum recordAudit; contraste com core.ts:7670-7687 e 9154-9228.
- Referência Velo: n-conferido
- Devora parcial: AuditoriaPage e core_audit_log existem e as mutações principais gravam
- Recomendação (NÃO implementada): recordAudit nas quatro rotas (ação, noteId/orderId, itemIndex, quantidade contada).

**GAP-V20 [P3] Entrada confirmada não tem estorno — corrigir nota errada exige acerto em duas pontas desconectadas** *(#03 Compras)*
- Impacto: XML confirmado por engano (nota do irmão da outra empresa, arquivo duplicado com chave diferente): o estoque só desce por ajuste manual com motivo, e a dívida só sai cancelando o lançamento no financeiro — dois gestos sem vínculo entre si nem com a nota, e o histórico do fornecedor continua contando a compra.
- Evidência: Nenhuma rota notes/:id/cancel|estorno (grep vazio); conferir após 'recebida' é recusado (nfe-conferencia-financeiro 'vira ajuste de inventário' — verde); cancelamento de lançamento financeiro existe à parte (cancelled_at em toEntry).
- Referência Velo: Cancelamento/estorno da entrada
- Devora parcial: Ajuste manual com motivo obrigatório + cancelamento avulso de lançamento cobrem o efeito, sem o vínculo
- Recomendação (NÃO implementada): Estorno de nota (status 'estornada') que reverta movimento e cancele o lançamento na MESMA transação, com motivo e auditoria — o espelho do confirmNfe.

**GAP-V21 [P3] Nota real do banco operacional está 'recebida' sem dívida no financeiro** *(#03 Compras)*
- Impacto: A NF 9991 (R$ 1.485,60, única nota de produção) foi confirmada antes da integração com o financeiro: não há NENHUM lançamento origin_type='nfe_entrada' no banco operacional. Se essa compra não foi paga/registrada por fora, há uma dívida real invisível no contas a pagar.
- Evidência: Consulta read-only: core_inbound_notes tem 1 linha (status 'recebida', total 148560, purchase_order_id NULL, sem xml_original); core_finance_entries não tem linha nfe_entrada. O código atual NÃO reescreve notas antigas por decisão registrada (NfeImportService.ts:1259-1264).
- Referência Velo: n-comparavel
- Devora parcial: Toda entrada NOVA cria a dívida (19 testes verdes)
- Recomendação (NÃO implementada): Conferência humana única: o dono verifica se a NF 9991 foi paga e, se preciso, lança a dívida manualmente. Não é defeito de código.

**GAP-V22 [P1] Título não navega até a origem (e a lista não expõe a origem)** *(#04 Financeiro)*
- Impacto: Quem cobra ou paga não consegue abrir a venda/nota que gerou o título sem caçar pelo texto da descrição; auditoria de um lançamento estranho exige SQL. É a metade que falta da rastreabilidade que o Velo demonstra na lista.
- Evidência: FinanceService.toEntry (server/src/services/core/FinanceService.ts:77-103) não serializa origin_id; src/lib/api/core.ts:1701 só tem originType; ContasPage.tsx não renderiza nem originType; VendasPage (OperacaoPages.tsx:1208) não tem detalhe com títulos.
- Referência Velo: Lista de títulos expõe o documento de origem e navega para ele
- Devora parcial: Descrição carrega 'Venda #N' e a busca LIKE encontra; origin_type/origin_id íntegros no banco
- Recomendação (NÃO implementada): Serializar originId no toEntry, adicionar coluna/badge de origem com Link para /vendas ou /compras conforme origin_type, e na ficha da venda listar os lançamentos por origin_id (a consulta é a UNIQUE que já existe).

**GAP-V23 [P1] Parcelamento manual não existe (crediário desativado)** *(#04 Financeiro)*
- Impacto: Venda a prazo negociada no balcão (carnê 3x sem cartão) não tem como ser registrada como 3 títulos: ou vira 1 título só (cobrança errada) ou 3 lançamentos digitados à mão sem vínculo entre si.
- Evidência: PaymentMethods.ts:70 — crediario active:false com gate deferred e comentário explicando que fechava quitado sem parcela; NovaContaCard (ContasPage.tsx:701) cria um título único; banco real: 0 lançamentos com installment_total > 1.
- Referência Velo: Título parcelado manual com N vencimentos
- Devora parcial: Cartão gera N parcelas via operadora (comprovado verde); esquema pronto para carnê
- Dependência: nenhuma externa
- Recomendação (NÃO implementada): Campo 'parcelar em N' no lançamento avulso gerando N linhas com installment_number/total (colunas e UNIQUE já prontos — comentário do schema.ts:1494 diz que baixa/estorno/conciliações já funcionam sobre parcela sem código novo); depois reativar o crediário pelo gancho deferred.

**GAP-V24 [P2] Sem aging por faixas de atraso** *(#04 Financeiro)*
- Impacto: O gestor vê QUANTO está vencido, mas não HÁ QUANTO TEMPO — priorizar cobrança (30 vs 90+ dias) exige filtrar datas na mão.
- Evidência: Grep por aging/faixas de atraso em server/src e src: zero ocorrências; só overdue booleano, overdueCents no summarize e filtros dueFrom/dueTo (FinanceService.ts:105-121).
- Referência Velo: Relatório de vencidos por faixa de idade
- Recomendação (NÃO implementada): Buckets no summarize (1-30/31-60/61-90/90+) por due_date contra hojeNaLoja — é um CASE a mais na mesma consulta que já soma overdueCents.

**GAP-V25 [P2] Centro de custo gravado sem leitor** *(#04 Financeiro)*
- Impacto: Cadastrar e preencher centro de custo hoje é trabalho sem retorno: nenhum relatório agrupa por centro, e o formulário de Contas nem oferece o campo — o dado só entra por API.
- Evidência: FinanceiroCadastrosPage.tsx:317-334 declara em texto; DRE agrupa só por category_id (IncomeStatementService); NovaContaCard não envia costCenterId; banco real: 0 centros, 0 lançamentos com centro.
- Referência Velo: Centro de custo aparece em relatório
- Devora parcial: Cadastro, rota e persistência completos; honestidade declarada na tela
- Recomendação (NÃO implementada): Ou dar o leitor (dimensão opcional no DRE / filtro na lista de Contas) e o campo no formulário, ou manter cortado como está — meio-termo atual só cria expectativa. Escrita já testada verde (dre-competencia).

**GAP-V26 [P2] Desfazer casamento bancário sem botão na tela** *(#04 Financeiro)*
- Impacto: Quem casa a linha errada do extrato (o erro humano mais provável da tela) não tem como voltar atrás pela interface — a divergência real fica escondida até alguém usar a API na mão.
- Evidência: DELETE /bank/lines/:id/match existe (core.ts:10040) e coreApi.unmatchBankLine existe (src/lib/api/core.ts:4382), mas grep por unmatch/desfazer em ConciliacaoBancariaPage.tsx: zero chamadas.
- Referência Velo: n-conferido
- Devora parcial: Backend e client completos (D nesta sub-capacidade)
- Recomendação (NÃO implementada): Botão 'Desfazer' nas linhas casadas chamando unmatchBankLine — client e rota prontos, é só UI.

**GAP-V27 [P3] Extrato bancário só por CSV colado; sem OFX/upload de arquivo** *(#04 Financeiro)*
- Impacto: Conciliar exige exportar CSV no internet banking, ajustar para data;descrição;valor e colar num textarea — atrito que explica os 0 extratos importados em produção.
- Evidência: ConciliacaoBancariaPage.tsx:194 (textarea) + parseExtratoCsv no navegador; rota aceita só lines já estruturadas (core.ts:9988).
- Referência Velo: n-conferido (import de extrato demonstrado no vídeo)
- Recomendação (NÃO implementada): Parser OFX no navegador (formato estável entre bancos) alimentando o mesmo POST /bank/statements — o dedupe por external_id (FITID) já está pronto do outro lado.

**GAP-V28 [P3] DRE sem CMV/margem** *(#04 Financeiro)*
- Impacto: O resultado do período não desconta o custo da mercadoria vendida — o contador precisa complementar fora do sistema.
- Evidência: IncomeStatementService.ts:71-77 — recusa declarada: core_sale_items não tem coluna de custo; o custo da venda de março não existe para ser lido depois. Ressalva impressa na tela sempre.
- Referência Velo: n-conferido
- Risco: Adicionar CMV sem custo histórico geraria número falso com cara de certo — a recusa atual é a decisão correta até o snapshot existir
- Recomendação (NÃO implementada): Gravar cost_cents no item no momento da venda (snapshot, mesmo padrão da comissão); só então a linha de CMV deixa de ser número inventado.

**GAP-V29 [P3] Fatia à vista da venda nasce quitada sem linha de baixa** *(#04 Financeiro)*
- Impacto: Regime de caixa é impossível de construir e a conciliação bancária não enxerga essas entradas (compara contra core_finance_settlements, que tem 0 linhas no banco real com 7 de 9 lançamentos já quitados).
- Evidência: SalesService insere settled_cents=amount direto (linha 1393-1396) sem INSERT em core_finance_settlements; IncomeStatementService.ts:66-69 documenta; consulta readOnly confirmou 0 settlements.
- Devora parcial: Parcelas de cartão nascem 'open' e a baixa manual delas gera settlement conciliável — o buraco é só a fatia à vista
- Recomendação (NÃO implementada): Gravar a baixa-espelho na venda quitada (mesma transação) — alimenta conciliação e abre a porta do regime de caixa sem mudar nenhum saldo.

**GAP-V30 [P2] Não existe envio do pacote ao contador por e-mail (nem fluxo, nem anexo, nem template)** *(#05 Contador)*
- Impacto: O mês só sai da empresa se alguém baixar e mandar, ou se o contador entrar e buscar. O Velo (vídeo #05) envia o pacote por e-mail em dia configurado; no Devora esse caminho inteiro não existe — a fila de e-mail é só texto, sem suporte a anexo.
- Evidência: server/src/services/notifications/EmailService.ts: EmailTemplate sem template de pacote; MensagemSmtp/sendMail sem campo de anexo; grep no repo sem qualquer fluxo pacote→e-mail.
- Referência Velo: Envio recorrente do pacote de XMLs por e-mail ao contador
- Devora parcial: Autosserviço: perfil contador entra sozinho e baixa (rodada 29, 130 testes verdes nesta auditoria); auditoria registra quem levou
- Dependência: SMTP (EMAIL_SMTP_* vazios — dependência já conhecida; a fila acumula em pending)
- Risco: Mês esquecido sem entrega até alguém lembrar; mitigado pelo autosserviço do contador
- Recomendação (NÃO implementada): Template 'pacote_contador' + anexo no carteiro (nodemailer aceita attachments), cadastro de destinatário e dia por empresa, e um laço no molde do MailInboxScheduler (trava com prazo, execução única). Reusar montarPacote como está.

**GAP-V31 [P3] Não existe automação recorrente (agendamento) do fechamento** *(#05 Contador)*
- Impacto: Nenhuma geração automática por competência; depende de clique humano (do contador ou do gerente).
- Evidência: Grep cron/schedule/setInterval em server/src: só inbox IMAP, flush de e-mail, backup e sync; EmailService.ts:693 declara 'neste servidor não há agendador (ele desliga à noite)'.
- Referência Velo: Rotina recorrente de fechamento/envio
- Devora parcial: Seletor da tela já abre no mês com matéria-prima; pacote é determinístico e re-gerável a qualquer hora
- Dependência: nenhuma técnica; decisão de desenho (servidor desliga à noite)
- Risco: baixo — o pacote é derivado, nada se perde por não agendar
- Recomendação (NÃO implementada): Se o envio por e-mail nascer, o agendamento nasce junto (mesmo gap de desenho). Servidor que desliga à noite pede disparo por evento (primeira subida do mês), não cron.

**GAP-V32 [P2] Arquivo de evento no pacote não é procEventoNFe: assinatura sai como '[removido]'** *(#05 Contador)*
- Impacto: O contador não consegue validar a assinatura do cancelamento/carta de correção pelo arquivo entregue; precisa do portal da SEFAZ. Escrituração funciona; arquivamento probatório não.
- Evidência: FiscalClosingService.ts:1040-1058: sanitizeResponse apaga assinatura/certificado antes de gravar core_fiscal_events.xml, e não há segunda cópia como o xml_signed do procNFe. Irreversível para o passado; o LEIA-ME declara.
- Referência Velo: Entrega eventos no pacote (formato exibido no vídeo não confirma procEventoNFe)
- Devora parcial: Evento entra no pacote com recorte correto pela data do EVENTO e peneira de teste/homologação — testes verdes
- Dependência: nenhuma para novos eventos; o passado não tem conserto
- Risco: Questionamento em fiscalização sobre prova de cancelamento; hoje teórico (0 eventos no banco real)
- Recomendação (NÃO implementada): Passar a guardar o procEventoNFe completo no momento do evento (a assinatura do evento não é segredo — o que a sanitização protege é credencial, não prova pública), mantendo a sanitização só para o envelope de resposta.

**GAP-V33 [P3] NFC-e (modelo 65) no pacote comprovada só por leitura, sem teste específico** *(#05 Contador)*
- Impacto: A consulta de emitidas não filtra modelo — 65 entra por construção —, mas todos os documentos fabricados em fechamento-contador.test.ts são model '55'. Uma regressão que filtrasse modelo passaria verde.
- Evidência: fechamento-contador.test.ts:143 (INSERT fixo em '55'); FiscalClosingService.ts consulta sem cláusula de model.
- Referência Velo: Vídeo mostra 55 e 65 no lote
- Devora parcial: Mecanismo idêntico para os dois modelos; NFC-e simulada já provada em outras suítes (fora do pacote)
- Dependência: nenhuma
- Risco: baixo
- Recomendação (NÃO implementada): Um caso com um documento model '65' AUTHORIZED no período, cobrando o arquivo em emitidas/ e a contagem na prévia.

**GAP-V34 [P3] Conteúdo real do pacote hoje: zero notas de saída (emissão real bloqueada) e a única nota de entrada sem XML** *(#05 Contador)*
- Impacto: Em produção o pacote atual entrega LEIA-ME + MANIFESTO + DRE e declara as ausências — correto e honesto, mas o valor pleno do módulo só aparece quando a emissão real ligar (certificado A1 do dono, endpoints SEFAZ por UF, homologação).
- Evidência: Banco operacional (leitura readOnly): core_fiscal_documents vazio, core_fiscal_events vazio, 1 core_inbound_notes sem xml_original (pré-v58, irreversível e declarado no LEIA-ME com a chave no MANIFESTO).
- Referência Velo: n/a
- Devora parcial: O LEIA-ME nomeia titular/emissor/CNPJ do certificado instalado (que é de TESTE) e a tabela SEFAZ vazia — exatamente para este cenário
- Dependência: Fiscal real: senha do A1 do dono, CSC, endpoints SEFAZ, homologação
- Risco: nenhum novo
- Recomendação (NÃO implementada): Nada a fazer no módulo do pacote — a pendência é a cadeia fiscal real (dependência externa já mapeada). Registrado para não confundir 'pacote quase vazio' com defeito.

**GAP-V35 [P1] Ciclo de validade inexistente em todas as camadas — num grupo que vende produto pesável** *(#06 Validade/Relatórios)*
- Impacto: Perda por vencimento invisível ao gestor, mercadoria vencida vendável no PDV sem qualquer trava, e exposição sanitária/PROCON. O agravante é interno: core_products tem weighable, plu_code e tare_grams — o sistema foi desenhado para varejo com balança (alimentos), exatamente o segmento onde validade é obrigação operacional.
- Evidência: PRAGMA readOnly no banco operacional: 0 colunas de validade/lote em core_products (48 colunas), core_stock (5) e core_stock_movements (21); nenhuma tabela de lote em sqlite_master; greps em schema.ts, core-migrations.ts, NfeImportService.ts e formulários de produto: só falsos cognatos.
- Referência Velo: Registro de validade por item na entrada, marcação conferido/não conferido, alerta de vencimento e relatório de validade.
- Devora parcial: Rastreio por UNIDADE serializada existe e funciona (core_product_units, schema.ts:1065-1137, chassi/IMEI) — o padrão de tabela-filha por produto com estado próprio está pronto para virar lote. Conferência por item madura em recebimento/inventário/importação.
- Dependência: Nenhuma externa — é modelagem e tela internas.
- Recomendação (NÃO implementada): Começar pelo razão, não pelo cadastro: lote/validade como dimensão de core_stock_movements na entrada (XML_RECEIPT), como já foi feito com location_id — saldo por lote sai da soma, sem segundo cache. Alerta reutilizando o padrão da régua única do estoque mínimo (SQL+TS lado a lado). Tela de conferência copia o molde conferido/não conferido do recebimento.

**GAP-V36 [P2] Rotas /bi/* decorativas sobreviveram à limpeza que o próprio time fez** *(#06 Validade/Relatórios)*
- Impacto: 11 dashboards de domínio (/bi/commercial, /bi/financial, /bi/inventory…) devolvem KPI zero hardcoded, /bi/rankings e /bi/comparisons devolvem zeros, e POST /bi/reports fabrica 'relatório' status ready com payload vazio — tudo alcançável por quem tem permissão corporate-bi.*. Integração ou tela futura consumirá zero como fato.
- Evidência: CorporateBIService.ts:23-34 (kpis value:0), :44-56 (payload:{}, status:'ready'), :66-78 (zeros); routes/v1/bi.ts:43-53 e :71-87. O comentário em bi.ts:27-37 condena exatamente isso — 'número decorativo em painel executivo é mentira executiva' — e removeu /bi/dashboard; estes ficaram no ar.
- Referência Velo: n/a — achado interno de higiene, não comparação.
- Devora parcial: Os números reais existem e são testados em /core/insights/* (audit-reports.test.ts verde).
- Dependência: Nenhuma.
- Recomendação (NÃO implementada): Mesmo tratamento dado ao /bi/dashboard: tirar do ar (404 com envelope da casa) ou ligar aos números reais de /core/insights/*. O POST /bi/reports é o mais urgente por FINGIR gerar relatório.

**GAP-V37 [P2] Nenhum relatório sai da tela — exportação restrita ao zip mensal do contador** *(#06 Validade/Relatórios)*
- Impacto: Gestor que precisa do DRE de um trimestre, do razão de estoque ou da trilha de auditoria em planilha copia número à mão; auditoria externa ou contador que peça recorte fora do pacote mensal não tem caminho. As telas são corretas (provadas contra o banco) mas terminam nelas mesmas.
- Evidência: Único gerador de CSV do repositório: FiscalClosingService.ts:593-926 (dre.csv/inutilizadas.csv/MANIFESTO.csv dentro do zip). Greps exportar/baixar/download/csv em BiPage, DrePage, AuditoriaPage, Posição de estoque e Movimentações: zero. BalancaPage exporta arquivo de equipamento, não relatório.
- Referência Velo: Exportação avulsa de relatório parametrizado (o vídeo demonstra a central com saída por relatório).
- Devora parcial: dre.csv mensal com teste verde que confere conteúdo contra o banco; download autenticado por Blob resolvido e documentado.
- Dependência: Nenhuma.
- Recomendação (NÃO implementada): Botão 'Exportar CSV' por tela de relatório reutilizando campoCsv/linhaCsv/montarCsv do FiscalClosingService e o caminho apiBinary+Content-Disposition já provado no pacote do contador — a infraestrutura inteira já existe e está testada.

**GAP-V38 [P1] Certificado real da Preço Justo está no cofre SEM senha selada** *(#07 Certificado A1)*
- Impacto: A primeira emissão real vai morrer em FISCAL_CERTIFICATE_PASSWORD_REQUIRED ('reenvie o arquivo') — o pipeline novo só emite sem pedir senha quando ela está selada, e a única linha real do banco (Preço Justo, vence 2026-10-15) tem encryptedPfx mas NÃO tem encryptedPassword (carregada antes da rodada do cofre).
- Evidência: Consulta readOnly em server/data/grupo-sampaio.db: fiscal_certificate_references com temSenhaCifrada=false; a recusa e a recuperação (reenvio → mesmo número) estão provadas verdes em a-emissao-abre-o-cofre.test.ts
- Referência Velo: n/a — gap operacional, não de capacidade
- Devora parcial: Fluxo de selagem implementado e provado; falta só o ato do dono
- Dependência: Dono do sistema (possui a senha do A1)
- Risco: Baixo — a recusa é clara e não queima numeração
- Recomendação (NÃO implementada): O dono reenvia o .pfx da Preço Justo com a senha em Fiscal › Certificado (a tela já diz isso na recusa). Nada a codificar.

**GAP-V39 [P2] Conferência do CNPJ do .pfx é opcional e manual — e o branch não tem teste** *(#07 Certificado A1)*
- Impacto: Se o gestor deixar o campo 'CNPJ esperado' vazio, um certificado de OUTRA empresa sobe sem aviso; o erro só apareceria na rejeição da SEFAZ, com a venda feita. O CNPJ do emitente já existe em core_fiscal_configs.cnpj e não é usado como conferência automática.
- Evidência: FiscalCertificateService.ts:137-139 (só compara se input.expectedCnpj vier); grep em server/tests por CNPJ_MISMATCH/expectedCnpj: zero ocorrências
- Referência Velo: vídeo sugere conferência de CNPJ no cadastro do certificado
- Devora parcial: Validação existe, opt-in
- Recomendação (NÃO implementada): Usar core_fiscal_configs.cnpj como conferência automática no upsert (quando configurado), mantendo expectedCnpj como override explícito; cobrir FISCAL_CERTIFICATE_CNPJ_MISMATCH com teste

**GAP-V40 [P2] Aviso de vencimento não é proativo** *(#07 Certificado A1)*
- Impacto: O aviso de 30 dias só aparece a quem abre a tela do certificado da operação; o checklist fiscal marca PASS sem detalhe quando 'próximo do vencimento', não há banner em dashboard/PDV, e-mail ou job. Com 6 empresas, ninguém é avisado se ninguém visitar 6 telas — e 'a emissão para no dia do vencimento' (mensagem do próprio sistema).
- Evidência: CertificateStatusService.ts (EXPIRY_WARNING_DAYS=30); FiscalConfigService.ts:268-273 (certificate_validity PASS com detail null quando não vencido); grep proximo_do_vencimento em src/: só CertificadoPage.tsx
- Referência Velo: checkpoint do vídeo pede alerta de vencimento
- Devora parcial: Cálculo e mensagens prontos no servidor; falta a superfície proativa
- Recomendação (NÃO implementada): Expor a janela de aviso no checklist (WARN com a mensagem já pronta) e/ou num banner do dashboard de gestão; o cert real entra na janela em ~2026-09-15

**GAP-V41 [P2] Sem visão consolidada dos certificados das 6 empresas** *(#07 Certificado A1)*
- Impacto: Conferir situação/vencimento dos A1 do grupo exige trocar de operação 6 vezes; nenhuma tela lista os certificados lado a lado.
- Evidência: GET /core/fiscal/certificate devolve só a empresa do token; CertificadoPage renderiza uma view única
- Referência Velo: vídeo mostra lista de certificados
- Devora parcial: Toda a informação já existe sanitizada por empresa
- Recomendação (NÃO implementada): Uma tela/rota de gestão do grupo (perfil dono) listando empresa × situação × validade × senha selada (booleano já sanitizado: senhaGuardada)

**GAP-V42 [P3] production_unlocked não tem escritor — produção só liga por UPDATE manual** *(#07 Certificado A1)*
- Impacto: A mensagem de erro promete liberação após 'configuração completa, certificado válido e autorização real na homologação', mas nenhum código/rota seta production_unlocked=1 (as colunas production_unlocked_at/by existem e nunca são escritas). Quando a homologação real acontecer, o go-live de produção exigirá mexer no banco na mão.
- Evidência: grep production_unlocked no repo (fora dist): só schema.ts:3094-3096 e leitura em FiscalConfigService.ts:87,134
- Referência Velo: n/a
- Devora parcial: Portão existe e é testado; falta a chave
- Dependência: Homologação real na SEFAZ (dono: senha A1, CSC)
- Risco: Deliberadamente conservador — errar para o lado seguro
- Recomendação (NÃO implementada): Criar o ato administrativo auditado de desbloqueio (condicionado a readiness HOMOLOGATED), preenchendo at/by

**GAP-V43 [P3] Emissão real na SEFAZ ainda não exercitada (dependência externa)** *(#07 Certificado A1)*
- Impacto: Zero documentos fiscais no banco operacional; readiness HOMOLOGATED inalcançável até uma autorização real com protocolo. Não é defeito de código: o caminho real (cofre → assinatura → SefazRealAdapter com TLS mútuo e cadeia) está provado por teste sem rede.
- Evidência: Consulta readOnly: core_fiscal_documents vazio, 0 AUTHORIZED com protocolo; environment=homologation, production_unlocked=0
- Referência Velo: Velo emite notas reais no vídeo
- Devora parcial: Simulador cobre todos os desfechos em dev; adapter real pronto
- Dependência: Dono (senha A1, CSC, ato de homologação) — classificação G
- Recomendação (NÃO implementada): Sequência do dono: reenviar .pfx com senha → botão 'Testar comunicação com a SEFAZ' (já na tela) → emitir em homologação → desbloquear produção

**GAP-V44 [P2] Vendas por MARCA não existem em nenhum relatório** *(#08 Dashboard/Acessos)*
- Impacto: O gerente não enxerga desempenho por marca no período — para responder 'qual marca vende mais' precisa exportar vendas e somar fora do sistema.
- Evidência: GET /core/dashboard devolve byDay/topProducts/bySeller/lowStock (core.ts:3659-3668); GroupInsights.ts sem marca; grep por byBrand/por marca no server retorna zero; core_brands tem 0 linhas no banco operacional.
- Referência Velo: O vídeo do Velo mostra o recorte de vendas por marca no dashboard.
- Devora parcial: O ingrediente existe: core_products.brand (texto livre no produto), cadastro de marcas com merge (/core/taxonomy/brands + CategoriasMarcasPage). Os insights agregam por produto, por operação e por margem — nunca por marca.
- Risco: Baixo — agregação de leitura, sem efeito colateral.
- Recomendação (NÃO implementada): Acrescentar byBrand ao /core/dashboard (JOIN core_sale_items→core_products, GROUP BY brand, 'Sem marca' para vazio) com teste no molde de audit-dashboard (soma dos grupos = faturamento). Atenção: 0 de 19 produtos do banco real têm marca preenchida — o relatório nasce vazio até o catálogo ser marcado.

**GAP-V45 [P3] 11 dashboards de domínio do BI corporativo respondem stub decorativo** *(#08 Dashboard/Acessos)*
- Impacto: GET /api/v1/bi/{commercial,financial,inventory,supply-chain,crm,workshop,rentals,ecommerce,logistics,fiscal,loyalty} devolvem kpis com value:0 hardcoded, rankings e series vazios — número decorativo alcançável por qualquer gerente com permissão corporate-bi.*, a MESMA doença que a auditoria removeu do /bi/dashboard executivo.
- Evidência: server/src/services/corporate-bi/CorporateBIService.ts:23-34 (getDomainDashboardBackend retorna value:0 fixo) servido por server/src/routes/v1/bi.ts:43-53.
- Devora parcial: Nenhuma tela os chama (BiPage usa /core/insights/*, que responde número de verdade); o /bi/dashboard executivo já foi removido (audit-dashboard prova o 404).
- Recomendação (NÃO implementada): Aplicar a mesma política do /bi/dashboard: remover as 11 rotas stub (mentira removida > mentira melhorada) ou implementá-las lendo os números reais do core.

**GAP-V46 [P3] Painel é mono-empresa e a troca recarrega a página inteira** *(#08 Dashboard/Acessos)*
- Impacto: Comparar o painel de duas empresas custa 1 troca no select + reload completo por empresa (window.location.reload em AppShell.tsx:206). A visão lado a lado existe, mas em outra tela (BI) e só para gerência — o recorte diário por empresa no próprio painel não existe.
- Evidência: src/components/gs/AppShell.tsx:199-207; src/pages/gs/BiPage.tsx; auth.ts:709 (switch-company).
- Referência Velo: Filtro de empresa dentro do próprio dashboard, sem recarregar.
- Devora parcial: Select 'Operação ativa' na topbar (token novo só dentro do vínculo, assertMembership) + BiPage com as 6 operações lado a lado, total do grupo e mesmo período.
- Recomendação (NÃO implementada): Aceitar como decisão de UX (o reload garante que TODAS as telas releiam o escopo — comentário no código) ou acrescentar um seletor de empresa no painel usando o mesmo escopo por vínculo de GET /core/insights/operations.

**GAP-V47 [P1] Crédito de loja concedido na devolução não vira saldo consumível** *(#09 PDV Pagamentos/TEF)*
- Impacto: Devolução 'em crédito' cria um passivo sem rastro por cliente: não há saldo, extrato nem forma de abater em venda futura. A loja fica devendo de cabeça, e o DRE só consegue NOMEAR o valor como ressalva.
- Evidência: SaleReturnService.ts:490-492 ('vira saldo do cliente') vs IncomeStatementService.ts:287-288: 'o crédito ainda nem existe como saldo no sistema — a rodada 21 já apontou isso'. Nenhum meio de pagamento de resgate em PaymentMethods.ts.
- Referência Velo: Vale/crédito de cliente utilizável como forma de pagamento no PDV
- Devora parcial: Concessão e mensuração existem (devolucao.test.ts verde); consumo ausente
- Risco: Financeiro: passivo invisível cresce com cada devolução em crédito
- Recomendação (NÃO implementada): Criar ledger de crédito por cliente (concessão na devolução, consumo na venda como meio próprio não-cash, saldo na ficha do cliente) — o gancho comportamental já existe no padrão do catálogo de métodos.

**GAP-V48 [P2] POST /core/sales não amarra pagamento em cartão à transação de terminal aprovada** *(#09 PDV Pagamentos/TEF)*
- Impacto: A garantia 'venda só fecha após confirmação da operadora' mora na tela: pela API, uma linha 'credito settled' entra sem transação aprovada mesmo com maquininha configurada. Também não há vínculo transação↔venda para fechar o ciclo depois de uma reconciliação aprovada.
- Evidência: SalesService.ts:876-885 valida método e valor, nada de origem; core_sale_payments tem provider/provider_ref sem escritor no fluxo PDV; createAndProcessPaymentTerminalTransactionBackend não recebe saleId.
- Risco: Integridade: brecha só explorável por cliente de API, não pela tela
- Recomendação (NÃO implementada): Com terminal configurado, exigir provider_ref de transação 'authorized' nas linhas debito/credito no fechamento; gravar sale_id na transação ao finalizar.

**GAP-V49 [P2] PIX integrado na maquininha é backend sem tela** *(#09 PDV Pagamentos/TEF)*
- Impacto: O fluxo assíncrono do PIX no aparelho (QR, polling, confirmação) está pronto e testado no servidor, mas o PagamentoDialog só roteia cartão pelo terminal — o dia em que a maquininha real chegar, o PIX integrado não funcionará sem frontend novo.
- Evidência: PagamentoDialog.tsx:401 (isCard = debito||credito); TerminalPayment do frontend sem qrPayload (src/lib/api/core.ts:1481-1495); pdv-pix-maquininha.test.ts verde só no serviço.
- Devora parcial: 12 testes verdes do fluxo no serviço; zero consumo na tela
- Recomendação (NÃO implementada): Rotear PIX pelo terminal quando configurado, exibir qrPayload e fazer polling de consultarPagamentoTerminal até settled.

**GAP-V50 [P1] TEF real inexistente — adapters estruturais aguardando SDK, credencial e hardware** *(#09 PDV Pagamentos/TEF)*
- Impacto: Nenhuma cobrança real passa pela maquininha em produção: os 7 providers reais devolvem 'HOMOLOGAÇÃO REAL PENDENTE' e o mock é bloqueado por env em produção/staging. Cartão hoje é lançado manualmente (declarado na tela).
- Evidência: PaymentTerminalProviderAdapter.ts:153-160; PaymentTerminalCredentialService.ts:25-35 (PAYMENT_TERMINAL_MOCK_IN_PRODUCTION); readiness sempre READY_FOR_HARDWARE (PdvTerminalService.ts:113).
- Dependência: Hardware SmartPOS/PinPad + credenciais da adquirente + homologação presencial
- Recomendação (NÃO implementada): Manter G no radar do dono: contratar adquirente, obter credenciais/SDK e rodar a homologação física — o checklist de 22 passos já existe (HOMOLOGATION_CHECKLIST_KEYS).

**GAP-V51 [P3] Idempotência de transação de terminal sem escopo por empresa** *(#09 PDV Pagamentos/TEF)*
- Impacto: O lookup de idempotencyKey em createAndProcessPaymentTerminalTransactionBackend é global: colisão de chave entre empresas devolveria a transação de outra empresa em vez de criar a própria.
- Evidência: PaymentTerminalService.ts:117 — findOneRow por idempotencyKey sem filtrar companyId (o PDV usa uuid, risco prático baixo).
- Risco: Tenant: teórico com uuid, real se um integrador usar chaves previsíveis
- Recomendação (NÃO implementada): Incluir companyId no predicado do lookup de idempotência.

**GAP-V52 [P1] Item cancelado no carrinho não deixa rastro — rodapé 'Itens cancelados' é um '0' fixo** *(#10 PDV Avançado)*
- Impacto: Controle antifraude do balcão ausente: o operador pode bipar, mostrar o total ao cliente, remover a linha e fechar por menos, sem contador na tela nem registro em auditoria. O rodapé imita o layout do Velo com um literal hardcoded, o que é pior que não ter — o gestor acha que o número existe.
- Evidência: src/pages/gs/PdvPage.tsx:2246 — ['Itens cancelados:', '0'] literal; botão ✕ (linhas 2226-2233) só faz setLines(filter); nenhum estado conta remoções; nenhum recordAudit de linha removida.
- Referência Velo: Exibe 'Itens cancelados' no rodapé do PDV e mantém o item cancelado visível/contado.
- Devora parcial: Remoção funciona e o fluxo com item removido roda verde (audit-pdv); só falta o rastreio.
- Risco: baixo — mudança contida na tela + um campo no detail de auditoria
- Recomendação (NÃO implementada): Contador de linhas removidas por venda (estado zerado no clearSale), exibido no rodapé; enviar a contagem (e opcionalmente os itens) no detail do sale.create para a auditoria que já existe.

**GAP-V53 [P2] Sem busca nem cadastro rápido de cliente dentro do PDV** *(#10 PDV Avançado)*
- Impacto: F2 despeja a lista completa de clientes num scroll de 160px sem filtro; com centenas de cadastros a escolha vira rolagem com fila no balcão. Cadastrar exige sair para a tela Clientes e perder o carrinho de vista.
- Evidência: src/pages/gs/PdvPage.tsx:1965-2023 — lista sem input de busca; grep na tela: só coreApi.listCustomers, nenhuma criação de cliente.
- Referência Velo: Pesquisa e cadastra o cliente sem sair da venda.
- Devora parcial: Escolher cliente reprecifica o carrinho pela tabela dele (mecânica superior à média), e o cadastro completo existe em Clientes.
- Risco: baixo
- Recomendação (NÃO implementada): Campo de filtro na lista F2 (client-side já resolve) e um formulário mínimo (nome/CPF/telefone) que chame o POST /core/customers existente sem fechar a venda.

**GAP-V54 [P2] Desconto digitável não existe no PDV — nem rodapé, nem por item** *(#10 PDV Avançado)*
- Impacto: O caixa que precisa dar R$ 5,00 de desconto redondo tem que recalcular e digitar o preço unitário rebaixado item a item; o desconto de rodapé só entra se a venda veio de pré-venda. O backend inteiro (discountCents de cabeçalho e de linha, alçada, auditoria) já está pronto e testado, sem emissor na tela.
- Evidência: PdvPage.tsx:1339-1345 ('não há onde digitá-lo'); pdvConcessao.ts:102-107 ('o PDV não tem campo de desconto por item'); core.ts:3021-3062 alçada honesta no servidor.
- Referência Velo: Desconto por item e no total, digitado no PDV.
- Devora parcial: Rebaixar preço unitário funciona e passa pela alçada; pré-venda carrega desconto.
- Risco: baixo — o caminho servidor↔alçada já cobre o valor
- Recomendação (NÃO implementada): Campo de desconto no rodapé do carrinho (R$ ou %) ligado ao discount state que já viaja no POST /sales; a prévia de concessão e a alçada já o medem hoje.

**GAP-V55 [P3] Sem comando de gaveta e sem impressão térmica silenciosa** *(#10 PDV Avançado)*
- Impacto: Cada cupom passa pelo diálogo de impressão do navegador (2+ interações, popup que pode ser bloqueado) e a gaveta física não abre por comando — no volume do balcão isso é o maior atrito por venda em relação ao Velo.
- Evidência: src/lib/print.ts (declara a limitação: 'O navegador NÃO imprime em silêncio'); grep drawer/escpos/kick sem resultados de comando.
- Referência Velo: Impressão direta na térmica e atalho de gaveta.
- Devora parcial: Fila de jobs com estados honestos, reimpressão e auditoria centavo a centavo já prontas (audit-impressao verde).
- Dependência: software local na máquina do caixa + impressora térmica
- Risco: médio — componente novo fora do navegador
- Recomendação (NÃO implementada): Agente local de impressão (serviço que consome a fila /core/print/jobs — a fila com estados já existe e está testada) com ESC/POS + pulso de gaveta.

**GAP-V56 [P3] Quantidade não editável na linha do carrinho** *(#10 PDV Avançado)*
- Impacto: Corrigir '2' para '3' depois do bipe exige rebipar (soma) ou remover e recomeçar; errar para MENOS exige remover a linha inteira e rebipar com a quantidade certa.
- Evidência: PdvPage.tsx:2118-2235 — linha do carrinho só tem o ✕; quantidade só no campo de entrada (1877-1891).
- Referência Velo: Altera quantidade na linha.
- Risco: baixo (atenção a serializado: quantidade é o nº de unidades escolhidas)
- Recomendação (NÃO implementada): Input de quantidade na própria linha (para produto não serializado), reaproveitando a validação de saldo que já avisa em linhasSemSaldo.

**GAP-V57 [P3] 'Pesq. avançada (F4)' é rótulo sem pesquisa avançada** *(#10 PDV Avançado)*
- Impacto: O operador que clica esperando filtros (categoria, marca, faixa de preço) recebe a mesma busca textual — promessa de tela que não existe, o mesmo padrão de defeito que o projeto já combate nos atalhos.
- Evidência: PdvPage.tsx:1808-1816 — onClick={() => void runSearch()}.
- Referência Velo: F4 abre pesquisa avançada com filtros.
- Risco: trivial na opção de renome
- Recomendação (NÃO implementada): Renomear para 'Pesquisar (F4)' (correção de 1 linha) ou implementar o modal de filtros sobre GET /core/products/search.

**GAP-V58 [P3] Observação da venda via window.prompt** *(#10 PDV Avançado)*
- Impacto: Prompt nativo do navegador: uma linha só, sem estilo, bloqueia a aba, e alguns kiosks/navegadores o desabilitam — a observação some sem erro.
- Evidência: PdvPage.tsx:986-990 — window.prompt('Observação da venda:', note).
- Risco: trivial
- Recomendação (NÃO implementada): Trocar por um mini-modal próprio (o projeto já tem o shell Modal no PagamentoDialog) mantendo Alt+O.

**GAP-V59 [P3] Venda em espera não cruza terminais** *(#10 PDV Avançado)*
- Impacto: F7 guarda no localStorage do terminal: o carrinho suspenso no caixa 1 não reaparece no caixa 2, e formatar a máquina perde as esperas do turno. Em loja com um caixa por empresa (cenário atual do grupo) o impacto é pequeno.
- Evidência: src/pages/gs/pdvEmEspera.ts — decisão documentada (localStorage, escopo por sessão de caixa/empresa).
- Devora parcial: Escopo por empresa correto (vazamento entre as 6 já consertado e testado); pré-venda cobre suspensão duradoura.
- Risco: baixo hoje
- Recomendação (NÃO implementada): Manter como está para o cenário atual; se o grupo puser 2+ caixas por loja, promover a espera a documento leve no servidor (sem reserva de estoque) — a pré-venda (F9) já cobre o caso com reserva.

**GAP-V60 [P2] Cancelamento de venda e devolução sem liberação pontual — exigem gerente logado na própria sessão** *(#11 Autorização Pontual)*
- Impacto: No balcão, o conceito do vídeo (operador pede, gestor digita a senha ali mesmo, os dois auditados) não cobre cancelar venda nem devolver: o operador de caixa não tem caminho — um gerente precisa assumir o terminal ou a ação espera. Nas 6 empresas com caixa único isso vira deslocamento ou troca de usuário.
- Evidência: core.ts:3321 (requireProfile 'gerente_loja', sem authorizationId no corpo); core.ts:9289 (sale-returns idem); AuthorizationService.ts:43-47 documenta a remoção de 'cancelar_venda' de RESTRICTED_ACTIONS.
- Referência Velo: Autorização gerencial pontual para cancelamentos e estornos no próprio PDV, sem o operador sair da sessão.
- Devora parcial: As ações existem, são auditadas e estornam estoque/comissão/fidelidade (cancelarVenda.test.tsx 12 VERDES); a mecânica de liberação pontual existe e está madura para desconto e sangria — só não alcança essas duas ações.
- Risco: Baixo — a mecânica de consumo já é transacional e testada.
- Recomendação (NÃO implementada): Incluir 'cancelar_venda' e 'devolucao' em RESTRICTED_ACTIONS consumidas pela mesma mecânica (consumirLiberacaoDeConcessao com refType próprio), mantendo a regra de não-autoautorização: o operador pede, um SEGUNDO usuário com alçada libera — o racional documentado ('o gerente teria de chamar outro gerente') só vale quando quem pede JÁ é gerente, e o guarda existente (manager.id !== requestedBy) resolve exatamente isso.

**GAP-V61 [P3] IP aceito e descartado; terminal ausente na liberação** *(#11 Autorização Pontual)*
- Impacto: A liberação registra quem pediu e quem liberou, mas não DE ONDE: numa disputa ('eu não digitei essa senha'), não há IP nem terminal para cruzar. O parâmetro ip já chega ao serviço e morre ali.
- Evidência: AuthorizationService.ts:123 declara input.ip; o INSERT (linhas 180-197) não o grava; recordAudit da rota (core.ts:3139-3151) não passa ip apesar de core_audit_log ter a coluna.
- Referência Velo: Registro de terminal na autorização (implícito no conceito de PDV por estação).
- Devora parcial: company_id sempre gravado; PdvTerminalService existe no servidor mas não é ligado à liberação.
- Recomendação (NÃO implementada): Gravar input.ip em core_authorizations (coluna nova) e passar ip ao recordAudit da rota; avaliar carimbar o terminal do PDV quando houver.

**GAP-V62 [P3] GET /core/authorizations é rota órfã — a 'tela de autorizações' citada nos comentários não existe** *(#11 Autorização Pontual)*
- Impacto: O gestor não tem visão consolidada das liberações (concedidas x consumidas x expiradas-sem-uso); a leitura hoje é garimpo na AuditoriaPage. O reason foi desenhado 'para a pessoa ler na tela de autorizações' — que ninguém construiu.
- Evidência: coreApi (src/lib/api/core.ts) só tem o POST; grep por consumo do GET no frontend: zero. Comentários em PdvPage.tsx:1369 e core.ts referenciam a tela.
- Referência Velo: n-conferido (relatório de autorizações não visto em detalhe).
- Devora parcial: Backend pronto (listAuthorizations com nome do gestor via JOIN); AuditoriaPage mostra as entradas authorization.*.
- Recomendação (NÃO implementada): Construir a listagem (rota já filtra por empresa e exige perfil de gerente) ou remover a rota morta — o guarda menu×servidor da casa existe justamente contra promessa não cumprida.

**GAP-V63 [P3] Itens removidos do carrinho não deixam trilha (prevenção de perda)** *(#11 Autorização Pontual)*
- Impacto: Remover linha antes de finalizar é invisível ao servidor. Para varejo com PDV assistido isso é aceitável; para o padrão anti-fraude de PDV (item cancelado registrado), falta a trilha.
- Evidência: PdvPage mantém o carrinho client-side; nenhuma rota recebe remoções; a venda só nasce no Finalizar (SalesService.createSale).
- Referência Velo: PDVs do segmento registram cancelamento de item na venda aberta.
- Devora parcial: A trava de concessão + recusa por percentual (CORE_AUTHORIZATION_ABOVE_PERCENT) fecha o abuso de PREÇO decorrente de mexer no carrinho pós-liberação.
- Dependência: decisão de produto
- Recomendação (NÃO implementada): Só atacar se o dono sentir o problema — exigiria venda aberta server-side, que é mudança de arquitetura do PDV.

**GAP-V64 [P3] Reabertura de caixa não existe** *(#11 Autorização Pontual)*
- Impacto: Fechamento com contagem errada não tem desfazer; a correção é operacional (ajuste em sessão nova).
- Evidência: AuthorizationService.ts:54-58 documenta a decisão; nenhuma rota/função/botão de reopen.
- Referência Velo: n-conferido (reabertura com senha de gestor é comum no segmento).
- Devora parcial: closeSession grava esperado/contado/diferença como fato auditável.
- Dependência: decisão de produto
- Recomendação (NÃO implementada): Rodada própria, como o próprio código pede: decidir o destino da conferência gravada antes de qualquer tranca.

**GAP-V65 [P1] Consignado/condicional inexistente de ponta a ponta** *(#12 Pré-venda/Orçamento/Consignado)*
- Impacto: Loja de roupas (Gringa, Me Mimei) e autopeças (PJ Motors) usam condicional no dia a dia: mercadoria sai da loja sem venda, volta em parte, fatura em parte. Hoje o operador improvisaria com pré-venda (que não registra saída física nem retorno parcial) ou fora do sistema — estoque mente nos dois casos.
- Evidência: grep -i consign/consigna em server/src, src/, docs/ e cp37-spec-full.txt: zero ocorrências; 'condicional' só como adjetivo em comentários.
- Referência Velo: Vídeo #12 demonstra ciclo de consignado
- Devora parcial: Pré-venda reserva estoque e converte em venda, mas não tira a peça da loja nem aceita retorno/venda parcial
- Dependência: nenhuma
- Risco: Estoque físico divergente do sistema em três das seis empresas
- Recomendação (NÃO implementada): Modelar ciclo próprio: documento de consignação com saída de estoque para local/custódia 'em consignação' (o InventoryService já tem movimentações tipadas e locais), retorno parcial, conversão parcial em venda reutilizando createSale, fechamento com financeiro — nos moldes do que a pré-venda já faz com reserva.

**GAP-V66 [P2] Documento aberto não pode ser editado nem ter a validade renovada** *(#12 Pré-venda/Orçamento/Consignado)*
- Impacto: Erro de digitação ou cliente que muda um item = cancelar e redigitar o documento inteiro, perdendo número, histórico e a liberação de gestor já consumida. Documento vencido: as mensagens do servidor e da tela mandam 'renovar a validade', mas não existe rota nem botão — beco anunciado.
- Evidência: Sem PUT/PATCH em /quotes (grep core.ts); QuoteService sem updateQuote; OrcamentosPage.tsx:949 exibe 'Renove a validade antes de aprovar' sem oferecer a ação (QuoteService.ts:723,1061 idem).
- Referência Velo: Edição de orçamento salvo antes da conversão
- Devora parcial: Cancelar + recriar funciona e devolve reserva corretamente
- Dependência: nenhuma
- Risco: Operador contorna cancelando e redigitando com pressa — erro de transcrição
- Recomendação (NÃO implementada): Curto prazo: rota POST /quotes/:id/renew (só validade, com auditoria) mata o beco com pouco risco — não mexe em preço nem reserva. Médio: edição de documento aberto re-passando pela mesma alçada de createQuote.

**GAP-V67 [P2] Vendedor não entra no documento pela tela — comissão da conversão vai para quem converte** *(#12 Pré-venda/Orçamento/Consignado)*
- Impacto: O vendedor que montou o orçamento não é registrado; quando a pré-venda é faturada no caixa, createSale usa o fallback (userId de quem converte) e a comissão nasce para o CAIXA, não para quem vendeu. Em loja com comissionamento ativo isso é dinheiro trocando de bolso silenciosamente.
- Evidência: NovoDocumentoDialog sem campo vendedor; client createQuote sem sellerId no tipo (src/lib/api/core.ts:3663-3670); rota aceita sellerId (core.ts:2840); convertQuote propaga quote.seller_id (QuoteService.ts:808); SalesService.ts:1461 'input.sellerId ?? input.userId'.
- Referência Velo: Pré-venda com vendedor identificado atravessando a conversão
- Devora parcial: Backend completo: coluna, rota, propagação e comissão na mesma transação — falta só o elo TELA→API
- Dependência: nenhuma
- Risco: baixo — mudança aditiva
- Recomendação (NÃO implementada): Adicionar seletor de vendedor no NovoDocumentoDialog (o PDV já tem um) e sellerId no client createQuote — o backend inteiro já está pronto; 1 tela + 1 tipo.

**GAP-V68 [P3] Conversão direta orçamento→venda sem tela** *(#12 Pré-venda/Orçamento/Consignado)*
- Impacto: Cliente que fecha na hora obriga dois passos (Aprovar→pré-venda, depois PDV F9) ou redigitar no PDV. A rota POST /quotes/:id/convert aceita orçamento e é testada, mas o PDV F9 lista só pre_venda e a OrcamentosPage não oferece 'faturar'.
- Evidência: PdvPage.tsx:1212 listQuotes({kind:'pre_venda'}); OrcamentosPage sem ação de conversão; teste 'orçamento vira venda com baixa e receita' VERDE só via serviço/rota.
- Referência Velo: Orçamento faturado direto do balcão
- Devora parcial: O caminho em dois passos funciona e é auditado
- Dependência: nenhuma
- Risco: nenhum novo — rota já existe e é testada
- Recomendação (NÃO implementada): Incluir orçamentos abertos na lista do F9 (ou aba própria) — a conversão já solta nada (orçamento não reserva) e herda a mesma idempotência.

**GAP-V69 [P3] Desconto do documento digitado em centavos crus** *(#12 Pré-venda/Orçamento/Consignado)*
- Impacto: O campo 'Desconto (centavos)' do NovoDocumentoDialog pede o número em centavos e filtra não-dígitos: R$ 10,00 digitado como '10,00' vira 1000 certo por acaso, mas '10' vira R$ 0,10 — fonte de desconto errado silencioso, num campo que alimenta a alçada.
- Evidência: OrcamentosPage.tsx:844-849 (label 'Desconto (centavos)', replace(/\D/g,'')); o PDV usa entrada em reais com máscara.
- Referência Velo: n-comparado
- Devora parcial: Servidor valida número finito e a alçada mede o resultado — o erro é de digitação, não de conta
- Dependência: nenhuma
- Risco: desconto involuntário dentro do limite passa sem gestor
- Recomendação (NÃO implementada): Trocar por entrada em reais com a mesma máscara do PDV.

**GAP-V70 [P1] Cobrança avulsa a partir do contas a receber manual não existe — a cobrança só nasce do pedido online** *(#13 Asaas/Contas a Receber)*
- Impacto: O fluxo central do vídeo do Velo (lançar um título no financeiro e cobrar o cliente por PIX/boleto/link) é impossível no Devora: ContasPage cria o título mas não há botão nem rota para gerar a cobrança. Cobrar aluguel, OS da oficina ou venda a prazo pelo Asaas exige gambiarra fora do sistema.
- Evidência: FinanceService.ts sem nenhuma menção a Asaas; createPaymentIntent (PaymentService.ts:194, aceita origin 'sale'/'service_order') sem NENHUM chamador; único criador vivo é createOrderCharge no checkout (storefront.ts:560).
- Referência Velo: Gera cobrança direto do título do contas a receber
- Devora parcial: Título manual existe (frontend+backend); toda a infraestrutura de cobrança/webhook/baixa existe para pedido online
- Recomendação (NÃO implementada): Botão 'Cobrar via Asaas' na conta a receber (ContasPage) chamando um novo fluxo sobre createPaymentIntent + resolveAsaasCustomer, com origin_type='finance_entry' e baixa do título pelo webhook (o rank e a idempotência já existem).

**GAP-V71 [P1] BLOCKED_CREDENTIAL_ROTATION: nenhuma credencial válida — integração inteira inativa ao vivo** *(#13 Asaas/Contas a Receber)*
- Impacto: Nada cobra de verdade: banco real mostra 5 intenções todas 'unconfigured', 0 webhooks recebidos, 0 vínculos de cliente. A loja degrada com honestidade ('pagamento online indisponível'), mas o recebimento online está parado nas 6 empresas.
- Evidência: docs/ESTADO-ATUAL.md:390 (BLOCKED_CREDENTIAL_ROTATION — chaves ficaram em cópias do banco seladas pela chave publicada); consultas read-only em server/data/grupo-sampaio.db.
- Dependência: Portal Asaas (dono) — rotação de credenciais
- Risco: Enquanto isso, qualquer checkpoint G desta lista é código provado por teste, não operação viva
- Recomendação (NÃO implementada): Ação do dono, não de código: reemitir chave sandbox, chave produção e token do webhook no portal Asaas, colar na tela de integração (que já grava no cofre por empresa), testar conexão e rodar a homologação pela própria tela.

**GAP-V72 [P2] Cancelamento pelo ERP e expiração automática não cancelam a cobrança no provedor (2 dos 3 caminhos)** *(#13 Asaas/Contas a Receber)*
- Impacto: Pedido cancelado pelo gerente (POST /core/orders/:id/cancel) ou pela rotina de expiração deixa o PIX/boleto vivo no Asaas: o cliente ainda pode pagar um pedido que não existe mais. O dinheiro não some (vira paid_after_cancel e aparece na conciliação), mas gera regularização manual evitável.
- Evidência: cancelOrderCharges só é chamado em storefront.ts:878 (portal). core.ts:8087 usa cancelStoreOrder=cancelOrder (StorefrontService.ts:1647) e OrderReservationExpiry.ts:58 usa cancelOrder — nenhum dos dois toca o provedor.
- Devora parcial: Caminho do portal cancela no provedor ANTES do pedido (testado verde); paid_after_cancel + conciliação seguram a ponta solta
- Recomendação (NÃO implementada): Chamar cancelOrderCharges nos 3 caminhos (ou movê-lo para dentro de cancelOrder, tornando-o async). O serviço já é tolerante a falha do provedor por construção.

**GAP-V73 [P2] Parcelamento de cobrança no provedor não implementado** *(#13 Asaas/Contas a Receber)*
- Impacto: Não dá para oferecer 3x no boleto/cartão via Asaas — a cobrança sai sempre à vista no valor total. O crediário interno existe, mas sem espelho na cobrança online.
- Evidência: Zero ocorrências de installmentCount no repositório; OrderChargeService.ts:174-182 envia value único.
- Referência Velo: Cobrança parcelada
- Recomendação (NÃO implementada): Aceitar installmentCount no createPayment e refletir as parcelas em core_finance_entries (installment_number já existe e a conciliação já soma parcelas — D6).

**GAP-V74 [P3] Recorrência de cobrança (assinatura) inexistente** *(#13 Asaas/Contas a Receber)*
- Impacto: Mensalidade/plano recorrente não pode ser cobrado automaticamente; teria de ser lançado e cobrado mês a mês (e nem isso existe hoje — ver gap P1).
- Evidência: createSubscription/cancelSubscription em AsaasHttpClient.ts:161-167 sem nenhum chamador, serviço, rota ou tela.
- Referência Velo: Recorrência de cobrança
- Recomendação (NÃO implementada): Só atacar depois da cobrança avulsa: assinatura sem título manual é telhado sem parede.

**GAP-V75 [P3] Status e falhas das cobranças invisíveis na gestão** *(#13 Asaas/Contas a Receber)*
- Impacto: Cobrança 'failed' com last_error, attempts e overdue não aparecem em tela nenhuma — o gestor só descobre quando a divergência estoura na conciliação ou o comprador reclama.
- Evidência: getIntentsFor (PaymentService.ts:311) sem chamador; nenhuma página lista core_payment_intents.
- Devora parcial: Status do PEDIDO visível; conciliação mostra os desfechos com dinheiro
- Recomendação (NÃO implementada): Tela (ou seção no pedido) listando as intenções com status, last_error e ação de re-tentar; a rota é uma query pronta.

**GAP-V76 [P3] Retry de cobrança falhada depende de reenvio do checkout** *(#13 Asaas/Contas a Receber)*
- Impacto: Se o Asaas oscilou na criação da cobrança, não há job nem botão 'gerar de novo': só o reenvio idempotente do mesmo checkout re-tenta. Comprador que fechou a aba fica sem cobrança até o pedido expirar em 25h.
- Evidência: requestAsaasCharge grava failed e ninguém re-processa (PaymentService.ts:265-309); fila asaas_operational_attempts com retry só vive nas rotas legadas /v1.
- Recomendação (NÃO implementada): Rota de re-cobrança no portal do cliente ('pagar de novo') sobre createOrderCharge, que já é idempotente e já re-tenta intenção sem provider_ref.


## 11. NÃO APLICÁVEIS AO GRUPO SAMPAIO

- **Crediário próprio no PDV (H):** desligado por DECISÃO documentada do dono ("não vende a prazo") em `PaymentMethods.ts`, com recusa nomeada e testada. A referência Velo o demonstra; para o Grupo Sampaio é política comercial, não lacuna.
- **Débito em conta:** NÃO DETERMINÁVEL A PARTIR DA REFERÊNCIA VELO FORNECIDA em detalhe suficiente para comparação além da existência do rótulo; no Devora não existe e não há demanda registrada — tratado como fora de escopo até o dono pedir.

## 12. DEPENDÊNCIAS EXTERNAS (não são bugs)

1. **TEF:** SDK do provedor, PinPad, homologação da adquirente.
2. **Asaas:** reemissão das credenciais no portal (sandbox+produção+token webhook), por empresa.
3. **SMTP:** senha de aplicativo e configuração.
4. **Fiscal:** senha do A1 (reenvio do .pfx pelo dono), IE/CRT/IBGE, CSC/CSC ID, pCredSN e NCM/CFOP (contador), primeira homologação SEFAZ-RS.
5. **Transportadoras:** tokens Melhor Envio; contratos Correios/Jadlog (e implementação futura dos conectores reais).
6. **Certificado real hoje:** o `.pfx` da Preço Justo está no cofre **sem a senha selada** — um gesto do dono na tela resolve.

## 13. RECOMENDAÇÃO FINAL

**Resposta: SIM, COM GAPS NÃO BLOQUEANTES.**

O Devora está funcionalmente no nível necessário para substituir o Velo nas operações do Grupo Sampaio no que é o CORAÇÃO da operação diária — PDV, estoque, compras, financeiro, oficina, PJ Motors, contador — com 79,1% de paridade funcional, ZERO gaps P0, e superioridade comprovada exatamente onde erro custa dinheiro (integridade, rastreabilidade, tenant, honestidade de estados). Os 12 P1 são lacunas importantes mas contornáveis no dia 1 (nenhuma impede vender, estocar, pagar, receber ou fechar caixa), e 3 deles são dependência externa/dono, não código.

**Gaps mínimos a resolver antes do uso operacional** (não implementados nesta auditoria, conforme a regra):
1. Rastro de item cancelado no carrinho (GAP-V52) — prevenção de perda no balcão;
2. Movimentação manual de estoque com tela na loja (GAP-V09);
3. Crédito de devolução consumível — fechar o ciclo de troca (GAP-V10/47);
4. Cliente inline no PDV (GAP-V53) e desconto digitável (GAP-V54) — produtividade de balcão;
5. Título↔origem navegável (GAP-V22) — rastreabilidade bidirecional que a referência demonstra;
6. Pedido de compra com itens do catálogo (GAP-V16) — destrava a conciliação item a item pela UI;
7. Do lado do dono: senha do A1 (GAP-V38) e rotação Asaas (GAP-V71) — dois gestos, sem código.
Validade/lote (GAP-V35) e consignado (GAP-V65) são os dois P1 de FUNCIONALIDADE nova de verdade: decidir com a operação se entram antes do go-live ou na primeira onda pós-uso.

## 14. ROADMAP PROPOSTO — SOMENTE PROPOSTA (nada executado)

**Wave 0 — antes do uso (críticos de balcão e rastreabilidade):** GAP-V52 (rastro de cancelado), V09 (tela de movimentação), V10/47 (crédito de troca), V53/V54 (cliente inline + desconto no PDV), V22 (título↔origem), V16 (itens do catálogo no pedido). Estimativa: 1-2 rodadas.
**Wave 1 — operação plena:** validade/lote (V35) se a operação exigir no dia 1; consignado (V65) idem; parcelamento manual (V23); entrada sem XML com título (V17); aging (V24); elevação pontual para cancelamento (V60).
**Wave 2 — produtividade/controle:** cobrança avulsa Asaas (V70) + parcelamento (V73) + tela de status (V75); envio do pacote ao contador por e-mail + agendamento (V30/V31); exportação de relatórios (V37); valor de estoque (V11); inventário parcial (V12); alertas de vencimento do A1 (V40) e visão 6-empresas (V41).
**Wave 3 — evolução:** preço por quantidade (V04), dias promocionais (V03), campos personalizados (V07), recorrência Asaas (V74), vendas por marca (V44), limpeza dos stubs /bi (V36/45), CMV no DRE (V28).

## 15. ANEXO — EVIDÊNCIAS

**Saída estruturada completa dos 13 auditores** (215 checkpoints com persistência/observações integrais, 76 gaps com todos os campos): `C:\Users\User\AppData\Local\Temp\claude\...\tasks\w2gqscu1d.output` (e journal por agente no diretório de transcripts do workflow `wf_4e03b09c-bb2`). Estatísticas e fragmentos intermediários no scratchpad da sessão (`paridade-*.md/txt`).
**Testes executados verdes durante a auditoria (por arquivo):** ver §4 — ~40 arquivos de teste de fluxo, ~700 casos, todos em banco temporário.
**Principais artefatos citados na matriz:** rotas em `server/src/routes/v1/` (core.ts 358 rotas), serviços em `server/src/services/`, DDL em `server/src/db/schema.ts` (326 tabelas), telas em `src/pages/gs/`, guardas em `src/router/` e `server/src/middleware/auth.ts`, suítes em `server/tests/` e `src/**/__tests__/`.
**Banco operacional:** identificado em `server/data/grupo-sampaio.db`; acessado SOMENTE com `readOnly:true`; integridade `ok`, FK 0 no início e no fim; nenhum dado alterado.

---

*Relatório gerado pela auditoria de paridade de 31/08/2026. Nenhuma linha de código de produto foi alterada; a única escrita no repositório é este documento.*
