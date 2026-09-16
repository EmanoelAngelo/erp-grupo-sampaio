/**
 * ============================================================================
 * FECHAR O TURNO COM DINHEIRO ELETRÔNICO INDEFINIDO (GAP-PRD-081)
 * ============================================================================
 *
 * O servidor passou a recusar o fechamento quando o turno tem cobrança da
 * maquininha sem resposta, cobrança ainda no aparelho, cobrança aprovada que
 * venda nenhuma usou, estorno de venda desfeita não confirmado ou PIX
 * pendente numa venda da gaveta. Fechar assim mesmo exige declarar que está
 * ciente, com o motivo — e é esta peça que diz O QUÊ, pelo nome e pelo valor,
 * e colhe a declaração. As três telas que fecham gaveta (o diálogo do PDV, a
 * tela de Caixa e as gavetas abertas da operação) usam a mesma.
 *
 * Duas pendências que não são de maquininha entraram depois, pelo mesmo
 * argumento — dinheiro do turno que fica indefinido se ninguém disser: a venda
 * guardada sem servidor e recusada (GAP-PRD-045), cujo dinheiro está NA gaveta
 * sem venda; e a devolução em duas etapas cujo reembolso ainda não foi
 * registrado (auditoria do PDV), que é dinheiro que a loja DEVE — e que, em
 * espécie, também está na gaveta sem ser dela.
 */
import { formatCents } from '@/components/gs/format';
import type { PendenciasEletronicas, TipoDePendenciaEletronica } from '@/lib/api/core';

const ROTULO: Record<TipoDePendenciaEletronica, string> = {
  nao_confirmada: 'Cobrança sem resposta da operadora',
  em_andamento: 'Cobrança ainda em andamento no aparelho',
  aprovada_sem_venda: 'Cobrança aprovada que nenhuma venda usou',
  estorno_pendente: 'Estorno de venda desfeita ainda não confirmado',
};

const MEIO: Record<string, string> = { credit: 'crédito', debit: 'débito', pix: 'PIX' };

export function PendenciasDoFechamento({
  pendencias,
  ciente,
  motivo,
  onCiente,
  onMotivo,
  idBase = 'pendencias',
}: {
  pendencias: PendenciasEletronicas;
  ciente: boolean;
  motivo: string;
  onCiente: (v: boolean) => void;
  onMotivo: (v: string) => void;
  /** Para dar nomes únicos quando há mais de uma gaveta na tela. */
  idBase?: string;
}) {
  /*
    O QUE DESTA LISTA ESTÁ MESMO NA GAVETA (P00-caixa-gaveta).

    A primeira versão somava TODA devolução pendente e mandava o operador
    procurar, na contagem, dinheiro que podia nunca ter passado por ali: a
    venda devolvida podia ter sido paga no cartão (o valor cai na conta) ou a
    dívida podia ter nascido num turno anterior, cuja gaveta já foi entregue.
    Quem responde agora é `naGavetaCents`, calculado pelo servidor a partir do
    meio de pagamento da venda e da gaveta em que ela foi paga.

    A venda guardada e recusada continua inteira: o dinheiro dela entrou NESTA
    gaveta sem venda que o explique — é a definição da pendência.

    Servidor anterior não manda o campo; então não se sabe, e o rodapé deixa
    de afirmar o lugar do dinheiro em vez de chutar.
  */
  const devolucoes = pendencias.devolucoesAguardandoReembolso ?? [];
  const seSabeOndeEsta = devolucoes.every((d) => d.naGavetaCents !== undefined);
  const naGavetaCents =
    (pendencias.vendasOffline ?? []).reduce((s, v) => s + v.receivedCents, 0)
    + devolucoes.reduce((s, d) => s + (d.naGavetaCents ?? 0), 0);
  const temEletronico = pendencias.cobrancas.length + pendencias.pagamentosPendentes.length > 0;
  return (
    <div
      role="alert"
      data-testid="pendencias-do-fechamento"
      className="rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)]
        px-4 py-3 flex flex-col gap-2 text-[length:var(--gs-text-sm)]"
    >
      <strong className="text-[var(--gs-warning)]">
        {(pendencias.vendasOffline?.length ?? 0) > 0
          || (pendencias.devolucoesAguardandoReembolso?.length ?? 0) > 0
          ? 'Pendências deste turno'
          : 'Dinheiro eletrônico ainda indefinido neste turno'}{' '}
        — {pendencias.quantidade} pendência(s), {formatCents(pendencias.totalCents)}
      </strong>
      <ul className="m-0 pl-5 flex flex-col gap-0.5">
        {pendencias.cobrancas.map((c) => (
          <li key={c.transactionId}>
            {ROTULO[c.tipo]} — {formatCents(c.amountInCents)} ({MEIO[c.method] ?? c.method})
            {c.simulated ? ' · TESTE' : ''}
          </li>
        ))}
        {pendencias.pagamentosPendentes.map((p) => (
          <li key={p.paymentId}>
            {p.method.toUpperCase()} pendente na venda #{p.saleNumber ?? '?'} — {formatCents(p.amountCents)}
          </li>
        ))}
        {/* GAP-PRD-045: o dinheiro desta está NA gaveta, e a venda não existe. */}
        {(pendencias.vendasOffline ?? []).map((v) => (
          <li key={v.id}>
            Venda guardada sem servidor e recusada — {formatCents(v.receivedCents)} na gaveta, sem venda
            {v.errorMessage ? ` (${v.errorMessage})` : ''}. Relance ou descarte em Regularizar.
          </li>
        ))}
        {/*
          Auditoria do PDV: a mercadoria voltou e o dinheiro do cliente ainda
          não saiu. Em espécie, esse dinheiro está NA gaveta e não é da loja.
        */}
        {devolucoes.map((d) => (
          <li key={d.id}>
            Devolução #{d.number} da venda #{d.saleNumber ?? '?'} — {formatCents(d.pendenteCents)} ainda
            não devolvidos ao cliente
            {d.reembolsadoCents > 0 ? ` (de ${formatCents(d.devolvivelCents)}, já voltaram ${formatCents(d.reembolsadoCents)})` : ''}
            . Registre o reembolso em Vendas › Devoluções.
          </li>
        ))}
      </ul>
      {/*
        O RODAPÉ NÃO PODE DESMENTIR A LINHA LOGO ACIMA DELE (P00-caixa-divida).

        O DEFEITO: ele afirmava, para toda a lista, "Cartão e PIX não estão na
        gaveta: a contagem continua sendo só do dinheiro" — verdade quando a
        lista era só de maquininha, mentira depois que entraram a venda
        guardada recusada (dinheiro NA gaveta, sem venda) e a devolução sem
        reembolso (dinheiro que a loja DEVE e que, em espécie, está na gaveta e
        vai para o turno seguinte como se fosse dela). A frase desmentia a
        linha que ela mesma explicava.

        Agora o rodapé é escolhido pelo que a lista CONTÉM — e, para a
        devolução, pelo que o servidor apurou sobre ONDE o dinheiro está.
      */}
      <span className="text-[var(--gs-text-soft)]">
        {naGavetaCents > 0 ? (
          <>
            {temEletronico ? 'Cartão e PIX não estão na gaveta: caem na conta. ' : ''}
            Atenção: {formatCents(naGavetaCents)} desta lista ESTÁ na contagem desta gaveta e não é
            da loja — o dinheiro da venda guardada e o reembolso de quem pagou em espécie nesta
            gaveta saem daí. Resolva em Vendas › Conferência de maquininha e em Vendas ›
            Devoluções; fechar agora não resolve nada disso, só registra que você fechou sabendo.
          </>
        ) : !seSabeOndeEsta ? (
          <>
            {temEletronico ? 'Cartão e PIX não estão na gaveta: caem na conta. ' : ''}
            Confira de onde sai cada reembolso antes de entregar o turno. Resolva em Vendas ›
            Conferência de maquininha e em Vendas › Devoluções; fechar agora não resolve nada
            disso, só registra que você fechou sabendo.
          </>
        ) : devolucoes.length > 0 ? (
          <>
            Nada desta lista está na contagem desta gaveta: o reembolso volta pelo meio da venda,
            ou o dinheiro entrou em gaveta de outro turno. Resolva em Vendas › Devoluções
            {temEletronico ? ' e em Vendas › Conferência de maquininha' : ''}; fechar agora não
            resolve nada disso, só registra que você fechou sabendo.
          </>
        ) : (
          <>
            Cartão e PIX não estão na gaveta: a contagem continua sendo só do dinheiro. Estas
            pendências são do gerente, em Vendas › Conferência de maquininha e em Vendas ›
            Devoluções — fechar agora não as resolve, só registra que você fechou sabendo delas.
          </>
        )}
      </span>
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          checked={ciente}
          onChange={(e) => onCiente(e.target.checked)}
          aria-label="Estou ciente das pendências eletrônicas deste turno"
          id={`${idBase}-ciente`}
        />
        Estou ciente e vou fechar o turno com estas pendências
      </label>
      {ciente && (
        <label className="flex flex-col gap-1">
          <span className="font-semibold">Por quê</span>
          <input
            aria-label="Motivo para fechar com pendências"
            value={motivo}
            onChange={(e) => onMotivo(e.target.value)}
            placeholder='Ex.: "o gerente confere o extrato amanhã cedo"'
            className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
          />
        </label>
      )}
    </div>
  );
}
