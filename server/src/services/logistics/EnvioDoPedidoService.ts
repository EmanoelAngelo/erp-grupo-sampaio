/**
 * ============================================================================
 * O ENVIO DO PEDIDO — etiqueta, despacho, rastreio e entrega com origem
 * (GAP-PRD-120, GAP-PRD-119)
 * ============================================================================
 *
 * ## O que havia
 *
 * Expedir era mudar o status e digitar um código num `window.prompt`. Nenhuma
 * tela chamava `/logistics/shipments`, que gravava QUALQUER corpo como
 * "quoted" — sem pedido, sem provedor. `logistics_labels` e
 * `logistics_tracking_events` não tinham escritor. O portal mostrava o código
 * como texto, sem transportadora e sem link; "entregue" era um clique do
 * operador sem origem declarada.
 *
 * ## O que há
 *
 *   pedido pago → PRONTIDÃO (o que falta, dito pelo nome)
 *              → ETIQUETA no provedor (carrinho → pagamento → geração)
 *              → DESPACHO (data e operador; o código de rastreio vem da
 *                etiqueta, ou é informado com a transportadora quando a
 *                encomenda foi postada fora do sistema)
 *              → RASTREIO (consulta ao provedor, pelo botão ou pela agenda;
 *                cada marco vira evento com origem "provedor"; a falha da
 *                consulta fica gravada e aparece no ERP e no portal)
 *              → ENTREGUE (pela transportadora — origem "provedor" — ou pelo
 *                operador, identificado, com origem "operador")
 *
 * ## O que NÃO se inventa
 *
 *   - sem NF-e autorizada do pedido, a etiqueta não é comprada — a menos que a
 *     operação tenha ligado a declaração de conteúdo, decisão do CONTADOR
 *     (`core_logistics_settings`, padrão desligado);
 *   - sem medidas, sem endereço do remetente, sem token utilizável, a compra é
 *     recusada ANTES de chamar o provedor, com a lista do que falta;
 *   - o destinatário é CONFIRMADO pelo operador: o endereço do pedido é um
 *     texto livre, e a sugestão de rua/número/bairro é só sugestão.
 *
 * ## Dinheiro
 *
 * Comprar etiqueta gasta saldo da carteira do Melhor Envio. A compra exige
 * chave de idempotência (clique duplo não compra duas), e só um envio VIVO por
 * pedido é aceito (índice parcial em `core_shipments`).
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { advanceFulfillment, isPickup, type OrderRecord } from '../core/StorefrontService.js';
import { buildOrderPackage, normalizeZip, type ShippingPackage } from '../core/OrderShippingService.js';
import { isValidCpf } from '../core/CatalogService.js';
import { isValidCnpj } from '../core/FiscalConfigService.js';
import { quoteLogisticsCarrier, resolveCarrierAccess, mensagemDoBloqueio } from './LogisticsCarrierAdapter.js';
import { getLogisticsCredentialRow, markCredentialTest } from './LogisticsCredentialService.js';
import { MelhorEnvioError } from './MelhorEnvioClient.js';
import type { PedidoDeEtiqueta, PessoaDoEnvio } from './MelhorEnvioEnvioClient.js';
import {
  abrirProvedorDeEnvio,
  type EstadoDoEnvio,
  type ProvedorDeEnvio,
  type SituacaoDoEnvio,
} from './ProvedorDeEnvio.js';
import {
  CODIGO_DOS_CORREIOS,
  isTransportadoraDoDespacho,
  linkDeRastreio,
  nomeDaTransportadora,
  normalizarCodigo,
} from './RastreioPublico.js';
import { ROTULO_DO_ENVIO } from './RastreioDoCliente.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';

// ------------------------------------------------------------------ vocabulário

export { ROTULO_DO_ENVIO };

export type OrigemDoEnvio = 'operador' | 'provedor' | 'sistema';

/** Estados em que o rastreio ainda tem o que dizer. */
const SINCRONIZAVEIS: EstadoDoEnvio[] = ['paga', 'etiqueta_gerada', 'postado', 'nao_entregue'];

/** Etapas do pedido antes da encomenda sair. */
const ANTES_DO_DESPACHO = new Set(['pago', 'separacao', 'conferencia', 'embalado']);

const UFS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------------ linhas

interface LinhaDoEnvio {
  id: string;
  company_id: string;
  order_id: string;
  channel: 'melhor_envio' | 'manual';
  carrier: string;
  provider_ref: string | null;
  provider_protocol: string | null;
  service_code: string | null;
  service_name: string | null;
  environment: 'sandbox' | 'production' | null;
  status: EstadoDoEnvio;
  tracking_code: string | null;
  price_cents: number | null;
  invoice_key: string | null;
  content_declaration: number;
  last_error: string | null;
  last_sync_at: string | null;
  last_sync_ok: number | null;
  last_sync_message: string | null;
  created_by: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  delivered_at: string | null;
  delivered_origin: string | null;
  cancelled_at: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

interface LinhaDoEvento {
  id: string;
  status: string;
  description: string;
  occurred_at: string;
  origin: string;
  user_id: string | null;
  user_name?: string | null;
}

interface LinhaDoPedido {
  id: string;
  company_id: string;
  number: number;
  status: string;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_document: string | null;
  shipping_zip: string | null;
  shipping_address: string | null;
  shipping_method: string | null;
  shipping_service_name: string | null;
  shipping_carrier: string | null;
  tracking_code: string | null;
  items_cents: number;
}

function db() {
  return getConnection();
}

function digitos(valor: unknown): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function texto(valor: unknown): string {
  return String(valor ?? '').trim();
}

function lerPedido(companyId: string, orderId: string): LinhaDoPedido {
  const pedido = db()
    .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as unknown as LinhaDoPedido | undefined;
  // O pedido da outra empresa responde o MESMO 404 do inexistente.
  if (!pedido) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
  return pedido;
}

function lerEnvio(companyId: string, shipmentId: string): LinhaDoEnvio {
  const linha = db()
    .prepare('SELECT * FROM core_shipments WHERE id = ? AND company_id = ?')
    .get(shipmentId, companyId) as unknown as LinhaDoEnvio | undefined;
  if (!linha) throw new ApiError('LOGISTICS_SHIPMENT_NOT_FOUND', 'Envio não encontrado.', 404);
  return linha;
}

function envioVivo(orderId: string): LinhaDoEnvio | null {
  return (
    (db()
      .prepare("SELECT * FROM core_shipments WHERE order_id = ? AND status <> 'cancelado' ORDER BY created_at DESC LIMIT 1")
      .get(orderId) as unknown as LinhaDoEnvio | undefined) ?? null
  );
}

function eventosDoEnvio(shipmentId: string): LinhaDoEvento[] {
  return db()
    .prepare(
      `SELECT e.id, e.status, e.description, e.occurred_at, e.origin, e.user_id,
              u.display_name AS user_name
         FROM core_shipment_events e
         LEFT JOIN core_users u ON u.id = e.user_id
        WHERE e.shipment_id = ?
        ORDER BY e.occurred_at, e.created_at`,
    )
    .all(shipmentId) as unknown as LinhaDoEvento[];
}

function registrarEvento(input: {
  envio: LinhaDoEnvio;
  status: string;
  descricao: string;
  em?: string;
  origem: OrigemDoEnvio;
  userId?: string | null;
  chave: string;
}): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO core_shipment_events
         (id, company_id, shipment_id, order_id, status, description, occurred_at, origin, user_id, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.envio.company_id,
      input.envio.id,
      input.envio.order_id,
      input.status,
      input.descricao,
      input.em ?? new Date().toISOString(),
      input.origem,
      input.userId ?? null,
      input.chave,
      new Date().toISOString(),
    );
}

function atualizarEnvio(id: string, campos: Partial<Record<keyof LinhaDoEnvio, unknown>>): void {
  const chaves = Object.keys(campos);
  if (chaves.length === 0) return;
  const sets = [...chaves.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ');
  db()
    .prepare(`UPDATE core_shipments SET ${sets} WHERE id = ?`)
    .run(...(chaves.map((c) => campos[c as keyof LinhaDoEnvio]) as never[]), new Date().toISOString(), id);
}

function mensagemDoErro(err: unknown, padrao: string): string {
  if (err instanceof MelhorEnvioError || err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : padrao;
}

// ------------------------------------------------------------------ resposta

export interface AcoesDoEnvio {
  pagarEGerar: boolean;
  imprimir: boolean;
  sincronizar: boolean;
  cancelar: boolean;
}

function acoesDe(l: LinhaDoEnvio): AcoesDoEnvio {
  const provedor = l.channel === 'melhor_envio' && Boolean(l.provider_ref);
  return {
    pagarEGerar: provedor && (l.status === 'pendente' || l.status === 'paga'),
    imprimir: provedor && (l.status === 'etiqueta_gerada' || l.status === 'postado'),
    sincronizar: provedor && SINCRONIZAVEIS.includes(l.status),
    cancelar: provedor && (l.status === 'pendente' || l.status === 'paga' || l.status === 'etiqueta_gerada'),
  };
}

export function envioParaResposta(l: LinhaDoEnvio) {
  return {
    id: l.id,
    orderId: l.order_id,
    channel: l.channel,
    carrier: l.carrier,
    carrierName: nomeDaTransportadora(l.carrier),
    serviceCode: l.service_code,
    serviceName: l.service_name,
    environment: l.environment,
    status: l.status,
    statusLabel: ROTULO_DO_ENVIO[l.status] ?? l.status,
    trackingCode: l.tracking_code,
    trackingUrl: linkDeRastreio(l.carrier, l.tracking_code),
    priceCents: l.price_cents,
    invoiceKey: l.invoice_key,
    contentDeclaration: l.content_declaration === 1,
    lastError: l.last_error,
    lastSync: l.last_sync_at
      ? { at: l.last_sync_at, ok: l.last_sync_ok === 1, message: l.last_sync_message }
      : null,
    dispatchedAt: l.dispatched_at,
    dispatchedBy: l.dispatched_by,
    deliveredAt: l.delivered_at,
    deliveredOrigin: l.delivered_origin,
    cancelledAt: l.cancelled_at,
    createdAt: l.created_at,
    actions: acoesDe(l),
    events: eventosDoEnvio(l.id).map((e) => ({
      status: e.status,
      description: e.description,
      occurredAt: e.occurred_at,
      origin: e.origin,
      userName: e.user_name ?? null,
    })),
  };
}

export type EnvioResposta = ReturnType<typeof envioParaResposta>;

// ------------------------------------------------------------ configuração

export interface ConfiguracaoDeEnvio {
  permitirDeclaracaoDeConteudo: boolean;
  agenciaJadlog: string | null;
  atualizadoEm: string | null;
}

export function lerConfiguracaoDeEnvio(companyId: string): ConfiguracaoDeEnvio {
  ensureCoreSchema();
  const linha = db()
    .prepare('SELECT * FROM core_logistics_settings WHERE company_id = ?')
    .get(companyId) as
    | { allow_content_declaration: number; jadlog_agency_id: string | null; updated_at: string }
    | undefined;
  return {
    // Sem linha, o padrão SEGURO: sem nota, sem etiqueta.
    permitirDeclaracaoDeConteudo: linha?.allow_content_declaration === 1,
    agenciaJadlog: linha?.jadlog_agency_id ?? null,
    atualizadoEm: linha?.updated_at ?? null,
  };
}

export function salvarConfiguracaoDeEnvio(
  companyId: string,
  entrada: { permitirDeclaracaoDeConteudo?: unknown; agenciaJadlog?: unknown },
  userId: string | null,
): ConfiguracaoDeEnvio {
  ensureCoreSchema();
  if (entrada.permitirDeclaracaoDeConteudo !== undefined && typeof entrada.permitirDeclaracaoDeConteudo !== 'boolean') {
    throw new ApiError('LOGISTICS_SETTINGS_INVALID', 'Informe sim ou não para a declaração de conteúdo.', 400);
  }
  const agencia = texto(entrada.agenciaJadlog);
  if (agencia && !/^\d{1,12}$/.test(agencia)) {
    throw new ApiError(
      'LOGISTICS_SETTINGS_INVALID',
      'A agência Jadlog é o NÚMERO que o Melhor Envio mostra na lista de agências (só dígitos).',
      400,
    );
  }
  const atual = lerConfiguracaoDeEnvio(companyId);
  const permitir =
    entrada.permitirDeclaracaoDeConteudo === undefined
      ? atual.permitirDeclaracaoDeConteudo
      : Boolean(entrada.permitirDeclaracaoDeConteudo);
  const agora = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO core_logistics_settings (company_id, allow_content_declaration, jadlog_agency_id, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         allow_content_declaration = excluded.allow_content_declaration,
         jadlog_agency_id = excluded.jadlog_agency_id,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(companyId, permitir ? 1 : 0, agencia || null, userId, agora);
  recordAudit({
    companyId,
    userId,
    action: 'logistics.shipping_settings_saved',
    entityType: 'logistics_settings',
    entityId: companyId,
    detail: { permitirDeclaracaoDeConteudo: permitir, agenciaJadlog: agencia || null },
  });
  return lerConfiguracaoDeEnvio(companyId);
}

// ------------------------------------------------------------- remetente

interface Remetente {
  pessoa: PessoaDoEnvio | null;
  faltando: string[];
}

/** O remetente é a operação, pelo cadastro fiscal — o mesmo endereço do emitente. */
function remetenteDaEmpresa(companyId: string): Remetente {
  const r = db()
    .prepare(
      `SELECT c.trade_name AS company_name, f.legal_name, f.trade_name, f.cnpj, f.ie,
              f.street, f.number, f.complement, f.district, f.city_name, f.uf, f.zip, f.phone
         FROM core_companies c
         LEFT JOIN core_fiscal_configs f ON f.company_id = c.id
        WHERE c.id = ?`,
    )
    .get(companyId) as Record<string, string | null> | undefined;
  const faltando: string[] = [];
  const nome = texto(r?.legal_name) || texto(r?.trade_name) || texto(r?.company_name);
  const cnpj = digitos(r?.cnpj);
  if (!nome) faltando.push('razão social');
  if (!isValidCnpj(cnpj)) faltando.push('CNPJ');
  if (!texto(r?.street)) faltando.push('rua');
  if (!texto(r?.number)) faltando.push('número');
  if (!texto(r?.district)) faltando.push('bairro');
  if (!texto(r?.city_name)) faltando.push('cidade');
  if (!UFS.has(texto(r?.uf).toUpperCase())) faltando.push('UF');
  if (!normalizeZip(r?.zip)) faltando.push('CEP');
  const fone = digitos(r?.phone);
  if (fone.length < 10 || fone.length > 11) faltando.push('telefone');
  if (faltando.length > 0) return { pessoa: null, faltando };

  const credencial = getLogisticsCredentialRow(companyId, 'melhor_envio');
  return {
    faltando,
    pessoa: {
      nome,
      telefone: fone,
      email: texto(credencial?.contactEmail) || null,
      cpf: null,
      cnpj,
      inscricaoEstadual: texto(r?.ie) || null,
      logradouro: texto(r?.street),
      numero: texto(r?.number),
      complemento: texto(r?.complement) || null,
      bairro: texto(r?.district),
      cidade: texto(r?.city_name),
      uf: texto(r?.uf).toUpperCase(),
      cep: normalizeZip(r?.zip) as string,
    },
  };
}

/** O que falta no cadastro do remetente para a etiqueta sair (vazio = completo). */
export function pendenciasDoRemetente(companyId: string): string[] {
  ensureCoreSchema();
  return remetenteDaEmpresa(companyId).faltando;
}

// ------------------------------------------------------------- destinatário

export interface DestinatarioInformado {
  nome: string;
  documento: string;
  telefone: string | null;
  email: string | null;
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

/**
 * A sugestão de rua/número/bairro/cidade/UF a partir do endereço LIVRE do
 * pedido ("Rua das Flores, 123 - Centro, Porto Alegre/RS"). É só sugestão: a
 * tela mostra os campos preenchidos e quem confirma é o operador.
 */
export function sugerirEndereco(bruto: string | null | undefined): Partial<DestinatarioInformado> {
  const partes = String(bruto ?? '')
    .split(/\s*[,;]\s*|\s+-\s+|\s*\n\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes.length === 0) return {};
  const sugestao: Partial<DestinatarioInformado> = {};

  let primeira = partes.shift() as string;
  const comNumero = primeira.match(/^(.*?)[\s,]+(?:n[º°o.]?\s*)?(\d+[A-Za-z]?)$/i);
  if (comNumero) {
    primeira = comNumero[1];
    sugestao.numero = comNumero[2];
  } else if (partes[0] && /^(?:n[º°o.]?\s*)?\d+[A-Za-z]?$/i.test(partes[0])) {
    sugestao.numero = (partes.shift() as string).replace(/^n[º°o.]?\s*/i, '');
  }
  sugestao.logradouro = primeira;

  // Cidade/UF no fim: "Porto Alegre/RS", "Porto Alegre - RS", "Canoas RS".
  const ultima = partes[partes.length - 1];
  if (ultima) {
    const m = ultima.match(/^(.*?)[\s/-]*\b([A-Za-z]{2})$/);
    if (m && UFS.has(m[2].toUpperCase())) {
      sugestao.uf = m[2].toUpperCase();
      partes.pop();
      if (m[1].trim()) sugestao.cidade = m[1].trim();
      else if (partes.length > 0) sugestao.cidade = partes.pop();
    }
  }
  if (partes.length > 0) sugestao.bairro = partes.shift();
  if (partes.length > 0) sugestao.complemento = partes.join(', ');
  return sugestao;
}

function destinatarioSugerido(pedido: LinhaDoPedido): Partial<DestinatarioInformado> {
  const cliente = pedido.customer_id
    ? (db().prepare('SELECT phone, email FROM core_customers WHERE id = ?').get(pedido.customer_id) as
      | { phone: string | null; email: string | null }
      | undefined)
    : undefined;
  return {
    nome: pedido.customer_name,
    documento: digitos(pedido.customer_document),
    telefone: digitos(cliente?.phone) || null,
    email: pedido.customer_email ?? cliente?.email ?? null,
    cep: normalizeZip(pedido.shipping_zip) ?? '',
    ...sugerirEndereco(pedido.shipping_address),
  };
}

/** Confere o destinatário que o operador confirmou. Recusa com a lista inteira. */
function validarDestinatario(bruto: unknown, pedido: LinhaDoPedido): PessoaDoEnvio {
  const d = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const problemas: string[] = [];
  const nome = texto(d.nome);
  const documento = digitos(d.documento);
  const telefone = digitos(d.telefone);
  const email = texto(d.email);
  const cep = normalizeZip(texto(d.cep));
  const uf = texto(d.uf).toUpperCase();

  if (nome.length < 3) problemas.push('nome');
  const cpf = documento.length === 11 && isValidCpf(documento);
  const cnpj = documento.length === 14 && isValidCnpj(documento);
  if (!cpf && !cnpj) problemas.push('CPF ou CNPJ válido');
  if (telefone && (telefone.length < 10 || telefone.length > 11)) problemas.push('telefone com DDD');
  if (email && !EMAIL.test(email)) problemas.push('e-mail');
  if (!texto(d.logradouro)) problemas.push('rua');
  if (!texto(d.numero)) problemas.push('número');
  if (!texto(d.bairro)) problemas.push('bairro');
  if (!texto(d.cidade)) problemas.push('cidade');
  if (!UFS.has(uf)) problemas.push('UF');
  if (!cep) problemas.push('CEP');
  if (problemas.length > 0) {
    throw new ApiError(
      'LOGISTICS_RECIPIENT_INVALID',
      `Confira o destinatário: ${problemas.join(', ')}.`,
      400,
      { campos: problemas },
    );
  }
  // O frete foi cotado para o CEP do pedido. Trocar o CEP aqui compraria
  // etiqueta para outro lugar, por outro preço, sem o cliente saber.
  const doPedido = normalizeZip(pedido.shipping_zip);
  if (doPedido && cep !== doPedido) {
    throw new ApiError(
      'LOGISTICS_RECIPIENT_ZIP_MISMATCH',
      `O CEP do destinatário (${cep}) é diferente do CEP do pedido (${doPedido}). O frete foi cotado para o CEP do pedido.`,
      409,
    );
  }
  return {
    nome,
    telefone: telefone || null,
    email: email || null,
    cpf: cpf ? documento : null,
    cnpj: cnpj ? documento : null,
    inscricaoEstadual: null,
    logradouro: texto(d.logradouro),
    numero: texto(d.numero),
    complemento: texto(d.complemento) || null,
    bairro: texto(d.bairro),
    cidade: texto(d.cidade),
    uf,
    cep: cep as string,
  };
}

// ------------------------------------------------------------- nota e serviço

interface NotaDoPedido {
  chave: string;
  numero: number;
  ambiente: string;
}

function notaDoPedido(companyId: string, orderId: string): NotaDoPedido | null {
  const nota = db()
    .prepare(
      `SELECT access_key, number, environment FROM core_fiscal_documents
        WHERE company_id = ? AND order_id = ? AND model = '55' AND status = 'AUTHORIZED'
          AND access_key IS NOT NULL
        ORDER BY COALESCE(authorized_at, created_at) DESC LIMIT 1`,
    )
    .get(companyId, orderId) as { access_key: string; number: number; environment: string } | undefined;
  return nota ? { chave: nota.access_key, numero: Number(nota.number), ambiente: nota.environment } : null;
}

const PREFIXO_ME = 'transportadora:melhor_envio:';

function servicoDoPedido(pedido: LinhaDoPedido): { code: string; name: string } | null {
  const metodo = String(pedido.shipping_method ?? '');
  if (!metodo.startsWith(PREFIXO_ME)) return null;
  const code = metodo.slice(PREFIXO_ME.length).trim();
  if (!code) return null;
  return { code, name: pedido.shipping_service_name ?? `Serviço ${code}` };
}

function ehJadlog(nomeDoServico: string | null | undefined): boolean {
  return /jadlog/i.test(String(nomeDoServico ?? ''));
}

// ------------------------------------------------------------- prontidão

export interface PendenciaDoEnvio {
  chave: string;
  mensagem: string;
  /** A tela onde se resolve, quando há uma. */
  onde: string | null;
}

export interface ProntidaoDaEtiqueta {
  pedido: { id: string; number: number; status: string; entrega: boolean };
  canal: { mode: string; ambiente: 'sandbox' | 'production' | null; disponivel: boolean; motivo: string | null };
  envioVivo: { id: string; status: EstadoDoEnvio; channel: string } | null;
  servico: { code: string; name: string } | null;
  pacote: ShippingPackage | null;
  remetente: { nome: string; cidade: string; uf: string; cep: string } | null;
  destinatarioSugerido: Partial<DestinatarioInformado>;
  nota: NotaDoPedido | null;
  declaracaoDeConteudoPermitida: boolean;
  faltando: PendenciaDoEnvio[];
  podeComprar: boolean;
}

/**
 * O que falta para comprar a etiqueta DESTE pedido — perguntado antes de
 * mostrar o botão. Só dois desfechos honestos: o botão compra, ou a tela diz
 * o que falta.
 */
export function prontidaoDaEtiqueta(companyId: string, orderId: string): ProntidaoDaEtiqueta {
  ensureCoreSchema();
  const pedido = lerPedido(companyId, orderId);
  const faltando: PendenciaDoEnvio[] = [];
  const entrega = !isPickup(pedido.shipping_method);

  if (!entrega) {
    faltando.push({ chave: 'retirada', mensagem: 'Pedido de retirada: não há envio.', onde: null });
  }
  if (pedido.status === 'aguardando_pagamento') {
    faltando.push({ chave: 'pagamento', mensagem: 'O pedido ainda não foi pago.', onde: null });
  } else if (pedido.status === 'cancelado' || pedido.status === 'reembolsado') {
    faltando.push({ chave: 'parado', mensagem: 'Pedido cancelado ou reembolsado não é enviado.', onde: null });
  } else if (!ANTES_DO_DESPACHO.has(pedido.status)) {
    faltando.push({ chave: 'despachado', mensagem: 'O pedido já saiu da loja.', onde: null });
  }

  const vivo = envioVivo(orderId);
  if (vivo) {
    faltando.push({
      chave: 'envio_vivo',
      mensagem: `Este pedido já tem um envio (${ROTULO_DO_ENVIO[vivo.status] ?? vivo.status}). Cancele-o antes de comprar outra etiqueta.`,
      onde: null,
    });
  }

  const access = resolveCarrierAccess(companyId, 'melhor_envio');
  const disponivel = access.realCalls && (access.mode === 'production' || access.mode === 'sandbox');
  const motivoDoCanal = disponivel
    ? null
    : access.mode === 'none'
      ? 'Nenhum token do Melhor Envio guardado nesta operação.'
      : mensagemDoBloqueio(access);
  if (!disponivel) {
    faltando.push({ chave: 'transportadora', mensagem: motivoDoCanal as string, onde: '/sistema/loja/logistica' });
  }

  let pacote: ShippingPackage | null = null;
  try {
    const p = buildOrderPackage({ companyId, orderId });
    if (p.ok) pacote = p.package;
    else {
      faltando.push({
        chave: 'medidas',
        mensagem: `Faltam peso e medidas em: ${p.missing.map((m) => `${m.productName} (${m.missing.join(', ')})`).join('; ')}.`,
        onde: '/sistema/produtos/prontidao-online',
      });
    }
  } catch (err) {
    faltando.push({ chave: 'medidas', mensagem: mensagemDoErro(err, 'Pedido sem itens.'), onde: null });
  }

  const remetente = remetenteDaEmpresa(companyId);
  if (!remetente.pessoa) {
    faltando.push({
      chave: 'remetente',
      mensagem: `Complete o endereço do remetente em Fiscal → Configuração: ${remetente.faltando.join(', ')}.`,
      onde: '/sistema/fiscal/configuracao',
    });
  }

  const config = lerConfiguracaoDeEnvio(companyId);
  const nota = notaDoPedido(companyId, orderId);
  const notaDeHomologacao = nota !== null && access.mode === 'production' && nota.ambiente !== 'production';
  if ((!nota || notaDeHomologacao) && !config.permitirDeclaracaoDeConteudo) {
    faltando.push({
      chave: 'nota',
      mensagem: notaDeHomologacao
        ? 'A NF-e deste pedido é de homologação e não vale para postar. Emita a NF-e de produção.'
        : 'Emita a NF-e do pedido antes de comprar a etiqueta: a transportadora exige a chave da nota '
          + 'no envio de empresa. (Envio com declaração de conteúdo é decisão do contador, em Loja → Logística.)',
      onde: null,
    });
  }

  const servico = servicoDoPedido(pedido);
  if (servico && ehJadlog(servico.name) && !config.agenciaJadlog) {
    faltando.push({
      chave: 'agencia_jadlog',
      mensagem: 'Serviço Jadlog exige a agência de postagem. Informe-a em Loja → Logística.',
      onde: '/sistema/loja/logistica',
    });
  }

  return {
    pedido: { id: pedido.id, number: pedido.number, status: pedido.status, entrega },
    canal: {
      mode: access.mode,
      ambiente: disponivel ? (access.mode === 'production' ? 'production' : 'sandbox') : null,
      disponivel,
      motivo: motivoDoCanal,
    },
    envioVivo: vivo ? { id: vivo.id, status: vivo.status, channel: vivo.channel } : null,
    servico,
    pacote,
    remetente: remetente.pessoa
      ? { nome: remetente.pessoa.nome, cidade: remetente.pessoa.cidade, uf: remetente.pessoa.uf, cep: remetente.pessoa.cep }
      : null,
    destinatarioSugerido: destinatarioSugerido(pedido),
    nota,
    declaracaoDeConteudoPermitida: config.permitirDeclaracaoDeConteudo,
    faltando,
    podeComprar: faltando.length === 0,
  };
}

// ------------------------------------------------------------- serviços

/**
 * Os serviços do Melhor Envio para o pacote DESTE pedido — para quando o
 * pedido foi vendido com a tabela da loja e o operador escolhe por quem
 * mandar. Só cotação real; simulação não compra etiqueta.
 */
export async function servicosParaOPedido(companyId: string, orderId: string) {
  const pronto = prontidaoDaEtiqueta(companyId, orderId);
  const cep = normalizeZip(lerPedido(companyId, orderId).shipping_zip);
  const remetente = remetenteDaEmpresa(companyId).pessoa;
  if (!pronto.canal.disponivel || !pronto.pacote || !cep || !remetente) {
    return {
      options: [],
      message: !cep
        ? 'O pedido não tem CEP de entrega.'
        : (pronto.faltando.find((f) => ['transportadora', 'medidas', 'remetente'].includes(f.chave))?.mensagem
          ?? 'Não dá para cotar este pedido agora.'),
    };
  }
  const r = await quoteLogisticsCarrier(companyId, 'melhor_envio', {
    originZipCode: remetente.cep,
    destinationZipCode: cep,
    ...pronto.pacote,
  });
  return {
    options: (r.options ?? [])
      .filter((o) => o.real)
      .map((o) => ({
        code: o.serviceCode,
        name: o.serviceName,
        priceCents: o.priceInCents,
        estimatedDays: Number.isFinite(o.estimatedDays) ? o.estimatedDays : null,
        environment: o.environment ?? null,
      })),
    message: r.message ?? null,
  };
}

// ------------------------------------------------------------- compra

function itensDoPedido(orderId: string) {
  return (
    db()
      .prepare('SELECT description, quantity, unit_price_cents FROM core_order_items WHERE order_id = ?')
      .all(orderId) as unknown as { description: string; quantity: number; unit_price_cents: number }[]
  ).map((i) => ({ nome: i.description, quantidade: Number(i.quantity), valorUnitarioCents: Number(i.unit_price_cents) }));
}

function nomeDaLoja(companyId: string): string {
  const c = db().prepare('SELECT trade_name FROM core_companies WHERE id = ?').get(companyId) as
    | { trade_name: string }
    | undefined;
  return c?.trade_name ?? 'Loja';
}

export interface ResultadoDaCompra {
  envio: EnvioResposta;
  /** Preenchido quando a compra parou no meio (saldo, geração): o envio existe e se retoma. */
  aviso: string | null;
}

/**
 * Compra a etiqueta do pedido no provedor: carrinho → pagamento → geração.
 *
 * Se o carrinho falhar, nada é gravado (o provedor também não tem nada). Se o
 * pagamento ou a geração falharem, o envio fica gravado no estado em que
 * parou, com a frase do provedor, e se retoma por `continuarEtiqueta` — sem
 * criar um segundo envio no provedor.
 */
export async function comprarEtiqueta(input: {
  companyId: string;
  orderId: string;
  userId: string | null;
  idempotencyKey: string;
  destinatario: unknown;
  servico?: { code?: unknown; name?: unknown } | null;
}): Promise<ResultadoDaCompra> {
  ensureCoreSchema();
  const chave = texto(input.idempotencyKey);
  if (!chave) throw new ApiError('API_IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key obrigatória.', 400);

  const repetido = db()
    .prepare('SELECT * FROM core_shipments WHERE company_id = ? AND idempotency_key = ?')
    .get(input.companyId, chave) as unknown as LinhaDoEnvio | undefined;
  /*
    O CLIQUE DUPLO É O MESMO PEDIDO — e a mesma chave com outro não é
    (RES-IDEM-VIZ). O reenvio devolvia o envio da chave sem olhar pedido,
    serviço nem destinatário: a etiqueta do pedido A respondia pelo B, e a do
    B nunca era comprada. A recusa é 422, antes do provedor e de qualquer
    escrita; envio anterior à impressão (nula) segue a regra de sempre.
  */
  const impressao = Impressao.impressaoDe({
    pedido: input.orderId,
    servico: texto(input.servico?.code),
    destinatario: input.destinatario ?? null,
  });
  if (repetido) {
    const gravada = (repetido as unknown as { idempotency_fingerprint?: string | null }).idempotency_fingerprint;
    if (Impressao.outraImpressao(gravada, impressao)) {
      throw Impressao.chaveReusada('outra etiqueta', { shipmentId: repetido.id });
    }
    return { envio: envioParaResposta(repetido), aviso: repetido.last_error };
  }

  const pronto = prontidaoDaEtiqueta(input.companyId, input.orderId);
  if (!pronto.podeComprar) {
    throw new ApiError(
      'LOGISTICS_LABEL_NOT_READY',
      `Ainda não dá para comprar a etiqueta: ${pronto.faltando.map((f) => f.mensagem).join(' ')}`,
      409,
      { faltando: pronto.faltando },
    );
  }

  const pedido = lerPedido(input.companyId, input.orderId);
  const codigoInformado = texto(input.servico?.code);
  const servico = codigoInformado
    ? { code: codigoInformado, name: texto(input.servico?.name) || `Serviço ${codigoInformado}` }
    : pronto.servico;
  if (!servico) {
    throw new ApiError(
      'LOGISTICS_SERVICE_REQUIRED',
      'Escolha o serviço do Melhor Envio: este pedido foi vendido sem transportadora (tabela da loja).',
      400,
    );
  }
  if (!/^\d+$/.test(servico.code)) {
    throw new ApiError('LOGISTICS_SERVICE_INVALID', 'Serviço do Melhor Envio desconhecido.', 400);
  }
  const config = lerConfiguracaoDeEnvio(input.companyId);
  if (ehJadlog(servico.name) && !config.agenciaJadlog) {
    throw new ApiError(
      'LOGISTICS_JADLOG_AGENCY_REQUIRED',
      'Serviço Jadlog exige a agência de postagem. Informe-a em Loja → Logística.',
      409,
    );
  }

  const destinatario = validarDestinatario(input.destinatario, pedido);
  const remetente = remetenteDaEmpresa(input.companyId).pessoa as PessoaDoEnvio;
  const nota = pronto.nota && !(pronto.canal.ambiente === 'production' && pronto.nota.ambiente !== 'production')
    ? pronto.nota
    : null;
  const provedor = abrirProvedorDeEnvio(input.companyId);

  const pedidoDeEtiqueta: PedidoDeEtiqueta = {
    servico: servico.code,
    agencia: ehJadlog(servico.name) ? config.agenciaJadlog : null,
    remetente,
    destinatario,
    itens: itensDoPedido(input.orderId),
    volume: pronto.pacote as ShippingPackage,
    valorDeclaradoCents: (pronto.pacote as ShippingPackage).declaredValueInCents,
    chaveDaNota: nota?.chave ?? null,
    declaracaoDeConteudo: !nota,
    identificacao: `Pedido #${pedido.number} — ${nomeDaLoja(input.companyId)}`,
  };

  let carrinho;
  try {
    carrinho = await provedor.colocarNoCarrinho(pedidoDeEtiqueta);
  } catch (err) {
    const mensagem = mensagemDoErro(err, 'Falha ao criar o envio no provedor.');
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'logistics.label_failed',
      entityType: 'order',
      entityId: input.orderId,
      detail: { etapa: 'carrinho', servico: servico.code, ambiente: provedor.ambiente, mensagem },
    });
    throw new ApiError('LOGISTICS_PROVIDER_ERROR', mensagem, 502);
  }

  const agora = new Date().toISOString();
  const id = randomUUID();
  try {
    withTransaction(() => {
      db()
        .prepare(
          `INSERT INTO core_shipments
             (id, company_id, order_id, channel, carrier, provider_ref, provider_protocol, service_code, service_name,
              environment, status, price_cents, invoice_key, content_declaration, created_by, idempotency_key,
              created_at, updated_at, idempotency_fingerprint)
           VALUES (?, ?, ?, 'melhor_envio', 'melhor_envio', ?, ?, ?, ?, ?, 'pendente', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          input.orderId,
          carrinho.id,
          carrinho.protocolo,
          servico.code,
          servico.name,
          provedor.ambiente,
          carrinho.precoCents,
          nota?.chave ?? null,
          nota ? 0 : 1,
          input.userId,
          chave,
          agora,
          agora,
          impressao,
        );
      registrarEvento({
        envio: lerEnvio(input.companyId, id),
        status: 'pendente',
        descricao: `Envio criado no Melhor Envio (${servico.name})`,
        origem: 'operador',
        userId: input.userId,
        chave: 'me:created_at',
      });
    });
  } catch (err) {
    // Dois cliques com chaves diferentes: o índice parcial recusa o segundo
    // envio vivo. O carrinho do provedor recebeu um item a mais — sai.
    await provedor.removerDoCarrinho(carrinho.id).catch(() => undefined);
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new ApiError('LOGISTICS_SHIPMENT_EXISTS', 'Este pedido já tem um envio em andamento.', 409);
    }
    throw err;
  }

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'logistics.label_created',
    entityType: 'shipment',
    entityId: id,
    detail: {
      orderId: input.orderId,
      servico: servico.code,
      ambiente: provedor.ambiente,
      precoCents: carrinho.precoCents,
      comNota: Boolean(nota),
    },
  });

  return continuarComProvedor(input.companyId, id, input.userId, provedor);
}

/** Retoma a compra parada (saldo que faltou, geração que falhou). */
export async function continuarEtiqueta(companyId: string, shipmentId: string, userId: string | null): Promise<ResultadoDaCompra> {
  ensureCoreSchema();
  const envio = lerEnvio(companyId, shipmentId);
  if (envio.channel !== 'melhor_envio' || !envio.provider_ref) {
    throw new ApiError('LOGISTICS_SHIPMENT_MANUAL', 'Envio registrado à mão não tem etiqueta no provedor.', 409);
  }
  return continuarComProvedor(companyId, shipmentId, userId, abrirProvedorDeEnvio(companyId));
}

async function continuarComProvedor(
  companyId: string,
  shipmentId: string,
  userId: string | null,
  provedor: ProvedorDeEnvio,
): Promise<ResultadoDaCompra> {
  let envio = lerEnvio(companyId, shipmentId);
  const ref = envio.provider_ref as string;
  if (envio.environment && envio.environment !== provedor.ambiente) {
    throw new ApiError(
      'LOGISTICS_ENVIRONMENT_CHANGED',
      `Este envio foi criado no ${envio.environment === 'production' ? 'Melhor Envio de produção' : 'sandbox'}, `
        + 'e a credencial guardada agora é de outro ambiente. Cancele-o e compre de novo.',
      409,
    );
  }

  if (envio.status === 'pendente') {
    try {
      await provedor.pagar(ref);
      withTransaction(() => {
        atualizarEnvio(shipmentId, { status: 'paga', last_error: null });
        registrarEvento({
          envio,
          status: 'paga',
          descricao: 'Etiqueta paga com o saldo do Melhor Envio',
          origem: 'operador',
          userId,
          chave: 'me:paid_at',
        });
      });
    } catch (err) {
      const mensagem = mensagemDoErro(err, 'Falha ao pagar a etiqueta.');
      atualizarEnvio(shipmentId, { last_error: mensagem });
      return {
        envio: envioParaResposta(lerEnvio(companyId, shipmentId)),
        aviso: `O envio está no carrinho do Melhor Envio, mas não foi pago: ${mensagem}`,
      };
    }
    envio = lerEnvio(companyId, shipmentId);
  }

  if (envio.status === 'paga') {
    try {
      await provedor.gerar(ref);
      withTransaction(() => {
        atualizarEnvio(shipmentId, { status: 'etiqueta_gerada', last_error: null });
        registrarEvento({
          envio,
          status: 'etiqueta_gerada',
          descricao: 'Etiqueta gerada',
          origem: 'operador',
          userId,
          chave: 'me:generated_at',
        });
      });
      markCredentialTest(companyId, 'melhor_envio', 'label_ok', undefined, { kind: 'label', ok: true });
    } catch (err) {
      const mensagem = mensagemDoErro(err, 'Falha ao gerar a etiqueta.');
      atualizarEnvio(shipmentId, { last_error: mensagem });
      markCredentialTest(companyId, 'melhor_envio', 'label_failed', undefined, { kind: 'label', ok: false, message: mensagem });
      return {
        envio: envioParaResposta(lerEnvio(companyId, shipmentId)),
        aviso: `A etiqueta foi paga, mas não foi gerada: ${mensagem}`,
      };
    }
    // O código de rastreio costuma existir logo depois da geração. Buscar
    // agora poupa o operador de voltar à tela; se falhar, a agenda busca.
    await sincronizarLote(companyId, [lerEnvio(companyId, shipmentId)], provedor).catch(() => undefined);
  }

  return { envio: envioParaResposta(lerEnvio(companyId, shipmentId)), aviso: null };
}

export async function linkParaImprimir(companyId: string, shipmentId: string): Promise<{ url: string }> {
  ensureCoreSchema();
  const envio = lerEnvio(companyId, shipmentId);
  if (!acoesDe(envio).imprimir) {
    throw new ApiError(
      'LOGISTICS_LABEL_NOT_AVAILABLE',
      envio.channel === 'manual'
        ? 'Envio registrado à mão: a etiqueta foi feita fora do sistema.'
        : `Não há etiqueta para imprimir neste estado (${ROTULO_DO_ENVIO[envio.status] ?? envio.status}).`,
      409,
    );
  }
  try {
    return { url: await abrirProvedorDeEnvio(companyId).linkDaEtiqueta(envio.provider_ref as string) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('LOGISTICS_PROVIDER_ERROR', mensagemDoErro(err, 'Falha ao pedir o link da etiqueta.'), 502);
  }
}

export async function cancelarEnvio(input: {
  companyId: string;
  shipmentId: string;
  userId: string | null;
  motivo: unknown;
}): Promise<EnvioResposta> {
  ensureCoreSchema();
  const envio = lerEnvio(input.companyId, input.shipmentId);
  if (envio.status === 'cancelado') return envioParaResposta(envio);
  if (envio.channel === 'manual') {
    throw new ApiError(
      'LOGISTICS_SHIPMENT_MANUAL',
      'Envio registrado à mão não se cancela aqui: a encomenda já saiu. Fale com a transportadora.',
      409,
    );
  }
  if (!acoesDe(envio).cancelar) {
    throw new ApiError(
      'LOGISTICS_SHIPMENT_NOT_CANCELLABLE',
      `A encomenda já está "${ROTULO_DO_ENVIO[envio.status] ?? envio.status}": o cancelamento é com a transportadora.`,
      409,
    );
  }
  const motivo = texto(input.motivo);
  if (motivo.length < 3) {
    throw new ApiError('LOGISTICS_CANCEL_REASON_REQUIRED', 'Diga o motivo do cancelamento.', 400);
  }
  const provedor = abrirProvedorDeEnvio(input.companyId);
  try {
    if (envio.status === 'pendente') await provedor.removerDoCarrinho(envio.provider_ref as string);
    else await provedor.cancelar(envio.provider_ref as string, motivo);
  } catch (err) {
    const mensagem = mensagemDoErro(err, 'Falha ao cancelar no provedor.');
    atualizarEnvio(envio.id, { last_error: mensagem });
    throw new ApiError('LOGISTICS_PROVIDER_ERROR', mensagem, 502);
  }
  const agora = new Date().toISOString();
  withTransaction(() => {
    atualizarEnvio(envio.id, { status: 'cancelado', cancelled_at: agora, last_error: null });
    registrarEvento({
      envio,
      status: 'cancelado',
      descricao: `Envio cancelado pela loja: ${motivo}`,
      origem: 'operador',
      userId: input.userId,
      chave: 'loja:cancelado',
    });
  });
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'logistics.label_cancelled',
    entityType: 'shipment',
    entityId: envio.id,
    detail: { orderId: envio.order_id, motivo, estadoAnterior: envio.status },
  });
  return envioParaResposta(lerEnvio(input.companyId, envio.id));
}

// ------------------------------------------------------------- despacho

/**
 * DESPACHAR: o pedido sai da loja, com data e operador.
 *
 * Com etiqueta do provedor gerada, o código vem DELA — o operador não digita
 * nada. Sem etiqueta (postado no balcão da agência, motoboy, transportadora
 * local), o operador diz QUEM leva e, havendo, o código; o envio fica
 * registrado como "manual".
 */
export function despacharPedido(input: {
  companyId: string;
  orderId: string;
  userId: string | null;
  carrier?: unknown;
  trackingCode?: unknown;
}): OrderRecord {
  ensureCoreSchema();
  const pedido = lerPedido(input.companyId, input.orderId);

  // Pedido que não pode sair (retirada, não pago, cancelado, reembolsado): a
  // recusa certa — com o motivo certo — é a do núcleo do pedido, e ela vem
  // ANTES de perguntar quem leva.
  if (isPickup(pedido.shipping_method) || ['aguardando_pagamento', 'cancelado', 'reembolsado'].includes(pedido.status)) {
    return advanceFulfillment({ companyId: input.companyId, orderId: input.orderId, toStatus: 'expedido', userId: input.userId });
  }

  const vivo = envioVivo(input.orderId);
  const agora = new Date().toISOString();

  if (vivo && vivo.channel === 'melhor_envio') {
    if (vivo.status === 'pendente' || vivo.status === 'paga') {
      throw new ApiError(
        'LOGISTICS_LABEL_NOT_GENERATED',
        `A etiqueta do Melhor Envio ainda não foi gerada (${ROTULO_DO_ENVIO[vivo.status]}). `
          + 'Termine a compra ou cancele o envio antes de despachar.',
        409,
      );
    }
    const codigo = vivo.tracking_code ?? normalizarCodigo(input.trackingCode as string | null);
    return withTransaction(() => {
      const pedidoAtualizado = advanceFulfillment({
        companyId: input.companyId,
        orderId: input.orderId,
        toStatus: 'expedido',
        userId: input.userId,
        trackingCode: codigo ?? undefined,
        shippingCarrier: 'melhor_envio',
        origin: 'operador',
      });
      atualizarEnvio(vivo.id, {
        dispatched_at: vivo.dispatched_at ?? agora,
        dispatched_by: vivo.dispatched_by ?? input.userId,
        tracking_code: codigo,
      });
      registrarEvento({
        envio: vivo,
        status: 'postado',
        descricao: 'Despachado pela loja',
        origem: 'operador',
        userId: input.userId,
        chave: 'loja:despacho',
      });
      return pedidoAtualizado;
    });
  }

  const carrier = texto(input.carrier);
  if (!isTransportadoraDoDespacho(carrier)) {
    throw new ApiError(
      'LOGISTICS_CARRIER_REQUIRED',
      'Diga quem leva a encomenda: Correios, Jadlog, Melhor Envio, outra transportadora ou entrega da loja.',
      400,
    );
  }
  const codigo = normalizarCodigo(input.trackingCode as string | null);
  if (carrier === 'correios' && codigo && !CODIGO_DOS_CORREIOS.test(codigo)) {
    throw new ApiError(
      'LOGISTICS_TRACKING_CODE_INVALID',
      'Código dos Correios tem 13 caracteres: duas letras, nove números e duas letras (ex.: AA123456789BR).',
      400,
    );
  }
  return withTransaction(() => {
    const pedidoAtualizado = advanceFulfillment({
      companyId: input.companyId,
      orderId: input.orderId,
      toStatus: 'expedido',
      userId: input.userId,
      trackingCode: codigo ?? undefined,
      shippingCarrier: carrier,
      origin: 'operador',
    });
    let envio: LinhaDoEnvio;
    if (vivo) {
      // Despacho repetido de envio manual: é correção de quem leva / código.
      atualizarEnvio(vivo.id, { carrier, tracking_code: codigo ?? vivo.tracking_code });
      envio = lerEnvio(input.companyId, vivo.id);
    } else {
      const id = randomUUID();
      db()
        .prepare(
          `INSERT INTO core_shipments
             (id, company_id, order_id, channel, carrier, status, tracking_code, created_by,
              dispatched_at, dispatched_by, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'manual', ?, 'postado', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          input.orderId,
          carrier,
          codigo,
          input.userId,
          agora,
          input.userId,
          `despacho:${input.orderId}:${id}`,
          agora,
          agora,
        );
      envio = lerEnvio(input.companyId, id);
    }
    registrarEvento({
      envio,
      status: 'postado',
      descricao: `Despachado pela loja (${nomeDaTransportadora(carrier)}${codigo ? ` — ${codigo}` : ''})`,
      origem: 'operador',
      userId: input.userId,
      chave: `loja:despacho:${agora}`,
    });
    return pedidoAtualizado;
  });
}

/**
 * Toda etapa do pedido pedida pela tela passa por aqui (a rota de
 * fulfillment). Expedir vira DESPACHO; entregar marca o envio como entregue
 * pelo OPERADOR — identificado, com origem declarada.
 */
export function avancarEtapaDoPedido(input: {
  companyId: string;
  orderId: string;
  toStatus: string;
  userId: string | null;
  trackingCode?: unknown;
  carrier?: unknown;
}): OrderRecord {
  if (input.toStatus === 'expedido') {
    return despacharPedido(input);
  }
  if (input.toStatus !== 'entregue') {
    return advanceFulfillment({
      companyId: input.companyId,
      orderId: input.orderId,
      toStatus: input.toStatus,
      userId: input.userId,
      origin: 'operador',
    });
  }
  ensureCoreSchema();
  const vivo = envioVivo(input.orderId);
  const provedorNaoConfirmou = vivo !== null && vivo.channel === 'melhor_envio' && vivo.status !== 'entregue';
  return withTransaction(() => {
    const pedido = advanceFulfillment({
      companyId: input.companyId,
      orderId: input.orderId,
      toStatus: 'entregue',
      userId: input.userId,
      origin: 'operador',
      note: provedorNaoConfirmou
        ? 'Marcado como entregue pela loja — a transportadora ainda não confirmou.'
        : 'Marcado como entregue pela loja.',
    });
    if (vivo && vivo.status !== 'entregue') {
      const agora = new Date().toISOString();
      atualizarEnvio(vivo.id, { status: 'entregue', delivered_at: agora, delivered_origin: 'operador' });
      registrarEvento({
        envio: vivo,
        status: 'entregue',
        descricao: 'Marcado como entregue pela loja',
        origem: 'operador',
        userId: input.userId,
        chave: 'loja:entregue',
      });
    }
    return pedido;
  });
}

// ------------------------------------------------------------- rastreio

function aplicarSituacao(envio: LinhaDoEnvio, s: SituacaoDoEnvio): void {
  const agora = new Date().toISOString();
  withTransaction(() => {
    for (const ev of s.eventos) {
      registrarEvento({ envio, status: ev.status, descricao: ev.descricao, em: ev.em, origem: 'provedor', chave: ev.chave });
    }
    // Entregue e cancelado não voltam atrás por uma leitura atrasada.
    const terminal = envio.status === 'entregue' || envio.status === 'cancelado';
    const novo: EstadoDoEnvio = terminal ? envio.status : (s.estado ?? envio.status);
    const codigo = normalizarCodigo(s.codigoDeRastreio) ?? envio.tracking_code;
    const quandoPostou = s.eventos.find((e) => e.status === 'postado')?.em ?? agora;
    const quandoEntregou = s.eventos.find((e) => e.status === 'entregue')?.em ?? agora;
    atualizarEnvio(envio.id, {
      status: novo,
      tracking_code: codigo,
      last_sync_at: agora,
      last_sync_ok: 1,
      last_sync_message: s.estado ? null : `O provedor mandou um estado que o sistema não conhece: "${s.estadoBruto ?? '—'}".`,
      delivered_at: novo === 'entregue' ? (envio.delivered_at ?? quandoEntregou) : envio.delivered_at,
      delivered_origin: novo === 'entregue' ? (envio.delivered_origin ?? 'provedor') : envio.delivered_origin,
      cancelled_at: novo === 'cancelado' ? (envio.cancelled_at ?? agora) : envio.cancelled_at,
      dispatched_at:
        (novo === 'postado' || novo === 'entregue' || novo === 'nao_entregue') ? (envio.dispatched_at ?? quandoPostou) : envio.dispatched_at,
    });

    // O PEDIDO SEGUE O QUE A TRANSPORTADORA DISSE — só para a frente.
    const pedido = db()
      .prepare('SELECT status, tracking_code FROM core_orders WHERE id = ?')
      .get(envio.order_id) as { status: string; tracking_code: string | null } | undefined;
    if (!pedido) return;
    const saiu = novo === 'postado' || novo === 'entregue' || novo === 'nao_entregue';
    let status = pedido.status;
    if (saiu && ANTES_DO_DESPACHO.has(status)) {
      advanceFulfillment({
        companyId: envio.company_id,
        orderId: envio.order_id,
        toStatus: 'expedido',
        trackingCode: codigo ?? undefined,
        shippingCarrier: envio.carrier,
        origin: 'provedor',
        note: `Postagem registrada pela transportadora (${nomeDaTransportadora(envio.carrier)}).`,
      });
      status = 'expedido';
    } else if (saiu && codigo && !pedido.tracking_code) {
      db()
        .prepare(
          `UPDATE core_orders SET tracking_code = ?, shipping_carrier = COALESCE(shipping_carrier, ?), updated_at = ?
            WHERE id = ?`,
        )
        .run(codigo, envio.carrier, agora, envio.order_id);
    }
    if (novo === 'entregue' && status === 'expedido' && envio.status !== 'entregue') {
      advanceFulfillment({
        companyId: envio.company_id,
        orderId: envio.order_id,
        toStatus: 'entregue',
        origin: 'provedor',
        note: `Entrega confirmada pela transportadora (${nomeDaTransportadora(envio.carrier)}) em `
          + `${new Date(quandoEntregou).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
      });
    }
  });
}

function registrarFalhaDaConsulta(envios: LinhaDoEnvio[], mensagem: string): void {
  const agora = new Date().toISOString();
  for (const e of envios) {
    atualizarEnvio(e.id, { last_sync_at: agora, last_sync_ok: 0, last_sync_message: mensagem });
  }
}

/** Consulta o provedor para vários envios da MESMA empresa, numa chamada. */
async function sincronizarLote(
  companyId: string,
  envios: LinhaDoEnvio[],
  provedorPronto?: ProvedorDeEnvio,
): Promise<{ ok: number; falhas: number }> {
  const doProvedor = envios.filter((e) => e.channel === 'melhor_envio' && e.provider_ref);
  if (doProvedor.length === 0) return { ok: 0, falhas: 0 };
  let provedor: ProvedorDeEnvio;
  try {
    provedor = provedorPronto ?? abrirProvedorDeEnvio(companyId);
  } catch (err) {
    registrarFalhaDaConsulta(doProvedor, mensagemDoErro(err, 'Provedor indisponível.'));
    return { ok: 0, falhas: doProvedor.length };
  }
  let situacoes: Record<string, SituacaoDoEnvio>;
  try {
    situacoes = await provedor.consultar(doProvedor.map((e) => e.provider_ref as string));
  } catch (err) {
    const mensagem = mensagemDoErro(err, 'Falha na consulta de rastreio.');
    registrarFalhaDaConsulta(doProvedor, mensagem);
    markCredentialTest(companyId, 'melhor_envio', 'tracking_failed', undefined, { kind: 'tracking', ok: false, message: mensagem });
    return { ok: 0, falhas: doProvedor.length };
  }
  let ok = 0;
  let falhas = 0;
  for (const envio of doProvedor) {
    const s = situacoes[envio.provider_ref as string];
    if (!s) {
      registrarFalhaDaConsulta([envio], 'O provedor não devolveu este envio na consulta de rastreio.');
      falhas += 1;
      continue;
    }
    try {
      aplicarSituacao(lerEnvio(companyId, envio.id), s);
      ok += 1;
    } catch (err) {
      registrarFalhaDaConsulta([envio], mensagemDoErro(err, 'Falha ao aplicar o rastreio.'));
      falhas += 1;
    }
  }
  if (ok > 0) markCredentialTest(companyId, 'melhor_envio', 'tracking_ok', undefined, { kind: 'tracking', ok: true });
  return { ok, falhas };
}

/** O botão "Atualizar rastreio". O resultado — inclusive a falha — fica gravado. */
export async function sincronizarEnvio(companyId: string, shipmentId: string): Promise<EnvioResposta> {
  ensureCoreSchema();
  const envio = lerEnvio(companyId, shipmentId);
  if (envio.channel !== 'melhor_envio' || !envio.provider_ref) {
    throw new ApiError(
      'LOGISTICS_SHIPMENT_MANUAL',
      'Envio registrado à mão não é consultado no provedor: use o link da transportadora.',
      409,
    );
  }
  await sincronizarLote(companyId, [envio]);
  return envioParaResposta(lerEnvio(companyId, shipmentId));
}

/**
 * A AGENDA: consulta os envios que ainda estão a caminho, de todas as
 * empresas, em lotes por empresa. Os mais antigos de consulta primeiro.
 */
export async function sincronizarEnviosPendentes(limite = 200): Promise<{ ok: number; falhas: number }> {
  ensureCoreSchema();
  const marcadores = SINCRONIZAVEIS.map(() => '?').join(', ');
  const linhas = db()
    .prepare(
      `SELECT * FROM core_shipments
        WHERE channel = 'melhor_envio' AND provider_ref IS NOT NULL AND status IN (${marcadores})
        ORDER BY COALESCE(last_sync_at, '') ASC
        LIMIT ?`,
    )
    .all(...SINCRONIZAVEIS, limite) as unknown as LinhaDoEnvio[];
  const porEmpresa = new Map<string, LinhaDoEnvio[]>();
  for (const l of linhas) porEmpresa.set(l.company_id, [...(porEmpresa.get(l.company_id) ?? []), l]);
  let ok = 0;
  let falhas = 0;
  for (const [companyId, envios] of porEmpresa) {
    // O rastreio do Melhor Envio aceita vários envios por chamada; 50 por vez.
    for (let i = 0; i < envios.length; i += 50) {
      const r = await sincronizarLote(companyId, envios.slice(i, i + 50));
      ok += r.ok;
      falhas += r.falhas;
    }
  }
  return { ok, falhas };
}

// ------------------------------------------------------------- leitura

export function listarEnviosDoPedido(companyId: string, orderId: string): EnvioResposta[] {
  ensureCoreSchema();
  lerPedido(companyId, orderId);
  return (
    db()
      .prepare('SELECT * FROM core_shipments WHERE company_id = ? AND order_id = ? ORDER BY created_at DESC')
      .all(companyId, orderId) as unknown as LinhaDoEnvio[]
  ).map(envioParaResposta);
}

export function listarEnviosDaEmpresa(companyId: string, limite = 200): EnvioResposta[] {
  ensureCoreSchema();
  return (
    db()
      .prepare('SELECT * FROM core_shipments WHERE company_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(companyId, limite) as unknown as LinhaDoEnvio[]
  ).map(envioParaResposta);
}

/** Os pedidos da lista com o link de rastreio já montado pelo servidor. */
export function comLinkDeRastreio<T extends Record<string, unknown>>(pedidos: T[]): (T & { tracking_url: string | null })[] {
  return pedidos.map((p) => ({
    ...p,
    tracking_url: linkDeRastreio(p.shipping_carrier as string | null, p.tracking_code as string | null),
  }));
}
