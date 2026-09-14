/**
 * VINCULAR O ITEM DA NOTA A UM PRODUTO QUE JÁ EXISTE — GAP-PRD-015.
 *
 * O item que o casamento automático não reconhecia (fornecedor sem GTIN, código
 * dele diferente do nosso, descrição diferente do nome) só tinha um destino na
 * conferência: virar produto novo, com preço zero, e o saldo subia nele. O
 * produto verdadeiro ficava com saldo velho e o PDV passava a ter dois
 * cadastros da mesma coisa.
 *
 * Este é o gesto que faltava: procurar no catálogo, ali mesmo na linha da nota,
 * e ligar. A busca é a MESMA do PDV (`/products/search`) — código, código de
 * barras (principal e adicionais) ou nome —, com as peças de oficina incluídas,
 * porque a peça quase sempre chega pela nota do fornecedor.
 *
 * O servidor é quem recusa modelo de grade e kit que desmembra; a busca já não
 * oferece o modelo, e a frase da recusa do kit chega inteira.
 *
 * "Lembrar para as próximas notas deste fornecedor" nasce MARCADO: o caso comum
 * é o código que se repete em toda nota, e a próxima deve casar sozinha. O
 * desmarcado existe para o item avulso — o brinde, a promoção de uma vez.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Button } from '@/components/gs/ui';
import { formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Product } from '@/lib/api/core';

export function VincularItemDaNota({
  descricao,
  codigoDoFornecedor,
  ocupado,
  aoEscolher,
  aoCancelar,
}: {
  /** A descrição do item NA NOTA — nomeia o campo e os botões para quem usa leitor de tela. */
  descricao: string;
  /** O `cProd` do fornecedor; quando existe, o de-para pode ser lembrado. */
  codigoDoFornecedor: string | null;
  ocupado: boolean;
  aoEscolher: (produto: Product, lembrar: boolean) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [termo, setTermo] = useState('');
  const [resultados, setResultados] = useState<Product[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [lembrar, setLembrar] = useState(true);
  /*
    A RESPOSTA QUE CHEGA FORA DE ORDEM.

    Quem digita "cabo acel" dispara uma busca por letra. A resposta de "ca"
    pode chegar DEPOIS da de "cabo acel" — e trocaria a lista certa pela
    errada. Só a resposta da ÚLTIMA pergunta é desenhada.
  */
  const ultimaBusca = useRef(0);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    campo.current?.focus();
  }, []);

  const procurar = async (valor: string) => {
    setTermo(valor);
    setErro(null);
    const pergunta = ++ultimaBusca.current;
    if (valor.trim().length < 2) {
      setResultados(null);
      return;
    }
    try {
      const encontrados = await coreApi.searchProducts(valor.trim(), { includeParts: true });
      if (pergunta === ultimaBusca.current) setResultados(encontrados);
    } catch (err) {
      if (pergunta !== ultimaBusca.current) return;
      setResultados([]);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao procurar no catálogo.');
    }
  };

  return (
    <div className="flex flex-col gap-2 min-w-[18rem]">
      {/* `<input>` nativo e não o `Input` do kit: o campo precisa do ref para
          receber o foco quando a busca abre, e o do kit não o repassa. */}
      <input
        ref={campo}
        type="search"
        aria-label={`Procurar no catálogo o produto de ${descricao}`}
        placeholder="Nome, código ou código de barras…"
        value={termo}
        onChange={(e) => void procurar(e.target.value)}
        className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
          bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-sm)]
          placeholder:text-[var(--gs-muted)] focus:border-[var(--gs-purple-700)]"
      />
      {erro && (
        <span role="alert" className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
          {erro}
        </span>
      )}
      {resultados && resultados.length === 0 && !erro && (
        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Nenhum produto do catálogo com “{termo.trim()}”.
        </span>
      )}
      {resultados && resultados.length > 0 && (
        <ul
          aria-label={`Produtos do catálogo para ${descricao}`}
          className="flex flex-col gap-1 max-h-56 overflow-y-auto"
        >
          {resultados.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2">
              <span className="flex flex-col text-[length:var(--gs-text-sm)]">
                <span className="font-semibold">{p.name}</span>
                <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  {p.internal_code}
                  {p.barcode ? ` · ${p.barcode}` : ''} · {p.unit}
                  {p.stock_quantity !== undefined
                    ? ` · saldo ${formatQuantity(p.stock_quantity)}`
                    : ''}
                  {p.kind === 'part' && (
                    <>
                      {' '}
                      <Badge tone="info">peça · {p.workshop_name ?? 'oficina'}</Badge>
                    </>
                  )}
                </span>
              </span>
              <Button
                size="sm"
                loading={ocupado}
                aria-label={`Vincular ${descricao} a ${p.name}`}
                onClick={() => void aoEscolher(p, Boolean(codigoDoFornecedor) && lembrar)}
              >
                Vincular
              </Button>
            </li>
          ))}
        </ul>
      )}
      <span className="flex items-center justify-between gap-2 flex-wrap">
        {codigoDoFornecedor ? (
          <label className="inline-flex items-center gap-1.5 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
            <input
              type="checkbox"
              checked={lembrar}
              onChange={(e) => setLembrar(e.target.checked)}
            />
            Lembrar o código {codigoDoFornecedor} para as próximas notas deste fornecedor
          </label>
        ) : (
          <span />
        )}
        <Button size="sm" variant="ghost" onClick={aoCancelar}>
          Cancelar
        </Button>
      </span>
    </div>
  );
}
