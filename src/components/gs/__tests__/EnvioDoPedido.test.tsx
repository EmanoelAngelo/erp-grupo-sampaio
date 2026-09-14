/**
 * O ENVIO NA FICHA DO PEDIDO (GAP-PRD-120, GAP-PRD-119) — o lado da tela.
 *
 * Antes não havia nada: a etiqueta era comprada e impressa fora do sistema, e
 * o rastreio era um código digitado num prompt. O que esta tela precisa fazer,
 * e este arquivo cobra com o cliente da API dublado:
 *
 *   - dizer o que falta para comprar a etiqueta, com o link da tela que resolve;
 *   - pedir a CONFIRMAÇÃO do destinatário (o endereço do pedido é texto livre)
 *     e perguntar antes de gastar saldo;
 *   - mostrar cada envio com o link da transportadora, a falha da última
 *     consulta e os eventos com a origem (transportadora × loja, com o nome);
 *   - oferecer só o que o servidor diz que cabe (`actions`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EnvioDoPedido } from '../EnvioDoPedido';
import { enviosApi, type Envio, type ProntidaoDaEtiqueta } from '@/lib/api/envios';

function prontidao(over: Partial<ProntidaoDaEtiqueta> = {}): ProntidaoDaEtiqueta {
  return {
    pedido: { id: 'ord-1', number: 1009, status: 'embalado', entrega: true },
    canal: { mode: 'sandbox', ambiente: 'sandbox', disponivel: true, motivo: null },
    envioVivo: null,
    servico: { code: '1', name: 'Correios PAC' },
    pacote: { weightGrams: 800, heightCm: 10, widthCm: 30, lengthCm: 40 },
    remetente: { nome: 'Gringa Comércio Ltda', cidade: 'Macapá', uf: 'AP', cep: '68900000' },
    destinatarioSugerido: {
      nome: 'Ana Compradora',
      documento: '11144477735',
      telefone: '96999990000',
      email: 'ana@example.com',
      logradouro: 'Avenida Paulista',
      numero: '1000',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01310100',
    },
    nota: { chave: '1'.repeat(44), numero: 123, ambiente: 'homologation' },
    declaracaoDeConteudoPermitida: false,
    faltando: [],
    podeComprar: true,
    ...over,
  };
}

function envio(over: Partial<Envio> = {}): Envio {
  return {
    id: 'env-1',
    orderId: 'ord-1',
    channel: 'melhor_envio',
    carrier: 'melhor_envio',
    carrierName: 'Melhor Envio',
    serviceCode: '1',
    serviceName: 'Correios PAC',
    environment: 'sandbox',
    status: 'postado',
    statusLabel: 'Postado',
    trackingCode: 'AA123456789BR',
    trackingUrl: 'https://www.melhorrastreio.com.br/rastreio/AA123456789BR',
    priceCents: 2390,
    invoiceKey: null,
    contentDeclaration: false,
    lastError: null,
    lastSync: { at: '2026-09-11T12:00:00.000Z', ok: false, message: 'O Melhor Envio está fora do ar (HTTP 503).' },
    dispatchedAt: '2026-09-11T12:00:00.000Z',
    deliveredAt: null,
    deliveredOrigin: null,
    cancelledAt: null,
    createdAt: '2026-09-10T12:00:00.000Z',
    actions: { pagarEGerar: false, imprimir: true, sincronizar: true, cancelar: false },
    events: [
      { status: 'etiqueta_gerada', description: 'Etiqueta gerada', occurredAt: '2026-09-10T13:00:00.000Z', origin: 'operador', userName: 'Bia Estoque' },
      { status: 'postado', description: 'Encomenda postada na transportadora', occurredAt: '2026-09-11T12:30:00.000Z', origin: 'provedor', userName: null },
    ],
    ...over,
  };
}

function montar() {
  render(
    <MemoryRouter>
      <EnvioDoPedido orderId="ord-1" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('o que falta para a etiqueta, dito pelo nome', () => {
  it('lista as pendências com o link da tela que resolve, e não oferece a compra', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({
      readiness: prontidao({
        podeComprar: false,
        faltando: [
          { chave: 'remetente', mensagem: 'Complete o endereço do remetente em Fiscal → Configuração: CNPJ.', onde: '/sistema/fiscal/configuracao' },
          { chave: 'nota', mensagem: 'Emita a NF-e do pedido antes de comprar a etiqueta.', onde: null },
        ],
      }),
      items: [],
    });
    montar();

    const lista = await screen.findByTestId('envio-o-que-falta');
    expect(lista.textContent).toContain('CNPJ');
    expect(lista.textContent).toContain('Emita a NF-e');
    expect(screen.getByRole('link', { name: 'Resolver' }).getAttribute('href')).toBe('/sistema/fiscal/configuracao');
    expect(screen.queryByTestId('compra-da-etiqueta')).toBeNull();
  });

  it('pedido já despachado por fora não pede etiqueta nenhuma', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({
      readiness: prontidao({ podeComprar: false, faltando: [{ chave: 'despachado', mensagem: 'O pedido já saiu da loja.', onde: null }] }),
      items: [],
    });
    montar();
    await waitFor(() => expect(screen.queryByText('Consultando o envio…')).toBeNull());
    expect(screen.queryByTestId('envio-o-que-falta')).toBeNull();
    expect(screen.queryByTestId('compra-da-etiqueta')).toBeNull();
  });
});

describe('a compra: destinatário confirmado, pergunta antes de gastar saldo', () => {
  it('preenche com a sugestão, deixa corrigir, pergunta e compra com o que está na tela', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({ readiness: prontidao(), items: [] });
    const comprar = vi.spyOn(enviosApi, 'comprarEtiqueta').mockResolvedValue({ envio: envio(), aviso: null });
    montar();

    const rua = (await screen.findByLabelText('Rua')) as HTMLInputElement;
    expect(rua.value).toBe('Avenida Paulista');
    expect(screen.getByText(/SANDBOX/)).toBeTruthy();
    expect(screen.getByText(/NF-e nº 123 vai na etiqueta/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Complemento'), { target: { value: 'Apto 12' } });

    screen.getByRole('button', { name: 'Comprar etiqueta' }).click();
    expect((await screen.findByText(/sai do saldo da carteira/)).textContent).toContain('Correios PAC');
    expect(comprar).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Sim, comprar' }).click();

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    const [orderId, corpo] = comprar.mock.calls[0];
    expect(orderId).toBe('ord-1');
    expect(corpo.servico).toEqual({ code: '1', name: 'Correios PAC' });
    expect(corpo.destinatario).toMatchObject({ logradouro: 'Avenida Paulista', complemento: 'Apto 12', cep: '01310100' });
  });

  it('compra que parou no saldo mostra a frase do provedor', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({ readiness: prontidao(), items: [] });
    vi.spyOn(enviosApi, 'comprarEtiqueta').mockResolvedValue({
      envio: envio({ status: 'pendente', statusLabel: 'No carrinho do provedor — não paga' }),
      aviso: 'O envio está no carrinho do Melhor Envio, mas não foi pago: Saldo insuficiente.',
    });
    montar();
    (await screen.findByRole('button', { name: 'Comprar etiqueta' })).click();
    (await screen.findByRole('button', { name: 'Sim, comprar' })).click();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Saldo insuficiente/);
  });

  it('pedido vendido pela tabela da loja: cota os serviços e compra o escolhido', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({ readiness: prontidao({ servico: null }), items: [] });
    vi.spyOn(enviosApi, 'servicos').mockResolvedValue({
      options: [
        { code: '1', name: 'Correios PAC', priceCents: 2390, estimatedDays: 8, environment: 'sandbox' },
        { code: '2', name: 'Correios SEDEX', priceCents: 3810, estimatedDays: 3, environment: 'sandbox' },
      ],
      message: null,
    });
    const comprar = vi.spyOn(enviosApi, 'comprarEtiqueta').mockResolvedValue({ envio: envio(), aviso: null });
    montar();

    expect((await screen.findByRole('button', { name: 'Comprar etiqueta' }) as HTMLButtonElement).disabled).toBe(true);
    screen.getByRole('button', { name: 'Cotar serviços para este pedido' }).click();
    fireEvent.change(await screen.findByLabelText('Serviço'), { target: { value: '2' } });
    screen.getByRole('button', { name: 'Comprar etiqueta' }).click();
    expect((await screen.findByText(/sai do saldo da carteira/)).textContent).toMatch(/R\$\s?38,10/);
    screen.getByRole('button', { name: 'Sim, comprar' }).click();
    await waitFor(() => expect(comprar).toHaveBeenCalled());
    expect(comprar.mock.calls[0][1].servico).toEqual({ code: '2', name: 'Correios SEDEX' });
  });
});

describe('o envio: link, falha da consulta e origem de cada evento', () => {
  it('mostra o link da transportadora, a falha da última consulta e quem disse cada coisa', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({ readiness: prontidao({ envioVivo: { id: 'env-1', status: 'postado', channel: 'melhor_envio' } }), items: [envio()] });
    montar();

    const link = await screen.findByRole('link', { name: 'Acompanhar na transportadora' });
    expect(link.getAttribute('href')).toBe('https://www.melhorrastreio.com.br/rastreio/AA123456789BR');
    expect(screen.getByText(/A última consulta ao provedor falhou/).textContent).toContain('HTTP 503');
    expect(screen.getByText(/Encomenda postada na transportadora/).textContent).toContain('pela transportadora');
    expect(screen.getByText(/Etiqueta gerada/, { selector: 'li' }).textContent).toContain('pela loja (Bia Estoque)');
    // Com envio vivo, a compra não aparece.
    expect(screen.queryByTestId('compra-da-etiqueta')).toBeNull();
    // Só o que o servidor permite.
    expect(screen.queryByRole('button', { name: 'Cancelar etiqueta' })).toBeNull();
  });

  it('imprimir pede o link na hora; atualizar rastreio consulta o provedor', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({ readiness: prontidao(), items: [envio()] });
    vi.spyOn(enviosApi, 'linkDaEtiqueta').mockResolvedValue({ url: 'https://melhorenvio.com.br/imprimir/abc' });
    const atualizar = vi.spyOn(enviosApi, 'atualizarRastreio').mockResolvedValue(envio({ lastSync: { at: '2026-09-11T13:00:00.000Z', ok: true, message: null } }));
    montar();

    (await screen.findByRole('button', { name: 'Imprimir etiqueta' })).click();
    const abrir = await screen.findByRole('link', { name: 'Abrir a etiqueta para imprimir' });
    expect(abrir.getAttribute('href')).toBe('https://melhorenvio.com.br/imprimir/abc');

    screen.getByRole('button', { name: 'Atualizar rastreio' }).click();
    await waitFor(() => expect(atualizar).toHaveBeenCalledWith('env-1'));
  });

  it('cancelar pede o motivo antes', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({
      readiness: prontidao(),
      items: [envio({ status: 'etiqueta_gerada', statusLabel: 'Etiqueta gerada', actions: { pagarEGerar: false, imprimir: true, sincronizar: true, cancelar: true } })],
    });
    const cancelar = vi.spyOn(enviosApi, 'cancelar').mockResolvedValue(envio({ status: 'cancelado' }));
    montar();

    (await screen.findByRole('button', { name: 'Cancelar etiqueta' })).click();
    const confirmar = (await screen.findByRole('button', { name: 'Sim, cancelar' })) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo do cancelamento'), { target: { value: 'Cliente mudou o endereço' } });
    confirmar.click();
    await waitFor(() => expect(cancelar).toHaveBeenCalledWith('env-1', 'Cliente mudou o endereço'));
  });

  it('envio parado no carrinho oferece "Tentar de novo"', async () => {
    vi.spyOn(enviosApi, 'doPedido').mockResolvedValue({
      readiness: prontidao(),
      items: [
        envio({
          status: 'pendente',
          statusLabel: 'No carrinho do provedor — não paga',
          lastError: 'O Melhor Envio recusou o envio (HTTP 422). O provedor disse: Saldo insuficiente.',
          lastSync: null,
          actions: { pagarEGerar: true, imprimir: false, sincronizar: false, cancelar: true },
        }),
      ],
    });
    const continuar = vi.spyOn(enviosApi, 'continuar').mockResolvedValue({ envio: envio(), aviso: null });
    montar();

    expect((await screen.findByText(/Saldo insuficiente/)).getAttribute('role')).toBe('alert');
    screen.getByRole('button', { name: 'Tentar de novo (pagar e gerar)' }).click();
    await waitFor(() => expect(continuar).toHaveBeenCalledWith('env-1'));
  });
});
