/**
 * RELER AS NOTAS JÁ RECEBIDAS, PELA TELA FISCAL (GAP-PRD-181).
 *
 * A retroação existe no servidor (`POST /core/fiscal/classification/reler-notas`)
 * — e rota sem botão é o defeito que esta base já batizou três vezes. O que se
 * crava aqui: o botão está no cartão das sugestões do XML (inclusive quando ele
 * está vazio, que é exatamente o caso da nota antiga que nunca gerou
 * sugestão), chama a rota certa, diz o que achou em português e recarrega as
 * sugestões.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FiscalPage from '../FiscalPage';
import { fraseDaReleitura } from '@/lib/api/releituraDoXml';

const RESUMO = {
  totalProducts: 2,
  withNcm: 2,
  withOrigin: 0,
  confirmed: 0,
  pendingSuggestions: 0,
  divergences: 0,
};

let chamadas: { url: string; metodo: string }[];
let respostaDaReleitura: () => Response;

function corpo(dados: unknown, status = 200): Response {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const caminho = String(typeof url === 'string' ? url : (url as Request).url ?? url);
      chamadas.push({ url: caminho, metodo: init?.method ?? 'GET' });
      if (caminho.includes('/fiscal/classification/reler-notas')) return respostaDaReleitura();
      if (caminho.includes('/fiscal/readiness')) {
        return corpo({ items: [], productionUnlock: null, classification: RESUMO });
      }
      if (caminho.includes('/fiscal/classification')) return corpo({ items: [], summary: RESUMO });
      if (caminho.includes('/fiscal/config')) {
        return corpo({ companyId: 'c1', legalName: 'Loja', environment: 'homologation', productionUnlocked: false });
      }
      return corpo({ items: [] });
    }),
  );
}

beforeEach(() => {
  chamadas = [];
  respostaDaReleitura = () =>
    corpo({
      notasLidas: 3,
      notasSemArquivo: 1,
      notasIlegiveis: 0,
      fornecedoresCompletados: 2,
      itensCompletados: 5,
      sugestoesNovas: 7,
      procedenciasCorrigidas: 2,
    });
  servidor();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Abre a tela e espera o cartão das sugestões ASSENTAR no estado vazio.
 *
 * O botão existe nos dois estados do cartão (carregando e vazio), e o React
 * troca o elemento quando a lista chega: pegar o botão do primeiro estado e
 * clicar depois seria clicar num nó que já saiu da página.
 */
async function abrir(): Promise<HTMLElement> {
  render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
  await screen.findByText('Nenhuma classificação sugerida esperando confirmação.');
  return screen.getByRole('button', { name: 'Reler as notas já recebidas' });
}

describe('o botão de reler as notas já recebidas', () => {
  it('existe mesmo com o cartão vazio, chama a rota e diz o que achou', async () => {
    const botao = await abrir();
    const antes = chamadas.filter((c) => c.url.includes('/fiscal/classification') && !c.url.includes('reler')).length;

    fireEvent.click(botao);

    await screen.findByText(/3 nota\(s\) relida\(s\)/);
    const aviso = screen.getByText(/3 nota\(s\) relida\(s\)/).textContent ?? '';
    expect(aviso).toContain('7 sugestão(ões) nova(s)');
    expect(aviso).toContain('2 fornecedor(es) com o cadastro completado');
    expect(aviso).toContain('2 produto(s) com a procedência do XML reconhecida');
    // A nota antiga sem arquivo é dita, e não escondida.
    expect(aviso).toContain('1 nota(s) antiga(s) sem o arquivo guardado');

    const releitura = chamadas.find((c) => c.url.includes('/fiscal/classification/reler-notas'));
    expect(releitura?.metodo).toBe('POST');
    // E as sugestões são perguntadas de novo — o que a releitura achou aparece.
    await waitFor(() =>
      expect(
        chamadas.filter((c) => c.url.includes('/fiscal/classification') && !c.url.includes('reler')).length,
      ).toBeGreaterThan(antes),
    );
  });

  /*
    B-estoque-entrada-04 (tela): o servidor devolve quantas linhas de nota
    antiga ganharam o fator de conversão e quantos pedidos de compra foram
    recontados. Sem o conserto, o aviso não dizia nada disso — e o gestor que
    rodou a releitura para consertar as caixas contadas como unidades saía sem
    saber se deu certo.
  */
  it('diz quantas linhas ganharam o fator de conversão e quantos pedidos foram recontados', async () => {
    respostaDaReleitura = () =>
      corpo({
        notasLidas: 3,
        notasSemArquivo: 0,
        notasIlegiveis: 0,
        notasSemValidadeFiscal: 0,
        fornecedoresCompletados: 0,
        itensCompletados: 0,
        sugestoesNovas: 0,
        procedenciasCorrigidas: 0,
        fatoresCompletados: 4,
        pedidosRecalculados: 2,
      });
    fireEvent.click(await abrir());

    const aviso = (await screen.findByText(/3 nota\(s\) relida\(s\)/)).textContent ?? '';
    expect(aviso).toContain('4 linha(s) ganharam o fator de conversão');
    expect(aviso).toContain('2 pedido(s) de compra recontado(s)');
  });

  it('zero também é resposta: diz que nenhuma linha precisou do fator', async () => {
    respostaDaReleitura = () =>
      corpo({
        notasLidas: 3,
        notasSemArquivo: 0,
        notasIlegiveis: 0,
        notasSemValidadeFiscal: 0,
        fornecedoresCompletados: 0,
        itensCompletados: 0,
        sugestoesNovas: 0,
        procedenciasCorrigidas: 0,
        fatoresCompletados: 0,
        pedidosRecalculados: 0,
      });
    fireEvent.click(await abrir());

    const aviso = (await screen.findByText(/3 nota\(s\) relida\(s\)/)).textContent ?? '';
    expect(aviso).toContain('0 linha(s) ganharam o fator de conversão; 0 pedido(s) de compra recontado(s).');
  });

  it('sem as contagens na resposta, a frase não inventa números', async () => {
    // A resposta padrão (beforeEach) não traz fatoresCompletados/pedidosRecalculados.
    fireEvent.click(await abrir());
    const aviso = (await screen.findByText(/3 nota\(s\) relida\(s\)/)).textContent ?? '';
    expect(aviso).not.toContain('fator de conversão');
    expect(aviso).not.toContain('undefined');
  });

  it('a recusa do servidor chega com a frase do servidor', async () => {
    respostaDaReleitura = () =>
      corpo({ error: { code: 'API_PERMISSION_DENIED', message: 'Reler as notas é gesto da gerência.' } }, 403);
    fireEvent.click(await abrir());
    expect((await screen.findByRole('alert')).textContent).toBe('Reler as notas é gesto da gerência.');
  });
});

describe('a frase da releitura', () => {
  const BASE = {
    notasLidas: 1,
    notasSemArquivo: 0,
    notasIlegiveis: 0,
    fornecedoresCompletados: 0,
    itensCompletados: 0,
    sugestoesNovas: 0,
    procedenciasCorrigidas: 0,
  };

  /*
    Revisão do B-estoque-entrada-04 (tela): a primeira versão completava a
    contagem ausente com `?? 0`. Uma resposta com só os pedidos fazia a frase
    dizer "0 linha(s) ganharam o fator" — um zero que o servidor não contou.
  */
  it('só afirma a contagem que o servidor mandou', () => {
    const soPedidos = fraseDaReleitura({ ...BASE, pedidosRecalculados: 2 });
    expect(soPedidos).toContain('2 pedido(s) de compra recontado(s).');
    expect(soPedidos).not.toContain('linha(s) ganharam o fator');

    const soFatores = fraseDaReleitura({ ...BASE, fatoresCompletados: 3 });
    expect(soFatores).toContain('3 linha(s) ganharam o fator de conversão.');
    expect(soFatores).not.toContain('pedido(s) de compra');
  });
});
