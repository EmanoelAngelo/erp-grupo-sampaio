/**
 * QUEM LEVA A ENCOMENDA, E ONDE O CLIENTE A ACOMPANHA (GAP-PRD-119).
 *
 * O portal e o ERP mostravam só o código digitado no despacho — texto solto,
 * sem transportadora. O cliente recebia "BR123456789BR" e tinha de adivinhar
 * em que site procurar; o e-mail de "seu pedido está a caminho" ia sem link.
 *
 * Aqui mora a ÚNICA tabela de transportadoras do despacho, com o nome que o
 * cliente lê e a página pública de rastreio de cada uma. É módulo puro (sem
 * banco, sem rede): o e-mail, o portal, a lista de pedidos e o envio usam a
 * mesma função, e o link não pode divergir entre eles.
 *
 * AS PÁGINAS SÃO PÚBLICAS E NÃO PEDEM CREDENCIAL. O link abre a situação
 * direto na transportadora — é o que o cliente consulta mesmo quando a nossa
 * sincronização com o provedor falhou.
 *
 *   correios      → rastreamento.correios.com.br (a página oficial)
 *   melhor_envio  → melhorrastreio.com.br, o rastreio público do Melhor Envio,
 *                   que aceita o código de qualquer transportadora que ele
 *                   intermedia (Correios, Jadlog, Loggi, Azul...)
 *   jadlog        → também pelo melhorrastreio.com.br: a Jadlog não publica
 *                   uma URL de consulta estável por código, e um link que abre
 *                   um formulário vazio seria pior que link nenhum
 *   generic       → sem link: "outra transportadora" não diz qual site é
 *   propria       → sem link: a entrega é da própria loja
 */

export const TRANSPORTADORAS_DO_DESPACHO = ['correios', 'jadlog', 'melhor_envio', 'generic', 'propria'] as const;

export type TransportadoraDoDespacho = (typeof TRANSPORTADORAS_DO_DESPACHO)[number];

export function isTransportadoraDoDespacho(valor: unknown): valor is TransportadoraDoDespacho {
  return typeof valor === 'string' && (TRANSPORTADORAS_DO_DESPACHO as readonly string[]).includes(valor);
}

export const NOME_DA_TRANSPORTADORA: Record<TransportadoraDoDespacho, string> = {
  correios: 'Correios',
  jadlog: 'Jadlog',
  melhor_envio: 'Melhor Envio',
  generic: 'Transportadora',
  propria: 'Entrega da loja',
};

/** O nome para gente. Transportadora desconhecida (dado antigo) sai como veio. */
export function nomeDaTransportadora(carrier: string | null | undefined): string | null {
  if (!carrier) return null;
  return isTransportadoraDoDespacho(carrier) ? NOME_DA_TRANSPORTADORA[carrier] : carrier;
}

/** O código dos Correios tem forma fixa: duas letras, nove números, duas letras. */
export const CODIGO_DOS_CORREIOS = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

/** Código de rastreio normalizado: sem espaço, em maiúsculas. */
export function normalizarCodigo(codigo: string | null | undefined): string | null {
  const limpo = String(codigo ?? '').replace(/\s+/g, '').toUpperCase();
  return limpo || null;
}

/**
 * A página pública onde este código é acompanhado, ou `null` quando não há
 * página a indicar. Nunca inventa: sem transportadora conhecida, sem link.
 */
export function linkDeRastreio(
  carrier: string | null | undefined,
  codigo: string | null | undefined,
): string | null {
  const c = normalizarCodigo(codigo);
  if (!c || !carrier) return null;
  const alvo = encodeURIComponent(c);
  switch (carrier) {
    case 'correios':
      return `https://rastreamento.correios.com.br/app/index.php?objetos=${alvo}`;
    case 'melhor_envio':
    case 'jadlog':
      return `https://www.melhorrastreio.com.br/rastreio/${alvo}`;
    default:
      return null;
  }
}
