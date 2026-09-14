/**
 * ============================================================================
 * UMA GRAFIA SÓ PARA O RECORTE DA MARCA — e o painel que não vira mata de barras
 * ============================================================================
 *
 * ## O defeito, e por que ele estava dormindo
 *
 * O SELECT da agregação por marca é COMPARTILHADO de propósito: `sqlDeMarcas`
 * existe para que "marca da linha" queira dizer a mesma coisa no painel de uma
 * operação e no BI do grupo — o comentário do painel diz isso com todas as
 * letras ("duas grafias do mesmo agrupamento seriam duas telas discordando
 * sobre o mesmo dia").
 *
 * O SELECT era compartilhado. O WHERE não:
 *
 *   painel (`GET /core/dashboard`)      →  `s.status = 'completed'`
 *   BI     (`GET /core/insights/brands`)→  `s.status <> 'cancelled'`
 *
 * Hoje as duas frases significam o mesmo conjunto POR ACIDENTE: `core_sales` só
 * recebe 'completed' (no INSERT da venda) ou 'cancelled' (no UPDATE do
 * cancelamento). No dia em que nascer um terceiro status — devolvida, em
 * espera, estornada —, o painel o exclui e o BI o inclui, e duas telas passam a
 * discordar sobre o mesmo dia SEM ninguém tocar em nenhuma das duas. Lista por
 * complemento: `<> 'cancelled'` diz quem está fora, e "quem está fora" muda
 * sozinho quando alguém acrescenta um valor.
 *
 * O primeiro caso deste arquivo é uma FALSIFICAÇÃO: ele cria a venda com o
 * terceiro status à mão, direto no banco de teste, e cobra que as duas
 * superfícies respondam o mesmo número. Sem o conserto, elas discordam.
 *
 * ## O segundo defeito: `byBrand` sem teto
 *
 * `topProducts` e `bySeller` do painel são `LIMIT 10`, e `topBrands` do BI é
 * limitado a 200. `byBrand` não tinha limite nenhum: catálogo com centenas de
 * marcas renderiza centenas de barras na tela que o gestor abre todo dia.
 *
 * E o corte tinha de ser feito SEM criar uma mentira nova: a linha
 * `byBrandUnallocatedCents` é o desconto de rodapé que não pertence a marca
 * nenhuma, e se a soma das barras encolhesse ela engordaria em silêncio,
 * passando a carregar marcas inteiras. Por isso o excedente vira uma LINHA
 * NOMEADA ("Outras N marcas") em vez de sumir: a soma continua fechando com o
 * faturamento, e quem lê vê o que ficou fora.
 *
 * ## Como este guarda falha (quebrando de propósito — conferido)
 *
 *   - troque `RECORTE_DA_VENDA_QUE_FATURA` por `s.status <> 'cancelled'` em
 *     `topBrands`: o caso da falsificação fica vermelho, com o BI contando a
 *     venda 'devolvida' que o painel não conta;
 *   - troque o mesmo por `s.status = 'completed'` só no painel: idem, do outro
 *     lado;
 *   - devolva `byBrand` ao SELECT sem teto: o caso das quinze marcas volta a
 *     ver quinze barras.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import {
  STATUS_QUE_FATURAM,
  TETO_DE_MARCAS_NO_PAINEL,
} from '../src/services/core/GroupInsights.js';

const app = createApp();
const SENHA = 'Marca@UmaGrafia2026';
const HOJE = '2026-06-10';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';

let conceito: string;
let auth: { Authorization: string };

async function ator(login: string, companyId: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function criarProduto(nome: string, precoCents: number, brand?: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, brand });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function carregar(productId: string, qtd: number): Promise<void> {
  const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${productId}-${randomUUID()}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function vender(productId: string, totalCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: totalCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  getConnection()
    .prepare('UPDATE core_sales SET created_at = ? WHERE id = ?')
    .run(MEIO_DIA, venda.id);
  return venda.id as string;
}

interface LinhaDeMarca {
  brand: string;
  quantity: number;
  revenue_cents: number;
  sales_count: number;
}

async function painel(): Promise<{
  revenueCents: number;
  byBrand: LinhaDeMarca[];
  byBrandUnallocatedCents: number;
}> {
  const res = await request(app).get(`/api/v1/core/dashboard?from=${HOJE}&to=${HOJE}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function biDoGrupo(): Promise<LinhaDeMarca[]> {
  const res = await request(app).get('/api/v1/core/insights/brands').set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as LinhaDeMarca[];
}

function somar(linhas: LinhaDeMarca[]): number {
  return linhas.reduce((acc, l) => acc + Number(l.revenue_cents), 0);
}

beforeEach(async () => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  auth = await ator('GERENTE.UMA.GRAFIA', conceito);
});

// ===========================================================================

describe('painel e BI recortam a venda com a MESMA frase', () => {
  it('hoje eles concordam — a linha de base, para o caso seguinte medir algo', async () => {
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    await vender(p, 20_000);

    const daTela = await painel();
    expect(somar(daTela.byBrand)).toBe(20_000);
    expect(somar(await biDoGrupo())).toBe(20_000);
  });

  it('FALSIFICAÇÃO — o TERCEIRO status não pode separar as duas superfícies', async () => {
    /*
      A venda com status inventado entra direto no banco de teste: é o futuro
      que a lista por complemento promete. `<> 'cancelled'` a INCLUI e
      `= 'completed'` a EXCLUI — e nenhuma das duas telas teria mudado.

      O conserto escolhe o lado explícito: fatura quem está NA LISTA de quem
      fatura, e um status novo nasce fora dela até alguém decidir o contrário —
      no `Record` total que não compila sem a decisão.
    */
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    const vendida = await vender(p, 20_000);
    const terceira = await vender(p, 20_000);
    getConnection()
      .prepare("UPDATE core_sales SET status = 'devolvida' WHERE id = ?")
      .run(terceira);

    const daTela = await painel();
    const doBi = await biDoGrupo();

    expect(
      somar(doBi),
      'o BI e o painel discordaram sobre o mesmo dia: uma grafia inclui o status novo e a outra não',
    ).toBe(somar(daTela.byBrand));
    // E o lado escolhido é o explícito: só quem está declarado como faturamento.
    expect(somar(daTela.byBrand)).toBe(20_000);
    expect(vendida).toBeTruthy();
  });

  it('a venda CANCELADA continua fora dos dois — o conserto não afrouxou nada', async () => {
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    await vender(p, 20_000);
    const cancelada = await vender(p, 20_000);
    const res = await request(app)
      .post(`/api/v1/core/sales/${cancelada}/cancel`)
      .set(auth)
      .send({ reason: 'teste da grafia' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(somar((await painel()).byBrand)).toBe(20_000);
    expect(somar(await biDoGrupo())).toBe(20_000);
  });
});

describe('o painel não desenha uma barra por marca do catálogo', () => {
  /** Uma marca a mais que o teto — o mínimo para o corte existir. */
  const QUANTAS = TETO_DE_MARCAS_NO_PAINEL + 5;

  async function venderUmaDeCadaMarca(): Promise<number> {
    let total = 0;
    for (let i = 0; i < QUANTAS; i += 1) {
      // Preços diferentes para a ordem por faturamento ser determinística: a
      // marca 0 é a maior, e as últimas são as que caem no balde "Outras".
      const preco = (QUANTAS - i) * 1_000;
      const p = await criarProduto(`Peça ${i}`, preco, `Marca ${String(i).padStart(2, '0')}`);
      await carregar(p, 2);
      await vender(p, preco);
      total += preco;
    }
    return total;
  }

  it('corta no teto e NOMEIA o excedente — em vez de somar centenas de barras', async () => {
    const faturamento = await venderUmaDeCadaMarca();
    const daTela = await painel();

    expect(daTela.revenueCents).toBe(faturamento);
    // O teto, mais a linha do excedente. Nunca uma barra por marca do catálogo.
    expect(
      daTela.byBrand.length,
      'o painel desenhou uma barra por marca — com centenas delas isso é a tela inteira',
    ).toBe(TETO_DE_MARCAS_NO_PAINEL + 1);

    const excedente = daTela.byBrand[daTela.byBrand.length - 1];
    expect(excedente.brand).toContain('Outras');
    expect(excedente.brand).toContain(String(QUANTAS - TETO_DE_MARCAS_NO_PAINEL));
  });

  it('A MORDIDA DO CORTE: a soma das barras + o não alocado continua sendo o faturamento', async () => {
    /*
      O risco do teto é criar uma mentira nova: se as marcas cortadas
      simplesmente sumissem, `byBrandUnallocatedCents` — que é o desconto de
      rodapé sem dono — engordaria com marcas inteiras, e a legenda da tela
      passaria a chamar mercadoria de desconto.
    */
    const faturamento = await venderUmaDeCadaMarca();
    const daTela = await painel();
    expect(somar(daTela.byBrand) + daTela.byBrandUnallocatedCents).toBe(faturamento);
    expect(daTela.byBrandUnallocatedCents).toBe(0);
  });

  it('a quantidade do excedente é a soma REAL das marcas que ele representa', async () => {
    await venderUmaDeCadaMarca();
    const daTela = await painel();
    const excedente = daTela.byBrand[daTela.byBrand.length - 1];
    // Uma peça por marca cortada — e o `sales_count` é contado no banco, com
    // DISTINCT, e não somado das linhas (uma venda que toca duas marcas contaria
    // duas vezes).
    expect(excedente.quantity).toBe(QUANTAS - TETO_DE_MARCAS_NO_PAINEL);
    expect(excedente.sales_count).toBe(QUANTAS - TETO_DE_MARCAS_NO_PAINEL);
  });

  it('com poucas marcas NÃO existe linha de excedente — o corte não inventa balde', async () => {
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    await vender(p, 20_000);
    const daTela = await painel();
    expect(daTela.byBrand).toHaveLength(1);
    expect(daTela.byBrand[0].brand).toBe('Farm');
  });
});

// ===========================================================================
// A GARANTIA DE COMPILAÇÃO COBRIA UMA CONSULTA DE CINCO — NA MESMA ROTA
// ===========================================================================

/**
 * ## O defeito
 *
 * `RECORTE_DA_VENDA_QUE_FATURA` entrou por DENTRO de `sqlDeMarcas` e a promessa
 * foi "um status novo quebra a COMPILAÇÃO". A promessa vale para `byBrand`. As
 * outras QUATRO consultas da MESMA rota do painel seguiam com
 * `status = 'completed'` escrito à mão: `totals`, `byDay`, `topProducts` e
 * `bySeller`.
 *
 * O dia em que alguém marcar um terceiro status como `true` no `Record FATURA`,
 * o arquivo COMPILA, `byBrand` cresce, `totals.revenue_cents` não, e
 * `byBrandUnallocatedCents = totals.revenue_cents − somaDasMarcas` fica
 * NEGATIVO — e a tela renderiza qualquer valor não-zero desse campo como
 * "desconto ou acréscimo de rodapé". Mercadoria virando desconto, exatamente a
 * mentira que o corte por teto foi desenhado para não criar.
 *
 * O guarda de falsificação de cima não pegava isso porque compara `byBrand` do
 * painel com `byBrand` do BI — os dois lados que JÁ usam a frase derivada — e
 * nunca mede o não alocado.
 *
 * ## Por que o caso de baixo é ESTRUTURAL
 *
 * O terceiro status que faturaria não existe hoje: `FATURA` é resolvido em
 * tempo de COMPILAÇÃO e nenhum teste pode acrescentar um membro a ele. Então a
 * divergência de comportamento não é alcançável a partir do banco — o que é
 * alcançável, e é o defeito de verdade, é o LITERAL escrito à mão sobrevivendo
 * na rota. É ele que este caso mede, lendo a árvore do arquivo.
 *
 * ## Como este guarda falha (quebrando de propósito — conferido)
 *
 *   - devolva `status = 'completed'` à consulta `totals` do painel: o caso
 *     estrutural fica vermelho, nomeando a consulta;
 *   - escreva `status <> 'cancelled'` em `totals`: o caso do não alocado fica
 *     vermelho, com a venda 'devolvida' entrando no faturamento e não nas
 *     marcas — o não alocado deixa de ser zero.
 */
describe('a rota do painel não escreve o recorte da venda à mão', () => {
  const ROTA = fileURLToPath(new URL('../src/routes/v1/core.ts', import.meta.url));

  /**
   * O nó da rota `GET /dashboard` — e nada mais do arquivo.
   *
   * A leitura é pela ÁRVORE, e não por recorte de texto, por um motivo que
   * este guarda já mordeu: a primeira versão casava com o próprio comentário
   * que explica o defeito (ele cita `status = 'completed'` para nomeá-lo) e
   * ficava vermelho com o conserto aplicado. Comentário não é consulta.
   */
  function noDoPainel(): ts.Node {
    expect(existsSync(ROTA), `arquivo não encontrado: ${ROTA}`).toBe(true);
    const fonte = readFileSync(ROTA, 'utf8');
    const arvore = ts.createSourceFile(ROTA, fonte, ts.ScriptTarget.ES2022, true);

    let achado: ts.Node | null = null;
    const visitar = (no: ts.Node): void => {
      if (achado) return;
      if (
        ts.isCallExpression(no)
        && ts.isPropertyAccessExpression(no.expression)
        && no.expression.name.text === 'get'
        && no.arguments.length > 0
        && ts.isStringLiteral(no.arguments[0])
        && no.arguments[0].text === '/dashboard'
      ) {
        achado = no;
        return;
      }
      ts.forEachChild(no, visitar);
    };
    visitar(arvore);

    expect(achado, 'a rota GET /dashboard não foi encontrada na árvore de core.ts').not.toBeNull();
    return achado as unknown as ts.Node;
  }

  /** Só o SQL: todo template literal de dentro da rota, comentários fora. */
  function sqlDoPainel(): string[] {
    const sqls: string[] = [];
    const visitar = (no: ts.Node): void => {
      if (ts.isTemplateExpression(no) || ts.isNoSubstitutionTemplateLiteral(no)) {
        sqls.push(no.getText());
        return;
      }
      ts.forEachChild(no, visitar);
    };
    visitar(noDoPainel());
    return sqls;
  }

  /** Quantas vezes a rota chama a frase derivada. */
  function chamadasDaFraseDerivada(): number {
    let n = 0;
    const visitar = (no: ts.Node): void => {
      if (
        ts.isCallExpression(no)
        && ts.isIdentifier(no.expression)
        && no.expression.text === 'recorteDaVendaQueFatura'
      ) {
        n += 1;
      }
      ts.forEachChild(no, visitar);
    };
    visitar(noDoPainel());
    return n;
  }

  it('ESTRUTURAL — nenhum status de venda escrito à mão sobrevive no SQL do painel', () => {
    /*
      Toda consulta do painel que recorta `core_sales` tem de pegar a frase da
      MESMA fonte derivada do `Record FATURA`. Um literal aqui é uma quinta
      grafia esperando o dia do terceiro status.
    */
    const escritosAMao = sqlDoPainel().flatMap((sql) => [
      // `\b` casa `status` e `s.status`, e NÃO casa `sale_status` de outra
      // tabela — o ponto é caractere de fronteira, o sublinhado não é.
      ...sql.matchAll(/\bstatus\s*(=|<>|!=)\s*'([a-z_]+)'/g),
    ]);

    expect(
      escritosAMao.map((m) => m[0]),
      'o painel ainda recorta a venda com literal escrito à mão — `byBrand` cresce '
        + 'no dia do terceiro status e `totals` não, e o não alocado fica negativo',
    ).toEqual([]);
  });

  it('ESTRUTURAL — e as quatro consultas de venda do painel usam a frase derivada', () => {
    // `byBrand` vem de `marcasDoPainel`, que já embute a frase; as outras
    // quatro (totals, byDay, topProducts, bySeller) têm de chamá-la aqui.
    expect(
      chamadasDaFraseDerivada(),
      'as quatro consultas de venda do painel precisam da frase derivada — '
        + 'totals, byDay, topProducts e bySeller',
    ).toBe(4);
    expect(sqlDoPainel().join('\n')).not.toContain("'completed'");
  });

  it('a frase derivada diz o que o Record diz — e nada mais', () => {
    // Se um dia alguém marcar um segundo status como faturamento, esta lista
    // cresce junto: ela sai do `Record`, não de uma cópia escrita aqui.
    expect([...STATUS_QUE_FATURAM]).toEqual(['completed']);
  });

  it('FALSIFICAÇÃO — o não alocado do painel não engole o terceiro status', async () => {
    /*
      A MORDIDA QUE FALTAVA no guarda de falsificação: medir
      `byBrandUnallocatedCents`.

      `byBrandUnallocatedCents` é o desconto de rodapé que não pertence a marca
      nenhuma, e a tela o mostra como tal. Se `totals` e `byBrand` recortarem a
      venda com frases diferentes, esse campo passa a carregar a diferença
      entre as duas frases — mercadoria (ou o negativo dela) apresentada ao
      gestor como desconto de rodapé.

      Aqui não há desconto de rodapé nenhum: toda venda é uma linha de item com
      o total do cabeçalho. Então o não alocado tem de ser EXATAMENTE zero,
      exista ou não a venda com o status inventado.
    */
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    await vender(p, 20_000);
    const terceira = await vender(p, 20_000);
    getConnection().prepare("UPDATE core_sales SET status = 'devolvida' WHERE id = ?").run(terceira);

    const daTela = await painel();

    // As duas contas do MESMO cartão fecham: faturamento = marcas + não alocado.
    expect(somar(daTela.byBrand) + daTela.byBrandUnallocatedCents).toBe(daTela.revenueCents);
    expect(
      daTela.byBrandUnallocatedCents,
      'o não alocado deixou de ser zero: `totals` e `byBrand` recortaram a venda com '
        + 'frases diferentes, e a tela chama essa diferença de desconto de rodapé',
    ).toBe(0);
    // E nunca negativo — a tela renderiza qualquer não-zero como desconto.
    expect(daTela.byBrandUnallocatedCents).toBeGreaterThanOrEqual(0);
    expect(daTela.revenueCents).toBe(20_000);
  });

  it('FALSIFICAÇÃO — e as outras três consultas do painel contam o mesmo dia', async () => {
    /*
      `byDay`, `topProducts` e `bySeller` respondem ao mesmo cartão. Um recorte
      divergente ali não mexe no não alocado, mas faz o gráfico do dia, o top de
      produtos e o do vendedor discordarem do número grande logo acima deles.
    */
    const p = await criarProduto('Vestido Longo', 20_000, 'Farm');
    await carregar(p, 10);
    await vender(p, 20_000);
    const terceira = await vender(p, 20_000);
    getConnection().prepare("UPDATE core_sales SET status = 'devolvida' WHERE id = ?").run(terceira);

    const res = await request(app).get(`/api/v1/core/dashboard?from=${HOJE}&to=${HOJE}`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const somaDe = (linhas: { revenue_cents: number }[]) =>
      linhas.reduce((acc, l) => acc + Number(l.revenue_cents), 0);

    expect(somaDe(res.body.byDay), 'o gráfico do dia discordou do faturamento').toBe(
      res.body.revenueCents,
    );
    expect(somaDe(res.body.topProducts), 'o top de produtos discordou do faturamento').toBe(
      res.body.revenueCents,
    );
    expect(somaDe(res.body.bySeller), 'o painel do vendedor discordou do faturamento').toBe(
      res.body.revenueCents,
    );
    expect(res.body.salesCount, 'a contagem de vendas contou a devolvida').toBe(1);
  });
});
