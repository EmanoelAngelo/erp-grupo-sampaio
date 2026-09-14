/**
 * ============================================================================
 * O DOCUMENTO NA TELA: quem vendeu, quanto de desconto, editar, renovar,
 * faturar (GAP-V66, V67, V68, V69)
 * ============================================================================
 *
 * Quatro defeitos da mesma tela, e três deles eram elos TELA→API que faltavam
 * enquanto o servidor já estava inteiro do outro lado.
 *
 * ## V69 — "Desconto (centavos)"
 *
 * O campo pedia o número em centavos e filtrava tudo que não fosse dígito.
 * "10,00" virava 1000 por acaso (a vírgula caía no filtro) e "10" virava R$
 * 0,10. Dez reais de desconto viravam dez centavos — ou o contrário, se a
 * pessoa aprendesse a digitar "1000". É desconto errado silencioso num campo
 * que alimenta a ALÇADA: o valor de menos passa por baixo do limite e não chama
 * gestor nenhum. O PDV, na mesma casa, sempre usou entrada em reais com a régua
 * de `parseReaisToCents`.
 *
 * ## V67 — o vendedor que não existia no formulário
 *
 * `NovoDocumentoDialog` não tinha campo de vendedor e o tipo do cliente HTTP
 * não tinha `sellerId`. O documento nascia com vendedor nulo; na conversão,
 * `createSale` faz `sellerId ?? userId` e a comissão nascia para quem estava no
 * CAIXA. O backend inteiro já estava pronto — coluna, rota, propagação e
 * comissão na mesma transação.
 *
 * ## V66 — editar e renovar
 *
 * Um item trocado custava o documento inteiro: cancelar e redigitar, perdendo
 * número, histórico e a liberação de gestor já consumida. E a faixa vermelha
 * dizia "Renove a validade antes de aprovar" sem oferecer onde — a tela
 * ensinava um gesto que o sistema não sabia fazer.
 *
 * ## V68 — o cliente que fecha na hora
 *
 * A rota de conversão sempre aceitou orçamento, e a tela não oferecia nada: o
 * caminho era Aprovar → pré-venda → PDV F9. Dois passos para quem já está com o
 * dinheiro na mão.
 *
 * ## Como estes guardas falham (quebrando de propósito)
 *
 *   - volte `Number(discount.replace(/\D/g, ''))` no lugar de
 *     `parseReaisToCents` → os dois casos do desconto ficam vermelhos;
 *   - tire `sellerId` do corpo de `createQuote` → "quem vendeu viaja" fica
 *     vermelho;
 *   - tire o botão Editar (ou o PATCH) → a edição fica vermelha;
 *   - tire o botão Renovar → o vencido volta a ser beco.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/*
  QUEM USA A TELA (GAP-PRD-149): desde que Orçamentos esconde o botão que o
  servidor recusa, a tela precisa saber o perfil. Este arquivo exercita o
  fluxo de quem cria, edita, renova e fatura — o gerente da loja.
*/
vi.mock('@/hooks/useSession', async (original) => ({
  ...(await original<typeof import('@/hooks/useSession')>()),
  useProfile: () => 'gerente_loja',
  useHasProfile: (...allowed: string[]) => allowed.includes('gerente_loja'),
}));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import OrcamentosPage from '../OrcamentosPage';

const PRODUTO = {
  id: 'p-1',
  internal_code: 'LJ-0001',
  sku: null,
  barcode: '789',
  name: 'Vestido longo',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 8000,
  price_cents: 20000,
  effective_price_cents: 20000,
  min_stock: 0,
  stock_quantity: 10,
  active: 1,
};

/** Aberto e dentro da validade — o que se edita e se fatura. */
const ABERTO = {
  id: 'q-1',
  number: 47,
  kind: 'orcamento',
  status: 'aberto',
  customer_id: null,
  total_cents: 40000,
  // Com desconto GRAVADO: é o que a edição precisa reabrir sem apagar.
  discount_cents: 2500,
  valid_until: new Date(Date.now() + 5 * 86400000).toISOString(),
  converted_sale_id: null,
  note: null,
  created_at: new Date().toISOString(),
};

/** Aberto e VENCIDO — o que a tela mandava renovar sem oferecer como. */
const VENCIDO = {
  ...ABERTO,
  id: 'q-2',
  number: 48,
  valid_until: new Date(Date.now() - 86400000).toISOString(),
};

let criados: Record<string, unknown>[] = [];
let editados: { id: string; body: Record<string, unknown> }[] = [];
let renovados: { id: string; body: Record<string, unknown> }[] = [];

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

      if (alvo.includes('/core/sale-policies')) {
        return json({
          discountLimitPercent: 10,
          creditSaleDueDays: 0,
          reservationValidDays: 3,
          definidos: {},
        });
      }
      if (alvo.includes('/core/sellers')) {
        return json({
          items: [
            { id: 'u-caixa', displayName: 'Caixa do Balcão', active: true },
            { id: 'u-vend', displayName: 'Vendedora do Salão', active: true },
          ],
        });
      }
      if (alvo.includes('/core/customers')) return json({ items: [] });
      if (alvo.includes('/core/products/search')) return json({ items: [PRODUTO] });
      if (alvo.match(/\/core\/products\/p-1$/)) return json(PRODUTO);

      const renovar = alvo.match(/\/core\/quotes\/([^/?]+)\/renew/);
      if (renovar && metodo === 'POST') {
        renovados.push({ id: renovar[1], body: corpo });
        return json({ ...ABERTO, id: renovar[1] });
      }
      const detalhe = alvo.match(/\/core\/quotes\/([^/?]+)$/);
      if (detalhe && metodo === 'PATCH') {
        editados.push({ id: detalhe[1], body: corpo });
        return json({ ...ABERTO, id: detalhe[1] });
      }
      if (detalhe && metodo === 'GET') {
        const base = detalhe[1] === 'q-2' ? VENCIDO : ABERTO;
        return json({
          ...base,
          expired: detalhe[1] === 'q-2',
          liberacao: null,
          items: [
            {
              id: 'i-1',
              product_id: 'p-1',
              description: 'Vestido longo',
              quantity: 2,
              unit_price_cents: 20000,
              total_cents: 40000,
            },
          ],
        });
      }
      if (alvo.includes('/core/quotes') && metodo === 'POST') {
        criados.push(corpo);
        return json({ id: 'q-novo', number: 49, kind: 'orcamento', status: 'aberto' }, 201);
      }
      if (alvo.includes('/core/quotes')) return json({ items: [ABERTO, VENCIDO] });

      return json({});
    }),
  );
}

/** Mostra a URL para onde a tela navegou — é assim que V68 se prova. */
function Destino() {
  const location = useLocation();
  return <div>PDV::{location.search}</div>;
}

function abrirTela() {
  render(
    <MemoryRouter initialEntries={['/sistema/orcamentos']}>
      <Routes>
        <Route path="/sistema/orcamentos" element={<OrcamentosPage />} />
        <Route path="/pdv" element={<Destino />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  criados = [];
  editados = [];
  renovados = [];
  localStorage.clear();
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function abrirNovoDocumento() {
  abrirTela();
  fireEvent.click(await screen.findByRole('button', { name: /^Novo / }));
  await screen.findByLabelText(/Pesquise o produto/);
}

async function adicionarProduto() {
  fireEvent.change(screen.getByLabelText(/Pesquise o produto/), { target: { value: 'Vestido' } });
  fireEvent.keyDown(screen.getByLabelText(/Pesquise o produto/), { key: 'Enter' });
  fireEvent.click(await screen.findByText('Vestido longo'));
}

// ---------------------------------------------------------------- GAP-V69

describe('o desconto é digitado em reais, com a régua do PDV', () => {
  it('"10" é dez REAIS, e não dez centavos', async () => {
    await abrirNovoDocumento();
    await adicionarProduto();

    // O RÓTULO diz a unidade em que a pessoa pensa. Dizendo "centavos", quem
    // digita "10" está certo e o sistema é que erra — trocar só a conta e
    // deixar o rótulo velho ensinaria o erro contrário.
    const campo = screen.getByLabelText(/Desconto \(R\$\)/);
    fireEvent.change(campo, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar /i }));

    await waitFor(() => expect(criados).toHaveLength(1));
    // Com o filtro antigo (`replace(/\D/g,'')`) isto valia 10 — dez CENTAVOS.
    expect(criados[0].discountCents).toBe(1000);
  });

  it('"10,50" é dez reais e cinquenta', async () => {
    await abrirNovoDocumento();
    await adicionarProduto();

    fireEvent.change(screen.getByLabelText(/Desconto \(R\$\)/), { target: { value: '10,50' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar /i }));

    await waitFor(() => expect(criados).toHaveLength(1));
    expect(criados[0].discountCents).toBe(1050);
  });
});

// ---------------------------------------------------------------- GAP-V67

describe('o vendedor entra no documento pela tela', () => {
  it('o seletor existe e traz a equipe', async () => {
    await abrirNovoDocumento();
    const seletor = await screen.findByLabelText(/Vendedor/);
    expect(seletor).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Vendedora do Salão')).toBeTruthy());
  });

  it('quem vendeu viaja no corpo — sem isso a comissão vai para o caixa', async () => {
    await abrirNovoDocumento();
    await adicionarProduto();

    const seletor = await screen.findByLabelText(/Vendedor/);
    await waitFor(() => expect(screen.getByText('Vendedora do Salão')).toBeTruthy());
    fireEvent.change(seletor, { target: { value: 'u-vend' } });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar /i }));

    await waitFor(() => expect(criados).toHaveLength(1));
    expect(criados[0].sellerId).toBe('u-vend');
  });
});

// ---------------------------------------------------------------- GAP-V66

describe('o documento aberto se edita sem perder o número', () => {
  it('o desconto gravado reabre em REAIS, com vírgula — a régua do balcão', async () => {
    /*
      VISTO NA TELA, com o servidor de verdade: o campo reabria escrito
      "10.00". O valor não ficava errado (`parseReaisToCents` lê o ponto), mas
      o campo ENSINAVA a digitar com ponto num sistema em que todo o resto do
      dinheiro se escreve com vírgula — e é assim que a próxima pessoa digita
      "1.000" achando que são mil reais.
    */
    abrirTela();
    const editar = await screen.findAllByRole('button', { name: /^Editar$/ });
    fireEvent.click(editar[0]);
    const campo = (await screen.findByLabelText(/Desconto \(R\$\)/)) as HTMLInputElement;
    await waitFor(() => expect(campo.value).toBe('25,00'));
  });

  it('a edição abre com os itens carregados e manda PATCH', async () => {
    abrirTela();
    const editar = await screen.findAllByRole('button', { name: /^Editar$/ });
    fireEvent.click(editar[0]);

    // Os itens do documento chegam prontos: ninguém redigita produto.
    await waitFor(() => expect(screen.getByLabelText(/Quantidade de Vestido longo/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Quantidade de Vestido longo/), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Salvar /i }));

    await waitFor(() => expect(editados).toHaveLength(1));
    expect(editados[0].id).toBe('q-1');
    expect((editados[0].body.items as { quantity: number }[])[0].quantity).toBe(5);
    // E NÃO cria documento novo: o número tem de sobreviver.
    expect(criados).toHaveLength(0);
  });
});

describe('o vencido tem para onde ir', () => {
  it('o documento vencido oferece Renovar validade, e a rota é chamada', async () => {
    abrirTela();
    const renovar = await screen.findByRole('button', { name: /Renovar/i });
    fireEvent.click(renovar);
    await waitFor(() => expect(renovados).toHaveLength(1));
    expect(renovados[0].id).toBe('q-2');
  });

  it('documento dentro da validade não oferece renovação — seria ruído', async () => {
    abrirTela();
    await screen.findByText('#47');
    expect(screen.getAllByRole('button', { name: /Renovar/i })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- GAP-V68

describe('o cliente que fecha na hora vai direto para o balcão', () => {
  it('Faturar leva ao PDV com o documento na URL', async () => {
    abrirTela();
    const faturar = await screen.findAllByRole('button', { name: /Faturar/i });
    fireEvent.click(faturar[0]);
    const destino = await screen.findByText(/^PDV::/);
    expect(destino.textContent).toContain('documento=q-1');
  });
});
