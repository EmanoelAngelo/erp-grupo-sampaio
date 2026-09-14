/**
 * ============================================================================
 * O PACOTE VAI ATÉ O CONTADOR — POR E-MAIL E POR AGENDA (GAP-V30/V31)
 * ============================================================================
 *
 * ## O problema, na mesa de quem trabalha
 *
 * O pacote mensal existe desde a rodada 27 e tem dois jeitos de sair da
 * empresa: alguém da loja baixa e manda por fora, ou o contador entra e busca.
 * Os dois dependem de alguém LEMBRAR — e o mês que passa é justamente o que
 * ninguém percebe. Este serviço fecha o caminho: um cadastro de quem recebe,
 * um botão que ENFILEIRA o e-mail com o zip anexado, e uma agenda que faz o
 * mesmo gesto sozinha, no dia configurado.
 *
 * ## AS REGRAS DA CASA, aplicadas uma a uma
 *
 * 1. NUNCA ENVIA DIRETO. Tudo passa pelo outbox de e-mail que já existe
 *    (`core_email_queue`): sem SMTP a fila acumula em `pending` — o estado
 *    honesto de sempre —, e o dia em que a credencial existir, a fila anda.
 *    Simular envio está proibido lá, e portanto aqui.
 *
 * 2. O ANEXO É O MESMO ZIP DO BOTÃO "BAIXAR". `montarPacote` monta, e o zip é
 *    gravado PRONTO na fila, junto do corpo — o mesmo princípio do "montada no
 *    instante do fato": montar no flush entregaria um mês que pode ter mudado
 *    desde o clique, e a pessoa teria conferido uma prévia e mandado outra.
 *
 * 3. UMA MÁQUINA DE ESTADOS SÓ. O histórico (`core_contador_envios`) NÃO tem
 *    coluna de status: o estado de cada envio é LIDO da fila de e-mail, que já
 *    tem pendente/enviado/falhou e o retry do carteiro. Uma segunda máquina
 *    divergiria da primeira no primeiro retry.
 *
 * 4. IDEMPOTÊNCIA POR CONSTRUÇÃO. A `dedupe_key` da fila é única: o clique
 *    repetido (mesma chave) e o tick repetido (chave determinística por
 *    empresa+competência+destinatário) não geram segundo e-mail — nem quando o
 *    processo morre entre o enfileirar e o marcar.
 *
 * ## O QUE ESTE SERVIÇO NÃO FAZ, DE PROPÓSITO
 *
 * Não bloqueia o envio por pendência do mês (a mesma decisão da prévia: alerta
 * que sempre acende deixa de ser lido) e não manda a competência CORRENTE pela
 * agenda — mês em curso não tem como estar completo; o que a agenda entrega no
 * dia D do mês M é o fechamento de M-1.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, logError, logInfo } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import {
  emailStatus,
  isDeliverableAddress,
  liberarAnexosSemDono,
  queuePacoteContadorEmail,
  type EmailReadiness,
} from '../notifications/EmailService.js';
import { hojeNaLoja } from './CalendarioOperacional.js';
import {
  montarPacote,
  periodBounds,
  previaDoFechamento,
  type PreviaDoFechamento,
} from './FiscalClosingService.js';

/**
 * Acima disto o zip NÃO viaja como anexo — o e-mail sai sem ele, dizendo isso.
 *
 * O teto do pacote é 60 MB (memória do servidor); o teto de ANEXO é outro
 * problema: provedores de e-mail recusam mensagens grandes (o Gmail corta em
 * 25 MB JÁ CONTANDO o inchaço de ~35% do base64). 15 MB de zip viram ~20 MB de
 * mensagem — dentro do limite com folga. Acima disso, mandar o anexo seria
 * enfileirar uma falha certa com cara de envio; o corpo avisa e aponta os dois
 * caminhos que já existem (o botão de baixar e o login do contador).
 */
export const ANEXO_TETO_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------- tipos

export interface DestinatarioDoContador {
  id: string;
  name: string;
  email: string;
  active: boolean;
  createdAt: string;
}

export interface AgendaDoContador {
  dayOfMonth: number;
  active: boolean;
  /** A última competência que a AGENDA entregou — a marca da idempotência. */
  lastSentPeriod: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface EnvioDoContador {
  id: string;
  period: string;
  name: string;
  email: string;
  origem: 'manual' | 'agenda';
  /** Derivado da fila de e-mail — nunca uma segunda máquina de estados. */
  status: 'pendente' | 'enviado' | 'falhou' | 'sem_registro';
  erro: string | null;
  enviadoEm: string | null;
  criadoEm: string;
  userId: string | null;
}

export interface ResultadoDoEnvio {
  period: string;
  /** Quantos e-mails entraram na fila NESTA chamada. */
  enfileirados: number;
  /** Quantos já estavam lá pela mesma chave — clique repetido, tick repetido. */
  duplicados: number;
  /** O zip coube no e-mail? Quando não, o corpo diz onde buscar. */
  comAnexo: boolean;
  nomeArquivo: string;
  /** SHA-256 do zip montado neste envio (GAP-PRD-176) — o do anexo. */
  sha256: string;
  /** SHA-256 do MANIFESTO.csv de dentro do zip. */
  manifestoSha256: string;
}

// --------------------------------------------------------- destinatários

function comoDestinatario(r: Record<string, unknown>): DestinatarioDoContador {
  return {
    id: String(r.id),
    name: String(r.name),
    email: String(r.email),
    active: Number(r.active) === 1,
    createdAt: String(r.created_at),
  };
}

export function listarDestinatarios(companyId: string): DestinatarioDoContador[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare(
        `SELECT * FROM core_contador_destinatarios
          WHERE company_id = ? ORDER BY active DESC, name`,
      )
      .all(companyId) as unknown as Record<string, unknown>[]
  ).map(comoDestinatario);
}

function validarEndereco(email: unknown): string {
  const limpo = String(email ?? '').trim();
  if (!isDeliverableAddress(limpo)) {
    throw new ApiError(
      'CORE_CONTADOR_EMAIL_INVALIDO',
      `"${limpo}" não é um endereço de e-mail utilizável. Confira arroba e domínio.`,
      400,
    );
  }
  return limpo;
}

export function criarDestinatario(input: {
  companyId: string;
  name: string;
  email: string;
  userId?: string | null;
}): DestinatarioDoContador {
  ensureCoreSchema();
  const nome = String(input.name ?? '').trim();
  if (!nome) {
    throw new ApiError(
      'CORE_CONTADOR_NOME_OBRIGATORIO',
      'Dê um nome ao destinatário — é ele que aparece no histórico de envios.',
      400,
    );
  }
  const email = validarEndereco(input.email);
  const id = randomUUID();

  getConnection()
    .prepare(
      `INSERT INTO core_contador_destinatarios
         (id, company_id, name, email, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(id, input.companyId, nome, email, new Date().toISOString());

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'contador.destinatario_created',
    entityType: 'contador_destinatario',
    entityId: id,
    detail: { name: nome, email },
  });

  return listarDestinatarios(input.companyId).find((d) => d.id === id)!;
}

export function atualizarDestinatario(input: {
  companyId: string;
  id: string;
  name?: string;
  email?: string;
  active?: boolean;
  userId?: string | null;
}): DestinatarioDoContador {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_contador_destinatarios WHERE id = ? AND company_id = ?')
    .get(input.id, input.companyId) as Record<string, unknown> | undefined;
  if (!atual) {
    throw new ApiError(
      'CORE_CONTADOR_DESTINATARIO_NOT_FOUND',
      'Destinatário não encontrado nesta operação.',
      404,
    );
  }

  const nome = input.name === undefined ? String(atual.name) : String(input.name).trim();
  if (!nome) {
    throw new ApiError('CORE_CONTADOR_NOME_OBRIGATORIO', 'O nome não pode ficar vazio.', 400);
  }
  const email = input.email === undefined ? String(atual.email) : validarEndereco(input.email);
  const ativo = input.active === undefined ? Number(atual.active) === 1 : Boolean(input.active);

  db.prepare(
    `UPDATE core_contador_destinatarios
        SET name = ?, email = ?, active = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(nome, email, ativo ? 1 : 0, new Date().toISOString(), input.id, input.companyId);

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'contador.destinatario_updated',
    entityType: 'contador_destinatario',
    entityId: input.id,
    detail: {
      fields: (['name', 'email', 'active'] as const).filter((c) => input[c] !== undefined),
    },
  });

  return listarDestinatarios(input.companyId).find((d) => d.id === input.id)!;
}

// ---------------------------------------------------------------- agenda

function comoAgenda(r: Record<string, unknown>): AgendaDoContador {
  return {
    dayOfMonth: Number(r.day_of_month),
    active: Number(r.active) === 1,
    lastSentPeriod: (r.last_sent_period as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    lastErrorAt: (r.last_error_at as string | null) ?? null,
  };
}

export function agendaDoContador(companyId: string): AgendaDoContador | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_contador_agenda WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  return row ? comoAgenda(row) : null;
}

/**
 * Grava a agenda: dia 1..28 e liga/desliga.
 *
 * 28 é o teto, e não 31: um agendamento no dia 30 simplesmente não dispararia
 * em fevereiro, e o mês esquecido pela própria automação é o pior desfecho — o
 * gesto existe exatamente para ninguém ter que lembrar.
 */
export function gravarAgendaDoContador(input: {
  companyId: string;
  dayOfMonth: number;
  active: boolean;
  userId?: string | null;
}): AgendaDoContador {
  ensureCoreSchema();
  const dia = Number(input.dayOfMonth);
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) {
    throw new ApiError(
      'CORE_CONTADOR_AGENDA_DIA_INVALIDO',
      'O dia do envio automático precisa estar entre 1 e 28 — dias 29 a 31 não existem em '
        + 'todo mês, e um agendamento que pula fevereiro é um mês esquecido.',
      400,
      { dayOfMonth: input.dayOfMonth },
    );
  }

  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_contador_agenda (company_id, day_of_month, active, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE
         SET day_of_month = excluded.day_of_month,
             active = excluded.active,
             updated_at = excluded.created_at`,
    )
    .run(input.companyId, dia, input.active ? 1 : 0, agora);

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'contador.agenda_updated',
    entityType: 'contador_agenda',
    entityId: input.companyId,
    detail: { dayOfMonth: dia, active: input.active },
  });

  return agendaDoContador(input.companyId)!;
}

// ---------------------------------------------------------------- o envio

const NOMES_DOS_MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

/**
 * 'AAAA-MM' por extenso, sobre o TEXTO — nunca por `new Date('2026-04')`, que
 * é meia-noite UTC e recua um dia (e um mês) no fuso da loja. A mordida já
 * está registrada no memorial da casa; o assunto do e-mail não vai repeti-la.
 */
function mesPorExtenso(period: string): string {
  const nome = NOMES_DOS_MESES[Number(period.slice(5, 7)) - 1];
  return nome ? `${nome} de ${period.slice(0, 4)}` : period;
}

/**
 * O NOME DE CADA CONTAGEM NO RESUMO DO E-MAIL.
 *
 * ## O DEFEITO QUE ESTE `Record` EXISTE PARA FECHAR
 *
 * O resumo era uma lista de SEIS linhas escrita à mão, e o mês tem OITO
 * contagens. Quando a prévia partiu "compra recebida sem arquivo" em três
 * fatos com nomes próprios — XML perdido, compra sem NF-e (entrada manual) e
 * entrada estornada —, o zip aprendeu os três, o LEIA-ME aprendeu os três e a
 * tela aprendeu os três. Esta lista continuou respondendo, calada, pelo mundo
 * de seis que ela conhecia: o contador que só lê a mensagem via o mês de uma
 * loja de feira como um mês SEM COMPRA NENHUMA.
 *
 * É a armadilha da lista escrita à mão. O remédio é o tipo: `Record` TOTAL
 * sobre as chaves de `contagens`, e não um mapa parcial. Uma nona contagem
 * nascendo na prévia quebra a COMPILAÇÃO aqui — que é o momento certo — em vez
 * de sumir da caixa de entrada de quem escritura o mês.
 *
 * A ORDEM É A DA LEITURA, não a do objeto: primeiro o que a loja emitiu,
 * depois o que ela recebeu, e só então a numeração que não virou nota.
 */
export const RESUMO_DO_MES: Record<keyof PreviaDoFechamento['contagens'], string> = {
  emitidasAutorizadas: 'Notas emitidas autorizadas',
  emitidasCanceladas: 'Notas emitidas canceladas',
  eventos: 'Cancelamentos e cartas de correção no mês',
  recebidasComArquivo: 'Notas de compra com XML',
  recebidasSemArquivo: 'Notas de compra sem XML',
  // As duas que faltavam. O nome diz o FATO, e não a ausência do arquivo:
  // compra sem NF-e nunca teve XML (não é arquivo perdido), e entrada
  // estornada é documento morto, que não se escritura como compra.
  recebidasSemNota: 'Compras sem NF-e (entrada manual)',
  recebidasEstornadas: 'Entradas estornadas (não escrituráveis)',
  faixasInutilizadas: 'Faixas de numeração inutilizadas',
};

/**
 * A ordem de leitura sai do PRÓPRIO `Record`, e não de uma segunda lista.
 *
 * Uma segunda lista seria a mesma armadilha um andar acima: o tipo cobraria o
 * rótulo da contagem nova e a lista continuaria não a imprimindo. Chave de
 * objeto em JavaScript preserva a ordem de inserção, então a ordem escrita
 * acima é a ordem que o contador lê — uma lista só, impossível de divergir
 * dela mesma.
 */
function ordemDoResumo(): (keyof PreviaDoFechamento['contagens'])[] {
  return Object.keys(RESUMO_DO_MES) as (keyof PreviaDoFechamento['contagens'])[];
}

/** O corpo do e-mail — texto puro, como todo o carteiro (ver `renderEmail`). */
function montarCorpoDoEmail(input: {
  previa: PreviaDoFechamento;
  comAnexo: boolean;
  sha256: string;
  manifestoSha256: string;
}): { subject: string; bodyText: string } {
  const { previa } = input;
  const mes = mesPorExtenso(previa.period);
  const c = previa.contagens;

  const linhas = [
    'Olá.',
    '',
    `Segue o fechamento fiscal de ${mes} — ${previa.empresa.nome}.`,
    `Competência: ${previa.primeiroDia} a ${previa.ultimoDia}.`,
    '',
    'Resumo do mês:',
    ...ordemDoResumo().map((chave) => `  - ${RESUMO_DO_MES[chave]}: ${c[chave]}`),
  ];

  if (previa.pendencias.length > 0) {
    linhas.push(
      '',
      `O mês tem ${previa.pendencias.length} ressalva(s) — elas estão explicadas, uma a uma,`,
      'no LEIA-ME.txt dentro do pacote. Nenhuma impede a escrituração; todas merecem leitura.',
    );
  }

  if (input.comAnexo) {
    linhas.push(
      '',
      `O pacote completo está anexado (${previa.nomeArquivo}): XMLs emitidos e recebidos,`,
      'eventos, numeração inutilizada, o DRE do período e um MANIFESTO.csv com uma linha',
      'por arquivo. Comece pelo LEIA-ME.txt — ele diz o que o mês tem e o que NÃO tem.',
    );
  } else {
    linhas.push(
      '',
      `O pacote deste mês (${previa.nomeArquivo}) passou do tamanho que viaja bem por`,
      'e-mail, então NÃO vai anexado — mandá-lo seria uma falha certa no seu provedor.',
      'Ele está disponível na tela "Fechamento do contador" do sistema, no botão',
      '"Baixar o pacote", tanto para a gerência quanto para o acesso do contador.',
    );
  }

  /*
    A PROVA DO QUE FOI MANDADO (GAP-PRD-176). O hash do anexo só é escrito
    quando o anexo vai: sem ele, o zip baixado depois é outro arquivo (leva
    outra hora de montagem) e teria outro número. O do MANIFESTO vai sempre —
    ele não muda enquanto os documentos do mês não mudam.
  */
  linhas.push('', 'Integridade (SHA-256):');
  if (input.comAnexo) {
    linhas.push(`  - do anexo ${previa.nomeArquivo}: ${input.sha256}`);
  }
  linhas.push(
    `  - do MANIFESTO.csv de dentro do pacote: ${input.manifestoSha256}`,
    '  Para conferir no Windows: certutil -hashfile <arquivo> SHA256; no Linux ou no',
    '  macOS: sha256sum <arquivo>. O MANIFESTO traz o SHA-256 de cada arquivo do pacote.',
  );

  linhas.push('', `${previa.empresa.nome} — Grupo Sampaio`);

  return {
    subject: `${previa.empresa.nome} · pacote do contador — ${mes}`,
    bodyText: linhas.join('\n'),
  };
}

/**
 * Enfileira o pacote do mês para os destinatários ativos.
 *
 * `origem: 'manual'` exige `idempotencyKey` (o clique repetido não pode virar
 * caixa de entrada em dobro); `origem: 'agenda'` usa chave DETERMINÍSTICA por
 * (empresa, competência, destinatário) — é isso que torna o tick re-executável
 * sem duplicar, inclusive depois de uma queda no meio.
 *
 * Reenviar de propósito (chave nova) é legítimo: o pacote é derivado e
 * re-gerável, e o histórico mostra cada envio.
 */
export function enviarPacotePorEmail(input: {
  companyId: string;
  period: string;
  origem: 'manual' | 'agenda';
  idempotencyKey?: string | null;
  userId?: string | null;
}): ResultadoDoEnvio {
  ensureCoreSchema();
  const limites = periodBounds(input.period);

  if (input.origem === 'manual' && !String(input.idempotencyKey ?? '').trim()) {
    throw new ApiError(
      'CORE_IDEMPOTENCY_REQUIRED',
      'Idempotency-Key é obrigatória — sem ela um clique repetido mandaria o mês em dobro.',
      400,
    );
  }

  const destinatarios = listarDestinatarios(input.companyId).filter((d) => d.active);
  if (destinatarios.length === 0) {
    throw new ApiError(
      'CORE_CONTADOR_SEM_DESTINATARIO',
      'Nenhum destinatário ativo cadastrado. Cadastre o e-mail do contador na tela de '
        + 'fechamento antes de enviar.',
      409,
    );
  }

  /*
    A FAXINA VEM ANTES DE GUARDAR MAIS UM MÊS.

    O DEFEITO: o zip de até 15 MB entrava no SQLite operacional (6,2 MB
    inteiro) e nunca mais saía — não existia um só DELETE da fila no servidor,
    e o blob continuava lá depois de 'sent'. Pior, o laço abaixo gravava o
    MESMO zip uma vez POR DESTINATÁRIO.

    A segunda metade morreu no cofre de anexos (`guardarAnexo`, um arquivo
    para N mensagens). Esta é a primeira: o envio é um dos dois EVENTOS de
    verdade em que o cofre muda de tamanho, e a faxina nasce com ele — o molde
    de `expireOverdueQuotes` na abertura de caixa, e não um agendador que este
    servidor não tem. Antes, e não depois, porque quem está prestes a guardar
    mais 15 MB é quem deve pagar a limpeza do que já não serve.

    E o escopo é O DESTA EMPRESA. Este gesto tem `companyId` do token, e a
    faxina varria o cofre INTEIRO — a Gringa mandava o mês dela e o cofre da
    Preço Justo encolhia junto. O parâmetro é obrigatório de propósito: não há
    como esquecer de dizer de quem é a casa que se está limpando.
  */
  liberarAnexosSemDono({ companyId: input.companyId });

  // A prévia e o pacote saem do MESMO instante — o corpo resume o que o anexo
  // carrega, e divergência entre os dois é o defeito que a casa não comete.
  const previa = previaDoFechamento(input.companyId, limites.period);
  const pacote = montarPacote(input.companyId, limites.period);
  const comAnexo = pacote.bytes.length <= ANEXO_TETO_BYTES;
  const { subject, bodyText } = montarCorpoDoEmail({
    previa,
    comAnexo,
    sha256: pacote.sha256,
    manifestoSha256: pacote.manifestoSha256,
  });

  const resultado = withTransaction(() => {
    let enfileirados = 0;
    let duplicados = 0;

    for (const dest of destinatarios) {
      const dedupeKey =
        input.origem === 'agenda'
          ? `contador-pacote:agenda:${input.companyId}:${limites.period}:${dest.id}`
          : `contador-pacote:manual:${input.companyId}:${limites.period}:${dest.id}:${String(input.idempotencyKey).trim()}`;

      const queueId = queuePacoteContadorEmail({
        companyId: input.companyId,
        toAddress: dest.email,
        subject,
        bodyText,
        anexoNome: comAnexo ? pacote.nomeArquivo : null,
        anexoBytes: comAnexo ? pacote.bytes : null,
        // Só o que a tela do histórico mostra — o zip NÃO entra no payload.
        payload: {
          tipo: 'pacote_contador',
          period: limites.period,
          origem: input.origem,
          comAnexo,
          bytes: pacote.bytes.length,
          sha256: comAnexo ? pacote.sha256 : null,
          manifestoSha256: pacote.manifestoSha256,
        },
        dedupeKey,
      });

      if (!queueId) {
        // Já estava na fila pela mesma chave: clique repetido ou tick
        // re-executado. Nada a registrar — o envio é o MESMO, não um novo.
        duplicados += 1;
        continue;
      }

      getConnection()
        .prepare(
          `INSERT INTO core_contador_envios
             (id, company_id, period, destinatario_id, name, email, origem,
              email_queue_id, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.companyId,
          limites.period,
          dest.id,
          dest.name,
          dest.email,
          input.origem,
          queueId,
          input.userId ?? null,
          new Date().toISOString(),
        );
      enfileirados += 1;
    }

    return { enfileirados, duplicados };
  });

  if (resultado.enfileirados > 0) {
    // O mês inteiro saiu (ou vai sair) da empresa: mesma gravidade — e mesma
    // trilha — do download do pacote.
    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'contador.pacote_email',
      entityType: 'fiscal_closing',
      entityId: limites.period,
      detail: {
        period: limites.period,
        origem: input.origem,
        destinatarios: resultado.enfileirados,
        comAnexo,
        bytes: pacote.bytes.length,
        nomeArquivo: pacote.nomeArquivo,
        // É por aqui que `/fiscal/closings/conferir` reconhece o anexo depois.
        sha256: pacote.sha256,
        manifestoSha256: pacote.manifestoSha256,
      },
    });
  }

  return {
    period: limites.period,
    enfileirados: resultado.enfileirados,
    duplicados: resultado.duplicados,
    comAnexo,
    nomeArquivo: pacote.nomeArquivo,
    sha256: pacote.sha256,
    manifestoSha256: pacote.manifestoSha256,
  };
}

// ------------------------------------------------------------- o histórico

const STATUS_DA_FILA: Record<string, EnvioDoContador['status']> = {
  pending: 'pendente',
  sent: 'enviado',
  failed: 'falhou',
};

export interface EnviosDoPeriodo {
  items: EnvioDoContador[];
  /** O estado do carteiro, para a tela dizer POR QUE está tudo pendente. */
  carteiro: { readiness: EmailReadiness; missing: string[] };
}

export function listarEnvios(companyId: string, period: string): EnviosDoPeriodo {
  ensureCoreSchema();
  const limites = periodBounds(period);

  const rows = getConnection()
    .prepare(
      `SELECT e.id, e.period, e.name, e.email, e.origem, e.user_id, e.created_at,
              q.status AS fila_status, q.last_error AS fila_erro, q.sent_at AS fila_sent_at
         FROM core_contador_envios e
         LEFT JOIN core_email_queue q ON q.id = e.email_queue_id
        WHERE e.company_id = ? AND e.period = ?
        ORDER BY e.created_at DESC, e.rowid DESC`,
    )
    .all(companyId, limites.period) as unknown as Record<string, unknown>[];

  const status = emailStatus(companyId);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      period: String(r.period),
      name: String(r.name),
      email: String(r.email),
      origem: r.origem === 'agenda' ? 'agenda' : 'manual',
      status: STATUS_DA_FILA[String(r.fila_status ?? '')] ?? 'sem_registro',
      erro: (r.fila_erro as string | null) ?? null,
      enviadoEm: (r.fila_sent_at as string | null) ?? null,
      criadoEm: String(r.created_at),
      userId: (r.user_id as string | null) ?? null,
    })),
    carteiro: { readiness: status.readiness, missing: status.missing },
  };
}

// --------------------------------------------------------------- a agenda anda

/** 'AAAA-MM' do mês ANTERIOR a um dia de calendário da loja. */
function competenciaAnterior(diaDaLoja: string): string {
  const ano = Number(diaDaLoja.slice(0, 4));
  const mes = Number(diaDaLoja.slice(5, 7));
  const anterior = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
  return `${anterior.ano}-${String(anterior.mes).padStart(2, '0')}`;
}

export interface ResultadoDoTick {
  verificadas: number;
  enviados: number;
  falhas: number;
}

/**
 * Uma passada da agenda. Exportada para o teste chamá-la sem relógio.
 *
 * O critério é `dia de hoje NA LOJA >= dia configurado`, e não `==`: este
 * servidor desliga à noite e pode passar o dia D inteiro apagado — no dia
 * seguinte em que subir, o mês devido sai. A idempotência por
 * (empresa, competência) segura a outra ponta: dentro do mesmo mês, o envio
 * da agenda acontece UMA vez, por mais ticks que rodem.
 *
 * Erro NÃO desliga a agenda (o molde do MailInboxScheduler): destinatário
 * ainda não cadastrado ou mês acima do teto são estados que se resolvem, e a
 * próxima passada tenta de novo. O erro fica anotado NA AGENDA — e só vira
 * linha de auditoria quando MUDA, para trinta dias de "sem destinatário" não
 * virarem setecentas linhas de trilha.
 */
export async function runContadorScheduler(now: Date = new Date()): Promise<ResultadoDoTick> {
  ensureCoreSchema();
  const db = getConnection();
  const hoje = hojeNaLoja(now);
  const diaDeHoje = Number(hoje.slice(8, 10));
  const competencia = competenciaAnterior(hoje);

  const agendas = db
    .prepare(
      `SELECT company_id, day_of_month, last_sent_period, last_error
         FROM core_contador_agenda WHERE active = 1`,
    )
    .all() as unknown as {
    company_id: string;
    day_of_month: number;
    last_sent_period: string | null;
    last_error: string | null;
  }[];

  let enviados = 0;
  let falhas = 0;

  for (const agenda of agendas) {
    if (diaDeHoje < Number(agenda.day_of_month)) continue;
    // Competência já entregue pela agenda? Nada a fazer — a comparação de
    // texto 'AAAA-MM' ordena igual à cronológica.
    if (agenda.last_sent_period && agenda.last_sent_period >= competencia) continue;

    try {
      enviarPacotePorEmail({
        companyId: agenda.company_id,
        period: competencia,
        origem: 'agenda',
        userId: null,
      });
      db.prepare(
        `UPDATE core_contador_agenda
            SET last_sent_period = ?, last_run_at = ?, last_error = NULL, last_error_at = NULL
          WHERE company_id = ?`,
      ).run(competencia, now.toISOString(), agenda.company_id);
      enviados += 1;
    } catch (err) {
      falhas += 1;
      const motivo = err instanceof ApiError ? err.message : 'Falha ao gerar o envio automático.';
      db.prepare(
        `UPDATE core_contador_agenda
            SET last_run_at = ?, last_error = ?, last_error_at = ?
          WHERE company_id = ?`,
      ).run(now.toISOString(), motivo, now.toISOString(), agenda.company_id);
      // Auditoria só na MUDANÇA de erro — ver o cabeçalho da função.
      if (agenda.last_error !== motivo) {
        recordAudit({
          companyId: agenda.company_id,
          userId: null,
          action: 'contador.agenda_error',
          entityType: 'contador_agenda',
          entityId: agenda.company_id,
          detail: { period: competencia, error: motivo },
        });
        logError('CONTADOR_AGENDA_ERROR', { companyId: agenda.company_id, error: motivo });
      }
    }
  }

  return { verificadas: agendas.length, enviados, falhas };
}

// ------------------------------------------------------- o laço de fundo

let timer: NodeJS.Timeout | null = null;

/**
 * Duas passadas não se atropelam: quem chegar durante uma, espera o resultado
 * dela — o mesmo desenho do flush do carteiro, pela mesma razão (um processo
 * só, tick sobreposto releria as mesmas agendas vencidas).
 */
let tickEmVoo: Promise<ResultadoDoTick> | null = null;

async function tickDaAgenda(): Promise<ResultadoDoTick> {
  if (tickEmVoo) return tickEmVoo;
  tickEmVoo = runContadorScheduler().finally(() => {
    tickEmVoo = null;
  });
  return tickEmVoo;
}

/**
 * Liga a agenda do contador — o molde é o do `startEmailFlushWorker`: roda já
 * na subida (o servidor pode ter atravessado o dia do envio desligado) e de
 * hora em hora depois. Hora, e não minuto: a granularidade da agenda é o DIA,
 * e o que segura a duplicata não é o intervalo, é a idempotência por
 * (empresa, competência).
 *
 * Quem chama é o `index.ts`, ao lado dos outros workers.
 */
export function startContadorScheduler(tickMs = 60 * 60_000): void {
  if (timer) return;
  void tickDaAgenda().catch((err) => {
    logError('CONTADOR_AGENDA_TICK_FAILED', { error: String(err) });
  });
  timer = setInterval(() => {
    void tickDaAgenda().catch((err) => {
      logError('CONTADOR_AGENDA_TICK_FAILED', { error: String(err) });
    });
  }, tickMs);
  // Não segura o processo: `npm test` e o desligamento não esperam o tick.
  timer.unref?.();
  logInfo('CONTADOR_AGENDA_STARTED', { tickMs });
}

export function stopContadorScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
