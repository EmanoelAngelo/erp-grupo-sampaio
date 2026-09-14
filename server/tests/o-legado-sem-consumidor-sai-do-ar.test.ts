/**
 * O LEGADO SEM CONSUMIDOR SAI DO AR (GAP-PRD-075).
 *
 * Dez roteadores paralelos ao núcleo continuavam montados sobre a camada de
 * documentos, e três deles não tinham nem consumidor nem dono:
 *
 *   /crm          17 rotas sobre `crm_*`. O próprio arquivo admitia viver "em
 *                 outro espaço de identidade" e coexistir com `core_leads`
 *                 "por prazo determinado". Duas verdades sobre o mesmo lead:
 *                 o gestor criava lead/oportunidade pela API e ele nunca
 *                 aparecia na tela, que lê `core_leads`.
 *   /automations  15 rotas sobre `automation_*`, com o menu dizendo "em breve"
 *                 — e as rotas respondendo.
 *   /bi           só a sonda de um módulo que já não tinha nenhum número (os
 *                 quinze painéis saíram na rodada dos relatórios). O processo
 *                 vivo é `/health`; o BI de verdade é `/core/insights/*`.
 *
 * Saíram os três roteadores, os serviços deles e as rotas do contrato
 * publicado. Na junção das frentes saíram mais três: `/fiscal*` (o CSC, a
 * última porta, foi para `/core/fiscal/nfce/csc`), `/integrations` (a Central
 * de Integrações sem tela, segunda porta de cada credencial) e
 * `/system/staging/readiness` (dizia "operacional" de módulos que já tinham
 * saído). Ficam fora do núcleo só os prefixos com tela em cima:
 * `/payment-terminals` (frente PAG) e `/logistics` (frente LOG), além de
 * `/system`. O último caso deste arquivo é a lista FECHADA do que pode estar
 * montado: prefixo novo fora do núcleo precisa de uma decisão escrita aqui.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '../src');
const app = createApp();
let auth: Record<string, string>;

beforeAll(async () => {
  const login = await loginForTest(app, {
    userId: 'gestor-do-legado',
    companyId: 'empresa-sem-legado',
    profileCodes: ['admin_geral'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}`, 'Idempotency-Key': 'legado-sai' };
});

const FORA_DO_AR: Array<{ metodo: 'get' | 'post' | 'patch'; caminho: string }> = [
  { metodo: 'get', caminho: '/crm/health' },
  { metodo: 'get', caminho: '/crm/leads' },
  { metodo: 'post', caminho: '/crm/leads' },
  { metodo: 'post', caminho: '/crm/opportunities' },
  { metodo: 'patch', caminho: '/crm/opportunities/qualquer' },
  { metodo: 'post', caminho: '/crm/segments' },
  { metodo: 'get', caminho: '/automations/health' },
  { metodo: 'get', caminho: '/automations/rules' },
  { metodo: 'post', caminho: '/automations/rules' },
  { metodo: 'get', caminho: '/automations/dashboard' },
  // A junção (GAP-PRD-075): a Central de Integrações sem tela, e o relatório
  // de staging que dizia "operacional" de módulos que já tinham saído.
  { metodo: 'get', caminho: '/integrations' },
  { metodo: 'get', caminho: '/integrations/asaas' },
  { metodo: 'post', caminho: '/integrations/asaas/secrets' },
  { metodo: 'post', caminho: '/integrations/nfe/secrets' },
  { metodo: 'post', caminho: '/integrations/asaas/activate' },
  { metodo: 'get', caminho: '/system/staging/readiness' },
  // A auditoria de sistema sem tela (verificação do GAP-PRD-075): respondia
  // uma lista em memória que só os testes preenchem e, vazia — sempre, em
  // produção —, inventava a linha 'audit-stub-scan'. A trilha é /core/audit.
  { metodo: 'get', caminho: '/system/audit' },
  { metodo: 'get', caminho: '/bi/health' },
];

describe('os roteadores sem consumidor respondem o 404 da casa', () => {
  for (const r of FORA_DO_AR) {
    it(`${r.metodo.toUpperCase()} ${r.caminho}`, async () => {
      const res = await request(app)[r.metodo](`/api/v1${r.caminho}`).set(auth).send({ name: 'x', title: 'x' });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error?.code).toBe('API_NOT_FOUND');
    });
  }

  it('o lead que a tela mostra continua tendo um escritor só: o núcleo', async () => {
    const res = await request(app).get('/api/v1/core/leads').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('e a sonda do processo continua em /health', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});

describe('o código e o contrato acompanham', () => {
  it('os roteadores e os serviços saíram da árvore', () => {
    for (const arquivo of [
      'routes/v1/crm.ts',
      'routes/v1/automations.ts',
      'routes/v1/bi.ts',
      'services/crm',
      'services/automation',
      'services/corporate-bi',
      // A junção (GAP-PRD-075): a Central de Integrações, os estados por
      // provedor que só ela gravava e o e-commerce que só ela lia.
      'routes/v1/integrations.ts',
      'services/integrations/IntegrationsService.ts',
      'services/integrations/FiscalIntegrationStateService.ts',
      'services/integrations/EcommerceIntegrationStateService.ts',
      'services/integrations/LogisticsIntegrationStateService.ts',
      'services/integrations/PaymentTerminalIntegrationStateService.ts',
      'services/ecommerce',
    ]) {
      expect(existsSync(resolve(SRC, arquivo)), `${arquivo} ainda existe`).toBe(false);
    }
  });

  it('o openapi não descreve /crm, /automations, /bi, /sync, /integrations, /system/staging nem /system/audit', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    const caminhos = Object.keys(res.body.paths as Record<string, unknown>);
    const sobras = caminhos.filter((c) => /^\/(crm|automations|bi|sync|integrations|system\/staging|system\/audit)(\/|$)/.test(c));
    expect(sobras).toEqual([]);
  });

  it('só monta prefixo fora do núcleo quem tem consumidor ou dono declarado', () => {
    const indice = readFileSync(resolve(SRC, 'routes/v1/index.ts'), 'utf8');
    const montados = [...indice.matchAll(/v1Router\.use\('([^']+)'/g)].map((m) => m[1]);
    /*
      A lista FECHADA. Sair daqui é livre (a frente dona desmonta quando
      decidir); entrar exige escrever o porquê.
    */
    const PERMITIDOS: Record<string, string> = {
      '/auth': 'login — todas as telas',
      '/core': 'o núcleo — todas as telas',
      '/loja': 'a vitrine pública',
      '/system': 'telas Sistema, Implantação e Backup (GAP-PRD-064/067/011)',
      // `/fiscal`, `/fiscal/nfe` (GAP-PRD-096) e `/fiscal/nfce` (o CSC foi ao
      // núcleo na junção do GAP-PRD-075) saíram: nenhum prefixo fiscal fora de `/core`.
      '/payment-terminals': 'frente PAG monta a tela da maquininha (GAP-PRD-076)',
      '/logistics': 'frente LOG monta o cadastro de transportadora (GAP-PRD-117)',
      '/acesso': 'tela Usuários e equipe — o editor de acesso por empresa, PDV e página (preparação da entrega)',
      // `/integrations` saiu na junção (GAP-PRD-075): nenhuma tela o chamava, e
      // cada credencial tem a porta do próprio domínio.
    };
    const semDono = montados.filter((p) => !(p in PERMITIDOS));
    expect(semDono, 'prefixo montado sem consumidor nem dono declarado').toEqual([]);
    expect(montados).toContain('/core');
  });
});
