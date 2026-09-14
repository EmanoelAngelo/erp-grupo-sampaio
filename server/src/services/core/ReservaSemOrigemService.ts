/**
 * ============================================================================
 * A RESERVA QUE SEGURA MERCADORIA SEM DONO — ver, entender e soltar (GAP-PRD-087)
 * ============================================================================
 *
 * `inventoryReconciliation` sempre soube dizer "este produto tem 1 reservado e
 * 0 com origem aberta" — e ninguém podia perguntar: o serviço não tinha rota
 * nem tela. O banco da loja tem exatamente esse caso (uma unidade da Conceito
 * presa por uma reserva da loja online cujo pedido não existe mais), e a única
 * saída era abrir o banco.
 *
 * Este módulo é o que faltava entre o diagnóstico e a mão do gestor:
 *
 *   1. O PORQUÊ, e não só o número. Para cada produto com reserva sem origem,
 *      o razão diz quais documentos RESERVARAM e não SOLTARAM (referência,
 *      número do papel, desde quando) — e a situação de cada um hoje: o pedido
 *      ainda existe? está aberto? A reserva da Conceito aparece como "pedido
 *      da loja online ... — não existe mais", que é a pista que leva à causa.
 *
 *   2. O GESTO, com trava. Soltar reserva é decisão de gerência, com motivo
 *      obrigatório, e SÓ da parte sem origem: a parte que pertence a um pedido
 *      ou pré-venda aberta não é solta aqui — ela é solta cancelando o
 *      documento dela, senão o documento continuaria prometendo o que a
 *      prateleira já vendeu para outro.
 *
 * O conserto continua NÃO sendo automático (a regra de `InventoryReconciliation`):
 * reserva é dado operacional, e soltar sozinho esconderia a causa. Aqui quem
 * solta é gente, com nome, motivo e rastro no razão (ORPHAN_RESERVATION_RELEASE).
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { inventoryReconciliation, type InventoryIssue } from './InventoryReconciliation.js';
import { releaseReservation } from './InventoryService.js';

/** O que se sabe hoje do documento que reservou. */
export type SituacaoDaOrigem = 'aberta' | 'encerrada' | 'inexistente' | 'nao_verificada';

export interface ReferenciaDaReserva {
  referenceType: string;
  referenceId: string;
  /** O papel legível ("Pré-venda #12"), quando o reservador o gravou. */
  documentNumber: string | null;
  /** O que esta referência ainda segura: reservado − soltado, pelo razão. */
  quantidade: number;
  desde: string;
  situacao: SituacaoDaOrigem;
  /** A frase que a tela mostra ao lado da referência. */
  explicacao: string;
}

export interface ProblemaDeReserva extends InventoryIssue {
  /** Quanto está preso SEM origem — o máximo que o gesto pode soltar. */
  semOrigem: number;
  /** As referências do razão que reservaram e não soltaram. */
  referencias: ReferenciaDaReserva[];
}

export interface ConferenciaDeReservas {
  healthy: boolean;
  critical: number;
  warnings: number;
  issues: ProblemaDeReserva[];
}

/** O nome que a tela dá a cada reservador. */
const ROTULO_DA_ORIGEM: Record<string, string> = {
  ecommerce_order: 'pedido da loja online',
  pre_venda: 'pré-venda',
  pre_venda_edicao: 'pré-venda (edição)',
  rental_contract: 'contrato de locação',
  rental_return: 'devolução de locação',
  rental_cancel: 'cancelamento de locação',
  service_order: 'ordem de serviço',
};

/** O id do documento, sem o sufixo de linha que alguns reservadores anexam. */
function idDoDocumento(referenceId: string): string {
  return referenceId.split(':')[0].split('#')[0];
}

function situacaoDe(
  companyId: string,
  referenceType: string,
  referenceId: string,
): SituacaoDaOrigem {
  const db = getConnection();
  const id = idDoDocumento(referenceId);
  switch (referenceType) {
    case 'ecommerce_order': {
      const pedido = db
        .prepare('SELECT status FROM core_orders WHERE id = ? AND company_id = ?')
        .get(id, companyId) as { status: string } | undefined;
      if (!pedido) return 'inexistente';
      return pedido.status === 'aguardando_pagamento' ? 'aberta' : 'encerrada';
    }
    case 'pre_venda':
    case 'pre_venda_edicao': {
      const doc = db
        .prepare('SELECT kind, status FROM core_quotes WHERE id = ? AND company_id = ?')
        .get(id, companyId) as { kind: string; status: string } | undefined;
      if (!doc) return 'inexistente';
      return doc.kind === 'pre_venda' && doc.status === 'aberto' ? 'aberta' : 'encerrada';
    }
    case 'rental_contract':
    case 'rental_return':
    case 'rental_cancel': {
      const contrato = db
        .prepare('SELECT status FROM core_rental_contracts WHERE id = ? AND company_id = ?')
        .get(id, companyId) as { status: string } | undefined;
      if (!contrato) return 'inexistente';
      return contrato.status === 'aberto' ? 'aberta' : 'encerrada';
    }
    case 'service_order': {
      const os = db
        .prepare('SELECT id FROM core_service_orders WHERE id = ? AND company_id = ?')
        .get(id, companyId);
      // A OS existe; se a PEÇA ainda está prometida é a conta de
      // `SQL_PROMESSAS_ABERTAS`, que já entrou no "com origem". Aqui só se
      // diz se o papel existe.
      return os ? 'nao_verificada' : 'inexistente';
    }
    default:
      return 'nao_verificada';
  }
}

function explicar(ref: Omit<ReferenciaDaReserva, 'explicacao'>): string {
  const nome = ROTULO_DA_ORIGEM[ref.referenceType] ?? `documento "${ref.referenceType}"`;
  const papel = ref.documentNumber ? `${ref.documentNumber} (${nome})` : `${nome} ${idDoDocumento(ref.referenceId).slice(0, 8)}`;
  switch (ref.situacao) {
    case 'inexistente':
      return `${papel} reservou ${ref.quantidade} e não existe mais — ninguém soltou a reserva quando ele sumiu.`;
    case 'encerrada':
      return `${papel} reservou ${ref.quantidade} e já foi encerrado sem soltar a reserva.`;
    case 'aberta':
      return `${papel} continua aberto e segura ${ref.quantidade} legitimamente.`;
    default:
      return `${papel} reservou ${ref.quantidade}; a situação dele não é conferida automaticamente.`;
  }
}

/** As referências do razão que reservaram este produto e não soltaram. */
function referenciasAbertasNoRazao(companyId: string, productId: string): ReferenciaDaReserva[] {
  const linhas = getConnection()
    .prepare(
      `SELECT reference_type, reference_id, MAX(document_number) AS document_number,
              SUM(reserved_delta) AS liquido, MIN(created_at) AS desde
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ?
          AND movement_type IN ('reserve', 'release')
        GROUP BY reference_type, reference_id
       HAVING SUM(reserved_delta) > 0
        ORDER BY MIN(created_at)`,
    )
    .all(companyId, productId) as unknown as {
    reference_type: string;
    reference_id: string;
    document_number: string | null;
    liquido: number;
    desde: string;
  }[];
  /*
    O QUE O GESTOR JÁ SOLTOU NÃO VOLTA A SER ACUSADO.

    A liberação sem origem tem referência própria ('reserva_sem_origem'), então
    a referência antiga — o pedido que sumiu — continua com saldo positivo no
    razão para sempre. Sem este desconto, a próxima reserva presa do mesmo
    produto listaria de novo o pedido já resolvido. O que foi solto abate as
    referências que NÃO estão abertas, da mais antiga para a mais nova.
  */
  const jaSolto = getConnection()
    .prepare(
      `SELECT COALESCE(-SUM(reserved_delta), 0) AS solto
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ? AND reference_type = 'reserva_sem_origem'`,
    )
    .get(companyId, productId) as { solto: number };
  let aAbater = Math.max(0, Number(jaSolto.solto));

  const resultado: ReferenciaDaReserva[] = [];
  for (const l of linhas) {
    const situacao = situacaoDe(companyId, l.reference_type, l.reference_id);
    let quantidade = Number(l.liquido);
    if (situacao !== 'aberta' && aAbater > 0) {
      const abatido = Math.min(aAbater, quantidade);
      quantidade -= abatido;
      aAbater -= abatido;
    }
    if (quantidade <= 1e-9) continue;
    const base = {
      referenceType: l.reference_type,
      referenceId: l.reference_id,
      documentNumber: l.document_number,
      quantidade,
      desde: l.desde,
      situacao,
    };
    resultado.push({ ...base, explicacao: explicar(base) });
  }
  return resultado;
}

/**
 * A conferência com o porquê de cada reserva presa — o que a tela mostra.
 *
 * Os números e as severidades são os de `inventoryReconciliation`, sem
 * recálculo: esta função só acrescenta as referências do razão e o "quanto está
 * sem origem" que o gesto de liberar respeita.
 */
export function conferirReservas(companyId: string): ConferenciaDeReservas {
  ensureCoreSchema();
  const base = inventoryReconciliation(companyId);
  return {
    ...base,
    issues: base.issues.map((issue) => ({
      ...issue,
      semOrigem:
        issue.check === 'STOCK_RESERVATION_WITHOUT_SOURCE'
          ? Math.max(0, issue.reserved - issue.withSource)
          : 0,
      referencias: referenciasAbertasNoRazao(companyId, issue.productId),
    })),
  };
}

export interface LiberacaoDeReserva {
  productId: string;
  productName: string;
  liberado: number;
  reservadoAntes: number;
  reservadoDepois: number;
  semOrigemAntes: number;
}

/**
 * Solta a parte da reserva que NÃO tem origem aberta.
 *
 * `quantidade` omitida solta toda a parte sem origem; informada, não pode
 * passar dela. Dentro de UMA transação a conferência é refeita — entre a tela
 * mostrar "1 sem origem" e o clique, um pedido pode ter nascido e passado a
 * sustentar aquela reserva.
 */
export function liberarReservaSemOrigem(input: {
  companyId: string;
  productId: string;
  quantidade?: number | null;
  motivo: string;
  userId: string;
}): LiberacaoDeReserva {
  ensureCoreSchema();
  const motivo = String(input.motivo ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_RESERVATION_RELEASE_REASON_REQUIRED',
      'Informe o motivo — por que esta reserva está sendo solta sem o documento que a criou. '
        + 'É ele que explica o movimento no histórico.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const produto = db
      .prepare('SELECT id, name FROM core_products WHERE id = ? AND company_id = ?')
      .get(input.productId, input.companyId) as { id: string; name: string } | undefined;
    if (!produto) {
      throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
    }

    const problema = inventoryReconciliation(input.companyId).issues.find(
      (i) => i.productId === input.productId && i.check === 'STOCK_RESERVATION_WITHOUT_SOURCE',
    );
    const semOrigem = problema ? Math.max(0, problema.reserved - problema.withSource) : 0;
    if (!problema || semOrigem <= 0) {
      throw new ApiError(
        'CORE_RESERVATION_HAS_SOURCE',
        `Toda a reserva de "${produto.name}" tem origem aberta (pedido, pré-venda, locação ou OS). `
          + 'Para soltá-la, cancele o documento que a segura — soltar por aqui deixaria o '
          + 'documento prometendo mercadoria que a prateleira já liberou.',
        409,
      );
    }

    const pedida =
      input.quantidade === undefined || input.quantidade === null
        ? semOrigem
        : Number(input.quantidade);
    if (!Number.isFinite(pedida) || pedida <= 0) {
      throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade inválida.', 400);
    }
    if (pedida > semOrigem + 1e-9) {
      throw new ApiError(
        'CORE_RESERVATION_RELEASE_EXCEEDS',
        `Só ${semOrigem} de "${produto.name}" está(ão) reservado(s) sem origem. `
          + `O resto (${problema.withSource}) pertence a documentos abertos e sai cancelando-os.`,
        409,
        { semOrigem, pedida },
      );
    }

    releaseReservation({
      companyId: input.companyId,
      productId: input.productId,
      quantity: pedida,
      kind: 'ORPHAN_RESERVATION_RELEASE',
      // Referência PRÓPRIA por gesto: o razão lê "esta linha soltou aquilo",
      // e duas liberações não colidem na chave de idempotência.
      referenceType: 'reserva_sem_origem',
      referenceId: randomUUID(),
      documentNumber: 'Conferência de reservas',
      userId: input.userId,
      reason: motivo,
    });

    return {
      productId: produto.id,
      productName: produto.name,
      liberado: pedida,
      reservadoAntes: problema.reserved,
      reservadoDepois: Math.max(0, problema.reserved - pedida),
      semOrigemAntes: semOrigem,
    };
  });
}
