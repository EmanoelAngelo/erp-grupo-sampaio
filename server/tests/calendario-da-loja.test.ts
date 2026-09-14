/**
 * O DIA DA LOJA É O DIA DE QUEM ESTÁ ATRÁS DO BALCÃO.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 * Todo recorte de data do sistema comparava o carimbo ISO, que é o relógio de
 * Greenwich. Pelotas está três horas atrás: a venda das 21h30 de 31 de agosto
 * é gravada como 2026-09-01T00:30:00.000Z e, para o banco, era de setembro.
 *
 * Este arquivo cobra a política num lugar só, nos quatro instantes em que ela
 * decide dinheiro:
 *
 *   - 31/08 às 22h — o caso que o dono nomeou;
 *   - a virada de mês, que move faturamento entre competências;
 *   - a virada de ano, que move faturamento entre exercícios;
 *   - a meia-noite local, que é 03:00Z e não 00:00Z.
 *
 * ============================================================================
 * O FUSO DA MÁQUINA NÃO PODE DECIDIR NADA
 * ============================================================================
 *
 * Esta máquina de desenvolvimento roda em America/Sao_Paulo, e é exatamente por
 * isso que o defeito passou despercebido: qualquer teste escrito aqui acerta
 * por acidente. O servidor de produção pode rodar em UTC — é o padrão de quase
 * todo contêiner —, e ali o mesmo código erra o dia.
 *
 * Então este arquivo força `TZ=UTC` ANTES de importar qualquer coisa. Se o
 * módulo voltar a depender do relógio da máquina, é aqui que fica vermelho.
 */
process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';

import {
  comoInstanteFinal,
  comoInstanteInicial,
  DESLOCAMENTO_SQL_HORAS,
  diaDaLoja,
  diaDaLojaSql,
  fimDoDia,
  hojeNaLoja,
  horaDaLoja,
  inicioDoDia,
  limitesDoMes,
  limitesDoPeriodo,
  mesDaLoja,
  oDeslocamentoAindaEFixo,
  somarDias,
} from '../src/services/core/CalendarioOperacional.js';

/** A venda que o dono descreveu: 31 de agosto, 22h, balcão de Pelotas. */
const VENDA_DAS_22H = '2026-09-01T01:00:00.000Z';

// ============================================================================

describe('o dia de um instante', () => {
  it('a máquina está mesmo em UTC — senão este arquivo não prova nada', () => {
    /*
      Guarda do guarda. Se algum dia alguém remover o `process.env.TZ` do topo,
      todos os testes abaixo continuariam passando NESTA máquina (que é
      America/Sao_Paulo) e falhariam só na produção. É o modo exato como o
      defeito original sobreviveu a 3.216 testes.
    */
    expect(new Date(VENDA_DAS_22H).getHours()).toBe(1);
  });

  it('a venda das 22h do dia 31 é do dia 31, não do dia 1º', () => {
    expect(diaDaLoja(VENDA_DAS_22H)).toBe('2026-08-31');
    // E o jeito antigo dizia o contrário. Esta linha é o defeito, por escrito.
    expect(VENDA_DAS_22H.slice(0, 10)).toBe('2026-09-01');
  });

  it('a hora exibida é a hora do relógio da parede', () => {
    expect(horaDaLoja(VENDA_DAS_22H)).toBe('22:00');
  });

  it('a virada do ano segue a mesma regra', () => {
    // Réveillon: 31/12 às 22h em Pelotas já é 01/01 em Greenwich.
    expect(diaDaLoja('2027-01-01T01:00:00.000Z')).toBe('2026-12-31');
    // E o primeiro minuto do ano novo na loja é do ano novo.
    expect(diaDaLoja('2027-01-01T03:00:00.000Z')).toBe('2027-01-01');
  });

  it('meio-dia é meio-dia, nos dois relógios', () => {
    // Fora da faixa das últimas três horas, os dois concordam — e é por isso
    // que o defeito só aparecia à noite.
    expect(diaDaLoja('2026-08-31T15:00:00.000Z')).toBe('2026-08-31');
  });

  it('aceita Date além de texto', () => {
    expect(diaDaLoja(new Date(VENDA_DAS_22H))).toBe('2026-08-31');
  });

  it('instante ilegível é recusado, não vira "hoje"', () => {
    expect(() => diaDaLoja('ontem à noite')).toThrow(/Instante inválido/);
  });

  it('data de calendário entra e sai igual — converter o que não tem hora é inventar uma', () => {
    /*
      Nem toda coluna guarda instante. `entered_at` de um equipamento é
      'AAAA-MM-DD'. Passar isso por `new Date()` produz meia-noite de
      Greenwich, que em Pelotas é o dia anterior às 21h — e a ficha passa a
      dizer "entrou em 11/08" para a máquina que entrou em 12.

      Este caso não é hipotético: ele apareceu ao migrar a garantia, e quatro
      testes de equipamento ficaram vermelhos de uma vez.
    */
    expect(diaDaLoja('2026-08-12')).toBe('2026-08-12');
    expect(diaDaLoja('2026-01-01')).toBe('2026-01-01');
  });
});

// ============================================================================

describe('hoje, e o mês de hoje', () => {
  it('hoje é o dia da loja no instante dado', () => {
    expect(hojeNaLoja(new Date(VENDA_DAS_22H))).toBe('2026-08-31');
    expect(mesDaLoja(new Date(VENDA_DAS_22H))).toBe('2026-08');
  });

  it('sem argumento, responde sobre agora — e é uma data de calendário', () => {
    expect(hojeNaLoja()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================================

describe('as pontas do período viram instantes', () => {
  it('a meia-noite da loja é 03:00 em Greenwich', () => {
    expect(inicioDoDia('2026-08-31')).toBe('2026-08-31T03:00:00.000Z');
  });

  it('o último milissegundo do dia é 02:59:59.999 do dia seguinte', () => {
    expect(fimDoDia('2026-08-31')).toBe('2026-09-01T02:59:59.999Z');
  });

  it('a venda das 22h cabe dentro do dia dela', () => {
    const { inicio, fim } = limitesDoPeriodo('2026-08-31', '2026-08-31');
    expect(VENDA_DAS_22H >= inicio).toBe(true);
    expect(VENDA_DAS_22H <= fim).toBe(true);
  });

  it('e não cabe no dia seguinte', () => {
    const { inicio } = limitesDoPeriodo('2026-09-01', '2026-09-01');
    expect(VENDA_DAS_22H >= inicio).toBe(false);
  });

  it('ponta vazia vira "sem filtro", não erro', () => {
    const aberto = limitesDoPeriodo(null, '');
    expect(VENDA_DAS_22H >= aberto.inicio).toBe(true);
    expect(VENDA_DAS_22H <= aberto.fim).toBe(true);
  });

  it('os sentinelas que as rotas já usam continuam valendo', () => {
    const aberto = limitesDoPeriodo('0000', '9999');
    expect(VENDA_DAS_22H >= aberto.inicio).toBe(true);
    expect(VENDA_DAS_22H <= aberto.fim).toBe(true);
  });

  it('carimbo completo na ponta é aceito — só o dia importa', () => {
    expect(limitesDoPeriodo('2026-08-31T23:00:00.000Z', '2026-08-31').inicio).toBe(
      '2026-08-31T03:00:00.000Z',
    );
  });
});

// ============================================================================

describe('o mês do contador', () => {
  it('agosto começa e termina no relógio da loja', () => {
    const agosto = limitesDoMes('2026-08');
    expect(agosto.primeiroDia).toBe('2026-08-01');
    expect(agosto.ultimoDia).toBe('2026-08-31');
    expect(agosto.inicio).toBe('2026-08-01T03:00:00.000Z');
    expect(agosto.fim).toBe('2026-09-01T02:59:59.999Z');
  });

  it('a venda das 22h do dia 31 é de AGOSTO, e não de setembro', () => {
    const agosto = limitesDoMes('2026-08');
    const setembro = limitesDoMes('2026-09');

    expect(VENDA_DAS_22H >= agosto.inicio && VENDA_DAS_22H <= agosto.fim).toBe(true);
    expect(VENDA_DAS_22H >= setembro.inicio && VENDA_DAS_22H <= setembro.fim).toBe(false);
  });

  it('fevereiro bissexto tem 29 dias, sem tabela escrita à mão', () => {
    expect(limitesDoMes('2028-02').ultimoDia).toBe('2028-02-29');
    expect(limitesDoMes('2026-02').ultimoDia).toBe('2026-02-28');
  });

  it('dezembro fecha na virada do ano', () => {
    const dezembro = limitesDoMes('2026-12');
    expect(dezembro.fim).toBe('2027-01-01T02:59:59.999Z');
    expect('2027-01-01T01:00:00.000Z' <= dezembro.fim).toBe(true);
  });
});

// ============================================================================

describe('a vigência que vem da tela', () => {
  /**
   * Um `<input type="date">` devolve 'AAAA-MM-DD'. Quem convertia isso em
   * instante era o navegador, com `new Date(...).toISOString()` — meia-noite de
   * Greenwich. Em Pelotas, 21h do dia anterior.
   *
   * Duas telas faziam essa conta: promoção e validade de orçamento. As duas
   * agora mandam a data crua, e a conversão é do servidor — que é quem sabe o
   * fuso da loja e quem depois cobra o prazo.
   */
  it('a ponta inicial é a virada do dia, e não 21h do dia anterior', () => {
    expect(comoInstanteInicial('2026-12-01')).toBe('2026-12-01T03:00:00.000Z');
  });

  it('a ponta final vale o dia INTEIRO', () => {
    expect(comoInstanteFinal('2026-12-31')).toBe('2027-01-01T02:59:59.999Z');
  });

  it('"válida até 31/12" ainda vale às 23h30 do dia 31', () => {
    expect('2027-01-01T02:30:00.000Z' <= comoInstanteFinal('2026-12-31')).toBe(true);
  });

  it('instante completo passa intocado — quem mandou carimbo sabe o que quer', () => {
    const carimbo = '2026-12-31T18:00:00.000Z';
    expect([comoInstanteInicial(carimbo), comoInstanteFinal(carimbo)]).toEqual([carimbo, carimbo]);
  });
});

// ============================================================================

describe('somar dias não escorrega', () => {
  it('o vencimento de trinta dias cai no dia combinado', () => {
    expect(somarDias('2026-08-31', 30)).toBe('2026-09-30');
  });

  it('atravessa o ano', () => {
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('anda para trás também', () => {
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});

// ============================================================================

describe('o SQL e o JavaScript contam a mesma história', () => {
  /**
   * Duas implementações da mesma regra é uma a mais do que se quer ter. Elas
   * existem porque o SQLite não tem banco de fusos e o JavaScript tem — então
   * o que este bloco compra é o direito de manter as duas: no dia em que
   * discordarem, alguém fica sabendo aqui, e não pelo relatório do contador.
   */
  it('a expressão é uma troca direta de substr(coluna, 1, 10)', () => {
    expect(diaDaLojaSql('created_at')).toBe(
      "substr(datetime(created_at, '-3 hours'), 1, 10)",
    );
  });

  it('o mesmo instante dá o mesmo dia nos dois caminhos', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE carimbos (c TEXT)');
    const inserir = db.prepare('INSERT INTO carimbos VALUES (?)');

    const instantes = [
      VENDA_DAS_22H,
      '2026-08-31T02:59:59.999Z',
      '2026-08-31T03:00:00.000Z',
      '2026-09-01T02:59:59.999Z',
      '2026-09-01T03:00:00.000Z',
      '2027-01-01T01:00:00.000Z',
      '2027-01-01T03:00:00.000Z',
      '2026-02-28T23:30:00.000Z',
      '2026-06-15T12:00:00.000Z',
    ];
    for (const i of instantes) inserir.run(i);

    const linhas = db
      .prepare(`SELECT c, ${diaDaLojaSql('c')} AS dia FROM carimbos`)
      .all() as { c: string; dia: string }[];

    expect(linhas).toHaveLength(instantes.length);
    for (const linha of linhas) {
      expect([linha.c, linha.dia]).toEqual([linha.c, diaDaLoja(linha.c)]);
    }
    db.close();
  });

  it('o deslocamento fixo do SQL descreve o ano inteiro — hoje', () => {
    /*
      O Brasil não tem horário de verão desde 2019. Enquanto for assim, o
      deslocamento fixo do SQL e a conversão do Intl coincidem em todo dia do
      ano. Se voltar a ter, esta asserção é o aviso — e o único arquivo a mudar
      é o do calendário.
    */
    const divergentes: string[] = [];
    for (let dia = 0; dia < 365; dia += 1) {
      const instante = new Date(Date.UTC(2026, 0, 1, 15, 0, 0) + dia * 86_400_000);
      if (!oDeslocamentoAindaEFixo(instante)) divergentes.push(instante.toISOString());
    }
    expect([DESLOCAMENTO_SQL_HORAS, divergentes]).toEqual([-3, []]);
  });
});
