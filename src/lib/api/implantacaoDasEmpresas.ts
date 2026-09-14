/**
 * Implantação de cada empresa (GAP-PRD-067) — o cliente das rotas
 * `/system/implantacao/empresas`.
 *
 * O servidor junta, por empresa, o que cada domínio já responde (fiscal,
 * certificado, impressão, maquininha, Asaas, loja online, entrega, contador,
 * equipe, oficina) e o que é do grupo (SMTP, central, backup, versão do banco),
 * num vocabulário só. O que se grava daqui é o que gente decide: "confirmo que
 * está certo" e "não se aplica a esta empresa", com motivo.
 */
import { apiRequest, exigirCampos } from './client';

export type EstadoDeImplantacao =
  | 'PRONTO'
  | 'AUTO_DETECTADO'
  | 'CONFIRMADO'
  | 'PENDENTE'
  | 'DIVERGENTE'
  | 'NAO_APLICAVEL'
  | 'BLOQUEADO_EXTERNAMENTE';

export type SituacaoDaEmpresa = 'PRONTA' | 'PRONTA_COM_PENDENCIA_EXTERNA' | 'PENDENTE';

export type DonoDoItem = 'gestor' | 'dono' | 'contador' | 'sefaz' | 'externo';

export interface MarcaDoItem {
  tipo: 'CONFIRMADO' | 'NAO_APLICAVEL';
  motivo: string | null;
  porId: string | null;
  porNome: string | null;
  em: string;
}

export interface ItemDeImplantacao {
  chave: string;
  titulo: string;
  estado: EstadoDeImplantacao;
  detalhe: string;
  dono: DonoDoItem;
  onde: string | null;
  global: boolean;
  podeConfirmar: boolean;
  podeMarcarNaoAplicavel: boolean;
  marca: MarcaDoItem | null;
  falhaDeLeitura: boolean;
}

export interface ImplantacaoDaEmpresa {
  empresa: { id: string; slug: string; nome: string; razaoSocial: string; tipo: string; ativa: boolean };
  avaliadoEm: string;
  situacao: SituacaoDaEmpresa;
  resumo: Record<EstadoDeImplantacao, number>;
  areas: Array<{ area: string; titulo: string; itens: ItemDeImplantacao[] }>;
}

export interface ResumoDaEmpresa {
  empresaId: string;
  situacao: SituacaoDaEmpresa;
  resumo: Record<EstadoDeImplantacao, number>;
}

export async function resumoDaImplantacao(): Promise<ResumoDaEmpresa[]> {
  const corpo = await apiRequest<{ items: ResumoDaEmpresa[] }>('/system/implantacao/empresas');
  return exigirCampos(corpo, 'items').items;
}

export async function implantacaoDaEmpresa(companyId: string): Promise<ImplantacaoDaEmpresa> {
  const corpo = await apiRequest<ImplantacaoDaEmpresa>(
    `/system/implantacao/empresas/${encodeURIComponent(companyId)}`,
  );
  return exigirCampos(corpo, 'empresa', 'situacao', 'resumo', 'areas');
}

export async function marcarItemDaImplantacao(
  companyId: string,
  item: string,
  marca: { tipo: 'CONFIRMADO' } | { tipo: 'NAO_APLICAVEL'; motivo: string },
): Promise<ItemDeImplantacao> {
  const corpo = await apiRequest<{ item: ItemDeImplantacao }>(
    `/system/implantacao/empresas/${encodeURIComponent(companyId)}/itens/${encodeURIComponent(item)}/marca`,
    { method: 'PUT', body: marca },
  );
  return exigirCampos(corpo, 'item').item;
}

export async function desmarcarItemDaImplantacao(companyId: string, item: string): Promise<ItemDeImplantacao> {
  const corpo = await apiRequest<{ removida: boolean; item: ItemDeImplantacao }>(
    `/system/implantacao/empresas/${encodeURIComponent(companyId)}/itens/${encodeURIComponent(item)}/marca`,
    { method: 'DELETE' },
  );
  return exigirCampos(corpo, 'item').item;
}
