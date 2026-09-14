/**
 * CONTAGEM PARCIAL — o recorte na abertura do inventário.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * `POST /core/inventory-counts` sempre aceitou `productIds`, mas a tela só
 * mandava `scopeNote`: toda contagem aberta pela UI congelava o catálogo ativo
 * INTEIRO. Contar o corredor de bebidas numa loja de milhares de SKUs abria
 * uma lista impraticável — e o acerto avulso de UM produto exigia rolar tudo.
 *
 * O conserto dá ao servidor o recorte que a tela consegue descrever: CATEGORIA
 * (o texto canônico gravado no produto) e/ou BUSCA (nome, código interno ou
 * código de barras — a MESMA régua da posição de estoque). O congelamento do
 * esperado passa a ser só dos produtos do recorte.
 *
 * ============================================================================
 * O QUE NÃO PODE MUDAR
 * ============================================================================
 *
 *   - contagem SEM recorte continua sendo o inventário geral (catálogo ativo
 *     inteiro) — é o comportamento de toda contagem existente;
 *   - `productIds` explícito continua mandando: é a lista de quem sabe
 *     exatamente o que quer contar, e recorte nenhum a segunda-adivinha;
 *   - produto FORA do recorte não é congelado, não entra no acerto e continua
 *     livre para vender e movimentar — contagem parcial não trava a loja;
 *   - produto fora da lista encontrado na prateleira continua podendo entrar
 *     pela contagem do item (comportamento já provado em inventario.test.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement, getBalance } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let coca: string;
let agua: string;
let camiseta: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-parcial',
    companyId: 'loja-parcial',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const cria = (nome: string, categoria: string, saldo: number) => {
    const id = createProduct(companyId, {
      name: nome,
      priceCents: 1_000,
      category: categoria,
    }).id;
    applyMovement({
      companyId,
      productId: id,
      movementType: 'in',
      quantity: saldo,
      referenceType: 'entrada',
      referenceId: `carga-${id}`,
    });
    return id;
  };

  coca = cria('Refrigerante Cola 2L', 'Bebidas', 10);
  agua = cria('Água mineral 500ml', 'Bebidas', 24);
  camiseta = cria('Camiseta básica', 'Vestuário', 7);
});

function abrir(body: Record<string, unknown>) {
  return request(app).post('/api/v1/core/inventory-counts').set(auth).send(body);
}

function nomesDosItens(body: { items: { name: string }[] }): string[] {
  return body.items.map((i) => i.name).sort();
}

describe('o recorte na abertura', () => {
  it('por CATEGORIA: congela só os produtos da categoria', async () => {
    const res = await abrir({ scopeNote: 'Corredor de bebidas', category: 'Bebidas' });

    expect(res.status).toBe(201);
    expect(nomesDosItens(res.body)).toEqual(['Refrigerante Cola 2L', 'Água mineral 500ml'].sort());
    // A camiseta não foi congelada: não há linha dela na contagem.
    expect(
      (res.body.items as { product_id: string }[]).some((i) => i.product_id === camiseta),
    ).toBe(false);
  });

  it('por BUSCA: a mesma régua da posição de estoque (nome, código, barras)', async () => {
    const res = await abrir({ scopeNote: 'Acerto avulso', search: 'Cola' });

    expect(res.status).toBe(201);
    expect(nomesDosItens(res.body)).toEqual(['Refrigerante Cola 2L']);
  });

  it('categoria E busca juntas apertam o recorte, não o alargam', async () => {
    const res = await abrir({ category: 'Bebidas', search: 'Água' });

    expect(res.status).toBe(201);
    expect(nomesDosItens(res.body)).toEqual(['Água mineral 500ml']);
  });

  it('recorte que não encontra nada é RECUSA legível, não contagem vazia', async () => {
    /*
      Uma contagem sem itens não tem o que contar nem o que aplicar — abriria
      só para ser cancelada. Melhor recusar na porta, dizendo por quê.
    */
    const res = await abrir({ category: 'Categoria que não existe' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_COUNT_SCOPE_EMPTY');
    expect(String(res.body.error.message)).toMatch(/recorte|produto/i);
  });

  it('SEM recorte continua abrindo o catálogo inteiro — o inventário geral não muda', async () => {
    const res = await abrir({ scopeNote: 'Geral' });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(3);
  });

  it('productIds explícito continua mandando, mesmo com recorte junto', async () => {
    const res = await abrir({ productIds: [camiseta], category: 'Bebidas' });

    expect(res.status).toBe(201);
    expect(nomesDosItens(res.body)).toEqual(['Camiseta básica']);
  });
});

describe('contagem parcial não trava o que ficou de fora', () => {
  it('o produto fora do recorte segue vendável e o acerto não o toca', async () => {
    const aberta = await abrir({ category: 'Bebidas' });
    expect(aberta.status).toBe(201);
    const countId = aberta.body.id as string;

    // Com a contagem ABERTA, a camiseta continua se movimentando normalmente.
    applyMovement({
      companyId,
      productId: camiseta,
      movementType: 'out',
      quantity: 2,
      referenceType: 'uso_interno',
      referenceId: randomUUID(),
      reason: 'Uniforme da equipe',
    });
    expect(getBalance(companyId, camiseta)).toBe(5);

    // Conta a cola com falta de 1 e aplica.
    await request(app)
      .post(`/api/v1/core/inventory-counts/${countId}/items`)
      .set(auth)
      .send({ productId: coca, countedQuantity: 9 })
      .expect(200);
    const aplicada = await request(app)
      .post(`/api/v1/core/inventory-counts/${countId}/apply`)
      .set(auth)
      .send({ reason: 'Contagem parcial de bebidas' });
    expect(aplicada.status).toBe(200);

    // O acerto mexeu SÓ no recorte: cola caiu para 9, água ficou, e a camiseta
    // ficou exatamente onde a saída de uso interno a deixou.
    expect(getBalance(companyId, coca)).toBe(9);
    expect(getBalance(companyId, agua)).toBe(24);
    expect(getBalance(companyId, camiseta)).toBe(5);

    // E não existe NENHUM movimento de inventário para a camiseta.
    const movimentosDaCamiseta = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_stock_movements
          WHERE company_id = ? AND product_id = ? AND reference_type = 'inventory_count'`,
      )
      .get(companyId, camiseta) as { n: number };
    expect(movimentosDaCamiseta.n).toBe(0);
  });
});
