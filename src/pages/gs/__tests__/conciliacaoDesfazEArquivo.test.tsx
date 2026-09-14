/**
 * CONCILIAÇÃO BANCÁRIA — o botão de desfazer (GAP-V26) e o extrato por arquivo
 * (GAP-V27).
 *
 * ============================================================================
 * OS DOIS DEFEITOS
 * ============================================================================
 *
 * V26. `DELETE /core/bank/lines/:id/match` existia. `coreApi.unmatchBankLine`
 * existia. NENHUMA tela os chamava. Quem casava a linha errada — e casar a
 * linha errada é o erro mais provável desta tela, porque dois recebimentos de
 * mesmo valor no mesmo dia são indistinguíveis para a sugestão — ficava sem
 * volta pela interface: a divergência real sumia do relatório feito para
 * mostrá-la, e só um SELECT na mão a traria de volta.
 *
 * V27. O extrato só entrava por CSV COLADO num textarea. Exportar do internet
 * banking, ajustar colunas e colar são três passos manuais antes do primeiro
 * clique útil — e o banco operacional mostra o resultado: zero extratos
 * importados em produção.
 *
 * ============================================================================
 * O QUE ESTES CASOS COBRAM
 * ============================================================================
 *
 * Que o gesto ATRAVESSA a tela até a chamada de rede. Testar a função de parse
 * isolada (o que `extratoOfx.test.ts` já faz) não provaria nada sobre a tela:
 * o defeito de V26 era exatamente uma função pronta sem chamador.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import ConciliacaoBancariaPage from '../ConciliacaoBancariaPage';

const RELATORIO = {
  period: { from: null, to: null },
  bankTotalCents: 15_000,
  financeTotalCents: 15_000,
  differenceCents: 0,
  matched: 1,
  divergences: [],
};

const LINHAS = [
  {
    id: 'linha-casada',
    occurred_at: '2026-08-10',
    description: 'PIX RECEBIDO FULANO',
    amount_cents: 15_000,
    document: null,
    matched_settlement_id: 'baixa-1',
    matched_at: '2026-08-12T10:00:00.000Z',
    matched_by_name: 'Gerente da Loja',
  },
  {
    id: 'linha-solta',
    occurred_at: '2026-08-11',
    description: 'TARIFA',
    amount_cents: -3_500,
    document: null,
    matched_settlement_id: null,
    matched_at: null,
    matched_by_name: null,
  },
];

/** O que a tela mandou ao servidor, na ordem. */
let chamadas: { url: string; method: string; body: unknown }[] = [];

function servidor() {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    chamadas.push({
      url: alvo,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/bank/conciliacao')) return json(RELATORIO);
    if (alvo.includes('/core/bank/lines') && alvo.endsWith('/match') && method === 'DELETE') {
      return json({ ok: true, lineId: 'linha-casada', settlementId: 'baixa-1' });
    }
    if (alvo.includes('/core/bank/statements') && method === 'POST') {
      return json({ statementId: 'ext-1', imported: 2, skipped: 0 }, 201);
    }
    if (alvo.includes('/core/bank/lines')) {
      // O servidor filtra pendentes e casadas desde o GAP-PRD-177: a tela
      // pede as duas listas separadas, cada uma com o próprio total.
      const itens = alvo.includes('onlyUnmatched=true')
        ? LINHAS.filter((l) => !l.matched_settlement_id)
        : alvo.includes('onlyMatched=true')
          ? LINHAS.filter((l) => l.matched_settlement_id)
          : LINHAS;
      return json({ items: itens, total: itens.length, limit: 500, offset: 0, truncated: false });
    }
    return json({ items: [] });
  });
}

beforeEach(() => {
  chamadas = [];
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste da conciliação bancária',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderizar() {
  render(
    <MemoryRouter>
      <ConciliacaoBancariaPage />
    </MemoryRouter>,
  );
}

describe('desfazer o casamento (GAP-V26)', () => {
  it('a linha já conciliada aparece, com quem conferiu', async () => {
    // Antes ela sumia da tela por completo: casada e invisível.
    renderizar();
    await screen.findByText('Linhas conciliadas');
    expect(screen.getByText('PIX RECEBIDO FULANO')).toBeTruthy();
    expect(screen.getByText(/Gerente da Loja/)).toBeTruthy();
  });

  it('desfazer PERGUNTA antes — o clique não apaga a conferência sozinho', async () => {
    renderizar();
    await screen.findByText('Linhas conciliadas');

    fireEvent.click(
      screen.getByRole('button', { name: /Desfazer a conciliação de PIX RECEBIDO FULANO/ }),
    );

    expect(screen.getByRole('alertdialog', { name: 'Desfazer a conciliação?' })).toBeTruthy();
    // Nada foi ao servidor só por abrir a pergunta.
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('confirmando, o DELETE sai para a linha certa', async () => {
    renderizar();
    await screen.findByText('Linhas conciliadas');

    fireEvent.click(
      screen.getByRole('button', { name: /Desfazer a conciliação de PIX RECEBIDO FULANO/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer mesmo assim' }));

    await waitFor(() => {
      expect(
        chamadas.some(
          (c) => c.method === 'DELETE' && c.url.includes('/core/bank/lines/linha-casada/match'),
        ),
      ).toBe(true);
    });
  });

  it('"Manter" fecha a pergunta sem chamar nada', async () => {
    renderizar();
    await screen.findByText('Linhas conciliadas');

    fireEvent.click(
      screen.getByRole('button', { name: /Desfazer a conciliação de PIX RECEBIDO FULANO/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manter' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('importar o extrato por arquivo (GAP-V27)', () => {
  const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260810120000[-3:BRT]<TRNAMT>150.00<FITID>F-1<MEMO>PIX RECEBIDO</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260831<TRNAMT>-45.90<FITID>F-2<MEMO>TARIFA</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  async function escolher(nome: string, conteudo: string) {
    const input = screen.getByLabelText(/Arquivo do banco/) as HTMLInputElement;
    const arquivo = new File([conteudo], nome, { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [arquivo], configurable: true });
    fireEvent.change(input);
  }

  it('o OFX escolhido vira lançamentos, com a contagem na tela', async () => {
    renderizar();
    await screen.findByText('Importar extrato');

    await escolher('extrato-agosto.ofx', OFX);

    const resumo = await screen.findByTestId('extrato-arquivo');
    expect(resumo.textContent).toContain('extrato-agosto.ofx');
    expect(resumo.textContent).toContain('OFX');
    expect(resumo.textContent).toContain('2 lançamento(s)');
  });

  it('importar manda as linhas do arquivo, com valor em centavos e o FITID', async () => {
    renderizar();
    await screen.findByText('Importar extrato');
    await escolher('extrato-agosto.ofx', OFX);
    await screen.findByTestId('extrato-arquivo');

    fireEvent.click(screen.getByRole('button', { name: 'Importar' }));

    await waitFor(() => {
      expect(
        chamadas.some((c) => c.method === 'POST' && c.url.includes('/core/bank/statements')),
      ).toBe(true);
    });
    const envio = chamadas.find(
      (c) => c.method === 'POST' && c.url.includes('/core/bank/statements'),
    )!.body as {
      sourceName: string;
      lines: { occurredAt: string; amountCents: number; externalId: string }[];
    };

    // O nome do arquivo fica gravado: explicar divergência começa por saber de
    // qual extrato ela veio.
    expect(envio.sourceName).toBe('extrato-agosto.ofx');
    expect(envio.lines).toHaveLength(2);
    expect(envio.lines[0].amountCents).toBe(15_000);
    expect(envio.lines[1].amountCents).toBe(-4_590);
    // Sem o FITID, reimportar o arquivo do mês duplicaria o mês inteiro.
    expect(envio.lines[0].externalId).toBe('F-1');
  });

  it('CSV escolhido como arquivo cai no campo de texto, para conferência', async () => {
    /*
      No CSV há o que corrigir à mão — separador errado, coluna trocada. Jogar
      o conteúdo no textarea deixa a pessoa ver antes de importar; no OFX não
      há o que ajustar, e a lista vai direto.
    */
    renderizar();
    await screen.findByText('Importar extrato');

    await escolher('extrato.csv', '10/08/2026;PIX recebido;150,00');

    await waitFor(() => {
      const area = screen.getByLabelText(/Linhas do extrato/) as HTMLTextAreaElement;
      expect(area.value).toContain('PIX recebido');
    });
    expect(screen.queryByTestId('extrato-arquivo')).toBeNull();
  });

  it('sem arquivo e sem texto, o botão de importar fica desabilitado', async () => {
    renderizar();
    await screen.findByText('Importar extrato');
    expect((screen.getByRole('button', { name: 'Importar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
