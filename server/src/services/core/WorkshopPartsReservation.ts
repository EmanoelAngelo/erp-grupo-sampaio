/**
 * O CICLO DA PEÇA PROMETIDA — rodada 55.
 *
 * ============================================================================
 * POR QUE ISTO EXISTE
 * ============================================================================
 *
 * A peça lançada numa OS baixava do estoque na hora. Só que o lançamento vem
 * ANTES da decisão do cliente: a oficina precisa de peça ou mão de obra na
 * ordem para poder pedir a aprovação do orçamento. Então a gaveta esvaziava
 * para montar uma conta que o cliente ainda podia recusar — e recusava sem
 * devolver nada, porque a devolução dependia de alguém lembrar.
 *
 * O sistema anterior tinha o desenho certo e a metade errada: lançar
 * reservava, e NENHUM caminho consumia a reserva. Cada OS paga corroía o
 * disponível para sempre. Aqui a reserva tem os dois lados.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 *   lançar          -> PROMETE   (reserved sobe, a prateleira não mente)
 *   cliente aprova  -> CONSOME   (a peça sai; o serviço foi autorizado)
 *   conclusão       -> CONSOME   (o que sobrou prometido saiu com a máquina)
 *   cliente recusa  -> SOLTA     (a peça volta para a gaveta sozinha)
 *
 * ============================================================================
 * MÓDULO FOLHA, DE PROPÓSITO
 * ============================================================================
 *
 * Importa razão, banco e erro — e nada do domínio da oficina. Os três que
 * precisam deste ciclo (a OS, as peças e o portal do cliente) já se importam
 * entre si de outras formas; pendurar o ciclo em qualquer um deles fecharia
 * um anel de importação. Em ESM o anel não estoura na hora: deixa uma
 * constante vazia do outro lado e o erro aparece longe da causa — foi o que
 * custou meia rodada na 54.
 */
import { getConnection } from '../../db/sqlite.js';
import {
  applyMovement,
  consumeReservation,
  releaseReservation,
  reserveStock,
} from './InventoryService.js';
import { isSerialized, pickUnitsFifo } from './ProductUnitService.js';

/** Onde a peça da OS está, do ponto de vista do estoque. */
export type EstadoDaPeca = 'prometida' | 'consumida' | 'solta' | 'sem_registro';

interface LinhaDePeca {
  id: string;
  product_id: string;
  quantity: number;
  returned_quantity: number | null;
  description: string;
}

/**
 * A referência que amarra a promessa à linha da OS — e dá a idempotência.
 *
 * ============================================================================
 * POR QUE ELA GANHOU UM CICLO
 * ============================================================================
 *
 * A referência era só `orderId:partId`, e isso tornava a promessa IRRENOVÁVEL.
 *
 * `reserveStock` tem um curto-circuito de idempotência: se já existe um
 * movimento `reserve` para aquela referência, ele **retorna em silêncio** — o
 * que está certo, e é o que impede dois cliques de reservarem duas vezes. Mas
 * como a referência não mudava, uma linha de peça que tivesse sido SOLTA (o
 * cliente recusou o orçamento) nunca mais podia ser reservada: o `reserve` da
 * primeira volta continuava lá.
 *
 * O efeito aparecia na oficina, no fluxo mais comum que ela tem — recusou,
 * negociou, reorçou: a peça seguia na conta da OS sem reserva nenhuma, o
 * balcão a vendia, e o cliente que apertasse "Aprovar" recebia 409 falando de
 * estoque, sobre o qual ele não tem ação. O rollback ainda desfazia o
 * `approved_at`, de modo que o botão ficava quebrado para sempre naquela OS.
 *
 * O ciclo resolve: cada volta de promessa tem a própria chave no razão.
 * `soltarPromessaParcial` já tinha resolvido essa mesma colisão do mesmo
 * jeito, pondo o acumulado devolvido na referência.
 *
 * O CICLO ZERO NÃO TEM SUFIXO. É o que mantém legível — e válido — todo o
 * razão que já existe no banco.
 */
function referenciaDaLinha(orderId: string, partId: string, ciclo = 0): string {
  const base = `${orderId}:${partId}`;
  return ciclo > 0 ? `${base}#${ciclo}` : base;
}

/** Todo movimento de razão daquela linha, de qualquer ciclo. */
function movimentosDaLinha(
  companyId: string,
  orderId: string,
  partId: string,
  productId: string,
): { ciclo: number; movement_type: string }[] {
  const base = referenciaDaLinha(orderId, partId);
  const linhas = getConnection()
    .prepare(
      `SELECT reference_id, movement_type FROM core_stock_movements
        WHERE company_id = ? AND reference_type = 'service_order'
          AND product_id = ?
          AND (reference_id = ? OR reference_id LIKE ?)`,
    )
    .all(companyId, productId, base, `${base}#%`) as unknown as {
    reference_id: string;
    movement_type: string;
  }[];

  return linhas.map((l) => ({
    ciclo: l.reference_id === base ? 0 : Number(l.reference_id.slice(base.length + 1)) || 0,
    movement_type: l.movement_type,
  }));
}

/** Em que volta de promessa esta linha está. Zero quando nunca foi prometida. */
export function cicloDaPeca(
  companyId: string,
  orderId: string,
  partId: string,
  productId: string,
): number {
  const movimentos = movimentosDaLinha(companyId, orderId, partId, productId);
  return movimentos.reduce((maior, m) => Math.max(maior, m.ciclo), 0);
}

/**
 * O estado sai do RAZÃO, não de uma coluna nova.
 *
 * Uma coluna `estado` na linha da peça seria uma segunda resposta para a mesma
 * pergunta, e as duas divergiriam no primeiro caminho que esquecesse de
 * atualizá-la. O razão já sabe: ele registra a promessa, a soltura e a baixa.
 *
 * A ORDEM DA LEITURA IMPORTA. Consumir escreve DUAS linhas — solta a promessa
 * e dá a saída —, então "tem soltura" não distingue recusa de consumo. A saída
 * é olhada primeiro porque ela é a que decide.
 */
export function estadoDaPeca(
  companyId: string,
  orderId: string,
  partId: string,
  productId: string,
): EstadoDaPeca {
  const movimentos = movimentosDaLinha(companyId, orderId, partId, productId);
  if (movimentos.length === 0) return 'sem_registro';

  /*
    SÓ O ÚLTIMO CICLO DECIDE.

    Agregar todos os movimentos da linha faria a soltura da PRIMEIRA volta
    condenar a promessa da segunda: uma peça reprometida apareceria como
    'solta' para sempre, o consumo cairia na baixa direta, e o conserto do
    reorçamento não teria efeito nenhum.
  */
  const ultimo = movimentos.reduce((maior, m) => Math.max(maior, m.ciclo), 0);
  const tipos = new Set(movimentos.filter((m) => m.ciclo === ultimo).map((m) => m.movement_type));

  if (tipos.has('out')) return 'consumida';
  if (tipos.has('release')) return 'solta';
  if (tipos.has('reserve')) return 'prometida';
  return 'sem_registro';
}

/** As linhas de peça da OS, com o que ainda está de pé em cada uma. */
function linhasDaOs(companyId: string, orderId: string): LinhaDePeca[] {
  return getConnection()
    .prepare(
      `SELECT id, product_id, quantity, returned_quantity, description
         FROM core_service_order_parts
        WHERE order_id = ? AND company_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(orderId, companyId) as unknown as LinhaDePeca[];
}

/** Quanto da linha ainda está de pé: o requisitado menos o que já voltou. */
function aindaDePe(linha: LinhaDePeca): number {
  return Number(linha.quantity) - Number(linha.returned_quantity ?? 0);
}

/**
 * Promete a peça ao conserto.
 *
 * O saldo FÍSICO não muda — e é a verdade: a peça está na prateleira, agora
 * com dono. O que cai é o disponível, e é isso que impede o balcão de vender
 * o que a bancada está contando para terminar um serviço.
 */
export function prometerPeca(input: {
  companyId: string;
  orderId: string;
  partId: string;
  productId: string;
  quantity: number;
  orderNumber: number;
  userId: string;
  /** A volta da promessa. Omitido é a primeira — o lançamento da peça. */
  ciclo?: number;
}): void {
  reserveStock({
    companyId: input.companyId,
    productId: input.productId,
    quantity: input.quantity,
    kind: 'WORKSHOP_PART_RESERVATION',
    referenceType: 'service_order',
    referenceId: referenciaDaLinha(input.orderId, input.partId, input.ciclo ?? 0),
    documentNumber: `OS #${input.orderNumber}`,
    userId: input.userId,
  });
}

/**
 * REPROMETE o que a OS ainda cobra e o estoque deixou de guardar.
 *
 * É o simétrico exato de `soltarPromessasDaOs`, e o caminho que faltava: quem
 * reabre o pedido de aprovação reabre a promessa das peças que continuam na
 * conta. Sem ele, a oficina reorçava e a peça ficava cobrada do cliente sem
 * estar reservada — o balcão vendia, e o cliente que aprovasse levava 409.
 *
 * A recusa por falta de estoque acontece AQUI, e isso é metade do conserto: ao
 * reorçar, quem está na frente da tela é a oficina, que pode comprar a peça,
 * trocá-la ou tirar a linha. Na aprovação, quem estava na frente era o cliente,
 * que não pode fazer nada a respeito de estoque — e ainda perdia o clique,
 * porque o rollback desfazia o `approved_at` junto.
 *
 * Devolve quantas linhas voltaram a ser prometidas, para a linha do tempo da
 * OS registrar o fato.
 */
export function reprometerPromessasDaOs(input: {
  companyId: string;
  orderId: string;
  orderNumber: number;
  userId: string | null;
}): number {
  let repromedidas = 0;
  for (const linha of linhasDaOs(input.companyId, input.orderId)) {
    // Só a peça SOLTA volta. A prometida já está guardada, e a consumida já
    // saiu da gaveta — reprometer qualquer uma das duas seria reservar duas
    // vezes a mesma mercadoria.
    if (estadoDaPeca(input.companyId, input.orderId, linha.id, linha.product_id) !== 'solta') {
      continue;
    }
    const quantidade = aindaDePe(linha);
    if (!(quantidade > 0)) continue;

    prometerPeca({
      companyId: input.companyId,
      orderId: input.orderId,
      partId: linha.id,
      productId: linha.product_id,
      quantity: quantidade,
      orderNumber: input.orderNumber,
      userId: input.userId ?? '',
      ciclo: cicloDaPeca(input.companyId, input.orderId, linha.id, linha.product_id) + 1,
    });
    repromedidas += 1;
  }
  return repromedidas;
}

/**
 * Solta UMA promessa parcial — a peça que voltou para a gaveta antes de ser
 * usada.
 *
 * A referência é a MESMA da devolução com estoque baixado
 * (`workshop_part_return`, com o acumulado no id), e não a da linha da OS. Duas
 * devoluções parciais precisam de duas chaves distintas; usar a da linha faria
 * a segunda colidir com a primeira na UNIQUE do razão — e a peça não voltaria.
 */
export function soltarPromessaParcial(input: {
  companyId: string;
  orderId: string;
  partId: string;
  productId: string;
  quantity: number;
  acumuladoDevolvido: number;
  orderNumber: number;
  userId: string;
}): void {
  releaseReservation({
    companyId: input.companyId,
    productId: input.productId,
    quantity: input.quantity,
    kind: 'WORKSHOP_PART_RESERVATION_RELEASE',
    referenceType: 'workshop_part_return',
    referenceId: `${input.partId}:${input.acumuladoDevolvido}`,
    documentNumber: `OS #${input.orderNumber}`,
    userId: input.userId,
  });
}

/**
 * Converte em BAIXA tudo que a OS ainda tinha prometido.
 *
 * Chamada onde o serviço passa a ser autorizado a acontecer: na aprovação do
 * orçamento pelo cliente e na conclusão técnica. Idempotente por construção —
 * linha já consumida não é olhada de novo, e o razão recusaria a repetição de
 * qualquer forma.
 *
 * Devolve quantas linhas saíram, porque quem chama registra isso na linha do
 * tempo da OS: "a peça saiu da gaveta" é um fato que o dono da moto tem o
 * direito de encontrar escrito.
 */
export function consumirPromessasDaOs(input: {
  companyId: string;
  orderId: string;
  orderNumber: number;
  userId: string | null;
  nota?: string;
}): number {
  let consumidas = 0;
  for (const linha of linhasDaOs(input.companyId, input.orderId)) {
    const estado = estadoDaPeca(input.companyId, input.orderId, linha.id, linha.product_id);
    if (estado === 'consumida') continue;

    const quantidade = aindaDePe(linha);
    // Devolvida por inteiro antes de sair: a promessa já caiu na devolução, e
    // consumir zero criaria uma linha de razão que não move nada.
    if (!(quantidade > 1e-9)) continue;

    /*
      A PEÇA QUE AINDA ESTÁ NA CONTA TEM DE SAIR DA GAVETA — com promessa de pé
      ou sem ela.

      O caso que faltava: o cliente RECUSA o orçamento (a promessa cai), a
      oficina liga, o cliente muda de ideia, e a OS segue. A linha da peça
      continua na conta — o cliente vai pagar por ela — e o estado dela virou
      'solta'. Olhar só o 'prometida' deixava essa peça sair da loja cobrada e
      NUNCA baixada: mercadoria entregue que o estoque continua contando na
      prateleira, para sempre, sem nada apontando o motivo.

      Consumir a promessa e dar baixa direta são caminhos diferentes porque o
      ponto de partida é diferente: no primeiro há reserva a soltar, no segundo
      não há. O resultado no saldo é o mesmo, e a chave do razão distingue os
      dois pelo `movement_type`.
    */
    const ciclo = cicloDaPeca(input.companyId, input.orderId, linha.id, linha.product_id);
    /*
      O CUSTO É FOTOGRAFADO NA BAIXA (GAP-PRD-101).

      A saída da peça pela OS nascia com `unit_cost_cents` nulo, e o CMV da
      oficina ignorava toda peça de conserto. O retrato é o custo do cadastro
      NO MOMENTO em que a peça deixa a prateleira — a mesma régua do balcão,
      que fotografa na venda —, e mora no RAZÃO, junto da saída: é dele que a
      venda da OS lê o custo (`custoDaPecaConsumida`), e a próxima nota de
      entrada que mudar o cadastro não reescreve a margem de um conserto já
      feito. Cadastro sem custo grava zero, que é o fato.
    */
    const custo = custoDoCadastro(input.companyId, linha.product_id);

    if (estado === 'prometida') {
      consumeReservation({
        companyId: input.companyId,
        productId: linha.product_id,
        quantity: quantidade,
        referenceType: 'service_order',
        referenceId: referenciaDaLinha(input.orderId, linha.id, ciclo),
        kind: 'WORKSHOP_PART_CONSUMPTION',
        releaseKind: 'WORKSHOP_PART_CONSUMPTION',
        documentNumber: `OS #${input.orderNumber}`,
        userId: input.userId,
        note: input.nota ?? `OS #${input.orderNumber}`,
        unitCostCents: custo,
      });
    } else {
      const unidades = isSerialized(input.companyId, linha.product_id)
        ? pickUnitsFifo(input.companyId, linha.product_id, quantidade)
        : undefined;
      applyMovement({
        companyId: input.companyId,
        productId: linha.product_id,
        movementType: 'out',
        quantity: quantidade,
        unitIds: unidades,
        referenceType: 'service_order',
        referenceId: referenciaDaLinha(input.orderId, linha.id, ciclo),
        kind: 'WORKSHOP_PART_CONSUMPTION',
        documentNumber: `OS #${input.orderNumber}`,
        userId: input.userId,
        note: input.nota ?? `OS #${input.orderNumber}`,
        unitCostCents: custo,
      });
    }
    consumidas += 1;
  }
  return consumidas;
}

/** O custo do cadastro agora, em centavo inteiro — zero quando não há. */
function custoDoCadastro(companyId: string, productId: string): number {
  const produto = getConnection()
    .prepare('SELECT cost_cents FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { cost_cents: number | null } | undefined;
  return Math.max(0, Math.trunc(Number(produto?.cost_cents ?? 0)) || 0);
}

/**
 * O custo unitário com que a peça desta linha SAIU da gaveta (GAP-PRD-101).
 *
 * Lido da saída no razão — a linha só sai uma vez (a baixa não se repete, e
 * o que volta entra como devolução com referência própria). Nulo quando a
 * peça ainda não saiu, ou saiu antes de a OS fotografar custo: "sem retrato"
 * é um estado honesto, e o CMV o conta à parte em vez de somar zero.
 */
export function custoDaPecaConsumida(
  companyId: string,
  orderId: string,
  partId: string,
  productId: string,
): number | null {
  const base = referenciaDaLinha(orderId, partId);
  const saida = getConnection()
    .prepare(
      `SELECT unit_cost_cents FROM core_stock_movements
        WHERE company_id = ? AND reference_type = 'service_order' AND product_id = ?
          AND movement_type = 'out'
          AND (reference_id = ? OR reference_id LIKE ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(companyId, productId, base, `${base}#%`) as { unit_cost_cents: number | null } | undefined;
  if (!saida || saida.unit_cost_cents === null || saida.unit_cost_cents === undefined) return null;
  return Number(saida.unit_cost_cents);
}

/**
 * Devolve à gaveta tudo que a OS tinha prometido.
 *
 * É o caminho do orçamento RECUSADO — o buraco que esta rodada fecha. O
 * físico nunca foi tocado, então não há entrada: o que houve foi uma promessa
 * que caiu, e é assim que ela aparece no histórico.
 */
export function soltarPromessasDaOs(input: {
  companyId: string;
  orderId: string;
  orderNumber: number;
  userId: string | null;
}): number {
  let soltas = 0;
  for (const linha of linhasDaOs(input.companyId, input.orderId)) {
    if (estadoDaPeca(input.companyId, input.orderId, linha.id, linha.product_id) !== 'prometida') {
      continue;
    }
    const quantidade = aindaDePe(linha);
    if (!(quantidade > 0)) continue;

    releaseReservation({
      companyId: input.companyId,
      productId: linha.product_id,
      quantity: quantidade,
      kind: 'WORKSHOP_PART_RESERVATION_RELEASE',
      referenceType: 'service_order',
      referenceId: referenciaDaLinha(
        input.orderId,
        linha.id,
        cicloDaPeca(input.companyId, input.orderId, linha.id, linha.product_id),
      ),
      documentNumber: `OS #${input.orderNumber}`,
      userId: input.userId,
    });
    soltas += 1;
  }
  return soltas;
}

/**
 * O QUE A OFICINA AINDA SEGURA DA GAVETA — em SQL, e não em função.
 *
 * A conciliação de estoque precisa desta pergunta DENTRO de uma consulta maior
 * (ela cruza `core_stock.reserved` com todas as origens legítimas de reserva
 * num LEFT JOIN só). Uma função que devolvesse linhas obrigaria a conciliação
 * a fazer a mesma pergunta do seu jeito — e "a mesma pergunta respondida em
 * dois lugares" é o defeito que este repositório mais encontra.
 *
 * Então a definição de "promessa aberta" mora AQUI, junto do ciclo que a
 * escreve, e quem precisa dela interpola o fragmento. Recebe UM parâmetro:
 * a empresa.
 *
 * A promessa está aberta quando existe a linha de reserva no razão e NÃO
 * existe nem baixa nem soltura para a mesma referência.
 */
/*
  A CHAVE CASA O CICLO ATUAL, E NÃO A LINHA INTEIRA.

  Era `m.reference_id = sp.order_id || ':' || sp.id` dos dois lados. Com a
  promessa ganhando ciclo (`...#2`, `...#3`), esse casamento passaria a ver só
  a primeira volta: uma peça reprometida apareceria como promessa FECHADA — e a
  conciliação acusaria `reserved` sem origem, todo dia, num alarme falso que
  ensina a ignorar o alarme.

  A regra é a mesma de antes, aplicada ao ciclo corrente: existe reserva na
  volta mais recente, e não existe baixa nem soltura NAQUELA volta.
*/
export const SQL_PROMESSAS_ABERTAS = `
  SELECT sp.product_id AS product_id,
         SUM(sp.quantity - COALESCE(sp.returned_quantity, 0)) AS quantidade
    FROM core_service_order_parts sp
    JOIN core_stock_movements m
      ON m.company_id = sp.company_id
     AND m.reference_type = 'service_order'
     AND m.product_id = sp.product_id
     AND m.movement_type = 'reserve'
     AND (m.reference_id = sp.order_id || ':' || sp.id
          OR m.reference_id LIKE sp.order_id || ':' || sp.id || '#%')
     AND m.reference_id = (
           SELECT ultimo.reference_id FROM core_stock_movements ultimo
            WHERE ultimo.company_id = sp.company_id
              AND ultimo.reference_type = 'service_order'
              AND ultimo.product_id = sp.product_id
              AND (ultimo.reference_id = sp.order_id || ':' || sp.id
                   OR ultimo.reference_id LIKE sp.order_id || ':' || sp.id || '#%')
            ORDER BY length(ultimo.reference_id) DESC, ultimo.reference_id DESC
            LIMIT 1
         )
   WHERE sp.company_id = ?
     AND NOT EXISTS (
           SELECT 1 FROM core_stock_movements baixa
            WHERE baixa.company_id = sp.company_id
              AND baixa.reference_type = 'service_order'
              AND baixa.reference_id = m.reference_id
              AND baixa.product_id = sp.product_id
              AND baixa.movement_type IN ('out', 'release')
         )
   GROUP BY sp.product_id`;
