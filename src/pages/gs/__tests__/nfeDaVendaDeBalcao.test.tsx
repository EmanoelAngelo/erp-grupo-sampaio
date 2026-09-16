/**
 * A NF-e (MODELO 55) DE UMA VENDA DE BALCÃO, NA FICHA DA VENDA (P0 fiscal).
 *
 * ## O defeito
 *
 * `createNfeForSale` existia inteiro no servidor — série do cadastro,
 * destinatário validado, município conferido na tabela do IBGE e a trava de
 * "um documento vivo por venda" — e NENHUM caminho o chamava fora dos testes.
 * A NF-e do sistema só saía de PEDIDO ONLINE. O cliente que compra no balcão
 * com CNPJ e pede a nota ficava sem caminho, embora o próprio domínio escreva
 * a regra do caso: quem vendeu no balcão e precisa da NF-e cancela o cupom,
 * dentro do prazo, e só então emite a nota.
 *
 * ## O que se cobra
 *
 *  - venda SEM documento: o formulário do destinatário (o endereço a loja não
 *    tem) e a emissão, com o município escolhido na lista do IBGE;
 *  - venda COM NFC-e viva: nada de botão — a tela diz que a venda já está
 *    documentada e qual é o caminho (cancelar o cupom primeiro);
 *  - venda COM a NF-e desta seção já emitida: a nota aparece e a emissão NÃO
 *    se oferece — este era o beco: a seção lia `/status`, que responde só pela
 *    NFC-e, e para a nota 55 a resposta era `null`, então o botão voltava e o
 *    segundo clique com o CNPJ "corrigido" devolvia a nota antiga como sucesso;
 *  - leitura que FALHOU não é venda sem nota: a seção declara a falha e não
 *    oferece a emissão;
 *  - o destinatário CONTRIBUINTE: o indicador de IE e a inscrição vão no corpo
 *    — sem eles, toda nota saía com indIEDest 9 mesmo para CNPJ;
 *  - o DIFAL que o sistema não monta é declarado onde se clica quando a UF do
 *    destinatário é outra;
 *  - quem não tem `fiscal.manage` não recebe a seção: a rota é da gerência.
 *
 * Como cada caso falha sem o conserto: sem a seção, o botão não existe; sem a
 * leitura dos DOIS modelos, a venda documentada volta a oferecer a emissão.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { VendasPage } from '../OperacaoPages';

const VENDA = {
  id: 'v-301',
  number: 301,
  total_cents: 25_000,
  change_cents: 0,
  status: 'completed',
  created_at: '2026-09-14T17:40:00.000Z',
  customer_id: null,
};

const FICHA = {
  ...VENDA,
  items: [
    {
      id: 'si-1',
      product_id: 'p-1',
      description: 'Camiseta',
      quantity: 1,
      unit_price_cents: 25_000,
      total_cents: 25_000,
    },
  ],
  payments: [],
  customerCreditCents: 0,
  removedItems: [],
  financeEntries: [],
};

/** Os documentos fiscais desta venda, como a rota nova os responde. */
let documentos: { items: unknown[]; ufDoEmitente: string | null } | 'falha' = {
  items: [],
  ufDoEmitente: 'RS',
};
let enviados: { url: string; metodo: string; corpo: Record<string, unknown> | null }[];

/** Uma linha da resposta de `/documentos`, no recorte que a ficha lê. */
function documento(model: '55' | '65', patch: Record<string, unknown> = {}) {
  return {
    document: { id: `doc-${model}`, model, serie: 1, number: model === '55' ? 31 : 88, status: 'AUTHORIZED', ...patch },
    statusLabel: model === '55' ? 'Autorizada' : 'NFC-e autorizada',
    terminal: true,
    isTest: false,
  };
}

const CAPS: Record<string, string[]> = {
  gerente_loja: ['fiscal.manage', 'sales.view'],
  operador_caixa_loja: ['fiscal.sale.emit', 'sales.view'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url).split('?')[0];
    const metodo = (init?.method ?? 'GET').toUpperCase();
    if (metodo !== 'GET') {
      enviados.push({
        url: alvo,
        metodo,
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
    }
    if (alvo.includes('/core/fiscal/sales/v-301/nfe') && metodo === 'POST') {
      return json({
        document: {
          id: 'doc-55',
          model: '55',
          serie: 1,
          number: 31,
          accessKey: '3'.repeat(44),
          status: 'AUTHORIZED',
          protocol: 'TEST-31',
        },
        statusLabel: 'Autorizada',
        pendencias: [
          'Venda com NF-e: a natureza da operação ("VENDA DE MERCADORIA") ainda não foi confirmada '
          + 'pelo contador.',
        ],
      });
    }
    if (alvo.includes('/core/fiscal/sales/v-301/documentos')) {
      return documentos === 'falha'
        ? json({ error: { code: 'X', message: 'servidor fora' } }, 500)
        : json(documentos);
    }
    if (alvo.includes('/loja/municipios')) {
      return json({ carregada: true, total: 1, itens: [{ codigo: '4314407', nome: 'Pelotas', uf: 'RS' }] });
    }
    if (/\/core\/sales\/v-301$/.test(alvo)) return json(FICHA);
    if (alvo.includes('/core/sales')) return json({ items: [VENDA], total: 1 });
    return json({});
  });
}

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [{ id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode }],
      access: {
        modelo: { code: profileCode, name: profileCode, personalizado: false },
        capabilities: CAPS[profileCode] ?? [],
        terminais: 'todos',
        bancadas: 'todas',
        casa: '/sistema',
        carimbo: `c-${profileCode}`,
      },
    } as never,
    'LOGIN',
    'teste da NF-e da venda de balcão',
  );
}

beforeEach(() => {
  enviados = [];
  documentos = { items: [], ufDoEmitente: 'RS' };
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrar('gerente_loja');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirFicha() {
  render(
    <MemoryRouter>
      <VendasPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir a venda #301' }));
  return screen.findByRole('dialog', { name: 'Venda #301' });
}

/** Preenche o endereço que a loja não tem — o mesmo de todos os casos. */
async function preencherEndereco(uf = 'RS') {
  fireEvent.change(screen.getByLabelText(/Logradouro/), { target: { value: 'Rua do Comércio' } });
  fireEvent.change(screen.getByLabelText(/^Número/), { target: { value: '500' } });
  fireEvent.change(screen.getByLabelText(/Bairro/), { target: { value: 'Industrial' } });
  fireEvent.change(screen.getByLabelText(/^UF/), { target: { value: uf } });
  fireEvent.change(screen.getByLabelText(/Município/), { target: { value: 'Pelot' } });
  fireEvent.click(await screen.findByRole('option', { name: /Pelotas/ }));
}

function corpoEnviado() {
  return enviados.find((e) => e.url.includes('/fiscal/sales/v-301/nfe'))!.corpo;
}

describe('a NF-e da venda de balcão sai pela ficha da venda', () => {
  it('sem documento, o formulário pede o endereço e a nota sai com o município do IBGE', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e desta venda' }));

    fireEvent.change(await screen.findByLabelText(/Nome do cliente/), {
      target: { value: 'Atacado Sul Ltda' },
    });
    fireEvent.change(screen.getByLabelText(/CPF ou CNPJ/), { target: { value: '11.444.777/0001-61' } });
    await preencherEndereco();

    const botoes = screen.getAllByRole('button', { name: 'Emitir NF-e desta venda' });
    fireEvent.click(botoes[botoes.length - 1]!);

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/fiscal/sales/v-301/nfe'))).toBe(true));
    expect(corpoEnviado()).toEqual({
      recipient: {
        document: '11444777000161',
        name: 'Atacado Sul Ltda',
        // O padrão do balcão, agora declarado pelo formulário e não cravado no
        // código: consumidor, sem inscrição.
        ieIndicator: '9',
        ie: null,
        consumidorFinal: null,
        street: 'Rua do Comércio',
        number: '500',
        complement: null,
        district: 'Industrial',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        uf: 'RS',
        zip: null,
      },
    });

    expect(await screen.findByText(/NF-e 31, série 1 — AUTHORIZED/)).toBeTruthy();
    // O que o contador ainda deve sai junto da nota — a tela tipava
    // `pendencias` e o servidor nunca as mandava.
    expect(screen.getByText(/ainda não foi confirmada pelo contador/)).toBeTruthy();
  });

  /*
    O CLIENTE PJ CONTRIBUINTE — o caso que justifica a feature.

    O DEFEITO: `destinatarioParaEnvio` cravava `ieIndicator: '9'` e o
    formulário não tinha campo nenhum de inscrição estadual, então a nota do
    contribuinte saía com indIEDest 9 e indFinal 1: a operação declarada
    errada, sem caminho no sistema para emiti-la certa.
  */
  it('cliente PJ contribuinte: o indicador de IE e a inscrição vão no corpo', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e desta venda' }));

    fireEvent.change(await screen.findByLabelText(/Nome do cliente/), {
      target: { value: 'Atacado Sul Ltda' },
    });
    fireEvent.change(screen.getByLabelText(/CPF ou CNPJ/), { target: { value: '11.444.777/0001-61' } });
    fireEvent.change(screen.getByLabelText(/Condição fiscal do destinatário/), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText(/^Inscrição estadual/), { target: { value: '096/1234567' } });
    await preencherEndereco();

    const botoes = screen.getAllByRole('button', { name: 'Emitir NF-e desta venda' });
    fireEvent.click(botoes[botoes.length - 1]!);

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/fiscal/sales/v-301/nfe'))).toBe(true));
    expect(corpoEnviado()).toMatchObject({
      recipient: {
        ieIndicator: '1',
        // Só dígitos, como o leiaute cobra; e o contribuinte compra para
        // revender, salvo declaração em contrário.
        ie: '0961234567',
        consumidorFinal: false,
      },
    });
  });

  it('contribuinte sem a inscrição não emite: o botão fica travado até ela existir', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e desta venda' }));
    fireEvent.change(await screen.findByLabelText(/Nome do cliente/), {
      target: { value: 'Atacado Sul Ltda' },
    });
    fireEvent.change(screen.getByLabelText(/CPF ou CNPJ/), { target: { value: '11.444.777/0001-61' } });
    await preencherEndereco();
    fireEvent.change(screen.getByLabelText(/Condição fiscal do destinatário/), {
      target: { value: '1' },
    });

    const botoes = screen.getAllByRole('button', { name: 'Emitir NF-e desta venda' });
    expect((botoes[botoes.length - 1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Inscrição estadual/), { target: { value: '0961234567' } });
    const depois = screen.getAllByRole('button', { name: 'Emitir NF-e desta venda' });
    expect((depois[depois.length - 1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('venda com NFC-e viva não oferece a emissão — e diz qual é o caminho', async () => {
    documentos = { items: [documento('65')], ufDoEmitente: 'RS' };
    await abrirFicha();
    expect(await screen.findByText(/já tem NFC-e nº 88/)).toBeTruthy();
    expect(screen.getByText(/cancele o cupom/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e desta venda' })).toBeNull();
  });

  /*
    O BECO: a seção lia `/status`, que responde só pela NFC-e. Para a venda já
    documentada pela NF-e 55 a resposta era `null`, a nota sumia da ficha e o
    botão voltava — e o segundo clique com o CNPJ "corrigido" devolvia a nota
    ANTIGA com a cara de sucesso.
  */
  it('venda que já tem a NF-e mostra a nota e NÃO oferece a segunda emissão', async () => {
    documentos = {
      items: [documento('55', { accessKey: '3'.repeat(44), protocol: 'TEST-31' })],
      ufDoEmitente: 'RS',
    };
    await abrirFicha();
    expect(await screen.findByTestId('nfe-da-venda-emitida')).toBeTruthy();
    expect(screen.getByText(/NF-e 31, série 1 — AUTHORIZED/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e desta venda' })).toBeNull();
  });

  it('NF-e rejeitada não vira uma segunda nota: a tela diz onde se resolve', async () => {
    documentos = { items: [documento('55', { status: 'REJECTED' })], ufDoEmitente: 'RS' };
    await abrirFicha();
    expect(await screen.findByText(/Documentos fiscais/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e desta venda' })).toBeNull();
  });

  it('leitura que falhou não é venda sem nota: declara a falha e não oferece a emissão', async () => {
    documentos = 'falha';
    await abrirFicha();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Não foi possível ler os documentos fiscais/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emitir NF-e desta venda' })).toBeNull();
  });

  /*
    O DIFAL NÃO É MONTADO POR NINGUÉM (grep por ICMSUFDest só acha a frase da
    pendência), e nada impedia a emissão interestadual. Agora a falta é dita
    onde se clica, no instante em que a UF do destinatário a torna real.
  */
  it('destinatário de outra UF: a tela declara o DIFAL que o sistema não monta', async () => {
    await abrirFicha();
    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NF-e desta venda' }));
    fireEvent.change(await screen.findByLabelText(/^UF/), { target: { value: 'SC' } });
    expect(await screen.findByText(/ICMSUFDest/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^UF/), { target: { value: 'RS' } });
    await waitFor(() => expect(screen.queryByText(/ICMSUFDest/)).toBeNull());
  });

  it('o caixa não recebe a seção: a rota é da gerência', async () => {
    entrar('operador_caixa_loja');
    await abrirFicha();
    expect(screen.queryByTestId('nfe-da-venda')).toBeNull();
  });
});
