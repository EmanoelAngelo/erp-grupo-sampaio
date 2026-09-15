/**
 * A TELA DE ETIQUETAS e a SAÍDA DA IMPRESSÃO (P0 das etiquetas da Preço Justo).
 *
 *   - escolher ZPL manda a saída ao servidor, não abre janela nenhuma, e a
 *     prévia, o arquivo e os comandos aparecem na tela;
 *   - a saída só de rolo fica indisponível na folha A4 (e a escolhida volta ao
 *     navegador), com o que falta conferir em papel à vista;
 *   - no navegador (o padrão), o pedido é o de sempre e a folha abre na janela;
 *   - o histórico diz quem imprimiu e reimprime na saída escolhida;
 *   - a etiqueta de teste sai na saída escolhida;
 *   - sem `labels.products.print`, nem histórico nem teste.
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

const PERFIS = [
  { id: 'navegador', rotulo: 'Navegador (diálogo de impressão)', dica: 'Pelo diálogo.', saida: 'html', mime: 'text/html', extensao: 'html', aceitaFolha: true, levaAjustesDaTermica: false },
  { id: 'zpl', rotulo: 'ZPL (Zebra e compatíveis)', dica: 'Comandos ZPL II.', saida: 'zpl', mime: 'text/plain', extensao: 'zpl', aceitaFolha: false, levaAjustesDaTermica: true },
];

const CATALOGO = {
  sources: [{ id: 'catalogo', label: 'Buscar no catálogo', hint: 'Por nome.', temQuantidadeDeDocumento: false }],
  formats: [
    { id: 'a4_63x25_3x11', label: 'Folha A4 — 33 por folha (63,5 × 25,4 mm)', hint: 'Pimaco A4356.', midia: 'folha', widthMm: 63.5, heightMm: 25.4, columns: 3, rows: 11, campos: ['nome'] },
    { id: 'rolo_50x30', label: 'Rolo 50 × 30 mm', hint: 'Térmica.', midia: 'rolo', widthMm: 50, heightMm: 30, columns: 1, rows: null, campos: ['nome'] },
  ],
  campos: [],
  defaultFormat: 'a4_63x25_3x11',
  quantityModes: [{ id: 'manual', label: 'Digitar a quantidade', hint: 'Uma por item.' }],
  perfis: PERFIS,
  perfilPadrao: 'navegador',
  homologacao: [
    { saida: 'todas', item: 'Leitura do código de barras pelo leitor do caixa', como: 'Bipar 20 vezes.' },
    { saida: 'zpl', item: 'Acentos com ^CI28 (UTF-8)', como: 'Imprimir "ação".' },
  ],
};

const RESPOSTA_ZPL = {
  html: '<html><body>prévia em svg</body></html>', etiquetas: 1, folhas: 1, promocoes: [], semPreco: [], perfil: 'zpl',
  arquivo: { nome: 'etiquetas-rolo_50x30.zpl', mime: 'text/plain; charset=utf-8', base64: btoa('^XA\n^XZ\n') },
  comandos: '^XA\n^PW400\n^XZ\n', avisos: ['TSPL: aviso de exemplo que a tela mostra'], impressaoId: 'j9',
};

const IMPRESSAO = {
  id: 'j1', kind: 'lote', profile: 'zpl', formatId: 'rolo_50x30', templateId: null, formatName: 'Rolo 50 × 30 mm',
  items: [{ productId: 'p1', name: 'Arroz', quantity: 2, priceCents: 990, batchId: null }], labels: 2, pages: 2,
  startAt: 1, reprintOf: null, userId: 'u1', userName: 'Gestor', createdAt: '2026-09-14T12:00:00.000Z',
};

function candidato(id: string, name: string) {
  return {
    productId: id, name, internalCode: `GS-${id}`, barcode: '7891234567895', priceCents: 990, listPriceCents: 990,
    onSale: false, stockQuantity: 3, documentQuantity: null, avisoDoCodigo: null,
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

function entrar(capabilities: string[]) {
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste da saída da impressão de etiquetas',
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/etiquetas']}>
      <EtiquetasPage />
    </MemoryRouter>,
  );
}

const seletorDeFormato = () => screen.getByLabelText('Formato da etiqueta') as HTMLSelectElement;
const seletorDeSaida = () => screen.getByLabelText('Saída da impressão') as HTMLSelectElement;
const pedidosPara = (metodo: string, caminho: string) => pedidos.filter((p) => p.metodo === metodo && p.url.includes(caminho));

let janela: { document: { open: () => void; write: ReturnType<typeof vi.fn>; close: () => void }; focus: () => void; print: ReturnType<typeof vi.fn>; close: () => void };

/** Rolo 50 × 30, Arroz na fila. */
async function arrozNoRolo() {
  await screen.findByRole('option', { name: 'Rolo 50 × 30 mm' });
  fireEvent.change(seletorDeFormato(), { target: { value: 'rolo_50x30' } });
  fireEvent.change(screen.getByPlaceholderText('Nome, código interno ou código de barras'), { target: { value: 'arr' } });
  fireEvent.click(await screen.findByLabelText('Selecionar Arroz'));
}

beforeEach(() => {
  pedidos = [];
  rotas = {
    'GET /core/labels/catalog': () => json(CATALOGO),
    'GET /core/labels/templates': () => json({ items: [], campos: [] }),
    'GET /core/labels/candidates': () => json({ source: 'catalogo', candidates: [candidato('p1', 'Arroz')], problemas: [], truncado: false }),
    'GET /core/labels/prints': () => json({ items: [IMPRESSAO] }),
  };
  servidor();
  entrar(['labels.products.print']);
  janela = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste da saída da impressão');
});

describe('a saída da impressão', () => {
  it('ZPL: o pedido leva a saída, nenhuma janela abre, e a prévia, o arquivo e os comandos aparecem na tela', async () => {
    rotas['POST /core/labels/sheet'] = () => json(RESPOSTA_ZPL);
    montar();
    await arrozNoRolo();
    fireEvent.change(seletorDeSaida(), { target: { value: 'zpl' } });
    // O que falta conferir em papel fica à vista, junto do seletor.
    const conferir = screen.getByTestId('homologacao-da-saida');
    expect(conferir.textContent).toMatch(/Acentos com \^CI28/);
    expect(conferir.textContent).toMatch(/Leitura do código de barras/);

    await waitFor(() => expect((screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Gerar folha/ }));
    await waitFor(() => expect(pedidosPara('POST', '/core/labels/sheet')).toHaveLength(1));
    expect(pedidosPara('POST', '/core/labels/sheet')[0].corpo).toMatchObject({ formatId: 'rolo_50x30', perfil: 'zpl', items: [{ productId: 'p1', quantity: 1 }] });
    expect(window.open).not.toHaveBeenCalled();

    expect(await screen.findByTitle('Prévia da impressão')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar etiquetas-rolo_50x30.zpl' })).toBeTruthy();
    expect(screen.getByTestId('comandos-da-impressora').textContent).toContain('^PW400');
    expect(screen.getByTestId('avisos-da-saida').textContent).toMatch(/aviso de exemplo/);
  });

  it('folha A4: a saída ZPL fica indisponível (só rolo), e a escolhida volta ao navegador quando o formato vira folha', async () => {
    montar();
    await screen.findByLabelText('Saída da impressão');
    const zpl = screen.getByRole('option', { name: /ZPL \(Zebra e compatíveis\) — só rolo/ }) as HTMLOptionElement;
    expect(zpl.disabled).toBe(true);

    fireEvent.change(seletorDeFormato(), { target: { value: 'rolo_50x30' } });
    fireEvent.change(seletorDeSaida(), { target: { value: 'zpl' } });
    expect(seletorDeSaida().value).toBe('zpl');
    fireEvent.change(seletorDeFormato(), { target: { value: 'a4_63x25_3x11' } });
    await waitFor(() => expect(seletorDeSaida().value).toBe('navegador'));
  });

  it('no navegador (o padrão), o pedido é o de sempre — sem "perfil" — e a folha abre na janela', async () => {
    rotas['POST /core/labels/sheet'] = () => json({ html: '<html>folha</html>', etiquetas: 1, folhas: 1, promocoes: [], semPreco: [], perfil: 'navegador', arquivo: null });
    montar();
    await arrozNoRolo();
    expect(seletorDeSaida().value).toBe('navegador');
    await waitFor(() => expect((screen.getByRole('button', { name: /Gerar folha/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Gerar folha/ }));
    await waitFor(() => expect(janela.print).toHaveBeenCalled());
    expect('perfil' in (pedidosPara('POST', '/core/labels/sheet')[0].corpo ?? {})).toBe(false);
    expect(janela.document.write).toHaveBeenCalledWith('<html>folha</html>');
    expect(screen.queryByTitle('Prévia da impressão')).toBeNull();
  });
});

describe('o histórico, a reimpressão e o teste', () => {
  it('o histórico diz quem imprimiu o quê, e reimprimir manda a saída escolhida agora', async () => {
    rotas['POST /core/labels/prints/j1/reprint'] = () => json({ html: '<html>reimpressa</html>', etiquetas: 2, folhas: 2, promocoes: [], semPreco: [], perfil: 'navegador', arquivo: null });
    montar();
    const tabela = await screen.findByRole('table', { name: 'Histórico de impressão de etiquetas' });
    expect(within(tabela).getByText('Gestor')).toBeTruthy();
    expect(within(tabela).getByText('Arroz × 2')).toBeTruthy();
    fireEvent.click(within(tabela).getByRole('button', { name: /Reimprimir a impressão de/ }));
    await waitFor(() => expect(pedidosPara('POST', '/core/labels/prints/j1/reprint')).toHaveLength(1));
    expect(pedidosPara('POST', '/core/labels/prints/j1/reprint')[0].corpo).toEqual({ perfil: 'navegador' });
    await waitFor(() => expect(janela.document.write).toHaveBeenCalledWith('<html>reimpressa</html>'));
    expect(await screen.findByText(/Reimpressão: 2 etiqueta\(s\) com o preço de hoje/)).toBeTruthy();
  });

  it('a etiqueta de teste sai na saída escolhida, com a prévia na tela', async () => {
    rotas['POST /core/labels/test'] = () => json({ ...RESPOSTA_ZPL, impressaoId: 'jt' });
    montar();
    await screen.findByRole('option', { name: 'Rolo 50 × 30 mm' });
    fireEvent.change(seletorDeFormato(), { target: { value: 'rolo_50x30' } });
    fireEvent.change(seletorDeSaida(), { target: { value: 'zpl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Imprimir etiqueta de teste' }));
    await waitFor(() => expect(pedidosPara('POST', '/core/labels/test')).toHaveLength(1));
    expect(pedidosPara('POST', '/core/labels/test')[0].corpo).toEqual({ formatId: 'rolo_50x30', perfil: 'zpl' });
    expect(await screen.findByText('Etiqueta de teste')).toBeTruthy();
    expect(screen.getByText(/confira se a moldura saiu centrada no adesivo/)).toBeTruthy();
  });

  it('sem labels.products.print, a tela não pede o histórico nem oferece o teste', async () => {
    entrar([]);
    montar();
    await screen.findByLabelText('Saída da impressão');
    expect(screen.queryByRole('button', { name: 'Imprimir etiqueta de teste' })).toBeNull();
    expect(screen.queryByText('Histórico de impressão')).toBeNull();
    expect(pedidosPara('GET', '/core/labels/prints')).toHaveLength(0);
  });
});
