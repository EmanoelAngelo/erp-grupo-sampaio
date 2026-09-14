/**
 * ============================================================================
 * A SÉTIMA OPERAÇÃO — e por que cada caso aqui quebra sem o que ele protege
 * ============================================================================
 *
 * Existia uma rota de criar empresa. Ela respondia 201 com uma empresa que
 * NUNCA tocava `core_companies`: o serviço guardava tudo num `Map` do
 * processo. Não havia teste nenhum sobre ela — nem podia haver de verdade,
 * porque não havia nada no banco para conferir. Foi assim que um 201 falso
 * atravessou vinte e quatro rodadas.
 *
 * Todo caso deste arquivo ATRAVESSA HTTP e termina conferindo o BANCO ou
 * fazendo um LOGIN de verdade. Nenhum procura texto de código, e nenhum se
 * contenta com o código de status: o status era exatamente o que a rota
 * fantasma acertava.
 *
 * COMO CADA GUARDA FALHA (verificado quebrando cada um de propósito):
 *
 *  - tirando `requireProfile(req)` de `POST /core/companies`, o estoquista
 *    passa a criar empresa e o caso do 403 falha;
 *  - lendo `req.body.companyId` em vez do escopo da sessão, o caso do corpo
 *    ignorado vincula o gerente à empresa alheia e falha;
 *  - derivando os administradores do grupo DEPOIS do `INSERT` da empresa, a
 *    lista volta vazia (ninguém é mais admin de TODAS) e o caso da ordem falha;
 *  - criando o gerente com `createTeamMember` (que abre a própria transação e
 *    é `async`) em vez de `inserirMembroDaEquipe`, o caso do rollback deixa a
 *    empresa órfã no banco e falha;
 *  - criando o gerente ANTES da bancada, o caso da oficina falha com
 *    `CORE_WORKSHOP_LINK_REQUIRED` — a empresa nem chega a nascer;
 *  - tirando o `slugLivre`, o caso do nome repetido estoura o UNIQUE do
 *    SQLite e devolve 500 em vez da segunda empresa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
const SENHA = 'Teste@Empresa2026';
const SENHA_GERENTE = 'Gerente@Novo2026';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/** Usuário de verdade, com senha Argon2id e login real — nada de token forjado. */
async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** Só vincula: usado para os administradores que não fazem login no caso. */
async function usuarioVinculado(login: string, vinculos: [string, string][]): Promise<string> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const [companyId, profile] of vinculos) {
    linkUserToCompany(userId, companyId, profile, false);
  }
  return userId;
}

function empresaPorSlug(slug: string): { id: string; kind: string; legal_name: string } | undefined {
  return getConnection()
    .prepare('SELECT id, kind, legal_name FROM core_companies WHERE slug = ?')
    .get(slug) as { id: string; kind: string; legal_name: string } | undefined;
}

function vinculosDe(userId: string): { company_id: string; profile_code: string }[] {
  return getConnection()
    .prepare('SELECT company_id, profile_code FROM core_user_companies WHERE user_id = ?')
    .all(userId) as unknown as { company_id: string; profile_code: string }[];
}

let lojaMae: string;

beforeEach(() => {
  resetDbForTests();
  lojaMae = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
});

/** O corpo mínimo de uma loja nova. */
function corpoDeLoja(extra: Record<string, unknown> = {}) {
  return {
    legalName: 'Sampaio Bikes Comércio Ltda',
    tradeName: 'Sampaio Bikes',
    kind: 'retail',
    manager: {
      login: 'GERENTE.BIKES',
      displayName: 'Gerente das Bikes',
      password: SENHA_GERENTE,
    },
    ...extra,
  };
}

describe('a empresa nasce inteira, e o gerente consegue entrar nela', () => {
  it('empresa chamada "PDV" não ganha /pdv como endereço de loja — a rota do sistema ganharia da loja', async () => {
    const dono = await ator('DONO.SLUG', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          legalName: 'PDV Comércio de Peças Ltda',
          tradeName: 'PDV',
          manager: { login: 'GERENTE.PDV', displayName: 'Gerente da PDV', password: SENHA_GERENTE },
        }),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(empresaPorSlug('pdv')).toBeUndefined();
    expect(empresaPorSlug('pdv-2')).toBeDefined();
  });
  it('cria a linha, o vínculo de quem criou e o gerente — e o gerente faz login', async () => {
    const dono = await ator('DONO1', lojaMae, 'admin_geral');

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja());

    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // (1) A LINHA EXISTE NO BANCO. É o que a rota fantasma nunca fez.
    const linha = empresaPorSlug('sampaio-bikes');
    expect(linha).toBeDefined();
    expect(linha!.id).toBe(res.body.company.id);
    expect(linha!.legal_name).toBe('Sampaio Bikes Comércio Ltda');
    expect(linha!.kind).toBe('retail');

    // (2) QUEM CRIOU ESTÁ DENTRO. Sem isto, quem abriu a operação não
    // conseguiria entrar nela para configurá-la.
    const doCriador = vinculosDe(dono.userId).find((v) => v.company_id === linha!.id);
    expect(doCriador?.profile_code).toBe('admin_geral');

    // (3) O GERENTE ENTRA — o teste que nenhuma asserção de banco substitui.
    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.BIKES', password: SENHA_GERENTE, companyId: linha!.id });
    expect(entrou.status, JSON.stringify(entrou.body)).toBe(200);
    expect(entrou.body.company.id).toBe(linha!.id);
    expect(entrou.body.user.profileCode).toBe('gerente_loja');

    // (4) E ela aparece na listagem do grupo.
    const lista = await request(app).get('/api/v1/core/companies').set(dono.auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items.map((c: { slug: string }) => c.slug)).toContain('sampaio-bikes');
  });

  it('a auditoria fica legível dos DOIS lados — a origem e a empresa nova', async () => {
    /*
      `listAudit` filtra por empresa, e a criação acontece ENTRE duas. Com um
      registro só, um dos dois lados fica cego: ou a trilha de quem criou não
      menciona o que ele fez, ou a empresa nova começa com um gerente surgindo
      do nada.
    */
    const dono = await ator('DONO2', lojaMae, 'admin_geral');
    const res = await request(app).post('/api/v1/core/companies').set(dono.auth).send(corpoDeLoja());
    expect(res.status).toBe(201);
    const novaId = res.body.company.id as string;

    const linhas = getConnection()
      .prepare("SELECT company_id FROM core_audit_log WHERE action = 'company.created'")
      .all() as unknown as { company_id: string }[];
    const empresas = linhas.map((l) => l.company_id);
    expect(empresas).toContain(lojaMae);
    expect(empresas).toContain(novaId);
  });
});

describe('quem não pode criar', () => {
  it('estoquista recebe 403 e nenhuma empresa nasce', async () => {
    /*
      O caso que prova o guarda. `estoquista` vive no ambiente `gestao` — o
      mesmo do `gestor` —, então o roteador do navegador o deixaria chegar numa
      tela de ROTA_GESTAO. É exatamente por isso que a rodada NÃO tem tela: o
      servidor nega, e não há mecanismo de filtro por perfil na navegação.
    */
    const estoquista = await ator('ESTOQUE1', lojaMae, 'estoquista');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(estoquista.auth)
      .send(corpoDeLoja());

    expect(res.status).toBe(403);
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
  });

  it('gerente de loja e caixa também recebem 403', async () => {
    for (const [login, perfil] of [
      ['GER.LOJA1', 'gerente_loja'],
      ['CAIXA1', 'operador_caixa_loja'],
      ['ATEND1', 'atendente'],
    ] as const) {
      const a = await ator(login, lojaMae, perfil);
      const res = await request(app).post('/api/v1/core/companies').set(a.auth).send(corpoDeLoja());
      expect(res.status, perfil).toBe(403);
    }
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
  });

  it('estoquista também não LISTA as empresas do grupo', async () => {
    // A listagem atravessa tenants: ela devolve as operações e os CNPJs do
    // grupo inteiro. Guardá-la mais frouxo que a criação seria vazar de leitura
    // o que a escrita protege.
    const estoquista = await ator('ESTOQUE2', lojaMae, 'estoquista');
    const res = await request(app).get('/api/v1/core/companies').set(estoquista.auth);
    expect(res.status).toBe(403);
  });

  it('gestor PODE criar — o guarda abriu de propósito, e está medido aqui', async () => {
    const gestor = await ator('GESTOR1', lojaMae, 'gestor');
    const res = await request(app).post('/api/v1/core/companies').set(gestor.auth).send(corpoDeLoja());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('o corpo não escolhe tenant nem pessoa', () => {
  it('companyId e userId no corpo são IGNORADOS — não dá para se vincular a outra', async () => {
    /*
      O vazamento da rodada 14, que a rota fantasma reintroduziu em outro
      arquivo: as irmãs dela liam `body.companyId`, e o `assertScope` era
      curto-circuitado por um `isGroupAdmin` que incluía `gestor`.

      Aqui um `gestor` do Preço Justo tenta plantar o gerente novo DENTRO da
      Gringa, mandando o id dela no corpo — e tenta creditar a criação a outra
      pessoa mandando o `userId` dela.
    */
    const gringa = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Comércio Ltda',
      tradeName: 'Gringa',
      kind: 'retail',
    });
    const alheio = await usuarioVinculado('ALHEIO1', [[gringa, 'gerente_loja']]);
    const invasor = await ator('GESTOR2', lojaMae, 'gestor');
    // Desde a rodada 48, abrir operação exige responder por TODAS as ativas
    // (`respondePeloGrupo`). O ponto deste caso é o corpo ignorado, não o
    // alcance — então o invasor é gestor do grupo de verdade.
    linkUserToCompany(invasor.userId, gringa, 'gestor', false);

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(invasor.auth)
      .send(corpoDeLoja({ companyId: gringa, userId: alheio, id: gringa }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const nova = empresaPorSlug('sampaio-bikes')!;
    expect(nova.id).not.toBe(gringa);

    // O gerente novo tem UM vínculo, e ele é com a empresa que o servidor
    // acabou de criar. Nada entrou na Gringa.
    const gerenteId = res.body.manager.id as string;
    const doGerente = vinculosDe(gerenteId);
    expect(doGerente.map((v) => v.company_id)).toEqual([nova.id]);

    // E o usuário alheio continua exatamente como estava: só a Gringa.
    expect(vinculosDe(alheio).map((v) => v.company_id)).toEqual([gringa]);

    // Quem ganhou o vínculo de criador foi quem apertou o botão.
    expect(vinculosDe(invasor.userId).map((v) => v.company_id)).toContain(nova.id);
  });
});

describe('a ordem dos administradores do grupo', () => {
  it('os admin de TODAS as empresas são derivados ANTES, e entram na nova', async () => {
    /*
      "Administrador do grupo" é quem é `admin_geral` em TODAS as empresas
      ativas. A lista tem de ser derivada ANTES do INSERT: derivada depois, o
      denominador do COUNT já inclui a empresa recém-criada — na qual ninguém
      está vinculado ainda — e NINGUÉM satisfaz o "todas". A lista volta vazia,
      e o defeito não dá erro nenhum: um grupo sem administradores tem
      exatamente a mesma cara.
    */
    const gringa = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Comércio Ltda',
      tradeName: 'Gringa',
      kind: 'retail',
    });

    const doGrupo = await usuarioVinculado('ADMIN.GRUPO', [
      [lojaMae, 'admin_geral'],
      [gringa, 'admin_geral'],
    ]);
    // Admin de UMA só: não é administrador do grupo, e não deve ser arrastado.
    const deUmaSo = await usuarioVinculado('ADMIN.LOCAL', [[lojaMae, 'admin_geral']]);

    const criador = await ator('GESTOR3', lojaMae, 'gestor');
    // Rodada 48: quem cria responde pelo grupo — gestor nas DUAS ativas.
    linkUserToCompany(criador.userId, gringa, 'gestor', false);
    const res = await request(app).post('/api/v1/core/companies').set(criador.auth).send(corpoDeLoja());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const nova = res.body.company.id as string;

    expect(res.body.linkedGroupAdmins).toContain(doGrupo);
    expect(vinculosDe(doGrupo).map((v) => v.company_id)).toContain(nova);
    expect(vinculosDe(deUmaSo).map((v) => v.company_id)).not.toContain(nova);

    // E o administrador do grupo continua conseguindo ENTRAR na empresa nova.
    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'ADMIN.GRUPO', password: SENHA, companyId: nova });
    expect(entrou.status, JSON.stringify(entrou.body)).toBe(200);
  });
});

describe('a empresa de oficina nasce com bancada', () => {
  it('a bancada existe e o gerente de oficina foi criado vinculado a ela', async () => {
    /*
      `inserirMembroDaEquipe` recusa `gerente_oficina` sem ao menos uma oficina
      vinculada — a mesma regra que impede um gerente de entrar e ver uma tela
      vazia sem explicação. Por isso a bancada nasce ANTES do gerente. Se a
      ordem inverter, a criação inteira falha com
      `CORE_WORKSHOP_LINK_REQUIRED` e este caso fica vermelho.
    */
    const dono = await ator('DONO3', lojaMae, 'admin_geral');

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send({
        legalName: 'Sampaio Motos Serviços Ltda',
        tradeName: 'Sampaio Motos',
        kind: 'workshop',
        manager: {
          login: 'GERENTE.MOTOS',
          displayName: 'Gerente das Motos',
          password: SENHA_GERENTE,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const nova = empresaPorSlug('sampaio-motos')!;
    expect(nova.kind).toBe('workshop');

    const bancada = getConnection()
      .prepare('SELECT id, slug FROM core_workshops WHERE company_id = ?')
      .get(nova.id) as { id: string; slug: string } | undefined;
    expect(bancada).toBeDefined();
    expect(res.body.workshop.id).toBe(bancada!.id);

    // O gerente é de oficina E está na bancada — as duas coisas, porque uma
    // sem a outra é a tela vazia.
    expect(res.body.manager.profileCode).toBe('gerente_oficina');
    const membro = getConnection()
      .prepare('SELECT role FROM core_workshop_members WHERE workshop_id = ? AND user_id = ?')
      .get(bancada!.id, res.body.manager.id) as { role: string } | undefined;
    expect(membro?.role).toBe('gerente_oficina');

    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.MOTOS', password: SENHA_GERENTE, companyId: nova.id });
    expect(entrou.status).toBe(200);
  });

  it('gerente de oficina numa LOJA é recusado, e nada fica no banco', async () => {
    const dono = await ator('DONO4', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          manager: {
            login: 'GERENTE.SEMBANCADA',
            displayName: 'Sem Bancada',
            password: SENHA_GERENTE,
            profileCode: 'gerente_oficina',
          },
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_WORKSHOP_LINK_REQUIRED');
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
  });
});

describe('o slug repetido é tratado pelo servidor', () => {
  it('duas empresas com o mesmo nome fantasia ganham endereços diferentes', async () => {
    const dono = await ator('DONO5', lojaMae, 'admin_geral');

    const primeira = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja());
    expect(primeira.status).toBe(201);
    expect(primeira.body.company.slug).toBe('sampaio-bikes');

    const segunda = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          manager: {
            login: 'GERENTE.BIKES2',
            displayName: 'Outro Gerente',
            password: SENHA_GERENTE,
          },
        }),
      );

    // 201, e não 409: o nome fantasia repetido é comum de verdade (filial), e
    // o slug é DERIVADO — quem escolhe é o servidor, então cabe a ele resolver
    // a colisão em vez de mandar o usuário adivinhar um nome livre.
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
    expect(segunda.body.company.slug).toBe('sampaio-bikes-2');
    expect(segunda.body.company.id).not.toBe(primeira.body.company.id);
  });

  it('duas oficinas com o mesmo nome não colidem no UNIQUE GLOBAL da bancada', async () => {
    // `core_workshops.slug` é UNIQUE no banco INTEIRO, não por empresa. Duas
    // oficinas homônimas em empresas diferentes estourariam a constraint no
    // meio da transação.
    const dono = await ator('DONO6', lojaMae, 'admin_geral');
    const corpo = (login: string) => ({
      legalName: 'Oficina do Zé Ltda',
      tradeName: 'Oficina do Zé',
      kind: 'workshop',
      manager: { login, displayName: 'Zé', password: SENHA_GERENTE },
    });

    const a = await request(app).post('/api/v1/core/companies').set(dono.auth).send(corpo('ZE1'));
    const b = await request(app).post('/api/v1/core/companies').set(dono.auth).send(corpo('ZE2'));

    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.workshop.slug).not.toBe(a.body.workshop.slug);
  });

  it('o slug reservado da visão consolidada não é ocupado', async () => {
    // `auth.ts` recusa login direto em `grupo` e `grupo-sampaio`. Uma empresa
    // com esse slug nasceria com gerente, vínculos e nenhuma porta.
    const dono = await ator('DONO7', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          tradeName: 'Grupo Sampaio',
          legalName: 'Grupo Sampaio Participações Ltda',
        }),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.company.slug).not.toBe('grupo-sampaio');

    const entrou = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.BIKES', password: SENHA_GERENTE, companyId: res.body.company.id });
    expect(entrou.status, JSON.stringify(entrou.body)).toBe(200);
  });
});

describe('tudo ou nada — a transação única', () => {
  it('login de gerente já existente derruba a empresa junto', async () => {
    /*
      ESTE É O CASO DO BLOQUEIO DA TRANSAÇÃO.

      `withTransaction` é SÍNCRONA e `createTeamMember` é `async`. Chamando a
      segunda de dentro da primeira, a Promise volta na hora, o COMMIT acontece
      antes de o gerente existir, e o erro do gerente NÃO desfaz a empresa: fica
      uma operação no banco sem ninguém que consiga entrar nela — uma porta
      trancada com a chave dentro.

      Por isso o gerente nasce por `inserirMembroDaEquipe`, que é síncrona e
      recebe o hash já derivado. O `CORE_LOGIN_TAKEN` abaixo é lançado DENTRO
      da transação, e leva a empresa, o vínculo do criador e a bancada embora.
    */
    const dono = await ator('DONO8', lojaMae, 'admin_geral');
    await upsertUser({ login: 'JAEXISTE', displayName: 'Já Existe', password: SENHA });

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          manager: { login: 'JAEXISTE', displayName: 'Impostor', password: SENHA_GERENTE },
        }),
      );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_LOGIN_TAKEN');

    // NADA sobrou: nem a empresa, nem o vínculo do criador.
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
    expect(vinculosDe(dono.userId).map((v) => v.company_id)).toEqual([lojaMae]);
  });

  it('a oficina meio-criada também some inteira', async () => {
    const dono = await ator('DONO9', lojaMae, 'admin_geral');
    await upsertUser({ login: 'OCUPADO', displayName: 'Ocupado', password: SENHA });

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send({
        legalName: 'Sampaio Motos Serviços Ltda',
        tradeName: 'Sampaio Motos',
        kind: 'workshop',
        manager: { login: 'OCUPADO', displayName: 'Ocupado', password: SENHA_GERENTE },
      });

    expect(res.status).toBe(409);
    expect(empresaPorSlug('sampaio-motos')).toBeUndefined();
    // A bancada nasce ANTES do gerente, então é ela quem prova o rollback.
    const bancadas = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_workshops WHERE slug LIKE 'oficina-sampaio-motos%'")
      .get() as { n: number };
    expect(bancadas.n).toBe(0);
  });
});

describe('o que a rota recusa antes de gravar', () => {
  it('razão social vazia é 400', async () => {
    const dono = await ator('DONO10', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja({ legalName: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_COMPANY_INCOMPLETE');
  });

  it('senha provisória curta é 400, e a empresa não nasce', async () => {
    // A senha é conferida ANTES do hash, e portanto antes da transação: é a
    // mesma regra de `POST /core/team`, na mesma função.
    const dono = await ator('DONO11', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(
        corpoDeLoja({
          manager: { login: 'FRACA', displayName: 'Fraca', password: '123' },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PASSWORD_WEAK');
    expect(empresaPorSlug('sampaio-bikes')).toBeUndefined();
  });

  it('CNPJ com dígito errado é 400 — o mesmo módulo 11 da configuração fiscal', async () => {
    // Gravar CNPJ errado agora vira rejeição da SEFAZ depois, com a venda feita.
    const dono = await ator('DONO12', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja({ cnpj: '11.111.111/1111-11' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_COMPANY_CNPJ_INVALID');
  });

  it('tipo de operação desconhecido é 400', async () => {
    const dono = await ator('DONO13', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(dono.auth)
      .send(corpoDeLoja({ kind: 'franquia' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_COMPANY_KIND_INVALID');
  });
});

describe('a rota fantasma não existe mais', () => {
  it('POST /organizations/companies responde 404, e não 201', async () => {
    /*
      Ela respondia 201 para uma empresa que nunca chegava ao banco. Enquanto
      existia, quem integrasse contra a API escreveria o cliente contra uma
      promessa vazia — e o 404 de hoje é informação honesta, enquanto o 201 era
      desinformação.
    */
    const dono = await ator('DONO14', lojaMae, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/organizations/companies')
      .set(dono.auth)
      .send({ name: 'Fantasma' });
    expect(res.status).toBe(404);
  });

  it('o openapi não anuncia mais nenhuma rota /organizations', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).not.toContain('/organizations/companies');
    expect(Object.keys(res.body.paths)).toContain('/core/companies');
  });
});

/*
  A ESCALADA QUE ESTA RODADA CRIOU O PRÊMIO PARA COMETER.

  `gestor` passa em `requireProfile` na primeira linha, em toda rota do núcleo.
  Enquanto isso era "ver e operar as seis lojas", um gerente fabricar um gestor
  já era largo demais. Depois que fundar operação virou possível, virou escalada
  com prêmio: o gerente de UMA loja criava a conta, entrava com ela, e abria
  empresas no grupo inteiro.

  Medido antes do conserto: 201 no cadastro e 201 na criação de empresa.

  A regra é a mais simples que fecha isso — ninguém entrega um crachá que não
  tem —, e ela vale nos DOIS caminhos: criar já com o perfil, e promover depois.
*/
describe('ninguém entrega um crachá que não tem', () => {
  let matriz: string;
  let gerente: Ator;

  beforeEach(async () => {
    matriz = upsertCompany({
      slug: 'matriz-escalada',
      legalName: 'Matriz Ltda',
      tradeName: 'Matriz',
      kind: 'retail',
    });
    gerente = await ator('gerente.escalada', matriz, 'gerente_loja');
  });

  it('gerente de loja NÃO cria um gestor', async () => {
    const res = await request(app)
      .post('/api/v1/core/team')
      .set(gerente.auth)
      .send({
        login: 'novo.gestor',
        displayName: 'Novo Gestor',
        profileCode: 'gestor',
        password: SENHA_GERENTE,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');
    // E não sobra usuário meio criado.
    const existe = getConnection()
      .prepare('SELECT 1 AS ok FROM core_users WHERE login = ?')
      .get('novo.gestor') as { ok?: number } | undefined;
    expect(existe?.ok).toBeUndefined();
  });

  it('nem PROMOVE alguém a gestor depois — era o caminho mais curto', async () => {
    const criado = await request(app)
      .post('/api/v1/core/team')
      .set(gerente.auth)
      .send({
        login: 'atendente.comum',
        displayName: 'Atendente',
        profileCode: 'atendente',
        password: SENHA_GERENTE,
      });
    expect(criado.status).toBe(201);

    const promoveu = await request(app)
      .patch(`/api/v1/core/team/${criado.body.id}`)
      .set(gerente.auth)
      .send({ profileCode: 'gestor' });

    expect(promoveu.status).toBe(403);
    expect(promoveu.body.error.code).toBe('CORE_PROFILE_ABOVE_YOURS');
  });

  it('o gerente continua montando o time dele — a trava não é uma parede', async () => {
    for (const perfil of ['atendente', 'estoquista', 'operador_caixa_loja', 'gerente_loja']) {
      const res = await request(app)
        .post('/api/v1/core/team')
        .set(gerente.auth)
        .send({
          login: `time.${perfil}`,
          displayName: perfil,
          profileCode: perfil,
          password: SENHA_GERENTE,
        });
      expect(res.status, `${perfil}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  it('quem já responde pelo grupo ENTREGA o crachá normalmente', async () => {
    const dono = await ator('dono.grupo', matriz, 'admin_geral');
    const res = await request(app)
      .post('/api/v1/core/team')
      .set(dono.auth)
      .send({
        login: 'gestor.legitimo',
        displayName: 'Gestor Legítimo',
        profileCode: 'gestor',
        password: SENHA_GERENTE,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
