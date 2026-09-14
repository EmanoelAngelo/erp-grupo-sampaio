/**
 * A ALTERAÇÃO RÁPIDA NÃO DESFAZ O PREÇO QUE OUTRA PESSOA GRAVOU (A-produto-07).
 *
 * O formulário do produto já mandava só o que mudou, com `expected`; a outra
 * metade do achado era esta tela. Ela mandava custo E venda em toda linha
 * alterada, sem `expected`, e o servidor — que só confere o que vem em
 * `expected` — gravava calado:
 *
 *   10:00  A abre a Alteração rápida (perfume a R$ 39,90).
 *   10:05  B baixa o preço para R$ 29,90 no formulário e imprime as etiquetas.
 *   10:10  A muda só o CUSTO dessa linha — o PUT levava `priceCents: 3990` e o
 *          preço voltava a R$ 39,90 sem aviso.
 *
 * Os testes olham o CORPO DO PUT, porque é no fio que o defeito vive: um
 * servidor dublado aceita o que se mandar, e só o corpo diz se a tela ainda
 * arrasta o preço antigo. E olham o que a linha mostra depois do 409: o valor
 * de B, com o que A digitou por cima — nunca o preço velho de volta.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/hooks/useSession', async (original) => ({
  ...(await original<typeof import('@/hooks/useSession')>()),
  useProfile: () => 'gerente_loja',
  useHasProfile: (...allowed: string[]) => allowed.includes('gerente_loja'),
}));

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AlteracaoRapidaPage from '../AlteracaoRapidaPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const PRODUTO_ID = 'p-perfume';

let produto: Record<string, unknown>;
let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> | null }[];
let respostaDoPut: (() => Response) | null;
/** A releitura da grade cai (rede) — ver o último caso. */
let falharLeitura: boolean;

const responder = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function perfume(): Record<string, unknown> {
  return {
    id: PRODUTO_ID,
    internal_code: 'PJ-0001',
    barcode: '7890000000017',
    name: 'Perfume Floral',
    unit: 'UN',
    stock_quantity: 12,
    cost_cents: 2000,
    price_cents: 3990,
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    pedidos.push({ metodo, url: alvo, corpo: init?.body ? JSON.parse(init.body) : null });
    if (metodo === 'PUT' && alvo.includes(`/core/products/${PRODUTO_ID}`)) {
      return respostaDoPut ? respostaDoPut() : responder(produto);
    }
    if (metodo === 'GET' && /\/core\/products(\?|$)/.test(alvo)) {
      if (falharLeitura) {
        return responder({ error: { code: 'INTERNAL', message: 'Sem conexão com o servidor.' } }, 500);
      }
      return responder({ items: [produto], missingShippingDataCount: 0 });
    }
    return responder({});
  });
}

beforeEach(() => {
  pedidos = [];
  produto = perfume();
  respostaDoPut = null;
  falharLeitura = false;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function montar() {
  render(
    <MemoryRouter>
      <AlteracaoRapidaPage />
    </MemoryRouter>,
  );
  await screen.findByLabelText('Custo de Perfume Floral');
}

const custo = () => screen.getByLabelText('Custo de Perfume Floral') as HTMLInputElement;
const venda = () => screen.getByLabelText('Venda de Perfume Floral') as HTMLInputElement;
const puts = () => pedidos.filter((p) => p.metodo === 'PUT');

async function salvarUmaLinha() {
  fireEvent.click(await screen.findByRole('button', { name: /Salvar 1 alteração/ }));
}

describe('só o campo que mudou, com o que a linha mostrava (A-produto-07)', () => {
  it('mudar só o CUSTO não reenvia o preço, e diz ao servidor o par que a tela viu', async () => {
    await montar();
    fireEvent.change(custo(), { target: { value: '15,00' } });
    await salvarUmaLinha();

    await waitFor(() => expect(puts()).toHaveLength(1));
    const corpo = puts()[0].corpo!;
    // Antes do conserto o corpo era { costCents: 1500, priceCents: 3990 }: o
    // preço de B era sobrescrito pelo que A viu às 10:00.
    expect(Object.keys(corpo).sort()).toEqual(['costCents', 'expected']);
    expect(corpo.costCents).toBe(1500);
    expect(corpo.expected).toEqual({ costCents: 2000, priceCents: 3990 });
  });

  it('mudar só a VENDA manda só a venda', async () => {
    await montar();
    fireEvent.change(venda(), { target: { value: '35,00' } });
    await salvarUmaLinha();

    await waitFor(() => expect(puts()).toHaveLength(1));
    const corpo = puts()[0].corpo!;
    expect(Object.keys(corpo).sort()).toEqual(['expected', 'priceCents']);
    expect(corpo.priceCents).toBe(3500);
    expect(corpo.expected).toEqual({ costCents: 2000, priceCents: 3990 });
  });

  it('409 de concorrência: a linha diz o que houve, mostra o preço de B e guarda só o que A digitou', async () => {
    await montar();
    // 10:05 — B baixou o preço no formulário. O servidor recusa o PUT de A.
    respostaDoPut = () => {
      produto = { ...perfume(), price_cents: 2990 };
      return responder(
        {
          error: {
            code: 'CORE_PRODUCT_STALE',
            message:
              'Enquanto você editava, este produto foi alterado por outra pessoa ou outra tela: '
              + 'Preço de venda (agora R$ 29,90). Nada foi gravado.',
            details: { fields: [{ field: 'price_cents', label: 'Preço de venda', agora: 'R$ 29,90' }] },
          },
        },
        409,
      );
    };
    // Na hora do PUT o banco já tem 29,90 — é o que a releitura vai trazer.
    fireEvent.change(custo(), { target: { value: '15,00' } });
    await salvarUmaLinha();

    const nota = await screen.findByTestId(`problema-${PRODUTO_ID}`);
    expect(nota.textContent).toContain('Outra pessoa alterou este produto');
    expect(nota.textContent).toContain('Preço de venda agora é R$ 29,90');
    // A frase de cima sobrevive à releitura da grade (antes `carregar` a zerava).
    expect((await screen.findByRole('alert')).textContent).toContain('1 de 1 não salvaram');

    // A venda mostra o que B gravou; o custo, o que A digitou.
    await waitFor(() => expect(venda().value).toBe('29,90'));
    expect(custo().value).toBe('15,00');

    // O Salvar seguinte é consciente, e continua sem arrastar o preço.
    respostaDoPut = null;
    await salvarUmaLinha();
    await waitFor(() => expect(puts()).toHaveLength(2));
    const segundo = puts()[1].corpo!;
    expect(Object.keys(segundo).sort()).toEqual(['costCents', 'expected']);
    expect(segundo.expected).toEqual({ costCents: 2000, priceCents: 2990 });
  });

  /*
    REVISÃO: com `expected`, a régua da linha (custo/venda originais) passou a
    valer no servidor. Ela só era trocada pela releitura do fim do Salvar; se
    esse GET falhasse (rede), a linha GRAVADA continuava "alterada e não salva"
    com a régua velha, e o Salvar seguinte levava 409 "Outra pessoa alterou este
    produto" — contra a gravação da própria pessoa. Antes do `expected` o
    reenvio era inofensivo; agora a régua sai da resposta do PUT.
  */
  it('a releitura falha depois de gravar: a linha fica como gravada, sem se acusar de conflito', async () => {
    await montar();
    respostaDoPut = () => {
      produto = { ...perfume(), cost_cents: 1500 };
      // A releitura que vem depois deste PUT cai.
      falharLeitura = true;
      return responder(produto);
    };
    fireEvent.change(custo(), { target: { value: '15,00' } });
    await salvarUmaLinha();

    await waitFor(() => expect(puts()).toHaveLength(1));
    // A linha gravada não fica pendente — sem o conserto o botão seguia
    // oferecendo "Salvar 1 alteração", e esse Salvar voltava com 409.
    expect(await screen.findByRole('button', { name: 'Nada alterado' })).toBeTruthy();
    expect(custo().value).toBe('15,00');
    expect(screen.queryByTestId(`problema-${PRODUTO_ID}`)).toBeNull();
  });
});

/*
  REAUDITORIA: `centavos` devolvia 0 para o texto que não se lê. Apagar a Venda
  (ou digitar "abc") contava como alteração, e o Salvar gravava priceCents 0 —
  o produto passava a sair de graça no PDV, sem aviso.
*/
describe('valor ilegível não vira R$ 0,00', () => {
  it('apagar a venda e salvar: nada vai ao servidor, a linha diz o que refazer e o foco vai ao campo', async () => {
    await montar();
    fireEvent.change(venda(), { target: { value: '' } });
    await salvarUmaLinha();

    const nota = await screen.findByTestId(`problema-${PRODUTO_ID}`);
    expect(nota.textContent).toContain('Valor de venda ilegível');
    expect((await screen.findByRole('alert')).textContent).toContain('Nada foi gravado');
    expect(puts()).toHaveLength(0);
    expect(document.activeElement).toBe(venda());
    expect(venda().getAttribute('aria-invalid')).toBe('true');
  });

  it('"abc" no custo também é recusado; corrigido, o Salvar grava o valor digitado', async () => {
    await montar();
    fireEvent.change(custo(), { target: { value: 'abc' } });
    await salvarUmaLinha();
    expect((await screen.findByTestId(`problema-${PRODUTO_ID}`)).textContent).toContain('Custo ilegível');
    expect(puts()).toHaveLength(0);

    fireEvent.change(custo(), { target: { value: '15,00' } });
    await salvarUmaLinha();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].corpo!.costCents).toBe(1500);
  });
});
