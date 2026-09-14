/**
 * O campo "Cupom de desconto" da gaveta do carrinho — GAP-PRD-123.
 *
 * "Aplicar" pergunta ao servidor (`/loja/checkout/cupom`), que faz a MESMA
 * conta do checkout: preço do banco, promoção, pedido mínimo, uso por cliente.
 * A tela mostra o desconto de cada loja e o total ANTES do clique; o checkout
 * confere de novo.
 *
 * O carrinho mudou com um cupom aplicado → a conta é refeita. Se o cupom
 * deixou de valer (tirou o item, ficou abaixo do mínimo), ele sai do total e a
 * tela diz por quê — um desconto que o checkout vai recusar não pode ficar na
 * tela.
 *
 * Mora DENTRO do formulário do checkout: por isso o botão é `type="button"` e
 * o Enter no campo aplica o cupom em vez de fechar o pedido.
 */
import { useEffect, useRef, useState } from 'react';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { simularCupom, type CupomSimulado } from '@/lib/api/cupons';

export function CupomDoCarrinho({
  itens,
  portalToken,
  email,
  aplicado,
  onAplicado,
  quantasLojas = 1,
}: {
  itens: { productId: string; quantity: number }[];
  portalToken?: string | null;
  email?: string;
  aplicado: CupomSimulado | null;
  onAplicado: (cupom: CupomSimulado | null) => void;
  /** Quantas lojas o carrinho tem — com mais de uma, a tela diz de qual veio o desconto. */
  quantasLojas?: number;
}) {
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const chaveDoCarrinho = JSON.stringify(itens);
  const ultimaChave = useRef(chaveDoCarrinho);

  const aplicar = async (codigo: string, depoisDeMudar = false) => {
    const code = codigo.trim();
    if (!code) {
      setErro('Digite o código do cupom.');
      return;
    }
    setAplicando(true);
    setErro(null);
    try {
      onAplicado(await simularCupom({ code, items: itens, portalToken, customerEmail: email }));
    } catch (err) {
      onAplicado(null);
      const motivo =
        err instanceof ApiRequestError ? err.message : 'Não foi possível conferir o cupom agora.';
      setErro(depoisDeMudar ? `O cupom ${code} saiu do total: ${motivo}` : motivo);
    } finally {
      setAplicando(false);
    }
  };

  // O carrinho mudou: o desconto de antes não vale para este carrinho.
  useEffect(() => {
    if (chaveDoCarrinho === ultimaChave.current) return;
    ultimaChave.current = chaveDoCarrinho;
    if (aplicado) void aplicar(aplicado.code, true);
    // `aplicar` muda a cada render; o gatilho é o carrinho.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveDoCarrinho]);

  return (
    <fieldset
      className="sm:col-span-3 border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3 m-0"
    >
      <legend className="text-[length:var(--gs-text-sm)] font-semibold px-1">Cupom de desconto</legend>
      {aplicado ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
            Cupom <strong>{aplicado.code}</strong> aplicado: −{formatCents(aplicado.discountCents)}
            {/* O cupom é de UMA loja: com o carrinho de duas, a tela diz de qual
                loja veio o desconto — senão o cliente acharia que o carrinho
                inteiro foi descontado. */}
            {quantasLojas > 1
              ? ` (${aplicado.lojas.map((l) => `${l.storeName}: −${formatCents(l.discountCents)}`).join('; ')})`
              : ''}
          </p>
          <button
            type="button"
            onClick={() => {
              onAplicado(null);
              setTexto('');
              setErro(null);
            }}
            className="bg-transparent border-0 text-[var(--gs-danger)] cursor-pointer px-1 underline"
          >
            Remover cupom
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Código do cupom"
            placeholder="Tem um cupom?"
            value={texto}
            autoComplete="off"
            onChange={(e) => setTexto(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void aplicar(texto);
              }
            }}
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
          <button
            type="button"
            disabled={aplicando}
            onClick={() => void aplicar(texto)}
            className="bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
              rounded-[var(--gs-radius)] px-3 py-2 cursor-pointer font-semibold disabled:opacity-50"
          >
            {aplicando ? 'Conferindo…' : 'Aplicar'}
          </button>
        </div>
      )}
      {erro && (
        <p role="alert" className="m-0 mt-2 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      <p className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
        O desconto vale sobre os produtos, nunca sobre a entrega.
      </p>
    </fieldset>
  );
}

