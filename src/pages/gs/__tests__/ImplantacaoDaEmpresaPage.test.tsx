/**
 * Tela da implantação de uma empresa (GAP-PRD-067).
 *
 * O que não pode falhar:
 *
 * 1. A tela pergunta pela empresa DA URL, e mostra a situação e cada item com
 *    o estado, quem resolve e o link para a tela que resolve.
 * 2. "Confirmar" manda a marca e relê — o estado que aparece é o do servidor.
 * 3. "Não se aplica" não sai sem motivo, e o motivo vai no corpo.
 * 4. A recusa (403 para quem não tem vínculo) aparece escrita.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ImplantacaoDaEmpresaPage from '../ImplantacaoDaEmpresaPage';
import { respostaDaBarraDoShell } from './barraDoShell';

function item(over: Record<string, unknown>) {
  return {
    chave: 'x',
    titulo: 'Item',
    estado: 'PENDENTE',
    detalhe: 'detalhe',
    dono: 'gestor',
    onde: null,
    global: false,
    podeConfirmar: false,
    podeMarcarNaoAplicavel: false,
    marca: null,
    falhaDeLeitura: false,
    ...over,
  };
}

function checklist(cadastroEstado = 'AUTO_DETECTADO') {
  return {
    empresa: { id: 'emp-7', slug: 'setima', nome: 'Sétima Loja', razaoSocial: 'Sétima Ltda', tipo: 'retail', ativa: true },
    avaliadoEm: '2026-09-11T13:00:00.000Z',
    situacao: 'PENDENTE',
    resumo: {
      PRONTO: 1,
      AUTO_DETECTADO: cadastroEstado === 'AUTO_DETECTADO' ? 1 : 0,
      CONFIRMADO: cadastroEstado === 'CONFIRMADO' ? 1 : 0,
      PENDENTE: 1,
      DIVERGENTE: 0,
      NAO_APLICAVEL: 0,
      BLOQUEADO_EXTERNAMENTE: 1,
    },
    areas: [
      {
        area: 'empresa',
        titulo: 'Empresa',
        itens: [
          item({
            chave: 'empresa.cadastro',
            titulo: 'Cadastro da empresa',
            estado: cadastroEstado,
            detalhe: 'Sétima Ltda · CNPJ 11222333000181.',
            onde: '/sistema/empresas',
            podeConfirmar: true,
          }),
        ],
      },
      {
        area: 'fiscal',
        titulo: 'Fiscal',
        itens: [
          item({
            chave: 'fiscal.certificado',
            titulo: 'Certificado digital A1',
            estado: 'BLOQUEADO_EXTERNAMENTE',
            detalhe: 'Nenhum certificado carregado.',
            dono: 'dono',
            onde: '/sistema/fiscal/certificado',
            podeMarcarNaoAplicavel: true,
          }),
        ],
      },
      {
        area: 'grupo',
        titulo: 'Serviços do grupo',
        itens: [
          item({ chave: 'grupo.email', titulo: 'E-mail de saída', estado: 'PENDENTE', global: true, dono: 'dono' }),
          item({ chave: 'grupo.versao_do_banco', titulo: 'Banco na versão', estado: 'PRONTO', global: true }),
        ],
      },
    ],
  };
}

interface Chamada {
  url: string;
  metodo: string;
  corpo: unknown;
}

function servidor(responder: (c: Chamada) => { status: number; corpo: unknown }) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      const c = { url: String(url), metodo: (init?.method ?? 'GET').toUpperCase(), corpo: init?.body ? JSON.parse(init.body) : null };
      chamadas.push(c);
      const { status, corpo } = responder(c);
      return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/empresas/emp-7/implantacao']}>
      <Routes>
        <Route path="/sistema/empresas/:companyId/implantacao" element={<ImplantacaoDaEmpresaPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('ImplantacaoDaEmpresaPage', () => {
  it('pergunta pela empresa da URL e mostra situação, estado, quem resolve e onde', async () => {
    const chamadas = servidor(() => ({ status: 200, corpo: checklist() }));
    montar();
    expect(await screen.findByText('HÁ O QUE FAZER')).toBeTruthy();
    expect(chamadas[0].url.endsWith('/api/v1/system/implantacao/empresas/emp-7')).toBe(true);
    expect(screen.getByText('Implantação — Sétima Loja')).toBeTruthy();

    const cert = screen.getByTestId('item-fiscal.certificado');
    expect(within(cert).getByText('BLOQUEADO EXTERNAMENTE')).toBeTruthy();
    expect(within(cert).getByText(/Quem resolve: o dono do sistema/)).toBeTruthy();
    expect(within(cert).getByRole('link', { name: 'Abrir a tela' }).getAttribute('href')).toBe('/sistema/fiscal/certificado');

    // O que é do grupo vem marcado como tal.
    expect(within(screen.getByTestId('item-grupo.email')).getByText('do grupo')).toBeTruthy();
    expect(screen.getByTestId('resumo').textContent).toMatch(/1 pendente/);
  });

  it('"Confirmar" manda a marca e relê o que o servidor diz', async () => {
    let confirmado = false;
    const chamadas = servidor((c) => {
      if (c.metodo === 'PUT') {
        confirmado = true;
        return { status: 200, corpo: { item: item({ chave: 'empresa.cadastro', estado: 'CONFIRMADO' }) } };
      }
      return { status: 200, corpo: checklist(confirmado ? 'CONFIRMADO' : 'AUTO_DETECTADO') };
    });
    montar();
    const cadastro = await screen.findByTestId('item-empresa.cadastro');
    expect(within(cadastro).getByText('AUTO-DETECTADO')).toBeTruthy();
    fireEvent.click(within(cadastro).getByRole('button', { name: 'Confirmar que está certo' }));
    await waitFor(() => expect(within(screen.getByTestId('item-empresa.cadastro')).getByText('CONFIRMADO')).toBeTruthy());
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(put.url.endsWith('/system/implantacao/empresas/emp-7/itens/empresa.cadastro/marca')).toBe(true);
    expect(put.corpo).toEqual({ tipo: 'CONFIRMADO' });
  });

  it('"não se aplica" não sai sem motivo, e o motivo vai no corpo', async () => {
    const chamadas = servidor((c) =>
      c.metodo === 'PUT'
        ? { status: 200, corpo: { item: item({ chave: 'fiscal.certificado', estado: 'NAO_APLICAVEL' }) } }
        : { status: 200, corpo: checklist() },
    );
    montar();
    const cert = await screen.findByTestId('item-fiscal.certificado');
    fireEvent.click(within(cert).getByRole('button', { name: 'Não se aplica a esta empresa' }));
    const gravar = within(cert).getByRole('button', { name: 'Gravar “não se aplica”' }) as HTMLButtonElement;
    expect(gravar.disabled).toBe(true);
    fireEvent.change(within(cert).getByLabelText('Por que não se aplica?'), {
      target: { value: 'Esta empresa não emite nota.' },
    });
    expect(gravar.disabled).toBe(false);
    fireEvent.click(gravar);
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      tipo: 'NAO_APLICAVEL',
      motivo: 'Esta empresa não emite nota.',
    });
  });

  it('a recusa do servidor aparece escrita', async () => {
    servidor(() => ({
      status: 403,
      corpo: { error: { code: 'API_TENANT_MISMATCH', message: 'Empresa não autorizada.' } },
    }));
    montar();
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toMatch(/vínculo nela/);
  });
});
