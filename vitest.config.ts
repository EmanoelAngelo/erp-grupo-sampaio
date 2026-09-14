import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    /**
     * QUALQUER teste sob `src` roda.
     *
     * A lista anterior nomeava duas pastas — `src/lib/__tests__` e
     * `src/components/__tests__`. Um teste escrito em `src/pages`,
     * `src/guards`, `src/hooks` ou `src/stores` simplesmente não era coletado:
     * ficava verde por nunca ter rodado, que é o pior tipo de verde, porque dá
     * confiança sem dar cobertura.
     *
     * O padrão agora é por EXTENSÃO, não por pasta. Escrever um teste em
     * qualquer lugar do frontend passa a bastar para ele contar.
     */
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/lib/__tests__/setup.ts'],

    /**
     * Cada arquivo de teste roda em um processo próprio, com jsdom próprio e
     * grafo de módulos próprio. No default do Vitest isso vira `núcleos - 1`
     * processos disputando a máquina, e o que estoura não é a memória: é o
     * relógio de cada teste.
     *
     * Medido nesta máquina (8 núcleos): com 7 forks, o tempo só de EXECUTAR os
     * testes saltou de 248s para 565s entre duas rodadas do MESMO commit, e a
     * suíte ficou vermelha em 2 de 4 rodadas — sempre por timeout, nunca por
     * asserção. Metade dos núcleos deixa folga para o trabalho que cada fork
     * realmente faz, em vez de multiplicar a fila de espera.
     */
    poolOptions: {
      forks: {
        maxForks: Math.max(2, Math.floor(cpus().length / 2)),
      },
    },

    /**
     * O default de 5s não é um contrato do produto: é um cronômetro da máquina.
     * Nenhum módulo daqui promete responder em 5s — são cálculos locais, na
     * casa das dezenas de milissegundos. O que enchia esse orçamento era a
     * carga do grafo de módulos (segundos na primeira chamada), que cai dentro
     * do `it` que chamar o serviço primeiro.
     *
     * Um valor único e generoso devolve ao timeout a única função que ele tem
     * aqui — pegar travamento de verdade — em vez de reprovar código correto
     * por a máquina estar ocupada.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});