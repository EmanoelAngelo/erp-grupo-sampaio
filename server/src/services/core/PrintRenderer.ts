/**
 * Renderização dos documentos para papel.
 *
 * Produz HTML autocontido, com `@page` e medidas em milímetros. Serve para os
 * três destinos sem biblioteca extra: o navegador imprime, o próprio navegador
 * gera PDF ("Salvar como PDF"), e o agente local — quando existir — recebe o
 * mesmo HTML.
 *
 * Por que HTML e não PDF gerado no servidor: PDF exigiria dependência de
 * renderização, e o layout de cupom térmico é essencialmente texto em coluna
 * estreita. HTML resolve isso e ainda deixa o layout ajustável sem recompilar.
 *
 * IDENTIDADE: GRUPO SAMPAIO · Gestão Empresarial, sempre. O nome da operação
 * aparece como quem está vendendo.
 */
import { getConnection } from '../../db/sqlite.js';
import { renderServiceOrderA4 } from './ServiceOrderA4.js';
import { publicBaseUrl } from './PublicUrl.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { qrSvg } from './Qr.js';
import type { DocumentType } from './PrintEngine.js';
import { renderDanfce } from './DanfceRenderer.js';
import { renderDanfe } from './DanfeRenderer.js';
import { identidadeLegivel, temIdentidade, unidadesPorLinha } from './IdentidadeDaUnidadeFiscal.js';
import { buildLabels } from './BarcodeService.js';
import { renderLabelSheet } from './LabelSheet.js';
import { findLabelFormat } from './LabelFormats.js';
import { ROTULO_DA_PENDENCIA } from './PendenciasDoTurno.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';
import {
  exigirEmpresaComPlaquinha,
  formatTagId,
} from './EquipmentTagPoolService.js';
import { dataHoraDaLoja, larguraDaBobina } from './PapelDaLoja.js';

/** Escapa texto que vai para o HTML — nome de produto pode conter `<`. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brl(cents: unknown): string {
  return (Number(cents ?? 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/*
  A HORA DO PAPEL É A DA LOJA (auditoria do cupom, F-08).

  Era `new Date(iso).toLocaleString('pt-BR')`, sem fuso: o relógio da máquina
  do servidor. No contêiner da API (alpine, UTC) a venda das 21:30 saía no
  papel às 00:30 do dia seguinte. O fuso agora sai da UF do cadastro fiscal —
  a mesma régua do `dhEmi` da nota — e Brasília quando não há cadastro.
*/
function dataHora(iso: unknown, uf?: string | null): string {
  return dataHoraDaLoja(iso, uf);
}

/** Papel de cupom: 80mm, fonte monoespaçada, sem margem lateral. */
/**
 * O CABEÇALHO DO PAPEL QUE O CLIENTE LEVA.
 *
 * Estava ao contrário: `<h1>GRUPO SAMPAIO</h1>` em 13px com a loja numa linha
 * de 10px embaixo — a holding 30% maior que a empresa que efetivamente vendeu.
 * Quem lê o cupom na semana seguinte precisa saber em qual das seis lojas
 * comprou; a holding não troca peça nem atende telefone.
 *
 * O grupo continua no papel, como sobrenome, porque é ele que responde pelo
 * conjunto.
 */
function cabecalhoDoCupom(c: DadosDaEmpresa): string {
  const linhas = [
    c.cnpj ? `CNPJ ${esc(c.cnpj)}` : '',
    c.endereco ? esc(c.endereco) : '',
    c.phone ? `Fone ${esc(c.phone)}` : '',
  ].filter(Boolean);

  return `<p class="grupo">GRUPO SAMPAIO</p>
     <h1>${esc(c.trade_name)}</h1>
     ${linhas.length > 0 ? `<p class="sub">${linhas.join('<br>')}</p>` : ''}`;
}

/*
  A BOBINA É A DA IMPRESSORA, E NÃO SEMPRE A DE 80 mm (auditoria do cupom, F-07).

  O papel era fixo: `@page { size: 80mm auto }` e corpo de 74 mm. Uma térmica
  de 58 mm pelo navegador (o caminho padrão da loja) recebia uma página mais
  larga que a bobina, e o driver cortava a coluna da direita — justamente
  valores, TOTAL e TROCO — ou encolhia tudo até ficar ilegível. Cadastrar a
  impressora como 58 mm não mudava nada: a largura só chegava ao agente.

  Agora quem enfileira passa a largura da impressora escolhida, e o papel se
  mede por ela. Sem largura, continua o de 80 mm de sempre.
*/
function cupomShell(titulo: string, corpo: string, larguraMm?: unknown): string {
  const largura = larguraDaBobina(larguraMm);
  const estreita = largura === 58;
  /*
    Na bobina de 58 mm a cabeça térmica imprime ~48 mm (384 pontos a 8/mm),
    centrados no papel. Margem de 2 mm dava um corpo de 54 mm — 3 mm além da
    cabeça de cada lado, e a coluna da direita (valores, TOTAL, TROCO) ainda
    saía cortada, que é o defeito que esta largura veio consertar. Margem de
    5 mm põe o corpo em 48 mm, dentro da faixa que imprime.
  */
  const margem = estreita ? 5 : 3;
  const util = largura - 2 * margem;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>
  @page { size: ${largura}mm auto; margin: ${margem}mm; }
  * { box-sizing: border-box; }
  body { width: ${util}mm; margin: 0; font-family: "Courier New", monospace; font-size: ${estreita ? '9.5px' : '11px'};
         line-height: 1.45; color: #000; }
  h1 { font-size: ${estreita ? '11px' : '13px'}; margin: 0 0 2mm; text-align: center; letter-spacing: .5px; }
  .grupo { text-align: center; font-size: ${estreita ? '8px' : '9px'}; letter-spacing: 1px; margin: 0 0 1mm; }
  .sub { text-align: center; font-size: ${estreita ? '8.5px' : '10px'}; margin-bottom: 3mm; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 0.6mm 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .b { font-weight: bold; }
  .total { font-size: ${estreita ? '12px' : '14px'}; font-weight: bold; }
  .tarja { border: 2px solid #000; padding: 1.5mm; margin-bottom: 2mm; text-align: center;
           font-weight: bold; text-transform: uppercase; }
  .aviso { border: 1px dashed #000; padding: 1mm; margin: 2mm 0; font-weight: bold; }
  .rodape { text-align: center; font-size: ${estreita ? '8px' : '9px'}; margin-top: 3mm; }
  @media screen { body { margin: 12px auto; padding: 8px; box-shadow: 0 0 0 1px #ccc; background: #fff; } }
</style></head><body>${corpo}</body></html>`;
}

/** Papel A4 para orçamento, pré-venda e OS. */
function a4Shell(titulo: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1f1b24; }
  header { border-bottom: 2px solid #4f1a6d; padding-bottom: 6mm; margin-bottom: 6mm; }
  .marca { font-size: 17px; font-weight: bold; color: #3b1453; letter-spacing: .3px; }
  .marca span { font-weight: normal; color: #5c5266; }
  h1 { font-size: 15px; margin: 4mm 0 0; color: #3b1453; }
  .meta { display: flex; gap: 10mm; flex-wrap: wrap; margin-top: 3mm; font-size: 11px; color: #5c5266; }
  table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .4px;
       color: #5c5266; border-bottom: 1px solid #d3ccdd; padding: 2mm 1mm; }
  td { padding: 2mm 1mm; border-bottom: 1px solid #e6e1ec; }
  .r { text-align: right; }
  .totais { margin-top: 5mm; display: flex; justify-content: flex-end; }
  .totais div { min-width: 60mm; }
  .linha { display: flex; justify-content: space-between; padding: 1.5mm 0; }
  .total { font-size: 15px; font-weight: bold; color: #3b1453;
           border-top: 2px solid #4f1a6d; padding-top: 2mm; }
  footer { margin-top: 10mm; font-size: 10px; color: #5c5266; }
  @media screen { body { max-width: 210mm; margin: 16px auto; padding: 14mm;
    box-shadow: 0 0 0 1px #e6e1ec; background: #fff; } }
</style></head><body>${corpo}</body></html>`;
}

/*
  O ENDEREÇO PÚBLICO MUDOU DE CASA (rodada 54).

  Ele morava aqui porque este era o único a usá-lo. Com a ordem de serviço
  saindo para `ServiceOrderA4` — que também precisa do endereço, para o QR —,
  ficar aqui fechava um CICLO de importação: o renderizador importava o
  documento e o documento importava o renderizador. Em ESM o ciclo não estoura
  na hora; ele deixa uma constante do outro lado vazia, e o erro aparece longe.

  A reexportação fica para quem já importava daqui não ter que mudar.
*/
export { publicBaseUrl, publicBaseUrlConfigurada } from './PublicUrl.js';

/*
  A `qrSvg` daqui virou `services/core/Qr.ts`.

  Eram três desenhos do mesmo símbolo — este, o do DANFCE e um no navegador.
  Três cópias divergem no dia em que uma muda, e num QR a divergência não
  aparece como layout torto: aparece como código que o celular não lê.
*/

export interface DadosDaEmpresa {
  trade_name: string;
  legal_name: string;
  cnpj: string | null;
  /** Endereço e telefone vêm do cadastro fiscal: é lá que eles moram. */
  endereco: string | null;
  phone: string | null;
  /** A UF do cadastro fiscal: é ela que diz o fuso da hora impressa. */
  uf: string | null;
}

/**
 * CNPJ como o cliente lê no papel, e não como o banco guarda.
 *
 * A expressão era `/D/g` — sem a barra invertida ela arrancava a LETRA "D", e
 * não os não-dígitos: um CNPJ gravado em formato misto ("12.345678/0001-90")
 * saía cru no papel. `\D` é o que se queria desde o começo.
 */
export function cnpjLegivel(bruto: string | null): string | null {
  const d = (bruto ?? '').replace(/\D/g, '');
  if (d.length !== 14) return bruto;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function company(companyId: string): DadosDaEmpresa {
  const row = getConnection()
    .prepare('SELECT trade_name, legal_name, cnpj FROM core_companies WHERE id = ?')
    .get(companyId) as
    | { trade_name: string; legal_name: string; cnpj: string | null }
    | undefined;

  if (!row) throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Operação não encontrada.', 404);

  /*
    O CUPOM PRECISA DIZER PARA ONDE VOLTAR.

    O cliente que quer trocar a peça na semana seguinte tem na mão um papel
    que não dizia nem o endereço nem o telefone da loja. Os dois existem no
    cadastro fiscal — a nota exige — e nenhum papel os lia.

    Pode não haver cadastro fiscal ainda: a loja funciona antes de emitir a
    primeira nota, e o cupom continua saindo sem as linhas.
  */
  const fiscal = getConnection()
    .prepare(
      'SELECT street, number, district, city_name, uf, phone FROM core_fiscal_configs WHERE company_id = ?',
    )
    .get(companyId) as
    | {
        street: string | null;
        number: string | null;
        district: string | null;
        city_name: string | null;
        uf: string | null;
        phone: string | null;
      }
    | undefined;

  const rua = [fiscal?.street, fiscal?.number].filter(Boolean).join(', ');
  const cidade = [fiscal?.district, fiscal?.city_name, fiscal?.uf].filter(Boolean).join(' · ');
  const endereco = [rua, cidade].filter(Boolean).join(' — ') || null;

  return {
    trade_name: row.trade_name,
    legal_name: row.legal_name,
    cnpj: cnpjLegivel(row.cnpj),
    endereco,
    phone: fiscal?.phone ?? null,
    uf: fiscal?.uf ?? null,
  };
}

/**
 * A LOJA COMO O PAPEL A DIZ, para quem monta papel FORA daqui
 * (F-cupom-fiscal-20#reauditoria).
 *
 * O DEFEITO: o comprovante que o PDV monta sozinho na venda offline saía só
 * com o nome fantasia — sem CNPJ e sem endereço —, porque a sessão do
 * navegador não conhece nem um nem outro e nenhuma resposta do servidor os
 * entregava. O cliente levava um papel que não dizia de qual CNPJ comprou nem
 * para onde voltar, justamente no dia em que ele é o único papel da venda.
 *
 * É a MESMA leitura do cabeçalho do cupom (`company`): CNPJ pela mesma régua,
 * endereço e telefone do cadastro fiscal. Duas leituras fariam o comprovante
 * offline e o cupom do servidor dizerem lojas diferentes.
 */
export function empresaDoPapel(companyId: string): DadosDaEmpresa {
  return company(companyId);
}

function cabecalhoA4(companyId: string, titulo: string, meta: string[]): string {
  const c = company(companyId);
  return `<header>
    <p class="marca">GRUPO SAMPAIO <span>· Gestão Empresarial</span></p>
    <h1>${esc(titulo)}</h1>
    <div class="meta">
      <span><strong>${esc(c.trade_name)}</strong></span>
      ${c.cnpj ? `<span>CNPJ ${esc(c.cnpj)}</span>` : ''}
      ${meta.map((m) => `<span>${m}</span>`).join('')}
    </div>
  </header>`;
}

// ------------------------------------------------------------------- venda

/**
 * O meio de pagamento como o cliente lê. O banco guarda o código ('debito');
 * o papel diz "Cartão de débito". Código desconhecido sai como veio.
 */
const ROTULO_DO_MEIO: Record<string, string> = {
  dinheiro: 'Dinheiro', pix: 'PIX', debito: 'Cartão de débito', credito: 'Cartão de crédito',
  crediario: 'Crediário', vale: 'Vale', boleto: 'Boleto', transferencia: 'Transferência',
};
export function rotuloDoMeio(metodo: string): string {
  return ROTULO_DO_MEIO[metodo] ?? metodo;
}

/** Unidade de medida que o papel mostra: só quando não é a unidade comum. */
const UNIDADES_COMUNS = new Set(['', 'UN', 'UND', 'UNID', 'UNIDADE']);

/**
 * Quantidade como o cliente lê: "0,5", "1,25", "2".
 *
 * Saía `esc(i.quantity)` — o número do JavaScript, com PONTO ("0.5 x R$ 19,90")
 * —, enquanto todo o resto do papel fala pt-BR. Três casas bastam: é a
 * precisão com que a balança pesa.
 */
export function quantidadeLegivel(quantidade: unknown): string {
  const n = Number(quantidade ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : String(quantidade ?? '');
}

export interface LinhaDoCupom {
  descricao: string;
  /** Chassi, motor, IMEI — a unidade que saiu por esta linha (GAP-PRD-026). */
  identidades: string[];
  /** Quantidade como o cliente lê ("0,5"). */
  quantidade: string;
  /** "KG", "M"... Nula para a unidade comum, que não precisa ser dita. */
  unidade: string | null;
  unitarioCents: number;
  /** Quantidade × unitário, como o banco fechou: total líquido + desconto do item. */
  brutoCents: number;
  descontoCents: number;
  totalCents: number;
}

export interface MeioDoCupom {
  rotulo: string;
  valorCents: number;
  /** Pagamento que a venda aceitou sem o dinheiro ter caído (PIX "receber depois"). */
  pendente: boolean;
  /** Linha que o cliente precisa ler de longe (A PRAZO). */
  destaque: boolean;
}

/**
 * O CUPOM DA VENDA, EM DADOS — a única leitura, para os dois transportes.
 *
 * O cupom HTML (navegador) e o ESC/POS (agente local) liam as tabelas cada um
 * por conta própria, e o ESC/POS lia MENOS: sem unitário, sem desconto, sem
 * acréscimo, sem subtotal, sem troco, com o código cru do meio ("credito") e o
 * CNPJ como o banco guarda (auditoria do cupom, F-06). O mesmo papel, visto
 * por dois transportes, dizia duas coisas diferentes. Agora os dois desenham
 * ESTA estrutura, e o que um mostra o outro mostra.
 */
export interface DadosDoCupom {
  empresa: DadosDaEmpresa;
  numero: number;
  /** A hora da venda no relógio da loja. */
  quando: string;
  cancelada: boolean;
  /** Quando foi cancelada, no relógio da loja (vazio se não se sabe). */
  canceladaEm: string;
  itens: LinhaDoCupom[];
  subtotalCents: number;
  descontoCents: number;
  acrescimoCents: number;
  totalCents: number;
  /** Meios de pagamento, o vale e a parte a prazo — somados, dão o TOTAL (mais o troco). */
  meios: MeioDoCupom[];
  /** Quanto dos meios ainda não foi confirmado (PIX pendente). */
  aReceberCents: number;
  trocoCents: number;
}

export function dadosDoCupom(companyId: string, saleId: string): DadosDoCupom {
  ensureCoreSchema();
  const db = getConnection();
  const sale = db
    .prepare('SELECT * FROM core_sales WHERE id = ? AND company_id = ?')
    .get(saleId, companyId) as Record<string, unknown> | undefined;
  if (!sale) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);

  const itens = db
    .prepare(
      `SELECT i.*, p.unit AS unidade_do_produto
         FROM core_sale_items i
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE i.sale_id = ?
        ORDER BY i.rowid`,
    )
    .all(saleId) as unknown as Record<string, unknown>[];
  /*
    O STATUS DO PAGAMENTO VAI PARA O PAPEL (auditoria do cupom, F-13).

    O PIX "receber depois" fecha a venda com a linha `pending` — decisão de
    negócio, a mercadoria sai contra ele. O cupom lia só método e valor, e
    imprimia "PIX R$ 120,00" igual a um PIX pago: se o dinheiro não caísse, o
    cliente tinha na mão um papel da loja dizendo que pagou.
  */
  const pagamentos = db
    .prepare('SELECT method, amount_cents, status FROM core_sale_payments WHERE sale_id = ? ORDER BY rowid')
    .all(saleId) as unknown as { method: string; amount_cents: number; status: string | null }[];
  const c = company(companyId);

  /*
    A CONTA DA LINHA FECHA AOS OLHOS DO CLIENTE (auditoria, fase 7).

    O PDV manda o desconto do item, o banco guarda e a alçada mede — mas o
    papel mostrava "2 x R$ 19,90 ... R$ 36,80" sem uma palavra sobre os
    R$ 3,00 de diferença: a linha saía com o total LÍQUIDO e o desconto de
    item não era impresso em lugar nenhum (o rodapé só conhece o desconto de
    rodapé). Quem confere o cupom multiplica quantidade por unitário; o número
    ao lado tem que ser ESSE, e o abatimento tem que estar escrito.

    Agora a linha mostra o BRUTO e o desconto vira linha própria logo abaixo.
    O subtotal do rodapé é a soma dos líquidos (é assim que o SalesService o
    grava), então bruto − desconto de item = subtotal, centavo a centavo.

    O bruto sai de total + desconto — centavos inteiros que o banco já fechou.
    Multiplicar quantidade de novo aqui arredondaria por conta própria, e
    quantidade fracionada (0,5 kg) faria o papel discordar da venda.
  */
  /*
    QUAL MOTO, QUAL CELULAR (GAP-PRD-026).

    O cupom dizia "Moto Urbana 160" e só. A unidade vendida está carimbada na
    linha, e o cliente leva no papel o chassi, o motor e o IMEI — o mesmo texto
    que a nota fiscal leva no `infAdProd`, pelo mesmo leitor.
  */
  const unidades = unidadesPorLinha(
    companyId,
    { tipo: 'sale', id: saleId },
    itens.map((i) => ({ id: String(i.id), productId: (i.product_id as string | null) ?? null })),
  );

  const linhas: LinhaDoCupom[] = itens.map((i, indice) => {
    const descontoDaLinha = Number(i.discount_cents ?? 0);
    const totalDaLinha = Number(i.total_cents ?? 0);
    const unidade = String(i.unidade_do_produto ?? '').trim().toUpperCase();
    return {
      descricao: String(i.description ?? ''),
      identidades: unidades[indice].filter(temIdentidade).map((u) => identidadeLegivel(u)),
      quantidade: quantidadeLegivel(i.quantity),
      unidade: UNIDADES_COMUNS.has(unidade) ? null : unidade,
      unitarioCents: Number(i.unit_price_cents ?? 0),
      brutoCents: totalDaLinha + descontoDaLinha,
      descontoCents: descontoDaLinha,
      totalCents: totalDaLinha,
    };
  });

  /*
    VENDA SEM MEIO NENHUM É A PRAZO, E O PAPEL DIZ (GAP-PRD-104).

    A OS faturada para o cliente sai sem linha de pagamento — o total vira conta
    a receber. Sem esta linha o cupom mostraria o TOTAL e nada embaixo, e quem o
    lê entenderia "pago". O valor vem do TÍTULO em aberto, e não do total: a
    venda paga inteira com o vale também não tem meio, e não deve nada.
  */
  const aPrazo =
    pagamentos.length === 0
      ? (
          db
            .prepare(
              `SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS aberto
                 FROM core_finance_entries
                WHERE origin_type = 'sale' AND origin_id = ? AND direction = 'in'
                  AND status <> 'cancelled'`,
            )
            .get(saleId) as { aberto: number }
        ).aberto
      : 0;

  /*
    O VALE QUE PAGOU PARTE DA VENDA VAI PARA O PAPEL (auditoria do cupom, F-14).

    O crédito de loja não mora em `core_sale_payments` — não é instrumento de
    pagamento, é dívida extinta, e fica em `core_customer_credits` (kind
    'redeem'). O cupom só listava os meios: a venda de R$ 100 paga com R$ 30 de
    vale e R$ 70 em dinheiro saía "TOTAL R$ 100,00 / Dinheiro R$ 70,00", e
    cliente e caixa liam que faltaram R$ 30. É a mesma consulta da ficha da
    venda (`SalesService`, "QUANTO DESTA VENDA FOI PAGO COM VALE").
  */
  const vale = Math.abs(
    Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) AS usado
               FROM core_customer_credits
              WHERE company_id = ? AND kind = 'redeem'
                AND origin_type = 'sale' AND origin_id = ?`,
          )
          .get(companyId, saleId) as { usado: number }
      ).usado,
    ),
  );

  const meios: MeioDoCupom[] = pagamentos.map((p) => {
    const pendente = p.status === 'pending';
    return {
      rotulo: pendente ? `${rotuloDoMeio(p.method)} — aguardando confirmação` : rotuloDoMeio(p.method),
      valorCents: Number(p.amount_cents),
      pendente,
      destaque: false,
    };
  });
  if (vale > 0) {
    meios.push({ rotulo: 'Vale / crédito do cliente', valorCents: vale, pendente: false, destaque: false });
  }
  if (aPrazo > 0) {
    meios.push({ rotulo: 'A PRAZO — conta a receber', valorCents: aPrazo, pendente: false, destaque: true });
  }

  return {
    empresa: c,
    numero: Number(sale.number ?? 0),
    quando: dataHora(sale.created_at, c.uf),
    /*
      VENDA CANCELADA NÃO REIMPRIME COMO VÁLIDA (auditoria do cupom, F-19).

      O cupom não olhava `status`: a venda #340 cancelada e reimpressa saía com
      o mesmo TOTAL e os mesmos pagamentos, pronta para ser usada numa troca.
    */
    cancelada: String(sale.status) === 'cancelled',
    canceladaEm: dataHora(sale.cancelled_at, c.uf),
    itens: linhas,
    subtotalCents: Number(sale.subtotal_cents ?? 0),
    descontoCents: Number(sale.discount_cents ?? 0),
    acrescimoCents: Number(sale.surcharge_cents ?? 0),
    totalCents: Number(sale.total_cents ?? 0),
    meios,
    aReceberCents: meios.filter((m) => m.pendente).reduce((s, m) => s + m.valorCents, 0),
    trocoCents: Number(sale.change_cents ?? 0),
  };
}

function renderSale(companyId: string, saleId: string, larguraMm?: unknown): string {
  const d = dadosDoCupom(companyId, saleId);

  const linhas = d.itens
    .map((i) => {
      const identidades = i.identidades.map((t) => `<tr><td colspan="2">${esc(t)}</td></tr>`).join('');
      return `<tr>
        <td colspan="2">${esc(i.descricao)}</td></tr>${identidades}
      <tr><td>${esc(i.quantidade)}${i.unidade ? ` ${esc(i.unidade)}` : ''} x ${brl(i.unitarioCents)}</td>
        <td class="r b">${brl(i.brutoCents)}</td></tr>
      ${i.descontoCents > 0 ? `<tr><td>Desconto do item</td><td class="r">- ${brl(i.descontoCents)}</td></tr>` : ''}`;
    })
    .join('');

  const meios = d.meios
    .map(
      (m) =>
        `<tr${m.destaque ? ' class="b"' : ''}><td>${esc(m.rotulo)}</td><td class="r">${brl(m.valorCents)}</td></tr>`,
    )
    .join('');

  const tarja = d.cancelada
    ? `<div class="tarja">VENDA CANCELADA${d.canceladaEm ? ` em ${esc(d.canceladaEm)}` : ''}<br>Não vale como comprovante de compra</div>`
    : '';
  const aReceber =
    d.aReceberCents > 0
      ? `<p class="aviso">A RECEBER ${brl(d.aReceberCents)}: pagamento ainda não confirmado. Este papel não comprova o pagamento dessa parte.</p>`
      : '';

  return cupomShell(
    `Venda ${d.numero}`,
    `${tarja}${cabecalhoDoCupom(d.empresa)}
     <p style="text-align:center;font-weight:bold;margin:4px 0;letter-spacing:.5px">COMPROVANTE NÃO FISCAL</p>
     <hr>
     <table><tr><td>Venda</td><td class="r b">#${esc(d.numero)}</td></tr>
       <tr><td>Data</td><td class="r">${esc(d.quando)}</td></tr></table>
     <hr>
     <table>${linhas}</table>
     <hr>
     <table>
       <tr><td>Subtotal</td><td class="r">${brl(d.subtotalCents)}</td></tr>
       ${d.descontoCents > 0 ? `<tr><td>Desconto</td><td class="r">- ${brl(d.descontoCents)}</td></tr>` : ''}
       ${
         /*
           O ACRÉSCIMO É COBRADO, ENTÃO É IMPRESSO (auditoria, fase 7).

           Juros e frete entram na conta como total = subtotal − desconto +
           acréscimo, e a nota fiscal sabe declará-los (vOutro) — mas o cupom
           saía "Subtotal R$ 39,80 / TOTAL R$ 42,30" sem dizer de onde vieram
           os R$ 2,50 a mais que o cliente pagou. Total maior que o subtotal
           sem explicação não fecha aos olhos de ninguém.
         */
         d.acrescimoCents > 0 ? `<tr><td>Acréscimo</td><td class="r">+ ${brl(d.acrescimoCents)}</td></tr>` : ''
       }
       <tr class="total"><td>TOTAL</td><td class="r">${brl(d.totalCents)}</td></tr>
     </table>
     <hr>
     <table>${meios}
       ${d.trocoCents > 0 ? `<tr class="b"><td>TROCO</td><td class="r">${brl(d.trocoCents)}</td></tr>` : ''}
     </table>
     ${aReceber}
     <p class="rodape">Documento sem valor fiscal.<br>Obrigado pela preferência!</p>`,
    larguraMm,
  );
}

// -------------------------------------------------- orçamento e pré-venda

function renderQuote(companyId: string, quoteId: string): string {
  const db = getConnection();
  const quote = db
    .prepare('SELECT * FROM core_quotes WHERE id = ? AND company_id = ?')
    .get(quoteId, companyId) as Record<string, unknown> | undefined;
  if (!quote) throw new ApiError('CORE_QUOTE_NOT_FOUND', 'Documento não encontrado.', 404);

  const itens = db
    .prepare('SELECT * FROM core_quote_items WHERE quote_id = ?')
    .all(quoteId) as unknown as Record<string, unknown>[];

  const customerId = quote.customer_id ? String(quote.customer_id) : null;
  const cliente = customerId
    ? (db.prepare('SELECT name FROM core_customers WHERE id = ?').get(customerId) as
        | { name: string }
        | undefined)
    : undefined;

  const ehPreVenda = quote.kind === 'pre_venda';
  const titulo = `${ehPreVenda ? 'Pré-venda' : 'Orçamento'} nº ${quote.number}`;

  const linhas = itens
    .map(
      (i) => `<tr>
        <td>${esc(i.description)}</td>
        <td class="r">${esc(i.quantity)}</td>
        <td class="r">${brl(i.unit_price_cents)}</td>
        <td class="r">${brl(i.total_cents)}</td>
      </tr>`,
    )
    .join('');

  return a4Shell(
    titulo,
    `${cabecalhoA4(companyId, titulo, [
      `Emitido em ${dataHora(quote.created_at, company(companyId).uf)}`,
      quote.valid_until
        ? `Válido até ${new Date(String(quote.valid_until)).toLocaleDateString('pt-BR')}`
        : '',
      cliente ? `Cliente: ${esc(cliente.name)}` : 'Consumidor final',
    ].filter(Boolean))}
     <table>
       <thead><tr><th>Item</th><th class="r">Qtde</th><th class="r">Unitário</th><th class="r">Total</th></tr></thead>
       <tbody>${linhas}</tbody>
     </table>
     <div class="totais"><div>
       ${Number(quote.discount_cents) > 0 ? `<div class="linha"><span>Desconto</span><span>- ${brl(quote.discount_cents)}</span></div>` : ''}
       <div class="linha total"><span>Total</span><span>${brl(quote.total_cents)}</span></div>
     </div></div>
     ${quote.note ? `<p style="margin-top:6mm">${esc(quote.note)}</p>` : ''}
     <footer>
       ${
         ehPreVenda
           ? 'Pré-venda: a mercadoria está reservada até o vencimento acima. Não é documento fiscal.'
           : 'Orçamento: os valores acima valem até a data indicada e não reservam mercadoria. Não é documento fiscal.'
       }
     </footer>`,
  );
}

// ---------------------------------------------------------------- etiqueta

/*
  A ETIQUETA DA FILA DIZ O PREÇO QUE O CAIXA COBRA (auditoria PJ, C-etiquetas-17).

  O DEFEITO: este era um desenho próprio de 50 × 30 mm que imprimia
  `price_cents` cru — o preço de TABELA. Com a promoção valendo (R$ 49,90 →
  R$ 39,90), o job PRODUCT_LABEL colava R$ 49,90 na prateleira enquanto o PDV
  cobrava R$ 39,90. A folha de etiquetas (`buildLabels`) já usava o preço
  vigente, e os dois caminhos da mesma etiqueta discordavam. Era também uma
  segunda cópia do rolo 50 × 30, fixa e só EAN-13, divergindo da folha a cada
  mudança feita num lado só.

  Agora a fila entrega o MESMO papel da tela de etiquetas: o item sai de
  `buildLabels` (preço de `effectivePriceCents`, o "de / por" da promoção,
  título e atributos da grade, qualquer simbologia de código) e o desenho sai
  de `renderLabelSheet` no formato `rolo_50x30`. Duas escolhas de propósito:

  - `podeGerarCodigo: false` — imprimir pela fila não grava EAN no cadastro
    (a fila aceita caixa e atendente, que não cadastram produto). Produto sem
    código sai sem barras, com o aviso para gerar no cadastro.
  - NÃO `itemParaPrevia`: aquele serve à PRÉVIA. Sem produto ele devolve a
    amostra com o EAN de amostra, e para produto sem código promete "gerado
    ao imprimir". Numa impressão real o primeiro seria um código falso colado
    na peça, e o segundo uma promessa que ninguém cumpre.

  A segunda via deste papel NÃO reaproveita o payload congelado: ver
  `TIPOS_QUE_SEGUEM_O_CADASTRO` em PrintEngine.
*/
function renderProductLabel(companyId: string, productId: string): string {
  const formato = findLabelFormat('rolo_50x30');
  if (!formato) {
    throw new ApiError(
      'CORE_LABEL_FORMAT_NOT_FOUND',
      'O formato de etiqueta "Rolo 50 × 30 mm" não está disponível nesta versão do sistema. Use a tela de Etiquetas.',
      500,
    );
  }
  const itens = buildLabels(companyId, [{ productId, quantity: 1 }], {
    campos: formato.campos,
    podeGerarCodigo: false,
  });
  return renderLabelSheet({ format: formato, items: itens, companyId });
}

// ------------------------------------------------------ ordem de serviço

function renderWorkshopOrder(companyId: string, orderId: string): string {
  /*
    UM DOCUMENTO SO, e ele mora em ServiceOrderA4 (rodada 54).

    O desenho daqui lia "parts_total_cents" e "labor_total_cents" — colunas
    que NAO existem (sao "parts_cents" e "labor_cents") —, entao as duas
    linhas do bloco de valores nunca apareciam: o papel mostrava so o total,
    sem dizer quanto era peca e quanto era mao de obra. E nenhuma tela
    chamava este caminho, entao ninguem viu.

    A fila de impressao e a tela agora entregam o MESMO papel: dois desenhos
    divergiriam no primeiro campo que alguem mudasse num so.
  */
  return renderServiceOrderA4(companyId, orderId).html;
}

// -------------------------------------------------- fechamento de caixa

/**
 * O movimento da gaveta como o operador lê. O banco guarda o código
 * ('withdrawal'); o papel diz "Sangria". Código que o papel não conhece sai
 * dizendo isso, em vez de se passar por um dos conhecidos.
 */
const ROTULO_DO_MOVIMENTO: Record<string, string> = {
  opening: 'Abertura (fundo de troco)',
  sale: 'Vendas em dinheiro (já sem o troco)',
  sale_cancel: 'Vendas canceladas (devolvido)',
  sale_return: 'Devoluções em dinheiro',
  supply: 'Suprimento',
  withdrawal: 'Sangria',
  adjustment: 'Ajuste',
};
export function rotuloDoMovimento(tipo: string): string {
  return ROTULO_DO_MOVIMENTO[tipo] ?? `Movimento "${tipo}"`;
}

/**
 * Os movimentos que o papel lista UM A UM, com hora, quem e motivo: são os
 * lançados à mão, que o gestor confere contra o comprovante. Os automáticos
 * (vendas, cancelamentos) saem somados — o detalhe deles está na venda.
 */
const MOVIMENTOS_LINHA_A_LINHA = new Set(['supply', 'withdrawal', 'adjustment']);

/** Valor como a gaveta lê: "- R$ 180,00" para o que saiu. */
function brlComSinal(cents: unknown): string {
  const n = Number(cents ?? 0);
  return n < 0 ? `- ${brl(Math.abs(n))}` : brl(n);
}

function nomeDoUsuario(userId: unknown): string | null {
  if (!userId) return null;
  const r = getConnection()
    .prepare('SELECT display_name FROM core_users WHERE id = ?')
    .get(String(userId)) as { display_name?: string } | undefined;
  return r?.display_name ?? null;
}

/** O que `closeSession` grava em `closed_with_pending` (GAP-PRD-081). */
interface PendenciaDeclarada {
  motivo?: string;
  cientePor?: string;
  cienteEm?: string;
  totalCents?: number;
  cobrancas?: { tipo?: string; amountInCents?: number }[];
  pagamentosPendentes?: { method?: string; amountCents?: number; saleNumber?: number | null }[];
  /** GAP-PRD-045: o dinheiro DESTA está na gaveta, e a venda não existe. */
  vendasOffline?: { receivedCents?: number; label?: string | null; errorMessage?: string | null }[];
  /** Auditoria do PDV: o que a loja ainda deve ao cliente da devolução. */
  devolucoesAguardandoReembolso?: {
    number?: number;
    saleNumber?: number | null;
    pendenteCents?: number;
    /**
     * Quanto desta dívida estava, em espécie, NESTA gaveta. Ausente nos
     * registros gravados antes de P00-caixa-gaveta: aí não se sabe, e a frase
     * escolhida lá embaixo não afirma lugar nenhum.
     */
    naGavetaCents?: number;
  }[];
}

/**
 * O turno que fechou COM pendência diz isso no papel.
 *
 * O fechamento exige ciência e motivo, e grava o que estava pendente — mas o
 * papel não dizia nada, e a via assinada parecia a de um turno limpo. O gestor
 * que guarda o papel com o dinheiro precisa ler ali o que ficou para ele.
 *
 * ## O QUE ESTE BLOCO ESTAVA AFIRMANDO DE ERRADO (P00-caixa-divida)
 *
 * Medido pela verificação adversarial: num turno que fechou devendo R$ 50,00
 * de uma devolução ainda não paga, o papel saía «FECHADO COM PENDÊNCIA
 * ELETRÔNICA DE R$ 50,00 … Não está na gaveta: continua na fila do gestor.»
 * com a TABELA DE ITENS VAZIA. Duas afirmações falsas na mesma via assinada:
 *
 *   - não dizia QUE pendência era (a devolução não era enumerada, porque
 *     `closeSession` não a gravava — consertado junto com este bloco);
 *   - dizia que o valor NÃO está na gaveta. O reembolso em espécie ainda não
 *     pago está: ele foi contado no fechamento, entra no esperado e vai para o
 *     turno seguinte como se fosse dinheiro da loja. O mesmo vale para a venda
 *     guardada recusada, cujo dinheiro está na gaveta sem venda que o explique.
 *
 * Frase errada em documento assinado é pior do que documento nenhum: o gestor
 * que confere o turno pelo papel concluía o CONTRÁRIO do que a trava quis
 * dizer. Agora cada linha sai pelo nome, e a frase do rodapé é escolhida pelo
 * que a lista de fato contém.
 */
function blocoDasPendencias(registro: unknown, uf: string | null): string {
  if (!registro) return '';
  let p: PendenciaDeclarada | null;
  try {
    p = JSON.parse(String(registro)) as PendenciaDeclarada;
  } catch {
    p = null;
  }
  if (!p || typeof p !== 'object') {
    return `<div class="aviso">FECHADO COM PENDÊNCIA DECLARADA.<br>O registro dela não pôde ser lido: confira no histórico do caixa.</div>`;
  }
  const rotulos = ROTULO_DA_PENDENCIA as Record<string, string>;
  const cobrancas = p.cobrancas ?? [];
  const pagamentos = p.pagamentosPendentes ?? [];
  const offline = p.vendasOffline ?? [];
  const devolucoes = p.devolucoesAguardandoReembolso ?? [];
  const linhas = [
    ...cobrancas.map(
      (c) =>
        `<tr><td>${esc(rotulos[String(c.tipo)] ?? 'cobrança pendente')}</td><td class="r">${brl(c.amountInCents)}</td></tr>`,
    ),
    ...pagamentos.map(
      (pg) =>
        `<tr><td>${esc(rotuloDoMeio(String(pg.method ?? '')))} pendente, venda #${esc(pg.saleNumber ?? '?')}</td>`
        + `<td class="r">${brl(pg.amountCents)}</td></tr>`,
    ),
    ...offline.map(
      (v) =>
        '<tr><td>Venda guardada sem servidor e recusada (dinheiro na gaveta, sem venda)</td>'
        + `<td class="r">${brl(v.receivedCents)}</td></tr>`,
    ),
    ...devolucoes.map(
      (d) =>
        `<tr><td>Devolução #${esc(d.number ?? '?')} da venda #${esc(d.saleNumber ?? '?')}: ainda não devolvido ao cliente</td>`
        + `<td class="r">${brl(d.pendenteCents)}</td></tr>`,
    ),
  ].join('');
  /*
    ONDE O DINHEIRO ESTÁ — PERGUNTADO, NÃO SUPOSTO (P00-caixa-gaveta).

    O DEFEITO DA PRIMEIRA VERSÃO deste bloco: `naGaveta` somava TODA devolução
    pendente, então a frase passou a afirmar o lugar do dinheiro pela simples
    EXISTÊNCIA da dívida. Medido: venda de R$ 100,00 paga no CRÉDITO,
    devolução de R$ 50,00 em duas etapas, gaveta com esperado 10.000, contado
    10.000, diferença 0 — e o papel imprimia «ATENÇÃO: R$ 50,00 deste total
    ESTÁ na contagem desta gaveta». Era regressão: antes o mesmo papel dizia
    «Não está na gaveta», que para o cartão era verdade. O mesmo texto saía no
    turno seguinte para a dívida herdada, cuja gaveta nunca viu o dinheiro.

    Agora quem responde é `naGavetaCents`, que o turno calcula olhando o meio
    de pagamento da venda devolvida e a gaveta em que ela foi paga. A venda
    guardada e recusada continua inteira aqui: o dinheiro dela entrou NESTA
    gaveta, é o que a define.

    Registro legado (gravado antes deste conserto) não traz o campo. Aí a
    resposta honesta é não afirmar lugar nenhum — e é o que a terceira frase
    faz.
  */
  const naGaveta =
    offline.reduce((s, v) => s + Number(v.receivedCents ?? 0), 0)
    + devolucoes.reduce((s, d) => s + Number(d.naGavetaCents ?? 0), 0);
  const seSabeOndeEsta = devolucoes.every((d) => d.naGavetaCents !== undefined);
  const soEletronico = offline.length === 0 && devolucoes.length === 0;
  const cartaoOuPix = cobrancas.length + pagamentos.length > 0 ? 'Cartão e PIX não estão na gaveta: caem na conta. ' : '';
  const naFila = ' a pendência continua na fila do gestor.';
  let ondeEstaODinheiro: string;
  if (soEletronico) {
    ondeEstaODinheiro = 'Não está na gaveta: continua na fila do gestor.';
  } else if (!seSabeOndeEsta) {
    ondeEstaODinheiro =
      cartaoOuPix
      + 'Confira de onde sai cada reembolso antes de entregar o turno (este registro é anterior ao'
      + ' cálculo do que fica na gaveta);' + naFila;
  } else if (naGaveta > 0) {
    ondeEstaODinheiro =
      cartaoOuPix
      + `ATENÇÃO: ${brl(naGaveta)} deste total ESTÁ na contagem desta gaveta e NÃO é da loja`
      + (devolucoes.some((d) => Number(d.naGavetaCents ?? 0) > 0)
        ? ' (o cliente pagou em espécie nesta gaveta e ainda não recebeu de volta)'
        : '')
      + '. Confira antes de entregar o turno;' + naFila;
  } else {
    ondeEstaODinheiro =
      cartaoOuPix
      + 'Nada deste total está na contagem desta gaveta: o reembolso volta pelo meio da venda, ou'
      + ' entrou em gaveta de outro turno.' + naFila;
  }
  const quem = nomeDoUsuario(p.cientePor);
  const declarado =
    quem || p.cienteEm
      ? `<br>Declarado${quem ? ` por ${esc(quem)}` : ''}${p.cienteEm ? ` em ${esc(dataHora(p.cienteEm, uf))}` : ''}.`
      : '';
  return `<div class="aviso">FECHADO COM PENDÊNCIA${soEletronico ? ' ELETRÔNICA' : ''}${p.totalCents ? ` DE ${brl(p.totalCents)}` : ''}
     ${linhas ? `<table>${linhas}</table>` : ''}
     ${ondeEstaODinheiro}${p.motivo ? `<br>Motivo: ${esc(p.motivo)}` : ''}${declarado}
   </div>`;
}

/*
  O PAPEL DO FECHAMENTO (auditoria PJ, H-caixa-seguranca-11).

  O DEFEITO: o layout existia, mas imprimia os códigos do banco ("dinheiro",
  "opening", "withdrawal", "sale"), não dizia quem abriu, quem fechou nem qual
  caixa, somava as sangrias numa linha só, sem o motivo que a regra da sangria
  exige, e calava o fechamento com pendência declarada. E não conferia o
  estado: num turno ABERTO esperado, contado e diferença são nulos, a conta
  virava 0 e o papel dizia "CONFERIDO R$ 0,00" — uma conferência que não
  aconteceu, com espaço para assinatura.

  Agora: turno que não está fechado é recusado (409, dizendo o que fazer);
  meio e movimento saem com o rótulo que o balcão lê; abre com caixa, quem
  abriu e quem fechou; sangria, suprimento e ajuste saem um a um com hora,
  quem lançou e o motivo; o troco devolvido aparece como a ponte entre
  "dinheiro recebido" e "gaveta"; e a pendência declarada vai para o papel.
*/
function renderCashClosing(companyId: string, sessionId: string, larguraMm?: unknown): string {
  const db = getConnection();
  const sessao = db
    .prepare(
      `SELECT s.*, t.name AS nome_do_caixa
         FROM core_cash_sessions s
         LEFT JOIN core_terminals t ON t.id = s.terminal_id
        WHERE s.id = ? AND s.company_id = ?`,
    )
    .get(sessionId, companyId) as Record<string, unknown> | undefined;
  if (!sessao) throw new ApiError('CORE_CASH_NOT_FOUND', 'Caixa não encontrado.', 404);
  if (String(sessao.status) !== 'closed') {
    throw new ApiError(
      'CORE_CASH_CLOSING_NOT_CLOSED',
      'Este caixa ainda está aberto: o papel de fechamento só existe depois do fechamento. '
        + 'Conte a gaveta, confirme o fechamento do caixa e peça a impressão de novo.',
      409,
      { sessionId, status: sessao.status },
    );
  }

  const porMeio = db
    .prepare(
      // Mesmo filtro do `CashService.getSummary`, e pelo mesmo motivo: o papel
      // que o operador assina não pode somar pagamento que ainda não caiu.
      // Divergir daqui faria a via impressa contradizer a tela.
      `SELECT p.method AS method, COALESCE(SUM(p.amount_cents), 0) AS total
         FROM core_sale_payments p
         JOIN core_sales s ON s.id = p.sale_id
        WHERE s.cash_session_id = ? AND s.status = 'completed'
          AND p.status = 'settled'
        GROUP BY p.method
        ORDER BY p.method`,
    )
    .all(sessionId) as unknown as { method: string; total: number }[];

  // O troco do turno, com o mesmo filtro do `CashService.getSummary`: é a
  // ponte entre o dinheiro que o cliente entregou (acima) e o que ficou na gaveta.
  const troco = (
    db
      .prepare(
        `SELECT COALESCE(SUM(change_cents), 0) AS total
           FROM core_sales WHERE cash_session_id = ? AND status = 'completed'`,
      )
      .get(sessionId) as { total: number }
  ).total;

  const movimentos = db
    .prepare(
      `SELECT m.movement_type, m.amount_cents, m.note, m.created_at, u.display_name AS quem
         FROM core_cash_movements m
         LEFT JOIN core_users u ON u.id = m.user_id
        WHERE m.session_id = ?
        ORDER BY m.created_at, m.rowid`,
    )
    .all(sessionId) as unknown as {
    movement_type: string;
    amount_cents: number;
    note: string | null;
    created_at: string;
    quem: string | null;
  }[];

  const c = company(companyId);
  const diferenca = Number(sessao.difference_cents ?? 0);
  const abertoPor = nomeDoUsuario(sessao.opened_by);
  const fechadoPor = nomeDoUsuario(sessao.closed_by);

  // Os automáticos somados por tipo (na ordem em que apareceram: a abertura
  // vem primeiro); os lançados à mão, um a um.
  const somados = new Map<string, number>();
  const lancados: typeof movimentos = [];
  for (const m of movimentos) {
    if (MOVIMENTOS_LINHA_A_LINHA.has(m.movement_type)) lancados.push(m);
    else somados.set(m.movement_type, (somados.get(m.movement_type) ?? 0) + Number(m.amount_cents ?? 0));
  }
  const linhasDaGaveta = [
    ...[...somados].map(
      ([tipo, total]) => `<tr><td>${esc(rotuloDoMovimento(tipo))}</td><td class="r">${brlComSinal(total)}</td></tr>`,
    ),
    ...lancados.map((m) => {
      const detalhe = [dataHora(m.created_at, c.uf), m.quem, m.note].filter((v) => String(v ?? '').trim() !== '');
      return (
        `<tr><td>${esc(rotuloDoMovimento(m.movement_type))}</td><td class="r">${brlComSinal(m.amount_cents)}</td></tr>`
        + (detalhe.length > 0
          ? `<tr><td colspan="2" style="padding-left:2mm;font-size:.9em">${esc(detalhe.join(' · '))}</td></tr>`
          : '')
      );
    }),
  ].join('');

  const reaberturas = Number(sessao.reopen_count ?? 0);

  return cupomShell(
    'Fechamento de caixa',
    `<h1>FECHAMENTO DE CAIXA</h1>
     <p class="sub">${esc(c.trade_name)}${c.cnpj ? `<br>CNPJ ${esc(c.cnpj)}` : ''}</p>
     <hr>
     <table>
       <tr><td>Caixa</td><td class="r">${esc(sessao.nome_do_caixa ?? 'Gaveta única da operação')}</td></tr>
       <tr><td>Aberto</td><td class="r">${esc(dataHora(sessao.opened_at, c.uf))}</td></tr>
       ${abertoPor ? `<tr><td>Aberto por</td><td class="r">${esc(abertoPor)}</td></tr>` : ''}
       <tr><td>Fechado</td><td class="r">${esc(dataHora(sessao.closed_at, c.uf))}</td></tr>
       ${fechadoPor ? `<tr><td>Fechado por</td><td class="r">${esc(fechadoPor)}</td></tr>` : ''}
     </table>
     ${
       reaberturas > 0
         ? `<p class="aviso">Turno reaberto ${reaberturas} vez(es): este é o fechamento que vale. Os anteriores ficam no histórico do caixa.</p>`
         : ''
     }
     <hr>
     <p class="b">POR FORMA DE PAGAMENTO</p>
     <table>
       ${porMeio.map((m) => `<tr><td>${esc(rotuloDoMeio(m.method))}</td><td class="r">${brl(m.total)}</td></tr>`).join('') || '<tr><td colspan="2">Sem vendas.</td></tr>'}
       ${troco > 0 ? `<tr><td>Troco devolvido (saiu do dinheiro)</td><td class="r">- ${brl(troco)}</td></tr>` : ''}
     </table>
     <hr>
     <p class="b">GAVETA (DINHEIRO)</p>
     <table>
       ${linhasDaGaveta || '<tr><td colspan="2">Sem movimento.</td></tr>'}
       <tr><td>Esperado</td><td class="r b">${brl(sessao.expected_cents)}</td></tr>
       <tr><td>Contado</td><td class="r b">${brl(sessao.counted_cents)}</td></tr>
     </table>
     <hr>
     <table>
       <tr class="total">
         <td>${diferenca === 0 ? 'CONFERIDO' : diferenca > 0 ? 'SOBRA' : 'FALTA'}</td>
         <td class="r">${brl(Math.abs(diferenca))}</td>
       </tr>
     </table>
     ${sessao.note ? `<p>Observação: ${esc(sessao.note)}</p>` : ''}
     ${blocoDasPendencias(sessao.closed_with_pending, c.uf)}
     <p class="rodape">Assinatura do responsável:<br><br>_______________________________${fechadoPor ? `<br>${esc(fechadoPor)}` : ''}</p>`,
    larguraMm,
  );
}

// ------------------------------------------------ plaquinha de equipamento

function renderEquipmentTag(companyId: string, equipmentId: string): string {
  /*
    A REGRA DE OURO CHEGA AQUI TAMBÉM (rodada 53).

    Este era o ÚNICO gerador de plaquinha sem guarda nenhum no sistema: a fila
    de impressão (`POST /core/print/jobs` com `EQUIPMENT_QR_TAG`) aceita perfis
    de LOJA, e daqui saía uma plaquinha com QR de equipamento sem passar nem
    pela regra da bancada — que a rodada 18 escreveu — nem pela da empresa. Que
    nenhuma tela chame este caminho hoje não é defesa: rota aberta é rota que
    alguém acha.
  */
  exigirEmpresaComPlaquinha(companyId);

  const db = getConnection();
  const eq = db
    .prepare('SELECT * FROM core_equipment WHERE id = ? AND company_id = ?')
    .get(equipmentId, companyId) as Record<string, unknown> | undefined;
  if (!eq) throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);

  // A bancada de celulares continua sem plaquinha: o aparelho entra e sai no
  // mesmo dia e é identificado pela própria OS.
  const bancada = eq.workshop_id
    ? (db
        .prepare('SELECT kind, name FROM core_workshops WHERE id = ?')
        .get(String(eq.workshop_id)) as { kind: string; name: string } | undefined)
    : undefined;
  if (bancada && !capabilitiesFor(bancada.kind).equipmentTags) {
    throw new ApiError(
      'CORE_WORKSHOP_NO_TAGS',
      `${bancada.name} não usa plaquinha: o aparelho é identificado pela própria OS.`,
      409,
    );
  }

  const c = company(companyId);
  const publicId = formatTagId(Number(eq.public_id));

  // O QR aponta para o token OPACO, nunca para dado do dono. A plaquinha fica
  // colada num equipamento que circula pela rua: quem apontar a câmera não
  // pode descobrir nome, telefone ou endereço de ninguém.
  const url = `${publicBaseUrl()}/equipamento/${String(eq.public_token)}`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Plaquinha ${esc(publicId)}</title>
<style>
  @page { size: 50mm 25mm; margin: 2mm; }
  body { margin: 0; width: 46mm; font-family: Arial, sans-serif; color: #000;
         display: flex; gap: 2mm; align-items: center; }
  .qr { width: 20mm; height: 20mm; flex: none; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .dados { font-size: 7px; line-height: 1.3; }
  .id { font-size: 15px; font-weight: bold; letter-spacing: .5px; }
  .op { font-size: 6px; color: #333; }
  @media screen { body { margin: 12px; padding: 8px; box-shadow: 0 0 0 1px #ccc; } }
</style></head><body>
  <div class="qr">${qrSvg(url)}</div>
  <div class="dados">
    <p class="id">${esc(publicId)}</p>
    <p>${esc(eq.brand ?? '')} ${esc(eq.model ?? '')}</p>
    <p class="op">${esc(c.trade_name)}</p>
  </div>
</body></html>`;
}

// ----------------------------------------------------------------- fachada

/**
 * Renderiza o documento para papel.
 *
 * Documentos fiscais não são gerados aqui: DANFE e DANFCE exigem XML
 * autorizado pela SEFAZ, e desenhar um "parecido" seria produzir um documento
 * falso.
 */
export function renderDocument(
  companyId: string,
  documentType: DocumentType,
  documentId: string,
  /**
   * A largura da bobina da impressora que vai receber o papel (F-07). Só os
   * papéis de cupom a usam; ausente, vale a de 80 mm.
   */
  opcoes: { larguraMm?: number | null } = {},
): string {
  ensureCoreSchema();

  switch (documentType) {
    case 'PDV_RECEIPT':
    case 'SALE_RECEIPT':
      return renderSale(companyId, documentId, opcoes.larguraMm);
    case 'QUOTE':
    case 'PRE_SALE':
      return renderQuote(companyId, documentId);
    case 'PRODUCT_LABEL':
      return renderProductLabel(companyId, documentId);
    case 'WORKSHOP_OS':
      return renderWorkshopOrder(companyId, documentId);
    case 'CASH_CLOSING':
      return renderCashClosing(companyId, documentId, opcoes.larguraMm);
    case 'EQUIPMENT_QR_TAG':
      return renderEquipmentTag(companyId, documentId);
    // O DANFCE agora existe porque existe documento fiscal de verdade: ele é
    // montado a partir de `core_fiscal_documents`, e só quando autorizado.
    // Estado diferente produz pré-visualização com tarja, nunca um papel
    // indistinguível de nota válida.
    case 'DANFCE':
      return renderDanfce(companyId, documentId, { larguraMm: opcoes.larguraMm });
    // O DANFE tambem sai do documento fiscal, e so quando autorizado.
    case 'DANFE':
      return renderDanfe(companyId, documentId);
    default:
      throw new ApiError(
        'CORE_PRINT_RENDERER_MISSING',
        `Ainda não há layout para ${documentType}.`,
        501,
      );
  }
}
