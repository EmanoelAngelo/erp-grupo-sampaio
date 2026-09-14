/**
 * Venda em espera (F7).
 *
 * O DEFEITO QUE ORIGINOU ISTO
 *
 * O botão "Aguardar (F7)" mostrava "Venda em espera." e não fazia nada: o
 * carrinho continuava na tela e nenhuma espera existia. O operador confiava na
 * mensagem, atendia o próximo cliente e perdia o carrinho. Mensagem que afirma
 * um fato que não aconteceu é pior que botão nenhum.
 *
 * O que se cobra aqui é o que separa "espera" de "pré-venda": a espera guarda
 * o carrinho, sobrevive ao refresh, pertence ao TURNO e não reserva estoque.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as espera from '../pdvEmEspera';
import type { CartLine } from '../pdvTypes';

const TURNO = 'caixa-1';
const OUTRO_TURNO = 'caixa-2';

function carrinho(quantidade = 2): CartLine[] {
  return [
    {
      product: { id: 'p-1', name: 'Camiseta', price_cents: 5000 } as CartLine['product'],
      quantity: quantidade,
      unitPriceCents: 5000,
    },
  ];
}

function guardar(over: Partial<Parameters<typeof espera.guardar>[0]> = {}) {
  return espera.guardar({
    escopo: TURNO,
    lines: carrinho(),
    customerId: null,
    customerName: null,
    discount: 0,
    note: '',
    ...over,
  });
}

beforeEach(() => localStorage.clear());

describe('guardar', () => {
  it('guarda o carrinho e ele aparece na lista do turno', () => {
    const v = guardar();
    expect(v).not.toBeNull();
    expect(espera.listar(TURNO)).toHaveLength(1);
    expect(espera.listar(TURNO)[0].lines[0].product.id).toBe('p-1');
  });

  it('recusa carrinho vazio — "esperar nada" encheria a lista de itens ocos', () => {
    expect(guardar({ lines: [] })).toBeNull();
    expect(espera.listar(TURNO)).toHaveLength(0);
  });

  it('o rótulo usa o cliente quando há um, senão a contagem e a hora', () => {
    const comCliente = guardar({ customerId: 'c-1', customerName: 'Ana Silva' });
    expect(comCliente!.rotulo).toBe('Ana Silva');

    localStorage.clear();
    const semCliente = guardar();
    expect(semCliente!.rotulo).toContain('item(ns)');
  });

  it('preserva desconto e observação — retomar não pode perder o combinado', () => {
    guardar({ discount: 500, note: 'Cliente volta às 15h' });
    const [v] = espera.listar(TURNO);
    expect(v.discount).toBe(500);
    expect(v.note).toBe('Cliente volta às 15h');
  });

  it('duas esperas convivem', () => {
    guardar({ customerName: 'Ana' });
    guardar({ customerName: 'Bruno' });
    expect(espera.listar(TURNO).map((v) => v.rotulo)).toEqual(['Ana', 'Bruno']);
  });
});

describe('sobrevive ao refresh', () => {
  it('a espera continua lá quando a tela recarrega', () => {
    guardar({ customerName: 'Ana' });
    // Recarregar a página só zera a memória; o armazenamento permanece.
    expect(espera.listar(TURNO)).toHaveLength(1);
    expect(localStorage.getItem('gs.pdv.emEspera')).toContain('Ana');
  });
});

describe('o turno é o dono', () => {
  it('espera de outro turno NÃO aparece no turno corrente', () => {
    guardar({ escopo: OUTRO_TURNO, customerName: 'De ontem' });
    guardar({ customerName: 'De hoje' });

    // Preço e estoque de ontem não valem hoje: a espera antiga não pode
    // reaparecer como se ainda fosse faturável.
    expect(espera.listar(TURNO).map((v) => v.rotulo)).toEqual(['De hoje']);
  });

  it('fechar o turno limpa só as esperas dele', () => {
    guardar({ escopo: OUTRO_TURNO, customerName: 'Outro caixa' });
    guardar({ customerName: 'Este caixa' });

    espera.limparEscopo(TURNO);

    expect(espera.listar(TURNO)).toHaveLength(0);
    expect(espera.listar(OUTRO_TURNO)).toHaveLength(1);
  });
});

describe('retomar', () => {
  it('devolve o carrinho e REMOVE da lista', () => {
    const guardada = guardar({ customerName: 'Ana', discount: 300 });

    const retomada = espera.retomar(guardada!.id);

    expect(retomada!.discount).toBe(300);
    // Sair da lista é o que impede o mesmo carrinho de ser faturado duas vezes.
    expect(espera.listar(TURNO)).toHaveLength(0);
  });

  it('retomar duas vezes o mesmo id devolve nada na segunda', () => {
    const guardada = guardar();
    expect(espera.retomar(guardada!.id)).not.toBeNull();
    expect(espera.retomar(guardada!.id)).toBeNull();
  });

  it('id inventado não devolve carrinho de outra pessoa', () => {
    guardar({ customerName: 'Ana' });
    expect(espera.retomar('espera-inventada')).toBeNull();
    expect(espera.listar(TURNO)).toHaveLength(1);
  });

  /*
    G-offline-sync-07 (reauditoria): a linha voltava da espera com a marca de
    preço "em dia" (`precificadaPara`) gravada na hora em que foi guardada. Se a
    pergunta de preço da retomada falhasse, nada mais a via como pendente: o
    Finalizar cobrava o preço velho e a diferença virava concessão do operador.
    Como fica vermelho: tire de `retomar` a remoção da marca.
  */
  it('a linha volta SEM a marca de preço: quem retoma pergunta o preço de agora', () => {
    const guardada = guardar({
      customerId: 'c-1',
      customerName: 'Ana',
      lines: [
        { ...carrinho()[0], precificadaPara: 'c-1', precificadaQtd: 2 },
        {
          product: { id: 'p-2', name: 'Serviço', price_cents: 0 } as CartLine['product'],
          quantity: 1,
          unitPriceCents: 3000,
          precoDigitado: true,
          precoNegociadoCents: 3000,
          precificadaPara: 'c-1',
          precificadaQtd: 1,
        },
      ],
    });

    const retomada = espera.retomar(guardada!.id)!;

    expect(retomada.lines.map((l) => l.precificadaPara)).toEqual([undefined, undefined]);
    // O resto da linha — inclusive o valor combinado — volta como foi guardado.
    expect(retomada.lines[0]).toMatchObject({ quantity: 2, unitPriceCents: 5000 });
    expect(retomada.lines[1]).toMatchObject({ unitPriceCents: 3000, precoDigitado: true, precoNegociadoCents: 3000 });
  });
});

describe('descartar', () => {
  it('some da lista', () => {
    const v = guardar();
    espera.descartar(v!.id);
    expect(espera.listar(TURNO)).toHaveLength(0);
  });
});

// ============================================================================

describe('a espera é da loja, e não do grupo', () => {
  it('sem caixa aberto, cada empresa tem o seu escopo', () => {
    /*
      Era a constante literal 'sem-caixa' para as seis empresas — mesma chave,
      mesmo localStorage, mesma máquina do balcão. O carrinho que a Gringa
      deixou esperando aparecia no PDV da Me Mimei, com preço e cliente de
      outra loja. E, desde que a tela de abertura de caixa passou a subir
      sozinha, "sem caixa" é exatamente como o dia começa.
    */
    expect(espera.escopoDaEspera(null, 'empresa-gringa')).toBe('sem-caixa:empresa-gringa');
    expect(espera.escopoDaEspera(null, 'empresa-me-mimei')).toBe('sem-caixa:empresa-me-mimei');
    expect(espera.escopoDaEspera(null, 'empresa-gringa')).not.toBe(espera.escopoDaEspera(null, 'empresa-me-mimei'));
  });

  it('com caixa aberto o dono é a sessão — que já é única por empresa', () => {
    expect(espera.escopoDaEspera('sessao-9', 'empresa-gringa')).toBe('sessao-9');
  });

  it('sem empresa conhecida ainda existe um escopo — e ele não é o das outras', () => {
    // Sessão ainda carregando: melhor um balde próprio do que o balde comum.
    expect(espera.escopoDaEspera(null, undefined)).toBe('sem-caixa:sem-empresa');
    expect(espera.escopoDaEspera(null, undefined)).not.toBe(espera.escopoDaEspera(null, 'empresa-gringa'));
  });
});
