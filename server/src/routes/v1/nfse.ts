/**
 * As rotas da NFS-e da mão de obra — GAP-PRD-024.
 *
 * Montado DENTRO do `coreRouter` (uma linha, no fim de core.ts), atrás do
 * mesmo `authMiddleware`: toda rota daqui exige sessão e declara quem a
 * alcança. A empresa vem sempre da sessão, nunca do corpo.
 *
 *   - configuração e prontidão: a gerência (é quem grava o cadastro fiscal);
 *   - emitir, registrar e consultar a NFS-e de uma venda: a gerência e os
 *     caixas — o caixa da oficina que cobrou a OS emite a nota dela;
 *   - registrar o cancelamento feito no portal: a gerência.
 */
import { Router } from 'express';
import type { AuthedRequest } from '../../middleware/auth.js';
import { ApiError } from '../../utils/errors.js';
import { decidePelaCapability, passaPelaCapabilityDaRota } from '../../services/auth/PonteDaRota.js';
import { loadEnv } from '../../config/env.js';
import {
  emitirNfseDaVenda,
  getNfseConfig,
  listNfse,
  nfseReadinessForSale,
  prontidaoDaNfse,
  registrarCancelamentoDaNfse,
  registrarNfseManual,
  updateNfseConfig,
} from '../../services/core/NfseService.js';

export const nfseRouter = Router();

const CAIXAS = ['operador_caixa', 'operador_caixa_loja', 'operador_caixa_oficina'] as const;
const GERENCIA = ['gerente_loja', 'gerente_oficina'] as const;

function escopo(req: AuthedRequest): { companyId: string; userId: string } {
  return { companyId: req.auth!.companyId, userId: req.auth!.sub };
}

/**
 * A mesma régua do `requireProfile` de core.ts: admin_geral e gestor passam;
 * o vínculo personalizado decide só pela capability da rota, e os atalhos da
 * tela de Usuários passam pela ponte (PonteDaRota.ts).
 */
function requireProfile(req: AuthedRequest, ...permitidos: readonly string[]): void {
  if (decidePelaCapability(req)) {
    if (passaPelaCapabilityDaRota(req)) return;
    throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
  }
  const perfis = req.auth?.profileCodes ?? [];
  if (perfis.includes('admin_geral') || perfis.includes('gestor')) return;
  if (permitidos.some((p) => perfis.includes(p))) return;
  if (passaPelaCapabilityDaRota(req)) return;
  throw new ApiError('API_PERMISSION_DENIED', 'Permissão negada para esta operação.', 403);
}

nfseRouter.get('/fiscal/nfse/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA);
    res.json(getNfseConfig(escopo(req).companyId));
  } catch (err) {
    next(err);
  }
});

nfseRouter.patch('/fiscal/nfse/config', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA);
    const { companyId, userId } = escopo(req);
    res.json(updateNfseConfig({ companyId, userId, patch: req.body ?? {} }));
  } catch (err) {
    next(err);
  }
});

nfseRouter.get('/fiscal/nfse/readiness', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA);
    res.json(prontidaoDaNfse(escopo(req).companyId));
  } catch (err) {
    next(err);
  }
});

nfseRouter.get('/fiscal/nfse/documents', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA);
    res.json({ items: listNfse(escopo(req).companyId) });
  } catch (err) {
    next(err);
  }
});

nfseRouter.get('/fiscal/sales/:saleId/nfse', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA, ...CAIXAS);
    res.json(nfseReadinessForSale(escopo(req).companyId, String(req.params.saleId)));
  } catch (err) {
    next(err);
  }
});

nfseRouter.post('/fiscal/sales/:saleId/nfse', (req: AuthedRequest, res, next) => {
  void (async () => {
    try {
      requireProfile(req, ...GERENCIA, ...CAIXAS);
      const { companyId, userId } = escopo(req);
      // O simulador só existe fora de produção; o serviço repete a trava
      // olhando também o ambiente da NFS-e e o NODE_ENV.
      const dev = req.body?.developmentMode === true && loadEnv().DEVORA_API_ENV !== 'production';
      const doc = await emitirNfseDaVenda({
        companyId,
        userId,
        saleId: String(req.params.saleId),
        developmentMode: dev,
      });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  })();
});

nfseRouter.post('/fiscal/sales/:saleId/nfse/manual', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA, ...CAIXAS);
    const { companyId, userId } = escopo(req);
    res.status(201).json(
      registrarNfseManual({
        companyId,
        userId,
        saleId: String(req.params.saleId),
        numero: String(req.body?.numero ?? ''),
        codigoVerificacao: req.body?.codigoVerificacao ?? null,
        chaveAcesso: req.body?.chaveAcesso ?? null,
        emitidaEm: String(req.body?.emitidaEm ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});

nfseRouter.post('/fiscal/nfse/:id/cancel-record', (req: AuthedRequest, res, next) => {
  try {
    requireProfile(req, ...GERENCIA);
    const { companyId, userId } = escopo(req);
    res.json(
      registrarCancelamentoDaNfse({
        companyId,
        userId,
        documentId: String(req.params.id),
        motivo: String(req.body?.motivo ?? ''),
      }),
    );
  } catch (err) {
    next(err);
  }
});
