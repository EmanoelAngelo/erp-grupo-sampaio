/**
 * A ETIQUETA DA BALANÇA DECLARADA PELA TELA (D-pdv-teclado-16, a tela).
 *
 * O servidor já lia a etiqueta que a balança imprime (prefixo 21–29, PLU e peso
 * ou preço embutidos) e já tinha a rota para declarar o formato — mas nenhuma
 * tela a chamava, e a leitura ficava desligada para sempre. Aqui, na tela da
 * balança:
 *
 *   - quem cadastra produtos declara prefixo, dígitos do PLU e valor embutido,
 *     vendo o código de exemplo montado ao vivo (com o verificador certo);
 *   - "Desligar leitura" manda `{ config: null }`;
 *   - o erro do servidor (prefixo já ocupado) aparece no próprio bloco;
 *   - quem só consulta vê o que está declarado, sem controles;
 *   - a declaração que não carrega não derruba o resto da tela;
 *   - o PLU que não cabe na etiqueta declarada é dito.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BalancaPage from '../BalancaPage';
import { setSession } from '@/lib/api/client';

type Pedido = { url: string; metodo: string; corpo: Record<string, unknown> | null };
let pedidos: Pedido[];
let rotas: Record<string, (p: Pedido) => Response | Promise<Response>>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const FORMATOS = [
  { id: 'csv_generico', label: 'CSV genérico', filename: 'ITENS.CSV', confirmado: true, observacao: 'Aberto em qualquer planilha.' },
];

function pesavel(id: string, name: string, pluCode: string | null) {
  return { productId: id, name, pluCode, priceCents: 4990, weighable: 1, tareGrams: 0 };
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const pedido: Pedido = {
        url: String(url),
        metodo: (init?.method ?? 'GET').toUpperCase(),
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      };
      pedidos.push(pedido);
      const caminho = new URL(pedido.url, 'http://x').pathname.replace(/^\/api\/v1/, '');
      const rota = rotas[`${pedido.metodo} ${caminho}`];
      return rota ? rota(pedido) : json({ items: [] });
    }),
  );
}

function entrar(capabilities: string[]) {
  setSession(
    {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
      // `useCan` lê as capabilities daqui.
      access: { capabilities, modelo: { personalizado: false }, casa: '/sistema' },
    } as never,
    'LOGIN',
    'teste da etiqueta da balança',
  );
}

function montar() {
  render(
    <MemoryRouter initialEntries={['/sistema/balanca']}>
      <BalancaPage />
    </MemoryRouter>,
  );
}

const bloco = () => screen.findByRole('region', { name: 'Etiqueta da balança no PDV' });
const puts = () => pedidos.filter((p) => p.metodo === 'PUT' && p.url.includes('/core/catalog/scale-label'));

/** A declaração do servidor falso: o PUT devolve o que gravou, como o de verdade. */
let declarada: Record<string, unknown> | null;

beforeEach(() => {
  pedidos = [];
  declarada = null;
  rotas = {
    'GET /core/scales/formats': () => json({ formats: FORMATOS }),
    'GET /core/scales/products': () => json({ items: [pesavel('p1', 'Queijo muçarela', '00123')] }),
    'GET /core/catalog/scale-label': () => json({ config: declarada }),
    'PUT /core/catalog/scale-label': (p) => {
      const corpo = p.corpo ?? {};
      declarada = 'config' in corpo && corpo.config === null ? null : corpo;
      return json({ config: declarada });
    },
  };
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'fim do teste da etiqueta da balança');
});

describe('quem cadastra produtos declara a etiqueta da balança', () => {
  it('sem declaração, o bloco diz "desligada"; o exemplo acompanha a escolha e o Salvar manda a declaração', async () => {
    entrar(['products.view', 'products.manage']);
    montar();
    const regiao = await bloco();
    expect(await within(regiao).findByText('Leitura desligada')).toBeTruthy();

    // O padrão do formulário: 21 + PLU 00123 + 00352 g + verificador 5.
    expect(within(regiao).getByText('2100123003525')).toBeTruthy();
    expect(within(regiao).queryByRole('button', { name: 'Desligar leitura' })).toBeNull();

    fireEvent.change(within(regiao).getByLabelText('Prefixo da etiqueta'), { target: { value: '23' } });
    fireEvent.change(within(regiao).getByLabelText('Dígitos do PLU'), { target: { value: '4' } });
    fireEvent.change(within(regiao).getByLabelText('Valor embutido'), { target: { value: 'preco' } });
    // 23 + PLU 0123 + 001990 centavos + verificador 8: o valor ganha a casa que o PLU perdeu.
    expect(within(regiao).getByText('2301230019908')).toBeTruthy();
    // Não promete o centavo: o PDV lança o peso arredondado ao grama e cobra
    // quantidade × preço do quilo, que pode diferir do total impresso (revisão).
    expect(within(regiao).getByText(/lança o peso que R\$ 19,90 compra/)).toBeTruthy();
    expect(within(regiao).getByText(/arredondado ao grama/)).toBeTruthy();
    expect(within(regiao).queryByText(/cobra R\$ 19,90/)).toBeNull();

    fireEvent.click(within(regiao).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].corpo).toEqual({ prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'preco' });

    expect(await within(regiao).findByText('Leitura ligada')).toBeTruthy();
    expect(within(regiao).getByRole('status').textContent).toMatch(/Formato salvo: prefixo 23, PLU de 4 dígitos/);
    expect(within(regiao).getByRole('button', { name: 'Desligar leitura' })).toBeTruthy();
    // Nada mudou desde o que foi salvo: não há o que salvar de novo.
    expect((within(regiao).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Desligar leitura" manda { config: null } e o bloco volta a "desligada"', async () => {
    declarada = { prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' };
    entrar(['products.view', 'products.manage']);
    montar();
    const regiao = await bloco();
    expect(await within(regiao).findByText('Leitura ligada')).toBeTruthy();
    expect((within(regiao).getByLabelText('Prefixo da etiqueta') as HTMLSelectElement).value).toBe('21');
    expect((within(regiao).getByLabelText('Dígitos do PLU') as HTMLSelectElement).value).toBe('5');
    expect((within(regiao).getByLabelText('Valor embutido') as HTMLSelectElement).value).toBe('peso');

    fireEvent.click(within(regiao).getByRole('button', { name: 'Desligar leitura' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].corpo).toEqual({ config: null });

    expect(await within(regiao).findByText('Leitura desligada')).toBeTruthy();
    expect(within(regiao).getByRole('status').textContent).toMatch(/Leitura desligada/);
    expect(within(regiao).queryByRole('button', { name: 'Desligar leitura' })).toBeNull();
  });

  it('o erro do servidor aparece no próprio bloco, e a declaração não muda', async () => {
    rotas['PUT /core/catalog/scale-label'] = () =>
      json(
        {
          error: {
            code: 'CORE_SCALE_PREFIX_IN_USE',
            message: 'O código de barras 2100000000013, do produto "Pão de queijo", já começa com 21. Escolha na balança outro prefixo de 21 a 29.',
          },
        },
        409,
      );
    entrar(['products.view', 'products.manage']);
    montar();
    const regiao = await bloco();
    await within(regiao).findByText('Leitura desligada');

    fireEvent.click(within(regiao).getByRole('button', { name: 'Salvar' }));
    const alerta = await within(regiao).findByRole('alert');
    expect(alerta.textContent).toMatch(/já começa com 21/);
    expect(within(regiao).getByText('Leitura desligada')).toBeTruthy();
    expect(within(regiao).queryByRole('status')).toBeNull();

    // Trocou o prefixo: o erro falava do 21 recusado, e sai da tela (revisão).
    fireEvent.change(within(regiao).getByLabelText('Prefixo da etiqueta'), { target: { value: '22' } });
    expect(within(regiao).queryByRole('alert')).toBeNull();
  });
});

describe('quem só consulta vê o que está declarado', () => {
  it('sem products.manage não há seletor, Salvar nem Desligar — e nenhum PUT', async () => {
    declarada = { prefixo: '22', digitosDoPlu: 4, valorEmbutido: 'preco' };
    entrar(['products.view']);
    montar();
    const regiao = await bloco();
    expect(await within(regiao).findByText('Leitura ligada')).toBeTruthy();
    expect(within(regiao).getByText(/Declarado: prefixo 22, PLU de 4 dígitos e o preço total em centavos/)).toBeTruthy();
    // O exemplo é o do DECLARADO: 22 + 0123 + 001990 + verificador.
    expect(within(regiao).getByText(/^220123001990\d$/)).toBeTruthy();

    expect(within(regiao).queryByLabelText('Prefixo da etiqueta')).toBeNull();
    expect(within(regiao).queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(within(regiao).queryByRole('button', { name: 'Desligar leitura' })).toBeNull();
    expect(puts()).toHaveLength(0);
  });
});

describe('a declaração que não carrega não derruba a tela', () => {
  it('o erro fica no bloco, a lista de pesáveis continua, e "Tentar de novo" relê', async () => {
    let falhar = true;
    rotas['GET /core/catalog/scale-label'] = () =>
      falhar
        ? json({ error: { code: 'INTERNAL', message: 'O servidor não conseguiu ler a configuração agora.' } }, 500)
        : json({ config: { prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' } });
    entrar(['products.view', 'products.manage']);
    montar();
    const regiao = await bloco();
    expect((await within(regiao).findByRole('alert')).textContent).toMatch(/não conseguiu ler a configuração/);
    // Sem saber o que está declarado, não há "ligada"/"desligada" nem botão de gravar.
    expect(within(regiao).queryByText('Leitura desligada')).toBeNull();
    expect(within(regiao).queryByRole('button', { name: 'Salvar' })).toBeNull();
    // O resto da tela segue de pé.
    expect(await screen.findByText('Queijo muçarela')).toBeTruthy();

    falhar = false;
    fireEvent.click(within(regiao).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(regiao).findByText('Leitura ligada')).toBeTruthy();
    expect(within(regiao).queryByRole('alert')).toBeNull();
  });
});

describe('o PLU que a etiqueta declarada não acha é dito', () => {
  it('PLU de 5 dígitos significativos com etiqueta de 4: aviso com o nome; com 5, some', async () => {
    rotas['GET /core/scales/products'] = () =>
      json({
        items: [
          pesavel('p1', 'Queijo muçarela', '00123'),
          pesavel('p2', 'Presunto cozido', '12345'),
          pesavel('p3', 'Mortadela', null),
        ],
      });
    entrar(['products.view', 'products.manage']);
    montar();
    const regiao = await bloco();
    await within(regiao).findByText('Leitura desligada');
    await screen.findByText('Presunto cozido');
    // Padrão de 5 dígitos: tudo cabe (00123 é o PLU 123; "sem PLU" é avisado na lista).
    expect(within(regiao).queryByText(/não cabe na etiqueta/)).toBeNull();

    fireEvent.change(within(regiao).getByLabelText('Dígitos do PLU'), { target: { value: '4' } });
    const aviso = within(regiao).getByText(/não cabe na etiqueta de 4/).parentElement!;
    expect(aviso.textContent).toMatch(/Presunto cozido \(PLU 12345\)/);
    expect(aviso.textContent).not.toMatch(/Queijo muçarela/);
    expect(aviso.textContent).not.toMatch(/Mortadela/);

    fireEvent.change(within(regiao).getByLabelText('Dígitos do PLU'), { target: { value: '5' } });
    expect(within(regiao).queryByText(/não cabe na etiqueta/)).toBeNull();
  });
});
