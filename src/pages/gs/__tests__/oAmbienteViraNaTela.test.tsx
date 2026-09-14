/**
 * ============================================================================
 * O AMBIENTE VIRA NA TELA QUE A MENSAGEM DO SERVIDOR NOMEIA — V07-CRT-007
 * ============================================================================
 *
 * ## O defeito
 *
 * O sistema instruía um gesto que ele não oferecia. Depois de liberar a
 * produção, o próprio servidor manda, por extenso:
 *
 *     "Virar o ambiente desta operação para «produção» em Fiscal ›
 *      Configuração — outro ato, depois deste."
 *
 * O dono lia o passo, abria Fiscal › Configuração e não achava nada. As três
 * camadas aceitavam a virada — `updateFiscalConfig` tem `environment` no mapa
 * do PATCH, a rota existe, `coreApi.updateFiscalConfig` também —, e no
 * NAVEGADOR não havia seletor, botão ou alavanca em lugar nenhum: o
 * `AmbienteCard` só RENDERIZAVA o ambiente num badge. O go-live terminava num
 * UPDATE à mão no banco.
 *
 * Promessa de tela que o sistema não cumpre é defeito próprio desta casa, e
 * este arquivo é a metade de cá.
 *
 * ## O que a tela promete agora, e não mais que isso
 *
 *  - o controle SÓ liga depois do desbloqueio — antes dele o servidor recusa
 *    com 409, e um botão que convidasse ao 409 seria outra promessa falsa;
 *  - ele diz O QUE MUDA antes de mudar: a partir da virada, a nota vale
 *    contra a SEFAZ de verdade;
 *  - ele PEDE CONFIRMAÇÃO digitada. Emitir em produção por engano gera
 *    documento com valor jurídico — e um clique errado não deveria bastar;
 *  - ele manda `environment` e NADA MAIS. O `EmitenteCard` manda as 14 chaves
 *    do endereço; se a virada fosse por lá, salvar o telefone viraria o
 *    ambiente junto.
 *
 * ## COMO CADA GUARDA FALHA (quebrado de propósito — conferido)
 *
 *  - remova o botão e o primeiro caso fica vermelho;
 *  - habilite-o sem `productionUnlocked` e o caso do desbloqueio cai;
 *  - dispense a palavra digitada e o caso "clicar por engano" fica vermelho;
 *  - mande o `form` inteiro no PATCH e o caso do corpo exato acusa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalPage from '../FiscalPage';

const BASE_CONFIG = {
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
  updatedAt: '2026-08-30T12:00:00.000Z',
};

/*
  OS PASSOS SÃO OS DO SERVIDOR, palavra por palavra.

  A rodada anterior encurtou este texto na fixture, e foi por isso que a
  instrução e o controle nunca se encontraram: a tela renderizava um passo que
  não era o que o servidor manda. Aqui ele é literal — e `server/tests/
  o-passo-nomeia-a-tela-que-o-oferece.test.ts` confere que continua sendo.
*/
const PASSO_DO_AMBIENTE =
  'Virar o ambiente desta operação para "produção" em Fiscal › Configuração — outro ato, '
  + 'depois deste. Enquanto ele estiver em homologação, a nota emitida não tem valor fiscal.';

const TRANCADA = {
  companyId: 'loja',
  unlocked: false,
  unlockedAt: null,
  unlockedBy: null,
  canUnlock: false,
  blockingReasons: ['Nenhuma nota autorizada de verdade na homologação.'],
  evidence: null,
  remainingSteps: [PASSO_DO_AMBIENTE],
};

const LIBERADA = {
  ...TRANCADA,
  unlocked: true,
  unlockedAt: '2026-08-30T10:00:00.000Z',
  unlockedBy: 'u-dono',
  canUnlock: false,
  blockingReasons: [],
  evidence: {
    model: '65',
    serie: 1,
    number: 41,
    protocol: '143260000123456',
    authorizedAt: '2026-08-29T12:00:00.000Z',
  },
};

let enviados: { url: string; method: string; body: unknown }[] = [];
let config: Record<string, unknown> = { ...BASE_CONFIG };
let producao: unknown = TRANCADA;
/** Quando não-nulo, o PATCH da configuração responde com esta recusa. */
let recusaDoPatch: { status: number; code: string; message: string } | null = null;

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

    if (alvo.includes('/core/fiscal/config')) {
      if (method === 'PATCH') {
        if (recusaDoPatch) {
          return json(
            { error: { code: recusaDoPatch.code, message: recusaDoPatch.message } },
            recusaDoPatch.status,
          );
        }
        config = { ...config, ...(body as object) };
      }
      return json(config);
    }
    if (alvo.includes('/core/fiscal/readiness')) {
      return json({
        items: [
          {
            companyId: 'loja',
            model: '65',
            readiness: 'HOMOLOGATED',
            canEmit: true,
            items: [],
            blockingReasons: [],
            certificateAlert: null,
          },
        ],
        productionUnlock: producao,
      });
    }
    if (alvo.includes('/core/fiscal/series')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/product-pendencies')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/nfce/csc')) return json({ items: [] });
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
    'teste do ambiente',
  );
}

async function abrirFiscal() {
  render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
  await screen.findByText('Numeração das notas');
}

const botao = (nome: RegExp | string) =>
  screen.getByRole('button', { name: nome }) as HTMLButtonElement;

beforeEach(() => {
  enviados = [];
  config = { ...BASE_CONFIG };
  producao = TRANCADA;
  recusaDoPatch = null;
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

describe('o controle de ambiente existe onde a mensagem promete', () => {
  it('o passo manda virar em Fiscal › Configuração — e o gesto está NESTA tela', async () => {
    await abrirFiscal();

    // O passo do servidor, renderizado literalmente...
    expect(screen.getByText(new RegExp('Virar o ambiente desta operação'))).toBeTruthy();
    // ...e o gesto que ele manda fazer, na mesma tela.
    expect(botao(/Virar para produção/i)).toBeTruthy();
  });

  it('ANTES do desbloqueio o controle existe DESLIGADO, e diz por quê', async () => {
    await abrirFiscal();

    expect(botao(/Virar para produção/i).disabled).toBe(true);
    expect(screen.getByText(/Libere a produção antes/i)).toBeTruthy();
  });

  it('desligado é desligado: clicar nele não manda nada ao servidor', async () => {
    await abrirFiscal();

    fireEvent.click(botao(/Virar para produção/i));
    await waitFor(() => expect(screen.getByText('HOMOLOGAÇÃO')).toBeTruthy());
    expect(enviados).toHaveLength(0);
  });
});

// ===========================================================================

describe('depois do desbloqueio, virar é ato consciente', () => {
  beforeEach(() => {
    producao = LIBERADA;
    config = { ...BASE_CONFIG, productionUnlocked: true };
  });

  it('o botão liga — e o primeiro clique CONFIRMA, não vira', async () => {
    await abrirFiscal();

    const virar = botao(/Virar para produção/i);
    expect(virar.disabled).toBe(false);
    fireEvent.click(virar);

    // O que muda tem de estar escrito ANTES de mudar.
    expect(await screen.findByText(/passa a ter valor jurídico/i)).toBeTruthy();
    // E nada foi ao servidor ainda.
    expect(enviados).toHaveLength(0);
  });

  it('a confirmação é DIGITADA: sem a palavra, o ambiente não vira', async () => {
    await abrirFiscal();
    fireEvent.click(botao(/Virar para produção/i));

    const campo = await screen.findByLabelText(/Digite PRODUÇÃO para confirmar/i);
    fireEvent.change(campo, { target: { value: 'producao' } });

    expect(botao(/^Confirmar a virada$/i).disabled).toBe(true);
    expect(enviados).toHaveLength(0);
  });

  it('confirmada, a tela manda environment=production — e NADA mais', async () => {
    await abrirFiscal();
    fireEvent.click(botao(/Virar para produção/i));

    const campo = await screen.findByLabelText(/Digite PRODUÇÃO para confirmar/i);
    fireEvent.change(campo, { target: { value: 'PRODUÇÃO' } });
    fireEvent.click(botao(/^Confirmar a virada$/i));

    await waitFor(() => expect(enviados.length).toBeGreaterThan(0));
    const patch = enviados.find((e) => e.url.includes('/core/fiscal/config'))!;
    expect(patch.method).toBe('PATCH');
    /*
      EXATAMENTE uma chave. O `EmitenteCard` manda as 14 do endereço; se a
      virada saísse de lá, salvar o telefone mudaria o ambiente junto.
    */
    expect(patch.body).toEqual({ environment: 'production' });

    // E a tela relê: o badge passa a dizer a verdade nova.
    expect(await screen.findByText('PRODUÇÃO')).toBeTruthy();
  });

  it('a recusa do servidor vira texto — e o ambiente NÃO muda na tela', async () => {
    recusaDoPatch = {
      status: 409,
      code: 'CORE_FISCAL_PRODUCTION_LOCKED',
      message: 'Produção bloqueada. Exige configuração completa.',
    };
    await abrirFiscal();
    fireEvent.click(botao(/Virar para produção/i));

    const campo = await screen.findByLabelText(/Digite PRODUÇÃO para confirmar/i);
    fireEvent.change(campo, { target: { value: 'PRODUÇÃO' } });
    fireEvent.click(botao(/^Confirmar a virada$/i));

    expect(await screen.findByText(/Produção bloqueada/i)).toBeTruthy();
    expect(screen.getByText('HOMOLOGAÇÃO')).toBeTruthy();
  });
});

// ===========================================================================

describe('a volta para homologação também é um gesto da tela', () => {
  it('em produção, a tela oferece voltar — e manda environment=homologation', async () => {
    producao = LIBERADA;
    config = { ...BASE_CONFIG, environment: 'production', productionUnlocked: true };
    await abrirFiscal();

    expect(screen.getByText('PRODUÇÃO')).toBeTruthy();
    fireEvent.click(botao(/Voltar para homologação/i));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar a volta$/i }));

    await waitFor(() => expect(enviados.length).toBeGreaterThan(0));
    const patch = enviados.find((e) => e.url.includes('/core/fiscal/config'))!;
    expect(patch.body).toEqual({ environment: 'homologation' });
  });

  it('em produção, não há botão de virar para produção de novo', async () => {
    producao = LIBERADA;
    config = { ...BASE_CONFIG, environment: 'production', productionUnlocked: true };
    await abrirFiscal();

    expect(screen.queryByRole('button', { name: /Virar para produção/i })).toBeNull();
  });
});
