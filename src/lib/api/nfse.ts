/**
 * A NFS-e da mão de obra — GAP-PRD-024.
 *
 * A venda da OS separa a peça (nota de mercadoria, NFC-e) da mão de obra
 * (NFS-e). Este módulo fala com as rotas da NFS-e: a configuração da
 * operação (decisão do dono, códigos do contador), a prontidão com o dono de
 * cada pendência, e a NFS-e de uma venda — emitir pela Sefin Nacional ou
 * registrar a emitida no portal.
 */
import { apiRequest } from './client';

export type ModoDaNfse = 'DESLIGADA' | 'EMISSOR_NACIONAL' | 'REGISTRO_MANUAL';
export type AmbienteDaNfse = 'homologation' | 'production';
export type SituacaoDaNfse =
  | 'ENVIANDO'
  | 'AUTORIZADA'
  | 'REJEITADA'
  | 'SEM_RESPOSTA'
  | 'REGISTRADA'
  | 'CANCELADA';

export interface ConfiguracaoDaNfse {
  companyId: string;
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  serviceCode: string | null;
  municipalServiceCode: string | null;
  nbsCode: string | null;
  serviceDescription: string | null;
  issRate: string | null;
  simplesOption: string | null;
  simplesRegime: string | null;
  specialRegime: string;
  issWithholding: string;
  dpsSeries: string;
  nextDpsNumber: number;
  municipalityConfirmedAt: string | null;
  municipalityConfirmedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type PatchDaNfse = Partial<
  Pick<
    ConfiguracaoDaNfse,
    | 'mode'
    | 'environment'
    | 'serviceCode'
    | 'municipalServiceCode'
    | 'nbsCode'
    | 'serviceDescription'
    | 'issRate'
    | 'simplesOption'
    | 'simplesRegime'
    | 'specialRegime'
    | 'issWithholding'
    | 'dpsSeries'
    | 'nextDpsNumber'
  >
> & { municipalityConfirmed?: boolean };

export type DonoDaPendencia = 'dono' | 'gerente' | 'contador' | 'prefeitura';

export interface ItemDaProntidaoNfse {
  key: string;
  label: string;
  status: 'OK' | 'FAIL' | 'INFO';
  detail: string;
  owner: DonoDaPendencia;
}

export interface ProntidaoDaNfse {
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  canEmit: boolean;
  items: ItemDaProntidaoNfse[];
}

export interface DocumentoDaNfse {
  id: string;
  saleId: string;
  serviceOrderId: string | null;
  origin: 'EMISSOR_NACIONAL' | 'REGISTRO_MANUAL';
  environment: AmbienteDaNfse;
  status: SituacaoDaNfse;
  serviceCents: number;
  description: string;
  takerDocument: string | null;
  takerName: string | null;
  dpsSeries: string | null;
  dpsNumber: number | null;
  dpsId: string | null;
  accessKey: string | null;
  nfseNumber: string | null;
  verificationCode: string | null;
  reason: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AcaoDaNfse = 'EMITIR' | 'REGISTRAR' | 'NENHUMA';

export interface ProntidaoDaNfseDaVenda {
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  /** O gesto que a tela oferece: emitir pela Sefin, registrar a do portal, ou nada. */
  action: AcaoDaNfse;
  canEmit: boolean;
  serviceCents: number;
  description: string;
  reasons: string[];
  document: DocumentoDaNfse | null;
}

export interface RegistroDaNfseDoPortal {
  numero: string;
  codigoVerificacao?: string | null;
  chaveAcesso?: string | null;
  emitidaEm: string;
}

export const nfseApi = {
  config: () => apiRequest<ConfiguracaoDaNfse>('/core/fiscal/nfse/config'),

  /** Só a gerência grava — e a troca fica na trilha de auditoria. */
  gravarConfig: (patch: PatchDaNfse) =>
    apiRequest<ConfiguracaoDaNfse>('/core/fiscal/nfse/config', { method: 'PATCH', body: patch }),

  prontidao: () => apiRequest<ProntidaoDaNfse>('/core/fiscal/nfse/readiness'),

  /** A NFS-e desta venda: o gesto possível, o valor do serviço e o que falta. */
  daVenda: (saleId: string) =>
    apiRequest<ProntidaoDaNfseDaVenda>(`/core/fiscal/sales/${encodeURIComponent(saleId)}/nfse`),

  emitir: (saleId: string) =>
    apiRequest<DocumentoDaNfse>(`/core/fiscal/sales/${encodeURIComponent(saleId)}/nfse`, {
      method: 'POST',
      body: {},
    }),

  registrar: (saleId: string, dados: RegistroDaNfseDoPortal) =>
    apiRequest<DocumentoDaNfse>(`/core/fiscal/sales/${encodeURIComponent(saleId)}/nfse/manual`, {
      method: 'POST',
      body: dados,
    }),

  registrarCancelamento: (documentId: string, motivo: string) =>
    apiRequest<DocumentoDaNfse>(`/core/fiscal/nfse/${encodeURIComponent(documentId)}/cancel-record`, {
      method: 'POST',
      body: { motivo },
    }),
};

/** O rótulo de cada modo, igual na configuração e na OS. */
export const ROTULO_DO_MODO_DA_NFSE: Record<ModoDaNfse, string> = {
  DESLIGADA: 'Desligada',
  EMISSOR_NACIONAL: 'Emissor Nacional (o sistema envia)',
  REGISTRO_MANUAL: 'Registro manual (emitida no portal)',
};

/** O rótulo da situação da NFS-e, para o selo. */
export const ROTULO_DA_SITUACAO_DA_NFSE: Record<SituacaoDaNfse, string> = {
  ENVIANDO: 'Enviando',
  AUTORIZADA: 'Autorizada',
  REJEITADA: 'Recusada',
  SEM_RESPOSTA: 'Sem resposta da Sefin',
  REGISTRADA: 'Registrada',
  CANCELADA: 'Cancelada',
};
