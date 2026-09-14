/**
 * O gatilho que faltava: emitir a NFC-e a partir da venda.
 *
 * O pipeline fiscal inteiro existia — chave de 44 dígitos, numeração,
 * assinatura, fila, DANFCE, cancelamento — e NENHUMA tela o acionava. A venda
 * saía sempre sem nota, e o painel do PDV só sabia dizer que não havia
 * documento. Faltava quem apertasse o botão, e faltava dizer por que, quando
 * não dá.
 *
 * A PERGUNTA É POR VENDA, NÃO PELA OPERAÇÃO. As duas respostas divergem, e a
 * divergência é o motivo deste arquivo existir:
 *
 *   - o checklist da operação conta produtos do CATÁLOGO sem NCM. Um produto
 *     incompleto que ninguém vendeu hoje não pode esconder o botão da venda que
 *     está no balcão;
 *   - e a operação em ordem não autoriza uma venda cujo próprio item está sem
 *     classificação fiscal.
 *
 * No balcão só há dois desfechos honestos: ou o botão aparece e a emissão anda,
 * ou ele não aparece e a tela diz o que falta. Oferecer e falhar no meio do
 * atendimento é o pior dos três — e era o que aconteceria se o painel
 * perguntasse pela operação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  emissionReadinessForSale,
  emitNfceForSale,
} from '../src/services/core/FiscalPipelineService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Teste@Emissao2026';

let companyId: string;
let caixa: { Authorization: string };
let numero = 0;

function configurarFiscal(id: string) {
  updateFiscalConfig({
    companyId: id,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
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
    },
  });
  grupoTributarioPadrao(id);
  setSeriesNextNumber({ companyId: id, model: '65', serie: 1, nextNumber: 1 });
}

/** Produto do catálogo. `ncm` nulo simula cadastro incompleto. */
function criarProduto(id: string, empresa: string, ncm: string | null): string {
  ensureCoreSchema();
  numero += 1;
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa Fixture', 'UN', 1000, 5000, ?, '5102', '0', 1, ?, ?)`,
    )
    .run(id, empresa, `FIX-${numero}`, ncm, now, now);
  return id;
}

function criarVenda(
  id: string,
  opcoes: { empresa?: string; produtoId: string; status?: string } ,
): string {
  ensureCoreSchema();
  numero += 1;
  const empresa = opcoes.empresa ?? companyId;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key,
                             change_cents, created_at)
     VALUES (?, ?, ?, ?, 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, numero, opcoes.status ?? 'completed', `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Fixture', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, empresa, opcoes.produtoId);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);

  return id;
}

beforeEach(async () => {
  resetDbForTests();
  numero = 0;
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  configurarFiscal(companyId);

  const userId = await upsertUser({ login: 'CAIXA1', displayName: 'Caixa', password: SENHA });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'CAIXA1', password: SENHA });
  caixa = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('sem credencial, o balcão não recebe botão', () => {
  it('diz que não dá para emitir, e diz por quê', () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-sem-cert', { produtoId: p });

    const r = emissionReadinessForSale(companyId, venda);

    expect(r.canEmit).toBe(false);
    expect(r.alreadyEmitted).toBe(false);
    // Não basta recusar: o caixa precisa saber o que pedir a quem resolve.
    expect(r.reasons.join(' ')).toContain('Certificado A1');
  });

  it('o que falta é EXATAMENTE o que depende de credencial', () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-cred', { produtoId: p });

    const r = emissionReadinessForSale(companyId, venda);

    // Configuração do emitente, série e itens da venda estão completos aqui.
    // Se aparecer motivo além de certificado e CSC, algo do cadastro regrediu —
    // e o caixa perderia o botão por um defeito nosso, não por falta de
    // credencial.
    /*
      O CSC saiu da lista porque a implantação mínima do teste agora o cadastra
      — a NFC-e passou a exigi-lo para montar o QR Code, e sem QR o cupom não
      vale. O que sobra é o certificado, que é a credencial que só o dono tem.
    */
    const rotulos = r.reasons.map((m) => m.split(':')[0]);
    expect(rotulos.sort()).toEqual(['Certificado A1', 'Validade do certificado']);
  });
});

describe('catálogo incompleto não pode parar a venda que está pronta', () => {
  it('produto que ninguém vendeu hoje não entra nos motivos desta venda', () => {
    // O catálogo tem um produto sem NCM — o checklist da operação conta isso e
    // reprova. Mas esta venda não tem esse produto.
    criarProduto('p-incompleto', companyId, null);
    const bom = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-catalogo', { produtoId: bom });

    const motivos = emissionReadinessForSale(companyId, venda).reasons.join(' ');

    // Esconder o botão por causa dele pararia a loja inteira o dia todo.
    expect(motivos).not.toContain('NCM dos produtos');
    expect(motivos).not.toContain('CFOP dos produtos');
    expect(motivos).not.toContain('produto(s) ativo(s)');
  });

  it('mas o item DESTA venda sem NCM entra, e diz qual item é', () => {
    const ruim = criarProduto('p-ruim', companyId, null);
    const venda = criarVenda('v-item-ruim', { produtoId: ruim });

    const r = emissionReadinessForSale(companyId, venda);
    const motivos = r.reasons.join(' ');

    expect(r.canEmit).toBe(false);
    expect(motivos).toContain('NCM');
    // Sem o nome do item, o caixa não sabe qual produto abrir para corrigir.
    expect(motivos).toContain('Camisa Fixture');
  });

  it('não repete a pendência do emitente com dois textos diferentes', () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    // Emitente incompleto: o checklist reprova E `validateNfce` reprova. Dois
    // textos para a mesma falta fariam o caixa procurar dois problemas.
    updateFiscalConfig({ companyId, patch: { ie: '' } });
    const venda = criarVenda('v-emit', { produtoId: p });

    const motivos = emissionReadinessForSale(companyId, venda).reasons;
    const sobreIe = motivos.filter((m) => /inscri..o estadual/i.test(m));
    expect(sobreIe).toHaveLength(1);
  });
});

describe('venda que não comporta emissão', () => {
  it('venda cancelada é recusada antes do clique, não depois', () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-cancelada', { produtoId: p, status: 'canceled' });

    const r = emissionReadinessForSale(companyId, venda);
    expect(r.canEmit).toBe(false);
  });

  it('venda que já tem NFC-e não é caso de emitir de novo', async () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-ja-tem', { produtoId: p });
    await emitNfceForSale({ companyId, saleId: venda, developmentMode: true });

    const r = emissionReadinessForSale(companyId, venda);

    expect(r.alreadyEmitted).toBe(true);
    expect(r.canEmit).toBe(false);
    // Um segundo documento para a mesma venda é nota em duplicidade.
    expect(r.reasons[0]).toContain('já tem NFC-e');
  });

  it('venda inexistente não vira botão', () => {
    const r = emissionReadinessForSale(companyId, 'nao-existe');
    expect(r.canEmit).toBe(false);
  });
});

describe('a rota respeita o vínculo', () => {
  it('responde ao caixa da própria operação', async () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-rota', { produtoId: p });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/sales/${venda}/emission-readiness`)
      .set(caixa);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('canEmit');
    expect(Array.isArray(res.body.reasons)).toBe(true);
  });

  it('venda de outra operação não existe para este caixa', async () => {
    const outra = upsertCompany({
      slug: 'oficina-vizinha',
      legalName: 'Oficina Vizinha Ltda',
      tradeName: 'Oficina Vizinha',
    });
    configurarFiscal(outra);
    const p = criarProduto('p-outra', outra, '62052000');
    const venda = criarVenda('v-outra', { empresa: outra, produtoId: p });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/sales/${venda}/emission-readiness`)
      .set(caixa);

    // A rota responde, mas sobre uma venda que ela não enxerga: o que não pode
    // é o caixa descobrir daqui que a venda da vizinha existe e está pronta.
    expect(res.status).toBe(200);
    expect(res.body.canEmit).toBe(false);
  });

  it('sem sessão, nada', async () => {
    const p = criarProduto('p-ok', companyId, '62052000');
    const venda = criarVenda('v-anon', { produtoId: p });

    const res = await request(app).get(
      `/api/v1/core/fiscal/sales/${venda}/emission-readiness`,
    );
    expect(res.status).toBe(401);
  });
});
