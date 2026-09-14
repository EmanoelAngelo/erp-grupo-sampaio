/**
 * O MUNICÍPIO DA NOTA DO PEDIDO SE CORRIGE NA FICHA (R3-IBGE, GAP-PRD-028).
 *
 * O pedido fechado antes da tabela oficial do IBGE guarda no retrato o código
 * que o cliente digitou. O servidor passou a apontá-lo na prontidão da nota e
 * a recusar a emissão sem numerar — e, sem porta para corrigir, o pedido não
 * se faturaria nunca. A ficha do pedido, no cartão "Nota fiscal do pedido",
 * oferece a correção ali mesmo: a cidade sugerida pelo nome escrito (ou
 * escolhida na lista, dentro da UF do endereço), e a prontidão recalculada
 * troca o aviso pelo botão de emitir.
 *
 * FIXTURE: municípios de amostra, não a lista oficial do IBGE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PedidosPage } from '../GestaoPages';
import { respostaDaBarraDoShell } from './barraDoShell';

const VOCABULARIO = {
  entrega: ['pago', 'separacao', 'conferencia', 'embalado', 'expedido', 'entregue'],
  retirada: ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'],
  rotulos: { pago: 'Pago', entregue: 'Entregue', cancelado: 'Cancelado' },
};

const PEDIDO = {
  id: 'ord-1',
  number: 1001,
  customer_name: 'Joana Compradora',
  total_cents: 10000,
  status: 'pago',
  tracking_code: null,
  created_at: '2026-08-10T12:00:00.000Z',
  shipping_method: 'retirada',
};

const MOTIVO = 'o código IBGE 4399999 não é de nenhum município de RS na tabela oficial do IBGE';

function prontidaoComMunicipio(sugestao: { codigo: string; nome: string; uf: string } | null) {
  return {
    canEmit: false,
    alreadyEmitted: false,
    documentId: null,
    reasons: [`Município do destinatário: ${MOTIVO}. Corrija em Pedidos › este pedido › Nota fiscal do pedido.`],
    municipio: { lado: 'faturamento', uf: 'RS', cidade: 'Pelotas', codigo: '4399999', motivo: MOTIVO, sugestao },
  };
}

const PRONTA = { canEmit: true, alreadyEmitted: false, documentId: null, reasons: [], municipio: null };

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor(opcoes: { prontidao: unknown; correcao?: () => Response }) {
  const posts: { url: string; body: unknown }[] = [];
  const buscas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const barra = respostaDaBarraDoShell(url);
      if (barra) return barra;
      const u = String(url);
      if (init?.method === 'POST') {
        posts.push({ url: u, body: JSON.parse(String(init.body ?? '{}')) });
        if (u.includes('/nfe/municipio')) return opcoes.correcao ? opcoes.correcao() : json(PRONTA);
        return json({});
      }
      if (u.includes('/loja/municipios')) {
        buscas.push(u);
        return json({
          carregada: true,
          total: 3,
          itens: u.includes('q=')
            ? [
                { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
                { codigo: '4314902', nome: 'Porto Alegre', uf: 'RS' },
              ]
            : [],
        });
      }
      if (u.includes('/nfe/readiness')) return json(opcoes.prontidao);
      if (/\/core\/orders\/[^/?]+$/.test(u.split('?')[0])) {
        return json({ ...PEDIDO, items: [], events: [], financeEntries: [] });
      }
      return json({ items: [PEDIDO], vocabulario: VOCABULARIO });
    }),
  );
  return { posts, buscas };
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/pedidos?encomenda=ord-1']}>
      <PedidosPage />
    </MemoryRouter>,
  );
}

async function grupoDaCorrecao() {
  return screen.findByRole('group', { name: 'Corrigir o município do endereço da nota' });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('a ficha oferece a correção do município que a tabela do IBGE desmente', () => {
  it('com a sugestão pelo nome, um clique corrige — e a prontidão recalculada mostra "Emitir NF-e"', async () => {
    const { posts } = servidor({ prontidao: prontidaoComMunicipio({ codigo: '4314407', nome: 'Pelotas', uf: 'RS' }) });
    montar();

    const grupo = await grupoDaCorrecao();
    // Diz o que está errado e o que vai mudar.
    expect(grupo.textContent).toContain('4399999');
    expect(grupo.textContent).toContain('Pelotas (código 4314407)');
    expect(screen.queryByRole('button', { name: 'Emitir NF-e' })).toBeNull();

    fireEvent.click(within(grupo).getByRole('button', { name: 'Corrigir o município' }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain('/core/orders/ord-1/nfe/municipio');
    expect(posts[0].body).toEqual({ cityIbge: '4314407' });
    expect(await screen.findByRole('button', { name: 'Emitir NF-e' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Corrigir o município do endereço da nota' })).toBeNull();
    await act(async () => {});
  });

  it('sem sugestão, a cidade é escolhida na lista, dentro da UF do endereço', async () => {
    const { posts, buscas } = servidor({ prontidao: prontidaoComMunicipio(null) });
    montar();

    const grupo = await grupoDaCorrecao();
    const botao = within(grupo).getByRole('button', { name: 'Corrigir o município' }) as HTMLButtonElement;
    // Nada escolhido ainda: o botão não manda nada.
    expect(botao.disabled).toBe(true);

    const campo = within(grupo).getByRole('combobox', { name: 'Município do endereço da nota' });
    fireEvent.change(campo, { target: { value: 'Pel' } });
    fireEvent.click(await within(grupo).findByRole('option', { name: /Pelotas/ }));
    expect(buscas.some((b) => b.includes('uf=RS'))).toBe(true);

    expect(botao.disabled).toBe(false);
    fireEvent.click(botao);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ cityIbge: '4314407' });
    await act(async () => {});
  });

  it('a recusa do servidor aparece com a frase dele, e o grupo continua para tentar de novo', async () => {
    servidor({
      prontidao: prontidaoComMunicipio({ codigo: '4314407', nome: 'Pelotas', uf: 'RS' }),
      correcao: () =>
        json(
          { error: { code: 'CORE_ORDER_NFE_JA_EXISTE', message: 'Este pedido já tem NF-e: o endereço da nota não muda mais.' } },
          409,
        ),
    });
    montar();

    const grupo = await grupoDaCorrecao();
    fireEvent.click(within(grupo).getByRole('button', { name: 'Corrigir o município' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Este pedido já tem NF-e');
    expect(await grupoDaCorrecao()).toBeTruthy();
    await act(async () => {});
  });

  it('código de OUTRA UF (retrato da 84 com a UF errada): a ficha oferece manter o código e corrigir a UF', async () => {
    const motivo = 'o código IBGE 4314407 é de Pelotas (RS), não de um município de SC';
    const { posts } = servidor({
      prontidao: {
        canEmit: false,
        alreadyEmitted: false,
        documentId: null,
        reasons: [`Município do destinatário: ${motivo}.`],
        municipio: {
          lado: 'faturamento',
          uf: 'SC',
          cidade: 'Pelotas',
          codigo: '4314407',
          motivo,
          sugestao: null,
          doCodigo: { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
        },
      },
    });
    montar();

    const grupo = await grupoDaCorrecao();
    const manter = within(grupo).getByRole('button', { name: 'Manter o código e corrigir a UF para RS' });
    fireEvent.click(manter);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ cityIbge: '4314407' });
    expect(await screen.findByRole('button', { name: 'Emitir NF-e' })).toBeTruthy();
    await act(async () => {});
  });

  it('prontidão sem o campo (servidor anterior) ou sem município a corrigir: só os motivos, sem o grupo', async () => {
    servidor({ prontidao: { canEmit: false, alreadyEmitted: false, documentId: null, reasons: ['Certificado A1: falta'] } });
    montar();
    expect(await screen.findByText('Certificado A1: falta')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Corrigir o município do endereço da nota' })).toBeNull();
    await act(async () => {});
  });
});
