/**
 * QUEM FALA COM A SEFIN NACIONAL — GAP-PRD-024.
 *
 * A DPS assinada vai à Sefin Nacional (Sistema Nacional NFS-e) por HTTPS com
 * TLS mútuo (o mesmo A1 que assina), num POST JSON com a DPS compactada em
 * GZip e codificada em Base64; a resposta traz a chave de acesso e a NFS-e
 * (também GZip+Base64), ou a lista de erros.
 *
 * ## Dois adapters, uma interface
 *
 * - `NfseNacionalAdapter` — o real. O transporte é injetável (os testes dublam
 *   o `postJson`; nenhum teste fala com a rede).
 * - `NfseTesteAdapter` — o simulador, SÓ para desenvolvimento e teste. Nunca
 *   transmite em produção: `assertAdapterDaNfsePodeTransmitir` recusa quando a
 *   operação OU o processo são de produção (`NODE_ENV=production` ou
 *   `DEVORA_API_ENV=production`) — a mesma régua dos atos da SEFAZ
 *   (GAP-PRD-018).
 *
 * ## Falha de transporte não é rejeição
 *
 * Sem resposta, a Sefin pode ter recebido a DPS. O adapter LANÇA
 * `TransportFailure` e o serviço guarda o documento como SEM_RESPOSTA, para o
 * reenvio usar o MESMO número de DPS (o `Id` da DPS é único: a Sefin não gera
 * duas NFS-e da mesma declaração).
 */
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiError } from '../../utils/errors.js';
import type { ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';
import { TransportFailure } from './SefazTestAdapter.js';
import { servidorEmProducao } from './SefazAdapter.js';
import { autoridadesConfiaveis } from './IcpBrasilTrust.js';

export type AmbienteDaNfse = 'homologation' | 'production';

export interface MotivoDaSefin {
  codigo: string;
  descricao: string;
}

export type ResultadoDaNfse =
  | {
      situacao: 'AUTORIZADA';
      chaveAcesso: string;
      numeroNfse: string | null;
      xmlNfse: string | null;
      alertas: MotivoDaSefin[];
    }
  | { situacao: 'REJEITADA'; motivos: MotivoDaSefin[] };

export interface NfseAdapter {
  readonly isReal: boolean;
  readonly nome: string;
  enviarDps(input: { dpsAssinada: string; ambiente: AmbienteDaNfse }): Promise<ResultadoDaNfse>;
}

/**
 * Os endereços da Sefin Nacional. Homologação é a "produção restrita" do
 * Sistema Nacional NFS-e — onde a primeira DPS do grupo deve ir.
 */
export const ENDERECOS_DA_SEFIN_NACIONAL: Record<AmbienteDaNfse, string> = {
  homologation: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  production: 'https://sefin.nfse.gov.br/SefinNacional',
};

/** Em produção — da operação ou do processo — só o adapter real transmite. */
export function assertAdapterDaNfsePodeTransmitir(input: {
  adapter: NfseAdapter;
  ambiente: AmbienteDaNfse | string;
}): void {
  if (input.adapter.isReal) return;
  if (input.ambiente !== 'production' && !servidorEmProducao()) return;
  throw new ApiError(
    'CORE_NFSE_TEST_PROVIDER_IN_PRODUCTION',
    'O simulador da NFS-e não pode emitir em produção — nota feita por ele não existe para a '
      + 'prefeitura nem para a Receita.',
    409,
  );
}

// ---------------------------------------------------------------- transporte

export type PostJson = (input: {
  url: string;
  body: string;
  cert: ParsedCertificateA1;
  timeoutMs: number;
  ca: string[];
}) => Promise<{ status: number; body: string }>;

/** POST JSON com TLS mútuo — o molde do `postSoapReal` da SEFAZ. */
const postJsonReal: PostJson = (input) =>
  new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // A cadeia, e não a folha sozinha — ver SefazRealAdapter.
        cert: input.cert.chainPem,
        key: input.cert.keyPem,
        ca: input.ca,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(input.body),
        },
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
      },
      (res) => {
        const partes: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > 10 * 1024 * 1024) {
            req.destroy();
            reject(new TransportFailure('NETWORK_ERROR', 'Resposta da Sefin Nacional grande demais.'));
            return;
          }
          partes.push(c);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(partes).toString('utf8') }),
        );
      },
    );
    req.on('error', (err) => reject(new TransportFailure('NETWORK_ERROR', err.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new TransportFailure('TIMEOUT', 'A Sefin Nacional não respondeu no tempo limite.'));
    });
    req.write(input.body);
    req.end();
  });

/** GZip + Base64, como a Sefin Nacional recebe e devolve os XMLs. */
export function compactarParaSefin(xml: string): string {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
}

export function descompactarDaSefin(b64: string): string {
  return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
}

function texto(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function motivosDe(lista: unknown): MotivoDaSefin[] {
  if (!Array.isArray(lista)) return [];
  return lista.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const complemento = texto(o.Complemento ?? o.complemento);
    return {
      codigo: texto(o.Codigo ?? o.codigo),
      descricao: [texto(o.Descricao ?? o.descricao), complemento].filter(Boolean).join(' — '),
    };
  });
}

/**
 * Lê a resposta da Sefin Nacional.
 *
 * - 2xx com `chaveAcesso` → AUTORIZADA (a NFS-e vem em `nfseXmlGZipB64`);
 * - 4xx com `erros` → REJEITADA, com código e descrição de cada erro;
 * - qualquer outra coisa (5xx, corpo que não é JSON, 2xx sem chave) →
 *   `TransportFailure`: não se sabe se a DPS foi processada, e o reenvio com o
 *   mesmo número é o caminho seguro.
 */
export function lerRespostaDaSefinNacional(status: number, corpo: string): ResultadoDaNfse {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(corpo) as Record<string, unknown>;
  } catch {
    throw new TransportFailure('NETWORK_ERROR', `A Sefin Nacional respondeu ${status} sem JSON legível.`);
  }
  const chave = texto(json.chaveAcesso ?? json.ChaveAcesso);
  if (status >= 200 && status < 300 && chave) {
    const b64 = texto(json.nfseXmlGZipB64 ?? json.NfseXmlGZipB64);
    let xmlNfse: string | null;
    try {
      xmlNfse = b64 ? descompactarDaSefin(b64) : null;
    } catch {
      // A chave basta para a nota existir; o XML ilegível fica para a consulta.
      xmlNfse = null;
    }
    const numero = xmlNfse ? /<nNFSe>\s*([^<\s]+)\s*<\/nNFSe>/.exec(xmlNfse)?.[1] ?? null : null;
    return {
      situacao: 'AUTORIZADA',
      chaveAcesso: chave,
      numeroNfse: numero,
      xmlNfse,
      alertas: motivosDe(json.alertas ?? json.Alertas),
    };
  }
  const erros = motivosDe(json.erros ?? json.Erros);
  if (status >= 400 && status < 500 && erros.length > 0) {
    return { situacao: 'REJEITADA', motivos: erros };
  }
  throw new TransportFailure(
    'NETWORK_ERROR',
    `A Sefin Nacional respondeu ${status} sem chave de acesso nem lista de erros.`,
  );
}

export class NfseNacionalAdapter implements NfseAdapter {
  readonly isReal = true;
  readonly nome = 'Sefin Nacional (Sistema Nacional NFS-e)';
  private readonly cert: ParsedCertificateA1;
  private readonly postJson: PostJson;
  private readonly timeoutMs: number;

  constructor(input: { cert: ParsedCertificateA1; postJson?: PostJson; timeoutMs?: number }) {
    this.cert = input.cert;
    this.postJson = input.postJson ?? postJsonReal;
    this.timeoutMs = input.timeoutMs ?? 30_000;
  }

  async enviarDps(input: { dpsAssinada: string; ambiente: AmbienteDaNfse }): Promise<ResultadoDaNfse> {
    const resposta = await this.postJson({
      url: `${ENDERECOS_DA_SEFIN_NACIONAL[input.ambiente]}/nfse`,
      body: JSON.stringify({ dpsXmlGZipB64: compactarParaSefin(input.dpsAssinada) }),
      cert: this.cert,
      timeoutMs: this.timeoutMs,
      // As raízes públicas do Node e as do ICP-Brasil: o servidor do governo
      // pode apresentar qualquer uma das duas cadeias.
      ca: [...rootCertificates, ...autoridadesConfiaveis()],
    });
    return lerRespostaDaSefinNacional(resposta.status, resposta.body);
  }
}

/**
 * O simulador — só desenvolvimento e teste, e sem valor fiscal nenhum: a
 * chave começa com "TESTE" para nenhum papel confundi-la com uma de verdade.
 */
export class NfseTesteAdapter implements NfseAdapter {
  readonly isReal = false;
  readonly nome = 'Simulador da NFS-e (sem valor fiscal)';
  private readonly cenario: 'autoriza' | 'rejeita' | 'cai';

  constructor(cenario: 'autoriza' | 'rejeita' | 'cai' = 'autoriza') {
    this.cenario = cenario;
  }

  async enviarDps(input: { dpsAssinada: string; ambiente: AmbienteDaNfse }): Promise<ResultadoDaNfse> {
    assertAdapterDaNfsePodeTransmitir({ adapter: this, ambiente: input.ambiente });
    if (this.cenario === 'cai') throw new TransportFailure('TIMEOUT', 'Simulador: sem resposta.');
    if (this.cenario === 'rejeita') {
      return {
        situacao: 'REJEITADA',
        motivos: [{ codigo: 'SIM01', descricao: 'Simulador: DPS recusada para teste.' }],
      };
    }
    const id = /Id="DPS(\d+)"/.exec(input.dpsAssinada)?.[1] ?? '0';
    return {
      situacao: 'AUTORIZADA',
      chaveAcesso: `TESTE${id}`.slice(0, 50),
      numeroNfse: `TESTE-${Number(id.slice(-15))}`,
      xmlNfse: null,
      alertas: [],
    };
  }
}
