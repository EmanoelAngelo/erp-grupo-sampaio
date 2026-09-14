/**
 * O COMPROVANTE DA VENDA DIZ A CONTA INTEIRA — NO NAVEGADOR E NA TÉRMICA.
 *
 * Achados da auditoria do cupom que este arquivo cobra:
 *
 *   F-06  o ESC/POS do agente não era o mesmo papel do HTML: sem unitário,
 *         desconto, acréscimo, subtotal, troco, com o código cru do meio
 *         ("credito") e o CNPJ como o banco guarda;
 *   F-08  a data/hora saía no fuso da MÁQUINA do servidor (UTC no contêiner):
 *         a venda das 21:30 saía às 00:30 do dia seguinte;
 *   F-13  o PIX "receber depois" (pendente) saía impresso igual a um pago;
 *   F-14  o vale usado na venda não aparecia: TOTAL R$ 100 e só R$ 70 pagos;
 *   F-19  a venda CANCELADA reimprimia igual a uma válida, sem tarja;
 *   F-20  `/D/g` no CNPJ (arrancava a letra D) e quantidade fracionada com
 *         ponto ("0.5 x").
 *
 * As vendas são gravadas direto nas tabelas — o que se testa é o PAPEL que
 * sai de uma venda como o banco a guarda, não as regras do fechamento.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { createCustomer } from '../src/services/core/CatalogService.js';
import { cnpjLegivel, dadosDoCupom, renderDocument } from '../src/services/core/PrintRenderer.js';
import { cupomEscPosDaVenda } from '../src/services/core/EscPos.js';

let empresa: string;
let n = 0;

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * O texto que a térmica imprime, sem os comandos ESC/POS que o cupom usa:
 * `ESC @`, `ESC a n`, `ESC E n`, `ESC p m t1 t2` e `GS V B 0`.
 */
function textoDaTermica(bytes: Uint8Array): string {
  const saida: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x1b) {
      const comando = bytes[i + 1];
      i += comando === 0x40 ? 1 : comando === 0x70 ? 4 : 2;
      continue;
    }
    if (bytes[i] === 0x1d) {
      i += 3;
      continue;
    }
    saida.push(bytes[i]);
  }
  return Buffer.from(saida).toString('latin1');
}

interface Linha {
  descricao: string;
  quantidade: number;
  unitarioCents: number;
  descontoCents?: number;
  unidade?: string;
}

function venda(o: {
  itens: Linha[];
  descontoCents?: number;
  acrescimoCents?: number;
  pagamentos: { method: string; amountCents: number; status?: string }[];
  trocoCents?: number;
  status?: string;
  criadaEm?: string;
  canceladaEm?: string | null;
  valeCents?: number;
}): string {
  ensureCoreSchema();
  n += 1;
  const db = getConnection();
  const id = `venda-${n}`;
  const agora = o.criadaEm ?? new Date().toISOString();
  const liquidos = o.itens.map((i) => Math.round(i.quantidade * i.unitarioCents) - (i.descontoCents ?? 0));
  const subtotal = liquidos.reduce((s, v) => s + v, 0);
  const total = subtotal - (o.descontoCents ?? 0) + (o.acrescimoCents ?? 0);

  let clienteId: string | null = null;
  if (o.valeCents) clienteId = String(createCustomer(empresa, { name: `Cliente ${n}` } as never).id);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents,
                             created_at, cancelled_at, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pdv', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    empresa,
    100 + n,
    o.status ?? 'completed',
    subtotal,
    o.descontoCents ?? 0,
    o.acrescimoCents ?? 0,
    total,
    `k-${id}`,
    o.trocoCents ?? 0,
    agora,
    o.canceladaEm ?? null,
    clienteId,
  );
  o.itens.forEach((i, k) => {
    const produto = `p-${id}-${k}`;
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    ).run(produto, empresa, `C-${id}-${k}`, i.descricao, i.unidade ?? 'UN', i.unitarioCents, agora, agora);
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`i-${id}-${k}`, id, empresa, produto, i.descricao, i.quantidade, i.unitarioCents, i.descontoCents ?? 0, liquidos[k]);
  });
  o.pagamentos.forEach((p, k) => {
    db.prepare(
      `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`pay-${id}-${k}`, id, empresa, p.method, p.amountCents, p.status ?? 'settled', agora);
  });
  if (o.valeCents && clienteId) {
    // O resgate como o SalesService grava: negativo, origem 'sale'.
    db.prepare(
      `INSERT INTO core_customer_credits (id, company_id, customer_id, kind, amount_cents,
                                          origin_type, origin_id, description, created_at)
       VALUES (?, ?, ?, 'redeem', ?, 'sale', ?, 'Vale usado na venda', ?)`,
    ).run(`cred-${id}`, empresa, clienteId, -o.valeCents, id, agora);
  }
  return id;
}

const cupomHtml = (saleId: string) => renderDocument(empresa, 'SALE_RECEIPT', saleId);
const cupomTermico = (saleId: string, colunas: 32 | 48 = 48) =>
  textoDaTermica(cupomEscPosDaVenda(empresa, saleId, { colunas }));

beforeEach(() => {
  resetDbForTests();
  n = 0;
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
    cnpj: '12345678000190',
  });
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      street: 'Rua das Palmeiras',
      number: '128',
      district: 'Centro',
      cityName: 'Pelotas',
      uf: 'RS',
      phone: '(53) 3222-1111',
    },
  });
});

// ============================================================================

describe('F-06 — o cupom da térmica é o mesmo papel do navegador', () => {
  it('unitário, subtotal, desconto, TOTAL, meio legível, TROCO, CNPJ formatado e endereço', () => {
    // 2 × R$ 50 = R$ 100; desconto de rodapé R$ 10; total R$ 90; R$ 100 em dinheiro, troco R$ 10.
    const id = venda({
      itens: [{ descricao: 'Camiseta', quantidade: 2, unitarioCents: 5_000 }],
      descontoCents: 1_000,
      pagamentos: [{ method: 'dinheiro', amountCents: 10_000 }],
      trocoCents: 1_000,
    });
    const t = cupomTermico(id);

    expect(t).toContain('2 x 50,00');
    expect(t).toContain('100,00');
    expect(t).toMatch(/Subtotal\s+100,00/);
    expect(t).toMatch(/Desconto\s+-10,00/);
    expect(t).toMatch(/TOTAL\s+90,00/);
    expect(t).toMatch(/Dinheiro\s+100,00/);
    expect(t).toMatch(/TROCO\s+10,00/);
    // O CNPJ como o cliente lê, e para onde voltar.
    expect(t).toContain('CNPJ 12.345.678/0001-90');
    expect(t).toContain('Rua das Palmeiras');
    expect(t).toContain('(53) 3222-1111');
  });

  it('o meio sai pelo nome ("Cartao de credito"), e o desconto do item e o acréscimo têm linha', () => {
    const id = venda({
      itens: [{ descricao: 'Tênis', quantidade: 1, unitarioCents: 20_000, descontoCents: 2_000 }],
      acrescimoCents: 500,
      pagamentos: [{ method: 'credito', amountCents: 18_500 }],
    });
    const t = cupomTermico(id);
    const linhas = t.split('\n').map((l) => l.trim());

    expect(t).toMatch(/Cartao de credito\s+185,00/);
    // O código cru do banco não começa linha nenhuma.
    expect(linhas.some((l) => /^credito\b/.test(l))).toBe(false);
    expect(t).toMatch(/1 x 200,00\s+200,00/);
    expect(t).toMatch(/Desconto do item\s+-20,00/);
    expect(t).toMatch(/Acrescimo\s+\+5,00/);
    expect(t).toMatch(/TOTAL\s+185,00/);
  });

  it('as linhas de pagamento do HTML e da térmica são as mesmas', () => {
    const id = venda({
      itens: [{ descricao: 'Bermuda', quantidade: 1, unitarioCents: 10_000 }],
      pagamentos: [
        { method: 'pix', amountCents: 4_000 },
        { method: 'debito', amountCents: 6_000 },
      ],
    });
    const html = cupomHtml(id);
    const t = cupomTermico(id);
    for (const rotulo of ['PIX', 'Cartão de débito']) expect(html).toContain(rotulo);
    for (const rotulo of ['PIX', 'Cartao de debito']) expect(t).toContain(rotulo);
  });
});

// ============================================================================

describe('F-08 — a hora do papel é a da loja, e não a do servidor', () => {
  let tzAntes: string | undefined;
  beforeAll(() => {
    // O contêiner da API roda em UTC (node:24-alpine sem TZ).
    tzAntes = process.env.TZ;
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (tzAntes === undefined) delete process.env.TZ;
    else process.env.TZ = tzAntes;
  });

  it('venda das 21:30 de 14/09 em Pelotas sai 14/09 21:30 — no HTML e na térmica', () => {
    const id = venda({
      itens: [{ descricao: 'Camiseta', quantidade: 1, unitarioCents: 5_000 }],
      pagamentos: [{ method: 'dinheiro', amountCents: 5_000 }],
      criadaEm: '2026-09-15T00:30:00.000Z',
    });

    const html = cupomHtml(id);
    expect(html).toContain('14/09/2026, 21:30:00');
    expect(html).not.toContain('15/09/2026');

    const t = cupomTermico(id);
    expect(t).toContain('14/09/2026, 21:30:00');
    expect(t).not.toContain('15/09/2026');
  });

  it('o fuso é o da UF da loja: Manaus está uma hora atrás de Brasília', () => {
    updateFiscalConfig({ companyId: empresa, patch: { uf: 'AM' } });
    const id = venda({
      itens: [{ descricao: 'Camiseta', quantidade: 1, unitarioCents: 5_000 }],
      pagamentos: [{ method: 'dinheiro', amountCents: 5_000 }],
      criadaEm: '2026-09-15T00:30:00.000Z',
    });
    expect(cupomHtml(id)).toContain('14/09/2026, 20:30:00');
  });
});

// ============================================================================

describe('F-13 — PIX pendente não sai como pago', () => {
  it('a linha diz "aguardando confirmação" e o papel avisa quanto falta receber', () => {
    const id = venda({
      itens: [{ descricao: 'Jaqueta', quantidade: 1, unitarioCents: 12_000 }],
      pagamentos: [{ method: 'pix', amountCents: 12_000, status: 'pending' }],
    });

    const html = cupomHtml(id);
    expect(html).toContain('PIX — aguardando confirmação');
    expect(html).toContain(`A RECEBER ${brl(12_000)}`);

    const t = cupomTermico(id);
    expect(t).toContain('PIX - aguardando confirmacao');
    expect(t).toContain('A RECEBER 120,00');
  });

  it('PIX liquidado sai como sempre saiu, sem ressalva', () => {
    const id = venda({
      itens: [{ descricao: 'Jaqueta', quantidade: 1, unitarioCents: 12_000 }],
      pagamentos: [{ method: 'pix', amountCents: 12_000 }],
    });
    const html = cupomHtml(id);
    expect(html).not.toContain('aguardando confirmação');
    expect(html).not.toContain('A RECEBER');
  });
});

// ============================================================================

describe('F-14 — o vale usado na venda está no papel', () => {
  it('R$ 30 de vale + R$ 70 em dinheiro: os meios impressos somam o TOTAL', () => {
    const id = venda({
      itens: [{ descricao: 'Calça', quantidade: 1, unitarioCents: 10_000 }],
      pagamentos: [{ method: 'dinheiro', amountCents: 7_000 }],
      valeCents: 3_000,
    });

    const html = cupomHtml(id);
    expect(html).toContain('Vale / crédito do cliente');
    expect(html).toContain(brl(3_000));

    const dados = dadosDoCupom(empresa, id);
    expect(dados.meios.reduce((s, m) => s + m.valorCents, 0)).toBe(dados.totalCents);

    const t = cupomTermico(id);
    expect(t).toMatch(/Vale \/ credito do cliente\s+30,00/);
    expect(t).toMatch(/Dinheiro\s+70,00/);
  });
});

// ============================================================================

describe('F-19 — venda cancelada reimprime com tarja', () => {
  it('o HTML e a térmica dizem VENDA CANCELADA, com a data do cancelamento', () => {
    const id = venda({
      itens: [{ descricao: 'Vestido', quantidade: 1, unitarioCents: 15_000 }],
      pagamentos: [{ method: 'dinheiro', amountCents: 15_000 }],
      status: 'cancelled',
      canceladaEm: '2026-09-14T18:00:00.000Z',
    });

    const html = cupomHtml(id);
    expect(html).toContain('VENDA CANCELADA em 14/09/2026, 15:00:00');
    // A tarja vem antes de tudo — quem pega o papel vê primeiro.
    expect(html.indexOf('VENDA CANCELADA')).toBeLessThan(html.indexOf('COMPROVANTE NÃO FISCAL'));

    const t = cupomTermico(id);
    expect(t).toContain('*** VENDA CANCELADA em 14/09/2026, 15:00:00 ***');
  });

  it('venda válida não tem tarja nenhuma', () => {
    const id = venda({
      itens: [{ descricao: 'Vestido', quantidade: 1, unitarioCents: 15_000 }],
      pagamentos: [{ method: 'dinheiro', amountCents: 15_000 }],
    });
    expect(cupomHtml(id)).not.toContain('CANCELADA');
    expect(cupomTermico(id)).not.toContain('CANCELADA');
  });
});

// ============================================================================

describe('F-20 — acabamento: CNPJ e quantidade fracionada', () => {
  it('o CNPJ gravado em formato misto sai formatado (a expressão era /D/g)', () => {
    expect(cnpjLegivel('12.345678/0001-90')).toBe('12.345.678/0001-90');
    expect(cnpjLegivel('12345678000190')).toBe('12.345.678/0001-90');
    expect(cnpjLegivel('12.345.678/0001-90')).toBe('12.345.678/0001-90');
    // O que não é CNPJ volta como veio.
    expect(cnpjLegivel('123')).toBe('123');
  });

  it('0,5 kg sai "0,5 KG x", com vírgula — e não "0.5 x"', () => {
    const id = venda({
      itens: [{ descricao: 'Queijo', quantidade: 0.5, unitarioCents: 3_980, unidade: 'KG' }],
      pagamentos: [{ method: 'dinheiro', amountCents: 1_990 }],
    });
    const html = cupomHtml(id);
    expect(html).toContain(`0,5 KG x ${brl(3_980)}`);
    expect(html).not.toContain('0.5');

    expect(cupomTermico(id)).toContain('0,5 KG x 39,80');
  });
});
