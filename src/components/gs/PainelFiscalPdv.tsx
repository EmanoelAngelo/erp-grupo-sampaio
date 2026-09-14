/**
 * Painel fiscal do PDV.
 *
 * O caixa precisa saber, sem sair do balcão, o que aconteceu com a nota da
 * venda que acabou de fechar. Não precisa aprender a máquina de estados: cada
 * situação vira uma frase e uma cor.
 *
 * O PAINEL É COMPACTO DE PROPÓSITO. O PDV continua sendo tela de operação —
 * o próximo cliente já está na fila. Ocupar a tela com o fiscal atrasaria o
 * atendimento por causa de algo que, na maioria das vezes, se resolve sozinho.
 *
 * O POLL PARA SOZINHO. Estado terminal encerra o temporizador, e a saída do
 * componente também. Um poll que sobrevive à venda vira vazamento: dez vendas
 * na hora do almoço deixariam dez timers batendo no servidor para sempre.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from '@/components/gs/ui';
import { ApiRequestError, apiDocument } from '@/lib/api/client';
import { coreApi, type FiscalSaleStatus, type SaleEmissionReadiness } from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';
import type { DisparoDaNfce } from '@/lib/api/emissaoNoFinalizar';

/** De quanto em quanto tempo perguntar enquanto não há desfecho. */
const POLL_MS = 3_000;

/**
 * Quantas voltas esperar por um documento que ainda não existe.
 *
 * ~1 minuto. Depois disso, a venda provavelmente não terá nota, e continuar
 * perguntando seria bater no servidor à toa por todo o expediente.
 */
const MAX_SEM_DOCUMENTO = 20;

/**
 * Cada situação em uma frase.
 *
 * `SENDING` merece atenção porque é o estado em que a resposta pode se perder
 * — e é dali que sai o "resposta não confirmada".
 */
const TOM: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  AUTHORIZED: 'success',
  REJECTED: 'danger',
  ERROR: 'danger',
  CANCELLED: 'danger',
  SENDING: 'warning',
  QUEUED: 'warning',
  CONTINGENCY: 'warning',
  DRAFT: 'neutral',
  VALIDATED: 'neutral',
  SIGNED: 'info',
};

const dataHora = dataHoraBR;

/** Chave em blocos de 4 — é assim que alguém consegue ler em voz alta. */
function chaveLegivel(chave: string | null): string {
  return chave ? chave.replace(/(\d{4})(?=\d)/g, '$1 ') : '—';
}

/**
 * Abre o DANFCE numa aba, BUSCANDO com o token antes.
 *
 * ## Aqui havia uma URL montada à mão, e ela não funcionava
 *
 * O que existia era `urlDanfce()`, devolvendo o endereço da rota, e dois
 * botões fazendo `window.open` nele. Janela aberta assim NÃO manda cabeçalho
 * nenhum — e `authMiddleware` lê o token só de `Authorization`. A rota
 * `/core/fiscal/documents/:id/danfce` é guardada, então o que abria era a
 * resposta 401 em JSON, no lugar do cupom.
 *
 * É o mesmo defeito que a impressão do PDV tinha, na mesma tela, por dois
 * caminhos diferentes. Consertar um e deixar o outro seria consertar metade.
 *
 * A fábrica de URL foi APAGADA junto, em vez de ficar sem chamador: função que
 * monta endereço de rota autenticada é um convite para o próximo `window.open`.
 */
/*
  A JANELA ABRE DENTRO DO CLIQUE, E A FALHA APARECE (F-cupom-fiscal-16).

  Era `await apiDocument(...)` e SÓ DEPOIS `window.open(url, '_blank',
  'noopener')`. Dois defeitos juntos: janela aberta depois de um `await` pode
  ser barrada como pop-up (a ativação do clique já expirou numa rede lenta), e
  com 'noopener' o retorno é SEMPRE nulo — não havia como saber que foi barrada.
  E os chamadores faziam `void abrirDanfce(...)`: erro de rede, 401 ou 500 viravam
  rejeição sem dono, e o botão simplesmente não fazia nada. O caixa clicava de
  novo, e de novo, com o cliente esperando.

  Agora a aba vazia nasce no próprio clique (é o gesto do usuário que a
  autoriza), o documento é buscado, e a aba é levada até ele. Barrada, a
  mensagem diz o que fazer; falhou a busca, a aba vazia fecha e o motivo do
  servidor aparece no painel.
*/
/*
  O DANFCE REABERTO DIZ DE QUAL CAIXA É O COMPUTADOR (PED-pdv-08).

  O DEFEITO: a rota do DANFCE escolhe a largura da bobina pela impressora de
  cupom do caixa (`?terminalId=`), e esta função não mandava caixa nenhum. Sem
  ele, a rota usa o token de dispositivo ou o caixa DA VENDA: no computador do
  caixa 2, com a térmica de 58 mm, o DANFCE de uma venda feita no caixa 1 (80
  mm) — ou reaberto por uma sessão de senha — saía na largura da outra bobina,
  cortado. Agora o caixa deste computador vai junto, e combina com a prévia.
*/
function caminhoDoDanfce(documentId: string, preview: boolean, terminalId: string | null): string {
  const params = new URLSearchParams();
  if (terminalId) params.set('terminalId', terminalId);
  if (preview) params.set('preview', '1');
  const qs = params.toString();
  return `/core/fiscal/documents/${documentId}/danfce${qs ? `?${qs}` : ''}`;
}

async function abrirDanfce(documentId: string, preview: boolean, terminalId: string | null): Promise<void> {
  const janela = window.open('', '_blank');
  if (!janela) {
    throw new Error('O navegador bloqueou a janela do DANFCE. Libere pop-ups para este endereço e clique de novo.');
  }
  try {
    const { content } = await apiDocument(caminhoDoDanfce(documentId, preview, terminalId));
    const url = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
    // A aba nova não precisa (nem deve) alcançar o PDV que a abriu.
    janela.opener = null;
    janela.location.href = url;
    // A aba já leu o blob; segurar a URL só vazaria memória.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    janela.close();
    throw err;
  }
}

/** A frase de uma falha ao abrir o DANFCE, para o painel. */
function motivoDaFalhaDoDanfce(err: unknown): string {
  if (err instanceof ApiRequestError) return `Não foi possível abrir o DANFCE: ${err.message}`;
  if (err instanceof Error && err.message) return err.message;
  return 'Não foi possível abrir o DANFCE. Tente de novo.';
}

export function PainelFiscalPdv({
  saleId,
  onDispensar,
  onImprimir,
  disparo = null,
  terminalId = null,
}: {
  saleId: string;
  /**
   * O caixa deste computador (PED-pdv-08): o DANFCE reaberto sai na largura
   * da bobina DELE. Nulo deixa a rota decidir (token de dispositivo, ou o
   * caixa da venda).
   */
  terminalId?: string | null;
  onDispensar: () => void;
  /**
   * Reimpressão — não refaz a venda nem o documento fiscal.
   *
   * O TIPO DO PAPEL VAI JUNTO (F-cupom-fiscal-03). Era `onImprimir()` sem
   * argumento, e o PDV imprimia sempre o comprovante NÃO fiscal: o "Imprimir"
   * ao lado de "Ver DANFCE" e de "DANFCE de contingência" entregava ao cliente
   * que pediu a nota o papel que não é nota. Quem sabe qual papel vale é o
   * painel, que está vendo o estado do documento.
   */
  onImprimir: (tipo: 'DANFCE' | 'SALE_RECEIPT', id: string) => void;
  /**
   * O que o Finalizar fez com a NFC-e (GAP-PRD-163). No modo automático a
   * nota pode já estar a caminho — e o painel diz isso, em vez de oferecer o
   * botão como se nada tivesse acontecido.
   */
  disparo?: DisparoDaNfce | null;
}) {
  const [status, setStatus] = useState<FiscalSaleStatus | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Avisa o laço para não reagendar. Preenchido pelo efeito do poll. */
  const pararRef = useRef<(() => void) | null>(null);
  /** Voltas seguidas sem documento, para o poll não insistir para sempre. */
  const semDocumento = useRef(0);
  /** O que falta para emitir ESTA venda. Nulo enquanto não se sabe. */
  const [prontidao, setProntidao] = useState<SaleEmissionReadiness | null>(null);
  const [emitindo, setEmitindo] = useState(false);
  /**
   * Religa o poll depois de emitir.
   *
   * Quando o painel abre numa venda sem nota, o laço desiste após algumas voltas
   * — e desistir está certo, porque a maioria das vendas nunca terá nota. Mas aí
   * o caixa clica em emitir e o laço já parou: o painel ficaria preso no primeiro
   * estado, dizendo "atualizando…" sem nunca atualizar. Mudar este contador
   * reexecuta o efeito, que recomeça do zero.
   */
  const [retomadas, setRetomadas] = useState(0);

  const parar = useCallback(() => {
    pararRef.current?.();
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /**
   * O que falta para emitir ESTA venda, perguntado uma vez.
   *
   * Não entra no poll: certificado, configuração e os itens da venda não mudam
   * enquanto o painel está aberto, e perguntar a cada três segundos seria bater
   * no servidor por um dado que não se move.
   */
  useEffect(() => {
    let ativo = true;
    void (async () => {
      try {
        const r = await coreApi.getEmissionReadinessForSale(saleId);
        if (ativo) setProntidao(r);
      } catch {
        // Sem saber a prontidão, o painel não oferece emissão — é o lado
        // seguro: melhor não oferecer do que oferecer e falhar no balcão.
      }
    })();
    return () => {
      ativo = false;
    };
  }, [saleId]);

  const emitir = useCallback(async () => {
    setEmitindo(true);
    setErro(null);
    try {
      await coreApi.emitNfceForSale(saleId);
      // O poll assume daqui: quem diz o desfecho é a SEFAZ, não este clique.
      // A autorização pode demorar, então o laço precisa estar rodando de novo.
      semDocumento.current = 0;
      setRetomadas((n) => n + 1);
    } catch (err) {
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível emitir agora.',
      );
    } finally {
      setEmitindo(false);
    }
  }, [saleId]);

  const consultar = useCallback(async () => {
    try {
      const s = await coreApi.getFiscalStatusForSale(saleId);
      setStatus(s);
      setErro(null);

      // Desfecho alcançado: não há mais nada a perguntar. A NFC-e off-line
      // (GAP-PRD-098) também para o poll: o cupom de contingência já vale, e a
      // autorização vem horas depois, pelo trabalhador da fila.
      if (s?.terminal || s?.contingencia?.pendente) {
        parar();
        return;
      }
      /*
        ERRO SEM NOVA TENTATIVA TAMBÉM É DESFECHO (F-cupom-fiscal-01).

        `ERROR` não é terminal no pipeline — ERROR → QUEUED é caminho legal de
        nova tentativa, e marcá-lo terminal no sistema inteiro esconderia uma
        recuperação. Mas ERROR com a fila MORTA (ou sem fila) não anda mais
        sozinho, e o painel perguntava a cada 3 s pelo resto do expediente.
      */
      if (s?.document?.status === 'ERROR' && (!s.queue || s.queue.status === 'dead')) {
        parar();
        return;
      }
      // Sem documento AINDA. Parar aqui faria o painel nunca perceber uma nota
      // emitida segundos depois — mas insistir para sempre numa venda que nunca
      // terá nota é desperdício. Daí o limite.
      if (!s) {
        semDocumento.current += 1;
        if (semDocumento.current >= MAX_SEM_DOCUMENTO) parar();
        return;
      }
      semDocumento.current = 0;
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao consultar a NFC-e.');
      parar();
    }
  }, [saleId, parar]);

  useEffect(() => {
    let vivo = true;
    // `parar()` zera esta bandeira ao alcançar o desfecho; é ela que decide se
    // vale reagendar.
    let continuar = true;

    const marcarParado = () => {
      continuar = false;
    };
    pararRef.current = marcarParado;

    const ciclo = async () => {
      if (!vivo) return;
      await consultar();
      // `setTimeout` encadeado, e não `setInterval`: uma resposta lenta não
      // empilha chamadas, e o agendamento só acontece depois da anterior
      // terminar.
      if (vivo && continuar) {
        timer.current = setTimeout(() => void ciclo(), POLL_MS);
      }
    };

    void ciclo();

    return () => {
      vivo = false;
      pararRef.current = null;
      parar();
    };
    // `retomadas` está aqui de propósito: mudá-lo é o que religa o laço.
  }, [consultar, parar, retomadas]);

  /*
    Venda sem nota: não é erro, é o caso de quem ainda não emitiu.

    E "sem documento" tem duas formas: resposta ausente e resposta SEM o
    documento dentro. A segunda caía adiante, em `status.document.status`, e
    derrubava a árvore inteira do PDV — logo depois de fechar uma venda, que é o
    pior momento possível. A barreira global do `App` pega a queda, então não é
    tela branca literal: é a página de erro do sistema com um botão que
    recarrega. Para quem está no balcão dá no mesmo, e o carrinho seguinte já
    montado se perde.
  */
  if (!status?.document) {
    return (
      <div
        role="status"
        className="px-6 py-2 bg-[var(--gs-purple-100)] text-[var(--gs-purple-800)]
          text-[length:var(--gs-text-sm)] flex items-center justify-between gap-4"
      >
        <span>
          {erro
            ?? (disparo?.disparada
              ? 'NFC-e sendo emitida automaticamente para esta venda — acompanhando a SEFAZ.'
              : 'Comprovante da última venda disponível. Nenhuma NFC-e emitida para ela.')}
          {/*
            O MODO AUTOMÁTICO QUE NÃO SAIU (GAP-PRD-163): a venda não estava
            pronta. O motivo vem do servidor, a mesma régua do botão abaixo.
          */}
          {disparo?.modo === 'AUTOMATICA' && !disparo.disparada && (
            <span className="block text-[length:var(--gs-text-xs)] mt-1">
              A emissão automática não saiu para esta venda
              {disparo.motivos[0] ? `: ${disparo.motivos[0]}` : ''}.
            </span>
          )}
          {/*
            O QUE FALTA PARA EMITIR, escrito.

            O pipeline fiscal inteiro existe e nunca era acionado por tela
            nenhuma: a venda saía sempre sem nota, e o painel só sabia dizer que
            não havia documento. Faltava o gatilho — e faltava dizer POR QUE,
            quando não dá.

            Sem certificado a emissão não passa. Oferecer o botão assim mesmo
            faria o caixa clicar, esperar e receber erro no meio do atendimento;
            então o que aparece é o motivo, e o botão fica para quando houver.
          */}
          {prontidao && !prontidao.canEmit && !prontidao.alreadyEmitted && (
            <span className="block text-[length:var(--gs-text-xs)] mt-1">
              {/* `reasons` é um array no contrato e pode chegar ausente de um
                  servidor mais antigo ou de um proxy que enxugou o corpo. Ler
                  `[0]` de `undefined` derruba o PDV inteiro por causa de uma
                  frase explicativa. */}
              Emissão indisponível: {prontidao.reasons?.[0] ?? 'configuração fiscal pendente'}.
            </span>
          )}
        </span>
        <span className="flex gap-3 shrink-0">
          {prontidao?.canEmit && !disparo?.disparada && (
            <button
              type="button"
              onClick={() => void emitir()}
              disabled={emitindo}
              className="font-semibold underline"
            >
              {emitindo ? 'emitindo…' : 'emitir NFC-e'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onImprimir('SALE_RECEIPT', saleId)}
            className="font-semibold underline"
          >
            imprimir comprovante
          </button>
          <button type="button" onClick={onDispensar} className="font-semibold underline">
            dispensar
          </button>
        </span>
      </div>
    );
  }

  const doc = status.document;
  const autorizada = doc.status === 'AUTHORIZED';
  const rejeitada = doc.status === 'REJECTED';
  // Emitida em contingência off-line e ainda sem autorização (GAP-PRD-098).
  const offline = Boolean(status.contingencia?.pendente);
  // Enviando e sem desfecho é exatamente o caso de resposta que pode ter se
  // perdido. O operador precisa ler isso, não "enviando" para sempre.
  const naoConfirmada = doc.status === 'SENDING' || (doc.status === 'QUEUED' && (status.queue?.attempts ?? 0) > 0);

  const frase = naoConfirmada && doc.status === 'SENDING'
    ? 'Resposta da SEFAZ não confirmada'
    : status.statusLabel;

  return (
    <div className="px-6 py-3 bg-[var(--gs-surface)] border-y border-[var(--gs-border)]">
      {/* A tarja de teste é a primeira coisa, e é grande. Um selo pequeno
          deixaria alguém entregar cupom de teste achando que vale. */}
      {/* CONTINGÊNCIA OFF-LINE (GAP-PRD-098): a instrução ao caixa é a
          primeira coisa — entregar o DANFCE de contingência, e a nota segue
          sozinha para a SEFAZ quando ela voltar. */}
      {offline && (
        <div
          role="status"
          className="mb-2 px-3 py-2 rounded-[var(--gs-radius)] border-2 border-[var(--gs-warning)]
            bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-center"
        >
          <strong className="block text-[length:var(--gs-text-base)]">EMITIDA EM CONTINGÊNCIA</strong>
          <span className="text-[length:var(--gs-text-sm)]">
            Entregue ao cliente o DANFCE de contingência. A nota será transmitida sozinha quando a
            SEFAZ voltar
            {status.contingencia?.prazoDeTransmissao
              ? ` (prazo: ${dataHora(status.contingencia.prazoDeTransmissao)})`
              : ''}
            .
          </span>
        </div>
      )}

      {status.isTest && (
        <div
          className="mb-2 px-3 py-2 rounded-[var(--gs-radius)] border-2 border-[var(--gs-warning)]
            bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-center"
        >
          <strong className="block text-[length:var(--gs-text-base)]">AMBIENTE DE TESTE</strong>
          <span className="text-[length:var(--gs-text-sm)]">
            NÃO É DOCUMENTO FISCAL HOMOLOGADO — este cupom não vale para o fisco.
          </span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[var(--gs-purple-900)]">NFC-e</span>
            <Badge tone={naoConfirmada ? 'warning' : (TOM[doc.status] ?? 'neutral')}>{frase}</Badge>
            {!status.terminal && (
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">atualizando…</span>
            )}
          </div>

          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Série {doc.serie} · Número {doc.number} ·{' '}
            {doc.environment === 'production' ? 'Produção' : 'Homologação'}
          </span>

          {rejeitada && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {doc.cStat ? `cStat ${doc.cStat} — ` : ''}
              {doc.xMotivo ?? 'Sem motivo informado.'}
            </span>
          )}

          {naoConfirmada && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              O sistema vai consultar a SEFAZ antes de qualquer reenvio. Não emita de novo.
              {/* A fila anda sozinha (GAP-PRD-020): o caixa lê QUANDO, e não
                  "aguardando" sem fim. */}
              {status.queue?.status === 'retry' && status.queue.nextAttemptAt && (
                <> Nova tentativa automática às {dataHora(status.queue.nextAttemptAt)}.</>
              )}
            </span>
          )}

          {autorizada && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Protocolo {doc.protocol} · {dataHora(doc.authorizedAt)}
            </span>
          )}

          {erro && (
            <span role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {erro}
            </span>
          )}
        </div>

        <div className="flex gap-2 flex-wrap shrink-0">
          {/*
            O PAPEL DE CADA ESTADO (F-cupom-fiscal-03).

            Autorizada e contingência: o papel é o DANFCE — o de contingência é
            obrigatório na emissão off-line. Os outros estados com documento
            (na fila, enviando, recusada, com erro) não tinham botão de papel
            NENHUM: o cliente esperando o cupom ficava sem o comprovante.
          */}
          {autorizada && (
            <>
              <Button
                size="sm"
                onClick={() => {
                  setErro(null);
                  abrirDanfce(doc.id, false, terminalId).catch((err) => setErro(motivoDaFalhaDoDanfce(err)));
                }}
              >
                Ver DANFCE
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onImprimir('DANFCE', doc.id)}>
                Imprimir DANFCE
              </Button>
            </>
          )}
          {rejeitada && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setErro(null);
                abrirDanfce(doc.id, true, terminalId).catch((err) => setErro(motivoDaFalhaDoDanfce(err)));
              }}
            >
              Ver documento recusado
            </Button>
          )}
          {offline && (
            <>
              <Button
                size="sm"
                onClick={() => {
                  setErro(null);
                  abrirDanfce(doc.id, false, terminalId).catch((err) => setErro(motivoDaFalhaDoDanfce(err)));
                }}
              >
                DANFCE de contingência
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onImprimir('DANFCE', doc.id)}>
                Imprimir DANFCE
              </Button>
            </>
          )}
          {!autorizada && !offline && (
            <Button size="sm" variant="ghost" onClick={() => onImprimir('SALE_RECEIPT', saleId)}>
              Imprimir comprovante
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAberto((v) => !v)}>
            {aberto ? 'Ocultar' : 'Detalhes'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDispensar}>
            Dispensar
          </Button>
        </div>
      </div>

      {aberto && (
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3 pt-3 border-t border-[var(--gs-border)] m-0">
          <Info rotulo="Chave de acesso" valor={chaveLegivel(doc.accessKey)} />
          <Info rotulo="Protocolo" valor={doc.protocol ?? '—'} />
          <Info rotulo="Situação" valor={doc.status} />
          <Info rotulo="cStat" valor={doc.cStat ?? '—'} />
          <Info rotulo="Tentativas" valor={String(status.queue?.attempts ?? 0)} />
          <Info rotulo="Próxima tentativa" valor={dataHora(status.queue?.nextAttemptAt)} />
        </dl>
      )}
    </div>
  );
}

function Info({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{rotulo}</dt>
      <dd className="m-0 text-[length:var(--gs-text-sm)] break-all">{valor}</dd>
    </div>
  );
}
