/**
 * ============================================================================
 * O FATO CHEGOU E NUNCA VIROU LINHA DE NEGÓCIO
 * ============================================================================
 *
 * A projeção só acontecia dentro de `syncOnce`, sobre o lote que ACABOU de ser
 * entregue. O comentário do serviço prometia que um fato não projetado "pode
 * ser reprojetado" — e não podia: `projetarLote` tinha um único chamador, e ele
 * só enxerga o que está saindo agora. Evento já marcado `synced` na fila local
 * nunca mais era alcançado.
 *
 * Isso deixou de ser hipótese em 29/08/2026. Os 118 eventos da instalação foram
 * entregues às 20:53, entre a migration 001 (20:50) e a 002 (20:56): a
 * aterrissagem já existia e as tabelas de negócio ainda não. Os fatos estão
 * salvos, `projected_at` nulo nos 118, e nenhum caminho os alcançava.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 * A reprojeção parte da ATERRISSAGEM, não da fila local — é essa inversão que
 * torna o mecanismo utilizável depois do fato. E ela reusa `project()`, o mesmo
 * e único mapeamento evento → linha: uma segunda tradução escrita aqui
 * divergiria da primeira no dia em que um campo novo aparecesse.
 *
 * Nenhum teste toca rede. O leitor da aterrissagem e o transporte de projeção
 * são de mentira, e é o `Projector.ts` de verdade que roda no meio.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { describe, expect, it } from 'vitest';

const { reprojetarPendentes, paraOutboxRow, planejarProjecao } = await import(
  '../src/services/sync/Reprojection.js',
);
const { project } = await import('../src/services/sync/Projector.js');

const PRECO_JUSTO = 'empresa-preco-justo';
const GRINGA = 'empresa-gringa';

interface EventoFalso {
  id: string;
  node_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  company_id: string;
  operational_unit_id: string | null;
  operation: string;
  schema_version: number;
  payload: Record<string, unknown>;
  occurred_at: string;
  node_seq: number | null;
  projected_at: string | null;
}

function evento(over: Partial<EventoFalso> = {}): EventoFalso {
  const n = over.node_seq ?? 1;
  return {
    id: over.id ?? `ev-${n}`,
    node_id: 'no-de-teste',
    event_type: 'product.upserted',
    aggregate_type: 'product',
    aggregate_id: over.aggregate_id ?? `prod-${n}`,
    company_id: PRECO_JUSTO,
    operational_unit_id: null,
    operation: 'insert',
    schema_version: 1,
    payload: { name: 'Camisa', unit: 'UN', price_cents: 2500, active: 1 },
    occurred_at: '2026-08-15T12:00:00.000Z',
    node_seq: n,
    projected_at: null,
    ...over,
  };
}

/**
 * A aterrissagem de mentira.
 *
 * Guarda os eventos e o carimbo. `marcarProjetados` é o único jeito de um
 * evento sair da lista dos pendentes — igual à central de verdade.
 */
function aterrissagemFalsa(eventos: EventoFalso[]) {
  const linhas = [...eventos];
  const chamadas = { leituras: 0, marcacoes: 0, marcados: [] as string[] };
  return {
    linhas,
    chamadas,
    reader: {
      name: 'aterrissagem-de-teste',
      async lerNaoProjetados(limite: number) {
        chamadas.leituras += 1;
        return linhas
          .filter((e) => e.projected_at === null)
          .sort((a, b) => (a.node_seq ?? 0) - (b.node_seq ?? 0))
          .slice(0, limite)
          .map((e) => ({ ...e }));
      },
      async contarNaoProjetados() {
        return linhas.filter((e) => e.projected_at === null).length;
      },
      async marcarProjetados(ids: string[]) {
        chamadas.marcacoes += 1;
        chamadas.marcados.push(...ids);
        let n = 0;
        for (const l of linhas) {
          if (ids.includes(l.id) && l.projected_at === null) {
            l.projected_at = '2026-08-29T21:00:00.000Z';
            n += 1;
          }
        }
        return n;
      },
    },
  };
}

/** Uma central de mentira que guarda o que recebeu, com a guarda de ordem. */
function centralFalsa(opts: { falharSempre?: boolean; falharSe?: (t: string) => boolean } = {}) {
  const tabelas = new Map<string, Map<string, Record<string, unknown>>>();
  const chamadas: Array<{ linhas: number }> = [];
  return {
    tabelas,
    chamadas,
    transporte: {
      name: 'central-de-teste',
      isTest: true,
      async apply(projections: Array<{ table: string; key: Record<string, unknown>; row: Record<string, unknown>; guardByOrder: boolean }>) {
        chamadas.push({ linhas: projections.length });
        if (opts.falharSempre) throw new Error('A central recusou a projeção (HTTP 404).');
        if (opts.falharSe && projections.some((p) => opts.falharSe?.(p.table))) {
          throw new Error('A central recusou a projeção desta tabela.');
        }
        let written = 0;
        let skippedByOrder = 0;
        for (const p of projections) {
          if (!tabelas.has(p.table)) tabelas.set(p.table, new Map());
          const t = tabelas.get(p.table) as Map<string, Record<string, unknown>>;
          const chave = JSON.stringify(p.key);
          const atual = t.get(chave);
          if (p.guardByOrder && atual) {
            const antigo = Number(atual.node_seq ?? 0);
            const novo = Number(p.row.node_seq ?? 0);
            if (novo < antigo) {
              skippedByOrder += 1;
              continue;
            }
          }
          t.set(chave, { ...p.row });
          written += 1;
        }
        return { written, skippedByOrder };
      },
    },
  };
}

function linhasDe(central: ReturnType<typeof centralFalsa>, tabela: string) {
  return [...(central.tabelas.get(tabela)?.values() ?? [])];
}

// ============================================================================

describe('a reprojeção parte da aterrissagem, não da fila', () => {
  it('reprojeta evento que a fila local já deu por ENVIADO', async () => {
    /*
      O caso que dá nome ao arquivo. Na fila local esses eventos estão `synced`
      e `sent_at` preenchido — para ela, o trabalho acabou. A reprojeção não
      pergunta nada à fila: ela lê a aterrissagem.
    */
    const a = aterrissagemFalsa([evento({ node_seq: 1 }), evento({ node_seq: 2 })]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.eventosProjetados).toBe(2);
    expect(linhasDe(c, 'erp_products')).toHaveLength(2);
  });

  it('não lê nada da fila local — o módulo nem a consulta', async () => {
    // Se a reprojeção dependesse do estado local, ela seria inútil justamente
    // quando é necessária.
    const fonte = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/services/sync/Reprojection.ts', import.meta.url), 'utf8'),
    );
    /*
      O TIPO pode vir de lá; o CÓDIGO não.

      `OutboxRow` é a forma que `project()` recebe, e reusá-la é o que
      mantém um mapeamento só. O que não pode existir é import de execução:
      seria a porta por onde a reprojeção voltaria a depender do estado da
      fila — justamente o que ela existe para contornar.
    */
    const importsDaFila = [...fonte.matchAll(/^import\s+(type\s+)?[^;]*from '\.\/OutboxService\.js';/gm)];
    expect(importsDaFila.length, "o tipo da linha vem de lá, e deve continuar vindo").toBe(1);
    expect(importsDaFila[0][1], "import de EXECUÇÃO da fila local").toBe('type ');

    expect(fonte).not.toContain('core_outbox');
    expect(fonte).not.toContain('marcarEnviados');
    expect(fonte).not.toContain('pendentes(');
    expect(fonte).not.toContain('outboxStatus');
  });

  it('usa o MESMO mapeamento de Projector.ts — não um segundo', async () => {
    /*
      A linha gravada pela reprojeção tem de ser idêntica à que `project()`
      produziria. Dois mapeamentos divergem no primeiro campo novo, e a
      divergência aparece como diferença de relatório meses depois.
    */
    const e = evento({ node_seq: 7, aggregate_id: 'prod-7' });
    const a = aterrissagemFalsa([e]);
    const c = centralFalsa();

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    const esperado = project(paraOutboxRow({ ...e }))[0];
    expect(linhasDe(c, 'erp_products')[0]).toEqual(esperado.row);
  });
});

// ============================================================================

describe('rodar duas vezes não duplica', () => {
  it('a segunda passada não encontra nada e não grava', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 }), evento({ node_seq: 2 })]);
    const c = centralFalsa();

    const primeira = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });
    const segunda = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(primeira.eventosProjetados).toBe(2);
    expect(segunda.eventosProjetados).toBe(0);
    expect(segunda.linhasGravadas).toBe(0);
    expect(linhasDe(c, 'erp_products')).toHaveLength(2);
  });

  it('e mesmo forçando a releitura, a chave manda: uma linha por produto', async () => {
    // Idempotência de verdade não depende de o `projected_at` filtrar: a chave
    // da linha no destino é a mesma, e o upsert converge.
    const a = aterrissagemFalsa([evento({ node_seq: 1, aggregate_id: 'prod-x' })]);
    const c = centralFalsa();

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });
    a.linhas.forEach((l) => { l.projected_at = null; });
    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(linhasDe(c, 'erp_products')).toHaveLength(1);
  });
});

// ============================================================================

describe('a guarda de ordem sobrevive à reprojeção', () => {
  it('evento ANTIGO chegando depois do novo não desfaz o novo', async () => {
    /*
      A rede não entrega em ordem, e a reprojeção pode varrer numa ordem
      qualquer. Um "produto renomeado" antigo sobrescrevendo o nome novo é o
      cliente vendo o cadastro voltar no tempo.
    */
    const c = centralFalsa();
    const novo = evento({
      id: 'ev-novo', node_seq: 50, aggregate_id: 'prod-1',
      payload: { name: 'Nome NOVO', unit: 'UN', active: 1 },
    });
    const antigo = evento({
      id: 'ev-antigo', node_seq: 10, aggregate_id: 'prod-1',
      payload: { name: 'nome antigo', unit: 'UN', active: 1 },
    });

    // O novo entra primeiro; o antigo é reprojetado depois.
    const a1 = aterrissagemFalsa([novo]);
    await reprojetarPendentes({ leitor: a1.reader, transporte: c.transporte });
    const a2 = aterrissagemFalsa([antigo]);
    await reprojetarPendentes({ leitor: a2.reader, transporte: c.transporte });

    expect(linhasDe(c, 'erp_products')[0].name).toBe('Nome NOVO');
  });

  it('e o node_seq é preservado na linha projetada', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 42 })]);
    const c = centralFalsa();
    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });
    expect(linhasDe(c, 'erp_products')[0].node_seq).toBe(42);
  });
});

// ============================================================================

describe('empresa nenhuma invade a outra', () => {
  it('lote com duas empresas mantém cada linha na sua', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'ev-pj', node_seq: 1, aggregate_id: 'prod-pj', company_id: PRECO_JUSTO }),
      evento({ id: 'ev-gr', node_seq: 2, aggregate_id: 'prod-gr', company_id: GRINGA }),
    ]);
    const c = centralFalsa();

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    const linhas = linhasDe(c, 'erp_products');
    expect(linhas).toHaveLength(2);
    expect(linhas.find((l) => l.id === 'prod-pj')?.company_id).toBe(PRECO_JUSTO);
    expect(linhas.find((l) => l.id === 'prod-gr')?.company_id).toBe(GRINGA);
  });

  it('e o relatório conta por empresa, sem misturar', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: PRECO_JUSTO }),
      evento({ id: 'c', node_seq: 3, aggregate_id: 'p3', company_id: GRINGA }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.porEmpresa[PRECO_JUSTO]).toBe(2);
    expect(r.porEmpresa[GRINGA]).toBe(1);
  });

  it('a linha projetada NUNCA leva a empresa de outro evento do lote', async () => {
    // O caso do tenant trocado. Cada linha carrega a empresa do SEU evento.
    const a = aterrissagemFalsa([
      evento({ id: 'ev-pj', node_seq: 1, aggregate_id: 'prod-pj', company_id: PRECO_JUSTO }),
      evento({ id: 'ev-gr', node_seq: 2, aggregate_id: 'prod-gr', company_id: GRINGA }),
    ]);
    const c = centralFalsa();

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    for (const l of linhasDe(c, 'erp_products')) {
      const esperada = l.id === 'prod-pj' ? PRECO_JUSTO : GRINGA;
      expect(l.company_id, `${l.id} ficou com a empresa errada`).toBe(esperada);
    }
  });
});

// ============================================================================

describe('projected_at só depois do sucesso', () => {
  it('com a central fora do ar, NADA é carimbado', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 }), evento({ node_seq: 2 })]);
    const c = centralFalsa({ falharSempre: true });

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.eventosProjetados).toBe(0);
    expect(r.falhas.length).toBeGreaterThan(0);
    expect(a.chamadas.marcados, 'nenhum id pode ter sido carimbado').toEqual([]);
    for (const l of a.linhas) expect(l.projected_at).toBeNull();
  });

  it('o carimbo vem DEPOIS da confirmação, nunca antes', async () => {
    /*
      A ordem importa: carimbar antes e falhar deixaria o fato marcado como
      projetado sem nunca ter virado linha — invisível para sempre, porque a
      próxima varredura não o veria.
    */
    const ordem: string[] = [];
    const a = aterrissagemFalsa([evento({ node_seq: 1 })]);
    const marcarOriginal = a.reader.marcarProjetados;
    a.reader.marcarProjetados = async (ids: string[]) => {
      ordem.push('marcar');
      return marcarOriginal(ids);
    };
    const c = centralFalsa();
    const applyOriginal = c.transporte.apply;
    c.transporte.apply = async (p) => {
      ordem.push('projetar');
      return applyOriginal(p);
    };

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(ordem).toEqual(['projetar', 'marcar']);
  });

  /*
    O PADRÃO MUDOU, E ESTE CASO É O TRIPWIRE QUE PEGOU.

    Ele cobrava que um tipo desconhecido fosse PULADO: o lote seguia, os
    conhecidos eram projetados, e o estranho ficava para trás sem carimbo.

    Isso continua certo dentro de `syncOnce`, no dia a dia — a central pode ser
    mais antiga que o nó, e derrubar a fila por um tipo novo seria pior que
    deixá-lo esperando.

    Para uma REPROJEÇÃO administrativa de fatos reais, não. Quem roda o
    comando precisa saber, antes de qualquer escrita, que existe fato que
    ninguém sabe traduzir. Então o padrão passou a ser PARAR, e seguir virou
    decisão explícita.

    O que este caso trava agora é o que nunca mudou: sob QUALQUER modo, o
    evento desconhecido não recebe carimbo. Carimbar o que não virou linha o
    apagaria do radar — a varredura seguinte não o veria.
  */
  it('evento de tipo desconhecido NUNCA é carimbado, em modo nenhum', async () => {
    const semear = () => aterrissagemFalsa([
      evento({ id: 'conhecido', node_seq: 1 }),
      evento({ id: 'estranho', node_seq: 2, event_type: 'coisa.que.ninguem.conhece' }),
    ]);

    // Padrão: para tudo, e nem o conhecido é carimbado.
    const a1 = semear();
    const r1 = await reprojetarPendentes({ leitor: a1.reader, transporte: centralFalsa().transporte });
    expect(r1.abortado).toBe(true);
    for (const l of a1.linhas) expect(l.projected_at).toBeNull();

    // Decisão explícita: segue, e SÓ o desconhecido fica sem carimbo.
    const a2 = semear();
    const r2 = await reprojetarPendentes({
      leitor: a2.reader,
      transporte: centralFalsa().transporte,
      seguirComDesconhecidos: true,
    });
    expect(r2.eventosProjetados).toBe(1);
    expect(r2.desconhecidos).toBe(1);
    expect(a2.linhas.find((l) => l.id === 'estranho')?.projected_at).toBeNull();
    expect(a2.linhas.find((l) => l.id === 'conhecido')?.projected_at).not.toBeNull();
  });
});

// ============================================================================

describe('falha parcial não trava o resto', () => {
  it('um evento problemático não impede os outros de serem projetados', async () => {
    /*
      O lote inteiro vai numa chamada só, por economia de rede. Quando ela
      falha, a reprojeção reduz para um evento por vez e isola o culpado — em
      vez de devolver "o lote falhou" e deixar 117 fatos parados por causa de um.
    */
    const a = aterrissagemFalsa([
      evento({ id: 'bom-1', node_seq: 1, aggregate_id: 'p1' }),
      evento({
        id: 'ruim', node_seq: 2, aggregate_id: 'c1',
        event_type: 'customer.upserted', aggregate_type: 'customer',
        payload: { name: 'Fulano' },
      }),
      evento({ id: 'bom-2', node_seq: 3, aggregate_id: 'p2' }),
    ]);
    // A central recusa só a tabela de clientes.
    const c = centralFalsa({ falharSe: (t) => t === 'erp_customers' });

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.eventosProjetados, 'os dois produtos precisam passar').toBe(2);
    expect(r.falhas).toHaveLength(1);
    expect(r.falhas[0].id).toBe('ruim');
    expect(a.linhas.find((l) => l.id === 'ruim')?.projected_at).toBeNull();
    expect(a.linhas.find((l) => l.id === 'bom-1')?.projected_at).not.toBeNull();
  });

  it('o erro é registrado com o id e o motivo', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 })]);
    const c = centralFalsa({ falharSempre: true });

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.falhas[0].id).toBeTruthy();
    expect(r.falhas[0].motivo).toContain('central');
  });

  it('não fica em laço infinito relendo o que falhou', async () => {
    // Sem isso, um evento que sempre falha faria a varredura girar para sempre:
    // ele volta em toda leitura, porque `projected_at` continua nulo.
    const a = aterrissagemFalsa([evento({ node_seq: 1 }), evento({ node_seq: 2 })]);
    const c = centralFalsa({ falharSempre: true });

    const r = await reprojetarPendentes({
      leitor: a.reader,
      transporte: c.transporte,
      tamanhoDoLote: 1,
    });

    expect(r.falhas).toHaveLength(2);
    expect(a.chamadas.leituras).toBeLessThan(10);
  });
});

// ============================================================================

describe('lotes controlados', () => {
  it('respeita o tamanho pedido', async () => {
    const eventos = Array.from({ length: 7 }, (_, i) =>
      evento({ id: `ev-${i}`, node_seq: i + 1, aggregate_id: `p-${i}` }));
    const a = aterrissagemFalsa(eventos);
    const c = centralFalsa();

    const r = await reprojetarPendentes({
      leitor: a.reader,
      transporte: c.transporte,
      tamanhoDoLote: 3,
    });

    expect(r.eventosProjetados).toBe(7);
    // 3 + 3 + 1 = três chamadas de projeção, uma por lote.
    expect(c.chamadas).toHaveLength(3);
    expect(c.chamadas.map((x) => x.linhas)).toEqual([3, 3, 1]);
  });

  it('aterrissagem vazia devolve zero sem reclamar', async () => {
    const a = aterrissagemFalsa([]);
    const c = centralFalsa();
    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });
    expect(r.eventosProjetados).toBe(0);
    expect(r.falhas).toEqual([]);
    expect(c.chamadas).toHaveLength(0);
  });

  it('o ensaio não projeta nem carimba', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 })]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte, ensaio: true });

    expect(r.ensaio).toBe(true);
    expect(r.pendentesEncontrados).toBe(1);
    expect(c.chamadas, 'ensaio não pode chamar a central').toHaveLength(0);
    expect(a.chamadas.marcados).toEqual([]);
  });
});

// ============================================================================

describe('a aterrissagem não recebe evento de volta', () => {
  it('o leitor só é usado para LER e CARIMBAR — nunca para inserir', async () => {
    /*
      Reprojetar não é reenviar. Se este mecanismo escrevesse em
      `erp_sync_events`, um fato entregue uma vez poderia virar dois.
    */
    const a = aterrissagemFalsa([evento({ node_seq: 1 })]);
    const c = centralFalsa();
    const antes = a.linhas.length;

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(a.linhas).toHaveLength(antes);
    expect(Object.keys(a.reader).sort()).toEqual(
      ['contarNaoProjetados', 'lerNaoProjetados', 'marcarProjetados', 'name'].sort(),
    );
  });

  it('e o módulo não conhece verbo de inserção na aterrissagem', async () => {
    const fonte = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/services/sync/Reprojection.ts', import.meta.url), 'utf8'),
    );
    expect(fonte).not.toContain('erp_sync_events?on_conflict');
    expect(fonte).not.toMatch(/method:\s*'POST'[\s\S]{0,200}erp_sync_events/);
  });
});

// ============================================================================

/*
  ============================================================================
  O QUE CADA EVENTO VIRARIA, ANTES DE VIRAR
  ============================================================================

  A reprojeção contava quantos eventos passariam e parava aí. Isso responde
  "quantos", e a pergunta antes de mexer em 118 fatos das seis empresas é
  "o quê": que tipo de evento vira que tabela, e quantos de cada.

  O plano usa `project()` — a mesma e única tradução. Ele não estima nem
  adivinha: roda o projetor de verdade sobre os eventos de verdade, em memória,
  e conta o que sairia.
*/
describe('o plano diz o que cada evento viraria', () => {
  it('mapeia tipo de evento para tabela de destino', () => {
    const p = planejarProjecao([
      evento({ id: 'a', node_seq: 1, event_type: 'product.upserted', aggregate_type: 'product' }),
      evento({ id: 'b', node_seq: 2, event_type: 'product.upserted', aggregate_type: 'product' }),
      evento({
        id: 'c', node_seq: 3, event_type: 'customer.upserted', aggregate_type: 'customer',
        aggregate_id: 'cli-1', payload: { name: 'Fulano' },
      }),
    ]);

    expect(p.eventos).toBe(3);
    expect(p.porTipo['product.upserted'].eventos).toBe(2);
    expect(p.porTipo['product.upserted'].tabelas).toEqual(['erp_products']);
    expect(p.porTipo['customer.upserted'].tabelas).toEqual(['erp_customers']);
  });

  it('conta as LINHAS previstas, não só os eventos', () => {
    /*
      Um evento pode virar mais de uma linha — uma venda produz o cabeçalho e
      os itens. Contar evento e chamar de linha subestimaria o que vai ser
      escrito.
    */
    const p = planejarProjecao([
      evento({
        id: 'venda', node_seq: 1, event_type: 'sale.registered', aggregate_type: 'sale',
        aggregate_id: 'v-1',
        payload: {
          id: 'v-1', status: 'concluida', total_cents: 5000,
          items: [
            { line_number: 1, product_id: 'p1', quantity: 1, total_cents: 2500 },
            { line_number: 2, product_id: 'p2', quantity: 1, total_cents: 2500 },
          ],
        },
      }),
    ]);

    expect(p.eventos).toBe(1);
    expect(p.linhasPrevistas).toBeGreaterThan(1);
    expect(p.porTipo['sale.registered'].tabelas).toContain('erp_sales');
  });

  it('agrupa por empresa sem misturar', () => {
    const p = planejarProjecao([
      evento({ id: 'a', node_seq: 1, company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, company_id: PRECO_JUSTO }),
      evento({ id: 'c', node_seq: 3, company_id: GRINGA }),
    ]);
    expect(p.porEmpresa[PRECO_JUSTO]).toBe(2);
    expect(p.porEmpresa[GRINGA]).toBe(1);
  });

  it('identifica evento SEM projetor, com id e tipo', () => {
    // "Quantos desconhecidos" não serve para agir. O id serve.
    const p = planejarProjecao([
      evento({ id: 'bom', node_seq: 1 }),
      evento({ id: 'estranho', node_seq: 2, event_type: 'coisa.que.ninguem.conhece' }),
    ]);

    expect(p.desconhecidos).toHaveLength(1);
    expect(p.desconhecidos[0].id).toBe('estranho');
    expect(p.desconhecidos[0].eventType).toBe('coisa.que.ninguem.conhece');
    expect(p.desconhecidos[0].companyId).toBe(PRECO_JUSTO);
  });

  it('lista vazia dá plano vazio', () => {
    const p = planejarProjecao([]);
    expect(p.eventos).toBe(0);
    expect(p.linhasPrevistas).toBe(0);
    expect(p.desconhecidos).toEqual([]);
  });

  it('o plano NÃO escreve nada — é cálculo em memória', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 })]);
    const antes = JSON.stringify(a.linhas);
    planejarProjecao(await a.reader.lerNaoProjetados(100));
    expect(JSON.stringify(a.linhas)).toBe(antes);
    expect(a.chamadas.marcados).toEqual([]);
  });
});

// ============================================================================

/*
  ============================================================================
  EVENTO DESCONHECIDO PARA A EXECUÇÃO, EM VEZ DE SER PULADO
  ============================================================================

  Antes, um tipo sem projetor era contado e ignorado: o lote seguia, os outros
  eram projetados, e aquele fato ficava para trás sem que ninguém precisasse
  decidir nada.

  Para o dia a dia isso é o certo — a central pode ser mais antiga que o nó, e
  derrubar a fila inteira por um tipo novo seria pior. Para uma REPROJEÇÃO
  administrativa de 118 fatos reais não é: quem roda o comando precisa saber,
  antes de escrever qualquer coisa, que existe fato que ninguém sabe traduzir.

  Por isso o padrão inverteu, e a decisão ficou explícita.
*/
describe('tipo sem projetor faz a reprojeção PARAR', () => {
  it('por padrão, aborta antes de projetar qualquer coisa', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'bom-1', node_seq: 1, aggregate_id: 'p1' }),
      evento({ id: 'estranho', node_seq: 2, event_type: 'tipo.desconhecido' }),
      evento({ id: 'bom-2', node_seq: 3, aggregate_id: 'p2' }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.abortado).toBe(true);
    expect(r.eventosProjetados, 'nem os conhecidos podem ter passado').toBe(0);
    expect(c.chamadas, 'a central não pode ter sido chamada').toHaveLength(0);
    expect(a.chamadas.marcados).toEqual([]);
  });

  it('e diz QUAIS eventos, não só quantos', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'bom', node_seq: 1 }),
      evento({ id: 'x1', node_seq: 2, event_type: 'tipo.a' }),
      evento({ id: 'x2', node_seq: 3, event_type: 'tipo.b' }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.desconhecidosDetalhados.map((d) => d.id).sort()).toEqual(['x1', 'x2']);
    expect(r.desconhecidosDetalhados.map((d) => d.eventType).sort()).toEqual(['tipo.a', 'tipo.b']);
  });

  it('com a decisão explícita, ele segue e deixa o desconhecido para trás', async () => {
    /*
      A saída existe, mas é preciso pedir. É a diferença entre uma máquina que
      decide sozinha e uma que apresenta a decisão.
    */
    const a = aterrissagemFalsa([
      evento({ id: 'bom', node_seq: 1, aggregate_id: 'p1' }),
      evento({ id: 'estranho', node_seq: 2, event_type: 'tipo.desconhecido' }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({
      leitor: a.reader,
      transporte: c.transporte,
      seguirComDesconhecidos: true,
    });

    expect(r.abortado).toBe(false);
    expect(r.eventosProjetados).toBe(1);
    expect(a.linhas.find((l) => l.id === 'estranho')?.projected_at).toBeNull();
    expect(a.linhas.find((l) => l.id === 'bom')?.projected_at).not.toBeNull();
  });

  it('sem desconhecido nenhum, não aborta', async () => {
    const a = aterrissagemFalsa([evento({ node_seq: 1 }), evento({ node_seq: 2 })]);
    const c = centralFalsa();
    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });
    expect(r.abortado).toBe(false);
    expect(r.eventosProjetados).toBe(2);
  });

  it('o ensaio também denuncia o desconhecido — e não aborta, porque não escreve', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'bom', node_seq: 1 }),
      evento({ id: 'estranho', node_seq: 2, event_type: 'tipo.desconhecido' }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte, ensaio: true });

    expect(r.ensaio).toBe(true);
    expect(r.desconhecidosDetalhados).toHaveLength(1);
    expect(c.chamadas).toHaveLength(0);
  });
});

// ============================================================================

describe('a reconciliação diz o que apareceu, não só o que mudou', () => {
  it('relata, por tipo, quantas linhas foram para cada tabela', async () => {
    /*
      `projected_at` mudou não é prova de que a linha existe. A conferência
      precisa dizer QUE tabela recebeu QUANTAS linhas — senão "sucesso" quer
      dizer apenas "o carimbo foi gravado".
    */
    const a = aterrissagemFalsa([
      evento({ id: 'p1', node_seq: 1, aggregate_id: 'prod-1' }),
      evento({ id: 'p2', node_seq: 2, aggregate_id: 'prod-2' }),
      evento({
        id: 'c1', node_seq: 3, event_type: 'customer.upserted', aggregate_type: 'customer',
        aggregate_id: 'cli-1', payload: { name: 'Fulano' },
      }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.porTabela.erp_products).toBe(2);
    expect(r.porTabela.erp_customers).toBe(1);
  });

  it('e o total por tabela bate com o que a central guardou', async () => {
    const a = aterrissagemFalsa([
      evento({ id: 'p1', node_seq: 1, aggregate_id: 'prod-1' }),
      evento({ id: 'p2', node_seq: 2, aggregate_id: 'prod-2' }),
    ]);
    const c = centralFalsa();

    const r = await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(r.porTabela.erp_products).toBe(linhasDe(c, 'erp_products').length);
  });
});

// ============================================================================

/*
  ============================================================================
  A VALIDAÇÃO DE TENANT PRECISA OLHAR O DESTINO, NÃO A ORIGEM
  ============================================================================

  Conferir que a aterrissagem continua com 90 eventos da Preço Justo prova que
  a aterrissagem não mudou. Não prova nada sobre onde as LINHAS foram parar.

  Um defeito de projeção que trocasse a empresa passaria por todas as outras
  conferências: a contagem total bate, os ids são os mesmos, `projected_at`
  virou não-nulo. E o gestor da Gringa veria a venda do Preço Justo.

  Por isso o plano diz, por TABELA e por EMPRESA, quantas linhas sairiam — e a
  conferência compara o crescimento real de cada par contra essa previsão.

  `erp_companies` e `erp_sale_items` não têm coluna de empresa: a primeira É a
  empresa, e a segunda pendura na venda. Elas ficam de fora, e o plano diz isso
  em vez de fingir que contou.
*/
describe('cada linha vai para a empresa do seu evento', () => {
  it('o plano conta linhas por tabela E por empresa', () => {
    const p = planejarProjecao([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: PRECO_JUSTO }),
      evento({ id: 'c', node_seq: 3, aggregate_id: 'p3', company_id: GRINGA }),
    ]);

    expect(p.porTabelaEmpresa.erp_products[PRECO_JUSTO]).toBe(2);
    expect(p.porTabelaEmpresa.erp_products[GRINGA]).toBe(1);
  });

  it('tabela sem coluna de empresa é declarada, não contada às escondidas', () => {
    /*
      `erp_sale_items` pendura na venda e não carrega empresa. Contá-la por
      empresa exigiria inventar de onde tirar o valor — e uma conferência que
      inventa é pior que uma que se declara incapaz.
    */
    const p = planejarProjecao([
      evento({
        id: 'venda', node_seq: 1, event_type: 'sale.registered', aggregate_type: 'sale',
        aggregate_id: 'v-1', company_id: PRECO_JUSTO,
        payload: {
          id: 'v-1', status: 'concluida', total_cents: 5000,
          items: [{ line_number: 1, product_id: 'p1', quantity: 1, total_cents: 5000 }],
        },
      }),
    ]);

    expect(p.porTabelaEmpresa.erp_sales[PRECO_JUSTO]).toBe(1);
    expect(p.tabelasSemEmpresa).toContain('erp_sale_items');
    expect(p.porTabelaEmpresa.erp_sale_items).toBeUndefined();
  });

  it('duas empresas no mesmo lote não se contaminam', () => {
    const p = planejarProjecao([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({
        id: 'b', node_seq: 2, aggregate_id: 'c1', company_id: GRINGA,
        event_type: 'customer.upserted', aggregate_type: 'customer',
        payload: { name: 'Fulano' },
      }),
    ]);

    expect(Object.keys(p.porTabelaEmpresa.erp_products)).toEqual([PRECO_JUSTO]);
    expect(Object.keys(p.porTabelaEmpresa.erp_customers)).toEqual([GRINGA]);
  });

  it('e o que foi GRAVADO carrega a empresa prevista', async () => {
    // A previsão só vale se o que a central recebeu bater com ela.
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: GRINGA }),
    ]);
    const c = centralFalsa();

    const plano = planejarProjecao(await a.reader.lerNaoProjetados(100));
    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    const gravadas = linhasDe(c, 'erp_products');
    const porEmpresa: Record<string, number> = {};
    for (const l of gravadas) {
      const e = String(l.company_id);
      porEmpresa[e] = (porEmpresa[e] ?? 0) + 1;
    }
    expect(porEmpresa).toEqual(plano.porTabelaEmpresa.erp_products);
  });

  it('nenhuma empresa aparece no destino sem estar na origem', async () => {
    /*
      O caso que dá nome ao bloco. Se uma linha aparecesse com empresa que não
      mandou evento nenhum, seria projeção cruzando tenant — e as outras
      conferências não veriam.
    */
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: GRINGA }),
    ]);
    const c = centralFalsa();
    const naOrigem = new Set([PRECO_JUSTO, GRINGA]);

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    for (const [tabela, mapa] of c.tabelas) {
      for (const linha of mapa.values()) {
        const e = linha.company_id;
        if (e === undefined) continue;
        expect(naOrigem.has(String(e)), tabela + ' recebeu linha de empresa estranha').toBe(true);
      }
    }
  });
});

// ============================================================================

/*
  ============================================================================
  FALSIFICAÇÃO: UMA TROCA DE EMPRESA TEM DE SER PEGA
  ============================================================================

  O gate do comando compara, por tabela e por empresa, o CRESCIMENTO real no
  destino contra o que o plano previu. Este bloco prova que a comparação morde:
  uma central que trocasse a empresa das linhas ao gravar produziria contagens
  que NÃO batem com o plano — e é essa divergência que o gate transforma em
  FALHA.

  Sem estes casos, a conferência de tenant seria uma soma que nunca viu o caso
  ruim. Com o cofre foi igual: nenhuma chave real quebrava o vaivém, e só um
  cofre trocado provou o guarda.
*/
describe('a troca de empresa é detectada pela comparação do gate', () => {
  /** Uma central que TROCA a empresa das linhas ao gravar. */
  function centralQueTroca(de: string, para: string) {
    const c = centralFalsa();
    const original = c.transporte.apply.bind(c.transporte);
    c.transporte.apply = async (projections) =>
      original(projections.map((p) => ({
        ...p,
        row: {
          ...p.row,
          company_id: p.row.company_id === de ? para : p.row.company_id,
        },
      })));
    return c;
  }

  /** A mesma conta que o gate faz: linhas gravadas, por empresa. */
  function gravadasPorEmpresa(c: ReturnType<typeof centralFalsa>, tabela: string) {
    const contagem: Record<string, number> = {};
    for (const l of linhasDe(c, tabela)) {
      const e = l.company_id;
      if (typeof e !== 'string' || !e) continue;
      contagem[e] = (contagem[e] ?? 0) + 1;
    }
    return contagem;
  }

  it('linhas trocadas entre DUAS empresas da origem divergem do plano', async () => {
    /*
      O caso mais traiçoeiro: a intrusa também mandou eventos, então a checagem
      de "empresa estranha" não vê nada. Só a comparação por PAR (tabela,
      empresa) pega — a Preço Justo cresceu menos que o previsto e a Gringa
      cresceu mais.
    */
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: PRECO_JUSTO }),
      evento({ id: 'c', node_seq: 3, aggregate_id: 'p3', company_id: GRINGA }),
    ]);
    const c = centralQueTroca(PRECO_JUSTO, GRINGA);

    const plano = planejarProjecao(await a.reader.lerNaoProjetados(100));
    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    const real = gravadasPorEmpresa(c, 'erp_products');
    expect(plano.porTabelaEmpresa.erp_products[PRECO_JUSTO]).toBe(2);
    expect(real[PRECO_JUSTO] ?? 0, 'a troca esvaziou a dona verdadeira').toBe(0);
    expect(real[GRINGA], 'e inflou a outra').toBe(3);
    // A divergência que o gate transforma em FALHA:
    expect(real).not.toEqual(plano.porTabelaEmpresa.erp_products);
  });

  it('linha desviada para empresa FORA da origem é pega pela outra rede', async () => {
    /*
      Aqui a comparação por par também divergiria, mas o que este caso trava é
      a segunda rede: nenhuma empresa pode aparecer no destino sem ter mandado
      evento nenhum. É a que pega até um desvio de UMA linha.
    */
    const INTRUSA = 'empresa-que-nao-mandou-nada';
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
    ]);
    const c = centralQueTroca(PRECO_JUSTO, INTRUSA);
    const empresasDaOrigem = new Set([PRECO_JUSTO]);

    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    const estranhas = Object.keys(gravadasPorEmpresa(c, 'erp_products'))
      .filter((e) => !empresasDaOrigem.has(e));
    expect(estranhas, 'a intrusa tem de aparecer na lista de estranhas').toEqual([INTRUSA]);
  });

  it('com a central HONESTA, as mesmas contas batem exatamente', async () => {
    // O contraponto que dá sentido aos dois acima: a detecção não pode
    // acusar quando nada foi trocado.
    const a = aterrissagemFalsa([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'p1', company_id: PRECO_JUSTO }),
      evento({ id: 'b', node_seq: 2, aggregate_id: 'p2', company_id: GRINGA }),
    ]);
    const c = centralFalsa();

    const plano = planejarProjecao(await a.reader.lerNaoProjetados(100));
    await reprojetarPendentes({ leitor: a.reader, transporte: c.transporte });

    expect(gravadasPorEmpresa(c, 'erp_products')).toEqual(plano.porTabelaEmpresa.erp_products);
  });
});

// ============================================================================

/*
  ============================================================================
  OPERAÇÃO NÃO É LINHA FINAL
  ============================================================================

  A primeira reprojeção real reportou 175 operações gravadas — e as tabelas
  terminaram com menos linhas. Não era perda: era UPSERT convergindo. 47
  movimentos de estoque produzem 47 linhas no razão (chave = id do movimento,
  única por evento) e apenas 15 no saldo (chave = empresa+produto, e vários
  movimentos do mesmo produto convergem para a mesma linha). 37 operações de
  produto convergiram para 16 produtos distintos.

  A conferência antiga comparava crescimento com contagem de operações — e
  reprovaria um resultado CORRETO. O plano passa a dizer, por tabela: quantas
  operações saem, sobre quantas CHAVES distintas, com qual estratégia — e quais
  são as chaves, para o gate conferir presença em vez de aritmética.
*/
describe('o plano separa operações de chaves finais', () => {
  function movimento(n: number, produto: string, empresa = PRECO_JUSTO) {
    return evento({
      id: `mov-${n}`,
      node_seq: n,
      event_type: 'inventory.moved',
      aggregate_type: 'inventory_movement',
      aggregate_id: `mov-${n}`,
      company_id: empresa,
      payload: {
        product_id: produto,
        movement_type: 'in',
        quantity: 1,
        balance_after: n,
      },
    });
  }

  it('razão é APPEND: cada movimento tem chave própria', () => {
    const p = planejarProjecao([
      movimento(1, 'prod-a'),
      movimento(2, 'prod-a'),
      movimento(3, 'prod-a'),
    ]);

    const razao = p.porTabelaDetalhe.erp_inventory_ledger;
    expect(razao.operacoes).toBe(3);
    expect(razao.chavesDistintas).toBe(3);
    expect(razao.estrategia).toBe('APPEND');
    expect(razao.chaveColunas).toEqual(['id']);
  });

  it('saldo CONVERGE: três movimentos do mesmo produto, uma linha final', () => {
    const p = planejarProjecao([
      movimento(1, 'prod-a'),
      movimento(2, 'prod-a'),
      movimento(3, 'prod-a'),
    ]);

    const saldo = p.porTabelaDetalhe.erp_inventory_snapshots;
    expect(saldo.operacoes).toBe(3);
    expect(saldo.chavesDistintas).toBe(1);
    expect(saldo.estrategia).toBe('CONVERGE');
    expect(saldo.chaveColunas).toEqual(['company_id', 'product_id']);
  });

  it('upsert + desativação do mesmo produto convergem para uma chave', () => {
    const p = planejarProjecao([
      evento({ id: 'a', node_seq: 1, aggregate_id: 'prod-x' }),
      evento({
        id: 'b', node_seq: 2, aggregate_id: 'prod-x',
        event_type: 'product.deactivated',
      }),
    ]);

    const produtos = p.porTabelaDetalhe.erp_products;
    expect(produtos.operacoes).toBe(2);
    expect(produtos.chavesDistintas).toBe(1);
    expect(produtos.estrategia).toBe('CONVERGE');
  });

  it('as chaves em si ficam disponíveis, com a empresa de cada uma', () => {
    /*
      É o que troca aritmética por verificação: o gate pode perguntar à central
      "esta chave existe? e pertence a esta empresa?" em vez de comparar somas
      que o UPSERT legitimamente encolhe.
    */
    const p = planejarProjecao([
      movimento(1, 'prod-a', PRECO_JUSTO),
      movimento(2, 'prod-b', GRINGA),
    ]);

    const saldo = p.porTabelaDetalhe.erp_inventory_snapshots;
    expect(saldo.chaves).toHaveLength(2);
    const donos = saldo.chaves.map((c) => c.empresa).sort();
    expect(donos).toEqual([GRINGA, PRECO_JUSTO].sort());
    for (const c of saldo.chaves) {
      expect(typeof c.chave).toBe('string');
      expect(c.chave.length).toBeGreaterThan(0);
    }
  });

  it('linhas previstas continuam sendo OPERAÇÕES — a soma que o RPC reporta', () => {
    // 175 gravadas com menos linhas finais não é perda; os dois números têm
    // nome diferente de propósito.
    const p = planejarProjecao([
      movimento(1, 'prod-a'),
      movimento(2, 'prod-a'),
    ]);
    expect(p.linhasPrevistas).toBe(4); // 2 razão + 2 saldo (operações)
    expect(p.porTabelaDetalhe.erp_inventory_snapshots.chavesDistintas).toBe(1);
  });
});
