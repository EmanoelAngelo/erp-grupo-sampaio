/**
 * A INTEGRIDADE DO PACOTE NA TELA (GAP-PRD-176).
 *
 * O servidor passou a dizer o SHA-256 do zip no cabeçalho do download e a
 * reconhecer, pela trilha, um hash informado. Estes casos cobram a metade que
 * só se prova clicando:
 *
 *   - o número que aparece depois do download é o do CABEÇALHO, e sem
 *     cabeçalho a tela não inventa número nenhum;
 *   - colar o hash consulta a conferência com o Bearer e diz, em português,
 *     de qual entrega ele é — ou que não é de nenhuma;
 *   - escolher o arquivo calcula o SHA-256 no navegador e manda SÓ o número;
 *   - sem Web Crypto, a tela ensina a calcular fora, em vez de falhar calada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FechamentoContadorPage from '../FechamentoContadorPage';

const HASH = 'ab'.repeat(32);

interface Chamada {
  url: string;
  autorizacao: string | null;
}

let chamadas: Chamada[];
let respostaDoPacote: () => Response;
let respostaDaConferencia: (url: string) => Response;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function previa(periodo: string) {
  return {
    period: periodo,
    primeiroDia: `${periodo}-01`,
    ultimoDia: `${periodo}-28`,
    empresa: { nome: 'Me Mimei Modas', slug: 'me-mimei' },
    nomeArquivo: `pacote-me-mimei-${periodo}.zip`,
    contagens: {
      emitidasAutorizadas: 3,
      emitidasCanceladas: 0,
      eventos: 0,
      recebidasComArquivo: 1,
      recebidasSemArquivo: 0,
      recebidasSemNota: 0,
      recebidasEstornadas: 0,
      faixasInutilizadas: 0,
    },
    pendencias: [],
    mesesComMateriaPrima: [],
  };
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      chamadas.push({ url: u, autorizacao: init?.headers?.Authorization ?? null });
      if (u.includes('/closings/conferir')) return respostaDaConferencia(u);
      if (u.includes('/pacote')) return respostaDoPacote();
      const periodo = /closings\/([^/]+)\/previa/.exec(u)?.[1] ?? '2026-05';
      return json(previa(periodo));
    }),
  );
}

/** O CONTADOR: a tela sem a seção de envio, que é da gestão. */
async function montar() {
  setSession(
    {
      accessToken: 'token-do-contador',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'contador', displayName: 'Contador', profileCode: 'contador' },
      company: { id: 'loja', slug: 'me-mimei', tradeName: 'Me Mimei', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da integridade do pacote',
  );
  servidor();
  render(
    <MemoryRouter>
      <FechamentoContadorPage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Baixar o pacote' });
}

beforeEach(() => {
  chamadas = [];
  respostaDoPacote = () =>
    new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: {
        'Content-Disposition': 'attachment; filename="pacote-me-mimei-2026-05.zip"',
        'X-Pacote-Sha256': HASH,
      },
    });
  respostaDaConferencia = () =>
    json({
      sha256: HASH,
      encontrado: true,
      ocorrencias: [
        {
          arquivo: 'zip',
          meio: 'download',
          period: '2026-05',
          nomeArquivo: 'pacote-me-mimei-2026-05.zip',
          quando: '2026-06-02T13:10:00.000Z',
          userId: 'u-9',
        },
      ],
    });
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:http://localhost/objeto'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da integridade do pacote');
});

describe('o número depois do download', () => {
  it('mostra o SHA-256 que o servidor disse no cabeçalho', async () => {
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar o pacote' }));

    const numero = await screen.findByTestId('sha256-do-download');
    expect(numero.textContent).toBe(HASH);
    expect(screen.getByRole('note', { name: 'SHA-256 do pacote baixado' }).textContent).toContain(
      'pacote-me-mimei-2026-05.zip',
    );
  });

  it('sem o cabeçalho, a tela não inventa número', async () => {
    respostaDoPacote = () =>
      new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="pacote-me-mimei-2026-05.zip"' },
      });
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Baixar o pacote' }));

    await screen.findByText(/baixado como pacote-me-mimei-2026-05\.zip/);
    expect(screen.queryByTestId('sha256-do-download')).toBeNull();
  });
});

describe('conferir um pacote recebido', () => {
  it('o hash colado vai à conferência com o Bearer, e a entrega é descrita', async () => {
    await montar();
    fireEvent.change(screen.getByLabelText('SHA-256 do pacote'), { target: { value: ` ${HASH} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));

    await screen.findByText('Reconhecido: é um pacote que o sistema entregou.');
    expect(screen.getByText(/O arquivo \.zip do pacote de 2026-05 \(pacote-me-mimei-2026-05\.zip\), baixado pela tela em/)).toBeTruthy();

    const consulta = chamadas.find((c) => c.url.includes('/closings/conferir'));
    expect(consulta?.url).toContain(`/core/fiscal/closings/conferir?sha256=${HASH}`);
    expect(consulta?.autorizacao).toBe('Bearer token-do-contador');
  });

  it('hash de nenhuma entrega: "Não reconhecido", com o caminho do MANIFESTO', async () => {
    respostaDaConferencia = () => json({ sha256: HASH, encontrado: false, ocorrencias: [] });
    await montar();
    fireEvent.change(screen.getByLabelText('SHA-256 do pacote'), { target: { value: HASH } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));

    await screen.findByText('Não reconhecido.');
    expect(screen.getByText(/confira o do MANIFESTO\.csv/)).toBeTruthy();
  });

  it('a recusa do servidor chega com a frase do servidor', async () => {
    respostaDaConferencia = () =>
      json(
        {
          error: {
            code: 'CORE_FISCAL_SHA256_INVALIDO',
            message: 'Informe o SHA-256 do arquivo: 64 caracteres, de 0 a 9 e de a a f.',
          },
        },
        400,
      );
    await montar();
    fireEvent.change(screen.getByLabelText('SHA-256 do pacote'), { target: { value: 'xyz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conferir' }));

    expect((await screen.findByRole('alert')).textContent).toContain('64 caracteres');
  });

  it('escolher o arquivo calcula o SHA-256 no navegador e manda SÓ o número', async () => {
    const digest = vi.fn(async () => new Uint8Array(32).fill(0xab).buffer);
    vi.stubGlobal('crypto', {
      subtle: { digest },
      getRandomValues: <T,>(a: T) => a,
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
    });
    await montar();

    const arquivo = { name: 'pacote.zip', arrayBuffer: async () => new ArrayBuffer(8) };
    fireEvent.change(screen.getByLabelText('Arquivo do pacote'), { target: { files: [arquivo] } });

    await screen.findByText('Reconhecido: é um pacote que o sistema entregou.');
    expect(digest).toHaveBeenCalledWith('SHA-256', expect.any(ArrayBuffer));
    expect((screen.getByLabelText('SHA-256 do pacote') as HTMLInputElement).value).toBe(HASH);
    const consulta = chamadas.find((c) => c.url.includes('/closings/conferir'));
    expect(consulta?.url).toContain(`sha256=${HASH}`);
  });

  it('sem Web Crypto, a tela ensina a calcular fora em vez de falhar calada', async () => {
    vi.stubGlobal('crypto', { getRandomValues: <T,>(a: T) => a });
    await montar();

    const arquivo = { name: 'pacote.zip', arrayBuffer: async () => new ArrayBuffer(8) };
    fireEvent.change(screen.getByLabelText('Arquivo do pacote'), { target: { files: [arquivo] } });

    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('certutil -hashfile');
    await waitFor(() =>
      expect(chamadas.some((c) => c.url.includes('/closings/conferir'))).toBe(false),
    );
  });
});
