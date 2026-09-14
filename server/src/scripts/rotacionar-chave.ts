/**
 * ============================================================================
 * ROTAÇÃO DA CHAVE DO COFRE — ferramenta administrativa
 * ============================================================================
 *
 * NÃO é rota, não é tela, não é endpoint. É um comando que alguém com acesso
 * ao servidor executa uma vez, na janela de manutenção do deploy.
 *
 * ## Como se usa
 *
 * As duas chaves vêm do AMBIENTE. Nunca as passe como argumento: linha de
 * comando fica no histórico do shell e na lista de processos da máquina.
 *
 *     # 1. ENSAIO — não escreve nada, só conta o que faria
 *     ROTACAO_CHAVE_ANTIGA='...' ROTACAO_CHAVE_NOVA='...' \
 *       node dist/scripts/rotacionar-chave.js --ensaio
 *
 *     # 2. DE VERDADE — só depois de o ensaio dizer o que você espera
 *     ROTACAO_CHAVE_ANTIGA='...' ROTACAO_CHAVE_NOVA='...' \
 *       node dist/scripts/rotacionar-chave.js --confirmar
 *
 * ## A ordem no dia do deploy
 *
 *   1. o servidor PARADO (ninguém escrevendo enquanto se resela);
 *   2. rodar o ensaio e ler o relatório;
 *   3. rodar a rotação;
 *   4. só então trocar `DEVORA_ENCRYPTION_KEY` no ambiente para a NOVA;
 *   5. subir o servidor e conferir em /core/system/secrets-readiness.
 *
 * Inverter 3 e 4 não quebra nada — a ferramenta recebe as duas chaves e não
 * depende da do ambiente —, mas deixa uma janela em que o servidor subiria
 * sem conseguir abrir o cofre.
 *
 * ## O que ela nunca faz
 *
 * Não imprime segredo, não o devolve, não o escreve em log. O relatório
 * carrega tipo, empresa e situação — nada mais.
 */
import { rotacionarChaveDoCofre } from '../db/rotateEncryptionKey.js';
import { BancoOcupado, assumirInstanciaAgora, type Trava } from '../services/implantacao/instanciaUnica.js';

const CHAVE_ANTIGA = process.env.ROTACAO_CHAVE_ANTIGA ?? '';
const CHAVE_NOVA = process.env.ROTACAO_CHAVE_NOVA ?? '';

const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const ensaio = !confirmar;

let trava: Trava | null = null;

function sair(mensagem: string, codigo = 1): never {
  trava?.liberar();
  console.error(mensagem);
  process.exit(codigo);
}

if (!CHAVE_ANTIGA || !CHAVE_NOVA) {
  sair(
    'Faltam ROTACAO_CHAVE_ANTIGA e ROTACAO_CHAVE_NOVA no ambiente.\n'
      + 'Não passe as chaves como argumento: elas ficariam no histórico do shell.',
  );
}

if (!confirmar && !args.includes('--ensaio')) {
  sair(
    'Escolha --ensaio (não escreve) ou --confirmar (escreve).\n'
      + 'Rodar o ensaio antes não é formalidade: é o passo em que se descobre, com\n'
      + 'o banco intacto, que um segredo não abre com a chave antiga.',
  );
}

/*
  "O servidor PARADO" deixou de ser só o passo 1 do roteiro (GAP-PRD-137): a
  rotação de verdade assume o banco, e com a API no ar ela recusa e diz quem
  está usando. O ensaio não escreve, e roda com a API no ar.
*/
if (confirmar) {
  try {
    trava = assumirInstanciaAgora('manutencao');
  } catch (err) {
    if (!(err instanceof BancoOcupado)) throw err;
    sair(`${err.message}\nNada foi escrito: pare a API antes de rotacionar a chave.`);
  }
}

console.log(ensaio ? '=== ENSAIO — nada será escrito ===' : '=== ROTAÇÃO — o banco será alterado ===');

const r = rotacionarChaveDoCofre({
  chaveAntiga: CHAVE_ANTIGA,
  chaveNova: CHAVE_NOVA,
  ensaio,
});
trava?.liberar();

console.log('');
console.log('FOUND              :', r.encontrados);
console.log('DECRYPTABLE_OLD    :', r.abremComAAntiga);
console.log('REENCRYPTABLE_NEW  :', r.resselaveisComANova);
console.log('FAILURES           :', r.impedimentos.length);
console.log('já na chave nova   :', r.jaNaChaveNova);
console.log('a resselar         :', r.resselados);
console.log('');

for (const l of r.linhas) {
  console.log(
    '  '
      + l.tipo.padEnd(44)
      + String(l.companyId ?? '—').slice(0, 8).padEnd(10)
      + String(l.ambiente ?? '—').padEnd(14)
      + l.situacao,
  );
}

if (r.impedimentos.length > 0) {
  console.log('');
  console.log('ABORTADO — estes não abrem com a chave antiga:');
  for (const l of r.impedimentos) {
    console.log('  ' + l.tipo.padEnd(44) + String(l.companyId ?? '—').slice(0, 8));
  }
  console.log('');
  sair(
    'Nada foi escrito. Confira se ROTACAO_CHAVE_ANTIGA é mesmo a chave que selou\n'
      + 'estes segredos. Se algum deles foi selado por uma terceira chave que se\n'
      + 'perdeu, ele precisa ser reenviado pela tela antes da rotação.',
  );
}

if (!ensaio) {
  console.log('');
  console.log('cópia antes   :', r.copia ?? '(pulada — o alvo não é o banco operacional)');
  console.log('conferido     :', r.conferido ? 'SIM — todos reabriram com a chave nova' : 'NÃO');
  if (!r.conferido && r.resselados > 0) {
    sair('A conferência não passou. A transação voltou atrás; nada foi alterado.');
  }
  console.log('');
  console.log('Agora troque DEVORA_ENCRYPTION_KEY no ambiente para a chave NOVA,');
  console.log('suba o servidor e confira em /core/system/secrets-readiness.');
} else {
  console.log('');
  console.log('Nada foi escrito. Para valer, rode de novo com --confirmar.');
}
