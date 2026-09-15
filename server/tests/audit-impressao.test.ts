/**
 * ============================================================================
 * AUDITORIA — FASE 7: PAPEL E QR
 * ============================================================================
 *
 * O que a casa JÁ cobre (conferido antes de escrever, para não duplicar):
 *
 *  - fila de impressão, reimpressão sem efeito, etiqueta com barras, plaquinha
 *    sem PII, DANFCE/DANFE só de documento fiscal → `impressao.test.ts`;
 *  - EAN-13, atributos da etiqueta, QR ignora baseUrl do navegador
 *    → `barcode-labels.test.ts`, `etiquetas-formatos.test.ts`;
 *  - OS assina com a identidade da OFICINA (não PJ Motors), configurável e a
 *    migração não reimpõe → `a-oficina-assina-como-oficina.test.ts` e
 *    `os-em-papel.test.ts`;
 *  - plaquinha cruzada em SERVIÇO (vinculáveis, vincular, listagem, dono)
 *    → `plaquinha-cruzada-e-recusada.test.ts`, `equipamento-no-estoque.test.ts`;
 *  - página pública da plaquinha sem dado do dono → `equipamento-publico.test.ts`.
 *
 * O que FALTAVA — e é o que este arquivo cobra:
 *
 *  1. o comprovante do PDV com os números EXATOS da venda, atravessando a API
 *     inteira (POST /sales → POST /print/jobs → GET .../document), em centavos;
 *  2. o desconto de LINHA e o ACRÉSCIMO no mesmo papel — a conta que o cliente
 *     confere tem que fechar;
 *  3. o orçamento impresso com os números exatos, pela rota;
 *  4. o cabeçalho do cupom é o da EMPRESA DA VENDA — CNPJ, endereço e telefone
 *     da outra loja não vazam, nem pelo job da fila;
 *  5. plaquinha nos FLUXOS DE IMPRESSÃO: o contexto da PJ Motors (moto de
 *     venda) e o da Oficina (máquina de cliente em manutenção) não se
 *     misturam no papel nem no QR;
 *  6. DANFCE com desconto: a aritmética impressa fecha consigo mesma.
 *
 * Os casos 2 e 6 NASCERAM vermelhos: eram defeitos reais encontrados pela
 * auditoria (ver o comentário de cada um). O conserto foi nos renderizadores —
 * `PrintRenderer.renderSale` e `renderDanfce` — e as asserções ficaram
 * exatamente como escritas: agora são o guarda de que a conta continua
 * fechando.
 */
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
import { createCustomer, createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { createOrder } from '../src/services/core/WorkshopCoreService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { vincularUnidade } from '../src/services/core/EquipmentStockLink.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  getDocument,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const SENHA = 'Auditoria@Papel2026';

/** O MESMO formato que o servidor usa no cupom — a comparação é por valor. */
function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** O formato do DANFCE (`money`), sem o símbolo. */
function moeda(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/** Usuário real, senha real, login real — como `adm-preso-a-sua-loja`. */
async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

function produtoComEstoque(
  companyId: string,
  userId: string,
  nome: string,
  precoCents: number,
  extras: Record<string, unknown> = {},
): string {
  const id = String(createProduct(companyId, { name: nome, priceCents: precoCents, ...extras }).id);
  applyMovement({
    companyId,
    productId: id,
    movementType: 'in',
    quantity: 50,
    referenceType: 'entrada',
    referenceId: 'carga-auditoria',
    userId,
  });
  return id;
}

async function vender(
  auth: { Authorization: string },
  corpo: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Record<string, unknown>;
}

/** Enfileira e busca o papel — o caminho que o PDV realmente percorre. */
async function papelDaFila(
  auth: { Authorization: string },
  documentType: string,
  documentId: string,
): Promise<string> {
  const job = await request(app)
    .post('/api/v1/core/print/jobs')
    .set(auth)
    .send({ documentType, documentId });
  expect(job.status, JSON.stringify(job.body)).toBe(201);
  expect(job.body.status).toBe('ready');

  const doc = await request(app)
    .get(`/api/v1/core/print/jobs/${job.body.id}/document`)
    .set(auth);
  expect(doc.status).toBe(200);
  return doc.text;
}

let gringa: string;
let precoJusto: string;

beforeEach(() => {
  resetDbForTests();
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio Ltda',
    tradeName: 'Gringa',
    cnpj: '11222333000181',
  });
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    cnpj: '99888777000166',
  });
  updateFiscalConfig({
    companyId: gringa,
    patch: {
      street: 'Rua das Gaivotas',
      number: '45',
      district: 'Centro',
      cityName: 'Pelotas',
      uf: 'RS',
      phone: '(53) 3222-1111',
    },
  });
  updateFiscalConfig({
    companyId: precoJusto,
    patch: {
      street: 'Av. Bento Gonçalves',
      number: '900',
      district: 'Fragata',
      cityName: 'Pelotas',
      uf: 'RS',
      phone: '(53) 3333-2222',
    },
  });
});

// ============================================================================

describe('o comprovante do PDV sai com os números exatos da venda', () => {
  it('itens, subtotal, desconto e troco — centavo a centavo, do POST /sales ao papel', async () => {
    const caixa = await ator('CAIXA.GRINGA', gringa, 'operador_caixa_loja');
    const bermuda = produtoComEstoque(gringa, caixa.userId, 'Bermuda Cargo', 3550);
    const meia = produtoComEstoque(gringa, caixa.userId, 'Meia Kit 3', 1990);

    /*
      A conta, em centavos inteiros:
        3 × 3550 = 10650
        2 × 1990 =  3980
        subtotal = 14630
        desconto de rodapé 630 (4,3% — dentro da alçada do caixa)
        total    = 14000
        dinheiro 15000 → troco 1000
    */
    const venda = await vender(caixa.auth, {
      items: [
        { productId: bermuda, quantity: 3 },
        { productId: meia, quantity: 2 },
      ],
      discountCents: 630,
      payments: [{ method: 'dinheiro', amountCents: 15000 }],
    });

    // O banco fecha a mesma conta antes de o papel existir.
    const linha = getConnection()
      .prepare(
        'SELECT subtotal_cents, discount_cents, total_cents, change_cents FROM core_sales WHERE id = ?',
      )
      .get(String(venda.id)) as {
      subtotal_cents: number;
      discount_cents: number;
      total_cents: number;
      change_cents: number;
    };
    expect(linha).toEqual({
      subtotal_cents: 14630,
      discount_cents: 630,
      total_cents: 14000,
      change_cents: 1000,
    });

    const html = await papelDaFila(caixa.auth, 'SALE_RECEIPT', String(venda.id));

    // Cada linha de item, com quantidade, unitário e total da LINHA.
    expect(html).toContain('Bermuda Cargo');
    expect(html).toContain(`3 x ${brl(3550)}`);
    expect(html).toContain(brl(10650));
    expect(html).toContain('Meia Kit 3');
    expect(html).toContain(`2 x ${brl(1990)}`);
    expect(html).toContain(brl(3980));

    // O bloco de totais, número a número.
    expect(html).toContain(brl(14630)); // subtotal
    expect(html).toContain('Desconto');
    expect(html).toContain(`- ${brl(630)}`);
    expect(html).toContain(brl(14000)); // TOTAL

    // O pagamento e o troco exatos.
    // O meio sai pelo nome que o cliente lê ("Dinheiro"), não pelo código do banco.
    expect(html).toContain('Dinheiro');
    expect(html).toContain('COMPROVANTE NÃO FISCAL');
    expect(html).toContain(brl(15000));
    expect(html).toContain('TROCO');
    expect(html).toContain(brl(1000));

    // E o papel é da venda certa, da loja certa.
    expect(html).toContain(`#${venda.number}`);
    expect(html).toContain('Gringa');
  });

  it('o desconto dado na LINHA aparece no papel — a conta do item tem que fechar', async () => {
    /*
      ACHADO DA AUDITORIA — consertado em `renderSale`.

      O PDV envia `items[].discountCents`, o servidor grava
      `core_sale_items.discount_cents` e a alçada o mede — mas `renderSale`
      não o imprimia em lugar nenhum. O papel saía assim:

          Meia Kit 3
          2 x R$ 19,90        R$ 36,80

      2 × 19,90 = 39,80 ≠ 36,80, e NADA no cupom explicava os R$ 3,00 de
      diferença: a linha "Desconto" do rodapé só mostra `sale.discount_cents`
      (o desconto de cabeçalho), que aqui é zero e nem aparece. O comprovante
      é o único papel do cliente na venda sem nota; a conta dele tem que
      fechar. Agora a linha sai com o BRUTO (quantidade × unitário) e o
      desconto do item vira linha própria — bruto − desconto = subtotal.
    */
    const caixa = await ator('CAIXA.GRINGA.L', gringa, 'operador_caixa_loja');
    const meia = produtoComEstoque(gringa, caixa.userId, 'Meia Kit 3', 1990);

    const venda = await vender(caixa.auth, {
      items: [{ productId: meia, quantity: 2, discountCents: 300 }],
      payments: [{ method: 'dinheiro', amountCents: 3680 }],
    });

    const item = getConnection()
      .prepare('SELECT discount_cents, total_cents FROM core_sale_items WHERE sale_id = ?')
      .get(String(venda.id)) as { discount_cents: number; total_cents: number };
    expect(item).toEqual({ discount_cents: 300, total_cents: 3680 });

    const html = await papelDaFila(caixa.auth, 'SALE_RECEIPT', String(venda.id));
    // O valor abatido precisa estar NO PAPEL — na linha ou no rodapé.
    expect(html, 'o cupom não mostra os R$ 3,00 de desconto dados na linha').toContain(brl(300));
  });

  it('o ACRÉSCIMO cobrado aparece no papel — total maior que o subtotal sem explicação não serve', async () => {
    /*
      ACHADO DA AUDITORIA — o irmão do caso acima, no rodapé; consertado em
      `renderSale`. `surchargeCents` (juros, frete) entra em
      `total = subtotal - desconto + acréscimo` e a nota fiscal sabe imprimi-lo
      (`vOutro`); o cupom, não. O papel saía "Subtotal R$ 39,80 / TOTAL
      R$ 42,30" e nenhuma linha dizia de onde vieram os R$ 2,50 a mais que o
      cliente pagou. Agora o rodapé tem a linha "Acréscimo" quando ele existe.
    */
    const caixa = await ator('CAIXA.GRINGA.A', gringa, 'operador_caixa_loja');
    const meia = produtoComEstoque(gringa, caixa.userId, 'Meia Kit 3', 1990);

    const venda = await vender(caixa.auth, {
      items: [{ productId: meia, quantity: 2 }],
      surchargeCents: 250,
      payments: [{ method: 'dinheiro', amountCents: 4230 }],
    });

    const linha = getConnection()
      .prepare('SELECT subtotal_cents, surcharge_cents, total_cents FROM core_sales WHERE id = ?')
      .get(String(venda.id)) as {
      subtotal_cents: number;
      surcharge_cents: number;
      total_cents: number;
    };
    expect(linha).toEqual({ subtotal_cents: 3980, surcharge_cents: 250, total_cents: 4230 });

    const html = await papelDaFila(caixa.auth, 'SALE_RECEIPT', String(venda.id));
    expect(html, 'o cupom não mostra os R$ 2,50 de acréscimo cobrados').toContain(brl(250));
  });
});

// ============================================================================

describe('o orçamento impresso sai com os números exatos', () => {
  it('itens, desconto e total pela rota — e o aviso de que nada está reservado', async () => {
    const gerente = await ator('GER.GRINGA.ORC', gringa, 'gerente_loja');
    const jaqueta = produtoComEstoque(gringa, gerente.userId, 'Jaqueta Jeans', 2575);

    /*
      4 × 2575 = 10300; desconto 300 (2,9%); total 10000.
    */
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(gerente.auth)
      .send({
        kind: 'orcamento',
        items: [{ productId: jaqueta, quantity: 4 }],
        discountCents: 300,
      });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.total_cents).toBe(10000);

    const html = await papelDaFila(gerente.auth, 'QUOTE', String(criado.body.id));

    expect(html).toContain(`Orçamento nº ${criado.body.number}`);
    expect(html).toContain('Jaqueta Jeans');
    expect(html).toContain(brl(2575)); // unitário
    expect(html).toContain(brl(10300)); // total da linha
    expect(html).toContain(`- ${brl(300)}`); // desconto
    expect(html).toContain(brl(10000)); // total
    // O orçamento não reserva mercadoria, e o papel precisa dizer isso.
    expect(html).toContain('não reservam mercadoria');
    // A identidade é a da empresa do documento.
    expect(html).toContain('Gringa');
    expect(html).not.toContain('Preço Justo');
  });
});

// ============================================================================

describe('o papel de uma empresa não veste o cabeçalho de outra', () => {
  it('o cupom da Gringa traz CNPJ, endereço e fone DA GRINGA — e nada da Preço Justo', async () => {
    const caixa = await ator('CAIXA.GRINGA.H', gringa, 'operador_caixa_loja');
    const meia = produtoComEstoque(gringa, caixa.userId, 'Meia Kit 3', 1990);
    const venda = await vender(caixa.auth, {
      items: [{ productId: meia, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 1990 }],
    });

    const html = await papelDaFila(caixa.auth, 'SALE_RECEIPT', String(venda.id));

    expect(html).toContain('Gringa');
    expect(html).toContain('CNPJ 11.222.333/0001-81');
    expect(html).toContain('Rua das Gaivotas, 45');
    expect(html).toContain('Fone (53) 3222-1111');

    expect(html).not.toContain('Preço Justo');
    expect(html).not.toContain('99.888.777');
    expect(html).not.toContain('Bento Gonçalves');
    expect(html).not.toContain('3333-2222');
  });

  it('a venda de uma loja não vira papel na fila da outra — nem pelo id do job', async () => {
    const caixaGringa = await ator('CAIXA.GRINGA.X', gringa, 'operador_caixa_loja');
    const caixaPj = await ator('CAIXA.PJUSTO.X', precoJusto, 'operador_caixa_loja');
    const meia = produtoComEstoque(gringa, caixaGringa.userId, 'Meia Kit 3', 1990);
    const venda = await vender(caixaGringa.auth, {
      items: [{ productId: meia, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 1990 }],
    });

    // O caixa da Preço Justo tenta enfileirar o cupom da venda da Gringa.
    const cruzado = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixaPj.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: String(venda.id) });
    expect(cruzado.status, JSON.stringify(cruzado.body)).toBe(404);
    expect(cruzado.body.error?.code).toBe('CORE_SALE_NOT_FOUND');

    // E nada ficou na fila dele.
    const fila = await request(app)
      .get(`/api/v1/core/print/jobs?documentId=${String(venda.id)}`)
      .set(caixaPj.auth);
    expect(fila.status).toBe(200);
    expect(fila.body.items).toHaveLength(0);

    // A Gringa enfileira o dela; a Preço Justo não lê o documento pelo id.
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixaGringa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: String(venda.id) });
    expect(job.status).toBe(201);

    const doc = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/document`)
      .set(caixaPj.auth);
    expect(doc.status, doc.text?.slice(0, 200)).toBe(404);
  });
});

// ============================================================================

describe('plaquinha: venda (PJ Motors) e manutenção (Oficina) não se misturam no papel', () => {
  let pjMotors: string;
  let oficina: string;
  let bancadaPj: string;
  let bancadaOficina: string;
  let vendedor: Ator;
  let mecanico: Ator;
  let motoDoPatio: { id: string; public_id: number };
  let motoDoCliente: { id: string; public_id: number };

  function bancada(companyId: string, slug: string): string {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, ?, ?, 'mobility', 1, ?)`,
      )
      .run(id, companyId, slug, `Bancada ${slug}`, new Date().toISOString());
    return id;
  }

  function token(equipmentId: string): string {
    const linha = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get(equipmentId) as { public_token: string };
    return linha.public_token;
  }

  beforeEach(async () => {
    pjMotors = upsertCompany({
      slug: 'pj-motors',
      legalName: 'PJ Motors Comércio Ltda',
      tradeName: 'PJ Motors',
    });
    oficina = upsertCompany({
      slug: 'oficina',
      legalName: 'Oficina Serviços Ltda',
      tradeName: 'Oficina',
      kind: 'workshop',
    });
    // A regra de ouro do dono, restrita no P0 das plaquinhas: plaquinha é SÓ da
    // PJ Motors. A marca ligada na Oficina fica aqui como o retrato de um banco
    // antigo — e é inerte: `empresaUsaPlaquinha` exige o slug da PJ.
    getConnection()
      .prepare(
        "UPDATE core_companies SET uses_equipment_tags = 1 WHERE slug IN ('pj-motors', 'oficina')",
      )
      .run();

    bancadaPj = bancada(pjMotors, 'pj-patio');
    bancadaOficina = bancada(oficina, 'oficina-mobilidade');

    vendedor = await ator('VEND.AUDIT.PLQ', pjMotors, 'gerente_loja');
    mecanico = await ator('MEC.AUDIT.PLQ', oficina, 'gerente_oficina');

    // A moto do PÁTIO da PJ Motors: existe para ser vendida.
    motoDoPatio = createEquipment({
      companyId: pjMotors,
      workshopId: bancadaPj,
      userId: vendedor.userId,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'Patio 150',
    } as Parameters<typeof createEquipment>[0]) as { id: string; public_id: number };

    // A moto do CLIENTE, na Oficina para manutenção — com OS aberta.
    const dona = createCustomer(oficina, { name: 'Marli Proprietária' } as never);
    motoDoCliente = createEquipment({
      companyId: oficina,
      workshopId: bancadaOficina,
      userId: mecanico.userId,
      origin: 'EXTERNAL_CUSTOMER',
      ownerCustomerId: String(dona.id),
      brand: 'Honda',
      model: 'Biz 125',
    } as Parameters<typeof createEquipment>[0]) as { id: string; public_id: number };
    createOrder({
      companyId: oficina,
      workshopId: bancadaOficina,
      userId: mecanico.userId,
      customerId: String(dona.id),
      equipmentId: motoDoCliente.id,
      complaint: 'Barulho no motor',
    } as Parameters<typeof createOrder>[0]);
  });

  it('cada plaquinha impressa carrega a identidade do próprio contexto', async () => {
    const daPj = await papelDaFila(vendedor.auth, 'EQUIPMENT_QR_TAG', motoDoPatio.id);
    expect(daPj).toContain('Shineray');
    expect(daPj).toContain('PJ Motors');
    expect(daPj).toMatch(/#\d{4}/);
    expect(daPj).not.toContain('Oficina');

    /*
      A OFICINA NÃO IMPRIME PLAQUINHA (P0 das plaquinhas).

      Este caso provava que a plaquinha da máquina do cliente saía com a
      identidade da Oficina. O dono tirou a plaquinha da Oficina: o pedido é
      recusado com 403 antes de o equipamento ser lido, e a recusa não carrega
      marca nem modelo da máquina.
    */
    const daOficina = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(mecanico.auth)
      .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: motoDoCliente.id });
    expect(daOficina.status, JSON.stringify(daOficina.body)).toBe(403);
    expect(daOficina.body.error?.code).toBe('CORE_COMPANY_NO_TAGS');
    expect(JSON.stringify(daOficina.body)).not.toContain('Honda');
  });

  it('a plaquinha de um contexto NÃO imprime no fluxo do outro', async () => {
    // A PJ Motors não enfileira a plaquinha da máquina do cliente da Oficina.
    const cruzada = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(vendedor.auth)
      .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: motoDoCliente.id });
    expect(cruzada.status, JSON.stringify(cruzada.body)).toBe(404);
    expect(cruzada.body.error?.code).toBe('CORE_EQUIPMENT_NOT_FOUND');

    // Nem a Oficina enfileira a plaquinha da moto do pátio da PJ Motors. Desde o
    // P0 das plaquinhas a recusa vem antes do 404: a Oficina não tem plaquinha
    // nenhuma (403), e nada da moto alheia é lido nem devolvido.
    const inversa = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(mecanico.auth)
      .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: motoDoPatio.id });
    expect(inversa.status, JSON.stringify(inversa.body)).toBe(403);
    expect(inversa.body.error?.code).toBe('CORE_COMPANY_NO_TAGS');
    expect(JSON.stringify(inversa.body)).not.toContain('Shineray');

    // A FOLHA de plaquinhas idem: o id alheio vira problema declarado, sem
    // vazar marca nem modelo do que é da vizinha.
    const folha = await request(app)
      .post('/api/v1/core/labels/equipment/sheet')
      .set(vendedor.auth)
      .send({ equipmentIds: [motoDoCliente.id] });
    expect(folha.status, JSON.stringify(folha.body)).toBe(409);
    expect(folha.body.error?.code).toBe('CORE_NO_TAGGABLE_EQUIPMENT');
    const corpo = JSON.stringify(folha.body);
    expect(corpo).toMatch(/não encontrado/i);
    expect(corpo).not.toContain('Honda');
    expect(corpo).not.toContain('Biz 125');
  });

  it('o QR de cada plaquinha resolve no próprio contexto: pátio à venda, cliente em manutenção', async () => {
    // O QR da moto do cliente abre a página da OFICINA, em serviço.
    const daCliente = await request(app).get(
      `/api/v1/loja/equipamento/${token(motoDoCliente.id)}`,
    );
    expect(daCliente.status).toBe(200);
    expect(daCliente.body.companyName).toBe('Oficina');
    expect(daCliente.body.inService).toBe(true);
    expect(daCliente.body.status).toBe('Recebido pela oficina');

    // O QR da moto do pátio abre a página da PJ MOTORS, sem serviço nenhum.
    const daPatio = await request(app).get(`/api/v1/loja/equipamento/${token(motoDoPatio.id)}`);
    expect(daPatio.status).toBe(200);
    expect(daPatio.body.companyName).toBe('PJ Motors');
    expect(daPatio.body.inService).toBe(false);

    // E um token nunca abre a página do outro contexto.
    expect(daCliente.body.companyName).not.toBe(daPatio.body.companyName);
  });

  it('a plaquinha da PJ Motors aponta para a UNIDADE SERIALIZADA de venda', async () => {
    const moto = createProduct(pjMotors, { name: 'Shineray Patio 150', priceCents: 1_200_000 }).id;
    updateProduct(pjMotors, String(moto), { serialized: true });
    const [unitId] = createUnits(pjMotors, String(moto), 1, {
      entryReferenceType: 'ajuste',
      entryReferenceId: 'audit-e1',
      locationId: null,
    });
    applyMovement({
      companyId: pjMotors,
      productId: String(moto),
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'audit-e1',
      unitIds: [unitId],
      userId: vendedor.userId,
    });

    const plaquinha = vincularUnidade({
      companyId: pjMotors,
      unitId,
      equipmentId: motoDoPatio.id,
      userId: vendedor.userId,
    }) as { publicId: number };
    expect(plaquinha.publicId).toBe(motoDoPatio.public_id);

    // A tela de unidades (a que imprime a etiqueta) vê a plaquinha NA unidade
    // de venda — com o status de venda, não de manutenção.
    const unidades = await request(app)
      .get(`/api/v1/core/units/${String(moto)}`)
      .set(vendedor.auth);
    expect(unidades.status, JSON.stringify(unidades.body)).toBe(200);
    const daUnidade = unidades.body.items[0].plaquinha;
    expect(daUnidade.publicId).toBe(motoDoPatio.public_id);
    expect(daUnidade.saleStatus).toBe('NOT_SOLD');
    expect(daUnidade.ordensAbertas).toBe(0);

    // E a folha imprime a plaquinha do pátio pela mão da própria PJ Motors.
    const folha = await request(app)
      .post('/api/v1/core/labels/equipment/sheet')
      .set(vendedor.auth)
      .send({ equipmentIds: [motoDoPatio.id] });
    expect(folha.status, JSON.stringify(folha.body).slice(0, 300)).toBe(200);
    expect(folha.body.plaquinhas).toBe(1);
    expect(folha.body.html).toContain(
      `#${String(motoDoPatio.public_id).padStart(4, '0')}`,
    );
  });
});

// ============================================================================

describe('DANFCE com desconto: a aritmética impressa fecha consigo mesma', () => {
  /*
    O cenário fiscal mínimo, no molde de `fiscal-danfce.test.ts` — a venda é
    escrita direto no banco porque o que está sob prova é o RENDERIZADOR.
  */
  let numeroVenda = 0;

  function vendaComDescontos(id: string): string {
    numeroVenda += 1;
    const db = getConnection();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa Social', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
    ).run(`prod-${id}`, gringa, `AUD-${numeroVenda}`, now, now);

    /*
      A conta em centavos:
        item: 2 × 5000 = 10000 brutos, desconto de LINHA 1000 → linha 9000
        subtotal = 9000
        desconto de RODAPÉ 500 → total 8500
      O desconto INTEIRO da venda é 1500.
    */
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
       VALUES (?, ?, ?, 'completed', 9000, 500, 0, 8500, 'pdv', ?, 0, ?)`,
    ).run(id, gringa, numeroVenda, `k-${id}`, now);

    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, 'Camisa Social', 2, 5000, 1000, 9000)`,
    ).run(`item-${id}`, id, gringa, `prod-${id}`);

    db.prepare(
      `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
       VALUES (?, ?, ?, 'dinheiro', 8500, 'settled', ?)`,
    ).run(`pay-${id}`, id, gringa, now);

    return id;
  }

  async function ateAutorizado(saleId: string) {
    const { document } = createNfceForSale({ companyId: gringa, saleId });
    validateDocument({ companyId: gringa, documentId: document.id });
    getConnection()
      .prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?")
      .run(document.id);
    transition({ companyId: gringa, documentId: document.id, to: 'SIGNED' });
    enqueue({ companyId: gringa, documentId: document.id });
    await processNext({ companyId: gringa, adapter: new SefazTestAdapter() });
    return getDocument(gringa, document.id)!;
  }

  beforeEach(() => {
    numeroVenda = 0;
    updateFiscalConfig({
      companyId: gringa,
      patch: {
        legalName: 'Gringa Comércio Ltda',
        cnpj: '11.222.333/0001-81',
        ie: '123456789',
        crt: '1',
        cityIbge: '4314407',
        zip: '96010000',
      },
    });
    grupoTributarioPadrao(gringa);
    setSeriesNextNumber({ companyId: gringa, model: '65', serie: 1, nextNumber: 1 });
  });

  it('o cupom fiscal mostra o desconto INTEIRO da venda, e a conta dos itens fecha com o total', async () => {
    /*
      ACHADO DA AUDITORIA — consertado em `renderDanfce`.

      `renderDanfce` imprimia cada item pelo `totalCents` — que já é LÍQUIDO
      do desconto de linha — e depois imprimia "Descontos" somando SÓ os
      descontos de item (`i.discountCents`), ignorando o de rodapé. Para esta
      venda o papel saía:

          Camisa Social  2 UN  50,00  90,00
          Descontos                  -10,00
          TOTAL                       85,00

      Quem conferia lia 90,00 − 10,00 = 80,00 ≠ 85,00: o desconto de item era
      subtraído DUAS vezes aos olhos do cliente e o de rodapé sumia. O XML da
      MESMA nota sempre fez a conta certa — `vProd` bruto (100,00), `vDesc`
      completo (15,00), `vNF` 85,00 — então o papel divergia do documento que
      representa.

      O conserto respeita a identidade do XML, com o unitário impresso
      (2 × 50,00): itens BRUTOS no corpo e o desconto INTEIRO na linha
      "Descontos" — 100,00 − 15,00 = 85,00.
    */
    const doc = await ateAutorizado(vendaComDescontos('venda-danfce-desc'));
    expect(doc.status).toBe('AUTHORIZED');

    const html = renderDanfce(gringa, doc.id);

    // O total impresso é o da venda.
    expect(html).toContain(moeda(8500));
    // O desconto impresso tem de ser o INTEIRO (linha + rodapé): R$ 15,00.
    expect(html, 'o DANFCE só imprime o desconto de linha e esquece o de rodapé').toContain(
      `-${moeda(1500)}`,
    );
    // E o item sai BRUTO (2 × 50,00 = 100,00), senão a subtração acima
    // desconta duas vezes o que a linha já descontou.
    expect(html, 'o item sai líquido e o leitor subtrai o desconto de novo').toContain(
      moeda(10000),
    );
  });
});
