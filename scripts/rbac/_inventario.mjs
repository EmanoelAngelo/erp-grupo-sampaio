import { AQUI as PASTA_RBAC, REPO as REPO_DA_ARVORE, BASE as BASE_DA_ARVORE } from './_caminhos.mjs';
import fs from 'node:fs';
const root = REPO_DA_ARVORE + '/server/src/routes/v1/';
const files = ['core.ts','nfse.ts','payment-terminals.ts','logistics.ts','system-admin.ts','index.ts','storefront.ts','auth.ts'];
const out = [];
for (const f of files) {
  const txt = fs.readFileSync(root + f, 'utf8');
  const lines = txt.split('\n');
  const starts = [];
  const re = /^\s*(\w+Router|router|app)\.(get|post|put|patch|delete)\(\s*$|^\s*(\w+Router|router|app)\.(get|post|put|patch|delete)\(\s*(['`])([^'`]+)\5/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    let method, path;
    if (m[2]) { method = m[2]; const n = lines[i+1].match(/^\s*(['`])([^'`]+)\1/); path = n ? n[2] : '?'; }
    else { method = m[4]; path = m[6]; }
    starts.push({ i, method, path, router: m[1] || m[3] });
  }
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k+1].i : Math.min(lines.length, s.i + 400);
    const region = lines.slice(s.i, end).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const g = region.match(/(requireProfile|abertaAo|requirePermission|rotaPublica|requireProfileNfse|exigirPerfil)\s*\(/);
    let guard = '-', args = '';
    if (g) {
      guard = g[1];
      let p = g.index + g[0].length, depth = 1, a = '';
      while (p < region.length && depth > 0) { const c = region[p]; if (c==='(') depth++; else if (c===')') { depth--; if (!depth) break; } a += c; p++; }
      args = a.replace(/\s+/g,' ').replace(/^req,?\s*/,'').trim();
    }
    const extras = [];
    for (const h of ['comLiberacaoPontual','resolveWorkshopScope','resolveWorkshop(','isManagerProfile','terminalDoPedido','operacoesOndeOPerfilAbre','podeVerDinheiro','veCusto','assertPodeAtribuir']) if (region.includes(h)) extras.push(h.replace('(',''));
    out.push([f, s.i+1, s.method.toUpperCase(), s.path, guard, args, extras.join(',')].join('\t'));
  }
}
fs.writeFileSync(process.argv[2], 'file\tline\tmethod\tpath\tguard\targs\textras\n' + out.join('\n'));
console.log('routes', out.length);
const byFile = {}; for (const r of out) { const f = r.split('\t')[0]; byFile[f]=(byFile[f]||0)+1; } console.log(byFile);
const byGuard = {}; for (const r of out) { const c = r.split('\t'); const key = c[4]+'('+c[5]+')'; byGuard[key]=(byGuard[key]||0)+1; }
console.log(Object.entries(byGuard).sort((a,b)=>b[1]-a[1]).map(([k,v])=>v+'  '+k).join('\n'));
