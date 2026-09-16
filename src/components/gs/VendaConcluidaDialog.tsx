/**
 * VENDA CONCLUÍDA — a tela que o caixa vê depois de receber, antes da próxima.
 *
 * O Finalizar fechava tudo em silêncio: uma faixa verde no alto, o carrinho
 * limpo, e o cupom — quando saía — saía sozinho na térmica. O operador não via
 * o número da venda, não conferia o troco num lugar só e não decidia se o
 * cliente queria o papel.
 *
 * Aqui ele vê o que aconteceu (número, total, pagamentos, troco, a situação
 * fiscal sem misturar os estados, o resumo do cupom) e escolhe, pelo teclado:
 *
 *   Enter  → imprimir (o botão Imprimir nasce com o foco)
 *   Esc    → não imprimir e começar a próxima venda
 *
 * E o LEITOR NÃO BIPA NO VAZIO: se o caixa já passa o próximo produto com esta
 * tela aberta, a primeira tecla fecha a tela (sem imprimir) e o que foi bipado
 * segue para o campo de leitura — o Enter do scanner não vira "Imprimir".
 *
 * Imprimir não refaz nada: cria só um papel para o mesmo documento — e não
 * mexe em estoque nem em caixa. O foco fica preso aqui enquanto a tela está
 * aberta (useArmadilhaDeFoco), como em todo modal do sistema.
 */
import { useLayoutEffect, useRef } from 'react';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { estaNoTopo, useArmadilhaDeFoco } from '@/components/gs/armadilhaDeFoco';

export type EstadoFiscalDaVenda =
  /** A NFC-e desta venda foi AUTORIZADA pela SEFAZ. */
  | { tipo: 'autorizada' }
  /** A NFC-e está a caminho (fila): ainda não autorizada, e será transmitida. */
  | { tipo: 'pendente'; motivo?: string | null }
  /*
    OS TRÊS ESTADOS QUE ERAM "PENDENTE" E NÃO SÃO (F-cupom-fiscal-01/02).

    A nota REJEITADA aparecia em amarelo dizendo "a nota segue na fila e será
    transmitida" — e rejeitada não volta sozinha: só sai de lá por correção
    manual, com número novo. O caixa dizia ao cliente que a nota "ia chegar".
    A nota em ERRO sem nova tentativa marcada é o mesmo desfecho. E a nota em
    CONTINGÊNCIA off-line já VALE no balcão: o papel dela é o DANFCE de
    contingência, obrigatório — e a faixa amarela mandava entregar o
    comprovante não fiscal.
  */
  /** A SEFAZ recusou a NFC-e: a venda está SEM nota até alguém corrigir. */
  | { tipo: 'rejeitada'; motivo?: string | null }
  /** A NFC-e falhou e não há nova tentativa automática marcada. */
  | { tipo: 'erro'; motivo?: string | null }
  /** Emitida em contingência off-line: o DANFCE de contingência é o papel. */
  | { tipo: 'contingencia'; prazo?: string | null }
  /** Esta venda não gerou NFC-e agora: o papel é o comprovante NÃO fiscal. */
  | { tipo: 'nao_fiscal'; motivo?: string | null }
  /** O servidor não estava alcançável: a venda está guardada neste computador. */
  | { tipo: 'offline' };

export interface VendaConcluida {
  /** Número da venda no servidor. Nulo na venda guardada offline. */
  numero: number | string | null;
  totalCents: number;
  trocoCents: number;
  pagamentos: { rotulo: string; valorCents: number }[];
  itens: { descricao: string; quantidade: number; totalCents: number }[];
  estadoFiscal: EstadoFiscalDaVenda;
}

const FAIXA: Record<EstadoFiscalDaVenda['tipo'], { rotulo: string; detalhe: string; cor: string }> = {
  autorizada: {
    rotulo: 'VENDA FISCAL AUTORIZADA — NFC-e',
    detalhe: 'A nota foi autorizada. Imprimir entrega o DANFE NFC-e.',
    cor: 'var(--gs-success)',
  },
  pendente: {
    rotulo: 'VENDA FISCAL PENDENTE — NFC-e ainda não autorizada',
    detalhe: 'A nota segue na fila e será transmitida. Imprimir entrega o comprovante NÃO fiscal.',
    cor: 'var(--gs-warning)',
  },
  rejeitada: {
    rotulo: 'NFC-e REJEITADA — a venda está sem nota',
    detalhe:
      'A SEFAZ recusou a nota, e ela não sai sozinha: chame a gerência para corrigir. '
      + 'Imprimir entrega o comprovante NÃO fiscal.',
    cor: 'var(--gs-danger)',
  },
  erro: {
    rotulo: 'NFC-e COM ERRO — a venda está sem nota',
    detalhe:
      'A emissão falhou e não há nova tentativa marcada: chame a gerência. '
      + 'Imprimir entrega o comprovante NÃO fiscal.',
    cor: 'var(--gs-danger)',
  },
  contingencia: {
    rotulo: 'NFC-e EMITIDA EM CONTINGÊNCIA',
    detalhe:
      'Imprimir entrega o DANFCE de contingência — obrigatório ao cliente. '
      + 'A nota é transmitida sozinha quando a SEFAZ voltar.',
    cor: 'var(--gs-warning)',
  },
  nao_fiscal: {
    rotulo: 'COMPROVANTE NÃO FISCAL',
    detalhe: 'Esta venda não gerou NFC-e agora. O papel não substitui a nota.',
    cor: 'var(--gs-info)',
  },
  offline: {
    rotulo: 'OFFLINE — VENDA GUARDADA, PENDENTE DE SINCRONIZAÇÃO',
    detalhe: 'Ela sobe sozinha quando a conexão voltar — não lance de novo. O papel é o comprovante NÃO fiscal.',
    cor: 'var(--gs-warning)',
  },
};

export function VendaConcluidaDialog({
  venda,
  onImprimir,
  onNovaVenda,
  onDigitacao,
  imprimindo = false,
  erroDeImpressao = null,
}: {
  venda: VendaConcluida;
  onImprimir: () => void;
  onNovaVenda: () => void;
  /** Uma tecla comum com a tela aberta (o scanner já no próximo produto): fecha e repassa. */
  onDigitacao?: (tecla: string) => void;
  imprimindo?: boolean;
  erroDeImpressao?: string | null;
}) {
  const painelRef = useRef<HTMLDivElement>(null);
  const imprimirRef = useRef<HTMLButtonElement>(null);

  useArmadilhaDeFoco(painelRef);

  /*
    O FOCO E O OUVINTE LIGAM NO COMMIT (useLayoutEffect), E NÃO DEPOIS DELE.

    Esta tela aparece com a resposta do servidor — uma atualização fora de
    evento, que o React desenha numa tarefa do agendador. Com `useEffect`, o
    foco no Imprimir e o ouvinte do Esc e do bipe só entravam na volta
    SEGUINTE do agendador: nesse intervalo a tela já estava de pé, com o foco
    ainda onde a venda o deixou e ninguém escutando. O primeiro caractere do
    próximo código — o caixa bipa assim que vê a tela — caía na página: não
    fechava a tela nem chegava ao campo de leitura; e o Esc não começava a
    próxima venda. É a classe do 808c1c9 no PDV: não existe tela desenhada sem
    o foco e o ouvinte dela.
  */
  // Declarado DEPOIS da armadilha: o foco inicial é o botão Imprimir (Enter imprime).
  useLayoutEffect(() => {
    imprimirRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc é "não imprimir, próxima venda" — e não chega aos atalhos do PDV por baixo.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onNovaVenda();
        return;
      }
      /*
        O bipe do próximo produto: tecla de um caractere, sem modificador,
        dentro desta tela.

        "DENTRO" INCLUI O CORPO DA PÁGINA QUANDO ESTA TELA É A DE CIMA
        (D-pdv-teclado-M07). O foco pode cair no `body` com a tela aberta — o
        botão focado ficou indisponível, um clique no fundo escuro —, e aí o
        keydown chega com `target = body`, que não está dentro do painel. O
        bipe inteiro se perdia no corpo da página, sem aviso: nada no campo de
        leitura, nada no carrinho.
      */
      const alvoAceito =
        e.target instanceof Node
        && (painelRef.current?.contains(e.target)
          || ((e.target === document.body || e.target === document.documentElement)
            && estaNoTopo(painelRef.current)));
      if (
        onDigitacao
        && e.key.length === 1
        && e.key !== ' '
        && !e.ctrlKey
        && !e.altKey
        && !e.metaKey
        && alvoAceito
      ) {
        e.preventDefault();
        e.stopPropagation();
        onDigitacao(e.key);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onNovaVenda, onDigitacao]);

  const faixa = FAIXA[venda.estadoFiscal.tipo];
  const motivo =
    venda.estadoFiscal.tipo === 'pendente'
    || venda.estadoFiscal.tipo === 'nao_fiscal'
    || venda.estadoFiscal.tipo === 'rejeitada'
    || venda.estadoFiscal.tipo === 'erro'
      ? venda.estadoFiscal.motivo
      : venda.estadoFiscal.tipo === 'contingencia' && venda.estadoFiscal.prazo
        ? `prazo de transmissão: ${new Date(venda.estadoFiscal.prazo).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
        : null;
  const mostrados = venda.itens.slice(0, 8);
  const resto = venda.itens.length - mostrados.length;

  return (
    <div
      ref={painelRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="venda-concluida-titulo"
    >
      <div className="w-full max-w-[560px] bg-[var(--gs-surface)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] p-6 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="venda-concluida-titulo" className="m-0 text-[length:var(--gs-text-xl)] font-bold text-[var(--gs-purple-900)]">
            Venda concluída
          </h2>
          <span className="text-[length:var(--gs-text-lg)] font-semibold text-[var(--gs-text-soft)]" data-testid="venda-concluida-numero">
            {venda.numero !== null ? `Venda #${venda.numero}` : 'Venda guardada (sem número ainda)'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] px-4 py-3">
            <div className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Total</div>
            <div className="text-[28px] font-bold text-[var(--gs-purple-900)]" data-testid="venda-concluida-total">
              {formatCents(venda.totalCents)}
            </div>
          </div>
          <div className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] px-4 py-3">
            <div className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Troco</div>
            <div
              className={`text-[28px] font-bold ${venda.trocoCents > 0 ? 'text-[var(--gs-success)]' : 'text-[var(--gs-muted)]'}`}
              data-testid="venda-concluida-troco"
            >
              {formatCents(venda.trocoCents)}
            </div>
          </div>
        </div>

        <div className="text-[length:var(--gs-text-sm)]" data-testid="venda-concluida-pagamentos">
          {venda.pagamentos.map((p, n) => (
            <div key={`${p.rotulo}-${p.valorCents}-${n}`} className="flex justify-between">
              <span>{p.rotulo}</span>
              <span className="font-semibold">{formatCents(p.valorCents)}</span>
            </div>
          ))}
        </div>

        <div
          role="status"
          data-testid="venda-concluida-fiscal"
          data-estado={venda.estadoFiscal.tipo}
          className="rounded-[var(--gs-radius)] px-4 py-3 border-2"
          style={{ borderColor: faixa.cor }}
        >
          <div className="font-bold" style={{ color: faixa.cor }}>{faixa.rotulo}</div>
          <div className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            {faixa.detalhe}
            {motivo ? ` (${motivo})` : ''}
          </div>
        </div>

        <details className="text-[length:var(--gs-text-sm)]">
          <summary className="cursor-pointer text-[var(--gs-text-soft)]">
            Resumo do cupom — {venda.itens.length} item(ns)
          </summary>
          <ul className="list-none m-0 mt-2 p-0 flex flex-col gap-1">
            {mostrados.map((i, n) => (
              <li key={`${i.descricao}-${n}`} className="flex justify-between gap-3">
                <span className="truncate">
                  {formatQuantity(i.quantidade)} × {i.descricao}
                </span>
                <span>{formatCents(i.totalCents)}</span>
              </li>
            ))}
            {resto > 0 && <li className="text-[var(--gs-muted)]">e mais {resto} item(ns)</li>}
          </ul>
        </details>

        {erroDeImpressao && (
          <p role="alert" className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
            {erroDeImpressao}
          </p>
        )}

        <div className="flex gap-3 justify-end flex-wrap">
          <button
            type="button"
            onClick={onNovaVenda}
            className="h-[52px] px-5 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
              text-[var(--gs-text)] font-semibold cursor-pointer"
          >
            Não imprimir · Nova venda <kbd className="ml-1 text-[length:var(--gs-text-xs)] opacity-70">Esc</kbd>
          </button>
          {/*
            `aria-disabled`, e NÃO `disabled`, durante a impressão
            (D-pdv-teclado-M07). Este botão nasce com o foco; desabilitá-lo
            joga o foco no `body` e o leitor fica mudo — o próximo bipe caía
            no corpo da página. Indisponível para leitor de tela e para o
            clique (o `onClick` ignora), mas o foco fica onde está.
          */}
          <button
            ref={imprimirRef}
            type="button"
            onClick={() => {
              if (imprimindo) return;
              onImprimir();
            }}
            aria-disabled={imprimindo || undefined}
            className={`h-[52px] px-6 rounded-[var(--gs-radius)] border-0 bg-[var(--gs-purple-800)] text-white font-bold cursor-pointer
              focus:outline focus:outline-4 focus:outline-[var(--gs-purple-300)] ${imprimindo ? 'opacity-60 cursor-wait' : ''}`}
          >
            {imprimindo ? 'Imprimindo…' : 'Imprimir'} <kbd className="ml-1 text-[length:var(--gs-text-xs)] opacity-80">Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
