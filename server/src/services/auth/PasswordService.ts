/**
 * Hashing de senhas do Grupo Sampaio ERP.
 *
 * Algoritmo oficial: Argon2id. O sistema legado guardava SHA-256 puro, sem
 * salt, calculado no browser — o que permite ataque por rainbow table e expõe
 * o hash como senha-equivalente. Aqui esses hashes continuam sendo aceitos no
 * login para não travar usuários existentes, mas são imediatamente
 * reescritos em Argon2id (`needsRehash`), de modo que a base migra sozinha
 * conforme as pessoas entram.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Parâmetros OWASP (2024) para Argon2id: 19 MiB, 2 iterações, paralelismo 1.
 * `algorithm: 2` é Argon2id — usamos o literal porque `Algorithm` é um
 * `const enum`, que não pode ser importado sob `isolatedModules`.
 */
const ARGON_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type HashAlgorithm = 'argon2id' | 'legacy-sha256';

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON_OPTIONS);
}

export function detectAlgorithm(hash: string): HashAlgorithm {
  return hash.startsWith('$argon2') ? 'argon2id' : 'legacy-sha256';
}

function legacySha256Matches(plain: string, expected: string): boolean {
  const actual = createHash('sha256').update(plain, 'utf8').digest('hex');
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  // Comparação em tempo constante evita distinguir hashes por timing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface VerificationResult {
  valid: boolean;
  /** true quando o hash guardado está no formato legado e deve ser reescrito. */
  needsRehash: boolean;
}

export async function verifyPassword(
  plain: string,
  storedHash: string,
): Promise<VerificationResult> {
  if (detectAlgorithm(storedHash) === 'argon2id') {
    try {
      const valid = await argon2Verify(storedHash, plain);
      return { valid, needsRehash: false };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }

  // Formato legado: aceita uma única vez e sinaliza upgrade.
  if (/^[a-f0-9]{64}$/i.test(storedHash) && legacySha256Matches(plain, storedHash)) {
    return { valid: true, needsRehash: true };
  }
  return { valid: false, needsRehash: false };
}

/**
 * Verificação "dummy" usada quando o login não existe. Mantém o custo de
 * tempo do handler parecido com o de um login válido, para que a resposta não
 * revele quais usuários existem.
 */
const DUMMY_HASH = argon2Hash('__grupo_sampaio_dummy__', ARGON_OPTIONS);

export async function wasteVerificationTime(): Promise<void> {
  try {
    await argon2Verify(await DUMMY_HASH, '__nao_confere__');
  } catch {
    // resultado irrelevante — só queremos consumir o mesmo tempo
  }
}
