/**
 * QUEM LIBEROU O DESCONTO DESTE DOCUMENTO — a pergunta da conferência de caixa,
 * que o banco sabia responder e nenhuma tela fazia.
 *
 * ## O defeito
 *
 * `core_quotes.authorization_id` era escrita na criação do documento (é a
 * liberação de gestor que cobriu a concessão dele) e não era lida por ninguém:
 * nem por tela, nem por relatório, nem por decisão. Coluna com escritor e sem
 * leitor não é dado — é a IMPRESSÃO de que alguém está olhando.
 *
 * Na prática, o desconto grande aparecia no total do documento e o nome de quem
 * autorizou ficava só no banco. Quem conferia o caixa tinha de abrir o relatório
 * de autorizações e cruzar por horário — e um vínculo reconstruído por horário
 * é um vínculo adivinhado.
 *
 * ## O que se cobra aqui
 *
 *   - o detalhe do documento MOSTRA o nome de quem liberou, a data e o teto;
 *   - documento que não precisou de gestor não mostra linha nenhuma. Um
 *     "Liberado por: —" fixo ensinaria o operador a ignorar a linha justamente
 *     nos casos em que ela importa.
 *
 * Um servidor que lê e não mostra não resolveria nada: é por isso que esta prova
 * é de TELA, e não só de rota.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OrcamentosPage from '../OrcamentosPage';

const DOCUMENTO = {
  id: 'q-1',
  number: 47,
  kind: 'orcamento' as const,
  status: 'aberto' as const,
  customer_id: null,
  total_cents: 600_000,
  discount_cents: 0,
  valid_until: '2026-09-01T23:59:59.999Z',
  converted_sale_id: null,
  note: null,
  created_at: '2026-08-17T12:00:00.000Z',
};

/** O que o servidor devolve no detalhe. Trocado por caso. */
let liberacao: unknown = null;

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const alvo = String(url);

      if (alvo.includes('/core/quotes/q-1')) {
        return new Response(
          JSON.stringify({
            ...DOCUMENTO,
            expired: false,
            liberacao,
            items: [
              {
                id: 'i-1',
                product_id: 'p-moto',
                description: 'Moto Elétrica',
                quantity: 1,
                unit_price_cents: 600_000,
                total_cents: 600_000,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (alvo.includes('/core/quotes')) {
        return new Response(JSON.stringify({ items: [DOCUMENTO] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  liberacao = null;
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Abre o detalhe do documento, que é a folha onde o caixa confere. */
async function abrirDetalhe() {
  render(
    <MemoryRouter>
      <OrcamentosPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Ver' }));
  return screen.findByText(/Orçamento #47/);
}

describe('o detalhe do documento mostra quem liberou o desconto', () => {
  it('com liberação, o NOME do gestor aparece na tela', async () => {
    liberacao = {
      id: 'a-1',
      created_at: '2026-08-17T12:00:00.000Z',
      autorizado_por: 'Ana Gerente',
      granted_concession_cents: 600_000,
      granted_gross_cents: 1_200_000,
      reason: 'cliente antigo',
    };

    await abrirDetalhe();

    // O nome é o que responde a pergunta. Sem ele, a linha seria só mais um
    // número numa tela que já tem vários.
    expect(await screen.findByText(/Desconto liberado por Ana Gerente/)).toBeTruthy();
    // O teto aprovado, em dinheiro, para a conferência bater sem abrir outra
    // tela.
    expect(screen.getByText(/6\.000,00 de concessão/)).toBeTruthy();
    expect(screen.getByText(/cliente antigo/)).toBeTruthy();
  });

  it('sem liberação, NÃO há linha nenhuma — o vazio também é informação', async () => {
    liberacao = null;

    await abrirDetalhe();

    /*
      Documento cujo desconto coube no limite do balcão não tem liberação, e
      esse é o caso comum. Uma linha fixa dizendo "Liberado por: —" apareceria
      em toda tela e ensinaria o olho a pular por cima dela — inclusive nas
      poucas em que ela carrega o nome de um gestor.
    */
    expect(screen.queryByText(/liberado por/i)).toBeNull();
  });
});
