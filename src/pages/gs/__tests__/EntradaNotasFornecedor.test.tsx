/**
 * NOTAS DO FORNECEDOR NA TELA — rodada 44.
 *
 * Três verdades que a tela passou a dizer e que este arquivo trava:
 *
 *   - a coluna "Diferença" mostra o número DE VERDADE (o servidor agora
 *     devolve receivedQuantity) e a divergência ganha MOTIVO que viaja no
 *     corpo — antes divergence_note era morta ponta a ponta;
 *   - "casou por" vem do método GRAVADO — não mais "código de barras" para
 *     todo item vinculado;
 *   - o radar da SEFAZ (Distribuição DF-e) e os fretes (CT-e) existem na
 *     tela, com manifestação restrita à gerência.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o divergenceNote do corpo do conferir e o caso do motivo cai;
 *   - volte a coluna Situação para o badge puro e o caso do método cai;
 *   - mostre a coluna Manifestar ao estoquista e o caso do perfil cai;
 *   - troque o corpo da manifestação e o caso da ciência cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';

const CHAVE_DFE = '4'.repeat(44);
const CHAVE_CTE = '5'.repeat(44);

let itens: Record<string, unknown>[];
/** A MESMA mercadoria noutra nota — ainda não conferida. É o cenário da key. */
let itensDaNota2: Record<string, unknown>[];
let dfeDocs: Record<string, unknown>[];
let ctes: Record<string, unknown>[];
/** Todo POST com o corpo — é a prova do contrato. */
let posts: { url: string; corpo: Record<string, unknown> }[];

function itemConferido(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'Bateria 60V',
    barcode: '7890000000031',
    ncm: '85076000',
    cfop: '5102',
    unit: 'UN',
    quantity: 10,
    unitCostCents: 5000,
    totalCents: 50000,
    productId: 'p-1',
    matchedBy: 'internal_code',
    receivedQuantity: 8,
    divergenceNote: null,
    ...sobre,
  };
}

function docDfe(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nsu: '1',
    schemaType: 'resNFe',
    accessKey: CHAVE_DFE,
    supplierCnpj: '14200166000187',
    supplierName: 'Fornecedor Simulado 1',
    totalCents: 15000,
    issuedAt: '2026-08-21T09:00:00-03:00',
    manifestStatus: null,
    importedNoteId: null,
    noteStatus: null,
    temXmlCompleto: false,
    ...sobre,
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (metodo === 'POST') posts.push({ url: alvo, corpo });

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/purchases/dfe/consultar')) return json({ novos: 2, total: 2, ultimoNsu: 2 });
    if (alvo.includes(`/purchases/dfe/${CHAVE_DFE}/manifestar`)) {
      const doc = dfeDocs.find((d) => d.accessKey === CHAVE_DFE)!;
      doc.manifestStatus = String(corpo.tipo);
      if (corpo.tipo === 'ciencia') doc.temXmlCompleto = true;
      return json({ ok: true });
    }
    if (alvo.includes(`/purchases/dfe/${CHAVE_DFE}/importar`)) {
      const doc = dfeDocs.find((d) => d.accessKey === CHAVE_DFE)!;
      doc.importedNoteId = 'nota-dfe-1';
      return json({ noteId: 'nota-dfe-1', duplicated: false });
    }
    if (alvo.endsWith('/purchases/dfe')) return json({ items: dfeDocs });
    if (alvo.includes('/purchases/cte/import')) {
      ctes.push({
        id: 'cte-2',
        accessKey: CHAVE_CTE,
        number: '124',
        carrierName: 'Transportadora Pampa',
        freightCents: 21000,
        issuedAt: null,
        createdAt: '2026-08-22T10:00:00.000Z',
        notas: [],
      });
      return json({ duplicated: false, freightCents: 21000 }, 201);
    }
    if (alvo.endsWith('/purchases/cte')) return json({ items: ctes });
    if (alvo.includes('/conferir')) {
      const indice = Number(corpo.itemIndex);
      itens[indice] = {
        ...itens[indice],
        receivedQuantity: Number(corpo.receivedQuantity),
        divergenceNote: (corpo.divergenceNote as string) ?? null,
      };
      return json({ items: itens });
    }
    if (alvo.includes('/purchases/notes/nota-2/items')) return json({ items: itensDaNota2 });
    if (/\/purchases\/notes\/[^/]+\/items$/.test(alvo)) return json({ items: itens });
    if (alvo.includes('/purchases/notes')) {
      return json({
        items: [
          {
            id: 'nota-1',
            access_key: '1'.repeat(44),
            number: '44',
            series: '1',
            issued_at: '2026-08-20T10:00:00-03:00',
            total_cents: 50000,
            status: 'conferencia',
            created_at: '2026-08-20T12:00:00.000Z',
            carrier_name_xml: null,
            freight_mode: null,
            volumes_qty: null,
            gross_weight_grams: null,
            vehicle_plate: null,
            tem_xml: 1,
            supplier_name: 'Distribuidora Alfa',
            received_at: null,
            received_by_name: null,
          },
          {
            id: 'nota-2',
            access_key: '2'.repeat(44),
            number: '45',
            series: '1',
            issued_at: '2026-08-21T10:00:00-03:00',
            total_cents: 50000,
            status: 'conferencia',
            created_at: '2026-08-21T12:00:00.000Z',
            carrier_name_xml: null,
            freight_mode: null,
            volumes_qty: null,
            gross_weight_grams: null,
            vehicle_plate: null,
            tem_xml: 1,
            supplier_name: 'Distribuidora Alfa',
            received_at: null,
            received_by_name: null,
          },
        ],
      });
    }
    return json({ items: [] });
  });
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da rodada 44',
  );
}

beforeEach(() => {
  posts = [];
  itens = [itemConferido()];
  itensDaNota2 = [itemConferido({ receivedQuantity: null, divergenceNote: null })];
  dfeDocs = [docDfe()];
  ctes = [
    {
      id: 'cte-1',
      accessKey: CHAVE_CTE,
      number: '123',
      carrierName: 'Transportadora Pampa',
      freightCents: 35000,
      issuedAt: '2026-08-21T08:00:00-03:00',
      createdAt: '2026-08-21T09:00:00.000Z',
      notas: [
        { accessKey: '6'.repeat(44), noteId: 'n-1', noteStatus: 'conferencia' },
        { accessKey: '7'.repeat(44), noteId: null, noteStatus: null },
      ],
    },
  ];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da rodada 44');
  localStorage.clear();
});

async function montar() {
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findAllByText('Distribuidora Alfa');
}

async function abrirConferencia(qual = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: 'Abrir' })[qual]);
  await screen.findByText('Conferência da nota');
}

describe('a conferência diz a verdade', () => {
  it('a coluna Diferença mostra o número gravado — não mais o "—" perpétuo', async () => {
    await montar();
    await abrirConferencia();
    // 8 chegaram de 10: a diferença é -2, visível antes de confirmar.
    await screen.findByText('-2');
    // E o campo "Chegou" abre com o que foi CONTADO, não com o da nota.
    const chegou = screen.getByLabelText('Quantidade recebida de Bateria 60V');
    expect((chegou as HTMLInputElement).value).toBe('8');
  });

  it('o motivo da divergência VIAJA no corpo e volta preenchido', async () => {
    await montar();
    await abrirConferencia();
    const motivo = await screen.findByLabelText('Motivo da diferença de Bateria 60V');
    fireEvent.change(motivo, { target: { value: 'duas caixas com avaria' } });
    fireEvent.blur(motivo);

    await waitFor(() => {
      const post = posts.find((p) => p.url.includes('/conferir'));
      expect(post).toBeTruthy();
      expect(post!.corpo.divergenceNote).toBe('duas caixas com avaria');
      // A quantidade contada não se perde ao anotar o motivo.
      expect(post!.corpo.receivedQuantity).toBe(8);
    });
  });

  it('a contagem digitada numa nota NÃO vaza para outra com o mesmo produto', async () => {
    /*
      A revisão adversarial mordeu: a key da linha era descrição+EAN, e os
      inputs são não-controlados. Fornecedor recorrente = mesmo produto em
      duas notas = React reaproveitava o <input> sujo — o número digitado na
      nota A aparecia (e, no blur, era GRAVADO) na nota B.
    */
    await montar();
    await abrirConferencia(0);
    const campo = screen.getByLabelText('Quantidade recebida de Bateria 60V');
    // Digita sem sair do campo — o pior momento para trocar de nota.
    fireEvent.change(campo, { target: { value: '3' } });
    expect((campo as HTMLInputElement).value).toBe('3');

    await abrirConferencia(1);
    const campoDaNota2 = await screen.findByLabelText('Quantidade recebida de Bateria 60V');
    // A nota 2 nunca foi conferida: o campo abre com a quantidade DELA (10),
    // não com o 3 digitado na nota 1.
    expect((campoDaNota2 as HTMLInputElement).value).toBe('10');
  });

  it('o item mostra COMO casou — o método gravado, não "barcode" fabricado', async () => {
    await montar();
    await abrirConferencia();
    await screen.findByText('por código interno');
  });
});

describe('o radar da SEFAZ', () => {
  it('Buscar agora consulta e conta os novos', async () => {
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    await screen.findByText('2 documento(s) novo(s) da SEFAZ.');
    expect(posts.some((p) => p.url.includes('/purchases/dfe/consultar'))).toBe(true);
  });

  it('ciência manda o tipo certo e o resumo vira nota importável', async () => {
    await montar();
    await screen.findByText('Fornecedor Simulado 1');
    // Antes da ciência: só o resumo.
    screen.getByText('só o resumo — a ciência libera a nota completa');

    fireEvent.click(screen.getByRole('button', { name: 'Ciência' }));
    await waitFor(() => {
      const post = posts.find((p) => p.url.includes('/manifestar'));
      expect(post).toBeTruthy();
      expect(post!.corpo.tipo).toBe('ciencia');
    });
    // A tela recarregou: agora dá para importar.
    const importar = await screen.findByRole('button', { name: 'Importar' });
    fireEvent.click(importar);
    await screen.findByText('Nota importada — está na lista de notas, em conferência.');
    expect(posts.some((p) => p.url.includes(`/purchases/dfe/${CHAVE_DFE}/importar`))).toBe(true);
  });

  it('não realizada exige justificativa de 15+ letras — o botão fica desarmado antes disso', async () => {
    await montar();
    await screen.findByText('Fornecedor Simulado 1');
    fireEvent.click(screen.getByRole('button', { name: 'Não realizada' }));
    const campo = await screen.findByLabelText(
      `Justificativa da operação não realizada de ${CHAVE_DFE}`,
    );
    const confirmar = screen.getByRole('button', { name: 'Confirmar' });
    expect((confirmar as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(campo, { target: { value: 'pedido cancelado antes do envio' } });
    expect((confirmar as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmar);
    await waitFor(() => {
      const post = posts.find((p) => p.url.includes('/manifestar'));
      expect(post!.corpo.tipo).toBe('nao_realizada');
      expect(post!.corpo.justification).toBe('pedido cancelado antes do envio');
    });
  });

  it('estoquista vê o radar mas NÃO vê os botões de manifestar', async () => {
    entrar('estoquista');
    await montar();
    await screen.findByText('Fornecedor Simulado 1');
    expect(screen.queryByRole('button', { name: 'Ciência' })).toBeNull();
    expect(screen.queryByText('Manifestar')).toBeNull();
  });
});

describe('os fretes', () => {
  it('o CT-e aparece com transportadora, valor e o vínculo derivado com as notas', async () => {
    await montar();
    await screen.findByText('Transportadora Pampa');
    screen.getByText('R$ 350,00');
    // Das duas NF-e transportadas, uma já entrou.
    screen.getByText('1 de 2 no funil');
  });

  it('importar o XML do conhecimento envia o texto cru e recarrega a lista', async () => {
    await montar();
    const card = screen.getByText('Fretes (CT-e)').closest('section') as HTMLElement;
    const input = within(card).getByLabelText('Arquivo XML do CT-e');
    const arquivo = new File(['<cteProc><CTe><infCte/></CTe></cteProc>'], 'cte.xml', {
      type: 'text/xml',
    });
    // O jsdom não implementa File.text(); a tela só precisa do texto.
    Object.defineProperty(arquivo, 'text', {
      value: async () => '<cteProc><CTe><infCte/></CTe></cteProc>',
    });
    fireEvent.change(input, { target: { files: [arquivo] } });

    await screen.findByText('Frete de R$ 210,00 registrado.');
    const post = posts.find((p) => p.url.includes('/purchases/cte/import'));
    expect(post).toBeTruthy();
    expect(String(post!.corpo.xml)).toContain('infCte');
  });
});
