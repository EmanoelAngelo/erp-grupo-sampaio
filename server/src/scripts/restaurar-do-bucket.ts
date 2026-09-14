/**
 * O ROTEIRO DO DISCO MORTO — `npm run db:restaurar-do-bucket -- <pasta-nova> [--banco <nome>] [--fotos <manifesto>]`.
 *
 * GAP-PRD-012. Numa pasta NOVA (vazia ou inexistente), traz do bucket o banco
 * mais novo (`grupo-sampaio.db`, conferido pelo integrity_check) e o conjunto
 * de fotos mais novo (`uploads/`, cada arquivo conferido pelo sha256), e
 * imprime as duas linhas do .env que fazem a API subir em cima deles.
 *
 * Numa máquina nova: instale o sistema, crie o .env com DEVORA_SUPABASE_URL,
 * DEVORA_SUPABASE_SERVICE_KEY e DEVORA_SUPABASE_BUCKET (e as chaves do cofre —
 * DEVORA_ENCRYPTION_KEY precisa ser A MESMA de antes, senão os segredos
 * gravados no banco não abrem), rode este comando, cole as duas linhas no
 * .env e suba a API. O passo a passo inteiro está em docs/DEPLOY.md.
 *
 *     node server/dist/scripts/restaurar-do-bucket.js D:/grupo-sampaio-restaurado
 *
 * Termina por `process.exitCode` (ver `listar-bucket.ts`).
 */
import { resolve } from 'node:path';
import { restaurarTudoDoBucket } from '../services/backup/restauracaoDoBucket.js';

const BANDEIRAS = ['--banco', '--fotos'];

async function principal(): Promise<number> {
  const args = process.argv.slice(2);
  const pasta = args.find((a, i) => !a.startsWith('--') && !BANDEIRAS.includes(args[i - 1] ?? ''));
  const valorDe = (bandeira: string): string | undefined => {
    const i = args.indexOf(bandeira);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (!pasta) {
    console.error('Uso: restaurar-do-bucket <pasta-nova> [--banco <nome.db>] [--fotos <manifesto-....json>]');
    console.error('Sem --banco/--fotos, traz os mais novos. Os nomes aparecem em listar-bucket.');
    return 1;
  }

  const r = await restaurarTudoDoBucket(resolve(pasta), { banco: valorDe('--banco'), fotos: valorDe('--fotos') });
  if (!r.ok) {
    console.error(`NÃO restaurado: ${r.motivo}`);
    return 1;
  }

  console.log('Restaurado do bucket e conferido.');
  console.log(`  pasta  : ${r.pasta}`);
  console.log(`  banco  : ${r.banco.nome} -> ${r.banco.destino} (${r.banco.tabelas} tabelas)`);
  if (r.fotos) {
    console.log(`  fotos  : ${r.fotos.origem} -> ${r.fotos.destino} (${r.fotos.arquivos} arquivo(s), formato ${r.fotos.formato})`);
  } else {
    console.log(`  fotos  : nenhuma — ${r.semFotos}`);
  }
  console.log('');
  console.log('Cole no .env da instalação (com a API desligada) e ligue a API:');
  for (const l of r.linhasDoEnv) console.log(`  ${l}`);
  console.log('');
  console.log('Depois, confira em Configurações › Backup e aponte DEVORA_BACKUP_DIR para outro disco.');
  return 0;
}

process.exitCode = await principal();
