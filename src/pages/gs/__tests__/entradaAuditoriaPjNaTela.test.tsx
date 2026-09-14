/**
 * A CONFERÊNCIA DA NOTA NA TELA — os achados da auditoria da Preço Justo
 * (trilha "entrada") que moram na EntradaNotasPage.
 *
 * ## Como cada caso fica vermelho
 *
 *   - B-15: tire o `await` das conferências em voo e o /confirm sai antes do
 *     /conferir (ou mesmo depois de ele falhar);
 *   - M03: volte a mandar `Number('')` e o campo apagado vira "chegou zero";
 *     tire o resumo das divergências e a entrada sai no primeiro clique;
 *   - B-18: deixe os campos editáveis na nota recebida, ou o blur sem mudança
 *     enviando, ou o fator levando `receivedQuantity` junto;
 *   - M05: volte o placeholder para `qTrib/qCom`;
 *   - B-19: tire o botão de declarar a equivalência em lote;
 *   - B-10: tire as colunas de estado fiscal;
 *   - B-08: trate o 409 da estornada como erro comum;
 *   - B-02/B-03: esconda o destinatário ou a dispensa da conta a pagar.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

interface Chamada {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let chamadas: Chamada[];
let statusDaNota: string;
let itens: Record<string, unknown>[];
let notaExtra: Record<string, unknown>;
let respostaDaConferencia: (body: Record<string, unknown>) => Promise<Response>;
let respostaDaConfirmacao: () => Response;
let respostaDaImportacao: (body: Record<string, unknown>) => Response;

function item(sobrescreve: Record<string, unknown> = {}) {
  return {
    supplierCode: 'ALFA-778',
    description: 'CABO ACEL CG160 REF 778',
    barcode: null,
    ncm: '87141000',
    cfop: '5102',
    unit: 'UN',
    quantity: 10,
    unitCostCents: 2225,
    totalCents: 22250,
    productId: 'p-cabo',
    matchedBy: 'manual',
    receivedQuantity: null,
    divergenceNote: null,
    conversionFactor: null,
    productName: 'Cabo de Acelerador CG 160',
    productInternalCode: 'CAB-160',
    productUnit: 'UN',
    resolvedFactor: 1,
    ...sobrescreve,
  };
}

function nota() {
  return {
    id: 'n-conf',
    access_key: '35260814200166000187550010000000011000000017',
    number: '11',
    series: '1',
    supplier_name: 'Distribuidora Alfa',
    total_cents: 22250,
    status: statusDaNota,
    created_at: '2026-09-10T10:00:00.000Z',
    issued_at: '2026-09-10T09:00:00.000Z',
    carrier_name_xml: null,
    freight_mode: null,
    volumes_qty: null,
    gross_weight_grams: null,
    vehicle_plate: null,
    tem_xml: 1,
    ...notaExtra,
  };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: u, method, body });

      if (u.includes('/purchases/nfe/import')) return respostaDaImportacao(body ?? {});
      if (u.includes('/purchases/notes/n-conf/conferir')) return respostaDaConferencia(body ?? {});
      if (u.includes('/purchases/notes/n-conf/confirm')) return respostaDaConfirmacao();
      if (u.includes('/purchases/notes/n-conf/items')) return json({ items: itens });
      if (u.includes('/purchases/notes/n-conf/repricing')) return json({ suggestions: [] });
      if (u.includes('/purchases/notes')) return json({ items: [nota()] });
      return json({ items: [] });
    }),
  );
}

async function montar() {
  setSession(
    {
      accessToken: 'token-da-doca',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'gerente', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da conferência da auditoria',
  );
  servidor();
  render(
    <MemoryRouter initialEntries={['/sistema/compras/entrada-notas?nota=n-conf']}>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  // A conferência (os itens) e a linha da nota (o status) precisam ter chegado.
  await screen.findByText('Conferência da nota');
  await screen.findByText('Distribuidora Alfa');
}

function chamadasA(trecho: string, method = 'POST'): Chamada[] {
  return chamadas.filter((c) => c.url.includes(trecho) && c.method === method);
}

const campoChegou = (descricao = 'CABO ACEL CG160 REF 778') =>
  screen.getByRole('spinbutton', { name: `Quantidade recebida de ${descricao}` }) as HTMLInputElement;
const campoFator = (descricao = 'CABO ACEL CG160 REF 778') =>
  screen.getByRole('spinbutton', {
    name: `Quantas unidades do cadastro vêm em uma da nota, em ${descricao}`,
  }) as HTMLInputElement;

beforeEach(() => {
  chamadas = [];
  statusDaNota = 'conferencia';
  itens = [item()];
  notaExtra = {};
  respostaDaConferencia = async (body) => {
    itens = [item({ receivedQuantity: body.receivedQuantity ?? null, conversionFactor: body.conversionFactor ?? null })];
    return json({ items: itens });
  };
  respostaDaConfirmacao = () =>
    json({ noteId: 'n-conf', status: 'recebida', createdProducts: 0, movedItems: 1, alreadyReceived: false });
  respostaDaImportacao = () => json({ noteId: 'n-conf', duplicated: false, items: itens }, 201);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('B-15 — a entrada espera a conferência gravada', () => {
  it('digitar 8 e clicar em "Dar entrada": o /confirm só sai depois do /conferir, e com o resumo da divergência', async () => {
    let liberar: () => void = () => {};
    respostaDaConferencia = (body) =>
      new Promise((resolve) => {
        liberar = () => {
          itens = [item({ receivedQuantity: body.receivedQuantity })];
          resolve(json({ items: itens }));
        };
      });
    await montar();

    fireEvent.change(campoChegou(), { target: { value: '8' } });
    fireEvent.blur(campoChegou());
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));

    await waitFor(() => expect(chamadasA('/conferir')).toHaveLength(1));
    expect(chamadasA('/confirm')).toHaveLength(0);

    liberar();
    // M03: com o 8 gravado, a entrada pede o segundo clique com a lista.
    const resumo = await screen.findByRole('alertdialog', { name: 'Conferir divergências' });
    expect(within(resumo).getByText(/nota 10, chegou 8/)).toBeTruthy();
    expect(chamadasA('/confirm')).toHaveLength(0);

    fireEvent.click(within(resumo).getByRole('button', { name: 'Dar entrada com o que chegou' }));
    await waitFor(() => expect(chamadasA('/confirm')).toHaveLength(1));
    const ordem = chamadas.map((c) => c.url);
    expect(ordem.findIndex((u) => u.includes('/conferir'))).toBeLessThan(
      ordem.findIndex((u) => u.includes('/confirm')),
    );
  });

  it('a conferência que falhou barra a entrada', async () => {
    respostaDaConferencia = async () =>
      json({ error: { code: 'CORE_INVALID_QUANTITY', message: 'Quantidade conferida inválida.' } }, 400);
    await montar();

    fireEvent.change(campoChegou(), { target: { value: '8' } });
    fireEvent.blur(campoChegou());
    await waitFor(() => expect(chamadasA('/conferir')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/não foi gravada/));
    expect(chamadasA('/confirm')).toHaveLength(0);
  });

  /*
    REVISÃO: a marca de falha não prende a entrada para sempre. Quem vê o 400 e
    redigita o valor que JÁ está gravado (o blur sem mudança não viaja) volta a
    ter tela e servidor iguais — e "Dar entrada" tem de passar.
  */
  it('depois da falha, voltar ao valor gravado libera a entrada', async () => {
    respostaDaConferencia = async () =>
      json({ error: { code: 'CORE_INVALID_QUANTITY', message: 'Quantidade conferida inválida.' } }, 400);
    await montar();

    fireEvent.change(campoChegou(), { target: { value: '8' } });
    fireEvent.blur(campoChegou());
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/inválida/));

    fireEvent.change(campoChegou(), { target: { value: '10' } });
    fireEvent.blur(campoChegou());
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));

    await waitFor(() => expect(chamadasA('/confirm')).toHaveLength(1));
    expect(chamadasA('/conferir')).toHaveLength(1);
  });
});

describe('M03 — campo apagado não é "chegou zero"', () => {
  it('apagar e sair do campo: nada viaja, e o campo volta ao que estava', async () => {
    await montar();
    fireEvent.change(campoChegou(), { target: { value: '' } });
    fireEvent.blur(campoChegou());
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadasA('/conferir')).toHaveLength(0);
    expect(campoChegou().value).toBe('10');
  });
});

describe('B-18 — só a nota em conferência se confere, e só o que mudou viaja', () => {
  it('nota RECEBIDA: campos travados e sem o botão de entrada', async () => {
    statusDaNota = 'recebida';
    await montar();
    expect(campoChegou().disabled).toBe(true);
    expect(campoFator().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Dar entrada no estoque' })).toBeNull();
  });

  it('atravessar "Chegou" sem mudar não grava; o fator viaja SEM a quantidade', async () => {
    await montar();
    fireEvent.blur(campoChegou());
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadasA('/conferir')).toHaveLength(0);

    fireEvent.change(campoFator(), { target: { value: '12' } });
    fireEvent.blur(campoFator());
    await waitFor(() => expect(chamadasA('/conferir')).toHaveLength(1));
    expect(chamadasA('/conferir')[0].body).toEqual({ itemIndex: 0, conversionFactor: 12 });
  });
});

describe('M05 — o placeholder do fator é o que a confirmação aplicaria', () => {
  it('unidade igual com qTrib 120: mostra 1, não 12; sem como resolver: pede', async () => {
    itens = [
      item({ unit: 'CX', productUnit: 'CX', quantityTrib: 120, resolvedFactor: 1 }),
      item({ description: 'Linha sem fator', unit: 'CX', productUnit: 'UN', resolvedFactor: null }),
    ];
    await montar();
    expect(campoFator().placeholder).toBe('1');
    expect(campoFator('Linha sem fator').placeholder).toBe('informe');
  });
});

describe('B-19 — "1 UND = 1 UN" de uma vez', () => {
  it('as linhas do mesmo par ganham fator 1 num clique', async () => {
    itens = [
      item({ description: 'ESPONJA A', unit: 'UND', productUnit: 'UN', resolvedFactor: null }),
      item({ description: 'ESPONJA B', unit: 'UND', productUnit: 'UN', resolvedFactor: null }),
    ];
    respostaDaConferencia = async (body) => {
      itens = itens.map((l, i) => (i === body.itemIndex ? { ...l, conversionFactor: body.conversionFactor } : l));
      return json({ items: itens });
    };
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Declarar 1 UND = 1 UN (2 linha(s))' }));
    await waitFor(() => expect(chamadasA('/conferir')).toHaveLength(2));
    expect(chamadasA('/conferir').map((c) => c.body)).toEqual([
      { itemIndex: 0, conversionFactor: 1 },
      { itemIndex: 1, conversionFactor: 1 },
    ]);
  });
});

describe('B-10 — o estado de cada dado fiscal', () => {
  it('NCM divergente mostra o do cadastro; "SEM GTIN" aparece como tal', async () => {
    itens = [
      item({
        ncm: '85171300',
        productNcm: '85176277',
        fiscal: { barcode: 'PENDENTE', ncm: 'DIVERGENTE', cest: 'NAO_APLICAVEL', origin: 'CONFIRMADO' },
      }),
      item({
        description: 'Item sem código',
        semGtin: true,
        fiscal: { barcode: 'NAO_APLICAVEL', ncm: 'CONFIRMADO', cest: 'NAO_APLICAVEL', origin: 'CONFIRMADO' },
      }),
    ];
    await montar();
    expect(screen.getByText('cadastro: 85176277')).toBeTruthy();
    expect(screen.getByText('SEM GTIN')).toBeTruthy();
    expect(screen.getAllByText('não se aplica').length).toBeGreaterThan(0);
  });
});

describe('B-02 e B-03 — o destinatário e a conta a pagar dispensada', () => {
  it('a conferência mostra o destinatário; a entrada diz que não gerou conta', async () => {
    notaExtra = { recipient_document: '11222333000181', recipient_name: 'Preco Justo Ltda' };
    respostaDaConfirmacao = () =>
      json({
        noteId: 'n-conf',
        status: 'recebida',
        createdProducts: 0,
        movedItems: 1,
        alreadyReceived: false,
        semContaAPagar: 'Sem conta a pagar: CFOP 5910 (bonificação, doação ou brinde).',
      });
    await montar();
    expect(screen.getByText(/Destinatário da nota: Preco Justo Ltda — 11222333000181/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dar entrada no estoque' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Sem conta a pagar: CFOP 5910/));
  });
});

describe('B-08 — a nota estornada entra de novo com o mesmo XML', () => {
  it('o 409 da estornada vira a pergunta, e a resposta reimporta com reabrirEstornada', async () => {
    respostaDaImportacao = (body) =>
      body.reabrirEstornada
        ? json({ noteId: 'n-conf', duplicated: false, items: itens, reabriuEstornada: 'n-velha' }, 201)
        : json(
            {
              error: {
                code: 'CORE_NOTE_REVERSED_REOPENABLE',
                message: 'Esta NF-e já entrou e foi ESTORNADA (motivo: produto errado).',
              },
            },
            409,
          );
    await montar();
    const arquivo = new File(['<nfeProc/>'], 'nota.xml', { type: 'text/xml' });
    Object.defineProperty(arquivo, 'text', { value: async () => '<nfeProc/>' });
    fireEvent.change(document.getElementById('nfe-file') as HTMLInputElement, { target: { files: [arquivo] } });

    const pergunta = await screen.findByRole('alertdialog', { name: 'Nota estornada' });
    expect(within(pergunta).getByText(/motivo: produto errado/)).toBeTruthy();
    fireEvent.click(within(pergunta).getByRole('button', { name: 'Abrir nova conferência com este XML' }));

    await waitFor(() => expect(chamadasA('/purchases/nfe/import')).toHaveLength(2));
    expect(chamadasA('/purchases/nfe/import')[1].body).toEqual({ xml: '<nfeProc/>', reabrirEstornada: true });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Nova conferência aberta/));
  });
});
