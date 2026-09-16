/**
 * Rotas das telas reconstruídas sobre o backend central.
 *
 * São registradas ANTES das rotas legadas, de modo que assumem os caminhos
 * já conhecidos (/login, /sistema/painel, /pdv…) sem exigir alteração no
 * arquivo de configuração legado. As telas antigas continuam acessíveis nos
 * demais caminhos enquanto vão sendo migradas.
 */
import type { RouteObject } from 'react-router-dom';
import type { ReactElement } from 'react';
import { Protected } from './Protected';
import {
  DONOS_DO_GRUPO,
  QUEM_ENTREGA_A_CONTABILIDADE,
  QUEM_MONTA_O_CATALOGO,
  QUEM_RESPONDE_PELA_LOJA,
  QUEM_COTA_FRETE,
  ROTA_CAIXA,
  ROTA_CONTABILIDADE,
  ROTA_GESTAO,
  ROTA_OFICINA,
  ROTA_PDV,
  type Environment,
} from './environments';
/*
  As listas da auditoria integral moram em `navItems.ts` — o menu e o roteador
  têm de citar a MESMA, e este é o módulo que os dois compartilham sem ciclo
  (importar daqui para lá puxaria as setenta telas para dentro do menu). Cada
  uma foi conferida contra o `requireProfile` real do servidor; a razão de
  cada recorte está escrita nelas.
*/
import {
  QUEM_ATENDE_O_CLIENTE,
  QUEM_CONCILIA_RECEBIMENTO,
  QUEM_CONTA_A_PRATELEIRA,
  QUEM_DESFAZ_VENDA,
  QUEM_DEVOLVE_AO_FORNECEDOR,
  QUEM_EMITE_NOTA,
  QUEM_GERENCIA_A_OPERACAO,
  QUEM_VE_A_CONSIGNACAO,
} from '@/components/gs/navItems';
/*
  As quatro telas do pacote inicial (GAP-PRD-210): as duas portas, o PDV — que
  vende sem rede e por isso não pode depender de um pedaço que talvez não tenha
  sido guardado — e o endereço inexistente. Todas as outras vêm de `./telas`,
  cada uma no seu pedaço, baixado quando alguém a abre.
*/
import LoginPage from '@/pages/gs/LoginPage';
import OficinaLoginPage from '@/pages/gs/OficinaLoginPage';
import PdvPage from '@/pages/gs/PdvPage';
import NaoEncontradaPage from '@/pages/gs/NaoEncontradaPage';
import {
  PainelPage,
  OficinaPage,
  OrdemServicoPage,
  EntradaNotasPage,
  ImportacaoPlanilhaPage,
  LojaPage,
  ProdutoLojaPage,
  EntregaLojaPage,
  ProntidaoDoDiaUmPage,
  EmailsPage,
  ConciliacaoAsaasPage,
  MinhaContaPage,
  MeuPedidoPage,
  RedefinirSenhaPage,
  PoliticaDePrivacidadePage,
  TermosDeUsoPage,
  TrocasEDevolucoesPage,
  FotosEmLotePage,
  MeusEquipamentosPage,
  EtiquetasPage,
  OrcamentosPage,
  ConsignacoesPage,
  ConferenciaMaquininhaPage,
  CertificadoPage,
  MovimentacoesEstoquePage,
  LocaisEstoquePage,
  ValidadePage,
  BalancaPage,
  UnidadesEstoquePage,
  ProdutoFormPage,
  ProntidaoOnlinePage,
  FornecedoresPage,
  TransportadorasPage,
  ConfiguracaoEntradaPage,
  PedidosCompraPage,
  ConciliacaoRecebimentoPage,
  DevolucoesFornecedorPage,
  DevolucoesPage,
  InventarioPage,
  LeadsPage,
  FidelidadePage,
  LocacaoPage,
  PecasPage,
  ConciliacaoBancariaPage,
  LojaAdminPage,
  OficinasPage,
  BiPage,
  RelatoriosPage,
  AuditoriaPage,
  EquipamentoPublicoPage,
  EntradaEmailPage,
  CategoriasMarcasPage,
  AuxiliaresCatalogoPage,
  AlteracaoRapidaPage,
  ImpressorasPage,
  ImplantacaoPage,
  BackupPage,
  SistemaPage,
  TerminaisPage,
  MaquininhasPage,
  PoliticaVendaPage,
  PoliticaGestaoPage,
  EquipamentosPage,
  EquipamentoFichaPage,
  PlaquinhasPage,
  EquipePage,
  ContasPage,
  DrePage,
  FinanceiroCadastrosPage,
  ComissoesPage,
  OperadorasPage,
  FluxoDeCaixaPage,
  FiscalPage,
  FiscalDocumentosPage,
  FiscalInutilizacoesPage,
  FiscalOperacoesPage,
  FechamentoContadorPage,
  IntegracaoAsaasPage,
  SincronizacaoPage,
  EmpresasPage,
  ImplantacaoDaEmpresaPage,
  LogisticaPage,
  IntegracoesPage,
  MovimentacoesPage,
  PedidosPage,
  PromocoesPage,
  CaixaPage,
  ClientesPage,
  EstoquePage,
  FinanceiroPage,
  ProdutosPage,
  VendasPage,
  RetornoDoGooglePage,
  LoginGooglePage,
  CuponsPage,
  AcessoNegadoPage,
} from './telas';
/**
 * Rota protegida por AMBIENTE.
 *
 * Sem ambiente declarado a rota exigiria só sessão — e foi exatamente isso que
 * deixou o painel do gestor acessível pelo PDV. Por isso o parâmetro é
 * obrigatório: esquecer de declarar passa a ser erro de compilação, não um
 * furo silencioso.
 */
const protectedRoute = (
  path: string,
  element: ReactElement,
  environments: Environment[],
  /**
   * Perfis, quando ambiente não descreve o guarda do servidor.
   *
   * OPCIONAL de propósito, ao contrário de `environments`. Ambiente é
   * obrigatório porque esquecê-lo abria o painel do gestor para o PDV — falha
   * ABERTA. Perfil é o inverso: a ausência restringe nada, e toda tela do
   * escritório que serve o escritório inteiro continua servindo. Torná-lo
   * obrigatório obrigaria sessenta rotas a repetir "todos", que é ruído sem
   * informação.
   */
  profiles?: readonly string[],
): RouteObject => ({
  path,
  element: (
    <Protected environments={environments} profiles={profiles}>
      {element}
    </Protected>
  ),
});

export const gsRoutes: RouteObject[] = [
  // Home publica: portal do Grupo Sampaio, nao a vitrine de uma operacao.
  { path: '/', element: <LojaPage /> },
  { path: '/loja', element: <LojaPage /> },
  // Página pública do produto. A loja vai na URL e o servidor confere: item
  // de outra operação não existe neste endereço.
  { path: '/loja/:storeSlug/produto/:productId', element: <ProdutoLojaPage /> },
  // Portal do cliente. Sessão própria, separada da administrativa: quem
  // comprou não ganha escopo de PDV nem de gerente.
  { path: '/minha-conta', element: <MinhaContaPage /> },
  { path: '/minha-conta/pedidos/:orderId', element: <MeuPedidoPage /> },
  // A volta do "Entrar com Google" (GAP-PRD-027): é o endereço de retorno
  // cadastrado no cliente OAuth. Pública — quem chega ainda não tem sessão.
  { path: '/minha-conta/google', element: <RetornoDoGooglePage /> },
  // A tela que o link do e-mail de recuperacao abre. Publica: o token e a credencial.
  { path: '/redefinir-senha', element: <RedefinirSenhaPage /> },
  // As páginas legais (rodada 45): estáticas de 1 segmento ganham de
  // /:storeSlug pelo ranking do próprio router — e ficam aqui por convenção.
  { path: '/politica-de-privacidade', element: <PoliticaDePrivacidadePage /> },
  { path: '/termos-de-uso', element: <TermosDeUsoPage /> },
  { path: '/trocas-e-devolucoes', element: <TrocasEDevolucoesPage /> },
  /*
    A página da MARCA (rodada 40): /preco-justo, /me-mimei, /conceito,
    /pj-motors, /gringa. Dinâmica porque as lojas vêm do banco. O React Router
    ranqueia caminho específico acima do dinâmico, então /login, /pdv e
    /sistema (a porta do painel) continuam ganhando; slug desconhecido mostra "esta loja não
    existe" com o caminho de volta. A Oficina não tem página: não é loja.
  */
  { path: '/:storeSlug', element: <LojaPage /> },
  // Portal do cliente, e não do ERP: a sessão é a do portal e a tela não tem
  // menu administrativo. Fora do roteador protegido de propósito.
  { path: '/minha-conta/equipamentos', element: <MeusEquipamentosPage /> },
  // A PLAQUINHA LEVA AQUI. Rota pública: quem escaneia o QR colado no
  // equipamento não tem conta, e exigir login mataria a plaquinha. Vem ANTES da
  // rota legada homônima, que só respondia para a sessão antiga.
  { path: '/equipamento/:token', element: <EquipamentoPublicoPage /> },
  { path: '/login', element: <LoginPage /> },
  // Porta da bancada. Pública como qualquer login, e separada de propósito:
  // `Protected` manda para cá quem tenta abrir rota de oficina sem sessão.
  { path: '/oficina/login', element: <OficinaLoginPage /> },
  /*
    A PORTA DO SISTEMA. Não havia rota /sistema: o endereço que a pessoa
    digita para chegar à gestão caía em /:storeSlug e respondia "Esta loja não
    existe". /sistema abre o painel, com o MESMO guarda de /sistema/painel —
    sem sessão, o guarda manda ao login.
  */
  protectedRoute('/sistema', <PainelPage />, ROTA_GESTAO),
  protectedRoute('/sistema/painel', <PainelPage />, ROTA_GESTAO),
  protectedRoute('/pdv', <PdvPage />, ROTA_PDV),
  protectedRoute('/sistema/produtos', <ProdutosPage />, ROTA_GESTAO),
  protectedRoute('/sistema/produtos/categorias', <CategoriasMarcasPage />, ROTA_GESTAO),
  // Vem ANTES de /sistema/produtos/:id, senão 'auxiliares' vira um id.
  protectedRoute('/sistema/produtos/auxiliares', <AuxiliaresCatalogoPage />, ROTA_GESTAO),
  // Também antes de /sistema/produtos/:id, pelo mesmo motivo.
  protectedRoute('/sistema/produtos/alteracao-rapida', <AlteracaoRapidaPage />, ROTA_GESTAO),
  // Vem ANTES de /sistema/produtos/:id, senao 'prontidao-online' vira um id.
  protectedRoute('/sistema/produtos/prontidao-online', <ProntidaoOnlinePage />, ROTA_GESTAO),
  protectedRoute('/sistema/produtos/novo', <ProdutoFormPage />, ROTA_GESTAO),
  protectedRoute('/sistema/produtos/:id', <ProdutoFormPage />, ROTA_GESTAO),
  protectedRoute('/sistema/estoque', <EstoquePage />, ROTA_GESTAO),
  protectedRoute('/sistema/clientes', <ClientesPage />, ROTA_GESTAO),
  protectedRoute('/sistema/caixa', <CaixaPage />, ROTA_CAIXA),
  protectedRoute('/sistema/vendas', <VendasPage />, ROTA_GESTAO),
  protectedRoute('/sistema/orcamentos', <OrcamentosPage />, ROTA_GESTAO),
  /*
    CONSIGNAÇÃO (GAP-V65). A lista repete `abertaAo('balcao', 'escritorio')`
    por inteiro, caixas inclusive — quem não é do ambiente já é barrado pelo
    AMBIENTE, e uma lista mais estreita que o servidor viraria a segunda
    verdade que envelhece sozinha. O recorte está justificado rota a rota em
    `QUEM_VE_A_CONSIGNACAO`.
  */
  protectedRoute(
    '/sistema/consignacoes',
    <ConsignacoesPage />,
    ROTA_GESTAO,
    QUEM_VE_A_CONSIGNACAO,
  ),
  /*
    A RODADA DA AUDITORIA INTEGRAL: as quinze rotas abaixo (e as vizinhas
    marcadas uma a uma) declaravam só `ROTA_GESTAO`, e o servidor de cada uma
    é mais estreito que o escritório — a porta que bate na cara, proibida
    desde a rodada 23 e fechada aqui pelo mesmo mecanismo das cinco telas de
    e-commerce. O guarda real de cada rota está citado na lista que ela usa,
    e `audit-portas.test.tsx` cobra os dois sentidos: o excluído não entra, o
    permitido não perde.
  */
  protectedRoute(
    '/sistema/conferencia-maquininha',
    <ConferenciaMaquininhaPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  // `requireProfile(req)` sem perfil extra nas três rotas do A1: só os donos
  // do grupo — o certificado assina nota em nome da empresa.
  protectedRoute('/sistema/fiscal/certificado', <CertificadoPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  protectedRoute(
    '/sistema/fiscal/configuracao',
    <FiscalPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  // Gerência e caixas: o caixa emite a nota da própria venda. Ver
  // `QUEM_EMITE_NOTA` — o ambiente continua barrando o balcão desta rota.
  protectedRoute(
    '/sistema/fiscal/documentos',
    <FiscalDocumentosPage />,
    ROTA_GESTAO,
    QUEM_EMITE_NOTA,
  ),
  protectedRoute(
    '/sistema/fiscal/inutilizacoes',
    <FiscalInutilizacoesPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  /*
    OPERAÇÕES FISCAIS — a tela que faltava para três rotas que já existiam.

    `GET /core/fiscal/operacoes` e `GET /core/fiscal/pendencias-contabeis` são
    `fiscal.view`; `PUT /core/fiscal/operacoes/:operacao` é
    `fiscal.policy.manage`. As duas capabilities param no mesmo conjunto de
    perfis de hoje (`QUEM_GERENCIA_A_OPERACAO`), e a lista é a mesma das
    vizinhas do Fiscal — o menu declara a mesma, e `menu-e-rotas.test.tsx`
    cobra os dois lados.
  */
  protectedRoute(
    '/sistema/fiscal/operacoes',
    <FiscalOperacoesPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  /*
    O PACOTE DO CONTADOR — a única tela do Fiscal com recorte de perfil.

    As duas rotas de `/core/fiscal/closings` nomeiam `gerente_loja` e
    `gerente_oficina`. A frase que estava aqui — "e não `abertaAo(req,
    'escritorio')` como as vizinhas" — saiu por ser falsa: as vizinhas também
    nomeiam gente, e nenhuma delas aceita estoquista ou atendente. O que faz
    esta tela ser a única do Fiscal com `profiles` no roteador não é o guarda
    do servidor ser diferente; é ela ser a única em que alguém escreveu a
    lista dos dois lados. As outras quatro estão relatadas como achado.
    Não é inconsistência do servidor: baixar o pacote leva a contabilidade
    inteira de um mês para fora da empresa, e o escritório inclui estoquista e
    atendente. `ROTA_GESTAO` sozinha abriria a tela para eles e as duas
    chamadas dela responderiam 403 — a porta que bate na cara, proibida desde
    a rodada 23. Ver `QUEM_ENTREGA_A_CONTABILIDADE`, que o menu cita também.

    E, desde a rodada 29, é também a ÚNICA TELA DO SISTEMA que o ambiente
    `contabilidade` abre — por isso `ROTA_CONTABILIDADE` no lugar de
    `ROTA_GESTAO`. As duas dimensões continuam valendo juntas, e cada uma faz
    um trabalho diferente aqui:

      - o AMBIENTE deixa o contador entrar (ele não está em `gestao`);
      - o PERFIL continua barrando estoquista e atendente, que estão.

    Esta é também a CASA do contador (`CASA.contabilidade`), e é o que torna a
    lista de perfis obrigatória de um jeito novo: `Protected` devolve para casa
    quem o perfil recusa, então um contador fora de `QUEM_ENTREGA_A_CONTABILIDADE`
    seria devolvido para a tela que acabou de recusá-lo, em laço. É o único
    destino de `CASA` que declara perfil, e há caso nomeado cobrando que o dono
    do ambiente caiba nele.
  */
  protectedRoute(
    '/sistema/fiscal/fechamento',
    <FechamentoContadorPage />,
    ROTA_CONTABILIDADE,
    QUEM_ENTREGA_A_CONTABILIDADE,
  ),
  protectedRoute('/sistema/configuracoes/impressoras', <ImpressorasPage />, ROTA_GESTAO),
  // A conferência da publicação (GAP-PRD-013). `GET /system/implantacao` é
  // `system-readiness.view`: `admin_geral` e `gestor`, e mais ninguém.
  protectedRoute('/sistema/configuracoes/implantacao', <ImplantacaoPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  // O estado do backup (GAP-PRD-011). `GET /system/backup/status` é
  // `system-backup.view`: `admin_geral` e `gestor` — o banco é das seis empresas.
  protectedRoute('/sistema/configuracoes/backup', <BackupPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  // Versão, banco, cofre e últimos erros (GAP-PRD-064). As três rotas que a
  // tela lê são de `admin_geral` e `gestor` — o que os documentos de operação
  // chamavam de "status", "saúde" e "prontidão".
  protectedRoute('/sistema/configuracoes/sistema', <SistemaPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  // Caixas e terminais (GAP-PRD-039/150): cadastrar caixa é `requireProfile`
  // de gerente no servidor; o token sem senha, só do dono do grupo (a tela
  // explica em vez de oferecer o botão).
  protectedRoute(
    '/sistema/configuracoes/terminais',
    <TerminaisPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  // Maquininhas (GAP-PRD-076): cadastrar, parear o agente, homologar e
  // desfazer cobrança pedem gerência no servidor (`requireProfile` de
  // gerente_loja/gerente_oficina em /payment-terminals e /pdv/terminal/configurations).
  protectedRoute(
    '/sistema/configuracoes/maquininhas',
    <MaquininhasPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  /*
    Política comercial do balcão — o limite de desconto, o prazo do fiado e a
    validade da pré-venda.

    ROTA_GESTAO, e não uma lista mais estreita, porque ambiente NÃO é perfil: os
    ambientes são três (pdv, oficina, gestao) e toda tela de configuração mora
    na gestão. Quem fecha de verdade é o servidor, que exige gerente_loja ou
    gerente_oficina em `/core/sale-policies` — estoquista e atendente alcançam a
    casca e recebem 403 no dado, com a tela dizendo que a decisão não é do
    balcão. Inventar aqui um quarto ambiente para uma tela só desalinharia o
    menu do roteador, que é o defeito que `menu-e-rotas.test.tsx` existe para
    pegar.
  */
  protectedRoute('/sistema/configuracoes/politica-de-venda', <PoliticaVendaPage />, ROTA_GESTAO),
  /*
    POLÍTICA DE GESTÃO (GAP-PRD-165/166) — ROTA_GESTAO sem lista, e conferido
    contra o servidor: `GET /core/management-policy` é `abertaAo('escritorio')`
    (o atendente que não vê o faturamento lê AQUI que é decisão, e não defeito).
    SALVAR é dos donos (`requireProfile(req)` no PUT), e a tela esconde o botão
    de quem não é — o mesmo desenho da Política do balcão.
  */
  protectedRoute('/sistema/configuracoes/politica-de-gestao', <PoliticaGestaoPage />, ROTA_GESTAO),
  protectedRoute('/sistema/financeiro', <FinanceiroPage />, ROTA_GESTAO),
  // Mesma tela para os dois lados: o lançamento é o mesmo, muda a direção.
  protectedRoute('/sistema/financeiro/contas-a-receber', <ContasPage />, ROTA_GESTAO),
  protectedRoute('/sistema/financeiro/contas-a-pagar', <ContasPage />, ROTA_GESTAO),
  /*
    O DRE — e o ambiente aqui foi CONFERIDO contra o guarda do servidor, não
    suposto.

    A rota do servidor é `abertaAo(req, 'escritorio')`, e `ESCRITORIO` são
    gerente_loja, gerente_oficina, estoquista e atendente (com admin_geral e
    gestor por cima, dentro de `requireProfile`). `ROTA_GESTAO` deixa chegar
    exatamente esse conjunto. Os dois batem.

    Uma lista mais estreita aqui esconderia a tela de quem o servidor atende;
    uma mais larga ofereceria uma porta que bate na cara. É a regra que a
    rodada 23 criou, e a 24 não pode ser a primeira a violá-la.
  */
  protectedRoute('/sistema/financeiro/dre', <DrePage />, ROTA_GESTAO),
  protectedRoute('/sistema/financeiro/cadastros', <FinanceiroCadastrosPage />, ROTA_GESTAO),
  protectedRoute(
    '/sistema/financeiro/comissoes',
    <ComissoesPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  protectedRoute(
    '/sistema/financeiro/operadoras',
    <OperadorasPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  // Fluxo de caixa projetado (GAP-PRD-094): a rota do servidor nomeia os
  // dois gerentes, como a de Cadastros, que já mostra o saldo das contas.
  protectedRoute(
    '/sistema/financeiro/fluxo-de-caixa',
    <FluxoDeCaixaPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  // Destino do mecânico após autenticar.
  protectedRoute('/sistema/oficina', <OficinaPage />, ROTA_OFICINA),
  protectedRoute('/sistema/oficina/os/:id', <OrdemServicoPage />, ROTA_OFICINA),
  // Vem ANTES da rota legada homônima, que só respondia para a sessão antiga
  // e por isso mandava todo mundo de volta para o login.
  protectedRoute('/sistema/equipamentos', <EquipamentosPage />, ROTA_OFICINA),
  /*
    A FICHA da máquina (rodada 52) — mesmo ambiente da lista.

    Sem item de menu, como a OS: chega-se por ela clicando na plaquinha. O
    histórico do equipamento (`core_equipment_events`) gravava desde que
    nasceu e nenhuma tela lia; esta é a leitora.
  */
  /*
    O POOL DE PLAQUINHAS (rodada 53).

    Vem ANTES de /sistema/equipamentos/:id: o roteador casa por ordem, e
    declarada depois esta tela seria engolida pela ficha, que a leria como
    um equipamento de id "plaquinhas".
  */
  protectedRoute('/sistema/equipamentos/plaquinhas', <PlaquinhasPage />, ROTA_OFICINA),
  protectedRoute('/sistema/equipamentos/:id', <EquipamentoFichaPage />, ROTA_OFICINA),
  // Mecânicos e usuários são a MESMA tela: a pessoa é uma só, o que muda é o
  // perfil. Duas telas seriam duas verdades sobre quem tem acesso — e por
  // isso o MESMO guarda nas duas portas: toda rota de `/core/team` nomeia os
  // gerentes.
  protectedRoute(
    '/sistema/oficina/mecanicos',
    <EquipePage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  protectedRoute('/sistema/usuarios', <EquipePage />, ROTA_GESTAO, QUEM_GERENCIA_A_OPERACAO),
  protectedRoute('/sistema/compras/entrada-notas', <EntradaNotasPage />, ROTA_GESTAO),
  /*
    A IRMÃ DA ENTRADA DE NOTAS — mesmo gesto, origem diferente.

    Fica declarada ao lado dela porque é o mesmo desenho (arquivo sobe, vira
    lista conferível, botão confirma) e quem for mexer numa deve enxergar a
    outra. O CAMINHO, porém, é de estoque e não de compras: planilha não tem
    fornecedor, não gera título a pagar e não é documento fiscal — ver a nota
    em `navItems.ts`.

    Declara PERFIL, ao contrário da entrada de notas, porque o guarda do
    servidor aqui é mais estreito que o ambiente: `/core/import/produtos` recusa
    o atendente em todas as seis rotas, e ROTA_GESTAO sozinha o deixaria entrar
    numa tela em que nada responde. Ver `QUEM_MONTA_O_CATALOGO`.
  */
  protectedRoute(
    '/sistema/estoque/importacao-planilha',
    <ImportacaoPlanilhaPage />,
    ROTA_GESTAO,
    QUEM_MONTA_O_CATALOGO,
  ),
  protectedRoute('/sistema/compras/nfe-email', <EntradaEmailPage />, ROTA_GESTAO),
  protectedRoute('/sistema/compras/fornecedores', <FornecedoresPage />, ROTA_GESTAO),
  protectedRoute('/sistema/compras/transportadoras', <TransportadorasPage />, ROTA_GESTAO),
  protectedRoute('/sistema/compras/configuracao', <ConfiguracaoEntradaPage />, ROTA_GESTAO),
  protectedRoute('/sistema/compras/pedidos', <PedidosCompraPage />, ROTA_GESTAO),
  /*
    A conciliação pedido × NF-e declara PERFIL porque as rotas de pedido de
    compra (`/core/purchase-orders*`) recusam o atendente — `ROTA_GESTAO`
    sozinha o deixaria entrar numa tela em que toda chamada volta 403. A
    MESMA lista guarda o item de menu; ver `QUEM_CONCILIA_RECEBIMENTO`.
  */
  protectedRoute(
    '/sistema/compras/conciliacao',
    <ConciliacaoRecebimentoPage />,
    ROTA_GESTAO,
    QUEM_CONCILIA_RECEBIMENTO,
  ),
  // GAP-PRD-089: as leituras da tela recusam o atendente; a MESMA lista guarda
  // o item de menu. Ver `QUEM_DEVOLVE_AO_FORNECEDOR`.
  protectedRoute(
    '/sistema/compras/devolucoes',
    <DevolucoesFornecedorPage />,
    ROTA_GESTAO,
    QUEM_DEVOLVE_AO_FORNECEDOR,
  ),
  /*
    CANCELAMENTOS E DEVOLUÇÕES — e aqui a lista CRESCEU, em vez de encolher.

    Ela nomeava só a gerência e os caixas, espelhando o guarda antigo de
    `GET /core/sale-returns`. O defeito apareceu quando as ESCRITAS da tela
    (`POST /sales/:id/cancel` e `POST /sale-returns`) viraram
    `abertaAo('escritorio')` + `comLiberacaoPontual`: o recurso foi construído
    para o estoquista e o atendente chamarem um gestor ali mesmo, e o
    `Protected` os devolvia para casa antes de a tela montar. O ramo
    `CORE_RETURN_NEEDS_AUTHORIZATION` ficou sem NENHUM usuário alcançável.

    As duas leituras do mount agora são `abertaAo('balcao', 'escritorio')`, e
    `QUEM_DESFAZ_VENDA` repete esse conjunto por inteiro — a mesma lista guarda
    o item de menu.
  */
  protectedRoute('/sistema/vendas/devolucoes', <DevolucoesPage />, ROTA_GESTAO, QUEM_DESFAZ_VENDA),
  /*
    AJUSTES E INVENTÁRIO declara PERFIL pelo mesmo motivo da conciliação de
    recebimento logo acima: as quatro rotas de contagem
    (`/core/inventory-counts*`) recusam o ATENDENTE, e `ROTA_GESTAO` sozinha o
    deixava entrar numa tela que monta inteira e vazia, com toda chamada
    voltando 403. A MESMA lista guarda o item de menu; ver
    `QUEM_CONTA_A_PRATELEIRA`.
  */
  protectedRoute(
    '/sistema/estoque/inventario',
    <InventarioPage />,
    ROTA_GESTAO,
    QUEM_CONTA_A_PRATELEIRA,
  ),
  // As três abaixo ficam fora do alcance do estoquista: as rotas de CRM,
  // fidelidade e locação nomeiam quem atende gente. Ver `QUEM_ATENDE_O_CLIENTE`.
  protectedRoute('/sistema/crm/leads', <LeadsPage />, ROTA_GESTAO, QUEM_ATENDE_O_CLIENTE),
  protectedRoute('/sistema/crm/fidelidade', <FidelidadePage />, ROTA_GESTAO, QUEM_ATENDE_O_CLIENTE),
  protectedRoute(
    '/sistema/locacao/contratos',
    <LocacaoPage />,
    ROTA_GESTAO,
    QUEM_ATENDE_O_CLIENTE,
  ),
  // A bancada também vê: é a gaveta de peças do mecânico.
  protectedRoute('/sistema/oficina/pecas', <PecasPage />, ROTA_OFICINA),
  protectedRoute(
    '/sistema/financeiro/conciliacao',
    <ConciliacaoBancariaPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  /*
    AS QUATRO TELAS DA LOJA ONLINE declaram perfil, e não só ambiente.

    O servidor delas guarda com `gerente_loja`/`gerente_oficina`.
    `ROTA_GESTAO` sozinha deixava o estoquista e o atendente entrarem numa
    tela que monta inteira e responde 403 em cada chamada. Ver
    `QUEM_RESPONDE_PELA_LOJA`.
  */
  protectedRoute(
    '/sistema/loja/administracao',
    <LojaAdminPage />,
    ROTA_GESTAO,
    QUEM_RESPONDE_PELA_LOJA,
  ),
  // O guarda da tela casa com o do servidor (a revisão mordeu: atendente
  // alcançava a tela e colecionava 403).
  protectedRoute('/sistema/loja/fotos', <FotosEmLotePage />, ROTA_GESTAO, QUEM_MONTA_O_CATALOGO),
  protectedRoute('/sistema/oficina/oficinas', <OficinasPage />, ROTA_GESTAO),
  // `/core/insights/*` nomeia os gerentes: comparar as operações é leitura
  // de quem responde por elas.
  protectedRoute('/sistema/relatorios/bi', <BiPage />, ROTA_GESTAO, QUEM_GERENCIA_A_OPERACAO),
  /*
    A CENTRAL DE RELATÓRIOS (GAP-V37) — e o alcance foi conferido contra o
    servidor, não suposto: `GET /core/reports` e `GET /core/reports/:id` são
    `requireProfile(req, 'gerente_loja', 'gerente_oficina')`.

    Ela é MAIS ESTREITA que várias das telas que a alimentam (a Posição de
    estoque é `abertaAo('escritorio')`, por exemplo), e é de propósito: a
    Central junta num lugar só o custo do estoque, a comissão por vendedor e a
    margem — três coisas que o servidor recusa ao estoquista e ao atendente em
    telas separadas. Reunir tudo numa tela larga daria por acidente o que
    quatro guardas negam de propósito. A mesma lista está no item de menu.
  */
  protectedRoute(
    '/sistema/relatorios/central',
    <RelatoriosPage />,
    ROTA_GESTAO,
    QUEM_GERENCIA_A_OPERACAO,
  ),
  /*
    A TRILHA DE AUDITORIA — e o alcance foi CONFERIDO contra o guarda do
    servidor, não suposto.

    `GET /core/audit` é `requireProfile(req)` sem perfil extra: `admin_geral` e
    `gestor`, e mais ninguém — a auditoria expõe as ações de todo mundo,
    inclusive as dos gerentes, e o vigiado não lê o próprio diário de
    vigilância (o 403 do gerente está provado em
    `server/tests/auditoria-tem-leitor.test.ts`). `ROTA_GESTAO` sozinha seria
    uma porta que bate na cara de quatro perfis; `DONOS_DO_GRUPO` fecha a
    diferença, e a mesma lista está no item de menu.
  */
  protectedRoute('/sistema/relatorios/auditoria', <AuditoriaPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  protectedRoute('/sistema/estoque/movimentacoes', <MovimentacoesEstoquePage />, ROTA_GESTAO),
  protectedRoute('/sistema/estoque/locais', <LocaisEstoquePage />, ROTA_GESTAO),
  /*
    VALIDADE E LOTES (GAP-V35). `ROTA_GESTAO` sem lista extra, como as outras
    telas de estoque, e isso foi CONFERIDO contra o servidor em vez de suposto:
    `GET /stock/batches` e `GET /stock/batches/alertas` são `abertaAo('escritorio')`
    — o MESMO alcance de `GET /stock`, que a tela de posição já usa. Nenhum
    perfil do escritório bate na cara aqui.

    A escrita (cadastrar lote, conferir, alocar) é mais estreita no servidor —
    gerentes e estoquista, como `POST /stock/locations` —, e essa assimetria já
    é o desenho aceito de Locais de estoque: quem só lê entra e vê; quem
    organiza a prateleira é quem mexe.
  */
  protectedRoute('/sistema/estoque/validade', <ValidadePage />, ROTA_GESTAO),
  protectedRoute('/sistema/estoque/unidades', <UnidadesEstoquePage />, ROTA_GESTAO),
  protectedRoute('/sistema/promocoes', <PromocoesPage />, ROTA_GESTAO),
  // Cupons da loja online (GAP-PRD-123): mesma alçada de Promoções.
  protectedRoute('/sistema/cupons', <CuponsPage />, ROTA_GESTAO),
  protectedRoute('/sistema/etiquetas', <EtiquetasPage />, ROTA_GESTAO),
  protectedRoute('/sistema/balanca', <BalancaPage />, ROTA_GESTAO),
  protectedRoute('/sistema/pedidos', <PedidosPage />, ROTA_GESTAO),
  // Onde o dono declara se a loja entrega e por quanto. Sem esta tela, todo
  // pedido online nascia como entrega com frete zero.
  protectedRoute(
    '/sistema/loja/entrega',
    <EntregaLojaPage />,
    ROTA_GESTAO,
    QUEM_RESPONDE_PELA_LOJA,
  ),
  // O que falta configurar, loja por loja (GAP-PRD-034). O mesmo alcance das
  // telas que resolvem os itens — e do servidor da lista.
  protectedRoute('/sistema/loja/prontidao', <ProntidaoDoDiaUmPage />, ROTA_GESTAO, QUEM_RESPONDE_PELA_LOJA),
  // Transportadoras e cotação. O módulo já existia inteiro no servidor e era
  // inalcançável: toda rota de `/logistics` exige um perfil chamado
  // "logistics.view", que ninguém tem.
  // E aqui quem fica de fora é o gerente da OFICINA: quem despacha
  // encomenda é quem embala, e a bancada não embala. Ver `QUEM_COTA_FRETE`.
  protectedRoute('/sistema/loja/logistica', <LogisticaPage />, ROTA_GESTAO, QUEM_COTA_FRETE),
  // A fila de e-mail é visível para que "pronto para a credencial" seja uma
  // afirmação conferível, e não uma promessa.
  protectedRoute('/sistema/loja/emails', <EmailsPage />, ROTA_GESTAO, QUEM_RESPONDE_PELA_LOJA),
  protectedRoute('/sistema/integracoes', <IntegracoesPage />, ROTA_GESTAO),
  protectedRoute('/sistema/integracoes/asaas', <IntegracaoAsaasPage />, ROTA_GESTAO),
  // Entrar com Google na loja (GAP-PRD-027): configuração da INSTALAÇÃO, e o
  // servidor guarda com requireProfile(req) sem perfil extra — os donos do grupo.
  protectedRoute('/sistema/integracoes/google', <LoginGooglePage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  // Confere o extrato do provedor contra o financeiro. Só relata — corrigir é
  // decisão de quem responde pelo caixa.
  protectedRoute(
    '/sistema/integracoes/asaas/conciliacao',
    <ConciliacaoAsaasPage />,
    ROTA_GESTAO,
    QUEM_RESPONDE_PELA_LOJA,
  ),
  // Banco central: a fila que sobe do nó local para a Supabase.
  // Só quem o servidor atende em `GET /core/sync/status` (GAP-PRD-136).
  protectedRoute(
    '/sistema/integracoes/central',
    <SincronizacaoPage />,
    ROTA_GESTAO,
    QUEM_RESPONDE_PELA_LOJA,
  ),
  /*
    AS EMPRESAS DO GRUPO — a primeira rota do sistema com recorte de PERFIL, e
    o alcance foi conferido contra o servidor, não suposto.

    `GET`/`POST /core/companies` são guardadas por `requireProfile(req)` SEM
    perfil extra. Lendo a implementação (`server/src/routes/v1/core.ts`), isso
    devolve cedo para `admin_geral` e `gestor` e recusa todo o resto com 403 —
    inclusive `gerente_loja`, `estoquista` e `atendente`, que `ROTA_GESTAO`
    deixa entrar.

    `ROTA_GESTAO` sozinha seria, portanto, uma porta que bate na cara de quatro
    perfis: exatamente o desalinhamento que a rodada 23 proibiu e que
    `menu-e-rotas.test.tsx` cobra. `DONOS_DO_GRUPO` fecha a diferença, e a
    mesma lista está no item de menu — as três declarações dizem a mesma coisa
    e o teste quebra se uma delas mudar sozinha.
  */
  protectedRoute('/sistema/empresas', <EmpresasPage />, ROTA_GESTAO, DONOS_DO_GRUPO),
  // O checklist de implantação de cada empresa (GAP-PRD-067). O servidor guarda
  // com `system-readiness.view` (admin_geral e gestor) E vínculo de gestão na
  // empresa pedida — a mesma lista da tela de Empresas, de onde se chega.
  protectedRoute(
    '/sistema/empresas/:companyId/implantacao',
    <ImplantacaoDaEmpresaPage />,
    ROTA_GESTAO,
    DONOS_DO_GRUPO,
  ),
  /**
   * Último de todos, e é onde as 350 rotas legadas terminavam.
   *
   * Enquanto elas existiam, um endereço antigo caía numa tela que exigia a
   * sessão legada e mandava a pessoa para o login — um beco sem saída que
   * parecia problema de senha. Agora diz o que é: o endereço não existe.
   */
  /**
   * A casa de quem ainda não tem nenhuma página liberada (acesso granular): a
   * sessão existe, mas o acesso está vazio — diz isso, em vez de mandar ao login.
   */
  { path: '/sem-acesso', element: <Protected><AcessoNegadoPage /></Protected> },
  { path: '*', element: <NaoEncontradaPage /> },
];
