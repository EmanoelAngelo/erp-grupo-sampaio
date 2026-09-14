/**
 * Os dois estados de uma tela que ainda não chegou (GAP-PRD-210).
 *
 * Com a divisão por tela, abrir uma rota pela primeira vez pode esperar o
 * pedaço dela chegar. Nesse intervalo a pessoa vê que está carregando — um
 * `role="status"` que o leitor de tela anuncia —, e não uma área em branco que
 * parece travamento.
 *
 * E, se o pedaço não chega (a rede caiu antes de o service worker guardá-lo, ou
 * o sistema foi atualizado com a aba aberta e o pedaço antigo já não existe no
 * servidor), a tela diz isso e oferece recarregar — em vez de estourar a
 * fronteira de erro geral com uma mensagem genérica.
 */

export function CarregandoTela() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-carregando-tela=""
      className="flex min-h-[40vh] items-center justify-center p-8 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
    >
      Carregando a tela…
    </div>
  );
}

export function TelaNaoCarregou() {
  return (
    <div
      role="alert"
      className="mx-auto flex min-h-[40vh] max-w-md flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <p className="m-0 font-semibold">Esta tela não carregou.</p>
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        A conexão caiu antes de a tela chegar, ou o sistema foi atualizado enquanto esta página
        estava aberta. Recarregar busca a versão atual — e, sem rede, abre a cópia guardada.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md border border-[var(--gs-border)] px-4 py-2 font-medium"
      >
        Recarregar a página
      </button>
    </div>
  );
}
