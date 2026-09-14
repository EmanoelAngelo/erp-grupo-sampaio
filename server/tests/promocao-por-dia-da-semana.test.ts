/**
 * ============================================================================
 * "TODA QUARTA A FRUTA EM OFERTA" — a promoção que não precisa ser recriada
 * ============================================================================
 *
 * ## O defeito (GAP-V03)
 *
 * `core_promotions` só tinha `starts_at` e `ends_at`. A oferta semanal do
 * hortifrúti — que é o formato mais comum do varejo de bairro — exigia criar
 * uma promoção nova a cada semana, com data de início e fim de um dia. Esquecer
 * de criar é preço cheio na quarta; esquecer de encerrar é preço promocional na
 * quinta. Os dois acontecem, e nenhum dos dois dá erro.
 *
 * ## O ponto delicado: QUE dia é hoje
 *
 * O carimbo do servidor é Greenwich. Das 21h à meia-noite de Pelotas, o relógio
 * de lá já virou o dia — então uma peneira feita com `strftime('%w')` no SQL (ou
 * com `new Date().getDay()` num servidor em UTC) faria "toda quarta" morrer às
 * 21h de quarta e começar às 21h de terça. São as três horas mais cheias do
 * balcão, erradas nos dois sentidos. Este arquivo cobra o dia da LOJA.
 *
 * ## COMO CADA GUARDA FALHA
 *
 *  - tire o `.filter(valeNesteDiaDaSemana)` de `promocoesVigentes` e a promoção
 *    de quarta desconta no domingo;
 *  - tire o mesmo filtro do caminho de UM produto em `effectivePriceCents` e o
 *    balcão diverge da vitrine (que passa a lista já peneirada);
 *  - faça `valeNesteDiaDaSemana` responder `false` para nulo e TODA promoção
 *    já existente no banco para de valer, sem ninguém ter mexido nela.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { loginForTest } = await import('./helpers/auth.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const {
  diaDaSemanaDaLoja,
  effectivePriceCents,
  promocoesVigentes,
  valeNesteDiaDaSemana,
} = await import('../src/services/core/PricingService.js');
const { hojeNaLoja } = await import('../src/services/core/CalendarioOperacional.js');

const app = createApp();
const LOJA = 'loja-da-quarta';
const PRECO_BASE = 10000;

let gerente: Record<string, string>;

function produto(id: string): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Melancia', 'KG', 4000, ?, 'Hortifrúti', 1, ?, ?)`,
    )
    .run(id, LOJA, `PQ-${id}`, PRECO_BASE, agora, agora);
  return id;
}

/** Grava a promoção direto, para poder testar QUALQUER dia sem esperar a semana. */
function promocao(weekdays: string | null, percentOff = 20): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, weekdays, active, created_by, created_at)
       VALUES (?, ?, 'p-1', NULL, NULL, ?, ?, NULL, ?, 1, 'u-1', ?)`,
    )
    .run(
      id,
      LOJA,
      percentOff,
      new Date(Date.now() - 3600_000).toISOString(),
      weekdays,
      new Date().toISOString(),
    );
  return id;
}

const preco = () => effectivePriceCents(LOJA, 'p-1', PRECO_BASE, 'Hortifrúti');

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  produto('p-1');
});

describe('o dia da semana peneira a promoção', () => {
  it('a promoção do dia de HOJE desconta', () => {
    promocao(String(diaDaSemanaDaLoja()));
    expect(preco().priceCents).toBe(8000);
    expect(preco().fonte).toBe('promocao');
  });

  it('a promoção de OUTRO dia não desconta nada hoje', () => {
    // O dia seguinte, seja qual for o de hoje: o teste roda em qualquer dia da
    // semana sem ficar verde por acidente.
    promocao(String((diaDaSemanaDaLoja() + 1) % 7));
    expect(preco().priceCents).toBe(PRECO_BASE);
    expect(preco().onSale).toBe(false);
    expect(preco().fonte).toBe('cadastro');
  });

  it('vários dias na mesma promoção: hoje entra, e o de ontem não decide nada', () => {
    const hoje = diaDaSemanaDaLoja();
    const ontem = (hoje + 6) % 7;
    promocao([ontem, hoje].sort().join(''));
    expect(preco().priceCents).toBe(8000);
  });

  it('SEM dias declarados vale todos os dias — é o que toda promoção antiga significa', () => {
    promocao(null);
    expect(preco().priceCents).toBe(8000);
  });

  it('a lista da vitrine é peneirada pelo MESMO critério do balcão', () => {
    promocao(String((diaDaSemanaDaLoja() + 3) % 7));
    // `promocoesVigentes` é o que a vitrine lê uma vez para o catálogo inteiro.
    // Se ela devolvesse a promoção de outro dia, a loja anunciaria um preço que
    // o balcão não cobra — o defeito que a função inteira existe para impedir.
    expect(promocoesVigentes(LOJA)).toHaveLength(0);

    const daSemana = promocoesVigentes(LOJA);
    expect(effectivePriceCents(LOJA, 'p-1', PRECO_BASE, 'Hortifrúti', {
      promocoes: daSemana,
    }).priceCents).toBe(PRECO_BASE);
  });

  it('e a lista PASSADA de fora é peneirada de novo — o resultado não depende do caminho', () => {
    const outroDia = (diaDaSemanaDaLoja() + 2) % 7;
    // Uma lista montada à mão, como faria um chamador desatento (ou um cache).
    const vigente = effectivePriceCents(LOJA, 'p-1', PRECO_BASE, 'Hortifrúti', {
      promocoes: [
        {
          product_id: 'p-1',
          category: null,
          price_cents: null,
          percent_off: 50,
          weekdays: String(outroDia),
        },
      ],
    });
    expect(vigente.priceCents).toBe(PRECO_BASE);
  });
});

describe('o dia é o da LOJA, não o de Greenwich', () => {
  it('diaDaSemanaDaLoja concorda com o dia de calendário da loja', () => {
    // A conversão de 'AAAA-MM-DD' para dia da semana não pode recuar um dia —
    // a mordida que este projeto já levou duas vezes. Ler ao MEIO-DIA UTC é o
    // que a evita em qualquer fuso negativo.
    const [ano, mes, dia] = hojeNaLoja().split('-').map(Number);
    const esperado = new Date(Date.UTC(ano, mes - 1, dia, 12)).getUTCDay();
    expect(diaDaSemanaDaLoja()).toBe(esperado);
  });

  it('nulo, vazio e espaço em branco querem dizer "todos os dias"', () => {
    for (const dia of [0, 1, 2, 3, 4, 5, 6]) {
      expect(valeNesteDiaDaSemana(null, dia)).toBe(true);
      expect(valeNesteDiaDaSemana('', dia)).toBe(true);
      expect(valeNesteDiaDaSemana('   ', dia)).toBe(true);
    }
  });
});

describe('a rota grava o que a tela manda', () => {
  it('POST /promotions guarda os dígitos ordenados, sem repetição', async () => {
    const res = await request(app)
      .post('/api/v1/core/promotions')
      .set(gerente)
      .send({ productId: 'p-1', percentOff: 15, weekdays: [5, 3, 3] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const linha = getConnection()
      .prepare('SELECT weekdays FROM core_promotions WHERE id = ?')
      .get(res.body.id) as { weekdays: string | null };
    expect(linha.weekdays).toBe('35');
  });

  it('a semana INTEIRA grava nulo — é o mesmo fato que "nenhum dia marcado"', async () => {
    const res = await request(app)
      .post('/api/v1/core/promotions')
      .set(gerente)
      .send({ productId: 'p-1', percentOff: 15, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(res.status).toBe(201);

    const linha = getConnection()
      .prepare('SELECT weekdays FROM core_promotions WHERE id = ?')
      .get(res.body.id) as { weekdays: string | null };
    // Duas formas de escrever o mesmo fato é onde nasce a regra que diverge.
    expect(linha.weekdays).toBeNull();
  });

  it('sem dias declarados grava nulo, e o comportamento de antes é preservado', async () => {
    const res = await request(app)
      .post('/api/v1/core/promotions')
      .set(gerente)
      .send({ productId: 'p-1', percentOff: 15 });
    expect(res.status).toBe(201);

    const linha = getConnection()
      .prepare('SELECT weekdays FROM core_promotions WHERE id = ?')
      .get(res.body.id) as { weekdays: string | null };
    expect(linha.weekdays).toBeNull();
    expect(preco().priceCents).toBe(8500);
  });

  it('dia inválido é RECUSADO, e nada é gravado', async () => {
    const res = await request(app)
      .post('/api/v1/core/promotions')
      .set(gerente)
      .send({ productId: 'p-1', percentOff: 15, weekdays: [9, 'segunda'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_INVALID_PROMOTION');

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_promotions WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(total.n).toBe(0);
  });

  it('a listagem devolve os dias, para a tela poder mostrá-los', async () => {
    await request(app)
      .post('/api/v1/core/promotions')
      .set(gerente)
      .send({ productId: 'p-1', percentOff: 15, weekdays: [3] })
      .expect(201);

    const lista = await request(app).get('/api/v1/core/promotions').set(gerente).expect(200);
    expect(lista.body.items[0].weekdays).toBe('3');
  });
});
