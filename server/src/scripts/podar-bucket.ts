/**
 * ============================================================================
 * PODA DO BUCKET — ferramenta administrativa
 * ============================================================================
 *
 * O bucket nunca teve poda. Em 27/08/2026 eram 530 objetos e 2,7 GB de cópias
 * do banco, num armazenamento pago, subindo a cada boot do servidor.
 *
 * ## Como se usa
 *
 *     # 1. ENSAIO — não apaga nada, só diz o que faria
 *     node dist/scripts/podar-bucket.js --ensaio
 *
 *     # 2. DE VERDADE, e só o que NÃO é legado
 *     node dist/scripts/podar-bucket.js --confirmar
 *
 *     # 3. incluindo os anteriores à rotação da chave — leia abaixo antes
 *     node dist/scripts/podar-bucket.js --confirmar --incluir-legados
 *
 * ## Por que `--incluir-legados` é separado
 *
 * Os backups anteriores à rotação carregam os segredos selados pela chave
 * PUBLICADA. São passivo de segurança — e são também o único caminho de volta
 * se algo na rotação tiver escapado.
 *
 * Apagá-los antes de existir backup novo VALIDADO troca um problema de
 * exposição por um de perda. A ordem certa está em `backupClassification`:
 * backup novo confirmado, restauração conferida, retenção mínima satisfeita sem
 * contar os legados.
 *
 * Mesmo com a bandeira, o mais recente de cada selo é preservado.
 *
 * ## O que ele nunca faz
 *
 * Não apaga o mais recente. Não desce do mínimo. Não apaga o que não conseguiu
 * classificar. E não faz nada sem `--confirmar`.
 */
import { apagarBackupRemoto, listarBackupsRemotos } from '../db/backupRemoto.js';
import { planejarExpurgo, politicaDeRetencao } from '../db/backupRetention.js';
import { prontidaoDosSegredos } from '../db/secretsReadiness.js';

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const incluirLegados = args.includes('--incluir-legados');

if (!confirmar && !args.includes('--ensaio')) {
  console.error(
    'Escolha --ensaio (não apaga) ou --confirmar (apaga).\n'
      + 'O ensaio não é formalidade: é onde se lê, com o bucket intacto, exatamente\n'
      + 'quais objetos sairiam.',
  );
  process.exit(1);
}

const politica = politicaDeRetencao();
console.log(confirmar ? '=== PODA — objetos serão apagados ===' : '=== ENSAIO — nada será apagado ===');
console.log('');
console.log('política:');
console.log('  diários  : ' + politica.diarios + ' dias (guarda todos)');
console.log('  semanais : ' + politica.semanais + ' semanas (um por semana)');
console.log('  mensais  : ' + politica.mensais + ' meses (um por mês)');
console.log('  mínimo   : ' + politica.minimo);
console.log('  legados  : ' + (incluirLegados ? 'INCLUÍDOS' : 'preservados'));

const lista = await listarBackupsRemotos({ limite: 5000 });
if (!lista.ok) {
  console.error('Não consegui listar o bucket: ' + lista.motivo);
  process.exit(1);
}

const plano = planejarExpurgo(
  lista.itens.map((i) => ({
    nome: i.nome,
    criadoEm: i.criadoEm ?? '1970-01-01T00:00:00.000Z',
    bytes: i.bytes ?? 0,
  })),
  {
    agora: new Date(),
    rotacionadoEm: prontidaoDosSegredos().cofreRotacionadoEm,
    permitirExpurgoDeLegados: incluirLegados,
    politica,
  },
);

console.log('');
console.log('WOULD KEEP          : ' + plano.manter.length);
console.log('WOULD DELETE        : ' + plano.apagar.length);
console.log('bytes que sairiam   : ' + (plano.bytesQueSairiam / 1024 / 1024).toFixed(1) + ' MB');
console.log('legados preservados : ' + plano.legadosPreservados);

if (plano.apagar.length === 0) {
  console.log('');
  console.log('Nada a apagar.');
  process.exit(0);
}

console.log('');
console.log('sairiam (os vinte primeiros):');
for (const o of plano.apagar.slice(0, 20)) {
  console.log('  ' + String(o.criadoEm).slice(0, 19) + '  ' + o.selo.padEnd(24) + o.motivo);
}
if (plano.apagar.length > 20) console.log('  ... e mais ' + (plano.apagar.length - 20));

if (!confirmar) {
  console.log('');
  console.log('Nada foi apagado. Para valer, rode de novo com --confirmar.');
  process.exit(0);
}

console.log('');
console.log('=== APAGANDO ===');
let apagados = 0;
let falhas = 0;
for (const o of plano.apagar) {
  const r = await apagarBackupRemoto(o.nome);
  if (r.ok) {
    apagados += 1;
  } else {
    falhas += 1;
    console.log('  FALHOU ' + o.nome + ': ' + r.motivo);
  }
}
console.log('  apagados : ' + apagados);
console.log('  falhas   : ' + falhas);
console.log('');
console.log('Confira com `listarBackupsRemotos` ou pelo painel do bucket.');
