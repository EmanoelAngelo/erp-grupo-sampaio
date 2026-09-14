/**
 * ============================================================================
 * O CONTADOR ENTRA PELA PORTA DELE
 * ============================================================================
 *
 * A rodada 27 entregou O QUE ele leva: a prévia do fechamento, o pacote mensal
 * em zip e o XML da nota recebida. Faltava ELE MESMO ENTRAR — até aqui alguém
 * da loja precisava lembrar de gerar e enviar todo mês, e o mês que passa é
 * justamente o que ninguém percebe.
 *
 * ## A decisão: perfil novo em `core_users`, não um portal com token próprio
 *
 * Está escrita em `TeamService.ts`, junto do perfil. O resumo: um portal seria
 * a TERCEIRA verdade sobre quem entra, e as duas primeiras (`core_users` e
 * `core_customer_accounts`) já custaram o cabeçalho inteiro de
 * `CustomerPortalService` para explicar por que não se misturam. Perfil novo
 * herda Argon2id, refresh com rotação, bloqueio por tentativa, vínculo por
 * empresa e desligamento — cinco mecanismos que ninguém precisa reescrever
 * para escolher qual deles vai ficar para trás.
 *
 * ## O que este arquivo cobra, e o que ele NÃO cobra
 *
 * Aqui estão os casos NOMEADOS: ele baixa, ele lê, ele não cria, ele não vê a
 * empresa do vizinho, e um gerente de loja não consegue fabricá-lo.
 *
 * O que este arquivo NÃO faz é afirmar "e nada mais ele alcança" — isso é
 * afirmação sobre 307 rotas, e nenhuma lista escrita à mão sobrevive à próxima
 * rodada. Quem afirma é `contador-varredura-das-rotas.test.ts`, que extrai as
 * rotas do AST de `core.ts` e bate em todas.
 *
 * ## Como cada guarda falha (medido, quebrando de propósito)
 *
 *   - tirando `'contador'` do `requireProfile` da prévia, do pacote ou do XML,
 *     os três primeiros casos ficam vermelhos com 403 no lugar de 200;
 *   - tirando `'contador'` de `PERFIS_DE_DONO` (TeamService), o caso do
 *     gerente de loja fica vermelho com 201 no lugar de 403 — e é o caso mais
 *     importante do arquivo, porque o 201 é silencioso;
 *   - trocando `scope(req).companyId` por `req.query.companyId` na prévia, o
 *     caso do escopo fica vermelho com as contagens da empresa vizinha.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { NOTA_RECEBIDA } from '../src/services/core/InboundNoteStatus.js';

const app = createApp();
const MONTAGEM = '/api/v1/core';
const PERIODO = '2026-07';

/** A empresa do contador, e a que ele nunca pode enxergar. */
const MINHA = 'preco-justo';
const VIZINHA = 'oficina-vizinha';

let contador: { Authorization: string };
let sequencia = 0;

beforeEach(async () => {
  resetDbForTests();
  sequencia = 0;

  /*
    A empresa vizinha nasce aqui, e não só quando alguém loga nela: os
    documentos dela são inseridos direto no banco, e `core_fiscal_documents`
    tem chave estrangeira para `core_companies`. Sem esta linha o cenário do
    isolamento morre com "FOREIGN KEY constraint failed" — vermelho por
    montagem, que é o vermelho que ninguém lê.
  */
  upsertCompany({
    id: VIZINHA,
    slug: VIZINHA,
    legalName: 'Oficina Vizinha Ltda',
    tradeName: 'Oficina Vizinha',
  });

  const login = await loginForTest(app, {
    userId: 'contador-do-escritorio',
    companyId: MINHA,
    profileCodes: ['contador'],
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect(login.body.user.profileCode).toBe('contador');
  contador = { Authorization: `Bearer ${login.body.accessToken}` };
});

/** Sessão de qualquer perfil, na empresa pedida. */
async function sessao(perfil: string, empresa = MINHA): Promise<{ Authorization: string }> {
  const login = await loginForTest(app, {
    userId: `u-${perfil}-${empresa}`,
    companyId: empresa,
    profileCodes: [perfil],
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

// ---------------------------------------------------------------------------
// Fabricação de cenário
// ---------------------------------------------------------------------------

/*
  A INSERÇÃO É DIRETA, pelo mesmo motivo já escrito em
  `fechamento-contador.test.ts`: levar um documento até AUTHORIZED pelo caminho
  de produção exige certificado, configuração fiscal completa e o provider de
  teste — que carimba protocolo `TEST-`, justamente o que o pacote EXCLUI. Os
  valores gravados aqui são os mesmos que `FiscalDocumentService.transition`
  escreve.
*/
function chave(n: number): string {
  return `3526071420016600018755001${String(n).padStart(19, '0')}`;
}

function notaEmitida(empresa: string): void {
  sequencia += 1;
  const k = chave(sequencia);
  const quando = `${PERIODO}-10T13:00:00.000Z`;
  const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${k}">`
    + '<ide><nNF>1</nNF></ide></infNFe>'
    + '<Signature><SignatureValue>YXNzaW5hdHVyYS1yZWFs</SignatureValue></Signature></NFe>';
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, model, serie, number, access_key, environment, status,
          xml_signed, xml_authorized, protocol, issued_at, authorized_at,
          created_at, updated_at)
       VALUES (?, ?, '55', 1, ?, ?, 'production', 'AUTHORIZED', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      empresa,
      sequencia,
      k,
      xml,
      `<retEnviNFe><protNFe><infProt><chNFe>${k}</chNFe><cStat>100</cStat></infProt>`
        + `</protNFe>${xml}</retEnviNFe>`,
      `1352600001${sequencia}`,
      quando,
      quando,
      quando,
      quando,
    );
}

/** O XML do fornecedor, gravado como a importação o grava. */
function xmlDaCompra(marca: string): string {
  return `<nfeProc><NFe><infNFe><emit><xNome>${marca}</xNome></emit></infNFe></NFe></nfeProc>`;
}

function notaRecebida(empresa: string, marca: string): string {
  sequencia += 1;
  const id = randomUUID();
  const quando = `${PERIODO}-05T12:00:00.000Z`;
  getConnection()
    .prepare(
      `INSERT INTO core_inbound_notes
         (id, company_id, access_key, number, series, total_cents, status,
          received_at, issued_at, xml_original, created_at)
       VALUES (?, ?, ?, ?, '1', 15000, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      empresa,
      chave(9000 + sequencia),
      String(2000 + sequencia),
      NOTA_RECEBIDA,
      quando,
      quando,
      xmlDaCompra(marca),
      quando,
    );
  return id;
}

/** Lê a resposta como bytes — o zip não é JSON e o parser padrão o corromperia. */
function comoBytes(pedido: request.Test) {
  return pedido.buffer(true).parse((r, cb) => {
    const pedacos: Buffer[] = [];
    r.on('data', (d: Buffer) => pedacos.push(d));
    r.on('end', () => cb(null, Buffer.concat(pedacos)));
  });
}

// ---------------------------------------------------------------------------
// O QUE ELE LEVA
// ---------------------------------------------------------------------------

describe('o contador busca o mês dele sozinho', () => {
  it('lê a prévia, com as contagens do mês', async () => {
    notaEmitida(MINHA);
    notaRecebida(MINHA, 'Fornecedor A');

    const res = await request(app)
      .get(`${MONTAGEM}/fiscal/closings/${PERIODO}/previa`)
      .set(contador);

    expect(res.status).toBe(200);
    // O corpo é conferido, e não só o status: um 200 com corpo vazio seria uma
    // tela em branco com cara de sucesso.
    expect(res.body.contagens).toMatchObject({
      emitidasAutorizadas: 1,
      recebidasComArquivo: 1,
    });
  });

  it('baixa o pacote, e a auditoria registra que foi ELE quem levou', async () => {
    notaEmitida(MINHA);

    const res = await comoBytes(
      request(app).get(`${MONTAGEM}/fiscal/closings/${PERIODO}/pacote`).set(contador),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="pacote-${MINHA}-${PERIODO}.zip"`,
    );
    // Assinatura local de zip: chegou arquivo, e não um JSON de erro com 200.
    expect((res.body as Buffer).readUInt32LE(0)).toBe(0x04034b50);

    /*
      A auditoria ficou MAIS importante com esta rodada, não menos. Antes, todo
      download tinha um funcionário da loja atrás; agora tem uma pessoa de fora,
      e este registro é a única coisa que distingue "o contador buscou o mês
      dele" de "alguém de fora levou a empresa inteira".
    */
    const trilha = getConnection()
      .prepare(
        `SELECT user_id, entity_id FROM core_audit_log
          WHERE company_id = ? AND action = 'fiscal.closing.package'`,
      )
      .all(MINHA) as { user_id: string; entity_id: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].entity_id).toBe(PERIODO);

    const quem = getConnection()
      .prepare(
        `SELECT uc.profile_code FROM core_user_companies uc
          WHERE uc.user_id = ? AND uc.company_id = ?`,
      )
      .get(trilha[0].user_id, MINHA) as { profile_code: string };
    expect(quem.profile_code).toBe('contador');
  });

  it('lê o XML da nota de compra, byte por byte como o fornecedor mandou', async () => {
    const id = notaRecebida(MINHA, 'Fornecedor A');

    const res = await comoBytes(
      request(app).get(`${MONTAGEM}/purchases/notes/${id}/xml`).set(contador),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    // O conteúdo, e não só o status: a escrituração da compra é feita a partir
    // deste arquivo, e um XML truncado escritura errado sem avisar ninguém.
    expect((res.body as Buffer).toString('utf8')).toBe(xmlDaCompra('Fornecedor A'));
  });
});

// ---------------------------------------------------------------------------
// O QUE ELE NÃO ALCANÇA
// ---------------------------------------------------------------------------

/**
 * Uma amostra NOMEADA do que fica fechado, por assunto.
 *
 * A varredura já cobra as 307 sem exceção; estes casos existem porque um
 * vermelho que diz "a comissão abriu para o contador" conserta-se mais rápido
 * do que um vermelho que diz "a rota 214 divergiu". Cada linha é o assunto
 * escrito por extenso.
 */
const FECHADAS: [string, 'get' | 'post' | 'put' | 'delete', string][] = [
  ['criar venda', 'post', '/sales'],
  ['criar produto', 'post', '/products'],
  ['cancelar venda', 'post', '/sales/qualquer-uma/cancel'],
  ['cancelar nota fiscal', 'post', '/fiscal/documents/qualquer-um/cancel'],
  ['inutilizar numeração', 'post', '/fiscal/void-ranges'],
  ['ver a gaveta do caixa', 'get', '/cash/sessions'],
  ['ver comissão', 'get', '/commissions/summary'],
  ['ver a equipe', 'get', '/team'],
  ['ver o custo da mercadoria', 'get', '/stock/movements'],
  ['ver cliente', 'get', '/customers'],
  ['ver o financeiro', 'get', '/finance/entries'],
  ['ver o painel da operação', 'get', '/dashboard'],
  ['listar as notas de entrada', 'get', '/purchases/notes'],
  ['conferir item de nota de entrada', 'post', '/purchases/notes/qualquer-uma/link'],
];

describe('o que ele não alcança, dito por assunto', () => {
  for (const [assunto, metodo, rota] of FECHADAS) {
    it(`não pode ${assunto} — 403, e do RBAC`, async () => {
      const res = await request(app)[metodo](MONTAGEM + rota).set(contador);
      expect(res.status, `${metodo.toUpperCase()} ${rota}`).toBe(403);
      // O código importa: um 403 de outro motivo — assinatura, idempotência —
      // passaria por "guarda funcionando" sem o guarda existir.
      expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
    });
  }

  it('nem o XML da nota que a própria empresa EMITIU, avulso', async () => {
    /*
      O contraste que mostra que a linha foi desenhada e não copiada.

      O XML da nota EMITIDA ele recebe — dentro do pacote do mês, junto com o
      manifesto que diz o que veio e o que faltou. O que ele não recebe é a
      rota avulsa `/fiscal/documents/:id/xml`, que serve à tela de documentos
      fiscais da loja: aquela tela é do escritório, e dar-lhe o arquivo solto
      não acrescenta nada à escrituração — o mês inteiro já vai no zip.

      O XML da nota RECEBIDA é o caso oposto, e por isso ele o alcança: nota de
      compra chega depois do fechamento e precisa ser buscada sozinha.
    */
    const res = await request(app)
      .get(`${MONTAGEM}/fiscal/documents/qualquer-um/xml`)
      .set(contador);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
  });
});

// ---------------------------------------------------------------------------
// A EMPRESA É A DO VÍNCULO
// ---------------------------------------------------------------------------

describe('ele só enxerga a empresa a que está vinculado', () => {
  it('a prévia ignora `companyId` mandado na URL e conta a empresa do vínculo', async () => {
    // Duas empresas com volumes DIFERENTES: se a rota lesse o parâmetro, a
    // resposta mudaria de número e o caso ficaria vermelho na contagem.
    notaEmitida(MINHA);
    notaEmitida(VIZINHA);
    notaEmitida(VIZINHA);
    notaEmitida(VIZINHA);

    const res = await request(app)
      .get(`${MONTAGEM}/fiscal/closings/${PERIODO}/previa?companyId=${VIZINHA}`)
      .set(contador);

    expect(res.status).toBe(200);
    expect(res.body.contagens.emitidasAutorizadas).toBe(1);
  });

  it('o pacote sai com o nome da empresa dele, mesmo pedindo a outra', async () => {
    notaEmitida(VIZINHA);

    const res = await comoBytes(
      request(app)
        .get(`${MONTAGEM}/fiscal/closings/${PERIODO}/pacote?companyId=${VIZINHA}`)
        .set(contador),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="pacote-${MINHA}-${PERIODO}.zip"`,
    );
  });

  it('a nota de compra da empresa vizinha não existe para ele, sabendo o id', async () => {
    const daVizinha = notaRecebida(VIZINHA, 'Fornecedor da Vizinha');

    const res = await request(app)
      .get(`${MONTAGEM}/purchases/notes/${daVizinha}/xml`)
      .set(contador);

    // 404 e não 403: para ele a nota simplesmente não está no catálogo dele.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_INBOUND_NOTE_NOT_FOUND');

    // A prova de que o id existia mesmo: o contador da vizinha lê o arquivo.
    const daOutra = await sessao('contador', VIZINHA);
    const lido = await comoBytes(
      request(app).get(`${MONTAGEM}/purchases/notes/${daVizinha}/xml`).set(daOutra),
    );
    expect(lido.status).toBe(200);
    expect((lido.body as Buffer).toString('utf8')).toContain('Fornecedor da Vizinha');
  });
});

// ---------------------------------------------------------------------------
// QUEM ENTREGA O CRACHÁ
// ---------------------------------------------------------------------------

describe('dar login de dentro a uma pessoa de fora é decisão de dono', () => {
  const NOVO = {
    login: 'contabilidade@escritorio.com.br',
    displayName: 'Escritório Contábil Ltda',
    profileCode: 'contador',
    password: 'SenhaProvisoria@2026',
  };

  it('gerente de loja NÃO cria contador — 403, com o motivo escrito', async () => {
    const gerente = await sessao('gerente_loja');

    const res = await request(app).post(`${MONTAGEM}/team`).set(gerente).send(NOVO);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');
    // A mensagem é lida por gente na tela. Ela tem de dizer POR QUE, senão o
    // gerente conclui que o sistema quebrou e liga para alguém.
    expect(res.body.error.message).toContain('FORA da empresa');

    // E não sobrou meio usuário criado no caminho.
    const criados = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_users WHERE login = ?')
      .get(NOVO.login) as { n: number };
    expect(criados.n).toBe(0);
  });

  it('gerente de oficina também não — a recusa é do perfil, não da loja', async () => {
    const gerente = await sessao('gerente_oficina');
    const res = await request(app).post(`${MONTAGEM}/team`).set(gerente).send(NOVO);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');
  });

  it('o gestor cria, e o contador nasce podendo entrar', async () => {
    /*
      O outro lado. Sem ele, `PERFIS_DE_DONO` poderia recusar TODO MUNDO e os
      dois casos acima continuariam verdes — com o perfil inalcançável, que é o
      defeito que a rodada 23 encontrou em 235 rotas.
    */
    const gestor = await sessao('gestor');

    const criado = await request(app).post(`${MONTAGEM}/team`).set(gestor).send(NOVO);
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.profileCode).toBe('contador');
    // A senha não volta na resposta nem em pedaço.
    expect(JSON.stringify(criado.body)).not.toContain(NOVO.password);

    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: NOVO.login, password: NOVO.password, companyId: MINHA });
    expect(entrou.status).toBe(200);
    expect(entrou.body.user.profileCode).toBe('contador');
  });

  it('gerente de loja também não PROMOVE alguém a contador depois', async () => {
    /*
      A porta dos fundos do caso acima: se a recusa vivesse só na criação, o
      gerente cadastraria um atendente e o promoveria no PATCH seguinte.
    */
    const gerente = await sessao('gerente_loja');
    const atendente = await request(app).post(`${MONTAGEM}/team`).set(gerente).send({
      login: 'atendente-promovido@loja',
      displayName: 'Atendente',
      profileCode: 'atendente',
      password: 'SenhaProvisoria@2026',
    });
    expect(atendente.status).toBe(201);

    const res = await request(app)
      .patch(`${MONTAGEM}/team/${atendente.body.id}`)
      .set(gerente)
      .send({ profileCode: 'contador' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');

    // E o perfil dele continua sendo o que era.
    const agora = getConnection()
      .prepare('SELECT profile_code FROM core_user_companies WHERE user_id = ? AND company_id = ?')
      .get(atendente.body.id, MINHA) as { profile_code: string };
    expect(agora.profile_code).toBe('atendente');
  });

  it('a lista de perfis que a tela oferece inclui contador', async () => {
    // Sem isto, o perfil existiria no servidor e não teria como ser escolhido
    // em lugar nenhum — funcionalidade inalcançável, que parece pronta.
    const gestor = await sessao('gestor');
    const res = await request(app).get(`${MONTAGEM}/team/profiles`).set(gestor);
    expect(res.status).toBe(200);
    expect(res.body.items).toContain('contador');
  });
});

// ---------------------------------------------------------------------------
// O DESLIGAMENTO, QUE JÁ EXISTIA E É POR ISSO QUE O PERFIL É DE `core_users`
// ---------------------------------------------------------------------------

describe('trocar de escritório contábil é desativar um usuário', () => {
  /**
   * O argumento inteiro de NÃO ter criado um portal separado está aqui: o
   * desligamento JÁ EXISTE, já é auditado, já aparece na tela de equipe, e
   * passou a valer para o contador sem uma linha nova. Um portal próprio teria
   * de reimplementá-lo — e é exatamente o tipo de coisa que fica para trás.
   *
   * O que este caso cobra é o desfecho que o produto realmente promete: quem
   * foi desligado NÃO ENTRA MAIS. O bilhete que ele já tinha na mão é assunto
   * do relatório desta rodada, não deste caso — ver a nota logo abaixo.
   */
  async function desligarOContador(): Promise<void> {
    const gestor = await sessao('gestor');
    const equipe = await request(app).get(`${MONTAGEM}/team`).set(gestor);
    expect(equipe.status).toBe(200);
    const alvo = (equipe.body.items as { id: string; profileCode: string }[]).find(
      (m) => m.profileCode === 'contador',
    );
    // O contador aparece na tela de equipe como qualquer outro — é o mesmo
    // cadastro, e é por isso que o desligamento dele não precisou de tela nova.
    expect(alvo, 'o contador não apareceu na equipe da operação').toBeDefined();

    const desligado = await request(app)
      .post(`${MONTAGEM}/team/${alvo!.id}/active`)
      .set(gestor)
      .send({ active: false });
    expect(desligado.status).toBe(200);
    expect(desligado.body.active).toBe(false);
  }

  it('depois de desligado, ele não entra mais — o login é recusado', async () => {
    const antes = await request(app).post('/api/v1/auth/login').send({
      login: `contador-do-escritorio@${MINHA}`,
      password: 'Teste@GrupoSampaio2026',
      companyId: MINHA,
    });
    expect(antes.status).toBe(200);

    await desligarOContador();

    const depois = await request(app).post('/api/v1/auth/login').send({
      login: `contador-do-escritorio@${MINHA}`,
      password: 'Teste@GrupoSampaio2026',
      companyId: MINHA,
    });
    expect(depois.status).toBe(401);
  });

  it('o cadastro fica de pé: o download de março continua tendo dono no histórico', async () => {
    // Desligar não apaga. A trilha de "quem baixou o pacote de julho" aponta
    // para um usuário que precisa continuar existindo — senão a auditoria de
    // seis meses atrás vira um id órfão.
    notaEmitida(MINHA);
    const baixou = await comoBytes(
      request(app).get(`${MONTAGEM}/fiscal/closings/${PERIODO}/pacote`).set(contador),
    );
    expect(baixou.status).toBe(200);

    await desligarOContador();

    const trilha = getConnection()
      .prepare(
        `SELECT a.user_id, u.login, u.active
           FROM core_audit_log a
           JOIN core_users u ON u.id = a.user_id
          WHERE a.company_id = ? AND a.action = 'fiscal.closing.package'`,
      )
      .all(MINHA) as { user_id: string; login: string; active: number }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].login).toBe(`contador-do-escritorio@${MINHA}`);
    expect(trilha[0].active).toBe(0);
  });
});

/*
  ================================================================
  A PORTA DA FRENTE RECUSAVA E A DE TRÁS NÃO
  ================================================================

  `PERFIS_DE_DONO` guardava só a ATRIBUIÇÃO — quem pode ENTREGAR o perfil.
  Ninguém guardava a conta de quem já o tem. Medido, com o gerente de loja:

    - criar um gestor            -> 403, como esperado;
    - trocar a SENHA do gestor   -> 200, e a conta muda de dono;
    - DESATIVAR o gestor         -> 200.

  Um gerente não conseguia se promover, mas conseguia tomar a conta de quem já
  era — que dá no mesmo, com uma volta a mais.

  A rodada 29 tornou isso mais caro: `contador` entrou em `PERFIS_DE_DONO`
  porque dá login de dentro a uma pessoa de FORA. Sem esta guarda, qualquer
  gerente trocaria a senha do escritório de contabilidade e passaria a baixar o
  pacote fiscal do grupo como se fosse ele.
*/
describe('mexer na conta de quem é de dono também é de dono', () => {
  it('gerente de loja NÃO troca a senha do gestor', async () => {
    const gestor = await sessao('gestor');
    const equipe = await request(app).get(`${MONTAGEM}/team`).set(gestor);
    const alvo = (equipe.body.items as { id: string; profileCode: string }[]).find(
      (m) => m.profileCode === 'contador',
    );
    expect(alvo).toBeDefined();

    const gerente = await sessao('gerente_loja');
    const res = await request(app)
      .post(`${MONTAGEM}/team/${alvo!.id}/password`)
      .set(gerente)
      .send({ password: 'SenhaTomada@2026' });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('CORE_TARGET_ABOVE_YOURS');
  });

  it('gerente de loja NÃO desativa o contador', async () => {
    const gestor = await sessao('gestor');
    const equipe = await request(app).get(`${MONTAGEM}/team`).set(gestor);
    const alvo = (equipe.body.items as { id: string; profileCode: string }[]).find(
      (m) => m.profileCode === 'contador',
    );

    const gerente = await sessao('gerente_loja');
    const res = await request(app)
      .post(`${MONTAGEM}/team/${alvo!.id}/active`)
      .set(gerente)
      .send({ active: false });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('CORE_TARGET_ABOVE_YOURS');
  });

  /*
    A GUARDA É ESTREITA DE PROPÓSITO: ela vale para quem é de dono, e mais
    ninguém. Um gerente continua administrando a própria equipe — travar isso
    seria trocar uma escalada de privilégio por uma loja que não se administra.
  */
  it('mas continua administrando quem não é de dono', async () => {
    const gestor = await sessao('gestor');
    const criado = await request(app)
      .post(`${MONTAGEM}/team`)
      .set(gestor)
      .send({
        login: `balconista-comum@${MINHA}`,
        displayName: 'Balconista',
        password: 'Teste@GrupoSampaio2026',
        profileCode: 'estoquista',
      });
    expect(criado.status).toBe(201);

    const gerente = await sessao('gerente_loja');
    const res = await request(app)
      .post(`${MONTAGEM}/team/${criado.body.id}/active`)
      .set(gerente)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});
