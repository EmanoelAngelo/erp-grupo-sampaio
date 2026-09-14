/**
 * Inventário: contar a prateleira e acertar o saldo.
 *
 * O ACERTO É A ÚNICA ENTRADA DE ESTOQUE SEM DOCUMENTO DE ORIGEM.
 *
 * Toda outra movimentação nasce de um fato com papel: a nota que chegou, a
 * venda que saiu, a peça que a OS consumiu. O acerto nasce de alguém afirmando
 * que o saldo é outro. Por isso o rastro aqui é mais forte — fica registrado
 * quem abriu, quem contou cada item, quanto o sistema esperava NAQUELE instante
 * e quanto foi achado. Sem isso, "acerto de inventário" vira a porta por onde
 * mercadoria some sem explicação.
 *
 * DUAS ARMADILHAS, e as duas custam estoque de verdade:
 *
 * 1. NULO NÃO É ZERO. Produto que a contagem não alcançou fica sem valor
 *    contado, e não com zero. Tratar como zero zeraria o estoque de tudo que
 *    ficou de fora do corredor que se contou hoje.
 *
 * 2. O ACERTO É DIFERENÇA, NÃO SUBSTITUIÇÃO. Entre contar e aplicar, a loja
 *    continua vendendo. Gravar o valor contado como saldo novo devolveria ao
 *    estoque tudo o que foi vendido no intervalo. O que se aplica é
 *    `contado − esperado`, somado ao saldo do momento — assim a venda legítima
 *    do intervalo continua valendo, e a falta encontrada também.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement, getBalance } from './InventoryService.js';
import { isSerialized } from './ProductUnitService.js';
import { balanceByLocation } from './StockLocationService.js';

/*
  ============================================================================
  A CONTAGEM POR LOCAL (GAP-PRD-167)
  ============================================================================

  A contagem comparava com o saldo TOTAL da empresa. Com dois locais (Preço
  Justo: loja e depósito), contar a Vitrine exigia somar o depósito de cabeça —
  ou contar a empresa inteira no mesmo dia. O local é dimensão do razão
  (`StockLocationService`): o saldo de um local é a SOMA dos movimentos dele,
  com o nulo lido como o local padrão.

  Com `location_id`, três coisas mudam, e só elas:

    - o ESPERADO congelado é o saldo DAQUELE local;
    - o ACERTO sai no mesmo local (o movimento leva `locationId`), e é
      recusado se deixaria o local negativo — além do total, que o banco já
      guarda;
    - o produto serializado compara com o saldo do local.

  O CONJUNTO de produtos segue as mesmas regras (catálogo ativo, recorte por
  categoria/busca, lista explícita): a peça fora do lugar — que o sistema acha
  que está no depósito e está na Vitrine — só aparece se estiver na lista, e é
  exatamente a sobra que a contagem existe para achar.
*/

/** O saldo que a contagem compara: do local, quando há um; da empresa, senão. */
function saldoContado(companyId: string, productId: string, locationId: string | null): number {
  if (!locationId) return getBalance(companyId, productId);
  return (
    balanceByLocation(companyId, productId).find((l) => l.locationId === locationId)?.quantity ?? 0
  );
}

export type CountStatus = 'aberta' | 'aplicada' | 'cancelada';

/**
 * O PRODUTO QUE PODE ENTRAR NUMA CONTAGEM — B-estoque-entrada-17.
 *
 * `recordCount` inseria QUALQUER `productId` que chegasse: de outra empresa,
 * modelo de grade, kit que desmembra, serviço. A contagem passava a mostrar o
 * nome e o EAN do produto alheio (o JOIN de `getInventoryCount` não filtrava a
 * empresa), e "Aplicar acerto" morria em `applyMovement`, que recusa esses
 * casos e aborta a transação inteira — a saída era cancelar a contagem.
 *
 * Uma régua só, nas duas portas (abertura com lista explícita e contagem de
 * produto fora da lista), dizendo o porquê de cada recusa.
 */
function exigirProdutoContavel(
  db: ReturnType<typeof getConnection>,
  companyId: string,
  productId: string,
): { id: string; name: string } {
  const produto = db
    .prepare(
      `SELECT p.id, p.name, p.stock_control, p.is_kit, p.kit_explode_on_sale,
              EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
         FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
    )
    .get(productId, companyId) as
    | {
        id: string;
        name: string;
        stock_control: number;
        is_kit: number;
        kit_explode_on_sale: number;
        tem_grade: number;
      }
    | undefined;
  if (!produto) {
    throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado nesta empresa.', 404);
  }
  /*
    LISTA EXPLÍCITA TAMBÉM RECUSA O SERVIÇO (GAP-V02), e a recusa é o
    contrário de um detalhe: a contagem que ACEITASSE um serviço gravaria
    esperado 0, a pessoa contaria 0, e o ajuste sairia zerado — inofensivo.
    Mas contaria 1 no dia em que alguém entendesse a linha como "quantas
    instalações eu vendi", e aí a aplicação criaria um MOVIMENTO de estoque
    para um produto que não tem estoque. Melhor dizer o porquê agora.
  */
  if (produto.stock_control === 0) {
    throw new ApiError(
      'CORE_PRODUCT_WITHOUT_STOCK_CONTROL',
      `"${produto.name}" não controla estoque e não entra em contagem: não há o que contar.`,
      400,
      { productId: produto.id },
    );
  }
  if (produto.tem_grade) {
    throw new ApiError(
      'CORE_PRODUCT_IS_GRID_MODEL',
      `"${produto.name}" é um modelo de grade: conte as variantes (tamanho/cor), que são as peças da prateleira.`,
      400,
      { productId: produto.id },
    );
  }
  if (produto.is_kit && produto.kit_explode_on_sale) {
    throw new ApiError(
      'CORE_PRODUCT_IS_KIT',
      `"${produto.name}" é um kit que desmembra na venda: conte os componentes, que são o que tem saldo.`,
      400,
      { productId: produto.id },
    );
  }
  return { id: produto.id, name: produto.name };
}

/**
 * O produto que o LEITOR bipou (B-estoque-entrada-16): primeiro entre os itens
 * da contagem (código de barras, adicional ou código interno), depois no
 * catálogo da empresa — a caixa que a lista não previa também se conta.
 */
function produtoDoCodigo(
  db: ReturnType<typeof getConnection>,
  companyId: string,
  countId: string,
  codigo: string,
): string | null {
  const daContagem = db
    .prepare(
      `SELECT i.product_id FROM core_inventory_count_items i
         JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
        WHERE i.count_id = ? AND i.company_id = ?
          AND (p.barcode = ? OR p.internal_code = ?
               OR EXISTS (SELECT 1 FROM core_product_barcodes b
                           WHERE b.product_id = p.id AND b.company_id = p.company_id AND b.barcode = ?))
        LIMIT 1`,
    )
    .get(countId, companyId, codigo, codigo, codigo) as { product_id: string } | undefined;
  if (daContagem) return daContagem.product_id;
  const doCatalogo = db
    .prepare(
      `SELECT p.id FROM core_products p
        WHERE p.company_id = ?
          AND (p.barcode = ? OR p.internal_code = ?
               OR EXISTS (SELECT 1 FROM core_product_barcodes b
                           WHERE b.product_id = p.id AND b.company_id = p.company_id AND b.barcode = ?))
        ORDER BY p.active DESC
        LIMIT 1`,
    )
    .get(companyId, codigo, codigo, codigo) as { id: string } | undefined;
  return doCatalogo?.id ?? null;
}

function loadCount(companyId: string, countId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_inventory_counts WHERE id = ? AND company_id = ?')
    .get(countId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_COUNT_NOT_FOUND', 'Contagem não encontrada.', 404);
  return row;
}

function exigirAberta(count: Record<string, unknown>): void {
  if (count.status !== 'aberta') {
    throw new ApiError(
      'CORE_COUNT_CLOSED',
      'Contagem já encerrada. Abra outra para novo acerto.',
      409,
    );
  }
}

/**
 * Abre a contagem já com os produtos que se vai conferir.
 *
 * O esperado de cada item é congelado agora. Fazer isso na hora de aplicar
 * deixaria o acerto absorver as vendas do intervalo.
 *
 * ## O recorte (`category` / `search`)
 *
 * A rota sempre aceitou `productIds`, mas a tela só mandava `scopeNote` — e
 * toda contagem aberta pela UI congelava o catálogo ativo INTEIRO. Contar o
 * corredor de bebidas numa loja de milhares de SKUs abria uma lista
 * impraticável, e o acerto avulso de UM produto exigia rolar tudo.
 *
 * O recorte descreve em termos que a tela conhece o que se vai contar:
 *
 *   CATEGORIA  o texto canônico gravado em `core_products.category` — o mesmo
 *              vocabulário do cadastro e das promoções por categoria;
 *   BUSCA      nome, código interno ou código de barras, a MESMA régua de
 *              `listStock`. Régua própria aqui divergiria da posição de
 *              estoque no primeiro dia.
 *
 * `productIds` explícito continua mandando: é a lista de quem sabe exatamente
 * o que quer contar, e recorte nenhum a segunda-adivinha. Sem nada, o
 * comportamento de sempre — inventário geral do catálogo ativo.
 */
export function openInventoryCount(input: {
  companyId: string;
  userId: string;
  scopeNote?: string | null;
  productIds?: string[];
  category?: string | null;
  search?: string | null;
  /** Contar só este local (GAP-PRD-167). Omitido = a empresa inteira. */
  locationId?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  const categoria = String(input.category ?? '').trim();
  const busca = String(input.search ?? '').trim();
  const localPedido = String(input.locationId ?? '').trim() || null;

  return withTransaction(() => {
    const db = getConnection();
    const id = randomUUID();
    const now = new Date().toISOString();

    // O local tem de ser desta empresa e estar ativo — contar um local
    // desativado congelaria um esperado que ninguém mais movimenta.
    if (localPedido) {
      const local = db
        .prepare('SELECT id FROM core_stock_locations WHERE id = ? AND company_id = ? AND active = 1')
        .get(localPedido, input.companyId);
      if (!local) {
        throw new ApiError('CORE_LOCATION_NOT_FOUND', 'Local não encontrado ou inativo.', 404);
      }
    }

    // Sem lista, entra o catálogo ativo — inteiro (inventário geral) ou o
    // RECORTE de categoria/busca, quando declarado na abertura.
    //
    // Modelo com grade fica de fora: quem tem estoque é a variante (o P e o G
    // são peças distintas na prateleira). Contar o modelo pediria um número que
    // não corresponde a nada que se possa pegar na mão.
    //
    // O SERVIÇO DE BALCÃO fica de fora pelo mesmo motivo (GAP-V02): não há
    // nada para contar. "Instalação de película: quantas você tem na
    // prateleira?" é uma linha que a contagem não sabe responder e que a pessoa
    // teria de pular em todo balanço, para sempre.
    let produtos: string[];
    if (input.productIds && input.productIds.length > 0) {
      produtos = input.productIds;
    } else {
      const params: unknown[] = [input.companyId];
      let sql = `SELECT p.id FROM core_products p
                  WHERE p.company_id = ? AND p.active = 1
                    AND p.stock_control = 1
                    AND NOT EXISTS (
                      SELECT 1 FROM core_products f WHERE f.parent_id = p.id
                    )
                    -- O kit que desmembra não tem saldo próprio: quem se conta
                    -- são os componentes (B-estoque-entrada-17).
                    AND NOT (p.is_kit = 1 AND p.kit_explode_on_sale = 1)`;
      if (categoria) {
        sql += ' AND p.category = ?';
        params.push(categoria);
      }
      if (busca) {
        sql += ' AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?)';
        params.push(`%${busca}%`, `%${busca}%`, busca);
      }
      produtos = (db.prepare(sql).all(...(params as never[])) as unknown as { id: string }[]).map(
        (r) => r.id,
      );

      /*
        RECORTE VAZIO É RECUSA, não contagem vazia.

        Uma contagem sem itens não tem o que contar nem o que aplicar — só
        abriria para ser cancelada, e a pessoa descobriria o engano (categoria
        digitada errada, busca sem resultado) DEPOIS de abrir. O catálogo
        inteiro vazio fica de fora da recusa de propósito: loja recém-criada
        sem produto nenhum sempre pôde abrir a contagem geral, e mudar isso
        quebraria comportamento que ninguém reclamou.
      */
      if ((categoria || busca) && produtos.length === 0) {
        throw new ApiError(
          'CORE_COUNT_SCOPE_EMPTY',
          'O recorte não encontrou nenhum produto ativo. Confira a categoria ou a busca.',
          400,
        );
      }
    }

    const numero = nextSequenceValue(input.companyId, 'inventory_count');

    db.prepare(
      `INSERT INTO core_inventory_counts
         (id, company_id, number, status, scope_note, opened_by, opened_at, created_at, location_id)
       VALUES (?, ?, ?, 'aberta', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      numero,
      input.scopeNote ? String(input.scopeNote).trim() : null,
      input.userId,
      now,
      now,
      localPedido,
    );

    for (const productId of produtos) {
      // A MESMA régua da contagem de produto fora da lista (B-17): empresa,
      // serviço, modelo de grade e kit que desmembra.
      exigirProdutoContavel(db, input.companyId, productId);
      db.prepare(
        `INSERT INTO core_inventory_count_items
           (id, count_id, company_id, product_id, expected_quantity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        id,
        input.companyId,
        productId,
        saldoContado(input.companyId, productId, localPedido),
        now,
      );
    }

    return getInventoryCount(input.companyId, id);
  });
}

/**
 * Registra o que foi achado na prateleira. Não mexe em estoque ainda.
 *
 * ## O bipe (B-estoque-entrada-16)
 *
 * A contagem era digitada linha a linha: bipar a caixa no filtro não achava o
 * item (o filtro não olhava o EAN) e o conferente lia o nome na etiqueta e
 * procurava a linha. Com `barcode`, o servidor acha o produto pelo código
 * lido; com `increment`, SOMA à contagem em vez de trocá-la — três bipes são
 * três unidades, e dois conferentes bipando o mesmo produto em corredores
 * diferentes somam, em vez de um apagar o outro.
 */
export function recordCount(input: {
  companyId: string;
  userId: string;
  countId: string;
  productId?: string;
  /** O código lido pelo leitor — barras, adicional ou código interno. */
  barcode?: string;
  /** Quanto se achou (substitui). Exclusivo com `increment`. */
  countedQuantity?: number;
  /** Quanto somar ao que já foi contado (o bipe). */
  increment?: number;
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const count = loadCount(input.companyId, input.countId);
    exigirAberta(count);

    const somar = input.increment !== undefined && input.increment !== null;
    const valor = Number(somar ? input.increment : input.countedQuantity);
    if (!Number.isFinite(valor) || valor < 0 || (somar && valor <= 0)) {
      throw new ApiError('CORE_COUNT_QUANTITY_INVALID', 'Quantidade contada inválida.', 400);
    }

    const db = getConnection();
    const codigo = String(input.barcode ?? '').trim();
    const productId = String(input.productId ?? '').trim()
      || (codigo ? produtoDoCodigo(db, input.companyId, input.countId, codigo) : null);
    if (!productId) {
      throw new ApiError(
        'CORE_PRODUCT_NOT_FOUND',
        codigo
          ? `Nenhum produto desta empresa tem o código ${codigo}. Confira a etiqueta ou cadastre o produto.`
          : 'Informe o produto contado.',
        404,
      );
    }
    const item = db
      .prepare(
        `SELECT id, counted_quantity FROM core_inventory_count_items
          WHERE count_id = ? AND product_id = ? AND company_id = ?`,
      )
      .get(input.countId, productId, input.companyId) as
      | { id: string; counted_quantity: number | null }
      | undefined;
    const quantidade = somar ? Number(item?.counted_quantity ?? 0) + valor : valor;

    // Produto fora da contagem entra agora, com o esperado do instante em que
    // apareceu — quem conta encontra caixa que a lista não previa. Mas só o que
    // PODE ser contado, e só desta empresa (B-estoque-entrada-17).
    if (!item) {
      exigirProdutoContavel(db, input.companyId, productId);
      db.prepare(
        `INSERT INTO core_inventory_count_items
           (id, count_id, company_id, product_id, expected_quantity, counted_quantity,
            counted_at, counted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.countId,
        input.companyId,
        productId,
        // Contagem de um local compara com o saldo DAQUELE local (GAP-PRD-167).
        saldoContado(input.companyId, productId, (count.location_id as string | null) ?? null),
        quantidade,
        new Date().toISOString(),
        input.userId,
        new Date().toISOString(),
      );
    } else {
      db.prepare(
        `UPDATE core_inventory_count_items
            SET counted_quantity = ?, counted_at = ?, counted_by = ?
          WHERE id = ?`,
      ).run(quantidade, new Date().toISOString(), input.userId, item.id);
    }

    return getInventoryCount(input.companyId, input.countId);
  });
}

/**
 * Aplica o acerto.
 *
 * Só gera movimento para item CONTADO e com diferença. Item não contado fica
 * de fora — não se sabe nada sobre ele — e item que bateu não vira linha de
 * histórico com delta zero.
 */
export function applyInventoryCount(input: {
  companyId: string;
  userId: string;
  countId: string;
  reason: string;
}): Record<string, unknown> {
  ensureCoreSchema();

  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError('CORE_COUNT_REASON_REQUIRED', 'Informe o motivo do acerto.', 400);
  }

  return withTransaction(() => {
    const count = loadCount(input.companyId, input.countId);
    exigirAberta(count);

    const db = getConnection();
    const itens = db
      .prepare(
        `SELECT * FROM core_inventory_count_items
          WHERE count_id = ? AND counted_quantity IS NOT NULL`,
      )
      .all(input.countId) as unknown as {
      id: string;
      product_id: string;
      expected_quantity: number;
      counted_quantity: number;
    }[];

    const localDaContagem = (count.location_id as string | null) ?? null;

    for (const item of itens) {
      const diferenca = item.counted_quantity - item.expected_quantity;
      if (Math.abs(diferenca) < 1e-9) continue;

      const saldoTotal = getBalance(input.companyId, item.product_id);
      // A CHECK do saldo recusa estoque negativo. Sem esta verificação o erro
      // viria do banco no meio do laço, com metade do acerto aplicado.
      if (saldoTotal + diferenca < 0) {
        throw new ApiError(
          'CORE_COUNT_WOULD_GO_NEGATIVE',
          'O acerto deixaria o saldo negativo. Confira a contagem antes de aplicar.',
          409,
        );
      }
      /*
        CONTAGEM DE UM LOCAL não pode deixar o LOCAL negativo (GAP-PRD-167).
        O banco só guarda o total; o saldo do local é soma do razão, e um acerto
        de −5 na Vitrine que só tem 3 faria a Vitrine "dever" 2 — a mesma ficção
        que `localDaSaida` existe para evitar.
      */
      const saldoAtual = localDaContagem
        ? saldoContado(input.companyId, item.product_id, localDaContagem)
        : saldoTotal;
      if (localDaContagem && saldoAtual + diferenca < -1e-9) {
        throw new ApiError(
          'CORE_COUNT_WOULD_GO_NEGATIVE',
          'O acerto deixaria o saldo DESTE LOCAL negativo — o sistema tem menos aqui do que a '
            + 'diferença contada. Confira se a mercadoria não foi transferida para outro local '
            + 'depois da abertura da contagem.',
          409,
        );
      }

      /*
        ================================================================
        PRODUTO SERIALIZADO NÃO SE ACERTA POR DIFERENÇA — E A CONTAGEM
        PRECISA TER FIM ASSIM MESMO
        ================================================================

        "Faltam 2" não diz QUAIS 2, e o acerto por número deixaria duas
        unidades marcadas como em estoque sem estar — a contagem fecharia e o
        chassi continuaria dizendo que a moto está no pátio. Isso continua
        recusado.

        O que estava errado era a PERGUNTA. A recusa comparava o contado com
        o esperado CONGELADO na abertura, e esse número não muda nunca. O
        conferente fazia exatamente o que a mensagem mandava — dar baixa na
        moto pelo chassi, em Estoque › Unidades —, o saldo caía e passava a
        bater com o que ele contou, e o acerto estourava de novo com a mesma
        frase, mandando fazer o que já tinha sido feito. A única saída era
        cancelar a contagem e recontar o pátio inteiro.

        A pergunta certa é contra o saldo de AGORA: se as baixas peça a peça
        já resolveram a divergência, não há acerto a fazer e a linha passa.
        Se ainda falta, a recusa continua — dizendo QUANTAS, que é o número
        de que quem está no pátio precisa.
      */
      if (isSerialized(input.companyId, item.product_id)) {
        const aindaFalta = saldoAtual - item.counted_quantity;
        if (Math.abs(aindaFalta) < 1e-9) continue;

        const nome = (
          db
            .prepare('SELECT name FROM core_products WHERE id = ?')
            .get(item.product_id) as { name: string } | undefined
        )?.name;
        const quantas = Math.abs(aindaFalta);
        throw new ApiError(
          'CORE_SERIALIZED_NEEDS_UNIT',
          `"${nome ?? 'Produto'}" é controlado por unidade: o acerto tem de ser feito peça a `
            + 'peça, em Estoque › Unidades, dizendo qual. '
            + (aindaFalta > 0
              ? `O sistema tem ${saldoAtual} e foram contadas ${item.counted_quantity}: `
                + `dê baixa em ${quantas} unidade(s), pelo chassi.`
              : `Foram contadas ${item.counted_quantity} e o sistema tem ${saldoAtual}: `
                + `identifique ${quantas} unidade(s) que ainda não estão cadastradas.`),
          409,
          { productId: item.product_id, faltam: quantas, saldoAtual },
        );
      }

      applyMovement({
        companyId: input.companyId,
        productId: item.product_id,
        movementType: 'adjust',
        quantity: diferenca,
        referenceType: 'inventory_count',
        referenceId: `${input.countId}:${item.product_id}`,
        kind: diferenca > 0 ? 'INVENTORY_ADJUSTMENT_POSITIVE' : 'INVENTORY_ADJUSTMENT_NEGATIVE',
        documentNumber: `Inventário #${count.number}`,
        userId: input.userId,
        reason: motivo,
        note: `Esperado ${item.expected_quantity}, contado ${item.counted_quantity}`,
        // O acerto sai NO LOCAL contado (GAP-PRD-167); sem local, o de sempre.
        locationId: localDaContagem,
      });
    }

    db.prepare(
      `UPDATE core_inventory_counts
          SET status = 'aplicada', applied_by = ?, applied_at = ?, apply_reason = ?
        WHERE id = ?`,
    ).run(input.userId, new Date().toISOString(), motivo, input.countId);

    return getInventoryCount(input.companyId, input.countId);
  });
}

export function cancelInventoryCount(
  companyId: string,
  countId: string,
  reason: string,
): Record<string, unknown> {
  ensureCoreSchema();
  const count = loadCount(companyId, countId);
  exigirAberta(count);
  const motivo = String(reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError('CORE_COUNT_REASON_REQUIRED', 'Informe o motivo do cancelamento.', 400);
  }
  getConnection()
    .prepare(
      "UPDATE core_inventory_counts SET status = 'cancelada', cancel_reason = ? WHERE id = ?",
    )
    .run(motivo, countId);
  return getInventoryCount(companyId, countId);
}

export function getInventoryCount(companyId: string, countId: string): Record<string, unknown> {
  ensureCoreSchema();
  const count = loadCount(companyId, countId);
  // `counted_by` era coluna escrita que nenhuma tela nomeava — e "QUEM contou"
  // é justamente a pergunta de quem investiga 40 peças faltando. O nome sai do
  // JOIN; o id continua na linha para não mentir se o usuário for removido.
  const items = getConnection()
    .prepare(
      `SELECT i.*, p.name, p.internal_code, p.barcode,
              -- Os códigos ADICIONAIS também acham o item no filtro e no bipe
              -- (B-estoque-entrada-16): o EAN do fabricante, o da caixa.
              (SELECT GROUP_CONCAT(b.barcode, ' ') FROM core_product_barcodes b
                WHERE b.product_id = p.id AND b.company_id = p.company_id) AS extra_barcodes,
              u.display_name AS counted_by_name
         FROM core_inventory_count_items i
         -- O produto é DESTA empresa (B-estoque-entrada-17): a linha que
         -- apontasse para o produto de outra não vaza nome nem EAN alheios.
         JOIN core_products p ON p.id = i.product_id AND p.company_id = i.company_id
         LEFT JOIN core_users u ON u.id = i.counted_by
        WHERE i.count_id = ? AND i.company_id = ?
        ORDER BY p.name`,
    )
    .all(countId, companyId) as unknown as Record<string, unknown>[];

  const contados = items.filter((i) => i.counted_quantity !== null);
  const divergentes = contados.filter(
    (i) => Math.abs(Number(i.counted_quantity) - Number(i.expected_quantity)) > 1e-9,
  );

  // O NOME do local contado (GAP-PRD-167) — o id sozinho não diz a quem conta
  // qual prateleira é. Nulo = a empresa inteira.
  const local = count.location_id
    ? (getConnection()
        .prepare('SELECT code, name FROM core_stock_locations WHERE id = ?')
        .get(count.location_id as string) as { code: string; name: string } | undefined)
    : undefined;

  return {
    ...count,
    location_code: local?.code ?? null,
    location_name: local?.name ?? null,
    items,
    resumo: {
      total: items.length,
      contados: contados.length,
      // Pendente é o que ainda não se sabe. É diferente de "conferiu e bateu".
      pendentes: items.length - contados.length,
      divergentes: divergentes.length,
      sobra: divergentes
        .filter((i) => Number(i.counted_quantity) > Number(i.expected_quantity))
        .length,
      falta: divergentes
        .filter((i) => Number(i.counted_quantity) < Number(i.expected_quantity))
        .length,
    },
  };
}

export function listInventoryCounts(
  companyId: string,
  filters: { status?: string } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  // O nome do local viaja na lista (GAP-PRD-167): duas contagens do mesmo dia,
  // uma da Vitrine e outra do depósito, precisam ser distinguíveis.
  let sql = `SELECT c.*, l.code AS location_code, l.name AS location_name
               FROM core_inventory_counts c
               LEFT JOIN core_stock_locations l ON l.id = c.location_id
              WHERE c.company_id = ?`;
  const params: (string | number)[] = [companyId];
  if (filters.status) {
    sql += ' AND c.status = ?';
    params.push(filters.status);
  }
  sql += ' ORDER BY c.number DESC LIMIT 100';
  return getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
}
