/**
 * O prazo que o cliente lê — e o que a loja NÃO promete.
 *
 * Prometer data de entrega inventada é dívida: o cliente organiza o dia por
 * ela, e quem não cumpre é a loja. Por isso são três estados, e nenhum deles
 * é um chute:
 *
 *   - DATA só depois da postagem, e só quando alguém cotou um prazo;
 *   - antes disso, o PRAZO em dias — contar a partir de hoje anteciparia a
 *     promessa a cada vez que a tela abrisse;
 *   - sem prazo cotado, a tela diz que o prazo sai no envio.
 *
 * E a origem acompanha: prazo de transportadora e estimativa da loja não
 * valem o mesmo.
 */
import { describe, expect, it } from 'vitest';
import { deliveryEstimate } from '../src/services/core/CustomerPortalService.js';

/** Uma sexta-feira, para os testes de dia útil não dependerem de "hoje". */
const SEXTA = '2026-08-14T12:00:00.000Z';

describe('sem prazo cotado', () => {
  it('não inventa nada', () => {
    const e = deliveryEstimate({
      status: 'expedido',
      estimatedDays: null,
      quoteReal: false,
      dispatchedAt: SEXTA,
    });
    expect(e.kind).toBe('sem_prazo');
    expect(e.dueDate).toBeNull();
  });

  it('prazo zero ou negativo também é ausência de prazo', () => {
    for (const dias of [0, -3]) {
      expect(
        deliveryEstimate({ status: 'expedido', estimatedDays: dias, quoteReal: true, dispatchedAt: SEXTA })
          .kind,
      ).toBe('sem_prazo');
    }
  });
});

describe('antes da postagem', () => {
  it('mostra o PRAZO, não a data', () => {
    for (const status of ['aguardando_pagamento', 'pago', 'separacao', 'embalado']) {
      const e = deliveryEstimate({
        status,
        estimatedDays: 4,
        quoteReal: true,
        dispatchedAt: null,
      });
      // A separação ainda pode demorar: a data ainda não é da loja para dar.
      expect(e.kind).toBe('previsto');
      expect(e.days).toBe(4);
      expect(e.dueDate).toBeNull();
    }
  });

  it('status expedido mas sem data de postagem também fica em previsto', () => {
    const e = deliveryEstimate({
      status: 'expedido',
      estimatedDays: 3,
      quoteReal: true,
      dispatchedAt: null,
    });
    expect(e.kind).toBe('previsto');
    expect(e.dueDate).toBeNull();
  });
});

describe('depois da postagem', () => {
  it('conta em DIAS ÚTEIS a partir da expedição', () => {
    // Sexta 14/08 + 3 dias úteis = quarta 19/08. Em dias corridos daria 17/08,
    // uma segunda — dois dias antes do que a transportadora prometeu.
    const e = deliveryEstimate({
      status: 'expedido',
      estimatedDays: 3,
      quoteReal: true,
      dispatchedAt: SEXTA,
    });
    expect(e.kind).toBe('prometido');
    expect(new Date(e.dueDate!).toISOString().slice(0, 10)).toBe('2026-08-19');
  });

  it('não cai em sábado nem em domingo', () => {
    // Sexta + 1 dia útil = segunda, nunca sábado.
    const e = deliveryEstimate({
      status: 'expedido',
      estimatedDays: 1,
      quoteReal: true,
      dispatchedAt: SEXTA,
    });
    // A data é dia de calendário (AAAA-MM-DD, GAP-PRD-196): o dia da semana
    // sai do meio-dia de Greenwich, que é o mesmo dia em qualquer fuso.
    const dia = new Date(`${e.dueDate!}T12:00:00.000Z`).getUTCDay();
    expect(dia).not.toBe(0);
    expect(dia).not.toBe(6);
  });

  it('pedido entregue mantém a data prometida', () => {
    const e = deliveryEstimate({
      status: 'entregue',
      estimatedDays: 2,
      quoteReal: true,
      dispatchedAt: SEXTA,
    });
    expect(e.kind).toBe('prometido');
  });
});

describe('a origem do prazo viaja junto', () => {
  it('transportadora e tabela da loja são distinguíveis', () => {
    const transportadora = deliveryEstimate({
      status: 'expedido',
      estimatedDays: 3,
      quoteReal: true,
      dispatchedAt: SEXTA,
    });
    const loja = deliveryEstimate({
      status: 'expedido',
      estimatedDays: 3,
      quoteReal: false,
      dispatchedAt: SEXTA,
    });

    // Esconder a diferença faria a loja responder por promessa que não fez.
    expect(transportadora.real).toBe(true);
    expect(loja.real).toBe(false);
  });
});
