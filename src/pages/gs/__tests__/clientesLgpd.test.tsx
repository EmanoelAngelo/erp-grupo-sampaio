/**
 * OS DIREITOS DO TITULAR NA TELA DE CLIENTES (GAP-PRD-073).
 *
 * O servidor ganhou `GET /core/customers/:id/dados-do-titular`,
 * `POST /core/customers/:id/anonimizar` e `GET /core/lgpd/retencao`. Sem tela,
 * as três seriam código morto: o pedido do titular continuaria terminando em
 * SQL do desenvolvedor. E a lista passou a devolver a linha mascarada a quem
 * não atende o cadastro — sem explicação, o estoquista acharia que o CPF
 * "sumiu" e alguém o "corrigiria".
 *
 * ## Cada teste falha quando o guarda sai
 *
 *   - tire o bloco da ficha e a gerência volta a não ter onde atender o titular;
 *   - mostre o bloco ao atendente e ele descobre a regra pelo 403;
 *   - baixe outra coisa que não o documento do servidor e o titular recebe um
 *     resumo inventado pela tela;
 *   - anonimize sem motivo ou sem confirmação e um clique perdido apaga o
 *     contato de uma pessoa sem volta;
 *   - engula a recusa com pendência e a gerência não sabe o que resolver;
 *   - esconda a política de retenção e ninguém sabe responder "o que fica?".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { ClientesPage } from '../OperacaoPages';

let clientes: Record<string, unknown>[] = [];
let exportacoes: string[] = [];
let anonimizacoes: { url: string; body: Record<string, unknown> }[] = [];
let respostaDaAnonimizacao: { status: number; body: unknown } | null = null;
let consultasDaRetencao = 0;
let baixados: string[] = [];

function novoBanco() {
  return [
    {
      id: 'c-final',
      name: 'Maria da Silva',
      document: '39053344705',
      email: 'maria@exemplo.com',
      phone: '96 99999-0000',
      address: 'Rua das Laranjeiras, 10',
      notes: null,
      active: 1,
      price_table_id: null,
    },
  ];
}

const DOCUMENTO_DO_SERVIDOR = {
  formato: 'devora.titular.v1',
  geradoEm: '2026-09-11T12:00:00.000Z',
  titular: { id: 'c-final', name: 'Maria da Silva', document: '39053344705' },
  secoes: [{ chave: 'vendas', titulo: 'Vendas', total: 0, linhas: [] }],
  retencao: [],
  observacoes: [],
};

const RETENCAO = [
  {
    chave: 'core_audit_log',
    oQue: 'Trilha de auditoria: quem fez o quê, em qual cadastro, e quando',
    prazo: '5 anos',
    base: 'Obrigação legal',
    destino: 'Apagada automaticamente depois do prazo.',
  },
];

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
    if (alvo.includes('/core/lgpd/retencao')) {
      consultasDaRetencao += 1;
      return json({ items: RETENCAO });
    }
    const exportacao = alvo.match(/\/core\/customers\/([^/?]+)\/dados-do-titular$/);
    if (exportacao) {
      exportacoes.push(exportacao[1]);
      return json(DOCUMENTO_DO_SERVIDOR);
    }
    const anonimizacao = alvo.match(/\/core\/customers\/([^/?]+)\/anonimizar$/);
    if (anonimizacao && metodo === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      anonimizacoes.push({ url: alvo, body });
      if (respostaDaAnonimizacao) return json(respostaDaAnonimizacao.body, respostaDaAnonimizacao.status);
      // Espelho do servidor: o contato sai, a linha fica inativa.
      const cliente = clientes.find((c) => c.id === anonimizacao[1])!;
      Object.assign(cliente, {
        name: 'Titular anonimizado c-final',
        document: null,
        email: null,
        phone: null,
        address: null,
        active: 0,
        anonymized_at: '2026-09-11T12:00:00.000Z',
      });
      return json({
        id: cliente.id,
        anonimizadoEm: '2026-09-11T12:00:00.000Z',
        motivo: body.motivo,
        alterados: { cadastro: 1, contatosComerciais: 0, ordensDeServico: 0, vinculosDoPortal: 0, copiasNaFila: 1 },
        retidos: [],
        avisos: [],
      });
    }
    if (/\/core\/customers\/[^/?]+\/credits$/.test(alvo)) {
      return json({ balance: 0, entries: [] });
    }
    const ficha = alvo.match(/\/core\/customers\/([^/?]+)$/);
    if (ficha && metodo === 'GET') {
      return json(clientes.find((c) => c.id === ficha[1]));
    }
    if (alvo.includes('/core/customers')) {
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
    'teste dos direitos do titular',
  );
}

beforeEach(() => {
  clientes = novoBanco();
  exportacoes = [];
  anonimizacoes = [];
  respostaDaAnonimizacao = null;
  consultasDaRetencao = 0;
  baixados = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  // O jsdom não tem `createObjectURL`, e o clique na âncora tentaria navegar.
  URL.createObjectURL = vi.fn(() => 'blob:titular');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    baixados.push(this.download);
  });
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

async function abrirFichaDaMaria() {
  fireEvent.click(await screen.findByLabelText('Editar cadastro de Maria da Silva'));
  const telefone = (await screen.findByLabelText('Telefone')) as HTMLInputElement;
  await waitFor(() => expect(telefone.value).toBe('96 99999-0000'));
}

describe('quem vê os direitos do titular', () => {
  it('a gerência encontra o bloco na ficha aberta', async () => {
    entrarComo('gerente_loja');
    montar();
    await abrirFichaDaMaria();
    expect(await screen.findByText('Direitos do titular (LGPD)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exportar dados do titular' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Anonimizar titular' })).toBeTruthy();
  });

  it('o atendente edita a ficha, mas não vê o bloco — o servidor o recusaria', async () => {
    entrarComo('atendente');
    montar();
    await abrirFichaDaMaria();
    expect(screen.queryByText('Direitos do titular (LGPD)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Anonimizar titular' })).toBeNull();
  });
});

describe('exportar', () => {
  it('baixa o documento que o servidor montou, com nome que diz de quem é', async () => {
    entrarComo('gerente_loja');
    montar();
    await abrirFichaDaMaria();
    fireEvent.click(await screen.findByRole('button', { name: 'Exportar dados do titular' }));

    await waitFor(() => expect(exportacoes).toEqual(['c-final']));
    await waitFor(() => expect(baixados).toHaveLength(1));
    expect(baixados[0]).toMatch(/^titular-c-final-\d{4}-\d{2}-\d{2}\.json$/);
    const blob = (URL.createObjectURL as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Blob;
    // O Blob do jsdom não tem `.text()`; o FileReader dele lê o mesmo conteúdo.
    const texto = await new Promise<string>((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(String(leitor.result));
      leitor.onerror = () => reject(leitor.error);
      leitor.readAsText(blob);
    });
    expect(JSON.parse(texto)).toEqual(DOCUMENTO_DO_SERVIDOR);
    expect(await screen.findByText(/Dados de Maria da Silva exportados/)).toBeTruthy();
  });
});

describe('anonimizar', () => {
  it('pede motivo e confirmação; depois a ficha fecha e a lista reflete', async () => {
    entrarComo('gerente_loja');
    montar();
    await abrirFichaDaMaria();
    fireEvent.click(await screen.findByRole('button', { name: 'Anonimizar titular' }));

    const dialogo = await screen.findByRole('dialog', { name: 'Anonimizar Maria da Silva' });
    const confirmar = within(dialogo).getByRole('button', { name: 'Anonimizar definitivamente' }) as HTMLButtonElement;
    // Sem motivo, o botão nem habilita: um clique perdido não apaga ninguém.
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), { target: { value: 'curto' } });
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), {
      target: { value: 'Pedido da titular por e-mail em 11/09/2026' },
    });
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);

    await waitFor(() => expect(anonimizacoes).toHaveLength(1));
    expect(anonimizacoes[0].url).toContain('/core/customers/c-final/anonimizar');
    expect(anonimizacoes[0].body.motivo).toBe('Pedido da titular por e-mail em 11/09/2026');

    expect(await screen.findByText(/Maria da Silva foi anonimizad/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByLabelText('Telefone')).toBeNull());
    await waitFor(() => expect(screen.queryByText('Maria da Silva')).toBeNull());
  });

  it('a recusa com pendência fica no diálogo, com a lista do que resolver', async () => {
    respostaDaAnonimizacao = {
      status: 409,
      body: {
        error: {
          code: 'CORE_TITULAR_COM_PENDENCIA',
          message: 'Há pendências com esta pessoa. Resolva-as antes de anonimizar.',
          details: {
            pendencias: [
              { chave: 'credito_de_loja', descricao: 'A loja deve R$ 50,00 em crédito de loja a esta pessoa.' },
              { chave: 'ordens_de_servico', descricao: '1 ordem(ns) de serviço ainda na oficina.' },
            ],
          },
        },
      },
    };
    entrarComo('gerente_loja');
    montar();
    await abrirFichaDaMaria();
    fireEvent.click(await screen.findByRole('button', { name: 'Anonimizar titular' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Anonimizar Maria da Silva' });
    fireEvent.change(within(dialogo).getByLabelText('Motivo'), {
      target: { value: 'Pedido da titular por e-mail em 11/09/2026' },
    });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Anonimizar definitivamente' }));

    const alerta = await within(dialogo).findByRole('alert');
    expect(alerta.textContent).toContain('Há pendências');
    expect(alerta.textContent).toContain('A loja deve R$ 50,00 em crédito de loja a esta pessoa.');
    expect(alerta.textContent).toContain('1 ordem(ns) de serviço ainda na oficina.');
    expect(screen.getByRole('dialog', { name: 'Anonimizar Maria da Silva' })).toBeTruthy();
  });
});

describe('a linha mascarada e a política de retenção', () => {
  it('quem recebe a linha mascarada fica sabendo por quê', async () => {
    clientes = [
      {
        id: 'c-final',
        name: 'Maria da Silva',
        document: '••• 4705',
        email: null,
        phone: '••• 0000',
        address: null,
        notes: null,
        active: 1,
        price_table_id: null,
        dados_mascarados: true,
      },
    ];
    entrarComo('estoquista');
    montar();
    expect(await screen.findByText('••• 4705')).toBeTruthy();
    expect(screen.getByText(/mascarad/i)).toBeTruthy();
  });

  it('a política de retenção carrega quando a gerência pede', async () => {
    entrarComo('gerente_loja');
    montar();
    await abrirFichaDaMaria();
    expect(consultasDaRetencao).toBe(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver a política de retenção' }));
    expect(
      await screen.findByText('Trilha de auditoria: quem fez o quê, em qual cadastro, e quando'),
    ).toBeTruthy();
    expect(screen.getByText('5 anos')).toBeTruthy();
    expect(consultasDaRetencao).toBe(1);
  });
});
