/**
 * ============================================================================
 * A TELA QUE ESTOURA NÃO DERRUBA O SISTEMA INTEIRO
 * ============================================================================
 *
 * ## O defeito
 *
 * Havia UMA fronteira de erro, `GlobalErrorBoundary`, e ela envolve o
 * `BrowserRouter` por fora. Quando qualquer tela estourava ao desenhar, o
 * React desmontava tudo que está abaixo dela — o roteador junto. O que sobrava
 * na tela era um cartão de erro em página cheia, com um botão só: "Tentar
 * novamente", que faz `window.location.reload()`.
 *
 * Recarregar volta para o MESMO endereço que acabou de estourar. Se a causa
 * estiver no dado (um campo nulo que a tela percorre, uma data que o servidor
 * mandou noutro formato, um pedido antigo com uma chave a menos), estourar é
 * determinístico: recarrega, estoura, recarrega. O caixa fica sem menu, sem
 * PDV e sem endereço para digitar — porque o roteador não existe mais para
 * atender o endereço novo. Uma tela quebrada levava o sistema inteiro junto, e
 * a única saída era fechar o navegador.
 *
 * ## O conserto, e por que é DENTRO do roteador
 *
 * Esta fronteira mora dentro do `BrowserRouter`, envolvendo só o elemento da
 * rota casada. Duas consequências, e são as duas que faltavam:
 *
 *  1. O ROTEADOR CONTINUA DE PÉ. Navegar volta a ser possível — e por isso o
 *     aviso abaixo tem botões que navegam de verdade, em vez de um recarregar
 *     que repete o estouro. A saída principal é a CASA DO PERFIL (o painel de
 *     quem gere, o PDV de quem vende), porque "início" para quem tem sessão
 *     não é a vitrine pública.
 *
 *  2. O ERRO SOME AO TROCAR DE TELA. Fronteira de erro do React não se limpa
 *     sozinha: uma vez em estado de erro, ela mostra o aviso para sempre — e,
 *     sem limpar, navegar deixaria a pessoa olhando o mesmo aviso na tela
 *     seguinte. `chave` é a identidade da navegação (`location.key`): quando
 *     ela muda, o erro é esquecido e a tela nova desenha.
 *
 * `GlobalErrorBoundary` CONTINUA onde está, e é certo que continue: ela pega o
 * que acontece FORA do roteador — a montagem do i18n, o próprio
 * `BrowserRouter`, um erro no caminho até aqui. Ela deixou de ser a única, que
 * era o problema; não deixou de ser necessária.
 *
 * ## O que este arquivo NÃO promete
 *
 * Preservar o menu. Cada tela desenha o próprio `AppShell` por dentro, então a
 * tela que estoura leva a casca dela junto. Promete o que decide entre "o
 * sistema caiu" e "esta tela falhou": a pessoa lê o que aconteceu e sai dali
 * clicando, com o resto do sistema respondendo.
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Identidade da navegação. Ao mudar, o erro é esquecido. */
  chave: string;
  /** Leva à casa do perfil (ou à porta, sem sessão). */
  aoInicio: () => void;
  /** Volta uma página no histórico. */
  aoVoltar: () => void;
}

interface State {
  erro: Error | null;
}

export class FronteiraDaTela extends Component<Props, State> {
  state: State = { erro: null };

  static getDerivedStateFromError(erro: Error): State {
    return { erro };
  }

  componentDidCatch(erro: Error, info: ErrorInfo): void {
    /*
      O relato vai para o console em desenvolvimento, como na fronteira geral.
      Em produção não: a mensagem pode carregar caminho de dado, e o console do
      caixa é lido por quem passa. O que a pessoa precisa saber está na tela.
    */
    if (import.meta.env.DEV) {
      console.error('[FronteiraDaTela] a tela estourou ao desenhar', erro, info.componentStack);
    }
  }

  componentDidUpdate(anterior: Props): void {
    // Navegou: a tela seguinte merece começar limpa.
    if (this.state.erro && anterior.chave !== this.props.chave) {
      this.setState({ erro: null });
    }
  }

  render(): ReactNode {
    if (!this.state.erro) return this.props.children;

    return (
      <div
        role="alert"
        data-tela-estourou=""
        className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <h1 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">Esta tela falhou.</h1>
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          O resto do sistema continua funcionando — o caixa, o menu e as outras telas seguem
          abrindo. Volte e tente de novo; se repetir, avise a gestão e diga por qual caminho
          chegou aqui.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.props.aoVoltar}
            className="rounded-md border border-[var(--gs-border)] px-4 py-2 font-medium"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={this.props.aoInicio}
            className="rounded-md border border-[var(--gs-border)] px-4 py-2 font-medium"
          >
            Ir para o início
          </button>
        </div>
      </div>
    );
  }
}

/**
 * O mesmo, montado sem JSX — `router/index.ts` não é um arquivo `.tsx`, e
 * `telaSobDemanda.ts` já usa `createElement` pelo mesmo motivo.
 */
export function comFronteiraDaTela(props: Props): ReturnType<typeof createElement> {
  return createElement(FronteiraDaTela, props);
}
