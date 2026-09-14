/**
 * O SELETOR DE PERFIL SÓ OFERECE O QUE QUEM PERGUNTA PODE ENTREGAR — GAP-PRD-149.
 *
 * `GET /core/team/profiles` devolvia `ASSIGNABLE_PROFILES` inteiro a qualquer
 * gerente. O gerente de loja via "Gestor" e "Escritório de contabilidade",
 * escolhia, preenchia a ficha e tomava 403 CORE_PROFILE_ABOVE_YOURS ao salvar.
 * A lista agora sai da mesma régua que recusa (`assertPodeAtribuir`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ASSIGNABLE_PROFILES } from '../src/services/core/TeamService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

let app: ReturnType<typeof createApp>;

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}`, companyId: 'empresa-seletor', profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
});

describe('o gerente não recebe no seletor o que o servidor lhe recusa', () => {
  for (const gerente of ['gerente_loja', 'gerente_oficina']) {
    it(`${gerente}: sem gestor e sem contador, com os perfis da operação`, async () => {
      const res = await request(app).get('/api/v1/core/team/profiles').set(auth(gerente));
      expect(res.status).toBe(200);
      const itens = res.body.items as string[];
      expect(itens).not.toContain('gestor');
      expect(itens).not.toContain('contador');
      expect(itens.sort()).toEqual(
        [
          'gerente_loja',
          'gerente_oficina',
          'mecanico',
          'atendente',
          'estoquista',
          'operador_caixa_loja',
          'operador_caixa_oficina',
        ].sort(),
      );
    });
  }

  it('e cada perfil oferecido ao gerente é aceito na criação (oferta ⊆ servidor)', async () => {
    const lista = await request(app).get('/api/v1/core/team/profiles').set(auth('gerente_loja'));
    for (const perfil of lista.body.items as string[]) {
      const res = await request(app)
        .post('/api/v1/core/team')
        .set(auth('gerente_loja'))
        .send({
          login: `novo.${perfil}`,
          displayName: `Novo ${perfil}`,
          profileCode: perfil,
          password: 'Provisoria@2026',
          workshopIds: [],
        });
      // Perfil de oficina exige bancada (400 CORE_WORKSHOP_REQUIRED...): o que
      // importa aqui é que NENHUM volta 403 CORE_PROFILE_ABOVE_YOURS.
      expect(res.body?.error?.code, perfil).not.toBe('CORE_PROFILE_ABOVE_YOURS');
    }
  });
});

describe('quem responde pelo grupo continua vendo a lista inteira', () => {
  for (const dono of ['gestor', 'admin_geral']) {
    it(`${dono}: todos os atribuíveis, inclusive gestor e contador`, async () => {
      const res = await request(app).get('/api/v1/core/team/profiles').set(auth(dono));
      expect(res.status).toBe(200);
      expect((res.body.items as string[]).sort()).toEqual([...ASSIGNABLE_PROFILES].sort());
    });
  }

  it('quem não gere pessoas continua de fora (403)', async () => {
    const res = await request(app).get('/api/v1/core/team/profiles').set(auth('estoquista'));
    expect(res.status).toBe(403);
  });
});
