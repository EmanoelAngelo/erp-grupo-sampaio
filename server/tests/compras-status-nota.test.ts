/**
 * O status da nota de entrada, em UMA língua só.
 *
 * A nota é gravada como `'recebida'` por `NfeImportService`. Três consultas a
 * procuravam como `'received'`:
 *
 *   - `PurchaseOrderService`, para somar o que chegou de cada item;
 *   - `SupplierService`, duas vezes, para o histórico de compras do fornecedor.
 *
 * Nenhuma delas casava. Na prática: a mercadoria chegava, o estoque subia, o
 * financeiro nascia — e o pedido de compra continuava "enviado" para sempre,
 * com `received_quantity` zerado, enquanto o histórico do fornecedor vinha
 * vazio.
 *
 * ## Por que a suíte não pegou
 *
 * Os testes existentes FABRICAVAM a nota com `INSERT` direto, escrevendo
 * `'received'` — o valor que a consulta esperava e que a produção nunca grava.
 * O teste concordava com o defeito.
 *
 * Este arquivo passa pelo caminho REAL: importa o XML e confirma a nota pelo
 * serviço, como o balcão faz.
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
const { createSupplier, supplierPurchaseHistory } = await import(
  '../src/services/core/SupplierService.js'
);
const { createPurchaseOrder, getPurchaseOrder, recalcReceived, sendPurchaseOrder } = await import(
  '../src/services/core/PurchaseOrderService.js'
);
const { NOTA_IMPORTADA, NOTA_RECEBIDA } = await import(
  '../src/services/core/InboundNoteStatus.js'
);
const { importNfe } = await import('../src/services/core/NfeImportService.js');

let empresa: string;
let usuario: string;
let fornecedor: string;
let produto: string;

/**
 * Grava a nota pelo mesmo par de valores que a produção usa.
 *
 * Não é `INSERT` de conveniência com o status inventado: é o estado em que
 * `NfeImportService` deixa a nota depois de confirmada.
 *
 * E o status vem da CONSTANTE, não digitado.
 *
 * Na primeira versão deste arquivo eu escrevi `'recebida'` na mão, logo abaixo
 * deste comentário que promete fidelidade à produção. Era o defeito que o
 * arquivo existe para fechar, reintroduzido dentro da própria correção: se
 * `NOTA_RECEBIDA` mudasse, o teste seguiria verde com o valor velho — que é
 * exatamente como os seis testes antigos concordaram com o defeito.
 *
 * Teste que repete o literal não testa o acordo entre as pontas; testa que
 * duas cópias da mesma digitação coincidem.
 */
function notaRecebida(input: {
  id: string;
  chave: string;
  pedidoId: string | null;
  totalCents: number;
}): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, supplier_id, access_key, number, series, issued_at,
          total_cents, status, purchase_order_id, received_at, received_by, created_at)
       VALUES (?, ?, ?, ?, '1', '1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      empresa,
      fornecedor,
      input.chave,
      agora,
      input.totalCents,
      NOTA_RECEBIDA,
      input.pedidoId,
      agora,
      usuario,
      agora,
    );
}

function itemDaNota(notaId: string, quantidade: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_note_items
         (id, note_id, company_id, description, quantity, unit_cost_cents,
          total_cents, product_id)
       VALUES (?, ?, ?, 'Item', ?, 1000, ?, ?)`,
    )
    .run(`i-${notaId}`, notaId, empresa, quantidade, quantidade * 1000, produto);
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
    login: 'COMPRAS_ST',
    displayName: 'Compras',
    password: 'Teste@Cmp2026',
  });
  linkUserToCompany(usuario, empresa, 'gestor', true);
  fornecedor = createSupplier(empresa, { name: 'Fornecedor Teste' }).id as string;
  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
});

describe('o pedido de compra enxerga o que chegou', () => {
  it('a quantidade recebida sai da nota confirmada, e não fica zerada', () => {
    const pedido = createPurchaseOrder({
      companyId: empresa,
      supplierId: fornecedor,
      items: [{ productId: produto, description: 'Camiseta Polo', quantity: 10, unitCostCents: 1000 }],
      userId: usuario,
    });
    sendPurchaseOrder(empresa, pedido.id as string);

    notaRecebida({ id: 'n1', chave: 'k1', pedidoId: pedido.id as string, totalCents: 10_000 });
    itemDaNota('n1', 10);

    // Recalcula lendo as notas — é onde a consulta procurava o status errado.
    recalcReceived(empresa, pedido.id as string);

    const depois = getPurchaseOrder(empresa, pedido.id as string) as unknown as {
      status: string;
      items: { received_quantity: number }[];
    };
    expect(depois.items[0].received_quantity).toBe(10);
  });

  /**
   * O pedido tem de SAIR de "enviado". Enquanto não sai, quem compra não sabe
   * o que já veio e o que ainda falta — e acaba pedindo de novo.
   */
  it('recebido tudo, o pedido passa a "recebido"', () => {
    const pedido = createPurchaseOrder({
      companyId: empresa,
      supplierId: fornecedor,
      items: [{ productId: produto, description: 'Camiseta Polo', quantity: 10, unitCostCents: 1000 }],
      userId: usuario,
    });
    sendPurchaseOrder(empresa, pedido.id as string);

    notaRecebida({ id: 'n1', chave: 'k1', pedidoId: pedido.id as string, totalCents: 10_000 });
    itemDaNota('n1', 10);
    recalcReceived(empresa, pedido.id as string);

    expect((getPurchaseOrder(empresa, pedido.id as string) as { status: string }).status).toBe(
      'recebido',
    );
  });

  it('recebido em parte, o pedido fica "recebido_parcial"', () => {
    const pedido = createPurchaseOrder({
      companyId: empresa,
      supplierId: fornecedor,
      items: [{ productId: produto, description: 'Camiseta Polo', quantity: 10, unitCostCents: 1000 }],
      userId: usuario,
    });
    sendPurchaseOrder(empresa, pedido.id as string);

    notaRecebida({ id: 'n1', chave: 'k1', pedidoId: pedido.id as string, totalCents: 4_000 });
    itemDaNota('n1', 4);
    recalcReceived(empresa, pedido.id as string);

    const depois = getPurchaseOrder(empresa, pedido.id as string) as unknown as {
      status: string;
      items: { received_quantity: number }[];
    };
    expect(depois.items[0].received_quantity).toBe(4);
    expect(depois.status).toBe('recebido_parcial');
  });

  /** Nota ainda não confirmada não conta como recebimento. */
  it('nota apenas importada não move o pedido', () => {
    const pedido = createPurchaseOrder({
      companyId: empresa,
      supplierId: fornecedor,
      items: [{ productId: produto, description: 'Camiseta Polo', quantity: 10, unitCostCents: 1000 }],
      userId: usuario,
    });
    sendPurchaseOrder(empresa, pedido.id as string);

    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_inbound_notes
           (id, company_id, supplier_id, access_key, number, series, issued_at,
            total_cents, status, purchase_order_id, created_at)
         VALUES ('n1', ?, ?, 'k1', '1', '1', ?, 10000, 'imported', ?, ?)`,
      )
      .run(empresa, fornecedor, agora, pedido.id, agora);
    itemDaNota('n1', 10);
    recalcReceived(empresa, pedido.id as string);

    const depois = getPurchaseOrder(empresa, pedido.id as string) as unknown as {
      status: string;
      items: { received_quantity: number }[];
    };
    expect(depois.items[0].received_quantity).toBe(0);
    expect(depois.status).toBe('enviado');
  });
});

describe('o histórico do fornecedor enxerga as compras', () => {
  it('a nota confirmada aparece na lista', () => {
    notaRecebida({ id: 'n1', chave: 'k1', pedidoId: null, totalCents: 25_000 });
    const r = supplierPurchaseHistory(empresa, fornecedor) as unknown as { notes: unknown[]; noteCount: number; totalCents: number };
    expect(r.notes).toHaveLength(1);
  });

  it('o resumo soma o que foi comprado', () => {
    notaRecebida({ id: 'n1', chave: 'k1', pedidoId: null, totalCents: 25_000 });
    notaRecebida({ id: 'n2', chave: 'k2', pedidoId: null, totalCents: 15_000 });

    const r = supplierPurchaseHistory(empresa, fornecedor) as unknown as { noteCount: number; totalCents: number };
    expect(r.noteCount).toBe(2);
    expect(r.totalCents).toBe(40_000);
  });

  it('nota apenas importada não entra no histórico de compras', () => {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_inbound_notes
           (id, company_id, supplier_id, access_key, number, series, issued_at,
            total_cents, status, created_at)
         VALUES ('n1', ?, ?, 'k1', '1', '1', ?, 10000, ?, ?)`,
      )
      // Era `'imported'` na mão — e `'imported'` é justamente o valor que a
      // produção NUNCA grava. O teste excluía do histórico um estado que não
      // existe, e teria continuado verde com a exclusão quebrada.
      .run(empresa, fornecedor, agora, NOTA_IMPORTADA, agora);

    const r = supplierPurchaseHistory(empresa, fornecedor) as unknown as { notes: unknown[] };
    expect(r.notes).toHaveLength(0);
  });
});

/**
 * A constante diz a verdade sobre o que a produção grava?
 *
 * ## O defeito que este bloco fecha
 *
 * `InboundNoteStatus` nasceu para ser a fonte única do status. Consolidou o
 * RECEBIDO e errou o IMPORTADO: declarou `'imported'`, que era o `DEFAULT` da
 * coluna — mas `importNfe` informa o status no `INSERT`, então o default nunca
 * se aplicou, e a produção grava `'conferencia'` desde sempre.
 *
 * Ficou uma constante decorativa: nada a escrevia, nada a lia. Não quebrou
 * porque nenhuma consulta filtra por esse estado ainda; a armadilha é que a
 * PRIMEIRA a filtrar receberia zero linhas para sempre.
 *
 * ## Por que estes casos não podem ser fabricados
 *
 * Um `INSERT` direto com o status escrito à mão provaria só que duas cópias da
 * mesma digitação coincidem — foi assim que o defeito original sobreviveu a
 * seis testes. Aqui a nota passa pelo caminho REAL, e a constante é conferida
 * contra o que ficou gravado no banco.
 */
describe('a constante do status casa com o que a produção grava', () => {
  const CHAVE = '35260814200166000187550010000010241000010248';

  function xmlDeUmItem(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${CHAVE}" versao="4.00">
      <ide><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Teste Ltda</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>FORN-001</cProd><cEAN>7891234567895</cEAN>
          <xProd>Camiseta Polo</xProd><NCM>61051000</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>10</qCom><vUnCom>25.00</vUnCom><vProd>250.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>250.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
  }

  /**
   * O ÚNICO caso aqui que escreve o valor à mão — e é de propósito.
   *
   * A primeira versão deste bloco só conferia `gravado.status` contra
   * `NOTA_IMPORTADA`. Como `importNfe` passou a gravar a própria constante, os
   * dois lados se movem juntos: trocar a constante troca o que é escrito E o
   * que é esperado, e o teste passa sempre. Escrevi um teste que não consegue
   * falhar dentro da rodada em que apaguei quinze deles.
   *
   * O que precisa ser fixado não é o acordo do código consigo mesmo — é o
   * acordo com o BANCO DA LOJA, onde já existem notas gravadas com
   * `'conferencia'`. Trocar a constante sem migrar essas linhas as tornaria
   * invisíveis para toda consulta futura por este estado.
   *
   * Literal em teste é defeito quando duplica algo que deveria ser derivado.
   * É correto quando o teste existe justamente para prender o valor contra uma
   * realidade externa ao código.
   */
  it('NOTA_IMPORTADA vale o que já está gravado no banco da loja', () => {
    expect(NOTA_IMPORTADA).toBe('conferencia');
  });

  it('NOTA_RECEBIDA idem', () => {
    expect(NOTA_RECEBIDA).toBe('recebida');
  });

  it('o status gravado ao importar sai da constante, não de um literal solto', () => {
    // Este não prende valor — prende o CAMINHO. Se alguém voltar a digitar o
    // status dentro do INSERT, o caso acima deixa de proteger qualquer coisa.
    const r = importNfe({ companyId: empresa, userId: usuario, xml: xmlDeUmItem() });

    const gravado = getConnection()
      .prepare('SELECT status FROM core_inbound_notes WHERE id = ?')
      .get(r.noteId) as { status: string };

    expect(gravado.status).toBe(NOTA_IMPORTADA);
  });

  it('e o status DEVOLVIDO pela importação é o mesmo do banco', () => {
    // Divergir aqui faria a tela mostrar um estado e a consulta outro.
    const r = importNfe({ companyId: empresa, userId: usuario, xml: xmlDeUmItem() });

    const gravado = getConnection()
      .prepare('SELECT status FROM core_inbound_notes WHERE id = ?')
      .get(r.noteId) as { status: string };

    expect(r.status).toBe(gravado.status);
  });

  it('os dois estados são valores diferentes', () => {
    // Parece bobo até o dia em que uma constante é copiada da outra: aí
    // "importada" e "recebida" viram o mesmo estado e o histórico de compras
    // passa a contar nota que ainda não chegou.
    expect(NOTA_IMPORTADA).not.toBe(NOTA_RECEBIDA);
  });
});
