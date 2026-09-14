/**
 * Codificação EAN-13.
 *
 * Código de barras errado não avisa: imprime bonito, cola no produto, e só
 * falha no balcão com o cliente esperando — ou pior, lê como OUTRO produto.
 * Por isso o que se cobra aqui é a estrutura que o leitor procura, não só o
 * fato de sair um desenho.
 */
import { describe, expect, it } from 'vitest';
import { ean13Bits, ean13Svg } from '../src/services/core/Ean13.js';

/** EAN-13 válido: 789123456789 + dígito verificador 5. */
const VALIDO = '7891234567895';

describe('estrutura do código', () => {
  it('tem 95 módulos — é o tamanho do EAN-13, não uma escolha', () => {
    expect(ean13Bits(VALIDO)).toHaveLength(95);
  });

  it('abre e fecha com a guarda 101', () => {
    const bits = ean13Bits(VALIDO)!;
    expect(bits.startsWith('101')).toBe(true);
    expect(bits.endsWith('101')).toBe(true);
  });

  it('tem a guarda central 01010 no meio exato', () => {
    // 3 (guarda) + 6×7 (metade esquerda) = 45.
    expect(ean13Bits(VALIDO)!.slice(45, 50)).toBe('01010');
  });

  it('o primeiro dígito não vira barra — ele escolhe a paridade', () => {
    // Trocar o primeiro dígito muda a metade ESQUERDA (padrão L/G) e preserva
    // a direita. É o que prova que a paridade está sendo aplicada.
    //
    // A comparação para em 85 de propósito: mudar o primeiro dígito muda
    // também o VERIFICADOR, que é o último e mora na metade direita. Incluí-lo
    // faria o teste acusar diferença que a paridade não causou.
    const a = ean13Bits('0891234567897')!;
    const b = ean13Bits('7891234567895')!;
    expect(a.slice(50, 85)).toBe(b.slice(50, 85));
    expect(a.slice(3, 45)).not.toBe(b.slice(3, 45));
  });
});

describe('o que não é EAN-13 é recusado', () => {
  it.each([
    ['vazio', ''],
    ['curto demais', '789123'],
    ['longo demais', '78912345678956'],
    ['com letra', '78912345678X5'],
    ['com espaço', '789123456789 '],
  ])('%s', (_nome, codigo) => {
    expect(ean13Bits(codigo)).toBeNull();
    expect(ean13Svg(codigo)).toBeNull();
  });
});

describe('SVG', () => {
  it('desenha barras de verdade, não o número escrito', () => {
    const svg = ean13Svg(VALIDO)!;
    expect(svg).toContain('<rect');
    // Uma barra por corrida de módulos contíguos — muito mais que zero, e
    // menos que 95, senão não houve agrupamento.
    const barras = (svg.match(/<rect/g) ?? []).length;
    expect(barras).toBeGreaterThan(20);
    expect(barras).toBeLessThan(95);
  });

  it('reserva a zona de silêncio, senão o leitor não acha o começo', () => {
    // 11 módulos à esquerda + 95 do código + 7 à direita = 113.
    expect(ean13Svg(VALIDO)).toContain('viewBox="0 0 113 28"');
  });

  it('nenhuma barra invade a zona de silêncio esquerda', () => {
    const svg = ean13Svg(VALIDO)!;
    const xs = [...svg.matchAll(/x="(\d+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(11);
  });

  it('a altura pedida é respeitada', () => {
    expect(ean13Svg(VALIDO, 40)).toContain('height="40"');
  });
});
