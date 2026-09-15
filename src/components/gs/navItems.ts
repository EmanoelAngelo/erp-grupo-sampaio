/**
 * Menu do sistema — estrutura administrativa completa do gestor.
 *
 * Cada grupo tem ícone, rótulo em caixa alta e subitens, como na referência.
 * Subitens podem trazer uma linha de apoio em itálico (`hint`), igual ao
 * "Importação de XML e manual" do menu de referência.
 *
 * Módulo ainda não construído entra com `pending: true`: aparece para dar a
 * dimensão do sistema, mas NÃO vira link — link quebrado para preencher menu
 * é pior que ausência.
 *
 * `environments` restringe a exibição. Um mecânico via Financeiro, Vendas e
 * Estoque no menu porque só UM grupo declarava restrição — o resto aparecia
 * para todo mundo. Nada vazava (o backend recusa em cada requisição), mas
 * oferecer porta que a pessoa não pode abrir é convite a chamado.
 *
 * O padrão é `['gestao']`: este menu É o do escritório. Grupo que também serve
 * a outro ambiente declara isso explicitamente.
 *
 * E é esse padrão que faz o AMBIENTE NOVO nascer fechado. Quando
 * `contabilidade` apareceu, na rodada 29, o contador não passou a ver nada:
 * todo grupo sem declaração continuou valendo só para a gestão, e o único item
 * que ele enxerga é o que foi aberto por escrito. O trabalho da rodada não foi
 * esconder quatorze itens dele — foi mostrar um.
 */

import {
  DONOS_DO_GRUPO,
  QUEM_ENTREGA_A_CONTABILIDADE,
  QUEM_MONTA_O_CATALOGO,
  QUEM_RESPONDE_PELA_LOJA,
  QUEM_COTA_FRETE,
  ROTA_CONTABILIDADE,
  ROTA_GESTAO,
  type Environment,
} from '@/router/environments';
import { EMPRESA_DAS_PLAQUINHAS } from '@/lib/acesso/plaquinhaDaEmpresa';
import type { NavIconName } from './icons';

/*
  ==========================================================================
  AS LISTAS DA AUDITORIA INTEGRAL — quinze portas que batiam na cara
  ==========================================================================

  A auditoria mediu o resto do estoque do defeito que a rodada 95 fechou nas
  cinco telas de e-commerce: itens de menu e rotas do roteador abertos a
  perfis que o servidor recusa com 403 em TODA chamada da tela. Cada lista
  abaixo foi conferida contra o `requireProfile` real em
  `server/src/routes/v1/core.ts`, rota a rota — nenhuma foi suposta.

  `admin_geral` e `gestor` entram em todas porque `requireProfile` os libera
  antes de olhar qualquer lista.

  Elas moram AQUI, e não em `environments.ts` como as irmãs mais velhas,
  porque o menu e o roteador precisam citar a MESMA lista e este é o módulo
  que os dois já compartilham sem ciclo (`gsRoutes` importa daqui; o inverso
  puxaria as setenta telas para dentro do menu). O dia em que
  `environments.ts` for reaberto, o lugar certo é lá, junto das outras.

  `audit-portas.test.tsx` percorre as quinze telas nos dois sentidos: o
  perfil excluído não vê o item nem alcança a rota, e o permitido continua
  vendo — o recorte não pode virar tesoura.
*/

/**
 * Quem GERENCIA uma operação — os dois donos e os dois gerentes.
 *
 * É o conjunto exato de `requireProfile(req, 'gerente_loja',
 * 'gerente_oficina')`, o guarda mais comum do escritório. Dez telas o usam, e
 * as rotas de cada uma foram lidas uma a uma: configuração fiscal
 * (`/fiscal/config`, `/fiscal/readiness`, `/fiscal/series`), inutilização
 * (`/fiscal/void-ranges`), BI (`/insights/*`), comissões (`/commissions/*`),
 * equipe (`/team/*` — duas portas de menu, a mesma tela), operadoras
 * (`/acquirers/*`), conciliação bancária (`/bank/*`) e conferência de
 * maquininha (`/pdv/terminal/uncertain` e `/reconcile`).
 *
 * NÃO é um apelido de `QUEM_RESPONDE_PELA_LOJA`, apesar de hoje os quatro
 * nomes coincidirem: aquela lista diz quem responde pela LOJA ONLINE e é
 * amarrada por AST ao guarda das rotas de e-commerce
 * (`cinco-telas-que-batem-na-cara.test.ts`). Juntar as duas faria a mudança
 * de uma arrastar a outra, calada — foi assim que este defeito nasceu.
 */
export const QUEM_GERENCIA_A_OPERACAO: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
];

/**
 * Quem lida com DOCUMENTO FISCAL emitido — gerência e os três caixas.
 *
 * `GET /core/fiscal/documents` (e o DANFE/DANFCE) guarda com
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina', ...CAIXAS)`: o
 * caixa emite a nota da própria venda e precisa reimprimi-la. Os caixas
 * moram no ambiente `pdv`, então nesta tela de gestão quem a lista fecha de
 * verdade é o estoquista e o atendente — mas a lista repete o servidor por
 * inteiro, senão vira uma segunda verdade que envelhece sozinha.
 */
export const QUEM_EMITE_NOTA: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
];

/**
 * Quem ATENDE O CLIENTE — CRM, fidelidade e locação.
 *
 * As rotas de `/core/leads`, `/opportunities`, `/crm/summary`,
 * `/loyalty/program`, `/loyalty/customers/:id` e `/rentals` nomeiam
 * `gerente_loja`, `gerente_oficina`, `atendente` e `operador_caixa_loja`.
 * Quem fica de fora do escritório é o ESTOQUISTA — lead é gente, não
 * mercadoria — e era ele quem clicava nas três telas e colecionava 403.
 */
export const QUEM_ATENDE_O_CLIENTE: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'atendente',
  'operador_caixa_loja',
];

/**
 * Quem DESFAZ VENDA — a lista de devoluções.
 *
 * ## O DEFEITO QUE ESTA LISTA CARREGAVA, e por que ela cresceu
 *
 * Ela era `gerente_loja`, `gerente_oficina` e os dois caixas, espelhando o
 * `requireProfile` de `GET /core/sale-returns`. Estava certa enquanto as
 * ESCRITAS da tela também nomeavam gerente — e deixou de estar no dia em que
 * `POST /sales/:id/cancel` e `POST /sale-returns` viraram
 * `abertaAo(req, 'escritorio')` + `comLiberacaoPontual`.
 *
 * Esse recurso existe EXATAMENTE para o estoquista e o atendente: em vez do
 * "não" seco, eles chamam um gestor ali mesmo, com a senha dele, gasta uma vez
 * e presa àquela venda. Só que a única tela que chama as duas rotas continuava
 * declarando esta lista, e o `Protected` os devolvia para casa antes de a tela
 * montar. O ramo `CORE_RETURN_NEEDS_AUTHORIZATION` ficou sem NENHUM usuário
 * alcançável na aplicação entregue: os quatro que abriam a tela devolvem
 * direto e nunca o veem — um caminho morto com cara de vivo.
 *
 * ## As três pontas, agora alinhadas
 *
 * As DUAS leituras do mount (`GET /sale-returns` e `GET /sales`) passaram a
 * ser `abertaAo(req, 'balcao', 'escritorio')` — o mesmo alcance que `GET
 * /sales` já tinha —, e esta lista repete esse conjunto por inteiro, caixas
 * incluídos. Repetir inteiro é a regra da casa (a forma de `QUEM_EMITE_NOTA` e
 * de `QUEM_VE_A_CONSIGNACAO`): quem não é do ambiente da tela já é barrado
 * pelo AMBIENTE, e escrever a lista mais estreita que o servidor a
 * transformaria numa segunda verdade que envelhece sozinha —
 * `o-menu-nao-promete-o-que-o-servidor-nega.test.ts` compara as duas por
 * inteiro e fica vermelho.
 *
 * A ESCRITA continua mais estreita que a leitura, e é assim que tem de ser:
 * quem não é gerente entra, vê e precisa da liberação para desfazer.
 *
 * NÃO é apelido de `QUEM_VE_A_CONSIGNACAO`, apesar de os nove nomes
 * coincidirem hoje: aquela lista responde por `GET /consignments` e esta pelas
 * duas leituras da tela de devoluções. Juntá-las faria a mudança de uma
 * arrastar a outra, calada — foi assim que este defeito nasceu.
 */
export const QUEM_DESFAZ_VENDA: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
  'atendente',
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
];

/**
 * Quem CONTA A PRATELEIRA — ajustes e inventário.
 *
 * ## O DEFEITO: a porta que a auditoria integral não varreu
 *
 * O item de menu e a rota não declaravam perfil nenhum, então valia
 * `ROTA_GESTAO` — o escritório inteiro. Mas as QUATRO rotas de contagem são
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')`
 * (`GET /core/inventory-counts`, `GET /inventory-counts/:id`,
 * `POST /inventory-counts`, `POST /inventory-counts/:id/items`), e o `apply` e
 * o `cancel` são só os dois gerentes. O ATENDENTE não aparece em nenhuma.
 *
 * Ele mora em `gestao`: via o item, clicava, e a tela montava INTEIRA e VAZIA
 * com toda chamada voltando 403 — a porta que bate na cara, proibida desde a
 * rodada 23. É o mesmo caso de `QUEM_CONCILIA_RECEBIMENTO`, fechado na rodada
 * vizinha pela mesma razão; esta escapou da varredura porque a tela não estava
 * entre as cobradas. Agora está, nos dois arquivos.
 *
 * O recorte é o certo, e não uma limitação: contar prateleira e acertar saldo
 * é trabalho de quem responde pela mercadoria. Quem atende cliente não conta
 * estoque.
 *
 * `admin_geral` e `gestor` entram porque `requireProfile` os libera antes de
 * olhar a lista — por isso os cinco, e não os três que a rota escreve.
 *
 * NÃO é apelido de `QUEM_CONCILIA_RECEBIMENTO` nem de `QUEM_MONTA_O_CATALOGO`,
 * apesar de os cinco nomes coincidirem hoje: cada uma espelha o guarda de
 * rotas diferentes, e um apelido faria a mudança de uma arrastar as outras em
 * silêncio.
 */
export const QUEM_CONTA_A_PRATELEIRA: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
];

/**
 * Quem CONCILIA pedido de compra × NF-e — a tela de recebimento.
 *
 * O recorte vem das rotas de PEDIDO, que são as mais estreitas que a tela
 * usa: `GET /core/purchase-orders`, `GET /purchase-orders/:id` e
 * `POST /purchase-orders/:id/notes/:noteId` guardam com
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')`.
 * As rotas de conferência da nota (`/purchases/notes/:id/conferir`,
 * `/confirm`) são mais LARGAS — aceitam também os caixas —, mas caixa mora
 * no ambiente `pdv` e sem ler o pedido a conciliação não existe: quem manda
 * no recorte é a porta mais estreita. No escritório, fica de fora o
 * ATENDENTE — receber mercadoria não é trabalho de balcão de gente.
 */
export const QUEM_CONCILIA_RECEBIMENTO: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
];

/**
 * Quem VÊ as devoluções ao fornecedor (GAP-PRD-089).
 *
 * A lista espelha as LEITURAS da tela — `GET /purchases/supplier-returns`,
 * `/:id` e `GET /purchases/notes/:id/devolviveis` —, que guardam com
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')`: quem
 * recebe mercadoria confere o que voltou. REGISTRAR e resolver o fiscal é mais
 * estreito (só gerência, como o estorno), e a tela esconde esses gestos de quem
 * não pode. O ATENDENTE fica de fora, como no pedido de compra.
 *
 * NÃO é apelido de `QUEM_CONCILIA_RECEBIMENTO`, apesar de os nomes coincidirem
 * hoje: cada uma espelha rotas diferentes.
 */
export const QUEM_DEVOLVE_AO_FORNECEDOR: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
];

/**
 * Quem VÊ A CONSIGNAÇÃO — a mercadoria que saiu da loja sem venda (GAP-V65).
 *
 * As duas rotas que a tela carrega ao montar — `GET /core/consignments` e
 * `GET /core/consignments/:id` — são `abertaAo(req, 'balcao', 'escritorio')`,
 * o mesmo alcance de `GET /core/quotes`: quem está no balcão precisa saber o
 * que a cliente levou antes de conferir o que ela trouxe de volta.
 *
 * A lista REPETE o servidor por inteiro, caixas inclusive, e isso é a regra
 * desta casa e não descuido — a mesma forma de `QUEM_EMITE_NOTA`. Quem não é
 * do ambiente da tela (os três caixas moram em `pdv`) já é barrado pelo
 * AMBIENTE, e escrever a lista mais estreita que o servidor a transformaria
 * numa segunda verdade que envelhece sozinha: no dia em que a rota mudar, o
 * espelho de `o-menu-nao-promete-o-que-o-servidor-nega.test.ts` fica vermelho
 * porque compara as duas listas por inteiro.
 *
 * As rotas de ESCRITA são mais estreitas (remessa e retorno nomeiam os caixas,
 * os gerentes e o atendente; faturar e fechar tiram o atendente), e é assim que
 * tem de ser: o estoquista abre a tela, vê o que está na rua — que é o número
 * de que ele precisa para conferir a prateleira — e toma recusa se tentar
 * registrar remessa, que não é trabalho de quem não atende cliente.
 */
export const QUEM_VE_A_CONSIGNACAO: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
  'atendente',
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
];

export interface NavChild {
  label: string;
  to?: string;
  hint?: string;
  pending?: boolean;
  /**
   * Ambientes que veem este item. Ausente = herda o do grupo.
   *
   * Existe porque o grupo Oficina serve dois ambientes com necessidades
   * diferentes: o mecânico usa ordens e equipamentos, mas gerir quem tem
   * acesso é trabalho do gerente. Sem este filtro o mecânico via um item que a
   * rota devolvia — justamente o defeito que a separação veio corrigir.
   */
  environments?: Environment[];
  /**
   * Perfis que veem este item, DENTRO do ambiente. Ausente = todos os do
   * ambiente, que é o caso de praticamente todo item.
   *
   * Ambiente é prédio; perfil é cargo. Alguns itens do escritório servem só
   * quem responde pelo grupo — abrir uma operação nova, por exemplo — e a
   * rota do servidor correspondente recusa o resto do escritório. Ver o bloco
   * final de `environments.ts`.
   */
  profiles?: readonly string[];
  /**
   * Empresas (slug) que veem este item. Ausente = todas, que é o caso de todo
   * item menos um.
   *
   * Existe por causa das PLAQUINHAS (P0): o item morava no grupo Oficina e
   * aparecia para a Oficina, a Preço Justo e as lojas de roupa, e a tela abria
   * para responder "esta operação não usa plaquinha". Plaquinha é da PJ Motors;
   * fora dela o item não aparece. Vale também para o acesso personalizado:
   * capability não faz outra empresa virar a PJ.
   */
  empresas?: readonly string[];
}

export interface NavItem {
  label: string;
  /**
   * Nome do desenho em `icons.tsx`, não o desenho.
   *
   * Este arquivo é DADO: uma lista que testes leem e percorrem. Guardar JSX
   * aqui obrigaria todo teste do menu a montar React só para ler um rótulo.
   */
  icon: NavIconName;
  to?: string;
  children?: NavChild[];
  section?: string;
  /** Ambientes que veem este grupo. Ausente = só a gestão. */
  environments?: Environment[];
  /** Perfis que veem este grupo. Ausente = todos os do ambiente. */
  profiles?: readonly string[];
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Início', icon: 'inicio', to: '/sistema/painel' },

  {
    label: 'Pessoas',
    icon: 'pessoas',
    children: [
      { label: 'Clientes', to: '/sistema/clientes' },
      { label: 'Fornecedores', to: '/sistema/compras/fornecedores' },
      {
        // Toda rota de `/core/team` nomeia os gerentes: quem entra no sistema
        // e com qual perfil não é decisão de estoquista nem de atendente.
        label: 'Usuários e equipe',
        to: '/sistema/usuarios',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
    ],
  },

  {
    label: 'Produtos',
    icon: 'produtos',
    children: [
      { label: 'Produtos', to: '/sistema/produtos' },
      {
        label: 'Alteração rápida',
        hint: 'Custo e preço de muitos itens sem abrir um a um',
        to: '/sistema/produtos/alteracao-rapida',
      },
      { label: 'Promoções', to: '/sistema/promocoes' },
      {
        label: 'Cupons de desconto',
        hint: 'Códigos para o cliente digitar no checkout da loja online',
        to: '/sistema/cupons',
      },
      {
        label: 'Prontidão online',
        hint: 'O que falta para cada produto vender na loja',
        to: '/sistema/produtos/prontidao-online',
      },
      { label: 'Categorias e marcas', to: '/sistema/produtos/categorias' },
      {
        label: 'Auxiliares',
        hint: 'Unidade, grupo tributário, alíquota e tabela de preços',
        to: '/sistema/produtos/auxiliares',
      },
      { label: 'Etiquetas', hint: 'Código de barras e QR', to: '/sistema/etiquetas' },
      { label: 'Balança', hint: 'Arquivo de produtos para a balança', to: '/sistema/balanca' },
    ],
  },

  {
    label: 'Estoque',
    icon: 'estoque',
    children: [
      { label: 'Posição de estoque', to: '/sistema/estoque' },
      { label: 'NF-e por e-mail', hint: 'Busca as notas do fornecedor', to: '/sistema/compras/nfe-email' },
      { label: 'Entrada de notas', to: '/sistema/compras/entrada-notas', hint: 'Importação de XML' },
      {
        /*
          A IMPORTAÇÃO FICA EM ESTOQUE, E NÃO EM COMPRAS — a escolha, e por quê.

          "Entrada de notas" aparece nos dois grupos (aqui e em Compras) porque
          receber mercadoria é as duas coisas ao mesmo tempo: é o fim de uma
          compra e é o começo de um saldo. A planilha NÃO é as duas: ela não
          tem fornecedor, não gera título a pagar, não tem CFOP nem chave de
          acesso, e ninguém a "comprou". Pô-la em Compras a apresentaria como
          uma variação da nota do fornecedor, e a primeira pergunta de quem
          clicasse seria "de qual fornecedor?".

          Entre Estoque e Produtos — os dois candidatos honestos — vence Estoque
          pela metade que surpreende. Como criador de catálogo ela é irmã de
          "Produtos"; mas o que ela faz e ninguém espera é MOVER ESTOQUE: cada
          linha com quantidade vira entrada de saldo, e reimportar soma de novo.
          Quem procura essa consequência procura em Estoque, ao lado da outra
          porta onde um arquivo vira saldo.

          Item ÚNICO, de propósito: duplicá-lo em Produtos repetiria o defeito
          que a entrada de notas já tem — o dia em que o caminho mudar, um dos
          dois fica para trás apontando para lugar nenhum.

          `profiles` porque o servidor recusa o atendente nas seis rotas de
          `/core/import/produtos`. A MESMA lista está na rota; ver
          `QUEM_MONTA_O_CATALOGO`.
        */
        label: 'Importação de planilha',
        hint: 'Monta o catálogo e o saldo inicial a partir de um CSV',
        to: '/sistema/estoque/importacao-planilha',
        profiles: QUEM_MONTA_O_CATALOGO,
      },
      { label: 'Movimentações', to: '/sistema/estoque/movimentacoes' },
      {
        /*
          VALIDADE E LOTES (GAP-V35). SEM `profiles`, e a ausência foi
          conferida contra o servidor, não suposta: as duas rotas que a tela
          carrega ao montar — `GET /stock/batches` e `GET /stock/batches/alertas`
          — são `abertaAo('escritorio')`, o mesmo alcance de `GET /stock`, que
          a Posição de estoque já usa sem lista. Declarar uma lista aqui a
          tornaria mais ESTREITA que o servidor, que é o defeito simétrico:
          tela virando segredo alcançável só por URL.
        */
        label: 'Validade e lotes',
        hint: 'Vencido e a vencer, conferência e FEFO',
        to: '/sistema/estoque/validade',
      },
      { label: 'Locais de estoque', to: '/sistema/estoque/locais' },
      { label: 'Unidades', to: '/sistema/estoque/unidades' },
      {
        /*
          `profiles` porque as quatro rotas de contagem recusam o ATENDENTE, e
          `ROTA_GESTAO` sozinha o deixava entrar numa tela que monta inteira e
          vazia. A MESMA lista está na rota; ver `QUEM_CONTA_A_PRATELEIRA`.
        */
        label: 'Ajustes e inventário',
        hint: 'Contagem e acerto, com motivo obrigatório',
        to: '/sistema/estoque/inventario',
        profiles: QUEM_CONTA_A_PRATELEIRA,
      },
    ],
  },

  {
    label: 'Vendas',
    icon: 'vendas',
    children: [
      { label: 'Vendas', to: '/sistema/vendas' },
      { label: 'Orçamentos e pré-vendas', hint: 'Orçamento não reserva; pré-venda reserva', to: '/sistema/orcamentos' },
      {
        // A lista repete `abertaAo('balcao', 'escritorio')` por inteiro — ver
        // `QUEM_VE_A_CONSIGNACAO`, onde o recorte está justificado rota a rota.
        label: 'Consignação (condicional)',
        hint: 'Mercadoria fora da loja: saiu, voltou, virou venda',
        to: '/sistema/consignacoes',
        profiles: QUEM_VE_A_CONSIGNACAO,
      },
      { label: 'Caixa', to: '/sistema/caixa' },
      { label: 'PDV', to: '/pdv' },
      {
        // `/pdv/terminal/uncertain` e `/reconcile` nomeiam os gerentes:
        // decidir se uma cobrança sem resposta valeu é decidir sobre dinheiro.
        label: 'Conferência de maquininha',
        hint: 'Cobranças sem resposta da operadora',
        to: '/sistema/conferencia-maquininha',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        /*
          As duas leituras do mount (`GET /core/sale-returns` e `GET /sales`)
          são `abertaAo('balcao', 'escritorio')`, e a lista repete o servidor
          por inteiro. O estoquista e o atendente PRECISAM entrar: é para eles
          que a liberação pontual de cancelar/devolver foi feita. Ver
          `QUEM_DESFAZ_VENDA`.
        */
        label: 'Cancelamentos e devoluções',
        hint: 'Devolver não altera a venda; cancelar desfaz',
        to: '/sistema/vendas/devolucoes',
        profiles: QUEM_DESFAZ_VENDA,
      },
    ],
  },

  {
    label: 'Financeiro',
    icon: 'financeiro',
    children: [
      { label: 'Lançamentos', to: '/sistema/financeiro' },
      { label: 'Contas a receber', to: '/sistema/financeiro/contas-a-receber' },
      { label: 'Contas a pagar', to: '/sistema/financeiro/contas-a-pagar' },
      {
        // GAP-PRD-094. A rota (`/finance/cash-flow`) nomeia os dois gerentes,
        // como a de Cadastros — é o saldo das contas projetado.
        label: 'Fluxo de caixa',
        hint: 'O que entra e sai nos próximos 30, 60 e 90 dias',
        to: '/sistema/financeiro/fluxo-de-caixa',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        // Sem declarar ambiente: herda a gestão, que é o conjunto que a rota
        // do servidor (`abertaAo(escritorio)`) atende. Declarar aqui uma lista
        // mais estreita esconderia a tela de quem o servidor deixa entrar.
        label: 'Resultado (DRE)',
        hint: 'Receita e despesa por categoria, por competência',
        to: '/sistema/financeiro/dre',
      },
      {
        label: 'Cadastros',
        hint: 'Plano de contas, centros de custo e contas',
        to: '/sistema/financeiro/cadastros',
      },
      {
        // As três abaixo: todas as rotas (`/commissions`, `/acquirers`,
        // `/bank`) nomeiam os gerentes — o estoquista e o atendente viam o
        // item e cada chamada voltava 403.
        label: 'Comissões',
        hint: 'Grupos, faixas e apuração por vendedor',
        to: '/sistema/financeiro/comissoes',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        label: 'Operadoras de cartão',
        hint: 'Taxa da maquininha e prazo para o dinheiro cair',
        to: '/sistema/financeiro/operadoras',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        label: 'Conciliação',
        hint: 'Extrato do banco × financeiro',
        to: '/sistema/financeiro/conciliacao',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
    ],
  },

  {
    label: 'Compras',
    icon: 'compras',
    children: [
      { label: 'Entrada de notas', to: '/sistema/compras/entrada-notas' },
      { label: 'Pedidos de compra', to: '/sistema/compras/pedidos' },
      {
        /*
          A COMPARAÇÃO que o pedido existe para permitir (PurchaseOrderService:
          "comparar o que chegou com o que foi pedido, quando a nota entrar").
          O motor inteiro já existia — amarrar, conferir, confirmar — e nenhuma
          tela o chamava; pedido real nunca saía de "enviado".

          `profiles` porque as rotas de pedido recusam o atendente — ver
          `QUEM_CONCILIA_RECEBIMENTO`, que é a MESMA lista da rota.
        */
        label: 'Conciliação de recebimento',
        hint: 'Pedido × NF-e, item a item',
        to: '/sistema/compras/conciliacao',
        profiles: QUEM_CONCILIA_RECEBIMENTO,
      },
      {
        // GAP-PRD-089: parte da compra que volta ao fornecedor. `profiles`
        // porque as leituras recusam o atendente — ver
        // `QUEM_DEVOLVE_AO_FORNECEDOR`, a MESMA lista da rota.
        label: 'Devoluções ao fornecedor',
        hint: 'Defeito ou sobra: estoque, crédito e NF-e de devolução',
        to: '/sistema/compras/devolucoes',
        profiles: QUEM_DEVOLVE_AO_FORNECEDOR,
      },
      { label: 'Fornecedores', to: '/sistema/compras/fornecedores' },
      {
        label: 'Transportadoras',
        hint: 'Quem trouxe a carga — não é o frete da loja',
        to: '/sistema/compras/transportadoras',
      },
      {
        label: 'Configuração da entrada',
        hint: 'O CFOP com que a loja vende',
        to: '/sistema/compras/configuracao',
      },
    ],
  },

  {
    label: 'Oficina',
    icon: 'oficina',
    // A bancada também vê: é o único grupo que o mecânico usa.
    environments: ['oficina', 'gestao'],
    children: [
      { label: 'Ordens de serviço', to: '/sistema/oficina' },
      { label: 'Equipamentos', to: '/sistema/equipamentos' },
      {
        label: 'Plaquinhas',
        hint: 'Gerar o lote, imprimir a folha e liberar para uso',
        to: '/sistema/equipamentos/plaquinhas',
        // Exclusiva da PJ Motors (P0 das plaquinhas): a Oficina, a Preço Justo e
        // as lojas não veem o item — a rota, se digitada, diz o mesmo.
        empresas: [EMPRESA_DAS_PLAQUINHAS],
      },
      // Gestão de acesso: quem entra no sistema e com qual perfil. Não é
      // trabalho de bancada — nem de estoquista ou atendente: é a mesma tela
      // de `/core/team` que "Usuários e equipe" abre, com o mesmo guarda.
      {
        label: 'Mecânicos e técnicos',
        to: '/sistema/oficina/mecanicos',
        environments: ['gestao'],
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        label: 'Oficinas e bancadas',
        hint: 'Quem trabalha onde, e o que cada oficina faz',
        to: '/sistema/oficina/oficinas',
        environments: ['gestao'],
      },
      {
        label: 'Peças',
        hint: 'O estoque da bancada',
        to: '/sistema/oficina/pecas',
        environments: ['oficina', 'gestao'],
      },
    ],
  },

  {
    label: 'E-commerce',
    icon: 'ecommerce',
    children: [
      {
        label: 'Administração da loja',
        hint: 'Como a vitrine se apresenta',
        to: '/sistema/loja/administracao',
        /*
          QUATRO ITENS DESTE GRUPO DECLARAM PERFIL, e a razão é a mesma nos
          quatro: o servidor deles guarda com `gerente_loja` e
          `gerente_oficina`, e o menu os oferecia ao escritório inteiro.
          O estoquista e o atendente clicavam, a tela montava, e cada
          chamada voltava 403 — porta que bate na cara de quem tenta abrir.
        */
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      {
        label: 'Fotos em lote',
        hint: 'Sobe as fotos nomeadas pelo código',
        to: '/sistema/loja/fotos',
        profiles: QUEM_MONTA_O_CATALOGO,
      },
      { label: 'Ver a loja', hint: 'A vitrine como o cliente vê', to: '/' },
      { label: 'Pedidos', to: '/sistema/pedidos' },
      /*
        Vinha aqui um segundo item, "OMS — Separação e expedição", apontando
        para `/sistema/pedidos` — a MESMA rota de "Pedidos" logo acima. Duas
        entradas para a mesma tela prometiam dois módulos, e quem clicasse na
        segunda procuraria uma separação que não existe em lugar nenhum: o
        roteador `/api/v1/oms` que dava nome ao item foi apagado na rodada 36
        com zero linha em todas as suas catorze tabelas. O que a loja usa de
        verdade é `POST /core/orders/:id/fulfillment`, dentro desta tela.
      */
      {
        // O que falta configurar em cada operação — entrega, medidas, CEP,
        // remetente, transportadora, Asaas e SMTP — num lugar só (GAP-PRD-034).
        // Mesmo alcance das telas que resolvem os itens.
        label: 'Prontidão do dia 1',
        hint: 'O que falta configurar, loja por loja',
        to: '/sistema/loja/prontidao',
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      {
        label: 'Entrega',
        hint: 'Frete e retirada da loja',
        to: '/sistema/loja/entrega',
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      {
        label: 'E-mails',
        hint: 'Avisos enviados ao cliente',
        to: '/sistema/loja/emails',
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      {
        label: 'Logística',
        hint: 'Transportadoras e cotação',
        to: '/sistema/loja/logistica',
        // E aqui o de fora é o gerente da OFICINA: quem despacha encomenda
        // é quem embala, e a bancada não embala.
        profiles: QUEM_COTA_FRETE,
      },
    ],
  },

  {
    /*
      FISCAL — o único grupo que dois ambientes veem com conteúdos DIFERENTES.

      A gestão vê os cinco itens. A contabilidade vê UM: o fechamento. Não é
      um recorte cosmético — é a única tela do sistema que o contador alcança.
      As outras quatro respondem 403 para ele, e vale conferir uma a uma em
      `server/src/routes/v1/core.ts`, porque a razão é a MESMA nas quatro e não
      é o ambiente:

        - Documentos fiscais → `requireProfile(gerente_loja, gerente_oficina,
          ...CAIXAS)`;
        - Inutilização       → `requireProfile(gerente_loja, gerente_oficina)`;
        - Configuração       → `requireProfile(gerente_loja, gerente_oficina)`;
        - Certificado A1     → `requireProfile(req)` sem perfil extra, ou seja
          só `admin_geral` e `gestor`.

      Nenhuma delas é `abertaAo(req, 'escritorio')` — o Fiscal inteiro nomeia
      gente, e `contador` não está em nenhuma das quatro listas.

      ## Por que aqui dentro, e não num grupo "Contabilidade" só dele

      Um grupo próprio seria mais bonito no menu do contador e pior em tudo o
      mais: o mesmo caminho apareceria escrito em dois lugares e, no dia em que
      ele mudasse, um dos dois ficaria apontando para lugar nenhum — que é o
      defeito que "Entrada de notas" já carrega por estar em Estoque e em
      Compras. E o grupo novo sumiria do menu da gestão, quebrando a promessa
      de que a gestão vê o menu inteiro.

      ## O preço, e quem o cobra

      Filho que não declara ambiente HERDA o do grupo. Com o grupo agora em
      `['contabilidade', 'gestao']`, um item novo do Fiscal nasceria visível
      para o contador apontando para uma rota `ROTA_GESTAO` — porta que bate na
      cara. Por isso os outros quatro declaram `ROTA_GESTAO` explicitamente, e
      por isso o caso "o ambiente do item cabe no que a rota exige", em
      `menu-e-rotas.test.tsx`, fica VERMELHO no dia em que alguém acrescentar
      um item aqui sem pensar nisso. Conferido quebrando de propósito.
    */
    label: 'Fiscal',
    icon: 'fiscal',
    environments: ROTA_CONTABILIDADE,
    children: [
      {
        // NF-e e NFC-e não são duas telas: é a mesma lista, filtrada por modelo.
        // Separar sugeriria dois fluxos, e o fluxo é um só.
        //
        // `profiles` porque o guarda da lista (`/fiscal/documents`) nomeia
        // gerência e caixas — o estoquista e o atendente ficavam com a casca
        // e o 403. Ver `QUEM_EMITE_NOTA`.
        label: 'Documentos fiscais',
        hint: 'NF-e e NFC-e: situação, DANFE/DANFCE, cancelamento e CC-e',
        to: '/sistema/fiscal/documentos',
        environments: ROTA_GESTAO,
        profiles: QUEM_EMITE_NOTA,
      },
      {
        // `/fiscal/void-ranges` nomeia os gerentes: inutilizar numeração é
        // conversa com a SEFAZ, não tarefa de balcão.
        label: 'Inutilização de numeração',
        hint: 'Números reservados que nunca viraram nota',
        to: '/sistema/fiscal/inutilizacoes',
        environments: ROTA_GESTAO,
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        /*
          O ENTREGÁVEL DO MÊS — e o segundo item do menu inteiro com recorte
          de perfil.

          Fica logo abaixo dos documentos e da inutilização porque é o que se
          faz DEPOIS deles: as duas telas acima são o mês acontecendo, esta é
          o mês sendo entregue.

          `profiles` porque as rotas de `/core/fiscal/closings` nomeiam os dois
          gerentes. Herdar o padrão do grupo poria o item na frente do
          estoquista e do atendente, e o clique deles terminaria em 403. A
          MESMA lista está na rota; ver `QUEM_ENTREGA_A_CONTABILIDADE`.

          CORREÇÃO DE UMA FRASE ERRADA que estava aqui desde a rodada 27: dizia
          que este item era exceção "ao contrário do resto do Fiscal, que é
          `abertaAo(req, 'escritorio')`". Não é — nenhuma rota do Fiscal usa
          ambiente; todas nomeiam gente (a lista está no comentário do grupo,
          acima, medida uma a uma). Ele é exceção no MENU, não no servidor. A
          diferença importava porque, sendo o servidor estreito nas cinco e o
          menu largo em quatro, os outros quatro itens eram portas que batiam
          na cara do estoquista e do atendente — o achado da rodada 29,
          fechado na rodada da auditoria integral: os quatro declaram
          `profiles` hoje, aqui e nas rotas do roteador, cada um citando o
          guarda real da própria tela.

          E é o ÚNICO item de menu do sistema inteiro que a contabilidade vê.
          O ambiente é declarado aqui além de no grupo porque é este item, e
          não o grupo, que carrega a decisão: o grupo abriu para
          `contabilidade` POR CAUSA desta linha. Repeti-la é o que faz o item
          continuar visível para o contador no dia em que alguém reorganizar o
          Fiscal e mover o grupo de lugar.
        */
        label: 'Fechamento do contador',
        hint: 'O mês num zip: XML emitidos e recebidos, eventos, numeração e DRE',
        to: '/sistema/fiscal/fechamento',
        environments: ROTA_CONTABILIDADE,
        profiles: QUEM_ENTREGA_A_CONTABILIDADE,
      },
      {
        // `/fiscal/config`, `/fiscal/readiness` e `/fiscal/series` nomeiam
        // os gerentes.
        label: 'Configuração fiscal',
        hint: 'Emitente, séries e o que falta para emitir',
        to: '/sistema/fiscal/configuracao',
        environments: ROTA_GESTAO,
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        // `requireProfile(req)` sem perfil extra nas três rotas do A1: só os
        // donos do grupo. O certificado assina nota em nome da empresa — até
        // os gerentes ficam de fora, e o menu tem de dizer o mesmo.
        label: 'Certificado A1',
        hint: 'Por operação, com aviso de vencimento',
        to: '/sistema/fiscal/certificado',
        environments: ROTA_GESTAO,
        profiles: DONOS_DO_GRUPO,
      },
    ],
  },

  {
    label: 'CRM',
    icon: 'crm',
    /*
      O GRUPO declara o perfil, além dos filhos: as rotas de `/core/leads`,
      `/opportunities` e `/loyalty` nomeiam quem atende gente — e o estoquista
      fica de fora de TODOS os filhos. Sem a declaração no grupo, ele veria um
      título de menu que expande para o nada. Ver `QUEM_ATENDE_O_CLIENTE`.
    */
    profiles: QUEM_ATENDE_O_CLIENTE,
    children: [
      {
        label: 'Leads e oportunidades',
        hint: 'Contato que ainda não comprou',
        to: '/sistema/crm/leads',
        profiles: QUEM_ATENDE_O_CLIENTE,
      },
      {
        label: 'Fidelidade',
        hint: 'Ponto acumulado é desconto a pagar',
        to: '/sistema/crm/fidelidade',
        profiles: QUEM_ATENDE_O_CLIENTE,
      },
    ],
  },

  {
    label: 'Locação',
    icon: 'locacao',
    // Mesmo desenho do CRM: filho único gateado esconderia o item e deixaria
    // o grupo vazio na frente do estoquista — as rotas de `/core/rentals`
    // nomeiam quem atende o cliente, e ele não está nelas.
    profiles: QUEM_ATENDE_O_CLIENTE,
    children: [
      {
        label: 'Contratos',
        hint: 'O bem sai reservado, não vendido',
        to: '/sistema/locacao/contratos',
        profiles: QUEM_ATENDE_O_CLIENTE,
      },
    ],
  },

  {
    label: 'Relatórios',
    icon: 'relatorios',
    children: [
      { label: 'Painel', to: '/sistema/painel' },
      {
        /*
          A CENTRAL DE RELATÓRIOS — GAP-V37, e o primeiro item deste grupo que
          ENTREGA arquivo.

          Fica logo abaixo do painel porque é o que se faz DEPOIS de olhar: o
          painel é o dia acontecendo, a Central é o recorte que sai da empresa
          em planilha.

          `profiles` porque `GET /core/reports` e `GET /core/reports/:id`
          nomeiam os dois gerentes — e o guarda é mais estreito que o de várias
          telas que a Central consolida, de propósito: ela junta custo de
          estoque, comissão por vendedor e margem num lugar só. Ver o
          comentário da rota em `gsRoutes.tsx`, e `QUEM_GERENCIA_A_OPERACAO`.
        */
        label: 'Central de relatórios',
        hint: 'Vendas, estoque, financeiro e compras — com exportação em CSV',
        to: '/sistema/relatorios/central',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        // As três rotas de `/core/insights` nomeiam os gerentes: comparar as
        // operações é leitura de quem responde por elas.
        label: 'BI',
        hint: 'As operações lado a lado',
        to: '/sistema/relatorios/bi',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        /*
          A TRILHA DE AUDITORIA — recorte de perfil pela mesma razão dos
          outros itens que o declaram: o guarda do servidor.

          `GET /core/audit` é `requireProfile(req)` sem perfil extra — só
          `admin_geral` e `gestor`. A trilha expõe as ações de TODO MUNDO,
          inclusive as dos gerentes; herdaria o escritório inteiro e o clique
          do gerente terminaria em 403 numa tela vazia. A MESMA lista está na
          rota; ver `DONOS_DO_GRUPO`.

          Fica em Relatórios porque é uma tela de LER: quem abre vem
          investigar um fato consumado, não configurar nada.
        */
        label: 'Auditoria',
        hint: 'Quem fez o quê, e quando — a trilha do sistema',
        to: '/sistema/relatorios/auditoria',
        profiles: DONOS_DO_GRUPO,
      },
    ],
  },

  {
    label: 'Configurações',
    icon: 'configuracoes',
    children: [
      {
        // PRIMEIRO do grupo, e não por ordem alfabética: é a única configuração
        // daqui que muda o que acontece no caixa todo dia. Ficou anos sem tela
        // — o limite de desconto era uma constante no servidor, a venda a prazo
        // vencia no dia, e a validade da pré-venda era um `7` digitado no
        // formulário de orçamento. Nada disso o dono alcançava.
        label: 'Política do balcão',
        hint: 'Desconto sem gestor, prazo do fiado e validade da pré-venda',
        to: '/sistema/configuracoes/politica-de-venda',
      },
      {
        // GAP-PRD-165/166. Sem `profiles`: a leitura é do escritório
        // (`abertaAo('escritorio')`); salvar é dos donos e a tela esconde o
        // botão de quem não é.
        label: 'Política de gestão',
        hint: 'Quem vê dinheiro e como o estoque é valorizado',
        to: '/sistema/configuracoes/politica-de-gestao',
      },
      { label: 'Integrações', to: '/sistema/integracoes' },
      {
        // Cobrança online tem tela própria: a credencial é por operação, e
        // misturar com a lista geral de integrações escondia isso.
        label: 'Cobrança online (Asaas)',
        hint: 'Credencial, webhook e produção — por operação',
        to: '/sistema/integracoes/asaas',
      },
      {
        // A porta de entrada dos CLIENTES da loja online (GAP-PRD-027). É da
        // instalação, não da operação — só os donos do grupo configuram.
        label: 'Entrar com Google (loja)',
        hint: 'Cliente OAuth do Google para a conta do cliente',
        to: '/sistema/integracoes/google',
        profiles: DONOS_DO_GRUPO,
      },
      {
        // Sem esta conferência, um webhook perdido vira receita invisível: o
        // dinheiro entra na conta do provedor e some do faturamento.
        label: 'Conciliação de recebimentos',
        hint: 'Provedor × financeiro',
        to: '/sistema/integracoes/asaas/conciliacao',
        //  nomeia os dois gerentes: conferir o
        // extrato do provedor contra o financeiro é decisão de quem responde
        // pela operação. Ver `QUEM_RESPONDE_PELA_LOJA`.
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      {
        // A fila que sobe deste nó para o banco central. Sem tela, o atraso da
        // sincronização só apareceria quando o relatório consolidado não
        // batesse com o caixa.
        label: 'Banco central (Supabase)',
        hint: 'Fila de sincronização deste nó',
        to: '/sistema/integracoes/central',
        // `GET /core/sync/status` é dos dois gerentes (e dos donos): o
        // estoquista e o atendente abriam a tela e tomavam 403 (GAP-PRD-136).
        profiles: QUEM_RESPONDE_PELA_LOJA,
      },
      { label: 'Impressoras', hint: 'Cupom, etiqueta e A4', to: '/sistema/configuracoes/impressoras' },
      {
        // A conferência da publicação (GAP-PRD-013): o servidor guarda com
        // `system-readiness.view`, que só `admin_geral` e `gestor` leem.
        label: 'Implantação',
        hint: 'Telas, HTTPS, serviço e dados',
        to: '/sistema/configuracoes/implantacao',
        profiles: DONOS_DO_GRUPO,
      },
      {
        // O estado do backup (GAP-PRD-011): `system-backup.view`, que só
        // `admin_geral` e `gestor` leem.
        label: 'Backup',
        hint: 'Cópia do banco, bucket e fotos',
        to: '/sistema/configuracoes/backup',
        profiles: DONOS_DO_GRUPO,
      },
      {
        // Versão, banco, cofre e últimos erros (GAP-PRD-064): `/system/release`,
        // `/system/readiness` e `/core/system/secrets-readiness` — as três só
        // `admin_geral` e `gestor` leem.
        label: 'Sistema',
        hint: 'Versão, banco, cofre e erros',
        to: '/sistema/configuracoes/sistema',
        profiles: DONOS_DO_GRUPO,
      },
      {
        // Um caixa por ponto de venda, cada um com a sua gaveta (GAP-PRD-039),
        // e o computador que entra sem senha (GAP-PRD-150). Mesma lista da
        // rota: cadastrar caixa é decisão de gerente no servidor.
        label: 'Caixas e terminais',
        hint: 'Um caixa por ponto de venda, e o computador sem senha',
        to: '/sistema/configuracoes/terminais',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        // O PinPad de cada caixa, o agente local, a homologação e as
        // cobranças (GAP-PRD-076). Mesma lista da rota: configurar maquininha
        // é decisão de gerente no servidor.
        label: 'Maquininhas',
        hint: 'PinPad do caixa, agente local e homologação',
        to: '/sistema/configuracoes/maquininhas',
        profiles: QUEM_GERENCIA_A_OPERACAO,
      },
      {
        /*
          O PRIMEIRO ITEM DO MENU QUE GANHOU RECORTE DE PERFIL — e a razão
          está no servidor, não no gosto de quem desenhou. (A frase antiga
          dizia "o único", e envelheceu: a importação de planilha, o
          fechamento do contador e a auditoria declaram `profiles` hoje, cada
          um citando a mesma lista da própria rota.)

          `GET`/`POST /core/companies` são guardadas por `requireProfile(req)`
          sem perfil extra: `admin_geral` e `gestor`, e mais ninguém. Herdar o
          padrão do grupo (o escritório inteiro) poria este item na frente do
          estoquista e do atendente, que clicariam e receberiam 403 numa tela
          em branco — o desalinhamento entre menu e guarda que
          `menu-e-rotas.test.tsx` existe para pegar, agora um nível abaixo do
          ambiente.

          Está em Configurações porque é aqui que mora o que se decide uma vez
          e vale para sempre. É o último dos itens que levam a algum lugar de
          propósito: abrir operação é a coisa mais rara e mais definitiva
          desta lista, e não deve ficar no caminho de quem veio ajustar
          impressora.
        */
        label: 'Empresas do grupo',
        hint: 'As operações que existem, e como abrir mais uma',
        to: '/sistema/empresas',
        profiles: DONOS_DO_GRUPO,
      },
      { label: 'Automações', pending: true },
    ],
  },
];
