/**
 * ============================================================================
 * A FOTOGRAFIA GUARDA A CHAVE DO DIA EM QUE FOI TIRADA
 * ============================================================================
 *
 * Rotacionar a chave do cofre não alcança os backups já feitos. Cada um
 * continua com os cinco segredos selados pela chave que valia naquele dia — e,
 * nesta instalação, aquela chave era a PADRÃO de desenvolvimento, escrita no
 * repositório. Eram 529 arquivos no bucket e 717 no disco.
 *
 * Depois da rotação os backups novos só abrem com uma chave que existe apenas
 * no `.env` do servidor. Dois grupos, tratamentos diferentes.
 *
 * ## E por que o expurgo não é automático
 *
 * Porque a tentação é apagar os legados no mesmo dia — eles são o passivo — e
 * essa pressa troca um problema de exposição por um de PERDA. O backup
 * pré-rotação é o único caminho de volta se algo na rotação tiver escapado, e
 * "algo escapou" é uma frase que só aparece depois.
 *
 * Este arquivo trava a ordem: backup novo confirmado, restauração conferida,
 * retenção mínima satisfeita SEM contar os legados. Faltando qualquer uma, a
 * resposta é não — e vem com o motivo escrito.
 */
import { describe, expect, it } from 'vitest';

const { classificarBackup, classificarBackups, podeExpurgarLegados } = await import(
  '../src/db/backupClassification.js'
);

const ROTACAO = '2026-08-27T13:42:13.194Z';

// ============================================================================

describe('de que lado da rotação está cada arquivo', () => {
  it('anterior à rotação é LEGACY_ENCRYPTION_KEY', () => {
    expect(classificarBackup('2026-08-25T00:00:00.000Z', ROTACAO)).toBe('LEGACY_ENCRYPTION_KEY');
  });

  it('posterior é CURRENT_ENCRYPTION_KEY', () => {
    expect(classificarBackup('2026-08-27T14:33:14.649Z', ROTACAO)).toBe('CURRENT_ENCRYPTION_KEY');
  });

  it('o empate conta como LEGADO — o lado seguro é o pessimista', () => {
    /*
      Um arquivo criado no mesmo instante da rotação pode ter sido tirado
      imediatamente antes dela. Errar para o lado de "ainda é legado" custa uma
      classificação a mais; errar para o outro lado deixa um arquivo exposto
      passando por limpo.
    */
    expect(classificarBackup(ROTACAO, ROTACAO)).toBe('LEGACY_ENCRYPTION_KEY');
  });

  it('sem rotação nenhuma, não há dois grupos a separar', () => {
    expect(classificarBackup('2026-08-25T00:00:00.000Z', null)).toBe('UNKNOWN');
  });

  it('a lista sai do mais novo para o mais velho, classificada', () => {
    const r = classificarBackups(
      [
        { nome: 'b', criadoEm: '2026-08-20T00:00:00.000Z', bytes: 1 },
        { nome: 'c', criadoEm: '2026-08-28T00:00:00.000Z', bytes: 1 },
        { nome: 'a', criadoEm: '2026-08-10T00:00:00.000Z', bytes: 1 },
      ],
      ROTACAO,
    );
    expect(r.map((x) => x.nome)).toEqual(['c', 'b', 'a']);
    expect(r.map((x) => x.selo)).toEqual([
      'CURRENT_ENCRYPTION_KEY',
      'LEGACY_ENCRYPTION_KEY',
      'LEGACY_ENCRYPTION_KEY',
    ]);
  });
});

// ============================================================================

describe('apagar o histórico exige as quatro condições', () => {
  const completo = {
    backupNovoValidado: true,
    restauracaoValidada: true,
    novosDisponiveis: 7,
    retencaoMinima: 7,
  };

  it('com todas satisfeitas, é permitido', () => {
    const v = podeExpurgarLegados(completo);
    expect(v.permitido).toBe(true);
    expect(v.motivos).toEqual([]);
  });

  it('sem backup novo confirmado, não', () => {
    const v = podeExpurgarLegados({ ...completo, backupNovoValidado: false });
    expect(v.permitido).toBe(false);
    expect(v.motivos.join(' ')).toContain('pós-rotação');
  });

  it('sem restauração conferida, não — subir não é o mesmo que voltar', () => {
    /*
      Backup que sobe e não volta é um arquivo caro. É o erro clássico: a
      confiança vem do upload ter dado 200, e a descoberta vem no dia do
      desastre.
    */
    const v = podeExpurgarLegados({ ...completo, restauracaoValidada: false });
    expect(v.permitido).toBe(false);
    expect(v.motivos.join(' ')).toContain('restaurado');
  });

  it('com menos backups novos que a retenção mínima, não', () => {
    const v = podeExpurgarLegados({ ...completo, novosDisponiveis: 1 });
    expect(v.permitido).toBe(false);
    expect(v.motivos.join(' ')).toContain('retenção mínima');
  });

  it('faltando várias, todas são ditas — e não só a primeira', () => {
    // Quem vai apagar precisa saber tudo o que falta de uma vez, senão descobre
    // uma condição por tentativa.
    const v = podeExpurgarLegados({
      backupNovoValidado: false,
      restauracaoValidada: false,
      novosDisponiveis: 0,
      retencaoMinima: 7,
    });
    expect(v.permitido).toBe(false);
    expect(v.motivos).toHaveLength(3);
  });

  it('o padrão de um estado vazio é NÃO', () => {
    const v = podeExpurgarLegados({
      backupNovoValidado: false,
      restauracaoValidada: false,
      novosDisponiveis: 0,
      retencaoMinima: 0,
    });
    expect(v.permitido).toBe(false);
  });
});
