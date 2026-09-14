/**
 * O CLIQUE DUPLO NA ENTRADA DE PEÇA.
 *
 * ============================================================================
 * A ÚNICA ENTRADA DE ESTOQUE SEM REFERÊNCIA ESTÁVEL
 * ============================================================================
 *
 * Todo movimento de estoque neste sistema passa por `applyMovement`, e
 * `applyMovement` tem idempotência de verdade: `UNIQUE (company_id,
 * reference_type, reference_id, product_id, movement_type)` no banco. Repetir
 * o mesmo movimento não soma de novo — volta `duplicated: true` e o saldo fica
 * como estava.
 *
 * Essa proteção só vale se a REFERÊNCIA for estável. A entrada de peça na
 * bancada montava a referência com `randomUUID()`: cada chamada inventava uma
 * chave nova, então cada chamada era, para o razão, um fato novo. O guarda
 * estava lá, armado, e nunca disparava.
 *
 * O resultado na bancada: o estoquista clica "Dar entrada", a rede demora, ele
 * clica de novo — e entram 6 onde chegaram 3. Sem duplicado na lista, sem
 * aviso, sem nada que denuncie. A gaveta passa a mentir a favor, que é o pior
 * jeito: o sistema promete peça que não existe, o mecânico monta a OS, e a
 * falta só aparece com a moto desmontada.
 *
 * ============================================================================
 * POR QUE NÃO BASTA CHAVEAR PELO NÚMERO DA NOTA
 * ============================================================================
 *
 * O comentário que justificava o `randomUUID()` estava CERTO no motivo e
 * errado na conclusão: duas cargas da MESMA nota acontecem de verdade — o
 * fornecedor entrega em duas viagens —, e amarrar a chave só ao número do
 * documento faria a segunda carga ser engolida em silêncio. A peça chegaria e
 * o saldo não subiria.
 *
 * A saída não é abrir mão da chave: é pedir a chave a QUEM SABE. Duas cargas
 * são dois gestos, e dois gestos têm duas chaves. Um clique repetido é UM
 * gesto, e o navegador manda a mesma chave. É a mesma régua que a venda, a
 * devolução e o pagamento já usam neste servidor: `Idempotency-Key`.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO TRAVA
 * ============================================================================
 *
 *  - reposição com a mesma chave soma uma vez só, e DIZ que foi repetida
 *  - reposição com chave nova soma de novo (a segunda viagem do fornecedor)
 *  - cadastro com a mesma chave cria UMA peça, não duas
 *  - entrada sem chave é recusada — a porta não fica aberta por omissão
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let gerente: { Authorization: string };
let companyId: string;
let workshopId: string;

const NF = { numero: 'NF 8899', fornecedor: 'Voltz Distribuidora', valorTotalCents: 96_000 };

beforeEach(async () => {
  resetDbForTests();

  const g = await loginForTest(app, {
    userId: 'ger-clique',
    companyId: 'oficina-clique',
    profileCodes: ['gerente_oficina'],
  });
  gerente = { Authorization: `Bearer ${g.body.accessToken}` };
  companyId = g.body.company.id;

  workshopId = 'wk-clique';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-clique', 'Bancada', 'mobility', 1, ?)`,
    )
    .run(workshopId, companyId, new Date().toISOString());
});

/** O cadastro com entrada, com a chave que o navegador manda. */
function cadastrar(chave: string | null, corpo: Record<string, unknown> = {}) {
  const req = request(app).post('/api/v1/core/workshop/parts').set(gerente);
  if (chave) req.set('Idempotency-Key', chave);
  return req.send({
    workshopId,
    name: 'Controlador 48V 1000W',
    barcode: '7891234567895',
    costCents: 32_000,
    markupPercent: 40,
    quantity: 3,
    minStock: 2,
    documento: NF,
    ...corpo,
  });
}

function repor(productId: string, chave: string | null, quantidade = 3) {
  const req = request(app)
    .post(`/api/v1/core/workshop/parts/${productId}/reposicao`)
    .set(gerente);
  if (chave) req.set('Idempotency-Key', chave);
  return req.send({ quantity: quantidade, documento: NF });
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function movimentos(productId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_stock_movements
        WHERE company_id = ? AND product_id = ? AND reference_type = 'entrada_bancada'`,
    )
    .get(companyId, productId) as { n: number };
  return row.n;
}

// ============================================================================

describe('a reposição repetida soma uma vez só', () => {
  it('dois cliques com a mesma chave: 3 entram, não 6', async () => {
    const nova = await cadastrar('cad-1');
    const peca = nova.body.productId as string;
    expect(saldo(peca)).toBe(3);

    const primeiro = await repor(peca, 'rep-1');
    const segundo = await repor(peca, 'rep-1');

    expect(primeiro.status).toBe(200);
    expect(segundo.status).toBe(200);
    expect(saldo(peca)).toBe(6);
    // E o razão tem DOIS fatos, não três: o cadastro e a reposição.
    expect(movimentos(peca)).toBe(2);
  });

  it('a segunda resposta DIZ que foi repetida — a tela não pode mentir', async () => {
    const nova = await cadastrar('cad-2');
    const peca = nova.body.productId as string;

    await repor(peca, 'rep-2');
    const segundo = await repor(peca, 'rep-2');

    /*
      Sem este campo a tela mostraria "Entrada registrada" duas vezes e quem
      está na bancada acharia que somou duas cargas. A resposta tem de contar
      o que aconteceu de verdade.
    */
    expect(segundo.body.duplicada).toBe(true);
    expect(segundo.body.quantity).toBe(3);
  });

  it('a SEGUNDA VIAGEM do fornecedor entra normalmente — chave nova, fato novo', async () => {
    const nova = await cadastrar('cad-3');
    const peca = nova.body.productId as string;

    // Mesma nota, mesma quantidade, mesmo tudo — só o gesto é outro.
    await repor(peca, 'viagem-1');
    const outra = await repor(peca, 'viagem-2');

    expect(outra.body.duplicada).toBe(false);
    expect(saldo(peca)).toBe(9);
    expect(movimentos(peca)).toBe(3);
  });
});

// ============================================================================

describe('o cadastro repetido não vira duas peças', () => {
  it('dois cliques com a mesma chave criam UMA peça', async () => {
    const primeiro = await cadastrar('cad-dup');
    const segundo = await cadastrar('cad-dup');

    expect(primeiro.status).toBe(201);
    expect(segundo.status).toBe(201);
    expect(segundo.body.productId).toBe(primeiro.body.productId);

    const quantas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = ?")
      .get(companyId, 'Controlador 48V 1000W') as { n: number };
    expect(quantas.n).toBe(1);
    expect(saldo(primeiro.body.productId as string)).toBe(3);
  });
});

// ============================================================================

describe('entrada sem chave é recusada', () => {
  /*
    A porta não fica aberta por omissão. Se a ausência da chave fosse tratada
    como "então gera uma", o defeito voltaria inteiro na primeira tela que
    esquecesse de mandá-la — e voltaria em silêncio, que é como ele nasceu.
  */
  it('reposição sem Idempotency-Key volta 400 e não mexe no saldo', async () => {
    const nova = await cadastrar('cad-4');
    const peca = nova.body.productId as string;

    const res = await repor(peca, null);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_REQUIRED');
    expect(saldo(peca)).toBe(3);
  });

  it('cadastro sem Idempotency-Key volta 400 e não cria peça', async () => {
    const res = await cadastrar(null);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_REQUIRED');
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(quantas.n).toBe(0);
  });
});
