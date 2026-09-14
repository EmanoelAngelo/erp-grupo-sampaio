/**
 * O COFRE — AES-256-GCM com chave derivada de `DEVORA_ENCRYPTION_KEY`.
 *
 * ## Por que existe uma forma que recebe a chave
 *
 * `encryptFiscalSecret`/`decryptFiscalSecret` usam a chave do AMBIENTE, e é
 * assim que todo o sistema fala com o cofre: um processo, uma chave. A rotação
 * é a única operação que precisa de DUAS ao mesmo tempo — abrir com a antiga,
 * selar com a nova — e é para ela que existem as formas explícitas.
 *
 * Elas não são um segundo cofre: são o MESMO algoritmo, o mesmo sal e o mesmo
 * formato de saída. Duplicar o primitivo para a rotação criaria dois lugares
 * onde o formato pode divergir, e o dia em que divergissem seria o dia em que
 * um segredo não abre mais.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { loadEnv } from '../../config/env.js';

/**
 * O SAL É FIXO E ISSO É DELIBERADO.
 *
 * Sal por segredo protegeria contra tabela pré-computada de senhas humanas.
 * Aqui a entrada é uma chave longa de ambiente, não uma senha; e um sal
 * variável exigiria guardá-lo junto do texto cifrado, o que muda o formato dos
 * cinco registros que já existem. O que protege aqui é o tamanho da chave.
 */
const SAL = 'devora-fiscal-vault';

function derivarDe(chave: string): Buffer {
  return scryptSync(chave, SAL, 32);
}

function deriveKey(): Buffer {
  return derivarDe(loadEnv().DEVORA_ENCRYPTION_KEY);
}

/** Sela com uma chave DADA. Só a rotação precisa disto. */
export function encryptWithKey(plaintext: string, chave: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivarDe(chave), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Abre com uma chave DADA. Lança se a chave não for a que selou. */
export function decryptWithKey(payload: string, chave: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', derivarDe(chave), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptFiscalSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptFiscalSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
