/**
 * Os rótulos da implantação por empresa (GAP-PRD-067) — um lugar só, para a
 * lista de Empresas e o checklist de cada uma dizerem a mesma coisa.
 */
import type { EstadoDeImplantacao, SituacaoDaEmpresa } from '@/lib/api/implantacaoDasEmpresas';

export type TomDoRotulo = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export const ESTADO_NA_TELA: Record<EstadoDeImplantacao, { rotulo: string; tom: TomDoRotulo }> = {
  DIVERGENTE: { rotulo: 'DIVERGENTE', tom: 'danger' },
  PENDENTE: { rotulo: 'PENDENTE', tom: 'warning' },
  AUTO_DETECTADO: { rotulo: 'AUTO-DETECTADO', tom: 'info' },
  BLOQUEADO_EXTERNAMENTE: { rotulo: 'BLOQUEADO EXTERNAMENTE', tom: 'neutral' },
  CONFIRMADO: { rotulo: 'CONFIRMADO', tom: 'success' },
  PRONTO: { rotulo: 'PRONTO', tom: 'success' },
  NAO_APLICAVEL: { rotulo: 'N.A.', tom: 'neutral' },
};

export const SITUACAO_NA_TELA: Record<SituacaoDaEmpresa, { rotulo: string; tom: TomDoRotulo; frase: string }> = {
  PRONTA: {
    rotulo: 'PRONTA',
    tom: 'success',
    frase: 'Tudo conferido: nada pendente, divergente ou esperando alguém de fora.',
  },
  PRONTA_COM_PENDENCIA_EXTERNA: {
    rotulo: 'FALTA SÓ O QUE É DE FORA',
    tom: 'info',
    frase:
      'O que é do sistema está feito. O que resta depende de insumo externo (certificado, SEFAZ, credencial, equipamento).',
  },
  PENDENTE: {
    rotulo: 'HÁ O QUE FAZER',
    tom: 'warning',
    frase: 'Há item pendente, divergente ou esperando confirmação — cada um diz a tela que resolve.',
  },
};
