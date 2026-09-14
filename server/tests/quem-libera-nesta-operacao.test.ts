/**
 * QUEM LIBERA AQUI — a alçada pontual diz com quem o balcão pode contar
 * (GAP-PRD-054).
 *
 * A mecânica da liberação pontual está pronta e provada (liberacao-pontual,
 * alcada-sem-porta-dos-fundos). O que faltava era VER o organograma: no banco
 * real só dois autorizadores (admin_geral e gestor do grupo) respondem pelas
 * seis operações, e nenhuma tela dizia isso. Toda liberação — desconto acima da
 * política, sangria especial, cancelar, devolver, reabrir caixa — depende de
 * uma dessas duas pessoas digitar a senha ao lado do operador.
 *
 * `GET /core/authorizations/quem-libera` responde, para a operação da sessão,
 * quem tem alçada ALI (a mesma régua de `POST /authorizations`: vínculo ativo
 * nesta operação com perfil autorizador), separando os gerentes da operação
 * dos donos do grupo. Só nomes e perfis — nunca o login, que é metade da
 * credencial que o diálogo pede.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const LOJA = 'empresa-loja';
const OUTRA = 'empresa-outra';

let app: ReturnType<typeof createApp>;

function sessao(userId: string, companyId: string, perfil: string): { Authorization: string } {
  const s = issueSession({ userId, companyId, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // O retrato do banco real: só os dois donos do grupo com alçada na loja.
  sessao('ADMIN', LOJA, 'admin_geral');
  sessao('CARLOS', LOJA, 'gestor');
  sessao('caixa-loja', LOJA, 'operador_caixa_loja');
  // E um gerente de OUTRA operação, que não libera aqui.
  sessao('gerente-da-outra', OUTRA, 'gerente_loja');
});

async function perguntar(auth: { Authorization: string }) {
  return request(app).get('/api/v1/core/authorizations/quem-libera').set(auth);
}

describe('o organograma de hoje fica visível', () => {
  it('só os donos do grupo: semAlcadaNaOperacao, e a lista diz quem são', async () => {
    const res = await perguntar(sessao('caixa-loja', LOJA, 'operador_caixa_loja'));
    expect(res.status).toBe(200);
    expect(res.body.semAlcadaNaOperacao).toBe(true);
    expect(res.body.daOperacao).toEqual([]);
    expect(res.body.doGrupo).toEqual([
      { nome: 'ADMIN', perfil: 'admin_geral' },
      { nome: 'CARLOS', perfil: 'gestor' },
    ]);
    // As ações que dependem dessas pessoas vêm da lista que o servidor cobra.
    expect(res.body.acoes).toEqual(
      expect.arrayContaining(['desconto_acima_limite', 'cancelar_venda', 'devolver_venda']),
    );
  });

  it('o gerente de OUTRA operação não aparece aqui — ele não libera aqui', async () => {
    const res = await perguntar(sessao('caixa-loja', LOJA, 'operador_caixa_loja'));
    expect(JSON.stringify(res.body)).not.toContain('gerente-da-outra');
  });

  it('com um gerente da loja cadastrado, a loja passa a ter alçada presente', async () => {
    sessao('Ana Gerente', LOJA, 'gerente_loja');
    const res = await perguntar(sessao('caixa-loja', LOJA, 'operador_caixa_loja'));
    expect(res.body.semAlcadaNaOperacao).toBe(false);
    expect(res.body.daOperacao).toEqual([{ nome: 'Ana Gerente', perfil: 'gerente_loja' }]);
  });

  it('gerente desligado não conta — ele não consegue liberar', async () => {
    sessao('Gerente Antigo', LOJA, 'gerente_loja');
    getConnection().prepare("UPDATE core_users SET active = 0 WHERE id = 'Gerente Antigo'").run();
    const res = await perguntar(sessao('caixa-loja', LOJA, 'operador_caixa_loja'));
    expect(res.body.semAlcadaNaOperacao).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('Gerente Antigo');
  });

  it('a resposta não carrega login nenhum', async () => {
    const res = await perguntar(sessao('caixa-loja', LOJA, 'operador_caixa_loja'));
    expect(JSON.stringify(res.body)).not.toMatch(/sessao-|"login"/);
  });
});

describe('quem pergunta', () => {
  it('o escritório também lê (é quem monta a equipe)', async () => {
    const res = await perguntar(sessao('estoq', LOJA, 'estoquista'));
    expect(res.status).toBe(200);
  });

  it('mecânico e contador não (403) — eles não pedem liberação', async () => {
    for (const perfil of ['mecanico', 'contador']) {
      const res = await perguntar(sessao(`u-${perfil}`, LOJA, perfil));
      expect(res.status, perfil).toBe(403);
    }
  });
});
