/**
 * ============================================================================
 * O CADASTRO DO PRODUTO GANHA MEMÓRIA, EMBALAGEM E CAMPOS PRÓPRIOS
 * ============================================================================
 *
 * Três buracos do mesmo cadastro, fechados juntos porque a tela é uma só.
 *
 * ## GAP-V05 — o histórico não dizia O QUE mudou
 *
 * `PUT /products/:id` gravava `recordAudit` sem `detail` nenhum. No banco real
 * são vinte registros de `product.update` que provam que ALGUÉM mexeu e não
 * respondem "quem baixou o preço de 39,90 para 29,90". Pior: a AuditoriaPage é
 * restrita aos donos do grupo, então nem o registro pobre chegava a quem cuida
 * do catálogo.
 *
 * O diff é montado comparando as LINHAS GRAVADAS, antes e depois — e não o
 * corpo da requisição contra o banco. A diferença decide se a trilha diz a
 * verdade: o formulário manda o objeto inteiro toda vez, e o servidor normaliza
 * (maiúsculas, vazio virando nulo, o par tipo/oficina). Um diff sobre o corpo
 * listaria quarenta alterações onde houve uma.
 *
 * ## GAP-V06 — o fator da caixa era redigitado a cada nota
 *
 * `conversion_factor` vivia só na LINHA da nota de entrada. Um 1 no lugar de 12
 * multiplica estoque e custo em silêncio, e o erro só aparece no inventário
 * seguinte. Agora ele é atributo do cadastro e serve de PADRÃO sugerido.
 *
 * ## GAP-V07 — não havia onde pôr voltagem, aro, validade de garantia
 *
 * Zero ocorrências de campo personalizado no repositório. `variant_attributes`
 * não serve: aquele é da GRADE, e cada valor dele vira um produto próprio com
 * EAN e saldo.
 *
 * ## COMO CADA GUARDA FALHA
 *
 *  - tire o `detail: { fields: diferencasDoProduto(...) }` da rota e a trilha
 *    volta a dizer só que houve alteração;
 *  - compare o CORPO em vez das linhas gravadas e o caso "salvar sem mexer em
 *    nada" passa a listar campos que ninguém tocou;
 *  - tire a recusa de `fatorDeEmbalagem` e "caixa com 0" entra no cadastro;
 *  - aceite código inexistente em `setCustomValues` e o valor digitado some
 *    com a tela dizendo "salvo".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { loginForTest } = await import('./helpers/auth.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { diferencasDoProduto, getProduct, productHistory } = await import(
  '../src/services/core/CatalogService.js'
);
const {
  deleteCustomField,
  listCustomValues,
  setCustomValues,
  upsertCustomField,
} = await import('../src/services/core/CatalogAuxService.js');

const app = createApp();
const LOJA = 'loja-do-cadastro';

let gerente: Record<string, string>;
let produtoId: string;

interface Mudanca {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

async function salvar(body: Record<string, unknown>) {
  const res = await request(app)
    .put(`/api/v1/core/products/${produtoId}`)
    .set(gerente)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** O detalhe da ÚLTIMA alteração gravada na trilha central. */
function ultimoDiff(): Mudanca[] {
  const linha = getConnection()
    .prepare(
      `SELECT detail FROM core_audit_log
        WHERE company_id = ? AND action = 'product.update'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(LOJA) as { detail: string | null } | undefined;
  return JSON.parse(linha?.detail ?? '{"fields":[]}').fields as Mudanca[];
}

function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava recusa, e passou');
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };

  const criado = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: 'Camiseta Polo', priceCents: 3990, costCents: 2000 })
    .expect(201);
  produtoId = String(criado.body.id);
});

describe('a trilha diz O QUE mudou (GAP-V05)', () => {
  it('a baixa de preço fica registrada de → para, EM REAIS', async () => {
    await salvar({ priceCents: 2990 });

    const campos = ultimoDiff();
    expect(campos).toHaveLength(1);
    // O rótulo é para gente ler; o campo é para a máquina filtrar.
    expect(campos[0]).toEqual({
      field: 'price_cents',
      label: 'Preço de venda',
      from: '39,90',
      to: '29,90',
    });
  });

  it('salvar SEM mexer em nada grava lista vazia — e isso é a verdade', async () => {
    await salvar({ name: 'Camiseta Polo', priceCents: 3990, costCents: 2000 });
    expect(ultimoDiff()).toEqual([]);
  });

  it('o formulário manda o objeto INTEIRO e só o que mudou entra na trilha', async () => {
    // Quarenta campos iguais aos que já estão gravados, e UM diferente. Uma
    // trilha montada sobre o corpo da requisição listaria todos.
    await salvar({
      name: 'Camiseta Polo',
      priceCents: 3990,
      costCents: 2000,
      minStock: 0,
      unit: 'UN',
      active: true,
      publishOnline: false,
      openPrice: false,
      weighable: false,
      serialized: false,
      stockControl: true,
      pluCode: '',
      taxProfile: '',
      brand: 'Polo Norte',
    });

    const campos = ultimoDiff();
    expect(campos.map((c) => c.field)).toEqual(['brand']);
    expect(campos[0].from).toBeNull();
    expect(campos[0].to).toBe('Polo Norte');
  });

  it('várias mudanças no mesmo salvar viram várias linhas', async () => {
    await salvar({ priceCents: 4500, costCents: 2500, name: 'Camiseta Polo Premium' });
    const campos = ultimoDiff();
    expect(campos.map((c) => c.field).sort()).toEqual(['cost_cents', 'name', 'price_cents']);
  });

  it('GET /products/:id/history devolve quem, quando e o quê', async () => {
    await salvar({ priceCents: 2990 });

    const res = await request(app)
      .get(`/api/v1/core/products/${produtoId}/history`)
      .set(gerente)
      .expect(200);

    const evento = res.body.items[0];
    expect(evento.action).toBe('product.update');
    // O NOME de quem alterou, não o UUID: um id cru não responde a pergunta.
    expect(evento.user_name).toBe('gerente');
    expect(evento.fields[0].label).toBe('Preço de venda');
    expect(evento.fields[0].from).toBe('39,90');
  });

  it('registro antigo SEM detalhe não derruba a aba — e diz que não sabe', () => {
    // Exatamente o formato das vinte linhas do banco real: sem `detail`.
    getConnection()
      .prepare(
        `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
         VALUES ('a-velha', ?, NULL, 'product.update', 'product', ?, NULL, ?)`,
      )
      .run(LOJA, produtoId, new Date().toISOString());

    const historico = productHistory(LOJA, produtoId);
    const velha = historico.find((h) => h.id === 'a-velha')!;
    expect(velha.fields).toEqual([]);
  });

  it('detalhe ilegível também não derruba: a trilha é append-only e tem de tudo', () => {
    getConnection()
      .prepare(
        `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
         VALUES ('a-torta', ?, NULL, 'product.update', 'product', ?, '{isso não é json', ?)`,
      )
      .run(LOJA, produtoId, new Date().toISOString());

    expect(() => productHistory(LOJA, produtoId)).not.toThrow();
  });

  it('o histórico NÃO cruza empresa nem produto', async () => {
    await salvar({ priceCents: 2990 });
    // Outro produto da mesma loja não herda a trilha do primeiro.
    const outro = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Boné' })
      .expect(201);
    expect(productHistory(LOJA, String(outro.body.id))).toHaveLength(1); // só o product.create
    expect(productHistory('gringa-co', produtoId)).toHaveLength(0);
  });

  it('diferencasDoProduto ignora carimbo e identidade — só decisão entra', () => {
    const antes = { id: 'x', company_id: 'c', name: 'A', updated_at: '1', price_cents: 100 };
    const depois = { id: 'x', company_id: 'c', name: 'A', updated_at: '2', price_cents: 100 };
    // `updated_at` muda em TODO salvar e não é decisão de ninguém. Uma lista
    // automática de colunas encheria a trilha de ruído.
    expect(diferencasDoProduto(antes, depois)).toEqual([]);
  });

  it('vazio, nulo e ausente são a MESMA coisa para quem lê a trilha', () => {
    expect(diferencasDoProduto({ brand: null }, { brand: '' })).toEqual([]);
    expect(diferencasDoProduto({ brand: '  ' }, { brand: null })).toEqual([]);
  });
});

describe('a embalagem vira atributo do cadastro (GAP-V06)', () => {
  it('o fator é gravado e volta na ficha', async () => {
    await salvar({ packFactor: 12, packUnit: 'cx' });
    const produto = getProduct(LOJA, produtoId)!;
    expect(produto.pack_factor).toBe(12);
    // A sigla sobe em maiúsculas: é assim que ela chega no XML do fornecedor.
    expect(produto.pack_unit).toBe('CX');
  });

  it('a mudança da embalagem entra na trilha, com rótulo legível', async () => {
    await salvar({ packFactor: 12, packUnit: 'CX' });
    const campos = ultimoDiff();
    expect(campos.map((c) => c.label).sort()).toEqual([
      'Sigla da embalagem',
      'Unidades por embalagem',
    ]);
  });

  it('vazio LIMPA — "este produto não vem mais em caixa"', async () => {
    await salvar({ packFactor: 12, packUnit: 'CX' });
    await salvar({ packFactor: null, packUnit: '' });
    const produto = getProduct(LOJA, produtoId)!;
    expect(produto.pack_factor).toBeNull();
    expect(produto.pack_unit).toBeNull();
  });

  it('ausente PRESERVA: corrigir o preço não apaga a embalagem', async () => {
    await salvar({ packFactor: 12, packUnit: 'CX' });
    await salvar({ priceCents: 4990 });
    expect(getProduct(LOJA, produtoId)?.pack_factor).toBe(12);
  });

  it('caixa com 0, com 1 ou fracionada é RECUSADA', async () => {
    for (const fator of [0, 1, -12, 12.5]) {
      const res = await request(app)
        .put(`/api/v1/core/products/${produtoId}`)
        .set(gerente)
        .send({ packFactor: fator });
      expect(res.status, `fator ${fator} passou`).toBe(400);
      expect(res.body.error.code).toBe('CORE_INVALID_PACK_FACTOR');
    }
    // E o cadastro continua intocado: recusa que grava metade é pior que recusa.
    expect(getProduct(LOJA, produtoId)?.pack_factor).toBeNull();
  });
});

describe('campos próprios da operação (GAP-V07)', () => {
  beforeEach(() => {
    upsertCustomField(LOJA, { code: 'VOLTAGEM', label: 'Voltagem', kind: 'select', options: '110V\n220V\nBivolt' });
    upsertCustomField(LOJA, { code: 'ARO', label: 'Aro', kind: 'number' });
  });

  it('a ficha do produto lista os campos ATIVOS, mesmo sem valor nenhum', () => {
    const ficha = listCustomValues(LOJA, produtoId);
    expect(ficha.map((c) => c.code).sort()).toEqual(['ARO', 'VOLTAGEM']);
    // Vazio é a resposta certa: o formulário precisa mostrar o campo para que
    // alguém possa preenchê-lo. Listar só o preenchido faria o campo novo
    // nunca aparecer.
    expect(ficha.every((c) => c.value === null)).toBe(true);
  });

  it('o valor é gravado e volta', async () => {
    const res = await request(app)
      .put(`/api/v1/core/products/${produtoId}/custom-fields`)
      .set(gerente)
      .send({ values: { VOLTAGEM: 'Bivolt', ARO: '26' } })
      .expect(200);

    const porCodigo = Object.fromEntries(
      (res.body.values as { code: string; value: string | null }[]).map((c) => [c.code, c.value]),
    );
    expect(porCodigo.VOLTAGEM).toBe('Bivolt');
    expect(porCodigo.ARO).toBe('26');
  });

  it('opção fora da lista é recusada, dizendo quais existem', () => {
    const erro = erroDe(() => setCustomValues(LOJA, produtoId, { VOLTAGEM: '380V' }));
    expect(erro.code).toBe('CORE_CUSTOM_FIELD_VALUE');
    expect(erro.message).toContain('110V, 220V, Bivolt');
  });

  it('texto num campo numérico é recusado — o erro para perto de quem digitou', () => {
    expect(erroDe(() => setCustomValues(LOJA, produtoId, { ARO: 'vinte e seis' })).code).toBe(
      'CORE_CUSTOM_FIELD_VALUE',
    );
  });

  it('data exige AAAA-MM-DD: campo de produto responde "que dia", não "que momento"', () => {
    upsertCustomField(LOJA, { code: 'VALIDADE', label: 'Validade', kind: 'date' });
    expect(erroDe(() => setCustomValues(LOJA, produtoId, { VALIDADE: '31/12/2026' })).code).toBe(
      'CORE_CUSTOM_FIELD_VALUE',
    );
    setCustomValues(LOJA, produtoId, { VALIDADE: '2026-12-31' });
    expect(listCustomValues(LOJA, produtoId).find((c) => c.code === 'VALIDADE')?.value).toBe(
      '2026-12-31',
    );
  });

  it('CÓDIGO INEXISTENTE é recusa, e não silêncio', () => {
    // Ignorar seria a requisição que devolve 200 e não faz: quem digitou
    // "voltage" veria "salvo" e o valor não estaria em lugar nenhum.
    const erro = erroDe(() => setCustomValues(LOJA, produtoId, { VOLTAGE: 'Bivolt' }));
    expect(erro.code).toBe('CORE_CUSTOM_FIELD_NOT_FOUND');
    expect(erro.message).toContain('VOLTAGE');
  });

  it('valor vazio LIMPA, e o campo continua na ficha para ser preenchido de novo', () => {
    setCustomValues(LOJA, produtoId, { ARO: '26' });
    setCustomValues(LOJA, produtoId, { ARO: '' });
    const ficha = listCustomValues(LOJA, produtoId);
    expect(ficha.find((c) => c.code === 'ARO')?.value).toBeNull();
    expect(ficha).toHaveLength(2);
  });

  it('o mapa só escreve o que MENCIONA — omissão não apaga', () => {
    setCustomValues(LOJA, produtoId, { ARO: '26', VOLTAGEM: 'Bivolt' });
    setCustomValues(LOJA, produtoId, { ARO: '29' });
    const ficha = listCustomValues(LOJA, produtoId);
    expect(ficha.find((c) => c.code === 'VOLTAGEM')?.value).toBe('Bivolt');
    expect(ficha.find((c) => c.code === 'ARO')?.value).toBe('29');
  });

  it('o CÓDIGO é imutável, e o RÓTULO se corrige sem perder o preenchido', () => {
    const campo = upsertCustomField(LOJA, { code: 'VOLTAGEN', label: 'Voltagen', kind: 'text' });
    setCustomValues(LOJA, produtoId, { VOLTAGEN: '110V' });

    expect(
      erroDe(() => upsertCustomField(LOJA, { id: campo.id, code: 'OUTRO', label: 'x' })).code,
    ).toBe('CORE_CUSTOM_FIELD_CODE_IMMUTABLE');

    upsertCustomField(LOJA, { id: campo.id, code: 'VOLTAGEN', label: 'Voltagem', kind: 'text' });
    expect(listCustomValues(LOJA, produtoId).find((c) => c.code === 'VOLTAGEN')?.value).toBe(
      '110V',
    );
  });

  it('campo JÁ PREENCHIDO não é apagado por engano — desative em vez de excluir', () => {
    const campo = upsertCustomField(LOJA, { code: 'GARANTIA', label: 'Garantia', kind: 'text' });
    setCustomValues(LOJA, produtoId, { GARANTIA: '12 meses' });

    const erro = erroDe(() => deleteCustomField(LOJA, campo.id));
    expect(erro.code).toBe('CORE_CUSTOM_FIELD_IN_USE');
    expect(erro.message).toContain('1 produto');
  });

  it('campo de LISTA sem opção nenhuma é um seletor vazio — recusado', () => {
    expect(
      erroDe(() => upsertCustomField(LOJA, { code: 'COR', label: 'Cor', kind: 'select' })).code,
    ).toBe('CORE_CUSTOM_FIELD_OPTIONS');
  });

  it('a definição NÃO vaza entre empresas', () => {
    expect(listCustomValues('gringa-co', produtoId)).toHaveLength(0);
  });

  it('a gravação deixa rastro na trilha, com os códigos mexidos', async () => {
    await request(app)
      .put(`/api/v1/core/products/${produtoId}/custom-fields`)
      .set(gerente)
      .send({ values: { ARO: '26' } })
      .expect(200);

    const linha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'product.custom_fields.set'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(LOJA) as { detail: string };
    /*
      O FORMATO MUDOU DE PROPÓSITO (A-produto-18). A trilha guardava só os
      CÓDIGOS (`{ fields: ['ARO'] }`), e a aba Histórico, que desenha
      `label: from → to`, mostrava ": — → —" a cada Salvar do produto. Agora o
      registro tem o mesmo formato do `product.update` — a voltagem e o aro são
      atributos do produto como o preço —, e salvar sem mudar nada não grava.
    */
    expect(JSON.parse(linha.detail)).toEqual({
      fields: [{ field: 'custom:ARO', label: 'Aro', from: null, to: '26' }],
    });
  });
});
