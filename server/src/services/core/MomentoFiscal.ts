/**
 * QUANDO ESTA NOTA FOI EMITIDA — a pergunta com uma resposta só.
 *
 * ============================================================================
 * POR QUE ISTO EXISTE
 * ============================================================================
 *
 * Dois lugares respondiam essa pergunta, e respondiam diferente.
 *
 * O `dhEmi` do XML nascia assim:
 *
 *     issuedAt.toISOString().replace(/\.\d{3}Z$/, '-03:00')
 *
 * `toISOString()` devolve o relógio de Greenwich. Trocar o `Z` por `-03:00` não
 * converte nada — apenas renomeia aquele relógio, afirmando que ele é local. E
 * "14:00 em Greenwich" e "14:00 em Pelotas" são instantes diferentes, com três
 * horas entre eles. Uma nota emitida às 14h saía declarando um instante três
 * horas no FUTURO, e a SEFAZ recusa toda nota com data de emissão posterior ao
 * horário de recebimento. Não era uma nota: era o dia inteiro.
 *
 * A chave de acesso, por sua vez, tirava o AAMM de `getFullYear()`/`getMonth()`
 * — o fuso da MÁQUINA do servidor, que não é nem Greenwich nem necessariamente
 * o da loja. Na venda das 22h do dia 31, a chave dizia agosto e o `dhEmi` dizia
 * setembro. Chave incoerente com a emissão também é rejeição, com o número da
 * nota já queimado.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * O emitente é quem define o relógio, e o emitente é identificado pela UF. O
 * Brasil tem quatro deslocamentos e **nenhum horário de verão desde 2019**, o
 * que torna a tabela abaixo estável — se o horário de verão voltar, este é o
 * arquivo que muda, e só ele.
 *
 * As duas respostas saem juntas, do mesmo cálculo, porque o defeito nasceu
 * exatamente de elas saírem separadas.
 */

/**
 * Deslocamento de cada UF em relação a Greenwich, em horas.
 *
 * Fernando de Noronha (−02:00) não está aqui porque não é UF: pertence a
 * Pernambuco, e uma nota emitida lá declara PE. Quem precisar dela um dia terá
 * de decidir pelo município, não pela sigla do estado.
 */
export const UF_OFFSET_HORAS: Record<string, number> = {
  // Acre e o oeste do Amazonas: UTC−5.
  AC: -5,
  // Amazônia ocidental e Centro-Oeste: UTC−4.
  AM: -4, RR: -4, RO: -4, MT: -4, MS: -4,
  // O resto do país: UTC−3.
  AP: -3, PA: -3, TO: -3, MA: -3, PI: -3, CE: -3, RN: -3, PB: -3, PE: -3,
  AL: -3, SE: -3, BA: -3, MG: -3, ES: -3, RJ: -3, SP: -3, PR: -3, SC: -3,
  RS: -3, GO: -3, DF: -3,
};

/** Brasília, para UF que não esteja na tabela. */
const PADRAO_HORAS = -3;

export interface MomentoFiscal {
  /**
   * O instante da emissão no relógio do emitente, com o deslocamento dele.
   * Relido, dá exatamente o mesmo instante que entrou — é o que a SEFAZ confere.
   */
  dhEmi: string;
  /** O AAMM da chave de acesso, tirado do MESMO relógio do `dhEmi`. */
  aamm: string;
}

function pad(valor: number, tamanho = 2): string {
  return String(Math.abs(valor)).padStart(tamanho, '0');
}

/**
 * O instante da emissão, no fuso de quem emite.
 *
 * @param quando o instante real (o `Date` que o sistema já tem em mãos).
 * @param uf a sigla do emitente. Fora da tabela, vale Brasília — errar por uma
 * hora é ruim, mas declarar Greenwich seria errar por três e rejeitar tudo.
 */
export function momentoFiscal(quando: Date, uf: string): MomentoFiscal {
  const horas = UF_OFFSET_HORAS[String(uf ?? '').toUpperCase()] ?? PADRAO_HORAS;

  /*
    Deslocar o instante e depois LER pelos getters de UTC é o que produz o
    relógio de parede do emitente. Usar os getters locais aqui traria de volta o
    fuso da máquina do servidor — que é justamente o segundo relógio que esta
    função veio eliminar.
  */
  const parede = new Date(quando.getTime() + horas * 3_600_000);

  const ano = parede.getUTCFullYear();
  const mes = parede.getUTCMonth() + 1;
  const dia = parede.getUTCDate();
  const hh = parede.getUTCHours();
  const mm = parede.getUTCMinutes();
  const ss = parede.getUTCSeconds();

  const sinal = horas <= 0 ? '-' : '+';
  const deslocamento = `${sinal}${pad(horas)}:00`;

  return {
    dhEmi: `${ano}-${pad(mes)}-${pad(dia)}T${pad(hh)}:${pad(mm)}:${pad(ss)}${deslocamento}`,
    aamm: `${String(ano).slice(-2)}${pad(mes)}`,
  };
}
