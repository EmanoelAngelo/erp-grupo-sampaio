/**
 * ============================================================================
 * CADA TELA NO SEU PEDAÇO — e o PDV no pacote inicial (GAP-PRD-210)
 * ============================================================================
 *
 * O roteador importava as setenta telas de uma vez, e o build saía num pacote
 * único de 1,7 MB. Agora cada tela é um `import()` (`src/router/telas.tsx`),
 * com quatro exceções de propósito: as duas portas de login, o PDV — que vende
 * sem rede — e o endereço inexistente.
 *
 * Este arquivo cobra:
 *   - que o roteador não volte a importar página estaticamente, fora das
 *     quatro (um import estático puxa a tela de volta para o pacote inicial,
 *     em silêncio);
 *   - que toda outra rota abra por tela sob demanda;
 *   - o comportamento da fábrica: carregando acessível, falha de rede vira
 *     aviso, erro de render continua subindo, tela carregada não pisca e não
 *     remonta.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Component, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteObject } from 'react-router-dom';
import { gsRoutes } from '../gsRoutes';
import { Protected } from '../Protected';
import { ehTelaSobDemanda, telaSobDemanda } from '../telaSobDemanda';
import LoginPage from '@/pages/gs/LoginPage';
import OficinaLoginPage from '@/pages/gs/OficinaLoginPage';
import PdvPage from '@/pages/gs/PdvPage';
import NaoEncontradaPage from '@/pages/gs/NaoEncontradaPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fonte = (arquivo: string) =>
  readFileSync(resolve(process.cwd(), 'src/router', arquivo), 'utf8');

/** A tela que a rota desenha, por baixo do guarda. */
function telaDaRota(rota: RouteObject): unknown {
  const elemento = rota.element as ReactElement<{ children?: ReactElement }> | undefined;
  if (!elemento) return undefined;
  if (elemento.type === Protected) return elemento.props.children?.type;
  return elemento.type;
}

const DO_PACOTE_INICIAL = new Map<unknown, string>([
  [LoginPage, 'LoginPage'],
  [OficinaLoginPage, 'OficinaLoginPage'],
  [PdvPage, 'PdvPage'],
  [NaoEncontradaPage, 'NaoEncontradaPage'],
]);

describe('o roteador', () => {
  it('importa estaticamente só as quatro telas do pacote inicial', () => {
    const estaticas = [...fonte('gsRoutes.tsx').matchAll(/from '@\/pages\/gs\/([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(estaticas.sort()).toEqual(['LoginPage', 'NaoEncontradaPage', 'OficinaLoginPage', 'PdvPage']);
  });

  it('e telas.tsx não importa página nenhuma estaticamente — só por import()', () => {
    expect(fonte('telas.tsx')).not.toMatch(/^import .* from '@\/pages\//m);
  });

  it('toda rota fora das quatro abre por tela sob demanda', () => {
    const estaticasNoRoteador: string[] = [];
    const semDemanda: string[] = [];
    let sobDemanda = 0;
    for (const rota of gsRoutes) {
      const tela = telaDaRota(rota);
      if (DO_PACOTE_INICIAL.has(tela)) estaticasNoRoteador.push(rota.path ?? '');
      else if (ehTelaSobDemanda(tela)) sobDemanda += 1;
      else semDemanda.push(rota.path ?? '(sem caminho)');
    }
    expect(semDemanda, 'rota com tela importada estaticamente fora das quatro').toEqual([]);
    expect(sobDemanda).toBeGreaterThan(80);
    expect(estaticasNoRoteador.sort()).toEqual(['*', '/login', '/oficina/login', '/pdv']);
  });

  it('o PDV é a tela do pacote inicial em /pdv — ele vende sem rede', () => {
    const pdv = gsRoutes.find((r) => r.path === '/pdv');
    expect(telaDaRota(pdv!)).toBe(PdvPage);
  });
});

function adiado<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((ok, falha) => {
    resolver = ok;
    rejeitar = falha;
  });
  return { promessa, resolver, rejeitar };
}

class FronteiraDeTeste extends Component<{ children: ReactNode; aoPegar: (erro: Error) => void }, { caiu: boolean }> {
  state = { caiu: false };
  static getDerivedStateFromError() {
    return { caiu: true };
  }
  componentDidCatch(erro: Error) {
    this.props.aoPegar(erro);
  }
  render() {
    return this.state.caiu ? <p>A FRONTEIRA PEGOU</p> : this.props.children;
  }
}

describe('a tela sob demanda', () => {
  it('enquanto o pedaço não chega, mostra um carregando que o leitor de tela anuncia', async () => {
    const pedaco = adiado<{ default: ComponentType }>();
    const Tela = telaSobDemanda('TelaDeTeste', () => pedaco.promessa);
    render(<Tela />);

    const aviso = screen.getByRole('status');
    expect(aviso.textContent).toMatch(/Carregando a tela/);
    expect(aviso.getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      pedaco.resolver({ default: () => <h1>Tela de teste</h1> });
    });
    expect(await screen.findByRole('heading', { name: 'Tela de teste' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pedaço que não chega vira aviso com o caminho de volta, e não tela em branco', async () => {
    const erroNoConsole = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Tela = telaSobDemanda('TelaQueNaoChega', () =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    );
    render(<Tela />);

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/Esta tela não carregou/);
    expect(screen.getByRole('button', { name: 'Recarregar a página' })).toBeTruthy();
    expect(erroNoConsole.mock.calls.some((c) => String(c[0]).includes('TelaQueNaoChega'))).toBe(true);
  });

  it('erro de RENDER da tela continua subindo para a fronteira — a fábrica só troca a falha de carregar', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pegos: string[] = [];
    const Estoura = () => {
      throw new Error('a tela estourou ao abrir');
    };
    const Tela = telaSobDemanda('TelaQueEstoura', async () => ({ default: Estoura }));
    render(
      <FronteiraDeTeste aoPegar={(e) => pegos.push(e.message)}>
        <Tela />
      </FronteiraDeTeste>,
    );

    expect(await screen.findByText('A FRONTEIRA PEGOU')).toBeTruthy();
    expect(pegos).toContain('a tela estourou ao abrir');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tela já carregada desenha na hora, sem piscar o carregando', async () => {
    const Tela = telaSobDemanda('TelaPronta', async () => ({ default: () => <p>pronta</p> }));
    await Tela.carregar();
    render(<Tela />);
    // Sem esperar nada: o módulo já estava na mão.
    expect(screen.getByText('pronta')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('o estado da tela sobrevive ao pai redesenhar — o carrinho não some', async () => {
    function Contador({ rotulo }: { rotulo: string }) {
      const [n, setN] = useState(0);
      return <button onClick={() => setN(n + 1)}>{`${rotulo}: ${n}`}</button>;
    }
    const Tela = telaSobDemanda('Contador', async () => ({ default: Contador }));
    const { rerender } = render(<Tela rotulo="a" />);

    const botao = await screen.findByRole('button', { name: 'a: 0' });
    fireEvent.click(botao);
    fireEvent.click(botao);
    rerender(<Tela rotulo="b" />);

    expect(screen.getByRole('button', { name: 'b: 2' })).toBeTruthy();
  });

  it('carregar duas vezes baixa uma; falha não fica guardada — a próxima tentativa busca de novo', async () => {
    const umaVez = vi.fn(async () => ({ default: () => null }));
    const Tela = telaSobDemanda('UmaVez', umaVez);
    await Promise.all([Tela.carregar(), Tela.carregar()]);
    expect(umaVez).toHaveBeenCalledTimes(1);

    const instavel = vi
      .fn<() => Promise<{ default: ComponentType }>>()
      .mockRejectedValueOnce(new Error('a rede caiu'))
      .mockResolvedValueOnce({ default: () => null });
    const Instavel = telaSobDemanda('Instavel', instavel);
    await expect(Instavel.carregar()).rejects.toThrow('a rede caiu');
    await Instavel.carregar();
    expect(instavel).toHaveBeenCalledTimes(2);
  });

  it('export nomeado: a tela é a exportação pedida do módulo', async () => {
    const Tela = telaSobDemanda(
      'Nomeada',
      async () => ({ Outra: () => <p>outra</p>, Nomeada: () => <p>nomeada</p> }),
      'Nomeada',
    );
    render(<Tela />);
    expect(await screen.findByText('nomeada')).toBeTruthy();
  });

  it('módulo que chega sem a exportação derruba carregar() com o nome da tela', async () => {
    const Tela = telaSobDemanda(
      'SemExport',
      async () => ({ default: undefined as unknown as ComponentType }),
    );
    await expect(Tela.carregar()).rejects.toThrow(/SemExport não exporta "default"/);
  });
});
