/**
 * ============================================================================
 * O A1 AVISA ANTES DE VENCER — e o grupo se enxerga inteiro
 * ============================================================================
 *
 * ## GAP-V40 — o aviso existia e não alcançava ninguém
 *
 * O cálculo dos dias e a frase de renovação estavam prontos desde sempre em
 * `CertificateStatusService`. O problema era o ALCANCE: a frase só aparecia
 * para quem abrisse Configurações › Fiscal › Certificado da operação certa. O
 * checklist fiscal marcava `certificate_validity` como PASS com `detail: null`
 * enquanto o certificado agonizava, e o painel do gestor não dizia nada. Com
 * seis empresas, ninguém é avisado se ninguém visitar seis telas — e a própria
 * mensagem do sistema promete que "a emissão para no dia do vencimento".
 *
 * ## Estado DERIVADO, não fila de e-mails
 *
 * Não há worker, não há tabela de avisos enviados e não há dedupe para
 * escrever: a faixa é uma função de `validTo` e do relógio. Fila de avisos
 * exigiria um agendador que este servidor não tem (ele desliga à noite), e
 * criaria a pergunta "por que o aviso de 30 dias não saiu?" — que estado
 * derivado não sabe responder porque não pode falhar.
 *
 * As faixas são 90, 60, 30, 15 e 7 dias, mais a de vencido. A faixa é a MENOR
 * que ainda cabe: faltando 23 dias, a faixa é a de 30 — e a frase é "A1 vence
 * em 23 dia(s)", com o número real, nunca o da faixa.
 *
 * A SITUAÇÃO NÃO MUDOU. `valido`/`proximo_do_vencimento`/`vencido` continuam
 * com a mesma régua de 30 dias que o resto do sistema já lê. A faixa é campo
 * NOVO ao lado, e não um estado a mais na lista antiga — acrescentar valor a
 * um enum antigo quebra em silêncio quem faz `switch` sobre ele.
 *
 * ## GAP-V41 — os seis lado a lado, e a régua de atravessar é o VÍNCULO
 *
 * `GET /core/fiscal/certificate` responde pela empresa do token, e só. Conferir
 * os A1 do grupo exigia trocar de operação seis vezes. A rota nova lista todas
 * — e "todas" é `core_user_companies`, o mesmo critério de `GET /core/companies`:
 * perfil não atravessa empresa, vínculo atravessa.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import forge from 'node-forge';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import {
  FAIXAS_DE_AVISO,
  getCertificateView,
} from '../src/services/core/CertificateStatusService.js';
import { assertCanEmit, buildReadiness, updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';

const app = createApp();
const SENHA = 'Vencimento@2026';
const CNPJ = '11222333000181';

function pfx(validoAte: Date, cn = `PRECO JUSTO LTDA:${CNPJ}`): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000 * 30);
  cert.validity.notAfter = validoAte;
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC SOLUTI Multipla v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

function daqui(dias: number): Date {
  return new Date(Date.now() + dias * 86_400_000);
}

let longo: string;
let empresa: string;

beforeAll(() => {
  // Um arquivo só, com folga larga. As faixas se exercitam movendo o RELÓGIO
  // DA CONSULTA — o upload recusa certificado já vencido, então simular o
  // vencimento pelo arquivo seria impossível.
  longo = pfx(daqui(400));
}, 120_000);

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  updateFiscalConfig({ companyId: empresa, patch: { cnpj: CNPJ } });
  upsertCertificateA1({
    companyId: empresa,
    operationalUnitId: 'unit-default',
    pfxBase64: longo,
    password: SENHA,
  });
});

/**
 * O relógio que faz o certificado carregado estar a N dias do fim.
 *
 * A conta parte do `validTo` GRAVADO, não de `Date.now()`. Partir de agora
 * daria um dia a menos por causa dos milissegundos gastos entre gerar o
 * arquivo e consultar — `daysBetween` arredonda para baixo, e a suíte
 * flakearia sem que ninguém entendesse o motivo.
 */
function relogioFaltando(dias: number): Date {
  const validTo = new Date(String(getCertificateView(empresa).certificate?.validTo));
  return new Date(validTo.getTime() - dias * 86_400_000);
}

/**
 * Uma validade a N dias daqui, com meio dia de folga.
 *
 * A folga existe pelo mesmo motivo acima: quem lê é o relógio REAL do
 * servidor, sempre alguns milissegundos à frente de quando este valor foi
 * calculado, e sem ela `Math.floor` devolveria N-1.
 */
function validadeEm(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000 + 43_200_000).toISOString();
}

// ===========================================================================
// GAP-V40 — as faixas
// ===========================================================================

describe('GAP-V40 — a faixa de aviso é derivada do arquivo e do relógio', () => {
  it('as faixas são 90, 60, 30, 15 e 7 — declaradas, não espalhadas pelo código', () => {
    expect([...FAIXAS_DE_AVISO]).toEqual([90, 60, 30, 15, 7]);
  });

  it('com folga larga não há alerta nenhum — aviso que aparece sempre não é aviso', () => {
    const view = getCertificateView(empresa, 'unit-default', relogioFaltando(120));
    expect(view.alerta).toBeNull();
    expect(view.situation).toBe('valido');
  });

  it.each([
    [85, 90, 'info'],
    [90, 90, 'info'],
    [45, 60, 'info'],
    [23, 30, 'warning'],
    [12, 15, 'warning'],
    [5, 7, 'danger'],
  ])('faltando %i dia(s), a faixa é a de %i e a severidade é %s', (dias, faixa, severidade) => {
    const view = getCertificateView(empresa, 'unit-default', relogioFaltando(dias));
    expect(view.alerta?.band).toBe(faixa);
    expect(view.alerta?.days).toBe(dias);
    expect(view.alerta?.severity).toBe(severidade);
    // A frase carrega o número REAL, não o da faixa.
    expect(view.alerta?.message).toContain(`${dias} dia`);
    expect(view.alerta?.message).toMatch(/A1 vence em/i);
  });

  it('vencido é a faixa zero, em vermelho, e diz que a emissão está bloqueada', () => {
    const view = getCertificateView(empresa, 'unit-default', relogioFaltando(-3));
    expect(view.alerta?.band).toBe(0);
    expect(view.alerta?.severity).toBe('danger');
    expect(view.alerta?.message).toMatch(/VENCIDO/);
    expect(view.alerta?.message).toMatch(/bloquead/i);
    expect(view.situation).toBe('vencido');
  });

  it('sem certificado não há alerta — a pendência é outra e tem mensagem própria', () => {
    const vazia = upsertCompany({ slug: 'vazia', legalName: 'Vazia', tradeName: 'Vazia' });
    const view = getCertificateView(vazia);
    expect(view.alerta).toBeNull();
    expect(view.situation).toBe('nao_configurado');
  });

  it('a situação antiga NÃO ganhou valor novo — quem faz switch sobre ela continua certo', () => {
    // 85 dias entra na faixa de 90 e continua sendo `valido`: a faixa avisa
    // com antecedência, ela não antecipa o estado.
    const view = getCertificateView(empresa, 'unit-default', relogioFaltando(85));
    expect(view.situation).toBe('valido');
    expect(view.alerta?.band).toBe(90);
  });
});

describe('GAP-V40 — o checklist fiscal deixa de calar', () => {
  it('o item da validade passa a CARREGAR o aviso em vez de PASS com detalhe vazio', () => {
    const relatorio = buildReadiness(empresa, '65', relogioFaltando(23));
    const item = relatorio.items.find((i) => i.key === 'certificate_validity');

    // Continua PASS: o certificado É válido, e transformar aviso em falha
    // travaria a emissão 30 dias antes da hora.
    expect(item?.status).toBe('PASS');
    // Este era o defeito: `detail` vinha null justamente quando havia o que dizer.
    expect(item?.detail).toContain('23 dia');

    // E o relatório carrega o alerta inteiro, para a tela pintar o banner.
    expect(relatorio.certificateAlert?.band).toBe(30);
  });

  it('sem faixa, o item volta a ser um PASS silencioso', () => {
    const relatorio = buildReadiness(empresa, '65', relogioFaltando(200));
    expect(relatorio.items.find((i) => i.key === 'certificate_validity')?.detail).toBeNull();
    expect(relatorio.certificateAlert).toBeNull();
  });

  it('VENCIDO bloqueia a emissão, com a mensagem do vencimento e não uma genérica', () => {
    let erro: unknown;
    try {
      assertCanEmit(empresa, '65', 'transmission', relogioFaltando(-1));
    } catch (e) {
      erro = e;
    }
    expect((erro as { code?: string })?.code).toBe('CORE_FISCAL_NOT_READY');
    expect(String((erro as Error)?.message)).toMatch(/VENCIDO/);
  });
});

describe('GAP-V40 — o painel do gestor avisa sem que ninguém procure', () => {
  it('o dashboard carrega a faixa do certificado da operação', async () => {
    const userId = await upsertUser({
      login: 'GERENTEPAINEL',
      displayName: 'Gerente',
      password: SENHA,
    });
    linkUserToCompany(userId, empresa, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTEPAINEL', password: SENHA, companyId: empresa });
    expect(login.status).toBe(200);

    /*
      O relógio do servidor não se move num teste HTTP. Para pôr o certificado
      dentro da faixa, o que muda é a VALIDADE gravada — o mesmo campo que o
      relógio moveria, visto do outro lado.
    */
    getConnection()
      .prepare(
        `UPDATE fiscal_certificate_references
            SET data = json_set(data, '$.validTo', ?)`,
      )
      .run(validadeEm(23));

    const res = await request(app)
      .get('/api/v1/core/dashboard')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.certificateAlert?.band).toBe(30);
    expect(String(res.body.certificateAlert?.message)).toMatch(/A1 vence em 23 dia/i);
    // O painel não é lugar de dado do titular: só o aviso.
    expect(JSON.stringify(res.body.certificateAlert)).not.toContain(CNPJ);
  });

  it('com folga, o painel não carrega alerta nenhum', async () => {
    const userId = await upsertUser({
      login: 'GERENTECALMO',
      displayName: 'Gerente',
      password: SENHA,
    });
    linkUserToCompany(userId, empresa, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTECALMO', password: SENHA, companyId: empresa });

    const res = await request(app)
      .get('/api/v1/core/dashboard')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });

    expect(res.status).toBe(200);
    expect(res.body.certificateAlert).toBeNull();
  });
});

// ===========================================================================
// GAP-V41 — a visão consolidada
// ===========================================================================

describe('GAP-V41 — os certificados do grupo lado a lado', () => {
  let gringa: string;
  let oficina: string;

  async function ator(login: string, empresas: { id: string; perfil: string }[]) {
    const userId = await upsertUser({ login, displayName: login, password: SENHA });
    for (const e of empresas) linkUserToCompany(userId, e.id, e.perfil, true);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login, password: SENHA, companyId: empresas[0].id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  beforeEach(() => {
    gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    oficina = upsertCompany({ slug: 'oficina', legalName: 'Oficina Ltda', tradeName: 'Oficina' });
    // A Gringa também tem A1; a Oficina não tem nenhum — e é isso que o dono
    // precisa ver de uma vez.
    upsertCertificateA1({
      companyId: gringa,
      operationalUnitId: 'unit-default',
      pfxBase64: longo,
      password: SENHA,
    });
  });

  it('quem tem vínculo nas três vê as três, com situação e validade de cada uma', async () => {
    const dono = await ator('DONOGRUPO', [
      { id: empresa, perfil: 'admin_geral' },
      { id: gringa, perfil: 'admin_geral' },
      { id: oficina, perfil: 'admin_geral' },
    ]);

    const res = await request(app).get('/api/v1/core/fiscal/certificates/group').set(dono);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const itens = res.body.items as Record<string, unknown>[];
    expect(itens).toHaveLength(3);

    const semA1 = itens.find((i) => i.companyId === oficina)!;
    expect(semA1.configured).toBe(false);
    expect(semA1.situation).toBe('nao_configurado');
    expect(semA1.tradeName).toBe('Oficina');

    const comA1 = itens.find((i) => i.companyId === empresa)!;
    expect(comA1.configured).toBe(true);
    expect(comA1.situation).toBe('valido');
    expect(comA1.holderName).toBe('PRECO JUSTO LTDA');
    expect(comA1.documentNumber).toBe(CNPJ);
    expect(comA1.validTo).toBeTruthy();
    expect(comA1.daysRemaining).toBeGreaterThan(0);
    // O booleano já sanitizado da rodada do cofre: a tela sabe que a senha
    // está selada sem que a senha exista do lado de cá.
    expect(comA1.senhaGuardada).toBe(true);
  });

  it('quem só tem vínculo numa vê UMA — perfil não atravessa empresa, vínculo atravessa', async () => {
    const donoDeUmaLoja = await ator('DONODEUMA', [{ id: empresa, perfil: 'admin_geral' }]);

    const res = await request(app)
      .get('/api/v1/core/fiscal/certificates/group')
      .set(donoDeUmaLoja);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect((res.body.items as { companyId: string }[])[0].companyId).toBe(empresa);
  });

  it('gerente de loja é recusado — o A1 assina nota em nome da empresa', async () => {
    const gerente = await ator('GERENTEGRUPO', [{ id: empresa, perfil: 'gerente_loja' }]);
    const res = await request(app).get('/api/v1/core/fiscal/certificates/group').set(gerente);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
  });

  it('a lista NÃO carrega segredo — nem arquivo, nem chave, nem senha', async () => {
    const dono = await ator('DONOSIGILO', [
      { id: empresa, perfil: 'admin_geral' },
      { id: gringa, perfil: 'gestor' },
    ]);
    const res = await request(app).get('/api/v1/core/fiscal/certificates/group').set(dono);
    const texto = JSON.stringify(res.body);

    expect(texto).not.toContain(SENHA);
    expect(texto).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(texto).not.toMatch(/encryptedPfx|encryptedPassword|keyPem|certPem/);
  });

  it('a faixa de aviso vem junto — é a lista que responde "qual das seis está para vencer"', async () => {
    getConnection()
      .prepare(
        `UPDATE fiscal_certificate_references
            SET data = json_set(data, '$.validTo', ?)
          WHERE json_extract(data, '$.companyId') = ?`,
      )
      .run(validadeEm(11), gringa);

    const dono = await ator('DONOFAIXA', [
      { id: empresa, perfil: 'admin_geral' },
      { id: gringa, perfil: 'admin_geral' },
    ]);
    const res = await request(app).get('/api/v1/core/fiscal/certificates/group').set(dono);

    const daGringa = (res.body.items as Record<string, unknown>[]).find(
      (i) => i.companyId === gringa,
    )!;
    expect((daGringa.alerta as { band: number }).band).toBe(15);
    const doPreco = (res.body.items as Record<string, unknown>[]).find(
      (i) => i.companyId === empresa,
    )!;
    expect(doPreco.alerta).toBeNull();
  });
});
