/**
 * ============================================================================
 * PARAR A API — a parada planejada, sem derrubar ninguém no meio (GAP-PRD-013)
 * ============================================================================
 *
 *     node server/dist/scripts/parar-api.js
 *
 * Fala com o supervisor pelo canal de controle local: ele pede à API que desça
 * limpa (termina o que está em andamento, fecha as conexões e o banco) e só
 * então sai. É o primeiro passo de atualizar a versão e o que
 * `deploy/windows/remover-servico.ps1` faz antes de remover a tarefa.
 *
 * Encerrar a tarefa agendada à força NÃO é a mesma coisa: no Windows a API
 * está no mesmo "job" do supervisor e morre junto, na hora.
 *
 * Sai com 0 quando parou, 2 quando não há supervisor rodando, 1 se falhou.
 */
import { ensureDotEnvLoaded } from '../config/env.js';
import { caminhoDoCanal, pedirParada } from '../services/implantacao/canalDeControle.js';

async function main(): Promise<number> {
  ensureDotEnvLoaded();
  const canal = caminhoDoCanal();
  console.log(`Pedindo ao supervisor (${canal}) que pare a API...`);
  const resposta = await pedirParada(canal);
  if (resposta === 'parado') {
    console.log('A API desceu limpa e o supervisor saiu.');
    return 0;
  }
  if (resposta === 'sem_supervisor') {
    console.log('Não há supervisor rodando neste canal. Nada a parar.');
    return 2;
  }
  console.log('O supervisor não confirmou a parada a tempo. Confira o log em server/data/logs.');
  return 1;
}

void main().then((codigo) => process.exit(codigo));
