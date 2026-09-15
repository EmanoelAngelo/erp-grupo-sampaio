/**
 * AS FOTOS E O FISCAL INCOMPLETO NO BALCÃO — P0 da Preço Justo.
 *
 * O que este arquivo trava, na tela do PDV com o login do caixa da loja:
 *
 *   - a lista da busca desenha a MINIATURA (`thumb_url`), com `loading="lazy"`
 *     e lado fixo — e NUNCA o original, nem quando a resposta o trouxesse;
 *   - produto sem miniatura mostra o espaço neutro, do mesmo tamanho;
 *   - miniatura que não carrega (servidor fora, sem rede) vira o espaço
 *     neutro, e NÃO é pedida de novo a cada busca — só quando o navegador
 *     avisa que a rede voltou;
 *   - preço e foto novos aparecem na busca seguinte: nada guarda a busca;
 *   - o "fiscal incompleto" aparece na lista e, no item bipado direto, na
 *     faixa e na linha do carrinho;
 *   - a pesquisa avançada (F4) segue a mesma régua da miniatura.
 *
 * ## Como cada caso fica vermelho
 *
 *   - troque `thumb_url` por `image_url` na linha e o caso do original cai;
 *   - tire a memória de falhas e a segunda busca volta a pedir a imagem;
 *   - tire o aviso de `addProduct` e o caso da bipagem não acha a frase.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { esquecerFalhasDeMiniatura } from '@/lib/miniaturas';
import { PesquisaAvancadaDialog } from '@/components/gs/PesquisaAvancadaDialog';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const ORIGINAL = '/uploads/produtos/p-azul.jpg';
const MINI_AZUL = '/uploads/produtos/p-azul-mini-0a1b2c3d.webp';

function camisetaAzul(extra: Record<string, unknown> = {}) {
  return {
    id: 'p-azul',
    internal_code: 'CAM-AZ',
    sku: null,
    barcode: '7890000000017',
    name: 'Camiseta Azul',
    category: 'Camisetas',
    brand: null,
    unit: 'UN',
    cost_cents: 500,
    price_cents: 3990,
    effective_price_cents: 3990,
    on_sale: false,
    min_stock: 0,
    stock_quantity: 4,
    active: 1,
    kind: 'retail',
    matched_exact: 0,
    thumb_url: MINI_AZUL,
    tem_foto: 1,
    // Um servidor que ainda mandasse o original: a tela não pode usá-lo.
    image_url: ORIGINAL,
    fiscal_pendencias: [],
    ...extra,
  };
}

function camisetaVerde(extra: Record<string, unknown> = {}) {
  return {
    ...camisetaAzul(),
    id: 'p-verde',
    internal_code: 'CAM-VD',
    barcode: '7890000000024',
    name: 'Camiseta Verde',
    thumb_url: null,
    tem_foto: 0,
    image_url: null,
    fiscal_pendencias: ['NCM', 'CFOP'],
    ...extra,
  };
}

let itensDaBusca: unknown[] = [];
let buscas: string[] = [];

function servidor() {
  return vi.fn(async (url: string | URL | Request) => {
    const alvo = String(url);
    let corpo: unknown = {};
    if (alvo.includes('/core/products/search')) {
      buscas.push(alvo);
      corpo = { items: itensDaBusca, catalogoVazio: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/team') || alvo.includes('/core/units')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function entrarComoCaixa() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-caixa', login: 'caixa', displayName: 'Caixa', profileCode: 'operador_caixa_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'operador_caixa_loja' }],
      access: {
        modelo: { code: 'operador_caixa_loja', name: 'Caixa da loja', personalizado: false },
        capabilities: ['pdv.sell'],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/pdv',
        carimbo: 'c-caixa',
      },
    } as never,
    'LOGIN',
    'teste das miniaturas do PDV',
  );
}

beforeEach(() => {
  itensDaBusca = [];
  buscas = [];
  localStorage.clear();
  esquecerFalhasDeMiniatura();
  vi.stubGlobal('fetch', servidor());
  entrarComoCaixa();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste das miniaturas do PDV');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  esquecerFalhasDeMiniatura();
});

function abrirPdv() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function buscar(termo: string) {
  const antes = buscas.length;
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: termo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() => expect(buscas.length).toBeGreaterThan(antes));
}

const srcs = () => Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '');

describe('a foto na lista da busca do PDV', () => {
  it('desenha a MINIATURA — preguiçosa, de lado fixo — e nunca o original', async () => {
    itensDaBusca = [camisetaAzul(), camisetaVerde()];
    abrirPdv();
    await buscar('camiseta');
    await screen.findByText('Camiseta Azul');

    const img = screen.getByTestId('miniatura-do-produto');
    expect(img.getAttribute('src')).toContain(MINI_AZUL);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('width')).toBe('44');
    expect(img.getAttribute('height')).toBe('44');
    // Nenhuma imagem da tela aponta para o arquivo grande.
    expect(srcs().some((s) => s.includes('p-azul.jpg'))).toBe(false);
    // O produto sem miniatura ganha o espaço neutro — nunca uma imagem quebrada.
    expect(screen.getAllByTestId('miniatura-sem-foto')).toHaveLength(1);
  });

  it('a miniatura que não carrega vira o espaço neutro, e não é pedida de novo até a rede voltar', async () => {
    itensDaBusca = [camisetaAzul(), camisetaVerde()];
    abrirPdv();
    await buscar('camiseta');
    fireEvent.error(await screen.findByTestId('miniatura-do-produto'));
    expect(screen.queryByTestId('miniatura-do-produto')).toBeNull();
    expect(screen.getAllByTestId('miniatura-sem-foto')).toHaveLength(2);

    // Outra busca com a mesma foto: a tela não tenta o arquivo de novo.
    await buscar('camis');
    await screen.findByText('Camiseta Azul');
    expect(screen.queryByTestId('miniatura-do-produto')).toBeNull();

    // A rede voltou: cada miniatura ganha uma nova chance.
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('miniatura-do-produto').getAttribute('src')).toContain(MINI_AZUL);
  });

  it('preço e foto novos chegam na busca seguinte — nada guarda a busca no caminho', async () => {
    itensDaBusca = [camisetaAzul()];
    abrirPdv();
    await buscar('camiseta');
    await screen.findByText('Camiseta Azul');
    expect(screen.getByText(/39,90/)).toBeTruthy();

    itensDaBusca = [
      camisetaAzul({
        price_cents: 4590,
        effective_price_cents: 4590,
        thumb_url: '/uploads/produtos/p-azul-mini-ffff0000.webp',
      }),
    ];
    await buscar('camis');
    await waitFor(() =>
      expect(screen.getByTestId('miniatura-do-produto').getAttribute('src')).toContain('ffff0000'),
    );
    expect(screen.getByText(/45,90/)).toBeTruthy();
    expect(screen.queryByText(/39,90/)).toBeNull();
  });
});

describe('o fiscal incompleto no balcão', () => {
  it('a lista diz QUAL campo falta, no próprio item', async () => {
    itensDaBusca = [camisetaAzul(), camisetaVerde()];
    abrirPdv();
    await buscar('camiseta');
    await screen.findByText('Camiseta Verde');
    expect(screen.getAllByText('Fiscal incompleto: NCM, CFOP')).toHaveLength(1);
  });

  it('o item bipado entra, e a faixa e a linha do carrinho avisam antes do pagamento', async () => {
    itensDaBusca = [camisetaVerde({ matched_exact: 1 })];
    abrirPdv();
    await buscar('7890000000024');
    await screen.findByText(/o cadastro fiscal está incompleto \(NCM, CFOP\)/);
    // A linha do carrinho carrega o distintivo até o fim da venda.
    expect(screen.getByText('Fiscal incompleto: NCM, CFOP')).toBeTruthy();
  });
});

describe('a pesquisa avançada (F4)', () => {
  it('segue a mesma régua: miniatura, espaço neutro e o fiscal incompleto', async () => {
    itensDaBusca = [camisetaAzul(), camisetaVerde()];
    render(<PesquisaAvancadaDialog incluirPecas={false} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nome do produto'), { target: { value: 'camiseta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByText('Camiseta Verde');

    expect(screen.getByTestId('miniatura-do-produto').getAttribute('src')).toContain(MINI_AZUL);
    expect(screen.getAllByTestId('miniatura-sem-foto')).toHaveLength(1);
    expect(srcs().some((s) => s.includes('p-azul.jpg'))).toBe(false);
    expect(screen.getByText('Fiscal incompleto: NCM, CFOP')).toBeTruthy();
  });
});
