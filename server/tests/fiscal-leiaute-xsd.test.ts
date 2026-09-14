/**
 * O LEIAUTE PELO XSD OFICIAL — GAP-PRD-097.
 *
 * Até aqui, `validateAgainstSchema` só conferia que as tags abriam e
 * fechavam, devolvia `validated: false` sempre, e o DRAFT→VALIDATED registrava
 * `schemaValidated: false`. Ordem de elemento, tamanho, padrão e domínio de
 * campo só apareciam como rejeição da SEFAZ, com o número fiscal já reservado.
 *
 * Este arquivo prova, com os XSDs do Pacote de Liberação embutido
 * (PL_010b_V1.30) e a libxml2:
 *
 *  - o pacote está íntegro (manifesto com SHA-256 de cada arquivo);
 *  - a NFC-e e a NF-e que o sistema monta CUMPREM o leiaute;
 *  - um erro de leiaute é recusado ANTES de reservar número — o contador da
 *    série não anda — e a recusa nomeia o campo;
 *  - o DRAFT→VALIDATED registra o pacote que aprovou, e XML fora do leiaute
 *    vai para ERROR com o motivo, sem chegar à assinatura;
 *  - os dois defeitos reais que o XSD achou no primeiro dia estão fechados:
 *    CEP do emitente ausente e `cIdToken` do QR com zeros à esquerda.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *  - tire `conferirLeiauteAntesDeNumerar` de `createNfceForSale`: o caso do
 *    xProd de 130 caracteres reserva o número — vermelho;
 *  - volte o `padStart(6, '0')` do idToken: o qrCode sai do padrão — vermelho;
 *  - volte o `validated: false` fixo: "reporta validado" fica vermelho.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  buildReadiness,
  getFiscalConfig,
  updateFiscalConfig,
} from '../src/services/core/FiscalConfigService.js';
import { getSeries, setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  getDocument,
  listDocumentEvents,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import {
  buildNfceXml,
  loadSaleForNfce,
  validateAgainstSchema,
  validateNfce,
} from '../src/services/core/FiscalXmlNfce.js';
import { buildNfeXml, type NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import {
  ESQUEMAS,
  PACOTE_DE_ESQUEMAS,
  situacaoDosEsquemas,
  validarXmlContraXsd,
} from '../src/services/core/FiscalXsdValidator.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const PASTA = new URL(`../fiscal-schemas/${PACOTE_DE_ESQUEMAS}/`, import.meta.url);

let companyId: string;
let proximaVenda = 0;

function criarVenda(id: string, descricao = 'Camisa'): string {
  ensureCoreSchema();
  proximaVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `GS-${proximaVenda}`, descricao, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key,
                             change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, proximaVenda, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, ?, 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`, descricao);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

const proximoNumero = () => getSeries(companyId, '65').find((s) => s.serie === 1)?.nextNumber;

beforeEach(() => {
  resetDbForTests();
  proximaVenda = 0;
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960012345',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010-000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
});

describe('o pacote de esquemas embutido', () => {
  it('está disponível, e é o PL_010b_V1.30', () => {
    expect(situacaoDosEsquemas()).toMatchObject({ pacote: 'PL_010b_V1.30', disponivel: true, motivo: null });
  });

  it('cada arquivo do manifesto existe e confere com o SHA-256 declarado', () => {
    const manifesto = JSON.parse(readFileSync(new URL('MANIFESTO.json', PASTA), 'utf8')) as {
      arquivos: Record<string, string>;
    };
    const xsdsNaPasta = readdirSync(PASTA).filter((f) => f.endsWith('.xsd')).sort();
    expect(Object.keys(manifesto.arquivos).sort()).toEqual(xsdsNaPasta);
    for (const [arquivo, hash] of Object.entries(manifesto.arquivos)) {
      const conteudo = readFileSync(new URL(arquivo, PASTA), 'utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(conteudo, 'utf8').digest('hex'), arquivo).toBe(hash);
    }
    // Todo documento que o sistema valida tem a raiz no pacote.
    for (const raiz of Object.values(ESQUEMAS)) expect(xsdsNaPasta).toContain(raiz);
  });
});

describe('o que o sistema monta cumpre o leiaute', () => {
  it('NFC-e 65 montada da venda: validated, sem problema nenhum', () => {
    const saleId = criarVenda('s1');
    const sale = loadSaleForNfce(companyId, saleId);
    const { xml } = buildNfceXml({ sale, config: getFiscalConfig(companyId), serie: 1, number: 1 });
    expect(validateAgainstSchema(xml)).toMatchObject({
      validated: true,
      wellFormed: true,
      problems: [],
      schemaPackage: 'PL_010b_V1.30',
    });
  });

  it('NF-e 55 com destinatário: validated, sem problema nenhum', () => {
    const saleId = criarVenda('s2');
    const sale = loadSaleForNfce(companyId, saleId);
    const recipient = {
      document: '11144477735',
      name: 'Cliente de Teste',
      ieIndicator: '9',
      ie: null,
      street: 'Rua das Flores',
      number: '10',
      district: 'Centro',
      cityIbge: '4314407',
      cityName: 'Pelotas',
      uf: 'RS',
    } as NfeRecipient;
    const { xml } = buildNfeXml({ sale, config: getFiscalConfig(companyId), recipient, serie: 1, number: 1 });
    expect(validateAgainstSchema(xml)).toMatchObject({ validated: true, problems: [] });
  });

  it('o QR Code leva o cIdToken sem zeros à esquerda — o padrão do XSD', () => {
    const saleId = criarVenda('s3');
    const sale = loadSaleForNfce(companyId, saleId);
    const { xml, accessKey } = buildNfceXml({ sale, config: getFiscalConfig(companyId), serie: 1, number: 1 });
    expect(xml).toContain(`?p=${accessKey}|2|2|1|`);
    expect(xml).not.toContain('|000001|');
  });
});

describe('o XSD acusa o que as regras de negócio não pegam', () => {
  it('ordem trocada, campo a mais e padrão violado aparecem nomeados', () => {
    const saleId = criarVenda('s4');
    const sale = loadSaleForNfce(companyId, saleId);
    const { xml } = buildNfceXml({ sale, config: getFiscalConfig(companyId), serie: 1, number: 1 });

    const ordemTrocada = xml.replace(/(<cMun>\d+<\/cMun>)(\s*<xMun>[^<]*<\/xMun>)/, '$2$1');
    expect(validateAgainstSchema(ordemTrocada).problems.join(' ')).toMatch(/xMun|cMun/);

    const cepRuim = xml.replace(/<CEP>\d+<\/CEP>/, '<CEP>960100</CEP>');
    expect(validateAgainstSchema(cepRuim).problems.join(' ')).toMatch(/CEP/);

    const intruso = xml.replace('<indTot>1</indTot>', '<indTot>1</indTot><campoInventado>1</campoInventado>');
    expect(validateAgainstSchema(intruso).problems.join(' ')).toMatch(/campoInventado/);
  });

  it('XML mal formado continua sendo dito como mal formado', () => {
    const r = validarXmlContraXsd('<NFe><infNFe></NFe>', 'nfe');
    expect(r).toMatchObject({ wellFormed: false, validated: false });
    expect(r.problems.length).toBeGreaterThan(0);
  });
});

describe('o portão ANTES do número (evita queimar numeração por leiaute)', () => {
  it('produto com nome de 130 caracteres: recusa nomeando o xProd, e o número NÃO é reservado', () => {
    const nomeLongo = `Jaqueta ${'X'.repeat(122)}`;
    expect(nomeLongo.length).toBe(130);
    const saleId = criarVenda('s5', nomeLongo);

    // As regras de negócio não sabem o tamanho do campo: passam.
    expect(validateNfce(loadSaleForNfce(companyId, saleId), getFiscalConfig(companyId))).toEqual([]);

    const antes = proximoNumero();
    let erro: unknown;
    try {
      createNfceForSale({ companyId, saleId });
    } catch (e) {
      erro = e;
    }
    expect(erro).toMatchObject({ code: 'CORE_FISCAL_LAYOUT_INVALID', status: 409 });
    expect(String((erro as Error).message)).toMatch(/xProd/);
    expect(String((erro as Error).message)).toMatch(/120/);
    // O contador da série não andou: nada foi queimado.
    expect(proximoNumero()).toBe(antes);
    const docs = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_fiscal_documents WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(Number(docs.n)).toBe(0);
  });

  it('venda dentro do leiaute passa pelo portão e é numerada normalmente', () => {
    const saleId = criarVenda('s6');
    const antes = proximoNumero();
    const { document, created } = createNfceForSale({ companyId, saleId });
    expect(created).toBe(true);
    expect(document.number).toBe(antes);
    expect(proximoNumero()).toBe(Number(antes) + 1);
  });

  it('CEP do emitente ausente: a regra nomeia o campo antes do número, e a prontidão aponta', () => {
    updateFiscalConfig({ companyId, patch: { zip: null } });
    const saleId = criarVenda('s7');
    const problemas = validateNfce(loadSaleForNfce(companyId, saleId), getFiscalConfig(companyId));
    expect(problemas.map((p) => p.field)).toContain('emit.CEP');

    const endereco = buildReadiness(companyId, '65').items.find((i) => i.key === 'address')!;
    expect(endereco.status).toBe('FAIL');
    expect(endereco.detail).toMatch(/CEP/);

    const antes = proximoNumero();
    expect(() => createNfceForSale({ companyId, saleId })).toThrow(/CEP/);
    expect(proximoNumero()).toBe(antes);
  });
});

describe('DRAFT → VALIDATED usa o XSD de verdade', () => {
  it('documento dentro do leiaute: VALIDATED, com o pacote no histórico', () => {
    const saleId = criarVenda('s8');
    const { document } = createNfceForSale({ companyId, saleId });
    const validado = validateDocument({ companyId, documentId: document.id });
    expect(validado.status).toBe('VALIDATED');
    const evento = listDocumentEvents(companyId, document.id).find((e) => e.eventType === 'status:DRAFT->VALIDATED')!;
    expect(JSON.parse(evento.detail!)).toMatchObject({ schemaValidated: true, schemaPackage: 'PL_010b_V1.30' });
  });

  it('XML gravado fora do leiaute (banco mexido por fora): ERROR com o motivo, sem assinar', () => {
    const saleId = criarVenda('s9');
    const { document } = createNfceForSale({ companyId, saleId });
    const db = getConnection();
    const { xml_original: original } = db
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_original: string };
    db.prepare('UPDATE core_fiscal_documents SET xml_original = ? WHERE id = ?').run(
      original.replace('<indTot>1</indTot>', '<indTot>7</indTot>'),
      document.id,
    );

    const r = validateDocument({ companyId, documentId: document.id });
    expect(r.status).toBe('ERROR');
    const atual = getDocument(companyId, document.id)!;
    expect(atual.xMotivo).toMatch(/Fora do leiaute oficial \(PL_010b_V1\.30\)/);
    expect(atual.xMotivo).toMatch(/indTot/);
    const assinado = db
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_signed: string | null };
    expect(assinado.xml_signed).toBeNull();
  });
});
