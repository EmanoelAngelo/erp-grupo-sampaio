/**
 * O NÚMERO DO KPI NÃO PODE ESCONDER DÍGITO — rodada 56.
 *
 * ## O defeito, e por que ele nasceu de um conserto
 *
 * Até a rodada 56, `text-[var(--gs-text-3xl)]` virava uma regra de COR
 * inválida (a ambiguidade do `text-[…]` do Tailwind) e o valor do KPI herdava
 * os 15px do corpo. Cabia em qualquer cartão — por acidente.
 *
 * Ao fazer a escala de tipo funcionar, os 36px passaram a valer de verdade. E
 * a faixa de quatro colunas do Painel dá ~180px de caixa num notebook de
 * 1280: "R$ 128.430,55" pede 239px. O gestor lia o faturamento com o último
 * dígito coberto pelo cartão vizinho.
 *
 * Dois detalhes impedem o texto de se ajeitar sozinho, e é por isso que o
 * conserto precisou ser explícito:
 *
 *   `formatCents` separa o "R$" do número com espaço NÃO-SEPARÁVEL (U+00A0),
 *   então o valor é UMA palavra e não quebra linha.
 *
 *   A grade do Tailwind usa `minmax(0, 1fr)`, então a coluna não cresce até o
 *   conteúdo.
 *
 * ## Por que este teste mede o CSS, e não a tela
 *
 * jsdom não faz layout: `clientWidth` é sempre zero e nenhum teste de
 * renderização consegue ver o transbordo. O que dá para travar aqui é a
 * DECISÃO — que o valor tem um tamanho elástico amarrado à largura do próprio
 * cartão — e é ela que impede o dígito de sumir. A medida de verdade foi
 * feita no navegador, contra o banco real, e está no comentário do componente.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { Kpi } from '../ui';

afterEach(cleanup);

describe('o valor do KPI cabe no cartão', () => {
  it('o tamanho do número é elástico, e o teto é o degrau da escala', () => {
    render(<Kpi label="Faturamento" value="R$ 128.430,55" />);
    const valor = screen.getByText('R$ 128.430,55');

    /*
      Três coisas, e cada uma responde a um jeito de o dígito sumir:

        `cqw`   — o tamanho segue a largura do CARTÃO, não a da janela: é o
                  cartão que aperta na faixa de quatro colunas.
        `clamp` — há um piso (o número não some) e um teto (onde sobra espaço,
                  ele volta ao degrau cheio da escala).
        o teto é o TOKEN, e não um número solto: a escala continua sendo a
                  fonte, e um degrau novo não deixa este cartão para trás.
    */
    const tamanho = valor.style.fontSize;
    expect(tamanho).toContain('cqw');
    expect(tamanho).toContain('clamp');
    expect(tamanho).toContain('var(--gs-text-3xl)');
  });

  it('o cartão é o contêiner que a medida do número consulta', () => {
    render(<Kpi label="Vendas" value="128" />);
    const cartao = screen.getByText('Vendas').parentElement!;
    // Sem isto o `cqw` mede a JANELA, e o número volta a ignorar o aperto da
    // coluna — que é exatamente o estado que produziu o defeito.
    expect(cartao.style.containerType).toBe('inline-size');
  });

  it('nada de cortar nem de quebrar: o valor sai inteiro no DOM', () => {
    render(<Kpi label="A receber" value="R$ 1.234.567,89" />);
    const valor = screen.getByText('R$ 1.234.567,89');
    /*
      As duas saídas fáceis são piores que o defeito: `truncate` esconde
      dígito, e quebrar linha parte o valor no meio — "R$ 1.234.567," numa
      linha e "89" na outra é um número que ninguém consegue ler direito.
    */
    expect(valor.className).not.toContain('truncate');
    expect(valor.className).not.toContain('break-');
    expect(valor.textContent).toBe('R$ 1.234.567,89');
  });
});
