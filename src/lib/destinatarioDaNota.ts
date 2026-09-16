/**
 * O DESTINATÁRIO DE UMA NF-e — o rascunho, a régua e o corpo (P0 fiscal).
 *
 * As funções puras do formulário `DestinatarioDaNota`, aqui e não lá, porque
 * módulo que exporta componente E função perde o recarregamento rápido do Vite
 * (a regra `react-refresh/only-export-components`) — e porque esta régua é
 * testável sem montar tela nenhuma.
 *
 * Por que o endereço é PERGUNTADO e não deduzido está escrito no componente: a
 * loja não tem o endereço de quem compra no balcão, e inventá-lo seria pôr
 * dado falso numa nota fiscal.
 */
import type { DestinatarioDaDevolucao } from '@/lib/api/core';

/** 1 contribuinte com IE, 2 contribuinte isento, 9 não contribuinte. */
export type IndicadorDeIe = '1' | '2' | '9';

export interface RascunhoDoDestinatario {
  name: string;
  document: string;
  /**
   * A CONDIÇÃO FISCAL DE QUEM RECEBE — o campo que não tinha escritor.
   *
   * O DEFEITO: `destinatarioParaEnvio` cravava '9' (não contribuinte) e o
   * formulário não perguntava nada. Toda nota das telas novas saía com
   * indIEDest 9 e indFinal 1, inclusive para CNPJ — e o caso de uso declarado
   * da NF-e de balcão é justamente o cliente PJ, que costuma ser CONTRIBUINTE
   * com inscrição. Para ele a nota saía declarando a operação errada, e não
   * havia caminho nenhum no sistema para emiti-la certa.
   */
  ieIndicator: IndicadorDeIe;
  /** A inscrição estadual, só dígitos (no RS, o CGC/TE). Vazia sem contribuinte. */
  ie: string;
  /**
   * A mercadoria é para USO/CONSUMO do destinatário (indFinal 1) e não para
   * revenda (indFinal 0)? Só se pergunta ao contribuinte: não contribuinte é
   * sempre consumidor final, e a SEFAZ recusa o contrário.
   */
  consumidorFinal: boolean;
  street: string;
  number: string;
  complement: string;
  district: string;
  cityName: string;
  cityIbge: string;
  uf: string;
  zip: string;
}

/** O rascunho vazio, ou com o que a loja já sabe sobre quem comprou. */
export function rascunhoDoDestinatario(
  sugerido?: { name: string; document: string } | null,
): RascunhoDoDestinatario {
  return {
    name: sugerido?.name ?? '',
    document: sugerido?.document ?? '',
    // O balcão é, na esmagadora maioria, consumidor: é o padrão que erra menos.
    // Quem muda para contribuinte está declarando, e aí a inscrição é cobrada.
    ieIndicator: '9',
    ie: '',
    consumidorFinal: true,
    street: '',
    number: '',
    complement: '',
    district: '',
    cityName: '',
    cityIbge: '',
    uf: '',
    zip: '',
  };
}

/** CPF tem 11 dígitos; CNPJ, 14. Qualquer outro tamanho é digitação pela metade. */
export function documentoDoDestinatarioConfere(valor: string): boolean {
  const digitos = valor.replace(/\D/g, '');
  return digitos.length === 11 || digitos.length === 14;
}

/**
 * A INSCRIÇÃO ESTADUAL VAI SÓ COM DÍGITOS na nota (no RS, o CGC/TE).
 *
 * "ISENTO" não é inscrição: destinatário isento usa o indicador 2. O servidor
 * recusa o contrário (`validateRecipient`), e perguntar aqui é não gastar uma
 * ida ao servidor por um campo que a tela já sabe julgar.
 */
export function inscricaoEstadualConfere(f: RascunhoDoDestinatario): boolean {
  return f.ieIndicator !== '1' || /\d/.test(f.ie);
}

/**
 * O formulário está completo para EMITIR?
 *
 * Tudo o que a validação do servidor cobra antes de numerar. Perguntar aqui
 * não é desconfiar dela: é não deixar o clique gastar uma ida ao servidor (e
 * um susto) por um campo em branco.
 */
export function destinatarioCompleto(f: RascunhoDoDestinatario): boolean {
  return Boolean(
    f.name.trim()
    && documentoDoDestinatarioConfere(f.document)
    && inscricaoEstadualConfere(f)
    && f.street.trim()
    && f.number.trim()
    && f.district.trim()
    && f.cityName.trim()
    && /^\d{7}$/.test(f.cityIbge)
    && f.uf,
  );
}

/**
 * A NOTA PARA OUTRA UF SAI SEM O DIFAL — e a tela tem de dizer isso ANTES do
 * clique (P0 fiscal).
 *
 * Na saída para consumidor final NÃO contribuinte de outra UF (indIEDest 9,
 * idDest 2) o leiaute pede o grupo ICMSUFDest (o diferencial de alíquota e o
 * FCP da UF de destino), e o sistema NÃO o monta: a alíquota interna do
 * destino e a decisão de o Simples recolher o DIFAL naquela UF são do
 * contador, e não existem no cadastro. A pendência já é declarada em Fiscal ›
 * Operações fiscais; aqui ela aparece onde se clica, que é onde o estrago
 * aconteceria.
 *
 * `null` quando não se aplica — ou quando a tela ainda não sabe a UF do
 * emitente, caso em que prometer o aviso seria pior do que não dá-lo.
 */
export function avisoDoDifal(
  f: RascunhoDoDestinatario,
  ufDoEmitente: string | null | undefined,
): string | null {
  const destino = f.uf.trim().toUpperCase();
  const origem = String(ufDoEmitente ?? '').trim().toUpperCase();
  if (!origem || !destino || origem === destino) return null;
  if (f.ieIndicator === '1') return null;
  return (
    `Venda para ${destino}, fora do estado do emitente (${origem}), a destinatário `
    + `${f.ieIndicator === '2' ? 'isento' : 'não contribuinte'}: a nota sai SEM o grupo ICMSUFDest `
    + '(DIFAL e FCP da UF de destino), que o sistema não monta — a alíquota interna do destino e a '
    + 'decisão de o Simples recolher o DIFAL ali são do contador. Confirme com ele antes de emitir; '
    + 'a pendência está em Fiscal › Operações fiscais.'
  );
}

/**
 * O corpo que a rota espera.
 *
 * O indicador de IE é o que declara a condição fiscal do destinatário e decide
 * a tributação da operação — por isso ele vem do formulário, e não de um
 * literal escrito aqui. A inscrição só acompanha o contribuinte (indicador 1):
 * mandá-la junto do isento ou do consumidor seria dizer duas coisas
 * contraditórias na mesma nota.
 *
 * `consumidorFinal` só é declarado para o contribuinte: o não contribuinte é
 * sempre consumidor final, e o servidor recusa a contradição.
 */
export function destinatarioParaEnvio(f: RascunhoDoDestinatario): DestinatarioDaDevolucao {
  return {
    document: f.document.replace(/\D/g, ''),
    name: f.name.trim(),
    ieIndicator: f.ieIndicator,
    ie: f.ieIndicator === '1' ? f.ie.replace(/\D/g, '') : null,
    consumidorFinal: f.ieIndicator === '9' ? null : f.consumidorFinal,
    street: f.street.trim(),
    number: f.number.trim(),
    complement: f.complement.trim() || null,
    district: f.district.trim(),
    cityName: f.cityName.trim(),
    cityIbge: f.cityIbge,
    uf: f.uf,
    zip: f.zip.replace(/\D/g, '') || null,
  };
}
