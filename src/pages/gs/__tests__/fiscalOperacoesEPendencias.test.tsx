/**
 * A TELA QUE FALTAVA: Fiscal › Operações fiscais e pendências contábeis (P0 fiscal).
 *
 * ## O defeito
 *
 * O servidor tinha as três portas — `GET /core/fiscal/operacoes`,
 * `PUT /core/fiscal/operacoes/:operacao` e `GET /core/fiscal/pendencias-contabeis`
 * — e NENHUMA tela as chamava. O sistema mandava o gestor para "Fiscal ›
 * Operações fiscais" (quando a devolução em produção era recusada) e para
 * "Fiscal › Pendências contábeis" (no item `accountant_pending` do checklist):
 * dois lugares que não existiam no navegador. O prazo de cancelamento, a
 * natureza da operação e o CFOP da devolução só podiam ser gravados por fora
 * do sistema.
 *
 * ## Como cada caso falha sem o conserto
 *
 *  - some a tela e nada renderiza (as quatro operações e as pendências);
 *  - mande o CFOP na operação de VENDA e o servidor responde 400
 *    (`CORE_FISCAL_OPERATION_SALE_CFOP`) — o caso do corpo enviado acusa;
 *  - deixe o botão de gravar visível para o gerente de loja e o caso do perfil
 *    acusa: o `PUT` é `fiscal.policy.manage`, que ele não tem, e o clique dele
 *    levaria 403;
 *  - tire o atalho do checklist e o caso do `accountant_pending` acusa: o item
 *    volta a mandar para um lugar sem caminho.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalOperacoesPage from '../FiscalOperacoesPage';
import FiscalPage from '../FiscalPage';

const OPERACOES = [
  {
    operacao: 'venda_nfce',
    rotulo: 'Venda com NFC-e (balcão)',
    direcao: 'saida',
    natOp: 'VENDA AO CONSUMIDOR',
    cfopInterno: null,
    cfopInterestadual: null,
    grupoTributario: null,
    prazoCancelamentoMinutos: null,
    confirmadaPeloContador: false,
    origem: 'padrao',
    observacao: null,
    atualizadoEm: null,
    atualizadoPor: null,
    pendencias: [
      'Venda com NFC-e (balcão): a natureza da operação ("VENDA AO CONSUMIDOR") ainda não foi '
      + 'confirmada pelo contador.',
      'Venda com NFC-e (balcão): o prazo de cancelamento aceito pela UF não foi informado — o '
      + 'sistema não barra o pedido fora do prazo e a SEFAZ decide.',
    ],
  },
  {
    operacao: 'venda_nfe',
    rotulo: 'Venda com NF-e',
    direcao: 'saida',
    natOp: 'VENDA DE MERCADORIA',
    cfopInterno: null,
    cfopInterestadual: null,
    grupoTributario: null,
    prazoCancelamentoMinutos: 1440,
    confirmadaPeloContador: true,
    origem: 'cadastro',
    observacao: 'confirmado na reunião de setembro',
    atualizadoEm: '2026-09-10T12:00:00.000Z',
    atualizadoPor: 'u-dono',
    pendencias: [],
  },
  {
    operacao: 'devolucao_venda',
    rotulo: 'Devolução de venda (NF-e de entrada, finalidade 4)',
    direcao: 'entrada',
    natOp: 'DEVOLUCAO DE VENDA',
    cfopInterno: '1202',
    cfopInterestadual: '2202',
    grupoTributario: null,
    prazoCancelamentoMinutos: null,
    confirmadaPeloContador: false,
    origem: 'padrao',
    observacao: null,
    atualizadoEm: null,
    atualizadoPor: null,
    pendencias: [
      'Devolução de venda (NF-e de entrada, finalidade 4): natureza da operação, CFOP (1202/2202) '
      + 'e tributação ainda não confirmados pelo contador — em produção a devolução não sai sem a '
      + 'confirmação.',
    ],
  },
  {
    operacao: 'devolucao_compra',
    rotulo: 'Devolução de compra (NF-e de saída, finalidade 4)',
    direcao: 'saida',
    natOp: 'DEVOLUCAO DE COMPRA',
    cfopInterno: '5202',
    cfopInterestadual: '6202',
    grupoTributario: null,
    prazoCancelamentoMinutos: null,
    confirmadaPeloContador: false,
    origem: 'padrao',
    observacao: null,
    atualizadoEm: null,
    atualizadoPor: null,
    pendencias: [],
  },
];

const PENDENCIAS = [
  {
    chave: 'grupo:SIMPLES-101:pcredsn',
    tema: 'Grupo SIMPLES-101 — CSOSN 101',
    descricao:
      'O CSOSN 101 exige o percentual de crédito do Simples (pCredSN), e o contador ainda não o '
      + 'informou: a venda dos produtos deste grupo é recusada até ele entrar no grupo.',
    impede: 'emissao',
    onde: 'Catálogo › Grupos tributários (quem informa é o contador)',
  },
  {
    chave: 'operacao:devolucao_venda:0',
    tema: 'Devolução de venda (NF-e de entrada, finalidade 4)',
    descricao: 'natureza da operação, CFOP e tributação ainda não confirmados pelo contador.',
    impede: 'producao',
    onde: 'Fiscal › Operações fiscais (quem confirma é o contador)',
  },
  {
    chave: 'difal',
    tema: 'DIFAL — venda a consumidor de outra UF',
    descricao: 'O sistema não monta o grupo ICMSUFDest. Confirme com o contador.',
    impede: 'nada',
    onde: 'Contador',
  },
];

const GRUPOS = [
  {
    id: 'g-1',
    code: 'SIMPLES-101',
    name: 'Simples com crédito',
    regime: 'simples',
    ncm: null,
    cest: null,
    cfop_internal: '5102',
    cfop_external: '6102',
    origin: '0',
    cst_icms: null,
    csosn: '101',
    p_cred_sn: null,
    cst_pis: '49',
    cst_cofins: '49',
    cst_ipi: null,
    ipi_rate_code: null,
    icms_rate_code: null,
    active: true,
  },
];

let enviados: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

function servidor() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') enviados.push({ url: alvo, method, body });
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/fiscal/pendencias-contabeis')) return json({ items: PENDENCIAS });
    if (alvo.includes('/core/fiscal/operacoes/')) {
      const operacao = decodeURIComponent(alvo.split('/core/fiscal/operacoes/')[1]!);
      const atual = OPERACOES.find((o) => o.operacao === operacao)!;
      return json({ ...atual, origem: 'cadastro', ...(body ?? {}) });
    }
    if (alvo.includes('/core/fiscal/operacoes')) return json({ items: OPERACOES });
    if (alvo.includes('/core/catalog/tax-groups')) return json({ taxGroups: GRUPOS });
    return json({ items: [] });
  });
}

/**
 * A tela pergunta pela CAPABILITY (`useCan`), que é o que o servidor cobra:
 * ler é `fiscal.view`, gravar é `fiscal.policy.manage`. O gerente de loja tem
 * a primeira e não a segunda.
 */
const CAPS: Record<string, string[]> = {
  gestor: ['fiscal.view', 'fiscal.policy.manage'],
  gerente_loja: ['fiscal.view'],
};

function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'pessoa', displayName: 'Pessoa', profileCode },
      company: { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail', profileCode },
      ],
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
    'teste das operações fiscais',
  );
}

beforeEach(() => {
  enviados = [];
  vi.stubGlobal('fetch', servidor());
  entrar('gestor');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function abrir() {
  render(
    <MemoryRouter>
      <FiscalOperacoesPage />
    </MemoryRouter>,
  );
}

/**
 * O cartão de uma operação, pelo TÍTULO DO CARTÃO — os campos repetem entre os
 * quatro. Pelo texto não serve: o tema de uma pendência contábil é o mesmo
 * rótulo da operação, e a busca acharia os dois.
 */
async function cartaoDe(rotulo: string) {
  const titulo = await screen.findByRole('heading', { level: 2, name: rotulo });
  return within(titulo.closest('section')!);
}

describe('a tela mostra as quatro operações e o que falta do contador', () => {
  it('lista as operações com as pendências de cada uma', async () => {
    abrir();
    for (const rotulo of OPERACOES.map((o) => o.rotulo)) {
      expect(await screen.findByRole('heading', { level: 2, name: rotulo })).toBeTruthy();
    }

    const nfce = await cartaoDe('Venda com NFC-e (balcão)');
    expect(nfce.getByText(/o prazo de cancelamento aceito pela UF não foi informado/)).toBeTruthy();
    expect(nfce.getByText('NÃO CONFIRMADA')).toBeTruthy();

    const nfe = await cartaoDe('Venda com NF-e');
    expect(nfe.getByText('CONFIRMADA PELO CONTADOR')).toBeTruthy();
    // 1440 minutos são um dia — e é isso que o gestor precisa ler.
    expect(nfe.getByText(/1 dia\(s\) depois da autorização/)).toBeTruthy();
  });

  it('as pendências contábeis vêm separadas pelo que cada uma impede', async () => {
    abrir();
    expect(await screen.findByText('IMPEDE A EMISSÃO')).toBeTruthy();
    expect(screen.getByText('IMPEDE A PRODUÇÃO')).toBeTruthy();
    expect(screen.getByText('CONFIRMAÇÃO PENDENTE')).toBeTruthy();
    expect(screen.getByText('Grupo SIMPLES-101 — CSOSN 101')).toBeTruthy();
    expect(screen.getByText(/O CSOSN 101 exige o percentual de crédito do Simples/)).toBeTruthy();
    expect(
      screen.getByText(/Onde se resolve: Catálogo › Grupos tributários/),
    ).toBeTruthy();
  });
});

describe('gravar o que o contador informou', () => {
  it('a venda envia natureza, prazo e confirmação — e NUNCA o CFOP (que mora no grupo)', async () => {
    abrir();
    const nfce = await cartaoDe('Venda com NFC-e (balcão)');

    fireEvent.change(nfce.getByLabelText(/Prazo de cancelamento/), { target: { value: '30' } });
    fireEvent.click(nfce.getByLabelText(/O contador conferiu e confirmou/));
    fireEvent.click(nfce.getByRole('button', { name: /Salvar venda com nfc-e/i }));

    await waitFor(() =>
      expect(enviados.find((e) => e.url.includes('/core/fiscal/operacoes/venda_nfce'))).toBeTruthy(),
    );
    const enviado = enviados.find((e) => e.url.includes('/core/fiscal/operacoes/venda_nfce'))!;
    expect(enviado.method).toBe('PUT');
    expect(enviado.body).toMatchObject({
      natOp: 'VENDA AO CONSUMIDOR',
      prazoCancelamentoMinutos: 30,
      confirmadaPeloContador: true,
    });
    // O servidor responde 400 se o CFOP vier numa operação de venda.
    expect(Object.keys(enviado.body!)).not.toContain('cfopInterno');
    expect(Object.keys(enviado.body!)).not.toContain('cfopInterestadual');
    expect(Object.keys(enviado.body!)).not.toContain('grupoTributario');
  });

  it('a devolução oferece CFOP e grupo tributário, e os envia', async () => {
    abrir();
    const dev = await cartaoDe('Devolução de venda (NF-e de entrada, finalidade 4)');
    expect((dev.getByLabelText('CFOP interno') as HTMLInputElement).value).toBe('1202');
    expect((dev.getByLabelText('CFOP interestadual') as HTMLInputElement).value).toBe('2202');

    fireEvent.change(dev.getByLabelText(/Grupo tributário da devolução/), {
      target: { value: 'SIMPLES-101' },
    });
    fireEvent.click(dev.getByRole('button', { name: /Salvar devolução de venda/i }));

    await waitFor(() =>
      expect(
        enviados.find((e) => e.url.includes('/core/fiscal/operacoes/devolucao_venda'))?.body,
      ).toMatchObject({
        cfopInterno: '1202',
        cfopInterestadual: '2202',
        grupoTributario: 'SIMPLES-101',
      }),
    );
  });

  it('prazo fora da faixa não é enviado: o erro aparece e o botão trava', async () => {
    abrir();
    const nfce = await cartaoDe('Venda com NFC-e (balcão)');
    fireEvent.change(nfce.getByLabelText(/Prazo de cancelamento/), { target: { value: '99999' } });

    expect(await nfce.findByText(/Informe minutos inteiros de 1 a 43200/)).toBeTruthy();
    const botao = nfce.getByRole('button', { name: /Salvar venda com nfc-e/i }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    expect(enviados.filter((e) => e.method === 'PUT')).toHaveLength(0);
  });
});

describe('quem grava é o dono do grupo; a gerência lê', () => {
  it('o gerente de loja lê as pendências e NÃO recebe o botão de gravar', async () => {
    entrar('gerente_loja');
    abrir();
    expect(await screen.findByText('Grupo SIMPLES-101 — CSOSN 101')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Salvar /i })).toBeNull();
    expect(screen.getAllByText(/Gravar estes parâmetros é do dono do grupo/).length).toBe(
      OPERACOES.length,
    );
    expect((screen.getAllByLabelText(/Prazo de cancelamento/)[0] as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

/**
 * O CHECKLIST FISCAL DEIXA DE MANDAR PARA LUGAR NENHUM.
 *
 * `accountant_pending` dizia "a lista completa está em Fiscal › Pendências
 * contábeis" sem atalho — e sem a tela. Agora o item aponta para ela.
 */
describe('o checklist leva às pendências contábeis', () => {
  const ITEM = {
    key: 'accountant_pending',
    label: 'Pendências contábeis (o que o contador ainda não confirmou)',
    status: 'PENDING',
    detail:
      '3 ponto(s) dependem do contador: Grupo SIMPLES-101 — CSOSN 101. A lista completa, com o que '
      + 'cada um impede, está em Fiscal › Pendências contábeis.',
    state: 'PENDENTE',
    source: null,
    owner: 'contador',
    known: null,
    counts: null,
  };

  const RELATORIO = {
    companyId: 'loja',
    model: '65',
    readiness: 'READY_FOR_CERTIFICATE',
    canEmit: false,
    items: [ITEM],
    blockingReasons: [],
    certificateAlert: null,
  };

  it('o item ganha o atalho para /sistema/fiscal/operacoes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        if (String(url).includes('/core/fiscal/readiness')) return json({ items: [RELATORIO] });
        if (String(url).includes('/core/fiscal/config')) {
          return json({ companyId: 'loja', environment: 'homologation', productionUnlocked: false });
        }
        return json({ items: [] });
      }),
    );
    render(
      <MemoryRouter>
        <FiscalPage />
      </MemoryRouter>,
    );

    const atalho = await screen.findByRole('link', {
      name: 'Abrir Fiscal › Operações fiscais e pendências contábeis',
    });
    expect(atalho.getAttribute('href')).toBe('/sistema/fiscal/operacoes');
  });
});
