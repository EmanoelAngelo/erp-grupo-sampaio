/**
 * Conferência da implantação (GAP-PRD-013) — o cliente da rota
 * `GET /system/implantacao`.
 *
 * O servidor olha a própria configuração e responde, item por item, se esta
 * instalação está publicada como produção deve estar: ambiente, variável
 * aposentada do acesso sem senha, chaves, HTTPS, proxy, quem serve as telas, quem levanta a API quando ela cai,
 * onde ficam banco, fotos e backup. Nomes de variável, nunca valores.
 */
import { apiRequest, exigirCampos } from './client';

export type EstadoDaImplantacao = 'OK' | 'INFO' | 'ATENCAO' | 'BLOQUEIA';

export interface ItemDaImplantacao {
  id: string;
  titulo: string;
  estado: EstadoDaImplantacao;
  detalhe: string;
  comoResolver?: string;
}

export interface ConferenciaDaImplantacao {
  conferidoEm: string;
  pronto: boolean;
  resumo: Record<EstadoDaImplantacao, number>;
  itens: ItemDaImplantacao[];
}

export async function conferirImplantacao(): Promise<ConferenciaDaImplantacao> {
  const corpo = await apiRequest<ConferenciaDaImplantacao>('/system/implantacao');
  return exigirCampos(corpo, 'conferidoEm', 'pronto', 'resumo', 'itens');
}
