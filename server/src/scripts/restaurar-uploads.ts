/**
 * Traz UM conjunto de fotos do bucket — `npm run db:restaurar-uploads -- <manifesto|pacote|--ultimo> <pasta>`.
 *
 * GAP-PRD-012. As fotos de produto, de loja e de OS voltam para `<pasta>` na
 * mesma estrutura do DEVORA_UPLOADS_DIR (`lojas/`, `produtos/`, `os/`). Cada
 * arquivo é conferido pelo sha256 do manifesto antes de ser gravado; arquivo
 * que já está na pasta com o mesmo conteúdo é pulado (retomar uma volta
 * interrompida), com conteúdo diferente interrompe tudo — nunca por cima.
 *
 * Aceita os dois formatos que existem no bucket: o conjunto por objetos
 * (manifesto versão 2, o do diário de hoje) e o pacote antigo `.json.gz`.
 *
 *     node server/dist/scripts/restaurar-uploads.js --ultimo D:/restauracao/uploads
 *
 * Termina por `process.exitCode` (ver `listar-bucket.ts`).
 */
import { resolve } from 'node:path';
import { restaurarFotosDoBucket } from '../services/backup/restauracaoDoBucket.js';

async function principal(): Promise<number> {
  const [pedido, destino] = process.argv.slice(2);
  if (!pedido || !destino) {
    console.error('Uso: restaurar-uploads <manifesto-....json | uploads-....json.gz | --ultimo> <pasta-destino>');
    console.error('Os nomes aparecem em: node server/dist/scripts/listar-bucket.js');
    return 1;
  }

  const r = await restaurarFotosDoBucket(pedido, resolve(destino));
  if (!r.ok) {
    console.error(`NÃO restaurado: ${r.motivo}`);
    return 1;
  }

  console.log('Fotos restauradas e conferidas.');
  console.log(`  origem     : ${r.origem} (formato ${r.formato})`);
  console.log(`  destino    : ${r.destino}`);
  console.log(`  arquivos   : ${r.arquivos} gravado(s), ${r.jaEstavam} já estavam lá`);
  console.log(`  tamanho    : ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log(`Para a API usar esta pasta: DEVORA_UPLOADS_DIR=${r.destino.split('\\').join('/')} no .env, e reinicie.`);
  return 0;
}

process.exitCode = await principal();
