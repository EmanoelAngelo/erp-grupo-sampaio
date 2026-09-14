/**
 * ============================================================================
 * O CERTIFICADO ESTÁ PRONTO PARA EMITIR?
 * ============================================================================
 *
 * Roda DEPOIS de o dono reenviar o `.pfx` com a senha em **Fiscal ›
 * Certificado**. Responde, sem imprimir nada do conteúdo:
 *
 *     A1 PFX             SEALED_CURRENT_KEY | LEGACY_KEY | ABSENT
 *     A1 PASSWORD        PRESENT | ABSENT
 *     CERTIFICATE VALID  YES | NO
 *     COMPANY            a razão social da empresa dona
 *
 * ## Por que a senha é um item separado
 *
 * O `.pfx` sozinho não emite nada — é um arquivo cifrado. Enquanto a senha não
 * estiver no cofre, a emissão a pediria a cada venda, com o cliente no balcão.
 *
 * E é a senha ausente que hoje separa este sistema do teste real com a SEFAZ:
 * o `.pfx` sobreviveu à rotação da chave (byte a byte idêntico, conferido por
 * sha256), mas ninguém consegue abri-lo sem ela.
 *
 * ## O que ele NÃO faz
 *
 * Não transmite nada à SEFAZ. Abrir o certificado e conferir a validade é
 * trabalho local; `statusServico` é chamada de rede, e essa é decisão do dono.
 * O comando termina dizendo se ela está liberada — não a executa.
 */
import { findRows } from '../db/database.js';
import { getConnection } from '../db/sqlite.js';
import { ensureCoreSchema } from '../db/schema.js';
import { prontidaoDosSegredos } from '../db/secretsReadiness.js';
import {
  getCertificateA1,
  testCertificateSignature,
  validateCertificateWindow,
} from '../services/fiscal/FiscalCertificateService.js';

interface ReferenciaDeCertificado extends Record<string, unknown> {
  id: string;
  companyId: string;
  operationalUnitId: string;
  subject?: string;
  encryptedPassword?: string;
}

function razaoSocialDe(companyId: string): string {
  try {
    ensureCoreSchema();
    const linha = getConnection()
      .prepare('SELECT trade_name, legal_name FROM core_companies WHERE id = ?')
      .get(companyId) as { trade_name?: string; legal_name?: string } | undefined;
    return linha?.trade_name || linha?.legal_name || '(empresa não encontrada)';
  } catch {
    return '(não consegui ler)';
  }
}

function main(): number {
  const p = prontidaoDosSegredos();

  console.log('=== O COFRE ===');
  console.log('  DEVORA_ENCRYPTION_KEY : ' + p.encryptionKey);
  console.log('  A1 PFX                : ' + p.a1Pfx);
  console.log('  A1 PASSWORD           : ' + (p.a1Password === 'ABSENT' ? 'ABSENT' : 'PRESENT'));

  if (p.a1Pfx === 'ABSENT') {
    console.log('');
    console.log('Não há certificado cadastrado. Envie o `.pfx` em Fiscal › Certificado.');
    return 1;
  }
  if (p.a1Pfx === 'LEGACY_KEY') {
    console.log('');
    console.log('O certificado está selado com OUTRA chave e não abre com a atual.');
    console.log('Rode `node dist/scripts/rotacionar-chave.js --ensaio` para ver a situação.');
    return 1;
  }

  const refs = findRows<ReferenciaDeCertificado>(
    'fiscal_certificate_references' as never,
    () => true,
  );

  console.log('');
  console.log('=== OS CERTIFICADOS CADASTRADOS ===');
  let prontos = 0;

  for (const ref of refs) {
    const empresa = razaoSocialDe(ref.companyId);
    console.log('');
    console.log('  COMPANY           : ' + empresa);
    console.log('  unidade           : ' + ref.operationalUnitId);

    if (!ref.encryptedPassword) {
      console.log('  A1 PASSWORD       : ABSENT');
      console.log('  CERTIFICATE VALID : NÃO SEI — sem a senha, o arquivo não abre');
      console.log('');
      console.log('  AÇÃO: reenvie o MESMO `.pfx` com a senha em Fiscal › Certificado.');
      continue;
    }

    console.log('  A1 PASSWORD       : PRESENT');

    try {
      // Sem senha por parâmetro: usa a que está no cofre, que é o caminho que
      // a emissão de verdade percorre.
      const parsed = getCertificateA1(ref.companyId, ref.operationalUnitId);
      const janela = validateCertificateWindow(parsed);
      const assina = testCertificateSignature(parsed);

      console.log('  titular           : ' + parsed.subject);
      console.log('  emissor           : ' + parsed.issuer);
      console.log('  CNPJ              : ' + parsed.cnpj);
      console.log('  válido de         : ' + parsed.validFrom.slice(0, 10));
      console.log('  válido até        : ' + parsed.validTo.slice(0, 10));
      console.log('  CERTIFICATE VALID : ' + (janela.valid ? 'YES' : 'NO — ' + (janela.reason ?? '')));
      console.log('  assina de verdade : ' + (assina ? 'SIM' : 'NÃO'));
      /*
        A cadeia importa tanto quanto a folha: sem as autoridades, a SEFAZ não
        encadeia o certificado até uma raiz confiável e recusa a CONEXÃO —
        antes mesmo de olhar o XML.
      */
      const elos = (parsed.chainPem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
      console.log('  cadeia            : ' + elos + ' certificado(s)'
        + (elos > 1 ? '' : '  — só a folha; a SEFAZ pode recusar a conexão'));

      if (janela.valid && assina) prontos += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('  CERTIFICATE VALID : NO');
      console.log('  motivo            : ' + msg);
    }
  }

  console.log('');
  console.log('=== VEREDITO ===');
  console.log('  certificados prontos para assinar : ' + prontos + '/' + refs.length);
  if (prontos === 0) {
    console.log('  statusServico                      : BLOQUEADO');
    console.log('');
    console.log('  Falta a senha do certificado. Reenvie o mesmo `.pfx` com ela em');
    console.log('  Fiscal › Certificado — o arquivo já está no cofre e sobreviveu à');
    console.log('  rotação da chave, mas sem a senha ninguém o abre.');
    return 1;
  }
  console.log('  statusServico                      : LIBERADO PARA TESTE');
  console.log('');
  console.log('  O teste de comunicação com a SEFAZ é chamada de REDE e não é feita');
  console.log('  aqui: rode-a pela tela Fiscal, em homologação, quando quiser.');
  return 0;
}

process.exitCode = main();
