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
  recarregou = 0;
});

function TelaQueEstoura(): never {
  throw new Error('campo nulo percorrido');
}

function TelaSa() {
  return <p>tela sã no ar</p>;
}

let navegar: ReturnType<typeof useNavigate>;
/** Quantas vezes o aviso mandou recarregar — a saída de último caso. */
let recarregou = 0;

/**
 * O arranjo mínimo: roteador de verdade, fronteira por dentro, chave da
 * navegação. `podeVoltar` e `inicioLevaEmbora` são as duas conferências que
 * decidem quais portas o aviso mostra — aqui vêm do roteador de verdade, como
 * em `AppRoutes`.
 */
function Moldura({ casa = '/sa' }: { casa?: string }) {
  const ir = useNavigate();
  const { key, pathname } = useLocation();
  navegar = ir;
  return (
    <FronteiraDaTela
      chave={key}
      aoInicio={() => ir(casa)}
      aoVoltar={() => ir(-1)}
      aoRecarregar={() => { recarregou += 1; }}
      podeVoltar={key !== 'default'}
      inicioLevaEmbora={() => casa !== pathname}
    >
      {/* Some quando a fronteira assume — é assim que o teste sabe que ela assumiu. */}
      <span data-tela-viva="" />
      <Routes>
        <Route path="/quebrada" element={<TelaQueEstoura />} />
        <Route path="/sa" element={<TelaSa />} />
      </Routes>
    </FronteiraDaTela>
  );
}

function Sistema({ inicial = '/quebrada', casa = '/sa' }: { inicial?: string; casa?: string }) {
  return (
    <MemoryRouter initialEntries={[inicial]}>
      <Moldura casa={casa} />
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

// ============================================================================
// O AVISO NÃO PROMETE O QUE NÃO ENTREGA
// ============================================================================

/**
 * O DEFEITO: a frase dizia "o caixa, o menu e as outras telas seguem abrindo".
 *
 * O MENU não segue — cada tela desenha o próprio `AppShell`, e o cabeçalho
 * deste mesmo arquivo de código diz que preservá-lo NÃO é promessa. E o CAIXA
 * não segue quando o caixa é a tela que estourou: a casa do
 * `operador_caixa_loja` é `/pdv`, então "Ir para o início" redesenharia a
 * mesma tela quebrada, e "Voltar" num PDV aberto direto não tem para onde ir.
 * Duas portas desenhadas que não abrem, embaixo de uma frase que garante as
 * duas.
 */
describe('o aviso mostra só a porta que abre', () => {
  it('não promete o menu — e diz que ele caiu com a tela', () => {
    render(<Sistema />);
    const aviso = screen.getByRole('alert');

    expect(aviso.textContent).not.toContain('o menu e as outras telas seguem');
    expect(aviso.textContent).toMatch(/menu não sobrevive/i);
    expect(aviso.textContent).toMatch(/OUTRAS telas do sistema continuam abrindo/i);
  });

  it('com o PDV estourando e sem página anterior, não oferece porta que volta ao PDV', () => {
    // A casa do perfil É a tela quebrada: é o caixa do balcão, que liga o
    // computador direto no endereço do PDV.
    render(<Sistema inicial="/quebrada" casa="/quebrada" />);

    expect(screen.queryByRole('button', { name: 'Ir para o início' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Voltar' })).toBeNull();

    // Sobra a única saída que existe — dita pelo que ela é.
    const aviso = screen.getByRole('alert');
    expect(aviso.textContent).toMatch(/não há página anterior/i);
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar esta tela' }));
    expect(recarregou).toBe(1);
  });

  it('quando a casa é outra tela, "Ir para o início" volta a aparecer', () => {
    render(<Sistema inicial="/quebrada" casa="/sa" />);
    expect(screen.getByRole('button', { name: 'Ir para o início' })).toBeTruthy();
    // E o recarregar NÃO aparece: ele é a saída de quem não tem outra.
    expect(screen.queryByRole('button', { name: 'Recarregar esta tela' })).toBeNull();
  });

  it('"Voltar" aparece quando há página anterior de verdade', () => {
    render(<Sistema inicial="/sa" casa="/quebrada" />);
    act(() => { navegar('/quebrada'); });

    expect(screen.getByRole('alert')).toBeTruthy();
    // A casa é a própria tela quebrada, então a única porta é o histórico.
    expect(screen.queryByRole('button', { name: 'Ir para o início' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByText('tela sã no ar')).toBeTruthy();
  });

  it('o aviso deixa um código para o telefone — e ele some ao sair da tela', () => {
    render(<Sistema />);
    const codigo = screen.getByText(/Código para o suporte:/);
    expect(codigo.textContent).toMatch(/Código para o suporte: err-[0-9a-z]+$/);

    // Ao navegar, o erro é esquecido: o código não pode sobrar na tela seguinte.
    act(() => { navegar('/sa'); });
    expect(screen.queryByText(/Código para o suporte:/)).toBeNull();
  });
});
