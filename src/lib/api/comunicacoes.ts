/**
 * O que falta para as comunicações da empresa funcionarem (GAP-PRD-130).
 *
 * Cliente da rota `GET /core/comunicacoes/prontidao`: SMTP, fila parada,
 * remetente, destinatário e agenda do contador, usuário do contador e caixa de
 * NF-e por e-mail — cada item com a situação, o que fazer, quem fornece e onde.
 */
import { apiRequest, exigirCampos } from './client';

export type SituacaoDoItem = 'ok' | 'falta' | 'opcional';

export interface ItemDaProntidao {
  chave: string;
  rotulo: string;
  situacao: SituacaoDoItem;
  detalhe: string;
  oQueFazer: string | null;
  quem: 'dono' | 'gerente' | 'contador' | null;
  onde: { rotulo: string; caminho: string | null } | null;
}

export interface ProntidaoDasComunicacoes {
  companyId: string;
  pronto: boolean;
  faltam: number;
  itens: ItemDaProntidao[];
}

export const comunicacoesApi = {
  prontidao: () =>
    apiRequest<ProntidaoDasComunicacoes>('/core/comunicacoes/prontidao').then((r) =>
      exigirCampos(r, 'pronto', 'faltam', 'itens'),
    ),
};
