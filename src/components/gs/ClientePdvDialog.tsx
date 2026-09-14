/**
 * Busca e cadastro rápido de cliente SEM sair da venda — GAP-V53.
 *
 * O QUE HAVIA ANTES
 *
 * F2 despejava a lista completa de clientes num scroll de 160px sem filtro:
 * com centenas de cadastros, escolher era rolagem com fila no balcão. E
 * cadastrar exigia abandonar o PDV rumo à tela Clientes — perdendo o carrinho
 * de vista com o cliente na frente.
 *
 * COMO FUNCIONA
 *
 * A busca é VIVA sobre a rota de sempre (GET /core/customers?search): o termo
 * viaja COMO FOI DIGITADO — nome, CPF/CNPJ com ou sem máscara, telefone ou
 * código — e quem normaliza os dois lados é o servidor, que tem teste próprio
 * para isso (busca-cliente-no-balcao.test.ts). Limpar a máscara aqui seria a
 * segunda implementação da regra, e as duas divergiriam em silêncio.
 *
 * O cadastro rápido é o formulário MÍNIMO da ficha (nome obrigatório, CPF e
 * telefone opcionais) pela MESMA porta do cadastro completo
 * (POST /core/customers): o servidor valida o documento, recusa duplicata e
 * grava a auditoria — e a recusa dele aparece AQUI, com o digitado preservado,
 * que é o padrão da ficha de clientes. O recém-criado JÁ SAI escolhido na
 * venda: quem cadastra no balcão cadastra para vender agora.
 *
 * Selecionar (ou cadastrar) devolve o cliente a quem chamou e é o CHAMADOR
 * quem aplica à venda — a reprecificação pela tabela do cliente já existe no
 * PdvPage (`precificadaPara` + POST /pricing/cart) e este diálogo não a
 * duplica. Esc fecha sem tocar em nada: o carrinho fica exatamente como
 * estava.
 */
import { useEffect, useRef, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button } from './ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Customer } from '@/lib/api/core';
import { paginaDeClientes } from '@/lib/api/paginas';

/** Quanto a busca espera depois da última tecla antes de ir ao servidor. */
const ATRASO_DA_BUSCA_MS = 200;

export function ClientePdvDialog({
  onSelect,
  onClose,
}: {
  /** O cliente escolhido — ou `null`, que é o consumidor final (sem cliente). */
  onSelect: (cliente: Customer | null) => void;
  onClose: () => void;
}) {
  const [termo, setTermo] = useState('');
  /** Nulo = primeira carga a caminho; lista vazia = buscou e não achou. */
  const [clientes, setClientes] = useState<Customer[] | null>(null);
  /**
   * Quantos o servidor achou — não só os que vieram (GAP-PRD-070).
   *
   * A primeira carga, sem termo, traz os 100 primeiros em ordem de nome. Sem
   * dizer que eram 100 de 1.180, o operador rolava até o fim, não achava a
   * "Zuleide" e cadastrava de novo. Nulo = o servidor não contou.
   */
  const [totalAchado, setTotalAchado] = useState<number | null>(null);
  const [erroBusca, setErroBusca] = useState<string | null>(null);

  // O formulário mínimo do cadastro rápido.
  const [cadastrando, setCadastrando] = useState(false);
  const [nome, setNome] = useState('');
  const [documento, setDocumento] = useState('');
  const [telefone, setTelefone] = useState('');
  const [erroCadastro, setErroCadastro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const buscaRef = useRef<HTMLInputElement>(null);
  const nomeRef = useRef<HTMLInputElement>(null);
  /**
   * A ida mais recente ao servidor. Busca viva responde fora de ordem quando a
   * rede engasga: sem este número, a resposta ATRASADA do termo antigo
   * sobrescreveria a lista do termo novo — e o operador clicaria no cliente
   * errado com a lista trocando debaixo do dedo.
   */
  const idaAtual = useRef(0);
  const primeiraCarga = useRef(true);

  useEffect(() => {
    buscaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cadastrando) nomeRef.current?.focus();
  }, [cadastrando]);

  // Esc fecha e o carrinho fica como estava. Captura, porque o handler de
  // atalhos da página está desligado enquanto este diálogo existe — a mesma
  // doutrina dos outros modais do PDV.
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

  /*
    A BUSCA VIVA. A primeira carga sai na hora (é ela que põe a lista na tela
    ao abrir o diálogo); as seguintes esperam a pessoa parar de digitar — sem o
    atraso, cada tecla do CPF viraria uma ida ao servidor na tela mais usada da
    loja. Falha não é fingida de "ninguém encontrado": tem frase própria, e o
    operador sabe que é a rede, não o cadastro.
  */
  useEffect(() => {
    const atraso = primeiraCarga.current ? 0 : ATRASO_DA_BUSCA_MS;
    primeiraCarga.current = false;
    const ida = ++idaAtual.current;
    const alvo = termo.trim();
    const timer = window.setTimeout(() => {
      paginaDeClientes({ search: alvo || undefined })
        .then((pagina) => {
          if (ida !== idaAtual.current) return;
          setClientes(pagina.items);
          setTotalAchado(pagina.totalConhecido ? pagina.total : null);
          setErroBusca(null);
        })
        .catch((err) => {
          if (ida !== idaAtual.current) return;
          setClientes([]);
          setTotalAchado(null);
          setErroBusca(
            err instanceof ApiRequestError
              ? err.message
              : 'Não foi possível buscar clientes. Tente de novo.',
          );
        });
    }, atraso);
    return () => window.clearTimeout(timer);
  }, [termo]);

  /**
   * Abre o cadastro aproveitando o que já foi digitado na busca: quem
   * procurou "João da Feira" e não achou não redigita o nome. Só o NOME é
   * semeado — um termo só de dígitos tanto pode ser CPF quanto telefone, e
   * chutar o campo errado mandaria um telefone à validação de CPF.
   */
  const abrirCadastro = () => {
    const digitado = termo.trim();
    if (digitado && !nome && /[^\d.\-/\s()]/.test(digitado)) setNome(digitado);
    setErroCadastro(null);
    setCadastrando(true);
  };

  const cadastrar = async () => {
    // Cinto do submit implícito (Enter num campo): o botão já não arma sem
    // nome, e o servidor recusaria de qualquer forma — com a mesma frase.
    if (!nome.trim() || salvando) return;
    setSalvando(true);
    setErroCadastro(null);
    try {
      const criado = await coreApi.createCustomer({
        name: nome.trim(),
        // Vazio nem viaja: `undefined` é "sem documento", e o servidor não
        // gasta validação com o que ninguém digitou.
        document: documento.trim() || undefined,
        phone: telefone.trim() || undefined,
      });
      // O recém-criado JÁ SAI escolhido: quem cadastra no balcão cadastra
      // para vender agora. Quem chama fecha o diálogo e reprecifica.
      onSelect(criado);
    } catch (err) {
      /*
        A recusa fica NO formulário, com o digitado intacto — o padrão da
        ficha de clientes: `CORE_INVALID_DOCUMENT` e `CORE_DUPLICATE_DOCUMENT`
        chegam como frase do servidor, e fechar jogaria fora o cadastro
        inteiro por causa de um dígito.
      */
      setErroCadastro(
        err instanceof ApiRequestError
          ? err.message
          : 'Não foi possível cadastrar o cliente. Tente de novo.',
      );
    } finally {
      setSalvando(false);
    }
  };

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
      aria-label="Cliente da venda (F2)"
    >
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Cliente da venda
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Escolher aplica na hora — a tabela de preço do cliente reprecifica o carrinho.
            Esc volta ao carrinho como estava.
          </p>
        </header>

        {!cadastrando && (
          <div className="px-6 py-4 flex flex-col gap-3">
            <input
              ref={buscaRef}
              aria-label="Buscar cliente"
              placeholder="Nome, CPF/CNPJ, telefone ou código — com ou sem máscara"
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              className={campo}
            />

            {erroBusca && (
              <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                {erroBusca}
              </p>
            )}

            {/*
              TIRAR O CLIENTE PRECISA SER POSSÍVEL — a lição da lista antiga,
              preservada. O cliente decide o preço: um revendedor escolhido
              por engano ficaria dando 15% ao carrinho inteiro sem isto. No
              topo, e não no fim: é a opção que se procura com pressa.
            */}
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="w-full text-left px-3 py-2 bg-transparent border border-dashed
                border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] cursor-pointer
                hover:bg-[var(--gs-surface-hover)] text-[var(--gs-muted)] italic"
            >
              Consumidor final (sem cliente)
            </button>

            {clientes === null ? (
              <p role="status" className="m-0 text-[var(--gs-text-soft)]">
                Carregando…
              </p>
            ) : clientes.length === 0 ? (
              <p className="m-0 text-[var(--gs-muted)]">
                {termo.trim()
                  ? `Nenhum cliente para "${termo.trim()}". Confira o termo — ou cadastre agora, sem sair da venda.`
                  : 'Nenhum cliente cadastrado.'}
              </p>
            ) : (
              <ul className="list-none m-0 p-0 border border-[var(--gs-border)] rounded-[var(--gs-radius)] overflow-hidden max-h-[320px] overflow-y-auto">
                {clientes.map((c) => (
                  <li key={c.id} className="border-b border-[var(--gs-border)] last:border-0">
                    {/*
                      `aria-label` com o NOME sozinho, de propósito: documento
                      e telefone abaixo são conferência visual, e um leitor de
                      tela anunciando o CPF inteiro a cada linha só atrasaria.
                    */}
                    <button
                      type="button"
                      aria-label={c.name}
                      onClick={() => onSelect(c)}
                      className="w-full flex flex-col gap-0.5 px-4 py-3 bg-transparent border-0
                        cursor-pointer text-left hover:bg-[var(--gs-surface-hover)]"
                    >
                      <span className="font-semibold text-[var(--gs-text)]">{c.name}</span>
                      {(c.document || c.phone || c.code) && (
                        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {[c.code, c.document, c.phone].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* O corte se declara — e diz o gesto que acha os outros. */}
            {clientes !== null && totalAchado !== null && totalAchado > clientes.length && (
              <p aria-live="polite" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {`Mostrando ${clientes.length} de ${totalAchado.toLocaleString('pt-BR')} clientes — `
                  + 'digite nome, CPF, telefone ou código para achar os outros.'}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              {/*
                Sem peneira de perfil aqui, e é decisão: todo perfil que
                alcança o PDV (caixas, atendente, gerência) está na lista do
                POST /core/customers. Se um dia divergirem, a recusa do
                servidor aparece legível no formulário — nunca um botão morto.
              */}
              <Button type="button" variant="secondary" onClick={abrirCadastro}>
                Cadastrar cliente novo
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                Fechar (Esc)
              </Button>
            </div>
          </div>
        )}

        {cadastrando && (
          <form
            className="px-6 py-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void cadastrar();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Nome — obrigatório
              </span>
              <input
                ref={nomeRef}
                aria-label="Nome do cliente"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                className={campo}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                CPF/CNPJ — com ou sem máscara; o servidor guarda só os dígitos e confere o
                verificador
              </span>
              <input
                aria-label="CPF/CNPJ"
                value={documento}
                onChange={(e) => setDocumento(e.target.value)}
                className={campo}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Telefone
              </span>
              <input
                aria-label="Telefone"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
                className={campo}
              />
            </label>

            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Só o nome é obrigatório — endereço, e-mail e o resto completam-se depois, na
              ficha em Cadastros › Clientes.
            </p>

            {erroCadastro && (
              <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                {erroCadastro}
              </p>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <Button type="button" variant="ghost" onClick={() => setCadastrando(false)}>
                Voltar à busca
              </Button>
              <Button type="submit" loading={salvando} disabled={!nome.trim()}>
                Cadastrar e usar na venda
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
