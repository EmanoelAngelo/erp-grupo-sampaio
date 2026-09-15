/**
 * A ORDEM DE SERVIÇO EM PAPEL — A4, com a marca de quem assina (rodada 54).
 *
 * ## O que existia, e por que não servia
 *
 * `PrintRenderer.renderWorkshopOrder` existia desde a rodada da fila de
 * impressão e **nenhuma tela jamais o chamou**: documento escrito, registrado
 * no catálogo de tipos, e inalcançável pelo aplicativo. Quem precisava
 * entregar um papel ao cliente não tinha por onde.
 *
 * E o que ele desenhava estava errado em silêncio: lia `parts_total_cents` e
 * `labor_total_cents`, colunas que **não existem** (são `parts_cents` e
 * `labor_cents`). `Number(undefined) > 0` é falso, então as duas linhas do
 * bloco de valores simplesmente nunca apareciam — o papel mostrava só o total,
 * sem dizer quanto era peça e quanto era mão de obra, que é a primeira coisa
 * que o cliente pergunta.
 *
 * Faltavam ainda a marca, a conferência de entrada (rodada 52), o prazo
 * prometido (rodada 51), as condições e as assinaturas.
 *
 * ## Quem assina o papel
 *
 * A bancada declara a marca (`core_workshops.brand_company_id`): a de
 * mobilidade pertence à Oficina, mas quem o cliente conhece, quem vendeu a
 * moto e quem responde pela garantia é a PJ Motors. A de celulares assina em
 * nome próprio, porque já é da Preço Justo.
 *
 * ## Desde a abertura
 *
 * O mesmo documento serve nos dois momentos: na ENTRADA, com a conferência
 * preenchida e a assinatura de recebimento, e na ENTREGA, com diagnóstico,
 * peças e valores. Não são dois papéis — é o mesmo, mais cheio. Dois modelos
 * divergiriam no primeiro campo que alguém mudasse num só.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { desenharQr } from './Qr.js';
import { capabilitiesFor } from './WorkshopCapabilities.js';
import { formatTagId } from './EquipmentTagPoolService.js';
import { rotuloDoStatus } from './WorkshopCoreService.js';
import { warrantyOf } from './EquipmentService.js';
import { publicBaseUrl } from './PublicUrl.js';
import { storeUploadsDir } from './StorefrontSettingsService.js';

function esc(v: unknown): string {
  return String(v ?? '')
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

/**
 * QUANTIDADE NO PAPEL — a mesma regra da tela.
 *
 * Peça se vende por metro e por quilo: `quantity` é REAL no banco, e a
 * subtração da devolvida em ponto flutuante produz `0.19999999999999998`. O
 * número cru ia direto para a célula, e o cliente recebia isso num documento
 * assinado. Três casas e vírgula decimal — o mesmo `formatQuantity` que a tela
 * da OS usa, para o papel e a tela não discordarem.
 */
function qtd(n: number): string {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/**
 * O CENTAVO DA LINHA — arredondado como o servidor arredonda.
 *
 * O total de peças da OS é `SUM(ROUND(unit_price_cents * (quantity -
 * returned_quantity)))`: o SQLite arredonda LINHA A LINHA. O papel multiplicava
 * em float e deixava o `Intl` arredondar na hora de escrever — duas contas
 * diferentes para o mesmo número. Com três peças de 0,7 × R$ 0,85, a coluna
 * somava R$ 1,80 e o bloco de valores logo abaixo dizia R$ 1,77: o documento
 * que o cliente usa para conferir a conta não fechava consigo mesmo.
 */
function centavosDaLinha(unitario: number, quantidade: number): number {
  return Math.round(Number(unitario) * Number(quantidade));
}

/**
 * INSTANTE se imprime no fuso de quem lê; DIA DE CALENDÁRIO, como veio.
 *
 * `new Date('2026-08-30')` é meia-noite UTC, e no Brasil isso é o dia 29 às
 * 21h: o prazo prometido ao cliente sairia impresso um dia antes do combinado.
 */
function diaDeCalendario(iso: unknown): string {
  const s = String(iso ?? '');
  const casou = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (casou) return `${casou[3]}/${casou[2]}/${casou[1]}`;
  return s;
}

function dataHora(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

const PRIORIDADE_ROTULO: Record<string, string> = {
  urgente: 'Urgente',
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
};

const RESPOSTA_ROTULO: Record<string, string> = {
  sim: 'Veio',
  nao: 'Não veio',
  pendente: '—',
};

/** Os mesmos três motivos que a conclusão técnica exige, em português. */
const MOTIVO_SEM_CUSTO: Record<string, string> = {
  garantia: 'garantia',
  cortesia_autorizada: 'cortesia autorizada',
  retrabalho: 'retrabalho',
  // Não é motivo da conclusão técnica: só a regularização da gestão o grava
  // (GAP-PRD-188), para a OS de teste ou aberta por engano.
  lancamento_indevido: 'lançamento indevido, encerrada pela gestão',
};

interface MarcaDoPapel {
  nome: string;
  cnpj: string | null;
  logoUrl: string | null;
  endereco: string | null;
  contato: string | null;
}

/**
 * A MARCA QUE ASSINA — juntada de três lugares, porque é onde ela mora.
 *
 * Nenhuma tabela sozinha tem um cabeçalho de papel completo:
 *
 *   core_companies           nome fantasia e CNPJ
 *   core_fiscal_configs      o ENDEREÇO e o telefone (é o cadastro que a NF-e
 *                            exige, e por isso é o único preenchido de verdade)
 *   core_storefront_settings a LOGO (arquivo no disco, rodada 40) e o WhatsApp
 *
 * O que faltar simplesmente não é impresso: cabeçalho com "CNPJ null" é pior
 * que cabeçalho curto. Hoje só a Preço Justo tem o bloco fiscal completo — a
 * PJ Motors e a Oficina saem com o nome e mais nada até alguém preencher.
 *
 * A logo vem como caminho relativo (`/uploads/lojas/...`) servido pela API. No
 * HTML aberto em janela do navegador, o caminho relativo resolveria contra a
 * origem da SPA e a marca não carregaria — o mesmo defeito que a rodada 52
 * achou nas fotos da OS.
 */
function marcaDoPapel(companyId: string, brandCompanyId: string | null): MarcaDoPapel {
  const db = getConnection();
  const alvo = brandCompanyId ?? companyId;
  const empresa = db
    .prepare('SELECT trade_name, legal_name, cnpj FROM core_companies WHERE id = ?')
    .get(alvo) as { trade_name: string; legal_name: string; cnpj: string | null } | undefined;
  const vitrine = db
    .prepare('SELECT logo_url, whatsapp FROM core_storefront_settings WHERE company_id = ?')
    .get(alvo) as { logo_url: string | null; whatsapp: string | null } | undefined;
  const fiscal = db
    .prepare(
      `SELECT cnpj, street, number, complement, district, city_name, uf, zip, phone
         FROM core_fiscal_configs WHERE company_id = ?`,
    )
    .get(alvo) as
    | {
        cnpj: string | null;
        street: string | null;
        number: string | null;
        complement: string | null;
        district: string | null;
        city_name: string | null;
        uf: string | null;
        zip: string | null;
        phone: string | null;
      }
    | undefined;

  const rua = [fiscal?.street, fiscal?.number].filter(Boolean).join(', ');
  const cidade = [fiscal?.city_name, fiscal?.uf].filter(Boolean).join('/');
  const endereco = [rua, fiscal?.complement, fiscal?.district, cidade, fiscal?.zip]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' · ');

  /*
    IDENTIDADE AUSENTE É CONFIGURAÇÃO INCOMPLETA — não "Grupo Sampaio".

    O fallback anterior era `|| 'Grupo Sampaio'`, e "Grupo Sampaio" não é
    nenhuma das seis operações: não tem CNPJ, não emite nota e não responde por
    garantia nenhuma. O papel saía com cara de certo e o cliente levava para
    casa um documento que não diz de quem é — e ninguém descobriria, porque
    nada falhava.

    Recusar aqui custa uma impressão; imprimir o genérico custa a próxima
    discussão de garantia.
  */
  const nome = (empresa?.trade_name || empresa?.legal_name || '').trim();
  if (!nome) {
    throw new ApiError(
      'CORE_MARCA_INCOMPLETA',
      'A operação que assina este documento está sem identidade cadastrada. '
        + 'Preencha o nome fantasia (ou a razão social) em Configurações › Empresas.',
      409,
      { companyId: alvo },
    );
  }

  return {
    nome,
    cnpj: empresa?.cnpj || fiscal?.cnpj || null,
    logoUrl: logoEmbutida(vitrine?.logo_url ?? null),
    endereco: endereco || null,
    contato: (fiscal?.phone || '').trim() || vitrine?.whatsapp || null,
  };
}

/** Teto da marca no papel. Acima disso o cabeçalho sai sem logo, e não quebrado. */
const MAX_LOGO_NO_PAPEL = 512 * 1024;

const TIPO_POR_EXTENSAO: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * A LOGO VIAJA DENTRO DO PAPEL.
 *
 * `core_storefront_settings.logo_url` é um caminho relativo servido pela API
 * (`/uploads/lojas/...`), e este HTML é aberto numa janela em branco do
 * navegador: caminho relativo ali resolveria contra a origem da SPA. Montar
 * com o endereço PÚBLICO também não serve — ele é o do site que o QR aponta,
 * não o da API, e num ambiente sem a variável preenchida a janela iria pedir a
 * marca ao domínio de produção e imprimir a imagem quebrada.
 *
 * Embutida como `data:`, a folha é autocontida: imprime sem rede, como a folha
 * de plaquinha da rodada 53 já faz. Arquivo ausente, tipo desconhecido ou
 * grande demais devolvem nulo — cabeçalho sem logo é melhor que cabeçalho com
 * um ícone de imagem quebrada.
 */
function logoEmbutida(logoUrl: string | null): string | null {
  if (!logoUrl) return null;
  if (logoUrl.startsWith('data:')) return logoUrl;
  // Só o nome do arquivo entra no caminho: nome com barra não é nosso.
  const nome = logoUrl.split('/').pop() ?? '';
  if (!nome || nome.includes('\\') || nome.includes('..')) return null;
  const tipo = TIPO_POR_EXTENSAO[extname(nome).toLowerCase()];
  if (!tipo) return null;
  try {
    const caminho = join(storeUploadsDir(), nome);
    const bytes = readFileSync(caminho);
    if (bytes.byteLength > MAX_LOGO_NO_PAPEL) return null;
    return `data:${tipo};base64,${bytes.toString('base64')}`;
  } catch {
    // Arquivo apagado à mão, permissão, disco: o papel sai sem a marca.
    return null;
  }
}

export interface OrdemParaPapel {
  html: string;
  /** O número da OS, para o nome do arquivo que a tela oferece. */
  numero: number;
  marca: string;
}

export function renderServiceOrderA4(companyId: string, orderId: string): OrdemParaPapel {
  ensureCoreSchema();
  const db = getConnection();

  const os = db
    .prepare('SELECT * FROM core_service_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as Record<string, unknown> | undefined;
  if (!os) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Ordem de serviço não encontrada.', 404);

  const bancada = os.workshop_id
    ? (db
        .prepare('SELECT name, kind, brand_company_id FROM core_workshops WHERE id = ?')
        .get(String(os.workshop_id)) as
        | { name: string; kind: string; brand_company_id: string | null }
        | undefined)
    : undefined;

  const marca = marcaDoPapel(companyId, bancada?.brand_company_id ?? null);

  const cliente = os.customer_id
    ? (db
        .prepare('SELECT name, phone, document FROM core_customers WHERE id = ? AND company_id = ?')
        .get(String(os.customer_id), companyId) as
        | { name: string; phone: string | null; document: string | null }
        | undefined)
    : undefined;

  const equipamento = os.equipment_id
    ? (db
        .prepare(
          `SELECT public_id, public_token, brand, model, serial_number, chassis,
                  warranty_months, sold_at, entered_at
             FROM core_equipment WHERE id = ? AND company_id = ?`,
        )
        .get(String(os.equipment_id), companyId) as
        | {
            public_id: number;
            public_token: string;
            brand: string | null;
            model: string | null;
            serial_number: string | null;
            chassis: string | null;
            warranty_months: number | null;
            sold_at: string | null;
            entered_at: string | null;
          }
        | undefined)
    : undefined;

  const mecanico = os.mechanic_id
    ? (db.prepare('SELECT display_name FROM core_users WHERE id = ?').get(String(os.mechanic_id)) as
        | { display_name: string }
        | undefined)
    : undefined;

  const pecas = db
    .prepare(
      `SELECT description, quantity, unit_price_cents, total_cents, returned_quantity
         FROM core_service_order_parts WHERE order_id = ? ORDER BY created_at`,
    )
    .all(orderId) as unknown as {
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    returned_quantity: number | null;
  }[];

  const conferencia = db
    .prepare(
      `SELECT item, answer, note FROM core_service_order_checklist
        WHERE order_id = ? ORDER BY position`,
    )
    .all(orderId) as unknown as { item: string; answer: string; note: string | null }[];

  /*
    O QR do acompanhamento só entra onde a plaquinha existe.

    É a mesma regra da bancada desde a rodada 18 e a regra de ouro da 53: a de
    celulares não usa plaquinha, e o aparelho é identificado pela própria OS.
    Imprimir um QR que não leva a lugar nenhum é pior que não imprimir.

    E ele continua aqui depois do P0 das plaquinhas (plaquinha exclusiva da PJ
    Motors), de propósito: este é o QR da PRÓPRIA máquina da Oficina
    (`core_equipment.public_token`), o link de acompanhamento do serviço que o
    cliente leva no papel da OS. A OS não gera, não cola, não vincula nem
    administra plaquinha nenhuma do pool — só imprime o endereço da máquina
    que já existe. Nenhum comportamento mudou.
  */
  const usaQr = Boolean(bancada && capabilitiesFor(bancada.kind).equipmentTags && equipamento);
  const qr = usaQr
    ? desenharQr(`${publicBaseUrl()}/equipamento/${equipamento!.public_token}`, { nivel: 'Q' })
    : null;

  const garantia = equipamento ? warrantyOf(equipamento) : null;

  const identificacao: [string, string][] = [];
  if (equipamento) {
    identificacao.push(['Plaquinha', formatTagId(equipamento.public_id)]);
    const nome = [equipamento.brand, equipamento.model].filter(Boolean).join(' ');
    if (nome) identificacao.push(['Equipamento', nome]);
    if (equipamento.chassis) identificacao.push(['Chassi', equipamento.chassis]);
    if (equipamento.serial_number) identificacao.push(['Número de série', equipamento.serial_number]);
    if (garantia && garantia.status !== 'sem_garantia' && garantia.expiresAt) {
      identificacao.push(['Garantia', `até ${diaDeCalendario(garantia.expiresAt)}`]);
    }
  } else if (os.equipment) {
    identificacao.push(['Equipamento', String(os.equipment)]);
  }
  if (os.plate) identificacao.push(['Placa', String(os.plate)]);

  const linhasDePeca = pecas
    .map((p) => {
      const devolvida = Number(p.returned_quantity ?? 0);
      const cobrada = Number(p.quantity) - devolvida;
      return `<tr>
        <td>${esc(p.description)}${devolvida > 0 ? ` <span class="obs">(${esc(qtd(devolvida))} devolvida${devolvida > 1 ? 's' : ''})</span>` : ''}</td>
        <td class="r">${esc(qtd(cobrada))}</td>
        <td class="r">${brl(p.unit_price_cents)}</td>
        <td class="r">${brl(centavosDaLinha(p.unit_price_cents, cobrada))}</td>
      </tr>`;
    })
    .join('');

  const linhasDaConferencia = conferencia
    .map(
      (c) => `<tr>
        <td>${esc(c.item)}</td>
        <td class="c">${esc(RESPOSTA_ROTULO[c.answer] ?? c.answer)}</td>
        <td>${esc(c.note ?? '')}</td>
      </tr>`,
    )
    .join('');

  const dados: [string, string][] = [
    ['Aberta em', dataHora(os.created_at)],
    ['Situação', rotuloDoStatus(String(os.status))],
    ['Prioridade', PRIORIDADE_ROTULO[String(os.priority ?? 'media')] ?? String(os.priority ?? '')],
  ];
  if (os.due_date) dados.push(['Prazo prometido', diaDeCalendario(os.due_date)]);
  if (bancada?.name) dados.push(['Bancada', bancada.name]);
  if (mecanico?.display_name) dados.push(['Responsável', mecanico.display_name]);

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>OS ${esc(os.number)} — ${esc(marca.nome)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; color: #1f1b24; }

  header { display: flex; align-items: flex-start; gap: 6mm;
           border-bottom: 1.5pt solid #4f1a6d; padding-bottom: 4mm; margin-bottom: 5mm; }
  .logo { width: 28mm; height: 18mm; object-fit: contain; flex: none; }
  .marca { flex: 1; }
  .marca h1 { font-size: 15pt; margin: 0; color: #3b1453; letter-spacing: .2px; }
  .marca p { margin: 1mm 0 0; font-size: 9pt; color: #5c5266; }
  .numero { text-align: right; flex: none; }
  .numero .rotulo { font-size: 8pt; text-transform: uppercase; letter-spacing: .6px; color: #5c5266; }
  .numero .valor { font-size: 20pt; font-weight: bold; color: #3b1453; line-height: 1; }
  .numero .qr { width: 22mm; height: 22mm; margin-top: 2mm; }
  .numero .qr svg { width: 100%; height: 100%; display: block; }
  .numero .qr-legenda { font-size: 6.5pt; color: #5c5266; }

  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .6px; color: #5c5266;
       margin: 5mm 0 2mm; border-bottom: .5pt solid #d3ccdd; padding-bottom: 1mm; }

  .grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm 6mm; }
  .campo .rotulo { font-size: 8pt; color: #5c5266; }
  .campo .valor { font-size: 10.5pt; }

  .texto { border: .5pt solid #d3ccdd; border-radius: 1.5mm; padding: 2.5mm; min-height: 12mm;
           white-space: pre-wrap; }

  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .4px;
       color: #5c5266; border-bottom: .5pt solid #d3ccdd; padding: 1.5mm 1mm; }
  td { padding: 1.5mm 1mm; border-bottom: .5pt solid #e6e1ec; font-size: 9.5pt; }
  .r { text-align: right; }
  .c { text-align: center; }
  .obs { color: #5c5266; font-size: 8pt; }

  .totais { display: flex; justify-content: flex-end; margin-top: 3mm; }
  .totais div { min-width: 65mm; }
  .linha { display: flex; justify-content: space-between; padding: 1mm 0; }
  .total { font-size: 13pt; font-weight: bold; color: #3b1453;
           border-top: 1.5pt solid #4f1a6d; padding-top: 1.5mm; margin-top: 1mm; }

  .condicoes { font-size: 8pt; color: #5c5266; margin-top: 5mm; line-height: 1.5; }

  /*
    As assinaturas não se separam do que assinam: uma folha que quebra entre o
    texto das condições e a linha da assinatura produz uma segunda página com
    dois traços soltos, que ninguém sabe do que são.
  */
  .assinaturas { display: flex; gap: 10mm; margin-top: 12mm; page-break-inside: avoid; }
  .assinatura { flex: 1; text-align: center; }
  .assinatura .traco { border-top: .5pt solid #1f1b24; margin-bottom: 1.5mm; }
  .assinatura .quem { font-size: 8.5pt; }
  .assinatura .quando { font-size: 7.5pt; color: #5c5266; }

  @media screen {
    body { max-width: 210mm; margin: 12px auto; padding: 12mm;
           box-shadow: 0 0 0 1px #e6e1ec; background: #fff; }
  }
</style></head><body>

  <header>
    ${marca.logoUrl ? `<img class="logo" src="${esc(marca.logoUrl)}" alt="">` : ''}
    <div class="marca">
      <h1>${esc(marca.nome)}</h1>
      ${marca.cnpj ? `<p>CNPJ ${esc(marca.cnpj)}</p>` : ''}
      ${marca.endereco ? `<p>${esc(marca.endereco)}</p>` : ''}
      ${marca.contato ? `<p>${esc(marca.contato)}</p>` : ''}
    </div>
    <div class="numero">
      <p class="rotulo" style="margin:0">Ordem de serviço</p>
      <p class="valor" style="margin:0">${esc(os.number)}</p>
      ${qr ? `<div class="qr">${qr.svg}</div><p class="qr-legenda" style="margin:0">Acompanhe pelo QR</p>` : ''}
    </div>
  </header>

  <h2>Atendimento</h2>
  <div class="grade">
    ${dados
      .map(
        ([rotulo, valor]) => `<div class="campo">
          <p class="rotulo" style="margin:0">${esc(rotulo)}</p>
          <p class="valor" style="margin:0">${esc(valor)}</p>
        </div>`,
      )
      .join('')}
  </div>

  <h2>Cliente</h2>
  <div class="grade">
    <div class="campo">
      <p class="rotulo" style="margin:0">Nome</p>
      <p class="valor" style="margin:0">${esc(cliente?.name ?? os.customer_name ?? 'Não informado')}</p>
    </div>
    ${
      cliente?.phone
        ? `<div class="campo"><p class="rotulo" style="margin:0">Telefone</p>
             <p class="valor" style="margin:0">${esc(cliente.phone)}</p></div>`
        : ''
    }
    ${
      cliente?.document
        ? `<div class="campo"><p class="rotulo" style="margin:0">Documento</p>
             <p class="valor" style="margin:0">${esc(cliente.document)}</p></div>`
        : ''
    }
  </div>

  ${
    identificacao.length > 0
      ? `<h2>Equipamento</h2>
         <div class="grade">
           ${identificacao
             .map(
               ([rotulo, valor]) => `<div class="campo">
                 <p class="rotulo" style="margin:0">${esc(rotulo)}</p>
                 <p class="valor" style="margin:0">${esc(valor)}</p>
               </div>`,
             )
             .join('')}
         </div>`
      : ''
  }

  <h2>Relato do cliente</h2>
  <div class="texto">${esc(os.complaint ?? '')}</div>

  ${
    conferencia.length > 0
      ? `<h2>Conferência de entrada</h2>
         <table>
           <thead><tr><th>Item</th><th class="c">Situação</th><th>Observação</th></tr></thead>
           <tbody>${linhasDaConferencia}</tbody>
         </table>`
      : ''
  }

  ${
    os.diagnosis
      ? `<h2>Diagnóstico e serviço executado</h2>
         <div class="texto">${esc(os.diagnosis)}</div>`
      : ''
  }

  ${
    pecas.length > 0
      ? `<h2>Peças aplicadas</h2>
         <table>
           <thead><tr><th>Peça</th><th class="r">Qtde</th><th class="r">Unitário</th><th class="r">Total</th></tr></thead>
           <tbody>${linhasDePeca}</tbody>
         </table>`
      : ''
  }

  <h2>Valores</h2>
  ${
    /*
      A OS SEM CUSTO PRECISA DIZER POR QUE NÃO TEM CUSTO.

      Garantia, cortesia autorizada e retrabalho fecham com total zero, e o
      papel saía com "Total R$ 0,00" e mais nada — o cliente guarda um
      documento que não prova que o serviço foi feito em garantia. O motivo é
      exigido pelo servidor desde a conclusão técnica; faltava sair no papel.
    */
    Number(os.has_cost) === 0 && os.no_cost_reason
      ? `<p style="margin:0 0 2mm"><strong>Serviço sem custo — ${esc(
          MOTIVO_SEM_CUSTO[String(os.no_cost_reason)] ?? String(os.no_cost_reason),
        )}.</strong></p>`
      : ''
  }
  ${
    os.approved_at
      ? `<p style="margin:0 0 2mm">Orçamento aprovado pelo cliente em ${esc(dataHora(os.approved_at))}.</p>`
      : ''
  }
  <div class="totais"><div>
    <div class="linha"><span>Peças</span><span>${brl(os.parts_cents)}</span></div>
    <div class="linha"><span>Mão de obra</span><span>${brl(os.labor_cents)}</span></div>
    <div class="linha total"><span>Total</span><span>${brl(os.total_cents)}</span></div>
  </div></div>

  <p class="condicoes">
    Este documento acompanha o serviço e <strong>não é documento fiscal</strong>.
    O equipamento é retirado mediante apresentação desta ordem e quitação do valor no caixa.
    Peças substituídas ficam à disposição do cliente por 30 dias; após esse prazo, são descartadas.
    Equipamento não retirado em 90 dias fica sujeito a cobrança de guarda.
  </p>

  <div class="assinaturas">
    <div class="assinatura">
      <div class="traco"></div>
      <p class="quem" style="margin:0">${esc(cliente?.name ?? os.customer_name ?? 'Cliente')}</p>
      <p class="quando" style="margin:0">Entrega do equipamento — data ___/___/______</p>
    </div>
    <div class="assinatura">
      <div class="traco"></div>
      <p class="quem" style="margin:0">${esc(mecanico?.display_name ?? 'Responsável técnico')}</p>
      <p class="quando" style="margin:0">${esc(marca.nome)}</p>
    </div>
  </div>

</body></html>`;

  return { html, numero: Number(os.number), marca: marca.nome };
}
