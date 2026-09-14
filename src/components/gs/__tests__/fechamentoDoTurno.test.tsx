/**
 * O FIM DO DIA PRECISA BATER COM O PAPEL.
 *
 * ============================================================================
 * QUATRO COISAS NA TELA QUE FECHA A GAVETA
 * ============================================================================
 *
 * 1. **Dois números verdadeiros que se contradiziam.** "Recebido no turno ·
 *    dinheiro" mostra o que o cliente ENTREGOU; "Esperado na gaveta" mostra o
 *    que FICOU. Numa venda de R$ 50 paga com R$ 100, um diz 100 e o outro diz
 *    50, e nada explicava a diferença. Quem confere conta R$ 50 na gaveta e vai
 *    procurar um erro que não existe. Agora a tela escreve a conta:
 *    entregue − troco = gaveta.
 *
 * 2. **O esperado não dizia de onde veio.** O servidor sempre mandou os
 *    movimentos do turno — abertura, cada venda, cada sangria, cada suprimento,
 *    com nota e horário — e a tela guardava só dois números e jogava o resto
 *    fora. "Esperado R$ 350" sem composição obriga a confiar ou a abrir outra
 *    tela, no exato momento em que a pessoa está com as notas na mão.
 *
 * 3. **Sem o resumo, o turno fechava às cegas.** Se a consulta falhava, o
 *    esperado virava "—", a diferença sumia — e o botão vermelho continuava
 *    ativo. Fechar assim grava uma conferência sem confronto: o valor contado
 *    entra como fato e a diferença fica registrada contra um esperado que
 *    ninguém viu.
 *
 * 4. **Fechar o caixa não tinha volta e não perguntava nada.** É o único botão
 *    daqui sem desfazer: fechado o turno, não há reabrir. E ele fica na mesma
 *    linha do Suprimento e da Sangria, alimentado pelo mesmo campo de valor.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaixaPdvDialog } from '../CaixaPdvDialog';
import { setSession } from '@/lib/api/client';

const CAIXA: Record<string, unknown> = {
  id: 'sessao-1',
  company_id: 'c1',
  opening_cents: 10000,
  status: 'aberto',
  opened_at: '2026-08-26T11:30:00.000Z',
};

/** O resumo que o servidor devolve — ou a falha, quando `resumoFalha`. */
let resumoFalha: boolean;
let fechamentos: { contado: number; nota: string | null }[];

const RESUMO = {
  expectedCents: 45275,
  changeCents: 4725,
  byMethod: [
    { method: 'dinheiro', total: 40000 },
    { method: 'pix', total: 30000 },
  ],
  movements: [
    { id: 'm1', movement_type: 'opening', amount_cents: 10000, note: 'Fundo de troco', created_at: '2026-08-26T11:30:00.000Z' },
    { id: 'm2', movement_type: 'sale', amount_cents: 35275, note: 'Venda #41', created_at: '2026-08-26T12:10:00.000Z' },
    { id: 'm3', movement_type: 'withdrawal', amount_cents: -10000, note: 'Sangria para o cofre', created_at: '2026-08-26T15:00:00.000Z' },
    { id: 'm4', movement_type: 'supply', amount_cents: 10000, note: 'Troco do banco', created_at: '2026-08-26T16:00:00.000Z' },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes('/summary')) {
        if (resumoFalha) return json({ error: { message: 'fora do ar' } }, 503);
        return json(RESUMO);
      }
      if (u.includes('/close')) {
        const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        fechamentos.push({
          contado: Number(corpo.countedCents),
          nota: (corpo.note as string) ?? null,
        });
        return json({ ...CAIXA, status: 'fechado' });
      }
      return json({ items: [] });
    }),
  );
}

function montar(cash: unknown = CAIXA) {
  render(
    <CaixaPdvDialog
      cash={cash as never}
      tetoSangriaCents={null}
      vendasEmEspera={0}
      onClose={() => undefined}
      onChanged={() => undefined}
    />,
  );
}

const botao = (nome: RegExp) => screen.getByRole('button', { name: nome }) as HTMLButtonElement;

beforeEach(() => {
  resumoFalha = false;
  fechamentos = [];
  servidor();
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'caixa', displayName: 'Caixa 1', profileCode: 'operador_caixa_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste de fechamento',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste de fechamento');
});

// ============================================================================

describe('a tela explica a diferença entre o entregue e a gaveta', () => {
  it('escreve a conta: entregue menos troco é o que ficou', async () => {
    montar();

    const conta = await screen.findByTestId('caixa-conta-do-dinheiro');
    const texto = conta.textContent?.replace(/\s+/g, ' ') ?? '';

    /*
      R$ 400 entregues em espécie, R$ 47,25 de troco, R$ 352,75 na gaveta — mais
      o fundo de abertura, que já está no esperado. O que a tela precisa fazer é
      parar de mostrar dois números que se contradizem sem explicação.
    */
    expect(texto).toMatch(/R\$ 400,00/);
    expect(texto).toMatch(/R\$ 47,25/);
    expect(texto).toMatch(/troco/i);
  });

  it('sem troco no turno, a linha não aparece — não se explica o que não houve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes('/summary')
          ? json({ ...RESUMO, changeCents: 0 })
          : json({ items: [] }),
      ),
    );
    montar();

    await screen.findByTestId('caixa-esperado');
    expect(screen.queryByTestId('caixa-conta-do-dinheiro')).toBeNull();
  });
});

// ============================================================================

describe('o esperado diz de onde veio', () => {
  it('a composição do turno aparece: abertura, venda, sangria e suprimento', async () => {
    montar();

    const composicao = await screen.findByTestId('caixa-composicao');
    const texto = composicao.textContent?.replace(/\s+/g, ' ') ?? '';

    /*
      O servidor sempre mandou isto e a tela jogava fora. É a diferença entre
      "confie no número" e "confira o número" — no momento em que a pessoa está
      com as notas na mão.
    */
    expect(texto).toMatch(/Fundo de troco/);
    expect(texto).toMatch(/Venda #41/);
    expect(texto).toMatch(/Sangria para o cofre/);
    expect(texto).toMatch(/Troco do banco/);
  });
});

// ============================================================================

describe('não se fecha o turno às cegas', () => {
  it('sem o resumo, o botão de fechar fica travado e a tela diz por quê', async () => {
    resumoFalha = true;
    montar();

    fireEvent.change(await screen.findByLabelText('Valor'), { target: { value: '452,75' } });

    /*
      Fechar sem esperado grava uma conferência sem confronto: o contado entra
      como fato e a diferença fica registrada contra um número que ninguém viu.
      E fechar não tem volta.
    */
    await waitFor(() => expect(botao(/Fechar caixa/i).disabled).toBe(true));
    expect(await screen.findByText(/não foi possível carregar o resumo/i)).toBeTruthy();
    expect(fechamentos).toHaveLength(0);
  });

  it('com o resumo na tela, fechar pede confirmação antes', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '452,75' } });
    fireEvent.click(botao(/Fechar caixa/i));

    // É o único botão daqui sem desfazer — e mora na mesma linha do Suprimento
    // e da Sangria, alimentado pelo mesmo campo.
    expect(await screen.findByTestId('caixa-confirmar-fechamento')).toBeTruthy();
    expect(fechamentos).toHaveLength(0);

    fireEvent.click(botao(/Confirmar fechamento/i));
    await waitFor(() => expect(fechamentos).toHaveLength(1));
    expect(fechamentos[0].contado).toBe(45275);
  });

  it('desistir da confirmação deixa o turno aberto', async () => {
    montar();
    await screen.findByTestId('caixa-esperado');

    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '452,75' } });
    fireEvent.click(botao(/Fechar caixa/i));
    fireEvent.click(await screen.findByRole('button', { name: /Voltar/i }));

    await waitFor(() => expect(screen.queryByText(/Confirmar fechamento/i)).toBeNull());
    expect(fechamentos).toHaveLength(0);
  });
});

// ============================================================================

describe('o teclado do diálogo do caixa', () => {
  it('Esc fecha — a mesma tecla que fecha o pagamento', async () => {
    const fechados: number[] = [];
    render(
      <CaixaPdvDialog
        cash={CAIXA as never}
        tetoSangriaCents={null}
        vendasEmEspera={0}
        onClose={() => fechados.push(1)}
        onChanged={() => undefined}
      />,
    );
    await screen.findByTestId('caixa-esperado');

    /*
      A ajuda do PDV ensina que Esc fecha modal e o diálogo de pagamento
      obedece. Este não tinha handler de tecla nenhum no arquivo inteiro: quem
      aprendeu o gesto apertava duas, três vezes antes de desconfiar.
    */
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(fechados).toHaveLength(1);
  });

  it('Esc NÃO fecha por cima da confirmação de fechamento', async () => {
    const fechados: number[] = [];
    render(
      <CaixaPdvDialog
        cash={CAIXA as never}
        tetoSangriaCents={null}
        vendasEmEspera={0}
        onClose={() => fechados.push(1)}
        onChanged={() => undefined}
      />,
    );
    await screen.findByTestId('caixa-esperado');
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '452,75' } });
    fireEvent.click(screen.getByRole('button', { name: /Fechar caixa/i }));
    await screen.findByTestId('caixa-confirmar-fechamento');

    // Com uma pergunta na tela, Esc responde a PERGUNTA — some com ela e
    // mantém o diálogo. Fechar tudo faria a tecla desfazer duas coisas.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('caixa-confirmar-fechamento')).toBeNull());
    expect(fechados).toHaveLength(0);
  });
});
