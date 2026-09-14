/**
 * Importação de planilha: a loja nova nascendo com catálogo E saldo.
 *
 * ## Por que existe
 *
 * A rodada anterior entregou a criação de uma operação nova — empresa, primeiro
 * gerente, primeira bancada — e parou num ponto que só apareceu na conferência
 * em tela: a loja nascia VAZIA. Cadastrar duzentos produtos à mão não é opção,
 * e catálogo sem saldo não vende, porque `applyMovement` recusa saída de
 * estoque que não existe. Uma importação que trouxesse só o cadastro entregaria
 * a metade inútil.
 *
 * ## O molde é o da nota fiscal, e de propósito
 *
 * `NfeImportService` já resolveu este problema uma vez: o arquivo entra, vira
 * um documento EM CONFERÊNCIA, a pessoa vê item a item o que o sistema
 * entendeu, e só o botão de confirmar mexe em estoque. Importação que grava
 * direto é importação em que ninguém confia — e o que se grava aqui é o
 * catálogo inteiro de uma operação.
 *
 * A diferença está na origem, e ela muda o rigor. A NF-e é documento de
 * terceiro, conferido na doca, item a item, com a mercadoria à vista. A
 * planilha é um arquivo que a própria loja digitou, com duzentas linhas que
 * ninguém vai reler uma a uma. Onde a nota pode ser tolerante, aqui é preciso
 * ser desconfiado — e é por isso que o casamento por NOME não existe neste
 * arquivo, e que a linha torta é PULADA em vez de derrubar o lote.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { lerCsv, type EncodingCsv, type SeparadorCsv } from './CsvParse.js';
import { parseQuantidade, parseReaisToCents } from './Money.js';
import {
  codigoInternoNormalizado,
  createProduct,
  exigirCodigoInternoLivre,
  exigirCodigoLivreNoBipe,
  produtoDoCodigoInterno,
  reservarCodigoInterno,
} from './CatalogService.js';
import { findProductByAnyBarcode } from './CatalogAuxService.js';
import { digitoVerificadorGtin, gtinValido, pareceGtin } from './Gtin.js';
import { applyMovement } from './InventoryService.js';
import { isSerialized } from './ProductUnitService.js';

/** Referência do movimento de estoque. Ver `MOVEMENT_KINDS`. */
export const REFERENCIA_IMPORTACAO = 'importacao_planilha';

/** Teto do arquivo, em bytes já decodificados. */
export const LIMITE_BYTES = 2 * 1024 * 1024;
/** Teto de linhas. Planilha maior que isto é migração de sistema, não abertura de loja. */
export const LIMITE_LINHAS = 5000;

export type CampoImportado =
  | 'nome'
  | 'codigo_barras'
  | 'codigo_interno'
  | 'unidade'
  | 'preco'
  | 'custo'
  | 'quantidade';

/**
 * Como o cabeçalho da planilha vira campo do produto.
 *
 * São as formas que aparecem de verdade em arquivo de fornecedor e em export
 * de sistema. Nada aqui é obrigatório — quem manda no fim é o mapa que a
 * pessoa confirma na tela; isto é só o palpite inicial, e um palpite errado
 * custa um clique, não uma reimportação.
 */
const SINONIMOS: Record<CampoImportado, string[]> = {
  nome: ['nome', 'produto', 'descricao', 'descricao_do_produto', 'name', 'description'],
  codigo_barras: ['codigo_barras', 'codigodebarras', 'cod_barras', 'barras', 'ean', 'gtin', 'barcode'],
  codigo_interno: ['codigo', 'codigo_interno', 'cod', 'sku', 'referencia', 'code'],
  unidade: ['unidade', 'un', 'unid', 'und', 'unit'],
  preco: ['preco', 'preco_venda', 'preco_de_venda', 'valor', 'venda', 'price'],
  custo: ['custo', 'preco_custo', 'preco_de_custo', 'custo_unitario', 'cost'],
  quantidade: ['quantidade', 'qtd', 'qtde', 'qtd_estoque', 'estoque', 'saldo', 'quantity', 'qty'],
};

/**
 * Cabeçalho para chave de comparação: sem acento, minúsculo, sem pontuação.
 *
 * "Código de Barras", "CODIGO DE BARRAS" e "codigo_de_barras" são a mesma
 * coluna para quem preencheu a planilha, e precisam ser a mesma aqui.
 */
function chaveDeCabecalho(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export type MapaDeColunas = Partial<Record<CampoImportado, number>>;

/**
 * O mapa guarda ÍNDICE de coluna, nunca nome.
 *
 * Planilha de verdade tem cabeçalho repetido — duas colunas chamadas "preco",
 * uma de custo e uma de venda — e tem cabeçalho vazio. Guardar por nome torna
 * o mapa ambíguo justamente nos arquivos que mais precisam de correção manual.
 * O índice é sempre único, e é o que a tela mostra ao lado do nome da coluna.
 *
 * A PRIMEIRA coluna que casa vence. Com "preco" repetido, a segunda fica sem
 * campo e aparece na tela como coluna ignorada — visível, para a pessoa
 * remapear se a ordem estiver ao contrário.
 */
export function adivinharMapa(cabecalho: string[]): MapaDeColunas {
  const chaves = cabecalho.map(chaveDeCabecalho);
  const mapa: MapaDeColunas = {};
  const usadas = new Set<number>();

  for (const campo of Object.keys(SINONIMOS) as CampoImportado[]) {
    for (const sinonimo of SINONIMOS[campo]) {
      const i = chaves.findIndex((c, idx) => c === sinonimo && !usadas.has(idx));
      if (i >= 0) {
        mapa[campo] = i;
        usadas.add(i);
        break;
      }
    }
  }
  return mapa;
}

export interface ItemDoLote {
  id: string;
  linha: number;
  nome: string | null;
  codigoBarras: string | null;
  codigoInterno: string | null;
  unidade: string | null;
  precoCents: number | null;
  custoCents: number | null;
  quantidade: number | null;
  produtoId: string | null;
  acao: 'novo' | 'existe' | 'erro';
  erroCodigo: string | null;
  erroDetalhe: string | null;
}

export interface ResumoDoLote {
  id: string;
  nomeArquivo: string;
  encoding: EncodingCsv;
  separador: SeparadorCsv;
  cabecalho: string[];
  mapa: MapaDeColunas;
  status: string;
  totalLinhas: number;
  novos: number;
  existentes: number;
  comSaldo: number;
  semSaldo: number;
  semPreco: number;
  erros: number;
  /** Lote anterior com o MESMO arquivo já confirmado, quando existe. */
  jaImportado: { id: string; confirmadoEm: string; criados: number; comSaldo: number } | null;
}

/** Célula da linha, ou null quando a coluna não foi mapeada nem existe na linha. */
function celula(celulas: string[], indice: number | undefined): string | null {
  if (indice === undefined) return null;
  const valor = celulas[indice];
  if (valor === undefined) return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}

interface LinhaLida {
  linha: number;
  nome: string | null;
  codigoBarras: string | null;
  codigoInterno: string | null;
  unidade: string | null;
  precoCents: number | null;
  custoCents: number | null;
  quantidade: number | null;
  produtoId: string | null;
  acao: 'novo' | 'existe' | 'erro';
  erroCodigo: string | null;
  erroDetalhe: string | null;
}

/** O que as linhas anteriores do mesmo arquivo já reclamaram. */
interface VistosNoLote {
  barras: Map<string, number>;
  /** Código interno JÁ normalizado (maiúsculas, sem espaço) → linha. */
  internos: Map<string, number>;
  /**
   * Os códigos das linhas que vão NASCER → linha: o que o banco ainda não
   * sabe e o cadastro vai saber na confirmação — o produto da linha 3 já
   * existirá quando a linha 9 for criada. Os dois em maiúsculas.
   */
  internosDosNovos: Map<string, number>;
  barrasDosNovos: Map<string, number>;
}

function vistosVazios(): VistosNoLote {
  return {
    barras: new Map(),
    internos: new Map(),
    internosDosNovos: new Map(),
    barrasDosNovos: new Map(),
  };
}

/**
 * Roda uma recusa do cadastro e devolve o que ela disse, em vez de lançar.
 *
 * Só `ApiError` vira erro de linha: é a recusa com código e frase para a
 * pessoa. Qualquer outra exceção é defeito do sistema e continua subindo.
 */
function recusaDoCadastro(conferir: () => void): { codigo: string; detalhe: string } | null {
  try {
    conferir();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return { codigo: err.code, detalhe: err.message };
    throw err;
  }
}

/**
 * Uma linha da planilha vira um item conferível — ou um erro com o número da
 * linha e o texto original.
 *
 * ## Por que a linha torta não derruba o lote
 *
 * A confirmação inteira roda numa transação só. Se uma célula ruim lançasse,
 * o rollback levaria junto as outras cento e noventa e sete linhas boas, e a
 * pessoa veria um erro cru DEPOIS de a tela ter mostrado tudo verde. O erro de
 * digitação de uma linha não pode custar o trabalho inteiro.
 *
 * Então o erro vira ESTADO da linha: ela fica marcada, aparece no topo da
 * conferência, é contada no rodapé, e a confirmação a pula.
 */
function lerLinha(
  companyId: string,
  linha: number,
  celulas: string[],
  mapa: MapaDeColunas,
  colunasDoCabecalho: number,
  vistos: VistosNoLote,
): LinhaLida {
  const base: LinhaLida = {
    linha,
    nome: celula(celulas, mapa.nome),
    codigoBarras: celula(celulas, mapa.codigo_barras),
    /*
      O CÓDIGO INTERNO É LIDO COMO O CADASTRO VAI GRAVÁ-LO (PED-prod-01): sem
      espaços e em maiúsculas, pela MESMA função de `createProduct`. A
      conferência mostra o que vai nascer, e as comparações abaixo passam a ser
      as do cadastro — "pj-0105" e "PJ-0105" são um código só.
    */
    codigoInterno: codigoInternoNormalizado(celula(celulas, mapa.codigo_interno)),
    unidade: celula(celulas, mapa.unidade),
    precoCents: null,
    custoCents: null,
    quantidade: null,
    produtoId: null,
    acao: 'novo',
    erroCodigo: null,
    erroDetalhe: null,
  };

  const erro = (codigo: string, detalhe: string): LinhaLida => ({
    ...base,
    acao: 'erro',
    erroCodigo: codigo,
    erroDetalhe: detalhe,
  });

  /*
    MAIS CÉLULAS QUE O CABEÇALHO É RECUSA; MENOS É NORMAL.

    Sobrar coluna quase sempre significa separador errado ou uma vírgula solta
    fora de aspas — e nesse caso TODAS as colunas da linha estão deslocadas, o
    que faria o preço entrar como unidade. Faltar coluna é só a planilha que
    termina antes: as células ausentes ficam vazias, sem deslocar nada.
  */
  if (celulas.length > colunasDoCabecalho) {
    return erro(
      'CORE_IMPORT_COLUNAS_DEMAIS',
      `A linha tem ${celulas.length} colunas e o cabeçalho tem ${colunasDoCabecalho}. Confira o separador.`,
    );
  }

  if (!base.nome) {
    return erro('CORE_IMPORT_SEM_NOME', 'Linha sem nome de produto.');
  }

  // ------------------------------------------------------------ dinheiro
  const precoTexto = celula(celulas, mapa.preco);
  if (precoTexto !== null) {
    const cents = parseReaisToCents(precoTexto);
    /*
      PREÇO ILEGÍVEL É ERRO DE LINHA, NUNCA ZERO.

      Cair em zero transformaria um erro de leitura em prejuízo: o produto
      nasceria a R$ 0,00 e o PDV o venderia de graça, sem recusa nenhuma —
      porque zero é preço válido para brinde. A célula está escrita; se não dá
      para lê-la, quem tem de decidir é a pessoa.
    */
    if (cents === null) {
      return erro('CORE_IMPORT_PRECO_ILEGIVEL', `Não consegui ler o preço "${precoTexto}".`);
    }
    base.precoCents = cents;
  }

  const custoTexto = celula(celulas, mapa.custo);
  if (custoTexto !== null) {
    const cents = parseReaisToCents(custoTexto);
    if (cents === null) {
      return erro('CORE_IMPORT_CUSTO_ILEGIVEL', `Não consegui ler o custo "${custoTexto}".`);
    }
    base.custoCents = cents;
  }

  // ---------------------------------------------------------- quantidade
  const qtdTexto = celula(celulas, mapa.quantidade);
  if (qtdTexto !== null) {
    const qtd = parseQuantidade(qtdTexto);
    if (qtd === null) {
      return erro('CORE_IMPORT_QUANTIDADE_ILEGIVEL', `Não consegui ler a quantidade "${qtdTexto}".`);
    }
    /*
      NEGATIVO É RECUSA, e a razão é que ele NÃO daria erro adiante.

      `signedDelta` faz `Math.abs` da quantidade. Uma linha com -3 chegaria em
      `applyMovement` e CRIARIA três unidades — a planilha que escreveu "-3"
      querendo dizer "faltam 3" aumentaria o saldo, em silêncio. Não há
      mensagem depois deste ponto; ou se recusa aqui, ou o estoque mente.
    */
    if (qtd < 0) {
      return erro(
        'CORE_IMPORT_QUANTIDADE_NEGATIVA',
        `A linha diz ${qtdTexto}. A importação só dá ENTRADA — corrija a planilha ou use Estoque > Ajustes e inventário para baixar.`,
      );
    }
    base.quantidade = qtd;
  }

  // ------------------------------------------------------------ identidade
  if (base.codigoBarras) {
    // GTIN com verificador errado é erro DA LINHA, na conferência — e não uma recusa no meio da
    // confirmação, que derrubaria o lote inteiro depois de a pessoa já ter conferido.
    if (pareceGtin(base.codigoBarras) && !gtinValido(base.codigoBarras)) {
      return erro(
        'CORE_BARCODE_INVALID',
        `O código de barras ${base.codigoBarras} tem o dígito verificador errado (o último deveria ser `
          + `${digitoVerificadorGtin(base.codigoBarras.slice(0, -1))}). Confira a planilha.`,
      );
    }
    const anterior = vistos.barras.get(base.codigoBarras);
    if (anterior !== undefined) {
      return erro(
        'CORE_IMPORT_BARRAS_REPETIDO',
        `O código ${base.codigoBarras} já aparece na linha ${anterior}.`,
      );
    }
    vistos.barras.set(base.codigoBarras, linha);
    base.produtoId = findProductByAnyBarcode(companyId, base.codigoBarras);
  }

  if (base.codigoInterno) {
    const anterior = vistos.internos.get(base.codigoInterno);
    if (anterior !== undefined) {
      return erro(
        'CORE_IMPORT_CODIGO_REPETIDO',
        `O código interno ${base.codigoInterno} já aparece na linha ${anterior}.`,
      );
    }
    vistos.internos.set(base.codigoInterno, linha);

    // A mesma pergunta do cadastro, em qualquer caixa (PED-prod-01). Com
    // `internal_code = ?` a linha "pj-0105" não achava o "PJ-0105", virava
    // "novo" e o cadastro a recusava no meio da confirmação.
    const porCodigo = produtoDoCodigoInterno(companyId, base.codigoInterno);

    /*
      DOIS CÓDIGOS APONTANDO PARA PRODUTOS DIFERENTES É CONFLITO DE VERDADE.

      Escolher um dos dois em silêncio poria saldo no produto errado, que é
      invisível até a prateleira discordar. Quem tem de decidir é quem montou
      a planilha.
    */
    if (porCodigo && base.produtoId && porCodigo !== base.produtoId) {
      return erro(
        'CORE_IMPORT_IDENTIDADE_AMBIGUA',
        'O código de barras e o código interno desta linha apontam para produtos diferentes.',
      );
    }
    if (porCodigo) base.produtoId = porCodigo;
  }

  base.acao = base.produtoId ? 'existe' : 'novo';

  /*
    A LINHA QUE VAI NASCER PASSA PELAS RECUSAS DO CADASTRO AQUI, NA CONFERÊNCIA
    (PED-prod-01).

    `createProduct` recusa o código interno igual ao EAN, a um adicional ou ao
    SKU de outro produto, e o código de barras igual ao código interno ou ao SKU
    de outro — senão o bipe acha dois itens. A conferência não sabia disso: a
    linha aparecia verde e a confirmação caía no meio, desfazendo o lote
    inteiro. Agora são as MESMAS funções do cadastro, e a recusa vira erro da
    linha, com a frase do cadastro.

    E as linhas do próprio lote contam: duas linhas novas em que o código
    interno de uma é o código de barras da outra passariam, cada uma, pela
    consulta ao banco — e a segunda cairia na confirmação, quando a primeira já
    existisse. A mesma linha pode ter código interno igual ao próprio EAN (o
    cadastro aceita: é o mesmo produto).
  */
  if (base.acao === 'novo') {
    const recusa = recusaDoCadastro(() => {
      if (base.codigoInterno) exigirCodigoInternoLivre(companyId, base.codigoInterno);
      exigirCodigoLivreNoBipe(companyId, base.codigoBarras, null, 'o código de barras');
    });
    if (recusa) return erro(recusa.codigo, recusa.detalhe);

    // As comparações são as de `donoDoCodigoNoBipe`: o código interno em
    // qualquer caixa contra o código de barras da outra linha, e vice-versa.
    // Barras contra barras e interno contra interno já foram vistos acima.
    const barrasEmMaiusculas = base.codigoBarras?.toUpperCase() ?? null;
    const colisoes: [string | null, Map<string, number>][] = [
      [base.codigoInterno, vistos.barrasDosNovos],
      [barrasEmMaiusculas, vistos.internosDosNovos],
    ];
    for (const [codigo, daOutraLinha] of colisoes) {
      const outra = codigo ? daOutraLinha.get(codigo) : undefined;
      if (codigo && outra !== undefined) {
        return erro(
          'CORE_CODE_CLASHES_BARCODE',
          `"${codigo}" já identifica o produto da linha ${outra} desta planilha (como código de barras ou código interno). `
            + 'Se dois produtos novos tiverem o mesmo código, o bipe no balcão acha os dois. Corrija uma das linhas.',
        );
      }
    }
    if (base.codigoInterno) vistos.internosDosNovos.set(base.codigoInterno, linha);
    if (barrasEmMaiusculas) vistos.barrasDosNovos.set(barrasEmMaiusculas, linha);
  }

  /*
    PRODUTO SERIALIZADO NÃO RECEBE SALDO POR PLANILHA.

    Chassi e IMEI não cabem numa coluna de quantidade, e `applyMovement` exige
    a lista exata de unidades. `confirmNfe` cria unidades anônimas, e ali se
    justifica: a nota é documento de um fornecedor e o pátio vem depois. Um
    arquivo que a própria loja digitou não tem essa autoridade — quarenta motos
    sem identidade seriam quarenta problemas para achar depois.

    Só acontece com produto que JÁ existe e JÁ é serializado: o que a
    importação cria nasce comum.
  */
  if (base.produtoId && base.quantidade !== null && base.quantidade > 0) {
    if (isSerialized(companyId, base.produtoId)) {
      return erro(
        'CORE_IMPORT_SERIALIZADO',
        'Este produto é controlado por unidade (chassi/IMEI). Dê entrada em Estoque > Unidades.',
      );
    }
  }

  return base;
}

/** Grava o lote e seus itens. Usado tanto pela importação quanto pela releitura. */
function gravarItens(batchId: string, companyId: string, linhas: LinhaLida[]): void {
  const db = getConnection();
  db.prepare('DELETE FROM core_import_batch_items WHERE batch_id = ?').run(batchId);

  const insert = db.prepare(
    `INSERT INTO core_import_batch_items
       (id, batch_id, company_id, line_number, name, barcode, internal_code, unit,
        price_cents, cost_cents, quantity, product_id, action, error_code, error_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of linhas) {
    insert.run(
      randomUUID(),
      batchId,
      companyId,
      l.linha,
      l.nome,
      l.codigoBarras,
      l.codigoInterno,
      l.unidade,
      l.precoCents,
      l.custoCents,
      l.quantidade,
      l.produtoId,
      l.acao,
      l.erroCodigo,
      l.erroDetalhe,
    );
  }
}

/** Lote anterior com o mesmo conteúdo, já confirmado — o aviso de reimportação. */
function lodeJaConfirmado(
  companyId: string,
  hash: string,
  exceto: string,
): ResumoDoLote['jaImportado'] {
  const row = getConnection()
    .prepare(
      `SELECT id, confirmed_at, created_products, moved_products
         FROM core_import_batches
        WHERE company_id = ? AND content_hash = ? AND status = 'confirmado' AND id <> ?
        ORDER BY confirmed_at DESC LIMIT 1`,
    )
    .get(companyId, hash, exceto) as
    | { id: string; confirmed_at: string; created_products: number; moved_products: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    confirmadoEm: row.confirmed_at,
    criados: row.created_products,
    comSaldo: row.moved_products,
  };
}

function montarResumo(companyId: string, batchId: string): ResumoDoLote {
  const db = getConnection();
  const lote = db
    .prepare('SELECT * FROM core_import_batches WHERE id = ? AND company_id = ?')
    .get(batchId, companyId) as Record<string, string | number> | undefined;
  if (!lote) throw new ApiError('CORE_IMPORT_LOTE_NAO_ENCONTRADO', 'Lote não encontrado.', 404);

  const itens = db
    .prepare('SELECT action, quantity, price_cents FROM core_import_batch_items WHERE batch_id = ?')
    .all(batchId) as { action: string; quantity: number | null; price_cents: number | null }[];

  const validos = itens.filter((i) => i.action !== 'erro');
  /*
    "SEM SALDO" E "SEM PREÇO" SÃO SOBRE OS PRODUTOS QUE VÃO NASCER.

    Contavam também as linhas que casam com produto existente, e ali as duas
    frases ficam falsas: um produto que já existe não "entra com estoque zero"
    (ele já tem o saldo que tem) nem "entra com preço R$ 0,00" (a importação
    não toca no preço de quem já existe — é a regra desta função). O número
    ficava maior que o problema, e aviso inflado é aviso que se aprende a
    ignorar.

    `comSaldo` continua contando TODOS, porque produto existente recebe entrada
    de estoque igual: ali o fato é o mesmo para os dois.
  */
  const novos = validos.filter((i) => i.action === 'novo');
  return {
    id: batchId,
    nomeArquivo: String(lote.filename),
    encoding: String(lote.encoding) as EncodingCsv,
    separador: String(lote.separator) as SeparadorCsv,
    cabecalho: JSON.parse(String(lote.header_json ?? '[]')) as string[],
    mapa: JSON.parse(String(lote.column_map)) as MapaDeColunas,
    status: String(lote.status),
    totalLinhas: itens.length,
    novos: validos.filter((i) => i.action === 'novo').length,
    existentes: validos.filter((i) => i.action === 'existe').length,
    comSaldo: validos.filter((i) => (i.quantity ?? 0) > 0).length,
    semSaldo: novos.filter((i) => (i.quantity ?? 0) <= 0).length,
    /*
      SEM PREÇO conta junto com SEM SALDO, e não é zelo excessivo.

      Produto a R$ 0,00 SAI DE GRAÇA no PDV: a venda não recusa, porque zero é
      preço legítimo de brinde. Uma planilha de fornecedor que só traz custo
      criaria duzentos produtos que o caixa entrega sem cobrar, e ninguém
      descobre até fechar o dia. Avisar do saldo e calar do preço deixaria a
      importação meio honesta.
    */
    semPreco: novos.filter((i) => !i.price_cents).length,
    erros: itens.length - validos.length,
    jaImportado: lodeJaConfirmado(companyId, String(lote.content_hash), batchId),
  };
}

/** Lê os bytes guardados e refaz os itens, com o separador e o mapa de agora. */
function reprocessar(
  companyId: string,
  batchId: string,
  opcoes: { separador?: SeparadorCsv; encoding?: EncodingCsv; mapa?: MapaDeColunas },
): ResumoDoLote {
  const db = getConnection();
  const lote = db
    .prepare('SELECT * FROM core_import_batches WHERE id = ? AND company_id = ?')
    .get(batchId, companyId) as Record<string, string> | undefined;
  if (!lote) throw new ApiError('CORE_IMPORT_LOTE_NAO_ENCONTRADO', 'Lote não encontrado.', 404);
  if (lote.status === 'confirmado') {
    throw new ApiError(
      'CORE_IMPORT_LOTE_CONFIRMADO',
      'Este lote já foi confirmado e não pode ser relido.',
      409,
    );
  }

  const bytes = new Uint8Array(Buffer.from(String(lote.content_b64), 'base64'));
  const leitura = lerCsv(bytes, { separador: opcoes.separador, encoding: opcoes.encoding });

  if (leitura.registros.length > LIMITE_LINHAS) {
    throw new ApiError(
      'CORE_IMPORT_LINHAS_DEMAIS',
      `A planilha tem ${leitura.registros.length} linhas e o limite é ${LIMITE_LINHAS}.`,
      400,
    );
  }

  const mapa = opcoes.mapa ?? adivinharMapa(leitura.cabecalho.celulas);
  const vistos = vistosVazios();
  const linhas = leitura.registros.map((r) =>
    lerLinha(companyId, r.linha, r.celulas, mapa, leitura.cabecalho.celulas.length, vistos),
  );

  db.prepare(
    `UPDATE core_import_batches
        SET encoding = ?, separator = ?, column_map = ?, header_json = ?
      WHERE id = ?`,
  ).run(
    leitura.encoding,
    leitura.separador,
    JSON.stringify(mapa),
    JSON.stringify(leitura.cabecalho.celulas),
    batchId,
  );
  gravarItens(batchId, companyId, linhas);

  return montarResumo(companyId, batchId);
}

export function importarPlanilha(input: {
  companyId: string;
  userId?: string | null;
  arquivoB64: string;
  nomeArquivo: string;
}): ResumoDoLote {
  ensureCoreSchema();

  const bruto = Buffer.from(input.arquivoB64, 'base64');
  if (bruto.length === 0) {
    throw new ApiError('CORE_IMPORT_ARQUIVO_VAZIO', 'O arquivo não tem nenhuma linha.', 400);
  }
  /*
    O TETO É DAQUI, e a rota precisa estar na lista de exceção do corpo em
    `app.ts`. Base64 cresce um terço: sem aquela linha, o body-parser recusaria
    antes desta função existir, e a pessoa receberia um erro sem texto em vez
    da mensagem abaixo.
  */
  if (bruto.length > LIMITE_BYTES) {
    throw new ApiError(
      'CORE_IMPORT_FILE_TOO_LARGE',
      `O arquivo tem ${Math.round(bruto.length / 1024)} KB e o limite é ${LIMITE_BYTES / 1024} KB.`,
      413,
    );
  }

  const hash = createHash('sha256').update(bruto).digest('hex');

  return withTransaction(() => {
    const db = getConnection();

    /*
      RASCUNHO ANTERIOR DO MESMO ARQUIVO É SUBSTITUÍDO, não duplicado.

      É o caso de quem viu o separador detectado errado e subiu de novo. Nada
      foi escrito fora do rascunho, então não há o que preservar — e deixar
      dois lotes idênticos em conferência só faria a pessoa confirmar o
      errado. Lote CONFIRMADO nunca é tocado: aquilo já virou estoque.
    */
    db.prepare(
      `DELETE FROM core_import_batches
        WHERE company_id = ? AND content_hash = ? AND status = 'conferencia'`,
    ).run(input.companyId, hash);

    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_import_batches
         (id, company_id, filename, content_hash, content_b64, encoding, separator,
          column_map, header_json, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, '', '', '{}', '[]', 'conferencia', ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.nomeArquivo,
      hash,
      bruto.toString('base64'),
      new Date().toISOString(),
      input.userId ?? null,
    );

    return reprocessar(input.companyId, id, {});
  });
}

export function relerLote(input: {
  companyId: string;
  batchId: string;
  separador?: SeparadorCsv;
  encoding?: EncodingCsv;
  mapa?: MapaDeColunas;
}): ResumoDoLote {
  ensureCoreSchema();
  return withTransaction(() =>
    reprocessar(input.companyId, input.batchId, {
      separador: input.separador,
      encoding: input.encoding,
      mapa: input.mapa,
    }),
  );
}

/**
 * Itens do lote, paginados e com os erros primeiro.
 *
 * A paginação não é enfeite: cinco mil linhas numa resposta só travam o
 * navegador na tela em que a pessoa mais precisa enxergar. E os erros vêm
 * primeiro porque são o que exige decisão — o resto ela confirma em bloco.
 */
export function listarItens(
  companyId: string,
  batchId: string,
  opcoes: { limit?: number; offset?: number; apenasErros?: boolean } = {},
): { itens: ItemDoLote[]; total: number } {
  ensureCoreSchema();
  const db = getConnection();
  const limit = Math.min(Math.max(opcoes.limit ?? 100, 1), 500);
  const offset = Math.max(opcoes.offset ?? 0, 0);
  const filtro = opcoes.apenasErros ? " AND action = 'erro'" : '';

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM core_import_batch_items
        WHERE batch_id = ? AND company_id = ?${filtro}`,
    )
    .get(batchId, companyId) as { n: number };

  const rows = db
    .prepare(
      `SELECT * FROM core_import_batch_items
        WHERE batch_id = ? AND company_id = ?${filtro}
        ORDER BY (action = 'erro') DESC, line_number ASC
        LIMIT ? OFFSET ?`,
    )
    .all(batchId, companyId, limit, offset) as Record<string, string | number | null>[];

  return {
    total: total.n,
    itens: rows.map((r) => ({
      id: String(r.id),
      linha: Number(r.line_number),
      nome: (r.name as string) ?? null,
      codigoBarras: (r.barcode as string) ?? null,
      codigoInterno: (r.internal_code as string) ?? null,
      unidade: (r.unit as string) ?? null,
      precoCents: r.price_cents === null ? null : Number(r.price_cents),
      custoCents: r.cost_cents === null ? null : Number(r.cost_cents),
      quantidade: r.quantity === null ? null : Number(r.quantity),
      produtoId: (r.product_id as string) ?? null,
      acao: String(r.action) as ItemDoLote['acao'],
      erroCodigo: (r.error_code as string) ?? null,
      erroDetalhe: (r.error_detail as string) ?? null,
    })),
  };
}

export function listarLotes(companyId: string): Record<string, unknown>[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT id, filename, status, created_at, confirmed_at,
              created_products, moved_products, skipped_rows
         FROM core_import_batches
        WHERE company_id = ?
        ORDER BY created_at DESC LIMIT 50`,
    )
    .all(companyId) as Record<string, unknown>[];
}

export function descartarLote(companyId: string, batchId: string): void {
  ensureCoreSchema();
  const info = getConnection()
    .prepare(
      "DELETE FROM core_import_batches WHERE id = ? AND company_id = ? AND status = 'conferencia'",
    )
    .run(batchId, companyId);
  if (info.changes === 0) {
    throw new ApiError(
      'CORE_IMPORT_LOTE_NAO_ENCONTRADO',
      'Lote não encontrado ou já confirmado.',
      404,
    );
  }
}

/**
 * Reserva um bloco de códigos internos livres, ANTES de criar qualquer produto.
 *
 * `generateInternalCode` avança a sequência e só depois `createProduct` confere
 * colisão. Se a loja tem um GS-000005 criado à mão enquanto a sequência está em
 * 3, a linha que chegar no 5 morre com código duplicado — e derruba o lote
 * inteiro na linha 187, depois de a tela ter mostrado tudo certo.
 *
 * Aqui cada número é reservado livre antes de gravar coisa alguma. Rodar dentro
 * da transação do lote é o que garante que um lote abortado devolva os números
 * junto.
 */
function reservarCodigos(companyId: string, quantos: number, doLote: Set<string>): string[] {
  /*
    O "LIVRE" É O DO CADASTRO, E O LOTE CONTA (PED-prod-01).

    O bloco antigo conferia só `internal_code IN (...)`, sensível a caixa e
    cego para o EAN e o SKU dos outros produtos — e cego para as linhas do
    próprio arquivo: a linha sem código ganhava o "GS-000007" que outra linha
    trazia escrito, e `createProduct` recusava no meio da confirmação. Agora
    cada número sai de `reservarCodigoInterno` (a regra de "ocupado" do
    cadastro, em qualquer papel no bipe) e pula os códigos que as linhas deste
    lote já reclamaram. Dentro da transação do lote, um lote abortado devolve
    os números junto.
  */
  const codigos: string[] = [];
  for (let i = 0; i < quantos; i += 1) {
    let codigo: string;
    try {
      codigo = reservarCodigoInterno(companyId, 'GS', doLote);
    } catch (err) {
      if (err instanceof ApiError) {
        throw new ApiError(
          'CORE_IMPORT_SEM_CODIGO_LIVRE',
          'Não consegui gerar códigos internos livres. Confira os códigos cadastrados à mão.',
          409,
        );
      }
      throw err;
    }
    doLote.add(codigo);
    codigos.push(codigo);
  }
  return codigos;
}

export interface ResultadoConfirmacao {
  criados: number;
  comSaldo: number;
  ignorados: number;
  unidadesEntradas: number;
}

export function confirmarLote(input: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}): ResultadoConfirmacao {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const lote = db
      .prepare('SELECT * FROM core_import_batches WHERE id = ? AND company_id = ?')
      .get(input.batchId, input.companyId) as Record<string, string> | undefined;
    if (!lote) throw new ApiError('CORE_IMPORT_LOTE_NAO_ENCONTRADO', 'Lote não encontrado.', 404);
    if (lote.status !== 'conferencia') {
      throw new ApiError(
        'CORE_IMPORT_LOTE_CONFIRMADO',
        'Este lote já foi confirmado.',
        409,
      );
    }

    const itens = db
      .prepare('SELECT * FROM core_import_batch_items WHERE batch_id = ? ORDER BY line_number')
      .all(input.batchId) as Record<string, string | number | null>[];

    const bons = itens.filter((i) => i.action !== 'erro');
    const ignorados = itens.length - bons.length;

    const novos = bons.filter((i) => i.action === 'novo');
    // Só quem veio SEM código ganha um; e o número gerado não pode ser nenhum
    // código que as linhas deste lote trazem escrito (PED-prod-01).
    const doLote = new Set<string>();
    for (const i of bons) {
      if (i.internal_code) doLote.add(String(i.internal_code).toUpperCase());
      if (i.barcode) doLote.add(String(i.barcode).toUpperCase());
    }
    const semCodigo = novos.filter((i) => !i.internal_code).length;
    const codigos = reservarCodigos(input.companyId, semCodigo, doLote);
    let proximoGerado = 0;

    let criados = 0;
    const porProduto = new Map<string, number>();

    /** Soma no produto, em vez de chamar o estoque duas vezes. Ver abaixo. */
    const acumular = (produtoId: string, quantidade: number | null) => {
      if (quantidade === null || quantidade <= 0) return;
      porProduto.set(produtoId, (porProduto.get(produtoId) ?? 0) + quantidade);
    };

    for (const item of bons) {
      if (item.action === 'novo') {
        const internalCode = item.internal_code
          ? String(item.internal_code)
          : codigos[proximoGerado++];
        let produto: Record<string, unknown>;
        try {
          produto = createProduct(input.companyId, {
            name: String(item.name),
            internalCode,
            barcode: (item.barcode as string) ?? undefined,
            unit: (item.unit as string) ?? 'UN',
            priceCents: item.price_cents === null ? 0 : Number(item.price_cents),
            costCents: item.cost_cents === null ? 0 : Number(item.cost_cents),
          });
        } catch (err) {
          /*
            O CADASTRO MUDOU DEPOIS DA CONFERÊNCIA (PED-prod-01).

            A conferência já passa cada linha nova pelas recusas do cadastro;
            o que ainda pode cair aqui é o produto que alguém cadastrou à mão
            entre a conferência e o clique em confirmar. A recusa crua do
            cadastro não dizia a LINHA, e a pessoa não sabia o que corrigir. A
            transação desfaz o lote inteiro; a frase diz qual linha e o que
            fazer.
          */
          if (err instanceof ApiError) {
            throw new ApiError(
              err.code,
              `Linha ${Number(item.line_number)}: ${err.message} Nada foi gravado. `
                + 'O cadastro mudou depois da conferência: suba a planilha de novo (o rascunho é substituído) '
                + 'para a linha aparecer marcada, e confirme.',
              err.status,
              { linha: Number(item.line_number) },
            );
          }
          throw err;
        }
        criados += 1;
        db.prepare('UPDATE core_import_batch_items SET product_id = ? WHERE id = ?').run(
          String(produto.id),
          String(item.id),
        );
        acumular(String(produto.id), item.quantity === null ? null : Number(item.quantity));
      } else {
        acumular(
          String(item.product_id),
          item.quantity === null ? null : Number(item.quantity),
        );
      }
    }

    /*
      AS QUANTIDADES SÃO SOMADAS POR PRODUTO ANTES DE CHEGAR AO ESTOQUE.

      A chave de idempotência de `applyMovement` é
      (empresa, referência, id da referência, produto, tipo). Como a referência
      é o LOTE, duas linhas do mesmo produto no mesmo arquivo produziriam a
      MESMA chave: a segunda chamada voltaria com `duplicated: true` e a
      quantidade dela SUMIRIA — sem erro, sem aviso, e com o saldo errado para
      sempre.

      Somar é o que a pessoa quis dizer ao repetir o produto, e a tela mostra a
      soma antes de confirmar. O mesmo alçapão existe hoje em `confirmNfe`,
      com NF-e que traz o mesmo produto em dois itens; está anotado e não é
      assunto desta rodada.
    */
    let comSaldo = 0;
    let unidadesEntradas = 0;
    for (const [produtoId, quantidade] of porProduto) {
      applyMovement({
        companyId: input.companyId,
        productId: produtoId,
        movementType: 'in',
        quantity: quantidade,
        referenceType: REFERENCIA_IMPORTACAO,
        referenceId: input.batchId,
        kind: 'SPREADSHEET_IMPORT',
        documentNumber: String(lote.filename).slice(0, 60),
        userId: input.userId ?? null,
        note: `Carga inicial: ${lote.filename}`,
      });
      comSaldo += 1;
      unidadesEntradas += quantidade;
    }

    db.prepare(
      `UPDATE core_import_batches
          SET status = 'confirmado', confirmed_at = ?, confirmed_by = ?,
              created_products = ?, moved_products = ?, skipped_rows = ?
        WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      input.userId ?? null,
      criados,
      comSaldo,
      ignorados,
      input.batchId,
    );

    return { criados, comSaldo, ignorados, unidadesEntradas };
  });
}
