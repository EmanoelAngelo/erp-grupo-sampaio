/**
 * A NOTA COM O MESMO PRODUTO EM DOIS ITENS — e a quantidade que sumia.
 *
 * ## O caso, como acontece na doca
 *
 * Fornecedor fatura a mesma peça em dois `<det>`: dois lotes, dois preços,
 * duas linhas. É comum — acontece quando parte do pedido sai de um lote com
 * desconto e parte não, e acontece sempre que o sistema do fornecedor separa
 * por validade. A nota diz 4 + 6; a prateleira recebe 10.
 *
 * ## Por que sumia, e por que ninguém percebia
 *
 * `applyMovement` é idempotente pela chave
 * (empresa, referência, id da referência, produto, tipo) — e essa chave existe
 * como UNIQUE no banco, para que uma baixa aconteça UMA vez. Em `confirmNfe` a
 * referência é a NOTA, e o laço aplicava um movimento POR ITEM. Os dois itens
 * do mesmo produto produziam a MESMA chave: o segundo voltava com
 * `duplicated: true`, a quantidade dele era descartada, e o estoque ficava com
 * 4 em vez de 10.
 *
 * Não havia erro. Não havia aviso. A tela dizia "entrada confirmada", e a
 * diferença só apareceria na próxima contagem — sem ninguém conseguir ligá-la
 * a uma nota de semanas antes.
 *
 * A importação de planilha (rodada 26) já resolvia isto somando por produto
 * antes de aplicar. Aqui ficou aberto até agora, no caminho por onde entra
 * TODA a mercadoria comprada.
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
const { confirmNfe, importNfe } = await import('../src/services/core/NfeImportService.js');
const { getBalance } = await import('../src/services/core/InventoryService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');

let empresa: string;
let usuario: string;

/**
 * Nota com a MESMA peça em dois itens: 4 de um lote e 6 de outro.
 *
 * O que amarra os dois ao mesmo produto é o `cEAN` — é por ele que
 * `matchItems` casa a linha com o cadastro.
 */
function notaComProdutoRepetido(
  k = '35260814200166000187550010000010991000010996',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${k}" versao="4.00">
      <ide><nNF>1099</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora Sao Paulo</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>SP-7001</cProd><cEAN>7890000007771</cEAN>
          <xProd>Pastilha de freio</xProd><NCM>87083090</NCM><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>4</qCom><vUnCom>50.00</vUnCom><vProd>200.00</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>SP-7001</cProd><cEAN>7890000007771</cEAN>
          <xProd>Pastilha de freio</xProd><NCM>87083090</NCM><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>6</qCom><vUnCom>47.00</vUnCom><vProd>282.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>482.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

function produtoDaNota(): string {
  const row = getConnection()
    .prepare('SELECT id FROM core_products WHERE company_id = ? AND barcode = ?')
    .get(empresa, '7890000007771') as { id: string } | undefined;
  if (!row) throw new Error('a entrada não criou o produto');
  return row.id;
}

/**
 * A peça JÁ CADASTRADA, que é o caso do dia a dia.
 *
 * Reposição é de item que a loja já vende: os dois `<det>` casam com o mesmo
 * produto na importação, e nada precisa ser criado. É aqui que a quantidade
 * some em silêncio — sem erro nenhum, porque não há cadastro a duplicar.
 */
function cadastrarAPeca(): string {
  return String(
    createProduct(empresa, {
      name: 'Pastilha de freio',
      barcode: '7890000007771',
      unit: 'UN',
    }).id,
  );
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
    login: 'CONFERENTE_DOCA',
    displayName: 'Conferente',
    password: 'Teste@Doca2026',
  });
  linkUserToCompany(usuario, empresa, 'gestor', true);
});

describe('o mesmo produto em dois itens da nota', () => {
  it('entra com a SOMA das duas linhas, e não com uma delas', () => {
    cadastrarAPeca();
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });

    // 4 + 6. Sem o agrupamento, o segundo item volta como repetido e some.
    expect(getBalance(empresa, produtoDaNota())).toBe(10);
  });

  /*
    O MOVIMENTO É UM SÓ, e isso não é detalhe de implementação: é a chave
    UNIQUE do banco. Dois movimentos com a mesma referência e o mesmo produto
    não caberiam — é justamente por isso que somar ANTES é a única saída, e não
    aplicar duas vezes.
  */
  it('e o razão de estoque registra UM movimento, com a quantidade somada', () => {
    cadastrarAPeca();
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });

    const movs = getConnection()
      .prepare(
        `SELECT quantity FROM core_stock_movements
          WHERE company_id = ? AND reference_type = 'nfe_entrada' AND product_id = ?`,
      )
      .all(empresa, produtoDaNota()) as { quantity: number }[];

    expect(movs).toHaveLength(1);
    expect(Math.abs(movs[0].quantity)).toBe(10);
  });

  it('confirmar a mesma nota duas vezes continua não dobrando o estoque', () => {
    cadastrarAPeca();
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });
    // A segunda confirmação é inócua — a idempotência que o agrupamento não
    // pode ter estragado ao juntar as linhas.
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });

    expect(getBalance(empresa, produtoDaNota())).toBe(10);
  });

  /*
    A CONFERÊNCIA CONTINUA VALENDO POR LINHA.

    Somar as quantidades não pode atropelar o que o conferente contou: se ele
    disse que do primeiro lote vieram 3 (e não 4), o estoque entra com 3 + 6.
    O que se soma é o RECEBIDO, nunca o faturado.
  */
  it('a soma usa o que foi CONFERIDO, não o que a nota diz', () => {
    cadastrarAPeca();
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });

    const itens = getConnection()
      .prepare(
        'SELECT id FROM core_inbound_note_items WHERE note_id = ? ORDER BY rowid LIMIT 1',
      )
      .get(nota.noteId) as { id: string };
    getConnection()
      .prepare('UPDATE core_inbound_note_items SET received_quantity = 3 WHERE id = ?')
      .run(itens.id);

    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });
    expect(getBalance(empresa, produtoDaNota())).toBe(9);
  });
});

/*
  A OUTRA FACE, ESSA BARULHENTA: a nota que não podia nem ser recebida.

  Quando o produto AINDA NÃO existe, a primeira linha o cadastra e a segunda
  tentava cadastrar de novo o MESMO código de barras. O cadastro recusa — e
  recusa com razão, porque dois produtos com o mesmo código de barras é o
  defeito que a rodada 26 fechou. Só que a recusa derrubava a nota INTEIRA,
  com a mensagem "este código de barras já pertence a outro produto", que não
  diz nada a quem está na doca com a mercadoria na mão.

  Agora a segunda linha reaproveita o cadastro que a primeira criou.
*/
describe('quando a peça ainda não está cadastrada', () => {
  it('a nota é recebida, e cria UM produto para as duas linhas', () => {
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    const feito = confirmNfe({
      companyId: empresa,
      userId: usuario,
      noteId: nota.noteId,
      createMissing: true,
    });

    expect(feito.createdProducts).toBe(1);

    const quantos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND barcode = ?')
      .get(empresa, '7890000007771') as { n: number };
    expect(quantos.n).toBe(1);
  });

  it('e o saldo entra somado, como no caso da peça já cadastrada', () => {
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });
    expect(getBalance(empresa, produtoDaNota())).toBe(10);
  });

  it('as DUAS linhas ficam vinculadas ao produto — nenhuma fica órfã na conferência', () => {
    const nota = importNfe({ companyId: empresa, userId: usuario, xml: notaComProdutoRepetido() });
    confirmNfe({ companyId: empresa, userId: usuario, noteId: nota.noteId, createMissing: true });

    const semProduto = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_inbound_note_items WHERE note_id = ? AND product_id IS NULL')
      .get(nota.noteId) as { n: number };
    expect(semProduto.n).toBe(0);
  });
});
