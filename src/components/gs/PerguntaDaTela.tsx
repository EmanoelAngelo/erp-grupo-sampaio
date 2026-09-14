/**
 * AS PERGUNTAS DA TELA — o motivo e a confirmação, sem o diálogo do navegador
 * (GAP-PRD-158).
 *
 * Cancelar nota de entrada, inventário, locação, pedido de compra; perder um
 * lead; mexer em unidade serializada: tudo isso pedia o motivo por
 * `window.prompt` e a certeza por `window.confirm`. O diálogo nativo bloqueia a
 * página inteira, tem cara diferente em cada navegador, some em tablet de
 * quiosque, não valida nada (um espaço em branco passava por motivo) e não diz
 * onde está o erro.
 *
 * As duas perguntas daqui são promessas, como as nativas eram síncronas: quem
 * chamava `const motivo = window.prompt(...)` passa a chamar
 * `const motivo = await pedirMotivo({...})`, e a resposta tem o mesmo formato —
 * o texto, ou `null` se a pessoa desistiu. A diferença é o que acontece no
 * meio: o motivo curto demais é recusado NA TELA, com a mensagem ao lado do
 * campo, e a pessoa corrige sem perder o que já digitou.
 *
 * O componente de cada pergunta volta junto (`dialogoDeMotivo`,
 * `dialogoDeConfirmacao`) e a página o põe em qualquer lugar do JSX.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { DialogoBase } from './DialogoBase';
import { DialogoDeMotivo, type PedidoDeMotivo } from './DialogoDeMotivo';
import { Button } from './ui';

export type { PedidoDeMotivo } from './DialogoDeMotivo';

// ------------------------------------------------------------------ motivo

export function usePedirMotivo(): {
  pedirMotivo: (pedido: PedidoDeMotivo) => Promise<string | null>;
  dialogoDeMotivo: ReactNode;
} {
  const [pedido, setPedido] = useState<{ n: number; p: PedidoDeMotivo } | null>(null);
  const resolver = useRef<((v: string | null) => void) | null>(null);
  const contador = useRef(0);

  const responder = useCallback((v: string | null) => {
    const r = resolver.current;
    resolver.current = null;
    setPedido(null);
    r?.(v);
  }, []);

  const pedirMotivo = useCallback(
    (p: PedidoDeMotivo) =>
      new Promise<string | null>((resolve) => {
        // Uma pergunta por vez: a anterior, se ainda aberta, conta como desistência.
        resolver.current?.(null);
        resolver.current = resolve;
        contador.current += 1;
        setPedido({ n: contador.current, p });
      }),
    [],
  );

  const dialogoDeMotivo = pedido ? (
    <DialogoDeMotivo key={pedido.n} pedido={pedido.p} onResponder={responder} />
  ) : null;
  return { pedirMotivo, dialogoDeMotivo };
}

// ------------------------------------------------------------- confirmação

export interface PedidoDeConfirmacao {
  titulo: string;
  mensagem: ReactNode;
  confirmar?: string;
  cancelar?: string;
  perigoso?: boolean;
}

export function useConfirmar(): {
  confirmar: (pedido: PedidoDeConfirmacao) => Promise<boolean>;
  dialogoDeConfirmacao: ReactNode;
} {
  const [pedido, setPedido] = useState<{ n: number; p: PedidoDeConfirmacao } | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const contador = useRef(0);

  const responder = useCallback((v: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setPedido(null);
    r?.(v);
  }, []);

  const confirmar = useCallback(
    (p: PedidoDeConfirmacao) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        contador.current += 1;
        setPedido({ n: contador.current, p });
      }),
    [],
  );

  const dialogoDeConfirmacao = pedido ? (
    <DialogoBase
      key={pedido.n}
      titulo={pedido.p.titulo}
      onFechar={() => responder(false)}
      largura="sm"
      // O foco começa em "Cancelar": Enter por reflexo não confirma o que não se leu.
      focoInicial="[data-foco-inicial]"
      testId="confirmar"
      rodape={
        <>
          <Button type="button" variant="ghost" data-foco-inicial onClick={() => responder(false)}>
            {pedido.p.cancelar ?? 'Cancelar'}
          </Button>
          <Button
            type="button"
            variant={pedido.p.perigoso ? 'danger' : 'primary'}
            onClick={() => responder(true)}
          >
            {pedido.p.confirmar ?? 'Confirmar'}
          </Button>
        </>
      }
    >
      <div className="text-[length:var(--gs-text-base)] text-[var(--gs-text)]">{pedido.p.mensagem}</div>
    </DialogoBase>
  ) : null;
  return { confirmar, dialogoDeConfirmacao };
}
