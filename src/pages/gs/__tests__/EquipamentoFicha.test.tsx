/**
 * A FICHA DA MÁQUINA na tela — e o dia que ela imprime.
 *
 * ## O defeito que só a tela mostra
 *
 * Data de calendário e instante não se imprimem do mesmo jeito.
 * `new Date('2026-08-12')` é meia-noite UTC, e o Brasil é UTC−3: o navegador
 * imprime **11/08**. Foi assim que a ficha apareceu na conferência desta
 * rodada — máquina com entrada em 12/08 dizendo "Entrou em 11/08", montagem
 * informada em 01/08 aparecendo como 31/07.
 *
 * Nenhum teste de servidor alcança isso: lá a data está certa, guardada como
 * `AAAA-MM-DD`. O erro nasce no `toLocaleDateString` do navegador, e por isso
 * este arquivo monta a tela e lê o que ela escreveu.
 *
 * `created_at` de evento e de OS é OUTRA coisa — é instante, e aí converter
 * para o fuso de quem lê é justamente o certo. A tela tem de saber distinguir
 * os dois, e é isso que se prova aqui.
 *
 * ## O que mais este arquivo segura
 *
 *   - o histórico append-only aparecendo (era escrita sem leitor desde a
 *     rodada da plaquinha — a auditoria mediu seis escritores e zero leitores);
 *   - o `public_token` NÃO aparecendo (a ficha é interna, mas o token abre a
 *     página pública do equipamento para qualquer um que o tenha);
 *   - a ficha completada mandando o patch ESTREITO, e não o cadastro inteiro.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EquipamentoFichaPage from '../EquipamentoFichaPage';

const EQUIP_ID = 'eq-1';

let ficha: Record<string, unknown>;
let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> }[];
/** A rota da equipe é de gestão: quem não é gerente leva 403 nela. */
let equipeResponde403: boolean;

/**
 * A ficha como o servidor a devolve — com as datas no formato REAL.
 *
 * `entered_at` e `assembled_at` são dias de calendário (`AAAA-MM-DD`), porque
 * é assim que a pessoa os digita; `sold_at` e os `created_at` são instantes,
 * porque são registros de quando algo aconteceu. A mistura é de propósito: é
 * ela que o defeito atravessava.
 */
function fichaCompleta() {
  return {
    equipment: {
      id: EQUIP_ID,
      brand: 'PJ Motors',
      model: 'Sport 3000',
      category: 'moto_eletrica',
      chassis: '9BW-TESTE-001',
      battery: '48V 20Ah',
      entered_at: '2026-08-12',
      assembled_at: '2026-08-01',
      assembly_mechanic_id: 'mec-marcos',
      sold_at: '2026-08-12T16:55:04.000Z',
      warranty_months: 6,
    },
    warranty: {
      months: 6,
      baseKind: 'venda',
      baseDate: '2026-08-12',
      expiresAt: '2027-02-12',
      status: 'vigente',
      daysLeft: 172,
    },
    assemblyMechanicName: 'MARCOS (Mecânico)',
    ownerName: 'Ana Proprietária',
    workshopName: 'Oficina de Mobilidade Elétrica',
    publicIdLabel: '#0001',
    events: [
      {
        id: 'ev-1',
        event_type: 'created',
        description: 'Equipamento interno registrado para montagem',
        order_number: null,
        user_name: 'Carlos Gerente',
        created_at: '2026-08-12T16:55:04.000Z',
      },
      {
        id: 'ev-2',
        event_type: 'service_completed',
        description: 'OS #2: Bateria substituída',
        order_number: 2,
        user_name: 'Carlos Gerente',
        created_at: '2026-08-12T16:55:06.000Z',
      },
    ],
    orders: [
      {
        id: 'os-2',
        number: 2,
        status: 'finalizada',
        complaint: 'Bateria nao carrega',
        total_cents: 180000,
        created_at: '2026-08-12T16:55:05.000Z',
        closed_at: '2026-08-12T16:55:06.000Z',
      },
    ],
  };
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    pedidos.push({ metodo, url: alvo, corpo });

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/team')) {
      // A rota da equipe é de GESTÃO: o mecânico, que também edita a ficha,
      // leva 403 aqui.
      if (equipeResponde403) {
        return responder(
          { error: { code: 'FORBIDDEN', message: 'Permissão negada para esta operação.' } },
          403,
        );
      }
      // `workshopStaff=1` devolve a equipe da oficina INTEIRA — o caixa vem
      // junto, e é ele que o seletor não pode oferecer.
      return responder({
        items: [
          { id: 'mec-marcos', displayName: 'MARCOS (Mecânico)', profileCode: 'mecanico' },
          { id: 'mec-lucas', displayName: 'LUCAS (Mecânico)', profileCode: 'mecanico' },
          { id: 'caixa-pdv', displayName: 'PDV Oficina', profileCode: 'operador_caixa_oficina' },
          { id: 'chefe', displayName: 'Carlos Gerente', profileCode: 'gerente_oficina' },
        ],
      });
    }

    if (metodo === 'PATCH' && alvo.includes(`/core/equipment/${EQUIP_ID}`)) {
      const eq = ficha.equipment as Record<string, unknown>;
      eq.warranty_months = corpo.warrantyMonths;
      eq.assembled_at = corpo.assembledAt;
      return responder({ ok: true });
    }

    if (alvo.includes(`/core/equipment/${EQUIP_ID}`)) return responder(ficha);
    return responder({});
  });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'carlos', displayName: 'Carlos Gerente', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  equipeResponde403 = false;
  ficha = fichaCompleta();
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('gerente_oficina');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter initialEntries={[`/sistema/equipamentos/${EQUIP_ID}`]}>
      <Routes>
        <Route path="/sistema/equipamentos/:id" element={<EquipamentoFichaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('o dia que a ficha imprime', () => {
  /**
   * O caso exato visto na conferência da rodada: entrada em 12/08 e montagem
   * em 01/08, num fuso negativo, apareciam como 11/08 e 31/07.
   */
  it('data de calendário aparece como foi digitada, sem recuar um dia', async () => {
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    expect(screen.getByText('12/08/2026')).toBeTruthy();
    expect(screen.queryByText('11/08/2026')).toBeNull();
    expect(screen.getByText(/em 01\/08\/2026/)).toBeTruthy();
    expect(screen.queryByText(/31\/07\/2026/)).toBeNull();
  });

  it('o vencimento da garantia é dia, e sai do jeito que o servidor mandou', async () => {
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    expect(screen.getByText(/vence em 12\/02\/2027/)).toBeTruthy();
    expect(screen.getByText('Em garantia')).toBeTruthy();
  });

  /**
   * O outro lado da mesma regra: INSTANTE continua no fuso de quem lê.
   *
   * Consertar a data de calendário imprimindo tudo como texto cru quebraria o
   * histórico, que grava em UTC e precisa aparecer na hora de quem está na
   * bancada.
   */
  it('instante do histórico continua convertido para o fuso de quem lê', async () => {
    ficha = fichaCompleta();
    // 00:30 UTC do dia 13 é ainda dia 12, às 21:30, no horário de Brasília.
    (ficha.events as { created_at: string }[])[0].created_at = '2026-08-13T00:30:00.000Z';
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    const historico = screen.getByText('O que já aconteceu').closest('section') as HTMLElement;
    // Sem a conversão, apareceria 13/08 — o dia em que ninguém estava lá. A
    // hora entra na busca porque é ela que distingue este registro do outro
    // evento do mesmo dia.
    expect(within(historico).getByText(/12\/08\/2026, 21:30/)).toBeTruthy();
    expect(within(historico).queryByText(/13\/08\/2026/)).toBeNull();
  });
});

describe('o histórico que ninguém lia', () => {
  it('mostra os acontecimentos em português, com a OS e quem fez', async () => {
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    const historico = screen.getByText('O que já aconteceu').closest('section') as HTMLElement;
    expect(within(historico).getByText(/Cadastrada/)).toBeTruthy();
    expect(within(historico).getByText(/Serviço concluído/)).toBeTruthy();
    // "OS #2" aparece duas vezes de propósito: no título do acontecimento e
    // dentro da descrição que o mecânico escreveu.
    expect(within(historico).getAllByText(/OS #2/).length).toBe(2);
    expect(within(historico).getAllByText(/Carlos Gerente/).length).toBeGreaterThan(0);
  });

  it('a ficha não imprime o token público da máquina', async () => {
    // O token abre a página pública do equipamento para quem o tiver: ele não
    // tem por que passear pela tela interna. O servidor já o remove; se um dia
    // voltar, a tela não pode ter onde escrevê-lo.
    (ficha.equipment as Record<string, unknown>).public_token = 'tok-secreto-123';
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    expect(screen.queryByText(/tok-secreto-123/)).toBeNull();
  });
});

describe('completar a ficha', () => {
  it('manda o patch ESTREITO — só o que o formulário oferece', async () => {
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    fireEvent.click(screen.getByRole('button', { name: 'Completar ficha' }));
    fireEvent.change(await screen.findByLabelText('Garantia (meses)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar ficha' }));

    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(true));
    const patch = pedidos.find((p) => p.metodo === 'PATCH')!;
    expect(patch.corpo.warrantyMonths).toBe(12);
    // Marca, modelo, chassi e dono NÃO viajam: a ficha completa a garantia e a
    // montagem, e mandar o cadastro inteiro de volta arrisca sobrescrever com
    // o que estava na tela quando ela abriu.
    expect(patch.corpo.brand).toBeUndefined();
    expect(patch.corpo.chassis).toBeUndefined();
    expect(patch.corpo.ownerName).toBeUndefined();
  });

  /**
   * O seletor "Montada por" não oferece quem o servidor recusaria.
   *
   * A rota da equipe devolve quem ATENDE a oficina — caixa incluído —, e o
   * servidor recusa caixa como montador (`CORE_NOT_A_MECHANIC`). Botão que
   * sempre leva 400 ensina a desconfiar do sistema.
   */
  it('só mecânico e gerente entram como quem montou a máquina', async () => {
    montar();
    await screen.findByText('PJ Motors Sport 3000');
    fireEvent.click(screen.getByRole('button', { name: 'Completar ficha' }));

    const seletor = await screen.findByLabelText('Montada por');
    await waitFor(() =>
      expect(within(seletor).queryByRole('option', { name: 'MARCOS (Mecânico)' })).toBeTruthy(),
    );
    expect(within(seletor).queryByRole('option', { name: 'Carlos Gerente' })).toBeTruthy();
    expect(within(seletor).queryByRole('option', { name: 'PDV Oficina' })).toBeNull();
  });

  /**
   * A LISTA DE EQUIPE É DE GESTÃO — e o mecânico também edita a ficha.
   *
   * `GET /core/team` exige gerente; o PATCH da ficha aceita `mecanico`. Então
   * o mecânico abre "Completar ficha", o pedido da equipe leva 403, o `catch`
   * engole, e o seletor abre em "Não informado" — inclusive numa máquina que
   * JÁ tem montador. Ele salva a garantia e APAGA quem montou, sem uma palavra
   * na tela. Não saber a equipe não pode virar "não tem montador".
   */
  it('sem poder ler a equipe, o seletor não mente sobre quem montou', async () => {
    entrarComo('mecanico');
    equipeResponde403 = true;
    montar();
    await screen.findByText('PJ Motors Sport 3000');
    fireEvent.click(screen.getByRole('button', { name: 'Completar ficha' }));

    const seletor = await screen.findByLabelText('Montada por');
    // O montador atual continua sendo o que a ficha mostra.
    await waitFor(() =>
      expect((seletor as HTMLSelectElement).selectedOptions[0]?.textContent).toContain(
        'MARCOS (Mecânico)',
      ),
    );
    // E a tela diz por que não dá para trocar, em vez de ficar calada.
    expect(screen.getByText(/não foi possível carregar a equipe/i)).toBeTruthy();
    expect((seletor as HTMLSelectElement).disabled).toBe(true);

    // Salvar não manda montador nenhum: o campo que não pôde ser editado não
    // viaja, e o que está gravado fica onde está.
    fireEvent.change(screen.getByLabelText('Garantia (meses)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar ficha' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PATCH')).toBe(true));
    const patch = pedidos.find((p) => p.metodo === 'PATCH')!;
    expect(patch.corpo.warrantyMonths).toBe(12);
    expect(patch.corpo.assemblyMechanicId).toBeUndefined();
  });

  it('quem não mexe na oficina não recebe o botão', async () => {
    entrarComo('atendente');
    montar();
    await screen.findByText('PJ Motors Sport 3000');

    expect(screen.queryByRole('button', { name: 'Completar ficha' })).toBeNull();
  });
});
