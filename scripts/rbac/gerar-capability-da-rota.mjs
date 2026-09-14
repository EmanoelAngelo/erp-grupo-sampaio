#!/usr/bin/env node
// Gera server/src/services/auth/CapabilityDaRota.ts a partir de scripts/rbac/mapa-final.json: para
// cada rota guardada (método + caminho declarado, como `chaveDaRota(req)` monta), a expressão de
// capability que reproduz quem passa hoje. É a PONTE do escopo reduzido da entrega: as guardas por
// perfil (requireProfile/abertaAo) continuam como estão e, quando o perfil não está na lista, a rota
// abre para quem tem a capability dela — o que só muda alguma coisa para vínculo PERSONALIZADO, porque
// os modelos de sistema foram derivados para dar exatamente o acesso de hoje (equivalência).
//
// uso: node scripts/rbac/gerar-capability-da-rota.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mapa = JSON.parse(readFileSync(join(RAIZ, 'scripts/rbac/mapa-final.json'), 'utf8'));
const catalogo = JSON.parse(readFileSync(join(RAIZ, 'scripts/rbac/catalogo-final.json'), 'utf8'));
const codigos = new Set((Array.isArray(catalogo) ? catalogo : catalogo.capabilities || catalogo.catalogo).map((c) => c.code));

function valida(texto) {
  const t = String(texto).trim();
  const composta = /^(qualquer|todas)\((.*)\)$/s.exec(t);
  const partes = composta ? composta[2].split(',').map((x) => x.trim()) : [t];
  return partes.length > 0 && partes.every((p) => codigos.has(p));
}

const porRota = new Map();
const recusadas = [];
for (const p of mapa.pontos) {
  if (p.tipo !== 'rota' || !p.metodo || !p.caminho) continue;
  const expr = String(p.capability_final ?? '').trim();
  if (!expr || /PUBLICA|SO_AUTENTICADO|^FALTA:/.test(expr)) continue;
  if (!valida(expr)) { recusadas.push(`${p.metodo} ${p.caminho} => ${expr}`); continue; }
  const chave = `${String(p.metodo).toUpperCase()} ${p.caminho}`;
  const ja = porRota.get(chave);
  if (ja && ja !== expr) throw new Error(`rota com duas expressões: ${chave}: ${ja} × ${expr}`);
  porRota.set(chave, expr);
}
if (recusadas.length) throw new Error(`expressões fora do catálogo:\n${recusadas.join('\n')}`);

const linhas = [...porRota].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
const ts = `/**
 * GERADO por scripts/rbac/gerar-capability-da-rota.mjs a partir de scripts/rbac/mapa-final.json.
 * Não edite à mão: regenere.
 *
 * A capability de cada rota guardada (método + caminho declarado, sem /api/v1), na forma de texto
 * que \`expressaoDoTexto\` lê. É a PONTE do escopo reduzido da entrega (ver
 * \`passaPelaCapabilityDaRota\` em Autorizacao.ts): a guarda por perfil continua valendo, e a rota
 * abre também para quem tem a capability dela. Rota fora desta tabela: só a guarda por perfil.
 */
export const CAPABILITY_DA_ROTA: Readonly<Record<string, string>> = {
${linhas.join('\n')}
};
`;
writeFileSync(join(RAIZ, 'server/src/services/auth/CapabilityDaRota.ts'), ts, 'utf8');
console.log(`CapabilityDaRota.ts: ${porRota.size} rotas`);
