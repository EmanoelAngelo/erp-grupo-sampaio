/**
 * ============================================================================
 * O CICLO DO PROCESSO — como a API cai, e como ela desce (GAP-PRD-063)
 * ============================================================================
 *
 * Um processo atende as seis empresas. Até o lote D1 ele não tinha rede de
 * segurança nenhuma:
 *
 *   - uma promessa rejeitada fora de `try/catch` — um laço de fundo que falha
 *     de madrugada — ENCERRA o processo no Node 24, sem uma linha de log com a
 *     causa. O balcão das seis operações parava até alguém digitar o comando;
 *   - o desligamento era `server.close(() => process.exit(0))`: sem prazo. O
 *     `close` espera cada requisição em andamento terminar, e uma pendurada
 *     segurava o processo "terminando" até o supervisor matá-lo à força;
 *   - o SQLite não era fechado: o `-wal` ficava para o próximo boot resolver.
 *
 * ## A assimetria é proposital
 *
 * REJEIÇÃO NÃO TRATADA → registra, com a causa e a pilha, e SEGUE. É uma
 * operação assíncrona que falhou sem ninguém escutando. O banco é síncrono (a
 * transação foi inteira ou voltou inteira), então não há estado pela metade a
 * proteger — e derrubar as seis empresas por ela é pior que a doença.
 *
 * EXCEÇÃO NÃO TRATADA → registra e DESLIGA com código 1. Aqui o Node não
 * garante mais nada sobre o estado do processo; o certo é sair limpo, dentro
 * do prazo, e deixar o supervisor subir de novo (`deploy/`, `restart:` do
 * Docker, `Restart=always` do systemd).
 *
 * ## O prazo
 *
 * `docker stop` manda SIGTERM e mata com SIGKILL dez segundos depois. O prazo
 * daqui (8 s) cabe dentro disso: o que não terminou até lá tem a conexão
 * cortada, e o banco é fechado ANTES de o processo sair.
 */
import { logError, logInfo } from '../../utils/errors.js';

/** Teto do desligamento. Cabe dentro dos 10 s do `docker stop`. */
export const PRAZO_DE_DESLIGAMENTO_MS = 8_000;

/** O pedaço do `http.Server` que o desligamento usa. */
export interface ServidorQueFecha {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface OpcoesDoDesligamento {
  servidor: ServidorQueFecha;
  /** Para os laços de fundo (e-mail, backup, central...). */
  pararTrabalhadores: () => void;
  /** Fecha o SQLite — leva junto o `-wal` e o `-shm`. */
  fecharBanco: () => void;
  /** `process.exit` em produção; um dublê em teste. */
  sair: (codigo: number) => void;
  prazoMs?: number;
}

export type Desligar = (motivo: string, codigo?: number) => Promise<void>;

/**
 * O erro em campos que o log consegue guardar.
 *
 * `JSON.stringify(new Error('x'))` é `{}` — o log dizia que falhou e não dizia
 * o quê. Aqui a mensagem, o tipo e o começo da pilha viram texto.
 */
export function descreverErro(erro: unknown): { erro: string; tipo?: string; pilha?: string } {
  if (erro instanceof Error) {
    return {
      erro: erro.message,
      tipo: erro.name,
      pilha: erro.stack?.split('\n').slice(0, 6).join(' | '),
    };
  }
  if (typeof erro === 'string') return { erro };
  try {
    return { erro: JSON.stringify(erro) ?? String(erro) };
  } catch {
    return { erro: String(erro) };
  }
}

/**
 * Monta o desligamento. Chamar de novo enquanto ele corre FORÇA a saída (o
 * segundo Ctrl+C de quem está no terminal), e um código maior vence o menor
 * (a exceção no meio de um SIGTERM precisa sair com 1).
 */
export function criarDesligamento(opcoes: OpcoesDoDesligamento): Desligar {
  const prazo = opcoes.prazoMs ?? PRAZO_DE_DESLIGAMENTO_MS;
  let emAndamento: Promise<void> | null = null;
  let codigoFinal = 0;
  let terminou = false;
  let forcar: (() => void) | null = null;

  const finalizar = (): void => {
    if (terminou) return;
    terminou = true;
    try {
      opcoes.fecharBanco();
    } catch (erro) {
      logError('desligamento_banco_nao_fechou', descreverErro(erro));
    }
    logInfo('API_DESLIGADA', { codigo: codigoFinal });
    opcoes.sair(codigoFinal);
  };

  return (motivo: string, codigo = 0): Promise<void> => {
    codigoFinal = Math.max(codigoFinal, codigo);
    if (emAndamento) {
      logError('desligamento_forcado', { motivo });
      forcar?.();
      return emAndamento;
    }

    logInfo('API_DESLIGANDO', { motivo, prazoMs: prazo });
    emAndamento = new Promise<void>((resolve) => {
      const concluir = (): void => {
        clearTimeout(relogio);
        finalizar();
        resolve();
      };
      forcar = () => {
        opcoes.servidor.closeAllConnections?.();
        concluir();
      };

      try {
        opcoes.pararTrabalhadores();
      } catch (erro) {
        logError('desligamento_trabalhador_nao_parou', descreverErro(erro));
      }

      const relogio = setTimeout(() => {
        logError('desligamento_estourou_prazo', { motivo, prazoMs: prazo });
        opcoes.servidor.closeAllConnections?.();
        concluir();
      }, prazo);

      try {
        opcoes.servidor.close(() => concluir());
      } catch (erro) {
        logError('desligamento_servidor_nao_fechou', descreverErro(erro));
        concluir();
        return;
      }
      // Conexão keep-alive ociosa (o PDV parado na tela) não tem por que
      // esperar o prazo: não há resposta a entregar nela.
      opcoes.servidor.closeIdleConnections?.();
    });
    return emAndamento;
  };
}

/** O pedaço do `process` que a rede de segurança escuta. */
export interface ProcessoQueEscuta {
  on(evento: string, ouvinte: (...args: never[]) => void): unknown;
}

/**
 * Liga a rede de segurança e os sinais ao desligamento.
 *
 * `message` é o canal do supervisor (`scripts/supervisionar-api`): no Windows
 * não existe SIGTERM de verdade — `child.kill()` é TerminateProcess, morte sem
 * aviso —, então ele pede o desligamento pelo IPC.
 */
export function instalarRedeDeSeguranca(
  processo: ProcessoQueEscuta,
  desligar: Desligar,
  plataforma: NodeJS.Platform = process.platform,
): void {
  processo.on('unhandledRejection', (motivo: unknown) => {
    logError('processo_rejeicao_nao_tratada', descreverErro(motivo));
  });

  processo.on('uncaughtException', (erro: unknown, origem?: unknown) => {
    logError('processo_excecao_nao_tratada', {
      ...descreverErro(erro),
      origem: typeof origem === 'string' ? origem : undefined,
    });
    void desligar('excecao_nao_tratada', 1);
  });

  const sinais = plataforma === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  for (const sinal of sinais) {
    processo.on(sinal, () => {
      void desligar(sinal, 0);
    });
  }

  processo.on('message', (mensagem: unknown) => {
    if (
      mensagem !== null
      && typeof mensagem === 'object'
      && (mensagem as { tipo?: unknown }).tipo === 'desligar'
    ) {
      void desligar('supervisor', 0);
    }
  });

  /*
    O SUPERVISOR SUMIU. No Linux, matar o pai NÃO mata o filho: a API ficaria
    órfã segurando a porta, e o próximo supervisor nasceria com EADDRINUSE —
    um laço de quedas. O canal IPC fechado é o aviso, e a API desce limpa.
    (No Windows o libuv põe o filho no "job" do pai e ele morre junto, na
    hora — é por isso que a parada planejada passa por `scripts/parar-api`.)
    Processo que nasceu sem IPC nunca recebe este evento.
  */
  processo.on('disconnect', () => {
    void desligar('supervisor_sumiu', 0);
  });
}
