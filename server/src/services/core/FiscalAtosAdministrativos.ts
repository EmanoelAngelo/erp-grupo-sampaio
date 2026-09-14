/**
 * OS ATOS ADMINISTRATIVOS COM A SEFAZ — cancelamento, carta de correção e
 * inutilização (GAP-PRD-005 / GAP-PRD-018).
 *
 * ## O que a auditoria mediu
 *
 * A tela mandava `developmentMode: true` nos três atos, e o servidor escolhia
 * o adapter por essa bandeira do CLIENTE. Resultado: nenhum caminho de tela
 * chegava à SEFAZ — em homologação a nota real era marcada cancelada com
 * protocolo `TEST-` fabricado; em produção o botão morria em 500. Sem a
 * bandeira, o slot "real" sem senha devolvia o simulador sempre que o
 * SERVIDOR não se declarava produção, e uma operação em produção cancelava
 * nota de verdade com protocolo de ensaio.
 *
 * ## A regra deste módulo: o caminho segue a PROCEDÊNCIA da nota
 *
 *  - Nota autorizada pelo SIMULADOR (protocolo `TEST-` ou XML com a marca de
 *    fixture) só é tocada pelo simulador — ela não existe para o fisco, e
 *    mandar o cancelamento dela à SEFAZ seria pedir o impossível. Em produção
 *    (da operação, da nota ou do processo) nem isso: é recusa explicada.
 *  - Nota autorizada pela SEFAZ só é tocada pela SEFAZ, com o A1 da operação.
 *    Pedir o simulador para ela é recusado em QUALQUER ambiente.
 *  - Inutilização não tem nota: vai à SEFAZ; o simulador só com pedido
 *    explícito (`developmentMode`), e nunca em produção.
 *
 * O cliente não escolhe mais o provider — ele pode, no máximo, PEDIR o modo
 * de desenvolvimento, e o servidor decide se o pedido cabe.
 *
 * ## O certificado: cofre ou senha digitada — decisão do dono
 *
 * A emissão já usa o A1 do COFRE (arquivo e senha selados juntos). Estender o
 * segredo selado aos atos administrativos era "decisão à parte, ainda não
 * tomada" — e enquanto não tomada, a tela não tinha como cancelar nada. A
 * decisão agora tem mecanismo (`core_fiscal_act_policies`) e tela
 * (Fiscal › Certificado), com padrão SEGURO: o cofre. A senha do A1 não
 * trafega pelo navegador e não passa a ser sabida por todo gerente que
 * cancela; quem cancela continua sendo só gerente, com trilha de auditoria.
 * O dono pode exigir a senha digitada a cada ato. Senha digitada, quando
 * vem, sempre ganha (quem digita afirma qual é, e o erro tem de aparecer).
 *
 * ## A Distribuição DF-e usa a MESMA decisão (GAP-PRD-168)
 *
 * A consulta das notas destinadas e a manifestação do destinatário são atos
 * com a SEFAZ sem nota nossa — como a inutilização. Elas chamam
 * `adapterDoAtoFiscal` sem `documentId`: mesma política, mesmo cofre, mesma
 * recusa. Antes usavam um slot à parte (`adapterRealOuSimulador`) que só abria
 * o A1 com a senha no corpo — que nenhuma tela mandava —, e com o A1 guardado
 * a tela ou tomava 400 (produção) ou falava com o simulador (homologação).
 */
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection } from '../../db/sqlite.js';
import { findOneRow } from '../../db/database.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { getDocument, type FiscalDocument } from './FiscalDocumentService.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';
import { FIXTURE_SIGNATURE_MARK } from './FiscalPipelineService.js';
import { assertAdapterPodeTransmitir, exigeAdapterReal, type SefazAdapter } from './SefazAdapter.js';
import { SefazRealAdapter } from './SefazRealAdapter.js';
import { SefazTestAdapter, isTestProtocol } from './SefazTestAdapter.js';
import { getCertificateA1, type ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';

const UNIDADE = 'unit-default';

// ------------------------------------------------------------ a política

export interface PoliticaDosAtos {
  /** `true`: cada ato pede a senha do A1. `false` (padrão): vale o cofre. */
  exigirSenhaDigitada: boolean;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

export function lerPoliticaDosAtos(companyId: string): PoliticaDosAtos {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT require_typed_password, updated_by, updated_at FROM core_fiscal_act_policies WHERE company_id = ?',
    )
    .get(companyId) as
    | { require_typed_password: number; updated_by: string | null; updated_at: string }
    | undefined;
  return {
    exigirSenhaDigitada: Number(row?.require_typed_password ?? 0) === 1,
    atualizadoEm: row?.updated_at ?? null,
    atualizadoPor: row?.updated_by ?? null,
  };
}

/** Grava a decisão do dono, com trilha. Só aceita booleano — "sim" não é resposta. */
export function gravarPoliticaDosAtos(input: {
  companyId: string;
  exigirSenhaDigitada: unknown;
  userId?: string | null;
}): PoliticaDosAtos {
  ensureCoreSchema();
  if (typeof input.exigirSenhaDigitada !== 'boolean') {
    throw new ApiError(
      'CORE_FISCAL_ACT_POLICY_INVALID',
      'Informe exigirSenhaDigitada como verdadeiro ou falso.',
      400,
    );
  }
  const antes = lerPoliticaDosAtos(input.companyId);
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_act_policies (company_id, require_typed_password, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         require_typed_password = excluded.require_typed_password,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(input.companyId, input.exigirSenhaDigitada ? 1 : 0, input.userId ?? null, agora);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.act_policy_updated',
    entityType: 'fiscal_config',
    entityId: input.companyId,
    detail: { antes: antes.exigirSenhaDigitada, depois: input.exigirSenhaDigitada },
  });
  return lerPoliticaDosAtos(input.companyId);
}

// ------------------------------------------------------------- o cofre

/**
 * O que o cofre tem — sem abrir o `.pfx` (abrir exigiria decifrar a senha só
 * para responder a uma pergunta de tela).
 */
export type SituacaoDoCofre = 'SELADO' | 'SEM_SENHA_SELADA' | 'AUSENTE';

export function situacaoDoCofre(companyId: string): SituacaoDoCofre {
  const ref = findOneRow<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === companyId && r.operationalUnitId === UNIDADE,
  );
  if (!ref?.encryptedPfx) return 'AUSENTE';
  if (!ref.encryptedPassword) return 'SEM_SENHA_SELADA';
  return 'SELADO';
}

// ---------------------------------------------------------- a procedência

/**
 * Nota de ENSAIO: autorizada pelo simulador (protocolo `TEST-`) ou assinada
 * pela fixture de desenvolvimento. Não existe para o fisco.
 */
export function documentoDeEnsaio(companyId: string, doc: FiscalDocument): boolean {
  if (isTestProtocol(doc.protocol)) return true;
  const row = getConnection()
    .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ? AND company_id = ?')
    .get(doc.id, companyId) as { xml_signed: string | null } | undefined;
  return String(row?.xml_signed ?? '').includes(FIXTURE_SIGNATURE_MARK);
}

// -------------------------------------------------------------- o plano

export type CaminhoDoAto = 'SEFAZ' | 'SIMULADOR' | 'BLOQUEADO';

export interface PlanoDoAto {
  /** Para onde o ato vai — decidido pelo servidor, nunca pelo cliente. */
  caminho: CaminhoDoAto;
  /** O ambiente em que o ato vale: o da nota, ou o da operação (inutilização). */
  ambiente: FiscalEnvironment;
  /** O que a tela precisa pedir. */
  senha: 'NAO_SE_APLICA' | 'OPCIONAL' | 'OBRIGATORIA';
  /** Situação do A1 da operação, para a tela explicar o que falta. */
  cofre: SituacaoDoCofre;
  /** Quando BLOQUEADO: o código do erro que o ato devolveria. */
  codigo: string | null;
  /** Em linguagem de gerente: o que vai acontecer, ou por que não. */
  motivo: string;
  politica: PoliticaDosAtos;
}

const STATUS_DO_BLOQUEIO: Record<string, number> = {
  CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION: 409,
  CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION: 409,
  CORE_SEFAZ_TEST_PROVIDER_REAL_DOCUMENT: 409,
  CORE_SEFAZ_CERTIFICATE_MISSING: 409,
};

function nomeDoAmbiente(ambiente: FiscalEnvironment): string {
  return ambiente === 'production' ? 'produção' : 'homologação';
}

/**
 * Decide o caminho de um ato — sem abrir certificado nem falar com ninguém.
 *
 * É a MESMA decisão que `adapterDoAtoFiscal` executa: a tela pergunta aqui
 * antes de mostrar o botão, e o ato, depois do clique, não tem como divergir.
 */
export function planejarAtoFiscal(input: {
  companyId: string;
  documentId?: string | null;
  developmentMode?: boolean;
  senhaDigitada?: boolean;
}): PlanoDoAto {
  ensureCoreSchema();
  const config = getFiscalConfig(input.companyId);
  const politica = lerPoliticaDosAtos(input.companyId);
  const cofre = situacaoDoCofre(input.companyId);

  let doc: FiscalDocument | null = null;
  if (input.documentId) {
    doc = getDocument(input.companyId, input.documentId);
    if (!doc) {
      throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
    }
  }

  const ambiente: FiscalEnvironment =
    doc && (doc.environment === 'production' || doc.environment === 'homologation')
      ? doc.environment
      : config.environment;
  // Produção da NOTA, da OPERAÇÃO ou do PROCESSO — qualquer uma basta.
  const producao = exigeAdapterReal(ambiente) || exigeAdapterReal(config.environment);

  const plano = (
    caminho: CaminhoDoAto,
    motivo: string,
    extra: Partial<Pick<PlanoDoAto, 'senha' | 'codigo'>> = {},
  ): PlanoDoAto => ({
    caminho,
    ambiente,
    senha: extra.senha ?? 'NAO_SE_APLICA',
    cofre,
    codigo: extra.codigo ?? null,
    motivo,
    politica,
  });

  if (doc && documentoDeEnsaio(input.companyId, doc)) {
    if (producao) {
      return plano(
        'BLOQUEADO',
        'Esta nota foi autorizada pelo SIMULADOR (protocolo de teste) e a operação está em '
          + 'produção. Ela nunca existiu para o fisco: não há o que cancelar ou corrigir na SEFAZ, '
          + 'e o simulador não age em produção.',
        { codigo: 'CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION' },
      );
    }
    return plano(
      'SIMULADOR',
      'Esta nota foi autorizada pelo simulador: o ato também será simulado, sem valor fiscal.',
    );
  }

  if (input.developmentMode) {
    if (producao) {
      return plano(
        'BLOQUEADO',
        'O modo de desenvolvimento não é permitido em produção: ato feito pelo simulador não '
          + 'existe para o fisco.',
        { codigo: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' },
      );
    }
    if (doc) {
      return plano(
        'BLOQUEADO',
        'Esta nota foi autorizada pela SEFAZ (protocolo real). O simulador não pode cancelá-la '
          + 'nem corrigi-la: o sistema diria "cancelada" enquanto o fisco a mantém válida.',
        { codigo: 'CORE_SEFAZ_TEST_PROVIDER_REAL_DOCUMENT' },
      );
    }
    return plano(
      'SIMULADOR',
      'Modo de desenvolvimento pedido explicitamente: o ato será simulado, sem valor fiscal.',
    );
  }

  const destino = `SEFAZ (${nomeDoAmbiente(ambiente)})`;
  if (cofre === 'AUSENTE') {
    return plano(
      'BLOQUEADO',
      `Este ato vai à ${destino} e precisa do certificado A1 da operação, que não está no `
        + 'cofre. Envie o .pfx em Fiscal › Certificado.',
      { codigo: 'CORE_SEFAZ_CERTIFICATE_MISSING' },
    );
  }
  if (input.senhaDigitada) {
    return plano('SEFAZ', `Vai à ${destino} com o certificado A1 aberto pela senha digitada.`, {
      senha: 'OBRIGATORIA',
    });
  }
  if (politica.exigirSenhaDigitada) {
    return plano(
      'SEFAZ',
      `Vai à ${destino}. A política desta operação exige a senha do certificado a cada ato.`,
      { senha: 'OBRIGATORIA' },
    );
  }
  if (cofre === 'SEM_SENHA_SELADA') {
    return plano(
      'SEFAZ',
      `Vai à ${destino}. O certificado foi guardado sem a senha selada: digite a senha, ou `
        + 'reenvie o .pfx com a senha em Fiscal › Certificado para dispensá-la.',
      { senha: 'OBRIGATORIA' },
    );
  }
  return plano('SEFAZ', `Vai à ${destino} com o certificado A1 do cofre desta operação.`, {
    senha: 'OPCIONAL',
  });
}

// ------------------------------------------------------------- o adapter

/** Abre o A1 do ato: senha digitada ganha; sem ela, o cofre — se a política deixar. */
function certificadoDoAto(companyId: string, senha: string, politica: PoliticaDosAtos): ParsedCertificateA1 {
  if (senha) {
    try {
      return getCertificateA1(companyId, UNIDADE, senha);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'FISCAL_CERTIFICATE_NOT_FOUND') {
        throw new ApiError(
          'CORE_SEFAZ_CERTIFICATE_MISSING',
          'Não há certificado A1 no cofre desta operação. Envie o .pfx em Fiscal › Certificado.',
          409,
        );
      }
      throw err;
    }
  }
  if (politica.exigirSenhaDigitada) {
    throw new ApiError(
      'CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED',
      'A política desta operação exige a senha do certificado A1 em cada ato com a SEFAZ '
        + '(cancelamento, carta de correção, inutilização, consulta e manifestação das notas '
        + 'destinadas). Digite a senha do certificado para continuar — ou o dono volta a política '
        + 'para o cofre em Fiscal › Certificado.',
      400,
    );
  }
  try {
    return getCertificateA1(companyId, UNIDADE);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.code === 'FISCAL_CERTIFICATE_NOT_FOUND') {
      throw new ApiError(
        'CORE_SEFAZ_CERTIFICATE_MISSING',
        'Não há certificado A1 no cofre desta operação. Envie o .pfx em Fiscal › Certificado.',
        409,
      );
    }
    if (err.code === 'FISCAL_CERTIFICATE_PASSWORD_REQUIRED') {
      throw new ApiError(
        'CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED',
        'O certificado desta operação foi guardado sem a senha selada. Digite a senha do '
          + 'certificado para este ato, ou reenvie o .pfx com a senha em Fiscal › Certificado.',
        400,
      );
    }
    if (err.code === 'FISCAL_CERTIFICATE_PASSWORD_INVALID') {
      // Ninguém digitou nada: "senha incorreta" acusaria quem não errou.
      throw new ApiError(
        'FISCAL_CERTIFICATE_PASSWORD_INVALID',
        'A senha selada no cofre não abre o certificado — o arquivo ou a senha mudaram por '
          + 'fora. Reenvie o .pfx com a senha atual em Fiscal › Certificado.',
        400,
      );
    }
    throw err;
  }
}

/**
 * O adapter de um ato administrativo, pela decisão de `planejarAtoFiscal`.
 *
 * `fabricarReal` existe para os testes trocarem o TRANSPORTE (nenhum byte sai
 * da suíte); o adapter devolvido passa pelo mesmo portão de produção de
 * qualquer outro.
 */
export function adapterDoAtoFiscal(input: {
  companyId: string;
  documentId?: string | null;
  developmentMode?: boolean;
  certificatePassword?: unknown;
  fabricarReal?: (cert: ParsedCertificateA1) => SefazAdapter;
}): SefazAdapter {
  const senha = typeof input.certificatePassword === 'string' ? input.certificatePassword : '';
  const plano = planejarAtoFiscal({
    companyId: input.companyId,
    documentId: input.documentId,
    developmentMode: input.developmentMode,
    senhaDigitada: Boolean(senha),
  });

  if (plano.caminho === 'BLOQUEADO') {
    const codigo = plano.codigo ?? 'CORE_SEFAZ_ACT_BLOCKED';
    throw new ApiError(codigo, plano.motivo, STATUS_DO_BLOQUEIO[codigo] ?? 409, {
      ambiente: plano.ambiente,
    });
  }

  const adapter =
    plano.caminho === 'SIMULADOR'
      ? new SefazTestAdapter()
      : (() => {
          const cert = certificadoDoAto(input.companyId, senha, plano.politica);
          return input.fabricarReal ? input.fabricarReal(cert) : new SefazRealAdapter({ cert });
        })();

  // A segunda tranca, independente do plano: em produção, só adapter real.
  assertAdapterPodeTransmitir({ adapter, environment: plano.ambiente });
  assertAdapterPodeTransmitir({
    adapter,
    environment: getFiscalConfig(input.companyId).environment,
  });
  return adapter;
}

/**
 * O PORTÃO NO DOMÍNIO — vale para quem chamar o serviço de eventos com
 * qualquer adapter, pela rota ou não.
 *
 *  - em produção (nota, operação ou processo), adapter de teste não age;
 *  - nota com protocolo REAL não é tocada por adapter de teste, em nenhum
 *    ambiente: o sistema diria "cancelada" com a nota válida no fisco.
 */
export function assertAdapterPodeAgirNoDocumento(input: {
  companyId: string;
  adapter: SefazAdapter;
  doc: FiscalDocument | null;
}): void {
  const config = getFiscalConfig(input.companyId);
  assertAdapterPodeTransmitir({ adapter: input.adapter, environment: config.environment });
  if (!input.doc) return;
  assertAdapterPodeTransmitir({ adapter: input.adapter, environment: input.doc.environment });
  if (!input.adapter.isReal && !documentoDeEnsaio(input.companyId, input.doc)) {
    throw new ApiError(
      'CORE_SEFAZ_TEST_PROVIDER_REAL_DOCUMENT',
      'Esta nota foi autorizada pela SEFAZ (protocolo real). O simulador não pode cancelá-la '
        + 'nem corrigi-la: o sistema diria "cancelada" enquanto o fisco a mantém válida.',
      409,
    );
  }
}
