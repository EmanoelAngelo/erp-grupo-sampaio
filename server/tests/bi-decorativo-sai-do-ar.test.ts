/**
 * ============================================================================
 * O QUE SOBROU DO /bi DECORATIVO SAI DO AR — GAP-V36 / GAP-V45
 * ============================================================================
 *
 * ## O achado
 *
 * A auditoria já havia removido `GET /bi/dashboard` e `/bi/executive` — um
 * painel executivo com TODOS os indicadores hardcoded em zero — e deixou o
 * motivo escrito na cicatriz: "número decorativo em painel executivo é mentira
 * executiva". A limpeza parou ali. Ficaram no ar, alcançáveis por qualquer
 * gerente com permissão `corporate-bi.*`:
 *
 *   - ONZE dashboards de domínio (`/bi/commercial`, `/financial`, `/inventory`,
 *     `/supply-chain`, `/crm`, `/workshop`, `/rentals`, `/ecommerce`,
 *     `/logistics`, `/fiscal`, `/loyalty`), servidos por um handler único que
 *     devolvia `kpis: [{ value: 0 }]`, `rankings: []` e `series: []` — o
 *     mesmo zero, com o nome do domínio colado na frente;
 *   - `/bi/rankings` e `/bi/comparisons`, com zeros e listas vazias;
 *   - `/bi/alerts`, `/bi/reconciliation` e `/bi/recovery`, lendo coleções que
 *     NENHUMA linha de código do repositório escreve — sempre vazias;
 *   - `/bi/readiness`, que respondia `ready: true` fixo, com dois contadores
 *     dessas mesmas coleções vazias;
 *   - e o pior deles, `POST /bi/reports`, que FINGIA gerar relatório: gravava
 *     uma linha com `status: 'ready'`, `payload: {}` e um `fingerprint` feito
 *     de `Date.now()`, e devolvia 201.
 *
 * ## A decisão, rota a rota
 *
 * A política é a mesma que a rodada anterior aplicou ao `/bi/dashboard`, e a
 * escolha entre "ligar ao dado real" e "tirar do ar" foi feita por rota:
 *
 *   - `/bi/health` ficou naquela rodada, como sonda. Saiu depois, com o
 *     roteador inteiro (GAP-PRD-075): era a sonda de um módulo que já não
 *     tinha número nenhum. "Este processo está de pé" é `/health`.
 *   - Todas as outras SAEM. Ligá-las ao dado real seria construir onze
 *     dashboards que nenhuma tela pede, com um vocabulário (`storeId`,
 *     `kpis`, `series`) que o sistema não usa em lugar nenhum — e os números
 *     de verdade já existem, testados, em `/core/insights/*`, no painel e, a
 *     partir desta rodada, na Central de Relatórios (`/core/reports`).
 *
 * Mentira removida > mentira melhorada. Quem chamar recebe o 404 com envelope
 * da casa, que é a verdade: essa resposta não existe.
 *
 * ## O caso que impede o desastre oposto
 *
 * Um teste que só cobra 404 fica verde se alguém derrubar o roteador inteiro,
 * ou o servidor. Por isso o último bloco prova que o processo continua
 * respondendo e que os números de verdade continuam no ar, no mesmo processo.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';

const app = createApp();

function dono() {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440099',
    companyId: 'company-bi-limpeza',
    storeId: 'store-bi-limpeza',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

/**
 * As rotas que saíram. O `admin_geral` é escolhido de propósito: ele passa em
 * TODA permissão, então um 404 para ele é 404 para todo mundo. Se o teste
 * usasse um perfil raso, um 403 disfarçaria a rota continuando no ar.
 */
const DOMINIOS = [
  'commercial',
  'financial',
  'inventory',
  'supply-chain',
  'crm',
  'workshop',
  'rentals',
  'ecommerce',
  'logistics',
  'fiscal',
  'loyalty',
];

const REMOVIDAS_GET = [
  ...DOMINIOS,
  'rankings',
  'comparisons',
  'alerts',
  'reports',
  'reconciliation',
  'recovery',
  'readiness',
];

beforeAll(() => {
  resetDbForTests();
});

describe('os onze dashboards de domínio não existem mais', () => {
  for (const dominio of DOMINIOS) {
    it(`GET /bi/${dominio} responde 404 com envelope da casa`, async () => {
      const res = await request(app).get(`/api/v1/bi/${dominio}`).set(dono());
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('API_NOT_FOUND');
      // E não sobra rastro do stub: nada de `kpis` nem de `value: 0` na
      // resposta — o 404 é a resposta inteira.
      expect(JSON.stringify(res.body)).not.toContain('kpis');
    });
  }
});

describe('o resto do BI decorativo também saiu', () => {
  for (const rota of REMOVIDAS_GET.filter((r) => !DOMINIOS.includes(r))) {
    it(`GET /bi/${rota} responde 404`, async () => {
      const res = await request(app).get(`/api/v1/bi/${rota}`).set(dono());
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('API_NOT_FOUND');
    });
  }

  it('POST /bi/reports — o que FINGIA gerar relatório — responde 404', async () => {
    /*
      Era a rota mais urgente das quinze: devolvia 201 com `status: 'ready'` e
      `payload: {}`. Uma integração que a chamasse concluiria que o relatório
      ficou pronto, e o relatório não existia. O caminho de verdade é
      `GET /core/reports/:id` (com `formato=csv`), montado sobre os números do
      banco.
    */
    const res = await request(app)
      .post('/api/v1/bi/reports')
      .set({ ...dono(), 'Idempotency-Key': 'bi-report-que-nao-nasce' })
      .send({ reportType: 'executive', title: 'Relatório BI' });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('API_NOT_FOUND');
  });
});

describe('o que ficou de pé continua de pé — o teste não pode passar varrendo o vazio', () => {
  it('o processo responde em /health — e /bi/health saiu com o roteador (GAP-PRD-075)', async () => {
    const processo = await request(app).get('/api/v1/health');
    expect(processo.status).toBe(200);
    const sonda = await request(app).get('/api/v1/bi/health');
    expect(sonda.status).toBe(404);
  });

  it('os números de VERDADE respondem no mesmo processo', async () => {
    // Sem este caso, apagar o roteador `/api/v1` inteiro deixaria o arquivo
    // verde. `/core/insights/operations` é a rota que o BI da tela usa.
    const res = await request(app).get('/api/v1/core/insights/operations').set(dono());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.operations)).toBe(true);
  });
});

describe('a documentação não pode continuar prometendo o que saiu', () => {
  it('o openapi não descreve nenhuma das rotas removidas', async () => {
    /*
      Um spec que anuncia quinze rotas mortas é a mesma mentira num outro
      arquivo — e é ele que um integrador lê ANTES de bater na API. A remoção
      não está completa enquanto o contrato publicado a contradiz.
    */
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const caminhos = Object.keys(res.body.paths as Record<string, unknown>);
    for (const rota of REMOVIDAS_GET) {
      expect(caminhos, `/bi/${rota} ainda está no openapi`).not.toContain(`/bi/${rota}`);
    }
    // Nem a sonda que sobrava (GAP-PRD-075); o que é de verdade continua
    // documentado — remover demais é o erro simétrico.
    expect(caminhos).not.toContain('/bi/health');
    expect(caminhos).toContain('/core/reports');
  });
});
