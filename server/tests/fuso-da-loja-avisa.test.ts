/**
 * ============================================================================
 * O DESLOCAMENTO FIXO DO SQL É CONFERIDO NO AR (GAP-PRD-145)
 * ============================================================================
 *
 * `diaDaLojaSql` soma -3h fixas; `diaDaLoja` usa o fuso oficial. Se o Brasil
 * reinstituir o horário de verão, os dois passam a discordar sobre o dia da
 * venda perto da meia-noite — e até aqui só a suíte percebia.
 *
 * A prova não depende de imaginação: o `tzdata` do Node guarda o último
 * horário de verão brasileiro (04/11/2018 a 17/02/2019). Conferir a partir de
 * outubro de 2018 TEM de avisar "vai divergir em 04/11"; conferir em janeiro
 * de 2019, "diverge agora"; e hoje, "o fixo vale".
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { avisarSeOFusoDiverge, conferirFusoDaLoja } from '../src/services/core/fusoDaLoja.js';

describe('a conferência do fuso', () => {
  it('hoje (sem horário de verão): o fixo vale pela janela inteira', () => {
    const c = conferirFusoDaLoja(new Date('2026-09-11T12:00:00.000Z'));
    expect(c.estado).toBe('FIXO_VALE');
    expect(c.primeiraDivergencia).toBeNull();
    expect(c.comoResolver).toBeNull();
    expect(c.deslocamentoSqlHoras).toBe(-3);
    expect(new Date(c.conferidoAte).getTime() - new Date(c.conferidoEm).getTime()).toBe(400 * 86_400_000);
  });

  it('outubro de 2018: avisa ANTES, com o dia em que o horário de verão começou', () => {
    const c = conferirFusoDaLoja(new Date('2018-10-01T12:00:00.000Z'));
    expect(c.estado).toBe('VAI_DIVERGIR');
    // O horário de verão de 2018 começou à 0h de 04/11 em São Paulo (03:00Z).
    expect(c.primeiraDivergencia!.slice(0, 10)).toBe('2018-11-04');
    expect(c.comoResolver).toContain('2018-11-04');
  });

  it('janeiro de 2019, dentro do horário de verão: diverge agora', () => {
    const c = conferirFusoDaLoja(new Date('2019-01-10T12:00:00.000Z'));
    expect(c.estado).toBe('DIVERGE_AGORA');
    expect(c.primeiraDivergencia).toBe('2019-01-10T12:00:00.000Z');
  });

  it('uma regra futura (simulada) aparece com a data dela', () => {
    const c = conferirFusoDaLoja(new Date('2026-09-11T12:00:00.000Z'), {
      aindaFixo: (instante) => instante.getTime() < Date.parse('2026-11-01T03:00:00.000Z'),
    });
    expect(c.estado).toBe('VAI_DIVERGIR');
    expect(c.primeiraDivergencia!.slice(0, 10)).toBe('2026-11-01');
  });
});

describe('o aviso do boot', () => {
  it('fixo valendo: não escreve nada no log', () => {
    const avisos: string[] = [];
    const c = avisarSeOFusoDiverge((m) => avisos.push(m), new Date('2026-09-11T12:00:00.000Z'));
    expect(c.estado).toBe('FIXO_VALE');
    expect(avisos).toEqual([]);
  });

  it('divergindo: escreve FUSO_DA_LOJA_DIVERGE com a data e o que fazer', () => {
    const avisos: Array<{ m: string; meta?: Record<string, unknown> }> = [];
    avisarSeOFusoDiverge((m, meta) => avisos.push({ m, meta }), new Date('2018-10-01T12:00:00.000Z'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.m).toBe('FUSO_DA_LOJA_DIVERGE');
    expect(String(avisos[0]!.meta?.primeiraDivergencia)).toMatch(/^2018-11-04/);
    expect(String(avisos[0]!.meta?.comoResolver)).toContain('DESLOCAMENTO_SQL_HORAS');
  });
});

describe('a tela Sistema recebe a conferência', () => {
  it('GET /system/release traz o calendário da loja', async () => {
    resetDbForTests();
    const app = createApp();
    const senha = 'Fuso@DaLoja!2026';
    const empresa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const userId = await upsertUser({ login: 'GESTOR.FUSO', displayName: 'Gestor', password: senha });
    linkUserToCompany(userId, empresa, 'gestor', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GESTOR.FUSO', password: senha, companyId: empresa });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const r = await request(app)
      .get('/api/v1/system/release')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.calendario).toMatchObject({
      estado: 'FIXO_VALE',
      fuso: 'America/Sao_Paulo',
      deslocamentoSqlHoras: -3,
    });
  });
});
