/**
 * A NOTA FISCAL DA COMPRA, no portal da cliente (GAP-PRD-125).
 *
 * A nota só existia no ERP, e a loja mandava o DANFE por e-mail à mão. Aqui a
 * dona do pedido vê número, série, chave e situação, abre o DANFE (para
 * imprimir ou salvar em PDF) e baixa o XML autorizado. O servidor decide o que
 * existe; a tela só oferece o que ele disse que há.
 */
import { useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { documentoDoPedidoNoPortal, type NotaDoPedidoNoPortal } from '@/lib/api/posVenda';

interface Props {
  orderId: string;
  token: string;
  nota: NotaDoPedidoNoPortal | null;
  /** Pedido pago: sem nota ainda, a tela diz que ela vem. */
  pago: boolean;
}

export function NotaDoPedido({ orderId, token, nota, pago }: Props) {
  const [erro, setErro] = useState<string | null>(null);
  const [buscando, setBuscando] = useState<'danfe' | 'xml' | null>(null);

  if (!nota) {
    if (!pago) return null;
    return (
      <section
        data-testid="nota-do-pedido"
        className="mt-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5"
      >
        <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
          Nota fiscal
        </h2>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          A nota fiscal aparece aqui assim que a loja emitir.
        </p>
      </section>
    );
  }

  const buscar = async (tipo: 'danfe' | 'xml') => {
    setErro(null);
    setBuscando(tipo);
    try {
      const { blob, nomeArquivo } = await documentoDoPedidoNoPortal(orderId, tipo, token);
      const url = URL.createObjectURL(blob);
      if (tipo === 'danfe') {
        // O DANFE abre em outra aba, pronto para imprimir ou salvar em PDF.
        window.open(url, '_blank', 'noopener');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = nomeArquivo;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // A aba/o download já leu o endereço; liberar logo não corta nada.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível abrir a nota agora.');
    } finally {
      setBuscando(null);
    }
  };

  return (
    <section
      data-testid="nota-do-pedido"
      className="mt-5 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius-lg)] p-5"
    >
      <h2 className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-purple-900)] mt-0">
        Nota fiscal
      </h2>
      <p className="text-[length:var(--gs-text-sm)] m-0">
        NF-e nº {nota.numero} (série {nota.serie}) — <strong>{nota.statusLabel}</strong>
      </p>
      {nota.chave && (
        <p className="text-[length:var(--gs-text-xs)] font-mono break-all text-[var(--gs-muted)] mt-1 mb-0">
          Chave de acesso: {nota.chave}
        </p>
      )}
      <div className="flex flex-wrap gap-2 mt-3">
        {nota.danfe && (
          <button
            type="button"
            onClick={() => void buscar('danfe')}
            disabled={buscando !== null}
            className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-4 py-2
              cursor-pointer font-semibold disabled:opacity-60"
          >
            {buscando === 'danfe' ? 'Abrindo…' : 'Ver DANFE'}
          </button>
        )}
        {nota.xml && (
          <button
            type="button"
            onClick={() => void buscar('xml')}
            disabled={buscando !== null}
            className="bg-transparent border border-[var(--gs-purple-700)] text-[var(--gs-purple-700)]
              rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold disabled:opacity-60"
          >
            {buscando === 'xml' ? 'Baixando…' : 'Baixar XML'}
          </button>
        )}
      </div>
      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] mt-2 mb-0">
          {erro}
        </p>
      )}
    </section>
  );
}
