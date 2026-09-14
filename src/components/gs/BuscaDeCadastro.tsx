/**
 * ESCOLHER CLIENTE OU PRODUTO SEM CARREGAR O CADASTRO INTEIRO — GAP-PRD-070.
 *
 * Fidelidade, Locação, Consignações, Orçamentos e Equipamentos montavam o
 * seletor com `listCustomers()` sem termo — as 100 primeiras pessoas em ordem
 * alfabética — num `<select>`. O 101º cliente simplesmente não existia ali:
 * quem se chamava "Zuleide" não recebia contrato de locação, e a Fidelidade
 * mostrava doze botões e nenhuma busca. A Locação fazia o mesmo com produto.
 *
 * A troca é por BUSCA INCREMENTAL: a pessoa digita nome, CPF, telefone ou
 * código, o servidor responde uma página curta com o total, e a tela diz
 * quando há mais ("mostrando 20 de 1.180 — continue digitando"). Nenhuma lista
 * completa viaja, e ninguém fica de fora por estar depois da letra M.
 *
 * O ESCOLHIDO É UM OBJETO {id, nome}, não só um id: o orçamento que se edita
 * chega com o cliente de antes, que pode não estar em página nenhuma que a
 * tela carregou — o `<select>` antigo mostrava "Consumidor final" por cima de
 * um cliente gravado, e salvava o cliente sem mostrar qual.
 *
 * Respostas fora de ordem são descartadas (a de "ma" chegando depois da de
 * "marlene" trocaria a lista certa pela errada), e falha de rede tem frase
 * própria — "nenhum encontrado" dito por causa de uma queda levaria a um
 * cadastro duplicado.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Customer, type Product } from '@/lib/api/core';
import { paginaDeClientes } from '@/lib/api/paginas';

/** Espera depois da última tecla antes de ir ao servidor. */
export const ATRASO_DA_BUSCA_MS = 250;
/** Quantos resultados a busca desenha de uma vez. */
export const RESULTADOS_POR_BUSCA = 20;

export interface Escolhido {
  id: string;
  nome: string;
}

interface Resultado<T> {
  items: T[];
  /** Nulo quando a fonte não conta (a busca de produto do balcão). */
  total: number | null;
}

function BuscaDeCadastro<T extends { id: string }>({
  rotulo,
  valor,
  aoMudar,
  buscar,
  nomeDe,
  detalheDe,
  obrigatorio = false,
  rotuloVazio,
  dica,
  placeholder,
  minimo = 1,
  desabilitado = false,
}: {
  rotulo: string;
  valor: Escolhido | null;
  aoMudar: (item: T | null) => void;
  buscar: (termo: string) => Promise<Resultado<T>>;
  nomeDe: (item: T) => string;
  detalheDe?: (item: T) => string | null | undefined;
  obrigatorio?: boolean;
  /** Quando nulo é escolha válida ("Consumidor final"), o nome dela. */
  rotuloVazio?: string;
  dica?: string;
  placeholder: string;
  /** Quantas letras antes de perguntar. */
  minimo?: number;
  desabilitado?: boolean;
}) {
  const id = useId();
  const [termo, setTermo] = useState('');
  const [resultado, setResultado] = useState<Resultado<T> | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const ultimaIda = useRef(0);
  const campo = useRef<HTMLInputElement>(null);
  const [trocando, setTrocando] = useState(false);
  const mostrandoBusca = !valor || trocando;

  useEffect(() => {
    if (!mostrandoBusca) return;
    const alvo = termo.trim();
    const ida = ++ultimaIda.current;
    if (alvo.length < minimo) {
      setResultado(null);
      setErro(null);
      setBuscando(false);
      return;
    }
    setBuscando(true);
    const timer = window.setTimeout(() => {
      buscar(alvo)
        .then((r) => {
          if (ida !== ultimaIda.current) return;
          setResultado(r);
          setErro(null);
        })
        .catch((err) => {
          if (ida !== ultimaIda.current) return;
          setResultado(null);
          setErro(
            err instanceof ApiRequestError
              ? err.message
              : 'Não foi possível buscar agora. Tente de novo.',
          );
        })
        .finally(() => {
          if (ida === ultimaIda.current) setBuscando(false);
        });
    }, ATRASO_DA_BUSCA_MS);
    return () => window.clearTimeout(timer);
    // `buscar` é recriado a cada render de quem chama; a busca depende do termo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termo, mostrandoBusca, minimo]);

  const escolher = (item: T | null) => {
    aoMudar(item);
    setTrocando(false);
    setTermo('');
    setResultado(null);
  };

  const idDaDica = `${id}-dica`;
  const faltam =
    resultado && resultado.total !== null && resultado.total > resultado.items.length
      ? resultado.total - resultado.items.length
      : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]"
      >
        {rotulo}
        {obrigatorio && (
          <span className="text-[var(--gs-danger)] ml-1" aria-hidden>
            *
          </span>
        )}
      </label>

      {!mostrandoBusca && valor && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            id={id}
            className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-surface-muted)] font-semibold"
          >
            {valor.nome}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={desabilitado}
            aria-label={`Trocar ${rotulo.toLocaleLowerCase('pt-BR')}`}
            onClick={() => {
              setTrocando(true);
              window.setTimeout(() => campo.current?.focus(), 0);
            }}
          >
            Trocar
          </Button>
          {!obrigatorio && (
            <Button
              size="sm"
              variant="ghost"
              disabled={desabilitado}
              aria-label={`Tirar ${rotulo.toLocaleLowerCase('pt-BR')}`}
              onClick={() => escolher(null)}
            >
              {rotuloVazio ? `Voltar para ${rotuloVazio.toLocaleLowerCase('pt-BR')}` : 'Tirar'}
            </Button>
          )}
        </div>
      )}

      {mostrandoBusca && (
        <>
          <div className="flex gap-2 items-center">
            <input
              ref={campo}
              id={id}
              type="text"
              value={termo}
              disabled={desabilitado}
              onChange={(e) => setTermo(e.target.value)}
              placeholder={placeholder}
              aria-describedby={idDaDica}
              autoComplete="off"
              className="w-full h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] text-[var(--gs-text)]"
            />
            {trocando && (
              <Button size="sm" variant="ghost" onClick={() => setTrocando(false)}>
                Cancelar
              </Button>
            )}
          </div>
          <p id={idDaDica} className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {!valor && rotuloVazio ? `${rotuloVazio} enquanto ninguém for escolhido. ` : ''}
            {dica ?? ''}
          </p>

          {erro && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          {buscando && !resultado && (
            <p aria-live="polite" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Buscando…
            </p>
          )}
          {resultado && resultado.items.length === 0 && !erro && (
            <p aria-live="polite" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Nenhum resultado para “{termo.trim()}”.
            </p>
          )}
          {resultado && resultado.items.length > 0 && (
            <ul
              aria-label={`Resultados de ${rotulo.toLocaleLowerCase('pt-BR')}`}
              className="m-0 p-0 list-none flex flex-col gap-1 max-h-64 overflow-y-auto"
            >
              {resultado.items.map((item) => {
                const detalhe = detalheDe?.(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => escolher(item)}
                      className="w-full text-left px-3 py-2 rounded-[var(--gs-radius-sm)] cursor-pointer
                        border border-[var(--gs-border)] bg-[var(--gs-surface)] hover:bg-[var(--gs-surface-hover)]"
                    >
                      <span className="font-semibold">{nomeDe(item)}</span>
                      {detalhe ? (
                        <span className="text-[var(--gs-muted)]"> · {detalhe}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {faltam > 0 && (
            <p aria-live="polite" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {`Mostrando ${resultado!.items.length} de ${resultado!.total!.toLocaleString('pt-BR')} — continue digitando para achar os outros ${faltam.toLocaleString('pt-BR')}.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * O CLIENTE, por busca no cadastro inteiro de ativos.
 *
 * A busca é a mesma do F2 do PDV (`GET /core/customers?search`): nome, código,
 * CPF/CNPJ e telefone, com e sem máscara.
 */
export function BuscaDeCliente({
  rotulo = 'Cliente',
  valor,
  aoMudar,
  obrigatorio,
  rotuloVazio,
  dica = 'Digite nome, CPF/CNPJ, telefone ou código.',
  desabilitado,
}: {
  rotulo?: string;
  valor: Escolhido | null;
  aoMudar: (cliente: Customer | null) => void;
  obrigatorio?: boolean;
  rotuloVazio?: string;
  dica?: string;
  desabilitado?: boolean;
}) {
  return (
    <BuscaDeCadastro<Customer>
      rotulo={rotulo}
      valor={valor}
      aoMudar={aoMudar}
      obrigatorio={obrigatorio}
      rotuloVazio={rotuloVazio}
      dica={dica}
      desabilitado={desabilitado}
      placeholder="Buscar cliente"
      buscar={async (termo) => {
        const pagina = await paginaDeClientes({ search: termo, limit: RESULTADOS_POR_BUSCA });
        return { items: pagina.items, total: pagina.totalConhecido ? pagina.total : null };
      }}
      nomeDe={(c) => c.name}
      detalheDe={(c) => c.document || c.phone}
    />
  );
}

/**
 * O PRODUTO, pela busca do balcão (`/products/search`): código, código de
 * barras (principal e adicionais) ou nome — a mesma que a Consignação e o
 * Orçamento já usam para montar itens. Peça de oficina fica fora da busca por
 * texto, que é o que a locação quer: ela recusa peça.
 */
export function BuscaDeProduto({
  rotulo = 'Produto',
  valor,
  aoMudar,
  obrigatorio,
  dica = 'Digite nome, código ou código de barras.',
  desabilitado,
}: {
  rotulo?: string;
  valor: Escolhido | null;
  aoMudar: (produto: Product | null) => void;
  obrigatorio?: boolean;
  dica?: string;
  desabilitado?: boolean;
}) {
  return (
    <BuscaDeCadastro<Product>
      rotulo={rotulo}
      valor={valor}
      aoMudar={aoMudar}
      obrigatorio={obrigatorio}
      dica={dica}
      desabilitado={desabilitado}
      placeholder="Buscar produto"
      minimo={2}
      buscar={async (termo) => ({
        items: await coreApi.searchProducts(termo, { excludeKits: false }),
        total: null,
      })}
      nomeDe={(p) => p.name}
      detalheDe={(p) => p.internal_code}
    />
  );
}
