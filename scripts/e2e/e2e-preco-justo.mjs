// E2E DA PREÇO JUSTO contra a pilha DESCARTÁVEL (localhost:E2E_API_PORT, padrão 19592).
// Usa os LOGINS PADRÃO de verdade: 'ADMIN-PREÇO JUSTO' (gestor) e 'PREÇO JUSTO' (PDV), e o 'admin'.
// Nunca chama 8787/3000. Nunca imprime senha nem token.
import { randomBytes } from 'node:crypto';

const PORTA = Number(process.env.E2E_API_PORT ?? 19592);
if (PORTA === 8787 || PORTA === 3000) throw new Error('porta da instalação recusada');
const ORIGIN = `http://localhost:${PORTA}`;
const API = `${ORIGIN}/api/v1`;
const RUN = Date.now().toString(36);

const PROVISORIAS = { logins: process.env.E2E_LOGINS_PASSWORD ?? '', admin: process.env.E2E_ADMIN_PASSWORD ?? '' };
const SEGREDOS = new Set(Object.values(PROVISORIAS).filter(Boolean));
function limpar(txt) {
  let t = String(txt);
  for (const s of SEGREDOS) if (s && s.length >= 6) t = t.split(s).join('***');
  return t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>');
}

// ------------------------------------------------------------------- http
const carimbos = [];
async function freio() {
  for (;;) {
    const agora = Date.now();
    while (carimbos.length && agora - carimbos[0] > 60_000) carimbos.shift();
    if (carimbos.length < 250) break;
    await new Promise((r) => setTimeout(r, 60_000 - (agora - carimbos[0]) + 50));
  }
  carimbos.push(Date.now());
}
let totalReq = 0;
async function api(method, p, { token, body, headers = {} } = {}) {
  const url = `${API}${p}`;
  if (!url.startsWith(`${ORIGIN}/`)) throw new Error('host fora da pilha descartável');
  await freio();
  totalReq += 1;
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* não-JSON */ }
  if (json?.refreshToken) SEGREDOS.add(json.refreshToken);
  if (json?.accessToken) SEGREDOS.add(json.accessToken);
  return { status: r.status, body: json, text, method, path: p };
}

// --------------------------------------------------------------- relatório
const resultados = [];
function ev(res, campos = {}) {
  const partes = [`${res.method} ${res.path} -> HTTP ${res.status}`];
  const code = res.body?.error?.code;
  if (code) partes.push(`code=${code}`);
  for (const [k, v] of Object.entries(campos)) partes.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return partes.join(' ');
}
function check(id, desc, ok, evidencia, res) {
  const tag = ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL';
  let linha = `${tag} [${id}] ${desc} :: ${evidencia}`;
  if (tag === 'FAIL' && res?.text) linha += ` :: body=${res.text.slice(0, 400)}`;
  linha = limpar(linha);
  resultados.push({ id, tag, desc, linha });
  console.log(linha);
  return ok;
}
async function secao(nome, fn) {
  console.log(`\n=== ${nome}`);
  try { await fn(); } catch (e) { check(`${nome}.ABORT`, 'seção abortada por erro do script/pré-condição', false, limpar(e?.stack ?? String(e))); }
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;

// --------------------------------------------------------------- sessões
const novas = new Map();
function senhaNova(login) {
  if (!novas.has(login)) { const s = `Pj!${randomBytes(15).toString('base64url')}7q`; SEGREDOS.add(s); novas.set(login, s); }
  return novas.get(login);
}
const login = (l, password, companyId) => api('POST', '/auth/login', { body: { login: l, password, ...(companyId ? { companyId } : {}) } });
async function entrar(l, familia, companyId) {
  let r = await login(l, PROVISORIAS[familia], companyId);
  if (r.status === 200 && r.body?.user?.mustChangePassword) {
    const t = await api('POST', '/auth/password', { token: r.body.accessToken, body: { currentPassword: PROVISORIAS[familia], newPassword: senhaNova(l) } });
    if (t.status !== 204) throw new Error(`troca de senha de ${l}: HTTP ${t.status}`);
    r = await login(l, senhaNova(l), companyId);
  } else if (r.status === 200 && !r.body?.accessToken && r.body?.companies) {
    r = await login(l, PROVISORIAS[familia], r.body.companies[0].id);
  }
  if (r.status !== 200 || !r.body?.accessToken) throw new Error(`não entrou como ${l}: HTTP ${r.status} ${limpar(r.text).slice(0, 200)}`);
  return r.body;
}
async function sessaoNaEmpresa(l, companyId) {
  const r = await login(l, senhaNova(l), companyId);
  if (r.status !== 200 || r.body?.company?.id !== companyId) throw new Error(`login de ${l} na empresa ${companyId}: HTTP ${r.status}`);
  return r.body.accessToken;
}

// --------------------------------------------------------------- helpers
const nomes = new Map();
async function saldo(token, productId) {
  const termo = nomes.get(productId) ?? '';
  const r = await api('GET', `/core/stock?search=${encodeURIComponent(termo)}&limit=200`, { token });
  const it = (r.body?.items ?? []).find((i) => (i.product_id ?? i.productId ?? i.id) === productId);
  const q = it ? (it.quantity ?? it.stock_quantity ?? it.balance ?? it.on_hand) : null;
  return { r, q: q === undefined || q === null ? null : Number(q) };
}
const lembrar = (p) => { if (p?.id && p?.name) nomes.set(p.id, p.name); return p; };
async function buscar(token, termo) {
  const r = await api('GET', `/core/products/search?q=${encodeURIComponent(termo)}`, { token });
  return { r, itens: r.body?.items ?? [] };
}
const venda = (token, key, cashSessionId, items, payments, extra = {}) => api('POST', '/core/sales', {
  token, headers: { 'Idempotency-Key': key }, body: { cashSessionId, items, payments, ...extra },
});

// ===================================================================== main
const ctx = {};

await secao('0 saúde', async () => {
  const r = await api('GET', '/health');
  check('0.1', 'GET /health responde 200', r.status === 200, ev(r));
});

await secao('1 logins padrão', async () => {
  const g = await entrar('ADMIN-PREÇO JUSTO', 'logins');
  ctx.gestor = g.accessToken;
  ctx.PJ = g.company.id;
  check('1.1', 'ADMIN-PREÇO JUSTO entra na Preço Justo como gerente da loja', g.company.slug === 'preco-justo' && (g.companies ?? []).length === 1,
    `company=${g.company.slug} profile=${g.user?.profileCode} empresas=${(g.companies ?? []).map((c) => c.slug).join(',')}`);
  const c = await entrar('PREÇO JUSTO', 'logins');
  ctx.caixa = c.accessToken;
  check('1.2', 'PREÇO JUSTO entra só na Preço Justo como operador de caixa', c.company.slug === 'preco-justo' && c.user?.profileCode === 'operador_caixa_loja',
    `company=${c.company.slug} profile=${c.user?.profileCode}`);
  const a = await entrar('admin', 'admin');
  ctx.adminEmpresas = Object.fromEntries((a.companies ?? []).map((e) => [e.slug, e.id]));
  ctx.adminGringa = await sessaoNaEmpresa('admin', ctx.adminEmpresas.gringa);
  check('1.3', 'admin é global (enxerga as seis empresas)', Object.keys(ctx.adminEmpresas).length >= 6, `empresas=${Object.keys(ctx.adminEmpresas).join(',')}`);
});

await secao('2 cadastro e códigos', async () => {
  const cod = await api('POST', '/core/products/codes/next', { token: ctx.gestor, body: {} });
  check('2.1', '"Gerar código" devolve um código curto', cod.status === 200 && /^[A-Z]{1,4}-?\d{3,8}$/.test(cod.body?.code ?? ''), ev(cod, { code: cod.body?.code }), cod);
  const p = await api('POST', '/core/products', { token: ctx.gestor, body: {
    name: `Arroz Tipo 1 5kg E2E ${RUN}`, priceCents: 2490, costCents: 1700, internalCode: cod.body?.code, unit: 'UN',
    ncm: '10063021', origin: '0', cfop: '5102',
  } });
  check('2.2', 'produto cadastrado pelo gestor', p.status === 201, ev(p, { internal_code: p.body?.internal_code }), p);
  ctx.arroz = lembrar(p.body);
  const bar = await api('POST', `/core/products/${ctx.arroz.id}/barcode/internal`, { token: ctx.gestor, body: {} });
  check('2.3', 'produto sem EAN recebe código de barras interno EAN-13', bar.status === 200 && /^2\d{12}$/.test(bar.body?.barcode ?? ''), ev(bar, { barcode: bar.body?.barcode }), bar);
  ctx.arrozBarras = bar.body?.barcode;
  const fab = await api('POST', '/core/products', { token: ctx.gestor, body: { name: `Refrigerante 2L E2E ${RUN}`, priceCents: 999, barcode: '7894900011517' } });
  check('2.4', 'produto com EAN do fabricante', fab.status === 201 && fab.body?.barcode === '7894900011517', ev(fab), fab);
  ctx.refri = fab.body;
  const barFab = await api('POST', `/core/products/${ctx.refri.id}/barcode/internal`, { token: ctx.gestor, body: {} });
  check('2.5', 'gerar código interno NÃO substitui o EAN do fabricante', barFab.body?.barcode === '7894900011517', ev(barFab, { barcode: barFab.body?.barcode }), barFab);
  const dup = await api('POST', '/core/products', { token: ctx.gestor, body: { name: 'dup', priceCents: 100, barcode: '7894900011517' } });
  check('2.6', 'EAN duplicado recusado (409)', dup.status === 409, ev(dup), dup);
  const dupCod = await api('POST', '/core/products', { token: ctx.gestor, body: { name: 'dup2', priceCents: 100, internalCode: ctx.arroz.internal_code } });
  check('2.7', 'código interno duplicado recusado (409)', dupCod.status === 409, ev(dupCod), dupCod);
  const eanRuim = await api('POST', '/core/products', { token: ctx.gestor, body: { name: 'ean ruim', priceCents: 100, barcode: '7894900011518' } });
  check('2.8', 'EAN-13 com dígito verificador errado é recusado (4xx)', eanRuim.status >= 400 && eanRuim.status < 500, ev(eanRuim), eanRuim);
  const neg = await api('POST', '/core/products', { token: ctx.gestor, body: { name: 'preço negativo', priceCents: -1 } });
  check('2.9', 'preço negativo é recusado (4xx)', neg.status >= 400 && neg.status < 500, ev(neg), neg);
  const cods = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/core/products/codes/next', { token: ctx.gestor, body: {} })));
  const lista = cods.map((r) => r.body?.code);
  check('2.10', '6 "Gerar código" simultâneos devolvem 6 códigos distintos', new Set(lista).size === 6 && cods.every((r) => r.status === 200), `codes=${lista.join(',')}`);
});

await secao('3 entrada e etiquetas', async () => {
  const e = await api('POST', '/core/stock/movements', { token: ctx.gestor, body: {
    productId: ctx.arroz.id, movementType: 'in', quantity: 10, referenceType: 'entrada', referenceId: `nf-e2e-${RUN}`, unitCostCents: 1700,
  } });
  check('3.1', 'entrada de 10 unidades', e.status === 201, ev(e), e);
  const e2 = await api('POST', '/core/stock/movements', { token: ctx.gestor, body: {
    productId: ctx.arroz.id, movementType: 'in', quantity: 10, referenceType: 'entrada', referenceId: `nf-e2e-${RUN}`, unitCostCents: 1700,
  } });
  const s = await saldo(ctx.gestor, ctx.arroz.id);
  check('3.2', 'a MESMA entrada reenviada não soma de novo (saldo 10)', s.q === 10, ev(e2, { saldo: s.q }), e2);
  const m = await api('POST', '/core/labels/templates', { token: ctx.gestor, body: {
    name: `Rolo 2 colunas E2E ${RUN}`, midia: 'rolo', paperWidthMm: 64, widthMm: 30, heightMm: 20, columns: 2, gapXmm: 2, marginLeftMm: 1,
    fields: ['nome', 'preco', 'barras', 'codigo'], isDefault: true,
  } });
  check('3.3', 'modelo de etiqueta de 2 colunas criado pelo gestor', m.status === 201, ev(m), m);
  ctx.modelo = m.body?.id;
  const antes = await saldo(ctx.gestor, ctx.arroz.id);
  for (let vez = 1; vez <= 2; vez += 1) {
    const f = await api('POST', '/core/labels/sheet', { token: ctx.gestor, body: { templateId: ctx.modelo, items: [{ productId: ctx.arroz.id, quantity: 10 }] } });
    const html = String(f.body?.html ?? '');
    check(`3.4.${vez}`, `${vez === 1 ? 'imprimir' : 'reimprimir'} 10 etiquetas (2 colunas = 5 linhas, nome e barras em cada uma)`,
      f.status === 200 && f.body?.etiquetas === 10 && f.body?.folhas === 5 && (html.match(/class="etq"/g) ?? []).length === 10 && html.includes('Arroz Tipo 1') && /<svg|<img/.test(html),
      ev(f, { etiquetas: f.body?.etiquetas, folhas: f.body?.folhas }), f);
  }
  const depois = await saldo(ctx.gestor, ctx.arroz.id);
  check('3.5', 'imprimir/reimprimir etiqueta NÃO mexe no estoque', antes.q === depois.q && depois.q === 10, `antes=${antes.q} depois=${depois.q}`);
  const xss = await api('POST', '/core/products', { token: ctx.gestor, body: { name: `<img src=x onerror=alert(1)> E2E ${RUN}`, priceCents: 100 } });
  const fx = await api('POST', '/core/labels/sheet', { token: ctx.gestor, body: { templateId: ctx.modelo, items: [{ productId: xss.body?.id, quantity: 1 }] } });
  check('3.6', 'nome com HTML sai escapado na etiqueta', fx.status === 200 && !String(fx.body?.html ?? '').includes('<img src=x'), ev(fx), fx);
});

await secao('4 PDV: busca, caixa, venda, troco, cupom', async () => {
  const pe = await buscar(ctx.caixa, ctx.arrozBarras);
  check('4.1', 'o scanner acha pelo código de barras interno', pe.itens.length === 1 && pe.itens[0].id === ctx.arroz.id, ev(pe.r, { n: pe.itens.length }), pe.r);
  const pc = await buscar(ctx.caixa, ctx.arroz.internal_code);
  check('4.2', 'o código interno acha o produto', pc.itens.some((i) => i.id === ctx.arroz.id), ev(pc.r, { n: pc.itens.length }), pc.r);
  const sem = await venda(ctx.caixa, `sem-caixa-${RUN}`, 'caixa-que-nao-existe', [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 2490 }]);
  check('4.3', 'venda sem caixa aberto é recusada (4xx)', sem.status >= 400 && sem.status < 500, ev(sem), sem);
  const ab = await api('POST', '/core/cash/open', { token: ctx.caixa, body: { openingCents: 10000 } });
  check('4.4', 'abrir caixa com R$ 100,00', ab.status === 201, ev(ab), ab);
  ctx.gaveta = ab.body?.id ?? (await api('GET', '/core/cash/open', { token: ctx.caixa })).body?.session?.id;
  const ab2 = await api('POST', '/core/cash/open', { token: ctx.caixa, body: { openingCents: 5000 } });
  check('4.5', 'abrir o caixa de novo não cria segunda sessão (4xx)', ab2.status >= 400 && ab2.status < 500, ev(ab2), ab2);

  const trapaca = await venda(ctx.caixa, `trapaca-${RUN}`, ctx.gaveta,
    [{ productId: ctx.arroz.id, quantity: 1, unitPriceCents: 1, priceCents: 1 }], [{ method: 'dinheiro', amountCents: 2490 }], { totalCents: 1 });
  check('4.6', 'preço/total mandados pelo cliente são ignorados (total = cadastro)', trapaca.status !== 201 || trapaca.body?.total_cents === 2490,
    ev(trapaca, { total: trapaca.body?.total_cents }), trapaca);
  const curto = await venda(ctx.caixa, `curto-${RUN}`, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 100 }]);
  check('4.7', 'pagamento menor que o total é recusado (4xx)', curto.status >= 400 && curto.status < 500, ev(curto), curto);
  const cartaoAMais = await venda(ctx.caixa, `cartao-mais-${RUN}`, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'credito', amountCents: 5000 }]);
  check('4.8', 'cartão acima do total (troco em cartão) é recusado (4xx)', cartaoAMais.status >= 400 && cartaoAMais.status < 500, ev(cartaoAMais), cartaoAMais);

  const antes = await saldo(ctx.gestor, ctx.arroz.id);
  const v = await venda(ctx.caixa, `venda-${RUN}`, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 2 }], [{ method: 'dinheiro', amountCents: 5000 }]);
  check('4.9', 'venda de 2 × R$ 24,90 paga com R$ 50,00: total 49,80 e troco 0,20', v.status === 201 && v.body?.total_cents === 4980 && v.body?.change_cents === 20,
    ev(v, { total: v.body?.total_cents, troco: v.body?.change_cents }), v);
  ctx.venda = v.body;
  const depois = await saldo(ctx.gestor, ctx.arroz.id);
  check('4.10', 'a venda baixou exatamente 2', antes.q - depois.q === 2, `antes=${antes.q} depois=${depois.q}`);
  const pix = await venda(ctx.caixa, `pix-${RUN}`, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'pix', amountCents: 2490 }]);
  check('4.11', 'venda no PIX', pix.status === 201 && (pix.body?.change_cents ?? 0) === 0, ev(pix), pix);
  ctx.vendaPix = pix.body;
  const misto = await venda(ctx.caixa, `misto-${RUN}`, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'debito', amountCents: 1000 }, { method: 'dinheiro', amountCents: 2000 }]);
  check('4.12', 'pagamento misto débito + dinheiro com troco só do dinheiro (5,10)', misto.status === 201 && misto.body?.change_cents === 510, ev(misto, { troco: misto.body?.change_cents }), misto);

  const cons = await api('GET', `/core/sales/${ctx.venda?.id}`, { token: ctx.caixa });
  const aposConsulta = await saldo(ctx.gestor, ctx.arroz.id);
  check('4.13', 'consultar a venda devolve a venda e não mexe no estoque', cons.status === 200 && aposConsulta.q === depois.q - 2,
    ev(cons, { saldo: aposConsulta.q }), cons);
  const job = await api('POST', '/core/print/jobs', { token: ctx.caixa, body: { documentType: 'SALE_RECEIPT', documentId: ctx.venda?.id } });
  check('4.14', 'imprimir o comprovante (job de impressão)', job.status === 201, ev(job, { transport: job.body?.transport }), job);
  const doc = await api('GET', `/core/print/jobs/${job.body?.id}/document`, { token: ctx.caixa });
  const papel = doc.text ?? '';
  check('4.15', 'o papel diz COMPROVANTE NÃO FISCAL, traz Preço Justo, itens, Dinheiro e troco — e não diz NFC-e autorizada',
    papel.includes('COMPROVANTE NÃO FISCAL') && /Pre[cç]o Justo/i.test(papel) && papel.includes('Dinheiro') && /troco/i.test(papel) && !/NFC-e autorizada/i.test(papel),
    ev(doc, { bytes: papel.length }), doc);
  const re = await api('POST', `/core/print/jobs/${job.body?.id}/reprint`, { token: ctx.caixa, body: {} });
  const aposReimpressao = await saldo(ctx.gestor, ctx.arroz.id);
  check('4.16', 'reimprimir o comprovante não mexe no estoque', ok2xx(re) && aposReimpressao.q === aposConsulta.q, ev(re, { saldo: aposReimpressao.q }), re);
  // F-cupom-fiscal-20: o PDV guarda daqui a loja do comprovante offline (nome, CNPJ, endereço, telefone) e a bobina.
  const dr = await api('GET', '/core/print/drawer', { token: ctx.caixa });
  const loja = dr.body?.loja ?? {};
  check('4.17', 'a resposta da gaveta traz a loja do comprovante offline (nome, CNPJ, endereço, telefone) e a largura da bobina',
    dr.status === 200 && /Pre[cç]o Justo/i.test(loja.nome ?? '') && ['cnpj', 'endereco', 'telefone'].every((k) => k in loja)
      && [58, 80].includes(dr.body?.paperWidthMm),
    ev(dr, { loja: loja.nome, cnpj: loja.cnpj ? 'presente' : 'vazio', bobina: dr.body?.paperWidthMm }), dr);
});

await secao('5 offline equivalente: resposta perdida e reenvio da fila', async () => {
  const chave = `offline-${RUN}`;
  const antes = await saldo(ctx.gestor, ctx.arroz.id);
  const envios = await Promise.all([1, 2].map(() => venda(ctx.caixa, chave, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 2490 }])));
  const tarde = await venda(ctx.caixa, chave, ctx.gaveta, [{ productId: ctx.arroz.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 2490 }]);
  const ids = new Set([...envios, tarde].filter((r) => r.status === 201 || r.status === 200).map((r) => r.body?.id));
  const depois = await saldo(ctx.gestor, ctx.arroz.id);
  check('5.1', 'a mesma venda enviada 3 vezes (2 simultâneas + 1 atrasada) vira UMA venda', ids.size === 1, `status=${[...envios, tarde].map((r) => r.status).join(',')} ids=${ids.size}`);
  check('5.2', 'e baixa o estoque UMA vez', antes.q - depois.q === 1, `antes=${antes.q} depois=${depois.q}`);
});

await secao('6 concorrência: dois caixas, o último item', async () => {
  const p = await api('POST', '/core/products', { token: ctx.gestor, body: { name: `Último item E2E ${RUN}`, priceCents: 1000 } });
  lembrar(p.body);
  await api('POST', '/core/stock/movements', { token: ctx.gestor, body: { productId: p.body.id, movementType: 'in', quantity: 1, referenceType: 'entrada', referenceId: `ult-${RUN}`, unitCostCents: 500 } });
  const duas = await Promise.all(['a', 'b'].map((k) => venda(ctx.caixa, `ultimo-${k}-${RUN}`, ctx.gaveta, [{ productId: p.body.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 1000 }])));
  const s = await saldo(ctx.gestor, p.body.id);
  const ok = duas.filter((r) => r.status === 201).length;
  check('6.1', 'duas vendas simultâneas do último item: uma passa, a outra é recusada, saldo 0', ok === 1 && s.q === 0, `status=${duas.map((r) => r.status).join(',')} saldo=${s.q}`);
});

await secao('7 uma fonte de verdade: o gestor muda, o PDV vê', async () => {
  const put = await api('PUT', `/core/products/${ctx.refri.id}`, { token: ctx.gestor, body: { name: `Refrigerante Cola 2L E2E ${RUN}`, priceCents: 1099 } });
  const b = await buscar(ctx.caixa, '7894900011517');
  check('7.1', 'nome e preço alterados aparecem na próxima busca do PDV', ok2xx(put) && b.itens[0]?.name?.startsWith('Refrigerante Cola') && (b.itens[0]?.effective_price_cents ?? b.itens[0]?.price_cents) === 1099,
    ev(b.r, { nome: b.itens[0]?.name, preco: b.itens[0]?.price_cents }), b.r);
  const novoEan = await api('PUT', `/core/products/${ctx.refri.id}`, { token: ctx.gestor, body: { barcode: '7891000100103' } });
  const bNovo = await buscar(ctx.caixa, '7891000100103');
  const bVelho = await buscar(ctx.caixa, '7894900011517');
  // A-produto-08: trocar o código principal NÃO apaga o antigo — ele fica como código adicional,
  // para as etiquetas já coladas na prateleira continuarem bipando O MESMO produto.
  check('7.2', 'código de barras alterado: o novo acha o produto, e o antigo (já colado) continua achando O MESMO produto',
    ok2xx(novoEan) && bNovo.itens.some((i) => i.id === ctx.refri.id) && bVelho.itens.length === 1 && bVelho.itens[0].id === ctx.refri.id,
    ev(novoEan, { novo: bNovo.itens.length, velho: bVelho.itens.map((i) => i.id === ctx.refri.id ? 'mesmo' : 'OUTRO').join(',') }), novoEan);
  const ina = await api('PUT', `/core/products/${ctx.refri.id}`, { token: ctx.gestor, body: { active: false } });
  const bi = await buscar(ctx.caixa, '7891000100103');
  const vi = await venda(ctx.caixa, `inativo-${RUN}`, ctx.gaveta, [{ productId: ctx.refri.id, quantity: 1 }], [{ method: 'dinheiro', amountCents: 1099 }]);
  check('7.3', 'produto inativado some da busca e não é vendido', ok2xx(ina) && bi.itens.length === 0 && vi.status !== 201, ev(vi), vi);
});

await secao('8 permissões e isolamento pela API direta', async () => {
  const put = await api('PUT', `/core/products/${ctx.arroz.id}`, { token: ctx.caixa, body: { priceCents: 1 } });
  check('8.1', 'o PDV não altera preço (403)', put.status === 403, ev(put), put);
  const tpl = await api('POST', '/core/labels/templates', { token: ctx.caixa, body: { name: 'x', widthMm: 40, heightMm: 30, fields: ['nome'] } });
  check('8.2', 'o PDV não cria modelo de etiqueta (403)', tpl.status === 403, ev(tpl), tpl);
  const antesAjuste = await saldo(ctx.gestor, ctx.arroz.id);
  const mov = await api('POST', '/core/stock/movements', { token: ctx.caixa, body: { productId: ctx.arroz.id, movementType: 'out', quantity: 1, referenceType: 'ajuste', referenceId: `aj-${RUN}`, reason: 'teste' } });
  const entradaCaixa = await api('POST', '/core/stock/movements', { token: ctx.caixa, body: { productId: ctx.arroz.id, movementType: 'in', quantity: 50, referenceType: 'entrada', referenceId: `in-cx-${RUN}`, unitCostCents: 1 } });
  const depoisAjuste = await saldo(ctx.gestor, ctx.arroz.id);
  check('8.3', 'o PDV não ajusta nem dá entrada de estoque na mão (403) e o saldo não muda', mov.status === 403 && entradaCaixa.status === 403 && antesAjuste.q === depoisAjuste.q,
    `saida=${mov.status} entrada=${entradaCaixa.status} saldo=${antesAjuste.q}->${depoisAjuste.q}`, mov);
  const prt = await api('POST', '/core/print/printers', { token: ctx.caixa, body: { name: 'x', kind: 'etiqueta', transport: 'browser' } });
  check('8.4', 'o PDV não cadastra impressora (403)', prt.status === 403, ev(prt), prt);
  const outro = await api('POST', '/core/products', { token: ctx.adminGringa, body: { name: `Produto da Gringa E2E ${RUN}`, priceCents: 5000 } });
  const ver = await api('GET', `/core/products/${outro.body?.id}`, { token: ctx.gestor });
  const alt = await api('PUT', `/core/products/${outro.body?.id}`, { token: ctx.gestor, body: { priceCents: 1 } });
  const bus = await buscar(ctx.caixa, `Produto da Gringa E2E ${RUN}`);
  check('8.5', 'ADMIN-PREÇO JUSTO não lê nem altera produto da Gringa; o PDV não o acha', outro.status === 201 && [403, 404].includes(ver.status) && [403, 404].includes(alt.status) && bus.itens.length === 0,
    `criar=${outro.status} ler=${ver.status} alterar=${alt.status} busca=${bus.itens.length}`);
  const troca = await login('ADMIN-PREÇO JUSTO', senhaNova('ADMIN-PREÇO JUSTO'), ctx.adminEmpresas.gringa);
  check('8.6', 'ADMIN-PREÇO JUSTO não entra na Gringa', troca.status !== 200 || troca.body?.company?.id !== ctx.adminEmpresas.gringa, ev(troca));
  const criaCaixa = await api('POST', '/core/products', { token: ctx.caixa, body: { name: `Produto do caixa E2E ${RUN}`, priceCents: 1 } });
  check('8.7', 'o PDV não cadastra produto novo (403)', criaCaixa.status === 403, ev(criaCaixa), criaCaixa);
  const nfeCaixa = await api('POST', '/core/purchases/nfe/preview', { token: ctx.caixa, body: { xml: '<nfeProc/>' } });
  const notasCaixa = await api('GET', '/core/purchases/notes', { token: ctx.caixa });
  check('8.8', 'o PDV não importa NF-e nem lê as notas de entrada (403)', nfeCaixa.status === 403 && notasCaixa.status === 403, `preview=${nfeCaixa.status} notas=${notasCaixa.status}`, nfeCaixa);
  const barrasCaixa = await api('POST', `/core/products/${ctx.arroz.id}/barcode`, { token: ctx.caixa, body: {} });
  check('8.9', 'o PDV não grava código de barras no cadastro (403)', barrasCaixa.status === 403, ev(barrasCaixa), barrasCaixa);
  const etqCaixa = await api('POST', '/core/labels/sheet', { token: ctx.caixa, body: { templateId: ctx.modelo, items: [{ productId: ctx.arroz.id, quantity: 1 }] } });
  check('8.10', 'o PDV continua reimprimindo etiqueta de produto (200) — operacional, não altera o cadastro', etqCaixa.status === 200, ev(etqCaixa), etqCaixa);
  const antesTipo = await saldo(ctx.gestor, ctx.arroz.id);
  const tipoRuim = await api('POST', '/core/stock/movements', { token: ctx.gestor, body: { productId: ctx.arroz.id, movementType: 'reserve', quantity: 5, referenceType: 'manual', referenceId: `tipo-${RUN}` } });
  const depoisTipo = await saldo(ctx.gestor, ctx.arroz.id);
  check('8.11', 'movimento manual com direção inventada é recusado (400) e o saldo não muda', tipoRuim.status === 400 && tipoRuim.body?.error?.code === 'CORE_MOVEMENT_TYPE_INVALID' && antesTipo.q === depoisTipo.q,
    ev(tipoRuim, { saldo: `${antesTipo.q}->${depoisTipo.q}` }), tipoRuim);
});

await secao('9 devolução sem duplicar e carrinho abandonado', async () => {
  const ficha = await api('GET', `/core/sales/${ctx.venda?.id}`, { token: ctx.gestor });
  const linha = (ficha.body?.items ?? []).find((i) => (i.product_id ?? i.productId) === ctx.arroz.id);
  check('9.0', 'a ficha da venda traz as linhas gravadas', ficha.status === 200 && !!linha, ev(ficha, { itens: (ficha.body?.items ?? []).length }), ficha);
  const antes = await saldo(ctx.gestor, ctx.arroz.id);
  const chave = `devolucao-${RUN}`;
  // Preço Justo em duas etapas (ligada pelo bootstrap): a devolução registra a mercadoria, com o motivo da lista.
  const corpo = { saleId: ctx.venda?.id, reasonCode: 'desistencia', reasonNote: 'E2E: cliente desistiu de 1 unidade', items: [{ saleItemId: linha?.id, quantity: 1, restock: true, condition: 'intacto' }] };
  const d1 = await api('POST', '/core/sale-returns', { token: ctx.gestor, body: corpo, headers: { 'Idempotency-Key': chave } });
  const d2 = await api('POST', '/core/sale-returns', { token: ctx.gestor, body: corpo, headers: { 'Idempotency-Key': chave } });
  const depois = await saldo(ctx.gestor, ctx.arroz.id);
  const idDe = (r) => r.body?.id ?? r.body?.return?.id ?? r.body?.devolucao?.id;
  check('9.1', 'a devolução reenviada com a MESMA chave vira UMA devolução (mesmo id)', ok2xx(d1) && ok2xx(d2) && idDe(d1) && idDe(d1) === idDe(d2),
    `status=${d1.status},${d2.status} ids=${idDe(d1)}|${idDe(d2)}`, ok2xx(d1) ? d2 : d1);
  check('9.2', 'e o estoque volta UMA vez (+1)', antes.q !== null && depois.q === antes.q + 1, `antes=${antes.q} depois=${depois.q}`);
  ctx.devolucao = idDe(d1);
  const antesAb = await saldo(ctx.gestor, ctx.arroz.id);
  const ab = await api('POST', '/core/sales/abandoned', { token: ctx.caixa, body: { saleKey: `abandono-${RUN}`, items: [{ productId: ctx.arroz.id, name: 'Arroz Tipo 1 5kg', quantity: 1, unitPriceCents: 2490 }] } });
  const depoisAb = await saldo(ctx.gestor, ctx.arroz.id);
  check('9.3', 'o F6 com carrinho montado deixa rastro (201) e não mexe no estoque', ab.status === 201 && antesAb.q === depoisAb.q, ev(ab, { saldo: `${antesAb.q}->${depoisAb.q}` }), ab);
});

await secao('10 devolução em duas etapas: reembolso, caixa, estoque, fiscal e fechamento', async () => {
  const esperado = async () => Number((await api('GET', `/core/cash/${ctx.gaveta}/summary`, { token: ctx.caixa })).body?.expectedCents);
  const ficha = await api('GET', `/core/sale-returns/${ctx.devolucao}`, { token: ctx.gestor });
  const reemb = ficha.body?.reembolso;
  check('10.1', 'a devolução registrou a MERCADORIA e deixou o reembolso PENDENTE',
    ficha.status === 200 && reemb?.fluxo === 'duas_etapas' && reemb?.situacao === 'pendente' && ficha.body?.mercadoria?.situacao === 'concluida',
    ev(ficha, { situacao: reemb?.situacao, pendente: reemb?.pendenteCents }), ficha);
  const valor = Number(reemb?.pendenteCents);
  const antes = await esperado();
  const saldoAntes = await saldo(ctx.gestor, ctx.arroz.id);
  const chave = `reembolso-${RUN}`;
  const duas = await Promise.all([1, 2].map(() => api('POST', `/core/sale-returns/${ctx.devolucao}/refunds`, {
    token: ctx.gestor, body: { method: 'dinheiro', amountCents: valor }, headers: { 'Idempotency-Key': chave },
  })));
  const depois = await esperado();
  const saldoDepois = await saldo(ctx.gestor, ctx.arroz.id);
  const final = duas.find((r) => r.status === 201) ?? duas[0];
  check('10.2', 'REGISTRAR DEVOLUÇÃO AO CLIENTE em dinheiro, clicado 2× com a mesma chave: UM registro e reembolso CONCLUÍDO',
    duas.map((r) => r.status).sort().join(',') === '200,201' && (final.body?.reembolso?.registros ?? []).length === 1 && final.body?.reembolso?.situacao === 'concluido',
    `status=${duas.map((r) => r.status).join(',')} registros=${(final.body?.reembolso?.registros ?? []).length}`, final);
  check('10.3', 'o dinheiro devolvido baixa o esperado do caixa exatamente uma vez', depois === antes - valor, `esperado ${antes} -> ${depois} (reembolso ${valor})`);
  check('10.4', 'o reembolso não mexe no estoque', saldoAntes.q !== null && saldoAntes.q === saldoDepois.q, `saldo ${saldoAntes.q} -> ${saldoDepois.q}`);

  const fichaPix = await api('GET', `/core/sales/${ctx.vendaPix?.id}`, { token: ctx.gestor });
  const linhaPix = (fichaPix.body?.items ?? [])[0];
  const devPix = await api('POST', '/core/sale-returns', {
    token: ctx.gestor,
    body: { saleId: ctx.vendaPix?.id, reasonCode: 'defeito', items: [{ saleItemId: linhaPix?.id, quantity: 1, restock: false, condition: 'avariado' }] },
    headers: { 'Idempotency-Key': `devpix-${RUN}` },
  });
  check('10.5', 'avariado NÃO volta ao estoque disponível, e o fiscal é um estado à parte (venda não fiscal)',
    devPix.status === 201 && devPix.body?.mercadoria?.estoque === 'nao_retornou' && devPix.body?.fiscal?.estado === 'nao_fiscal',
    ev(devPix, { estoque: devPix.body?.mercadoria?.estoque, fiscal: devPix.body?.fiscal?.estado }), devPix);
  const antesPix = await esperado();
  const parcial = await api('POST', `/core/sale-returns/${devPix.body?.id}/refunds`, {
    token: ctx.gestor, body: { method: 'pix', amountCents: 1000, reference: `E2E-${RUN}` }, headers: { 'Idempotency-Key': `pix1-${RUN}` },
  });
  const depoisPix = await esperado();
  check('10.6', 'PIX manual parcial: PARCIAL, saldo pendente certo, e o dinheiro da gaveta não muda',
    parcial.status === 201 && parcial.body?.reembolso?.situacao === 'parcial' && parcial.body?.reembolso?.pendenteCents === devPix.body?.total_cents - 1000 && antesPix === depoisPix,
    ev(parcial, { situacao: parcial.body?.reembolso?.situacao, pendente: parcial.body?.reembolso?.pendenteCents, esperado: `${antesPix}->${depoisPix}` }), parcial);
  const demais = await api('POST', `/core/sale-returns/${devPix.body?.id}/refunds`, {
    token: ctx.gestor, body: { method: 'pix', amountCents: devPix.body?.total_cents }, headers: { 'Idempotency-Key': `pix2-${RUN}` },
  });
  check('10.7', 'reembolso acima do saldo pendente é recusado (409)', demais.status === 409 && demais.body?.error?.code === 'CORE_REFUND_EXCEEDS_PENDING', ev(demais), demais);
  const peloCaixa = await api('POST', `/core/sale-returns/${devPix.body?.id}/refunds`, {
    token: ctx.caixa, body: { method: 'pix', amountCents: 100 }, headers: { 'Idempotency-Key': `pix3-${RUN}` },
  });
  check('10.8', 'o PDV (PREÇO JUSTO) não registra reembolso (403)', peloCaixa.status === 403, ev(peloCaixa), peloCaixa);

  const resumo = await api('GET', `/core/cash/${ctx.gaveta}/summary`, { token: ctx.caixa });
  const esp = Number(resumo.body?.expectedCents);
  // O turno NÃO fecha calado devendo ao cliente: a devolução em PIX registrada
  // acima ficou sem reembolso, e a primeira tentativa volta 409 nomeando a dívida.
  const recusado = await api('POST', `/core/cash/${ctx.gaveta}/close`, { token: ctx.caixa, body: { countedCents: esp - 1000 } });
  check('10.9', 'fechar com devolução sem reembolso é recusado, e a recusa nomeia a dívida',
    recusado.status === 409 && recusado.body?.error?.code === 'CORE_CASH_CLOSE_ELECTRONIC_PENDING'
      && /devolu[çc][ãa]o/i.test(String(recusado.body?.error?.message ?? '')),
    ev(recusado, { motivo: String(recusado.body?.error?.message ?? '').slice(0, 120) }), recusado);

  const fechado = await api('POST', `/core/cash/${ctx.gaveta}/close`, {
    token: ctx.caixa,
    body: { countedCents: esp - 1000, pendenciasCiente: true, pendenciasMotivo: 'o gerente confere o extrato amanhã cedo' },
  });
  check('10.10', 'fechamento com ciência declarada: o operador VÊ o esperado, informa o contado, e o sistema mostra a falta de R$ 10,00',
    resumo.status === 200 && Number.isFinite(esp) && fechado.status === 200 && fechado.body?.expected_cents === esp && fechado.body?.difference_cents === -1000,
    ev(fechado, { esperado: esp, contado: esp - 1000, diferenca: fechado.body?.difference_cents }), fechado);
});

await secao('11 fiscal do balcão (P0): o selo diz o que falta, o PDV só consulta', async () => {
  const r = await api('GET', '/core/fiscal/pdv-summary', { token: ctx.caixa });
  const faltas = r.body?.faltas ?? [];
  check('11.1', 'o operador de caixa lê o resumo fiscal: situação, frase com o que falta e quem resolve, item a item',
    r.status === 200 && typeof r.body?.resumo === 'string' && faltas.length > 0 && faltas.every((f) => f.texto && f.quemResolve && f.onde),
    ev(r, { situacao: r.body?.situacao, ambiente: r.body?.ambiente, faltas: faltas.map((f) => `${f.key}:${f.quemResolve}`) }), r);
  check('11.2', 'o resumo do balcão não carrega segredo nem arquivo do certificado',
    r.status === 200 && !/encrypted|pfx|keyPem|cscToken|password/i.test(r.text), `bytes=${r.text.length}`, r);

  const cert = await api('GET', '/core/fiscal/certificate', { token: ctx.caixa });
  const envio = await api('POST', '/core/fiscal/certificate', { token: ctx.caixa, body: { pfxBase64: 'AAAA', certificatePassword: 'x' } });
  check('11.3', 'o PDV não lê nem envia certificado A1 (403 nos dois)', cert.status === 403 && envio.status === 403, `${ev(cert)} | ${ev(envio)}`, envio);
  const envioGerente = await api('POST', '/core/fiscal/certificate', { token: ctx.gestor, body: { pfxBase64: 'AAAA', certificatePassword: 'x' } });
  check('11.4', 'o gerente da loja também não envia o A1 — é do painel administrativo (403)', envioGerente.status === 403, ev(envioGerente), envioGerente);

  const antes = await api('GET', '/core/fiscal/series', { token: ctx.gestor });
  const atual = ((antes.body?.items ?? []).find((i) => i.model === '65')?.series ?? []).find((s) => s.serie === 1)?.nextNumber ?? 1;
  const prod = await api('POST', '/core/fiscal/series', { token: ctx.gestor, body: { model: '65', serie: 1, nextNumber: atual, environment: 'production' } });
  const hom = await api('POST', '/core/fiscal/series', { token: ctx.gestor, body: { model: '65', serie: 2, nextNumber: 1, environment: 'homologation' } });
  const lista = await api('GET', '/core/fiscal/series', { token: ctx.gestor });
  const nfce = (lista.body?.items ?? []).find((i) => i.model === '65')?.series ?? [];
  check('11.5', 'numeração por ambiente: NFC-e série 1 só produção (número intacto) e série 2 só homologação',
    prod.status === 200 && hom.status === 200
      && nfce.find((s) => s.serie === 1)?.environment === 'production' && nfce.find((s) => s.serie === 1)?.nextNumber === atual
      && nfce.find((s) => s.serie === 2)?.environment === 'homologation',
    ev(lista, { series: nfce.map((s) => `${s.serie}:${s.environment}:${s.nextNumber}`) }), lista);
  const depois = await api('GET', '/core/fiscal/pdv-summary', { token: ctx.caixa });
  check('11.6', 'com a série de homologação no lugar, o selo do balcão não cobra série',
    depois.status === 200 && !(depois.body?.faltas ?? []).some((f) => f.key === 'serie'),
    ev(depois, { faltas: (depois.body?.faltas ?? []).map((f) => f.key) }), depois);
  const errado = await api('POST', '/core/fiscal/series', { token: ctx.gestor, body: { model: '65', serie: 3, nextNumber: 1, environment: 'producao' } });
  check('11.7', 'ambiente inventado na série é recusado com motivo (400)',
    errado.status === 400 && errado.body?.error?.code === 'CORE_FISCAL_ENVIRONMENT_INVALID', ev(errado), errado);
});

await secao('12 plaquinhas só na PJ Motors (P0)', async () => {
  // O admin alcança tudo pelo perfil: a recusa dele prova que quem barra é a REGRA DA EMPRESA.
  const tokenNaEmpresa = async (l, familia, companyId) => {
    for (const s of [senhaNova(l), PROVISORIAS[familia]]) {
      const r = await login(l, s, companyId);
      if (r.status === 200 && r.body?.company?.id === companyId) return r.body.accessToken;
    }
    throw new Error(`login de ${l} na empresa ${companyId} falhou`);
  };
  const ids = ctx.adminEmpresas ?? {};
  const caixa = await api('GET', '/core/equipment-tags?status=disponivel', { token: ctx.caixa });
  check('12.1', 'o PDV da Preço Justo não alcança plaquinha (403)', caixa.status === 403, ev(caixa), caixa);
  const layout = await api('GET', '/core/equipment-tags/layout', { token: ctx.gestor });
  const lotes = await api('GET', '/core/equipment-tags/batches', { token: ctx.gestor });
  check('12.2', 'o gestor da Preço Justo não alcança pool, lotes nem layout de plaquinha (403)',
    layout.status === 403 && lotes.status === 403, `${ev(layout)} | ${ev(lotes)}`, layout);

  const adminPj = await tokenNaEmpresa('admin', 'admin', ids['preco-justo']);
  const naPj = await api('GET', '/core/equipment-tags', { token: adminPj });
  check('12.3', 'nem o admin do grupo vê plaquinha DENTRO da Preço Justo (403 CORE_COMPANY_NO_TAGS)',
    naPj.status === 403 && naPj.body?.error?.code === 'CORE_COMPANY_NO_TAGS', ev(naPj), naPj);
  const ligar = await api('PATCH', `/core/companies/${ids['preco-justo']}/equipment-tags`, { token: adminPj, body: { enabled: true } });
  check('12.4', 'ligar plaquinha na Preço Justo é recusado (403 CORE_COMPANY_TAGS_PJ_ONLY)',
    ligar.status === 403 && ligar.body?.error?.code === 'CORE_COMPANY_TAGS_PJ_ONLY', ev(ligar), ligar);

  if (ids.oficina) {
    const adminOf = await tokenNaEmpresa('admin', 'admin', ids.oficina);
    const naOficina = await api('GET', '/core/equipment-tags', { token: adminOf });
    check('12.5', 'a Oficina também não gerencia plaquinha (403 CORE_COMPANY_NO_TAGS)',
      naOficina.status === 403 && naOficina.body?.error?.code === 'CORE_COMPANY_NO_TAGS', ev(naOficina), naOficina);
  }
  if (ids['pj-motors']) {
    const adminPjm = await tokenNaEmpresa('admin', 'admin', ids['pj-motors']);
    const naPjm = await api('GET', '/core/equipment-tags', { token: adminPjm });
    check('12.6', 'na PJ Motors o pool de plaquinhas responde (200)', naPjm.status === 200, ev(naPjm), naPjm);
  } else {
    check('12.6', 'na PJ Motors o pool de plaquinhas responde', null, 'PJ Motors não está na pilha descartável');
  }
});

await secao('13 etiquetas da Preço Justo (P0): saídas, teste, lote, histórico e reimpressão', async () => {
  const cat = await api('GET', '/core/labels/catalog', { token: ctx.gestor });
  const perfis = (cat.body?.perfis ?? []).map((p) => p.id);
  const SETE = ['navegador', 'driver_windows', 'termica_generica', 'pdf', 'zpl', 'epl', 'tspl'];
  check('13.1', 'o catálogo traz as sete saídas e a lista do que depende de homologação física',
    cat.status === 200 && SETE.every((id) => perfis.includes(id)) && (cat.body?.homologacao ?? []).length > 0,
    ev(cat, { perfis, homologacao: (cat.body?.homologacao ?? []).length }), cat);

  const teste = (perfil, formatId) => api('POST', '/core/labels/test', { token: ctx.gestor, body: { perfil, formatId } });
  const zpl = await teste('zpl', 'rolo_50x30');
  const cmdZpl = String(zpl.body?.comandos ?? '').trim();
  check('13.2', 'etiqueta de teste em ZPL no rolo 50×30: ^XA…^XZ e arquivo para baixar',
    zpl.status === 200 && cmdZpl.startsWith('^XA') && cmdZpl.includes('^XZ') && Boolean(zpl.body?.arquivo?.base64),
    ev(zpl, { mime: zpl.body?.arquivo?.mime, avisos: (zpl.body?.avisos ?? []).length }), zpl);
  const tspl = await teste('tspl', 'rolo_50x30');
  const epl = await teste('epl', 'rolo_50x30');
  check('13.3', 'TSPL (SIZE…PRINT) e EPL (…P1) saem do mesmo layout',
    tspl.status === 200 && /SIZE/.test(tspl.body?.comandos ?? '') && /PRINT/.test(tspl.body?.comandos ?? '')
      && epl.status === 200 && /\bP\d+/.test(epl.body?.comandos ?? ''),
    `${ev(tspl)} | ${ev(epl)}`, tspl.status === 200 ? epl : tspl);
  const pdf = await teste('pdf', 'a4_63x25_3x11');
  const cabecaPdf = pdf.body?.arquivo?.base64 ? Buffer.from(pdf.body.arquivo.base64, 'base64').subarray(0, 4).toString('latin1') : '';
  check('13.4', 'PDF vetorial da folha A4 3×11 começa com %PDF', pdf.status === 200 && cabecaPdf === '%PDF',
    ev(pdf, { mime: pdf.body?.arquivo?.mime, cabeca: cabecaPdf }), pdf);
  const zplNaFolha = await teste('zpl', 'a4_63x25_3x11');
  const inventado = await teste('ppla', 'rolo_50x30');
  check('13.5', 'térmica em folha A4 é recusada com motivo (400), e saída inventada também (400)',
    zplNaFolha.status === 400 && inventado.status === 400 && inventado.body?.error?.code === 'CORE_LABEL_PROFILE_UNKNOWN',
    `${ev(zplNaFolha)} | ${ev(inventado)}`, zplNaFolha.status === 400 ? inventado : zplNaFolha);

  const lote = await api('POST', '/core/labels/sheet', {
    token: ctx.gestor, body: { perfil: 'zpl', formatId: 'rolo_100x30_2', items: [{ productId: ctx.arroz?.id, quantity: 3 }] },
  });
  check('13.6', 'lote de 3 etiquetas de um produto no rolo de 2 colunas, em ZPL', lote.status === 200 && lote.body?.etiquetas === 3,
    ev(lote, { etiquetas: lote.body?.etiquetas, avisos: lote.body?.avisos }), lote);

  const hist = await api('GET', '/core/labels/prints', { token: ctx.gestor });
  const doLote = (hist.body?.items ?? []).find((h) => (h.items ?? []).some((i) => i.productId === ctx.arroz?.id));
  check('13.7', 'o histórico diz quem imprimiu, quando, o quê e quantas',
    hist.status === 200 && Boolean(doLote?.userId) && Boolean(doLote?.createdAt) && (doLote?.items ?? []).some((i) => Number(i.quantity) === 3),
    ev(hist, { registros: (hist.body?.items ?? []).length, perfil: doLote?.perfil }), hist);
  const re = doLote
    ? await api('POST', `/core/labels/prints/${doLote.id}/reprint`, { token: ctx.gestor, body: { perfil: 'tspl' } })
    : { status: 0, body: null, text: '', method: 'POST', path: '/core/labels/prints/?/reprint' };
  check('13.8', 'reimprimir do histórico em outra saída: as mesmas 3 etiquetas', re.status === 200 && re.body?.etiquetas === 3,
    ev(re, { etiquetas: re.body?.etiquetas }), re);
});

const soma = resultados.reduce((acc, r) => ({ ...acc, [r.tag]: (acc[r.tag] ?? 0) + 1 }), {});
console.log(`\nRESUMO run=${RUN} ${JSON.stringify(soma)} requisicoes=${totalReq} (todas para ${ORIGIN})`);
process.exit(soma.FAIL ? 1 : 0);
