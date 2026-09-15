/**
 * API transacional do núcleo do ERP.
 *
 * Regra que vale para todo endpoint aqui: `companyId` vem SEMPRE de
 * `req.auth.companyId` (derivado do vínculo do usuário no banco) e nunca do
 * corpo ou da query. Não existe caminho em que o cliente escolha o tenant.
 */
import { Router } from 'express';
import { authMiddleware, type AuthedRequest } from '../../middleware/auth.js';
import { caixaNoEscopo, decidePelaCapability, passaPelaCapabilityDaRota } from '../../services/auth/PonteDaRota.js';
import { acessoDaRequisicao, can, requireAnyCapability, requireCapability } from '../../services/auth/Autorizacao.js';
import { ipDeOrigem } from '../../middleware/ipDeOrigem.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  createProduct,
  createCustomer,
  diferencasDoProduto,
  getCustomer,
  getProduct,
  listCustomers,
  productHistory,
  setCustomerPriceTable,
  countProductsMissingShippingData,
  countCustomers,
  countProducts,
  catalogoSemProdutoAtivo,
  lerSituacaoDoCadastro,
  listOnlineReadiness,
  listProducts,
  publishReadyProducts,
  searchProducts,
  updateCustomer,
  updateProduct,
  reservarCodigoInterno,
} from '../../services/core/CatalogService.js';
import { excluirProduto } from '../../services/core/ProductDeletionService.js';
import { lerPagina } from '../../services/core/paginacao.js';
import {
  alcanceDoCliente,
  anonimizarTitular,
  exportarDadosDoTitular,
  projetarCliente,
} from '../../services/lgpd/TitularService.js';
import { POLITICA_DE_RETENCAO } from '../../services/lgpd/PoliticaDeRetencao.js';
import {
  definirMarcaDaBancada,
  listarMarcasDasBancadas,
} from '../../services/core/WorkshopBrandService.js';
import {
  criarPromocao,
  editarPromocao,
  listarPromocoes,
} from '../../services/core/PromotionService.js';
import { criarCupom, encerrarCupom, listarCupons } from '../../services/core/CupomService.js';
import {
  comoInstanteFinal,
  diaDaLojaSql,
  hojeNaLoja,
  mesDaLoja,
} from '../../services/core/CalendarioOperacional.js';
import {
  MOVEMENT_KINDS,
  MOVEMENT_KIND_LABEL,
  applyMovement,
  listMovements,
  countMovements,
  listStock,
  stockValuation,
  conferirReenvioDoMovimento,
} from '../../services/core/InventoryService.js';
import {
  balanceByLocation,
  createLocation,
  listLocations,
  transferStock,
  updateLocation,
} from '../../services/core/StockLocationService.js';
import {
  allocateToBatch,
  balancesByBatch,
  batchAlerts,
  createBatch,
  findOrCreateBatch,
  getBatch,
  listBatches,
  markBatchChecked,
  pendenciasSemLote,
  setBatchControl,
  updateBatch,
  type FaixaDeValidade,
} from '../../services/core/BatchService.js';
import {
  FORMATO_PADRAO,
  LABEL_FORMATS,
  findLabelFormat,
  CAMPOS_DA_ETIQUETA,
} from '../../services/core/LabelFormats.js';
import {
  avisosDoFormato,
  problemasDosCodigos,
  renderLabelSheet,
  resumoDaFolha,
} from '../../services/core/LabelSheet.js';
import {
  atualizarModelo,
  criarModelo,
  excluirModelo,
  formatoDoModelo,
  listarModelos,
  obterModelo,
  validarModelo,
} from '../../services/core/LabelTemplateService.js';
import {
  LABEL_SOURCES,
  QUANTITY_MODES,
  listLabelCandidates,
  type LabelSource,
} from '../../services/core/LabelSourcesService.js';
import {
  SCALE_FORMATS,
  buildScaleFile,
  listWeighableProducts,
} from '../../services/core/ScaleExportService.js';
import { activePaymentMethods } from '../../services/core/PaymentMethods.js';
import { applyPrices, suggestionsForNote } from '../../services/core/RepricingService.js';
import {
  createAcquirer,
  listAcquirers,
  listRates,
  planForPayment,
  removeRate,
  setRate,
  updateAcquirer,
} from '../../services/core/AcquirerService.js';
import {
  createGroup as createCommissionGroup,
  fecharPeriodo,
  getClosing as getCommissionClosing,
  listClosings as listCommissionClosings,
  listGroups as listCommissionGroups,
  listMembers as listCommissionMembers,
  listTiers,
  removeTier,
  setMemberGroup,
  setTier,
  summarize as summarizeCommissions,
  updateGroup as updateCommissionGroup,
} from '../../services/core/CommissionService.js';
import {
  accountBalanceCents,
  createAccount,
  createCategory,
  createCostCenter,
  listAccounts,
  // `listCategories` já é a lista de categorias de PRODUTO. Nomes iguais para
  // coisas diferentes: aqui são categorias do plano de contas.
  listCategories as listFinanceCategories,
  listCostCenters,
  updateAccount,
  updateCategory,
  updateCostCenter,
} from '../../services/core/FinanceSetupService.js';
import { projetarFluxoDeCaixa } from '../../services/core/FluxoDeCaixa.js';
import {
  criarBaixasEspelhoLegadas,
  listarQuitacoesSemBaixa,
} from '../../services/core/BaixasLegadas.js';
import {
  getUnit,
  identifyUnit,
  // `listUnits` já é a lista de UNIDADES DE MEDIDA do catálogo. Nomes iguais
  // para coisas diferentes: aqui são peças físicas.
  listUnits as listProductUnits,
  searchUnit,
} from '../../services/core/ProductUnitService.js';
import {
  desvincularUnidade,
  plaquinhaDaUnidade,
  plaquinhasVinculaveis,
  vincularUnidade,
} from '../../services/core/EquipmentStockLink.js';
import { cancelSale, countSales, createSale, getSaleDetail, listSales } from '../../services/core/SalesService.js';
import {
  addMovement,
  closeSession,
  getOpenSession,
  getSession,
  getSummary,
  listSessions,
  openSession,
  reopenSession,
  deOutroDia,
  listarGavetasAbertas,
} from '../../services/core/CashService.js';
import {
  desistirDaCobranca,
  listarPendenciasDaMaquininha,
  registrarTratativa,
  vincularCobrancaAVenda,
} from '../../services/core/CobrancasSemVenda.js';
import { executarEstornosPendentes, registrarEstornoManual } from '../../services/core/EstornoNaMaquininha.js';
import {
  assertTerminalDaEmpresa,
  contarTerminaisAtivos,
  terminalDoPedido,
} from '../../services/core/TerminalRegistry.js';
import {
  createTerminal,
  listTerminals,
  renameTerminal,
  setTerminalActive,
} from '../../services/core/TerminalService.js';
import { listAudit, listAuditActions, recordAudit } from '../../services/audit/AuditService.js';
import { nfseRouter } from './nfse.js';
import {
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  addComment,
  addPart,
  assumeOrder,
  completeTechnical,
  createOrder,
  decidirOrcamentoNoBalcao,
  getOrderDetail,
  searchOrders,
  moveOrder,
  pedirAprovacaoOrcamento,
  releaseOrder,
  setLabor,
  setOrderPlan,
} from '../../services/core/WorkshopCoreService.js';
import {
  estornarRecebimentoDaOs,
  filaDeRecebimento,
  receberOs,
  vendaAEstornar,
} from '../../services/core/WorkshopCashierService.js';
import {
  bancadaDeEntrada,
  bancadasDeEntrada,
  type BancadaDeEntrada,
} from '../../services/core/WorkshopIntakeService.js';
import { lerVersaoEsperada } from '../../services/core/WorkshopOrderVersion.js';
import { regularizarOs } from '../../services/core/WorkshopOrderRegularization.js';
import {
  definirPlaquinhaDaEmpresa,
  gravarPlaquinhaDaEmpresa,
  lerEscolhaDePlaquinha,
  plaquinhaPadraoDaEmpresaNova,
} from '../../services/core/CompanyTagSettings.js';
import { folhaDaPlaquinhaDaUnidade } from '../../services/core/UnitTagReprint.js';
import {
  corrigirIdentidade,
  vinculoDeEstoque,
} from '../../services/core/EquipmentIdentityService.js';
import {
  addEquipmentPhoto,
  listEquipmentPhotos,
  removeEquipmentPhoto,
} from '../../services/core/EquipmentPhotoService.js';
import {
  getSlaConfig,
  resetSlaConfig,
  saveSlaConfig,
} from '../../services/core/WorkshopSlaService.js';
import {
  ASSIGNABLE_PROFILES,
  assertPassword,
  createTeamMember,
  listTeam,
  removerDaOperacao,
  resetTeamMemberPassword,
  setTeamMemberActive,
  updateTeamMember,
  vincularContaExistente,
} from '../../services/core/TeamService.js';
import { acoesSobre, capacidadeDe, exigenciaDe } from '../../services/core/HierarquiaDePerfis.js';
import {
  agingPorFaixas,
  createEntry,
  listEntries,
  listSettlements,
  relatorioPorCentroDeCusto,
  reverseSettlement,
  settleEntry,
  summarize,
} from '../../services/core/FinanceService.js';
import { incomeStatement } from '../../services/core/IncomeStatementService.js';
import {
  FISCAL_MODELS,
  assessProductionUnlock,
  buildReadiness,
  getFiscalConfig,
  isValidCnpj,
  listProductFiscalPendencies,
  unlockProduction,
  updateFiscalConfig,
  updateProductFiscal,
} from '../../services/core/FiscalConfigService.js';
import {
  confirmClassification,
  listProductClassifications,
  summarizeClassification,
} from '../../services/core/FiscalSuggestionService.js';
import { getSeries, setSeriesNextNumber } from '../../services/core/FiscalKeyService.js';
import {
  getDocument,
  listDocumentEvents,
  getFiscalDocumentRow,
  listFiscalDocuments,
} from '../../services/core/FiscalDocumentService.js';
import {
  emitNfceForSale,
  fiscalStatusForSale,
  emissionReadinessForSale,
} from '../../services/core/FiscalPipelineService.js';
import { renderDanfce } from '../../services/core/DanfceRenderer.js';
import { renderDanfe } from '../../services/core/DanfeRenderer.js';
import {
  CCE_LIMITATION_NOTICE,
  listVoidRanges,
  requestCancel,
  requestCorrectionLetter,
  requestVoidRange,
} from '../../services/core/FiscalEventsService.js';
import {
  adapterDoAtoFiscal,
  gravarPoliticaDosAtos,
  planejarAtoFiscal,
} from '../../services/core/FiscalAtosAdministrativos.js';
import { cancelOrderCharges, refundOrder } from '../../services/core/OrderChargeService.js';
import { receberMercadoriaDevolvida } from '../../services/core/OrderReturnService.js';
import { decidirSolicitacao, listarSolicitacoes } from '../../services/core/PosVendaDoPortal.js';
import { type SefazAdapter } from '../../services/core/SefazAdapter.js';
import { TransportFailure } from '../../services/core/SefazTestAdapter.js';
import { loadEnv } from '../../config/env.js';
import { reconciliationReport } from '../../services/core/FiscalReconciliation.js';
import { requeueFromContingency } from '../../services/core/FiscalContingencyService.js';
import { painelDaFila, transmitirAgora } from '../../services/core/FiscalFilaPainel.js';
import { resumoFiscalDoPdv } from '../../services/core/ResumoFiscalDoPdv.js';
import { drenarEmpresa } from '../../services/core/FiscalQueueWorker.js';
import {
  abrirPeriodo,
  encerrarPeriodo,
  gravarPoliticaDeContingencia,
  painelDaContingencia,
} from '../../services/core/FiscalContingenciaOffline.js';
import { buildLabels, ensureBarcode, itemParaPrevia } from '../../services/core/BarcodeService.js';
import { generateVariants, variantStock } from '../../services/core/VariantService.js';
import {
  type DocumentType,
  TIPOS_RESERVADOS,
  advancePrintJob,
  createPrintJob,
  getPrintJob,
  getPrinter,
  impressoraDoDanfce,
  impressoraDoDocumento,
  listPrintJobs,
  listPrinters,
  papelSimples,
  printReadiness,
  reprintJob,
  upsertPrinter,
} from '../../services/core/PrintEngine.js';
/*
  O cupom na língua da térmica e a verdade sobre a gaveta (GAP-V55). Ficam num
  arquivo próprio porque são OUTRO transporte do mesmo papel — não uma variação
  do renderizador de HTML.
*/
import { cupomEscPosDaVenda, prontidaoDaGaveta } from '../../services/core/EscPos.js';
import {
  alcadaDaVendaGuardada,
  concluirRelancamento,
  corpoDaVendaOffline,
  descartarVendaOffline,
  destinoDoRelancamento,
  listarVendasOfflineRecusadas,
  registrarRecusaDoRelancamento,
  registrarVendaOfflineRecusada,
  relancarComAjusteDePreco,
  vendaNovaDaPendencia,
  type AjusteDePrecoAplicado,
} from '../../services/core/VendasOfflineRecusadas.js';
import { recusarChaveDoServidor } from '../../services/core/ChavesDoServidor.js';
import { renderDocument } from '../../services/core/PrintRenderer.js';
import {
  listBrands,
  listCategories,
  listOrphanValues,
  mergeBrand,
  mergeCategory,
  removeBrand,
  removeCategory,
  upsertBrand,
  upsertCategory,
} from '../../services/core/TaxonomyService.js';
import {
  addProductBarcode,
  deleteCustomField,
  deletePriceTable,
  deleteTaxGroup,
  deleteTaxRate,
  deleteUnit,
  diferencasDosCamposProprios,
  gravarConfigDaEtiquetaDaBalanca,
  kitCostCents,
  lerConfigDaEtiquetaDaBalanca,
  listCustomFields,
  listCustomValues,
  listKitComponents,
  listPriceTableItems,
  listPriceTables,
  listPriceTiers,
  listProductBarcodes,
  listTaxGroups,
  listTaxRates,
  listUnits,
  removePriceTableItem,
  removePriceTier,
  removeProductBarcode,
  setCustomValues,
  setKitComponents,
  setPriceTableItem,
  setPriceTier,
  upsertCustomField,
  upsertPriceTable,
  upsertTaxGroup,
  upsertTaxRate,
  upsertUnit,
} from '../../services/core/CatalogAuxService.js';
import { avaliarPreco, precoPorMargem, precoPorMarkup } from '../../services/core/Pricing.js';
import { cloneProduct } from '../../services/core/ProductCloneService.js';
import {
  converterParaPeca,
  converterParaRevenda,
} from '../../services/core/ProductKindService.js';
import {
  checkInbox,
  getInboxStatus,
  listMailMessages,
  removeInbox,
  testarConexao,
  upsertInbox,
} from '../../services/core/MailInboxService.js';
import {
  getSchedulerSettings,
  setSchedule,
} from '../../services/core/MailInboxScheduler.js';
import {
  effectivePriceCents,
  priceCartForCustomer,
} from '../../services/core/PricingService.js';
import {
  addProductImage,
  resolverNomesDeFotos,
  listProductImages,
  removeProductImage,
  reorderProductImages,
  setPrimaryImage,
} from '../../services/core/ProductImageService.js';
import {
  cancelQuote,
  convertQuote,
  createQuote,
  expireOverdueQuotes,
  getQuoteDetail,
  listQuotes,
  countQuotes,
  promoteToPreSale,
  renewQuote,
  updateQuote,
} from '../../services/core/QuoteService.js';
import {
  lerUnidadesPedidas,
  reservarUnidadesDaPreVenda,
  reservasAtivas,
} from '../../services/core/UnitHoldService.js';
import { desfazerVendaAMao, temVendaAMao } from '../../services/core/EquipmentManualSale.js';
import {
  criarConsignacao,
  faturarConsignacao,
  fecharConsignacao,
  getConsignacao,
  listConsignacoes,
  registrarRetorno,
} from '../../services/core/ConsignmentService.js';
import {
  createSupplier,
  listSuppliers,
  loadSupplier,
  setSupplierActive,
  supplierPurchaseHistory,
  updateSupplier,
} from '../../services/core/SupplierService.js';
import {
  carrierNoteHistory,
  createCarrier,
  listCarriers,
  loadCarrier,
  setCarrierActive,
  updateCarrier,
} from '../../services/core/CarrierService.js';
import {
  getInboundConfig,
  setInboundConfig,
} from '../../services/core/InboundConfigService.js';
import {
  EQUIPMENT_TAG_FORMATS,
  FORMATO_PERSONALIZADO,
  equipmentTagFormat,
  formatoDoLayout,
} from '../../services/core/EquipmentTagFormats.js';
import {
  renderEquipmentTagSheet,
  type PlaquinhaItem,
} from '../../services/core/EquipmentTagSheet.js';
import { publicBaseUrl, publicBaseUrlConfigurada } from '../../services/core/PrintRenderer.js';
import {
  converterChamado,
  decidirOrcamento,
  emitirConvitePortal,
  encerrarChamado,
  listarChamadosDaOficina,
} from '../../services/core/EquipmentPortalService.js';
import {
  marcasDoPainel,
  marginWhereReliable,
  operationsOverview,
  recorteDaVendaQueFatura,
  recorteDoPedidoQueFatura,
  topBrands,
  topProducts,
} from '../../services/core/GroupInsights.js';
import { operacoesOndeOPerfilAbre } from '../../services/auth/AlcanceCruzado.js';
import { assinarCaminhoDaFoto } from '../../services/core/FotoDaOsAssinada.js';
import { quemLiberaNaOperacao, RESTRICTED_ACTIONS } from '../../services/core/AuthorizationService.js';
import {
  configuracaoDaRecuperacao,
  definirRecuperacaoPorEmail,
} from '../../services/auth/RecuperacaoDeSenhaDaEquipe.js';
import { carteiroConfigurado } from '../../services/notifications/EmailService.js';
import {
  listReports,
  nomeDaEmpresa,
  nomeDoArquivo,
  periodoDoPedido,
  reportToCsv,
  runReport,
} from '../../services/core/ReportsService.js';
import { nomeDeArquivoSeguro } from '../../services/core/Csv.js';
import { capabilitiesFor } from '../../services/core/WorkshopCapabilities.js';
import {
  addWorkshopMember,
  listWorkshopMembers,
  removeWorkshopMember,
} from '../../services/core/WorkshopMembersService.js';
import {
  getStorefrontPreset,
  getStorefrontSettings,
  listPublishedForAdmin,
  removeStoreImage,
  setFeatured,
  setStoreImage,
  updateStorefrontSettings,
} from '../../services/core/StorefrontSettingsService.js';
import {
  definirModoDoCheckout,
  politicaDoCheckout,
} from '../../services/core/CheckoutIdentityService.js';
import {
  lerConfiguracaoGoogle,
  retratoParaAuditoria as retratoDoGoogle,
  salvarConfiguracaoGoogle,
} from '../../services/core/GoogleLoginConfigService.js';
import {
  importStatement,
  listLinesPage,
  listStatementsPage,
  matchLine,
  reconcileBank,
  suggestMatches,
  unmatchLine,
} from '../../services/core/BankReconciliation.js';
import {
  listParts,
  podeVerCusto,
  returnPartToStock,
} from '../../services/core/WorkshopPartsService.js';
import {
  ajustarPeca,
  cadastrarPecaComEntrada,
  reporPeca,
  resolverCodigo,
} from '../../services/core/WorkshopPartsEntryService.js';
import {
  cancelRentalContract,
  createRentalContract,
  getRentalContract,
  listRentalContracts,
  returnRentalItems,
} from '../../services/core/RentalContractService.js';
import {
  customerStatement,
  getProgram,
  loyaltyLiability,
  redeemPoints,
  updateProgram,
} from '../../services/core/LoyaltyService.js';
import {
  creditLiability,
  creditStatement,
} from '../../services/core/CustomerCreditService.js';
import {
  closeOpportunity,
  convertLead,
  createLead,
  createOpportunity,
  crmSummary,
  listLeads,
  listOpportunities,
  updateLeadStatus,
} from '../../services/core/LeadService.js';
import {
  applyInventoryCount,
  cancelInventoryCount,
  getInventoryCount,
  listInventoryCounts,
  openInventoryCount,
  recordCount,
} from '../../services/core/InventoryCountService.js';
import {
  createSaleReturn,
  devolucaoDaChave,
  getSaleReturn,
  listSaleReturns,
  marcarAprovacaoDaDevolucao,
  reembolsoDaChave,
  registrarReembolso,
  returnableItems,
  vendaDaDevolucao,
  vendaParaDevolucao,
} from '../../services/core/SaleReturnService.js';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  linkNoteToOrder,
  listPurchaseOrders,
  countPurchaseOrders,
  sendPurchaseOrder,
  updatePurchaseOrderItems,
} from '../../services/core/PurchaseOrderService.js';
import {
  getCertificateView,
  listGroupCertificates,
  revokeCertificate,
} from '../../services/core/CertificateStatusService.js';
import { upsertCertificateA1 } from '../../services/fiscal/FiscalCertificateService.js';
import { unidadeFiscalDoPedido } from '../../services/core/UnidadeFiscal.js';
import {
  listNfceCscSettings,
  sanitizeNfceCscForResponse,
  upsertNfceCsc,
  type AmbienteDoCsc,
} from '../../services/nfce/NfceCscService.js';
import { requireIdempotencyKey, requisicaoDe, withIdempotency } from '../../services/api/ApiIdempotencyService.js';
import * as Impressao from '../../services/api/ImpressaoDaRequisicao.js';
import {
  chargeOnTerminal,
  confirmarPixDeTeste,
  getTerminalPayment,
  getTerminalStatus,
  listTerminalConfigurationsForManager,
  listUncertainPayments,
  reconcileTerminalPayment,
  setTerminalConfigurationActive,
} from '../../services/core/PdvTerminalService.js';
import {
  assignOwner,
  createEquipment,
  fichaDoEquipamento,
  formatPublicId,
  getEquipment,
  listEquipment,
  countEquipment,
  setEquipmentWarrantyAndAssembly,
  warrantyOf,
} from '../../services/core/EquipmentService.js';
import {
  criarLoteDePlaquinhas,
  empresaTemBancada,
  empresaUsaPlaquinha,
  exigirBancadaQueColaPlaquinha,
  exigirEmpresaComPlaquinha,
  formatTagId,
  listarLotes as listarLotesDePlaquinha,
  listarPlaquinhas,
  liberarPlaquinhas,
  marcarDanificada,
  marcarImpressas,
  plaquinhasDoLote,
  plaquinhasPorId,
  resumoDoPool,
  semCredencial,
  substituirPlaquinha,
} from '../../services/core/EquipmentTagPoolService.js';
import {
  layoutDaEmpresa,
  layoutValidado,
  salvarLayout,
} from '../../services/core/EquipmentTagLayoutService.js';
import { renderServiceOrderA4 } from '../../services/core/ServiceOrderA4.js';
import {
  addOrderPhoto,
  listOrderPhotos,
  removeOrderPhoto,
} from '../../services/core/WorkshopPhotoService.js';
import {
  listChecklist,
  responderItem,
} from '../../services/core/WorkshopChecklistService.js';
import {
  createCompanyWithFounders,
  findUserById,
  listCompaniesForUser,
  respondePeloGrupo,
} from '../../services/auth/IdentityService.js';
import { hashPassword } from '../../services/auth/PasswordService.js';
import {
  cancelOrder as cancelStoreOrder,
  ETAPAS_DA_ENTREGA,
  ETAPAS_DA_RETIRADA,
  ORDER_STATUS_LABEL,
  getOrderDetail as getStoreOrderDetail,
  listOrders as listStoreOrders,
  countOrders as countStoreOrders,
  markOrderPaid,
  regressFulfillment,
} from '../../services/core/StorefrontService.js';
import {
  corrigirMunicipioDaNotaDoPedido,
  emitNfeForOrder,
  orderInvoiceReadiness,
} from '../../services/core/OrderInvoiceService.js';
import {
  backendLogisticsQuote,
  logisticsProvidersStatus,
  logisticsReadiness,
  melhorEnvioIntegrationStatus,
} from '../../services/logistics/LogisticsService.js';
import { originZipOf } from '../../services/logistics/LogisticsReadinessService.js';
import { avancarEtapaDoPedido, comLinkDeRastreio } from '../../services/logistics/EnvioDoPedidoService.js';
import { prontidaoDasOperacoes } from '../../services/logistics/ProntidaoDoDiaUm.js';
import { prontidaoDosSegredos } from '../../db/secretsReadiness.js';
import {
  getShippingSettings,
  saveShippingSettings,
} from '../../services/core/CheckoutShippingService.js';
import { reconcileAsaas } from '../../services/core/AsaasReconciliation.js';
import {
  contarCobrancasAConsultar,
  sincronizarCobrancasComProvedor,
  ultimaSincronizacao,
} from '../../services/core/AsaasSincronizacao.js';
import {
  EMAIL_QUEUE_STATUSES,
  emailStatus,
  flushEmailQueue,
  listEmailQueue,
  reenfileirarEmail,
  remetenteDoAmbiente,
  type EmailQueueStatus,
} from '../../services/notifications/EmailService.js';
import {
  identidadeParaATela,
  salvarIdentidade,
} from '../../services/notifications/IdentidadeDoRemetente.js';
import { prontidaoDasComunicacoes } from '../../services/notifications/ProntidaoDasComunicacoes.js';
import { avisosDaOs } from '../../services/notifications/AvisosDaOficina.js';
import {
  getAsaasStatus,
  getIntentsFor,
  listPaymentIntents,
  retryPaymentIntent,
  testAsaasCredential,
} from '../../services/core/PaymentService.js';
import {
  cancelFinanceEntryCharges,
  chargeFinanceEntry,
} from '../../services/core/FinanceChargeService.js';
import { refundFinanceEntryCharge } from '../../services/core/FinanceChargeRefund.js';
import {
  cancelarPixDoBalcao,
  confirmarPixPendente,
  consultarPixDoBalcao,
  criarPixDoBalcao,
  listarPixPendentesDoBalcao,
  statusDoPixDoBalcao,
} from '../../services/core/PdvPixService.js';
import { probeCentralSchema, syncOnce, syncStatus } from '../../services/sync/SyncService.js';
import { bootstrapCentralFromLocal } from '../../services/sync/BootstrapService.js';
import { reviverMortos } from '../../services/sync/OutboxService.js';
import {
  asaasEnvFallbackAllowed,
  getAsaasCredentialStatus,
  removeAsaasSecret,
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../../services/integrations/AsaasCredentialService.js';
// A URL do webhook por operação e o último aviso recebido (GAP-PRD-002).
import { describeAsaasWebhook } from '../../services/core/AsaasWebhookInfo.js';
// O que cada operação do grupo ainda precisa para cobrar (GAP-PRD-017).
import { prontidaoAsaasDoGrupo } from '../../services/core/ProntidaoAsaasDoGrupo.js';
// A homologação do sandbox, que até a rodada 62 não tinha porta nenhuma.
import {
  conferirAvisoExternoDaHomologacao,
  runAsaasSandboxHomologation,
} from '../../services/integrations/AsaasHomologationService.js';
import {
  getAsaasIntegrationState,
  resetAsaasConnectionState,
  upsertAsaasIntegrationState,
} from '../../services/integrations/AsaasIntegrationStateService.js';
import {
  authorizeAction,
  consumirLiberacaoDeAcao,
  listAuthorizations,
  temAlcadaParaLiberar,
} from '../../services/core/AuthorizationService.js';
import {
  fluxoDaDevolucao,
  politicaDaEmpresa,
  salvarPolitica,
  validadeDaReserva,
} from '../../services/core/SalePolicyService.js';
import {
  confirmNfe,
  conferirItem,
  createManualInboundNote,
  estornarNota,
  fornecedorPeloDocumento,
  getNoteXml,
  importNfe,
  linkNoteItem,
  listNoteItems,
  listNotes,
  countNotes,
  matchItems,
  parseNfeXml,
  exigirNotaComValidadeFiscal,
  exigirNotaDestaEmpresa,
} from '../../services/core/NfeImportService.js';
import {
  consultarDistribuicao,
  estadoDaDistribuicao,
  importarDfe,
  listarDfe,
  ambienteDaDistribuicao,
  documentosDeOutroAmbiente,
  manifestarDfe,
  type TipoManifestacao,
} from '../../services/core/DfeDistribuicaoService.js';
import { importCte, listCtes } from '../../services/core/CteImportService.js';
import { SefazRealAdapter } from '../../services/core/SefazRealAdapter.js';
// O teste de comunicação abre o certificado AQUI para separar "senha não
// abriu" de "SEFAZ não respondeu" — ver POST /fiscal/sefaz/status.
import { getCertificateA1 } from '../../services/fiscal/FiscalCertificateService.js';
import {
  montarPacote,
  previaDoFechamento,
} from '../../services/core/FiscalClosingService.js';
import { conferirPacote } from '../../services/core/ConferenciaDoPacote.js';
import { relerNotasRecebidas } from '../../services/core/ReleituraDasNotasRecebidas.js';
import {
  emitirNoFinalizar,
  gravarPoliticaDeEmissao,
  lerPoliticaDeEmissao,
} from '../../services/core/EmissaoNoFinalizar.js';
import {
  agendaDoContador,
  atualizarDestinatario,
  criarDestinatario,
  enviarPacotePorEmail,
  gravarAgendaDoContador,
  listarDestinatarios,
  listarEnvios,
} from '../../services/core/ContadorEnvioService.js';
import {
  confirmarLote,
  descartarLote,
  importarPlanilha,
  listarItens as listarItensDaImportacao,
  listarLotes,
  relerLote,
} from '../../services/core/ProductImportService.js';
// Frente EST, lote T3 (GAP-PRD-087/088/089/090/165/166/167).
import { conferirReservas, liberarReservaSemOrigem } from '../../services/core/ReservaSemOrigemService.js';
import {
  enviarPedidoPorEmail,
  renderPurchaseOrderA4,
} from '../../services/core/PurchaseOrderDocument.js';
import {
  getDevolucao,
  itensDevolviveis,
  listarDevolucoes,
  registrarDevolucao,
  registrarSituacaoFiscal,
} from '../../services/core/SupplierReturnService.js';
import {
  decidirContaDaNota,
  notasRecebidasSemConta,
} from '../../services/core/NotaSemContaService.js';
import {
  politicaDeGestao,
  salvarPoliticaDeGestao,
  veCustoDoEstoque,
  veDinheiroDoPainel,
} from '../../services/core/PoliticaDeGestaoService.js';

/*
  `customerIdOfUser` saiu junto com a rota /equipment/by-token.

  Ela lia `core_users.customer_id` para descobrir de quem era a conta do
  proprietário — uma identidade de dono construída sobre USUÁRIO INTERNO, que
  é a mesma tabela do mecânico e do caixa. O portal do cliente tem a sua
  própria (`core_customer_accounts` + `core_customer_account_links`), e manter
  duas fazia a que não funcionava parecer a oficial.
*/

export const coreRouter = Router();

coreRouter.use(authMiddleware);

/** Escopo da requisição, sempre a partir da sessão autenticada. */
function scope(req: AuthedRequest): { companyId: string; userId: string; profiles: string[] } {
  return {
    companyId: req.auth!.companyId,
    userId: req.auth!.sub,
    profiles: req.auth!.profileCodes ?? [],
  };
}

/** RBAC simples: admin_geral e gestor passam por qualquer exigência. */
/**
 * Os códigos de caixa — os três.
 *
 * O caixa existe POR OPERAÇÃO (loja e oficina), e o genérico ficou de
 * instalação antiga. É o mesmo papel nos três casos, e listar um subconjunto
 * foi exatamente o que quebrou: `/finance/entries/:id/settle` só aceitava o
 * genérico, que ninguém tem — nenhum caixa real dava baixa em lançamento. E as
 * seis rotas fiscais esqueciam o `_oficina`, então o caixa da Oficina vendia e
 * não conseguia emitir a nota da própria venda.
 *
 * Espalhar a lista à mão foi o que permitiu a divergência. Agora é um nome.
 */
const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'] as const;

/**
 * QUEM OPERA O BALCÃO — os caixas e a gerência das DUAS bancadas.
 *
 * O mesmo esquecimento do comentário acima, do outro lado: a lista voltou a
 * ser espalhada à mão e as rotas de dinheiro do balcão nomeavam `gerente_loja`
 * sem `gerente_oficina`. O roteador do navegador deixa o gerente da oficina
 * chegar ao /pdv, e em oficina pequena ele É quem fica no balcão — abria a
 * tela inteira, montava o carrinho com o cliente na frente e tomava 403 no
 * Finalizar.
 *
 * Vira um nome, como os caixas viraram. Há varredura cobrando.
 */
const BALCAO_E_GERENCIA = [...CAIXAS, 'gerente_loja', 'gerente_oficina'] as const;

function requireProfile(req: AuthedRequest, ...allowed: string[]): void {
  // Vínculo personalizado na tela de Usuários: só a capability da rota decide —
  // a página retirada fecha mesmo para o perfil que a lista abaixo deixaria passar.
  if (decidePelaCapability(req)) {
    if (passaPelaCapabilityDaRota(req)) return;
    throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
  }
  const profiles = req.auth?.profileCodes ?? [];
  if (profiles.includes('admin_geral') || profiles.includes('gestor')) return;
  if (allowed.some((p) => profiles.includes(p))) return;
  // A ponte do acesso granular: os atalhos da tela de Usuários (Somente PDV,
  // PDV + Painel, Estoque…) passam quando têm a capability desta rota
  // (PonteDaRota.ts). Os modelos de sistema dão exatamente o acesso de hoje,
  // então para os perfis de hoje nada muda.
  if (passaPelaCapabilityDaRota(req)) return;
  throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
}

/*
  ================================ ABERTURA DECLARADA ==========================

  ## O problema que isto resolve, e por que não era o estoque de rotas caladas

  Este arquivo tem 297 rotas. Cinquenta e duas não diziam NADA sobre quem as
  alcança. O defeito não era o número: era que o SILÊNCIO É INDISTINGUÍVEL DE
  "ABERTA DE PROPÓSITO". Uma rota que ninguém guardou e uma rota que alguém
  decidiu abrir têm exatamente a mesma cara no código, e foi assim que as 52
  apareceram uma de cada vez ao longo de vinte e duas rodadas. Acrescentar 52
  `requireProfile` consertaria hoje e não impediria a rota 298.

  ## A diferença entre declarar abertura e ficar calado

  Uma crítica afiada apontou que `abertaAo(req, 'balcao', 'bancada',
  'escritorio')` é, em execução, idêntico a não ter guarda nenhum: todo mundo
  passa nos dois casos. Isso é FALSO, e a diferença é justamente o ponto da
  rodada:

    - SEM guarda, um perfil DESCONHECIDO passa. É falha ABERTA. No dia em que
      alguém criar o nono perfil — um "conferente", um "auxiliar", um vínculo
      antigo com código escrito errado —, ele entra em todas as rotas caladas,
      em silêncio, sem ninguém tocar em uma linha deste arquivo.

    - COM `abertaAo`, um perfil que não pertence a ambiente nenhum recebe 403.
      É falha FECHADA. O perfil novo não entra em lugar nenhum até que alguém
      o coloque numa das três listas abaixo — que é exatamente o momento em
      que a decisão deve ser tomada por gente, e não herdada por omissão.

  `rotas-abertura-declarada.test.ts` prova os dois lados com um perfil
  inventado, numa rota aberta aos três ambientes. Se o teste passar sem o
  guarda, o guarda não vale nada — e ele não passa.

  ## Por cima de `requireProfile`, e não ao lado

  `abertaAo` DELEGA. Não existe um segundo caminho de autorização: o atalho de
  `admin_geral` e `gestor` continua com uma implementação só, e o dia em que a
  regra de RBAC mudar, muda num lugar. Quem precisa nomear perfis um a um
  continua chamando `requireProfile` direto — é o caso das rotas que servem
  papéis específicos, como a política de desconto que só o gerente edita.

  ## As quatro listas

  Os nomes são os do prédio, não os do organograma, porque é assim que o
  roteador do navegador já pensa (`src/router/environments.ts`): `pdv`,
  `oficina`, `gestao` e, a partir desta rodada, `contabilidade`. A regra para
  escolher o ambiente de uma rota é o conjunto que o roteador deixa chegar às
  telas que a consomem — NUNCA mais estreito que a tela, porque guarda mais
  estreito que a tela quebra tela em produção — somado ao que o CORPO da rota
  já diz sobre quem ela serve.

  ## Os dois Records moram em arquivos diferentes, e ninguém os liga

  Este `PERFIS_DO_AMBIENTE` e o `AMBIENTE_POR_PERFIL` do navegador dizem a
  mesma coisa em dois lugares, e o `tsc` não conhece nenhuma relação entre os
  dois: um é servidor, o outro é frontend, e nenhum importa o outro. Divergir é
  fácil e o sintoma é feio dos dois lados — se o navegador puser um perfil num
  ambiente que o servidor não põe, a tela abre e a rota responde 403; se o
  servidor for mais largo, a rota entrega dado que a tela nunca ofereceu.

  Quem amarra os dois é `ambientes-dos-dois-lados.test.ts`, que lê os dois
  arquivos por AST e cobra a correspondência perfil a perfil.
*/

/** O balcão: quem opera caixa, nas duas operações e no genérico antigo. */
const BALCAO = CAIXAS;

/** A bancada: quem põe a mão no aparelho. */
const BANCADA = ['mecanico'] as const;

/**
 * O escritório: quem administra.
 *
 * `admin_geral` e `gestor` NÃO estão aqui de propósito — eles passam por cima
 * de qualquer lista dentro de `requireProfile`, e repeti-los aqui criaria uma
 * segunda cópia dessa regra para divergir da primeira.
 */
const ESCRITORIO = ['gerente_loja', 'gerente_oficina', 'estoquista', 'atendente'] as const;

/**
 * A contabilidade: o escritório do contador, que fica FORA da empresa.
 *
 * ## Por que um ambiente próprio, e não `contador` dentro de ESCRITORIO
 *
 * Ambiente é prédio. O contador não trabalha no escritório da loja: ele
 * recebe o mês e vai embora. Pô-lo em ESCRITORIO o faria entrar, de uma vez
 * só e sem ninguém decidir, em TODAS as rotas guardadas por `abertaAo(req,
 * 'escritorio')` — o financeiro, o custo do produto, a equipe, o cliente. Não
 * é um alargamento que se revisa: é uma lista que ninguém lê inteira.
 *
 * ## Ele falha FECHADO de graça, e é isso que faz o trabalho ser pequeno
 *
 * `contador` não pertence a nenhum OUTRO ambiente. Como `abertaAo` monta a
 * lista de perfis a partir dos ambientes declarados, toda rota que declara
 * alcance por ambiente já o recusa com 403 sem ninguém escrever uma linha a
 * respeito dela. O trabalho da rodada não foi FECHAR 307 rotas; foi ABRIR
 * três — a prévia, o pacote e o XML da nota recebida —, e cada uma delas
 * nomeia `contador` no próprio `requireProfile`, onde a decisão fica visível
 * ao lado do que ela libera.
 *
 * Nenhuma rota declara `abertaAo(req, 'contabilidade')` hoje, e isso é
 * correto: as três que ele alcança servem também a gerente, e nomear perfis
 * um a um é o que `requireProfile` existe para fazer. A lista está aqui para
 * que o ambiente EXISTA — sem ela, `contador` seria um perfil sem prédio, e o
 * dia em que uma tela inteira for dele o roteador do navegador não teria com
 * o que casar.
 */
const CONTABILIDADE = ['contador'] as const;

type Ambiente = 'balcao' | 'bancada' | 'escritorio' | 'contabilidade';

const PERFIS_DO_AMBIENTE: Record<Ambiente, readonly string[]> = {
  balcao: BALCAO,
  bancada: BANCADA,
  escritorio: ESCRITORIO,
  contabilidade: CONTABILIDADE,
};

/**
 * Declara a QUAIS AMBIENTES esta rota está aberta.
 *
 * Exige pelo menos um ambiente por assinatura: `abertaAo(req)` seria uma rota
 * que nega todo mundo, e quem quer isso está querendo outra coisa.
 */
function abertaAo(req: AuthedRequest, primeiro: Ambiente, ...outros: Ambiente[]): void {
  const perfis = [primeiro, ...outros].flatMap((a) => PERFIS_DO_AMBIENTE[a]);
  requireProfile(req, ...perfis);
}

// ------------------------------------------------------------------ produtos

coreRouter.get('/products', (req: AuthedRequest, res, next) => {
  try {
    /*
      As cinco telas que listam produto — Produtos, Etiquetas, Locação, Alteração
      rápida e o formulário — são todas ROTA_GESTAO no roteador. O balcão nunca
      chega aqui: ele acha produto por `/products/search`, que é outra rota.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    /*
      A PÁGINA SE DECLARA (GAP-PRD-070): 150 produtos devolviam 100 e mais
      nada, e a tela de Produtos desenhava os 100 como o catálogo. `total`
      respeita busca e filtro; o `limit` tem teto de 500.
    */
    const recorte = {
      search: req.query.search as string | undefined,
      missingShippingData: req.query.missingShippingData === '1',
      // `?situacao=ativos|inativos` — o filtro "mostrar inativos" da tela de
      // Produtos. Ausente = todos, como sempre foi: as outras quatro telas que
      // listam por aqui (Etiquetas, Locação, Alteração rápida, formulário) não
      // mudam de universo por esta rodada.
      situacao: lerSituacaoDoCadastro(req.query.situacao),
    };
    const pagina = lerPagina(req.query, 100);
    res.json({
      items: listProducts(companyId, { ...recorte, ...pagina }),
      total: countProducts(companyId, recorte),
      ...pagina,
      // Contagem real, sempre — é ela que o painel mostra como pendência.
      missingShippingDataCount: countProductsMissingShippingData(companyId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O que falta em cada produto para ele vender online.
 *
 * Vem ANTES de `/products/:id` porque o Express casa na ordem: declarada
 * depois, a palavra "prontidao-online" viraria um id de produto.
 */
/**
 * O casamento arquivo→produto do envio de fotos em lote (rodada 45).
 * Antes de /products/:id pelo mesmo motivo da prontidão: declarada depois,
 * "fotos-em-lote" viraria um id de produto.
 */
coreRouter.post('/products/fotos-em-lote/resolver', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    res.json({ items: resolverNomesDeFotos(companyId, names) });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/products/prontidao-online', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({ items: listOnlineReadiness(companyId) });
  } catch (err) {
    next(err);
  }
});

/** Publica de uma vez os produtos que já estão prontos. */
coreRouter.post('/products/publicar-prontos', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    // Sem foto é aviso, e levar os sem foto no lote é escolha explícita do
    // gestor (GAP-PRD-207): só `true` de verdade liga.
    const incluirSemFoto = req.body?.incluirSemFoto === true;
    const resultado = publishReadyProducts(companyId, { incluirSemFoto });
    recordAudit({
      companyId,
      userId,
      action: 'product.publish_ready',
      entityType: 'product',
      entityId: 'lote',
      detail: {
        published: resultado.published.length,
        skipped: resultado.skipped,
        semFoto: resultado.semFoto,
        incluirSemFoto,
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/products/search', (req: AuthedRequest, res, next) => {
  try {
    /*
      A busca do PDV. `?includeParts=1` é o interruptor "incluir peças da
      oficina" da tela de venda — a rota foi escrita para o balcão, e ROTA_PDV
      aceita `pdv` e `gestao`.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const term = String(req.query.q ?? '').trim();
    if (!term) {
      res.json({ items: [] });
      return;
    }
    // `?excludeKits=1` é a tela de montar kit pedindo só o que pode virar peça.
    //
    // `?includeParts=1` é a tela dizendo "quero as peças de bancada também".
    // Sem ele, a busca POR TEXTO devolve só mercadoria de revenda — e a busca
    // POR CÓDIGO devolve a peça de qualquer forma, ligada ou desligada, porque
    // negar um item que está na mão do operador faz alguém cadastrá-lo de novo
    // e rachar o saldo em dois cadastros. A doutrina inteira está em
    // `searchProducts`; a linha da peça vem marcada com `kind` e
    // `workshop_name` para a tela poder distinguir.
    const items = searchProducts(companyId, term, 30, {
      excludeKits: req.query.excludeKits === '1',
      includeParts: req.query.includeParts === '1',
    });
    res.json({
      items,
      // "Nenhum produto encontrado" e "nenhum produto cadastrado" pedem gestos
      // diferentes: o primeiro é procurar de outro jeito; o segundo é cadastrar.
      // Só se pergunta quando a busca voltou vazia.
      catalogoVazio: items.length === 0 ? catalogoSemProdutoAtivo(companyId) : false,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/products/:id', (req: AuthedRequest, res, next) => {
  try {
    /*
      O PDV lê a ficha para montar o item da venda com o preço vigente; o
      formulário e a alteração rápida leem a mesma coisa pela gestão.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const product = getProduct(companyId, String(req.params.id));
    if (!product) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

    // Preço vigente calculado pelo PricingService — o mesmo que o PDV e a
    // vitrine cobram. A tela mostra a promoção sem reimplementar a regra, e o
    // preço de tabela continua intocado no cadastro.
    const vigente = effectivePriceCents(
      companyId,
      String(product.id),
      Number(product.price_cents ?? 0),
      (product.category as string | null) ?? null,
    );

    res.json({
      ...product,
      effective_price_cents: vigente.priceCents,
      on_sale: vigente.onSale,
      stock: listStock(companyId, { search: String(product.internal_code ?? '') }).find(
        (s) => s.product_id === product.id,
      ) ?? null,
      /*
        AS FAIXAS VÊM NA FICHA (GAP-V04), e não numa segunda chamada.

        Quem lê esta rota é o PDV montando a linha da venda: sem as faixas
        aqui, o balcão só descobriria o preço de três DEPOIS de o cliente pegar
        três, ou não descobriria nunca. Lista vazia na esmagadora maioria dos
        produtos — o custo é uma consulta por leitura de ficha, do mesmo
        tamanho da do saldo que já está aqui.
      */
      price_tiers: listPriceTiers(companyId, String(product.id)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O CARRINHO REPRECIFICADO PARA UM CLIENTE.
 *
 * `{ customerId, items: [{ productId, quantity }] }` entra; sai o preço vigente
 * de cada produto e a condição comercial do cliente.
 *
 * NENHUMA REGRA DE PREÇO NASCE NO NAVEGADOR. A tela pergunta e desenha; quem
 * decide quanto custa é `PricingService`, o mesmo arquivo que a venda usa para
 * conferir. Se o PDV calculasse o desconto do revendedor por conta própria, a
 * primeira divergência apareceria como venda recusada por alçada num carrinho
 * que a tela mostrava dentro do limite — e o balcão não teria como saber quem
 * está certo.
 *
 * `customerId` ausente ou nulo é legítimo e significa "venda sem cliente": a
 * resposta volta com os preços normais e `priceTable: null`, que é exatamente o
 * que a tela precisa quando o operador TIRA o cliente do carrinho.
 *
 * Aberta ao balcão e à bancada porque os dois vendem: o PDV da loja e o
 * atendimento da oficina, que fecha OS com peça.
 */
coreRouter.post('/pricing/cart', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const corpo = (req.body ?? {}) as {
      customerId?: string | null;
      items?: { productId?: unknown; quantity?: unknown }[];
    };
    // Corpo sem itens não é erro: o carrinho vazio com cliente escolhido é o
    // primeiro estado do PDV, e a tela ainda quer saber qual é a tabela dele
    // para poder anunciá-la antes do primeiro bipe.
    const items = Array.isArray(corpo.items) ? corpo.items : [];
    res.json(
      priceCartForCustomer(
        companyId,
        corpo.customerId ? String(corpo.customerId) : null,
        items
          .filter((i) => i && i.productId)
          .map((i) => ({ productId: String(i.productId), quantity: Number(i.quantity ?? 1) })),
      ),
    );
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------- entrada de XML por e-mail

coreRouter.get('/mail/inbox', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    res.json(getInboxStatus(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/mail/inbox', (req: AuthedRequest, res, next) => {
  try {
    // Configurar origem de documento fiscal é decisão de gestor.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    // A empresa é a do TOKEN e vem por último: com o corpo espalhado depois,
    // um `companyId` no corpo gravava a caixa de outra empresa.
    const status = upsertInbox({ ...(req.body ?? {}), companyId });
    // A auditoria registra QUE a caixa mudou e qual o endereço — nunca a senha.
    recordAudit({
      companyId,
      userId,
      action: 'mail.inbox.upsert',
      entityType: 'mail_inbox',
      entityId: status.inbox?.id ?? 'novo',
      detail: {
        address: status.inbox?.address,
        host: status.inbox?.host,
        afterRead: status.inbox?.after_read,
        processedFolder: status.inbox?.processed_folder ?? null,
      },
    });
    res.status(201).json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * Testar conexão (GAP-PRD-128): entra, abre a pasta e sai, sem ler nota
 * nenhuma. É o passo seguinte a colar a senha de aplicativo — descobrir na
 * hora se o provedor aceitou. Gestor, como a configuração da caixa.
 */
coreRouter.post('/mail/inbox/test', (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const teste = await testarConexao(companyId);
      recordAudit({
        companyId,
        userId,
        action: 'mail.inbox.test',
        entityType: 'mail_inbox',
        entityId: teste.status.inbox?.id ?? 'caixa',
        detail: { ok: teste.ok, tipo: teste.tipo },
      });
      res.json(teste);
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.delete('/mail/inbox', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const status = removeInbox(companyId);
    recordAudit({
      companyId,
      userId,
      action: 'mail.inbox.remove',
      entityType: 'mail_inbox',
      entityId: 'removida',
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/** Estado da leitura automática. */
coreRouter.get('/mail/schedule', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    res.json(getSchedulerSettings(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/mail/schedule', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      setSchedule({
        companyId,
        userId,
        enabled: Boolean(req.body?.enabled),
        intervalMinutes: req.body?.intervalMinutes
          ? Number(req.body.intervalMinutes)
          : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/mail/messages', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    res.json({ items: listMailMessages(scope(req).companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Lê a caixa agora.
 *
 * Não movimenta estoque: cada XML encontrado vira uma nota EM CONFERÊNCIA,
 * exatamente como no upload manual.
 */
coreRouter.post('/mail/check', (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
      const { companyId, userId } = scope(req);
      const result = await checkInbox({ companyId, userId });
      recordAudit({
        companyId,
        userId,
        action: 'mail.inbox.check',
        entityType: 'mail_inbox',
        entityId: 'leitura',
        detail: {
          checked: result.checked,
          importados: result.results.filter((r) => r.outcome === 'importado').length,
          restantes: result.restantes,
        },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  })();
});

// ---------------------------------------------------------------- impressão

coreRouter.get('/print/readiness', (req: AuthedRequest, res, next) => {
  try {
    /*
      Diagnóstico de impressora: só a tela de Configurações → Impressoras
      consome, e ela é ROTA_GESTAO. Quem imprime no balcão usa `/print/jobs`.
    */
    abertaAo(req, 'escritorio');
    res.json(printReadiness(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/print/printers', (req: AuthedRequest, res, next) => {
  try {
    /*
      A lista de impressoras cadastradas alimenta a tela de configuração
      (ROTA_GESTAO). O cupom do balcão sai sem escolher impressora.
    */
    abertaAo(req, 'escritorio');
    res.json({ items: listPrinters(scope(req).companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/print/printers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    /*
      SÓ O CUPOM IMPRIME PELO AGENTE. O agente fala ESC/POS (a língua da
      térmica de cupom); etiqueta e A4 saem como HTML pelo driver, no diálogo
      do sistema. Uma impressora de etiqueta cadastrada "de agente" recebia a
      página de teste em ESC/POS (lixo numa Argox PPLA ou numa Zebra ZPL), o
      agente confirmava a escrita, e a prontidão passava a dizer "impressão
      direta" para uma impressora que nunca recebe etiqueta pelo agente.
    */
    if (req.body?.transport === 'agent' && req.body?.kind !== 'cupom') {
      throw new ApiError(
        'CORE_PRINTER_AGENT_ONLY_RECEIPT',
        'Só a impressora de cupom imprime pelo agente local. Etiqueta e A4 saem pelo driver da impressora, '
          + 'no diálogo de impressão do sistema: escolha "Navegador" em "Como imprime".',
        400,
      );
    }
    // A empresa vem da SESSÃO e vence o corpo: espalhado depois, um
    // `companyId` no corpo gravaria a impressora na operação de outra pessoa.
    const impressora = upsertPrinter({ ...(req.body ?? {}), companyId });
    recordAudit({
      companyId,
      userId,
      action: 'print.printer.save',
      entityType: 'printer',
      entityId: impressora.id,
      detail: {
        name: impressora.name,
        transport: impressora.transport,
        pdvTerminalId: impressora.pdv_terminal_id,
        agentDevice: impressora.agent_device,
      },
    });
    res.status(201).json(impressora);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/print/jobs', (req: AuthedRequest, res, next) => {
  try {
    /*
      A fila de impressão é do balcão: `lib/print.ts` roda no PDV e em
      Orçamentos. O espelho é o POST logo abaixo, que aceita caixa, gerentes,
      atendente e estoquista — e não o mecânico.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listPrintJobs(companyId, {
        documentId: req.query.documentId as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Enfileira uma impressão, já com o documento renderizado.
 *
 * Isto NÃO cria venda, nota, receita nem movimento de estoque — só papel.
 */
coreRouter.post('/print/jobs', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'operador_caixa_loja',
      'operador_caixa_oficina',
      'gerente_loja',
      'gerente_oficina',
      'atendente',
      'estoquista',
    );
    const { companyId, userId } = scope(req);
    const documentType = String(req.body?.documentType ?? '') as DocumentType;
    const documentId = String(req.body?.documentId ?? '');
    // A página de teste e o pulso da gaveta têm rota própria (gerência,
    // motivo, trilha). Por aqui, abrir a gaveta sem venda passaria sem nada.
    if (TIPOS_RESERVADOS.includes(documentType)) {
      throw new ApiError(
        'CORE_PRINT_TYPE_RESERVED',
        'Este documento tem rota própria: POST /print/printers/:id/test ou POST /print/drawer/open.',
        400,
      );
    }
    // O caixa de quem pede escolhe a impressora daquele computador (GAP-PRD-082).
    const caixa = caixaNoEscopo(req, { informado: req.body?.terminalId, doDispositivo: req.auth?.storeId });
    assertTerminalDaEmpresa(companyId, caixa);

    /*
      A IMPRESSORA ANTES DO PAPEL (auditoria do cupom, F-07). O documento era
      renderizado antes de a impressora ser escolhida, então a bobina de 58 mm
      cadastrada nunca chegava ao papel do navegador: saía sempre o de 80 mm,
      cortado ou encolhido. A escolha é a mesma do `createPrintJob`.
    */
    const impressora = impressoraDoDocumento(companyId, documentType, caixa, req.body?.printerId ?? null);
    const payload = renderDocument(companyId, documentType, documentId, {
      larguraMm: impressora?.paper_width_mm ?? null,
    });
    const job = createPrintJob({
      companyId,
      userId,
      documentType,
      documentId,
      payload,
      copies: req.body?.copies ? Number(req.body.copies) : 1,
      printerId: req.body?.printerId ?? null,
      pdvTerminalId: caixa,
      // Só vale pelo agente e só para cupom de venda: o motor ignora o resto.
      openDrawer: req.body?.openDrawer === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'print.job.create',
      entityType: 'print_job',
      entityId: job.id,
      detail: { documentType, documentId },
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

/**
 * Um job, pelo id — o PDV acompanha o cupom que mandou ao agente local até
 * ele dizer `printed` ou `failed` (GAP-PRD-082). Mesmo alcance da fila.
 */
coreRouter.get('/print/jobs/:id', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const job = getPrintJob(companyId, String(req.params.id));
    // O papel renderizado não viaja aqui: quem precisa dele pede /document.
    res.json({ ...job, payload: undefined });
  } catch (err) {
    next(err);
  }
});

/** Segunda via: novo job para o MESMO documento. Nada é refeito. */
coreRouter.post('/print/jobs/:id/reprint', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'operador_caixa_loja',
      'operador_caixa_oficina',
      'gerente_loja',
      'gerente_oficina',
      'atendente',
    );
    const { companyId, userId } = scope(req);
    const job = reprintJob({ companyId, userId, jobId: String(req.params.id) });
    recordAudit({
      companyId,
      userId,
      action: 'print.job.reprint',
      entityType: 'print_job',
      entityId: job.id,
      detail: { originalJobId: req.params.id, documentId: job.document_id },
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

/**
 * DESISTIR DO CUPOM QUE O AGENTE AINDA NÃO PEGOU — num passo só
 * (F-cupom-fiscal-09).
 *
 * O DEFEITO: a tela relia o job e, ainda `ready`, mandava `cancelled` por
 * `/status`. Entre a releitura e o cancelamento o agente podia pegar o cupom, e
 * a transição `printing → cancelled` é aceita: a tela dizia "cancelado para não
 * sair depois" e o papel saía — no meio do atendimento de outro cliente.
 *
 * Aqui o cancelamento é CONDICIONAL na própria instrução (`status = 'ready'` no
 * WHERE): ou o job ainda esperava o agente e passa a `cancelled`, ou nada muda
 * e a resposta é 409 `CORE_PRINT_JOB_TAKEN`, com o estado de agora — a tela só
 * diz "cancelado" com 200. Mesmo alcance de quem cria o job.
 */
coreRouter.post('/print/jobs/:id/desistir', (req: AuthedRequest, res, next) => {
  try {
    // Rota nova nasce pela capability: a mesma expressão de POST /print/jobs/:id/status.
    requireAnyCapability(req, 'pdv.sell', 'sales.view');
    const { companyId, userId } = scope(req);
    const jobId = String(req.params.id);
    // 404 para job de outra empresa ou inexistente — antes de qualquer escrita.
    getPrintJob(companyId, jobId);
    const motivo =
      String(req.body?.motivo ?? '').trim().slice(0, 300)
      || 'O agente local não pegou o cupom no prazo do balcão: cancelado para não sair depois.';
    const mudou = getConnection()
      .prepare(
        `UPDATE core_print_jobs
            SET status = 'cancelled', error = ?
          WHERE id = ? AND company_id = ? AND transport = 'agent' AND status = 'ready'`,
      )
      .run(motivo, jobId, companyId);
    const agora = getPrintJob(companyId, jobId);
    if (Number(mudou.changes) === 0) {
      const porEstado: Record<string, string> = {
        printing:
          'O agente do caixa já pegou este cupom e está imprimindo — aguarde o papel, não imprima de novo.',
        printed: 'O cupom já saiu na impressora do caixa.',
        failed: `O agente do caixa já tentou e não conseguiu imprimir: ${agora.error ?? 'sem motivo informado'}.`,
        cancelled: 'Este cupom já estava cancelado.',
      };
      throw new ApiError(
        'CORE_PRINT_JOB_TAKEN',
        agora.transport !== 'agent'
          ? 'Este cupom sai pela janela do navegador, e não pelo agente: não há pedido do agente para desistir.'
          : porEstado[agora.status] ?? `O cupom está em "${agora.status}" e não pode mais ser desistido.`,
        409,
        { status: agora.status, transport: agora.transport ?? null },
      );
    }
    recordAudit({
      companyId,
      userId,
      action: 'print.job.desistir',
      entityType: 'print_job',
      entityId: jobId,
      detail: { motivo, documentType: agora.document_type, documentId: agora.document_id },
    });
    res.json(agora);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/print/jobs/:id/status', (req: AuthedRequest, res, next) => {
  try {
    /*
      ESCREVE, mas só o estado do papel: `printing` antes de abrir a janela do
      navegador e `printed` quando o diálogo fecha. Quem cria o job é quem o
      avança, então o alcance é o mesmo do POST /print/jobs.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(
      advancePrintJob({
        companyId,
        jobId: String(req.params.id),
        status: req.body?.status,
        error: req.body?.error ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A VERDADE SOBRE A GAVETA, nesta operação (GAP-V55).
 *
 * O PDV pergunta isto para decidir se DESENHA o botão de abrir gaveta. A
 * resposta é `byCommand: false` sempre que não houver agente local registrado
 * — porque o navegador não abre gaveta, e um botão que às vezes não faz nada é
 * pior do que botão nenhum: o operador aprende a não confiar na tela.
 *
 * Alcance do balcão, e não da gestão: quem precisa da resposta é quem está no
 * caixa com o cliente na frente.
 */
coreRouter.get('/print/drawer', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    // A gaveta é DESTE caixa: a resposta depende da térmica e do agente dele.
    const caixa = caixaNoEscopo(req, { informado: req.query.terminalId, doDispositivo: req.auth?.storeId });
    assertTerminalDaEmpresa(companyId, caixa);
    res.json(prontidaoDaGaveta(companyId, caixa));
  } catch (err) {
    next(err);
  }
});

/**
 * ABRIR A GAVETA SEM VENDA, pelo agente local (GAP-PRD-082).
 *
 * Troco, sangria, conferência: o pulso vai para a térmica do caixa, e só se o
 * agente dela estiver no ar — sem ele, 409 com a frase do que falta (a gaveta
 * abre pela chave). Motivo obrigatório; o pedido e a abertura confirmada pelo
 * agente ficam na trilha. O pulso que o agente não retira em 1 minuto nunca
 * abre depois.
 */
coreRouter.post('/print/drawer/open', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    const motivo = String(req.body?.reason ?? '').trim();
    if (motivo.length < 3) {
      throw new ApiError(
        'CORE_DRAWER_REASON_REQUIRED',
        'Diga por que a gaveta vai abrir sem venda (ex.: "troco para o caixa 2").',
        400,
      );
    }
    const caixa = caixaNoEscopo(req, { informado: req.body?.terminalId, doDispositivo: req.auth?.storeId });
    assertTerminalDaEmpresa(companyId, caixa);
    const prontidao = prontidaoDaGaveta(companyId, caixa);
    if (!prontidao.byCommand || !prontidao.printerId) {
      throw new ApiError('CORE_DRAWER_NOT_BY_COMMAND', prontidao.message, 409);
    }
    const job = createPrintJob({
      companyId,
      userId,
      documentType: 'DRAWER_PULSE',
      documentId: caixa ?? companyId,
      payload: papelSimples('Abertura da gaveta sem venda', [`Motivo: ${motivo.slice(0, 300)}`]),
      printerId: prontidao.printerId,
      pdvTerminalId: caixa,
      openDrawer: true,
      reason: motivo.slice(0, 300),
      exigirAgente: true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'cash.drawer.open_requested',
      entityType: 'print_job',
      entityId: job.id,
      detail: { reason: motivo.slice(0, 300), pdvTerminalId: caixa, printerId: prontidao.printerId },
    });
    res.status(201).json({ ...job, payload: undefined });
  } catch (err) {
    next(err);
  }
});

/**
 * A PÁGINA DE TESTE da impressora de agente (GAP-PRD-082): a prova de que o
 * agente daquele caixa imprime nela. A tela de Impressoras só diz "impressão
 * direta" depois de o agente confirmar este job.
 */
coreRouter.post('/print/printers/:id/test', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const impressora = getPrinter(companyId, String(req.params.id));
    if (impressora.transport !== 'agent') {
      throw new ApiError(
        'CORE_PRINTER_NOT_AGENT',
        'A página de teste é da impressora de agente local. A de navegador imprime pela caixa de diálogo.',
        400,
      );
    }
    // A página de teste é ESC/POS: numa impressora de etiqueta ou A4 (cadastrada
    // antes da trava do cadastro) ela sairia como lixo e ainda "homologaria" a
    // impressora na prontidão.
    if (impressora.kind !== 'cupom') {
      throw new ApiError(
        'CORE_PRINTER_TEST_ONLY_RECEIPT',
        `"${impressora.name}" é de ${impressora.kind === 'etiqueta' ? 'etiqueta' : 'A4'}: ela imprime pelo driver, no diálogo do sistema, `
          + 'e não pelo agente. A página de teste do agente é só para a impressora de cupom. Edite a impressora e escolha "Navegador".',
        400,
      );
    }
    const job = createPrintJob({
      companyId,
      userId,
      documentType: 'PRINTER_TEST',
      documentId: impressora.id,
      payload: papelSimples('Página de teste', [`Impressora: ${impressora.name}`]),
      printerId: impressora.id,
      exigirAgente: true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'print.printer.test',
      entityType: 'printer',
      entityId: impressora.id,
      detail: { jobId: job.id },
    });
    res.status(201).json({ ...job, payload: undefined });
  } catch (err) {
    next(err);
  }
});

/**
 * O MESMO documento, na língua da impressora térmica (GAP-V55).
 *
 * `/document` devolve HTML — o que o navegador imprime. Este devolve ESC/POS:
 * o fluxo de bytes que uma térmica executa, com corte e, quando pedido, o
 * PULSO DA GAVETA.
 *
 * Para quem é: o agente local (`core_printers.transport = 'agent'`), uma
 * impressora de rede na porta 9100, ou um driver "genérico / somente texto".
 * NÃO é para o navegador — ele não tem porta de impressora, e mandar estes
 * bytes para a caixa de diálogo imprimiria os comandos como texto.
 *
 * O conteúdo sai das MESMAS tabelas do cupom HTML: duas vias do mesmo papel
 * que divergissem seriam duas verdades sobre a mesma venda.
 */
coreRouter.get('/print/jobs/:id/escpos', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const job = getPrintJob(companyId, String(req.params.id));
    if (job.document_type !== 'PDV_RECEIPT' && job.document_type !== 'SALE_RECEIPT') {
      // Etiqueta, OS e DANFE têm layout próprio e não cabem em coluna de
      // cupom. Fingir que cabem entregaria papel ilegível.
      throw new ApiError(
        'CORE_PRINT_ESCPOS_UNSUPPORTED',
        `Não há cupom térmico para ${job.document_type}.`,
        400,
      );
    }
    const bytes = cupomEscPosDaVenda(companyId, job.document_id, {
      // A gaveta só é pedida quando quem chama pede: cupom de segunda via não
      // deve abrir gaveta nenhuma.
      abrirGaveta: req.query.gaveta === '1',
      colunas: req.query.colunas === '32' ? 32 : 48,
    });
    res.type('application/octet-stream').send(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
});

/** Documento pronto para o navegador imprimir ou salvar em PDF. */
coreRouter.get('/print/jobs/:id/document', (req: AuthedRequest, res, next) => {
  try {
    /*
      O HTML que o navegador imprime. Mesmo alcance da fila: é a janela que o
      PDV abre logo depois de enfileirar.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const job = getPrintJob(companyId, String(req.params.id));
    const html = job.payload ?? renderDocument(companyId, job.document_type, job.document_id);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ categorias e marcas

coreRouter.get('/taxonomy', (req: AuthedRequest, res, next) => {
  try {
    /*
      Categorias e marcas alimentam o cadastro de produto e a tela de
      Categorias/Marcas, ambas ROTA_GESTAO.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({
      categories: listCategories(companyId),
      brands: listBrands(companyId),
      // Valores escritos nos produtos que ainda não estão na lista.
      orphans: listOrphanValues(companyId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/taxonomy/categories', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const categoria = upsertCategory({ companyId, ...(req.body ?? {}) });
    recordAudit({
      companyId,
      userId,
      action: req.body?.id ? 'taxonomy.category.update' : 'taxonomy.category.create',
      entityType: 'category',
      entityId: categoria.id,
      detail: { name: categoria.name },
    });
    res.status(201).json(categoria);
  } catch (err) {
    next(err);
  }
});

/** Une duas categorias e migra os produtos da origem. */
coreRouter.post('/taxonomy/categories/merge', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const destino = mergeCategory({
      companyId,
      sourceId: String(req.body?.sourceId ?? ''),
      targetId: String(req.body?.targetId ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'taxonomy.category.merge',
      entityType: 'category',
      entityId: destino.id,
      detail: { sourceId: req.body?.sourceId, targetName: destino.name },
    });
    res.json(destino);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/taxonomy/categories/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    removeCategory(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'taxonomy.category.remove',
      entityType: 'category',
      entityId: String(req.params.id),
    });
    res.json({ categories: listCategories(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/taxonomy/brands', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const marca = upsertBrand({ companyId, ...(req.body ?? {}) });
    recordAudit({
      companyId,
      userId,
      action: req.body?.id ? 'taxonomy.brand.update' : 'taxonomy.brand.create',
      entityType: 'brand',
      entityId: marca.id,
      detail: { name: marca.name },
    });
    res.status(201).json(marca);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/taxonomy/brands/merge', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const destino = mergeBrand({
      companyId,
      sourceId: String(req.body?.sourceId ?? ''),
      targetId: String(req.body?.targetId ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'taxonomy.brand.merge',
      entityType: 'brand',
      entityId: destino.id,
      detail: { sourceId: req.body?.sourceId, targetName: destino.name },
    });
    res.json(destino);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/taxonomy/brands/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    removeBrand(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'taxonomy.brand.remove',
      entityType: 'brand',
      entityId: String(req.params.id),
    });
    res.json({ brands: listBrands(companyId) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- auxiliares do catálogo
//
// Unidade, grupo tributário, alíquota e tabela de preços numa chamada só: a
// tela de produto precisa dos quatro para montar os seletores, e quatro
// requisições em sequência deixariam o formulário abrir pela metade.

coreRouter.get('/catalog/aux', (req: AuthedRequest, res, next) => {
  try {
    /*
      Unidade, grupo tributário, alíquota e tabela de preço: os seletores do
      cadastro. Tela de Auxiliares do catálogo, ROTA_GESTAO.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({
      units: listUnits(companyId),
      taxGroups: listTaxGroups(companyId),
      taxRates: listTaxRates(companyId),
      priceTables: listPriceTables(companyId),
    });
  } catch (err) {
    next(err);
  }
});

const AUX_EDITORES = ['gerente_loja', 'gerente_oficina', 'estoquista'] as const;

coreRouter.post('/catalog/units', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const unidade = upsertUnit(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: req.body?.id ? 'catalog.unit.update' : 'catalog.unit.create',
      entityType: 'unit',
      entityId: unidade.id,
      detail: { code: unidade.code, decimals: unidade.decimals },
    });
    res.status(201).json(unidade);
  } catch (err) {
    next(err);
  }
});

/*
  A ETIQUETA DA BALANÇA (auditoria da Preço Justo, D-pdv-teclado-16).

  A busca do PDV sabe ler a etiqueta que a balança imprime (EAN-13 com prefixo
  21–29, PLU e peso ou preço embutidos) — mas só depois que a operação DECLARA o
  formato. O prefixo 20 é o dos códigos internos que o próprio sistema gera, e
  ler "todo 2…" como balança transformaria a etiqueta de um produto qualquer em
  peso. Sem declaração, a busca é a de sempre.
*/
coreRouter.get('/catalog/scale-label', (req: AuthedRequest, res, next) => {
  try {
    // Rota nova nasce pela capability (catraca das guardas legadas): products.view
    // alcança exatamente o escritório que abertaAo('escritorio') alcançaria.
    requireCapability(req, 'products.view');
    const { companyId } = scope(req);
    res.json({ config: lerConfigDaEtiquetaDaBalanca(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/catalog/scale-label', (req: AuthedRequest, res, next) => {
  try {
    // products.manage: os mesmos editores do catálogo auxiliar (AUX_EDITORES e os donos).
    requireCapability(req, 'products.manage');
    const { companyId, userId } = scope(req);
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    // { config: null } desliga a leitura; o resto é a declaração (validada no serviço).
    const desligar = Object.prototype.hasOwnProperty.call(corpo, 'config') && corpo.config === null;
    const config = gravarConfigDaEtiquetaDaBalanca(companyId, desligar ? null : corpo, userId);
    recordAudit({
      companyId,
      userId,
      action: 'catalog.scale_label.set',
      entityType: 'scale_label',
      entityId: companyId,
      detail: { config },
    });
    res.json({ config });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/units/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    deleteUnit(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'catalog.unit.delete',
      entityType: 'unit',
      entityId: String(req.params.id),
    });
    res.json({ units: listUnits(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * A LISTA DE GRUPOS TRIBUTÁRIOS, sozinha (GAP-V01).
 *
 * `/catalog/aux` já a devolve, junto de unidades, alíquotas e tabelas de preço
 * — e continua sendo a chamada certa para a tela de Auxiliares, que precisa
 * das quatro. O cadastro do PRODUTO precisa de UMA: pedir as quatro para
 * desenhar um seletor traz a lista inteira de tabelas de preço e de alíquotas
 * a cada abertura do formulário, e o cadastro abre muito mais vezes do que os
 * auxiliares.
 *
 * A resposta é o MESMO `listTaxGroups` da outra rota: uma leitura, dois
 * caminhos. Duas consultas diferentes divergiriam no dia em que uma delas
 * passasse a filtrar por `active`.
 */
coreRouter.get('/catalog/tax-groups', (req: AuthedRequest, res, next) => {
  try {
    // O mesmo alcance de `/catalog/aux`: é seletor de cadastro, ROTA_GESTAO.
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ taxGroups: listTaxGroups(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/catalog/tax-groups', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const grupo = upsertTaxGroup(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: req.body?.id ? 'catalog.tax_group.update' : 'catalog.tax_group.create',
      entityType: 'tax_group',
      entityId: grupo.id,
      // O IPI entra no detalhe porque ele MUDA O XML de todo produto do grupo
      // (GAP-V08): quem ligou o destaque e quando é pergunta de fiscalização.
      detail: {
        code: grupo.code,
        regime: grupo.regime,
        cstIpi: grupo.cst_ipi,
        ipiRateCode: grupo.ipi_rate_code,
      },
    });
    res.status(201).json(grupo);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/tax-groups/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    deleteTaxGroup(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'catalog.tax_group.delete',
      entityType: 'tax_group',
      entityId: String(req.params.id),
    });
    res.json({ taxGroups: listTaxGroups(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/catalog/tax-rates', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId } = scope(req);
    res.status(201).json(upsertTaxRate(companyId, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/tax-rates/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId } = scope(req);
    deleteTaxRate(companyId, String(req.params.id));
    res.json({ taxRates: listTaxRates(companyId) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------- campos personalizados (V07)
//
// A DEFINIÇÃO é da operação; o VALOR é do produto. As duas metades vivem em
// rotas diferentes de propósito: criar "Voltagem" é decisão de quem organiza o
// catálogo, e preenchê-la é trabalho de quem cadastra o produto — e são
// pessoas e momentos diferentes.

coreRouter.get('/catalog/custom-fields', (req: AuthedRequest, res, next) => {
  try {
    // Mesmo alcance dos outros auxiliares: é seletor de cadastro.
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ fields: listCustomFields(companyId, String(req.query.entity ?? 'product')) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/catalog/custom-fields', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const campo = upsertCustomField(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: req.body?.id ? 'catalog.custom_field.update' : 'catalog.custom_field.create',
      entityType: 'custom_field',
      entityId: campo.id,
      detail: { code: campo.code, label: campo.label, kind: campo.kind },
    });
    res.status(201).json(campo);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/custom-fields/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    deleteCustomField(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'catalog.custom_field.delete',
      entityType: 'custom_field',
      entityId: String(req.params.id),
    });
    res.json({ fields: listCustomFields(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/catalog/price-tables', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.status(201).json(upsertPriceTable(companyId, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/price-tables/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    deletePriceTable(companyId, String(req.params.id));
    res.json({ priceTables: listPriceTables(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Os preços fixados da tabela — a metade de LER do gesto de fixar.
 *
 * Mesmo alcance de `/catalog/aux`: é a mesma tela (Auxiliares do catálogo,
 * ROTA_GESTAO) que lista as tabelas e agora mostra o que está fixado em cada
 * uma. Ler o combinado não é mais sensível do que ler o percentual da tabela,
 * que já viaja na mesma resposta.
 */
coreRouter.get('/catalog/price-tables/:id/items', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listPriceTableItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/catalog/price-tables/:id/items/:productId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    setPriceTableItem(
      companyId,
      String(req.params.id),
      String(req.params.productId),
      // SEM `?? 0`: corpo sem preço virava "fixado em R$ 0,00" — produto de
      // graça no cupom, sem erro para ninguém. `Number(undefined)` é NaN, e o
      // serviço recusa NaN com 400 nomeado.
      Number(req.body?.priceCents),
    );
    res.json({ items: listPriceTableItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/catalog/price-tables/:id/items/:productId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    removePriceTableItem(companyId, String(req.params.id), String(req.params.productId));
    // A lista volta atualizada pela mesma razão do PUT: a tela re-renderiza o
    // que o servidor afirma, não o que ela acha que aconteceu.
    res.json({ items: listPriceTableItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Clonar produto.
 *
 * As decisões de o que vai e o que não vai estão em `ProductCloneService`, com
 * o porquê de cada uma. Aqui só o caminho HTTP e o rastro.
 */
coreRouter.post('/products/:id/clone', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const clone = cloneProduct(companyId, String(req.params.id), { name: req.body?.name });
    recordAudit({
      companyId,
      userId,
      action: 'catalog.product.clone',
      entityType: 'product',
      entityId: String(clone.id),
      detail: { origem: String(req.params.id), internalCode: clone.internal_code },
    });
    res.status(201).json(clone);
  } catch (err) {
    next(err);
  }
});

/**
 * CONVERTER O TIPO DO PRODUTO — mercadoria de revenda <-> peça de oficina.
 *
 * POR QUE UMA ROTA PRÓPRIA, E NÃO SÓ O PUT DO CADASTRO
 *
 * O PUT passou a gravar `kind` e `workshop_id` (era o defeito central desta
 * rodada: ele devolvia 200 e não gravava nenhum dos dois). Mas trocar o tipo
 * não é editar um campo: o produto SAI da vitrine, PERDE o destaque e o saldo
 * dele muda de dono na mesma hora. Quem faz isso precisa ver a conta antes de
 * confirmar e depois de feito — e é `ResultadoDoTipo.efeitos` que carrega essa
 * conta, que um PUT genérico não teria como devolver.
 *
 * QUEM PODE
 *
 * `AUX_EDITORES` — gerente de loja, gerente de oficina e estoquista (mais
 * `admin_geral` e `gestor`, que o `requireProfile` já libera em tudo). É a
 * interseção CONFERIDA no roteador do front: converter é decisão de quem
 * cadastra o produto (`/sistema/produtos/:id`) E de quem recebe a nota que traz
 * a peça (`/sistema/compras/entrada-notas`), e as duas telas são `ROTA_GESTAO`.
 *
 * `operador_caixa_loja` e `operador_caixa_oficina` NÃO entram, embora apareçam
 * nas rotas de produto e de entrada de nota do servidor: pelo roteador, os dois
 * perfis vivem no ambiente `pdv`, e `ROTA_GESTAO` é só `['gestao']`. Incluí-los
 * daria permissão a quem não alcança nenhuma das duas telas.
 */
coreRouter.post('/products/:id/tipo', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const productId = String(req.params.id);
    const kind = String(req.body?.kind ?? '').trim();

    if (kind !== 'part' && kind !== 'retail') {
      throw new ApiError(
        'CORE_INVALID_PAYLOAD',
        'Informe o tipo: "part" (peça de oficina) ou "retail" (mercadoria de revenda).',
        400,
      );
    }

    const resultado =
      kind === 'part'
        ? converterParaPeca({
            companyId,
            productId,
            workshopId: String(req.body?.workshopId ?? '').trim(),
            userId,
          })
        : converterParaRevenda({ companyId, productId, userId });

    // O rastro guarda os EFEITOS, não só o novo tipo: seis meses depois, a
    // pergunta que se faz é "quem tirou este item da vitrine", e a resposta
    // precisa estar aqui.
    recordAudit({
      companyId,
      userId,
      action: kind === 'part' ? 'product.kind.to_part' : 'product.kind.to_retail',
      entityType: 'product',
      entityId: productId,
      detail: {
        workshopId: resultado.workshopId,
        workshopName: resultado.workshopName,
        ...resultado.efeitos,
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- códigos de barras e kit por produto

coreRouter.get('/products/:id/barcodes', (req: AuthedRequest, res, next) => {
  try {
    /*
      Só o formulário de produto lê os códigos de barras cadastrados. As
      escritas ao lado exigem AUX_EDITORES, que é mais estreito ainda.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ barcodes: listProductBarcodes(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products/:id/barcodes', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId } = scope(req);
    res
      .status(201)
      .json({ barcodes: addProductBarcode(companyId, String(req.params.id), req.body?.barcode) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/products/:id/barcodes/:barcode', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId } = scope(req);
    res.json({
      barcodes: removeProductBarcode(
        companyId,
        String(req.params.id),
        String(req.params.barcode),
      ),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/products/:id/kit', (req: AuthedRequest, res, next) => {
  try {
    /*
      A composição do kit e o custo somado. O PDV vende o kit pelo preço do
      produto e nunca pede os componentes — quem os pede é o formulário.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const kitId = String(req.params.id);
    res.json({
      components: listKitComponents(companyId, kitId),
      costCents: kitCostCents(companyId, kitId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/products/:id/kit', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    const kitId = String(req.params.id);
    const entrada = Array.isArray(req.body?.components) ? req.body.components : [];
    const components = setKitComponents(
      companyId,
      kitId,
      entrada.map((c: Record<string, unknown>) => ({
        componentId: String(c?.componentId ?? ''),
        quantity: Number(c?.quantity ?? 0),
      })),
    );
    recordAudit({
      companyId,
      userId,
      action: 'catalog.kit.set',
      entityType: 'product',
      entityId: kitId,
      detail: { components: components.length },
    });
    res.json({ components, costCents: kitCostCents(companyId, kitId) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- faixa de preço por quantidade
//
// GAP-V04. "3 por R$ 10" e o atacado por volume para quem chega no balcão sem
// cadastro nenhum. A tabela de preço da casa é por CLIENTE e exige alguém
// identificado e vinculado; a faixa é do PRODUTO e vale para qualquer um.

coreRouter.get('/products/:id/price-tiers', (req: AuthedRequest, res, next) => {
  try {
    /*
      O BALCÃO LÊ TAMBÉM, e não só a gestão: o operador precisa poder dizer ao
      cliente "levando três sai por R$ 10 cada" antes de ele levar três. Negar
      a leitura ao PDV faria a oferta existir e ninguém saber dela.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({ tiers: listPriceTiers(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/products/:id/price-tiers', (req: AuthedRequest, res, next) => {
  try {
    /*
      ESCREVER É DECISÃO DE PREÇO, e por isso não tem a largura do cadastro:
      a faixa muda quanto a loja cobra de TODO cliente que levar aquela
      quantidade, sem passar por alçada nenhuma (ela entra no denominador, como
      a tabela de preço). Os mesmos perfis que criam tabela de preço.
    */
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const productId = String(req.params.id);
    const minQuantity = Number(req.body?.minQuantity ?? 0);
    const priceCents = Number(req.body?.priceCents ?? 0);
    const tiers = setPriceTier(companyId, productId, minQuantity, priceCents);
    recordAudit({
      companyId,
      userId,
      action: 'catalog.price_tier.set',
      entityType: 'product',
      entityId: productId,
      detail: { minQuantity, priceCents },
    });
    res.json({ tiers });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/products/:id/price-tiers/:minQuantity', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const productId = String(req.params.id);
    const minQuantity = Number(req.params.minQuantity);
    const tiers = removePriceTier(companyId, productId, minQuantity);
    recordAudit({
      companyId,
      userId,
      action: 'catalog.price_tier.remove',
      entityType: 'product',
      entityId: productId,
      detail: { minQuantity },
    });
    res.json({ tiers });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------ campos personalizados de UM produto

coreRouter.get('/products/:id/custom-fields', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ values: listCustomValues(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/products/:id/custom-fields', (req: AuthedRequest, res, next) => {
  try {
    /*
      Preencher a voltagem de um produto é trabalho de quem cadastra. O caixa
      da LOJA saiu (PJ-CAIXA: o login do PDV da Preço Justo não administra
      produto); o da oficina segue. Quem NÃO pode é criar o campo — isso é
      `/catalog/custom-fields`.
    */
    requireProfile(
      req,
      'gerente_loja',
      'gerente_oficina',
      'estoquista',
      'operador_caixa_oficina',
    );
    const { companyId, userId } = scope(req);
    const productId = String(req.params.id);
    /*
      O QUE MUDOU, DE → PARA, e só se mudou (A-produto-18).

      A trilha gravava `fields: ['VOLTAGEM']` — os códigos —, e o formulário
      manda os campos próprios em TODO Salvar do produto: cada salvar punha no
      Histórico uma entrada com linhas ": — → —". Agora o registro tem o mesmo
      formato do `product.update` (a voltagem é atributo do produto como o
      preço), e salvar sem mudar nada não grava nada.
    */
    const antes = listCustomValues(companyId, productId);
    const values = setCustomValues(companyId, productId, req.body?.values ?? {});
    const mudancas = diferencasDosCamposProprios(antes, values);
    if (mudancas.length > 0) {
      recordAudit({
        companyId,
        userId,
        action: 'product.custom_fields.set',
        entityType: 'product',
        entityId: productId,
        detail: { fields: mudancas },
      });
    }
    res.json({ values });
  } catch (err) {
    next(err);
  }
});

/**
 * O HISTÓRICO DO PRODUTO — o que mudou, de quanto para quanto, por quem (V05).
 *
 * A trilha central já registrava `product.update` desde sempre, e SEM detalhe:
 * "houve uma alteração" e nada mais. Vinte delas no banco real, nenhuma
 * respondendo "quem baixou o preço de 39,90 para 29,90".
 *
 * A rota é aberta ao ESCRITÓRIO, e não aos donos do grupo: a AuditoriaPage é
 * restrita por desenho (ela cruza empresa e mostra tudo), mas quem cuida do
 * catálogo precisa poder auditar o próprio catálogo sem pedir acesso à trilha
 * inteira. O recorte é o mais estreito possível — um produto, desta empresa.
 */
coreRouter.get('/products/:id/history', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: productHistory(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Precificação: a conta dos dois lados.
 *
 * A tela precisa ir e voltar — digitar o preço mostra markup e margem, digitar
 * o markup calcula o preço. Fazer essa conta no navegador criaria uma segunda
 * implementação da mesma regra, e as duas divergiriam no arredondamento.
 */
coreRouter.post('/catalog/pricing/preview', (req: AuthedRequest, res, next) => {
  try {
    /*
      É POST porque a conta vai e volta com vários campos, mas NÃO ESCREVE
      nada: devolve markup e margem do que o formulário está digitando. Tratá-la
      como escrita e exigir gerente tiraria a conta de quem cadastra produto.
    */
    abertaAo(req, 'escritorio');
    scope(req);
    const custo = Number(req.body?.costCents ?? 0);
    const minimos = {
      minPriceCents: req.body?.minPriceCents == null ? null : Number(req.body.minPriceCents),
      minMarkupPercent:
        req.body?.minMarkupPercent == null ? null : Number(req.body.minMarkupPercent),
      minMarginPercent:
        req.body?.minMarginPercent == null ? null : Number(req.body.minMarginPercent),
    };

    // Precedência: o preço explícito manda. Se não veio, calcula pelo markup;
    // se nem isso, pela margem. Aceitar os três ao mesmo tempo obrigaria a
    // inventar um desempate que a tela não tem como explicar.
    let preco = req.body?.priceCents == null ? null : Number(req.body.priceCents);
    if (preco == null && req.body?.markupPercent != null) {
      preco = precoPorMarkup(custo, Number(req.body.markupPercent));
    }
    if (preco == null && req.body?.marginPercent != null) {
      preco = precoPorMargem(custo, Number(req.body.marginPercent));
      if (preco == null) {
        throw new ApiError(
          'CORE_PRICING_MARGIN',
          'Margem de 100% ou mais é impossível: o preço seria infinito.',
          400,
        );
      }
    }
    if (preco == null) {
      throw new ApiError(
        'CORE_PRICING_INPUT',
        'Informe preço, markup ou margem.',
        400,
      );
    }

    res.json({ priceCents: preco, ...avaliarPreco(custo, preco, minimos) });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------- fotos do produto

coreRouter.get('/products/:id/images', (req: AuthedRequest, res, next) => {
  try {
    /*
      A galeria do produto é montada no formulário (ROTA_GESTAO). A vitrine
      pública tem rota própria, sem sessão.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listProductImages(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products/:id/images', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const image = addProductImage({
      companyId,
      productId: String(req.params.id),
      dataUrl: String(req.body?.dataUrl ?? ''),
      fileName: req.body?.fileName ?? null,
      mimeType: req.body?.mimeType,
    });
    recordAudit({
      companyId,
      userId,
      action: 'product.image.add',
      entityType: 'product',
      entityId: String(req.params.id),
      detail: { imageId: image.id, bytes: image.byte_size },
    });
    res.status(201).json(image);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products/:id/images/:imageId/primary', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    setPrimaryImage(companyId, String(req.params.id), String(req.params.imageId));
    res.json({ items: listProductImages(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/products/:id/images/:imageId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    removeProductImage(companyId, String(req.params.id), String(req.params.imageId));
    recordAudit({
      companyId,
      userId,
      action: 'product.image.remove',
      entityType: 'product',
      entityId: String(req.params.id),
      detail: { imageId: req.params.imageId },
    });
    res.json({ items: listProductImages(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products/:id/images/reorder', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      items: reorderProductImages(
        companyId,
        String(req.params.id),
        (req.body?.orderedIds ?? []) as string[],
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- grade (variantes)

coreRouter.get('/products/:id/variants', (req: AuthedRequest, res, next) => {
  try {
    /** Grade de variações: existe dentro do formulário de produto. */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json(variantStock(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products/:id/variants', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const result = generateVariants({
      companyId,
      productId: String(req.params.id),
      axes: (req.body?.axes ?? {}) as Record<string, string[]>,
      priceByCombo: req.body?.priceByCombo,
    });
    recordAudit({
      companyId,
      userId,
      action: 'product.variants.generate',
      entityType: 'product',
      entityId: String(req.params.id),
      detail: { created: result.created.length, existing: result.existing.length },
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/products', (req: AuthedRequest, res, next) => {
  try {
    /*
      O CAIXA DA LOJA SAIU (PJ-CAIXA, regra do dono para a Preço Justo): o
      login do PDV opera o caixa e não administra produto. Com o próprio token
      ele criava produto com qualquer preço, custo e dado fiscal — até publicado
      na loja online. O produto que não está no cadastro vai para o gestor.

      O caixa da OFICINA continua (GAP-PRD-052: a peça nova no balcão da
      oficina é fluxo modelado e fora do escopo desta regra). O `PUT` já era
      fechado aos dois — ver o comentário da rota logo abaixo.
    */
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    // Quem cadastra pela tela ou pela API escolhe a unidade do vocabulário da
    // loja (A-produto-26); a importação de XML segue com a do fornecedor.
    const product = createProduct(companyId, req.body ?? {}, undefined, { unidadeDoVocabulario: true });
    recordAudit({
      companyId,
      userId,
      action: 'product.create',
      entityType: 'product',
      entityId: String(product.id),
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

/**
 * EDITAR O CADASTRO — e SÓ o cadastro.
 *
 * `kind` e `workshopId` diferentes do que está gravado são recusados em
 * `atualizarProduto` com `CORE_PRODUCT_KIND_BY_ROUTE`, apontando a rota de
 * conversão. Mandar o valor que já está lá (o formulário manda o objeto inteiro)
 * passa e não escreve nada.
 *
 * ## Os caixas saíram daqui (GAP-PRD-052)
 *
 * Esta rota aceitava os dois `operador_caixa_*` com o argumento de que
 * "corrigir preço, código de barras e descrição é trabalho de balcão". Nenhuma
 * tela do balcão chama esta rota — as três que chamam (Produtos, formulário e
 * Alteração rápida) são `ROTA_GESTAO`, e `GET /products` já recusa o caixa. O
 * que sobrava era a porta pela API: o caixa, com o próprio token, baixava o
 * preço de TABELA e vendia pelo preço novo sem pedir liberação — a alçada de
 * desconto mede a concessão contra o preço vigente, e o vigente já era o
 * baixo. O custo, que alimenta CMV e margem, ia junto. Desconto passa pela
 * alçada (`SalePolicyService` + `POST /authorizations`); preço de tabela de um
 * item que já existe é de quem responde pelo cadastro.
 */
coreRouter.put('/products/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...AUX_EDITORES);
    const { companyId, userId } = scope(req);
    /*
      A FOTOGRAFIA DE ANTES — é ela que faz a trilha dizer O QUE mudou (V05).

      Esta rota gravava `product.update` sem `detail` nenhum: sabia-se que
      houve alteração, nunca de quanto para quanto. No banco real são vinte
      registros assim, e a pergunta "quem baixou o preço de 39,90 para 29,90"
      não tem resposta em nenhum deles.

      A leitura acontece AQUI, e não dentro de `updateProduct`, porque o serviço
      tem vários chamadores (a publicação em massa, a alteração rápida, a
      importação de planilha) e cada um grava a própria auditoria com o próprio
      nome de ação. Gravar lá dentro daria dois registros para o mesmo fato.

      É uma consulta a mais por salvar de produto, e ela paga por si: sem o
      "antes", o diff teria de ser montado sobre o CORPO da requisição — que
      traz o formulário inteiro toda vez e ainda não passou pela normalização
      do servidor. Listaria quarenta alterações onde houve uma, e erraria o
      valor final de várias.
    */
    const antes = getProduct(companyId, String(req.params.id));
    const product = updateProduct(companyId, String(req.params.id), req.body ?? {}, {
      unidadeDoVocabulario: true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'product.update',
      entityType: 'product',
      entityId: String(req.params.id),
      // Lista VAZIA é resposta legítima e não erro: quem clicou em Salvar sem
      // mexer em nada fez exatamente isso, e a trilha diz isso.
      detail: { fields: diferencasDoProduto(antes, product) },
    });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

/**
 * EXCLUIR O PRODUTO — só o que nunca aconteceu (frente PRODUTO).
 *
 * Sem histórico, a exclusão é física e controlada: variantes, códigos, fotos
 * (e os arquivos), preços, campos e o de-para saem juntos; a trilha e o
 * tombstone da central são gravados DENTRO de `excluirProduto`, na mesma
 * transação — por isso esta rota não grava auditoria própria. Com histórico,
 * 409 `CORE_PRODUCT_HAS_HISTORY` com a contagem e a saída: inativar.
 *
 * O alcance é o par de gerência que responde pelo catálogo, mais estreito que
 * o do PUT: o estoquista edita e inativa, mas apagar um cadastro é decisão de
 * quem responde por ele. O RBAC por capacidades da próxima rodada remapeia.
 */
coreRouter.delete('/products/:id', (req: AuthedRequest, res, next) => {
  try {
    // Guarda no mecanismo novo (catraca do RBAC): products.catalog.admin é, nos
    // modelos de sistema, exatamente o par de gerência + os donos do grupo.
    requireCapability(req, 'products.catalog.admin');
    const { companyId, userId } = scope(req);
    const excluido = excluirProduto({ companyId, productId: String(req.params.id), userId });
    res.json({ deleted: true, ...excluido });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- estoque

coreRouter.get('/stock', (req: AuthedRequest, res, next) => {
  try {
    /*
      O saldo por produto aparece em Estoque, Locais, Unidades e no formulário —
      as quatro ROTA_GESTAO. O balcão não consulta saldo: ele vende, e a venda
      é que baixa.
    */
    abertaAo(req, 'escritorio');
    const { companyId, profiles } = scope(req);
    const items = listStock(companyId, {
      lowOnly: req.query.low === 'true',
      search: req.query.search as string | undefined,
    });
    /*
      QUEM VÊ O CUSTO É DECISÃO DO DONO (GAP-PRD-165). Padrão seguro: só a
      gerência. Para o resto do escritório o custo e o valor SAEM da resposta —
      no servidor, como o `hideCost` do mecânico em `/stock/movements` —, e o
      saldo, o reservado e o mínimo continuam: são o trabalho de quem arruma a
      prateleira.
    */
    if (!veCustoDoEstoque(companyId, profiles)) {
      res.json({
        items: items.map((i) => ({ ...i, cost_cents: null, value_cents: null, valuation_cost_cents: null })),
        custoOculto: true,
      });
      return;
    }
    res.json({ items, custoOculto: false });
  } catch (err) {
    next(err);
  }
});

/**
 * Quanto vale o estoque — saldo × custo do cadastro, somado no servidor.
 *
 * Nenhuma superfície respondia isso: o stub de BI que prometia
 * `inventoryValueCents` foi removido por responder zero hardcoded, e quem
 * precisava do número para fechamento ou seguro somava fora do sistema. O
 * custo é o do CADASTRO (decisão documentada em `stockValuation`), e o
 * resultado é centavo inteiro, arredondado por item.
 */
coreRouter.get('/stock/valuation', (req: AuthedRequest, res, next) => {
  try {
    /*
      O mesmo alcance de `/stock`, que já entrega `cost_cents` linha a linha ao
      escritório: quem vê o custo de cada item pode ver a soma. A bancada fica
      de fora pelo mesmo motivo do `hideCost` — quanto a empresa pagou não é
      assunto do mecânico.
    */
    abertaAo(req, 'escritorio');
    const { companyId, profiles } = scope(req);
    const valor = stockValuation(companyId);
    const politica = politicaDeGestao(companyId);
    // A régua e a confirmação do contador viajam junto (GAP-PRD-166): a tela diz
    // COMO o número foi feito, e se a régua ainda espera o contador.
    const regua = {
      regua: valor.regua ?? politica.reguaDeValorizacao,
      reguaConfirmadaPor: politica.reguaConfirmadaPor,
      reguaConfirmadaEm: politica.reguaConfirmadaEm,
      semCustoNoRazao: valor.semCustoNoRazao ?? 0,
    };
    // O total segue o mesmo recorte do custo por linha (GAP-PRD-165).
    if (!veCustoDoEstoque(companyId, profiles)) {
      res.json({ totalCents: null, produtosComSaldo: valor.produtosComSaldo, oculto: true, ...regua });
      return;
    }
    res.json({ ...valor, oculto: false, ...regua });
  } catch (err) {
    next(err);
  }
});

/**
 * A CONFERÊNCIA DE RESERVAS (GAP-PRD-087) — o diagnóstico que não tinha leitor.
 *
 * `inventoryReconciliation` classificava a reserva presa como crítica e ninguém
 * podia chamá-la. O mesmo alcance de `/stock`: quem vê "Reservado 1" na posição
 * de estoque precisa poder perguntar por quê — e a resposta traz as referências
 * do razão que reservaram e não soltaram, com a situação de cada documento.
 */
coreRouter.get('/stock/reconciliation', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json(conferirReservas(companyId));
  } catch (err) {
    next(err);
  }
});

/**
 * A POLÍTICA DE GESTÃO (GAP-PRD-165/166) — quem vê dinheiro e como o estoque
 * é valorizado.
 *
 * LER é do escritório inteiro: saber que "os números de dinheiro são da
 * gerência" é justamente o que o atendente precisa ler para não achar que o
 * painel quebrou. ALTERAR é dos DONOS (`requireProfile(req)` sem perfil extra:
 * admin_geral e gestor) — é a decisão que a ficha pediu que fosse do dono, e
 * nem o gerente a toma por ele.
 */
coreRouter.get('/management-policy', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ policy: politicaDeGestao(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/management-policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    const antes = politicaDeGestao(companyId);
    const body = req.body ?? {};
    const policy = salvarPoliticaDeGestao({
      companyId,
      userId,
      painelFinanceiroEquipe: body.painelFinanceiroEquipe,
      custoDoEstoqueEquipe: body.custoDoEstoqueEquipe,
      reguaDeValorizacao: body.reguaDeValorizacao,
      reguaConfirmadaPor: body.reguaConfirmadaPor,
    });
    recordAudit({
      companyId,
      userId,
      action: 'management_policy.updated',
      entityType: 'management_policy',
      entityId: companyId,
      detail: {
        antes: {
          painelFinanceiroEquipe: antes.painelFinanceiroEquipe,
          custoDoEstoqueEquipe: antes.custoDoEstoqueEquipe,
          reguaDeValorizacao: antes.reguaDeValorizacao,
          reguaConfirmadaPor: antes.reguaConfirmadaPor,
        },
        depois: {
          painelFinanceiroEquipe: policy.painelFinanceiroEquipe,
          custoDoEstoqueEquipe: policy.custoDoEstoqueEquipe,
          reguaDeValorizacao: policy.reguaDeValorizacao,
          reguaConfirmadaPor: policy.reguaConfirmadaPor,
        },
      },
    });
    res.json({ policy });
  } catch (err) {
    next(err);
  }
});

/**
 * SOLTAR A PARTE DA RESERVA QUE NÃO TEM ORIGEM — gerência, com motivo.
 *
 * Mais estreita que a leitura, como o estorno da entrada: devolver mercadoria
 * à venda por decisão (e não por um documento que caiu) é decisão de quem
 * responde pela operação. O estoquista vê a divergência e chama o gerente.
 */
coreRouter.post('/stock/reservations/:productId/liberar-sem-origem', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const resultado = liberarReservaSemOrigem({
      companyId,
      productId: String(req.params.productId),
      quantidade:
        body.quantity === undefined || body.quantity === null || body.quantity === ''
          ? null
          : Number(body.quantity),
      motivo: String(body.reason ?? ''),
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.reservation.orphan_released',
      entityType: 'product',
      entityId: resultado.productId,
      detail: {
        liberado: resultado.liberado,
        reservadoAntes: resultado.reservadoAntes,
        reservadoDepois: resultado.reservadoDepois,
        motivo: String(body.reason ?? '').trim(),
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/stock/movements', (req: AuthedRequest, res, next) => {
  try {
    /*
      A BANCADA ENTRA AQUI DE PROPÓSITO, e não por simetria com o resto do
      estoque: o `hideCost` logo abaixo só dispara para `mecanico`, e o serviço
      REMOVE `unit_cost_cents` da resposta dele. Esta rota foi escrita para
      servir o mecânico com o custo podado — fechá-la ao escritório mataria um
      ramo que alguém construiu de propósito.
    */
    abertaAo(req, 'bancada', 'escritorio');
    const { companyId, profiles } = scope(req);
    // O mecânico consulta o que existe e por quanto se revende. O que a empresa
    // pagou no fornecedor não é assunto dele — e o custo é removido da
    // resposta, não apenas escondido na tela.
    //
    // Havia um `'tecnico'` nesta lista. Perfil que não existe em
    // `ASSIGNABLE_PROFILES`, logo ninguém o tem, logo a condição nunca somava
    // nada. Ler a lista dava a impressão de dois papéis cobertos; era um.
    const hideCost =
      !profiles.some((p) =>
        ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista'].includes(p),
      ) && profiles.includes('mecanico');

    const kindParam = req.query.kind;
    const recorte = {
      productId: req.query.productId as string | undefined,
      // O razão de UM lote — é como a tela de Validade responde "de onde
      // saiu cada unidade deste lote" num recall.
      batchId: req.query.batchId as string | undefined,
      kind: Array.isArray(kindParam)
        ? (kindParam as string[])
        : (kindParam as string | undefined),
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      documentNumber: req.query.document as string | undefined,
      userId: req.query.userId as string | undefined,
      search: req.query.search as string | undefined,
    };
    // Página com teto e total do mesmo recorte (GAP-PRD-070): a tela só
    // descobria o fim quando uma página vinha incompleta.
    const pagina = lerPagina(req.query, 200);
    res.json({
      items: listMovements(companyId, { ...recorte, ...pagina, hideCost }),
      total: countMovements(companyId, recorte),
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

/** Tipos disponíveis para o filtro, já com o rótulo em português. */
coreRouter.get('/stock/movement-kinds', (req: AuthedRequest, res, next) => {
  try {
    /*
      Os rótulos do filtro da tela de movimentações. Anda junto com
      `/stock/movements`: um alcance mais estreito deixaria o mecânico com a
      lista e sem os nomes dos tipos.
    */
    abertaAo(req, 'bancada', 'escritorio');
    res.json({
      items: MOVEMENT_KINDS.map((kind) => ({ kind, label: MOVEMENT_KIND_LABEL[kind] })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Os rótulos que a rota manual de estoque pode produzir.
 *
 * FECHADA de propósito: `applyMovement` decide o destino da plaquinha pela
 * referência, e `sale`/`ecommerce_order` dão dono. Deixar o corpo escolher
 * transformava um ajuste em venda, no histórico e na moto.
 */
const REFERENCIAS_MANUAIS = new Set(['manual', 'entrada', 'ajuste', 'perda', 'uso_interno']);
/** As direções que a tela de movimentação manda (MovimentacoesEstoquePage): entrada, saída e ajuste ±. */
const DIRECOES_MANUAIS = new Set(['in', 'out', 'adjust']);

coreRouter.post('/stock/movements', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    // A referência define a identidade do movimento e garante idempotência.
    const referenceId = String(body.referenceId ?? '').trim();
    if (!referenceId) {
      throw new ApiError('CORE_REFERENCE_REQUIRED', 'referenceId é obrigatório.', 400);
    }

    /*
      O RÓTULO NÃO É DIGITADO PELO CHAMADOR.

      `referenceType` vinha livre do corpo e ia direto para o histórico: dava
      para lançar um ajuste manual e chamá-lo de `sale`. Duas consequências, e
      a segunda não é cosmética — `applyMovement` decide o destino da PLAQUINHA
      pela referência, e `sale` está na lista das que DÃO DONO. Um ajuste
      rotulado de venda carimbaria proprietário numa moto que ninguém comprou,
      e a garantia passaria a correr dali.

      A lista é fechada nos rótulos que esta rota realmente produz. Movimento
      de venda, de OS ou de pedido online nasce no serviço daquele fluxo, e não
      aqui.
    */
    const referenceType = String(body.referenceType ?? 'manual').trim() || 'manual';
    if (!REFERENCIAS_MANUAIS.has(referenceType)) {
      throw new ApiError(
        'CORE_REFERENCE_TYPE_INVALID',
        `"${referenceType}" não é um tipo de movimento manual. Use um destes: `
          + `${[...REFERENCIAS_MANUAIS].join(', ')}.`,
        400,
      );
    }

    /*
      A DIREÇÃO TAMBÉM É UMA LISTA FECHADA.

      `movementType` ia cru para o razão: qualquer texto que não fosse 'out'
      virava delta POSITIVO ('reserve', 'xyz', um erro de digitação somavam
      mercadoria sem motivo, rotuladas "Acerto de inventário (+)"), e o tipo
      ausente estourava o NOT NULL com 500. A tela manda só estas três.
    */
    if (!DIRECOES_MANUAIS.has(String(body.movementType ?? ''))) {
      throw new ApiError(
        'CORE_MOVEMENT_TYPE_INVALID',
        `"${String(body.movementType ?? '')}" não é uma direção de movimento manual. Use in (entrada), out (saída) ou adjust (ajuste ±).`,
        400,
      );
    }

    /*
      O QUE DESAPARECE PRECISA DE MOTIVO.

      A rota aceitava tirar mercadoria do sistema sem uma palavra de
      explicação, e nem repassava `reason` — a coluna nascia nula mesmo quando
      alguém digitava algo. A contagem de inventário, que faz a MESMA coisa,
      sempre exigiu motivo.

      O histórico de estoque é o que se consulta quando a prateleira discorda
      do sistema. "Saíram 3" sem motivo não distingue perda, furto, uso interno
      e erro de digitação — e é justamente essa diferença que decide o que o
      gestor faz a respeito.

      Entrada não pede: mercadoria que chega aparece na prateleira, e a
      prateleira confere.
    */
    const quantidade = Number(body.quantity);
    const motivo = String(body.reason ?? '').trim();
    const tiraDoEstoque =
      body.movementType === 'out' || (body.movementType === 'adjust' && quantidade < 0);
    if (tiraDoEstoque && !motivo) {
      throw new ApiError(
        'CORE_REASON_REQUIRED',
        'Informe o motivo da saída — perda, uso interno, acerto de contagem. '
          + 'É o que explica a diferença quando a prateleira discordar do sistema.',
        400,
      );
    }
    /*
      O AJUSTE POSITIVO TAMBÉM PRECISA DE MOTIVO (B-estoque-entrada-13#reauditoria).

      A regra acima só olhava o que SAI, e o "Ajuste de saldo (±)" de +20 passava
      mudo: vinte peças surgiam no histórico sem documento e sem uma palavra, e
      quando a prateleira discordasse ninguém saberia se foi contagem, lançamento
      desfeito ou erro de digitação. Ajuste NÃO é entrada — a "Entrada avulsa"
      (tipo 'in') continua sem motivo, porque mercadoria que chega tem origem; o
      ajuste diz que o sistema estava ERRADO, nos dois sentidos. A tela manda os
      dois tipos separados, então a regra não pega a carga de estoque comum.
    */
    if (body.movementType === 'adjust' && quantidade > 0 && !motivo) {
      throw new ApiError(
        'CORE_REASON_REQUIRED',
        'Informe o motivo do ajuste — mercadoria achada na contagem, lançamento anterior errado. '
          + 'Ajuste de saldo diz que o sistema estava errado, e o histórico precisa dizer por quê. '
          + 'Se é mercadoria que chegou, use "Entrada avulsa".',
        400,
      );
    }

    /*
      A REFERÊNCIA É A CHAVE DE QUEM CHAMA — e a mesma com outra carga não é
      reenvio (RES-IDEM-VIZ).

      `applyMovement` casava (empresa, referência, produto, tipo) e respondia
      "duplicado" com o saldo de agora: a mesma referência com 8 em vez de 5
      voltava 200, e as 3 peças a mais nunca entravam. A impressão do pedido
      (quantidade, custo, local, lote, unidades) é conferida AQUI, antes de o
      código do lote virar lote novo, e gravada no movimento; movimento
      anterior a ela (nulo) segue a regra de sempre.
    */
    const impressao = Impressao.impressaoDe({
      quantidade: Impressao.numero(body.quantity),
      custo: body.unitCostCents === undefined || body.unitCostCents === null || body.unitCostCents === ''
        ? null
        : Impressao.numero(body.unitCostCents),
      local: Impressao.texto(body.locationId),
      lote: Impressao.texto(body.batchId),
      codigoDoLote: Impressao.texto(body.batchCode),
      unidades: Array.isArray(body.unitIds) ? body.unitIds.map(String).sort(Impressao.porCodigo) : [],
    });
    conferirReenvioDoMovimento({
      companyId,
      referenceType,
      referenceId,
      productId: String(body.productId),
      movementType: body.movementType,
      impressao,
    });

    /*
      O LOTE NA ENTRADA MANUAL (GAP-V35), e ele pode chegar de dois jeitos.

      `batchId` é o lote que já existe — escolhido numa lista. `batchCode` é o
      que o conferente LÊ NA EMBALAGEM com a caixa na mão, e cadastrar o lote
      antes de poder lançar a entrada seria obrigá-lo a sair da tela no meio do
      trabalho. `findOrCreateBatch` é idempotente por (empresa, produto,
      código): repetir a entrada do mesmo lote não cria um segundo lote.

      Só ENTRADA cria lote pelo código. Numa SAÍDA, um código que ainda não
      existe significa que a pessoa digitou errado — criar o lote ali faria
      nascer um lote de saldo negativo, que é uma linha que não deveria poder
      existir. Na saída o código é RESOLVIDO, e não encontrá-lo é recusa.
    */
    const entra = body.movementType === 'in' || (body.movementType === 'adjust' && quantidade > 0);
    const codigoDoLote = String(body.batchCode ?? '').trim();
    let batchId: string | undefined = body.batchId ? String(body.batchId) : undefined;
    if (!batchId && codigoDoLote) {
      if (entra) {
        batchId = findOrCreateBatch(companyId, {
          productId: String(body.productId),
          code: codigoDoLote,
          expiresOn: body.expiresOn ?? null,
          manufacturedOn: body.manufacturedOn ?? null,
          locationId: body.locationId ? String(body.locationId) : null,
          userId,
        }).id;
      } else {
        const achado = listBatches(companyId, {
          productId: String(body.productId),
          incluirZerados: true,
        }).find((l) => l.code === codigoDoLote);
        if (!achado) {
          throw new ApiError(
            'CORE_BATCH_NOT_FOUND',
            `Não existe o lote "${codigoDoLote}" para este produto. Confira o código na `
              + 'embalagem — numa saída o sistema não cria lote novo.',
            404,
          );
        }
        batchId = achado.id;
      }
    }

    const result = applyMovement({
      companyId,
      productId: String(body.productId),
      movementType: body.movementType,
      quantity: quantidade,
      referenceType,
      referenceId,
      reason: motivo || null,
      unitCostCents: body.unitCostCents,
      userId,
      note: body.note,
      locationId: body.locationId ? String(body.locationId) : null,
      // Produto serializado sem unidade é recusado pelo próprio
      // `applyMovement`. Repassar em vez de escolher aqui mantém a decisão
      // num lugar só.
      unitIds: Array.isArray(body.unitIds) ? body.unitIds.map(String) : undefined,
      /*
        Lote ausente numa SAÍDA de produto com controle NÃO é erro: o
        `applyMovement` aplica FEFO e grava a escolha. Quem quer descartar um
        lote específico o nomeia — e é justamente aí que a perda de mercadoria
        vencida acontece, porque a lista de saídas que podem levar vencido
        (BatchService) inclui perda, ajuste e uso interno.
      */
      batchId,
      impressao,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.movement',
      entityType: 'product',
      entityId: String(body.productId),
      detail: {
        movementType: body.movementType,
        quantity: body.quantity,
        // O lote entra na trilha porque é ele que responde "de qual lote saiu"
        // num recall — e o id sozinho não se lê.
        batchId: batchId ?? null,
        batchCode: codigoDoLote || null,
      },
    });
    res.status(result.duplicated ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- locais de estoque

coreRouter.get('/stock/locations', (req: AuthedRequest, res, next) => {
  try {
    /*
      ABERTA AOS TRÊS, e isto é uma decisão registrada: `rotas-dado-sensivel`
      já cobra que o mecânico receba 200 aqui. Saber onde a peça está guardada
      não é dado de dinheiro nem de pessoa, e quem não enxerga o local não
      consegue buscar o que vai montar nem o que vai vender.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    res.json({
      locations: listLocations(companyId, req.query.incluirInativos === 'true'),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/stock/locations', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const local = createLocation(companyId, {
      code: String(req.body?.code ?? ''),
      name: String(req.body?.name ?? ''),
      note: req.body?.note ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.location.create',
      entityType: 'stock_location',
      entityId: local.id,
      detail: { code: local.code },
    });
    res.status(201).json({ location: local });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/stock/locations/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const local = updateLocation(companyId, String(req.params.id), {
      name: req.body?.name,
      note: req.body?.note,
      active: req.body?.active,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.location.update',
      entityType: 'stock_location',
      entityId: local.id,
      detail: { active: local.active },
    });
    res.json({ location: local });
  } catch (err) {
    next(err);
  }
});

/** Onde está o saldo deste produto — derivado do razão, não de um cache. */
coreRouter.get('/stock/locations/balance/:productId', (req: AuthedRequest, res, next) => {
  try {
    /*
      Quanto tem em cada local, para um produto. Só a tela de Locais de estoque
      consome, e ela é ROTA_GESTAO.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ balances: balanceByLocation(companyId, String(req.params.productId)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/stock/transfers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const result = transferStock({
      companyId,
      productId: String(body.productId),
      fromLocationId: String(body.fromLocationId),
      toLocationId: String(body.toLocationId),
      quantity: Number(body.quantity),
      userId,
      note: body.note ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.transfer',
      entityType: 'product',
      entityId: String(body.productId),
      detail: {
        from: body.fromLocationId,
        to: body.toLocationId,
        quantity: body.quantity,
      },
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- lotes e validade
//
// GAP-V35. O saldo por lote é DERIVADO do razão — nunca uma segunda tabela de
// saldo —, exatamente como o saldo por local logo acima. As rotas de LEITURA
// acompanham `/stock` (`abertaAo('escritorio')`); as de ESCRITA acompanham
// `/stock/locations` (gerentes e estoquista), porque cadastrar lote, conferir
// e alocar é o mesmo trabalho de quem organiza a prateleira.

/**
 * Os lotes da operação, com saldo, valor e faixa de validade.
 *
 * O mesmo alcance de `/stock`: quem vê a posição de estoque vê a validade
 * dela. A bancada fica de fora como no resto do estoque — o mecânico consulta
 * o histórico (`/stock/movements`), que é a rota escrita para ele.
 */
coreRouter.get('/stock/batches', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listBatches(companyId, {
        productId: req.query.productId as string | undefined,
        faixa: req.query.faixa as FaixaDeValidade | undefined,
        search: req.query.search as string | undefined,
        incluirZerados: req.query.incluirZerados === 'true',
        somenteNaoConferidos: req.query.naoConferidos === 'true',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O ALERTA: quanto vence, quando e quanto vale — por faixa.
 *
 * Vem junto da lista de PENDÊNCIAS (saldo sem lote declarado) porque as duas
 * respondem à mesma pergunta do gestor: "o que precisa de ação hoje". Separá-las
 * em duas rotas faria a tela abrir com metade da verdade enquanto a segunda
 * chamada não voltasse.
 */
coreRouter.get('/stock/batches/alertas', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ ...batchAlerts(companyId), pendencias: pendenciasSemLote(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Onde está o saldo deste produto, lote a lote — derivado do razão.
 *
 * Declarada ANTES de `/stock/batches/:id` porque o Express casa na ordem:
 * depois dela, a palavra "saldos" viraria um id de lote. É a mesma lição de
 * `/products/prontidao-online`.
 */
coreRouter.get('/stock/batches/saldos/:productId', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ balances: balancesByBatch(companyId, String(req.params.productId)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/stock/batches/:id', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const lote = getBatch(companyId, String(req.params.id));
    // TENANT: o lote da empresa A não existe para a B — e a resposta é a mesma
    // de "não existe", de propósito. Dizer "existe, mas não é sua" já entrega
    // que aquele id existe em algum lugar.
    if (!lote) throw new ApiError('CORE_BATCH_NOT_FOUND', 'Lote não encontrado.', 404);
    res.json({ batch: lote });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/stock/batches', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const lote = createBatch(companyId, {
      productId: String(body.productId ?? ''),
      code: String(body.code ?? ''),
      manufacturedOn: body.manufacturedOn ?? null,
      expiresOn: body.expiresOn ?? null,
      locationId: body.locationId ? String(body.locationId) : null,
      note: body.note ?? null,
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.batch.create',
      entityType: 'product_batch',
      entityId: lote.id,
      detail: { productId: lote.product_id, code: lote.code, expiresOn: lote.expires_on },
    });
    res.status(201).json({ batch: lote });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/stock/batches/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const antes = getBatch(companyId, String(req.params.id));
    if (!antes) throw new ApiError('CORE_BATCH_NOT_FOUND', 'Lote não encontrado.', 404);
    const lote = updateBatch(companyId, String(req.params.id), {
      manufacturedOn: body.manufacturedOn,
      expiresOn: body.expiresOn,
      locationId: body.locationId,
      note: body.note,
    });
    /*
      A TRILHA GUARDA O DE/PARA DA VALIDADE, e não só o "alguém editou".
      Mudar a validade de um lote que já está na prateleira é a alteração mais
      consequente desta tela: ela decide o que o FEFO escolhe e o que a venda
      recusa. Sem o valor anterior, a auditoria não responde a única pergunta
      que alguém fará ("quem prorrogou aquele iogurte?").
    */
    recordAudit({
      companyId,
      userId,
      action: 'stock.batch.update',
      entityType: 'product_batch',
      entityId: lote.id,
      detail: {
        code: lote.code,
        expiresOn: { de: antes.expires_on, para: lote.expires_on },
        manufacturedOn: { de: antes.manufactured_on, para: lote.manufactured_on },
      },
    });
    res.json({ batch: lote });
  } catch (err) {
    next(err);
  }
});

/** A conferência da doca: quem olhou a caixa e quando. Idempotente. */
coreRouter.post('/stock/batches/:id/conferir', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const resultado = markBatchChecked({
      companyId,
      batchId: String(req.params.id),
      userId,
    });
    // Conferência repetida NÃO gera segunda linha de auditoria: ela não
    // aconteceu de novo, e a trilha registra fatos, não cliques.
    if (!resultado.duplicated) {
      recordAudit({
        companyId,
        userId,
        action: 'stock.batch.check',
        entityType: 'product_batch',
        entityId: resultado.batch.id,
        detail: { code: resultado.batch.code, expiresOn: resultado.batch.expires_on },
      });
    }
    res.status(resultado.duplicated ? 200 : 201).json(resultado);
  } catch (err) {
    next(err);
  }
});

/**
 * ALOCAÇÃO: o saldo sem lote declarado passa a ter lote.
 *
 * Move saldo de verdade — por um PAR de movimentos, como a transferência entre
 * locais —, e por isso pede o mesmo perfil de quem lança movimento manual.
 */
coreRouter.post('/stock/batches/:id/alocar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const resultado = allocateToBatch({
      companyId,
      productId: String(body.productId ?? ''),
      batchId: String(req.params.id),
      quantity: Number(body.quantity),
      userId,
      note: body.note ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'stock.batch.allocate',
      entityType: 'product_batch',
      entityId: String(req.params.id),
      detail: { productId: body.productId, quantity: resultado.quantity },
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

/**
 * O INTERRUPTOR do controle de lote por produto.
 *
 * Rota PRÓPRIA, e não um campo em `PUT /products/:id`, pelo mesmo desenho da
 * grade e do kit: o módulo é dono do próprio interruptor e das próprias
 * recusas (serializado, serviço sem estoque, modelo de grade). A tela do
 * produto chama esta rota depois de salvar a ficha.
 */
coreRouter.patch('/stock/batch-control/:productId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const tracksBatches = req.body?.tracksBatches === true;
    const resultado = setBatchControl({
      companyId,
      productId: String(req.params.productId),
      tracksBatches,
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'product.batch_control',
      entityType: 'product',
      entityId: String(req.params.productId),
      detail: { tracksBatches },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ clientes

coreRouter.get('/customers', (req: AuthedRequest, res, next) => {
  try {
    /*
      DADO DE PESSOA QUE NÃO PODE FECHAR — e o motivo escrito, porque a
      tentação de apertar é grande.

      A tela de Clientes é ROTA_GESTAO, mas ela não é a única consumidora: o PDV
      busca cliente para vincular à venda (ROTA_PDV), e a Oficina e Equipamentos
      buscam o dono do aparelho (ROTA_OFICINA). Fechar ao balcão quebraria a
      venda com cliente; fechar à bancada quebraria a abertura de OS.

      Quem responde por este risco é o POST ao lado, que decide quem CADASTRA.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    /*
      O QUE CADA UM LÊ — GAP-PRD-073 (LGPD). A porta segue aberta aos três
      ambientes pelo motivo acima; o que muda é a LINHA. Quem atende o
      cadastro (caixa, atendente, gerência) vê o contato inteiro: cadastra,
      corrige e põe o CPF na nota. A bancada e o estoque veem o nome e os
      últimos dígitos do telefone e do documento — o que basta para achar o
      dono do aparelho. A busca continua comparando com o valor inteiro.
    */
    const alcance = alcanceDoCliente(req.auth?.profileCodes ?? []);
    const termo = String(req.query.search ?? '').trim();
    /*
      A PÁGINA SE DECLARA (GAP-PRD-070). Sem termo, 150 clientes devolviam 100
      e só `{ items }`: o seletor de cliente do PDV, a Fidelidade, a Locação e
      os Orçamentos paravam no 100º sem saber que havia outros. Agora `total`
      diz quantos existem (com e sem termo), o `offset` anda, e o `limit` tem
      teto de 500 — o padrão de 100 continua o de sempre.
    */
    const pagina = lerPagina(req.query, 100);
    if (!termo) {
      res.json({
        items: listCustomers(companyId, pagina).map((c) => projetarCliente(c, alcance)),
        total: countCustomers(companyId),
        ...pagina,
      });
      return;
    }
    /*
      A BUSCA NORMALIZA OS DOIS LADOS — GAP-V53, a busca viva do F2 do PDV.

      O LIKE cru do serviço comparava máscara com dígito e perdia o cliente
      dos dois jeitos: o cadastro NOVO guarda o documento só com dígitos
      (é a coluna que vai no <CPF> do XML), então "390.533.447-05" digitado
      como está impresso no documento não achava ninguém; e o cadastro
      ANTIGO pode estar gravado COM máscara (constatação escrita em
      `clientePorDocumento`), então o CPF digitado limpo também não achava.
      No balcão, "não achou" vira cadastro DUPLICADO na hora — o operador
      conclui que a pessoa não existe e cadastra de novo.

      A regra é a mesma do dedupe de documento: tirar a máscara dos dois
      lados, em memória — o SQLite não faz isso sozinho, e a lista de
      clientes de uma loja cabe nela com folga (doutrina de
      `clientePorDocumento`, CatalogService.ts). De quebra o CÓDIGO do
      cliente vira pesquisável: a coluna `code` sempre foi gravável pelo
      POST e nenhuma busca a lia.

      O padrão de 100 do retorno continua o mesmo de sempre; a base varrida é
      que passa a ser a lista inteira de ativos, já em ordem de nome.
    */
    const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');
    const alvo = termo.toLocaleLowerCase('pt-BR');
    const digitos = soDigitos(termo);
    const ativos = listCustomers(companyId, { limit: 100_000 });
    const casa = (c: Record<string, unknown>): boolean => {
      if (String(c.name ?? '').toLocaleLowerCase('pt-BR').includes(alvo)) return true;
      if (String(c.code ?? '').toLocaleLowerCase('pt-BR').includes(alvo)) return true;
      if (
        digitos
        && (soDigitos(c.document).includes(digitos) || soDigitos(c.phone).includes(digitos))
      ) {
        return true;
      }
      // O comportamento antigo, preservado por inteiro: o termo cru ainda
      // compara com o valor cru — quem buscava "(96)" literal continua achando.
      return String(c.document ?? '').includes(termo) || String(c.phone ?? '').includes(termo);
    };
    // A página anda sobre os que CASAM, e o total é deles — não da empresa.
    const achados = ativos.filter(casa);
    res.json({
      items: achados.slice(pagina.offset, pagina.offset + pagina.limit).map((c) => projetarCliente(c, alcance)),
      total: achados.length,
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/customers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    const customer = createCustomer(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'customer.create',
      entityType: 'customer',
      entityId: String(customer.id),
    });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/customers/:id', (req: AuthedRequest, res, next) => {
  try {
    // A mesma abertura da listagem, pelo mesmo motivo escrito nela: o PDV
    // vincula o cliente à venda, a bancada acha o dono do aparelho e a gestão
    // reabre a ficha para editar. A ficha não carrega nada que a lista já não
    // devolva linha a linha.
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const customer = getCustomer(companyId, String(req.params.id));
    if (!customer) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
    // A mesma projeção da lista (GAP-PRD-073): a ficha da bancada não é mais larga que a linha.
    res.json(projetarCliente(customer, alcanceDoCliente(req.auth?.profileCodes ?? [])));
  } catch (err) {
    next(err);
  }
});

/**
 * EDITAR O CADASTRO — a metade que faltava do ciclo do cliente.
 *
 * Perfis espelhados do POST acima: quem pode cadastrar uma pessoa no balcão
 * pode corrigir o telefone que digitou errado — exigir gerência para consertar
 * o próprio erro só faria o erro ficar.
 *
 * A inativação viaja aqui, no campo `active`, como no produto: cadastro nunca
 * se apaga (a venda antiga precisa do cliente para fazer sentido), sai de
 * circulação — `listCustomers` filtra `active = 1` e o balcão para de achar.
 *
 * O que NÃO passa por aqui: a tabela de preço (rota própria, com auditoria
 * própria, porque muda dinheiro) e a empresa dona do cadastro (vem do vínculo
 * da sessão, nunca do corpo — regra do arquivo inteiro).
 */
coreRouter.put('/customers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    const customer = updateCustomer(companyId, String(req.params.id), req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'customer.update',
      entityType: 'customer',
      entityId: String(req.params.id),
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

/**
 * Por qual tabela este cliente compra — a partir de agora.
 *
 * ROTA PRÓPRIA, e não um campo dentro de um "salvar cliente", porque esta é a
 * decisão que MUDA DINHEIRO: da próxima venda em diante, a pessoa passa a pagar
 * outro preço. Separada, ela tem registro de auditoria próprio, e quem for
 * conferir depois por que o revendedor começou a ter 15% acha uma linha com
 * nome e hora — em vez de ter de deduzi-la de um salvamento que também trocou
 * um telefone.
 *
 * Por isso também o perfil é mais estreito que o do cadastro: quem cadastra
 * cliente no balcão é atendente e caixa; quem concede condição comercial é
 * gerência.
 *
 * `priceTableId: null` desfaz o vínculo e devolve o cliente ao preço normal.
 */
coreRouter.put('/customers/:id/price-table', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const bruto = (req.body ?? {}) as { priceTableId?: unknown };
    const priceTableId = bruto.priceTableId ? String(bruto.priceTableId) : null;
    const customer = setCustomerPriceTable(companyId, String(req.params.id), priceTableId);
    recordAudit({
      companyId,
      userId,
      action: 'customer.price_table',
      entityType: 'customer',
      entityId: String(req.params.id),
      // O id da tabela vai no rastro: "trocou a tabela" sem dizer PARA QUAL não
      // responde a única pergunta que se faz ao ler esta linha depois.
      detail: { priceTableId },
    });
    res.json(customer);
  } catch (err) {
    next(err);
  }
});

/**
 * O EXTRATO DE CRÉDITO DE LOJA do cliente — saldo e movimento (GAP-V10/V47).
 *
 * ## Quem alcança, e por quê
 *
 * O BALCÃO precisa, e é a razão principal desta rota existir: o PDV só oferece
 * "Crédito do cliente" como forma de abater quando há saldo, e para saber que há
 * saldo ele pergunta aqui. Uma rota só de gerência faria o operador descobrir o
 * vale pelo erro — ou, pior, não descobrir e cobrar do cliente o valor inteiro.
 *
 * O ESCRITÓRIO precisa pela outra ponta: é na ficha do cliente que a dúvida
 * ("de onde veio esse crédito?") é respondida, com o número da devolução que o
 * concedeu e o da venda que o gastou.
 *
 * A BANCADA não entra: a oficina não vende com vale, e saldo de cliente é dado
 * financeiro. O CONTADOR também não — ele recebe o pacote do mês, não a conta
 * corrente de cada pessoa.
 *
 * O cerco de empresa é do `scope`, como no resto do arquivo: cliente da loja B
 * simplesmente não aparece para a A, e o extrato dele volta zerado em vez de
 * revelar que o id existe.
 */
coreRouter.get('/customers/:id/credits', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(creditStatement(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * OS DIREITOS DO TITULAR (LGPD, art. 18) — GAP-PRD-073.
 *
 * Antes, cada pedido de titular terminava em SQL do desenvolvedor. Agora são
 * duas rotas, com trilha: EXPORTAR tudo o que a operação guarda da pessoa
 * (art. 18, II e V) e ANONIMIZAR mantendo o histórico fiscal (art. 18, IV e
 * VI). A doutrina inteira está em `services/lgpd/TitularService.ts`.
 *
 * Só a gerência — e o dono, pelo atalho do `requireProfile`. Responder ao
 * titular é decisão de quem responde pela operação: o balcão encaminha, não
 * decide. O contador fica de fora, como em todo o resto do núcleo.
 *
 * O cerco de empresa é o do `scope`: titular da vizinha é 404.
 */
coreRouter.get('/customers/:id/dados-do-titular', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const documento = exportarDadosDoTitular(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'customer.lgpd_export',
      entityType: 'customer',
      entityId: String(req.params.id),
      // Quantas linhas de cada lugar saíram — nunca o conteúdo.
      detail: { secoes: documento.secoes.map((s) => ({ chave: s.chave, total: s.total })) },
    });
    res.json(documento);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/customers/:id/anonimizar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const resultado = anonimizarTitular({
      companyId,
      customerId: String(req.params.id),
      motivo: (req.body ?? {}).motivo,
    });
    recordAudit({
      companyId,
      userId,
      action: 'customer.lgpd_anonymize',
      entityType: 'customer',
      entityId: String(req.params.id),
      // O motivo e o alcance vão no rastro; o dado apagado, não.
      detail: { motivo: resultado.motivo, alterados: resultado.alterados },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/** O que o sistema guarda de gente, e por quanto tempo — a declaração que a gerência mostra ao titular. */
coreRouter.get('/lgpd/retencao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    res.json({ items: POLITICA_DE_RETENCAO });
  } catch (err) {
    next(err);
  }
});

/**
 * Quanto a operação DEVE em vale, somado.
 *
 * Passivo, e mais duro que o da fidelidade: ponto é desconto prometido, vale é
 * mercadoria que já voltou para a prateleira e ainda não foi paga de volta.
 * Fica ao lado do extrato porque é a mesma razão vista de cima, e é de
 * gerência — a pergunta "quanto a loja deve em crédito?" é de quem responde
 * pelo caixa, não de quem opera.
 */
coreRouter.get('/customer-credits/liability', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(creditLiability(companyId));
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------- caixa

/**
 * A GAVETA DA URL ESTÁ NO ESCOPO DE QUEM PEDE? (H-caixa-seguranca-10)
 *
 * O DEFEITO: o recorte de caixas do vínculo (`acesso.terminais`) só era
 * conferido na ABERTURA (`caixaNoEscopo` em POST /cash/open). Movimento,
 * resumo, fechamento e reabertura usavam só a empresa do token e o `sessionId`
 * da URL: o operador restrito ao "Caixa 1" pegava o id da gaveta do Caixa 2 e
 * lançava sangria nela, ou a fechava com uma contagem qualquer.
 *
 * Agora toda rota que mexe numa gaveta pelo id passa aqui: a gaveta precisa
 * existir nesta empresa (404, a mesma resposta de um id inventado), o
 * computador registrado como caixa só opera a gaveta do PRÓPRIO caixa, e o
 * caixa dela precisa estar no acesso do vínculo. Vínculo com "todos os
 * caixas" (como os logins padrão nascem) e empresa sem caixa cadastrado
 * passam sem mudança nenhuma.
 */
function gavetaNoEscopo(req: AuthedRequest, sessionId: string): void {
  const { companyId } = scope(req);
  const gaveta = getSession(companyId, sessionId);
  if (!gaveta) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);
  const doDispositivo = req.auth?.storeId ?? null;
  if (doDispositivo && gaveta.terminal_id !== doDispositivo) {
    throw new ApiError(
      'CORE_TERMINAL_MISMATCH',
      'Este computador entrou como terminal registrado de outro caixa. Ele só opera a gaveta do próprio caixa.',
      409,
      { terminalDoDispositivo: doDispositivo, terminalDaGaveta: gaveta.terminal_id },
    );
  }
  try {
    caixaNoEscopo(req, { informado: gaveta.terminal_id, doDispositivo: null });
  } catch (err) {
    // A gaveta SEM caixa (a única de antes do cadastro de caixas) não é de
    // nenhum caixa do acesso restrito: "escolha o caixa" seria a frase errada.
    if ((err as { code?: unknown }).code === 'CORE_TERMINAL_REQUIRED') {
      throw new ApiError(
        'CORE_TERMINAL_OUT_OF_SCOPE',
        'Esta gaveta não é de nenhum caixa do seu acesso nesta empresa. Peça a quem administra os usuários.',
        403,
        { sessionId },
      );
    }
    throw err;
  }
}

/**
 * O número de centavos que veio no corpo, lido sem conversão frouxa.
 *
 * O DEFEITO (H-caixa-seguranca-R01): as rotas da gaveta faziam `Number(valor)`
 * sobre o que viesse. `Number(' ')`, `Number(false)` e `Number([])` são 0, e
 * `Number(true)` é 1 — inteiros legítimos, que passavam inteiros pela régua
 * dos centavos do serviço. Aqui só passa `number` (a régua do serviço confere
 * se é inteiro e não negativo) ou texto escrito como número; o resto vira NaN,
 * e a régua recusa com `CORE_INVALID_AMOUNT`. "0x10" e "1e3" também viram NaN:
 * contagem de gaveta não se escreve em hexadecimal nem em notação científica.
 */
function numeroDoCorpo(valor: unknown): number {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string') {
    const texto = valor.trim();
    if (/^[+-]?\d+(?:\.\d+)?$/.test(texto)) return Number(texto);
  }
  return Number.NaN;
}

/**
 * Valor OBRIGATÓRIO no corpo (fundo de troco, contagem do fechamento): o que
 * não foi informado não vira zero em silêncio.
 *
 * O DEFEITO (H-caixa-seguranca-R01): só `undefined`, `null` e `''` eram
 * "não informado". `{countedCents: ' '}` (o campo com um espaço) e
 * `{countedCents: false}` fechavam o turno com contado ZERO — a gaveta inteira
 * registrada como falta, sem ninguém ter contado, o mesmo "fechar sem
 * conferência" do H-13 — e `{openingCents: true}` abria a gaveta com R$ 0,01.
 * Texto só de espaços, booleano, lista e objeto também são "não informou": o
 * mesmo 400 nomeado. Texto que não é número ("2z5", "duzentos") continua indo
 * à régua do serviço, que diz `CORE_INVALID_AMOUNT`.
 */
function centavosDoCorpo(valor: unknown, codigo: string, mensagem: string): number {
  const informado =
    typeof valor === 'number' || (typeof valor === 'string' && valor.trim() !== '');
  if (!informado) throw new ApiError(codigo, mensagem, 400);
  return numeroDoCorpo(valor);
}

coreRouter.get('/cash/open', (req: AuthedRequest, res, next) => {
  try {
    /*
      A gaveta é do balcão. ROTA_CAIXA e ROTA_PDV aceitam `pdv` e `gestao`, e o
      POST logo abaixo já dizia a mesma coisa em perfis. A bancada fica de fora:
      o mecânico não abre nem consulta caixa.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    /*
      DE QUAL CAIXA É ESTE COMPUTADOR (GAP-PRD-039). O terminal do TOKEN de
      dispositivo vence o da consulta: a máquina registrada como Caixa 2 só
      enxerga a gaveta do Caixa 2. Terminal que não é desta operação, ou que foi
      desligado, não derruba a consulta — vira `terminalRecusado`, e o PDV pede
      a escolha de novo em vez de ficar sem saber da gaveta.
    */
    const terminalDoDispositivo = req.auth?.storeId ?? null;
    const pedido =
      terminalDoDispositivo
      ?? (typeof req.query.terminalId === 'string' && req.query.terminalId !== ''
        ? req.query.terminalId
        : null);
    let terminal: ReturnType<typeof assertTerminalDaEmpresa> = null;
    let terminalRecusado: { id: string; motivo: string } | null = null;
    try {
      terminal = assertTerminalDaEmpresa(companyId, pedido, { exigirAtivo: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      terminalRecusado = { id: String(pedido), motivo: err.message };
    }
    /*
      O CAIXA PEDIDO ESTÁ NO ACESSO DO VÍNCULO? (H-caixa-seguranca-10)

      `?terminalId=` era livre: o operador restrito ao Caixa 1 consultava a
      gaveta do Caixa 2 e saía com o `sessionId` dela. A mesma recusa da
      abertura, dita como `terminalRecusado` — a consulta não cai, o PDV só pede
      a escolha de novo.
    */
    if (terminal) {
      try {
        caixaNoEscopo(req, { informado: terminal.id, doDispositivo: null });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        terminalRecusado = { id: terminal.id, motivo: err.message };
        terminal = null;
      }
    }
    const terminaisAtivos = contarTerminaisAtivos(companyId);
    // Com caixas cadastrados, "sem caixa" não tem gaveta: a gaveta sem
    // terminal que sobrou aberta aparece em `/cash/drawers` para ser fechada.
    const exigeTerminal = !terminal && terminaisAtivos > 0;
    const session = terminalRecusado || exigeTerminal ? null : getOpenSession(companyId, terminal?.id ?? null);
    /*
      O teto da sangria viaja JUNTO com a sessão aberta, e não numa rota própria.

      Duas razões. A primeira é que o PDV já chama esta rota para achar o caixa
      do terminal — o número chega sem uma segunda ida ao servidor, e a tela
      consegue avisar ANTES de o operador digitar um valor que vai ser recusado.
      A segunda é de permissão: `GET /sale-policies` exige gerente, porque lá se
      LÊ e se ESCREVE a política inteira. O operador de caixa não pode ver o
      limite de desconto da operação nem o prazo do fiado, mas precisa saber
      quanto pode tirar da gaveta — é a regra que se aplica a ele.

      `null` significa "sem teto", e é o que a tela usa para não desenhar aviso
      nenhum.
    */
    res.json({
      session,
      cashWithdrawalLimitCents: politicaDaEmpresa(companyId).cashWithdrawalLimitCents,
      terminal: terminal ? { id: terminal.id, code: terminal.code, name: terminal.name } : null,
      terminalDoDispositivo: Boolean(terminalDoDispositivo),
      terminalRecusado,
      terminaisAtivos,
      exigeTerminal,
      // A gaveta de outro dia (GAP-PRD-131): o PDV avisa e leva ao fechamento.
      deOutroDia: session ? deOutroDia(session.opened_at) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Todas as gavetas abertas da operação, uma por caixa (GAP-PRD-131).
 *
 * É a lista que aponta a gaveta ESQUECIDA — o Painel avisa, e a tela de Caixa
 * deixa fechá-la. Mesmo alcance da consulta da gaveta: quem abre e fecha caixa
 * vê as gavetas abertas; a bancada não tem gaveta.
 */
coreRouter.get('/cash/drawers', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const items = listarGavetasAbertas(companyId);
    res.json({ items, deOutroDia: items.filter((g) => g.deOutroDia).length });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- caixas (terminais de PDV)
//
// O cadastro que `core_terminals` esperava (GAP-PRD-039/146). Ler é do balcão
// — o operador escolhe "qual caixa é este computador" —; cadastrar, renomear e
// desligar é da gerência, que responde pela gaveta de cada um.

coreRouter.get('/terminals', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listTerminals(companyId, { somenteAtivos: req.query.ativos === '1' }) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/terminals', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const terminal = createTerminal({ companyId, userId, name: req.body?.name });
    recordAudit({
      companyId,
      userId,
      action: 'terminal.create',
      entityType: 'terminal',
      entityId: terminal.id,
      detail: { code: terminal.code, name: terminal.name },
      ip: ipDoSocket(req),
    });
    res.status(201).json(terminal);
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/terminals/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const { antes, terminal } = renameTerminal({
      companyId,
      terminalId: String(req.params.id),
      name: req.body?.name,
    });
    recordAudit({
      companyId,
      userId,
      action: 'terminal.rename',
      entityType: 'terminal',
      entityId: terminal.id,
      detail: { antes, depois: terminal.name },
      ip: ipDoSocket(req),
    });
    res.json(terminal);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/terminals/:id/deactivate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const terminal = setTerminalActive({
      companyId,
      userId,
      terminalId: String(req.params.id),
      active: false,
      reason: req.body?.reason,
    });
    recordAudit({
      companyId,
      userId,
      action: 'terminal.deactivate',
      entityType: 'terminal',
      entityId: terminal.id,
      // Os tokens presos ao caixa param de entrar enquanto ele estiver
      // desligado (o login de dispositivo confere) — a trilha diz quantos.
      detail: { reason: terminal.deactivationReason, tokensAtivos: terminal.tokensAtivos },
      ip: ipDoSocket(req),
    });
    res.json(terminal);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/terminals/:id/activate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const terminal = setTerminalActive({
      companyId,
      userId,
      terminalId: String(req.params.id),
      active: true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'terminal.activate',
      entityType: 'terminal',
      entityId: terminal.id,
      ip: ipDoSocket(req),
    });
    res.json(terminal);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/cash/sessions', (req: AuthedRequest, res, next) => {
  try {
    /*
      O histórico de turnos da gaveta — abertura, fechamento e diferença por
      turno, com quem abriu e quem fechou pelo nome. É a resposta de "de quem
      era o caixa que fechou faltando 40?", e a tela de Caixa da gestão o
      consome. O alcance vem da família: quem abre e fecha caixa é quem lista
      os turnos.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listSessions(
        companyId,
        req.query.limit ? Number(req.query.limit) : undefined,
      ),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/cash/open', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    // O caixa do TOKEN de dispositivo vence; corpo que discorda é 409 nomeado.
    // Vem ANTES do fundo: o caixa fora do acesso é 403, seja qual for o corpo.
    const terminalId = caixaNoEscopo(req, {
      informado: req.body?.terminalId,
      doDispositivo: req.auth?.storeId,
    });
    /*
      O FUNDO É EXPLÍCITO (H-caixa-seguranca-13). `Number(openingCents ?? 0)`
      abria a gaveta com zero quando o campo nem vinha (ou vinha nulo, que é o
      que um NaN vira no JSON) — sem erro nenhum. Gaveta que abre vazia manda 0.
    */
    const openingCents = centavosDoCorpo(
      req.body?.openingCents,
      'CORE_CASH_OPENING_REQUIRED',
      'Informe o fundo de troco da abertura (0 se a gaveta abre vazia).',
    );
    const session = openSession({
      companyId,
      userId,
      terminalId,
      openingCents,
      note: req.body?.note,
    });
    recordAudit({
      companyId,
      userId,
      action: 'cash.open',
      entityType: 'cash_session',
      entityId: session.id,
      detail: { terminalId: session.terminal_id },
    });
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/cash/:sessionId/movements', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    gavetaNoEscopo(req, String(req.params.sessionId));
    // `Number(true)` é 1 (H-caixa-seguranca-R01): `{amountCents: true}`
    // lançava R$ 0,01 na gaveta. Ausente segue zero, que o serviço recusa.
    // O MESMO número vai ao serviço e à auditoria: gravar o corpo cru deixava
    // na trilha o texto " 5000 " ao lado do movimento de 5000.
    const amountCents =
      req.body?.amountCents === undefined || req.body?.amountCents === null
        ? 0
        : numeroDoCorpo(req.body.amountCents);
    const result = addMovement({
      companyId,
      sessionId: String(req.params.sessionId),
      userId,
      movementType: req.body?.movementType,
      amountCents,
      note: req.body?.note,
      // Os perfis saem do TOKEN, nunca do corpo. Foi assim que a rodada 21
      // fechou o denominador da alçada de desconto: quem se declara não é quem
      // decide.
      alcada: {
        profileCodes: scope(req).profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
      // O reenvio do mesmo movimento (H-caixa-seguranca-09) não grava de novo.
      chave: req.header('Idempotency-Key') ?? null,
    });
    // O reenvio já registrado não é um segundo movimento: nem 201, nem auditoria.
    if (result.repetido) {
      res.status(200).json(result);
      return;
    }
    recordAudit({
      companyId,
      userId,
      action: `cash.${req.body?.movementType}`,
      entityType: 'cash_session',
      entityId: String(req.params.sessionId),
      detail: { amountCents, motivo: req.body?.note ?? null },
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/cash/:sessionId/summary', (req: AuthedRequest, res, next) => {
  try {
    /*
      O resumo que o operador confere ao fechar o turno — o diálogo do PDV e a
      tela de Caixa (ROTA_CAIXA) pedem os dois. É dinheiro, mas é o dinheiro DA
      GAVETA DELE; a bancada não tem gaveta.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    gavetaNoEscopo(req, String(req.params.sessionId));
    const summary = getSummary(companyId, String(req.params.sessionId));
    if (!summary) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/** O que o fechamento deixou pendente, em números, para a auditoria (GAP-PRD-081). */
function resumoDasPendenciasDoFechamento(cru: string | null | undefined): Record<string, unknown> | null {
  if (!cru) return null;
  try {
    const p = JSON.parse(cru) as {
      motivo?: string;
      totalCents?: number;
      cobrancas?: unknown[];
      pagamentosPendentes?: unknown[];
    };
    return {
      cobrancas: p.cobrancas?.length ?? 0,
      pagamentosPendentes: p.pagamentosPendentes?.length ?? 0,
      totalCents: p.totalCents ?? 0,
      motivo: p.motivo ?? null,
    };
  } catch {
    return { ilegivel: true };
  }
}

coreRouter.post('/cash/:sessionId/close', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    gavetaNoEscopo(req, String(req.params.sessionId));
    /*
      A CONTAGEM É OBRIGATÓRIA (H-caixa-seguranca-13). `Number(countedCents ?? 0)`
      fechava o turno com contado ZERO quando o campo não vinha (ou vinha nulo):
      falta do esperado inteiro registrada, sem erro nenhum — justamente o
      "fechar sem conferência" que a régua dos centavos existe para impedir.
      Gaveta esvaziada de verdade manda 0, e continua fechando.
    */
    const countedCents = centavosDoCorpo(
      req.body?.countedCents,
      'CORE_CASH_COUNT_REQUIRED',
      'Informe quanto foi contado na gaveta para fechar o turno (0 se ela foi esvaziada).',
    );
    const session = closeSession({
      companyId,
      sessionId: String(req.params.sessionId),
      userId,
      countedCents,
      note: req.body?.note,
      // Com dinheiro eletrônico indefinido no turno, fechar exige declarar
      // que está ciente, com o motivo (GAP-PRD-081).
      pendenciasCiente: req.body?.pendenciasCiente === true,
      pendenciasMotivo: req.body?.pendenciasMotivo,
    });
    const pendencias = resumoDasPendenciasDoFechamento(session.closed_with_pending);
    recordAudit({
      companyId,
      userId,
      action: 'cash.close',
      entityType: 'cash_session',
      entityId: session.id,
      detail: { difference: session.difference_cents, pendencias },
    });
    res.json(session);
  } catch (err) {
    next(err);
  }
});

/**
 * Reabre o ÚLTIMO turno fechado, no mesmo dia da loja.
 *
 * A regra inteira — por que só o último, por que só hoje, e o que acontece com
 * a conferência já gravada — está em `CashService.reopenSession`. Aqui ficam só
 * as duas coisas que são da rota: o alcance (o mesmo de abrir e fechar; quem
 * mexe na gaveta é quem a reabre) e os perfis, que saem do TOKEN e nunca do
 * corpo.
 */
coreRouter.post('/cash/:sessionId/reopen', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId, profiles } = scope(req);
    gavetaNoEscopo(req, String(req.params.sessionId));
    const { session, authorizationId, authorizedBy } = reopenSession({
      companyId,
      sessionId: String(req.params.sessionId),
      userId,
      reason: req.body?.reason,
      alcada: {
        profileCodes: profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
    });
    recordAudit({
      companyId,
      userId,
      action: 'cash.reopen',
      entityType: 'cash_session',
      entityId: session.id,
      /*
        O ANTES E O DEPOIS, na mesma linha — e o "antes" aqui é o fechamento que
        acabou de ser desfeito. Ele também está arquivado em `closing_trail`,
        e a duplicidade é deliberada: a trilha da sessão responde "o que já
        aconteceu com este turno" e a auditoria responde "quem mexeu nele e
        quando", e quem investiga costuma chegar por uma só das duas.
      */
      detail: {
        reason: req.body?.reason ?? null,
        requestingUserId: userId,
        authorizingUserId: authorizedBy,
        authorizationId,
        reopenCount: session.reopen_count ?? null,
        fechamentoDesfeito: session.closing_trail,
      },
      ip: ipDoSocket(req),
    });
    res.json(session);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ certificado digital A1

/**
 * Certificado é artefato da empresa, não da loja: só admin e gestor mexem.
 * `requireProfile` sem perfis extras deixa passar exatamente esses dois.
 */
coreRouter.get('/fiscal/certificate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId } = scope(req);
    // Unidade só existe uma (GAP-PRD-180): `?unit=` de outra é recusado.
    res.json(getCertificateView(companyId, unidadeFiscalDoPedido(req.query.unit)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/certificate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    const pfxBase64 = String(req.body?.pfxBase64 ?? '');
    const password = String(req.body?.certificatePassword ?? '');
    if (!pfxBase64 || !password) {
      throw new ApiError(
        'FISCAL_CERTIFICATE_CREDENTIALS_REQUIRED',
        'Arquivo .pfx e senha são obrigatórios.',
        400,
      );
    }
    // GAP-PRD-180: o arquivo vai para onde a emissão o procura, ou para lugar
    // nenhum — nunca para uma unidade que nada lê.
    const unit = unidadeFiscalDoPedido(req.body?.operationalUnitId);

    /*
      `expectedCnpj` continua sendo aceito, mas deixou de ser o que LIGA a
      conferência (GAP-V39): o serviço agora compara sempre, contra o CNPJ do
      emitente que a própria operação já tem configurado. O campo virou
      override — quem o informa está afirmando contra qual número quer
      conferir, e essa afirmação ganha do cadastro.
    */
    upsertCertificateA1({
      companyId,
      operationalUnitId: unit,
      pfxBase64,
      password,
      expectedCnpj: req.body?.expectedCnpj,
    });

    // A auditoria registra QUE houve troca de certificado, qual o titular e
    // COMO a conferência do CNPJ terminou — nunca o arquivo nem a senha. A
    // impressão digital identifica o arquivo sem guardar nada dele.
    const view = getCertificateView(companyId, unit);
    recordAudit({
      companyId,
      userId,
      action: 'fiscal.certificate.upsert',
      entityType: 'fiscal_certificate',
      entityId: unit,
      detail: {
        cnpj: view.certificate?.cnpj,
        holderName: view.certificate?.holderName,
        validTo: view.certificate?.validTo,
        issuer: view.certificate?.issuer,
        fingerprintSha256: view.certificate?.fingerprintSha256,
        cnpjConference: view.certificate?.cnpjConference,
      },
    });
    res.status(201).json(view);
  } catch (err) {
    next(err);
  }
});

/**
 * OS CERTIFICADOS DAS SEIS EMPRESAS, LADO A LADO — GAP-V41.
 *
 * `GET /fiscal/certificate` responde pela empresa do token, e só; conferir a
 * situação dos A1 do grupo exigia trocar de operação seis vezes, com um reload
 * inteiro a cada troca. Na prática ninguém conferia, e o vencimento chegava sem
 * ninguém saber.
 *
 * ALCANCE: `requireProfile(req)` sem perfil extra — `admin_geral` e `gestor`,
 * os mesmos que já alcançam o certificado de uma operação. O A1 assina nota em
 * nome da empresa; gerente de loja fica de fora aqui como fica lá.
 *
 * E "as seis" é o VÍNCULO, não o perfil: `listCompaniesForUser` devolve o que
 * há em `core_user_companies`, a mesma régua de `GET /companies`. O adm de uma
 * loja vê a sua loja — o A1 e o CNPJ das outras não são dele.
 */
coreRouter.get('/fiscal/certificates/group', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { userId } = scope(req);
    // Só onde o perfil de LÁ também é de dono (GAP-PRD-084): vínculo de
    // mecânico numa loja não mostra o A1 dela ao gestor de outra.
    const deDono = new Set(operacoesOndeOPerfilAbre(userId, []).map((c) => c.id));
    const empresas = listCompaniesForUser(userId).filter((c) => deDono.has(c.id));
    res.json({ items: listGroupCertificates(empresas) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/certificate/revoke', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    const unit = unidadeFiscalDoPedido(req.body?.operationalUnitId);
    const view = revokeCertificate({
      companyId,
      operationalUnitId: unit,
      reason: String(req.body?.reason ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'fiscal.certificate.revoke',
      entityType: 'fiscal_certificate',
      entityId: unit,
      detail: { reason: req.body?.reason },
    });
    res.json(view);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ CSC da NFC-e (GAP-PRD-075)

/*
  O CSC MORA NO NÚCLEO — era a última porta fiscal fora do `coreRouter`.

  Estas duas rotas moravam no `nfceRouter` legado (`/fiscal/nfce/csc`), o que
  sobrou das vinte rotas sobre `nfce_documents` que o GAP-PRD-096 apagou. O
  dado é o mesmo — `nfce_settings`, uma linha por (empresa, unidade, ambiente),
  com o token cifrado pelo cofre fiscal — e é o que a NFC-e do núcleo lê para
  assinar o QR Code (`acharCscDaOperacao`). Um escritor (`upsertNfceCsc`), um
  leitor de emissão, uma porta.

  Alcance: o mesmo que o roteador legado cobrava (`fiscal.nfce.csc.manage`, o
  "escrever" do módulo fiscal): admin_geral, gestor e gerente_loja. A empresa
  vem SEMPRE do token; a unidade é a da operação (GAP-PRD-180).

  O GET devolve só `items`. O legado espalhava também `items[0]` no topo — mas
  sanitizando de novo uma linha já sanitizada, o que dava `hasCsc: false` com
  CSC configurado; a tela nunca leu o topo (`envelope('items')`).
*/
coreRouter.get('/fiscal/nfce/csc', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId } = scope(req);
    res.json({ items: listNfceCscSettings(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/nfce/csc', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    // Dois cliques no botão não viram duas gravações (nem duas linhas de auditoria).
    const idempotencyKey = requireIdempotencyKey(req.headers['idempotency-key'] as string);
    const payload = withIdempotency(idempotencyKey, companyId, () => {
      const row = upsertNfceCsc({
        companyId,
        // GAP-PRD-180: o CSC vai para onde a NFC-e o procura.
        operationalUnitId: unidadeFiscalDoPedido(req.body?.operationalUnitId),
        cscId: String(req.body?.cscId ?? ''),
        cscToken: String(req.body?.cscToken ?? ''),
        // O valor vai CRU ao serviço, que tem a lista fechada (GAP-PRD-022).
        environment: (req.body?.environment ?? 'homologation') as AmbienteDoCsc,
      });
      // A trilha do gesto — qual ambiente, qual ID, quem —, nunca o token.
      recordAudit({
        companyId,
        userId,
        action: 'fiscal.nfce_csc.upsert',
        entityType: 'nfce_csc',
        entityId: String(row.id),
        detail: {
          environment: row.environment,
          cscId: row.cscId,
          operationalUnitId: row.operationalUnitId,
        },
      });
      return sanitizeNfceCscForResponse(row);
    }, requisicaoDe(req));
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- PIX do balcão pelo Asaas (GAP-PRD-077)
//
// Sem maquininha, o PIX do balcão era lançado à mão depois de o operador
// conferir o app do banco — e a tela prometia um QR que não existia. Estas
// rotas geram o QR na conta da operação, acompanham a confirmação e dão à
// gerência a fila do que ficou pendente.

coreRouter.get('/pdv/pix-asaas/status', (req: AuthedRequest, res, next) => {
  try {
    /*
      Se o balcão pode gerar QR pelo provedor. Mesma família do status da
      maquininha: quem abre o diálogo de pagamento (PDV e Orçamentos) pergunta.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(statusDoPixDoBalcao(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/pix-asaas', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      // Quem fecha venda gera o QR dela: o mesmo alcance de POST /sales.
      requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
      const { companyId, userId } = scope(req);
      const pix = await criarPixDoBalcao({
        companyId,
        userId,
        amountCents: Number(req.body?.amountCents ?? 0),
        referencia: String(req.body?.referencia ?? ''),
        customerId: req.body?.customerId ? String(req.body.customerId) : null,
        pagadorDocumento: req.body?.pagadorDocumento ? String(req.body.pagadorDocumento) : null,
        pagadorNome: req.body?.pagadorNome ? String(req.body.pagadorNome) : null,
      });
      recordAudit({
        companyId,
        userId,
        action: 'sale.pix_balcao_gerado',
        entityType: 'payment_intent',
        entityId: pix.intentId,
        detail: { amountCents: pix.amountCents, status: pix.status, environment: pix.environment },
      });
      res.status(201).json(pix);
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.get('/pdv/pix-asaas/:id', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      // A tela do caixa consulta; `?consultar=1` pergunta ao provedor.
      abertaAo(req, 'balcao', 'escritorio');
      const { companyId } = scope(req);
      res.json(
        await consultarPixDoBalcao({
          companyId,
          intentId: String(req.params.id),
          consultar: req.query.consultar === '1',
        }),
      );
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.post('/pdv/pix-asaas/:id/cancel', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
      const { companyId, userId } = scope(req);
      const pix = await cancelarPixDoBalcao({ companyId, intentId: String(req.params.id) });
      recordAudit({
        companyId,
        userId,
        action: 'sale.pix_balcao_cancelado',
        entityType: 'payment_intent',
        entityId: pix.intentId,
        detail: { amountCents: pix.amountCents },
      });
      res.json(pix);
    } catch (err) {
      next(err);
    }
  })();
});

/*
  A FILA DOS PIX PENDENTES DO BALCÃO — é da gerência: é quem cobra o que não
  caiu e decide o que fazer com a venda. A tela é Contas a receber (gestão).
*/
coreRouter.get('/pdv/pix-pendentes', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: listarPixPendentesDoBalcao(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/sales/:id/payments/:paymentId/confirmar', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      // Afirmar que o dinheiro entrou é da gerência — com o PIX do provedor,
      // quem afirma é o provedor, consultado aqui mesmo.
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const r = await confirmarPixPendente({
        companyId,
        saleId: String(req.params.id),
        paymentId: String(req.params.paymentId),
        userId,
        note: typeof req.body?.note === 'string' ? req.body.note : null,
      });
      recordAudit({
        companyId,
        userId,
        action: 'sale.pix_pendente_confirmado',
        entityType: 'sale',
        entityId: String(req.params.id),
        detail: { paymentId: String(req.params.paymentId), liquidada: r.liquidada, note: req.body?.note ?? null },
      });
      res.json(r);
    } catch (err) {
      next(err);
    }
  })();
});

// ------------------------------------------------------ maquininha no PDV

coreRouter.get('/pdv/terminal/status', (req: AuthedRequest, res, next) => {
  try {
    /*
      Se a maquininha está configurada. O diálogo de pagamento vive no PDV e em
      Orçamentos; a cobrança em si (POST /charge) já exigia caixa ou gerente.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    // A maquininha é por caixa (GAP-PRD-014): o PDV diz de qual caixa pergunta;
    // o do token de dispositivo vence, como na gaveta.
    const caixa = caixaNoEscopo(req, { informado: req.query.terminalId, doDispositivo: req.auth?.storeId });
    assertTerminalDaEmpresa(companyId, caixa);
    res.json(getTerminalStatus(companyId, caixa));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/terminal/charge', (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      requireProfile(req, ...BALCAO_E_GERENCIA);
      const { companyId, userId } = scope(req);
      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
      if (!idempotencyKey) {
        throw new ApiError(
          'CORE_IDEMPOTENCY_REQUIRED',
          'Header Idempotency-Key é obrigatório — sem ele um reenvio cobraria o cliente duas vezes.',
          400,
        );
      }
      const caixa = caixaNoEscopo(req, { informado: req.body?.terminalId, doDispositivo: req.auth?.storeId });
      assertTerminalDaEmpresa(companyId, caixa);
      res.json(
        await chargeOnTerminal({
          companyId,
          userId,
          method: String(req.body?.method ?? ''),
          amountInCents: Number(req.body?.amountInCents ?? 0),
          installments: req.body?.installments ? Number(req.body.installments) : undefined,
          idempotencyKey,
          scenario: req.body?.scenario,
          // A cobrança vai para a maquininha DESTE caixa (GAP-PRD-014).
          pdvTerminalId: caixa,
        }),
      );
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.get('/pdv/terminal/uncertain', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: listUncertainPayments(companyId) });
  } catch (err) {
    next(err);
  }
});

/*
  O DINHEIRO DA MAQUININHA SEM DONO (GAP-PRD-078) E O ESTORNO A FAZER DE VENDA
  DESFEITA (GAP-PRD-080): a segunda e a terceira filas do gestor, ao lado da
  de não confirmadas. Mesmos perfis de `/uncertain` e `/reconcile` — decidir o
  que foi feito com o dinheiro da operadora não é do balcão.

  Antes de `/pdv/terminal/:id`: declarada depois, "pendencias" seria lido
  como id de transação.
*/
coreRouter.get('/pdv/terminal/pendencias', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const bruto = req.query.minutos;
    res.json(
      listarPendenciasDaMaquininha(companyId, {
        minutos: bruto === undefined || bruto === '' ? undefined : Number(bruto),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * O balcão desiste da cobrança — e a operadora fica sabendo (GAP-PRD-078).
 *
 * Era "Desistir desta cobrança" só na tela: o PIX continuava no aparelho, o
 * cliente pagava depois e o dinheiro virava órfão. O operador desiste da
 * cobrança que ELE fez; a do colega é do gestor (o serviço confere).
 */
coreRouter.post('/pdv/terminal/:id/desistir', (req: AuthedRequest, res, next) => {
  (async () => {
    try {
      requireProfile(req, ...BALCAO_E_GERENCIA);
      const { companyId, userId, profiles } = scope(req);
      res.json(
        await desistirDaCobranca({
          companyId,
          userId,
          profiles,
          transactionId: String(req.params.id),
          reason: req.body?.reason,
        }),
      );
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.post('/pdv/terminal/:id/tratativa', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      registrarTratativa({
        companyId,
        userId,
        transactionId: String(req.params.id),
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/terminal/:id/vincular-venda', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      vincularCobrancaAVenda({
        companyId,
        userId,
        transactionId: String(req.params.id),
        saleId: req.body?.saleId ? String(req.body.saleId) : null,
        saleNumber:
          req.body?.saleNumber === undefined || req.body?.saleNumber === null || req.body?.saleNumber === ''
            ? null
            : Number(req.body.saleNumber),
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** O gestor afirma que o estorno da venda desfeita foi feito no aparelho (GAP-PRD-080). */
coreRouter.post('/pdv/terminal/:id/estorno-manual', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      registrarEstornoManual({
        companyId,
        userId,
        transactionId: String(req.params.id),
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/*
  AS MAQUININHAS DA OPERAÇÃO, PARA O GESTOR LIGAR E DESLIGAR (GAP-PRD-001).

  Não existia rota nem tela: a configuração `mock` ativa no banco real da
  Preço Justo só sairia com alguém abrindo o SQLite. Os mesmos perfis da
  conferência (`/uncertain` e `/reconcile`), e pelo mesmo motivo: desligar a
  maquininha desliga a exigência de cobrança aprovada no cartão — o caixa não
  pode tirar do caminho a regra que confere o próprio trabalho.

  Ficam ANTES de `/pdv/terminal/:id`: declarada depois, "configurations"
  seria lida como id de transação.
*/
coreRouter.get('/pdv/terminal/configurations', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(listTerminalConfigurationsForManager(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/terminal/configurations/:id/deactivate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      setTerminalConfigurationActive({
        companyId,
        userId,
        configurationId: String(req.params.id),
        active: false,
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/terminal/configurations/:id/activate', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      setTerminalConfigurationActive({
        companyId,
        userId,
        configurationId: String(req.params.id),
        active: true,
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/pdv/terminal/:id', (req: AuthedRequest, res, next) => {
  try {
    /*
      Uma cobrança da maquininha pelo id. Mesma família do status — e note que
      `/pdv/terminal/uncertain`, que lista as pendentes de todo mundo, é mais
      estreita de propósito: exige gerente.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(getTerminalPayment(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Confirma um PIX no provedor de TESTE.
 *
 * Existe para que o fluxo assíncrono do PIX na maquininha seja percorrível sem
 * aparelho físico. O serviço recusa fora do provedor mock — com adquirente
 * real, quem confirma é ela, e esta porta não abre.
 *
 * Fica DEPOIS de `/uncertain` porque o Express casa na ordem de declaração:
 * uma rota com parâmetro declarada antes engoliria o caminho literal.
 */
coreRouter.post('/pdv/terminal/:id/confirmar-teste', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    res.json(
      confirmarPixDeTeste({ companyId, userId, transactionId: String(req.params.id) }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/pdv/terminal/:id/reconcile', (req: AuthedRequest, res, next) => {
  try {
    // Afirmar o que a operadora fez é decisão de gestor, não do balcão.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      reconcileTerminalPayment({
        companyId,
        userId,
        transactionId: String(req.params.id),
        outcome: req.body?.outcome,
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- orçamento e pré-venda

coreRouter.get('/quotes', (req: AuthedRequest, res, next) => {
  try {
    /*
      Orçamento e pré-venda nascem no balcão e são revistos na gestão
      (ROTA_PDV + ROTA_GESTAO). O POST ao lado já aceitava caixa, gerente de
      loja e atendente.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    // Página e total (GAP-PRD-070): o 101º documento sumia sem aviso.
    const recorte = {
      kind: req.query.kind as 'orcamento' | 'pre_venda' | undefined,
      status: req.query.status as 'aberto' | 'convertido' | 'expirado' | 'cancelado' | undefined,
    };
    const pagina = lerPagina(req.query, 100);
    res.json({
      items: listQuotes(companyId, { ...recorte, ...pagina }),
      total: countQuotes(companyId, recorte),
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/quotes/:id', (req: AuthedRequest, res, next) => {
  try {
    /** O documento aberto, para converter em venda. Mesmo alcance da lista. */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const quote = getQuoteDetail(companyId, String(req.params.id));
    if (!quote) throw new ApiError('CORE_QUOTE_NOT_FOUND', 'Documento não encontrado.', 404);
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/quotes', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    /*
      A ALÇADA ENTRA AQUI, e este é o lado da rodada que fecha a venda em duas
      etapas.

      O orçamento era a porta dos fundos do PDV: o mesmo operador escrevia a
      moto de R$ 12.000 por R$ 1,00 num documento, convertia segundos depois, e
      a venda saía sem que ninguém assinasse nada — POST /core/sales recusava,
      POST /core/quotes não conferia. A concessão passa a ser medida ONDE O
      PREÇO É ESCRITO, que é também onde não há cliente no balcão esperando o
      troco. A conversão, em troca, deixa de cobrar de novo (ver o cabeçalho de
      `convertQuote`).
    */
    const quote = createQuote({
      companyId,
      userId,
      kind: req.body?.kind,
      items: req.body?.items ?? [],
      customerId: req.body?.customerId ?? null,
      sellerId: req.body?.sellerId ?? null,
      discountCents: req.body?.discountCents,
      validUntil: req.body?.validUntil
        ? comoInstanteFinal(String(req.body.validUntil))
        : null,
      note: req.body?.note ?? null,
      alcada: {
        profileCodes: scope(req).profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
    });
    recordAudit({
      companyId,
      userId,
      action: `quote.create.${quote.kind}`,
      entityType: 'quote',
      entityId: quote.id,
      // A concessão do documento fica na trilha mesmo quando coube no limite:
      // é a venda que PASSOU — dentro da alçada, ou liberada — que o dono
      // precisa revisar depois para descobrir um padrão.
      detail: { total: quote.total_cents, authorizationId: req.body?.authorizationId ?? null },
    });
    res.status(201).json(quote);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/quotes/:id/convert', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }
    const result = convertQuote({
      companyId,
      userId,
      quoteId: String(req.params.id),
      idempotencyKey,
      payments: req.body?.payments ?? [],
      cashSessionId: req.body?.cashSessionId ?? null,
      /*
        O VALE DO CLIENTE ABATE A CONVERSÃO (GAP-V10/V47).

        Este campo não era lido aqui: quem o mandasse via a venda fechar pelo
        total cheio com o saldo intacto, sem erro nenhum. Ele viaja igual ao de
        POST /core/sales — só o VALOR, nunca o dono. De quem é o saldo já está
        dito pelo DOCUMENTO, e aceitar um dono pelo corpo deixaria o balcão
        pagar a pré-venda de um cliente com o vale de outro.

        As três recusas (sem cliente, acima do total, acima do saldo) moram no
        serviço, dentro da transação da conversão, porque uma conferência feita
        aqui fora se desatualiza entre a leitura e a gravação.
      */
      customerCreditCents: req.body?.customerCreditCents,
      // O chassi bipado na conversão (GAP-PRD-025). Ausente: a moto que o
      // documento segura, ou a mais antiga livre do pátio.
      unidades: lerUnidadesPedidas(req.body?.unidades),
      // Quem converte responde pelo PISO de preço do produto
      // (A-produto-17#orcamento) — só o piso: a concessão foi conferida
      // quando o documento foi escrito (ver `convertQuote`).
      alcada: {
        profileCodes: scope(req).profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
    });
    recordAudit({
      companyId,
      userId,
      action: 'quote.convert',
      entityType: 'quote',
      entityId: String(req.params.id),
      // A diferença entre o que o documento tinha aprovado e o que a venda de
      // hoje concede é o preço de NÃO barrar aqui — ver `convertQuote`. Ela
      // já vira uma linha própria de auditoria lá dentro quando é positiva;
      // aqui ela acompanha a conversão para que a leitura por documento não
      // precise cruzar duas ações.
      detail: {
        saleId: result.saleId,
        concessaoAutorizadaCents: result.concessaoAutorizadaCents,
        concessaoNaVendaCents: result.concessaoNaVendaCents,
        diferencaCents: result.diferencaCents,
        // O par em PERCENTUAL acompanha o par em centavos porque é ele quem
        // decide se a conversão virou linha própria de auditoria — ver o bloco
        // da comparação em `convertQuote`. Registrar só os centavos deixaria a
        // leitura por documento sem o número que motivou o registro.
        percentualAutorizado: result.percentualAutorizado,
        percentualNaVenda: result.percentualNaVenda,
        // Quanto do vale do cliente esta conversão consumiu. A razão de crédito
        // já guarda o fato e a venda em que ele saiu; a trilha guarda QUEM o
        // fez e por qual documento — que é a pergunta que se faz quando um
        // saldo some sem o cliente reconhecer a compra.
        creditoDeLojaCents: result.customerCreditCents || undefined,
      },
    });
    // A venda da conversão também é venda: a mesma NFC-e no Finalizar (GAP-PRD-163).
    const nfce = emitirNoFinalizar({ companyId, saleId: String(result.saleId), userId });
    res.status(201).json({ ...result, nfceNoFinalizar: nfce.disparo });
  } catch (err) {
    next(err);
  }
});

/**
 * A pré-venda segura AQUELA moto (GAP-PRD-111): o chassi que o cliente do sinal
 * viu no pátio. Substitui o que o documento segurava deste produto; lista vazia
 * solta. Os mesmos perfis que escrevem o documento.
 */
coreRouter.put('/quotes/:id/unidades', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const productId = String(req.body?.productId ?? '').trim();
    if (!productId || !Array.isArray(req.body?.unitIds)) {
      throw new ApiError(
        'CORE_QUOTE_UNITS_INVALID',
        'Informe o produto e a lista de unidades a segurar.',
        400,
      );
    }
    const unidadesReservadas = reservarUnidadesDaPreVenda({
      companyId,
      quoteId: String(req.params.id),
      productId,
      unitIds: (req.body.unitIds as unknown[]).map(String),
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'quote.units.hold',
      entityType: 'quote',
      entityId: String(req.params.id),
      detail: {
        productId,
        unidades: unidadesReservadas
          .filter((r) => r.productId === productId)
          .map((r) => ({ unitId: r.unitId, rotulo: r.rotulo })),
      },
    });
    res.json({ unidadesReservadas });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/quotes/:id/promote', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    /*
      A PRÉ-VENDA NASCE COM VENCIMENTO. Sempre.

      Aprovar orçamento criava pré-venda com validUntil NULO, e a varredura que
      expira documentos filtra "valid_until IS NOT NULL" — ela ignorava
      justamente estas. Pré-venda RESERVA estoque: a peça sumia do disponível
      para sempre, sem nunca ter sido vendida, e ninguém tinha como saber por
      quê olhando o saldo.

      Os 7 dias existiam só na tela de quem digita o orçamento à mão. Agora o
      prazo é o da POLÍTICA da operação (nulo = os mesmos 7), e este é o leitor
      de reservation_valid_days: a coluna nasce nesta rodada já sendo lida, que
      é a única forma honesta de uma configuração nascer.

      O que a tela mandar continua ganhando: quem escolheu uma data escolheu.
      O padrão só cobre o caminho em que ninguém escolheu nada — que era
      exatamente o caminho que produzia a reserva eterna.
    */
    /*
      A ALÇADA TAMBÉM ENTRA AQUI, e só faz efeito num caso: orçamento anterior
      à rodada da trava, que nasceu sem `concession_cents` e portanto NUNCA foi
      conferido por ninguém. Aprovar é a primeira vez que alguém olha para
      aquele preço, e é onde a trava cobra (ver `promoteToPreSale`).

      Documento criado por esta rodada em diante já foi conferido na criação e
      passa direto — cobrar de novo pararia o balcão a cada reajuste de tabela.

      Os perfis são os mesmos de POST /core/quotes: quem aprova é quem está com
      o token na mão, e `scope` já os tem.
    */
    const preSale = promoteToPreSale({
      companyId,
      userId,
      quoteId: String(req.params.id),
      validUntil: req.body?.validUntil
        ? comoInstanteFinal(String(req.body.validUntil))
        : validadeDaReserva(companyId),
      alcada: {
        profileCodes: scope(req).profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
    });
    recordAudit({
      companyId,
      userId,
      action: 'quote.promote',
      entityType: 'quote',
      entityId: String(req.params.id),
      detail: { preSaleId: preSale.id },
    });
    res.status(201).json(preSale);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/quotes/:id/cancel', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    const quote = cancelQuote({
      companyId,
      quoteId: String(req.params.id),
      reason: req.body?.reason,
    });
    recordAudit({
      companyId,
      userId,
      action: 'quote.cancel',
      entityType: 'quote',
      entityId: String(req.params.id),
    });
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/quotes/expire-overdue', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ expired: expireOverdueQuotes(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * EDITAR O DOCUMENTO ABERTO (GAP-V66).
 *
 * Os MESMOS perfis de `POST /core/quotes`, e não os de gerência, porque é o
 * MESMO ato: escrever o documento. Quem pode montar o orçamento pode corrigir o
 * item que digitou errado — exigir gerente aqui empurraria o balcão de volta
 * para o contorno que esta rota existe para matar (cancelar e redigitar), que
 * ninguém precisa de permissão para fazer.
 *
 * A alçada desce igual à criação: a edição reescreve preço e desconto, que é
 * exatamente o que ela mede.
 */
coreRouter.patch('/quotes/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const quote = updateQuote({
      companyId,
      userId,
      quoteId: String(req.params.id),
      items: req.body?.items ?? [],
      // `undefined` significa "não mexa" e `null` significa "consumidor final":
      // são coisas diferentes, e o serviço as separa. Por isso a propriedade só
      // entra quando o corpo a trouxe.
      ...(req.body?.customerId === undefined ? {} : { customerId: req.body.customerId }),
      ...(req.body?.sellerId === undefined ? {} : { sellerId: req.body.sellerId }),
      discountCents: req.body?.discountCents,
      // A OBSERVAÇÃO SEGUE A MESMA RÉGUA DOS DOIS DE CIMA, e não seguia.
      //
      // O DEFEITO: `note: req.body?.note ?? null` mandava `null` tanto para
      // quem apagou o texto quanto para quem nem citou o campo — e o serviço,
      // sem saber a diferença, resolvia com `COALESCE(?, note)`, que mantinha
      // o texto ANTIGO nos DOIS casos. Não existia caminho para apagar a
      // observação de um documento aberto.
      ...(req.body?.note === undefined ? {} : { note: req.body.note }),
      alcada: {
        profileCodes: scope(req).profiles,
        authorizationId: req.body?.authorizationId ?? null,
      },
    });
    // A trilha do QUE mudou é gravada dentro de `updateQuote`, que é quem
    // conhece o antes. Aqui não se grava um segundo `quote.update` com metade
    // da informação — duas linhas para o mesmo fato fariam a leitura por
    // documento contar a edição duas vezes.
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

/**
 * RENOVAR A VALIDADE (GAP-V66) — o beco que três mensagens anunciavam.
 *
 * `convertQuote` e `promoteToPreSale` mandam "renove a validade" desde que
 * existem, e a tela repetia a frase. Não havia rota nenhuma.
 *
 * Mesmos perfis da criação, pelo mesmo motivo da edição — e com uma razão a
 * mais: renovar não mexe em preço, item nem reserva, então não há concessão
 * nova para medir. É o gesto mais barato deste módulo.
 */
coreRouter.post('/quotes/:id/renew', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const quote = renewQuote({
      companyId,
      userId,
      quoteId: String(req.params.id),
      // A data vai PURA e o servidor a fecha no último instante do dia da loja
      // — a mesma régua de `POST /core/quotes`. Ausente, vale a política.
      validUntil: req.body?.validUntil ? comoInstanteFinal(String(req.body.validUntil)) : null,
      reason: req.body?.reason ?? null,
    });
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- consignação / condicional

/*
  A MERCADORIA QUE SAI DA LOJA SEM VENDA (GAP-V65).

  Seis portas, e o alcance de cada uma segue o que ela FAZ, não o módulo:

  - as duas de LEITURA são `abertaAo('balcao', 'escritorio')`, o mesmo alcance
    de `GET /quotes`: quem está no balcão precisa saber o que a cliente levou
    antes de conferir o que ela trouxe de volta;
  - REMESSA e RETORNO nomeiam os caixas, os gerentes e o atendente — os mesmos
    de `POST /core/quotes`, porque é o mesmo balcão que escreve;
  - FATURAR cria VENDA, e por isso é `BALCAO_E_GERENCIA` sem o atendente,
    exatamente como `POST /quotes/:id/convert`;
  - FECHAR é `BALCAO_E_GERENCIA` pela mesma razão: declarar que não sobrou nada
    lá fora é dar por encerrada uma custódia.

  As seis são fechadas ao contador: mandar mercadoria para a rua e faturá-la é
  operação da empresa, e ele é quem RECEBE o pacote do mês.
*/
coreRouter.get('/consignments', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listConsignacoes(companyId, {
        status: req.query.status as 'aberta' | 'fechada' | undefined,
        customerId: req.query.customerId as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/consignments/:id', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const consignacao = getConsignacao(companyId, String(req.params.id));
    if (!consignacao) {
      throw new ApiError('CORE_CONSIGNMENT_NOT_FOUND', 'Consignação não encontrada.', 404);
    }
    res.json(consignacao);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/consignments', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    /*
      A CHAVE É OBRIGATÓRIA AQUI TAMBÉM — e era a única das três que não pedia.

      O DEFEITO: a remessa é o evento de estoque MAIS caro do módulo (tira
      mercadoria do saldo sem venda) e era o único sem `Idempotency-Key`. Um
      reenvio de rede ou uma aba duplicada criava DUAS consignações, sob dois
      números, tirando a mesma mercadoria do saldo duas vezes — e nenhum CHECK
      do banco reage a isso, porque as duas remessas são, cada uma, legítimas.
      `loading={busy}` na tela segura o clique duplo do mesmo navegador e nada
      além disso.
    */
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }
    const consignacao = criarConsignacao({
      companyId,
      userId,
      customerId: req.body?.customerId,
      sellerId: req.body?.sellerId ?? null,
      items: req.body?.items ?? [],
      validUntil: req.body?.validUntil ? comoInstanteFinal(String(req.body.validUntil)) : null,
      note: req.body?.note ?? null,
      idempotencyKey,
    });
    // A trilha completa (itens, valor declarado) é gravada em
    // `criarConsignacao`, que é quem conhece os preços resolvidos.
    //
    // 200 no reenvio, 201 na remessa nova — a mesma distinção de `/retorno` e
    // `/faturar`. Devolver 201 nos dois faria a tela comemorar uma saída de
    // mercadoria que não aconteceu.
    res.status(consignacao.duplicated ? 200 : 201).json(consignacao);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/consignments/:id/retorno', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    /*
      A CHAVE É OBRIGATÓRIA, e aqui ela vale tanto quanto na venda: o clique
      duplo devolveria ao saldo mercadoria que continua na casa da cliente, e o
      CHECK do banco só reagiria se a soma estourasse a remessa — um retorno de
      2 em 5 passaria duas vezes calado.
    */
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }
    const resultado = registrarRetorno({
      companyId,
      userId,
      consignmentId: String(req.params.id),
      idempotencyKey,
      items: req.body?.items ?? [],
      note: req.body?.note ?? null,
    });
    // 200 no reenvio, 201 no retorno novo — a mesma distinção de `/faturar` e
    // do recebimento da OS. Devolver 201 nos dois faria a tela comemorar uma
    // devolução que não aconteceu.
    res.status(resultado.duplicated ? 200 : 201).json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/consignments/:id/faturar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }
    const result = faturarConsignacao({
      companyId,
      userId,
      consignmentId: String(req.params.id),
      idempotencyKey,
      items: req.body?.items ?? [],
      payments: req.body?.payments ?? [],
      cashSessionId: req.body?.cashSessionId ?? null,
      note: req.body?.note ?? null,
    });
    res.status(result.duplicated ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/consignments/:id/fechar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA);
    const { companyId, userId } = scope(req);
    res.json(fecharConsignacao({ companyId, userId, consignmentId: String(req.params.id) }));
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- vendas

/**
 * O CORPO DA VENDA, VIRADO `createSale` — um lugar só (GAP-PRD-045).
 *
 * `POST /sales` e o relançamento da venda guardada offline montam a MESMA
 * entrada: se cada rota mapeasse o corpo do seu jeito, o primeiro campo novo
 * da venda (um desconto, um vale) entraria numa e faltaria na outra — e a
 * venda relançada sairia diferente da que o balcão fez.
 */
function vendaDoCorpo(
  req: AuthedRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  corpo: Record<string, any>,
  idempotencyKey: string,
  /**
   * Os perfis com que a ALÇADA é medida, quando não são os do token — a venda
   * guardada sem servidor, reenviada pela sessão de outra pessoa
   * (G-offline-sync-M03, `alcadaDaVendaGuardada`).
   */
  opcoes: {
    perfisDaAlcada?: string[];
    /**
     * A hora em que a venda guardada aconteceu no balcão (G-offline-sync-14) —
     * só `POST /sales`, e só com `vendaGuardada` no corpo. `createSale`
     * confere e decide se ela vira a hora da venda.
     */
    vendidaEm?: string | null;
  } = {},
) {
  const { companyId, userId } = scope(req);
  return createSale({
    vendidaEm: opcoes.vendidaEm ?? null,
    companyId,
    userId,
    idempotencyKey,
    items: corpo?.items ?? [],
    payments: corpo?.payments ?? [],
    customerId: corpo?.customerId ?? null,
    sellerId: corpo?.sellerId ?? null,
    terminalId: caixaNoEscopo(req, {
      informado: corpo?.terminalId,
      doDispositivo: req.auth?.storeId,
    }),
    cashSessionId: corpo?.cashSessionId ?? null,
    // A venda de balcão cai num turno qualquer que seja a forma de pagamento
    // (E-venda-servidor-08): quem diz que é balcão é a rota, nunca o corpo.
    canal: 'balcao',
    discountCents: corpo?.discountCents,
    surchargeCents: corpo?.surchargeCents,
    origin: corpo?.origin,
    note: corpo?.note,
    // O rastro do que saiu do carrinho antes do Finalizar (GAP-V52/V63).
    // Quem removeu é o usuário do TOKEN — o serviço ignora autor do corpo.
    cancelledItems: Array.isArray(corpo?.cancelledItems)
      ? corpo.cancelledItems
      : undefined,
    /*
      Quanto do CRÉDITO DE LOJA esta venda abate (GAP-V10/V47).

      Só o VALOR viaja: de quem é o saldo já está dito por `customerId`, e
      aceitar um "creditCustomerId" do corpo deixaria o balcão gastar o vale
      de outra pessoa. As três recusas — sem cliente, acima do total, acima do
      saldo — moram no serviço, dentro da transação da venda, porque uma
      checagem feita aqui fora se desatualiza entre a conferência e a
      gravação.
    */
    customerCreditCents: corpo?.customerCreditCents,
    alcada: {
      profileCodes: opcoes.perfisDaAlcada ?? scope(req).profiles,
      authorizationId: corpo?.authorizationId ?? null,
    },
  });
}

/**
 * O CARRINHO MONTADO QUE O F6 APAGOU DEIXA RASTRO (D-pdv-teclado-12).
 *
 * O DEFEITO: a confirmação do F6 existia, mas o carrinho cancelado sumia sem
 * registro nenhum — o carrinho é local e o servidor só ficava sabendo da venda
 * no Finalizar. Trinta itens bipados, mostrados ao cliente e apagados: o
 * gerente não tinha como saber que aquilo aconteceu, nem quem fez.
 *
 * Aqui o PDV conta o que saiu da tela, e o SERVIDOR carimba quem e quando, pelo
 * token — na trilha de auditoria (`pdv.cart.abandoned`), onde a gerência lê.
 * Não mexe em estoque nem em caixa: carrinho cancelado não é venda.
 */
coreRouter.post('/sales/abandoned', (req: AuthedRequest, res, next) => {
  try {
    // Rota nova nasce pela capability (catraca das guardas legadas): pdv.sell é a
    // mesma de POST /sales e alcança exatamente os mesmos perfis.
    requireCapability(req, 'pdv.sell');
    const { companyId, userId } = scope(req);
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const saleKey = String(corpo.saleKey ?? '').trim();
    if (!saleKey || saleKey.length > 200) {
      throw new ApiError(
        'CORE_ABANDONED_CART_KEY_REQUIRED',
        'Falta a chave da venda cancelada (saleKey): sem ela o registro não se liga a nada. Recarregue o PDV e tente de novo.',
        400,
      );
    }
    const brutos = Array.isArray(corpo.items) ? (corpo.items as unknown[]) : [];
    if (brutos.length === 0) {
      throw new ApiError(
        'CORE_ABANDONED_CART_EMPTY',
        'Carrinho sem itens não é venda cancelada: não há o que registrar.',
        400,
      );
    }
    if (brutos.length > 500) {
      throw new ApiError(
        'CORE_ABANDONED_CART_TOO_LARGE',
        'O carrinho cancelado passa de 500 linhas — confira o PDV antes de registrar.',
        400,
      );
    }
    const itens = brutos.map((bruto, n) => {
      const i = (bruto ?? {}) as Record<string, unknown>;
      const productId = String(i.productId ?? '').trim();
      const name = String(i.name ?? '').trim().slice(0, 200);
      const quantity = Number(i.quantity);
      const unitPriceCents = Number(i.unitPriceCents);
      if (
        !productId
        || !Number.isFinite(quantity)
        || !(quantity > 0)
        || !Number.isInteger(unitPriceCents)
        || unitPriceCents < 0
      ) {
        throw new ApiError(
          'CORE_ABANDONED_CART_INVALID_ITEM',
          `A linha ${n + 1} do carrinho cancelado veio incompleta (produto, quantidade maior que zero e preço em centavos). Recarregue o PDV e tente de novo.`,
          400,
          { index: n },
        );
      }
      return { productId, name, quantity, unitPriceCents };
    });
    const totalCents = itens.reduce((s, i) => s + Math.round(i.quantity * i.unitPriceCents), 0);
    const opcional = (v: unknown) => {
      const t = typeof v === 'string' ? v.trim().slice(0, 100) : '';
      return t || null;
    };
    recordAudit({
      companyId,
      userId,
      action: 'pdv.cart.abandoned',
      entityType: 'sale_key',
      entityId: saleKey,
      detail: {
        itens,
        totalCents,
        terminalId: opcional(corpo.terminalId),
        customerId: opcional(corpo.customerId),
      },
    });
    res.status(201).json({ ok: true, totalCents });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/sales', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    // A chave de idempotência é do cliente (PDV), para que reenvio após queda
    // de rede não gere uma segunda venda.
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    if (!idempotencyKey) {
      throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key é obrigatório.', 400);
    }
    // A forma das chaves que o servidor deriva (pré-venda, consignação, OS,
    // venda nova da pendência) não é do cliente: ver `ChavesDoServidor`.
    recusarChaveDoServidor(idempotencyKey);

    /*
      A ALÇADA SAIU DAQUI, e este comentário é o registro de por quê.

      O que existia nesta rota media o desconto do RODAPÉ contra
      req.body.estimatedTotalCents — um total que o PRÓPRIO PDV informava. Três
      defeitos num bloco só:

        - o denominador vinha do cliente: mandar um total inflado passava
          QUALQUER desconto sem gestor;
        - desconto de LINHA não passava por aqui, bastava digitar o desconto no
          item em vez do rodapé;
        - preço unitário rebaixado não passava por nada.

      O corpo pode continuar enviando estimatedTotalCents — o PDV ainda envia,
      e não é papel desta rodada mexer na tela. O campo é IGNORADO: ele é a
      opinião do cliente sobre o preço, e a alçada é medida contra o preço
      vigente que só o servidor conhece. Aceitá-lo "só como dica" seria manter
      viva a porta que esta rodada veio fechar.

      Quem decide agora é createSale, que é onde o preço de cada linha é
      calculado. Esta rota informa apenas o que só ela sabe: quem está no
      balcão e se um gestor já liberou.
    */
    // A venda guardada sem servidor que a fila reenvia com a sessão de OUTRA
    // pessoa: a alçada é a de quem vendeu, e a trilha diz quem vendeu, quem
    // enviou e quando a venda aconteceu (G-offline-sync-M03 / 14).
    const guardada = alcadaDaVendaGuardada({
      companyId,
      userId,
      perfisDoToken: scope(req).profiles,
      vendaGuardada: req.body?.vendaGuardada,
    });
    const result = vendaDoCorpo(req, req.body ?? {}, idempotencyKey, {
      perfisDaAlcada: guardada?.perfis,
      // A venda guardada entra com a hora em que aconteceu, quando ela passa
      // pelas conferências do serviço (G-offline-sync-14).
      vendidaEm: guardada ? String(req.body?.vendaGuardada?.queuedAt ?? '') : null,
    });
    if (!result.duplicated) {
      recordAudit({
        companyId,
        userId,
        action: 'sale.create',
        entityType: 'sale',
        entityId: result.sale.id,
        // A CONCESSÃO FICA REGISTRADA MESMO QUANDO PASSOU.
        //
        // Só o que é barrado vira erro; o que passa some. E é justamente a
        // venda que passou — dentro do limite, ou liberada por um gestor — que
        // o dono precisa conseguir revisar depois, para descobrir que um
        // operador dá 9,9% todos os dias.
        detail: {
          total: result.sale.total_cents,
          concessao: result.concessao,
          authorizationId: req.body?.authorizationId ?? null,
          // A venda guardada sem servidor: quem vendeu, quem enviou e quando
          // ela aconteceu no balcão (G-offline-sync-M03 / 14).
          ...(guardada
            ? {
                vendaGuardada: {
                  vendidaPor: guardada.vendidaPor,
                  enviadaPor: userId,
                  vendidaEm: guardada.vendidaEm,
                  // Com que hora ela entrou, e por que não foi a do PDV
                  // quando não foi (G-offline-sync-14).
                  registradaEm: result.horaDaVenda?.instante ?? result.sale.created_at,
                  motivoDaHora: result.horaDaVenda?.motivo ?? null,
                },
              }
            : {}),
          // Quantos itens saíram do carrinho antes do Finalizar — o número que
          // o rodapé do PDV mostra ao vivo, agora com leitor na trilha central.
          itensCancelados: result.cancelados,
          // Quanto do vale do cliente esta venda consumiu. A razão de crédito
          // já guarda o fato; a trilha guarda QUEM o fez, que é a pergunta que
          // se faz quando um saldo some sem o cliente reconhecer a compra.
          creditoDeLojaCents: Number(req.body?.customerCreditCents ?? 0) || undefined,
        },
      });
    }
    /*
      A NFC-e NO FINALIZAR (GAP-PRD-163). No modo automático, com a venda
      pronta, a emissão dispara em segundo plano DEPOIS desta resposta — a
      venda nunca espera a SEFAZ nem cai por causa dela. A venda repetida pela
      mesma chave não dispara de novo.
    */
    const nfce = result.duplicated
      ? null
      : emitirNoFinalizar({ companyId, saleId: String(result.sale.id), userId });
    res
      .status(result.duplicated ? 200 : 201)
      .json(nfce ? { ...result.sale, nfceNoFinalizar: nfce.disparo } : result.sale);
  } catch (err) {
    next(err);
  }
});


// ------------------------------------------- vendas guardadas offline recusadas
/*
  A VENDA QUE O SERVIDOR RECUSOU DEPOIS DE O DINHEIRO ENTRAR (GAP-PRD-045/046).

  O PDV guarda a venda na fila do navegador quando o servidor não responde, e
  reenvia quando ele volta. Recusada de vez — o caixa daquele turno fechou, o
  estoque acabou —, ela é ENTREGUE aqui (corpo original, mesma chave) e passa
  a ser do servidor: visível ao gestor e aos outros caixas, e fora do risco da
  máquina do caixa. Sai por relançar (mesma chave, gaveta aberta) ou descartar
  (gerência, com motivo). Ver `VendasOfflineRecusadas`.
*/
coreRouter.get('/offline-sales', (req: AuthedRequest, res, next) => {
  try {
    // Ler é do balcão e do escritório: qualquer caixa da operação vê a venda
    // presa de outro caixa, e o gestor vê todas.
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const status = String(req.query.status ?? 'pendente');
    res.json({
      items: listarVendasOfflineRecusadas(companyId, {
        status: (['pendente', 'regularizada', 'descartada', 'todas'].includes(status)
          ? status
          : 'pendente') as 'pendente',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/offline-sales', (req: AuthedRequest, res, next) => {
  try {
    // Quem entrega é o PDV que guardou a venda: o mesmo alcance de POST /sales.
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const r = registrarVendaOfflineRecusada({
      companyId,
      userId,
      idempotencyKey: req.body?.idempotencyKey,
      label: req.body?.label,
      body: req.body?.body,
      queuedAt: req.body?.queuedAt,
      errorCode: req.body?.errorCode,
      errorMessage: req.body?.errorMessage,
    });
    res.status(r.jaSubiu ? 200 : 201).json(r);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/offline-sales/:id/relaunch', (req: AuthedRequest, res, next) => {
  try {
    // Relançar é VENDER: o mesmo alcance e a mesma régua de POST /sales
    // (alçada de desconto, gaveta aberta do mesmo caixa, estoque).
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const id = String(req.params.id);
    const guardada = corpoDaVendaOffline(companyId, id);
    /*
      A GAVETA É A DO DINHEIRO, E NÃO A DE QUEM CLICA (G-offline-sync-10).
      Esta rota sobrescrevia gaveta e caixa com o que o pedido mandava — a
      gaveta aberta do computador de quem relança —, e a venda do Caixa 1
      entrava na gaveta do Caixa 2. Agora: a gaveta da venda ainda aberta, ou
      a aberta do mesmo caixa; só sem elas a do pedido, e a de outro caixa com
      confirmação. Ver `destinoDoRelancamento`.
    */
    const destino = destinoDoRelancamento({
      companyId,
      id,
      pedido: req.body,
      terminalDoDispositivo: req.auth?.storeId ?? null,
    });
    const cashSessionId = destino.cashSessionId;
    /*
      A LIBERAÇÃO PEDIDA EM "REGULARIZAR" (G-offline-sync-11). A venda feita
      sem servidor não tinha como pedir liberação antes de sair, e esta rota só
      usava a do corpo guardado — que offline não existe. Sem a do pedido, a
      pendência recusada por alçada só saía com um gestor logado no caixa.
    */
    const authorizationId =
      typeof req.body?.authorizationId === 'string' && req.body.authorizationId
        ? req.body.authorizationId
        : (guardada.corpo.authorizationId ?? null);
    const corpo = { ...guardada.corpo, cashSessionId, terminalId: destino.terminalId, authorizationId };
    let result: ReturnType<typeof vendaDoCorpo>;
    /*
      O PREÇO QUE BAIXOU DEPOIS DA VENDA (G-offline-sync-08). Repetir o corpo
      guardado tomava `CORE_SALE_TOTAL_CHANGED` para sempre. Com `ajusteDePreco`
      ('preco_de_agora' | 'manter_o_cobrado'), o serviço refaz o corpo com as
      linhas da própria recusa. Ver `relancarComAjusteDePreco`.
    */
    let ajusteDePreco: AjusteDePrecoAplicado | null = null;
    try {
      const relancado = relancarComAjusteDePreco({
        companyId,
        userId,
        id,
        perfis: scope(req).profiles,
        corpo,
        pedido: req.body?.ajusteDePreco,
        vender: (c) => vendaDoCorpo(req, c, guardada.idempotencyKey),
      });
      result = relancado.result;
      ajusteDePreco = relancado.ajusteDePreco;
    } catch (err) {
      registrarRecusaDoRelancamento(companyId, id, err);
      throw err;
    }
    if (!result.duplicated) {
      recordAudit({
        companyId,
        userId,
        action: 'sale.create',
        entityType: 'sale',
        entityId: result.sale.id,
        detail: {
          total: result.sale.total_cents,
          concessao: result.concessao,
          authorizationId,
          // A venda nasceu de uma venda guardada offline: a trilha aponta a
          // pendência, que guarda quando ela foi feita e em que gaveta.
          offlinePendingId: id,
          itensCancelados: result.cancelados,
          // Quem relançou escolheu, sabendo, a gaveta de outro caixa.
          ...(destino.outraGavetaConfirmada ? { outraGavetaConfirmada: true } : {}),
          ...(ajusteDePreco ? { ajusteDePreco } : {}),
        },
      });
    }
    const pendencia = concluirRelancamento({
      companyId,
      userId,
      id,
      saleId: result.sale.id,
      saleNumber: Number(result.sale.number ?? 0) || null,
      cashSessionId,
      duplicated: result.duplicated,
      ajusteDePreco,
    });
    res
      .status(result.duplicated ? 200 : 201)
      .json({ sale: result.sale, duplicated: result.duplicated, pendencia, ajusteDePreco });
  } catch (err) {
    next(err);
  }
});

/*
  RELANÇAR COMO VENDA NOVA (RES-IDEM-TELA).

  A chave desta pendência já registrou OUTRA venda (a #N, com outros itens), e
  a mesma chave com outra mercadoria é 422 para sempre: o relançamento comum
  nunca passa. A venda da pendência vira outra venda, com chave PRÓPRIA dela,
  na gaveta aberta de quem relança; a #N fica como está. O serviço recusa
  quando a chave não tem venda de outra mercadoria — ali a saída é a comum, e
  chave nova seria vender em dobro. Mesmo alcance do relançamento: é vender.
*/
coreRouter.post('/offline-sales/:id/relaunch-as-new', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...BALCAO_E_GERENCIA, 'atendente');
    const { companyId, userId } = scope(req);
    const id = String(req.params.id);
    const nova = vendaNovaDaPendencia(companyId, id);
    // A mesma gaveta do dinheiro do relançamento comum (G-offline-sync-10):
    // a da venda ainda aberta, ou a aberta do mesmo caixa; só sem elas a do
    // pedido, e a de outro caixa com confirmação.
    const destino = destinoDoRelancamento({
      companyId,
      id,
      pedido: req.body,
      terminalDoDispositivo: req.auth?.storeId ?? null,
    });
    const cashSessionId = destino.cashSessionId;
    // O dinheiro desta venda já está numa gaveta: sem gaveta aberta que o
    // receba, ele sobraria sem venda que o explique. A pendência não guarda
    // esta recusa — ela é de quem relança, e não da venda.
    if (!cashSessionId) {
      throw new ApiError(
        'CORE_CASH_SESSION_REQUIRED',
        'A venda nova entra na gaveta onde o dinheiro está — a da venda ou a aberta do mesmo caixa —, e '
          + 'nenhuma está aberta: abra o caixa e relance.',
        400,
      );
    }
    // A liberação pedida em "Regularizar" vale também aqui (G-offline-sync-11).
    const authorizationId =
      typeof req.body?.authorizationId === 'string' && req.body.authorizationId
        ? req.body.authorizationId
        : (nova.corpo.authorizationId ?? null);
    const corpo = { ...nova.corpo, cashSessionId, terminalId: destino.terminalId, authorizationId };
    let result: ReturnType<typeof vendaDoCorpo>;
    // O preço que baixou depois da venda também trava a venda nova (G-offline-sync-08).
    let ajusteDePreco: AjusteDePrecoAplicado | null = null;
    try {
      const relancado = relancarComAjusteDePreco({
        companyId,
        userId,
        id,
        perfis: scope(req).profiles,
        corpo,
        pedido: req.body?.ajusteDePreco,
        vender: (c) => vendaDoCorpo(req, c, nova.chaveNova),
      });
      result = relancado.result;
      ajusteDePreco = relancado.ajusteDePreco;
    } catch (err) {
      registrarRecusaDoRelancamento(companyId, id, err);
      throw err;
    }
    const vendaDaChaveOriginal = { id: nova.vendaDaChave.id, number: nova.vendaDaChave.number };
    if (!result.duplicated) {
      recordAudit({
        companyId,
        userId,
        action: 'sale.create',
        entityType: 'sale',
        entityId: result.sale.id,
        detail: {
          total: result.sale.total_cents,
          concessao: result.concessao,
          authorizationId,
          offlinePendingId: id,
          relancadaComoVendaNova: true,
          chaveOriginal: nova.chaveOriginal,
          vendaDaChaveOriginal,
          itensCancelados: result.cancelados,
          ...(destino.outraGavetaConfirmada ? { outraGavetaConfirmada: true } : {}),
          ...(ajusteDePreco ? { ajusteDePreco } : {}),
        },
      });
    }
    const pendencia = concluirRelancamento({
      companyId,
      userId,
      id,
      saleId: result.sale.id,
      saleNumber: Number(result.sale.number ?? 0) || null,
      cashSessionId,
      duplicated: result.duplicated,
      vendaNova: { chaveOriginal: nova.chaveOriginal, vendaDaChave: vendaDaChaveOriginal },
      ajusteDePreco,
    });
    res
      .status(result.duplicated ? 200 : 201)
      .json({ sale: result.sale, duplicated: result.duplicated, pendencia, ajusteDePreco });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/offline-sales/:id/discard', (req: AuthedRequest, res, next) => {
  try {
    // Descartar é dizer que a venda NÃO existe com o dinheiro já recebido:
    // decisão da gerência, com motivo e trilha.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(descartarVendaOffline({ companyId, userId, id: String(req.params.id), motivo: req.body?.reason }));
  } catch (err) {
    next(err);
  }
});

/**
 * DE ONDE VEIO O PEDIDO — o endereço do SOCKET, e nunca o de um cabeçalho.
 *
 * `req.ip` obedece a `trust proxy` e a `X-Forwarded-For`, e um cabeçalho é a
 * coisa mais barata do mundo de forjar: gravar aquele valor como "onde a senha
 * do gerente foi digitada" seria gravar o que o cliente MANDOU dizer. O
 * endereço do socket ninguém forja de fora. O mesmo motivo já está escrito em
 * `clientIp`, no roteador de autenticação, e a razão de haver uma segunda cópia
 * aqui é que o roteador de autenticação não exporta a dele.
 */
function ipDoSocket(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  // Atrás de um proxy declarado, o socket é o proxy para todo mundo: vale o
  // endereço que o salto confiável acrescentou (GAP-PRD-074, `ipDeOrigem`).
  return ipDeOrigem(req);
}

/**
 * Libera uma ação restrita com a credencial de um gestor, sem o operador
 * sair do PDV. Não cria sessão — autoriza aquela ação e registra quem foi.
 */
/**
 * QUEM LIBERA AQUI — GAP-PRD-054.
 *
 * O organograma que a alçada pontual pressupõe, visível: quem tem alçada NESTA
 * operação (gerentes dela) e quem tem pelo grupo (admin_geral, gestor). A
 * decisão de nomear um gerente por loja é do dono, e o caminho já existe
 * (Usuários e equipe); o que faltava era a tela dizer que hoje só os donos do
 * grupo liberam. Aberta a quem PEDE liberação (balcão) e a quem monta a equipe
 * (escritório). Só nomes e perfis — nunca o login.
 */
coreRouter.get('/authorizations/quem-libera', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const { daOperacao, doGrupo } = quemLiberaNaOperacao(companyId);
    res.json({
      daOperacao,
      doGrupo,
      semAlcadaNaOperacao: daOperacao.length === 0,
      acoes: [...RESTRICTED_ACTIONS],
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/authorizations', async (req: AuthedRequest, res, next) => {
  try {
    /*
      ESCREVE, e o perfil ACRESCENTA mesmo com a senha conferida por dentro.

      A rota valida a credencial do gestor, então quem não a tem não libera
      nada. O que o guarda impede é diferente: é alguém de fora do balcão usar
      esta rota como oráculo de senha, tentando login e senha de gestor à
      vontade a partir de uma sessão qualquer. Sem guarda, o mecânico — e o
      perfil que ninguém previu — teria esse oráculo.

      O alcance é o de quem PEDE liberação: o operador no PDV e no diálogo de
      caixa (ROTA_PDV), mais a gestão.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId, userId } = scope(req);
    /*
      O QUE ESTÁ SENDO LIBERADO, EM NÚMERO.

      A liberação era um "sim" sem valor e sem prazo: valia para qualquer
      concessão e para sempre. O prazo foi resolvido pelo consumo (a liberação
      é gasta no documento que a usa). O VALOR precisa vir de quem pede, e este
      é o campo por onde ele entra — liberar R$ 1.800 e vender concedendo
      R$ 7.200 passa a ser recusado com os dois números na mensagem.

      É opcional porque a tela do PDV ainda manda só o `reason` em texto, e a
      tela não é desta rodada. Sem o campo, a liberação nasce sem teto e
      continua valendo UMA vez — o consumo não depende dele. É uma porta
      estreita, não uma porta aberta, e ela fecha no dia em que o PDV passar a
      mandar o número que já calcula para escrever a frase.
    */
    const result = await authorizeAction({
      companyId,
      requestedBy: userId,
      action: String(req.body?.action ?? ''),
      login: String(req.body?.login ?? ''),
      password: String(req.body?.password ?? ''),
      reason: req.body?.reason,
      referenceId: req.body?.referenceId,
      detail: req.body?.detail,
      concessao: {
        concedidoCents: req.body?.concedidoCents,
        brutoCents: req.body?.brutoCents,
      },
      /*
        ONDE A SENHA FOI DIGITADA — e este é o campo que era montado e perdido.

        `ip` já viajava nesta chamada, `authorizeAction` já o tinha na
        assinatura, e a tabela não tinha coluna: o endereço chegava e morria no
        parâmetro. Parâmetro que ninguém grava é pior que parâmetro ausente,
        porque quem lê a chamada acredita que o dado ficou registrado — e a
        conferência de caixa, que é quem pergunta "essa senha foi digitada no
        balcão?", nunca teve com o que responder.

        O TERMINAL vem do TOKEN (`storeId`), nunca do corpo: quem se declara não
        é quem decide, e um terminal informado pelo cliente seria uma etiqueta
        que o próprio operador escolhe. Nulo quando a sessão é de login comum —
        e nulo aqui é a verdade, não ausência de dado: não houve terminal.
      */
      ip: ipDoSocket(req),
      terminalId: req.auth?.storeId ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: `authorization.${result.action}`,
      entityType: 'authorization',
      entityId: result.id,
      detail: {
        authorizedBy: result.authorizedBy,
        reason: req.body?.reason,
        grantedConcessionCents: result.grantedConcessionCents,
        grantedGrossCents: result.grantedGrossCents,
        // O ALVO na trilha: sem ele, duas liberações de cancelamento no mesmo
        // minuto ficam indistinguíveis para quem lê a auditoria depois.
        referenceId: result.referenceId,
        terminalId: result.terminalId,
      },
      ip: result.ip,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * AS LIBERAÇÕES DE GESTOR DA OPERAÇÃO — a rota que virou tela.
 *
 * Ela existia desde a primeira rodada da alçada e NENHUMA tela a chamava: cada
 * senha de gerente digitada no balcão virava linha no banco e o dono só a
 * alcançava abrindo o SQLite. A seção "Liberações de gestor" da tela de
 * Auditoria é o leitor que faltava.
 *
 * ## O guarda ESTREITOU, e não é descuido
 *
 * Era `gerente_loja, gerente_oficina`. Esta lista é o diário de vigilância dos
 * gerentes: quem pediu, quem ASSINOU, para qual venda, de qual terminal. O
 * mesmo argumento que fecha `GET /core/audit` a eles vale aqui inteiro — abrir
 * faria o vigiado ler a própria vigilância, e faria pior, porque aqui a linha
 * nomeia o gerente que autorizou. `requireProfile(req)` sem perfis extras é
 * exatamente `admin_geral` e `gestor`, que é quem a tela de Auditoria já
 * admite: a rota passa a ter o mesmo recorte da tela que a consome, em vez de
 * ser mais larga que ela.
 */
coreRouter.get('/authorizations', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId } = scope(req);
    res.json({
      items: listAuthorizations(
        companyId,
        req.query.limit ? Number(req.query.limit) : undefined,
      ),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Regra de desconto do balcão, para o PDV saber quando pedir liberação.
 *
 * Continua SEM requireProfile: é o operador de caixa quem precisa desta
 * resposta, e ela não revela nada que ele já não descubra tentando fechar uma
 * venda. O que mudou é a fonte — o limite agora é o da OPERAÇÃO, e não mais os
 * 10% que valiam igual para o grupo inteiro.
 */
coreRouter.get('/sales/discount-policy', (req: AuthedRequest, res, next) => {
  try {
    /*
      Era a rota que dizia em comentário "continua SEM requireProfile". A
      intenção estava certa e continua valendo — quem precisa da resposta é o
      operador de caixa —, mas agora ela está DECLARADA em vez de calada: o
      silêncio deixava passar também o perfil que ninguém criou ainda.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId, profiles } = scope(req);
    res.json({
      operatorLimitPercent: politicaDaEmpresa(companyId).discountLimitPercent,
      canAuthorizeSelf: temAlcadaParaLiberar(profiles),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- política comercial do balcão
//
// QUEM ALCANÇA ESTA TELA — conferido no roteador, não suposto.
//
// As telas de configuração do sistema moram todas em ROTA_GESTAO
// (src/router/gsRoutes.tsx), e o ambiente "gestao" recebe também estoquista e
// atendente (src/router/environments.ts). Ou seja: a CASCA abre para mais gente
// do que deveria decidir política comercial, e é o servidor que fecha.
//
// Por isso o perfil exigido aqui é o de quem responde pela margem —
// gerente_loja e gerente_oficina —, e requireProfile já deixa passar admin_geral
// e gestor por cima de qualquer lista. Operador de caixa NÃO entra: o limite de
// desconto existe justamente para limitá-lo, e quem pode editar o próprio limite
// não tem limite nenhum.

coreRouter.get('/sale-policies', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    res.json(politicaDaEmpresa(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/sale-policies', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const corpo = req.body ?? {};

    // Ausente e nulo são coisas diferentes para uma tela parcial, mas aqui a
    // tela manda os três campos sempre — e o campo apagado chega como null ou
    // string vazia, que salvarPolitica lê como "volta ao padrão do sistema".
    const politica = salvarPolitica({
      companyId,
      userId,
      discountLimitPercent: corpo.discountLimitPercent ?? null,
      creditSaleDueDays: corpo.creditSaleDueDays ?? null,
      reservationValidDays: corpo.reservationValidDays ?? null,
      cashWithdrawalLimitReais: corpo.cashWithdrawalLimitReais ?? null,
      // Faturar a OS a prazo (GAP-PRD-104): ausente volta ao padrão, desligado.
      workshopCreditEnabled: corpo.workshopCreditEnabled ?? null,
    });

    // Auditoria obrigatória: mudar o limite de desconto é mudar quanto a loja
    // pode dar de graça sem ninguém ser chamado. Guarda o que ficou valendo,
    // e não o que veio no corpo — é o estado final que explica uma venda.
    recordAudit({
      companyId,
      userId,
      action: 'sale_policy.update',
      entityType: 'sale_policy',
      entityId: companyId,
      detail: {
        discountLimitPercent: politica.discountLimitPercent,
        creditSaleDueDays: politica.creditSaleDueDays,
        reservationValidDays: politica.reservationValidDays,
        cashWithdrawalLimitCents: politica.cashWithdrawalLimitCents,
        workshopCreditEnabled: politica.workshopCreditEnabled,
        definidos: politica.definidos,
      },
    });

    res.json(politica);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/sales', (req: AuthedRequest, res, next) => {
  try {
    /*
      DINHEIRO — e o guarda cede ao balcão porque a tela cede.

      A lista de vendas aparece em Vendas e Devoluções (ROTA_GESTAO), mas também
      no PDV (ROTA_PDV), que mostra as últimas vendas do turno. Fechar ao balcão
      seria mais estreito que a tela. A bancada, essa fica de fora: o mecânico
      não tem por que ler o faturamento da loja.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    /*
      A lista corta em página — e DIZ que cortou.

      O LIMIT padrão de 200 vivia só no serviço: a rota não repassava
      limit/offset nem contava o recorte, e um dia com 205 vendas devolvia
      200 sem erro nenhum — o painel afirmava um total e a lista somava
      outro. Agora a página é escolhível (teto de 500 — página maior que
      isso é o navegador varrendo o banco), o offset percorre o resto, e o
      `total` diz quantas vendas o recorte tem de verdade, para a tela saber
      que existe mais página.

      O customerId é o histórico de compras do cliente do balcão — sempre
      dentro da MESMA empresa do token, que o serviço impõe antes dele.
    */
    const recorte = {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      customerId: req.query.customerId as string | undefined,
    };
    // A página pedida volta na resposta (GAP-PRD-070): a tela precisa dela
    // para escrever "mostrando 1–200 de 1.180" sem refazer a conta do teto.
    const pagina = lerPagina(req.query, 200);
    res.json({
      items: listSales(companyId, { ...recorte, ...pagina }),
      total: countSales(companyId, recorte),
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/sales/:id', (req: AuthedRequest, res, next) => {
  try {
    /*
      A venda aberta, item a item. Mesmo alcance da lista — e o cancelamento
      ao lado continua exigindo gerente_loja, que é o certo: ler o que se
      vendeu não é desfazer.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const sale = getSaleDetail(companyId, String(req.params.id));
    if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);
    res.json(sale);
  } catch (err) {
    next(err);
  }
});

/**
 * ============================================================================
 * O PORTÃO DE DUAS PORTAS — perfil OU liberação pontual, e nunca um terceiro
 * mecanismo
 * ============================================================================
 *
 * ## O defeito que ele fecha
 *
 * Cancelar venda e registrar devolução exigiam PERFIL, e só. Quem não o tinha
 * lia "Permissão negada" e a operação parava ali: o gerente estava na loja, ao
 * lado do balcão, e não havia como ele dizer "pode" sem trocar de sessão — o
 * que na prática significa emprestar a senha, que é o contorno que toda loja
 * inventa e que nenhuma trilha registra. O sistema já tinha a saída certa
 * construída (a liberação de desconto acima da alçada) e a usava em UM lugar.
 *
 * ## Duas portas, e a primeira continua sendo a de sempre
 *
 * Quem tem alçada faz DIRETO, sem pedir nada a ninguém — é o que mata o
 * argumento que tirou `cancelar_venda` da lista de ações restritas ("o gerente
 * teria de chamar um segundo gerente"). A liberação existe SÓ para quem antes
 * tomava 403 e ia embora.
 *
 * ## Por que o bilhete é gasto DENTRO da transação da ação
 *
 * Se o cancelamento falhar depois do consumo — venda já cancelada, gaveta
 * fechada, o que for —, o rollback devolve a liberação intacta. Fazer o
 * operador chamar o gerente de novo por causa de um erro que não foi dele é
 * como uma trava correta vira uma trava que todo mundo aprende a contornar. É a
 * mesma decisão, pelo mesmo motivo, que `consumirLiberacaoDeConcessao` já
 * tomava dentro da transação da venda.
 *
 * ## E o alvo é a VENDA, nos dois casos
 *
 * Cancelar e devolver são coisas diferentes feitas sobre o MESMO registro, e a
 * devolução ainda não existe na hora em que o gestor digita a senha. O que
 * separa um "sim" do outro é a AÇÃO, que entra na consulta do consumo: uma
 * liberação de `devolver_venda` não cancela a venda, e vice-versa.
 */
function comLiberacaoPontual<T>(
  req: AuthedRequest,
  opcoes: {
    /** Quem faz direto — a lista que a rota exigia ANTES, sem alargar nada. */
    perfisQuePodemDireto: readonly string[];
    action: 'cancelar_venda' | 'devolver_venda';
    /** O registro que o gestor liberou. Nas duas ações, a venda. */
    refId: string;
    codigo: string;
    mensagem: string;
  },
  executar: () => T,
): { resultado: T; authorizationId: string | null; authorizedBy: string | null } {
  const { companyId, userId, profiles } = scope(req);
  const direto =
    profiles.includes('admin_geral')
    || profiles.includes('gestor')
    || opcoes.perfisQuePodemDireto.some((p) => profiles.includes(p));

  if (direto) {
    return { resultado: executar(), authorizationId: null, authorizedBy: null };
  }

  const authorizationId = req.body?.authorizationId
    ? String(req.body.authorizationId)
    : null;
  if (!authorizationId) {
    /*
      O 403 NOMEADO, e ele é o que faz a tela abrir o diálogo do gestor.

      `API_PERMISSION_DENIED` diria "não pode" e a tela não teria o que
      oferecer. Este código diz "não pode SOZINHO", e o `details` leva a ação e
      o alvo que o pedido de liberação precisa mandar de volta — sem eles a tela
      teria de adivinhar os dois.
    */
    throw new ApiError(opcoes.codigo, opcoes.mensagem, 403, {
      action: opcoes.action,
      referenceId: opcoes.refId,
    });
  }

  return withTransaction(() => {
    const gasta = consumirLiberacaoDeAcao({
      companyId,
      authorizationId,
      requestedBy: userId,
      action: opcoes.action,
      refType: 'sale',
      refId: opcoes.refId,
      now: new Date().toISOString(),
    });
    return {
      resultado: executar(),
      authorizationId: gasta.id,
      authorizedBy: gasta.authorizedBy,
    };
  });
}

coreRouter.post('/sales/:id/cancel', (req: AuthedRequest, res, next) => {
  try {
    /*
      O ALCANCE É O DA TELA, e o perfil voltou a ser uma DECISÃO em vez de um
      portão.

      Era `requireProfile(req, 'gerente_loja')`, e o alcance passa a ser o do
      escritório — que é exatamente quem a `DevolucoesPage` (ROTA_GESTAO) deixa
      entrar. Isso NÃO alarga quem cancela: `gerente_loja` continua sendo o
      único que cancela direto (mais `admin_geral` e `gestor`, como em todo
      `requireProfile`). O que muda é que estoquista e atendente deixam de tomar
      um "não" seco e passam a poder chamar um gestor ali mesmo — com a senha
      dele, gasta uma vez, presa a ESTA venda e registrada com os dois nomes.

      O contador continua fora, e continua pelo mesmo motivo de sempre: ele não
      mora em ambiente nenhum do prédio.
    */
    abertaAo(req, 'escritorio');
    const { companyId, userId } = scope(req);
    const saleId = String(req.params.id);
    const caixaDoPedido = caixaNoEscopo(req, {
      informado: req.body?.terminalId,
      doDispositivo: req.auth?.storeId,
    });

    const { resultado: sale, authorizationId, authorizedBy } = comLiberacaoPontual(
      req,
      {
        perfisQuePodemDireto: ['gerente_loja'],
        action: 'cancelar_venda',
        refId: saleId,
        codigo: 'CORE_CANCEL_NEEDS_AUTHORIZATION',
        mensagem:
          'Cancelar uma venda desfaz estoque, comissão e fidelidade de uma vez. '
          + 'Peça a liberação de um gestor para esta venda.',
      },
      () =>
        cancelSale({
          companyId,
          saleId,
          userId,
          reason: req.body?.reason,
          // De qual gaveta sai o dinheiro de turno já fechado: a do caixa de
          // quem cancela (GAP-PRD-161). O do token vence o do corpo.
          terminalId: caixaDoPedido,
          // Venda já cancelada é 409 DENTRO da transação da liberação: o
          // bilhete do gestor volta intacto, e nem a auditoria nem o estorno
          // na maquininha rodam de novo (E-venda-servidor-14).
          recusarSeJaCancelada: true,
        }),
    );

    recordAudit({
      companyId,
      userId,
      action: 'sale.cancel',
      entityType: 'sale',
      entityId: sale.id,
      /*
        OS DOIS USUÁRIOS NA MESMA LINHA — é o que a liberação pontual custa para
        ser honesta. `userId` sozinho diria que a estoquista cancelou a venda,
        por conta própria; com `authorizingUserId` ao lado, a trilha diz quem
        pediu e quem assinou, e o id do bilhete liga a linha à liberação inteira
        (terminal, IP, hora).
      */
      detail: {
        reason: req.body?.reason,
        requestingUserId: userId,
        authorizingUserId: authorizedBy,
        authorizationId,
      },
      ip: ipDoSocket(req),
    });
    /*
      O ESTORNO NA MAQUININHA, DEPOIS DO COMMIT (GAP-PRD-080).

      `cancelSale` marcou "a estornar" nas cobranças da venda dentro da
      transação; aqui o estorno é pedido à operadora, fora dela. O que a
      operadora não confirmar volta como "pendente" com o motivo — o
      cancelamento já vale — e fica na fila de estornos do gestor.
    */
    executarEstornosPendentes({ companyId, userId, saleId })
      .then((estornosNaMaquininha) => res.json({ ...sale, estornosNaMaquininha }))
      .catch(next);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- financeiro

coreRouter.get('/finance/entries', (req: AuthedRequest, res, next) => {
  try {
    /*
      DINHEIRO, e este fecha de verdade: contas a pagar e a receber da empresa.
      As duas telas que consomem — Contas e Financeiro — são ROTA_GESTAO, e o
      POST ao lado já exigia gerente. Balcão e bancada saem.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const direction = req.query.direction as 'in' | 'out' | undefined;
    res.json({
      items: listEntries(companyId, {
        direction,
        situation: req.query.situation as string | undefined,
        dueFrom: req.query.dueFrom as string | undefined,
        dueTo: req.query.dueTo as string | undefined,
        search: req.query.search as string | undefined,
        // O filtro por categoria CHEGA no serviço.
        //
        // Escrever o parâmetro na tela e não repassá-lo aqui é o formato de
        // defeito que esta rodada existe para consertar — o mesmo que fazia o
        // POST ao lado descartar quatro campos. Um filtro que a rota engole em
        // silêncio devolve a lista inteira, e quem filtrou acredita que aquilo
        // é o recorte pedido.
        categoryId: req.query.categoryId as string | undefined,
        /*
          O CENTRO DE CUSTO GANHOU LEITOR (GAP-V25).

          A coluna era gravada por `createEntry` e nenhuma consulta a lia:
          preencher centro de custo era trabalho sem retorno. Este filtro e a
          dimensão no DRE são os dois primeiros leitores dela — e o filtro
          chega ao serviço, em vez de ser engolido aqui, que é o defeito que a
          rodada da categoria já consertou uma vez.
        */
        costCenterId: req.query.costCenterId as string | undefined,
        // A VOLTA da rastreabilidade: os lançamentos de UM documento. É a
        // consulta que a ficha da venda/nota/pedido faz para listar os seus
        // títulos — o avesso do originId que cada linha agora carrega.
        originType: req.query.originType as string | undefined,
        originId: req.query.originId as string | undefined,
      }),
      // Os totais vêm somados no banco: a lista traz 500 linhas, o total é de
      // tudo. Somar no navegador daria um número menor e silenciosamente
      // errado assim que a operação crescesse.
      summary: direction ? summarize(companyId, direction) : null,
      // O vencido por IDADE (a vencer, 1-30, 31-60, 61-90, >90) — campo
      // IRMÃO do resumo, não dentro dele: o formato do summary é contrato
      // conferido campo a campo pelos testes de auditoria, e as faixas são
      // outra pergunta sobre o mesmo dinheiro.
      aging: direction ? agingPorFaixas(companyId, direction) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Cria a conta que não nasce de uma venda — e agora com a classificação junto.
 *
 * A ROTA DESCARTAVA QUATRO CAMPOS. `createEntry` aceita `categoryId`,
 * `costCenterId`, `accountId` e `competenceDate`, e GRAVA os quatro; a rota
 * montava o objeto nomeando seis campos e deixava esses de fora. O formulário
 * podia oferecer a categoria, o servidor gravava nulo, e o lançamento aparecia
 * no DRE dentro de "Sem categoria" — sem erro em lugar nenhum.
 *
 * É o mesmo defeito da rodada 22 (configuração inerte com a suíte verde), e o
 * teste que o cobre atravessa HTTP de propósito: chamar o serviço direto
 * passaria com a rota exatamente como estava.
 *
 * `costCenterId` é repassado embora NENHUM relatório o use — ele é gravado, e
 * o campo não pode chegar ao serviço pela metade. A tela de cadastro diz, em
 * uma frase, que centro de custo ainda não alimenta relatório nenhum.
 */
coreRouter.post('/finance/entries', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const entry = createEntry({
      companyId,
      direction: req.body?.direction === 'out' ? 'out' : 'in',
      description: String(req.body?.description ?? ''),
      amountCents: Number(req.body?.amountCents),
      dueDate: req.body?.dueDate ?? null,
      customerId: req.body?.customerId ?? null,
      supplierId: req.body?.supplierId ?? null,
      categoryId: req.body?.categoryId ?? null,
      costCenterId: req.body?.costCenterId ?? null,
      accountId: req.body?.accountId ?? null,
      competenceDate: req.body?.competenceDate ?? null,
      // O carnê do balcão: parcelar em N vencimentos mensais. Omitido = 1.
      // Repassado como veio — a validação (inteiro, teto, primeiro
      // vencimento) mora no serviço, onde toda porta passa por ela.
      installments: req.body?.installments ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.entry_created',
      entityType: 'finance_entry',
      entityId: entry.id,
      detail: {
        direction: entry.direction,
        // No carnê, o `entry` devolvido é a PRIMEIRA parcela; o valor da
        // trilha é o TOTAL combinado — é ele que o gerente reconhece.
        amountCents: Number(req.body?.amountCents),
        // Grupo e contagem só quando houve parcelamento: a trilha do
        // lançamento comum continua com a cara de sempre.
        ...(entry.installmentTotal > 1
          ? { installments: entry.installmentTotal, groupId: entry.originId }
          : {}),
      },
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/finance/entries/:id/settlements', (req: AuthedRequest, res, next) => {
  try {
    /*
      As baixas de um lançamento: quem pagou, quando e por qual conta bancária.
      Mesma tela, mesmo alcance.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listSettlements(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/entries/:id/settle', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId, userId } = scope(req);
    // Idempotency-Key (GAP-PRD-173): o reenvio da MESMA baixa devolve a baixa
    // já feita. Sem a chave, o comportamento é o de sempre — os escritores
    // antigos continuam funcionando, e a tela passa a mandar.
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ||
      (req.body?.idempotencyKey ? String(req.body.idempotencyKey) : null);
    const result = settleEntry({
      companyId,
      entryId: String(req.params.id),
      amountCents: Number(req.body?.amountCents),
      method: req.body?.method ?? null,
      note: req.body?.note ?? null,
      userId,
      idempotencyKey,
    });
    // O reenvio não é um segundo recebimento: a trilha registra a baixa uma
    // vez só, como o banco.
    if (!result.replayed) {
      recordAudit({
        companyId,
        userId,
        action: 'finance.settled',
        entityType: 'finance_entry',
        entityId: result.entry.id,
        detail: { amountCents: Number(req.body?.amountCents), balance: result.entry.balanceCents },
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/settlements/:id/reverse', (req: AuthedRequest, res, next) => {
  try {
    // Estorno é decisão de gestão: desfaz dinheiro já registrado como recebido.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const result = reverseSettlement({
      companyId,
      settlementId: String(req.params.id),
      userId,
      note: req.body?.note ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.settlement_reversed',
      entityType: 'finance_entry',
      entityId: result.entry.id,
      detail: { settlementId: String(req.params.id) },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * FLUXO DE CAIXA PROJETADO (GAP-PRD-094): o que entra e sai por dia ou semana
 * e o saldo projetado. Mesmo alcance da tela de Cadastros, que já mostra o
 * saldo das contas — gerência das operações.
 */
coreRouter.get('/finance/cash-flow', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const q = req.query;
    res.json(
      projetarFluxoDeCaixa({
        companyId,
        from: q.from ? String(q.from) : null,
        to: q.to ? String(q.to) : null,
        days: q.days ? Number(q.days) : null,
        accountId: q.accountId ? String(q.accountId) : null,
        granularity: q.granularity ? String(q.granularity) : null,
        overdue: q.overdue ? String(q.overdue) : null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * AS QUITAÇÕES ANTIGAS SEM BAIXA (GAP-PRD-171) — a lista e o botão da decisão.
 *
 * Gerência: é dinheiro que a conciliação bancária passa ou não a enxergar. O
 * POST exige `confirm: true` no corpo e grava na trilha quem decidiu.
 */
coreRouter.get('/finance/legacy-settlements', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(listarQuitacoesSemBaixa(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/legacy-settlements/mirror', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const entryIds = Array.isArray(req.body?.entryIds) ? (req.body.entryIds as unknown[]).map(String) : null;
    const resultado = criarBaixasEspelhoLegadas({
      companyId,
      userId,
      entryIds,
      confirm: req.body?.confirm === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.legacy_settlements_mirrored',
      entityType: 'finance_settlement',
      entityId: 'legacy',
      detail: { created: resultado.created, totalCents: resultado.totalCents, entryIds },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- cobrança online do título (V70)

/**
 * COBRAR O TÍTULO PELO PROVEDOR — o botão que não existia.
 *
 * `createPaymentIntent` estava escrito e sem chamador; a única cobrança viva
 * nascia do checkout da loja. Lançar o aluguel no contas a receber e mandar o
 * PIX para o cliente era impossível pelo sistema.
 *
 * ALCANCE: os mesmos de `/finance/entries/:id/settle`. Cobrar e dar baixa são
 * o mesmo trabalho, feito pelas mesmas pessoas — gerência das duas operações e
 * os caixas. Estoquista e atendente alcançam a TELA (ela é ROTA_GESTAO) e leem
 * a lista; gerar cobrança no provedor, não.
 *
 * A resposta traz o copia-e-cola, a linha digitável e o link da fatura — nunca
 * a chave da operação, que não sai do cofre nem em erro.
 */
coreRouter.post('/finance/entries/:id/charge', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
      const { companyId, userId } = scope(req);
      const metodo = String(req.body?.method ?? 'pix');
      const cobranca = await chargeFinanceEntry({
        companyId,
        entryId: String(req.params.id),
        // Qualquer coisa fora dos três vira PIX, o meio mais universal — a
        // mesma escolha do checkout da loja.
        method: metodo === 'boleto' ? 'boleto' : metodo === 'cartao' ? 'cartao' : 'pix',
        // Parcelar: repassado como veio. A validação (inteiro, teto, título
        // ainda inteiro) mora no serviço, onde toda porta passa por ela.
        installmentCount: req.body?.installmentCount ?? null,
      });
      recordAudit({
        companyId,
        userId,
        action: 'finance.charge_created',
        entityType: 'finance_entry',
        entityId: String(req.params.id),
        detail: {
          method: cobranca.intent.method,
          amountCents: cobranca.intent.amount_cents,
          installments: cobranca.installments.length,
          status: cobranca.status,
          environment: cobranca.environment,
        },
      });
      res.status(201).json(cobranca);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * CANCELAR A COBRANÇA DO TÍTULO NO PROVEDOR — o gesto que faltava.
 *
 * Existia `cancelOrderCharges` para o pedido, com três chamadores; do lado do
 * título não havia nada, e a própria tela declarava a ausência ("não há rota
 * para isso no título"). Um PIX/boleto de título que perdeu a razão de ser
 * continuava vivo no provedor e o cliente podia pagá-lo — dinheiro que entra
 * sem destino, virando regularização manual.
 *
 * ALCANCE: os mesmos de `/charge`. Quem cria a cobrança é quem a desfaz —
 * gerência das duas operações e os caixas. Estoquista e atendente continuam
 * alcançando a TELA (ela é ROTA_GESTAO) e lendo a lista, sem mexer no provedor.
 *
 * A resposta é a contagem honesta: o que morreu no provedor e o que ele recusou
 * derrubar. Cobrança PAGA não entra na conta — o caminho do dinheiro que entrou
 * é o estorno, não o cancelamento.
 */
coreRouter.post('/finance/entries/:id/charges/cancel', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
      const { companyId, userId } = scope(req);
      const resultado = await cancelFinanceEntryCharges({
        companyId,
        entryId: String(req.params.id),
      });
      recordAudit({
        companyId,
        userId,
        action: 'finance.charge_cancelled',
        entityType: 'finance_entry',
        entityId: String(req.params.id),
        detail: { cancelled: resultado.cancelled, failed: resultado.failed },
      });
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * ESTORNAR A COBRANÇA PAGA DO TÍTULO (GAP-PRD-092).
 *
 * Pede o estorno ao provedor e, sob confirmação explícita (`desfazerBaixa`),
 * desfaz a baixa que a cobrança produziu — com contrapartida e motivo. Quando
 * o estorno já foi feito no portal, só desfaz a baixa.
 *
 * ALCANCE: GERÊNCIA (as duas operações), não os caixas. Cobrar e dar baixa são
 * trabalho do caixa; DEVOLVER dinheiro ao cliente e mexer em receita já
 * reconhecida é decisão de quem responde pelo caixa. A tela (Contas a receber
 * › Cobranças online, ROTA_GESTAO) desenha o botão só para esses perfis.
 */
coreRouter.post('/finance/entries/:id/charges/refund', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      if (typeof req.body?.desfazerBaixa !== 'boolean') {
        throw new ApiError(
          'CORE_CHARGE_REFUND_CONFIRMATION_REQUIRED',
          'Diga se a baixa do título deve ser desfeita junto (desfazerBaixa: true ou false).',
          400,
        );
      }
      const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo : null;
      const resultado = await refundFinanceEntryCharge({
        companyId,
        entryId: String(req.params.id),
        desfazerBaixa: req.body.desfazerBaixa,
        motivo,
        userId,
      });
      recordAudit({
        companyId,
        userId,
        action: 'finance.charge_refunded',
        entityType: 'finance_entry',
        entityId: String(req.params.id),
        detail: {
          intentId: resultado.intentId,
          providerRef: resultado.providerRef,
          estornadoNoProvedor: resultado.estornadoNoProvedor,
          baixaDesfeita: resultado.baixaDesfeita,
          baixaDePe: resultado.baixaDePe,
          motivo,
        },
      });
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

/** As cobranças DESTE título: status, erro e tentativas. Leitura da tela. */
coreRouter.get('/finance/entries/:id/charges', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: getIntentsFor({
        companyId,
        originType: 'finance_entry',
        originId: String(req.params.id),
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O QUE ACONTECEU COM AS COBRANÇAS (GAP-V75).
 *
 * `getIntentsFor` não tinha chamador e nenhuma tela lia `core_payment_intents`:
 * cobrança `failed` com `last_error`, tentativa que não foi adiante e cobrança
 * vencida eram invisíveis. O gestor descobria pela reclamação do comprador ou
 * pela divergência da conciliação — sempre tarde.
 *
 * Mesmo alcance da tela de Contas, que é onde a lista aparece.
 */
coreRouter.get('/payment-intents', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listPaymentIntents({
        companyId,
        status: (req.query.status as string | undefined) || undefined,
        originType: (req.query.originType as string | undefined) || undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * TENTAR DE NOVO a cobrança que falhou (GAP-V76).
 *
 * Reusa a MESMA intenção pela mesma chave de idempotência — não é uma segunda
 * cobrança. Cobrança que já existe no provedor é recusada com 409: "gerar de
 * novo" ali cobraria o cliente duas vezes.
 */
coreRouter.post('/payment-intents/:id/retry', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
      const { companyId, userId } = scope(req);
      const resultado = await retryPaymentIntent({
        companyId,
        intentId: String(req.params.id),
      });
      recordAudit({
        companyId,
        userId,
        action: 'finance.charge_retried',
        entityType: 'payment_intent',
        entityId: String(req.params.id),
        detail: { status: resultado.status, originType: resultado.intent.origin_type },
      });
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * As categorias do plano de contas, para o SELETOR do formulário.
 *
 * Já existe `/finance/setup`, e ele NÃO serve aqui: exige gerente e devolve o
 * SALDO de todas as contas bancárias junto. A tela de Contas é ROTA_GESTAO —
 * o roteador do navegador deixa chegar estoquista e atendente —, e um seletor
 * que responde 403 para quem a tela deixou entrar é tela quebrada em produção.
 *
 * Foi exatamente esse desencontro que a rodada 23 fechou, e a regra dela vale
 * para toda rota nova: o guarda bate com quem alcança a tela, nunca é mais
 * estreito. Por isso a lista de categorias sai daqui, sozinha, sem saldo
 * nenhum atrás — o que é público para a tela é o nome da categoria.
 */
coreRouter.get('/finance/categories', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const direction = req.query.direction === 'in' || req.query.direction === 'out'
      ? (req.query.direction as 'in' | 'out')
      : undefined;
    res.json({ items: listFinanceCategories(companyId, { direction }) });
  } catch (err) {
    next(err);
  }
});

/**
 * Os centros de custo, para o SELETOR e para o FILTRO (GAP-V25).
 *
 * Mesma decisão da rota de categorias logo acima, e pelo mesmo motivo: o
 * filtro por centro vive na tela de Contas, que é ROTA_GESTAO e recebe
 * estoquista e atendente. `/finance/setup` exige gerente e traz o saldo das
 * contas bancárias junto — usá-lo aqui daria 403 para quem a tela deixou
 * entrar, que é o desencontro que a rodada 23 fechou.
 *
 * O que é público para a tela é o CÓDIGO e o NOME do centro. Nada de valor
 * viaja nesta lista.
 */
coreRouter.get('/finance/cost-centers', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    /*
      Só os ATIVOS: esta lista alimenta formulário e filtro, e ninguém deve
      atribuir despesa nova a um centro que a empresa encerrou. O RELATÓRIO,
      por outro lado, continua nomeando o centro desativado no passado — ver
      `relatorioPorCentroDeCusto`.
    */
    res.json({ items: listCostCenters(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * O DRE do período — receita por categoria, despesa por categoria, resultado.
 *
 * ALCANCE: a tela é ROTA_GESTAO, que no roteador do navegador inclui
 * estoquista e atendente além dos dois gerentes. `requireProfile` com os dois
 * gerentes seria mais estreito que a tela, e o desencontro apareceria como
 * "tela em branco com erro de permissão" para quem entrou pela porta que o
 * sistema abriu. `abertaAo(escritorio)` é o conjunto exato.
 *
 * O período é obrigatório na prática, mas tem padrão: o mês corrente. Um DRE
 * sem recorte somaria a história inteira da empresa numa coluna só, o que não
 * é resultado de período nenhum.
 */
coreRouter.get('/finance/income-statement', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const hoje = hojeNaLoja();
    const mes = mesDaLoja();
    const from = String(req.query.from ?? '').trim() || `${mes}-01`;
    const to = String(req.query.to ?? '').trim() || hoje;
    res.json(incomeStatement(companyId, from, to));
  } catch (err) {
    next(err);
  }
});

/**
 * O MESMO PERÍODO, PELA OUTRA PERGUNTA: por centro de custo (GAP-V25).
 *
 * O centro de custo era gravado em todo lançamento e ninguém o lia — nenhum
 * relatório agrupava, nenhuma lista mostrava, nenhum filtro aceitava. Este é o
 * primeiro leitor, junto do filtro em `/finance/entries`.
 *
 * Rota IRMÃ do DRE e não uma linha dentro dele: "de quem é esta despesa" é
 * outra pergunta sobre o mesmo dinheiro, e enfiá-la na partição por categoria
 * faria a mesma quantia aparecer duas vezes na mesma estrutura — que é
 * exatamente como aquele relatório contou a devolução em dobro na primeira
 * versão.
 *
 * Mesmo alcance, mesmo padrão de período e MESMA competência (a expressão é
 * importada do DRE): as duas telas precisam somar o mesmo conjunto.
 */
coreRouter.get('/finance/cost-centers/report', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const hoje = hojeNaLoja();
    const mes = mesDaLoja();
    const from = String(req.query.from ?? '').trim() || `${mes}-01`;
    const to = String(req.query.to ?? '').trim() || hoje;
    res.json(relatorioPorCentroDeCusto(companyId, from, to));
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- dashboard

coreRouter.get('/dashboard', (req: AuthedRequest, res, next) => {
  try {
    /*
      O painel: faturamento, ticket médio, contas vencendo. Uma tela só
      (ROTA_GESTAO) e nenhum outro consumidor.

      O RECORTE DE DATA PERDIA O ÚLTIMO DIA, e isso importa agora porque o DRE
      compara o próprio total com este.

      `created_at` é timestamp (2026-08-31T14:00:00.000Z) e o limite chega
      como data (2026-08-31). Na comparação de texto crua,
      '2026-08-31T14:00:00.000Z' <= '2026-08-31' é FALSO: toda venda do
      último dia do período caía fora, em silêncio, e o mês fechava a menos.
      Comparar a data pura devolve a ponta de cima. Os padrões '0000' e '9999'
      seguem funcionando: continuam sendo texto fora do intervalo de qualquer
      data.

      E a data pura é a do RELÓGIO DA LOJA, não a de Greenwich: `diaDaLojaSql`
      converte a coluna antes de comparar. Sem isso, a venda das 21h30 aparece
      no painel do dia seguinte — e o painel é justamente a tela que o gerente
      abre no fim do expediente para conferir o dia que acabou de viver.
    */
    abertaAo(req, 'escritorio');
    ensureCoreSchema();
    const { companyId: daSessao, userId } = scope(req);
    /*
      O PAINEL DEIXA DE SER MONO-EMPRESA — GAP-V46.

      Comparar o dia de duas operações custava uma troca no seletor da topbar
      MAIS um `window.location.reload()` inteiro por empresa. A visão lado a
      lado existe (Relatórios › BI, `/insights/operations`), mas o recorte
      DIÁRIO por empresa dentro do próprio painel não existia.

      A REGRA DE ATRAVESSAR EMPRESA É O VÍNCULO, e nunca o perfil. É a mesma
      régua de `GET /companies` e de `/fiscal/certificates/group`:
      `listCompaniesForUser` lê `core_user_companies`. Um `companyId` fora do
      vínculo é RECUSADO com 403 — não silenciosamente trocado pela empresa da
      sessão, que ensinaria que o parâmetro não faz nada, nem devolvido como
      404, que contaria se a empresa existe.

      Sem `companyId`, nada muda: o painel é o da sessão, como sempre foi.

      E o painel devolve a LISTA do vínculo junto: sem ela a tela precisaria de
      uma segunda rota (ou de `GET /companies`, que é de dono) só para desenhar
      o seletor — e um seletor que só o dono consegue montar não serve ao
      gerente que tem duas lojas.
    */
    /*
      E O VÍNCULO SOZINHO NÃO ABRE (GAP-PRD-084): a operação pedida entra só se
      o perfil da pessoa LÁ abriria este painel lá — a mesma lista que
      `abertaAo(req, 'escritorio')` passa ao guarda, com o atalho dos donos.
      Quem é gerente aqui e mecânico na outra loja não lê o faturamento de lá
      com a sessão daqui; o seletor nem a oferece.
    */
    const doVinculo = operacoesOndeOPerfilAbre(userId, PERFIS_DO_AMBIENTE.escritorio);
    const pedida = String(req.query.companyId ?? '').trim();
    if (pedida && pedida !== daSessao && !doVinculo.some((c) => c.id === pedida)) {
      const temVinculo = listCompaniesForUser(userId).some((c) => c.id === pedida);
      throw temVinculo
        ? new ApiError(
            'CORE_COMPANY_PROFILE_WITHOUT_ACCESS',
            'O seu perfil nesta operação não abre o painel dela.',
            403,
          )
        : new ApiError(
            'CORE_COMPANY_NOT_IN_MEMBERSHIP',
            'Você não tem vínculo com esta operação.',
            403,
          );
    }
    const companyId = pedida || daSessao;
    const db = getConnection();
    const from = String(req.query.from ?? '').trim() || '0000';
    const to = String(req.query.to ?? '').trim() || '9999';

    /*
      AS CINCO CONSULTAS DESTE CARTÃO RECORTAM A VENDA COM A MESMA FRASE.

      O DEFEITO: `RECORTE_DA_VENDA_QUE_FATURA` entrou por dentro de
      `sqlDeMarcas` e a promessa foi "um status novo quebra a COMPILAÇÃO". Ela
      valia para `byBrand` e para mais nenhuma: as quatro consultas abaixo
      seguiam com `status = 'completed'` escrito à mão.

      No dia em que alguém marcasse um terceiro status como `true` no `Record
      FATURA`, o arquivo COMPILARIA, `byBrand` cresceria, `totals.revenue_cents`
      não, e `byBrandUnallocatedCents = totals.revenue_cents − somaDasMarcas`
      ficaria NEGATIVO. A tela mostra qualquer valor não-zero desse campo como
      "desconto ou acréscimo de rodapé" — mercadoria apresentada ao gestor como
      desconto, que é a mentira exata que o corte por teto foi desenhado para
      não criar. E `byDay`, `topProducts` e `bySeller` passariam a discordar do
      número grande logo acima deles no mesmo cartão.

      `recorteDaVendaQueFatura(apelido)` sai do mesmo `Record` que
      `sqlDeMarcas` usa. O apelido é parâmetro porque duas destas consultas
      leem `core_sales` sem apelido nenhum — foi a incompatibilidade de grafia
      que deixou as quatro para trás da primeira vez.
    */
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS sales_count,
                COALESCE(SUM(total_cents), 0) AS revenue_cents
           FROM core_sales
          WHERE company_id = ? AND ${recorteDaVendaQueFatura()}
            AND ${diaDaLojaSql('created_at')} >= ? AND ${diaDaLojaSql('created_at')} <= ?`,
      )
      .get(companyId, from, to) as { sales_count: number; revenue_cents: number };

    const byDay = db
      .prepare(
        `SELECT ${diaDaLojaSql('created_at')} AS day,
                COUNT(*) AS sales_count,
                COALESCE(SUM(total_cents), 0) AS revenue_cents
           FROM core_sales
          WHERE company_id = ? AND ${recorteDaVendaQueFatura()}
            AND ${diaDaLojaSql('created_at')} >= ? AND ${diaDaLojaSql('created_at')} <= ?
          GROUP BY day ORDER BY day`,
      )
      .all(companyId, from, to);

    const topProducts = db
      .prepare(
        `SELECT i.product_id, i.description,
                SUM(i.quantity) AS quantity,
                SUM(i.total_cents) AS revenue_cents
           FROM core_sale_items i
           JOIN core_sales s ON s.id = i.sale_id
          WHERE i.company_id = ? AND ${recorteDaVendaQueFatura('s')}
            AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?
          GROUP BY i.product_id, i.description
          ORDER BY revenue_cents DESC LIMIT 10`,
      )
      .all(companyId, from, to);

    // Resolve o nome do vendedor: mostrar o UUID cru no painel não ajuda quem
    // está lendo o relatório.
    const bySeller = db
      .prepare(
        `SELECT COALESCE(s.seller_id, 'sem-vendedor') AS seller_id,
                COALESCE(u.display_name, 'Sem vendedor') AS seller_name,
                COUNT(*) AS sales_count,
                COALESCE(SUM(s.total_cents), 0) AS revenue_cents
           FROM core_sales s
           LEFT JOIN core_users u ON u.id = s.seller_id
          WHERE s.company_id = ? AND ${recorteDaVendaQueFatura('s')}
            AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?
          GROUP BY s.seller_id, u.display_name
          ORDER BY revenue_cents DESC LIMIT 10`,
      )
      .all(companyId, from, to);

    /*
      VENDAS POR MARCA — GAP-V44.

      O recorte que o gerente pedia e nenhuma superfície respondia: "qual marca
      vende mais no período". O ingrediente sempre esteve em
      `core_products.brand`; o que faltava era a agregação.

      O SQL vem de `sqlDeMarcas`, em GroupInsights, e não é escrito aqui: o BI
      do grupo faz a MESMA pergunta sobre as operações do vínculo, e duas
      grafias do mesmo agrupamento seriam duas telas discordando sobre o mesmo
      dia. Lá está também a razão de "Sem marca" ser um GRUPO e não um filtro —
      no banco real zero de dezenove produtos têm marca preenchida.
    */
    const marcas = marcasDoPainel(
      // Só ESCOPO e PERÍODO. O recorte de status era escrito aqui, com
      // igualdade a 'completed', enquanto o BI escrevia diferença de
      // 'cancelled' — duas grafias do mesmo agrupamento, na metade que o
      // SELECT compartilhado não cobria. Agora ele vem de dentro de
      // `sqlDeMarcas` e não passa mais por esta chamada.
      `i.company_id = ?
         AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?`,
      [companyId, from, to],
    );
    // Com teto e com o excedente NOMEADO — ver `marcasDoPainel`.
    const byBrand = marcas.linhas;

    /*
      A PARCELA QUE NÃO TEM MARCA DONA — e por que ela é DECLARADA.

      A conta por marca soma LINHAS de item; o desconto (e o acréscimo) do
      rodapé vive no cabeçalho da venda, sem dono entre as linhas. Ratear R$
      5,00 entre três marcas exigiria escolher um critério que ninguém decidiu,
      e qualquer escolha inventaria número.

      Então a diferença sai NOMEADA, do mesmo jeito que o DRE nomeia a
      diferença para o painel: o total é `soma das marcas + esta parcela`, e
      quem lê vê de quanto ela é em vez de descobrir que as colunas não fecham.
    */
    /*
      A SOMA É DE TODAS AS MARCAS, e não das que couberam no teto.

      Era `byBrand.reduce(...)`, e ficou errada no instante em que `byBrand`
      passou a ser cortado: as marcas fora do topo apareceriam DENTRO de
      `byBrandUnallocatedCents`, e a legenda da tela — que chama esse valor de
      desconto de rodapé sem dono — passaria a chamar mercadoria de desconto.
    */
    const somaDasMarcas = marcas.somaCents;

    /*
      OS DEZ DO PAINEL, E QUANTOS FICARAM DE FORA (GAP-PRD-164).

      O corte em 10 é do cartão, não da loja: com 37 produtos abaixo do mínimo
      o painel mostrava 10 e calava os outros 27. O total vai junto, e a tela
      escreve "37 abaixo do mínimo (mostrando 10)" com o link para o relatório
      que lista todos.
    */
    const abaixoDoMinimo = listStock(companyId, { lowOnly: true });
    const lowStock = abaixoDoMinimo.slice(0, 10);

    const receivables = db
      .prepare(
        /*
          O MESMO CRITÉRIO DE "EM ABERTO" QUE A TELA DE CONTAS E O DRE USAM.

          Eram três: aqui `status = 'open'`, em Contas `settled_cents <
          amount_cents` sem olhar cancelamento, e no DRE `cancelled_at IS
          NULL`. Três telas do mesmo dono respondendo "quanto está em aberto"
          com três números.

          O carimbo ganha porque o `status` é derivado: `aplicarStatus` o
          recalcula a cada baixa, e uma baixa lançada depois do cancelamento
          devolvia a linha para 'open'. E `settled_cents < amount_cents`
          precisa vir junto porque `status` também respondia por isso.
        */
        `SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS total
           FROM core_finance_entries
          WHERE company_id = ? AND direction = 'in'
            AND cancelled_at IS NULL AND settled_cents < amount_cents`,
      )
      .get(companyId) as { total: number };

    const ticket = totals.sales_count > 0 ? Math.round(totals.revenue_cents / totals.sales_count) : 0;

    /*
      QUEM LÊ FATURAMENTO E RECEBÍVEIS É DECISÃO DO DONO (GAP-PRD-165).

      O painel abria o dinheiro ao escritório inteiro, atendente e estoquista
      inclusos, por decisão tomada no código. Agora a política da empresa
      decide, com padrão SEGURO: sem decisão, só a gerência vê os números de
      dinheiro. Para os outros o painel continua útil — quantas vendas, quais
      produtos saíram, o que está abaixo do mínimo —, e o DINHEIRO sai da
      resposta no servidor, com `dinheiroOculto` para a tela dizer por quê.
      A política é a da empresa OLHADA (o seletor de operação), não a da sessão.
    */
    const dinheiro = veDinheiroDoPainel(companyId, scope(req).profiles);
    const semValor = <T extends Record<string, unknown>>(linhas: T[]): T[] =>
      dinheiro ? linhas : linhas.map((l) => ({ ...l, revenue_cents: null }));

    /*
      A LOJA ONLINE AO LADO, COM O PRÓPRIO NÚMERO (GAP-PRD-132).

      O faturamento deste cartão continua sendo venda de balcão (é o que o
      rótulo diz, e o que as outras quatro consultas recortam). O pedido online
      pago no recorte vem separado, pela régua do DRE (dia do pagamento, total
      pago): somado ao faturamento, fecha com Relatórios › Vendas do período.
    */
    const online = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total
           FROM core_orders
          WHERE company_id = ? AND ${recorteDoPedidoQueFatura()}
            AND ${diaDaLojaSql('paid_at')} >= ? AND ${diaDaLojaSql('paid_at')} <= ?`,
      )
      .get(companyId, from, to) as { n: number; total: number };

    res.json({
      revenueCents: dinheiro ? totals.revenue_cents : null,
      salesCount: totals.sales_count,
      // A loja online ao lado (GAP-PRD-132): o valor segue a política de
      // dinheiro do painel (GAP-PRD-165); a contagem de pedidos é contagem.
      onlineRevenueCents: dinheiro ? online.total : null,
      onlineOrdersCount: online.n,
      averageTicketCents: dinheiro ? ticket : null,
      openReceivablesCents: dinheiro ? receivables.total : null,
      dinheiroOculto: !dinheiro,
      byDay: semValor(byDay as Record<string, unknown>[]),
      topProducts: semValor(topProducts as Record<string, unknown>[]),
      bySeller: semValor(bySeller as Record<string, unknown>[]),
      byBrand: semValor(byBrand as unknown as Record<string, unknown>[]),
      byBrandUnallocatedCents: dinheiro ? totals.revenue_cents - somaDasMarcas : null,
      // As linhas de `listStock` carregam custo e valor: o cartão não os mostra,
      // e a resposta também não os entrega a quem a política não deixa ver.
      lowStock: veCustoDoEstoque(companyId, scope(req).profiles)
        ? lowStock
        : lowStock.map((l) => ({ ...l, cost_cents: null, value_cents: null, valuation_cost_cents: null })),
      lowStockTotal: abaixoDoMinimo.length,
      /*
        O ESCOPO VIAJA DE VOLTA (GAP-V46): a tela desenha o seletor com estas
        duas coisas e não precisa adivinhar em qual operação está olhando —
        que é o que o `reload` fazia por ela.
      */
      companyId,
      companies: doVinculo.map((c) => ({ id: c.id, tradeName: c.trade_name })),
      /*
        O AVISO DO CERTIFICADO CHEGA A QUEM NÃO FOI PROCURÁ-LO — GAP-V40.

        A frase de renovação existia e só aparecia em Fiscal › Certificado, da
        operação certa. Com seis empresas, isso é não avisar ninguém: o A1
        vence, a emissão para, e a descoberta acontece no balcão.

        Vem `null` enquanto há folga — banner que aparece todo dia deixa de ser
        lido. E vem SÓ o aviso: nada do titular, do CNPJ ou do arquivo. O
        painel é aberto a todo o escritório, e "o A1 vence em 23 dias" é
        informação operacional; o cartão do certificado continua atrás do
        perfil de dono.
      */
      certificateAlert: getCertificateView(companyId).alerta,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- oficinas
//
// Toda rota daqui exige, além da empresa da sessão, uma OFICINA. É a
// combinação company_id + workshop_id que mantém a Oficina de Celulares
// (dentro do Preço Justo) separada da Oficina de Mobilidade.

interface WorkshopRow {
  id: string;
  company_id: string;
  slug: string;
  name: string;
  kind: string;
}

function listWorkshopsOf(companyId: string): WorkshopRow[] {
  ensureCoreSchema();
  return getConnection()
    .prepare('SELECT * FROM core_workshops WHERE company_id = ? AND active = 1 ORDER BY name')
    .all(companyId) as unknown as WorkshopRow[];
}

/**
 * Resolve a oficina da requisição.
 *
 * O técnico só alcança oficinas em que está vinculado; gestores alcançam
 * qualquer oficina da própria empresa. Se a empresa tiver uma única oficina,
 * ela é assumida por padrão para não obrigar o cliente a informá-la.
 */
function resolveWorkshop(req: AuthedRequest, required = true): WorkshopRow | null {
  const { companyId, userId, profiles } = scope(req);
  const asked =
    (req.query.workshopId as string | undefined) ?? (req.body?.workshopId as string | undefined);

  const available = listWorkshopsOf(companyId);
  const isManager =
    profiles.includes('admin_geral')
    || profiles.includes('gestor')
    || profiles.includes('gerente_oficina');

  const allowed = isManager
    ? available
    : available.filter((w) => {
        const member = getConnection()
          .prepare('SELECT 1 AS ok FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?')
          .get(w.id, userId) as { ok?: number } | undefined;
        return Boolean(member?.ok);
      });

  if (asked) {
    const found = allowed.find((w) => w.id === asked || w.slug === asked);
    if (!found) {
      throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Oficina não autorizada para este usuário.', 403);
    }
    return found;
  }
  if (allowed.length === 1) return allowed[0];
  if (!required) return null;
  // Empresa SEM bancada nenhuma não "atende mais de uma" (GAP-PRD-110): a frase
  // antiga mandava a gestão da PJ Motors escolher uma oficina que não existe.
  if (available.length === 0) {
    throw new ApiError(
      'CORE_COMPANY_WITHOUT_WORKSHOP',
      'Esta empresa não tem oficina nem bancada: cadastro de máquina, OS e plaquinha são da oficina do '
        + 'grupo. A moto da loja recebe a plaquinha da oficina em Estoque › Unidades.',
      409,
    );
  }
  throw new ApiError(
    'CORE_WORKSHOP_REQUIRED',
    'Informe a oficina (workshopId) — este usuário atende mais de uma.',
    400,
  );
}

/**
 * As oficinas que esta sessão pode enxergar — como ESCOPO, não como ausência.
 *
 * ## O buraco que isto fecha
 *
 * `resolveWorkshop(req, false)` devolve `null` quando o usuário atende mais de
 * uma oficina ou nenhuma, e quem chama some com o `WHERE` de oficina. Funciona
 * por acidente: o resultado certo sai porque o filtro desapareceu, não porque
 * alguém decidiu o alcance. O dia em que outro filtro for acrescentado ao lado,
 * o alcance muda sem ninguém perceber.
 *
 * ## E o buraco que NÃO se pode fechar fechando o caixa
 *
 * A tentação é traduzir "não é membro de oficina" para lista vazia. No banco da
 * loja isso quebraria o atendimento: o caixa da oficina (`oficina.pdv`,
 * perfil `operador_caixa_oficina`) NÃO tem linha em `core_workshop_members` —
 * só os cinco mecânicos têm — e é ele quem cobra a OS pronta. Lista vazia
 * zeraria a fila de pagamento dele.
 *
 * Então a regra é: quem é gerente vê todas; quem é membro vê as suas; quem não
 * é nem um nem outro vê todas da empresa, que é o que ele já via. A empresa
 * continua sendo a fronteira real, e ela é imposta pelo `company_id` em toda
 * consulta.
 */
function resolveWorkshopScope(req: AuthedRequest): string[] | null {
  const { companyId, userId, profiles } = scope(req);
  const pedida = req.query.workshopId as string | undefined;

  const disponiveis = listWorkshopsOf(companyId);
  const gerente =
    profiles.includes('admin_geral')
    || profiles.includes('gestor')
    || profiles.includes('gerente_oficina');

  const minhas = gerente
    ? disponiveis
    : disponiveis.filter((w) => {
        const vinculo = getConnection()
          .prepare('SELECT 1 AS ok FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?')
          .get(w.id, userId) as { ok?: number } | undefined;
        return Boolean(vinculo?.ok);
      });

  // Pediu uma oficina específica: só passa se ela estiver no alcance.
  if (pedida) {
    const permitidas = minhas.length > 0 ? minhas : disponiveis;
    const achada = permitidas.find((w) => w.id === pedida || w.slug === pedida);
    if (!achada) {
      throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Oficina não autorizada para este usuário.', 403);
    }
    return [achada.id];
  }

  // Sem vínculo nenhum: o alcance é a empresa inteira, como sempre foi.
  if (minhas.length === 0) return null;
  return minhas.map((w) => w.id);
}

/**
 * A bancada onde a OS (ou o equipamento) ENTRA — a régua de quem abre, e não
 * a de quem conserta (GAP-PRD-099). A decisão mora em `WorkshopIntakeService`;
 * aqui só se lê a oficina pedida, do corpo ou da query, como `resolveWorkshop`.
 */
function resolveBancadaDeEntrada(req: AuthedRequest): BancadaDeEntrada {
  const { companyId, userId, profiles } = scope(req);
  const pedida =
    (req.query.workshopId as string | undefined) ?? (req.body?.workshopId as string | undefined);
  return bancadaDeEntrada({ companyId, userId, profiles, pedida });
}

/**
 * A voz de quem comenta na OS (GAP-PRD-102): gestão, técnico ou balcão.
 *
 * O atendente e o caixa da oficina caíam em "técnico" e levavam a trava de
 * responsável em toda OS assumida. Quem também é mecânico continua falando
 * como técnico — a trava é dele.
 */
function vozNaOs(req: AuthedRequest): 'gestor' | 'tecnico' | 'balcao' {
  if (isManagerProfile(req)) return 'gestor';
  return (req.auth?.profileCodes ?? []).includes('mecanico') ? 'tecnico' : 'balcao';
}

function actorName(req: AuthedRequest): string {
  const user = findUserById(scope(req).userId);
  return user?.display_name ?? 'Usuário';
}

function isManagerProfile(req: AuthedRequest): boolean {
  const profiles = req.auth?.profileCodes ?? [];
  return (
    profiles.includes('admin_geral')
    || profiles.includes('gestor')
    || profiles.includes('gerente_oficina')
  );
}

coreRouter.get('/workshops', (req: AuthedRequest, res, next) => {
  try {
    /*
      A lista de oficinas com as capacidades de cada uma. As quatro telas que a
      pedem são ROTA_GESTAO. A bancada não perde nada: `GET /workshop/orders`
      já devolve `workshops` no mesmo pacote, para a tela montar o seletor.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    // As capacidades vêm junto: a tela não pode repetir a regra de qual oficina
    // usa plaquinha, senão as duas divergem na primeira mudança.
    res.json({
      items: listWorkshopsOf(companyId).map((w) => ({
        ...w,
        capabilities: capabilitiesFor(
          String((w as unknown as Record<string, unknown>).kind ?? ''),
        ),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * EM NOME DE QUEM CADA BANCADA IMPRIME.
 *
 * A Ordem de Serviço da Oficina saía com o nome PJ MOTORS, e a escolha morava
 * numa migração — fora do alcance de quem opera, e reimposta a cada subida do
 * servidor. O vínculo é legítimo (quem vendeu a moto responde pela garantia
 * dela), mas é decisão de negócio, e decisão de negócio tem tela.
 */
coreRouter.get('/workshops/brands', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listarMarcasDasBancadas(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/workshops/:id/brand', (req: AuthedRequest, res, next) => {
  try {
    // Trocar a identidade de um documento que vai para o cliente é ato de
    // gerência, não de balcão.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      definirMarcaDaBancada({
        companyId,
        workshopId: String(req.params.id),
        brandCompanyId: req.body?.brandCompanyId ?? null,
        userId,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- fiscal
//
// Configuração fiscal é de gestão. Mecânico não acessa: o RBAC é verificado
// aqui, na rota, e não só escondendo o item no menu — quem tem token pode
// chamar a API direto.

coreRouter.get('/fiscal/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(getFiscalConfig(companyId));
  } catch (err) {
    next(err);
  }
});

/**
 * "A comunicação com a SEFAZ funciona?" — a pergunta que o sistema não sabia
 * responder (rodada 58).
 *
 * ## O defeito
 *
 * `statusServico` existe nos dois adapters e fala SOAP de verdade contra o
 * webservice do estado — e ninguém o chamava: nem rota, nem tela. A tela do
 * certificado dizia `CERTIFICATE_LOADED · FALTA TESTE REAL CONTRA A SEFAZ`,
 * cobrando um teste que ela mesma não oferecia. Terceira vez que esta base
 * repete o padrão de código nascido sem porta.
 *
 * ## Por que o status, e não uma nota de teste
 *
 * `statusServico` é a única conversa com o fisco que NÃO cria documento. Ela
 * responde as quatro perguntas que interessam a quem acabou de subir o
 * certificado — a senha abre o arquivo, o TLS fecha com a chave, a SEFAZ do
 * estado está de pé, e a cadeia do certificado é aceita por ela — sem gastar
 * numeração e sem exigir produto classificado. Emitir para testar exigiria
 * CRT, série, NCM, CFOP e destinatário, e cada pendência de CADASTRO
 * esconderia a resposta sobre a COMUNICAÇÃO, que é o que se perguntou.
 *
 * ## Sem simulador aqui
 *
 * Todas as outras rotas fiscais caem no `SefazTestAdapter` quando não há
 * senha, fora de produção — é o caminho de desenvolvimento das telas. Esta
 * NÃO cai: uma tela que responde "SEFAZ de pé" sem ter falado com a SEFAZ é
 * pior que tela nenhuma. Sem senha, sem certificado ou sem UF, a rota diz o
 * que falta.
 */
coreRouter.post('/fiscal/sefaz/status', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);

      /*
        A unidade é conferida PRIMEIRO (GAP-PRD-180): é erro do pedido, não da
        configuração. As rotas irmãs só conhecem uma unidade — aceitar outra
        aqui testaria a SEFAZ com um arquivo que nenhuma emissão usa, e o
        "tudo certo" seria sobre o lugar errado.
      */
      const unidade = unidadeFiscalDoPedido(req.body?.operationalUnitId);

      const senha = String(req.body?.certificatePassword ?? '').trim();
      if (!senha) {
        throw new ApiError(
          'CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED',
          'Informe a senha do certificado para este teste de comunicação. '
            + 'A emissão normal usa a senha selada no cofre; aqui ela é digitada '
            + 'de propósito, para provar que a senha que você conhece abre o A1.',
          400,
        );
      }

      const config = getFiscalConfig(companyId);
      const uf = String(config.uf ?? '').trim().toUpperCase();
      if (!uf) {
        throw new ApiError(
          'CORE_FISCAL_UF_REQUIRED',
          'Informe a UF do emitente na configuração fiscal: o endereço da SEFAZ depende do estado.',
          400,
        );
      }

      /*
        O certificado é aberto AQUI, antes de chamar a SEFAZ, para separar os
        dois erros que a tela precisa distinguir: senha que não abre o arquivo
        (problema de quem digitou) e SEFAZ que não responde (problema de rede
        ou do fisco). O `getCertificateA1` já recusa certificado vencido.
      */
      // A `unidade` foi conferida no topo da rota (GAP-PRD-180).
      let cert;
      try {
        cert = getCertificateA1(companyId, unidade, senha);
      } catch (err) {
        /*
          O erro do cofre é traduzido para o que quem está na TELA precisa
          fazer. "Certificado não configurado no backend" (404) é vocabulário
          de quem escreveu o servidor; quem lê é o dono, e o que ele precisa
          saber é que falta subir o arquivo — ou que a senha não abriu.
        */
        const codigo = (err as { code?: string }).code;
        if (codigo === 'FISCAL_CERTIFICATE_NOT_FOUND') {
          throw new ApiError(
            'CORE_SEFAZ_CERTIFICATE_REQUIRED',
            'Esta operação ainda não tem certificado A1. Suba o arquivo antes de testar a comunicação.',
            400,
          );
        }
        if (codigo === 'FISCAL_CERTIFICATE_EXPIRED') {
          throw err;
        }
        if (codigo === 'FISCAL_CERTIFICATE_PASSWORD_INVALID') {
          throw new ApiError(
            'CORE_SEFAZ_CERTIFICATE_PASSWORD_INVALID',
            'A senha não abriu o certificado. Confira se é a senha deste arquivo .pfx.',
            400,
          );
        }
        /*
          O QUE SOBRA NÃO É CULPA DE QUEM DIGITOU. `decryptFiscalSecret`
          estoura sem `code` quando a chave do cofre não confere — e ela vai
          mudar: o servidor RECUSA subir em produção com a chave padrão de
          desenvolvimento, que é a que cifrou o certificado de hoje. No dia da
          virada, acusar a senha mandaria o dono redigitar para sempre uma
          senha certa; o conserto real é subir o .pfx de novo, e é isso que a
          mensagem passa a dizer.

          Colapsar "o cofre não abre" dentro de "a senha não abriu" seria
          repetir, um degrau abaixo, o mesmo defeito que esta rodada existe
          para consertar.
        */
        throw new ApiError(
          'CORE_SEFAZ_CERTIFICATE_UNREADABLE',
          'O certificado guardado não pode ser aberto por este servidor. '
            + 'Isso acontece quando a chave de segurança do cofre muda — envie o arquivo .pfx de novo.',
          400,
        );
      }

      const adapter = new SefazRealAdapter({ cert });
      let resultado;
      try {
        resultado = await adapter.statusServico({ uf, environment: config.environment });
      } catch (err) {
        /*
          ERRO DE NEGÓCIO PASSA INTEIRO. `resolverEndpointReal` levanta
          `CORE_SEFAZ_ENDPOINT_NOT_CONFIGURED` (501) quando a UF não tem
          endereço mapeado — hoje só o RS tem. Traduzir isso para "não foi
          possível alcançar a SEFAZ" mandaria o dono de outro estado conferir
          firewall e proxy por um problema que é do NOSSO cadastro de
          endereços, e que nenhuma configuração dele resolve.
        */
        if (err instanceof ApiError) throw err;

        /*
          Não alcançar a SEFAZ NÃO é a SEFAZ estar parada. A primeira é
          problema daqui — firewall, DNS, proxy, a própria UF bloqueando —, a
          segunda é do fisco, e só a segunda se resolve esperando. 502 porque
          o erro é de gateway: este servidor não conseguiu falar com o outro.
        */
        /*
          Pelo TIPO, não pelo nome. A checagem era `err.name ===
          'TimeoutError'` — idioma correto no PaymentService, onde o fetch usa
          `AbortSignal.timeout` e o runtime produz esse nome. Aqui o transporte
          embrulha tudo em `TransportFailure`, então nenhum timeout casava: o
          caso mais comum — fisco lento, justamente quando esperar resolve —
          caía no ramo genérico e mandava o dono caçar firewall e proxy.
        */
        const timeout = err instanceof TransportFailure && err.kind === 'TIMEOUT';

        /*
          O MOTIVO TÉCNICO VAI JUNTO (rodada 59), e é a lição de um erro meu.

          O dono testou com o A1 real e leu "confira a conexão, o proxy e se a
          UF permite o acesso" — foi caçar firewall. A rede estava limpa: a
          SEFAZ recusou o CERTIFICADO, porque mandávamos a folha sem a cadeia.
          O transporte tinha o motivo exato do TLS ("unable to verify the
          first certificate") e esta rota o descartava para escrever uma frase
          genérica que apontava para o lado errado.

          A frase amigável continua na frente, porque é ela que orienta quem
          não lê inglês de TLS. O motivo vem atrás, entre parênteses, para
          quem for investigar. Nada aqui carrega segredo: é a mensagem do
          erro de rede, nunca a senha nem o conteúdo do certificado.
        */
        const motivo = String((err as Error)?.message ?? '').trim();
        const frase = timeout
          ? 'A SEFAZ não respondeu no tempo esperado. Costuma ser o fisco sobrecarregado — tente de novo em alguns minutos.'
          : 'Não foi possível completar a conversa com a SEFAZ. Pode ser a conexão daqui ou o certificado que o fisco recusou.';

        throw new ApiError(
          'CORE_SEFAZ_UNREACHABLE',
          motivo ? `${frase} (motivo técnico: ${motivo})` : frase,
          502,
        );
      }

      recordAudit({
        companyId,
        userId,
        action: 'fiscal.sefaz_status_checked',
        entityType: 'fiscal_config',
        entityId: companyId,
        // O resultado, nunca a senha: a trilha é prova de diligência para o
        // contador, e diligência não inclui guardar segredo do dono.
        detail: {
          uf,
          environment: config.environment,
          online: resultado.online,
          cStat: resultado.cStat,
        },
      });

      /*
        200 mesmo com `online: false`: a PERGUNTA foi respondida com sucesso —
        o que veio é que o fisco está parado. Devolver erro faria a tela dizer
        "não foi possível perguntar" quando a verdade é "perguntei, e a SEFAZ
        disse que está fora".
      */
      res.json({
        ...resultado,
        uf,
        environment: config.environment,
        certificate: {
          subject: cert.subject,
          cnpj: cert.cnpj,
          validTo: cert.validTo,
          /*
            QUANTOS CERTIFICADOS O .PFX TROUXE (rodada 59).

            Um arquivo da ICP-Brasil normalmente traz a folha MAIS a
            autoridade que a emitiu. Quando traz só a folha, o handshake com a
            SEFAZ pode ser recusado por mais que o nosso código esteja certo —
            e aí o conserto é do lado de fora: baixar as intermediárias no
            site da AC e regerar o .pfx. Sem este número, essa diferença é
            invisível para quem está na tela, e ninguém consegue distinguir
            "o sistema está errado" de "o arquivo está incompleto".
          */
          chainLength: (cert.chainPem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length,
        },
      });
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.patch('/fiscal/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const config = updateFiscalConfig({ companyId, patch: req.body ?? {} });
    recordAudit({
      companyId,
      userId,
      action: 'fiscal.config_update',
      entityType: 'fiscal_config',
      entityId: companyId,
      // Os campos alterados, nunca valores de segredo — não há segredo aqui,
      // mas a regra vale para quando houver.
      detail: { fields: Object.keys(req.body ?? {}) },
    });
    res.json(config);
  } catch (err) {
    next(err);
  }
});

/*
  O DIAGNÓSTICO DO COFRE — para o dono, e só.

  Responde o ESTADO de cada segredo, nunca o valor. Existe porque a
  pergunta "posso publicar?" depende dele: uma chave de cifra padrão em
  produção é produção sem cofre, e um certificado selado com a chave antiga
  é um certificado que não abre depois da rotação.

  `requireProfile(req)` sem perfil extra: só `admin_geral` e `gestor`.
  Gerente não entra — saber que a senha do certificado está ausente é
  informação de quem responde pelo sistema, não de quem opera a loja.
*/
coreRouter.get('/system/secrets-readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    res.json(prontidaoDosSegredos());
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const model = String(req.query.model ?? '');
    const models = model ? [model] : [...FISCAL_MODELS];
    res.json({
      items: models.map((m) => buildReadiness(companyId, m)),
      /*
        O PARECER DA PRODUÇÃO VIAJA JUNTO (GAP-V42).

        A tela que mostra o checklist é a mesma que mostra o ambiente; pedir
        uma segunda chamada para saber se o botão de liberar produção está
        desligado — e por quê — faria a tela desenhar o botão antes de saber a
        resposta, e piscar depois.
      */
      productionUnlock: assessProductionUnlock(companyId),
      /*
        O RESUMO DA CLASSIFICAÇÃO DO CATÁLOGO, uma vez — e não uma por modelo.

        O checklist vem por modelo (NFC-e e NF-e têm exigências diferentes), mas
        o catálogo é um só: repetir a contagem dentro de cada relatório faria a
        tela somar produtos duas vezes se alguém distraído os somasse, que é o
        tipo de armadilha que um número duplicado sempre acaba armando.
      */
      classification: summarizeClassification(companyId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * ============================================================================
 * O PAINEL DE CLASSIFICAÇÃO — o que o XML sugeriu, produto a produto
 * ============================================================================
 *
 * Responde a pergunta que a lista de pendências não respondia: dos produtos que
 * faltam classificar, QUANTOS já têm resposta pronta vinda do XML de um
 * fornecedor? A rota de `product-pendencies` continua sendo a que aponta o que
 * BLOQUEIA a emissão; esta é a que mostra o que o sistema já descobriu sozinho
 * e está esperando um humano dizer "sim".
 *
 * `all=1` devolve o catálogo inteiro; o padrão da tela devolve só quem tem algo
 * a resolver — sugestão aplicável ou divergência.
 *
 * ALCANCE: os mesmos perfis de `product-pendencies`, e pelo mesmo motivo — quem
 * classifica produto é quem responde pelo cadastro. O contador NÃO entra: ele é
 * gente de fora que recebe o pacote do mês, e a chave do catálogo não é dele.
 */
coreRouter.get('/fiscal/classification', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    const todos = String(req.query.all ?? '') === '1';
    const productId = String(req.query.productId ?? '').trim();
    /*
      COM `productId`, é a ficha do produto perguntando pela PRÓPRIA
      classificação — e aí `onlyOpen` não faz sentido: quem abre a ficha quer
      a resposta mesmo quando não há nada a resolver ("veio do XML da nota
      1024, confirmado por Fulano em março").
    */
    res.json({
      items: productId
        ? listProductClassifications(companyId, { productId })
        : listProductClassifications(companyId, { onlyOpen: !todos }),
      summary: summarizeClassification(companyId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * CONFIRMAR EM LOTE — o clique que tira a digitação do caminho.
 *
 * Corpo VAZIO significa "tudo que é inequívoco": campo vazio no cadastro, um
 * único valor sugerido, produto que ninguém confirmou ainda. É o caso comum, e
 * é o que transforma trinta notas de fornecedor em trinta produtos
 * classificados sem ninguém digitar um dígito.
 *
 * Com `items`, é escolha explícita — e só ela resolve DIVERGÊNCIA: quando dois
 * fornecedores discordam sobre o NCM da mesma mercadoria, escolher é decidir, e
 * decidir é justamente o que uma pessoa pode fazer e um lote não.
 *
 * A TRILHA SÓ REGISTRA QUANDO ALGO MUDOU. Gravar a cada clique encheria a
 * auditoria de linhas idênticas e faria o ato que importa — o primeiro, com
 * autor e data — sumir no meio delas. É a mesma regra do desbloqueio da
 * produção, logo abaixo.
 */
/**
 * RELER AS NOTAS JÁ RECEBIDAS (GAP-PRD-181).
 *
 * O parser passou a ler o emitente inteiro, o destinatário e a tributação
 * declarada nos itens; as notas que já tinham entrado continuavam com o que a
 * leitura antiga deixou — e sem sugestão de classificação nenhuma. Esta rota
 * relê o XML guardado de cada nota da empresa e completa SÓ o que está nulo
 * (ver `relerNotasRecebidas`). Nada é confirmado sozinho.
 *
 * GERÊNCIA: escreve no cadastro de fornecedor e na procedência do produto, e
 * percorre todas as notas da empresa.
 */
coreRouter.post('/fiscal/classification/reler-notas', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(relerNotasRecebidas({ companyId, userId }));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/classification/confirm', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : undefined;
    const resultado = confirmClassification({ companyId, userId, items });

    if (resultado.confirmed > 0) {
      recordAudit({
        companyId,
        userId,
        action: 'fiscal.classification_confirmed',
        entityType: 'product',
        // O lote não tem UMA entidade: o alvo é o catálogo desta operação, e a
        // lista do que mudou vai no detalhe, produto por produto.
        entityId: companyId,
        detail: {
          confirmed: resultado.confirmed,
          products: resultado.products,
          applied: resultado.applied,
          // De onde veio o valor aceito. É esta palavra que, meses depois,
          // separa "o contador decidiu" de "o fornecedor sugeriu e alguém
          // confirmou".
          source: 'supplier_xml',
        },
      });
    }
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/**
 * A CHAVE DA PRODUÇÃO — GAP-V42.
 *
 * O portão existia e nunca teve chave: `updateFiscalConfig` recusa
 * `environment = 'production'` enquanto `production_unlocked` for 0, e NENHUMA
 * linha de código escrevia essa coluna nem as duas do carimbo. No dia da
 * virada, ligar produção seria um UPDATE na mão no banco — sem autor, sem
 * data e sem trilha.
 *
 * ALCANCE: `requireProfile(req)` sem perfil extra. Liberar emissão com valor
 * jurídico é ato de quem responde pela empresa, não de quem opera a loja — a
 * mesma régua do certificado, que é o outro artefato capaz de produzir nota
 * real.
 *
 * A condição é a REAL, e mora no serviço: autorização de verdade na SEFAZ de
 * homologação, com protocolo que não é do simulador. `readiness ===
 * 'HOMOLOGATED'` NÃO serve — o simulador o satisfaz.
 */
coreRouter.post('/fiscal/production-unlock', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    const parecer = unlockProduction({ companyId, userId });

    /*
      A trilha registra o ato e A PROVA que o autorizou. Repetir o registro a
      cada clique encheria a auditoria de linhas idênticas e faria o ato
      original — o que tem autor e data — sumir no meio delas.
    */
    if (!parecer.alreadyUnlocked) {
      recordAudit({
        companyId,
        userId,
        action: 'fiscal.production_unlocked',
        entityType: 'fiscal_config',
        entityId: companyId,
        detail: { evidence: parecer.evidence, unlockedAt: parecer.unlockedAt },
      });
    }
    res.json(parecer);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- documentos fiscais

/**
 * Dispara o pipeline fiscal de uma venda.
 *
 * O caixa pode chamar: emitir a nota da própria venda é parte do fechamento.
 * A idempotência mora no serviço — chamar duas vezes não gera segundo número.
 */
coreRouter.post('/fiscal/sales/:saleId/emit', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
      const { companyId, userId } = scope(req);

      // O modo de desenvolvimento (assinatura de fixture + provider de teste)
      // só existe fora de produção. A checagem definitiva está no serviço; aqui
      // ela é repetida para que a intenção fique explícita na rota.
      const dev = req.body?.developmentMode === true && loadEnv().DEVORA_API_ENV !== 'production';

      const resultado = await emitNfceForSale({
        companyId,
        saleId: String(req.params.saleId),
        userId,
        certificatePassword: req.body?.certificatePassword,
        developmentMode: dev,
        // O cenário só atravessa quando o modo de desenvolvimento está ligado,
        // que já é impossível em produção.
        testScenario: dev ? req.body?.testScenario : undefined,
      });
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

// O painel do PDV pergunta ANTES de mostrar o botão. Por venda, e não pela
// operação: pendência de catálogo não pode esconder o botão de uma venda que
// está completa, e operação impecável não autoriza venda com item sem NCM.
coreRouter.get('/fiscal/sales/:saleId/emission-readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    res.json(emissionReadinessForSale(companyId, String(req.params.saleId)));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/sales/:saleId/status', (req: AuthedRequest, res, next) => {
  try {
    /*
      O painel fiscal do PDV pergunta se a venda já virou nota. A emissão logo
      acima já aceitava os três caixas e os dois gerentes.
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(fiscalStatusForSale(companyId, String(req.params.saleId)));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/documents', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    res.json({ items: listFiscalDocuments(companyId, req.query as Record<string, string>) });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/documents/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    // A MESMA linha da lista: valor, venda e destinatário juntos. `getDocument`
    // devolve só o documento, e a tela mostrava "R$ NaN".
    const doc = getFiscalDocumentRow(companyId, String(req.params.id));
    if (!doc) {
      throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
    }
    res.json({
      document: doc,
      events: listDocumentEvents(companyId, doc.id),
    });
  } catch (err) {
    next(err);
  }
});

/** DANFCE. Preview técnico exige pedido explícito e sai com tarja. */
coreRouter.get('/fiscal/documents/:id/danfce', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    /*
      A BOBINA DA IMPRESSORA DE CUPOM (auditoria PJ, F-cupom-fiscal-07#danfce).
      Esta rota chamava `renderDanfce` sem largura: o DANFCE saía sempre em
      80 mm, mesmo com a térmica de 58 mm cadastrada. Agora a largura é a da
      impressora de cupom do caixa (`?terminalId=`, ou o do token de
      dispositivo; sem nenhum, o caixa da venda da nota).

      Aqui é `terminalDoPedido`, e não `caixaNoEscopo`: esta rota só LÊ o
      papel (não cria job nem abre gaveta), e o gerente de acesso restrito a
      alguns caixas abre o DANFCE pela tela de documentos fiscais sem escolher
      caixa — `caixaNoEscopo` passaria a recusar isso com "Escolha o caixa".
    */
    const caixa = terminalDoPedido({ informado: req.query.terminalId, doDispositivo: req.auth?.storeId });
    assertTerminalDaEmpresa(companyId, caixa);
    const impressora = impressoraDoDanfce(companyId, String(req.params.id), caixa);
    const html = renderDanfce(companyId, String(req.params.id), {
      allowUnauthorized: req.query.preview === '1',
      larguraMm: impressora?.paper_width_mm ?? null,
    });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

/**
 * Resumo fiscal para o balcão.
 *
 * O caixa precisa de duas informações antes e depois de vender: dá para emitir
 * nesta operação, e há alguma nota precisando de atenção. O detalhe completo
 * fica na tela de configuração; aqui vai o suficiente para decidir.
 */
coreRouter.get('/fiscal/pdv-summary', (req: AuthedRequest, res, next) => {
  try {
    // O operador de caixa PRECISA ver isto — é a nota da venda dele.
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    /*
      O RESUMO MORA NUM SERVIÇO (auditoria P0 da Preço Justo): a situação, o
      ambiente, a frase com o que falta e quem resolve, e a lista no texto do
      balcão — sem o detalhe do checklist, que carrega titular e CSC ID.
    */
    res.json(resumoFiscalDoPdv(companyId));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ eventos fiscais
//
// Rotas FINAS: toda regra vive no domínio. O `companyId` vem SEMPRE do token,
// nunca do corpo — aceitar do cliente permitiria cancelar a nota de outra
// operação sabendo o id.
//
// O provider é escolhido pelo servidor. Cancelamento, carta de correção e
// inutilização decidem em `adapterDoAtoFiscal` (GAP-PRD-005): o caminho segue a
// procedência da nota, e o corpo pode no máximo PEDIR o modo de desenvolvimento.

/**
 * Adapter da DISTRIBUIÇÃO DF-e (consulta e manifestação) — pela MESMA política
 * dos atos administrativos (GAP-PRD-168): `adapterDoAtoFiscal` sem nota, como
 * a inutilização. Cofre (padrão): o A1 selado da empresa do token, sem pedir
 * nada; "cada ato pede a senha": `certificatePassword` no corpo, ou 400 dizendo
 * o que fazer; sem A1: 409 dizendo onde enviá-lo. O simulador só por pedido
 * explícito (`developmentMode`) e nunca em produção (GAP-PRD-018).
 *
 * Devolve a FÁBRICA: o serviço a chama depois das validações do domínio.
 */
function fiscalAdapter(req: AuthedRequest): () => SefazAdapter {
  const { companyId } = scope(req);
  return () =>
    adapterDoAtoFiscal({
      companyId,
      documentId: null,
      developmentMode: req.body?.developmentMode === true,
      certificatePassword: req.body?.certificatePassword,
    });
}

/** O adapter de um ato administrativo — fabricado só depois das validações do domínio. */
function adapterDoAto(req: AuthedRequest, documentId: string | null): () => SefazAdapter {
  const { companyId } = scope(req);
  return () =>
    adapterDoAtoFiscal({
      companyId,
      documentId,
      developmentMode: req.body?.developmentMode === true,
      certificatePassword: req.body?.certificatePassword,
    });
}

/**
 * COMO ESTE ATO VAI À SEFAZ — a pergunta que a tela faz antes do botão.
 *
 * Mesma decisão que o ato executa: SEFAZ (e em qual ambiente), simulador (nota
 * de ensaio) ou bloqueado (com o motivo). Diz também se a senha do A1 é
 * pedida — pela política do dono ou porque o cofre não tem a senha selada.
 */
coreRouter.get('/fiscal/acts/plan', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const documentId = typeof req.query.documentId === 'string' ? req.query.documentId : null;
    res.json(planejarAtoFiscal({ companyId, documentId }));
  } catch (err) {
    next(err);
  }
});

/**
 * A DECISÃO DO DONO: cofre ou senha digitada nos atos com a SEFAZ.
 *
 * Só os donos do grupo (`requireProfile(req)` sem perfil extra, o alcance do
 * certificado): é a regra de uso do A1, e quem cancela não decide sozinho se
 * precisa saber a senha.
 */
/**
 * A NFC-e NO FINALIZAR (GAP-PRD-163) — manual (padrão) ou automática.
 *
 * Ler: a gerência vê qual está valendo, porque o balcão que ela gerencia
 * depende disso. Gravar: só os donos — ligar a emissão automática produz
 * documento fiscal sem clique, a mesma régua da política dos atos com a SEFAZ.
 */
coreRouter.get('/fiscal/emission-policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(lerPoliticaDeEmissao(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/fiscal/emission-policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    res.json(gravarPoliticaDeEmissao({ companyId, userId, modo: req.body?.modo }));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/fiscal/acts/policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    res.json(
      gravarPoliticaDosAtos({
        companyId,
        userId,
        exigirSenhaDigitada: req.body?.exigirSenhaDigitada,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A VOLTA DA CONTINGÊNCIA — o caminho que existia sem porta.
 *
 * `requeueFromContingency` estava escrito, testado e sem rota: a nota entrava
 * em contingência e não havia como devolvê-la à fila por tela nenhuma. Quem
 * decide que a SEFAZ voltou é gestão, não o caixa.
 */
coreRouter.post('/fiscal/documents/:id/reenfileirar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      requeueFromContingency({
        companyId,
        documentId: String(req.params.id),
        userId,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A FILA FISCAL NA TELA (GAP-PRD-020): o trabalhador de fundo transmite
 * sozinho; aqui o gestor VÊ (o que espera, por quê, e a última resposta da
 * SEFAZ) e AGE (transmitir agora uma nota, ou a fila inteira da operação).
 */
coreRouter.get('/fiscal/queue', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(painelDaFila(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/queue/drain', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const resultado = await drenarEmpresa({ companyId, userId });
      res.json({ resultado, painel: painelDaFila(companyId) });
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.post('/fiscal/documents/:id/transmitir', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      res.json(await transmitirAgora({ companyId, documentId: String(req.params.id), userId }));
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * A CONTINGÊNCIA OFF-LINE DA NFC-e (GAP-PRD-098). A gerência vê a modalidade,
 * o período aberto e as notas off-line pendentes, e abre ou fecha o período
 * (com justificativa ao abrir — ela vai no xJust de cada nota). A MODALIDADE e
 * o PRAZO são decisão do contador, gravada só pelos donos do grupo.
 */
coreRouter.get('/fiscal/contingency', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(painelDaContingencia(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/fiscal/contingency/policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    gravarPoliticaDeContingencia({
      companyId,
      userId,
      modo: req.body?.modo,
      prazoHoras: req.body?.prazoHoras,
      observacao: req.body?.observacao,
    });
    res.json(painelDaContingencia(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/contingency/enter', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    abrirPeriodo({
      companyId,
      userId,
      origem: 'MANUAL',
      motivo: req.body?.motivo === 'SEFAZ_UNAVAILABLE' ? 'SEFAZ_UNAVAILABLE' : 'NETWORK_UNAVAILABLE',
      justificativa: typeof req.body?.justificativa === 'string' ? req.body.justificativa : '',
    });
    res.json(painelDaContingencia(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/contingency/exit', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    encerrarPeriodo({ companyId, userId, origem: 'MANUAL', motivo: 'Encerrado pela gerência.' });
    res.json(painelDaContingencia(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/documents/:id/cancel', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      // Cancelar desfaz um documento fiscal: é decisão de gestão.
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const result = await requestCancel({
        companyId,
        documentId: String(req.params.id),
        justification: String(req.body?.justification ?? ''),
        adapter: adapterDoAto(req, String(req.params.id)),
        userId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.post('/fiscal/documents/:id/correction-letter', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const result = await requestCorrectionLetter({
        companyId,
        documentId: String(req.params.id),
        text: String(req.body?.text ?? ''),
        adapter: adapterDoAto(req, String(req.params.id)),
        userId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  })();
});

/** O aviso dos limites da carta vem do domínio, não é texto solto na tela. */
coreRouter.get('/fiscal/correction-letter/notice', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    res.json({ notice: CCE_LIMITATION_NOTICE });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/void-ranges', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: listVoidRanges(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/void-ranges', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      // Inutilizar queima numeração para sempre — não é ação de caixa.
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const result = await requestVoidRange({
        companyId,
        model: String(req.body?.model ?? ''),
        serie: Number(req.body?.serie),
        // Sem ano no corpo, o domínio usa o corrente no fuso do emitente.
        year:
          req.body?.year === undefined || req.body?.year === null || req.body?.year === ''
            ? undefined
            : Number(req.body.year),
        from: Number(req.body?.from),
        to: Number(req.body?.to),
        justification: String(req.body?.justification ?? ''),
        adapter: adapterDoAto(req, null),
        userId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * XML do documento.
 *
 * Serve a NOTA — assinada quando já foi, original enquanto não. `xml_authorized`
 * NÃO entra aqui: aquela coluna guarda o envelope de RESPOSTA da SEFAZ, que é
 * outra coisa. Quem pede "o XML da nota" e recebe o retorno do fisco leva o
 * arquivo errado para o contador.
 *
 * `?response=1` entrega a resposta, para quem está diagnosticando.
 *
 * O `procNFe` completo — nota + protocolo num só arquivo, que é o formato de
 * arquivamento — depende de compor os dois. Fica registrado como pendência:
 * hoje o protocolo está no documento e no evento, separado da nota.
 */
coreRouter.get('/fiscal/documents/:id/xml', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const doc = getDocument(companyId, String(req.params.id));
    if (!doc) {
      throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
    }
    const row = getConnection()
      .prepare('SELECT xml_original, xml_signed, xml_authorized FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as Record<string, string | null>;

    const conteudo =
      req.query.response === '1'
        ? row.xml_authorized ?? '<sem-resposta/>'
        : row.xml_signed ?? row.xml_original ?? '<vazio/>';

    res.type('application/xml').send(conteudo);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/documents/:id/danfe', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS);
    const { companyId } = scope(req);
    res.type('html').send(
      renderDanfe(companyId, String(req.params.id), {
        allowUnauthorized: req.query.preview === '1',
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/reconciliation', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(reconciliationReport(companyId));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- fechamento mensal do contador
//
// Duas rotas e uma regra de alcance só: baixar o pacote é levar para fora da
// empresa TODOS os documentos fiscais do mês, o resultado do período e os
// XMLs de compra. É decisão de GERÊNCIA, e por isso aqui está `requireProfile`
// nomeando os dois gerentes em vez de `abertaAo(req, 'escritorio')` — o
// escritório inclui estoquista e atendente, que conferem mercadoria e atendem
// cliente, não entregam a contabilidade da operação.
//
// E, desde a rodada 29, o `contador` — que é o DESTINATÁRIO do pacote.
//
// A rodada 27 entregou o que ele leva; ele continuava dependendo de alguém da
// loja lembrar de gerar e enviar todo mês, e o mês que passa é justamente o
// que ninguém percebe. Nomeá-lo aqui é o que fecha a última ponta: ele entra
// pela porta dele e busca.
//
// Por que ele NÃO vem por `abertaAo(req, 'contabilidade', 'escritorio')`: o
// escritório inteiro não alcança estas duas rotas, e trocar `requireProfile`
// por ambiente aqui alargaria o guarda para estoquista e atendente — o
// contrário do que a decisão acima diz. Ambiente é o recorte largo; estas
// duas rotas pedem o recorte estreito, e por isso continuam nomeando gente.

/** O que o mês tem, o que falta nele, e o nome do arquivo que vai sair. */
coreRouter.get('/fiscal/closings/:period/previa', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'contador');
    const { companyId } = scope(req);
    res.json(previaDoFechamento(companyId, String(req.params.period)));
  } catch (err) {
    next(err);
  }
});

/**
 * O pacote do mês, em zip.
 *
 * ## `Content-Disposition`, e por que ele só funciona com a linha do CORS
 *
 * O nome do arquivo viaja neste cabeçalho. Mas `authMiddleware` lê o token
 * SÓ do cabeçalho `Authorization` — não há cookie nem `?token=` —, então esta
 * rota não pode ser aberta com `window.open` nem com um `<a href>`: a janela
 * não manda header nenhum e recebe 401. O download é feito por `fetch` com o
 * Bearer, e aí o JavaScript precisa LER o `Content-Disposition` para saber
 * como nomear o arquivo. Ler cabeçalho de resposta entre origens exige
 * `exposedHeaders` no CORS — está em `app.ts`, com o mesmo motivo escrito lá.
 *
 * O nome vem de `montarPacote`, montado só com slug e período já validados.
 * Interpolar aqui o que veio da URL seria injeção de cabeçalho.
 *
 * ## A auditoria
 *
 * Fica AQUI e não no serviço, porque é a rota que sabe QUEM pediu. O que sai
 * daqui é a contabilidade inteira de um mês saindo da empresa; seis meses
 * depois, "quem baixou o pacote de março?" tem que ter resposta.
 *
 * E ela ficou MAIS importante quando o contador passou a poder baixar sozinho:
 * antes, o download tinha sempre um funcionário da loja atrás; agora tem uma
 * pessoa de fora, e o registro de quem levou é a única coisa que distingue
 * "o contador buscou o mês dele" de "alguém de fora levou a empresa inteira".
 */
coreRouter.get('/fiscal/closings/:period/pacote', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'contador');
    const { companyId, userId } = scope(req);
    const period = String(req.params.period);
    const pacote = montarPacote(companyId, period);

    recordAudit({
      companyId,
      userId,
      action: 'fiscal.closing.package',
      entityType: 'fiscal_closing',
      entityId: period,
      detail: {
        period,
        nomeArquivo: pacote.nomeArquivo,
        bytes: pacote.bytes.length,
        // A prova do que saiu (GAP-PRD-176): é por este registro que
        // `/fiscal/closings/conferir` reconhece o zip meses depois.
        sha256: pacote.sha256,
        manifestoSha256: pacote.manifestoSha256,
      },
    });

    res.type('application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pacote.nomeArquivo}"`);
    // Exposto pelo CORS (app.ts): a tela mostra o número a quem baixou.
    res.setHeader('X-Pacote-Sha256', pacote.sha256);
    res.send(pacote.bytes);
  } catch (err) {
    next(err);
  }
});

/**
 * CONFERIR UM PACOTE RECEBIDO (GAP-PRD-176).
 *
 * O contador calcula o SHA-256 do zip (ou só do MANIFESTO.csv) que tem na mão
 * e pergunta: foi este que o sistema entregou? A resposta vem da trilha de
 * auditoria do download e do envio por e-mail — com quando, por quem e qual
 * mês. Só a empresa do token: o pacote da vizinha não é reconhecido aqui.
 *
 * Mesmo alcance do download: os dois gerentes e o contador.
 */
coreRouter.get('/fiscal/closings/conferir', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'contador');
    const { companyId } = scope(req);
    res.json(conferirPacote(companyId, String(req.query.sha256 ?? '')));
  } catch (err) {
    next(err);
  }
});

// --------------------------------- o pacote SAI da empresa (GAP-V30/V31)
//
// Cinco rotas de cadastro/agenda e duas de envio/histórico, todas guardadas
// pelos MESMOS dois gerentes do download — e SEM o `contador`: ele é a pessoa
// de fora que RECEBE o mês; decidir para onde a contabilidade vai, quando vai
// sozinha e mandá-la agora é ato de quem responde pela operação. A varredura
// do contador cobra o 403 de cada uma.
//
// A auditoria destas rotas mora no SERVIÇO, e não aqui como no download — de
// propósito: a agenda dispara o mesmo envio SEM rota nenhuma, e duas trilhas
// para o mesmo fato divergiriam na primeira mudança.

coreRouter.get('/fiscal/contador/destinatarios', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: listarDestinatarios(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/contador/destinatarios', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const destinatario = criarDestinatario({
      companyId,
      userId,
      name: String(req.body?.name ?? ''),
      email: String(req.body?.email ?? ''),
    });
    res.status(201).json({ destinatario });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/fiscal/contador/destinatarios/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const destinatario = atualizarDestinatario({
      companyId,
      userId,
      id: String(req.params.id),
      name: req.body?.name === undefined ? undefined : String(req.body.name),
      email: req.body?.email === undefined ? undefined : String(req.body.email),
      active: req.body?.active === undefined ? undefined : Boolean(req.body.active),
    });
    res.json({ destinatario });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/contador/agenda', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    // Agenda nunca gravada é `null` — a tela mostra o formulário vazio, e não
    // um padrão inventado que pareceria escolha de alguém.
    res.json({ agenda: agendaDoContador(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/fiscal/contador/agenda', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const agenda = gravarAgendaDoContador({
      companyId,
      userId,
      dayOfMonth: Number(req.body?.dayOfMonth),
      active: Boolean(req.body?.active),
    });
    res.json({ agenda });
  } catch (err) {
    next(err);
  }
});

/**
 * Enfileira o pacote do mês para os destinatários ativos — NUNCA envia direto.
 *
 * Sem SMTP a fila acumula em `pending`, que é o estado honesto; a resposta e o
 * histórico dizem isso em vez de fingir entrega. A Idempotency-Key é
 * obrigatória pelo mesmo motivo das cobranças: um clique repetido não pode
 * virar caixa de entrada em dobro.
 */
coreRouter.post('/fiscal/closings/:period/enviar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const idempotencyKey =
      (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? '');
    res.json(
      enviarPacotePorEmail({
        companyId,
        userId,
        period: String(req.params.period),
        origem: 'manual',
        idempotencyKey,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/closings/:period/envios', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(listarEnvios(companyId, String(req.params.period)));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/fiscal/product-pendencies', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({ items: listProductFiscalPendencies(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/fiscal/product-pendencies/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const produto = updateProductFiscal({
      companyId,
      productId: String(req.params.id),
      ncm: req.body?.ncm,
      cest: req.body?.cest,
      cfop: req.body?.cfop,
      origin: req.body?.origin,
      taxProfile: req.body?.taxProfile,
    });
    recordAudit({
      companyId,
      userId,
      action: 'fiscal.product_updated',
      entityType: 'product',
      entityId: String(req.params.id),
      detail: { fields: Object.keys(req.body ?? {}) },
    });
    res.json(produto);
  } catch (err) {
    next(err);
  }
});

/**
 * Converte o valor do corpo em número SEM inventar zero.
 *
 * `Number(null)` é 0, e `null` é exatamente o que chega quando a tela manda um
 * campo vazio ou uma letra: o navegador faz `Number('abc')`, ganha NaN, e o
 * `JSON.stringify` grava NaN como `null`. Com o `Number` cru da rota, digitar
 * uma letra no campo "série" gravava a SÉRIE 0 em silêncio, e a nota sairia
 * numa série que ninguém pediu. Aqui o vazio continua vazio: vira NaN, e a
 * validação de `setSeriesNextNumber` responde 400 com o motivo.
 */
function numeroOuNaN(valor: unknown): number {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && valor.trim() !== '') return Number(valor);
  return Number.NaN;
}

coreRouter.get('/fiscal/series', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      items: [...FISCAL_MODELS].map((model) => ({
        model,
        series: getSeries(companyId, model),
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/fiscal/series', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    setSeriesNextNumber({
      companyId,
      model: String(req.body?.model ?? ''),
      serie: numeroOuNaN(req.body?.serie),
      nextNumber: numeroOuNaN(req.body?.nextNumber),
      /*
        O AMBIENTE DA SÉRIE (auditoria P0): só é mexido quando o corpo o traz.
        Vazio ou nulo = a série serve aos dois; o valor cru vai ao serviço, que
        tem a lista fechada e recusa o resto com motivo.
      */
      ...(req.body && typeof req.body === 'object' && 'environment' in req.body
        ? {
            environment:
              req.body.environment === '' || req.body.environment == null
                ? null
                : (req.body.environment as 'homologation' | 'production'),
          }
        : {}),
    });
    recordAudit({
      companyId,
      userId,
      action: 'fiscal.series_update',
      entityType: 'fiscal_series',
      entityId: `${req.body?.model}-${req.body?.serie}`,
      detail: { nextNumber: Number(req.body?.nextNumber) },
    });
    res.json({ items: getSeries(companyId, String(req.body?.model ?? '')) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- empresas
//
/*
  ==================== A SÉTIMA OPERAÇÃO NASCE AQUI =========================

  ## O QUE ESTAS DUAS ROTAS SUBSTITUEM

  Existia `POST /api/v1/organizations/companies`. Ela respondia 201 com uma
  empresa que NUNCA tocava `core_companies`: o serviço guardava tudo num `Map`
  do processo. A empresa sumia no reinício, nenhum login jamais a alcançava, e
  o 201 era a única prova de que ela existira. O roteador inteiro foi apagado —
  ver o comentário em `routes/v1/index.ts`.

  Estas nascem em `coreRouter` DE PROPÓSITO: é o único roteador que a regra
  `rota-declara-alcance` vigia, e foi exatamente fora dessa cobertura que a
  rota fantasma nasceu calada e atravessou vinte e quatro rodadas.

  ## O GUARDA, E A TENSÃO QUE ELE RESOLVE

  O plano desta rodada pedia `somenteAdminDoGrupo` — só `admin_geral` — e uma
  tela em `ROTA_GESTAO`. As duas coisas não cabem juntas: `ROTA_GESTAO` é o
  ambiente `gestao`, que no roteador do navegador admite `gestor`,
  `gerente_loja`, `gerente_oficina`, `estoquista` e `atendente`. O estoquista
  clicaria no item de menu e levaria 403 — guarda mais estreito que a tela,
  pela terceira rodada seguida, e o motivo pelo qual a regra da rodada 23
  existe.

  A tensão foi resolvida pelos DOIS lados, e nenhum deles é "ignorar":

   1. NÃO EXISTE TELA NESTA RODADA. O menu (`navItems.ts`) e o `Protected`
      filtram por AMBIENTE, não por perfil — não há hoje nenhum mecanismo para
      esconder um item de `estoquista` e mostrá-lo a `gestor`, porque os dois
      vivem no mesmo ambiente. Construir esse mecanismo é trabalho de verdade
      (uma terceira dimensão no roteador, no menu, e nos testes que comparam os
      dois), e inventá-lo agora sem nenhuma tela para usá-lo produziria
      exatamente o defeito da rodada 22: configuração inerte com a suíte verde.
      A API existe e cumpre o que promete; a tela vem quando o mecanismo vier
      junto, e aí as duas nascem alinhadas.

   2. O GUARDA É `requireProfile(req)` SEM PERFIL EXTRA — o que, por dentro,
      quer dizer `admin_geral` e `gestor`, e mais ninguém. Não inventei um
      `somenteAdminDoGrupo`: este projeto tem UM caminho de autorização, e o
      atalho de `admin_geral`/`gestor` mora dentro de `requireProfile`. Um
      segundo guarda ao lado seria uma segunda cópia da regra de RBAC, para
      divergir da primeira no dia em que a regra mudar — é o que o cabeçalho de
      `abertaAo` diz com todas as letras, e é precisamente o que a rota
      fantasma fazia com o `isGroupAdmin` dela.

  Note o que isto NÃO abre: `estoquista`, `atendente`, `gerente_loja`,
  `gerente_oficina`, `mecanico` e os três caixas continuam recebendo 403. A
  abertura foi de `admin_geral` para `admin_geral` + `gestor` — o perfil que
  este sistema inteiro já trata como dono do grupo.

  ## O CORPO NÃO ESCOLHE TENANT NEM PESSOA

  `companyId` e `userId` do corpo são IGNORADOS, não recusados: o servidor
  simplesmente não lê esses campos. Quem cria é `req.auth.sub`, e a empresa
  criada é a que o servidor acabou de inventar. Recusar com 400 ensinaria que
  existe um campo por perto; ignorar não ensina nada. A rota fantasma lia
  `body.companyId` nas irmãs, e era por ali que o tenant vazava.
*/

coreRouter.get('/companies', (req: AuthedRequest, res, next) => {
  try {
    /*
      ALCANCE: nenhum perfil além do atalho — `admin_geral` e `gestor`.

      Esta é a única rota do núcleo que lê ATRAVÉS de empresas — e desde a
      rodada 48 ela atravessa SÓ para onde há vínculo: `listCompaniesForUser`
      devolve as empresas de `core_user_companies`, não o grupo. Para o ADMIN
      e o gestor do grupo (vínculo nas seis) nada muda; o adm de uma loja vê
      a sua loja, porque as operações e os CNPJs das outras não são dele.

      `abertaAo` continua não servindo aqui: o recorte não é por prédio, é
      por dono — e agora o "dono" é dito pelo vínculo, não pelo perfil.
    */
    requireProfile(req);
    // O mesmo recorte do certificado do grupo (GAP-PRD-084): só as operações
    // em que o perfil de lá também é de dono.
    const deDono = new Set(operacoesOndeOPerfilAbre(scope(req).userId, []).map((c) => c.id));
    const empresas = listCompaniesForUser(scope(req).userId).filter((c) => deDono.has(c.id));
    res.json({
      items: empresas.map((c) => ({
        id: c.id,
        slug: c.slug,
        legalName: c.legal_name,
        tradeName: c.trade_name,
        cnpj: c.cnpj,
        kind: c.kind,
        active: c.active === 1,
        // Quem usa plaquinha com QR (GAP-PRD-185): a tela liga e desliga.
        usesEquipmentTags: Number((c as { uses_equipment_tags?: number }).uses_equipment_tags ?? 0) === 1,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * LIGA OU DESLIGA A PLAQUINHA COM QR de uma operação (GAP-PRD-185).
 *
 * A marca só tinha o passo de migração como escritor: a sétima oficina nascia
 * sem ela e o pool recusava a primeira folha. Mesmo alcance da criação — quem
 * responde pelo grupo —, e a empresa tem de ser uma das dele.
 */
coreRouter.patch('/companies/:id/equipment-tags', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    if (!respondePeloGrupo(userId)) {
      throw new ApiError(
        'CORE_GROUP_SCOPE_REQUIRED',
        'Ligar a plaquinha de uma operação é de quem responde por todas as empresas do grupo.',
        403,
      );
    }
    const alvo = String(req.params.id);
    if (!listCompaniesForUser(userId).some((c) => c.id === alvo)) {
      throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404);
    }
    const mudanca = definirPlaquinhaDaEmpresa({ companyId: alvo, enabled: req.body?.enabled });
    if (mudanca.antes !== mudanca.depois) {
      for (const onde of new Set([alvo, companyId])) {
        recordAudit({
          companyId: onde,
          userId,
          action: 'company.equipment_tags.update',
          entityType: 'company',
          entityId: alvo,
          detail: { antes: mudanca.antes, depois: mudanca.depois, tradeName: mudanca.tradeName },
        });
      }
    }
    res.json({ companyId: alvo, usesEquipmentTags: mudanca.depois });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/companies', (req: AuthedRequest, res, next) => {
  /*
    A IIFE assíncrona é a forma que as outras rotas que derivam Argon2id já
    usam (`POST /team`, `POST /team/:id/password`). O hash tem de ser calculado
    AQUI, antes do serviço, porque `withTransaction` é síncrona: o gerente só
    consegue nascer dentro da mesma transação da empresa se o trabalho
    assíncrono já tiver terminado quando ela abrir.
  */
  void (async () => {
    try {
      // ALCANCE: idêntico ao GET acima, e pelo mesmo motivo — abrir operação no
      // grupo é do dono do grupo. Ver o cabeçalho da seção.
      requireProfile(req);
      const { companyId, userId } = scope(req);

      // E "dono do grupo" é VÍNCULO, não perfil (rodada 48): quem abre a
      // sétima operação responde por todas as que existem. O adm de uma loja
      // tem o perfil certo e o alcance errado — é exatamente ele que este 403
      // barra.
      if (!respondePeloGrupo(userId)) {
        throw new ApiError(
          'CORE_GROUP_SCOPE_REQUIRED',
          'Abrir operação nova é de quem responde por todas as empresas do grupo.',
          403,
        );
      }

      const legalName = String(req.body?.legalName ?? '').trim();
      const tradeName = String(req.body?.tradeName ?? '').trim();
      if (!legalName) {
        throw new ApiError('CORE_COMPANY_INCOMPLETE', 'Informe a razão social.', 400);
      }

      const kind = String(req.body?.kind ?? 'retail');
      if (kind !== 'retail' && kind !== 'workshop') {
        throw new ApiError(
          'CORE_COMPANY_KIND_INVALID',
          'Tipo de operação inválido: use "retail" (loja) ou "workshop" (oficina).',
          400,
        );
      }

      /*
        CNPJ é opcional, mas se vier tem de fechar o módulo 11.

        Gravar um CNPJ errado agora vira rejeição da SEFAZ depois, com a venda
        já feita. É o mesmo raciocínio de `updateFiscalConfig`, e usa a MESMA
        função para que as duas portas nunca discordem sobre o que é um CNPJ.
      */
      const cnpj = String(req.body?.cnpj ?? '').trim();
      if (cnpj && !isValidCnpj(cnpj)) {
        throw new ApiError(
          'CORE_COMPANY_CNPJ_INVALID',
          'CNPJ inválido: os dígitos não conferem.',
          400,
        );
      }

      const gerente = (req.body?.manager ?? {}) as Record<string, unknown>;
      const senha = String(gerente.password ?? '');
      // A regra da senha vive em `TeamService` e é conferida aqui porque daqui
      // para a frente só existe o hash — e hash não tem comprimento de senha.
      assertPassword(senha);

      /*
        O perfil do primeiro gerente segue o tipo da operação quando o corpo não
        diz. `gerente_oficina` numa loja é recusado lá dentro com
        `CORE_WORKSHOP_LINK_REQUIRED`, que é a resposta certa: não há bancada
        para vincular, e um gerente de oficina sem oficina entraria e veria uma
        tela vazia sem explicação.
      */
      const profileCode = String(
        gerente.profileCode ?? (kind === 'workshop' ? 'gerente_oficina' : 'gerente_loja'),
      );

      const passwordHash = await hashPassword(senha);

      /*
        A PLAQUINHA COM QR (GAP-PRD-185): a escolha da tela, ou o padrão que
        a bancada já diz (oficina de mobilidade usa; celular e loja, não). Lida
        ANTES de criar: a escolha malformada é 400 sem nada nascer.
      */
      const workshopKind = req.body?.workshopKind === 'phones' ? 'phones' : 'mobility';
      const usaPlaquinha =
        lerEscolhaDePlaquinha(req.body?.usesEquipmentTags)
        ?? plaquinhaPadraoDaEmpresaNova(kind, workshopKind);

      // A marca entra na MESMA transação da empresa: nasce inteira ou não nasce.
      const criada = withTransaction(() => {
        const nova = createCompanyWithFounders({
          legalName,
          tradeName,
          cnpj: cnpj || null,
          kind,
          // O tipo da bancada, quando for oficina. Ele decide se o equipamento
          // ganha plaquinha com QR, e o grupo já tem uma oficina de cada tipo —
          // nascer sempre mobilidade daria capacidade errada à de celulares.
          workshopKind,
          // Sempre da sessão. O corpo pode mandar `userId` e `companyId` à
          // vontade: ninguém os lê.
          criadorUserId: userId,
          perfisDoCriador: scope(req).profiles,
          primeiroGerente: {
            login: String(gerente.login ?? ''),
            displayName: String(gerente.displayName ?? ''),
            email: gerente.email == null ? null : String(gerente.email),
            passwordHash,
            profileCode,
          },
        });
        gravarPlaquinhaDaEmpresa(nova.company.id, usaPlaquinha);
        return nova;
      });

      /*
        ONDE A AUDITORIA FICA LEGÍVEL — e por que são DOIS registros.

        `listAudit` filtra por empresa, e este acontecimento mora ENTRE duas: a
        de quem apertou o botão e a que nasceu. Um registro só deixaria um dos
        lados cego, e os dois lados são leitores reais:

          - na empresa de ORIGEM, porque é lá que está a trilha da pessoa que
            criou, e é lá que alguém pergunta "quem abriu essa operação?";
          - na empresa NOVA, porque a primeira linha da trilha dela não pode ser
            um usuário aparecendo do nada. Sem isto, a auditoria da sétima
            operação começa com um gerente já dentro e nenhuma origem.

        Duplicar duas linhas é barato. Um log que não responde à pergunta que
        motivou a consulta não é.
      */
      const detalhe = {
        slug: criada.company.slug,
        tradeName: criada.company.trade_name,
        kind: criada.company.kind,
        managerLogin: criada.gerente.login,
        managerProfile: criada.gerente.profileCode,
        workshopSlug: criada.workshop?.slug ?? null,
        usesEquipmentTags: usaPlaquinha,
        linkedGroupAdmins: criada.adminsVinculados.length,
        linkedGroupManagers: criada.gestoresVinculados.length,
      };
      recordAudit({
        companyId,
        userId,
        action: 'company.created',
        entityType: 'company',
        entityId: criada.company.id,
        detail: detalhe,
      });
      recordAudit({
        companyId: criada.company.id,
        userId,
        action: 'company.created',
        entityType: 'company',
        entityId: criada.company.id,
        detail: { ...detalhe, createdFromCompanyId: companyId },
      });

      res.status(201).json({
        company: {
          id: criada.company.id,
          slug: criada.company.slug,
          legalName: criada.company.legal_name,
          tradeName: criada.company.trade_name,
          cnpj: criada.company.cnpj,
          kind: criada.company.kind,
          active: criada.company.active === 1,
          usesEquipmentTags: usaPlaquinha,
        },
        workshop: criada.workshop,
        manager: criada.gerente,
        linkedGroupAdmins: criada.adminsVinculados,
        linkedGroupManagers: criada.gestoresVinculados,
      });
    } catch (err) {
      next(err);
    }
  })();
});

// ----------------------------------------------------------------- equipe
//
// Gerir quem entra no sistema é privilégio de gestão. `requireProfile` já
// deixa `admin_geral` e `gestor` passarem; `gerente_oficina` entra para poder
// administrar os próprios técnicos sem depender da matriz.

/**
 * QUEM PODE VENDER NESTA LOJA — a porta do balcão.
 *
 * O PDV monta o seletor "Vendedor" e precisa de nome e id. Chamava
 * `GET /core/team`, que exige gerente: o 403 caía num catch silencioso, o
 * seletor nunca aparecia, e TODA venda saía em nome de quem estava no caixa.
 * A comissão do mês inteiro ia para o operador.
 *
 * A rota de gestão continua sendo de gestão. Aquela devolve login, e-mail,
 * último acesso e vínculos de oficina — login é metade de uma credencial, e
 * nada disso preenche um seletor. Esta devolve id, nome e ativo. Nada mais.
 */
coreRouter.get('/sellers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', ...BALCAO);
    const { companyId } = scope(req);
    res.json({
      items: listTeam(companyId).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        active: p.active,
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/team', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId, profiles } = scope(req);
    // A oficina passa por `resolveWorkshop`, que recusa oficina de outro
    // tenant e oficina em que o solicitante não está vinculado.
    const workshop = req.query.workshopId ? resolveWorkshop(req) : null;
    res.json({
      items: listTeam(companyId, {
        workshopId: workshop?.id,
        search: req.query.search as string | undefined,
        onlyWorkshopStaff: req.query.workshopStaff === '1',
      }).map((membro) => ({
        ...membro,
        // O que a tela pode oferecer sobre cada pessoa, calculado pelas MESMAS
        // funções que recusam (GAP-PRD-010/152): o botão que aparece é o que
        // o servidor aceita, e nenhum outro.
        acoes: acoesSobre({ companyId, alvoId: membro.id, actorId: userId, perfisDeQuemAge: profiles }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/team', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const member = await createTeamMember({
        companyId,
        login: String(req.body?.login ?? ''),
        displayName: String(req.body?.displayName ?? ''),
        email: req.body?.email ?? null,
        profileCode: String(req.body?.profileCode ?? ''),
        // Os perfis saem do TOKEN. Perfil informado pelo corpo seria a própria escalada pedindo licença.
        perfisDeQuemCria: scope(req).profiles,
        password: String(req.body?.password ?? ''),
        workshopIds: Array.isArray(req.body?.workshopIds) ? req.body.workshopIds : [],
      });
      recordAudit({
        companyId,
        userId,
        action: 'team.create',
        entityType: 'user',
        entityId: member.id,
        // A senha NUNCA entra na auditoria — o registro é lido por gente.
        detail: { login: member.login, profileCode: member.profileCode },
      });
      res.status(201).json(member);
    } catch (err) {
      next(err);
    }
  })();
});

coreRouter.patch('/team/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const member = updateTeamMember({
      companyId,
      userId: String(req.params.id),
      actorId: userId,
      displayName: req.body?.displayName,
      email: req.body?.email,
      profileCode: req.body?.profileCode,
        // Os perfis saem do TOKEN. Perfil informado pelo corpo seria a própria escalada pedindo licença.
        perfisDeQuemCria: scope(req).profiles,
      workshopIds: Array.isArray(req.body?.workshopIds) ? req.body.workshopIds : undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'team.update',
      entityType: 'user',
      entityId: member.id,
      detail: { profileCode: member.profileCode, workshops: member.workshops.map((w) => w.slug) },
    });
    res.json(member);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/team/:id/active', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const member = setTeamMemberActive({
      companyId,
      userId: String(req.params.id),
      active: req.body?.active === true,
      actorId: userId,
      // Os perfis vem do ESCOPO da sessao, nunca do corpo — a mesma regra que
      // a criacao ja seguia. Ver `HierarquiaDePerfis.assertPodeMexerNaConta`.
      perfisDeQuemAge: scope(req).profiles,
    });
    recordAudit({
      companyId,
      userId,
      action: member.active ? 'team.activated' : 'team.deactivated',
      entityType: 'user',
      entityId: member.id,
    });
    res.json(member);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/team/:id/password', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const member = await resetTeamMemberPassword({
        companyId,
        userId: String(req.params.id),
        password: String(req.body?.password ?? ''),
        actorId: userId,
        perfisDeQuemAge: scope(req).profiles,
      });
      recordAudit({
        companyId,
        userId,
        action: 'team.password_reset',
        entityType: 'user',
        entityId: member.id,
      });
      res.json(member);
    } catch (err) {
      next(err);
    }
  })();
});

/*
  O VÍNCULO TEM A PRÓPRIA ALAVANCA (GAP-PRD-152).

  "Desativar" desliga a conta em TODAS as operações da pessoa; estas duas
  rotas mexem só na linha DESTA operação. Ver `removerDaOperacao` e
  `vincularContaExistente` para as recusas — o mesmo guarda de perfil das
  outras rotas de equipe, e os perfis saem do token.
*/
coreRouter.post('/team/:id/remove-from-company', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId, profiles } = scope(req);
    const removido = removerDaOperacao({
      companyId,
      userId: String(req.params.id),
      actorId: userId,
      perfisDeQuemAge: profiles,
    });
    recordAudit({
      companyId,
      userId,
      action: 'team.removed_from_company',
      entityType: 'user',
      entityId: removido.id,
      detail: { login: removido.login, outrasOperacoes: removido.outrasOperacoes },
    });
    res.json({ id: removido.id, removedFromCompany: true, outrasOperacoes: removido.outrasOperacoes });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/team/link', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId, profiles } = scope(req);
    const member = vincularContaExistente({
      companyId,
      login: String(req.body?.login ?? ''),
      profileCode: String(req.body?.profileCode ?? ''),
      perfisDeQuemCria: profiles,
      workshopIds: Array.isArray(req.body?.workshopIds) ? req.body.workshopIds : [],
    });
    recordAudit({
      companyId,
      userId,
      action: 'team.linked',
      entityType: 'user',
      entityId: member.id,
      detail: { login: member.login, profileCode: member.profileCode },
    });
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
});

/**
 * "ESQUECI MINHA SENHA" DA EQUIPE — a escolha do dono, por operação (GAP-PRD-160).
 *
 * `requireProfile(req)` sem perfil extra: só `admin_geral` e `gestor`. Deixar
 * a pessoa trocar a própria senha pelo e-mail é política da casa, e o gerente
 * da loja não a decide pelo dono. A resposta diz também se o SMTP está pronto:
 * ligado sem SMTP, o código espera na fila e a tela de login não oferece o
 * caminho.
 */
function recuperacaoDaOperacao(companyId: string) {
  return {
    ...configuracaoDaRecuperacao(companyId),
    carteiroPronto: carteiroConfigurado(),
    faltaNoCarteiro: emailStatus().missing,
  };
}

coreRouter.get('/team/recuperacao-de-senha', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    res.json(recuperacaoDaOperacao(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/team/recuperacao-de-senha', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    if (typeof req.body?.emailLigado !== 'boolean') {
      throw new ApiError('API_INVALID_PAYLOAD', 'Informe emailLigado: true ou false.', 400);
    }
    definirRecuperacaoPorEmail({ companyId, ligado: req.body.emailLigado, userId });
    recordAudit({
      companyId,
      userId,
      action: 'team.password_recovery.config',
      entityType: 'company',
      entityId: companyId,
      detail: { emailLigado: req.body.emailLigado },
    });
    res.json(recuperacaoDaOperacao(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/team/profiles', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    /*
      SÓ O QUE QUEM PERGUNTA PODE ENTREGAR (GAP-PRD-149).

      A lista inteira de `ASSIGNABLE_PROFILES` ia para todo mundo: o gerente
      de loja via "Gestor" e "Escritório de contabilidade" no seletor, escolhia,
      preenchia a ficha e tomava 403 CORE_PROFILE_ABOVE_YOURS no Salvar. A
      régua é a MESMA da recusa (`assertPodeAtribuir`): capacidade de quem age
      contra a exigência do perfil.
    */
    const capacidade = capacidadeDe(req.auth?.profileCodes ?? []);
    res.json({ items: ASSIGNABLE_PROFILES.filter((p) => capacidade >= exigenciaDe(p)) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- ordens de serviço

/**
 * O quadro e a busca, no mesmo endereço.
 *
 * O quadro pede tudo e desenha as colunas; a busca manda filtro e paginação.
 * Separar em duas rotas duplicaria a regra de alcance, que é justamente onde o
 * erro dói — uma delas acabaria enxergando o que a outra não enxerga.
 *
 * O limite continua alto por padrão (300, como era) porque o Kanban desenha
 * TODAS as colunas: cortar em 50 esconderia a OS antiga ainda aberta, que é
 * exatamente a que precisa aparecer.
 */
coreRouter.get('/workshop/orders', (req: AuthedRequest, res, next) => {
  try {
    /*
      OS TRÊS, e o terceiro não é distração: `POST /workshop/orders/:id/checkout`
      e `GET /workshop/pending-payment` exigem `operador_caixa_oficina`. Quem
      cobra a OS no balcão da oficina precisa lê-la. A tela em si é ROTA_OFICINA
      (`oficina` + `gestao`), e o corpo desta rota serve o mecânico: `?mine=true`
      só filtra por `profiles.includes("mecanico")`.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId, userId, profiles } = scope(req);
    const oficinas = resolveWorkshopScope(req);
    const onlyMine = req.query.mine === 'true' && profiles.includes('mecanico');
    const statuses =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    const busca = searchOrders(companyId, {
      workshopIds: oficinas,
      statuses,
      mechanicId: onlyMine ? userId : (req.query.mechanicId as string | undefined),
      customerId: req.query.customerId as string | undefined,
      equipmentId: req.query.equipmentId as string | undefined,
      q: req.query.q as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
      // A coluna do quadro pede a ordem do card: prioridade e a mais antiga
      // primeiro (GAP-PRD-187). Sem o parâmetro, a ordem de sempre.
      ordem: req.query.ordem === 'quadro' ? 'quadro' : undefined,
    });

    res.json({
      statuses: ORDER_STATUSES,
      // A lista de oficinas do alcance: é dela que a tela monta o seletor, e é
      // ela que diz se faz sentido oferecer "todas".
      workshops: listWorkshopsOf(companyId),
      // A régua do SLA vem JUNTO do quadro (rodada 51): os cards calculam o
      // alerta na tela, sem segunda requisição — e todo mundo que vê o quadro
      // vê a mesma régua, inclusive o mecânico (que não alcança as rotas de
      // configuração).
      sla: getSlaConfig(companyId).matrix,
      priorities: ORDER_PRIORITIES,
      ...busca,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * A ORDEM DE SERVIÇO EM PAPEL — A4, desde a abertura (rodada 54).
 *
 * Fica colada na leitura da OS porque é o MESMO alcance: quem abre a ordem
 * imprime. (A ordem de declaração aqui é indiferente — `:id` do Express não
 * atravessa a barra, e `/photos` e `/checklist` convivem com ela há rodadas.)
 *
 * O documento é o MESMO que a fila de impressão entrega (`WORKSHOP_OS`):
 * dois desenhos divergiriam no primeiro campo que alguém mudasse num só.
 *
 * Mesmo alcance da leitura da OS: quem pode abrir a ordem pode imprimi-la.
 * O papel não mostra nada que a tela já não mostre a essas pessoas.
 */
coreRouter.get('/workshop/orders/:id/impressao', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    /*
      A OS é lida PELO ESCOPO DA BANCADA antes de virar papel.

      `renderServiceOrderA4` filtra por empresa, e isso não basta: um
      mecânico que atende só a bancada de celulares não pode imprimir a OS
      da mobilidade, que ele nem vê no quadro. A leitura de detalhe já faz
      esse recorte — reusá-la é o que impede a fronteira de existir só na
      tela.
    */
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    const papel = renderServiceOrderA4(companyId, String(req.params.id));
    res.json(papel);
  } catch (err) {
    next(err);
  }
});
coreRouter.get('/workshop/orders/:id', (req: AuthedRequest, res, next) => {
  try {
    /*
      A OS aberta, com peças e mão de obra. Mesmo alcance da lista, pelo mesmo
      motivo: o caixa da oficina fecha e cobra esta OS.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const order = getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * O que a oficina mandou ao cliente por esta OS (GAP-PRD-036): orçamento,
 * pronta, concluída — com a situação de entrega de cada mensagem, o e-mail do
 * cadastro e se o envio está ligado. É o que deixa a tela dizer a verdade
 * sobre o "enviado". Mesmo alcance do detalhe da OS, pela mesma régua.
 */
coreRouter.get('/workshop/orders/:id/avisos', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const orderId = String(req.params.id);
    // Fora do alcance de oficinas do usuário: 404, como no detalhe.
    getOrderDetail(companyId, resolveWorkshopScope(req), orderId);
    res.json(avisosDaOs(companyId, orderId));
  } catch (err) {
    next(err);
  }
});

/**
 * As bancadas onde quem pergunta pode abrir OS e cadastrar equipamento
 * (GAP-PRD-099). O balcão (caixa e atendente) tem a régua da EMPRESA; o
 * mecânico, a da filiação — ver `WorkshopIntakeService`. As telas de abertura
 * mostram a escolha só quando a lista tem mais de uma.
 */
coreRouter.get('/workshop/entrada', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'operador_caixa_oficina', 'atendente', 'mecanico');
    const { companyId, userId, profiles } = scope(req);
    res.json({ items: bancadasDeEntrada({ companyId, userId, profiles }) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'operador_caixa_oficina', 'atendente', 'mecanico');
    const { companyId, userId } = scope(req);
    // A régua de quem ABRE (GAP-PRD-099): o balcão não é membro de bancada, e
    // `resolveWorkshop` o recusava justamente aqui, onde a rota o nomeia.
    const workshop = resolveBancadaDeEntrada(req);
    const order = createOrder({
      companyId,
      workshopId: workshop.id,
      userId,
      customerName: req.body?.customerName,
      customerId: req.body?.customerId ?? null,
      equipmentId: req.body?.equipmentId ?? null,
      equipment: req.body?.equipment,
      // A placa era digitada na tela e morria aqui: a rota não a repassava e o
      // serviço não a recebia, enquanto a listagem exibia a coluna vazia.
      plate: req.body?.plate,
      complaint: req.body?.complaint,
      // Prioridade e prazo do quadro (rodada 51). Ausentes, a OS nasce media
      // e sem prazo — o comportamento de sempre.
      priority: req.body?.priority ?? undefined,
      dueDate: req.body?.dueDate ?? undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.create',
      entityType: 'service_order',
      entityId: order.id,
      detail: { workshopId: workshop.id },
    });
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

/** Assumir: único caminho para sair de EM ABERTO. Exige comentário. */
coreRouter.post('/workshop/orders/:id/assume', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    // Escopo de bancada pela LISTA, como na leitura (ver `/release`).
    const order = assumeOrder({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      toStatus: String(req.body?.status ?? 'em_andamento'),
      comment: String(req.body?.comment ?? ''),
      // O retrato do quadro (GAP-PRD-183): dois técnicos no mesmo card.
      esperado: lerVersaoEsperada(req.body),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.assume',
      entityType: 'service_order',
      entityId: order.id,
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders/:id/move', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    // Escopo de bancada pela LISTA, como na leitura (ver `/release`).
    const order = moveOrder({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      toStatus: String(req.body?.status ?? ''),
      comment: req.body?.comment,
      isManager: isManagerProfile(req),
      // O retrato do quadro (GAP-PRD-183): quem move sobre situação velha
      // leva 409 dizendo onde a OS está agora, em vez de ganhar no grito.
      esperado: lerVersaoEsperada(req.body),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.move',
      entityType: 'service_order',
      entityId: order.id,
      detail: { status: order.status },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * LARGAR a OS: devolve ao quadro, sem responsável, com justificativa (r51).
 *
 * É o inverso do assumir. O caixa fica de fora de propósito: quem larga é
 * quem carrega o serviço — o técnico responsável, ou o gerente remanejando.
 */
coreRouter.post('/workshop/orders/:id/release', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    /*
      O ALCANCE DE BANCADA VEM DA LISTA, não de "uma oficina ou nenhuma".

      `resolveWorkshop(req, false)` devolve `null` quando o usuário atende
      MAIS DE UMA bancada — e `null`, no serviço, significa "sem filtro de
      oficina". O quadro dele já esconde a OS da bancada alheia (a leitura
      usa `resolveWorkshopScope`), mas a escrita passaria. Aqui as duas
      metades usam a mesma régua.
    */
    const order = releaseOrder({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      reason: String(req.body?.reason ?? ''),
      isManager: isManagerProfile(req),
      esperado: lerVersaoEsperada(req.body),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.release',
      entityType: 'service_order',
      entityId: order.id,
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * REGULARIZAR a OS que ficou fora das regras (GAP-PRD-188): sem bancada, ou
 * numa coluna de trabalho sem responsável — o dado antigo que nenhuma outra
 * porta conserta. Destino `quadro` (volta às regras) ou `encerrar`
 * (lançamento indevido, sem dinheiro nenhum). Só a gestão da oficina.
 */
coreRouter.post('/workshop/orders/:id/regularizar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const resultado = regularizarOs({
      companyId,
      alcance: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      destino: req.body?.destino,
      motivo: req.body?.motivo,
      workshopId: req.body?.workshopId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.regularize',
      entityType: 'service_order',
      entityId: resultado.order.id,
      detail: {
        destino: resultado.destino,
        motivo: String(req.body?.motivo ?? '').trim(),
        irregularidadesAntes: resultado.irregularidadesAntes,
        statusAntes: resultado.statusAntes,
        statusDepois: resultado.order.status,
        workshopIdAntes: resultado.workshopIdAntes,
        workshopIdDepois: resultado.order.workshop_id,
      },
    });
    res.json(resultado.order);
  } catch (err) {
    next(err);
  }
});

/**
 * Prioridade e prazo (r51). O responsável replaneja o próprio serviço; o
 * gerente replaneja qualquer um; OS sem dono qualquer técnico prioriza —
 * é a triagem do quadro.
 */
coreRouter.patch('/workshop/orders/:id/plan', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    // Mesma régua da leitura — ver o comentário em `/release`.
    const order = setOrderPlan({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      priority: req.body?.priority,
      dueDate: req.body?.dueDate,
      isManager: isManagerProfile(req),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.plan',
      entityType: 'service_order',
      entityId: order.id,
      detail: { priority: order.priority, dueDate: order.due_date },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------- fotos e conferência da OS (rodada 52)
//
// A prova do que chegou e do que foi feito. LER é de quem atende a OS —
// inclusive o caixa da oficina, que cobra o serviço e responde ao cliente no
// balcão; ESCREVER é da bancada.

coreRouter.get('/workshop/orders/:id/photos', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    // A OS é conferida pelo alcance de bancada antes de a foto sair.
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    // O link que abre a foto é assinado e vale uma hora (GAP-PRD-184): o
    // caminho gravado sozinho não abre mais nada.
    res.json({
      items: listOrderPhotos(companyId, String(req.params.id)).map((foto) => ({
        ...foto,
        url: assinarCaminhoDaFoto(foto.url),
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders/:id/photos', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    const foto = addOrderPhoto({
      companyId,
      orderId: String(req.params.id),
      userId,
      dataUrl: String(req.body?.dataUrl ?? ''),
      fileName: req.body?.fileName ?? null,
      mimeType: req.body?.mimeType,
      kind: req.body?.kind,
      caption: req.body?.caption ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.photo.add',
      entityType: 'service_order',
      entityId: String(req.params.id),
      detail: { kind: foto.kind, bytes: foto.byte_size },
    });
    res.status(201).json({ ...foto, url: assinarCaminhoDaFoto(foto.url) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/workshop/orders/:id/photos/:photoId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    removeOrderPhoto({
      companyId,
      orderId: String(req.params.id),
      photoId: String(req.params.photoId),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.photo.remove',
      entityType: 'service_order',
      entityId: String(req.params.id),
      detail: { photoId: String(req.params.photoId) },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/workshop/orders/:id/checklist', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    const items = listChecklist(companyId, String(req.params.id));
    res.json({
      items,
      pendentes: items.filter((i) => i.answer === 'pendente').length,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/workshop/orders/:id/checklist/:itemId', (req: AuthedRequest, res, next) => {
  try {
    // Quem confere é quem recebe o aparelho: a bancada e o balcão da oficina.
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    getOrderDetail(companyId, resolveWorkshopScope(req), String(req.params.id));
    res.json(
      responderItem({
        companyId,
        orderId: String(req.params.id),
        itemId: String(req.params.itemId),
        userId,
        answer: String(req.body?.answer ?? ''),
        note: req.body?.note ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ SLA do quadro (rodada 51)
//
// A régua de reação por coluna × prioridade. LER é do quadro (vem junto do
// GET /workshop/orders); EDITAR é da gestão da oficina — o mesmo recorte da
// política de venda: a régua vale para a empresa inteira, não por navegador.

coreRouter.get('/workshop/sla', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(getSlaConfig(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/workshop/sla', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina');
    const { companyId, userId } = scope(req);
    // `reset: true` restaura o padrão inteiro — o botão "Restaurar padrão".
    const resultado = req.body?.reset === true
      ? resetSlaConfig(companyId)
      : saveSlaConfig(companyId, req.body?.matrix);
    recordAudit({
      companyId,
      userId,
      action: 'workshop.sla.update',
      entityType: 'workshop_sla',
      entityId: companyId,
      detail: { custom: resultado.custom.length, reset: req.body?.reset === true },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders/:id/comments', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    /*
      O ALCANCE É O DO QUADRO (GAP-PRD-186), e a VOZ é a de quem fala
      (GAP-PRD-102).

      `resolveWorkshop(req, false)` devolvia nulo para o mecânico de duas
      bancadas, e nulo virava "a empresa inteira": ele escrevia na terceira.
      Esta porta e as quatro vizinhas (peça, mão de obra, pedido de aprovação,
      conclusão) passam a usar a mesma lista que a leitura, a assunção e o
      movimento já usavam.
    */
    addComment({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      authorName: actorName(req),
      authorKind: vozNaOs(req),
      body: String(req.body?.body ?? ''),
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders/:id/parts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const order = addPart({
      companyId,
      // O alcance do quadro (GAP-PRD-186) — ver a nota em `/comments`.
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      // Nome e papel de quem lançou: é com eles que a linha do tempo assina a
      // queda da aprovação quando a peça muda um total já aceito.
      userName: actorName(req),
      isManager: isManagerProfile(req),
      productId: String(req.body?.productId),
      quantity: Number(req.body?.quantity ?? 1),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.part',
      entityType: 'service_order',
      entityId: order.id,
      detail: { productId: req.body?.productId, quantity: req.body?.quantity },
    });
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/orders/:id/labor', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      setLabor({
        companyId,
        // O alcance do quadro (GAP-PRD-186) — ver a nota em `/comments`.
        workshopId: resolveWorkshopScope(req),
        orderId: String(req.params.id),
        userId,
        // Mesmo par do lançamento de peça: a queda da aprovação assina com o
        // nome de quem mudou o valor.
        userName: actorName(req),
        isManager: isManagerProfile(req),
        laborCents: Number(req.body?.laborCents ?? 0),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * O primeiro tempo do orçamento: a oficina pede, o cliente decide no portal.
 * O atendente entra na lista porque é ele quem fala com o cliente no balcão.
 */
coreRouter.post('/workshop/orders/:id/pedir-aprovacao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'atendente');
    const { companyId, userId, profiles } = scope(req);
    const order = pedirAprovacaoOrcamento({
      companyId,
      // O alcance do quadro (GAP-PRD-186) — ver a nota em `/comments`.
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      isManager: !profiles.includes('mecanico'),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.approval_request',
      entityType: 'service_order',
      entityId: order.id,
      detail: { total: order.total_cents },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * O segundo tempo, quando o "sim" chega POR TELEFONE: o balcão registra.
 *
 * Não existia — só o portal decidia, e o aceite por telefone morria sem
 * `approved_at` e sem autoria (achado da auditoria). A decisão continua sendo
 * a MESMA do portal (`decidirOrcamento`, injetada no serviço da bancada), com
 * duas coisas a mais: a fala de quem registrou na linha do tempo e a
 * AUDITORIA de quem atendeu o telefone. Os perfis espelham o pedir-aprovação,
 * o vizinho de cima: quem fala com o cliente registra o que ele respondeu.
 */
coreRouter.post('/workshop/orders/:id/decidir-orcamento', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'atendente');
    const { companyId, userId, profiles } = scope(req);
    // approved é OBRIGATÓRIO e booleano: corpo torto virando "recusa" soltaria
    // as peças prometidas de um orçamento que o cliente aceitou.
    if (typeof req.body?.approved !== 'boolean') {
      throw new ApiError(
        'CORE_APPROVED_REQUIRED',
        'Informe approved: true (cliente aceitou) ou false (cliente recusou).',
        400,
      );
    }
    const approved = req.body.approved === true;
    const order = decidirOrcamentoNoBalcao({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      approved,
      note: req.body?.note,
      // A mesma régua do pedir-aprovação: atendente e gerente falam como
      // gestão; só o mecânico fala como técnico.
      isManager: !profiles.includes('mecanico'),
      decidir: decidirOrcamento,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.budget_decision',
      entityType: 'service_order',
      entityId: order.id,
      detail: {
        approved,
        total: order.total_cents,
        via: 'balcao',
        note: String(req.body?.note ?? '').trim() || undefined,
      },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/** Conclusão técnica. Com custo vai para AGUARDANDO PAGAMENTO. */
coreRouter.post('/workshop/orders/:id/complete', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const order = completeTechnical({
      companyId,
      // O alcance do quadro (GAP-PRD-186) — ver a nota em `/comments`.
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.id),
      userId,
      userName: actorName(req),
      diagnosis: String(req.body?.diagnosis ?? ''),
      hasCost: Boolean(req.body?.hasCost),
      noCostReason: req.body?.noCostReason,
      // A saída de emergência da conferência de entrada (rodada 52): a
      // bancada não trava, e a decisão fica na linha do tempo.
      forcarChecklist: req.body?.forcarChecklist === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.complete',
      entityType: 'service_order',
      entityId: order.id,
      detail: { hasCost: order.has_cost, status: order.status },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * Fila do caixa da oficina: OS concluídas tecnicamente, aguardando pagamento.
 *
 * GANHOU TELA (GAP-PRD-042): o botão "OS a receber" do PDV. O caixa da
 * oficina mora no ambiente `pdv` e não alcança a ficha da OS; é por esta fila
 * que ele chega ao recebimento. A resposta traz cliente, aparelho e bancada
 * (a linha crua da OS não dizia QUAL moto era), se a empresa tem oficina (o
 * PDV sem bancada não oferece o botão) e a política do fiado da OS, que o
 * caixa não lê em `/sale-policies`.
 *
 * O alcance é o do quadro (`resolveWorkshopScope`): o caixa sem vínculo de
 * bancada vê a empresa inteira, o mecânico de uma bancada veria só a dele —
 * mas mecânico não chega aqui, a fila é de dinheiro.
 */
coreRouter.get('/workshop/pending-payment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(filaDeRecebimento(companyId, resolveWorkshopScope(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * Recebimento da OS: a venda (fato econômico único) e a baixa da OS, juntas.
 *
 * A cesta é a do PDV (GAP-PRD-104): pagamentos divididos, troco, cobrança da
 * maquininha (`providerRef`), crédito de loja, acréscimo e desconto com a
 * MESMA alçada do balcão — quem decide tudo isso é `createSale`, e esta rota só
 * repassa o que só ela sabe (quem está no balcão, qual terminal, se um gestor
 * liberou). Lista de pagamentos vazia é o FIADO da OS, que só passa com a
 * política ligada e cliente do cadastro.
 *
 * Repetir com a mesma Idempotency-Key devolve o recebimento original com 200 e
 * `replay: true` (GAP-PRD-209). As regras moram em `WorkshopCashierService`.
 */
coreRouter.post('/workshop/orders/:id/checkout', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina');
    const { companyId, userId, profiles } = scope(req);
    const orderId = String(req.params.id);
    const cabecalho = (req.headers['idempotency-key'] as string | undefined)?.trim() || null;

    const resultado = receberOs({
      companyId,
      userId,
      orderId,
      idempotencyKey: cabecalho,
      payments: Array.isArray(req.body?.payments) ? req.body.payments : [],
      cashSessionId: req.body?.cashSessionId ?? null,
      // O terminal vem do corpo ou do token, como na venda do balcão.
      terminalId: req.body?.terminalId ?? req.auth?.storeId ?? null,
      sellerId: req.body?.sellerId ?? null,
      discountCents: req.body?.discountCents,
      surchargeCents: req.body?.surchargeCents,
      customerCreditCents: req.body?.customerCreditCents,
      alcada: { profileCodes: profiles, authorizationId: req.body?.authorizationId ?? null },
    });

    if (!resultado.replay) {
      const parts = getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_service_order_parts WHERE order_id = ?')
        .get(orderId) as { n: number };
      recordAudit({
        companyId,
        userId,
        action: 'workshop.order.checkout',
        entityType: 'service_order',
        entityId: orderId,
        detail: {
          saleId: resultado.sale.id,
          total: resultado.sale.total_cents,
          parts: parts.n,
          // A concessão fica registrada mesmo quando passou — como na venda
          // do balcão, é a que passou que o dono precisa poder revisar.
          concessao: resultado.concessao,
          authorizationId: req.body?.authorizationId ?? null,
          fiado: (Array.isArray(req.body?.payments) ? req.body.payments : []).length === 0,
        },
      });
    }

    res.status(resultado.replay ? 200 : 201).json({
      order: resultado.order,
      sale: resultado.sale,
      replay: resultado.replay,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Estorno do recebimento de uma OS paga (GAP-PRD-105).
 *
 * Cancela a venda da OS — o MESMO cancelamento da tela de vendas, que desfaz
 * título, gaveta, comissão e pontos — e devolve a OS à fila do caixa com o
 * motivo na linha do tempo. Se a conta da OS estava errada, o gerente a move
 * da fila de volta para a bancada; se só a forma de pagamento estava errada, o
 * caixa recebe de novo.
 *
 * QUEM: o gerente da oficina faz direto (é o dono do balcão da oficina, como o
 * gerente de loja é do balcão da loja); o caixa da oficina faz com a senha de
 * um gestor, gasta uma vez e presa a ESTA venda (`cancelar_venda`), o mesmo
 * bilhete da tela de devoluções.
 */
coreRouter.post('/workshop/orders/:id/estorno', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'operador_caixa_oficina', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const orderId = String(req.params.id);
    const motivo = String(req.body?.reason ?? '').trim();
    if (motivo.length < 3) {
      throw new ApiError(
        'CORE_REVERSAL_REASON_REQUIRED',
        'Diga por que o recebimento está sendo estornado — é o que explica a OS de volta na fila.',
        400,
      );
    }
    // O alvo da liberação é a VENDA; a recusa de estado sai antes da senha.
    const { saleId } = vendaAEstornar(companyId, orderId);

    const { resultado, authorizationId, authorizedBy } = comLiberacaoPontual(
      req,
      {
        perfisQuePodemDireto: ['gerente_oficina'],
        action: 'cancelar_venda',
        refId: saleId,
        codigo: 'CORE_CANCEL_NEEDS_AUTHORIZATION',
        mensagem:
          'Estornar o recebimento cancela a venda da OS e desfaz título e gaveta. '
          + 'Peça a liberação de um gestor para esta venda.',
      },
      () => estornarRecebimentoDaOs({ companyId, userId, orderId, reason: motivo }),
    );

    recordAudit({
      companyId,
      userId,
      action: 'workshop.order.reversal',
      entityType: 'service_order',
      entityId: orderId,
      detail: {
        saleId,
        reason: motivo,
        reparo: resultado.reparo,
        requestingUserId: userId,
        authorizingUserId: authorizedBy,
        authorizationId,
      },
      ip: ipDoSocket(req),
    });

    res.json({ order: resultado.order, sale: resultado.sale });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- equipamentos

coreRouter.get('/equipment', (req: AuthedRequest, res, next) => {
  try {
    /*
      O balcão da oficina cadastra equipamento (`POST /equipment` aceita
      `operador_caixa_oficina`) e o balcão da loja troca o dono
      (`POST /equipment/:id/owner` aceita `operador_caixa_loja`). Quem escreve
      precisa listar.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const workshop = resolveWorkshop(req, false);
    /*
      A LISTA NÃO CARREGA A CREDENCIAL DA PLAQUINHA.

      `listEquipment` faz `SELECT e.*`, e `e.public_token` é o segredo que abre
      `/equipamento/:token` — a página pública que qualquer um lê SEM sessão.
      Declarar esta rota aberta aos três ambientes entregando o token junto
      seria pior que o silêncio de ontem: o balcão inteiro passaria a ter, numa
      requisição, a chave de leitura de todos os aparelhos da oficina, e token
      vazado não expira nem se revoga.

      O que a tela usa é o `publicIdLabel` — o "#0007" colado na máquina.
      Nenhuma tela lê `public_token`: quem precisa do endereço do QR é a
      etiqueta, e ela é montada NO SERVIDOR, com o token sem sair daqui.

      O POST ao lado continua devolvendo o token, e isso é de propósito: quem
      acabou de cadastrar o aparelho é quem imprime a plaquinha dele.
    */
    // Página e total (GAP-PRD-070): o corte de 300 era mudo.
    const recorte = {
      workshopId: workshop?.id,
      search: req.query.search as string | undefined,
    };
    const pagina = lerPagina(req.query, 300);
    res.json({
      total: countEquipment(companyId, recorte),
      /*
        Os cartões "do grupo" e "de cliente" contavam a PÁGINA: com 300 na
        tela, diziam 300 cadastrados. A contagem por origem vem do banco, no
        mesmo recorte da lista.
      */
      totalPorOrigem: {
        INTERNAL_PJ_MOTORS: countEquipment(companyId, { ...recorte, origin: 'INTERNAL_PJ_MOTORS' }),
        EXTERNAL_CUSTOMER: countEquipment(companyId, { ...recorte, origin: 'EXTERNAL_CUSTOMER' }),
      },
      ...pagina,
      items: listEquipment(companyId, { ...recorte, ...pagina }).map((e) => {
        const visivel: Record<string, unknown> = {
          ...e,
          publicIdLabel: formatPublicId(e.public_id),
          /*
            A GARANTIA VEM PRONTA — e a conta é uma só.

            A coluna "Garantia" da lista nasceu refazendo a derivação no
            navegador. Duas contas para a mesma pergunta divergem no primeiro
            caso de borda, e divergiram: no fuso de quem lê, a lista anunciava
            o vencimento um dia antes da ficha. Agora as duas telas leem o
            mesmo `warrantyOf`.
          */
          warranty: warrantyOf(e),
        };
        delete visivel.public_token;
        return visivel;
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/equipment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    // A régua de quem RECEBE a máquina (GAP-PRD-099) — a mesma da abertura da
    // OS: o balcão tem a empresa, o mecânico a filiação.
    const workshop = resolveBancadaDeEntrada(req);
    const equipment = createEquipment({
      companyId,
      workshopId: workshop.id,
      userId,
      origin: req.body?.origin,
      originCompanyId: req.body?.originCompanyId ?? null,
      ownerCustomerId: req.body?.ownerCustomerId ?? null,
      category: req.body?.category,
      brand: req.body?.brand,
      model: req.body?.model,
      year: req.body?.year,
      version: req.body?.version,
      color: req.body?.color,
      serialNumber: req.body?.serialNumber,
      motorNumber: req.body?.motorNumber,
      chassis: req.body?.chassis,
      battery: req.body?.battery,
      batterySerial: req.body?.batterySerial,
      notes: req.body?.notes,
      // Ficha completa da máquina (rodada 52): o combinado de garantia, a
      // data em que ela entrou e quem a montou.
      warrantyMonths: req.body?.warrantyMonths,
      enteredAt: req.body?.enteredAt,
      assemblyMechanicId: req.body?.assemblyMechanicId ?? null,
      assembledAt: req.body?.assembledAt,
      // O numero da plaquinha JA COLADA na maquina (rodada 53).
      tagPublicId: req.body?.tagPublicId,
      // Placa e quilometragem da MAQUINA (GAP-PRD-106): moravam so na OS.
      plate: req.body?.plate,
      odometerKm: req.body?.odometerKm,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.create',
      entityType: 'equipment',
      entityId: equipment.id,
      detail: { origin: equipment.origin, publicId: equipment.public_id },
    });
    /*
      O TOKEN DO QR NÃO SAI NA RESPOSTA (GAP-PRD-106). Toda outra rota de
      equipamento já o tirava — a lista, a ficha, a correção —, e esta, a de
      criar, devolvia o registro inteiro. O token abre /equipamento/:token sem
      sessão e não expira; quem imprime a plaquinha o pega pela rota das
      etiquetas, que monta o endereço público.
    */
    const visivel: Record<string, unknown> = {
      ...equipment,
      publicIdLabel: formatPublicId(equipment.public_id),
    };
    delete visivel.public_token;
    res.status(201).json(visivel);
  } catch (err) {
    next(err);
  }
});

/**
 * A FICHA da máquina: identidade, garantia derivada e HISTÓRICO (rodada 52).
 *
 * `core_equipment_events` era write-only desde que nasceu — seis lugares
 * gravavam e ninguém lia. Esta é a rota que faltava. O alcance é o mesmo da
 * lista: quem atende a bancada precisa da ficha, e o caixa da oficina também
 * (é ele quem cobra a OS daquela máquina).
 *
 * O `public_token` da plaquinha NÃO sai daqui — quem projeta a página pública
 * é o portal, coluna a coluna.
 */
coreRouter.get('/equipment/:id', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    const ficha = fichaDoEquipamento(companyId, String(req.params.id));
    if (!ficha) {
      throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
    }
    /*
      O QUE A FICHA PODE FAZER COM A PLAQUINHA (GAP-PRD-107): trocar o
      adesivo exige a empresa no pool (`uses_equipment_tags`) e a bancada que
      dá QR à máquina (celular não ganha). A ficha só oferece o botão quando
      os dois dizem sim — oferecer o que leva 409 é pior que não oferecer.
    */
    const bancadaDaMaquina = getConnection()
      .prepare('SELECT kind FROM core_workshops WHERE id = ? AND company_id = ?')
      .get(String(ficha.equipment.workshop_id), companyId) as { kind: string } | undefined;
    /*
      O CONTATO DO DONO (GAP-PRD-106): a ficha dizia o nome e não como falar
      com ele. O telefone é o mesmo que a OS já mostra a quem a abre.
    */
    const dono = ficha.equipment.owner_customer_id
      ? (getConnection()
          .prepare('SELECT phone FROM core_customers WHERE id = ? AND company_id = ?')
          .get(String(ficha.equipment.owner_customer_id), companyId) as { phone: string | null } | undefined)
      : undefined;
    res.json({
      ...ficha,
      publicIdLabel: formatPublicId(Number(ficha.equipment.public_id)),
      ownerPhone: dono?.phone ?? null,
      plaquinha: {
        empresaUsa: empresaUsaPlaquinha(companyId),
        bancadaUsa: capabilitiesFor(bancadaDaMaquina?.kind).equipmentTags,
      },
      // Quem manda no chassi, motor e série quando há vínculo com a loja: a
      // correção pela ficha trava esses três e diz onde corrigir.
      vinculoDeEstoque: vinculoDeEstoque(String(ficha.equipment.id)),
      // A plaquinha interna "vendida à mão", sem venda no sistema (GAP-PRD-189):
      // a ficha oferece desfazer, com motivo, para a moto sair pelo PDV.
      vendaAMao: temVendaAMao(String(ficha.equipment.id)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Completa garantia e montagem (rodada 52).
 *
 * Patch ESTREITO: identidade (chassi, série, motor) continua sem porta de
 * edição — o que se corrige aqui é o que a bancada descobre depois.
 */
coreRouter.patch('/equipment/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const equipment = setEquipmentWarrantyAndAssembly({
      companyId,
      equipmentId: String(req.params.id),
      userId,
      warrantyMonths: req.body?.warrantyMonths,
      assemblyMechanicId: req.body?.assemblyMechanicId,
      assembledAt: req.body?.assembledAt,
      enteredAt: req.body?.enteredAt,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.update',
      entityType: 'equipment',
      entityId: equipment.id,
      detail: {
        warrantyMonths: equipment.warranty_months,
        assemblyMechanicId: equipment.assembly_mechanic_id,
      },
    });
    /*
      A CREDENCIAL DA PLAQUINHA NÃO VOLTA NA RESPOSTA.

      `public_token` abre `/equipamento/:token` sem sessão, não expira e não se
      revoga. O GET ao lado o projeta fora (com o comentário que explica por
      quê) e a ficha faz igual; esta rota respondia a linha crua.
    */
    const visivel: Record<string, unknown> = {
      ...equipment,
      publicIdLabel: formatPublicId(equipment.public_id),
    };
    delete visivel.public_token;
    res.json(visivel);
  } catch (err) {
    next(err);
  }
});

/**
 * CORRIGE A IDENTIDADE da máquina (GAP-PRD-106): tipo, marca, modelo, versão,
 * cor, ano, série, motor, chassi, bateria, placa, quilometragem e observações.
 *
 * Mudança de identidade exige motivo e fica no histórico com o antes e o
 * depois; chassi, motor e série de máquina vinculada à loja são da unidade.
 * Os perfis do gap: quem mexe na máquina (mecânico e gerente da oficina).
 */
coreRouter.patch('/equipment/:id/identidade', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const resultado = corrigirIdentidade({
      companyId,
      equipmentId: String(req.params.id),
      userId,
      campos: corpo,
      motivo: corpo.motivo,
    });
    if (resultado.mudancas.length > 0) {
      recordAudit({
        companyId,
        userId,
        action: 'equipment.identity.update',
        entityType: 'equipment',
        entityId: resultado.equipment.id,
        detail: {
          evento: resultado.evento,
          motivo: String(corpo.motivo ?? '').trim() || null,
          mudancas: resultado.mudancas,
        },
      });
    }
    const visivel: Record<string, unknown> = {
      ...resultado.equipment,
      publicIdLabel: formatPublicId(resultado.equipment.public_id),
      mudancas: resultado.mudancas,
    };
    delete visivel.public_token;
    res.json(visivel);
  } catch (err) {
    next(err);
  }
});

/**
 * Fotos da MÁQUINA (GAP-PRD-106) — o estado dela entre uma OS e outra. Ler é
 * de quem lê a ficha; subir, de quem recebe a máquina (a mesma régua das fotos
 * da OS); apagar, da bancada.
 */
coreRouter.get('/equipment/:id/photos', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    const { companyId } = scope(req);
    // O link que abre a foto é assinado e vale uma hora, como o da OS.
    res.json({
      items: listEquipmentPhotos(companyId, String(req.params.id)).map((foto) => ({
        ...foto,
        url: assinarCaminhoDaFoto(foto.url),
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/equipment/:id/photos', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    const foto = addEquipmentPhoto({
      companyId,
      equipmentId: String(req.params.id),
      userId,
      dataUrl: String(req.body?.dataUrl ?? ''),
      fileName: req.body?.fileName ?? null,
      mimeType: req.body?.mimeType,
      kind: req.body?.kind,
      caption: req.body?.caption ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.photo.add',
      entityType: 'equipment',
      entityId: String(req.params.id),
      detail: { kind: foto.kind, bytes: foto.byte_size },
    });
    res.status(201).json({ ...foto, url: assinarCaminhoDaFoto(foto.url) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/equipment/:id/photos/:photoId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'mecanico', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const foto = removeEquipmentPhoto({
      companyId,
      equipmentId: String(req.params.id),
      photoId: String(req.params.photoId),
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.photo.remove',
      entityType: 'equipment',
      entityId: String(req.params.id),
      detail: { photoId: foto.id, kind: foto.kind },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/equipment/:id/owner', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'operador_caixa_loja', 'gerente_loja');
    const { companyId, userId } = scope(req);
    const equipment = assignOwner({
      companyId,
      equipmentId: String(req.params.id),
      customerId: String(req.body?.customerId),
      userId,
      saleId: req.body?.saleId ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.sold',
      entityType: 'equipment',
      entityId: equipment.id,
    });
    /*
      O token da plaquinha NÃO sai daqui.

      `assignOwner` devolve a linha inteira, e `public_token` é credencial pura:
      ela abre `/equipamento/:token` sem sessão, não expira e não se revoga. A
      exceção escrita no `POST /equipment` — "quem acabou de cadastrar o
      aparelho é quem imprime a plaquinha" — não cobre esta rota: aqui ninguém
      imprime nada, só se registra que o aparelho trocou de dono.
    */
    const { public_token, ...semCredencial } = equipment;
    void public_token;
    res.json(semCredencial);
  } catch (err) {
    next(err);
  }
});

/**
 * DESFAZ o registro de venda À MÃO de uma plaquinha interna (GAP-PRD-189).
 *
 * O registro à mão da moto que ainda estava no pátio deixava a plaquinha
 * `SOLD` sem venda, e a única volta era mexer no banco. Aqui volta a
 * `NOT_SOLD`, com o motivo e o dono anterior no histórico, para a moto ser
 * adotada pela unidade da loja e vendida pelo PDV. Venda de verdade (com
 * `sale_id`, ou com unidade vinculada) não se desfaz por aqui.
 */
coreRouter.post('/equipment/:id/owner/desfazer', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const motivo = String(req.body?.motivo ?? '');
    const equipment = desfazerVendaAMao({
      companyId,
      equipmentId: String(req.params.id),
      userId,
      motivo,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.sale.manual_undo',
      entityType: 'equipment',
      entityId: equipment.id,
      detail: { motivo: motivo.trim() },
    });
    // O token da plaquinha não sai daqui, pelo mesmo motivo da rota vizinha.
    const { public_token, ...semCredencial } = equipment;
    void public_token;
    res.json(semCredencial);
  } catch (err) {
    next(err);
  }
});

/*
  A ROTA /equipment/by-token/:token FOI REMOVIDA.

  Ela resolvia o MESMO token da plaquinha que a rota pública resolve, e fazia
  o oposto da disciplina de EquipmentPublicView: devolvia a ficha inteira do
  equipamento — série, chassi, número de motor, observações, o dono e o
  próprio public_token — podada por uma lista de delete em cima do objeto.

  O que a justificava era o ramo do PROPRIETÁRIO, e ele nunca foi verdadeiro:
  testava um perfil "proprietario" que NADA no sistema concede — não está em
  ASSIGNABLE_PROFILES, nem em Permissions.ts, nem em AMBIENTE_POR_PERFIL. O
  dono jamais entrou por aqui. Sobrava a equipe, que já vê a ficha completa
  pela tela de equipamentos.

  E a rota não tinha um único chamador. Era código que PARECIA dar acesso ao
  proprietário e não dava — pior que ausência, porque quem lesse o arquivo
  contaria com ele. É a mesma arqueologia dos perfis "financeiro" e "tecnico"
  que a rodada 14 removeu.

  O acesso do proprietário é assunto do PORTAL, com sessão de cliente de
  verdade (core_customer_sessions), e não de um perfil administrativo que
  ninguém pode receber.
*/


// ----------------------------------------------- código de barras e etiquetas

/** Garante EAN-13 para o produto (mantém o do fabricante se já existir). */
coreRouter.post('/products/:id/barcode', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const result = ensureBarcode(companyId, String(req.params.id));
    if (result.generated) {
      recordAudit({
        companyId,
        userId,
        action: 'product.barcode.generate',
        entityType: 'product',
        entityId: result.productId,
        detail: { barcode: result.barcode },
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Dados das etiquetas comerciais a imprimir. O desenho é feito no cliente.
 *
 * ESCREVE NO CADASTRO, como a folha: produto sem código ganha EAN interno
 * quando a sessão tem products.manage e a etiqueta imprime código.
 *
 * DEFEITO QUE ISTO CORRIGE (C-etiquetas-R03): a rota chamava `buildLabels`
 * sem campos (logo, "precisa de código" para todos) e sem auditoria — 300
 * produtos pela API ganhavam 300 EANs, a sequência andava 300, e nenhuma linha
 * dizia quem ganhou qual código: o buraco que a folha (`/labels/sheet`) já
 * tinha fechado. Agora montar e auditar é uma transação só, a trilha
 * `label.products` lista os códigos que nasceram, a resposta devolve os mesmos
 * em `codigosGerados`, e o pedido pode dizer o formato (`formatId` ou
 * `templateId`): um formato sem código de barras não grava EAN em ninguém.
 */
coreRouter.post('/labels/products', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      throw new ApiError('CORE_EMPTY_LABELS', 'Selecione ao menos um produto.', 400);
    }
    // Teto de lote, o mesmo da folha: esta rota também grava EAN interno, e sem
    // teto um pedido pela API mandava o cadastro inteiro para a sequência de
    // código de barras numa transação só (revisão de C-etiquetas-R03).
    if (items.length > 1000) {
      throw new ApiError(
        'CORE_LABELS_TOO_MANY',
        'Lote grande demais: até 1000 produtos por pedido. Divida a lista em pedidos menores.',
        400,
      );
    }
    const pediuFormato = Boolean(body.templateId || body.formatId);
    const format = body.templateId
      ? formatoDoModelo(obterModelo(companyId, String(body.templateId)))
      : body.formatId
        ? findLabelFormat(String(body.formatId))
        : undefined;
    if (pediuFormato && !format) {
      throw new ApiError(
        'CORE_LABEL_FORMAT_UNKNOWN',
        `Formato de etiqueta desconhecido ("${String(body.formatId)}"). Em formatId vai um dos formatos de GET /labels/catalog; para um modelo da loja, mande o id dele em templateId.`,
        400,
      );
    }
    // Gravar EAN interno no cadastro é de quem gere o cadastro (products.manage):
    // o operador de caixa lê as etiquetas, mas produto sem código volta sem código.
    const podeGerarCodigo = Boolean(req.auth?.acesso?.capabilities.has('products.manage'));
    const { montadas, codigosGerados } = withTransaction(() => {
      const lote = buildLabels(companyId, items, { campos: format?.campos, podeGerarCodigo });
      const gerados = lote
        .filter((i) => i.codigoGerado)
        .map((i) => ({ productId: i.productId, name: i.name, barcode: i.barcode }));
      recordAudit({
        companyId,
        userId,
        action: 'label.products',
        entityType: 'label_batch',
        entityId: format?.id ?? 'dados-das-etiquetas',
        detail: {
          produtos: lote.length,
          codigosGerados: gerados.map(({ productId, barcode }) => ({ productId, barcode })),
        },
      });
      return { montadas: lote, codigosGerados: gerados };
    });
    res.json({ items: montadas, codigosGerados });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- etiquetas: origens e folha

/** O catálogo do que a tela pode oferecer: 6 origens, 7 formatos, 3 modos. */
coreRouter.get('/labels/catalog', (req: AuthedRequest, res, next) => {
  try {
    /*
      ABERTA AOS TRÊS: são as origens, formatos e modos que a tela pode
      oferecer — tabela fixa, sem um dado da empresa dentro.
      `rotas-dado-sensivel` já cobra 200 para o mecânico aqui.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    res.json({
      sources: LABEL_SOURCES,
      formats: LABEL_FORMATS,
      campos: CAMPOS_DA_ETIQUETA,
      defaultFormat: FORMATO_PADRAO,
      quantityModes: QUANTITY_MODES,
    });
  } catch (err) {
    next(err);
  }
});

/** De onde vêm os produtos a etiquetar. Leitura — não escreve nada. */
coreRouter.get('/labels/candidates', (req: AuthedRequest, res, next) => {
  try {
    /*
      O ESCRITÓRIO INTEIRO, e não o guarda de `POST /labels/sheet`.

      Copiar o guarda da folha seria o erro que esta rodada existe para não
      cometer: a folha esqueceu o `atendente`, e o roteador manda a tela de
      Etiquetas para ROTA_GESTAO, que inclui atendente e estoquista. Guarda mais
      estreito que a tela quebra tela.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const q = req.query;
    res.json(
      listLabelCandidates(companyId, {
        source: String(q.source ?? 'catalogo') as LabelSource,
        search: q.search ? String(q.search) : undefined,
        lowOnly: q.lowOnly === 'true',
        purchaseOrderId: q.purchaseOrderId ? String(q.purchaseOrderId) : undefined,
        // A origem "Nota de entrada": o que entrou numa nota confirmada.
        noteId: q.noteId ? String(q.noteId) : undefined,
        countId: q.countId ? String(q.countId) : undefined,
        productId: q.productId ? String(q.productId) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A origem "códigos colados" é POST porque a lista pode ter centenas de linhas
 * — não cabe em querystring — e porque colar texto não é um endereço que se
 * queira ver no histórico do navegador.
 */
coreRouter.post('/labels/candidates/codes', (req: AuthedRequest, res, next) => {
  try {
    /*
      É POST porque a lista colada não cabe na querystring — e só LÊ: devolve os
      produtos daqueles códigos. Quem escreve é `POST /labels/sheet`, que grava
      EAN-13. Mesmo alcance da tela de Etiquetas, pelo mesmo motivo do
      `/labels/candidates`.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json(
      listLabelCandidates(companyId, {
        source: 'codigos',
        codes: String(req.body?.codes ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * A folha pronta, em HTML medido em milímetro.
 *
 * ESCREVE NO CADASTRO: `buildLabels` grava EAN-13 interno em quem não tinha.
 * Um clique com a origem "estoque" pode carimbar código em centenas de
 * produtos de uma vez e consumir a sequência da empresa — por isso a auditoria
 * abaixo registra quantos itens passaram, e não é enfeite.
 */
coreRouter.post('/labels/sheet', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_loja');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      throw new ApiError('CORE_EMPTY_LABELS', 'Selecione ao menos um produto.', 400);
    }
    // Teto de lote: sem ele, um engano na origem "estoque" manda a loja
    // inteira para o papel e para a sequência de código de barras.
    if (items.length > 1000) {
      throw new ApiError(
        'CORE_LABELS_TOO_MANY',
        'Lote grande demais: até 1000 produtos por folha.',
        400,
      );
    }
    // Um MODELO da loja (templateId) ou um dos formatos prontos (formatId).
    const format = body.templateId
      ? formatoDoModelo(obterModelo(companyId, String(body.templateId)))
      : findLabelFormat(String(body.formatId ?? FORMATO_PADRAO));
    if (!format) {
      throw new ApiError('CORE_LABEL_FORMAT_UNKNOWN', 'Formato de etiqueta desconhecido.', 400);
    }

    /*
      "Começar na posição N" da primeira folha: a folha já usada volta à
      impressora e as etiquetas saem nas células livres, em vez de gastar uma
      folha nova para cada punhado de produtos.
    */
    const cabemNaFolha = format.columns * (format.rows ?? 1);
    const comecarEm = body.startAt === undefined || body.startAt === null || body.startAt === '' ? 1 : Number(body.startAt);
    if (!Number.isInteger(comecarEm) || comecarEm < 1 || comecarEm > cabemNaFolha) {
      throw new ApiError(
        'CORE_LABEL_START_INVALID',
        `Posição inicial: informe um número de 1 a ${cabemNaFolha} (as etiquetas desta folha).`,
        400,
      );
    }

    /*
      QUEM PODE CARIMBAR CÓDIGO NO CADASTRO. Reimprimir etiqueta é operacional
      (o caixa pode), mas gravar EAN interno em produto sem código é mexer no
      cadastro e consumir a sequência da empresa — só quem tem products.manage.
      Para os outros, o item sem código sai sem barras, e a tela diz que falta
      gerar o código no cadastro.
    */
    const podeGerarCodigo = Boolean(req.auth?.acesso?.capabilities.has('products.manage'));
    /*
      MONTAR, DESENHAR E AUDITAR NUMA TRANSAÇÃO SÓ.

      DEFEITO QUE ISTO CORRIGE: `buildLabels` conferia o lote antes de gravar,
      mas fechava a PRÓPRIA transação ao voltar — e o desenho ainda pode recusar
      a folha (o preço que não cabe nem no corpo mínimo, 400). Os EANs recém
      gravados ficavam no cadastro, sem folha e sem a auditoria que diz quais
      nasceram: o mesmo buraco do lote sem transação. Com o desenho e a
      auditoria aqui dentro, a recusa desfaz os códigos (a transação de
      `buildLabels` vira SAVEPOINT desta).
    */
    const { built, html, resumo, codigosGerados } = withTransaction(() => {
      const montadas = buildLabels(companyId, items, { campos: format.campos, podeGerarCodigo });
      const desenho = renderLabelSheet({ format, items: montadas, companyId, comecarEm });
      const contas = resumoDaFolha(format, montadas, comecarEm);
      const gerados = montadas
        .filter((i) => i.codigoGerado)
        .map((i) => ({ productId: i.productId, name: i.name, barcode: i.barcode }));
      recordAudit({
        companyId,
        userId,
        action: 'label.sheet',
        entityType: 'label_batch',
        entityId: format.id,
        // QUAIS produtos ganharam código neste lote, e não só quantos passaram:
        // sem a lista, não havia como saber de onde veio um EAN interno.
        detail: {
          produtos: montadas.length,
          ...contas,
          codigosGerados: gerados.map(({ productId, barcode }) => ({ productId, barcode })),
        },
      });
      return { built: montadas, html: desenho, resumo: contas, codigosGerados: gerados };
    });
    res.json({
      html,
      ...resumo,
      codigosGerados,
      semCodigo: built.filter((i) => i.codigoPendente === 'sem_permissao').map((i) => i.name),
      codigosSemDesenho: problemasDosCodigos(format, built),
      promocoes: built.filter((i) => i.onSale).map((i) => i.name),
      // Etiqueta com R$ 0,00 na prateleira é pior que etiqueta nenhuma: o
      // preço anunciado obriga a loja. Não recusamos a impressão — há caso
      // legítimo, como brinde —, mas quem clicou precisa ser avisado.
      semPreco: built.filter((i) => i.priceCents <= 0).map((i) => i.name),
    });
  } catch (err) {
    next(err);
  }
});


/*
  MODELOS DE ETIQUETA (preparação da Preço Justo). Ler, pré-visualizar e usar:
  quem imprime etiqueta. Criar, mudar e apagar: quem configura a impressão da
  loja. O modelo é a geometria e o conteúdo; a impressora é escolhida à parte.
*/
coreRouter.get('/labels/templates', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'labels.products.print');
    const { companyId } = scope(req);
    res.json({ items: listarModelos(companyId), campos: CAMPOS_DA_ETIQUETA });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/labels/templates', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'settings.printers.manage');
    const { companyId, userId } = scope(req);
    const modelo = criarModelo(companyId, userId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'label.template.created',
      entityType: 'label_template',
      entityId: modelo.id,
      detail: { nome: modelo.name, colunas: modelo.columns, larguraMm: modelo.widthMm, alturaMm: modelo.heightMm },
    });
    // Salva, mas diz o que pode dar errado no papel (barra abaixo do mínimo
    // GS1, campos que não cabem na altura).
    res.status(201).json({ ...modelo, avisos: avisosDoFormato(formatoDoModelo(modelo)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/labels/templates/:id', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'settings.printers.manage');
    const { companyId, userId } = scope(req);
    const modelo = atualizarModelo(companyId, String(req.params.id), req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'label.template.updated',
      entityType: 'label_template',
      entityId: modelo.id,
      detail: { nome: modelo.name, colunas: modelo.columns, larguraMm: modelo.widthMm, alturaMm: modelo.heightMm },
    });
    res.json({ ...modelo, avisos: avisosDoFormato(formatoDoModelo(modelo)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/labels/templates/:id', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'settings.printers.manage');
    const { companyId, userId } = scope(req);
    const apagado = excluirModelo(companyId, String(req.params.id));
    recordAudit({ companyId, userId, action: 'label.template.deleted', entityType: 'label_template', entityId: apagado.id, detail: { nome: apagado.name } });
    res.json({ ok: true, ...apagado });
  } catch (err) {
    next(err);
  }
});

/**
 * A prévia de um modelo — salvo (templateId) ou em edição (template). Só LÊ:
 * com produto, usa o dele sem gravar código de barras; sem, um exemplo.
 */
coreRouter.post('/labels/templates/preview', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'labels.products.print');
    const { companyId } = scope(req);
    const body = req.body ?? {};
    const modelo = body.templateId
      ? obterModelo(companyId, String(body.templateId))
      : validarModelo(body.template ?? {}, companyId);
    const quantidade = Number(body.quantity) || modelo.columns * 2;
    // Os campos do modelo decidem o título da variante (nome completo sem a linha da grade).
    const item = itemParaPrevia(companyId, body.productId ? String(body.productId) : null, quantidade, modelo.fields);
    const format = formatoDoModelo(modelo);
    res.json({
      html: renderLabelSheet({ format, items: [item], companyId }),
      ...resumoDaFolha(format, [item]),
      avisos: avisosDoFormato(format),
    });
  } catch (err) {
    next(err);
  }
});

/** "Gerar código" do cadastro: reserva o próximo código interno livre desta operação. */
coreRouter.post('/products/codes/next', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'products.manage');
    const { companyId } = scope(req);
    res.json({ code: reservarCodigoInterno(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * "Gerar código de barras" do cadastro: o EAN-13 de uso interno (prefixo 2)
 * para o produto sem código do fabricante. Produto que já tem código fica com
 * o dele — trocar invalidaria as etiquetas coladas.
 */
coreRouter.post('/products/:id/barcode/internal', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'products.manage');
    const { companyId, userId } = scope(req);
    const r = ensureBarcode(companyId, String(req.params.id));
    if (r.generated) {
      recordAudit({ companyId, userId, action: 'product.barcode_generated', entityType: 'product', entityId: r.productId, detail: { barcode: r.barcode } });
    }
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/**
 * O que a nota fez com o preço.
 *
 * Confirmar a entrada atualiza o CUSTO e deixa o preço onde estava. Esta rota
 * responde quais produtos ficaram abaixo do mínimo declarado — e por quanto
 * voltariam a ele.
 */
coreRouter.get('/purchases/notes/:id/repricing', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({ suggestions: suggestionsForNote(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/** Aplica só o que o lojista aceitou, linha a linha. */
coreRouter.post('/purchases/repricing/apply', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const precos = Array.isArray(req.body?.prices) ? req.body.prices : [];
    const r = applyPrices(
      companyId,
      precos.map((p: { productId: string; priceCents: number }) => ({
        productId: String(p.productId),
        priceCents: Number(p.priceCents),
      })),
    );
    recordAudit({
      companyId,
      userId,
      action: 'purchase.repricing.apply',
      entityType: 'product',
      entityId: String(req.body?.noteId ?? ''),
      detail: { atualizados: r.atualizados },
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- operadora de cartão

/**
 * Taxa de operadora é negociação comercial, e a única consumidora é a tela de
 * gestão. As cinco escritas ao lado já exigiam gerente; a leitura, não.
 *
 * O PDV não perde nada: ele pega as formas de pagamento em `/payment-methods`
 * e a taxa entra na venda pelo servidor, dentro de `planForPayment`.
 */
coreRouter.get('/acquirers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      acquirers: listAcquirers(companyId, true),
      rates: listRates(companyId),
      methods: activePaymentMethods(),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/acquirers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const a = createAcquirer(companyId, {
      name: String(req.body?.name ?? ''),
      accountId: req.body?.accountId ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'acquirer.create',
      entityType: 'acquirer',
      entityId: a.id,
      detail: { name: a.name },
    });
    res.status(201).json({ acquirer: a });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/acquirers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const a = updateAcquirer(companyId, String(req.params.id), {
      name: req.body?.name,
      accountId: req.body?.accountId,
      active: req.body?.active,
    });
    recordAudit({
      companyId,
      userId,
      action: 'acquirer.update',
      entityType: 'acquirer',
      entityId: a.id,
      detail: { active: a.active },
    });
    res.json({ acquirer: a });
  } catch (err) {
    next(err);
  }
});

/**
 * Grava taxa e prazo. É a rota que LIGA o comportamento novo: até haver uma
 * regra, a venda no cartão continua nascendo quitada como sempre.
 */
coreRouter.put('/acquirers/:id/rates', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const b = req.body ?? {};
    const r = setRate(companyId, {
      acquirerId: String(req.params.id),
      paymentMethod: String(b.paymentMethod ?? ''),
      installments: Number(b.installments ?? 1),
      feeBps: Number(b.feeBps ?? 0),
      settlementDays: Number(b.settlementDays ?? 0),
    });
    recordAudit({
      companyId,
      userId,
      action: 'acquirer.rate.set',
      entityType: 'acquirer_rate',
      entityId: r.id,
      detail: {
        method: r.payment_method,
        installments: r.installments,
        feeBps: r.fee_bps,
        days: r.settlement_days,
      },
    });
    res.json({ rate: r });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/acquirers/rates/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    removeRate(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'acquirer.rate.remove',
      entityType: 'acquirer_rate',
      entityId: String(req.params.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Simula o calendário antes de o lojista confiar nele. */
coreRouter.get('/acquirers/preview', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      plan: planForPayment(companyId, {
        paymentMethod: String(req.query.method ?? 'credito'),
        amountCents: Number(req.query.amountCents ?? 0),
        installments: Number(req.query.installments ?? 1),
        saleDate: hojeNaLoja(),
      }),
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- comissões

/**
 * Comissão é folha de pagamento.
 *
 * Estas duas leituras nasceram sem guarda enquanto as sete escritas ao lado
 * exigiam gerente — e leitura desprotegida ao lado de escrita protegida é a
 * forma mais fácil de o dado vazar: `/setup` diz quanto cada faixa paga e quem
 * está em qual grupo, `/summary` diz quanto cada vendedor ganhou no período.
 * Qualquer sessão autenticada lia as duas, inclusive mecânico e atendente.
 */
coreRouter.get('/commissions/setup', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const grupos = listCommissionGroups(companyId, true);
    res.json({
      groups: grupos.map((g) => ({ ...g, tiers: listTiers(companyId, g.id) })),
      members: listCommissionMembers(companyId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/commissions/groups', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const g = createCommissionGroup(companyId, String(req.body?.name ?? ''));
    recordAudit({
      companyId,
      userId,
      action: 'commission.group.create',
      entityType: 'commission_group',
      entityId: g.id,
      detail: { name: g.name },
    });
    res.status(201).json({ group: g });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/commissions/groups/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const g = updateCommissionGroup(companyId, String(req.params.id), {
      name: req.body?.name,
      active: req.body?.active,
    });
    recordAudit({
      companyId,
      userId,
      action: 'commission.group.update',
      entityType: 'commission_group',
      entityId: g.id,
      detail: { active: g.active },
    });
    res.json({ group: g });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/commissions/groups/:id/tiers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const t = setTier(
      companyId,
      String(req.params.id),
      Number(req.body?.minCents ?? 0),
      Number(req.body?.rateBps ?? 0),
    );
    recordAudit({
      companyId,
      userId,
      action: 'commission.tier.set',
      entityType: 'commission_tier',
      entityId: t.id,
      detail: { minCents: t.min_cents, rateBps: t.rate_bps },
    });
    res.json({ tier: t });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/commissions/tiers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    removeTier(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'commission.tier.remove',
      entityType: 'commission_tier',
      entityId: String(req.params.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/commissions/members/:userId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    setMemberGroup(companyId, String(req.params.userId), req.body?.groupId ?? null);
    recordAudit({
      companyId,
      userId,
      action: 'commission.member.set',
      entityType: 'user',
      entityId: String(req.params.userId),
      detail: { groupId: req.body?.groupId ?? null },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/commissions/summary', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const hoje = hojeNaLoja();
    res.json(
      summarizeCommissions(
        companyId,
        String(req.query.from ?? `${hoje.slice(0, 7)}-01`),
        String(req.query.to ?? hoje),
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * O único ponto em que comissão vira dinheiro — por isso o perfil é o de quem
 * responde pelo caixa, e a auditoria registra quem mandou pagar.
 */
coreRouter.post('/commissions/close', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const b = req.body ?? {};
    const r = fecharPeriodo({
      companyId,
      sellerId: String(b.sellerId ?? ''),
      from: String(b.from ?? ''),
      to: String(b.to ?? ''),
      userId,
      dueDate: b.dueDate ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'commission.close',
      entityType: 'commission_closing',
      entityId: r.closingId,
      detail: { sellerId: b.sellerId, totalCents: r.totalCents, from: b.from, to: b.to },
    });
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

/**
 * O histórico de fechamentos (GAP-PRD-174) — para onde leva o título da
 * comissão no contas a pagar. Mesmo alcance de quem fecha.
 */
coreRouter.get('/commissions/closings', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      items: listCommissionClosings(companyId, {
        sellerId: req.query.sellerId ? String(req.query.sellerId) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/commissions/closings/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(getCommissionClosing(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * As formas de recebimento que o balcão pode oferecer.
 *
 * Existe para o PDV parar de ter a própria lista. Duas listas divergem no dia
 * em que uma muda — e a que grava é esta.
 */
coreRouter.get('/payment-methods', (req: AuthedRequest, res, next) => {
  try {
    /*
      ABERTA AOS TRÊS: as formas de pagamento aceitas são cardápio, não
      segredo. `rotas-dado-sensivel` já cobra 200 para o mecânico.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    res.json({ methods: activePaymentMethods() });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- financeiro: os três cadastros

/**
 * Devolve o SALDO de todas as contas bancárias da empresa — por isso a guarda.
 *
 * Nasceu aberta a qualquer sessão autenticada. A tela é de gestão e bloqueava
 * o acesso pelo roteador do navegador, mas a API respondia para quem chamasse
 * direto: mecânico, atendente, caixa. Tela que bloqueia com API que responde
 * não é proteção, é aparência de proteção.
 */
coreRouter.get('/finance/setup', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    // Numa chamada só: a tela precisa das três listas juntas para montar os
    // seletores, e três idas ao servidor fariam a tela piscar em três tempos.
    res.json({
      categories: listFinanceCategories(companyId, { includeInactive: true }),
      costCenters: listCostCenters(companyId, true),
      accounts: listAccounts(companyId, true).map((c) => ({
        ...c,
        balanceCents: accountBalanceCents(companyId, c.id),
      })),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/categories', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const c = createCategory(companyId, {
      direction: String(req.body?.direction ?? 'out') as 'in' | 'out',
      name: String(req.body?.name ?? ''),
      parentId: req.body?.parentId ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.category.create',
      entityType: 'finance_category',
      entityId: c.id,
      detail: { name: c.name, direction: c.direction },
    });
    res.status(201).json({ category: c });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/finance/categories/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const c = updateCategory(companyId, String(req.params.id), {
      name: req.body?.name,
      active: req.body?.active,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.category.update',
      entityType: 'finance_category',
      entityId: c.id,
      detail: { active: c.active },
    });
    res.json({ category: c });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/cost-centers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const cc = createCostCenter(companyId, {
      code: String(req.body?.code ?? ''),
      name: String(req.body?.name ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.cost_center.create',
      entityType: 'cost_center',
      entityId: cc.id,
      detail: { code: cc.code },
    });
    res.status(201).json({ costCenter: cc });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/finance/cost-centers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const cc = updateCostCenter(companyId, String(req.params.id), {
      name: req.body?.name,
      active: req.body?.active,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.cost_center.update',
      entityType: 'cost_center',
      entityId: cc.id,
      detail: { active: cc.active },
    });
    res.json({ costCenter: cc });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/finance/accounts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const b = req.body ?? {};
    const conta = createAccount(companyId, {
      name: String(b.name ?? ''),
      kind: b.kind,
      bankCode: b.bankCode,
      agency: b.agency,
      accountNumber: b.accountNumber,
      openingBalanceCents: Number(b.openingBalanceCents ?? 0),
      openingDate: b.openingDate ?? null,
      isDefault: b.isDefault === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.account.create',
      entityType: 'finance_account',
      entityId: conta.id,
      detail: { name: conta.name, kind: conta.kind },
    });
    res.status(201).json({ account: conta });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/finance/accounts/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const conta = updateAccount(companyId, String(req.params.id), {
      name: req.body?.name,
      active: req.body?.active,
      isDefault: req.body?.isDefault,
      openingBalanceCents:
        req.body?.openingBalanceCents === undefined
          ? undefined
          : Number(req.body.openingBalanceCents),
    });
    recordAudit({
      companyId,
      userId,
      action: 'finance.account.update',
      entityType: 'finance_account',
      entityId: conta.id,
      detail: { active: conta.active, isDefault: conta.is_default },
    });
    res.json({ account: conta });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------- unidades serializadas

/**
 * Plaquinhas do grupo que esta loja pode adotar.
 *
 * Vem ANTES de `/units/:productId` de propósito: o Express casa por ordem, e
 * declarada depois esta rota seria engolida pela outra com
 * `productId = 'equipment-candidates'`.
 *
 * Guardada pelos MESMOS perfis das rotas que escrevem unidade — e não aberta
 * como as duas leituras vizinhas — porque esta lista atravessa empresa por
 * desenho: mostra plaquinha que vive na oficina, que é outra empresa. É a única
 * leitura de unidade que faz isso.
 */
coreRouter.get('/units/equipment-candidates', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    const termo = req.query.termo ? String(req.query.termo) : undefined;
    // A unidade que vai receber: vendida, a lista traz só a plaquinha com o
    // mesmo número (vínculo tardio, GAP-PRD-108).
    const unitId = req.query.unitId ? String(req.query.unitId) : undefined;
    res.json({ items: plaquinhasVinculaveis(companyId, termo, unitId) });
  } catch (err) {
    next(err);
  }
});

/**
 * O tamanho da fila de vínculo — a empresa inteira, sem escolher produto antes.
 *
 * ## Por que uma rota, e não uma conta na tela
 *
 * A tela de Unidades já contava "sem plaquinha", mas só depois de escolher o
 * produto — e escolher o produto é justamente o passo difícil, porque exige
 * adivinhar de qual cadastro saiu a moto que se tem na mão. Enquanto o número
 * dependesse desse passo, a fila não existia: ninguém vincula o que não vê, e
 * TUDO o que o vínculo entrega (o comprador virar dono, o QR responder, a
 * garantia ter a quem pertencer) ficava pendurado nele.
 *
 * A conta tem que vir do servidor porque a tela nunca tem a empresa inteira em
 * mãos: `/units/:productId` traz um produto, `/units?q=` traz o que casou com o
 * termo bipado. Somar no navegador daria o total do que já foi carregado, que é
 * outro número — e um número menor que a verdade é pior do que número nenhum,
 * porque some sozinho da tela quando a fila esvazia por engano.
 *
 * ## O corte
 *
 * `in_stock` de propósito. A peça VENDIDA sem plaquinha é passado: ninguém volta
 * atrás no vínculo depois que a moto saiu, e contá-la faria a fila crescer para
 * sempre com trabalho que não existe mais. A baixada, idem.
 *
 * Conta unidade de QUALQUER produto serializado, inclusive celular — que nunca
 * vai ter plaquinha. Filtrar por "produto que passa pela bancada" exigiria uma
 * marca no cadastro que ninguém preenche, e marca não preenchida esconderia
 * justamente a moto. Quem lê a tela recebe a ressalva junto do número.
 *
 * ## Perfis
 *
 * Aberta como as duas leituras vizinhas de unidade (`/units/:productId` e
 * `/units?q=`), e não fechada como `/units/equipment-candidates`. A diferença é
 * o que cada uma alcança: a lista de candidatas atravessa empresa por desenho —
 * mostra plaquinha que vive na oficina — enquanto isto aqui é uma contagem das
 * unidades DA PRÓPRIA empresa, o mesmo dado que as duas leituras abertas já
 * devolvem linha a linha.
 *
 * Declarada ANTES de `/units/:productId` pelo mesmo motivo de
 * `/units/equipment-candidates`: o Express casa por ordem, e depois dela esta
 * rota seria engolida com `productId = 'summary'` — devolvendo 200 com lista
 * vazia, que é o pior jeito de quebrar, porque não parece quebrado.
 */
coreRouter.get('/units/summary', (req: AuthedRequest, res, next) => {
  try {
    /*
      O resumo de quantas unidades serializadas existem por produto: tela de
      Unidades de estoque, ROTA_GESTAO.
    */
    abertaAo(req, 'escritorio');
    ensureCoreSchema();
    const { companyId } = scope(req);
    const db = getConnection();
    const contar = (sql: string): number =>
      Number((db.prepare(sql).get(companyId) as { total: number }).total);
    res.json({
      semPlaquinha: contar(
        `SELECT COUNT(*) AS total FROM core_product_units
          WHERE company_id = ? AND status = 'in_stock' AND equipment_id IS NULL`,
      ),
      /*
        A FILA DO VÍNCULO TARDIO (GAP-PRD-108): moto que saiu vendida sem
        plaquinha. Deixou de ser "passado" — a plaquinha com o mesmo número ainda
        entra nela e o comprador vira o dono no portal.
      */
      vendidasSemPlaquinha: contar(
        `SELECT COUNT(*) AS total FROM core_product_units
          WHERE company_id = ? AND status = 'sold' AND equipment_id IS NULL
            AND exit_reference_type IN ('sale', 'ecommerce_order')`,
      ),
      /*
        O DIA 1 DA OPERAÇÃO DE MOTOS (GAP-PRD-112): quantos produtos são
        controlados por unidade e quantas motos do pátio ainda não têm número
        nenhum. Zero produto serializado é a configuração que falta, dita na tela.
      */
      produtosSerializados: contar(
        'SELECT COUNT(*) AS total FROM core_products WHERE company_id = ? AND serialized = 1 AND active = 1',
      ),
      semIdentidade: contar(
        `SELECT COUNT(*) AS total FROM core_product_units
          WHERE company_id = ? AND status = 'in_stock'
            AND chassis IS NULL AND motor_number IS NULL AND serial_number IS NULL
            AND imei IS NULL AND plate IS NULL`,
      ),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/units/:productId', (req: AuthedRequest, res, next) => {
  try {
    /*
      O PDV precisa listar as unidades para o operador escolher qual número de
      série está saindo (ROTA_PDV).
    */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const status = req.query.status ? String(req.query.status) : undefined;
    const unidades = listProductUnits(companyId, String(req.params.productId), {
      status: status as 'in_stock' | 'sold' | 'baixada' | undefined,
    });
    // A moto segurada por uma pré-venda viva (GAP-PRD-111) vem marcada: o PDV
    // não a escolhe para outro cliente, e a tela diz para quem ela está.
    const reservas = reservasAtivas(
      companyId,
      unidades.filter((u) => u.status === 'in_stock').map((u) => u.id),
    );
    res.json({
      // A plaquinha vai JUNTO da unidade porque é na lista que o operador
      // decide: sem ela, a tela mostraria um botão de vincular para uma moto que
      // já tem plaquinha, e só descobriria o engano no 409.
      //
      // Só consulta quem tem vínculo. Unidade sem `equipment_id` — a maioria
      // esmagadora do estoque — não paga nenhuma consulta a mais.
      items: unidades.map((u) => ({
        ...u,
        plaquinha: u.equipment_id ? plaquinhaDaUnidade(companyId, u.id) : null,
        reserva: reservas.get(u.id) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Adota a plaquinha da oficina para esta unidade.
 *
 * `confirmarPelaUnidade` é a válvula da divergência de identidade: sem ela, o
 * chassi digitado errado na bancada viraria beco sem saída, porque o vínculo é o
 * único caminho de conserto da plaquinha.
 */
coreRouter.post('/units/:id/equipment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const equipmentId = String(req.body?.equipmentId ?? '').trim();
    if (!equipmentId) {
      throw new ApiError('CORE_EQUIPMENT_REQUIRED', 'Informe a plaquinha a vincular.', 400);
    }
    const plaquinha = vincularUnidade({
      companyId,
      unitId: String(req.params.id),
      equipmentId,
      userId,
      confirmarPelaUnidade: req.body?.confirmarPelaUnidade === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'unit.equipment.link',
      entityType: 'product_unit',
      entityId: String(req.params.id),
      detail: {
        equipmentId,
        publicId: plaquinha.publicId,
        // Fica na auditoria porque é a sobrescrita da identidade da plaquinha —
        // quem autorizou precisa aparecer, não só o fato de ter havido vínculo.
        confirmarPelaUnidade: req.body?.confirmarPelaUnidade === true,
        // Vínculo feito depois da venda: o dono foi carimbado agora (GAP-PRD-108).
        tardio: plaquinha.saleStatus === 'SOLD',
      },
    });
    res.status(201).json({ plaquinha });
  } catch (err) {
    next(err);
  }
});

/**
 * REIMPRIME a plaquinha adotada por esta unidade (GAP-PRD-190).
 *
 * Quem vende a moto não tinha como: as duas rotas de etiqueta procuram o
 * equipamento pela empresa da sessão, e ele vive na Oficina. A autorização é a
 * UNIDADE (da empresa da sessão), e a plaquinha vem do vínculo dela — o corpo
 * só escolhe o formato. Mesmo número e mesmo QR: reimprimir não é trocar.
 */
coreRouter.post('/units/:id/equipment/sheet', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const folha = folhaDaPlaquinhaDaUnidade({
      companyId,
      unitId: String(req.params.id),
      userId,
      formatId: req.body?.formatId ? String(req.body.formatId) : undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'unit.equipment.label.reprint',
      entityType: 'product_unit',
      entityId: String(req.params.id),
      detail: { equipmentId: folha.equipmentId, publicId: folha.publicIdLabel, formatId: folha.formatId },
    });
    res.json({
      html: folha.html,
      formatId: folha.formatId,
      publicIdLabel: folha.publicIdLabel,
      plaquinhas: 1,
      folhas: folha.folhas,
      qrMm: folha.qrMm,
      moduloMm: folha.moduloMm,
      abaixoDoPiso: folha.abaixoDoPiso,
      baseUrl: folha.baseUrl,
      baseUrlConfigurada: folha.baseUrlConfigurada,
    });
  } catch (err) {
    next(err);
  }
});

/** Desfaz o vínculo — só enquanto nada saiu do estoque. */
coreRouter.delete('/units/:id/equipment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const antes = plaquinhaDaUnidade(companyId, String(req.params.id));
    desvincularUnidade({ companyId, unitId: String(req.params.id), userId });
    recordAudit({
      companyId,
      userId,
      action: 'unit.equipment.unlink',
      entityType: 'product_unit',
      entityId: String(req.params.id),
      // Lido ANTES de desfazer: depois do UPDATE não há mais como dizer QUAL
      // plaquinha foi solta, e é justamente isso que a auditoria precisa guardar.
      detail: { equipmentId: antes?.id ?? null, publicId: antes?.publicId ?? null },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Bipar o IMEI ou o chassi no balcão e achar a peça. */
coreRouter.get('/units', (req: AuthedRequest, res, next) => {
  try {
    /** Busca de unidade por código: é o operador com a etiqueta na mão. */
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: searchUnit(companyId, String(req.query.q ?? '')) });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/units/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const b = req.body ?? {};
    const unidade = identifyUnit(companyId, String(req.params.id), {
      serialNumber: b.serialNumber,
      imei: b.imei,
      chassis: b.chassis,
      motorNumber: b.motorNumber,
      plate: b.plate,
      note: b.note,
      // Quem corrigiu vai junto porque a correção pode ATRAVESSAR para a
      // plaquinha da oficina, e lá o histórico é lido por outra equipe.
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'unit.identify',
      entityType: 'product_unit',
      entityId: unidade.id,
      detail: { productId: unidade.product_id },
    });
    res.json({ unit: unidade });
  } catch (err) {
    next(err);
  }
});

/**
 * Baixa de unidade: perda, quebra, devolução ao fornecedor.
 *
 * É o caminho que substitui o acerto de inventário para produto serializado —
 * lá "faltam 2" não diz QUAIS 2.
 */
coreRouter.post('/units/:id/write-off', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const unidade = getUnit(companyId, String(req.params.id));
    if (!unidade) throw new ApiError('CORE_UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);
    const motivo = String(req.body?.reason ?? '').trim();
    if (!motivo) {
      throw new ApiError('CORE_REASON_REQUIRED', 'Informe o motivo da baixa.', 400);
    }

    // 'adjust' com delta negativo: o saldo cai e a unidade vira "baixada" — que
    // é diferente de "vendida", porque não gera nota nem garantia.
    applyMovement({
      companyId,
      productId: unidade.product_id,
      movementType: 'adjust',
      quantity: -1,
      referenceType: 'unit_write_off',
      referenceId: unidade.id,
      kind: 'INVENTORY_ADJUSTMENT_NEGATIVE',
      userId,
      reason: motivo,
      unitIds: [unidade.id],
    });
    recordAudit({
      companyId,
      userId,
      action: 'unit.write_off',
      entityType: 'product_unit',
      entityId: unidade.id,
      detail: { reason: motivo },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- balança

coreRouter.get('/scales/formats', (req: AuthedRequest, res, next) => {
  try {
    /*
      ABERTA AOS TRÊS: os layouts de arquivo que as balanças do mercado leem.
      Tabela do produto, não da empresa. `rotas-dado-sensivel` cobra 200 para o
      mecânico.
    */
    abertaAo(req, 'balcao', 'bancada', 'escritorio');
    res.json({ formats: SCALE_FORMATS });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/scales/products', (req: AuthedRequest, res, next) => {
  try {
    /*
      Já esta lista é da empresa — os pesáveis com preço, prontos para exportar
      para a balança. Tela de Balança, ROTA_GESTAO.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listWeighableProducts(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Devolve JSON e não `text/plain` de propósito: a tela precisa mostrar o que
 * ficou de FORA antes de o arquivo ser baixado. Um arquivo com 4 linhas quando
 * se esperava 40 tem de se explicar antes, não depois.
 */
coreRouter.post('/scales/export', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const result = buildScaleFile(companyId, {
      formatId: String(req.body?.formatId ?? ''),
      productIds: Array.isArray(req.body?.productIds) ? req.body.productIds : undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'scale.export',
      entityType: 'scale_export',
      entityId: String(req.body?.formatId ?? ''),
      detail: { lineCount: result.lineCount, skipped: result.skipped.length },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Plaquinha do equipamento: QR + #ID.
 *
 * Devolve o token para o QR, nunca dados do proprietário — a plaquinha fica
 * exposta no equipamento e não pode carregar informação pessoal.
 */
coreRouter.post('/labels/equipment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'mecanico', 'operador_caixa_oficina');
    const { companyId } = scope(req);
    const ids: string[] = Array.isArray(req.body?.equipmentIds) ? req.body.equipmentIds : [];
    if (ids.length === 0) {
      throw new ApiError('CORE_EMPTY_LABELS', 'Selecione ao menos um equipamento.', 400);
    }
    /*
      O ENDEREÇO DO QR SAI DA CONFIGURAÇÃO, NÃO DO CORPO DA REQUISIÇÃO.

      A rota irmã — a folha de plaquinhas, umas cem linhas abaixo — já usa
      `publicBaseUrl()`. Esta continuava lendo `req.body.baseUrl`: o MESMO
      endereço, decidido em dois lugares do MESMO arquivo, por duas regras
      diferentes. Quem imprime a folha e quem pede os dados da plaquinha
      recebiam QRs que apontavam para hosts distintos, e nada denunciava a
      divergência — os dois códigos escaneiam, só que um vai para o lugar
      errado.

      Pior: o navegador mandava o que ele sabia, que é o endereço por onde
      AQUELE atendente entrou. Numa loja, isso costuma ser o IP da máquina na
      rede interna. A plaquinha fica colada no equipamento por anos e sai do
      pátio no guidão da moto — o QR precisa funcionar do celular do cliente,
      na rua, meses depois. `publicBaseUrl()` é o endereço que o dono
      configurou em `GRUPO_SAMPAIO_PUBLIC_URL`, e é o único que sobrevive a
      uma troca de rede.

      O corpo pode continuar mandando `baseUrl`: é simplesmente ignorado. A
      tela de etiquetas já parou de enviá-lo.
    */
    const base = publicBaseUrl();
    const items = ids.map((id) => {
      const equipment = getEquipment(companyId, id);
      if (!equipment) {
        throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);
      }

      // PLAQUINHA SÓ ONDE O APARELHO FICA.
      //
      // Moto e patinete passam dias no pátio: a plaquinha é como se acha o
      // aparelho e como o cliente consulta o andamento. Celular entra e sai,
      // muitas vezes no mesmo dia, e vai para gaveta identificada pela própria
      // OS — plaquinha com QR colada no aparelho do cliente não serve, e
      // oferecer o botão ensina a usar o que não se usa.
      const oficina = equipment.workshop_id
        ? (getConnection()
            .prepare('SELECT kind, name FROM core_workshops WHERE id = ?')
            .get(String(equipment.workshop_id)) as { kind: string; name: string } | undefined)
        : undefined;
      if (oficina && !capabilitiesFor(oficina.kind).equipmentTags) {
        throw new ApiError(
          'CORE_WORKSHOP_NO_TAGS',
          `${oficina.name} não usa plaquinha: o aparelho é identificado pela própria OS.`,
          409,
        );
      }

      return {
        equipmentId: equipment.id,
        publicIdLabel: formatPublicId(equipment.public_id),
        qrUrl: `${base}/equipamento/${equipment.public_token}`,
        brand: equipment.brand,
        model: equipment.model,
      };
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * A FOLHA de plaquinhas, desenhada no servidor, em milímetro.
 *
 * A rota acima devolve DADOS e a tela montava o adesivo em pixels — sem
 * tamanho físico previsível. Esta devolve o papel pronto, como a folha de
 * etiqueta de produto já faz.
 *
 * ## Um celular na seleção não derruba o lote
 *
 * A rota acima lança no primeiro equipamento sem plaquinha. Aqui o que não
 * pode virar adesivo sai numa lista de `problemas`, e a folha é gerada com o
 * resto: quem selecionou trinta equipamentos não perde os vinte e nove por
 * causa de um.
 */
coreRouter.post('/labels/equipment/sheet', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente');
    const { companyId } = scope(req);
    const ids: string[] = Array.isArray(req.body?.equipmentIds) ? req.body.equipmentIds : [];
    if (ids.length === 0) {
      throw new ApiError('CORE_EMPTY_LABELS', 'Selecione ao menos um equipamento.', 400);
    }

    const formato = equipmentTagFormat(req.body?.formatId as string | undefined);
    const itens: PlaquinhaItem[] = [];
    const problemas: { equipmentId: string; motivo: string }[] = [];

    for (const id of ids) {
      const equipment = getEquipment(companyId, id);
      if (!equipment) {
        problemas.push({ equipmentId: id, motivo: 'Equipamento não encontrado.' });
        continue;
      }
      const oficina = equipment.workshop_id
        ? (getConnection()
            .prepare('SELECT kind, name FROM core_workshops WHERE id = ?')
            .get(String(equipment.workshop_id)) as { kind: string; name: string } | undefined)
        : undefined;
      if (oficina && !capabilitiesFor(oficina.kind).equipmentTags) {
        problemas.push({
          equipmentId: id,
          motivo: `${oficina.name} não usa plaquinha: o aparelho é identificado pela própria OS.`,
        });
        continue;
      }
      itens.push({
        publicIdLabel: formatPublicId(equipment.public_id),
        // O endereço sai da CONFIGURAÇÃO, nunca do host de quem imprimiu: o
        // adesivo fica colado por anos, e apontar para o IP da máquina que
        // gerou a folha faria o QR morrer na próxima troca de rede.
        qrUrl: `${publicBaseUrl()}/equipamento/${equipment.public_token}`,
        brand: equipment.brand as string | null,
        model: equipment.model as string | null,
      });
    }

    if (itens.length === 0) {
      throw new ApiError(
        'CORE_NO_TAGGABLE_EQUIPMENT',
        'Nenhum dos equipamentos selecionados usa plaquinha.',
        409,
        { problemas },
      );
    }

    /*
      A MESMA PLAQUINHA NÃO PODE TER DUAS CARAS (rodada 53).

      Esta é a folha da tela de Equipamentos — o caminho de sempre para
      reimprimir o adesivo de uma máquina já cadastrada. Sem o layout, ela saía
      branca e sem marca enquanto a folha do pool saía com a logo e as cores da
      operação: a mesma divergência que tirar o layout do navegador matou.
    */
    const folha = renderEquipmentTagSheet({
      companyId,
      format: formato,
      layout: layoutDaEmpresa(companyId),
      items: itens,
    });
    res.json({
      html: folha.html,
      formatId: formato.id,
      plaquinhas: itens.length,
      folhas: folha.folhas,
      qrMm: folha.qrMm,
      moduloMm: folha.moduloMm,
      // A tela avisa ANTES de gastar folha adesiva: módulo pequeno demais é
      // adesivo impresso que o celular não lê.
      abaixoDoPiso: folha.abaixoDoPiso,
      // O endereço vai junto para conferência: a plaquinha fica anos colada, e
      // qual é o endereço certo é pergunta para o dono, não para o código.
      baseUrl: publicBaseUrl(),
      baseUrlConfigurada: publicBaseUrlConfigurada(),
      problemas,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/labels/equipment/formats', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista', 'atendente');
    res.json({
      items: EQUIPMENT_TAG_FORMATS,
      baseUrl: publicBaseUrl(),
      baseUrlConfigurada: publicBaseUrlConfigurada(),
    });
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------- o pool de plaquinhas (rodada 53)
//
// A REGRA DE OURO do dono mora em `empresaUsaPlaquinha`, e todas as rotas
// abaixo passam por ela: plaquinha com QR e número é da PJ Motors e da
// Oficina. Loja de roupa e de maquiagem identifica mercadoria por etiqueta
// comercial — código de barras e preço —, que é outra tela e outro catálogo.
//
// Os perfis são os da BANCADA (mecânico, gerente de oficina, atendente,
// caixa da oficina) mais o gerente de loja, que é quem adota a plaquinha na
// PJ Motors. O `gerente_loja` de uma loja de roupa passa no perfil e para na
// regra de ouro, com a frase que explica por quê.

coreRouter.post('/equipment-tags/batches', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista');
    const { companyId, userId } = scope(req);
    const lote = criarLoteDePlaquinhas({
      companyId,
      userId,
      quantidade: Number(req.body?.quantidade),
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.tags.batch',
      entityType: 'equipment_tag_batch',
      entityId: lote.batchId,
      detail: { criadas: lote.criadas, primeira: lote.primeira, ultima: lote.ultima },
    });
    res.status(201).json(lote);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/equipment-tags', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'gerente_oficina',
      'gerente_loja',
      'mecanico',
      'estoquista',
      'atendente',
      'operador_caixa_oficina',
    );
    const { companyId } = scope(req);
    res.json({
      /*
        A CREDENCIAL NAO VIAJA NA LISTA.

        `public_token` abre a pagina publica do equipamento SEM sessao, nao
        expira e nao se revoga — e na plaquinha associada ele E o token da
        maquina. As tres rotas irmas de equipamento ja podam o campo; esta
        entregaria ate mil credenciais numa requisicao, aos perfis mais
        largos da rodada. A poda e aqui, na fronteira: quem imprime a folha
        precisa do token, e e a mesma funcao que responde as duas.
      */
      ...(() => {
        const { itens, total } = listarPlaquinhas({
          companyId,
          status: req.query.status ? String(req.query.status) : undefined,
          batchId: req.query.batchId ? String(req.query.batchId) : undefined,
          busca: req.query.busca ? String(req.query.busca) : undefined,
          limite: req.query.limite ? Number(req.query.limite) : undefined,
        });
        // `total` é o que a busca ENCONTROU; `items` é o que coube na janela.
        // A tela precisa dos dois para dizer "mostrando 300 de 1.180".
        return { items: itens.map(semCredencial), total };
      })(),
      resumo: resumoDoPool(companyId),
      usaPlaquinha: empresaUsaPlaquinha(companyId),
      // Gerar, imprimir e liberar exigem bancada para colar o adesivo
      // (GAP-PRD-110): a tela explica em vez de oferecer o que leva 409.
      temBancada: empresaTemBancada(companyId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/equipment-tags/batches', (req: AuthedRequest, res, next) => {
  try {
    /*
      Os MESMOS perfis que leem o pool: os lotes sao uma leitura do mesmo
      dado, agrupada. Com a lista mais estreita, o atendente abria a tela,
      levava 403 aqui, o `catch` da tela engolia, e o card dizia "Nenhum
      lote — gere o primeiro acima" com mil plaquinhas no banco e sem o
      botao de gerar na tela dele.
    */
    requireProfile(
      req,
      'gerente_oficina',
      'gerente_loja',
      'mecanico',
      'estoquista',
      'atendente',
      'operador_caixa_oficina',
    );
    res.json({ items: listarLotesDePlaquinha(scope(req).companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * A FOLHA do lote — e a marca de que o papel existe.
 *
 * Esta rota é a única que grava `printed_at`, e é por isso que ela é POST e
 * não GET: exportar a folha é um FATO, não uma leitura. A liberação depois
 * consulta essa marca, e é o que impede número liberado sem adesivo.
 *
 * `preview: true` desenha UMA plaquinha de exemplo com o layout que vier no
 * corpo — é o que o editor mostra enquanto o gerente mexe nas cores, e vem do
 * MESMO renderizador que imprime, para que o que se vê seja o que sai.
 */
coreRouter.post('/equipment-tags/sheet', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista');
    const { companyId } = scope(req);
    exigirEmpresaComPlaquinha(companyId);

    const layout = req.body?.layout
      ? layoutValidado(req.body.layout as Record<string, unknown>)
      : layoutDaEmpresa(companyId);
    /*
      O TAMANHO DO LAYOUT SÓ VALE NO FORMATO QUE O SEGUE.

      O editor pede largura e altura em milímetro; o catálogo de formatos
      decide onde a plaquinha cai na folha. Enquanto os dois não se falavam, o
      editor prometia 100 × 40 mm e o papel saía com os 63 × 33 do formato
      escolhido — duas verdades sobre a mesma etiqueta. Agora o tamanho do
      layout tem um formato próprio, com colunas calculadas e a mesma conta de
      módulo do QR.
    */
    const formatoPedido = req.body?.formatId as string | undefined;
    const formato =
      formatoPedido === FORMATO_PERSONALIZADO
        ? formatoDoLayout(layout)
        : equipmentTagFormat(formatoPedido);

    if (req.body?.preview === true) {
      const folha = renderEquipmentTagSheet({
        companyId,
        format: formato,
        layout,
        items: [
          {
            publicIdLabel: formatTagId(1),
            brand: 'Exemplo',
            model: 'Plaquinha',
            qrUrl: `${publicBaseUrl()}/equipamento/exemplo`,
          },
        ],
      });
      res.json({ ...folha, preview: true });
      return;
    }

    // Imprimir o lote é o passo antes de colar: sem bancada, o adesivo não teria
    // onde entrar (GAP-PRD-110). A pré-visualização do layout continua livre.
    exigirBancadaQueColaPlaquinha(companyId);

    /*
      O LOTE INTEIRO, ou os ids escolhidos — e nunca por lista janelada.

      A primeira versão filtrava `listarPlaquinhas({ limite: 1000 })`, que
      ordena por número DESCENDENTE: num lote cheio de mil, a plaquinha mais
      velha saía da janela assim que outra nascia. O que a folha não desenha
      não recebe `printed_at`, e sem `printed_at` não há liberação — o lote
      ficava preso em `gerada` para sempre, com a numeração queimada.
    */
    const ids: string[] = Array.isArray(req.body?.tagIds) ? req.body.tagIds : [];
    const doLote = req.body?.batchId ? String(req.body.batchId) : '';
    if (ids.length === 0 && !doLote) {
      throw new ApiError('CORE_EMPTY_LABELS', 'Selecione ao menos uma plaquinha.', 400);
    }
    const plaquinhas = doLote
      ? plaquinhasDoLote(companyId, doLote)
      : plaquinhasPorId(companyId, ids);
    if (plaquinhas.length === 0) {
      throw new ApiError('CORE_TAG_NOT_FOUND', 'Nenhuma das plaquinhas foi encontrada.', 404);
    }
    /*
      Id que não voltou não some calado: quem pediu trinta e recebeu vinte
      precisa saber quais ficaram de fora — e antes eram justamente as que
      travariam o lote.
    */
    const naoAchados = doLote ? [] : ids.filter((id) => !plaquinhas.some((t) => t.id === id));

    const folha = renderEquipmentTagSheet({
      companyId,
      format: formato,
      layout,
      items: plaquinhas.map((t) => ({
        publicIdLabel: formatTagId(t.public_id),
        brand: null,
        model: null,
        // O endereço sai da CONFIGURAÇÃO, nunca do host de quem imprimiu: o
        // adesivo fica colado por anos.
        qrUrl: `${publicBaseUrl()}/equipamento/${t.public_token}`,
      })),
    });
    marcarImpressas(companyId, plaquinhas.map((t) => t.id));

    res.json({
      ...folha,
      plaquinhas: plaquinhas.length,
      naoAchados,
      baseUrl: publicBaseUrl(),
      baseUrlConfigurada: publicBaseUrlConfigurada(),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/equipment-tags/release', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'estoquista');
    const { companyId, userId } = scope(req);
    const resultado = liberarPlaquinhas({
      companyId,
      userId,
      ids: Array.isArray(req.body?.tagIds) ? req.body.tagIds : undefined,
      batchId: req.body?.batchId ? String(req.body.batchId) : undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.tags.release',
      entityType: 'equipment_tag',
      entityId: String(req.body?.batchId ?? 'selecao'),
      detail: resultado,
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/equipment-tags/:id/damage', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista');
    const { companyId, userId } = scope(req);
    const tag = marcarDanificada({
      companyId,
      userId,
      tagId: String(req.params.id),
      motivo: req.body?.motivo,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.tags.damage',
      entityType: 'equipment_tag',
      entityId: tag.id,
      detail: { publicId: tag.public_id, motivo: tag.damaged_reason },
    });
    res.json(semCredencial(tag));
  } catch (err) {
    next(err);
  }
});

/**
 * Trocar o adesivo de uma máquina.
 *
 * O sistema anterior não tinha isto, e a plaquinha danificada era um beco: o
 * adesivo descascava no sol e a moto ficava sem identificação para sempre.
 */
coreRouter.post('/equipment-tags/:id/replace', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'mecanico');
    const { companyId, userId } = scope(req);
    const resultado = substituirPlaquinha({
      companyId,
      userId,
      equipmentId: String(req.body?.equipmentId ?? ''),
      novaTagId: String(req.params.id),
      motivo: req.body?.motivo,
    });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.tags.replace',
      entityType: 'equipment',
      entityId: String(req.body?.equipmentId ?? ''),
      detail: resultado,
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/equipment-tags/layout', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'estoquista');
    const { companyId } = scope(req);
    res.json({ layout: layoutDaEmpresa(companyId), usaPlaquinha: empresaUsaPlaquinha(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/equipment-tags/layout', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja');
    const { companyId, userId } = scope(req);
    const layout = salvarLayout({ companyId, userId, entrada: req.body ?? {} });
    recordAudit({
      companyId,
      userId,
      action: 'equipment.tags.layout',
      entityType: 'equipment_tag_layout',
      entityId: companyId,
      detail: { widthMm: layout.widthMm, heightMm: layout.heightMm },
    });
    res.json({ layout });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- entrada por XML de NF-e
//
// Duas etapas: importar (lê e guarda para conferência, sem tocar no estoque)
// e confirmar (aplica a entrada). A chave da NF-e é única por empresa, então
// reimportar o mesmo arquivo não duplica entrada nem contas a pagar.

coreRouter.get('/purchases/notes', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    /*
      A 201ª NOTA NÃO SOME MAIS (GAP-PRD-164): a lista parava em 200 sem
      offset nem contagem. Página, total, busca e a nota do link (`?id=`).
    */
    const { companyId } = scope(req);
    const recorte = {
      id: req.query.id ? String(req.query.id) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
    };
    const pagina = lerPagina(req.query, 200);
    res.json({
      items: listNotes(companyId, { ...recorte, ...pagina }),
      total: countNotes(companyId, recorte),
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

/** Lê o XML sem gravar nada — usado para mostrar o preview antes de decidir. */
coreRouter.post('/purchases/nfe/preview', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId } = scope(req);
    const parsed = parseNfeXml(String(req.body?.xml ?? ''));
    // A prévia já diz que a nota de homologação não entra na produção (R3-DFE).
    exigirNotaComValidadeFiscal(companyId, parsed.environment);
    // E que a nota de OUTRA empresa do grupo não entra nesta (B-estoque-entrada-02).
    exigirNotaDestaEmpresa(companyId, parsed.recipient);
    // O de-para do fornecedor JÁ cadastrado vale na prévia também — sem criar
    // o fornecedor só porque alguém abriu o arquivo (GAP-PRD-015).
    const fornecedor = fornecedorPeloDocumento(companyId, parsed.supplierDocument);
    res.json({ ...parsed, items: matchItems(companyId, parsed.items, fornecedor) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/nfe/import', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    const result = importNfe({
      companyId,
      userId,
      xml: String(req.body?.xml ?? ''),
      // O mesmo XML de uma nota ESTORNADA, numa conferência nova — só com o
      // pedido explícito da tela (B-estoque-entrada-08).
      reabrirEstornada: req.body?.reabrirEstornada === true,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.nfe.import',
      entityType: 'inbound_note',
      entityId: result.noteId,
      detail: {
        accessKey: result.accessKey,
        duplicated: result.duplicated,
        ...(result.reabriuEstornada ? { reabriuEstornada: result.reabriuEstornada } : {}),
      },
    });
    res.status(result.duplicated ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

/*
  ------------------------------- CT-e (rodada 44) --------------------------

  O documento do TRANSPORTE. Mesmo alcance da entrada de notas: quem recebe
  mercadoria na doca é quem recebe o conhecimento do frete.
*/
coreRouter.get('/purchases/cte', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'gerente_loja',
      'gerente_oficina',
      'estoquista',
      'operador_caixa_oficina',
    );
    const { companyId } = scope(req);
    res.json({ items: listCtes(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/cte/import', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'gerente_loja',
      'gerente_oficina',
      'estoquista',
      'operador_caixa_oficina',
    );
    const { companyId, userId } = scope(req);
    const resultado = importCte({ companyId, userId, xml: String(req.body?.xml ?? '') });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.cte.import',
      entityType: 'cte',
      entityId: resultado.cteId,
      detail: { accessKey: resultado.accessKey, duplicated: resultado.duplicated },
    });
    res.status(resultado.duplicated ? 200 : 201).json(resultado);
  } catch (err) {
    next(err);
  }
});
/*
  ------------------------- Distribuição DF-e (rodada 44) -------------------

  A fonte OFICIAL das notas do fornecedor: a SEFAZ entrega o que foi emitido
  contra o CNPJ do grupo. Consultar e listar é trabalho da doca (gerentes e
  estoquista); MANIFESTAR é ato fiscal com efeito jurídico — só gerência.
*/
coreRouter.get('/purchases/dfe', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    /*
      O PLANO VIAJA COM A LISTA (GAP-PRD-168): para onde "Buscar agora" e a
      manifestação vão (SEFAZ e em qual ambiente, ou por que não) e se a senha
      do A1 vai ser pedida — a mesma decisão que o ato executa. A doca inteira
      (estoquista incluído) precisa ler isto antes do botão; o plano dos atos
      sobre nota (`/fiscal/acts/plan`) é de gerência. Falhar ao planejar não
      derruba a lista: a recusa, se houver, vem do ato com o motivo.
    */
    let plano: ReturnType<typeof planejarAtoFiscal> | null = null;
    try {
      plano = planejarAtoFiscal({ companyId });
    } catch {
      plano = null;
    }
    /*
      O AMBIENTE (DFE-AMBIENTE): a lista é do ambiente fiscal atual, e o
      número do outro vai junto para a tela dizer por que eles não aparecem.
    */
    res.json({
      items: listarDfe(companyId),
      plano,
      ambiente: ambienteDaDistribuicao(companyId),
      outroAmbiente: documentosDeOutroAmbiente(companyId),
      // A espera que a SEFAZ impôs (em dia, ou 656): o botão diz a hora (R3-DFE).
      distribuicao: estadoDaDistribuicao(companyId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/dfe/consultar', (req: AuthedRequest, res, next) => {
  (async () => {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    res.json(await consultarDistribuicao({ companyId, userId, adapter: fiscalAdapter(req) }));
  })().catch(next);
});

coreRouter.post('/purchases/dfe/:chave/manifestar', (req: AuthedRequest, res, next) => {
  (async () => {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const resultado = await manifestarDfe({
      companyId,
      userId,
      accessKey: String(req.params.chave),
      tipo: String(req.body?.tipo ?? '') as TipoManifestacao,
      justification: req.body?.justification,
      adapter: fiscalAdapter(req),
    });
    // A auditoria mora no SERVIÇO ('dfe.manifest', com protocolo e cStat):
    // auditar de novo aqui gerava DUAS linhas por clique, com nomes
    // diferentes — quem filtrasse por um deles contaria metade ou o dobro.
    res.json(resultado);
  })().catch(next);
});

coreRouter.post('/purchases/dfe/:chave/importar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const resultado = importarDfe({ companyId, userId, accessKey: String(req.params.chave) });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.dfe.import',
      entityType: 'inbound_note',
      entityId: resultado.noteId,
      detail: { accessKey: String(req.params.chave), duplicated: resultado.duplicated },
    });
    res.status(resultado.duplicated ? 200 : 201).json(resultado);
  } catch (err) {
    next(err);
  }
});
/**
 * O XML da nota de COMPRA, como o fornecedor o enviou.
 *
 * Mesmo alcance da lista de notas — quem confere mercadoria na doca é quem
 * precisa do arquivo, e a tela de Entrada de Notas é a mesma. Estreitar o
 * guarda aqui deixaria o botão visível e morto para o estoquista.
 *
 * MAIS o `contador`, e ele é o único aqui que NÃO alcança a tela de Entrada de
 * Notas. Não é incoerência: o XML da compra é peça de escrituração — é por ele
 * que a entrada de mercadoria é lançada —, e ele já viaja dentro do pacote
 * mensal que o contador baixa. O que esta rota lhe dá é o arquivo AVULSO, para
 * a nota que chegou depois do fechamento ou que ele precisa reimportar sozinha,
 * sem pedir o mês inteiro de novo.
 *
 * Como ele chega até um `:id` sem a tela que lista notas: a prévia do
 * fechamento (`/fiscal/closings/:period/previa`), que ele alcança, é quem
 * enumera as notas recebidas do período. O botão dele nasce LÁ, na tela de
 * fechamento — não aqui. Abrir esta rota sem esse caminho seria dar uma chave
 * para uma porta que ele não sabe onde fica.
 *
 * O que ele NÃO ganha junto: `/purchases/notes` (a lista), `/items`, `/link` e
 * as demais da entrada de nota continuam sem ele, e a varredura de rotas cobra
 * isso uma a uma. Ler o XML de uma nota é escriturar; conferir e vincular
 * mercadoria é operar o estoque, e não é trabalho dele.
 *
 * DOIS "não existe" DIFERENTES, com códigos diferentes, porque a tela precisa
 * dizer coisas diferentes:
 *
 *   - a nota não existe (ou é de outra operação) → some da lista, é erro de
 *     navegação;
 *   - a nota existe e o arquivo nunca foi guardado → é a nota importada antes
 *     da rodada 27, e a frase certa é "o XML desta nota não foi guardado", não
 *     "nota não encontrada", que mandaria alguém procurar um defeito que não
 *     existe.
 *
 * `Content-Disposition` com o nome montado a partir da CHAVE DE ACESSO, que é
 * de 44 dígitos por definição — e mesmo assim ela passa por um filtro antes de
 * entrar no cabeçalho: chave vem de arquivo de terceiro, e cabeçalho montado
 * com texto não validado é injeção de cabeçalho.
 */
coreRouter.get('/purchases/notes/:id/xml', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina', 'contador');
    const { companyId } = scope(req);
    const nota = getNoteXml(companyId, String(req.params.id));
    if (!nota) {
      throw new ApiError('CORE_INBOUND_NOTE_NOT_FOUND', 'Nota de entrada não encontrada.', 404);
    }
    /*
      A COMPRA DIGITADA NUNCA TEVE ARQUIVO (GAP-PRD-204).

      A frase da nota antiga ("entrou antes de o sistema passar a guardar") é
      verdade para o XML que foi lido e descartado — e mentira para a entrada
      manual, que nasce sem XML de propósito. Aplicada a ela, mandava o
      contador procurar um arquivo que nunca existiu. Código próprio, para que
      qualquer cliente distinga as duas ausências sem ler a frase.
    */
    if (!nota.xmlOriginal && nota.docType === 'manual') {
      throw new ApiError(
        'CORE_INBOUND_NOTE_MANUAL_SEM_XML',
        'Esta entrada foi lançada manualmente, sem nota fiscal do fornecedor: não existe XML '
          + 'para baixar. No fechamento do contador ela conta em "Compras sem NF-e".',
        404,
      );
    }
    if (!nota.xmlOriginal) {
      throw new ApiError(
        'CORE_INBOUND_NOTE_XML_AUSENTE',
        'O XML desta nota não foi guardado. Ela entrou antes de o sistema passar a guardar '
          + 'o arquivo do fornecedor, e não há como recuperá-lo.',
        404,
      );
    }
    const chave = nota.accessKey.replace(/[^0-9A-Za-z]/g, '').slice(0, 44) || 'nota';
    res.type('application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${chave}-nfe.xml"`);
    res.send(nota.xmlOriginal);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/purchases/notes/:id/items', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId } = scope(req);
    res.json({ items: listNoteItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/notes/:id/link', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    /*
      `productId: null` DESFAZ o vínculo (GAP-PRD-015) — o item volta para "sem
      produto" enquanto a nota está em conferência. Ausente ou vazio é pedido
      mal formado, e não "o produto de id 'undefined'", que era o que o
      `String(...)` fabricava.
    */
    const bruto = req.body?.productId;
    if (bruto !== null && (typeof bruto !== 'string' || !bruto.trim())) {
      throw new ApiError(
        'CORE_LINK_PRODUCT_REQUIRED',
        'Informe o produto do catálogo — ou null para desfazer o vínculo.',
        400,
      );
    }
    const productId = bruto === null ? null : String(bruto).trim();
    const resultado = linkNoteItem({
      companyId,
      noteId: String(req.params.id),
      itemIndex: Number(req.body?.itemIndex),
      productId,
      userId,
      lembrar: req.body?.lembrar !== false,
    });
    // A decisão HUMANA de casar item com produto entra na trilha central
    // (GAP-V19): um vínculo errado faz o saldo subir no produto errado, e
    // "quem vinculou" era pergunta sem resposta. O ANTES vai junto: trocar de
    // produto sem guardar o anterior apagaria metade da história.
    recordAudit({
      companyId,
      userId,
      action: resultado.desvinculado ? 'purchase.note.item_desvinculado' : 'purchase.note.item_vinculado',
      entityType: 'inbound_note',
      entityId: String(req.params.id),
      detail: {
        itemIndex: Number(req.body?.itemIndex),
        productId,
        anterior: resultado.anterior,
        lembrado: resultado.lembrado,
      },
    });
    res.json({ items: listNoteItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Registra o que o conferente contou.
 *
 * Quem confere é quem está na doca: os mesmos perfis que vinculam item.
 */
coreRouter.post('/purchases/notes/:id/conferir', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(
      req,
      'gerente_loja',
      'gerente_oficina',
      'estoquista',
      'operador_caixa_oficina',
    );
    const { companyId, userId } = scope(req);
    conferirItem({
      companyId,
      noteId: String(req.params.id),
      itemIndex: Number(req.body?.itemIndex),
      // AUSENTE é "não mexi na quantidade" (B-estoque-entrada-18): o blur do
      // fator gravava "chegou tudo" em item que ninguém contou.
      receivedQuantity:
        req.body?.receivedQuantity === undefined
        || req.body?.receivedQuantity === null
        || req.body?.receivedQuantity === ''
          ? undefined
          : Number(req.body.receivedQuantity),
      divergenceNote: req.body?.divergenceNote,
      // Quantas unidades do cadastro vêm em uma da nota. Só é preciso quando
      // nem a nota resolve — o fornecedor que fatura e tributa em CX.
      conversionFactor:
        req.body?.conversionFactor === undefined || req.body?.conversionFactor === null
          ? null
          : Number(req.body.conversionFactor),
    });
    /*
      A CONTAGEM DA DOCA GANHA AUTOR NA TRILHA CENTRAL (GAP-V19).

      A nota só guarda `received_by` na CONFIRMAÇÃO — quem contou 8 do
      faturado 10 três dias antes não aparecia em lugar nenhum. É exatamente
      a pergunta de quando a divergência vira conversa com o fornecedor.
    */
    recordAudit({
      companyId,
      userId,
      action: 'purchase.note.conferida',
      entityType: 'inbound_note',
      entityId: String(req.params.id),
      detail: {
        itemIndex: Number(req.body?.itemIndex),
        receivedQuantity: Number(req.body?.receivedQuantity),
        ...(req.body?.divergenceNote ? { divergenceNote: String(req.body.divergenceNote) } : {}),
        ...(req.body?.conversionFactor !== undefined && req.body?.conversionFactor !== null
          ? { conversionFactor: Number(req.body.conversionFactor) }
          : {}),
      },
    });
    res.json({ items: listNoteItems(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/notes/:id/confirm', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'operador_caixa_oficina');
    const { companyId, userId } = scope(req);
    const result = confirmNfe({
      companyId,
      noteId: String(req.params.id),
      userId,
      createMissing: Boolean(req.body?.createMissing),
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.nfe.confirm',
      entityType: 'inbound_note',
      entityId: result.noteId,
      detail: { created: result.createdProducts, moved: result.movedItems },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Entrada manual — a compra SEM nota fiscal (GAP-V17).
 *
 * Cria um documento de espécie própria (doc_type 'manual', que NUNCA finge
 * ser NF-e) e o despeja no MESMO funil conferir → confirmar acima: estoque,
 * custo, prazo do fornecedor e conciliação com pedido são os músculos já
 * provados da entrada por XML.
 *
 * O alcance é MAIS ESTREITO que o da importação de XML, e é decisão: importar
 * um arquivo assinado pelo fornecedor é transcrição; DIGITAR uma compra do
 * zero cria dívida a partir de teclado, e isso é da gestão do estoque
 * (gerentes e estoquista — quem a tela de Entrada de notas, ROTA_GESTAO,
 * alcança). Os operadores de caixa nem chegam à tela.
 */
coreRouter.post('/purchases/manual', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const result = createManualInboundNote({
      companyId,
      userId,
      supplierId: String(req.body?.supplierId ?? ''),
      documentNumber: req.body?.documentNumber ?? null,
      idempotencyKey: req.body?.idempotencyKey ?? null,
      items: Array.isArray(req.body?.items) ? req.body.items : [],
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.manual.create',
      entityType: 'inbound_note',
      entityId: result.noteId,
      detail: {
        supplierId: String(req.body?.supplierId ?? ''),
        totalCents: result.totalCents,
        duplicated: result.duplicated,
      },
    });
    res.status(result.duplicated ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Estorno da entrada CONFIRMADA (GAP-V20) — o espelho do confirm acima.
 *
 * Reverte os movimentos com lançamento CONTRÁRIO no razão (nunca apaga),
 * cancela a dívida aberta (se baixada, recusa mandando estornar a baixa
 * primeiro) e desfaz o retrato do pedido amarrado — tudo numa transação.
 *
 * SÓ GERÊNCIA, mais estreito que confirmar: desfazer uma entrada confirmada
 * reescreve estoque E financeiro de uma vez — é a mesma alçada do estorno de
 * baixa (/finance/settlements/:id/reverse) e do cancelamento fiscal. A tela
 * de Entrada de notas esconde o botão de quem não pode.
 */
coreRouter.post('/purchases/notes/:id/estornar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const result = estornarNota({
      companyId,
      noteId: String(req.params.id),
      userId,
      reason: String(req.body?.reason ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.note.estorno',
      entityType: 'inbound_note',
      entityId: result.noteId,
      detail: {
        reason: String(req.body?.reason ?? ''),
        reversedMovements: result.reversedMovements,
        financeCancelled: result.financeCancelled,
        alreadyReversed: result.alreadyReversed,
      },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ devolução ao fornecedor
//
// GAP-PRD-089. O estorno desfaz a nota inteira; a devolução desfaz PARTE de uma
// compra que continua valendo. As leituras têm o alcance de quem recebe
// mercadoria (gerentes e estoquista, como o pedido de compra); registrar e
// resolver o fiscal é da gerência, como o estorno — mexe em estoque E dívida.

/** O que dá para devolver desta nota, hoje — por produto, com o limite. */
coreRouter.get('/purchases/notes/:id/devolviveis', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(itensDevolviveis(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/purchases/supplier-returns', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      items: listarDevolucoes(companyId, {
        noteId: req.query.noteId ? String(req.query.noteId) : undefined,
        fiscalStatus: req.query.fiscalStatus ? String(req.query.fiscalStatus) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/purchases/supplier-returns/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(getDevolucao(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/supplier-returns', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const devolucao = registrarDevolucao({
      companyId,
      userId,
      noteId: String(body.noteId ?? ''),
      reason: String(body.reason ?? ''),
      items: Array.isArray(body.items) ? body.items : [],
      financeMode: String(body.financeMode ?? '') as 'abatimento' | 'credito' | 'sem_financeiro',
      creditCents:
        body.creditCents === undefined || body.creditCents === null || body.creditCents === ''
          ? null
          : Number(body.creditCents),
      dueDate: body.dueDate ? String(body.dueDate) : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.supplier_return.created',
      entityType: 'supplier_return',
      entityId: devolucao.id,
      detail: {
        noteId: devolucao.noteId,
        number: devolucao.number,
        goodsCents: devolucao.goodsCents,
        creditCents: devolucao.creditCents,
        financeMode: devolucao.financeMode,
        items: devolucao.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      },
    });
    res.status(201).json(devolucao);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------- nota recebida sem conta a pagar
//
// GAP-PRD-088. As notas confirmadas antes de o financeiro nascer junto (a NF
// 9991) ficaram sem título, e o código não fabrica dívida retroativa. A lista e
// os três gestos são da GERÊNCIA — é decisão sobre dinheiro, do mesmo tamanho
// do estorno.

coreRouter.get('/purchases/notas-sem-conta', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: notasRecebidasSemConta(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchases/notes/:id/conta-a-pagar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const resultado = decidirContaDaNota({
      companyId,
      userId,
      noteId: String(req.params.id),
      acao: String(body.acao ?? '') as 'lancar' | 'ja_paga' | 'sem_divida',
      dueDate: body.dueDate ? String(body.dueDate) : null,
      paidOn: body.paidOn ? String(body.paidOn) : null,
      method: body.method ? String(body.method) : null,
      reason: body.reason ? String(body.reason) : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.note.finance_decision',
      entityType: 'inbound_note',
      entityId: resultado.noteId,
      detail: {
        acao: resultado.acao,
        entryId: resultado.entryId,
        reason: body.reason ? String(body.reason) : null,
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/** O gancho fiscal: a chave da NF-e de devolução, a nota do fornecedor ou a dispensa. */
coreRouter.post('/purchases/supplier-returns/:id/fiscal', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const body = req.body ?? {};
    const devolucao = registrarSituacaoFiscal({
      companyId,
      userId,
      id: String(req.params.id),
      status: String(body.status ?? '') as 'emitida' | 'nota_do_fornecedor' | 'dispensada',
      accessKey: body.accessKey ? String(body.accessKey) : null,
      note: body.note ? String(body.note) : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase.supplier_return.fiscal',
      entityType: 'supplier_return',
      entityId: devolucao.id,
      detail: { status: devolucao.fiscalStatus, accessKey: devolucao.fiscalAccessKey },
    });
    res.json(devolucao);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- pedidos online / OMS

coreRouter.get('/orders', (req: AuthedRequest, res, next) => {
  try {
    /*
      Pedidos da loja online, com endereço e valor do comprador. Uma tela só
      (Pedidos, ROTA_GESTAO). O cliente vê os DELE pelo portal, que tem sessão e
      rotas próprias.
    */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    // Página e total (GAP-PRD-070): o 201º pedido sumia sem aviso.
    const situacao = req.query.status as string | undefined;
    const pagina = lerPagina(req.query, 200);
    res.json({
      // Com o link da transportadora montado AQUI (GAP-PRD-119): a tela não
      // mantém uma segunda tabela de sites de rastreio.
      items: comLinkDeRastreio(listStoreOrders(companyId, situacao, pagina)),
      total: countStoreOrders(companyId, situacao),
      ...pagina,
      /*
        O VOCABULÁRIO VAI JUNTO — e é por isso que a tela deixou de ter o dele.

        A tela mantinha a própria lista de etapas, fixa em `embalado →
        expedido`, e a própria tabela de rótulos. Como o padrão de toda loja do
        grupo é RETIRADA, todo pedido online caía num beco: a tela oferecia
        "Expedido", o servidor recusava com 409, e o pedido ficava parado em
        "Embalado" com a mercadoria no balcão.

        Mandar as listas com a lista de pedidos custa alguns bytes e apaga a
        segunda cópia. Estado novo passa a nascer com rótulo.
      */
      vocabulario: {
        entrega: ETAPAS_DA_ENTREGA,
        retirada: ETAPAS_DA_RETIRADA,
        rotulos: ORDER_STATUS_LABEL,
      },
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/orders/:id', (req: AuthedRequest, res, next) => {
  try {
    /**
     * O pedido aberto — com os títulos que ele gerou. Mesmo alcance da lista.
     *
     * O RECORTE POR EMPRESA MUDOU DE LUGAR, e não de rigor: a leitura pedia o
     * pedido de qualquer empresa e comparava `company_id` AQUI. Com o bloco
     * financeiro pendurado na resposta (V04-FIN-016), a consulta dos títulos
     * precisa de um `companyId` — e o único aceitável é o do token. Passá-lo ao
     * serviço faz o pedido do vizinho voltar `null` na origem, antes de
     * qualquer leitura de dinheiro; a resposta ao cliente é o MESMO 404 de
     * antes, que cobre o id inexistente e o pedido de outra empresa com a mesma
     * frase — dizer "existe, mas não é sua" já entrega que existe.
     */
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    const order = getStoreOrderDetail(String(req.params.id), companyId);
    if (!order) {
      throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    }
    // Os pedidos de devolução que a cliente abriu no portal (GAP-PRD-125).
    res.json({ ...order, returnRequests: listarSolicitacoes(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Dá para faturar este pedido? Perguntado antes de mostrar o botão.
 *
 * Por pedido, e não pela operação: pendência de catálogo não pode esconder o
 * faturamento de um pedido completo, e operação em ordem não autoriza faturar
 * pedido cujo cliente não tem endereço fiscal.
 *
 * As três rotas de faturamento do pedido online concediam também a um perfil
 * `'financeiro'`. Ele não existe em `ASSIGNABLE_PROFILES`, e `TeamService`
 * recusa qualquer código fora daquela lista — ninguém jamais pôde recebê-lo.
 * A concessão dizia "o financeiro fatura o pedido"; na prática só o gerente
 * faturava, e ler o código sugeria o contrário.
 *
 * Se o papel de financeiro precisar existir de verdade, ele nasce na rodada da
 * matriz de permissões, com linha no banco e lugar no ambiente — não como uma
 * string solta numa guarda.
 */
coreRouter.get('/orders/:id/nfe/readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId } = scope(req);
    res.json(orderInvoiceReadiness(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Emite a NF-e do pedido online.
 *
 * A nota REFERENCIA o pedido; não cria venda, não baixa estoque e não lança
 * receita. Esses fatos já aconteceram no checkout e no pagamento — repeti-los
 * produziria estoque negativo e faturamento em dobro.
 */
coreRouter.post('/orders/:id/nfe', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja');
      const { companyId, userId } = scope(req);
      const dev = req.body?.developmentMode === true && loadEnv().DEVORA_API_ENV !== 'production';

      const resultado = await emitNfeForOrder({
        companyId,
        orderId: String(req.params.id),
        userId,
        certificatePassword: req.body?.certificatePassword,
        developmentMode: dev,
      });
      recordAudit({
        companyId,
        userId,
        action: 'order.emit_nfe',
        entityType: 'order',
        entityId: String(req.params.id),
      });
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * Corrige o município do endereço da nota do pedido (R3-IBGE, GAP-PRD-028).
 *
 * O pedido fechado antes da tabela oficial do IBGE guarda no retrato o código
 * que o cliente digitou; a prontidão o aponta e a emissão recusa sem numerar.
 * Esta é a porta para sair disso: a gerência escolhe o município na lista, só
 * o município muda, e só quando o de hoje não confere e a nota ainda não
 * existe. Devolve a prontidão já recalculada — a tela troca o aviso pelo botão.
 */
coreRouter.post('/orders/:id/nfe/municipio', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const orderId = String(req.params.id);
    const correcao = corrigirMunicipioDaNotaDoPedido({
      companyId,
      orderId,
      cityIbge: req.body?.cityIbge,
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.nfe_municipio_corrigido',
      entityType: 'order',
      entityId: orderId,
      detail: {
        lado: correcao.lado,
        de: correcao.de,
        para: correcao.para.codigo,
        ufDe: correcao.ufDe,
        ufPara: correcao.para.uf,
      },
    });
    res.json(orderInvoiceReadiness(companyId, orderId));
  } catch (err) {
    next(err);
  }
});

/** Baixa manual autorizada (PIX conferido no extrato, dinheiro na retirada). */
coreRouter.post('/orders/:id/pay', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const order = markOrderPaid({
      companyId,
      orderId: String(req.params.id),
      userId,
      provider: 'manual',
      providerRef: req.body?.reference,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.pay_manual',
      entityType: 'order',
      entityId: order.id,
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * Cancelamento pelo ERP — e a cobrança morre junto (GAP-V72).
 *
 * O DEFEITO: este era um dos dois caminhos que cancelavam o pedido sem tocar no
 * provedor. `cancelOrderCharges` existia, era tolerante a falha por construção,
 * e só o portal do cliente a chamava. O gerente cancelava aqui, o estoque
 * voltava à vitrine, e o PIX/boleto continuava vivo no Asaas: o comprador ainda
 * podia pagar um pedido que não existe mais.
 *
 * A ordem é a mesma do portal: cancela lá fora ANTES de soltar a reserva aqui.
 * E falha do provedor não segura o cancelamento — o erro fica registrado na
 * intenção e a mercadoria não fica presa por causa de uma API de fora.
 */
coreRouter.post('/orders/:id/cancel', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'atendente');
      const { companyId, userId } = scope(req);
      const orderId = String(req.params.id);
      /*
        O MOTIVO É OBRIGATÓRIO NO ERP (GAP-PRD-124). Quem cancela do escritório
        age em nome do cliente ("desistiu por telefone", "produto acabou"), e o
        cliente não vê este botão: o motivo é a única explicação que o pedido
        cancelado vai ter na linha do tempo e na auditoria.
      */
      const motivo = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!motivo) {
        throw new ApiError(
          'CORE_ORDER_CANCEL_REASON',
          'Diga o motivo do cancelamento — ele fica na linha do tempo do pedido.',
          400,
        );
      }
      const antes = getConnection()
        .prepare('SELECT status FROM core_orders WHERE id = ? AND company_id = ?')
        .get(orderId, companyId) as { status: string } | undefined;
      await cancelOrderCharges({ companyId, orderId });
      const cancelado = cancelStoreOrder({ companyId, orderId, userId, reason: motivo });
      if (antes && antes.status !== 'cancelado') {
        recordAudit({
          companyId,
          userId,
          action: 'order.cancel',
          entityType: 'order',
          entityId: orderId,
          detail: { de: antes.status, motivo },
        });
      }
      res.json(cancelado);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * Devolução de pedido PAGO (rodada 42): estorno no provedor (melhor esforço),
 * estoque de volta pelo razão (idempotente), pedido reembolsado. Dinheiro
 * saindo é decisão de gerência — atendente não devolve.
 */
coreRouter.post('/orders/:id/devolver', async (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    // A mercadoria já está na mão? Omitido, o servidor decide pela etapa: sim
    // enquanto ela nunca saiu da loja, não para expedido e entregue
    // (GAP-PRD-122).
    const naMao = req.body?.mercadoriaNaMao;
    const r = await refundOrder({
      companyId,
      orderId: String(req.params.id),
      reason: String(req.body?.reason ?? ''),
      userId,
      mercadoriaNaMao: typeof naMao === 'boolean' ? naMao : undefined,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.refund',
      entityType: 'ecommerce_order',
      entityId: String(req.params.id),
      detail: {
        reason: req.body?.reason,
        providerRefund: r.providerRefund,
        dinheiro: r.dinheiro,
        mercadoria: r.mercadoria,
      },
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/**
 * O recebimento da mercadoria devolvida (GAP-PRD-122): só o que foi CONFERIDO
 * volta ao estoque, item a item. Quem recebe mercadoria é o estoque e a
 * gerência.
 */
coreRouter.post('/orders/:id/devolucao/receber', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'estoquista');
    const { companyId, userId } = scope(req);
    const r = receberMercadoriaDevolvida({
      companyId,
      orderId: String(req.params.id),
      userId,
      itens: (req.body?.itens ?? null) as { productId: string; quantidade: number }[] | null,
      nota: typeof req.body?.nota === 'string' ? req.body.nota : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.return_received',
      entityType: 'order',
      entityId: r.orderId,
      detail: {
        itens: r.itens.map((i) => ({
          productId: i.productId,
          doPedido: i.quantidadeDoPedido,
          voltou: i.voltouAoEstoque,
        })),
      },
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

/**
 * A loja decide o pedido de devolução que a cliente abriu no portal
 * (GAP-PRD-125). Recusar exige motivo, que a cliente lê. Aprovar não mexe em
 * dinheiro nem estoque: o reembolso é o "Devolver", que conclui a solicitação.
 */
coreRouter.post(
  '/orders/:id/devolucao/solicitacoes/:requestId/decidir',
  (req: AuthedRequest, res, next) => {
    try {
      requireProfile(req, 'gerente_loja', 'atendente');
      const { companyId, userId } = scope(req);
      const r = decidirSolicitacao({
        companyId,
        orderId: String(req.params.id),
        requestId: String(req.params.requestId),
        decisao: req.body?.decisao,
        nota: req.body?.nota,
        userId,
      });
      recordAudit({
        companyId,
        userId,
        action: 'order.return_request_decided',
        entityType: 'order',
        entityId: r.orderId,
        detail: { requestId: r.id, status: r.status, nota: r.decisionNote },
      });
      res.json(r);
    } catch (err) {
      next(err);
    }
  },
);

/** Etapas do OMS: separação, conferência, embalagem, expedição, entrega. */
coreRouter.post('/orders/:id/fulfillment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'estoquista', 'atendente');
    const { companyId, userId } = scope(req);
    // Expedir é DESPACHO (quem leva + código, ou o código da etiqueta do
    // provedor); entregar marca o envio com origem "operador" (GAP-PRD-119/120).
    const order = avancarEtapaDoPedido({
      companyId,
      orderId: String(req.params.id),
      toStatus: String(req.body?.status ?? ''),
      userId,
      trackingCode: req.body?.trackingCode,
      carrier: req.body?.carrier,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.fulfillment',
      entityType: 'order',
      entityId: order.id,
      detail: { status: order.status, carrier: req.body?.carrier ?? undefined },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * Desfazer UMA etapa (GAP-PRD-121). O avanço só aceita a próxima; voltar é
 * decisão de gerência, com motivo na linha do tempo e na auditoria.
 */
coreRouter.post('/orders/:id/fulfillment/voltar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const r = regressFulfillment({
      companyId,
      orderId: String(req.params.id),
      reason: req.body?.reason,
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'order.fulfillment_regress',
      entityType: 'order',
      entityId: r.order.id,
      detail: { de: r.de, para: r.para, motivo: r.motivo },
    });
    res.json(r.order);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ promoções

coreRouter.get('/promotions', (req: AuthedRequest, res, next) => {
  try {
    /*
      A régua das promoções, com as datas e os percentuais. Tela de Promoções,
      ROTA_GESTAO. O balcão não lê a régua: ele recebe o preço já promovido em
      `/products/:id`.
    */
    abertaAo(req, 'escritorio');
    ensureCoreSchema();
    const { companyId } = scope(req);
    // Com o nome e o código do produto, o que já saiu do estoque promocional
    // e os `problemas` da linha legada que a regra de hoje recusaria
    // (GAP-PRD-032/033/197/194) — ver `PromotionService.listarPromocoes`.
    res.json({ items: listarPromocoes(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/promotions', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    ensureCoreSchema();
    const { companyId, userId } = scope(req);
    /*
      A CONFERÊNCIA É DO SERVIDOR (GAP-PRD-032/033/197). Alvo desta empresa
      (id, código interno ou de barras) ou categoria que existe; um desconto
      que é desconto; grátis só confirmado; fim depois do início. As datas da
      tela ('2026-12-31') viram instante AQUI, com a ponta final valendo o dia
      inteiro da loja — ver `PromotionService`.
    */
    const r = criarPromocao({ companyId, userId, corpo: req.body ?? {} });
    recordAudit({
      companyId,
      userId,
      action: 'promotion.create',
      entityType: 'promotion',
      entityId: r.id,
      // O que MUDA O PREÇO entra na trilha: a pergunta "por que caiu na
      // quarta e não na quinta, às 18h e não às 21h" precisa de resposta.
      detail: {
        weekdays: r.promocao.weekdays,
        startsTime: r.promocao.starts_time,
        endsTime: r.promocao.ends_time,
        maxUnits: r.promocao.max_units,
        gratisConfirmado: r.promocao.free_confirmed === 1,
      },
    });
    res.status(201).json({ id: r.id, sobreposicoes: r.sobreposicoes });
  } catch (err) {
    next(err);
  }
});

/**
 * Edita uma promoção ativa (GAP-PRD-194) — em vez de encerrar e recriar.
 * A mesma conferência da criação, e a trilha guarda o antes e o depois.
 */
coreRouter.patch('/promotions/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    ensureCoreSchema();
    const { companyId, userId } = scope(req);
    const r = editarPromocao({
      companyId,
      userId,
      id: String(req.params.id),
      corpo: req.body ?? {},
    });
    if (Object.keys(r.mudancas).length > 0) {
      recordAudit({
        companyId,
        userId,
        action: 'promotion.update',
        entityType: 'promotion',
        entityId: r.id,
        detail: { mudancas: r.mudancas },
      });
    }
    res.json({ id: r.id, mudancas: r.mudancas, sobreposicoes: r.sobreposicoes });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/promotions/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    ensureCoreSchema();
    const { companyId } = scope(req);
    getConnection()
      .prepare('UPDATE core_promotions SET active = 0 WHERE id = ? AND company_id = ?')
      .run(String(req.params.id), companyId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------- cupons de desconto

/*
  CUPONS DA LOJA ONLINE (GAP-PRD-123). A mesma alçada das promoções: ler é do
  escritório (a tela de Cupons é ROTA_GESTAO), criar e encerrar é do
  gerente_loja. O código desconta só o pedido desta empresa no checkout — ver
  `CupomService`.
*/
coreRouter.get('/coupons', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'escritorio');
    const { companyId } = scope(req);
    res.json({ items: listarCupons(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/coupons', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const cupom = criarCupom({ companyId, userId, corpo: req.body ?? {} });
    recordAudit({
      companyId,
      userId,
      action: 'coupon.create',
      entityType: 'coupon',
      entityId: cupom.id,
      detail: {
        code: cupom.code,
        percentOff: cupom.percent_off,
        amountCents: cupom.amount_cents,
        minOrderCents: cupom.min_order_cents,
        maxUses: cupom.max_uses,
        maxUsesPerCustomer: cupom.max_uses_per_customer,
        cumulativo: cupom.accumulates_with_promotions === 1,
      },
    });
    res.status(201).json(cupom);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/coupons/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const r = encerrarCupom({ companyId, userId, id: String(req.params.id) });
    if (r.mudou) {
      recordAudit({
        companyId,
        userId,
        action: 'coupon.end',
        entityType: 'coupon',
        entityId: r.cupom.id,
        detail: { code: r.cupom.code },
      });
    }
    res.json(r.cupom);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------- status integrações

/**
 * Prontidão honesta dos provedores externos. Não diz "homologado" — diz
 * exatamente em que fronteira o módulo parou e o que falta.
 */
// ------------------------------------------------- sincronização com a central

/**
 * A FILA É DO NÓ; O GERENTE VÊ E AGE NA OPERAÇÃO DELE — GAP-PRD-136.
 *
 * `core_outbox` guarda os eventos de TODAS as empresas deste servidor, e estas
 * rotas operavam no nó inteiro: o gerente da loja A via as contagens, o tipo do
 * último evento e o texto do último erro da loja B, devolvia à fila os mortos
 * da B e disparava a carga inicial do histórico da B.
 *
 * Quem responde pelo NÓ é quem responde pelo grupo inteiro — vínculo de gestão
 * em todas as operações ativas (`respondePeloGrupo`, a mesma pergunta que
 * decide quem abre operação nova). Os demais ficam no recorte da operação da
 * sessão. O estado da credencial e do schema da central continua visível a
 * todos: é do servidor, não é dado de empresa, e é o que o gerente precisa
 * saber para chamar o dono.
 *
 * `POST /sync/run` continua do nó para quem a rota aceita: ele só antecipa o
 * ciclo de fundo, que envia a fila inteira a cada 15 segundos de qualquer
 * forma — não decide nada sobre evento de ninguém.
 */
function escopoDoSync(req: AuthedRequest): { doNo: boolean; recorte?: { companyId: string } } {
  const { companyId, userId } = scope(req);
  const doNo = respondePeloGrupo(userId);
  return doNo ? { doNo } : { doNo, recorte: { companyId } };
}

/**
 * Situação da fila de saída deste nó.
 *
 * O que interessa a quem opera é uma pergunta só: a central está em dia com
 * esta loja? Por isso a resposta mostra quanto falta enviar e desde quando —
 * um "pendente: 0" e um "pendente: 340 desde ontem" pedem ações diferentes.
 *
 * A credencial NUNCA sai por aqui: o que sai é se ela existe e, quando não
 * existe, o nome da variável que falta.
 *
 * `acoes` diz à tela quais botões oferecer, calculado pelas MESMAS regras que
 * recusam (GAP-PRD-136 e GAP-PRD-149): botão que o servidor fecha não aparece.
 */
coreRouter.get('/sync/status', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { doNo, recorte } = escopoDoSync(req);
    const perfis = req.auth?.profileCodes ?? [];
    const dono = perfis.includes('admin_geral') || perfis.includes('gestor');
    res.json({
      ...syncStatus(undefined, recorte),
      escopo: doNo ? 'no' : 'operacao',
      acoes: {
        cargaInicial: doNo,
        conferirSchema: dono || perfis.includes('gerente_loja'),
        reviver: dono || perfis.includes('gerente_loja'),
        sincronizar: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Empurra a fila agora, sem esperar o ciclo de fundo.
 *
 * Serve para o gerente que acabou de recuperar a internet e quer ver a fila
 * baixar na hora, em vez de confiar que "daqui a pouco sincroniza".
 */
coreRouter.post('/sync/run', async (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    res.json(await syncOnce());
  } catch (err) {
    next(err);
  }
});

/** Confere se a central já tem o schema aplicado. Toca a rede. */
coreRouter.post('/sync/probe', async (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    res.json(await probeCentralSchema());
  } catch (err) {
    next(err);
  }
});

/**
 * Carga inicial do histórico deste nó para a central.
 *
 * A operação é idempotente: os ids dos eventos são derivados do fato, então
 * repetir não duplica. É a razão de esta rota poder existir sem um travamento
 * elaborado.
 *
 * Ela sobe o histórico de TODAS as operações do servidor, com um checkpoint do
 * nó — não há "carga da minha loja". Por isso é de quem responde pelo nó
 * (GAP-PRD-136): o gerente da loja A não enfileira o histórico da loja B.
 */
coreRouter.post('/sync/bootstrap', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    if (!escopoDoSync(req).doNo) {
      throw new ApiError(
        'CORE_SYNC_NODE_SCOPE',
        'A carga inicial sobe o histórico de TODAS as operações deste servidor. Só quem '
          + 'responde pelo grupo inteiro (gestão em todas as operações) a dispara.',
        403,
      );
    }
    const resultado = bootstrapCentralFromLocal({ resume: req.body?.resume !== false });
    recordAudit({
      companyId,
      userId,
      action: 'sync.bootstrap',
      entityType: 'sync',
      entityId: 'central',
      detail: { enqueued: resultado.enqueued },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

/**
 * Devolve à fila os eventos que esgotaram as tentativas. Ação de gente.
 *
 * No recorte de quem pede (GAP-PRD-136): o gerente devolve os mortos da
 * operação dele; quem responde pelo nó, os do nó. E fica na trilha.
 */
coreRouter.post('/sync/revive', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const { doNo, recorte } = escopoDoSync(req);
    const revived = reviverMortos(recorte);
    recordAudit({
      companyId,
      userId,
      action: 'sync.revive',
      entityType: 'sync',
      entityId: 'central',
      detail: { revived, escopo: doNo ? 'no' : 'operacao' },
    });
    res.json({ revived });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/integrations/status', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    // O status do Asaas é DA OPERAÇÃO: cada uma tem conta e chave próprias.
    const { companyId } = scope(req);
    res.json({
      providers: [
        {
          ...getAsaasStatus({ companyId }),
          missing: 'API key sandbox desta operação e URL pública de webhook',
        },
        {
          provider: 'nfe',
          configured: false,
          environment: 'homologacao',
          readiness: 'READY_FOR_CERTIFICATE',
          missing: 'Certificado A1 (.pfx) + senha, CNPJ, IE, CRT, série',
        },
        {
          provider: 'nfce',
          configured: false,
          environment: 'homologacao',
          readiness: 'READY_FOR_CERTIFICATE',
          missing: 'CSC + CSC ID por operação, além do certificado A1',
        },
        // Dizia READY_FOR_CREDENTIAL, "Contrato, usuário e senha" — como se a
        // credencial bastasse. Não há cliente HTTP dos Correios (GAP-PRD-118):
        // os serviços deles chegam pelo Melhor Envio.
        {
          provider: 'correios',
          configured: false,
          environment: 'n/a',
          readiness: 'NOT_IMPLEMENTED',
          missing:
            'Sem integração direta: PAC e SEDEX são cotados, comprados e rastreados pelo Melhor Envio. '
            + 'Contrato direto com os Correios exigiria programação — a credencial sozinha não basta.',
        },
        // Era fixo ("Token sandbox e produção", nunca configurado). Sai do
        // mesmo estado que decide a cotação do checkout (GAP-PRD-127).
        melhorEnvioIntegrationStatus(companyId),
        {
          provider: 'tef',
          configured: false,
          environment: 'n/a',
          readiness: 'READY_FOR_HARDWARE',
          missing: 'SDK do provedor e PinPad físico',
        },
        {
          provider: 'impressao',
          configured: false,
          environment: 'n/a',
          readiness: 'READY_FOR_HARDWARE',
          missing: 'Modelo da impressora e agente local instalado',
        },
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- Asaas da operação
//
// Configuração de cobrança online é POR OPERAÇÃO. O `companyId` vem sempre do
// token: aceitar do corpo deixaria alguém gravar a chave de outra empresa —
// ou, pior, ler o estado da conta dela.
//
// A chave NUNCA volta pela API. O que volta é dica mascarada, origem e estado.

/** Painel da integração: o que está configurado, e o que falta para produção. */
coreRouter.get('/integrations/asaas', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId } = scope(req);
    res.json({
      status: getAsaasStatus({ companyId }),
      credentials: getAsaasCredentialStatus(companyId),
      state: getAsaasIntegrationState({ companyId }),
      envFallbackAllowed: asaasEnvFallbackAllowed(),
      webhook: describeAsaasWebhook(companyId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * O QUE CADA OPERAÇÃO DO GRUPO AINDA PRECISA PARA COBRAR (GAP-PRD-017).
 *
 * A tela do Asaas é por operação; esta leitura junta as do VÍNCULO da pessoa
 * (nunca "todas as empresas") e diz o que falta em cada uma — credencial,
 * cadastro no painel do Asaas, configuração do servidor ou ação na tela.
 * Nenhum segredo sai. `requireProfile(req)` sem extra: só os donos do grupo,
 * que respondem pelas seis contas.
 */
coreRouter.get('/integrations/asaas/grupo', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { userId } = scope(req);
    res.json(prontidaoAsaasDoGrupo(userId));
  } catch (err) {
    next(err);
  }
});

/**
 * Grava a chave no cofre.
 *
 * Trocar a credencial invalida o que já foi verificado com a anterior: a
 * conexão testada e a homologação eram DAQUELA chave. Manter os selos seria
 * dizer que a chave nova já foi testada.
 *
 * SÓ OS SELOS DAQUELE AMBIENTE (GAP-PRD-170). Guardar a chave de produção
 * derrubava também a conexão e a homologação do SANDBOX — que não tinham
 * mudado —, e o dono repetia a homologação a cada vai-e-vem. Agora a chave de
 * produção derruba o selo da produção, e a de sandbox os do sandbox.
 */
coreRouter.put('/integrations/asaas/credentials', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const environment = req.body?.environment === 'production' ? 'production' : 'sandbox';
    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (apiKey.length < 10) {
      throw new ApiError('CORE_ASAAS_KEY_INVALID', 'Informe a API key do Asaas.', 400);
    }

    upsertAsaasApiKey({ companyId, environment, apiKey });
    resetAsaasConnectionState({ companyId }, environment);

    recordAudit({
      companyId,
      userId,
      action: 'integrations.asaas.credential_saved',
      entityType: 'integration',
      entityId: 'asaas',
      // Só o ambiente. A chave não entra em auditoria nem mascarada.
      detail: { environment },
    });

    res.json({ credentials: getAsaasCredentialStatus(companyId) });
  } catch (err) {
    next(err);
  }
});

/** Token com que o Asaas se identifica ao chamar o webhook desta operação. */
/**
 * A HOMOLOGAÇÃO DO SANDBOX — a trava que o dono não tinha como abrir
 * (rodada 62).
 *
 * ## O defeito
 *
 * A tela lista as travas que impedem cobrar de verdade, e uma delas é "a
 * homologação em sandbox ainda não foi concluída". O dono cumpriu tudo que
 * dependia dele — chave sandbox, chave produção, conexão testada, pedido de
 * produção — e parou nessa, sem nenhum botão que a abrisse.
 *
 * O motor existia e roda dezesseis passos contra o sandbox. O que faltava era
 * o caminho: a rota antiga (`POST /integrations/:provider/homologate`) exige
 * a permissão `integrations.homologate`, e a matriz declara
 * `integrations: { ler: [], escrever: [] }` — nenhum perfil a tem. Código
 * correto, inalcançável por qualquer pessoa. A terceira vez que esta base
 * entrega motor sem porta.
 *
 * ## Por que uma rota nova, e não abrir a permissão da antiga
 *
 * Porque a antiga aceita `companyId` no CORPO (`resolveIntegrationCompanyId`),
 * e abrir a permissão a um perfil daria ao gerente de uma loja o poder de
 * homologar outra sabendo o id — e homologação carimba o estado que libera
 * cobrança real. Aqui a empresa vem do token, como em todo o resto do núcleo.
 */
coreRouter.post('/integrations/asaas/homologar', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja');
      const { companyId, userId } = scope(req);

      const resultado = await runAsaasSandboxHomologation({
        companyId,
        correlationId: req.correlationId,
      });

      recordAudit({
        companyId,
        userId,
        action: 'integrations.asaas.homologation_run',
        entityType: 'integration',
        entityId: 'asaas',
        // O resultado, não os dados de teste: a trilha responde "quem
        // homologou e quando", que é o que o contador pode perguntar. É a
        // ÚNICA trilha da corrida desde o GAP-PRD-075 — o id e a mensagem
        // moravam também em `integration_audit_entries`, sem leitor.
        detail: {
          status: resultado.status,
          homologationId: resultado.homologationId,
          mensagem: resultado.message,
        },
      });

      /*
        200 mesmo com `status: 'failed'`: a homologação RODOU, e o resultado é
        que ela não passou. Devolver erro faria a tela dizer "não foi possível
        homologar" e esconder QUAL dos dezesseis passos falhou — que é a única
        informação com a qual alguém conserta.
      */
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * "O AVISO DO ASAAS CHEGOU?" (GAP-PRD-169) — a prova do webhook externo.
 *
 * O passo final da homologação só fica verde quando um aviso do próprio Asaas
 * sobre as cobranças de teste chega por fora. Ele pode levar alguns segundos,
 * ou só chegar depois que o dono cadastrar a URL no painel: esta rota confere
 * de novo, sem rodar a homologação inteira.
 */
coreRouter.post('/integrations/asaas/homologar/conferir-aviso', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId } = scope(req);
    const passo = conferirAvisoExternoDaHomologacao({ companyId });
    res.json({
      step: passo,
      steps: (getAsaasIntegrationState({ companyId }).homologationSteps as unknown[] | undefined) ?? [],
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/integrations/asaas/webhook-token', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const webhookToken = String(req.body?.webhookToken ?? '').trim();
    if (webhookToken.length < 8) {
      throw new ApiError('CORE_ASAAS_TOKEN_INVALID', 'Informe o token do webhook.', 400);
    }

    upsertAsaasWebhookToken({ companyId, webhookToken });
    recordAudit({
      companyId,
      userId,
      action: 'integrations.asaas.webhook_token_saved',
      entityType: 'integration',
      entityId: 'asaas',
    });

    res.json({ credentials: getAsaasCredentialStatus(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/integrations/asaas/credentials/:environment', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const environment = req.params.environment === 'production' ? 'production' : 'sandbox';

    removeAsaasSecret(companyId, 'api_key', undefined, environment);
    resetAsaasConnectionState({ companyId }, environment);

    recordAudit({
      companyId,
      userId,
      action: 'integrations.asaas.credential_removed',
      entityType: 'integration',
      entityId: 'asaas',
      detail: { environment },
    });

    res.json({ credentials: getAsaasCredentialStatus(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Pedido de produção.
 *
 * Aqui só se registra a INTENÇÃO. Quem decide o ambiente efetivo é
 * `resolveAsaasEnvironment`, conferindo as cinco trancas — a resposta devolve
 * o que ainda falta, para a tela não prometer o que não vai acontecer.
 */
coreRouter.patch('/integrations/asaas', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const environment = req.body?.environment === 'production' ? 'production' : 'sandbox';

    upsertAsaasIntegrationState({ companyId }, { environment });
    recordAudit({
      companyId,
      userId,
      action: 'integrations.asaas.environment_requested',
      entityType: 'integration',
      entityId: 'asaas',
      detail: { environment },
    });

    res.json({
      status: getAsaasStatus({ companyId }),
      state: getAsaasIntegrationState({ companyId }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * TESTA AS CHAVES — cada uma no próprio ambiente (GAP-PRD-170).
 *
 * Testava o ambiente EFETIVO: sandbox enquanto a porta de produção estava
 * fechada. O selo que a porta exigia era satisfeito pela chave de sandbox, e a
 * chave de produção só era testada pela primeira cobrança real. Agora cada
 * chave configurada é testada no próprio ambiente (ou só a pedida em
 * `environment`), e cada ambiente ganha o próprio selo: `connectionVerified`
 * para o sandbox, `productionConnectionVerified` para a produção — que é o
 * que a tranca de produção lê.
 */
coreRouter.post('/integrations/asaas/test', async (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja');
    const { companyId, userId } = scope(req);
    const pedido = req.body?.environment;
    const credenciais = getAsaasCredentialStatus(companyId);
    const ambientes: ('sandbox' | 'production')[] =
      pedido === 'sandbox' || pedido === 'production'
        ? [pedido]
        : (['sandbox', 'production'] as const).filter((e) => credenciais[e].configured);
    if (ambientes.length === 0) ambientes.push('sandbox');

    const results = [];
    for (const ambiente of ambientes) {
      const r = await testAsaasCredential({ companyId }, ambiente);
      results.push(r);
      if (!r.tested) continue;
      const agora = new Date().toISOString();
      // O selo é consequência do teste, não um botão à parte: marcar
      // verificado sem ter verificado destrava produção de mentira.
      upsertAsaasIntegrationState(
        { companyId },
        ambiente === 'production'
          ? {
              productionConnectionVerified: r.ok,
              productionConnectionTestedAt: agora,
              productionConnectionError: r.ok ? null : r.detail,
            }
          : { connectionVerified: r.ok, lastConnectionTestAt: agora, lastConnectionError: r.ok ? null : r.detail },
      );
    }
    const testados = results.filter((r) => r.tested);
    const resultado = {
      ok: testados.length > 0 && testados.every((r) => r.ok) && results.every((r) => r.tested),
      detail: results
        .map((r) => `${r.environment === 'production' ? 'Produção' : 'Sandbox'}: ${r.detail}`)
        .join(' '),
      results,
    };
    recordAudit({
      companyId,
      userId,
      action: 'integrations.asaas.connection_tested',
      entityType: 'integration',
      entityId: 'asaas',
      detail: { ok: resultado.ok, results: results.map((r) => ({ environment: r.environment, tested: r.tested, ok: r.ok })) },
    });

    res.json({ ...resultado, status: getAsaasStatus({ companyId }) });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- auditoria

/**
 * A trilha, legível. `core_audit_log` tem 128 escritores; este é o leitor.
 *
 * ## Alcance: só quem responde pelo grupo — e o porquê, por extenso
 *
 * `requireProfile(req)` sem perfis nomeados deixa passar exatamente
 * `admin_geral` e `gestor`. A auditoria expõe as ações de TODO MUNDO,
 * inclusive as dos gerentes — desconto liberado, venda cancelada, preço
 * mexido. Abrir isso ao `gerente_loja` faria o vigiado ler o próprio diário de
 * vigilância: ele veria o rastro do que os colegas (e ele mesmo) fizeram, e
 * saberia o que o dono consegue ou não consegue ver. Quem investiga responde
 * pelo grupo; quem opera aparece na trilha. O 403 do gerente está provado em
 * `tests/auditoria-tem-leitor.test.ts`.
 *
 * ## Paginação no servidor
 *
 * 200 linhas fixas não são histórico, são amostra. `limit`/`offset`/`action`/
 * `q` filtram NO BANCO, e o `total` volta junto para a tela numerar páginas.
 * Nada aqui reescreve nada: a trilha é append-only e continua sendo.
 */
coreRouter.get('/audit', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId } = scope(req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const pagina = listAudit(companyId, {
      limit,
      offset,
      action: (req.query.action as string | undefined) || undefined,
      q: (req.query.q as string | undefined) || undefined,
    });
    res.json({
      ...pagina,
      // O seletor de ações da tela sai daqui: lista fixa no frontend
      // envelheceria a cada escritor novo.
      actions: listAuditActions(companyId),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- como a loja entrega
//
// Ligar entrega é decisão de dinheiro: antes desta tela existir, todo pedido
// online nascia como entrega com frete R$ 0,00 e a operação pagava o envio.
// Por isso o padrão é desligado, e ligar exige um valor.

coreRouter.get('/shipping-settings', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    const c = getShippingSettings(companyId);
    res.json({
      pickupEnabled: c.pickup_enabled === 1,
      deliveryEnabled: c.delivery_enabled === 1,
      flatRateCents: c.flat_rate_cents,
      freeAboveCents: c.free_above_cents,
      estimatedDays: c.estimated_days,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/shipping-settings', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const corpo = req.body ?? {};

    saveShippingSettings({
      companyId,
      pickupEnabled: corpo.pickupEnabled !== false,
      deliveryEnabled: corpo.deliveryEnabled === true,
      flatRateCents: corpo.flatRateCents ?? null,
      freeAboveCents: corpo.freeAboveCents ?? null,
      estimatedDays: corpo.estimatedDays ?? null,
    });

    recordAudit({
      companyId,
      userId,
      action: 'shipping.settings_update',
      entityType: 'shipping_settings',
      entityId: companyId,
      detail: {
        deliveryEnabled: corpo.deliveryEnabled === true,
        flatRateCents: corpo.flatRateCents ?? null,
      },
    });

    const c = getShippingSettings(companyId);
    res.json({
      pickupEnabled: c.pickup_enabled === 1,
      deliveryEnabled: c.delivery_enabled === 1,
      flatRateCents: c.flat_rate_cents,
      freeAboveCents: c.free_above_cents,
      estimatedDays: c.estimated_days,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- e-mail transacional
//
// A fila é visível de propósito: enquanto não houver SMTP, é aqui que o gestor
// confere o que SAIRIA. "Pronto para a credencial" só é verdade se der para
// olhar o conteúdo antes de ligar.

coreRouter.get('/emails', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    // O filtro da tela (GAP-PRD-038): "com falha" é a lista que se trabalha.
    const filtro = req.query.status === undefined ? undefined : String(req.query.status);
    if (filtro !== undefined && !EMAIL_QUEUE_STATUSES.includes(filtro as EmailQueueStatus)) {
      throw new ApiError(
        'EMAIL_FILTRO_INVALIDO',
        'Filtro de situação inválido: use pending, sent ou failed.',
        400,
      );
    }
    res.json({
      status: emailStatus(companyId),
      // O corpo sai sem o conteúdo protegido (GAP-PRD-007) — ver listEmailQueue.
      items: listEmailQueue(companyId, 50, filtro as EmailQueueStatus | undefined),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Devolve à fila uma mensagem que desistiu (GAP-PRD-038) — auditado.
 *
 * Só a mensagem da empresa do token; já entregue, ainda na fila ou sem
 * conteúdo para mandar (segredo vencido, anexo liberado) respondem 409 com o
 * que o gestor faz no lugar.
 */
coreRouter.post('/emails/:id/reenviar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const item = reenfileirarEmail({ companyId, id: String(req.params.id), userId });
    res.json({ item, status: emailStatus(companyId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Tenta entregar a fila — a DA EMPRESA DO TOKEN (GAP-PRD-198).
 *
 * Era a fila das seis: o clique do gerente da Preço Justo marcava `sent` a
 * mensagem da Gringa. O worker de fundo continua sendo o carteiro de todas.
 *
 * Sem credencial devolve `READY_FOR_CREDENTIAL` e não muda nada — não existe
 * modo "fingir que mandou".
 */
coreRouter.post('/emails/enviar', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId } = scope(req);
      // Desde a rodada 49 o flush ENTREGA de verdade (SMTP) — e por isso é
      // assíncrono. Sem credencial, a resposta continua a mesma de sempre.
      const r = await flushEmailQueue({ companyId });
      res.json({ ...r, status: emailStatus(companyId) });
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * Quem assina o e-mail desta empresa (GAP-PRD-198): a escolha gravada e a
 * prévia de como o cliente vê — com o `EMAIL_FROM` de agora.
 */
coreRouter.get('/emails/identidade', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(identidadeParaATela(companyId, remetenteDoAmbiente()));
  } catch (err) {
    next(err);
  }
});

/**
 * Grava a escolha — da empresa do TOKEN, nunca do corpo — auditada como
 * `email.identidade.update`. Padrão seguro: `grupo`, o comportamento de antes.
 */
coreRouter.put('/emails/identidade', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    salvarIdentidade({
      companyId,
      userId,
      entrada: {
        modo: req.body?.modo,
        nomeRemetente: req.body?.nomeRemetente,
        enderecoRemetente: req.body?.enderecoRemetente,
        responderPara: req.body?.responderPara,
        assinatura: req.body?.assinatura,
      },
    });
    res.json(identidadeParaATela(companyId, remetenteDoAmbiente()));
  } catch (err) {
    next(err);
  }
});

/**
 * O que falta para as comunicações desta empresa funcionarem (GAP-PRD-130):
 * SMTP, fila parada, remetente, destinatário e agenda do contador, usuário do
 * contador, caixa de NF-e. Só leitura, da empresa do token; mesmo alcance da
 * fila de e-mail.
 */
coreRouter.get('/comunicacoes/prontidao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    res.json(prontidaoDasComunicacoes(scope(req).companyId));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------- conciliação de recebimentos
//
// Compara o que o provedor confirmou com o que o financeiro registrou. NÃO
// corrige nada: relata para quem responde pelo caixa decidir.

coreRouter.get('/asaas/conciliacao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      ...reconcileAsaas({
        companyId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
      /*
        DE QUANDO É ESTA VERDADE (GAP-PRD-016). O relatório compara o que o
        ERP SABE do provedor; sem a última consulta ao provedor ao lado, a tela
        o apresentava como "provedor × financeiro" mesmo quando o webhook tinha
        parado de chegar há dias.
      */
      sincronizacao: {
        last: ultimaSincronizacao(companyId),
        pendingWithRef: contarCobrancasAConsultar(companyId),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PERGUNTAR AO PROVEDOR AGORA (GAP-PRD-016).
 *
 * Consulta `GET /payments/:id` das cobranças em aberto desta operação e aplica
 * o status que o provedor devolver pelo mesmo caminho do webhook. Mesmo
 * alcance da conciliação: é o botão da tela dela (gerência das duas
 * operações; o roteador do navegador só leva a gestão até ela).
 */
coreRouter.post('/asaas/conciliacao/sincronizar', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'gerente_oficina');
      const { companyId, userId } = scope(req);
      const passada = await sincronizarCobrancasComProvedor({ companyId, trigger: 'manual', userId });
      recordAudit({
        companyId,
        userId,
        action: 'asaas.sync',
        entityType: 'asaas_sync_run',
        entityId: passada.id,
        detail: {
          checked: passada.checked,
          changed: passada.changed,
          failed: passada.failed,
          skipped: passada.skipped,
          unconfigured: passada.unconfigured,
        },
      });
      res.json(passada);
    } catch (err) {
      next(err);
    }
  })();
});

/** A última passada e quantas cobranças esperam consulta. Leitura da tela. */
coreRouter.get('/asaas/conciliacao/sincronizacao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ last: ultimaSincronizacao(companyId), pendingWithRef: contarCobrancasAConsultar(companyId) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- convite e fila de chamados
//
// ## Os perfis aqui batem com quem CONSEGUE ABRIR A TELA
//
// O desenho original dava a emissão do convite ao `operador_caixa_oficina` e
// punha o botão na tela de Clientes. Mas Clientes é `ROTA_GESTAO` e os perfis
// de caixa vivem no ambiente `pdv`: o guarda do navegador os devolve antes de
// qualquer render. Seria permissão concedida a quem nunca chega ao botão — o
// mesmo defeito dos perfis `financeiro` e `tecnico` que a rodada 14 removeu.
//
// Quem entrega o papel é quem atende: na oficina de moto o mecânico É o balcão.
// Por isso a lista é a dos perfis que alcançam a tela da OS e a de clientes.

coreRouter.post('/customers/:id/convite-portal', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'mecanico', 'atendente');
    const { companyId, userId } = scope(req);
    const convite = emitirConvitePortal(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'customer.portal_invite',
      entityType: 'customer',
      entityId: String(req.params.id),
      // O CÓDIGO NÃO ENTRA NA AUDITORIA: é credencial, e a auditoria é lida por
      // mais gente do que quem o emitiu.
      detail: { expiresAt: convite.expiresAt },
    });
    res.status(201).json(convite);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/workshop/chamados', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'atendente');
    const { companyId } = scope(req);
    res.json({ items: listarChamadosDaOficina(companyId, resolveWorkshopScope(req)) });
  } catch (err) {
    next(err);
  }
});

/**
 * O aparelho chegou: o chamado vira OS.
 *
 * O mecânico CONVERTE. Ele já abre OS pelo mesmo quadro, e na bancada é ele
 * quem recebe a moto — deixá-lo de fora renderia um botão que sempre falha na
 * única tela onde a fila aparece.
 */
coreRouter.post('/workshop/chamados/:id/converter', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'atendente');
    const { companyId, userId } = scope(req);
    const r = converterChamado({
      companyId,
      requestId: String(req.params.id),
      userId,
      criarOrdem: (dados) =>
        createOrder({
          companyId,
          workshopId: dados.workshopId,
          userId,
          equipmentId: dados.equipmentId,
          customerId: dados.customerId,
          complaint: dados.complaint,
          // É AQUI que `opened_by_customer` ganha escritor. A coluna existia
          // desde a primeira versão da tabela e nenhuma rota a preenchia.
          openedByCustomer: true,
        }),
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.request.convert',
      entityType: 'service_request',
      entityId: String(req.params.id),
      detail: { orderId: r.orderId },
    });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/workshop/chamados/:id/encerrar', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'gerente_loja', 'mecanico', 'atendente');
    const { companyId, userId } = scope(req);
    encerrarChamado({
      companyId,
      requestId: String(req.params.id),
      userId,
      note: req.body?.note,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.request.close',
      entityType: 'service_request',
      entityId: String(req.params.id),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------- transportadoras
//
// Quem trouxe a mercadoria até a porta. Nasce sozinha na importação do XML,
// com nome e documento; cobrar uma avaria exige telefone e contato, e conferir
// crédito de ICMS sobre o frete exige a inscrição estadual.
//
// A leitura aceita estoquista — é quem confere na doca e precisa saber para
// quem ligar. A escrita é do gerente, como em fornecedor.

coreRouter.get('/carriers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      items: listCarriers(companyId, {
        search: req.query.search ? String(req.query.search) : undefined,
        includeInactive: req.query.includeInactive === '1',
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/carriers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    const carrier = loadCarrier(companyId, String(req.params.id));
    res.json({ carrier, history: carrierNoteHistory(companyId, carrier.id) });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/carriers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const c = createCarrier(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'carrier.create',
      entityType: 'carrier',
      entityId: c.id,
      detail: { name: c.name },
    });
    res.status(201).json({ carrier: c });
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/carriers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const c = updateCarrier(companyId, String(req.params.id), req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'carrier.update',
      entityType: 'carrier',
      entityId: c.id,
    });
    res.json({ carrier: c });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/carriers/:id/active', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const c = setCarrierActive(companyId, String(req.params.id), Boolean(req.body?.active));
    recordAudit({
      companyId,
      userId,
      action: 'carrier.active',
      entityType: 'carrier',
      entityId: c.id,
      detail: { active: c.active },
    });
    res.json({ carrier: c });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ configuração da entrada
//
// O CFOP com que a LOJA VENDE, gravado no produto que a entrada cria. Sem ele
// o produto herda o CFOP do fornecedor — 6102 de quem vende de outro estado —
// e o cupom de uma venda de balcão sai declarado como operação interestadual.

coreRouter.get('/inbound/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(getInboundConfig(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/inbound/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const cfg = setInboundConfig(companyId, { defaultSaleCfop: req.body?.defaultSaleCfop });
    recordAudit({
      companyId,
      userId,
      action: 'inbound.config.set',
      entityType: 'company',
      entityId: companyId,
      detail: { defaultSaleCfop: cfg.defaultSaleCfop },
    });
    res.json(cfg);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- fornecedores
//
// O cadastro nascia sozinho, como efeito da importação de XML: nome e
// documento, o bastante para a nota ter origem. Comprar exige prazo de entrega
// e prazo de pagamento — sem eles não há como planejar reposição nem prever o
// caixa. Estas rotas dão dono ao cadastro.

coreRouter.get('/suppliers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      items: listSuppliers(companyId, {
        search: req.query.search ? String(req.query.search) : undefined,
        includeInactive: req.query.includeInactive === 'true',
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/suppliers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    const supplier = loadSupplier(companyId, String(req.params.id));
    res.json({
      ...supplier,
      history: supplierPurchaseHistory(companyId, String(req.params.id)),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/suppliers', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const supplier = createSupplier(companyId, req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'suppliers.created',
      entityType: 'supplier',
      entityId: String(supplier.id),
    });
    res.status(201).json(supplier);
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/suppliers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const supplier = updateSupplier(companyId, String(req.params.id), req.body ?? {});
    recordAudit({
      companyId,
      userId,
      action: 'suppliers.updated',
      entityType: 'supplier',
      entityId: String(supplier.id),
    });
    res.json(supplier);
  } catch (err) {
    next(err);
  }
});

/** Desativa em vez de apagar: o histórico já recebido continua com origem. */
coreRouter.post('/suppliers/:id/active', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const active = req.body?.active !== false;
    const supplier = setSupplierActive(companyId, String(req.params.id), active);
    recordAudit({
      companyId,
      userId,
      action: active ? 'suppliers.activated' : 'suppliers.deactivated',
      entityType: 'supplier',
      entityId: String(supplier.id),
    });
    res.json(supplier);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------- pedidos de compra
//
// O pedido NÃO movimenta estoque: quem dá entrada é a conferência da nota. O
// pedido é o combinado, a nota é o que chegou — e é a comparação entre os dois
// que revela divergência.

coreRouter.get('/purchase-orders', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    // Página e total (GAP-PRD-164): o 201º pedido sumia da tela sem aviso.
    const recorte = {
      status: req.query.status ? String(req.query.status) : undefined,
      supplierId: req.query.supplierId ? String(req.query.supplierId) : undefined,
    };
    const pagina = lerPagina(req.query, 200);
    res.json({
      items: listPurchaseOrders(companyId, { ...recorte, ...pagina }),
      total: countPurchaseOrders(companyId, recorte),
      ...pagina,
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/purchase-orders/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(getPurchaseOrder(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchase-orders', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const order = createPurchaseOrder({
      companyId,
      userId,
      supplierId: String(req.body?.supplierId ?? ''),
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      expectedAt: req.body?.expectedAt ?? null,
      notes: req.body?.notes ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.created',
      entityType: 'purchase_order',
      entityId: String(order.id),
    });
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/purchase-orders/:id/items', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const order = updatePurchaseOrderItems(companyId, String(req.params.id), items);
    // Reescrever o rascunho é reescrever o compromisso em gestação — entra
    // na trilha com autor e tamanho (GAP-V19). O conteúdo novo está no
    // próprio pedido; a trilha diz QUEM mexeu e QUANDO.
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.items_updated',
      entityType: 'purchase_order',
      entityId: String(req.params.id),
      detail: { itemCount: items.length, totalCents: Number(order.total_cents) },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchase-orders/:id/send', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const order = sendPurchaseOrder(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.sent',
      entityType: 'purchase_order',
      entityId: String(order.id),
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/**
 * O PEDIDO EM PAPEL (GAP-PRD-090) — o A4 que o fornecedor recebe.
 *
 * O mesmo alcance da ficha do pedido: quem abre o pedido imprime. O papel não
 * mostra nada que a ficha já não mostre a essas pessoas.
 */
coreRouter.get('/purchase-orders/:id/impressao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(renderPurchaseOrderA4(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * O PEDIDO POR E-MAIL AO FORNECEDOR (GAP-PRD-090).
 *
 * O mesmo alcance de `/send`: mandar o combinado ao fornecedor é o gesto que
 * trava os itens, e ele é da gerência. Sem SMTP a mensagem fica na fila e a
 * resposta diz `READY_FOR_CREDENTIAL` — a tela não afirma entrega que não houve.
 */
coreRouter.post('/purchase-orders/:id/email', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const resultado = enviarPedidoPorEmail({
      companyId,
      orderId: String(req.params.id),
      para: req.body?.to ? String(req.body.to) : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.emailed',
      entityType: 'purchase_order',
      entityId: String(req.params.id),
      detail: {
        to: resultado.toAddress,
        queued: resultado.queued,
        readiness: resultado.readiness,
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/purchase-orders/:id/cancel', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const order = cancelPurchaseOrder(
      companyId,
      String(req.params.id),
      String(req.body?.reason ?? ''),
    );
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.cancelled',
      entityType: 'purchase_order',
      entityId: String(order.id),
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

/** Amarra uma nota já importada ao pedido que ela atende. */
coreRouter.post('/purchase-orders/:id/notes/:noteId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const order = linkNoteToOrder(companyId, String(req.params.noteId), String(req.params.id));
    /*
      AMARRAR ENTRA NA TRILHA (GAP-V19). Re-amarrar reprojeta DOIS pedidos —
      o que ganha e o que perde a nota — e mudava dois retratos sem registro
      de quem o fez. O detail guarda a nota; o pedido é o entity_id.
    */
    recordAudit({
      companyId,
      userId,
      action: 'purchase_orders.note_linked',
      entityType: 'purchase_order',
      entityId: String(req.params.id),
      detail: { noteId: String(req.params.noteId) },
    });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- devoluções
//
// Devolver não é cancelar. Cancelar desfaz a venda; devolver reconhece que ela
// aconteceu e o cliente voltou depois com parte da mercadoria. A venda não é
// tocada — a devolução é registro novo apontando para ela.

/*
  AS TRÊS LEITURAS DA TELA DE DEVOLUÇÕES — e o alcance delas era mais estreito
  que o das ESCRITAS que elas servem.

  As três nomeavam `gerente_loja`, `gerente_oficina` e os dois caixas à mão.
  Isso casava com o mundo antigo, em que cancelar exigia `gerente_loja` e
  pronto. Quando `POST /sales/:id/cancel` e `POST /sale-returns` passaram a ser
  `abertaAo(req, 'escritorio')` + `comLiberacaoPontual` — o recurso feito
  EXATAMENTE para o estoquista e o atendente pedirem o "sim" de um gestor ali
  mesmo —, estas três continuaram recusando os dois com 403. E a tela chama a
  lista ao MONTAR: eles não chegavam nem a ver a venda que queriam desfazer.

  Resultado medido: o ramo `CORE_RETURN_NEEDS_AUTHORIZATION` não tinha nenhum
  usuário alcançável na aplicação entregue — os quatro perfis que abriam a tela
  devolvem DIRETO e nunca o veem. Caminho morto com cara de vivo.

  O guarda agora é `abertaAo(req, 'balcao', 'escritorio')`, que é o MESMO de
  `GET /sales` — a outra chamada do mount da mesma tela. Duas mudanças de uma
  vez, e as duas de propósito:

    - o ESCRITÓRIO inteiro entra (estoquista e atendente incluídos), que é o
      alcance das escritas: ler o que se pode desfazer não pode ser mais
      fechado que pedir para desfazer;
    - a lista deixa de ser escrita à mão e passa a sair de `PERFIS_DO_AMBIENTE`,
      então o próximo morador do balcão ou do escritório nasce dentro dela em
      vez de ser esquecido numa enumeração.

  A ESCRITA continua estreita: `perfisQuePodemDireto` segue nomeando os
  gerentes, e quem não é gerente precisa da liberação, gasta uma vez e presa
  àquela venda. Ler não é desfazer.

  A BANCADA e a CONTABILIDADE seguem fora — o mecânico não lê o faturamento da
  loja e o contador não mora em ambiente nenhum daqui.
*/

/** O que ainda pode voltar desta venda, já descontado o que voltou antes. */
coreRouter.get('/sales/:id/returnable', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    const saleId = String(req.params.id);
    res.json({
      items: returnableItems(companyId, saleId),
      // Como esta operação devolve o dinheiro (a Preço Justo em duas etapas) e
      // a venda inteira — quem, quando, como pagou, fiscal e o que já voltou.
      fluxo: fluxoDaDevolucao(companyId),
      venda: vendaParaDevolucao(companyId, saleId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/sale-returns', (req: AuthedRequest, res, next) => {
  try {
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json({
      items: listSaleReturns(companyId, {
        saleId: req.query.saleId ? String(req.query.saleId) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/sale-returns/:id', (req: AuthedRequest, res, next) => {
  try {
    // Mesmo alcance da lista: o detalhe é o que a tela abre ao clicar na linha.
    abertaAo(req, 'balcao', 'escritorio');
    const { companyId } = scope(req);
    res.json(getSaleReturn(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Registra a devolução.
 *
 * Devolver mexe em estoque e em dinheiro, então é decisão de quem responde
 * pelo caixa — não de quem só opera o balcão. O que mudou é que "não é sua
 * decisão" deixou de ser o fim da conversa: quem não tem o perfil traz a
 * liberação de um gestor, presa a ESTA venda e gasta uma vez. Ver o cabeçalho
 * de `comLiberacaoPontual`, que é o mesmo portão do cancelamento.
 */
coreRouter.post('/sale-returns', (req: AuthedRequest, res, next) => {
  try {
    // Mesmo recorte da `DevolucoesPage`, que é a tela que chama as duas rotas.
    abertaAo(req, 'escritorio');
    const { companyId, userId } = scope(req);
    const saleId = String(req.body?.saleId ?? '');
    const caixaDoPedido = caixaNoEscopo(req, {
      informado: req.body?.terminalId,
      doDispositivo: req.auth?.storeId,
    });

    /*
      O REENVIO DA MESMA DEVOLUÇÃO (E-venda-servidor-09). A chave do pedido é
      lida ANTES da liberação: a do gestor foi gasta pelo primeiro envio, e o
      reenvio de quem não tem alçada tomaria "liberação já usada" em vez de
      ouvir que a devolução está registrada. Mesma chave com outro pedido é 422.
    */
    const chaveDoPedido = req.headers['idempotency-key'] as string | undefined;
    const jaRegistrada = devolucaoDaChave({
      companyId,
      idempotencyKey: chaveDoPedido,
      pedido: { saleId, refundMethod: req.body?.refundMethod, items: req.body?.items },
    });
    const { resultado: registro, authorizationId, authorizedBy } = jaRegistrada
      ? { resultado: jaRegistrada as Record<string, unknown>, authorizationId: null, authorizedBy: null }
      : comLiberacaoPontual(
          req,
          {
            perfisQuePodemDireto: ['gerente_loja', 'gerente_oficina'],
            action: 'devolver_venda',
            refId: saleId,
            codigo: 'CORE_RETURN_NEEDS_AUTHORIZATION',
            mensagem:
              'Registrar devolução devolve mercadoria ao estoque e dinheiro ao cliente. '
              + 'Peça a liberação de um gestor para esta venda.',
          },
          () =>
            createSaleReturn({
              companyId,
              userId,
              saleId,
              reason: String(req.body?.reason ?? ''),
              reasonCode: req.body?.reasonCode ?? null,
              reasonNote: req.body?.reasonNote ?? null,
              refundMethod: req.body?.refundMethod,
              items: Array.isArray(req.body?.items) ? req.body.items : [],
              cashSessionId: req.body?.cashSessionId ?? null,
              // A gaveta da devolução em dinheiro é a do caixa do pedido quando
              // a informada não serve (GAP-PRD-161). O do token vence o do corpo.
              terminalId: caixaDoPedido,
              idempotencyKey: chaveDoPedido ?? null,
            }),
        );
    // O reenvio não é um fato novo: sem segunda linha de trilha, e 200.
    const repetida = registro.duplicated === true;
    const status = repetida ? 200 : 201;

    if (!repetida) {
      // Quem APROVOU fica na devolução: o gestor da liberação, ou quem registrou
      // direto (que só registra direto por ser gestor).
      marcarAprovacaoDaDevolucao(companyId, String(registro.id), authorizedBy ?? userId);
      Object.assign(registro, getSaleReturn(companyId, String(registro.id)));
      const itens = Array.isArray(registro.items) ? (registro.items as Record<string, unknown>[]) : [];
      recordAudit({
        companyId,
        userId,
        action: 'sale_returns.created',
        entityType: 'sale_return',
        entityId: String(registro.id),
        // Quem pediu e quem assinou — ver o mesmo detalhe em `sale.cancel`.
        detail: {
          saleId,
          returnNumber: registro.number,
          requestingUserId: userId,
          authorizingUserId: authorizedBy,
          authorizationId,
          motivo: registro.reason,
          devolvivelCents: registro.total_cents,
          fluxo: (registro.reembolso as { fluxo?: string } | undefined)?.fluxo ?? null,
          situacaoFiscal: (registro.fiscal as { estado?: string } | undefined)?.estado ?? null,
          itens: itens.map((i) => ({
            saleItemId: i.sale_item_id,
            quantity: i.quantity,
            totalCents: i.total_cents,
            voltouAoEstoque: Number(i.restock) === 1,
            condicao: i.item_condition ?? null,
          })),
        },
        ip: ipDoSocket(req),
      });
    }
    // Devolução no cartão: o estorno é pedido à operadora depois do commit,
    // como no cancelamento (GAP-PRD-080). Outras formas não tocam a maquininha.
    // No reenvio também: o estorno é o PENDENTE, e o que já foi feito não repete.
    if (req.body?.refundMethod !== 'estorno_cartao') {
      res.status(status).json({ ...registro, estornosNaMaquininha: [] });
      return;
    }
    executarEstornosPendentes({ companyId, userId, saleId })
      .then((estornosNaMaquininha) => res.status(status).json({ ...registro, estornosNaMaquininha }))
      .catch(next);
  } catch (err) {
    next(err);
  }
});

/**
 * REGISTRAR DEVOLUÇÃO AO CLIENTE — o reembolso da devolução em duas etapas.
 *
 * A devolução registrou a mercadoria; aqui se registra o que de fato voltou ao
 * cliente, num meio: dinheiro da gaveta, PIX feito pela conta, estorno feito na
 * maquininha, crédito de loja. Mesmo portão da devolução (quem opera
 * devoluções, e o gestor direto — os demais com a liberação dele); devolver por
 * um meio que a venda não recebeu é só do gestor, com justificativa. A chave do
 * pedido é obrigatória: o clique duplo devolve o mesmo registro.
 */
coreRouter.post('/sale-returns/:id/refunds', (req: AuthedRequest, res, next) => {
  try {
    requireCapability(req, 'sales.returns.operate');
    const { companyId, userId } = scope(req);
    const returnId = String(req.params.id);
    const saleId = vendaDaDevolucao(companyId, returnId);
    const caixaDoPedido = caixaNoEscopo(req, {
      informado: req.body?.terminalId,
      doDispositivo: req.auth?.storeId,
    });
    const chaveDoPedido = req.headers['idempotency-key'] as string | undefined;
    const jaRegistrado = reembolsoDaChave({
      companyId,
      idempotencyKey: chaveDoPedido,
      pedido: { returnId, method: req.body?.method, amountCents: req.body?.amountCents },
    });
    const podeTrocarMeio = can(acessoDaRequisicao(req), 'approval.sale_return');
    const { resultado, authorizationId, authorizedBy } = jaRegistrado
      ? {
          resultado: { ...jaRegistrado, saleId, pedirEstornoNaMaquininha: false },
          authorizationId: null,
          authorizedBy: null,
        }
      : comLiberacaoPontual(
          req,
          {
            perfisQuePodemDireto: ['gerente_loja', 'gerente_oficina'],
            action: 'devolver_venda',
            refId: saleId,
            codigo: 'CORE_REFUND_NEEDS_AUTHORIZATION',
            mensagem:
              'Registrar o reembolso tira dinheiro da loja para o cliente. '
              + 'Peça a liberação de um gestor para esta venda.',
          },
          () =>
            registrarReembolso({
              companyId,
              userId,
              returnId,
              method: req.body?.method,
              amountCents: req.body?.amountCents,
              reference: req.body?.reference,
              note: req.body?.note,
              justification: req.body?.justification,
              podeTrocarMeio,
              cashSessionId: req.body?.cashSessionId ?? null,
              terminalId: caixaDoPedido,
              idempotencyKey: chaveDoPedido ?? null,
            }),
        );
    const repetido = resultado.duplicated === true;
    if (!repetido) {
      const reembolso = resultado.reembolso as
        | { registros?: Record<string, unknown>[]; situacao?: string; pendenteCents?: number }
        | undefined;
      const registro = (reembolso?.registros ?? []).find((r) => r.id === resultado.refundId);
      recordAudit({
        companyId,
        userId,
        action: 'sale_returns.refund_registered',
        entityType: 'sale_return',
        entityId: returnId,
        detail: {
          saleId,
          returnNumber: resultado.number,
          refundId: resultado.refundId,
          method: registro?.method ?? null,
          amountCents: registro?.amount_cents ?? null,
          originalMethod: registro?.original_method ?? null,
          justification: registro?.method_justification ?? null,
          reference: registro?.reference ?? null,
          cashSessionId: registro?.cash_session_id ?? null,
          situacaoDepois: reembolso?.situacao ?? null,
          pendenteDepoisCents: reembolso?.pendenteCents ?? null,
          requestingUserId: userId,
          authorizingUserId: authorizedBy,
          authorizationId,
        },
        ip: ipDoSocket(req),
      });
    }
    const { pedirEstornoNaMaquininha, ...corpo } = resultado;
    const status = repetido ? 200 : 201;
    if (!pedirEstornoNaMaquininha) {
      res.status(status).json({ ...corpo, estornosNaMaquininha: [] });
      return;
    }
    executarEstornosPendentes({ companyId, userId, saleId })
      .then((estornosNaMaquininha) => res.status(status).json({ ...corpo, estornosNaMaquininha }))
      .catch(next);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- inventário
//
// O acerto é a única entrada de estoque sem documento de origem: não há nota,
// venda nem OS por trás. Por isso o rastro é mais forte, e por isso aplicar é
// decisão de quem responde pelo estoque.

coreRouter.get('/inventory-counts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      items: listInventoryCounts(companyId, {
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/inventory-counts/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json(getInventoryCount(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/inventory-counts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const count = openInventoryCount({
      companyId,
      userId,
      scopeNote: req.body?.scopeNote ?? null,
      productIds: Array.isArray(req.body?.productIds) ? req.body.productIds : undefined,
      // O recorte da contagem parcial: categoria e/ou busca. A seleção roda no
      // serviço, contra o catálogo DESTA empresa — nunca ids soltos do corpo.
      category: req.body?.category ? String(req.body.category) : null,
      search: req.body?.search ? String(req.body.search) : null,
      // O local contado (GAP-PRD-167): validado no serviço contra os locais
      // ATIVOS desta empresa.
      locationId: req.body?.locationId ? String(req.body.locationId) : null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'inventory_counts.opened',
      entityType: 'inventory_count',
      entityId: String(count.id),
      detail: { locationId: (count.location_id as string | null) ?? null },
    });
    res.status(201).json(count);
  } catch (err) {
    next(err);
  }
});

/** Registra o que foi achado na prateleira. Ainda não mexe em estoque. */
coreRouter.post('/inventory-counts/:id/items', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    res.json(
      recordCount({
        companyId,
        userId,
        countId: String(req.params.id),
        productId: req.body?.productId ? String(req.body.productId) : undefined,
        // O BIPE DO LEITOR (B-estoque-entrada-16): o código lido acha o
        // produto no servidor, e `increment` soma à contagem em vez de trocar.
        barcode: req.body?.barcode ? String(req.body.barcode) : undefined,
        countedQuantity:
          req.body?.countedQuantity === undefined ? undefined : Number(req.body.countedQuantity),
        increment: req.body?.increment === undefined ? undefined : Number(req.body.increment),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** Aplica o acerto. Só gerente: é aqui que o saldo muda sem documento. */
coreRouter.post('/inventory-counts/:id/apply', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const count = applyInventoryCount({
      companyId,
      userId,
      countId: String(req.params.id),
      reason: String(req.body?.reason ?? ''),
    });
    recordAudit({
      companyId,
      userId,
      action: 'inventory_counts.applied',
      entityType: 'inventory_count',
      entityId: String(count.id),
    });
    res.json(count);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/inventory-counts/:id/cancel', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const count = cancelInventoryCount(
      companyId,
      String(req.params.id),
      String(req.body?.reason ?? ''),
    );
    recordAudit({
      companyId,
      userId,
      action: 'inventory_counts.cancelled',
      entityType: 'inventory_count',
      entityId: String(count.id),
    });
    res.json(count);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- CRM
//
// Lead não é cliente: guardá-lo em `core_customers` inflaria toda conta feita
// por cliente. Quando compra, vira cliente apontando para o cadastro que já
// existe — e se já houver alguém com o mesmo documento, liga ao que existe.

coreRouter.get('/leads', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json({
      items: listLeads(companyId, {
        status: req.query.status ? String(req.query.status) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/leads', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId, userId } = scope(req);
    const lead = createLead({
      companyId,
      userId,
      name: String(req.body?.name ?? ''),
      phone: req.body?.phone ?? null,
      email: req.body?.email ?? null,
      document: req.body?.document ?? null,
      source: req.body?.source ?? null,
      notes: req.body?.notes ?? null,
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
    });
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
});

coreRouter.patch('/leads/:id/status', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json(
      updateLeadStatus({
        companyId,
        leadId: String(req.params.id),
        status: req.body?.status,
        lostReason: req.body?.lostReason ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** O lead comprou: vira cliente, reaproveitando o cadastro se já houver. */
coreRouter.post('/leads/:id/convert', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    const resultado = convertLead({ companyId, leadId: String(req.params.id), userId });
    recordAudit({
      companyId,
      userId,
      action: 'leads.converted',
      entityType: 'lead',
      entityId: String(req.params.id),
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/opportunities', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json({
      items: listOpportunities(companyId, {
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/opportunities', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId, userId } = scope(req);
    const opp = createOpportunity({
      companyId,
      userId,
      title: String(req.body?.title ?? ''),
      amountCents: Number(req.body?.amountCents ?? 0),
      leadId: req.body?.leadId ?? null,
      customerId: req.body?.customerId ?? null,
      expectedCloseAt: req.body?.expectedCloseAt ?? null,
    });
    res.status(201).json(opp);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/opportunities/:id/close', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente');
    const { companyId } = scope(req);
    res.json(
      closeOpportunity({
        companyId,
        opportunityId: String(req.params.id),
        status: req.body?.status,
        lostReason: req.body?.lostReason ?? null,
        saleId: req.body?.saleId ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/crm/summary', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json(crmSummary(companyId));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- fidelidade
//
// Ponto acumulado é dívida da loja, não receita: tem razão própria e não passa
// pelo financeiro. O acúmulo acontece sozinho na venda; aqui ficam a
// configuração, o extrato e o resgate.

coreRouter.get('/loyalty/program', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'operador_caixa_loja', 'atendente');
    const { companyId } = scope(req);
    res.json({ program: getProgram(companyId), liability: loyaltyLiability(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/loyalty/program', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const program = updateProgram(companyId, {
      active: req.body?.active,
      centsPerPoint: req.body?.centsPerPoint,
      pointValueCents: req.body?.pointValueCents,
      minPointsToRedeem: req.body?.minPointsToRedeem,
    });
    recordAudit({
      companyId,
      userId,
      action: 'loyalty.program_updated',
      entityType: 'loyalty_program',
      entityId: companyId,
    });
    res.json(program);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/loyalty/customers/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'operador_caixa_loja', 'atendente');
    const { companyId } = scope(req);
    res.json(customerStatement(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/** Resgate: pontos viram desconto em centavos, para o PDV aplicar. */
coreRouter.post('/loyalty/redeem', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'operador_caixa_loja');
    const { companyId, userId } = scope(req);
    res.json(
      redeemPoints({
        companyId,
        customerId: String(req.body?.customerId ?? ''),
        points: Number(req.body?.points),
        saleId: req.body?.saleId ?? null,
        userId,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- locação
//
// Locar RESERVA em vez de dar baixa: o bem continua sendo da loja e volta. A
// reserva é o que impede o balcão de vender a peça que está com o cliente.

coreRouter.get('/rentals', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json({
      items: listRentalContracts(companyId, {
        status: req.query.status ? String(req.query.status) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/rentals/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente', 'operador_caixa_loja');
    const { companyId } = scope(req);
    res.json(getRentalContract(companyId, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/rentals', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    const contrato = createRentalContract({
      companyId,
      userId,
      customerId: String(req.body?.customerId ?? ''),
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      startsAt: req.body?.startsAt ?? null,
      endsAt: String(req.body?.endsAt ?? ''),
      depositCents: Number(req.body?.depositCents ?? 0),
      notes: req.body?.notes ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'rentals.created',
      entityType: 'rental_contract',
      entityId: String(contrato.id),
    });
    res.status(201).json(contrato);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/rentals/:id/return', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'atendente');
    const { companyId, userId } = scope(req);
    res.json(
      returnRentalItems({
        companyId,
        userId,
        contractId: String(req.params.id),
        items: Array.isArray(req.body?.items) ? req.body.items : [],
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/rentals/:id/cancel', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    res.json(
      cancelRentalContract({
        companyId,
        userId,
        contractId: String(req.params.id),
        reason: String(req.body?.reason ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ peças
//
// Peça não é produto de revenda: pertence a UMA oficina, e a bancada de
// celulares não enxerga o estoque de mobilidade. O mecânico NÃO vê custo — o
// campo é removido da resposta, não escondido na tela.

coreRouter.get('/workshop/parts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'mecanico', 'atendente');
    const { companyId, profiles } = scope(req);
    res.json({
      items: listParts(companyId, {
        workshopId: req.query.workshopId ? String(req.query.workshopId) : null,
        // O alcance de quem está olhando. Sem ele o mecânico da bancada de
        // celulares via a gaveta de mobilidade — e a tela dizia o contrário.
        workshopIds: resolveWorkshopScope(req),
        search: req.query.search ? String(req.query.search) : undefined,
        hideCost: !podeVerCusto(profiles),
      }),
    });
  } catch (err) {
    next(err);
  }
});

/*
  ============================================================================
  BIPAR E RESOLVER — o gesto do balcão da oficina (rodada 55)
  ============================================================================

  Um código na mão, duas saídas: a peça existe e se repõe, ou não existe e se
  cadastra. Quem só lê (o mecânico) recebe a mesma resposta e usa como consulta
  — quanto tem, onde está, qual o mínimo —, que é o uso mais frequente do
  leitor na bancada.
*/
coreRouter.get('/workshop/parts/scan', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista', 'mecanico');
    const { companyId, profiles } = scope(req);
    const alcance = resolveWorkshopScope(req);
    const peca = resolverCodigo(
      companyId,
      String(req.query.codigo ?? ''),
      req.query.workshopId ? String(req.query.workshopId) : null,
    );

    // Peça de bancada fora do alcance de quem bipou é, para essa pessoa,
    // código que não existe — e não um convite a cadastrar de novo, por isso
    // a resposta diz `foraDoAlcance`.
    const foraDoAlcance = Boolean(
      peca && alcance && peca.workshop_id && !alcance.includes(peca.workshop_id),
    );
    if (!peca || foraDoAlcance) {
      res.json({
        encontrada: null,
        codigo: String(req.query.codigo ?? '').trim(),
        foraDoAlcance,
      });
      return;
    }

    const item: Record<string, unknown> = { ...peca, available: peca.stock_quantity - peca.reserved };
    if (!podeVerCusto(profiles)) delete item.cost_cents;
    res.json({ encontrada: item, codigo: String(req.query.codigo ?? '').trim(), foraDoAlcance: false });
  } catch (err) {
    next(err);
  }
});

/** Cadastra a peça e dá a entrada — o mesmo gesto, o mesmo fato. */
coreRouter.post('/workshop/parts', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    /*
      A BANCADA VEM DO CORPO, e quem a valida é o serviço — não
      `resolveWorkshop`.

      `resolveWorkshop` resolve pela FILIAÇÃO a `core_workshop_members`, e o
      estoquista não tem linha lá: quem tem são os mecânicos. Usá-lo aqui dava
      403 justamente a quem esta rota nomeia. A régua certa para quem dá
      entrada é a EMPRESA, e `exigirBancadaComPeca` a aplica — inclusive
      assumindo a bancada quando só existe uma.
    */
    const criada = cadastrarPecaComEntrada({
      companyId,
      workshopId: String(req.body?.workshopId ?? ''),
      userId,
      /*
        A CHAVE DO GESTO, e não uma inventada aqui.

        Entrada de peça é a mesma classe de operação que a venda e o
        pagamento: repetir o envio não pode repetir o fato. O serviço recusa
        quando ela falta, então a rota só repassa — e repassa o header, que é
        o que o navegador reenvia igual no clique repetido.
      */
      entryKey: (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? ''),
      name: String(req.body?.name ?? ''),
      barcode: req.body?.barcode ?? null,
      internalCode: req.body?.internalCode ?? null,
      unit: req.body?.unit ?? null,
      costCents: Number(req.body?.costCents ?? 0),
      markupPercent: req.body?.markupPercent ?? null,
      priceCents: req.body?.priceCents ?? null,
      quantity: Number(req.body?.quantity ?? 0),
      minStock: req.body?.minStock ?? null,
      storageLocation: req.body?.storageLocation ?? null,
      supplierId: req.body?.supplierId ?? null,
      documento: {
        numero: String(req.body?.documento?.numero ?? ''),
        fornecedor: req.body?.documento?.fornecedor ?? null,
        valorTotalCents: req.body?.documento?.valorTotalCents ?? null,
      },
    });
    // Gesto repetido não vira linha nova na auditoria: o fato é um só.
    if (!criada.duplicada) {
      recordAudit({
        companyId,
        userId,
        action: 'workshop.part.created',
        entityType: 'product',
        entityId: criada.productId,
        detail: { quantity: criada.quantity, documento: req.body?.documento?.numero },
      });
    }
    res.status(201).json(criada);
  } catch (err) {
    next(err);
  }
});

/** Repõe a gaveta, com documento. */
coreRouter.post('/workshop/parts/:id/reposicao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const feita = reporPeca({
      companyId,
      productId: String(req.params.id),
      userId,
      entryKey: (req.headers['idempotency-key'] as string) || String(req.body?.idempotencyKey ?? ''),
      quantity: Number(req.body?.quantity ?? 0),
      costCents: req.body?.costCents ?? null,
      markupPercent: req.body?.markupPercent ?? null,
      documento: {
        numero: String(req.body?.documento?.numero ?? ''),
        fornecedor: req.body?.documento?.fornecedor ?? null,
        valorTotalCents: req.body?.documento?.valorTotalCents ?? null,
      },
    });
    if (!feita.duplicada) {
      recordAudit({
        companyId,
        userId,
        action: 'workshop.part.restocked',
        entityType: 'product',
        entityId: String(req.params.id),
        detail: { quantity: feita.quantity, documento: req.body?.documento?.numero },
      });
    }
    res.json(feita);
  } catch (err) {
    next(err);
  }
});

/**
 * O MÍNIMO E O ENDEREÇO, editáveis de onde se olha a gaveta.
 *
 * São os dois campos que só quem está na bancada sabe: quantas peças não podem
 * faltar, e em que prateleira ela mora. Estavam no cadastro de produto, que é
 * tela de gestão e fica FECHADA para o mecânico — então na prática ninguém os
 * preenchia, e `below_minimum` nunca disparava para peça nascida de nota,
 * porque ela nasce com mínimo zero.
 */
coreRouter.patch('/workshop/parts/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const atualizada = ajustarPeca({
      companyId,
      productId: String(req.params.id),
      minStock: req.body?.minStock,
      storageLocation: req.body?.storageLocation,
      costCents: req.body?.costCents,
      priceCents: req.body?.priceCents,
      markupPercent: req.body?.markupPercent,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.part.updated',
      entityType: 'product',
      entityId: String(req.params.id),
      detail: { minStock: req.body?.minStock, storageLocation: req.body?.storageLocation },
    });
    res.json(atualizada);
  } catch (err) {
    next(err);
  }
});

/** Devolve ao estoque a peça requisitada e não usada. */
coreRouter.post('/workshop/orders/:orderId/parts/:partId/return', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_oficina', 'mecanico');
    const { companyId, userId } = scope(req);
    /*
      QUEM DEVOLVE (GAP-PRD-103): o alcance de bancada do quadro, o
      responsável pela OS ou a gestão da oficina — a mesma régua do
      lançamento. Nome e papel viajam para assinar a queda da aprovação.
    */
    const resultado = returnPartToStock({
      companyId,
      workshopId: resolveWorkshopScope(req),
      orderId: String(req.params.orderId),
      partId: String(req.params.partId),
      quantity: Number(req.body?.quantity),
      userId,
      userName: actorName(req),
      isManager: isManagerProfile(req),
      reason: req.body?.reason ?? null,
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.part_returned',
      entityType: 'service_order',
      entityId: String(req.params.orderId),
      detail: {
        partId: String(req.params.partId),
        quantity: resultado.returned,
        reason: req.body?.reason ?? undefined,
      },
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- conciliação bancária
//
// A terceira verdade sobre o mesmo dinheiro: a venda, o financeiro e o banco.
// COMPARA E RELATA — não corrige, e não casa sozinha.

coreRouter.get('/bank/statements', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    // A página declara o que cortou (GAP-PRD-177): `total` e `truncated`
    // viajam junto de `items`, e `limit`/`offset` pedem a próxima.
    res.json(
      listStatementsPage(companyId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/bank/lines', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(
      listLinesPage(companyId, {
        statementId: req.query.statementId ? String(req.query.statementId) : undefined,
        onlyUnmatched: req.query.onlyUnmatched === 'true',
        onlyMatched: req.query.onlyMatched === 'true',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/bank/statements', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const resultado = importStatement({
      companyId,
      userId,
      accountLabel: String(req.body?.accountLabel ?? ''),
      sourceName: req.body?.sourceName ?? null,
      lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
    });
    recordAudit({
      companyId,
      userId,
      action: 'bank.statement_imported',
      entityType: 'bank_statement',
      entityId: resultado.statementId,
    });
    res.status(201).json(resultado);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/bank/lines/:id/suggestions', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: suggestMatches(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/** Casar é ato de quem confere: o sistema sugere, a pessoa confirma. */
coreRouter.post('/bank/lines/:id/match', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const linha = matchLine({
      companyId,
      lineId: String(req.params.id),
      settlementId: String(req.body?.settlementId ?? ''),
      userId,
    });
    recordAudit({
      companyId,
      userId,
      action: 'bank.line_matched',
      entityType: 'bank_statement_line',
      entityId: String(req.params.id),
      detail: {
        settlementId: String(req.body?.settlementId ?? ''),
        amountCents: Number(linha.amount_cents ?? 0),
      },
    });
    res.json(linha);
  } catch (err) {
    next(err);
  }
});

/**
 * Desfaz o casamento (GAP-V26).
 *
 * A rota existia e o client também; nenhuma tela a chamava — desfazer só era
 * possível pela API na mão, e o erro mais provável da conciliação é
 * justamente casar a linha errada.
 *
 * A TRILHA É OBRIGATÓRIA AQUI, e mais do que no casamento: desfazer APAGA
 * `matched_by` e `matched_at` da linha. Sem esta gravação, o único vestígio de
 * que houve uma conferência some junto com ela, e a divergência volta ao
 * relatório sem história — ninguém saberia que ela já tinha sido resolvida uma
 * vez, nem por quem, nem que alguém mudou de ideia.
 */
coreRouter.delete('/bank/lines/:id/match', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const desfeito = unmatchLine(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'bank.line_unmatched',
      entityType: 'bank_statement_line',
      entityId: desfeito.lineId,
      detail: {
        // A baixa que voltou a ficar solta, nomeada: é ela que reaparece como
        // divergência na próxima conferência.
        settlementId: desfeito.settlementId,
        amountCents: desfeito.amountCents,
        description: desfeito.description,
      },
    });
    res.json({ ok: true, ...desfeito });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/bank/conciliacao', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(
      reconcileBank({
        companyId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------ administração da loja
//
// A identidade da vitrine, por operação. O CATÁLOGO não passa por aqui: quem
// decide o que aparece continua sendo `publish_online` no produto, e o destaque
// é sinalizador no próprio produto — lista paralela divergiria do cadastro.

coreRouter.get('/storefront/settings', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({
      settings: getStorefrontSettings(companyId),
      products: listPublishedForAdmin(companyId),
      /*
        O TIPO mora em `core_companies` e não nas configurações da vitrine,
        porque ele não é aparência: é o que a loja É, na mesma prateleira da
        resposta para "isto é loja ou oficina". A tela mostra os dois juntos
        porque é onde o dono pensa neles juntos.
      */
      preset: getStorefrontPreset(companyId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Logo e capa da página da marca (rodada 40). A imagem sobe em base64 e vai
 * para o disco; o banco guarda a URL. Trocar substitui — cada loja tem UM
 * logo e UMA capa.
 */
coreRouter.post('/storefront/imagem', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const tipo = req.body?.tipo === 'capa' ? 'capa' : 'logo';
    const settings = setStoreImage({
      companyId,
      tipo,
      dataUrl: String(req.body?.dataUrl ?? ''),
      mimeType: req.body?.mimeType,
    });
    recordAudit({
      companyId,
      userId,
      action: `storefront.${tipo}.set`,
      entityType: 'storefront',
      entityId: companyId,
    });
    res.status(201).json(settings);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/storefront/imagem/:tipo', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const tipo = req.params.tipo === 'capa' ? 'capa' : 'logo';
    const settings = removeStoreImage(companyId, tipo);
    recordAudit({
      companyId,
      userId,
      action: `storefront.${tipo}.remove`,
      entityType: 'storefront',
      entityId: companyId,
    });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/storefront/settings', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const settings = updateStorefrontSettings(companyId, {
      headline: req.body?.headline,
      description: req.body?.description,
      whatsapp: req.body?.whatsapp,
      bannerText: req.body?.bannerText,
      bannerActive: req.body?.bannerActive,
      installmentsMax: req.body?.installmentsMax,
      storefrontPreset: req.body?.storefrontPreset,
    });
    recordAudit({
      companyId,
      userId,
      action: 'storefront.settings_updated',
      entityType: 'storefront',
      entityId: companyId,
    });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

/**
 * QUEM PODE FECHAR PEDIDO NA LOJA ONLINE DESTA OPERAÇÃO (GAP-PRD-028).
 *
 * 'conta' (o padrão, quando ninguém escolheu) exige a sessão do portal com
 * e-mail provado e cadastro completo; 'visitante' aceita também quem compra
 * sem conta. É decisão do dono — por isso a troca fica na trilha, com o antes
 * e o depois.
 */
coreRouter.get('/storefront/checkout-policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(politicaDoCheckout(companyId));
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/storefront/checkout-policy', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const antes = politicaDoCheckout(companyId).mode;
    const politica = definirModoDoCheckout(companyId, req.body?.mode);
    recordAudit({
      companyId,
      userId,
      action: 'storefront.checkout_mode_updated',
      entityType: 'storefront',
      entityId: companyId,
      detail: { antes, depois: politica.mode },
    });
    res.json(politica);
  } catch (err) {
    next(err);
  }
});

/*
  ENTRAR COM GOOGLE NA LOJA (GAP-PRD-027) — a configuração é da INSTALAÇÃO
  (a conta do cliente é do grupo), então só quem responde pelo grupo mexe:
  `requireProfile(req)` sem perfil extra — `admin_geral` e `gestor`. O
  segredo entra aqui e nunca sai: a resposta traz só a dica. A trilha guarda
  o antes/depois SEM o segredo.
*/
coreRouter.get('/portal/login-google', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    res.json(lerConfiguracaoGoogle());
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/portal/login-google', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req);
    const { companyId, userId } = scope(req);
    const antes = retratoDoGoogle(lerConfiguracaoGoogle());
    const depois = salvarConfiguracaoGoogle(
      {
        enabled: req.body?.enabled,
        providerMode: req.body?.providerMode,
        clientId: req.body?.clientId,
        clientSecret: req.body?.clientSecret,
        redirectUri: req.body?.redirectUri,
      },
      userId,
    );
    recordAudit({
      companyId,
      userId,
      action: 'portal.google_login_updated',
      entityType: 'portal_google_login',
      entityId: 'google',
      detail: {
        antes,
        depois: retratoDoGoogle(depois),
        segredoTrocado: typeof req.body?.clientSecret === 'string' && req.body.clientSecret.trim() !== '',
      },
    });
    res.json(depois);
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/storefront/featured/:productId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json(
      setFeatured(companyId, String(req.params.productId), req.body?.featured !== false),
    );
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------- oficinas e seus mecânicos
//
// As duas oficinas do grupo trabalham diferente: mobilidade usa plaquinha
// porque o aparelho fica; celulares não, porque entra e sai. A regra mora em
// `WorkshopCapabilities`, num lugar só.
//
// O vínculo mecânico↔oficina é o que impede quem conserta celular de mexer na
// bancada de mobilidade — pertencer à mesma empresa não basta.

// A listagem de oficinas JÁ EXISTE, mais acima, e é ela que ganhou as
// capacidades. Uma segunda declaração aqui nunca seria alcançada — o Express
// usa a primeira que casa —, e viraria código morto que parece vivo.

coreRouter.get('/workshops/:id/members', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId } = scope(req);
    res.json({ items: listWorkshopMembers(companyId, String(req.params.id)) });
  } catch (err) {
    next(err);
  }
});

/** Põe alguém na bancada desta oficina. */
coreRouter.post('/workshops/:id/members', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const membro = addWorkshopMember({
      companyId,
      workshopId: String(req.params.id),
      userId: String(req.body?.userId ?? ''),
      role: req.body?.role ?? 'mecanico',
    });
    recordAudit({
      companyId,
      userId,
      action: 'workshop.member_added',
      entityType: 'workshop',
      entityId: String(req.params.id),
    });
    res.status(201).json(membro);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/workshops/:id/members/:userId', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    removeWorkshopMember(companyId, String(req.params.id), String(req.params.userId));
    recordAudit({
      companyId,
      userId,
      action: 'workshop.member_removed',
      entityType: 'workshop',
      entityId: String(req.params.id),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- CENTRAL DE RELATÓRIOS
//
// GAP-V37: nenhum relatório saía da tela. O único gerador de CSV do repositório
// vivia dentro do zip mensal do contador, e as telas de Estoque, Movimentações,
// DRE, BI e Auditoria terminavam nelas mesmas — quem precisava do trimestre em
// planilha copiava número a número.
//
// SÃO DUAS ROTAS, e não catorze: o catálogo e o relatório. Uma rota por
// relatório multiplicaria por catorze o guarda, o recorte de empresa e o
// caminho da exportação — e a décima quinta nasceria com um deles esquecido. O
// catálogo é DADO (ver `ReportsService`), e a tela desenha o que ele diz.
//
// ALCANCE: `requireProfile(req, 'gerente_loja', 'gerente_oficina')`, o mesmo
// dos insights e das comissões — e ele é a porta MAIS ESTREITA entre os
// ingredientes que a Central junta. Ela consolida custo de estoque, comissão
// por vendedor e margem no mesmo lugar; abri-la ao escritório inteiro daria ao
// estoquista e ao atendente, numa tela só, o que quatro telas hoje recusam.
// A lista do menu e a do roteador repetem esta — `o-menu-nao-promete` cobra.

coreRouter.get('/reports', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    // O catálogo não lê o banco: ele é a declaração dos relatórios. Vem
    // guardado assim mesmo porque a lista já conta o que o sistema mede.
    res.json({ items: listReports() });
  } catch (err) {
    next(err);
  }
});

/**
 * Um relatório — os dados, e o MESMO conteúdo em CSV quando `formato=csv`.
 *
 * UMA ROTA PARA OS DOIS, e é a decisão que garante que o arquivo confere com a
 * tela: a exportação recebe o resultado já montado (`reportToCsv`), em vez de
 * repetir a consulta. Duas rotas rodariam a consulta duas vezes, e entre a
 * leitura e o download cabe uma venda — quem comparasse os dois juraria que o
 * sistema erra.
 *
 * PDF NÃO É OFERECIDO, aqui nem na tela: não há biblioteca de PDF no servidor,
 * e um botão que gera HTML chamado de PDF é rótulo mentiroso. A tela diz que a
 * impressão em papel é a do navegador.
 */
coreRouter.get('/reports/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const { from, to } = periodoDoPedido(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
    );
    const direcao = req.query.direcao === 'in' || req.query.direcao === 'out'
      ? (req.query.direcao as 'in' | 'out')
      : undefined;
    const resultado = runReport(String(req.params.id), {
      // A EMPRESA É A DO TOKEN, sem exceção e sem parâmetro: a Central lê
      // custo, comissão e margem, e um `?companyId=` aqui seria a porta mais
      // barata para o relatório da loja vizinha.
      companyId,
      from,
      to,
      situacao: (req.query.situacao as string | undefined)?.trim() || undefined,
      direcao,
      categoria: (req.query.categoria as string | undefined)?.trim() || undefined,
      busca: (req.query.busca as string | undefined)?.trim() || undefined,
    });

    if (String(req.query.formato ?? '').toLowerCase() !== 'csv') {
      res.json(resultado);
      return;
    }

    /*
      A EXPORTAÇÃO DEIXA RASTRO — e o download dos dados também não deixaria,
      não fosse esta linha.

      Levar o razão do estoque ou o contas a receber de um trimestre para fora
      da empresa é o mesmo gesto que o pacote do contador faz uma vez por mês,
      e aquele é auditado desde que nasceu. Sem trilha, "quem tirou a lista de
      clientes do sistema" não teria resposta.
    */
    recordAudit({
      companyId,
      userId,
      action: 'report.export',
      entityType: 'report',
      entityId: resultado.report.id,
      detail: {
        from,
        to,
        linhas: resultado.rows.length,
        total: resultado.rowCount,
        truncado: resultado.truncated,
      },
    });

    const nome = nomeDoArquivo(resultado.report.id, from, to);
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeDeArquivoSeguro(nome)}"`);
    res.send(reportToCsv(resultado, nomeDaEmpresa(companyId)));
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- BI
//
// Compara as operações do grupo. O escopo segue o VÍNCULO da pessoa
// (`core_user_companies`), não "todas as empresas" — uma consulta que
// atravessasse empresas livremente seria a única do repositório a fazer isso.
// E segue o PERFIL de cada vínculo (GAP-PRD-084): a lista do guarda abaixo é a
// mesma que escolhe as operações (`PERFIS_QUE_LEEM_O_BI`, em GroupInsights) —
// escrita por extenso aqui porque `o-menu-nao-promete` lê o guarda por AST, e
// `bi-e-painel-seguem-o-perfil-de-cada-operacao` cobra que as duas batem.

coreRouter.get('/insights/operations', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { userId } = scope(req);
    res.json(
      operationsOverview({
        userId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/insights/products', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { userId } = scope(req);
    res.json({
      items: topProducts({
        userId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Vendas por MARCA nas operações do vínculo — GAP-V44.
 *
 * O mesmo alcance das outras três de `/insights`: os dois gerentes. Comparar
 * marcas entre as lojas do grupo é leitura de quem responde por elas.
 */
coreRouter.get('/insights/brands', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { userId } = scope(req);
    res.json({
      items: topBrands({
        userId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** Margem só onde o custo é confiável — e diz quantos itens ficaram de fora. */
coreRouter.get('/insights/margin', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { userId } = scope(req);
    res.json(
      marginWhereReliable({
        userId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- logística
//
// O MÓDULO EXISTIA E NÃO ERA ALCANÇÁVEL POR NINGUÉM.
//
// O roteador `/logistics` guarda toda rota com `requirePermission('logistics.
// view')`, e `requirePermission` compara a string com os PERFIS do usuário —
// não existe perfil chamado "logistics.view". Só `admin_geral` passa, e não há
// nenhum admin_geral em uso: cotação, transportadoras, envios e homologação
// respondiam 403 para todo mundo, inclusive para o gestor.
//
// Estas rotas falam o vocabulário do resto do sistema: perfis nomeados, com o
// mesmo desvio de gestor e admin. O roteador legado fica como está — os outros
// dezesseis têm a mesma forma, e mexer neles às cegas por causa deste seria
// alargar acesso em dezesseis lugares para resolver um.

coreRouter.get('/logistics/readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'estoquista');
    const { companyId } = scope(req);
    res.json({
      ...logisticsReadiness(companyId),
      // O CEP de onde a mercadoria sai. A tela mostra para o gestor conferir
      // que está cotando a partir do galpão certo.
      originZip: originZipOf(companyId),
    });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/logistics/carriers', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'estoquista');
      const { companyId } = scope(req);
      res.json(await logisticsProvidersStatus(companyId));
    } catch (err) {
      next(err);
    }
  })();
});

/**
 * Cotação de conferência.
 *
 * SEM DEFAULT SILENCIOSO — o serviço recusa pacote sem peso ou sem dimensão,
 * porque o transportador cobra pelo volume real e a diferença aparece depois,
 * com a mercadoria já vendida. E o resultado vem marcado: cotação simulada não
 * pode ser lida como preço de transportadora.
 */
coreRouter.post('/logistics/quote', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, 'gerente_loja', 'estoquista');
      const { companyId } = scope(req);
      const origem = String(req.body?.originZipCode ?? '') || originZipOf(companyId) || '';
      res.json(
        await backendLogisticsQuote(companyId, {
          originZipCode: origem,
          destinationZipCode: String(req.body?.destinationZipCode ?? ''),
          weightGrams: req.body?.weightGrams,
          heightCm: req.body?.heightCm,
          widthCm: req.body?.widthCm,
          lengthCm: req.body?.lengthCm,
          declaredValueInCents: req.body?.declaredValueInCents,
        }),
      );
    } catch (err) {
      next(err);
    }
  })();
});

/*
  Aqui existiu um `GET /core/logistics/shipments`. Saiu MEDIDO: nenhuma tela o
  chamava, nenhum teste o cobria, e ele lia a camada JSON legada cujo escritor
  é inalcançável por tela — uma segunda resposta para a pergunta que o módulo
  `/api/v1/logistics` (que fica, e tem rodada própria) já responde com guarda
  de permissão. Rota sem chamador que duplica leitor vivo não é reserva: é a
  porta que envelhece sem ninguém olhar.
*/

/**
 * A configuração do dia 1, loja por loja (GAP-PRD-034): entrega, produtos e
 * medidas, CEP e remetente, transportadora, Asaas e SMTP — o que falta, quem
 * resolve e onde. Mesmo alcance das telas que resolvem os itens
 * (`QUEM_RESPONDE_PELA_LOJA`). Quem responde pelo GRUPO vê as operações todas
 * de uma vez; o gerente, a dele.
 */
coreRouter.get('/loja/prontidao-do-dia-1', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const empresas = respondePeloGrupo(userId)
      ? listCompaniesForUser(userId).map((c) => String(c.id))
      : [companyId];
    res.json({ operacoes: prontidaoDasOperacoes(empresas) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------- importação de planilha
/*
  QUEM PODE IMPORTAR É MAIS ESTREITO DO QUE QUEM RECEBE NOTA — de propósito.

  A entrada de NF-e aceita até o operador de caixa: receber mercadoria é ato de
  rotina, feito na doca, com o papel na mão e a carga à vista. Importar planilha
  é outra coisa: cria o CATÁLOGO INTEIRO e o saldo inicial de uma operação, a
  partir de um arquivo que ninguém confere item a item. É ato de montar a loja,
  não de tocá-la, e por isso fica com quem responde por ela.

  Todas as rotas declaram alcance — a regra de lint em AST recusa rota calada —
  e o alcance aqui bate com a tela, que vive em ROTA_GESTAO.
*/

coreRouter.post('/import/produtos', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    const resumo = importarPlanilha({
      companyId,
      userId,
      arquivoB64: String(req.body?.arquivo ?? ''),
      nomeArquivo: String(req.body?.nomeArquivo ?? 'planilha.csv'),
    });
    recordAudit({
      companyId,
      userId,
      action: 'import.produtos.upload',
      entityType: 'import_batch',
      entityId: resumo.id,
      detail: {
        nomeArquivo: resumo.nomeArquivo,
        linhas: resumo.totalLinhas,
        erros: resumo.erros,
        jaImportado: resumo.jaImportado?.id ?? null,
      },
    });
    res.status(201).json(resumo);
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/import/produtos', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    res.json({ items: listarLotes(companyId) });
  } catch (err) {
    next(err);
  }
});

coreRouter.get('/import/produtos/:id/itens', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    /*
      Paginado, e não por escolha de estilo: cinco mil linhas numa resposta só
      travariam justamente a tela em que a pessoa mais precisa enxergar. Os
      itens com erro vêm primeiro porque são os que exigem decisão.
    */
    res.json(
      listarItensDaImportacao(companyId, String(String(req.params.id)), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        apenasErros: req.query.apenasErros === '1',
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.put('/import/produtos/:id/leitura', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId } = scope(req);
    /*
      O cliente diz COMO ler; quem lê continua sendo o servidor, sobre os bytes
      que ele guardou. É o que faz "detectei o separador errado" custar um
      clique em vez de uma reimportação — sem que o navegador passe a ser fonte
      de dado nenhum.
    */
    res.json(
      relerLote({
        companyId,
        batchId: String(String(req.params.id)),
        separador: req.body?.separador,
        encoding: req.body?.encoding,
        mapa: req.body?.mapa,
      }),
    );
  } catch (err) {
    next(err);
  }
});

coreRouter.post('/import/produtos/:id/confirmar', (req: AuthedRequest, res, next) => {
  try {
    // Confirmar é o que CRIA produto e mexe em estoque. Fica com a gerência.
    requireProfile(req, 'gerente_loja', 'gerente_oficina');
    const { companyId, userId } = scope(req);
    const feito = confirmarLote({ companyId, batchId: String(String(req.params.id)), userId });
    recordAudit({
      companyId,
      userId,
      action: 'import.produtos.confirmar',
      entityType: 'import_batch',
      entityId: String(String(req.params.id)),
      detail: feito,
    });
    res.json(feito);
  } catch (err) {
    next(err);
  }
});

coreRouter.delete('/import/produtos/:id', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista');
    const { companyId, userId } = scope(req);
    descartarLote(companyId, String(req.params.id));
    recordAudit({
      companyId,
      userId,
      action: 'import.produtos.descartar',
      entityType: 'import_batch',
      entityId: String(String(req.params.id)),
      detail: {},
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// A NFS-e da mão de obra (GAP-PRD-024): rotas em arquivo próprio, atrás do
// mesmo authMiddleware deste roteador — cada uma declara quem a alcança.
coreRouter.use(nfseRouter);
