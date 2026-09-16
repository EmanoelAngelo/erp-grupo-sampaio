/**
 * ============================================================================
 * AS TELAS DO ROTEADOR, CADA UMA NO SEU PEDAÇO (GAP-PRD-210)
 * ============================================================================
 *
 * O build saía num pacote único de 1,7 MB (424 kB comprimido) com as setenta
 * telas dentro, e todo caixa o baixava inteiro para abrir o PDV. Aqui cada
 * tela é um `import()` — o Vite corta um pedaço para cada módulo de página, e
 * a tela só é baixada quando alguém a abre (ver `telaSobDemanda.ts`).
 *
 * ## O que fica FORA desta lista, de propósito
 *
 * `gsRoutes.tsx` importa direto quatro telas, que vão no pedaço inicial:
 *
 *   - `LoginPage` e `OficinaLoginPage` — as portas. É a primeira tela de quem
 *     chega, e esperar um segundo pedaço para ver o campo de senha seria
 *     trocar um carregamento por dois;
 *   - `PdvPage` — o balcão VENDE SEM REDE (fila de vendas offline). O PDV não
 *     pode depender de um pedaço que talvez não tenha sido guardado: indo no
 *     pacote inicial, abre sempre que a casca abre;
 *   - `NaoEncontradaPage` — endereço errado responde na hora.
 *
 * As outras telas também abrem sem rede: o build escreve a lista de todos os
 * pedaços (`sw-precache.json`) e o service worker guarda a lista inteira
 * (`public/sw.js`), não só o que a pessoa visitou.
 *
 * Tela nova entra aqui, com a mesma forma; `telas-sob-demanda.test.tsx` recusa
 * import estático de página em `gsRoutes.tsx` fora das quatro acima.
 */
import { telaSobDemanda } from './telaSobDemanda';

export const PainelPage = telaSobDemanda('PainelPage', () => import('@/pages/gs/PainelPage'));
export const AcessoNegadoPage = telaSobDemanda('AcessoNegadoPage', () => import('@/pages/gs/AcessoNegadoPage'));
export const OficinaPage = telaSobDemanda('OficinaPage', () => import('@/pages/gs/OficinaPage'));
export const OrdemServicoPage = telaSobDemanda('OrdemServicoPage', () => import('@/pages/gs/OrdemServicoPage'));
export const EntradaNotasPage = telaSobDemanda('EntradaNotasPage', () => import('@/pages/gs/EntradaNotasPage'));
export const ImportacaoPlanilhaPage = telaSobDemanda('ImportacaoPlanilhaPage', () => import('@/pages/gs/ImportacaoPlanilhaPage'));
export const LojaPage = telaSobDemanda('LojaPage', () => import('@/pages/gs/LojaPage'));
export const ProdutoLojaPage = telaSobDemanda('ProdutoLojaPage', () => import('@/pages/gs/ProdutoLojaPage'));
export const EntregaLojaPage = telaSobDemanda('EntregaLojaPage', () => import('@/pages/gs/EntregaLojaPage'));
export const ProntidaoDoDiaUmPage = telaSobDemanda('ProntidaoDoDiaUmPage', () => import('@/pages/gs/ProntidaoDoDiaUmPage'));
export const EmailsPage = telaSobDemanda('EmailsPage', () => import('@/pages/gs/EmailsPage'));
export const ConciliacaoAsaasPage = telaSobDemanda('ConciliacaoAsaasPage', () => import('@/pages/gs/ConciliacaoAsaasPage'));
export const MinhaContaPage = telaSobDemanda('MinhaContaPage', () => import('@/pages/gs/MinhaContaPage'));
export const MeuPedidoPage = telaSobDemanda('MeuPedidoPage', () => import('@/pages/gs/MinhaContaPage'), 'MeuPedidoPage');
export const RedefinirSenhaPage = telaSobDemanda('RedefinirSenhaPage', () => import('@/pages/gs/RedefinirSenhaPage'));
export const RetornoDoGooglePage = telaSobDemanda('RetornoDoGooglePage', () => import('@/pages/gs/RetornoDoGooglePage'));
export const LoginGooglePage = telaSobDemanda('LoginGooglePage', () => import('@/pages/gs/LoginGooglePage'));
export const PoliticaDePrivacidadePage = telaSobDemanda('PoliticaDePrivacidadePage', () => import('@/pages/gs/PaginasLegais'), 'PoliticaDePrivacidadePage');
export const TermosDeUsoPage = telaSobDemanda('TermosDeUsoPage', () => import('@/pages/gs/PaginasLegais'), 'TermosDeUsoPage');
export const TrocasEDevolucoesPage = telaSobDemanda('TrocasEDevolucoesPage', () => import('@/pages/gs/PaginasLegais'), 'TrocasEDevolucoesPage');
export const FotosEmLotePage = telaSobDemanda('FotosEmLotePage', () => import('@/pages/gs/FotosEmLotePage'));
export const MeusEquipamentosPage = telaSobDemanda('MeusEquipamentosPage', () => import('@/pages/gs/MeusEquipamentosPage'));
export const EtiquetasPage = telaSobDemanda('EtiquetasPage', () => import('@/pages/gs/EtiquetasPage'));
export const OrcamentosPage = telaSobDemanda('OrcamentosPage', () => import('@/pages/gs/OrcamentosPage'));
export const ConsignacoesPage = telaSobDemanda('ConsignacoesPage', () => import('@/pages/gs/ConsignacoesPage'));
export const ConferenciaMaquininhaPage = telaSobDemanda('ConferenciaMaquininhaPage', () => import('@/pages/gs/ConferenciaMaquininhaPage'));
export const CertificadoPage = telaSobDemanda('CertificadoPage', () => import('@/pages/gs/CertificadoPage'));
export const MovimentacoesEstoquePage = telaSobDemanda('MovimentacoesEstoquePage', () => import('@/pages/gs/MovimentacoesEstoquePage'));
export const LocaisEstoquePage = telaSobDemanda('LocaisEstoquePage', () => import('@/pages/gs/LocaisEstoquePage'));
export const ValidadePage = telaSobDemanda('ValidadePage', () => import('@/pages/gs/ValidadePage'));
export const BalancaPage = telaSobDemanda('BalancaPage', () => import('@/pages/gs/BalancaPage'));
export const UnidadesEstoquePage = telaSobDemanda('UnidadesEstoquePage', () => import('@/pages/gs/UnidadesEstoquePage'));
export const ProdutoFormPage = telaSobDemanda('ProdutoFormPage', () => import('@/pages/gs/ProdutoFormPage'));
export const ProntidaoOnlinePage = telaSobDemanda('ProntidaoOnlinePage', () => import('@/pages/gs/ProntidaoOnlinePage'));
export const FornecedoresPage = telaSobDemanda('FornecedoresPage', () => import('@/pages/gs/FornecedoresPage'));
export const TransportadorasPage = telaSobDemanda('TransportadorasPage', () => import('@/pages/gs/TransportadorasPage'));
export const ConfiguracaoEntradaPage = telaSobDemanda('ConfiguracaoEntradaPage', () => import('@/pages/gs/ConfiguracaoEntradaPage'));
export const PedidosCompraPage = telaSobDemanda('PedidosCompraPage', () => import('@/pages/gs/PedidosCompraPage'));
export const ConciliacaoRecebimentoPage = telaSobDemanda('ConciliacaoRecebimentoPage', () => import('@/pages/gs/ConciliacaoRecebimentoPage'));
export const DevolucoesFornecedorPage = telaSobDemanda('DevolucoesFornecedorPage', () => import('@/pages/gs/DevolucoesFornecedorPage'));
export const DevolucoesPage = telaSobDemanda('DevolucoesPage', () => import('@/pages/gs/DevolucoesPage'));
export const InventarioPage = telaSobDemanda('InventarioPage', () => import('@/pages/gs/InventarioPage'));
export const LeadsPage = telaSobDemanda('LeadsPage', () => import('@/pages/gs/LeadsPage'));
export const FidelidadePage = telaSobDemanda('FidelidadePage', () => import('@/pages/gs/FidelidadePage'));
export const LocacaoPage = telaSobDemanda('LocacaoPage', () => import('@/pages/gs/LocacaoPage'));
export const PecasPage = telaSobDemanda('PecasPage', () => import('@/pages/gs/PecasPage'));
export const ConciliacaoBancariaPage = telaSobDemanda('ConciliacaoBancariaPage', () => import('@/pages/gs/ConciliacaoBancariaPage'));
export const LojaAdminPage = telaSobDemanda('LojaAdminPage', () => import('@/pages/gs/LojaAdminPage'));
export const OficinasPage = telaSobDemanda('OficinasPage', () => import('@/pages/gs/OficinasPage'));
export const BiPage = telaSobDemanda('BiPage', () => import('@/pages/gs/BiPage'));
export const RelatoriosPage = telaSobDemanda('RelatoriosPage', () => import('@/pages/gs/RelatoriosPage'));
export const AuditoriaPage = telaSobDemanda('AuditoriaPage', () => import('@/pages/gs/AuditoriaPage'));
export const EquipamentoPublicoPage = telaSobDemanda('EquipamentoPublicoPage', () => import('@/pages/gs/EquipamentoPublicoPage'));
export const EntradaEmailPage = telaSobDemanda('EntradaEmailPage', () => import('@/pages/gs/EntradaEmailPage'));
export const CategoriasMarcasPage = telaSobDemanda('CategoriasMarcasPage', () => import('@/pages/gs/CategoriasMarcasPage'));
export const AuxiliaresCatalogoPage = telaSobDemanda('AuxiliaresCatalogoPage', () => import('@/pages/gs/AuxiliaresCatalogoPage'));
export const AlteracaoRapidaPage = telaSobDemanda('AlteracaoRapidaPage', () => import('@/pages/gs/AlteracaoRapidaPage'));
export const ImpressorasPage = telaSobDemanda('ImpressorasPage', () => import('@/pages/gs/ImpressorasPage'));
export const ImplantacaoPage = telaSobDemanda('ImplantacaoPage', () => import('@/pages/gs/ImplantacaoPage'));
export const BackupPage = telaSobDemanda('BackupPage', () => import('@/pages/gs/BackupPage'));
export const SistemaPage = telaSobDemanda('SistemaPage', () => import('@/pages/gs/SistemaPage'));
export const TerminaisPage = telaSobDemanda('TerminaisPage', () => import('@/pages/gs/TerminaisPage'));
export const MaquininhasPage = telaSobDemanda('MaquininhasPage', () => import('@/pages/gs/MaquininhasPage'));
export const PoliticaVendaPage = telaSobDemanda('PoliticaVendaPage', () => import('@/pages/gs/PoliticaVendaPage'));
export const PoliticaGestaoPage = telaSobDemanda('PoliticaGestaoPage', () => import('@/pages/gs/PoliticaGestaoPage'));
export const EquipamentosPage = telaSobDemanda('EquipamentosPage', () => import('@/pages/gs/EquipamentosPage'));
export const EquipamentoFichaPage = telaSobDemanda('EquipamentoFichaPage', () => import('@/pages/gs/EquipamentoFichaPage'));
export const PlaquinhasPage = telaSobDemanda('PlaquinhasPage', () => import('@/pages/gs/PlaquinhasPage'));
export const EquipePage = telaSobDemanda('EquipePage', () => import('@/pages/gs/EquipePage'));
export const ContasPage = telaSobDemanda('ContasPage', () => import('@/pages/gs/ContasPage'));
export const DrePage = telaSobDemanda('DrePage', () => import('@/pages/gs/DrePage'));
export const FinanceiroCadastrosPage = telaSobDemanda('FinanceiroCadastrosPage', () => import('@/pages/gs/FinanceiroCadastrosPage'));
export const ComissoesPage = telaSobDemanda('ComissoesPage', () => import('@/pages/gs/ComissoesPage'));
export const OperadorasPage = telaSobDemanda('OperadorasPage', () => import('@/pages/gs/OperadorasPage'));
export const FluxoDeCaixaPage = telaSobDemanda('FluxoDeCaixaPage', () => import('@/pages/gs/FluxoDeCaixaPage'));
export const FiscalPage = telaSobDemanda('FiscalPage', () => import('@/pages/gs/FiscalPage'));
export const FiscalDocumentosPage = telaSobDemanda('FiscalDocumentosPage', () => import('@/pages/gs/FiscalDocumentosPage'));
export const FiscalInutilizacoesPage = telaSobDemanda('FiscalInutilizacoesPage', () => import('@/pages/gs/FiscalInutilizacoesPage'));
export const FiscalOperacoesPage = telaSobDemanda('FiscalOperacoesPage', () => import('@/pages/gs/FiscalOperacoesPage'));
export const FechamentoContadorPage = telaSobDemanda('FechamentoContadorPage', () => import('@/pages/gs/FechamentoContadorPage'));
export const IntegracaoAsaasPage = telaSobDemanda('IntegracaoAsaasPage', () => import('@/pages/gs/IntegracaoAsaasPage'));
export const SincronizacaoPage = telaSobDemanda('SincronizacaoPage', () => import('@/pages/gs/SincronizacaoPage'));
export const EmpresasPage = telaSobDemanda('EmpresasPage', () => import('@/pages/gs/EmpresasPage'));
export const ImplantacaoDaEmpresaPage = telaSobDemanda('ImplantacaoDaEmpresaPage', () => import('@/pages/gs/ImplantacaoDaEmpresaPage'));
export const LogisticaPage = telaSobDemanda('LogisticaPage', () => import('@/pages/gs/LogisticaPage'));
export const IntegracoesPage = telaSobDemanda('IntegracoesPage', () => import('@/pages/gs/GestaoPages'), 'IntegracoesPage');
export const MovimentacoesPage = telaSobDemanda('MovimentacoesPage', () => import('@/pages/gs/GestaoPages'), 'MovimentacoesPage');
export const PedidosPage = telaSobDemanda('PedidosPage', () => import('@/pages/gs/GestaoPages'), 'PedidosPage');
export const PromocoesPage = telaSobDemanda('PromocoesPage', () => import('@/pages/gs/GestaoPages'), 'PromocoesPage');
export const CuponsPage = telaSobDemanda('CuponsPage', () => import('@/pages/gs/CuponsPage'));
export const CaixaPage = telaSobDemanda('CaixaPage', () => import('@/pages/gs/OperacaoPages'), 'CaixaPage');
export const ClientesPage = telaSobDemanda('ClientesPage', () => import('@/pages/gs/OperacaoPages'), 'ClientesPage');
export const EstoquePage = telaSobDemanda('EstoquePage', () => import('@/pages/gs/OperacaoPages'), 'EstoquePage');
export const FinanceiroPage = telaSobDemanda('FinanceiroPage', () => import('@/pages/gs/OperacaoPages'), 'FinanceiroPage');
export const ProdutosPage = telaSobDemanda('ProdutosPage', () => import('@/pages/gs/OperacaoPages'), 'ProdutosPage');
export const VendasPage = telaSobDemanda('VendasPage', () => import('@/pages/gs/OperacaoPages'), 'VendasPage');
