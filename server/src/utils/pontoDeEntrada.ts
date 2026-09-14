/**
 * Este módulo é o que o `node`/`tsx` mandou rodar? (GAP-PRD-056)
 *
 * A pergunta aparece em arquivo que é, ao mesmo tempo, biblioteca (importada
 * pelo boot) e comando (`npm run db:migrate`). A forma que estava em
 * `migrate.ts` montava a URL à mão — `file://${argv[1]}` — e no Windows ela
 * nunca casa: o caminho `C:\...` vira `file:///C:/...` (três barras) e o
 * espaço de "Grupo Sampaio" vira `%20`. O comando saía em silêncio, sem fazer
 * nada, e sem dizer que não fez.
 *
 * Aqui a comparação é entre CAMINHOS: a URL do módulo volta a caminho por
 * `fileURLToPath`, o argumento é resolvido contra a pasta atual (como o próprio
 * node o resolve), os dois passam pelo `realpath` quando existem (atalho,
 * junção, letra de disco em caixa diferente) e, no Windows, a comparação
 * ignora maiúsculas — o sistema de arquivos também ignora.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizar(caminho: string): string {
  let absoluto = resolve(caminho);
  try {
    absoluto = realpathSync.native(absoluto);
  } catch {
    // Não existe (ou não dá para ler): fica o caminho resolvido.
  }
  return process.platform === 'win32' ? absoluto.toLowerCase() : absoluto;
}

export function ehPontoDeEntrada(
  urlDoModulo: string,
  argumento: string | undefined = process.argv[1],
): boolean {
  if (!argumento) return false;
  let doModulo: string;
  try {
    doModulo = fileURLToPath(urlDoModulo);
  } catch {
    return false;
  }
  return normalizar(doModulo) === normalizar(argumento);
}
