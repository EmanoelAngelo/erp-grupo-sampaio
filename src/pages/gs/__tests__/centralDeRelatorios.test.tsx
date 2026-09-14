/**
 * ============================================================================
 * A CENTRAL DE RELATÓRIOS NA TELA — GAP-V37
 * ============================================================================
 *
 * ## Por que o servidor verde não basta aqui
 *
 * A Central tem 18 casos verdes no servidor, e nenhum deles alcança o que
 * quebra deste lado. O servidor pode declarar que "estoque" não usa período e
 * a tela desenhar De/Até assim mesmo; pode devolver `money` em centavos e a
 * tela escrever "600" onde deveria estar "R$ 6,00"; pode montar o CSV certo e
 * a tela baixá-lo por `<a href>`, que chega 401 porque navegação não manda
 * cabeçalho. Toda vez que este projeto teve um defeito desse feitio, o teste
 * de servidor estava verde.
 *
 * ## Como cada caso fica vermelho
 *
 *   - desenhe os filtros com uma lista escrita nesta tela em vez da declarada
 *     pelo servidor, e o caso dos filtros cai (a tela passa a oferecer período
 *     num relatório que não o usa);
 *   - formate `money` sem dividir por 100 e a tabela mostra centavo cru;
 *   - troque `apiBinary` por um link e o Blob nunca chega ao `salvarArquivo`;
 *   - some o rodapé de totais, ou calcule-o na tela, e o caso do rodapé cai;
 *   - esconda a ressalva do servidor e o caso da ressalva cai — que é o que
 *     mais importa, porque o arquivo circula FORA do sistema;
 *   - acrescente um botão "PDF" e o último caso cai: não há biblioteca de PDF
 *     no servidor, e um botão que gera HTML com outro nome é rótulo mentiroso.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import RelatoriosPage from '../RelatoriosPage';

let urls: string[] = [];
let salvos: { nome: string }[] = [];

const CATALOGO = [
  {
    id: 'vendas',
    label: 'Vendas do período',
    group: 'Vendas',
    description: 'Uma linha por venda.',
    filters: ['periodo', 'situacao'],
    columns: [
      { key: 'numero', label: 'Número', kind: 'number' },
      { key: 'dia', label: 'Dia', kind: 'date' },
      { key: 'cliente', label: 'Cliente', kind: 'text' },
      { key: 'total_cents', label: 'Total', kind: 'money' },
    ],
    caveat: 'O dia é o da LOJA (fuso de São Paulo).',
  },
  {
    /*
      O relatório SEM período existe no dublê de propósito: é ele que prova
      que a tela desenha o filtro declarado, e não uma lista própria. O aging
      real é assim — ele é uma fotografia de HOJE, e um De/Até nele seria um
      controle que não faz nada.
    */
    id: 'aging',
    label: 'Vencidos por faixa de idade',
    group: 'Financeiro',
    description: 'A receber e a pagar por idade.',
    filters: [],
    columns: [
      { key: 'direcao', label: 'Direção', kind: 'text' },
      { key: 'd90_cents', label: 'Mais de 90 dias', kind: 'money' },
    ],
    caveat: 'A régua é HOJE no fuso da loja, e quem envelhece é o SALDO.',
  },
];

const VENDAS = {
  report: CATALOGO[0],
  from: '2026-06-01',
  to: '2026-06-10',
  rows: [
    { numero: 12, dia: '2026-06-10', cliente: 'Maria', total_cents: 24_690 },
        // A segunda linha é do dia 8, e não do 9, de propósito: o caso da data
    // confere que o dia 10 não RECUOU para 9. Com uma linha legítima no dia 9,
    // a asserção passaria a medir a linha errada.
    { numero: 11, dia: '2026-06-08', cliente: 'Consumidor', total_cents: 6_789 },
  ],
  totals: { total_cents: 31_479 },
  generatedAt: '2026-06-10T18:00:00.000Z',
  truncated: false,
  rowCount: 2,
};

const AGING = {
  report: CATALOGO[1],
  from: '2026-06-01',
  to: '2026-06-10',
  rows: [{ direcao: 'A receber', d90_cents: 150_000 }],
  totals: { d90_cents: 150_000 },
  generatedAt: '2026-06-10T18:00:00.000Z',
  truncated: false,
  rowCount: 1,
};

/*
  O RESULTADO QUE A ROTA DE VENDAS DEVOLVE NESTE TESTE.

  Mutável porque a truncagem é um ESTADO da resposta, e não do catálogo: o mesmo
  relatório volta cortado ou inteiro conforme o recorte pedido.
*/
let vendasDoServidor: typeof VENDAS = VENDAS;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const endereco = String(url);
      urls.push(endereco);
      if (endereco.includes('formato=csv')) {
        return new Response('﻿Número;Dia\r\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="vendas-2026-06-01-a-2026-06-10.csv"',
          },
        });
      }
      if (/\/core\/reports\/aging/.test(endereco)) return json(AGING);
      if (/\/core\/reports\/vendas/.test(endereco)) return json(vendasDoServidor);
      return json({ items: CATALOGO });
    }),
  );
}

function entrar() {
  setSession(
    {
      accessToken: 'token-do-gerente',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'conceito', tradeName: 'Conceito', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da central',
  );
}

async function montar() {
  entrar();
  servidor();
  render(
    <MemoryRouter>
      <RelatoriosPage />
    </MemoryRouter>,
  );
  // Pelo BOTÃO da lista, e não pelo texto: "Vendas do período" aparece duas
  // vezes de propósito — no seletor à esquerda e no título do card.
  await screen.findByRole('button', { name: 'Vendas do período' });
  await screen.findByRole('table');
}

beforeEach(() => {
  urls = [];
  salvos = [];
  vendasDoServidor = VENDAS;
  localStorage.clear();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:http://localhost/objeto'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    salvos.push({ nome: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da central');
  localStorage.clear();
});

describe('a tela desenha o catálogo do servidor, e nunca uma lista própria', () => {
  it('os relatórios aparecem agrupados, com o rótulo do servidor', async () => {
    await montar();
    // Os títulos de GRUPO do seletor.  porque 'Vendas' também é
    // a migalha do cabeçalho — o que se mede aqui é que o grupo existe.
    expect(screen.getAllByText('Vendas').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Financeiro').length).toBeGreaterThan(0);
    await screen.findByRole('button', { name: 'Vencidos por faixa de idade' });
  });

  it('A MORDIDA DOS FILTROS: relatório sem período NÃO desenha De/Até', async () => {
    /*
      É o caso que separa "a tela lê o catálogo" de "a tela tem a própria
      lista". Um De/Até num relatório que é uma fotografia de hoje é um
      controle que não faz nada — a mesma promessa vazia do botão que este
      projeto já removeu de outra tela.
    */
    await montar();
    expect(screen.getByLabelText('De')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Vencidos por faixa de idade' }));
    await screen.findByText(/A régua é HOJE no fuso da loja/);
    expect(screen.queryByLabelText('De')).toBeNull();
    expect(screen.queryByLabelText('Até')).toBeNull();
    // E o filtro de situação, que é do relatório de vendas, também some.
    expect(screen.queryByLabelText('Situação')).toBeNull();
  });

  it('o filtro de um relatório não vaza para o seguinte', async () => {
    await montar();
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'cancelled' } });
    await waitFor(() => expect(urls.some((u) => u.includes('situacao=cancelled'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Vencidos por faixa de idade' }));
    await waitFor(() => expect(urls.some((u) => u.includes('/core/reports/aging'))).toBe(true));
    // Situação carregada para o relatório seguinte filtraria por um status que
    // não existe lá, e a tabela viria vazia sem motivo visível.
    expect(urls.filter((u) => u.includes('/core/reports/aging')).every((u) => !u.includes('situacao'))).toBe(
      true,
    );
  });
});

describe('a tabela mostra o que o servidor mandou, do jeito que o tipo diz', () => {
  it('dinheiro vem em CENTAVO e é escrito em reais — nunca o número cru', async () => {
    await montar();
    const tabela = await screen.findByRole('table');
    // 24.690 centavos é R$ 246,90. Escrever "24690" seria o defeito mais
    // provável de uma coluna nova.
    expect(within(tabela).getByText('R$ 246,90')).toBeTruthy();
    expect(within(tabela).queryByText('24690')).toBeNull();
  });

  it('data de calendário não recua um dia', async () => {
    /*
      `new Date('2026-06-10')` é meia-noite UTC, e `toLocaleDateString` no fuso
      da loja devolve 09/06. Este projeto já foi mordido duas vezes por isso.
    */
    await montar();
    const tabela = await screen.findByRole('table');
    expect(within(tabela).getByText('10/06/2026')).toBeTruthy();
    expect(within(tabela).queryByText('09/06/2026')).toBeNull();
  });

  it('o rodapé traz os totais DO SERVIDOR — a tela não soma coluna', async () => {
    await montar();
    const tabela = await screen.findByRole('table');
    // Pelo : 'Total' é também o rótulo de uma coluna, e casar por texto
    // pegaria o cabeçalho.
    const rodape = tabela.querySelector('tfoot tr') as HTMLElement;
    expect(within(rodape).getByText('R$ 314,79')).toBeTruthy();
  });

  it('a ressalva do relatório é renderizada — ela vem do servidor', async () => {
    await montar();
    // Se a frase fosse texto solto nesta tela, a primeira reescrita deixaria
    // de fora justamente a que incomoda.
    await screen.findByText('O dia é o da LOJA (fuso de São Paulo).');
  });
});

describe('a exportação passa pelo Bearer, e não por um link', () => {
  it('o CSV chega como Blob e é salvo com o nome do Content-Disposition', async () => {
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    await waitFor(() => expect(salvos).toHaveLength(1));
    expect(salvos[0].nome).toBe('vendas-2026-06-01-a-2026-06-10.csv');
    // A requisição levou o token: sem ele o servidor responde 401 e a pasta de
    // downloads recebe um arquivo de erro em JSON.
    const pedido = (
      fetch as unknown as { mock: { calls: [string, { headers?: Record<string, string> }][] } }
    ).mock.calls.find(
      ([u]) => String(u).includes('formato=csv'),
    );
    expect(pedido).toBeTruthy();
    expect(
      (pedido![1]?.headers as Record<string, string>)?.Authorization,
    ).toBe('Bearer token-do-gerente');
  });

  it('a exportação leva os MESMOS filtros que a tabela na tela', async () => {
    await montar();
    fireEvent.change(screen.getByLabelText('Situação'), { target: { value: 'cancelled' } });
    await waitFor(() => expect(urls.some((u) => u.includes('situacao=cancelled'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    await waitFor(() => expect(salvos).toHaveLength(1));
    const csv = urls.find((u) => u.includes('formato=csv'))!;
    // Arquivo que ignora o filtro da tela é a forma mais silenciosa de o
    // download discordar do que a pessoa acabou de ler.
    expect(csv).toContain('situacao=cancelled');
  });
});

/**
 * ============================================================================
 * A TELA AFIRMA O QUE O ARQUIVO RELATIVIZA — a truncagem contada duas vezes
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * O CSV escreve "O relatório tem PELO MENOS {n} linhas e o arquivo traz as
 * primeiras {m}", e o "pelo menos" está lá por um motivo escrito: `rowCount` é
 * o que a consulta CONSEGUIU trazer, e num relatório cuja FONTE tem teto
 * próprio o total real pode ser maior do que isso. A tela escrevia o mesmo
 * número como fato — "{n} linha(s)" — na mesma resposta, sobre o mesmo corte.
 *
 * Numa funcionalidade cujo assunto É truncagem honesta, é a mesma assimetria
 * em miniatura: quem lê a tela recebe um total exato que o arquivo se recusa a
 * afirmar, e o número da tela é o que vira decisão.
 *
 * ## O LIMITE DO CONSERTO, e por que ele não vira "pelo menos" sempre
 *
 * Sem truncagem, `rowCount` É exato — a consulta trouxe tudo. Escrever "pelo
 * menos" ali seria trocar uma afirmação forte demais por uma fraca demais, e
 * ensinar o operador a desconfiar de um número que está certo. A ressalva
 * acompanha o corte, exatamente como no arquivo.
 *
 * QUEBRANDO DE PROPÓSITO: volte a tela ao "{n} linha(s)" seco e o primeiro
 * caso fica vermelho; ponha "pelo menos" também no não truncado e o segundo
 * fica.
 */
describe('a tela conta a truncagem com as MESMAS palavras do arquivo', () => {
  it('cortado: o total é "pelo menos", igual ao aviso do CSV', async () => {
    vendasDoServidor = { ...VENDAS, truncated: true, rowCount: 5_001 };
    await montar();

    const resultado = screen.getByText('Resultado').closest('section')!;
    expect(resultado.textContent).toContain('pelo menos 5001 linha(s)');
    // E o número do corte continua sendo o das linhas que vieram.
    expect(resultado.textContent).toContain('as primeiras 2');
  });

  it('inteiro: o total é FATO, e nenhuma ressalva o enfraquece', async () => {
    await montar();

    const resultado = screen.getByText('Resultado').closest('section')!;
    expect(resultado.textContent).toContain('2 linha(s)');
    expect(resultado.textContent).not.toContain('pelo menos');
  });
});

describe('a tela não promete o que não existe', () => {
  it('não há botão de PDF — e a tela diz o que existe no lugar', async () => {
    await montar();
    // Não há biblioteca de PDF no servidor. Oferecer o botão e entregar HTML
    // com outro nome seria rótulo mentiroso.
    expect(screen.queryByRole('button', { name: /PDF/i })).toBeNull();
    await screen.findByText(/Não há geração de PDF/);
    expect(screen.getByRole('button', { name: 'Imprimir' })).toBeTruthy();
  });
});
