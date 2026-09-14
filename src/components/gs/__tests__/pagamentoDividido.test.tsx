/**
 * O DIÁLOGO QUE DIVIDE O DINHEIRO DA LOJA — a primeira suíte dele.
 *
 * ============================================================================
 * POR QUE ESTE ARQUIVO EXISTE
 * ============================================================================
 *
 * `PagamentoDialog` decide quanto falta receber, quanto é troco, quando o
 * Finalizar acende e o que acontece com cada lançamento — e não era importado
 * por nenhum teste do projeto. A suíte do PDV cobre atalhos, concessão, espera,
 * tabela de preço e peça da oficina; o dinheiro dividido, não.
 *
 * O dono pediu explicitamente que o pagamento dividido estivesse pronto para a
 * entrega: parte em dinheiro, parte no PIX ou no cartão. A conta já estava
 * certa — foi conferida na tela antes de qualquer mudança. O que estava errado
 * era o TECLADO em volta dela.
 *
 * ============================================================================
 * OS TRÊS DEFEITOS DE TECLADO
 * ============================================================================
 *
 * 1. **F5 recarregava o navegador no meio do pagamento.** O `preventDefault` só
 *    acontecia quando `canConfirm` era verdadeiro — e em pagamento dividido ele
 *    é FALSO durante toda a montagem (falta receber). É exatamente aí que o
 *    botão ao lado dizia "Finalizar (F5)". A pessoa apertava a tecla que a tela
 *    mandava apertar e perdia o carrinho inteiro. O PDV já tinha tirado F5 do
 *    próprio mapa por esse motivo, com comentário e teste: "tecla do sistema
 *    operacional pertence ao sistema operacional". O diálogo ficou de fora.
 *
 * 2. **As teclas 1..5 nunca chegavam.** A ajuda do PDV promete "1 a 5 — no
 *    pagamento, escolhe o meio". O ouvinte desistia antes de olhar a tecla
 *    (`if (target?.tagName === 'INPUT') return;`) e o diálogo põe o foco NUM
 *    INPUT ao abrir, e de volta nele depois de cada lançamento. Resultado: o
 *    dígito não escolhia meio nenhum e ia parar no campo de valor — quem
 *    apertava "2" para escolher débito inflava o valor que estava digitando.
 *    Agora é Alt+1..Alt+5, o mesmo idioma do Alt+O da observação: escolhe o
 *    meio sem disputar com os dígitos do valor.
 *
 * 3. **O campo lia CENTAVOS enquanto o resto do PDV lê REAIS.** `parseCents`
 *    jogava fora tudo que não é dígito e tratava o resto como centavos: "50"
 *    virava R$ 0,50. No mesmo balcão, na mesma venda, o campo de preço da linha
 *    usa `parseReaisToCents` — "50" ali é R$ 50,00. Dois campos vizinhos com
 *    regras opostas é erro de digitação garantido, e o erro sai em dinheiro.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PagamentoDialog, type PaymentLine } from '../PagamentoDialog';

const MEIOS = [
  { code: 'dinheiro', label: 'Dinheiro', key: '1', cash: true, deferred: false, active: true },
  { code: 'debito', label: 'Débito', key: '2', cash: false, deferred: false, active: true },
  { code: 'credito', label: 'Crédito', key: '3', cash: false, deferred: false, active: true },
  { code: 'pix', label: 'PIX', key: '4', cash: false, deferred: false, active: true },
];

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/payment-methods')) return json({ items: MEIOS });
      if (u.includes('/terminal')) {
        // Sem maquininha integrada: o cartão é lançado à mão, que é o caso das
        // seis operações hoje.
        return json({ configured: false, provider: null, message: 'Sem maquininha integrada.' });
      }
      return json({ items: [] });
    }),
  );
}

let confirmado: { payments: PaymentLine[]; change: number; surcharge: number } | null;
let cancelado: number;

function montar(totalCents = 24675) {
  render(
    <PagamentoDialog
      totalCents={totalCents}
      onConfirm={(payments, change, surcharge) => {
        confirmado = { payments, change, surcharge };
      }}
      onCancel={() => {
        cancelado += 1;
      }}
    />,
  );
}

/** O campo onde o operador digita o valor recebido. */
const campoValor = () => screen.getByLabelText(/Valor recebido em/i) as HTMLInputElement;

/** Lança um valor no meio corrente. Vazio significa "o que falta". */
function lancar(texto: string) {
  fireEvent.change(campoValor(), { target: { value: texto } });
  fireEvent.click(screen.getByRole('button', { name: /^Lançar$/i }));
}

const finalizar = () => screen.getByRole('button', { name: /^Finalizar/i }) as HTMLButtonElement;

beforeEach(() => {
  confirmado = null;
  cancelado = 0;
  servidor();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================

describe('o cliente paga uma parte em dinheiro e o resto no PIX', () => {
  it('a conta acompanha cada lançamento e o Finalizar só acende no fim', async () => {
    montar(24675);
    await screen.findByRole('button', { name: /^PIX/ });

    // R$ 100,00 em dinheiro numa venda de R$ 246,75.
    lancar('100,00');
    await screen.findByText('R$ 146,75');
    expect(finalizar().disabled).toBe(true);

    // PIX com o campo VAZIO significa "o que falta" — o gesto mais comum.
    fireEvent.click(screen.getByRole('button', { name: /^PIX/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Lançar$/i }));

    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());

    expect(confirmado?.payments).toEqual([
      { method: 'dinheiro', amountCents: 10000 },
      { method: 'pix', amountCents: 14675 },
    ]);
    // Nada de troco: o PIX cobriu exatamente o que faltava.
    expect(confirmado?.change).toBe(0);
  });

  it('troco nunca passa do dinheiro recebido — e o Finalizar recusa se passar', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    /*
      R$ 150 no PIX numa venda de R$ 100 não gera R$ 50 de troco: o troco sai da
      GAVETA, e a gaveta não recebeu nada. Devolver aqui seria tirar dinheiro
      vivo contra uma transferência.
    */
    fireEvent.click(screen.getByRole('button', { name: /^PIX/ }));
    lancar('150,00');

    /*
      A RECUSA AGORA VEM ANTES DO LANÇAMENTO (D-pdv-teclado-M03). O valor em
      PIX e cartão não passa do que falta receber — e isso também fecha o bipe
      que caía no campo de valor e virava cobrança de trilhões na maquininha.
      Nada é lançado, e o Finalizar continua apagado.
    */
    expect((await screen.findByTestId('pagamento-aviso')).textContent).toMatch(
      /não pode passar do que falta receber/,
    );
    expect(finalizar().disabled).toBe(true);

    /*
      O GUARDA DO TROCO CONTINUA DE PÉ para o caminho que ainda chega nele: o
      PIX lançado com acréscimo, e o acréscimo apagado depois. O troco que
      sobra não saiu da gaveta, e o Finalizar recusa.
    */
    const acrescimo = screen.getByRole('textbox', { name: 'Acréscimo (juros, frete)' });
    fireEvent.change(acrescimo, { target: { value: '50,00' } });
    lancar('150,00');
    await waitFor(() => expect(screen.queryByTestId('pagamento-aviso')).toBeNull());
    fireEvent.change(acrescimo, { target: { value: '' } });

    await screen.findByText(/Troco só é possível sobre o valor recebido em dinheiro/i);
    expect(finalizar().disabled).toBe(true);
  });

  it('dinheiro a mais vira troco', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    lancar('150,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());

    expect(confirmado?.change).toBe(5000);
  });
});

// ============================================================================

describe('o campo de valor fala a mesma língua do resto do PDV', () => {
  it('"50" é cinquenta reais, e não cinquenta centavos', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    /*
      No mesmo balcão, na mesma venda, o campo de preço da linha usa
      `parseReaisToCents`: "50" ali é R$ 50,00. Dois campos vizinhos com regras
      opostas é erro de digitação garantido — e o erro sai em dinheiro.
    */
    lancar('50');
    // "Falta receber" e o lançamento mostram o mesmo número — os dois provam
    // que o campo leu reais: em centavos seriam R$ 0,50 e R$ 99,50.
    expect((await screen.findAllByText('R$ 50,00')).length).toBeGreaterThan(0);
    // E ainda falta metade da venda.
    expect(finalizar().disabled).toBe(true);
  });

  it('"1.250,00" é mil duzentos e cinquenta reais', async () => {
    montar(125000);
    await screen.findByRole('button', { name: /^PIX/ });

    lancar('1.250,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());
    expect(confirmado?.payments).toEqual([{ method: 'dinheiro', amountCents: 125000 }]);
  });
});

// ============================================================================

describe('as teclas do balcão', () => {
  it('Alt+2 escolhe o débito COM o foco no campo de valor — e nenhum dígito entra', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^Débito/ });

    const campo = campoValor();
    campo.focus();
    fireEvent.keyDown(campo, { key: '2', altKey: true });

    expect(await screen.findByText(/Valor recebido em Débito/i)).toBeTruthy();
    /*
      O campo tinha que continuar vazio. Antes, o dígito da escolha ia parar
      dentro do valor: quem apertava "2" para escolher débito somava um 2 ao
      número que estava digitando, e o lançamento saía errado.
    */
    expect(campoValor().value).toBe('');
  });

  it('F5 NÃO finaliza a venda — ela é do navegador', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });
    lancar('100,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));

    /*
      O PDV tirou F5 do próprio mapa de propósito, com comentário e teste:
      "tecla do sistema operacional pertence ao sistema operacional". O diálogo
      ficou de fora e sequestrava a tecla — mas SÓ quando podia finalizar. Em
      pagamento dividido, que é quando o Finalizar está desabilitado, a tecla
      passava direto e recarregava a página com o carrinho montado.
    */
    fireEvent.keyDown(window, { key: 'F5' });
    expect(confirmado).toBeNull();
  });

  it('F10 finaliza — a mesma tecla que abriu o pagamento o conclui', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });
    lancar('100,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));

    fireEvent.keyDown(window, { key: 'F10' });
    expect(confirmado?.payments).toEqual([{ method: 'dinheiro', amountCents: 10000 }]);
  });

  it('F10 com o pagamento incompleto não fecha nada', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });
    lancar('40,00');

    fireEvent.keyDown(window, { key: 'F10' });
    expect(confirmado).toBeNull();
  });
});

// ============================================================================

describe('sair do pagamento não joga fora o que já foi lançado', () => {
  it('com lançamentos na lista, o Voltar pede confirmação', async () => {
    montar(24675);
    await screen.findByRole('button', { name: /^PIX/ });
    lancar('100,00');
    await screen.findByText('R$ 146,75');

    fireEvent.click(screen.getByRole('button', { name: /Voltar/i }));

    /*
      A lista mora no estado do diálogo, e o PDV monta o diálogo sob
      `showPayment`: qualquer saída desmonta e joga tudo fora. Com três meios já
      lançados e o cliente na frente, refazer tudo por causa de um Esc na tecla
      errada é o tipo de perda que a tela pode evitar perguntando.
    */
    expect(await screen.findByText(/lançamento/i)).toBeTruthy();
    expect(cancelado).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /Descartar/i }));
    expect(cancelado).toBe(1);
  });

  it('sem lançamento nenhum, o Voltar volta na hora', async () => {
    montar(24675);
    await screen.findByRole('button', { name: /^PIX/ });

    fireEvent.click(screen.getByRole('button', { name: /Voltar/i }));
    // Perguntar aqui seria atrito puro: não há nada para perder.
    expect(cancelado).toBe(1);
  });
});

// ============================================================================

describe('o acréscimo tem onde ser lançado', () => {
  it('juros e frete entram no total a receber e voltam no confirmar', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    /*
      A faixa "Acima do preço vigente" instruía, com todas as letras:
      "Acréscimo de verdade — juros, frete — entra no pagamento, onde fica
      visível". No pagamento não havia onde. O servidor aceita `surchargeCents`
      desde sempre, com coluna própria, recusa de valor negativo e regra escrita
      para não inflar a base de comissão — um campo inteiro sem leitor.

      Sem ele, quem precisa cobrar frete sobe o preço da linha: vira "acima do
      vigente", que o servidor recusa, e o frete acaba virando desconto ao
      contrário na cabeça de quem confere depois.
    */
    fireEvent.change(screen.getByLabelText(/Acréscimo/i), { target: { value: '15,00' } });

    // R$ 100 de mercadoria + R$ 15 de frete: o cliente paga R$ 115 — e o
    // mesmo número aparece no total e no que falta receber.
    await waitFor(() => expect(screen.getAllByText('R$ 115,00').length).toBeGreaterThan(0));
    lancar('115,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());

    expect(confirmado?.surcharge).toBe(1500);
    expect(confirmado?.change).toBe(0);
  });

  it('sem acréscimo, nada muda — o campo vazio não vira zero na venda', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    lancar('100,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));
    fireEvent.click(finalizar());

    expect(confirmado?.surcharge).toBe(0);
  });

  it('o Finalizar não acende enquanto o acréscimo não estiver coberto', async () => {
    montar(10000);
    await screen.findByRole('button', { name: /^PIX/ });

    lancar('100,00');
    await waitFor(() => expect(finalizar().disabled).toBe(false));

    // O frete entra DEPOIS de o cliente já ter pago a mercadoria: faltam R$ 15.
    fireEvent.change(screen.getByLabelText(/Acréscimo/i), { target: { value: '15,00' } });
    await waitFor(() => expect(finalizar().disabled).toBe(true));
    expect(screen.getByText('R$ 15,00')).toBeTruthy();
  });
});
