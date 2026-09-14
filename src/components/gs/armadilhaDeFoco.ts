/**
 * A ARMADILHA DE FOCO — separada do diálogo para servir às molduras que já
 * existem (GAP-PRD-159).
 *
 * `DialogoBase` a usa por dentro. As molduras próprias (os diálogos do PDV, da
 * oficina, os modais das páginas), que têm muita regra de negócio junto da
 * moldura, ganham a armadilha com UM atributo: `ref={prenderFoco}` no elemento
 * de `role="dialog"`. É um callback ref (React 19): instala ao montar e devolve
 * a limpeza, que o React chama ao desmontar. Sem gancho, sem ordem de hooks —
 * vale até em componente que retorna cedo.
 *
 * O que ela garante:
 *  - ao abrir, o foco ENTRA no diálogo (no elemento marcado por `focoInicial`,
 *    ou no primeiro focável, ou no próprio painel);
 *  - Tab e Shift+Tab GIRAM dentro dele, e o foco que escapa (clique no fundo,
 *    script) volta para dentro;
 *  - ao fechar, o foco VOLTA ao elemento que abriu o diálogo.
 *
 * DIÁLOGO DENTRO DE DIÁLOGO: só o de cima prende o foco. A pilha é o que impede
 * os dois de brigarem, e `estaNoTopo` deixa o Esc fechar só o de cima.
 */
import { useEffect, type RefObject } from 'react';

const FOCAVEIS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Diálogos abertos, do mais antigo ao de cima. */
const pilha: HTMLElement[] = [];

function focaveisDe(raiz: HTMLElement): HTMLElement[] {
  return Array.from(raiz.querySelectorAll<HTMLElement>(FOCAVEIS)).filter(
    (el) => !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Este elemento é o diálogo de cima? */
export function estaNoTopo(raiz: HTMLElement | null): boolean {
  return raiz !== null && pilha[pilha.length - 1] === raiz;
}

export interface OpcoesDaArmadilha {
  /** Liga e desliga sem desmontar (diálogo que fica montado e só esconde). */
  ativa?: boolean;
  /** Seletor CSS, procurado DENTRO do diálogo, de quem recebe o foco ao abrir. */
  focoInicial?: string;
}

/**
 * Instala a armadilha em `raiz` e devolve a limpeza (tira da pilha, solta os
 * ouvintes e devolve o foco a quem abriu).
 */
export function instalarArmadilhaDeFoco(raiz: HTMLElement, focoInicial?: string): () => void {
  const quemAbriu = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pilha.push(raiz);

  const entrar = () => {
    const marcado = focoInicial ? raiz.querySelector<HTMLElement>(focoInicial) : null;
    (marcado ?? focaveisDe(raiz)[0] ?? raiz).focus();
  };
  if (!raiz.contains(document.activeElement)) entrar();

  const aoTeclar = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !estaNoTopo(raiz)) return;
    const lista = focaveisDe(raiz);
    if (lista.length === 0) {
      e.preventDefault();
      raiz.focus();
      return;
    }
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    const atual = document.activeElement;
    const fora = !raiz.contains(atual);
    if (e.shiftKey && (fora || atual === primeiro || atual === raiz)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && (fora || atual === ultimo)) {
      e.preventDefault();
      primeiro.focus();
    }
  };
  const aoFocar = (e: FocusEvent) => {
    if (!estaNoTopo(raiz)) return;
    if (e.target instanceof Node && !raiz.contains(e.target)) entrar();
  };

  document.addEventListener('keydown', aoTeclar, true);
  document.addEventListener('focusin', aoFocar);
  return () => {
    document.removeEventListener('keydown', aoTeclar, true);
    document.removeEventListener('focusin', aoFocar);
    const i = pilha.lastIndexOf(raiz);
    if (i >= 0) pilha.splice(i, 1);
    // Devolve o foco a quem abriu — se ele ainda existe na tela.
    if (quemAbriu && quemAbriu.isConnected) quemAbriu.focus();
  };
}

/** A armadilha como gancho, para quem tem o painel num `useRef`. */
export function useArmadilhaDeFoco(
  ref: RefObject<HTMLElement | null>,
  { ativa = true, focoInicial }: OpcoesDaArmadilha = {},
): void {
  useEffect(() => {
    const raiz = ref.current;
    if (!ativa || !raiz) return undefined;
    return instalarArmadilhaDeFoco(raiz, focoInicial);
  }, [ativa, focoInicial, ref]);
}

/**
 * A armadilha como callback ref (React 19): `ref={prenderFoco}` no elemento de
 * `role="dialog"`. Identidade estável (função de módulo), então o React instala
 * uma vez ao montar e limpa uma vez ao desmontar.
 */
export function prenderFoco(raiz: HTMLElement | null): (() => void) | undefined {
  if (!raiz) return undefined;
  return instalarArmadilhaDeFoco(raiz);
}
