/**
 * ============================================================================
 * A OFICINA FALA COM O CLIENTE (GAP-PRD-036)
 * ============================================================================
 *
 * O QUE ERA: o botão "Enviar orçamento ao cliente" gravava
 * `approval_requested_at` e uma fala interna na linha do tempo — e mais nada.
 * A tela dizia "enviado em …", o cliente não recebia coisa nenhuma, e só
 * descobria que havia um orçamento esperando se abrisse o portal por conta
 * própria. A moto ficava na bancada esperando um "sim" que ninguém pediu. A
 * oficina não tinha NENHUM modelo de mensagem: nem orçamento, nem pronta, nem
 * concluída.
 *
 * O QUE É: três avisos, cada um montado NO INSTANTE DO FATO e enfileirado
 * DENTRO da transação dele (pelo contrato da fila, uma falha ao enfileirar
 * nunca desfaz o fato — ver `queueMensagemPronta`):
 *
 *   - `os_orcamento_disponivel` — a oficina pediu a aprovação: valor e o
 *     caminho para decidir (Minha conta › Meus equipamentos). Dedupe por
 *     (OS, pedido de aprovação): reorçar (valor novo, ou depois de uma
 *     decisão) gera aviso novo; pedir de novo o MESMO valor que ainda espera
 *     o cliente não;
 *   - `os_pronta` — conclusão técnica com custo: está pronta, e quanto pagar
 *     na retirada;
 *   - `os_concluida` — encerrada sem custo (garantia, cortesia, retrabalho)
 *     ou paga no caixa.
 *
 * O cliente sem e-mail cadastrado não recebe nada — e a tela da OS DIZ isso
 * ("avise por telefone"), em vez de rotular como enviado o que não saiu. A
 * rota `GET /core/workshop/orders/:id/avisos` entrega o que foi para a fila
 * de cada OS, com a situação de entrega de cada mensagem.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { publicBaseUrl } from '../core/PublicUrl.js';
import {
  carteiroConfigurado,
  isDeliverableAddress,
  queueMensagemPronta,
  rotuloDoModelo,
  type ModeloDeMensagemPronta,
} from './EmailService.js';
import { assinaturaDaEmpresa } from './IdentidadeDoRemetente.js';

interface OsDoAviso {
  id: string;
  company_id: string;
  workshop_id: string | null;
  number: number;
  customer_id: string | null;
  customer_name: string | null;
  equipment: string | null;
  status: string;
  total_cents: number;
  no_cost_reason: string | null;
  approval_requested_at: string | null;
}

/** O resultado que a linha do tempo da OS e a tela contam. */
export interface AvisoDaOs {
  /** Para quem foi (ou iria), ou `null` quando o cliente não tem e-mail. */
  para: string | null;
  /** O id da mensagem na fila; `null` se nada entrou (sem e-mail, repetido ou fila indisponível). */
  emailId: string | null;
}

function reais(cents: number): string {
  return (Number(cents) / 100).toFixed(2).replace('.', ',');
}

function lerOs(companyId: string, orderId: string): OsDoAviso | undefined {
  return getConnection()
    .prepare(
      `SELECT id, company_id, workshop_id, number, customer_id, customer_name, equipment, status,
              total_cents, no_cost_reason, approval_requested_at
         FROM core_service_orders WHERE id = ? AND company_id = ?`,
    )
    .get(orderId, companyId) as OsDoAviso | undefined;
}

/** O e-mail do cadastro vinculado à OS — da MESMA empresa, e só se entregável. */
function emailDoCliente(os: OsDoAviso): string | null {
  if (!os.customer_id) return null;
  const c = getConnection()
    .prepare('SELECT email FROM core_customers WHERE id = ? AND company_id = ?')
    .get(os.customer_id, os.company_id) as { email: string | null } | undefined;
  const email = (c?.email ?? '').trim();
  return isDeliverableAddress(email) ? email : null;
}

/**
 * O nome que o cliente conhece: o da marca que assina o papel da bancada
 * (`brand_company_id` — a PJ Motors na bancada de mobilidade), ou o da empresa.
 */
function marcaDaOficina(os: OsDoAviso): string {
  const linha = getConnection()
    .prepare(
      `SELECT COALESCE(b.trade_name, c.trade_name) AS nome
         FROM core_companies c
         LEFT JOIN core_workshops w ON w.id = ?
         LEFT JOIN core_companies b ON b.id = w.brand_company_id
        WHERE c.id = ?`,
    )
    .get(os.workshop_id, os.company_id) as { nome: string | null } | undefined;
  return (linha?.nome ?? '').trim() || 'Grupo Sampaio';
}

function assinatura(os: OsDoAviso, marca: string): string {
  return assinaturaDaEmpresa(os.company_id) ?? `${marca} — Grupo Sampaio`;
}

function saudacao(os: OsDoAviso): string {
  const nome = (os.customer_name ?? '').trim();
  return nome ? `Olá, ${nome}.\n\n` : 'Olá.\n\n';
}

function oQue(os: OsDoAviso): string {
  const eq = (os.equipment ?? '').trim();
  return eq ? `a ordem de serviço #${os.number} (${eq})` : `a ordem de serviço #${os.number}`;
}

function enfileirar(
  os: OsDoAviso,
  template: ModeloDeMensagemPronta,
  dedupeKey: string,
  subject: string,
  bodyText: string,
): AvisoDaOs {
  const para = emailDoCliente(os);
  if (!para) return { para: null, emailId: null };
  const emailId = queueMensagemPronta({
    companyId: os.company_id,
    template,
    toAddress: para,
    subject,
    bodyText,
    // Só o que a mensagem mostra — a fila é lida em tela.
    payload: {
      osId: os.id,
      numero: Number(os.number),
      evento: template,
      totalCents: Number(os.total_cents),
    },
    dedupeKey,
  });
  return { para, emailId };
}

/** O valor do último orçamento avisado desta OS — ou `null` se nenhum foi. */
function ultimoOrcamentoAvisado(os: OsDoAviso): number | null {
  const prefixo = `os_orcamento_disponivel:${os.id}:`;
  const linha = getConnection()
    .prepare(
      `SELECT payload FROM core_email_queue
        WHERE company_id = ? AND substr(dedupe_key, 1, ?) = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(os.company_id, prefixo.length, prefixo) as { payload: string } | undefined;
  if (!linha) return null;
  try {
    const total = (JSON.parse(linha.payload) as { totalCents?: unknown }).totalCents;
    return typeof total === 'number' ? total : null;
  } catch {
    return null;
  }
}

/**
 * A oficina pediu a aprovação — o cliente precisa SABER que há um orçamento.
 *
 * Chamada DENTRO da transação de `pedirAprovacaoOrcamento`, depois do UPDATE
 * de `approval_requested_at`: o dedupe usa esse instante, então reorçar (novo
 * pedido) avisa de novo, com o valor novo.
 */
export function avisarOrcamentoDisponivel(
  companyId: string,
  orderId: string,
  opcoes: {
    /**
     * A OS já estava esperando o cliente ANTES deste pedido (pedido anterior
     * sem decisão). Com o mesmo valor, é o clique repetido: o cliente já tem
     * o aviso desse orçamento, e um segundo e-mail igual é ruído.
     */
    estavaPendente?: boolean;
  } = {},
): AvisoDaOs {
  ensureCoreSchema();
  const os = lerOs(companyId, orderId);
  if (!os) return { para: null, emailId: null };
  if (opcoes.estavaPendente && ultimoOrcamentoAvisado(os) === Number(os.total_cents)) {
    return { para: emailDoCliente(os), emailId: null };
  }
  const marca = marcaDaOficina(os);
  return enfileirar(
    os,
    'os_orcamento_disponivel',
    `os_orcamento_disponivel:${os.id}:${os.approval_requested_at ?? ''}`,
    `${marca} · orçamento da OS #${os.number} para aprovar`,
    saudacao(os)
      + `O orçamento de ${oQue(os)} está pronto: R$ ${reais(os.total_cents)}.\n\n`
      + 'Para aprovar ou recusar, entre em Minha conta › Meus equipamentos com este e-mail:\n'
      + `${publicBaseUrl()}/minha-conta/equipamentos\n\n`
      + 'Se preferir, responda à oficina por telefone: o aceite também é registrado no balcão.\n\n'
      + assinatura(os, marca),
  );
}

const MOTIVO_SEM_CUSTO: Record<string, string> = {
  garantia: 'garantia',
  cortesia_autorizada: 'cortesia',
  retrabalho: 'retrabalho',
};

/**
 * A bancada terminou. Com custo, a OS está PRONTA e espera o pagamento na
 * retirada (`os_pronta`); sem custo, já está concluída (`os_concluida`).
 *
 * Chamada DENTRO da transação de `completeTechnical`.
 */
export function avisarConclusaoTecnica(companyId: string, orderId: string): AvisoDaOs {
  ensureCoreSchema();
  const os = lerOs(companyId, orderId);
  if (!os) return { para: null, emailId: null };
  const marca = marcaDaOficina(os);

  if (os.status === 'aguardando_pagamento') {
    return enfileirar(
      os,
      'os_pronta',
      `os_pronta:${os.id}`,
      `${marca} · OS #${os.number} pronta para retirada`,
      saudacao(os)
        + `O serviço de ${oQue(os)} foi concluído e o equipamento está pronto para retirada.\n`
        + `Valor a pagar na retirada: R$ ${reais(os.total_cents)}.\n`
        + 'Traga um documento com foto.\n\n'
        + assinatura(os, marca),
    );
  }
  if (os.status === 'finalizada') {
    const motivo = MOTIVO_SEM_CUSTO[os.no_cost_reason ?? ''];
    return enfileirar(
      os,
      'os_concluida',
      `os_concluida:${os.id}`,
      `${marca} · OS #${os.number} concluída`,
      saudacao(os)
        + `O serviço de ${oQue(os)} foi concluído sem custo${motivo ? ` (${motivo})` : ''}, `
        + 'e o equipamento está pronto para retirada.\n'
        + 'Traga um documento com foto.\n\n'
        + assinatura(os, marca),
    );
  }
  return { para: null, emailId: null };
}

/**
 * O caixa recebeu: a OS está finalizada. Chamada DENTRO da transação de
 * `settleOrder`. O dedupe é o mesmo do concluído sem custo — os dois caminhos
 * se excluem, e uma OS termina uma vez só.
 */
export function avisarOsPaga(companyId: string, orderId: string): AvisoDaOs {
  ensureCoreSchema();
  const os = lerOs(companyId, orderId);
  if (!os || os.status !== 'finalizada') return { para: null, emailId: null };
  const marca = marcaDaOficina(os);
  return enfileirar(
    os,
    'os_concluida',
    `os_concluida:${os.id}`,
    `${marca} · OS #${os.number} finalizada`,
    saudacao(os)
      + `${oQue(os).charAt(0).toUpperCase()}${oQue(os).slice(1)} foi finalizada, `
      + `com o pagamento de R$ ${reais(os.total_cents)} registrado.\n`
      + 'Obrigado pela confiança! Guarde este e-mail: ele identifica o serviço se você '
      + 'precisar da garantia.\n\n'
      + assinatura(os, marca),
  );
}

// ------------------------------------------------------------ a leitura

export interface AvisoNaFila {
  id: string;
  template: string;
  templateLabel: string;
  toAddress: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface AvisosDaOs {
  /** O e-mail do cadastro vinculado — `null` quando não há como avisar por e-mail. */
  emailDoCliente: string | null;
  /** O carteiro tem credencial? Sem ela, o aviso espera na fila. */
  envioLigado: boolean;
  avisos: AvisoNaFila[];
}

/**
 * O que foi para a fila por esta OS — para a tela contar a verdade sobre o
 * "enviado". A OS é conferida pela empresa; o alcance de oficina é conferido
 * pela rota antes de chamar (a mesma régua do detalhe da OS).
 */
export function avisosDaOs(companyId: string, orderId: string): AvisosDaOs | null {
  ensureCoreSchema();
  const os = lerOs(companyId, orderId);
  if (!os) return null;
  const chaves = [`os_pronta:${os.id}`, `os_concluida:${os.id}`];
  const prefixo = `os_orcamento_disponivel:${os.id}:`;
  const linhas = getConnection()
    .prepare(
      `SELECT id, template, to_address, status, attempts, last_error, created_at, sent_at
         FROM core_email_queue
        WHERE company_id = ?
          AND (dedupe_key IN (?, ?) OR substr(dedupe_key, 1, ?) = ?)
        ORDER BY created_at DESC`,
    )
    .all(companyId, chaves[0], chaves[1], prefixo.length, prefixo) as unknown as {
    id: string;
    template: string;
    to_address: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
    sent_at: string | null;
  }[];
  return {
    emailDoCliente: emailDoCliente(os),
    envioLigado: carteiroConfigurado(),
    avisos: linhas.map((l) => ({
      id: l.id,
      template: l.template,
      templateLabel: rotuloDoModelo(l.template),
      toAddress: l.to_address,
      status: l.status,
      attempts: Number(l.attempts),
      lastError: l.last_error,
      createdAt: l.created_at,
      sentAt: l.sent_at,
    })),
  };
}
