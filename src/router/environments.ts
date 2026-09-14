/**
 * Ambientes do sistema — quem entra onde, e para onde volta.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 *
 * O guarda de rota só perguntava "tem sessão?". O servidor recusava os dados
 * (`requireProfile` em mais de noventa rotas), mas a CASCA abria: do PDV e da
 * Oficina dava para chegar ao painel do gestor e ver o menu inteiro —
 * Financeiro, Vendas, Estoque. Nenhum dado vazava, e ainda assim estava
 * errado: um caixa não deve enxergar o que não é dele, e uma tela que abre
 * vazia com erro de permissão parece defeito.
 *
 * O menu tinha o mesmo furo: um único grupo declarava `profiles`, o resto
 * aparecia para todo mundo.
 *
 * O DESENHO
 *
 * Quatro ambientes, cada um com sua porta e sua casa. A pessoa é uma só, o que
 * muda é o papel: o mesmo usuário pode ser caixa numa operação e gerente em
 * outra, e o ambiente segue o perfil ATIVO da sessão.
 *
 * O QUARTO AMBIENTE FICA FORA DA EMPRESA
 *
 * `contabilidade` é o único cujo morador não trabalha aqui: o contador recebe
 * o mês e vai embora. Ele nasceu na rodada 29, quando o entregável do
 * fechamento — que a rodada 27 construiu — deixou de depender de alguém da
 * loja lembrar de gerar e enviar todo mês.
 *
 * O ESPELHO DO SERVIDOR, E O QUE NÃO O LIGA
 *
 * `PERFIS_DO_AMBIENTE`, em `server/src/routes/v1/core.ts`, diz a MESMA coisa
 * ao contrário (ambiente → perfis) e com outro vocabulário: lá os nomes são
 * `balcao`, `bancada`, `escritorio` e `contabilidade`. Nenhum dos dois
 * arquivos importa o outro e o `tsc` não conhece relação nenhuma entre eles —
 * os dois compilam felizes dizendo coisas contrárias. Quando divergem, o
 * sintoma é ruim dos dois lados: navegador mais largo abre tela que responde
 * 403; servidor mais largo entrega dado que tela nenhuma oferece.
 *
 * Quem os amarra é `server/tests/ambientes-dos-dois-lados.test.ts`, que lê os
 * dois por AST e cobra a correspondência perfil a perfil, nos dois sentidos.
 * Ele exige que os valores aqui sejam TEXTO LITERAL: trocar
 * `contador: 'contabilidade'` por uma constante deixaria a leitura cega.
 *
 * ISTO NÃO É A AUTORIZAÇÃO
 *
 * A autorização real continua no servidor, que valida token e vínculo de
 * empresa em cada requisição. O que está aqui é navegação: leva a pessoa para
 * onde ela trabalha e não oferece porta que ela não pode abrir. Defesa em
 * profundidade — se esta camada falhar, a API ainda recusa.
 */

export type Environment = 'pdv' | 'oficina' | 'gestao' | 'contabilidade';

/**
 * Perfil → ambiente.
 *
 * Os cinco primeiros são os que existem na base real; os demais aparecem nas
 * rotas do servidor e entram aqui para que um vínculo antigo não caia em
 * ambiente nenhum.
 *
 * EXPORTADO só para que o teste possa percorrer TODO perfil que existe, em vez
 * de conferir uma lista escrita à mão que envelhece no dia em que nascer o
 * décimo perfil. É o que sustenta o caso "a casa de cada ambiente aceita quem
 * mora nele", que é a trava contra o laço de redirecionamento que
 * `CASA.contabilidade` passou a tornar possível.
 */
export const AMBIENTE_POR_PERFIL: Record<string, Environment> = {
  // Balcão
  operador_caixa: 'pdv',
  operador_caixa_loja: 'pdv',
  operador_caixa_oficina: 'pdv',

  // Bancada
  mecanico: 'oficina',

  // Escritório
  admin_geral: 'gestao',
  gestor: 'gestao',
  gerente_loja: 'gestao',
  gerente_oficina: 'gestao',
  estoquista: 'gestao',
  atendente: 'gestao',

  /*
    Contabilidade — e ele mora SOZINHO aqui, o que é metade do desenho.

    `contador` não pertencer a nenhum outro ambiente é o que faz toda rota do
    servidor guardada por ambiente recusá-lo com 403 sem ninguém ter escrito
    uma linha a respeito dela. O trabalho da rodada não foi fechar 307 rotas;
    foi abrir três — a prévia do fechamento, o pacote do mês e o XML da nota
    recebida —, e cada uma delas nomeia `contador` no próprio guarda.

    Do lado de cá vale o mesmo de graça: todo grupo de menu e toda rota que
    não declara ambiente herda `['gestao']`, então o contador não enxerga nem
    alcança nada além do que esta rodada abriu por escrito.
  */
  contador: 'contabilidade',
};

/**
 * Onde cada ambiente começa. É para cá que a pessoa volta ao errar a porta.
 *
 * A casa da contabilidade é a TELA DE FECHAMENTO, e não o painel. O painel é
 * o começo do escritório e responde 403 inteiro para o contador — mandá-lo
 * para lá seria recebê-lo, no primeiro segundo do primeiro acesso, com uma
 * tela em branco cheia de erro de permissão. A casa de alguém tem de ser um
 * lugar onde ele consegue trabalhar.
 *
 * Os valores são TEXTO LITERAL de propósito, e não constantes compartilhadas
 * com o roteador: `ambientes-dos-dois-lados.test.ts` lê este objeto por AST e
 * exige literal. O amarramento entre esta casa e a rota que a atende é feito
 * por teste (`contador-no-navegador.test.tsx`), que compara os dois caminhos.
 */
export const CASA: Record<Environment, string> = {
  pdv: '/pdv',
  oficina: '/sistema/oficina',
  gestao: '/sistema/painel',
  contabilidade: '/sistema/fiscal/fechamento',
};

export function environmentOf(profileCode: string | null | undefined): Environment | null {
  if (!profileCode) return null;
  return AMBIENTE_POR_PERFIL[profileCode] ?? null;
}

/**
 * A casa de um perfil.
 *
 * Perfil desconhecido cai na gestão: é o ambiente onde a pessoa consegue pelo
 * menos ver o que tem acesso, em vez de ficar presa num redirecionamento
 * circular. O servidor continua recusando o que ela não pode.
 */
export function homeOf(profileCode: string | null | undefined): string {
  const ambiente = environmentOf(profileCode);
  return CASA[ambiente ?? 'gestao'];
}

/**
 * O ambiente pode abrir esta rota?
 *
 * As sobreposições são deliberadas e vão todas na mesma direção: o gerente
 * precisa enxergar a bancada, então `gestao` abre as telas de oficina, e
 * precisa continuar enxergando o fechamento, então `gestao` abre a tela da
 * contabilidade. O contrário nunca vale — o mecânico não entra no escritório,
 * e o contador tampouco.
 */
export function canAccess(environment: Environment, rota: Environment[]): boolean {
  return rota.includes(environment);
}

/** Ambientes que abrem cada rota protegida. Usado por `Protected`. */

/**
 * A tela de venda, aberta também para o escritório.
 *
 * Era só `['pdv']` — e o menu da gestão oferecia "PDV" desde sempre. O gerente
 * clicava e o guarda o devolvia para casa, sem explicação: o comportamento de
 * sessão expirada, num sistema em que a sessão está perfeitamente válida.
 *
 * O desalinhamento passou porque nenhum teste comparava o menu com o roteador;
 * quem o encontrou foi o arquivo `menu-e-rotas.test.tsx`, no primeiro dia dele.
 *
 * Abrir era a correção certa, e não tirar o item do menu, por dois motivos: a
 * gaveta do dinheiro (`ROTA_CAIXA`) e a bancada (`ROTA_OFICINA`) já aceitam a
 * gestão — o PDV era o único de fora, e é MENOS sensível que a gaveta; e isto
 * aqui é navegação, não autorização. Cada rota do servidor continua conferindo
 * perfil e vínculo de empresa em toda requisição.
 */
export const ROTA_PDV: Environment[] = ['pdv', 'gestao'];
export const ROTA_OFICINA: Environment[] = ['oficina', 'gestao'];
export const ROTA_GESTAO: Environment[] = ['gestao'];

/**
 * O caixa é do caixa.
 *
 * Abrir o turno, sangrar, suprir e fechar é trabalho de quem está no balcão —
 * não do escritório. Enquanto a abertura e o fechamento não estiverem dentro
 * da própria tela do PDV, tirar esta rota do operador o impediria de começar
 * o dia.
 */
export const ROTA_CAIXA: Environment[] = ['pdv', 'gestao'];

/**
 * A tela de fechamento, que agora tem DOIS públicos.
 *
 * A gestão continua vendo — é assim hoje, e é ela quem confere o mês antes de
 * ele sair da empresa. O que muda é que a contabilidade entra na mesma tela,
 * em vez de ganhar uma cópia dela: o contador precisa exatamente do que o
 * gerente já vê (o que o mês tem, o que falta nele e o botão de baixar), e
 * duas telas para a mesma pergunta divergiriam no primeiro ajuste.
 *
 * `['contabilidade', 'gestao']` e não o contrário: a ordem não muda nada em
 * `canAccess`, mas escreve de quem é a casa. Esta é a única rota do sistema em
 * que o dono do ambiente `contabilidade` entra.
 */
export const ROTA_CONTABILIDADE: Environment[] = ['contabilidade', 'gestao'];

/*
  ==========================================================================
  A TERCEIRA DIMENSÃO: PERFIL, PARA A TELA QUE AMBIENTE NÃO CONSEGUE DESCREVER
  ==========================================================================

  ## Por que ela nasce agora, e não antes

  Até aqui o roteador e o menu filtravam por AMBIENTE, e só. Isso bastava
  enquanto toda tela do escritório servia ao escritório inteiro: `ROTA_GESTAO`
  deixa entrar `admin_geral`, `gestor`, `gerente_loja`, `gerente_oficina`,
  `estoquista` e `atendente`, e era exatamente esse o conjunto que as rotas de
  servidor correspondentes atendiam (`abertaAo(req, 'escritorio')`).

  `/core/companies` quebra o casamento. O guarda dela é `requireProfile(req)`
  SEM perfil extra — por dentro, `admin_geral` e `gestor`, e mais ninguém.
  Abrir a sétima operação do grupo cria empresa, gerente e login: não é
  trabalho de estoquista nem de atendente, e o servidor recusa os dois com 403.

  Sem esta dimensão só existiriam dois desfechos, e ambos são defeitos que este
  projeto já pagou:

    - pôr a tela em `ROTA_GESTAO` e deixar assim: o estoquista vê o item no
      menu, clica, e a lista chega vazia com 403. Guarda mais estreito que a
      tela — a regra que a rodada 23 criou, violada pela quarta rodada seguida.
    - alargar o guarda do servidor até caber em `ROTA_GESTAO`: dar ao
      estoquista o poder de abrir empresa para não ter que mexer no roteador.

  ## Por que perfil, e não um quarto ambiente

  Ambiente é PRÉDIO: onde a pessoa trabalha (balcão, bancada, escritório). É
  por isso que o mecânico não vê Financeiro, e é o recorte certo para a
  navegação. Um quarto ambiente "grupo" mentiria: `gestor` continuaria morando
  no escritório e passaria a morar em dois lugares, `homeOf` teria de escolher
  um, e o menu inteiro dele mudaria de dono.

  Perfil é CARGO. A distinção que falta aqui é de cargo dentro do mesmo prédio,
  e é por isso que a declaração é uma lista de perfis ao lado da de ambientes —
  não no lugar dela. As duas valem juntas: a rota exige o ambiente E o perfil.

  ## ISTO NÃO É A AUTORIZAÇÃO

  Vale o mesmo que já valia para ambiente: quem decide é o servidor, em toda
  requisição. O que muda aqui é que a pessoa deixa de receber a oferta de uma
  porta que bate na cara dela.
*/

/**
 * Quem responde pelo GRUPO, e não por uma operação.
 *
 * Espelho exato do atalho de `requireProfile` no servidor
 * (`server/src/routes/v1/core.ts`), que devolve cedo para `admin_geral` e
 * `gestor` antes de olhar qualquer lista. Uma rota de servidor guardada por
 * `requireProfile(req)` sem argumento extra atende este conjunto e nenhum
 * outro — logo é este o conjunto que a tela correspondente pode oferecer.
 *
 * A lista mora AQUI e é a única do frontend: `useHasProfile` a consome em vez
 * de repetir os dois códigos, senão o dia em que o atalho do servidor mudar
 * haveria dois lugares para lembrar e um deles ficaria para trás.
 */
export const DONOS_DO_GRUPO: readonly string[] = ['admin_geral', 'gestor'];

/**
 * Quem monta o catálogo de uma operação — a importação de planilha.
 *
 * As seis rotas de `/core/import/produtos` são guardadas por
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina', 'estoquista')`, e
 * `requireProfile` devolve cedo para `admin_geral` e `gestor` antes de olhar a
 * lista — por isso os cinco, e não os três que a rota escreve.
 *
 * O ATENDENTE fica de fora, e é ele o motivo desta lista existir. Ele mora na
 * gestão, então `ROTA_GESTAO` sozinha o deixaria entrar numa tela em que TODAS
 * as chamadas respondem 403: a lista de importações chega vazia, o envio do
 * arquivo falha, e a tela inteira vira uma mensagem de permissão negada. Não é
 * o caso de `/sistema/configuracoes/politica-de-venda`, onde a casca abre e diz
 * em palavras que a decisão não é do balcão — ali há o que ler; aqui não há
 * nada, porque a tela é um formulário de envio e mais nada.
 *
 * A lista fica AQUI porque a rota e o item de menu precisam citar a MESMA — é
 * o que `menu-e-rotas.test.tsx` cobra, e é o que impede uma das duas
 * declarações de mudar sozinha.
 */
export const QUEM_MONTA_O_CATALOGO: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'estoquista',
];

/**
 * Quem entrega a contabilidade do mês para fora da empresa.
 *
 * As duas rotas de `/core/fiscal/closings` são guardadas por
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina')`, e `requireProfile`
 * devolve cedo para `admin_geral` e `gestor` antes de olhar a lista — por isso
 * os quatro, e não os dois que a rota escreve.
 *
 * O recorte é mais estreito que o que o MENU oferece no resto do Fiscal, e a
 * razão está no que o botão faz: baixar o pacote leva para fora TODOS os
 * documentos fiscais do mês, os XML das compras e o resultado do período, num
 * arquivo só.
 * `ROTA_GESTAO` sozinha ofereceria isso ao estoquista e ao atendente — que
 * conferem mercadoria e atendem cliente —, e o servidor os devolveria com 403
 * numa tela já aberta. O servidor foi escrito com essa decisão dentro
 * (`server/src/routes/v1/core.ts`, seção "fechamento mensal do contador"); aqui
 * ela só é repetida para o menu não oferecer a porta.
 *
 * ## O QUINTO NOME, e por que ele é de outra natureza
 *
 * `contador` entrou na rodada 29, quando as rotas passaram a nomeá-lo. Os
 * quatro primeiros são gente de dentro que ENTREGA o pacote; ele é a pessoa de
 * fora que o RECEBE. É a mesma tela porque é a mesma pergunta — o que o mês
 * tem, o que falta nele, e o arquivo — e porque quem entrega e quem recebe
 * precisam estar olhando para a mesma contagem quando discordarem.
 *
 * E ele é obrigatório aqui por um motivo mecânico, além do de desenho:
 * `CASA.contabilidade` é esta tela, e `Protected` devolve para casa quem não
 * atende a lista de perfis. Um contador fora desta lista seria devolvido de
 * volta para a própria casa, que é a tela que acabou de recusá-lo —
 * pingue-pongue infinito na primeira tela depois do login. Há caso nomeado
 * para isso em `contador-no-navegador.test.tsx`.
 */
/**
 * Quem responde pela LOJA ONLINE de uma operação.
 *
 * Quatro telas de e-commerce declaravam só `ROTA_GESTAO` — o escritório
 * inteiro, que inclui estoquista e atendente — e o servidor delas guarda
 * com `requireProfile(req, 'gerente_loja', 'gerente_oficina')`:
 *
 *   Administração da loja   GET/PUT /core/storefront/settings
 *   Entrega                 GET/PUT /core/shipping-settings
 *   E-mails                 GET /core/emails, POST /core/emails/enviar
 *   Conciliação Asaas       GET /core/asaas/conciliacao
 *
 * O estoquista e o atendente clicavam no menu, a tela montava INTEIRA, e
 * cada chamada voltava 403. É o "guarda mais estreito que a tela" da rodada
 * 23: chega ao dono como "o sistema está com defeito", e não como "você não
 * tem permissão", porque ninguém disse isso em lugar nenhum.
 *
 * E o recorte é o certo, não uma limitação: publicar a vitrine, decidir se a
 * loja entrega e por quanto, disparar e-mail para cliente e conferir o
 * extrato do provedor são decisões de quem RESPONDE pela operação. Quem
 * confere mercadoria e quem atende cliente não decidem nenhuma delas.
 *
 * `admin_geral` e `gestor` entram porque `requireProfile` os libera antes de
 * olhar a lista — por isso os quatro, e não os dois que a rota escreve.
 *
 * `cinco-telas-que-batem-na-cara.test.ts`, no servidor, lê esta lista e a
 * dos guardas por AST e exige que sejam a MESMA.
 */
export const QUEM_RESPONDE_PELA_LOJA: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
];

/**
 * Quem cota frete e cadastra transportadora.
 *
 * É o CONTRÁRIO das quatro acima, e por isso é uma lista separada em vez de
 * um apelido: as rotas de `/core/logistics` guardam com
 * `requireProfile(req, 'gerente_loja', 'estoquista')` — quem fica de fora aqui
 * é o GERENTE DA OFICINA, e quem entra é o estoquista.
 *
 * A razão é a mercadoria: quem despacha encomenda é quem embala, e a bancada
 * não embala. Juntar as duas listas numa só faria uma das duas telas bater
 * na cara de alguém — foi assim que este defeito nasceu.
 */
export const QUEM_COTA_FRETE: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'estoquista',
];

export const QUEM_ENTREGA_A_CONTABILIDADE: readonly string[] = [
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'contador',
];

/**
 * O perfil satisfaz a exigência declarada?
 *
 * Sem lista declarada, qualquer perfil do ambiente serve — é o comportamento
 * de todas as telas existentes, e mantê-lo é o que impede esta dimensão de
 * mudar, calada, o alcance de sessenta rotas que não pediram nada.
 */
export function perfilAtende(
  profileCode: string | null | undefined,
  perfis: readonly string[] | undefined,
): boolean {
  if (!perfis) return true;
  return !!profileCode && perfis.includes(profileCode);
}
