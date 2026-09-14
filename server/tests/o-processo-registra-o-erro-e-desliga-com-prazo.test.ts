/**
 * ============================================================================
 * O PROCESSO REGISTRA O ERRO E DESLIGA COM PRAZO (GAP-PRD-063)
 * ============================================================================
 *
 * Um processo, seis empresas. Até o lote D1:
 *
 *   - não havia tratador de `unhandledRejection` nem de `uncaughtException`.
 *     O Node 24 ENCERRA o processo numa promessa rejeitada sem `catch` — um
 *     laço de fundo que falhasse de madrugada derrubava o balcão das seis
 *     operações sem deixar a causa no log;
 *   - o desligamento era `server.close(() => process.exit(0))`: sem prazo, e
 *     o `close` espera cada conexão em andamento terminar. Uma requisição
 *     pendurada segurava o processo "terminando" até alguém matá-lo;
 *   - o SQLite nunca era fechado — o `-wal` ficava para o próximo boot.
 *
 * O desenho, e por que ele é assimétrico:
 *
 *   REJEIÇÃO NÃO TRATADA → registra e SEGUE. É uma operação assíncrona que
 *   falhou sem ninguém escutando; o banco é síncrono (a transação ou foi
 *   inteira ou voltou), então não há estado pela metade para proteger, e
 *   derrubar as seis empresas por ela é o remédio pior que a doença.
 *
 *   EXCEÇÃO NÃO TRATADA → registra e DESLIGA com código 1. Aqui o Node não
 *   garante mais nada sobre o estado do processo; o certo é sair limpo e
 *   deixar o supervisor (deploy/, ou o `restart:` do Docker) subir de novo.
 *
 * Tudo é injetado — o emissor de eventos, o servidor, o banco e o `exit` —,
 * então nada aqui instala tratador no processo do Vitest nem encerra nada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const { criarDesligamento, instalarRedeDeSeguranca } = await import(
  '../src/services/implantacao/cicloDoProcesso.js'
);

let erros: string[] = [];
let infos: string[] = [];

beforeEach(() => {
  erros = [];
  infos = [];
  vi.spyOn(console, 'error').mockImplementation((linha: unknown) => {
    erros.push(String(linha));
  });
  vi.spyOn(console, 'log').mockImplementation((linha: unknown) => {
    infos.push(String(linha));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function linhaCom(lista: string[], mensagem: string): Record<string, unknown> | undefined {
  const bruta = lista.find((l) => l.includes(`"message":"${mensagem}"`));
  return bruta ? (JSON.parse(bruta) as Record<string, unknown>) : undefined;
}

// ============================================================================

describe('a rede de segurança', () => {
  function montar() {
    const processo = new EventEmitter();
    const desligar = vi.fn<(motivo: string, codigo?: number) => Promise<void>>(async () => undefined);
    instalarRedeDeSeguranca(processo, desligar, 'linux');
    return { processo, desligar };
  }

  it('rejeição não tratada vira linha de log COM a causa e a pilha — e o processo segue', () => {
    const { processo, desligar } = montar();
    processo.emit('unhandledRejection', new Error('disco cheio ao gravar o backup'));

    const linha = linhaCom(erros, 'processo_rejeicao_nao_tratada');
    expect(linha, 'a rejeição não apareceu no log').toBeDefined();
    expect(linha!.erro).toBe('disco cheio ao gravar o backup');
    expect(String(linha!.pilha)).toContain('Error: disco cheio');
    expect(desligar).not.toHaveBeenCalled();
  });

  it('e o motivo que não é Error também é dito, em vez de virar {}', () => {
    const { processo } = montar();
    processo.emit('unhandledRejection', 'tempo esgotado na central');
    expect(linhaCom(erros, 'processo_rejeicao_nao_tratada')!.erro).toBe('tempo esgotado na central');
  });

  it('exceção não tratada é registrada e desliga com código 1, para o supervisor subir de novo', () => {
    const { processo, desligar } = montar();
    processo.emit('uncaughtException', new TypeError('x is not a function'), 'uncaughtException');

    const linha = linhaCom(erros, 'processo_excecao_nao_tratada');
    expect(linha!.erro).toBe('x is not a function');
    expect(linha!.tipo).toBe('TypeError');
    expect(linha!.origem).toBe('uncaughtException');
    expect(desligar).toHaveBeenCalledWith('excecao_nao_tratada', 1);
  });

  it.each(['SIGINT', 'SIGTERM'])('%s desliga com código 0', (sinal) => {
    const { processo, desligar } = montar();
    processo.emit(sinal);
    expect(desligar).toHaveBeenCalledWith(sinal, 0);
  });

  it('no Windows, Ctrl+Break (SIGBREAK) também desliga', () => {
    const processo = new EventEmitter();
    const desligar = vi.fn(async () => undefined);
    instalarRedeDeSeguranca(processo, desligar, 'win32');
    processo.emit('SIGBREAK');
    expect(desligar).toHaveBeenCalledWith('SIGBREAK', 0);
  });

  it('o pedido do supervisor pelo canal IPC desliga — no Windows não existe SIGTERM de verdade', () => {
    /*
      `child.kill('SIGTERM')` no Windows é TerminateProcess: morte sem aviso,
      sem `close`, sem fechar o banco. O supervisor pede pelo canal IPC.
    */
    const { processo, desligar } = montar();
    processo.emit('message', { tipo: 'outra-coisa' });
    expect(desligar).not.toHaveBeenCalled();
    processo.emit('message', { tipo: 'desligar' });
    expect(desligar).toHaveBeenCalledWith('supervisor', 0);
  });

  it('se o supervisor some, a API desce em vez de ficar órfã segurando a porta', () => {
    /*
      No Linux, matar o pai não mata o filho. Uma API órfã continuaria na
      porta, e o próximo supervisor nasceria com a porta ocupada — um laço de
      quedas. O canal IPC fechado é o aviso de que o pai se foi. (No Windows o
      filho morre junto com o pai, pelo "job" do libuv — medido; a parada
      planejada é o `parar-api`, provado em o-supervisor-para-quando-pedem.)
    */
    const { processo, desligar } = montar();
    processo.emit('disconnect');
    expect(desligar).toHaveBeenCalledWith('supervisor_sumiu', 0);
  });
});

// ============================================================================

describe('o desligamento', () => {
  let servidor: Server | null = null;
  let pendurada: (() => void) | null = null;
  /*
    Resolve quando a requisição presa CHEGA ao servidor. Os casos esperavam
    50 ms fixos: sob carga (a suíte inteira com outras rodando ao lado) a
    requisição ainda não tinha chegado, o servidor não tinha conexão aberta,
    o desligamento terminava em 2 ms e o caso acusava o prazo de um defeito
    que não existe. Esperar o fato, e não o relógio.
  */
  let chegouAPresa: Promise<void> = Promise.resolve();

  afterEach(async () => {
    pendurada?.();
    pendurada = null;
    if (servidor?.listening) {
      servidor.closeAllConnections();
      await new Promise<void>((r) => servidor!.close(() => r()));
    }
    servidor = null;
  });

  /** Um servidor HTTP de verdade cuja rota /presa nunca responde. */
  async function subir(): Promise<number> {
    let avisarChegada: () => void = () => undefined;
    chegouAPresa = new Promise<void>((r) => {
      avisarChegada = r;
    });
    servidor = createServer((req, res) => {
      if (req.url === '/presa') {
        pendurada = () => res.destroy();
        avisarChegada();
        return; // nunca responde
      }
      res.end('ok');
    });
    await new Promise<void>((r) => servidor!.listen(0, '127.0.0.1', () => r()));
    return (servidor!.address() as AddressInfo).port;
  }

  function pedir(porta: number, caminho: string): Promise<string> {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: porta, path: caminho, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(`status ${res.statusCode}`));
      });
      req.on('error', (e) => resolve(`erro ${e.message}`));
      req.end();
    });
  }

  it('uma requisição pendurada NÃO segura o processo além do prazo', async () => {
    const porta = await subir();
    const resposta = pedir(porta, '/presa');
    await chegouAPresa;

    const sair = vi.fn();
    const fecharBanco = vi.fn();
    const pararTrabalhadores = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores,
      fecharBanco,
      sair,
      prazoMs: 300,
    });

    const inicio = Date.now();
    await desligar('SIGTERM', 0);
    const levou = Date.now() - inicio;

    expect(levou).toBeGreaterThanOrEqual(250);
    expect(levou).toBeLessThan(3_000);
    expect(pararTrabalhadores).toHaveBeenCalledTimes(1);
    expect(fecharBanco, 'o SQLite não foi fechado').toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledWith(0);
    // A conexão presa foi cortada, não esquecida aberta.
    expect(await resposta).toMatch(/^erro /);
    expect(linhaCom(erros, 'desligamento_estourou_prazo')).toBeDefined();
  });

  it('sem nada pendurado, desliga na hora — o prazo é teto, não espera', async () => {
    const porta = await subir();
    expect(await pedir(porta, '/')).toBe('status 200');

    const sair = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores: () => undefined,
      fecharBanco: () => undefined,
      sair,
      prazoMs: 5_000,
    });
    const inicio = Date.now();
    await desligar('SIGINT', 0);
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(sair).toHaveBeenCalledWith(0);
    expect(linhaCom(infos, 'API_DESLIGANDO')!.motivo).toBe('SIGINT');
    expect(linhaCom(infos, 'API_DESLIGADA')).toBeDefined();
  });

  it('trabalhador que falha ao parar não impede fechar o banco nem sair', async () => {
    await subir();
    const sair = vi.fn();
    const fecharBanco = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores: () => {
        throw new Error('timer já estava parado');
      },
      fecharBanco,
      sair,
      prazoMs: 1_000,
    });
    await desligar('SIGTERM', 0);
    expect(fecharBanco).toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledWith(0);
    expect(linhaCom(erros, 'desligamento_trabalhador_nao_parou')!.erro).toBe('timer já estava parado');
  });

  it('banco que falha ao fechar é registrado, e o processo sai assim mesmo', async () => {
    await subir();
    const sair = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores: () => undefined,
      fecharBanco: () => {
        throw new Error('database is locked');
      },
      sair,
      prazoMs: 1_000,
    });
    await desligar('SIGTERM', 0);
    expect(sair).toHaveBeenCalledWith(0);
    expect(linhaCom(erros, 'desligamento_banco_nao_fechou')!.erro).toBe('database is locked');
  });

  it('o segundo pedido (Ctrl+C de novo) força a saída sem esperar o prazo', async () => {
    const porta = await subir();
    void pedir(porta, '/presa');
    await chegouAPresa;

    const sair = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores: () => undefined,
      fecharBanco: () => undefined,
      sair,
      prazoMs: 20_000,
    });
    const primeiro = desligar('SIGINT', 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(sair).not.toHaveBeenCalled();

    const inicio = Date.now();
    await desligar('SIGINT', 0);
    await primeiro;
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(sair).toHaveBeenCalledTimes(1);
  });

  it('exceção no meio do desligamento sobe o código para 1 — o supervisor precisa saber', async () => {
    const porta = await subir();
    void pedir(porta, '/presa');
    await chegouAPresa;

    const sair = vi.fn();
    const desligar = criarDesligamento({
      servidor: servidor!,
      pararTrabalhadores: () => undefined,
      fecharBanco: () => undefined,
      sair,
      prazoMs: 20_000,
    });
    const primeiro = desligar('SIGTERM', 0);
    await desligar('excecao_nao_tratada', 1);
    await primeiro;
    expect(sair).toHaveBeenCalledWith(1);
  });
});
