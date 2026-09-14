/**
 * O REFRESH PERGUNTA À PESSOA DE HOJE — não à sessão de ontem.
 *
 * ## O buraco, medido antes do conserto
 *
 * `refreshSession` lia só a linha da sessão e reemitia o que estava gravado:
 * perfil antigo, versão antiga, sem nunca abrir `core_users`. Consequências:
 *
 *   - desligado (`active = 0`) renovava o token a cada hora, PARA SEMPRE — o
 *     login barrava, o refresh não. Para um contador desligado, pessoa de fora
 *     com acesso ao pacote fiscal do grupo, não era janela: era porta;
 *   - `session_version` era escritor sem leitor — desativação e troca de senha
 *     incrementam o campo exatamente para derrubar sessões, e nada o comparava;
 *   - rebaixado renovava com o perfil antigo até alguém notar.
 *
 * Todos os casos abaixo atravessam a ROTA (`POST /auth/refresh`), porque este
 * projeto já teve guarda perfeito no serviço e inerte na rota.
 *
 * ## O que continua aberto, de propósito e escrito
 *
 * O ACCESS token já emitido vale até expirar (1 hora). O que esta rodada
 * garante é que ele não se RENOVA — desligou, a pessoa cai em no máximo uma
 * hora, e não "nunca".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';

const app = createApp();
const LOJA = 'loja-sessao';

let gestorAuth: { Authorization: string };

/** Entra como o usuário-alvo e devolve tokens + o id dele no banco. */
async function entrar(login: string, perfil: string) {
  const res = await loginForTest(app, {
    userId: login,
    companyId: LOJA,
    profileCodes: [perfil],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    userId: String(res.body.user.id),
    accessToken: String(res.body.accessToken),
    refreshToken: String(res.body.refreshToken),
  };
}

async function refresh(refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const gestor = await loginForTest(app, {
    userId: 'chefe-sessao',
    companyId: LOJA,
    profileCodes: ['gestor'],
  });
  gestorAuth = { Authorization: `Bearer ${gestor.body.accessToken}` };
});

describe('o refresh de quem foi desligado', () => {
  it('desativar a conta mata a renovação — o 401 chega pela rota', async () => {
    const alvo = await entrar('contador-desligavel', 'contador');

    // Antes do desligamento, o refresh funciona.
    const antes = await refresh(alvo.refreshToken);
    expect(antes.status).toBe(200);

    const desligado = await request(app)
      .post(`/api/v1/core/team/${alvo.userId}/active`)
      .set(gestorAuth)
      .send({ active: false });
    expect(desligado.status).toBe(200);

    // O refresh emitido ANTES do desligamento morre aqui.
    const depois = await refresh(String(antes.body.refreshToken));
    expect(depois.status).toBe(401);
  });

  /*
    A RECUSA REVOGA. Sem isto, o refresh recusado ficaria vivo esperando a
    conta ser reativada — e a credencial antiga ressuscitaria sozinha, sem
    ninguém decidir isso. Reativar dá acesso pelo LOGIN, nunca pelo token que
    sobrou na mão de quem foi desligado.
  */
  it('reativar a conta NÃO ressuscita o refresh que foi recusado', async () => {
    const alvo = await entrar('contador-reativado', 'contador');

    await request(app)
      .post(`/api/v1/core/team/${alvo.userId}/active`)
      .set(gestorAuth)
      .send({ active: false });

    // A tentativa durante o desligamento é recusada — e revoga.
    expect((await refresh(alvo.refreshToken)).status).toBe(401);

    await request(app)
      .post(`/api/v1/core/team/${alvo.userId}/active`)
      .set(gestorAuth)
      .send({ active: true });

    // Mesmo reativado, o token antigo continua morto.
    expect((await refresh(alvo.refreshToken)).status).toBe(401);
  });

  it('trocar a senha derruba as sessões anteriores — session_version ganhou o leitor', async () => {
    const alvo = await entrar('estoquista-senha', 'estoquista');

    const troca = await request(app)
      .post(`/api/v1/core/team/${alvo.userId}/password`)
      .set(gestorAuth)
      .send({ password: 'NovaSenha@2026' });
    expect(troca.status).toBe(200);

    // O refresh emitido antes da troca carrega a versão antiga: 401.
    expect((await refresh(alvo.refreshToken)).status).toBe(401);
  });
});

describe('o refresh de quem mudou de papel', () => {
  it('rebaixado renova com o perfil DE AGORA — e a rota de gestão o recusa', async () => {
    const alvo = await entrar('gerente-rebaixado', 'gerente_loja');

    // O gerente alcança a prévia do fechamento.
    const antes = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-08/previa')
      .set({ Authorization: `Bearer ${alvo.accessToken}` });
    expect(antes.status).toBe(200);

    // Rebaixado a atendente pelo caminho real da tela de equipe.
    const rebaixa = await request(app)
      .patch(`/api/v1/core/team/${alvo.userId}`)
      .set(gestorAuth)
      .send({ profileCode: 'atendente' });
    expect(rebaixa.status).toBe(200);

    const renovado = await refresh(alvo.refreshToken);
    expect(renovado.status).toBe(200);

    /*
      O token NOVO carrega o perfil relido do vínculo. A prova não é decodificar
      o JWT — é o guarda da rota recusar: a mesma prévia que abria para o
      gerente devolve 403 para o atendente que ele virou.
    */
    const depois = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-08/previa')
      .set({ Authorization: `Bearer ${renovado.body.accessToken}` });
    expect(depois.status).toBe(403);
  });

  it('desvinculado da operação não renova acesso a ela', async () => {
    const alvo = await entrar('vinculo-removido', 'estoquista');

    getConnection()
      .prepare('DELETE FROM core_user_companies WHERE user_id = ? AND company_id = ?')
      .run(alvo.userId, LOJA);

    expect((await refresh(alvo.refreshToken)).status).toBe(401);
  });
});

describe('quem não mudou nada continua renovando', () => {
  it('o caminho feliz fica de pé, com rotação', async () => {
    const alvo = await entrar('caixa-normal', 'operador_caixa_loja');

    const primeira = await refresh(alvo.refreshToken);
    expect(primeira.status).toBe(200);
    expect(primeira.body.accessToken).toBeTruthy();

    // Rotação: o token usado morre.
    expect((await refresh(alvo.refreshToken)).status).toBe(401);
    // E o novo segue funcionando.
    expect((await refresh(String(primeira.body.refreshToken))).status).toBe(200);
  });
});
