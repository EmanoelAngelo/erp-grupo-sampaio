/**
 * ============================================================================
 * O DESLOCAMENTO FIXO DO SQL AINDA VALE? — conferido no ar (GAP-PRD-145)
 * ============================================================================
 *
 * `diaDaLojaSql` corta o dia somando um deslocamento FIXO de -3h, porque o
 * SQLite não tem banco de fusos; o JavaScript (`diaDaLoja`) usa o `Intl`, que
 * acompanha a regra oficial. Os dois concordam porque o Brasil não tem horário
 * de verão desde 2019.
 *
 * Se voltar a ter, os dois passam a discordar em uma hora: a venda das 23h30
 * cai num dia pela consulta SQL e noutro pelo cálculo em JS — fechamento do
 * dia, DRE e pacote do contador contando histórias diferentes. Até aqui, só a
 * suíte de testes percebia (`calendario-da-loja`), e ela não roda na loja.
 *
 * Agora a API confere ao subir e a tela Sistema mostra: o deslocamento vale
 * hoje e pelos próximos ~13 meses? A regra nova de fuso chega pelo `tzdata`
 * do Node meses antes de valer, então o aviso aparece ANTES da divergência —
 * com a data em que ela começa.
 */
import {
  DESLOCAMENTO_SQL_HORAS,
  FUSO_DA_LOJA,
  oDeslocamentoAindaEFixo,
} from './CalendarioOperacional.js';

export type EstadoDoFuso =
  /** O deslocamento fixo vale agora e por toda a janela conferida. */
  | 'FIXO_VALE'
  /** Vale agora, e deixa de valer dentro da janela — há data para agir. */
  | 'VAI_DIVERGIR'
  /** SQL e JS discordam AGORA sobre o dia da loja. */
  | 'DIVERGE_AGORA';

export interface ConferenciaDoFuso {
  estado: EstadoDoFuso;
  fuso: string;
  deslocamentoSqlHoras: number;
  conferidoEm: string;
  /** Até quando a janela foi conferida. */
  conferidoAte: string;
  /** O primeiro instante conferido em que o fixo deixa de valer. */
  primeiraDivergencia: string | null;
  /** O que fazer, em português; nulo quando não há o que fazer. */
  comoResolver: string | null;
}

const DOZE_HORAS_MS = 12 * 3_600_000;

/**
 * Confere `agora` e, de doze em doze horas, os próximos `dias` dias.
 *
 * Doze horas bastam: mudança de horário de verão dura meses, e o que se quer
 * saber é o DIA em que ela começa. São ~800 consultas ao `Intl` — nada perto
 * do custo de uma requisição.
 */
export function conferirFusoDaLoja(
  agora: Date = new Date(),
  opcoes: { dias?: number; aindaFixo?: (instante: Date) => boolean } = {},
): ConferenciaDoFuso {
  const dias = opcoes.dias ?? 400;
  const aindaFixo = opcoes.aindaFixo ?? oDeslocamentoAindaEFixo;
  const fim = agora.getTime() + dias * 86_400_000;

  let primeira: Date | null = aindaFixo(agora) ? null : agora;
  for (let t = agora.getTime() + DOZE_HORAS_MS; primeira === null && t <= fim; t += DOZE_HORAS_MS) {
    const instante = new Date(t);
    if (!aindaFixo(instante)) primeira = instante;
  }

  const estado: EstadoDoFuso =
    primeira === null ? 'FIXO_VALE' : primeira.getTime() === agora.getTime() ? 'DIVERGE_AGORA' : 'VAI_DIVERGIR';

  const comoResolver =
    estado === 'FIXO_VALE'
      ? null
      : `A regra de fuso de ${FUSO_DA_LOJA} deixou de ser ${DESLOCAMENTO_SQL_HORAS}h fixas `
        + `(${estado === 'DIVERGE_AGORA' ? 'já agora' : `a partir de ${primeira!.toISOString().slice(0, 10)}`}). `
        + 'As consultas SQL cortam o dia por esse deslocamento e os cálculos em JavaScript pelo fuso '
        + 'oficial: o dia da venda perto da meia-noite passa a divergir entre relatórios. É preciso '
        + 'uma versão do sistema que corte o dia no SQL pela regra nova (DESLOCAMENTO_SQL_HORAS em '
        + 'CalendarioOperacional.ts) — avise o suporte com esta data.';

  return {
    estado,
    fuso: FUSO_DA_LOJA,
    deslocamentoSqlHoras: DESLOCAMENTO_SQL_HORAS,
    conferidoEm: agora.toISOString(),
    conferidoAte: new Date(fim).toISOString(),
    primeiraDivergencia: primeira ? primeira.toISOString() : null,
    comoResolver,
  };
}

/**
 * A conferência do boot: diz no log quando o fixo não vale (ou vai deixar de
 * valer), e devolve o resultado. O `log` é injetável para o teste.
 */
export function avisarSeOFusoDiverge(
  log: (mensagem: string, meta?: Record<string, unknown>) => void,
  agora: Date = new Date(),
): ConferenciaDoFuso {
  const c = conferirFusoDaLoja(agora);
  if (c.estado !== 'FIXO_VALE') {
    log('FUSO_DA_LOJA_DIVERGE', {
      estado: c.estado,
      fuso: c.fuso,
      deslocamentoSqlHoras: c.deslocamentoSqlHoras,
      primeiraDivergencia: c.primeiraDivergencia,
      comoResolver: c.comoResolver,
    });
  }
  return c;
}
