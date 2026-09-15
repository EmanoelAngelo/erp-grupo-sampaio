/**
 * O LIMITE DE DESCONTO POR PERFIL E O MOTIVO OBRIGATÓRIO NA TELA DA POLÍTICA
 * (P0 da Preço Justo).
 *
 * O que não pode errar:
 *
 * 1. O QUE ESTÁ GRAVADO APARECE — cada perfil numa linha, percentual como
 *    número e valor em reais no formato brasileiro, e vazio onde não há teto.
 * 2. O QUE SAI NO FIO É A LISTA INTEIRA, EM TEXTO — a mesma régua dos outros
 *    campos da tela: `''` é "sem este teto", e quem recusa o erro de digitação
 *    é o servidor. Por isso os casos olham o CORPO da requisição.
 * 3. SERVIDOR ANTIGO NÃO RECEBE O QUE NÃO CONHECE — sem `perfisComLimite` na
 *    leitura, a tabela não aparece e o corpo sai como antes. O inverso (mandar a
 *    lista a quem conhece sem ter lido o gravado) apagaria os limites de todos.
 *
 * Como falha: tirando o portão de `perfisComLimite`, o terceiro caso manda os
 * campos novos; convertendo o texto na tela, o segundo recebe números.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PoliticaVendaPage from '../PoliticaVendaPage';

const DEFINIDOS = {
  discountLimitPercent: false,
  creditSaleDueDays: false,
  reservationValidDays: false,
  cashWithdrawalLimitCents: false,
};

/** Servidor de antes desta rodada: nada de perfis nem de motivo. */
const SERVIDOR_ANTIGO = {
  discountLimitPercent: 10,
  creditSaleDueDays: 0,
  reservationValidDays: 7,
  cashWithdrawalLimitCents: null,
  definidos: DEFINIDOS,
};

/** A atendente limitada a 5% e R$ 50,00; o motivo exigido na operação. */
const COM_LIMITES = {
  ...SERVIDOR_ANTIGO,
  workshopCreditEnabled: false,
  discountReasonRequired: true,
  definidos: { ...DEFINIDOS, workshopCreditEnabled: false, discountReasonRequired: true },
  perfisComLimite: ['operador_caixa_loja', 'atendente', 'gerente_loja'],
  limitesPorPerfil: [
    { profileCode: 'atendente', maxPercent: 5, maxCents: 5000, itemMaxPercent: null, itemMaxCents: null },
  ],
};

let enviados: Record<string, unknown>[] = [];

function servidor(leitura: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') enviados.push(init?.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify(leitura), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function montar() {
  render(
    <MemoryRouter>
      <PoliticaVendaPage />
    </MemoryRouter>,
  );
}

const campo = (nome: string) => screen.getByRole('textbox', { name: nome }) as HTMLInputElement;
const motivo = () =>
  screen.getByRole('checkbox', { name: 'Exigir motivo na liberação de desconto' }) as HTMLInputElement;

describe('limite de desconto por perfil na tela da política', () => {
  it('o que está gravado aparece: cada perfil numa linha, e vazio onde não há teto', async () => {
    servidor(COM_LIMITES);
    montar();

    await waitFor(() => expect(campo('Atendente: desconto da venda (%)').value).toBe('5'));
    expect(campo('Atendente: desconto da venda (R$)').value).toBe('50,00');
    expect(campo('Atendente: desconto por item (%)').value).toBe('');
    expect(campo('Operador de caixa (loja): desconto da venda (%)').value).toBe('');
    expect(campo('Gerente de loja: desconto por item (R$)').value).toBe('');
    expect(motivo().checked).toBe(true);
  });

  it('salvar manda a lista INTEIRA, em texto, e o motivo como escolha explícita', async () => {
    servidor(COM_LIMITES);
    montar();

    await waitFor(() => expect(campo('Atendente: desconto da venda (%)').value).toBe('5'));
    fireEvent.change(campo('Operador de caixa (loja): desconto por item (%)'), { target: { value: '15' } });
    fireEvent.click(motivo());
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0].discountReasonRequired).toBe(false);
    expect(enviados[0].limitesPorPerfil).toEqual([
      { profileCode: 'operador_caixa_loja', maxPercent: '', maxReais: '', itemMaxPercent: '15', itemMaxReais: '' },
      { profileCode: 'atendente', maxPercent: '5', maxReais: '50,00', itemMaxPercent: '', itemMaxReais: '' },
      { profileCode: 'gerente_loja', maxPercent: '', maxReais: '', itemMaxPercent: '', itemMaxReais: '' },
    ]);
  });

  it('servidor antigo: sem tabela, e o corpo sai sem os campos que ele não conhece', async () => {
    servidor(SERVIDOR_ANTIGO);
    montar();

    await waitFor(() => expect(screen.getByRole('button', { name: /Salvar política/ })).toBeTruthy());
    expect(screen.queryByText('Limite de desconto por perfil')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Exigir motivo na liberação de desconto' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).not.toHaveProperty('limitesPorPerfil');
    expect(enviados[0]).not.toHaveProperty('discountReasonRequired');
  });
});
