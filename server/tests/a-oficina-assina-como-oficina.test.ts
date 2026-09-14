/**
 * O PAPEL DIZ O NOME DE QUEM O ASSINA.
 *
 * ============================================================================
 * O DEFEITO QUE O DONO APONTOU
 * ============================================================================
 *
 * "A Ordem de Serviço da OFICINA está imprimindo PJ MOTORS."
 *
 * A causa está no dado: `core_workshops.brand_company_id` da bancada de
 * mobilidade aponta para `pj-motors`. E a causa da causa está numa MIGRAÇÃO,
 * que cravava esse vínculo em código e o REIMPUNHA a cada execução — de modo
 * que corrigir pela tela duraria até a próxima migração rodar.
 *
 * O comentário do módulo defendia a escolha com um raciocínio de negócio:
 * "quem o cliente conhece, quem vendeu a moto e quem responde pela garantia é
 * a PJ Motors". É um raciocínio legítimo, e o dono decidiu o contrário: a
 * Oficina assina como Oficina. Decisão de negócio é dele; o que o código deve
 * garantir é que ela seja CONFIGURÁVEL e não volte sozinha.
 *
 * ============================================================================
 * E O FALLBACK QUE ESCONDIA CONFIGURAÇÃO FALTANDO
 * ============================================================================
 *
 * `nome: empresa?.trade_name || empresa?.legal_name || 'Grupo Sampaio'`
 *
 * Empresa sem nome imprimia "Grupo Sampaio" — que não é nenhuma das seis, não
 * tem CNPJ e não responde por garantia nenhuma. Um papel com identidade
 * genérica parece certo e não é conferível: o cliente leva para casa um
 * documento que não diz de quem ele é.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { renderServiceOrderA4 } = await import('../src/services/core/ServiceOrderA4.js');
const { definirMarcaDaBancada } = await import('../src/services/core/WorkshopBrandService.js');

let oficina: string;
let pjMotors: string;
let precoJusto: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  oficina = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Ltda',
    tradeName: 'Oficina',
    kind: 'workshop',
  });
  pjMotors = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
});

/** Uma bancada da empresa, com a marca que se quiser. */
function bancada(companyId: string, slug: string, brandCompanyId: string | null): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, brand_company_id, active, created_at)
       VALUES (?, ?, ?, ?, 'mobility', ?, 1, ?)`,
    )
    .run(id, companyId, slug, `Bancada ${slug}`, brandCompanyId, new Date().toISOString());
  return id;
}

/** Uma OS aberta naquela bancada. */
function ordem(companyId: string, workshopId: string | null): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const numero =
    Number(
      (
        getConnection()
          .prepare(
            'SELECT COALESCE(MAX(number), 0) AS n FROM core_service_orders WHERE company_id = ?',
          )
          .get(companyId) as { n: number }
      ).n,
    ) + 1;
  getConnection()
    .prepare(
      `INSERT INTO core_service_orders
         (id, company_id, workshop_id, number, status, complaint, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'recebido', 'Não liga', ?, ?)`,
    )
    .run(id, companyId, workshopId, numero, agora, agora);
  return id;
}

// ============================================================================

describe('a identidade impressa é a que a bancada declara', () => {
  it('a Oficina assina como Oficina', () => {
    const b = bancada(oficina, 'oficina-mobilidade', null);
    const papel = renderServiceOrderA4(oficina, ordem(oficina, b));

    expect(papel.marca).toBe('Oficina');
    expect(papel.html).toContain('Oficina');
    expect(papel.html).not.toContain('PJ Motors');
  });

  it('a bancada que declara outra marca assina com ela — o vínculo é configuração', () => {
    /*
      A capacidade continua existindo: uma bancada PODE assinar em nome de
      outra operação do grupo, e há razão de negócio para isso (quem vendeu a
      moto responde pela garantia). O que mudou é que a escolha é do dono, e
      não uma constante em migração.
    */
    const b = bancada(oficina, 'oficina-mobilidade', pjMotors);
    const papel = renderServiceOrderA4(oficina, ordem(oficina, b));

    expect(papel.marca).toBe('PJ Motors');
  });

  it('a bancada de celulares da Preço Justo assina como Preço Justo', () => {
    const b = bancada(precoJusto, 'oficina-celulares', null);
    expect(renderServiceOrderA4(precoJusto, ordem(precoJusto, b)).marca).toBe('Preço Justo');
  });

  it('OS sem bancada assina com a empresa dela', () => {
    expect(renderServiceOrderA4(oficina, ordem(oficina, null)).marca).toBe('Oficina');
  });
});

// ============================================================================

describe('identidade ausente é configuração incompleta, não "Grupo Sampaio"', () => {
  it('empresa sem nome recusa a impressão, dizendo onde resolver', () => {
    /*
      "Grupo Sampaio" não é nenhuma das seis operações: não tem CNPJ, não emite
      nota e não responde por garantia. Imprimi-lo é entregar ao cliente um
      papel que parece certo e não diz de quem é.
    */
    const semNome = upsertCompany({ slug: 'sem-nome', legalName: '', tradeName: '' });
    getConnection()
      .prepare("UPDATE core_companies SET trade_name = '', legal_name = '' WHERE id = ?")
      .run(semNome);
    const b = bancada(semNome, 'bancada-sem-nome', null);

    expect(() => renderServiceOrderA4(semNome, ordem(semNome, b))).toThrow(/identidade/i);
  });

  it('e a recusa nomeia a operação que precisa ser configurada', () => {
    const b = bancada(oficina, 'oficina-mobilidade', null);
    const orderId = ordem(oficina, b);
    getConnection()
      .prepare("UPDATE core_companies SET trade_name = '', legal_name = '' WHERE id = ?")
      .run(oficina);

    expect(() => renderServiceOrderA4(oficina, orderId)).toThrow(/Empresas/i);
  });
});

// ============================================================================

describe('a marca da bancada tem dono, e o dono é a tela', () => {
  it('definir a marca troca a identidade do papel', () => {
    const b = bancada(oficina, 'oficina-mobilidade', pjMotors);
    expect(renderServiceOrderA4(oficina, ordem(oficina, b)).marca).toBe('PJ Motors');

    definirMarcaDaBancada({ companyId: oficina, workshopId: b, brandCompanyId: null });

    expect(renderServiceOrderA4(oficina, ordem(oficina, b)).marca).toBe('Oficina');
  });

  it('a marca só pode ser uma empresa que existe', () => {
    const b = bancada(oficina, 'oficina-mobilidade', null);
    expect(() =>
      definirMarcaDaBancada({
        companyId: oficina,
        workshopId: b,
        brandCompanyId: 'empresa-que-nao-existe',
      }),
    ).toThrow(/não encontrada/i);
  });

  it('não se muda a bancada da vizinha', () => {
    const daPrecoJusto = bancada(precoJusto, 'oficina-celulares', null);

    expect(() =>
      definirMarcaDaBancada({
        companyId: oficina,
        workshopId: daPrecoJusto,
        brandCompanyId: pjMotors,
      }),
    ).toThrow(/não encontrada/i);
  });
});

// ============================================================================

describe('a migração semeia, e não manda', () => {
  it('rodar a migração de novo NÃO reimpõe a marca que o dono trocou', async () => {
    /*
      Este é o defeito estrutural: a migração fazia
      `UPDATE ... SET brand_company_id = ?` com o valor cravado em código, em
      TODA execução. O dono corrigia pela tela, a migração rodava no próximo
      deploy, e a OS voltava a sair com o nome errado — sem ninguém ter mexido
      em nada.

      Semear é escrever o que ainda não existe. O que já existe tem dono.
    */
    const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
    const b = bancada(oficina, 'oficina-mobilidade', pjMotors);
    definirMarcaDaBancada({ companyId: oficina, workshopId: b, brandCompanyId: null });

    migrateCoreSchema();

    const depois = getConnection()
      .prepare('SELECT brand_company_id FROM core_workshops WHERE id = ?')
      .get(b) as { brand_company_id: string | null };
    expect(depois.brand_company_id).toBeNull();
  });
});

// ============================================================================

describe('o dado errado é desfeito UMA vez', () => {
  /**
   * A causa estrutural foi resolvida na semeadura, mas o valor que ela já
   * gravou continua no banco. O passo 72 o desfaz — e o faz uma vez só, porque
   * é correção de um erro conhecido, e não imposição de política.
   */
  /**
   * Um banco que VIVEU na versão 71 — que é o caso real. Banco criado do zero
   * já nasce na versão alvo com todos os passos marcados, e migrar nele não
   * exercita passo nenhum: o teste passaria sem tocar no código sob prova.
   */
  async function migrarDeUmBancoAntigo() {
    const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
    getConnection()
      .prepare("DELETE FROM core_meta WHERE key = 'core_migration_step_72'")
      .run();
    getConnection()
      .prepare("UPDATE core_meta SET value = '71' WHERE key = 'core_schema_version'")
      .run();
    return migrateCoreSchema();
  }

  it('a bancada de mobilidade deixa de assinar como PJ Motors', async () => {
    const b = bancada(oficina, 'oficina-mobilidade', pjMotors);
    await migrarDeUmBancoAntigo();

    const depois = getConnection()
      .prepare('SELECT brand_company_id FROM core_workshops WHERE id = ?')
      .get(b) as { brand_company_id: string | null };
    expect(depois.brand_company_id).toBeNull();
  });

  it('bancada que já aponta para OUTRA empresa não é tocada', async () => {
    /*
      O passo corrige um valor conhecido e errado. Uma bancada que alguém
      configurou para assinar como Preço Justo é uma decisão de quem opera, e
      migração não desfaz decisão de operador.
    */
    const b = bancada(oficina, 'oficina-mobilidade', precoJusto);
    await migrarDeUmBancoAntigo();

    const depois = getConnection()
      .prepare('SELECT brand_company_id FROM core_workshops WHERE id = ?')
      .get(b) as { brand_company_id: string | null };
    expect(depois.brand_company_id).toBe(precoJusto);
  });

  it('depois de aplicado, o passo não desfaz uma escolha nova do dono', async () => {
    const b = bancada(oficina, 'oficina-mobilidade', pjMotors);
    await migrarDeUmBancoAntigo();

    // O dono decide, DEPOIS, que a mobilidade volta a assinar como PJ Motors.
    definirMarcaDaBancada({ companyId: oficina, workshopId: b, brandCompanyId: pjMotors });
    // E o servidor sobe de novo: migração normal, sem passo pendente.
    const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
    migrateCoreSchema();

    const depois = getConnection()
      .prepare('SELECT brand_company_id FROM core_workshops WHERE id = ?')
      .get(b) as { brand_company_id: string | null };
    expect(depois.brand_company_id).toBe(pjMotors);
  });
});
