/**
 * Traz UMA cópia do banco do bucket — `npm run db:baixar -- <nome|--ultimo> <destino>`.
 *
 * GAP-PRD-012. O destino precisa ser um caminho que NÃO existe: restaurar por
 * cima de um banco corrompe os dois. O arquivo baixado só ganha o nome pedido
 * depois de passar no `integrity_check`; se não abrir, é apagado e o comando
 * sai com 1.
 *
 * O arquivo trazido já é um banco pronto: aponte DEVORA_DATABASE_PATH para
 * ele (com a API desligada) e suba. Ou use `db:restore` para copiá-lo para
 * outro lugar.
 *
 *     node server/dist/scripts/baixar-backup.js --ultimo D:/restauracao/grupo-sampaio.db
 *     node server/dist/scripts/baixar-backup.js grupo-sampaio-2026-09-10T06-00-01-123Z-diario.db D:/r/banco.db
 *
 * Termina por `process.exitCode` (ver `listar-bucket.ts`).
 */
import { resolve } from 'node:path';
import { baixarBancoDoBucket } from '../services/backup/restauracaoDoBucket.js';

async function principal(): Promise<number> {
  const [pedido, destino] = process.argv.slice(2);
  if (!pedido || !destino) {
    console.error('Uso: baixar-backup <nome-no-bucket | --ultimo> <destino-novo.db>');
    console.error('Os nomes aparecem em: node server/dist/scripts/listar-bucket.js');
    return 1;
  }

  const r = await baixarBancoDoBucket(pedido, resolve(destino));
  if (!r.ok) {
    console.error(`NÃO baixado: ${r.motivo}`);
    return 1;
  }

  console.log('Baixado e conferido.');
  console.log(`  origem  : ${r.nome}`);
  console.log(`  destino : ${r.destino}`);
  console.log(`  tamanho : ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  tabelas : ${r.tabelas}`);
  console.log('');
  console.log('Para subir em cima dele: API desligada, DEVORA_DATABASE_PATH apontando para o destino, e ligue a API —');
  console.log('a migração leva o banco ao esquema atual sem apagar nada.');
  return 0;
}

process.exitCode = await principal();
