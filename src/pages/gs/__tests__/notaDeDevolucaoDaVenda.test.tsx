/**
 * A NF-e DE DEVOLUÇÃO DA VENDA, PELA FICHA DA DEVOLUÇÃO (P0 fiscal).
 *
 * ## O defeito
 *
 * `POST /core/fiscal/devolucoes/venda/:returnId/nfe` existia, emitia a nota de
 * ENTRADA com finalidade 4 referenciando a NFC-e — e NENHUMA tela a chamava. A
 * ficha da devolução dizia, em palavras, que a regularização "é a NF-e de
 * devolução, emitida pela devolução", e não oferecia gesto nenhum: o caminho
 * terminava no emissor do contador.
 *
 * ## O que se cobra
 *
 *  - com NFC-e autorizada, a gerência abre o formulário, que já vem com o nome
 *    e o CPF que foram para a nota da venda (o sistema não repergunta o que
 *    sabe) e pede o endereço, que ele NÃO tem;
 *  - o município é escolhido na lista do IBGE e o código vai junto — ninguém
 *    digita os 7 dígitos;
 *  - emitida, a ficha mostra número, série e chave em vez do botão;
 *  - venda sem documento fiscal não oferece o gesto (não há nota a referenciar);
 *  - o caixa não recebe o botão: a rota é `fiscal.manage`, e o clique dele
 *    levaria 403.
 *
 * Como cada caso falha sem o conserto: sem o componente, o botão não existe;
 * sem o `destinatarioSugerido`, o formulário nasce vazio; sem o recorte de
 * perfil, o caixa vê o botão.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import DevolucoesPage from '../DevolucoesPage';

const FISCAL_PENDENTE = {
  estado: 'pendente_regularizacao',
  rotulo: 'PENDENTE DE REGULARIZAÇÃO',
  detalhe:
    'A venda tem NFC-e autorizada. A devolução é regularizada com a NF-e de devolução (nota de '
    + 'entrada, finalidade 4, referenciando a NFC-e).',
  documentoStatus: 'AUTHORIZED',
};

const FISCAL_NAO_FISCAL = {
  estado: 'nao_fiscal',
  rotulo: 'NÃO FISCAL',
  detalhe: 'A venda saiu com comprovante não fiscal: não há documento fiscal a regularizar.',
  documentoStatus: null,
};

const LINHA = {
  id: 'r-1',
  number: 7,
  sale_id: 's-1',
  sale_number: 42,
  reason: 'Defeito',
  total_cents: 10000,
  refund_method: 'em_etapas',
  refund_flow: 'duas_etapas',
  created_at: '2026-09-14T11:00:00.000Z',
  reembolso: {
    fluxo: 'duas_etapas',
    devolvivelCents: 10000,
    reembolsadoCents: 10000,
    pendenteCents: 0,
    situacao: 'concluido',
  },
};

let fiscal: typeof FISCAL_PENDENTE | typeof FISCAL_NAO_FISCAL;
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[];

function detalhe() {
  return {
    ...LINHA,
    items: [
      {
        id: 'ri-1',
        sale_item_id: 'si-1',
        product_id: 'p-1',
        description: 'Camiseta',
        quantity: 2,
        unit_price_cents: 5000,
        total_cents: 10000,
        restock: 1,
      },
    ],
    created_by_name: 'Fulano',
    approved_by_name: 'Fulano',
    mercadoria: { situacao: 'concluida', estoque: 'retornou' },
    reembolso: {
      ...LINHA.reembolso,
      registros: [],
      meiosDaVenda: [
        { method: 'dinheiro', recebidoCents: 10000, reembolsadoCents: 10000, disponivelCents: 0 },
      ],
      sugestao: [],
    },
    fiscal,
    notaDeDevolucao: null,
    destinatarioSugerido: { name: 'Maria Consumidora', document: '12345678909' },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url).split('?')[0];
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') {
        enviados.push({
          url: alvo,
          metodo,
          corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        });
      }
      if (alvo.includes('/core/fiscal/devolucoes/venda/r-1/nfe') && metodo === 'POST') {
        return json({
          document: {
            id: 'doc-9',
            model: '55',
            serie: 1,
            number: 12,
            accessKey: '7'.repeat(44),
            status: 'AUTHORIZED',
            protocol: 'TEST-9',
          },
          statusLabel: 'Autorizada',
          pendencias: [],
        });
      }
      if (alvo.includes('/loja/municipios')) {
        return json({
          carregada: true,
          total: 1,
          itens: [{ codigo: '4314407', nome: 'Pelotas', uf: 'RS' }],
        });
      }
      if (alvo.endsWith('/core/sale-returns/r-1')) return json(detalhe());
      if (alvo.includes('/core/sale-returns')) return json({ items: [LINHA] });
      if (alvo.includes('/core/sales')) return json({ items: [] });
      return json({ items: [] });
    }),
  );
}

/**
 * A tela pergunta pela CAPABILITY (`useCan`), que é o que a rota cobra:
 * `fiscal.manage`. O caixa do balcão não a tem.
 */
const CAPS: Record<string, string[]> = {
  gerente_loja: ['fiscal.manage', 'fiscal.view', 'sales.view'],
  operador_caixa_loja: ['fiscal.sale.emit', 'sales.view'],
};

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'PESSOA', displayName: 'Pessoa', profileCode },
      company: { id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [
        { id: 'preco-justo', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode },
      ],
      access: {
        modelo: { code: profileCode, name: profileCode, personalizado: false },
        capabilities: CAPS[profileCode] ?? [],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/sistema',
        carimbo: `c-${profileCode}`,
      },
    } as never,
    'LOGIN',
    'teste da NF-e de devolução da venda',
  );
}

beforeEach(() => {
  enviados = [];
  fiscal = FISCAL_PENDENTE;
  localStorage.clear();
  servidor();
  entrar('gerente_loja');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste');
  localStorage.clear();
});

/** Abre a ficha da devolução pelo histórico. */
async function abrirFicha() {
  render(
    <MemoryRouter>
      <DevolucoesPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Ver' }));
  return screen.findByText(/Devolução #7 — venda #42/);
}

describe('a NF-e de devolução da venda sai pela ficha', () => {
  it('o formulário nasce com quem a loja já sabe que comprou, e pede o endereço', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e de devolução' }));

    expect((await screen.findByLabelText(/Nome do cliente/) as HTMLInputElement).value).toBe(
      'Maria Consumidora',
    );
    expect((screen.getByLabelText(/CPF ou CNPJ/) as HTMLInputElement).value).toBe('12345678909');
    // O endereço a loja não tem: ele nasce vazio, e é isso que se quer.
    expect((screen.getByLabelText(/Logradouro/) as HTMLInputElement).value).toBe('');
  });

  it('o município vem da lista do IBGE e a nota sai com o código junto', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e de devolução' }));

    fireEvent.change(await screen.findByLabelText(/Logradouro/), { target: { value: 'Rua das Flores' } });
    fireEvent.change(screen.getByLabelText(/^Número/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Bairro/), { target: { value: 'Centro' } });
    fireEvent.change(screen.getByLabelText(/^UF/), { target: { value: 'RS' } });
    fireEvent.change(screen.getByLabelText(/Município/), { target: { value: 'Pelot' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));

    const botoes = screen.getAllByRole('button', { name: 'Emitir NF-e de devolução' });
    fireEvent.click(botoes[botoes.length - 1]!);

    await waitFor(() =>
      expect(enviados.some((e) => e.url.includes('/devolucoes/venda/r-1/nfe'))).toBe(true),
    );
    expect(enviados.find((e) => e.url.includes('/devolucoes/venda/r-1/nfe'))!.corpo).toEqual({
      recipient: {
        document: '12345678909',
        name: 'Maria Consumidora',
        ieIndicator: '9',
        street: 'Rua das Flores',
        number: '10',
        complement: null,
        district: 'Centro',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        uf: 'RS',
        zip: null,
      },
    });

    // Emitida, a ficha mostra a nota em vez do botão.
    expect(await screen.findByText(/NF-e de devolução 12, série 1 — AUTHORIZED/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e de devolução' })).toBeNull();
  });

  it('venda sem documento fiscal não oferece o gesto — não há nota a referenciar', async () => {
    fiscal = FISCAL_NAO_FISCAL;
    await abrirFicha();
    expect(await screen.findByText(/não há documento fiscal a regularizar/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e de devolução' })).toBeNull();
  });

  it('o caixa não recebe o botão: a rota é da gerência', async () => {
    entrar('operador_caixa_loja');
    await abrirFicha();
    expect(await screen.findByText(/PENDENTE DE REGULARIZAÇÃO/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e de devolução' })).toBeNull();
  });
});
