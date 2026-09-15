/**
 * Estado da conexão e da fila de escrita.
 *
 * A tela precisa dizer TRÊS coisas diferentes, e confundi-las custa caro:
 *
 *   SEM REDE           este computador não tem rede.
 *   SERVIDOR FORA      a rede está de pé e o SERVIDOR DA LOJA não responde
 *                      (GAP-PRD-044). `navigator.onLine` continua `true` nesse
 *                      caso e o evento `online` nunca dispara: quem descobre é
 *                      a sonda em `/health`.
 *   PENDENTE DE ENVIO  há venda esperando para subir. Enquanto houver, o
 *                      faturamento do dia ainda não está inteiro no servidor.
 *
 * Nos dois primeiros, o que a loja consegue fazer é UMA coisa só: finalizar o
 * carrinho que já está na tela — ele entra na fila e sobe sozinho. Não há
 * catálogo neste computador: a busca de produto, o preço e o estoque vêm do
 * servidor, e voltam com ele (G-offline-sync-03). A barra dizia que "a venda
 * continua sendo registrada", e o operador bipava o cliente seguinte para ler
 * "Falha na busca." em todo item — a promessa era maior que a fila.
 *
 * ## O servidor fora aparece mesmo sem fila (G-offline-sync-04)
 *
 * A sonda só rodava dentro do envio da fila: com a fila vazia, o servidor caía
 * e nenhuma faixa dizia isso até a primeira venda ser guardada. Agora toda
 * requisição que não chega ao servidor avisa (`EVENTO_SERVIDOR_SEM_RESPOSTA`,
 * no cliente HTTP), a barra sonda na hora, e enquanto o servidor estiver fora
 * ela volta a perguntar a cada 15 s — até ele responder e a faixa sumir.
 *
 * ## A fila sobe SOZINHA (GAP-PRD-044)
 *
 * O reenvio dependia de o operador clicar em "Enviar agora" — ou do evento
 * `online`, que não acontece quando o que caiu foi o servidor. Agora, enquanto
 * houver fila, a barra tenta de novo sozinha: 5 s, 10 s, 20 s e daí a cada
 * 30 s, perguntando antes ao servidor se ele voltou. Vale também para o
 * navegador fechado e reaberto: a fila está no `localStorage`, e a primeira
 * tentativa sai poucos segundos depois de a tela abrir. A venda que estava NO
 * AR quando a tela recarregou volta para a fila com a mesma chave
 * (`recuperarEnviosInterrompidos`, G-offline-sync-06).
 *
 * ## A recusa não fica presa neste computador (GAP-PRD-045/046)
 *
 * Venda que o servidor RECUSA (o caixa daquele turno fechou, o estoque acabou)
 * não passa com nova tentativa, e o dinheiro já foi recebido. Ela é entregue
 * ao servidor como pendência — com o corpo original e a mesma chave — e sai
 * daqui: o gestor e os outros caixas a veem em "Regularizar", e ela não morre
 * com a máquina do caixa. Se a entrega falhar, a venda continua na fila com a
 * recusa escrita, e a próxima tentativa entrega de novo.
 *
 * ## O que a venda guardada virou (G-offline-sync-15)
 *
 * O reenvio descartava a resposta, e a barra dizia só "3 venda(s)
 * enviada(s)." O cliente que voltava pedindo a nota não tinha como ser
 * atendido: ninguém sabia se a venda das 15h20 virou a #1234 ou a #1235. Agora
 * a barra diz "a venda guardada das 15:20 (código …) virou a #1234", com o
 * botão de imprimir o comprovante — o código é o mesmo do comprovante offline.
 *
 * O componente NÃO some quando volta a conexão se ainda há fila: some quando a
 * fila esvazia. Sumir antes daria a impressão de que tudo subiu.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTO_SERVIDOR_SEM_RESPOSTA, apiRequest, getSession } from '@/lib/api/client';
import {
  classificarFalha,
  codigoDaVendaGuardada,
  esperaDaTentativa,
  flushQueue,
  queued,
  recuperarEnviosInterrompidos,
  subscribeQueue,
  vincularAoEscopo,
  type QueuedRequest,
} from '@/lib/api/offlineQueue';
import { caixaDesteComputador } from '@/lib/api/terminais';
import { sondarServidor, vendasOfflineApi, type EstadoDoServidor } from '@/lib/api/vendasOffline';
import { printDocument } from '@/lib/print';
import { formatCents } from './format';
import { RegularizarVendasOffline } from './RegularizarVendasOffline';

/**
 * A venda guardada é DESTA operação? (RES-SESSAO)
 *
 * O reenvio sai com a sessão de agora. A venda feita na loja não pode subir na
 * oficina só porque alguém trocou de operação antes de a fila esvaziar: ela
 * espera a pessoa voltar à loja. A pessoa não decide SE a venda sobe — a troca
 * de turno no mesmo caixa sempre subiu a venda do colega, na mesma operação —,
 * mas viaja junto com ela (`corpoDoReenvio`), para o servidor medir a alçada
 * de quem VENDEU e não a de quem está logado na hora do envio.
 */
function daOperacaoDeAgora(item: QueuedRequest): boolean {
  const agora = getSession()?.company.id ?? null;
  // Sem sessão, o envio nem sai: o 401 diz "entre de novo", como antes.
  if (!agora) return true;
  // Guardada antes de a fila saber a operação: sobe na de agora, como antes.
  if (!item.escopo?.companyId) return true;
  return item.escopo.companyId === agora;
}

/**
 * O corpo do reenvio: o da venda, mais QUEM a fez e QUANDO
 * (G-offline-sync-M03 / G-offline-sync-14).
 *
 * O reenvio sai com o token de quem está logado AGORA. Sem dizer quem vendeu,
 * o servidor media a alçada do desconto com a sessão do envio: o desconto de
 * 25% que o operador deu com o servidor fora passava sem liberação se o
 * gerente tivesse entrado no mesmo computador antes de a conexão voltar — e a
 * trilha atribuía os 25% ao gerente. `vendaGuardada` leva a pessoa e a hora da
 * venda; o servidor mede a alçada pela régua mais estreita das duas pessoas e
 * grava na trilha quem vendeu, quem enviou e quando a venda aconteceu.
 */
function corpoDoReenvio(item: QueuedRequest): unknown {
  if (item.path !== '/core/sales') return item.body;
  if (!item.body || typeof item.body !== 'object' || Array.isArray(item.body)) return item.body;
  return {
    ...(item.body as Record<string, unknown>),
    vendaGuardada: { userId: item.escopo?.userId ?? null, queuedAt: item.queuedAt },
  };
}

/** De quanto em quanto tempo a barra pergunta se há venda recusada esperando. */
const INTERVALO_DAS_RECUSADAS_MS = 120_000;
/** Com o servidor fora e a fila vazia, a sonda volta a perguntar neste ritmo. */
const INTERVALO_DA_SONDA_MS = 15_000;
/** De quanto em quanto tempo a venda que ficou no ar é procurada. */
const INTERVALO_DA_RECUPERACAO_MS = 15_000;

/*
  Um envio por vez NESTE navegador. O PDV e a casca podem montar a barra ao
  mesmo tempo numa troca de tela; dois envios da mesma fila ao mesmo tempo não
  duplicariam venda (a chave impede), mas duplicariam a entrega da recusa e o
  aviso na tela.
*/
let envioEmCurso = false;

/** A venda guardada que subiu, e o número que ela virou. */
interface VendaSubida {
  saleId: string;
  numero: number | null;
  feitaEm: string;
  codigo: string;
}

function horaCurta(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '--:--';
}

/** O que a venda guardada recebeu — a soma dos pagamentos do corpo. */
function recebidoDa(item: QueuedRequest): number {
  const pagamentos = (item.body as { payments?: unknown } | null)?.payments;
  if (!Array.isArray(pagamentos)) return 0;
  return pagamentos.reduce((s: number, p: { amountCents?: unknown }) => {
    const v = Number(p?.amountCents);
    return s + (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  }, 0);
}

/**
 * A fila em UMA frase (G-offline-sync-17).
 *
 * Era "8 operação(ões) aguardando envio: venda do PDV, venda do PDV, …" — uma
 * frase enorme e repetitiva, sem valor e sem hora. O que importa a quem está no
 * caixa é quantas, quanto dinheiro, e desde quando.
 */
function resumoDaFila(fila: QueuedRequest[]): string {
  const soma = fila.reduce((s, f) => s + recebidoDa(f), 0);
  const maisAntiga = [...fila].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
  const vendas = fila.length === 1 ? '1 venda guardada' : `${fila.length} vendas guardadas`;
  return (
    `${vendas} aguardando envio — ${formatCents(soma)} recebidos`
    + (fila.length === 1 ? `, feita às ${horaCurta(maisAntiga?.queuedAt)}.` : `; a mais antiga das ${horaCurta(maisAntiga?.queuedAt)}.`)
  );
}

export function EstadoConexao() {
  const [fila, setFila] = useState<QueuedRequest[]>([]);
  const [estado, setEstado] = useState<EstadoDoServidor>(
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'sem_rede' : 'ok',
  );
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [recusadas, setRecusadas] = useState(0);
  const [regularizando, setRegularizando] = useState(false);
  const [subidas, setSubidas] = useState<VendaSubida[]>([]);
  /**
   * Quantas vendas da fila a gerência já tinha descartado (G-offline-sync-16).
   * Fica na barra até o caixa dar ciência: com a fila vazia a barra some, e o
   * aviso comum sumiria junto — o caixa nunca saberia que a venda não existe.
   */
  const [descartadas, setDescartadas] = useState(0);
  /** Muda a cada tentativa, para o agendamento rodar de novo mesmo sem a fila mudar. */
  const [rodada, setRodada] = useState(0);
  const tentativasSemSucesso = useRef(0);
  const sondando = useRef(false);
  const estadoAtual = useRef(estado);
  estadoAtual.current = estado;

  useEffect(() => subscribeQueue(setFila), []);

  const contarRecusadas = useCallback(async () => {
    try {
      setRecusadas((await vendasOfflineApi.listar('pendente')).length);
    } catch {
      // Sem servidor, ou perfil que não lê a fila (mecânico): nada a dizer.
    }
  }, []);

  useEffect(() => {
    void contarRecusadas();
    const relogio = setInterval(() => void contarRecusadas(), INTERVALO_DAS_RECUSADAS_MS);
    return () => clearInterval(relogio);
  }, [contarRecusadas]);

  /*
    A SONDA QUE NÃO DEPENDE DA FILA (G-offline-sync-04).

    Uma sonda por vez. Quando o servidor volta, a contagem das recusadas é
    refeita — só na volta, para uma listagem que falhe com o servidor de pé
    não virar um vaivém de sondas.
  */
  const conferirServidor = useCallback(async () => {
    if (sondando.current) return;
    sondando.current = true;
    try {
      const sonda = await sondarServidor();
      const antes = estadoAtual.current;
      setEstado(sonda);
      if (sonda === 'ok' && antes !== 'ok') void contarRecusadas();
    } finally {
      sondando.current = false;
    }
  }, [contarRecusadas]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const aoFicarSemResposta = () => void conferirServidor();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, aoFicarSemResposta);
    return () => window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, aoFicarSemResposta);
  }, [conferirServidor]);

  // Com fila, o agendamento dela já sonda antes de cada tentativa.
  useEffect(() => {
    if (estado === 'ok' || fila.length > 0) return;
    const relogio = setInterval(() => void conferirServidor(), INTERVALO_DA_SONDA_MS);
    return () => clearInterval(relogio);
  }, [estado, fila.length, conferirServidor]);

  // A venda que estava no ar quando a tela recarregou (G-offline-sync-06).
  useEffect(() => {
    recuperarEnviosInterrompidos();
    const relogio = setInterval(() => recuperarEnviosInterrompidos(), INTERVALO_DA_RECUPERACAO_MS);
    return () => clearInterval(relogio);
  }, []);

  const enviarPendentes = useCallback(
    async (origem: 'automatica' | 'manual') => {
      if (envioEmCurso || queued().length === 0) {
        /*
          O RETORNO ANTECIPADO NÃO PODE CONGELAR A BARRA (G-offline-sync-13).

          Saía sem reler a fila e sem nova rodada: a aba cuja fila a OUTRA aba
          esvaziou seguia dizendo "aguardando envio" para sempre, e a que achou
          um envio no ar parava de agendar. Relê o que está gravado e, se ainda
          houver fila, agenda a próxima volta.
        */
        const agora = queued();
        setFila(agora);
        if (agora.length > 0) setRodada((n) => n + 1);
        return;
      }
      envioEmCurso = true;
      setEnviando(true);
      if (origem === 'manual') setAviso(null);
      const subiramNestaVolta: VendaSubida[] = [];
      /** As vendas da fila que a gerência já tinha descartado (G-offline-sync-16). */
      let descartadasNestaVolta = 0;
      try {
        // A tentativa automática pergunta antes: um servidor fora do ar não
        // precisa receber a venda inteira para dizer que está fora.
        if (origem === 'automatica') {
          const sonda = await sondarServidor();
          setEstado(sonda);
          if (sonda !== 'ok') {
            tentativasSemSucesso.current += 1;
            return;
          }
        }

        const r = await flushQueue(async (item) => {
          // A sessão de onde este envio SAI: se ela trocar de operação no meio
          // do caminho, a venda guardada antes do campo `escopo` fica vinculada
          // à operação de onde saiu, e não sobe na nova (RES-SESSAO).
          const sessaoDoEnvio = getSession();
          try {
            // Reenvia com a MESMA chave: é ela que impede a venda de duplicar.
            const venda = await apiRequest<{ id?: unknown; number?: unknown } | undefined>(item.path, {
              method: item.method as 'POST',
              body: corpoDoReenvio(item),
              idempotencyKey: item.idempotencyKey,
            });
            if (typeof venda?.id === 'string') {
              subiramNestaVolta.push({
                saleId: venda.id,
                numero: typeof venda.number === 'number' ? venda.number : null,
                feitaEm: item.queuedAt,
                codigo: codigoDaVendaGuardada(item.idempotencyKey),
              });
            }
            return 'enviada';
          } catch (err) {
            if ((err as { code?: unknown })?.code === 'API_SESSION_SCOPE_CHANGED' && sessaoDoEnvio) {
              vincularAoEscopo(item.id, {
                userId: sessaoDoEnvio.user?.id ?? null,
                companyId: sessaoDoEnvio.company.id,
              });
            }
            if (classificarFalha(err) !== 'recusa') throw err;
            /*
              A VENDA QUE A GERÊNCIA DESCARTOU SAI DA FILA (G-offline-sync-16).

              O DEFEITO: descartada em "Regularizar", a pendência fechava no
              servidor, mas a cópia desta fila seguia aqui (a resposta da
              entrega se perdeu, ou a venda estava em dois computadores). O
              reenvio passou a ser recusado com 409
              `CORE_OFFLINE_SALE_DISCARDED`, e esta volta tratava como qualquer
              recusa: entregava de novo como pendência — e, se a entrega
              falhasse, a venda ficava na fila tentando para sempre, com a barra
              dizendo "aguardando envio" de uma venda que não vai existir. A
              decisão já está no servidor: não há o que entregar, ela sai da fila.
            */
            if ((err as { code?: unknown })?.code === 'CORE_OFFLINE_SALE_DISCARDED') {
              descartadasNestaVolta += 1;
              return 'encaminhada';
            }
            /*
              O MOTIVO DA RECUSA É O QUE DECIDE O QUE FAZER.

              "Tentaremos de novo" é verdade para rede instável e mentira para
              a recusa: a venda foi guardada com a gaveta daquele turno, o turno
              fechou, e o servidor passa a recusar. Nova tentativa nunca vai dar
              certo — e o dinheiro já foi recebido. A venda vai para o
              servidor, que a mostra a quem pode relançá-la.
            */
            const e = err as { code?: string; message?: string };
            try {
              const entrega = await vendasOfflineApi.entregar({
                idempotencyKey: item.idempotencyKey,
                label: item.label,
                /*
                  O CORPO VAI COM QUEM VENDEU (P0 da Preço Justo). Era o corpo
                  cru: a pendência perdia a pessoa, e o relançamento em
                  "Regularizar" media o desconto da atendente contra o limite de
                  quem clicou. Com `vendaGuardada`, o servidor mede pela régua
                  mais estreita das duas — e o campo só estreita, nunca abre.
                */
                body: corpoDoReenvio(item),
                queuedAt: item.queuedAt,
                errorCode: e.code ?? null,
                errorMessage: e.message ?? null,
              });
              if (entrega.jaSubiu) {
                subiramNestaVolta.push({
                  saleId: entrega.saleId,
                  numero: entrega.saleNumber ?? null,
                  feitaEm: item.queuedAt,
                  codigo: codigoDaVendaGuardada(item.idempotencyKey),
                });
              }
              return entrega.jaSubiu ? 'enviada' : 'encaminhada';
            } catch {
              // A entrega falhou: a venda FICA, com a recusa escrita.
              throw err;
            }
          }
        }, daOperacaoDeAgora);

        const partes: string[] = [];
        // A venda de outra operação ficou de fora deste envio (RES-SESSAO).
        const deOutraOperacao = queued().filter((q) => !daOperacaoDeAgora(q)).length;
        if (r.sent > 0) partes.push(`${r.sent} venda(s) enviada(s).`);
        // A descartada sai contada como encaminhada, mas NÃO foi para
        // "Regularizar": dizer que foi mandaria o caixa procurar o que não está lá.
        const paraRegularizar = r.forwarded - descartadasNestaVolta;
        if (paraRegularizar > 0) {
          partes.push(
            `${paraRegularizar} venda(s) recusada(s) pelo servidor foi(ram) para "Regularizar" — o gestor e os outros caixas veem.`,
          );
          void contarRecusadas();
        }
        if (r.failed > 0) {
          tentativasSemSucesso.current += 1;
          // A que parou este envio é a última tentada — que pode já ser de
          // outra operação, se a troca a pegou no meio do caminho.
          const parada = [...queued()].sort((a, b) =>
            (b.lastAttemptAt ?? '').localeCompare(a.lastAttemptAt ?? ''),
          )[0];
          if (parada?.lastErrorKind === 'sessao') {
            // A troca de operação no meio do envio não é sessão vencida
            // (RES-SESSAO — ver `classificarFalha`): a frase diz o que houve.
            partes.push(
              parada.lastErrorCode === 'API_SESSION_SCOPE_CHANGED'
                ? 'A operação mudou enquanto a venda subia: ela não foi enviada e continua na fila.'
                : 'Sua sessão expirou: entre de novo para enviar.',
            );
          } else if (parada?.lastErrorKind === 'recusa') {
            partes.push(`Recusado: ${parada.lastError}`);
          } else {
            setEstado(typeof navigator !== 'undefined' && navigator.onLine === false ? 'sem_rede' : 'servidor_fora');
            partes.push('Ainda não foi possível enviar. Tentando de novo sozinho.');
          }
        } else if (deOutraOperacao > 0 && r.sent + r.forwarded === 0) {
          // Nada desta operação para subir: a sonda espera mais entre as voltas.
          tentativasSemSucesso.current += 1;
          setEstado('ok');
        } else {
          tentativasSemSucesso.current = 0;
          setEstado('ok');
        }
        if (deOutraOperacao > 0) {
          partes.push(
            `${deOutraOperacao} venda(s) guardada(s) em outra operação: sobe(m) quando você voltar a ela.`,
          );
        }
        setAviso(partes.length ? partes.join(' ') : null);
      } finally {
        if (subiramNestaVolta.length > 0) {
          // As dez mais recentes bastam: a lista completa está em Vendas.
          setSubidas((antes) => [...antes, ...subiramNestaVolta].slice(-10));
        }
        if (descartadasNestaVolta > 0) setDescartadas((n) => n + descartadasNestaVolta);
        envioEmCurso = false;
        setEnviando(false);
        setRodada((n) => n + 1);
      }
    },
    [contarRecusadas],
  );

  // O agendamento: enquanto houver fila, sempre existe uma próxima tentativa.
  useEffect(() => {
    if (fila.length === 0) {
      tentativasSemSucesso.current = 0;
      return;
    }
    const relogio = setTimeout(
      () => void enviarPendentes('automatica'),
      esperaDaTentativa(tentativasSemSucesso.current),
    );
    return () => clearTimeout(relogio);
  }, [fila.length, rodada, enviarPendentes]);

  useEffect(() => {
    const voltou = () => {
      setEstado('ok');
      void enviarPendentes('automatica');
    };
    const caiu = () => setEstado('sem_rede');
    window.addEventListener('online', voltou);
    window.addEventListener('offline', caiu);
    return () => {
      window.removeEventListener('online', voltou);
      window.removeEventListener('offline', caiu);
    };
  }, [enviarPendentes]);

  const imprimirComprovante = useCallback(async (venda: VendaSubida) => {
    try {
      const feita = await printDocument('SALE_RECEIPT', venda.saleId, {
        terminalId: caixaDesteComputador(getSession()?.company.id),
      });
      if (feita.aviso) setAviso(feita.aviso);
    } catch (err) {
      setAviso(
        `O comprovante da venda #${venda.numero ?? '?'} não saiu: `
          + `${err instanceof Error ? err.message : 'falha na impressão'}. Ele continua disponível em Vendas.`,
      );
    }
  }, []);

  // Nada a dizer: servidor respondendo, sem pendência, sem recusa esperando e
  // sem venda guardada recém-subida para mostrar. Barra permanente vira ruído
  // e some da atenção justamente quando teria algo importante a dizer.
  if (
    estado === 'ok'
    && fila.length === 0
    && recusadas === 0
    && subidas.length === 0
    && descartadas === 0
    && !regularizando
  ) {
    return null;
  }

  const fora = estado !== 'ok';
  const temPendencia = fila.length > 0 || recusadas > 0;

  return (
    <>
      {(fora || temPendencia || subidas.length > 0 || descartadas > 0) && (
        <div
          role="status"
          data-testid="estado-conexao"
          className={`px-4 py-2 text-[length:var(--gs-text-sm)] font-semibold ${
            fora
              ? 'bg-[var(--gs-danger)] text-white'
              : temPendencia || descartadas > 0
                ? 'bg-[var(--gs-warning)] text-black'
                : 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
          }`}
        >
          {estado === 'sem_rede' && <span>Este computador está sem rede. </span>}
          {estado === 'servidor_fora' && (
            <span>
              O servidor da loja não responde — a rede deste computador está de pé. Avise quem cuida do
              servidor.{' '}
            </span>
          )}
          {fila.length > 0 ? (
            <>
              <span data-testid="resumo-da-fila">{resumoDaFila(fila)}</span>{' '}
              {!enviando && <span>Nova tentativa automática em até 30 s. </span>}
              {estado !== 'sem_rede' && (
                <button
                  type="button"
                  onClick={() => void enviarPendentes('manual')}
                  disabled={enviando}
                  className="underline bg-transparent border-0 cursor-pointer font-semibold"
                >
                  {enviando ? 'Enviando…' : 'Enviar agora'}
                </button>
              )}
            </>
          ) : (
            fora && (
              <span data-testid="o-que-funciona-sem-servidor">
                Dá para finalizar só o carrinho que já está na tela: ele fica guardado e sobe sozinho quando o
                servidor voltar. A busca de produto, o preço e o estoque voltam junto com o servidor.
              </span>
            )
          )}
          {recusadas > 0 && (
            <span>
              {' '}
              {recusadas} venda(s) guardada(s) recusada(s) pelo servidor esperando regularização.{' '}
              <button
                type="button"
                onClick={() => setRegularizando(true)}
                className="underline bg-transparent border-0 cursor-pointer font-semibold"
              >
                Regularizar
              </button>
            </span>
          )}
          {subidas.map((s) => (
            <span key={s.saleId} data-testid="venda-guardada-subiu" className="block">
              A venda guardada das {horaCurta(s.feitaEm)} (código {s.codigo}) virou a venda
              {s.numero !== null ? ` #${s.numero}` : ' registrada no servidor'}.{' '}
              <button
                type="button"
                onClick={() => void imprimirComprovante(s)}
                className="underline bg-transparent border-0 cursor-pointer font-semibold"
              >
                Imprimir comprovante{s.numero !== null ? ` da #${s.numero}` : ''}
              </button>
            </span>
          ))}
          {subidas.length > 0 && (
            <button
              type="button"
              onClick={() => setSubidas([])}
              className="underline bg-transparent border-0 cursor-pointer font-semibold"
            >
              Dispensar
            </button>
          )}
          {descartadas > 0 && (
            <span data-testid="vendas-descartadas" className="block">
              {descartadas} venda(s) guardada(s) neste computador tinha(m) sido DESCARTADA(S) pela gerência em
              "Regularizar" e saiu(ram) da fila sem ser registrada(s). Se ela aconteceu de fato, lance uma venda
              nova.{' '}
              <button
                type="button"
                onClick={() => setDescartadas(0)}
                className="underline bg-transparent border-0 cursor-pointer font-semibold"
              >
                Ciente
              </button>
            </span>
          )}
          {aviso && <span> {aviso}</span>}
        </div>
      )}
      {regularizando && (
        <RegularizarVendasOffline
          onClose={() => {
            setRegularizando(false);
            void contarRecusadas();
          }}
          onMudou={() => void contarRecusadas()}
        />
      )}
    </>
  );
}
