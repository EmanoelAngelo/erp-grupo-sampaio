/**
 * E-mail transacional: montado sempre, enviado só com credencial.
 *
 * O QUE ESTE ARQUIVO GARANTE
 *
 * 1. A mensagem é montada NO INSTANTE DO FATO e guardada pronta. Montar na
 *    hora do envio leria de novo um pedido que pode ter mudado — e mandaria ao
 *    cliente a confirmação de algo que já não é assim.
 *
 * 2. Sem credencial, nada sai e nada se perde. A fila acumula em `pending` e a
 *    tela de gestão mostra exatamente o que sairia. É `READY_FOR_CREDENTIAL`,
 *    não "desligado": o dia em que a chave existir, a fila anda.
 *
 * 3. UMA mensagem por fato. `dedupe_key` é única, então dez webhooks repetidos
 *    do mesmo pagamento geram um e-mail. Caixa de entrada com dez confirmações
 *    iguais ensina o cliente a ignorar a notificação inteira — inclusive a que
 *    importa.
 *
 * 4. Segredo não entra no payload NEM NO CORPO GUARDADO. A fila é lida por
 *    tela de gestão, e o que aparece numa tela vaza em print. O link de
 *    recuperação e o código de verificação moram selados em
 *    `core_email_segredos`, e o corpo da fila leva um marcador no lugar deles
 *    (GAP-PRD-007). Só o carteiro abre, na hora de entregar — e apaga.
 *
 * 5. A notificação nunca derruba o fato (GAP-PRD-201). As funções de aviso
 *    não lançam: falha ao enfileirar vira log e `null`, desfeita num
 *    SAVEPOINT próprio, e a conta, a senha ou o pedido de quem chamou seguem.
 *
 * 6. Falha espaça, não mata (GAP-PRD-038). Cada falha empurra a próxima
 *    tentativa (1, 5, 30, 120, 720 min); só a sexta desiste. E o que desistiu
 *    volta à fila por um clique auditado na tela, com o motivo à vista.
 *
 * 7. A credencial SMTP é lida AO VIVO do `.env` (GAP-PRD-065): colou a senha
 *    de aplicativo, a próxima batida já a usa — sem reiniciar a API.
 *
 * 8. Cada modelo tem nome em português (`EMAIL_TEMPLATE_LABEL`, GAP-PRD-199),
 *    e a oficina e o pós-venda falam com o cliente (GAP-PRD-036/037) — os
 *    corpos prontos entram por `queueMensagemPronta`, com o mesmo contrato.
 *
 * 9. O flush tem escopo (GAP-PRD-198): o clique do gerente entrega só a fila
 *    da empresa dele; o worker de fundo, a das seis. E cada empresa sai com a
 *    identidade que o dono escolheu (`IdentidadeDoRemetente`; padrão: a do
 *    grupo, como sempre foi).
 *
 * O QUE ELE NÃO FAZ, DE PROPÓSITO
 *
 * Não simula envio. Não existe modo "fingir que mandou": um e-mail marcado
 * como enviado sem ter saído faria o suporte procurar na caixa do cliente uma
 * mensagem que nunca existiu. Desde a rodada 49 o transporte REAL existe
 * (SMTP via nodemailer, credencial só no ambiente) — e a regra continua: sem
 * credencial a fila acumula; nos testes o carteiro é injetado, nunca fingido.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { lerVariaveisAoVivo } from '../../config/env.js';
import { ApiError, logError, logInfo } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { decryptFiscalSecret, encryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { assinaturaDaEmpresa, cabecalhosDoRemetente } from './IdentidadeDoRemetente.js';

/**
 * OS MODELOS, numa lista só — e o rótulo de cada um, colado nela (GAP-PRD-199).
 *
 * A tela da fila tinha o próprio mapa de rótulos, com 4 dos 9 modelos: a
 * recuperação de senha, a conta criada e o pacote do contador apareciam para o
 * gestor como o código cru (`recuperacao_senha`). O rótulo agora mora AQUI,
 * tipado pela lista: modelo novo sem rótulo não compila, e a tela recebe o
 * rótulo pronto da rota (`templateLabel`).
 *
 * Os modelos da oficina (GAP-PRD-036) e do pós-venda (GAP-PRD-037) entraram
 * nesta lista: orçamento disponível, OS pronta, OS concluída, pedido
 * cancelado, reembolsado, pagamento depois do cancelamento, entregue e nota
 * fiscal disponível.
 */
export const EMAIL_TEMPLATES = [
  'pedido_recebido',
  'pagamento_confirmado',
  'pedido_expedido',
  'pedido_pronto_retirada',
  'pedido_entregue',
  'pedido_cancelado',
  'pedido_reembolsado',
  'pagamento_apos_cancelamento',
  'nota_disponivel',
  'os_orcamento_disponivel',
  'os_pronta',
  'os_concluida',
  'recuperacao_senha',
  'recuperacao_senha_equipe',
  'conta_criada',
  'senha_alterada',
  // A conta do portal ganhou a entrada pelo Google (GAP-PRD-027).
  'google_ligado',
  'verificacao_email',
  'pacote_contador',
  // O pedido de compra que vai ao FORNECEDOR (GAP-PRD-090).
  'pedido_compra',
] as const;

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplate, string> = {
  pedido_recebido: 'Pedido recebido',
  pagamento_confirmado: 'Pagamento confirmado',
  pedido_expedido: 'Pedido a caminho',
  pedido_pronto_retirada: 'Pronto para retirada',
  pedido_entregue: 'Pedido entregue',
  pedido_cancelado: 'Pedido cancelado',
  pedido_reembolsado: 'Pedido reembolsado',
  pagamento_apos_cancelamento: 'Pagamento depois do cancelamento',
  nota_disponivel: 'Nota fiscal do pedido',
  os_orcamento_disponivel: 'Orçamento da OS para aprovar',
  os_pronta: 'OS pronta para retirada',
  os_concluida: 'OS concluída',
  recuperacao_senha: 'Recuperação de senha',
  recuperacao_senha_equipe: 'Código de troca de senha da equipe',
  conta_criada: 'Conta criada',
  senha_alterada: 'Senha alterada',
  google_ligado: 'Entrada pelo Google ligada',
  verificacao_email: 'Código de confirmação do e-mail',
  pacote_contador: 'Pacote do contador',
  pedido_compra: 'Pedido de compra ao fornecedor',
};

/** O rótulo em português; modelo desconhecido (linha antiga) volta como veio. */
export function rotuloDoModelo(template: string): string {
  return (EMAIL_TEMPLATE_LABEL as Record<string, string>)[template] ?? template;
}

export interface EmailQueueRow {
  id: string;
  template: EmailTemplate;
  /** O nome do modelo em português — o que a tela mostra (GAP-PRD-199). */
  templateLabel: string;
  toAddress: string;
  subject: string;
  /**
   * O corpo como a TELA pode ver: o conteúdo protegido (link de recuperação,
   * código de verificação) aparece como `MARCA_DO_CONTEUDO_PROTEGIDO`, nunca
   * em claro — nem nas mensagens gravadas antes do cofre (ver
   * `mascararConteudoProtegidoLegado`).
   */
  bodyText: string;
  status: string;
  attempts: number;
  /** O motivo da última falha, sem a senha do SMTP. */
  lastError: string | null;
  /** Quando a próxima tentativa pode sair (pendente depois de uma falha). */
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Uma mensagem que desistiu pode voltar à fila? (só `failed`) */
  podeReenviar: boolean;
  /** Por que NÃO pode — em palavras que o gestor resolve. */
  motivoSemReenvio: string | null;
}

/** Os filtros da tela da fila. */
export type EmailQueueStatus = 'pending' | 'sent' | 'failed';
export const EMAIL_QUEUE_STATUSES: readonly EmailQueueStatus[] = ['pending', 'sent', 'failed'];

/**
 * A prontidão do canal, do jeito que a tela mostra.
 *
 * `READY_FOR_CREDENTIAL` é o estado honesto enquanto faltar SMTP: o caminho
 * inteiro existe e foi testado, só não há por onde entregar.
 */
export type EmailReadiness = 'READY_FOR_CREDENTIAL' | 'READY';

export interface EmailStatus {
  readiness: EmailReadiness;
  enabled: boolean;
  /** O que ainda falta, em palavras que o gestor resolve. */
  missing: string[];
  pending: number;
  sent: number;
  failed: number;
}

/** Endereço utilizável? Não valida caixa; só descarta o que não é endereço. */
export function isDeliverableAddress(endereco: string | null | undefined): boolean {
  const e = String(endereco ?? '').trim();
  // Sem arroba, sem ponto no domínio, ou com espaço, não há para onde mandar.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * A CREDENCIAL SMTP, lida AO VIVO a cada pergunta (GAP-PRD-065).
 *
 * Era `loadEnv()`, que memoriza na primeira leitura: o dono colava a senha de
 * aplicativo no `.env`, a tela continuava dizendo "falta EMAIL_SMTP_PASSWORD"
 * e o carteiro seguia parado até alguém reiniciar a API — com a recuperação
 * de senha e o código de verificação do cliente esperando na fila.
 *
 * Agora cada batida, cada status e cada envio releem as seis chaves
 * (`lerVariaveisAoVivo`, com a precedência do boot: variável do ambiente do
 * sistema continua mandando). O transporte é montado a cada flush com o que
 * estiver valendo naquele instante.
 */
const CHAVES_SMTP = [
  'EMAIL_ENABLED',
  'EMAIL_FROM',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USER',
  'EMAIL_SMTP_PASSWORD',
] as const;

interface ConfigSmtp {
  enabled: boolean;
  from: string;
  host: string;
  port: number;
  portaValida: boolean;
  user: string;
  password: string;
}

function configSmtp(): ConfigSmtp {
  const v = lerVariaveisAoVivo(CHAVES_SMTP);
  const portaCrua = (v.EMAIL_SMTP_PORT ?? '').trim();
  // Vazia vale 587 — o mesmo padrão do esquema do ambiente.
  const port = portaCrua === '' ? 587 : Number(portaCrua);
  return {
    enabled: (v.EMAIL_ENABLED ?? '').trim() === 'true',
    from: (v.EMAIL_FROM ?? '').trim(),
    host: (v.EMAIL_SMTP_HOST ?? '').trim(),
    port,
    portaValida: Number.isInteger(port) && port > 0 && port < 65_536,
    user: (v.EMAIL_SMTP_USER ?? '').trim(),
    password: v.EMAIL_SMTP_PASSWORD ?? '',
  };
}

function credenciaisFaltando(cfg: ConfigSmtp = configSmtp()): string[] {
  const faltando: string[] = [];
  if (!cfg.enabled) faltando.push('EMAIL_ENABLED=true');
  if (!cfg.from) faltando.push('EMAIL_FROM (remetente)');
  if (!cfg.host) faltando.push('EMAIL_SMTP_HOST');
  if (!cfg.portaValida) faltando.push('EMAIL_SMTP_PORT (número da porta, ex.: 465 ou 587)');
  if (!cfg.user) faltando.push('EMAIL_SMTP_USER');
  if (!cfg.password) faltando.push('EMAIL_SMTP_PASSWORD');
  return faltando;
}

export function emailStatus(companyId?: string): EmailStatus {
  ensureCoreSchema();
  const faltando = credenciaisFaltando();
  const db = getConnection();

  const filtro = companyId ? ' WHERE company_id = ?' : '';
  const args = companyId ? [companyId] : [];
  const contar = (status: string) =>
    Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) c FROM core_email_queue${filtro}${filtro ? ' AND' : ' WHERE'} status = ?`,
          )
          .get(...args, status) as { c: number }
      ).c,
    );

  return {
    readiness: faltando.length === 0 ? 'READY' : 'READY_FOR_CREDENTIAL',
    enabled: faltando.length === 0,
    missing: faltando,
    pending: contar('pending'),
    sent: contar('sent'),
    failed: contar('failed'),
  };
}

// ------------------------------------------------------------- modelos

/** Quem cancelou o pedido — muda o que o cliente precisa fazer (GAP-PRD-037). */
export type OrigemDoCancelamento = 'cliente' | 'loja' | 'prazo';

/**
 * Como o dinheiro volta ao cliente depois do reembolso (GAP-PRD-037).
 *
 * Dito só quando se SABE: "o valor volta pelo cartão" para quem ainda depende
 * de a loja fazer o PIX de volta à mão seria a mesma promessa falsa que o
 * botão "Enviar orçamento" fazia na oficina.
 */
export type ComoOValorVolta =
  /** O provedor avisou que estornou (webhook `refunded`). */
  | 'estorno_confirmado'
  /** A loja devolveu e o pedido de estorno ao provedor foi aceito. */
  | 'estorno_solicitado'
  /** O cliente contestou com a operadora do cartão (chargeback). */
  | 'contestacao'
  /** Não houve estorno automático: a loja devolve e combina como. */
  | 'devolucao_pela_loja';

export interface Contexto {
  storeName: string;
  customerName: string;
  orderNumber: number;
  totalCents: number;
  trackingCode?: string | null;
  /** A página pública da transportadora para este código (GAP-PRD-119). */
  trackingUrl?: string | null;
  /** Quem leva: "Correios", "Melhor Envio", "Entrega da loja". */
  carrierName?: string | null;
  estimatedDays?: number | null;
  /** Retirada no balcão (e não entrega). */
  retirada?: boolean;
  origemDoCancelamento?: OrigemDoCancelamento;
  comoOValorVolta?: ComoOValorVolta;
  /** O valor que o provedor confirmou DEPOIS do cancelamento. */
  valorRecebidoCents?: number | null;
  /** O pedido no portal do cliente. */
  linkDoPedido?: string | null;
  /** A vitrine, para refazer o pedido que venceu. */
  linkDaLoja?: string | null;
  /**
   * A última linha da mensagem. Vazia, vale a de sempre (`<loja> — Grupo
   * Sampaio`); preenchida quando o dono escolheu identidade por empresa
   * (GAP-PRD-198, `IdentidadeDoRemetente`).
   */
  assinatura?: string | null;
}

function reais(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function assinaturaDe(ctx: Contexto): string {
  const propria = (ctx.assinatura ?? '').trim();
  return propria || `${ctx.storeName} — Grupo Sampaio`;
}

function linhaDoPedido(ctx: Contexto): string {
  return ctx.linkDoPedido ? `Acompanhe em Minha conta: ${ctx.linkDoPedido}\n` : '';
}

/** O "não pague" que todo cancelamento precisa dizer — PIX e boleto seguem na mão do cliente. */
const NAO_PAGUE =
  'Não pague o PIX nem o boleto deste pedido. Se você já tinha pago, a loja entra em '
  + 'contato para devolver o valor.\n';

function corpoDoCancelamento(ctx: Contexto, pedido: string): string {
  switch (ctx.origemDoCancelamento ?? 'loja') {
    case 'cliente':
      return (
        `Seu pedido ${pedido} foi cancelado, como você pediu em Minha conta.\n`
        + 'A reserva dos itens foi desfeita.\n'
        + NAO_PAGUE
      );
    case 'prazo':
      // O "como refazer" que o aviso de PIX vencido precisa ter.
      return (
        `O prazo para pagar o pedido ${pedido} venceu sem o pagamento ser confirmado, `
        + 'e ele foi cancelado automaticamente. Os itens voltaram para a loja.\n'
        + (ctx.linkDaLoja
          ? `Se ainda quiser os itens, é só fazer um novo pedido: ${ctx.linkDaLoja}\n`
          : 'Se ainda quiser os itens, é só fazer um novo pedido na loja.\n')
        + NAO_PAGUE
      );
    case 'loja':
      return (
        `A loja cancelou o pedido ${pedido}, que ainda aguardava pagamento.\n`
        + NAO_PAGUE
        + 'Se tiver alguma dúvida, fale com a loja.\n'
      );
  }
}

function corpoDoReembolso(ctx: Contexto, pedido: string): string {
  const valor = `R$ ${reais(ctx.totalCents)}`;
  switch (ctx.comoOValorVolta ?? 'devolucao_pela_loja') {
    case 'estorno_confirmado':
      return (
        `O pagamento do pedido ${pedido} (${valor}) foi estornado.\n`
        + 'O valor volta pelo mesmo meio de pagamento; o prazo para aparecer depende do seu '
        + 'banco ou da operadora do cartão.\n'
      );
    case 'estorno_solicitado':
      return (
        `A loja registrou a devolução do pedido ${pedido} e pediu o estorno de ${valor} ao `
        + 'provedor de pagamento.\n'
        + 'O valor volta pelo mesmo meio de pagamento; o prazo para aparecer depende do seu '
        + 'banco ou da operadora do cartão.\n'
      );
    case 'contestacao':
      return (
        `O pagamento do pedido ${pedido} foi contestado junto à operadora do cartão, e o `
        + 'pedido foi encerrado.\n'
        + 'O valor segue o processo da contestação na operadora.\n'
      );
    case 'devolucao_pela_loja':
      return (
        `A loja registrou a devolução do pedido ${pedido}.\n`
        + `O estorno de ${valor} não é automático neste caso: a loja entra em contato para `
        + 'combinar como o valor volta para você.\n'
      );
  }
}

/**
 * O texto de cada mensagem.
 *
 * Só texto puro. HTML de e-mail transacional é um problema de compatibilidade
 * com dezenas de clientes de e-mail, e a informação aqui — número do pedido,
 * valor, rastreio — cabe inteira em texto. Quando houver identidade visual
 * definida, a versão HTML entra ao lado desta, nunca no lugar.
 */
export function renderEmail(
  template: EmailTemplate,
  ctx: Contexto,
): { subject: string; bodyText: string } {
  const pedido = `#${ctx.orderNumber}`;

  switch (template) {
    case 'pedido_recebido':
      return {
        subject: `${ctx.storeName} · pedido ${pedido} recebido`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + `Recebemos seu pedido ${pedido} no valor de R$ ${reais(ctx.totalCents)}.\n`
          // Dizer que ainda NÃO está pago evita a pessoa achar que acabou.
          + 'Ele será separado assim que o pagamento for confirmado pelo provedor.\n\n'
          + assinaturaDe(ctx),
      };

    case 'pagamento_confirmado':
      return {
        subject: `${ctx.storeName} · pagamento do pedido ${pedido} confirmado`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + `O pagamento do pedido ${pedido} foi confirmado.\n`
          + 'Já estamos preparando seus itens.\n\n'
          + assinaturaDe(ctx),
      };

    case 'pedido_expedido':
      return {
        subject: `${ctx.storeName} · pedido ${pedido} a caminho`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + `Seu pedido ${pedido} saiu para entrega`
          + (ctx.carrierName ? ` (${ctx.carrierName})` : '')
          + '.\n'
          + (ctx.trackingCode ? `Código de rastreio: ${ctx.trackingCode}\n` : '')
          // O link da transportadora: o código sozinho mandava o cliente
          // adivinhar em que site procurar (GAP-PRD-119).
          + (ctx.trackingUrl ? `Acompanhe a entrega: ${ctx.trackingUrl}\n` : '')
          // Prazo só quando existe: "chega em X dias" inventado vira dívida.
          + (ctx.estimatedDays
            ? `Prazo estimado: ${ctx.estimatedDays} dia(s) útil(eis) a partir da postagem.\n`
            : '')
          + `\n${assinaturaDe(ctx)}`,
      };

    case 'pedido_pronto_retirada':
      return {
        subject: `${ctx.storeName} · pedido ${pedido} pronto para retirada`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + `Seu pedido ${pedido} está pronto e separado na loja.\n`
          + 'Traga um documento com foto para retirar.\n\n'
          + assinaturaDe(ctx),
      };

    case 'pedido_entregue':
      // O fim do caminho — e o canal para dizer "não recebi".
      return {
        subject: ctx.retirada
          ? `${ctx.storeName} · pedido ${pedido} retirado`
          : `${ctx.storeName} · pedido ${pedido} entregue`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + (ctx.retirada
            ? `Seu pedido ${pedido} foi retirado na loja. Obrigado pela compra!\n`
            : `Seu pedido ${pedido} foi entregue. Obrigado pela compra!\n`)
          + linhaDoPedido(ctx)
          + 'Se não foi você quem recebeu, ou se algo veio diferente do pedido, fale com a loja.\n\n'
          + assinaturaDe(ctx),
      };

    case 'pedido_cancelado':
      return {
        subject: `${ctx.storeName} · pedido ${pedido} cancelado`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + corpoDoCancelamento(ctx, pedido)
          + `\n${assinaturaDe(ctx)}`,
      };

    case 'pedido_reembolsado':
      return {
        subject: `${ctx.storeName} · devolução do pedido ${pedido}`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + corpoDoReembolso(ctx, pedido)
          + linhaDoPedido(ctx)
          + `\n${assinaturaDe(ctx)}`,
      };

    case 'pagamento_apos_cancelamento': {
      // O dinheiro chegou num pedido que já não existe: o cliente precisa
      // saber que foi visto e que não precisa pagar de novo.
      const valor =
        ctx.valorRecebidoCents !== undefined && ctx.valorRecebidoCents !== null
          ? ` de R$ ${reais(ctx.valorRecebidoCents)}`
          : '';
      return {
        subject: `${ctx.storeName} · recebemos o pagamento do pedido ${pedido}, que estava cancelado`,
        bodyText:
          `Olá, ${ctx.customerName}.\n\n`
          + `O pagamento${valor} do pedido ${pedido} foi confirmado depois que o pedido já `
          + 'estava cancelado. O pedido continua cancelado e os itens não foram reservados de novo.\n'
          + 'A loja vai entrar em contato para devolver o valor ou, se você preferir, refazer o '
          + 'pedido. Você não precisa pagar de novo.\n\n'
          + assinaturaDe(ctx),
      };
    }

    case 'recuperacao_senha_equipe':
    case 'recuperacao_senha':
      // A recuperação de senha tem corpo próprio, montado em
      // `queuePasswordResetEmail` (o token não passa por `Contexto`). Este
      // ramo existe só para o switch ficar exaustivo — não é chamado.
      return {
        subject: 'Grupo Sampaio · recuperação de senha',
        bodyText: 'Use o link enviado para redefinir sua senha.',
      };

    case 'conta_criada':
    case 'senha_alterada':
    case 'google_ligado':
    case 'verificacao_email':
    case 'pacote_contador':
    case 'nota_disponivel':
    case 'os_orcamento_disponivel':
    case 'os_pronta':
    case 'os_concluida':
    case 'pedido_compra':
      // Corpo próprio em `queueContaCriadaEmail`/`queueSenhaAlteradaEmail`/
      // `queueVerificacaoEmail`/`queuePacoteContadorEmail`, e os da nota e
      // da oficina em `queueMensagemPronta` (AvisoDaNotaDoPedido,
      // AvisosDaOficina) — não cabem em `Contexto`, que é de pedido. Os ramos
      // existem só para o switch ficar exaustivo — não são chamados.
      return {
        subject: 'Grupo Sampaio · aviso da sua conta',
        bodyText: 'Veja o aviso sobre a sua conta.',
      };
  }
}

/**
 * ============================================================================
 * O COFRE DE ANEXOS — o arquivo guardado UMA vez, e não uma por mensagem
 * ============================================================================
 *
 * ## O DEFEITO, EM MEGABYTES
 *
 * O zip do contador chega a 15 MB e era gravado dentro de `core_email_queue`,
 * uma cópia POR DESTINATÁRIO: o laço do `ContadorEnvioService` chamava a fila
 * com o MESMO `pacote.bytes` para cada contador ativo, e três destinatários na
 * mesma competência viravam três cópias do mesmo arquivo — num banco
 * operacional que tem 6,2 MB inteiro. A agenda repete o gesto todo mês, para
 * cada uma das seis empresas.
 *
 * ## O ID É O CONTEÚDO, e por isso a duplicata não tem como acontecer
 *
 * O id é o sha256 de (empresa + bytes). Duas mensagens que carregam o mesmo
 * arquivo caem no mesmo id por CONSTRUÇÃO: o segundo INSERT é um
 * `ON CONFLICT DO NOTHING`, e não uma comparação que alguém pode esquecer de
 * fazer. A empresa entra no hash de propósito — conteúdo idêntico de DUAS
 * operações não pode compartilhar linha, ou uma leria o cofre da outra.
 */
function guardarAnexo(companyId: string, nome: string, bytes: Buffer): string {
  const id = createHash('sha256')
    .update(companyId)
    // O separador é um byte que id de empresa não contém — sem ele,
    // (empresa 'ab', bytes 'c') e (empresa 'a', bytes 'bc') teriam o mesmo sha.
    .update('\u0000')
    .update(bytes)
    .digest('hex');
  getConnection()
    .prepare(
      `INSERT INTO core_email_attachments (id, company_id, nome, size_bytes, conteudo, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, companyId, nome, bytes.length, bytes, new Date().toISOString());
  return id;
}

/**
 * A FAXINA DO COFRE — os bytes saem quando ninguém mais precisa deles.
 *
 * ## A RETENÇÃO, DECLARADA
 *
 * O anexo vive enquanto houver mensagem PENDENTE que ainda possa sair — e,
 * desde o GAP-PRD-038, enquanto houver mensagem que FALHOU há menos de um mês
 * (ela pode voltar à fila pela tela; ver `RETENCAO_DO_ANEXO_QUE_FALHOU_MS`).
 * Sent não vai ler o arquivo nunca mais. Guardá-lo seria megabyte parado
 * dentro do banco da loja, para sempre, sem pergunta que o leia.
 *
 * PENDENTE NUNCA É PODADO, e essa metade é tão importante quanto a outra: sem
 * credencial a fila acumula — é o estado honesto que este arquivo declara no
 * cabeçalho —, e apagar o anexo de um pendente entregaria, no dia em que a
 * credencial existisse, um e-mail dizendo "segue anexo" sem anexo nenhum.
 *
 * O nome do arquivo NÃO é apagado da mensagem: ele custa bytes e responde
 * "qual arquivo foi para o contador em julho?" na tela do histórico. O que sai
 * é o conteúdo. E o ponteiro cai junto — `anexo_id` pendurado para uma linha
 * que não existe mais seria uma mentira sobre o que o banco ainda tem.
 *
 * ## POR QUE ELA NÃO ESPERA UM AGENDADOR
 *
 * Aqui existiu um `pruneSentEmails` que nenhum agendador, rota ou teste jamais
 * chamou, e ele foi removido com um argumento que continua valendo: faxina que
 * roda em EVENTO DE VERDADE segue o molde de `expireOverdueQuotes` na abertura
 * de caixa, e NASCE COM o evento que a dispara. Esta nasce com dois, e são os
 * dois momentos em que o cofre muda de tamanho: o FLUSH (que acabou de tornar
 * um anexo desnecessário) e o ENVIO (que está prestes a guardar mais um). O
 * que mudou desde aquele comentário não é o argumento — é que agora existe
 * evento para pendurar a faxina.
 *
 * ## O ESCOPO É DECLARADO, e o compilador cobra a declaração
 *
 * O DEFEITO: esta função varria o cofre INTEIRO, sem filtro de empresa, e um
 * dos dois eventos que a disparam tem escopo de empresa — `enviarPacotePorEmail`
 * roda com o `companyId` do token. A Gringa mandava o mês dela e o cofre da
 * Preço Justo encolhia junto. Não vaza dado (só apaga órfão), mas é escrita
 * cross-tenant num sistema cuja regra é `companyId` SEMPRE do token; e "só
 * órfão" não é conforto, porque órfão é o que ESTA consulta considera órfão, e
 * ela rodava com o conhecimento de uma empresa sobre o banco de seis.
 *
 * O escopo virou PARÂMETRO OBRIGATÓRIO, e não um `companyId` opcional que some
 * por esquecimento: os dois eventos são legitimamente diferentes — o flush é o
 * worker de fundo, que atende as seis, e o envio é o gesto de uma. Quem chamar
 * tem de dizer qual dos dois é, ou não compila.
 */
export type EscopoDaFaxina =
  /** O gesto de UMA empresa: só o cofre dela é varrido. */
  | { readonly companyId: string }
  /**
   * O worker de fundo. O flush lê `core_email_queue` inteira, sem filtro de
   * empresa, porque é o carteiro das seis — a faxina que vem depois dele
   * enxerga o mesmo tanto, e aqui isso é o escopo certo e não um descuido.
   */
  | 'todas_as_empresas';

/**
 * Quanto tempo o anexo de uma mensagem que DESISTIU fica guardado.
 *
 * Desde o GAP-PRD-038 o `failed` não é mais terminal: o gestor pode devolver
 * a mensagem à fila pela tela. Um pacote do contador que falhou e volta sem o
 * zip seria um e-mail dizendo "segue anexo" sem anexo — então os bytes de quem
 * falhou ficam por um mês, o prazo de alguém notar e reenviar. Depois disso a
 * faxina leva, e a tela diz que o reenvio precisa gerar o pacote de novo.
 */
const RETENCAO_DO_ANEXO_QUE_FALHOU_MS = 30 * 24 * 60 * 60 * 1000;

export function liberarAnexosSemDono(escopo: EscopoDaFaxina): number {
  ensureCoreSchema();
  const db = getConnection();
  const daEmpresa = escopo !== 'todas_as_empresas';
  const corteDoFalho = new Date(Date.now() - RETENCAO_DO_ANEXO_QUE_FALHOU_MS).toISOString();
  const mortos = db
    .prepare(
      `SELECT a.id FROM core_email_attachments a
        WHERE ${daEmpresa ? 'a.company_id = ?' : '1 = 1'}
          AND NOT EXISTS (
          SELECT 1 FROM core_email_queue q
           WHERE q.anexo_id = a.id
             AND (q.status = 'pending'
                  OR (q.status = 'failed' AND q.created_at >= ?)))`,
    )
    .all(...(daEmpresa ? [escopo.companyId] : []), corteDoFalho) as unknown as { id: string }[];
  if (mortos.length === 0) return 0;

  return withTransaction(() => {
    const soltar = db.prepare('UPDATE core_email_queue SET anexo_id = NULL WHERE anexo_id = ?');
    const apagar = db.prepare('DELETE FROM core_email_attachments WHERE id = ?');
    for (const morto of mortos) {
      // O ponteiro cai ANTES do conteúdo: a chave estrangeira recusaria o
      // DELETE com a mensagem entregue ainda apontando para cá.
      soltar.run(morto.id);
      apagar.run(morto.id);
    }
    return mortos.length;
  });
}

/**
 * O PACOTE DO CONTADOR vai por e-mail (GAP-V30) — corpo e anexo prontos.
 *
 * O molde é o de `queuePasswordResetEmail`: corpo montado por quem conhece o
 * fato (o `ContadorEnvioService`, que tem a prévia do mês em mãos), payload
 * mínimo para a tela da fila, dedupe pelo fato. O ANEXO segue o mesmo
 * princípio do corpo — o zip é montado NO INSTANTE do envio e gravado pronto:
 * montar na hora do flush entregaria um mês que pode ter mudado desde o
 * clique, e a pessoa teria conferido uma prévia e mandado outra.
 *
 * O que mudou: os bytes vão para o COFRE (ver `guardarAnexo`) e a mensagem
 * guarda o PONTEIRO. Três destinatários passam a custar um arquivo, não três.
 *
 * Nada aqui é segredo: o pacote é o mesmo zip que o botão "Baixar" entrega, e
 * o payload guarda só o resumo que a tela do histórico mostra.
 *
 * ## OS BYTES SÓ ENTRAM DEPOIS QUE A MENSAGEM ENTROU
 *
 * O DEFEITO: `guardarAnexo` corria ANTES do INSERT, e o INSERT é
 * `ON CONFLICT (dedupe_key) DO NOTHING`. Se dois envios da mesma competência
 * produzissem bytes DIFERENTES — um carimbo de tempo dentro do zip basta —, o
 * segundo gravava um anexo com sha novo cujo INSERT de mensagem era descartado
 * pelo dedupe. Nascia um órfão de até 15 MB na hora, coletado só na próxima
 * passagem da faxina; e a faxina agora é por EMPRESA, então "próxima passagem"
 * pode ser no mês seguinte, num banco operacional de 6,2 MB.
 *
 * A ordem consertada: tenta a mensagem primeiro (com o ponteiro ainda nulo),
 * e só quem GANHOU a chave paga o cofre. Tudo numa transação, para que a
 * mensagem nunca fique visível prometendo um anexo que ainda não existe.
 */
export function queuePacoteContadorEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  subject: string;
  bodyText: string;
  anexoNome?: string | null;
  anexoBytes?: Buffer | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  const id = randomUUID();
  const db = getConnection();

  return withTransaction(() => {
    const inserido = db
      .prepare(
        `INSERT INTO core_email_queue
           (id, company_id, template, to_address, subject, body_text, payload,
            status, attempts, dedupe_key, anexo_nome, anexo_id, created_at)
         VALUES (?, ?, 'pacote_contador', ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        input.companyId,
        String(input.toAddress).trim(),
        input.subject,
        input.bodyText,
        JSON.stringify(input.payload),
        input.dedupeKey,
        input.anexoNome ?? null,
        new Date().toISOString(),
      );

    // Chave repetida: a mensagem é a MESMA que já está na fila. Nenhum byte
    // entra no cofre por causa dela — era exatamente aqui que nascia o órfão.
    if (inserido.changes === 0) return null;

    // Só existe anexo quando os DOIS existem: nome sem bytes seria uma promessa
    // de arquivo, e bytes sem nome não têm como viajar.
    if (input.anexoNome && input.anexoBytes) {
      const anexoId = guardarAnexo(input.companyId, input.anexoNome, input.anexoBytes);
      db.prepare('UPDATE core_email_queue SET anexo_id = ? WHERE id = ?').run(anexoId, id);
    }

    return id;
  });
}

// ------------------------------------------- o conteúdo protegido (GAP-PRD-007)

/**
 * O que a TELA vê no lugar do segredo — no corpo guardado na fila.
 *
 * ## O DEFEITO QUE ISTO FECHA
 *
 * O token de recuperação de senha e o código de verificação iam no
 * `body_text`, e a redação só valia para o `payload`. Mas é o `body_text` que
 * `GET /core/emails` devolve e que a tela de E-mails mostra ao gerente — e a
 * conta do cliente é do GRUPO: o gerente de uma loja pedia "esqueci a senha"
 * com o e-mail do cliente, lia o link na fila (sem SMTP ele fica pendente e o
 * gerente lê ANTES do cliente) e redefinia a senha. Takeover provado ponta a
 * ponta pela auditoria.
 *
 * ## COMO FICOU
 *
 * O corpo guardado tem ESTE marcador no lugar do segredo. O segredo em si vai
 * selado para `core_email_segredos`, com prazo, e só o carteiro o abre — para
 * montar o texto que sai para o cliente (`montarTextoDeEntrega`). Entregue,
 * desistido ou vencido, o segredo é APAGADO. A tela de gestão nunca teve como
 * ler o que o banco não lhe entrega, e o banco em repouso não o guarda em
 * claro nem durante a hora em que ele vale.
 */
export const MARCA_DO_CONTEUDO_PROTEGIDO = '[protegido: só o cliente recebe]';

/** O link e o código valem uma hora — o mesmo prazo do portal. */
const PRAZO_DO_CONTEUDO_PROTEGIDO_MS = 60 * 60 * 1000;

/** Os modelos que carregam segredo de uso único. */
const MODELOS_COM_SEGREDO: ReadonlySet<EmailTemplate> = new Set<EmailTemplate>([
  'recuperacao_senha',
  'recuperacao_senha_equipe',
  'verificacao_email',
]);

/**
 * A MÁSCARA PARA O QUE FOI GRAVADO ANTES DO COFRE.
 *
 * Mensagens enfileiradas antes desta mudança têm o link e o código em claro no
 * `body_text` — a linha da fila nunca é podada, então o link ficaria legível
 * para sempre. A tela passa por esta máscara; o carteiro, ao entregar ou
 * desistir de uma dessas, grava o corpo já mascarado. A limpeza em lote do que
 * já foi entregue é passo de dados, descrito em
 * `docs/audits/remediacao/migracoes/EML.md`.
 */
export function mascararConteudoProtegidoLegado(template: string, corpo: string): string {
  if (!MODELOS_COM_SEGREDO.has(template as EmailTemplate)) return corpo;
  return (
    corpo
      // O link de recuperação: qualquer endereço que carregue `token=`.
      .replace(/\S*token=\S+/gi, MARCA_DO_CONTEUDO_PROTEGIDO)
      // O código de verificação: a sequência de dígitos do corpo antigo.
      .replace(/\b\d{4,8}\b/g, MARCA_DO_CONTEUDO_PROTEGIDO)
  );
}

/**
 * A NOTIFICAÇÃO NUNCA DERRUBA O FATO (GAP-PRD-201).
 *
 * O contrato estava escrito só em `enfileirarEmailDoPedido` ("a venda vale
 * mais que a notificação"); os avisos da conta chamavam a fila direto, dentro
 * da transação do registro e da troca de senha, e uma exceção do INSERT
 * desfazia a conta recém-criada ou a senha recém-trocada.
 *
 * O conserto mora AQUI, e não em cada chamador, para que o próximo disparo
 * nasça com o contrato: o enfileiramento roda num SAVEPOINT próprio
 * (`withTransaction` aninhado), a falha desfaz só ele, vira log e `null` — e o
 * fato de quem chamou segue inteiro.
 *
 * `queuePacoteContadorEmail` fica FORA de propósito: ali o e-mail É o fato (o
 * contador pediu o mês), e engolir a falha responderia "enviado" a um envio
 * que não existe.
 */
function semDerrubarOFato(template: EmailTemplate, enfileirar: () => string | null): string | null {
  try {
    return withTransaction(enfileirar);
  } catch (err) {
    registrarQueNaoEnfileirou(template, err);
    return null;
  }
}

function registrarQueNaoEnfileirou(template: EmailTemplate, err: unknown): void {
  logError('email_nao_enfileirado', {
    template,
    motivo: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  });
}

interface LinhaNova {
  companyId: string;
  template: EmailTemplate;
  toAddress: string;
  subject: string;
  bodyText: string;
  payload: string;
  dedupeKey: string;
}

/** O INSERT da fila — `null` quando o dedupe descarta (mesmo fato, mesma mensagem). */
function inserirNaFila(linha: LinhaNova): string | null {
  const id = randomUUID();
  const inserido = getConnection()
    .prepare(
      `INSERT INTO core_email_queue
         (id, company_id, template, to_address, subject, body_text, payload,
          status, attempts, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .run(
      id,
      linha.companyId,
      linha.template,
      linha.toAddress.trim(),
      linha.subject,
      linha.bodyText,
      linha.payload,
      linha.dedupeKey,
      new Date().toISOString(),
    );
  // O id DA MENSAGEM. Aqui já se devolveu `lastInsertRowid` (o rowid interno
  // do SQLite), que não abre linha nenhuma pelo id.
  return inserido.changes > 0 ? id : null;
}

/**
 * Enfileira uma mensagem que carrega segredo: o corpo vai com o marcador, e o
 * segredo vai selado para `core_email_segredos`.
 *
 * O selo (scrypt + AES-GCM) é feito ANTES da transação: a chave derivada custa
 * dezenas de milissegundos, e segurar o write lock do banco da loja por isso
 * seria pagar o custo em todos os caixas.
 */
function enfileirarComSegredo(input: {
  linha: LinhaNova;
  segredo: string;
  expiraEm: string;
}): string | null {
  let cifrado: string;
  try {
    cifrado = encryptFiscalSecret(input.segredo);
  } catch (err) {
    // Cofre indisponível também não derruba o fato — e o segredo NÃO cai no
    // corpo em claro como plano B: sem selo, a mensagem simplesmente não entra.
    registrarQueNaoEnfileirou(input.linha.template, err);
    return null;
  }
  return semDerrubarOFato(input.linha.template, () => {
    const id = inserirNaFila(input.linha);
    if (!id) return null;
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_email_segredos
           (id, company_id, segredo_cifrado, expira_em, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, input.linha.companyId, cifrado, input.expiraEm, agora);
    return id;
  });
}

function prazoDoSegredo(expiraEm: string | undefined): string {
  return expiraEm ?? new Date(Date.now() + PRAZO_DO_CONTEUDO_PROTEGIDO_MS).toISOString();
}

/**
 * O PEDIDO DE COMPRA vai ao fornecedor (GAP-PRD-090) — corpo e papel prontos.
 *
 * O molde é o do pacote do contador, e pela mesma razão: o documento é montado
 * NO INSTANTE do clique e guardado pronto. Montar na hora do flush mandaria um
 * pedido que pode ter mudado entre o clique e a entrega — e o fornecedor
 * separaria mercadoria de um combinado que ninguém enviou.
 *
 * O anexo é o MESMO A4 que o botão Imprimir abre (HTML autocontido): dois
 * papéis para o mesmo pedido divergiriam no primeiro campo que alguém mudasse.
 * Nada aqui é segredo — é o que o fornecedor tem de receber.
 */
export function queuePedidoCompraEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  subject: string;
  bodyText: string;
  anexoNome: string;
  anexoBytes: Buffer;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  const id = randomUUID();
  const db = getConnection();

  return withTransaction(() => {
    const inserido = db
      .prepare(
        `INSERT INTO core_email_queue
           (id, company_id, template, to_address, subject, body_text, payload,
            status, attempts, dedupe_key, anexo_nome, anexo_id, created_at)
         VALUES (?, ?, 'pedido_compra', ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        input.companyId,
        String(input.toAddress).trim(),
        input.subject,
        input.bodyText,
        JSON.stringify(input.payload),
        input.dedupeKey,
        input.anexoNome,
        new Date().toISOString(),
      );
    // Chave repetida: nenhum byte entra no cofre (a lição do pacote do contador).
    if (inserido.changes === 0) return null;
    const anexoId = guardarAnexo(input.companyId, input.anexoNome, input.anexoBytes);
    db.prepare('UPDATE core_email_queue SET anexo_id = ? WHERE id = ?').run(anexoId, id);
    return id;
  });
}

/**
 * Enfileira o e-mail de recuperação de senha.
 *
 * O LINK É UM SEGREDO: quem o tiver redefine a senha do cliente enquanto ele
 * valer. Ele não entra no payload NEM no corpo guardado — vai selado para
 * `core_email_segredos`, e o corpo leva `MARCA_DO_CONTEUDO_PROTEGIDO` no lugar.
 * A tela do gestor vê que houve um pedido de recuperação, não o link.
 *
 * O e-mail fica na fila com status `pending` até haver SMTP — o mesmo padrão
 * honesto do resto do sistema. Se o link vencer antes de sair, a mensagem
 * desiste dizendo isso (mandar link vencido seria pior que não mandar).
 */
export function queuePasswordResetEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  resetLink: string;
  dedupeKey: string;
  /** Quando o link deixa de valer; padrão: 1 hora, o prazo do portal. */
  expiraEm?: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  return enfileirarComSegredo({
    linha: {
      companyId: input.companyId,
      template: 'recuperacao_senha',
      toAddress: String(input.toAddress),
      subject: 'Grupo Sampaio · recuperação de senha',
      bodyText:
        'Você pediu para redefinir a senha da sua conta no Grupo Sampaio.\n\n'
        + `Abra este link para escolher uma nova senha (vale por 1 hora):\n${MARCA_DO_CONTEUDO_PROTEGIDO}\n\n`
        + 'Se não foi você, ignore este e-mail: sua senha continua a mesma.\n\n'
        + 'Grupo Sampaio',
      // Payload SEM o token — a tela do gestor não pode virar um sequestro.
      payload: JSON.stringify({ tipo: 'recuperacao_senha', pedidoEm: new Date().toISOString() }),
      dedupeKey: input.dedupeKey,
    },
    segredo: input.resetLink,
    expiraEm: prazoDoSegredo(input.expiraEm),
  });
}

/**
 * O CÓDIGO DE TROCA DE SENHA DA EQUIPE (GAP-PRD-054) — pelo mesmo cofre.
 *
 * A recuperação da equipe nasceu gravando o código de oito dígitos em claro no
 * corpo da fila, e escondendo-o só na tela. A fila nunca é podada: o código
 * ficaria no arquivo do banco e em todo backup dele. Ele vai selado, como o
 * link do portal e o código de confirmação (GAP-PRD-007): o corpo leva o
 * marcador e o carteiro troca pelo código só na hora de entregar. Venceu (15
 * minutos) sem sair, a mensagem desiste e o segredo é apagado.
 */
export function queueCodigoDaEquipeEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  nome: string;
  login: string;
  codigo: string;
  dedupeKey: string;
  expiraEm: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;
  return enfileirarComSegredo({
    linha: {
      companyId: input.companyId,
      template: 'recuperacao_senha_equipe',
      toAddress: String(input.toAddress),
      subject: 'Grupo Sampaio · código para trocar a sua senha',
      bodyText:
        `Olá, ${input.nome}.\n\n`
        + `Alguém pediu para trocar a senha da sua conta no sistema do Grupo Sampaio (login: ${input.login}).\n\n`
        + `Código: ${MARCA_DO_CONTEUDO_PROTEGIDO}\n\n`
        + 'Ele vale por 15 minutos e só uma vez. Digite-o na tela de entrada, em "Esqueci minha senha".\n\n'
        + 'Se não foi você, ignore este e-mail — a sua senha continua a mesma — e avise a gerência.\n\n'
        + 'Grupo Sampaio',
      // Payload SEM o código: a tela da fila não pode virar o atalho da conta alheia.
      payload: JSON.stringify({ tipo: 'recuperacao_senha_equipe', pedidoEm: new Date().toISOString() }),
      dedupeKey: input.dedupeKey,
    },
    segredo: input.codigo,
    expiraEm: input.expiraEm,
  });
}

/**
 * Um aviso da CONTA (não de pedido), com corpo próprio e sem segredo nenhum.
 *
 * O molde dos dois avisos abaixo é o de `queuePasswordResetEmail`: corpo
 * montado aqui, payload mínimo para a tela do gestor, dedupe pelo fato.
 */
function queueAvisoDaConta(input: {
  companyId: string;
  toAddress: string | null | undefined;
  template: 'conta_criada' | 'senha_alterada' | 'google_ligado';
  subject: string;
  bodyText: string;
  dedupeKey: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  return semDerrubarOFato(input.template, () =>
    inserirNaFila({
      companyId: input.companyId,
      template: input.template,
      toAddress: String(input.toAddress),
      subject: input.subject,
      bodyText: input.bodyText,
      payload: JSON.stringify({ tipo: input.template, em: new Date().toISOString() }),
      dedupeKey: input.dedupeKey,
    }),
  );
}

/**
 * O código que prova o e-mail — rodada 50.
 *
 * O CÓDIGO é segredo como o link do reset: vai selado para
 * `core_email_segredos`, e nem o payload nem o corpo guardado o carregam — a
 * fila é lida em tela, e o código na tela viraria verificação sequestrável.
 */
export function queueVerificacaoEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  codigo: string;
  dedupeKey: string;
  /** Quando o código deixa de valer; padrão: 1 hora, o prazo do portal. */
  expiraEm?: string;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  return enfileirarComSegredo({
    linha: {
      companyId: input.companyId,
      template: 'verificacao_email',
      toAddress: String(input.toAddress),
      subject: 'Grupo Sampaio · confirme seu e-mail',
      bodyText:
        'Olá!\n\n'
        + `Seu código de confirmação no Grupo Sampaio é: ${MARCA_DO_CONTEUDO_PROTEGIDO}\n\n`
        + 'Digite-o na página "Minha conta" para provar que este e-mail é seu.\n'
        + 'Ele vale por 1 hora. Se não foi você, ignore esta mensagem.\n\n'
        + 'Grupo Sampaio',
      // Payload SEM o código — a tela do gestor vê que houve pedido, só.
      payload: JSON.stringify({ tipo: 'verificacao_email', em: new Date().toISOString() }),
      dedupeKey: input.dedupeKey,
    },
    segredo: input.codigo,
    expiraEm: prazoDoSegredo(input.expiraEm),
  });
}

/** A conta nasceu: o dono do e-mail precisa saber — inclusive se não foi ele. */
export function queueContaCriadaEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  dedupeKey: string;
}): string | null {
  return queueAvisoDaConta({
    ...input,
    template: 'conta_criada',
    subject: 'Grupo Sampaio · sua conta foi criada',
    bodyText:
      'Olá!\n\n'
      + 'Sua conta no Grupo Sampaio foi criada com este e-mail.\n'
      + 'Por aqui você acompanha seus pedidos, endereços e equipamentos.\n\n'
      + 'Se não foi você quem criou a conta, responda este e-mail que a gente resolve.\n\n'
      + 'Grupo Sampaio',
  });
}

/**
 * A senha mudou: quem NÃO trocou precisa ficar sabendo AGORA.
 *
 * O corpo não carrega a senha nem token nenhum — só o fato e o caminho de
 * reação. A recuperação de senha derruba as sessões de quem trocou, e é para
 * lá que o aviso aponta.
 */
export function queueSenhaAlteradaEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  dedupeKey: string;
}): string | null {
  return queueAvisoDaConta({
    ...input,
    template: 'senha_alterada',
    subject: 'Grupo Sampaio · sua senha foi alterada',
    bodyText:
      'Olá.\n\n'
      + 'A senha da sua conta no Grupo Sampaio acabou de ser alterada.\n\n'
      + 'Se foi você, está tudo certo — pode ignorar este aviso.\n'
      + 'Se NÃO foi você, use "Esqueci minha senha" agora mesmo: a nova senha\n'
      + 'derruba todas as sessões abertas, inclusive a de quem trocou.\n\n'
      + 'Grupo Sampaio',
  });
}

/**
 * A conta ganhou a entrada pelo Google (GAP-PRD-027): o dono do e-mail
 * precisa saber — se não foi ele, a conta Google que entrou não é dele.
 */
export function queueGoogleLigadoEmail(input: {
  companyId: string;
  toAddress: string | null | undefined;
  dedupeKey: string;
  googleEmail: string;
}): string | null {
  return queueAvisoDaConta({
    companyId: input.companyId,
    toAddress: input.toAddress,
    dedupeKey: input.dedupeKey,
    template: 'google_ligado',
    subject: 'Grupo Sampaio · entrada pelo Google ligada à sua conta',
    bodyText:
      'Olá.\n\n'
      + `A sua conta no Grupo Sampaio agora também entra pela conta Google ${input.googleEmail}.\n\n`
      + 'Se foi você, está tudo certo — pode ignorar este aviso.\n'
      + 'Se NÃO foi você, entre na conta, desligue o Google em "Minha conta" e troque a senha\n'
      + '(ou use "Esqueci minha senha", que derruba todas as sessões abertas).\n\n'
      + 'Grupo Sampaio',
  });
}

// -------------------------------------------------------------- a fila

/**
 * Enfileira uma mensagem — DENTRO da transação do fato.
 *
 * Devolve o id, ou `null` quando não há nada a fazer: endereço inutilizável,
 * mensagem já enfileirada para o mesmo fato, ou fila indisponível (logado).
 * Nenhum dos três pode derrubar a venda — perder um pedido porque o cliente
 * digitou o e-mail errado seria trocar um problema pequeno por um grande.
 */
export function queueEmail(input: {
  companyId: string;
  template: EmailTemplate;
  toAddress: string | null | undefined;
  dedupeKey: string;
  context: Contexto;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  return semDerrubarOFato(input.template, () => {
    // A assinatura da empresa (GAP-PRD-198) entra no corpo NO INSTANTE DO
    // FATO, como o resto da mensagem. Modo `grupo`: nula, e vale a de sempre.
    const context: Contexto = {
      ...input.context,
      assinatura: input.context.assinatura ?? assinaturaDaEmpresa(input.companyId),
    };
    const { subject, bodyText } = renderEmail(input.template, context);
    return inserirNaFila({
      companyId: input.companyId,
      template: input.template,
      toAddress: String(input.toAddress),
      subject,
      bodyText,
      // Só o que a mensagem mostra. A fila é lida em tela; segredo não entra.
      payload: JSON.stringify(context),
      dedupeKey: input.dedupeKey,
    });
  });
}

/** Os modelos que chegam com corpo montado por quem conhece o fato. */
export type ModeloDeMensagemPronta = Extract<
  EmailTemplate,
  'nota_disponivel' | 'os_orcamento_disponivel' | 'os_pronta' | 'os_concluida'
>;

/**
 * Enfileira uma mensagem de corpo PRONTO — a oficina e a nota fiscal
 * (GAP-PRD-036, GAP-PRD-037).
 *
 * O molde é o de `queueAvisoDaConta`: quem conhece o fato monta o corpo (a
 * OS e a nota não cabem no `Contexto` do pedido), a fila guarda pronto,
 * dedupe pelo fato — e o contrato de sempre: NUNCA lança, a falha vira log e
 * `null` num SAVEPOINT próprio, e o fato de quem chamou segue.
 *
 * O anexo, quando houver, vai para o cofre DEPOIS que a mensagem ganhou a
 * chave — o mesmo cuidado de `queuePacoteContadorEmail` para não nascer órfão.
 *
 * Nenhum modelo com segredo passa por aqui (o tipo não deixa): segredo tem
 * caminho próprio, selado.
 */
export function queueMensagemPronta(input: {
  companyId: string;
  template: ModeloDeMensagemPronta;
  toAddress: string | null | undefined;
  subject: string;
  bodyText: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  anexo?: { nome: string; bytes: Buffer } | null;
}): string | null {
  ensureCoreSchema();
  if (!isDeliverableAddress(input.toAddress)) return null;

  return semDerrubarOFato(input.template, () => {
    const id = inserirNaFila({
      companyId: input.companyId,
      template: input.template,
      toAddress: String(input.toAddress),
      subject: input.subject,
      bodyText: input.bodyText,
      payload: JSON.stringify(input.payload),
      dedupeKey: input.dedupeKey,
    });
    if (!id) return null;
    if (input.anexo) {
      const anexoId = guardarAnexo(input.companyId, input.anexo.nome, input.anexo.bytes);
      getConnection()
        .prepare('UPDATE core_email_queue SET anexo_nome = ?, anexo_id = ? WHERE id = ?')
        .run(input.anexo.nome, anexoId, id);
    }
    return id;
  });
}

interface LinhaCruaDaFila {
  id: string;
  template: string;
  to_address: string;
  subject: string;
  body_text: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  sent_at: string | null;
  created_at: string;
  anexo_nome: string | null;
  anexo_id: string | null;
  tem_blob_legado: number;
}

/*
  Colunas nomeadas, e não `*`: desde o GAP-V30 a fila carrega BLOB de anexo (o
  zip do contador chega a megabytes), e a tela de gestão só precisa do resumo —
  arrastar cinquenta zips para listar cinquenta linhas seria pagar o pacote
  inteiro por linha. O blob legado entra só como "existe?".
*/
const COLUNAS_DA_TELA = `id, template, to_address, subject, body_text, status, attempts,
       last_error, next_attempt_at, sent_at, created_at, anexo_nome, anexo_id,
       (anexo_blob IS NOT NULL) AS tem_blob_legado`;

/**
 * Por que uma mensagem que DESISTIU não pode voltar à fila — ou `null` se pode.
 *
 * Duas razões, as duas sobre o que já não existe mais para mandar:
 *   - o segredo de uso único (link, código) foi apagado quando a mensagem
 *     desistiu — e já teria vencido de qualquer jeito (vale uma hora);
 *   - o zip do contador foi liberado pela faxina do cofre.
 */
function motivoSemReenvio(linha: LinhaCruaDaFila): string | null {
  if (MODELOS_COM_SEGREDO.has(linha.template as EmailTemplate)) {
    return linha.template === 'recuperacao_senha'
      ? 'O link de recuperação vale 1 hora e foi apagado quando a mensagem desistiu. '
          + 'O cliente precisa pedir outro em "Esqueci minha senha".'
      : 'O código de verificação vale 1 hora e foi apagado quando a mensagem desistiu. '
          + 'O cliente precisa pedir outro na página "Minha conta".';
  }
  if (linha.anexo_nome && !linha.anexo_id && !Number(linha.tem_blob_legado)) {
    return linha.template === 'nota_disponivel'
      ? 'O arquivo da nota já foi liberado do banco. '
          + 'Baixe o XML e o DANFE pela tela Fiscal e envie ao cliente.'
      : 'O arquivo anexo já foi liberado do banco. '
          + 'Gere o envio de novo pela tela do contador.';
  }
  return null;
}

function paraATela(r: LinhaCruaDaFila): EmailQueueRow {
  const falhou = r.status === 'failed';
  const motivo = falhou ? motivoSemReenvio(r) : null;
  return {
    id: String(r.id),
    template: r.template as EmailTemplate,
    templateLabel: rotuloDoModelo(r.template),
    toAddress: String(r.to_address),
    subject: String(r.subject),
    bodyText: mascararConteudoProtegidoLegado(r.template, String(r.body_text)),
    status: String(r.status),
    attempts: Number(r.attempts),
    lastError: r.last_error ?? null,
    nextAttemptAt: r.status === 'pending' ? (r.next_attempt_at ?? null) : null,
    sentAt: r.sent_at ?? null,
    createdAt: String(r.created_at),
    podeReenviar: falhou && motivo === null,
    motivoSemReenvio: motivo,
  };
}

export function listEmailQueue(
  companyId: string,
  limit = 50,
  status?: EmailQueueStatus,
): EmailQueueRow[] {
  ensureCoreSchema();
  const filtro = status ? ' AND status = ?' : '';
  return (
    getConnection()
      .prepare(
        `SELECT ${COLUNAS_DA_TELA}
           FROM core_email_queue
          WHERE company_id = ?${filtro} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...(status ? [companyId, status] : [companyId]), limit) as unknown as LinhaCruaDaFila[]
  ).map(paraATela);
}

function linhaDaEmpresa(companyId: string, id: string): LinhaCruaDaFila | undefined {
  return getConnection()
    .prepare(`SELECT ${COLUNAS_DA_TELA} FROM core_email_queue WHERE id = ? AND company_id = ?`)
    .get(id, companyId) as LinhaCruaDaFila | undefined;
}

/**
 * DEVOLVE À FILA uma mensagem que desistiu (GAP-PRD-038).
 *
 * `failed` era terminal: depois de qualquer instabilidade de SMTP, reenviar
 * era "chamar o desenvolvedor" para um UPDATE no banco. Agora é um clique na
 * tela — do gestor da EMPRESA DONA da mensagem (`companyId` do token), e
 * auditado com o motivo da falha que ficou para trás.
 *
 * O que ele NÃO faz: reenviar o que já saiu (duplicaria o e-mail na caixa do
 * cliente) nem o que não tem mais conteúdo para mandar (ver
 * `motivoSemReenvio`). A tentativa volta a contar do zero, sem espera.
 */
export function reenfileirarEmail(input: {
  companyId: string;
  id: string;
  userId?: string | null;
}): EmailQueueRow {
  ensureCoreSchema();
  const linha = linhaDaEmpresa(input.companyId, input.id);
  // Mensagem de OUTRA empresa responde igual a inexistente: dizer "existe,
  // mas não é sua" já seria contar o que a outra loja manda.
  if (!linha) {
    throw new ApiError('EMAIL_NAO_ENCONTRADO', 'Mensagem não encontrada nesta empresa.', 404);
  }
  if (linha.status === 'pending') {
    throw new ApiError(
      'EMAIL_JA_NA_FILA',
      'Esta mensagem já está na fila e sai na próxima tentativa.',
      409,
    );
  }
  if (linha.status === 'sent') {
    throw new ApiError(
      'EMAIL_JA_ENTREGUE',
      'Esta mensagem já foi entregue. Reenviar duplicaria o e-mail na caixa do cliente.',
      409,
    );
  }
  const motivo = motivoSemReenvio(linha);
  if (motivo) throw new ApiError('EMAIL_SEM_REENVIO', motivo, 409);

  withTransaction(() => {
    const mudou = getConnection()
      .prepare(
        `UPDATE core_email_queue
            SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
          WHERE id = ? AND company_id = ? AND status = 'failed'`,
      )
      .run(input.id, input.companyId);
    if (mudou.changes === 0) {
      throw new ApiError('EMAIL_JA_NA_FILA', 'Esta mensagem já voltou para a fila.', 409);
    }
    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'email.requeue',
      entityType: 'email_queue',
      entityId: input.id,
      detail: {
        template: linha.template,
        tentativasAnteriores: Number(linha.attempts),
        // O motivo já foi gravado sem a senha (`motivoSemSegredo`).
        ultimoErro: linha.last_error,
      },
    });
  });

  return paraATela(linhaDaEmpresa(input.companyId, input.id) as LinhaCruaDaFila);
}

// ---------------------------------------------------------- o carteiro

/** Um arquivo que viaja junto da mensagem (GAP-V30 — o zip do contador). */
export interface AnexoDeEmail {
  nome: string;
  conteudo: Buffer;
}

export interface MensagemSmtp {
  from: string;
  to: string;
  subject: string;
  text: string;
  /**
   * Para onde vai a resposta do cliente — só quando a empresa escolheu
   * identidade própria com Reply-To (GAP-PRD-198). Ausente, o cliente
   * responde ao remetente, como sempre.
   */
  replyTo?: string;
  /** Ausente ou vazio em todo e-mail sem anexo — o caso de sempre. */
  anexos?: AnexoDeEmail[];
}

/** Quem entrega. O real fala SMTP; os testes injetam um dublado. */
export interface CarteiroSmtp {
  enviar(msg: MensagemSmtp): Promise<void>;
}

/**
 * O carteiro real — nodemailer, carregado sob demanda como o `imapflow` da
 * caixa de entrada: o ERP inteiro não paga o custo do cliente SMTP quando a
 * credencial nem existe.
 *
 * Montado A CADA FLUSH com a credencial lida naquele instante (GAP-PRD-065):
 * trocar a senha de aplicativo no `.env` vale na batida seguinte.
 */
async function carteiroReal(cfg: ConfigSmtp): Promise<CarteiroSmtp> {
  const { default: nodemailer } = await import('nodemailer');
  const secure = cfg.port === 465;
  const transporte = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 é TLS implícito (o do Gmail).
    secure,
    // Fora da 465, o STARTTLS do nodemailer é OPORTUNISTA: um servidor (ou um
    // homem-no-meio removendo a capability do EHLO) que não ofereça STARTTLS
    // deixaria o AUTH sair em texto claro — a senha de app em base64
    // reversível no fio. `requireTLS` transforma o downgrade em erro duro:
    // sem canal cifrado, a credencial NUNCA viaja.
    requireTLS: !secure,
    auth: { user: cfg.user, pass: cfg.password },
  });
  return {
    async enviar(msg: MensagemSmtp): Promise<void> {
      await transporte.sendMail({
        from: msg.from,
        to: msg.to,
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        subject: msg.subject,
        text: msg.text,
        // O vocabulário do nodemailer para anexo: filename + content (Buffer).
        attachments: (msg.anexos ?? []).map((a) => ({
          filename: a.nome,
          content: a.conteudo,
        })),
      });
    },
  };
}

/**
 * QUANTO ESPERAR DEPOIS DE CADA FALHA, em minutos (GAP-PRD-038).
 *
 * Era "cinco tentativas, uma por batida de 60 s": cinco minutos de SMTP fora
 * — senha de app trocada, DNS, provedor instável — matavam TODOS os
 * pendentes, inclusive a recuperação de senha e o código de verificação. Com
 * a espera crescendo, a mensagem atravessa uma queda de quase quinze horas
 * antes de desistir, e o SMTP que volta em minutos a entrega em minutos.
 *
 * A sexta falha desiste (`failed`), com o motivo guardado — e o gestor a
 * devolve à fila pela tela (`reenfileirarEmail`).
 */
export const ESPERA_ENTRE_TENTATIVAS_MIN: readonly number[] = [1, 5, 30, 120, 720];
const MAX_TENTATIVAS = ESPERA_ENTRE_TENTATIVAS_MIN.length + 1;

/** Quando a próxima tentativa pode sair, depois da falha número `tentativas`. */
function proximaTentativa(tentativas: number, agora: Date): string {
  const minutos =
    ESPERA_ENTRE_TENTATIVAS_MIN[Math.min(tentativas, ESPERA_ENTRE_TENTATIVAS_MIN.length) - 1];
  return new Date(agora.getTime() + minutos * 60_000).toISOString();
}

/**
 * O motivo da falha SEM a senha. O `last_error` aparece na tela da fila, e
 * tela vaza em print — erro de AUTH do provedor costuma ecoar a credencial.
 */
function motivoSemSegredo(err: unknown, senha = configSmtp().password): string {
  let texto = err instanceof Error ? err.message : String(err);
  if (senha) texto = texto.split(senha).join('•••');
  return texto.slice(0, 500);
}

export interface ResultadoDoFlush {
  readiness: EmailReadiness;
  sent: number;
  failed: number;
  missing: string[];
}

/**
 * UM flush por vez — quem chegar durante um flush RECEBE o dele.
 *
 * O worker de 60 s, o tick sobreposto (SMTP lento passa de um minuto) e o
 * clique do gerente na tela vivem no MESMO processo e releriam os MESMOS
 * pendentes durante o `await` do SMTP: o SELECT vê `pending` até o UPDATE
 * pós-envio, e o cliente receberia o aviso em dobro — inclusive o de "sua
 * senha foi alterada", que duplicado vira ruído de segurança. Compartilhar a
 * promessa em voo fecha as três sobreposições de uma vez; o segundo chamador
 * não "perde a vez", ele recebe o resultado verdadeiro do flush que já
 * estava andando. (Vale porque o servidor é UM processo — a mesma premissa
 * do node:sqlite síncrono de todo o resto.)
 *
 * ## CADA FLUSH NO ESCOPO DE QUEM PEDIU (GAP-PRD-198)
 *
 * O clique "Processar fila" do gerente da Preço Justo entregava a fila das
 * SEIS: a mensagem da Gringa virava `sent` por um gesto de outra empresa.
 * Não vazava conteúdo, mas era escrita de estado cruzando a fronteira — num
 * sistema cuja regra é `companyId` SEMPRE do token. Agora o flush tem escopo:
 * o do gerente é a empresa dele; o do worker de fundo (sem empresa) continua
 * sendo o carteiro das seis.
 *
 * Mesmo escopo chegando junto compartilha a promessa (o de sempre). Escopo
 * DIFERENTE espera o anterior terminar e roda o seu — em fila, nunca em
 * paralelo: dois flushes de escopos que se sobrepõem (o global contém o da
 * empresa) lendo `pending` ao mesmo tempo seria o aviso em dobro de volta.
 */
const flushesEmVoo = new Map<string, Promise<ResultadoDoFlush>>();
let ultimoFlush: Promise<unknown> = Promise.resolve();

export interface OpcoesDoFlush {
  carteiro?: CarteiroSmtp;
  limite?: number;
  /**
   * O relógio. Só os testes passam: é o jeito de provar a espera entre
   * tentativas (minutos a horas) sem esperar minutos a horas.
   */
  agora?: Date;
  /**
   * A empresa do gesto (GAP-PRD-198): só a fila dela é entregue. Ausente, é o
   * worker de fundo — o carteiro das seis.
   */
  companyId?: string;
}

/**
 * Entrega o que está na fila.
 *
 * Sem credencial, devolve `READY_FOR_CREDENTIAL` e NÃO entrega nada — marcar
 * como enviado o que não saiu faria o suporte procurar na caixa do cliente
 * uma mensagem que nunca existiu. (A única coisa que anda sem credencial é o
 * PRAZO do conteúdo protegido: link vencido desiste dizendo que venceu, e o
 * segredo é apagado — ver `vencerConteudoProtegido`.)
 *
 * Com credencial, cada pendente cuja hora chegou sai UMA vez: enviado ganha
 * `sent_at`; falha conta tentativa, guarda o motivo (sem a senha) e empurra a
 * próxima tentativa; a sexta falha vira `failed`.
 */
export function flushEmailQueue(opts: OpcoesDoFlush = {}): Promise<ResultadoDoFlush> {
  const escopo = opts.companyId ?? '*';
  const emVoo = flushesEmVoo.get(escopo);
  if (emVoo) return emVoo;
  const rodar = () => fazerFlush(opts);
  // Atrás do anterior, dê ele certo ou errado: a falha de um flush não pode
  // travar a fila dos próximos.
  const promessa = ultimoFlush.then(rodar, rodar).finally(() => {
    flushesEmVoo.delete(escopo);
  });
  ultimoFlush = promessa.catch(() => undefined);
  flushesEmVoo.set(escopo, promessa);
  return promessa;
}

const MOTIVO_VENCEU: Record<string, string> = {
  recuperacao_senha:
    'O link de recuperação venceu (vale 1 hora) antes de sair. '
    + 'O cliente precisa pedir outro em "Esqueci minha senha".',
  verificacao_email:
    'O código de verificação venceu (vale 1 hora) antes de sair. '
    + 'O cliente precisa pedir outro na página "Minha conta".',
};

const MOTIVO_SEM_CONTEUDO =
  'O conteúdo protegido desta mensagem não existe mais (venceu ou foi apagado). '
  + 'O cliente precisa pedir outro.';

const MOTIVO_COFRE_NAO_ABRE =
  'O conteúdo protegido não abre com a chave atual do cofre. O cliente precisa pedir outro.';

function apagarSegredo(id: string): void {
  getConnection().prepare('DELETE FROM core_email_segredos WHERE id = ?').run(id);
}

/**
 * Desiste de uma mensagem sem tentar: não há o que mandar. Apaga o segredo e,
 * se o corpo for do tempo em que o segredo ficava em claro, grava-o mascarado.
 */
function desistirSemEnviar(id: string, template: string, motivo: string): boolean {
  const db = getConnection();
  const mudou = db
    .prepare(
      `UPDATE core_email_queue
          SET status = 'failed', last_error = ?, next_attempt_at = NULL
        WHERE id = ? AND status = 'pending'`,
    )
    .run(motivo, id);
  apagarSegredo(id);
  mascararCorpoGuardado(id, template);
  return mudou.changes > 0;
}

/** O corpo legado (segredo em claro) sai mascarado quando a mensagem termina. */
function mascararCorpoGuardado(id: string, template: string): void {
  if (!MODELOS_COM_SEGREDO.has(template as EmailTemplate)) return;
  const db = getConnection();
  const linha = db.prepare('SELECT body_text FROM core_email_queue WHERE id = ?').get(id) as
    | { body_text: string }
    | undefined;
  if (!linha) return;
  const mascarado = mascararConteudoProtegidoLegado(template, linha.body_text);
  if (mascarado !== linha.body_text) {
    db.prepare('UPDATE core_email_queue SET body_text = ? WHERE id = ?').run(mascarado, id);
  }
}

/**
 * O PRAZO DO SEGREDO ANDA MESMO SEM CREDENCIAL.
 *
 * Link de recuperação vale uma hora. Sem SMTP ele fica pendente — e depois da
 * hora, mandá-lo seria entregar ao cliente um link que responde "não vale
 * mais". A mensagem desiste dizendo por quê, e o segredo selado é APAGADO: não
 * existe motivo para o banco guardar, nem cifrado, o que não abre mais nada.
 *
 * Também recolhe segredo de mensagem que já terminou (o processo pode ter
 * morrido entre o envio e a faxina).
 *
 * No escopo do flush (GAP-PRD-198): o clique do gerente vence só o que é da
 * empresa dele; o worker de fundo vence o das seis.
 */
function vencerConteudoProtegido(agora: Date, companyId?: string): number {
  const db = getConnection();
  const vencidos = db
    .prepare(
      `SELECT s.id, q.status, q.template
         FROM core_email_segredos s
         JOIN core_email_queue q ON q.id = s.id
        WHERE (s.expira_em <= ? OR q.status <> 'pending')
          ${companyId ? 'AND q.company_id = ?' : ''}`,
    )
    .all(
      agora.toISOString(),
      ...(companyId ? [companyId] : []),
    ) as unknown as { id: string; status: string; template: string }[];
  let desistidos = 0;
  for (const v of vencidos) {
    if (v.status === 'pending') {
      if (desistirSemEnviar(v.id, v.template, MOTIVO_VENCEU[v.template] ?? MOTIVO_SEM_CONTEUDO)) {
        desistidos += 1;
      }
    } else {
      apagarSegredo(v.id);
    }
  }
  return desistidos;
}

interface Pendente {
  id: string;
  company_id: string;
  template: string;
  to_address: string;
  subject: string;
  body_text: string;
  attempts: number;
  anexo_nome: string | null;
  anexo_conteudo: Uint8Array | null;
  segredo_cifrado: string | null;
}

class SemConteudoParaEntregar extends Error {}

/**
 * O TEXTO QUE SAI PARA O CLIENTE — a única montagem que abre o cofre.
 *
 * Corpo guardado + segredo aberto no lugar do marcador. Corpo com marcador e
 * sem segredo (venceu, foi apagado, ou a linha legada foi mascarada) não é
 * entregável: sair assim seria mandar "abra este link: [protegido]".
 */
function montarTexto(corpo: string, segredoCifrado: string | null): string {
  if (segredoCifrado) {
    const segredo = decryptFiscalSecret(segredoCifrado);
    return corpo.split(MARCA_DO_CONTEUDO_PROTEGIDO).join(segredo);
  }
  if (corpo.includes(MARCA_DO_CONTEUDO_PROTEGIDO)) {
    throw new SemConteudoParaEntregar(MOTIVO_SEM_CONTEUDO);
  }
  return corpo;
}

/**
 * O texto exato que o cliente receberia por esta mensagem — ou `null`.
 *
 * É a MESMA montagem do carteiro, exposta para quem faz o papel da caixa de
 * entrada do cliente: os testes que precisam "abrir o e-mail" para ler o
 * código. NUNCA pendure isto numa rota — é exatamente o segredo que a tela de
 * gestão não pode ver (GAP-PRD-007).
 */
export function textoDeEntrega(emailId: string): string | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT q.body_text, s.segredo_cifrado
         FROM core_email_queue q
         LEFT JOIN core_email_segredos s ON s.id = q.id
        WHERE q.id = ?`,
    )
    .get(emailId) as { body_text: string; segredo_cifrado: string | null } | undefined;
  if (!linha) return null;
  try {
    return montarTexto(linha.body_text, linha.segredo_cifrado ?? null);
  } catch {
    return null;
  }
}

async function fazerFlush(opts: OpcoesDoFlush): Promise<ResultadoDoFlush> {
  ensureCoreSchema();
  const agora = opts.agora ?? new Date();
  const empresa = opts.companyId;
  // O prazo do segredo anda com ou sem credencial (ver a função).
  const vencidos = vencerConteudoProtegido(agora, empresa);

  const cfg = configSmtp();
  const faltando = credenciaisFaltando(cfg);
  if (faltando.length > 0) {
    return { readiness: 'READY_FOR_CREDENTIAL', sent: 0, failed: vencidos, missing: faltando };
  }

  const db = getConnection();
  const pendentes = db
    .prepare(
      /*
        O ANEXO VEM DO COFRE — com o blob antigo como rede.

        `a.conteudo` é o caminho de hoje: um arquivo, N mensagens. `q.anexo_blob`
        é a mensagem que já estava na fila ANTES do cofre existir, e ela precisa
        sair inteira mesmo assim — a migração não move bytes de propósito (ver o
        passo 84), então a fila legada se esvazia sozinha conforme anda.

        E SÓ SAI QUEM TEM HORA: `next_attempt_at` nulo (nunca falhou) ou já
        passado. A falha empurra a hora; o pendente antigo tem nulo e sai já.
      */
      `SELECT q.id, q.company_id, q.template, q.to_address, q.subject, q.body_text, q.attempts,
              q.anexo_nome, COALESCE(a.conteudo, q.anexo_blob) AS anexo_conteudo,
              s.segredo_cifrado
         FROM core_email_queue q
         LEFT JOIN core_email_attachments a ON a.id = q.anexo_id
         LEFT JOIN core_email_segredos s ON s.id = q.id
        WHERE q.status = 'pending'
          AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
          ${empresa ? 'AND q.company_id = ?' : ''}
        ORDER BY q.created_at
        LIMIT ?`,
    )
    .all(
      agora.toISOString(),
      ...(empresa ? [empresa] : []),
      Math.max(1, Math.min(200, opts.limite ?? 25)),
    ) as unknown as Pendente[];

  if (pendentes.length === 0) {
    return { readiness: 'READY', sent: 0, failed: vencidos, missing: [] };
  }

  const carteiro = opts.carteiro ?? (await carteiroReal(cfg));
  let sent = 0;
  let failed = vencidos;
  // O remetente de cada empresa (GAP-PRD-198), lido uma vez por flush.
  const remetentes = new Map<string, { from: string; replyTo?: string }>();
  const remetenteDe = (companyId: string) => {
    let r = remetentes.get(companyId);
    if (!r) {
      r = cabecalhosDoRemetente(companyId, cfg.from);
      remetentes.set(companyId, r);
    }
    return r;
  };

  for (const linha of pendentes) {
    let texto: string;
    try {
      texto = montarTexto(linha.body_text, linha.segredo_cifrado ?? null);
    } catch (err) {
      // Não há o que mandar (ou o cofre não abre): tentar de novo não muda
      // nada, então a mensagem desiste agora, dizendo o que o cliente faz.
      const motivo = err instanceof SemConteudoParaEntregar ? err.message : MOTIVO_COFRE_NAO_ABRE;
      if (desistirSemEnviar(linha.id, linha.template, motivo)) failed += 1;
      continue;
    }

    try {
      // Espera UM de cada vez, de propósito: o SMTP do Gmail tolera pouco
      // paralelismo de uma conta só, e a fila daqui é de dezenas, não milhões.
      const remetente = remetenteDe(linha.company_id);
      await carteiro.enviar({
        from: remetente.from,
        ...(remetente.replyTo ? { replyTo: remetente.replyTo } : {}),
        to: linha.to_address,
        subject: linha.subject,
        text: texto,
        // O anexo sai como foi guardado — o node:sqlite devolve BLOB como
        // Uint8Array, e o transporte fala Buffer.
        anexos:
          linha.anexo_nome && linha.anexo_conteudo
            ? [{ nome: linha.anexo_nome, conteudo: Buffer.from(linha.anexo_conteudo) }]
            : undefined,
      });
      db.prepare(
        `UPDATE core_email_queue
            SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL,
                next_attempt_at = NULL
          WHERE id = ? AND status = 'pending'`,
      ).run(new Date().toISOString(), linha.id);
      // Entregue: o segredo não tem mais função nenhuma no banco.
      apagarSegredo(linha.id);
      mascararCorpoGuardado(linha.id, linha.template);
      sent += 1;
    } catch (err) {
      const tentativas = linha.attempts + 1;
      const desistiu = tentativas >= MAX_TENTATIVAS;
      db.prepare(
        `UPDATE core_email_queue
            SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(
        tentativas,
        motivoSemSegredo(err, cfg.password),
        desistiu ? 'failed' : 'pending',
        desistiu ? null : proximaTentativa(tentativas, agora),
        linha.id,
      );
      if (desistiu) {
        apagarSegredo(linha.id);
        mascararCorpoGuardado(linha.id, linha.template);
        failed += 1;
      }
    }
  }

  /*
    A FAXINA NASCE COM O EVENTO QUE A DISPARA.

    Este flush é o momento em que um anexo deixa de ter função: a última
    mensagem que o carregava acabou de sair. Liberar aqui é o molde de
    `expireOverdueQuotes` na abertura de caixa — e é o que faltava para o zip
    de 15 MB não morar no banco da loja depois de entregue. Ver
    `liberarAnexosSemDono` (e a retenção de quem falhou, que pode voltar).
  */
  // A faxina enxerga o mesmo tanto que o flush leu: a fila das SEIS no worker
  // de fundo, a da empresa no clique do gerente (GAP-PRD-198).
  if (sent > 0 || failed > 0) {
    liberarAnexosSemDono(empresa ? { companyId: empresa } : 'todas_as_empresas');
  }

  return { readiness: 'READY', sent, failed, missing: [] };
}

// ---------------------------------------------------- o worker de fundo

/**
 * Uma batida do carteiro: entrega o que der e registra no log só quando algo
 * aconteceu — batida vazia a cada minuto não vira ruído.
 */
export async function tickDoCarteiro(carteiro?: CarteiroSmtp): Promise<void> {
  try {
    const r = await flushEmailQueue({ carteiro });
    if (r.sent > 0 || r.failed > 0) {
      logInfo('carteiro_saida', { enviados: r.sent, desistidos: r.failed });
    }
  } catch (err) {
    // Transporte indisponível (config quebrada, DNS...): a fila fica como
    // está e a próxima batida tenta de novo. Nunca derruba o servidor.
    logError('carteiro_indisponivel', { motivo: motivoSemSegredo(err) });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 60_000;

/** O carteiro está pronto para sair? (a pergunta que o boot faz) */
export function carteiroConfigurado(): boolean {
  return credenciaisFaltando().length === 0;
}

/** O `EMAIL_FROM` de agora — lido ao vivo, para a prévia do remetente (GAP-PRD-198). */
export function remetenteDoAmbiente(): string {
  return configSmtp().from;
}

/**
 * Liga o carteiro de fundo — o molde é o do `startSyncWorker`: só é chamado
 * quando há credencial, roda já na subida (o servidor pode ter passado a
 * noite desligado com fila acumulada) e a cada minuto depois.
 */
export function startEmailFlushWorker(): void {
  if (timer) return;
  void tickDoCarteiro();
  timer = setInterval(() => {
    void tickDoCarteiro();
  }, TICK_MS);
  timer.unref?.();
}

export function stopEmailFlushWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/*
  Aqui existiu um `pruneSentEmails` — faxina da fila que nenhum agendador,
  rota ou teste jamais chamou. O argumento que o removeu continua de pé, e é o
  mesmo que rege `liberarAnexosSemDono` lá em cima: faxina que roda em evento
  de verdade segue o molde de `expireOverdueQuotes` na abertura de caixa, e
  nasce COM o evento que a dispara, não à espera de um agendador.

  A diferença é que agora existem os eventos — o flush e o envio do pacote —, e
  a faxina está pendurada nos dois. E ela NÃO é aquele prune: o que sai é o
  ANEXO sem dono, não a mensagem. A linha da fila fica onde está, com estado,
  destinatário, assunto e nome do arquivo, porque é dela que o histórico do
  contador deriva "enviado" — apagá-la transformaria um envio que aconteceu em
  'sem_registro' na tela de quem foi conferir.
*/
