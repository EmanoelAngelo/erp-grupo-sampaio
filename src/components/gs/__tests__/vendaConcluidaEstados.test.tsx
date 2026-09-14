/**
 * A TELA DE VENDA CONCLUÍDA — os estados fiscais que eram "pendente" e o
 * leitor que ficava mudo durante a impressão.
 *
 * F-cupom-fiscal-01/02 — rejeitada, erro e contingência apareciam como
 * "PENDENTE — a nota segue na fila e será transmitida. Imprimir entrega o
 * comprovante NÃO fiscal": falso para os três.
 *
 * D-pdv-teclado-M07 — com "Imprimindo…", o botão focado ficava `disabled`, o
 * foco caía no `body`, e o bipe do próximo produto se perdia no corpo da página.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VendaConcluidaDialog, type VendaConcluida } from '../VendaConcluidaDialog';

function venda(estadoFiscal: VendaConcluida['estadoFiscal']): VendaConcluida {
  return {
    numero: 101,
    totalCents: 5270,
    trocoCents: 0,
    pagamentos: [{ rotulo: 'Dinheiro', valorCents: 5270 }],
    itens: [{ descricao: 'ARROZ', quantidade: 1, totalCents: 5270 }],
    estadoFiscal,
  };
}

afterEach(() => cleanup());

describe('cada estado fiscal diz a verdade', () => {
  it('REJEITADA: vermelha, com o motivo da SEFAZ, e sem prometer transmissão', () => {
    render(
      <VendaConcluidaDialog
        venda={venda({ tipo: 'rejeitada', motivo: '778 — NCM inexistente' })}
        onImprimir={() => undefined}
        onNovaVenda={() => undefined}
      />,
    );
    const faixa = screen.getByTestId('venda-concluida-fiscal');
    expect(faixa.getAttribute('data-estado')).toBe('rejeitada');
    expect(faixa.textContent).toContain('REJEITADA');
    expect(faixa.textContent).toContain('778');
    expect(faixa.textContent).not.toMatch(/será transmitida/);
  });

  it('ERRO sem nova tentativa: diz que a venda está sem nota', () => {
    render(
      <VendaConcluidaDialog
        venda={venda({ tipo: 'erro', motivo: 'Certificado vencido' })}
        onImprimir={() => undefined}
        onNovaVenda={() => undefined}
      />,
    );
    const faixa = screen.getByTestId('venda-concluida-fiscal');
    expect(faixa.getAttribute('data-estado')).toBe('erro');
    expect(faixa.textContent).toContain('sem nota');
    expect(faixa.textContent).toContain('Certificado vencido');
  });

  it('CONTINGÊNCIA: o papel é o DANFCE de contingência — e nada de "NÃO fiscal"', () => {
    render(
      <VendaConcluidaDialog
        venda={venda({ tipo: 'contingencia', prazo: null })}
        onImprimir={() => undefined}
        onNovaVenda={() => undefined}
      />,
    );
    const faixa = screen.getByTestId('venda-concluida-fiscal');
    expect(faixa.getAttribute('data-estado')).toBe('contingencia');
    expect(faixa.textContent).toContain('DANFCE de contingência');
    expect(faixa.textContent).not.toMatch(/NÃO fiscal/);
  });
});

describe('imprimindo, o leitor não fica mudo', () => {
  it('o botão focado não vira `disabled`, e o clique durante a impressão é ignorado', () => {
    const imprimir = vi.fn();
    render(
      <VendaConcluidaDialog
        venda={venda({ tipo: 'nao_fiscal' })}
        imprimindo
        onImprimir={imprimir}
        onNovaVenda={() => undefined}
      />,
    );
    const botao = screen.getByRole('button', { name: /Imprimindo/ }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    expect(botao.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(botao);
    expect(imprimir).not.toHaveBeenCalled();
  });

  it('com o foco no corpo da página, o bipe ainda chega ao campo de leitura', () => {
    const digitado = vi.fn();
    render(
      <VendaConcluidaDialog
        venda={venda({ tipo: 'nao_fiscal' })}
        imprimindo
        onImprimir={() => undefined}
        onNovaVenda={() => undefined}
        onDigitacao={digitado}
      />,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: '7' });
    expect(digitado).toHaveBeenCalledWith('7');
  });
});
