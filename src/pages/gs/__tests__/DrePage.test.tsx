/**
 * ============================================================================
 * A TELA DO DRE — e a ressalva, que é a parte que não pode faltar
 * ============================================================================
 *
 * ## O que não pode errar, e por quê
 *
 * 1. O REGIME APARECE ANTES DO NÚMERO. Competência e caixa produzem resultados
 *    diferentes sobre os mesmos fatos. Quem lê "resultado do período" sem saber
 *    qual dos dois está vendo não tem como usar o número — e vai usá-lo assim
 *    mesmo.
 *
 * 2. O PERÍODO PADRÃO É O MÊS CORRENTE, e nunca "tudo". Um DRE sem recorte
 *    soma a história inteira da empresa numa coluna: parece grande, não
 *    significa nada, e ninguém percebe porque não há nada na tela que diga que
 *    o período é infinito. Por isso o teste olha a URL da requisição, e não o
 *    que está desenhado.
 *
 * 3. A TELA NÃO REFAZ A CONTA. Todos os totais vêm prontos do servidor, que já
 *    conferiu três invariantes antes de devolvê-los. O teste que prova isso usa
 *    um corpo DELIBERADAMENTE INCONSISTENTE — `resultCents` que não é
 *    `receita - despesa`, totais de lado que não são a soma das linhas — e
 *    exige que a tela mostre o que o servidor mandou. É o único jeito de
 *    detectar uma segunda aritmética: uma que dá o mesmo resultado é invisível
 *    até o dia em que diverge.
 *
 * 4. "SEM CATEGORIA" APARECE NOS DOIS LADOS. Esconder o balde anônimo de um dos
 *    lados faria o total não bater com a soma visível das linhas — e um
 *    relatório que não fecha na tela perde a confiança inteira por causa de uma
 *    decisão de layout.
 *
 * 5. A RESSALVA É FIXA, SEMPRE ABERTA, E COMPLETA. Ela vem logo abaixo do
 *    resultado, renderiza TODAS as frases do servidor e não tem controle de
 *    recolher. Um painel que recolhe é um painel que fica recolhido: a pessoa
 *    fecha uma vez para ver o número inteiro e nunca mais abre.
 *
 * 6. A DIFERENÇA PARA O PAINEL TEM NOME E VALOR. Duas telas do mesmo sistema
 *    mostrando faturamentos diferentes do mesmo mês, sem explicação, levam à
 *    conclusão de que o sistema está errado — e daí à escolha do número
 *    preferido.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire "COMPETÊNCIA" do título e o primeiro cai;
 *   - mande o período vazio (ou não mande período) e o segundo cai;
 *   - calcule `receita - despesa` na tela e o bloco da aritmética cai;
 *   - filtre a linha de categoria nula em qualquer um dos lados e o quarto cai;
 *   - ponha `collapsible` na ressalva, ou deixe de renderizar uma frase da
 *     lista, e o bloco da ressalva cai;
 *   - troque as parcelas nomeadas por um link seco para o painel e o sexto cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DrePage from '../DrePage';
import { respostaDaBarraDoShell } from './barraDoShell';

/** As frases que o servidor manda sempre. A tela renderiza a lista inteira. */
const RESSALVA_FIXA = [
  /*
    A PRIMEIRA FRASE MUDOU DE ASSUNTO na rodada do CMV (GAP-V28).

    Ela dizia "Não há CMV nem margem: o custo do item não é gravado no momento
    da venda" — e ficou FALSA no minuto em que `core_sale_items.cost_cents`
    passou a existir. O que continua verdadeiro, e por isso segue impresso, é o
    ALCANCE: o CMV é gerencial, mede pela data da venda, e não é descontado do
    resultado porque a compra já entrou como despesa.
  */
  'O CMV é medido pela data da VENDA e não é descontado do resultado: a compra da mercadoria já entra aqui como despesa, no título da nota de entrada — tirá-la duas vezes seria contar a mesma compra duas vezes.',
  'Não há rateio: cada lançamento pertence inteiro à empresa em que foi lançado.',
  'Não há provisão nem depreciação.',
  'É regime de COMPETÊNCIA, não de caixa: conta o mês do fato, não o dia em que o dinheiro entrou ou saiu.',
  'A devolução aparece como DESPESA, na categoria dela — não como desconto da receita. Fazer as duas coisas a contaria duas vezes.',
  'Comissão estornada depois do fechamento não volta a este resultado: o estorno entra na apuração seguinte.',
];

/**
 * Agosto na PJ Motors, com os números do banco real.
 *
 * O painel soma R$ 1.074,75 (só venda de balcão) e o DRE soma R$ 1.403,75 —
 * a diferença de R$ 329,00 é pedido online mais lançamento manual, e as duas
 * parcelas somam exatamente a diferença.
 */
const AGOSTO = {
  companyId: 'cfc491b0',
  from: '2026-08-01',
  to: '2026-08-31',
  revenue: {
    lines: [
      {
        categoryId: 'cat-venda',
        categoryName: 'Venda de mercadoria',
        systemCode: 'venda',
        totalCents: 107475,
        entryCount: 3,
      },
      {
        categoryId: 'cat-online',
        categoryName: 'Pedido online',
        systemCode: 'ecommerce',
        totalCents: 22900,
        entryCount: 1,
      },
      {
        categoryId: null,
        categoryName: 'Sem categoria',
        systemCode: null,
        totalCents: 10000,
        entryCount: 1,
      },
    ],
    totalCents: 140375,
    entryCount: 5,
  },
  expense: {
    lines: [
      {
        categoryId: 'cat-fornecedor',
        categoryName: 'Fornecedores',
        systemCode: 'fornecedor',
        totalCents: 80000,
        entryCount: 2,
      },
      {
        categoryId: 'cat-devolucao',
        categoryName: 'Devolução de venda',
        systemCode: 'devolucao',
        totalCents: 15000,
        entryCount: 1,
      },
      {
        categoryId: null,
        categoryName: 'Sem categoria',
        systemCode: null,
        totalCents: 5000,
        entryCount: 1,
      },
    ],
    totalCents: 100000,
    entryCount: 4,
  },
  resultCents: 40375,
  /*
    O CMV (GAP-V28) chega PRONTO, como o resto: custo, receita considerada,
    margem e as TRÊS contagens que dizem sobre quanto do período o número fala.
    O cenário tem as três populações vivas de propósito — 4 linhas com custo, 1
    sem custo cadastrado e 2 anteriores ao snapshot —, para que a tela tenha de
    renderizar as duas frases de alcance.
  */
  cogs: {
    costCents: 60000,
    revenueCents: 100000,
    marginCents: 40000,
    marginPercent: 40,
    itemsWithCost: 4,
    itemsWithoutCost: 1,
    itemsBeforeSnapshot: 2,
  },
  uncategorized: { entryCount: 2, revenueCents: 10000, expenseCents: 5000 },
  reconciliation: {
    panelRevenueCents: 107475,
    statementRevenueCents: 140375,
    differenceCents: 32900,
    lines: [
      {
        key: 'ecommerce_order',
        label: 'Pedido online: entra no DRE e não no painel',
        cents: 22900,
      },
      {
        key: 'manual',
        label: 'Lançamento manual de receita: entra no DRE e não no painel',
        cents: 10000,
      },
    ],
  },
  caveats: [
    ...RESSALVA_FIXA,
    '2 lançamento(s) sem categoria, somando R$ 150,00 (R$ 100,00 em receita e R$ 50,00 em despesa).',
  ],
};

/** O mês em que painel e DRE coincidem: só houve venda de balcão. */
const MES_QUE_BATE = {
  ...AGOSTO,
  uncategorized: { entryCount: 0, revenueCents: 0, expenseCents: 0 },
  reconciliation: {
    panelRevenueCents: 107475,
    statementRevenueCents: 107475,
    differenceCents: 0,
    lines: [],
  },
  caveats: RESSALVA_FIXA,
};

/**
 * Um corpo IMPOSSÍVEL, de propósito.
 *
 * `resultCents` não é `receita - despesa`, e os totais dos lados não são a soma
 * das linhas. Nenhum servidor devolveria isto — ele estoura antes. O corpo
 * existe para uma pergunta só: a tela está MOSTRANDO o que recebeu, ou está
 * refazendo a conta por baixo? Se refizer, os números da tela serão os
 * "certos" e o teste cai.
 */
const IMPOSSIVEL = {
  ...AGOSTO,
  revenue: { ...AGOSTO.revenue, totalCents: 999999 },
  expense: { ...AGOSTO.expense, totalCents: 111111 },
  resultCents: 777777,
};

let urls: string[] = [];

function servidor(resposta: { status?: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      urls.push(String(url));
      return new Response(JSON.stringify(resposta.body), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  urls = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function montar() {
  render(
    <MemoryRouter>
      <DrePage />
    </MemoryRouter>,
  );
}

/** Hoje no fuso local — a mesma conta que a tela faz, e pelo mesmo motivo. */
function hojeLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const ressalva = () => screen.getByLabelText('O que este resultado não inclui');

/**
 * O cartão de um indicador, a partir do rótulo dele.
 *
 * A busca é escopada porque os mesmos valores aparecem de propósito em mais de
 * um lugar da tela — o total da receita vive no indicador e no rodapé da
 * tabela, e é justamente isso que se quer conferir. Sem escopo, o teste
 * quebraria por ambiguidade em vez de medir o que pretende.
 */
const indicador = (rotulo: string) => screen.getByText(rotulo).closest('div') as HTMLElement;

const cardDe = (titulo: string) =>
  screen.getByText(titulo).closest('section') as HTMLElement;

describe('o regime está no título, antes de qualquer número', () => {
  it('a tela diz COMPETÊNCIA no cabeçalho', async () => {
    servidor({ body: AGOSTO });
    montar();

    // Competência e caixa dão números diferentes. Qual dos dois é este não
    // pode ser uma nota de rodapé: a leitura do número acontece antes.
    await screen.findByText(/regime de COMPETÊNCIA/);
    await screen.findByText(/Conta o mês do FATO/);
  });
});

describe('o período padrão é o mês corrente, e nunca "tudo"', () => {
  it('a primeira requisição já vai recortada no mês', async () => {
    servidor({ body: AGOSTO });
    montar();

    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    const hoje = hojeLocal();
    const url = urls[0];

    /*
      O recorte olhado NO FIO, e não na tela.

      Um seletor de data desenhado com o mês corrente e uma requisição sem
      `from`/`to` são exatamente a mesma imagem para quem olha — e a segunda
      soma a empresa inteira. O defeito só aparece aqui.
    */
    expect(url).toContain(`from=${hoje.slice(0, 7)}-01`);
    expect(url).toContain(`to=${hoje}`);
  });

  it('a data vai como YYYY-MM-DD, sem timestamp colado', async () => {
    servidor({ body: AGOSTO });
    montar();

    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    // O painel mandava `T23:59:59.999Z` para contornar um recorte quebrado no
    // servidor. Repetir o contorno aqui faria a conciliação comparar dois
    // recortes ligeiramente diferentes do mesmo período.
    expect(urls[0]).not.toContain('T23');
    expect(urls[0]).not.toContain('%3A');
  });
});

describe('a aritmética é a do servidor, e a tela não tem uma segunda', () => {
  it('receita, despesa e resultado saem do corpo, mesmo quando não fecham entre si', async () => {
    servidor({ body: IMPOSSIVEL });
    montar();

    /*
      O CORAÇÃO DESTE ARQUIVO.

      999.999 − 111.111 = 888.888, e o corpo diz 777.777. Uma tela que
      recalcula mostraria 8.888,88; esta mostra 7.777,77, porque o número do
      relatório é o do servidor — que já conferiu que nenhum lançamento entrou
      em duas linhas nem ficou de fora.

      A versão anterior deste relatório errava R$ 100,00 justamente porque a
      mesma conta era feita em lugares que se pareciam. Uma quarta cópia aqui
      não seria detectável no dia em que concordasse.
    */
    await waitFor(() => expect(indicador('Resultado')).toBeTruthy());
    expect(within(indicador('Receita')).getByText('R$ 9.999,99')).toBeTruthy();
    expect(within(indicador('Despesa')).getByText('R$ 1.111,11')).toBeTruthy();
    expect(within(indicador('Resultado')).getByText('R$ 7.777,77')).toBeTruthy();
    expect(screen.queryByText('R$ 8.888,88')).toBeNull();
  });

  it('o total de cada lado é o do servidor, e não a soma das linhas desenhadas', async () => {
    servidor({ body: IMPOSSIVEL });
    montar();

    await waitFor(() => expect(cardDe('Receita por categoria')).toBeTruthy());
    const cardReceita = cardDe('Receita por categoria');
    // As linhas somam 140.375; o corpo diz 999.999. Quem manda é o corpo.
    expect(within(cardReceita).getByText('R$ 9.999,99')).toBeTruthy();
    expect(within(cardReceita).queryByText('R$ 1.403,75')).toBeNull();
  });
});

describe('receita e despesa saem por categoria, com o balde anônimo à vista', () => {
  it('as categorias dos DOIS lados aparecem', async () => {
    servidor({ body: AGOSTO });
    montar();

    // A receita por categoria é metade da justificativa da rodada: sem ela, a
    // categoria automática de venda e o backfill não mudariam uma linha da
    // tela.
    await screen.findByText('Venda de mercadoria');
    await screen.findByText('Pedido online');
    await screen.findByText('Fornecedores');
    await screen.findByText('Devolução de venda');
  });

  it('"SEM CATEGORIA" aparece marcado nos DOIS lados, e não só num', async () => {
    servidor({ body: AGOSTO });
    montar();

    const receita = (await screen.findByText('Receita por categoria')).closest(
      'section',
    ) as HTMLElement;
    const despesa = (await screen.findByText('Despesa por categoria')).closest(
      'section',
    ) as HTMLElement;

    /*
      Esconder o balde anônimo de um dos lados deixaria o total daquele lado
      maior que a soma das linhas visíveis. Quem confere na mão — que é
      exatamente quem abre um DRE — encontra a diferença e deixa de confiar no
      relatório inteiro.
    */
    expect(within(receita).getByText('SEM CATEGORIA')).toBeTruthy();
    expect(within(despesa).getByText('SEM CATEGORIA')).toBeTruthy();

    // E cada lado diz quanto é o seu, para a linha ser acionável.
    expect(within(receita).getByText(/1 lançamento\(s\) sem categoria/)).toBeTruthy();
    expect(within(despesa).getByText(/1 lançamento\(s\) sem categoria/)).toBeTruthy();
  });
});

describe('a ressalva: fixa, sempre aberta, e inteira', () => {
  it('todas as frases do servidor são renderizadas — nenhuma escolhida a dedo', async () => {
    servidor({ body: AGOSTO });
    montar();

    const painel = await waitFor(() => ressalva());
    for (const frase of AGOSTO.caveats) {
      expect(within(painel).getByText(frase)).toBeTruthy();
    }
    // A contagem também: renderizar todas MENOS a última continuaria passando
    // no laço acima se a lista fosse filtrada antes.
    expect(within(painel).getAllByRole('listitem')).toHaveLength(AGOSTO.caveats.length);
  });

  it('não há nada para recolher: o painel não tem controle de fechar', async () => {
    servidor({ body: AGOSTO });
    montar();

    const painel = await waitFor(() => ressalva());
    /*
      `Card` com `collapsible` desenha um botão de recolher. A ressalva NÃO é
      um Card com esse controle, de propósito: um painel que recolhe é um
      painel que fica recolhido, e a partir daí o DRE volta a ser um total sem
      contexto — a limitação tecnicamente presente e praticamente ausente.
    */
    expect(within(painel).queryByRole('button')).toBeNull();
    expect(within(painel).queryByLabelText('Recolher')).toBeNull();
  });

  it('a ressalva vem DEPOIS do resultado, grudada nele', async () => {
    servidor({ body: AGOSTO });
    montar();

    // Esperar o painel PRIMEIRO importa: `findByText` devolve o primeiro
    // casamento que aparecer, e antes da resposta chegar a tela ainda não tem
    // indicador nenhum. Sem esta espera o teste compararia a posição de outro
    // elemento qualquer e passaria sem provar nada.
    const painel = await waitFor(() => ressalva());
    const resultado = screen.getByText('Resultado');
    // Ordem importa: a limitação precisa ser lida por quem acabou de ler o
    // número, não por quem rolou a página inteira até o rodapé.
    expect(
      resultado.compareDocumentPosition(painel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('a frase condicional some quando não é verdade', async () => {
    servidor({ body: MES_QUE_BATE });
    montar();

    const painel = await waitFor(() => ressalva());
    // Ressalva que aparece sempre vira paisagem. A contagem de "sem categoria"
    // só existe quando existem lançamentos sem categoria.
    expect(within(painel).queryByText(/sem categoria, somando/)).toBeNull();
    expect(within(painel).getAllByRole('listitem')).toHaveLength(RESSALVA_FIXA.length);
  });
});

describe('painel × DRE: a diferença tem nome e valor', () => {
  it('os dois números aparecem juntos, com a diferença decomposta', async () => {
    servidor({ body: AGOSTO });
    montar();

    await waitFor(() => expect(cardDe('Por que o Painel mostra outro faturamento')).toBeTruthy());
    const bloco = cardDe('Por que o Painel mostra outro faturamento');

    // Os dois números lado a lado, no MESMO bloco: é a comparação que a tela
    // precisa fazer no lugar de quem olharia duas telas e concluiria que uma
    // delas está errada.
    expect(within(bloco).getByText('R$ 1.074,75')).toBeTruthy();
    expect(within(bloco).getByText('R$ 1.403,75')).toBeTruthy();
    expect(within(bloco).getByText('R$ 329,00')).toBeTruthy();

    /*
      As PARCELAS, e não só o total da diferença. O servidor confere que elas
      somam exatamente a diferença e estoura se não somarem — uma lista de
      motivos que não fecha é pior que motivo nenhum, porque tem cara de
      explicação.
    */
    expect(within(bloco).getByText('Pedido online: entra no DRE e não no painel')).toBeTruthy();
    expect(
      within(bloco).getByText('Lançamento manual de receita: entra no DRE e não no painel'),
    ).toBeTruthy();
    expect(within(bloco).getByText('R$ 229,00')).toBeTruthy();
    expect(within(bloco).getByText('R$ 100,00')).toBeTruthy();
  });

  it('o link para o painel vem acompanhado do motivo, nunca sozinho', async () => {
    servidor({ body: AGOSTO });
    montar();

    const link = await screen.findByRole('link', { name: 'Painel' });
    expect(link.getAttribute('href')).toBe('/sistema/painel');
    // Link mudo entre dois números que discordam é pior que não ter link.
    await screen.findByText(/ele mede pela data da venda e só conta venda de balcão/);
  });

  it('quando os dois batem, a tela diz isso — e o bloco continua existindo', async () => {
    servidor({ body: MES_QUE_BATE });
    montar();

    await screen.findByText('Neste período os dois números coincidem.');
    // "Hoje bate" é informação, e ela some no dia em que deixar de bater.
    expect(screen.queryByText(/entra no DRE e não no painel/)).toBeNull();
  });
});

describe('a recusa de permissão se identifica', () => {
  it('403 diz que o perfil não abre o resultado, e não "falha ao carregar"', async () => {
    servidor({
      status: 403,
      body: { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } },
    });
    montar();

    // 403 mostrado como erro genérico faz a pessoa chamar o suporte por um
    // sistema que está funcionando exatamente como deveria.
    await screen.findByText('Seu perfil não abre o resultado do período');
    expect(screen.queryByText('Receita por categoria')).toBeNull();
  });
});

/**
 * ============================================================================
 * O CMV NA TELA — GAP-V28
 * ============================================================================
 *
 * O risco desta seção é específico e caro: o CMV, mostrado ao lado do
 * resultado, ser LIDO como um quarto número do resultado. A compra da
 * mercadoria já entrou no DRE como despesa, no título da nota de entrada;
 * quem subtrair o CMV do resultado tira a mesma compra duas vezes — e o
 * número que sai dessa conta é plausível.
 *
 * Por isso os casos cobram a frase, e não só os números. E cobram também que
 * a tela mostre o ALCANCE: quantas linhas entraram na margem e quantas não.
 */
describe('o CMV aparece ao lado do resultado, com o alcance dito', () => {
  it('custo, margem e percentual saem do corpo — a tela não recalcula nada', async () => {
    servidor({ body: AGOSTO });
    montar();

    const bloco = await screen.findByLabelText('Custo da mercadoria vendida');
    expect(within(bloco).getByText('R$ 600,00')).toBeTruthy(); // CMV
    expect(within(bloco).getByText('R$ 400,00')).toBeTruthy(); // margem
    expect(within(bloco).getByText('40%')).toBeTruthy();
  });

  it('A FRASE QUE IMPEDE A CONTA ERRADA: "não descontado do resultado"', async () => {
    servidor({ body: AGOSTO });
    montar();

    const bloco = await screen.findByLabelText('Custo da mercadoria vendida');
    await within(bloco).findByText(/não descontado do resultado/);
    // E o motivo vem junto: sem ele, a frase parece arbitrária e alguém a
    // "corrige" na rodada seguinte.
    await within(bloco).findByText(/já entra no DRE como despesa/);
  });

  it('diz sobre quantas linhas a margem vale, e quantas ficaram de fora', async () => {
    servidor({ body: AGOSTO });
    montar();

    const bloco = await screen.findByLabelText('Custo da mercadoria vendida');
    // 4 com custo, 1 sem custo cadastrado, 2 anteriores ao snapshot.
    await within(bloco).findByText(/vale sobre 4 linha\(s\)/);
    await within(bloco).findByText(/1 ficaram de fora por o produto estar sem custo cadastrado/);
    await within(bloco).findByText(/2 são de vendas anteriores/);
  });

  it('período sem NENHUMA linha com custo não mostra margem zero — diz que não há CMV', async () => {
    /*
      É o retrato de todo mês anterior a esta rodada. Mostrar "CMV R$ 0,00,
      margem 100%" seria o número bonito e falso que a recusa original do DRE
      existia para evitar.
    */
    servidor({
      body: {
        ...AGOSTO,
        cogs: {
          costCents: 0,
          revenueCents: 0,
          marginCents: 0,
          marginPercent: null,
          itemsWithCost: 0,
          itemsWithoutCost: 0,
          itemsBeforeSnapshot: 9,
        },
      },
    });
    montar();

    const bloco = await screen.findByLabelText('Custo da mercadoria vendida');
    await within(bloco).findByText(/Não há CMV para este período/);
    await within(bloco).findByText(/não há conserto retroativo/);
    expect(within(bloco).queryByText('100%')).toBeNull();
    expect(within(bloco).queryByText('0%')).toBeNull();
  });

  it('percentual nulo vira travessão, e nunca 0%', async () => {
    servidor({
      body: {
        ...AGOSTO,
        cogs: { ...AGOSTO.cogs, marginPercent: null, itemsWithCost: 1, itemsBeforeSnapshot: 0 },
      },
    });
    montar();

    const bloco = await screen.findByLabelText('Custo da mercadoria vendida');
    // "Não dá para saber" e "vendeu sem lucro" são afirmações diferentes.
    expect(within(bloco).queryByText('0%')).toBeNull();
    expect(within(bloco).getByText('—')).toBeTruthy();
  });
});
