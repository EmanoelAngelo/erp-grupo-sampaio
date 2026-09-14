/**
 * A IMPORTAÇÃO PELA PORTA DA FRENTE — HTTP, autenticação e alçada.
 *
 * Testar o serviço não prova que a rota funciona. Este projeto já pagou por
 * isso: uma configuração inteira ficou inerte em produção com a suíte verde,
 * porque todos os testes chamavam o serviço direto e ninguém atravessava a
 * requisição.
 *
 * Aqui há duas coisas que só aparecem por HTTP:
 *
 *   1. O ALCANCE. O guarda da rota tem de bater com a tela — nem mais largo
 *      (dado exposto), nem mais estreito (botão que não funciona).
 *   2. O CORPO. O arquivo sobe em base64, e base64 cresce um terço. Sem a rota
 *      na lista de exceção de `app.ts`, o body-parser recusaria ANTES de a
 *      função existir, e a pessoa receberia um erro sem texto em vez da
 *      mensagem que explica o que fazer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';

const LOJA = 'loja-import';
const app = createApp();

const PLANILHA =
  'nome;codigo_barras;preco;quantidade\n' +
  'Cabo HDMI;7891111111111;25,90;10\n' +
  'Fonte 12V;7892222222222;89,00;4\n';

function base64(texto: string): string {
  return Buffer.from(texto, 'utf8').toString('base64');
}

async function token(profileCodes: string[]): Promise<string> {
  const res = await loginForTest(app, { companyId: LOJA, profileCodes });
  return res.body.accessToken as string;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('o caminho inteiro por HTTP', () => {
  it('sobe a planilha, confere e confirma — e o saldo entra', async () => {
    const jwt = await token(['gerente_loja']);

    const subida = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(PLANILHA), nomeArquivo: 'abertura.csv' });

    expect(subida.status).toBe(201);
    expect(subida.body.status).toBe('conferencia');
    expect(subida.body.novos).toBe(2);
    expect(subida.body.separador).toBe(';');

    // Nada foi gravado ainda — a conferência é o ponto do desenho.
    const antes = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(antes.n).toBe(0);

    const itens = await request(app)
      .get(`/api/v1/core/import/produtos/${subida.body.id}/itens`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(itens.status).toBe(200);
    expect(itens.body.total).toBe(2);
    expect(itens.body.itens[0].linha).toBe(2);

    const confirmacao = await request(app)
      .post(`/api/v1/core/import/produtos/${subida.body.id}/confirmar`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(confirmacao.status).toBe(200);
    expect(confirmacao.body.criados).toBe(2);
    expect(confirmacao.body.comSaldo).toBe(2);

    const saldo = getConnection()
      .prepare(
        `SELECT s.quantity AS q FROM core_stock s
           JOIN core_products p ON p.id = s.product_id
          WHERE s.company_id = ? AND p.name = ?`,
      )
      .get(LOJA, 'Cabo HDMI') as { q: number };
    expect(saldo.q).toBe(10);
  });

  it('a releitura com outro separador não pede o arquivo de novo', async () => {
    const jwt = await token(['gerente_loja']);
    const subida = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64('nome,preco,quantidade\nCabo,25.90,10\n'), nomeArquivo: 'x.csv' });
    expect(subida.body.separador).toBe(',');

    const relido = await request(app)
      .put(`/api/v1/core/import/produtos/${subida.body.id}/leitura`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ separador: ';' });

    expect(relido.status).toBe(200);
    expect(relido.body.separador).toBe(';');
  });

  it('descartar o rascunho devolve 204', async () => {
    const jwt = await token(['gerente_loja']);
    const subida = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(PLANILHA), nomeArquivo: 'abertura.csv' });

    const apagado = await request(app)
      .delete(`/api/v1/core/import/produtos/${subida.body.id}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(apagado.status).toBe(204);
  });
});

/*
  IMPORTAR CRIA O CATÁLOGO E O SALDO INICIAIS DE UMA OPERAÇÃO INTEIRA.

  Não é receber mercadoria: é montar a loja. Por isso o alcance é mais estreito
  que o da entrada de NF-e, que aceita até o operador de caixa. Cada caso
  abaixo é um perfil que existe de verdade em `ASSIGNABLE_PROFILES` — guarda
  contra perfil fantasma, que este projeto já teve em cinco rotas.
*/
describe('o alcance da rota bate com quem monta a loja', () => {
  it('o mecânico não enxerga a importação', async () => {
    const jwt = await token(['mecanico']);
    const res = await request(app)
      .get('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(403);
  });

  it('o operador de caixa não importa planilha', async () => {
    const jwt = await token(['operador_caixa_loja']);
    const res = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(PLANILHA), nomeArquivo: 'x.csv' });
    expect(res.status).toBe(403);
  });

  /*
    O estoquista SOBE e confere — é ele quem conta a prateleira — mas não
    CONFIRMA: confirmar cria o catálogo inteiro e o saldo inicial. A divisão é
    deliberada, e é a única assimetria de perfil dentro deste grupo de rotas.
  */
  it('o estoquista sobe a planilha', async () => {
    const jwt = await token(['estoquista']);
    const res = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(PLANILHA), nomeArquivo: 'x.csv' });
    expect(res.status).toBe(201);
  });

  it('mas o estoquista NÃO confirma', async () => {
    const gerente = await token(['gerente_loja']);
    const subida = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${gerente}`)
      .send({ arquivo: base64(PLANILHA), nomeArquivo: 'x.csv' });

    const estoquista = await token(['estoquista']);
    const res = await request(app)
      .post(`/api/v1/core/import/produtos/${subida.body.id}/confirmar`)
      .set('Authorization', `Bearer ${estoquista}`)
      .send({});
    expect(res.status).toBe(403);

    // E a recusa é real: nenhum produto nasceu.
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
      .get(LOJA) as { n: number };
    expect(n.n).toBe(0);
  });

  it('sem token nenhum, 401', async () => {
    const res = await request(app).get('/api/v1/core/import/produtos');
    expect(res.status).toBe(401);
  });
});

/*
  O TETO DO CORPO — e por que ele precisa da linha em `app.ts`.

  Base64 cresce 33%. Com o limite geral de 1 MB, um arquivo de 800 KB seria
  recusado pelo body-parser antes de a rota rodar, e a resposta não teria
  texto nenhum. A rota está na lista de exceção justamente para que QUEM
  RECUSA seja ela, que sabe explicar.
*/
describe('arquivo grande recebe a mensagem da rota, e não o silêncio do parser', () => {
  it('uma planilha de ~900 KB atravessa o body-parser e é lida', async () => {
    const jwt = await token(['gerente_loja']);
    const linhas = ['nome;preco;quantidade'];
    for (let i = 0; i < 12000; i += 1) linhas.push(`Produto ${i};10,00;1`);
    const texto = linhas.join('\n');
    expect(texto.length).toBeGreaterThan(200_000);

    const res = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(texto), nomeArquivo: 'grande.csv' });

    /*
      O que importa aqui é que a resposta veio DA ROTA: 400 com código nomeado
      por passar do limite de linhas. Sem a exceção em `app.ts`, viria um erro
      do body-parser, sem código e sem texto útil.
    */
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_IMPORT_LINHAS_DEMAIS');
  });

  it('arquivo vazio é recusado com o motivo certo', async () => {
    const jwt = await token(['gerente_loja']);
    const res = await request(app)
      .post('/api/v1/core/import/produtos')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ arquivo: base64(''), nomeArquivo: 'vazio.csv' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_IMPORT_ARQUIVO_VAZIO');
  });
});
