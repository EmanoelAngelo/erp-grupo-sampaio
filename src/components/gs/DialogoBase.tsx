/**
 * O DIÁLOGO DA CASA — com o foco preso dentro e devolvido a quem abriu
 * (GAP-PRD-159).
 *
 * Os diálogos nasceram cada um com a própria moldura: `role="dialog"`,
 * `aria-modal`, Esc — e nenhum segurava o foco. Tab saía do modal e ia parar
 * nos botões da venda, por trás do véu escuro; ao fechar, o foco caía no
 * `body`, e quem opera pelo teclado (o leitor de código de barras, o Tab do
 * caixa rápido) precisava clicar na tela para voltar a digitar.
 *
 * Aqui as três coisas moram num lugar só:
 *  - ao abrir, o foco ENTRA no diálogo (no elemento marcado por `focoInicial`,
 *    ou no primeiro focável);
 *  - Tab e Shift+Tab GIRAM dentro dele, e o foco que escapa (clique no fundo,
 *    script) volta para dentro;
 *  - ao fechar, o foco VOLTA ao elemento que abriu o diálogo.
 * E o título nomeia o diálogo por `aria-labelledby`, que o leitor de tela
 * anuncia ao abrir.
 *
 * DIÁLOGO DENTRO DE DIÁLOGO: só o de cima prende o foco e só o de cima fecha
 * com Esc. A pilha abaixo é o que impede os dois de brigarem.
 *
 * `useArmadilhaDeFoco` existe separado para os diálogos que já têm moldura
 * própria (PDV): eles ganham a armadilha com uma linha, sem redesenhar a tela.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { estaNoTopo, useArmadilhaDeFoco } from './armadilhaDeFoco';

const LARGURA = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export function DialogoBase({
  titulo,
  subtitulo,
  children,
  rodape,
  onFechar,
  largura = 'md',
  focoInicial,
  testId,
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  children: ReactNode;
  rodape?: ReactNode;
  /** Sem `onFechar` o diálogo não tem ×, e Esc não fecha: a pergunta exige resposta. */
  onFechar?: () => void;
  largura?: keyof typeof LARGURA;
  focoInicial?: string;
  testId?: string;
}) {
  const idTitulo = useId();
  const idSubtitulo = useId();
  const painel = useRef<HTMLDivElement>(null);
  useArmadilhaDeFoco(painel, { focoInicial });

  useEffect(() => {
    if (!onFechar) return undefined;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !estaNoTopo(painel.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onFechar();
    };
    window.addEventListener('keydown', aoTeclar, true);
    return () => window.removeEventListener('keydown', aoTeclar, true);
  }, [onFechar]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div
        ref={painel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={subtitulo ? idSubtitulo : undefined}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${LARGURA[largura]} max-h-[90vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl outline-none`}
      >
        <header className="px-6 py-4 border-b border-[var(--gs-border)] flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <h2 id={idTitulo} className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
              {titulo}
            </h2>
            {subtitulo && (
              <p id={idSubtitulo} className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
                {subtitulo}
              </p>
            )}
          </div>
          {onFechar && (
            <button
              type="button"
              onClick={onFechar}
              aria-label="Fechar"
              className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-[var(--gs-text-soft)] hover:bg-[var(--gs-surface-hover)]"
            >
              <span aria-hidden>×</span>
            </button>
          )}
        </header>
        <div className="px-6 py-4">{children}</div>
        {rodape && (
          <footer className="px-6 py-4 border-t border-[var(--gs-border)] flex flex-wrap justify-end gap-2">
            {rodape}
          </footer>
        )}
      </div>
    </div>
  );
}
