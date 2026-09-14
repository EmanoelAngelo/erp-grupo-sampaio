/**
 * Worker de sincronização — entrega, falha, reinício e duplicidade.
 *
 * A pergunta central de todo este arquivo: **o que acontece quando dá errado?**
 * Sincronização que só funciona com rede boa não é sincronização; é sorte.
 *
 * Cenários cobertos, todos com central de TESTE (nenhuma credencial real é
 * necessária para desenvolver este projeto):
 *
 *  - central fora do ar → o PDV segue vendendo, nada se perde
 *  - processo morre depois do envio e antes do ACK → reenvio não duplica
 *  - dois workers no mesmo nó → um fato, um efeito
 *  - falha repetida → backoff e, no limite, `dead` esperando gente
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { MAX_ATTEMPTS, outboxStatus, pendentes } from '../src/services/sync/OutboxService.js';
import {
  startSyncWorker,
  stopSyncWorker,
  supabaseConfig,
  syncOnce,
  syncStatus,
  testCentralTransport,
  type CentralTransport,
} from '../src/services/sync/SyncService.js';
import { createSale } from '../src/services/core/SalesService.js';

let gringa: string;

function evento(id: string, tipo = 'sale.registered') {
  withTransaction(() => {
    recordDomainEvent({
      eventType: tipo as never,
      aggregateType: 'sale',
      aggregateId: id,
      companyId: gringa,
      payload: { id, total_cents: 5000 },
    });
  });
}

function statusDaFila(): Record<string, number> {
  const linhas = getConnection()
    .prepare('SELECT status, COUNT(*) c FROM core_outbox GROUP BY status')
    .all() as unknown as { status: string; c: number }[];
  return Object.fromEntries(linhas.map((l) => [l.status, l.c]));
}

function produto(companyId: string, id: string, saldo: number): void {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Item', 'UN', 1000, 2500, 1, ?, ?)`,
  ).run(id, companyId, `W-${id}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(companyId, id, saldo, agora);
}

/** Solta os prazos de backoff para o teste não precisar esperar de verdade. */
function adiantarRelogio(): void {
  getConnection().prepare('UPDATE core_outbox SET next_attempt_at = NULL').run();
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  /*
    `core_meta` sobrevive ao reset DE PROPÓSITO: é onde mora a versão do
    esquema e o registro de cada migração aplicada. Apagá-la faria o banco de
    teste esquecer quem é.

    Só que as marcas de SINCRONIA são outra coisa — estado operacional, não
    identidade. Um caso que confirma o esquema da central não pode decidir o
    estado do caso seguinte, e foi exatamente isso que aconteceu quando o
    envio passou a sondar o esquema antes de sair.
  */
  getConnection().exec("DELETE FROM core_meta WHERE key LIKE 'central_%'");
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('entrega normal', () => {
  it('envia na ordem em que os fatos aconteceram', async () => {
    for (const n of ['1', '2', '3']) evento(`v-${n}`);

    const recebidos: string[] = [];
    await syncOnce({
      transport: {
        name: 'ordem',
        isTest: true,
        async send(batch) {
          recebidos.push(...batch.map((r) => r.aggregate_id));
          return { acceptedIds: batch.map((r) => r.id) };
        },
      },
    });

    expect(recebidos).toEqual(['v-1', 'v-2', 'v-3']);
    expect(statusDaFila()).toEqual({ synced: 3 });
  });

  it('só sai da fila o que a central CONFIRMOU', async () => {
    evento('v-1');
    evento('v-2');

    // A central aceita o primeiro e cala sobre o segundo.
    const r = await syncOnce({
      transport: {
        name: 'parcial',
        isTest: true,
        async send(batch) {
          return { acceptedIds: [batch[0].id] };
        },
      },
    });

    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    // O não confirmado continua na fila, para reenvio. Marcar como enviado o
    // que "provavelmente chegou" é a forma de perder um fato de dinheiro.
    expect(statusDaFila().synced).toBe(1);
    expect(statusDaFila().retry).toBe(1);
  });
});

describe('OFFLINE — a loja não pode parar', () => {
  it('central fora do ar: a venda acontece, o estoque baixa, o evento espera', async () => {
    produto(gringa, 'p-1', 10);

    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-offline',
      items: [{ productId: 'p-1', quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });

    const r = await syncOnce({
      transport: {
        name: 'sem-rede',
        isTest: true,
        async send() {
          throw new Error('ECONNREFUSED');
        },
      },
    });

    // A venda está feita e o estoque baixou — a central não tem voto nisso.
    expect(sale.id).toBeTruthy();
    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE product_id = ?')
      .get('p-1') as { quantity: number };
    expect(saldo.quantity).toBe(8);

    // E o fato não se perdeu: continua na fila, com o motivo registrado.
    expect(r.sent).toBe(0);
    expect(r.error).toContain('ECONNREFUSED');
    expect(outboxStatus().pending + outboxStatus().retry).toBeGreaterThan(0);
    expect(outboxStatus().synced).toBe(0);
  });

  it('a central voltando, o atraso é recuperado — nada se perdeu', async () => {
    evento('v-1');
    await syncOnce({
      transport: {
        name: 'sem-rede',
        isTest: true,
        async send() {
          throw new Error('offline');
        },
      },
    });
    adiantarRelogio();

    const central = testCentralTransport();
    const r = await syncOnce({ transport: central });

    expect(r.sent).toBe(1);
    expect(central.gravados.size).toBe(1);
    expect(outboxStatus().pending).toBe(0);
  });
});

describe('DUPLICIDADE — o mesmo fato, muitas entregas', () => {
  it('o mesmo lote enviado dez vezes vira UMA linha na central', async () => {
    evento('v-1');
    const central = testCentralTransport();

    for (let i = 0; i < 10; i += 1) {
      await syncOnce({ transport: central });
      // Força o reenvio: simula ACK perdido dez vezes seguidas.
      getConnection().prepare("UPDATE core_outbox SET status = 'pending', sent_at = NULL").run();
      adiantarRelogio();
    }

    expect(central.envios).toBe(10);
    // Dez entregas, uma linha: é o UPSERT por id que garante isso.
    expect(central.gravados.size).toBe(1);
  });

  it('depois de sincronizado, a fila não reenvia sozinha', async () => {
    evento('v-1');
    const central = testCentralTransport();

    await syncOnce({ transport: central });
    await syncOnce({ transport: central });
    await syncOnce({ transport: central });

    // Só o primeiro tinha o que enviar.
    expect(central.envios).toBe(1);
    expect(statusDaFila()).toEqual({ synced: 1 });
  });
});

describe('REINÍCIO DO PROCESSO', () => {
  it('morrer entre o envio e o ACK local não perde nem duplica o fato', async () => {
    evento('v-1');
    const central = testCentralTransport();

    // O processo morre logo depois de a central gravar: nada de `marcarEnviados`.
    await syncOnce({
      transport: {
        name: 'morre-apos-enviar',
        isTest: true,
        async send(batch) {
          for (const row of batch) central.gravados.set(row.id, row);
          throw new Error('processo morreu antes do ACK');
        },
      },
    });

    expect(central.gravados.size).toBe(1);
    // Do lado do nó o evento continua pendente — do jeito certo: melhor
    // reenviar do que assumir que chegou.
    expect(outboxStatus().synced).toBe(0);

    // Reinício: reenvia, e a central deduplica por id.
    adiantarRelogio();
    const r = await syncOnce({ transport: central });
    expect(r.sent).toBe(1);
    expect(central.gravados.size).toBe(1);
    expect(outboxStatus().synced).toBe(1);
  });

  it('evento preso em "processing" volta a circular quando o prazo vence', async () => {
    evento('v-1');
    getConnection()
      .prepare("UPDATE core_outbox SET status = 'processing', next_attempt_at = ?")
      .run(new Date(Date.now() + 60_000).toISOString());

    // Enquanto o prazo não vence, nenhum outro worker pega — evita gastar rede
    // com envio duplicado.
    expect(pendentes()).toHaveLength(0);

    adiantarRelogio();
    expect(pendentes()).toHaveLength(1);
  });
});

describe('MULTI-WORKER no mesmo nó', () => {
  it('dois workers em paralelo produzem UM efeito na central', async () => {
    for (const n of ['1', '2', '3']) evento(`v-${n}`);
    const central = testCentralTransport();

    await Promise.all([syncOnce({ transport: central }), syncOnce({ transport: central })]);

    // Mesmo que os dois peguem o mesmo lote, a central deduplica por id.
    expect(central.gravados.size).toBe(3);
    expect(outboxStatus().synced).toBe(3);
  });
});

describe('RETRY e backoff', () => {
  it('a falha registra motivo, conta tentativa e agenda a próxima', async () => {
    evento('v-1');

    await syncOnce({
      transport: {
        name: 'recusa',
        isTest: true,
        async send() {
          throw new Error('HTTP 503');
        },
      },
    });

    const linha = getConnection()
      .prepare('SELECT status, attempts, last_error, next_attempt_at FROM core_outbox')
      .get() as { status: string; attempts: number; last_error: string; next_attempt_at: string };
    expect(linha.status).toBe('retry');
    expect(linha.attempts).toBe(1);
    expect(linha.last_error).toContain('503');
    // Logo em seguida não há nada elegível: martelar a central fora do ar só
    // queima bateria e enche log.
    expect(pendentes()).toHaveLength(0);
    expect(new Date(linha.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('esgotadas as tentativas, o evento vira "dead" e espera uma pessoa', async () => {
    evento('v-1');
    const recusa: CentralTransport = {
      name: 'sempre-recusa',
      isTest: true,
      async send() {
        throw new Error('erro permanente');
      },
    };

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: recusa });
    }

    expect(statusDaFila().dead).toBe(1);
    // Morto não é reenviado sozinho: doze falhas seguidas indicam problema que
    // tentar de novo não resolve.
    adiantarRelogio();
    expect(pendentes()).toHaveLength(0);
    expect(outboxStatus().dead).toBe(1);
  });
});

describe('ESTADOS HONESTOS', () => {
  /*
    O NOME MUDOU, E ESTE CASO É O TRIPWIRE QUE PEGOU.

    Ele cobrava `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Esses eram os
    nomes que só a sincronia usava — o backup remoto, na mesma conta Supabase,
    sempre leu `DEVORA_SUPABASE_URL` e `DEVORA_SUPABASE_SERVICE_KEY`.

    O `.env` desta instalação tinha os `DEVORA_*` preenchidos: o backup subia
    e a sincronia nunca ligou. 118 eventos parados desde 15/08/2026.

    O projeto passou a ter UM nome, o `DEVORA_*` que já era o oficial em todo o
    resto. Este caso foi atualizado para ele — e ganhou, logo abaixo, o irmão
    que cobra que o nome ANTIGO seja denunciado em vez de ignorado.
  */
  it('sem credencial: READY_FOR_CREDENTIAL, e a fila acumula', async () => {
    const anterior = { ...process.env };
    delete process.env.DEVORA_SUPABASE_URL;
    delete process.env.DEVORA_SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      evento('v-1');
      const status = syncStatus();
      expect(status.readiness).toBe('READY_FOR_CREDENTIAL');
      expect(status.missing).toContain('DEVORA_SUPABASE_URL');
      expect(status.missing).toContain('DEVORA_SUPABASE_SERVICE_KEY');

      const r = await syncOnce();
      expect(r.readiness).toBe('READY_FOR_CREDENTIAL');
      expect(r.sent).toBe(0);
      expect(outboxStatus().pending).toBe(1);
    } finally {
      Object.assign(process.env, anterior);
    }
  });

  it('com transporte mas sem schema conferido: READY_FOR_SCHEMA', () => {
    const status = syncStatus(testCentralTransport());
    // "Tem credencial" NÃO é "tem schema". Chamar isso de ONLINE esconderia a
    // pergunta que o gestor precisa fazer.
    expect(status.readiness).toBe('READY_FOR_SCHEMA');
  });

  it('a central de TESTE se identifica como tal', () => {
    const status = syncStatus(testCentralTransport());
    expect(status.isTestTransport).toBe(true);
    // Um ambiente que sincroniza para lugar nenhum não pode se apresentar
    // como pronto.
    expect(status.transport).toBe('test-central');
  });

  it('o estado NUNCA devolve a credencial', () => {
    const anterior = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = 'https://projeto.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-secreta';
    try {
      expect(JSON.stringify(syncStatus())).not.toContain('chave-de-servico-secreta');
    } finally {
      if (anterior === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = anterior;
      delete process.env.SUPABASE_URL;
    }
  });

  it('o atraso é medido em segundos, para o gestor remoto saber o tamanho', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'sale.registered',
        aggregateType: 'sale',
        aggregateId: 'v-antigo',
        companyId: gringa,
        payload: {},
        occurredAt: new Date(Date.now() - 12_000).toISOString(),
      });
    });

    const lag = outboxStatus().lagSeconds;
    expect(lag).not.toBeNull();
    expect(lag!).toBeGreaterThanOrEqual(11);
  });
});

/**
 * O CICLO DE FUNDO PRECISA MESMO RODAR.
 *
 * O trabalhador existia inteiro — lote, upsert idempotente, baixa só do que a
 * central confirmou — e `startSyncWorker` não tinha um único chamador. A tela
 * dizia "a fila sobe sozinha" e nada subia: quem visse o texto acreditaria, e
 * só descobriria olhando a fila crescer por dias.
 *
 * Afirmação sobre processo de fundo tem que ser conferível de fora. Daí
 * `workerRunning` no estado.
 */
describe('o ciclo automático é conferível, não prometido', () => {
  it('parado, o estado diz parado', () => {
    stopSyncWorker();
    expect(syncStatus().workerRunning).toBe(false);
  });

  it('ligado, o estado diz ligado — e desligar volta a dizer parado', () => {
    try {
      startSyncWorker({ intervalMs: 60_000, transport: testCentralTransport() });
      expect(syncStatus().workerRunning).toBe(true);
    } finally {
      stopSyncWorker();
    }
    expect(syncStatus().workerRunning).toBe(false);
  });

  it('ligar duas vezes não cria dois ciclos', () => {
    try {
      startSyncWorker({ intervalMs: 60_000, transport: testCentralTransport() });
      startSyncWorker({ intervalMs: 60_000, transport: testCentralTransport() });
      expect(syncStatus().workerRunning).toBe(true);
      // Um `stop` tem que bastar: se o segundo `start` tivesse criado outro
      // timer, ele ficaria rodando órfão, enviando lote em paralelo com o
      // primeiro pelo resto da vida do processo.
      stopSyncWorker();
      expect(syncStatus().workerRunning).toBe(false);
    } finally {
      stopSyncWorker();
    }
  });

  /*
    O NOME DESTE CASO DIZIA O CONTRÁRIO DO BOOT (GAP-PRD-139).

    Chamava-se "o servidor NÃO liga o ciclo sem credencial da central", e o
    corpo só conferia o estado. O boot (`server/src/index.ts`) chama
    `startSyncWorker()` SEMPRE — o `if (supabaseConfig())` caiu porque só
    criava dependência de ordem. Quem lesse o título "consertaria" o boot para
    bater com o teste, e a fila de venda/estoque/fiscal voltaria a ficar parada
    até alguém reiniciar a API depois de preencher a credencial.

    O contrato de verdade, e o que este caso prova: sem credencial o ciclo
    RODA, cada passada devolve READY_FOR_CREDENTIAL sem tocar a rede, e a fila
    ACUMULA (nada é descartado nem contado como tentativa).

    E os nomes limpos são os OFICIAIS: o caso antigo apagava `SUPABASE_URL` e
    `SUPABASE_SERVICE_ROLE_KEY`, nomes que o servidor nem lê mais.
  */
  it('sem credencial da central o ciclo roda, o estado é READY_FOR_CREDENTIAL e a fila acumula', async () => {
    const nomes = [
      'DEVORA_SUPABASE_URL',
      'DEVORA_SUPABASE_SERVICE_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ] as const;
    const antes = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
    for (const n of nomes) delete process.env[n];
    const fetchReal = globalThis.fetch;
    let chamadasDeRede = 0;
    globalThis.fetch = (async () => {
      chamadasDeRede += 1;
      throw new Error('sem credencial não se toca a rede');
    }) as typeof fetch;
    try {
      expect(supabaseConfig()).toBeNull();
      expect(syncStatus().readiness).toBe('READY_FOR_CREDENTIAL');

      // O que o boot faz: liga SEM condição.
      startSyncWorker({ intervalMs: 60_000 });
      expect(syncStatus().workerRunning).toBe(true);

      evento('v-sem-credencial');
      const r = await syncOnce();
      expect(r.readiness).toBe('READY_FOR_CREDENTIAL');
      expect(r.attempted).toBe(0);
      expect(chamadasDeRede).toBe(0);
      // A fila acumula: o evento continua lá, sem tentativa gasta.
      expect(statusDaFila()).toEqual({ pending: 1 });
      const tentativas = getConnection()
        .prepare('SELECT attempts FROM core_outbox WHERE aggregate_id = ?')
        .get('v-sem-credencial') as { attempts: number };
      expect(tentativas.attempts).toBe(0);
    } finally {
      stopSyncWorker();
      globalThis.fetch = fetchReal;
      for (const n of nomes) {
        if (antes[n] !== undefined) process.env[n] = antes[n];
      }
    }
  });
});

// ============================================================================

/*
  ============================================================================
  CENTRAL SEM ESQUEMA NÃO É CENTRAL FORA DO AR
  ============================================================================

  Os dois casos parecem o mesmo — o envio falha —, e não são. Central fora do
  ar volta: insistir com espera crescente é a resposta certa, e é o que este
  arquivo já cobria. Central sem as tabelas não volta sozinha; alguém tem de
  rodar o SQL no painel. Insistir contra isso é gastar o orçamento de tentativas
  contra uma condição que tentar de novo não resolve.

  E o orçamento acaba: doze tentativas, espera com teto de cinco minutos. Uma
  hora de servidor no ar, e a fila inteira vira `dead` — esperando uma pessoa
  que nem sabe que precisa ser esperada.

  Isso foi MEDIDO, não imaginado. Ao ligar o worker depois de acertar o nome da
  credencial, com a central ainda sem o esquema, 100 dos 118 eventos foram para
  `retry` com duas tentativas em menos de um minuto, todos com o mesmo erro:

      Central recusou o lote (HTTP 404): Could not find the table
      'public.erp_sync_events' in the schema cache

  O estado `READY_FOR_SCHEMA` existe desde sempre e já dizia exatamente isso.
  Ninguém o consultava antes de enviar.
*/
describe('sem esquema na central, não se gasta tentativa', () => {
  /** Uma central que responde, autentica — e não tem as tabelas. */
  function centralSemEsquema(): CentralTransport & { enviou: number } {
    const t = {
      name: 'central-sem-esquema',
      isTest: true,
      enviou: 0,
      async send() {
        t.enviou += 1;
        throw new Error(
          "Central recusou o lote (HTTP 404): Could not find the table 'public.erp_sync_events'",
        );
      },
      async probeSchema() {
        return { ok: false, detail: 'tabelas ausentes' };
      },
    };
    return t;
  }

  it('a fila não é sequer tentada', async () => {
    evento('v-sem-esquema-1');
    const t = centralSemEsquema();

    const r = await syncOnce({ transport: t });

    expect(r.attempted, 'nada deve sair enquanto a central não tem onde receber').toBe(0);
    expect(t.enviou, 'o transporte nem foi chamado').toBe(0);
    expect(r.readiness).toBe('READY_FOR_SCHEMA');
  });

  it('e nenhum evento ganha tentativa — o orçamento fica intacto', async () => {
    /*
      É o caso que importa de verdade. Sem ele, uma hora de servidor no ar
      contra uma central sem esquema deixa a fila inteira em `dead`.
    */
    evento('v-sem-esquema-2');
    const t = centralSemEsquema();

    for (let i = 0; i < 5; i += 1) await syncOnce({ transport: t });

    const linha = getConnection()
      .prepare("SELECT attempts, status FROM core_outbox WHERE aggregate_id = 'v-sem-esquema-2'")
      .get() as { attempts: number; status: string };
    expect(linha.attempts, 'cinco passadas não podem ter gasto tentativa nenhuma').toBe(0);
    expect(linha.status).toBe('pending');
  });

  it('assim que o esquema aparece, a mesma passada volta a enviar', async () => {
    /*
      A espera não pode virar paralisia: o dono roda o SQL no painel e a fila
      tem de andar sozinha na batida seguinte, sem reiniciar o servidor.
    */
    evento('v-com-esquema');
    let temEsquema = false;
    const entregues: string[] = [];
    const t: CentralTransport = {
      name: 'central-que-ganha-esquema',
      isTest: true,
      async send(batch) {
        entregues.push(...batch.map((r) => r.id));
        return { acceptedIds: batch.map((r) => r.id) };
      },
      async probeSchema() {
        return temEsquema ? { ok: true, centralVersion: 1 } : { ok: false, detail: 'ausente' };
      },
    };

    await syncOnce({ transport: t });
    expect(entregues, 'sem esquema, nada sai').toHaveLength(0);

    temEsquema = true;
    const depois = await syncOnce({ transport: t });
    expect(depois.attempted, 'com esquema, a fila anda na passada seguinte').toBeGreaterThan(0);
    expect(entregues.length).toBeGreaterThan(0);
  });

  it('central fora do ar CONTINUA gastando tentativa — são coisas diferentes', async () => {
    /*
      O guarda novo não pode engolir a falha transitória. Uma central que tem o
      esquema e está inacessível é exatamente o caso em que insistir resolve.
    */
    evento('v-fora-do-ar');
    const t: CentralTransport = {
      name: 'central-fora-do-ar',
      isTest: true,
      async send() {
        throw new Error('ECONNREFUSED');
      },
      async probeSchema() {
        return { ok: true, centralVersion: 1 };
      },
    };

    await syncOnce({ transport: t });

    const linha = getConnection()
      .prepare("SELECT attempts, status FROM core_outbox WHERE aggregate_id = 'v-fora-do-ar'")
      .get() as { attempts: number; status: string };
    expect(linha.attempts, 'falha transitória deve continuar contando').toBeGreaterThan(0);
    expect(linha.status).toBe('retry');
  });
});
