import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configure, getConfig } from '@testing-library/react';

/**
 * ============================================================================
 * O ORÇAMENTO DAS ESPERAS É UM SÓ — E O LOCAL SÓ PODE ALARGAR
 * ============================================================================
 *
 * ## O defeito, e por que ele só aparece na suíte inteira
 *
 * `setup.ts` define UM orçamento para toda espera de tela (`asyncUtilTimeout`),
 * dimensionado para a máquina saturada, e explica ali por quê: com os forks
 * disputando os núcleos, esperas por condições CERTAS levam mais de 1 s, e o
 * default de 1 s do testing-library reprova código correto.
 *
 * Só que vinte chamadas espalhadas pela suíte passavam um `{ timeout: N }`
 * PRÓPRIO, com N menor que o orçamento. Elas nasceram ALARGANDO o default
 * antigo de 1 s — 2 s, 3 s, 4 s eram folga. No dia em que o orçamento da suíte
 * subiu, cada uma virou o contrário do que foi escrita para ser: um APERTO,
 * silencioso, de 5 s para 2 s, exatamente nos arquivos mais pesados (PDV,
 * plaquinha, etiquetas). Nada apontou a inversão, porque o número local não
 * menciona o global e o global não sabe dos locais.
 *
 * O que isso custou: numa corrida da suíte inteira,
 * `plaquinhaDaPjNaUnidade.test.tsx` falhou ao esperar 2 s por um botão que
 * aparece — e o MESMO arquivo passa sozinho em 2,9 s. Vermelho que depende de
 * quem mais está rodando não é teste: é ruído que ensina a gente a reexecutar
 * a suíte até ficar verde, e reexecutar até passar é como um defeito de
 * verdade atravessa a entrega.
 *
 * ## A regra que este arquivo cobra
 *
 * Orçamento local ABAIXO do da suíte é sempre um aperto acidental: o único
 * efeito possível é desistir mais cedo do que a suíte decidiu. Alargar
 * continua permitido — uma espera que legitimamente demora mais diz isso na
 * própria linha, e aparece na revisão.
 *
 * Não é uma regra de estilo: é a diferença entre uma suíte que mede o produto
 * e uma que mede a carga da máquina.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '..', '..');

function arquivosDeTeste(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivosDeTeste(caminho, acc);
    else if (/\.test\.tsx?$/.test(nome)) acc.push(caminho);
  }
  return acc;
}

describe('o orçamento das esperas da suíte de tela', () => {
  it('vale de verdade em execução — é o do setup, e não o default de 1 s do testing-library', () => {
    expect(getConfig().asyncUtilTimeout).toBe(5_000);
  });

  it('nenhuma espera aperta o orçamento da suíte por conta própria', () => {
    const orcamento = getConfig().asyncUtilTimeout;
    const apertos: string[] = [];

    for (const arquivo of arquivosDeTeste(SRC)) {
      /*
        Este arquivo é o único isento, e por um motivo que não se generaliza:
        o caso abaixo PRECISA de um orçamento apertado (20 ms) para demonstrar
        que apertar aperta. Isentá-lo aqui é mais honesto do que escrever o
        número por partes só para escapar da própria varredura.
      */
      if (resolve(arquivo) === resolve(fileURLToPath(import.meta.url))) continue;
      const texto = readFileSync(arquivo, 'utf8');
      const linhas = texto.split('\n');
      linhas.forEach((linha, i) => {
        const achado = /\btimeout:\s*(\d[\d_]*)/.exec(linha);
        if (!achado) return;
        const valor = Number(achado[1].replace(/_/g, ''));
        if (valor >= orcamento) return;
        apertos.push(
          `${relative(SRC, arquivo).replace(/\\/g, '/')}:${i + 1} espera ${valor} ms, `
          + `abaixo dos ${orcamento} ms da suíte — tire o número e deixe o orçamento único valer.`,
        );
      });
    }

    expect(apertos.join('\n')).toBe('');
  });

  it('e o aperto seria mesmo um aperto: o orçamento menor manda no maior', async () => {
    /*
      A falsificação da regra acima. Sem este caso, "local abaixo do global é
      aperto" seria só a nossa leitura da documentação do testing-library —
      e a regra inteira ficaria de pé sobre uma suposição não medida.

      `waitFor` com orçamento local de 20 ms desiste de uma condição que só
      fica verdadeira aos 200 ms, ENQUANTO o orçamento da suíte é de 5 s. Se
      um dia o local passasse a apenas sugerir, este caso fica vermelho e a
      varredura acima perde o sentido junto — que é como deve ser.
    */
    const { waitFor } = await import('@testing-library/react');
    expect(getConfig().asyncUtilTimeout).toBe(5_000);

    const comecou = Date.now();
    let pronto = false;
    const relogio = setTimeout(() => { pronto = true; }, 200);
    try {
      await expect(
        waitFor(() => { expect(pronto).toBe(true); }, { timeout: 20 }),
      ).rejects.toThrow();
      // Desistiu MUITO antes dos 5 s da suíte: o número local mandou.
      expect(Date.now() - comecou).toBeLessThan(2_000);
    } finally {
      clearTimeout(relogio);
      configure({ asyncUtilTimeout: 5_000 });
    }
  });
});
