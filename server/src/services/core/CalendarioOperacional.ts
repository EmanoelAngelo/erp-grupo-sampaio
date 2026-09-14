/**
 * QUE DIA É HOJE NA LOJA — a pergunta com uma resposta só.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * Todo recorte de data do sistema comparava o texto ISO do carimbo, que é o
 * relógio de Greenwich:
 *
 *     WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
 *
 * Pelotas está três horas atrás de Greenwich. Uma venda das 21h30 de 31 de
 * agosto é gravada como 2026-09-01T00:30:00.000Z. Para o banco, ela é do dia
 * 1º de setembro — e por isso:
 *
 *   - some do fechamento do dia que o operador acabou de viver;
 *   - entra no faturamento do MÊS seguinte, inclusive no pacote do contador;
 *   - aparece no DRE de setembro, com a mercadoria saída em agosto;
 *   - faz a conferência do turno não bater com a gaveta.
 *
 * Não é caso raro: no varejo, tudo que acontece **depois das 21h** cai no dia
 * errado. Em loja que fecha às 22h, é a última hora de todo dia.
 *
 * `FiscalClosingService` documentava a escolha e a defendia com uma razão boa —
 * uma convenção só, para tela e pacote contarem a mesma história. A razão está
 * certa; a convenção é que estava errada. Este arquivo mantém a razão e troca a
 * convenção: **um dono só, e o dia é o dia de quem opera a loja.**
 *
 * ============================================================================
 * AS DUAS FORMAS, E QUANDO USAR CADA UMA
 * ============================================================================
 *
 * 1. `diaDaLojaSql(coluna)` — para consulta que corta POR DIA de calendário
 *    ou agrupa por dia. Devolve a expressão SQL que converte o carimbo para o
 *    dia da loja. Substitui `substr(coluna, 1, 10)` sem mexer em mais nada:
 *    os sentinelas '0000'/'9999' continuam funcionando, e o GROUP BY também.
 *
 * 2. `limitesDoPeriodo(de, ate)` — para consulta que já compara INSTANTE
 *    (`created_at >= ?`). Converte as duas pontas do período para os instantes
 *    UTC correspondentes à meia-noite e ao último milissegundo locais.
 *
 * As duas dizem a mesma coisa por caminhos diferentes, e o teste do calendário
 * cobra que concordem instante a instante. Se um dia divergirem, o teste fica
 * vermelho antes do relatório.
 *
 * ============================================================================
 * HORÁRIO DE VERÃO
 * ============================================================================
 *
 * O JavaScript converte pelo banco de fusos do sistema (`Intl`), então
 * `diaDaLoja()` acerta em qualquer regra, presente ou futura. O SQLite não tem
 * banco de fusos: `diaDaLojaSql` soma um deslocamento FIXO. Os dois coincidem
 * porque o Brasil não tem horário de verão desde 2019.
 *
 * Se voltar a ter, `oDeslocamentoAindaEFixo()` — cobrado pelo teste ao longo de
 * um ano inteiro — fica vermelho, e este é o arquivo que muda.
 */

/** O relógio pelo qual a loja vive. */
export const FUSO_DA_LOJA = 'America/Sao_Paulo';

/**
 * O deslocamento usado no SQL, em horas.
 *
 * Negativo porque o Brasil está atrás de Greenwich: para achar o dia local a
 * partir do carimbo UTC, recua-se o relógio.
 */
export const DESLOCAMENTO_SQL_HORAS = -3;

/** O menor e o maior texto possíveis numa comparação de data. */
export const SEM_INICIO = '0000';
export const SEM_FIM = '9999';

const PARTES = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO_DA_LOJA,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Parede {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function pad(valor: number, tamanho = 2): string {
  return String(valor).padStart(tamanho, '0');
}

/** O relógio de parede da loja no instante dado. */
function paredeEm(instante: Date): Parede {
  const campos: Record<string, string> = {};
  for (const parte of PARTES.formatToParts(instante)) {
    if (parte.type !== 'literal') campos[parte.type] = parte.value;
  }
  return {
    ano: Number(campos.year),
    mes: Number(campos.month),
    dia: Number(campos.day),
    hora: Number(campos.hour),
    minuto: Number(campos.minute),
    segundo: Number(campos.second),
  };
}

/** Quanto o relógio da loja está adiantado em relação a Greenwich, em ms. */
function deslocamentoMs(instante: Date): number {
  const p = paredeEm(instante);
  const comoSeFosseUtc = Date.UTC(
    p.ano,
    p.mes - 1,
    p.dia,
    p.hora,
    p.minuto,
    p.segundo,
    instante.getUTCMilliseconds(),
  );
  return comoSeFosseUtc - instante.getTime();
}

function comoData(instante: string | Date): Date {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`Instante inválido para o calendário da loja: ${String(instante)}`);
  }
  return d;
}

const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * O dia de calendário da loja em que este instante caiu.
 *
 * É o contrário de `toISOString().slice(0, 10)`: aquele responde "que dia era
 * em Greenwich", que é a pergunta que ninguém faz.
 *
 * **Data de calendário entra e sai igual.** Nem toda coluna do sistema guarda
 * instante: `entered_at` de um equipamento é 'AAAA-MM-DD', e converter uma data
 * que não tem hora é inventar uma — meia-noite de Greenwich, que em Pelotas é
 * o dia anterior às 21h. A ficha passaria a dizer "entrou em 11/08" para uma
 * máquina que entrou em 12. Quem já é dia da loja não precisa virar dia da
 * loja de novo.
 */
export function diaDaLoja(instante: string | Date): string {
  if (typeof instante === 'string' && SO_DATA.test(instante.trim())) return instante.trim();
  const p = paredeEm(comoData(instante));
  return `${p.ano}-${pad(p.mes)}-${pad(p.dia)}`;
}

/** A hora de parede da loja, HH:MM. Para tela e comprovante. */
export function horaDaLoja(instante: string | Date): string {
  const p = paredeEm(comoData(instante));
  return `${pad(p.hora)}:${pad(p.minuto)}`;
}

/** Hoje, para quem está atrás do balcão. */
export function hojeNaLoja(agora: Date = new Date()): string {
  return diaDaLoja(agora);
}

/** O mês corrente da loja, AAAA-MM. */
export function mesDaLoja(agora: Date = new Date()): string {
  return hojeNaLoja(agora).slice(0, 7);
}

/**
 * O instante UTC de um relógio de parede da loja.
 *
 * Duas passadas de propósito: na virada de horário de verão, o deslocamento do
 * instante-chute difere do deslocamento do instante-resposta, e uma passada só
 * erraria a hora exatamente no dia em que ninguém quer errar.
 */
function instanteDaParede(
  dia: string,
  hora: number,
  minuto: number,
  segundo: number,
  ms: number,
): Date {
  const [ano, mes, d] = dia.split('-').map(Number);
  if (!ano || !mes || !d) {
    throw new TypeError(`Data inválida para o calendário da loja: ${dia}`);
  }
  const alvo = Date.UTC(ano, mes - 1, d, hora, minuto, segundo, ms);
  const chute = new Date(alvo - deslocamentoMs(new Date(alvo)));
  return new Date(alvo - deslocamentoMs(chute));
}

/** O instante UTC em que este dia começou na loja. */
export function inicioDoDia(dia: string): string {
  return instanteDaParede(dia, 0, 0, 0, 0).toISOString();
}

/** O instante UTC do último milissegundo deste dia na loja. */
export function fimDoDia(dia: string): string {
  return instanteDaParede(dia, 23, 59, 59, 999).toISOString();
}

export interface LimitesEmInstantes {
  /** Inclusivo. */
  inicio: string;
  /** Inclusivo, até o último milissegundo. */
  fim: string;
}

/**
 * O período do calendário da loja, em instantes UTC comparáveis com o carimbo.
 *
 * Ponta vazia — ou o sentinela que as rotas já usam — vira um limite fora de
 * qualquer data real, e não um erro: "sem filtro" é resposta legítima.
 */
export function limitesDoPeriodo(de?: string | null, ate?: string | null): LimitesEmInstantes {
  const inicial = String(de ?? '').trim();
  const final = String(ate ?? '').trim();
  return {
    inicio:
      !inicial || inicial === SEM_INICIO
        ? '0000-01-01T00:00:00.000Z'
        : inicioDoDia(inicial.slice(0, 10)),
    fim:
      !final || final === SEM_FIM ? '9999-12-31T23:59:59.999Z' : fimDoDia(final.slice(0, 10)),
  };
}

export interface LimitesDoMes extends LimitesEmInstantes {
  period: string;
  primeiroDia: string;
  ultimoDia: string;
}

/** O mês AAAA-MM no calendário da loja. Presume o formato já validado. */
export function limitesDoMes(period: string): LimitesDoMes {
  const ano = Number(period.slice(0, 4));
  const mes = Number(period.slice(5, 7));
  // Dia 0 do mês SEGUINTE é o último deste — sem tabela de 30/31 nem regra de
  // ano bissexto escrita à mão.
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const primeiroDia = `${period}-01`;
  const ultimoDia = `${period}-${pad(ultimo)}`;
  return {
    period,
    primeiroDia,
    ultimoDia,
    inicio: inicioDoDia(primeiroDia),
    fim: fimDoDia(ultimoDia),
  };
}

/**
 * Soma dias a uma data de calendário.
 *
 * Meio-dia de propósito: somar sobre a meia-noite escorrega um dia inteiro
 * conforme o fuso, e o efeito seria uma dívida vencendo um dia antes do
 * combinado.
 */
export function somarDias(dia: string, dias: number): string {
  const base = new Date(`${dia.slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new TypeError(`Data inválida para somar dias: ${dia}`);
  }
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

/** Um valor que veio da tela é data de calendário, e não instante? */
function ehDataDeCalendario(valor: string): boolean {
  return SO_DATA.test(valor);
}

/**
 * A ponta INICIAL de uma vigência, vinda da tela.
 *
 * Um `<input type="date">` devolve '2026-12-31'. Passar isso por `new Date()`
 * produz meia-noite de GREENWICH, que em Pelotas é 21h do dia 30 — e é assim
 * que "começa em 31/12" virava "começa às 21h do dia 30".
 *
 * Instante completo passa intocado: quem já mandou um carimbo sabe o que quer.
 */
export function comoInstanteInicial(valor: string): string {
  const texto = String(valor ?? '').trim();
  return ehDataDeCalendario(texto) ? inicioDoDia(texto) : texto;
}

/**
 * A ponta FINAL de uma vigência, vinda da tela.
 *
 * O erro aqui é o que aparece na loja: "válida até 31/12" com meia-noite de
 * Greenwich mata a promoção às **21h do dia 30**, com a campanha ainda
 * anunciada e o preço voltando ao de tabela sozinho. Uma data na ponta final
 * significa o dia INTEIRO.
 */
export function comoInstanteFinal(valor: string): string {
  const texto = String(valor ?? '').trim();
  return ehDataDeCalendario(texto) ? fimDoDia(texto) : texto;
}

/**
 * A expressão SQL que devolve o dia da loja de uma coluna de carimbo.
 *
 * Troca direta por `substr(coluna, 1, 10)`. O SQLite lê o sufixo Z sem ajuda,
 * e o modificador de horas faz a conversão.
 */
export function diaDaLojaSql(coluna: string): string {
  const sinal = DESLOCAMENTO_SQL_HORAS < 0 ? '-' : '+';
  return `substr(datetime(${coluna}, '${sinal}${Math.abs(DESLOCAMENTO_SQL_HORAS)} hours'), 1, 10)`;
}

/**
 * O deslocamento fixo do SQL ainda descreve o fuso da loja neste instante?
 *
 * Existe para o teste cobrar. Enquanto não houver horário de verão, é sempre
 * verdadeiro; no dia em que houver, aponta o arquivo que precisa mudar.
 */
export function oDeslocamentoAindaEFixo(instante: Date): boolean {
  return deslocamentoMs(instante) === DESLOCAMENTO_SQL_HORAS * 3_600_000;
}
