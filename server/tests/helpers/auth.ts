/**
 * Helper de autenticação para os testes.
 *
 * Antes, os testes obtinham token chamando `POST /auth/login` com um
 * `userId`/`companyId` arbitrários — o endpoint não verificava senha. Esse
 * bypass foi removido do produto, então aqui provisionamos usuário, empresa e
 * vínculo de verdade e fazemos um login real com senha Argon2id.
 */
import request from 'supertest';
import type { Express } from 'express';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../../src/services/auth/IdentityService.js';

export const TEST_PASSWORD = 'Teste@GrupoSampaio2026';

export interface TestLoginPayload {
  userId?: string;
  companyId?: string;
  storeId?: string;
  profileCodes?: string[];
}

/**
 * Provisiona o cenário descrito no payload e devolve a resposta do login
 * real, mantendo o mesmo formato que os testes já consomem
 * (`res.body.accessToken`).
 */
export async function loginForTest(app: Express, payload: TestLoginPayload = {}) {
  const userId = payload.userId ?? 'user-1';
  const companyId = payload.companyId ?? 'company-1';
  const profile = payload.profileCodes?.[0] ?? 'admin_geral';
  const login = `${userId}@${companyId}`;

  // O id da empresa é fixado para bater com o que os testes enviam no corpo
  // das requisições e com as checagens de escopo do middleware.
  upsertCompany({
    id: companyId,
    slug: companyId,
    legalName: `${companyId} Ltda`,
    tradeName: companyId,
  });
  const realUserId = await upsertUser({
    login,
    displayName: userId,
    password: TEST_PASSWORD,
  });
  linkUserToCompany(realUserId, companyId, profile, true);

  return request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: TEST_PASSWORD, companyId });
}
