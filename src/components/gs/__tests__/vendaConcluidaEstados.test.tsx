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
import { useEffect, useState } from 'react';
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

describe('a tela nasce pronta para o leitor — foco e ouvinte ligam no commit', () => {
  /*
    A TELA APARECE COM A RESPOSTA DO SERVIDOR, FORA DE QUALQUER EVENTO, e o
    React desenha essa atualização numa tarefa do agendador. O foco no
    Imprimir, a armadilha de foco e o ouvinte do Esc e do bipe eram ligados em
    `useEffect` — que roda DEPOIS do commit, numa volta seguinte do agendador.
    Entre as duas voltas a tela já estava de pé com o foco onde a venda o
    deixou e sem ouvinte nenhum: o primeiro caractere do próximo código caía na
    página (não fechava a tela nem chegava ao campo de leitura), e o Esc não
    começava a próxima venda. A mesma classe do 808c1c9 no PDV.

    O dublê é o PDV em miniatura: a venda chega por uma promessa, como a
    resposta do POST, e o teste tecla ASSIM que a tela aparece — sem esperar
    mais nada, que é o que o leitor faz.
  */
  function TelaQueChegaDepois({
    onDigitacao,
    onNovaVenda,
  }: {
    onDigitacao: (tecla: string) => void;
    onNovaVenda: () => void;
  }) {
    const [concluida, setConcluida] = useState<VendaConcluida | null>(null);
    useEffect(() => {
      void Promise.resolve().then(() => setConcluida(venda({ tipo: 'nao_fiscal' })));
    }, []);
    return concluida ? (
      <VendaConcluidaDialog
        venda={concluida}
        onImprimir={() => undefined}
        onNovaVenda={onNovaVenda}
        onDigitacao={onDigitacao}
      />
    ) : null;
  }

  it('o primeiro caractere do bipe, logo que a tela aparece, segue para o campo de leitura', async () => {
    const digitado = vi.fn();
    render(<TelaQueChegaDepois onDigitacao={digitado} onNovaVenda={() => undefined} />);
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    // Enter imprime: o foco já está no Imprimir no instante em que a tela aparece.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Imprimir/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: '7' });
    expect(digitado).toHaveBeenCalledWith('7');
  });

  it('o Esc, logo que a tela aparece, já começa a próxima venda', async () => {
    const novaVenda = vi.fn();
    render(<TelaQueChegaDepois onDigitacao={() => undefined} onNovaVenda={novaVenda} />);
    await screen.findByRole('dialog', { name: 'Venda concluída' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(novaVenda).toHaveBeenCalledTimes(1);
  });
});
