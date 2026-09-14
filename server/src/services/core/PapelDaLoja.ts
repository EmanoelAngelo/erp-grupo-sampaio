/**
 * O PAPEL DA LOJA: A HORA DA LOJA E A LARGURA DA BOBINA DA LOJA.
 *
 * Duas perguntas que todo documento impresso responde — cupom HTML, cupom
 * ESC/POS, DANFCE, fechamento de caixa — e que cada um respondia por conta
 * própria, e errado.
 *
 * ## A hora
 *
 * O papel imprimia `new Date(iso).toLocaleString('pt-BR')`, SEM fuso. Isso é o
 * relógio da MÁQUINA do servidor, e não o da loja. A imagem Docker da API
 * (`node:24-alpine`, sem `TZ`) roda em UTC: a venda das 21:30 de 14/09 saía no
 * cupom como "15/09/2026, 00:30:00" — outro dia, e três horas adiantada. Na
 * troca da semana seguinte o papel não batia com o horário do caixa nem com o
 * relatório do dia. Rodando direto num Windows no fuso de Brasília a hora saía
 * certa — por acaso, e não por construção.
 *
 * O fuso sai da UF do emitente, a MESMA régua do `dhEmi` da nota
 * (`MomentoFiscal`): o cupom e a nota de uma venda não podem discordar sobre a
 * que horas ela aconteceu. O Intl do Node traz o banco de fusos embutido, então
 * isto funciona no alpine sem `tzdata`.
 *
 * ## A largura
 *
 * O cupom e o DANFCE eram fixos em 80 mm (`@page { size: 80mm auto }`), e a
 * largura cadastrada na impressora só chegava ao agente local. Uma térmica de
 * 58 mm pelo navegador recebia uma página de 74 mm: o driver cortava a coluna
 * da direita (valores, TOTAL, TROCO) ou encolhia tudo até ficar ilegível. E o
 * agente só reconhecia EXATAMENTE 58: quem cadastrasse 57 (a medida escrita na
 * bobina) ganhava 48 colunas numa impressora de 32.
 *
 * Bobina de cupom, no Brasil, é de 58 ou de 80 mm. Tudo abaixo de 70 é a
 * estreita; o resto, a larga.
 */

/** Fuso de cada UF que NÃO está no horário de Brasília — ver `MomentoFiscal.UF_OFFSET_HORAS`. */
const FUSO_DA_UF: Record<string, string> = {
  AC: 'America/Rio_Branco',
  AM: 'America/Manaus',
  RR: 'America/Boa_Vista',
  RO: 'America/Porto_Velho',
  MT: 'America/Cuiaba',
  MS: 'America/Campo_Grande',
};

/** Brasília: o fuso de todo o resto do país, e de loja sem UF cadastrada. */
export const FUSO_PADRAO_DA_LOJA = 'America/Sao_Paulo';

export function fusoDaLoja(uf?: string | null): string {
  return FUSO_DA_UF[String(uf ?? '').trim().toUpperCase()] ?? FUSO_PADRAO_DA_LOJA;
}

/**
 * Data e hora como o cliente lê no papel, no relógio da loja.
 *
 * Vazio para instante ausente ou ilegível: "Invalid Date" num cupom é pior que
 * a linha em branco.
 */
export function dataHoraDaLoja(iso: unknown, uf?: string | null): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { timeZone: fusoDaLoja(uf) });
}

export type LarguraDaBobina = 58 | 80;

/** A bobina que o papel deve assumir: 58 para tudo abaixo de 70 mm; 80 no resto (e sem cadastro). */
export function larguraDaBobina(mm: unknown): LarguraDaBobina {
  const n = Number(mm);
  return mm !== null && mm !== undefined && Number.isFinite(n) && n > 0 && n < 70 ? 58 : 80;
}

/** Colunas de texto que cabem na bobina, na fonte padrão da térmica. */
export function colunasDaBobina(mm: unknown): 32 | 48 {
  return larguraDaBobina(mm) === 58 ? 32 : 48;
}

/**
 * A largura que o CADASTRO de impressora de cupom aceita.
 *
 * 57 e 58 são a mesma bobina (a medida impressa na caixa e a nominal), 79 e 80
 * também. Qualquer outra medida numa impressora de cupom é erro de digitação —
 * 65 mm não existe — e gravá-la faria o papel escolher a largura sozinho.
 * `null` = sem medida (vale a de 80 mm); `undefined` = medida recusada.
 */
export function larguraDoCupomCadastrada(mm: unknown): LarguraDaBobina | null | undefined {
  if (mm === null || mm === undefined || mm === '') return null;
  const n = Number(mm);
  if (!Number.isFinite(n)) return undefined;
  if (n >= 56 && n <= 60) return 58;
  if (n >= 76 && n <= 82) return 80;
  return undefined;
}
