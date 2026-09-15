/**
 * A EMPRESA DAS PLAQUINHAS, do lado da tela (P0 das plaquinhas).
 *
 * ## O defeito
 *
 * A tela de Plaquinhas, o item do menu, o seletor de adesivo no cadastro de
 * máquina, a aba de plaquinha em Etiquetas e o vínculo em Estoque › Unidades
 * apareciam em qualquer empresa. O servidor decidia no fim — lista vazia,
 * `usaPlaquinha: false` ou 409 —, e a Preço Justo, a Oficina e as lojas de
 * roupa viam uma função que não é delas.
 *
 * ## A regra
 *
 * Plaquinha com QR e número é EXCLUSIVA da PJ Motors. A tela pergunta ao slug
 * da empresa da SESSÃO — o mesmo que o servidor exige em
 * `server/src/services/core/EmpresaDasPlaquinhas.ts` — e esconde menu, rota e
 * botões antes de fazer qualquer chamada. Isto é navegação, não autorização:
 * o servidor recusa com 403 `CORE_COMPANY_NO_TAGS` em toda rota de plaquinha,
 * e é ele que protege o dado.
 *
 * Módulo sem React de propósito: `navItems.ts` é dado lido por teste, e não
 * pode puxar o cliente HTTP para dentro do menu.
 */
export const EMPRESA_DAS_PLAQUINHAS = 'pj-motors';

/** A empresa de slug `slug` tem plaquinha? Espaço e caixa não mudam a resposta. */
export function empresaTemPlaquinha(slug: string | null | undefined): boolean {
  return String(slug ?? '').trim().toLowerCase() === EMPRESA_DAS_PLAQUINHAS;
}

/** A frase do estado "não disponível", a mesma na rota e nos cartões. */
export const PLAQUINHA_SO_NA_PJ =
  'Plaquinha com QR e número é exclusiva da PJ Motors. Nesta empresa a mercadoria é '
  + 'identificada pela etiqueta de produto, em Etiquetas · Código de barras.';
