/**
 * Os endereços da conta do cliente (GAP-PRD-115): listar, criar, EDITAR,
 * tornar padrão e remover — e para que cada um serve.
 *
 * Módulo próprio porque três telas falam disso (Minha conta, o checkout da
 * vitrine e o formulário que as duas usam), e o formato precisa ser um só.
 * Toda chamada leva o token do PORTAL (`x-portal-token`), nunca o Bearer do
 * ERP.
 */
import { comTokenPortal } from '@/lib/portalSession';

/**
 * 'ambos' é o caso comum (a casa da pessoa). Faturar exige o código IBGE do
 * município: sem ele o servidor só aceita 'entrega'.
 */
export type TipoDeEndereco = 'entrega' | 'faturamento' | 'ambos';

export const ROTULO_DO_TIPO: Record<TipoDeEndereco, string> = {
  ambos: 'Entrega e nota fiscal',
  entrega: 'Só entrega',
  faturamento: 'Só nota fiscal',
};

export interface EnderecoDaConta {
  id: string;
  label: string | null;
  zip: string;
  street: string;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  /** Código IBGE do município. A NF-e identifica o município por ele. */
  cityIbge: string | null;
  isDefault: boolean;
  /** Ausentes em servidor anterior ao GAP-PRD-115: tratar como 'ambos'. */
  kind?: TipoDeEndereco;
  recipientName?: string | null;
  usableForShipping?: boolean;
  usableForBilling?: boolean;
}

/** O que o formulário manda. Vazio = não informado. */
export interface DadosDoEndereco {
  label: string;
  recipientName: string;
  zip: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  cityIbge: string;
  /** '' = o servidor decide pelo IBGE ('ambos' com IBGE, 'entrega' sem). */
  kind: TipoDeEndereco | '';
}

export const ENDERECO_VAZIO: DadosDoEndereco = {
  label: '',
  recipientName: '',
  zip: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
  cityIbge: '',
  kind: '',
};

export function paraFormulario(e: EnderecoDaConta): DadosDoEndereco {
  return {
    label: e.label ?? '',
    recipientName: e.recipientName ?? '',
    zip: e.zip,
    street: e.street,
    number: e.number ?? '',
    complement: e.complement ?? '',
    district: e.district ?? '',
    city: e.city,
    state: e.state,
    cityIbge: e.cityIbge ?? '',
    kind: e.kind ?? '',
  };
}

/** Serve para entregar? (servidor antigo, sem o campo: sim) */
export function serveParaEntrega(e: EnderecoDaConta): boolean {
  return e.usableForShipping ?? e.kind !== 'faturamento';
}

/** Serve para a nota? (servidor antigo, sem o campo: só com IBGE) */
export function serveParaFaturamento(e: EnderecoDaConta): boolean {
  return e.usableForBilling ?? (e.kind ? e.kind !== 'entrega' : Boolean(e.cityIbge));
}

/** Como cada campo que falta é dito na tela — as mesmas palavras do servidor. */
const CAMPO_DA_ENTREGA: Record<string, string> = {
  rua: 'a rua',
  numero: 'o número (ou "S/N")',
  bairro: 'o bairro',
  cidade: 'a cidade',
  uf: 'a UF',
  cep: 'o CEP',
  ibge: 'o código IBGE do município',
};

function digitos(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\D/g, '');
}

/**
 * O que falta para o endereço RECEBER um pedido (GAP-PRD-028, reauditoria).
 *
 * A mesma regra do servidor (`CheckoutIdentityService.faltaParaEntregar`):
 * rua, número, bairro, cidade, UF, CEP e o código IBGE do município. Quem
 * recebe nunca falta — sem destinatário, recebe quem compra. A tela avisa
 * antes do clique; o servidor recusa com 422 CHECKOUT_ENDERECO_INCOMPLETO.
 */
export function faltaParaEntregar(e: EnderecoDaConta): string[] {
  const falta: string[] = [];
  if (!e.street?.trim()) falta.push('rua');
  if (!e.number?.trim()) falta.push('numero');
  if (!e.district?.trim()) falta.push('bairro');
  if (!e.city?.trim()) falta.push('cidade');
  if (!e.state?.trim()) falta.push('uf');
  if (digitos(e.zip).length !== 8) falta.push('cep');
  if (digitos(e.cityIbge).length !== 7) falta.push('ibge');
  return falta;
}

/** "o número (ou "S/N") e o bairro" — a lista do que falta, em frase. */
export function descreverFalta(faltando: string[]): string {
  const partes = faltando.map((c) => CAMPO_DA_ENTREGA[c] ?? c);
  if (partes.length <= 1) return partes.join('');
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

function corpo(d: DadosDoEndereco): Record<string, string | undefined> {
  return { ...d, kind: d.kind || undefined };
}

export const enderecosApi = {
  listar: (token: string) =>
    comTokenPortal<{ items: EnderecoDaConta[] }>('/loja/portal/enderecos', token).then((r) =>
      Array.isArray(r.items) ? r.items : [],
    ),
  criar: (token: string, dados: DadosDoEndereco) =>
    comTokenPortal<EnderecoDaConta>('/loja/portal/enderecos', token, {
      method: 'POST',
      body: corpo(dados),
    }),
  editar: (token: string, id: string, dados: DadosDoEndereco) =>
    comTokenPortal<EnderecoDaConta>(`/loja/portal/enderecos/${encodeURIComponent(id)}`, token, {
      method: 'PUT',
      body: corpo(dados),
    }),
};
