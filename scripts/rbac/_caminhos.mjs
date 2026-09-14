// Onde os scripts do RBAC leem e escrevem — sem caminho absoluto de máquina.
//
// Os geradores nasceram numa pasta de rascunho, lendo uma árvore fixa
// (int/b, fb4c111). Aqui eles leem a árvore em que ESTÃO (duas pastas acima
// desta) e escrevem nesta pasta, de modo que `node scripts/rbac/regenerar.mjs`
// refaz o mapa sobre o HEAD da hora.
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Esta pasta (`scripts/rbac`), com barras normais. */
export const AQUI = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

/** A raiz do repositório em que os scripts moram. */
export const REPO = resolve(AQUI, '..', '..').replace(/\\/g, '/');

function cabeca() {
  try {
    const ramo = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO }).toString().trim();
    const sha = execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim();
    return `branch ${ramo}, HEAD ${sha}`;
  } catch {
    return 'HEAD desconhecido';
  }
}

/** A base declarada nas saídas: qual árvore foi lida. */
export const BASE = `${REPO} (${cabeca()})`;
