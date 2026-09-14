/**
 * Backup manual do banco operacional — `npm run backup`.
 *
 * CLI fino de propósito: quem sabe copiar um SQLite aberto é
 * `snapshotDatabase` (VACUUM INTO, com o WAL incluído), a MESMA função do
 * diário automático e dos testes. Nada de regra própria aqui — o antecessor
 * deste arquivo fazia `copyFileSync` do `.db` e nascia desatualizado com cara
 * de íntegro, porque as transações recentes moram no `-wal`.
 *
 * O recém-criado é conferido na hora (`verificarBackup`): "copiou" não é
 * "restaura". Em produção, rode a versão compilada:
 *
 *     node server/dist/scripts/backup-agora.js
 */
import { snapshotDatabase, verificarBackup } from '../db/backup.js';
import { resolveDatabasePath } from '../db/sqlite.js';

const resultado = snapshotDatabase('manual');

if (resultado.skipped) {
  const motivo =
    resultado.skipped === 'in-memory'
      ? 'o banco configurado é ":memory:"'
      : 'o banco configurado está marcado como descartável';
  console.error(
    `Nada a salvar: ${motivo}.\n`
      + 'Backup só faz sentido sobre o banco OPERACIONAL. '
      + `Caminho atual: ${resolveDatabasePath()}`,
  );
  process.exit(1);
}

const veredito = verificarBackup(resultado.path);
if (!veredito.ok) {
  console.error(`O backup foi gravado mas NÃO passou na verificação: ${veredito.motivo}`);
  console.error(`Arquivo: ${resultado.path}`);
  process.exit(1);
}

console.log('Backup criado e conferido.');
console.log(`  arquivo : ${resultado.path}`);
console.log(`  tamanho : ${(resultado.bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  tabelas : ${veredito.tabelas}`);
