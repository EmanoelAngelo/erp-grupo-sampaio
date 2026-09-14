/**
 * ============================================================================
 * GRUPO SEM FILHO VISÍVEL SOME DO MENU — título não é porta
 * ============================================================================
 *
 * A auditoria integral pôs `profiles` nos cinco filhos do Fiscal, cada um
 * citando o guarda real da própria rota — e nenhum dos cinco aceita o
 * estoquista ou o atendente. O GRUPO, porém, não declara perfil nenhum: o
 * título "Fiscal" continuava na coluna dos dois, expandia, e mostrava o nada.
 * Um título que abre para o vazio não é menu — é convite a chamado ("cadê o
 * fiscal que sumiu?"), a mesma espécie de defeito das portas que batiam na
 * cara, só que uma camada acima.
 *
 * O conserto é ESTRUTURAL, no `AppShell`, e não um `profiles` escrito à mão no
 * grupo: a lista dos cinco filhos já diz quem vê o quê, e repeti-la no grupo
 * criaria uma segunda verdade que envelhece sozinha (foi assim que o
 * comentário errado da rodada 27 nasceu). Grupo sem NENHUM filho visível para
 * o perfil corrente simplesmente não renderiza.
 *
 * ## Como cada caso fica VERMELHO (medido antes do conserto)
 *
 *   - os dois casos negativos falhavam ANTES do conserto: o botão "Fiscal"
 *     estava lá, vazio, para estoquista e atendente;
 *   - o caso do gerente pega a tesoura: se o filtro novo esconder demais, o
 *     grupo some de quem tem os filhos;
 *   - o caso do contador pega o limiar: UM filho visível basta, e o Fiscal é
 *     o único grupo do menu dele;
 *   - o caso das Configurações do estoquista prova que o filtro não virou
 *     tesoura nos grupos em que ele ainda tem o que clicar.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';

/**
 * A sessão é dublada no hook, e não no `localStorage` — mesma decisão, e mesmo
 * motivo, de `menuPorPerfil.test.tsx`: imitar o formato exato do servidor
 * amarraria o teste do MENU à hidratação do cliente HTTP.
 */
vi.mock('@/hooks/useSession', () => ({
  useSession: () => sessaoAtual,
  useProfile: () => sessaoAtual?.user.profileCode ?? null,
  useHasProfile: () => false,
}));

let sessaoAtual: {
  user: { id: string; displayName: string; profileCode: string };
  company: { id: string; tradeName: string };
  companies: { id: string; tradeName: string; profileCode: string }[];
} | null = null;

function entrarComo(profileCode: string): void {
  sessaoAtual = {
    user: { id: 'u1', displayName: 'Fulano', profileCode },
    company: { id: 'c1', tradeName: 'Sampaio Centro' },
    companies: [{ id: 'c1', tradeName: 'Sampaio Centro', profileCode }],
  };
}

function abrirCasca(): void {
  render(
    <MemoryRouter>
      <AppShell>
        <p>PAGINA</p>
      </AppShell>
    </MemoryRouter>,
  );
}

/** O botão do grupo, ou nulo — grupo escondido não deixa botão. */
function botaoDoGrupo(nome: RegExp): HTMLElement | null {
  return screen.queryByRole('button', { name: nome });
}

beforeEach(() => {
  sessaoAtual = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('o título Fiscal não aparece para quem não veria filho nenhum', () => {
  it('o estoquista NÃO vê o grupo Fiscal — os cinco filhos o excluem', () => {
    entrarComo('estoquista');
    abrirCasca();
    expect(botaoDoGrupo(/Fiscal/)).toBeNull();
  });

  it('o atendente NÃO vê o grupo Fiscal', () => {
    entrarComo('atendente');
    abrirCasca();
    expect(botaoDoGrupo(/Fiscal/)).toBeNull();
  });
});

describe('o filtro novo não é tesoura', () => {
  it('o gerente de loja vê o Fiscal com os filhos DELE — e sem o A1, que é dos donos', () => {
    entrarComo('gerente_loja');
    abrirCasca();

    const grupo = botaoDoGrupo(/Fiscal/);
    expect(grupo).toBeTruthy();
    fireEvent.click(grupo!);

    expect(screen.getByText('Documentos fiscais')).toBeTruthy();
    expect(screen.getByText('Inutilização de numeração')).toBeTruthy();
    expect(screen.getByText('Configuração fiscal')).toBeTruthy();
    expect(screen.getByText('Fechamento do contador')).toBeTruthy();
    // O recorte por filho continua valendo DENTRO do grupo que ficou:
    // `requireProfile(req)` sem perfil extra nas rotas do A1 = só os donos.
    expect(screen.queryByText('Certificado A1')).toBeNull();
  });

  it('o contador continua vendo o Fiscal: UM filho visível basta', () => {
    // O limiar é "pelo menos um", não "todos": para o contador o grupo tem um
    // único item — que é a única tela do sistema que ele alcança. Se este
    // caso quebrar, o menu dele fica sem NADA.
    entrarComo('contador');
    abrirCasca();

    const grupo = botaoDoGrupo(/Fiscal/);
    expect(grupo).toBeTruthy();
    fireEvent.click(grupo!);

    expect(screen.getByText('Fechamento do contador')).toBeTruthy();
    expect(screen.queryByText('Documentos fiscais')).toBeNull();
  });

  it('grupo em que o estoquista ainda tem o que clicar continua aparecendo', () => {
    entrarComo('estoquista');
    abrirCasca();

    // Configurações perdeu "Empresas do grupo" para ele, mas sobra tela: o
    // grupo fica, com o que ele pode abrir dentro.
    const grupo = botaoDoGrupo(/Configurações/);
    expect(grupo).toBeTruthy();
    fireEvent.click(grupo!);

    expect(screen.getByText('Impressoras')).toBeTruthy();
    expect(screen.getByText('Política do balcão')).toBeTruthy();
  });
});
