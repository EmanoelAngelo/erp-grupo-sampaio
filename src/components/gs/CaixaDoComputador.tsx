/**
 * QUAL CAIXA É ESTE COMPUTADOR — e a gaveta esquecida de outro dia.
 * (GAP-PRD-039, GAP-PRD-131)
 *
 * Peças pequenas que o PDV, o diálogo do caixa e a tela de Caixa compartilham.
 * Moram fora dos arquivos grandes para que a regra seja escrita uma vez:
 *
 * - `EscolhaDoCaixa`: a operação cadastrou caixas e este computador ainda não
 *   disse qual é. Sem a escolha, o servidor recusa abrir gaveta
 *   (`CORE_TERMINAL_REQUIRED`) — e é isso que impede o segundo operador de
 *   vender na gaveta do colega.
 * - `LinhaDoCaixa`: o caixa escolhido, com "Trocar" — menos quando ele veio do
 *   token de dispositivo, que prende a máquina ao caixa.
 * - `AvisoGavetaDeOutroDia`: a gaveta aberta num dia anterior. Não bloqueia
 *   (uma loja que passa da meia-noite continua vendendo); diz desde quando, há
 *   quantos dias, e o que fazer.
 * - `TETO_FUNDO_DE_TROCO_CENTS`: o teto do fundo de troco, o MESMO nas duas
 *   telas que abrem gaveta (o diálogo do PDV e a tela de Caixa da gestão).
 * - `ImprimirFechamento`: o papel do fechamento para assinar, oferecido logo
 *   depois de fechar — nas três portas que fecham gaveta.
 */
import { useEffect, useRef, useState, type KeyboardEvent as TeclaDoBotao } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { printDocument } from '@/lib/print';
import {
  diaBr,
  fraseDaGavetaDeOutroDia,
  terminaisApi,
  type GavetaDeOutroDia,
  type TerminalDeCaixa,
} from '@/lib/api/terminais';

export function EscolhaDoCaixa({
  onEscolher,
  recusado,
}: {
  onEscolher: (terminalId: string) => void;
  /** O caixa que este computador tinha e que não vale mais — dito, não escondido. */
  recusado?: { id: string; motivo: string } | null;
}) {
  const [caixas, setCaixas] = useState<TerminalDeCaixa[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    terminaisApi
      .listar(true)
      .then((lista) => {
        if (vivo) setCaixas(lista);
      })
      .catch((err: unknown) => {
        if (vivo) {
          setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar os caixas.');
        }
      });
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <section
      data-testid="escolha-do-caixa"
      aria-label="Qual caixa é este computador"
      className="flex flex-col gap-2 rounded-[var(--gs-radius)] border border-[var(--gs-purple-700)]
        bg-[var(--gs-purple-100)] px-4 py-3"
    >
      <p className="m-0 font-semibold text-[var(--gs-purple-900)]">Qual caixa é este computador?</p>
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        Esta operação tem mais de um caixa, e cada um tem a sua gaveta. A escolha fica guardada
        neste computador.
      </p>
      {recusado && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          {recusado.motivo}
        </p>
      )}
      {erro && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {caixas === null && !erro && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando os caixas…</p>
      )}
      {caixas && caixas.length === 0 && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Nenhum caixa ativo. Um gerente cadastra em Configurações › Caixas e terminais.
        </p>
      )}
      {caixas && caixas.length > 0 && (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {caixas.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onEscolher(c.id)}
                className="w-full text-left bg-[var(--gs-surface)] border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] px-3 py-2 cursor-pointer flex justify-between gap-3"
              >
                <span className="font-semibold">{c.name}</span>
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {c.caixaAberto
                    ? `gaveta aberta${c.caixaAberto.openedByName ? ` por ${c.caixaAberto.openedByName}` : ''}`
                      + (c.caixaAberto.deOutroDia ? ` desde ${diaBr(c.caixaAberto.deOutroDia.abertaNoDia)}` : '')
                    : 'gaveta fechada'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LinhaDoCaixa({
  nome,
  fixo,
  onTrocar,
}: {
  nome: string;
  /** Veio do token de dispositivo: a máquina é deste caixa, e não troca. */
  fixo: boolean;
  onTrocar?: () => void;
}) {
  return (
    <p data-testid="linha-do-caixa" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
      Caixa deste computador: <strong className="text-[var(--gs-purple-900)]">{nome}</strong>
      {fixo ? (
        <span className="text-[var(--gs-muted)]"> · registrado neste computador</span>
      ) : (
        onTrocar && (
          <>
            {' · '}
            <button
              type="button"
              onClick={onTrocar}
              className="bg-transparent border-0 p-0 cursor-pointer underline text-[var(--gs-purple-800)]"
            >
              Trocar
            </button>
          </>
        )
      )}
    </p>
  );
}

export function AvisoGavetaDeOutroDia({
  gaveta,
  onFechar,
  rotuloDoBotao = 'Fechar o turno antigo',
}: {
  gaveta: GavetaDeOutroDia;
  onFechar?: () => void;
  rotuloDoBotao?: string;
}) {
  return (
    <div
      role="alert"
      data-testid="gaveta-de-outro-dia"
      className="px-4 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]
        text-[length:var(--gs-text-sm)] flex flex-wrap items-center justify-between gap-3"
    >
      <span>{fraseDaGavetaDeOutroDia(gaveta)}</span>
      {onFechar && (
        <button
          type="button"
          onClick={onFechar}
          className="bg-[var(--gs-warning)] text-white border-0 rounded-[var(--gs-radius)]
            px-3 py-1 cursor-pointer font-semibold shrink-0"
        >
          {rotuloDoBotao}
        </button>
      )}
    </div>
  );
}

/**
 * TETO DO FUNDO DE TROCO — R$ 100.000,00.
 *
 * O campo de valor fica focado quando o diálogo abre, e o leitor de código de
 * barras está ligado na MESMA máquina. Bipar um produto na tela de abertura
 * escrevia "7894561230012" no fundo de troco: `parseReaisToCents` lê treze
 * dígitos sem separador como R$ 7.894.561.230,01, e a gaveta nascia com quase
 * oito bilhões de reais dentro. Todo o fechamento do dia sai errado a partir
 * daí.
 *
 * O teto é folgado de propósito: nenhuma gaveta de balcão abre com cem mil
 * reais, e um número redondo é o que o operador entende quando a recusa
 * aparece. É o MESMO número de `TETO_DE_DINHEIRO_NA_GAVETA_CENTS` do servidor,
 * que recusa abertura, suprimento e ajuste acima dele (H-caixa-seguranca-14).
 *
 * MORA AQUI, E NÃO NO DIÁLOGO DO PDV (H-caixa-seguranca-01, as duas telas). O
 * DEFEITO: a constante era local de `CaixaPdvDialog`, e a tela de Caixa da
 * gestão — a outra porta que abre gaveta — não a conhecia: o mesmo código de
 * barras bipado no "Fundo de troco" dela ia inteiro para o servidor, e o
 * operador só descobria pela recusa, longe do campo. Agora as duas telas leem
 * o teto daqui e avisam NO CAMPO, antes de enviar.
 */
export const TETO_FUNDO_DE_TROCO_CENTS = 100_000_00;

/**
 * O PAPEL DO FECHAMENTO, LOGO DEPOIS DE FECHAR (H-caixa-seguranca-11, a metade
 * da tela).
 *
 * O DEFEITO: o servidor já desenhava o fechamento com rótulos legíveis, o
 * caixa, quem abriu e quem fechou, cada sangria com o motivo, o troco e a
 * pendência declarada — e NENHUMA tela pedia `CASH_CLOSING`. O operador
 * fechava o turno e ia embora sem o papel para assinar; o gestor conferia o
 * dinheiro contra a memória de quem contou.
 *
 * Aparece nas três portas que fecham gaveta (o diálogo do PDV, a tela de Caixa
 * e a lista de gavetas abertas), com o FOCO no botão: Enter imprime, Esc segue
 * sem imprimir — o balcão fecha o dia sem tirar a mão do teclado. Quem chama
 * guarda o id da sessão ANTES de a tela esquecer a gaveta: o PDV zera `cash`
 * no mesmo instante do fechamento.
 *
 * A IMPRESSÃO QUE FALHA NÃO DESFAZ NADA. O turno já está fechado no servidor;
 * a mensagem diz isso com todas as letras e mostra o motivo que veio da
 * impressão (sem papel, agente fora, pop-up bloqueado), e o botão continua ali
 * para tentar de novo.
 */
export function ImprimirFechamento({
  sessionId,
  terminalId,
  onSeguir,
}: {
  /** A sessão que ACABOU de fechar — o papel é dela. */
  sessionId: string;
  /** O caixa da gaveta: é a impressora de cupom dele que o servidor procura. */
  terminalId: string | null;
  /** Seguir sem imprimir (ou depois de imprimir): a oferta sai da tela. */
  onSeguir: () => void;
}) {
  const [imprimindo, setImprimindo] = useState(false);
  const [feito, setFeito] = useState<string | null>(null);
  const [falha, setFalha] = useState<string | null>(null);
  const botaoImprimir = useRef<HTMLButtonElement | null>(null);
  const botaoSeguir = useRef<HTMLButtonElement | null>(null);
  // Dois Enter rápidos (ou o repique do botão) não podem virar dois papéis.
  const emCurso = useRef(false);

  useEffect(() => {
    botaoImprimir.current?.focus();
  }, []);

  // Saiu o papel: o foco vai para "Concluir", e um segundo Enter não imprime de
  // novo. Falhou: volta para "Imprimir fechamento", que é a próxima tentativa.
  useEffect(() => {
    if (feito) botaoSeguir.current?.focus();
  }, [feito]);
  useEffect(() => {
    if (falha) botaoImprimir.current?.focus();
  }, [falha]);

  const imprimir = async () => {
    if (emCurso.current) return;
    emCurso.current = true;
    setImprimindo(true);
    setFalha(null);
    try {
      const r = await printDocument('CASH_CLOSING', sessionId, { terminalId });
      setFeito(
        r.via === 'agente'
          ? 'O fechamento saiu na impressora do caixa. Confira, assine e guarde junto do dinheiro.'
          : 'O fechamento abriu na janela de impressão. Imprima, confira e assine.'
            + (r.aviso ? ` ${r.aviso}` : ''),
      );
    } catch (err) {
      /*
        A FRASE DA FALHA NÃO PODE CONTRADIZER O MOTIVO (revisão do H-caixa-seguranca-11).

        O DEFEITO: a frase fixa era "só o papel não saiu. <motivo> Confira a
        impressora e tente de novo." — e `printDocument` também falha quando o
        agente PEGOU o papel e ainda não confirmou ("aguarde o papel antes de
        imprimir de novo") ou quando não conseguiu cancelar ("o cupom ainda pode
        sair"). Nesses casos a tela dizia que o papel não saiu e mandava tentar
        de novo, com o foco no botão: um Enter e saíam DOIS fechamentos. Agora a
        frase só diz o que é sempre verdade (a falha não desfaz o fechamento), e
        a orientação é a do motivo, que já diz o que fazer; o "tente de novo"
        fica só para a falha que veio sem explicação.
      */
      const motivo = err instanceof Error && err.message ? err.message : null;
      setFalha(
        'A impressão do fechamento não se confirmou, e isso não desfaz o fechamento do turno. '
          + (motivo ?? 'Não foi possível imprimir o fechamento. Confira a impressora e tente de novo.'),
      );
    } finally {
      emCurso.current = false;
      setImprimindo(false);
    }
  };

  const aoTeclarNoImprimir = (e: TeclaDoBotao<HTMLButtonElement>) => {
    if (e.key === 'Enter') {
      // O Enter é tratado aqui (e não deixado ao clique nativo do botão) para
      // valer igual em todo navegador — e o `preventDefault` impede o clique
      // nativo de mandar um segundo papel.
      e.preventDefault();
      void imprimir();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onSeguir();
    }
  };
  const aoTeclarNoSeguir = (e: TeclaDoBotao<HTMLButtonElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onSeguir();
  };

  return (
    <section
      aria-label="Papel do fechamento"
      data-testid="imprimir-fechamento"
      className="flex flex-col gap-2 rounded-[var(--gs-radius)] border border-[var(--gs-purple-700)]
        bg-[var(--gs-purple-100)] px-4 py-3"
    >
      <p className="m-0 font-semibold text-[var(--gs-purple-900)]">
        Turno fechado. Imprima o papel do fechamento para conferir e assinar.
      </p>
      {feito && (
        <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          {feito}
        </p>
      )}
      {falha && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {falha}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!feito && (
          <button
            ref={botaoImprimir}
            type="button"
            disabled={imprimindo}
            onClick={() => void imprimir()}
            onKeyDown={aoTeclarNoImprimir}
            className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
              px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
          >
            {imprimindo ? 'Imprimindo…' : 'Imprimir fechamento'}
          </button>
        )}
        <button
          ref={botaoSeguir}
          type="button"
          onClick={onSeguir}
          onKeyDown={aoTeclarNoSeguir}
          className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer"
        >
          {feito ? 'Concluir' : 'Seguir sem imprimir'}
        </button>
        {!feito && (
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Enter imprime · Esc segue sem imprimir
          </span>
        )}
      </div>
    </section>
  );
}
