/**
 * A SÉTIMA EMPRESA NASCE SEM UMA LINHA DE CÓDIGO — auditoria de entrega.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO PROVA, E POR QUE ELE É O CONTRATO DA ENTREGA
 * ============================================================================
 *
 * O dono vai cadastrar Gringa, Me Mimei, Conceito, PJ Motors e as futuras
 * SOZINHO, pelas telas. A promessa da arquitetura é: a única diferença entre
 * as empresas são DADOS, CREDENCIAIS, CERTIFICADOS e CONFIGURAÇÕES — nunca
 * código. Se qualquer passo abaixo exigisse um `if empresa === ...`, este
 * teste não teria como passar, porque a empresa daqui não existe em lugar
 * nenhum do código: ela nasce DURANTE o teste, pelas mesmas rotas que o dono
 * usa.
 *
 * A caminhada, na ordem em que o dono a faria:
 *
 *   1. quem responde pelo grupo abre a operação (POST /companies);
 *   2. o gerente dela entra e enxerga SÓ ela;
 *   3. preenche a configuração fiscal;
 *   4. sobe um certificado A1 (de teste, gerado aqui);
 *   5. guarda a chave Asaas sandbox no cofre DELA;
 *   6. configura as séries fiscais;
 *   7. lê o quadro de prontidão — que responde sobre ELA;
 *   8. cadastra produto, entra estoque e VENDE no PDV dela;
 *   9. e nada disso encosta nas outras empresas.
 *
 * O certificado e a chave são de TESTE e vivem no banco em memória deste
 * arquivo. Nenhuma empresa real é usada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import forge from 'node-forge';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);

const app = createApp();
const SENHA = 'Auditoria@2026';
const SENHA_CERT = 'senha-do-a1-de-teste';

/** Um .pfx de teste com cadeia (folha + AC), como o mundo real entrega. */
function pfxDeTeste(cnpj: string): string {
  const acKeys = forge.pki.rsa.generateKeyPair(1024);
  const folhaKeys = forge.pki.rsa.generateKeyPair(1024);
  const mk = (cn: string, issuer: string, pub: forge.pki.rsa.PublicKey, sign: forge.pki.rsa.PrivateKey) => {
    const c = forge.pki.createCertificate();
    c.publicKey = pub;
    c.serialNumber = '01';
    c.validity.notBefore = new Date(Date.now() - 86400000);
    c.validity.notAfter = new Date(Date.now() + 90 * 86400000);
    c.setSubject([{ name: 'commonName', value: cn }]);
    c.setIssuer([{ name: 'commonName', value: issuer }]);
    c.sign(sign);
    return c;
  };
  const ac = mk('AC FIXTURE AUDITORIA', 'AC FIXTURE AUDITORIA', acKeys.publicKey, acKeys.privateKey);
  const folha = mk(`EMPRESA FIXTURE:${cnpj}`, 'AC FIXTURE AUDITORIA', folhaKeys.publicKey, acKeys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(folhaKeys.privateKey, [folha, ac], SENHA_CERT, {
    algorithm: '3des',
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

let dono: { Authorization: string };
/** A prova da sessão do dono — a troca de operação a exige (R2-SESSAO). */
let refreshDoDono: string;
let precoJusto: string;

async function entrarComRefresh(login: string): Promise<{ auth: { Authorization: string }; refreshToken: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, refreshToken: String(res.body.refreshToken) };
}

async function entrar(login: string): Promise<{ Authorization: string }> {
  return (await entrarComRefresh(login)).auth;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  /*
    O mundo de partida: um grupo com UMA empresa já configurada (a "Preço
    Justo" deste cenário) e o dono com vínculo de gestor nela. O dono responde
    pelo grupo porque gerencia todas as ativas — é o mesmo critério da rota.
  */
  precoJusto = upsertCompany({
    slug: 'preco-justo-fixture',
    legalName: 'PRECO JUSTO FIXTURE LTDA',
    tradeName: 'Preço Justo Fixture',
    kind: 'retail',
  });
  const donoId = await upsertUser({ login: 'DONO', displayName: 'Dono do Grupo', password: SENHA });
  linkUserToCompany(donoId, precoJusto, 'gestor', true);
  const sessaoDoDono = await entrarComRefresh('DONO');
  dono = sessaoDoDono.auth;
  refreshDoDono = sessaoDoDono.refreshToken;
});

// ============================================================================

describe('a sétima operação nasce pelas rotas, não pelo código', () => {
  it('a caminhada inteira: criar → configurar → certificado → Asaas → série → prontidão → vender', async () => {
    // ------------------------------------------------------------ 1. nascer
    const criada = await request(app)
      .post('/api/v1/core/companies')
      .set(dono)
      .send({
        legalName: 'EMPRESA FIXTURE DA AUDITORIA LTDA',
        tradeName: 'Fixture Auditoria',
        kind: 'retail',
        // CNPJ de teste válido pelo módulo 11.
        cnpj: '11.222.333/0001-81',
        manager: { login: 'GERENTE.FIXTURE', displayName: 'Gerente Fixture', password: SENHA },
      });
    expect(criada.status).toBe(201);
    const empresaId = String(criada.body.company?.id ?? criada.body.id);
    expect(empresaId).toBeTruthy();

    /*
      ------------------------------------------ 2. o dono TROCA para a nova
      A rota vincula os administradores do grupo à operação recém-criada
      (`linkedGroupAdmins`), e a troca de empresa é a mesma do seletor do
      topo: `switch-company`, que confere o vínculo. É exatamente o gesto que
      o dono fará na tela.
    */
    const troca = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(dono)
      .send({ companyId: empresaId, refreshToken: refreshDoDono });
    expect(troca.status).toBe(200);
    const donoNaNova = { Authorization: `Bearer ${troca.body.accessToken}` };

    // E o gerente criado junto enxerga a empresa ao entrar.
    const sessaoGerente = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.FIXTURE', password: SENHA });
    expect(sessaoGerente.status).toBe(200);
    expect(sessaoGerente.body.company?.id).toBe(empresaId);

    /*
      A senha do gerente é PROVISÓRIA — o dono a digitou na criação. Desde o
      GAP-PRD-202 a API só responde à troca até ela acontecer, então a
      caminhada faz o que o gerente fará na tela: troca e entra de novo.
    */
    expect(sessaoGerente.body.user.mustChangePassword).toBe(true);
    const troca1 = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${sessaoGerente.body.accessToken}` })
      .send({ currentPassword: SENHA, newPassword: `${SENHA}-dele` });
    expect(troca1.status).toBe(204);
    const sessaoDefinitiva = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.FIXTURE', password: `${SENHA}-dele` });
    expect(sessaoDefinitiva.status).toBe(200);
    const gerente = { Authorization: `Bearer ${sessaoDefinitiva.body.accessToken}` };

    // ------------------------------------------------------ 3. config fiscal
    const config = await request(app)
      .patch('/api/v1/core/fiscal/config')
      .set(gerente)
      .send({
        legalName: 'EMPRESA FIXTURE DA AUDITORIA LTDA',
        cnpj: '11.222.333/0001-81',
        ie: '123456789',
        crt: '1',
        street: 'Rua da Fixture',
        number: '1',
        district: 'Centro',
        cityName: 'Pelotas',
        cityIbge: '4314407',
        uf: 'RS',
      });
    expect(config.status).toBe(200);
    expect(config.body.crt).toBe('1');

    // -------------------------------------------------- 4. certificado DELA
    const cert = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(donoNaNova)
      .send({ pfxBase64: pfxDeTeste('11222333000181'), certificatePassword: SENHA_CERT });
    expect(cert.status).toBe(201);
    expect(String(cert.body.certificate?.cnpj ?? '')).toBe('11222333000181');

    // ------------------------------------------------ 5. Asaas no cofre DELA
    const chave = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(donoNaNova)
      .send({ environment: 'sandbox', apiKey: 'chave-sandbox-de-teste-da-fixture' });
    expect(chave.status).toBe(200);
    expect(chave.body.credentials.sandbox.configured).toBe(true);
    expect(chave.body.credentials.sandbox.source).toBe('vault');

    // ----------------------------------------------------------- 6. séries
    const serie = await request(app)
      .post('/api/v1/core/fiscal/series')
      .set(gerente)
      .send({ model: '65', serie: 1, nextNumber: 1 });
    expect(serie.status).toBe(200);

    // ------------------------------------------------------- 7. prontidão
    const quadro = await request(app)
      .get('/api/v1/core/fiscal/readiness?model=65')
      .set(gerente);
    expect(quadro.status).toBe(200);
    const itens = quadro.body.items[0].items as { key: string; status: string }[];
    // A empresa nova responde por ELA: certificado dela PASS, série PASS.
    expect(itens.find((i) => i.key === 'certificate')?.status).toBe('PASS');
    expect(itens.find((i) => i.key === 'serie')?.status).toBe('PASS');

    // --------------------------------------- 8. produto, estoque e venda PDV
    const produto = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Produto da Fixture', priceCents: 5000 });
    expect(produto.status).toBe(201);
    const produtoId = String(produto.body.id);

    const entrada = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerente)
      .send({ productId: produtoId, movementType: 'in', quantity: 10, referenceId: 'entrada-fixture-1' });
    expect([200, 201]).toContain(entrada.status);

    // O caixa abre NA empresa nova — e a venda entra nele.
    const caixa = await request(app)
      .post('/api/v1/core/cash/open')
      .set(gerente)
      .send({ openingCents: 10000 });
    expect([200, 201]).toContain(caixa.status);
    const cashSessionId = String(caixa.body.id ?? caixa.body.sessionId ?? caixa.body.session?.id);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerente)
      .set('Idempotency-Key', 'venda-fixture-1')
      .send({
        cashSessionId,
        items: [{ productId: produtoId, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 10000 }],
      });
    expect([200, 201]).toContain(venda.status);

    // ------------------------------------------- 9. e a vizinha nem percebeu
    const vizinha = await entrar('DONO');
    const produtosDaVizinha = await request(app)
      .get('/api/v1/core/products?search=Fixture')
      .set(vizinha);
    expect(produtosDaVizinha.status).toBe(200);
    const nomes = (produtosDaVizinha.body.items ?? []).map((p: { name: string }) => p.name);
    // O produto da empresa nova NÃO aparece no catálogo da primeira.
    expect(nomes).not.toContain('Produto da Fixture');
  });

  it('o gerente de uma loja NÃO abre operação nova — é de quem responde pelo grupo', async () => {
    // Um gerente preso a uma empresa só.
    const gerenteId = await upsertUser({
      login: 'GERENTE.PRESO',
      displayName: 'Gerente de Uma Loja',
      password: SENHA,
    });
    linkUserToCompany(gerenteId, precoJusto, 'gerente_loja', true);
    const preso = await entrar('GERENTE.PRESO');

    const res = await request(app)
      .post('/api/v1/core/companies')
      .set(preso)
      .send({ legalName: 'INVASORA LTDA', tradeName: 'Invasora', kind: 'retail' });

    expect(res.status).toBe(403);
  });

  it('empresa nova SEM certificado e SEM Asaas responde "falta o meu" — nunca usa o da vizinha', async () => {
    /*
      A REGRA DE NÃO-FALLBACK, na prática. A primeira empresa do grupo tem
      certificado e chave; a recém-criada não tem nada. As respostas precisam
      ser sobre ELA — READY_FOR_CERTIFICATE, credencial não configurada — e
      jamais os dados da vizinha.
    */
    // A vizinha ganha certificado e chave.
    await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(dono)
      .send({ pfxBase64: pfxDeTeste('99888777000160'), certificatePassword: SENHA_CERT });
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(dono)
      .send({ environment: 'sandbox', apiKey: 'chave-da-vizinha-que-nao-vaza' });

    // Nasce a segunda, vazia.
    const criada = await request(app)
      .post('/api/v1/core/companies')
      .set(dono)
      .send({
        legalName: 'EMPRESA VAZIA LTDA',
        tradeName: 'Vazia',
        kind: 'retail',
        manager: { login: 'GERENTE.VAZIA', displayName: 'G Vazia', password: SENHA },
      });
    expect(criada.status).toBe(201);
    const idVazia = String(criada.body.company?.id ?? criada.body.id);
    const trocaVazia = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(dono)
      .send({ companyId: idVazia, refreshToken: refreshDoDono });
    expect(trocaVazia.status).toBe(200);
    const gerente = { Authorization: 'Bearer ' + trocaVazia.body.accessToken };

    // Certificado: o DELA não existe — e a resposta diz isso.
    const cert = await request(app).get('/api/v1/core/fiscal/certificate').set(gerente);
    expect(cert.status).toBe(200);
    expect(cert.body.configured).toBe(false);

    // Asaas: nada configurado — e nada da vizinha.
    const asaas = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
    expect(asaas.status).toBe(200);
    expect(asaas.body.credentials.sandbox.configured).toBe(false);
    expect(asaas.body.status.readiness).toBe('READY_FOR_CREDENTIAL');
  });
});
