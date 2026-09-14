/**
 * A CASA DOS BANCOS TEMPORÁRIOS DA SUÍTE — criada uma vez, apagada uma vez.
 *
 * ## O que estava errado, com medida
 *
 * Cada arquivo de teste cria uma pasta temporária com o próprio SQLite, e a
 * limpeza vivia num `process.on('exit')` dentro de `tests/setup.ts`. O
 * comentário de lá dizia que essa limpeza "resolve o caso normal" e que o
 * Windows era a exceção rara. A medida diz o contrário, e não por pouco:
 *
 *   3 execuções completas -> 440 pastas, 2,6 GB
 *   1 execução completa   -> 155 pastas, 935 MB   (155 arquivos de teste)
 *
 * Uma pasta por arquivo de teste, TODA vez: o `rmSync` da saída falhava em
 * praticamente 100% dos casos. A razão é simples e não tem nada de excepcional
 * no Windows — o arquivo SQLite ainda está ABERTO pelo processo que está
 * morrendo, e o Windows não deixa apagar arquivo com handle aberto. Não era o
 * caso raro: era o caso ÚNICO.
 *
 * Comentário que descreve um mundo que não existe é pior que comentário
 * nenhum: ele convence a próxima pessoa de que o problema já foi resolvido.
 *
 * ## O conserto, em duas camadas
 *
 * 1. `tests/setup.ts` FECHA A CONEXÃO antes do `rmSync` (é o que solta o
 *    handle e faz a remoção funcionar de verdade).
 * 2. este arquivo. `globalSetup` roda no processo principal do Vitest: o
 *    `setup` antes de qualquer worker existir, o `teardown` depois de TODOS
 *    terem morrido. É a única posição do sistema em que não existe mais nenhum
 *    handle aberto para nenhum banco de teste — e por isso é a única em que a
 *    remoção não depende de sorte.
 *
 * A camada 1 sozinha bastaria no caminho feliz; a 2 cobre o worker que morreu
 * de `SIGKILL`, o que estourou memória e o que travou. Juntas, não sobra pasta.
 *
 * ## Por que uma PASTA-RAIZ por execução, e não uma varredura por prefixo
 *
 * O `teardown` precisa saber o que é dele. Apagar todo `gs-erp-test-*` do
 * temporário levaria junto a pasta de uma OUTRA suíte rodando ao mesmo tempo na
 * mesma máquina — duas janelas de terminal é o cenário normal de quem
 * desenvolve, e a suíte alheia morreria com o banco sumindo debaixo dela.
 *
 * A raiz é criada aqui, o caminho desce para os workers por variável de
 * ambiente (os forks herdam `process.env` no momento em que nascem, e eles
 * nascem depois desta função), e o `teardown` apaga a raiz inteira. O que é
 * desta execução está dentro dela; o que não está, não é nosso.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Nome da variável que leva a raiz até os workers. */
const VAR_RAIZ = 'GS_ERP_TEST_TMP_ROOT';

/**
 * VARREDURA DO QUE FICOU PARA TRÁS — de execuções ANTERIORES, não desta.
 *
 * Ela nasceu de um caso real: 21.293 pastas somando 158 GB encheram o disco da
 * máquina de desenvolvimento e a suíte passou a falhar em massa com
 * `ENOSPC: no space left on device`, um erro que não diz nada sobre a causa.
 *
 * Com o `teardown` abaixo funcionando, ela deixa de ser a rede de segurança
 * principal e passa a cobrir só o que nenhum `teardown` alcança: a execução que
 * foi interrompida com Ctrl+C ou morta pelo sistema no meio.
 *
 * MUDOU DE LUGAR e isso é metade do conserto: ela morava em `tests/setup.ts`,
 * que roda uma vez POR ARQUIVO DE TESTE — 155 varreduras do diretório
 * temporário inteiro por execução, todas fazendo o mesmo trabalho. Aqui roda
 * uma vez.
 *
 * Só toca em pasta nossa (prefixo `gs-`) e parada há mais de QUINZE MINUTOS.
 * A janela é curta de propósito: uma rodada completa leva cerca de três
 * minutos, então quinze nunca alcança a pasta de uma suíte em andamento — e uma
 * janela longa (uma hora foi a primeira tentativa) deixaria o resíduo acumular
 * dentro da mesma sessão de trabalho, que é justamente quando se roda a suíte
 * dezenas de vezes.
 */
function varrerResiduoAntigo(): void {
  const limite = Date.now() - 15 * 60_000;
  let base: string[];
  try {
    base = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const nome of base) {
    if (!nome.startsWith('gs-')) continue;
    const caminho = join(tmpdir(), nome);
    try {
      if (statSync(caminho).mtimeMs > limite) continue;
      rmSync(caminho, { recursive: true, force: true });
    } catch {
      // Pasta em uso por outra suíte, ou já removida. Seguir adiante.
    }
  }
}

let raiz: string | null = null;

export function setup(): void {
  varrerResiduoAntigo();
  raiz = mkdtempSync(join(tmpdir(), 'gs-erp-run-'));
  process.env[VAR_RAIZ] = raiz;
}

export function teardown(): void {
  const alvo = raiz ?? process.env[VAR_RAIZ];
  if (!alvo) return;
  try {
    /*
      Aqui não há mais nenhum worker vivo, portanto não há mais nenhum handle
      de SQLite aberto — é o único momento em que apagar não depende de o
      `rmSync` do worker ter dado certo.

      A falha continua sendo engolida por um motivo só: `teardown` que estoura
      derruba a execução DEPOIS de todos os testes terem passado, e transformar
      "sobrou lixo no temporário" em "a suíte falhou" ensinaria a rodar de novo
      até passar — o hábito em que um vermelho de verdade some junto. Se algo
      escapar, a varredura da próxima execução termina o serviço.
    */
    rmSync(alvo, { recursive: true, force: true });
  } catch {
    // Ver acima.
  }
}
