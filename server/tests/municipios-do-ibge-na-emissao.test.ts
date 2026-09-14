/**
 * ============================================================================
 * A NOTA CONFERE O MUNICÍPIO NA TABELA ANTES DE NUMERAR (R3-IBGE, GAP-PRD-028)
 * ============================================================================
 *
 * O IBGE-MUNICIPIOS fez valer a tabela oficial ao SALVAR o endereço e no
 * FECHAMENTO do pedido. Ficaram de fora os dois lugares onde o código errado
 * custa mais caro — a EMISSÃO:
 *
 *   1. o pedido fechado ANTES de a tabela ser carregada guarda no retrato o
 *      código que o cliente digitou (só o formato era conferido). A prontidão
 *      da nota dizia "pode emitir", a emissão numerava e transmitia, e a
 *      recusa vinha da SEFAZ DEPOIS de o número ser consumido — número
 *      queimado, inutilização. E, sem caminho para corrigir o retrato, o
 *      pedido não se faturava nunca;
 *   2. o emitente aceitava qualquer código de 7 dígitos. Um cMun errado no
 *      emitente faz TODA nota ser recusada (NF-e, NFC-e, NFS-e).
 *
 * Com a tabela carregada:
 *   - a prontidão da nota do pedido aponta o código, diz onde corrigir e
 *     sugere a cidade pelo nome do retrato; a emissão recusa SEM numerar; a
 *     rota de correção troca o município do retrato (só o que não confere, só
 *     antes da nota, só por um município da UF do endereço);
 *   - a NF-e de venda (destinatário informado) recusa sem numerar;
 *   - o cadastro do emitente confere código × UF × nome da cidade (422);
 *   - o checklist fiscal (e com ele o portão de montagem de NF-e e NFC-e), a
 *     prontidão da NFS-e e a conferência da implantação apontam o emitente
 *     cujo código não bate.
 * Sem a tabela, a regra de hoje: o formato basta.
 *
 * FIXTURE: os municípios abaixo são uma AMOSTRA DE TESTE declarada, não a
 * lista oficial do IBGE. "4399999" tem o prefixo do RS e não é município
 * nenhum — é o código digitado errado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import {
  assertCanEmit,
  buildReadiness,
  updateFiscalConfig,
} from '../src/services/core/FiscalConfigService.js';
import { getSeries, setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { createNfeForSale } from '../src/services/core/FiscalDocumentService.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import {
  createNfeForOrder,
  orderInvoiceReadiness,
} from '../src/services/core/OrderInvoiceService.js';
import { gravarMunicipios } from '../src/services/core/MunicipiosIbge.js';
import { prontidaoDaNfse, updateNfseConfig } from '../src/services/core/NfseService.js';
import {
  conferirImplantacao,
  contextoDoProcesso,
} from '../src/services/implantacao/conferenciaDaImplantacao.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Teste@MunicipioNaNota2026';
const EMAIL = 'joana@exemplo.com';

/** FIXTURE DE TESTE — amostra, não a lista oficial do IBGE. */
const AMOSTRA = [
  { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
  { codigo: '4314902', nome: 'Porto Alegre', uf: 'RS' },
  { codigo: '4317103', nome: "Sant'Ana do Livramento", uf: 'RS' },
  { codigo: '3550308', nome: 'São Paulo', uf: 'SP' },
];

/** O código digitado errado: prefixo do RS, município nenhum. */
const CODIGO_ERRADO = '4399999';

const EMITENTE = {
  legalName: 'Gringa Comércio Ltda',
  cnpj: '11.222.333/0001-81',
  ie: '123456789',
  crt: '1',
  street: 'Av. Central',
  number: '100',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  zip: '96010000',
  uf: 'RS',
};

let companyId: string;
let gestor: { Authorization: string };
let n = 0;

function agora(): string {
  return new Date().toISOString();
}

function carregarTabela(): void {
  gravarMunicipios(AMOSTRA);
}

function proximoNumero(model = '55'): number {
  return getSeries(companyId, model).find((s) => s.serie === 1)!.nextNumber;
}

function documentos(): number {
  return Number(
    (getConnection().prepare('SELECT COUNT(*) AS c FROM core_fiscal_documents').get() as { c: number }).c,
  );
}

/**
 * Pedido pago com o RETRATO do endereço de faturamento em colunas — como o
 * checkout grava desde o GAP-PRD-115. `ibge` é o código que o cliente digitou
 * quando a tabela ainda não existia.
 */
function pedidoComRetrato(opcoes: { ibge?: string; cidade?: string; uf?: string; lado?: 'billing' | 'shipping' } = {}): string {
  ensureCoreSchema();
  n += 1;
  const db = getConnection();
  const id = `pedido-ibge-${n}`;
  const produto = `prod-ibge-${n}`;
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Online', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(produto, companyId, `IBGE-${n}`, agora(), agora());
  const lado = opcoes.lado ?? 'billing';
  const ibge = opcoes.ibge ?? CODIGO_ERRADO;
  const cidade = opcoes.cidade ?? 'Pelotas';
  const uf = opcoes.uf ?? 'RS';
  const retrato =
    lado === 'billing'
      ? {
          billing_name: 'Joana Compradora', billing_zip: '96010000', billing_street: 'Rua XV de Novembro',
          billing_number: '500', billing_district: 'Centro', billing_city: cidade, billing_state: uf,
          billing_city_ibge: ibge,
        }
      : {
          shipping_street: 'Rua XV de Novembro', shipping_number: '500', shipping_district: 'Centro',
          shipping_city: cidade, shipping_state: uf, shipping_city_ibge: ibge,
        };
  const colunas = Object.keys(retrato);
  db.prepare(
    `INSERT INTO core_orders
       (id, company_id, number, customer_name, customer_email, customer_document,
        shipping_zip, shipping_address, shipping_method, shipping_cents,
        items_cents, total_cents, status, payment_method, idempotency_key, created_at, updated_at,
        ${colunas.join(', ')})
     VALUES (?, ?, ?, 'Joana Compradora', ?, '11144477735', '96010000', 'Rua XV de Novembro, 500',
             'retirada', 0, 10000, 10000, 'pago', 'pix', ?, ?, ?, ${colunas.map(() => '?').join(', ')})`,
  ).run(id, companyId, 1000 + n, EMAIL, `k-${id}`, agora(), agora(), ...Object.values(retrato));
  db.prepare(
    `INSERT INTO core_order_items (id, order_id, company_id, product_id, description,
                                   quantity, unit_price_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Online', 2, 5000, 10000)`,
  ).run(`oi-${id}`, id, companyId, produto);
  return id;
}

/** Pedido anterior ao retrato: o destinatário sai do endereço da conta. */
function pedidoSemRetratoComConta(ibge: string): string {
  const db = getConnection();
  const conta = randomUUID();
  db.prepare(
    `INSERT INTO core_customer_accounts (id, email, password_hash, active, created_at, updated_at)
     VALUES (?, ?, 'x', 1, ?, ?)`,
  ).run(conta, EMAIL, agora(), agora());
  db.prepare(
    `INSERT INTO core_customer_addresses
       (id, account_id, label, zip, street, number, complement, district, city, state,
        city_ibge, is_default, created_at, updated_at)
     VALUES (?, ?, 'Casa', '96010000', 'Rua XV de Novembro', '500', NULL, 'Centro', 'Pelotas', 'RS', ?, 1, ?, ?)`,
  ).run(randomUUID(), conta, ibge, agora(), agora());
  const id = pedidoComRetrato({ ibge: '' });
  // Sem retrato nenhum: o pedido é de antes do GAP-PRD-115.
  db.prepare(
    `UPDATE core_orders SET billing_name = NULL, billing_zip = NULL, billing_street = NULL, billing_number = NULL,
            billing_district = NULL, billing_city = NULL, billing_state = NULL, billing_city_ibge = NULL
      WHERE id = ?`,
  ).run(id);
  return id;
}

/**
 * Os motivos da prontidão que falam do MUNICÍPIO. O fixture não tem
 * certificado A1, então a prontidão sempre traz os dois itens do certificado
 * — que não são assunto deste arquivo.
 */
function doMunicipio(r: { reasons: string[] }): string[] {
  return r.reasons.filter((m) => /IBGE|cMun|munic/i.test(m));
}

function corrigir(pedido: string, corpo: Record<string, unknown>) {
  return request(app).post(`/api/v1/core/orders/${pedido}/nfe/municipio`).set(gestor).send(corpo);
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  updateFiscalConfig({ companyId, patch: EMITENTE });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });

  const userId = await upsertUser({ login: 'GESTOR-IBGE', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'GESTOR-IBGE', password: SENHA });
  gestor = { Authorization: `Bearer ${res.body.accessToken}` };
});

// ============================================================================

describe('o pedido fechado antes da tabela: a nota confere o município antes de numerar', () => {
  it('SEM a tabela, a regra de hoje: o formato basta, a prontidão libera e a nota sai', () => {
    const pedido = pedidoComRetrato();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(doMunicipio(r)).toEqual([]);
    const { document } = createNfeForOrder({ companyId, orderId: pedido });
    expect(document.number).toBe(1);
    expect(proximoNumero()).toBe(2);
  });

  it('com a tabela, a prontidão aponta o código, diz onde corrigir e sugere a cidade pelo nome', () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    const motivos = r.reasons.join(' | ');
    expect(motivos).toContain(CODIGO_ERRADO);
    expect(motivos).toContain('RS');
    expect(motivos).toContain('Nota fiscal do pedido');
    expect(r).toMatchObject({
      municipio: {
        lado: 'faturamento',
        uf: 'RS',
        cidade: 'Pelotas',
        codigo: CODIGO_ERRADO,
        sugestao: { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
      },
    });
  });

  it('com a tabela, a emissão recusa SEM numerar: nenhum documento, a numeração não anda', () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    let erro: { code?: string; message?: string } = {};
    try {
      createNfeForOrder({ companyId, orderId: pedido });
    } catch (e) {
      erro = e as typeof erro;
    }
    expect(erro.code).toBe('CORE_FISCAL_DOCUMENT_INVALID');
    expect(erro.message).toContain('dest.cMun');
    expect(erro.message).toContain(CODIGO_ERRADO);
    expect(documentos()).toBe(0);
    expect(proximoNumero()).toBe(1);
  });

  it('pela rota de emissão também: 409 e a numeração parada', async () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    const res = await request(app).post(`/api/v1/core/orders/${pedido}/nfe`).set(gestor).send({ developmentMode: true });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toContain(CODIGO_ERRADO);
    expect(proximoNumero()).toBe(1);
  });

  it('código de OUTRA UF no retrato: a prontidão diz de que cidade ele é', () => {
    const pedido = pedidoComRetrato({ ibge: '3550308' });
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r.reasons.join(' ')).toContain('São Paulo (SP)');
  });

  it('o retrato da ENTREGA (sem faturamento) também é conferido', () => {
    const pedido = pedidoComRetrato({ lado: 'shipping' });
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r).toMatchObject({ municipio: { lado: 'entrega', codigo: CODIGO_ERRADO } });
    expect(() => createNfeForOrder({ companyId, orderId: pedido })).toThrow(/dest\.cMun/);
    expect(proximoNumero()).toBe(1);
  });

  it('pedido de antes do retrato (endereço da conta) também é conferido', () => {
    const pedido = pedidoSemRetratoComConta(CODIGO_ERRADO);
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r).toMatchObject({ municipio: { lado: 'cadastro', codigo: CODIGO_ERRADO } });
    expect(() => createNfeForOrder({ companyId, orderId: pedido })).toThrow(/dest\.cMun/);
    expect(proximoNumero()).toBe(1);
  });

  it('com o código certo no retrato, a tabela não atrapalha', () => {
    const pedido = pedidoComRetrato({ ibge: '4314407' });
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(doMunicipio(r)).toEqual([]);
    expect(r).toMatchObject({ municipio: null });
  });
});

describe('o caminho para corrigir: o gestor troca o município do retrato, na nota do pedido', () => {
  it('escolhido um município da UF, o retrato muda, a prontidão libera e a nota sai com o código certo', async () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    const res = await corrigir(pedido, { cityIbge: '4314407' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.municipio).toBeNull();
    expect(doMunicipio(res.body)).toEqual([]);
    const linha = getConnection()
      .prepare('SELECT billing_city, billing_city_ibge, billing_state FROM core_orders WHERE id = ?')
      .get(pedido) as Record<string, string>;
    expect(linha).toEqual({ billing_city: 'Pelotas', billing_city_ibge: '4314407', billing_state: 'RS' });
    // O histórico do pedido diz o que mudou e quem mudou.
    const evento = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(pedido) as { note: string };
    expect(evento.note).toContain(CODIGO_ERRADO);
    expect(evento.note).toContain('4314407');

    const { document } = createNfeForOrder({ companyId, orderId: pedido });
    const xml = (getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_original: string }).xml_original;
    expect(xml).toContain('<cMun>4314407</cMun>');
    expect(xml).not.toContain(CODIGO_ERRADO);
  });

  it('o retrato da entrega é corrigido na entrega', async () => {
    const pedido = pedidoComRetrato({ lado: 'shipping' });
    carregarTabela();
    expect((await corrigir(pedido, { cityIbge: '4314407' })).status).toBe(200);
    const linha = getConnection()
      .prepare('SELECT shipping_city_ibge, billing_city_ibge FROM core_orders WHERE id = ?')
      .get(pedido) as Record<string, string | null>;
    expect(linha).toEqual({ shipping_city_ibge: '4314407', billing_city_ibge: null });
  });

  it('pedido de antes do retrato: a correção grava o retrato do faturamento a partir do endereço da conta', async () => {
    const pedido = pedidoSemRetratoComConta(CODIGO_ERRADO);
    carregarTabela();
    const res = await corrigir(pedido, { cityIbge: '4314407' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.municipio).toBeNull();
    const linha = getConnection()
      .prepare('SELECT billing_street, billing_city, billing_city_ibge FROM core_orders WHERE id = ?')
      .get(pedido) as Record<string, string>;
    expect(linha).toEqual({ billing_street: 'Rua XV de Novembro', billing_city: 'Pelotas', billing_city_ibge: '4314407' });
  });

  it('recusa município de outra UF (422), código que não existe (422) e formato errado (400)', async () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    const outraUf = await corrigir(pedido, { cityIbge: '3550308' });
    expect(outraUf.status).toBe(422);
    expect(outraUf.body.error.message).toContain('São Paulo (SP)');
    expect((await corrigir(pedido, { cityIbge: '4399998' })).status).toBe(422);
    expect((await corrigir(pedido, { cityIbge: '43' })).status).toBe(400);
    const linha = getConnection().prepare('SELECT billing_city_ibge FROM core_orders WHERE id = ?').get(pedido) as {
      billing_city_ibge: string;
    };
    expect(linha.billing_city_ibge).toBe(CODIGO_ERRADO);
  });

  it('sem a tabela não há o que conferir (409); município que já confere não se troca (409)', async () => {
    const pedido = pedidoComRetrato();
    const semTabela = await corrigir(pedido, { cityIbge: '4314407' });
    expect(semTabela.status).toBe(409);
    carregarTabela();
    const certo = pedidoComRetrato({ ibge: '4314407' });
    const jaConfere = await corrigir(certo, { cityIbge: '4314902' });
    expect(jaConfere.status).toBe(409);
  });

  it('depois da nota, o retrato não muda (409)', async () => {
    const pedido = pedidoComRetrato({ ibge: '4314407' });
    createNfeForOrder({ companyId, orderId: pedido });
    carregarTabela();
    getConnection().prepare('UPDATE core_orders SET billing_city_ibge = ? WHERE id = ?').run(CODIGO_ERRADO, pedido);
    expect((await corrigir(pedido, { cityIbge: '4314407' })).status).toBe(409);
  });

  it('é da gerência: sem sessão, 401', async () => {
    const pedido = pedidoComRetrato();
    const res = await request(app).post(`/api/v1/core/orders/${pedido}/nfe/municipio`).send({ cityIbge: '4314407' });
    expect(res.status).toBe(401);
  });
});

describe('a NF-e de venda (destinatário informado) confere o município antes de numerar', () => {
  function venda(): string {
    const db = getConnection();
    const id = `venda-ibge-${++n}`;
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
    ).run(`p-${id}`, companyId, `V-${n}`, agora(), agora());
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
       VALUES (?, ?, ?, 'completed', 100000, 0, 0, 100000, 'pdv', ?, 0, ?)`,
    ).run(id, companyId, n, `k-${id}`, agora());
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, 'Patinete', 1, 100000, 0, 100000)`,
    ).run(`i-${id}`, id, companyId, `p-${id}`);
    db.prepare(
      `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
       VALUES (?, ?, ?, 'pix', 100000, 'settled', ?)`,
    ).run(`pay-${id}`, id, companyId, agora());
    return id;
  }
  const DEST: NfeRecipient = {
    document: '11.444.777/0001-61',
    name: 'Comprador Atacado Ltda',
    ieIndicator: '1',
    ie: '987654321',
    street: 'Rua do Comércio',
    number: '500',
    district: 'Industrial',
    cityName: 'Pelotas',
    cityIbge: CODIGO_ERRADO,
    uf: 'RS',
    zip: '96010100',
  };

  it('com a tabela, destinatário com código que não é município da UF: recusa sem numerar', () => {
    carregarTabela();
    expect(() => createNfeForSale({ companyId, saleId: venda(), recipient: DEST })).toThrow(/dest\.cMun.*4399999/);
    expect(documentos()).toBe(0);
    expect(proximoNumero()).toBe(1);
  });

  it('sem a tabela, a regra de hoje', () => {
    const { document } = createNfeForSale({ companyId, saleId: venda(), recipient: DEST });
    expect(document.number).toBe(1);
  });
});

// ============================================================================

describe('o emitente confere código × UF × nome da cidade na tabela', () => {
  function salvar(patch: Record<string, unknown>) {
    return request(app).patch('/api/v1/core/fiscal/config').set(gestor).send(patch);
  }

  it('SEM a tabela, a regra de hoje: qualquer código de 7 dígitos é gravado', async () => {
    const res = await salvar({ cityIbge: CODIGO_ERRADO });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cityIbge).toBe(CODIGO_ERRADO);
  });

  it('com a tabela, código de OUTRA UF é 422 e diz de que cidade ele é — nada é gravado', async () => {
    carregarTabela();
    const res = await salvar({ cityIbge: '3550308', cityName: 'Pelotas', uf: 'RS' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CORE_FISCAL_IBGE_NAO_CONFERE');
    expect(res.body.error.message).toContain('São Paulo (SP)');
    expect(res.body.error.message).toContain('Fiscal › Emitente');
    expect(buildReadiness(companyId, '55').items.find((i) => i.key === 'ibge')!.known).toBe('4314407');
  });

  it('com a tabela, código que não é município nenhum é 422', async () => {
    carregarTabela();
    const res = await salvar({ cityIbge: CODIGO_ERRADO });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain(CODIGO_ERRADO);
  });

  it('com a tabela, código de outra cidade da mesma UF é 422 e nomeia as duas', async () => {
    carregarTabela();
    const res = await salvar({ cityIbge: '4314902', cityName: 'Pelotas', uf: 'RS' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Porto Alegre');
    expect(res.body.error.message).toContain('Pelotas');
  });

  it('trocar só a UF deixa o código de outra UF: 422', async () => {
    carregarTabela();
    const res = await salvar({ uf: 'SP' });
    expect(res.status).toBe(422);
  });

  it('com a tabela, o certo passa — o nome sem acento, sem caixa e sem apóstrofo também', async () => {
    carregarTabela();
    expect((await salvar({ cityIbge: '4314902', cityName: 'Porto Alegre', uf: 'RS' })).status).toBe(200);
    const semAcento = await salvar({ cityIbge: '4317103', cityName: 'SANTANA DO LIVRAMENTO', uf: 'rs' });
    expect(semAcento.status, JSON.stringify(semAcento.body)).toBe(200);
  });

  it('com a tabela, o que não mexe no município não é conferido de novo', async () => {
    // O emitente de antes da tabela, gravado com o código errado.
    updateFiscalConfig({ companyId, patch: { cityIbge: CODIGO_ERRADO } });
    carregarTabela();
    expect((await salvar({ phone: '5332220000' })).status).toBe(200);
  });
});

describe('o emitente de antes da tabela com código errado: o checklist aponta e a montagem não numera', () => {
  beforeEach(() => {
    updateFiscalConfig({ companyId, patch: { cityIbge: CODIGO_ERRADO } });
  });

  it('sem a tabela, o checklist diz o que diz hoje (o formato)', () => {
    const item = buildReadiness(companyId, '55').items.find((i) => i.key === 'ibge')!;
    expect(item.status).toBe('PASS');
  });

  it('com a tabela, o item do código IBGE é FAIL, DIVERGENTE, com o motivo e onde corrigir', () => {
    carregarTabela();
    for (const modelo of ['55', '65']) {
      const item = buildReadiness(companyId, modelo).items.find((i) => i.key === 'ibge')!;
      expect(item.status).toBe('FAIL');
      expect(item.state).toBe('DIVERGENTE');
      expect(item.detail).toContain(CODIGO_ERRADO);
      expect(item.detail).toContain('Fiscal › Emitente');
    }
  });

  it('com a tabela, a cidade que não bate com o código também é apontada', () => {
    updateFiscalConfig({ companyId, patch: { cityIbge: '4314902' } });
    carregarTabela();
    const item = buildReadiness(companyId, '55').items.find((i) => i.key === 'ibge')!;
    expect(item.status).toBe('FAIL');
    expect(item.detail).toContain('Porto Alegre');
  });

  it('com a tabela, a montagem (NF-e e NFC-e) recusa antes de numerar', () => {
    carregarTabela();
    expect(() => assertCanEmit(companyId, '55', 'document')).toThrow(/IBGE/);
    expect(() => assertCanEmit(companyId, '65', 'document')).toThrow(/IBGE/);
    const pedido = pedidoComRetrato({ ibge: '4314407' });
    expect(() => createNfeForOrder({ companyId, orderId: pedido })).toThrow(/4399999/);
    expect(proximoNumero()).toBe(1);
  });

  it('com a tabela, a prontidão da NFS-e aponta o prestador', () => {
    updateNfseConfig({
      companyId,
      userId: 'gestor-ibge',
      patch: {
        mode: 'EMISSOR_NACIONAL',
        serviceCode: '140101',
        simplesOption: '3',
        simplesRegime: '1',
        issRate: '2.00',
        municipalityConfirmed: true,
      },
    });
    const antes = prontidaoDaNfse(companyId).items.find((i) => i.key === 'nfse_emitente')!;
    expect(antes.status).toBe('OK');
    carregarTabela();
    const depois = prontidaoDaNfse(companyId).items.find((i) => i.key === 'nfse_emitente')!;
    expect(depois.status).toBe('FAIL');
    expect(depois.detail).toContain(CODIGO_ERRADO);
  });

  it('a conferência da implantação aponta o emitente (pela conexão da API), sem bloquear a subida', () => {
    const semTabela = conferirImplantacao(contextoDoProcesso({ protocolo: 'https' }));
    expect(semTabela.itens.find((i) => i.id === 'municipio_do_emitente')).toBeUndefined();
    carregarTabela();
    const r = conferirImplantacao(contextoDoProcesso({ protocolo: 'https' }));
    const item = r.itens.find((i) => i.id === 'municipio_do_emitente');
    expect(item).toMatchObject({ estado: 'ATENCAO' });
    expect(item!.detalhe).toContain(CODIGO_ERRADO);
    expect(item!.detalhe).toContain('Gringa Comércio Ltda');
    expect(item!.comoResolver).toContain('Fiscal › Emitente');
  });

  it('com o emitente certo, a conferência diz OK', () => {
    updateFiscalConfig({ companyId, patch: { cityIbge: '4314407' } });
    carregarTabela();
    const r = conferirImplantacao(contextoDoProcesso({ protocolo: 'https' }));
    expect(r.itens.find((i) => i.id === 'municipio_do_emitente')).toMatchObject({ estado: 'OK' });
  });
});

// ============================================================================
// VERIFICAÇÃO ADVERSARIAL DO R3-IBGE — três furos que o conserto deixou.
// ============================================================================

describe('verificação: o emitente escrito com a UF no fim ("Pelotas - RS") é a mesma cidade', () => {
  function salvar(patch: Record<string, unknown>) {
    return request(app).patch('/api/v1/core/fiscal/config').set(gestor).send(patch);
  }

  it('o cadastro aceita a cidade com a UF do próprio cadastro no fim — o código é o dela', async () => {
    carregarTabela();
    for (const cidade of ['Pelotas - RS', 'Pelotas/RS', 'Pelotas (RS)', 'PELOTAS-RS', 'Pelotas, RS']) {
      const res = await salvar({ cityIbge: '4314407', cityName: cidade, uf: 'RS' });
      expect(res.status, `${cidade}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it('o emitente de antes da tabela gravado "Pelotas - RS" não trava a NF-e nem a NFC-e', () => {
    updateFiscalConfig({ companyId, patch: { cityName: 'Pelotas - RS' } });
    carregarTabela();
    for (const modelo of ['55', '65']) {
      expect(buildReadiness(companyId, modelo).items.find((i) => i.key === 'ibge')!.status).toBe('PASS');
    }
    expect(() => assertCanEmit(companyId, '65', 'document')).not.toThrow();
  });

  it('a UF de OUTRO estado no fim, ou outra cidade com a UF certa, continuam recusadas', async () => {
    carregarTabela();
    expect((await salvar({ cityIbge: '4314407', cityName: 'Pelotas - SP', uf: 'RS' })).status).toBe(422);
    expect((await salvar({ cityIbge: '4314407', cityName: 'Porto Alegre - RS', uf: 'RS' })).status).toBe(422);
  });
});

describe('verificação: o destinatário com código de OUTRA cidade da mesma UF', () => {
  it('retrato "Pelotas" com o código de Porto Alegre: a prontidão aponta e a emissão recusa sem numerar', () => {
    const pedido = pedidoComRetrato({ ibge: '4314902', cidade: 'Pelotas' });
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r.canEmit).toBe(false);
    expect(r).toMatchObject({
      municipio: { codigo: '4314902', cidade: 'Pelotas', sugestao: { codigo: '4314407', nome: 'Pelotas' } },
    });
    expect(r.reasons.join(' ')).toContain('Porto Alegre');
    expect(() => createNfeForOrder({ companyId, orderId: pedido })).toThrow(/dest\.cMun.*4314902/);
    expect(documentos()).toBe(0);
    expect(proximoNumero()).toBe(1);
  });

  it('e a ficha corrige: o código de Pelotas entra, e a nota sai com ele', async () => {
    const pedido = pedidoComRetrato({ ibge: '4314902', cidade: 'Pelotas' });
    carregarTabela();
    const res = await corrigir(pedido, { cityIbge: '4314407' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.municipio).toBeNull();
    const { document } = createNfeForOrder({ companyId, orderId: pedido });
    expect(document.number).toBe(1);
  });

  it('nome que não é o de nenhuma outra cidade da UF (abreviado, com a UF no fim) não trava', () => {
    carregarTabela();
    for (const cidade of ['POA', 'Porto Alegre - RS', 'Porto Alegre/RS']) {
      const pedido = pedidoComRetrato({ ibge: '4314902', cidade });
      const r = orderInvoiceReadiness(companyId, pedido);
      expect(r, cidade).toMatchObject({ municipio: null });
      expect(doMunicipio(r), cidade).toEqual([]);
    }
  });

  it('a NF-e de venda também: destinatário "Pelotas" com o código de Porto Alegre recusa sem numerar', () => {
    carregarTabela();
    const db = getConnection();
    const id = 'venda-ibge-outra-cidade';
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, 'V-OC', 'Patinete', 'UN', 50000, 100000, '87116000', '5102', '0', 1, ?, ?)`,
    ).run(`p-${id}`, companyId, agora(), agora());
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
       VALUES (?, ?, 77, 'completed', 100000, 0, 0, 100000, 'pdv', ?, 0, ?)`,
    ).run(id, companyId, `k-${id}`, agora());
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, 'Patinete', 1, 100000, 0, 100000)`,
    ).run(`i-${id}`, id, companyId, `p-${id}`);
    db.prepare(
      `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
       VALUES (?, ?, ?, 'pix', 100000, 'settled', ?)`,
    ).run(`pay-${id}`, id, companyId, agora());
    const dest: NfeRecipient = {
      document: '11.444.777/0001-61', name: 'Comprador Atacado Ltda', ieIndicator: '1', ie: '987654321',
      street: 'Rua do Comércio', number: '500', district: 'Industrial', cityName: 'Pelotas',
      cityIbge: '4314902', uf: 'RS', zip: '96010100',
    };
    expect(() => createNfeForSale({ companyId, saleId: id, recipient: dest })).toThrow(/dest\.cMun.*4314902/);
    expect(proximoNumero()).toBe(1);
  });
});

describe('verificação: o retrato do banco da 84 com a UF errada e o código certo', () => {
  /*
    No banco da 84, o endereço da conta guardava city_ibge conferindo só os 7
    dígitos (a UF só tinha de ter 2 letras), e o fechamento sem a tabela copia
    esse código para o retrato. Cliente de Pelotas que marcou SC: retrato
    "Pelotas / SC / 4314407". A correção só aceitava município de SC — e o
    pedido não se faturava nunca (ou saía com uma cidade de SC inventada).
  */
  it('a prontidão diz de que cidade o código é, e a ficha corrige a UF para a dele', async () => {
    const pedido = pedidoComRetrato({ ibge: '4314407', cidade: 'Pelotas', uf: 'SC' });
    carregarTabela();
    const r = orderInvoiceReadiness(companyId, pedido);
    expect(r).toMatchObject({
      municipio: { uf: 'SC', codigo: '4314407', doCodigo: { codigo: '4314407', nome: 'Pelotas', uf: 'RS' } },
    });

    const res = await corrigir(pedido, { cityIbge: '4314407' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.municipio).toBeNull();
    const linha = getConnection()
      .prepare('SELECT billing_city, billing_state, billing_city_ibge FROM core_orders WHERE id = ?')
      .get(pedido) as Record<string, string>;
    expect(linha).toEqual({ billing_city: 'Pelotas', billing_state: 'RS', billing_city_ibge: '4314407' });
    const evento = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(pedido) as { note: string };
    expect(evento.note).toContain('SC');
    expect(evento.note).toContain('RS');

    const { document } = createNfeForOrder({ companyId, orderId: pedido });
    expect(document.number).toBe(1);
  });

  it('só o município do PRÓPRIO código muda a UF: outra cidade de outra UF continua 422', async () => {
    const pedido = pedidoComRetrato({ ibge: '4314407', cidade: 'Pelotas', uf: 'SC' });
    carregarTabela();
    expect((await corrigir(pedido, { cityIbge: '4314902' })).status).toBe(422);
    expect((await corrigir(pedido, { cityIbge: '3550308' })).status).toBe(422);
    const linha = getConnection()
      .prepare('SELECT billing_state, billing_city_ibge FROM core_orders WHERE id = ?')
      .get(pedido) as Record<string, string>;
    expect(linha).toEqual({ billing_state: 'SC', billing_city_ibge: '4314407' });
  });

  it('código que não existe na tabela não tem "UF dele": doCodigo nulo', () => {
    const pedido = pedidoComRetrato();
    carregarTabela();
    expect(orderInvoiceReadiness(companyId, pedido)).toMatchObject({ municipio: { doCodigo: null } });
  });
});
