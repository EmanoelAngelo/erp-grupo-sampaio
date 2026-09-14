/**
 * AVISO NÃO DERRUBA BALCÃO.
 *
 * ============================================================================
 * O PADRÃO QUE ESTA AUDITORIA ENCONTROU TRÊS VEZES
 * ============================================================================
 *
 * Três painéis do PDV só INFORMAM — o selo fiscal, o painel fiscal da última
 * venda e a barra de conexão. Nenhum deles vende nada, e cada um derrubou a
 * tela inteira nesta auditoria, sempre do mesmo jeito: o servidor devolveu uma
 * forma que a tela não previa e o componente estourou ao ler um campo.
 *
 *   - `SITUACAO[resumo.situacao]` com uma quinta situação → `undefined.classe`;
 *   - `status.document.status` com resposta sem documento;
 *   - `prontidao.reasons[0]` com `reasons` ausente.
 *
 * A barreira global do `App` pega a queda, então não é tela branca literal: é a
 * página de erro do sistema, com um botão que recarrega. Para quem está no
 * balcão dá no mesmo — o carrinho montado com o cliente na frente se perde.
 *
 * Os três casos foram consertados onde nasceram. Isto aqui é o cinto: o próximo
 * campo que o servidor mudar não vai fechar a loja enquanto ninguém percebe.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PainelAuxiliar } from '../PainelAuxiliar';
import FONTE_PDV from '@/pages/gs/PdvPage.tsx?raw';

/** Um painel informativo que estourou lendo um campo que não veio. */
function PainelQuebrado(): React.ReactElement {
  const resposta = {} as { document: { status: string } };
  return <span>{resposta.document.status}</span>;
}

beforeEach(() => {
  // O React registra a queda no console; o barulho não é o assunto do teste.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ============================================================================

describe('o painel que quebra some sozinho', () => {
  it('o resto da tela continua de pé', () => {
    render(
      <div>
        <span data-testid="balcao">Finalizar (F10)</span>
        <PainelAuxiliar nome="teste">
          <PainelQuebrado />
        </PainelAuxiliar>
      </div>,
    );

    /*
      A ordem de grandeza é o argumento inteiro: um selo que diz "FISCAL OK"
      não pode custar uma venda. Quando ele falha, o certo é ele sumir.
    */
    expect(screen.getByTestId('balcao')).toBeTruthy();
  });

  it('o painel são continua aparecendo — a barreira não é um interruptor geral', () => {
    render(
      <PainelAuxiliar nome="teste">
        <span data-testid="painel">FISCAL OK</span>
      </PainelAuxiliar>,
    );
    expect(screen.getByTestId('painel').textContent).toBe('FISCAL OK');
  });
});

// ============================================================================

describe('os três painéis informativos do PDV estão protegidos', () => {
  for (const painel of ['EstadoConexao', 'FiscalBadgePdv', 'PainelFiscalPdv']) {
    it(`${painel} é montado dentro da barreira`, () => {
      /*
        A varredura vale mais que os três casos: ela cobra o próximo painel
        informativo que alguém pendurar no PDV. Sem ela, a lição se perde na
        primeira tela nova.
      */
      const antes = FONTE_PDV.split(`<${painel}`)[0];
      const abertura = antes.lastIndexOf('<PainelAuxiliar');
      const fechamento = antes.lastIndexOf('</PainelAuxiliar>');
      expect(
        abertura > fechamento,
        `<${painel}> está fora de <PainelAuxiliar> — um aviso pode derrubar o balcão`,
      ).toBe(true);
    });
  }
});
