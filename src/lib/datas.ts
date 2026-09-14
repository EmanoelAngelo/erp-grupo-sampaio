/**
 * DATA NA TELA — o dia da loja, e não o do navegador.
 *
 * ============================================================================
 * OS DOIS ERROS QUE ESTE ARQUIVO EXISTE PARA IMPEDIR
 * ============================================================================
 *
 * **1. Data de calendário lida como instante.**
 *
 *     new Date('2026-12-31').toLocaleDateString('pt-BR')  // → '30/12/2026'
 *
 * `new Date` lê '2026-12-31' como meia-noite de GREENWICH; em Pelotas isso é
 * 21h do dia 30, e a tela mostra o dia anterior. Vencimento, competência,
 * validade de orçamento e prazo de promoção são todos data de calendário — e
 * todos apareciam um dia adiantados para trás.
 *
 * A correção não é converter melhor: é NÃO CONVERTER. Uma data de calendário
 * não tem hora, não tem fuso e não precisa de `Date` nenhum para virar
 * '31/12/2026'.
 *
 * **2. Instante lido no fuso do navegador.**
 *
 * O carimbo do banco é UTC. `toLocaleDateString` sem fuso usa o relógio da
 * MÁQUINA de quem olha — e o dono abre o painel do notebook, o contador abre
 * de outra cidade, e um navegador configurado em UTC mostra a venda das 21h30
 * no dia seguinte. O dia da loja não pode depender de quem está olhando.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Um valor no formato 'AAAA-MM-DD' é DATA: vira texto, sem `Date`.
 * Qualquer outro é INSTANTE: convertido para `America/Sao_Paulo`, sempre.
 *
 * O servidor tem o mesmo dono da mesma regra, em
 * `server/src/services/core/CalendarioOperacional.ts`.
 */

/** O relógio pelo qual a loja vive. Igual ao do servidor. */
export const FUSO_DA_LOJA = 'America/Sao_Paulo';

/** O que aparece no lugar de uma data que não existe. */
const VAZIO = '—';

const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

const DIA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_LOJA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DIA_E_HORA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_LOJA,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const HORA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_LOJA,
  hour: '2-digit',
  minute: '2-digit',
});

const MES_E_ANO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_DA_LOJA,
  month: '2-digit',
  year: 'numeric',
});

function comInstante(
  valor: string | null | undefined,
  formato: Intl.DateTimeFormat,
  vazio: string,
): string {
  const texto = String(valor ?? '').trim();
  if (!texto) return vazio;
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? vazio : formato.format(d);
}

/**
 * A data, como se lê em português.
 *
 * @param vazio o que mostrar quando não há data. O padrão é o travessão; passe
 * outro quando a tela já tiver uma frase própria para a ausência.
 */
export function dataBR(valor: string | null | undefined, vazio = VAZIO): string {
  const texto = String(valor ?? '').trim();
  if (!texto) return vazio;

  // Data de calendário: reescrita, nunca convertida. É aqui que o dia deixa de
  // recuar.
  const so = SO_DATA.exec(texto);
  if (so) return `${so[3]}/${so[2]}/${so[1]}`;

  return comInstante(texto, DIA, vazio);
}

/** A data e a hora do relógio da loja. */
export function dataHoraBR(valor: string | null | undefined, vazio = VAZIO): string {
  const texto = String(valor ?? '').trim();
  // Data pura não tem hora para mostrar, e inventar '00:00' seria afirmar um
  // horário que ninguém registrou.
  if (SO_DATA.test(texto)) return dataBR(texto, vazio);
  return comInstante(texto, DIA_E_HORA, vazio);
}

/** Só a hora, para linha do tempo e comprovante. */
export function horaBR(valor: string | null | undefined, vazio = VAZIO): string {
  return comInstante(valor, HORA, vazio);
}

/** Mês e ano, para agrupamento de lista. */
export function mesAnoBR(valor: string | null | undefined, vazio = VAZIO): string {
  const texto = String(valor ?? '').trim();
  const so = SO_DATA.exec(texto);
  if (so) return `${so[2]}/${so[1]}`;
  return comInstante(texto, MES_E_ANO, vazio);
}

/**
 * Hoje na loja, no formato de um `<input type="date">`.
 *
 * Serve para valor inicial de filtro. `new Date().toISOString().slice(0, 10)`
 * responderia o dia de Greenwich — e depois das 21h abriria a tela já no dia
 * seguinte, com o expediente ainda em curso.
 */
export function hojeNaLoja(agora: Date = new Date()): string {
  const partes = DIA.formatToParts(agora);
  const pegar = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return `${pegar('year')}-${pegar('month')}-${pegar('day')}`;
}

/** O mês corrente da loja, 'AAAA-MM'. */
export function mesDaLoja(agora: Date = new Date()): string {
  return hojeNaLoja(agora).slice(0, 7);
}

/** O primeiro dia do mês corrente da loja, para filtro que abre no mês. */
export function primeiroDiaDoMes(agora: Date = new Date()): string {
  return `${mesDaLoja(agora)}-01`;
}

/**
 * Soma dias a uma data de calendário.
 *
 * Meio-dia de propósito: somar sobre a meia-noite escorrega um dia inteiro
 * conforme o fuso. Mesma regra do servidor.
 */
export function somarDias(dia: string, dias: number): string {
  const base = new Date(`${dia.slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return dia;
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

/** O dia da loja de N dias atrás, para o valor inicial de um filtro. */
export function diasAtras(quantos: number, agora: Date = new Date()): string {
  return somarDias(hojeNaLoja(agora), -quantos);
}
