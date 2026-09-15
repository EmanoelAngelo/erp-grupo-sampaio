/**
 * A FOTO DO PRODUTO NO BALCÃO — sempre a miniatura, nunca o original.
 *
 * O DEFEITO (P0 da Preço Justo): a lista da busca do PDV não tinha foto
 * nenhuma, e o operador distinguia "Blusa Viscose Azul" de "Blusa Viscose
 * Azul-marinho" lendo o código. A única imagem disponível era o original da
 * vitrine (até 1600 px), que não cabe numa lista de trinta linhas refeita a
 * cada tecla.
 *
 * O componente recebe SÓ a `thumb_url` — não há propriedade para o original,
 * e a busca do balcão nem o manda. Com isso:
 *   - `loading="lazy"` e `decoding="async"`: linha fora da tela não baixa, e a
 *     decodificação não trava a digitação;
 *   - lado fixo (`width`/`height`): a lista não pula quando a imagem chega;
 *   - sem miniatura (produto sem foto, ou foto antiga ainda sem miniatura):
 *     o espaço neutro, com o mesmo tamanho — nunca uma imagem genérica que
 *     enganaria sobre o produto, nunca o ícone de imagem quebrada;
 *   - falhou (servidor fora, arquivo ausente): o espaço neutro, e a falha fica
 *     lembrada até a rede voltar (`src/lib/miniaturas.ts`), para a lista não
 *     pedir de novo a cada tecla.
 */
import { useSyncExternalStore } from 'react';
import { coreApi } from '@/lib/api/core';
import {
  anotarFalhaDeMiniatura,
  assinarFalhasDeMiniatura,
  miniaturaFalhou,
  versaoDasFalhasDeMiniatura,
} from '@/lib/miniaturas';

export function MiniaturaDoProduto({
  thumbUrl,
  tamanho = 44,
}: {
  /** A miniatura do balcão (`Product.thumb_url`). Nula = espaço neutro. */
  thumbUrl: string | null | undefined;
  /** Lado do quadrado, em px. */
  tamanho?: number;
}) {
  useSyncExternalStore(assinarFalhasDeMiniatura, versaoDasFalhasDeMiniatura, versaoDasFalhasDeMiniatura);
  const src = thumbUrl ? coreApi.imageUrl(thumbUrl) : null;
  const quadro = { width: tamanho, height: tamanho, minWidth: tamanho };

  if (!src || miniaturaFalhou(src)) {
    return (
      <span
        data-testid="miniatura-sem-foto"
        aria-hidden="true"
        style={quadro}
        className="inline-flex items-center justify-center shrink-0 rounded-[var(--gs-radius)]
          border border-[var(--gs-border)] bg-[var(--gs-surface-muted)] text-[var(--gs-muted)]"
      >
        <svg width="45%" height="45%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M21 16l-5-5-8 8" />
        </svg>
      </span>
    );
  }

  return (
    <img
      data-testid="miniatura-do-produto"
      src={src}
      alt=""
      width={tamanho}
      height={tamanho}
      loading="lazy"
      decoding="async"
      draggable={false}
      style={quadro}
      onError={() => anotarFalhaDeMiniatura(src)}
      className="shrink-0 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
        bg-[var(--gs-surface-muted)] object-cover"
    />
  );
}
