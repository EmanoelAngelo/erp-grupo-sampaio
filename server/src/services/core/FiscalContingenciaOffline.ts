/**
 * A CONTINGÊNCIA OFF-LINE DA NFC-e — GAP-PRD-098.
 *
 * ## O que a auditoria mediu
 *
 * A contingência era "fundação": o documento que esgotava cinco tentativas
 * (e só se houvesse emissões) mudava de estado para CONTINGENCY com o mesmo
 * XML `tpEmis=1` — um cupom sem autorização e sem os dizeres de contingência,
 * que não vale como NFC-e off-line —, e só saía dali por uma rota sem botão.
 *
 * ## O desenho, na ordem em que a loja vive
 *
 *  1. A MODALIDADE É DECISÃO DO CONTADOR (registrada pelo dono, nesta tela):
 *     'AGUARDAR' (padrão seguro) — com a SEFAZ fora, a nota espera na fila e
 *     o trabalhador a transmite quando o serviço volta; ou 'OFFLINE_NFCE' —
 *     enquanto durar o período, a NFC-e é MONTADA em contingência off-line
 *     desde o início: `tpEmis=9` na chave e no XML, `dhCont` e `xJust` no
 *     `ide`, QR Code da versão off-line (com o `digVal` da assinatura), e o
 *     DANFCE sai com "EMITIDA EM CONTINGÊNCIA" e "Pendente de autorização". O
 *     PRAZO de transmissão é o que o contador confirmar para a UF (o sistema
 *     não chuta: sem prazo, a modalidade não liga).
 *  2. O PERÍODO abre sozinho na primeira indisponibilidade confirmada da
 *     SEFAZ na autorização de uma NFC-e (serviço paralisado, ou rede fora com
 *     a consulta também sem resposta) — ou pelo gerente, com justificativa. A
 *     nota que DISPAROU o período continua a mesma (tpEmis 1, na fila): trocar
 *     o tipo de emissão mudaria a chave de uma nota que a SEFAZ pode ter
 *     recebido, e duas notas para a mesma venda é o que a contingência não
 *     pode causar.
 *  3. O PERÍODO FECHA SOZINHO quando a sondagem do trabalhador da fila ouve
 *     o `107` (ou quando qualquer nota da operação é autorizada) — ou pelo
 *     gerente. Aí as notas off-line são transmitidas pelo trabalhador, e cada
 *     uma, autorizada, encerra a própria contingência (o registro fica).
 *
 * EPEC (`tpEmis=4`) é contingência da NF-e (e da NFC-e só em SP); as seis
 * operações do grupo são do RS, onde a NFC-e usa a off-line. Por isso as
 * modalidades oferecidas são as duas acima.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { momentoFiscal } from './MomentoFiscal.js';
import type { ReadinessItem } from './FiscalConfigService.js';

// ------------------------------------------------------------------ a política

export type ModoDeContingencia = 'AGUARDAR' | 'OFFLINE_NFCE';

export const MODOS_DE_CONTINGENCIA: readonly ModoDeContingencia[] = ['AGUARDAR', 'OFFLINE_NFCE'];

/** Teto do prazo que a tela aceita: uma semana. O prazo real vem do contador. */
export const PRAZO_MAXIMO_HORAS = 168;

export interface PoliticaDeContingencia {
  modo: ModoDeContingencia;
  /** O prazo de transmissão da nota off-line, em horas, confirmado pelo contador. */
  prazoHoras: number | null;
  observacao: string | null;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

export function lerPoliticaDeContingencia(companyId: string): PoliticaDeContingencia {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT mode, deadline_hours, note, updated_by, updated_at
         FROM core_fiscal_contingency_policies WHERE company_id = ?`,
    )
    .get(companyId) as
    | { mode: string; deadline_hours: number | null; note: string | null; updated_by: string | null; updated_at: string }
    | undefined;
  const modo = row?.mode === 'OFFLINE_NFCE' ? 'OFFLINE_NFCE' : 'AGUARDAR';
  return {
    modo,
    prazoHoras: modo === 'OFFLINE_NFCE' && row?.deadline_hours ? Number(row.deadline_hours) : null,
    observacao: row?.note ?? null,
    atualizadoEm: row?.updated_at ?? null,
    atualizadoPor: row?.updated_by ?? null,
  };
}

/**
 * Grava a decisão (do contador, registrada pelo dono), com trilha.
 *
 * Off-line sem prazo não liga: o prazo de transmissão da UF é justamente o
 * que o sistema não pode chutar. Desligar com um período aberto o encerra —
 * a próxima venda volta a sair normal, e as notas off-line já emitidas seguem
 * para a fila.
 */
export function gravarPoliticaDeContingencia(input: {
  companyId: string;
  modo: unknown;
  prazoHoras?: unknown;
  observacao?: unknown;
  userId?: string | null;
}): PoliticaDeContingencia {
  ensureCoreSchema();
  if (!MODOS_DE_CONTINGENCIA.includes(input.modo as ModoDeContingencia)) {
    throw new ApiError(
      'CORE_CONTINGENCY_POLICY_INVALID',
      'Modalidade inválida: escolha AGUARDAR (a nota espera a SEFAZ voltar) ou OFFLINE_NFCE '
        + '(NFC-e em contingência off-line, tpEmis 9).',
      400,
    );
  }
  const modo = input.modo as ModoDeContingencia;
  let prazo: number | null = null;
  if (modo === 'OFFLINE_NFCE') {
    const n = Number(input.prazoHoras);
    if (!Number.isInteger(n) || n < 1 || n > PRAZO_MAXIMO_HORAS) {
      throw new ApiError(
        'CORE_CONTINGENCY_DEADLINE_REQUIRED',
        `Informe o prazo de transmissão da NFC-e off-line, em horas inteiras (1 a ${PRAZO_MAXIMO_HORAS}), `
          + 'como o contador confirmou para a UF. Sem ele a modalidade não liga.',
        400,
      );
    }
    prazo = n;
  }
  const observacao =
    typeof input.observacao === 'string' && input.observacao.trim()
      ? input.observacao.trim().slice(0, 500)
      : null;

  const antes = lerPoliticaDeContingencia(input.companyId);
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_contingency_policies (company_id, mode, deadline_hours, note, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         mode = excluded.mode,
         deadline_hours = excluded.deadline_hours,
         note = excluded.note,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(input.companyId, modo, prazo, observacao, input.userId ?? null, agora);

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.contingency_policy_updated',
    entityType: 'fiscal_config',
    entityId: input.companyId,
    detail: {
      antes: { modo: antes.modo, prazoHoras: antes.prazoHoras },
      depois: { modo, prazoHoras: prazo },
    },
  });

  if (modo === 'AGUARDAR' && periodoAtivo(input.companyId)) {
    encerrarPeriodo({
      companyId: input.companyId,
      origem: 'MANUAL',
      userId: input.userId ?? null,
      motivo: 'Modalidade off-line desligada.',
    });
  }

  return lerPoliticaDeContingencia(input.companyId);
}

// ------------------------------------------------------------------ o período

export type MotivoDoPeriodo = 'SEFAZ_UNAVAILABLE' | 'NETWORK_UNAVAILABLE' | 'TRANSPORT_ERROR';

const MOTIVO_ROTULO: Record<MotivoDoPeriodo, string> = {
  SEFAZ_UNAVAILABLE: 'SEFAZ indisponível',
  NETWORK_UNAVAILABLE: 'Sem conexão com a SEFAZ',
  TRANSPORT_ERROR: 'Falha de comunicação com a SEFAZ',
};

export type OrigemDoPeriodo = 'AUTOMATICA' | 'MANUAL';

export interface PeriodoDeContingencia {
  id: string;
  companyId: string;
  motivo: MotivoDoPeriodo;
  motivoRotulo: string;
  /** O `xJust` das notas do período — sai no XML de cada uma. */
  justificativa: string;
  iniciadoEm: string;
  origem: OrigemDoPeriodo;
  iniciadoPor: string | null;
  codigoDoGatilho: string | null;
  encerradoEm: string | null;
  origemDoEncerramento: OrigemDoPeriodo | null;
  encerradoPor: string | null;
  ultimaSondagemEm: string | null;
  ultimaSondagemCStat: string | null;
  ultimaSondagemMotivo: string | null;
}

function paraPeriodo(row: Record<string, unknown>): PeriodoDeContingencia {
  const motivo = String(row.reason) as MotivoDoPeriodo;
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    motivo,
    motivoRotulo: MOTIVO_ROTULO[motivo] ?? motivo,
    justificativa: String(row.justification),
    iniciadoEm: String(row.started_at),
    origem: String(row.started_origin) as OrigemDoPeriodo,
    iniciadoPor: (row.started_by as string | null) ?? null,
    codigoDoGatilho: (row.trigger_code as string | null) ?? null,
    encerradoEm: (row.ended_at as string | null) ?? null,
    origemDoEncerramento: (row.ended_origin as OrigemDoPeriodo | null) ?? null,
    encerradoPor: (row.ended_by as string | null) ?? null,
    ultimaSondagemEm: (row.last_probe_at as string | null) ?? null,
    ultimaSondagemCStat: (row.last_probe_cstat as string | null) ?? null,
    ultimaSondagemMotivo: (row.last_probe_reason as string | null) ?? null,
  };
}

export function periodoAtivo(companyId: string): PeriodoDeContingencia | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT * FROM core_fiscal_contingency_periods
        WHERE company_id = ? AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(companyId) as Record<string, unknown> | undefined;
  return row ? paraPeriodo(row) : null;
}

export function listarPeriodos(companyId: string, limite = 10): PeriodoDeContingencia[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare(
        `SELECT * FROM core_fiscal_contingency_periods WHERE company_id = ?
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(companyId, limite) as unknown as Record<string, unknown>[]
  ).map(paraPeriodo);
}

/**
 * O texto do `xJust` dentro do leiaute: 15 a 256 caracteres do TString (do
 * `!` ao `ÿ`, sem espaço nas pontas). Travessão e aspas curvas viram o
 * equivalente simples; o que não cabe no Latin-1 sai.
 */
export function textoDoXJust(texto: string): string {
  return texto
    .replace(/[‒-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^ -ÿ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256)
    .trim();
}

/**
 * Abre o período de contingência da operação.
 *
 * IDEMPOTENTE: com um período aberto, devolve ele — a segunda nota que falha
 * não abre outro. Só com a modalidade off-line ligada: com 'AGUARDAR', a
 * contingência é da fila (a nota espera), e abrir período aqui seria mudar o
 * tipo de emissão contra a decisão do contador.
 */
export function abrirPeriodo(input: {
  companyId: string;
  motivo: MotivoDoPeriodo;
  origem: OrigemDoPeriodo;
  justificativa?: string | null;
  codigoDoGatilho?: string | null;
  mensagemDoGatilho?: string | null;
  userId?: string | null;
}): PeriodoDeContingencia {
  ensureCoreSchema();
  const politica = lerPoliticaDeContingencia(input.companyId);
  if (politica.modo !== 'OFFLINE_NFCE') {
    throw new ApiError(
      'CORE_CONTINGENCY_POLICY_OFF',
      'A contingência off-line está desligada nesta operação (decisão do contador, em Fiscal › '
        + 'Documentos). Com ela desligada, a NFC-e espera na fila e sai quando a SEFAZ voltar.',
      409,
    );
  }
  if (!MOTIVO_ROTULO[input.motivo]) {
    throw new ApiError(
      'CORE_CONTINGENCY_REASON_INVALID',
      'Contingência exige um motivo de indisponibilidade. Erro de dado fiscal não é contingência.',
      400,
    );
  }

  const aberto = periodoAtivo(input.companyId);
  if (aberto) return aberto;

  let justificativa: string;
  if (input.origem === 'MANUAL') {
    justificativa = textoDoXJust(String(input.justificativa ?? ''));
    if (justificativa.length < 15) {
      throw new ApiError(
        'CORE_CONTINGENCY_JUSTIFICATION_INVALID',
        'Escreva a justificativa da entrada em contingência (15 a 256 caracteres) — ela vai '
          + 'dentro de cada NFC-e do período.',
        400,
      );
    }
  } else {
    justificativa = textoDoXJust(
      `${MOTIVO_ROTULO[input.motivo]}: ${input.mensagemDoGatilho || 'sem resposta do servico de autorizacao da NFC-e'}`,
    );
    if (justificativa.length < 15) justificativa = textoDoXJust(`${MOTIVO_ROTULO[input.motivo]} - sem resposta`);
  }

  const agora = new Date().toISOString();
  const id = randomUUID();
  try {
    withTransaction(() => {
      getConnection()
        .prepare(
          `INSERT INTO core_fiscal_contingency_periods
             (id, company_id, model, reason, justification, started_at, started_origin, started_by,
              trigger_code, created_at, updated_at)
           VALUES (?, ?, '65', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          input.motivo,
          justificativa,
          agora,
          input.origem,
          input.userId ?? null,
          input.codigoDoGatilho ?? null,
          agora,
          agora,
        );
    });
  } catch (err) {
    // O índice único parcial segurou uma corrida: outro chamador abriu primeiro.
    const vencedor = periodoAtivo(input.companyId);
    if (vencedor) return vencedor;
    throw err;
  }

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.contingency_period_started',
    entityType: 'fiscal_contingency',
    entityId: id,
    detail: {
      motivo: input.motivo,
      origem: input.origem,
      codigoDoGatilho: input.codigoDoGatilho ?? null,
      justificativa,
    },
  });
  return periodoAtivo(input.companyId)!;
}

/**
 * Encerra o período aberto — pela sondagem (a SEFAZ respondeu 107), por uma
 * autorização que chegou, ou pelo gerente. Sem período aberto: nada a fazer.
 */
export function encerrarPeriodo(input: {
  companyId: string;
  origem: OrigemDoPeriodo;
  userId?: string | null;
  cStat?: string | null;
  motivo?: string | null;
}): PeriodoDeContingencia | null {
  ensureCoreSchema();
  const aberto = periodoAtivo(input.companyId);
  if (!aberto) return null;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `UPDATE core_fiscal_contingency_periods
          SET ended_at = ?, ended_origin = ?, ended_by = ?, updated_at = ?
        WHERE id = ? AND ended_at IS NULL`,
    )
    .run(agora, input.origem, input.userId ?? null, agora, aberto.id);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.contingency_period_finished',
    entityType: 'fiscal_contingency',
    entityId: aberto.id,
    detail: { origem: input.origem, cStat: input.cStat ?? null, motivo: input.motivo ?? null },
  });
  return { ...aberto, encerradoEm: agora, origemDoEncerramento: input.origem, encerradoPor: input.userId ?? null };
}

/** A última resposta à sondagem, gravada no período aberto (para a tela dizer). */
export function anotarSondagemNoPeriodo(
  companyId: string,
  sondagem: { em: string; cStat: string | null; xMotivo: string | null },
): void {
  getConnection()
    .prepare(
      `UPDATE core_fiscal_contingency_periods
          SET last_probe_at = ?, last_probe_cstat = ?, last_probe_reason = ?, updated_at = ?
        WHERE company_id = ? AND ended_at IS NULL`,
    )
    .run(sondagem.em, sondagem.cStat, sondagem.xMotivo, sondagem.em, companyId);
}

// --------------------------------------------------------- a emissão off-line

/** `tpEmis` da contingência off-line da NFC-e — posição 35 da chave. */
export const TP_EMIS_OFFLINE_NFCE = '9';

/** O tipo de emissão gravado na CHAVE (posição 35). Nulo sem chave. */
export function tipoDeEmissaoDaChave(accessKey: string | null | undefined): string | null {
  const chave = String(accessKey ?? '');
  return chave.length === 44 ? chave[34] : null;
}

export function emitidaOffline(accessKey: string | null | undefined): boolean {
  return tipoDeEmissaoDaChave(accessKey) === TP_EMIS_OFFLINE_NFCE;
}

export interface EmissaoEmContingencia {
  emissionType: typeof TP_EMIS_OFFLINE_NFCE;
  /** Data e hora da ENTRADA em contingência, no fuso do emitente (TDateTimeUTC). */
  dhCont: string;
  xJust: string;
  periodo: PeriodoDeContingencia;
}

/**
 * A próxima NFC-e desta operação sai em contingência off-line?
 *
 * Sim só com as três coisas juntas: modelo 65, modalidade off-line decidida e
 * um período aberto. A resposta vem ANTES de numerar — a chave carrega o
 * `tpEmis`, e trocá-lo depois mudaria a chave.
 */
export function emissaoEmContingencia(
  companyId: string,
  model: string,
  uf: string | null | undefined,
): EmissaoEmContingencia | null {
  if (model !== '65') return null;
  if (lerPoliticaDeContingencia(companyId).modo !== 'OFFLINE_NFCE') return null;
  const periodo = periodoAtivo(companyId);
  if (!periodo) return null;
  return {
    emissionType: TP_EMIS_OFFLINE_NFCE,
    dhCont: momentoFiscal(new Date(periodo.iniciadoEm), String(uf ?? '')).dhEmi,
    xJust: periodo.justificativa,
    periodo,
  };
}

/** O prazo de transmissão de UMA nota off-line: emissão + prazo do contador. */
export function prazoDeTransmissao(companyId: string, emitidaEm: string | null): string | null {
  const politica = lerPoliticaDeContingencia(companyId);
  if (!politica.prazoHoras || !emitidaEm) return null;
  return new Date(new Date(emitidaEm).getTime() + politica.prazoHoras * 3_600_000).toISOString();
}

// ------------------------------------------------------------- a prontidão

/**
 * O item da prontidão da NFC-e: a modalidade de contingência foi decidida?
 *
 * PENDING, nunca FAIL: emitir sem a decisão é possível (a nota espera a SEFAZ
 * voltar) — o que falta é a resposta do contador sobre o que fazer quando a
 * SEFAZ cai com o cliente no balcão. O dono do item é o contador.
 */
export function itemDeProntidaoDaContingencia(companyId: string): ReadinessItem {
  const p = lerPoliticaDeContingencia(companyId);
  const decidido = p.atualizadoEm !== null;
  if (p.modo === 'OFFLINE_NFCE') {
    return {
      key: 'contingency',
      label: 'Contingência da NFC-e',
      status: 'PASS',
      detail: `Off-line (tpEmis 9) com prazo de transmissão de ${p.prazoHoras} h, conforme o contador.`,
      state: 'CONFIRMADO',
      source: 'cadastro',
      owner: 'contador',
      known: `off-line, ${p.prazoHoras} h`,
      counts: null,
    };
  }
  return {
    key: 'contingency',
    label: 'Contingência da NFC-e',
    status: decidido ? 'PASS' : 'PENDING',
    detail: decidido
      ? 'Sem contingência off-line: com a SEFAZ fora, a NFC-e espera na fila e é transmitida '
        + 'sozinha quando o serviço volta.'
      : 'O contador ainda não decidiu a modalidade. Enquanto isso, com a SEFAZ fora a NFC-e '
        + 'espera na fila (o cliente sai sem DANFCE). Para emitir off-line (tpEmis 9) é preciso '
        + 'a modalidade e o prazo de transmissão da UF — em Fiscal › Documentos.',
    state: decidido ? 'CONFIRMADO' : 'PENDENTE',
    source: decidido ? 'cadastro' : null,
    owner: 'contador',
    known: decidido ? 'aguardar a SEFAZ' : null,
    counts: null,
  };
}

// ---------------------------------------------------------------- o painel

export interface PainelDaContingencia {
  politica: PoliticaDeContingencia;
  /** O período aberto agora, se houver. */
  periodo: PeriodoDeContingencia | null;
  /** Os últimos períodos, para a auditoria de quem abriu e quem fechou. */
  historico: PeriodoDeContingencia[];
  /** NFC-e emitidas off-line ainda sem autorização. */
  notasOffline: { pendentes: number; prazoMaisProximo: string | null };
}

export function painelDaContingencia(companyId: string): PainelDaContingencia {
  ensureCoreSchema();
  const pendentes = getConnection()
    .prepare(
      `SELECT issued_at FROM core_fiscal_documents
        WHERE company_id = ? AND model = '65' AND substr(access_key, 35, 1) = '9'
          AND status IN ('CONTINGENCY', 'QUEUED', 'SENDING')
        ORDER BY issued_at`,
    )
    .all(companyId) as unknown as { issued_at: string | null }[];
  return {
    politica: lerPoliticaDeContingencia(companyId),
    periodo: periodoAtivo(companyId),
    historico: listarPeriodos(companyId, 5),
    notasOffline: {
      pendentes: pendentes.length,
      prazoMaisProximo: pendentes.length ? prazoDeTransmissao(companyId, pendentes[0].issued_at) : null,
    },
  };
}
