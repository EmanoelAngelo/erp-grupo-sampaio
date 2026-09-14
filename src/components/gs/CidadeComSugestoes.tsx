/**
 * A CIDADE PELO NOME, E O CÓDIGO IBGE JUNTO (IBGE-MUNICIPIOS).
 *
 * Depois do GAP-PRD-028 a entrega exige o código IBGE do município, e o
 * cliente não sabe o que é isso. Este campo busca a cidade no servidor
 * (`GET /loja/municipios`, a tabela oficial carregada pelo dono) enquanto a
 * pessoa digita e, ao escolher, entrega a cidade com o código e a UF — quem
 * usa o campo guarda os três.
 *
 * Um só, usado no formulário do endereço (Minha conta e checkout) e no
 * cadastro fiscal do emitente. Quem decide se ele aparece é
 * `useTabelaDeMunicipios`: sem a tabela, as telas mostram o campo digitado.
 *
 * TECLADO: setas andam na lista, Enter ESCOLHE e não deixa o Enter subir —
 * dentro do checkout, o Enter do formulário do endereço salva, e salvar com
 * a cidade pela metade não é o que a pessoa pediu. Esc fecha a lista.
 * Sair do campo com o nome exato de uma cidade da lista escolhe essa cidade.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { municipiosApi, normalizarNome, type MunicipioDoIbge } from '@/lib/api/municipios';

/** Espera entre teclas antes de perguntar ao servidor. */
const ESPERA_MS = 200;

export function CidadeComSugestoes({
  uf,
  valor,
  onDigitar,
  onEscolher,
  id,
  className = '',
  placeholder,
  'aria-label': rotulo,
  'aria-describedby': descritoPor,
  'aria-invalid': invalido,
}: {
  /** A UF do endereço; vazia = busca em todas. */
  uf: string;
  /** O nome da cidade no formulário. */
  valor: string;
  /** A pessoa digitou: quem usa apaga o código (ele era de outra cidade). */
  onDigitar: (nome: string) => void;
  onEscolher: (municipio: MunicipioDoIbge) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const listaId = useId();
  const [sugestoes, setSugestoes] = useState<MunicipioDoIbge[]>([]);
  // A UF em que as sugestões foram buscadas: trocou a UF, elas não valem.
  const [ufDasSugestoes, setUfDasSugestoes] = useState('');
  const [aberta, setAberta] = useState(false);
  const [ativo, setAtivo] = useState(-1);
  const relogio = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pedido = useRef(0);

  useEffect(
    () => () => {
      if (relogio.current) clearTimeout(relogio.current);
    },
    [],
  );

  const visiveis = aberta && ufDasSugestoes === uf ? sugestoes : [];
  const semResultado = aberta && ufDasSugestoes === uf && sugestoes.length === 0;

  const procurar = (texto: string) => {
    if (relogio.current) clearTimeout(relogio.current);
    pedido.current += 1;
    const meu = pedido.current;
    if (normalizarNome(texto).replace(/ /g, '').length < 2) {
      setAberta(false);
      setSugestoes([]);
      return;
    }
    const ufDoPedido = uf;
    relogio.current = setTimeout(() => {
      municipiosApi
        .buscar(ufDoPedido, texto)
        .then((r) => {
          if (meu !== pedido.current) return;
          setSugestoes(Array.isArray(r?.itens) ? r.itens : []);
          setUfDasSugestoes(ufDoPedido);
          setAtivo(-1);
          setAberta(true);
        })
        .catch(() => {
          if (meu !== pedido.current) return;
          setSugestoes([]);
          setAberta(false);
        });
    }, ESPERA_MS);
  };

  const escolher = (m: MunicipioDoIbge) => {
    pedido.current += 1;
    if (relogio.current) clearTimeout(relogio.current);
    setAberta(false);
    setSugestoes([]);
    setAtivo(-1);
    onEscolher(m);
  };

  const teclas = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && visiveis.length > 0) {
      e.preventDefault();
      setAtivo((a) => Math.min(a + 1, visiveis.length - 1));
    } else if (e.key === 'ArrowUp' && visiveis.length > 0) {
      e.preventDefault();
      setAtivo((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && visiveis.length > 0) {
      // Com a lista aberta, Enter é da lista — nunca salva o formulário.
      e.preventDefault();
      e.stopPropagation();
      const alvo = ativo >= 0 ? visiveis[ativo] : visiveis.length === 1 ? visiveis[0] : null;
      if (alvo) escolher(alvo);
    } else if (e.key === 'Escape' && aberta) {
      e.stopPropagation();
      setAberta(false);
    }
  };

  const sair = () => {
    const nome = normalizarNome(valor);
    const exatos = visiveis.filter((m) => normalizarNome(m.nome) === nome);
    if (exatos.length === 1) escolher(exatos[0]);
    else setAberta(false);
  };

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-label={rotulo}
        aria-describedby={descritoPor}
        aria-invalid={invalido}
        aria-autocomplete="list"
        aria-expanded={visiveis.length > 0}
        aria-controls={listaId}
        aria-activedescendant={ativo >= 0 && visiveis[ativo] ? `${listaId}-${ativo}` : undefined}
        autoComplete="off"
        placeholder={placeholder ?? 'Digite o nome da cidade'}
        value={valor}
        onChange={(e) => {
          onDigitar(e.target.value);
          procurar(e.target.value);
        }}
        onKeyDown={teclas}
        onBlur={sair}
        className={`w-full ${className}`}
      />
      {visiveis.length > 0 && (
        <ul
          id={listaId}
          role="listbox"
          aria-label="Cidades encontradas"
          className="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-auto m-0 p-1 list-none
            bg-[var(--gs-surface)] border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] shadow-lg"
        >
          {visiveis.map((m, i) => (
            <li
              key={m.codigo}
              id={`${listaId}-${i}`}
              role="option"
              aria-selected={i === ativo}
              // Sem isto, o clique tira o foco do campo antes de chegar aqui.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => escolher(m)}
              className={`px-3 py-2 cursor-pointer rounded-[var(--gs-radius)] flex justify-between gap-3
                hover:bg-[var(--gs-surface-hover)] ${i === ativo ? 'bg-[var(--gs-surface-hover)] font-semibold' : ''}`}
            >
              <span>{m.nome}</span>
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                {m.uf} · {m.codigo}
              </span>
            </li>
          ))}
        </ul>
      )}
      {semResultado && (
        <p role="status" className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
          Nenhuma cidade com esse nome{uf ? ` em ${uf}` : ''}. Confira a UF e o nome.
        </p>
      )}
    </div>
  );
}
