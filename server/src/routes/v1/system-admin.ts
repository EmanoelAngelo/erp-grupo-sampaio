import { Router } from 'express';
import { authMiddleware, requirePermission, rotaPublica, type AuthedRequest } from '../../middleware/auth.js';
import {
  systemAdminHealth,
  getReleaseVersionInfo,
  evaluateBackendReadiness,
} from '../../services/system-admin/SystemAdminService.js';
import { listCompaniesForUser, temVinculoDeGestao } from '../../services/auth/IdentityService.js';
import { conferirImplantacao, contextoDoProcesso } from '../../services/implantacao/conferenciaDaImplantacao.js';
import {
  desmarcarItem,
  implantacaoDaEmpresa,
  itemExiste,
  marcarItem,
  resumoDasEmpresas,
  type TipoDeMarca,
} from '../../services/implantacao/implantacaoPorEmpresa.js';
import { ApiError } from '../../utils/errors.js';
import { conferirBucket, estadoDoBackup } from '../../services/backup/estadoDoBackup.js';
import { recordAudit } from '../../services/audit/AuditService.js';
import { instanciaNoAr } from '../../services/implantacao/instanciaUnica.js';
import { conferirFusoDaLoja } from '../../services/core/fusoDaLoja.js';

export const systemAdminRouter = Router();

systemAdminRouter.get('/health', rotaPublica('sonda de saúde: monitor e deploy batem aqui antes de existir sessão'), (_req, res) => {
  res.json(systemAdminHealth());
});

systemAdminRouter.get('/readiness', authMiddleware, requirePermission('system-readiness.view'), (_req: AuthedRequest, res) => {
  res.json(evaluateBackendReadiness());
});

/*
  `GET /staging/readiness` SAIU (GAP-PRD-075). Nenhuma tela o chamava, e ele
  dizia "CRM/Kanban operacional", "BI dashboards operacionais" e "Automações
  idempotentes" de três módulos que já tinham saído, e montava a prontidão da
  NF-e e da NFC-e sobre `fiscal_issuer_profiles`/`fiscal_product_profiles`,
  coleções que ninguém escreve. A situação de staging que vale continua em
  `GET /readiness` (`stagingStatus`), e a prontidão fiscal é
  `/core/fiscal/readiness`.
*/

/*
  A CONFERÊNCIA DA IMPLANTAÇÃO (GAP-PRD-013) — o mesmo código do comando
  `conferir-implantacao`, mais o que só a API no ar sabe: se a página chegou
  por HTTPS, se há proxy na frente e se há supervisor. Diz nomes de variável,
  nunca valores. Tela: Configurações › Implantação.
*/
systemAdminRouter.get('/implantacao', authMiddleware, requirePermission('system-readiness.view'), (req: AuthedRequest, res) => {
  res.json(
    conferirImplantacao(
      contextoDoProcesso({ protocolo: req.protocol, encaminhadoComo: req.get('x-forwarded-proto') ?? null }),
    ),
  );
});

/*
  A IMPLANTAÇÃO DE CADA EMPRESA (GAP-PRD-067) — o checklist que junta, por
  empresa, o que cada domínio já responde (fiscal, certificado, impressão,
  maquininha, Asaas, loja online, entrega, contador, equipe, oficina) e o que é
  do grupo (SMTP, central, backup, versão do banco).

  Alcance: `system-readiness.view` (admin_geral e gestor) E vínculo de gestão
  na empresa PEDIDA — o adm de uma loja lê a sua, não a da vizinha. A lista
  devolve só as empresas com vínculo. Marcar (confirmar / não se aplica) é
  `system-readiness.manage`, vai para a auditoria da empresa, e o item confere
  a própria regra (só confirma o que o sistema achou; "não se aplica" só onde
  admite, com motivo). Tela: Configurações › Empresas do grupo › Implantação.
*/
function empresaDeGestao(req: AuthedRequest): string {
  const companyId = String(req.params.companyId ?? '');
  if (!temVinculoDeGestao(req.auth!.sub, companyId)) {
    throw new ApiError('API_TENANT_MISMATCH', 'Empresa não autorizada.', 403);
  }
  return companyId;
}

systemAdminRouter.get('/implantacao/empresas', authMiddleware, requirePermission('system-readiness.view'), (req: AuthedRequest, res, next) => {
  try {
    const ids = listCompaniesForUser(req.auth!.sub)
      .map((c) => c.id)
      .filter((id) => temVinculoDeGestao(req.auth!.sub, id));
    res.json({ items: resumoDasEmpresas(ids) });
  } catch (err) {
    next(err);
  }
});

systemAdminRouter.get('/implantacao/empresas/:companyId', authMiddleware, requirePermission('system-readiness.view'), (req: AuthedRequest, res, next) => {
  try {
    res.json(implantacaoDaEmpresa(empresaDeGestao(req)));
  } catch (err) {
    next(err);
  }
});

systemAdminRouter.put('/implantacao/empresas/:companyId/itens/:item/marca', authMiddleware, requirePermission('system-readiness.manage'), (req: AuthedRequest, res, next) => {
  try {
    const companyId = empresaDeGestao(req);
    const item = String(req.params.item ?? '');
    const tipo = String(req.body?.tipo ?? '') as TipoDeMarca;
    const resultado = marcarItem({
      companyId,
      item,
      tipo,
      motivo: typeof req.body?.motivo === 'string' ? req.body.motivo : null,
      userId: req.auth!.sub,
    });
    recordAudit({
      companyId,
      userId: req.auth!.sub,
      action: 'implantacao.item_marcado',
      entityType: 'implantacao',
      entityId: item,
      detail: { tipo, motivo: resultado.marca?.motivo ?? null, estado: resultado.estado },
      ip: req.ip ?? null,
    });
    res.json({ item: resultado });
  } catch (err) {
    next(err);
  }
});

systemAdminRouter.delete('/implantacao/empresas/:companyId/itens/:item/marca', authMiddleware, requirePermission('system-readiness.manage'), (req: AuthedRequest, res, next) => {
  try {
    const companyId = empresaDeGestao(req);
    const item = String(req.params.item ?? '');
    if (!itemExiste(item)) throw new ApiError('IMPLANTACAO_ITEM_DESCONHECIDO', 'Item de implantação desconhecido.', 404);
    const { removida, item: atual } = desmarcarItem(companyId, item);
    if (removida) {
      recordAudit({
        companyId,
        userId: req.auth!.sub,
        action: 'implantacao.marca_removida',
        entityType: 'implantacao',
        entityId: item,
        detail: { estado: atual.estado },
        ip: req.ip ?? null,
      });
    }
    res.json({ removida, item: atual });
  } catch (err) {
    next(err);
  }
});

/*
  O QUE SAIU DAQUI (GAP-PRD-064), e por quê.

  Sete rotas respondiam estado CRAVADO, sem consultar nada, e nenhuma tela as
  chamava: `/health-dashboard` ("backend ok, database ok" sem abrir o banco),
  `/recovery` e `/reconciliation` ("scan_ok" para qualquer empresa),
  `/homologations` (o "Core ERP" homologado por constante), `/inventory`
  ("CP01-CP73", `indexedDbVersion: 67` de um IndexedDB que não existe),
  `/go-live` (quatro listas de palavras) e `/go-live/activate-core` — que
  respondia "Core Production ativado no backend" sem ativar coisa nenhuma. Os
  documentos de operação mandavam o operador para telas que as consumiriam e
  que nunca existiram.

  O que é de verdade continua, e agora tem tela: `/readiness` e `/release`
  (Configurações › Sistema), `/implantacao` (Configurações › Implantação),
  `/implantacao/empresas/*` (Empresas do grupo › Implantação), `/backup/*`
  (Configurações › Backup).

  `GET /audit` SAIU na verificação do GAP-PRD-075. Nenhuma tela o chamava, e
  ele lia uma lista EM MEMÓRIA que só os testes preenchiam: vazia — sempre, em
  produção —, respondia a linha inventada `audit-stub-scan` ("stub scan",
  "success") para qualquer empresa. Era uma segunda trilha ao lado de
  `core_audit_log`, e só ficava de pé pelo guarda de empresa que a suíte
  cobrava nela. A trilha de verdade é uma só: `GET /core/audit` (Relatórios ›
  Auditoria), com a empresa do token.
*/

/*
  A versão publicada, mais o que só quem responde pelo sistema precisa ver: o
  Node que roda, desde quando o processo está no ar e em que plataforma.
  Tela: Configurações › Sistema.
*/
const PROCESSO_NO_AR_DESDE = new Date(Date.now() - process.uptime() * 1000).toISOString();

systemAdminRouter.get('/release', authMiddleware, requirePermission('system-release.view'), (_req, res) => {
  res.json({
    ...getReleaseVersionInfo(),
    processo: {
      node: process.version,
      plataforma: `${process.platform}/${process.arch}`,
      noArDesde: PROCESSO_NO_AR_DESDE,
      supervisionado: process.env.DEVORA_SUPERVISIONADO === '1',
    },
    // O dono do banco (GAP-PRD-137): uma instância por arquivo, e se é esta.
    instancia: instanciaNoAr(),
    // O corte do dia no SQL ainda bate com o fuso oficial? (GAP-PRD-145)
    calendario: conferirFusoDaLoja(),
  });
});

/*
  O ESTADO DO BACKUP (GAP-PRD-011). Respondia `{ lastBackup: null }` cravado,
  com backup na pasta ou sem. Agora lê a pasta, o registro das execuções, a
  configuração da cópia remota (só se existe) e a última conferência do bucket.
  Global de propósito — o banco é um só para as seis empresas —, e por isso
  guardado por `system-backup`, que só `admin_geral` e `gestor` alcançam.
  Tela: Configurações › Backup.
*/
systemAdminRouter.get('/backup/status', authMiddleware, requirePermission('system-backup.view'), (_req, res) => {
  res.json(estadoDoBackup());
});

/*
  "ENVIOU" NÃO É "ESTÁ LÁ". Lê o bucket e confere o último `.db` enviado e as
  fotos do último conjunto. Uma chamada ao provedor por clique; fica na
  auditoria quem conferiu e o que achou.
*/
systemAdminRouter.post('/backup/conferir-bucket', authMiddleware, requirePermission('system-backup.manage'), async (req: AuthedRequest, res, next) => {
  try {
    const conferencia = await conferirBucket();
    recordAudit({
      companyId: req.auth!.companyId,
      userId: req.auth!.sub,
      action: 'system.backup.bucket_conferido',
      entityType: 'backup',
      detail: {
        ok: conferencia.ok,
        bancos: conferencia.bancos,
        objetosFaltando: conferencia.objetosFaltando,
        motivo: conferencia.motivo,
      },
      ip: req.ip ?? null,
    });
    res.json({ conferencia, estado: estadoDoBackup() });
  } catch (err) {
    next(err);
  }
});
