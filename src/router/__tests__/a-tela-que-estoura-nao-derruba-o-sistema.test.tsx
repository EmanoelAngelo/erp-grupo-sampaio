/**
 * ============================================================================
 * A TELA QUE ESTOURA NÃO DERRUBA O SISTEMA INTEIRO
 * ============================================================================
 *
 * ## O defeito que este arquivo guarda
 *
 * A única fronteira de erro era `GlobalErrorBoundary`, e ela envolve o
 * `BrowserRouter` POR FORA. Uma tela que estourasse ao desenhar levava o
 * roteador junto: sobrava um cartão em página cheia com um botão só —
 * "Tentar novamente" — que faz `window.location.reload()`, isto é, volta ao
 * MESMO endereço que acabou de estourar. Causa no dado (campo nulo que a tela
 * percorre, data noutro formato, pedido antigo sem uma chave) é
 * determinística: recarrega, estoura, recarrega. O caixa fica sem menu, sem
 * PDV e sem para onde navegar — o roteador não existe mais para atender outro
 * endereço. Uma tela quebrada levava o sistema junto.
 *
 * ## O que cada caso mede
 *
 * A pergunta NÃO é "a fronteira desenha um aviso" — isso a fronteira antiga já
 * fazia. A pergunta é SE SOBROU SAÍDA. Por isso os casos medem navegação de
 * verdade, dentro de um roteador de verdade:
 *
 *  1. o estouro vira aviso e o roteador continua vivo — provado por uma
 *     navegação que leva a uma tela sã, que desenha;
 *  2. o aviso LIMPA ao trocar de rota. Fronteira do React não se reseta
 *     sozinha: sem isso, a pessoa levaria o mesmo aviso para a tela seguinte —
 *     uma saída que não sai;
 *  3. os botões do aviso são a saída, e não enfeite;
 *  4. A FIAÇÃO: com uma tela do roteador REAL estourando, `AppRoutes` — o que
 *     o `App` monta — segura o estouro e ainda navega. Sem este caso, os três
 *     acima provariam que o componente funciona, não que ele protege alguma
 *     coisa;
 *  5. e a metade que impede complacência: tela sã desenha, e o aviso não
 *     aparece por nada.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { FronteiraDaTela } from '../FronteiraDaTela';

/*
  A tela do endereço inexistente é PÚBLICA e entra no pacote inicial (importada
  direto por `gsRoutes`), então serve de cobaia sem sessão e sem `import()`
  pendurado. Fazê-la estourar é o estouro real de uma tela do roteador.
*/
vi.mock('@/pages/gs/NaoEncontradaPage', () => ({
  default: function NaoEncontradaQueEstoura(): never {
    throw new Error('campo nulo percorrido');
  },
}));

afterEach(() => {
  cleanup();
});

function TelaQueEstoura(): never {
  throw new Error('campo nulo percorrido');
}

function TelaSa() {
  return <p>tela sã no ar</p>;
}

let navegar: ReturnType<typeof useNavigate>;

/** O arranjo mínimo: roteador de verdade, fronteira por dentro, chave da navegação. */
function Moldura() {
  const ir = useNavigate();
  const { key } = useLocation();
  navegar = ir;
  return (
    <FronteiraDaTela chave={key} aoInicio={() => ir('/sa')} aoVoltar={() => ir(-1)}>
      {/* Some quando a fronteira assume — é assim que o teste sabe que ela assumiu. */}
      <span data-tela-viva="" />
      <Routes>
        <Route path="/quebrada" element={<TelaQueEstoura />} />
        <Route path="/sa" element={<TelaSa />} />
      </Routes>
    </FronteiraDaTela>
  );
}

function Sistema({ inicial = '/quebrada' }: { inicial?: string }) {
  return (
    <MemoryRouter initialEntries={[inicial]}>
      <Moldura />
    </MemoryRouter>
  );
}

describe('a tela que estoura não derruba o sistema', () => {
  it('1. o estouro vira aviso, e o roteador continua vivo — dá para chegar a uma tela sã', () => {
    render(<Sistema />);

    expect(screen.getByRole('alert').textContent).toContain('Esta tela falhou.');
    expect(document.querySelector('[data-tela-viva]')).toBeNull();

    act(() => { navegar('/sa'); });
    expect(screen.getByText('tela sã no ar')).toBeTruthy();
  });

  it('2. sem limpar ao navegar, a saída não sairia: a chave nova esquece o erro', () => {
    render(<Sistema />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => { navegar('/sa'); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-tela-viva]')).toBeTruthy();
  });

  it('3. os botões do aviso são a saída — "Ir para o início" e "Voltar" navegam', () => {
    render(<Sistema />);
    fireEvent.click(screen.getByRole('button', { name: 'Ir para o início' }));
    expect(screen.getByText('tela sã no ar')).toBeTruthy();

    cleanup();
    render(<Sistema inicial="/sa" />);
    act(() => { navegar('/quebrada'); });
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByText('tela sã no ar')).toBeTruthy();
  });

  it('4. e é `AppRoutes` quem a monta: uma tela do roteador REAL estoura e o sistema segue', async () => {
    const { AppRoutes } = await import('..');
    render(
      <MemoryRouter initialEntries={['/endereco/que/nao/existe']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    // A tela real estourou, e o que apareceu foi a fronteira DA TELA — a que
    // tem saída —, não o cartão de página cheia da fronteira geral.
    const aviso = screen.getByRole('alert');
    expect(aviso.textContent).toContain('Esta tela falhou.');
    expect(aviso.getAttribute('data-tela-estourou')).toBe('');

    // E há saída: clicar leva embora e o aviso some.
    fireEvent.click(screen.getByRole('button', { name: 'Ir para o início' }));
    expect(screen.queryByText('Esta tela falhou.')).toBeNull();
  });

  it('5. tela sã continua desenhando, e o aviso não aparece por nada', () => {
    render(<Sistema inicial="/sa" />);
    expect(screen.getByText('tela sã no ar')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('[data-tela-viva]')).toBeTruthy();
  });
});
