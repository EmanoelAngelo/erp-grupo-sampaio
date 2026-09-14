/**
 * O ICMS DO GRUPO TRIBUTÁRIO NA TELA (GAP-PRD-021).
 *
 * ## O que estava errado
 *
 * CSOSN e CST de ICMS eram campos de texto: "999" era enviado, e a recusa só
 * vinha na venda. O regime normal não tinha onde dizer a alíquota de ICMS, a
 * redução de base, o FCP nem o código de benefício — e o tipo "ICMS" tinha
 * sumido do cadastro de alíquotas, porque nada o lia.
 *
 * ## O que este arquivo crava
 *
 *  - CSOSN e CST são seletores com a tabela do leiaute;
 *  - a alíquota de ICMS lista só as do tipo ICMS e só vale nos CST que a leem;
 *  - trocar para um CST que não a lê limpa o que ele não lê (o servidor
 *    recusaria gravar);
 *  - a ST calculada por esta empresa é avisada ANTES de salvar;
 *  - ICMS e FCP voltam a ser tipos de alíquota;
 *  - `?aba=tributarios` abre direto nos grupos (o atalho do checklist fiscal).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import AuxiliaresCatalogoPage from '../AuxiliaresCatalogoPage';

const GRUPO_NORMAL = {
  id: 'tg-9',
  code: 'NORMAL',
  name: 'Regime normal',
  regime: 'normal',
  ncm: null,
  cest: null,
  cfop_internal: '5102',
  cfop_external: '6102',
  origin: '0',
  cst_icms: '20',
  csosn: null,
  p_cred_sn: null,
  cst_pis: '01',
  cst_cofins: '01',
  cst_ipi: null,
  ipi_rate_code: null,
  icms_rate_code: 'ICMS17',
  p_red_bc: '41.18',
  fcp_rate_code: 'FCP2',
  c_benef: null,
  active: 1,
  usage: 3,
};

const ALIQUOTAS = [
  { id: 'a-1', code: 'IPI0', name: 'IPI zero', kind: 'ipi', percent: 0, active: 1 },
  { id: 'a-2', code: 'ICMS17', name: 'ICMS 17%', kind: 'icms', percent: 17, active: 1 },
  { id: 'a-3', code: 'FCP2', name: 'FCP 2%', kind: 'fcp', percent: 2, active: 1 },
];

let salvamentos: Record<string, unknown>[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  salvamentos = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (alvo.includes('/core/catalog/tax-groups') && metodo === 'POST') {
        salvamentos.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return json(GRUPO_NORMAL, 201);
      }
      if (alvo.includes('/core/catalog/aux')) {
        return json({ units: [], taxGroups: [GRUPO_NORMAL], taxRates: ALIQUOTAS, priceTables: [] });
      }
      if (alvo.includes('/core/catalog/custom-fields')) return json({ fields: [] });
      return json({ items: [] });
    }),
  );
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste do ICMS do grupo tributário',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrirGrupos() {
  render(
    <MemoryRouter>
      <AuxiliaresCatalogoPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Grupos tributários' }));
  await screen.findByText('NORMAL');
}

const selecao = (rotulo: RegExp) => screen.getByLabelText(rotulo) as HTMLSelectElement;
const valores = (s: HTMLSelectElement) => [...s.options].map((o) => o.value);

async function salvar() {
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(salvamentos).toHaveLength(1));
  return salvamentos[0];
}

describe('CSOSN e CST de ICMS vêm da tabela do leiaute', () => {
  it('são seletores — com o 500 e o 60 da ST já recolhida', async () => {
    await abrirGrupos();
    const csosn = selecao(/^CSOSN/);
    const cst = selecao(/CST de ICMS/i);
    expect(csosn.tagName).toBe('SELECT');
    expect(cst.tagName).toBe('SELECT');
    expect(valores(csosn)).toEqual(
      expect.arrayContaining(['101', '102', '103', '300', '400', '500', '900']),
    );
    expect(valores(cst)).toEqual(expect.arrayContaining(['00', '20', '40', '41', '50', '60', '90']));
  });

  it('CSOSN 201: a tela avisa que a emissão vai recusar — ST cobrada por fora', async () => {
    await abrirGrupos();
    fireEvent.change(selecao(/^CSOSN/), { target: { value: '201' } });
    expect(screen.getByText(/ICMS-ST é cobrado por fora/)).toBeTruthy();
  });
});

describe('o ICMS próprio do regime normal', () => {
  it('CST 00: a alíquota lista só as de ICMS, e com FCP e cBenef tudo chega ao servidor', async () => {
    await abrirGrupos();
    fireEvent.change(screen.getByLabelText(/^Código/), { target: { value: 'GERAL' } });
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: 'Geral' } });

    const aliquota = selecao(/^Alíquota de ICMS/);
    expect(aliquota.disabled).toBe(true);
    fireEvent.change(selecao(/CST de ICMS/i), { target: { value: '00' } });
    expect(screen.getByText(/O CST 00 destaca ICMS: escolha a alíquota de ICMS/)).toBeTruthy();

    expect(aliquota.disabled).toBe(false);
    expect(valores(aliquota)).toContain('ICMS17');
    expect(valores(aliquota)).not.toContain('IPI0');
    fireEvent.change(aliquota, { target: { value: 'ICMS17' } });
    expect(screen.queryByText(/O CST 00 destaca ICMS/)).toBeNull();

    const fcp = selecao(/^Alíquota de FCP/);
    expect(fcp.disabled).toBe(false);
    expect(valores(fcp)).toEqual(['', 'FCP2']);
    fireEvent.change(fcp, { target: { value: 'FCP2' } });
    fireEvent.change(screen.getByLabelText(/cBenef/), { target: { value: 'rs801001' } });

    const corpo = await salvar();
    expect(corpo).toMatchObject({
      cstIcms: '00',
      icmsRateCode: 'ICMS17',
      fcpRateCode: 'FCP2',
      cBenef: 'RS801001',
      pRedBc: '',
    });
  });

  it('trocar para um CST que não lê alíquota limpa o que ele não lê', async () => {
    await abrirGrupos();
    const linha = screen.getByText('NORMAL').closest('tr')!;
    fireEvent.click(within(linha).getByRole('button', { name: 'Editar' }));
    await screen.findByText(/Editando NORMAL/);
    expect(selecao(/^Alíquota de ICMS/).value).toBe('ICMS17');
    expect((screen.getByLabelText(/Redução da base do ICMS/) as HTMLInputElement).value).toBe(
      '41.18',
    );

    fireEvent.change(selecao(/CST de ICMS/i), { target: { value: '40' } });
    expect(selecao(/^Alíquota de ICMS/).disabled).toBe(true);
    const corpo = await salvar();
    expect(corpo).toMatchObject({ cstIcms: '40', icmsRateCode: '', pRedBc: '', fcpRateCode: '' });
  });
});

describe('o cadastro de alíquotas e o atalho do checklist', () => {
  it('ICMS e FCP voltam a ser tipos de alíquota', async () => {
    render(
      <MemoryRouter>
        <AuxiliaresCatalogoPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Alíquotas' }));
    const tipo = (await screen.findByLabelText(/^Tipo/)) as HTMLSelectElement;
    expect(valores(tipo)).toEqual(['pis', 'cofins', 'ipi', 'icms', 'fcp']);
  });

  it('?aba=tributarios abre direto nos grupos tributários', async () => {
    render(
      <MemoryRouter initialEntries={['/sistema/produtos/auxiliares?aba=tributarios']}>
        <AuxiliaresCatalogoPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('NORMAL')).toBeTruthy();
  });
});
