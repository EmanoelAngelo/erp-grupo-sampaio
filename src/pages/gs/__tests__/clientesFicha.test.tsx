/**
 * A FICHA DO CLIENTE FECHA O CICLO — criar, editar e inativar, que o servidor já sabia.
 *
 * `GET` e `PUT /core/customers/:id` existem do lado de lá, com validação de
 * CPF, dedupe e o campo `active` — e nenhuma tela chamava. O cadastro era
 * write-once na prática: telefone digitado errado no balcão ficava errado para
 * sempre, e a coluna `active` tinha leitor (`listCustomers` filtra `active = 1`)
 * e nenhum escritor ao alcance de gente.
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire o botão Novo cliente e `POST /core/customers` volta a ser código
 *     morto: o balcão não tem como cadastrar cliente com CPF antes da venda;
 *   - tire o botão Editar e a rota de edição volta a ser código morto;
 *   - preencha o formulário pela LINHA da lista em vez do GET e a edição parte
 *     de uma ficha velha — o que outro balcão corrigiu há um minuto é
 *     sobrescrito de volta;
 *   - engula o erro do CPF e o operador sai achando que corrigiu o documento
 *     que a SEFAZ vai recusar na próxima venda;
 *   - inative sem confirmação e um clique perdido some com o cliente da busca
 *     do balcão inteiro;
 *   - tire o Reativar do aviso e a inativação por engano vira beco sem saída:
 *     a lista só mostra ativos, então não haveria de onde desfazer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { ClientesPage } from '../OperacaoPages';

/** As linhas do "banco" — o mock aplica o PUT/POST nelas, como o servidor faria. */
let clientes: Record<string, unknown>[] = [];

/** Os corpos que a tela mandou para `PUT /core/customers/:id`. */
let edicoes: { url: string; body: Record<string, unknown> }[] = [];

/** Resposta forçada do PUT — para os testes de recusa do servidor. */
let respostaDaEdicao: { status: number; body: unknown } | null = null;

/** Os corpos que a tela mandou para `POST /core/customers`. */
let criacoes: { url: string; body: Record<string, unknown> }[] = [];

/** Resposta forçada do POST — CPF inválido e duplicata chegam por aqui. */
let respostaDaCriacao: { status: number; body: unknown } | null = null;

function novoBanco() {
  return [
    {
      id: 'c-revenda',
      name: 'PJ Motos Revenda',
      document: '11222333000181',
      email: null,
      phone: null,
      address: null,
      notes: null,
      active: 1,
      price_table_id: null,
    },
    {
      id: 'c-final',
      name: 'Maria da Silva',
      document: null,
      email: 'maria@exemplo.com',
      phone: '96 99999-0000',
      address: 'Rua das Laranjeiras, 10',
      notes: 'Prefere retirar na loja.',
      active: 1,
      price_table_id: null,
    },
  ];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/catalog/aux')) {
      return json({ units: [], taxGroups: [], taxRates: [], priceTables: [] });
    }

    const ficha = alvo.match(/\/core\/customers\/([^/?]+)$/);
    if (ficha && metodo === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      edicoes.push({ url: alvo, body });
      if (respostaDaEdicao) return json(respostaDaEdicao.body, respostaDaEdicao.status);
      const cliente = clientes.find((c) => c.id === ficha[1]);
      if (!cliente) {
        return json(
          { error: { code: 'CORE_CUSTOMER_NOT_FOUND', message: 'Cliente não encontrado.' } },
          404,
        );
      }
      // Espelho do `atualizarCliente` do servidor: campo AUSENTE preserva,
      // enviado vazio limpa; `active` vira 0/1 como na coluna.
      for (const campo of ['name', 'document', 'email', 'phone', 'address', 'notes'] as const) {
        if (campo in body) cliente[campo] = String(body[campo] ?? '').trim() || null;
      }
      if ('active' in body) cliente.active = body.active ? 1 : 0;
      return json(cliente);
    }
    if (ficha && metodo === 'GET') {
      const cliente = clientes.find((c) => c.id === ficha[1]);
      if (!cliente) {
        return json(
          { error: { code: 'CORE_CUSTOMER_NOT_FOUND', message: 'Cliente não encontrado.' } },
          404,
        );
      }
      return json(cliente);
    }

    if (alvo.includes('/core/customers') && metodo === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      criacoes.push({ url: alvo, body });
      if (respostaDaCriacao) return json(respostaDaCriacao.body, respostaDaCriacao.status);
      // Espelho do cadastro do servidor: vazio vira null, e o novo já nasce ativo.
      const cliente: Record<string, unknown> = {
        id: `c-novo-${criacoes.length}`,
        name: String(body.name ?? '').trim(),
        document: null,
        email: null,
        phone: null,
        address: null,
        notes: null,
        active: 1,
        price_table_id: null,
      };
      for (const campo of ['document', 'email', 'phone', 'address', 'notes'] as const) {
        if (campo in body) cliente[campo] = String(body[campo] ?? '').trim() || null;
      }
      clientes.push(cliente);
      return json(cliente, 201);
    }

    if (alvo.includes('/core/customers')) {
      // Como o servidor: a lista SÓ devolve ativos — inativar é sumir daqui.
      return json({ items: clientes.filter((c) => c.active === 1) });
    }

    return json({ items: [] });
  });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste da ficha do cliente',
  );
}

beforeEach(() => {
  clientes = novoBanco();
  edicoes = [];
  respostaDaEdicao = null;
  criacoes = [];
  respostaDaCriacao = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <ClientesPage />
    </MemoryRouter>,
  );
}

function chamadasDoFetch(): unknown[][] {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

describe('editar a ficha', () => {
  it('o formulário abre preenchido pela FICHA do servidor, não pela linha da lista', async () => {
    entrarComo('atendente');
    montar();

    fireEvent.click(await screen.findByLabelText('Editar cadastro de Maria da Silva'));

    // O que se edita é o que o GET devolveu agora — inclusive endereço e
    // observações, que a coluna da lista nem mostra.
    const telefone = (await screen.findByLabelText('Telefone')) as HTMLInputElement;
    await waitFor(() => expect(telefone.value).toBe('96 99999-0000'));
    expect((screen.getByLabelText('Endereço') as HTMLInputElement).value).toBe(
      'Rua das Laranjeiras, 10',
    );
    expect((screen.getByLabelText('Observações') as HTMLInputElement).value).toBe(
      'Prefere retirar na loja.',
    );

    const buscouAFicha = chamadasDoFetch().some(
      (c) => /\/core\/customers\/c-final$/.test(String(c[0]))
        && ((c[1] as { method?: string } | undefined)?.method ?? 'GET').toUpperCase() === 'GET',
    );
    expect(buscouAFicha).toBe(true);
  });

  it('salvar o telefone vai pela rota da ficha e a lista reflete', async () => {
    entrarComo('atendente');
    montar();

    fireEvent.click(await screen.findByLabelText('Editar cadastro de Maria da Silva'));
    const telefone = (await screen.findByLabelText('Telefone')) as HTMLInputElement;
    await waitFor(() => expect(telefone.value).toBe('96 99999-0000'));

    fireEvent.change(telefone, { target: { value: '96 98888-7777' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(edicoes).toHaveLength(1));
    expect(edicoes[0].url).toContain('/core/customers/c-final');
    expect(edicoes[0].body.phone).toBe('96 98888-7777');
    // A ficha viaja INTEIRA: mandar só o telefone deixaria o servidor sem
    // saber se o e-mail apagado no formulário foi decisão ou omissão.
    expect(edicoes[0].body.name).toBe('Maria da Silva');
    expect(edicoes[0].body.email).toBe('maria@exemplo.com');

    // O formulário fecha e é a LISTA recarregada que mostra o número novo.
    await waitFor(() => expect(screen.queryByLabelText('Telefone')).toBeNull());
    await screen.findByText('96 98888-7777');
    await screen.findByText('Ficha de Maria da Silva atualizada.');
  });

  it('CPF inválido volta como frase, no formulário, e a ficha continua aberta', async () => {
    respostaDaEdicao = {
      status: 400,
      body: {
        error: {
          code: 'CORE_INVALID_DOCUMENT',
          message: 'CPF inválido: os dígitos não conferem.',
        },
      },
    };
    entrarComo('atendente');
    montar();

    fireEvent.click(await screen.findByLabelText('Editar cadastro de Maria da Silva'));
    const documento = (await screen.findByLabelText('CPF/CNPJ')) as HTMLInputElement;
    fireEvent.change(documento, { target: { value: '111.111.111-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('CPF inválido');
    // A mensagem é a do servidor, não o código técnico dele.
    expect(erro.textContent).not.toContain('CORE_INVALID_DOCUMENT');
    // A ficha fica aberta com o que foi digitado — fechar jogaria fora a
    // correção inteira por causa de um dígito.
    expect((screen.getByLabelText('CPF/CNPJ') as HTMLInputElement).value).toBe('111.111.111-11');
  });

  it('CPF de outro cliente também é dito em português', async () => {
    respostaDaEdicao = {
      status: 409,
      body: {
        error: {
          code: 'CORE_DUPLICATE_DOCUMENT',
          message: 'Já existe cliente com este CPF/CNPJ.',
        },
      },
    };
    entrarComo('atendente');
    montar();

    fireEvent.click(await screen.findByLabelText('Editar cadastro de Maria da Silva'));
    await screen.findByLabelText('Telefone');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('Já existe cliente com este CPF/CNPJ.');
    expect(erro.textContent).not.toContain('CORE_DUPLICATE_DOCUMENT');
  });
});

describe('criar cliente', () => {
  it('o botão abre a ficha vazia; salvar vai pelo POST e a lista recarregada mostra o novo', async () => {
    entrarComo('atendente');
    montar();
    await screen.findByText('Maria da Silva');

    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }));

    // A ficha nasce VAZIA — não sobra nada de uma edição anterior.
    const nome = (await screen.findByLabelText(/^Nome/)) as HTMLInputElement;
    expect(nome.value).toBe('');
    expect((screen.getByLabelText('CPF/CNPJ') as HTMLInputElement).value).toBe('');

    fireEvent.change(nome, { target: { value: 'João do Balcão' } });
    fireEvent.change(screen.getByLabelText('CPF/CNPJ'), {
      target: { value: '390.533.447-05' },
    });
    fireEvent.change(screen.getByLabelText('Telefone'), {
      target: { value: '96 97777-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    // Cadastro novo é POST na coleção — não PUT em ficha que não existe.
    await waitFor(() => expect(criacoes).toHaveLength(1));
    expect(criacoes[0].url).toMatch(/\/core\/customers(\?|$)/);
    expect(criacoes[0].body.name).toBe('João do Balcão');
    expect(criacoes[0].body.document).toBe('390.533.447-05');
    expect(criacoes[0].body.phone).toBe('96 97777-1234');
    expect(edicoes).toHaveLength(0);

    // O formulário fecha e é a LISTA recarregada que mostra o cliente novo.
    await waitFor(() => expect(screen.queryByLabelText('Telefone')).toBeNull());
    await screen.findByText('João do Balcão');
    await screen.findByText('Cliente João do Balcão cadastrado.');
  });

  it('CPF inválido no cadastro volta como frase, e o digitado continua na ficha', async () => {
    respostaDaCriacao = {
      status: 400,
      body: {
        error: {
          code: 'CORE_INVALID_DOCUMENT',
          message: 'CPF inválido: os dígitos não conferem.',
        },
      },
    };
    entrarComo('atendente');
    montar();
    await screen.findByText('Maria da Silva');

    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }));
    fireEvent.change(await screen.findByLabelText(/^Nome/), {
      target: { value: 'João do Balcão' },
    });
    fireEvent.change(screen.getByLabelText('CPF/CNPJ'), {
      target: { value: '111.111.111-11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('CPF inválido');
    // A mensagem é a do servidor, não o código técnico dele.
    expect(erro.textContent).not.toContain('CORE_INVALID_DOCUMENT');
    // A ficha fica aberta com o digitado — fechar jogaria fora o cadastro
    // inteiro por causa de um dígito.
    expect((screen.getByLabelText(/^Nome/) as HTMLInputElement).value).toBe('João do Balcão');
    expect((screen.getByLabelText('CPF/CNPJ') as HTMLInputElement).value).toBe('111.111.111-11');
  });

  it('CPF que já é de outro cliente também é dito em português', async () => {
    respostaDaCriacao = {
      status: 409,
      body: {
        error: {
          code: 'CORE_DUPLICATE_DOCUMENT',
          message: 'Já existe cliente com este CPF/CNPJ.',
        },
      },
    };
    entrarComo('atendente');
    montar();
    await screen.findByText('Maria da Silva');

    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }));
    fireEvent.change(await screen.findByLabelText(/^Nome/), {
      target: { value: 'PJ Motos Revenda' },
    });
    fireEvent.change(screen.getByLabelText('CPF/CNPJ'), {
      target: { value: '11222333000181' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toContain('Já existe cliente com este CPF/CNPJ.');
    expect(erro.textContent).not.toContain('CORE_DUPLICATE_DOCUMENT');
  });
});

describe('inativar e reativar', () => {
  it('inativar pede confirmação; confirmado, o cliente SOME da lista', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByLabelText('Inativar Maria da Silva'));

    // A pergunta aparece e NADA foi mandado ainda: confirmação que já agiu
    // não é confirmação.
    await screen.findByRole('dialog');
    expect(edicoes).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Inativar cliente' }));

    await waitFor(() => expect(edicoes).toHaveLength(1));
    expect(edicoes[0].url).toContain('/core/customers/c-final');
    expect(edicoes[0].body).toEqual({ active: false });

    // O servidor lista só ativos — o reflexo honesto é a linha sumir.
    await waitFor(() => expect(screen.queryByText('Maria da Silva')).toBeNull());
    expect(screen.getByText('PJ Motos Revenda')).toBeTruthy();
  });

  it('cancelar a pergunta não manda nada', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByLabelText('Inativar Maria da Silva'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(edicoes).toHaveLength(0);
    expect(screen.getByText('Maria da Silva')).toBeTruthy();
  });

  it('o aviso oferece Reativar — a lista só mostra ativos, e sem isso o engano não teria volta', async () => {
    entrarComo('gerente_loja');
    montar();

    fireEvent.click(await screen.findByLabelText('Inativar Maria da Silva'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Inativar cliente' }));
    await waitFor(() => expect(screen.queryByText('Maria da Silva')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Reativar' }));

    await waitFor(() => expect(edicoes).toHaveLength(2));
    expect(edicoes[1].url).toContain('/core/customers/c-final');
    expect(edicoes[1].body).toEqual({ active: true });
    // De volta à lista — e o botão de desfazer sai de cena junto.
    await screen.findByText('Maria da Silva');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull());
  });
});

describe('quem o servidor recusaria não vê os botões', () => {
  it('estoquista lê a lista e não cadastra, edita nem inativa', async () => {
    entrarComo('estoquista');
    montar();

    await screen.findByText('Maria da Silva');
    // O PUT é de balcão e gerência (os mesmos perfis do POST). Desenhar o
    // botão para o estoquista seria deixar o 403 explicar a regra.
    expect(screen.queryByLabelText('Editar cadastro de Maria da Silva')).toBeNull();
    expect(screen.queryByLabelText('Inativar Maria da Silva')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Novo cliente' })).toBeNull();
  });
});
