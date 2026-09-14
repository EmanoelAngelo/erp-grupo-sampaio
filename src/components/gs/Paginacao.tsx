/**
 * A LISTA DIZ QUE CORTOU — GAP-PRD-070 / GAP-PRD-164.
 *
 * Produtos, Clientes, Vendas, Entrada de Notas e Pedidos de compra desenhavam
 * as 100 ou 200 primeiras linhas como se fossem a lista inteira. O gestor
 * concluía que "só tem 100 produtos", e a 201ª nota sumia sem aviso.
 *
 * Este rodapé é a frase que faltava — "Mostrando 101–150 de 150 produtos" — e
 * os dois gestos para andar. Ele não sabe de onde vêm os números: recebe a
 * página do servidor (`total`, `limit`, `offset`) e devolve o novo `offset`.
 *
 * Quando a lista cabe inteira numa página, a frase continua (o total é
 * informação) e os botões somem — "Anterior" desabilitado numa lista de 12
 * itens é ruído.
 *
 * Resposta sem `total` (servidor anterior): a frase diz só o que chegou, sem
 * inventar um "de N", e "Próxima" aparece enquanto a página vier cheia — o
 * mesmo critério honesto que o histórico de estoque sempre usou.
 */
import { Button } from '@/components/gs/ui';

export interface PaginaNaTela {
  total: number;
  limit: number;
  offset: number;
  /** Quantas linhas vieram nesta página. */
  quantidade: number;
  /** Falso quando o servidor não mandou `total`. */
  totalConhecido?: boolean;
}

const numero = (n: number) => n.toLocaleString('pt-BR');

/** A frase do rodapé: o que está na tela e de quantos. */
function fraseDaPagina(
  pagina: PaginaNaTela,
  rotulo: { singular: string; plural: string },
): string {
  const { total, offset, quantidade } = pagina;
  const conhecido = pagina.totalConhecido !== false;
  if (quantidade === 0) {
    return conhecido && total > 0
      ? `Nenhum ${rotulo.singular} nesta página — são ${numero(total)} no total.`
      : '';
  }
  const nome = (n: number) => (n === 1 ? rotulo.singular : rotulo.plural);
  // Sem `total`, mas a página veio INCOMPLETA: então é a lista inteira.
  if (!conhecido && offset === 0 && quantidade < pagina.limit) {
    return `${numero(quantidade)} ${nome(quantidade)}.`;
  }
  if (!conhecido) {
    return `Mostrando ${numero(offset + 1)}–${numero(offset + quantidade)} ${rotulo.plural}.`;
  }
  if (offset === 0 && quantidade >= total) {
    return `${numero(total)} ${nome(total)}.`;
  }
  return `Mostrando ${numero(offset + 1)}–${numero(offset + quantidade)} de ${numero(total)} ${nome(total)}.`;
}

export function Paginacao({
  pagina,
  rotulo,
  onMudar,
  dica,
  carregando = false,
}: {
  pagina: PaginaNaTela | null;
  /** "produto" / "produtos" — a frase fala a língua da lista. */
  rotulo: { singular: string; plural: string };
  onMudar: (offset: number) => void;
  /** O que fazer para achar quem ficou de fora, quando a lista está cortada. */
  dica?: string;
  carregando?: boolean;
}) {
  if (!pagina) return null;
  const { total, limit, offset, quantidade } = pagina;
  const conhecido = pagina.totalConhecido !== false;
  const frase = fraseDaPagina(pagina, rotulo);
  if (!frase) return null;

  const temAnterior = offset > 0;
  const temProxima = conhecido ? offset + quantidade < total : quantidade >= limit && limit > 0;
  const cortada = temAnterior || temProxima;

  return (
    <nav
      aria-label={`Páginas de ${rotulo.plural}`}
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3
        text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
    >
      {/*
        `aria-live`, e não `role="status"`: a tela já tem o SEU status (o aviso
        do que acabou de acontecer), e o rodapé não pode competir com ele.
      */}
      <p aria-live="polite" className="m-0">
        {frase}
        {cortada && dica ? ` ${dica}` : ''}
      </p>
      {cortada && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!temAnterior || carregando}
            onClick={() => onMudar(Math.max(0, offset - limit))}
          >
            Anterior
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!temProxima || carregando}
            onClick={() => onMudar(offset + limit)}
          >
            Próxima
          </Button>
        </div>
      )}
    </nav>
  );
}
