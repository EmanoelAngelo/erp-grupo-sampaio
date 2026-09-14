/**
 * A AUDITORIA GANHA LEITOR — `core_audit_log` tem 128 escritores e, até esta
 * rodada, um leitor que nenhuma tela chamava e que devolvia 200 linhas fixas.
 * 200 linhas fixas não são histórico: são uma amostra que esconde justamente
 * o que se procura ("quem deu esse desconto em março?").
 *
 * O que cada caso quebra sem o conserto:
 *   - sem paginação no SERVIDOR, o caso "a página 2 existe e é diferente"
 *     falha: tudo vinha numa resposta só e o offset era ignorado;
 *   - sem filtro por ação no banco, o caso do filtro devolve ações misturadas;
 *   - sem o `total` filtrado, a tela numeraria páginas de um universo errado;
 *   - sem o JOIN com `core_users`, `user_name` volta nulo e a tabela da tela
 *     mostraria uuid a quem pergunta por GENTE;
 *   - sem `requireProfile(req)` (o atalho de admin_geral/gestor), o caso do
 *     403 do gerente falha — removido o guarda de propósito, ele caiu com
 *     `expected 403, received 200`, que é a prova de que o guarda morde.
 *
 * ALCANCE, por extenso: a auditoria expõe ações de TODO MUNDO, inclusive dos
 * gerentes. Quem investiga responde pelo grupo; quem opera aparece na trilha.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { recordAudit } from '../src/services/audit/AuditService.js';

const app = createApp();
const LOJA = 'loja-auditoria';

async function token(perfil: string, userId: string): Promise<string> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function lerTrilha(t: string, query: Record<string, string | number> = {}) {
  return request(app)
    .get('/api/v1/core/audit')
    .query(query)
    .set('Authorization', `Bearer ${t}`);
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('quem pode ler a trilha', () => {
  it('o gestor lê; o gerente de loja recebe 403 — ele APARECE na trilha, não a lê', async () => {
    const gestor = await token('gestor', 'dono');
    const gerente = await token('gerente_loja', 'gerencia');

    expect((await lerTrilha(gestor)).status).toBe(200);

    const recusado = await lerTrilha(gerente);
    expect(recusado.status).toBe(403);
    expect(recusado.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('o operador de caixa também não lê', async () => {
    const caixa = await token('operador_caixa_loja', 'caixa');
    expect((await lerTrilha(caixa)).status).toBe(403);
  });
});

describe('paginação e filtro no SERVIDOR', () => {
  /** Semeia N acontecimentos com ações alternadas e detalhe procurável. */
  function semear(n: number): void {
    for (let i = 0; i < n; i += 1) {
      recordAudit({
        companyId: LOJA,
        userId: null,
        action: i % 2 === 0 ? 'sale.create' : 'cash.open',
        entityType: 'teste',
        entityId: `ent-${i}`,
        detail: { marcador: i === 7 ? 'agulha-no-palheiro' : `linha ${i}` },
      });
    }
  }

  it('limit e offset percorrem o histórico inteiro, e o total diz quanto existe', async () => {
    const gestor = await token('gestor', 'dono');
    semear(30);

    const pagina1 = await lerTrilha(gestor, { limit: 10, offset: 0 });
    const pagina2 = await lerTrilha(gestor, { limit: 10, offset: 10 });

    expect(pagina1.status).toBe(200);
    expect(pagina1.body.items).toHaveLength(10);
    expect(pagina2.body.items).toHaveLength(10);
    // O login do gestor também audita — o total conta TUDO da empresa, não a
    // amostra. O que importa: é MAIOR que uma página e igual nas duas leituras.
    expect(pagina1.body.total).toBeGreaterThanOrEqual(30);
    expect(pagina1.body.total).toBe(pagina2.body.total);

    // Página 2 não repete página 1: o offset é aplicado no banco.
    const ids1 = new Set(pagina1.body.items.map((i: { id: string }) => i.id));
    for (const item of pagina2.body.items as { id: string }[]) {
      expect(ids1.has(item.id)).toBe(false);
    }
  });

  it('filtrar por ação devolve SÓ aquela ação, e o total acompanha o filtro', async () => {
    const gestor = await token('gestor', 'dono');
    semear(20);

    const res = await lerTrilha(gestor, { action: 'cash.open', limit: 200 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(10);
    expect(res.body.total).toBe(10);
    for (const item of res.body.items as { action: string }[]) {
      expect(item.action).toBe('cash.open');
    }
    // E o seletor da tela recebe as ações que EXISTEM nesta empresa.
    expect(res.body.actions).toContain('sale.create');
    expect(res.body.actions).toContain('cash.open');
  });

  it('a busca acha pelo detalhe — inclusive com % sem virar curinga', async () => {
    const gestor = await token('gestor', 'dono');
    semear(20);

    const res = await lerTrilha(gestor, { q: 'agulha-no-palheiro' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].detail).toContain('agulha-no-palheiro');

    // "100%" procurado como TEXTO: sem o escape do LIKE, "%" casaria tudo.
    recordAudit({
      companyId: LOJA,
      action: 'sale.create',
      entityType: 'teste',
      detail: { marcador: 'desconto de 100% liberado' },
    });
    const comPorcento = await lerTrilha(gestor, { q: '100%' });
    expect(comPorcento.body.total).toBe(1);
  });

  it('quem fez vem PELO NOME, e a trilha de outra empresa não vaza', async () => {
    const gestor = await token('gestor', 'dono');
    // O login do gestor gravou auditoria com o user de verdade.
    const res = await lerTrilha(gestor, { limit: 200 });
    const doDono = (res.body.items as { user_name: string | null }[]).find(
      (i) => i.user_name === 'dono',
    );
    expect(doDono).toBeTruthy();

    // Outra empresa grava; a leitura da LOJA não a vê.
    recordAudit({
      companyId: 'outra-empresa',
      action: 'sale.create',
      entityType: 'teste',
      detail: { marcador: 'segredo-da-outra' },
    });
    const denovo = await lerTrilha(gestor, { q: 'segredo-da-outra' });
    expect(denovo.body.total).toBe(0);
  });

  it('o teto por página vale mesmo para quem pede mais: limit=9999 volta no máximo 200', async () => {
    const gestor = await token('gestor', 'dono');
    for (let i = 0; i < 210; i += 1) {
      recordAudit({ companyId: LOJA, action: 'sale.create', entityType: 'teste' });
    }
    const res = await lerTrilha(gestor, { limit: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(210);
  });
});

/*
  `?limit=abc` NÃO PODE SER 500. `Number('abc')` é NaN, e NaN atravessa
  Math.min/Math.max intacto até o bind do LIMIT — onde o SQLite recusa com
  "datatype mismatch". A rota que existe para traduzir ação em texto legível
  respondia com o erro mais ilegível do sistema. Achado por atacante, por rota.
*/
describe('limite que não é número', () => {
  it('?limit=abc cai no padrão em vez de estourar', async () => {
    const gestor = await token('gestor', 'dono-limit');
    const res = await lerTrilha(gestor, { limit: 'abc', offset: 'xyz' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
