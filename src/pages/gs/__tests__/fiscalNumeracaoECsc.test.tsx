/**
 * NUMERAÇÃO E CSC NA TELA FISCAL.
 *
 * Até a rodada 33 estes dois itens do checklist só existiam por rota: o
 * `readiness` cobrava `serie:FAIL` e `csc:FAIL`, e não havia nenhum lugar no
 * sistema onde alguém pudesse resolvê-los. O dono via a pendência e não tinha
 * botão. Estes casos existem para que a tela não desapareça de novo.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem o cartão de numeração, quem lê "Nenhuma série configurada" não tem
 *     onde configurar — o primeiro caso falha na ausência do campo;
 *   - se a série viajar como TEXTO, o servidor recebe "1" onde espera 1, e a
 *     validação de faixa passa a comparar string com número — o caso do corpo
 *     da requisição falha;
 *   - se o token do CSC voltar para a tela (ou ficar no campo depois de
 *     gravado), o segredo passa a morar no navegador — o caso do token falha;
 *   - o ambiente do CSC COMEÇA no da operação: o caminho normal não pede
 *     escolha, e é assim que o de teste não vira "de produção" por descuido;
 *     o caso do ambiente falha se o padrão não acompanhar a operação. Gravar o
 *     de produção ANTES da virada é escolha explícita e tem o seu próprio
 *     arquivo (fiscalCscPorAmbiente.test.tsx, GAP-PRD-022).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalPage from '../FiscalPage';

const CONFIG = {
  companyId: 'loja',
  legalName: 'Preço Justo Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '68900000',
  street: 'Av. Central',
  number: '100',
  complement: null,
  district: 'Centro',
  cityName: 'Macapá',
  cityIbge: '1600303',
  uf: 'AP',
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: '2026-08-23T12:00:00.000Z',
};

const SERIES = [
  { model: '65', series: [{ serie: 1, nextNumber: 41 }] },
  { model: '55', series: [] },
];

/** Tudo o que a tela mandou para o servidor, na ordem. */
let enviados: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
let cscAtual: unknown[];

function servidor() {
  return vi.fn(async (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    const headers = init?.headers ?? {};
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') enviados.push({ url: alvo, method, body, headers });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/fiscal/config')) return json(CONFIG);
    if (alvo.includes('/core/fiscal/readiness')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/product-pendencies')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/series')) return json({ items: SERIES });
    if (alvo.includes('/core/fiscal/nfce/csc')) {
      if (method === 'POST') {
        cscAtual = [
          {
            operationalUnitId: 'unit-default',
            cscId: String(body?.cscId ?? ''),
            configured: true,
            environment: body?.environment,
          },
        ];
        return json(cscAtual[0], 201);
      }
      return json({ items: cscAtual });
    }
    return json({ items: [] });
  });
}

function entrarComoGestor() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste da numeração e do CSC',
  );
}

beforeEach(() => {
  enviados = [];
  cscAtual = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGestor();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrir() {
  render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
  await screen.findByText('Numeração das notas');
}

describe('numeração das séries', () => {
  it('mostra a série existente e diz quando não há nenhuma', async () => {
    await abrir();

    // O modelo 65 tem série 1 na próxima nota 41.
    expect(await screen.findByText(/Série 1 — próxima nota número 41/)).toBeTruthy();
    // O modelo 55 não tem — e a tela diz o efeito, não só "vazio".
    expect(
      screen.getByText(/Nenhuma série configurada — a emissão deste modelo fica bloqueada/),
    ).toBeTruthy();
  });

  it('envia série e número como NÚMERO, não como texto', async () => {
    await abrir();

    fireEvent.change(screen.getByLabelText('Série'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Próximo número'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Salvar numeração'));

    await waitFor(() => {
      expect(enviados.some((e) => e.url.includes('/core/fiscal/series'))).toBe(true);
    });
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/series'))!;
    // Tipo, e não só valor: "2" e 2 são coisas diferentes para a validação de
    // faixa do servidor, que usa Number.isInteger.
    expect(envio.body).toEqual({ model: '65', serie: 2, nextNumber: 100 });
    expect(typeof (envio.body as { serie: unknown }).serie).toBe('number');
  });
});

describe('CSC', () => {
  it('começa como NÃO CONFIGURADO e só libera o botão com os dois campos', async () => {
    await abrir();

    // Um lugar para cada ambiente (GAP-PRD-022): os dois começam vazios.
    expect(screen.getAllByText('NÃO CONFIGURADO')).toHaveLength(2);

    const botao = screen.getByText('Gravar CSC').closest('button')!;
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000001' } });
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'SEGREDO-XYZ' } });
    expect(botao.disabled).toBe(false);
  });

  it('grava com chave de idempotência, no ambiente da operação, e some com o token', async () => {
    await abrir();

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000001' } });
    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'SEGREDO-XYZ' } });
    fireEvent.click(screen.getByText('Gravar CSC'));

    await waitFor(() => {
      expect(enviados.some((e) => e.url.includes('/core/fiscal/nfce/csc'))).toBe(true);
    });
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/nfce/csc'))!;

    // A rota EXIGE a chave: sem ela o servidor responde 400 e o botão parece
    // quebrado. Dois cliques com a mesma chave devolvem a mesma gravação.
    expect(envio.headers['Idempotency-Key']).toBeTruthy();
    // O ambiente acompanha a operação — não é escolha de quem digita.
    expect((envio.body as { environment: string }).environment).toBe('homologation');

    // Gravado: o selo muda e o campo do token fica vazio. O segredo não
    // continua pendurado na tela depois de subir.
    await screen.findByText('CONFIGURADO');
    const campoToken = screen.getByLabelText('Token do CSC') as HTMLInputElement;
    expect(campoToken.value).toBe('');
    expect(campoToken.type).toBe('password');

    // E o token não aparece em lugar nenhum da tela.
    expect(document.body.textContent).not.toContain('SEGREDO-XYZ');
  });
});
