/**
 * ============================================================================
 * A PORTA DA TELA FECHOU; A DO BOTÃO NÃO — inventário (V02-EST-004)
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * A rodada anterior consertou o ALCANCE da tela: o atendente saiu de
 * `/sistema/estoque/inventario` e o estoquista entrou, porque contar prateleira
 * é o trabalho dele. Só que aplicar e cancelar são gerente-only no servidor —
 * `requireProfile(req, 'gerente_loja', 'gerente_oficina')` nas duas rotas
 * (`POST /core/inventory-counts/:id/apply` e `.../cancel`) — e os botões
 * "Aplicar acerto" e "Cancelar contagem" eram renderizados SEM nenhuma
 * condição de perfil.
 *
 * O efeito no corredor: o estoquista conta a prateleira inteira, digita o
 * motivo, clica em Aplicar e lê "Falha ao aplicar o acerto." — que é o 403 do
 * servidor traduzido para uma frase que não explica nada. É a mesma "porta
 * desenhada que não abre" que a rodada foi consertar, um nível abaixo: no
 * botão em vez da tela.
 *
 * ## A FORMA ESCOLHIDA, E POR QUÊ — o botão SOME
 *
 * A casa tem precedente para as duas formas, e elas não são intercambiáveis:
 *
 *   BOTÃO VISÍVEL COM AVISO   é o de `DevolucoesPage`, e ele só existe porque
 *                             existe CAMINHO: o servidor recusa com
 *                             `CORE_CANCEL_NEEDS_AUTHORIZATION`, o gestor
 *                             assina ali mesmo e a ação segue. Mostrar o botão
 *                             é oferecer uma saída real.
 *   BOTÃO QUE NÃO EXISTE      é o dos vizinhos DESTE módulo:
 *                             `MovimentacoesEstoquePage` (`podeLancar &&
 *                             <LancamentoManual/>`) e `EntradaNotasPage`
 *                             (`estorna`, `manifesta`) — "a tela não promete o
 *                             que o servidor nega", escrito lá com essas
 *                             palavras.
 *
 * Aplicar inventário NÃO tem caminho de liberação: `aplicar_inventario` não
 * está em `RESTRICTED_ACTIONS` (as cinco ações são desconto_acima_limite,
 * sangria_especial, cancelar_venda, devolver_venda e reabrir_caixa), então não
 * há bilhete a pedir e o diálogo do gestor não teria o que fazer. Mostrar o
 * botão desabilitado seria desenhar uma porta e escrever "não abre" nela.
 *
 * Some — e no lugar dele a tela DIZ quem aplica. Sumir calado deixaria o
 * estoquista com a contagem pronta e sem saber o que fazer com ela, que é o
 * segundo defeito do primeiro. A contagem, essa, continua inteira: contar é o
 * trabalho DELE, e o campo de contagem não é tocado por este recorte.
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *   - tire o `podeFecharAContagem` dos dois botões e o caso do estoquista fica
 *     vermelho: ele volta a ver Aplicar/Cancelar e a tomar 403 depois do
 *     trabalho feito;
 *   - troque o recorte por um que exclua o estoquista do CAMPO de contagem e o
 *     caso da contagem cai: a tela passaria a negar o trabalho dele;
 *   - tire a frase que nomeia quem aplica e o caso do aviso cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import InventarioPage from '../InventarioPage';

const CONTAGEM = {
  id: 'c-1',
  number: 9,
  status: 'aberta',
  scope_note: 'Corredor 3',
  opened_at: '2026-08-25T09:00:00.000Z',
  applied_at: null,
  apply_reason: null,
  cancel_reason: null,
  items: [
    {
      id: 'i-1',
      product_id: 'p-1',
      name: 'Refrigerante Cola 2L',
      internal_code: 'REF-01',
      barcode: null,
      expected_quantity: 10,
      counted_quantity: null,
      counted_by_name: null,
    },
  ],
  resumo: { total: 1, contados: 0, pendentes: 1, divergentes: 0, sobra: 0, falta: 0 },
};

const TAXONOMIA = { categories: [], brands: [], orphans: { categories: [], subcategories: [], brands: [] } };

/** Contagens gravadas — o gesto que é do estoquista e não pode sumir. */
let contagens: Record<string, unknown>[] = [];

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const json = (corpo: unknown, status = 200) =>
      new Response(JSON.stringify(corpo), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/taxonomy')) return json(TAXONOMIA);
    if (alvo.includes('/items') && metodo === 'POST') {
      contagens.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({
        ...CONTAGEM,
        items: [{ ...CONTAGEM.items[0], counted_quantity: 8, counted_by_name: 'Estela Estoque' }],
        resumo: { total: 1, contados: 1, pendentes: 0, divergentes: 1, sobra: 0, falta: 1 },
      });
    }
    if (alvo.match(/\/core\/inventory-counts\/c-1$/)) return json(CONTAGEM);
    if (alvo.includes('/core/inventory-counts')) return json({ items: [CONTAGEM] });
    return json({ items: [] });
  });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'quem', displayName: 'Quem Conta', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da porta do botão do inventário',
  );
}

beforeEach(() => {
  localStorage.clear();
  contagens = [];
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Abre a contagem existente — é dentro dela que os botões vivem. */
async function abrirAContagem(profileCode: string) {
  entrarComo(profileCode);
  render(
    <MemoryRouter>
      <InventarioPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir' }));
  await screen.findByText('Refrigerante Cola 2L');
}

const botaoAplicar = () => screen.queryByRole('button', { name: 'Aplicar acerto' });
const botaoCancelar = () => screen.queryByRole('button', { name: 'Cancelar contagem' });

describe('quem APLICA o acerto vê os botões — e é o mesmo recorte da rota', () => {
  it('o gerente de loja vê Aplicar, Cancelar e o motivo obrigatório', async () => {
    await abrirAContagem('gerente_loja');
    expect(botaoAplicar()).toBeTruthy();
    expect(botaoCancelar()).toBeTruthy();
    expect(screen.getByLabelText(/Motivo do acerto/)).toBeTruthy();
  });

  it('o gerente de oficina também — a bancada guarda peça e conta prateleira', async () => {
    await abrirAContagem('gerente_oficina');
    expect(botaoAplicar()).toBeTruthy();
    expect(botaoCancelar()).toBeTruthy();
  });

  it('o dono do grupo passa por cima da lista, igual ao requireProfile', async () => {
    await abrirAContagem('admin_geral');
    expect(botaoAplicar()).toBeTruthy();
  });
});

describe('o ESTOQUISTA conta a prateleira e NÃO toma 403 depois do trabalho feito', () => {
  it('os dois botões que o servidor nega não são desenhados', async () => {
    await abrirAContagem('estoquista');
    /*
      O 403 chegava DEPOIS da contagem inteira, com a frase genérica "Falha ao
      aplicar o acerto." — a tela prometia e o servidor negava.
    */
    expect(botaoAplicar()).toBeNull();
    expect(botaoCancelar()).toBeNull();
    // E o campo de motivo vai junto: ele só serve ao acerto que ele não aplica.
    expect(screen.queryByLabelText(/Motivo do acerto/)).toBeNull();
  });

  it('a tela DIZ quem aplica — sumir calado deixaria a contagem sem destino', async () => {
    await abrirAContagem('estoquista');
    expect(screen.getByText(/aplicar o acerto é de quem responde pela loja|gerente/i)).toBeTruthy();
  });

  it('CONTAR continua sendo dele: o campo grava, e o recorte não o toca', async () => {
    await abrirAContagem('estoquista');

    const campo = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(campo, { target: { value: '8' } });
    fireEvent.blur(campo);

    await waitFor(() => expect(contagens).toHaveLength(1));
    expect(contagens[0].countedQuantity).toBe(8);
    // E quem contou aparece: a contagem dele conta, mesmo sem o acerto.
    await screen.findByText('Estela Estoque');
  });
});
