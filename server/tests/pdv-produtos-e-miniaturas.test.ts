/**
 * PRODUTOS E FOTOS NO PDV — P0 da Preço Justo.
 *
 * O que este arquivo trava, pela rota que o balcão usa (`GET /products/search`,
 * com o token do caixa da loja):
 *
 *   - a busca acha por nome, código interno, SKU, código de barras e código
 *     ADICIONAL (`core_product_barcodes`); vende a VARIANTE, nunca o modelo;
 *     inativo e variante de modelo arquivado não aparecem;
 *   - a linha traz a MINIATURA (`thumb_url`) e nunca o original (`image_url`
 *     sai da resposta); sem foto, `thumb_url` nulo e `tem_foto` zero;
 *   - a miniatura é conferida pelo servidor: WebP ou JPEG, até 40 KB, até
 *     160 px no maior lado — lido do cabeçalho; recusada, nada fica no disco;
 *   - as fotos antigas ganham miniatura por uma porta só, que preenche o vazio
 *     (409 no segundo) e que o caixa não alcança (PDV não administra);
 *   - isolamento: nada de outra empresa sai pela busca, pela miniatura, pela
 *     fila do preenchimento nem por um `parent_id` torto;
 *   - preço e foto novos chegam à próxima busca, sem cache no caminho;
 *   - o "fiscal incompleto" diz o NOME do campo que a NFC-e recusaria.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - devolva `p.*` sem apagar `image_url` e o caso "nunca o original" cai;
 *   - tire o `company_id` da subconsulta da miniatura e o caso do `parent_id`
 *     torto mostra a foto da outra loja;
 *   - confira só o peso da miniatura e o caso dos 800 px passa;
 *   - troque `requireCapability('products.manage')` por `abertaAo('balcao')` e
 *     o caixa grava miniatura.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { MAX_THUMB_BYTES, uploadsDir } from '../src/services/core/ProductImageService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const LOJA = 'loja-pdv-fotos';
const OUTRA = 'outra-loja-pdv';

/** PNG 1x1 real — o ORIGINAL da foto nos testes. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: ReturnType<typeof createApp>;

function auth(perfil: string, empresa = LOJA): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}-${empresa}`, companyId: empresa, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

/**
 * Um JPEG com o cabeçalho de verdade (SOI, APP0 JFIF, SOF0 com os lados, EOI).
 * O servidor lê o tamanho do SOF — é só isso que ele confere, e é isso que o
 * teste precisa controlar. `recheio` engorda o arquivo sem mudar os lados.
 */
function jpeg(largura: number, altura: number, recheio = 0): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    altura >> 8, altura & 0xff, largura >> 8, largura & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, ...app0, ...sof0]),
    Buffer.alloc(recheio),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Um WebP estendido (VP8X) com os lados no cabeçalho. */
function webp(largura: number, altura: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(largura - 1, 24, 3);
  b.writeUIntLE(altura - 1, 27, 3);
  return b;
}

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

interface Extras {
  companyId?: string;
  barcode?: string | null;
  sku?: string | null;
  internalCode?: string;
  active?: number;
  parentId?: string | null;
  ncm?: string | null;
  cfop?: string | null;
  origin?: string | null;
  taxProfile?: string | null;
  priceCents?: number;
}

function produto(id: string, name: string, x: Extras = {}): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, sku, barcode, name, unit, cost_cents, price_cents, active,
          publish_online, parent_id, ncm, cfop, origin, tax_profile, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'UN', 500, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      x.companyId ?? LOJA,
      x.internalCode ?? `C-${id}`,
      x.sku ?? null,
      x.barcode ?? null,
      name,
      x.priceCents ?? 1000,
      x.active ?? 1,
      x.parentId ?? null,
      x.ncm ?? null,
      x.cfop ?? null,
      x.origin ?? null,
      x.taxProfile ?? null,
      agora,
      agora,
    );
}

/** A busca do balcão, com o token do caixa da loja — o login do PDV. */
async function buscar(q: string, empresa = LOJA, perfil = 'operador_caixa_loja') {
  const r = await request(app).get('/api/v1/core/products/search').query({ q }).set(auth(perfil, empresa));
  expect(r.status).toBe(200);
  return r.body.items as Array<Record<string, unknown>>;
}

async function enviarFoto(
  productId: string,
  miniatura?: { mime: string; bytes: Buffer } | null,
  perfil = 'gerente_loja',
) {
  return request(app)
    .post(`/api/v1/core/products/${productId}/images`)
    .set(auth(perfil))
    .send({
      dataUrl: `data:image/png;base64,${PNG_1X1}`,
      fileName: 'foto.png',
      ...(miniatura ? { thumbDataUrl: dataUrl(miniatura.mime, miniatura.bytes) } : {}),
    });
}

const arquivosNoDisco = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()).length : 0);

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // As sessões provisionam as duas empresas antes de qualquer produto.
  auth('gerente_loja', LOJA);
  auth('gerente_loja', OUTRA);
});

// --------------------------------------------------------------- a busca

describe('a busca do balcão', () => {
  beforeEach(() => {
    produto('p-arroz', 'Arroz Tipo 1 5kg', { barcode: '7890000000017', sku: 'ARZ-5', internalCode: 'PJ-0105' });
  });

  it('acha por nome, código interno (em qualquer caixa), SKU e código de barras', async () => {
    for (const termo of ['arroz', 'pj-0105', 'ARZ-5', '7890000000017']) {
      const itens = await buscar(termo);
      expect(itens.map((i) => i.id), termo).toContain('p-arroz');
    }
  });

  it('acha pelo código ADICIONAL, marcado como casamento exato', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_product_barcodes (id, company_id, product_id, barcode, created_at)
         VALUES ('bc-fardo', ?, 'p-arroz', '17890000000014', ?)`,
      )
      .run(LOJA, new Date().toISOString());
    const [achado] = await buscar('17890000000014');
    expect(achado.id).toBe('p-arroz');
    expect(Number(achado.matched_exact)).toBe(1);
  });

  it('traz preço vigente e saldo na linha', async () => {
    const [achado] = await buscar('7890000000017');
    expect(achado.price_cents).toBe(1000);
    expect(achado.effective_price_cents).toBe(1000);
    expect(achado).toHaveProperty('stock_quantity', 0);
  });

  it('produto INATIVO não aparece — nem pelo código de barras', async () => {
    produto('p-inativo', 'Feijão arquivado', { barcode: '7890000000024', active: 0 });
    expect(await buscar('7890000000024')).toEqual([]);
    expect((await buscar('feijão')).map((i) => i.id)).not.toContain('p-inativo');
  });

  it('vende a VARIANTE, não o modelo; variante de modelo arquivado some junto', async () => {
    produto('m-polo', 'Camiseta Polo');
    produto('v-polo-m', 'Camiseta Polo · M', { parentId: 'm-polo', barcode: '7890000000031' });
    const nomes = (await buscar('camiseta polo')).map((i) => i.id);
    expect(nomes).toContain('v-polo-m');
    expect(nomes).not.toContain('m-polo');

    getConnection().prepare("UPDATE core_products SET active = 0 WHERE id = 'm-polo'").run();
    expect(await buscar('7890000000031')).toEqual([]);
  });
});

// ----------------------------------------------------------- a miniatura

describe('a miniatura do balcão', () => {
  beforeEach(() => {
    produto('p-vestido', 'Vestido Longo', { barcode: '7890000000048' });
  });

  it('a foto sobe com a miniatura, e a busca devolve a MINIATURA — nunca o original', async () => {
    const r = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: jpeg(160, 120) });
    expect(r.status).toBe(201);
    expect(r.body.thumb_url).toMatch(/^\/uploads\/produtos\/[0-9a-f-]+-mini-[0-9a-f]{8}\.jpg$/);
    expect(r.body.thumb_bytes).toBeGreaterThan(0);

    const [achado] = await buscar('7890000000048');
    expect(achado.thumb_url).toBe(r.body.thumb_url);
    expect(achado.thumb_url).not.toBe(r.body.url);
    expect(Number(achado.tem_foto)).toBe(1);
    // O caminho do original não chega ao balcão — nem por descuido da tela.
    expect(achado).not.toHaveProperty('image_url');
    expect(JSON.stringify(achado)).not.toContain(r.body.url);
  });

  it('a miniatura é servida como imagem, com cache imutável (o nome nunca é reescrito)', async () => {
    const r = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: jpeg(100, 100) });
    const arquivo = await request(app).get(r.body.thumb_url);
    expect(arquivo.status).toBe(200);
    expect(arquivo.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(arquivo.headers['cache-control']).toMatch(/immutable/);
    expect(Number(arquivo.headers['content-length'])).toBeLessThanOrEqual(MAX_THUMB_BYTES);
  });

  it('WebP é aceito', async () => {
    const r = await enviarFoto('p-vestido', { mime: 'image/webp', bytes: webp(160, 90) });
    expect(r.status).toBe(201);
    expect(r.body.thumb_url).toMatch(/\.webp$/);
  });

  it('miniatura pesada, grande, em PNG ou ilegível é recusada — e nada fica no disco', async () => {
    const antes = arquivosNoDisco();
    const pesada = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: jpeg(160, 160, MAX_THUMB_BYTES) });
    expect(pesada.status).toBe(413);
    expect(pesada.body.error?.code ?? pesada.body.code).toBe('CORE_THUMB_TOO_LARGE');

    const grande = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: jpeg(800, 600) });
    expect(grande.status).toBe(400);
    expect(grande.body.error?.code ?? grande.body.code).toBe('CORE_THUMB_TOO_BIG');

    const png = await enviarFoto('p-vestido', { mime: 'image/png', bytes: Buffer.from(PNG_1X1, 'base64') });
    expect(png.status).toBe(400);
    expect(png.body.error?.code ?? png.body.code).toBe('CORE_THUMB_FORMAT_INVALID');

    const lixo = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: Buffer.from('não é jpeg') });
    expect(lixo.status).toBe(400);
    expect(lixo.body.error?.code ?? lixo.body.code).toBe('CORE_THUMB_INVALID');

    // O original recusado junto não virou órfão na pasta.
    expect(arquivosNoDisco()).toBe(antes);
    expect((await request(app).get('/api/v1/core/products/p-vestido/images').set(auth('gerente_loja'))).body.items).toEqual([]);
  });

  it('produto sem foto: miniatura nula e `tem_foto` zero — o balcão mostra o espaço neutro', async () => {
    const [achado] = await buscar('7890000000048');
    expect(achado.thumb_url).toBeNull();
    expect(Number(achado.tem_foto)).toBe(0);
  });

  it('a variante sem galeria mostra a miniatura do MODELO', async () => {
    produto('m-saia', 'Saia Midi');
    produto('v-saia-p', 'Saia Midi · P', { parentId: 'm-saia', barcode: '7890000000055' });
    const r = await enviarFoto('m-saia', { mime: 'image/jpeg', bytes: jpeg(120, 160) });
    const [achado] = await buscar('7890000000055');
    expect(achado.id).toBe('v-saia-p');
    expect(achado.thumb_url).toBe(r.body.thumb_url);
  });

  it('remover a foto remove a miniatura dela do disco', async () => {
    const r = await enviarFoto('p-vestido', { mime: 'image/jpeg', bytes: jpeg(100, 100) });
    const mini = join(uploadsDir(), String(r.body.thumb_url).split('/').pop()!);
    expect(existsSync(mini)).toBe(true);
    const del = await request(app)
      .delete(`/api/v1/core/products/p-vestido/images/${r.body.id}`)
      .set(auth('gerente_loja'));
    expect(del.status).toBe(200);
    expect(existsSync(mini)).toBe(false);
  });
});

// -------------------------------------------- as fotos que já existiam

describe('o preenchimento das fotos antigas', () => {
  beforeEach(() => {
    produto('p-legado', 'Bolsa de couro', { barcode: '7890000000062' });
    getConnection()
      .prepare(
        `INSERT INTO core_product_images (id, company_id, product_id, url, position, is_primary, created_at)
         VALUES ('img-legado', ?, 'p-legado', '/uploads/produtos/legado.jpg', 0, 1, ?)`,
      )
      .run(LOJA, new Date().toISOString());
  });

  it('foto antiga: o balcão recebe miniatura nula (nunca o original) e `tem_foto` 1', async () => {
    const [achado] = await buscar('7890000000062');
    expect(achado.thumb_url).toBeNull();
    expect(Number(achado.tem_foto)).toBe(1);
    expect(achado).not.toHaveProperty('image_url');
  });

  it('entra na fila, é preenchida uma vez, e o segundo preenchimento é recusado (409)', async () => {
    const fila = await request(app).get('/api/v1/core/products/fotos-sem-miniatura').set(auth('gerente_loja'));
    expect(fila.status).toBe(200);
    expect(fila.body.total).toBe(1);
    expect(fila.body.items[0]).toMatchObject({ id: 'img-legado', product_id: 'p-legado', product_name: 'Bolsa de couro' });

    const url = '/api/v1/core/products/p-legado/images/img-legado/thumbnail';
    const ok = await request(app).put(url).set(auth('estoquista')).send({ dataUrl: dataUrl('image/jpeg', jpeg(160, 160)) });
    expect(ok.status).toBe(200);
    expect(ok.body.thumb_url).toMatch(/-mini-/);

    const [achado] = await buscar('7890000000062');
    expect(achado.thumb_url).toBe(ok.body.thumb_url);

    const de_novo = await request(app).put(url).set(auth('gerente_loja')).send({ dataUrl: dataUrl('image/jpeg', jpeg(100, 100)) });
    expect(de_novo.status).toBe(409);

    const depois = await request(app).get('/api/v1/core/products/fotos-sem-miniatura').set(auth('gerente_loja'));
    expect(depois.body.total).toBe(0);
  });

  it('o caixa da loja NÃO gera miniatura nem lê a fila — o PDV não administra', async () => {
    const caixa = auth('operador_caixa_loja');
    const put = await request(app)
      .put('/api/v1/core/products/p-legado/images/img-legado/thumbnail')
      .set(caixa)
      .send({ dataUrl: dataUrl('image/jpeg', jpeg(100, 100)) });
    expect(put.status).toBe(403);
    const fila = await request(app).get('/api/v1/core/products/fotos-sem-miniatura').set(caixa);
    expect(fila.status).toBe(403);
    // A foto, também não.
    expect((await enviarFoto('p-legado', null, 'operador_caixa_loja')).status).toBe(403);
  });
});

// ------------------------------------------------------------ isolamento

describe('isolamento entre empresas', () => {
  beforeEach(async () => {
    produto('p-alheio', 'Tênis da outra loja', { companyId: OUTRA, barcode: '7890000000079' });
    getConnection()
      .prepare(
        `INSERT INTO core_product_images (id, company_id, product_id, url, position, is_primary, created_at, thumb_url)
         VALUES ('img-alheia', ?, 'p-alheio', '/uploads/produtos/alheia.jpg', 0, 1, ?,
                 '/uploads/produtos/alheia-mini-00000000.jpg')`,
      )
      .run(OUTRA, new Date().toISOString());
  });

  it('a busca não devolve produto de outra empresa — nem por código, nem por nome', async () => {
    expect(await buscar('7890000000079')).toEqual([]);
    expect(await buscar('tênis')).toEqual([]);
    // A dona acha.
    expect((await buscar('7890000000079', OUTRA)).map((i) => i.id)).toEqual(['p-alheio']);
  });

  it('a miniatura de outra empresa não vaza por um `parent_id` torto', async () => {
    produto('v-torta', 'Variante torta', { parentId: 'p-alheio', barcode: '7890000000086' });
    const [achado] = await buscar('7890000000086');
    expect(achado.id).toBe('v-torta');
    expect(achado.thumb_url).toBeNull();
    expect(Number(achado.tem_foto)).toBe(0);
  });

  it('a imagem de outra empresa, pelo id, responde como inexistente', async () => {
    const put = await request(app)
      .put('/api/v1/core/products/p-alheio/images/img-alheia/thumbnail')
      .set(auth('gerente_loja'))
      .send({ dataUrl: dataUrl('image/jpeg', jpeg(100, 100)) });
    expect(put.status).toBe(404);
    const galeria = await request(app).get('/api/v1/core/products/p-alheio/images').set(auth('gerente_loja'));
    expect(galeria.body.items).toEqual([]);
    const fila = await request(app).get('/api/v1/core/products/fotos-sem-miniatura').set(auth('gerente_loja'));
    expect(fila.body.items.map((i: { id: string }) => i.id)).not.toContain('img-alheia');
  });
});

// ------------------------------------------------- atualizações no balcão

describe('o que muda no cadastro chega à próxima busca', () => {
  beforeEach(() => {
    produto('p-cafe', 'Café 500g', { barcode: '7890000000093' });
  });

  it('preço novo aparece na busca seguinte', async () => {
    const put = await request(app).put('/api/v1/core/products/p-cafe').set(auth('gerente_loja')).send({ priceCents: 1890 });
    expect(put.status).toBe(200);
    const [achado] = await buscar('7890000000093');
    expect(achado.price_cents).toBe(1890);
    expect(achado.effective_price_cents).toBe(1890);
  });

  it('foto principal nova = URL de miniatura nova (o cache do navegador não segura a velha)', async () => {
    const primeira = await enviarFoto('p-cafe', { mime: 'image/jpeg', bytes: jpeg(100, 100) });
    const segunda = await enviarFoto('p-cafe', { mime: 'image/jpeg', bytes: jpeg(120, 120) });
    expect((await buscar('7890000000093'))[0].thumb_url).toBe(primeira.body.thumb_url);

    const principal = await request(app)
      .post(`/api/v1/core/products/p-cafe/images/${segunda.body.id}/primary`)
      .set(auth('gerente_loja'));
    expect(principal.status).toBe(200);
    const [achado] = await buscar('7890000000093');
    expect(achado.thumb_url).toBe(segunda.body.thumb_url);
    expect(achado.thumb_url).not.toBe(primeira.body.thumb_url);
  });
});

// -------------------------------------------------------- fiscal incompleto

describe('o fiscal incompleto na linha da busca', () => {
  it('operação que emite: diz QUAL campo falta, pela régua da nota — sem valor nenhum', async () => {
    updateFiscalConfig({ companyId: LOJA, patch: { cnpj: '11222333000181', crt: '1' } });
    grupoTributarioPadrao(LOJA);
    produto('p-completo', 'Blusa completa', {
      barcode: '7890000000109', ncm: '62046200', cfop: '5102', origin: '0', taxProfile: 'SIMPLES-102',
    });
    produto('p-sem-ncm', 'Blusa sem NCM', { barcode: '7890000000116', origin: '0', taxProfile: 'SIMPLES-102' });

    const [completo] = await buscar('7890000000109');
    expect(completo.fiscal_pendencias).toEqual([]);

    const [semNcm] = await buscar('7890000000116');
    // O CFOP vem do grupo (a mesma completação da emissão): só o NCM falta.
    expect(semNcm.fiscal_pendencias).toEqual(['NCM']);
  });

  it('produto com perfil tributário inexistente: "tributação"', async () => {
    updateFiscalConfig({ companyId: LOJA, patch: { cnpj: '11222333000181', crt: '1' } });
    grupoTributarioPadrao(LOJA);
    produto('p-perfil', 'Perfil que não existe', {
      barcode: '7890000000123', ncm: '62046200', cfop: '5102', origin: '0', taxProfile: 'NAO-EXISTE',
    });
    const [achado] = await buscar('7890000000123');
    expect(achado.fiscal_pendencias).toEqual(['tributação']);
  });

  it('operação sem CNPJ fiscal não emite NFC-e: nenhuma marca (ruído que o caixa aprenderia a ignorar)', async () => {
    produto('p-sem-nada', 'Sem fiscal', { barcode: '7890000000130' });
    const [achado] = await buscar('7890000000130');
    expect(achado.fiscal_pendencias).toEqual([]);
  });
});
