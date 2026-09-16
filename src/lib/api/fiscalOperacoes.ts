/**
 * AS OPERAÇÕES FISCAIS E AS PENDÊNCIAS CONTÁBEIS NA TELA (P0 fiscal).
 *
 * ## O defeito que este arquivo fecha
 *
 * O servidor já tinha as três portas — `GET /core/fiscal/operacoes`,
 * `PUT /core/fiscal/operacoes/:operacao` e `GET /core/fiscal/pendencias-contabeis`
 * — e NENHUMA tela as chamava. As mensagens do sistema mandavam o gestor para
 * "Fiscal › Operações fiscais" e "Fiscal › Pendências contábeis": dois lugares
 * que não existiam no navegador. Quem recebesse
 * `CORE_FISCAL_OPERATION_NOT_CONFIRMED` (a devolução recusada em produção) ou o
 * cancelamento sem prazo informado ficava sem caminho — e o prazo de
 * cancelamento, a natureza da operação e o CFOP da devolução só podiam ser
 * gravados por `curl`.
 *
 * ## Quem grava o quê
 *
 * Ler é `fiscal.view` (a gerência). Gravar é `fiscal.policy.manage` — a mesma
 * régua da política de contingência, porque é o que libera a devolução em
 * produção.
 */
import { apiRequest, exigirCampos } from './client';

export type OperacaoFiscal = 'venda_nfce' | 'venda_nfe' | 'devolucao_venda' | 'devolucao_compra';

export const OPERACOES_FISCAIS: readonly OperacaoFiscal[] = [
  'venda_nfce',
  'venda_nfe',
  'devolucao_venda',
  'devolucao_compra',
];

/** Teto do prazo de cancelamento que o servidor aceita: 30 dias em minutos. */
export const PRAZO_DE_CANCELAMENTO_MAXIMO_MIN = 30 * 24 * 60;

export interface ParametrosDaOperacao {
  operacao: OperacaoFiscal;
  rotulo: string;
  direcao: 'saida' | 'entrada';
  natOp: string;
  cfopInterno: string | null;
  cfopInterestadual: string | null;
  grupoTributario: string | null;
  /** Nulo: nenhum prazo informado — a SEFAZ decide, e é pendência contábil. */
  prazoCancelamentoMinutos: number | null;
  confirmadaPeloContador: boolean;
  origem: 'cadastro' | 'padrao';
  observacao: string | null;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  pendencias: string[];
}

export interface PendenciaContabil {
  chave: string;
  tema: string;
  descricao: string;
  /** 'emissao': a venda é recusada hoje. 'producao': sai em homologação, não em produção. */
  impede: 'emissao' | 'producao' | 'nada';
  onde: string;
}

/**
 * A tela percorre `pendencias` e `rotulo` de cada operação. Um 200 sem eles
 * viraria `undefined.map` dentro do render — o `exigirCampos` transforma isso
 * em erro legível ANTES de a tela tentar desenhar.
 */
function operacaoConferida(o: ParametrosDaOperacao): ParametrosDaOperacao {
  return exigirCampos(o, 'operacao', 'rotulo', 'natOp', 'pendencias', 'origem');
}

export interface GravarOperacaoInput {
  natOp?: string | null;
  /** Só a devolução: na venda, o CFOP mora no grupo tributário do produto. */
  cfopInterno?: string | null;
  cfopInterestadual?: string | null;
  grupoTributario?: string | null;
  prazoCancelamentoMinutos?: number | null;
  confirmadaPeloContador?: boolean;
  observacao?: string | null;
}

export const fiscalOperacoesApi = {
  listar: () =>
    apiRequest<{ items: ParametrosDaOperacao[] }>('/core/fiscal/operacoes')
      .then((r) => exigirCampos(r, 'items').items.map(operacaoConferida)),

  gravar: (operacao: OperacaoFiscal, input: GravarOperacaoInput) =>
    apiRequest<ParametrosDaOperacao>(`/core/fiscal/operacoes/${encodeURIComponent(operacao)}`, {
      method: 'PUT',
      body: input,
    }).then(operacaoConferida),

  pendencias: () =>
    apiRequest<{ items: PendenciaContabil[] }>('/core/fiscal/pendencias-contabeis')
      .then((r) => exigirCampos(r, 'items').items),
};
