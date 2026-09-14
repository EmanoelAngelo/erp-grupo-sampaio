/**
 * ============================================================================
 * O RASTRO DO ITEM CANCELADO PRECISA DIZER QUEM — E O ID NÃO DIZ
 * ============================================================================
 *
 * ## O defeito
 *
 * `GET /core/sales/:id` devolve `removedItems` com `removed_by` = o ID de quem
 * tirou a linha do carrinho. A ficha da venda resolvia esse id em NOME
 * chamando `GET /core/sellers` — uma rota de balcão que NÃO alcança todo perfil
 * que chega à tela de Vendas (o estoquista toma 403). Sem alcance, a coluna
 * "Quem tirou" caía no identificador cru.
 *
 * Um rastro de prevenção de perda que mostra `a3f1-…` para metade dos
 * operadores não é rastro: a pergunta que o gestor faz é sobre GENTE — quem
 * tirou a bermuda do carrinho antes de fechar por menos —, e um UUID não a
 * responde. Pior: a ficha dependia de um SEGUNDO pedido, que podia falhar em
 * silêncio, para completar um dado que a própria ficha já podia trazer.
 *
 * ## A decisão sobre o nome que não existe
 *
 * O RASTRO VALE MAIS QUE O NOME. Conta apagada depois da venda, ou id que não
 * pertence a esta operação, NÃO podem derrubar a consulta nem sumir com a
 * linha: o que o gestor precisa ver é que ALGUÉM tirou a peça, com valor e
 * hora. Então o nome vem nulo e o id continua na resposta — a tela mostra o
 * identificador, que é feio de ler e honesto.
 *
 * E o nome só é resolvido DENTRO da empresa da venda: exibir o `display_name`
 * de alguém de outro tenant seria vazamento — o mesmo cerco que faz o rastro
 * gravar `product_id` nulo quando o produto é de outra empresa.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { createSale, getSaleDetail } from '../src/services/core/SalesService.js';

const SENHA = 'Rastro@ComNome2026';

let companyA: string;
let companyB: string;
let camiseta: string;
let cinto: string;

function criarProduto(companyId: string, name: string, priceCents: number): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents,
          min_stock, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 0, 1, ?, ?)`,
    )
    .run(id, companyId, `COD-${id.slice(0, 6)}`, name, priceCents, now, now);
  return id;
}

async function operador(login: string, displayName: string, companyId: string): Promise<string> {
  const userId = await upsertUser({ login, displayName, password: SENHA });
  linkUserToCompany(userId, companyId, 'operador_caixa', true);
  return userId;
}

beforeEach(() => {
  resetDbForTests();
  companyA = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  companyB = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  camiseta = criarProduto(companyA, 'Camiseta', 5000);
  cinto = criarProduto(companyA, 'Cinto', 1200);
  applyMovement({
    companyId: companyA,
    productId: camiseta,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: 'carga-a',
  });
});

/** A venda padrão do arquivo: 1 camiseta em dinheiro, com um cinto retirado. */
function venderRetirando(userId: string) {
  return createSale({
    companyId: companyA,
    userId,
    idempotencyKey: randomUUID(),
    items: [{ productId: camiseta, quantity: 1, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    cancelledItems: [
      {
        productId: cinto,
        name: 'Cinto',
        quantity: 2,
        unitPriceCents: 1200,
        removedAt: '2026-08-30T14:03:00.000Z',
      },
    ],
  } as Parameters<typeof createSale>[0]);
}

interface LinhaDoRastro {
  id: string;
  name: string;
  removed_by: string | null;
  removed_by_name: string | null;
}

function rastroDaFicha(companyId: string, saleId: string): LinhaDoRastro[] {
  return getSaleDetail(companyId, saleId)!.removedItems as LinhaDoRastro[];
}

describe('a ficha da venda diz o NOME de quem tirou o item', () => {
  it('usuário da casa: a ficha traz o nome junto, sem segunda consulta', async () => {
    const joana = await operador('joana@preco-justo', 'Joana do Caixa', companyA);
    const { sale } = venderRetirando(joana);

    const rastro = rastroDaFicha(companyA, sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].name).toBe('Cinto');
    // O id continua na resposta — quem audita cruza por ele —, e o NOME vem ao
    // lado, resolvido pelo servidor, que é quem tem a tabela de usuários.
    expect(rastro[0].removed_by).toBe(joana);
    expect(rastro[0].removed_by_name).toBe('Joana do Caixa');
  });

  it('conta APAGADA depois da venda: a linha fica, o nome é que falta', async () => {
    const efemero = await operador('temporario@preco-justo', 'Contratado da Black Friday', companyA);
    const { sale } = venderRetirando(efemero);

    // A conta some do sistema meses depois. O rastro é história: ele não pode
    // sumir junto nem explodir a ficha inteira por causa de um nome ausente.
    getConnection().prepare('DELETE FROM core_users WHERE id = ?').run(efemero);

    const rastro = rastroDaFicha(companyA, sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].name).toBe('Cinto');
    expect(rastro[0].removed_by).toBe(efemero);
    // "Não sei o nome" é um estado, e é diferente de "ninguém removeu": nulo
    // aqui faz a tela cair no identificador em vez de apagar a linha.
    expect(rastro[0].removed_by_name).toBeNull();
  });

  it('id de OUTRA empresa não vira nome — o cerco do tenant vale para o nome também', async () => {
    const deFora = await operador('gerente@gringa', 'Gerente da Gringa', companyB);
    const joana = await operador('joana2@preco-justo', 'Joana do Caixa', companyA);
    const { sale } = venderRetirando(joana);

    // O carimbo vem do token, então isto não acontece pela porta da frente —
    // mas se acontecer (importação, correção manual, defeito futuro), exibir o
    // nome de alguém de outro tenant seria vazamento, e sumir com a linha
    // apagaria a única prova de que a peça saiu do carrinho.
    getConnection()
      .prepare('UPDATE core_sale_removed_items SET removed_by = ? WHERE sale_id = ?')
      .run(deFora, sale.id);

    const rastro = rastroDaFicha(companyA, sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].removed_by).toBe(deFora);
    expect(rastro[0].removed_by_name).toBeNull();
  });

  it('rastro antigo, sem carimbo de autor, continua chegando à ficha', async () => {
    const joana = await operador('joana3@preco-justo', 'Joana do Caixa', companyA);
    const { sale } = venderRetirando(joana);
    // Linha gravada antes de o carimbo existir: `removed_by` nulo.
    getConnection()
      .prepare('UPDATE core_sale_removed_items SET removed_by = NULL WHERE sale_id = ?')
      .run(sale.id);

    const rastro = rastroDaFicha(companyA, sale.id);
    expect(rastro).toHaveLength(1);
    expect(rastro[0].removed_by).toBeNull();
    expect(rastro[0].removed_by_name).toBeNull();
  });
});
