/**
 * AS GAVETAS ABERTAS DA OPERAÇÃO — e a esquecida de outro dia (GAP-PRD-131).
 *
 * O banco operacional tinha duas gavetas abertas havia semanas (a Gringa desde
 * 12/08, a Preço Justo desde 26/08) e nenhuma tela as apontava: o Painel não
 * falava de caixa, e a tela de Caixa só mostrava a data de abertura de UMA
 * gaveta, sem alerta. A primeira venda de setembro cairia no turno de agosto.
 *
 * Duas peças, a mesma fonte (`GET /core/cash/drawers`):
 *
 * - `GavetasAbertasCard` (tela de Caixa): todas as gavetas abertas, uma por
 *   caixa, com esperado, quem abriu, desde quando — e o FECHAMENTO ali mesmo,
 *   com a contagem. É a "opção de fechamento pelo gestor" da ficha: a gaveta
 *   do Caixa 2 esquecida aberta não depende de alguém ir ao computador dele.
 * - `AvisoCaixasEsquecidos` (Painel): só aparece quando há gaveta de outro
 *   dia, e leva à tela de Caixa. Falha na consulta não vira aviso nenhum — o
 *   Painel é de outra coisa, e um erro de caixa nele seria ruído.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Input } from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError, getSession } from '@/lib/api/client';
import { coreApi, type PendenciasEletronicas } from '@/lib/api/core';
import { subscribeQueue, type QueuedRequest } from '@/lib/api/offlineQueue';
import { useSession } from '@/hooks/useSession';
import { PendenciasDoFechamento } from '@/components/gs/PendenciasDoFechamento';
import { ImprimirFechamento } from '@/components/gs/CaixaDoComputador';
import { cienciaCompleta, pendenciasDoErro } from '@/lib/pendenciasDoFechamento';
import { dataHoraBR } from '@/lib/datas';
import { caixaDesteComputador, diaBr, fraseDaGavetaDeOutroDia, terminaisApi, type GavetaAberta } from '@/lib/api/terminais';

/** O nome da gaveta nas frases da tela. */
const nomeDaGaveta = (g: GavetaAberta): string => g.terminalName ?? 'Gaveta única';

export function GavetasAbertasCard({
  recarregarEm = 0,
  onFechou,
  semAGaveta = null,
}: {
  /** Muda quando a tela abriu/fechou outra gaveta — relê a lista. */
  recarregarEm?: number;
  onFechou?: () => void;
  /**
   * A gaveta que a tela JÁ fecha no próprio card — a do turno corrente, na tela
   * de Caixa. Ela sai desta lista (H-caixa-seguranca-M02, a metade que faltou):
   * a mesma gaveta com dois botões de fechar é convite a fechar pelo caminho
   * que confere menos, e a conta dela já está na tela logo acima.
   */
  semAGaveta?: string | null;
}) {
  const [gavetas, setGavetas] = useState<GavetaAberta[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [contagem, setContagem] = useState<Record<string, string>>({});
  const [fechando, setFechando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<string | null>(null);
  /*
    A GAVETA QUE ACABOU DE FECHAR, PARA O PAPEL (H-caixa-seguranca-11).

    O gestor que fecha aqui a gaveta esquecida do Caixa 2 também precisa do
    papel do fechamento para assinar — e a gaveta some da lista no mesmo
    instante. O id e o caixa ficam guardados antes disso.
  */
  const [paraImprimir, setParaImprimir] = useState<{ sessionId: string; terminalId: string | null } | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setGavetas((await terminaisApi.gavetasAbertas()).items ?? []);
    } catch (err) {
      setGavetas(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível listar as gavetas abertas.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar, recarregarEm]);

  /**
   * As pendências eletrônicas que o servidor apontou ao tentar fechar, por
   * gaveta, e a ciência de quem fecha (GAP-PRD-081). Só existem depois da
   * recusa: a lista vem do servidor, nunca de uma conta feita aqui.
   */
  const [pendencias, setPendencias] = useState<
    Record<string, { p: PendenciasEletronicas; ciente: boolean; motivo: string }>
  >({});

  /*
    AS GUARDAS DO FECHAMENTO — as mesmas do diálogo do PDV e do card "Caixa
    aberto" (H-caixa-seguranca-M02, a metade que faltou).

    O DEFEITO: "Fechar esta gaveta" chamava `closeCash` direto, e a tela de
    Caixa desenha este card junto do card principal — com a gaveta do turno
    corrente nas duas listas. Por aqui, a mesma gaveta fechava:
      (b) contra o "esperado na gaveta" do momento em que a lista carregou —
          com a página aberta desde as 14h, as vendas das 14h às 18h não
          entravam no número que o gestor via;
      sem pergunta nenhuma: um clique gravava a contagem, e desfazer só pela
          reabertura, com alçada;
      (c) duas vezes no clique duplo — a trava era só o estado `fechando`, que
          o React ainda não redesenhou quando o segundo clique chega: o
          segundo voltava 409 e a faixa trocava o "fechada" por "Caixa já
          fechado.";
      (d) com venda offline dela ainda na fila deste computador — o servidor
          recusava a venda no reenvio, com o dinheiro dela já contado.

    Agora "Fechar esta gaveta" RELÊ a lista no servidor e pergunta "Contado X
    contra o esperado Y" com o número de agora; só "Confirmar fechamento"
    envia. O ref barra o segundo clique; a fila trava a gaveta como no PDV.
  */
  const ocupadoRef = useRef(false);
  const [confirmando, setConfirmando] = useState<{ sessionId: string; esperadoCents: number } | null>(null);

  /*
    A VENDA GUARDADA NESTE COMPUTADOR QUE AINDA NÃO SUBIU (item d).

    A regra é a do diálogo de caixa do PDV (G-offline-sync-12), escrita igual:
    trava a venda desta operação (ou a antiga, sem escopo gravado) que sobe
    NESTA gaveta — ou em gaveta nenhuma, que o servidor resolve no reenvio e
    pode cair em qualquer uma delas. A de outra operação não trava.
  */
  const empresa = useSession()?.company.id ?? null;
  const [fila, setFila] = useState<QueuedRequest[]>([]);
  useEffect(() => subscribeQueue(setFila), []);
  const vendasNaFilaDa = (g: GavetaAberta): number =>
    fila.filter((q) => {
      const empresaDaVenda = q.escopo?.companyId ?? null;
      const gaveta = (q.body as { cashSessionId?: string | null } | null)?.cashSessionId ?? null;
      const daOperacao = !empresaDaVenda || !empresa || empresaDaVenda === empresa;
      return daOperacao && (gaveta === null || gaveta === g.sessionId);
    }).length;

  /** Esperado que o servidor não disse não vira R$ 0,00 na tela (item a). */
  const temEsperado = (g: GavetaAberta): boolean =>
    typeof g.expectedCents === 'number' && Number.isFinite(g.expectedCents);

  const pedirFechamento = async (g: GavetaAberta) => {
    if (ocupadoRef.current) return;
    const contado = parseReaisToCents(contagem[g.sessionId] ?? '');
    if (contado === null || vendasNaFilaDa(g) > 0) return;
    ocupadoRef.current = true;
    setFechando(g.sessionId);
    setErro(null);
    try {
      let agora: GavetaAberta[];
      try {
        agora = (await terminaisApi.gavetasAbertas()).items ?? [];
      } catch {
        // A lista de antes FICA na tela: a falha é da releitura, não das gavetas.
        setErro(
          `Não foi possível reler o esperado de ${nomeDaGaveta(g)}, e sem ele não dá para conferir a contagem. `
            + 'Tente de novo em instantes.',
        );
        return;
      }
      setGavetas(agora);
      const relida = agora.find((x) => x.sessionId === g.sessionId);
      if (!relida) {
        setErro(`${nomeDaGaveta(g)} já foi fechada — por outra tela ou outro computador. A lista foi atualizada.`);
        onFechou?.();
        return;
      }
      if (!temEsperado(relida)) {
        setErro(
          `O servidor não devolveu o esperado de ${nomeDaGaveta(g)}, e sem ele não dá para conferir a contagem. `
            + 'Tente de novo em instantes.',
        );
        return;
      }
      setConfirmando({ sessionId: g.sessionId, esperadoCents: relida.expectedCents });
    } finally {
      ocupadoRef.current = false;
      setFechando(null);
    }
  };

  const fechar = async (g: GavetaAberta) => {
    if (ocupadoRef.current) return;
    const contado = parseReaisToCents(contagem[g.sessionId] ?? '');
    if (contado === null) return;
    // Só fecha o que foi PERGUNTADO — e as travas conferidas de novo no envio:
    // a fila pode ter mudado com a pergunta já na tela.
    if (confirmando?.sessionId !== g.sessionId || vendasNaFilaDa(g) > 0) return;
    const pend = pendencias[g.sessionId];
    if (pend && !cienciaCompleta(pend.ciente, pend.motivo)) return;
    ocupadoRef.current = true;
    setFechando(g.sessionId);
    setErro(null);
    try {
      const fechada = await coreApi.closeCash(
        g.sessionId,
        contado,
        undefined,
        pend ? { ciente: pend.ciente, motivo: pend.motivo } : undefined,
      );
      setConfirmando(null);
      /*
        O papel sai NESTE computador, e não no caixa da gaveta: esta lista existe
        para o gestor fechar a gaveta esquecida do Caixa 2 SEM ir até ela
        (GAP-PRD-131) — mandar o papel para a impressora de lá o deixaria sem o
        que assinar. Computador sem caixa registrado imprime pelo navegador.
      */
      setParaImprimir({ sessionId: g.sessionId, terminalId: caixaDesteComputador(getSession()?.company.id) ?? null });
      setResultado(
        `${nomeDaGaveta(g)} fechada. Esperado ${formatCents(fechada.expected_cents ?? 0)}, `
          + `contado ${formatCents(fechada.counted_cents ?? 0)}, diferença ${formatCents(fechada.difference_cents ?? 0)}.`
          + (pend ? ' Fechada com pendência eletrônica declarada — ela continua na Conferência de maquininha.' : ''),
      );
      setContagem((c) => ({ ...c, [g.sessionId]: '' }));
      setPendencias((atual) => {
        const resto = { ...atual };
        delete resto[g.sessionId];
        return resto;
      });
      await carregar();
      onFechou?.();
    } catch (err) {
      /*
        OUTRO COMPUTADOR FECHOU ENTRE A PERGUNTA E O CONFIRMAR (revisão do
        H-caixa-seguranca-M02). Só "Fechar esta gaveta" sabia disso; aqui o 409
        virava "Caixa já fechado." com a gaveta ainda na lista, sem releitura —
        o gestor ficava olhando uma gaveta que não existe mais.
      */
      if (err instanceof ApiRequestError && (err.code === 'CORE_CASH_CLOSED' || err.code === 'CORE_CASH_NOT_FOUND')) {
        setConfirmando(null);
        setPendencias((atual) => {
          const resto = { ...atual };
          delete resto[g.sessionId];
          return resto;
        });
        // A releitura vem ANTES da frase: `carregar` zera o erro quando lê bem.
        await carregar();
        setErro(`${nomeDaGaveta(g)} já foi fechada — por outra tela ou outro computador. A lista foi atualizada.`);
        onFechou?.();
        return;
      }
      const p = pendenciasDoErro(err);
      if (p) {
        // A recusa por pendência eletrônica pede ciência e motivo: a pergunta
        // FICA, com "Confirmar fechamento" travado até os dois virem.
        setPendencias((atual) => ({
          ...atual,
          [g.sessionId]: { p, ciente: atual[g.sessionId]?.ciente ?? false, motivo: atual[g.sessionId]?.motivo ?? '' },
        }));
      } else {
        // Qualquer outra recusa desfaz a pergunta; a faixa diz o porquê.
        setConfirmando(null);
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível fechar a gaveta.');
    } finally {
      ocupadoRef.current = false;
      setFechando(null);
    }
  };

  const visiveis = (gavetas ?? []).filter((g) => g.sessionId !== semAGaveta);

  return (
    <Card
      title="Gavetas abertas nesta operação"
      subtitle="Uma por caixa. A gaveta de outro dia precisa ser contada e fechada antes de vender hoje — senão as vendas de hoje entram na conferência daquele dia."
    >
      {resultado && (
        <p role="status" className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          {resultado}
        </p>
      )}
      {paraImprimir && (
        <div className="mb-3">
          <ImprimirFechamento
            key={paraImprimir.sessionId}
            sessionId={paraImprimir.sessionId}
            terminalId={paraImprimir.terminalId}
            onSeguir={() => setParaImprimir(null)}
          />
        </div>
      )}
      {erro && (
        <p role="alert" className="m-0 mb-3 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {gavetas === null ? (
        !erro && <p role="status" className="m-0 text-[var(--gs-muted)]">Carregando…</p>
      ) : visiveis.length === 0 ? (
        <p className="m-0 text-[var(--gs-muted)]">
          {gavetas.length > 0
            ? 'Nenhuma outra gaveta aberta — a deste caixa está no card acima.'
            : 'Nenhuma gaveta aberta.'}
        </p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-3" data-testid="gavetas-abertas">
          {visiveis.map((g) => {
            const contado = parseReaisToCents(contagem[g.sessionId] ?? '');
            const naFila = vendasNaFilaDa(g);
            const pend = pendencias[g.sessionId];
            const pendIncompleta = Boolean(pend && !cienciaCompleta(pend.ciente, pend.motivo));
            const perguntando = confirmando?.sessionId === g.sessionId && contado !== null;
            return (
              <li
                key={g.sessionId}
                className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] px-4 py-3 flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-center gap-2 justify-between">
                  <strong>{g.terminalName ?? 'Gaveta única (sem caixa)'}</strong>
                  {g.deOutroDia && (
                    <Badge tone="warning">
                      De outro dia — desde {diaBr(g.deOutroDia.abertaNoDia)} ({g.deOutroDia.dias} dia(s))
                    </Badge>
                  )}
                </div>
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                  Aberta{g.openedByName ? ` por ${g.openedByName}` : ''} em {dataHoraBR(g.openedAt)} · fundo{' '}
                  {formatCents(g.openingCents)} · esperado na gaveta{' '}
                  <strong data-testid={`gaveta-esperado-${g.sessionId}`}>
                    {temEsperado(g) ? formatCents(g.expectedCents) : 'não carregado'}
                  </strong>
                </span>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">Valor contado</span>
                    <Input
                      aria-label={`Valor contado — ${g.terminalName ?? 'gaveta única'}`}
                      value={contagem[g.sessionId] ?? ''}
                      onChange={(e) => {
                        setContagem((c) => ({ ...c, [g.sessionId]: e.target.value }));
                        // Número novo, pergunta nova — com o esperado relido de novo.
                        setConfirmando((atual) => (atual?.sessionId === g.sessionId ? null : atual));
                      }}
                      placeholder="0,00"
                      className="text-right w-40"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={fechando === g.sessionId && !perguntando}
                    disabled={
                      contado === null
                      || fechando !== null
                      || confirmando?.sessionId === g.sessionId
                      || naFila > 0
                      || pendIncompleta
                    }
                    onClick={() => void pedirFechamento(g)}
                  >
                    Fechar esta gaveta
                  </Button>
                </div>
                {naFila > 0 && (
                  <p
                    role="alert"
                    data-testid={`gaveta-fila-offline-${g.sessionId}`}
                    className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
                  >
                    {naFila} venda(s) guardada(s) neste computador ainda não subiram para o servidor. Envie pela
                    barra do topo antes de fechar: fechada a gaveta, o servidor recusa a venda que era dela.
                  </p>
                )}
                {perguntando && confirmando && (
                  <div
                    role="alertdialog"
                    aria-label={`Confirmar fechamento — ${nomeDaGaveta(g)}`}
                    data-testid={`gaveta-confirmar-${g.sessionId}`}
                    className="rounded-[var(--gs-radius)] border border-[var(--gs-danger)]
                      bg-[var(--gs-danger-bg)] px-4 py-3 flex flex-col gap-2"
                  >
                    <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                      Fechar a gaveta grava a contagem; desfazer só pela reabertura, com alçada.
                    </p>
                    <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
                      Contado <strong>{formatCents(contado)}</strong> contra o esperado{' '}
                      <strong>{formatCents(confirmando.esperadoCents)}</strong>
                      {contado !== confirmando.esperadoCents && (
                        <>
                          {' '}({contado > confirmando.esperadoCents ? 'sobra' : 'falta'}{' '}
                          {formatCents(Math.abs(contado - confirmando.esperadoCents))})
                        </>
                      )}
                      .
                    </p>
                    <div className="flex flex-wrap gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={fechando !== null}
                        onClick={() => setConfirmando(null)}
                      >
                        Voltar
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={fechando === g.sessionId}
                        disabled={naFila > 0 || pendIncompleta}
                        onClick={() => void fechar(g)}
                      >
                        Confirmar fechamento
                      </Button>
                    </div>
                  </div>
                )}
                {pend && (
                  <PendenciasDoFechamento
                    idBase={`gaveta-${g.sessionId}`}
                    pendencias={pend.p}
                    ciente={pend.ciente}
                    motivo={pend.motivo}
                    onCiente={(v) =>
                      setPendencias((atual) => ({ ...atual, [g.sessionId]: { ...atual[g.sessionId], ciente: v } }))
                    }
                    onMotivo={(v) =>
                      setPendencias((atual) => ({ ...atual, [g.sessionId]: { ...atual[g.sessionId], motivo: v } }))
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function AvisoCaixasEsquecidos() {
  const [esquecidas, setEsquecidas] = useState<GavetaAberta[]>([]);

  useEffect(() => {
    let vivo = true;
    terminaisApi
      .gavetasAbertas()
      .then((r) => {
        if (vivo) setEsquecidas((r.items ?? []).filter((g) => g.deOutroDia));
      })
      // Perfil sem acesso ao caixa, ou servidor fora: o Painel segue sem aviso.
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  if (esquecidas.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="caixas-esquecidos"
      className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)]
        bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] flex flex-col gap-1"
    >
      <strong>
        {esquecidas.length === 1
          ? 'Uma gaveta está aberta desde outro dia.'
          : `${esquecidas.length} gavetas estão abertas desde outro dia.`}
      </strong>
      <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
        {esquecidas.map((g) => (
          <li key={g.sessionId}>
            {g.terminalName ?? 'Gaveta única'}
            {g.openedByName ? ` (aberta por ${g.openedByName})` : ''}: {g.deOutroDia && fraseDaGavetaDeOutroDia(g.deOutroDia)}
          </li>
        ))}
      </ul>
      <Link to="/sistema/caixa" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)] underline">
        Ir para Vendas › Caixa e fechar
      </Link>
    </div>
  );
}
