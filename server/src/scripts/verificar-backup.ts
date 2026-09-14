/**
 * Verifica um backup — `npm run backup:verify [-- <arquivo>]`.
 *
 * Sem argumento, confere o MAIS RECENTE da pasta de backups. A verificação é
 * a oficial (`verificarBackup`): abre o arquivo como SQLite somente leitura e
 * pergunta ao próprio SQLite se ele está íntegro — não confere SHA de cópia,
 * confere que o conteúdo serve para restaurar.
 *
 * Em produção: node server/dist/scripts/verificar-backup.js [arquivo]
 */
import { resolve } from 'node:path';
import { backupDirectory, listarBackups, verificarBackup } from '../db/backup.js';

const pedido = process.argv[2];

let alvo: string;
if (pedido) {
  alvo = resolve(pedido);
} else {
  const todos = listarBackups();
  if (todos.length === 0) {
    console.error(`Nenhum backup em ${backupDirectory()}. Crie um com: npm run backup`);
    process.exit(1);
  }
  const maisRecente = todos.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  alvo = maisRecente.path;
}

const veredito = verificarBackup(alvo);
if (!veredito.ok) {
  console.error(`REPROVADO: ${veredito.motivo}`);
  console.error(`  arquivo: ${alvo}`);
  process.exit(1);
}

console.log('Backup íntegro.');
console.log(`  arquivo : ${alvo}`);
console.log(`  tabelas : ${veredito.tabelas}`);
