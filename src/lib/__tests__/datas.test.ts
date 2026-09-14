/**
 * A DATA NA TELA É A DA LOJA — não a do navegador de quem está olhando.
 *
 * ============================================================================
 * OS DOIS DEFEITOS COBRADOS AQUI
 * ============================================================================
 *
 * 1. `new Date('2026-12-31').toLocaleDateString('pt-BR')` devolve '30/12/2026'
 *    em qualquer máquina a oeste de Greenwich. Vencimento, competência,
 *    validade de orçamento e prazo de promoção são datas de calendário, e
 *    todas apareciam um dia atrás.
 *
 * 2. Um carimbo UTC formatado sem fuso usa o relógio da MÁQUINA. O dono abre o
 *    painel do notebook, o contador abre de outro lugar, e a venda das 21h30
 *    aparece em dias diferentes para cada um.
 *
 * ============================================================================
 * O NAVEGADOR DO TESTE NÃO PODE ESTAR NO BRASIL
 * ============================================================================
 *
 * `TZ=UTC` antes de qualquer import. Sem isso, esta máquina (que roda em
 * America/Sao_Paulo) acerta por acidente — e foi assim que o defeito
 * atravessou 860 testes de tela.
 */
process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';

import {
  dataBR,
  dataHoraBR,
  hojeNaLoja,
  horaBR,
  mesAnoBR,
  mesDaLoja,
  primeiroDiaDoMes,
} from '../datas';

/** 21h30 de 31/08 em Pelotas. Em Greenwich já é 1º de setembro. */
const VENDA_DAS_21H30 = '2026-09-01T00:30:00.000Z';

// ============================================================================

describe('data de calendário não vira instante', () => {
  it('a máquina do teste está em UTC — senão nada aqui prova nada', () => {
    expect(new Date(VENDA_DAS_21H30).getHours()).toBe(0);
  });

  it('31/12 é 31/12, e não 30/12', () => {
    expect(dataBR('2026-12-31')).toBe('31/12/2026');
  });

  it('o primeiro dia do mês também', () => {
    expect(dataBR('2026-03-01')).toBe('01/03/2026');
  });

  it('e o jeito antigo errava — o defeito, por escrito', () => {
    // Documenta a causa: `new Date` lê data pura como meia-noite de Greenwich.
    expect(new Date('2026-12-31').getUTCHours()).toBe(0);
  });

  it('data pura não ganha hora inventada', () => {
    expect(dataHoraBR('2026-12-31')).toBe('31/12/2026');
  });

  it('mês e ano de uma data pura saem sem conversão', () => {
    expect(mesAnoBR('2026-01-01')).toBe('01/2026');
  });
});

// ============================================================================

describe('instante é lido no relógio da loja', () => {
  it('a venda das 21h30 aparece no dia 31', () => {
    expect(dataBR(VENDA_DAS_21H30)).toBe('31/08/2026');
  });

  it('com a hora do balcão, não a de Greenwich', () => {
    expect(dataHoraBR(VENDA_DAS_21H30)).toBe('31/08/2026, 21:30');
    expect(horaBR(VENDA_DAS_21H30)).toBe('21:30');
  });

  it('a virada de ano segue a mesma regra', () => {
    expect(dataBR('2027-01-01T01:00:00.000Z')).toBe('31/12/2026');
    expect(dataBR('2027-01-01T03:00:00.000Z')).toBe('01/01/2027');
  });

  it('o mês de uma venda de 31/08 às 21h30 é agosto', () => {
    expect(mesAnoBR(VENDA_DAS_21H30)).toBe('08/2026');
  });
});

// ============================================================================

describe('ausência e lixo não viram data', () => {
  it('vazio, nulo e indefinido mostram o travessão', () => {
    expect([dataBR(null), dataBR(undefined), dataBR('')]).toEqual(['—', '—', '—']);
  });

  it('texto ilegível não vira "Invalid Date" na tela', () => {
    expect(dataBR('ontem')).toBe('—');
    expect(dataHoraBR('ontem')).toBe('—');
  });

  it('a tela pode escolher a própria frase para a ausência', () => {
    expect(dataBR(null, 'Sem prazo')).toBe('Sem prazo');
  });
});

// ============================================================================

describe('hoje, para o filtro que abre na tela', () => {
  it('às 21h30 do dia 31, hoje ainda é o dia 31', () => {
    expect(hojeNaLoja(new Date(VENDA_DAS_21H30))).toBe('2026-08-31');
    expect(mesDaLoja(new Date(VENDA_DAS_21H30))).toBe('2026-08');
    expect(primeiroDiaDoMes(new Date(VENDA_DAS_21H30))).toBe('2026-08-01');
  });

  it('e o jeito antigo abriria a tela já no dia seguinte', () => {
    expect(new Date(VENDA_DAS_21H30).toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('sem argumento, responde sobre agora, no formato do campo de data', () => {
    expect(hojeNaLoja()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
