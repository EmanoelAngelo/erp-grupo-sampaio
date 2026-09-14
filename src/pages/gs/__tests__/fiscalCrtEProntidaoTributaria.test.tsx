/**
 * O CRT E A TRIBUTAÇÃO NA TELA FISCAL (GAP-PRD-021, GAP-PRD-095).
 *
 * ## O que estava errado
 *
 *  - O CRT era um campo de texto com a dica "1 · 2 · 3": "simples" ou "5"
 *    eram enviados, o 4 (MEI) nem aparecia, e escolher 3 não dizia que o
 *    regime normal depende da alíquota de ICMS do grupo tributário.
 *  - O checklist não tinha item de tributação: com o grupo sem pCredSN e sem
 *    CST de PIS/COFINS, a tela dizia que a operação estava pronta. O item
 *    novo vem do servidor; esta tela precisa mostrá-lo com o que falta, quem
 *    resolve e ONDE — o atalho para Catálogo › Grupos tributários.
 *
 * ## Como cada caso falha sem o conserto
 *
 *  - com o CRT de volta a texto, não há opção "4" nem aviso do regime normal;
 *  - sem o atalho no checklist, o link para os grupos não existe;
 *  - com o atalho aparecendo em item já resolvido, o caso do PASS acusa.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalPage from '../FiscalPage';

const CONFIG = {
  companyId: 'loja',
  legalName: 'PJ Motors Ltda',
  tradeName: 'PJ Motors',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '96010000',
  street: 'Av. Central',
  number: '100',
  complement: null,
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: '2026-09-11T12:00:00.000Z',
};

const ITEM_TRIBUTACAO = {
  key: 'product_tax_group',
  label: 'Tributação dos produtos (grupo tributário)',
  status: 'FAIL',
  detail:
    '12 de 12 produto(s) ativo(s) não têm tributação que feche — a venda deles é recusada. '
    + 'SIMPLES-101 (12 produto(s)): o CSOSN 101 é "com permissão de crédito" e exige a alíquota '
    + 'de crédito do Simples (pCredSN), que o grupo SIMPLES-101 não tem.',
  state: 'PENDENTE',
  source: 'cadastro',
  owner: 'contador',
  known: 'SIMPLES-101 (CSOSN 101)',
  counts: { done: 0, total: 12, percent: 0 },
};

const ITEM_NCM_OK = {
  key: 'product_ncm',
  label: 'NCM dos produtos',
  status: 'PASS',
  detail: null,
  state: 'CONFIRMADO',
  source: 'cadastro',
  owner: 'contador',
  known: null,
  counts: { done: 12, total: 12, percent: 100 },
};

const RELATORIO = {
  companyId: 'loja',
  model: '65',
  readiness: 'READY_FOR_SEFAZ_HOMOLOGATION',
  canEmit: false,
  items: [ITEM_NCM_OK, ITEM_TRIBUTACAO],
  blockingReasons: [`${ITEM_TRIBUTACAO.label}: ${ITEM_TRIBUTACAO.detail}`],
  certificateAlert: null,
};

let enviados: { url: string; method: string; body: unknown }[] = [];

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

    if (alvo.includes('/core/fiscal/config')) return json({ ...CONFIG, ...(body ?? {}) });
    if (alvo.includes('/core/fiscal/readiness')) return json({ items: [RELATORIO] });
    return json({ items: [] });
  });
}

beforeEach(() => {
  enviados = [];
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste da tela fiscal — CRT e tributação',
  );
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
      <FiscalPage />
    </MemoryRouter>,
  );
}

describe('o CRT é escolhido entre os quatro do leiaute', () => {
  it('oferece 1, 2, 3 e 4 — e o regime normal diz o que depende do grupo', async () => {
    abrir();
    const crt = (await screen.findByLabelText(/^CRT/)) as HTMLSelectElement;
    expect(crt.tagName).toBe('SELECT');
    expect([...crt.options].map((o) => o.value)).toEqual(['', '1', '2', '3', '4']);
    expect(crt.value).toBe('1');
    expect(screen.queryByText(/Regime normal: cada item sai com o CST de ICMS/)).toBeNull();

    fireEvent.change(crt, { target: { value: '3' } });
    expect(screen.getByText(/Regime normal: cada item sai com o CST de ICMS/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar configuração' }));
    await waitFor(() =>
      expect(enviados.find((e) => e.url.includes('/core/fiscal/config'))?.body).toMatchObject({
        crt: '3',
      }),
    );
  });
});

describe('o checklist mostra a tributação do grupo', () => {
  it('com o que falta, quem resolve e o atalho para Catálogo › Grupos tributários', async () => {
    abrir();
    expect(await screen.findByText('Tributação dos produtos (grupo tributário)')).toBeTruthy();
    expect(screen.getByText(/pCredSN/)).toBeTruthy();
    expect(screen.getByText('0 de 12 (0%)')).toBeTruthy();
    expect(screen.getAllByText(/resolve: o contador/).length).toBeGreaterThan(0);

    const atalho = screen.getByRole('link', { name: 'Abrir Catálogo › Grupos tributários' });
    expect(atalho.getAttribute('href')).toBe('/sistema/produtos/auxiliares?aba=tributarios');
  });

  it('item já resolvido não ganha atalho — não há o que abrir', async () => {
    abrir();
    await screen.findByText('NCM dos produtos');
    expect(screen.queryByRole('link', { name: 'Classificar na alteração rápida' })).toBeNull();
  });
});
