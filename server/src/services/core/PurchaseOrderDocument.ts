/**
 * ============================================================================
 * O PEDIDO DE COMPRA EM PAPEL, E NO E-MAIL DO FORNECEDOR (GAP-PRD-090)
 * ============================================================================
 *
 * "Enviar ao fornecedor" só fazia `UPDATE status = 'enviado'`: nada saía do
 * sistema, não existia documento imprimível do pedido, e o comprador
 * transcrevia itens, quantidades e custos no WhatsApp. A conciliação depois
 * acusava divergência que tinha nascido na digitação.
 *
 * Agora há três gestos, cada um com o nome do que faz:
 *
 *   IMPRIMIR   o A4 do pedido (este arquivo), o mesmo desenho em qualquer
 *              status — rascunho sai com a tarja "RASCUNHO", para ninguém
 *              mandar ao fornecedor um combinado que ainda muda;
 *   E-MAIL     o mesmo A4 como anexo e o pedido em texto no corpo, para o
 *              e-mail do cadastro do fornecedor. Sem SMTP configurado, a
 *              mensagem fica na fila e a resposta DIZ isso — "pronto para a
 *              credencial", nunca "enviado";
 *   MARCAR     o antigo botão, com o rótulo honesto: registrar que o pedido
 *              foi mandado por fora (telefone, WhatsApp) e travar os itens.
 *
 * Enviar por e-mail um rascunho também o marca como enviado, na mesma
 * transação: o fornecedor recebeu o combinado, e o combinado não muda mais.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  emailStatus,
  isDeliverableAddress,
  queuePedidoCompraEmail,
  type EmailReadiness,
} from '../notifications/EmailService.js';
import { getPurchaseOrder, sendPurchaseOrder } from './PurchaseOrderService.js';

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brl(cents: unknown): string {
  return (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function qtd(n: unknown): string {
  return Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Dia de calendário como veio; instante no fuso de quem lê. */
function dia(iso: unknown): string {
  const s = String(iso ?? '');
  if (!s) return '—';
  const casou = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return casou ? `${casou[3]}/${casou[2]}/${casou[1]}` : s;
}

const ROTULO_DO_STATUS: Record<string, string> = {
  rascunho: 'Rascunho',
  enviado: 'Enviado ao fornecedor',
  recebido_parcial: 'Recebido em parte',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

interface Comprador {
  nome: string;
  cnpj: string | null;
  endereco: string | null;
  telefone: string | null;
}

/**
 * QUEM COMPRA — a identidade da operação no cabeçalho.
 *
 * Mesma costura de `ServiceOrderA4`: nome e CNPJ em `core_companies`, endereço
 * e telefone no cadastro fiscal (o único preenchido de verdade). O que faltar
 * não é impresso — cabeçalho com "CNPJ null" é pior que cabeçalho curto — e
 * empresa sem nome é recusa, não "Grupo Sampaio".
 */
function comprador(companyId: string): Comprador {
  const db = getConnection();
  const empresa = db
    .prepare('SELECT trade_name, legal_name, cnpj FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name: string | null; legal_name: string | null; cnpj: string | null } | undefined;
  const fiscal = db
    .prepare(
      `SELECT cnpj, street, number, district, city_name, uf, zip, phone
         FROM core_fiscal_configs WHERE company_id = ?`,
    )
    .get(companyId) as Record<string, string | null> | undefined;
  const nome = String(empresa?.trade_name || empresa?.legal_name || '').trim();
  if (!nome) {
    throw new ApiError(
      'CORE_MARCA_INCOMPLETA',
      'A operação que compra está sem identidade cadastrada. Preencha o nome fantasia '
        + '(ou a razão social) em Configurações › Empresas.',
      409,
      { companyId },
    );
  }
  const rua = [fiscal?.street, fiscal?.number].filter(Boolean).join(', ');
  const cidade = [fiscal?.city_name, fiscal?.uf].filter(Boolean).join('/');
  const endereco = [rua, fiscal?.district, cidade, fiscal?.zip]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(' · ');
  return {
    nome,
    cnpj: empresa?.cnpj || fiscal?.cnpj || null,
    endereco: endereco || null,
    telefone: String(fiscal?.phone ?? '').trim() || null,
  };
}

interface Fornecedor {
  name: string;
  trade_name: string | null;
  document: string | null;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  payment_term_days: number;
}

function fornecedorDoPedido(companyId: string, supplierId: string): Fornecedor {
  const f = getConnection()
    .prepare(
      `SELECT name, trade_name, document, email, phone, contact_name, payment_term_days
         FROM core_suppliers WHERE id = ? AND company_id = ?`,
    )
    .get(supplierId, companyId) as Fornecedor | undefined;
  if (!f) throw new ApiError('CORE_SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.', 404);
  return f;
}

export interface PedidoParaPapel {
  html: string;
  numero: number;
  status: string;
  fornecedor: string;
  /** O e-mail do cadastro do fornecedor, para a tela oferecer (ou não) o envio. */
  emailDoFornecedor: string | null;
}

interface ItemDoPedido {
  description: string;
  internal_code: string | null;
  quantity: number;
  unit_cost_cents: number;
  total_cents: number;
  received_quantity: number;
}

export function renderPurchaseOrderA4(companyId: string, orderId: string): PedidoParaPapel {
  ensureCoreSchema();
  const pedido = getPurchaseOrder(companyId, orderId) as Record<string, unknown> & {
    items: ItemDoPedido[];
  };
  const quem = comprador(companyId);
  const f = fornecedorDoPedido(companyId, String(pedido.supplier_id));
  const status = String(pedido.status);
  const rascunho = status === 'rascunho';
  const cancelado = status === 'cancelado';

  const linhas = pedido.items
    .map(
      (i) => `<tr>
        <td class="mono">${esc(i.internal_code ?? '—')}</td>
        <td>${esc(i.description)}</td>
        <td class="r">${qtd(i.quantity)}</td>
        <td class="r">${brl(i.unit_cost_cents)}</td>
        <td class="r">${brl(i.total_cents)}</td>
      </tr>`,
    )
    .join('');

  const prazo = Number(f.payment_term_days) > 0
    ? `${Number(f.payment_term_days)} dia(s) após o recebimento`
    : 'à vista, no recebimento';

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Pedido de compra ${esc(pedido.number)} — ${esc(quem.nome)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 11pt; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 3mm; }
  header h1 { margin: 0; font-size: 16pt; }
  header p { margin: 0.5mm 0; font-size: 9pt; }
  .numero { text-align: right; }
  .numero .valor { font-size: 20pt; font-weight: bold; margin: 0; }
  .rotulo { font-size: 8pt; text-transform: uppercase; color: #555; margin: 0; }
  h2 { font-size: 11pt; margin: 5mm 0 2mm; text-transform: uppercase; color: #333; }
  .grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm 6mm; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { border-bottom: 1px solid #ccc; padding: 1.5mm 1mm; text-align: left; }
  th { background: #f2f2f2; }
  .r { text-align: right; }
  .mono { font-family: 'Courier New', monospace; }
  .total { font-size: 13pt; font-weight: bold; text-align: right; margin-top: 3mm; }
  .tarja { border: 2px dashed #b00; color: #b00; text-align: center; font-weight: bold; padding: 2mm; margin-top: 4mm; }
  .condicoes { font-size: 9pt; color: #444; margin-top: 6mm; }
  .assinatura { margin-top: 16mm; width: 60%; border-top: 1px solid #333; padding-top: 1mm; font-size: 9pt; }
</style></head><body>
  <header>
    <div>
      <h1>${esc(quem.nome)}</h1>
      ${quem.cnpj ? `<p>CNPJ ${esc(quem.cnpj)}</p>` : ''}
      ${quem.endereco ? `<p>${esc(quem.endereco)}</p>` : ''}
      ${quem.telefone ? `<p>${esc(quem.telefone)}</p>` : ''}
    </div>
    <div class="numero">
      <p class="rotulo">Pedido de compra</p>
      <p class="valor">Nº ${esc(pedido.number)}</p>
      <p class="rotulo">${esc(ROTULO_DO_STATUS[status] ?? status)}</p>
    </div>
  </header>
  ${rascunho ? '<p class="tarja">RASCUNHO — este pedido ainda não foi enviado e pode mudar.</p>' : ''}
  ${cancelado ? `<p class="tarja">CANCELADO${pedido.cancel_reason ? ` — ${esc(pedido.cancel_reason)}` : ''}</p>` : ''}

  <h2>Fornecedor</h2>
  <div class="grade">
    <div><p class="rotulo">Razão social</p><p style="margin:0">${esc(f.name)}</p></div>
    ${f.trade_name ? `<div><p class="rotulo">Nome fantasia</p><p style="margin:0">${esc(f.trade_name)}</p></div>` : ''}
    ${f.document ? `<div><p class="rotulo">CNPJ/CPF</p><p style="margin:0">${esc(f.document)}</p></div>` : ''}
    ${f.contact_name ? `<div><p class="rotulo">Contato</p><p style="margin:0">${esc(f.contact_name)}</p></div>` : ''}
    ${f.email ? `<div><p class="rotulo">E-mail</p><p style="margin:0">${esc(f.email)}</p></div>` : ''}
    ${f.phone ? `<div><p class="rotulo">Telefone</p><p style="margin:0">${esc(f.phone)}</p></div>` : ''}
  </div>

  <h2>Condições</h2>
  <div class="grade">
    <div><p class="rotulo">Emitido em</p><p style="margin:0">${dia(pedido.created_at)}</p></div>
    <div><p class="rotulo">Entrega prevista</p><p style="margin:0">${dia(pedido.expected_at)}</p></div>
    <div><p class="rotulo">Pagamento</p><p style="margin:0">${esc(prazo)}</p></div>
  </div>

  <h2>Itens</h2>
  <table>
    <thead><tr><th>Código</th><th>Descrição</th><th class="r">Qtde</th><th class="r">Custo unit.</th><th class="r">Total</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table>
  <p class="total">Total do pedido: ${brl(pedido.total_cents)}</p>
  ${pedido.notes ? `<h2>Observação</h2><p style="margin:0">${esc(pedido.notes)}</p>` : ''}

  <p class="condicoes">
    Este pedido registra o que foi combinado e <strong>não é documento fiscal</strong>. A mercadoria
    é conferida na chegada contra a nota fiscal; quantidade ou preço diferentes do pedido são
    tratados com o comprador antes do pagamento. Informe o número deste pedido na nota fiscal.
  </p>
  <div class="assinatura">${esc(quem.nome)} — comprador</div>
</body></html>`;

  return {
    html,
    numero: Number(pedido.number),
    status,
    fornecedor: f.trade_name || f.name,
    emailDoFornecedor: f.email && isDeliverableAddress(f.email) ? f.email.trim() : null,
  };
}

/** O pedido em TEXTO, para o corpo do e-mail — lê-se sem abrir o anexo. */
function corpoDoEmail(companyId: string, orderId: string): { subject: string; bodyText: string } {
  const pedido = getPurchaseOrder(companyId, orderId) as Record<string, unknown> & {
    items: ItemDoPedido[];
  };
  const quem = comprador(companyId);
  const f = fornecedorDoPedido(companyId, String(pedido.supplier_id));
  const itens = pedido.items
    .map(
      (i, n) =>
        `${n + 1}. ${i.description}${i.internal_code ? ` (${i.internal_code})` : ''} — `
        + `${qtd(i.quantity)} × ${brl(i.unit_cost_cents)} = ${brl(i.total_cents)}`,
    )
    .join('\n');
  return {
    subject: `Pedido de compra nº ${pedido.number} — ${quem.nome}`,
    bodyText:
      `Olá${f.contact_name ? `, ${f.contact_name}` : ''}.\n\n`
      + `Segue o pedido de compra nº ${pedido.number} de ${quem.nome}`
      + `${quem.cnpj ? ` (CNPJ ${quem.cnpj})` : ''}.\n\n`
      + `${itens}\n\n`
      + `Total do pedido: ${brl(pedido.total_cents)}\n`
      + `Entrega prevista: ${dia(pedido.expected_at)}\n`
      + (pedido.notes ? `Observação: ${pedido.notes}\n` : '')
      + '\nO pedido completo vai em anexo (abra e imprima pelo navegador). '
      + 'Por favor, informe o número deste pedido na nota fiscal.\n\n'
      + `${quem.nome}${quem.telefone ? ` — ${quem.telefone}` : ''}`,
  };
}

export interface ResultadoDoEnvioPorEmail {
  /** A mensagem entrou agora na fila (false = já havia uma igual pendente). */
  queued: boolean;
  toAddress: string;
  /** READY = o carteiro está configurado e entrega; READY_FOR_CREDENTIAL = fica na fila. */
  readiness: EmailReadiness;
  missing: string[];
  /** O pedido depois do gesto — rascunho enviado por e-mail passa a 'enviado'. */
  order: Record<string, unknown>;
}

/**
 * Manda o pedido ao fornecedor pela fila de e-mail.
 *
 * O endereço é o do CADASTRO do fornecedor; `para` só substitui quando quem
 * compra digita outro (o vendedor pediu no e-mail pessoal). Endereço
 * inutilizável é recusa com a frase do que falta — e não um "enviado" mudo.
 */
export function enviarPedidoPorEmail(input: {
  companyId: string;
  orderId: string;
  para?: string | null;
}): ResultadoDoEnvioPorEmail {
  ensureCoreSchema();
  return withTransaction(() => {
    const atual = getPurchaseOrder(input.companyId, input.orderId);
    const status = String(atual.status);
    if (status === 'cancelado') {
      throw new ApiError(
        'CORE_PURCHASE_ORDER_CANCELLED',
        'Pedido cancelado não vai ao fornecedor. Faça outro pedido.',
        409,
      );
    }
    if (status === 'recebido') {
      throw new ApiError(
        'CORE_PURCHASE_ORDER_RECEIVED',
        'Pedido já recebido — não há mais o que pedir ao fornecedor.',
        409,
      );
    }
    const f = fornecedorDoPedido(input.companyId, String(atual.supplier_id));
    const destino = String(input.para ?? '').trim() || String(f.email ?? '').trim();
    if (!isDeliverableAddress(destino)) {
      throw new ApiError(
        'CORE_SUPPLIER_EMAIL_REQUIRED',
        destino
          ? `"${destino}" não é um endereço de e-mail utilizável. Confira o e-mail do fornecedor.`
          : 'O fornecedor não tem e-mail no cadastro. Preencha em Compras › Fornecedores, '
            + 'ou imprima o pedido e envie por outro meio.',
        400,
      );
    }

    // O rascunho que vai por e-mail É enviado: o combinado não muda mais.
    if (status === 'rascunho') sendPurchaseOrder(input.companyId, input.orderId);

    const db = getConnection();
    /*
      UMA MENSAGEM PENDENTE POR PEDIDO E DESTINO.

      Sem SMTP configurado a mensagem fica na fila, e o comprador aperta o botão
      de novo achando que não foi. Repetir não pode enfileirar a segunda cópia:
      o fornecedor receberia dois pedidos iguais no dia em que a credencial
      existisse, e separaria mercadoria em dobro.
    */
    const pendente = db
      .prepare(
        `SELECT id FROM core_email_queue
          WHERE company_id = ? AND template = 'pedido_compra' AND status = 'pending'
            AND to_address = ? AND dedupe_key LIKE ?`,
      )
      .get(input.companyId, destino, `pedido_compra:${input.orderId}:%`) as { id: string } | undefined;

    let queued = false;
    if (!pendente) {
      const envios = db
        .prepare(
          `SELECT COUNT(*) AS n FROM core_email_queue
            WHERE company_id = ? AND dedupe_key LIKE ?`,
        )
        .get(input.companyId, `pedido_compra:${input.orderId}:%`) as { n: number };
      const papel = renderPurchaseOrderA4(input.companyId, input.orderId);
      const { subject, bodyText } = corpoDoEmail(input.companyId, input.orderId);
      const id = queuePedidoCompraEmail({
        companyId: input.companyId,
        toAddress: destino,
        subject,
        bodyText,
        anexoNome: `pedido-compra-${papel.numero}.html`,
        anexoBytes: Buffer.from(papel.html, 'utf8'),
        payload: { orderId: input.orderId, number: papel.numero, fornecedor: papel.fornecedor },
        dedupeKey: `pedido_compra:${input.orderId}:${Number(envios.n) + 1}`,
      });
      queued = id !== null;
    }

    const prontidao = emailStatus(input.companyId);
    return {
      queued,
      toAddress: destino,
      readiness: prontidao.readiness,
      missing: prontidao.missing,
      order: getPurchaseOrder(input.companyId, input.orderId),
    };
  });
}
