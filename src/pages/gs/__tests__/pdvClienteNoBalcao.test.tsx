/**
 * CLIENTE SEM SAIR DA VENDA — busca viva e cadastro rápido no PDV (GAP-V53).
 *
 * O QUE HAVIA ANTES
 *
 * F2 despejava a lista COMPLETA de clientes num scroll de 160px sem filtro:
 * com centenas de cadastros, escolher era rolagem com fila no balcão. E
 * cadastrar exigia abandonar o PDV rumo à tela Clientes — com o carrinho
 * bipado ficando para trás, fora da vista de quem atende.
 *
 * O que este arquivo cobra, montando o PDV de verdade com a rede dublada:
 *
 *   - a busca é VIVA e viaja como o operador digitou (máscara inclusive) —
 *     quem normaliza os dois lados é o servidor, e ISSO tem teste próprio em
 *     server/tests/busca-cliente-no-balcao.test.ts. Aqui se cobra o fio: o
 *     termo chega à rota e o que volta vira lista clicável;
 *   - selecionar aplica o cliente NA HORA, e a tabela de preço dele
 *     reprecifica o carrinho pelo mecanismo que já existe (pdvReprecificacao);
 *   - o cadastro rápido cria pelo POST /core/customers e o recém-criado JÁ
 *     SAI escolhido na venda — sem redigitar, sem trocar de tela;
 *   - a recusa do servidor (CPF inválido, duplicado) fica legível NO
 *     formulário, com o digitado preservado — o padrão da ficha de clientes;
 *   - Esc fecha e o carrinho fica EXATAMENTE como estava.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatCents } from '@/components/gs/format';
import PdvPage from '../PdvPage';

const CAIXA_ABERTO = { id: 'sessao-teste', opening_cents: 20000, status: 'aberto' };

const MOTO = {
  id: 'p-moto',
  internal_code: 'MT-0001',
  sku: null,
  barcode: '7890000001111',
  name: 'Moto Honda CG 160',
  category: null,
  brand: null,
  unit: 'UN',
  cost_cents: 900000,
  price_cents: 1200000,
  effective_price_cents: 1200000,
  on_sale: false,
  min_stock: 0,
  stock_quantity: 3,
  active: 1,
  kind: 'retail',
  workshop_name: null,
  open_price: 0,
};

/** Gravada como o servidor grava: documento SÓ com dígitos. */
const MARIA = {
  id: 'c-maria',
  code: null,
  name: 'Maria da Silva',
  document: '39053344705',
  email: null,
  phone: '(96) 99999-1234',
  price_table_id: null,
};

const REVENDEDOR = {
  id: 'c-revenda',
  code: 'CLI-042',
  name: 'PJ Motos Revenda',
  document: '11222333000181',
  email: null,
  phone: null,
  price_table_id: 't-atacado',
};

const CLIENTES = [MARIA, REVENDEDOR];

/** O CPF que o dublê recusa como duplicado — com a frase real do servidor. */
const CPF_DUPLICADO = '39053344705';

/** As URLs de GET /core/customers, na ordem — é o fio da busca viva. */
let buscasFeitas: string[] = [];
/** Os corpos de POST /core/customers. */
let criacoes: Record<string, unknown>[] = [];
/** Os corpos de POST /core/pricing/cart. */
let pedidosDePreco: { customerId: string | null }[] = [];

/**
 * A peneira do dublê espelha a do servidor de verdade: normaliza os DOIS
 * lados. Um dublê que devolvesse a lista inteira para qualquer termo deixaria
 * de reprovar a tela no dia em que ela parasse de mandar o termo.
 */
function casaComTermo(c: typeof MARIA, termo: string): boolean {
  if (!termo) return true;
  const digitos = termo.replace(/\D/g, '');
  if (c.name.toLowerCase().includes(termo.toLowerCase())) return true;
  if (c.code && c.code.toLowerCase().includes(termo.toLowerCase())) return true;
  if (digitos && String(c.document ?? '').replace(/\D/g, '').includes(digitos)) return true;
  if (digitos && String(c.phone ?? '').replace(/\D/g, '').includes(digitos)) return true;
  return false;
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();

    if (alvo.includes('/core/pricing/cart') && metodo === 'POST') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as {
        customerId: string | null;
        items: { productId: string }[];
      };
      pedidosDePreco.push(corpo);
      const revenda = corpo.customerId === REVENDEDOR.id;
      return new Response(
        JSON.stringify({
          items: corpo.items.map((i) => ({
            productId: i.productId,
            priceCents: revenda ? Math.round(MOTO.price_cents * 0.85) : MOTO.price_cents,
            listPriceCents: MOTO.price_cents,
            onSale: revenda,
            fonte: revenda ? 'tabela' : 'cadastro',
          })),
          priceTable: revenda ? { id: 't-atacado', name: 'Atacado', percentOff: 15 } : null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (alvo.includes('/core/customers') && metodo === 'POST') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      criacoes.push(corpo);
      const digitos = String(corpo.document ?? '').replace(/\D/g, '');
      if (digitos === CPF_DUPLICADO) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'CORE_DUPLICATE_DOCUMENT',
              message: 'Já existe cliente com este CPF/CNPJ.',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'c-novo',
          code: null,
          name: corpo.name,
          document: digitos || null,
          email: null,
          phone: corpo.phone ?? null,
          price_table_id: null,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let corpo: unknown = {};
    if (alvo.includes('/core/customers')) {
      buscasFeitas.push(alvo);
      const termo = new URLSearchParams(alvo.split('?')[1] ?? '').get('search') ?? '';
      corpo = { items: CLIENTES.filter((c) => casaComTermo(c, termo)) };
    } else if (alvo.includes('/core/products/search')) {
      const q = new URLSearchParams(alvo.split('?')[1] ?? '').get('q') ?? '';
      corpo = { items: [MOTO].filter((p) => p.barcode === q) };
    } else if (alvo.includes('/core/sales/discount-policy')) {
      corpo = { operatorLimitPercent: 10, canAuthorizeSelf: false };
    } else if (alvo.includes('/core/cash/open')) {
      corpo = { session: CAIXA_ABERTO, cashWithdrawalLimitCents: null };
    } else if (alvo.includes('/core/sellers')) {
      corpo = { items: [] };
    } else if (alvo.includes('/core/fiscal/pdv-summary')) {
      corpo = {
        situacao: 'NOT_CONFIGURED',
        readiness: 'READY_FOR_CERTIFICATE',
        canEmit: false,
        blocking: [],
        pendencies: [],
        pendencyCount: 0,
      };
    }
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => {
  buscasFeitas = [];
  criacoes = [];
  pedidosDePreco = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <PdvPage />
    </MemoryRouter>,
  );
}

async function bipar(codigo: string) {
  const campo = screen.getByLabelText(/Pesquise por código/);
  fireEvent.change(campo, { target: { value: codigo } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  await waitFor(() =>
    expect(screen.queryAllByRole('button', { name: /^Remover / }).length).toBeGreaterThan(0),
  );
}

async function abrirClientes() {
  fireEvent.click(screen.getByRole('button', { name: 'Cliente (F2)' }));
  return await screen.findByLabelText('Buscar cliente');
}

/** O nome escrito na linha "Cliente" do card da venda. */
function clienteDaVenda(): string {
  return screen.getByText('Cliente').parentElement!.textContent!;
}

// ------------------------------------------------------------- a busca viva

describe('a busca viva do F2', () => {
  it('o CPF digitado COM máscara viaja à rota e acha o cliente', async () => {
    montar();
    const busca = await abrirClientes();

    // O gesto real do balcão: ler o CPF impresso no documento, pontos e traço.
    fireEvent.change(busca, { target: { value: '390.533.447-05' } });

    // O termo viaja COMO DIGITADO — normalizar é trabalho do servidor, que
    // tem teste próprio; a tela que limpasse a máscara por conta própria
    // criaria uma segunda implementação da regra. A espera aqui é a da busca
    // viva: a ida ao servidor sai depois de a pessoa parar de digitar.
    await waitFor(() =>
      expect(
        buscasFeitas.some((u) => decodeURIComponent(u).includes('390.533.447-05')),
      ).toBe(true),
    );

    const opcao = await screen.findByRole('button', { name: 'Maria da Silva' });
    fireEvent.click(opcao);
    // Selecionar aplica NA HORA: o diálogo sai e a venda mostra o nome.
    await waitFor(() => expect(screen.queryByLabelText('Buscar cliente')).toBeNull());
    expect(clienteDaVenda()).toContain('Maria da Silva');
  });

  it('quem só filtra achando de menos não some com o resto: termo vazio lista todos', async () => {
    montar();
    await abrirClientes();
    await screen.findByRole('button', { name: 'Maria da Silva' });
    await screen.findByRole('button', { name: 'PJ Motos Revenda' });
  });

  it('escolher cliente com tabela reprecifica o carrinho já bipado', async () => {
    montar();
    await bipar('7890000001111');

    const busca = await abrirClientes();
    fireEvent.change(busca, { target: { value: 'CLI-042' } });
    fireEvent.click(await screen.findByRole('button', { name: 'PJ Motos Revenda' }));

    // A reprecificação é o mecanismo que JÁ existia (precificadaPara +
    // POST /pricing/cart) — o diálogo só entrega o cliente a ele.
    await waitFor(() =>
      expect(pedidosDePreco.some((p) => p.customerId === 'c-revenda')).toBe(true),
    );
    await waitFor(() => {
      const linha = screen.getByRole('button', { name: /^Remover / }).closest('li')!;
      expect(linha.textContent).toContain(formatCents(1020000));
    });
    expect(screen.getByTestId('pdv-tabela-do-cliente').textContent).toContain('Atacado');
  });

  it('o consumidor final continua a um clique — tirar o cliente também', async () => {
    montar();
    const busca = await abrirClientes();
    fireEvent.change(busca, { target: { value: 'maria' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Maria da Silva' }));
    await waitFor(() => expect(clienteDaVenda()).toContain('Maria da Silva'));

    await abrirClientes();
    fireEvent.click(await screen.findByRole('button', { name: /Consumidor final/ }));
    await waitFor(() => expect(clienteDaVenda()).toContain('Consumidor final'));
  });
});

// -------------------------------------------------- Esc: carrinho intacto

describe('Esc volta ao carrinho intacto', () => {
  it('fechar no meio da busca não mexe em linha nem em cliente', async () => {
    montar();
    await bipar('7890000001111');

    const busca = await abrirClientes();
    fireEvent.change(busca, { target: { value: 'maria' } });
    fireEvent.keyDown(busca, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('Buscar cliente')).toBeNull());
    // O carrinho está EXATAMENTE como estava: a linha bipada segue lá e a
    // venda continua de consumidor final.
    expect(screen.getByRole('button', { name: 'Remover Moto Honda CG 160' })).toBeTruthy();
    expect(clienteDaVenda()).toContain('Consumidor final');
  });
});

// ------------------------------------------------------- o cadastro rápido

describe('o cadastro rápido dentro da venda', () => {
  it('cria pelo POST e o recém-criado JÁ SAI escolhido — carrinho de pé', async () => {
    montar();
    await bipar('7890000001111');

    const busca = await abrirClientes();
    // Ninguém com esse nome: é a deixa do cadastro.
    fireEvent.change(busca, { target: { value: 'João da Feira' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar cliente novo' }));

    // O termo digitado na busca vira o nome do formulário — redigitar o que a
    // pessoa acabou de escrever seria o atrito que este diálogo veio tirar.
    const nome = (await screen.findByLabelText('Nome do cliente')) as HTMLInputElement;
    expect(nome.value).toBe('João da Feira');

    fireEvent.change(screen.getByLabelText('CPF/CNPJ'), {
      target: { value: '111.444.777-35' },
    });
    fireEvent.change(screen.getByLabelText('Telefone'), {
      target: { value: '(96) 98888-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar e usar na venda' }));

    await waitFor(() => expect(criacoes).toHaveLength(1));
    // O documento viaja como digitado — validar e limpar é do servidor.
    expect(criacoes[0].name).toBe('João da Feira');
    expect(criacoes[0].document).toBe('111.444.777-35');
    expect(criacoes[0].phone).toBe('(96) 98888-0000');

    // Já sai escolhido na venda, com o carrinho intacto.
    await waitFor(() => expect(clienteDaVenda()).toContain('João da Feira'));
    expect(screen.getByRole('button', { name: 'Remover Moto Honda CG 160' })).toBeTruthy();
    // E a precificação é consultada para o cliente novo — o mesmo fio de
    // qualquer seleção.
    await waitFor(() =>
      expect(pedidosDePreco.some((p) => p.customerId === 'c-novo')).toBe(true),
    );
  });

  it('a recusa do servidor fica legível e o digitado não se perde', async () => {
    montar();
    await abrirClientes();
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar cliente novo' }));

    fireEvent.change(await screen.findByLabelText('Nome do cliente'), {
      target: { value: 'Maria Homônima' },
    });
    fireEvent.change(screen.getByLabelText('CPF/CNPJ'), {
      target: { value: '390.533.447-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar e usar na venda' }));

    // A frase é a DO SERVIDOR — a mesma porta da ficha de clientes.
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Já existe cliente com este CPF/CNPJ.');

    // O formulário continua aberto com o que foi digitado: fechar jogaria
    // fora o cadastro inteiro por causa de um dígito.
    expect((screen.getByLabelText('Nome do cliente') as HTMLInputElement).value).toBe(
      'Maria Homônima',
    );
    expect((screen.getByLabelText('CPF/CNPJ') as HTMLInputElement).value).toBe(
      '390.533.447-05',
    );
    // E nada foi aplicado à venda.
    expect(clienteDaVenda()).toContain('Consumidor final');
  });

  it('sem nome não há o que cadastrar — o botão nem arma', async () => {
    montar();
    await abrirClientes();
    fireEvent.click(await screen.findByRole('button', { name: 'Cadastrar cliente novo' }));
    const botao = (await screen.findByRole('button', {
      name: 'Cadastrar e usar na venda',
    })) as HTMLButtonElement;
    // Só o nome é obrigatório — a MESMA regra do servidor e da ficha.
    expect(botao.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nome do cliente'), {
      target: { value: 'Fulano' },
    });
    expect(botao.disabled).toBe(false);
  });
});
