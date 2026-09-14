/**
 * ============================================================================
 * SUPERVISIONAR A API — o comando que a tarefa do Windows sobe (GAP-PRD-013)
 * ============================================================================
 *
 *     node server/dist/scripts/supervisionar-api.js
 *
 * Roda na RAIZ da instalação (onde está o `.env`). Sobe a API
 * (`server/dist/index.js`), a levanta de novo quando ela cai e grava a saída
 * em `DEVORA_LOG_DIR` (padrão `server/data/logs`), um arquivo por dia da loja,
 * guardando `DEVORA_LOG_RETENCAO_DIAS` dias (padrão 30).
 *
 * Quem o registra como tarefa que sobe com o Windows é
 * `deploy/windows/instalar-servico.ps1`. Em Linux, prefira a unidade systemd
 * de `deploy/linux/` (que já reinicia sozinha); em Docker, o `restart:` do
 * compose — nenhum dos dois precisa deste comando.
 *
 * PARAR DE PROPÓSITO é `node server/dist/scripts/parar-api.js`: pelo canal de
 * controle, a API desce limpa (fecha conexões e o banco) e só então este
 * processo sai. Encerrar a tarefa à força derruba a API junto, na hora — no
 * Windows o filho está no mesmo "job" do pai. Ctrl+C num terminal também
 * desce limpo.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDotEnvLoaded } from '../config/env.js';
import { repoRoot } from '../db/sqlite.js';
import { abrirCanalDeControle, caminhoDoCanal } from '../services/implantacao/canalDeControle.js';
import { criarRegistroDiario, retencaoDoAmbiente } from '../services/implantacao/registroEmArquivo.js';
import { iniciarSupervisor, type Supervisor } from '../services/implantacao/supervisor.js';

async function main(): Promise<void> {
  ensureDotEnvLoaded();
  const aqui = dirname(fileURLToPath(import.meta.url));
  // Compilado: dist/scripts → dist/index.js. Pelo tsx (desenvolvimento):
  // src/scripts → src/index.ts, carregado com `--import tsx`.
  const compilado = import.meta.url.endsWith('.js');
  const entrada = resolve(aqui, '..', compilado ? 'index.js' : 'index.ts');
  if (!existsSync(entrada)) {
    console.error(`Não achei ${entrada}. Rode \`npm run build\` na raiz da instalação.`);
    process.exit(1);
  }

  const raiz = repoRoot();
  const pastaDeLogs = process.env.DEVORA_LOG_DIR?.trim()
    ? resolve(raiz, process.env.DEVORA_LOG_DIR.trim())
    : resolve(raiz, 'server', 'data', 'logs');
  const registro = criarRegistroDiario({
    pasta: pastaDeLogs,
    retencaoDias: retencaoDoAmbiente(process.env.DEVORA_LOG_RETENCAO_DIAS),
  });
  const saida = (texto: string): void => {
    process.stdout.write(texto);
    registro.escrever(texto);
  };

  let supervisor: Supervisor | null = null;
  let saindo: Promise<void> | null = null;
  const encerrar = (motivo: string): Promise<void> => {
    saindo ??= (async () => {
      saida(`${JSON.stringify({ level: 'info', message: 'SUPERVISOR_ENCERRANDO', motivo })}\n`);
      await supervisor?.parar();
      registro.descarregar();
      // Dá tempo de a resposta do canal ("parado") chegar a quem pediu.
      setTimeout(() => process.exit(0), 200);
    })();
    return saindo;
  };

  // O canal abre ANTES da API: se já há um supervisor, este não sobe outra.
  const canal = caminhoDoCanal();
  try {
    await abrirCanalDeControle(canal, { aoParar: () => encerrar('parar-api') });
  } catch (erro) {
    saida(
      `${JSON.stringify({ level: 'error', message: 'SUPERVISOR_JA_RODANDO', erro: erro instanceof Error ? erro.message : String(erro) })}\n`,
    );
    registro.descarregar();
    process.exit(1);
  }

  saida(`${JSON.stringify({ level: 'info', message: 'SUPERVISOR_INICIADO', entrada, logs: pastaDeLogs, canal })}\n`);
  supervisor = iniciarSupervisor({
    entrada,
    argumentosDoNode: compilado ? [] : ['--import', 'tsx'],
    cwd: process.cwd(),
    env: process.env,
    saida,
  });

  for (const sinal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sinal, () => {
      void encerrar(sinal);
    });
  }
}

void main();
