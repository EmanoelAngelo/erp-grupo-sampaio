/**
 * O CHASSI, O MOTOR E O IMEI DA UNIDADE VENDIDA SAEM NO DOCUMENTO — GAP-PRD-026.
 *
 * A unidade serializada existia (identidade própria, índice único por empresa,
 * saída carimbada pela venda) e nenhum documento a lia: a NF-e e a NFC-e da
 * moto saíam só com `<xProd>`, o cupom só com o nome. O cliente não emplacava
 * e a garantia do celular ficava sem lastro.
 *
 * O que cada teste derruba:
 *   - tire o carimbo `sale_item_id` da venda e duas motos iguais em duas linhas
 *     trocam de chassi (ou somem) na nota;
 *   - tire o `infAdProd` dos montadores e a nota volta a sair sem chassi;
 *   - ponha o `infAdProd` fora da ordem do leiaute e o XSD oficial reprova;
 *   - tire a leitura do cupom, do DANFE ou do DANFCE e o papel entregue ao
 *     cliente volta a não dizer qual moto ele levou;
 *   - corte o texto em vez de recusar e a nota sai com identidade pela metade.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createUnits, getUnit } from '../src/services/core/ProductUnitService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber, getSeries } from '../src/services/core/FiscalKeyService.js';
import { createNfceForSale, createNfeForSale } from '../src/services/core/FiscalDocumentService.js';
import { loadSaleForNfce } from '../src/services/core/FiscalXmlNfce.js';
import { validarLeiauteNfe } from '../src/services/core/FiscalXsdValidator.js';
import { emissionReadinessForSale } from '../src/services/core/FiscalPipelineService.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { renderDanfe } from '../src/services/core/DanfeRenderer.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const DEST: NfeRecipient = {
  document: '529.982.247-25',
  name: 'Comprador da Moto',
  ieIndicator: '9',
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96010-000',
};

const CHASSI_1 = '9C2KC2210RR000001';
const CHASSI_2 = '9C2KC2210RR000002';

let empresa: string;
let usuario: string;
let chave = 0;

function produtoSerializado(nome: string, ncm: string, precoCents: number): string {
  const id = String(createProduct(empresa, { name: nome, priceCents: precoCents }).id);
  updateProduct(empresa, id, { serialized: true });
  getConnection()
    .prepare("UPDATE core_products SET ncm = ?, cfop = '5102', origin = '0' WHERE id = ?")
    .run(ncm, id);
  return id;
}

function entrar(
  produto: string,
  identidades: { chassis?: string; motorNumber?: string; imei?: string; serialNumber?: string }[],
): string[] {
  chave += 1;
  const ids = createUnits(empresa, produto, identidades.length, {
    entryReferenceType: 'ajuste',
    entryReferenceId: `e-${chave}`,
    identidades,
  });
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: identidades.length,
    referenceType: 'ajuste',
    referenceId: `e-${chave}`,
    unitIds: ids,
  });
  return ids;
}

function vender(
  itens: { productId: string; quantity: number; unitIds?: string[] }[],
  totalCents: number,
): string {
  chave += 1;
  const r = createSale({
    companyId: empresa,
    userId: usuario,
    items: itens,
    payments: [{ method: 'pix', amountCents: totalCents }],
    idempotencyKey: `venda-${chave}`,
  });
  return r.sale.id as string;
}

function xmlDo(documentId: string): string {
  return (
    getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(documentId) as { xml_original: string }
  ).xml_original;
}

function detsDo(xml: string): string[] {
  return [...xml.matchAll(/<det nItem="\d+">([\s\S]*?)<\/det>/g)].map((m) => m[1]);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  chave = 0;
  empresa = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  usuario = await upsertUser({ login: 'CAIXA_UN', displayName: 'Caixa', password: 'Teste@Unidade2026' });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'PJ Motors Comércio Ltda',
      tradeName: 'PJ Motors',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      zip: '96010-000',
      street: 'Av. das Motos',
      number: '1000',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(empresa);
  setSeriesNextNumber({ companyId: empresa, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 1 });
});

describe('a venda diz qual unidade saiu por qual linha', () => {
  it('carimba sale_item_id na unidade vendida', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{ chassis: CHASSI_1, motorNumber: 'MTR-0001' }]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);

    const item = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(venda) as { id: string };
    expect(getUnit(empresa, u1)?.sale_item_id).toBe(item.id);
  });

  it('o mesmo produto em duas linhas: cada linha leva o seu chassi', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1, u2] = entrar(moto, [
      { chassis: CHASSI_1, motorNumber: 'MTR-0001' },
      { chassis: CHASSI_2, motorNumber: 'MTR-0002' },
    ]);
    // Ordem invertida de propósito: a linha 1 leva a SEGUNDA moto.
    const venda = vender(
      [
        { productId: moto, quantity: 1, unitIds: [u2] },
        { productId: moto, quantity: 1, unitIds: [u1] },
      ],
      3_000_000,
    );

    const lida = loadSaleForNfce(empresa, venda);
    expect(lida.items[0].unidades?.map((u) => u.chassis)).toEqual([CHASSI_2]);
    expect(lida.items[1].unidades?.map((u) => u.chassis)).toEqual([CHASSI_1]);
  });

  it('venda de antes do carimbo: acha a unidade pela saída, se a linha é única', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{ chassis: CHASSI_1 }]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);
    // O banco que já existia: saída carimbada, linha não.
    getConnection().prepare('UPDATE core_product_units SET sale_item_id = NULL WHERE id = ?').run(u1);

    const lida = loadSaleForNfce(empresa, venda);
    expect(lida.items[0].unidades?.map((u) => u.chassis)).toEqual([CHASSI_1]);
  });
});

describe('o XML da nota identifica a unidade', () => {
  it('NFC-e da moto: infAdProd com chassi e motor, dentro do leiaute oficial', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{ chassis: CHASSI_1, motorNumber: 'MTR-0001' }]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);

    const { document } = createNfceForSale({ companyId: empresa, saleId: venda });
    const xml = xmlDo(document.id);
    const [det] = detsDo(xml);
    expect(det).toContain(`<infAdProd>Chassi ${CHASSI_1}, Motor MTR-0001</infAdProd>`);
    // O leiaute manda: infAdProd depois do imposto.
    expect(det.indexOf('<infAdProd>')).toBeGreaterThan(det.indexOf('</imposto>'));
    const xsd = validarLeiauteNfe(xml);
    expect(xsd.validated).toBe(true);
    expect(xsd.problems).toEqual([]);
  });

  it('NF-e da moto: o mesmo infAdProd, também no leiaute', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{ chassis: CHASSI_1, motorNumber: 'MTR-0001' }]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);

    const { document } = createNfeForSale({ companyId: empresa, saleId: venda, recipient: DEST });
    const xml = xmlDo(document.id);
    expect(detsDo(xml)[0]).toContain(`<infAdProd>Chassi ${CHASSI_1}, Motor MTR-0001</infAdProd>`);
    const xsd = validarLeiauteNfe(xml);
    expect(xsd.validated).toBe(true);
    expect(xsd.problems).toEqual([]);
  });

  it('celular da Preço Justo: o IMEI sai na linha dele, e a camiseta sai sem nada', () => {
    const celular = produtoSerializado('Smartphone X 128GB', '85171231', 200_000);
    const camiseta = String(createProduct(empresa, { name: 'Capa', priceCents: 5_000 }).id);
    getConnection()
      .prepare("UPDATE core_products SET ncm = '39269090', cfop = '5102', origin = '0' WHERE id = ?")
      .run(camiseta);
    applyMovement({
      companyId: empresa,
      productId: camiseta,
      movementType: 'in',
      quantity: 5,
      referenceType: 'ajuste',
      referenceId: 'capa-entrada',
    });
    const [c1] = entrar(celular, [{ imei: '356938035643809' }]);
    const venda = vender(
      [
        { productId: celular, quantity: 1, unitIds: [c1] },
        { productId: camiseta, quantity: 1 },
      ],
      205_000,
    );

    const { document } = createNfceForSale({ companyId: empresa, saleId: venda });
    const [detCelular, detCapa] = detsDo(xmlDo(document.id));
    expect(detCelular).toContain('<infAdProd>IMEI 356938035643809</infAdProd>');
    expect(detCapa).not.toContain('<infAdProd>');
  });

  it('unidade vendida antes de ler o chassi: a nota sai, sem infAdProd inventado', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{}]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);

    const { document } = createNfceForSale({ companyId: empresa, saleId: venda });
    expect(detsDo(xmlDo(document.id))[0]).not.toContain('<infAdProd>');
  });

  it('identidade que não cabe no campo é recusada ANTES do número, dizendo o caminho', () => {
    const celular = produtoSerializado('Smartphone X 128GB', '85171231', 1_000);
    const imeis = Array.from({ length: 30 }, (_, i) => ({ imei: `35693803564${String(i).padStart(4, '0')}` }));
    const ids = entrar(celular, imeis);
    const venda = vender([{ productId: celular, quantity: 30, unitIds: ids }], 30_000);

    expect(() => createNfceForSale({ companyId: empresa, saleId: venda })).toThrow(/linhas separadas/);
    expect(getSeries(empresa, '65').find((s) => s.serie === 1)?.nextNumber).toBe(1);
    const prontidao = emissionReadinessForSale(empresa, venda);
    expect(prontidao.canEmit).toBe(false);
    expect(prontidao.reasons.join(' ')).toMatch(/aceita 500/);
  });
});

describe('o papel entregue ao cliente diz qual moto ele levou', () => {
  it('o cupom da venda imprime chassi e motor abaixo do item', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1] = entrar(moto, [{ chassis: CHASSI_1, motorNumber: 'MTR-0001' }]);
    const venda = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);

    const html = renderDocument(empresa, 'SALE_RECEIPT', venda);
    expect(html).toContain(`Chassi ${CHASSI_1}, Motor MTR-0001`);
  });

  it('o DANFCE e o DANFE imprimem a identidade do item', () => {
    const moto = produtoSerializado('Moto Urbana 160', '87112020', 1_500_000);
    const [u1, u2] = entrar(moto, [{ chassis: CHASSI_1 }, { chassis: CHASSI_2 }]);
    const vendaCupom = vender([{ productId: moto, quantity: 1, unitIds: [u1] }], 1_500_000);
    const vendaNfe = vender([{ productId: moto, quantity: 1, unitIds: [u2] }], 1_500_000);

    const nfce = createNfceForSale({ companyId: empresa, saleId: vendaCupom }).document;
    expect(renderDanfce(empresa, nfce.id, { allowUnauthorized: true })).toContain(`Chassi ${CHASSI_1}`);

    const nfe = createNfeForSale({ companyId: empresa, saleId: vendaNfe, recipient: DEST }).document;
    expect(renderDanfe(empresa, nfe.id, { allowUnauthorized: true })).toContain(`Chassi ${CHASSI_2}`);
  });
});
