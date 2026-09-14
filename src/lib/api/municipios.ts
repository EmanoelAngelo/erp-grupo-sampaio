/**
 * Os municípios do IBGE (IBGE-MUNICIPIOS): o formulário do endereço acha a
 * cidade pelo NOME e leva o código IBGE junto — o cliente nunca digita o
 * código. A rota é pública (a vitrine pergunta antes de haver conta), e o ERP
 * usa a mesma no cadastro fiscal do emitente.
 *
 * `carregada` diz se a tabela oficial já foi carregada pelo dono (comando
 * `carregar-municipios-ibge`). Sem ela, as telas voltam ao campo digitado.
 */
import { apiRequest } from '@/lib/api/client';

export interface MunicipioDoIbge {
  codigo: string;
  nome: string;
  uf: string;
}

export interface BuscaDeMunicipios {
  carregada: boolean;
  total: number;
  itens: MunicipioDoIbge[];
}

/** As 27 UFs, na ordem alfabética da sigla. */
export const UFS: readonly string[] = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

/** Como o servidor compara: sem acento, minúsculo, pontuação vira espaço. */
export function normalizarNome(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const municipiosApi = {
  /** A tabela está carregada? (a mesma rota, sem busca) */
  situacao: (signal?: AbortSignal) =>
    apiRequest<BuscaDeMunicipios>('/loja/municipios', { anonymous: true, signal }),
  /** Até 20 municípios cujo nome contém o texto, dentro da UF (se dada). */
  buscar: (uf: string, texto: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (uf) params.set('uf', uf);
    params.set('q', texto);
    return apiRequest<BuscaDeMunicipios>(`/loja/municipios?${params.toString()}`, { anonymous: true, signal });
  },
};
