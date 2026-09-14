/**
 * Entrada de NF-e por e-mail.
 *
 * É apenas OUTRA PORTA para o `NfeImportService`, que já funciona. Nada do
 * parser, da conferência ou da confirmação é reimplementado aqui: este módulo
 * busca a mensagem, separa o anexo XML e entrega. O que acontece depois é
 * exatamente o mesmo do upload manual.
 *
 * REGRAS QUE VALEM AQUI
 *
 *   receber ≠ dar entrada.  A mensagem vira uma nota EM CONFERÊNCIA. O estoque
 *                           só se move quando alguém confirma, como sempre.
 *
 *   nada de duplicidade.    O mesmo XML chegando por upload e por e-mail não
 *                           cria duas entradas — a chave da NF-e é a defesa, e
 *                           ela já vive no NfeImportService. O UID da mensagem
 *                           evita reler o mesmo e-mail.
 *
 *   anexo que não é XML     é registrado e ignorado. Boleto em PDF não é nota
 *                           fiscal, e tentar interpretá-lo como tal encheria a
 *                           conferência de lixo.
 *
 *   segredo no cofre.       A senha/token do e-mail é cifrada pelo mesmo cofre
 *                           do certificado A1. A API devolve só endereço e
 *                           situação — nunca a credencial.
 *
 *   a caixa não entope.     (GAP-PRD-035) A leitura pedia as não lidas e parava
 *                           na 25ª — e o imapflow baixa com BODY.PEEK, que não
 *                           marca nada como lida. Com 26 não lidas na caixa, a
 *                           26ª nunca entrava. Agora o sistema lembra ONDE PAROU
 *                           (último UID, amarrado ao UIDVALIDITY da pasta), faz
 *                           com a mensagem o que a empresa escolheu (marcar como
 *                           lida, mover, ou não mexer) e diz quantas restam.
 *
 *   falha com nome.         (GAP-PRD-128) "Command failed" não diz nada ao
 *                           gestor. A falha é classificada — senha recusada,
 *                           pasta que não existe, provedor fora do ar — e a
 *                           situação da caixa diz o passo seguinte. "Testar
 *                           conexão" confere a senha nova sem ler nenhuma nota.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { encryptFiscalSecret, decryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { importNfe } from './NfeImportService.js';
import { importCte } from './CteImportService.js';

export interface MailInbox {
  id: string;
  company_id: string;
  address: string;
  host: string;
  port: number;
  secure: number;
  username: string;
  folder: string;
  active: number;
  last_check_at: string | null;
  last_error: string | null;
  /** O que fazer com a mensagem depois de processada (GAP-PRD-035). */
  after_read: DepoisDeLer;
  processed_folder: string | null;
  /** Último UID processado nesta pasta — onde a próxima leitura começa. */
  imap_last_uid: number | null;
  /** Quantas ficaram na caixa depois da última leitura. */
  imap_pending: number | null;
  /** Tipo da última falha (GAP-PRD-128). */
  last_error_kind: TipoDaFalha | null;
  /** Última vez que a conexão funcionou (leitura ou teste). */
  last_ok_at: string | null;
}

/**
 * O que fazer com a mensagem depois de processada (GAP-PRD-035).
 *
 *   lida    marca como lida — o padrão. Quem abre a caixa vê o que o sistema
 *           já pegou; é o que a auditoria esperava.
 *   mover   leva para uma pasta (criada se não existir). A caixa de entrada
 *           fica só com o que o sistema ainda não viu.
 *   manter  não toca na caixa. Para caixa que também é lida por gente: o
 *           sistema não depende de "não lida" para saber o que falta — ele
 *           lembra o último UID que processou.
 */
export type DepoisDeLer = 'lida' | 'mover' | 'manter';
export const DEPOIS_DE_LER: readonly DepoisDeLer[] = ['lida', 'mover', 'manter'];

/** Tipo da falha de leitura, para a tela dizer o passo seguinte (GAP-PRD-128). */
export type TipoDaFalha = 'credencial' | 'pasta' | 'conexao';

/**
 * Quantas mensagens uma leitura processa, no máximo.
 *
 * O teto continua existindo — uma caixa com 5.000 não lidas não pode segurar a
 * trava do agendador por uma hora —, mas agora é um LOTE: a leitura seguinte
 * começa depois da última processada, e o agendador volta em 1 minuto enquanto
 * sobrar mensagem.
 */
export const LOTE_POR_LEITURA = 25;

/**
 * Mensagem acima disto nem é baixada. Nenhuma NF-e ou CT-e chega perto (o anexo
 * já tem teto de 2 MB); 25 MB é o limite de envio do Gmail e do Outlook.
 */
export const TETO_DA_MENSAGEM_BYTES = 25 * 1024 * 1024;

/** O que aconteceu com uma mensagem. */
/**
 * 'recusado' (R3-DFE, GAP-PRD-168): a NF-e é legível, mas não pode entrar — a
 * de homologação numa empresa em produção. Não é "XML inválido", e dizer isso
 * mandaria o gestor procurar defeito no arquivo em vez de pedir a nota de
 * produção ao fornecedor.
 */
export type MailOutcome = 'importado' | 'duplicado' | 'sem_xml' | 'invalido' | 'recusado' | 'frete' | 'ilegivel';

/**
 * As recusas do funil que não são defeito do arquivo — vão como 'recusado'.
 *
 * PED-ent-02: a trava do destinatário (B-estoque-entrada-02) e a do protocolo
 * de autorização (M02) nasceram depois deste conjunto, e ele não as conhecia.
 * A NF-e da Gringa que chegava na caixa da Preço Justo — XML perfeito, só que
 * de OUTRA empresa — ficava marcada como 'invalido', e o gestor ia procurar
 * defeito no arquivo em vez de importá-la na empresa certa. O mesmo com o XML
 * sem protocolo: não é arquivo quebrado, é o arquivo errado (peça o autorizado).
 */
const RECUSAS_DO_FUNIL = new Set([
  'CORE_NFE_DE_HOMOLOGACAO',
  'CORE_NFE_AMBIENTE_ILEGIVEL',
  'CORE_NFE_OUTRO_DESTINATARIO',
  'CORE_NFE_SEM_AUTORIZACAO',
]);

export interface MailMessageRecord {
  id: string;
  provider_uid: string;
  subject: string | null;
  sender: string | null;
  received_at: string | null;
  outcome: MailOutcome;
  detail: string | null;
  note_id: string | null;
  access_key: string | null;
  created_at: string;
}

/**
 * Estado honesto da caixa.
 *
 * Sem credencial configurada é `READY_FOR_CREDENTIAL`. Nunca "homologado":
 * conectar numa caixa real depende de senha de aplicativo ou OAuth do
 * provedor, que é do usuário.
 */
export interface InboxStatus {
  configured: boolean;
  /**
   * CREDENTIAL_REJECTED: a senha foi recusada pelo provedor na última
   * tentativa (GAP-PRD-128) — nada entra até alguém trocar a senha.
   * CONNECTION_FAILING: a última tentativa falhou por outro motivo (pasta,
   * rede, servidor); costuma ser temporário ou erro de digitação.
   */
  readiness: 'READY_FOR_CREDENTIAL' | 'CONFIGURED' | 'CREDENTIAL_REJECTED' | 'CONNECTION_FAILING';
  message: string;
  inbox: MailInbox | null;
}

/**
 * O passo a passo da senha de aplicativo, dito por inteiro.
 *
 * É o que falta à Preço Justo desde 13/08 (GAP-PRD-128): a caixa do Gmail
 * recusa a senha normal da conta para IMAP. Nenhuma linha de código resolve —
 * mas a tela precisa dizer exatamente o que o dono faz.
 */
export const COMO_GERAR_SENHA_DE_APLICATIVO =
  'No Gmail: ative a verificação em duas etapas da conta, gere uma senha de app em ' +
  'Conta Google › Segurança › Senhas de app e cole os 16 caracteres no campo "Senha de ' +
  'aplicativo"; confira também em Configurações › Encaminhamento e POP/IMAP que o IMAP ' +
  'está ativado. No Outlook/Microsoft 365, a senha de aplicativo fica em Segurança › ' +
  'Opções de segurança avançadas. Depois, use "Testar conexão".';

/** A linha do banco NUNCA sai inteira: o segredo cifrado e a trava ficam dentro. */
function sanitize(row: Record<string, unknown>): MailInbox {
  const { secret_cipher, imap_uid_validity, locked_by, ...resto } = row;
  void secret_cipher;
  void imap_uid_validity;
  void locked_by;
  return {
    ...(resto as unknown as MailInbox),
    after_read: normalizarDepoisDeLer(row.after_read),
    last_error_kind: tipoDaUltimaFalha(row),
  };
}

/**
 * O tipo da última falha — gravado desde o GAP-PRD-128, ou deduzido do texto
 * quando a falha é de antes da coluna existir.
 *
 * A caixa da Preço Justo tem `last_error = 'Command failed'` desde 13/08 e a
 * coluna nova chega vazia ao banco. Sem a dedução, a tela continuaria dizendo
 * "Configurada" até alguém ler de novo — justamente o que este gap corrige.
 * `last_error` só existe enquanto a última tentativa falhou (o sucesso limpa).
 */
function tipoDaUltimaFalha(row: Record<string, unknown>): TipoDaFalha | null {
  const gravado = row.last_error_kind;
  if (gravado === 'credencial' || gravado === 'pasta' || gravado === 'conexao') return gravado;
  const texto = typeof row.last_error === 'string' ? row.last_error : '';
  if (!texto) return null;
  if (/command failed|authenticat|invalid credentials|senha/i.test(texto)) return 'credencial';
  if (/doesn.t exist|nonexistent|no such mailbox|unknown mailbox/i.test(texto)) return 'pasta';
  return 'conexao';
}

function normalizarDepoisDeLer(valor: unknown): DepoisDeLer {
  return DEPOIS_DE_LER.includes(valor as DepoisDeLer) ? (valor as DepoisDeLer) : 'lida';
}

function inboxRow(companyId: string): Record<string, unknown> | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_mail_inboxes WHERE company_id = ? ORDER BY created_at LIMIT 1')
    .get(companyId) as Record<string, unknown> | undefined;
}

export function getInboxStatus(companyId: string): InboxStatus {
  ensureCoreSchema();
  const row = inboxRow(companyId);

  if (!row || !row.secret_cipher) {
    return {
      configured: false,
      readiness: 'READY_FOR_CREDENTIAL',
      message: row
        ? 'Caixa cadastrada, mas sem senha. Informe a senha de aplicativo do provedor para o sistema conseguir ler os e-mails.'
        : 'Nenhuma caixa configurada. Cadastre o e-mail que recebe as notas dos fornecedores.',
      inbox: row ? sanitize(row) : null,
    };
  }

  // A última tentativa diz a verdade sobre a credencial: "configurada" com a
  // senha recusada desde agosto era a tela da Preço Justo (GAP-PRD-128).
  const falha = tipoDaUltimaFalha(row);
  if (falha === 'credencial') {
    return {
      configured: true,
      readiness: 'CREDENTIAL_REJECTED',
      message: `O provedor recusou a senha de ${String(row.address)} na última tentativa — nenhuma nota entra por e-mail até a senha ser trocada. ${COMO_GERAR_SENHA_DE_APLICATIVO}`,
      inbox: sanitize(row),
    };
  }
  if (falha === 'pasta' || falha === 'conexao') {
    return {
      configured: true,
      readiness: 'CONNECTION_FAILING',
      message:
        falha === 'pasta'
          ? `A pasta "${String(row.folder)}" não foi encontrada em ${String(row.address)}. Corrija o nome da pasta (no Gmail, a caixa de entrada é INBOX) e use "Testar conexão".`
          : `A última tentativa de ler ${String(row.address)} falhou (veja o último erro). Se o servidor e a porta estão certos, costuma ser passageiro — a leitura automática tenta de novo sozinha.`,
      inbox: sanitize(row),
    };
  }

  const pendentes = Number(row.imap_pending ?? 0);
  return {
    configured: true,
    readiness: 'CONFIGURED',
    message:
      `Lendo ${String(row.address)}. Notas recebidas entram em conferência — o estoque só se move na confirmação.` +
      (pendentes > 0
        ? ` Ainda há ${pendentes} mensagem(ns) na caixa para a próxima leitura.`
        : ''),
    inbox: sanitize(row),
  };
}

/** Nome de pasta IMAP aceitável: sem caractere de controle, tamanho de gente. */
function pastaValida(nome: string): boolean {
  if (nome.length === 0 || nome.length > 200) return false;
  for (const c of nome) {
    const codigo = c.charCodeAt(0);
    if (codigo < 32 || codigo === 127) return false;
  }
  return true;
}

/**
 * Cadastra ou atualiza a caixa.
 *
 * A senha só é regravada quando vem preenchida: salvar o formulário sem
 * redigitar a senha não pode apagar a credencial existente.
 *
 * Trocar de caixa (endereço, servidor, usuário ou pasta) zera o "onde parou":
 * o último UID de uma pasta não quer dizer nada em outra. E senha nova apaga
 * o erro da senha antiga — ele descrevia a credencial que acabou de sair.
 */
export function upsertInbox(input: {
  companyId: string;
  address: string;
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  folder?: string;
  active?: boolean;
  /** 'lida' | 'mover' | 'manter' — o que fazer depois de processar (GAP-PRD-035). */
  afterRead?: string;
  /** Pasta de destino quando `afterRead` é 'mover'. */
  processedFolder?: string | null;
}): InboxStatus {
  ensureCoreSchema();

  if (!input.address?.trim() || !input.host?.trim()) {
    throw new ApiError('CORE_MAIL_FIELDS_REQUIRED', 'Informe o e-mail e o servidor.', 400);
  }
  const folder = String(input.folder ?? 'INBOX').trim() || 'INBOX';
  if (!pastaValida(folder)) {
    throw new ApiError('CORE_MAIL_FOLDER_INVALID', 'Nome de pasta inválido.', 400);
  }
  const porta = input.port === undefined ? 993 : Number(input.port);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    throw new ApiError('CORE_MAIL_PORT_INVALID', 'Porta inválida (use 993 para IMAP seguro).', 400);
  }
  if (input.afterRead !== undefined && !DEPOIS_DE_LER.includes(input.afterRead as DepoisDeLer)) {
    throw new ApiError(
      'CORE_MAIL_AFTER_READ_INVALID',
      'Escolha o que fazer com a mensagem depois de lida: marcar como lida, mover para uma pasta ou não mexer.',
      400,
      { permitidos: DEPOIS_DE_LER },
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const existing = inboxRow(input.companyId);
    const now = new Date().toISOString();
    const username = input.username?.trim() || input.address.trim();

    const depois: DepoisDeLer =
      (input.afterRead as DepoisDeLer | undefined) ?? normalizarDepoisDeLer(existing?.after_read);
    const destino =
      input.processedFolder === undefined
        ? ((existing?.processed_folder as string | null | undefined) ?? null)
        : String(input.processedFolder ?? '').trim() || null;
    if (depois === 'mover') {
      if (!destino || !pastaValida(destino)) {
        throw new ApiError(
          'CORE_MAIL_PROCESSED_FOLDER_REQUIRED',
          'Informe a pasta para onde as mensagens lidas vão (ex.: "Notas processadas").',
          400,
        );
      }
      if (destino.toLowerCase() === folder.toLowerCase()) {
        throw new ApiError(
          'CORE_MAIL_PROCESSED_FOLDER_SAME',
          'A pasta das mensagens lidas precisa ser diferente da pasta que o sistema lê.',
          400,
        );
      }
    }

    const senhaNova = Boolean(input.password?.trim());
    const cipher = senhaNova
      ? encryptFiscalSecret(input.password!.trim())
      : ((existing?.secret_cipher as string | undefined) ?? null);

    if (existing) {
      const outraCaixa =
        String(existing.address) !== input.address.trim() ||
        String(existing.host) !== input.host.trim() ||
        String(existing.username) !== username ||
        String(existing.folder) !== folder;
      db.prepare(
        `UPDATE core_mail_inboxes
            SET address = ?, host = ?, port = ?, secure = ?, username = ?, secret_cipher = ?,
                folder = ?, active = ?, after_read = ?, processed_folder = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.address.trim(),
        input.host.trim(),
        porta,
        input.secure === false ? 0 : 1,
        username,
        cipher,
        folder,
        input.active === false ? 0 : 1,
        depois,
        destino,
        now,
        String(existing.id),
      );
      if (outraCaixa) {
        db.prepare(
          `UPDATE core_mail_inboxes
              SET imap_uid_validity = NULL, imap_last_uid = NULL, imap_pending = NULL
            WHERE id = ?`,
        ).run(String(existing.id));
      }
      if (senhaNova || outraCaixa) {
        db.prepare(
          'UPDATE core_mail_inboxes SET last_error = NULL, last_error_kind = NULL WHERE id = ?',
        ).run(String(existing.id));
      }
    } else {
      db.prepare(
        `INSERT INTO core_mail_inboxes
           (id, company_id, address, host, port, secure, username, secret_cipher, folder,
            active, after_read, processed_folder, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.companyId,
        input.address.trim(),
        input.host.trim(),
        porta,
        input.secure === false ? 0 : 1,
        username,
        cipher,
        folder,
        input.active === false ? 0 : 1,
        depois,
        destino,
        now,
        now,
      );
    }

    return getInboxStatus(input.companyId);
  });
}

export function removeInbox(companyId: string): InboxStatus {
  ensureCoreSchema();
  getConnection().prepare('DELETE FROM core_mail_inboxes WHERE company_id = ?').run(companyId);
  return getInboxStatus(companyId);
}

/** Anexo de uma mensagem, no formato que este módulo entende. */
export interface MailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface IncomingMail {
  uid: string;
  subject?: string;
  from?: string;
  date?: string;
  attachments: MailAttachment[];
}

/** Anexo é XML de NF-e? Nome e tipo, porque provedor mente em um dos dois. */
function looksLikeNfeXml(att: MailAttachment): boolean {
  const nome = (att.filename ?? '').toLowerCase();
  const tipo = (att.contentType ?? '').toLowerCase();
  return nome.endsWith('.xml') || tipo.includes('xml');
}

/**
 * Processa UMA mensagem já baixada.
 *
 * Separado da conexão IMAP de propósito: assim a regra — o que é XML, o que é
 * duplicado, o que vira conferência — é testável sem servidor de e-mail
 * nenhum, e a mesma função serve para qualquer outra origem futura.
 */
export function processIncomingMail(input: {
  companyId: string;
  userId: string;
  inboxId: string;
  mail: IncomingMail;
}): MailMessageRecord {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();

    // Mesmo e-mail relido não é reprocessado.
    const jaVisto = db
      .prepare('SELECT * FROM core_mail_messages WHERE inbox_id = ? AND provider_uid = ?')
      .get(input.inboxId, input.mail.uid) as MailMessageRecord | undefined;
    if (jaVisto) return jaVisto;

    const registrar = (
      outcome: MailOutcome,
      detail: string,
      extra: { noteId?: string | null; accessKey?: string | null } = {},
    ): MailMessageRecord => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO core_mail_messages
           (id, company_id, inbox_id, provider_uid, subject, sender, received_at,
            outcome, detail, note_id, access_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        input.inboxId,
        input.mail.uid,
        input.mail.subject ?? null,
        input.mail.from ?? null,
        input.mail.date ?? null,
        outcome,
        detail,
        extra.noteId ?? null,
        extra.accessKey ?? null,
        new Date().toISOString(),
      );
      return db
        .prepare('SELECT * FROM core_mail_messages WHERE id = ?')
        .get(id) as unknown as MailMessageRecord;
    };

    const xmls = (input.mail.attachments ?? []).filter(looksLikeNfeXml);
    if (xmls.length === 0) {
      // Boleto, propaganda, assinatura de imagem: registra e ignora. Tentar
      // interpretar como nota encheria a conferência de lixo.
      const outros = (input.mail.attachments ?? []).map((a) => a.filename).join(', ');
      return registrar(
        'sem_xml',
        outros ? `Sem XML de NF-e. Anexos ignorados: ${outros}` : 'Mensagem sem anexo.',
      );
    }

    /*
      TODOS OS XML DO E-MAIL, E NÃO SÓ O PRIMEIRO.

      Aqui estava `const anexo = xmls[0]`, e o resto ia para o lixo — em
      silêncio, com a mensagem gravada dizendo "importado". Fornecedor que
      fatura três pedidos no mesmo dia manda um e-mail com três XML; duas notas
      sumiam, e a caixa de entrada afirmava sucesso.

      Isso ficou mais caro nesta rodada: agora o XML é o que se entrega ao
      contador, e anexo descartado é documento de compra que não existe em
      lugar nenhum — nem aqui, nem no e-mail depois que a mensagem for marcada
      como lida.

      O laço é seguro porque `importNfe` já é idempotente pela chave de acesso:
      o mesmo XML duas vezes não cria duas entradas, venha ele do upload manual
      ou daqui. E o resultado de CADA anexo entra no detalhe da mensagem — se
      dois entram e um é inválido, a caixa mostra os três, com o motivo.
    */
    const resultados: string[] = [];
    /*
      A LINHA DA MENSAGEM APONTA PARA UMA NOTA SÓ, e isso é o esquema, não
      descuido: `core_mail_messages` tem `note_id` e `access_key` no singular.

      Com vários anexos, o vínculo fica com a PRIMEIRA nota que entrou — é o
      que mantém funcionando o caminho de quem clica na mensagem para abrir a
      conferência. As outras não somem: cada uma aparece nomeada no detalhe,
      com o que aconteceu com ela, e todas estão na lista de notas de entrada.

      Uma tabela de ligação mensagem↔nota seria o desenho certo se e-mail com
      vários anexos fosse o caso comum. Não é, e criar tabela para o caso raro
      cobraria migração e leitor novo numa rodada que já tem dono.
    */
    let primeiraNota: { noteId?: string | null; accessKey?: string | null } = {};
    let importadas = 0;
    let duplicadas = 0;
    let invalidas = 0;
    let recusadas = 0;
    let fretesNovos = 0;
    let fretesDuplicados = 0;

    /*
      TETO POR ANEXO (revisão da rodada 44): o upload manual herda o limite
      de 1 MB do body-parser, mas o e-mail chegava sem teto nenhum — e cada
      anexo não-NF-e agora paga um SEGUNDO parse (CT-e). Um XML de NF-e ou
      CT-e de verdade cabe folgado em 2 MB; o que passa disso não é nota,
      é problema.
    */
    const TETO_POR_ANEXO = 2 * 1024 * 1024;

    for (const anexo of xmls) {
      const bytes = Buffer.isBuffer(anexo.content)
        ? anexo.content.length
        : Buffer.byteLength(String(anexo.content));
      if (bytes > TETO_POR_ANEXO) {
        invalidas += 1;
        resultados.push(
          `${anexo.filename}: arquivo grande demais (${Math.round(bytes / 1024 / 1024)} MB — limite 2 MB)`,
        );
        continue;
      }
      const xml = Buffer.isBuffer(anexo.content)
        ? anexo.content.toString('utf8')
        : String(anexo.content);

      try {
        const result = importNfe({ companyId: input.companyId, userId: input.userId, xml });
        if (result.duplicated) {
          duplicadas += 1;
          resultados.push(`${anexo.filename}: já havia sido importada`);
        } else {
          importadas += 1;
          resultados.push(
            `${anexo.filename}: em conferência, ${result.items?.length ?? 0} item(ns)`,
          );
        }
        if (!primeiraNota.noteId) {
          primeiraNota = { noteId: result.noteId, accessKey: result.accessKey };
        }
      } catch (err) {
        /*
          Não é NF-e? Pode ser o CONHECIMENTO DO TRANSPORTE — a
          transportadora manda o CT-e pelo mesmo e-mail que o fornecedor
          manda a nota. Só o "não parece NF-e" tenta o segundo parser:
          XML quebrado continua sendo XML quebrado.
        */
        if (err instanceof ApiError && err.code === 'CORE_XML_NOT_NFE') {
          try {
            const cte = importCte({ companyId: input.companyId, userId: input.userId, xml });
            // A REVISÃO MORDEU AQUI: o duplicado contava como novidade e o
            // e-mail reenviado virava 'importado' — a NF-e reenviada, não.
            if (cte.duplicated) {
              fretesDuplicados += 1;
              resultados.push(`${anexo.filename}: CT-e já havia sido importado`);
            } else {
              fretesNovos += 1;
              resultados.push(
                `${anexo.filename}: CT-e do frete registrado (R$ ${(cte.freightCents / 100).toFixed(2)})`,
              );
            }
            continue;
          } catch {
            // Nem NF-e nem CT-e: cai na recusa comum, com a mensagem da NF-e.
          }
        }
        /*
          A NOTA DE HOMOLOGAÇÃO NUMA EMPRESA EM PRODUÇÃO (R3-DFE): recusada
          ANTES de gravar, registrada com o motivo. A mensagem fica gravada
          como as outras — relida, não é reprocessada, e o cursor da caixa
          passa por ela: uma nota de teste não trava o canal.
        */
        if (err instanceof ApiError && RECUSAS_DO_FUNIL.has(err.code)) {
          recusadas += 1;
          resultados.push(`${anexo.filename}: ${err.message}`);
          continue;
        }
        invalidas += 1;
        const mensagem = err instanceof ApiError ? err.message : 'XML inválido.';
        resultados.push(`${anexo.filename}: ${mensagem}`);
      }
    }

    /*
      O STATUS da mensagem descreve o CONJUNTO, e o pior caso vence.

      Uma mensagem com duas notas boas e uma inválida não pode ficar marcada
      como "importado": quem varre a caixa procurando o que deu errado passaria
      direto por ela. O detalhe lista as três, com o nome do arquivo.
    */
    /*
      'frete' é situação PRÓPRIA (revisão da rodada 44): e-mail só de CT-e
      dizia 'importado' e a tela anunciava uma nota em conferência que não
      existe — CT-e não tem itens e não entra no funil. Com nota nova junto,
      'importado' segue valendo: a NOTA é o que manda no rótulo.
    */
    const status: MailOutcome =
      invalidas > 0
        ? 'invalido'
        : recusadas > 0
          ? 'recusado'
          : importadas > 0
            ? 'importado'
            : fretesNovos > 0
              ? 'frete'
              : 'duplicado';

    const fretes = fretesNovos + fretesDuplicados;
    return registrar(
      status,
      `${xmls.length} XML no e-mail — ${importadas} importada(s), ${duplicadas} já existia(m), ${invalidas} inválida(s)${recusadas > 0 ? `, ${recusadas} recusada(s)` : ''}${fretes > 0 ? `, ${fretesNovos} frete(s) novo(s), ${fretesDuplicados} frete(s) repetido(s)` : ''}. ${resultados.join('; ')}`,
      primeiraNota,
    );
  });
}

export function listMailMessages(companyId: string, limit = 100): MailMessageRecord[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      'SELECT * FROM core_mail_messages WHERE company_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(companyId, limit) as unknown as MailMessageRecord[];
}

/** Resultado de uma leitura da caixa. */
export interface ResultadoDaLeitura {
  /** Mensagens tratadas nesta leitura (novas ou já conhecidas). */
  checked: number;
  results: MailMessageRecord[];
  /**
   * Quantas ficaram na caixa para a próxima leitura (GAP-PRD-035). Antes não
   * existia: a 26ª ficava invisível e a tela dizia "Nenhuma mensagem nova".
   */
  restantes: number;
  /** O que foi feito com cada mensagem depois de processada. */
  depoisDeLer: DepoisDeLer;
  /** O que não impediu a leitura, mas o gestor precisa saber. */
  avisos: string[];
}

/**
 * A chave da mensagem na caixa: `<UIDVALIDITY>:<UID>@<pasta>`.
 *
 * O UID sozinho só identifica a mensagem dentro de UMA validade de UMA pasta.
 * Se o provedor recria a pasta (UIDVALIDITY novo), o UID 5 passa a ser outra
 * mensagem — e com a chave antiga ela seria confundida com a de antes e
 * pulada.
 */
function chaveDaMensagem(validade: string, uid: number, pasta: string): string {
  return `${validade}:${uid}@${pasta}`;
}

/**
 * Onde a leitura anterior parou, para esta validade da pasta.
 *
 * Devolve `null` na primeira leitura e quando o UIDVALIDITY mudou — aí o
 * cursor recomeça. Na primeira leitura de uma caixa que já tinha mensagens
 * gravadas pelo formato antigo (só o UID), elas ganham a chave nova com a
 * validade de agora — a única conhecida —, para não serem reprocessadas.
 */
function cursorDaCaixa(inboxId: string, validade: string, pasta: string): number | null {
  const db = getConnection();
  const atual = db
    .prepare('SELECT imap_uid_validity AS v, imap_last_uid AS u FROM core_mail_inboxes WHERE id = ?')
    .get(inboxId) as { v: string | null; u: number | null } | undefined;

  if (atual && atual.v === validade) {
    return atual.u === null || atual.u === undefined ? null : Number(atual.u);
  }

  withTransaction(() => {
    if (!atual?.v) {
      db.prepare(
        `UPDATE core_mail_messages
            SET provider_uid = ? || ':' || provider_uid || '@' || ?
          WHERE inbox_id = ?
            AND provider_uid <> ''
            AND provider_uid NOT GLOB '*[^0-9]*'`,
      ).run(validade, pasta, inboxId);
    }
    db.prepare(
      'UPDATE core_mail_inboxes SET imap_uid_validity = ?, imap_last_uid = NULL WHERE id = ?',
    ).run(validade, inboxId);
  });
  return null;
}

/** Anda o cursor — nunca para trás, e só dentro da mesma validade. */
function avancarCursor(inboxId: string, validade: string, uid: number): void {
  getConnection()
    .prepare(
      `UPDATE core_mail_inboxes
          SET imap_last_uid = ?
        WHERE id = ? AND imap_uid_validity = ?
          AND (imap_last_uid IS NULL OR imap_last_uid < ?)`,
    )
    .run(uid, inboxId, validade, uid);
}

function mensagemJaVista(inboxId: string, chave: string): MailMessageRecord | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_mail_messages WHERE inbox_id = ? AND provider_uid = ?')
    .get(inboxId, chave) as MailMessageRecord | undefined;
}

/**
 * Registra uma mensagem que não pôde ser lida — grande demais, ou que o
 * `mailparser` não entendeu. Ela aparece na lista com o motivo e o cursor
 * passa por ela: uma mensagem problemática não pode entupir o canal de novo.
 */
function registrarSemLer(input: {
  companyId: string;
  inboxId: string;
  chave: string;
  detalhe: string;
}): MailMessageRecord {
  const db = getConnection();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_mail_messages
       (id, company_id, inbox_id, provider_uid, subject, sender, received_at,
        outcome, detail, note_id, access_key, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'ilegivel', ?, NULL, NULL, ?)`,
  ).run(id, input.companyId, input.inboxId, input.chave, input.detalhe, new Date().toISOString());
  return db.prepare('SELECT * FROM core_mail_messages WHERE id = ?').get(id) as unknown as MailMessageRecord;
}

/**
 * Classifica a falha para a tela dizer o passo seguinte (GAP-PRD-128).
 *
 * O imapflow marca a recusa de login com `authenticationFailed` e a pasta
 * inexistente com `serverResponseCode: 'NONEXISTENT'`; o texto do provedor
 * ("Invalid credentials", "Application-specific password required") vem em
 * `response`. Nada disso carrega a senha.
 */
function classificarFalha(
  err: unknown,
  caixa: { host: string; port: number; folder: string },
): { tipo: TipoDaFalha; motivo: string } {
  const e = (err ?? {}) as {
    message?: unknown;
    response?: unknown;
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    code?: unknown;
  };
  const bruto = typeof e.message === 'string' && e.message ? e.message : 'Falha ao conectar.';
  const resposta =
    typeof e.response === 'string' && e.response.trim() ? e.response.trim().slice(0, 200) : '';
  const texto = resposta && !bruto.includes(resposta) ? `${bruto} (${resposta})` : bruto;
  const tudo = `${bruto} ${resposta}`;

  if (
    e.authenticationFailed === true ||
    /authenticat|invalid credentials|login|application-specific password|web login required/i.test(tudo)
  ) {
    return {
      tipo: 'credencial',
      motivo: `${texto}. O provedor recusou o usuário ou a senha. Verifique o usuário e a senha de aplicativo — a senha normal da conta não funciona para IMAP, e o provedor pode exigir liberar o acesso.`,
    };
  }
  if (e.serverResponseCode === 'NONEXISTENT' || /doesn.t exist|nonexistent|no such mailbox|unknown mailbox/i.test(tudo)) {
    return {
      tipo: 'pasta',
      motivo: `${texto}. A pasta "${caixa.folder}" não existe nesta caixa — confira o nome (no Gmail, a caixa de entrada é INBOX).`,
    };
  }
  if (/command failed/i.test(bruto) && !resposta) {
    // "Command failed" sozinho é o que o provedor devolve para quase tudo,
    // inclusive senha errada: sem outro sinal, a causa provável é a senha.
    return {
      tipo: 'credencial',
      motivo: `${texto}. Verifique o usuário e a senha de aplicativo — a senha normal da conta não funciona para IMAP, e o provedor pode exigir liberar o acesso.`,
    };
  }
  return {
    tipo: 'conexao',
    motivo: `${texto}. Confira o servidor (${caixa.host}), a porta (${caixa.port}) e a conexão segura; se estão certos, costuma ser passageiro.`,
  };
}

function registrarFalha(inboxId: string, tipo: TipoDaFalha, motivo: string): void {
  getConnection()
    .prepare(
      'UPDATE core_mail_inboxes SET last_check_at = ?, last_error = ?, last_error_kind = ? WHERE id = ?',
    )
    .run(new Date().toISOString(), motivo, tipo, inboxId);
}

/** A caixa em condição de ser aberta — ou o erro que diz por que não. */
function caixaPronta(companyId: string): Record<string, unknown> {
  const row = inboxRow(companyId);
  if (!row || !row.secret_cipher) {
    throw new ApiError(
      'CORE_MAIL_NOT_CONFIGURED',
      'Caixa de e-mail não configurada ou sem senha.',
      409,
      { readiness: 'READY_FOR_CREDENTIAL' },
    );
  }
  if (row.active !== 1) {
    throw new ApiError('CORE_MAIL_INACTIVE', 'A leitura desta caixa está desativada.', 409);
  }
  return row;
}

async function abrirCliente(row: Record<string, unknown>) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: String(row.host),
    port: Number(row.port),
    secure: row.secure === 1,
    auth: {
      user: String(row.username),
      pass: decryptFiscalSecret(String(row.secret_cipher)),
    },
    // O log padrão despeja a conversa inteira, credencial incluída.
    logger: false,
  });
}

/**
 * Busca as mensagens novas na caixa e processa cada uma.
 *
 * A conexão IMAP é carregada sob demanda: o ERP inteiro não precisa do cliente
 * de e-mail em memória para funcionar, e quem nunca configurou caixa nenhuma
 * não paga por isso.
 *
 * COMO NÃO ENTUPIR (GAP-PRD-035)
 *
 *   1. O que é "novo" vem do CURSOR, não do "não lida": depois da primeira
 *      leitura, é tudo com UID acima do último processado — inclusive a
 *      mensagem que alguém já abriu no Gmail antes de o sistema passar.
 *      Sem cursor (primeira leitura, ou a pasta mudou de UIDVALIDITY), vale o
 *      "não lida" — não dá para importar dez anos de caixa.
 *   2. Um lote por leitura, do UID mais antigo ao mais novo; o cursor anda a
 *      cada mensagem, então uma queda no meio não repete nem pula nada.
 *   3. Depois de processada, a mensagem é marcada como lida, movida ou
 *      deixada, conforme a empresa escolheu. Se o provedor recusar (caixa
 *      somente leitura), vira aviso — o cursor já garante que ela não volta.
 *   4. Nenhum comando roda dentro do laço de um `fetch` — no imapflow isso
 *      trava a conexão. Busca (SEARCH), tamanhos (FETCH de metadados) e cada
 *      mensagem (FETCH um a um) são comandos separados.
 */
export async function checkInbox(input: {
  companyId: string;
  userId: string;
  /** Quantas mensagens processar nesta leitura, no máximo. */
  limit?: number;
}): Promise<ResultadoDaLeitura> {
  ensureCoreSchema();
  const row = caixaPronta(input.companyId);

  const { simpleParser } = await import('mailparser');
  const client = await abrirCliente(row);

  const inboxId = String(row.id);
  const pasta = String(row.folder);
  const limite = Math.max(1, Math.floor(input.limit ?? LOTE_POR_LEITURA));
  let depois = normalizarDepoisDeLer(row.after_read);
  const destino = row.processed_folder ? String(row.processed_folder) : null;
  if (depois === 'mover' && !destino) depois = 'lida';

  const results: MailMessageRecord[] = [];
  const avisos = new Set<string>();
  let checked = 0;
  let restantes: number | undefined;

  try {
    await client.connect();
    const lock = await client.getMailboxLock(pasta);
    try {
      const aberta = client.mailbox;
      const validade = aberta ? String(aberta.uidValidity ?? '') : '';
      const cursor = cursorDaCaixa(inboxId, validade, pasta);

      const achados = await client.search(
        cursor === null ? { seen: false } : { uid: `${cursor + 1}:*` },
        { uid: true },
      );
      // `N:*` com N acima do último UID devolve a ÚLTIMA mensagem (RFC 3501):
      // o filtro é o que impede reler a mesma para sempre.
      const novos = (Array.isArray(achados) ? achados : [])
        .map(Number)
        .filter((uid) => Number.isInteger(uid) && (cursor === null || uid > cursor))
        .sort((a, b) => a - b);

      // Caixa sem nada não lido na primeira leitura: o cursor começa no fim,
      // e a partir daí vale "tudo que chegar", lido por alguém ou não.
      if (cursor === null && novos.length === 0 && aberta && Number(aberta.uidNext) > 1) {
        avancarCursor(inboxId, validade, Number(aberta.uidNext) - 1);
      }

      const lote = novos.slice(0, limite);
      restantes = novos.length - lote.length;

      if (depois === 'mover' && lote.length > 0) {
        try {
          await client.mailboxCreate(destino!);
        } catch (err) {
          depois = 'lida';
          avisos.add(
            `Não foi possível usar a pasta "${destino}" (${err instanceof Error ? err.message : 'erro do provedor'}) — as mensagens foram marcadas como lidas no lugar.`,
          );
        }
      }

      // O tamanho de cada uma, sem baixar: uma mensagem de 80 MB não entra
      // na memória do servidor para descobrir que não é nota.
      const tamanhos = new Map<number, number>();
      if (lote.length > 0) {
        const meta = await client.fetchAll(lote, { uid: true, size: true }, { uid: true });
        for (const m of meta) tamanhos.set(Number(m.uid), Number(m.size ?? 0));
      }

      for (const uid of lote) {
        const chave = chaveDaMensagem(validade, uid, pasta);
        let registro = mensagemJaVista(inboxId, chave);

        if (!registro) {
          const tamanho = tamanhos.get(uid);
          if (tamanho === undefined) {
            // Apagada entre a busca e o download: não há o que ler.
            avancarCursor(inboxId, validade, uid);
            continue;
          }
          if (tamanho > TETO_DA_MENSAGEM_BYTES) {
            registro = registrarSemLer({
              companyId: input.companyId,
              inboxId,
              chave,
              detalhe: `Mensagem de ${Math.round(tamanho / 1024 / 1024)} MB, acima do limite de ${TETO_DA_MENSAGEM_BYTES / 1024 / 1024} MB — não foi baixada. Se houver nota nela, salve o XML e use o upload manual.`,
            });
          } else {
            const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (!msg || !msg.source) {
              avancarCursor(inboxId, validade, uid);
              continue;
            }
            let parsed: Awaited<ReturnType<typeof simpleParser>> | null = null;
            try {
              parsed = await simpleParser(msg.source);
            } catch (err) {
              registro = registrarSemLer({
                companyId: input.companyId,
                inboxId,
                chave,
                detalhe: `Não foi possível ler a mensagem (${err instanceof Error ? err.message : 'formato desconhecido'}). Se houver nota nela, salve o XML e use o upload manual.`,
              });
            }
            if (parsed) {
              // Falha AQUI (banco, por exemplo) derruba a leitura sem andar o
              // cursor: a mensagem é tentada de novo na próxima.
              registro = processIncomingMail({
                companyId: input.companyId,
                userId: input.userId,
                inboxId,
                mail: {
                  uid: chave,
                  subject: parsed.subject ?? undefined,
                  from: parsed.from?.text ?? undefined,
                  date: parsed.date?.toISOString(),
                  attachments: (parsed.attachments ?? []).map((a) => ({
                    filename: a.filename ?? 'anexo',
                    content: a.content,
                    contentType: a.contentType,
                  })),
                },
              });
            }
          }
        }

        checked += 1;
        results.push(registro!);

        // Depois de processada: o que a empresa escolheu.
        try {
          if (depois === 'lida') {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } else if (depois === 'mover') {
            await client.messageMove(String(uid), destino!, { uid: true });
          }
        } catch (err) {
          avisos.add(
            `O provedor não deixou ${depois === 'mover' ? `mover a mensagem para "${destino}"` : 'marcar a mensagem como lida'} (${err instanceof Error ? err.message : 'erro do provedor'}). Nada será lido de novo — o sistema lembra onde parou.`,
          );
        }
        avancarCursor(inboxId, validade, uid);
      }
    } finally {
      lock.release();
    }

    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `UPDATE core_mail_inboxes
            SET last_check_at = ?, last_ok_at = ?, last_error = NULL, last_error_kind = NULL,
                imap_pending = ?
          WHERE id = ?`,
      )
      .run(agora, agora, restantes ?? 0, inboxId);
  } catch (err) {
    // A mensagem do provedor é guardada para o gestor entender o que houve —
    // mas a credencial nunca entra aqui.
    const { tipo, motivo } = classificarFalha(err, {
      host: String(row.host),
      port: Number(row.port),
      folder: pasta,
    });
    registrarFalha(inboxId, tipo, motivo);
    throw new ApiError('CORE_MAIL_CONNECTION_FAILED', `Não foi possível ler a caixa: ${motivo}`, 502, {
      tipo,
    });
  } finally {
    try {
      await client.logout();
    } catch {
      // Conexão já caída.
    }
  }

  return { checked, results, restantes: restantes ?? 0, depoisDeLer: depois, avisos: [...avisos] };
}

/** Resultado de "Testar conexão" (GAP-PRD-128). */
export interface TesteDeConexao {
  ok: boolean;
  /** Quantas mensagens a pasta tem, e quantas não lidas — só com `ok`. */
  mensagens: number | null;
  naoLidas: number | null;
  tipo: TipoDaFalha | null;
  message: string;
  status: InboxStatus;
}

/**
 * Entra na caixa, abre a pasta e sai — sem ler nenhuma mensagem.
 *
 * É o que o dono faz depois de colar a senha de aplicativo: descobrir na hora
 * se o provedor aceitou, em vez de esperar a próxima leitura automática (ou
 * ligá-la e encher a auditoria de erro). Não processa, não marca, não move.
 */
export async function testarConexao(companyId: string): Promise<TesteDeConexao> {
  ensureCoreSchema();
  const row = inboxRow(companyId);
  if (!row || !row.secret_cipher) {
    throw new ApiError(
      'CORE_MAIL_NOT_CONFIGURED',
      'Salve a caixa com a senha de aplicativo antes de testar.',
      409,
      { readiness: 'READY_FOR_CREDENTIAL' },
    );
  }
  const inboxId = String(row.id);
  const pasta = String(row.folder);
  const client = await abrirCliente(row);

  try {
    await client.connect();
    const situacao = await client.status(pasta, { messages: true, unseen: true });
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `UPDATE core_mail_inboxes
            SET last_check_at = ?, last_ok_at = ?, last_error = NULL, last_error_kind = NULL
          WHERE id = ?`,
      )
      .run(agora, agora, inboxId);
    const mensagens = Number(situacao?.messages ?? 0);
    const naoLidas = Number(situacao?.unseen ?? 0);
    return {
      ok: true,
      mensagens,
      naoLidas,
      tipo: null,
      message: `Conexão aceita. A pasta "${pasta}" tem ${mensagens} mensagem(ns), ${naoLidas} não lida(s). Nenhuma foi lida agora — use "Ler agora" ou ative a leitura automática.`,
      status: getInboxStatus(companyId),
    };
  } catch (err) {
    const { tipo, motivo } = classificarFalha(err, {
      host: String(row.host),
      port: Number(row.port),
      folder: pasta,
    });
    registrarFalha(inboxId, tipo, motivo);
    return {
      ok: false,
      mensagens: null,
      naoLidas: null,
      tipo,
      message: motivo,
      status: getInboxStatus(companyId),
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // Conexão já caída.
    }
  }
}
