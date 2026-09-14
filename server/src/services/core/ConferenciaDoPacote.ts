/**
 * ============================================================================
 * CONFERIR UM PACOTE DO CONTADOR (GAP-PRD-176)
 * ============================================================================
 *
 * "O arquivo que o contador recebeu é o que o sistema gerou?" era uma pergunta
 * sem resposta: o pacote descrevia o próprio conteúdo em texto, e texto se
 * edita. Agora cada entrega deixa o SHA-256 na trilha de auditoria — o do zip
 * inteiro e o do MANIFESTO.csv de dentro dele — e esta função procura um hash
 * informado contra essas entregas.
 *
 * ## Por que a trilha, e não uma tabela nova
 *
 * A trilha JÁ era o registro de cada entrega ("quem baixou o pacote de
 * março?"), com quem e quando. O hash é mais um fato do mesmo gesto; uma
 * segunda tabela seria uma segunda verdade sobre a mesma entrega, pronta para
 * divergir da primeira.
 *
 * ## Dois hashes, duas perguntas
 *
 *   - o do ZIP muda a cada montagem (o zip leva a hora em que foi montado):
 *     ele prova "este é exatamente o arquivo que saiu naquele dia";
 *   - o do MANIFESTO é determinístico e amarra o SHA-256 de cada arquivo:
 *     ele prova o CONTEÚDO, mesmo que o zip tenha sido extraído e recompactado.
 *
 * ## Só a empresa do token
 *
 * O filtro de empresa vai na consulta. O pacote da vizinha, com o mesmo hash
 * informado, não é reconhecido — nem é dito que existe.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface OcorrenciaDoPacote {
  /** De qual arquivo é o hash: o zip inteiro ou o MANIFESTO.csv de dentro. */
  arquivo: 'zip' | 'manifesto';
  /** Como a entrega saiu: baixada pela tela ou enfileirada por e-mail. */
  meio: 'download' | 'email';
  period: string | null;
  nomeArquivo: string | null;
  /** Instante da entrega, como a trilha o guardou (ISO). */
  quando: string;
  userId: string | null;
}

export interface ConferenciaDoPacote {
  sha256: string;
  encontrado: boolean;
  ocorrencias: OcorrenciaDoPacote[];
}

/** As duas entregas que carregam o hash. Nenhuma outra ação é procurada. */
const MEIO_DA_ACAO: Record<string, OcorrenciaDoPacote['meio']> = {
  'fiscal.closing.package': 'download',
  'contador.pacote_email': 'email',
};

/** 64 caracteres hexadecimais — o SHA-256 que `certutil` e `sha256sum` mostram. */
const SHA256 = /^[0-9a-f]{64}$/;

export function conferirPacote(companyId: string, hashInformado: string): ConferenciaDoPacote {
  ensureCoreSchema();
  // `certutil` mostra em minúsculas; alguns utilitários, em maiúsculas. Espaço
  // de copiar e colar não é parte do hash.
  const sha256 = String(hashInformado ?? '').replace(/\s+/g, '').toLowerCase();
  if (!SHA256.test(sha256)) {
    throw new ApiError(
      'CORE_FISCAL_SHA256_INVALIDO',
      'Informe o SHA-256 do arquivo: 64 caracteres, de 0 a 9 e de a a f.',
      400,
    );
  }

  /*
    O LIKE só estreita a busca — ele casaria o hash em qualquer campo. A
    decisão é a comparação EXATA com `sha256`/`manifestoSha256` do detalhe
    lido, logo abaixo. O valor do LIKE já passou pela regex: só tem [0-9a-f].
  */
  const linhas = getConnection()
    .prepare(
      `SELECT action, user_id, detail, created_at
         FROM core_audit_log
        WHERE company_id = ?
          AND action IN ('fiscal.closing.package', 'contador.pacote_email')
          AND detail LIKE ?
        ORDER BY created_at, rowid`,
    )
    .all(companyId, `%${sha256}%`) as {
    action: string;
    user_id: string | null;
    detail: string | null;
    created_at: string;
  }[];

  const ocorrencias: OcorrenciaDoPacote[] = [];
  for (const linha of linhas) {
    let detalhe: Record<string, unknown>;
    try {
      detalhe = JSON.parse(String(linha.detail ?? '')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const arquivo =
      detalhe.sha256 === sha256 ? 'zip' : detalhe.manifestoSha256 === sha256 ? 'manifesto' : null;
    const meio = MEIO_DA_ACAO[linha.action];
    if (!arquivo || !meio) continue;
    ocorrencias.push({
      arquivo,
      meio,
      period: typeof detalhe.period === 'string' ? detalhe.period : null,
      nomeArquivo: typeof detalhe.nomeArquivo === 'string' ? detalhe.nomeArquivo : null,
      quando: String(linha.created_at),
      userId: linha.user_id ?? null,
    });
  }

  return { sha256, encontrado: ocorrencias.length > 0, ocorrencias };
}
