/**
 * A ENTRADA DE NOTAS PEDE A SENHA DO A1 SÓ QUANDO A POLÍTICA PEDE — GAP-PRD-168.
 *
 * A tela mandava `{}` para consultar a Distribuição DF-e e `{tipo}` para
 * manifestar, e não tinha onde digitar a senha do certificado. Com o servidor
 * decidindo pela política dos atos (cofre ou senha digitada), a tela passou a:
 *
 *  - mostrar o caminho do certificado no quadro da SEFAZ, como os atos;
 *  - com o COFRE, mandar o pedido direto — sem diálogo, sem campo de senha;
 *  - com "cada ato pede a senha", abrir o diálogo da casa (foco preso, nada de
 *    `window.prompt`) com um campo de senha, e só então enviar — com a senha
 *    no corpo, que some quando o diálogo fecha;
 *  - se o servidor pedir a senha que o plano não previa (a política mudou no
 *    meio), abrir o mesmo diálogo com o motivo e reenviar;
 *  - com o ato BLOQUEADO (sem A1), dizer por quê e não armar o botão.
 *
 * ## Como fica vermelho
 *
 *  - tire o diálogo e o caso "pede a senha" não acha o campo;
 *  - esqueça a senha no corpo e o POST sai sem `certificatePassword`;
 *  - abra o diálogo sempre e o caso do cofre acha um campo que não devia existir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import EntradaNotasPage from '../EntradaNotasPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const CHAVE = '4'.repeat(44);
const POLITICA = { exigirSenhaDigitada: false, atualizadoEm: null, atualizadoPor: null };

const COFRE = {
  caminho: 'SEFAZ',
  ambiente: 'production',
  senha: 'OPCIONAL',
  cofre: 'SELADO',
  codigo: null,
  motivo: 'Vai à SEFAZ (produção) com o certificado A1 do cofre desta operação.',
  politica: POLITICA,
};

const PEDE_SENHA = {
  ...COFRE,
  senha: 'OBRIGATORIA',
  motivo: 'Vai à SEFAZ (produção). A política desta operação exige a senha do certificado a cada ato.',
  politica: { ...POLITICA, exigirSenhaDigitada: true },
};

const SEM_A1 = {
  ...COFRE,
  caminho: 'BLOQUEADO',
  senha: 'NAO_SE_APLICA',
  cofre: 'AUSENTE',
  codigo: 'CORE_SEFAZ_CERTIFICATE_MISSING',
  motivo:
    'Este ato vai à SEFAZ (produção) e precisa do certificado A1 da operação, que não está no cofre. '
    + 'Envie o .pfx em Fiscal › Certificado.',
};

let plano: Record<string, unknown> | undefined;
let posts: { url: string; corpo: Record<string, unknown> }[];
/** A resposta da consulta, pedido a pedido — para o servidor que pede a senha no meio. */
let consulta: (corpo: Record<string, unknown>) => { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const barra = respostaDaBarraDoShell(url);
    if (barra) return barra;
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (metodo === 'POST') posts.push({ url: alvo, corpo });

    if (alvo.includes('/purchases/dfe/consultar')) {
      const r = consulta(corpo);
      return json(r.body, r.status);
    }
    if (alvo.includes(`/purchases/dfe/${CHAVE}/manifestar`)) return json({ accessKey: CHAVE, manifestStatus: corpo.tipo });
    if (alvo.endsWith('/purchases/dfe')) {
      return json({
        items: [
          {
            nsu: '1',
            schemaType: 'resNFe',
            accessKey: CHAVE,
            supplierCnpj: '14200166000187',
            supplierName: 'Distribuidora Real Ltda',
            totalCents: 15000,
            issuedAt: '2026-09-10T10:00:00-03:00',
            manifestStatus: null,
            manifestProtocol: null,
            manifestedAt: null,
            importedNoteId: null,
            noteStatus: null,
            temXmlCompleto: false,
            receivedAt: '2026-09-10T13:00:00.000Z',
          },
        ],
        ...(plano ? { plano } : {}),
      });
    }
    return json({ items: [] });
  });
}

function entrar(profileCode = 'gerente_loja') {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste do GAP-PRD-168',
  );
}

async function montar() {
  render(
    <MemoryRouter>
      <EntradaNotasPage />
    </MemoryRouter>,
  );
  await screen.findByText('Distribuidora Real Ltda');
}

function consultas() {
  return posts.filter((p) => p.url.includes('/purchases/dfe/consultar'));
}

beforeEach(() => {
  posts = [];
  plano = undefined;
  consulta = () => ({ status: 200, body: { novos: 1, total: 1, ultimoNsu: 1 } });
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste do GAP-PRD-168');
  localStorage.clear();
});

describe('política COFRE: nada é pedido', () => {
  it('o quadro diz o caminho, e Buscar agora vai direto — sem diálogo nem campo de senha', async () => {
    plano = COFRE;
    await montar();

    expect(await screen.findByText('Vai à SEFAZ (produção).')).toBeTruthy();
    expect(screen.getByText(/com o certificado A1 do cofre desta operação/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    await screen.findByText('1 documento(s) novo(s) da SEFAZ.');

    expect(consultas()).toHaveLength(1);
    expect(consultas()[0].corpo).not.toHaveProperty('certificatePassword');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText(/Senha do certificado A1/)).toBeNull();
  });

  it('a manifestação também vai direto, com o corpo de sempre', async () => {
    plano = COFRE;
    await montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ciência' }));
    await waitFor(() => expect(posts.some((p) => p.url.includes('/manifestar'))).toBe(true));
    const post = posts.find((p) => p.url.includes('/manifestar'))!;
    expect(post.corpo.tipo).toBe('ciencia');
    expect(post.corpo).not.toHaveProperty('certificatePassword');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('política "cada ato pede a senha": o diálogo da casa pede, e a senha vai no corpo', () => {
  it('Buscar agora abre o diálogo com o campo de senha; só depois dela o pedido sai', async () => {
    plano = PEDE_SENHA;
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    const dialogo = await screen.findByRole('dialog');
    expect(consultas()).toHaveLength(0);

    const campo = within(dialogo).getByLabelText(/Senha do certificado A1/) as HTMLInputElement;
    expect(campo.type).toBe('password');
    const enviar = within(dialogo).getByRole('button', { name: 'Enviar à SEFAZ' }) as HTMLButtonElement;
    expect(enviar.disabled).toBe(true);

    fireEvent.change(campo, { target: { value: 'senha-do-a1' } });
    expect(enviar.disabled).toBe(false);
    fireEvent.click(enviar);

    await waitFor(() => expect(consultas()).toHaveLength(1));
    expect(consultas()[0].corpo).toEqual({ certificatePassword: 'senha-do-a1' });
    await screen.findByText('1 documento(s) novo(s) da SEFAZ.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a manifestação pede de novo — a senha não fica guardada na tela', async () => {
    plano = PEDE_SENHA;
    await montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Ciência' }));
    const dialogo = await screen.findByRole('dialog');
    const campo = within(dialogo).getByLabelText(/Senha do certificado A1/) as HTMLInputElement;
    expect(campo.value).toBe('');
    fireEvent.change(campo, { target: { value: 'senha-do-a1' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Enviar à SEFAZ' }));

    await waitFor(() => expect(posts.some((p) => p.url.includes('/manifestar'))).toBe(true));
    const post = posts.find((p) => p.url.includes('/manifestar'))!;
    expect(post.corpo).toMatchObject({ tipo: 'ciencia', certificatePassword: 'senha-do-a1' });
  });

  it('Voltar fecha o diálogo e nada é enviado', async () => {
    plano = PEDE_SENHA;
    await montar();
    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(consultas()).toHaveLength(0);
  });
});

describe('o servidor decide: a tela obedece', () => {
  it('se o servidor pedir a senha que o plano não previa, o diálogo abre com o motivo e reenvia', async () => {
    plano = COFRE;
    const motivo =
      'A política desta operação exige a senha do certificado A1 em cada ato com a SEFAZ. '
      + 'Digite a senha do certificado para continuar.';
    consulta = (corpo) =>
      corpo.certificatePassword
        ? { status: 200, body: { novos: 0, total: 0, ultimoNsu: 1 } }
        : { status: 400, body: { error: { code: 'CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED', message: motivo } } };
    await montar();

    fireEvent.click(screen.getByRole('button', { name: 'Buscar agora' }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByText(motivo)).toBeTruthy();

    fireEvent.change(within(dialogo).getByLabelText(/Senha do certificado A1/), { target: { value: 'senha-do-a1' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Enviar à SEFAZ' }));

    await waitFor(() => expect(consultas()).toHaveLength(2));
    expect(consultas()[1].corpo).toEqual({ certificatePassword: 'senha-do-a1' });
    await screen.findByText('Nenhum documento novo — a caixa da SEFAZ está em dia.');
  });

  it('sem A1 no cofre, o quadro diz o que falta e o botão não arma', async () => {
    plano = SEM_A1;
    await montar();
    expect(await screen.findByText('Este ato não pode sair agora.')).toBeTruthy();
    expect(screen.getByText(/não está no cofre/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Buscar agora' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Ciência' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
