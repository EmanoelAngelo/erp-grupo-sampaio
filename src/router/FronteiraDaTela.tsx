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
 *
 * ============================================================================
 * O AVISO PROMETIA O QUE ESTE ARQUIVO NÃO ENTREGA
 * ============================================================================
 *
 * ## O defeito
 *
 * A frase na tela dizia "o caixa, o menu e as outras telas seguem abrindo", e
 * duas dessas três coisas não eram verdade:
 *
 *  - O MENU não segue. Está escrito seis linhas acima, no que este arquivo NÃO
 *    promete — o aviso contradizia o próprio código.
 *  - O CAIXA não segue quando o caixa é a tela que estourou. `aoInicio` vai
 *    para `homeOf(perfil)`, e a casa do `operador_caixa_loja` é `/pdv`: com o
 *    PDV quebrado, "Ir para o início" limpa o erro, redesenha a MESMA tela,
 *    ela estoura de novo e o aviso volta. E "Voltar" é `navigate(-1)`, que num
 *    PDV aberto direto (o balcão liga o computador no endereço do PDV) não tem
 *    para onde ir: a porta existe e não abre.
 *
 * Aviso que promete a mais é pior que aviso que promete de menos: quem lê para
 * de procurar saída.
 *
 * ## A regra
 *
 * A tela só oferece a porta que ABRE. "Voltar" aparece quando há página
 * anterior nesta sessão de navegação; "Ir para o início" aparece quando a casa
 * do perfil é OUTRA tela. Quando nenhuma das duas serve — o caso do caixa com
 * o PDV quebrado —, o aviso diz isso com todas as letras e oferece a única
 * saída que sobra, recarregar, avisando que ela pode repetir o estouro.
 *
 * E o aviso deixa RASTRO: um código que a pessoa lê ao telefone, no mesmo
 * formato do da fronteira geral (`err-<base36>`). Sem ele, quem atende o
 * chamado não tem o que pedir — `componentDidCatch` só escreve no console em
 * desenvolvimento, de propósito.
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
  /** Recarrega o endereço atual. A última saída, quando não há outra. */
  aoRecarregar: () => void;
  /**
   * Há página anterior NESTA sessão de navegação? Falso no endereço em que o
   * navegador abriu — é o caso do balcão que liga o computador direto no PDV.
   */
  podeVoltar: boolean;
  /**
   * "Ir para o início" leva para FORA desta tela? Falso quando a casa do
   * perfil É a tela que estourou. Função, e não valor: a sessão é lida só
   * quando há erro a desenhar, para não amarrar o roteador ao login.
   */
  inicioLevaEmbora: () => boolean;
}

interface State {
  erro: Error | null;
  /** O código que a pessoa repete ao telefone. Vazio enquanto não há erro. */
  idDoRelato: string;
}

export class FronteiraDaTela extends Component<Props, State> {
  state: State = { erro: null, idDoRelato: '' };

  static getDerivedStateFromError(erro: Error): State {
    return { erro, idDoRelato: `err-${Date.now().toString(36)}` };
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
      this.setState({ erro: null, idDoRelato: '' });
    }
  }

  render(): ReactNode {
    if (!this.state.erro) return this.props.children;

    // Só entra na lista a porta que abre: oferecer a que não abre é o defeito
    // que esta fronteira tinha na frase.
    const saidas: { rotulo: string; acao: () => void }[] = [];
    if (this.props.podeVoltar) saidas.push({ rotulo: 'Voltar', acao: this.props.aoVoltar });
    if (this.props.inicioLevaEmbora()) {
      saidas.push({ rotulo: 'Ir para o início', acao: this.props.aoInicio });
    }
    const semSaida = saidas.length === 0;
    if (semSaida) {
      saidas.push({ rotulo: 'Recarregar esta tela', acao: this.props.aoRecarregar });
    }

    return (
      <div
        role="alert"
        data-tela-estourou=""
        className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <h1 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">Esta tela falhou.</h1>
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          {semSaida
            ? 'Esta é a tela inicial deste acesso e não há página anterior para onde voltar: '
              + 'daqui, só recarregando. Se o erro voltar ao recarregar, ele é desta tela e não '
              + 'da rede — avise a gestão com o código abaixo.'
            : 'As OUTRAS telas do sistema continuam abrindo: use os botões abaixo. O menu não '
              + 'sobrevive a esta falha — ele é desenhado por dentro de cada tela e caiu junto '
              + 'com esta. Se repetir, avise a gestão com o código abaixo e diga por qual '
              + 'caminho chegou aqui.'}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {saidas.map((s) => (
            <button
              key={s.rotulo}
              type="button"
              onClick={s.acao}
              className="rounded-md border border-[var(--gs-border)] px-4 py-2 font-medium"
            >
              {s.rotulo}
            </button>
          ))}
        </div>
        {/* O que o suporte pede ao telefone. Sem isto, o chamado começa do zero. */}
        <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Código para o suporte: {this.state.idDoRelato}
        </p>
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
