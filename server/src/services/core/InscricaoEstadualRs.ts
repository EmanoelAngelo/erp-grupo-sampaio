/**
 * A INSCRIÇÃO ESTADUAL DO RIO GRANDE DO SUL — o CGC/TE (auditoria P0 da Preço Justo).
 *
 * No RS a inscrição estadual se chama CGC/TE (Cadastro Geral de Contribuintes
 * de Tributos Estaduais) e é escrita 999/9999999: dez dígitos — três do
 * município, seis do contribuinte e um verificador.
 *
 * O verificador é módulo 11 sobre os nove primeiros, com os pesos 2, 9, 8, 7,
 * 6, 5, 4, 3, 2; resto que daria 10 ou 11 vira 0. É a conta publicada pela
 * SEFAZ-RS no roteiro do Sintegra.
 *
 * A CONTA NÃO REESCREVE O NÚMERO: a barra é só formatação. Quem guarda é o
 * cadastro, como foi digitado; o XML já leva só os dígitos.
 */
const PESOS = [2, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export function ieDoRsConfere(ie: string | null | undefined): boolean {
  const digitos = String(ie ?? '').replace(/\D/g, '');
  if (digitos.length !== 10) return false;
  const soma = PESOS.reduce((acc, peso, i) => acc + peso * Number(digitos[i]), 0);
  const conta = 11 - (soma % 11);
  const verificador = conta >= 10 ? 0 : conta;
  return verificador === Number(digitos[9]);
}
