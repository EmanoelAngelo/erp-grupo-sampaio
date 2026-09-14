/**
 * A TELA DE TABELAS DE PREÇO PASSA A MOSTRAR EFEITO.
 *
 * Até esta rodada ela prometia a regra de negociação de atacado — o texto está
 * lá, explicando o percentual e a exceção por item — e não havia como saber se
 * alguma tabela valia para alguém. Dava para criar dez e nunca descobrir que
 * nenhuma alterava preço nenhum. Essa é literalmente a razão de a rodada
 * existir, e é por isso que a contagem de clientes é parte dela, e não enfeite.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire a coluna "Clientes" e "Excluir" volta a ser um botão que ou apaga
 *     uma tabela sem uso ou é recusado por um 409 que ninguém esperava;
 *   - engula a mensagem do 409 e o gerente lê "não foi possível salvar" no
 *     lugar da frase que diz QUANTOS clientes dependem da tabela;
 *   - pare de mandar `active` e editar o nome de uma tabela desativada volta a
 *     reativá-la em silêncio — com todos os clientes vinculados voltando a ter
 *     desconto sem ninguém ter decidido isso.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import AuxiliaresCatalogoPage from '../AuxiliaresCatalogoPage';

const TABELAS = [
  { id: 't-atacado', name: 'Atacado', percent_off: 15, active: 1, items: 2, customers: 4 },
  { id: 't-vazia', name: 'Especial', percent_off: 5, active: 1, items: 0, customers: 0 },
  { id: 't-antiga', name: 'Promoção 2024', percent_off: 30, active: 0, items: 0, customers: 0 },
];

let salvamentos: unknown[] = [];
let respostaDaExclusao: { status: number; body: unknown } = {
  status: 200,
  body: { priceTables: TABELAS },
};
let respostaDoSalvamento: { status: number; body: unknown } = { status: 201, body: TABELAS[0] };

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/catalog/price-tables') && metodo === 'DELETE') {
      return new Response(JSON.stringify(respostaDaExclusao.body), {
        status: respostaDaExclusao.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (alvo.includes('/core/catalog/price-tables') && metodo === 'POST') {
      salvamentos.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify(respostaDoSalvamento.body), {
        status: respostaDoSalvamento.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (alvo.includes('/core/catalog/aux')) {
      return new Response(
        JSON.stringify({ units: [], taxGroups: [], taxRates: [], priceTables: TABELAS }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function entrarComoGerente() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste da tela de tabelas de preço',
  );
}

beforeEach(() => {
  salvamentos = [];
  respostaDaExclusao = { status: 200, body: { priceTables: TABELAS } };
  respostaDoSalvamento = { status: 201, body: TABELAS[0] };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGerente();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirAbaDeTabelas() {
  render(
    <MemoryRouter>
      <AuxiliaresCatalogoPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Tabelas de preço' }));
  await screen.findByText('Atacado');
}

/**
 * A célula de "Clientes" daquela linha.
 *
 * Pela POSIÇÃO da coluna, e não pelo texto da linha inteira: "4" também
 * apareceria dentro de "15.00%" ou de uma contagem de preços fixados, e um
 * teste que aceita isso ficaria verde com a coluna nova ausente.
 */
function celulaDeClientes(nomeDaTabela: string): string {
  const linha = screen.getByText(nomeDaTabela).closest('tr')!;
  const cabecalhos = Array.from(
    linha.closest('table')!.querySelectorAll('thead th'),
  ).map((th) => th.textContent);
  return linha.querySelectorAll('td')[cabecalhos.indexOf('Clientes')].textContent ?? '';
}

describe('quantos clientes compram por cada tabela', () => {
  it('a tabela em uso mostra o número', async () => {
    await abrirAbaDeTabelas();
    expect(celulaDeClientes('Atacado')).toBe('4');
  });

  it('a tabela sem cliente nenhum mostra travessão, e não zero', async () => {
    // Zero em toda linha vira ruído; o que interessa ler de relance é QUAIS
    // têm gente.
    await abrirAbaDeTabelas();
    expect(celulaDeClientes('Especial')).toBe('—');
  });

  it('a tabela desativada se identifica na lista', async () => {
    // Desativada e ativa parecem iguais numa lista de nomes — e a diferença é
    // que a desativada não dá desconto nenhum a quem está vinculado a ela.
    await abrirAbaDeTabelas();
    const linha = screen.getByText('Promoção 2024').closest('tr')!;
    expect(linha.textContent).toContain('desativada');
  });
});

describe('a tabela em uso não some', () => {
  it('a recusa diz QUANTOS clientes dependem dela', async () => {
    respostaDaExclusao = {
      status: 409,
      body: {
        error: {
          code: 'CORE_PRICE_TABLE_IN_USE',
          message:
            'Esta tabela não pode ser excluída: 4 clientes compram por ela. '
            + 'Troque a tabela desses clientes antes.',
          details: { priceTableId: 't-atacado', customers: 4 },
        },
      },
    };
    await abrirAbaDeTabelas();
    const linha = screen.getByText('Atacado').closest('tr')!;
    fireEvent.click(
      Array.from(linha.querySelectorAll('button')).find((b) => b.textContent === 'Excluir')!,
    );

    // "Não foi possível salvar" mandaria o gerente adivinhar. A mensagem do
    // servidor diz o tamanho do trabalho que ele teria de fazer antes.
    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('4 clientes compram por ela');
  });
});

describe('desativar é a porta ao lado de excluir', () => {
  it('editar manda o estado ATIVO junto — desativada não se reativa sozinha', async () => {
    /*
      O formulário não mandava `active`, e o servidor trata ausente como 1:
      corrigir o nome de uma tabela desativada a reativava em silêncio. Enquanto
      a tabela não alterava preço nenhum isso era invisível; agora ela altera, e
      todo cliente vinculado voltaria a ter desconto sem decisão de ninguém.
    */
    await abrirAbaDeTabelas();
    const linha = screen.getByText('Promoção 2024').closest('tr')!;
    fireEvent.click(
      Array.from(linha.querySelectorAll('button')).find((b) => b.textContent === 'Editar')!,
    );

    const caixa = screen.getByRole('checkbox') as HTMLInputElement;
    expect(caixa.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(salvamentos).toHaveLength(1));
    expect(salvamentos[0]).toMatchObject({ id: 't-antiga', active: false });
  });

  it('desmarcar "Ativa" numa tabela em uso é recusado pelo servidor, e a tela mostra', async () => {
    await abrirAbaDeTabelas();
    const linha = screen.getByText('Atacado').closest('tr')!;
    fireEvent.click(
      Array.from(linha.querySelectorAll('button')).find((b) => b.textContent === 'Editar')!,
    );
    fireEvent.click(screen.getByRole('checkbox'));

    // O dublê responde 409 nesta gravação: é o mesmo `recusarSeTemCliente` que
    // a exclusão dispara, aplicado à transição 1 -> 0.
    respostaDoSalvamento = {
      status: 409,
      body: {
        error: {
          code: 'CORE_PRICE_TABLE_IN_USE',
          message: 'Esta tabela não pode ser desativada: 4 clientes compram por ela.',
          details: { customers: 4 },
        },
      },
    };

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('não pode ser desativada');
    expect(erro.textContent).toContain('4 clientes');
  });
});
