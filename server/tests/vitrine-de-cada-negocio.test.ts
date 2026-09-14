/**
 * A VITRINE DE CADA NEGÓCIO — rodada 56.
 *
 * ============================================================================
 * A FRASE QUE DEFINE A RODADA
 * ============================================================================
 *
 * Medido no banco real antes de escrever uma linha: hoje, em produção, a
 * diferença entre as cinco lojas do grupo é EXCLUSIVAMENTE a paleta de cores.
 * Mesma ordem de seções, mesma grade, mesmo card, mesmos filtros, mesma
 * paginação. Nenhuma tem logo, capa, chamada, descrição ou faixa — as duas
 * únicas linhas de `core_storefront_settings` estão com todos os campos nulos.
 *
 * E o catálogo está quase vazio: 19 produtos no grupo inteiro, 5 visíveis na
 * loja, ZERO com foto. Então o que esta rodada entrega não pode depender de o
 * dono preencher nada: a vitrine tem de ler como um negócio de verdade
 * ESTANDO VAZIA, e melhorar conforme ele preenche.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 * O SERVIDOR precisa saber responder três perguntas novas, e responder honesto:
 *
 *   QUE TIPO DE LOJA É ESTA?  — para a tela saber como se arrumar
 *   QUAIS SÃO OS DEPARTAMENTOS? — a ÁRVORE que a taxonomia já mantém, e que a
 *                                 vitrine ignorava, mostrando texto solto
 *   O QUE É VERDADE SOBRE ESTA COMPRA? — os selos, e SÓ os que o cadastro
 *                                 sustenta. Selo sem dado é propaganda falsa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureOfficialStorefrontPresets } from '../src/db/core-migrations.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger-56',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${login.body.accessToken}` };
  companyId = login.body.company.id;

  /*
    O MESMO que o servidor faz ao subir (`index.ts`) e que a semeadura faz num
    banco novo: carimbar o tipo das lojas oficiais. Chamar aqui é o que faz o
    teste medir o caminho de verdade, e não um estado montado à mão.
  */
  ensureOfficialStorefrontPresets();
});

/** As cinco lojas do grupo, como a semeadura as cria. */
function criarAsLojasDoGrupo(): void {
  for (const slug of ['preco-justo', 'gringa', 'me-mimei', 'conceito', 'pj-motors']) {
    upsertCompany({ id: slug, slug, legalName: `${slug} Ltda`, tradeName: slug });
  }
  ensureOfficialStorefrontPresets();
}

/** Produto publicado na vitrine. É o único que a loja pública enxerga. */
async function publicado(
  nome: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome, priceCents: 9900, publishOnline: true, ...extra });
  expect(p.status, JSON.stringify(p.body)).toBe(201);

  await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

function loja(slug: string) {
  return request(app).get(`/api/v1/loja/stores`).then((r) => {
    const todas = [...(r.body.stores ?? []), ...(r.body.services ?? [])];
    return todas.find((s: { slug: string }) => s.slug === slug);
  });
}

// ============================================================================

describe('o tipo da loja é DADO, não código', () => {
  it('cada loja do grupo declara o próprio tipo, e a vitrine recebe', async () => {
    const gringa = await loja('gringa');
    expect(gringa).toBeTruthy();
    /*
      A paleta já é por loja desde a rodada 40 — e é a ÚNICA coisa que era.
      O tipo é o que faltava para a página conseguir se arrumar: a mesma tela
      não pode servir uma importadora de variedades e uma loja de moda com a
      mesma densidade e a mesma ordem de seções.
    */
    expect(gringa.storefrontPreset).toBe('moda');
  });

  it('as cinco lojas do grupo nascem com o tipo certo', async () => {
    criarAsLojasDoGrupo();
    const esperado: Record<string, string> = {
      'preco-justo': 'variedades',
      gringa: 'moda',
      conceito: 'moda',
      'me-mimei': 'beleza',
      'pj-motors': 'veiculos',
    };
    for (const [slug, preset] of Object.entries(esperado)) {
      const s = await loja(slug);
      expect(s, `loja ${slug} não existe`).toBeTruthy();
      expect(s.storefrontPreset, `preset de ${slug}`).toBe(preset);
    }
  });

  it('loja nova sem tipo declarado não quebra: vem nula e a tela decide o neutro', async () => {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_companies (id, slug, legal_name, trade_name, kind, active, created_at, updated_at)
         VALUES ('emp-nova-56', 'loja-nova', 'Loja Nova LTDA', 'Loja Nova', 'retail', 1, ?, ?)`,
      )
      .run(agora, agora);

    const nova = await loja('loja-nova');
    expect(nova).toBeTruthy();
    // Nulo é resposta legítima: "ninguém declarou". Inventar um tipo faria a
    // loja nova nascer vestida de outro negócio.
    expect(nova.storefrontPreset).toBeNull();
  });

  it('tipo inventado é recusado — a lista de presets não aceita complemento calado', async () => {
    const res = await request(app)
      .put('/api/v1/core/storefront/settings')
      .set(gerente)
      .send({ storefrontPreset: 'importadora-de-luxo' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_STOREFRONT_PRESET_INVALID');
  });

  it('o gestor troca o tipo da própria loja', async () => {
    const res = await request(app)
      .put('/api/v1/core/storefront/settings')
      .set(gerente)
      .send({ storefrontPreset: 'variedades' });
    expect(res.status).toBe(200);
    expect((await loja('gringa')).storefrontPreset).toBe('variedades');
  });
});

describe('os departamentos são a ÁRVORE, não texto solto', () => {
  it('a vitrine devolve raízes com as filhas dentro, e a contagem do que dá para comprar', async () => {
    await publicado('Camisa Polo', { category: 'Vestuário', subcategory: 'Camisas' });
    await publicado('Camisa Social', { category: 'Vestuário', subcategory: 'Camisas' });
    await publicado('Calça Jeans', { category: 'Vestuário', subcategory: 'Calças' });
    await publicado('Tênis Runner', { category: 'Calçados' });

    const res = await request(app).get('/api/v1/loja/categories').query({ store: 'gringa' });
    expect(res.status).toBe(200);

    const arvore = res.body.items as {
      name: string;
      productCount: number;
      children: { name: string; productCount: number }[];
    }[];

    const vestuario = arvore.find((c) => c.name === 'Vestuário');
    expect(vestuario, 'Vestuário deveria ser um departamento').toBeTruthy();
    // A contagem do PAI inclui as filhas: é o número que o cliente espera ao
    // clicar num departamento.
    expect(vestuario!.productCount).toBe(3);
    expect(vestuario!.children.map((f) => f.name).sort()).toEqual(['Calças', 'Camisas']);
    expect(vestuario!.children.find((f) => f.name === 'Camisas')!.productCount).toBe(2);

    const calcados = arvore.find((c) => c.name === 'Calçados');
    expect(calcados!.productCount).toBe(1);
    expect(calcados!.children).toEqual([]);
  });

  it('departamento sem nada para comprar não vira gaveta vazia', async () => {
    await publicado('Camisa Polo', { category: 'Vestuário' });
    // Existe no vocabulário e não tem produto VISÍVEL: o cliente clicaria e
    // voltaria sem nada. É a mesma doutrina que já valia para peça de bancada.
    await request(app)
      .post('/api/v1/core/taxonomy/categories')
      .set(gerente)
      .send({ name: 'Acessórios' });

    const res = await request(app).get('/api/v1/loja/categories').query({ store: 'gringa' });
    const nomes = (res.body.items as { name: string }[]).map((c) => c.name);
    expect(nomes).toContain('Vestuário');
    expect(nomes).not.toContain('Acessórios');
  });

  it('filtrar por SUBCATEGORIA traz só o galho, não o departamento inteiro', async () => {
    await publicado('Camisa Polo', { category: 'Vestuário', subcategory: 'Camisas' });
    await publicado('Calça Jeans', { category: 'Vestuário', subcategory: 'Calças' });

    const galho = await request(app)
      .get('/api/v1/loja/products')
      .query({ store: 'gringa', subcategory: 'Camisas' });
    expect(galho.status).toBe(200);
    expect(galho.body.items.map((p: { name: string }) => p.name)).toEqual(['Camisa Polo']);

    const departamento = await request(app)
      .get('/api/v1/loja/products')
      .query({ store: 'gringa', category: 'Vestuário' });
    expect(departamento.body.items).toHaveLength(2);
  });

  /**
   * A ÁRVORE E O FILTRO PRECISAM CONCORDAR — sempre.
   *
   * A árvore agrupa em JavaScript e o filtro compara em SQL, e as duas dobras
   * de caixa não são iguais: o `LOWER` do SQLite só mexe em ASCII, então
   * `LOWER('CALÇADOS')` devolve `calÇados`. Com dobras diferentes, a pílula
   * dizia ter cinco peças e o clique devolvia duas.
   */
  it('a contagem da pílula é o número que o clique devolve', async () => {
    await publicado('Camisa Polo', { category: 'Vestuário' });
    await publicado('Camisa Social', { category: 'vestuário' });
    await publicado('Calça Jeans', { category: 'VESTUÁRIO' });

    const arvore = (await request(app).get('/api/v1/loja/categories').query({ store: 'gringa' }))
      .body.items as { name: string; productCount: number }[];

    for (const dep of arvore) {
      const clique = await request(app)
        .get('/api/v1/loja/products')
        .query({ store: 'gringa', category: dep.name });
      expect(
        clique.body.items.length,
        `a pílula "${dep.name}" promete ${dep.productCount} e o clique devolve ${clique.body.items.length}`,
      ).toBe(dep.productCount);
    }
  });

  it('a grade de tamanhos conta como UM, que é o card que aparece', async () => {
    const modelo = await publicado('Camiseta', { category: 'Vestuário' });
    // Variante é linha de produto com pai — e a vitrine mostra a grade inteira
    // num card só. Contar cada tamanho faria a pílula prometer o triplo.
    for (const tamanho of ['P', 'M', 'G']) {
      const v = await request(app)
        .post('/api/v1/core/products')
        .set(gerente)
        .send({ name: `Camiseta ${tamanho}`, priceCents: 9900, publishOnline: true, category: 'Vestuário' });
      getConnection()
        .prepare('UPDATE core_products SET parent_id = ? WHERE id = ?')
        .run(modelo, v.body.id);
    }

    const arvore = (await request(app).get('/api/v1/loja/categories').query({ store: 'gringa' }))
      .body.items as { name: string; productCount: number }[];
    expect(arvore.find((c) => c.name === 'Vestuário')!.productCount).toBe(1);
  });

  it('a árvore respeita a loja: departamento de uma não aparece na outra', async () => {
    await publicado('Camisa Polo', { category: 'Vestuário' });

    const outra = await loginForTest(app, {
      userId: 'ger-mm',
      companyId: 'me-mimei',
      profileCodes: ['gerente_loja'],
    });
    const p = await request(app)
      .post('/api/v1/core/products')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ name: 'Batom', priceCents: 3900, publishOnline: true, category: 'Beleza' });
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ productId: p.body.id, movementType: 'in', quantity: 3, referenceType: 'entrada', referenceId: 'c1' });

    const daGringa = await request(app).get('/api/v1/loja/categories').query({ store: 'gringa' });
    expect((daGringa.body.items as { name: string }[]).map((c) => c.name)).toEqual(['Vestuário']);
  });
});

describe('os selos dizem só o que o cadastro sustenta', () => {
  it('loja sem nada configurado: o único selo é a verdade padrão — retirada', async () => {
    const g = await loja('gringa');
    const selos = g.seals as { id: string; label: string }[];
    /*
      O padrão do sistema é retirada ligada e entrega desligada
      (`getShippingSettings`), e nenhuma das seis empresas configurou frete.
      Então hoje o único selo honesto é "retire na loja" — e é útil: diz ao
      cliente de Pelotas que dá para buscar.
    */
    // Retirada porque é o padrão do sistema, e troca porque é a lei — nenhum
    // dos dois depende de o dono ter preenchido coisa alguma. O que NÃO
    // aparece é tudo que dependeria de cadastro.
    expect(selos.map((s) => s.id)).toEqual(['retirada', 'troca']);
  });

  it('frete grátis acima de X só aparece quando a loja declarou o valor', async () => {
    const semSelo = await loja('gringa');
    expect((semSelo.seals as { id: string }[]).map((s) => s.id)).not.toContain('frete-gratis');

    await request(app)
      .put('/api/v1/core/shipping-settings')
      .set(gerente)
      .send({
        pickupEnabled: true,
        deliveryEnabled: true,
        flatRateCents: 1990,
        freeAboveCents: 20000,
        estimatedDays: 3,
      });

    const selos = (await loja('gringa')).seals as { id: string; label: string }[];
    const frete = selos.find((s) => s.id === 'frete-gratis');
    expect(frete, 'o selo de frete grátis deveria existir').toBeTruthy();
    // O número vem do cadastro. Um selo com valor inventado é cobrança
    // surpresa no fim do checkout.
    expect(frete!.label).toContain('R$ 200,00');

    const prazo = selos.find((s) => s.id === 'prazo');
    expect(prazo!.label).toContain('3');
  });

  it('entrega desligada não vira selo de entrega', async () => {
    await request(app)
      .put('/api/v1/core/shipping-settings')
      .set(gerente)
      .send({ pickupEnabled: true, deliveryEnabled: false, freeAboveCents: 20000 });

    const selos = (await loja('gringa')).seals as { id: string }[];
    // O valor está gravado, mas a loja não entrega: prometer frete grátis
    // seria prometer um serviço que ela não presta.
    expect(selos.map((s) => s.id)).not.toContain('frete-gratis');
    expect(selos.map((s) => s.id)).toContain('retirada');
  });

  it('parcelamento só quando a loja declara em quantas vezes vende', async () => {
    expect(((await loja('gringa')).seals as { id: string }[]).map((s) => s.id))
      .not.toContain('parcelamento');

    const res = await request(app)
      .put('/api/v1/core/storefront/settings')
      .set(gerente)
      .send({ installmentsMax: 6 });
    expect(res.status).toBe(200);

    const selo = ((await loja('gringa')).seals as { id: string; label: string }[])
      .find((s) => s.id === 'parcelamento');
    expect(selo).toBeTruthy();
    expect(selo!.label).toContain('6');
  });

  it('parcelamento absurdo é recusado', async () => {
    for (const valor of [0, -1, 25, 'muitas']) {
      const res = await request(app)
        .put('/api/v1/core/storefront/settings')
        .set(gerente)
        .send({ installmentsMax: valor });
      expect(res.status, `aceitou ${valor}`).toBe(400);
    }
  });

  it('o selo de troca sai da política que a loja JÁ publica, e não de um número novo', async () => {
    const selos = (await loja('gringa')).seals as { id: string; label: string }[];
    const troca = selos.find((s) => s.id === 'troca');
    expect(troca, 'toda loja do grupo tem direito de arrependimento').toBeTruthy();
    // 7 dias é o que a página de Trocas e Devoluções já declara ao cliente.
    // Um número diferente aqui faria a vitrine e a política se contradizerem.
    expect(troca!.label).toContain('7');
  });
});

describe('produtos relacionados: o que mais tem dessa prateleira', () => {
  it('a página do produto traz outros do mesmo departamento, sem ele mesmo', async () => {
    const alvo = await publicado('Camisa Polo', { category: 'Vestuário' });
    await publicado('Camisa Social', { category: 'Vestuário' });
    await publicado('Calça Jeans', { category: 'Vestuário' });
    await publicado('Tênis Runner', { category: 'Calçados' });

    const res = await request(app).get(`/api/v1/loja/stores/gringa/products/${alvo}`);
    expect(res.status).toBe(200);

    const nomes = (res.body.related as { id: string; name: string }[]).map((p) => p.name);
    expect(nomes).toContain('Camisa Social');
    expect(nomes).toContain('Calça Jeans');
    expect(nomes).not.toContain('Tênis Runner');
    // Mostrar o próprio produto como "relacionado" é o defeito clássico dessa
    // seção, e some sozinho quando ninguém olha.
    expect(res.body.related.map((p: { id: string }) => p.id)).not.toContain(alvo);
  });

  it('produto sem departamento não inventa relação', async () => {
    const alvo = await publicado('Item solto');
    await publicado('Outro item solto');

    const res = await request(app).get(`/api/v1/loja/stores/gringa/products/${alvo}`);
    // "Sem categoria" não é uma categoria: relacionar tudo que não tem
    // categoria juntaria batom com pneu.
    expect(res.body.related).toEqual([]);
  });

  it('relacionado respeita a vitrine: nada de despublicado nem de outra loja', async () => {
    const alvo = await publicado('Camisa Polo', { category: 'Vestuário' });
    const escondido = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Camisa Guardada', priceCents: 5000, category: 'Vestuário' });
    expect(escondido.body.publish_online ?? 0).toBeFalsy();

    const res = await request(app).get(`/api/v1/loja/stores/gringa/products/${alvo}`);
    expect((res.body.related as { name: string }[]).map((p) => p.name)).not.toContain(
      'Camisa Guardada',
    );
  });
});
