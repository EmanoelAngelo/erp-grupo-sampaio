/**
 * AS OPERAÇÕES DO GRUPO NO ASAAS, NUM CARTÃO SÓ (GAP-PRD-017).
 *
 * Para saber o que faltava nas seis operações, o dono trocava de empresa seis
 * vezes. O cartão junta as do vínculo e diz o que falta em cada uma — e só
 * aparece para os donos do grupo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AsaasDoGrupoCard } from '@/components/gs/AsaasDoGrupoCard';
import { setSession } from '@/lib/api/client';

let chamadas: string[];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function entrarComo(profileCode: string) {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'fulano', displayName: 'Fulano', profileCode },
      company: { id: 'pj', slug: 'pj', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [{ id: 'pj', slug: 'pj', tradeName: 'Preço Justo', kind: 'retail', profileCode }],
    } as never,
    'LOGIN',
    'teste do Asaas do grupo',
  );
}

beforeEach(() => {
  chamadas = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      chamadas.push(String(url));
      return json({
        total: 2,
        readyForProduction: 1,
        operations: [
          {
            companyId: 'gringa',
            tradeName: 'Gringa',
            effectiveEnvironment: 'sandbox',
            canChargeSandbox: false,
            canChargeProduction: false,
            sandboxHomologated: false,
            webhook: { url: 'https://erp/x', publiclyReachable: true, lastEventAt: null },
            missing: [
              { codigo: 'CHAVE_SANDBOX', tipo: 'credencial', quem: 'dono', frase: 'Guardar a API key de SANDBOX da conta Asaas desta operação.' },
              { codigo: 'PRODUCAO_NO_SERVIDOR', tipo: 'configuracao_do_servidor', quem: 'instalacao', frase: 'Ligar ASAAS_PRODUCTION_ENABLED=true no servidor de produção.' },
            ],
          },
          {
            companyId: 'pj',
            tradeName: 'Preço Justo',
            effectiveEnvironment: 'production',
            canChargeSandbox: true,
            canChargeProduction: true,
            sandboxHomologated: true,
            webhook: { url: 'https://erp/y', publiclyReachable: true, lastEventAt: '2026-09-10T12:00:00.000Z' },
            missing: [],
          },
        ],
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'teste do Asaas do grupo');
});

describe('GAP-PRD-017 — o que falta em cada operação, num cartão só', () => {
  it('o dono vê cada operação, a situação e o que falta — com quem resolve', async () => {
    entrarComo('gestor');
    render(
      <MemoryRouter>
        <AsaasDoGrupoCard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('As operações do grupo')).toBeTruthy();
    expect(screen.getByText(/1 de 2 cobrando em produção/)).toBeTruthy();
    const gringa = screen.getByTestId('asaas-operacao-gringa');
    expect(gringa.textContent).toContain('sem credencial');
    expect(gringa.textContent).toContain('Guardar a API key de SANDBOX');
    expect(gringa.textContent).toContain('quem instala o servidor');
    expect(screen.getByTestId('asaas-operacao-pj').textContent).toContain('cobrando em produção');
  });

  it('o gerente da loja não vê o cartão, e nem pergunta ao servidor', async () => {
    entrarComo('gerente_loja');
    render(
      <MemoryRouter>
        <AsaasDoGrupoCard />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('As operações do grupo')).toBeNull();
    expect(chamadas.some((u) => u.includes('/core/integrations/asaas/grupo'))).toBe(false);
  });
});
