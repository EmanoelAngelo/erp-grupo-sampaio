/**
 * O SELO FISCAL DO BALCÃO DIZ O QUE FALTA — auditoria P0 da Preço Justo.
 *
 * O caixa lia "FISCAL NÃO CONFIGURADO — Esta operação ainda não emite nota." e
 * nada mais. Na Preço Justo a causa era dupla (A1 sem a senha guardada, CSC
 * não gravado), e nenhuma das duas chegava ao balcão com nome. Aqui se cobra:
 *
 *  - a frase do servidor (o que falta e quem resolve) no próprio selo;
 *  - a lista item a item com "quem resolve" e onde;
 *  - o selo se confere de novo quando a janela volta ao foco e pelo botão;
 *  - sem resposta do servidor, o selo diz que não sabe (não some calado);
 *  - sem permissão (403), some;
 *  - em homologação, nunca "FISCAL OK";
 *  - o formato antigo (sem `faltas`) não derruba o balcão.
 *
 * ## Como fica vermelho
 *
 *  - volte o `explica` fixo e o caso da frase não acha "Falta:";
 *  - tire o ouvinte de foco e o caso da reconferência fica em uma chamada;
 *  - volte o `catch` que zera o selo e o caso "sem resposta" não acha o texto.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FiscalBadgePdv } from '@/components/gs/FiscalBadgePdv';
import { ApiRequestError } from '@/lib/api/client';

const api = vi.hoisted(() => ({ getFiscalPdvSummary: vi.fn() }));

vi.mock('@/lib/api/core', () => ({
  coreApi: { getFiscalPdvSummary: api.getFiscalPdvSummary },
}));

const FALTAS = [
  {
    key: 'certificate',
    label: 'Certificado A1',
    texto:
      'O certificado digital A1 está carregado, mas sem a senha guardada: precisa ser reenviado com a senha.',
    quemResolve: 'administrador' as const,
    onde: 'painel administrativo › Fiscal › Certificado',
  },
  {
    key: 'csc',
    label: 'CSC (código de segurança do contribuinte)',
    texto: 'O CSC (código do QR Code da NFC-e) de homologação não está gravado.',
    quemResolve: 'administrador' as const,
    onde: 'Fiscal › Configuração › CSC (o código sai do portal da SEFAZ)',
  },
];

/** O estado da Preço Justo que a auditoria encontrou. */
const PRECO_JUSTO_HOJE = {
  situacao: 'NOT_CONFIGURED' as const,
  readiness: 'READY_FOR_CERTIFICATE',
  canEmit: false,
  ambiente: 'homologation' as const,
  resumo:
    'Esta operação ainda não emite NFC-e. Falta: Certificado A1; CSC (código de segurança do '
    + 'contribuinte). Quem resolve: administrador.',
  faltas: FALTAS,
  blocking: FALTAS.map((f) => ({ key: f.key, label: f.label, detail: f.texto })),
  pendencies: [],
  pendencyCount: 0,
  contingencia: null,
  verificadoEm: '2026-09-15T13:00:00.000Z',
};

const PRONTA_PARA_TESTE = {
  ...PRECO_JUSTO_HOJE,
  situacao: 'TEST_ONLY' as const,
  readiness: 'READY_FOR_SEFAZ_HOMOLOGATION',
  canEmit: true,
  resumo: 'A NFC-e está em HOMOLOGAÇÃO (teste): a nota emitida aqui não tem valor fiscal.',
  faltas: [],
  blocking: [],
};

function abrir() {
  return render(
    <MemoryRouter>
      <FiscalBadgePdv />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  api.getFiscalPdvSummary.mockReset();
});

afterEach(() => cleanup());

describe('o selo diz o que falta', () => {
  it('a frase do servidor está no selo, e a lista diz quem resolve e onde', async () => {
    api.getFiscalPdvSummary.mockResolvedValue(PRECO_JUSTO_HOJE);
    abrir();

    const selo = await screen.findByRole('button', { name: 'FISCAL NÃO CONFIGURADO' });
    // Antes: "Esta operação ainda não emite nota." — sem o que falta.
    expect(selo.getAttribute('title')).toMatch(/Falta: Certificado A1; CSC/);

    fireEvent.click(selo);
    expect(screen.getByText(/sem a senha guardada/)).toBeTruthy();
    expect(screen.getByText(/de homologação não está gravado/)).toBeTruthy();
    expect(screen.getAllByText(/Quem resolve: o administrador/)).toHaveLength(2);
    expect(screen.getByText(/painel administrativo › Fiscal › Certificado/)).toBeTruthy();
    expect(screen.getByText(/Conferido às/)).toBeTruthy();
  });

  it('confere de novo quando a janela volta ao foco e pelo botão', async () => {
    api.getFiscalPdvSummary
      .mockResolvedValueOnce(PRECO_JUSTO_HOJE)
      .mockResolvedValueOnce(PRONTA_PARA_TESTE)
      .mockResolvedValue(PRONTA_PARA_TESTE);
    abrir();
    await screen.findByRole('button', { name: 'FISCAL NÃO CONFIGURADO' });

    // O administrador gravou o A1 e o CSC no painel e o caixa voltou à janela.
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByRole('button', { name: 'FISCAL — HOMOLOGAÇÃO' })).toBeTruthy();
    expect(api.getFiscalPdvSummary).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'FISCAL — HOMOLOGAÇÃO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conferir de novo' }));
    await waitFor(() => expect(api.getFiscalPdvSummary).toHaveBeenCalledTimes(3));
  });

  it('em homologação nunca diz FISCAL OK — a nota não tem valor fiscal', async () => {
    api.getFiscalPdvSummary.mockResolvedValue({ ...PRONTA_PARA_TESTE, situacao: 'READY' });
    abrir();
    const selo = await screen.findByRole('button', { name: 'FISCAL — HOMOLOGAÇÃO' });
    expect(selo.getAttribute('title')).toMatch(/não tem valor fiscal/);
    expect(screen.queryByText('FISCAL OK')).toBeNull();
  });
});

describe('quando não há resposta', () => {
  it('sem resposta do servidor: o selo diz que não sabe, e que venda registrada não é nota autorizada', async () => {
    api.getFiscalPdvSummary.mockRejectedValue(new TypeError('Failed to fetch'));
    abrir();
    const selo = await screen.findByRole('button', { name: 'FISCAL — SEM RESPOSTA' });
    expect(selo.getAttribute('title')).toMatch(/nenhuma NFC-e é autorizada/);

    // Tocar no selo tenta de novo.
    api.getFiscalPdvSummary.mockResolvedValue(PRECO_JUSTO_HOJE);
    fireEvent.click(selo);
    expect(await screen.findByRole('button', { name: 'FISCAL NÃO CONFIGURADO' })).toBeTruthy();
  });

  it('sem permissão (403): o selo some — o assunto não é deste perfil', async () => {
    api.getFiscalPdvSummary.mockRejectedValue(new ApiRequestError('API_PERMISSION_DENIED', 'negado', 403));
    const { container } = abrir();
    await waitFor(() => expect(api.getFiscalPdvSummary).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('o formato antigo, sem `faltas` nem `pendencies`, não derruba o balcão', async () => {
    api.getFiscalPdvSummary.mockResolvedValue({
      situacao: 'NOT_CONFIGURED',
      pendencyCount: 0,
      blocking: [{ key: 'csc', label: 'CSC', detail: 'CSC e CSC ID de homologação não configurados.' }],
    });
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: 'FISCAL NÃO CONFIGURADO' }));
    expect(screen.getByText(/CSC e CSC ID de homologação não configurados/)).toBeTruthy();
  });
});
