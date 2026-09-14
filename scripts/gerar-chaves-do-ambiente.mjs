/**
 * Gera as duas chaves fortes que o servidor exige em produção e as grava no
 * arquivo .env da raiz.
 *
 * POR QUE UM SCRIPT, E NÃO UM COMANDO SOLTO: a chave não pode passar por
 * chat, por histórico de terminal nem por captura de tela. Aqui ela é gerada,
 * gravada e NUNCA impressa — a saída diz apenas quantas chaves entraram.
 *
 * POR QUE `node` PURO, SEM `tsx`: este script não abre banco nenhum. Ele lê e
 * escreve um arquivo de texto e mais nada. Rodá-lo não tem como tocar na base
 * operacional.
 *
 * RODAR DUAS VEZES É SEGURO: chave que já existe no arquivo não é substituída.
 * Trocar a DEVORA_ENCRYPTION_KEY depois de instalar o certificado e o CSC
 * torna os dois ILEGÍVEIS — é ela que deriva a chave do cofre fiscal
 * (FiscalSecretVault). Por isso a recusa em sobrescrever é proteção, não
 * teimosia.
 *
 *   node scripts/gerar-chaves-do-ambiente.mjs
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = process.argv[2] ? resolve(process.argv[2]) : resolve(RAIZ, '.env');

/*
  O mínimo vem de `server/src/config/env.ts`: produção recusa subir com
  DEVORA_JWT_SECRET menor que 16 e DEVORA_ENCRYPTION_KEY menor que 24, e
  recusa também os valores de desenvolvimento. 48 bytes em base64url dão 64
  caracteres — folgado nos dois casos, e sem caractere que atrapalhe o
  arquivo (base64url não tem `+`, `/`, `=` nem aspas).
*/
const CHAVES = ['DEVORA_JWT_SECRET', 'DEVORA_ENCRYPTION_KEY'];

const texto = existsSync(ARQUIVO) ? readFileSync(ARQUIVO, 'utf8') : '';
// O arquivo desta máquina é CRLF. Escrever `\n` no meio dele deixaria linhas
// de dois formatos no mesmo arquivo; o leitor de .env do projeto aguenta,
// mas quem abrir no editor veria a bagunça.
const fim = texto.includes('\r\n') ? '\r\n' : '\n';

const novas = [];
for (const chave of CHAVES) {
  if (new RegExp(`^\\s*${chave}\\s*=`, 'm').test(texto)) {
    console.log(`${chave}: já existe no .env — não foi tocada.`);
    continue;
  }
  novas.push(`${chave}=${randomBytes(48).toString('base64url')}`);
}

if (novas.length === 0) {
  console.log('Nada a fazer. As duas chaves já estão no arquivo.');
  process.exit(0);
}

const prefixo = texto.length > 0 && !/\r?\n$/.test(texto) ? fim : '';
appendFileSync(ARQUIVO, prefixo + novas.join(fim) + fim);

console.log(
  `${novas.length} chave(s) gravada(s) em ${ARQUIVO}.`
    + '\nO valor NÃO foi impresso de propósito: ele não deve passar por chat,'
    + '\nhistórico de terminal nem captura de tela.'
    + '\n\nReinicie o servidor da API para que ele leia o arquivo.',
);
