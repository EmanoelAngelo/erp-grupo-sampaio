/**
 * Logística — a tela de um módulo que existia e ninguém alcançava.
 *
 * O QUE ESTA TELA NÃO PODE DEIXAR PASSAR: cotação simulada parecendo preço de
 * transportadora. Quem abre esta tela decide o frete que a loja vai cobrar; um
 * número sem marca vira prejuízo em todo pedido, e ninguém descobre até fechar
 * o mês.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogisticaPage from '../LogisticaPage';
import { coreApi } from '@/lib/api/core';
import { enviosApi } from '@/lib/api/envios';

function prontidao(over: Record<string, unknown> = {}) {
  return {
    readyForHomologation: false,
    readyForProduction: false,
    productionBlocked: true,
    externalEnabled: false,
    overallStatus: 'pending',
    originZip: '68900000',
    blockingReasons: [],
    providers: [
      {
        carrier: 'correios',
        configured: false,
        homologated: false,
        blockingReasons: [],
        // O formato que o servidor manda desde o GAP-PRD-118: Correios não
        // tem cliente HTTP, e o cartão diz isso num item só — não acende mais
        // um "IMPLEMENTADO" verde fixo.
        implemented: false,
        items: [
          {
            key: 'implementado',
            label: 'SEM INTEGRAÇÃO DIRETA',
            status: 'blocked',
            message: 'O sistema não fala direto com os Correios: os serviços dos Correios são cotados, comprados e rastreados pelo Melhor Envio.',
          },
        ],
      },
    ],
    ...over,
  } as never;
}

function transportadoras() {
  return {
    productionBlocked: true,
    items: [
      {
        carrier: 'correios',
        configured: false,
        environment: 'homologation',
        connection: { ok: false, real: false, simulated: false, message: 'Não configurado.' },
      },
    ],
  } as never;
}

function montar() {
  render(
    <MemoryRouter>
      <LogisticaPage />
    </MemoryRouter>,
  );
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

describe('o estado do módulo aparece antes de tudo', () => {
  it('diz que o checkout está sem transportadora e por quê', async () => {
    // A tarja dizia "PRODUÇÃO BLOQUEADA" lendo só a variável do servidor; agora
    // vem do contrato (`checkoutCarrier`) — ver LogisticaCredencial.test.tsx.
    montar();
    expect(await screen.findByText(/CHECKOUT SEM TRANSPORTADORA/)).toBeTruthy();
    expect(screen.getByText(/não para cobrar do cliente/)).toBeTruthy();
  });

  it('mostra o CEP de origem formatado, e de onde ele vem', async () => {
    montar();
    // Pedir o mesmo CEP em duas telas criaria duas verdades sobre o galpão.
    expect(await screen.findByText('68900-000')).toBeTruthy();
    expect(screen.getByText(/Fiscal → Configuração/)).toBeTruthy();
  });

  it('sem CEP declarado, não inventa um', async () => {
    vi.spyOn(coreApi, 'getLogisticsReadiness').mockResolvedValue(
      prontidao({ originZip: null }),
    );
    montar();
    expect(await screen.findByText('—')).toBeTruthy();
  });

  it('lista a transportadora e diz, no cartão dela, que não há integração direta', async () => {
    montar();
    // Aparece duas vezes de propósito: na tabela e no bloco de pendências.
    expect((await screen.findAllByText('Correios')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Não configurada').length).toBeGreaterThan(0);
    expect(screen.getByText('SEM INTEGRAÇÃO DIRETA')).toBeTruthy();
    expect(screen.getByText(/O sistema não fala direto com os Correios/)).toBeTruthy();
    expect(screen.queryByText('IMPLEMENTADO')).toBeNull();
  });

  it('mostra o cartão "Envio e etiqueta" com o padrão seguro (sem declaração de conteúdo)', async () => {
    montar();
    const caixa = (await screen.findByRole('checkbox', { name: /Permitir envio sem NF-e/ })) as HTMLInputElement;
    expect(caixa.checked).toBe(false);
  });
});

describe('cotação', () => {
  it('pacote incompleto vira lista do que falta, não uma caixa inventada', async () => {
    vi.spyOn(coreApi, 'quoteShipping').mockResolvedValue({
      options: [],
      simulated: false,
      real: false,
      code: 'SHIPPING_DATA_REQUIRED',
      missing: ['peso', 'altura'],
    });
    montar();

    (await screen.findByText('Cotar')).click();

    // Assumir 500 g e caixa 10x15x20 é o defeito que o servidor já recusava; a
    // tela precisa mostrar a recusa em vez de engoli-la.
    expect(await screen.findByText(/Não dá para cotar sem: peso, altura/)).toBeTruthy();
  });

  it('resultado simulado sai com tarja, e a tarja diz para não cobrar', async () => {
    vi.spyOn(coreApi, 'quoteShipping').mockResolvedValue({
      options: [
        { carrier: 'correios', service: 'PAC', priceInCents: 2350, estimatedDays: 6 },
      ],
      simulated: true,
      real: false,
    });
    montar();

    (await screen.findByText('Cotar')).click();

    expect(await screen.findByText('COTAÇÃO SIMULADA')).toBeTruthy();
    expect(screen.getByText(/Não use para cobrar do cliente/)).toBeTruthy();
    expect(screen.getByText(/PAC/)).toBeTruthy();
  });

  it('cotação real NÃO leva tarja de simulada', async () => {
    vi.spyOn(coreApi, 'quoteShipping').mockResolvedValue({
      options: [{ carrier: 'correios', service: 'SEDEX', priceInCents: 4210 }],
      simulated: false,
      real: true,
    });
    montar();

    (await screen.findByText('Cotar')).click();

    await screen.findByText(/SEDEX/);
    // Tarja que aparece sempre ensina a ignorar a tarja.
    expect(screen.queryByText('COTAÇÃO SIMULADA')).toBeNull();
  });
});
