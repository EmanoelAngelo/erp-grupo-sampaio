/**
 * Reler as notas de entrada já recebidas (GAP-PRD-181).
 *
 * O XML guardado de cada nota é lido de novo pelo parser atual: o fornecedor
 * ganha o que está em branco no cadastro (IE, endereço, IBGE), os itens ganham
 * CEST, origem e a tributação declarada, as sugestões de classificação nascem
 * para as notas anteriores ao recurso, e o produto que se prova nascido da nota
 * passa a dizer que o NCM veio do XML. Nada é confirmado sozinho.
 */
import { apiRequest } from './client';

export interface ResultadoDaReleitura {
  notasLidas: number;
  notasSemArquivo: number;
  notasIlegiveis: number;
  /** De homologação numa empresa em produção: sem validade fiscal, ficam de fora (R3-DFE). */
  notasSemValidadeFiscal?: number;
  fornecedoresCompletados: number;
  itensCompletados: number;
  sugestoesNovas: number;
  procedenciasCorrigidas: number;
  /*
    O DEFEITO (B-estoque-entrada-04, tela): o servidor passou a completar o
    fator de conversão das notas antigas e a recontar o pedido de compra
    amarrado a elas, e devolve as duas contagens — mas o tipo não as tinha, e
    a frase não as dizia. O gestor rodava a releitura justamente para
    consertar as caixas contadas como unidades e saía sem saber se as notas
    antigas ganharam o fator.

    Opcionais porque a frase só afirma o que o servidor contou: sem o número,
    ela não inventa "0 linha(s)".
  */
  /** Linhas de nota RECEBIDA que ganharam agora o fator de conversão. */
  fatoresCompletados?: number;
  /** Pedidos de compra amarrados a essas notas, recontados com o fator. */
  pedidosRecalculados?: number;
}

export const releituraDoXmlApi = {
  reler: () =>
    apiRequest<ResultadoDaReleitura>('/core/fiscal/classification/reler-notas', { method: 'POST' }),
};

/** O que a releitura achou, numa frase para quem clicou. */
export function fraseDaReleitura(r: ResultadoDaReleitura): string {
  const partes = [
    `${r.notasLidas} nota(s) relida(s): ${r.sugestoesNovas} sugestão(ões) nova(s), `
      + `${r.fornecedoresCompletados} fornecedor(es) com o cadastro completado, `
      + `${r.itensCompletados} item(ns) com CEST, origem ou tributos completados e `
      + `${r.procedenciasCorrigidas} produto(s) com a procedência do XML reconhecida.`,
  ];
  // Dito também quando é zero: "0 linha(s) ganharam o fator" é a resposta de
  // quem queria saber se a releitura ainda achou nota antiga sem o fator.
  // Cada contagem só entra se o servidor a mandou — com `?? 0`, a resposta que
  // trouxesse só uma delas fazia a frase afirmar um "0" que ninguém contou.
  const trechosDoFator = [
    typeof r.fatoresCompletados === 'number'
      ? `${r.fatoresCompletados} linha(s) ganharam o fator de conversão`
      : null,
    typeof r.pedidosRecalculados === 'number'
      ? `${r.pedidosRecalculados} pedido(s) de compra recontado(s)`
      : null,
  ].filter((t): t is string => t !== null);
  if (trechosDoFator.length > 0) partes.push(`${trechosDoFator.join('; ')}.`);
  if (r.notasSemArquivo > 0) {
    partes.push(
      `${r.notasSemArquivo} nota(s) antiga(s) sem o arquivo guardado não têm o que reler.`,
    );
  }
  if (r.notasIlegiveis > 0) {
    partes.push(`${r.notasIlegiveis} nota(s) com o XML ilegível ficaram de fora.`);
  }
  if ((r.notasSemValidadeFiscal ?? 0) > 0) {
    partes.push(
      `${r.notasSemValidadeFiscal} nota(s) de homologação (sem validade fiscal) ficaram de fora — a empresa está em produção.`,
    );
  }
  return partes.join(' ');
}
