/**
 * Filtro de listagem: o que a pessoa digita tem que achar o que ela vê.
 *
 * O caso com DÍGITO existe por acidente real: a normalização de acentos foi
 * escrita com o intervalo de combining marks escapado errado
 * (`[0300-036f]` em vez de `[̀-ͯ]`), e o que parecia um detalhe de
 * escrita virou um filtro que apagava números do valor comparado — buscar
 * "1234" passava a casar com qualquer coisa.
 */
import { describe, expect, it } from 'vitest';
import { aplicarFiltros, type FiltroAtivo } from '../filtros';

interface Produto {
  nome: string;
  codigo: string;
  ativo: string;
}

const PRODUTOS: Produto[] = [
  { nome: 'Óleo 20W50', codigo: '1234', ativo: 'sim' },
  { nome: 'Pneu Aro 17', codigo: '5678', ativo: 'sim' },
  { nome: 'Câmara de ar', codigo: '9012', ativo: 'nao' },
];

const ler = (p: Produto, campo: string) => (p as unknown as Record<string, unknown>)[campo];
const filtrar = (ativos: FiltroAtivo[]) => aplicarFiltros(PRODUTOS, ativos, ler);

describe('aplicarFiltros', () => {
  it('sem filtro, devolve a lista inteira', () => {
    expect(filtrar([])).toHaveLength(3);
  });

  it('acha por trecho do nome', () => {
    expect(filtrar([{ campo: 'nome', valor: 'pneu' }]).map((p) => p.codigo)).toEqual(['5678']);
  });

  it('ignora acento: "camara" acha "Câmara"', () => {
    expect(filtrar([{ campo: 'nome', valor: 'camara' }]).map((p) => p.codigo)).toEqual(['9012']);
  });

  it('ignora maiúscula', () => {
    expect(filtrar([{ campo: 'nome', valor: 'ÓLEO' }]).map((p) => p.codigo)).toEqual(['1234']);
  });

  /** O caso que o bug quebrava: dígito não pode ser removido na normalização. */
  it('não come dígitos do valor comparado', () => {
    expect(filtrar([{ campo: 'codigo', valor: '1234' }]).map((p) => p.nome)).toEqual(['Óleo 20W50']);
    expect(filtrar([{ campo: 'codigo', valor: '0000' }])).toHaveLength(0);
  });

  it('combina filtros com E, não com OU', () => {
    expect(filtrar([{ campo: 'ativo', valor: 'sim' }])).toHaveLength(2);
    expect(
      filtrar([
        { campo: 'ativo', valor: 'sim' },
        { campo: 'nome', valor: 'pneu' },
      ]),
    ).toHaveLength(1);
  });

  it('campo ausente no item não derruba o filtro', () => {
    expect(filtrar([{ campo: 'inexistente', valor: 'x' }])).toHaveLength(0);
  });
});
