/**
 * OS DOCUMENTOS FISCAIS DA OS PAGA — GAP-PRD-024, pela tela.
 *
 * A OS paga não tinha ação fiscal nenhuma (OrdemServicoPage sem ação fiscal,
 * na ficha). O cartão mostra os dois caminhos — peças pela NFC-e, mão de obra
 * pela NFS-e — e só oferece o botão quando o servidor diz que dá.
 *
 * O que cada teste derruba:
 *   - chame a emissão da NFC-e pela rota errada e as peças ficam sem nota;
 *   - ofereça o botão com a NFS-e desligada e o clique leva 409 no balcão;
 *   - esqueça o código de verificação no corpo e o registro do portal é recusado;
 *   - esconda o motivo da recusa e ninguém sabe o que o contador precisa mudar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import { DocumentosFiscaisDaOs } from '../DocumentosFiscaisDaOs';

const SALE = 'sale-1';

let prontidaoNfce: Record<string, unknown>;
let statusNfce: Record<string, unknown> | null;
let nfse: Record<string, unknown>;
let pedidos: { metodo: string; alvo: string; corpo: Record<string, unknown> }[];

function responder(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (metodo !== 'GET') pedidos.push({ metodo, alvo, corpo });
    if (alvo.endsWith(`/fiscal/sales/${SALE}/status`)) return responder(statusNfce);
    if (alvo.endsWith(`/fiscal/sales/${SALE}/emission-readiness`)) return responder(prontidaoNfce);
    if (alvo.endsWith(`/fiscal/sales/${SALE}/emit`) && metodo === 'POST') {
      statusNfce = { document: { id: 'd1' }, statusLabel: 'Autorizada', terminal: true, isTest: false };
      return responder(statusNfce);
    }
    if (alvo.endsWith(`/fiscal/sales/${SALE}/nfse/manual`) && metodo === 'POST') {
      const doc = { id: 'n1', status: 'REGISTRADA', nfseNumber: corpo.numero, accessKey: null, simulated: false, reason: null };
      nfse = { ...nfse, action: 'NENHUMA', reasons: ['Esta venda já tem NFS-e.'], document: doc };
      return responder(doc, 201);
    }
    if (alvo.endsWith(`/fiscal/sales/${SALE}/nfse`) && metodo === 'POST') {
      const doc = { id: 'n1', status: 'AUTORIZADA', nfseNumber: '123', accessKey: '4314', simulated: false, reason: null };
      nfse = { ...nfse, action: 'NENHUMA', reasons: ['Esta venda já tem NFS-e.'], document: doc };
      return responder(doc);
    }
    if (alvo.endsWith(`/fiscal/sales/${SALE}/nfse`)) return responder(nfse);
    return responder({});
  });
}

beforeEach(() => {
  pedidos = [];
  statusNfce = null;
  prontidaoNfce = { canEmit: true, alreadyEmitted: false, reasons: [] };
  nfse = {
    mode: 'EMISSOR_NACIONAL',
    environment: 'homologation',
    action: 'EMITIR',
    canEmit: true,
    serviceCents: 5000,
    description: 'Mão de obra — OS #1',
    reasons: [],
    document: null,
  };
  vi.stubGlobal('fetch', servidor());
  setSession(
    {
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'cx', displayName: 'Caixa', profileCode: 'operador_caixa_oficina' },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode: 'operador_caixa_oficina' },
      ],
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

describe('os dois documentos da OS paga', () => {
  it('peças pela NFC-e e mão de obra pela NFS-e, cada uma pela rota dela', async () => {
    render(<DocumentosFiscaisDaOs saleId={SALE} podeEmitir />);

    fireEvent.click(await screen.findByRole('button', { name: 'Emitir NFC-e das peças' }));
    await screen.findByText('Autorizada');
    expect(pedidos[0]).toMatchObject({ metodo: 'POST', corpo: { developmentMode: false } });
    expect(pedidos[0].alvo).toContain(`/core/fiscal/sales/${SALE}/emit`);

    expect(screen.getByText(/Mão de obra — NFS-e \(R\$\s?50,00\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Emitir NFS-e (homologação — sem valor fiscal)' }));
    await screen.findByText('NFS-e nº 123');
    expect(pedidos[1].alvo).toContain(`/core/fiscal/sales/${SALE}/nfse`);
  });

  it('sem configuração: mostra o motivo que o servidor deu, sem botão', async () => {
    prontidaoNfce = {
      canEmit: false,
      alreadyEmitted: false,
      reasons: ['det — Esta venda é só de serviço (mão de obra, R$ 50,00): o documento dela é a NFS-e, não a nota de mercadoria.'],
    };
    nfse = { ...nfse, mode: 'DESLIGADA', action: 'NENHUMA', canEmit: false, reasons: ['A NFS-e está desligada: a mão de obra da OS fica sem documento.'] };
    render(<DocumentosFiscaisDaOs saleId={SALE} podeEmitir />);

    expect(await screen.findByText(/só de serviço/)).toBeTruthy();
    expect(await screen.findByText(/A NFS-e está desligada/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('registro manual: número, código de verificação e data vão no corpo', async () => {
    nfse = { ...nfse, mode: 'REGISTRO_MANUAL', action: 'REGISTRAR', canEmit: false };
    render(<DocumentosFiscaisDaOs saleId={SALE} podeEmitir />);

    fireEvent.change(await screen.findByLabelText('Número da NFS-e'), { target: { value: '77' } });
    fireEvent.change(screen.getByLabelText('Código de verificação'), { target: { value: 'AB12CD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar NFS-e' }));

    await screen.findByText('NFS-e nº 77');
    const registro = pedidos.find((p) => p.alvo.endsWith('/nfse/manual'))!;
    expect(registro.corpo).toMatchObject({ numero: '77', codigoVerificacao: 'AB12CD', chaveAcesso: null });
    expect(String(registro.corpo.emitidaEm)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('recusada pela Sefin: o motivo aparece e o reenvio é oferecido com o mesmo número', async () => {
    nfse = {
      ...nfse,
      document: { id: 'n1', status: 'REJEITADA', nfseNumber: null, accessKey: null, simulated: false, reason: 'E0310 Código de serviço não permitido' },
    };
    render(<DocumentosFiscaisDaOs saleId={SALE} podeEmitir />);

    expect(await screen.findByText('E0310 Código de serviço não permitido')).toBeTruthy();
    expect(screen.getByText('Recusada')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo (mesmo número de DPS)' })).toBeTruthy();
  });

  it('quem não cobra não recebe botão de emitir', async () => {
    render(<DocumentosFiscaisDaOs saleId={SALE} podeEmitir={false} />);
    await waitFor(() => expect(screen.getByText(/Pronta para emitir/)).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
  });
});
