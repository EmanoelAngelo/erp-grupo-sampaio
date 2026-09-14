/**
 * O AGENTE LOCAL FALANDO COM O SERVIDOR (GAP-PRD-014).
 *
 * Este é o lado do programa que roda no computador do caixa. Ele não tem
 * sessão de usuário: fala com o servidor assinando cada pedido com o segredo
 * que recebeu no pareamento (`agentSignature.ts` — o MESMO código que o
 * servidor usa para conferir). O caminho assinado é o que vai na linha do
 * pedido (`/api/v1/payment-terminals/agent/...`): um proxy na frente do
 * servidor precisa preservá-lo.
 *
 * O `buscar` é injetável para o teste falar com o app em memória, sem rede.
 */
import { randomUUID } from 'node:crypto';
import { assinar, CABECALHOS_DO_AGENTE, fraseDaAssinatura } from '../services/payment-terminal/agentSignature.js';

export interface RespostaHttp {
  status: number;
  json(): Promise<unknown>;
}

export type Buscador = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<RespostaHttp>;

export const buscarPelaRede: Buscador = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

export interface IdentidadeDoAgente {
  /** Base da API, com o prefixo: `https://erp.exemplo.com.br/api/v1`. */
  servidor: string;
  agentId: string;
  segredo: string;
}

export class ErroDoServidor extends Error {
  readonly status: number;
  readonly codigo: string | null;

  constructor(status: number, codigo: string | null, mensagem: string) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }

  /** O servidor RECUSOU (4xx): repetir o mesmo pedido não muda a resposta. */
  get definitivo(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

async function lerErro(res: RespostaHttp): Promise<ErroDoServidor> {
  let codigo: string | null = null;
  let mensagem = `HTTP ${res.status}`;
  try {
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    codigo = corpo?.error?.code ?? null;
    mensagem = corpo?.error?.message ?? mensagem;
  } catch {
    // corpo que não é JSON: fica o status
  }
  return new ErroDoServidor(res.status, codigo, mensagem);
}

function semBarraFinal(servidor: string): string {
  return servidor.replace(/\/+$/, '');
}

/**
 * Pareia: troca o código de uso único pelo id do agente e o segredo.
 * É a única chamada sem assinatura — o agente ainda não tem identidade.
 */
export async function parearComOServidor(
  servidor: string,
  codigo: string,
  info: { version: string; hostname: string },
  buscar: Buscador = buscarPelaRede,
): Promise<{ agentId: string; segredo: string; pdvTerminalId: string | null; companyId: string | null }> {
  const res = await buscar(`${semBarraFinal(servidor)}/payment-terminals/agent/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode: codigo.trim().toUpperCase(), version: info.version, hostname: info.hostname }),
  });
  if (res.status !== 201) throw await lerErro(res);
  const corpo = (await res.json()) as Record<string, unknown>;
  return {
    agentId: String(corpo.agentId),
    segredo: String(corpo.agentSecret),
    pdvTerminalId: (corpo.pdvTerminalId as string | null | undefined) ?? null,
    companyId: (corpo.companyId as string | null | undefined) ?? null,
  };
}

export interface ComandoRecebido {
  id: string;
  command: 'startPayment' | 'queryStatus' | 'cancel' | 'refund' | 'reprint' | 'health';
  transactionId: string | null;
  payload: Record<string, unknown>;
  redelivery: boolean;
}

export interface RespostaAoResultado {
  commandId: string;
  accepted: boolean;
  duplicate: boolean;
  outcome: string;
  transactionStatus: string | null;
  confirmOnTef: boolean;
  message: string;
}

/** Um cupom (ou teste, ou pulso de gaveta) para escrever na impressora (GAP-PRD-082). */
export interface ImpressaoRecebida {
  jobId: string;
  documentType: string;
  documentLabel: string;
  copies: number;
  openDrawer: boolean;
  printer: { id: string; name: string; device: string; columns: 32 | 48 };
  /** Todas as vias juntas, em ESC/POS. */
  escposBase64: string;
  createdAt: string;
}

export class ClienteDoServidor {
  private readonly id: IdentidadeDoAgente;
  private readonly buscar: Buscador;
  private readonly relogio: () => number;

  constructor(id: IdentidadeDoAgente, buscar: Buscador = buscarPelaRede, relogio: () => number = () => Date.now()) {
    this.id = { ...id, servidor: semBarraFinal(id.servidor) };
    this.buscar = buscar;
    this.relogio = relogio;
  }

  private async pedir(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<unknown> {
    const url = `${this.id.servidor}${caminho}`;
    const assinado = new URL(url);
    const texto = corpo === undefined ? '' : JSON.stringify(corpo);
    const carimbo = String(this.relogio());
    const nonce = randomUUID();
    const frase = fraseDaAssinatura({
      metodo,
      caminho: `${assinado.pathname}${assinado.search}`,
      carimbo,
      nonce,
      corpo: texto,
    });
    const headers: Record<string, string> = {
      [CABECALHOS_DO_AGENTE.agente]: this.id.agentId,
      [CABECALHOS_DO_AGENTE.carimbo]: carimbo,
      [CABECALHOS_DO_AGENTE.nonce]: nonce,
      [CABECALHOS_DO_AGENTE.assinatura]: assinar(this.id.segredo, frase),
    };
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.buscar(url, { method: metodo, headers, body: corpo === undefined ? undefined : texto });
    if (res.status < 200 || res.status >= 300) throw await lerErro(res);
    return res.json();
  }

  async sinal(info: { version: string; hostname: string; health: Record<string, unknown> }): Promise<void> {
    await this.pedir('POST', '/payment-terminals/agent/heartbeat', info);
  }

  async comandos(esperaMs = 0): Promise<ComandoRecebido[]> {
    const corpo = (await this.pedir('GET', `/payment-terminals/agent/commands?waitMs=${Math.max(0, Math.floor(esperaMs))}`)) as {
      items?: ComandoRecebido[];
    };
    return corpo.items ?? [];
  }

  /** Os cupons da impressora deste caixa (long-poll de até 25 s). */
  async impressoes(esperaMs = 0): Promise<ImpressaoRecebida[]> {
    const corpo = (await this.pedir(
      'GET',
      `/payment-terminals/agent/print-jobs?waitMs=${Math.max(0, Math.floor(esperaMs))}`,
    )) as { items?: ImpressaoRecebida[] };
    return corpo.items ?? [];
  }

  /** Conta o que aconteceu com a impressão. Repetir o mesmo resultado é seguro. */
  async resultadoDaImpressao(
    jobId: string,
    corpo: { status: 'printed' | 'failed'; message?: string | null },
  ): Promise<{ jobId: string; status: string; duplicate: boolean }> {
    return (await this.pedir(
      'POST',
      `/payment-terminals/agent/print-jobs/${encodeURIComponent(jobId)}/result`,
      corpo,
    )) as { jobId: string; status: string; duplicate: boolean };
  }

  async resultado(commandId: string, corpo: Record<string, unknown>): Promise<RespostaAoResultado> {
    return (await this.pedir(
      'POST',
      `/payment-terminals/agent/commands/${encodeURIComponent(commandId)}/result`,
      corpo,
    )) as RespostaAoResultado;
  }
}
