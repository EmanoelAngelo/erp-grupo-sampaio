/**
 * Situação do certificado digital A1, por operação.
 *
 * NÃO reimplementa nada: `FiscalCertificateService` já lê o .pfx, valida a
 * janela de validade, confere o CNPJ e testa a assinatura, e
 * `FiscalSecretVault` cifra o arquivo. Aqui só se calcula o que a tela precisa
 * mostrar — situação, dias restantes — e se garante que nada sensível saia.
 *
 * O QUE NUNCA SAI DAQUI: o arquivo .pfx, a chave privada e a senha. A senha
 * não é sequer guardada; ela é pedida a cada operação que precise assinar.
 * Quem devolve o objeto para o cliente é `sanitizeCertificateForResponse`, que
 * já omite `encryptedPfx`.
 */
import { ApiError } from '../../utils/errors.js';
import { findRows, updateRows } from '../../db/database.js';
import { sanitizeCertificateForResponse } from '../fiscal/FiscalCertificateService.js';

/** Quando a SITUAÇÃO passa a ser "próximo do vencimento". */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * AS FAIXAS DO AVISO PROATIVO — GAP-V40.
 *
 * O cálculo dos dias e a frase de renovação existiam; o que faltava era
 * ALCANCE. A frase só aparecia para quem abrisse a tela do certificado da
 * operação certa, e com seis empresas isso significa não avisar ninguém.
 *
 * O aviso aqui é ESTADO DERIVADO: uma função de `validTo` e do relógio. Não há
 * fila, não há tabela de "avisos enviados" e não há dedupe para manter — e não
 * há por um motivo prático, não por preguiça: este servidor desliga à noite e
 * não tem agendador, então uma fila produziria a pergunta "por que o aviso de
 * 30 dias não saiu?", que estado derivado não sabe responder porque não pode
 * falhar. Quem abre o painel vê a faixa de hoje, sempre.
 *
 * A faixa é a MENOR que ainda cabe: faltando 23 dias, a faixa é a de 30. A
 * frase, porém, carrega o número REAL — "A1 vence em 23 dia(s)" —, porque quem
 * lê precisa saber quanto tempo tem, não em que gaveta caiu.
 */
export const FAIXAS_DE_AVISO = [90, 60, 30, 15, 7] as const;

/** A faixa atual. `0` é o vencido, que não é aviso: é bloqueio. */
export type ExpiryBand = (typeof FAIXAS_DE_AVISO)[number] | 0;

export interface CertificateAlert {
  band: ExpiryBand;
  /** Dias restantes de verdade. Negativo quando já venceu. */
  days: number;
  severity: 'info' | 'warning' | 'danger';
  /** Frase pronta para banner — curta, sem dado do titular. */
  message: string;
}

export type CertificateSituation =
  | 'nao_configurado'
  | 'valido'
  | 'proximo_do_vencimento'
  | 'vencido';

export interface CertificateView {
  configured: boolean;
  situation: CertificateSituation;
  /** Frase pronta para a tela, já no tom de quem precisa agir. */
  message: string;
  /**
   * Estado honesto da emissão fiscal. Sem certificado real carregado e sem
   * teste contra a SEFAZ, isto NUNCA é `HOMOLOGATED`.
   */
  readiness: 'READY_FOR_CERTIFICATE' | 'CERTIFICATE_LOADED';
  daysRemaining: number | null;
  /**
   * O aviso proativo, ou `null` quando ainda há folga.
   *
   * Campo NOVO ao lado de `situation`, e não um valor a mais nela: acrescentar
   * estado a um enum antigo quebra em silêncio todo `switch` que já existe
   * sobre ele — a casa já pagou esse preço uma vez.
   */
  alerta: CertificateAlert | null;
  certificate: Record<string, unknown> | null;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

const SEVERIDADE: Record<ExpiryBand, CertificateAlert['severity']> = {
  90: 'info',
  60: 'info',
  30: 'warning',
  15: 'warning',
  7: 'danger',
  0: 'danger',
};

/** A faixa de hoje, ou `null` quando o vencimento ainda está longe. */
export function faixaDoVencimento(days: number | null): ExpiryBand | null {
  if (days === null) return null;
  if (days < 0) return 0;
  const faixa = [...FAIXAS_DE_AVISO].reverse().find((f) => days <= f);
  return faixa ?? null;
}

function alertaDe(days: number | null): CertificateAlert | null {
  const band = faixaDoVencimento(days);
  if (band === null || days === null) return null;
  return {
    band,
    days,
    severity: SEVERIDADE[band],
    message:
      band === 0
        ? `Certificado A1 VENCIDO há ${Math.abs(days)} dia(s) — a emissão de nota está bloqueada.`
        : `A1 vence em ${days} dia(s).${band <= 30 ? ' Providencie a renovação.' : ''}`,
  };
}

function situationOf(validTo: string | null | undefined, now: Date): {
  situation: CertificateSituation;
  days: number | null;
} {
  if (!validTo) return { situation: 'nao_configurado', days: null };
  const days = daysBetween(now, new Date(validTo));
  if (days < 0) return { situation: 'vencido', days };
  if (days <= EXPIRY_WARNING_DAYS) return { situation: 'proximo_do_vencimento', days };
  return { situation: 'valido', days };
}

const MESSAGE: Record<CertificateSituation, (days: number | null) => string> = {
  nao_configurado: () =>
    'Nenhum certificado carregado nesta operação. Sem ele, nota fiscal não é emitida.',
  valido: (d) => `Certificado válido. Vence em ${d} dia(s).`,
  proximo_do_vencimento: (d) =>
    `Certificado vence em ${d} dia(s). Providencie a renovação antes disso — a emissão para no dia do vencimento.`,
  vencido: (d) =>
    `Certificado VENCIDO há ${Math.abs(d ?? 0)} dia(s). A emissão de nota está bloqueada até a substituição.`,
};

function certificateRow(
  companyId: string,
  operationalUnitId: string,
): Record<string, unknown> | undefined {
  const rows = findRows<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === companyId && r.operationalUnitId === operationalUnitId,
  );
  return rows[0];
}

/** O que a tela de Configurações › Fiscal mostra para uma operação. */
export function getCertificateView(
  companyId: string,
  operationalUnitId = 'unit-default',
  now = new Date(),
): CertificateView {
  const row = certificateRow(companyId, operationalUnitId);

  if (!row || row.status === 'revoked') {
    return {
      configured: false,
      situation: 'nao_configurado',
      message: MESSAGE.nao_configurado(null),
      readiness: 'READY_FOR_CERTIFICATE',
      daysRemaining: null,
      alerta: null,
      certificate: null,
    };
  }

  const { situation, days } = situationOf(row.validTo as string | undefined, now);

  return {
    configured: true,
    situation,
    message: MESSAGE[situation](days),
    // Certificado carregado ainda não é homologação: falta o teste real
    // contra a SEFAZ, que depende de credenciais e ambiente do usuário.
    readiness: 'CERTIFICATE_LOADED',
    daysRemaining: days,
    alerta: alertaDe(days),
    certificate: sanitizeCertificateForResponse(row),
  };
}

/**
 * OS CERTIFICADOS DO GRUPO, LADO A LADO — GAP-V41.
 *
 * Conferir a situação dos seis A1 exigia trocar de operação seis vezes, e a
 * troca recarrega a página inteira: na prática ninguém conferia, e o
 * vencimento chegava sem aviso.
 *
 * QUEM ENTRA NA LISTA NÃO É DECIDIDO AQUI, e isso é deliberado. Esta função
 * recebe as empresas já resolvidas por quem chamou — que as resolve por
 * `core_user_companies`, a mesma régua de `GET /core/companies`: perfil não
 * atravessa empresa, VÍNCULO atravessa. Um `admin_geral` da Conceito é
 * administrador DA CONCEITO, e a Gringa só aparece para ele se houver uma
 * linha dizendo isso.
 *
 * A lista NÃO carrega segredo: cada item é o recorte já sanitizado por
 * `sanitizeCertificateForResponse`, mais o nome da empresa.
 */
export interface GroupCertificateItem {
  companyId: string;
  slug: string;
  tradeName: string;
  legalName: string;
  configured: boolean;
  situation: CertificateSituation;
  message: string;
  daysRemaining: number | null;
  alerta: CertificateAlert | null;
  holderName: string | null;
  documentNumber: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** A senha está selada no cofre? Booleano, nunca a senha. */
  senhaGuardada: boolean;
}

export function listGroupCertificates(
  companies: { id: string; slug: string; trade_name: string; legal_name: string }[],
  now = new Date(),
): GroupCertificateItem[] {
  return companies.map((c) => {
    const view = getCertificateView(c.id, 'unit-default', now);
    const cert = view.certificate;
    const texto = (chave: string): string | null => {
      const v = cert?.[chave];
      return v == null ? null : String(v);
    };
    return {
      companyId: c.id,
      slug: c.slug,
      tradeName: c.trade_name,
      legalName: c.legal_name,
      configured: view.configured,
      situation: view.situation,
      message: view.message,
      daysRemaining: view.daysRemaining,
      alerta: view.alerta,
      /*
        `holderName` só existe em registro gravado a partir da autodetecção.
        Para os anteriores, o CN cru (`subject`) é o que há — melhor mostrar o
        nome com o CNPJ colado do que uma linha vazia que parece defeito.
      */
      holderName: texto('holderName') ?? texto('subject'),
      documentNumber: texto('documentNumber') ?? texto('cnpj'),
      issuer: texto('issuer'),
      validFrom: texto('validFrom'),
      validTo: texto('validTo'),
      senhaGuardada: cert?.senhaGuardada === true,
    };
  });
}

/**
 * Desativa o certificado da operação.
 *
 * Não apaga a linha: marca como revogada. O histórico de qual certificado
 * assinou quais notas precisa continuar existindo — apagar deixaria documentos
 * fiscais sem rastro de quem os assinou.
 */
export function revokeCertificate(input: {
  companyId: string;
  operationalUnitId?: string;
  reason: string;
}): CertificateView {
  const unit = input.operationalUnitId ?? 'unit-default';
  const row = certificateRow(input.companyId, unit);
  if (!row) {
    throw new ApiError(
      'FISCAL_CERTIFICATE_NOT_FOUND',
      'Nenhum certificado configurado nesta operação.',
      404,
    );
  }
  if (!input.reason?.trim()) {
    throw new ApiError(
      'FISCAL_CERTIFICATE_REASON_REQUIRED',
      'Informe o motivo da desativação.',
      400,
    );
  }

  updateRows(
    'fiscal_certificate_references',
    (r) => r.id === row.id,
    (r) => ({
      ...r,
      status: 'revoked',
      /*
        O ARQUIVO E A SENHA saem do registro: desativado é desativado
        (GAP-PRD-179). Só o `.pfx` saía, e a senha selada ficava — decifrável
        por quem tivesse a chave do cofre, depois de o dono ter "desativado" o
        certificado justamente por desconfiar dele. Metade do segredo apagada
        é segredo guardado. O que fica é o que qualquer um lê no certificado
        (titular, série, validade, impressão digital): o rastro de quem
        assinou as notas anteriores.
      */
      encryptedPfx: undefined,
      encryptedPassword: undefined,
      revokedAt: new Date().toISOString(),
      revokeReason: input.reason,
    }),
  );

  return getCertificateView(input.companyId, unit);
}
