/**
 * O EXECUTOR DO AGENTE LOCAL — a fila do servidor de um lado, o PinPad do outro (GAP-PRD-014).
 *
 * Um comando por vez (o PinPad só faz uma coisa por vez), nesta ordem:
 *
 *   1. retira os comandos do servidor (long-poll);
 *   2. para a cobrança: marca "em andamento" no estado local ANTES de falar
 *      com o cliente TEF, avisa o servidor da etapa, cobra;
 *   3. aprovada: guarda a pendência de confirmação no estado local ANTES de
 *      devolver o resultado;
 *   4. devolve o resultado (repetindo enquanto a rede falhar — o servidor
 *      trata a repetição como a mesma resposta);
 *   5. o servidor aceitou e manda confirmar → CNF; recusou → NCN (desfaz no
 *      cliente TEF, porque o ERP não vai registrar aquele dinheiro).
 *
 * ## Por que o estado local
 *
 * O agente pode cair no meio. Ao voltar:
 *
 * - pendência de confirmação guardada: devolve o resultado de novo (o
 *   servidor responde a mesma coisa) e faz o CNF/NCN que faltou;
 * - comando que volta como REENTREGA e estava "em andamento": o agente não
 *   sabe se o PinPad cobrou. Ele NÃO cobra de novo — responde "não
 *   confirmada", e a conferência vai para o gestor;
 * - reentrega sem registro local: o agente nunca começou (a resposta da
 *   retirada se perdeu) — é seguro executar.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { ClienteDoServidor, ComandoRecebido, RespostaAoResultado } from './ClienteDoServidor.js';
import { ErroDoServidor } from './ClienteDoServidor.js';
import type { DadosDeConfirmacao, PonteTef, ResultadoDaPonte } from './PonteTef.js';

export interface PendenciaDeConfirmacao {
  commandId: string;
  resultado: Record<string, unknown>;
  confirmacao: DadosDeConfirmacao;
}

export interface EstadoDoAgente {
  /** Comando cuja operação foi mandada ao cliente TEF e ainda não terminou aqui. */
  emAndamento: string | null;
  pendentes: PendenciaDeConfirmacao[];
  /** Os últimos comandos terminados — reentrega deles não executa de novo. */
  feitos: string[];
}

export interface ArmazemDeEstado {
  ler(): EstadoDoAgente;
  gravar(estado: EstadoDoAgente): void;
}

const VAZIO: EstadoDoAgente = { emAndamento: null, pendentes: [], feitos: [] };

export function armazemEmMemoria(inicial: EstadoDoAgente = VAZIO): ArmazemDeEstado & { atual: EstadoDoAgente } {
  const box = { atual: structuredClone(inicial) };
  return {
    get atual() {
      return box.atual;
    },
    ler: () => structuredClone(box.atual),
    gravar: (e) => {
      box.atual = structuredClone(e);
    },
  };
}

/** Estado num arquivo JSON, gravado por troca atômica (tmp + rename). */
export function armazemEmArquivo(caminho: string): ArmazemDeEstado {
  return {
    ler: () => {
      if (!existsSync(caminho)) return structuredClone(VAZIO);
      try {
        return { ...structuredClone(VAZIO), ...(JSON.parse(readFileSync(caminho, 'utf8')) as EstadoDoAgente) };
      } catch {
        return structuredClone(VAZIO);
      }
    },
    gravar: (e) => {
      const tmp = `${caminho}.tmp`;
      writeFileSync(tmp, JSON.stringify(e, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, caminho);
    },
  };
}

export interface OpcoesDoExecutor {
  estado: ArmazemDeEstado;
  versao: string;
  hostname: string;
  /** Tentativas de devolver um resultado dentro de um passo (a pendência continua para o próximo). */
  tentativas?: number;
  esperaEntreTentativasMs?: number;
  log?: (mensagem: string) => void;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function numero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** DDMMAAAA e HHMMSS de um instante ISO, no fuso da loja. */
function dataEHora(iso: unknown): { data: string | null; hora: string | null } {
  if (!iso) return { data: null, hora: null };
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return { data: null, hora: null };
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return { data: `${p('day')}${p('month')}${p('year')}`, hora: `${p('hour')}${p('minute')}${p('second')}` };
}

export class ExecutorDoAgente {
  private readonly cliente: ClienteDoServidor;
  private readonly ponte: PonteTef;
  private readonly op: Required<Omit<OpcoesDoExecutor, 'log'>> & { log: (m: string) => void };

  constructor(cliente: ClienteDoServidor, ponte: PonteTef, opcoes: OpcoesDoExecutor) {
    this.cliente = cliente;
    this.ponte = ponte;
    this.op = {
      tentativas: 5,
      esperaEntreTentativasMs: 2000,
      log: () => undefined,
      ...opcoes,
    };
  }

  private mudarEstado(f: (e: EstadoDoAgente) => void): void {
    const e = this.op.estado.ler();
    f(e);
    e.feitos = e.feitos.slice(-200);
    this.op.estado.gravar(e);
  }

  /** Sinal de vida com a saúde do cliente TEF. */
  async sinal(): Promise<void> {
    const saude = await this.ponte.saude();
    await this.cliente.sinal({ version: this.op.versao, hostname: this.op.hostname, health: { ...saude } });
  }

  /**
   * Devolve um resultado, repetindo enquanto a falha for de rede. Recusa
   * definitiva do servidor (4xx) sobe como `ErroDoServidor`.
   */
  private async devolver(commandId: string, corpo: Record<string, unknown>): Promise<RespostaAoResultado | null> {
    for (let i = 0; i < this.op.tentativas; i += 1) {
      try {
        return await this.cliente.resultado(commandId, corpo);
      } catch (err) {
        if (err instanceof ErroDoServidor && err.definitivo) throw err;
        this.op.log(`Falha ao devolver o resultado de ${commandId} (${String(err)}); tentando de novo.`);
        await dormir(this.op.esperaEntreTentativasMs);
      }
    }
    return null;
  }

  /** CNF ou NCN, conforme o servidor registrou ou não o dinheiro. */
  private async fecharNoTef(pendencia: PendenciaDeConfirmacao, confirmar: boolean): Promise<void> {
    if (confirmar) await this.ponte.confirmar(pendencia.confirmacao);
    else await this.ponte.desfazer(pendencia.confirmacao);
    this.mudarEstado((e) => {
      e.pendentes = e.pendentes.filter((p) => p.commandId !== pendencia.commandId);
    });
  }

  /** Resolve as pendências de confirmação que sobraram de uma queda. */
  async resolverPendentes(): Promise<void> {
    for (const p of this.op.estado.ler().pendentes) {
      try {
        const r = await this.devolver(p.commandId, p.resultado);
        if (!r) continue; // rede ainda fora: fica para o próximo passo
        await this.fecharNoTef(p, r.confirmOnTef);
      } catch (err) {
        if (err instanceof ErroDoServidor && err.definitivo) {
          // O servidor não vai registrar esta transação: desfaz no cliente TEF.
          await this.fecharNoTef(p, false);
        } else {
          this.op.log(`Pendência ${p.commandId}: ${String(err)}`);
        }
      }
    }
  }

  /** Um ciclo: pendências, retirada, execução. Devolve quantos comandos executou. */
  async passo(esperaMs = 0): Promise<number> {
    await this.resolverPendentes();
    const comandos = await this.cliente.comandos(esperaMs);
    let feitos = 0;
    for (const cmd of comandos) {
      await this.executar(cmd);
      feitos += 1;
    }
    return feitos;
  }

  async executar(cmd: ComandoRecebido): Promise<void> {
    const estado = this.op.estado.ler();
    if (estado.pendentes.some((p) => p.commandId === cmd.id)) return; // resolverPendentes cuida
    if (estado.feitos.includes(cmd.id)) return;
    if (cmd.redelivery && estado.emAndamento === cmd.id) {
      // Caiu no meio da operação: ninguém sabe o que o PinPad fez.
      await this.terminar(cmd, {
        status: 'uncertain',
        message: 'O agente reiniciou no meio desta operação. Confira no gerenciador TEF antes de cobrar de novo.',
      });
      return;
    }
    this.mudarEstado((e) => {
      e.emAndamento = cmd.id;
    });
    let resultado: ResultadoDaPonte;
    try {
      resultado = await this.operar(cmd);
    } catch (err) {
      resultado = {
        status: cmd.command === 'startPayment' ? 'uncertain' : 'failed',
        message: `Falha do agente ao falar com o cliente TEF: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await this.terminar(cmd, resultado);
  }

  private async operar(cmd: ComandoRecebido): Promise<ResultadoDaPonte> {
    const p = cmd.payload;
    switch (cmd.command) {
      case 'startPayment':
        return this.ponte.cobrar(
          {
            referencia: this.referenciaNumerica(cmd.id),
            documento: String(p.reference ?? '').slice(0, 10),
            valorEmCentavos: numero(p.amountInCents),
            metodo: p.paymentMethod === 'debit' ? 'debit' : p.paymentMethod === 'pix' ? 'pix' : 'credit',
            parcelas: Math.max(1, numero(p.installments)),
          },
          (etapa) => {
            void this.cliente
              .resultado(cmd.id, { status: 'in_progress', stage: etapa.stage, message: etapa.message ?? null })
              .catch((err: unknown) => this.op.log(`Etapa de ${cmd.id} não chegou ao servidor: ${String(err)}`));
          },
        );
      case 'cancel':
      case 'refund': {
        const quando = dataEHora(p.authorizedAt);
        return this.ponte.cancelar({
          referencia: this.referenciaNumerica(cmd.id),
          valorEmCentavos: numero(p.amountInCents),
          valorOriginalEmCentavos: numero(p.originalAmountInCents ?? p.amountInCents),
          rede: (p.acquirer as string | null) ?? null,
          nsu: (p.nsu as string | null) ?? null,
          data: quando.data,
          hora: quando.hora,
        });
      }
      case 'queryStatus':
        return this.ponte.consultar(this.referenciaNumerica(cmd.id));
      case 'health': {
        const s = await this.ponte.saude();
        return { status: s.tefClient === 'ok' ? 'approved' : 'failed', message: s.message };
      }
      case 'reprint':
      default:
        return {
          status: 'failed',
          message: 'Reimpressão pelo PinPad não é feita por este agente: use a segunda via na tela de Maquininhas.',
        };
    }
  }

  /** Identificação numérica estável do comando para o cliente TEF (até 10 dígitos). */
  private referenciaNumerica(commandId: string): string {
    let h = 0;
    for (const c of commandId) h = (h * 31 + c.charCodeAt(0)) % 9_999_999_967;
    return String(h).padStart(10, '0').slice(-10);
  }

  private corpoDoResultado(r: ResultadoDaPonte): Record<string, unknown> {
    return {
      status: r.status,
      message: r.message ?? null,
      nsu: r.nsu ?? null,
      authorizationCode: r.authorizationCode ?? null,
      maskedCard: r.maskedCard ?? null,
      cardBrand: r.cardBrand ?? null,
      acquirer: r.acquirer ?? null,
      providerTransactionId: r.providerTransactionId ?? null,
      merchantReceipt: r.merchantReceipt ?? null,
      customerReceipt: r.customerReceipt ?? null,
      simulated: r.simulated === true,
    };
  }

  private async terminar(cmd: ComandoRecebido, resultado: ResultadoDaPonte): Promise<void> {
    const corpo = this.corpoDoResultado(resultado);
    const pendencia: PendenciaDeConfirmacao | null = resultado.confirmacao
      ? { commandId: cmd.id, resultado: corpo, confirmacao: resultado.confirmacao }
      : null;
    this.mudarEstado((e) => {
      if (pendencia) e.pendentes.push(pendencia);
      e.emAndamento = null;
      e.feitos.push(cmd.id);
    });
    try {
      const r = await this.devolver(cmd.id, corpo);
      if (!r) return; // rede fora: a pendência (se houver) resolve no próximo passo
      if (pendencia) await this.fecharNoTef(pendencia, r.confirmOnTef);
    } catch (err) {
      if (err instanceof ErroDoServidor && err.definitivo && pendencia) {
        await this.fecharNoTef(pendencia, false);
      }
      this.op.log(`Resultado de ${cmd.id} recusado pelo servidor: ${String(err)}`);
    }
  }

  /** O laço de sempre: sinal a cada 30 s, retirada em long-poll de 25 s. */
  async rodar(parar: AbortSignal): Promise<void> {
    let ultimoSinal = 0;
    while (!parar.aborted) {
      try {
        if (Date.now() - ultimoSinal >= 30_000) {
          await this.sinal();
          ultimoSinal = Date.now();
        }
        await this.passo(25_000);
      } catch (err) {
        this.op.log(`Ciclo do agente falhou: ${String(err)}`);
        await dormir(5000);
      }
    }
  }
}
