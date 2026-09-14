/**
 * Carga inicial e conferência.
 *
 * A fila só carrega o que aconteceu depois que ela passou a existir. Todo o
 * histórico anterior está no SQLite e não subiria nunca — é o que este
 * processo resolve.
 *
 * O que se cobra aqui:
 *
 *  - carga leva o que existe HOJE, por leitura oficial do banco local;
 *  - rodar duas vezes não duplica (ids derivados do fato, não aleatórios);
 *  - cair no meio e recomeçar não duplica nem pula;
 *  - a conferência COMPARA e não conserta — o banco operacional nunca é
 *    alterado para "fazer bater" com a central.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  bootstrapCentralFromLocal,
  bootstrapEventId,
  compareLocalWithCentral,
} from '../src/services/sync/BootstrapService.js';
import type { OutboxRow } from '../src/services/sync/OutboxService.js';
import { InMemoryCentral, projectBatch } from '../src/services/sync/Projector.js';
import { createCustomer, createProduct } from '../src/services/core/CatalogService.js';
import { syncStatus } from '../src/services/sync/SyncService.js';

let gringa: string;

function filaBruta(): OutboxRow[] {
  return getConnection()
    .prepare('SELECT * FROM core_outbox ORDER BY seq')
    .all() as unknown as OutboxRow[];
}

function contarNaFila(aggregate: string): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT COUNT(*) c FROM core_outbox WHERE aggregate_type = ?')
        .get(aggregate) as { c: number }
    ).c,
  );
}

/** Histórico "de antes": grava direto, sem passar pela fila. */
function historicoAnterior(companyId: string, quantos: number): void {
  const agora = new Date().toISOString();
  const db = getConnection();
  for (let i = 1; i <= quantos; i += 1) {
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 1000, 2500, 1, ?, ?)`,
    ).run(`hist-${i}`, companyId, `H-${i}`, `Produto ${i}`, agora, agora);
  }
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('carga inicial', () => {
  it('leva o que já existia no nó antes da fila existir', () => {
    historicoAnterior(gringa, 5);
    // A fila está vazia: nada disso subiria sozinho.
    expect(filaBruta()).toHaveLength(0);

    const r = bootstrapCentralFromLocal();

    expect(r.enqueued).toBeGreaterThanOrEqual(6); // 5 produtos + 1 empresa
    expect(r.byAggregate.product).toBe(5);
    expect(r.byAggregate.company).toBe(1);
  });

  it('usa leitura oficial: o payload traz os campos do cadastro', () => {
    createProduct(gringa, { name: 'Camiseta', priceCents: 5000, unit: 'UN' });
    getConnection().prepare('DELETE FROM core_outbox').run();

    bootstrapCentralFromLocal();

    const produto = filaBruta().find((e) => e.aggregate_type === 'product')!;
    const payload = JSON.parse(produto.payload) as Record<string, unknown>;
    expect(payload.name).toBe('Camiseta');
    expect(payload.price_cents).toBe(5000);
  });

  it('a empresa sobe antes do produto — a central tem chave estrangeira', () => {
    historicoAnterior(gringa, 2);
    bootstrapCentralFromLocal();

    const tipos = filaBruta().map((e) => e.aggregate_type);
    expect(tipos.indexOf('company')).toBeLessThan(tipos.indexOf('product'));
  });

  it('o id do evento é DERIVADO do fato, não aleatório', () => {
    historicoAnterior(gringa, 1);
    bootstrapCentralFromLocal();

    const produto = filaBruta().find((e) => e.aggregate_type === 'product')!;
    expect(produto.id).toBe(bootstrapEventId('product', 'hist-1'));
  });

  it('marca o bootstrap como concluído — o estado deixa de ser READY_FOR_BOOTSTRAP', () => {
    historicoAnterior(gringa, 1);
    bootstrapCentralFromLocal();

    expect(syncStatus().bootstrapCompletedAt).toBeTruthy();
  });
});

describe('IDEMPOTÊNCIA da carga', () => {
  it('rodar duas vezes não duplica evento nenhum', () => {
    historicoAnterior(gringa, 4);

    bootstrapCentralFromLocal();
    const depoisDaPrimeira = contarNaFila('product');
    bootstrapCentralFromLocal();

    expect(contarNaFila('product')).toBe(depoisDaPrimeira);
    expect(depoisDaPrimeira).toBe(4);
  });

  it('e a central projetada fica igual depois de dez cargas', () => {
    historicoAnterior(gringa, 3);
    for (let i = 0; i < 10; i += 1) bootstrapCentralFromLocal();

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    expect(central.count('erp_products')).toBe(3);
    expect(central.count('erp_companies')).toBe(1);
  });
});

describe('CHECKPOINT — cair no meio e recomeçar', () => {
  it('a carga interrompida retoma sem duplicar nem pular', () => {
    historicoAnterior(gringa, 10);

    // Primeira passada completa, e depois "perdemos" parte da fila para
    // simular um processo que morreu antes de terminar.
    bootstrapCentralFromLocal();
    const todos = filaBruta().filter((e) => e.aggregate_type === 'product');
    const sobreviventes = todos.slice(0, 4).map((e) => e.id);
    getConnection()
      .prepare(
        `DELETE FROM core_outbox WHERE aggregate_type = 'product' AND id NOT IN (${sobreviventes
          .map(() => '?')
          .join(', ')})`,
      )
      .run(...sobreviventes);
    expect(contarNaFila('product')).toBe(4);

    // Retomada: os ids derivados fazem o reprocessamento ser inofensivo, e o
    // que faltava entra.
    bootstrapCentralFromLocal();

    expect(contarNaFila('product')).toBe(10);
    const ids = filaBruta()
      .filter((e) => e.aggregate_type === 'product')
      .map((e) => e.id);
    expect(new Set(ids).size).toBe(10);
  });

  it('o checkpoint é limpo ao concluir — a próxima carga começa do início', () => {
    historicoAnterior(gringa, 2);
    bootstrapCentralFromLocal();

    const cp = getConnection()
      .prepare("SELECT value FROM core_meta WHERE key = 'central_bootstrap_checkpoint'")
      .get() as { value?: string } | undefined;
    expect(cp?.value ?? '').toBe('');
  });
});

describe('CONFERÊNCIA — comparar sem consertar', () => {
  it('bate depois da carga: MATCH em todos os domínios com dado', () => {
    historicoAnterior(gringa, 3);
    createCustomer(gringa, { name: 'Ana', document: '111.444.777-35' });
    bootstrapCentralFromLocal();

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    const { lines, verdict } = compareLocalWithCentral((t) => central.count(t));
    const produtos = lines.find((l) => l.domain === 'products')!;
    expect(produtos.localCount).toBe(3);
    expect(produtos.centralCount).toBe(3);
    expect(verdict).toBe('MATCH');
  });

  it('acusa MISMATCH quando a central está atrás — e diz em qual domínio', () => {
    historicoAnterior(gringa, 5);
    bootstrapCentralFromLocal();

    const central = new InMemoryCentral();
    // Projeta só metade: simula uma sincronização incompleta.
    projectBatch(filaBruta().slice(0, 3), central);

    const { lines, verdict } = compareLocalWithCentral((t) => central.count(t));
    expect(verdict).toBe('MISMATCH');
    const produtos = lines.find((l) => l.domain === 'products')!;
    expect(produtos.verdict).toBe('MISMATCH');
    expect(produtos.localCount).toBeGreaterThan(produtos.centralCount);
  });

  it('a conferência NÃO altera o banco operacional', () => {
    historicoAnterior(gringa, 4);
    const antes = getConnection().prepare('SELECT COUNT(*) c FROM core_products').get() as {
      c: number;
    };

    // Central vazia: divergência máxima. Ainda assim nada do nó pode mudar —
    // durante a primeira carga a central é quem está recebendo, e "corrigir" o
    // operacional inverteria quem é a autoridade.
    const { verdict } = compareLocalWithCentral(() => 0);
    expect(verdict).toBe('MISMATCH');

    const depois = getConnection().prepare('SELECT COUNT(*) c FROM core_products').get() as {
      c: number;
    };
    expect(depois.c).toBe(antes.c);
  });

  it('cobre os domínios que o gestor pergunta', () => {
    const { lines } = compareLocalWithCentral(() => 0);
    const dominios = lines.map((l) => l.domain);
    expect(dominios).toEqual(
      expect.arrayContaining([
        'companies',
        'products',
        'customers',
        'inventory',
        'sales',
        'orders',
        'finance',
        'fiscal',
        'workshop',
      ]),
    );
  });
});

// ============================================================================

/*
  ============================================================================
  O BOOTSTRAP NÃO PODE FAZER O ESTADO ANDAR PARA TRÁS
  ============================================================================

  O bootstrap re-emite a história com seq NOVO — maior que o de qualquer evento
  vivo. A guarda de ordem (`node_seq`) então deixa essas emissões vencerem. Para
  fontes cujo payload é o estado ATUAL (pedido, produto, cliente), vencer é
  correto: o estado atual é a verdade mais fresca.

  Para o ESTOQUE, não. O snapshot guarda o `balance_after` do movimento de
  MAIOR seq — e o bootstrap emitia os movimentos em ordem de id (UUID), não de
  tempo. O último enfileirado seria o de id alfabeticamente maior: um ponto
  QUALQUER da história. O saldo consolidado da central regrediria para o saldo
  de um movimento antigo, calado, e o consolidado do grupo mostraria estoque
  que não existe (ou esconderia o que existe).

  A auditoria de retomada do sync (30/08/2026) pegou isso ANTES do primeiro
  bootstrap real. Este bloco trava a correção: movimentos sobem em ordem
  CRONOLÓGICA, e assim o maior seq é o movimento mais novo — cujo
  `balance_after` é o saldo atual de verdade.
*/
describe('o bootstrap preserva a ordem do tempo onde ela decide estado', () => {
  function movimentoLocal(id: string, criadoEm: string, saldoDepois: number): void {
    getConnection()
      .prepare(
        `INSERT INTO core_stock_movements
           (id, company_id, product_id, movement_type, quantity, balance_after,
            reference_type, reference_id, created_at)
         VALUES (?, ?, 'prod-mov', 'in', 1, ?, 'Ajuste', ?, ?)`,
      )
      .run(id, gringa, saldoDepois, 'ref-' + id, criadoEm);
  }

  it('movimentos sobem em ordem cronológica, não em ordem de id', () => {
    historicoAnterior(gringa, 1);
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, active, created_at, updated_at)
         VALUES ('prod-mov', ?, 'MOV-1', 'Produto Movimentado', 'UN', 1000, 2500, 1,
                 '2026-08-10T09:00:00.000Z', '2026-08-10T09:00:00.000Z')`,
      )
      .run(gringa);

    /*
      A ordem alfabética dos ids CONTRARIA a ordem do tempo, de propósito:
        mov-a  12:00  saldo 8   (o mais NOVO — o saldo verdadeiro)
        mov-b  11:00  saldo 2
        mov-c  10:00  saldo 5
      Em ordem de id, o último enfileirado seria mov-c e o snapshot diria 5.
    */
    movimentoLocal('mov-c', '2026-08-10T10:00:00.000Z', 5);
    movimentoLocal('mov-a', '2026-08-10T12:00:00.000Z', 8);
    movimentoLocal('mov-b', '2026-08-10T11:00:00.000Z', 2);

    bootstrapCentralFromLocal();

    const naFila = filaBruta().filter((e) => e.aggregate_type === 'inventory_movement');
    expect(naFila).toHaveLength(3);
    // O seq cresce na ordem de enfileiramento: a ordem tem de ser a do relógio.
    expect(naFila.map((e) => e.aggregate_id)).toEqual(['mov-c', 'mov-b', 'mov-a']);

    // E portanto o MAIOR seq carrega o saldo atual — é ele que a guarda deixa
    // vencer no snapshot.
    const ultimo = JSON.parse(naFila[naFila.length - 1].payload) as { balance_after?: number };
    expect(ultimo.balance_after).toBe(8);
  });

  it('o payload de equipamento carrega o STATUS que o projetor lê', () => {
    /*
      O bootstrap selecionava `sale_status` e o projetor lê `p.status`. Com seq
      alto e guarda de ordem, a emissão de bootstrap venceria a viva — e
      gravaria status NULO por cima do status real. O equipamento "em
      manutenção" viraria equipamento sem estado, sem erro nenhum.
    */
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, created_at)
         VALUES ('wk-1', ?, 'bancada-teste', 'Bancada de Teste', '2026-08-10T09:00:00.000Z')`,
      )
      .run(gringa);
    getConnection()
      .prepare(
        `INSERT INTO core_equipment (id, company_id, workshop_id, public_id, public_token,
                                     origin, status, created_at, updated_at)
         VALUES ('eq-1', ?, 'wk-1', 9001, 'tok-eq-1', 'CUSTOMER',
                 'em_manutencao', '2026-08-10T09:00:00.000Z', '2026-08-10T09:00:00.000Z')`,
      )
      .run(gringa);

    bootstrapCentralFromLocal();

    const evento = filaBruta().find((e) => e.aggregate_type === 'equipment');
    expect(evento).toBeTruthy();
    const p = JSON.parse(String(evento?.payload)) as Record<string, unknown>;
    expect(p.status, 'o campo que o projetor lê tem de vir preenchido').toBe('em_manutencao');
  });
});

// ============================================================================

/*
  ============================================================================
  O ID DO EVENTO VAI PARA UMA COLUNA uuid — E TEXTO NÃO É uuid
  ============================================================================

  Na primeira Carga inicial de verdade (30/08/2026), a central recusou o lote
  inteiro com o erro que dá nome a este bloco:

      HTTP 400, code 22P02
      invalid input syntax for type uuid:
      "bootstrap:company:399eceb2-362e-4c32-b69d-c7e47a1f8751"

  `erp_sync_events.id` é `uuid primary key`. Os 118 eventos vivos passavam
  porque `recordDomainEvent` usa randomUUID. O bootstrap usava o texto
  `bootstrap:<agregado>:<id>` — legível, determinístico... e não é um uuid.
  Os 81 fatos do histórico ficaram TODOS em retry, queimando tentativas.

  Por que nenhum teste pegou: as centrais de mentira (InMemoryCentral, os
  transportes de teste) aceitam qualquer string — o tipo `uuid` só existe no
  Postgres de verdade. Este bloco traz o contrato para dentro da suíte.

  ## A correção que ele trava

  O id continua DERIVADO do fato — sha256 de `bootstrap:<agregado>:<id>`,
  vestido de uuid (versão 8, RFC 9562: bits de versão e variante postos sobre
  o hash). Determinismo e idempotência intactos: a mesma entidade produz
  sempre o mesmo uuid, dez cargas convergem para uma linha. E a identidade da
  ENTIDADE nunca esteve aqui — ela é o aggregate_id, que sempre foi o uuid
  real da linha local.
*/
describe('o id do evento de bootstrap é um uuid de verdade', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('o caso EXATO que a central recusou passa a produzir uuid válido', () => {
    // A empresa real do erro de 30/08. O id derivado tem de caber numa
    // coluna `uuid` — é o contrato de erp_sync_events.id.
    const id = bootstrapEventId('company', '399eceb2-362e-4c32-b69d-c7e47a1f8751');
    expect(id).toMatch(UUID);
  });

  it('continua determinístico: a mesma entidade, o mesmo id, sempre', () => {
    const a = bootstrapEventId('product', 'prod-1');
    const b = bootstrapEventId('product', 'prod-1');
    expect(a).toBe(b);
  });

  it('entidades diferentes nunca colidem — nem entre agregados', () => {
    /*
      O agregado participa da derivação: um produto e um cliente com o mesmo
      id local (possível — são tabelas distintas) não podem disputar o mesmo
      evento.
    */
    const ids = new Set([
      bootstrapEventId('product', 'x-1'),
      bootstrapEventId('customer', 'x-1'),
      bootstrapEventId('company', 'x-1'),
      bootstrapEventId('product', 'x-2'),
    ]);
    expect(ids.size).toBe(4);
  });

  it('TODO evento enfileirado pela carga sai com id uuid', () => {
    historicoAnterior(gringa, 3);
    bootstrapCentralFromLocal();

    const naFila = filaBruta();
    expect(naFila.length).toBeGreaterThan(0);
    for (const e of naFila) {
      expect(e.id, e.aggregate_type + '/' + e.aggregate_id + ' com id fora do contrato uuid')
        .toMatch(UUID);
    }
  });

  it('e o aggregate_id continua sendo o uuid REAL da entidade — intocado', () => {
    // A identidade da entidade nunca foi o id do evento. Trocar o formato do
    // evento não pode encostar em quem a linha É.
    historicoAnterior(gringa, 1);
    bootstrapCentralFromLocal();

    const produto = filaBruta().find((e) => e.aggregate_type === 'product')!;
    expect(produto.aggregate_id).toBe('hist-1');
    expect(produto.company_id).toBe(gringa);
  });
});
