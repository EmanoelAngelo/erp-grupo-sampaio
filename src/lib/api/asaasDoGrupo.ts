/**
 * O que cada operação do grupo ainda precisa para cobrar pelo Asaas
 * (GAP-PRD-017) — o cliente de `GET /core/integrations/asaas/grupo`.
 *
 * Só os donos do grupo leem (o servidor responde 403 ao gerente de loja). Não
 * há segredo na resposta: só se cada coisa está configurada e o que falta.
 */
import { apiRequest, exigirCampos } from './client';

export interface OQueFaltaNoAsaas {
  codigo: string;
  tipo: 'credencial' | 'configuracao_do_servidor' | 'cadastro_no_asaas' | 'acao_na_tela';
  quem: 'dono' | 'instalacao';
  frase: string;
}

export interface ProntidaoAsaasDaOperacao {
  companyId: string;
  tradeName: string;
  effectiveEnvironment: 'sandbox' | 'production';
  canChargeSandbox: boolean;
  canChargeProduction: boolean;
  sandboxHomologated: boolean;
  webhook: { url: string; publiclyReachable: boolean; lastEventAt: string | null };
  missing: OQueFaltaNoAsaas[];
}

export interface ProntidaoAsaasDoGrupo {
  operations: ProntidaoAsaasDaOperacao[];
  readyForProduction: number;
  total: number;
}

export const asaasDoGrupoApi = {
  prontidao: () =>
    apiRequest<ProntidaoAsaasDoGrupo>('/core/integrations/asaas/grupo').then((r) =>
      exigirCampos(r, 'operations', 'readyForProduction', 'total'),
    ),
};
