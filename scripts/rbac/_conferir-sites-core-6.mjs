// Confere sites-core-6.json: JSON válido, uma entrada por rota da fatia, rota e
// capability iguais ao mapa-rota-capability.tsv, e as linhas citadas batem com o fonte.
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const j = JSON.parse(readFileSync(join(aqui, 'sites-core-6.json'), 'utf8'));
const src = readFileSync(REPO_DA_ARVORE + '/server/src/routes/v1/core.ts', 'utf8').split('\n');
const tsv = readFileSync(join(aqui, 'mapa-rota-capability.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t'))
  .filter((c) => c[0] === 'core.ts' && +c[1] >= 11001 && +c[1] <= 13200);
const porLinha = new Map(tsv.map((c) => [+c[1], c]));

// Rotas declaradas no fonte dentro da fatia, independente do TSV.
const rotasFonte = [];
for (let i = 11000; i < 13200; i++) {
  if (/coreRouter\.(get|post|put|patch|delete)\(/.test(src[i])) rotasFonte.push(i + 1);
}

const problemas = [];
for (const s of j) {
  const t = porLinha.get(s.linha);
  if (!t) problemas.push(['sem linha no TSV', s.linha]);
  else {
    if (t[2] !== s.metodo || `/core${t[3]}` !== s.caminho) problemas.push(['rota difere do TSV', s.linha, t[2], t[3]]);
    if (t[6] !== s.capability) problemas.push(['capability difere do TSV', s.linha, t[6], s.capability]);
  }
  if (!src[s.linha - 1].includes(`coreRouter.${s.metodo.toLowerCase()}(`)) problemas.push(['linha da rota não bate', s.linha]);
  const g = Number(/core\.ts:(\d+)/.exec(s.nota)[1]);
  if (!/requireProfile\(|abertaAo\(/.test(src[g - 1])) problemas.push(['linha da guarda não bate', g]);
}
const linhas = new Set(j.map((s) => s.linha));
console.log(JSON.stringify({
  entradas: j.length,
  rotasNoTsv: tsv.length,
  rotasNoFonte: rotasFonte.length,
  faltandoDoTsv: tsv.filter((c) => !linhas.has(+c[1])).map((c) => `${c[1]} ${c[2]} ${c[3]}`),
  faltandoDoFonte: rotasFonte.filter((l) => !linhas.has(l)),
  duplicadas: j.length - linhas.size,
  problemas,
}, null, 2));
