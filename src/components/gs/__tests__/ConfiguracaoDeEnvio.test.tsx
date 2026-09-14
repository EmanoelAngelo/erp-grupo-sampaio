/**
 * "Envio e etiqueta" — as decisões que mudam o que a etiqueta leva (GAP-PRD-120).
 *
 * O padrão do servidor é o SEGURO (sem NF-e, sem etiqueta), e a tela o mostra
 * assim; ligar a declaração de conteúdo é ato explícito, com o aviso de que é
 * decisão do contador. A agência Jadlog vai junto. E também a Integrações:
 * a linha dos Correios diz "Sem integração direta" (GAP-PRD-118).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfiguracaoDeEnvio } from '../ConfiguracaoDeEnvio';
import { enviosApi } from '@/lib/api/envios';
import { ApiRequestError } from '@/lib/api/client';
import { IntegracoesPage } from '@/pages/gs/GestaoPages';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Envio e etiqueta', () => {
  it('nasce com a declaração DESLIGADA e grava o que o gestor escolher', async () => {
    vi.spyOn(enviosApi, 'lerConfiguracao').mockResolvedValue({
      permitirDeclaracaoDeConteudo: false,
      agenciaJadlog: null,
      atualizadoEm: null,
    });
    const salvar = vi.spyOn(enviosApi, 'salvarConfiguracao').mockResolvedValue({
      permitirDeclaracaoDeConteudo: true,
      agenciaJadlog: '4321',
      atualizadoEm: '2026-09-11T12:00:00.000Z',
    });
    render(<ConfiguracaoDeEnvio />);

    const caixa = (await screen.findByRole('checkbox', { name: /Permitir envio sem NF-e/ })) as HTMLInputElement;
    await waitFor(() => expect(caixa.disabled).toBe(false));
    expect(caixa.checked).toBe(false);
    expect(screen.getByText(/de acordo do contador/)).toBeTruthy();

    fireEvent.click(caixa);
    fireEvent.change(screen.getByLabelText(/Agência Jadlog/), { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(salvar).toHaveBeenCalledWith({ permitirDeclaracaoDeConteudo: true, agenciaJadlog: '4321' }),
    );
    expect((await screen.findByRole('status')).textContent).toMatch(/guardada/);
  });

  it('a recusa do servidor aparece com a frase dele', async () => {
    vi.spyOn(enviosApi, 'lerConfiguracao').mockResolvedValue({
      permitirDeclaracaoDeConteudo: false,
      agenciaJadlog: null,
      atualizadoEm: null,
    });
    vi.spyOn(enviosApi, 'salvarConfiguracao').mockRejectedValue(
      new ApiRequestError('LOGISTICS_SETTINGS_INVALID', 'A agência Jadlog é o NÚMERO que o Melhor Envio mostra.', 400),
    );
    render(<ConfiguracaoDeEnvio />);
    const botao = await screen.findByRole('button', { name: 'Guardar' });
    await waitFor(() => expect((botao as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/Agência Jadlog/), { target: { value: 'abc' } });
    fireEvent.click(botao);
    expect((await screen.findByRole('alert')).textContent).toMatch(/NÚMERO/);
  });
});

describe('Integrações — a linha dos Correios', () => {
  it('diz "Sem integração direta", e não "Aguardando credencial"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            providers: [
              {
                provider: 'correios',
                configured: false,
                environment: 'n/a',
                readiness: 'NOT_IMPLEMENTED',
                missing: 'Sem integração direta: PAC e SEDEX são cotados, comprados e rastreados pelo Melhor Envio.',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    render(
      <MemoryRouter>
        <IntegracoesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Sem integração direta')).toBeTruthy();
    expect(screen.queryByText('Aguardando credencial')).toBeNull();
  });
});
