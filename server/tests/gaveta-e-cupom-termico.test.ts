/**
 * ============================================================================
 * A GAVETA E O CUPOM TÉRMICO (GAP-V55)
 * ============================================================================
 *
 * ## O que o gap pedia, e o que é POSSÍVEL
 *
 * "Comando de gaveta e impressão térmica silenciosa." Metade disso o navegador
 * não faz e nunca vai fazer: ele não expõe porta serial/USB/raw de impressora
 * a uma página, e o caminho de impressão dele passa pelo DRIVER, que rasteriza
 * a página — bytes ESC/POS embutidos num HTML saem IMPRESSOS como texto, não
 * executados como comando.
 *
 * Prometer o contrário seria o pior desfecho: o operador confiaria no botão, a
 * gaveta ficaria fechada com o cliente esperando o troco, e o sistema teria
 * mentido numa tela de dinheiro.
 *
 * ## O que este arquivo cobra
 *
 * 1. O CUPOM ESC/POS EXISTE E É REAL — bytes conferidos um a um, incluindo o
 *    pulso `ESC p 0 25 250`, na ORDEM certa (pulso antes do corte).
 * 2. A GAVETA SÓ É PROMETIDA QUANDO PODE SER CUMPRIDA — `byCommand` é falso
 *    sem agente local registrado, e a mensagem diz o que fazer no lugar.
 * 3. O CUPOM TÉRMICO É O MESMO PAPEL: os totais saem da venda gravada, não de
 *    uma segunda aritmética.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { cupomEscPos, prontidaoDaGaveta, pulsoDaGaveta } from '../src/services/core/EscPos.js';
import { upsertPrinter } from '../src/services/core/PrintEngine.js';

const app = createApp();
const SENHA = 'Gaveta@Balcao2026';

let companyId: string;
let auth: { Authorization: string };
/** A gerência: cadastra e estoca a mercadoria do teste (PJ-CAIXA — o caixa da loja não administra produto). */
let authGerente: { Authorization: string };

async function entrar(): Promise<void> {
  const userId = await upsertUser({
    login: 'CAIXA.GAVETA',
    displayName: 'Caixa',
    password: SENHA,
  });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'CAIXA.GAVETA', password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };

  const gerenteId = await upsertUser({ login: 'GERENTE.GAVETA', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(gerenteId, companyId, 'gerente_loja', true);
  const g = await request(app)
    .post('/api/v1/auth/login')
    .send({ login: 'GERENTE.GAVETA', password: SENHA, companyId });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  authGerente = { Authorization: `Bearer ${g.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  await entrar();
});

describe('o pulso da gaveta', () => {
  it('é ESC p 0 25 250 — os bytes que a térmica executa', () => {
    // 0x1B 0x70: `ESC p`. Depois vêm o conector e a duração do pulso em
    // unidades de 2 ms. Errar um byte aqui é uma gaveta que nunca abre.
    expect([...pulsoDaGaveta()]).toEqual([0x1b, 0x70, 0, 25, 250]);
  });

  it('o conector 1 existe para a gaveta ligada na outra saída', () => {
    expect([...pulsoDaGaveta(1)]).toEqual([0x1b, 0x70, 1, 25, 250]);
  });
});

describe('o cupom em ESC/POS', () => {
  const venda = {
    loja: 'Gringa',
    cnpj: '12.345.678/0001-90',
    numero: 7,
    quando: '10/08/2026 14:30',
    itens: [{ descricao: 'Camiseta', quantidade: 2, totalCents: 7000 }],
    totalCents: 7000,
    pagamentos: [{ metodo: 'dinheiro', valorCents: 7000 }],
  };

  function texto(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('latin1');
  }

  it('começa inicializando a impressora', () => {
    // `ESC @` limpa formatação pendente do job anterior. Sem ele, um cupom sai
    // em negrito porque o anterior morreu no meio.
    expect([...cupomEscPos(venda).slice(0, 2)]).toEqual([0x1b, 0x40]);
  });

  it('leva loja, número, item e total em centavos exatos', () => {
    const t = texto(cupomEscPos(venda));
    expect(t).toContain('Gringa');
    expect(t).toContain('Venda #7');
    expect(t).toContain('Camiseta');
    expect(t).toContain('70,00');
  });

  it('sem pedir gaveta, o pulso NÃO vai junto', () => {
    // Segunda via não abre gaveta: o dinheiro já entrou uma vez.
    const t = texto(cupomEscPos(venda));
    expect(t.includes('\x1b\x70')).toBe(false);
  });

  it('pedindo gaveta, o pulso vem ANTES do corte', () => {
    /*
      A ordem é o detalhe que faz "às vezes a gaveta não abre": depois do corte
      a impressora pode já ter descarregado o buffer, e o pulso se perde. Um
      defeito que parece intermitente e é determinístico.
    */
    const t = texto(cupomEscPos({ ...venda, abrirGaveta: true }));
    const pulso = t.indexOf('\x1b\x70');
    const corte = t.indexOf('\x1d\x56');
    expect(pulso).toBeGreaterThan(-1);
    expect(corte).toBeGreaterThan(-1);
    expect(pulso).toBeLessThan(corte);
  });

  it('acento vira letra sem acento, e não caractere quebrado', () => {
    /*
      Térmica de cupom sai de fábrica em CP850/CP437 e não fala UTF-8: "Ação"
      em UTF-8 imprime dois símbolos estranhos no lugar do "ç". Sem acento é
      feio e LEGÍVEL; o inverso é ilegível.
    */
    const t = texto(
      cupomEscPos({
        ...venda,
        itens: [{ descricao: 'Cartão de saudação', quantidade: 1, totalCents: 500 }],
      }),
    );
    expect(t).toContain('Cartao de saudacao');
  });

  it('todo byte cabe em um octeto — nada de UTF-8 vazando', () => {
    const bytes = cupomEscPos({ ...venda, loja: 'Ação & Cia' });
    expect([...bytes].every((b) => b >= 0 && b <= 255)).toBe(true);
  });
});

describe('a prontidão da gaveta é honesta', () => {
  it('SEM agente local, byCommand é falso e a mensagem diz o que fazer', () => {
    const r = prontidaoDaGaveta(companyId);
    expect(r.byCommand).toBe(false);
    expect(r.agentPrinters).toBe(0);
    // A frase precisa levar a uma ação que funciona hoje.
    expect(r.message).toMatch(/chave|driver/i);
  });

  it('o comando viaja mesmo sem agente — é o dado de quem TEM a porta', () => {
    // Devolver o comando não é o mesmo que prometer executá-lo, e a mensagem
    // ao lado diz qual dos dois é o caso.
    const r = prontidaoDaGaveta(companyId);
    expect(Buffer.from(r.command, 'base64')).toEqual(Buffer.from(pulsoDaGaveta()));
  });

  it('impressora de NAVEGADOR não liga o comando de gaveta', () => {
    upsertPrinter({
      companyId,
      name: 'Cupom do balcão',
      kind: 'cupom',
      transport: 'browser',
    });
    // O navegador continua sem porta de impressora: cadastrar uma impressora
    // não muda o que o ambiente permite.
    expect(prontidaoDaGaveta(companyId).byCommand).toBe(false);
  });

  it('impressora de AGENTE cadastrada sem agente no ar NÃO liga o comando (GAP-PRD-082)', () => {
    /*
      Este caso dizia o contrário — "com agente local registrado, o comando
      passa a valer" — e era a promessa que a auditoria mediu como falsa:
      bastava CADASTRAR uma impressora como "agente" para `byCommand` virar
      true, com nenhum programa consumindo o pulso. Agora o comando só vale
      com o endereço da impressora no computador do caixa E o agente daquele
      caixa pareado e no ar; o caso positivo, com o agente de verdade, está em
      `impressao-pelo-agente-local.test.ts`.
    */
    upsertPrinter({
      companyId,
      name: 'Térmica da bancada',
      kind: 'cupom',
      transport: 'agent',
      agentDevice: 'tcp:192.168.0.60:9100',
    });
    const r = prontidaoDaGaveta(companyId);
    expect(r.byCommand).toBe(false);
    expect(r.agentPrinters).toBe(1);
    expect(r.message).toMatch(/Nenhum agente local pareado/);
  });

  it('agente de OUTRA empresa não abre gaveta nesta', () => {
    const vizinha = upsertCompany({
      slug: 'me-mimei',
      legalName: 'Me Mimei Ltda',
      tradeName: 'Me Mimei',
    });
    upsertPrinter({
      companyId: vizinha,
      name: 'Térmica da vizinha',
      kind: 'cupom',
      transport: 'agent',
    });
    expect(prontidaoDaGaveta(companyId).byCommand).toBe(false);
  });
});

describe('as rotas', () => {
  it('/print/drawer responde ao balcão com a verdade', async () => {
    const res = await request(app).get('/api/v1/core/print/drawer').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.byCommand).toBe(false);
    expect(typeof res.body.message).toBe('string');
  });

  it('/print/jobs/:id/escpos devolve o cupom da venda em bytes', async () => {
    // Um produto, uma venda, um cupom — o caminho inteiro pela API.
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(authGerente)
      .send({ name: 'Camiseta', priceCents: 3500 });
    expect(produto.status).toBe(201);
    await request(app)
      .post('/api/v1/core/stock/movements')
      .set(authGerente)
      .send({
        productId: produto.body.id,
        movementType: 'in',
        quantity: 5,
        referenceType: 'entrada',
        referenceId: `carga-${produto.body.id}`,
      });

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId: produto.body.id, quantity: 2, unitPriceCents: 3500 }],
        payments: [{ method: 'dinheiro', amountCents: 7000 }],
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: venda.body.id });
    expect(job.status, JSON.stringify(job.body)).toBe(201);

    const semGaveta = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/escpos`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const pedacos: Buffer[] = [];
        res.on('data', (d: Buffer) => pedacos.push(d));
        res.on('end', () => cb(null, Buffer.concat(pedacos)));
      });
    expect(semGaveta.status).toBe(200);
    const bytes = semGaveta.body as Buffer;
    const texto = bytes.toString('latin1');
    // O MESMO papel: total gravado na venda, não recalculado aqui.
    expect(texto).toContain('70,00');
    expect(texto).toContain('Camiseta');
    expect(texto.includes('\x1b\x70')).toBe(false);

    const comGaveta = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/escpos?gaveta=1`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const pedacos: Buffer[] = [];
        res.on('data', (d: Buffer) => pedacos.push(d));
        res.on('end', () => cb(null, Buffer.concat(pedacos)));
      });
    expect((comGaveta.body as Buffer).toString('latin1').includes('\x1b\x70')).toBe(true);
  });

  it('etiqueta não vira cupom térmico — recusa em vez de papel ilegível', async () => {
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(authGerente)
      .send({ name: 'Camiseta', priceCents: 3500 });
    const job = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(auth)
      .send({ documentType: 'PRODUCT_LABEL', documentId: produto.body.id });
    expect(job.status, JSON.stringify(job.body)).toBe(201);

    const res = await request(app)
      .get(`/api/v1/core/print/jobs/${job.body.id}/escpos`)
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('CORE_PRINT_ESCPOS_UNSUPPORTED');
  });
});
