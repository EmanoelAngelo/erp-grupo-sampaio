/**
 * ============================================================================
 * O BUCKET CRESCE PARA SEMPRE
 * ============================================================================
 *
 * A poda local existe desde a rodada 35 — trinta dias, mínimo sete. A remota
 * nunca existiu: o módulo sabia enviar, listar e baixar, e nada apagava. Medido
 * em 27/08/2026: 530 objetos, 2,7 GB, num armazenamento pago, subindo a cada
 * boot do servidor.
 *
 * ============================================================================
 * A POLÍTICA, E POR QUE ELA É ESSA
 * ============================================================================
 *
 * Avô-pai-filho, que é o desenho clássico de retenção, com os prazos vindos do
 * que este sistema guarda:
 *
 *   DIÁRIOS   14 dias — "quebrei alguma coisa esta semana e não percebi".
 *                       Duas semanas cobre o intervalo entre um defeito entrar
 *                       e alguém notar no relatório do mês.
 *
 *   SEMANAIS   8 semanas — dois meses. É o horizonte em que se descobre que um
 *                       lançamento vinha errado desde antes.
 *
 *   MENSAIS   12 meses — o ano fiscal. Nota emitida é guardada por anos, e o
 *                       banco é o que sabe o que foi emitido.
 *
 *   MÍNIMO     7 — por mais velhos que sejam, nunca ficar abaixo disto. É o que
 *                  impede uma política mal configurada de esvaziar o bucket.
 *
 * Nada disso é fixo no código: cada número vem do ambiente, com estes padrões.
 *
 * ============================================================================
 * E O QUE ELA NUNCA APAGA
 * ============================================================================
 *
 * Os backups anteriores à rotação da chave carregam os segredos selados pela
 * chave publicada. São passivo — e são também o ÚNICO caminho de volta se algo
 * na rotação tiver escapado. Apagá-los antes de existir backup novo validado
 * troca um problema de exposição por um de perda.
 *
 * Por isso o plano só inclui legado quando quem chamou disser explicitamente
 * que pode. O padrão é não.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { politicaDeRetencao, planejarExpurgo } = await import('../src/db/backupRetention.js');

const AGORA = new Date('2026-08-27T12:00:00.000Z');
const ROTACAO = '2026-08-27T00:00:00.000Z';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL };
  for (const v of [
    'DEVORA_BACKUP_RETENCAO_DIARIOS',
    'DEVORA_BACKUP_RETENCAO_SEMANAIS',
    'DEVORA_BACKUP_RETENCAO_MENSAIS',
    'DEVORA_BACKUP_RETENCAO_MINIMO',
  ]) delete process.env[v];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** Um objeto por dia, contando para trás a partir de AGORA. */
function objetosDiarios(quantos: number): Array<{ nome: string; criadoEm: string; bytes: number }> {
  return Array.from({ length: quantos }, (_, i) => {
    const d = new Date(AGORA.getTime() - i * 24 * 60 * 60 * 1000);
    return { nome: `grupo-sampaio-${d.toISOString().replace(/[:.]/g, '-')}-diario.db`, criadoEm: d.toISOString(), bytes: 5_000_000 };
  });
}

// ============================================================================

describe('a política vem do ambiente, com padrões explicados', () => {
  it('sem nada declarado, usa os padrões', () => {
    const p = politicaDeRetencao();
    expect(p.diarios).toBe(14);
    expect(p.semanais).toBe(8);
    expect(p.mensais).toBe(12);
    expect(p.minimo).toBe(7);
  });

  it('cada número é configurável', () => {
    process.env.DEVORA_BACKUP_RETENCAO_DIARIOS = '30';
    process.env.DEVORA_BACKUP_RETENCAO_MINIMO = '10';
    const p = politicaDeRetencao();
    expect(p.diarios).toBe(30);
    expect(p.minimo).toBe(10);
  });

  it('valor absurdo cai no padrão em vez de esvaziar o bucket', () => {
    // Um `0` digitado por engano numa variável de ambiente não pode virar
    // "apague tudo".
    process.env.DEVORA_BACKUP_RETENCAO_MINIMO = '0';
    process.env.DEVORA_BACKUP_RETENCAO_DIARIOS = 'abacaxi';
    const p = politicaDeRetencao();
    expect(p.minimo).toBe(7);
    expect(p.diarios).toBe(14);
  });
});

// ============================================================================

describe('o plano de expurgo', () => {
  it('com poucos objetos, não apaga nada', () => {
    const plano = planejarExpurgo(objetosDiarios(5), { agora: AGORA, rotacionadoEm: null });
    expect(plano.apagar).toHaveLength(0);
    expect(plano.manter).toHaveLength(5);
  });

  it('nunca desce do mínimo, por mais velhos que sejam', () => {
    /*
      Todos com dois anos: pela régua de idade, todos sairiam. O mínimo é o que
      impede uma política mal configurada de esvaziar o bucket.
    */
    const velhos = objetosDiarios(20).map((o, i) => ({
      ...o,
      criadoEm: new Date(AGORA.getTime() - (700 + i) * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const plano = planejarExpurgo(velhos, { agora: AGORA, rotacionadoEm: null });
    expect(plano.manter.length).toBeGreaterThanOrEqual(7);
  });

  it('guarda TODOS os dos últimos catorze dias', () => {
    const plano = planejarExpurgo(objetosDiarios(60), { agora: AGORA, rotacionadoEm: null });
    const recentes = plano.manter.filter(
      (o) => new Date(o.criadoEm).getTime() > AGORA.getTime() - 14 * 24 * 60 * 60 * 1000,
    );
    expect(recentes.length).toBe(14);
  });

  it('além dos catorze dias, guarda um por semana', () => {
    const plano = planejarExpurgo(objetosDiarios(120), { agora: AGORA, rotacionadoEm: null });
    // Entre 14 dias e 8 semanas atrás sobra no máximo um por semana.
    const semanas = new Set(
      plano.manter
        .filter((o) => {
          const idade = AGORA.getTime() - new Date(o.criadoEm).getTime();
          return idade > 14 * 24 * 3600_000 && idade <= 8 * 7 * 24 * 3600_000;
        })
        .map((o) => o.balde),
    );
    const naFaixa = plano.manter.filter((o) => {
      const idade = AGORA.getTime() - new Date(o.criadoEm).getTime();
      return idade > 14 * 24 * 3600_000 && idade <= 8 * 7 * 24 * 3600_000;
    });
    expect(naFaixa.length).toBe(semanas.size);
  });

  it('o que sai é dito com o motivo — não é uma lista muda', () => {
    const plano = planejarExpurgo(objetosDiarios(60), { agora: AGORA, rotacionadoEm: null });
    expect(plano.apagar.length).toBeGreaterThan(0);
    for (const o of plano.apagar) expect(o.motivo).toBeTruthy();
  });

  it('o mais recente NUNCA sai, aconteça o que acontecer', () => {
    const plano = planejarExpurgo(objetosDiarios(400), { agora: AGORA, rotacionadoEm: null });
    const maisRecente = objetosDiarios(1)[0].nome;
    expect(plano.apagar.map((o) => o.nome)).not.toContain(maisRecente);
    expect(plano.manter.map((o) => o.nome)).toContain(maisRecente);
  });
});

// ============================================================================

describe('o legado só sai com autorização explícita', () => {
  /** Metade anterior à rotação, metade posterior. */
  function misturados() {
    const antes = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(new Date(ROTACAO).getTime() - (i + 1) * 24 * 3600_000);
      return { nome: `legado-${i}.db`, criadoEm: d.toISOString(), bytes: 5_000_000 };
    });
    const depois = Array.from({ length: 3 }, (_, i) => {
      const d = new Date(new Date(ROTACAO).getTime() + (i + 1) * 3600_000);
      return { nome: `atual-${i}.db`, criadoEm: d.toISOString(), bytes: 5_000_000 };
    });
    return [...depois, ...antes];
  }

  it('por padrão, nenhum legado entra na lista de apagar', () => {
    const plano = planejarExpurgo(misturados(), { agora: AGORA, rotacionadoEm: ROTACAO });
    for (const o of plano.apagar) {
      expect(o.selo, `${o.nome} é legado e entrou no expurgo sem autorização`).toBe(
        'CURRENT_ENCRYPTION_KEY',
      );
    }
  });

  it('e o plano diz quantos ficaram de fora por isso', () => {
    const plano = planejarExpurgo(misturados(), { agora: AGORA, rotacionadoEm: ROTACAO });
    expect(plano.legadosPreservados).toBeGreaterThan(0);
  });

  it('com autorização, o legado entra na mesma régua — e não numa régua pior', () => {
    const plano = planejarExpurgo(misturados(), {
      agora: AGORA,
      rotacionadoEm: ROTACAO,
      permitirExpurgoDeLegados: true,
    });
    expect(plano.apagar.some((o) => o.selo === 'LEGACY_ENCRYPTION_KEY')).toBe(true);
    // O mínimo continua valendo para o conjunto todo.
    expect(plano.manter.length).toBeGreaterThanOrEqual(7);
  });

  it('mesmo com autorização, o mais recente de CADA selo é preservado', () => {
    /*
      Se algo na rotação tiver escapado, o caminho de volta é o backup legado
      mais recente. Ele é o último a sair, nunca o primeiro.
    */
    const plano = planejarExpurgo(misturados(), {
      agora: AGORA,
      rotacionadoEm: ROTACAO,
      permitirExpurgoDeLegados: true,
    });
    const legadoMaisRecente = 'legado-0.db';
    expect(plano.apagar.map((o) => o.nome)).not.toContain(legadoMaisRecente);
  });
});

// ============================================================================

describe('o ensaio não apaga', () => {
  it('o plano é só uma lista — nada nele executa', () => {
    const plano = planejarExpurgo(objetosDiarios(100), { agora: AGORA, rotacionadoEm: null });
    expect(plano).toHaveProperty('manter');
    expect(plano).toHaveProperty('apagar');
    expect(typeof (plano as unknown as Record<string, unknown>).executar).toBe('undefined');
  });

  it('bucket vazio dá plano vazio, sem reclamar', () => {
    const plano = planejarExpurgo([], { agora: AGORA, rotacionadoEm: null });
    expect(plano.apagar).toEqual([]);
    expect(plano.manter).toEqual([]);
  });
});
