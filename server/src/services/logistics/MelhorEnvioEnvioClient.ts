/**
 * O cliente HTTP do Melhor Envio para ETIQUETA, RASTREIO e CANCELAMENTO
 * (GAP-PRD-120, GAP-PRD-119).
 *
 * A cotação mora em `MelhorEnvioClient`; aqui mora o que vem depois dela. O
 * fluxo do provedor tem quatro atos, e o sistema os trata separados porque
 * cada um pode falhar sozinho:
 *
 *   1. `POST /api/v2/me/cart`              — o envio entra no carrinho da conta
 *                                            (ainda não custou nada);
 *   2. `POST /api/v2/me/shipment/checkout` — a etiqueta é PAGA com o saldo da
 *                                            carteira do Melhor Envio;
 *   3. `POST /api/v2/me/shipment/generate` — a etiqueta é gerada (vira PDF);
 *   4. `POST /api/v2/me/shipment/print`    — o link para imprimir.
 *
 * Saldo insuficiente no passo 2 deixa o envio no carrinho: o serviço guarda o
 * estado e o gestor tenta de novo depois de pôr saldo, sem criar um segundo
 * envio no provedor.
 *
 * O rastreio (`POST /api/v2/me/shipment/tracking`) devolve, por envio, o
 * estado atual, o código da transportadora e as datas de cada marco (paga,
 * gerada, postada, entregue, cancelada). Cada data vira um evento com origem
 * "provedor".
 *
 * O ERRO DIZ O QUE O PROVEDOR DISSE. A validação do Melhor Envio responde 422
 * com a lista de campos recusados ("to.document: O campo documento é
 * obrigatório"). A mensagem sobe inteira (aparada) para a tela, porque é ela
 * que diz ao gestor o que corrigir. O token nunca entra em mensagem nenhuma.
 *
 * O ENDEREÇO SAI DO AMBIENTE DA CREDENCIAL, pelo mesmo `melhorEnvioBaseUrl` da
 * cotação: token de sandbox compra etiqueta de mentira no sandbox; token de
 * produção compra etiqueta de verdade, com dinheiro da carteira.
 */
import {
  cabecalhos,
  melhorEnvioBaseUrl,
  MelhorEnvioError,
  nomeDoAmbiente,
  type MelhorEnvioAmbiente,
} from './MelhorEnvioClient.js';

export interface ContextoMelhorEnvio {
  token: string;
  ambiente: MelhorEnvioAmbiente;
  contato?: string | null;
}

/** Remetente ou destinatário, já conferido pelo serviço. */
export interface PessoaDoEnvio {
  nome: string;
  telefone: string | null;
  email: string | null;
  /** CPF, só dígitos — pessoa física. */
  cpf: string | null;
  /** CNPJ, só dígitos — empresa. */
  cnpj: string | null;
  inscricaoEstadual: string | null;
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

export interface PedidoDeEtiqueta {
  /** O id do serviço no Melhor Envio (o `serviceCode` da cotação). */
  servico: string;
  /** Agência de postagem, exigida em serviço Jadlog. */
  agencia: string | null;
  remetente: PessoaDoEnvio;
  destinatario: PessoaDoEnvio;
  itens: { nome: string; quantidade: number; valorUnitarioCents: number }[];
  volume: { weightGrams: number; heightCm: number; widthCm: number; lengthCm: number };
  valorDeclaradoCents: number;
  /** Chave de 44 dígitos da NF-e autorizada, ou nulo com declaração de conteúdo. */
  chaveDaNota: string | null;
  declaracaoDeConteudo: boolean;
  /** Aparece no painel do Melhor Envio: "Pedido #1009 — Gringa". */
  identificacao: string;
}

export interface EnvioNoCarrinho {
  id: string;
  protocolo: string | null;
  precoCents: number | null;
  status: string | null;
}

/** O que o rastreio do Melhor Envio devolve para UM envio. */
export interface SituacaoNoMelhorEnvio {
  id: string;
  status: string | null;
  /** Código da transportadora (Correios, Jadlog...), quando já existe. */
  tracking: string | null;
  /** Código do próprio Melhor Envio. */
  melhorEnvioTracking: string | null;
  marcos: { chave: string; em: string }[];
}

const TEMPO_MS = 20_000;

/** As datas que o rastreio devolve, na ordem em que acontecem. */
const MARCOS = [
  'created_at',
  'paid_at',
  'generated_at',
  'posted_at',
  'delivered_at',
  'canceled_at',
  'expired_at',
] as const;

function digitos(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function aparar(texto: string, max = 400): string {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A frase do provedor, montada a partir do corpo de erro. O Melhor Envio usa
 * `message`, `error` e `errors` (objeto campo → lista de frases).
 */
export function motivoDoProvedor(corpo: unknown): string | null {
  if (!corpo || typeof corpo !== 'object') return typeof corpo === 'string' && corpo.trim() ? aparar(corpo) : null;
  const c = corpo as Record<string, unknown>;
  const partes: string[] = [];
  if (c.errors && typeof c.errors === 'object') {
    for (const [campo, frases] of Object.entries(c.errors as Record<string, unknown>)) {
      const lista = Array.isArray(frases) ? frases : [frases];
      partes.push(`${campo}: ${lista.map((f) => String(f)).join(' ')}`);
    }
  }
  if (partes.length === 0) {
    for (const chave of ['error', 'message']) {
      if (typeof c[chave] === 'string' && String(c[chave]).trim()) {
        partes.push(String(c[chave]));
        break;
      }
    }
  }
  return partes.length ? aparar(partes.join('; ')) : null;
}

function erroDoEnvio(status: number, ambiente: MelhorEnvioAmbiente, corpo: unknown): MelhorEnvioError {
  const motivo = motivoDoProvedor(corpo);
  const disse = motivo ? ` O provedor disse: ${motivo}` : '';
  if (status === 401 || status === 403) {
    return new MelhorEnvioError(
      'TOKEN_RECUSADO',
      `O Melhor Envio (${nomeDoAmbiente(ambiente)}) recusou o token (HTTP ${status}). Confira se o token tem `
        + 'permissão de carrinho, compra, geração, impressão e rastreio de envios.' + disse,
      status,
    );
  }
  if (status === 400 || status === 422) {
    return new MelhorEnvioError(
      'DADOS_RECUSADOS',
      `O Melhor Envio recusou o envio (HTTP ${status}).${disse || ' Confira remetente, destinatário e volume.'}`,
      status,
    );
  }
  if (status === 402) {
    return new MelhorEnvioError(
      'SALDO_INSUFICIENTE',
      `O Melhor Envio não conseguiu pagar a etiqueta (HTTP 402).${disse || ' Confira o saldo da carteira.'}`,
      status,
    );
  }
  if (status === 404) {
    return new MelhorEnvioError('ENVIO_NAO_ENCONTRADO', `O Melhor Envio não encontrou o envio (HTTP 404).${disse}`, status);
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
      `O Melhor Envio está fora do ar ou com erro interno (HTTP ${status}).${disse}`,
      status,
    );
  }
  return new MelhorEnvioError('HTTP_INESPERADO', `O Melhor Envio respondeu HTTP ${status}.${disse}`, status);
}

async function lerCorpo(res: Response): Promise<unknown> {
  const texto = await res.text().catch(() => '');
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

async function chamar(
  ctx: ContextoMelhorEnvio,
  caminho: string,
  metodo: 'GET' | 'POST' | 'DELETE',
  corpo?: unknown,
): Promise<unknown> {
  const url = `${melhorEnvioBaseUrl(ctx.ambiente)}${caminho}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: metodo,
      headers: cabecalhos(ctx.token, ctx.contato),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_MS),
    });
  } catch (err) {
    const nome = err instanceof Error ? err.name : '';
    if (nome === 'TimeoutError' || nome === 'AbortError') {
      throw new MelhorEnvioError(
        'SEM_RESPOSTA',
        `O Melhor Envio (${nomeDoAmbiente(ctx.ambiente)}) não respondeu em ${Math.round(TEMPO_MS / 1000)} s.`,
      );
    }
    throw new MelhorEnvioError(
      'SEM_CONEXAO',
      `Não foi possível falar com o Melhor Envio (${nomeDoAmbiente(ctx.ambiente)}): `
        + `${err instanceof Error ? err.message : 'falha de rede'}.`,
    );
  }
  const dados = await lerCorpo(res);
  if (!res.ok) throw erroDoEnvio(res.status, ctx.ambiente, dados);
  return dados;
}

function pessoa(p: PessoaDoEnvio): Record<string, unknown> {
  const corpo: Record<string, unknown> = {
    name: p.nome,
    address: p.logradouro,
    number: p.numero,
    district: p.bairro,
    city: p.cidade,
    state_abbr: p.uf,
    country_id: 'BR',
    postal_code: digitos(p.cep),
  };
  if (p.telefone) corpo.phone = digitos(p.telefone);
  if (p.email) corpo.email = p.email;
  if (p.complemento) corpo.complement = p.complemento;
  if (p.cpf) corpo.document = digitos(p.cpf);
  if (p.cnpj) corpo.company_document = digitos(p.cnpj);
  if (p.inscricaoEstadual) corpo.state_register = p.inscricaoEstadual;
  return corpo;
}

/** O corpo do carrinho, exposto para o teste conferir o que sai para o provedor. */
export function corpoDoCarrinho(pedido: PedidoDeEtiqueta): Record<string, unknown> {
  const opcoes: Record<string, unknown> = {
    // Valor declarado em reais: é ele que define o seguro e o ressarcimento.
    insurance_value: pedido.valorDeclaradoCents / 100,
    receipt: false,
    own_hand: false,
    reverse: false,
    non_commercial: pedido.declaracaoDeConteudo,
    platform: 'DEVORA ERP',
    tags: [{ tag: pedido.identificacao, url: null }],
  };
  if (pedido.chaveDaNota) opcoes.invoice = { key: pedido.chaveDaNota };

  const corpo: Record<string, unknown> = {
    service: Number(pedido.servico),
    from: pessoa(pedido.remetente),
    to: pessoa(pedido.destinatario),
    products: pedido.itens.map((i) => ({
      name: i.nome,
      quantity: i.quantidade,
      unitary_value: i.valorUnitarioCents / 100,
    })),
    volumes: [
      {
        height: pedido.volume.heightCm,
        width: pedido.volume.widthCm,
        length: pedido.volume.lengthCm,
        // O Melhor Envio mede peso em quilos.
        weight: pedido.volume.weightGrams / 1000,
      },
    ],
    options: opcoes,
  };
  if (pedido.agencia) corpo.agency = Number(pedido.agencia) || pedido.agencia;
  return corpo;
}

function texto(valor: unknown): string | null {
  const t = String(valor ?? '').trim();
  return t ? t : null;
}

function centavos(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Passo 1: o envio entra no carrinho da conta. Não custa nada ainda. */
export async function colocarNoCarrinho(ctx: ContextoMelhorEnvio, pedido: PedidoDeEtiqueta): Promise<EnvioNoCarrinho> {
  const dados = (await chamar(ctx, '/api/v2/me/cart', 'POST', corpoDoCarrinho(pedido))) as Record<string, unknown> | null;
  const id = texto(dados?.id);
  if (!id) {
    throw new MelhorEnvioError('RESPOSTA_ILEGIVEL', 'O Melhor Envio aceitou o carrinho mas não devolveu o id do envio.');
  }
  return {
    id,
    protocolo: texto(dados?.protocol),
    precoCents: centavos(dados?.price),
    status: texto(dados?.status),
  };
}

/** Passo 2: paga a etiqueta com o saldo da carteira. */
export async function pagarEtiqueta(ctx: ContextoMelhorEnvio, id: string): Promise<void> {
  await chamar(ctx, '/api/v2/me/shipment/checkout', 'POST', { orders: [id] });
}

/**
 * Passo 3: gera a etiqueta. O provedor responde 200 mesmo quando não gerou —
 * o veredito vem por envio, em `{ [id]: { status, message } }`.
 */
export async function gerarEtiqueta(ctx: ContextoMelhorEnvio, id: string): Promise<void> {
  const dados = (await chamar(ctx, '/api/v2/me/shipment/generate', 'POST', { orders: [id] })) as
    | Record<string, unknown>
    | null;
  const veredito = dados?.[id] as Record<string, unknown> | undefined;
  if (veredito && veredito.status === false) {
    throw new MelhorEnvioError(
      'ETIQUETA_NAO_GERADA',
      `O Melhor Envio não gerou a etiqueta: ${aparar(String(veredito.message ?? 'sem motivo informado'))}`,
    );
  }
}

/** Passo 4: o link para imprimir. Modo público: abre sem login no Melhor Envio. */
export async function linkDaEtiqueta(ctx: ContextoMelhorEnvio, id: string): Promise<string> {
  const dados = (await chamar(ctx, '/api/v2/me/shipment/print', 'POST', { mode: 'public', orders: [id] })) as
    | Record<string, unknown>
    | null;
  const url = texto(dados?.url);
  if (!url || !/^https:\/\//i.test(url)) {
    throw new MelhorEnvioError('RESPOSTA_ILEGIVEL', 'O Melhor Envio não devolveu o link de impressão da etiqueta.');
  }
  return url;
}

/** Rastreio de vários envios numa chamada só. */
export async function rastrearEnvios(
  ctx: ContextoMelhorEnvio,
  ids: string[],
): Promise<Record<string, SituacaoNoMelhorEnvio>> {
  if (ids.length === 0) return {};
  const dados = (await chamar(ctx, '/api/v2/me/shipment/tracking', 'POST', { orders: ids })) as
    | Record<string, unknown>
    | null;
  const saida: Record<string, SituacaoNoMelhorEnvio> = {};
  for (const id of ids) {
    const bruto = dados?.[id] as Record<string, unknown> | undefined;
    if (!bruto || typeof bruto !== 'object') continue;
    const marcos: { chave: string; em: string }[] = [];
    for (const chave of MARCOS) {
      const em = texto(bruto[chave]);
      if (em && !Number.isNaN(Date.parse(em.replace(' ', 'T')))) marcos.push({ chave, em });
    }
    saida[id] = {
      id,
      status: texto(bruto.status),
      tracking: texto(bruto.tracking),
      melhorEnvioTracking: texto(bruto.melhorenvio_tracking),
      marcos,
    };
  }
  return saida;
}

/** Tira do carrinho um envio que ainda não foi pago. */
export async function removerDoCarrinho(ctx: ContextoMelhorEnvio, id: string): Promise<void> {
  await chamar(ctx, `/api/v2/me/cart/${encodeURIComponent(id)}`, 'DELETE');
}

/**
 * Cancela uma etiqueta paga. O Melhor Envio devolve o valor à carteira;
 * etiqueta já postada não se cancela por aqui.
 */
export async function cancelarEtiqueta(ctx: ContextoMelhorEnvio, id: string, motivo: string): Promise<void> {
  const dados = (await chamar(ctx, '/api/v2/me/shipment/cancel', 'POST', {
    order: { id, reason_id: '2', description: aparar(motivo, 200) },
  })) as Record<string, unknown> | null;
  const veredito = dados?.[id] as Record<string, unknown> | undefined;
  if (veredito && veredito.canceled === false) {
    throw new MelhorEnvioError('CANCELAMENTO_RECUSADO', 'O Melhor Envio recusou o cancelamento desta etiqueta.');
  }
}
