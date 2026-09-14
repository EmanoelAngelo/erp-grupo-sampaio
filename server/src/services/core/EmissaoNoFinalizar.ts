/**
 * ============================================================================
 * A NFC-e NO FINALIZAR — DECISÃO DO DONO, COM MECANISMO (GAP-PRD-163)
 * ============================================================================
 *
 * A NFC-e da venda é emitida por um clique no painel fiscal do PDV, depois do
 * Finalizar. O painel é honesto — mostra o que falta quando não dá —, mas o
 * clique pode ser esquecido, e a venda sai sem nota. Emitir sozinho resolve o
 * esquecimento e troca por outro risco: a nota nasce sem ninguém olhar para
 * ela. É escolha do dono, e até aqui não havia como escolher.
 *
 * ## Os dois modos
 *
 *   - MANUAL (padrão): o comportamento de sempre. O Finalizar não emite; o
 *     painel oferece "emitir NFC-e" quando a venda está pronta. É o padrão
 *     porque é o que a loja opera hoje: ligar a emissão automática muda o
 *     balcão e produz documento fiscal, e isso é decisão de quem responde
 *     pela empresa, não efeito colateral de uma atualização.
 *   - AUTOMATICA: ao Finalizar, se a prontidão DESTA VENDA está verde (a
 *     mesma régua do botão — `emissionReadinessForSale`), a emissão dispara
 *     sozinha, em segundo plano, depois da resposta da venda. Venda que não
 *     está pronta não dispara nada, e a resposta diz por quê; o painel
 *     continua oferecendo o botão para quando a pendência sumir.
 *
 * ## O que a emissão automática NUNCA faz
 *
 *   - atrasar ou derrubar a venda: a venda já está gravada quando a emissão
 *     começa, e qualquer falha dela vira trilha (`fiscal.nfce_auto_emit_failed`)
 *     e o estado da nota no painel — nunca erro no Finalizar;
 *   - emitir duas vezes: `emitNfceForSale` é idempotente por venda, então o
 *     clique manual que cruze com a automática recebe a mesma nota;
 *   - usar o emissor de teste em produção: a costura de teste é recusada ao
 *     ser armada num servidor de produção (NODE_ENV ou DEVORA_API_ENV) e é
 *     ignorada se já estiver armada quando o processo vira produção.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { emissionReadinessForSale, emitNfceForSale } from './FiscalPipelineService.js';
import { servidorEmProducao } from './SefazAdapter.js';

export type ModoDaNfceNoFinalizar = 'MANUAL' | 'AUTOMATICA';

export const MODOS_DA_NFCE_NO_FINALIZAR: readonly ModoDaNfceNoFinalizar[] = ['MANUAL', 'AUTOMATICA'];

export interface PoliticaDeEmissao {
  modo: ModoDaNfceNoFinalizar;
  /** Nulo enquanto ninguém escolheu: vale o padrão, MANUAL. */
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

/** O que o Finalizar fez com a NFC-e — vai na resposta da venda. */
export interface DisparoDaNfce {
  modo: ModoDaNfceNoFinalizar;
  /** A emissão foi disparada agora, em segundo plano. */
  disparada: boolean;
  /** Por que não disparou, no modo automático. Vazio no manual. */
  motivos: string[];
}

export function lerPoliticaDeEmissao(companyId: string): PoliticaDeEmissao {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT nfce_on_finalize, updated_by, updated_at FROM core_fiscal_emission_policies WHERE company_id = ?',
    )
    .get(companyId) as
    | { nfce_on_finalize: string; updated_by: string | null; updated_at: string }
    | undefined;
  return {
    modo: row?.nfce_on_finalize === 'AUTOMATICA' ? 'AUTOMATICA' : 'MANUAL',
    atualizadoEm: row?.updated_at ?? null,
    atualizadoPor: row?.updated_by ?? null,
  };
}

/** Grava a escolha do dono, com trilha. Só os dois valores da lista valem. */
export function gravarPoliticaDeEmissao(input: {
  companyId: string;
  modo: unknown;
  userId?: string | null;
}): PoliticaDeEmissao {
  ensureCoreSchema();
  const modo = String(input.modo ?? '') as ModoDaNfceNoFinalizar;
  if (!MODOS_DA_NFCE_NO_FINALIZAR.includes(modo)) {
    throw new ApiError(
      'CORE_FISCAL_EMISSION_POLICY_INVALID',
      'Informe o modo da NFC-e no Finalizar: MANUAL ou AUTOMATICA.',
      400,
      { aceitos: MODOS_DA_NFCE_NO_FINALIZAR },
    );
  }
  const antes = lerPoliticaDeEmissao(input.companyId);
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_emission_policies (company_id, nfce_on_finalize, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         nfce_on_finalize = excluded.nfce_on_finalize,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(input.companyId, modo, input.userId ?? null, new Date().toISOString());
  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.emission_policy_updated',
    entityType: 'fiscal_config',
    entityId: input.companyId,
    detail: { antes: antes.modo, depois: modo },
  });
  return lerPoliticaDeEmissao(input.companyId);
}

// ------------------------------------------------------ a costura de teste

type EmissorDaVenda = (input: {
  companyId: string;
  saleId: string;
  userId: string | null;
}) => Promise<unknown>;

let emissorDeTeste: EmissorDaVenda | null = null;

/**
 * Troca o emissor por um dublê — SÓ fora de produção.
 *
 * Existe porque a emissão real abre o A1 e fala com a SEFAZ, e a suíte não sai
 * para a rede. Em produção a chamada é recusada com 409, e um dublê armado
 * antes de o processo virar produção é ignorado (`emissorEmUso`).
 */
export function definirEmissorDeTeste(emissor: EmissorDaVenda | null): void {
  if (emissor && servidorEmProducao()) {
    throw new ApiError(
      'CORE_TEST_SEAM_IN_PRODUCTION',
      'O emissor de teste não existe em produção: a NFC-e automática só sai pela emissão real.',
      409,
    );
  }
  emissorDeTeste = emissor;
}

/** Qual emissor o Finalizar usaria agora. Em produção, sempre o real. */
export function emissorEmUso(): 'TESTE' | 'REAL' {
  return emissorDeTeste && !servidorEmProducao() ? 'TESTE' : 'REAL';
}

const emissorReal: EmissorDaVenda = (input) =>
  emitNfceForSale({
    companyId: input.companyId,
    saleId: input.saleId,
    userId: input.userId ?? undefined,
  });

// ------------------------------------------------------------- o Finalizar

/**
 * O que o Finalizar faz com a NFC-e da venda recém-gravada.
 *
 * Devolve o `disparo` (vai na resposta da venda, e o painel do PDV o lê) e a
 * promessa da emissão — que já está correndo e já trata os próprios erros; a
 * rota não a espera. A emissão só começa no próximo giro do laço de eventos,
 * DEPOIS da resposta: assinar e validar o XML não entram no tempo do balcão.
 */
export function emitirNoFinalizar(input: {
  companyId: string;
  saleId: string;
  userId: string | null;
}): { disparo: DisparoDaNfce; emissao: Promise<void> } {
  const politica = lerPoliticaDeEmissao(input.companyId);
  if (politica.modo !== 'AUTOMATICA') {
    return {
      disparo: { modo: politica.modo, disparada: false, motivos: [] },
      emissao: Promise.resolve(),
    };
  }

  const prontidao = emissionReadinessForSale(input.companyId, input.saleId);
  if (!prontidao.canEmit) {
    return {
      disparo: { modo: 'AUTOMATICA', disparada: false, motivos: prontidao.reasons ?? [] },
      emissao: Promise.resolve(),
    };
  }

  const emitir = emissorEmUso() === 'TESTE' && emissorDeTeste ? emissorDeTeste : emissorReal;
  const emissao = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => emitir(input))
    .then((resultado) => {
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'fiscal.nfce_auto_emit',
        entityType: 'sale',
        entityId: input.saleId,
        detail: { status: (resultado as { status?: string } | null)?.status ?? null },
      });
    })
    .catch((err: unknown) => {
      recordAudit({
        companyId: input.companyId,
        userId: input.userId,
        action: 'fiscal.nfce_auto_emit_failed',
        entityType: 'sale',
        entityId: input.saleId,
        detail: {
          code: err instanceof ApiError ? err.code : 'ERRO',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });

  return { disparo: { modo: 'AUTOMATICA', disparada: true, motivos: [] }, emissao };
}
