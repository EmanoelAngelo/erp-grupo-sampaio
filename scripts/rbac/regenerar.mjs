// Regenera o mapa do RBAC granular sobre o HEAD desta árvore.
//
//   node scripts/rbac/regenerar.mjs
//
// A cadeia é a mesma que produziu o desenho (F0 do plano de implementação):
//
//   _inventario  → as rotas dos oito roteadores, com o guarda de hoje;
//   _resolver    → o conjunto de perfis que cada guarda alcança hoje;
//   _catalogo-def → o catálogo de entrada, o mapa rota → capability e os modelos dia 1;
//   _gen-sites-* / _gerar-sites-* / _tela-montar → as onze fatias (rotas, serviços, tela);
//   _consolidar  → catalogo-final.json, modelos.json, mapa-final.json e os relatórios;
//   _cenarios    → os cenários A–J medidos contra o mapa (só imprime).
//
// Tudo é escrito nesta pasta. Só lê a árvore; não toca em banco nem em servidor.
// Depois de regenerar, `node scripts/rbac/gerar-artefatos.mjs` reescreve os três
// arquivos que o código e os testes usam (Capabilities.ts, a tradução de
// requirePermission e a linha de base dos testes).
import { spawnSync } from 'node:child_process';
import { AQUI } from './_caminhos.mjs';

const PASSOS = [
  ['_inventario.mjs', '_inventario-rotas.tsv'],
  ['_resolver.mjs', '--escrever'],
  ['_catalogo-def.mjs'],
  ['_gen-sites-core-1.mjs'],
  ['_sites-core-2.mjs'],
  ['_sites-core-3.mjs'],
  ['_gerar-sites-core-4.mjs'],
  ['_sites-core-5.cjs'],
  ['_gerar-sites-core-6.mjs'],
  ['_conferir-sites-core-6.mjs'],
  ['_gerar-sites-core-7.mjs'],
  ['_gerar-sites-outros-roteadores.mjs'],
  ['_gerar-sites-servicos.mjs'],
  ['_gerar-sites-tela-botoes.mjs'],
  ['_tela-montar.mjs'],
  ['_consolidar.mjs'],
  ['_cenarios.mjs'],
];

for (const [script, ...args] of PASSOS) {
  console.log(`\n=== ${script}`);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: AQUI, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${script} saiu com ${r.status}: a cadeia para aqui.`);
    process.exit(r.status ?? 1);
  }
}
