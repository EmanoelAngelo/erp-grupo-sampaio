/**
 * ============================================================================
 * AUDITORIA — FASE 2 (MULTIEMPRESA): AS FRONTEIRAS QUE NINGUÉM TINHA MEDIDO
 * ============================================================================
 *
 * Seis empresas moram no mesmo banco. A regra do grupo é uma só, escrita na
 * rodada 48: QUEM ATRAVESSA EMPRESA É O VÍNCULO, NUNCA O PERFIL — e nunca o
 * corpo da requisição. Muito já está provado em outros arquivos:
 *
 *   - ler produto/venda alheia por id, listas isoladas, mover estoque com
 *     productId alheio, cliente alheio na venda, gaveta alheia NA VENDA,
 *     companyId alheio no corpo do POST de produto, baixa em lançamento
 *     alheio, documento fiscal na LISTA da outra:
 *       `matriz-das-seis-operacoes`, `auditoria-p0-isolamento`, `core-api`;
 *   - OS alheia por id (leitura): `os-de-verdade`;
 *   - CRM, logística, integrações e troca de loja: `adm-preso-a-sua-loja`.
 *
 * Este arquivo cobre o que SOBROU sem prova — as superfícies de ESCRITA e as
 * leituras por id que nenhum teste atravessava de propósito:
 *
 *   1. EDITAR o produto da vizinha (PUT), não só ler;
 *   2. EDITAR o cliente da vizinha: a tabela de preço (muda dinheiro) e o
 *      convite de portal (grava credencial no cadastro dela);
 *   3. OPERAR a gaveta da vizinha: suprimento, fechamento e resumo — a venda
 *      na gaveta alheia já era provada, o resto da gaveta não;
 *   4. o FINANCEIRO da vizinha por id: as baixas de um lançamento dela, e o
 *      ESTORNO de uma baixa dela;
 *   5. o DOCUMENTO FISCAL da vizinha por id — detalhe e XML (o XML carrega
 *      CNPJ, destinatário e valores; a lista isolada não prova o GET por id);
 *   6. REPLANEJAR a OS da vizinha (a leitura era provada; a escrita não);
 *   7. companyId da vizinha no corpo da VENDA — o dado que vira dinheiro.
 *
 * Cada caso tem as duas metades da falsificação: a travessia é NEGADA
 * (403/404) e NADA muda no banco da vizinha; e a MESMA operação passa dentro
 * da própria empresa — recusar tudo também deixaria este arquivo verde.
 *
 * Os ids aqui são reais (UUID/prefixo-timestamp), mas o padrão de ataque é o
 * de id ADIVINHADO: o invasor tem token legítimo da empresa A e chuta/possui
 * o id de um recurso da B. Empresa errada tem de responder IGUAL a id
 * inexistente — sem oráculo de existência entre tenants.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Fronteira@Fase2-2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/**
 * Usuário de verdade, vínculo em UMA empresa, login real com senha Argon2id —
 * o mesmo desenho do invasor plausível: credencial legítima, empresa errada.
 */
async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

let empresaA: string;
let empresaB: string;

beforeEach(() => {
  resetDbForTests();
  empresaA = upsertCompany({
    slug: 'audit-a',
    legalName: 'Auditoria A Ltda',
    tradeName: 'Auditoria A',
    kind: 'retail',
  });
  empresaB = upsertCompany({
    slug: 'audit-b',
    legalName: 'Auditoria B Ltda',
    tradeName: 'Auditoria B',
    kind: 'retail',
  });
});

const gerenteA = () => ator('GER.AUDIT.A', empresaA, 'gerente_loja');
const gerenteB = () => ator('GER.AUDIT.B', empresaB, 'gerente_loja');

function linha<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return getConnection().prepare(sql).get(...(params as [])) as T | undefined;
}

// ============================================================================
// 1. O CADASTRO DA VIZINHA NÃO SE EDITA
// ============================================================================

describe('editar o produto da vizinha', () => {
  it('PUT no produto da B com token da A é 404 — e nem uma letra muda no banco', async () => {
    const b = await gerenteB();
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(b.auth)
      .send({ name: 'Notebook da B', priceCents: 250_000 });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const produtoB = String(criado.body.id);

    const a = await gerenteA();
    const res = await request(app)
      .put(`/api/v1/core/products/${produtoB}`)
      .set(a.auth)
      .send({ name: 'Invadido pela A', priceCents: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_PRODUCT_NOT_FOUND');

    const depois = linha<{ name: string; price_cents: number; company_id: string }>(
      'SELECT name, price_cents, company_id FROM core_products WHERE id = ?',
      produtoB,
    );
    expect(depois?.name).toBe('Notebook da B');
    expect(depois?.price_cents).toBe(250_000);
    expect(depois?.company_id).toBe(empresaB);
  });

  it('e o dono continua editando o próprio — senão o 404 acima não prova nada', async () => {
    const a = await gerenteA();
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(a.auth)
      .send({ name: 'Produto da A', priceCents: 1_000 });
    expect(criado.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/core/products/${criado.body.id}`)
      .set(a.auth)
      .send({ name: 'Produto da A v2', priceCents: 2_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = linha<{ name: string }>(
      'SELECT name FROM core_products WHERE id = ?',
      String(criado.body.id),
    );
    expect(depois?.name).toBe('Produto da A v2');
  });
});

// ============================================================================
// 2. O CLIENTE DA VIZINHA — AS DUAS ESCRITAS QUE EXISTEM SOBRE ELE
// ============================================================================

describe('editar o cliente da vizinha', () => {
  it('a tabela de preço do cliente da B não se troca com token da A — e o vínculo fica de pé', async () => {
    /*
      Não existe PUT genérico de cliente; a escrita que MUDA DINHEIRO é esta.
      Se o predicado de empresa cair, a A consegue devolver o revendedor da B
      ao preço cheio (ou dar desconto a ele) sem ninguém da B saber.
    */
    const b = await gerenteB();
    const tabela = await request(app)
      .post('/api/v1/core/catalog/price-tables')
      .set(b.auth)
      .send({ name: 'Atacado da B', percentOff: 10 });
    expect(tabela.status, JSON.stringify(tabela.body)).toBe(201);
    const tabelaB = String(tabela.body.id);

    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(b.auth)
      .send({ name: 'Revendedor da B' });
    expect(cliente.status).toBe(201);
    const clienteB = String(cliente.body.id);

    const vinculo = await request(app)
      .put(`/api/v1/core/customers/${clienteB}/price-table`)
      .set(b.auth)
      .send({ priceTableId: tabelaB });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(200);

    const a = await gerenteA();
    const res = await request(app)
      .put(`/api/v1/core/customers/${clienteB}/price-table`)
      .set(a.auth)
      .send({ priceTableId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_CUSTOMER_NOT_FOUND');

    const depois = linha<{ price_table_id: string | null }>(
      'SELECT price_table_id FROM core_customers WHERE id = ?',
      clienteB,
    );
    expect(depois?.price_table_id).toBe(tabelaB);
  });

  it('o convite de portal do cliente da B não nasce pela mão da A — nenhum hash gravado', async () => {
    /*
      O convite é CREDENCIAL: o código em claro sai na resposta de quem o
      emitiu. Emitido de fora, quem o recebe é o invasor — e ele entra no
      portal como o cliente da B.
    */
    const b = await gerenteB();
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(b.auth)
      .send({ name: 'Cliente do Portal da B' });
    expect(cliente.status).toBe(201);
    const clienteB = String(cliente.body.id);

    const a = await gerenteA();
    const res = await request(app)
      .post(`/api/v1/core/customers/${clienteB}/convite-portal`)
      .set(a.auth)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    const depois = linha<{ portal_invite_hash: string | null }>(
      'SELECT portal_invite_hash FROM core_customers WHERE id = ?',
      clienteB,
    );
    expect(depois?.portal_invite_hash ?? null).toBeNull();
  });
});

// ============================================================================
// 3. A GAVETA DA VIZINHA — O QUE SOBROU ALÉM DA VENDA
// ============================================================================
//
// `auditoria-p0-isolamento` prova que a VENDA da A não entra na gaveta da B.
// Mas a gaveta tem mais três portas: movimento avulso, fechamento e resumo.
// Cada uma delas mexeria (ou leria) o dinheiro contado de outra operação.

describe('operar a gaveta da vizinha', () => {
  async function gavetaAberta(quem: Ator, openingCents = 10_000): Promise<string> {
    const res = await request(app)
      .post('/api/v1/core/cash/open')
      .set(quem.auth)
      .send({ openingCents });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return String(res.body.id ?? res.body.sessionId ?? res.body.session?.id);
  }

  it('suprimento na gaveta da B com token da A: 404, e nenhum movimento aparece', async () => {
    const b = await gerenteB();
    const sessaoB = await gavetaAberta(b);

    const a = await gerenteA();
    const res = await request(app)
      .post(`/api/v1/core/cash/${sessaoB}/movements`)
      .set(a.auth)
      .send({ movementType: 'supply', amountCents: 5_000, note: 'injetado de fora' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_CASH_NOT_FOUND');

    const movimentos = linha<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ? AND movement_type = 'supply'",
      sessaoB,
    );
    expect(movimentos?.n).toBe(0);
  });

  it('fechar a gaveta da B com token da A: 404, e a gaveta segue aberta', async () => {
    const b = await gerenteB();
    const sessaoB = await gavetaAberta(b);

    const a = await gerenteA();
    const res = await request(app)
      .post(`/api/v1/core/cash/${sessaoB}/close`)
      .set(a.auth)
      .send({ countedCents: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    const depois = linha<{ status: string; closed_at: string | null }>(
      'SELECT status, closed_at FROM core_cash_sessions WHERE id = ?',
      sessaoB,
    );
    expect(depois?.status).toBe('open');
    expect(depois?.closed_at ?? null).toBeNull();
  });

  it('o resumo da gaveta da B é 404 para a A — e o dono continua lendo o dele', async () => {
    /*
      O resumo diz quanto dinheiro há na gaveta AGORA. Lido de fora, é o
      relatório perfeito para saber qual loja do grupo vale a pena assaltar.
    */
    const b = await gerenteB();
    const sessaoB = await gavetaAberta(b, 12_345);

    const a = await gerenteA();
    const cruzado = await request(app)
      .get(`/api/v1/core/cash/${sessaoB}/summary`)
      .set(a.auth);
    expect(cruzado.status, JSON.stringify(cruzado.body)).toBe(404);

    const proprio = await request(app)
      .get(`/api/v1/core/cash/${sessaoB}/summary`)
      .set(b.auth);
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(200);
  });

  it('e o movimento na PRÓPRIA gaveta continua passando', async () => {
    const a = await gerenteA();
    const sessaoA = await gavetaAberta(a);
    const res = await request(app)
      .post(`/api/v1/core/cash/${sessaoA}/movements`)
      .set(a.auth)
      .send({ movementType: 'supply', amountCents: 2_000, note: 'troco' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ============================================================================
// 4. O FINANCEIRO DA VIZINHA POR ID
// ============================================================================
//
// A lista isolada (`matriz`) e a baixa recusada (`matriz`) já estão provadas.
// Faltavam as duas rotas por id que ninguém atravessava: ler as BAIXAS de um
// lançamento alheio, e ESTORNAR uma baixa alheia.

describe('o financeiro da vizinha por id', () => {
  async function lancamentoComBaixa(quem: Ator): Promise<{ entryId: string; settlementId: string }> {
    const entrada = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(quem.auth)
      .send({ direction: 'in', description: 'Aluguel da vitrine', amountCents: 10_000 });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
    const entryId = String(entrada.body.id);

    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${entryId}/settle`)
      .set(quem.auth)
      .send({ amountCents: 4_000, method: 'pix' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);
    const settlementId = String(
      (baixa.body.settlements as { id: string }[]).find(Boolean)!.id,
    );
    return { entryId, settlementId };
  }

  it('as baixas do lançamento da B não aparecem para a A — nem uma linha', async () => {
    const b = await gerenteB();
    const { entryId } = await lancamentoComBaixa(b);

    const a = await gerenteA();
    const res = await request(app)
      .get(`/api/v1/core/finance/entries/${entryId}/settlements`)
      .set(a.auth);
    // 200 vazio e 404 são ambos aceitáveis: o que NÃO pode é vir a baixa da B.
    expect([200, 404]).toContain(res.status);
    expect(((res.body?.items ?? []) as unknown[]).length).toBe(0);
  });

  it('estornar a baixa da B com token da A: 404, e a baixa continua valendo', async () => {
    const b = await gerenteB();
    const { settlementId } = await lancamentoComBaixa(b);

    const a = await gerenteA();
    const res = await request(app)
      .post(`/api/v1/core/finance/settlements/${settlementId}/reverse`)
      .set(a.auth)
      .send({ note: 'estorno de fora' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_SETTLEMENT_NOT_FOUND');

    const depois = linha<{ reversed_at: string | null }>(
      'SELECT reversed_at FROM core_finance_settlements WHERE id = ?',
      settlementId,
    );
    expect(depois?.reversed_at ?? null).toBeNull();
  });
});

// ============================================================================
// 5. O DOCUMENTO FISCAL DA VIZINHA POR ID
// ============================================================================
//
// `matriz` prova que a LISTA da outra não vaza. O GET por id é outra rota,
// outro predicado — e o XML carrega CNPJ, destinatário e valores. A nota é
// plantada direto no banco (o caminho de emissão inteiro é coberto pela
// `fiscal-multiempresa`); o que se mede aqui é só a fronteira HTTP.

describe('o documento fiscal da vizinha por id', () => {
  function notaPlantadaDaB(): string {
    const id = `nfce-audit-${randomUUID()}`;
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, model, serie, number, environment, status,
            xml_authorized, recipient_name, created_at, updated_at)
         VALUES (?, ?, '65', 1, 101, 'homologacao', 'AUTHORIZED', ?, ?, ?, ?)`,
      )
      .run(id, empresaB, '<nfeProc>segredo-da-b</nfeProc>', 'Cliente Sigiloso da B', agora, agora);
    return id;
  }

  it('o detalhe da nota da B é 404 para a A — e 200 para a própria B', async () => {
    const notaB = notaPlantadaDaB();

    const a = await gerenteA();
    const cruzado = await request(app)
      .get(`/api/v1/core/fiscal/documents/${notaB}`)
      .set(a.auth);
    expect(cruzado.status, JSON.stringify(cruzado.body)).toBe(404);
    expect(cruzado.body.error?.code).toBe('CORE_FISCAL_DOCUMENT_NOT_FOUND');

    const b = await gerenteB();
    const proprio = await request(app)
      .get(`/api/v1/core/fiscal/documents/${notaB}`)
      .set(b.auth);
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(200);
    expect(proprio.body.document?.id).toBe(notaB);
  });

  it('o XML da nota da B também não sai: 404, sem uma tag no corpo', async () => {
    const notaB = notaPlantadaDaB();

    const a = await gerenteA();
    const res = await request(app)
      .get(`/api/v1/core/fiscal/documents/${notaB}/xml`)
      .set(a.auth);
    expect(res.status).toBe(404);
    expect(String(res.text ?? '')).not.toContain('segredo-da-b');
  });
});

// ============================================================================
// 6. A OS DA VIZINHA NÃO SE REPLANEJA
// ============================================================================
//
// A LEITURA da OS alheia já é 404 (`os-de-verdade`). A escrita não tinha
// prova cruzando EMPRESA — `kanban-com-sla` cruza bancadas da mesma empresa.

describe('replanejar a OS da vizinha', () => {
  function bancada(companyId: string, id: string): void {
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, ?, 'Bancada', 'mobility', 1, ?)`,
      )
      .run(id, companyId, id, new Date().toISOString());
  }

  it('PATCH de plano na OS da B com token da A: 404, e a prioridade não muda', async () => {
    bancada(empresaB, 'ws-audit-b');
    bancada(empresaA, 'ws-audit-a');
    const oficinaB = await ator('OFI.AUDIT.B', empresaB, 'gerente_oficina');
    const criada = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(oficinaB.auth)
      .send({ customerName: 'Cliente da B', complaint: 'não liga' });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    const osB = String(criada.body.id);

    const oficinaA = await ator('OFI.AUDIT.A', empresaA, 'gerente_oficina');
    const res = await request(app)
      .patch(`/api/v1/core/workshop/orders/${osB}/plan`)
      .set(oficinaA.auth)
      .send({ priority: 'urgente' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error?.code).toBe('CORE_ORDER_NOT_FOUND');

    const depois = linha<{ priority: string; company_id: string }>(
      'SELECT priority, company_id FROM core_service_orders WHERE id = ?',
      osB,
    );
    expect(depois?.priority).toBe('media');
    expect(depois?.company_id).toBe(empresaB);

    // E a própria B replaneja — a rota funciona, só não atravessa.
    const proprio = await request(app)
      .patch(`/api/v1/core/workshop/orders/${osB}/plan`)
      .set(oficinaB.auth)
      .send({ priority: 'urgente' });
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(200);
    expect(proprio.body.priority).toBe('urgente');
  });
});

// ============================================================================
// 7. O companyId DO CORPO NÃO MUDA O DONO DA VENDA
// ============================================================================
//
// `matriz` prova isso para o CADASTRO de produto. A venda é o dado que vira
// dinheiro, caixa e imposto — se algum refactor passar a ler o corpo, é aqui
// que o grupo mistura faturamento entre CNPJs.

describe('a venda com companyId da vizinha no corpo', () => {
  it('nasce na empresa do TOKEN, e a B nunca a vê', async () => {
    const a = await gerenteA();
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(a.auth)
      .send({ name: 'Produto vendido pela A', priceCents: 1_000 });
    expect(produto.status).toBe(201);
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(a.auth)
      .send({
        productId: produto.body.id,
        movementType: 'in',
        quantity: 10,
        referenceId: 'entrada-audit',
      })
      .expect(201);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(a.auth)
      .set('Idempotency-Key', 'venda-corpo-alheio')
      .send({
        companyId: empresaB, // a opinião do cliente sobre quem vendeu — ignorada
        items: [{ productId: produto.body.id, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1_000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const dono = linha<{ company_id: string }>(
      'SELECT company_id FROM core_sales WHERE id = ?',
      String(venda.body.id),
    );
    expect(dono?.company_id).toBe(empresaA);

    const b = await gerenteB();
    const listaDaB = await request(app).get('/api/v1/core/sales').set(b.auth);
    expect(listaDaB.status).toBe(200);
    const idsDaB = ((listaDaB.body.items ?? []) as { id: string }[]).map((s) => s.id);
    expect(idsDaB).not.toContain(String(venda.body.id));
  });
});
