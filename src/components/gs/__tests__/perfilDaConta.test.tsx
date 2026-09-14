/**
 * "Meus dados" — GAP-PRD-133 e GAP-PRD-205, na tela.
 *
 * O servidor passou a guardar nome, telefone e CPF/CNPJ na CONTA. A tela
 * cobra três coisas:
 *
 *   - o documento se declara uma vez: sem documento, o campo é editável e vai
 *     no PUT; com documento, a tela mostra só o final e o PUT não o manda;
 *   - "Dados atualizados." só aparece quando o servidor devolveu o perfil — a
 *     recusa (CPF com dígito errado) aparece com a mensagem do servidor;
 *   - na conta antiga, o nome que veio do cadastro diz de onde veio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContaDoCliente } from '../ContaDoCliente';

const TOKEN = 'tok-portal';

type Chamada = { url: string; method: string; body: Record<string, unknown> | null };

function servidor(perfil: Record<string, unknown>, aoSalvar?: (corpo: Record<string, unknown>) => Response) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      chamadas.push({ url: alvo, method, body });
      if (alvo.includes('/loja/portal/perfil') && method === 'PUT' && aoSalvar) return aoSalvar(body ?? {});
      const corpo = alvo.includes('/loja/portal/perfil') ? perfil : { items: [] };
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SEM_DOCUMENTO = {
  email: 'ana@exemplo.com',
  name: null,
  phone: null,
  nameSource: null,
  documentMasked: null,
  hasDocument: false,
  faltando: ['nome', 'documento', 'telefone'],
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('o CPF/CNPJ da conta', () => {
  it('sem documento, o campo é editável e o salvar manda o documento', async () => {
    const chamadas = servidor(SEM_DOCUMENTO, (corpo) =>
      json({
        ...SEM_DOCUMENTO,
        name: corpo.name,
        phone: corpo.phone,
        nameSource: 'conta',
        hasDocument: true,
        documentMasked: '••• 7735',
        faltando: [],
      }),
    );
    render(<ContaDoCliente token={TOKEN} />);
    await screen.findByText('Meus dados');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Nova' } });
    fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '11988887777' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '111.444.777-35' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar dados' }));

    await screen.findByText('Dados atualizados.');
    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ name: 'Ana Nova', phone: '11988887777', document: '111.444.777-35' });
    // Depois de salvo, o documento vira só leitura, mascarado.
    const campo = screen.getByLabelText('CPF ou CNPJ') as HTMLInputElement;
    expect(campo.disabled).toBe(true);
    expect(campo.value).toBe('••• 7735');
  });

  it('com documento, a tela mostra só o final e o salvar não o manda', async () => {
    const chamadas = servidor(
      { ...SEM_DOCUMENTO, name: 'Ana', phone: '11988887777', nameSource: 'conta', hasDocument: true, documentMasked: '••• 7735' },
      (corpo) => json({ ...SEM_DOCUMENTO, name: corpo.name, phone: corpo.phone, hasDocument: true, documentMasked: '••• 7735' }),
    );
    render(<ContaDoCliente token={TOKEN} />);
    await screen.findByText('Meus dados');

    expect((screen.getByLabelText('CPF ou CNPJ') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Para trocar o CPF/CNPJ da conta, fale com a loja.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar dados' }));
    await screen.findByText('Dados atualizados.');
    const put = chamadas.find((c) => c.method === 'PUT')!;
    expect(put.body).not.toHaveProperty('document');
  });

  it('a recusa do servidor aparece com a mensagem dele — e "Dados atualizados." não', async () => {
    servidor(SEM_DOCUMENTO, () =>
      json(
        {
          error: {
            code: 'PORTAL_INVALID_DOCUMENT',
            message: 'CPF ou CNPJ inválido: confira os números — os dígitos finais não conferem.',
          },
        },
        400,
      ),
    );
    render(<ContaDoCliente token={TOKEN} />);
    await screen.findByText('Meus dados');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('CPF ou CNPJ'), { target: { value: '111.444.777-00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar dados' }));

    await screen.findByText(/os dígitos finais não conferem/);
    expect(screen.queryByText('Dados atualizados.')).toBeNull();
  });
});

describe('de onde vem o nome (GAP-PRD-205)', () => {
  it('conta antiga: o nome do cadastro vem com o aviso de onde veio', async () => {
    servidor({ ...SEM_DOCUMENTO, name: 'Nome do Preço Justo', nameSource: 'cadastro' });
    render(<ContaDoCliente token={TOKEN} />);

    await screen.findByText(/Veio do cadastro da sua compra mais recente/);
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Nome do Preço Justo');
  });

  it('nome da conta: sem aviso nenhum', async () => {
    servidor({ ...SEM_DOCUMENTO, name: 'Ana', nameSource: 'conta' });
    render(<ContaDoCliente token={TOKEN} />);

    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Ana'));
    expect(screen.queryByText(/Veio do cadastro/)).toBeNull();
  });
});
