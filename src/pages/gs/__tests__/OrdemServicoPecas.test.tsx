/**
 * A PEÇA CHEGANDO NA OS — pela tela, que é onde ela não chegava.
 *
 * ## O buraco que este arquivo fecha
 *
 * O defeito era inteiro de frontend: `POST /workshop/orders/:id/parts` existia
 * desde a rodada da OS, `WorkshopPartsService.returnPartToStock` existia desde a
 * rodada passada, e NENHUMA tela chamava nenhum dos dois. O card "Peças
 * aplicadas" era leitura pura, mostrando "Nada saiu do estoque para esta OS"
 * sem oferecer caminho nenhum de fazer sair. O conserto foram cerca de mil
 * linhas em cinco telas — e nenhuma linha de teste.
 *
 * Um teste de servidor não alcança esse defeito: o servidor estava certo o
 * tempo todo. O que faltava era a metade que só se prova montando a tela e
 * clicando nela.
 *
 * ## Por que a tela DE VERDADE, com a rede dublada
 *
 * Testar as funções soltas provaria que elas decidem certo e ficaria verde com
 * a tela ignorando a decisão — que é exatamente a forma do defeito original: o
 * código existia, ninguém o chamava. Aqui a rede é dublada e a tela é real, e
 * cada teste falha quando o guarda ou o caminho sai do componente:
 *
 *   - tire a chamada de `lancarPeca` e o estado vazio nunca some;
 *   - tire o `workshopId` da busca e a gaveta da outra bancada aparece;
 *   - troque a mensagem do servidor por um texto genérico no `catch` e a recusa
 *     de peça sem preço vira "algo deu errado";
 *   - deixe a tela imprimir `cost_cents` e o mecânico passa a ver o custo.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OrdemServicoPage from '../OrdemServicoPage';

const OS_ID = 'os-1';
const BANCADA = 'wk-celulares';
const MECANICO = 'user-mec';

/**
 * A OS como o servidor a devolve, e ela MUDA durante o teste.
 *
 * Guardar um objeto fixo faria o teste passar com a tela nunca relendo a ordem
 * — e a releitura é justamente o que faz a tabela "Peças aplicadas" deixar de
 * mostrar o estado vazio depois do lançamento.
 */
interface ParteNaOS {
  id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  returned_quantity: number | null;
}

let os: {
  id: string;
  number: number;
  status: string;
  workshop_id: string;
  mechanic_id: string | null;
  mechanic_name: string | null;
  workshop_name: string;
  customer_display: string;
  customer_phone: null;
  customer_id: null;
  equipment_display: string;
  equipment_public_id: null;
  equipment_serial: null;
  plate: null;
  complaint: string;
  diagnosis: null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
  opened_by_customer: number;
  created_at: string;
  parts: ParteNaOS[];
  comments: never[];
  events: never[];
};

/** A gaveta da bancada. `cost_cents` NÃO existe: o servidor o remove. */
let gaveta: {
  id: string;
  internal_code: string;
  barcode: string | null;
  name: string;
  unit: string;
  price_cents: number;
  min_stock: number;
  workshop_id: string;
  workshop_name: string;
  stock_quantity: number;
  reserved: number;
  available: number;
  below_minimum: boolean;
}[];

/** Toda URL que a tela pediu — é por ela que se prova o recorte da bancada. */
let pedidos: string[];
/** O que a próxima escrita responde. Nulo = sucesso. */
let recusaDoServidor: { status: number; code: string; message: string } | null;

function osVazia() {
  return {
    id: OS_ID,
    number: 41,
    status: 'em_andamento',
    workshop_id: BANCADA,
    mechanic_id: MECANICO,
    mechanic_name: 'Zé Mecânico',
    workshop_name: 'Oficina de Celulares',
    customer_display: 'Dona Marta',
    customer_phone: null,
    customer_id: null,
    equipment_display: 'iPhone 11',
    equipment_public_id: null,
    equipment_serial: null,
    plate: null,
    complaint: 'não liga',
    diagnosis: null,
    labor_cents: 5000,
    parts_cents: 0,
    total_cents: 5000,
    opened_by_customer: 0,
    created_at: '2026-08-01T12:00:00.000Z',
    parts: [] as ParteNaOS[],
    comments: [] as never[],
    events: [] as never[],
  };
}

/**
 * O servidor dublado — e ele MEXE no estado, não só responde.
 *
 * Lançar baixa a gaveta e enche a OS; devolver faz o caminho de volta. Um dublê
 * que respondesse 201 sem mexer em nada deixaria passar uma tela que lança a
 * peça e não relê a ordem — o defeito seguinte mais provável.
 */
function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    pedidos.push(`${metodo} ${alvo}`);

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (recusaDoServidor && metodo === 'POST') {
      const r = recusaDoServidor;
      return responder({ error: { code: r.code, message: r.message } }, r.status);
    }

    // Lançar: baixa a gaveta e soma na conta, como o servidor faz na mesma
    // transação.
    if (metodo === 'POST' && /\/workshop\/orders\/[^/]+\/parts$/.test(alvo)) {
      const peca = gaveta.find((p) => p.id === corpo.productId)!;
      const quantidade = Number(corpo.quantity);
      peca.stock_quantity -= quantidade;
      peca.available -= quantidade;
      os.parts.push({
        id: `sp-${os.parts.length + 1}`,
        description: peca.name,
        quantity: quantidade,
        unit_price_cents: peca.price_cents,
        total_cents: peca.price_cents * quantidade,
        returned_quantity: null,
      });
      os.parts_cents += peca.price_cents * quantidade;
      os.total_cents = os.labor_cents + os.parts_cents;
      return responder({ ok: true }, 201);
    }

    // Devolver: volta para a gaveta e derruba a conta da OS.
    const devolucao = alvo.match(/\/workshop\/orders\/[^/]+\/parts\/([^/]+)\/return$/);
    if (metodo === 'POST' && devolucao) {
      const parte = os.parts.find((p) => p.id === devolucao[1])!;
      const quantidade = Number(corpo.quantity);
      parte.returned_quantity = Number(parte.returned_quantity ?? 0) + quantidade;
      const peca = gaveta.find((p) => p.name === parte.description);
      if (peca) {
        peca.stock_quantity += quantidade;
        peca.available += quantidade;
      }
      os.parts_cents -= parte.unit_price_cents * quantidade;
      os.total_cents = os.labor_cents + os.parts_cents;
      return responder({ returned: quantidade });
    }

    if (alvo.includes('/core/workshop/parts')) {
      const params = new URLSearchParams(alvo.split('?')[1] ?? '');
      const daBancada = params.get('workshopId');
      const busca = (params.get('search') ?? '').toLowerCase();
      const itens = gaveta.filter(
        (p) =>
          (!daBancada || p.workshop_id === daBancada)
          && (!busca || p.name.toLowerCase().includes(busca)),
      );
      return responder({ items: itens });
    }

    if (/\/core\/workshop\/orders\/[^/]+$/.test(alvo)) return responder(os);

    return responder({});
  });
}

/**
 * A sessão do MECÂNICO.
 *
 * É a persona da tela: `useHasProfile('mecanico', 'gerente_oficina')` é o que
 * decide se o botão "Acrescentar peça" existe, e `useSession()?.user.id` é o
 * que compara com o responsável da OS. Sem sessão de verdade, o teste mediria
 * uma tela que ninguém vê.
 */
function entrarComo(profileCode: string, userId = MECANICO) {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: userId, login: 'ze', displayName: 'Zé Mecânico', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  recusaDoServidor = null;
  os = osVazia();
  gaveta = [
    {
      id: 'p-conector',
      internal_code: 'PC-0001',
      barcode: '7890000000024',
      name: 'Conector de carga',
      unit: 'UN',
      price_cents: 9000,
      min_stock: 2,
      workshop_id: BANCADA,
      workshop_name: 'Oficina de Celulares',
      stock_quantity: 6,
      reserved: 0,
      available: 6,
      below_minimum: false,
    },
    {
      id: 'p-parafuso',
      internal_code: 'PC-0002',
      barcode: null,
      name: 'Parafuso pentalobe',
      unit: 'UN',
      price_cents: 300,
      min_stock: 10,
      workshop_id: BANCADA,
      workshop_name: 'Oficina de Celulares',
      stock_quantity: 4,
      reserved: 0,
      available: 4,
      below_minimum: true,
    },
    // Peça de OUTRA bancada: nunca pode aparecer nesta OS.
    {
      id: 'p-pneu',
      internal_code: 'MB-0007',
      barcode: null,
      name: 'Pneu traseiro',
      unit: 'UN',
      price_cents: 25000,
      min_stock: 0,
      workshop_id: 'wk-mobilidade',
      workshop_name: 'Oficina de Motos',
      stock_quantity: 3,
      reserved: 0,
      available: 3,
      below_minimum: false,
    },
  ];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('mecanico');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter initialEntries={[`/sistema/oficina/os/${OS_ID}`]}>
      <Routes>
        <Route path="/sistema/oficina/os/:id" element={<OrdemServicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * O card das peças aplicadas.
 *
 * O recorte importa: a tela tem outras tabelas e outros avisos, e um
 * `screen.getByText` solto passaria com a informação certa aparecendo no lugar
 * errado — que é metade do defeito quando a mensagem é uma recusa.
 */
function cardDePecas(): HTMLElement {
  return screen.getByText('Peças aplicadas').closest('section') as HTMLElement;
}

/**
 * As DUAS tabelas do card, distinguidas pela coluna que só cada uma tem.
 *
 * A mesma peça aparece nas duas ao mesmo tempo — na gaveta, para ser lançada de
 * novo; na conta, porque já foi. Um `getByText` no card inteiro encontraria as
 * duas e um `getAllByText` esconderia em qual delas o dado apareceu, que é
 * justamente o que se quer provar depois de lançar.
 */
function tabelaDaGaveta(): HTMLElement {
  return within(cardDePecas())
    .getAllByRole('table')
    .find((t) => within(t).queryByRole('columnheader', { name: 'Levar' })) as HTMLElement;
}

function tabelaDaConta(): HTMLElement {
  return within(cardDePecas())
    .getAllByRole('table')
    .find((t) => within(t).queryByRole('columnheader', { name: 'Devolvida' })) as HTMLElement;
}

/** A linha de uma peça dentro de uma das tabelas. */
function linhaDe(tabela: HTMLElement, nome: string): HTMLElement {
  return within(tabela).getByText(nome).closest('tr') as HTMLElement;
}

/**
 * Abre a gaveta e espera a busca chegar.
 *
 * São DOIS botões com o mesmo nome, e de propósito: o do cabeçalho do card e o
 * do estado vazio, que é onde o olho de quem abriu a OS sem peça cai primeiro.
 * O do cabeçalho é o que existe sempre.
 */
async function abrirAGaveta() {
  const botoes = await screen.findAllByRole('button', { name: 'Acrescentar peça' });
  fireEvent.click(botoes[0]);
  await waitFor(() =>
    expect(pedidos.some((p) => p.includes('/core/workshop/parts'))).toBe(true),
  );
  /*
    O PEDIDO não é a RESPOSTA. Esperar só a URL da busca deixava os casos
    lerem logo depois, síncronos, a "Quantidade de …" e os botões "Lançar" da
    gaveta — que só nascem quando a resposta é desenhada. Sob carga, a lista
    ainda era "Abrindo a gaveta…" (visto sozinho, 2 de 3 rodadas vermelhas com
    o React atrasado em 20 ms). A gaveta chega num `setAchados` só: quando a
    frase de espera some, a lista inteira — ou o estado vazio dela — está na
    tela.
  */
  await waitFor(() => expect(screen.queryByText('Abrindo a gaveta…')).toBeNull());
}

describe('acrescentar peça à OS', () => {
  it('busca na gaveta DAQUELA bancada, lança, e o estado vazio some', async () => {
    montar();
    // A premissa: enquanto nada foi lançado, a tabela mostra o estado vazio —
    // que era tudo o que esta tela sabia fazer antes.
    expect(await screen.findByText('Nenhuma peça')).toBeTruthy();

    await abrirAGaveta();

    // O recorte da bancada vai na URL: sem ele o mecânico de celular escolheria
    // um pneu e o servidor recusaria depois (`CORE_PART_OTHER_WORKSHOP`).
    const busca = pedidos.find((p) => p.includes('/core/workshop/parts'))!;
    expect(busca).toContain(`workshopId=${BANCADA}`);
    expect(await screen.findByText('Conector de carga')).toBeTruthy();
    expect(screen.queryByText('Pneu traseiro')).toBeNull();

    // Quantidade: o padrão é 1, e quem troca a peça leva 2.
    fireEvent.change(screen.getByLabelText('Quantidade de Conector de carga'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[0]);

    // O estado vazio some porque a OS foi RELIDA e agora tem peça — não porque
    // a tela guardou o que mandou.
    await waitFor(() => expect(screen.queryByText('Nenhuma peça')).toBeNull());
    // Na tabela da CONTA, que é a que não existia antes de a peça ser lançada.
    const naConta = linhaDe(tabelaDaConta(), 'Conector de carga');
    expect(within(naConta).getByText('2')).toBeTruthy();
    expect(within(naConta).getByText('R$ 180,00')).toBeTruthy();
    // A conta do cabeçalho subiu junto: 50,00 de mão de obra + 180,00 de peça.
    expect(screen.getByText('R$ 230,00')).toBeTruthy();
    // E a gaveta foi RELIDA: o saldo na tela é o de agora (6 − 2), não o de
    // antes. Sem a releitura, a conferência seguinte seria feita contra um
    // número velho.
    await waitFor(() =>
      expect(within(linhaDe(tabelaDaGaveta(), 'Conector de carga')).getByText('4')).toBeTruthy(),
    );
  });

  it('a busca por nome estreita a gaveta, e o que não bate diz por quê', async () => {
    montar();
    await abrirAGaveta();

    const campo = screen.getByPlaceholderText(/Nome, código ou código de barras/);
    fireEvent.change(campo, { target: { value: 'martelo' } });
    fireEvent.keyDown(campo, { key: 'Enter' });

    // A frase nomeia o que foi digitado: "nenhum resultado" mandaria a pessoa
    // desconfiar da bancada em vez do termo.
    expect(await screen.findByText(/Nenhuma peça desta bancada bate com "martelo"/)).toBeTruthy();
  });
});

/**
 * A RECUSA DO SERVIDOR CHEGA INTEIRA NA TELA.
 *
 * As três recusas que interessam (peça sem preço, falta de peça com o número, e
 * OS de outro técnico) chegam com texto pronto da bancada. Um `catch` que
 * escrevesse "Falha ao lançar a peça" por cima transformaria a informação que
 * resolve o problema num aviso que não resolve nada — e é o erro mais fácil de
 * cometer, porque o texto genérico já está escrito ali como último recurso.
 */
describe('a recusa da bancada aparece com as palavras do servidor', () => {
  it('peça sem preço: a frase do servidor, não um erro genérico', async () => {
    montar();
    await abrirAGaveta();

    recusaDoServidor = {
      status: 409,
      code: 'CORE_PART_WITHOUT_PRICE',
      message:
        'A peça "Conector de carga" está sem preço de venda: ela entraria na OS por R$ 0,00 e o '
        + 'conserto fecharia sem custo nenhum. Quem define o preço é o cadastro do produto — '
        + 'peça a quem cuida do catálogo antes de lançar.',
    };
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[0]);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('sem preço de venda');
    expect(aviso.textContent).toContain('cadastro do produto');
    // O texto de último recurso NÃO entrou no lugar da mensagem boa.
    expect(aviso.textContent).not.toContain('Falha ao lançar a peça');
    // E nada foi lançado: o estado vazio continua onde estava.
    expect(screen.getByText('Nenhuma peça')).toBeTruthy();
  });

  it('falta de peça: os números da bancada chegam ao mecânico', async () => {
    montar();
    await abrirAGaveta();

    recusaDoServidor = {
      status: 409,
      code: 'CORE_INSUFFICIENT_STOCK',
      message: 'Falta peça: "Conector de carga" tem 1 na gaveta e a OS pediu 3.',
    };
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[0]);

    const aviso = await screen.findByRole('alert');
    // O nome e os dois números: é o que quem está com o aparelho aberto usa
    // para decidir se espera a reposição ou fecha o conserto.
    expect(aviso.textContent).toContain('Conector de carga');
    expect(aviso.textContent).toContain('1 na gaveta');
    expect(aviso.textContent).toContain('pediu 3');
  });

  /**
   * A RECUSA MORA DENTRO DO CARD, colada no que foi clicado.
   *
   * "Falta peça: Conector tem 1 e a OS pediu 3" no topo da página, acima do
   * cabeçalho do cliente, é uma mensagem que ninguém lê: o olho está na tabela
   * da gaveta, que é onde o clique aconteceu.
   */
  it('a recusa fica no card das peças, não no topo da página', async () => {
    montar();
    await abrirAGaveta();

    recusaDoServidor = {
      status: 409,
      code: 'CORE_INSUFFICIENT_STOCK',
      message: 'Falta peça: "Conector de carga" tem 1 na gaveta e a OS pediu 3.',
    };
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[0]);

    await screen.findByRole('alert');
    expect(within(cardDePecas()).getByRole('alert')).toBeTruthy();
  });
});

describe('devolver a peça pela linha da tabela', () => {
  it('devolve o que não foi usado, e a conta da OS cai junto', async () => {
    montar();
    await abrirAGaveta();

    fireEvent.change(screen.getByLabelText('Quantidade de Parafuso pentalobe'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[1]);
    await waitFor(() => expect(screen.queryByText('Nenhuma peça')).toBeNull());
    // 50,00 + 3 × 3,00.
    expect(screen.getByText('R$ 59,00')).toBeTruthy();

    // A devolução começa pela LINHA da peça aplicada, e vem preenchida com o
    // que ainda está na OS — o caso comum é devolver tudo o que sobrou.
    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    const quanto = screen.getByLabelText('Quantidade a devolver de Parafuso pentalobe');
    expect((quanto as HTMLInputElement).value).toBe('3');
    fireEvent.change(quanto, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    // O cliente não paga pelo parafuso que está de volta na gaveta.
    await waitFor(() => expect(screen.getByText('R$ 56,00')).toBeTruthy());
    // E a linha CONTINUA na tabela, dizendo quanto voltou. Sumir com ela faria
    // a OS parecer que a peça nunca saiu — e ela saiu, e duas ficaram.
    const linha = linhaDe(tabelaDaConta(), 'Parafuso pentalobe');
    // `formatCents` usa `toLocaleString`, que separa o "R$" do número com
    // espaço RÍGIDO (U+00A0). Comparar o texto cru falharia por um caractere
    // invisível — o mesmo tipo de armadilha que faz teste bom parecer defeito.
    const numeros = within(linha)
      .getAllByRole('cell')
      .map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
    // Requisitadas 3, devolvida 1, cobradas 2 × R$ 3,00.
    expect(numeros).toContain('3');
    expect(numeros).toContain('1');
    expect(numeros).toContain('R$ 6,00');
    const enviado = pedidos.find((p) => p.includes('/return'))!;
    expect(enviado).toContain('POST');
  });

  it('cancelar a devolução não devolve nada', async () => {
    montar();
    await abrirAGaveta();
    fireEvent.click(screen.getAllByRole('button', { name: 'Lançar' })[0]);
    await waitFor(() => expect(screen.queryByText('Nenhuma peça')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Devolver' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull());
    expect(pedidos.some((p) => p.includes('/return'))).toBe(false);
  });
});

/**
 * O MECÂNICO NÃO VÊ CUSTO — e a tela é a segunda metade dessa regra.
 *
 * A primeira metade é do servidor: `listParts` REMOVE `cost_cents` da resposta
 * para quem não é gerente ou estoquista, e há teste de servidor cobrando isso.
 * A metade daqui é a que só a tela prova: a busca desta OS vai ao endereço das
 * PEÇAS e não ao catálogo — o catálogo devolveria o custo para todo mundo — e a
 * tabela não tem coluna de custo nenhuma para preencher.
 */
describe('o mecânico não vê custo na tela da peça', () => {
  it('a busca vai ao endereço das peças, e não ao catálogo', async () => {
    montar();
    await abrirAGaveta();

    expect(pedidos.some((p) => p.includes('/core/workshop/parts'))).toBe(true);
    // `/core/products/search` devolve `cost_cents` para qualquer perfil: usá-lo
    // aqui vazaria o custo por inspeção do navegador, sem nada aparecer na tela.
    expect(pedidos.some((p) => p.includes('/core/products'))).toBe(false);
  });

  it('a tabela da gaveta mostra PREÇO e não tem coluna de custo', async () => {
    montar();
    await abrirAGaveta();
    await screen.findByText('Conector de carga');

    const card = cardDePecas();
    const cabecalhos = within(card)
      .getAllByRole('columnheader')
      .map((c) => c.textContent?.trim());
    expect(cabecalhos).toContain('Preço');
    // O preço é o que entra na conta do cliente e o mecânico precisa vê-lo. O
    // custo é o que a empresa pagou no fornecedor, e não é assunto dele.
    expect(cabecalhos).not.toContain('Custo');
    expect(within(card).getByText('R$ 90,00')).toBeTruthy();
  });

  it('mesmo se o servidor vazar o custo, a tela não o imprime', async () => {
    // O cenário do dia em que alguém acrescentar um perfil ao `VEEM_CUSTO` sem
    // pensar nesta tela: o campo volta a sair do servidor. A tela continua sem
    // ter onde imprimi-lo, e este teste é o que garante que continue assim.
    (gaveta[0] as unknown as { cost_cents: number }).cost_cents = 4321;
    montar();
    await abrirAGaveta();
    await screen.findByText('Conector de carga');

    expect(screen.queryByText('R$ 43,21')).toBeNull();
    expect(screen.queryByText(/4321/)).toBeNull();
  });
});

/**
 * QUEM NÃO PODE LANÇAR NÃO RECEBE O BOTÃO.
 *
 * A tela não inventa regra: ela deixa de oferecer o que levaria 403 ou 409 do
 * servidor, e diz por quê. Botão que sempre falha ensina a pessoa a desconfiar
 * do sistema — e some junto com a informação de por que não dá.
 */
describe('a tela oferece o caminho só a quem o servidor deixaria passar', () => {
  it('o atendente abre a OS e vê a leitura, sem botão de peça', async () => {
    entrarComo('atendente', 'user-atendente');
    montar();
    await screen.findByText('Peças aplicadas');

    expect(screen.queryByRole('button', { name: 'Acrescentar peça' })).toBeNull();
    // E a tabela continua sendo o que sempre foi: leitura.
    expect(screen.getByText('Nenhuma peça reservada para esta OS.')).toBeTruthy();
  });

  it('a OS de OUTRO técnico explica por que não dá, em vez de sumir calada', async () => {
    entrarComo('mecanico', 'outro-mecanico');
    montar();
    await screen.findByText('Peças aplicadas');

    expect(screen.queryByRole('button', { name: 'Acrescentar peça' })).toBeNull();
    // O nome de quem assumiu: é a pessoa a quem ir pedir.
    expect(screen.getByText(/Esta OS foi assumida por Zé Mecânico/)).toBeTruthy();
  });

  it('OS finalizada não recebe peça — a conta já fechou', async () => {
    os.status = 'finalizada';
    montar();
    await screen.findByText('Peças aplicadas');

    expect(screen.queryByRole('button', { name: 'Acrescentar peça' })).toBeNull();
    expect(screen.getByText(/OS finalizada: a conta já fechou/)).toBeTruthy();
  });
});
