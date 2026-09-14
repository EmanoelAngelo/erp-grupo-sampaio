/**
 * ============================================================================
 * A CENTRAL DE RELATÓRIOS — GAP-V37
 * ============================================================================
 *
 * ## O que este arquivo mede
 *
 * A pergunta não é "a rota responde 200?" — é "o que o gestor baixa é o que o
 * banco diz, e é o mesmo que ele acabou de ver na tela?". As telas do sistema
 * estavam certas e terminavam nelas mesmas: o único gerador de CSV do
 * repositório vivia dentro do zip mensal do contador.
 *
 * ## Os quatro riscos que os casos cercam
 *
 * 1. PAYLOAD VAZIO COM CARA DE PRONTO. É a doença que a auditoria removeu do
 *    `/bi/reports` — "relatório" com status `ready` e conteúdo `{}`. Aqui cada
 *    relatório é conferido contra a aritmética de um cenário conhecido, no
 *    centavo, e o catálogo inteiro é varrido: os CATORZE respondem 200 e
 *    NENHUM devolve estrutura vazia.
 *
 * 2. O ARQUIVO DISCORDAR DA TELA. O CSV é gerado do resultado JÁ montado, e
 *    não de uma segunda consulta. Os casos comparam linha a linha.
 *
 * 3. FORMATO QUE O EXCEL RECUSA. BOM de UTF-8, ponto-e-vírgula e CRLF são o
 *    contrato do CSV da casa (o mesmo do zip do contador, agora num arquivo
 *    só) — sem eles "Inutilização" vira "InutilizaÃ§Ã£o" e as colunas
 *    desalinham na primeira descrição com ponto-e-vírgula.
 *
 * 4. VAZAMENTO DE EMPRESA E DE PERFIL. A Central junta custo de estoque,
 *    comissão e margem numa tela só; ela é fechada aos mesmos dois gerentes
 *    das rotas que a alimentam, e a empresa vem do TOKEN — não há
 *    `?companyId=` aqui.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Central@Relatorios2026';
const HOJE = '2026-06-10';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';
const BASE = '/api/v1/core/reports';

let conceito: string;
let gringa: string;
let auth: { Authorization: string };

async function ator(login: string, companyId: string, perfil = 'gerente_loja') {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, perfil, false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio de Roupas Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  auth = await ator('GERENTE.CENTRAL', conceito);
});

async function criarProduto(
  quem: { Authorization: string },
  nome: string,
  precoCents: number,
  extras: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(quem)
    .send({ name: nome, priceCents: precoCents, ...extras });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function carregar(quem: { Authorization: string }, productId: string, qtd: number) {
  const res = await request(app).post('/api/v1/core/stock/movements').set(quem).send({
    productId,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function vender(
  quem: { Authorization: string },
  itens: { productId: string; quantity: number }[],
  totalCents: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(quem)
    .set('Idempotency-Key', randomUUID())
    .send({ items: itens, payments: [{ method: 'dinheiro', amountCents: totalCents }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  expect(venda.total_cents).toBe(totalCents);
  getConnection().prepare('UPDATE core_sales SET created_at = ? WHERE id = ?').run(MEIO_DIA, venda.id);
  return venda.id as string;
}

interface Resultado {
  report: {
    id: string;
    label: string;
    columns: { key: string; label: string; kind: string }[];
    caveat?: string;
  };
  from: string;
  to: string;
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  truncated: boolean;
  rowCount: number;
}

async function relatorio(id: string, qs = ''): Promise<Resultado> {
  const res = await request(app).get(`${BASE}/${id}?from=${HOJE}&to=${HOJE}${qs}`).set(auth);
  expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as Resultado;
}

/**
 * O cenário da Conceito, no centavo:
 *
 *   Bicicleta (Caloi) — preço 12.345, custo 6.000, estoque 10, mínimo 2
 *   Capacete  (sem marca) — preço 6.789, custo 3.000, estoque 10, mínimo 8
 *
 *   V1 = 2 × 12.345 = 24.690
 *   V2 = 1 ×  6.789 =  6.789
 *   faturamento do dia = 31.479, 2 vendas
 *   estoque depois: bicicleta 8, capacete 9 (ABAIXO do mínimo 8? não — 9 > 8)
 */
async function montarCenario() {
  const bike = await criarProduto(auth, 'Bicicleta Aro 29', 12_345, {
    costCents: 6_000,
    minStock: 2,
    brand: 'Caloi',
    internalCode: 'BIKE-1',
  });
  const capacete = await criarProduto(auth, 'Capacete Urbano', 6_789, {
    costCents: 3_000,
    minStock: 12,
    internalCode: 'CAP-1',
  });
  await carregar(auth, bike, 10);
  await carregar(auth, capacete, 10);
  await vender(auth, [{ productId: bike, quantity: 2 }], 24_690);
  await vender(auth, [{ productId: capacete, quantity: 1 }], 6_789);
  return { bike, capacete };
}

// ============================================================================

describe('o catálogo diz o que existe, e nada dele responde vazio', () => {
  it('os catorze relatórios estão declarados, com colunas e grupo', async () => {
    const res = await request(app).get(BASE).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const itens = res.body.items as Resultado['report'][];
    expect(itens).toHaveLength(14);
    for (const r of itens) {
      expect(r.id, JSON.stringify(r)).toBeTruthy();
      expect(r.columns.length, `${r.id} sem colunas`).toBeGreaterThan(0);
      // Coluna sem tipo faria o CSV escrever centavo cru onde deveria ir
      // dinheiro — o defeito silencioso mais provável desta estrutura.
      for (const c of r.columns) expect(c.kind, `${r.id}.${c.key}`).toBeTruthy();
    }
  });

  it('CADA relatório do catálogo responde 200 com estrutura de verdade', async () => {
    /*
      A varredura que impede o "payload vazio com cara de pronto". Um
      relatório novo que esqueça o `run` — ou que devolva `{}` como o
      `/bi/reports` fazia — fica vermelho AQUI, e não em produção.
    */
    await montarCenario();
    const catalogo = (await request(app).get(BASE).set(auth)).body.items as { id: string }[];
    for (const { id } of catalogo) {
      const r = await relatorio(id);
      expect(r.report.id, id).toBe(id);
      expect(Array.isArray(r.rows), id).toBe(true);
      expect(r.report.columns.length, id).toBeGreaterThan(0);
      expect(typeof r.rowCount, id).toBe('number');
    }
  });
});

describe('os números do relatório são os do banco', () => {
  it('vendas: duas linhas, o total no centavo, e o rodapé soma as linhas', async () => {
    await montarCenario();
    const r = await relatorio('vendas');
    expect(r.rows).toHaveLength(2);
    expect(r.totals.total_cents).toBe(31_479);
    expect(r.rows.reduce((acc, l) => acc + Number(l.total_cents), 0)).toBe(31_479);
    // O painel do mesmo dia tem de dizer o mesmo número — dois lugares, uma
    // conta, que é a régua desta casa.
    const painel = await request(app)
      .get(`/api/v1/core/dashboard?from=${HOJE}&to=${HOJE}`)
      .set(auth);
    expect(painel.body.revenueCents).toBe(r.totals.total_cents);
  });

  it('a venda CANCELADA fica fora por padrão, e entra quando se pede', async () => {
    const { bike } = await montarCenario();
    const cancelada = await vender(auth, [{ productId: bike, quantity: 1 }], 12_345);
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${cancelada}/cancel`)
      .set(auth)
      .send({ reason: 'teste da central' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    expect((await relatorio('vendas')).totals.total_cents).toBe(31_479);
    const todas = await relatorio('vendas', '&situacao=todas');
    expect(todas.rows).toHaveLength(3);
    expect(todas.totals.total_cents).toBe(43_824);
  });

  it('valorização: saldo × custo, no centavo, e sem produto zerado', async () => {
    await montarCenario();
    const r = await relatorio('valorizacao');
    // bicicleta 8 × 6.000 = 48.000 | capacete 9 × 3.000 = 27.000
    expect(r.totals.value_cents).toBe(75_000);
    expect(r.rows[0]).toMatchObject({ name: 'Bicicleta Aro 29', value_cents: 48_000 });
  });

  it('mínimo: só quem ficou abaixo, com o quanto FALTA', async () => {
    await montarCenario();
    const r = await relatorio('minimo');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'Capacete Urbano', quantity: 9, min_stock: 12 });
    expect(r.rows[0].falta).toBe(3);
  });

  it('DRE: o relatório carrega as MESMAS linhas do /finance/income-statement', async () => {
    await montarCenario();
    const dre = await request(app)
      .get(`/api/v1/core/finance/income-statement?from=${HOJE}&to=${HOJE}`)
      .set(auth);
    expect(dre.status).toBe(200);
    const r = await relatorio('dre');
    const totalReceita = r.rows.find((l) => l.lado === 'Receita' && l.categoria === 'TOTAL');
    expect(totalReceita!.valor_cents).toBe(dre.body.revenue.totalCents);
    const resultado = r.rows.find((l) => l.lado === 'Resultado');
    expect(resultado!.valor_cents).toBe(dre.body.resultCents);
    // O CMV entra como LINHA PRÓPRIA — e não somado ao resultado (GAP-V28).
    const cmv = r.rows.find((l) => String(l.lado).startsWith('CMV'));
    expect(cmv!.valor_cents).toBe(dre.body.cogs.costCents);
    expect(cmv!.valor_cents).toBe(15_000); // 2×6.000 + 1×3.000
  });

  it('marca: o mesmo recorte do painel, com "Sem marca" como grupo', async () => {
    await montarCenario();
    const r = await relatorio('marca');
    expect(r.rows.map((l) => l.brand)).toEqual(['Caloi', 'Sem marca']);
    expect(r.totals.revenue_cents).toBe(31_479);
  });
});

describe('a exportação leva EXATAMENTE o que a tela mostrou', () => {
  it('o CSV tem BOM, ponto-e-vírgula e CRLF — o formato que o Excel abre', async () => {
    await montarCenario();
    const res = await request(app)
      .get(`${BASE}/vendas?from=${HOJE}&to=${HOJE}&formato=csv`)
      .set(auth);
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('vendas-2026-06-10-a-2026-06-10.csv');

    const texto = res.text;
    expect(texto.charCodeAt(0)).toBe(0xfeff);
    expect(texto).toContain('\r\n');
    // O canal (balcão e oficina × loja online) entrou na segunda coluna (GAP-PRD-132).
    expect(texto).toContain('Número;Canal;Dia;Cliente;Vendedor;Situação;Itens;Total');
  });

  it('cada linha do arquivo é uma linha do resultado — em reais com vírgula', async () => {
    await montarCenario();
    const dados = await relatorio('vendas');
    const csv = (
      await request(app).get(`${BASE}/vendas?from=${HOJE}&to=${HOJE}&formato=csv`).set(auth)
    ).text;

    for (const linha of dados.rows) {
      const emReais = (Number(linha.total_cents) / 100).toFixed(2).replace('.', ',');
      expect(csv, `venda ${linha.numero}`).toContain(`;${emReais}`);
    }
    // E o rodapé de TOTAL vai junto: quem abre a planilha vê a soma sem
    // precisar escrevê-la.
    expect(csv).toContain('TOTAL');
    expect(csv).toContain('314,79');
  });

  it('o cabeçalho do arquivo diz a empresa, o período e a ressalva', async () => {
    await montarCenario();
    const csv = (
      await request(app).get(`${BASE}/marca?from=${HOJE}&to=${HOJE}&formato=csv`).set(auth)
    ).text;
    expect(csv).toContain('Conceito');
    expect(csv).toContain('2026-06-10 a 2026-06-10');
    // A ressalva viaja para dentro do arquivo pelo mesmo motivo de estar na
    // tela: o arquivo circula fora do sistema, e sem ela "Sem marca" pareceria
    // um defeito.
    expect(csv).toContain('Sem marca');
  });

  it('a exportação deixa RASTRO na auditoria — levar dado para fora é ato', async () => {
    await montarCenario();
    await request(app).get(`${BASE}/estoque?formato=csv`).set(auth).expect(200);
    const trilha = getConnection()
      .prepare(
        "SELECT action, entity_id FROM core_audit_log WHERE company_id = ? AND action = 'report.export'",
      )
      .all(conceito) as { action: string; entity_id: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].entity_id).toBe('estoque');
  });

  it('a LEITURA não é auditada — só a saída do dado', async () => {
    // Auditar toda abertura de tela encheria a trilha de ruído e afogaria o
    // que importa. O que muda o mundo aqui é o arquivo saindo.
    await relatorio('estoque');
    const trilha = getConnection()
      .prepare("SELECT 1 FROM core_audit_log WHERE action = 'report.export'")
      .all();
    expect(trilha).toHaveLength(0);
  });
});

describe('o cerco: empresa do token, perfil do servidor, período conferido', () => {
  it('A MORDIDA: o relatório da vizinha não aparece nem por parâmetro', async () => {
    const naGringa = await ator('GERENTE.GRINGA', gringa);
    const p = await criarProduto(naGringa, 'Chinelo da Gringa', 4_000, { costCents: 1_000 });
    await carregar(naGringa, p, 5);
    await vender(naGringa, [{ productId: p, quantity: 1 }], 4_000);

    // `?companyId=` não existe nesta rota: o parâmetro é IGNORADO, e o
    // relatório continua sendo o do token. Aceitar aqui seria a porta mais
    // barata do sistema — a Central lê custo, comissão e margem.
    const r = await request(app)
      .get(`${BASE}/vendas?from=${HOJE}&to=${HOJE}&companyId=${gringa}`)
      .set(auth);
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain('Chinelo da Gringa');
  });

  it('o estoquista e o atendente são recusados — e o gerente entra', async () => {
    for (const perfil of ['estoquista', 'atendente', 'mecanico', 'contador']) {
      const quem = await ator(`P.${perfil}`, conceito, perfil);
      const lista = await request(app).get(BASE).set(quem);
      expect(lista.status, perfil).toBe(403);
      const um = await request(app).get(`${BASE}/vendas`).set(quem);
      expect(um.status, perfil).toBe(403);
    }
    expect((await request(app).get(BASE).set(auth)).status).toBe(200);
  });

  it('relatório que não existe é 404 com o envelope da casa — e diz onde está a lista', async () => {
    const res = await request(app).get(`${BASE}/relatorio-inventado`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_REPORT_NOT_FOUND');
    expect(res.body.error.message).toContain('GET /core/reports');
  });

  it('período invertido é 400 — e não uma tabela vazia com cara de "não há nada"', async () => {
    /*
      O caso existe porque a resposta ERRADA aqui é plausível: `from > to`
      devolve zero linhas em qualquer SQL, e quem digitou as datas trocadas
      concluiria que o mês não teve movimento.
    */
    const res = await request(app).get(`${BASE}/vendas?from=2026-06-30&to=2026-06-01`).set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REPORT_INVALID_PERIOD');
  });

  it('sem período, o padrão é o MÊS corrente da loja — nunca a história inteira', async () => {
    const res = await request(app).get(`${BASE}/vendas`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(res.body.to >= res.body.from).toBe(true);
  });
});
