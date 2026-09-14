import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Roda antes de qualquer import de módulo do app, para que cada worker
    // aponte para seu próprio arquivo SQLite.
    setupFiles: ['tests/setup.ts'],

    /**
     * A PASTA-RAIZ DOS BANCOS TEMPORÁRIOS, criada e APAGADA uma vez.
     *
     * `setupFiles` roda dentro de cada worker, e o worker morre com o SQLite
     * aberto — a limpeza de lá falhava em 100% dos arquivos e deixava 155
     * pastas (935 MB) por execução. `globalSetup` roda no processo principal: o
     * `teardown` só é chamado quando TODOS os workers já morreram, que é o
     * único momento em que não existe handle aberto para segurar arquivo
     * nenhum. Ver o cabeçalho de `tests/global-setup.ts`.
     */
    globalSetup: ['tests/global-setup.ts'],

    /**
     * Cada arquivo roda em processo próprio, com banco SQLite próprio e grafo
     * de módulos próprio — são 141 arquivos pagando esse preço inteiro. No
     * default do Vitest isso vira `núcleos - 1` processos disputando a máquina,
     * e o que estoura não é a memória: é o relógio de cada teste.
     *
     * O sintoma aqui foi cinco testes vermelhos numa rodada e verdes na
     * seguinte, sem nenhuma mudança de código — sempre por tempo, nunca por
     * asserção. Suíte que muda de cor sozinha não serve de gate: a pessoa
     * aprende a rodar de novo até passar, e nesse hábito um vermelho de verdade
     * some junto.
     *
     * A medição vem do config do frontend, na mesma máquina de 8 núcleos: com 7
     * forks, o tempo só de EXECUTAR saltou de 248s para 565s entre duas rodadas
     * do MESMO commit, e a suíte ficou vermelha em 2 de 4. Metade dos núcleos
     * deixa folga para o trabalho que cada fork realmente faz, em vez de
     * multiplicar a fila de espera.
     */
    poolOptions: {
      forks: {
        maxForks: Math.max(2, Math.floor(cpus().length / 2)),
      },
    },

    /**
     * O default de 5s não é um contrato do produto: é um cronômetro da máquina.
     * Nada aqui promete responder em 5s — são migrações e consultas locais em
     * SQLite. O que enche esse orçamento é a carga do grafo de módulos e, nos
     * arquivos de migração, a reconstrução de tabela em disco: `schema-drift`
     * sozinho leva quase 9s.
     *
     * Um valor único e generoso devolve ao timeout a única função que ele tem
     * aqui — pegar travamento de verdade — em vez de reprovar código correto
     * por a máquina estar ocupada.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
