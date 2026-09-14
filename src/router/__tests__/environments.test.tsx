/**
 * Ambientes: cada um na sua porta.
 *
 * O defeito que originou este arquivo: do PDV e da Oficina dava para abrir o
 * painel do gestor e ver o menu inteiro — Financeiro, Vendas, Estoque. Nenhum
 * dado vazava (o servidor recusa em cada requisição), mas a casca abria, e
 * tela que abre vazia com erro de permissão parece defeito.
 *
 * O que se cobra aqui:
 *
 *  1. cada perfil entra no seu ambiente e é DEVOLVIDO à própria casa ao errar
 *     a porta — nunca ao login, que pareceria sessão expirada;
 *  2. o menu mostra só o que o ambiente usa;
 *  3. login e guarda concordam: não existe destino que o guarda devolva.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Protected } from '../Protected';
import {
  CASA,
  DONOS_DO_GRUPO,
  ROTA_CAIXA,
  ROTA_GESTAO,
  ROTA_OFICINA,
  ROTA_PDV,
  environmentOf,
  homeOf,
} from '../environments';
import { NAV_ITEMS } from '@/components/gs/navItems';

/**
 * A sessão é mockada em vez de gravada no localStorage.
 *
 * `getSession()` guarda a sessão em cache de módulo e exige a forma exata que
 * o servidor emite — token JWT incluso. Imitar isso no teste amarraria a
 * cobertura a um detalhe interno do cliente HTTP, e o que se quer provar aqui
 * é o GUARDA, não a hidratação.
 */
vi.mock('@/lib/api/client', () => ({
  getSession: () => perfilAtual,
  // `Protected` ACOMPANHA a sessão (`useSession`, GAP-PRD-202): o guarda
  // redesenha quando o servidor marca a sessão como provisória. Aqui a sessão
  // não muda durante o render, e a inscrição não precisa avisar ninguém.
  subscribeSession: () => () => undefined,
  // A casca monta o EstadoConexao, que escuta o aviso de servidor sem resposta
  // e confere as vendas guardadas: o módulo falso precisa ter os dois.
  EVENTO_SERVIDOR_SEM_RESPOSTA: 'gs:servidor-caiu',
  apiRequest: async () => ({ items: [] }),
}));

let perfilAtual: { user: { profileCode: string } } | null = null;

function entrarComo(profileCode: string): void {
  perfilAtual = { user: { profileCode } };
}

/** Renderiza a rota protegida e devolve o que ficou na tela. */
function abrir(
  rota: string,
  environments: Parameters<typeof Protected>[0]['environments'],
  profiles?: readonly string[],
) {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route
          path={rota}
          element={
            <Protected environments={environments} profiles={profiles}>
              <p>CONTEUDO</p>
            </Protected>
          }
        />
        <Route path="/login" element={<p>TELA DE LOGIN</p>} />
        <Route path="/oficina/login" element={<p>TELA DE LOGIN DA OFICINA</p>} />
        <Route path="/pdv" element={<p>CASA PDV</p>} />
        <Route path="/sistema/oficina" element={<p>CASA OFICINA</p>} />
        <Route path="/sistema/painel" element={<p>CASA GESTAO</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  perfilAtual = null;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('mapa de perfis', () => {
  it('cobre os cinco perfis que existem na base real', () => {
    expect(environmentOf('operador_caixa_loja')).toBe('pdv');
    expect(environmentOf('operador_caixa_oficina')).toBe('pdv');
    expect(environmentOf('mecanico')).toBe('oficina');
    expect(environmentOf('gestor')).toBe('gestao');
    expect(environmentOf('admin_geral')).toBe('gestao');
  });

  it('perfil desconhecido não fica sem casa', () => {
    // Sem isto, um vínculo antigo entraria num redirecionamento circular.
    expect(homeOf('perfil_que_nao_existe')).toBe(CASA.gestao);
    expect(homeOf(null)).toBe(CASA.gestao);
  });
});

describe('o guarda devolve para casa, não para o login', () => {
  it('caixa tentando o painel do gestor volta para o PDV', () => {
    entrarComo('operador_caixa_loja');
    abrir('/sistema/painel', ROTA_GESTAO);

    expect(screen.getByText('CASA PDV')).toBeTruthy();
    // Mandar ao login quem já está autenticado parece sessão expirada, e o
    // caixa redigita a senha achando que caiu.
    expect(screen.queryByText('TELA DE LOGIN')).toBeNull();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('mecânico tentando o painel do gestor volta para a oficina', () => {
    entrarComo('mecanico');
    abrir('/sistema/painel', ROTA_GESTAO);

    expect(screen.getByText('CASA OFICINA')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('mecânico não entra no PDV', () => {
    entrarComo('mecanico');
    abrir('/pdv', ROTA_PDV);

    expect(screen.getByText('CASA OFICINA')).toBeTruthy();
  });

  it('caixa não entra na oficina', () => {
    entrarComo('operador_caixa_loja');
    abrir('/sistema/oficina', ROTA_OFICINA);

    expect(screen.getByText('CASA PDV')).toBeTruthy();
  });
});

describe('cada um entra na sua porta', () => {
  it('caixa abre o PDV', () => {
    entrarComo('operador_caixa_loja');
    abrir('/pdv', ROTA_PDV);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('mecânico abre a oficina', () => {
    entrarComo('mecanico');
    abrir('/sistema/oficina', ROTA_OFICINA);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('gestor abre o painel', () => {
    entrarComo('gestor');
    abrir('/sistema/painel', ROTA_GESTAO);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('gestor também abre a oficina — o gerente precisa ver a bancada', () => {
    entrarComo('gestor');
    abrir('/sistema/oficina', ROTA_OFICINA);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('o caixa abre a tela de caixa: abrir e fechar turno é trabalho dele', () => {
    entrarComo('operador_caixa_loja');
    abrir('/sistema/caixa', ROTA_CAIXA);
    // Se esta rota fosse só da gestão, o operador não conseguiria começar o dia.
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });
});

/**
 * ==========================================================================
 * PERFIL, A DIMENSÃO QUE FALTAVA — e a prova de que ela FECHA
 * ==========================================================================
 *
 * `ROTA_GESTAO` deixa entrar o escritório inteiro. `/core/companies`, no
 * servidor, é guardada por `requireProfile(req)` sem perfil extra: só
 * `admin_geral` e `gestor`. Sem a lista de perfis, o estoquista abriria a tela
 * e receberia 403 no dado — porta que bate na cara.
 *
 * TODO CASO AQUI FICA VERMELHO SE O GUARDA SAIR: apague o bloco de `profiles`
 * em `Protected.tsx` e os quatro primeiros passam a mostrar CONTEUDO para quem
 * não deveria vê-lo. Não é retórica — foi assim que se conferiu.
 */
describe('perfil: o cargo dentro do prédio', () => {
  it('o estoquista é devolvido para casa, mesmo estando na gestão', () => {
    entrarComo('estoquista');
    abrir('/sistema/empresas', ROTA_GESTAO, DONOS_DO_GRUPO);

    // Ambiente certo, cargo errado: volta ao painel, que é a casa dele.
    expect(screen.getByText('CASA GESTAO')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO')).toBeNull();
    // E não para o login: a sessão está perfeitamente válida.
    expect(screen.queryByText('TELA DE LOGIN')).toBeNull();
  });

  it('o gerente de loja também não abre — não é dono do grupo', () => {
    entrarComo('gerente_loja');
    abrir('/sistema/empresas', ROTA_GESTAO, DONOS_DO_GRUPO);
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('o atendente também não', () => {
    entrarComo('atendente');
    abrir('/sistema/empresas', ROTA_GESTAO, DONOS_DO_GRUPO);
    expect(screen.queryByText('CONTEUDO')).toBeNull();
  });

  it('o gestor abre', () => {
    entrarComo('gestor');
    abrir('/sistema/empresas', ROTA_GESTAO, DONOS_DO_GRUPO);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('o administrador do grupo abre', () => {
    entrarComo('admin_geral');
    abrir('/sistema/empresas', ROTA_GESTAO, DONOS_DO_GRUPO);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });

  it('a lista espelha o atalho do requireProfile do servidor', () => {
    // Se alguém acrescentar um terceiro perfil aqui sem mexer no servidor, a
    // tela passa a oferecer uma porta que a API recusa. É a única linha deste
    // arquivo que fala do servidor, e é de propósito.
    expect([...DONOS_DO_GRUPO].sort()).toEqual(['admin_geral', 'gestor']);
  });

  it('rota sem lista de perfis continua aceitando o ambiente inteiro', () => {
    // A ausência não pode restringir: sessenta telas do escritório dependem
    // disso, e um padrão restritivo apagaria todas de uma vez.
    entrarComo('estoquista');
    abrir('/sistema/painel', ROTA_GESTAO);
    expect(screen.getByText('CONTEUDO')).toBeTruthy();
  });
});

describe('o menu esconde de quem o guarda devolveria', () => {
  const item = () =>
    NAV_ITEMS.flatMap((g) => g.children ?? []).find((c) => c.to === '/sistema/empresas')!;

  it('"Empresas do grupo" declara perfil, e é o mesmo do guarda', () => {
    expect([...(item().profiles ?? [])].sort()).toEqual(['admin_geral', 'gestor']);
  });

  it('nenhum outro item do escritório ficou restrito por engano', () => {
    // A dimensão é nova: se ela tivesse nascido com padrão restritivo, o menu
    // do gerente perderia dezenas de itens sem que ninguém pedisse.
    //
    // A lista é NOMINAL de propósito. Cada entrada aqui é um item que alguém
    // decidiu esconder de parte do escritório, e a decisão tem de estar escrita
    // em algum lugar que quebre quando um terceiro aparecer sem discussão:
    //
    //   - `/sistema/empresas`: `requireProfile(req)` sem perfil extra, ou seja
    //     só `admin_geral` e `gestor`;
    //   - `/sistema/estoque/importacao-planilha`: as seis rotas de
    //     `/core/import/produtos` recusam o ATENDENTE, e a tela inteira é
    //     chamada de rede — para ele não sobraria casca nenhuma para ler.
    //   - `/sistema/fiscal/fechamento`: as duas rotas de
    //     `/core/fiscal/closings` nomeiam `gerente_loja` e `gerente_oficina`.
    //     O motivo está no que o botão faz: baixar o pacote leva a
    //     contabilidade inteira de um mês para fora da empresa, e o escritório
    //     inclui estoquista e atendente. Ver `QUEM_ENTREGA_A_CONTABILIDADE`.
    //   - `/sistema/relatorios/auditoria` (rodada 32): `GET /core/audit` é
    //     `requireProfile(req)` sem perfil extra — só `admin_geral` e
    //     `gestor`. A trilha expõe as ações de TODO MUNDO, inclusive as dos
    //     gerentes, e o vigiado não lê o próprio diário de vigilância; o 403
    //     do gerente está provado em `server/tests/auditoria-tem-leitor`.
    //     Ver `DONOS_DO_GRUPO`, que a rota e o menu citam juntos.
    //
    // A frase "ao contrário do resto do Fiscal, que é `abertaAo(req,
    // 'escritorio')`" estava aqui e SAIU: é falsa, e foi conferida rota a rota
    // na rodada 29. Nenhuma rota do Fiscal usa ambiente — todas nomeiam
    // perfis, e nenhuma delas aceita estoquista ou atendente. Esta lista
    // esteve CURTA por defeito durante rodadas ("Documentos fiscais",
    // "Inutilização", "Configuração fiscal" e "Certificado A1" deviam
    // declarar perfil e não declaravam); a rodada da auditoria integral pagou
    // a dívida inteira — os quatro do Fiscal e mais onze telas, cada uma
    // conferida contra o `requireProfile` da própria rota. O terceiro que
    // aparecer sem discussão continua quebrando aqui, que é o trabalho desta
    // lista.
    //
    // Que os perfis de cada um batem com a rota é `menu-e-rotas.test.tsx` que
    // cobra, e os dois sentidos de cada porta (excluído não entra, permitido
    // não perde) são `audit-portas.test.tsx`; o que se cobra aqui é que a
    // lista não CRESÇA sozinha.
    const restritos = NAV_ITEMS.flatMap((g) =>
      (g.children ?? []).filter((c) => c.profiles).map((c) => c.to),
    );
    expect(restritos.sort()).toEqual([
      // A conciliação de recebimento (rodada P1.2) lê e amarra pelas rotas de
      // pedido de compra, que recusam o ATENDENTE:
      // `requireProfile('gerente_loja', 'gerente_oficina', 'estoquista')`.
      // Ver `QUEM_CONCILIA_RECEBIMENTO` e `conciliacaoPorta.test.tsx`.
      '/sistema/compras/conciliacao',
      // As devoluções ao fornecedor (GAP-PRD-089): as leituras
      // (`/purchases/supplier-returns*`, `/purchases/notes/:id/devolviveis`)
      // recusam o ATENDENTE, como o pedido de compra. Ver
      // `QUEM_DEVOLVE_AO_FORNECEDOR`.
      '/sistema/compras/devolucoes',
      // `/pdv/terminal/uncertain` e `/reconcile`: gerentes. Decidir se uma
      // cobrança sem resposta valeu é decidir sobre dinheiro.
      '/sistema/conferencia-maquininha',
      // O estado do backup (GAP-PRD-011): `GET /system/backup/status` é
      // `system-backup.view`, que só `admin_geral` e `gestor` leem. Mostra a
      // pasta do backup e as falhas da cópia remota — diagnóstico do dono, e o
      // banco copiado é das seis empresas.
      '/sistema/configuracoes/backup',
      // A conferência da publicação (GAP-PRD-013): `GET /system/implantacao`
      // é `system-readiness.view`, que só `admin_geral` e `gestor` leem. Diz
      // caminho de banco e estado das chaves — diagnóstico do dono.
      '/sistema/configuracoes/implantacao',
      // Maquininhas (GAP-PRD-076): cadastrar, parear o agente e desfazer
      // cobrança pedem `requireProfile('gerente_loja', 'gerente_oficina')` em
      // /payment-terminals e /pdv/terminal/configurations.
      '/sistema/configuracoes/maquininhas',
      // Versão, banco, cofre e erros (GAP-PRD-064): `/system/release`,
      // `/system/readiness` e `/core/system/secrets-readiness`, as três de
      // `admin_geral` e `gestor`.
      '/sistema/configuracoes/sistema',
      // Caixas e terminais (GAP-PRD-039/150): `POST/PATCH /core/terminals*`
      // nomeiam os dois gerentes — cadastrar e desligar caixa é decidir sobre
      // a gaveta de cada um. O estoquista e o atendente não mexem nisso.
      '/sistema/configuracoes/terminais',
      /*
        A CONSIGNAÇÃO (GAP-V65) É O CASO OPOSTO AO DE TODOS OS VIZINHOS DESTA
        LISTA, e por isso merece a explicação inteira.

        As outras entradas declaram perfil para ESCONDER a tela de parte do
        escritório. Esta declara para MOSTRAR o servidor por inteiro: as duas
        rotas que a tela carrega ao montar são `abertaAo(req, 'balcao',
        'escritorio')` — nenhum perfil do escritório fica de fora —, e a lista
        existe porque o espelho de `o-menu-nao-promete-o-que-o-servidor-nega`
        compara as duas listas POR IGUALDADE. Sem declarar nada, a oferta cairia
        no fallback do ambiente (só a gestão) e o espelho acusaria oferta mais
        estreita que o servidor, que é o defeito simétrico.

        Ou seja: ninguém do escritório perde o item por causa desta linha. Ver
        `QUEM_VE_A_CONSIGNACAO`, onde o recorte está justificado rota a rota.
      */
      '/sistema/consignacoes',
      // CRM, fidelidade e locação nomeiam quem atende gente — o de fora do
      // escritório é o ESTOQUISTA. Ver `QUEM_ATENDE_O_CLIENTE`.
      '/sistema/crm/fidelidade',
      '/sistema/crm/leads',
      '/sistema/empresas',
      '/sistema/estoque/importacao-planilha',
      /*
        AJUSTES E INVENTÁRIO — a porta que a auditoria integral não varreu.

        As quatro rotas de contagem (`GET /core/inventory-counts`,
        `GET /inventory-counts/:id`, `POST /inventory-counts` e
        `POST /inventory-counts/:id/items`) nomeiam `gerente_loja`,
        `gerente_oficina` e `estoquista`; aplicar e cancelar são só os dois
        gerentes. O ATENDENTE não está em nenhuma — e morava em `gestao`, então
        via o item, entrava, e a tela montava inteira e VAZIA com toda chamada
        voltando 403. Ver `QUEM_CONTA_A_PRATELEIRA`.
      */
      '/sistema/estoque/inventario',
      // `/commissions`, `/bank` e `/acquirers`: gerentes, os três.
      '/sistema/financeiro/comissoes',
      '/sistema/financeiro/conciliacao',
      // `/finance/cash-flow` (GAP-PRD-094): gerentes — é o saldo das contas
      // projetado, o mesmo alcance de `/finance/setup`.
      '/sistema/financeiro/fluxo-de-caixa',
      '/sistema/financeiro/operadoras',
      // O Fiscal inteiro nomeia gente, e agora o menu diz o mesmo: o A1 é só
      // dos donos (`requireProfile(req)` sem extra); configuração e
      // inutilização são dos gerentes; documentos, de gerência e caixas.
      '/sistema/fiscal/certificado',
      '/sistema/fiscal/configuracao',
      '/sistema/fiscal/documentos',
      '/sistema/fiscal/fechamento',
      '/sistema/fiscal/inutilizacoes',
      /*
        AS CINCO TELAS DA LOJA ONLINE.

        As quatro primeiras (administração, entrega, e-mails e conciliação
        do provedor) são guardadas no servidor por `gerente_loja` e
        `gerente_oficina`; a logística, por `gerente_loja` e `estoquista` —
        e é a única em que o de fora é o gerente da OFICINA, porque quem
        despacha encomenda é quem embala.

        Antes da rodada 95 as cinco declaravam só `ROTA_GESTAO`: montavam
        inteiras para o estoquista e o atendente e respondiam 403 em cada
        chamada. Ver `QUEM_RESPONDE_PELA_LOJA` e `QUEM_COTA_FRETE`, e o
        `cinco-telas-que-batem-na-cara.test.ts` do servidor, que lê os dois
        lados por AST e exige que digam o mesmo.
      */
      '/sistema/integracoes/asaas/conciliacao',
      // `GET /core/sync/status` é dos dois gerentes e dos donos (GAP-PRD-136):
      // o estoquista e o atendente abriam a fila do nó e tomavam 403. Ver
      // `QUEM_RESPONDE_PELA_LOJA`.
      '/sistema/integracoes/central',
      // Entrar com Google na loja (GAP-PRD-027): `/core/portal/login-google`
      // é `requireProfile(req)` sem perfil extra — a porta de entrada dos
      // clientes é da instalação, e só os donos do grupo a configuram.
      '/sistema/integracoes/google',
      // `/core/rentals`: o mesmo conjunto do CRM.
      '/sistema/locacao/contratos',
      '/sistema/loja/administracao',
      '/sistema/loja/emails',
      '/sistema/loja/entrega',
      // Rodada 45: as rotas que a tela de fotos consome exigem
      // gerente/estoquista — o menu esconde do atendente o que o servidor
      // recusaria com 403.
      '/sistema/loja/fotos',
      '/sistema/loja/logistica',
      // A prontidão do dia 1 (GAP-PRD-034): `GET /core/loja/prontidao-do-dia-1`
      // é `requireProfile('gerente_loja', 'gerente_oficina')` — o mesmo alcance
      // das telas que resolvem os itens (Entrega, E-mails, Asaas).
      '/sistema/loja/prontidao',
      // A mesma tela de `/core/team` nas duas portas, com o mesmo guarda:
      // gerentes.
      '/sistema/oficina/mecanicos',
      '/sistema/relatorios/auditoria',
      // `/core/insights/*`: gerentes.
      '/sistema/relatorios/bi',
      /*
        A CENTRAL DE RELATÓRIOS (GAP-V37): `GET /core/reports` e
        `GET /core/reports/:id` nomeiam os dois gerentes.

        Ela é MAIS ESTREITA que várias das telas que consolida — a Posição de
        estoque é `abertaAo('escritorio')` —, e o recorte é deliberado: a
        Central junta num lugar só o custo do estoque, a comissão por vendedor
        e a margem, três coisas que o servidor recusa ao estoquista e ao
        atendente em telas separadas. Uma tela larga daria por acidente o que
        quatro guardas negam de propósito.
      */
      '/sistema/relatorios/central',
      '/sistema/usuarios',
      /*
        CANCELAMENTOS E DEVOLUÇÕES — o segundo caso OPOSTO desta lista, junto
        da consignação.

        A linha dizia "gerência e caixas", e era verdade enquanto cancelar
        exigia `gerente_loja` e pronto. Deixou de ser quando as escritas da
        tela viraram `abertaAo('escritorio')` + `comLiberacaoPontual`: o
        recurso existe para o estoquista e o atendente pedirem o "sim" de um
        gestor, e eram justamente eles que o `Protected` devolvia para casa.

        Hoje a declaração MOSTRA o servidor por inteiro — as duas leituras do
        mount são `abertaAo('balcao', 'escritorio')` — e ninguém do escritório
        perde o item por causa dela. Ver `QUEM_DESFAZ_VENDA`.
      */
      '/sistema/vendas/devolucoes',
    ]);
  });
});

describe('sem sessão', () => {
  it('vai para o login, não para casa nenhuma', () => {
    abrir('/sistema/painel', ROTA_GESTAO);
    expect(screen.getByText('TELA DE LOGIN')).toBeTruthy();
  });

  /**
   * A bancada volta para a porta DELA.
   *
   * Sem isto, toda sessão expirada na oficina despejava o mecânico na tela do
   * escritório, que oferece Gestão e PDV — dois lugares que ele não usa. A
   * decisão vem da ROTA, porque sem sessão não há perfil para consultar.
   */
  it('rota de oficina manda para a porta da oficina', () => {
    abrir('/sistema/equipamentos', ROTA_OFICINA);
    expect(screen.getByText('TELA DE LOGIN DA OFICINA')).toBeTruthy();
  });

  it('rota de caixa continua indo para o login geral', () => {
    abrir('/sistema/caixa', ROTA_CAIXA);
    expect(screen.getByText('TELA DE LOGIN')).toBeTruthy();
  });
});

describe('o menu mostra só o que o ambiente usa', () => {
  const grupos = (ambiente: string) =>
    NAV_ITEMS.filter((i) => (i.environments ?? ['gestao']).includes(ambiente as never)).map(
      (i) => i.label,
    );

  it('o mecânico vê a Oficina e mais nada', () => {
    expect(grupos('oficina')).toEqual(['Oficina']);
  });

  it('o mecânico NÃO vê Financeiro, Vendas nem Estoque', () => {
    const vistos = grupos('oficina');
    for (const proibido of ['Financeiro', 'Vendas', 'Estoque', 'Fiscal', 'Configurações']) {
      expect(vistos).not.toContain(proibido);
    }
  });

  it('o PDV não usa o menu do escritório', () => {
    expect(grupos('pdv')).toEqual([]);
  });

  it('a contabilidade vê o Fiscal e mais nada', () => {
    /*
      O ambiente novo da rodada 29, no mesmo formato do caso do mecânico logo
      acima — e pelo mesmo motivo: um grupo a mais aqui é um grupo inteiro de
      itens que respondem 403 para o contador. Que DENTRO do Fiscal só um
      subitem apareça é `contador-no-navegador.test.tsx` que cobra, abrindo o
      menu de verdade; o que se lê aqui é a lista de grupos.
    */
    expect(grupos('contabilidade')).toEqual(['Fiscal']);
  });

  it('a gestão continua vendo tudo', () => {
    expect(grupos('gestao').length).toBe(NAV_ITEMS.length);
  });

  it('o mecânico não vê subitem que a rota devolveria', () => {
    // "Mecânicos e técnicos" é gestão de ACESSO, e a rota é da gestão. Ficar
    // no menu do mecânico seria oferecer porta que não abre — o mesmo defeito
    // que a separação de ambientes veio corrigir, um nível abaixo.
    const oficina = NAV_ITEMS.find((i) => i.label === 'Oficina')!;
    const vistos = oficina.children!
      .filter((c) => (c.environments ?? oficina.environments ?? ['gestao']).includes('oficina'))
      .map((c) => c.label);

    expect(vistos).toContain('Ordens de serviço');
    expect(vistos).toContain('Equipamentos');
    expect(vistos).not.toContain('Mecânicos e técnicos');
  });

  it('subitem sem declaração herda o grupo, não fica mais visível que ele', () => {
    const financeiro = NAV_ITEMS.find((i) => i.label === 'Financeiro')!;
    for (const filho of financeiro.children ?? []) {
      const ambientes = filho.environments ?? financeiro.environments ?? ['gestao'];
      expect(ambientes).not.toContain('oficina');
      expect(ambientes).not.toContain('pdv');
    }
  });

  it('grupo novo nasce restrito à gestão, não visível para todos', () => {
    // O padrão importa: antes, grupo sem restrição aparecia para qualquer um —
    // foi assim que o mecânico passou a enxergar o ERP inteiro.
    const semDeclaracao = NAV_ITEMS.filter((i) => !i.environments);
    expect(semDeclaracao.length).toBeGreaterThan(0);
    for (const item of semDeclaracao) {
      expect(grupos('oficina')).not.toContain(item.label);
    }
  });
});

describe('login e guarda concordam', () => {
  it('a casa de cada perfil é uma rota que o próprio perfil consegue abrir', () => {
    const casos: [string, Parameters<typeof Protected>[0]['environments']][] = [
      ['operador_caixa_loja', ROTA_PDV],
      ['mecanico', ROTA_OFICINA],
      ['gestor', ROTA_GESTAO],
    ];

    for (const [perfil, permitidos] of casos) {
      cleanup();
      entrarComo(perfil);
      abrir(homeOf(perfil), permitidos);
      // Se o login mandasse para uma rota que o guarda devolve, o resultado
      // seria um pingue-pongue infinito na primeira tela após autenticar.
      expect(screen.getByText('CONTEUDO')).toBeTruthy();
    }
  });
});
