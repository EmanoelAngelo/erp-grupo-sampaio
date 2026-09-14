/**
 * ============================================================================
 * O SUPERVISOR — quem levanta a API quando ela cai (GAP-PRD-013)
 * ============================================================================
 *
 * A instalação da loja rodava a API à mão, num terminal. Uma queda — de
 * madrugada, por uma exceção, por falta de memória — parava o balcão das seis
 * empresas até alguém chegar e digitar o comando de novo. O repositório não
 * trazia supervisor nenhum; `DEPLOY.md` dizia "quem publica escolhe".
 *
 * Este é o supervisor de referência. É Node puro — o mesmo executável que já
 * roda a API, nada a baixar nem instalar como serviço de terceiro — e é o que a
 * tarefa agendada do Windows (`deploy/windows/instalar-servico.ps1`) sobe.
 * Docker e systemd têm supervisor próprio (`restart:`, `Restart=always`) e
 * não precisam dele.
 *
 * ## Como ele se comporta
 *
 *   - sobe a API com `DEVORA_SUPERVISIONADO=1` no ambiente (a tela de
 *     Implantação usa isso para dizer que há quem a levante);
 *   - quando ela sai sem ninguém ter pedido, espera e sobe de novo. A espera
 *     dobra a cada queda seguida (1 s, 2 s, 4 s... até 60 s) — um defeito que
 *     derruba a API na subida não vira laço apertado comendo a CPU do balcão —
 *     e volta ao começo depois de cinco minutos estável. Ele NUNCA desiste:
 *     são seis empresas, e cada tentativa fica no registro;
 *   - para desligar, pede pelo canal IPC (`{ tipo: 'desligar' }`). No Windows
 *     `child.kill()` é TerminateProcess — morte sem fechar conexão nem banco.
 *     Se a API não sair no prazo, aí sim é derrubada;
 *   - toda a saída da API, e os eventos dele mesmo, vão para `saida` — o
 *     script liga isso ao arquivo do dia e ao terminal.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface OpcoesDoSupervisor {
  /** O arquivo que o Node roda: `server/dist/index.js`. */
  entrada: string;
  /** Argumentos do Node antes da entrada (em desenvolvimento: `--import tsx`). */
  argumentosDoNode?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Recebe texto cru: a saída da API e as linhas JSON do supervisor. */
  saida: (texto: string) => void;
  esperaInicialMs?: number;
  esperaMaximaMs?: number;
  /** Depois disso no ar, a próxima queda recomeça a espera do início. */
  estavelAposMs?: number;
  /** Quanto esperar a API descer sozinha antes de derrubá-la. */
  prazoDeParadaMs?: number;
}

export interface Supervisor {
  parar(): Promise<void>;
  /** PID da API em execução, ou null entre uma queda e a próxima subida. */
  pidAtual(): number | null;
}

export function iniciarSupervisor(opcoes: OpcoesDoSupervisor): Supervisor {
  const esperaInicial = opcoes.esperaInicialMs ?? 1_000;
  const esperaMaxima = opcoes.esperaMaximaMs ?? 60_000;
  const estavelApos = opcoes.estavelAposMs ?? 5 * 60_000;
  const prazoDeParada = opcoes.prazoDeParadaMs ?? 15_000;

  let filho: ChildProcess | null = null;
  let quedasSeguidas = 0;
  let parando = false;
  let proximaSubida: ReturnType<typeof setTimeout> | null = null;
  let aoSairFilho: (() => void) | null = null;

  const anotar = (message: string, meta: Record<string, unknown> = {}, level = 'info'): void => {
    opcoes.saida(`${JSON.stringify({ level, message, ...meta })}\n`);
  };

  const subir = (): void => {
    proximaSubida = null;
    if (parando) return;
    const inicio = Date.now();
    let encerrado = false;

    const atual = spawn(process.execPath, [...(opcoes.argumentosDoNode ?? []), opcoes.entrada], {
      cwd: opcoes.cwd,
      env: { ...opcoes.env, DEVORA_SUPERVISIONADO: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    filho = atual;
    anotar('SUPERVISOR_API_SUBINDO', { pid: atual.pid ?? null, tentativa: quedasSeguidas + 1 });

    atual.stdout?.setEncoding('utf8');
    atual.stderr?.setEncoding('utf8');
    atual.stdout?.on('data', (texto: string) => opcoes.saida(texto));
    atual.stderr?.on('data', (texto: string) => opcoes.saida(texto));

    const encerrar = (codigo: number | null, sinal: string | null, falha?: Error): void => {
      if (encerrado) return;
      encerrado = true;
      if (filho === atual) filho = null;
      const durouMs = Date.now() - inicio;
      anotar(
        'SUPERVISOR_API_SAIU',
        { codigo, sinal, durouMs, ...(falha ? { erro: falha.message } : {}) },
        codigo === 0 && !falha ? 'info' : 'error',
      );
      if (parando) {
        aoSairFilho?.();
        return;
      }
      if (durouMs >= estavelApos) quedasSeguidas = 0;
      const esperaMs = Math.min(esperaMaxima, esperaInicial * 2 ** quedasSeguidas);
      quedasSeguidas += 1;
      anotar('SUPERVISOR_REINICIA', { esperaMs, quedasSeguidas }, 'error');
      proximaSubida = setTimeout(subir, esperaMs);
    };

    atual.on('exit', (codigo, sinal) => encerrar(codigo, sinal));
    atual.on('error', (erro) => encerrar(null, null, erro));
  };

  subir();

  return {
    pidAtual: () => filho?.pid ?? null,
    parar: () => {
      parando = true;
      if (proximaSubida) {
        clearTimeout(proximaSubida);
        proximaSubida = null;
      }
      const atual = filho;
      if (!atual) return Promise.resolve();
      anotar('SUPERVISOR_PARANDO', { pid: atual.pid ?? null });
      return new Promise<void>((resolve) => {
        const derrubar = setTimeout(() => {
          anotar('SUPERVISOR_FORCOU_PARADA', { pid: atual.pid ?? null, prazoMs: prazoDeParada }, 'error');
          atual.kill('SIGKILL');
        }, prazoDeParada);
        aoSairFilho = () => {
          clearTimeout(derrubar);
          resolve();
        };
        if (atual.connected) {
          atual.send({ tipo: 'desligar' }, (erro) => {
            if (erro) atual.kill('SIGTERM');
          });
        } else {
          atual.kill('SIGTERM');
        }
      });
    },
  };
}
