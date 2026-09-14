/**
 * O seletor de produto da promoção (GAP-PRD-033).
 *
 * A tela pedia "Código do produto" num campo de texto solto, e a API exigia o
 * id do banco: quem digitava o código da etiqueta recebia "Erro interno", e a
 * promoção por produto só funcionava colando o id da URL da ficha.
 *
 * Agora a pessoa BUSCA pelo nome ou pelo código e escolhe na lista — vai o id
 * do produto. Se ela preferir digitar o código e não escolher, vai o texto: o
 * servidor acha o produto pelo código interno ou de barras, e diz pelo nome o
 * código que não achou.
 */
import { useEffect, useRef, useState } from 'react';
import { formatCents } from '@/components/gs/format';
import { promocoesApi, type ProdutoAchado } from '@/lib/api/promocoes';

export function SeletorDeProduto({
  inputProps,
  valor,
  rotulo,
  onChange,
}: {
  /** O que o `Field` passa (id, aria-*) — o rótulo aponta para este campo. */
  inputProps: Record<string, unknown>;
  /** O que vai ao servidor: o id escolhido ou o código digitado. */
  valor: string;
  /** "Nome (código)" quando o produto foi escolhido na lista. */
  rotulo: string | null;
  onChange: (valor: string, rotulo: string | null) => void;
}) {
  const [texto, setTexto] = useState(rotulo ?? valor);
  const [achados, setAchados] = useState<ProdutoAchado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const ultimaBusca = useRef(0);

  // O pai limpa o formulário depois de salvar: o campo acompanha.
  useEffect(() => {
    setTexto(rotulo ?? valor);
  }, [rotulo, valor]);

  useEffect(() => {
    const termo = texto.trim();
    // Escolhido da lista: o texto é o rótulo, não um termo de busca.
    if (rotulo !== null || termo.length < 2) {
      setAchados([]);
      return;
    }
    const minha = ++ultimaBusca.current;
    const t = setTimeout(() => {
      setBuscando(true);
      setErro(null);
      promocoesApi
        .buscarProdutos(termo)
        .then((itens) => {
          if (minha === ultimaBusca.current) setAchados(itens);
        })
        .catch(() => {
          if (minha === ultimaBusca.current) {
            setAchados([]);
            setErro('Não foi possível buscar os produtos agora — o código digitado ainda vale.');
          }
        })
        .finally(() => {
          if (minha === ultimaBusca.current) setBuscando(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [texto, rotulo]);

  const escolher = (p: ProdutoAchado) => {
    const nome = p.internal_code ? `${p.name} (${p.internal_code})` : p.name;
    setTexto(nome);
    setAchados([]);
    onChange(p.id, nome);
  };

  return (
    <div className="relative">
      <input
        {...inputProps}
        value={texto}
        autoComplete="off"
        placeholder="Nome, código interno ou de barras"
        onChange={(e) => {
          setTexto(e.target.value);
          onChange(e.target.value, null);
        }}
        className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
          bg-[var(--gs-surface)] text-[var(--gs-text)]"
      />
      {buscando && (
        <p role="status" className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Buscando…
        </p>
      )}
      {erro && (
        <p role="status" className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
          {erro}
        </p>
      )}
      {achados.length > 0 && (
        <ul
          aria-label="Produtos encontrados"
          className="list-none p-0 m-0 mt-1 border border-[var(--gs-border)] rounded-[var(--gs-radius)]
            bg-[var(--gs-surface)] max-h-60 overflow-y-auto"
        >
          {achados.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => escolher(p)}
                className="w-full text-left bg-transparent border-0 px-3 py-2 cursor-pointer
                  hover:bg-[var(--gs-surface-hover)]"
              >
                <strong>{p.name}</strong>
                <span className="text-[var(--gs-muted)] text-[length:var(--gs-text-sm)]">
                  {p.internal_code ? ` · ${p.internal_code}` : ''} · {formatCents(p.price_cents)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
