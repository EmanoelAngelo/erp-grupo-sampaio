/**
 * O PREÇO FIXADO GANHA ESCRITOR NA TELA — a metade que faltava da promessa.
 *
 * A aba de tabelas promete desde a rodada 26: "um produto pode ter preço
 * fixado, e aí o preço fixado ganha". O servidor sempre cumpriu na venda
 * (`priceInTable`), mas as rotas `PUT/DELETE .../items/:productId` tinham ZERO
 * chamadores — não existia como fixar um preço sem abrir o banco na mão. A
 * prova da promessa INTEIRA (fixado em R$ 120,00 vence os 15% na VENDA) é de
 * rota e mora em `server/tests/preco-fixado-na-tabela.test.ts`; aqui se prova
 * a metade da tela: o gesto existe, fala com as rotas certas e re-renderiza o
 * que o servidor afirma.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem o PUT com `priceCents` em CENTAVOS, "120,00" viraria 120 centavos e
 *     o combinado de cento e vinte reais sairia por R$ 1,20 no cupom;
 *   - se a tela pintar a lista dela em vez da resposta do servidor, o caso do
 *     PUT falha: a linha exibida é a que voltou na resposta;
 *   - sem repassar a frase do servidor no 400, o gerente leria "não foi
 *     possível salvar" onde o servidor explicou a recusa;
 *   - sem o recorte de perfil, o estoquista ganharia um formulário cujo
 *     salvar responde 403 — a porta que bate na cara, proibida na rodada 23.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
// O mesmo formatador da tela: o real separa "R$" do número com espaço
// inextensível (U+00A0), e um literal digitado com espaço comum nunca bate.
import { formatCents } from '@/components/gs/format';
import AuxiliaresCatalogoPage from '../AuxiliaresCatalogoPage';

const TABELAS = [
  { id: 't-atacado', name: 'Atacado', percent_off: 15, active: 1, items: 1, customers: 4 },
];

const FIXADO_EXISTENTE = {
  product_id: 'p-capacete',
  price_cents: 12000,
  updated_at: '2026-08-01T10:00:00.000Z',
  product_name: 'Capacete fechado',
  internal_code: 'CAP-01',
  barcode: '7891000000017',
  base_price_cents: 20000,
};

const PRODUTO_BUSCADO = {
  id: 'p-oleo',
  internal_code: 'OLE-02',
  sku: null,
  barcode: null,
  name: 'Óleo 20W50',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 1500,
  price_cents: 4000,
  min_stock: 0,
  active: 1,
};

let gravacoes: { url: string; body: unknown }[] = [];
let remocoes: string[] = [];
let respostaDoPut: { status: number; body: unknown };
let itensDaTabela: unknown[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    // As rotas de ITEM têm '/items' no caminho — antes das rotas da tabela,
    // senão o DELETE de item cairia no dublê de excluir a tabela inteira.
    if (alvo.includes('/core/catalog/price-tables/') && alvo.includes('/items')) {
      if (metodo === 'PUT') {
        gravacoes.push({ url: alvo, body: JSON.parse(String(init?.body ?? '{}')) });
        return json(respostaDoPut.body, respostaDoPut.status);
      }
      if (metodo === 'DELETE') {
        remocoes.push(alvo);
        return json({ items: [] });
      }
      return json({ items: itensDaTabela });
    }
    if (alvo.includes('/core/products/search')) {
      return json({ items: [PRODUTO_BUSCADO] });
    }
    if (alvo.includes('/core/catalog/aux')) {
      return json({ units: [], taxGroups: [], taxRates: [], priceTables: TABELAS });
    }
    return json({ items: [] });
  });
}

function entrarCom(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode },
      ],
    } as never,
    'LOGIN',
    'teste do preço fixado na tabela',
  );
}

beforeEach(() => {
  gravacoes = [];
  remocoes = [];
  itensDaTabela = [FIXADO_EXISTENTE];
  respostaDoPut = {
    status: 200,
    body: {
      items: [
        FIXADO_EXISTENTE,
        {
          product_id: 'p-oleo',
          price_cents: 3000,
          updated_at: '2026-08-19T10:00:00.000Z',
          product_name: 'Óleo 20W50',
          internal_code: 'OLE-02',
          barcode: null,
          base_price_cents: 4000,
        },
      ],
    },
  };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarCom('gerente_loja');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirPainelDeFixados() {
  render(
    <MemoryRouter>
      <AuxiliaresCatalogoPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Tabelas de preço' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Preços fixados' }));
  await screen.findByText('Preços fixados — Atacado');
}

describe('o combinado é visível antes do cupom', () => {
  it('o painel lista o que está fixado, com o de/por do cadastro', async () => {
    await abrirPainelDeFixados();

    expect(await screen.findByText('Capacete fechado')).toBeTruthy();
    const linha = screen.getByText('Capacete fechado').closest('tr')!;
    // O cadastro (R$ 200,00) ao lado do fixado (R$ 120,00): sem os dois, um
    // valor fixado não diz se foi desconto ou aumento.
    expect(linha.textContent).toContain(formatCents(20000));
    expect(linha.textContent).toContain(formatCents(12000));
  });
});

describe('fixar um preço', () => {
  it('busca o produto, digita em reais e o PUT sai em CENTAVOS para a rota certa', async () => {
    await abrirPainelDeFixados();

    fireEvent.change(screen.getByPlaceholderText('Capacete, 7891234…'), {
      target: { value: 'oleo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar produto' }));
    fireEvent.click(await screen.findByRole('button', { name: /Óleo 20W50/ }));

    fireEvent.change(screen.getByPlaceholderText('120,00'), { target: { value: '30,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fixar preço' }));

    await waitFor(() => expect(gravacoes).toHaveLength(1));
    // Rota do ITEM: tabela e produto no caminho, preço em centavos no corpo.
    expect(gravacoes[0].url).toContain('/core/catalog/price-tables/t-atacado/items/p-oleo');
    expect(gravacoes[0].body).toEqual({ priceCents: 3000 });

    // A lista exibida é a que o SERVIDOR devolveu no PUT — não a que a tela
    // acha que ficou.
    expect(await screen.findByText('Óleo 20W50')).toBeTruthy();
  });

  it('sem preço que preste, o botão nem arma — zero seria produto de graça', async () => {
    await abrirPainelDeFixados();

    fireEvent.change(screen.getByPlaceholderText('Capacete, 7891234…'), {
      target: { value: 'oleo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar produto' }));
    fireEvent.click(await screen.findByRole('button', { name: /Óleo 20W50/ }));

    const botao = screen.getByRole('button', { name: 'Fixar preço' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true); // vazio

    fireEvent.change(screen.getByPlaceholderText('120,00'), { target: { value: '0' } });
    expect(botao.disabled).toBe(true); // zero

    fireEvent.change(screen.getByPlaceholderText('120,00'), { target: { value: '30,00' } });
    expect(botao.disabled).toBe(false);
  });

  it('a recusa do servidor aparece com a frase DELE', async () => {
    respostaDoPut = {
      status: 400,
      body: {
        error: {
          code: 'CORE_PRICE_TABLE_ITEM_PRICE',
          message: 'Preço fixado inválido: informe um valor inteiro em centavos, maior que zero.',
        },
      },
    };
    await abrirPainelDeFixados();

    fireEvent.change(screen.getByPlaceholderText('Capacete, 7891234…'), {
      target: { value: 'oleo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar produto' }));
    fireEvent.click(await screen.findByRole('button', { name: /Óleo 20W50/ }));
    fireEvent.change(screen.getByPlaceholderText('120,00'), { target: { value: '30,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fixar preço' }));

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Preço fixado inválido');
  });
});

describe('remover devolve o item ao percentual', () => {
  it('o DELETE vai para a rota do item e a lista re-renderiza a resposta', async () => {
    await abrirPainelDeFixados();
    await screen.findByText('Capacete fechado');

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(remocoes).toHaveLength(1));
    expect(remocoes[0]).toContain('/core/catalog/price-tables/t-atacado/items/p-capacete');
    // O dublê devolve lista vazia no DELETE; a tela tem de exibi-la.
    expect(await screen.findByText('Nenhum preço fixado nesta tabela')).toBeTruthy();
  });
});

describe('quem vê e quem fixa não são o mesmo conjunto', () => {
  it('o estoquista LÊ a lista, mas não ganha formulário nem Remover', async () => {
    /*
      O guarda do servidor em PUT/DELETE nomeia só gerente_loja e
      gerente_oficina — fixar valor fechado é decisão de gerente. O GET é do
      escritório inteiro. Oferecer o formulário ao estoquista seria a porta
      que bate na cara: tudo nele terminaria em 403.
    */
    entrarCom('estoquista');
    await abrirPainelDeFixados();

    expect(await screen.findByText('Capacete fechado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buscar produto' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover' })).toBeNull();
  });
});
