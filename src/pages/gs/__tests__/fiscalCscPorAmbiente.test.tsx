/**
 * UM CSC PARA CADA AMBIENTE, NA TELA — GAP-PRD-022.
 *
 * O servidor guardava um CSC só; o cartão mostrava "CONFIGURADO" com qualquer
 * um, e depois da virada para produção o cupom saía com o código de TESTE sem
 * que nada na tela avisasse. E o de produção só podia ser gravado com uma
 * variável ligada no servidor.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem o aviso, a operação em produção com só o de homologação parece
 *     pronta — o primeiro caso cobra a frase e o formulário apontando para
 *     produção;
 *   - sem a escolha do ambiente, o de produção não pode ser gravado antes da
 *     virada — o segundo caso grava produção a partir de homologação e cobra
 *     a explicação de que ele fica guardado;
 *   - se a tela voltasse a mostrar um só, o terceiro caso não acharia os dois
 *     IDs;
 *   - se a unidade voltasse a viajar no corpo, o servidor recusaria qualquer
 *     valor diferente do da operação (GAP-PRD-180) — o quarto caso cobra que
 *     ela não vá.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalPage from '../FiscalPage';

const CONFIG_BASE = {
  companyId: 'loja',
  legalName: 'Preço Justo Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '96010000',
  street: 'Rua Marechal Floriano',
  number: '38',
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

const HOMOLOGACAO = {
  operationalUnitId: 'unit-default',
  cscId: '000001',
  configured: true,
  environment: 'homologation',
};

const PRODUCAO = {
  operationalUnitId: 'unit-default',
  cscId: '000002',
  configured: true,
  environment: 'production',
};

let config: typeof CONFIG_BASE;
let cscAtual: Record<string, unknown>[];
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

    if (alvo.includes('/core/fiscal/config')) return json(config);
    if (alvo.includes('/core/fiscal/readiness')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/product-pendencies')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/series')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/nfce/csc')) {
      if (method === 'POST') {
        const gravado = {
          operationalUnitId: 'unit-default',
          cscId: String(body?.cscId ?? ''),
          configured: true,
          environment: body?.environment,
        };
        cscAtual = [...cscAtual.filter((c) => c.environment !== body?.environment), gravado];
        return json(gravado, 201);
      }
      return json({ items: cscAtual });
    }
    return json({ items: [] });
  });
}

beforeEach(() => {
  config = { ...CONFIG_BASE };
  cscAtual = [];
  enviados = [];
  localStorage.clear();
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
    'teste do CSC por ambiente',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function abrir() {
  render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
  await screen.findByLabelText('CSC por ambiente');
}

describe('o cartão do CSC conhece os dois ambientes', () => {
  it('operação em PRODUÇÃO com só o de homologação: a tela diz que o cupom não sai', async () => {
    config = { ...CONFIG_BASE, environment: 'production', productionUnlocked: true };
    cscAtual = [HOMOLOGACAO];
    await abrir();

    const alerta = await screen.findByText(/só o CSC de homologação está gravado/);
    expect(alerta.textContent).toMatch(/emite em produção/);
    expect(alerta.textContent).toContain('000001');
    expect(alerta.textContent).toMatch(/O cupom não sai/);
    // O formulário já aponta para o que falta.
    expect((screen.getByLabelText('Ambiente do CSC') as HTMLSelectElement).value).toBe('production');
  });

  it('em homologação, o de produção pode ser gravado antes da virada — e fica guardado', async () => {
    cscAtual = [HOMOLOGACAO];
    await abrir();

    fireEvent.change(screen.getByLabelText('Ambiente do CSC'), { target: { value: 'production' } });
    expect(screen.getByText(/fica guardado/).textContent).toMatch(
      /o cupom continua usando o CSC de homologação/,
    );

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000002' } });
    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'TOKEN-PRODUCAO' } });
    fireEvent.click(screen.getByText('Gravar CSC'));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/core/fiscal/nfce/csc'))).toBe(true));
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/nfce/csc'))!;
    expect((envio.body as { environment: string }).environment).toBe('production');
    expect(await screen.findByText('CSC de produção gravado no cofre.')).toBeTruthy();
    // O de homologação continua lá: são dois lugares, não um.
    expect(screen.getAllByText('CONFIGURADO')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('TOKEN-PRODUCAO');
  });

  it('com os dois gravados, cada ambiente mostra o seu ID — e não há alerta', async () => {
    cscAtual = [HOMOLOGACAO, PRODUCAO];
    await abrir();

    const lista = screen.getByLabelText('CSC por ambiente');
    await within(lista).findByText('CSC ID 000001');
    expect(within(lista).getByText('CSC ID 000002')).toBeTruthy();
    expect(within(lista).getAllByText('CONFIGURADO')).toHaveLength(2);
    expect(screen.queryByText(/O cupom não sai/)).toBeNull();
  });

  it('o corpo da gravação não leva unidade — o CSC é da operação', async () => {
    await abrir();

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000001' } });
    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'TOKEN-H' } });
    fireEvent.click(screen.getByText('Gravar CSC'));

    await waitFor(() => expect(enviados.some((e) => e.url.includes('/core/fiscal/nfce/csc'))).toBe(true));
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/nfce/csc'))!;
    expect(envio.body).toEqual({ cscId: '000001', cscToken: 'TOKEN-H', environment: 'homologation' });
  });
});
