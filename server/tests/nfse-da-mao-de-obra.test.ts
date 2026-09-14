/**
 * A NFS-e DA MÃO DE OBRA DA OS — GAP-PRD-024 (metade do serviço).
 *
 * Não existia modelo NFS-e nenhum no servidor: a mão de obra da oficina não
 * tinha documento pelo sistema, e o contador não recebia nota da oficina.
 *
 * O que cada teste derruba:
 *   - ligue a NFS-e por padrão e a oficina emite sem ninguém ter decidido;
 *   - abra a configuração ao caixa e quem cobra muda o código do serviço;
 *   - esqueça o dono da pendência e o contador não sabe o que é dele;
 *   - mande a peça na DPS e a NFS-e declara ISS sobre mercadoria;
 *   - troque o A1 do cofre e a assinatura deixa de verificar;
 *   - reserve um número novo a cada tentativa e a numeração da DPS ganha
 *     buracos (e a queda de rede vira duas NFS-e);
 *   - deixe o simulador em produção e sai nota que não existe para ninguém;
 *   - destrave a produção sem autorização real e a primeira nota de verdade
 *     vira o teste do leiaute.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import {
  linkUserToCompany,
  linkUserToWorkshop,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { certificadoDoCofre } from '../src/services/core/FiscalPipelineService.js';
import { verifyXmlElementSignature } from '../src/services/core/FiscalSigner.js';
import { TransportFailure } from '../src/services/core/SefazTestAdapter.js';
import {
  NfseNacionalAdapter,
  NfseTesteAdapter,
  assertAdapterDaNfsePodeTransmitir,
  compactarParaSefin,
  descompactarDaSefin,
  type PostJson,
} from '../src/services/core/NfseAdapter.js';
import { emitirNfseDaVenda, getNfseConfig, updateNfseConfig } from '../src/services/core/NfseService.js';
import { gerarCertificado } from './helpers/certificado.js';

const app = createApp();
const SENHA = 'Teste@Nfse2026';
const SENHA_A1 = 'senha-do-a1-de-teste';
const CNPJ = '11222333000181';
const CHAVE_REAL = '43144072112223330001810000000000000126090000012345';

let pfx: string;
let oficina: string;
let outra: string;
let mobilidade: string;
let gerente: { Authorization: string };
let gerenteId: string;
let caixa: { Authorization: string };
let peca: string;

async function entrar(login: string, empresa: string, perfil: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, perfil, true);
  if (empresa === oficina) linkUserToWorkshop(userId, mobilidade, 'mecanico');
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** OS com mão de obra (e peça, se pedida), concluída e cobrada. */
async function vendaDaOs(opcoes: { maoDeObraCents?: number; pecas?: number } = {}): Promise<string> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente)
    .send({ customerName: 'Maria', complaint: 'Revisão' });
  const id = os.body.id as string;
  await request(app).post(`/api/v1/core/workshop/orders/${id}/assume`).set(gerente)
    .send({ status: 'em_andamento', comment: 'ok' });
  if (opcoes.pecas) {
    await request(app).post(`/api/v1/core/workshop/orders/${id}/parts`).set(gerente)
      .send({ productId: peca, quantity: opcoes.pecas });
  }
  await request(app).post(`/api/v1/core/workshop/orders/${id}/labor`).set(gerente)
    .send({ laborCents: opcoes.maoDeObraCents ?? 5000 });
  const fim = await request(app).post(`/api/v1/core/workshop/orders/${id}/complete`).set(gerente)
    .send({ diagnosis: 'Revisão feita', hasCost: true, forcarChecklist: true });
  const pago = await request(app).post(`/api/v1/core/workshop/orders/${id}/checkout`).set(gerente)
    .send({ payments: [{ method: 'pix', amountCents: fim.body.total_cents }] });
  expect(pago.status, JSON.stringify(pago.body)).toBe(201);
  return pago.body.sale.id as string;
}

/** A NFS-e pronta para o Emissor Nacional, como o contador e o dono deixariam. */
function configurarEmissorNacional(): void {
  updateNfseConfig({
    companyId: oficina,
    userId: gerenteId,
    patch: {
      mode: 'EMISSOR_NACIONAL',
      serviceCode: '140101',
      simplesOption: '3',
      simplesRegime: '1',
      issRate: '2.00',
      municipalityConfirmed: true,
    },
  });
  upsertCertificateA1({ companyId: oficina, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
}

/** O transporte dublado: guarda o que foi enviado e responde o que o teste manda. */
function dubleDaSefin(respostas: (() => { status: number; body: string })[]) {
  const enviados: { url: string; dps: string }[] = [];
  const postJson: PostJson = async (input) => {
    const corpo = JSON.parse(input.body) as { dpsXmlGZipB64: string };
    enviados.push({ url: input.url, dps: descompactarDaSefin(corpo.dpsXmlGZipB64) });
    const proxima = respostas.shift();
    if (!proxima) throw new Error('resposta não prevista');
    return proxima();
  };
  return { enviados, postJson };
}

const autorizada = (chave = CHAVE_REAL, numero = '123') => () => ({
  status: 201,
  body: JSON.stringify({
    tipoAmbiente: 2,
    chaveAcesso: chave,
    nfseXmlGZipB64: compactarParaSefin(`<NFSe><infNFSe><nNFSe>${numero}</nNFSe></infNFSe></NFSe>`),
  }),
});

function adapterReal(postJson: PostJson) {
  return new NfseNacionalAdapter({ cert: certificadoDoCofre(oficina)!, postJson });
}

beforeAll(() => {
  // RSA 2048 é caro: um certificado para o arquivo inteiro.
  pfx = gerarCertificado(`OFICINA SAMPAIO LTDA:${CNPJ}`, SENHA_A1);
});

const nodeEnvOriginal = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = nodeEnvOriginal;
});

beforeEach(async () => {
  resetDbForTests();
  oficina = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina', kind: 'workshop' });
  outra = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  ensureOfficialWorkshops();
  mobilidade = (
    getConnection().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }
  ).id;
  const g = await entrar('GER_NFSE', oficina, 'gerente_oficina');
  gerente = g.auth;
  gerenteId = g.userId;
  caixa = (await entrar('CX_NFSE', oficina, 'operador_caixa_oficina')).auth;
  updateFiscalConfig({
    companyId: oficina,
    patch: {
      legalName: 'Oficina Sampaio Ltda',
      cnpj: CNPJ,
      ie: '123456789',
      im: '98765',
      crt: '1',
      street: 'Rua da Oficina',
      number: '50',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010-000',
      uf: 'RS',
    },
  });
  const p = await request(app).post('/api/v1/core/products').set(gerente)
    .send({ name: 'Pastilha de freio', priceCents: 9000, kind: 'part', workshopId: mobilidade });
  peca = p.body.id as string;
  await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: peca, movementType: 'in', quantity: 5, referenceType: 'entrada', referenceId: 'nf-pecas',
  });
});

describe('padrão seguro e quem decide', () => {
  it('sem decisão do dono a NFS-e está desligada: a OS diz o que falta e nada sai', async () => {
    const venda = await vendaDaOs();
    const r = await request(app).get(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('DESLIGADA');
    expect(r.body.action).toBe('NENHUMA');
    expect(r.body.serviceCents).toBe(5000);
    expect(r.body.reasons.join(' ')).toMatch(/desligada/);

    const emitir = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa).send({});
    expect(emitir.status).toBe(409);
    expect(emitir.body.error.code).toBe('CORE_NFSE_MODE_NOT_API');
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_nfse_documents').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('a configuração é da gerência: o caixa leva 403, formato errado leva 400, e fica auditada', async () => {
    expect((await request(app).patch('/api/v1/core/fiscal/nfse/config').set(caixa).send({ mode: 'EMISSOR_NACIONAL' })).status).toBe(403);
    const errado = await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ serviceCode: '14.01' });
    expect(errado.status).toBe(400);
    const certo = await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente)
      .send({ mode: 'EMISSOR_NACIONAL', serviceCode: '140101' });
    expect(certo.status).toBe(200);
    expect(certo.body).toMatchObject({ mode: 'EMISSOR_NACIONAL', serviceCode: '140101', environment: 'homologation' });
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'fiscal.nfse.config_updated'")
      .get() as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('a prontidão nomeia o dono de cada pendência', async () => {
    await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ mode: 'EMISSOR_NACIONAL' });
    const r = await request(app).get('/api/v1/core/fiscal/nfse/readiness').set(gerente);
    expect(r.status).toBe(200);
    const falhas = Object.fromEntries(
      (r.body.items as { key: string; status: string; owner: string }[])
        .filter((i) => i.status === 'FAIL')
        .map((i) => [i.key, i.owner]),
    );
    expect(falhas).toEqual({
      nfse_municipio: 'prefeitura',
      nfse_codigo: 'contador',
      nfse_regime: 'contador',
      nfse_certificado: 'dono',
    });
    expect(r.body.canEmit).toBe(false);
  });
});

describe('a emissão pelo Emissor Nacional', () => {
  it('DPS só com a mão de obra, assinada com o A1 do cofre, em GZip+Base64 na produção restrita', async () => {
    configurarEmissorNacional();
    const venda = await vendaDaOs({ maoDeObraCents: 5000, pecas: 1 });
    const { enviados, postJson } = dubleDaSefin([autorizada()]);

    const doc = await emitirNfseDaVenda({ companyId: oficina, saleId: venda, userId: gerenteId, adapter: adapterReal(postJson) });

    expect(enviados).toHaveLength(1);
    expect(enviados[0].url).toBe('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse');
    const dps = enviados[0].dps;
    expect(dps).toContain('<infDPS Id="DPS431440721122233300018100001000000000000001">');
    expect(dps).toContain('<tpAmb>2</tpAmb>');
    expect(dps).toContain('<vServ>50.00</vServ>');
    expect(dps).toContain('<cTribNac>140101</cTribNac>');
    expect(dps).toContain('<IM>98765</IM>');
    expect(dps).toContain('<pAliq>2.00</pAliq>');
    expect(dps).toContain('Mão de obra — OS #1');
    expect(dps).not.toContain('Pastilha');
    const assinatura = verifyXmlElementSignature(dps, 'infDPS');
    expect(assinatura.valid, assinatura.reason ?? '').toBe(true);

    expect(doc).toMatchObject({
      status: 'AUTORIZADA',
      accessKey: CHAVE_REAL,
      nfseNumber: '123',
      serviceCents: 5000,
      dpsNumber: 1,
      environment: 'homologation',
      simulated: false,
    });
    expect(getNfseConfig(oficina).nextDpsNumber).toBe(2);

    // Idempotente: a segunda chamada devolve a mesma, sem falar com a Sefin.
    const outraVez = await emitirNfseDaVenda({ companyId: oficina, saleId: venda, userId: gerenteId, adapter: adapterReal(postJson) });
    expect(outraVez.id).toBe(doc.id);
    expect(enviados).toHaveLength(1);
  });

  it('a recusa guarda os motivos, e o reenvio usa o MESMO número de DPS', async () => {
    configurarEmissorNacional();
    const venda = await vendaDaOs();
    const { enviados, postJson } = dubleDaSefin([
      () => ({ status: 400, body: JSON.stringify({ erros: [{ Codigo: 'E0310', Descricao: 'Código de serviço não permitido' }] }) }),
      autorizada(),
    ]);

    const recusada = await emitirNfseDaVenda({ companyId: oficina, saleId: venda, userId: gerenteId, adapter: adapterReal(postJson) });
    expect(recusada.status).toBe('REJEITADA');
    expect(recusada.reason).toContain('E0310 Código de serviço não permitido');

    const aceita = await emitirNfseDaVenda({ companyId: oficina, saleId: venda, userId: gerenteId, adapter: adapterReal(postJson) });
    expect(aceita.status).toBe('AUTORIZADA');
    expect(enviados.map((e) => /<nDPS>(\d+)<\/nDPS>/.exec(e.dps)?.[1])).toEqual(['1', '1']);
    expect(getNfseConfig(oficina).nextDpsNumber).toBe(2);
  });

  it('sem resposta da Sefin: SEM_RESPOSTA, e o reenvio é com o mesmo número', async () => {
    configurarEmissorNacional();
    const venda = await vendaDaOs();
    const { postJson } = dubleDaSefin([
      () => {
        throw new TransportFailure('TIMEOUT', 'sem resposta');
      },
    ]);
    const doc = await emitirNfseDaVenda({ companyId: oficina, saleId: venda, userId: gerenteId, adapter: adapterReal(postJson) });
    expect(doc.status).toBe('SEM_RESPOSTA');
    expect(doc.reason).toMatch(/mesmo número \(1\/1\)/);
    expect(doc.dpsNumber).toBe(1);
  });

  it('venda só de peças não tem NFS-e', async () => {
    configurarEmissorNacional();
    const venda = await vendaDaOs({ maoDeObraCents: 0, pecas: 1 });
    const r = await request(app).get(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa);
    expect(r.body.serviceCents).toBe(0);
    expect(r.body.reasons.join(' ')).toMatch(/não tem serviço/);
  });
});

describe('o simulador e a produção', () => {
  it('o simulador emite pela rota fora de produção, com chave que se declara de teste', async () => {
    updateNfseConfig({
      companyId: oficina,
      userId: gerenteId,
      patch: { mode: 'EMISSOR_NACIONAL', serviceCode: '140101', simplesOption: '3', simplesRegime: '1', municipalityConfirmed: true },
    });
    const venda = await vendaDaOs();
    const r = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa).send({ developmentMode: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('AUTORIZADA');
    expect(r.body.simulated).toBe(true);
    expect(String(r.body.accessKey)).toMatch(/^TESTE/);
  });

  it('com NODE_ENV=production o simulador é recusado — pela rota e no adapter', async () => {
    updateNfseConfig({
      companyId: oficina,
      userId: gerenteId,
      patch: { mode: 'EMISSOR_NACIONAL', serviceCode: '140101', simplesOption: '3', simplesRegime: '1', municipalityConfirmed: true },
    });
    const venda = await vendaDaOs();
    process.env.NODE_ENV = 'production';
    const r = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa).send({ developmentMode: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_NFSE_TEST_PROVIDER_IN_PRODUCTION');
    process.env.NODE_ENV = nodeEnvOriginal;
    expect(() => assertAdapterDaNfsePodeTransmitir({ adapter: new NfseTesteAdapter(), ambiente: 'production' })).toThrow(
      /simulador/,
    );
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_nfse_documents').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('produção só depois de uma autorização REAL na homologação', async () => {
    configurarEmissorNacional();
    const travada = await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ environment: 'production' });
    expect(travada.status).toBe(409);
    expect(travada.body.error.code).toBe('CORE_NFSE_PRODUCTION_LOCKED');

    // A do simulador não conta.
    const v1 = await vendaDaOs();
    await request(app).post(`/api/v1/core/fiscal/sales/${v1}/nfse`).set(caixa).send({ developmentMode: true });
    expect((await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ environment: 'production' })).status).toBe(409);

    const v2 = await vendaDaOs();
    const { postJson } = dubleDaSefin([autorizada()]);
    await emitirNfseDaVenda({ companyId: oficina, saleId: v2, userId: gerenteId, adapter: adapterReal(postJson) });
    const liberada = await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ environment: 'production' });
    expect(liberada.status).toBe(200);
    expect(liberada.body.environment).toBe('production');
  });
});

describe('o registro da NFS-e emitida no portal', () => {
  it('número e código ligados à venda e à OS; depois o cancelamento registrado com motivo', async () => {
    await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ mode: 'REGISTRO_MANUAL' });
    const venda = await vendaDaOs();
    const r = await request(app).get(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa);
    expect(r.body.action).toBe('REGISTRAR');

    const semCodigo = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse/manual`).set(caixa)
      .send({ numero: '77', emitidaEm: new Date().toISOString() });
    expect(semCodigo.status).toBe(400);

    const ok = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse/manual`).set(caixa)
      .send({ numero: '77', codigoVerificacao: 'AB12CD', emitidaEm: new Date().toISOString() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ status: 'REGISTRADA', nfseNumber: '77', verificationCode: 'AB12CD', serviceCents: 5000 });
    expect(ok.body.serviceOrderId).toBeTruthy();

    const depois = await request(app).get(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(caixa);
    expect(depois.body.action).toBe('NENHUMA');
    expect(depois.body.reasons).toEqual(['Esta venda já tem NFS-e.']);

    const curto = await request(app).post(`/api/v1/core/fiscal/nfse/${ok.body.id}/cancel-record`).set(gerente).send({ motivo: 'erro' });
    expect(curto.status).toBe(400);
    expect((await request(app).post(`/api/v1/core/fiscal/nfse/${ok.body.id}/cancel-record`).set(caixa)
      .send({ motivo: 'Serviço cobrado em duplicidade, cancelado no portal.' })).status).toBe(403);
    const cancelada = await request(app).post(`/api/v1/core/fiscal/nfse/${ok.body.id}/cancel-record`).set(gerente)
      .send({ motivo: 'Serviço cobrado em duplicidade, cancelado no portal.' });
    expect(cancelada.status).toBe(200);
    expect(cancelada.body.status).toBe('CANCELADA');
  });

  it('outra empresa não enxerga nem registra a NFS-e desta venda', async () => {
    await request(app).patch('/api/v1/core/fiscal/nfse/config').set(gerente).send({ mode: 'REGISTRO_MANUAL' });
    const venda = await vendaDaOs();
    const alheio = (await entrar('GER_PJ', outra, 'gerente_loja')).auth;
    const r = await request(app).get(`/api/v1/core/fiscal/sales/${venda}/nfse`).set(alheio);
    expect(r.body.document).toBeNull();
    expect(r.body.action).toBe('NENHUMA');
    const tenta = await request(app).post(`/api/v1/core/fiscal/sales/${venda}/nfse/manual`).set(alheio)
      .send({ numero: '1', codigoVerificacao: 'X', emitidaEm: new Date().toISOString() });
    expect(tenta.status).toBeGreaterThanOrEqual(400);
    const n = getConnection().prepare('SELECT COUNT(*) AS n FROM core_nfse_documents').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
