/**
 * Logística — o token do Melhor Envio entra pela TELA (GAP-PRD-117), e a tela
 * diz pelo contrato se o checkout está cobrando transportadora (GAP-PRD-126).
 *
 * Antes: nenhum formulário. Cadastrar credencial exigia curl com JWT, e a
 * tarja "PRODUÇÃO BLOQUEADA" lia uma variável do servidor, não a credencial.
 * A coluna "Conexão: Real" saía de um teste feito a cada abertura da tela,
 * enquanto o checkout, por outro caminho, não chamava ninguém.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogisticaPage from '../LogisticaPage';
import { coreApi, type LogisticsCarrierStatus } from '@/lib/api/core';
import { logisticaApi, type LogisticsAccess } from '@/lib/api/logistica';
import { ApiRequestError } from '@/lib/api/client';
import { enviosApi } from '@/lib/api/envios';

function acesso(over: Partial<LogisticsAccess> = {}): LogisticsAccess {
  return {
    carrier: 'melhor_envio',
    configured: false,
    environment: null,
    mode: 'none',
    realCalls: false,
    chargeable: false,
    locks: ['SEM_CREDENCIAL'],
    ...over,
  };
}

function prontidao(over: Record<string, unknown> = {}) {
  return {
    readyForHomologation: false,
    readyForProduction: false,
    productionBlocked: true,
    externalEnabled: false,
    overallStatus: 'pending',
    originZip: '68900000',
    blockingReasons: [],
    providers: [],
    checkoutCarrier: {
      active: false,
      carriers: [],
      message: 'Nenhuma transportadora com token de produção: o checkout oferece só retirada e a tabela da loja.',
    },
    ...over,
  } as never;
}

function melhorEnvio(over: Partial<LogisticsCarrierStatus> = {}): LogisticsCarrierStatus {
  return {
    carrier: 'melhor_envio',
    configured: false,
    environment: 'homologation',
    maskedHint: null,
    connection: { ok: false, real: false, simulated: false, tested: false, message: 'Não configurado.' },
    access: acesso(),
    ...over,
  };
}

function transportadoras(me: LogisticsCarrierStatus = melhorEnvio()) {
  return { productionBlocked: !me.access?.chargeable, items: [me] } as never;
}

function montar() {
  render(
    <MemoryRouter>
      <LogisticaPage />
    </MemoryRouter>,
  );
}

function digitar(rotulo: RegExp, valor: string) {
  fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(coreApi, 'getLogisticsReadiness').mockResolvedValue(prontidao());
  vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(transportadoras());
  // A tela monta também o cartão "Envio e etiqueta" (GAP-PRD-120), que lê a
  // configuração de envio da operação.
  vi.spyOn(enviosApi, 'lerConfiguracao').mockResolvedValue({
    permitirDeclaracaoDeConteudo: false,
    agenciaJadlog: null,
    atualizadoEm: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('a tarja diz, pelo contrato, se o checkout cobra transportadora', () => {
  it('sem token de produção: CHECKOUT SEM TRANSPORTADORA, com o motivo do servidor', async () => {
    montar();
    expect(await screen.findByText(/CHECKOUT SEM TRANSPORTADORA/)).toBeTruthy();
    expect(screen.getByText(/só retirada e a tabela da loja/)).toBeTruthy();
  });

  it('com token de produção valendo: TRANSPORTADORA NO CHECKOUT', async () => {
    vi.spyOn(coreApi, 'getLogisticsReadiness').mockResolvedValue(
      prontidao({
        productionBlocked: false,
        readyForProduction: true,
        checkoutCarrier: {
          active: true,
          carriers: ['melhor_envio'],
          message: 'Melhor Envio em produção: a cotação vale como preço de frete no checkout.',
        },
      }),
    );
    montar();
    expect(await screen.findByText(/TRANSPORTADORA NO CHECKOUT/)).toBeTruthy();
    expect(screen.queryByText(/CHECKOUT SEM TRANSPORTADORA/)).toBeNull();
  });
});

describe('credencial do Melhor Envio', () => {
  it('o token é campo de senha, e Guardar só libera com um token de verdade', async () => {
    montar();
    const campo = (await screen.findByLabelText(/Token do Melhor Envio/)) as HTMLInputElement;
    expect(campo.type).toBe('password');
    expect(campo.autocomplete).toBe('off');

    const guardar = screen.getByRole('button', { name: 'Guardar token' }) as HTMLButtonElement;
    expect(guardar.disabled).toBe(true);
    digitar(/Token do Melhor Envio/, 'abc');
    expect(guardar.disabled).toBe(true);
    digitar(/Token do Melhor Envio/, 'token-de-producao-0001');
    expect(guardar.disabled).toBe(false);
  });

  it('guarda com o ambiente escolhido, limpa o campo e recarrega o estado', async () => {
    const salvar = vi.spyOn(logisticaApi, 'salvarCredencial').mockResolvedValue({
      carrier: 'melhor_envio',
      environment: 'production',
      hasCredentials: true,
      maskedHint: '••••0001',
      contactEmail: 'ti@gringa.com.br',
      access: acesso({ configured: true, environment: 'production', mode: 'production', realCalls: true, chargeable: true, locks: [] }),
    });
    montar();
    await screen.findByLabelText(/Token do Melhor Envio/);
    const carregamentosAntes = vi.mocked(coreApi.getLogisticsCarriers).mock.calls.length;

    fireEvent.change(screen.getByLabelText(/Ambiente do token/), { target: { value: 'production' } });
    digitar(/Token do Melhor Envio/, 'token-de-producao-0001');
    digitar(/E-mail de contato técnico/, 'ti@gringa.com.br');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar token' }));

    await waitFor(() =>
      expect(salvar).toHaveBeenCalledWith({
        carrier: 'melhor_envio',
        environment: 'production',
        token: 'token-de-producao-0001',
        contactEmail: 'ti@gringa.com.br',
      }),
    );
    expect(await screen.findByText(/Token de produção guardado/)).toBeTruthy();
    expect((screen.getByLabelText(/Token do Melhor Envio/) as HTMLInputElement).value).toBe('');
    await waitFor(() =>
      expect(vi.mocked(coreApi.getLogisticsCarriers).mock.calls.length).toBeGreaterThan(carregamentosAntes),
    );
  });

  it('token guardado aparece mascarado, com o ambiente e as travas pelo nome', async () => {
    vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(
      transportadoras(
        melhorEnvio({
          configured: true,
          environment: 'production',
          maskedHint: '••••0001',
          access: acesso({
            configured: true,
            environment: 'production',
            mode: 'blocked',
            locks: ['PRODUCAO_DESABILITADA_NO_PROCESSO'],
          }),
        }),
      ),
    );
    montar();
    expect(await screen.findByText(/Guardado \(••••0001\)/)).toBeTruthy();
    expect(screen.getByText(/produção de logística desligada \(LOGISTICS_PRODUCTION_ENABLED\)/)).toBeTruthy();
    // O token em si nunca aparece: o servidor nem o devolve.
    expect(screen.queryByDisplayValue(/token/)).toBeNull();
  });

  it('recusa do servidor aparece como alerta, com a mensagem dele', async () => {
    vi.spyOn(logisticaApi, 'salvarCredencial').mockRejectedValue(
      new ApiRequestError('LOGISTICS_CONTACT_EMAIL_INVALID', 'E-mail de contato técnico inválido.', 400),
    );
    montar();
    await screen.findByLabelText(/Token do Melhor Envio/);
    digitar(/Token do Melhor Envio/, 'token-de-producao-0001');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar token' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/E-mail de contato técnico inválido/);
  });

  it('Testar conexão chama o servidor e mostra o que ele respondeu', async () => {
    vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(
      transportadoras(
        melhorEnvio({
          configured: true,
          environment: 'production',
          maskedHint: '••••0001',
          access: acesso({ configured: true, environment: 'production', mode: 'production', realCalls: true, chargeable: true, locks: [] }),
        }),
      ),
    );
    const testar = vi.spyOn(logisticaApi, 'testarConexao').mockResolvedValue({
      ok: false,
      real: true,
      simulated: false,
      environment: 'production',
      message: 'O Melhor Envio recusou o token (HTTP 401).',
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));
    await waitFor(() => expect(testar).toHaveBeenCalledWith('melhor_envio'));
    expect(await screen.findByText(/recusou o token \(HTTP 401\)/)).toBeTruthy();
  });

  it('remover pede confirmação na própria tela antes de chamar o servidor', async () => {
    vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(
      transportadoras(
        melhorEnvio({
          configured: true,
          environment: 'homologation',
          maskedHint: '••••0002',
          access: acesso({ configured: true, environment: 'homologation', mode: 'sandbox', realCalls: true, locks: ['CREDENCIAL_DE_SANDBOX'] }),
        }),
      ),
    );
    const remover = vi.spyOn(logisticaApi, 'removerCredencial').mockResolvedValue({
      removed: 1,
      access: acesso(),
    });
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Remover token' }));
    expect(remover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sim, remover' }));
    await waitFor(() => expect(remover).toHaveBeenCalledWith('melhor_envio'));
  });
});

describe('a tabela diz o que cada transportadora vale no checkout', () => {
  it('sandbox: conexão testada, mas só conferência — não cobra', async () => {
    vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(
      transportadoras(
        melhorEnvio({
          configured: true,
          environment: 'homologation',
          connection: { ok: true, real: true, simulated: false, tested: true, message: 'Conexão com o Melhor Envio (sandbox) OK.' },
          access: acesso({ configured: true, environment: 'homologation', mode: 'sandbox', realCalls: true, locks: ['CREDENCIAL_DE_SANDBOX'] }),
        }),
      ),
    );
    montar();
    expect(await screen.findByText('Só conferência (sandbox)')).toBeTruthy();
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('produção valendo: cobra do cliente; conexão ainda não testada diz isso', async () => {
    vi.spyOn(coreApi, 'getLogisticsCarriers').mockResolvedValue(
      transportadoras(
        melhorEnvio({
          configured: true,
          environment: 'production',
          connection: { ok: false, real: false, simulated: false, tested: false, message: 'Ainda não testada com esta credencial.' },
          access: acesso({ configured: true, environment: 'production', mode: 'production', realCalls: true, chargeable: true, locks: [] }),
        }),
      ),
    );
    montar();
    expect(await screen.findByText('Cobra do cliente')).toBeTruthy();
    expect(screen.getByText('Não testada')).toBeTruthy();
  });
});

describe('cotação de conferência', () => {
  it('mostra o nome do serviço que o servidor manda (serviceName)', async () => {
    vi.spyOn(coreApi, 'quoteShipping').mockResolvedValue({
      options: [
        { carrier: 'melhor_envio', serviceName: 'Correios PAC', serviceCode: '1', priceInCents: 2390, estimatedDays: 8, simulated: false, real: true, environment: 'production' },
      ],
      simulated: false,
      real: true,
    });
    montar();
    fireEvent.click(await screen.findByText('Cotar'));
    expect(await screen.findByText(/Correios PAC/)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('resultado de sandbox sai com a tarja própria, e não com a de simulação', async () => {
    vi.spyOn(coreApi, 'quoteShipping').mockResolvedValue({
      options: [
        { carrier: 'melhor_envio', serviceName: 'Correios SEDEX', serviceCode: '2', priceInCents: 3810, estimatedDays: 3, simulated: true, real: true, environment: 'sandbox' },
      ],
      simulated: true,
      real: true,
    });
    montar();
    fireEvent.click(await screen.findByText('Cotar'));
    expect(await screen.findByText('COTAÇÃO DE SANDBOX')).toBeTruthy();
    expect(screen.queryByText('COTAÇÃO SIMULADA')).toBeNull();
  });
});
