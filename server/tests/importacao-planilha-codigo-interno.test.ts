/**
 * A CONFERÊNCIA DA PLANILHA CONHECE AS REGRAS DO CÓDIGO INTERNO (PED-prod-01).
 *
 * O cadastro passou a gravar o código interno em MAIÚSCULAS, a recusar o
 * repetido em qualquer caixa (CORE_DUPLICATE_CODE) e a recusar o código igual
 * ao EAN ou ao SKU de outro produto (CORE_CODE_CLASHES_BARCODE). A conferência
 * da planilha continuava conferindo do jeito antigo: a linha aparecia verde e
 * a confirmação caía no meio — com as outras linhas boas desfeitas junto.
 *
 * O que se cobra aqui é o estado depois da conferência e da confirmação: a
 * linha que o cadastro recusaria já sai MARCADA, e o resto do lote entra.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { confirmarLote, importarPlanilha, listarItens } = await import(
  '../src/services/core/ProductImportService.js'
);
const { getBalance } = await import('../src/services/core/InventoryService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { ApiError } = await import('../src/utils/errors.js');

let empresa: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'loja-codigos',
    legalName: 'Loja Codigos Ltda',
    tradeName: 'Loja Codigos',
    kind: 'store',
  });
});

function subir(texto: string) {
  return importarPlanilha({
    companyId: empresa,
    arquivoB64: Buffer.from(texto, 'utf8').toString('base64'),
    nomeArquivo: 'produtos.csv',
  });
}

function itens(batchId: string) {
  return listarItens(empresa, batchId, { limit: 500 }).itens;
}

function contarProdutos(): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(empresa) as { n: number }
  ).n;
}

function produtoPorNome(nome: string): { id: string; internal_code: string } | undefined {
  return getConnection()
    .prepare('SELECT id, internal_code FROM core_products WHERE company_id = ? AND name = ?')
    .get(empresa, nome) as { id: string; internal_code: string } | undefined;
}

describe('código interno em outra caixa é o MESMO código (PED-prod-01)', () => {
  it('"pj-0105" na planilha casa com o "PJ-0105" que já existe — recebe o saldo, não estoura a confirmação', () => {
    const existente = createProduct(empresa, { name: 'Martelo', internalCode: 'PJ-0105', priceCents: 3990 });

    const resumo = subir(
      'nome;codigo;preco;quantidade\n'
        + 'Martelo;pj-0105;39,90;5\n'
        + 'Serrote;;59,90;2\n',
    );

    const linhas = itens(resumo.id);
    const martelo = linhas.find((l) => l.nome === 'Martelo')!;
    // Antes: `internal_code = ?` (sensível a caixa) dizia "novo", e o cadastro
    // recusava "PJ-0105" no meio da confirmação.
    expect(martelo.acao).toBe('existe');
    expect(martelo.produtoId).toBe(String(existente.id));
    // A conferência mostra o código como o cadastro o lê.
    expect(martelo.codigoInterno).toBe('PJ-0105');
    expect(resumo.novos).toBe(1);
    expect(resumo.existentes).toBe(1);

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(1);
    expect(getBalance(empresa, String(existente.id))).toBe(5);
    expect(produtoPorNome('Serrote')).toBeTruthy();
  });

  it('código novo em minúsculas nasce em MAIÚSCULAS, igual ao que a conferência mostrou', () => {
    const resumo = subir('nome;codigo;preco\nChave de fenda;cf- 01;9,90\n');
    expect(itens(resumo.id)[0].codigoInterno).toBe('CF-01');
    confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(produtoPorNome('Chave de fenda')?.internal_code).toBe('CF-01');
  });

  it('"ab-1" e "AB-1" em duas linhas são o mesmo código repetido — erro na segunda, e a primeira entra', () => {
    const resumo = subir('nome;codigo;preco\nAlicate;ab-1;19,90\nAlicate grande;AB-1;29,90\n');
    const segunda = itens(resumo.id).find((l) => l.nome === 'Alicate grande')!;
    expect(segunda.acao).toBe('erro');
    expect(segunda.erroCodigo).toBe('CORE_IMPORT_CODIGO_REPETIDO');

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(1);
    expect(feito.ignorados).toBe(1);
  });
});

describe('código que o bipe acharia em dois produtos é erro DA LINHA (PED-prod-01)', () => {
  it('código interno igual ao EAN de outro produto: erro na linha, com a frase do cadastro — o resto do lote entra', () => {
    createProduct(empresa, { name: 'Cabo HDMI', barcode: '7891111111111', priceCents: 2590 });

    const resumo = subir(
      'nome;codigo;preco;quantidade\n'
        + 'Fonte 12V;7891111111111;89,00;4\n'
        + 'Mouse;MS-01;39,90;7\n',
    );

    const fonte = itens(resumo.id).find((l) => l.nome === 'Fonte 12V')!;
    expect(fonte.acao).toBe('erro');
    expect(fonte.erroCodigo).toBe('CORE_CODE_CLASHES_BARCODE');
    expect(fonte.erroDetalhe).toMatch(/Cabo HDMI/);
    expect(resumo.erros).toBe(1);

    // Antes: a linha era "novo", e `createProduct` a recusava no meio da
    // confirmação — o Mouse, que estava certo, não nascia.
    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(1);
    expect(feito.ignorados).toBe(1);
    expect(produtoPorNome('Mouse')).toBeTruthy();
    expect(produtoPorNome('Fonte 12V')).toBeUndefined();
  });

  it('código interno igual ao SKU de outro produto: erro na linha', () => {
    createProduct(empresa, { name: 'Parafuso', sku: 'PAR-10', priceCents: 50 });
    const resumo = subir('nome;codigo;preco\nPorca;par-10;0,30\nArruela;ARR-1;0,10\n');
    const porca = itens(resumo.id).find((l) => l.nome === 'Porca')!;
    expect(porca.acao).toBe('erro');
    expect(porca.erroCodigo).toBe('CORE_CODE_CLASHES_BARCODE');
    expect(confirmarLote({ companyId: empresa, batchId: resumo.id }).criados).toBe(1);
  });

  it('código de barras igual ao código interno de outro produto: erro na linha', () => {
    createProduct(empresa, { name: 'Tomada', internalCode: '7892222222222', priceCents: 1290 });
    const resumo = subir('nome;codigo_barras;preco\nInterruptor;7892222222222;15,90\nPlugue;7893333333333;4,90\n');
    const interruptor = itens(resumo.id).find((l) => l.nome === 'Interruptor')!;
    expect(interruptor.acao).toBe('erro');
    expect(interruptor.erroCodigo).toBe('CORE_CODE_CLASHES_BARCODE');
    expect(interruptor.erroDetalhe).toMatch(/Tomada/);
    expect(confirmarLote({ companyId: empresa, batchId: resumo.id }).criados).toBe(1);
  });

  it('duas linhas NOVAS em que o código interno de uma é o código de barras da outra: erro na segunda', () => {
    const resumo = subir(
      'nome;codigo;codigo_barras;preco\n'
        + 'Lixa;LX-100;;2,00\n'
        + 'Lixa fina;;lx-100;2,50\n'
        + 'Trena;TR-5;;19,90\n',
    );
    const fina = itens(resumo.id).find((l) => l.nome === 'Lixa fina')!;
    expect(fina.acao).toBe('erro');
    expect(fina.erroCodigo).toBe('CORE_CODE_CLASHES_BARCODE');
    expect(fina.erroDetalhe).toMatch(/linha 2/);

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(2);
    expect(contarProdutos()).toBe(2);
  });

  it('a mesma linha com o código interno igual ao próprio EAN é aceita, como no cadastro', () => {
    const resumo = subir('nome;codigo;codigo_barras;preco\nGraxa;7894444444444;7894444444444;12,00\n');
    expect(itens(resumo.id)[0].acao).toBe('novo');
    expect(confirmarLote({ companyId: empresa, batchId: resumo.id }).criados).toBe(1);
  });
});

describe('o código gerado para a linha sem código não rouba o de outra linha (PED-prod-01)', () => {
  it('linha sem código antes de uma linha que traz "gs-000001" escrito: as duas nascem', () => {
    // A sequência da empresa nova começa em 1: o primeiro número gerado seria
    // GS-000001 — exatamente o que a segunda linha traz.
    const resumo = subir('nome;codigo;preco\nPincel;;5,00\nRolo;gs-000001;15,00\n');
    expect(resumo.erros).toBe(0);

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(2);
    expect(produtoPorNome('Rolo')?.internal_code).toBe('GS-000001');
    expect(produtoPorNome('Pincel')?.internal_code).not.toBe('GS-000001');
  });
});

describe('o cadastro que mudou DEPOIS da conferência diz a linha (PED-prod-01)', () => {
  it('a recusa da confirmação traz o número da linha e o que fazer — e nada é gravado', () => {
    const resumo = subir('nome;codigo;preco\nBroca;BR-8;9,00\nBucha;BU-8;1,00\n');
    // Alguém cadastra à mão, entre a conferência e o clique em confirmar.
    createProduct(empresa, { name: 'Bucha cadastrada à mão', internalCode: 'bu-8', priceCents: 100 });

    let recusa: unknown;
    try {
      confirmarLote({ companyId: empresa, batchId: resumo.id });
    } catch (err) {
      recusa = err;
    }
    expect(recusa).toBeInstanceOf(ApiError);
    const e = recusa as InstanceType<typeof ApiError>;
    expect(e.code).toBe('CORE_DUPLICATE_CODE');
    expect(e.message).toMatch(/^Linha 3: /);
    expect(e.message).toMatch(/suba a planilha de novo/);
    // A transação desfez o lote: a Broca, que veio antes, não ficou pela metade.
    expect(produtoPorNome('Broca')).toBeUndefined();
    expect(contarProdutos()).toBe(1);
  });
});
