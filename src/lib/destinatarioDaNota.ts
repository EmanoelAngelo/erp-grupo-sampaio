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

export interface RascunhoDoDestinatario {
  name: string;
  document: string;
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
    && f.street.trim()
    && f.number.trim()
    && f.district.trim()
    && f.cityName.trim()
    && /^\d{7}$/.test(f.cityIbge)
    && f.uf,
  );
}

/**
 * O corpo que a rota espera.
 *
 * `ieIndicator: '9'` — NÃO contribuinte: é o consumidor do balcão, e é o que
 * decide a tributação da operação. Quem vende para contribuinte com IE emite
 * por outro caminho (o pedido), onde a inscrição é cadastrada; oferecer o
 * campo aqui convidaria o balcão a declarar contribuinte sem a inscrição, que
 * a SEFAZ recusa.
 */
export function destinatarioParaEnvio(f: RascunhoDoDestinatario): DestinatarioDaDevolucao {
  return {
    document: f.document.replace(/\D/g, ''),
    name: f.name.trim(),
    ieIndicator: '9',
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
