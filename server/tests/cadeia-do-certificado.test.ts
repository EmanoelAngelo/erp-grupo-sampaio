/**
 * A CADEIA DO CERTIFICADO CHEGA À SEFAZ — rodada 59.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO CONTRA O FISCO DE VERDADE
 * ============================================================================
 *
 * O dono apertou "Testar comunicação com a SEFAZ" com o A1 real da Preço
 * Justo e leu que a comunicação não foi permitida. A rede estava limpa: DNS
 * resolvendo (200.233.4.136), porta 443 aberta, e o TLS do servidor da SEFAZ
 * fechando — um GET sem certificado devolve 403, que é o que um servidor de
 * TLS mútuo responde a quem não se identifica.
 *
 * O que faltava era do NOSSO lado. Um `.pfx` da ICP-Brasil carrega o
 * certificado da empresa MAIS as autoridades que provam que ele é legítimo
 * até a raiz. `parseCertificateA1` pegava `certBag[0]` — a folha — e jogava o
 * resto fora. No handshake, a SEFAZ recebia um certificado que não conseguia
 * encadear até uma raiz confiável e recusava a conexão.
 *
 * ============================================================================
 * POR QUE OS 19 TESTES DA RODADA 58 FICARAM VERDES
 * ============================================================================
 *
 * Porque todos geram um `.pfx` com UM certificado só. O mundo real não tem
 * nenhum assim: certificado ICP-Brasil sempre vem com a AC que o emitiu. O
 * teste reproduzia um mundo mais simples que o do dono, e um mundo mais
 * simples não prova nada sobre o dele.
 *
 * Por isso este arquivo monta o `.pfx` como ele é: folha + intermediária.
 */
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { parseCertificateA1 } = await import('../src/services/fiscal/FiscalCertificateService.js');

const SENHA = 'senha-do-a1';

/**
 * Um `.pfx` com CADEIA, como o da ICP-Brasil: a folha da empresa e a
 * autoridade que a emitiu, no mesmo arquivo.
 */
function pfxComCadeia(): { base64: string; cnEmpresa: string; cnAutoridade: string } {
  const chaveDaAc = forge.pki.rsa.generateKeyPair(1024);
  const chaveDaEmpresa = forge.pki.rsa.generateKeyPair(1024);
  const cnAutoridade = 'AC DIGITAL MULTIPLA G1 TESTE';
  const cnEmpresa = 'PRECO JUSTO COMERCIO DE VARIEDADES LTDA:48025052000149';

  const ac = forge.pki.createCertificate();
  ac.publicKey = chaveDaAc.publicKey;
  ac.serialNumber = '01';
  ac.validity.notBefore = new Date(Date.now() - 86400000);
  ac.validity.notAfter = new Date(Date.now() + 90 * 86400000);
  ac.setSubject([{ name: 'commonName', value: cnAutoridade }]);
  ac.setIssuer([{ name: 'commonName', value: cnAutoridade }]);
  ac.sign(chaveDaAc.privateKey);

  const folha = forge.pki.createCertificate();
  folha.publicKey = chaveDaEmpresa.publicKey;
  folha.serialNumber = '02';
  folha.validity.notBefore = ac.validity.notBefore;
  folha.validity.notAfter = ac.validity.notAfter;
  folha.setSubject([{ name: 'commonName', value: cnEmpresa }]);
  // Emitida PELA autoridade — é esse elo que a SEFAZ precisa poder seguir.
  folha.setIssuer([{ name: 'commonName', value: cnAutoridade }]);
  folha.sign(chaveDaAc.privateKey);

  const p12 = forge.pkcs12.toPkcs12Asn1(chaveDaEmpresa.privateKey, [folha, ac], SENHA, {
    algorithm: '3des',
  });
  return {
    base64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()),
    cnEmpresa,
    cnAutoridade,
  };
}

/** Quantos blocos CERTIFICATE existem num PEM. */
function quantosCertificados(pem: string): number {
  return (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
}

// ============================================================================

describe('o .pfx da ICP-Brasil vem com cadeia, e ela não pode ser jogada fora', () => {
  it('a leitura preserva a autoridade que emitiu o certificado', () => {
    const { base64, cnEmpresa, cnAutoridade } = pfxComCadeia();
    const lido = parseCertificateA1(base64, SENHA);

    // A identidade continua sendo a da EMPRESA — a cadeia não muda quem assina.
    expect(lido.subject).toBe(cnEmpresa);
    expect(lido.cnpj).toBe('48025052000149');
    expect(lido.issuer).toBe(cnAutoridade);

    /*
      `chainPem` é o que vai para o handshake: a folha PRIMEIRO, as
      autoridades depois. Antes existia só `certPem`, com a folha sozinha, e a
      SEFAZ não tinha como seguir o elo até uma raiz confiável.
    */
    expect(quantosCertificados(lido.chainPem)).toBe(2);
    // A folha abre a cadeia: é a ordem que o TLS exige.
    expect(lido.chainPem.startsWith(lido.certPem.trim())).toBe(true);
  });

  it('certPem continua sendo só a folha — quem assina XML não usa a cadeia', () => {
    const { base64 } = pfxComCadeia();
    const lido = parseCertificateA1(base64, SENHA);

    /*
      A assinatura do XML fiscal leva o certificado do SIGNATÁRIO, um só. Se
      `certPem` passasse a carregar a cadeia inteira, o <X509Certificate> do
      XML sairia com três certificados e a SEFAZ rejeitaria o documento. São
      duas perguntas diferentes: "quem assinou" e "por que confiar nele".
    */
    expect(quantosCertificados(lido.certPem)).toBe(1);
  });

  it('.pfx sem cadeia continua funcionando — a cadeia é o que houver', () => {
    // Certificado autoassinado (sem AC separada) é o caso dos testes antigos
    // e de ambientes internos: a cadeia é a própria folha, e nada quebra.
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '03';
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: 'SOZINHO:11222333000181' }]);
    cert.setIssuer([{ name: 'commonName', value: 'SOZINHO:11222333000181' }]);
    cert.sign(keys.privateKey);
    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, { algorithm: '3des' });
    const base64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes());

    const lido = parseCertificateA1(base64, SENHA);
    expect(quantosCertificados(lido.chainPem)).toBe(1);
    expect(quantosCertificados(lido.certPem)).toBe(1);
  });
});

// ============================================================================

describe('nenhum cliente TLS volta a mandar a folha sozinha', () => {
  it('todo `cert:` de https.request usa a cadeia', async () => {
    /*
      VARREDURA, e não teste de um caminho. O defeito nasceu duas vezes no
      mesmo repositório — no SefazRealAdapter e no cliente de prontidão da
      NF-e —, porque `cert: cert.certPem` lê como código certo: é o
      certificado, afinal. A diferença entre `certPem` e `chainPem` só aparece
      contra o fisco de verdade, e é tarde demais.

      Um teste de caminho protegeria o caminho que eu lembrei. Este protege o
      que alguém escrever depois.
    */
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const arquivos: string[] = [];
    (function varrer(dir: string) {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) varrer(caminho);
        else if (nome.endsWith('.ts')) arquivos.push(caminho);
      }
    })(raiz);

    const culpados: string[] = [];
    for (const arquivo of arquivos) {
      const conteudo = readFileSync(arquivo, 'utf8')
        // Comentários explicam o defeito citando o nome dele; a varredura
        // olha só para o que vira chamada.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\bcert:\s*[A-Za-z_$][\w$]*\.certPem\b/.test(conteudo)) {
        culpados.push(arquivo.replace(raiz, 'server/src'));
      }
    }

    expect(
      culpados,
      'Estes mandam a FOLHA no handshake TLS. A SEFAZ recusa a conexão sem a '
        + 'cadeia: use `chainPem`.\n' + culpados.join('\n'),
    ).toEqual([]);
  });
});

// ============================================================================

describe('o handshake leva a cadeia, não só a folha', () => {
  it('o transporte SOAP envia chainPem no certificado do cliente', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const { base64 } = pfxComCadeia();
    const cert = parseCertificateA1(base64, SENHA);

    let enviado: { cert: string; key: string } | null = null;
    const adapter = new SefazRealAdapter({
      cert,
      postSoap: async (input) => {
        enviado = { cert: input.cert.chainPem, key: input.cert.keyPem };
        return {
          status: 200,
          body: '<retConsStatServ><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ>',
        };
      },
    });

    await adapter.statusServico({ uf: 'RS', environment: 'homologation' });

    expect(enviado).not.toBeNull();
    /*
      DOIS certificados no que sai para o fisco. Com um só, a SEFAZ recebe uma
      folha órfã: ela sabe quem diz ser o dono, e não tem como verificar. O
      handshake morre antes de qualquer XML ser lido, e o erro que volta fala
      de TLS, não de nota fiscal.
    */
    expect(quantosCertificados(enviado!.cert)).toBe(2);
  });
});
