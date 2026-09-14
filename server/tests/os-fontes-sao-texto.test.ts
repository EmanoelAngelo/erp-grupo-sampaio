/**
 * OS FONTES SÃO TEXTO — nenhum byte de controle cru no que o repositório guarda.
 *
 * Três vezes a mesma mordida: o SyncService (GAP-PRD-047), a prontidão
 * tributária (GAP-PRD-095) e o StorefrontService (junção da ECO) carregavam um
 * byte NUL LITERAL dentro de uma string — o separador de uma chave composta,
 * num `.join(...)`. Em tempo de execução é a mesma string que o escape (barra
 * invertida, u0000); para todo o resto, não:
 *
 *  - o git passa a tratar o arquivo como BINÁRIO: o diff some ("Binary files
 *    differ"), o grep responde "Binary file matches" em vez da linha, e a
 *    junção de duas frentes vira UM conflito do arquivo inteiro (4.527 linhas
 *    no StorefrontService), sem os blocos que dariam para resolver;
 *  - editor e revisor não enxergam o byte — a linha parece `.join('')`.
 *
 * O byte de controle se escreve ESCAPADO, com barra invertida (u0000, x1b).
 * Tab, LF e CR são os únicos permitidos crus.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = resolve(__dirname, '..', '..');

/** As pastas de fonte e documentação que o repositório guarda. */
const PASTAS = ['src', 'server/src', 'server/tests', 'scripts', 'deploy', 'docs', 'public'];

/** Extensões de TEXTO. Imagem, fonte e PDF ficam de fora — esses são binários de propósito. */
const TEXTO = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.sql',
  '.yml', '.yaml', '.conf', '.example', '.xsd', '.xml', '.txt', '.ps1', '.sh', '.env',
]);

/** Nunca descer aqui: dependências, artefatos de build e dados de execução. */
const IGNORAR = new Set(['node_modules', 'dist', 'coverage', 'data', 'backups', 'uploads', '.vite']);

function arquivosDe(pasta: string): string[] {
  const absoluta = join(RAIZ, pasta);
  let entradas: string[];
  try {
    entradas = readdirSync(absoluta);
  } catch {
    return [];
  }
  const saida: string[] = [];
  for (const nome of entradas) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(absoluta, nome);
    const st = statSync(caminho);
    if (st.isDirectory()) saida.push(...arquivosDe(relative(RAIZ, caminho)));
    else if (TEXTO.has(extname(nome).toLowerCase())) saida.push(caminho);
  }
  return saida;
}

/** Byte de controle que não é Tab (9), LF (10) nem CR (13) — inclui ESC (27) e DEL (127). */
function ehControleProibido(b: number): boolean {
  return (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127;
}

function achados(arquivo: string): string[] {
  const bytes = readFileSync(arquivo);
  const saida: string[] = [];
  let linha = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === 10) linha += 1;
    else if (ehControleProibido(b)) {
      saida.push(`${relative(RAIZ, arquivo).replace(/\\/g, '/')}:${linha} byte 0x${b.toString(16).padStart(2, '0')}`);
    }
  }
  return saida;
}

describe('os fontes são texto', () => {
  const arquivos = PASTAS.flatMap(arquivosDe);

  it('a varredura enxerga o repositório — senão ficaria verde lendo nada', () => {
    expect(arquivos.length).toBeGreaterThan(1000);
    expect(arquivos.some((a) => a.replace(/\\/g, '/').endsWith('server/src/services/core/StorefrontService.ts'))).toBe(true);
  });

  it('nenhum arquivo de texto tem byte de controle cru (escreva-o escapado)', () => {
    expect(arquivos.flatMap(achados)).toEqual([]);
  });

  it('o detector acusa o byte NUL, o ESC e o DEL, e deixa Tab, LF e CR', () => {
    expect([0, 1, 8, 11, 12, 14, 27, 31, 127].every(ehControleProibido)).toBe(true);
    expect([9, 10, 13, 32, 65, 0xc3].some(ehControleProibido)).toBe(false);
  });
});
