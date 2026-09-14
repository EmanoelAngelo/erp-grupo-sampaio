/**
 * A TELA DE ETIQUETAS — o que a auditoria da Preço Justo achou, provado na tela.
 *
 *   - o "modelo padrão da loja" não é trocado pelo formato A4 conforme a ordem
 *     em que as respostas chegam (C-etiquetas-06);
 *   - o campo de quantidade deixa apagar: limpar e digitar 30 dá 30, e não 130
 *     (C-etiquetas-M01);
 *   - a fila sobrevive a uma busca nova, e dá para começar numa posição da
 *     folha (C-etiquetas-M03);
 *   - a folha gerada é dita como sucesso, com os avisos juntos — o "foi
 *     baixada" não some atrás do aviso de promoção (C-etiquetas-M05);
 *   - a impressora preferida é dita na hora de imprimir (C-etiquetas-18);
 *   - a sugestão pelo saldo para em 200 e diz que parou (C-etiquetas-09);
 *   - sem formato escolhido, não há "Gerar folha" (C-etiquetas-19);
 *   - "Imprimir etiquetas desta entrada" abre a fila da nota (B-estoque-entrada-07).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EtiquetasPage from '../EtiquetasPage';
import { setSession } from '@/lib/api/client';

type Pedido = { url: string; metodo: string; corpo: Record<string, unknown> | null };
let pedidos: Pedido[];
let rotas: Record<string, (p: Pedido) => Response | Promise<Response>>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function adiado() {
  let resolver!: () => void;
  const p = new Promise<void>((r) => {
    resolver = r;
  });
  return { p, resolver };
}

const CATALOGO = {
  sources: [
    { id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false },
    { id: 'estoque', label: 'Posição de estoque', hint: 'Prateleira.', temQuantidadeDeDocumento: false },
    { id: 'nota', label: 'Nota de entrada', hint: 'O que entrou.', temQuantidadeDeDocumento: true },
  ],
  formats: [
    { id: 'a4_63x25_3x11', label: 'Folha A4 — 33 por folha (63,5 × 25,4 mm)', hint: 'Pimaco A4356.', midia: 'folha', widthMm: 63.5, heightMm: 25.4, columns: 3, rows: 11, campos: ['nome'] },
    { id: 'rolo_50x30', label: 'Rolo 50 × 30 mm', hint: 'Térmica.', midia: 'rolo', widthMm: 50, heightMm: 30, columns: 1, rows: null, campos: ['nome'] },
  ],
  campos: [],
  defaultFormat: 'a4_63x25_3x11',
  quantityModes: [
    { id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' },
    { id: 'saldo', label: 'Usar o saldo em estoque', hint: 'Uma por peça.' },
    { id: 'documento', label: 'Usar a quantidade do documento', hint: 'Do documento.' },
  ],
};

const MODELO_PADRAO = {
  id: 'm1', name: 'Rolo 40 × 30', midia: 'rolo', paperWidthMm: 40, paperHeightMm: null, widthMm: 40, heightMm: 30,
  columns: 1, rows: null, gapXmm: 0, gapYmm: 0, marginTopMm: 1, marginLeftMm: 0, orientation: 'retrato',
  scalePercent: 100, fields: ['nome', 'preco'], priceHighlight: true, complementText: null,
  printerId: 'imp-z', printerName: 'Zebra ZD220', isDefault: true,
};

function candidato(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    productId: id, name, internalCode: `GS-${id}`, barcode: '7891234567895', priceCents: 990, listPriceCents: 990,
    onSale: false, stockQuantity: 3, documentQuantity: null, avisoDoCodigo: null, ...extra,
  };
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const pedido: Pedido = {
        url: String(url),
        metodo: (init?.method ?? 'GET').toUpperCase(),
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      pedidos.push(pedido);
      const caminho = new URL(pedido.url, 'http://x').pathname.replace(/^\/api\/v1/, '');
      const rota = rotas[`${pedido.metodo} ${caminho}`];
      return rota ? rota(pedido) : json({ items: [] });
    }),
  );
}

function entrar(capabilities: string[] = []) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      // Acesso do modelo padrão (não personalizado): o menu segue o perfil, e
      // `useCan` lê as capabilities daqui.
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste da tela de etiquetas',
  );
}

function montar(inicio = '/sistema/etiquetas') {
  render(
    <MemoryRouter initialEntries={[inicio]}>
      <EtiquetasPage />
    </MemoryRouter>,
  );
}

const seletorDeFormato = () => screen.getByLabelText('Formato da etiqueta') as HTMLSelectElement;
const botaoGerar = () => screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement;

/** A busca do catálogo devolve o que o termo pedir. */
function catalogoCom(porTermo: Record<string, ReturnType<typeof candidato>[]>) {
  rotas['GET /core/labels/candidates'] = (p) => {
    const q = new URL(p.url, 'http://x').searchParams;
    const lista = porTermo[q.get('search') ?? ''] ?? [];
    return json({ source: q.get('source'), candidates: lista, problemas: [], truncado: false });
  };
}

async function buscar(termo: string) {
  fireEvent.change(screen.getByPlaceholderText('Nome, código interno ou código de barras'), { target: { value: termo } });
}

let janela: { document: { open: () => void; write: (h: string) => void; close: () => void }; focus: () => void; print: ReturnType<typeof vi.fn>; close: () => void };

beforeEach(() => {
  pedidos = [];
  rotas = {
    'GET /core/labels/catalog': () => json(CATALOGO),
    'GET /core/labels/templates': () => json({ items: [MODELO_PADRAO], campos: [] }),
  };
  servidor();
  entrar();
  janela = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste da tela de etiquetas');
});

describe('o modelo padrão da loja não depende da ordem das respostas (C-etiquetas-06)', () => {
  it('modelos respondem ANTES do catálogo: continua o modelo padrão, não o A4', async () => {
    const modelos = adiado();
    const catalogo = adiado();
    rotas['GET /core/labels/templates'] = () => modelos.p.then(() => json({ items: [MODELO_PADRAO], campos: [] }));
    rotas['GET /core/labels/catalog'] = () => catalogo.p.then(() => json(CATALOGO));
    montar();
    modelos.resolver();
    await waitFor(() => expect(seletorDeFormato().value).toBe('modelo:m1'));
    catalogo.resolver();
    await screen.findByRole('option', { name: /Folha A4 — 33 por folha/ });
    expect(seletorDeFormato().value).toBe('modelo:m1');
  });

  it('catálogo responde ANTES dos modelos: o modelo padrão vence o formato que ninguém escolheu', async () => {
    const modelos = adiado();
    const catalogo = adiado();
    rotas['GET /core/labels/templates'] = () => modelos.p.then(() => json({ items: [MODELO_PADRAO], campos: [] }));
    rotas['GET /core/labels/catalog'] = () => catalogo.p.then(() => json(CATALOGO));
    montar();
    catalogo.resolver();
    await waitFor(() => expect(seletorDeFormato().value).toBe('a4_63x25_3x11'));
    modelos.resolver();
    await waitFor(() => expect(seletorDeFormato().value).toBe('modelo:m1'));
  });

  it('o modelo escolhido é apagado e não há padrão: cai no formato padrão, não em vazio (C-etiquetas-19)', async () => {
    entrar(['settings.printers.manage']);
    const outro = { ...MODELO_PADRAO, id: 'm2', name: 'Gôndola', isDefault: false };
    let lista: unknown[] = [outro];
    rotas['GET /core/labels/templates'] = () => json({ items: lista, campos: [] });
    rotas['DELETE /core/labels/templates/m2'] = () => {
      lista = [];
      return json({ ok: true, id: 'm2', name: 'Gôndola' });
    };
    montar();
    await screen.findByRole('option', { name: /Gôndola/ });
    fireEvent.change(seletorDeFormato(), { target: { value: 'modelo:m2' } });
    expect(seletorDeFormato().value).toBe('modelo:m2');
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, apagar' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: /Gôndola/ })).toBeNull());
    expect(seletorDeFormato().value).toBe('a4_63x25_3x11');
  });
});

describe('a fila e a quantidade', () => {
  it('limpar a quantidade e digitar 3 e 0 dá 30 etiquetas, não 130 (C-etiquetas-M01)', async () => {
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')] });
    montar();
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    const qtd = screen.getByLabelText('Quantidade de etiquetas de Sabão em barra') as HTMLInputElement;
    expect(qtd.value).toBe('1');
    // Tecla a tecla: apaga, depois digita "3" e "0" no fim do que estiver no campo.
    fireEvent.change(qtd, { target: { value: '' } });
    expect(qtd.value).toBe('');
    expect(botaoGerar().disabled).toBe(true);
    fireEvent.change(qtd, { target: { value: `${qtd.value}3` } });
    fireEvent.change(qtd, { target: { value: `${qtd.value}0` } });
    expect(qtd.value).toBe('30');
    expect(botaoGerar().textContent).toMatch(/\(30\)/);
    expect(botaoGerar().disabled).toBe(false);
  });

  it('a fila sobrevive a uma busca nova: dois produtos de duas buscas vão na mesma folha (C-etiquetas-M03)', async () => {
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')], det: [candidato('p2', 'Detergente 500 ml')] });
    rotas['POST /core/labels/sheet'] = () => json({ html: '<html></html>', etiquetas: 2, folhas: 1, promocoes: [], semPreco: [] });
    montar();
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    await buscar('det');
    fireEvent.click(await screen.findByLabelText('Selecionar Detergente 500 ml'));
    const fila = screen.getByRole('list', { name: 'Itens na fila' });
    expect(within(fila).getByText('Sabão em barra')).toBeTruthy();
    expect(within(fila).getByText('Detergente 500 ml')).toBeTruthy();
    await waitFor(() => expect(botaoGerar().disabled).toBe(false));
    fireEvent.click(botaoGerar());
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))).toBe(true));
    const corpo = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))!.corpo!;
    expect((corpo.items as { productId: string }[]).map((i) => i.productId).sort()).toEqual(['p1', 'p2']);
  });

  it('"Começar na posição" vai para o servidor numa folha de várias etiquetas (C-etiquetas-M03)', async () => {
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')] });
    rotas['POST /core/labels/sheet'] = () => json({ html: '<html></html>', etiquetas: 1, folhas: 1, promocoes: [], semPreco: [] });
    montar();
    await screen.findByRole('option', { name: /Folha A4 — 33 por folha/ });
    fireEvent.change(seletorDeFormato(), { target: { value: 'a4_63x25_3x11' } });
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    fireEvent.change(screen.getByLabelText('Começar na posição'), { target: { value: '5' } });
    fireEvent.click(botaoGerar());
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))).toBe(true));
    expect(pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))!.corpo).toMatchObject({
      formatId: 'a4_63x25_3x11',
      startAt: 5,
    });
  });

  it('a posição de uma folha maior não trava o rolo, onde o campo "Começar na posição" some (revisão do M03)', async () => {
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')] });
    rotas['POST /core/labels/sheet'] = () => json({ html: '<html></html>', etiquetas: 1, folhas: 1, promocoes: [], semPreco: [] });
    montar();
    await screen.findByRole('option', { name: /Folha A4 — 33 por folha/ });
    fireEvent.change(seletorDeFormato(), { target: { value: 'a4_63x25_3x11' } });
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    fireEvent.change(screen.getByLabelText('Começar na posição'), { target: { value: '20' } });
    fireEvent.change(seletorDeFormato(), { target: { value: 'rolo_50x30' } });
    expect(screen.queryByLabelText('Começar na posição')).toBeNull();
    expect(screen.queryByTestId('motivo-para-nao-gerar')).toBeNull();
    expect(botaoGerar().disabled).toBe(false);
    fireEvent.click(botaoGerar());
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))).toBe(true));
    const corpo = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/core/labels/sheet'))!.corpo!;
    expect(corpo).toMatchObject({ formatId: 'rolo_50x30' });
    expect(corpo.startAt).toBeUndefined();
  });

  it('pelo saldo, 350 peças viram 200 etiquetas — e a tela diz que parou em 200 (C-etiquetas-09)', async () => {
    rotas['GET /core/labels/candidates'] = () =>
      json({ source: 'estoque', candidates: [candidato('p9', 'Parafuso 3/8', { stockQuantity: 350 })], problemas: [], truncado: false });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Posição de estoque' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Usar o saldo em estoque' }));
    fireEvent.click(await screen.findByLabelText('Selecionar Parafuso 3/8'));
    expect((screen.getByLabelText('Quantidade de etiquetas de Parafuso 3/8') as HTMLInputElement).value).toBe('200');
    expect(screen.getByTestId('aviso-do-teto').textContent).toMatch(/saldo 350/);
    expect(botaoGerar().textContent).toMatch(/\(200\)/);
  });
});

describe('gerar a folha', () => {
  it('sucesso é dito como sucesso: quantas saíram, a impressora a escolher e o aviso de promoção juntos (C-M05, C-18)', async () => {
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')] });
    rotas['POST /core/labels/sheet'] = () =>
      json({ html: '<html>folha</html>', etiquetas: 1, folhas: 1, promocoes: ['Sabão em barra'], semPreco: [], codigosGerados: [] });
    montar();
    await waitFor(() => expect(seletorDeFormato().value).toBe('modelo:m1'));
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    fireEvent.click(botaoGerar());
    const avisos = await screen.findByTestId('avisos-da-folha');
    expect(avisos.textContent).toMatch(/Saíram 1 etiqueta\(s\) em 1 folha\(s\)/);
    expect(avisos.textContent).toMatch(/escolha "Zebra ZD220"/);
    expect(avisos.textContent).toMatch(/promoção/);
    expect(janela.print).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pop-up bloqueado: "foi baixada" e o aviso de promoção aparecem JUNTOS, e não como erro (C-etiquetas-M05)', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    const criar = vi.fn(() => 'blob:folha');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() }));
    catalogoCom({ sab: [candidato('p1', 'Sabão em barra')] });
    rotas['POST /core/labels/sheet'] = () =>
      json({ html: '<html>folha</html>', etiquetas: 1, folhas: 1, promocoes: ['Sabão em barra'], semPreco: [] });
    montar();
    await buscar('sab');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    fireEvent.click(botaoGerar());
    const avisos = await screen.findByTestId('avisos-da-folha');
    expect(avisos.textContent).toMatch(/BAIXADA/);
    expect(avisos.textContent).toMatch(/promoção/);
    expect(criar).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sem formato escolhido, "Gerar folha" fica travado e diz por quê (C-etiquetas-19)', async () => {
    // O catálogo não chega e não há modelo: o seletor fica vazio.
    rotas['GET /core/labels/catalog'] = () => new Promise<Response>(() => {});
    rotas['GET /core/labels/templates'] = () => json({ items: [], campos: [] });
    rotas['GET /core/labels/candidates'] = () =>
      json({ source: 'nota', candidates: [candidato('p1', 'Sabão em barra', { documentQuantity: 5 })], problemas: [], truncado: false });
    montar('/sistema/etiquetas?origem=nota&nota=n1');
    fireEvent.click(await screen.findByLabelText('Selecionar Sabão em barra'));
    expect(seletorDeFormato().value).toBe('');
    expect(botaoGerar().disabled).toBe(true);
    expect(screen.getByTestId('motivo-para-nao-gerar').textContent).toMatch(/Escolha o formato/);
  });
});

describe('a nota de entrada (B-estoque-entrada-07)', () => {
  it('"Imprimir etiquetas desta entrada" abre a fila da nota, na quantidade da nota', async () => {
    rotas['GET /core/labels/candidates'] = () =>
      json({
        source: 'nota',
        candidates: [candidato('p1', 'Sabão em barra', { documentQuantity: 5 }), candidato('p2', 'Detergente', { documentQuantity: 3 })],
        problemas: [],
        truncado: false,
      });
    montar('/sistema/etiquetas?origem=nota&nota=n1');
    await screen.findByLabelText('Selecionar Sabão em barra');
    const pedido = pedidos.find((p) => p.url.includes('/core/labels/candidates'))!;
    expect(new URL(pedido.url, 'http://x').searchParams.get('noteId')).toBe('n1');
    expect(new URL(pedido.url, 'http://x').searchParams.get('source')).toBe('nota');
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect((screen.getByLabelText('Quantidade de etiquetas de Sabão em barra') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('Quantidade de etiquetas de Detergente') as HTMLInputElement).value).toBe('3');
  });
});
