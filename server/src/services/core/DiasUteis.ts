/**
 * DIA ÚTIL NO CALENDÁRIO DA LOJA.
 *
 * Duas contas do e-commerce dependem de "dia útil" e as duas erravam por
 * motivos diferentes:
 *
 *   - a data de entrega prometida (GAP-PRD-196) somava dias com `getDay()` do
 *     fuso do PROCESSO — num servidor em UTC, a expedição das 21h30 de quinta
 *     em Pelotas já é sexta, e a promessa pulava para segunda;
 *   - a reserva do pedido com boleto (GAP-PRD-029) não contava dia útil
 *     nenhum: morria em 25 horas, antes de o banco poder confirmar o boleto
 *     pago no vencimento.
 *
 * Aqui tudo é DATA DE CALENDÁRIO (AAAA-MM-DD). Um instante que chegue é
 * primeiro convertido para o dia da loja (`diaDaLoja`), e o dia da semana sai
 * do meio-dia de Greenwich da própria data — o mesmo dia em qualquer fuso.
 *
 * FERIADOS: o calendário BANCÁRIO nacional — os fixos da lei federal, mais
 * carnaval (segunda e terça), sexta-feira da Paixão e Corpus Christi, que o
 * sistema financeiro não trata como dia útil. Feriado estadual e municipal
 * não entram: o sistema não tem de onde tirar a cidade de cada banco e de
 * cada transportadora. Errar para o lado de MAIS dias não úteis é o lado
 * seguro nas duas contas: a reserva do boleto dura um pouco mais, e a data
 * prometida ao cliente fica um pouco mais longe — nunca mais perto.
 */
import { diaDaLoja, somarDias } from './CalendarioOperacional.js';

function pad(valor: number): string {
  return String(valor).padStart(2, '0');
}

/** 0 = domingo … 6 = sábado, do dia de calendário da loja. */
export function diaDaSemana(dia: string): number {
  return new Date(`${diaDaLoja(dia)}T12:00:00.000Z`).getUTCDay();
}

/**
 * Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário
 * gregoriano). É dele que saem carnaval, Paixão e Corpus Christi.
 */
function domingoDePascoa(ano: number): string {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const diaDoMes = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${pad(mes)}-${pad(diaDoMes)}`;
}

const FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];

const porAno = new Map<number, ReadonlySet<string>>();

/** Os dias não úteis do calendário bancário nacional naquele ano. */
export function feriadosNacionais(ano: number): ReadonlySet<string> {
  const guardado = porAno.get(ano);
  if (guardado) return guardado;
  const dias = new Set(FIXOS.map((md) => `${ano}-${md}`));
  // Consciência Negra: feriado nacional desde a Lei 14.759/2023.
  if (ano >= 2024) dias.add(`${ano}-11-20`);
  const pascoa = domingoDePascoa(ano);
  dias.add(somarDias(pascoa, -48)); // carnaval, segunda
  dias.add(somarDias(pascoa, -47)); // carnaval, terça
  dias.add(somarDias(pascoa, -2)); // sexta-feira da Paixão
  dias.add(somarDias(pascoa, 60)); // Corpus Christi
  porAno.set(ano, dias);
  return dias;
}

export function ehDiaUtil(dia: string): boolean {
  const data = diaDaLoja(dia);
  const semana = diaDaSemana(data);
  if (semana === 0 || semana === 6) return false;
  return !feriadosNacionais(Number(data.slice(0, 4))).has(data);
}

/**
 * O primeiro dia útil a partir deste (inclusive). É o "vence no sábado, paga
 * na segunda" do boleto.
 */
export function proximoDiaUtil(dia: string): string {
  let atual = diaDaLoja(dia);
  // Nenhum trecho do calendário brasileiro tem mais de quatro dias não úteis
  // seguidos; o teto só existe para um calendário corrompido não virar laço.
  for (let i = 0; i < 15 && !ehDiaUtil(atual); i += 1) atual = somarDias(atual, 1);
  return atual;
}

/**
 * Soma `dias` dias úteis a uma data. Zero devolve a própria data (do jeito que
 * veio, útil ou não): "prazo zero" não é promessa de dia nenhum.
 */
export function somarDiasUteis(dia: string, dias: number): string {
  if (!Number.isInteger(dias) || dias < 0) {
    throw new TypeError(`Quantidade de dias úteis inválida: ${String(dias)}`);
  }
  let atual = diaDaLoja(dia);
  let restantes = dias;
  while (restantes > 0) {
    atual = somarDias(atual, 1);
    if (ehDiaUtil(atual)) restantes -= 1;
  }
  return atual;
}
