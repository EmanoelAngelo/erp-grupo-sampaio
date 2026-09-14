// Monta sites-tela-rotas-menu.json. node _tela-montar.mjs
import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
import { LISTAS, ROTA, alcanceTela, alcanceCap, diffDia1 } from './_tela-base.mjs';
import { ROTAS_A } from './_tela-rotas-a.mjs';
import { ROTAS_B } from './_tela-rotas-b.mjs';
import { MENU } from './_tela-menu.mjs';
import { MECANISMOS } from './_tela-mecanismos.mjs';
const DIR = PASTA_RBAC;
const REPO = REPO_DA_ARVORE;

// linha do `{` → linha do `label:` (a linha citada é a do rótulo)
const LINHA_DO_ROTULO = { 339: 340, 345: 348, 355: 356, 360: 361, 366: 367, 371: 372, 377: 378, 387: 388, 394: 421,
  427: 437, 443: 449, 457: 458, 463: 466, 473: 476, 481: 489, 497: 498, 504: 507, 512: 516, 520: 521, 525: 529,
  534: 535, 540: 541, 549: 550, 555: 565, 570: 574, 580: 581, 585: 586, 593: 594, 601: 602, 609: 610, 615: 616,
  621: 622, 630: 631, 634: 635, 647: 648, 664: 668, 673: 674, 679: 680, 685: 686, 696: 735, 739: 746, 752: 755,
  761: 794, 800: 803, 809: 813, 822: 823, 833: 834, 839: 840, 848: 849, 856: 857, 865: 866, 870: 885, 890: 893,
  898: 912, 920: 921, 924: 930, 934: 938, 943: 946, 950: 953, 958: 961, 969: 973, 981: 984, 989: 992, 997: 1001,
  1006: 1010, 1015: 1019, 1024: 1046 };

const sites = [];
const envTxt = (envs) => `[${envs.map((e) => `'${e}'`).join(', ')}]`;
for (const [linha, caminho, rota, lista, cap, escopo, nota] of [...ROTAS_A, ...ROTAS_B]) {
  const perfis = alcanceTela(ROTA[rota], lista ? LISTAS[lista] : undefined);
  sites.push({ arquivo: 'src/router/gsRoutes.tsx', linha, tipo: 'tela-rota', tela: caminho,
    guarda_hoje: `protectedRoute('${caminho}', …, ${rota}${lista ? `, ${lista}` : ''}) → <Protected environments=${envTxt(ROTA[rota])}${lista ? ` profiles=${lista}` : ''}>`,
    perfis_hoje: perfis, capability: cap, escopo, nota: `${nota} ${diffDia1(perfis, cap)}` });
}
for (const [l0, rotulo, to, envs, lista, cap, escopo, nota] of MENU) {
  const linha = LINHA_DO_ROTULO[l0] ?? l0;
  const perfis = alcanceTela(envs, lista ? LISTAS[lista] : undefined);
  const g = `menu "${rotulo}"${to ? ` → ${to}` : ''}: environments ${envTxt(envs)}${lista ? `, profiles ${lista}` : ''} (filtrado em AppShell.tsx:31-58)`;
  sites.push({ arquivo: 'src/components/gs/navItems.ts', linha, tipo: 'tela-menu', tela: to ?? `(grupo/pendente) ${rotulo}`,
    guarda_hoje: g, perfis_hoje: perfis, capability: cap, escopo, nota: `${nota} ${diffDia1(perfis, cap)}` });
}
for (const [arquivo, linha, tipo, extra, guarda, perfis, cap, escopo, nota] of MECANISMOS) {
  const s = { arquivo, linha, tipo, ...extra, guarda_hoje: guarda, perfis_hoje: perfis, capability: cap, escopo, nota };
  sites.push(s);
}
// conferências
const vistos = new Set();
for (const s of sites) {
  const k = `${s.arquivo}:${s.linha}:${s.tipo}`;
  if (vistos.has(k)) throw new Error(`duplicado ${k}`);
  vistos.add(k);
  if (!['rota', 'servico', 'tela-rota', 'tela-menu', 'tela-botao', 'atalho-admin', 'publica'].includes(s.tipo)) throw new Error(s.tipo);
  if (!['empresa', 'grupo', 'pdv', 'bancada'].includes(s.escopo)) throw new Error(s.escopo);
  alcanceCap(s.capability); // lança se o code não existe
  const texto = fs.readFileSync(`${REPO}/${s.arquivo}`, 'utf8').split('\n')[s.linha - 1] ?? '';
  s._conferencia = texto.trim().slice(0, 90);
}
const out = sites.map(({ _conferencia, ...s }) => s);
fs.writeFileSync(`${DIR}/sites-tela-rotas-menu.json`, JSON.stringify(out, null, 2));
if (process.argv[2] === '--linhas') for (const s of sites) console.log(`${s.arquivo.split('/').pop()}:${s.linha}\t${s.tela ?? ''}\t| ${s._conferencia}`);
const porTipo = {};
for (const s of out) porTipo[s.tipo] = (porTipo[s.tipo] || 0) + 1;
console.log('total', out.length, JSON.stringify(porTipo));
console.log('desvios dia-1:', out.filter((s) => s.nota.includes('DESVIO')).map((s) => `${s.tipo} ${s.linha} ${s.tela}`).join('\n  '));
