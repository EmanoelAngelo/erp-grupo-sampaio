/**
 * Lista os backups locais — `npm run db:backups`.
 *
 * Só leitura, direto do inventário oficial (`listarBackups`). O passo antes de
 * `npm run db:restore -- <arquivo> <destino>`.
 */
import { backupDirectory, listarBackups } from '../db/backup.js';

const todos = listarBackups().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

console.log(`Pasta: ${backupDirectory()}`);
if (todos.length === 0) {
  console.log('Nenhum backup. Crie um com: npm run backup');
  process.exit(0);
}

console.log(`${String(todos.length)} backup(s), do mais novo para o mais velho:\n`);
for (const b of todos) {
  const mb = (b.bytes / 1024 / 1024).toFixed(1).padStart(6);
  console.log(`  ${b.createdAt}  ${mb} MB  ${b.motivo.padEnd(14)} ${b.file}`);
}
