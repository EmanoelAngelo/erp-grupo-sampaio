/**
 * DIA ÚTIL NO CALENDÁRIO DA LOJA — a conta que o boleto (GAP-PRD-029) e a
 * data de entrega prometida (GAP-PRD-196) fazem.
 *
 * Tudo aqui é data de calendário (AAAA-MM-DD). Nenhuma função olha o fuso do
 * processo: o dia da semana sai do meio-dia de Greenwich da própria data, que
 * é o mesmo dia em qualquer fuso do planeta habitado.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  diaDaSemana,
  ehDiaUtil,
  feriadosNacionais,
  proximoDiaUtil,
  somarDiasUteis,
} from '../src/services/core/DiasUteis.js';

const TZ_ORIGINAL = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ_ORIGINAL;
});

describe('dia da semana', () => {
  it('não depende do fuso do processo', () => {
    for (const fuso of ['UTC', 'America/Sao_Paulo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = fuso;
      expect(diaDaSemana('2026-08-14')).toBe(5); // sexta
      expect(diaDaSemana('2026-08-16')).toBe(0); // domingo
    }
  });
});

describe('feriados nacionais (calendário bancário)', () => {
  it('os fixos e os que dependem da Páscoa, em 2026', () => {
    const f = feriadosNacionais(2026);
    for (const dia of [
      '2026-01-01',
      '2026-02-16', // carnaval, segunda
      '2026-02-17', // carnaval, terça
      '2026-04-03', // sexta-feira da Paixão (Páscoa em 05/04)
      '2026-04-21',
      '2026-05-01',
      '2026-06-04', // Corpus Christi
      '2026-09-07',
      '2026-10-12',
      '2026-11-02',
      '2026-11-15',
      '2026-11-20',
      '2026-12-25',
    ]) {
      expect(f.has(dia), dia).toBe(true);
    }
    expect(f.has('2026-04-05')).toBe(false); // Páscoa é domingo, não entra na lista
  });

  it('a Páscoa de outros anos também sai certa', () => {
    // Páscoa: 2027-03-28, 2030-04-21 → Paixão dois dias antes.
    expect(feriadosNacionais(2027).has('2027-03-26')).toBe(true);
    expect(feriadosNacionais(2030).has('2030-04-19')).toBe(true);
  });
});

describe('contagem', () => {
  it('fim de semana e feriado não são dia útil', () => {
    expect(ehDiaUtil('2026-08-14')).toBe(true);
    expect(ehDiaUtil('2026-08-15')).toBe(false);
    expect(ehDiaUtil('2026-08-16')).toBe(false);
    expect(ehDiaUtil('2026-09-07')).toBe(false);
  });

  it('próximo dia útil: o próprio dia quando já é útil', () => {
    expect(proximoDiaUtil('2026-09-11')).toBe('2026-09-11');
    expect(proximoDiaUtil('2026-09-12')).toBe('2026-09-14');
    expect(proximoDiaUtil('2026-09-05')).toBe('2026-09-08'); // sábado, domingo, feriado
  });

  it('somar dias úteis pula fim de semana e feriado', () => {
    expect(somarDiasUteis('2026-08-14', 3)).toBe('2026-08-19');
    expect(somarDiasUteis('2026-09-04', 1)).toBe('2026-09-08');
    expect(somarDiasUteis('2026-12-24', 1)).toBe('2026-12-28');
    expect(somarDiasUteis('2026-08-14', 0)).toBe('2026-08-14');
  });

  it('aceita o carimbo completo e usa só a data', () => {
    expect(somarDiasUteis('2026-08-14T23:59:00.000Z', 1)).toBe('2026-08-17');
  });

  it('recusa quantidade negativa ou fracionada', () => {
    expect(() => somarDiasUteis('2026-08-14', -1)).toThrow();
    expect(() => somarDiasUteis('2026-08-14', 1.5)).toThrow();
  });
});
