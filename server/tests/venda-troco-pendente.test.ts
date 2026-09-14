/**
 * Troco só pode sair de dinheiro que ENTROU.
 *
 * `paid` soma todos os pagamentos sem olhar o `status`, e o troco é calculado
 * sobre essa soma. Um PIX marcado como `pending` — que é o caminho previsto
 * para pagamento aguardando confirmação — engorda o `paid` e pode liberar
 * troco em cima de dinheiro que ainda não chegou.
 *
 * O prejuízo é direto e imediato: sai nota da gaveta contra uma promessa.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');

let empresa: string;
let usuario: string;
let produto: string;

function vender(
  payments: { method: string; amountCents: number; status?: 'settled' | 'pending' }[],
  chave: string,
) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    items: [{ productId: produto, quantity: 1 }],
    payments,
    idempotencyKey: chave,
  });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_TRC',
    displayName: 'Caixa',
    password: 'Teste@Trc2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  // Produto de R$ 50,00.
  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'e1',
  });
});

describe('o troco sai do dinheiro que entrou', () => {
  it('dinheiro a mais gera troco normalmente', () => {
    const { sale } = vender([{ method: 'dinheiro', amountCents: 10000 }], 'v1');
    expect(sale.change_cents).toBe(5000);
  });

  /**
   * O CASO QUE IMPORTA.
   *
   * Cliente dá R$ 50 em dinheiro e promete R$ 30 por PIX ainda não
   * confirmado, numa compra de R$ 50. A soma de R$ 80 gera R$ 30 de troco —
   * e o caixa entrega trinta reais contra dinheiro que não chegou.
   */
  /*
    O COMPORTAMENTO MUDOU AQUI (E-venda-servidor-07, lado do servidor).

    Este caso aceitava a venda e provava só que o troco saía zero. Aceitar era
    o defeito: os R$ 30 do PIX pendente passam do total e não são troco de
    ninguém — quando o PIX caísse, entrariam no banco sem título. A tela
    (`PagamentoDialog`) já recusava; agora o servidor recusa com ela, e o que
    este caso prova passa a ser a recusa — nada gravado, nenhuma nota saindo.
  */
  it('pagamento pendente NÃO banca troco — e recebido a mais com PIX pendente é recusado', () => {
    let erro: { code?: string; status?: number } | null = null;
    try {
      vender(
        [
          { method: 'dinheiro', amountCents: 5000 },
          { method: 'pix', amountCents: 3000, status: 'pending' },
        ],
        'v1',
      );
    } catch (e) {
      erro = e as { code?: string; status?: number };
    }
    expect(erro?.code).toBe('CORE_CHANGE_WITH_PENDING');
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(empresa) as {
        n: number;
      }).n,
    ).toBe(0);
  });

  /**
   * E o dinheiro fica INTEIRO na gaveta: com o PIX pendente cobrindo a parte
   * dele e o dinheiro fechando o resto, nada é devolvido.
   *
   * (Antes o caso usava R$ 50 em dinheiro + R$ 30 pendentes numa venda de
   * R$ 50 — combinação que agora é recusada, ver o caso acima.)
   */
  it('a gaveta recebe todo o dinheiro quando o pendente não vira troco', async () => {
    const { openSession, expectedCents } = await import('../src/services/core/CashService.js');
    const caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });

    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      cashSessionId: caixa.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [
        { method: 'dinheiro', amountCents: 2000 },
        { method: 'pix', amountCents: 3000, status: 'pending' },
      ],
      idempotencyKey: 'v-gaveta',
    });

    // Vinte entraram e nada saiu: o PIX pendente não tirou nota da gaveta.
    expect(sale.change_cents).toBe(0);
    expect(expectedCents(caixa.id)).toBe(2000);
  });

  it('o mesmo PIX já confirmado é aceito, e o troco sai do dinheiro', () => {
    const { sale } = vender(
      [
        { method: 'dinheiro', amountCents: 5000 },
        { method: 'pix', amountCents: 3000, status: 'settled' },
      ],
      'v1',
    );
    // Pagou 80 numa compra de 50: o troco é 30 e cabe no dinheiro recebido.
    expect(sale.change_cents).toBe(3000);
  });

  /** Sem troco envolvido, pendente continua sendo caminho válido. */
  it('PIX pendente que fecha o valor exato passa, e nada sai da gaveta', () => {
    const { sale } = vender([{ method: 'pix', amountCents: 5000, status: 'pending' }], 'v1');
    expect(sale.change_cents).toBe(0);

    const gaveta = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_cash_movements
          WHERE company_id = ? AND reference_id = ?`,
      )
      .get(empresa, sale.id) as { n: number } | undefined;
    expect(gaveta?.n ?? 0).toBe(0);
  });

  /** Troco de cartão nunca existiu, e continua não existindo. */
  it('cartão a mais continua sendo recusado', () => {
    expect(() => vender([{ method: 'credito', amountCents: 8000 }], 'v1')).toThrow(/troco/i);
  });
});

/**
 * O vocabulário do status de pagamento, cobrado nos próprios testes.
 *
 * Dez arquivos fiscais gravavam `status: 'captured'` em `core_sale_payments`
 * por `INSERT` direto. A produção nunca escreve esse valor — o tipo em
 * `SalesService` é `'settled' | 'pending'` e mais nada. SQL cru não passa pelo
 * tipo, então a invenção entrava sem resistência.
 *
 * O efeito não era teórico: a consulta do fechamento de caixa não filtrava
 * status nenhum, e nenhum dos dez casos podia revelar isso, porque todos
 * usavam um valor que o filtro certo também deixaria de fora. Fixture
 * inventada não só deixa de pegar o defeito — ela o esconde.
 */
describe('os testes não inventam status de pagamento', () => {
  it('todo status escrito à mão nos testes existe na produção', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const dir = join(process.cwd(), 'tests');
    const permitidos = new Set(['settled', 'pending']);
    const inventados = new Set<string>();

    for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
      const texto = readFileSync(join(dir, arquivo), 'utf8');
      // Só as linhas de INSERT em core_sale_payments interessam: `status` é
      // uma palavra comum demais para varrer o arquivo inteiro.
      for (const bloco of texto.matchAll(/INSERT INTO core_sale_payments[\s\S]{0,400}?\)\s*`/g)) {
        for (const lit of bloco[0].matchAll(/'([a-z_]+)'/g)) {
          const v = lit[1]!;
          // Descarta nome de coluna e forma de pagamento; sobra o status.
          if (['settled', 'pending', 'captured', 'authorized', 'failed', 'paid'].includes(v)) {
            if (!permitidos.has(v)) inventados.add(`${arquivo}: '${v}'`);
          }
        }
      }
    }

    expect([...inventados].sort().join('\n')).toBe('');
  });
});

/**
 * O mesmo pendente, na hora de fechar.
 *
 * O troco já estava protegido; a CONFERÊNCIA não estava. `getSummary` somava
 * `core_sale_payments` filtrando só o status da VENDA, nunca o do PAGAMENTO —
 * então o PIX pendente aparecia no total por forma como dinheiro recebido.
 *
 * Quem fecha o caixa confere o papel contra a gaveta. Se o papel conta um PIX
 * que não caiu, a conferência acusa sobra ou falta que não existe, e o
 * operador assina em cima disso.
 */
describe('o fechamento não conta o que não caiu', () => {
  /*
    A venda de R$ 50 fecha com R$ 20 em dinheiro e R$ 30 de PIX pendente.

    Era R$ 50 em dinheiro + R$ 30 pendentes, que o servidor passou a recusar
    (E-venda-servidor-07: recebido a mais com PIX pendente não é troco de
    ninguém). O que estes casos protegem não muda: o PIX que não caiu fica fora
    do "por forma de pagamento" e aparece só como pendência declarada.
  */
  async function caixaComPixPendente() {
    const { openSession, getSummary } = await import('../src/services/core/CashService.js');
    const caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });

    createSale({
      companyId: empresa,
      userId: usuario,
      cashSessionId: caixa.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [
        { method: 'dinheiro', amountCents: 2000 },
        { method: 'pix', amountCents: 3000, status: 'pending' },
      ],
      idempotencyKey: 'v-fechamento',
    });

    return { caixa, resumo: getSummary(empresa, caixa.id)! };
  }

  it('PIX pendente não entra no total por forma de pagamento', async () => {
    const { resumo } = await caixaComPixPendente();
    const porForma = new Map(resumo.byMethod.map((l) => [l.method, l.total]));

    expect(porForma.get('dinheiro')).toBe(2000);
    // A linha some inteira: não há PIX recebido nesta sessão.
    expect(porForma.get('pix')).toBeUndefined();
  });

  it('o mesmo PIX confirmado entra normalmente', async () => {
    const { openSession, getSummary } = await import('../src/services/core/CashService.js');
    const caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });

    createSale({
      companyId: empresa,
      userId: usuario,
      cashSessionId: caixa.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [
        { method: 'dinheiro', amountCents: 2000 },
        { method: 'pix', amountCents: 3000, status: 'settled' },
      ],
      idempotencyKey: 'v-confirmado',
    });

    const porForma = new Map(getSummary(empresa, caixa.id)!.byMethod.map((l) => [l.method, l.total]));
    expect(porForma.get('dinheiro')).toBe(2000);
    expect(porForma.get('pix')).toBe(3000);
  });

  /**
   * A via impressa é gerada por outra consulta, em `PrintRenderer`. Duas
   * consultas com a mesma regra divergem no dia em que só uma é corrigida —
   * e aí a tela e o papel discordam sobre quanto entrou.
   */
  /*
    O TURNO É FECHADO ANTES DE IMPRIMIR (auditoria PJ, H-caixa-seguranca-11).

    Este caso imprimia o papel de fechamento de um turno ABERTO — que é
    justamente o defeito: sem fechamento, esperado e contado são nulos e o
    papel saía "CONFERIDO R$ 0,00". O papel agora recusa turno aberto (409),
    então o turno é fechado aqui, como na loja: com o PIX pendente, o
    fechamento exige declarar ciência e motivo.

    E o PIX de R$ 30,00 passa a aparecer no papel — mas no bloco da pendência
    declarada, que diz que ele NÃO está na gaveta, e não como valor recebido.
    O que este caso protege continua de pé: a seção "por forma de pagamento",
    que é a conta da tela, não soma o que não caiu.
  */
  it('a via impressa mostra o mesmo que a tela', async () => {
    const { caixa, resumo } = await caixaComPixPendente();
    const { renderDocument } = await import('../src/services/core/PrintRenderer.js');
    const { closeSession } = await import('../src/services/core/CashService.js');
    closeSession({
      companyId: empresa,
      sessionId: caixa.id,
      userId: usuario,
      countedCents: 2000,
      pendenciasCiente: true,
      pendenciasMotivo: 'o gerente confere o extrato amanhã',
    });

    const papel = renderDocument(empresa, 'CASH_CLOSING', caixa.id);
    const [recebido, pendencia] = papel.split('FECHADO COM PENDÊNCIA ELETRÔNICA');

    expect(recebido).toMatch(/20,00/);
    expect(recebido).not.toMatch(/30,00/);
    expect(pendencia).toMatch(/PIX pendente/);
    expect(pendencia).toMatch(/30,00/);
    expect(resumo.byMethod.some((l) => l.method === 'pix')).toBe(false);
  });
});
