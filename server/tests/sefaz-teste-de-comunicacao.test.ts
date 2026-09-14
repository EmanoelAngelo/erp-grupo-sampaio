/**
 * TESTAR A COMUNICAÇÃO COM A SEFAZ — rodada 58.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO NA TELA CONTRA O BANCO REAL
 * ============================================================================
 *
 * O dono subiu o certificado A1 da Preço Justo e perguntou a coisa mais
 * simples do mundo: "a comunicação com a SEFAZ funciona?".
 *
 * O sistema não sabia responder. `statusServico` existe nos dois adapters e
 * fala SOAP de verdade contra `nfe-homologacao.sefazrs.rs.gov.br` — e NINGUÉM
 * o chama: nenhuma rota, nenhuma tela. Código que nasceu sem porta, a terceira
 * vez que esta base repete o padrão.
 *
 * O que a tela de certificado mostrava era `CERTIFICATE_LOADED · FALTA TESTE
 * REAL CONTRA A SEFAZ` — honesto, e sem oferecer o teste que ela mesma cobra.
 *
 * ============================================================================
 * POR QUE O TESTE DE STATUS, E NÃO "EMITIR UMA NOTA DE TESTE"
 * ============================================================================
 *
 * `statusServico` é a única conversa com o fisco que NÃO cria documento. Ela
 * responde as quatro perguntas que fazem alguém dormir tranquilo — o
 * certificado abre com esta senha, o TLS fecha, a SEFAZ do estado está de pé,
 * e a cadeia do certificado é aceita por ela — sem gastar numeração, sem
 * gravar nada no fisco e sem exigir produto classificado.
 *
 * Emitir para testar seria o contrário: precisa de CRT, série, NCM, CFOP e
 * destinatário, e cada pendência de cadastro esconderia a resposta sobre a
 * COMUNICAÇÃO, que é o que se está perguntando.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const { upsertCertificateA1 } = await import(
  '../src/services/fiscal/FiscalCertificateService.js'
);
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');

const app = createApp();
const SENHA_LOGIN = 'Teste@Sefaz2026';
const SENHA_CERT = 'senha-do-certificado-a1';

let precoJusto: string;
let gringa: string;
let gestor: { Authorization: string };
let gestorGringa: { Authorization: string };
let caixa: { Authorization: string };

/** Um .pfx de verdade, gerado na hora. Não há certificado no repositório. */
function fazerPfx(cnpj = '48025052000149'): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 90 * 86400000);
  cert.setSubject([{ name: 'commonName', value: `PRECO JUSTO LTDA:${cnpj}` }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC TESTE GRUPO SAMPAIO' }]);
  cert.sign(keys.privateKey);
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_CERT, {
    algorithm: '3des',
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

async function ator(login: string, profile: string, company: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(id, company, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA_LOGIN });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'PRECO JUSTO COMERCIO DE VARIEDADES LTDA',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  updateFiscalConfig({
    companyId: precoJusto,
    patch: {
      legalName: 'PRECO JUSTO COMERCIO DE VARIEDADES LTDA',
      cnpj: '48.025.052/0001-49',
      ie: '093/0501268',
      crt: '1',
      street: 'Rua Marechal Floriano',
      number: '38',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  // A Gringa ganha UF para o teste de isolamento cobrar o CERTIFICADO dela —
  // sem UF, a rota pararia antes, na configuração, e o caso não provaria nada.
  updateFiscalConfig({ companyId: gringa, patch: { uf: 'RS', cityIbge: '4314407' } });
  gestor = await ator('gestor-pj', 'gerente_loja', precoJusto);
  gestorGringa = await ator('gestor-gringa', 'gerente_loja', gringa);
  caixa = await ator('caixa-pj', 'operador_caixa', precoJusto);
});

/*
  O restore fica AQUI, e não no fim de cada caso: `vi.restoreAllMocks()` na
  última linha do teste não roda quando um `expect` falha antes dele — e o
  mock vazado contamina os casos seguintes, que falham por um motivo que não
  é o deles. Aconteceu nesta própria rodada: dois casos verdes quebraram
  junto quando um mock do cofre ficou de pé.
*/
afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================

describe('quem pode perguntar à SEFAZ', () => {
  it('sem certificado, a rota diz o que falta em vez de tentar', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    // Falar com a SEFAZ exige o certificado: é ele que assina o TLS.
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/certificado/i);
  });

  it('sem a senha, recusa — a senha do A1 nunca fica guardada', async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({});

    /*
      A senha é pedida A CADA conversa com o fisco — é a decisão que impede o
      servidor de assinar sozinho se alguém levar o banco. A rota não pode
      cair no simulador em silêncio quando a senha falta: responder "SEFAZ de
      pé" sem ter falado com ela é exatamente a mentira que este teste existe
      para impedir.
    */
    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/senha/i);
  });

  it('senha errada não vira "SEFAZ fora do ar" — diz que a senha não abriu', async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: 'senha-errada' });

    /*
      A diferença importa para quem está na tela: "a senha não abriu o
      certificado" manda conferir a senha; "a SEFAZ não respondeu" manda
      esperar. Trocar uma pela outra faz o dono esperar por um problema que
      só ele pode resolver.
    */
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/senha|certificado/i);
  });

  it('caixa não pergunta à SEFAZ — é configuração, não operação de balcão', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(caixa)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(403);
  });

  it('o gestor da Gringa não testa o certificado da Preço Justo', async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });

    // A empresa vem do TOKEN. Sem certificado na Gringa, a resposta é a falta
    // dele — nunca o certificado da vizinha.
    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestorGringa)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/certificado/i);
  });
});

// ============================================================================

describe('a resposta da SEFAZ chega inteira à tela', () => {
  beforeEach(async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });
  });

  it('serviço em operação (cStat 107) volta como online, com o motivo do fisco', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockResolvedValue({
      online: true,
      cStat: '107',
      xMotivo: 'Servico em Operacao',
      source: 'sefaz',
      checkedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(200);
    expect(res.body.online).toBe(true);
    expect(res.body.cStat).toBe('107');
    // O motivo é do FISCO, e chega inteiro: é ele que diz o que houve quando
    // não é 107, e resumir apaga o diagnóstico.
    expect(res.body.xMotivo).toBe('Servico em Operacao');
    expect(res.body.uf).toBe('RS');
    expect(res.body.environment).toBe('homologation');
    /*
      Quantos certificados o .pfx trouxe. O certificado deste teste é
      autoassinado, então a cadeia é 1 — e é justamente esse número que
      avisa o dono, na tela, quando o arquivo dele veio sem as autoridades:
      a SEFAZ pode recusar a conexão com o nosso lado inteiramente certo.
    */
    expect(res.body.certificate.chainLength).toBe(1);
    vi.restoreAllMocks();
  });

  it('serviço fora do ar volta como offline — sem virar erro de servidor', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockResolvedValue({
      online: false,
      cStat: '109',
      xMotivo: 'Servico paralisado sem previsao',
      source: 'sefaz',
      checkedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    /*
      200 com online=false, e não 500: a pergunta foi respondida com sucesso —
      a resposta é que o fisco está parado. Devolver erro faria a tela dizer
      "não foi possível perguntar", quando a verdade é "perguntei, e a SEFAZ
      disse que está fora".
    */
    expect(res.status).toBe(200);
    expect(res.body.online).toBe(false);
    expect(res.body.cStat).toBe('109');
  });

  it('a rede caindo NÃO vira "SEFAZ fora do ar"', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'Error' }),
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    /*
      Não alcançar a SEFAZ e a SEFAZ dizer que está parada são coisas
      diferentes: a primeira é problema DAQUI (firewall, DNS, proxy da UF), a
      segunda é do fisco. Quem lê a tela precisa saber para qual lado olhar.
    */
    expect(res.status).toBe(502);
    expect(String(res.body?.error?.message ?? '')).toMatch(/alcançar|conex|rede/i);
  });

  it('a senha não volta na resposta nem sobra na auditoria', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockResolvedValue({
      online: true,
      cStat: '107',
      xMotivo: 'Servico em Operacao',
      source: 'sefaz',
      checkedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SENHA_CERT);

    const { getConnection } = await import('../src/db/sqlite.js');
    const trilha = getConnection()
      .prepare(`SELECT * FROM core_audit_log WHERE action LIKE 'fiscal.sefaz%'`)
      .all() as Record<string, unknown>[];
    // O teste FICA na trilha — é prova de diligência para o contador — mas a
    // senha não pode estar em lugar nenhum dela.
    expect(trilha.length).toBeGreaterThan(0);
    expect(JSON.stringify(trilha)).not.toContain(SENHA_CERT);
    vi.restoreAllMocks();
  });
});

// ============================================================================

describe('"no ar" é uma pergunta com UMA resposta', () => {
  beforeEach(async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });
  });

  it('cStat 108 — serviço paralisado — NÃO é serviço no ar', async () => {
    /*
      A MESMA PERGUNTA RESPONDIDA EM TRÊS LUGARES, e um deles discordava.

        SefazAdapter.CSTAT      SERVICE_UP: ['107'] · SERVICE_DOWN: ['108', …]
        SefazTestAdapter        108 → online: false
        SefazRealAdapter        108 → online: TRUE

      Só o adapter REAL — o que fala com o fisco de verdade — dizia que
      "Serviço Paralisado Momentaneamente" é serviço no ar. A tela pintava a
      caixa de VERDE e escrevia "serviço em operação" enquanto a SEFAZ dizia
      o contrário, e o dono concluía que podia emitir.

      A cicatriz é conhecida nesta base: as três definições de "abaixo do
      mínimo" da rodada 55. Aqui a tabela canônica passa a mandar.
    */
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(
      SefazRealAdapter.prototype as unknown as { enviar: () => Promise<string> },
      'enviar',
    ).mockResolvedValue(
      '<retConsStatServ><cStat>108</cStat>'
      + '<xMotivo>Servico Paralisado Momentaneamente</xMotivo></retConsStatServ>',
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(200);
    expect(res.body.cStat).toBe('108');
    expect(res.body.online).toBe(false);
    // A frase do fisco chega inteira: é ela que separa "momentaneamente" (108)
    // de "sem previsão" (109) para quem decide se espera.
    expect(res.body.xMotivo).toMatch(/Paralisado/);
    vi.restoreAllMocks();
  });

  it('cStat 107 continua sendo o único "no ar"', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    vi.spyOn(
      SefazRealAdapter.prototype as unknown as { enviar: () => Promise<string> },
      'enviar',
    ).mockResolvedValue(
      '<retConsStatServ><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ>',
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.body.online).toBe(true);
    vi.restoreAllMocks();
  });
});

// ============================================================================

describe('o erro diz de quem é o problema', () => {
  beforeEach(async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });
  });

  it('UF sem endereço mapeado NÃO vira "confira sua conexão"', async () => {
    // Hoje só o RS tem endereço no adapter real. Uma operação de outro estado
    // não tem problema de rede: tem endereço que o NOSSO cadastro não conhece,
    // e mandá-la conferir firewall é mandar procurar onde não está.
    updateFiscalConfig({ companyId: precoJusto, patch: { uf: 'SP' } });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(501);
    expect(String(res.body?.error?.message ?? '')).toMatch(/endpoint|endereço/i);
    expect(String(res.body?.error?.message ?? '')).not.toMatch(/conexão|proxy/i);
  });

  it('timeout do fisco manda ESPERAR, não conferir o proxy', async () => {
    /*
      O ramo de timeout era CÓDIGO MORTO. A checagem era por `err.name ===
      'TimeoutError'` — idioma copiado do PaymentService, onde o fetch usa
      AbortSignal.timeout e o runtime realmente produz esse nome. Aqui o
      transporte embrulha tudo em `TransportFailure`, cujo name é
      'TransportFailure', então NENHUM timeout casava: o caso mais comum de
      todos — fisco lento, justamente quando esperar resolve — caía no ramo
      genérico e mandava o dono investigar firewall e proxy.
    */
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const { TransportFailure } = await import('../src/services/core/SefazTestAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockRejectedValue(
      new TransportFailure('TIMEOUT', 'A SEFAZ não respondeu no tempo limite.'),
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(502);
    expect(String(res.body?.error?.message ?? '')).toMatch(/tempo|minutos/i);
    expect(String(res.body?.error?.message ?? '')).not.toMatch(/proxy/i);
    vi.restoreAllMocks();
  });

  it('o motivo técnico do TLS chega à tela — sem ele o dono caça no lugar errado', async () => {
    /*
      A LIÇÃO DE UM ERRO MEU (rodada 59). O dono testou com o A1 real e leu
      "confira a conexão, o proxy e se a UF permite o acesso" — e foi procurar
      firewall. A rede estava limpa: o que a SEFAZ recusou foi o certificado,
      porque mandávamos a folha sem a cadeia. O transporte tinha o motivo
      exato do TLS na mão, e esta rota o descartava para escrever uma frase
      genérica que apontava para o lado errado.

      Motivo técnico não é ruído: é a diferença entre consertar em um minuto e
      procurar por uma tarde.
    */
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const { TransportFailure } = await import('../src/services/core/SefazTestAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockRejectedValue(
      new TransportFailure('NETWORK_ERROR', 'unable to verify the first certificate'),
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(502);
    expect(String(res.body?.error?.message ?? '')).toContain(
      'unable to verify the first certificate',
    );
  });

  it('falha de rede continua mandando conferir a conexão', async () => {
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const { TransportFailure } = await import('../src/services/core/SefazTestAdapter.js');
    vi.spyOn(SefazRealAdapter.prototype, 'statusServico').mockRejectedValue(
      new TransportFailure('NETWORK_ERROR', 'getaddrinfo ENOTFOUND'),
    );

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(502);
    expect(String(res.body?.error?.message ?? '')).toMatch(/conexão|proxy/i);
    vi.restoreAllMocks();
  });

  it('cofre que não abre NÃO é acusado de senha errada', async () => {
    /*
      `decryptFiscalSecret` estoura sem `.code` quando a chave do cofre muda —
      e ela MUDA: o servidor recusa subir em produção com a chave padrão de
      desenvolvimento, que é a que cifrou o certificado de hoje. No dia da
      virada, o dono leria "a senha não abriu o certificado" com a senha
      certa, e nenhuma senha resolveria: o conserto é subir o .pfx de novo.
    */
    const { getCertificateA1 } = await import(
      '../src/services/fiscal/FiscalCertificateService.js'
    );
    void getCertificateA1;
    const cofre = await import('../src/services/fiscal/FiscalSecretVault.js');
    vi.spyOn(cofre, 'decryptFiscalSecret').mockImplementation(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(400);
    const msg = String(res.body?.error?.message ?? '');
    expect(msg).toMatch(/envie o arquivo de novo|não pode ser aberto/i);
    // A acusação errada some: quem digitou a senha certa não é mandado
    // conferir a senha.
    expect(msg).not.toMatch(/Confira se é a senha/i);
    vi.restoreAllMocks();
  });

  it('senha realmente errada continua dizendo que é a senha', async () => {
    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: 'senha-que-nao-e' });

    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/senha/i);
  });

  it('sem UF na configuração, pede a UF em vez de tentar', async () => {
    updateFiscalConfig({ companyId: precoJusto, patch: { uf: '' } });

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    expect(res.status).toBe(400);
    expect(String(res.body?.error?.message ?? '')).toMatch(/UF/);
  });

  it('outra unidade é recusada pelo nome — o teste só fala do certificado que a emissão usa', async () => {
    /*
      O CONTRATO MUDOU COM O GAP-PRD-180, e este caso muda junto.

      Ele cobrava que o teste achasse um certificado guardado sob "filial-2".
      Só que nada que EMITE lê outra unidade — prontidão, PDV, pipeline e cofre
      dos atos leem a da operação. Um "SEFAZ respondeu" sobre o arquivo da
      filial seria verdade sobre um certificado que nunca assina nota. Não
      existe cadastro de unidades: pedir outra é recusado, com o motivo, antes
      de abrir cofre ou chamar a SEFAZ.
    */
    await upsertCertificateA1({
      companyId: gringa,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const espiao = vi.spyOn(SefazRealAdapter.prototype, 'statusServico');

    const res = await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestorGringa)
      .send({ certificatePassword: SENHA_CERT, operationalUnitId: 'filial-2' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_UNIT_NOT_SUPPORTED');
    expect(espiao).not.toHaveBeenCalled();
  });
});

// ============================================================================

describe('o ambiente perguntado é o que a operação está usando', () => {
  it('operação em homologação pergunta à SEFAZ de homologação', async () => {
    await upsertCertificateA1({
      companyId: precoJusto,
      operationalUnitId: 'unit-default',
      pfxBase64: fazerPfx(),
      password: SENHA_CERT,
    });
    const { SefazRealAdapter } = await import('../src/services/core/SefazRealAdapter.js');
    const espiao = vi
      .spyOn(SefazRealAdapter.prototype, 'statusServico')
      .mockResolvedValue({
        online: true,
        cStat: '107',
        xMotivo: 'Servico em Operacao',
        source: 'sefaz',
        checkedAt: new Date().toISOString(),
      });

    await request(app)
      .post('/api/v1/core/fiscal/sefaz/status')
      .set(gestor)
      .send({ certificatePassword: SENHA_CERT });

    /*
      Perguntar ao ambiente errado responde sobre um servidor que a operação
      não usa: "de pé" em produção não diz nada a quem emite em homologação —
      e o inverso daria a alguém a impressão de estar liberado.
    */
    expect(espiao).toHaveBeenCalledWith(
      expect.objectContaining({ uf: 'RS', environment: 'homologation' }),
    );
    vi.restoreAllMocks();
  });
});
