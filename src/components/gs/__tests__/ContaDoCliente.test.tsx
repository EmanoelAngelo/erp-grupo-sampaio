/**
 * Endereços e senha, na tela.
 *
 * O backend já garantia as regras; esta é a parte que o cliente toca. O que se
 * cobra aqui é o que a tela promete e o que ela avisa ANTES de agir — trocar a
 * senha derruba as outras sessões, e descobrir isso pelo celular deslogado é
 * susto desnecessário.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContaDoCliente } from '../ContaDoCliente';

const TOKEN = 'tok-portal';

function endereco(over: Record<string, unknown> = {}) {
  return {
    id: 'end-1',
    label: 'Casa',
    zip: '01001000',
    street: 'Praça da Sé',
    number: '100',
    complement: null,
    district: 'Sé',
    city: 'São Paulo',
    state: 'SP',
    isDefault: true,
    ...over,
  };
}

function servidor(rotas: Record<string, () => unknown>) {
  const chamadas: { url: string; method: string; body: unknown; token: string | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        url: string | URL | Request,
        init?: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        const alvo = String(url);
        chamadas.push({
          url: alvo,
          method: (init?.method ?? 'GET').toUpperCase(),
          body: init?.body ? JSON.parse(init.body) : null,
          token: init?.headers?.['x-portal-token'],
        });
        for (const [padrao, responder] of Object.entries(rotas)) {
          const [m, caminho] = padrao.split(' ');
          if (m === (init?.method ?? 'GET') && alvo.includes(caminho)) {
            return new Response(JSON.stringify(responder()), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    ),
  );
  return chamadas;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('endereços', () => {
  it('mostra o endereço salvo e marca o padrão', async () => {
    servidor({ 'GET /loja/portal/enderecos': () => ({ items: [endereco()] }) });
    render(<ContaDoCliente token={TOKEN} />);

    await screen.findByText('Padrão');
    expect(screen.getByText(/Praça da Sé/)).toBeTruthy();
    expect(screen.getByText(/São Paulo\/SP · CEP 01001-000/)).toBeTruthy();
  });

  it('sem endereço, explica por que vale a pena salvar um', async () => {
    servidor({ 'GET /loja/portal/enderecos': () => ({ items: [] }) });
    render(<ContaDoCliente token={TOKEN} />);

    await screen.findByText(/evita digitar tudo na próxima compra/);
  });

  it('o endereço padrão não oferece "usar como padrão"', async () => {
    servidor({ 'GET /loja/portal/enderecos': () => ({ items: [endereco()] }) });
    render(<ContaDoCliente token={TOKEN} />);

    await screen.findByText('Padrão');
    // Botão que não muda nada é ruído na tela.
    expect(screen.queryByRole('button', { name: 'Usar como padrão' })).toBeNull();
  });

  it('o não padrão oferece, e a chamada leva o token', async () => {
    const chamadas = servidor({
      'GET /loja/portal/enderecos': () => ({ items: [endereco({ isDefault: false })] }),
      'POST /padrao': () => ({ items: [endereco()] }),
    });
    render(<ContaDoCliente token={TOKEN} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Usar como padrão' }));

    await screen.findByText('Padrão');
    const post = chamadas.find((c) => c.method === 'POST');
    expect(post!.url).toContain('/enderecos/end-1/padrao');
    expect(post!.token).toBe(TOKEN);
  });

  it('salvar manda os campos preenchidos', async () => {
    const chamadas = servidor({ 'GET /loja/portal/enderecos': () => ({ items: [] }) });
    render(<ContaDoCliente token={TOKEN} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar endereço' }));
    fireEvent.change(screen.getByLabelText('CEP'), { target: { value: '01001-000' } });
    fireEvent.change(screen.getByLabelText('Rua'), { target: { value: 'Praça da Sé' } });
    fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'São Paulo' } });
    fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'SP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar endereço' }));

    const post = chamadas.find((c) => c.method === 'POST');
    const corpo = post!.body as Record<string, string>;
    expect(corpo.zip).toBe('01001-000');
    expect(corpo.city).toBe('São Paulo');
  });
});

describe('troca de senha', () => {
  it('avisa o efeito ANTES de a pessoa clicar', async () => {
    servidor({ 'GET /loja/portal/enderecos': () => ({ items: [] }) });
    render(<ContaDoCliente token={TOKEN} />);

    // Descobrir que o celular deslogou sem entender por quê é susto evitável.
    await screen.findByText(/encerra as sessões abertas em outros aparelhos/);
  });

  it('manda a senha atual junto — o servidor exige', async () => {
    const chamadas = servidor({
      'GET /loja/portal/enderecos': () => ({ items: [] }),
      'POST /loja/portal/senha': () => ({ message: 'Senha alterada.' }),
    });
    render(<ContaDoCliente token={TOKEN} />);

    fireEvent.change(await screen.findByLabelText('Senha atual'), {
      target: { value: 'a-antiga' },
    });
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'a-nova-maior' } });
    fireEvent.change(screen.getByLabelText('Confirme a nova senha'), { target: { value: 'a-nova-maior' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await screen.findByText('Senha alterada.');
    const post = chamadas.find((c) => c.url.includes('/senha'));
    expect((post!.body as Record<string, string>).currentPassword).toBe('a-antiga');
  });

  it('os campos de senha são do tipo password — não ficam à mostra', async () => {
    servidor({ 'GET /loja/portal/enderecos': () => ({ items: [] }) });
    render(<ContaDoCliente token={TOKEN} />);

    const atual = (await screen.findByLabelText('Senha atual')) as HTMLInputElement;
    const nova = screen.getByLabelText('Nova senha') as HTMLInputElement;
    expect(atual.type).toBe('password');
    expect(nova.type).toBe('password');
  });

  it('a senha digitada não sobra no DOM depois de trocar', async () => {
    servidor({
      'GET /loja/portal/enderecos': () => ({ items: [] }),
      'POST /loja/portal/senha': () => ({ message: 'Senha alterada.' }),
    });
    render(<ContaDoCliente token={TOKEN} />);

    fireEvent.change(await screen.findByLabelText('Senha atual'), { target: { value: 'a-antiga' } });
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'a-nova-maior' } });
    fireEvent.change(screen.getByLabelText('Confirme a nova senha'), { target: { value: 'a-nova-maior' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));

    await screen.findByText('Senha alterada.');
    expect(document.body.innerHTML).not.toContain('a-nova-maior');
  });
});
