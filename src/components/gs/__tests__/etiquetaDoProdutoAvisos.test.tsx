/**
 * A ETIQUETA NO CADASTRO DO PRODUTO avisa o que saiu errado no papel
 * (A-produto-M03):
 *
 *   - preço zero: a etiqueta sai com R$ 0,00 e o caixa recusa a venda;
 *   - preço promocional: a etiqueta fica errada quando a promoção acabar;
 *   - código cadastrado que não virou barra: o motivo;
 *   - o aviso de "sem código" NÃO apaga mais o erro do pop-up bloqueado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { EtiquetaDoProduto } from '../EtiquetaDoProduto';

const MODELO = {
  id: 'm1', name: 'Rolo 40 × 30', midia: 'rolo', paperWidthMm: 40, paperHeightMm: null, widthMm: 40, heightMm: 30,
  columns: 1, rows: null, gapXmm: 0, gapYmm: 0, marginTopMm: 1, marginLeftMm: 0, orientation: 'retrato',
  scalePercent: 100, dpi: 203, fields: ['nome'], priceHighlight: true, complementText: null, printerId: null,
  printerName: null, isDefault: true,
};

let folha: Record<string, unknown>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  folha = { html: '<html>folha</html>', etiquetas: 1, folhas: 1, promocoes: [], semPreco: [], codigosGerados: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      if (alvo.includes('/core/labels/templates/preview')) return json({ html: '<html>prévia</html>', etiquetas: 1, folhas: 1 });
      if (alvo.includes('/core/labels/templates')) return json({ items: [MODELO], campos: [] });
      if (alvo.includes('/core/labels/sheet')) return json(folha);
      return json({});
    }),
  );
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste dos avisos da etiqueta do produto',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste dos avisos da etiqueta do produto');
});

const janelaAberta = () => ({
  document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn(),
});

async function imprimirCom(janela: unknown) {
  vi.spyOn(window, 'open').mockImplementation(() => janela as never);
  const onImpresso = vi.fn();
  render(<EtiquetaDoProduto productId="p1" onImpresso={onImpresso} />);
  await waitFor(() => expect((screen.getByLabelText('Modelo de etiqueta') as HTMLSelectElement).value).toBe('m1'));
  fireEvent.click(screen.getByRole('button', { name: 'Imprimir 1 etiqueta(s)' }));
  await waitFor(() => expect(onImpresso).toHaveBeenCalled());
  return onImpresso;
}

describe('os avisos da folha, no cadastro', () => {
  it('preço zero e promoção: os dois avisos aparecem, junto com o "enviada(s) para impressão"', async () => {
    folha = { ...folha, semPreco: ['Sabão'], promocoes: ['Detergente'] };
    const onImpresso = await imprimirCom(janelaAberta());
    const lista = screen.getByTestId('problemas-da-etiqueta');
    expect(lista.textContent).toMatch(/Sem preço: Sabão — a etiqueta sai com R\$ 0,00 e o caixa vai recusar a venda/);
    expect(lista.textContent).toMatch(/Preço promocional: Detergente — .*fica errada quando a promoção acabar/);
    expect(screen.getByRole('status').textContent).toMatch(/enviada\(s\) para impressão/);
    expect(onImpresso).toHaveBeenCalledWith({ codigoGerado: null });
  });

  it('sem nenhum problema, não aparece lista de avisos', async () => {
    await imprimirCom(janelaAberta());
    expect(screen.queryByTestId('problemas-da-etiqueta')).toBeNull();
  });

  it('código cadastrado que não virou barra: o motivo aparece', async () => {
    folha = {
      ...folha,
      codigosSemDesenho: [{ name: 'Sabão', motivo: 'o código 7891234567890 tem dígito verificador errado (o último deveria ser 5)' }],
    };
    await imprimirCom(janelaAberta());
    expect(screen.getByTestId('problemas-da-etiqueta').textContent).toMatch(/não sai em barras: .*verificador errado/);
  });

  it('pop-up bloqueado E produto sem código: os dois recados ficam na tela (antes o segundo apagava o primeiro)', async () => {
    folha = { ...folha, semCodigo: ['Sabão'], semPreco: ['Sabão'] };
    await imprimirCom(null);
    expect(screen.getByRole('alert').textContent).toMatch(/bloqueou a janela de impressão: nada foi impresso/);
    const lista = screen.getByTestId('problemas-da-etiqueta').textContent ?? '';
    expect(lista).toMatch(/não inclui gerar código no cadastro/);
    // Revisão: nada foi impresso, então os avisos não podem dizer que a etiqueta "saiu".
    expect(lista).not.toMatch(/saiu/);
  });
});
