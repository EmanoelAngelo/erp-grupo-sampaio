/**
 * ============================================================================
 * O QUE A TELA MOSTRA DO CERTIFICADO — e o que ela parou de perguntar
 * ============================================================================
 *
 * A suíte do servidor prova que o `.pfx` é lido, conferido e guardado. Nada
 * disso vira melhoria enquanto a TELA continuar pedindo o CNPJ que o arquivo
 * informa, ou escondendo o vencimento de quem nunca abre Fiscal › Certificado.
 * Este arquivo cobra a metade de cá:
 *
 *   - GAP-V39: o campo "CNPJ esperado (opcional)" SUMIU do formulário, e o
 *     envio não manda mais `expectedCnpj`. Enquanto ele existir, o caminho
 *     normal (campo vazio) é o que deixava passar o A1 de outra empresa;
 *   - autodetecção: o cartão mostra titular, documento, emissor, série,
 *     validade e impressão digital — todos vindos do arquivo;
 *   - GAP-V40: o aviso de vencimento aparece no PAINEL e na CONFIGURAÇÃO
 *     fiscal, não só na tela do certificado. Um aviso que só uma tela dá não
 *     avisa ninguém;
 *   - GAP-V41: a lista consolidada mostra as operações com vínculo;
 *   - GAP-V42: o botão de liberar produção existe, diz POR QUE está desligado
 *     e declara que liberar NÃO liga produção.
 *
 * ## Como estes casos falham (quebrando de propósito — conferido)
 *
 *   - devolver `alerta: null` no dashboard e o caso do painel fica vermelho;
 *   - repor o campo de CNPJ no `UploadCard` e o caso do formulário acusa;
 *   - marcar o botão como habilitado sem `canUnlock` e o caso da alçada cai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import CertificadoPage from '../CertificadoPage';
import FiscalPage from '../FiscalPage';
import PainelPage from '../PainelPage';

const CERTIFICADO = {
  id: 'cert-1',
  subject: 'PRECO JUSTO COMERCIO LTDA:11222333000181',
  holderName: 'PRECO JUSTO COMERCIO LTDA',
  documentType: 'CNPJ',
  documentNumber: '11222333000181',
  cnpj: '11222333000181',
  issuer: 'AC SOLUTI Multipla v5',
  serialNumber: '0a1b2c3d',
  subjectDn: 'CN=PRECO JUSTO COMERCIO LTDA:11222333000181, O=ICP-Brasil, C=BR',
  issuerDn: 'CN=AC SOLUTI Multipla v5',
  fingerprintSha256: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  chainLength: 2,
  selfSigned: false,
  cnpjConference: 'conferido',
  cnpjConferenceWarning: null,
  /*
    MEIO-DIA EM UTC, e não meia-noite: a validade do certificado é um INSTANTE,
    e a tela o mostra no fuso da loja. Meia-noite em UTC vira o dia anterior em
    Macapá, e o caso ficaria vermelho por uma diferença de fuso que não é
    defeito nenhum — a mordida que esta casa já documentou duas vezes.
  */
  validFrom: '2026-01-10T12:00:00.000Z',
  validTo: '2026-09-22T12:00:00.000Z',
  senhaGuardada: true,
};

const ALERTA_23 = {
  band: 30,
  days: 23,
  severity: 'warning',
  message: 'A1 vence em 23 dia(s). Providencie a renovação.',
};

const VIEW = {
  configured: true,
  situation: 'valido',
  message: 'Certificado válido. Vence em 23 dia(s).',
  readiness: 'CERTIFICATE_LOADED',
  daysRemaining: 23,
  alerta: ALERTA_23,
  certificate: CERTIFICADO,
};

const GRUPO = [
  {
    companyId: 'loja',
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
    configured: true,
    situation: 'valido',
    message: 'Certificado válido.',
    daysRemaining: 23,
    alerta: ALERTA_23,
    holderName: 'PRECO JUSTO COMERCIO LTDA',
    documentNumber: '11222333000181',
    issuer: 'AC SOLUTI Multipla v5',
    validFrom: '2026-01-10T00:00:00.000Z',
    validTo: '2026-09-22T00:00:00.000Z',
    senhaGuardada: true,
  },
  {
    companyId: 'oficina',
    slug: 'oficina',
    tradeName: 'Oficina',
    legalName: 'Oficina Ltda',
    configured: false,
    situation: 'nao_configurado',
    message: 'Nenhum certificado carregado nesta operação.',
    daysRemaining: null,
    alerta: null,
    holderName: null,
    documentNumber: null,
    issuer: null,
    validFrom: null,
    validTo: null,
    senhaGuardada: false,
  },
];

const CONFIG = {
  companyId: 'loja',
  legalName: 'Preço Justo Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '68900000',
  street: 'Av. Central',
  number: '100',
  complement: null,
  district: 'Centro',
  cityName: 'Macapá',
  cityIbge: '1600303',
  uf: 'AP',
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: '2026-08-23T12:00:00.000Z',
};

const SEM_HOMOLOGACAO = {
  companyId: 'loja',
  unlocked: false,
  unlockedAt: null,
  unlockedBy: null,
  canUnlock: false,
  blockingReasons: [
    'Nenhuma nota autorizada de verdade na homologação. É preciso transmitir à SEFAZ de '
      + 'homologação e receber um protocolo real — autorização do simulador (protocolo TEST-…) '
      + 'não conta, e é por isso que ela não abre a produção.',
  ],
  evidence: null,
  remainingSteps: [
    'Virar o ambiente desta operação para "produção" em Fiscal › Configuração.',
    'Gravar o CSC de PRODUÇÃO.',
  ],
};

const COM_HOMOLOGACAO = {
  ...SEM_HOMOLOGACAO,
  canUnlock: true,
  blockingReasons: [],
  evidence: {
    model: '65',
    serie: 1,
    number: 41,
    protocol: '143260000123456',
    authorizedAt: '2026-08-20T12:00:00.000Z',
  },
};

const PAINEL_BASE = {
  revenueCents: 0,
  salesCount: 0,
  averageTicketCents: 0,
  openReceivablesCents: 0,
  byDay: [],
  topProducts: [],
  bySeller: [],
  lowStock: [],
};

/** Tudo o que a tela mandou ao servidor, na ordem — o que ela promete de fato. */
let enviados: { url: string; method: string; body: unknown }[] = [];
let producao: unknown = SEM_HOMOLOGACAO;
let alertaDoPainel: unknown = ALERTA_23;

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

    if (alvo.includes('/core/fiscal/certificates/group')) return json({ items: GRUPO });
    if (alvo.includes('/core/fiscal/certificate')) return json(VIEW, method === 'POST' ? 201 : 200);
    if (alvo.includes('/core/fiscal/production-unlock')) {
      producao = { ...COM_HOMOLOGACAO, unlocked: true, unlockedAt: '2026-08-30T10:00:00.000Z', unlockedBy: 'u-dono', canUnlock: false, alreadyUnlocked: false };
      return json(producao);
    }
    if (alvo.includes('/core/fiscal/config')) return json(CONFIG);
    if (alvo.includes('/core/fiscal/readiness')) {
      return json({
        items: [
          {
            companyId: 'loja',
            model: '65',
            readiness: 'READY_FOR_SEFAZ_HOMOLOGATION',
            canEmit: true,
            items: [],
            blockingReasons: [],
            certificateAlert: ALERTA_23,
          },
        ],
        productionUnlock: producao,
      });
    }
    if (alvo.includes('/core/fiscal/series')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/product-pendencies')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/nfce/csc')) return json({ items: [] });
    if (alvo.includes('/core/dashboard')) {
      return json({ ...PAINEL_BASE, certificateAlert: alertaDoPainel });
    }
    return json({ items: [] });
  });
}

function entrarComoDono() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Preço Justo', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste do certificado',
  );
}

beforeEach(() => {
  enviados = [];
  producao = SEM_HOMOLOGACAO;
  alertaDoPainel = ALERTA_23;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoDono();
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ===========================================================================

describe('o cartão CERTIFICADO VALIDADO', () => {
  async function abrirCertificado() {
    render(
      <MemoryRouter>
        <CertificadoPage />
      </MemoryRouter>,
    );
    await screen.findByText('CERTIFICADO VALIDADO');
  }

  it('mostra tudo o que o arquivo informou — nada disso foi digitado', async () => {
    await abrirCertificado();

    /*
      `getAllByText` e não `getByText`: o titular aparece no cartão E na lista
      consolidada logo abaixo, que é justamente o que esta rodada acrescentou.
      Exigir ocorrência única faria o caso quebrar por causa da outra melhoria.
    */
    expect(screen.getAllByText('PRECO JUSTO COMERCIO LTDA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('11.222.333/0001-81').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AC SOLUTI Multipla v5').length).toBeGreaterThan(0);
    expect(screen.getByText('0a1b2c3d')).toBeTruthy();
    expect(screen.getAllByText('22/09/2026').length).toBeGreaterThan(0);
    expect(screen.getByText(CERTIFICADO.fingerprintSha256)).toBeTruthy();
    // Aparece duas vezes de propósito: o veredito deste arquivo, no cartão, e
    // a explicação da regra, no formulário de envio.
    expect(screen.getAllByText(/CNPJ conferido contra o emitente/i).length).toBeGreaterThan(0);
  });

  it('o formulário NÃO pede o CNPJ — e o envio não o manda', async () => {
    await abrirCertificado();

    // O campo que deixava o A1 de outra empresa passar quando ficava vazio.
    expect(screen.queryByText(/CNPJ esperado/i)).toBeNull();

    const arquivo = document.querySelector('input[type="file"]') as HTMLInputElement;
    /*
      O ÚLTIMO campo de senha, não o primeiro: a tela tem dois — o do teste de
      comunicação com a SEFAZ, que vem antes, e o do envio do arquivo. Pegar o
      primeiro deixaria o formulário de envio vazio e o botão desabilitado, e o
      caso falharia dizendo a coisa errada.
    */
    const senhas = document.querySelectorAll('input[type="password"]');
    const senha = senhas[senhas.length - 1] as HTMLInputElement;
    expect(arquivo).toBeTruthy();
    expect(senhas.length).toBeGreaterThan(1);

    // O `FileReader` do jsdom entrega o base64 de forma assíncrona; o que
    // interessa aqui é o CORPO da requisição, então o arquivo entra pelo
    // caminho normal e o envio espera o botão habilitar.
    const blob = new File([new Uint8Array([1, 2, 3])], 'a1.pfx', {
      type: 'application/x-pkcs12',
    });
    fireEvent.change(arquivo, { target: { files: [blob] } });
    fireEvent.change(senha, { target: { value: 'senha-do-a1' } });

    const botao = screen.getByRole('button', { name: 'Substituir' }) as HTMLButtonElement;
    await waitFor(() => expect(botao.disabled).toBe(false));
    fireEvent.click(botao);

    await waitFor(() => expect(enviados.length).toBeGreaterThan(0));
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/certificate'))!;
    expect(envio.method).toBe('POST');
    expect(Object.keys(envio.body as object)).toEqual(['pfxBase64', 'certificatePassword']);
  });

  it('lista as operações com vínculo, com titular, validade e situação', async () => {
    await abrirCertificado();

    expect(await screen.findByText('Certificados das suas operações')).toBeTruthy();
    expect(screen.getAllByText('Oficina').length).toBeGreaterThan(0);
    expect(screen.getByText('Oficina Ltda')).toBeTruthy();
    // A que não tem A1 é a informação mais útil da lista.
    expect(screen.getAllByText('NÃO CONFIGURADO').length).toBeGreaterThan(0);
  });
});

// ===========================================================================

describe('o aviso de vencimento alcança quem não foi procurá-lo', () => {
  it('o painel do gestor mostra a faixa', async () => {
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/A1 vence em 23 dia/i)).toBeTruthy();
  });

  it('com folga, o painel não mostra banner nenhum', async () => {
    alertaDoPainel = null;
    render(
      <MemoryRouter>
        <PainelPage />
      </MemoryRouter>,
    );
    await screen.findByText('Dashboard');
    expect(screen.queryByText(/A1 vence em/i)).toBeNull();
  });

  it('a configuração fiscal também avisa — não só a tela do certificado', async () => {
    render(
      <MemoryRouter>
        <FiscalPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/A1 vence em 23 dia/i)).toBeTruthy();
  });
});

// ===========================================================================

describe('a chave da produção na tela', () => {
  async function abrirFiscal() {
    render(
      <MemoryRouter>
        <FiscalPage />
      </MemoryRouter>,
    );
    await screen.findByText('Numeração das notas');
  }

  it('sem homologação real, o botão existe DESLIGADO e diz por quê', async () => {
    await abrirFiscal();

    const botao = screen.getByRole('button', { name: 'Liberar produção' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(screen.getByText(/autorização do simulador/i)).toBeTruthy();
    expect(screen.getByText('PRODUÇÃO BLOQUEADA')).toBeTruthy();
  });

  it('declara que liberar NÃO liga produção, com os passos que faltam', async () => {
    await abrirFiscal();
    expect(
      screen.getByText(/Liberar produção não liga produção/i),
    ).toBeTruthy();
    expect(screen.getByText(/Gravar o CSC de PRODUÇÃO/i)).toBeTruthy();
  });

  it('com a homologação comprovada, o botão liga e a prova aparece', async () => {
    producao = COM_HOMOLOGACAO;
    await abrirFiscal();

    const botao = screen.getByRole('button', { name: 'Liberar produção' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    expect(screen.getByText(/protocolo 143260000123456/)).toBeTruthy();

    fireEvent.click(botao);
    await waitFor(() =>
      expect(enviados.some((e) => e.url.includes('/core/fiscal/production-unlock'))).toBe(true),
    );
    // E o recado diz a verdade: liberado não é ligado.
    expect(await screen.findByText(/ainda NÃO está ligada/i)).toBeTruthy();
  });
});
