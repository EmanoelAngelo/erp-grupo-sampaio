/**
 * DEVOLVER E CANCELAR PELO MEIO CERTO — a tela de Devoluções na trilha "venda"
 * da auditoria do Preço Justo.
 *
 *   E-venda-servidor-06  o aviso do cancelamento dizia sempre "não há o que
 *                        devolver", até na venda do cartão avulso. Agora cada
 *                        meio vira uma instrução, com o valor do servidor.
 *   E-venda-servidor-03  a forma nascia sempre "Dinheiro" e a tela não dizia
 *                        como a venda foi paga.
 *   E-venda-servidor-09  sem resposta do servidor, a tela convidava ao segundo
 *                        clique — que gravava a SEGUNDA devolução.
 *   (recusas do cancelamento) a mensagem ia para a faixa da página, ATRÁS do
 *                        diálogo aberto; agora aparece dentro dele.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const VENDA = {
  id: 's-1',
  number: 42,
  company_id: 'loja',
  customer_id: null,
  seller_id: null,
  cash_session_id: null,
  subtotal_cents: 10000,
  discount_cents: 0,
  total_cents: 10000,
  change_cents: 0,
  status: 'completed',
  note: null,
  created_at: '2026-09-14T10:00:00.000Z',
};

const ITEM = {
  sale_item_id: 'si-1',
  product_id: 'p-1',
  description: 'Jaqueta jeans',
  quantity: 2,
  total_cents: 10000,
  net_total_cents: 10000,
  returned_quantity: 0,
  returned_cents: 0,
  serialized: 0,
  units: [],
};

interface Enviado {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
}
let enviados: Enviado[] = [];

const json = (dado: unknown, status = 200) =>
  new Response(JSON.stringify(dado), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * O servidor de mentira. `rotas` responde primeiro; o resto cai no padrão da
 * tela (listas vazias, a venda #42 na lista de vendas).
 */
function servidor(rotas: (url: string, metodo: string, corpo: Record<string, unknown> | null) => Response | Promise<Response> | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      if (metodo !== 'GET') enviados.push({ url: alvo, metodo, corpo });
      const propria = await rotas(alvo, metodo, corpo);
      if (propria) return propria;
      if (alvo.includes('/returnable')) return json({ items: [ITEM] });
      if (alvo.includes('/core/sale-returns')) return json({ items: [] });
      if (alvo.includes('/core/sales')) return json({ items: [VENDA] });
      return json({ items: [] });
    }),
  );
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste de devolução pelo meio certo',
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
  entrarComo('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de devolução pelo meio certo');
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
}

async function abrirConfirmacaoDoCancelamento() {
  montar();
  await screen.findByText('#42');
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar venda' }));
  await screen.findByTestId('confirmar-cancelamento');
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'cliente desistiu' } });
  fireEvent.click(screen.getByRole('button', { name: /Cancelar a venda #42/ }));
}

describe('E-venda-servidor-06 — o aviso do cancelamento diz o que ainda precisa de uma mão', () => {
  it('cartão sem maquininha integrada: manda estornar no aparelho, e não diz mais "não há o que devolver"', async () => {
    servidor((url, metodo) =>
      url.includes('/cancel') && metodo === 'POST'
        ? json({
            ...VENDA,
            status: 'cancelled',
            estornosNaMaquininha: [],
            reembolso: {
              gavetaCents: 0,
              aDevolverAMao: { dinheiro: 0, credito: 25000, debito: 0, pix: 0 },
              maquininhaCents: 0,
              valeDevolvidoCents: 0,
              valeRevogadoCents: 0,
              jaDevolvidoCents: 0,
            },
          })
        : null,
    );
    await abrirConfirmacaoDoCancelamento();

    const aviso = await screen.findByText(/Venda #42 cancelada/);
    expect(aviso.textContent).toMatch(/Estorne R\$\s250,00 no crédito, no próprio aparelho/);
    expect(aviso.textContent).not.toMatch(/não há o que devolver/);
  });

  it('dinheiro pela gaveta: diz quanto entregar, e o que devoluções anteriores já devolveram', async () => {
    servidor((url, metodo) =>
      url.includes('/cancel') && metodo === 'POST'
        ? json({
            ...VENDA,
            status: 'cancelled',
            reembolso: {
              gavetaCents: 5000,
              aDevolverAMao: { dinheiro: 0, credito: 0, debito: 0, pix: 0 },
              maquininhaCents: 0,
              valeDevolvidoCents: 0,
              valeRevogadoCents: 0,
              jaDevolvidoCents: 5000,
            },
          })
        : null,
    );
    await abrirConfirmacaoDoCancelamento();

    const aviso = await screen.findByText(/Venda #42 cancelada/);
    expect(aviso.textContent).toMatch(/Entregue R\$\s50,00 ao cliente, da gaveta/);
    expect(aviso.textContent).toMatch(/R\$\s50,00 já tinham voltado ao cliente/);
  });

  it('a recusa do servidor aparece DENTRO da confirmação, e não atrás dela', async () => {
    servidor((url, metodo) =>
      url.includes('/cancel') && metodo === 'POST'
        ? json(
            {
              error: {
                code: 'CORE_SALE_HAS_FISCAL_DOCUMENT',
                message: 'A venda #42 tem a NFC-e nº 321 autorizada na SEFAZ.',
              },
            },
            409,
          )
        : null,
    );
    await abrirConfirmacaoDoCancelamento();

    const erro = await screen.findByTestId('erro-do-cancelamento');
    expect(erro.textContent).toContain('NFC-e nº 321');
    expect(screen.getByTestId('confirmar-cancelamento').contains(erro)).toBe(true);
  });
});

describe('E-venda-servidor-03 — a tela diz como a venda foi paga e propõe o meio', () => {
  it('venda paga no cartão: mostra o pagamento e a devolução nasce em "Estorno no cartão"', async () => {
    servidor((url) =>
      /\/core\/sales\/s-1$/.test(url)
        ? json({
            ...VENDA,
            surcharge_cents: 0,
            items: [],
            payments: [{ id: 'pg-1', method: 'credito', amount_cents: 10000, status: 'settled' }],
            customerCreditCents: 0,
            removedItems: [],
            financeEntries: [],
          })
        : null,
    );
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getByRole('button', { name: 'Devolver desta' }));

    const bloco = await screen.findByTestId('como-a-venda-foi-paga');
    expect(bloco.textContent).toMatch(/Cartão de crédito R\$\s100,00/);
    const forma = screen.getByLabelText('Como o dinheiro volta') as HTMLSelectElement;
    expect(forma.value).toBe('estorno_cartao');
  });

  it('venda em dinheiro continua nascendo em "Dinheiro"', async () => {
    servidor((url) =>
      /\/core\/sales\/s-1$/.test(url)
        ? json({
            ...VENDA,
            items: [],
            payments: [{ id: 'pg-1', method: 'dinheiro', amount_cents: 10000, status: 'settled' }],
            customerCreditCents: 0,
          })
        : null,
    );
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getByRole('button', { name: 'Devolver desta' }));
    await screen.findByTestId('como-a-venda-foi-paga');
    expect((screen.getByLabelText('Como o dinheiro volta') as HTMLSelectElement).value).toBe('dinheiro');
  });
});

describe('E-venda-servidor-09 — sem resposta, a tela pergunta se a devolução chegou antes de deixar repetir', () => {
  async function devolverUmaPorPix() {
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getByRole('button', { name: 'Devolver desta' }));
    await screen.findByLabelText('Devolver quantos de Jaqueta jeans');
    fireEvent.change(screen.getByLabelText('Devolver quantos de Jaqueta jeans'), {
      target: { value: '1' },
    });
    // O campo da devolução é obrigatório: o rótulo leva o asterisco.
    fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: 'Tamanho errado' } });
    fireEvent.change(screen.getByLabelText('Como o dinheiro volta'), { target: { value: 'pix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar devolução' }));
  }

  it('a devolução foi gravada e a resposta se perdeu: a tela diz que foi registrada e limpa o formulário', async () => {
    let postou = false;
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        postou = true;
        throw new TypeError('Failed to fetch');
      }
      if (url.includes('/core/sale-returns?saleId=s-1') && postou) {
        return json({
          items: [
            {
              id: 'r-9',
              number: 9,
              sale_id: 's-1',
              sale_number: 42,
              reason: 'Tamanho errado',
              total_cents: 5000,
              refund_method: 'pix',
              created_at: '2026-09-14T10:05:00.000Z',
            },
          ],
        });
      }
      return null;
    });
    await devolverUmaPorPix();

    await screen.findByText(/A devolução #9 foi registrada/);
    // O formulário saiu da tela: não há "Registrar devolução" para o segundo clique.
    expect(screen.queryByRole('button', { name: 'Registrar devolução' })).toBeNull();
    expect(enviados.filter((e) => e.url.includes('/core/sale-returns') && e.metodo === 'POST')).toHaveLength(1);
  });

  it('nada chegou: a tela diz que NÃO foi registrada, e o formulário continua para tentar de novo', async () => {
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') throw new TypeError('Failed to fetch');
      return null;
    });
    await devolverUmaPorPix();

    await screen.findByText(/ela não foi registrada/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Registrar devolução' })).toBeTruthy(),
    );
  });
});

/*
  REVISÃO DA TRILHA "venda" — a primeira versão da conferência afirmava mais do
  que tinha conferido. Cada teste abaixo falha na versão anterior da tela.
*/
describe('E-venda-servidor-09 (revisão) — a tela só afirma o que conferiu', () => {
  const devolucao = (id: string, number: number) => ({
    id,
    number,
    sale_id: 's-1',
    sale_number: 42,
    reason: 'Tamanho errado',
    total_cents: 5000,
    refund_method: 'pix',
    created_at: '2026-09-14T10:05:00.000Z',
  });

  async function preencherDevolucaoPorPix() {
    montar();
    await screen.findByText('#42');
    fireEvent.click(screen.getByRole('button', { name: 'Devolver desta' }));
    await screen.findByLabelText('Devolver quantos de Jaqueta jeans');
    fireEvent.change(screen.getByLabelText('Devolver quantos de Jaqueta jeans'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: 'Tamanho errado' } });
    fireEvent.change(screen.getByLabelText('Como o dinheiro volta'), { target: { value: 'pix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar devolução' }));
  }

  const postsDeDevolucao = () =>
    enviados.filter((e) => e.url.includes('/core/sale-returns') && e.metodo === 'POST');

  it('a devolução ANTIGA desta venda, fora da lista geral da tela, não é anunciada como a nova', async () => {
    /*
      A lista geral da tela (as 100 mais recentes da operação) não traz a #8; a
      lista DA VENDA traz, antes e depois do envio. Na versão anterior a base
      era a lista geral: a #8 parecia nova, e a tela dizia "A devolução #8 foi
      registrada" para um envio que não chegou — o operador entregava o
      dinheiro sem nada lançado.
    */
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') throw new TypeError('Failed to fetch');
      if (url.includes('/core/sale-returns?saleId=s-1')) return json({ items: [devolucao('r-8', 8)] });
      return null;
    });
    await preencherDevolucaoPorPix();

    await screen.findByText(/ela não foi registrada/);
    expect(screen.queryByText(/A devolução #8 foi registrada/)).toBeNull();
  });

  it('sem como conferir, a tela NÃO diz "não foi registrada" — e confere antes do próximo envio', async () => {
    /*
      A rede cai depois do commit e continua fora na leitura do histórico. A
      versão anterior lia a falha da leitura como "nada chegou" e mandava
      registrar de novo: com a rede de volta, o clique gravava a SEGUNDA
      devolução.
    */
    let fase: 'antes' | 'rede_fora' | 'voltou' = 'antes';
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        fase = 'rede_fora';
        throw new TypeError('Failed to fetch');
      }
      if (url.includes('/core/sale-returns?saleId=s-1')) {
        if (fase === 'rede_fora') throw new TypeError('Failed to fetch');
        return json({ items: fase === 'voltou' ? [devolucao('r-9', 9)] : [] });
      }
      return null;
    });
    await preencherDevolucaoPorPix();

    const erro = await screen.findByText(/ainda não deu para conferir/);
    expect(erro.textContent).not.toMatch(/não foi registrada/);

    // A conexão volta, e a primeira TINHA chegado: o clique confere e não envia.
    fase = 'voltou';
    fireEvent.click(screen.getByRole('button', { name: 'Registrar devolução' }));
    await screen.findByText(/A devolução #9 foi registrada/);
    expect(postsDeDevolucao()).toHaveLength(1);
  });

  it('o 504 do proxy também é "sem resposta": a devolução gravada atrás dele é anunciada, e não repetida', async () => {
    let postou = false;
    servidor((url, metodo) => {
      if (url.includes('/core/sale-returns') && metodo === 'POST') {
        postou = true;
        return new Response('<html>504 Gateway Time-out</html>', {
          status: 504,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.includes('/core/sale-returns?saleId=s-1')) {
        return json({ items: postou ? [devolucao('r-9', 9)] : [] });
      }
      return null;
    });
    await preencherDevolucaoPorPix();

    // Antes: "O servidor respondeu algo que não é JSON…", com o formulário
    // intacto para o segundo clique.
    await screen.findByText(/A devolução #9 foi registrada/);
    expect(screen.queryByRole('button', { name: 'Registrar devolução' })).toBeNull();
    expect(postsDeDevolucao()).toHaveLength(1);
  });
});

describe('E-venda-servidor-03 (revisão) — a forma proposta é da venda aberta agora', () => {
  it('a venda misturada, aberta depois de uma no cartão, não herda o "Estorno no cartão" da anterior', async () => {
    const OUTRA = { ...VENDA, id: 's-2', number: 43 };
    servidor((url) => {
      if (/\/core\/sales(\?[^/]*)?$/.test(url)) return json({ items: [VENDA, OUTRA] });
      if (/\/core\/sales\/s-1$/.test(url)) {
        return json({
          ...VENDA,
          items: [],
          payments: [{ id: 'pg-1', method: 'credito', amount_cents: 10000, status: 'settled' }],
          customerCreditCents: 0,
        });
      }
      if (/\/core\/sales\/s-2$/.test(url)) {
        return json({
          ...OUTRA,
          items: [],
          payments: [
            { id: 'pg-2', method: 'dinheiro', amount_cents: 5000, status: 'settled' },
            { id: 'pg-3', method: 'credito', amount_cents: 5000, status: 'settled' },
          ],
          customerCreditCents: 0,
        });
      }
      return null;
    });
    montar();
    await screen.findByText('#43');
    fireEvent.click(screen.getAllByRole('button', { name: 'Devolver desta' })[0]);
    await screen.findByTestId('como-a-venda-foi-paga');
    expect((screen.getByLabelText('Como o dinheiro volta') as HTMLSelectElement).value).toBe(
      'estorno_cartao',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trocar venda' }));
    await screen.findByText('#43');
    fireEvent.click(screen.getAllByRole('button', { name: 'Devolver desta' })[1]);
    await waitFor(() =>
      expect(screen.getByTestId('como-a-venda-foi-paga').textContent).toMatch(/Dinheiro R\$\s50,00/),
    );
    // Antes: continuava "Estorno no cartão", proposto pela venda ANTERIOR.
    expect((screen.getByLabelText('Como o dinheiro volta') as HTMLSelectElement).value).toBe('dinheiro');
  });
});
