/**
 * A NFC-e NO FINALIZAR NA TELA (GAP-PRD-163).
 *
 * Duas pontas que só se provam renderizando:
 *
 *   - o CARTÃO do dono, na tela fiscal: mostra o modo que vale (MANUAL por
 *     padrão), grava a escolha pela rota certa e mostra a recusa do servidor
 *     quando quem clica não é o dono;
 *   - o PAINEL do PDV: quando o Finalizar disparou a NFC-e sozinho, ele diz
 *     isso e NÃO oferece o botão de emitir de novo; quando o modo automático
 *     não disparou, ele diz por quê; e sem disparo o balcão fica como sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EmissaoNoFinalizarCard } from '@/components/gs/EmissaoNoFinalizarCard';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import { coreApi } from '@/lib/api/core';

function corpo(dados: unknown, status = 200): Response {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('o cartão do dono', () => {
  let modoAtual: string;
  let gravacoes: unknown[];
  let recusarGravacao: boolean;

  beforeEach(() => {
    modoAtual = 'MANUAL';
    gravacoes = [];
    recusarGravacao = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
        const caminho = String(url);
        if (caminho.includes('/core/fiscal/emission-policy')) {
          if (init?.method === 'PUT') {
            if (recusarGravacao) {
              return corpo({ error: { code: 'API_PERMISSION_DENIED', message: 'Só o dono decide.' } }, 403);
            }
            const enviado = JSON.parse(String(init.body)) as { modo: string };
            gravacoes.push(enviado);
            modoAtual = enviado.modo;
          }
          return corpo({
            modo: modoAtual,
            atualizadoEm: modoAtual === 'MANUAL' ? null : '2026-09-11T12:00:00.000Z',
            atualizadoPor: null,
          });
        }
        return corpo({});
      }),
    );
  });

  it('mostra o padrão MANUAL e grava a escolha AUTOMÁTICA pela rota', async () => {
    render(<EmissaoNoFinalizarCard />);

    const manual = (await screen.findByRole('radio', { name: /Pelo botão do painel fiscal/ })) as HTMLInputElement;
    expect(manual.checked).toBe(true);
    const gravar = screen.getByRole('button', { name: 'Gravar escolha' }) as HTMLButtonElement;
    // Nada mudou: nada a gravar.
    expect(gravar.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Sozinha, no Finalizar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Gravar escolha' }));

    await screen.findByText(/a NFC-e passa a sair sozinha no Finalizar/);
    expect(gravacoes).toEqual([{ modo: 'AUTOMATICA' }]);
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: /Sozinha, no Finalizar/ }) as HTMLInputElement).checked).toBe(true),
    );
  });

  it('quem não é o dono lê a recusa do servidor', async () => {
    recusarGravacao = true;
    render(<EmissaoNoFinalizarCard />);
    fireEvent.click(await screen.findByRole('radio', { name: /Sozinha, no Finalizar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Gravar escolha' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Só o dono decide.');
  });
});

describe('o painel fiscal do PDV depois do Finalizar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(coreApi, 'getFiscalStatusForSale').mockResolvedValue(null);
  });

  function montar(disparo?: { modo: 'MANUAL' | 'AUTOMATICA'; disparada: boolean; motivos: string[] }) {
    return render(
      <MemoryRouter>
        <PainelFiscalPdv saleId="sale-1" onDispensar={() => {}} onImprimir={() => {}} disparo={disparo} />
      </MemoryRouter>,
    );
  }

  it('disparada no Finalizar: diz que está saindo e não oferece emitir de novo', async () => {
    const prontidao = vi
      .spyOn(coreApi, 'getEmissionReadinessForSale')
      .mockResolvedValue({ canEmit: true, alreadyEmitted: false, reasons: [] });
    montar({ modo: 'AUTOMATICA', disparada: true, motivos: [] });

    expect(await screen.findByText(/NFC-e sendo emitida automaticamente para esta venda/)).toBeTruthy();
    await waitFor(() => expect(prontidao).toHaveBeenCalled());
    // A prontidão ainda diria "pode emitir" (a nota nasce em segundo plano):
    // o botão ali seria um convite ao clique duplo.
    expect(screen.queryByRole('button', { name: 'emitir NFC-e' })).toBeNull();
  });

  it('automática que não saiu: o painel diz o motivo do servidor', async () => {
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: false,
      alreadyEmitted: false,
      reasons: ['Certificado A1: ausente'],
    });
    montar({ modo: 'AUTOMATICA', disparada: false, motivos: ['Certificado A1: ausente'] });

    expect(
      await screen.findByText(/A emissão automática não saiu para esta venda: Certificado A1: ausente\./),
    ).toBeTruthy();
  });

  it('sem disparo (modo manual), o balcão fica como sempre: o botão de emitir aparece', async () => {
    vi.spyOn(coreApi, 'getEmissionReadinessForSale').mockResolvedValue({
      canEmit: true,
      alreadyEmitted: false,
      reasons: [],
    });
    montar();

    expect(await screen.findByRole('button', { name: 'emitir NFC-e' })).toBeTruthy();
    expect(screen.getByText(/Nenhuma NFC-e emitida para ela/)).toBeTruthy();
  });
});
