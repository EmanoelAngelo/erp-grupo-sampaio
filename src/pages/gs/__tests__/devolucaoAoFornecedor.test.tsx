/**
 * DEVOLUÇÃO AO FORNECEDOR — GAP-PRD-089, o lado da tela.
 *
 * Não havia tela nenhuma: o que existia era o estorno da nota inteira. Estes
 * casos cobram o caminho que a gerência percorre — a nota (via "Devolver")
 * abre a devolução nova com o que dá para devolver, o modo financeiro sugerido
 * vem da dívida da nota, e o registro viaja com itens, motivo e modo; a ficha
 * mostra a pendência fiscal e aceita a chave da NF-e de devolução. O estoquista
 * lê e não registra; o título de crédito no financeiro navega para a ficha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import DevolucoesFornecedorPage from '../DevolucoesFornecedorPage';

const DEVOLVIVEIS = {
  nota: {
    id: 'n-1',
    rotulo: 'NF-e 1024',
    accessKey: '35240114200166000187550010000000015123456789',
    status: 'recebida',
    supplierId: 'f-1',
    supplierName: 'Distribuidora Freio Bom',
    totalCents: 25000,
  },
  itens: [
    {
      productId: 'p-pastilha',
      name: 'Pastilha de freio',
      internalCode: 'PST-01',
      unit: 'UN',
      entrou: 10,
      jaDevolvido: 0,
      disponivel: 10,
      podeDevolver: 10,
      unitCostCents: 2500,
      serializado: false,
      unidades: [],
    },
  ],
  saldoEmAbertoCents: 25000,
  temTitulo: true,
  jaCreditadoCents: 0,
};

const DETALHE = {
  id: 'd-1',
  number: 1,
  noteId: 'n-1',
  noteLabel: 'NF-e 1024',
  noteAccessKey: DEVOLVIVEIS.nota.accessKey,
  supplierName: 'Distribuidora Freio Bom',
  reason: 'Duas com defeito',
  goodsCents: 5000,
  creditCents: 5000,
  financeMode: 'abatimento',
  fiscalStatus: 'pendente',
  fiscalAccessKey: null,
  createdAt: '2026-09-11T12:00:00.000Z',
  createdByName: 'Gerente',
  items: [
    { productId: 'p-pastilha', name: 'Pastilha de freio', internalCode: 'PST-01', quantity: 2, unitCostCents: 2500, totalCents: 5000 },
  ],
  financeEntryId: 't-1',
  financeDetail: [{ entryId: 't-1', abatidoCents: 5000, antesCents: 25000, depoisCents: 20000, cancelado: false }],
  fiscalNote: null,
  pendenciaFiscal:
    'Emitir a NF-e de devolução (modelo 55, finalidade 4 — devolução) referenciando a chave 35240114200166000187550010000000015123456789.',
};

let pedidos: { url: string; method: string; body: unknown }[] = [];
let fiscalResolvido = false;
/** O que a rota de emissão responde neste caso: a nota, ou a recusa do cadastro. */
let emissaoResponde: { status: number; body: unknown } = {
  status: 200,
  body: {
    document: {
      id: 'doc-1',
      model: '55',
      serie: 1,
      number: 7,
      accessKey: '9'.repeat(44),
      status: 'AUTHORIZED',
      protocol: 'TEST-1',
    },
    statusLabel: 'Autorizada',
    pendencias: ['Devolução de compra: natureza e CFOP ainda não confirmados pelo contador.'],
  },
};

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    pedidos.push({ url: alvo, method, body: init?.body ? JSON.parse(init.body) : null });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (alvo.includes('/core/fiscal/devolucoes/compra/d-1/nfe') && method === 'POST') {
      if (emissaoResponde.status === 200) fiscalResolvido = true;
      return json(emissaoResponde.body, emissaoResponde.status);
    }
    if (alvo.includes('/core/purchases/notes/n-1/devolviveis')) return json(DEVOLVIVEIS);
    if (alvo.endsWith('/core/purchases/supplier-returns') && method === 'POST') return json(DETALHE, 201);
    if (alvo.includes('/core/purchases/supplier-returns/d-1/fiscal') && method === 'POST') {
      fiscalResolvido = true;
      return json({ ...DETALHE, fiscalStatus: 'emitida', fiscalAccessKey: '4'.repeat(44), pendenciaFiscal: null });
    }
    if (alvo.includes('/core/purchases/supplier-returns/d-1')) {
      return json(fiscalResolvido ? { ...DETALHE, fiscalStatus: 'emitida', pendenciaFiscal: null } : DETALHE);
    }
    if (alvo.includes('/core/purchases/supplier-returns')) return json({ items: [] });
    return json({ items: [] });
  });
}

function entrarComo(perfil: string) {
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: perfil, displayName: perfil, profileCode: perfil },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: perfil }],
    } as never,
    'LOGIN',
    'teste da devolução ao fornecedor',
  );
}

beforeEach(() => {
  localStorage.clear();
  pedidos = [];
  fiscalResolvido = false;
  emissaoResponde = {
    status: 200,
    body: {
      document: {
        id: 'doc-1',
        model: '55',
        serie: 1,
        number: 7,
        accessKey: '9'.repeat(44),
        status: 'AUTHORIZED',
        protocol: 'TEST-1',
      },
      statusLabel: 'Autorizada',
      pendencias: ['Devolução de compra: natureza e CFOP ainda não confirmados pelo contador.'],
    },
  };
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderizar(caminho: string) {
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <DevolucoesFornecedorPage />
    </MemoryRouter>,
  );
}

describe('GAP-PRD-089 — a devolução nova, a partir da nota', () => {
  it('mostra o que a nota pode devolver e sugere abater a dívida que ainda existe', async () => {
    entrarComo('gerente_loja');
    renderizar('/sistema/compras/devolucoes?nota=n-1');
    expect(await screen.findByText('Nova devolução — NF-e 1024')).toBeTruthy();
    expect(screen.getByText('Pastilha de freio')).toBeTruthy();
    const abater = screen.getByLabelText(/Abatido da dívida da nota/) as HTMLInputElement;
    expect(abater.checked).toBe(true);
  });

  it('o registro viaja com itens, motivo e modo; a ficha abre com a pendência fiscal', async () => {
    entrarComo('gerente_loja');
    renderizar('/sistema/compras/devolucoes?nota=n-1');
    fireEvent.change(await screen.findByLabelText('Quantidade de Pastilha de freio a devolver'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText(/Motivo da devolução/), { target: { value: 'Duas com defeito' } });
    fireEvent.click(screen.getByRole('button', { name: /Registrar devolução/ }));

    await waitFor(() => expect(pedidos.some((p) => p.method === 'POST')).toBe(true));
    const post = pedidos.find((p) => p.method === 'POST')!;
    expect(post.body).toEqual({
      noteId: 'n-1',
      reason: 'Duas com defeito',
      financeMode: 'abatimento',
      items: [{ productId: 'p-pastilha', quantity: 2 }],
    });

    expect(await screen.findByText(/Devolução #1 registrada/)).toBeTruthy();
    expect(await screen.findByText(/finalidade 4/)).toBeTruthy();
    expect(screen.getByText(/250,00 → R\$\s?200,00/)).toBeTruthy();
  });

  it('a gerência registra a chave da NF-e de devolução pela ficha', async () => {
    entrarComo('gerente_loja');
    renderizar('/sistema/compras/devolucoes?devolucao-compra=d-1');
    fireEvent.change(await screen.findByLabelText('Chave da NF-e de devolução'), {
      target: { value: '4'.repeat(44) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar situação fiscal' }));
    await waitFor(() =>
      expect(pedidos.some((p) => p.method === 'POST' && p.url.includes('/d-1/fiscal'))).toBe(true),
    );
    const post = pedidos.find((p) => p.url.includes('/d-1/fiscal'))!;
    expect(post.body).toEqual({ status: 'emitida', accessKey: '4'.repeat(44) });
    await waitFor(() => expect(screen.queryByText(/finalidade 4/)).toBeNull());
  });

  /*
    EMITIR A NF-e DE DEVOLUÇÃO PELA PRÓPRIA FICHA (P0 fiscal).

    A rota POST /core/fiscal/devolucoes/compra/:id/nfe existia e NENHUMA tela a
    chamava: a ficha só sabia registrar a chave de uma nota emitida em outro
    lugar, e a devolução ao fornecedor terminava sempre no emissor do contador.
    O corpo vai vazio de propósito — o destinatário é o fornecedor da nota de
    entrada, e o servidor o lê do cadastro.
  */
  it('a gerência emite a NF-e de devolução pela ficha, com corpo vazio', async () => {
    entrarComo('gerente_loja');
    renderizar('/sistema/compras/devolucoes?devolucao-compra=d-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e de devolução' }));

    await waitFor(() =>
      expect(pedidos.some((p) => p.method === 'POST' && p.url.includes('/devolucoes/compra/d-1/nfe'))).toBe(true),
    );
    // Endereço redigitado divergiria do cadastro: a tela não manda destinatário.
    expect(pedidos.find((p) => p.url.includes('/devolucoes/compra/d-1/nfe'))!.body).toEqual({});

    expect(await screen.findByText(/NF-e 7, série 1: Autorizada/)).toBeTruthy();
    expect(screen.getByText(/ainda não confirmados pelo contador/)).toBeTruthy();
    // A ficha é relida: a situação fiscal deixou de ser pendente.
    await waitFor(() => expect(screen.queryByText(/finalidade 4/)).toBeNull());
  });

  it('cadastro do fornecedor incompleto: a recusa do servidor aparece com o campo que falta', async () => {
    emissaoResponde = {
      status: 422,
      body: {
        error: {
          code: 'CORE_FISCAL_RETURN_SUPPLIER_INCOMPLETE',
          message:
            'O cadastro do fornecedor "Distribuidora Freio Bom" não tem código IBGE do município — e a '
            + 'NF-e de devolução leva o endereço do destinatário.',
        },
      },
    };
    entrarComo('gerente_loja');
    renderizar('/sistema/compras/devolucoes?devolucao-compra=d-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e de devolução' }));

    expect(await screen.findByText(/código IBGE do município/)).toBeTruthy();
    // Recusa não inventa nota: a pendência fiscal continua onde estava.
    expect(screen.getByText(/finalidade 4/)).toBeTruthy();
  });

  it('o estoquista não emite nem registra: a ficha não oferece os gestos', async () => {
    entrarComo('estoquista');
    renderizar('/sistema/compras/devolucoes?devolucao-compra=d-1');
    expect(await screen.findByText(/finalidade 4/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e de devolução' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Registrar situação fiscal' })).toBeNull();
  });

  it('o estoquista não registra: a tela diz que é decisão da gerência', async () => {
    entrarComo('estoquista');
    renderizar('/sistema/compras/devolucoes?nota=n-1');
    expect(await screen.findByText(/decisão da gerência/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Registrar devolução/ })).toBeNull();
  });

  it('o crédito no financeiro navega para a ficha da devolução', () => {
    expect(destinoDaOrigem('devolucao_fornecedor', 'd-1')).toBe(
      '/sistema/compras/devolucoes?devolucao-compra=d-1',
    );
  });
});
