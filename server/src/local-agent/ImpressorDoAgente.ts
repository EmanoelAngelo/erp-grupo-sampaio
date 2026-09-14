/**
 * O IMPRESSOR DO AGENTE LOCAL — a fila de impressão do servidor de um lado, a
 * térmica do caixa do outro (GAP-PRD-082).
 *
 * O mesmo programa que fala com o PinPad retira os cupons da impressora de
 * agente do caixa dele e escreve os bytes na porta:
 *
 *   1. retira (long-poll de até 25 s) — o servidor já marca "imprimindo";
 *   2. escreve na impressora (`PonteImpressora`);
 *   3. conta `printed` ou `failed` (com o motivo: sem papel, cabo, endereço).
 *
 * Um job escrito nunca é escrito de novo por este processo: se a volta do
 * resultado falhar (rede), o resultado fica guardado e é reenviado no próximo
 * passo — o servidor trata a repetição como a mesma resposta. Reimprimir
 * sozinho seria cupom em dobro e, com gaveta, a gaveta abrindo duas vezes.
 */
import type { ClienteDoServidor, ImpressaoRecebida } from './ClienteDoServidor.js';
import { ErroDoServidor } from './ClienteDoServidor.js';
import { escritorDoSistema, imprimirNoDestino, type EscritorDeImpressora } from './PonteImpressora.js';

export interface OpcoesDoImpressor {
  escritor?: EscritorDeImpressora;
  log?: (mensagem: string) => void;
}

type Resultado = { status: 'printed' | 'failed'; message: string | null };

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ImpressorDoAgente {
  private readonly cliente: ClienteDoServidor;
  private readonly escritor: EscritorDeImpressora;
  private readonly log: (m: string) => void;
  /** Resultados escritos que ainda não chegaram ao servidor. */
  private readonly pendentes = new Map<string, Resultado>();
  /** Os últimos jobs escritos por este processo — nunca escritos de novo. */
  private readonly feitos: string[] = [];

  constructor(cliente: ClienteDoServidor, opcoes: OpcoesDoImpressor = {}) {
    this.cliente = cliente;
    this.escritor = opcoes.escritor ?? escritorDoSistema;
    this.log = opcoes.log ?? (() => undefined);
  }

  /** Quantos resultados esperam para ser contados ao servidor. */
  get resultadosPendentes(): number {
    return this.pendentes.size;
  }

  private async devolverPendentes(): Promise<void> {
    for (const [jobId, resultado] of [...this.pendentes]) {
      try {
        await this.cliente.resultadoDaImpressao(jobId, resultado);
        this.pendentes.delete(jobId);
      } catch (err) {
        if (err instanceof ErroDoServidor && err.definitivo) {
          // O servidor não reconhece este job para este agente: não adianta insistir.
          this.pendentes.delete(jobId);
          this.log(`Resultado da impressão ${jobId} recusado pelo servidor: ${err.message}`);
        } else {
          this.log(`Resultado da impressão ${jobId} não chegou ao servidor (${String(err)}); tento no próximo passo.`);
          return;
        }
      }
    }
  }

  async imprimir(job: ImpressaoRecebida): Promise<void> {
    if (this.feitos.includes(job.jobId)) return;
    let resultado: Resultado;
    try {
      await imprimirNoDestino(job.printer.device, Buffer.from(job.escposBase64, 'base64'), this.escritor);
      resultado = { status: 'printed', message: null };
      this.log(`${job.documentLabel} impresso em "${job.printer.name}" (${job.printer.device}).`);
    } catch (err) {
      resultado = {
        status: 'failed',
        message: `Falha ao imprimir em "${job.printer.name}" (${job.printer.device}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
      this.log(resultado.message ?? '');
    }
    this.feitos.push(job.jobId);
    if (this.feitos.length > 200) this.feitos.splice(0, this.feitos.length - 200);
    this.pendentes.set(job.jobId, resultado);
    await this.devolverPendentes();
  }

  /** Um ciclo: resultados atrasados, retirada, impressão. Devolve quantos jobs chegaram. */
  async passo(esperaMs = 0): Promise<number> {
    await this.devolverPendentes();
    const jobs = await this.cliente.impressoes(esperaMs);
    for (const job of jobs) await this.imprimir(job);
    return jobs.length;
  }

  async rodar(parar: AbortSignal): Promise<void> {
    while (!parar.aborted) {
      try {
        await this.passo(25_000);
      } catch (err) {
        this.log(`Ciclo de impressão falhou: ${String(err)}`);
        await dormir(5000);
      }
    }
  }
}
