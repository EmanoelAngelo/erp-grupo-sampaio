/**
 * ============================================================================
 * O CANAL DE CONTROLE DO SUPERVISOR — a parada planejada, sem matar a API
 * ============================================================================
 *
 * Medido com o supervisor compilado nesta máquina: no Windows o libuv põe a
 * API num "job" que morre junto com o supervisor. Encerrar a tarefa agendada
 * derruba a API NA HORA — sem fechar conexões, sem fechar o banco. Nenhum dado
 * confirmado se perde (WAL + `synchronous FULL`), mas a venda sendo gravada
 * naquele instante recebe erro de rede.
 *
 * Para parar DE PROPÓSITO (atualizar a versão, remover o serviço), o
 * supervisor escuta um canal local — pipe nomeado no Windows, socket de
 * arquivo no Linux — e `scripts/parar-api` manda `parar` por ele. O
 * supervisor pede à API que desça limpa, espera, responde `parado` e sai.
 *
 * O canal só aceita conexão da própria máquina (não é porta de rede) e só
 * conhece um comando. Ele também impede um segundo supervisor de subir em
 * cima do primeiro: duas APIs disputando a mesma porta e o mesmo banco.
 */
import { createConnection, createServer, type Server } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOME_PADRAO = 'grupo-sampaio-erp-api';

/**
 * Onde o canal mora. `DEVORA_SUPERVISOR_CANAL` troca o NOME — para duas
 * instalações na mesma máquina (produção e homologação) não se atropelarem.
 */
export function caminhoDoCanal(): string {
  const nome = process.env.DEVORA_SUPERVISOR_CANAL?.trim() || NOME_PADRAO;
  if (process.platform === 'win32') return nome.startsWith('\\\\') ? nome : `\\\\.\\pipe\\${nome}`;
  return nome.startsWith('/') ? nome : join(tmpdir(), `${nome}.sock`);
}

function alguemResponde(caminho: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(caminho);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

function escutar(servidor: Server, caminho: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const falhou = (erro: Error) => {
      servidor.off('listening', ouviu);
      reject(erro);
    };
    const ouviu = () => {
      servidor.off('error', falhou);
      resolve();
    };
    servidor.once('error', falhou);
    servidor.once('listening', ouviu);
    servidor.listen(caminho);
  });
}

export async function abrirCanalDeControle(
  caminho: string,
  acoes: { aoParar: () => Promise<void> },
): Promise<Server> {
  let parando: Promise<void> | null = null;
  const servidor = createServer((conexao) => {
    let recebido = '';
    conexao.setEncoding('utf8');
    conexao.on('error', () => undefined);
    conexao.on('data', (pedaco: string) => {
      recebido += pedaco;
      if (!recebido.includes('\n')) return;
      const comando = recebido.trim();
      if (comando !== 'parar') {
        conexao.end(`comando desconhecido: ${comando.slice(0, 40)}\n`);
        return;
      }
      conexao.write('parando\n');
      parando ??= acoes.aoParar();
      void parando.then(
        () => conexao.end('parado\n'),
        (erro: unknown) => conexao.end(`falhou: ${erro instanceof Error ? erro.message : String(erro)}\n`),
      );
    });
  });

  try {
    await escutar(servidor, caminho);
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw erro;
    if (await alguemResponde(caminho)) {
      throw new Error(
        `já há um supervisor rodando neste canal (${caminho}). Pare-o antes `
          + '(node server/dist/scripts/parar-api.js) — duas APIs disputariam a mesma porta e o mesmo banco.',
        { cause: erro },
      );
    }
    // Socket de arquivo órfão de um supervisor que caiu (só no Linux: o pipe
    // do Windows some com o processo). Ninguém responde nele: pode sair.
    if (process.platform !== 'win32' && existsSync(caminho)) rmSync(caminho, { force: true });
    await escutar(servidor, caminho);
  }
  return servidor;
}

export type RespostaDaParada = 'parado' | 'sem_supervisor' | 'falhou';

/** Pede ao supervisor que pare, e espera a API descer. */
export function pedirParada(caminho: string, limiteMs = 60_000): Promise<RespostaDaParada> {
  return new Promise((resolve) => {
    const s = createConnection(caminho);
    let texto = '';
    let conectou = false;
    const relogio = setTimeout(() => {
      s.destroy();
      resolve('falhou');
    }, limiteMs);
    s.setEncoding('utf8');
    s.on('connect', () => {
      conectou = true;
      s.write('parar\n');
    });
    s.on('data', (pedaco: string) => {
      texto += pedaco;
    });
    s.on('error', () => {
      clearTimeout(relogio);
      resolve(conectou ? 'falhou' : 'sem_supervisor');
    });
    s.on('close', () => {
      clearTimeout(relogio);
      if (!conectou) return resolve('sem_supervisor');
      resolve(/^parado$/m.test(texto) ? 'parado' : 'falhou');
    });
  });
}
