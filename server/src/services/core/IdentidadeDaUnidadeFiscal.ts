/**
 * A IDENTIDADE DA UNIDADE VENDIDA NO DOCUMENTO — GAP-PRD-026.
 *
 * ## O defeito
 *
 * `core_product_units` guarda QUAL moto (chassi, motor, série), QUAL celular
 * (IMEI) saiu em cada venda — e nenhum documento lia isso. A NF-e e a NFC-e
 * saíam só com `<xProd>`, o cupom só com o nome do produto. O cabeçalho de
 * `ProductUnitService` jurava que a unidade "é o número que sai no documento
 * fiscal da venda"; não saía em lugar nenhum. O cliente da moto não emplacava
 * (o DETRAN pede a nota com o chassi) e a garantia do celular ficava sem lastro.
 *
 * ## O que este módulo faz
 *
 * É o LEITOR único que os documentos usam — XML da NF-e e da NFC-e, DANFE,
 * DANFCE e cupom da venda: quais unidades saíram por cada linha, e o texto que
 * as identifica. Um leitor só, para o papel e o XML nunca dizerem chassis
 * diferentes da mesma venda.
 *
 * ## Como a unidade é achada
 *
 * 1. Pela LINHA: `core_product_units.sale_item_id`, que a venda passou a
 *    carimbar (SalesService) — é a resposta exata, inclusive com o mesmo
 *    produto em duas linhas.
 * 2. Pela SAÍDA, para o que foi vendido antes do carimbo e para o pedido
 *    online: `exit_reference_type`/`exit_reference_id` + produto. Só vale
 *    quando UMA linha tem aquele produto — com duas, dizer qual chassi foi em
 *    qual linha seria sorteio, e sorteio em documento fiscal é pior que o
 *    silêncio.
 *
 * ## O leiaute
 *
 * `infAdProd` (informações adicionais do produto, até 500 caracteres, dentro do
 * `<det>`, depois do `<imposto>`) é o lugar que o leiaute 4.00 dá a esta
 * informação em qualquer mercadoria — NF-e e NFC-e. O grupo `veicProd` do
 * veículo novo, com os dados do RENAVAM, é outra coisa e mora em
 * `FichaDoVeiculo.ts`.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';

/** O que o documento conta de uma unidade. */
export interface UnidadeNoDocumento {
  unitId: string;
  serialNumber: string | null;
  imei: string | null;
  chassis: string | null;
  motorNumber: string | null;
  plate: string | null;
}

/** O limite do `infAdProd` no leiaute 4.00 (TString 1-500). */
export const LIMITE_INF_AD_PROD = 500;

interface LinhaDoDocumento {
  /** `core_sale_items.id` — nulo para linha que não é de venda (pedido online). */
  id: string | null;
  productId: string | null;
}

interface LinhaDaUnidade {
  id: string;
  product_id: string;
  sale_item_id: string | null;
  serial_number: string | null;
  imei: string | null;
  chassis: string | null;
  motor_number: string | null;
  plate: string | null;
}

function paraDocumento(u: LinhaDaUnidade): UnidadeNoDocumento {
  return {
    unitId: u.id,
    serialNumber: u.serial_number,
    imei: u.imei,
    chassis: u.chassis,
    motorNumber: u.motor_number,
    plate: u.plate,
  };
}

/**
 * As unidades de cada linha, na ordem das linhas.
 *
 * `origem` é por onde as unidades SAÍRAM: `sale` (balcão, pré-venda
 * convertida, checkout) ou `ecommerce_order` (pedido online). Devolve um
 * arranjo do mesmo tamanho de `linhas`; linha sem unidade recebe `[]`.
 */
export function unidadesPorLinha(
  companyId: string,
  origem: { tipo: 'sale' | 'ecommerce_order'; id: string },
  linhas: LinhaDoDocumento[],
): UnidadeNoDocumento[][] {
  ensureCoreSchema();
  const db = getConnection();
  const resultado: UnidadeNoDocumento[][] = linhas.map(() => []);
  if (linhas.length === 0) return resultado;

  const colunas = `id, product_id, sale_item_id, serial_number, imei, chassis, motor_number, plate`;

  // 1. Pela linha — o carimbo exato.
  const idsDasLinhas = linhas.map((l) => l.id).filter((v): v is string => Boolean(v));
  const vistas = new Set<string>();
  if (origem.tipo === 'sale' && idsDasLinhas.length > 0) {
    const marcadores = idsDasLinhas.map(() => '?').join(', ');
    const carimbadas = db
      .prepare(
        `SELECT ${colunas} FROM core_product_units
          WHERE company_id = ? AND sale_item_id IN (${marcadores})
          ORDER BY created_at, rowid`,
      )
      .all(companyId, ...idsDasLinhas) as unknown as LinhaDaUnidade[];
    for (const u of carimbadas) {
      const indice = linhas.findIndex((l) => l.id === u.sale_item_id);
      if (indice < 0) continue;
      resultado[indice].push(paraDocumento(u));
      vistas.add(u.id);
    }
  }

  // 2. Pela saída — venda antiga (sem carimbo) e pedido online.
  const pelaSaida = db
    .prepare(
      `SELECT ${colunas} FROM core_product_units
        WHERE company_id = ? AND exit_reference_type = ? AND exit_reference_id = ?
          AND status = 'sold'
        ORDER BY created_at, rowid`,
    )
    .all(companyId, origem.tipo, origem.id) as unknown as LinhaDaUnidade[];

  for (const u of pelaSaida) {
    if (vistas.has(u.id)) continue;
    // Carimbada para uma linha que não está neste documento: não é daqui.
    if (u.sale_item_id && idsDasLinhas.length > 0 && !idsDasLinhas.includes(u.sale_item_id)) continue;
    const doProduto = linhas
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.productId && l.productId === u.product_id);
    // Uma linha só com o produto: a unidade é dela. Duas ou mais: não se sabe.
    if (doProduto.length !== 1) continue;
    resultado[doProduto[0].i].push(paraDocumento(u));
    vistas.add(u.id);
  }

  return resultado;
}

/** A unidade tem alguma identidade registrada? */
export function temIdentidade(u: UnidadeNoDocumento): boolean {
  return Boolean(u.chassis || u.motorNumber || u.serialNumber || u.imei || u.plate);
}

/**
 * O texto de UMA unidade, na ordem que o balcão e o DETRAN leem: chassi
 * primeiro, depois motor, série, IMEI e placa. Só o que existe.
 */
export function identidadeLegivel(u: UnidadeNoDocumento): string {
  return [
    u.chassis ? `Chassi ${u.chassis}` : null,
    u.motorNumber ? `Motor ${u.motorNumber}` : null,
    u.serialNumber ? `Série ${u.serialNumber}` : null,
    u.imei ? `IMEI ${u.imei}` : null,
    u.plate ? `Placa ${u.plate}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Tira do texto o que o `TString` do leiaute não aceita: caractere fora de
 * espaço..ÿ (controle, emoji) e espaço nas pontas. Identidade é alfanumérica;
 * isto é a rede para o que alguém colou de outro sistema.
 */
function paraTString(texto: string): string {
  return texto
    .replace(/[^ -ÿ]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * O `infAdProd` da linha — ou nulo quando nenhuma unidade dela tem
 * identidade (unidade vendida antes de alguém ler o chassi).
 *
 * Não corta: identidade pela metade num documento fiscal é pior que a recusa.
 * Quem cuida do limite é `problemaDaIdentidadeNoItem`, antes do número.
 */
export function infAdProdDasUnidades(unidades: UnidadeNoDocumento[] | undefined): string | null {
  const identificadas = (unidades ?? []).filter(temIdentidade);
  if (identificadas.length === 0) return null;
  const texto = paraTString(identificadas.map(identidadeLegivel).join('; '));
  return texto || null;
}

/**
 * A recusa do limite, para a validação que roda ANTES de numerar.
 *
 * Linha com dezenas de celulares estoura os 500 caracteres; a nota sairia com
 * o texto cortado ou seria rejeitada no leiaute. A saída honesta é dizer a
 * quantidade e o caminho — uma linha por grupo menor de unidades.
 */
export function problemaDaIdentidadeNoItem(item: {
  description: string;
  unidades?: UnidadeNoDocumento[];
}): string | null {
  const texto = infAdProdDasUnidades(item.unidades);
  if (!texto || texto.length <= LIMITE_INF_AD_PROD) return null;
  const n = (item.unidades ?? []).filter(temIdentidade).length;
  return (
    `As identidades das ${n} unidades desta linha somam ${texto.length} caracteres, e o campo `
    + `do documento aceita ${LIMITE_INF_AD_PROD}. Venda estas unidades em linhas separadas `
    + '(menos unidades por linha) para cada uma sair identificada na nota.'
  );
}

/** A linha do XML, pronta para entrar no `<det>` depois do `<imposto>`. */
export function infAdProdXml(
  unidades: UnidadeNoDocumento[] | undefined,
  escape: (v: string) => string,
): string {
  const texto = infAdProdDasUnidades(unidades);
  return texto ? `\n      <infAdProd>${escape(texto)}</infAdProd>` : '';
}
