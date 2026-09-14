/**
 * ============================================================================
 * QUEM ASSINA O E-MAIL DE CADA EMPRESA (GAP-PRD-198)
 * ============================================================================
 *
 * O carteiro mandava tudo com o único `EMAIL_FROM` do ambiente. O cliente da
 * Gringa recebia de "grupo@…", o nome no "De:" era o do grupo, e a resposta
 * dele ("não recebi", "quero devolver") caía numa caixa só — que nenhuma das
 * seis lojas lê como sua.
 *
 * Qual identidade vale é DECISÃO DO DONO, e o software agora oferece o
 * mecanismo, empresa por empresa, com o padrão seguro:
 *
 *   - `grupo` — o padrão, e o que vale para empresa sem linha nenhuma.
 *     Exatamente o comportamento de antes: remetente do ambiente, sem
 *     Reply-To, assinatura "<loja> — Grupo Sampaio". Ninguém precisa decidir
 *     nada para o sistema continuar como está.
 *   - `empresa` — o nome que o cliente vê no "De:" ("Gringa"), o Reply-To da
 *     loja (a resposta cai na caixa DELA), a assinatura própria no fim da
 *     mensagem e, opcional, o endereço próprio.
 *
 * ## O ENDEREÇO PRÓPRIO É OPCIONAL, E A TELA DIZ POR QUÊ
 *
 * A credencial SMTP é UMA, a do ambiente. Provedor como o Gmail só envia "como"
 * outro endereço se ele estiver cadastrado na conta ("Enviar e-mail como") —
 * sem isso, troca o remetente ou recusa. Por isso o padrão do modo `empresa` é
 * o NOME da loja com o endereço do ambiente, e o Reply-To da loja: funciona em
 * qualquer provedor. O endereço próprio fica para quem configurou o provedor.
 *
 * ## NADA DE CABEÇALHO INJETADO
 *
 * O nome vai para o cabeçalho `From`. Quebra de linha, aspas e sinais de
 * endereço são recusados na entrada: um nome com "\r\nBcc: alguém" viraria um
 * destinatário escondido em toda mensagem da empresa.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';

export type ModoDoRemetente = 'grupo' | 'empresa';

export interface IdentidadeDoRemetente {
  modo: ModoDoRemetente;
  /** O nome no "De:" (modo `empresa`). */
  nomeRemetente: string | null;
  /** O endereço próprio — só se o provedor SMTP permitir enviar por ele. */
  enderecoRemetente: string | null;
  /** Para onde vai a resposta do cliente. */
  responderPara: string | null;
  /** A última linha das mensagens da loja (pedido e oficina). */
  assinatura: string | null;
  updatedAt: string | null;
}

/** Como o cliente vê a mensagem, com o `EMAIL_FROM` de agora. */
export interface PreviaDoRemetente {
  de: string | null;
  responderPara: string | null;
  assinatura: string;
  /** Falta alguma coisa para a prévia ser verdadeira? */
  aviso: string | null;
}

interface Linha {
  modo: string;
  nome_remetente: string | null;
  endereco_remetente: string | null;
  responder_para: string | null;
  assinatura: string | null;
  updated_at: string | null;
}

const PADRAO: IdentidadeDoRemetente = {
  modo: 'grupo',
  nomeRemetente: null,
  enderecoRemetente: null,
  responderPara: null,
  assinatura: null,
  updatedAt: null,
};

export function lerIdentidade(companyId: string): IdentidadeDoRemetente {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT modo, nome_remetente, endereco_remetente, responder_para, assinatura, updated_at
         FROM core_email_identidade WHERE company_id = ?`,
    )
    .get(companyId) as Linha | undefined;
  if (!linha) return { ...PADRAO };
  return {
    modo: linha.modo === 'empresa' ? 'empresa' : 'grupo',
    nomeRemetente: linha.nome_remetente,
    enderecoRemetente: linha.endereco_remetente,
    responderPara: linha.responder_para,
    assinatura: linha.assinatura,
    updatedAt: linha.updated_at,
  };
}

// ------------------------------------------------------------ validação

const ENDERECO = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
/** Caractere de controle (quebra de linha inclusive) — o que injeta cabeçalho. */
function temControle(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Nome no "De:": sem controle, aspas, sinais de endereço nem barra invertida. */
function nomeProibido(s: string): boolean {
  return temControle(s) || /["<>\\]/.test(s);
}

function textoOpcional(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const s = String(valor).trim();
  return s.length ? s : null;
}

function exigirEndereco(valor: string | null, campo: string): string | null {
  if (valor === null) return null;
  if (valor.length > 254 || !ENDERECO.test(valor)) {
    throw new ApiError(
      'EMAIL_IDENTIDADE_INVALIDA',
      `${campo}: informe um endereço de e-mail válido (ex.: contato@loja.com.br).`,
      400,
      { campo },
    );
  }
  return valor.toLowerCase();
}

export interface EntradaDaIdentidade {
  modo?: unknown;
  nomeRemetente?: unknown;
  enderecoRemetente?: unknown;
  responderPara?: unknown;
  assinatura?: unknown;
}

function validar(entrada: EntradaDaIdentidade): Omit<IdentidadeDoRemetente, 'updatedAt'> {
  const modo = entrada.modo === undefined ? 'grupo' : entrada.modo;
  if (modo !== 'grupo' && modo !== 'empresa') {
    throw new ApiError(
      'EMAIL_IDENTIDADE_INVALIDA',
      'Modo inválido: use "grupo" (remetente do grupo) ou "empresa" (remetente desta empresa).',
      400,
      { campo: 'modo' },
    );
  }

  const nome = textoOpcional(entrada.nomeRemetente);
  if (nome !== null && (nome.length > 60 || nomeProibido(nome))) {
    throw new ApiError(
      'EMAIL_IDENTIDADE_INVALIDA',
      'Nome do remetente: até 60 caracteres, numa linha só, sem aspas nem os sinais < > \\.',
      400,
      { campo: 'nomeRemetente' },
    );
  }
  const assinatura = textoOpcional(entrada.assinatura);
  if (assinatura !== null && (assinatura.length > 120 || temControle(assinatura))) {
    throw new ApiError(
      'EMAIL_IDENTIDADE_INVALIDA',
      'Assinatura: até 120 caracteres, numa linha só.',
      400,
      { campo: 'assinatura' },
    );
  }
  const endereco = exigirEndereco(textoOpcional(entrada.enderecoRemetente), 'Endereço do remetente');
  const responder = exigirEndereco(textoOpcional(entrada.responderPara), 'Responder para');

  // Remetente próprio sem nome seria o "De:" do grupo com outro rótulo na tela.
  if (modo === 'empresa' && nome === null) {
    throw new ApiError(
      'EMAIL_IDENTIDADE_INVALIDA',
      'Para usar o remetente desta empresa, informe o nome que o cliente vai ver no "De:".',
      400,
      { campo: 'nomeRemetente' },
    );
  }

  return {
    modo,
    nomeRemetente: nome,
    enderecoRemetente: endereco,
    responderPara: responder,
    assinatura,
  };
}

/**
 * Grava a escolha do dono para a empresa DO TOKEN — auditado.
 *
 * Os campos do modo `empresa` ficam guardados mesmo quando se volta ao
 * `grupo`: quem alterna para testar não precisa redigitar. Só o modo decide o
 * que o carteiro usa.
 */
export function salvarIdentidade(input: {
  companyId: string;
  userId?: string | null;
  entrada: EntradaDaIdentidade;
}): IdentidadeDoRemetente {
  ensureCoreSchema();
  const nova = validar(input.entrada);
  const antes = lerIdentidade(input.companyId);
  const agora = new Date().toISOString();

  withTransaction(() => {
    getConnection()
      .prepare(
        `INSERT INTO core_email_identidade
           (company_id, modo, nome_remetente, endereco_remetente, responder_para, assinatura,
            updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id) DO UPDATE SET
           modo = excluded.modo,
           nome_remetente = excluded.nome_remetente,
           endereco_remetente = excluded.endereco_remetente,
           responder_para = excluded.responder_para,
           assinatura = excluded.assinatura,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.companyId,
        nova.modo,
        nova.nomeRemetente,
        nova.enderecoRemetente,
        nova.responderPara,
        nova.assinatura,
        input.userId ?? null,
        agora,
        agora,
      );
    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'email.identidade.update',
      entityType: 'email_identidade',
      entityId: input.companyId,
      // Nada aqui é segredo: nome, endereços públicos da loja e assinatura.
      detail: {
        antes: { ...antes, updatedAt: undefined },
        depois: nova,
      },
    });
  });

  return lerIdentidade(input.companyId);
}

// ---------------------------------------------------- o uso pelo carteiro

/** O endereço puro de um `EMAIL_FROM` que pode vir como `Nome <a@b>`. */
export function enderecoDoRemetente(from: string): string {
  const entre = /<([^>]+)>/.exec(from);
  return (entre ? entre[1] : from).trim();
}

/**
 * A assinatura da empresa — ou `null`, e aí vale a de sempre.
 *
 * Só no modo `empresa`: no modo `grupo` a mensagem continua exatamente como
 * era, que é a promessa do padrão.
 */
export function assinaturaDaEmpresa(companyId: string): string | null {
  const id = lerIdentidade(companyId);
  if (id.modo !== 'empresa') return null;
  return id.assinatura ?? null;
}

/**
 * Os cabeçalhos com que a mensagem desta empresa sai — lidos NA HORA DO
 * ENVIO, com o `EMAIL_FROM` daquele instante.
 *
 * Diferente da assinatura (que é do corpo, montado no instante do fato), o
 * remetente é do envelope: a loja que troca o Reply-To hoje quer que a fila
 * acumulada já saia com o novo.
 */
export function cabecalhosDoRemetente(
  companyId: string,
  fromDoAmbiente: string,
): { from: string; replyTo?: string } {
  const id = lerIdentidade(companyId);
  if (id.modo !== 'empresa' || !id.nomeRemetente) return { from: fromDoAmbiente };
  const endereco = id.enderecoRemetente ?? enderecoDoRemetente(fromDoAmbiente);
  return {
    from: `"${id.nomeRemetente}" <${endereco}>`,
    ...(id.responderPara ? { replyTo: id.responderPara } : {}),
  };
}

/** O que a tela de E-mails recebe: a escolha gravada e como ela sai hoje. */
export function identidadeParaATela(
  companyId: string,
  fromDoAmbiente: string,
): { identidade: IdentidadeDoRemetente; previa: PreviaDoRemetente } {
  const loja = getConnection()
    .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name: string | null } | undefined;
  return {
    identidade: lerIdentidade(companyId),
    previa: previaDoRemetente(companyId, fromDoAmbiente, (loja?.trade_name ?? '').trim() || 'Grupo Sampaio'),
  };
}

/** O que a tela mostra como "é assim que o cliente vê". */
export function previaDoRemetente(
  companyId: string,
  fromDoAmbiente: string,
  nomeDaLoja: string,
): PreviaDoRemetente {
  const id = lerIdentidade(companyId);
  const propria = id.modo === 'empresa';
  const fromAtual = fromDoAmbiente.trim();
  const endereco =
    propria && id.enderecoRemetente
      ? id.enderecoRemetente
      : fromAtual
        ? enderecoDoRemetente(fromAtual)
        : null;

  let de: string | null = null;
  if (endereco !== null) {
    de = propria && id.nomeRemetente ? `"${id.nomeRemetente}" <${endereco}>` : fromAtual;
  }

  let aviso: string | null = null;
  if (endereco === null) {
    aviso = 'O remetente do servidor (EMAIL_FROM) ainda não está configurado.';
  } else if (propria && id.enderecoRemetente) {
    aviso =
      'Endereço próprio só funciona se o provedor de e-mail permitir enviar por ele '
      + '(no Gmail: "Enviar e-mail como"). Sem isso, o provedor troca o remetente ou recusa a mensagem.';
  }

  return {
    de,
    responderPara: propria ? id.responderPara : null,
    assinatura: propria && id.assinatura ? id.assinatura : `${nomeDaLoja} — Grupo Sampaio`,
    aviso,
  };
}
