/**
 * Pesquisa avançada de produtos do PDV — GAP-V57.
 *
 * O QUE HAVIA ANTES
 *
 * "Pesq. avançada (F4)" era um rótulo em cima da MESMA busca textual do campo
 * grande: quem clicava esperando filtros recebia o que já tinha. Promessa de
 * tela que não existe é o padrão de defeito que a casa combate nos atalhos —
 * o operador aprende que os rótulos mentem, inclusive os que não mentem.
 *
 * COMO ELA FUNCIONA
 *
 * A rota é a MESMA de sempre: GET /core/products/search, que procura por
 * nome, código interno e código de barras de uma vez. O diálogo manda ao
 * servidor o primeiro termo preenchido (nome, código ou barras) e aplica os
 * DEMAIS filtros — inclusive categoria, que a rota não conhece — sobre o que
 * voltou, no navegador. Trinta linhas é o teto da rota; peneirar trinta no
 * cliente é barato e honesto, e nenhum filtro daqui é decorativo: cada campo
 * preenchido estreita a lista de verdade.
 *
 * `incluirPecas` vem da tela: o interruptor "Incluir peças da oficina" vale
 * aqui também — duas buscas com regras diferentes de peça confundiriam quem
 * alterna entre elas.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Badge, Button } from './ui';
import { formatCents, formatQuantity } from './format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Product } from '@/lib/api/core';
import { distintivoDePeca, ehPecaDeBancada, rotuloFiscalIncompleto } from '@/pages/gs/pdvTypes';
import { MiniaturaDoProduto } from './MiniaturaDoProduto';

export function PesquisaAvancadaDialog({
  incluirPecas,
  onPick,
  onClose,
}: {
  /** O interruptor de peças da tela — a mesma regra da busca principal. */
  incluirPecas: boolean;
  /** O produto escolhido. Quem chama decide quantidade e preço. */
  onPick: (product: Product) => void;
  onClose: () => void;
}) {
  const [nome, setNome] = useState('');
  const [codigo, setCodigo] = useState('');
  const [barras, setBarras] = useState('');
  const [categoria, setCategoria] = useState('');
  /** Nulo = ainda não se buscou; lista vazia = buscou e não achou. */
  const [resultados, setResultados] = useState<Product[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const nomeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nomeRef.current?.focus();
  }, []);

  // Esc fecha — a mesma tecla que fecha os outros modais do PDV. Captura,
  // porque o handler da página está desligado enquanto este diálogo existe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const buscar = useCallback(async () => {
    // O servidor precisa de UM termo; os demais campos peneiram o retorno.
    const termo = nome.trim() || codigo.trim() || barras.trim();
    if (!termo) {
      setErro('Preencha ao menos nome, código ou código de barras.');
      setResultados(null);
      return;
    }
    setBuscando(true);
    setErro(null);
    try {
      const achados = await coreApi.searchProducts(termo, { includeParts: incluirPecas });
      const nomeAlvo = nome.trim().toLowerCase();
      const codigoAlvo = codigo.trim().toLowerCase();
      const barrasAlvo = barras.trim();
      const categoriaAlvo = categoria.trim().toLowerCase();
      setResultados(
        achados.filter(
          (p) =>
            (!nomeAlvo || p.name.toLowerCase().includes(nomeAlvo))
            && (!codigoAlvo || (p.internal_code ?? '').toLowerCase().includes(codigoAlvo))
            && (!barrasAlvo || (p.barcode ?? '').includes(barrasAlvo))
            && (!categoriaAlvo || (p.category ?? '').toLowerCase().includes(categoriaAlvo)),
        ),
      );
    } catch (err) {
      setResultados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha na busca.');
    } finally {
      setBuscando(false);
    }
  }, [nome, codigo, barras, categoria, incluirPecas]);

  const campo =
    'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] '
    + 'bg-[var(--gs-surface)] text-[var(--gs-text)]';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label="Pesquisa avançada de produtos"
    >
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Pesquisa avançada
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Preencha um ou mais filtros. Categoria peneira o resultado da busca.
          </p>
        </header>

        <form
          className="px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void buscar();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Nome do produto
            </span>
            <input
              ref={nomeRef}
              aria-label="Nome do produto"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className={campo}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Código interno
            </span>
            <input
              aria-label="Código interno"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              className={campo}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Código de barras
            </span>
            <input
              aria-label="Código de barras"
              value={barras}
              onChange={(e) => setBarras(e.target.value)}
              inputMode="numeric"
              className={campo}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Categoria
            </span>
            <input
              aria-label="Categoria"
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              className={campo}
            />
          </label>

          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            {erro && (
              <p role="alert" className="m-0 mr-auto text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                {erro}
              </p>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Fechar (Esc)
            </Button>
            <Button type="submit" loading={buscando}>
              Buscar
            </Button>
          </div>
        </form>

        {resultados !== null && (
          <div className="px-6 pb-5">
            {resultados.length === 0 ? (
              <p className="m-0 text-[var(--gs-muted)]">
                Nenhum produto passou pelos filtros. Afrouxe um deles e busque de novo.
              </p>
            ) : (
              <ul className="list-none m-0 p-0 border border-[var(--gs-border)] rounded-[var(--gs-radius)] overflow-hidden max-h-[320px] overflow-y-auto">
                {resultados.map((p) => (
                  <li key={p.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <button
                      type="button"
                      onClick={() => onPick(p)}
                      className="w-full flex items-center justify-between gap-4 px-4 py-3
                        bg-transparent border-0 cursor-pointer text-left hover:bg-[var(--gs-surface-hover)]"
                    >
                      {/* A miniatura do balcão, como na busca principal (P0 da
                          Preço Justo): nunca o original, e o espaço neutro
                          quando não há foto. */}
                      <span className="flex items-center gap-3 min-w-0">
                        <MiniaturaDoProduto thumbUrl={p.thumb_url} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 flex-wrap font-semibold text-[var(--gs-text)]">
                            {p.name}
                            {ehPecaDeBancada(p) && (
                              <Badge tone="warning">{distintivoDePeca(p)}</Badge>
                            )}
                            {rotuloFiscalIncompleto(p) && (
                              <Badge tone="warning">{rotuloFiscalIncompleto(p)}</Badge>
                            )}
                          </span>
                          <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                            {p.internal_code}
                            {p.barcode ? ` · ${p.barcode}` : ''}
                            {p.category ? ` · ${p.category}` : ''} · saldo{' '}
                            {formatQuantity(p.stock_quantity ?? 0)}
                          </span>
                        </span>
                      </span>
                      <span className="font-bold text-[var(--gs-purple-800)] whitespace-nowrap">
                        {formatCents(p.effective_price_cents ?? p.price_cents)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
