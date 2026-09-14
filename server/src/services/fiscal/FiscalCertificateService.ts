import forge from 'node-forge';
import { createSign, createVerify } from 'node:crypto';
import { findOneRow, insertRow, updateRows } from '../../db/database.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';
import { decryptFiscalSecret, encryptFiscalSecret } from './FiscalSecretVault.js';

export interface ParsedCertificateA1 {
  subject: string;
  issuer: string;
  cnpj: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  /**
   * O nome do titular SEM o documento que o padrão ICP-Brasil cola no CN.
   *
   * O CN de um e-CNPJ é "EMPRESA LTDA:11222333000181". Quem lê a tela quer o
   * nome da empresa; o número tem campo próprio logo abaixo. Mostrar os dois
   * grudados é mostrar um dado cru e chamar isso de informação.
   */
  holderName: string;
  /** O que o arquivo informou: um e-CNPJ, um e-CPF, ou nada reconhecível. */
  documentType: 'CNPJ' | 'CPF' | null;
  /** Só os dígitos do documento do titular. */
  documentNumber: string;
  /** O DN inteiro do titular, não só o CN. */
  subjectDn: string;
  /** O DN inteiro de quem emitiu — a autoridade certificadora. */
  issuerDn: string;
  /**
   * SHA-256 do certificado (DER), em pares hexadecimais.
   *
   * É a identidade do ARQUIVO. Serve para o dono confirmar que o que está no
   * servidor é o mesmo que ele tem em mãos, e para a trilha registrar QUAL
   * arquivo entrou sem guardar nada do arquivo.
   */
  fingerprintSha256: string;
  /**
   * Quantos certificados vieram no .pfx. 1 = só a folha, sem as autoridades —
   * a SEFAZ pode recusar o handshake por mais certo que o nosso lado esteja.
   */
  chainLength: number;
  /** Emissor igual ao titular: é fixture, e a SEFAZ não aceita. */
  selfSigned: boolean;
  /** SÓ a folha — o certificado de quem assina o XML fiscal. */
  certPem: string;
  /**
   * A cadeia inteira do .pfx, folha primeiro: é o que vai no TLS mútuo com a
   * SEFAZ. Sem as autoridades, o fisco não consegue encadear o certificado
   * até uma raiz confiável e recusa a conexão (rodada 59).
   */
  chainPem: string;
  keyPem: string;
}

function extractCnpj(subjectCn: string): string {
  const match = subjectCn.match(/\d{14}/);
  return match?.[0] ?? '';
}

/** "12.345.678/0001-99" a partir dos dígitos; devolve o que veio se não couber. */
export function formatarCnpj(digitos: string): string {
  const so = (digitos ?? '').replace(/\D/g, '');
  if (so.length !== 14) return digitos || '—';
  return so.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** O DN inteiro, no formato que uma pessoa lê: `CN=..., O=..., C=BR`. */
function dnDe(campo: forge.pki.Certificate['subject']): string {
  return campo.attributes
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value ?? '')}`)
    .join(', ');
}

/**
 * QUEM É O TITULAR, SEGUNDO O PRÓPRIO ARQUIVO.
 *
 * A ordem de procura NÃO é arbitrária, e trocá-la produz o pior erro possível
 * — atribuir à empresa o documento de outra pessoa:
 *
 *   1. o CN. No perfil e-CNPJ da ICP-Brasil ele é "RAZÃO SOCIAL:CNPJ", e é o
 *      lugar canônico do CNPJ do titular;
 *   2. o resto do DN, para os arquivos que põem o CNPJ noutro atributo;
 *   3. o atributo `serialNumber` (OID 2.5.4.5) — POR ÚLTIMO de propósito. Num
 *      e-CNPJ ele costuma carregar o CPF do RESPONSÁVEL pela empresa, não o
 *      CNPJ dela. Consultá-lo primeiro faria o sistema anunciar o CPF de uma
 *      pessoa como se fosse o documento da empresa, e a conferência do CNPJ
 *      passaria a recusar todo certificado legítimo;
 *   4. e só então um CPF de 11 dígitos, que é o caso do e-CPF.
 */
function documentoDoTitular(cert: forge.pki.Certificate, cn: string, dn: string): {
  documentType: 'CNPJ' | 'CPF' | null;
  documentNumber: string;
} {
  const cnpj = extractCnpj(cn) || extractCnpj(dn);
  if (cnpj) return { documentType: 'CNPJ', documentNumber: cnpj };

  const serial = String(cert.subject.getField({ name: 'serialNumber' })?.value ?? '')
    .replace(/\D/g, '');
  if (serial.length === 14) return { documentType: 'CNPJ', documentNumber: serial };
  if (serial.length === 11) return { documentType: 'CPF', documentNumber: serial };

  const cpf = (cn.match(/(?<!\d)\d{11}(?!\d)/) ?? dn.match(/(?<!\d)\d{11}(?!\d)/))?.[0] ?? '';
  if (cpf) return { documentType: 'CPF', documentNumber: cpf };

  return { documentType: null, documentNumber: '' };
}

/** O nome do titular sem o `:documento` que o padrão gruda no fim do CN. */
function nomeDoTitular(cn: string, documento: string): string {
  const limpo = documento
    ? cn.replace(new RegExp(`\\s*:?\\s*${documento}\\s*$`), '')
    : cn;
  return limpo.trim() || cn;
}

// ------------------------------------------------------- conferência do CNPJ

/**
 * O veredito da conferência entre o CNPJ do arquivo e o da empresa.
 *
 *   - `conferido`      — os catorze dígitos batem;
 *   - `raiz`           — mesma RAIZ, estabelecimento diferente (aceito, com aviso);
 *   - `sem_referencia` — não havia com o que comparar (aceito, declarado).
 *
 * Raiz diferente não tem valor aqui: ela LEVANTA, não devolve.
 */
export type CnpjConference = 'conferido' | 'raiz' | 'sem_referencia';

export interface ResultadoDaConferencia {
  status: CnpjConference;
  /** O que a tela precisa mostrar quando o veredito não é o limpo. */
  warning: string | null;
}

/**
 * A RÉGUA: a RAIZ do CNPJ, oito dígitos.
 *
 * Não é leniência nossa — é a régua do fisco. A SEFAZ compara a BASE do CNPJ
 * do certificado com a do emitente, e por isso o A1 da matriz assina
 * legitimamente pela filial. Exigir os catorze dígitos faria este sistema ser
 * mais severo que a SEFAZ e recusar uma carga que o fisco aceitaria — a pior
 * forma de erro, porque não há a quem recorrer.
 *
 * O que a raiz igual com sufixo diferente NÃO é é silêncio: carregar o A1 da
 * matriz numa filial é uma escolha, e a tela mostra o aviso com os dois
 * números.
 */
export function conferirCnpjDoCertificado(input: {
  documentType: 'CNPJ' | 'CPF' | null;
  documentNumber: string;
  esperado: string | null | undefined;
}): ResultadoDaConferencia {
  const esperado = (input.esperado ?? '').replace(/\D/g, '');

  if (input.documentType === 'CPF') {
    return {
      status: 'sem_referencia',
      warning:
        'Este certificado é de PESSOA FÍSICA (e-CPF): não há CNPJ no arquivo para conferir '
        + 'contra o do emitente. Confirme com a sua contabilidade se a UF aceita e-CPF para '
        + 'a emissão desta operação.',
    };
  }

  if (!input.documentNumber) {
    return {
      status: 'sem_referencia',
      warning:
        'O arquivo não informa um CNPJ reconhecível: o certificado foi aceito sem conferência.',
    };
  }
  if (esperado.length !== 14) {
    return {
      status: 'sem_referencia',
      warning:
        'O CNPJ do emitente não está configurado nesta operação, então o do certificado não foi '
        + `conferido. O arquivo é de ${formatarCnpj(input.documentNumber)} — preencha o CNPJ em `
        + 'Fiscal › Configuração para que a conferência passe a valer.',
    };
  }

  if (input.documentNumber === esperado) return { status: 'conferido', warning: null };

  if (input.documentNumber.slice(0, 8) === esperado.slice(0, 8)) {
    return {
      status: 'raiz',
      warning:
        `O certificado é de ${formatarCnpj(input.documentNumber)} e esta operação emite como `
        + `${formatarCnpj(esperado)}: mesma raiz de CNPJ, estabelecimento diferente. A SEFAZ `
        + 'aceita (ela compara a raiz), e o arquivo foi guardado — confira se é mesmo o A1 da '
        + 'matriz que você quer usar aqui.',
    };
  }

  throw new ApiError(
    'FISCAL_CERTIFICATE_CNPJ_MISMATCH',
    'CNPJ do certificado não corresponde à empresa selecionada. '
      + `O arquivo é de ${formatarCnpj(input.documentNumber)} e esta operação emite como `
      + `${formatarCnpj(esperado)}. Nada foi gravado.`,
    400,
  );
}

/**
 * O CNPJ que o próprio sistema já conhece do emitente.
 *
 * A leitura é uma coluna, direto na tabela, e NÃO `getFiscalConfig`: aquele
 * módulo importa `CertificateStatusService`, que importa este — o ciclo
 * funcionaria, mas deixaria a ordem de carga de dois módulos fiscais dependendo
 * de quem for importado primeiro. Uma coluna lida aqui não duplica regra
 * nenhuma; duplicar o ciclo, sim, seria duplicar risco.
 */
function cnpjDoEmitenteConfigurado(companyId: string): string {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT cnpj FROM core_fiscal_configs WHERE company_id = ?')
    .get(companyId) as { cnpj?: string | null } | undefined;
  return String(row?.cnpj ?? '').replace(/\D/g, '');
}

export function parseCertificateA1(pfxBase64: string, password: string): ParsedCertificateA1 {
  if (!pfxBase64?.trim()) {
    throw new ApiError('FISCAL_CERTIFICATE_NOT_FOUND', 'Arquivo de certificado ausente.', 400);
  }
  let pfxDer: forge.util.ByteStringBuffer;
  try {
    pfxDer = forge.util.createBuffer(forge.util.decode64(pfxBase64));
  } catch {
    throw new ApiError('FISCAL_CERTIFICATE_INVALID', 'Arquivo .pfx inválido ou corrompido.', 400);
  }

  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(pfxDer);
  } catch {
    throw new ApiError('FISCAL_CERTIFICATE_INVALID', 'Arquivo .pfx não é DER/ASN.1 válido.', 400);
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password ?? '');
  } catch {
    throw new ApiError('FISCAL_CERTIFICATE_PASSWORD_INVALID', 'Senha do certificado incorreta.', 400);
  }

  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })?.[forge.pki.oids.pkcs8ShroudedKeyBag];
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })?.[forge.pki.oids.certBag];
  if (!keyBag?.[0]?.key || !certBag?.[0]?.cert) {
    throw new ApiError('FISCAL_CERTIFICATE_INVALID', 'Não foi possível extrair chave/certificado do .pfx.', 400);
  }

  const cert = certBag[0].cert;
  const subjectCn = cert.subject.getField('CN')?.value ?? 'Desconhecido';
  const issuerCn = cert.issuer.getField('CN')?.value ?? 'Desconhecido';

  /*
    A CADEIA, QUE ERA JOGADA FORA (rodada 59).

    Um .pfx da ICP-Brasil carrega o certificado da empresa MAIS as autoridades
    que provam que ele é legítimo até a raiz. Só a folha (`certBag[0]`) era
    lida, e o resto se perdia — então no TLS mútuo a SEFAZ recebia um
    certificado órfão: sabia quem o dono dizia ser, e não tinha como
    verificar. O handshake morria antes de qualquer XML, e o dono lia que "a
    comunicação não foi permitida".

    Ordem importa: a folha PRIMEIRO, as autoridades depois — é o que o
    protocolo exige de quem apresenta o certificado.
  */
  const chainPem = certBag
    .map((bag) => bag.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c))
    .map((c) => forge.pki.certificateToPem(c).trim())
    .join('\n');

  /*
    O QUE O ARQUIVO INFORMA, EXTRAÍDO NA ENTRADA — a regra mestre desta rodada.

    Tudo abaixo estava dentro do `.pfx` desde sempre e era jogado fora; a tela
    pedia "CNPJ esperado" para conferir um número que o próprio arquivo
    carrega. Se o sistema descobre, ele não pergunta.
  */
  const subjectDn = dnDe(cert.subject);
  const issuerDn = dnDe(cert.issuer);
  const { documentType, documentNumber } = documentoDoTitular(cert, subjectCn, subjectDn);

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const digest = forge.md.sha256.create();
  digest.update(der);
  const fingerprintSha256 = (digest.digest().toHex().toUpperCase().match(/../g) ?? []).join(':');

  return {
    subject: subjectCn,
    issuer: issuerCn,
    cnpj: documentType === 'CNPJ' ? documentNumber : '',
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    holderName: nomeDoTitular(subjectCn, documentNumber),
    documentType,
    documentNumber,
    subjectDn,
    issuerDn,
    fingerprintSha256,
    chainLength: (chainPem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length,
    selfSigned: Boolean(subjectDn) && subjectDn === issuerDn,
    /*
      `certPem` continua sendo SÓ A FOLHA, de propósito: é ele que vai no
      <X509Certificate> da assinatura do XML fiscal, que leva o certificado de
      quem assinou — um só. Colocar a cadeia ali faria a SEFAZ rejeitar o
      documento. São duas perguntas diferentes: "quem assinou" (certPem) e
      "por que confiar nele" (chainPem).
    */
    certPem: forge.pki.certificateToPem(cert),
    chainPem,
    keyPem: forge.pki.privateKeyToPem(keyBag[0].key),
  };
}

export function validateCertificateWindow(parsed: ParsedCertificateA1): { valid: boolean; reason?: string } {
  const now = Date.now();
  if (now > new Date(parsed.validTo).getTime()) {
    return { valid: false, reason: 'Certificado vencido.' };
  }
  if (now < new Date(parsed.validFrom).getTime()) {
    return { valid: false, reason: 'Certificado ainda não é válido.' };
  }
  return { valid: true };
}

export function testCertificateSignature(parsed: ParsedCertificateA1): boolean {
  const payload = 'DEVORA-NFE-HOMOLOGATION-SIGNATURE-TEST';
  const signer = createSign('RSA-SHA256');
  signer.update(payload);
  const signature = signer.sign(parsed.keyPem);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(payload);
  return verifier.verify(parsed.certPem, signature);
}

/** Quantas trocas o registro lembra. O resto está na auditoria. */
const LIMITE_DO_HISTORICO = 20;

/**
 * O certificado que sai de cena, sem nada de segredo (GAP-PRD-179).
 *
 * Lista FECHADA de campos, e não "tudo menos os cifrados": um campo novo com
 * segredo, acrescentado um dia ao registro, não pode vazar para cá por omissão.
 */
function resumoParaOHistorico(
  anterior: Record<string, unknown>,
  substituidoEm: string,
): Record<string, unknown> {
  const texto = (chave: string): string | null => {
    const v = anterior[chave];
    return v == null ? null : String(v);
  };
  return {
    status: texto('status'),
    subject: texto('subject'),
    holderName: texto('holderName'),
    documentNumber: texto('documentNumber') ?? texto('cnpj'),
    issuer: texto('issuer'),
    serialNumber: texto('serialNumber'),
    fingerprintSha256: texto('fingerprintSha256'),
    validFrom: texto('validFrom'),
    validTo: texto('validTo'),
    revokedAt: texto('revokedAt'),
    revokeReason: texto('revokeReason'),
    replacedAt: substituidoEm,
  };
}

export function upsertCertificateA1(input: {
  companyId: string;
  operationalUnitId: string;
  pfxBase64: string;
  password: string;
  expectedCnpj?: string;
}): Record<string, unknown> {
  const parsed = parseCertificateA1(input.pfxBase64, input.password);
  const window = validateCertificateWindow(parsed);
  if (!window.valid) {
    throw new ApiError('FISCAL_CERTIFICATE_EXPIRED', window.reason ?? 'Certificado inválido.', 400);
  }

  /*
    A CONFERÊNCIA DO CNPJ DEIXOU DE SER OPCIONAL (GAP-V39).

    Ela só acontecia quando quem chamava mandava `expectedCnpj` — e o campo na
    tela é opcional, então o caminho normal era não mandar nada. Resultado: o
    A1 de outra empresa subia calado, e o desmentido chegava na rejeição da
    SEFAZ, com a venda feita.

    O CNPJ do emitente já existe em `core_fiscal_configs` e é a referência
    natural: o sistema sabe por quem esta operação emite. `expectedCnpj`
    continua existindo como OVERRIDE explícito — quem o informa está afirmando
    contra qual número quer conferir, e essa afirmação ganha do cadastro.
  */
  const conferencia = conferirCnpjDoCertificado({
    documentType: parsed.documentType,
    documentNumber: parsed.documentNumber,
    esperado: input.expectedCnpj ?? cnpjDoEmitenteConfigurado(input.companyId),
  });

  if (!testCertificateSignature(parsed)) {
    throw new ApiError('FISCAL_CERTIFICATE_SIGNATURE_FAILED', 'Falha ao validar assinatura do certificado.', 400);
  }

  const encryptedPfx = encryptFiscalSecret(input.pfxBase64);
  /*
    A SENHA VAI PARA O MESMO COFRE DO ARQUIVO.

    Ela era exigida em toda chamada, e o desenho explicava a intenção: "a senha
    não fica guardada, então todo ato fiscal real tem alguém presente". Isso
    serve para um ato por dia; para o PDV, não — emitir cupom é o gesto mais
    repetido da loja, e pedir a senha a cada venda produz um de dois desfechos,
    ambos piores que guardá-la: ninguém emite nota, ou a senha vira um papel
    colado no monitor.

    Mesmo primitivo do `.pfx`, do token do CSC e da chave do Asaas. Não há
    cofre novo, porque haveria dois lugares para proteger.
  */
  const encryptedPassword = encryptFiscalSecret(input.password);
  const existing = findOneRow<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === input.companyId && r.operationalUnitId === input.operationalUnitId,
  );

  const row = {
    companyId: input.companyId,
    operationalUnitId: input.operationalUnitId,
    type: 'A1',
    subject: parsed.subject,
    issuer: parsed.issuer,
    cnpj: parsed.cnpj,
    serialNumber: parsed.serialNumber,
    validFrom: parsed.validFrom,
    validTo: parsed.validTo,
    status: 'valid',
    // O que o arquivo informou, guardado JUNTO: a tela lê o cartão do
    // certificado sem reabrir o `.pfx` — e reabrir exigiria a senha.
    holderName: parsed.holderName,
    documentType: parsed.documentType,
    documentNumber: parsed.documentNumber,
    subjectDn: parsed.subjectDn,
    issuerDn: parsed.issuerDn,
    fingerprintSha256: parsed.fingerprintSha256,
    chainLength: parsed.chainLength,
    selfSigned: parsed.selfSigned,
    cnpjConference: conferencia.status,
    cnpjConferenceWarning: conferencia.warning,
    secretReference: `vault:a1:${input.operationalUnitId}`,
    encryptedPfx,
    encryptedPassword,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    /*
      A TROCA NÃO MISTURA HISTÓRIA (GAP-PRD-179).

      Era `{ ...r, ...row }`: o registro voltava a `valid` carregando o
      `revokedAt` e o `revokeReason` do certificado ANTERIOR — um válido com
      carimbo de revogado. Os carimbos saem do topo, e o que havia antes
      (revogado ou não) vai para `historico`, só com o que qualquer um lê no
      certificado: série, impressão digital, validade, e o motivo quando foi
      revogado. Nada de segredo — o histórico existe para dizer QUAL arquivo
      assinou as notas de antes, não para guardá-lo.
    */
    const historico = [
      resumoParaOHistorico(existing, row.updatedAt),
      ...(Array.isArray(existing.historico) ? (existing.historico as unknown[]) : []),
    ].slice(0, LIMITE_DO_HISTORICO);
    updateRows('fiscal_certificate_references', (r) => r.id === existing.id, (r) => ({
      ...r,
      ...row,
      revokedAt: undefined,
      revokeReason: undefined,
      historico,
    }));
    return findOneRow('fiscal_certificate_references', (r) => r.id === existing.id) as Record<string, unknown>;
  }

  return insertRow('fiscal_certificate_references', {
    id: `fisc-cert-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...row,
  });
}

export function getCertificateA1(
  companyId: string,
  operationalUnitId: string,
  /**
   * A senha, quando quem chama a tem em mãos (o caminho interativo).
   *
   * Omitida, vale a que foi selada na configuração — é assim que o PDV emite
   * sem parar a fila para pedir senha. Informada ERRADA continua sendo
   * recusada: quem informa está afirmando qual é, e aceitar a guardada no
   * lugar esconderia do operador que ele digitou errado.
   */
  password?: string,
): ParsedCertificateA1 {
  const ref = findOneRow<Record<string, unknown>>(
    'fiscal_certificate_references',
    (r) => r.companyId === companyId && r.operationalUnitId === operationalUnitId,
  );
  if (!ref?.encryptedPfx) {
    throw new ApiError('FISCAL_CERTIFICATE_NOT_FOUND', 'Certificado não configurado no backend.', 404);
  }
  const pfxBase64 = decryptFiscalSecret(String(ref.encryptedPfx));

  const senha = password ?? (ref.encryptedPassword
    ? decryptFiscalSecret(String(ref.encryptedPassword))
    : null);
  if (!senha) {
    throw new ApiError(
      'FISCAL_CERTIFICATE_PASSWORD_REQUIRED',
      'Este certificado foi cadastrado antes de a senha passar a ser guardada. '
        + 'Reenvie o arquivo com a senha em Fiscal › Certificado para que a emissão '
        + 'deixe de pedi-la a cada venda.',
      400,
    );
  }
  const parsed = parseCertificateA1(pfxBase64, senha);
  const window = validateCertificateWindow(parsed);
  if (!window.valid) {
    throw new ApiError('FISCAL_CERTIFICATE_EXPIRED', window.reason ?? 'Certificado inválido.', 400);
  }
  return parsed;
}

export function sanitizeCertificateForResponse(row: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog({
    id: row.id,
    companyId: row.companyId,
    operationalUnitId: row.operationalUnitId,
    type: row.type,
    subject: row.subject,
    issuer: row.issuer,
    cnpj: row.cnpj,
    serialNumber: row.serialNumber,
    validFrom: row.validFrom,
    validTo: row.validTo,
    status: row.status,
    /*
      O CARTÃO "CERTIFICADO VALIDADO" — tudo o que o arquivo informou.

      Nenhum destes campos é segredo: são o que qualquer um lê abrindo o
      certificado, e é exatamente por isso que o sistema não deve pedi-los a
      quem já mandou o arquivo. O segredo (o `.pfx`, a chave e a senha)
      continua fora daqui, como sempre esteve.

      `?? null` em vez de deixar sumir: um registro gravado antes desta rodada
      não tem estes campos, e a tela precisa distinguir "não sabemos" de
      "vazio". Reenviar o arquivo preenche todos.
    */
    holderName: row.holderName ?? null,
    documentType: row.documentType ?? null,
    documentNumber: row.documentNumber ?? null,
    subjectDn: row.subjectDn ?? null,
    issuerDn: row.issuerDn ?? null,
    fingerprintSha256: row.fingerprintSha256 ?? null,
    chainLength: row.chainLength ?? null,
    selfSigned: row.selfSigned ?? null,
    cnpjConference: row.cnpjConference ?? null,
    cnpjConferenceWarning: row.cnpjConferenceWarning ?? null,
    hasSecret: Boolean(row.encryptedPfx),
    /*
      A tela precisa saber que a senha está guardada, para não pedir de novo.

      O nome NÃO carrega "password" de propósito: `sanitizeForLog` apaga todo
      campo cujo nome cheira a segredo, e apagaria este — que é um booleano,
      não o segredo. O redator está certo; o nome é que precisava mudar.
    */
    senhaGuardada: Boolean(row.encryptedPassword),
    secretReference: row.secretReference,
  }) as Record<string, unknown>;
}
