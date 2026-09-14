/**
 * O cliente HTTP do Melhor Envio — sandbox E produção (GAP-PRD-030).
 *
 * O ADAPTER SÓ CONHECIA O SANDBOX. As duas funções que falavam com o Melhor
 * Envio liam `LOGISTICS_MELHOR_ENVIO_SANDBOX_URL` e mais nada: não havia
 * endereço de produção no código. Quem colasse o token de produção teria a
 * chamada feita contra o sandbox — onde aquele token não existe — e a loja
 * ficaria sem frete sem entender por quê.
 *
 * Aqui o endereço sai do AMBIENTE DA CREDENCIAL, e de nenhum outro lugar:
 *
 *   sandbox    → LOGISTICS_MELHOR_ENVIO_SANDBOX_URL    (padrão sandbox.melhorenvio.com.br)
 *   production → LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL (padrão melhorenvio.com.br)
 *
 * Os dois padrões são os endereços públicos do provedor; a variável existe
 * para quem precisar apontar para um proxy, não para "ligar" nada.
 *
 * O QUE O MELHOR ENVIO DEVOLVE, E O QUE DISSO VIRA PREÇO
 *
 * A cotação responde uma lista de serviços. Serviço que não atende o trecho
 * vem SEM preço e com o campo `error` — e o mapeamento antigo transformava o
 * preço ausente em `0`, ou seja, em frete grátis oferecido ao cliente. Agora
 * serviço com `error`, sem preço ou com preço não positivo simplesmente não
 * entra na lista.
 *
 * `custom_price` e `custom_delivery_time` são o preço e o prazo com os ajustes
 * que a própria conta configurou no painel do Melhor Envio (taxa adicional,
 * dias de manuseio). É o valor que a loja decidiu cobrar; o preço de tabela
 * (`price`) só vale quando a conta não personalizou nada.
 */
import { loadEnv } from '../../config/env.js';

export type MelhorEnvioAmbiente = 'sandbox' | 'production';

export interface MelhorEnvioPacote {
  originZipCode: string;
  destinationZipCode: string;
  weightGrams: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  declaredValueInCents: number;
}

export interface MelhorEnvioServico {
  serviceCode: string;
  serviceName: string;
  priceInCents: number;
  estimatedDays: number | null;
}

/** Falha do provedor, com um código estável e uma frase que o gestor entende. */
export class MelhorEnvioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MelhorEnvioError';
  }
}

/** Quanto o checkout espera o provedor antes de cair na tabela da loja. */
const TEMPO_DA_COTACAO_MS = 15_000;
const TEMPO_DA_CONEXAO_MS = 15_000;

const URL_PADRAO: Record<MelhorEnvioAmbiente, string> = {
  production: 'https://melhorenvio.com.br',
  sandbox: 'https://sandbox.melhorenvio.com.br',
};

/**
 * O endereço do ambiente. Variável VAZIA cai no padrão: o
 * `.env.production.example` traz `LOGISTICS_MELHOR_ENVIO_SANDBOX_URL=` em
 * branco, e o `default` do schema só vale para variável ausente — sem esta
 * guarda, copiar o exemplo produziria `fetch('/api/v2/me')`, uma URL que nem
 * chega à rede.
 */
export function melhorEnvioBaseUrl(ambiente: MelhorEnvioAmbiente): string {
  const env = loadEnv();
  const configurada =
    ambiente === 'production'
      ? env.LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL
      : env.LOGISTICS_MELHOR_ENVIO_SANDBOX_URL;
  const url = String(configurada ?? '').trim() || URL_PADRAO[ambiente];
  return url.replace(/\/+$/, '');
}

/**
 * O Melhor Envio pede que a aplicação se identifique no `User-Agent`, com um
 * e-mail de contato técnico. O e-mail é da operação (informado na tela junto
 * do token); sem ele, a aplicação se identifica só pelo nome.
 */
export function cabecalhos(token: string, contato?: string | null): Record<string, string> {
  const email = String(contato ?? '').trim();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': email ? `DEVORA ERP (${email})` : 'DEVORA ERP',
  };
}

export function nomeDoAmbiente(ambiente: MelhorEnvioAmbiente): string {
  return ambiente === 'production' ? 'produção' : 'sandbox';
}

function erroDeStatus(status: number, ambiente: MelhorEnvioAmbiente): MelhorEnvioError {
  if (status === 401 || status === 403) {
    return new MelhorEnvioError(
      'TOKEN_RECUSADO',
      `O Melhor Envio recusou o token (HTTP ${status}). Confira se é um token de `
        + `${nomeDoAmbiente(ambiente)} válido, não vencido e com permissão de cotação — `
        + 'token de sandbox não abre a produção, e o de produção não abre o sandbox.',
      status,
    );
  }
  if (status === 422 || status === 400) {
    return new MelhorEnvioError(
      'DADOS_RECUSADOS',
      `O Melhor Envio recusou os dados do pacote (HTTP ${status}). Confira CEPs, peso e medidas.`,
      status,
    );
  }
  if (status === 429) {
    return new MelhorEnvioError(
      'LIMITE_DE_REQUISICOES',
      'O Melhor Envio limitou as requisições desta conta (HTTP 429). Tente de novo em instantes.',
      status,
    );
  }
  if (status >= 500) {
    return new MelhorEnvioError(
      'PROVEDOR_INDISPONIVEL',
      `O Melhor Envio está fora do ar ou com erro interno (HTTP ${status}).`,
      status,
    );
  }
  return new MelhorEnvioError('HTTP_INESPERADO', `O Melhor Envio respondeu HTTP ${status}.`, status);
}

async function chamar(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  ambiente: MelhorEnvioAmbiente,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const nome = err instanceof Error ? err.name : '';
    if (nome === 'TimeoutError' || nome === 'AbortError') {
      throw new MelhorEnvioError(
        'SEM_RESPOSTA',
        `O Melhor Envio (${nomeDoAmbiente(ambiente)}) não respondeu em ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    throw new MelhorEnvioError(
      'SEM_CONEXAO',
      `Não foi possível falar com o Melhor Envio (${nomeDoAmbiente(ambiente)}): `
        + `${err instanceof Error ? err.message : 'falha de rede'}.`,
    );
  }
  if (!res.ok) throw erroDeStatus(res.status, ambiente);
  return res;
}

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** Converte a resposta do provedor, descartando o que não é preço. */
export function servicosCotados(dados: unknown): MelhorEnvioServico[] {
  if (!Array.isArray(dados)) return [];
  const servicos: MelhorEnvioServico[] = [];
  dados.forEach((bruto, i) => {
    if (!bruto || typeof bruto !== 'object') return;
    const item = bruto as Record<string, unknown>;
    // Trecho não atendido, serviço suspenso, dimensão acima do limite: o
    // provedor manda o motivo em `error` e nenhum preço.
    if (item.error) return;
    const preco = numero(item.custom_price) ?? numero(item.price);
    if (preco === null || preco <= 0) return;
    const prazo = numero(item.custom_delivery_time) ?? numero(item.delivery_time);
    const empresa = item.company as Record<string, unknown> | undefined;
    const servico = String(item.name ?? '').trim();
    const transportadora = String(empresa?.name ?? '').trim();
    servicos.push({
      serviceCode: String(item.id ?? `me-${i}`),
      // "PAC" sozinho não diz de quem é; "Correios PAC" diz.
      serviceName: [transportadora, servico].filter(Boolean).join(' ') || 'Melhor Envio',
      priceInCents: Math.round(preco * 100),
      estimatedDays: prazo !== null && prazo >= 0 ? prazo : null,
    });
  });
  return servicos;
}

export async function cotarMelhorEnvio(input: {
  token: string;
  ambiente: MelhorEnvioAmbiente;
  contato?: string | null;
  pacote: MelhorEnvioPacote;
}): Promise<MelhorEnvioServico[]> {
  const { pacote } = input;
  const corpo = {
    from: { postal_code: pacote.originZipCode.replace(/\D/g, '') },
    to: { postal_code: pacote.destinationZipCode.replace(/\D/g, '') },
    products: [
      {
        id: 'devora-pacote',
        width: pacote.widthCm,
        height: pacote.heightCm,
        length: pacote.lengthCm,
        // O Melhor Envio mede peso em quilos e seguro em reais.
        weight: pacote.weightGrams / 1000,
        insurance_value: pacote.declaredValueInCents / 100,
        quantity: 1,
      },
    ],
  };
  const res = await chamar(
    `${melhorEnvioBaseUrl(input.ambiente)}/api/v2/me/shipment/calculate`,
    { method: 'POST', headers: cabecalhos(input.token, input.contato), body: JSON.stringify(corpo) },
    TEMPO_DA_COTACAO_MS,
    input.ambiente,
  );
  let dados: unknown;
  try {
    dados = await res.json();
  } catch {
    throw new MelhorEnvioError('RESPOSTA_ILEGIVEL', 'O Melhor Envio respondeu algo que não é JSON.');
  }
  return servicosCotados(dados);
}

/**
 * Confere o token contra `/api/v2/me` — a chamada mais barata que prova que o
 * token abre a conta, sem cotar nem comprar nada.
 */
export async function conferirContaMelhorEnvio(input: {
  token: string;
  ambiente: MelhorEnvioAmbiente;
  contato?: string | null;
}): Promise<{ conta: string | null }> {
  const res = await chamar(
    `${melhorEnvioBaseUrl(input.ambiente)}/api/v2/me`,
    { method: 'GET', headers: cabecalhos(input.token, input.contato) },
    TEMPO_DA_CONEXAO_MS,
    input.ambiente,
  );
  try {
    const me = (await res.json()) as Record<string, unknown>;
    // Só o nome: é o que basta para o gestor ver que colou o token da conta
    // certa. E-mail e documento da conta não saem daqui.
    const nome = [me.firstname, me.lastname].map((p) => String(p ?? '').trim()).filter(Boolean).join(' ');
    return { conta: nome || null };
  } catch {
    return { conta: null };
  }
}
