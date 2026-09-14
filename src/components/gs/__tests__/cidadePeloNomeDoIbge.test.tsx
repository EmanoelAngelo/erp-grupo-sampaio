/**
 * O CÓDIGO IBGE SAI DO NOME DA CIDADE — na tela (IBGE-MUNICIPIOS).
 *
 * Depois do GAP-PRD-028 a entrega exige o código IBGE do município, e o
 * formulário mandava o cliente "buscar no site do IBGE, pelo nome da cidade".
 * Cliente de loja online não sabe o que é isso: a compra não fechava.
 *
 * O que não pode falhar:
 *
 *   1. com a tabela oficial carregada no servidor, a pessoa escolhe a UF e a
 *      cidade pelo nome, e o código IBGE vem junto — ela NUNCA digita o
 *      código (o campo digitado nem aparece);
 *   2. escolher com o teclado (setas + Enter) escolhe a cidade e NÃO salva o
 *      endereço — dentro do checkout, Enter salvando seria fechar a compra;
 *   3. mexer no nome depois de escolher tira o código (ele era de outra
 *      cidade), e trocar a UF também;
 *   4. sem a tabela (ou com o servidor fora), o campo digitado de hoje volta,
 *      com o texto de ajuda;
 *   5. o cadastro fiscal do emitente usa o mesmo seletor.
 *
 * FIXTURE: os municípios abaixo são uma amostra de teste, não a lista oficial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { FormularioDeEndereco } from '../FormularioDeEndereco';
import FiscalPage from '@/pages/gs/FiscalPage';
import { respostaDaBarraDoShell } from '@/pages/gs/__tests__/barraDoShell';
import type { DadosDoEndereco } from '@/lib/api/enderecos';

/** FIXTURE DE TESTE — amostra, não a lista oficial do IBGE. */
const AMOSTRA = [
  { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
  { codigo: '4314902', nome: 'Porto Alegre', uf: 'RS' },
  { codigo: '3550308', nome: 'São Paulo', uf: 'SP' },
  { codigo: '3548708', nome: 'São Bernardo do Campo', uf: 'SP' },
];

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

type Tabela = 'carregada' | 'vazia' | 'fora';

interface Enviado {
  url: string;
  method: string;
  body: unknown;
}

function servidor(tabela: Tabela, outras: (url: string, method: string, body: unknown) => Response | undefined = () => undefined) {
  const buscas: string[] = [];
  const enviados: Enviado[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (entrada: string | URL | Request, init?: { method?: string; body?: string }) => {
      const url = String(entrada);
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (method !== 'GET') enviados.push({ url, method, body });
      if (url.includes('/loja/municipios')) {
        buscas.push(url);
        if (tabela === 'fora') return json({ error: { code: 'X', message: 'fora do ar' } }, 500);
        if (tabela === 'vazia') return json({ carregada: false, total: 0, itens: [] });
        const params = new URL(url, 'http://teste').searchParams;
        const uf = params.get('uf') ?? '';
        const q = semAcento(params.get('q') ?? '');
        const itens =
          q.length < 2 ? [] : AMOSTRA.filter((m) => (!uf || m.uf === uf) && semAcento(m.nome).includes(q));
        return json({ carregada: true, total: 5571, itens });
      }
      return outras(url, method, body) ?? json({ items: [] });
    }),
  );
  return { buscas, enviados };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function modoTabela(): Promise<void> {
  await waitFor(() => expect((screen.getByLabelText('UF') as HTMLElement).tagName).toBe('SELECT'));
}

describe('o formulário do endereço, com a tabela oficial carregada', () => {
  it('escolher a cidade preenche a cidade e o código IBGE — o cliente nunca digita o código', async () => {
    servidor('carregada');
    const onSalvar = vi.fn(async (dados: DadosDoEndereco) => void dados);
    render(<FormularioDeEndereco onSalvar={onSalvar} />);
    await modoTabela();

    // O campo digitado não existe neste modo.
    expect(screen.queryByLabelText('Código IBGE do município')).toBeNull();
    expect(screen.queryByText(/site do IBGE/)).toBeNull();

    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'RS' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'pel' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));

    expect((screen.getByLabelText('Cidade') as HTMLInputElement).value).toBe('Pelotas');
    expect(screen.getByText(/4314407/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));
    await waitFor(() => expect(onSalvar).toHaveBeenCalledTimes(1));
    expect(onSalvar.mock.calls[0][0]).toMatchObject({ city: 'Pelotas', state: 'RS', cityIbge: '4314407' });
  });

  it('a busca vai com a UF e o que foi digitado, sem acento na conta do servidor', async () => {
    const { buscas } = servidor('carregada');
    render(<FormularioDeEndereco onSalvar={vi.fn(async () => {})} />);
    await modoTabela();
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'SP' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'sao' } });
    expect(await screen.findByRole('option', { name: /São Paulo/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /São Bernardo do Campo/ })).toBeTruthy();
    const ultima = new URL(buscas[buscas.length - 1], 'http://teste').searchParams;
    expect(ultima.get('uf')).toBe('SP');
    expect(ultima.get('q')).toBe('sao');
  });

  it('setas e Enter escolhem a cidade — e o Enter NÃO salva o endereço', async () => {
    servidor('carregada');
    const onSalvar = vi.fn(async () => {});
    render(<FormularioDeEndereco onSalvar={onSalvar} />);
    await modoTabela();
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'SP' } });
    const cidade = screen.getByLabelText('Cidade');
    fireEvent.change(cidade, { target: { value: 'sao paulo' } });
    await screen.findByRole('option', { name: /São Paulo/ });
    fireEvent.keyDown(cidade, { key: 'ArrowDown' });
    fireEvent.keyDown(cidade, { key: 'Enter' });

    expect((cidade as HTMLInputElement).value).toBe('São Paulo');
    expect(screen.getByText(/3550308/)).toBeTruthy();
    expect(onSalvar).not.toHaveBeenCalled();
  });

  it('mexer no nome depois de escolher tira o código, e a tela pede para escolher na lista', async () => {
    servidor('carregada');
    const onSalvar = vi.fn(async (dados: DadosDoEndereco) => void dados);
    render(<FormularioDeEndereco onSalvar={onSalvar} />);
    await modoTabela();
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'RS' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'pel' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Pelotinhas' } });

    expect(screen.queryByText(/4314407/)).toBeNull();
    expect(screen.getAllByText(/escolha a cidade na lista/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));
    await waitFor(() => expect(onSalvar).toHaveBeenCalled());
    expect(onSalvar.mock.calls[0][0]).toMatchObject({ city: 'Pelotinhas', cityIbge: '' });
  });

  it('trocar a UF tira o código escolhido', async () => {
    servidor('carregada');
    render(<FormularioDeEndereco onSalvar={vi.fn(async () => {})} />);
    await modoTabela();
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'RS' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'pel' } });
    fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'SP' } });
    expect(screen.queryByText(/4314407/)).toBeNull();
  });

  it('editar um endereço que já tem o código mostra o código e o mantém ao salvar', async () => {
    servidor('carregada');
    const onSalvar = vi.fn(async (dados: DadosDoEndereco) => void dados);
    render(
      <FormularioDeEndereco
        inicial={{
          label: 'Casa',
          recipientName: '',
          zip: '96010000',
          street: 'Rua XV',
          number: '500',
          complement: '',
          district: 'Centro',
          city: 'Pelotas',
          state: 'RS',
          cityIbge: '4314407',
          kind: '',
        }}
        onSalvar={onSalvar}
      />,
    );
    await modoTabela();
    expect(screen.getByText(/4314407/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));
    await waitFor(() => expect(onSalvar).toHaveBeenCalled());
    expect(onSalvar.mock.calls[0][0]).toMatchObject({ city: 'Pelotas', state: 'RS', cityIbge: '4314407' });
  });
});

describe('o formulário do endereço, sem a tabela', () => {
  for (const [caso, tabela] of [
    ['tabela vazia no servidor', 'vazia'],
    ['servidor fora do ar', 'fora'],
  ] as const) {
    it(`${caso}: o campo digitado de hoje continua, com o texto de ajuda`, async () => {
      const { buscas } = servidor(tabela);
      const onSalvar = vi.fn(async (dados: DadosDoEndereco) => void dados);
      render(<FormularioDeEndereco onSalvar={onSalvar} />);
      await waitFor(() => expect(buscas.length).toBeGreaterThan(0));

      expect((screen.getByLabelText('UF') as HTMLElement).tagName).toBe('INPUT');
      const codigo = screen.getByLabelText('Código IBGE do município');
      expect(screen.getByText(/site do IBGE/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Pelotas' } });
      fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'RS' } });
      fireEvent.change(codigo, { target: { value: '4314407' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));
      await waitFor(() => expect(onSalvar).toHaveBeenCalled());
      expect(onSalvar.mock.calls[0][0]).toMatchObject({ city: 'Pelotas', state: 'RS', cityIbge: '4314407' });
    });
  }
});

// ============================================================================

const CONFIG = {
  companyId: 'loja',
  legalName: 'PJ Motors Ltda',
  tradeName: 'PJ Motors',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '96010000',
  street: 'Av. Central',
  number: '100',
  complement: null,
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: '2026-09-11T12:00:00.000Z',
};

describe('o cadastro fiscal do emitente usa o mesmo seletor', () => {
  beforeEach(() => {
    setSession(
      {
        accessToken: 'sem-escopo',
        refreshToken: 'r-1',
        expiresAt: Date.now() + 3_600_000,
        user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
        company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
        companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gestor' }],
      } as never,
      'LOGIN',
      'teste do município do emitente',
    );
  });
  afterEach(() => {
    setSession(null, 'LOGOUT', 'fim do teste');
  });

  function fiscal(url: string, _method: string, body: unknown): Response | undefined {
    if (url.includes('/core/fiscal/config')) return json({ ...CONFIG, ...((body as object) ?? {}) });
    return undefined;
  }

  it('com a tabela, o município é escolhido pelo nome e o código vai junto na configuração', async () => {
    const { enviados } = servidor('carregada', fiscal);
    render(
      <MemoryRouter>
        <FiscalPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect((screen.getByLabelText('UF') as HTMLElement).tagName).toBe('SELECT'));
    expect(screen.queryByLabelText('Código IBGE')).toBeNull();
    expect(screen.getByText(/4314407/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'SP' } });
    fireEvent.change(screen.getByLabelText('Município'), { target: { value: 'sao pa' } });
    fireEvent.click(await screen.findByRole('option', { name: /São Paulo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }));

    await waitFor(() =>
      expect(enviados.find((e) => e.url.includes('/core/fiscal/config'))?.body).toMatchObject({
        cityName: 'São Paulo',
        cityIbge: '3550308',
        uf: 'SP',
      }),
    );
  });

  it('sem a tabela, os três campos digitados de hoje', async () => {
    servidor('vazia', fiscal);
    render(
      <MemoryRouter>
        <FiscalPage />
      </MemoryRouter>,
    );
    const codigo = (await screen.findByLabelText('Código IBGE')) as HTMLInputElement;
    expect(codigo.tagName).toBe('INPUT');
    expect(codigo.value).toBe('4314407');
    expect((screen.getByLabelText('UF') as HTMLElement).tagName).toBe('INPUT');
  });
});
