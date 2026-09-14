#!/usr/bin/env node
// Gera src/lib/acesso/capabilityDaTela.gen.ts a partir de scripts/rbac/mapa-final.json: a capability
// de cada TELA (rota do roteador e item de menu), para o guarda de navegação e o menu refletirem o
// acesso de quem foi PERSONALIZADO pela tela de Usuários (escopo reduzido da entrega). Os perfis de
// hoje continuam com o guarda por ambiente/perfil de sempre.
//
// uso: node scripts/rbac/gerar-capability-da-tela.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mapa = JSON.parse(readFileSync(join(RAIZ, 'scripts/rbac/mapa-final.json'), 'utf8'));
const catalogo = JSON.parse(readFileSync(join(RAIZ, 'scripts/rbac/catalogo-final.json'), 'utf8'));
const itens = Array.isArray(catalogo) ? catalogo : catalogo.capabilities || catalogo.catalogo;
const codigos = new Set(itens.map((c) => c.code));

function valida(texto) {
  const t = String(texto).trim();
  const composta = /^(qualquer|todas)\((.*)\)$/s.exec(t);
  const partes = composta ? composta[2].split(',').map((x) => x.trim()) : [t];
  return partes.length > 0 && partes.every((p) => codigos.has(p));
}

const porTela = new Map();
for (const p of mapa.pontos) {
  if ((p.tipo !== 'tela-rota' && p.tipo !== 'tela-menu') || !p.tela) continue;
  const expr = String(p.capability_final ?? '').trim();
  if (!expr || !valida(expr)) continue;
  const ja = porTela.get(p.tela);
  // Rota e item de menu da mesma tela devem concordar; se não, vale a da ROTA (quem guarda é ela).
  if (ja && ja.expr !== expr && p.tipo !== 'tela-rota') continue;
  porTela.set(p.tela, { expr, tipo: p.tipo });
}

// O catálogo em forma de tela: áreas → capabilities, para o editor de acesso de Usuários.
const areas = new Map();
for (const c of itens) {
  if (!areas.has(c.area)) areas.set(c.area, []);
  areas.get(c.area).push({ code: c.code, label: c.label, escopo: c.escopo });
}

const linhas = [...porTela].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([tela, { expr }]) => `  ${JSON.stringify(tela)}: ${JSON.stringify(expr)},`);
const ts = `/**
 * GERADO por scripts/rbac/gerar-capability-da-tela.mjs a partir de scripts/rbac/mapa-final.json.
 * Não edite à mão: regenere.
 *
 * A capability de cada tela (caminho do roteador, com :parametros) na forma de texto
 * \`capability\`, \`qualquer(a, b)\` ou \`todas(a, b)\`. Usada para quem tem acesso PERSONALIZADO.
 */
export const CAPABILITY_DA_TELA: Readonly<Record<string, string>> = {
${linhas.join('\n')}
};

/** O catálogo agrupado por área, para o editor de acesso da tela de Usuários. */
export const AREAS_DO_CATALOGO: ReadonlyArray<{ area: string; capabilities: ReadonlyArray<{ code: string; label: string; escopo: string }> }> = ${JSON.stringify([...areas].map(([area, capabilities]) => ({ area, capabilities })), null, 2)};
`;
mkdirSync(join(RAIZ, 'src/lib/acesso'), { recursive: true });
writeFileSync(join(RAIZ, 'src/lib/acesso/capabilityDaTela.gen.ts'), ts, 'utf8');
console.log(`capabilityDaTela.gen.ts: ${porTela.size} telas, ${areas.size} áreas`);
