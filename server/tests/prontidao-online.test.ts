/**
 * O que falta para cada produto vender online.
 *
 * POR QUE ISTO IMPORTA
 *
 * Na base real, dos 18 produtos cadastrados apenas 5 apareciam na loja — e
 * NENHUM tinha foto ou medidas de envio. Sem um diagnóstico, "por que só cinco
 * itens aparecem?" é um mistério; com ele, vira uma lista de tarefas.
 *
 * A regra que este arquivo protege: publicar em massa NÃO pode colocar na
 * vitrine item sem foto (o cliente não compra) nem sem medida (o frete não
 * cota). Publicar assim faz a loja parecer quebrada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { listOnlineReadiness, publishReadyProducts } from '../src/services/core/CatalogService.js';

let gringa: string;

/** Produto com tudo no lugar; `falta` remove o que o teste quer testar. */
function produto(
  id: string,
  falta: ('preco' | 'foto' | 'medidas' | 'saldo' | 'publicacao')[] = [],
): void {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents, category,
        active, publish_online, weight_grams, height_cm, width_cm, length_cm,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, ?, 'Vestuário', 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    gringa,
    `PR-${id}`,
    `Produto ${id}`,
    falta.includes('preco') ? 0 : 10000,
    falta.includes('publicacao') ? 0 : 1,
    falta.includes('medidas') ? null : 800,
    falta.includes('medidas') ? null : 20,
    falta.includes('medidas') ? null : 30,
    falta.includes('medidas') ? null : 10,
    agora,
    agora,
  );

  if (!falta.includes('saldo')) {
    db.prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
    ).run(gringa, id, agora);
  }
  if (!falta.includes('foto')) {
    db.prepare(
      `INSERT INTO core_product_images (id, product_id, company_id, url, is_primary, position, created_at)
       VALUES (?, ?, ?, ?, 1, 0, ?)`,
    ).run(`img-${id}`, id, gringa, `/uploads/${id}.jpg`, agora);
  }
}

const linha = (id: string) => listOnlineReadiness(gringa).find((l) => l.id === id)!;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('diagnóstico por produto', () => {
  it('produto completo e publicado está vendendo', () => {
    produto('p-ok');
    expect(linha('p-ok').ready).toBe(true);
    expect(linha('p-ok').blockers).toEqual([]);
  });

  it('sem foto é AVISO: o produto publicado vende, e a tela avisa (GAP-PRD-207)', () => {
    // O PUT publica sem foto e a vitrine mostra "Foto em breve": chamar isso
    // de bloqueio era a segunda verdade sobre o mesmo produto.
    produto('p-1', ['foto']);
    expect(linha('p-1').blockers).not.toContain('sem_foto');
    expect(linha('p-1').warnings).toEqual(['sem_foto']);
    expect(linha('p-1').ready).toBe(true);
  });

  it('sem medidas é apontado — sem elas o frete não cota', () => {
    produto('p-1', ['medidas']);
    expect(linha('p-1').blockers).toContain('sem_medidas');
  });

  it('sem preço é apontado', () => {
    produto('p-1', ['preco']);
    expect(linha('p-1').blockers).toContain('sem_preco');
  });

  it('sem saldo é apontado', () => {
    produto('p-1', ['saldo']);
    expect(linha('p-1').blockers).toContain('sem_saldo');
  });

  it('um produto pode ter várias pendências ao mesmo tempo', () => {
    produto('p-1', ['foto', 'medidas', 'preco', 'saldo', 'publicacao']);
    const b = linha('p-1').blockers;
    expect(b).toEqual(
      expect.arrayContaining(['sem_medidas', 'sem_preco', 'sem_saldo', 'nao_publicado']),
    );
    expect(linha('p-1').warnings).toEqual(['sem_foto']);
  });

  it('modelo com grade não é vendável: quem vai à vitrine são as variantes', () => {
    produto('modelo');
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, parent_id, active, publish_online, created_at, updated_at)
         VALUES ('var-1', ?, 'PR-var', 'Variante P', 'UN', 4000, 10000, 'modelo', 1, 1, ?, ?)`,
      )
      .run(gringa, agora, agora);

    expect(linha('modelo').blockers).toContain('modelo_com_grade');
  });
});

describe('pronto para publicar', () => {
  it('só falta publicar quando o resto está no lugar', () => {
    produto('p-1', ['publicacao']);
    expect(linha('p-1').readyToPublish).toBe(true);
    expect(linha('p-1').blockers).toEqual(['nao_publicado']);
  });

  it('faltando só a foto é pronto para publicar, com o aviso junto (GAP-PRD-207)', () => {
    produto('p-1', ['publicacao', 'foto']);
    expect(linha('p-1').readyToPublish).toBe(true);
    expect(linha('p-1').warnings).toEqual(['sem_foto']);
  });

  it('sem pedido explícito, a publicação em massa não leva os sem foto', () => {
    produto('p-1', ['publicacao', 'foto']);
    const r = publishReadyProducts(gringa);
    expect(r.published).toEqual([]);
    expect(r.semFoto).toBe(1);
    expect(publishReadyProducts(gringa, { incluirSemFoto: true }).published).toEqual(['p-1']);
  });

  it('já publicado não aparece como pronto para publicar', () => {
    produto('p-1');
    expect(linha('p-1').readyToPublish).toBe(false);
  });
});

describe('publicação em massa', () => {
  it('publica os prontos e deixa os pendentes de fora', () => {
    produto('pronto-1', ['publicacao']);
    produto('pronto-2', ['publicacao']);
    produto('sem-foto', ['publicacao', 'foto']);
    produto('sem-medida', ['publicacao', 'medidas']);

    const r = publishReadyProducts(gringa);

    expect(r.published.sort()).toEqual(['pronto-1', 'pronto-2']);
    expect(r.skipped).toBe(2);
    // O que impede a compra continua fora da vitrine.
    expect(linha('sem-foto').publishOnline).toBe(false);
    expect(linha('sem-medida').publishOnline).toBe(false);
  });

  it('publicar duas vezes não muda nada na segunda', () => {
    produto('pronto-1', ['publicacao']);
    expect(publishReadyProducts(gringa).published).toHaveLength(1);
    expect(publishReadyProducts(gringa).published).toHaveLength(0);
  });

  it('sem nenhum pronto, não publica nada', () => {
    produto('sem-foto', ['publicacao', 'foto']);
    const r = publishReadyProducts(gringa);
    expect(r.published).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('o produto publicado passa a aparecer como vendendo', () => {
    produto('p-1', ['publicacao']);
    publishReadyProducts(gringa);
    expect(linha('p-1').ready).toBe(true);
  });
});

describe('isolamento entre operações', () => {
  it('a prontidão de uma loja não mostra produto da vizinha', async () => {
    const precoJusto = await upsertCompany({
      slug: 'preco-justo',
      tradeName: 'Preço Justo',
      legalName: 'PJ Ltda',
    });
    produto('p-gringa');

    expect(listOnlineReadiness(gringa).map((l) => l.id)).toContain('p-gringa');
    expect(listOnlineReadiness(precoJusto)).toHaveLength(0);
  });
});
