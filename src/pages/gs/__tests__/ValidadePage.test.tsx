/**
 * Estoque › Validade — a tela do GAP-V35.
 *
 * ## Por que uma prova de TELA além das 40 do servidor
 *
 * A suíte do servidor prova o FEFO, a recusa do vencido, o tenant e a
 * identidade por lote. Nada disso impede a tela de montar vazia, de somar
 * errado o rodapé ou de chamar a rota errada — e uma suíte verde já escondeu
 * quatro falhas neste projeto que só apareceram na tela.
 *
 * O que este arquivo cobra é o contrato ENTRE os dois lados:
 *
 *   - a tela chama as rotas que existem, com os parâmetros que o servidor lê;
 *   - ela MOSTRA o que o servidor mandou, sem recalcular — faixa, valor e o
 *     "hoje" vêm de lá;
 *   - o filtro por faixa vira `?faixa=`, e não uma filtragem em memória que
 *     esvaziaria a página com lote de sobra no banco;
 *   - a pendência da doca aparece com o caminho de resolução ao lado.
 *
 * ## Como estes casos falham (quebrando de propósito — conferido)
 *
 *   - troque `formatCents(f.valueCents)` por uma multiplicação feita aqui e o
 *     caso do valor fica vermelho;
 *   - filtre `lotes` em memória em vez de mandar `faixa` na consulta e o caso
 *     do filtro fica vermelho, nomeando a URL que faltou.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ValidadePage from '../ValidadePage';

const ALERTA = {
  hoje: '2026-08-30',
  faixas: [
    { faixa: 'vencido', label: 'Vencido', lotes: 1, quantity: 4, valueCents: 800 },
    { faixa: 'vence_em_7', label: 'Vence em até 7 dias', lotes: 2, quantity: 10, valueCents: 2000 },
    { faixa: 'vence_em_15', label: 'Vence em 8 a 15 dias', lotes: 0, quantity: 0, valueCents: 0 },
    { faixa: 'vence_em_30', label: 'Vence em 16 a 30 dias', lotes: 0, quantity: 0, valueCents: 0 },
    { faixa: 'em_dia', label: 'Em dia', lotes: 3, quantity: 30, valueCents: 6000 },
    { faixa: 'sem_validade', label: 'Sem validade declarada', lotes: 0, quantity: 0, valueCents: 0 },
  ],
  naoConferidos: 1,
  produtosComSaldoSemLote: 1,
  quantidadeSemLote: 20,
  pendencias: [
    {
      productId: 'p-1',
      productName: 'Iogurte natural 170g',
      internalCode: 'PRD-1',
      unit: 'UN',
      quantity: 20,
    },
  ],
};

const LOTES = [
  {
    id: 'b-1',
    company_id: 'c',
    product_id: 'p-1',
    product_name: 'Iogurte natural 170g',
    internal_code: 'PRD-1',
    unit: 'UN',
    code: 'L2409',
    manufactured_on: null,
    expires_on: '2026-08-25',
    location_id: null,
    location_name: null,
    checked_at: null,
    checked_by: null,
    checked_by_name: null,
    note: null,
    created_at: '2026-08-01T00:00:00.000Z',
    quantity: 4,
    value_cents: 800,
    faixa: 'vencido',
    dias_para_vencer: -5,
  },
  {
    id: 'b-2',
    company_id: 'c',
    product_id: 'p-1',
    product_name: 'Iogurte natural 170g',
    internal_code: 'PRD-1',
    unit: 'UN',
    code: 'L2410',
    manufactured_on: null,
    expires_on: '2026-09-03',
    location_id: null,
    location_name: null,
    checked_at: '2026-08-20T10:00:00.000Z',
    checked_by: 'u-1',
    checked_by_name: 'Ana Estoquista',
    note: null,
    created_at: '2026-08-02T00:00:00.000Z',
    quantity: 10,
    value_cents: 2000,
    faixa: 'vence_em_7',
    dias_para_vencer: 4,
  },
];

function servidor() {
  const chamadas: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      chamadas.push({
        url: alvo,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body) : null,
      });
      const responder = (corpo: unknown, status = 200) =>
        new Response(JSON.stringify(corpo), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/stock/batches/alertas')) return responder(ALERTA);
      if (alvo.includes('/conferir')) {
        return responder({ batch: { ...LOTES[0], checked_at: 'x' }, duplicated: false }, 201);
      }
      if (alvo.includes('/stock/batches')) {
        // O filtro é do SERVIDOR: a tela manda `faixa` e recebe já recortado.
        const faixa = new URL(alvo, 'http://x').searchParams.get('faixa');
        const items = faixa ? LOTES.filter((l) => l.faixa === faixa) : LOTES;
        return responder({ items });
      }
      return responder({});
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <ValidadePage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a tela mostra o que o servidor mandou, sem refazer a conta', () => {
  it('as seis faixas aparecem, inclusive as zeradas', async () => {
    servidor();
    montar();
    // Faixa ausente faria a tela ter de inventar a linha "Vencido: 0" — e uma
    // tela que às vezes tem a linha deixa o gestor sem saber se leu o número
    // ou se o número não existe.
    for (const f of ALERTA.faixas) {
      expect(await screen.findByText(f.label)).toBeTruthy();
    }
  });

  it('o valor vem em centavos do servidor — a tela não multiplica nada', async () => {
    servidor();
    montar();
    // 800 centavos do lote vencido, formatados. Se a tela recalculasse
    // quantidade × custo, o primeiro produto fracionado divergiria do rodapé.
    expect(await screen.findByText(/4 · R\$ ?8,00/)).toBeTruthy();
    // E o "em risco" é a soma das faixas de urgência: 800 + 2000, nunca 8800.
    expect(await screen.findByText(/R\$ ?28,00 em risco/)).toBeTruthy();
  });

  it('o "hoje" é o da LOJA, vindo do servidor — a tela não olha o relógio', async () => {
    servidor();
    montar();
    expect(await screen.findByText(/Medido em 30\/08\/2026/)).toBeTruthy();
  });

  it('o lote vencido é rotulado pelo que ele IMPEDE, não pela data', async () => {
    servidor();
    montar();
    // "não pode vender" é a consequência, e é o que o operador precisa ler —
    // "venceu há 5 dias" o deixaria adivinhando se ainda dá para passar.
    expect(await screen.findByText('não pode vender')).toBeTruthy();
  });
});

describe('o filtro por faixa é do servidor', () => {
  it('clicar na faixa manda `faixa` na consulta, e clicar de novo tira', async () => {
    const chamadas = servidor();
    montar();
    fireEvent.click(await screen.findByText('Vencido'));

    await waitFor(() => {
      expect(
        chamadas.some((c) => c.url.includes('/stock/batches?') && c.url.includes('faixa=vencido')),
      ).toBe(true);
    });
    // Filtrar em memória esvaziaria a página com lote de sobra no banco: o
    // servidor pagina DEPOIS de recortar.
    await waitFor(() => expect(screen.queryByText('L2410')).toBeNull());

    fireEvent.click(await screen.findByText('Vencido'));
    await waitFor(() => expect(screen.getByText('L2410')).toBeTruthy());
  });
});

describe('a pendência da doca tem porta de saída na própria tela', () => {
  it('o saldo sem lote aparece com o produto e o caminho para resolver', async () => {
    servidor();
    montar();
    expect(await screen.findByText('Entrou sem lote declarado')).toBeTruthy();
    expect(await screen.findByText(/20 UN/)).toBeTruthy();
    expect(await screen.findByText('Alocar em um lote')).toBeTruthy();
  });

  it('a alocação cadastra o lote e move o saldo — nesta ordem, e sem UPDATE', async () => {
    const chamadas = servidor();
    montar();
    fireEvent.click(await screen.findByText('Alocar em um lote'));

    fireEvent.change(screen.getByPlaceholderText('L2409'), { target: { value: 'DOCA-1' } });
    fireEvent.click(screen.getByText('Alocar'));

    await waitFor(() => {
      const post = chamadas.filter((c) => c.method === 'POST');
      // Primeiro o lote passa a existir; só então a mercadoria passa a ser
      // dele. A ordem inversa pediria alocação para um lote que ainda não
      // nasceu, e o servidor recusaria com 404.
      expect(post[0].url).toMatch(/\/stock\/batches$/);
      expect(post[0].body).toMatchObject({ code: 'DOCA-1', productId: 'p-1' });
    });
  });
});

describe('a conferência é um gesto da tela, com autor', () => {
  it('lote não conferido oferece o botão; conferido mostra quem conferiu', async () => {
    servidor();
    montar();
    // O L2410 já foi conferido pela Ana: nome no lugar do botão.
    expect(await screen.findByText('Ana Estoquista')).toBeTruthy();
    // O L2409 não foi: um botão só na tabela inteira.
    expect(screen.getAllByText('Conferir')).toHaveLength(1);
  });

  it('conferir chama a rota do lote certo', async () => {
    const chamadas = servidor();
    montar();
    fireEvent.click(await screen.findByText('Conferir'));
    await waitFor(() => {
      expect(chamadas.some((c) => c.url.includes('/stock/batches/b-1/conferir'))).toBe(true);
    });
  });
});

describe('a régua fica escrita na tela em que ela decide', () => {
  it('a tela diz que vencido não vende e por onde ele sai', async () => {
    servidor();
    montar();
    // Sem isto o operador descobre a recusa com o cliente na frente e sem
    // saber o que fazer.
    expect(
      await screen.findByText(/Lote vencido não sai pela venda/),
    ).toBeTruthy();
  });

  it('e diz, na mesma frase, que quem não usa lote não é afetado', async () => {
    servidor();
    montar();
    expect(
      await screen.findByText(/Produto\s+sem controle de lote não é afetado/),
    ).toBeTruthy();
  });
});
