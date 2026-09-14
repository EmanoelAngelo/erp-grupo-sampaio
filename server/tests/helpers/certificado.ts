/**
 * Um certificado A1 de teste, em PKCS#12, protegido por senha.
 *
 * Os testes que já existiam montavam o `ParsedCertificateA1` direto, sem passar
 * pelo `.pfx` — o que serve para exercitar assinatura, mas não para exercitar o
 * COFRE: guardar e reabrir o arquivo é justamente o que a senha protege.
 *
 * Gerar RSA de 2048 é caro (segundos). Quem usar isto num `beforeEach` deve
 * gerar uma vez no `beforeAll` do arquivo.
 */
import forge from 'node-forge';

/** Devolve o `.pfx` em base64, como o dono envia pela tela. */
export function gerarCertificado(cn: string, senha: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 365);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, {
    algorithm: '3des',
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}
