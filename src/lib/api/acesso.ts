/**
 * O acesso de cada pessoa por EMPRESA, PDV (caixa) e PÁGINA/MÓDULO — o que a
 * tela de Usuários lê e grava em `/acesso` (servidor: `routes/v1/acesso.ts`).
 *
 * A tela só monta o pedido; quem decide o que pode ser dado, por quem e onde, é
 * o servidor — e ele devolve o retrato já gravado, que a tela passa a mostrar.
 */
import { apiRequest } from './client';

export interface CapabilityDoCatalogo {
  code: string;
  rotulo: string;
  pagina: string;
  escopo: string;
}

export interface AreaDoCatalogo {
  area: string;
  capabilities: CapabilityDoCatalogo[];
}

export interface ModeloDoCatalogo {
  code: string;
  nome: string;
  descricao: string;
  /** Modelo de dono do grupo — só quem administra o grupo entrega. */
  doGrupo: boolean;
  /** Atalho de cenário (Somente PDV, PDV + Painel, Estoque…). */
  atalho: boolean;
  capabilities: string[];
}

export interface CaixaDaEmpresa {
  id: string;
  nome: string;
  codigo: string;
}

export interface AcessoNaEmpresa {
  companyId: string;
  slug: string;
  tradeName: string;
  vinculado: boolean;
  modelo: { code: string; name: string; personalizado: boolean } | null;
  capabilities: string[];
  terminais: 'todos' | string[];
  caixas: CaixaDaEmpresa[];
  /** Quem está na tela administra os usuários desta empresa. */
  podeEditar: boolean;
}

export interface AcessoDoUsuario {
  usuario: { id: string; login: string; displayName: string; active: boolean };
  empresas: AcessoNaEmpresa[];
}

export interface MudancaNaEmpresa {
  companyId: string;
  vinculado: boolean;
  modelo?: string;
  capabilities?: string[];
  terminais?: 'todos' | string[];
}

export const acessoApi = {
  catalogo: () => apiRequest<{ areas: AreaDoCatalogo[]; modelos: ModeloDoCatalogo[] }>('/acesso/catalogo'),

  doUsuario: (userId: string) =>
    apiRequest<AcessoDoUsuario>(`/acesso/usuarios/${encodeURIComponent(userId)}`),

  salvar: (userId: string, empresas: MudancaNaEmpresa[]) =>
    apiRequest<AcessoDoUsuario>(`/acesso/usuarios/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: { empresas },
    }),
};
