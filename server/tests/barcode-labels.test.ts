/**
 * Código de barras e etiquetas.
 *
 * O dígito verificador é conferido contra EANs reais conhecidos: um código
 * com dígito errado é recusado pelo leitor no balcão, então gerar "quase
 * certo" seria pior que não gerar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { ean13CheckDigit, isValidEan13 } from '../src/services/core/BarcodeService.js';
import { publicBaseUrl } from '../src/services/core/PrintRenderer.js';

const app = createApp();
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: 'loja-barcode',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('EAN-13', () => {
  it('calcula o dígito verificador corretamente', () => {
    // Códigos reais conhecidos: os 12 primeiros dígitos e o verificador real.
    expect(ean13CheckDigit('789100031103')).toBe(5); // 7891000311035
    expect(ean13CheckDigit('400638133393')).toBe(1); // 4006381333931
    expect(ean13CheckDigit('501234567890')).toBe(0); // 5012345678900
  });

  it('valida código completo', () => {
    expect(isValidEan13('7891000311035')).toBe(true);
    expect(isValidEan13('4006381333931')).toBe(true);
    // Dígito verificador trocado.
    expect(isValidEan13('7891000311036')).toBe(false);
    expect(isValidEan13('123')).toBe(false);
    expect(isValidEan13('abcdefghijklm')).toBe(false);
  });

  it('recusa entrada com tamanho errado', () => {
    expect(() => ean13CheckDigit('123')).toThrow(/12 dígitos/);
  });
});

describe('geração para o produto', () => {
  it('gera EAN interno válido quando o produto não tem código', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Sem código', priceCents: 1000 });

    const res = await request(app)
      .post(`/api/v1/core/products/${product.body.id}/barcode`)
      .set(auth)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(true);
    expect(isValidEan13(res.body.barcode)).toBe(true);
    // Prefixo 2 = faixa de uso interno, não colide com EAN de fabricante.
    expect(res.body.barcode.startsWith('2')).toBe(true);
  });

  it('não troca o código de quem já tem — etiqueta impressa continua valendo', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Com EAN', priceCents: 1000, barcode: '7891000311035' });

    const res = await request(app)
      .post(`/api/v1/core/products/${product.body.id}/barcode`)
      .set(auth)
      .send({});

    expect(res.body.generated).toBe(false);
    expect(res.body.barcode).toBe('7891000311035');
  });

  it('gera códigos distintos para produtos diferentes', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const p = await request(app)
        .post('/api/v1/core/products')
        .set(auth)
        .send({ name: `Produto ${i}`, priceCents: 100 });
      const r = await request(app)
        .post(`/api/v1/core/products/${p.body.id}/barcode`)
        .set(auth)
        .send({});
      codes.add(r.body.barcode);
    }
    expect(codes.size).toBe(5);
  });

  it('o código gerado encontra o produto na busca do PDV', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Buscável', priceCents: 2500 });
    const barcode = (
      await request(app).post(`/api/v1/core/products/${product.body.id}/barcode`).set(auth).send({})
    ).body.barcode;

    const busca = await request(app)
      .get(`/api/v1/core/products/search?q=${barcode}`)
      .set(auth);
    expect(busca.body.items).toHaveLength(1);
    expect(busca.body.items[0].id).toBe(product.body.id);
  });
});

describe('etiquetas comerciais', () => {
  it('monta as etiquetas gerando código para quem não tem', async () => {
    const a = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Etiqueta A', priceCents: 4990 });
    const b = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Etiqueta B', priceCents: 1250, barcode: '4006381333931' });

    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({
        items: [
          { productId: a.body.id, quantity: 3 },
          { productId: b.body.id, quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(isValidEan13(res.body.items[0].barcode)).toBe(true);
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.items[1].barcode).toBe('4006381333931');
    expect(res.body.items[1].priceCents).toBe(1250);
  });

  it('recusa lista vazia', async () => {
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  /*
    MUDOU (auditoria C-etiquetas-09): 99999 era cortado para 200 EM SILÊNCIO —
    a tela prometia o total cheio e saía menos, sem aviso nenhum; e "abc"
    virava NaN e zero etiquetas. Agora a quantidade fora de 1 a 200 é recusada
    dizendo o produto (a tela já limita a sugestão a 200 e avisa).
  */
  it('quantidade acima de 200 é recusada dizendo o produto, e não cortada em silêncio', async () => {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Muitas', priceCents: 100 });
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [{ productId: p.body.id, quantity: 99999 }] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('CORE_LABEL_QUANTITY_INVALID');
    expect(res.body.error?.message).toMatch(/"Muitas"/);
  });
});

/**
 * A etiqueta trazia só nome, preço e código.
 *
 * Numa arara de camisetas isso torna P, M e G indistinguíveis: quem está na
 * loja tem de bipar peça por peça para saber o que está segurando. O atributo
 * vem do cadastro, não de uma lista fechada de categoria — camiseta tem
 * tamanho, batom tem tom, e a etiqueta imprime o que houver.
 */
describe('a etiqueta diz o que a peça é', () => {
  async function comAtributos(attrs: Record<string, string>, extra: Record<string, unknown> = {}) {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Peça', priceCents: 5000, ...extra });
    getConnection()
      .prepare('UPDATE core_products SET variant_attributes = ? WHERE id = ?')
      .run(JSON.stringify(attrs), p.body.id);
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [{ productId: p.body.id }] });
    return res.body.items[0].attributes as string;
  }

  it('roupa mostra tamanho e cor', async () => {
    expect(await comAtributos({ tamanho: 'M', cor: 'Azul' })).toBe('Tamanho M · Cor Azul');
  });

  it('maquiagem mostra o tom, sem inventar tamanho', async () => {
    const attr = await comAtributos({ tom: 'Nude 02' });
    expect(attr).toBe('Tom Nude 02');
    expect(attr).not.toContain('Tamanho');
  });

  it('atributo vazio não vira lixo na etiqueta', async () => {
    expect(await comAtributos({ tamanho: 'G', cor: '   ' })).toBe('Tamanho G');
  });

  it('produto sem grade cai para marca e categoria', async () => {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Fone', priceCents: 9900, brand: 'JBL', category: 'Áudio' });
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [{ productId: p.body.id }] });
    expect(res.body.items[0].attributes).toBe('JBL · Áudio');
  });

  it('produto sem nada devolve string vazia, não "undefined" impresso', async () => {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Simples', priceCents: 100 });
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [{ productId: p.body.id }] });
    expect(res.body.items[0].attributes).toBe('');
  });

  it('cadastro com JSON torto não derruba a etiqueta', async () => {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Torto', priceCents: 100, brand: 'ACME' });
    getConnection()
      .prepare('UPDATE core_products SET variant_attributes = ? WHERE id = ?')
      .run('{não é json', p.body.id);
    const res = await request(app)
      .post('/api/v1/core/labels/products')
      .set(auth)
      .send({ items: [{ productId: p.body.id }] });
    expect(res.status).toBe(200);
    expect(res.body.items[0].attributes).toBe('ACME');
  });
});

describe('plaquinha do equipamento', () => {
  it('traz QR com token e #ID, sem dado do proprietário', async () => {
    resetDbForTests();
    // O login provisiona a empresa; a oficina é criada dentro dela.
    //
    // A empresa é a PJ MOTORS com bancada (P0 das plaquinhas): plaquinha é
    // exclusiva dela, e numa empresa qualquer ('oficina-lb', como era) esta
    // rota agora responde 403 — o que `plaquinhas-so-na-pj` prova.
    const login = await loginForTest(app, {
      userId: 'ger-of',
      companyId: 'pj-motors',
      profileCodes: ['gerente_oficina'],
    });
    const oficinaAuth = { Authorization: `Bearer ${login.body.accessToken}` };
    getConnection().prepare("UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = 'pj-motors'").run();
    const workshopId = 'ws-lb';
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, 'pj-motors', 'oficina-mobilidade', 'Mobilidade', 'mobility', 1, ?)`,
      )
      .run(workshopId, new Date().toISOString());

    const equip = await request(app)
      .post('/api/v1/core/equipment')
      .set(oficinaAuth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ', model: 'Sport', workshopId });

    const res = await request(app)
      .post('/api/v1/core/labels/equipment')
      .set(oficinaAuth)
      // O `baseUrl` vai no corpo DE PROPÓSITO, e apontando para um IP de rede
      // interna: é exatamente o que o navegador mandava antes. O teste abaixo
      // cobra que o servidor o IGNORE.
      .send({ equipmentIds: [equip.body.id], baseUrl: 'http://192.168.0.10:3000' });

    expect(res.status).toBe(200);
    const label = res.body.items[0];
    expect(label.publicIdLabel).toMatch(/^#\d{4}$/);
    // O token não sai na resposta de criação (GAP-PRD-106): lido do banco.
    const { public_token: tokenDoQr } = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get(equip.body.id) as { public_token: string };
    expect(equip.body.public_token).toBeUndefined();
    expect(label.qrUrl).toBe(`${publicBaseUrl()}/equipamento/${tokenDoQr}`);
    // A plaquinha fica exposta no equipamento: nada de PII nela.
    const serialized = JSON.stringify(label);
    expect(serialized).not.toMatch(/owner|customer|cpf|documento/i);
  });

  /*
    O QR NÃO PODE SAIR PELO ENDEREÇO DE QUEM PEDIU A ETIQUETA.

    Este teste é o que prova que o guarda existe: se alguém voltar a ler
    `req.body.baseUrl`, a plaquinha volta a nascer apontando para o IP da
    máquina do balcão. Ela fica colada no equipamento por anos e é escaneada
    pelo celular do cliente, na rua — um endereço de rede interna ali é um QR
    que nunca mais funciona, e o defeito só aparece quando o adesivo já está no
    aparelho.
  */
  it('ignora o endereço que o navegador mandar e usa o configurado', async () => {
    resetDbForTests();
    // A PJ Motors com bancada, pelo mesmo motivo do caso acima (P0 das plaquinhas).
    const login = await loginForTest(app, {
      userId: 'ger-of2',
      companyId: 'pj-motors',
      profileCodes: ['gerente_oficina'],
    });
    const oficinaAuth = { Authorization: `Bearer ${login.body.accessToken}` };
    getConnection().prepare("UPDATE core_companies SET uses_equipment_tags = 1 WHERE id = 'pj-motors'").run();
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('ws-lb2', 'pj-motors', 'oficina-mobilidade', 'Mobilidade', 'mobility', 1, ?)`,
      )
      .run(new Date().toISOString());

    const equip = await request(app)
      .post('/api/v1/core/equipment')
      .set(oficinaAuth)
      .send({ origin: 'INTERNAL_PJ_MOTORS', brand: 'PJ', model: 'Sport', workshopId: 'ws-lb2' });

    const res = await request(app)
      .post('/api/v1/core/labels/equipment')
      .set(oficinaAuth)
      .send({ equipmentIds: [equip.body.id], baseUrl: 'http://192.168.0.77:3000' });

    expect(res.status).toBe(200);
    expect(res.body.items[0].qrUrl).not.toContain('192.168.0.77');
    expect(res.body.items[0].qrUrl.startsWith(publicBaseUrl())).toBe(true);
  });
});
