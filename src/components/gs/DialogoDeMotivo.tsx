/**
 * A pergunta do MOTIVO, desenhada (GAP-PRD-158). Quem pergunta é
 * `usePedirMotivo`, em `PerguntaDaTela.tsx`; este arquivo é só a tela dela.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { DialogoBase } from './DialogoBase';
import { Button } from './ui';

export interface PedidoDeMotivo {
  titulo: string;
  /** O que acontece se confirmar — aparece sob o título. */
  explicacao?: ReactNode;
  rotulo?: string;
  /** Tamanho mínimo, contado depois de tirar os espaços das pontas. Padrão: 1. */
  minimo?: number;
  /** Motivo em branco é aceito (volta ''); só desistir volta null. */
  opcional?: boolean;
  confirmar?: string;
  perigoso?: boolean;
  valorInicial?: string;
}

export function DialogoDeMotivo({
  pedido,
  onResponder,
}: {
  pedido: PedidoDeMotivo;
  onResponder: (v: string | null) => void;
}) {
  const [texto, setTexto] = useState(pedido.valorInicial ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const idCampo = useId();
  const minimo = pedido.opcional ? 0 : Math.max(1, pedido.minimo ?? 1);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    const valor = texto.trim();
    if (valor.length < minimo) {
      setErro(minimo <= 1 ? 'Escreva o motivo.' : `Escreva o motivo com pelo menos ${minimo} caracteres.`);
      document.getElementById(idCampo)?.focus();
      return;
    }
    onResponder(valor);
  };

  return (
    <DialogoBase
      titulo={pedido.titulo}
      subtitulo={pedido.explicacao}
      onFechar={() => onResponder(null)}
      largura="sm"
      focoInicial="[data-foco-inicial]"
      testId="pedir-motivo"
    >
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={idCampo}
            className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]"
          >
            {pedido.rotulo ?? 'Motivo'}
            {!pedido.opcional && (
              <span className="text-[var(--gs-danger)] ml-1" aria-hidden>
                *
              </span>
            )}
          </label>
          <input
            id={idCampo}
            data-foco-inicial
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              if (erro) setErro(null);
            }}
            aria-invalid={erro ? true : undefined}
            aria-describedby={erro ? `${idCampo}-erro` : minimo > 1 ? `${idCampo}-dica` : undefined}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)] focus:border-[var(--gs-purple-700)]"
          />
          {minimo > 1 && !erro && (
            <p id={`${idCampo}-dica`} className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Pelo menos {minimo} caracteres.
            </p>
          )}
          {erro && (
            <p
              id={`${idCampo}-erro`}
              role="alert"
              className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0"
            >
              {erro}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onResponder(null)}>
            Cancelar
          </Button>
          <Button type="submit" variant={pedido.perigoso ? 'danger' : 'primary'}>
            {pedido.confirmar ?? 'Confirmar'}
          </Button>
        </div>
      </form>
    </DialogoBase>
  );
}
