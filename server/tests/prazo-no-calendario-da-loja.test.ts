/**
 * A DATA PROMETIDA É CONTADA NO CALENDÁRIO DA LOJA (GAP-PRD-196).
 *
 * O DEFEITO: `deliveryEstimate` somava dias com `new Date(dispatchedAt)`,
 * `setDate` e `getDay()` — o relógio do PROCESSO. Num servidor em UTC, uma
 * expedição às 21h30 de quinta em Pelotas já é sexta em Greenwich: a contagem
 * começava no dia seguinte, sábado e domingo entravam no meio, e a data
 * prometida pulava de sexta para segunda. O resto do domínio já usa o
 * calendário da loja (`CalendarioOperacional`); este cálculo não usava.
 *
 * A PROVA roda o MESMO cálculo com o processo em UTC e em São Paulo e cobra a
 * mesma data. A data sai como dia de calendário (AAAA-MM-DD), que a tela
 * reescreve sem converter (`dataBR`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { deliveryEstimate } from '../src/services/core/CustomerPortalService.js';

const TZ_ORIGINAL = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ_ORIGINAL;
});

function prometida(dispatchedAt: string, dias: number): string | null {
  return deliveryEstimate({ status: 'expedido', estimatedDays: dias, quoteReal: true, dispatchedAt })
    .dueDate;
}

describe.each(['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'])('processo em %s', (fuso) => {
  it('quinta às 21h30 na loja + 1 dia útil = sexta', () => {
    process.env.TZ = fuso;
    // 2026-08-13 (quinta) 21:30 em São Paulo = 2026-08-14T00:30Z.
    expect(prometida('2026-08-14T00:30:00.000Z', 1)).toBe('2026-08-14');
  });

  it('domingo às 21h30 na loja + 1 dia útil = segunda', () => {
    process.env.TZ = fuso;
    // 2026-08-16 (domingo) 21:30 em São Paulo = 2026-08-17T00:30Z.
    expect(prometida('2026-08-17T00:30:00.000Z', 1)).toBe('2026-08-17');
  });

  it('sexta de manhã + 3 dias úteis = quarta', () => {
    process.env.TZ = fuso;
    expect(prometida('2026-08-14T12:00:00.000Z', 3)).toBe('2026-08-19');
  });

  it('feriado nacional não conta como dia útil (07/09)', () => {
    process.env.TZ = fuso;
    // Sexta 04/09/2026 + 1 dia útil: segunda 07/09 é Independência → terça.
    expect(prometida('2026-09-04T13:00:00.000Z', 1)).toBe('2026-09-08');
  });
});
