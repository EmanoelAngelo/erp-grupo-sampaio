/**
 * GAP-PRD-192 — a tela de criar conta pede o NOME e a senha DUAS vezes; a
 * tela de redefinir pelo link também confere a confirmação; e a recusa do
 * servidor (senha das mais usadas, teto de cadastros) aparece com as
 * palavras dele.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MinhaContaPage from '@/pages/gs/MinhaContaPage';
import RedefinirSenhaPage from '@/pages/gs/RedefinirSenhaPage';
import { problemaDaSenhaNova } from '@/lib/senhaNova';

type Resposta = { status: number; body: unknown };

function servidor(rotas: Record<string, () => Resposta>) {
  const fake = vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
    const alvo = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [padrao, responder] of Object.entries(rotas)) {
      const [m, caminho] = padrao.split(' ');
      if (m === method && alvo.includes(caminho)) {
        const r = responder();
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: 'rota não mockada' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fake);
  return fake;
}

function chamouRegistrar(fake: ReturnType<typeof servidor>) {
  return fake.mock.calls.some((c) => String(c[0]).includes('/portal/registrar'));
}

async function abrirCriar() {
  render(
    <MemoryRouter initialEntries={['/minha-conta']}>
      <Routes>
        <Route path="/minha-conta" element={<MinhaContaPage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Ainda não tenho acesso'));
}

function preencher(campos: Record<string, string>) {
  for (const [rotulo, valor] of Object.entries(campos)) {
    fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });
  }
  fireEvent.click(screen.getByLabelText('Aceito os termos e a política de privacidade'));
  fireEvent.click(screen.getByRole('button', { name: 'Criar acesso' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('GAP-PRD-192 — criar conta', () => {
  it('pede nome, senha e a confirmação — os três obrigatórios', async () => {
    servidor({});
    await abrirCriar();
    expect((screen.getByLabelText('Nome') as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText('Senha') as HTMLInputElement).required).toBe(true);
    const confirma = screen.getByLabelText('Confirme a senha') as HTMLInputElement;
    expect(confirma.required).toBe(true);
    expect(confirma.type).toBe('password');
  });

  it('senhas diferentes: a tela avisa e NÃO chama o servidor', async () => {
    const fake = servidor({});
    await abrirCriar();
    preencher({
      Nome: 'Ana Souza',
      'E-mail': 'ana@exemplo.com',
      Senha: 'cavalo-bateria-grampo',
      'Confirme a senha': 'cavalo-bateria-grampa',
    });
    expect(await screen.findByText(/não são iguais\. Digite a mesma senha/)).toBeTruthy();
    expect(chamouRegistrar(fake)).toBe(false);
  });

  it('nome em branco: a tela pede o nome e NÃO chama o servidor', async () => {
    const fake = servidor({});
    await abrirCriar();
    preencher({
      Nome: '   ',
      'E-mail': 'ana@exemplo.com',
      Senha: 'cavalo-bateria-grampo',
      'Confirme a senha': 'cavalo-bateria-grampo',
    });
    expect(await screen.findByText('Informe seu nome.')).toBeTruthy();
    expect(chamouRegistrar(fake)).toBe(false);
  });

  it('senha das mais usadas: a recusa do servidor aparece com as palavras dele', async () => {
    servidor({
      'POST /loja/portal/registrar': () => ({
        status: 400,
        body: {
          error: {
            code: 'PORTAL_WEAK_PASSWORD',
            message: 'Essa senha está entre as mais usadas e é das primeiras que um invasor tenta.',
          },
        },
      }),
    });
    await abrirCriar();
    preencher({
      Nome: 'Ana Souza',
      'E-mail': 'ana@exemplo.com',
      Senha: 'senha123',
      'Confirme a senha': 'senha123',
    });
    expect(await screen.findByText(/entre as mais usadas/)).toBeTruthy();
  });

  it('teto de cadastros da conexão: o 429 aparece com a frase do servidor', async () => {
    servidor({
      'POST /loja/portal/registrar': () => ({
        status: 429,
        body: {
          error: {
            code: 'PORTAL_LIMITE_CADASTRO',
            message: 'Muitas contas criadas a partir desta conexão na última hora.',
            details: { tenteEmMinutos: 40 },
          },
        },
      }),
    });
    await abrirCriar();
    preencher({
      Nome: 'Ana Souza',
      'E-mail': 'ana@exemplo.com',
      Senha: 'cavalo-bateria-grampo',
      'Confirme a senha': 'cavalo-bateria-grampo',
    });
    expect(await screen.findByText(/Muitas contas criadas/)).toBeTruthy();
  });
});

describe('GAP-PRD-192 — redefinir pelo link', () => {
  function abrirRedefinir() {
    render(
      <MemoryRouter initialEntries={['/redefinir-senha?token=tok-123']}>
        <Routes>
          <Route path="/redefinir-senha" element={<RedefinirSenhaPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('confirmação diferente não gasta o link', async () => {
    const fake = servidor({});
    abrirRedefinir();
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'cavalo-bateria-grampo' } });
    fireEvent.change(screen.getByLabelText('Confirme a nova senha'), { target: { value: 'outra-coisa-qualquer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    expect(await screen.findByText(/não são iguais\. Digite a mesma senha/)).toBeTruthy();
    expect(fake.mock.calls.some((c) => String(c[0]).includes('/redefinir-senha'))).toBe(false);
  });

  it('iguais: manda a senha com o token do link', async () => {
    const fake = servidor({ 'POST /loja/portal/redefinir-senha': () => ({ status: 200, body: { ok: true } }) });
    abrirRedefinir();
    fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: 'cavalo-bateria-grampo' } });
    fireEvent.change(screen.getByLabelText('Confirme a nova senha'), { target: { value: 'cavalo-bateria-grampo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    expect(await screen.findByText(/Senha redefinida/)).toBeTruthy();
    const init = fake.mock.calls.find((c) => String(c[0]).includes('/redefinir-senha'))![1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ token: 'tok-123', password: 'cavalo-bateria-grampo' });
  });
});

describe('problemaDaSenhaNova', () => {
  it('confere comprimento e igualdade, e mais nada', () => {
    expect(problemaDaSenhaNova('curta', 'curta')).toMatch(/8 caracteres/);
    expect(problemaDaSenhaNova('x'.repeat(129), 'x'.repeat(129))).toMatch(/128/);
    expect(problemaDaSenhaNova('uma-frase-boa', 'uma-frase-ruim')).toMatch(/não são iguais/);
    expect(problemaDaSenhaNova('uma-frase-boa', 'uma-frase-boa')).toBeNull();
  });
});
