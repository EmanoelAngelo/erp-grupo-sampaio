/**
 * O que existe no bucket da cópia remota — `npm run db:bucket`.
 *
 * Só leitura (GAP-PRD-012). Lista as cópias do banco (raiz do bucket) e os
 * conjuntos de fotos (`uploads/`), do mais novo para o mais velho. É o passo
 * antes de `baixar-backup` e `restaurar-uploads`, e o jeito de conferir, sem
 * abrir o painel do provedor, que o diário está chegando lá.
 *
 * Lê DEVORA_SUPABASE_URL, DEVORA_SUPABASE_SERVICE_KEY e DEVORA_SUPABASE_BUCKET
 * do .env (rode da pasta da instalação). A chave nunca é impressa.
 *
 *     node server/dist/scripts/listar-bucket.js
 *
 * Os comandos do bucket terminam por `process.exitCode`, e não por
 * `process.exit()`: no Windows, sair à força com a conexão do `fetch` ainda
 * aberta derruba o Node com 0xC0000409 em vez do código pedido — medido no
 * teste destes comandos.
 */
import { nomeDoBucket } from '../services/backup/bucket.js';
import { listarBucket } from '../services/backup/restauracaoDoBucket.js';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).padStart(7)} MB`;
}

async function principal(): Promise<number> {
  const r = await listarBucket();
  if (!r.ok) {
    console.error(`Não consegui listar o bucket: ${r.motivo}`);
    return 1;
  }

  console.log(`Bucket: ${nomeDoBucket()}`);
  console.log('');
  console.log(`Cópias do banco: ${r.bancos.length}${r.bancos.length > 20 ? ' (as vinte mais novas abaixo)' : ''}`);
  for (const b of r.bancos.slice(0, 20)) console.log(`  ${mb(b.bytes)}  ${b.nome}`);
  console.log('');
  console.log(`Conjuntos de fotos (manifestos): ${r.manifestos.length}`);
  for (const m of r.manifestos.slice(0, 10)) console.log(`  ${m.nome}`);
  if (r.pacotes.length > 0) {
    console.log(`Pacotes antigos (versão 1): ${r.pacotes.length}`);
    for (const p of r.pacotes.slice(0, 10)) console.log(`  ${mb(p.bytes)}  ${p.nome}`);
  }
  console.log('');
  console.log('Para trazer de volta:');
  console.log('  node server/dist/scripts/baixar-backup.js --ultimo <arquivo-novo.db>');
  console.log('  node server/dist/scripts/restaurar-uploads.js --ultimo <pasta-nova>');
  console.log('  node server/dist/scripts/restaurar-do-bucket.js <pasta-nova>     (os dois, para o disco morto)');
  return 0;
}

process.exitCode = await principal();
