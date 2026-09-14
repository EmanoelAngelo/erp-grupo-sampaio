import fs from 'node:fs';
const AB = { gerente_loja:'L', gerente_oficina:'O', estoquista:'E', atendente:'T', operador_caixa:'C', operador_caixa_loja:'CL', operador_caixa_oficina:'CO', mecanico:'M', contador:'K' };
const CONST = {
  CAIXAS:['operador_caixa','operador_caixa_loja','operador_caixa_oficina'],
  BALCAO:['operador_caixa','operador_caixa_loja','operador_caixa_oficina'],
  BALCAO_E_GERENCIA:['operador_caixa','operador_caixa_loja','operador_caixa_oficina','gerente_loja','gerente_oficina'],
  AUX_EDITORES:['gerente_loja','gerente_oficina','estoquista'],
  GERENCIA:['gerente_loja','gerente_oficina'],
};
const AMB = { balcao:CONST.CAIXAS, bancada:['mecanico'], escritorio:['gerente_loja','gerente_oficina','estoquista','atendente'], contabilidade:['contador'] };
const PT = { // Permissions.ts MODULOS: ler / escrever
  fiscal:{ler:['estoquista','atendente','gerente_oficina'],esc:['gerente_loja']},
  'payment-terminal':{ler:['atendente'],esc:['gerente_loja','operador_caixa','operador_caixa_loja','operador_caixa_oficina']},
  crm:{ler:['estoquista'],esc:['gerente_loja','atendente']},
  'corporate-bi':{ler:['gerente_loja','gerente_oficina'],esc:[]},
  logistics:{ler:['atendente'],esc:['gerente_loja','estoquista']},
  asaas:{ler:['atendente'],esc:['gerente_loja']},
};
const LEIT = new Set(['view','list','status','health','readiness','preview','export']);
const PT_GERENCIA = new Set([227,244,258,271,285,312,342,360,403,515,566]);
export function resolve(file, guard, args, line) {
  const r0 = resolve0(file, guard, args);
  if (file==='payment-terminals.ts' && PT_GERENCIA.has(Number(line))) { const k=r0.split(',').filter(x=>x==='L'||x==='O'); return k.length?k.join(','):'DONOS'; }
  return r0;
}
function resolve0(file, guard, args) {
  if (guard === 'rotaPublica') return 'PUBLICA';
  if (guard === '-') return 'SEM_GUARDA';
  let set = [];
  if (guard === 'abertaAo') { for (const a of args.split(',').map(s=>s.trim().replace(/'/g,''))) set.push(...(AMB[a]||['?'+a])); }
  else if (guard === 'requireProfile') {
    for (let t of args.split(',').map(s=>s.trim()).filter(t=>t && t!=='req')) {
      if (t.startsWith('...')) set.push(...(CONST[t.slice(3)]||['?'+t])); else set.push(t.replace(/'/g,''));
    }
  } else if (guard === 'requirePermission') {
    const p = args.replace(/'/g,''); const mod = p.split('.')[0]; const ac = p.split('.').pop(); const r = PT[mod];
    if (!r) set = []; else set = LEIT.has(ac) ? [...r.ler, ...r.esc] : [...r.esc];
    set = [...new Set(set)];
  }
  const u = [...new Set(set)].map(p=>AB[p]||p).sort();
  return u.length ? u.join(',') : 'DONOS';
}
if (process.argv[2]) {
  const rows = fs.readFileSync('_inventario-rotas.tsv','utf8').split('\n').slice(1).map(l=>l.split('\t'));
  const out = rows.map(r => ({f:r[0], l:r[1], m:r[2], p:r[3], g:r[4], a:r[5], set: resolve(r[0], r[4], r[5], r[1])}));
  fs.writeFileSync('_rotas-resolvidas.json', JSON.stringify(out));
  const core = out.filter(r=>r.f==='core.ts').sort((a,b)=>a.p.localeCompare(b.p));
  for (const r of core) console.log(`${r.l}\t${r.m}\t${r.p}\t${r.set}`);
}
