/**
 * O "FISCAL INCOMPLETO" DA BUSCA DO PDV (P0 da Preço Justo).
 *
 * O DEFEITO: o produto sem NCM (ou sem CFOP, ou sem grupo tributário que
 * feche) entrava no carrinho sem nenhum sinal. A recusa só aparecia DEPOIS do
 * pagamento, na emissão da NFC-e — com o cliente já pago na frente do caixa, e
 * a venda saindo sem nota ou parada na fila fiscal.
 *
 * A REGRA NÃO É NOVA: é a da nota, lida mais cedo.
 *   - os campos do cadastro vêm de `problemasFiscaisDoCadastro`, a MESMA função
 *     que `validateNfce` chama item a item;
 *   - antes de conferir, o que o produto não declara é completado pelo grupo
 *     (`completarPeloGrupo`), exatamente como a emissão monta a nota — senão o
 *     balcão acusaria de incompleto o produto que o grupo resolve;
 *   - a tributação vem de `diagnosticarTributacao`, a mesma régua de
 *     `motivosDaTributacaoDaVenda` (só as faltas do tipo 'tributacao').
 *
 * O QUE SAI: só o NOME do campo que falta ('NCM', 'CFOP', 'origem', 'CEST',
 * 'tributação'). Nenhum valor, nenhuma alíquota, nenhum dado do certificado
 * ou do CSC — o operador precisa saber QUE falta e a quem pedir, não a
 * configuração fiscal da empresa.
 *
 * QUANDO NÃO SE PERGUNTA: operação sem CNPJ na configuração fiscal não emite
 * NFC-e (o painel do PDV já diz "não configurado"). Marcar todo o catálogo
 * como incompleto ali seria ruído que o caixa aprende a ignorar — e aí ignora
 * também quando a loja começar a emitir.
 */
import { getFiscalConfig } from './FiscalConfigService.js';
import { problemasFiscaisDoCadastro, type NfceSale } from './FiscalXmlNfce.js';
import { completarPeloGrupo, diagnosticarTributacao } from './TributacaoDoItem.js';

export type PendenciaFiscal = 'NCM' | 'CFOP' | 'origem' | 'CEST' | 'tributação';

const texto = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

/**
 * As pendências fiscais de cada linha da busca, pelo id do produto. Linha sem
 * pendência (ou operação que não emite) devolve lista vazia.
 */
export function pendenciasFiscaisDoBalcao(
  companyId: string,
  linhas: Record<string, unknown>[],
): Map<string, PendenciaFiscal[]> {
  const resultado = new Map<string, PendenciaFiscal[]>();
  for (const l of linhas) resultado.set(String(l.id), []);
  if (linhas.length === 0) return resultado;

  const config = getFiscalConfig(companyId);
  if (String(config.cnpj ?? '').replace(/\D/g, '').length !== 14) return resultado;

  // A venda de mentira que a emissão montaria com estes itens — só para
  // passar pela mesma completação do grupo. Nada disto é gravado.
  const venda: NfceSale = {
    id: 'balcao',
    number: 0,
    companyId,
    createdAt: new Date().toISOString(),
    subtotalCents: 0,
    discountCents: 0,
    surchargeCents: 0,
    totalCents: 0,
    changeCents: 0,
    customerId: null,
    customerDocument: null,
    customerName: null,
    payments: [],
    items: linhas.map((l) => {
      const preco = Number(l.effective_price_cents ?? l.price_cents ?? 0);
      return {
        productId: String(l.id),
        description: String(l.name ?? ''),
        quantity: 1,
        unitPriceCents: preco,
        discountCents: 0,
        totalCents: preco,
        ncm: texto(l.ncm),
        cest: texto(l.cest),
        cfop: texto(l.cfop),
        origin: texto(l.origin),
        unit: texto(l.unit),
        barcode: texto(l.barcode),
        internalCode: texto(l.internal_code),
        taxProfile: texto(l.tax_profile),
      };
    }),
  };

  const completa = completarPeloGrupo(venda, null);
  for (const item of completa.items) {
    const pendencias: PendenciaFiscal[] = problemasFiscaisDoCadastro(item).map((p) => p.campo);
    const diagnostico = diagnosticarTributacao({
      companyId,
      produto: {
        id: item.productId,
        description: item.description,
        taxProfile: item.taxProfile,
        origin: item.origin,
        cfop: item.cfop,
        ncm: item.ncm,
        cest: item.cest,
        totalCents: item.totalCents,
      },
    });
    if (diagnostico.faltas.some((f) => f.tipo === 'tributacao')) pendencias.push('tributação');
    resultado.set(item.productId, pendencias);
  }
  return resultado;
}
