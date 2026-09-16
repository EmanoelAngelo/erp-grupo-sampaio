/**
 * ============================================================================
 * A PLAQUINHA NA FILA DE IMPRESSÃO — só a gestão da PJ Motors a reimprime, lê
 * ou vê (resíduo do P0 das plaquinhas)
 * ============================================================================
 *
 * ## O buraco que isto fecha
 *
 * O P0 fechou o POST /print/jobs com EQUIPMENT_QR_TAG (labels.equipment.print),
 * e as outras portas da mesma fila ficaram abertas:
 *
 *   - a segunda via (POST /print/jobs/:id/reprint) admite os dois caixas e
 *     COPIAVA o papel do job original — o PDV da PJ e o caixa da Oficina
 *     reimprimiam uma plaquinha (201), e o renderizador, único que confere a
 *     regra da empresa, nunca rodava na cópia;
 *   - GET /print/jobs/:id/document (alcance do balcão) devolvia o HTML gravado,
 *     com o endereço do QR — o token que abre a página da moto sem sessão;
 *   - GET /print/jobs devolvia o payload de todo job, plaquinha inclusive;
 *   - GET /print/jobs/:id descrevia o job da plaquinha a qualquer caixa.
 *
 * Aqui, pelas rotas de verdade num banco descartável: o caixa do PDV da PJ e o
 * caixa da Oficina levam 403 sem nada gravado; a gestão da Oficina (que TEM a
 * capability) leva a regra da empresa; a gestão da PJ reimprime, e a via sai
 * com o QR de HOJE; os outros papéis (orçamento) seguem como antes; e o motor
 * recusa job de plaquinha fora da PJ mesmo chamado direto.
 *
 * ## As mordidas (cada uma deixa um caso vermelho)
 *
 *   - tire `exigirAcessoAoPapelDaPlaquinha` da segunda via → o PDV da PJ
 *     reimprime (201);
 *   - tire-o de /document → o PDV lê o HTML com o token (200);
 *   - tire-o de GET /print/jobs/:id → o PDV descreve o job (200);
 *   - tire `exigirEmpresaComPlaquinha` dele → a gestão da Oficina lê o papel
 *     antigo e o job (200);
 *   - troque `incluirPlaquinha` por `true` → o PDV vê o job na lista;
 *   - tire o `payload: null` de `listPrintJobs` → o token volta na lista;
 *   - tire EQUIPMENT_QR_TAG de `TIPOS_QUE_SEGUEM_O_CADASTRO` → a via sai com o
 *     QR do adesivo que morreu;
 *   - tire `exigirEmpresaDoPapel` de `createPrintJob` → o motor enfileira
 *     plaquinha da Oficina.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureOfficialTagCompanies, ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { createEquipment } from '../src/services/core/EquipmentService.js';
import { createPrintJob, reprintJob } from '../src/services/core/PrintEngine.js';
import { publicBaseUrl } from '../src/services/core/PublicUrl.js';
import { qrSvg } from '../src/services/core/Qr.js';
import { loginForTest } from './helpers/auth.js';

let app: Express;

type Auth = { Authorization: string };
interface Sessao {
  id: string;
  auth: Auth;
  userId: string;
}

/** O gestor da PJ — `gerente_loja`, o modelo do `ADMIN-PJ MOTORS`. */
let pj: Sessao;
/** O caixa do PDV da PJ — `operador_caixa_loja`, o login `PJ MOTORS`. */
let pdvPj: Sessao;
/** A gestão da Oficina: TEM labels.equipment.print, e a empresa não tem plaquinha. */
let gestaoOficina: Sessao;
/** O caixa da Oficina — `operador_caixa_oficina`, que a segunda via admite. */
let caixaOficina: Sessao;
let mobilidade: string;
let maquinaDaPj: { id: string };

const db = () => getConnection();
const agora = () => new Date().toISOString();

async function entrar(userId: string, slug: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: slug, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    id: String(res.body.company.id),
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    userId: String(res.body.user.id),
  };
}

function token(equipmentId: string): string {
  return (db().prepare('SELECT public_token FROM core_equipment WHERE id = ?').get(equipmentId) as { public_token: string })
    .public_token;
}

/**
 * O QR como a plaquinha o desenha. O papel não traz o endereço em texto: traz
 * o desenho dele (SVG, feito no servidor). Procurar o token como texto no HTML
 * da plaquinha não acharia nada — nem quando ele vaza.
 */
const desenho = (t: string) => qrSvg(`${publicBaseUrl()}/equipamento/${t}`);

const payloadDe = (jobId: string) =>
  String((db().prepare('SELECT payload FROM core_print_jobs WHERE id = ?').get(jobId) as { payload: string | null }).payload);

const jobsDa = (companyId: string) =>
  Number((db().prepare('SELECT COUNT(*) AS n FROM core_print_jobs WHERE company_id = ?').get(companyId) as { n: number }).n);

/** Um job gravado como o banco o guarda — o papel antigo, de antes da regra. */
function jobGravado(companyId: string, documentType: string, documentId: string, payload: string): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO core_print_jobs
         (id, company_id, document_type, document_id, printer_id, status, copies, attempts, payload, error,
          reprint_of, created_by, created_at, printed_at, transport, open_drawer, pdv_terminal_id, agent_id,
          claimed_at, fallback_reason, reason)
       VALUES (?, ?, ?, ?, NULL, 'printed', 1, 1, ?, NULL, NULL, NULL, ?, ?, 'browser', 0, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(id, companyId, documentType, documentId, payload, agora(), agora());
  return id;
}

const reimprimir = (a: Auth, jobId: string) => request(app).post(`/api/v1/core/print/jobs/${jobId}/reprint`).set(a).send({});
const papel = (a: Auth, jobId: string) => request(app).get(`/api/v1/core/print/jobs/${jobId}/document`).set(a);
const job = (a: Auth, jobId: string) => request(app).get(`/api/v1/core/print/jobs/${jobId}`).set(a);
const fila = (a: Auth) => request(app).get('/api/v1/core/print/jobs').set(a);
const estado = (a: Auth, jobId: string, status: string) =>
  request(app).post(`/api/v1/core/print/jobs/${jobId}/status`).set(a).send({ status });
const desistir = (a: Auth, jobId: string) =>
  request(app).post(`/api/v1/core/print/jobs/${jobId}/desistir`).set(a).send({});
const escpos = (a: Auth, jobId: string) => request(app).get(`/api/v1/core/print/jobs/${jobId}/escpos`).set(a);

beforeEach(async () => {
  resetDbForTests();
  app = createApp();
  pj = await entrar('admin-pj', 'pj-motors', 'gerente_loja');
  pdvPj = await entrar('pdv-pj', 'pj-motors', 'operador_caixa_loja');
  gestaoOficina = await entrar('admin-oficina', 'oficina', 'gerente_oficina');
  caixaOficina = await entrar('caixa-oficina', 'oficina', 'operador_caixa_oficina');
  ensureOfficialWorkshops();
  ensureOfficialTagCompanies();
  mobilidade = (db().prepare("SELECT id FROM core_workshops WHERE slug = 'oficina-mobilidade'").get() as { id: string }).id;

  /*
    Uma máquina da PJ para a plaquinha pela fila. A PJ não tem bancada; esta é
    o retrato de um banco antigo (a mesma montagem de audit-impressao), porque
    o papel EQUIPMENT_QR_TAG é desenhado a partir de `core_equipment`.
  */
  const bancadaAntiga = randomUUID();
  db()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'pj-patio-antigo', 'Bancada antiga', 'mobility', 1, ?)`,
    )
    .run(bancadaAntiga, pj.id, agora());
  maquinaDaPj = createEquipment({
    companyId: pj.id,
    workshopId: bancadaAntiga,
    userId: pj.userId,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Patio 150',
  } as Parameters<typeof createEquipment>[0]) as { id: string };
});

/** Uma máquina da Oficina, com o papel da plaquinha dela gravado de antes da regra. */
function plaquinhaAntigaDaOficina(): { jobId: string; token: string } {
  const maquina = createEquipment({
    companyId: gestaoOficina.id,
    workshopId: mobilidade,
    userId: gestaoOficina.userId,
    origin: 'INTERNAL_PJ_MOTORS',
    brand: 'Shineray',
    model: 'Jet 50',
  } as Parameters<typeof createEquipment>[0]) as { id: string };
  const t = token(maquina.id);
  return { jobId: jobGravado(gestaoOficina.id, 'EQUIPMENT_QR_TAG', maquina.id, `<html>/equipamento/${t}</html>`), token: t };
}

describe('o caixa do PDV da PJ não administra a plaquinha pela fila', () => {
  it('não reimprime, não lê o papel, não vê o job — e o orçamento segue saindo como antes', async () => {
    const criado = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(pj.auth)
      .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: maquinaDaPj.id });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const jobId = String(criado.body.id);
    // A plaquinha nunca vai para o agente do caixa: sai pelo diálogo do navegador.
    expect(criado.body.transport).toBe('browser');
    const qrDaMaquina = desenho(token(maquinaDaPj.id));
    // O papel gravado TEM o QR — é ele que não pode sair para o caixa.
    expect(payloadDe(jobId)).toContain(qrDaMaquina);
    const antes = jobsDa(pj.id);

    for (const [nome, chamar] of [
      ['POST /print/jobs/:id/reprint', () => reimprimir(pdvPj.auth, jobId)],
      ['GET /print/jobs/:id/document', () => papel(pdvPj.auth, jobId)],
      ['GET /print/jobs/:id', () => job(pdvPj.auth, jobId)],
      // Estas três também DEVOLVEM o job inteiro (ou dizem o tipo dele), e
      // ficaram de fora do primeiro conserto.
      ['POST /print/jobs/:id/status', () => estado(pdvPj.auth, jobId, 'printing')],
      ['POST /print/jobs/:id/desistir', () => desistir(pdvPj.auth, jobId)],
      ['GET /print/jobs/:id/escpos', () => escpos(pdvPj.auth, jobId)],
    ] as const) {
      const res = await chamar();
      expect(res.status, `${nome}: ${res.text.slice(0, 200)}`).toBe(403);
      expect(res.body.error?.code, nome).toBe('API_PERMISSION_DENIED');
      expect(res.text, `${nome} vazou o QR da plaquinha`).not.toContain(qrDaMaquina);
    }
    const lista = await fila(pdvPj.auth);
    expect(lista.status).toBe(200);
    expect((lista.body.items as { id: string; document_type: string }[]).some((j) => j.document_type === 'EQUIPMENT_QR_TAG')).toBe(false);
    expect(lista.text).not.toContain(qrDaMaquina);
    // Nenhuma via nasceu.
    expect(jobsDa(pj.id)).toBe(antes);

    // Os outros papéis não mudaram: o PDV segue pedindo a segunda via do orçamento e o papel dele.
    const orcamento = jobGravado(pj.id, 'QUOTE', randomUUID(), '<html>Orçamento nº 12</html>');
    const via = await reimprimir(pdvPj.auth, orcamento);
    expect(via.status, JSON.stringify(via.body)).toBe(201);
    const html = await papel(pdvPj.auth, String(via.body.id));
    expect(html.status).toBe(200);
    expect(html.text).toContain('Orçamento nº 12');
    expect(((await fila(pdvPj.auth)).body.items as { id: string }[]).map((j) => j.id)).toContain(orcamento);
  });
});

describe('fora da PJ Motors a plaquinha antiga não sai de novo', () => {
  /*
    A RECUSA DA OFICINA É A DA EMPRESA, e não a do perfil — inclusive para o
    caixa. O portão do papel precisa do TIPO do documento, que só se sabe lendo
    o job; e a leitura do job de plaquinha já passa pela regra da empresa
    (PrintEngine.loadJob). Fora da PJ Motors, então, a primeira e verdadeira
    razão é "plaquinha é exclusiva da PJ Motors" — sem dizer nada sobre o job.
  */
  it('a Oficina inteira leva a regra da empresa em toda a fila — sem via nova e sem token', async () => {
    const antiga = plaquinhaAntigaDaOficina();
    const antes = jobsDa(gestaoOficina.id);

    for (const [quem, sessao, codigo] of [
      ['caixa da Oficina', caixaOficina, 'CORE_COMPANY_NO_TAGS'],
      ['gestão da Oficina', gestaoOficina, 'CORE_COMPANY_NO_TAGS'],
    ] as const) {
      for (const [nome, chamar] of [
        ['POST /print/jobs/:id/reprint', () => reimprimir(sessao.auth, antiga.jobId)],
        ['GET /print/jobs/:id/document', () => papel(sessao.auth, antiga.jobId)],
        ['GET /print/jobs/:id', () => job(sessao.auth, antiga.jobId)],
        ['POST /print/jobs/:id/status', () => estado(sessao.auth, antiga.jobId, 'printing')],
        ['POST /print/jobs/:id/desistir', () => desistir(sessao.auth, antiga.jobId)],
        ['GET /print/jobs/:id/escpos', () => escpos(sessao.auth, antiga.jobId)],
      ] as const) {
        const res = await chamar();
        expect(res.status, `${quem} ${nome}: ${res.text.slice(0, 200)}`).toBe(403);
        expect(res.body.error?.code, `${quem} ${nome}`).toBe(codigo);
        expect(res.text, `${quem} ${nome} vazou o token do QR`).not.toContain(antiga.token);
      }
      const lista = await fila(sessao.auth);
      expect(lista.status).toBe(200);
      expect((lista.body.items as { id: string }[]).map((j) => j.id)).not.toContain(antiga.jobId);
      expect(lista.text).not.toContain(antiga.token);
    }
    expect(jobsDa(gestaoOficina.id)).toBe(antes);
  });
});

describe('a gestão da PJ reimprime, e a via sai com o QR de hoje', () => {
  it('depois da troca do adesivo, a segunda via não reimprime o QR que morreu', async () => {
    const criado = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(pj.auth)
      .send({ documentType: 'EQUIPMENT_QR_TAG', documentId: maquinaDaPj.id });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const jobId = String(criado.body.id);
    const tokenVelho = token(maquinaDaPj.id);
    expect((await papel(pj.auth, jobId)).text).toContain(desenho(tokenVelho));

    // O adesivo foi trocado: a máquina passou a responder por outro token.
    const tokenNovo = `tok-novo-${randomUUID()}`;
    db().prepare('UPDATE core_equipment SET public_token = ? WHERE id = ?').run(tokenNovo, maquinaDaPj.id);

    const via = await reimprimir(pj.auth, jobId);
    expect(via.status, JSON.stringify(via.body)).toBe(201);
    expect(via.body.reprint_of).toBe(jobId);
    const html = await papel(pj.auth, String(via.body.id));
    expect(html.status).toBe(200);
    expect(html.text).toContain(desenho(tokenNovo));
    expect(html.text).not.toContain(desenho(tokenVelho));

    // Quem administra vê o job e a via na fila — sem a credencial na lista.
    const descrito = await job(pj.auth, String(via.body.id));
    expect(descrito.status).toBe(200);
    expect(descrito.body.payload).toBeUndefined();
    const lista = await fila(pj.auth);
    expect(lista.status).toBe(200);
    const daPlaquinha = (lista.body.items as { id: string; document_type: string; payload: string | null }[]).filter(
      (j) => j.document_type === 'EQUIPMENT_QR_TAG',
    );
    expect(daPlaquinha.map((j) => j.id).sort()).toEqual([jobId, String(via.body.id)].sort());
    expect(daPlaquinha.every((j) => j.payload === null)).toBe(true);
    expect(lista.text).not.toContain(desenho(tokenNovo));
    expect(lista.text).not.toContain(desenho(tokenVelho));
  });
});

describe('o motor recusa plaquinha fora da PJ, venha de onde vier', () => {
  it('createPrintJob e reprintJob chamados direto: 403 da regra da empresa, e nada gravado', () => {
    const maquina = createEquipment({
      companyId: gestaoOficina.id,
      workshopId: mobilidade,
      userId: gestaoOficina.userId,
      origin: 'INTERNAL_PJ_MOTORS',
      brand: 'Shineray',
      model: 'Phoenix',
    } as Parameters<typeof createEquipment>[0]) as { id: string };
    const antiga = plaquinhaAntigaDaOficina();
    const antes = jobsDa(gestaoOficina.id);

    expect(() =>
      createPrintJob({
        companyId: gestaoOficina.id,
        documentType: 'EQUIPMENT_QR_TAG',
        documentId: maquina.id,
        payload: '<html>plaquinha</html>',
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE_COMPANY_NO_TAGS', status: 403 }));
    expect(() => reprintJob({ companyId: gestaoOficina.id, jobId: antiga.jobId })).toThrow(
      expect.objectContaining({ code: 'CORE_COMPANY_NO_TAGS', status: 403 }),
    );
    expect(jobsDa(gestaoOficina.id)).toBe(antes);

    // O mesmo motor segue enfileirando os outros papéis da Oficina.
    const orcamento = createPrintJob({
      companyId: gestaoOficina.id,
      documentType: 'QUOTE',
      documentId: randomUUID(),
      payload: '<html>orçamento</html>',
    });
    expect(orcamento.status).toBe('ready');
  });
});
