/**
 * A DIFERENÇA ENTRE DECLARAR ABERTURA E FICAR CALADO.
 *
 * Este arquivo existe por causa de uma crítica, e ela era boa: se
 * `abertaAo(req, 'balcao', 'bancada', 'escritorio')` deixa passar todo mundo,
 * escrever essa linha em dezenas de rotas é carimbo — o mesmo comportamento de
 * não ter guarda nenhum, com mais linhas.
 *
 * A resposta é que o comportamento NÃO é o mesmo, e a prova está aqui embaixo,
 * em dois testes que se olham:
 *
 *   - `rota calada aceita perfil que ninguém criou` monta um handler SEM guarda
 *     atrás do `authMiddleware` de produção — é o retrato do que as 52 rotas
 *     eram ontem — e mostra um perfil inventado passando com 200. Falha ABERTA.
 *
 *   - `rota declarada recusa o mesmo perfil` faz a MESMA requisição contra
 *     `/core/labels/catalog`, que está declarada aberta aos três ambientes, e
 *     recebe 403. Falha FECHADA.
 *
 * O perfil inventado não é ficção de laboratório: o sistema tem oito perfis
 * hoje e ganhou perfis novos em rodadas passadas. No dia em que nascer o nono,
 * as rotas caladas o deixariam entrar em tudo sem ninguém tocar numa linha do
 * roteador — e ninguém veria, porque não há erro nenhum a ver.
 *
 * ## O resto do arquivo
 *
 * As rotas de DINHEIRO e de DADO DE PESSOA, cobradas dos dois lados: 403 para
 * quem não alcança a tela e 200 para quem alcança. Sem o segundo lado, um
 * guarda que negasse para todo mundo passaria no teste e quebraria o produto.
 *
 * E as duas rotas onde a decisão foi ABRIR, com o motivo: `/customers` é
 * consumida pelo PDV e pela Oficina, e `/workshop/orders` é lida pelo caixa da
 * oficina, que é quem cobra a OS. Elas estão aqui para que a próxima varredura
 * não as "conserte" por simetria com as vizinhas fechadas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { loginForTest } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { authMiddleware, type AuthedRequest } from '../src/middleware/auth.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-1';

/** Uma sessão real, com senha Argon2id, para o perfil pedido. */
async function sessao(perfil: string): Promise<{ app: ReturnType<typeof createApp>; token: string }> {
  const app = createApp();
  const login = await loginForTest(app, {
    userId: `u-${perfil}`,
    companyId: EMPRESA,
    profileCodes: [perfil],
  });
  expect(login.status).toBe(200);
  return { app, token: login.body.accessToken as string };
}

function get(app: ReturnType<typeof createApp>, token: string, rota: string) {
  return request(app).get(`/api/v1/core${rota}`).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
});

// ---------------------------------------------------------------------------
// O CASO QUE PROVA A RODADA
// ---------------------------------------------------------------------------

/**
 * Um código de perfil que nada no sistema concede.
 *
 * Não está em `ASSIGNABLE_PROFILES`, não está em `AMBIENTE_POR_PERFIL` do
 * roteador, não está em nenhuma das três listas de ambiente. É o nono perfil
 * do futuro, ou o vínculo antigo com o código escrito errado.
 */
const PERFIL_INVENTADO = 'conferente_noturno';

describe('perfil que ninguém criou: calado deixa entrar, declarado não', () => {
  it('rota CALADA aceita o perfil inventado — é a falha ABERTA', async () => {
    /*
      O retrato do que as 52 rotas eram ontem: `authMiddleware` de produção, e
      depois nada. Não é uma imitação do guarda — é a AUSÊNCIA dele, que é
      exatamente o que se quer retratar, e o middleware é o de verdade.

      Se este teste passar a dar 403 um dia, é porque alguém pôs verificação de
      perfil dentro do `authMiddleware` — e aí o teste ao lado ficou redundante,
      o que seria uma boa notícia a ser lida com atenção, não apagada.
    */
    const calado = express();
    calado.use(express.json());
    calado.use('/api/v1/core', authMiddleware);
    calado.get('/api/v1/core/rota-calada', (req: AuthedRequest, res) => {
      res.json({ perfis: req.auth?.profileCodes ?? [] });
    });

    const { token } = await sessao(PERFIL_INVENTADO);
    const res = await request(calado)
      .get('/api/v1/core/rota-calada')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // E entrou COM o perfil inventado no token: o servidor o conhece, aceita e
    // não tem o que fazer com ele.
    expect(res.body.perfis).toEqual([PERFIL_INVENTADO]);
  });

  it('rota DECLARADA recusa o mesmo perfil — é a falha FECHADA', async () => {
    // `/labels/catalog` é o caso mais duro possível para esta prova: está
    // declarada aberta aos TRÊS ambientes, ou seja, é a linha que o crítico
    // chamou de carimbo. Ela recusa mesmo assim.
    const { app, token } = await sessao(PERFIL_INVENTADO);
    const res = await get(app, token, '/labels/catalog');
    expect(res.status).toBe(403);
  });

  it('e a mesma rota declarada continua abrindo para quem pertence a um ambiente', async () => {
    // Sem este caso, um guarda que negasse para TODO MUNDO passaria no teste
    // acima. Os três ambientes, um de cada.
    for (const perfil of ['operador_caixa_loja', 'mecanico', 'atendente']) {
      const { app, token } = await sessao(perfil);
      const res = await get(app, token, '/labels/catalog');
      expect(res.status, `${perfil} em /labels/catalog`).toBe(200);
    }
  });

  it('o perfil inventado bate em 403 em todas as rotas de ambiente, não só numa', async () => {
    // Uma amostra dos três desenhos de guarda: aberta aos três, aberta a dois,
    // aberta a um. Nenhuma delas conhece o perfil, e nenhuma delas deixa passar.
    const { app, token } = await sessao(PERFIL_INVENTADO);
    for (const rota of ['/payment-methods', '/quotes', '/dashboard', '/products']) {
      const res = await get(app, token, rota);
      expect(res.status, `perfil inventado em ${rota}`).toBe(403);
    }
  });

  it('sem token continua sendo 401, e não 403', async () => {
    // A distinção importa: 401 diz "identifique-se", 403 diz "você não pode".
    const res = await request(createApp()).get('/api/v1/core/labels/catalog');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DINHEIRO E DADO DE PESSOA
// ---------------------------------------------------------------------------

/** Rotas sem parâmetro: dá para cobrar 403 e 200 sem montar nada antes. */
const SO_ESCRITORIO = ['/finance/entries', '/dashboard'] as const;

describe('o dinheiro da empresa é do escritório', () => {
  for (const rota of SO_ESCRITORIO) {
    it(`mecânico recebe 403 em ${rota}`, async () => {
      const { app, token } = await sessao('mecanico');
      expect((await get(app, token, rota)).status).toBe(403);
    });

    it(`operador de caixa recebe 403 em ${rota}`, async () => {
      // O caixa mexe com dinheiro o dia inteiro, então parece natural liberar.
      // Mas o que ele conta é a gaveta dele — não as contas a pagar da empresa
      // nem o faturamento do mês.
      const { app, token } = await sessao('operador_caixa_loja');
      expect((await get(app, token, rota)).status).toBe(403);
    });

    it(`gerente de loja recebe 200 em ${rota}`, async () => {
      const { app, token } = await sessao('gerente_loja');
      expect((await get(app, token, rota)).status).toBe(200);
    });
  }

  it('gestor passa, como passa em tudo', async () => {
    const { app, token } = await sessao('gestor');
    expect((await get(app, token, '/dashboard')).status).toBe(200);
  });
});

describe('a gaveta é do balcão, e a bancada não tem gaveta', () => {
  const DA_GAVETA = ['/cash/open', '/cash/sessions'] as const;

  for (const rota of DA_GAVETA) {
    it(`mecânico recebe 403 em ${rota}`, async () => {
      const { app, token } = await sessao('mecanico');
      expect((await get(app, token, rota)).status).toBe(403);
    });

    it(`operador de caixa recebe 200 em ${rota}`, async () => {
      const { app, token } = await sessao('operador_caixa_loja');
      expect((await get(app, token, rota)).status).toBe(200);
    });

    it(`gerente de loja recebe 200 em ${rota}`, async () => {
      const { app, token } = await sessao('gerente_loja');
      expect((await get(app, token, rota)).status).toBe(200);
    });
  }
});

describe('a venda: o balcão lê porque é dele, a bancada não', () => {
  it('mecânico recebe 403 em /sales', async () => {
    const { app, token } = await sessao('mecanico');
    expect((await get(app, token, '/sales')).status).toBe(403);
  });

  it('operador de caixa recebe 200 em /sales — a tela do PDV é dele', async () => {
    const { app, token } = await sessao('operador_caixa_loja');
    expect((await get(app, token, '/sales')).status).toBe(200);
  });

  it('gerente de loja recebe 200 em /sales', async () => {
    const { app, token } = await sessao('gerente_loja');
    expect((await get(app, token, '/sales')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ROTAS COM PARÂMETRO
// ---------------------------------------------------------------------------

/**
 * Rota com parâmetro não dá 200 sem o dado existir — daria 404, e um teste que
 * aceita 404 como sucesso passa até com a rota apagada.
 *
 * Então cada caso aqui faz uma coisa só: ou MONTA o dado e cobra o 200, ou
 * cobra SÓ o 403 de quem não alcança, que o guarda decide antes de qualquer
 * busca no banco e não depende de fixture nenhuma.
 */
describe('rotas com parâmetro: ou o dado existe, ou só o 403 é cobrado', () => {
  it('o 403 do mecânico em /finance/entries/:id/settlements não precisa do lançamento', async () => {
    const { app, token } = await sessao('mecanico');
    const res = await get(app, token, '/finance/entries/id-que-nao-existe/settlements');
    // 403, e não 404: o guarda roda ANTES da busca. Se um dia isto virar 404, é
    // porque alguém moveu o guarda para depois da consulta.
    expect(res.status).toBe(403);
  });

  it('com o lançamento montado, o gerente recebe 200 nas baixas dele', async () => {
    const { app, token } = await sessao('gerente_loja');
    const criado = await request(app)
      .post('/api/v1/core/finance/entries')
      .set('Authorization', `Bearer ${token}`)
      .send({ direction: 'in', description: 'Serviço avulso', amountCents: 25_000 });
    expect(criado.status).toBe(201);

    const res = await get(app, token, `/finance/entries/${criado.body.id}/settlements`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('com o turno aberto, o caixa lê o resumo da própria gaveta', async () => {
    const { app, token } = await sessao('operador_caixa_loja');
    const aberto = await request(app)
      .post('/api/v1/core/cash/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingCents: 10_000 });
    expect(aberto.status).toBe(201);

    const res = await get(app, token, `/cash/${aberto.body.id}/summary`);
    expect(res.status).toBe(200);
  });

  it('o mecânico não lê o resumo de gaveta nenhuma, exista ela ou não', async () => {
    const { app, token } = await sessao('mecanico');
    const res = await get(app, token, '/cash/turno-inexistente/summary');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ONDE A DECISÃO FOI ABRIR — e o motivo, para não ser "consertado" depois
// ---------------------------------------------------------------------------

describe('o que fica aberto de propósito, e por quê', () => {
  /**
   * `/customers` é dado de pessoa e mesmo assim abre para os três.
   *
   * Não por descuido: o PDV busca cliente para vincular à venda (ROTA_PDV) e a
   * Oficina busca o dono do aparelho (ROTA_OFICINA). Guarda mais estreito que a
   * tela quebra tela — e quem responde pelo risco é o POST ao lado, que decide
   * quem CADASTRA cliente.
   */
  it('o balcão e a bancada leem /customers, porque as telas deles precisam', async () => {
    for (const perfil of ['operador_caixa_loja', 'mecanico', 'atendente']) {
      const { app, token } = await sessao(perfil);
      expect((await get(app, token, '/customers')).status, perfil).toBe(200);
    }
  });

  /**
   * `/workshop/orders` abre também ao balcão porque
   * `POST /workshop/orders/:id/checkout` exige `operador_caixa_oficina`: quem
   * cobra a OS tem de conseguir lê-la.
   */
  it('o caixa da oficina lê as OS que ele mesmo vai cobrar', async () => {
    const { app, token } = await sessao('operador_caixa_oficina');
    expect((await get(app, token, '/workshop/orders')).status).toBe(200);
  });

  /**
   * O ramo `hideCost` é o ARGUMENTO de o mecânico estar no guarda desta rota, e
   * por isso ele precisa ser atravessado, e não só tocado.
   *
   * A primeira versão deste caso conferia `status === 200` e mais nada. O título
   * dizia "sem o custo" e nada no teste olhava o custo: dava para inverter o
   * sinal do `hideCost`, ou tirá-lo do objeto passado a `listMovements`, e os
   * 2387 testes continuariam verdes com o mecânico lendo o que a loja pagou no
   * fornecedor.
   *
   * É a lição que o cabeçalho deste arquivo cita e que este caso não cumpria:
   * teste o que atravessa a corrente. Por isso ele monta um movimento com custo
   * de verdade e compara as DUAS leituras — a do escritório, que vê, e a da
   * bancada, que não vê.
   */
  it('o mecânico lê as movimentações e NÃO vê o custo; o escritório vê', async () => {
    const gerencia = await sessao('gerente_loja');

    const produto = await request(gerencia.app)
      .post('/api/v1/core/products')
      .set('Authorization', `Bearer ${gerencia.token}`)
      .send({ name: 'ZZ Peça com custo', unit: 'UN', costCents: 4_200, priceCents: 9_900 });
    expect(produto.status).toBe(201);

    const entrada = await request(gerencia.app)
      .post('/api/v1/core/stock/movements')
      .set('Authorization', `Bearer ${gerencia.token}`)
      .send({
        productId: produto.body.id,
        movementType: 'in',
        quantity: 3,
        unitCostCents: 4_200,
        referenceType: 'ajuste',
        referenceId: 'mov-1',
      });
    expect(entrada.status).toBe(201);

    const doEscritorio = await get(gerencia.app, gerencia.token, '/stock/movements');
    expect(doEscritorio.status).toBe(200);
    const linhaDoEscritorio = doEscritorio.body.items.find(
      (m: { product_id: string }) => m.product_id === produto.body.id,
    );
    // Sem isto o caso passaria com a lista vazia, e não provaria nada.
    expect(linhaDoEscritorio).toBeDefined();
    expect(linhaDoEscritorio.unit_cost_cents).toBe(4_200);

    const daBancada = await sessao('mecanico');
    const doMecanico = await get(daBancada.app, daBancada.token, '/stock/movements');
    expect(doMecanico.status).toBe(200);
    const linhaDoMecanico = doMecanico.body.items.find(
      (m: { product_id: string }) => m.product_id === produto.body.id,
    );
    expect(linhaDoMecanico).toBeDefined();
    // O que a empresa pagou no fornecedor não é assunto de quem monta a peça.
    expect(linhaDoMecanico.unit_cost_cents).toBeNull();
  });

  /**
   * A tela de Etiquetas é ROTA_GESTAO, e `gestao` inclui `atendente`.
   *
   * O guarda de `POST /labels/sheet` esqueceu o atendente, e copiá-lo para as
   * duas rotas de candidatos deixaria o guarda MAIS ESTREITO QUE A TELA — o
   * erro que esta rodada existe para não cometer.
   */
  it('o atendente lista candidatos a etiqueta, como a tela dele promete', async () => {
    const { app, token } = await sessao('atendente');
    // `source=estoque` é a origem que não exige argumento nenhum: o que se
    // cobra aqui é o guarda, não a consulta.
    expect((await get(app, token, '/labels/candidates?source=estoque')).status).toBe(200);

    const codes = await request(app)
      .post('/api/v1/core/labels/candidates/codes')
      .set('Authorization', `Bearer ${token}`)
      .send({ codes: '7891234567895' });
    expect(codes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// A CREDENCIAL DA PLAQUINHA
// ---------------------------------------------------------------------------

describe('a lista de equipamentos não entrega o token da plaquinha', () => {
  it('a listagem devolve a plaquinha e engole o token', async () => {
    const { app, token } = await sessao('gerente_oficina');

    /*
      A linha vai direto ao banco de propósito.

      O que está sob teste é o que SAI da rota de listagem, e o cadastro pela
      rota exigiria oficina oficial, vínculo de bancada e escolha de origem —
      montagem que já tem dono em `workshops-equipment`, inclusive a prova de
      que o POST devolve o token para quem vai imprimir a plaquinha. Aqui basta
      existir um equipamento com token conhecido.
    */
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('of-plaquinha', ?, 'of-plaquinha', 'Oficina', 'mobility', 1, ?)`,
      )
      .run(EMPRESA, agora);
    getConnection()
      .prepare(
        `INSERT INTO core_equipment
           (id, company_id, workshop_id, public_id, public_token, origin,
            brand, model, status, entered_at, created_at, updated_at)
         VALUES (?, ?, ?, 7, 'tok-secreto-da-plaquinha', 'INTERNAL_PJ_MOTORS',
                 'Honda', 'CG 160', 'ativo', ?, ?, ?)`,
      )
      .run('eq-plaquinha', EMPRESA, 'of-plaquinha', agora, agora, agora);

    const lista = await get(app, token, '/equipment');
    expect(lista.status).toBe(200);
    expect(lista.body.items.length).toBeGreaterThan(0);

    for (const item of lista.body.items) {
      // `public_token` abre `/equipamento/:token` SEM sessão. Um token vazado
      // não expira nem se revoga — então ele não viaja na listagem que o balcão
      // inteiro consulta.
      expect(item.public_token).toBeUndefined();
      // E o que a tela realmente usa continua vindo.
      expect(item.publicIdLabel).toMatch(/^#\d+$/);
    }

    // A prova de que o token estava mesmo lá para ser vazado: se ele não
    // existisse na linha, o `expect` acima passaria sozinho e não valeria nada.
    expect(JSON.stringify(lista.body)).not.toContain('tok-secreto-da-plaquinha');
    const gravado = getConnection()
      .prepare('SELECT public_token FROM core_equipment WHERE id = ?')
      .get('eq-plaquinha') as { public_token: string };
    expect(gravado.public_token).toBe('tok-secreto-da-plaquinha');
  });
});
