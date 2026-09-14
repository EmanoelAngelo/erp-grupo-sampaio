/**
 * A NFS-e DA MÃO DE OBRA NA CONFIGURAÇÃO FISCAL — GAP-PRD-024, pela tela.
 *
 * O que cada teste derruba:
 *   - nasça ligada e a oficina emite sem o dono decidir;
 *   - esconda de quem é cada pendência e o contador não sabe o que é dele;
 *   - esqueça um código no corpo e a DPS sai sem o que o contador informou;
 *   - engula a recusa do servidor e o dono acha que a produção foi ligada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { NfseConfigCard } from '../NfseConfigCard';

let config: Record<string, unknown>;
let prontidao: Record<string, unknown>;
let patches: Record<string, unknown>[];
let recusarProducao: boolean;

function responder(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function base(): Record<string, unknown> {
  return {
    companyId: 'oficina',
    mode: 'DESLIGADA',
    environment: 'homologation',
    serviceCode: null,
    municipalServiceCode: null,
    nbsCode: null,
    serviceDescription: null,
    issRate: null,
    simplesOption: null,
    simplesRegime: null,
    specialRegime: '0',
    issWithholding: '1',
    dpsSeries: '1',
    nextDpsNumber: 1,
    municipalityConfirmedAt: null,
    municipalityConfirmedBy: null,
    updatedAt: null,
    updatedBy: null,
  };
}

beforeEach(() => {
  patches = [];
  recusarProducao = false;
  config = base();
  prontidao = {
    mode: 'DESLIGADA',
    environment: 'homologation',
    canEmit: false,
    items: [
      { key: 'nfse_mode', label: 'Modo da NFS-e', status: 'FAIL', owner: 'dono', detail: 'A NFS-e está desligada.' },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (alvo.endsWith('/core/fiscal/nfse/config') && metodo === 'PATCH') {
        const corpo = JSON.parse(init!.body!) as Record<string, unknown>;
        patches.push(corpo);
        if (recusarProducao && corpo.environment === 'production') {
          return responder(
            { error: { code: 'CORE_NFSE_PRODUCTION_LOCKED', message: 'A NFS-e só vai para produção depois de uma DPS autorizada na homologação.' } },
            409,
          );
        }
        config = { ...config, ...corpo };
        return responder(config);
      }
      if (alvo.endsWith('/core/fiscal/nfse/config')) return responder(config);
      if (alvo.endsWith('/core/fiscal/nfse/readiness')) return responder(prontidao);
      return responder({});
    }),
  );
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'g1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_oficina' },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [{ id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode: 'gerente_oficina' }],
    },
    'LOGIN',
    'client.login',
  );
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
});

describe('a NFS-e na configuração fiscal', () => {
  it('nasce desligada, e o checklist diz de quem é cada pendência', async () => {
    render(<NfseConfigCard />);
    const modo = (await screen.findByLabelText('Modo')) as HTMLSelectElement;
    expect(modo.value).toBe('DESLIGADA');
    expect(screen.getByText('FALTA')).toBeTruthy();
    expect(screen.getByText(/Dono — A NFS-e está desligada/)).toBeTruthy();
    // Desligada não pede código nenhum.
    expect(screen.queryByLabelText('Código de tributação nacional (cTribNac)')).toBeNull();
  });

  it('Emissor Nacional abre os códigos do contador e grava o que foi escolhido', async () => {
    render(<NfseConfigCard />);
    fireEvent.change(await screen.findByLabelText('Modo'), { target: { value: 'EMISSOR_NACIONAL' } });
    fireEvent.change(screen.getByLabelText('Código de tributação nacional (cTribNac)'), { target: { value: '140101' } });
    fireEvent.change(screen.getByLabelText('Situação no Simples Nacional'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Regime de apuração (ME/EPP)'), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText(/O município do prestador está no Sistema Nacional/));
    fireEvent.click(screen.getByRole('button', { name: 'Gravar NFS-e' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      mode: 'EMISSOR_NACIONAL',
      serviceCode: '140101',
      simplesOption: '3',
      simplesRegime: '1',
      specialRegime: '0',
      issWithholding: '1',
      dpsSeries: '1',
      nextDpsNumber: 1,
      municipalityConfirmed: true,
    });
  });

  it('a recusa do servidor (produção travada) aparece na tela', async () => {
    config = { ...base(), mode: 'EMISSOR_NACIONAL' };
    recusarProducao = true;
    render(<NfseConfigCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Passar para produção' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/só vai para produção/);
    expect(patches[0]).toEqual({ environment: 'production' });
  });
});
