// Cenários A–J como conjuntos de capabilities, medidos contra o mapa rota->capability.
// E a régua "só entrega o que tem" medida contra a hierarquia de hoje (HierarquiaDePerfis).
import fs from 'node:fs';
const mapa = fs.readFileSync('mapa-rota-capability.tsv', 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
const modelos = JSON.parse(fs.readFileSync('_modelos-dia1.json', 'utf8'));
const catalogo = JSON.parse(fs.readFileSync('catalogo.json', 'utf8'));
const TODAS = catalogo.map((c) => c.code);

function passa(expr, caps) {
  if (expr.startsWith('rotaPublica')) return true;
  const m = expr.match(/^(qualquer|todas)\((.*)\)$/);
  if (!m) return caps.has(expr);
  const cs = m[2].split(',').map((s) => s.trim());
  return m[1] === 'qualquer' ? cs.some((c) => caps.has(c)) : cs.every((c) => caps.has(c));
}
const guardadas = mapa.filter((r) => !r[6].startsWith('rotaPublica'));
const alcance = (caps) => guardadas.filter((r) => passa(r[6], caps));
const tem = (caps, m, p, f = 'core.ts') => {
  const r = guardadas.find((x) => x[0] === f && x[2] === m && x[3] === p);
  if (!r) return `?${m} ${p}`;
  return passa(r[6], caps) ? 'SIM' : 'nao';
};

const SOMENTE_PDV = ['pdv.sell', 'pdv.cash.operate', 'pdv.payment.charge', 'fiscal.sale.emit', 'customers.contact.view', 'integrations.card_terminal.view', 'integrations.card_terminal.operate'];
const CEN = {
  'A só PDV Preço Justo (modelo "Somente PDV")': SOMENTE_PDV,
  'B PDV PJ + PDV Gringa (mesmo modelo, 2 vínculos)': SOMENTE_PDV,
  'C todos os PDVs (mesmo modelo, 6 vínculos; na Oficina + workshop.checkout)': SOMENTE_PDV,
  'D PDVs + painel ("PDV + Painel")': [...SOMENTE_PDV, 'dashboard.view'],
  'E só Estoque ("Estoque")': ['inventory.view', 'inventory.manage', 'inventory.adjust.approve', 'inventory.units.view', 'inventory.units.manage'],
  'F Financeiro + Relatórios': ['finance.view', 'finance.advanced.view', 'finance.manage', 'finance.commissions.manage', 'finance.acquirers.manage', 'finance.bank_reconciliation.manage', 'reports.central.view', 'reports.bi.view'],
  'G só Oficina Kanban/OS (técnico)': ['workshop.kanban.view', 'workshop.orders.open', 'workshop.orders.move', 'workshop.orders.assume', 'workshop.orders.plan', 'workshop.parts.use', 'workshop.labor.manage', 'workshop.orders.complete', 'workshop.quote.request', 'workshop.equipment.view'],
  'H Kanban + PDV Oficina (caixa da oficina + técnico)': [...modelos.operador_caixa_oficina, 'workshop.orders.assume', 'workshop.orders.plan', 'workshop.parts.use', 'workshop.labor.manage', 'workshop.orders.complete'],
  'I gestor da Preço Justo (PDV, estoque, vendas, financeiro)': [...SOMENTE_PDV, 'dashboard.view', 'dashboard.money.view', 'sales.view', 'sales.supervise', 'sales.quotes.manage', 'sales.returns.operate', 'sales.cancel.direct', 'inventory.view', 'inventory.manage', 'inventory.adjust.approve', 'inventory.cost.view', 'products.view', 'finance.view', 'finance.advanced.view', 'finance.manage', 'approval.discount', 'approval.cash_withdrawal', 'approval.cash_reopen', 'approval.sale_cancel', 'approval.sale_return'],
  'J administrador do grupo': TODAS,
};
console.log('rotas guardadas (fora rotaPublica):', guardadas.length);
for (const [nome, lista] of Object.entries(CEN)) {
  const caps = new Set(lista);
  const n = alcance(caps).length;
  console.log(`\n${nome}: ${caps.size} capabilities, ${n} rotas`);
  console.log('  POST /sales', tem(caps, 'POST', '/sales'), '| POST /cash/open', tem(caps, 'POST', '/cash/open'),
    '| GET /products/search', tem(caps, 'GET', '/products/search'), '| GET /customers', tem(caps, 'GET', '/customers'),
    '| GET /dashboard', tem(caps, 'GET', '/dashboard'), '| GET /stock', tem(caps, 'GET', '/stock'),
    '| GET /finance/entries', tem(caps, 'GET', '/finance/entries'), '| PATCH /fiscal/config', tem(caps, 'PATCH', '/fiscal/config'),
    '| GET /team', tem(caps, 'GET', '/team'), '| GET /workshop/orders', tem(caps, 'GET', '/workshop/orders'),
    '| POST assume', tem(caps, 'POST', '/workshop/orders/:id/assume'), '| POST checkout', tem(caps, 'POST', '/workshop/orders/:id/checkout'),
    '| GET /insights/operations', tem(caps, 'GET', '/insights/operations'), '| POST /companies', tem(caps, 'POST', '/companies'));
}
// O PDV (tela) funciona com "Somente PDV"? As rotas que o PdvPage carrega.
const pdv = new Set(SOMENTE_PDV);
const doPdv = [['GET','/products/search'],['GET','/products/:id'],['GET','/customers'],['GET','/stock/locations'],['GET','/payment-methods'],['POST','/pricing/cart'],['GET','/sales/discount-policy'],['GET','/terminals'],['GET','/cash/open'],['POST','/cash/open'],['POST','/sales'],['POST','/print/jobs'],['GET','/units/:productId'],['POST','/authorizations'],['GET','/authorizations/quem-libera'],['POST','/fiscal/sales/:saleId/emit'],['POST','/pdv/terminal/charge'],['GET','/pdv/terminal/status']];
console.log('\nTela do PDV com "Somente PDV":', doPdv.map(([m, p]) => `${m} ${p}=${tem(pdv, m, p)}`).join(' | '));

// Régua "só entrega o que tem" contra a hierarquia de hoje.
const NIVEL = (p) => (['admin_geral', 'gestor'].includes(p) ? 2 : ['gerente_loja', 'gerente_oficina'].includes(p) ? 1 : 0);
const EXIGE = (p) => (['gerente_loja', 'gerente_oficina', 'mecanico', 'atendente', 'estoquista', 'operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'].includes(p) ? 1 : 2);
const perfis = Object.keys(modelos);
console.log('\nHoje permitido e QUEBRA pela régua de subconjunto (quem age -> alvo: capabilities que faltam a quem age):');
for (const ator of perfis) for (const alvo of perfis) {
  if (NIVEL(ator) < EXIGE(alvo)) continue;
  const falta = modelos[alvo].filter((c) => !modelos[ator].includes(c));
  if (falta.length) console.log(`  ${ator} -> ${alvo}: faltam ${falta.length} (${falta.slice(0, 6).join(', ')}${falta.length > 6 ? ', …' : ''})`);
}
console.log('\nHoje RECUSADO e passaria pela régua de subconjunto:');
for (const ator of perfis) for (const alvo of perfis) {
  if (NIVEL(ator) >= EXIGE(alvo)) continue;
  if (!['gerente_loja', 'gerente_oficina'].includes(ator)) continue;
  const falta = modelos[alvo].filter((c) => !modelos[ator].includes(c));
  if (!falta.length) console.log(`  ${ator} -> ${alvo}`);
}
