/**
 * E-mail transacional: montado sempre, enviado só com credencial.
 *
 * O QUE ESTE ARQUIVO PROTEGE
 *
 *  - NADA sai sem credencial, e nada é marcado como enviado sem ter saído.
 *    Um e-mail "enviado" que não existiu faz o suporte procurar na caixa do
 *    cliente uma mensagem que nunca chegou.
 *  - UMA mensagem por fato: dez webhooks repetidos do mesmo pagamento geram um
 *    e-mail. Dez confirmações iguais ensinam o cliente a ignorar a notificação
 *    inteira — inclusive a que importa.
 *  - O e-mail NUNCA derruba a venda. Endereço torto é motivo para não mandar
 *    mensagem, não para perder o pedido.
 *  - Só os marcos que exigem ação do cliente avisam. Avisar cada etapa interna
 *    vira ruído.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  advanceFulfillment,
  checkout,
  markOrderPaid,
} from '../src/services/core/StorefrontService.js';
import {
  emailStatus,
  flushEmailQueue,
  isDeliverableAddress,
  listEmailQueue,
  queueEmail,
  renderEmail,
} from '../src/services/notifications/EmailService.js';

let gringa: string;
let n = 0;

function produto(): string {
  n += 1;
  const id = `mail-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta', 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, gringa, `ML-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 30, 0, ?)',
  ).run(gringa, id, agora);
  return id;
}

function comprar(email: string | undefined) {
  n += 1;
  const [pedido] = checkout({
    idempotencyKey: `mail-ck-${n}`,
    customerName: 'Ana Compradora',
    customerEmail: email,
    customerDocument: '111.444.777-35',
    paymentMethod: 'pix',
    items: [{ productId: produto(), quantity: 1 }],
  });
  return pedido;
}

function fila() {
  return listEmailQueue(gringa, 100);
}

/*
  Este arquivo prova o comportamento SEM credencial — e o `.env` do dono pode
  ter as chaves EMAIL_* preenchidas (rodada 49). String vazia vence o arquivo
  (`loadDotEnvFiles` só escreve em chave ausente); sem forçar, a suíte
  quebraria — ou enviaria e-mail DE VERDADE — no dia em que a credencial real
  entrasse no ambiente.
*/
const EMAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;
const emailOriginais = new Map<string, string | undefined>();
for (const v of EMAIL_VARS) emailOriginais.set(v, process.env[v]);

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  for (const v of EMAIL_VARS) process.env[v] = '';
  // O interruptor é um enum ('true'|'false') — vazio não valida.
  process.env.EMAIL_ENABLED = 'false';
  resetEnvCacheForTests();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

afterEach(() => {
  for (const v of EMAIL_VARS) {
    const original = emailOriginais.get(v);
    if (original === undefined) delete process.env[v];
    else process.env[v] = original;
  }
  resetEnvCacheForTests();
});

describe('nada sai sem credencial', () => {
  it('o estado é READY_FOR_CREDENTIAL e diz o que falta', () => {
    const s = emailStatus(gringa);
    expect(s.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(s.enabled).toBe(false);
    // A lista precisa ser acionável: o gestor resolve item por item.
    expect(s.missing).toContain('EMAIL_ENABLED=true');
    expect(s.missing).toContain('EMAIL_SMTP_HOST');
  });

  it('mandar a fila NÃO marca nada como enviado', async () => {
    comprar('ana@exemplo.com');
    expect(fila()).toHaveLength(1);

    // Assíncrono desde a rodada 49, quando o flush ganhou transporte real —
    // a regra daqui continua idêntica: sem credencial, nada se move.
    const r = await flushEmailQueue();
    expect(r.readiness).toBe('READY_FOR_CREDENTIAL');
    expect(r.sent).toBe(0);
    // Não existe modo "fingir que mandou".
    expect(fila()[0].status).toBe('pending');
    expect(fila()[0].sentAt).toBeNull();
  });

  it('a fila acumula em vez de perder mensagem', () => {
    const pedido = comprar('ana@exemplo.com');
    markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });

    // Sem credencial, as duas continuam esperando — nenhuma se perde.
    expect(fila().filter((e) => e.status === 'pending')).toHaveLength(2);
  });
});

describe('uma mensagem por fato', () => {
  it('a MESMA chave enfileirada dez vezes vira uma linha', () => {
    // Este é o teste do mecanismo. Passar pelo `markOrderPaid` provaria a
    // idempotência DELE — ele já sai fora na segunda chamada —, e a fila
    // continuaria descoberta.
    const ctx = {
      storeName: 'Gringa',
      customerName: 'Ana',
      orderNumber: 1,
      totalCents: 1000,
    };
    const ids = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(
        queueEmail({
          companyId: gringa,
          template: 'pagamento_confirmado',
          toAddress: 'ana@exemplo.com',
          dedupeKey: 'pagamento_confirmado:pedido-x',
          context: ctx,
        }),
      );
    }

    expect(fila()).toHaveLength(1);
    // A primeira devolve id; as outras devolvem null, e quem chamou sabe que
    // não criou nada.
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
  });

  it('confirmar o pagamento dez vezes gera UM e-mail', () => {
    const pedido = comprar('ana@exemplo.com');
    for (let i = 0; i < 10; i += 1) {
      markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });
    }

    const confirmacoes = fila().filter((e) => e.template === 'pagamento_confirmado');
    expect(confirmacoes).toHaveLength(1);
  });

  it('cada marco tem a sua, sem repetir', () => {
    const pedido = comprar('ana@exemplo.com');
    markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada']) {
      advanceFulfillment({ companyId: gringa, orderId: pedido.id, toStatus: etapa });
    }

    const templates = fila().map((e) => e.template).sort();
    expect(templates).toEqual([
      'pagamento_confirmado',
      'pedido_pronto_retirada',
      'pedido_recebido',
    ]);
  });

  it('etapas internas NÃO avisam o cliente', () => {
    const pedido = comprar('ana@exemplo.com');
    markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });
    for (const etapa of ['separacao', 'conferencia', 'embalado']) {
      advanceFulfillment({ companyId: gringa, orderId: pedido.id, toStatus: etapa });
    }

    // "Separando seu pedido" três vezes é ruído, e ruído ensina a ignorar.
    expect(fila()).toHaveLength(2);
  });
});

describe('o e-mail nunca derruba a venda', () => {
  it('pedido sem e-mail é criado normalmente, só não notifica', () => {
    const pedido = comprar(undefined);
    expect(pedido.id).toBeTruthy();
    expect(fila()).toHaveLength(0);
  });

  it('endereço inutilizável não entra na fila', () => {
    for (const ruim of ['sem-arroba', 'a@b', 'com espaco@x.com', '']) {
      expect(isDeliverableAddress(ruim)).toBe(false);
    }
    expect(isDeliverableAddress('ana@exemplo.com')).toBe(true);

    const pedido = comprar('sem-arroba');
    expect(pedido.id).toBeTruthy();
    expect(fila()).toHaveLength(0);
  });
});

describe('o conteúdo', () => {
  it('o pedido recebido diz que ainda NÃO está pago', () => {
    const m = renderEmail('pedido_recebido', {
      storeName: 'Gringa',
      customerName: 'Ana',
      orderNumber: 42,
      totalCents: 24675,
    });
    expect(m.subject).toContain('#42');
    expect(m.bodyText).toContain('R$ 246,75');
    // Sem isto a pessoa acha que acabou e não paga o PIX.
    expect(m.bodyText).toMatch(/pagamento for confirmado/i);
  });

  it('o expedido só promete prazo quando existe prazo', () => {
    const semPrazo = renderEmail('pedido_expedido', {
      storeName: 'Gringa',
      customerName: 'Ana',
      orderNumber: 7,
      totalCents: 1000,
      trackingCode: 'BR123',
    });
    expect(semPrazo.bodyText).toContain('BR123');
    // "Chega em X dias" inventado é dívida que a loja não contraiu.
    expect(semPrazo.bodyText).not.toMatch(/prazo estimado/i);

    const comPrazo = renderEmail('pedido_expedido', {
      storeName: 'Gringa',
      customerName: 'Ana',
      orderNumber: 7,
      totalCents: 1000,
      trackingCode: 'BR123',
      estimatedDays: 4,
    });
    expect(comPrazo.bodyText).toMatch(/4 dia\(s\) útil\(eis\)/);
  });

  it('a mensagem guardada é a do INSTANTE do fato', () => {
    const pedido = comprar('ana@exemplo.com');
    const antes = fila()[0].bodyText;

    // O pedido muda depois; a confirmação já enviada não pode mudar junto.
    getConnection()
      .prepare('UPDATE core_orders SET total_cents = 999999 WHERE id = ?')
      .run(pedido.id);

    expect(fila()[0].bodyText).toBe(antes);
  });
});

describe('privacidade da fila', () => {
  it('o payload não carrega documento nem segredo', () => {
    comprar('ana@exemplo.com');
    const linha = getConnection()
      .prepare('SELECT payload FROM core_email_queue LIMIT 1')
      .get() as { payload: string };

    // A fila é lida em tela de gestão; o que aparece numa tela vaza em print.
    expect(linha.payload).not.toContain('111.444.777-35');
    expect(linha.payload.toLowerCase()).not.toContain('senha');
    expect(linha.payload.toLowerCase()).not.toContain('password');
  });
});
