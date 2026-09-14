/**
 * Filho antes de pai, para CADA referência — não só para a mais óbvia.
 *
 * `CORE_TABLES_IN_DELETE_ORDER` é a ordem em que `resetDbForTests` esvazia o
 * banco. Uma tabela colocada depois de alguém que aponta para ela derruba
 * FOREIGN KEY, e o estrago tem uma característica cruel: **a falha aparece no
 * arquivo de teste SEGUINTE**, no `beforeEach`, longe de quem a causou.
 *
 * Este projeto já tropeçou nisso três vezes:
 *
 * 1. sete tabelas de tabela de preços ficaram fora da lista;
 * 2. as cinco tabelas de comissão entraram no fim, depois do financeiro e da
 *    venda para quem elas apontam;
 * 3. `core_product_units` entrou perto dos produtos porque eu contei duas das
 *    suas quatro referências — e `core_equipment` passou a ser apagado 71
 *    posições antes dela.
 *
 * As três foram descobertas do jeito caro: rodando a suíte e lendo o estouro.
 * A terceira nem estourou — ficou dormente esperando a primeira gravação em
 * `equipment_id`, que é a rodada do equipamento interno.
 *
 * Este arquivo troca as três descobertas por uma pergunta que o SQLite já sabe
 * responder: `PRAGMA foreign_key_list`.
 */
import { describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema, CORE_TABLES_IN_DELETE_ORDER } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');

ensureCoreSchema();

const posicao = new Map<string, number>(CORE_TABLES_IN_DELETE_ORDER.map((t, i) => [t, i]));

/**
 * A única tabela do núcleo que fica FORA do reset, de propósito.
 *
 * `core_meta` guarda a versão do schema e a marca de cada passo de migração.
 * Esvaziá-la faria toda migração rodar de novo a cada teste — inclusive as
 * reconstruções de tabela, que são caras e não são idempotentes de graça.
 *
 * A lista é explícita para que a próxima ausência seja uma decisão, e não um
 * esquecimento que passa despercebido.
 */
const FORA_DO_RESET_DE_PROPOSITO = new Set(['core_meta']);

/** As tabelas do núcleo que existem de fato no banco. */
function tabelasDoNucleo(): string[] {
  return (
    getConnection()
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'core_%'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as { name: string }[]
  ).map((r) => r.name);
}

interface Violacao {
  tabela: string;
  aponta: string;
  posicaoDaTabela: number;
  posicaoDoAlvo: number;
}

describe('a ordem de exclusão respeita todas as chaves estrangeiras', () => {
  it('nenhuma tabela é apagada depois de alguém para quem ela aponta', () => {
    const db = getConnection();
    const violacoes: Violacao[] = [];

    for (const [tabela, indice] of posicao) {
      const fks = db.prepare(`PRAGMA foreign_key_list("${tabela}")`).all() as unknown as {
        table: string;
      }[];

      // Um mesmo par pode aparecer várias vezes (chave composta): o conjunto
      // evita relatar a mesma violação três linhas seguidas.
      for (const alvo of new Set(fks.map((f) => f.table))) {
        // Auto-referência é sempre válida: a árvore de categorias aponta para
        // si mesma, e o DELETE resolve isso numa passada só.
        if (alvo === tabela) continue;

        const indiceDoAlvo = posicao.get(alvo);
        // Alvo fora da lista é o outro defeito, coberto pelo caso abaixo.
        if (indiceDoAlvo === undefined) continue;

        if (indiceDoAlvo < indice) {
          violacoes.push({
            tabela,
            aponta: alvo,
            posicaoDaTabela: indice,
            posicaoDoAlvo: indiceDoAlvo,
          });
        }
      }
    }

    // A mensagem tem de dizer o CONSERTO, não só o erro: quem ler isto no
    // vermelho precisa saber para onde mover a linha. E vai como texto único
    // porque o vitest abrevia array de objetos para `[ Array(1) ]` — uma
    // mensagem que não se lê é quase tão ruim quanto teste que não falha.
    const legivel = violacoes
      .map(
        (v) =>
          `${v.tabela} (pos ${v.posicaoDaTabela}) aponta para ${v.aponta} ` +
          `(pos ${v.posicaoDoAlvo}) — mova "${v.tabela}" para ANTES de "${v.aponta}"`,
      )
      .join('\n');
    expect(legivel).toBe('');
  });

  it('toda tabela do núcleo está na lista', () => {
    // O caso das sete tabelas de tabela de preços: a tabela existe, o reset
    // nunca a esvazia, e o teste seguinte herda a sujeira do anterior.
    const faltando = tabelasDoNucleo().filter(
      (t) => !posicao.has(t) && !FORA_DO_RESET_DE_PROPOSITO.has(t),
    );
    expect(faltando).toEqual([]);
  });

  it('a lista não cita tabela que não existe', () => {
    // Nome errado na lista é um DELETE que nunca roda — some sem avisar.
    const existentes = new Set(tabelasDoNucleo());
    const fantasmas = [...posicao.keys()].filter((t) => !existentes.has(t));
    expect(fantasmas).toEqual([]);
  });

  it('a lista não repete nenhuma tabela', () => {
    const vistas = new Set<string>();
    const repetidas: string[] = [];
    for (const t of CORE_TABLES_IN_DELETE_ORDER) {
      if (vistas.has(t)) repetidas.push(t);
      vistas.add(t);
    }
    expect(repetidas).toEqual([]);
  });
});
