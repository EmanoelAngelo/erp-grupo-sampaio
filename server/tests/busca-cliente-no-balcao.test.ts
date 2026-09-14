/**
 * ============================================================================
 * A BUSCA DE CLIENTE QUE O BALCÃO USA DE VERDADE — GAP-V53
 * ============================================================================
 *
 * O F2 do PDV ganhou busca viva sobre GET /core/customers?search — e a busca
 * que existia ali era um LIKE cru sobre name/document/phone. Cru demais para
 * um balcão:
 *
 *   - o cadastro NOVO grava o documento SÓ COM DÍGITOS (decisão da rodada do
 *     checkout: é a coluna que vai no <CPF> do XML). Quem digita o CPF do
 *     jeito que ele está impresso no documento — 390.533.447-05 — não achava
 *     ninguém, porque o LIKE comparava máscara com dígito;
 *   - o cadastro ANTIGO pode estar gravado COM máscara (desta rodada para
 *     trás ninguém normalizava no INSERT — a mesma constatação escrita em
 *     `clientePorDocumento`). Quem digita só os dígitos não achava esses;
 *   - o CÓDIGO do cliente (coluna `code`, que o POST sempre aceitou) não era
 *     pesquisável por rota nenhuma.
 *
 * A regra passa a ser a MESMA do dedupe de documento: normalizar OS DOIS
 * LADOS. O termo digitado e o valor gravado perdem a máscara antes da
 * comparação — em memória, porque o SQLite não tira máscara sozinho e a lista
 * de clientes de uma loja cabe nela com folga (doutrina de
 * `clientePorDocumento`, CatalogService.ts).
 *
 * Cada caso daqui nasceu VERMELHO contra o LIKE cru.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

interface Loja {
  auth: { Authorization: string };
  companyId: string;
}

/**
 * Quem busca é o CAIXA — a rota é aberta ao balcão de propósito (o comentário
 * dela explica: o PDV vincula cliente à venda). Logar como caixa aqui é o que
 * garante que a busca nova não estreitou a porta sem querer.
 */
async function abrirBalcao(userId: string, companyId: string): Promise<Loja> {
  const res = await loginForTest(app, {
    userId,
    companyId,
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    companyId: res.body.company.id,
  };
}

async function cadastrar(loja: Loja, corpo: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/api/v1/core/customers').set(loja.auth).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

/**
 * Um cadastro COMO A VERSÃO ANTIGA GRAVAVA: documento e telefone com máscara,
 * direto no banco. O POST de hoje normaliza no INSERT, então o único jeito de
 * reproduzir o legado real é escrevê-lo cru — que é exatamente como ele está
 * no banco de produção.
 */
function cadastrarLegado(companyId: string, nome: string, documentoMascarado: string): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers
         (id, company_id, name, document, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, companyId, nome, documentoMascarado, agora, agora);
  return id;
}

async function buscar(loja: Loja, termo: string) {
  const res = await request(app)
    .get(`/api/v1/core/customers?search=${encodeURIComponent(termo)}`)
    .set(loja.auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as { id: string; name: string }[];
}

let loja: Loja;
let maria: string;

beforeEach(async () => {
  resetDbForTests();
  loja = await abrirBalcao('caixa-busca', 'gringa');
  // O cadastro de hoje: o servidor guarda o documento só com dígitos.
  maria = await cadastrar(loja, {
    name: 'Maria Aparecida',
    document: '390.533.447-05',
    phone: '(96) 99999-1234',
  });
});

// ============================================================= com e sem máscara

describe('documento com e sem máscara acha o mesmo cliente', () => {
  it('o CPF digitado COM máscara acha o cadastro gravado só com dígitos', async () => {
    // É o gesto real do balcão: ler o CPF do documento impresso, pontos e
    // traço inclusive. O LIKE cru devolvia lista vazia aqui.
    const itens = await buscar(loja, '390.533.447-05');
    expect(itens.map((c) => c.id)).toContain(maria);
  });

  it('um pedaço do CPF, sem máscara, também acha', async () => {
    const itens = await buscar(loja, '39053344');
    expect(itens.map((c) => c.id)).toContain(maria);
  });

  it('o CPF só com dígitos acha o cadastro LEGADO gravado com máscara', async () => {
    // O outro lado da mesma moeda: o banco antigo tem máscara gravada
    // (constatação de `clientePorDocumento`), e quem digita limpo não achava.
    const legado = cadastrarLegado(loja.companyId, 'Sr. Cadastro Antigo', '529.982.247-25');
    const itens = await buscar(loja, '52998224725');
    expect(itens.map((c) => c.id)).toContain(legado);
  });

  it('o telefone digitado limpo acha o cadastro com máscara no telefone', async () => {
    // O telefone da Maria foi gravado como "(96) 99999-1234" — cru, porque
    // telefone nunca foi normalizado (e não precisa ser: a busca normaliza).
    const itens = await buscar(loja, '96999991234');
    expect(itens.map((c) => c.id)).toContain(maria);
  });
});

// ======================================================================= código

describe('o código do cliente é pesquisável', () => {
  it('buscar pelo code acha o cliente — a coluna deixou de ser só gravável', async () => {
    const ze = await cadastrar(loja, { name: 'José da Revenda', code: 'CLI-042' });
    const itens = await buscar(loja, 'CLI-042');
    expect(itens.map((c) => c.id)).toContain(ze);
  });
});

// ============================================================ o que já valia

describe('o que a busca antiga fazia continua valendo', () => {
  it('nome acha, sem diferenciar maiúscula', async () => {
    const itens = await buscar(loja, 'maria apa');
    expect(itens.map((c) => c.id)).toContain(maria);
  });

  it('termo que não casa com nada devolve lista vazia — e não a lista inteira', async () => {
    const itens = await buscar(loja, 'ninguem-com-esse-nome');
    expect(itens).toHaveLength(0);
  });

  it('sem termo, a listagem completa continua respondendo', async () => {
    const res = await request(app).get('/api/v1/core/customers').set(loja.auth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { id: string }) => c.id)).toContain(maria);
  });
});

// ==================================================================== tenant

describe('a busca não atravessa empresa', () => {
  it('o CPF da Maria buscado pela loja vizinha devolve vazio', async () => {
    // A normalização acontece DEPOIS do recorte por empresa — se um dia ela
    // passar a varrer o banco inteiro, este caso fica vermelho na hora.
    const vizinha = await abrirBalcao('caixa-vizinha', 'memimei');
    const itens = await buscar(vizinha, '390.533.447-05');
    expect(itens).toHaveLength(0);
  });
});
