/**
 * Restaura um backup NUM CAMINHO NOVO — `npm run db:restore -- <arquivo> <destino>`.
 *
 * POR QUE NÃO RESTAURA POR CIMA DO BANCO EM USO: com o servidor ligado, o
 * SQLite está com o arquivo aberto e o WAL ativo — sobrescrever corrompe os
 * dois. O caminho seguro, e é o que este comando conduz:
 *
 *   1. Desligue o servidor da API.
 *   2. Renomeie o banco atual (ex.: grupo-sampaio.db → grupo-sampaio.antes.db),
 *      junto com o -wal e o -shm, se existirem.
 *   3. npm run db:restore -- <backup> ./server/data/grupo-sampaio.db
 *   4. Ligue o servidor. A migração leva o banco restaurado ao esquema atual.
 *
 * A recusa de destino existente vem da função oficial (`restaurarBackupEm`),
 * que também verifica o backup ANTES de copiar e o restaurado DEPOIS — este
 * arquivo só conduz. Em produção:
 *
 *     node server/dist/scripts/restaurar-backup.js <arquivo> <destino>
 */
import { resolve } from 'node:path';
import { restaurarBackupEm } from '../db/backup.js';

const [backup, destino] = process.argv.slice(2);

if (!backup || !destino) {
  console.error('Uso: npm run db:restore -- <arquivo-de-backup> <destino-novo>');
  console.error('');
  console.error('O destino precisa ser um caminho que NÃO existe — restaurar por cima');
  console.error('de um banco corrompe os dois. Liste os backups com: npm run db:backups');
  process.exit(1);
}

const veredito = restaurarBackupEm(resolve(backup), resolve(destino));
if (!veredito.ok) {
  console.error(`NÃO restaurado: ${veredito.motivo}`);
  process.exit(1);
}

console.log('Restaurado e conferido.');
console.log(`  destino : ${resolve(destino)}`);
console.log(`  tabelas : ${veredito.tabelas}`);
console.log('');
console.log('Se este é o banco que vai subir, ligue o servidor agora — a migração');
console.log('leva o restaurado ao esquema atual sem apagar nada.');
