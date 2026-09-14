/**
 * AVISO NÃO DERRUBA BALCÃO.
 *
 * ============================================================================
 * POR QUE ISTO EXISTE
 * ============================================================================
 *
 * O PDV tem três painéis que só INFORMAM: o selo fiscal, o painel fiscal da
 * última venda e a barra de conexão. Nenhum deles vende nada — e cada um deles
 * já derrubou a tela inteira nesta auditoria, sempre pelo mesmo caminho: o
 * servidor devolveu uma forma que a tela não previa, o componente estourou ao
 * ler um campo, e o React desmontou a árvore.
 *
 * Havia uma barreira global no `App`, então não é uma tela branca literal: é a
 * página de erro do sistema, com um botão que recarrega. Para quem está no
 * balcão dá no mesmo — o carrinho montado com o cliente na frente se perde.
 *
 * A ordem de grandeza importa: um selo que diz "FISCAL OK" não pode custar uma
 * venda. Quando ele falha, o certo é ele sumir e o balcão seguir vendendo.
 *
 * ============================================================================
 * O QUE ISTO NÃO É
 * ============================================================================
 *
 * Não é desculpa para não tratar a forma da resposta — os três casos que
 * apareceram foram consertados um a um, onde nasceram. Isto é o cinto: o
 * próximo campo que o servidor mudar não vai fechar a loja enquanto ninguém
 * percebe.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  /** Só para depuração — aparece no console em desenvolvimento. */
  nome: string;
  children: ReactNode;
}

export class PainelAuxiliar extends Component<Props, { quebrou: boolean }> {
  constructor(props: Props) {
    super(props);
    this.state = { quebrou: false };
  }

  static getDerivedStateFromError(): { quebrou: boolean } {
    return { quebrou: true };
  }

  componentDidCatch(erro: Error): void {
    // Em produção o painel apenas some. Em desenvolvimento o erro aparece
    // inteiro: sumir em silêncio na bancada de quem programa esconderia o
    // defeito até ele chegar na loja.
    if (import.meta.env.DEV) {
      console.error(`[PainelAuxiliar: ${this.props.nome}]`, erro);
    }
  }

  render(): ReactNode {
    if (this.state.quebrou) return null;
    return this.props.children;
  }
}
