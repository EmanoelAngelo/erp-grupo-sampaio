/**
 * Entrada por XML: o que chegou e o que se deve.
 *
 * DOIS BURACOS QUE ESTE ARQUIVO FECHA
 *
 * 1. A nota dava entrada no estoque e NÃO criava contas a pagar. A mercadoria
 *    chegava na prateleira e a dívida com o fornecedor não existia em lugar
 *    nenhum: contas a pagar vazio, fluxo de caixa sem prever a saída, e a
 *    conta só aparecendo quando o fornecedor cobrava.
 *
 * 2. O estoque entrava pela quantidade do ARQUIVO. Quando o fornecedor fatura
 *    10 e descarrega 8, o saldo passava a mentir sobre a prateleira — e a
 *    mentira só apareceria na contagem seguinte, sem ninguém saber a origem.
 *
 * A regra de negócio das duas juntas: o ESTOQUE entra com o que chegou, porque
 * estoque tem que refletir a prateleira; a DÍVIDA é a da nota, porque é o que
 * está faturado. A diferença fica registrada — negociar abatimento é conversa
 * de gente, não decisão do sistema.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';
import {
  conferirItem,
  confirmNfe,
  importNfe,
} from '../src/services/core/NfeImportService.js';

const CHAVE = '35240114200166000187550010000000015123456789';

function nfeXml(chave = CHAVE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide><nNF>1024</nNF><serie>1</serie><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>14200166000187</CNPJ><xNome>Distribuidora de Pecas Ltda</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>FORN-001</cProd><cEAN>7891234567895</cEAN>
          <xProd>Filtro de oleo</xProd><NCM>84212300</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>10</qCom><vUnCom>25.00</vUnCom><vProd>250.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>250.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

let gringa: string;

function importar(): string {
  return importNfe({ companyId: gringa, userId: 'u-1', xml: nfeXml() }).noteId;
}

function contasAPagar() {
  return getConnection()
    .prepare(
      `SELECT amount_cents, direction, status, due_date, origin_type, origin_id,
              supplier_id, description
         FROM core_finance_entries WHERE company_id = ?`,
    )
    .all(gringa) as unknown as Record<string, unknown>[];
}

function saldo(): number {
  const linha = getConnection()
    .prepare(
      `SELECT s.quantity FROM core_stock s
         JOIN core_products p ON p.id = s.product_id
        WHERE s.company_id = ? AND p.name = 'Filtro de oleo'`,
    )
    .get(gringa) as { quantity: number } | undefined;
  return linha?.quantity ?? 0;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('contas a pagar', () => {
  it('receber a nota cria a dívida com o fornecedor', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    const contas = contasAPagar();
    expect(contas).toHaveLength(1);
    expect(contas[0].direction).toBe('out');
    expect(contas[0].amount_cents).toBe(25000);
    expect(contas[0].status).toBe('open');
    expect(contas[0].origin_type).toBe('nfe_entrada');
    expect(contas[0].origin_id).toBe(noteId);
  });

  it('a conta aponta para o fornecedor da nota', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    const fornecedor = getConnection()
      .prepare('SELECT id, name FROM core_suppliers WHERE company_id = ?')
      .get(gringa) as { id: string; name: string };
    expect(fornecedor.name).toBe('Distribuidora de Pecas Ltda');
    expect(contasAPagar()[0].supplier_id).toBe(fornecedor.id);
  });

  it('confirmar duas vezes NÃO cria duas dívidas', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    // A UNIQUE (origin_type, origin_id, direction) é o que segura isso.
    expect(contasAPagar()).toHaveLength(1);
  });

  it('a descrição diz o número da nota — é assim que o financeiro acha o papel', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(String(contasAPagar()[0].description)).toContain('1024');
  });
});

/**
 * O PRAZO DO FORNECEDOR TEM DE CHEGAR AO VENCIMENTO.
 *
 * `core_suppliers.payment_term_days` era digitado no cadastro, exibido na tela
 * como "30 dias" e lido por NINGUÉM. O vencimento da dívida era a data de hoje,
 * então toda compra nascia vencida no dia em que a mercadoria chegava e o
 * painel de contas a pagar abria com atraso que não existia.
 *
 * Os testes daqui quebram se o leitor sair: sem ele, o prazo de 30 dias volta a
 * ser hoje, e é exatamente a asserção que falha.
 */
describe('vencimento da compra sai do prazo do fornecedor', () => {
  function fornecedorDaNota(): { id: string } {
    return getConnection()
      .prepare('SELECT id FROM core_suppliers WHERE company_id = ?')
      .get(gringa) as { id: string };
  }

  function comPrazo(dias: number, noteId: string): void {
    // O fornecedor nasce na IMPORTAÇÃO, a partir do <emit> da nota. Por isso o
    // prazo é gravado entre importar e confirmar — é a ordem real: o comprador
    // cadastra o prazo negociado antes de a carga ser recebida.
    getConnection()
      .prepare('UPDATE core_suppliers SET payment_term_days = ? WHERE id = ?')
      .run(dias, fornecedorDaNota().id);
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
  }

  /*
    ESTE AJUDANTE ERRAVA JUNTO COM O CÓDIGO — e por isso não acusava nada.

    Ele copiava o corpo antigo de `diaMaisNaCompra`, inclusive o
    `new Date().toISOString().slice(0, 10)` que responde o dia de GREENWICH. Um
    teste que reproduz a conta que audita não mede a conta: ele só confirma que
    o serviço faz o que o teste faz. Entre 21h e a meia-noite estes três casos
    passavam com o vencimento errado — e, na virada do mês, ficavam vermelhos
    sozinhos sem que ninguém tivesse mexido em nada.

    Agora a expectativa é montada do dia da LOJA, que é a resposta que o
    fornecedor combinou.
  */
  function diaMais(dias: number): string {
    return somarDias(hojeNaLoja(), dias);
  }

  it('30 dias no cadastro viram 30 dias no vencimento', () => {
    const noteId = importar();
    comPrazo(30, noteId);
    expect(contasAPagar()[0].due_date).toBe(diaMais(30));
  });

  it('prazo ZERO é à vista: vence hoje, como sempre foi', () => {
    const noteId = importar();
    comPrazo(0, noteId);
    // Zero é o DEFAULT da coluna: quem nunca preencheu o cadastro não pode ser
    // surpreendido por um vencimento que ninguém combinou.
    expect(contasAPagar()[0].due_date).toBe(diaMais(0));
  });

  it('sem tocar no cadastro, o comportamento é o de antes', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(contasAPagar()[0].due_date).toBe(diaMais(0));
  });

  it('nota JÁ CONFIRMADA não tem o vencimento reescrito', () => {
    const noteId = importar();
    comPrazo(0, noteId);
    const vencimentoOriginal = contasAPagar()[0].due_date;

    // O dono cadastra o prazo DEPOIS e reconfirma a nota. O passado fica como
    // está: aquele lançamento pode já ter sido pago, renegociado ou conciliado,
    // e reescrevê-lo para embelezar o painel é mexer no que o financeiro usou.
    getConnection()
      .prepare('UPDATE core_suppliers SET payment_term_days = 45 WHERE id = ?')
      .run(fornecedorDaNota().id);
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    expect(contasAPagar()).toHaveLength(1);
    expect(contasAPagar()[0].due_date).toBe(vencimentoOriginal);
  });
});

/**
 * O CUSTO DO PRODUTO SÓ MUDA SE ALGUMA COISA ENTROU.
 *
 * O UPDATE de `cost_cents` morava FORA do `if (quantidadeEntrada > 0)`: item
 * conferido com ZERO recebido reescrevia o custo do produto assim mesmo, a
 * partir de mercadoria que nunca chegou à prateleira. E custo não fica parado
 * num campo — é o que a margem calcula, o que o markup sugere e o que o
 * relatório de lucro subtrai.
 */
describe('custo do produto e o que realmente chegou', () => {
  function custo(): number {
    const linha = getConnection()
      .prepare("SELECT cost_cents FROM core_products WHERE company_id = ? AND name = 'Filtro de oleo'")
      .get(gringa) as { cost_cents: number } | undefined;
    return linha?.cost_cents ?? -1;
  }

  it('carga recebida atualiza o custo', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(custo()).toBe(2500);
  });

  it('conferido ZERO: o custo do cadastro NÃO é tocado', () => {
    const noteId = importar();
    conferirItem({
      companyId: gringa,
      noteId,
      itemIndex: 0,
      receivedQuantity: 0,
      divergenceNote: 'Item não veio',
    });
    // O produto é criado na confirmação com o custo da nota, então o valor de
    // partida é o mesmo; o que este teste cobra é o CAMINHO: nada entrou, nada
    // se moveu. Por isso o saldo é conferido junto — custo atualizado sem
    // movimento é a assinatura do defeito.
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(saldo()).toBe(0);

    // Segunda nota do MESMO produto, mais cara, também conferida com zero: se
    // o UPDATE voltar para fora do `if`, o custo pula para 4000 sem que uma
    // única peça tenha entrado — e a margem da loja inteira muda por causa de
    // uma carga que não veio.
    const chave2 = '35240114200166000187550010000000025123456789';
    const xml2 = nfeXml(chave2).replace('<vUnCom>25.00</vUnCom>', '<vUnCom>40.00</vUnCom>');
    const nota2 = importNfe({ companyId: gringa, userId: 'u-1', xml: xml2 }).noteId;
    conferirItem({ companyId: gringa, noteId: nota2, itemIndex: 0, receivedQuantity: 0 });
    confirmNfe({ companyId: gringa, noteId: nota2, userId: 'u-1', createMissing: true });

    expect(custo()).toBe(2500);
  });
});

describe('conferência da quantidade', () => {
  it('sem conferir, vale a quantidade da nota', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(saldo()).toBe(10);
  });

  it('chegou menos: o estoque entra com o que chegou', () => {
    const noteId = importar();
    conferirItem({
      companyId: gringa,
      noteId,
      itemIndex: 0,
      receivedQuantity: 8,
      divergenceNote: 'Faltaram 2 caixas',
    });
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    // Dar entrada de 10 faria o saldo mentir sobre a prateleira.
    expect(saldo()).toBe(8);
  });

  it('a dívida continua sendo a da NOTA, mesmo chegando menos', () => {
    const noteId = importar();
    conferirItem({ companyId: gringa, noteId, itemIndex: 0, receivedQuantity: 8 });
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    // Abater sozinho seria o sistema decidir uma negociação que é de gente.
    expect(contasAPagar()[0].amount_cents).toBe(25000);
  });

  it('a divergência é contada e devolvida no resultado', () => {
    const noteId = importar();
    conferirItem({ companyId: gringa, noteId, itemIndex: 0, receivedQuantity: 8 });
    const r = confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(r.divergentItems).toBe(1);
  });

  it('conferir ZERO é diferente de não conferir: nada entra', () => {
    const noteId = importar();
    conferirItem({
      companyId: gringa,
      noteId,
      itemIndex: 0,
      receivedQuantity: 0,
      divergenceNote: 'Item não veio',
    });
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    // Tratar zero como "não conferido" daria entrada de mercadoria ausente.
    expect(saldo()).toBe(0);
  });

  it('chegou MAIS do que a nota também entra pelo que chegou', () => {
    const noteId = importar();
    conferirItem({ companyId: gringa, noteId, itemIndex: 0, receivedQuantity: 12 });
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });
    expect(saldo()).toBe(12);
  });

  it('a observação da divergência fica gravada', () => {
    const noteId = importar();
    conferirItem({
      companyId: gringa,
      noteId,
      itemIndex: 0,
      receivedQuantity: 8,
      divergenceNote: 'Duas caixas avariadas, devolvidas ao motorista',
    });

    const item = getConnection()
      .prepare('SELECT received_quantity, divergence_note FROM core_inbound_note_items WHERE note_id = ?')
      .get(noteId) as { received_quantity: number; divergence_note: string };
    expect(item.received_quantity).toBe(8);
    expect(item.divergence_note).toContain('avariadas');
  });

  it('quantidade negativa é recusada', () => {
    const noteId = importar();
    expect(() =>
      conferirItem({ companyId: gringa, noteId, itemIndex: 0, receivedQuantity: -1 }),
    ).toThrow();
  });

  it('conferir DEPOIS de receber é recusado — vira ajuste de inventário', () => {
    const noteId = importar();
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    expect(() =>
      conferirItem({ companyId: gringa, noteId, itemIndex: 0, receivedQuantity: 5 }),
    ).toThrow(/ajuste de inventário/i);
  });
});

/**
 * ============================================================================
 * NOTA 'RECEBIDA' SEM DÍVIDA — a investigação do GAP-V21, escrita como guarda
 * ============================================================================
 *
 * O banco operacional tem UMA nota real (NF 9991, R$ 1.485,60) em 'recebida'
 * sem NENHUM lançamento de origem no financeiro. A investigação no código
 * concluiu: NÃO é caminho vivo. `confirmNfe` cria a dívida NA MESMA transação
 * do estoque e do status desde a rodada que integrou compras ao financeiro —
 * a NF 9991 foi confirmada ANTES dessa rodada, e a decisão registrada (ver o
 * comentário no serviço) é não reescrever o passado: aquele valor pode já ter
 * sido pago por fora, e fabricar dívida retroativa cobraria o dono duas vezes.
 * A providência é humana: o dono confere se a NF 9991 foi paga e, se preciso,
 * lança a conta manualmente.
 *
 * O que o código PODE garantir é que o buraco não reabre: a varredura abaixo
 * fica vermelha se QUALQUER caminho futuro voltar a carimbar 'recebida' sem
 * criar a dívida. A única exceção legítima é a nota de total ZERO
 * (bonificação/brinde) — dívida de zero centavos não é dívida.
 */
describe('recebida sem dívida não volta a nascer (GAP-V21)', () => {
  /** Toda nota 'recebida' com total > 0 sem lançamento de origem — deve ser vazio. */
  function recebidasSemDivida(): Record<string, unknown>[] {
    return getConnection()
      .prepare(
        `SELECT n.id, n.number, n.total_cents
           FROM core_inbound_notes n
          WHERE n.company_id = ? AND n.status = 'recebida' AND n.total_cents > 0
            AND NOT EXISTS (
              SELECT 1 FROM core_finance_entries e
               WHERE e.origin_id = n.id AND e.direction = 'out'
                 AND e.origin_type IN ('nfe_entrada', 'entrada_manual')
            )`,
      )
      .all(gringa) as unknown as Record<string, unknown>[];
  }

  it('depois de confirmar — inclusive com divergência da doca — não existe nota recebida sem dívida', () => {
    const cheia = importar();
    confirmNfe({ companyId: gringa, noteId: cheia, userId: 'u-1', createMissing: true });

    const divergente = importNfe({
      companyId: gringa,
      userId: 'u-1',
      xml: nfeXml('35240114200166000187550010000000035123456789'),
    }).noteId;
    conferirItem({ companyId: gringa, noteId: divergente, itemIndex: 0, receivedQuantity: 3 });
    confirmNfe({ companyId: gringa, noteId: divergente, userId: 'u-1', createMissing: true });

    expect(recebidasSemDivida()).toEqual([]);
  });

  it('a exceção declarada: nota de total ZERO (bonificação) recebe sem criar dívida — de propósito', () => {
    const chave = '35240114200166000187550010000000045123456789';
    const xmlZerado = nfeXml(chave)
      .replace('<vUnCom>25.00</vUnCom>', '<vUnCom>0.00</vUnCom>')
      .replace('<vProd>250.00</vProd>', '<vProd>0.00</vProd>')
      .replace('<vNF>250.00</vNF>', '<vNF>0.00</vNF>');
    const noteId = importNfe({ companyId: gringa, userId: 'u-1', xml: xmlZerado }).noteId;
    confirmNfe({ companyId: gringa, noteId, userId: 'u-1', createMissing: true });

    const nota = getConnection()
      .prepare('SELECT status, total_cents FROM core_inbound_notes WHERE id = ?')
      .get(noteId) as { status: string; total_cents: number };
    expect(nota.status).toBe('recebida');
    expect(nota.total_cents).toBe(0);
    // Dívida de zero centavos não é dívida — e a varredura acima a exclui
    // pelo `total_cents > 0`, então o brinde não vira alarme falso.
    expect(contasAPagar()).toHaveLength(0);
  });
});
