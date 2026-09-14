/**
 * A IMPORTAÇÃO DE PLANILHA, DO ARQUIVO AO SALDO.
 *
 * A rodada 25 entregou a criação da sétima operação — empresa, gerente,
 * bancada — e parou num ponto que só apareceu na conferência: a loja nascia
 * VAZIA. Cadastrar 200 produtos à mão não é opção, e catálogo sem saldo não
 * vende, porque `applyMovement` recusa saída de estoque que não existe.
 *
 * O que se cobra aqui é o ESTADO depois da operação: quantos produtos
 * existem, quanto saldo entrou, e o que aconteceu com a linha que veio torta.
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
const { CORE_TARGET_VERSION, migrateCoreSchema } = await import(
  '../src/db/core-migrations.js'
);

let empresa: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'loja-nova',
    legalName: 'Loja Nova Ltda',
    tradeName: 'Loja Nova',
    kind: 'store',
  });
});

/*
  A MIGRAÇÃO QUE RODA VERDE E NÃO FAZ NADA já aconteceu duas vezes neste
  projeto. Um passo que só marca a versão passa por qualquer suíte que não
  olhe o banco — por isso estes testes perguntam ao SQLite, e não ao código.
*/
describe('as tabelas da importação existem de verdade', () => {
  it.each(['core_import_batches', 'core_import_batch_items'])('%s nasce com o schema', (tabela) => {
    const row = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tabela) as { name: string } | undefined;
    expect(row?.name).toBe(tabela);
  });

  it('os índices vêm junto, e não numa migração separada', () => {
    const nomes = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_import%'")
      .all() as { name: string }[];
    expect(nomes.map((n) => n.name).sort()).toEqual([
      'ix_import_batches_company',
      'ix_import_batches_hash',
      'ix_import_items_batch',
    ]);
  });

  /*
    O HASH NÃO PODE SER ÚNICO — e isto é teste porque a intenção é fácil de
    perder num "ah, é um hash, põe UNIQUE".

    Único trancaria a segunda tentativa do MESMO arquivo, que é exatamente o
    que faz quem viu o separador detectado errado. O hash serve para AVISAR,
    não para impedir.
  */
  it('o hash do arquivo NÃO é único: a segunda tentativa tem de caber', () => {
    const indices = getConnection()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all('core_import_batches') as { sql: string | null }[];
    const unicos = indices.filter((i) => (i.sql ?? '').toUpperCase().includes('UNIQUE'));
    expect(unicos).toHaveLength(0);
  });

  /*
    DUAS COISAS QUE EU ERREI AQUI, e que ficam escritas para o próximo:

    1. A versão NÃO mora no `PRAGMA user_version` — mora numa linha de
       `core_meta`. Um teste que consultasse o pragma leria zero para sempre.
    2. `ensureCoreSchema()` NÃO roda as migrações. Num banco novo ele não
       precisa: a DDL canônica já cria tudo. Quem caminha os passos é
       `migrateCoreSchema()`, chamado na subida do servidor.

    Então o que este teste faz é o que a subida faz — e o que ele prova é que
    o passo 57 é ALCANÇÁVEL e chega ao fim. Um passo que estoura no meio
    derruba a API inteira no boot, e nenhum teste de serviço perceberia.
  */
  /*
    ESTE TESTE JÁ FIXOU O NÚMERO 57 EM TRÊS LINHAS, e a rodada 27 mostrou o
    custo: o passo 58 (o XML da nota de entrada) deixou este arquivo vermelho
    sem que nada da importação de planilha tivesse mudado. O número do alvo tem
    UM dono — o teste da rodada que o move —, e aqui a pergunta é outra: o
    passo 57 é alcançável e chega ao fim?

    Então o que se cobra é a MARCA do passo 57, que é imutável por definição, e
    o fato de a migração parar no alvo, qualquer que ele seja hoje.
  */
  it('a migração aplica o passo 57 e para no alvo', () => {
    const resultado = migrateCoreSchema();
    expect(resultado.to).toBe(CORE_TARGET_VERSION);

    const marca = getConnection()
      .prepare("SELECT value FROM core_meta WHERE key = 'core_migration_step_57'")
      .get() as { value: string } | undefined;
    expect(marca?.value).toBe('applied');

    const versao = getConnection()
      .prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'")
      .get() as { value: string } | undefined;
    expect(Number(versao?.value)).toBe(CORE_TARGET_VERSION);
  });

  it('rodar a migração de novo não refaz trabalho nem estoura', () => {
    migrateCoreSchema();
    const segunda = migrateCoreSchema();
    expect(segunda.from).toBe(CORE_TARGET_VERSION);
    expect(segunda.to).toBe(CORE_TARGET_VERSION);
  });

  /*
    A ordem de exclusão é filho antes de pai, PARA CADA chave estrangeira. O
    item aponta para o lote E para o produto, então precisa sair antes dos
    dois. Um reset com a ordem errada estoura FOREIGN KEY — e já estourou
    aqui, com sete tabelas de fora.
  */
  it('o reset dos testes derruba as duas tabelas sem estourar chave', () => {
    expect(() => resetDbForTests()).not.toThrow();
    ensureCoreSchema();
    const sobrou = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_import_batches')
      .get() as { n: number };
    expect(sobrou.n).toBe(0);
  });
});

const {
  confirmarLote,
  descartarLote,
  importarPlanilha,
  listarItens,
  relerLote,
} = await import('../src/services/core/ProductImportService.js');
const { getBalance } = await import('../src/services/core/InventoryService.js');
const { addProductBarcode } = await import('../src/services/core/CatalogAuxService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');

/** Planilha em UTF-8, do jeito que o navegador a mandaria. */
function planilha(texto: string): string {
  return Buffer.from(texto, 'utf8').toString('base64');
}

function subir(texto: string, nome = 'produtos.csv') {
  return importarPlanilha({ companyId: empresa, arquivoB64: planilha(texto), nomeArquivo: nome });
}

function saldo(nome: string): number {
  const p = getConnection()
    .prepare('SELECT id FROM core_products WHERE company_id = ? AND name = ?')
    .get(empresa, nome) as { id: string } | undefined;
  if (!p) throw new Error(`produto ${nome} não existe`);
  return getBalance(empresa, p.id);
}

const TRES_LINHAS =
  'nome;codigo_barras;preco;quantidade\n' +
  'Cabo HDMI;7891111111111;25,90;10\n' +
  'Fonte 12V;7892222222222;89,00;4\n' +
  'Mouse;7893333333333;39,90;7\n';

describe('a loja nova nasce com catálogo E saldo', () => {
  it('o lote entra em conferência sem tocar em produto nem estoque', () => {
    const resumo = subir(TRES_LINHAS);

    expect(resumo.status).toBe('conferencia');
    expect(resumo.novos).toBe(3);
    expect(resumo.comSaldo).toBe(3);

    // O ponto da conferência: NADA foi gravado ainda.
    const produtos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(produtos.n).toBe(0);
  });

  it('código de barras com o verificador errado vira erro DA LINHA na conferência — e o resto do lote entra', () => {
    const resumo = subir(
      'nome;codigo_barras;preco;quantidade\n' +
        'Cabo HDMI;7891111111111;25,90;10\n' +
        'Fonte torta;7892222222224;89,00;4\n',
    );
    // Só a linha boa vai nascer; a torta fica de fora antes de a pessoa confirmar.
    expect(resumo.novos).toBe(1);
    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(1);
    const torta = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = ?')
      .get(empresa, 'Fonte torta') as { n: number };
    expect(torta.n).toBe(0);
  });

  it('confirmar cria os produtos e o saldo entra', () => {
    const resumo = subir(TRES_LINHAS);
    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });

    expect(feito.criados).toBe(3);
    expect(feito.comSaldo).toBe(3);
    expect(saldo('Cabo HDMI')).toBe(10);
    expect(saldo('Fonte 12V')).toBe(4);
    expect(saldo('Mouse')).toBe(7);
  });

  it('o preço chega em centavos, pela regra do pt-BR', () => {
    const resumo = subir(TRES_LINHAS);
    confirmarLote({ companyId: empresa, batchId: resumo.id });

    const p = getConnection()
      .prepare('SELECT price_cents FROM core_products WHERE company_id = ? AND name = ?')
      .get(empresa, 'Cabo HDMI') as { price_cents: number };
    expect(p.price_cents).toBe(2590);
  });

  /*
    O movimento tem de dizer DE ONDE o saldo veio. Se caísse em acerto de
    inventário, o primeiro fato de estoque da operação apareceria como sobra
    encontrada numa contagem que nunca houve.
  */
  it('o histórico registra carga por planilha, e não outra coisa', () => {
    const resumo = subir(TRES_LINHAS);
    confirmarLote({ companyId: empresa, batchId: resumo.id });

    const mov = getConnection()
      .prepare('SELECT DISTINCT kind, reference_type FROM core_stock_movements WHERE company_id = ?')
      .all(empresa) as { kind: string; reference_type: string }[];
    expect(mov).toHaveLength(1);
    expect(mov[0].kind).toBe('SPREADSHEET_IMPORT');
    expect(mov[0].reference_type).toBe('importacao_planilha');
  });
});

describe('confirmar duas vezes não dobra o estoque', () => {
  it('a segunda confirmação é recusada', () => {
    const resumo = subir(TRES_LINHAS);
    confirmarLote({ companyId: empresa, batchId: resumo.id });

    expect(() => confirmarLote({ companyId: empresa, batchId: resumo.id })).toThrowError(
      /já foi confirmado/i,
    );
    expect(saldo('Cabo HDMI')).toBe(10);
  });
});

/*
  O ALÇAPÃO DA IDEMPOTÊNCIA — o defeito mais caro que esta rodada podia ter.

  A chave de `applyMovement` é (empresa, referência, id da referência, produto,
  tipo). Com a referência sendo o LOTE, duas linhas do mesmo produto produzem a
  MESMA chave: a segunda chamada volta como repetida e a quantidade dela some,
  sem erro nenhum. O saldo fica errado para sempre e nada denuncia.
*/
describe('o mesmo produto em duas linhas soma, e não some', () => {
  it('dois códigos de barras diferentes do mesmo produto somam', () => {
    // Um produto só, com DOIS códigos: o da embalagem e o da caixa fechada.
    const criado = createProduct(empresa, { name: 'Óleo 1L', barcode: '7890000000000' });
    const p = String(criado.id);
    addProductBarcode(empresa, p, '7890000000017');

    const resumo = subir(
      'nome;codigo_barras;preco;quantidade\n' +
        'Óleo 1L;7890000000000;30,00;3\n' +
        'Óleo (caixa);7890000000017;30,00;5\n',
    );
    confirmarLote({ companyId: empresa, batchId: resumo.id });

    // 3 + 5, e não 3. Sem o agrupamento, a segunda linha sumiria calada.
    expect(getBalance(empresa, p)).toBe(8);
  });
});

describe('a linha torta não derruba as outras', () => {
  const COM_ERROS =
    'nome;preco;quantidade\n' +
    'Cabo;25,90;10\n' +
    ';30,00;5\n' +
    'Fonte;abc;4\n' +
    'Mouse;39,90;-3\n' +
    'Teclado;50,00;2\n';

  it('as linhas ruins viram erro com o número da linha, e não exceção', () => {
    const resumo = subir(COM_ERROS);
    expect(resumo.erros).toBe(3);
    expect(resumo.novos).toBe(2);

    const { itens } = listarItens(empresa, resumo.id, { apenasErros: true });
    expect(itens.map((i) => i.linha).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it('a quantidade negativa tem mensagem própria — ela não daria erro adiante', () => {
    const resumo = subir(COM_ERROS);
    const { itens } = listarItens(empresa, resumo.id, { apenasErros: true });
    const negativa = itens.find((i) => i.linha === 5);
    expect(negativa?.erroCodigo).toBe('CORE_IMPORT_QUANTIDADE_NEGATIVA');
    // O detalhe repete o texto original: é o que faz a pessoa achar a célula.
    expect(negativa?.erroDetalhe).toContain('-3');
  });

  it('confirmar importa as boas e pula as ruins', () => {
    const resumo = subir(COM_ERROS);
    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });

    expect(feito.criados).toBe(2);
    expect(feito.ignorados).toBe(3);
    expect(saldo('Cabo')).toBe(10);
    expect(saldo('Teclado')).toBe(2);
  });

  /*
    A CONTRAPROVA DO DESENHO: sem o erro virar ESTADO da linha, a exceção
    subiria dentro da transação única da confirmação e levaria junto as duas
    linhas boas. Aqui elas existem.
  */
  it('e as boas existem mesmo com três linhas ruins no arquivo', () => {
    const resumo = subir(COM_ERROS);
    confirmarLote({ companyId: empresa, batchId: resumo.id });
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(n.n).toBe(2);
  });
});

describe('quando a planilha não traz saldo, o sistema DIZ', () => {
  const SEM_QUANTIDADE = 'nome;preco\nCabo;25,90\nFonte;89,00\n';

  it('os produtos nascem e o saldo fica em zero, contado como sem saldo', () => {
    const resumo = subir(SEM_QUANTIDADE);
    expect(resumo.novos).toBe(2);
    expect(resumo.comSaldo).toBe(0);
    expect(resumo.semSaldo).toBe(2);

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(2);
    expect(feito.comSaldo).toBe(0);
    expect(saldo('Cabo')).toBe(0);
  });

  it('quantidade ZERO é linha válida: cria o produto e não move estoque', () => {
    const resumo = subir('nome;preco;quantidade\nCabo;25,90;0\n');
    expect(resumo.erros).toBe(0);

    const feito = confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(feito.criados).toBe(1);
    expect(feito.comSaldo).toBe(0);

    // Zero não é movimento — e `applyMovement` recusaria quantidade zero,
    // derrubando o lote inteiro se a guarda não existisse.
    const movs = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(movs.n).toBe(0);
  });
});

/*
  PRODUTO A R$ 0,00 SAI DE GRAÇA NO PDV — a venda não recusa, porque zero é
  preço legítimo de brinde. Avisar do saldo e calar do preço deixaria a
  importação meio honesta.
*/
describe('sem preço é contado com o mesmo destaque de sem saldo', () => {
  it('a planilha só de custo é contada como sem preço', () => {
    const resumo = subir('nome;custo;quantidade\nCabo;10,00;5\nFonte;40,00;2\n');
    expect(resumo.semPreco).toBe(2);
    expect(resumo.novos).toBe(2);
  });

  it('preço ilegível é ERRO de linha, e nunca vira zero', () => {
    const resumo = subir('nome;preco;quantidade\nCabo;R$ ??;5\n');
    expect(resumo.erros).toBe(1);
    const { itens } = listarItens(empresa, resumo.id, { apenasErros: true });
    expect(itens[0].erroCodigo).toBe('CORE_IMPORT_PRECO_ILEGIVEL');
  });
});

describe('produto que já existe recebe saldo, e o cadastro fica intocado', () => {
  it('nome e preço do cadastro não são reescritos pela planilha', () => {
    const criado = createProduct(empresa, {
      name: 'Cabo HDMI 2m',
      barcode: '7891111111111',
      priceCents: 4990,
    });
    const p = String(criado.id);

    const resumo = subir('nome;codigo_barras;preco;quantidade\nCABO HDMI;7891111111111;9,90;6\n');
    expect(resumo.existentes).toBe(1);
    expect(resumo.novos).toBe(0);

    confirmarLote({ companyId: empresa, batchId: resumo.id });

    const depois = getConnection()
      .prepare('SELECT name, price_cents FROM core_products WHERE id = ?')
      .get(p) as { name: string; price_cents: number };

    // Uma importação que reescreve 200 preços em silêncio é a falha mais cara
    // que esta função poderia ter. Entra o saldo, e só o saldo.
    expect(depois.name).toBe('Cabo HDMI 2m');
    expect(depois.price_cents).toBe(4990);
    expect(getBalance(empresa, p)).toBe(6);
  });
});

describe('o arquivo do Excel brasileiro, ponta a ponta', () => {
  it('Windows-1252 com acento e ponto e vírgula chegam legíveis', () => {
    // 'Válvula' com o byte 0xE1 solto, que é o que o Excel pt-BR grava.
    const linhas = 'nome;preco;quantidade\nV\xe1lvula;12,50;3\n';
    const bytes = Uint8Array.from(linhas, (c) => c.charCodeAt(0));
    const resumo = importarPlanilha({
      companyId: empresa,
      arquivoB64: Buffer.from(bytes).toString('base64'),
      nomeArquivo: 'excel.csv',
    });

    expect(resumo.encoding).toBe('windows-1252');
    expect(resumo.separador).toBe(';');

    confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(saldo('Válvula')).toBe(3);
  });
});

describe('errar o separador custa um clique, não uma reimportação', () => {
  it('a releitura usa os bytes guardados, sem pedir o arquivo de novo', () => {
    const resumo = subir('nome,preco,quantidade\nCabo,25.90,10\n', 'exportado.csv');
    expect(resumo.separador).toBe(',');

    // A pessoa discorda e manda ler com ponto e vírgula: o arquivo vira uma
    // coluna só, e a linha perde o preço e a quantidade.
    const forcado = relerLote({ companyId: empresa, batchId: resumo.id, separador: ';' });
    expect(forcado.separador).toBe(';');

    // E volta atrás sem subir nada de novo — que é o ponto de guardar os bytes.
    const devolta = relerLote({ companyId: empresa, batchId: resumo.id, separador: ',' });
    expect(devolta.separador).toBe(',');
    expect(devolta.novos).toBe(1);
    expect(devolta.comSaldo).toBe(1);
  });

  it('subir o MESMO arquivo de novo substitui o rascunho, em vez de duplicar', () => {
    const primeiro = subir(TRES_LINHAS);
    const segundo = subir(TRES_LINHAS);
    expect(segundo.id).not.toBe(primeiro.id);

    const lotes = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_import_batches WHERE company_id = ? AND status = 'conferencia'",
      )
      .get(empresa) as { n: number };
    expect(lotes.n).toBe(1);
  });

  /*
    O AVISO DA SEGUNDA IMPORTAÇÃO. Um `content_hash` ÚNICO trancaria a
    segunda tentativa do mesmo arquivo — inclusive a de quem só quer corrigir
    o separador. O hash avisa; quem decide é a pessoa.
  */
  it('subir um arquivo já CONFIRMADO avisa, e não impede', () => {
    const primeiro = subir(TRES_LINHAS);
    confirmarLote({ companyId: empresa, batchId: primeiro.id });

    const segundo = subir(TRES_LINHAS);
    expect(segundo.jaImportado).not.toBeNull();
    expect(segundo.jaImportado?.criados).toBe(3);
    expect(segundo.status).toBe('conferencia');
  });

  it('descartar apaga o rascunho e os itens junto', () => {
    const resumo = subir(TRES_LINHAS);
    descartarLote(empresa, resumo.id);

    const itens = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_import_batch_items WHERE batch_id = ?')
      .get(resumo.id) as { n: number };
    expect(itens.n).toBe(0);
  });

  it('descartar lote confirmado é recusado — aquilo já virou estoque', () => {
    const resumo = subir(TRES_LINHAS);
    confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(() => descartarLote(empresa, resumo.id)).toThrowError(/já confirmado/i);
  });
});

/*
  "ENTRA COM ESTOQUE ZERO" E "ENTRA COM PREÇO R$ 0,00" SÃO SOBRE QUEM VAI NASCER.

  As duas contagens somavam também as linhas que casam com produto existente, e
  ali as frases ficam falsas: quem já existe não "entra" com nada — mantém o
  preço que tem e recebe apenas a entrada de estoque. O número saía maior que o
  problema, e aviso inflado é aviso que se aprende a ignorar.
*/
describe('as contagens de aviso olham só os produtos novos', () => {
  it('produto que já existe não conta como sem preço nem sem saldo', () => {
    createProduct(empresa, { name: 'Cabo HDMI 2m', barcode: '7891111111111', priceCents: 4990 });

    const resumo = subir(
      'nome;codigo_barras;preco;quantidade\n' +
        'CABO;7891111111111;;\n' +
        'Fonte nova;;;\n',
    );

    expect(resumo.existentes).toBe(1);
    expect(resumo.novos).toBe(1);
    // Só a linha NOVA entra sem preço e sem saldo. A outra já existe.
    expect(resumo.semPreco).toBe(1);
    expect(resumo.semSaldo).toBe(1);
  });

  it('mas o saldo do produto existente entra normalmente', () => {
    const criado = createProduct(empresa, {
      name: 'Cabo HDMI 2m',
      barcode: '7891111111111',
      priceCents: 4990,
    });
    const resumo = subir('nome;codigo_barras;preco;quantidade\nCABO;7891111111111;;7\n');
    // `comSaldo` conta TODOS: ali o fato é o mesmo para novo e existente.
    expect(resumo.comSaldo).toBe(1);

    confirmarLote({ companyId: empresa, batchId: resumo.id });
    expect(getBalance(empresa, String(criado.id))).toBe(7);
  });
});
