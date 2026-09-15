/**
 * TURNOS ANTERIORES NA TELA DE CAIXA — a metade de tela que a rota esperava.
 *
 * `GET /core/cash/sessions` devolve o histórico de turnos com quem abriu e
 * quem fechou PELO NOME, e a diferença de cada fechamento — é a resposta de
 * "de quem era o caixa que fechou faltando 40?". O comentário da rota afirma
 * que a tela de Caixa da gestão o consome; a auditoria integral mediu que
 * NENHUMA tela o chamava. Este arquivo fixa a metade que faltava.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire a seção e o histórico volta a ser rota sem tela: a pergunta do
 *     turno que fechou com falta continua sem resposta na gestão;
 *   - pinte a diferença sempre da mesma cor e a falta de R$ 40,00 vira um
 *     número igual aos outros — quem bate o olho não vê o problema;
 *   - ignore o limite e a tela pede o histórico inteiro de uma vez, que é
 *     exatamente o que o teto do servidor existe para recusar.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { formatCents } from '@/components/gs/format';
import { dataHoraBR } from '@/lib/datas';
import { CaixaPage } from '../OperacaoPages';

/** Um turno como `listSessions` devolve: a sessão + os dois nomes. */
function turno(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    opening_cents: 10000,
    expected_cents: 52000,
    counted_cents: 48000,
    difference_cents: -4000,
    status: 'closed',
    opened_at: '2026-08-27T11:00:00.000Z',
    closed_at: '2026-08-27T21:30:00.000Z',
    opened_by_name: 'Carlos Caixa',
    closed_by_name: 'Gerente Gilda',
    ...sobrescreve,
  };
}

const COM_FALTA = turno();
const NO_ZERO = turno({
  id: 's-2',
  expected_cents: 30000,
  counted_cents: 30000,
  difference_cents: 0,
  opened_at: '2026-08-26T11:00:00.000Z',
  closed_at: '2026-08-26T20:00:00.000Z',
  opened_by_name: 'Alice Atendente',
  closed_by_name: 'Alice Atendente',
});
const AINDA_ABERTO = turno({
  id: 's-3',
  expected_cents: null,
  counted_cents: null,
  difference_cents: null,
  status: 'open',
  opened_at: '2026-08-28T11:05:00.000Z',
  closed_at: null,
  opened_by_name: 'Beto Balcão',
  closed_by_name: null,
});

/** O que o servidor tem; a rota corta pelo `limit`, como a real. */
let turnosNoServidor: ReturnType<typeof turno>[] = [];
/** As URLs com que a tela pediu `/core/cash/sessions`. */
let pedidosDeTurnos: string[] = [];

function servidor() {
  return vi.fn(async (url: string) => {
    const alvo = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/cash/sessions')) {
      pedidosDeTurnos.push(alvo);
      const limite = Number(new URL(alvo, 'http://x').searchParams.get('limit') ?? 50);
      return json({ items: turnosNoServidor.slice(0, limite) });
    }

    // A tela também pergunta pelo caixa aberto; fechado é `session: null`.
    if (alvo.includes('/core/cash/open')) {
      return json({ session: null, cashWithdrawalLimitCents: null });
    }

    return json({ items: [] });
  });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste dos turnos anteriores',
  );
}

function montar() {
  render(
    <MemoryRouter>
      <CaixaPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  turnosNoServidor = [AINDA_ABERTO, COM_FALTA, NO_ZERO];
  pedidosDeTurnos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a seção Turnos anteriores', () => {
  it('lista o que a API devolve: quem abriu, quem fechou, os valores e o quando', async () => {
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('Turnos anteriores');

    // Os nomes — a razão de ser da rota: gaveta tem dono, não número.
    const linhaComFalta = (await screen.findByText('Gerente Gilda')).closest('tr');
    expect(linhaComFalta).toBeTruthy();
    expect(linhaComFalta!.textContent).toContain('Carlos Caixa');
    expect(linhaComFalta!.textContent).toContain(formatCents(52000));
    expect(linhaComFalta!.textContent).toContain(formatCents(48000));
    expect(linhaComFalta!.textContent).toContain(formatCents(-4000));
    // `dataHoraBR`, e não a string literal: a tela mostra o relógio da LOJA.
    expect(linhaComFalta!.textContent).toContain(dataHoraBR('2026-08-27T11:00:00.000Z'));
    expect(linhaComFalta!.textContent).toContain(dataHoraBR('2026-08-27T21:30:00.000Z'));

    // Turno ainda aberto não inventa contagem nem fechador.
    const linhaAberta = screen.getByText('Beto Balcão').closest('tr');
    expect(linhaAberta!.textContent).toContain('ainda aberto');
  });

  it('a diferença fica em vermelho quando não é zero — e SÓ quando não é', async () => {
    entrarComo('gerente_loja');
    montar();
    // "Turnos anteriores" é o título do cartão, desenhado antes de
    // `/core/cash/sessions` responder; as células da diferença só existem com
    // a lista. Quem fechou o turno com falta vem na MESMA resposta.
    await screen.findByText('Gerente Gilda');

    // Comparação pelo `textContent` CRU: `formatCents` separa "R$" do número
    // com espaço rígido, e o normalizador do getByText o achataria.
    const celula = (texto: string) => (_: string, el: Element | null) =>
      el?.tagName === 'SPAN' && el.textContent === texto;

    // Faltaram R$ 40,00: o número precisa gritar.
    const falta = screen.getByText(celula(formatCents(-4000)));
    expect(falta.className).toContain('gs-danger');

    // Bateu no zero: pintar de vermelho ensinaria o olho a ignorar a cor.
    const zero = screen.getByText(celula(formatCents(0)));
    expect(zero.className).not.toContain('gs-danger');
  });

  it('pede com limite, e "Mostrar mais" alarga o pedido em vez de trazer tudo', async () => {
    turnosNoServidor = Array.from({ length: 13 }, (_, i) =>
      turno({
        id: `s-pag-${i + 1}`,
        opened_by_name: `Pessoa ${i + 1}`,
        // Nome DIFERENTE do de quem abriu: com os dois iguais, `findByText`
        // acharia duas células e o teste quebraria pelo motivo errado.
        closed_by_name: `Conferente ${i + 1}`,
      }),
    );
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('Pessoa 10');
    // O primeiro pedido é comedido: o histórico completo é caso de exportação,
    // não de tela — o teto do servidor diz o mesmo.
    expect(pedidosDeTurnos[0]).toContain('limit=10');
    expect(screen.queryByText('Pessoa 11')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais' }));

    await screen.findByText('Pessoa 13');
    expect(pedidosDeTurnos[pedidosDeTurnos.length - 1]).toContain('limit=20');
    // Treze turnos no servidor, vinte pedidos: acabou o histórico, some o botão.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mostrar mais' })).toBeNull(),
    );
  });

  it('com a lista vazia diz que não há turno fechado, em vez de uma tabela nua', async () => {
    turnosNoServidor = [];
    entrarComo('gerente_loja');
    montar();

    await screen.findByText('Turnos anteriores');
    await screen.findByText('Nenhum turno registrado');
  });
});
